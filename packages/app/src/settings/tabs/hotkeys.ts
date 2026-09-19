/**
 * Settings → Hotkeys (§6.6).
 *
 * Every command with its hotkeys; filter chips All / Assigned / Assigned by me
 * / Unassigned / Conflicts; "+" records a key press; × removes a hotkey (an
 * empty list is saved as `[]`, which unbinds a default); Restore default
 * removes the custom entry. Stored by `hotkeyManager.setHotkeys` in
 * `.obsidian/hotkeys.json`.
 *
 * Plugins open this tab filtered to themselves:
 * `app.setting.openTabById("hotkeys").searchComponent.setValue(name)` then
 * `updateHotkeyVisibility()`, so both are kept as public members.
 *
 * Row DOM: `.setting-item.mod-toggle` > `.setting-item-control` >
 * `.setting-command-hotkeys` > `.setting-hotkey[.mod-empty][.mod-active][.has-conflict]`
 * (+ `.setting-hotkey-icon.setting-delete-hotkey`), then
 * `.setting-restore-hotkey-button` and `.setting-add-hotkey-button`.
 */
import type { Command, Hotkey } from "obsidian";
import type { App } from "../../obsidian/app";
import { setIcon } from "../../obsidian/ui/icons";
import { Scope, eventToHotkey, hotkeyToString } from "../../obsidian/ui/keymap";
import { SearchComponent, Setting } from "../../obsidian/ui/setting";
import { setTooltip } from "../../obsidian/ui/tooltip";
import { Platform } from "../../obsidian/util";
import { matchesAll, tokens } from "../helpers";
import { AppSettingTab } from "../tab-base";

type Filter = "all" | "assigned" | "custom" | "unassigned" | "conflicts";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "assigned", label: "Assigned" },
  { id: "custom", label: "Assigned by me" },
  { id: "unassigned", label: "Unassigned" },
  { id: "conflicts", label: "Conflicts" },
];

interface Row {
  command: Command;
  settingEl: HTMLElement;
  hotkeysEl: HTMLElement;
  setting: Setting;
}

export class HotkeysSettingTab extends AppSettingTab {
  // internal (used by plugins: filter the list to a plugin's commands)
  searchComponent!: SearchComponent;
  filter: Filter = "all";
  private rows: Row[] = [];
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private chipEls = new Map<Filter, HTMLElement>();
  private recording: { scope: Scope; cleanup: () => void } | null = null;
  private query = "";

  constructor(app: App) {
    super(app, "hotkeys", "Hotkeys", "lucide-keyboard");
  }

  render(el: HTMLElement): void {
    const controls = el.createDiv({ cls: "vault-hotkey-controls" });
    const searchSetting = new Setting(controls).setName("Search hotkeys");
    searchSetting.settingEl.addClass("vault-hotkey-search");
    searchSetting.infoEl.remove();
    this.searchComponent = new SearchComponent(searchSetting.controlEl).setPlaceholder("Filter by command name or id...");
    this.searchComponent.setValue(this.query);
    this.searchComponent.onChange((v) => {
      this.query = v;
      this.updateHotkeyVisibility();
    });
    const chips = controls.createDiv({ cls: "vault-hotkey-filter-chips", attr: { role: "tablist" } });
    this.chipEls.clear();
    for (const f of FILTERS) {
      const chip = chips.createDiv({ cls: "vault-hotkey-filter-chip", text: f.label, attr: { role: "tab", tabindex: 0 } });
      chip.addEventListener("click", () => {
        this.filter = f.id;
        this.updateHotkeyVisibility();
      });
      chip.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          chip.click();
        }
      });
      this.chipEls.set(f.id, chip);
    }
    this.countEl = controls.createDiv({ cls: "vault-hotkey-count setting-item-description" });

    this.listEl = el.createDiv({ cls: "vault-hotkey-list" });
    const commands = Object.values(this.app.commands.commands).sort((a, b) => a.name.localeCompare(b.name));
    this.rows = commands.map((command) => this.createRow(command));
    this.updateHotkeyVisibility();
  }

  /** Opening the tab puts the cursor in the filter (desktop; on a phone it would raise the keyboard). */
  override showTab(): void {
    super.showTab();
    if (Platform.isDesktop) this.searchComponent?.inputEl.focus({ preventScroll: true });
  }

  override hide(): void {
    this.stopRecording();
    super.hide();
    this.rows = [];
  }

  private createRow(command: Command): Row {
    const setting = new Setting(this.listEl).setName(command.name);
    setting.settingEl.addClass("mod-toggle");
    setting.settingEl.setAttr("data-command-id", command.id);
    setting.descEl.setText(command.id);
    setting.descEl.addClass("vault-hotkey-command-id");
    const hotkeysEl = setting.controlEl.createDiv({ cls: "setting-command-hotkeys" });
    const row: Row = { command, settingEl: setting.settingEl, hotkeysEl, setting };
    this.renderHotkeys(row);
    return row;
  }

  private renderHotkeys(row: Row) {
    const hm = this.app.hotkeyManager;
    const id = row.command.id;
    const keys = hm.getEffective(id);
    const custom = hm.getHotkeys(id) !== undefined;
    const { setting, hotkeysEl } = row;
    hotkeysEl.empty();
    for (const el of Array.from(setting.controlEl.querySelectorAll(".setting-restore-hotkey-button, .setting-add-hotkey-button"))) el.remove();

    if (!keys.length) {
      hotkeysEl.createSpan({ cls: "setting-hotkey mod-empty", text: "Blank" });
    }
    let conflicted = false;
    keys.forEach((hotkey, index) => {
      const chip = hotkeysEl.createSpan({ cls: "setting-hotkey", text: hotkeyToString(hotkey) });
      const conflicts = hm.findConflicts(hotkey, id);
      if (conflicts.length) {
        conflicted = true;
        chip.addClass("has-conflict");
        const names = conflicts.map((c) => this.app.commands.findCommand(c)?.name ?? c);
        setTooltip(chip, `This hotkey conflicts with ${names.map((n) => `"${n}"`).join(", ")}`);
      }
      const del = chip.createSpan({ cls: "setting-hotkey-icon setting-delete-hotkey", attr: { "aria-label": "Delete hotkey", role: "button" } });
      setIcon(del, "lucide-x");
      del.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const next = keys.filter((_, i) => i !== index);
        hm.setHotkeys(id, next);
        this.refreshAll();
      });
    });
    row.settingEl.toggleClass("has-conflict", conflicted);

    if (custom) {
      const restore = setting.controlEl.createDiv({ cls: "clickable-icon setting-restore-hotkey-button", attr: { "aria-label": "Restore default", role: "button", tabindex: 0 } });
      setIcon(restore, "lucide-rotate-ccw");
      restore.addEventListener("click", () => {
        hm.removeHotkeys(id);
        this.refreshAll();
      });
    }
    const add = setting.controlEl.createDiv({ cls: "clickable-icon setting-add-hotkey-button", attr: { "aria-label": "Customize this command", role: "button", tabindex: 0 } });
    setIcon(add, "lucide-plus-circle");
    add.addEventListener("click", () => this.startRecording(row));
    add.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        this.startRecording(row);
      }
    });
  }

  /** Re-render every row: a change to one command can create or clear a conflict on another. */
  private refreshAll() {
    for (const row of this.rows) this.renderHotkeys(row);
    this.updateHotkeyVisibility();
  }

  private startRecording(row: Row) {
    this.stopRecording();
    const hm = this.app.hotkeyManager;
    const chip = row.hotkeysEl.createSpan({ cls: "setting-hotkey mod-active", text: "Press hotkey..." });
    row.hotkeysEl.querySelector(".mod-empty")?.remove();
    const scope = new Scope();
    scope.register(null, null, (evt) => {
      if (evt.key === "Escape" && !evt.ctrlKey && !evt.metaKey && !evt.altKey && !evt.shiftKey) {
        this.stopRecording();
        this.renderHotkeys(row);
        return false;
      }
      const hotkey = eventToHotkey(evt);
      if (!hotkey) return false; // a modifier on its own: keep waiting
      this.stopRecording();
      const current = hm.getEffective(row.command.id);
      const exists = current.some((k: Hotkey) => hotkeyToString(k) === hotkeyToString(hotkey));
      if (!exists) hm.setHotkeys(row.command.id, [...current, hotkey]);
      this.refreshAll();
      return false;
    });
    this.app.keymap.pushScope(scope);
    const onPointer = (evt: PointerEvent) => {
      if (chip.contains(evt.target as Node)) return;
      this.stopRecording();
      this.renderHotkeys(row);
    };
    const timer = window.setTimeout(() => document.addEventListener("pointerdown", onPointer, true), 0);
    this.recording = {
      scope,
      cleanup: () => {
        window.clearTimeout(timer);
        document.removeEventListener("pointerdown", onPointer, true);
        chip.remove();
      },
    };
  }

  private stopRecording() {
    const rec = this.recording;
    if (!rec) return;
    this.recording = null;
    this.app.keymap.popScope(rec.scope);
    rec.cleanup();
  }

  // internal (used by plugins after setting searchComponent's value)
  updateHotkeyVisibility(): void {
    if (!this.listEl) return;
    const hm = this.app.hotkeyManager;
    this.query = this.searchComponent?.getValue() ?? this.query;
    const toks = tokens(this.query);
    let shown = 0;
    for (const row of this.rows) {
      const id = row.command.id;
      const keys = hm.getEffective(id);
      let pass: boolean;
      switch (this.filter) {
        case "assigned":
          pass = keys.length > 0;
          break;
        case "custom":
          pass = hm.getHotkeys(id) !== undefined;
          break;
        case "unassigned":
          pass = keys.length === 0;
          break;
        case "conflicts":
          pass = keys.some((k) => hm.findConflicts(k, id).length > 0);
          break;
        default:
          pass = true;
      }
      if (pass && toks.length) pass = matchesAll(`${row.command.name} ${id} ${keys.map((k) => hotkeyToString(k)).join(" ")}`, toks);
      row.settingEl.toggle(pass);
      if (pass) shown++;
    }
    for (const [id, chip] of this.chipEls) {
      chip.toggleClass("is-active", id === this.filter);
      chip.setAttr("aria-selected", id === this.filter ? "true" : "false");
    }
    this.countEl?.setText(`Showing ${shown} of ${this.rows.length} commands`);
  }
}
