/**
 * Core plugin Command palette (`command-palette`), `Mod+P`.
 *
 * With no query: pinned commands (from `.obsidian/command-palette.json`
 * `pinned`), then recently used ones, then the rest alphabetically. With a
 * query: fuzzy-ranked by the Rust matcher, with a small boost for recent
 * commands. Each row shows the command's hotkeys.
 *
 * Instance: `options.pinned`, `recentCommands`, `saveSettings()`,
 * `openPalette()`.
 */
import { getEngine } from "@vault/engine";
import type { Command, FuzzyMatch } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { hotkeyToString } from "../../obsidian/ui/keymap";
import { SettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { FuzzySuggestModal } from "../../obsidian/ui/suggest";

const RECENT_KEY = "command-palette-recent";
const MAX_RECENT = 20;
/** Score bonus per recency rank when a query is typed (the top recent command gets the most). */
const RECENT_BOOST = 0.02;

class CommandPaletteModal extends FuzzySuggestModal<Command> {
  constructor(private plugin: CommandPalettePlugin) {
    super(plugin.app);
    this.modalEl.addClass("mod-command-palette");
    this.setPlaceholder("Type a command...");
    this.emptyStateText = "No commands found.";
    this.limit = 0;
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to use" },
      { command: "esc", purpose: "to dismiss" },
    ]);
    // Ctrl+N / Ctrl+P move through results on every platform.
    this.scope.register(["Ctrl"], "n", (evt) => (this.chooser.moveDown(evt), false));
    this.scope.register(["Ctrl"], "p", (evt) => (this.chooser.moveUp(evt), false));
  }

  getItems(): Command[] {
    return this.app.commands.listCommands();
  }

  getItemText(cmd: Command): string {
    return cmd.name;
  }

  override getSuggestions(query: string): FuzzyMatch<Command>[] {
    const commands = this.getItems();
    const recent = this.plugin.recentCommands;
    const pinned: string[] = this.plugin.options.pinned;
    const q = query.trim();
    if (!q) {
      const byId = new Map(commands.map((c) => [c.id, c]));
      const out: FuzzyMatch<Command>[] = [];
      const used = new Set<string>();
      const push = (id: string) => {
        const cmd = byId.get(id);
        if (!cmd || used.has(id)) return;
        used.add(id);
        out.push({ item: cmd, match: { score: 0, matches: [] } });
      };
      pinned.forEach(push);
      recent.forEach(push);
      commands
        .filter((c) => !used.has(c.id))
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((c) => push(c.id));
      return out;
    }
    const ranked = getEngine().rank(q, commands.map((c) => c.name), commands.length);
    const out = ranked.map((r) => {
      const cmd = commands[r.index]!;
      const recentIndex = recent.indexOf(cmd.id);
      const boost = recentIndex === -1 ? 0 : RECENT_BOOST * (MAX_RECENT - recentIndex);
      return { item: cmd, match: { score: r.result.score + boost, matches: r.result.matches } };
    });
    out.sort((a, b) => b.match.score - a.match.score);
    return out;
  }

  override renderSuggestion(match: FuzzyMatch<Command>, el: HTMLElement): void {
    const cmd = match.item;
    el.addClass("mod-complex");
    const content = el.createDiv({ cls: "suggestion-content" });
    const title = content.createDiv({ cls: "suggestion-title" });
    super.renderSuggestion(match, title);
    const aux = el.createDiv({ cls: "suggestion-aux" });
    if (this.plugin.options.pinned.includes(cmd.id)) {
      const flair = aux.createSpan({ cls: "suggestion-flair", attr: { "aria-label": "Pinned" } });
      setIcon(flair, "lucide-pin");
    }
    const hotkeys = this.app.hotkeyManager.getEffective(cmd.id) ?? [];
    for (const hotkey of hotkeys) aux.createEl("kbd", { cls: "suggestion-hotkey", text: hotkeyToString(hotkey) });
  }

  onChooseItem(cmd: Command, evt: MouseEvent | KeyboardEvent): void {
    this.plugin.recordUse(cmd.id);
    // Let the modal close and focus return before the command runs.
    window.setTimeout(() => this.app.commands.executeCommand(cmd, evt), 0);
  }
}

/** Picker used by the settings tab's "Add a command..." button. */
class CommandPickerModal extends FuzzySuggestModal<Command> {
  constructor(
    app: any,
    private exclude: Set<string>,
    private onPick: (cmd: Command) => void,
  ) {
    super(app);
    this.setPlaceholder("Select a command to pin...");
  }
  getItems(): Command[] {
    return (Object.values(this.app.commands.commands) as Command[]).filter((c) => !this.exclude.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
  }
  getItemText(cmd: Command): string {
    return cmd.name;
  }
  onChooseItem(cmd: Command): void {
    this.onPick(cmd);
  }
}

class CommandPaletteSettingTab extends SettingTab {
  private dragIndex: number | null = null;

  constructor(
    app: any,
    private plugin: CommandPalettePlugin,
  ) {
    super(app);
    this.id = "command-palette";
    this.icon = "lucide-puzzle";
    this.name = "Command palette";
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    const pinned: string[] = this.plugin.options.pinned;
    new Setting(el)
      .setName("Pinned commands")
      .setDesc("Pinned commands appear at the top of the command palette when you open it.")
      .setHeading();
    const list = el.createDiv({ cls: "vault-pinned-commands" });
    pinned.forEach((id, index) => {
      const cmd = this.app.commands.findCommand(id) as Command | undefined;
      const setting = new Setting(list).setName(cmd?.name ?? id);
      if (!cmd) setting.setDesc("This command is not available right now.");
      const row = setting.settingEl;
      row.addClass("mod-draggable");
      row.setAttr("draggable", "true");
      const grip = createDiv({ cls: "setting-item-drag-handle clickable-icon", attr: { "aria-label": "Drag to reorder" } });
      setIcon(grip, "lucide-grip-vertical");
      row.prepend(grip);
      row.addEventListener("dragstart", (evt) => {
        this.dragIndex = index;
        evt.dataTransfer?.setData("text/plain", id);
        row.addClass("is-being-dragged");
      });
      row.addEventListener("dragend", () => row.removeClass("is-being-dragged"));
      row.addEventListener("dragover", (evt) => {
        if (this.dragIndex === null) return;
        evt.preventDefault();
        row.addClass("is-being-dragged-over");
      });
      row.addEventListener("dragleave", () => row.removeClass("is-being-dragged-over"));
      row.addEventListener("drop", (evt) => {
        evt.preventDefault();
        row.removeClass("is-being-dragged-over");
        if (this.dragIndex === null || this.dragIndex === index) return;
        this.move(this.dragIndex, index);
        this.dragIndex = null;
      });
      row.addEventListener("keydown", (evt) => {
        if (!evt.altKey || (evt.key !== "ArrowUp" && evt.key !== "ArrowDown")) return;
        evt.preventDefault();
        const to = evt.key === "ArrowUp" ? index - 1 : index + 1;
        if (to >= 0 && to < pinned.length) this.move(index, to);
      });
      row.setAttr("tabindex", "0");
      setting.addExtraButton((b) =>
        b
          .setIcon("lucide-x")
          .setTooltip("Remove")
          .onClick(() => {
            pinned.splice(index, 1);
            void this.plugin.saveSettings();
            this.display();
          }),
      );
    });
    if (pinned.length === 0) list.createDiv({ cls: "setting-item-description", text: "No pinned commands." });
    new Setting(el).addButton((b) =>
      b
        .setButtonText("Add a command...")
        .setCta()
        .onClick(() => {
          new CommandPickerModal(this.app, new Set(pinned), (cmd) => {
            pinned.push(cmd.id);
            void this.plugin.saveSettings();
            this.display();
          }).open();
        }),
    );
  }

  private move(from: number, to: number) {
    const pinned: string[] = this.plugin.options.pinned;
    const [id] = pinned.splice(from, 1);
    pinned.splice(to, 0, id!);
    void this.plugin.saveSettings();
    this.display();
    this.containerEl.querySelectorAll<HTMLElement>(".vault-pinned-commands .setting-item")[to]?.focus();
  }
}

export class CommandPalettePlugin extends Plugin {
  instance!: any;
  recentCommands: string[] = [];

  get options(): { pinned: string[] } {
    const o = this.instance.options;
    if (!Array.isArray(o.pinned)) o.pinned = [];
    return o;
  }

  override onload() {
    const stored = this.app.loadLocalStorage(RECENT_KEY);
    this.recentCommands = Array.isArray(stored) ? stored.filter((s: unknown) => typeof s === "string") : [];
    const open = () => new CommandPaletteModal(this).open();
    Object.assign(this.instance, {
      openPalette: open,
      saveSettings: () => this.saveSettings(),
    });
    Object.defineProperty(this.instance, "recentCommands", { configurable: true, enumerable: false, get: () => this.recentCommands });
    this.register(() => {
      delete this.instance.openPalette;
      delete this.instance.saveSettings;
      delete this.instance.recentCommands;
    });
    this.addCommand({
      id: "command-palette:open",
      name: "Command palette: Open command palette",
      icon: "lucide-terminal-square",
      hotkeys: [{ modifiers: ["Mod"], key: "p" }],
      callback: open,
    });
    this.addRibbonIcon("lucide-terminal-square", "Open command palette", open);
    if (this.app.setting?.addSettingTab) this.addSettingTab(new CommandPaletteSettingTab(this.app, this));
  }

  recordUse(id: string) {
    this.recentCommands.remove(id);
    this.recentCommands.unshift(id);
    if (this.recentCommands.length > MAX_RECENT) this.recentCommands.length = MAX_RECENT;
    this.app.saveLocalStorage(RECENT_KEY, this.recentCommands);
  }

  async saveSettings() {
    await this.instance.saveOptions();
  }
}

export const commandPalette: CorePluginDefinition = {
  id: "command-palette",
  name: "Command palette",
  description: "Use Ctrl/Cmd+P and begin typing to invoke a command.",
  icon: "lucide-terminal-square",
  defaultOn: true,
  defaultOptions: { pinned: [] },
  create: (app) =>
    new CommandPalettePlugin(app, { id: "command-palette", name: "Command palette", version: "", minAppVersion: "", author: "", description: "" }),
};
