/**
 * Formatting toolbar (`formatting-toolbar`) — hidden, always-on core plugin.
 *
 * Setting `formattingToolbar` (app.json): "off" (default) | "fixed" | "selection".
 *  - fixed: a bar at the top of every Markdown view's `.view-content`, above
 *    the editor (hidden in reading view and on mobile, where W4's keyboard
 *    toolbar takes over);
 *  - selection: the floating bar from `editor/toolbar-commands.ts`.
 *
 *   div.vault-formatting-toolbar[role=toolbar]
 *     div.vault-formatting-toolbar-inner
 *       div.clickable-icon.vault-toolbar-button[data-command][aria-label][.is-active][.has-dropdown]
 *
 * The buttons are stored as command ids in `.obsidian/formatting-toolbar.json`
 * `{ commands: string[] }`. The toolbar steps aside while the Editing Toolbar
 * or cMenu community plugin is enabled.
 *
 * Also registers Obsidian's `editor:undo`, `editor:redo`, `editor:set-heading`
 * ("Toggle heading", a heading menu at the cursor) and `editor:context-menu`
 * when nothing else has.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Menu } from "../../obsidian/ui/menu";
import { Modal } from "../../obsidian/ui/modal";
import { ButtonComponent, Setting } from "../../obsidian/ui/setting";
import { FuzzySuggestModal } from "../../obsidian/ui/suggest";
import { Platform } from "../../obsidian/util";
import {
  FORMATTING_TOOLBAR_COMMANDS,
  HEADING_ITEMS,
  TOOLBAR_PLUGINS,
  activeFormats,
  runCommandOn,
  setToolbarMenuFactory,
  toolbarItemFor,
  type ToolbarItem,
} from "../../editor/toolbar-commands";

const TOOLBAR_CLS = "vault-formatting-toolbar";

export const DEFAULT_TOOLBAR_IDS = FORMATTING_TOOLBAR_COMMANDS.map((c) => c.id);

interface MarkdownLike {
  leaf: any;
  editor: any;
  contentEl: HTMLElement;
  getViewType(): string;
  getMode(): "source" | "preview";
}

class FormattingToolbarPlugin extends Plugin {
  instance!: any;
  private bars = new Map<MarkdownLike, { el: HTMLElement; buttons: { id: string; el: HTMLElement }[] }>();
  private frame = 0;

  get commandIds(): string[] {
    const ids = this.instance.options.commands;
    return Array.isArray(ids) ? ids.filter((x: unknown) => typeof x === "string") : DEFAULT_TOOLBAR_IDS;
  }

  override onload() {
    const app = this.app;
    setToolbarMenuFactory((item, anchor, run, active) => showDropdown(item, anchor, run, active));
    this.register(() => setToolbarMenuFactory(null));

    this.instance.openManager = () => new ToolbarManagerModal(app, this).open();
    this.instance.getCommandIds = () => this.commandIds;
    this.instance.setCommandIds = (ids: string[]) => this.setCommandIds(ids);

    this.registerFallbackCommands();

    this.registerEvent(app.workspace.on("layout-change", () => this.sync()));
    this.registerEvent(app.workspace.on("active-leaf-change", () => this.sync()));
    this.registerEvent(app.workspace.on("editor-change", () => this.scheduleActiveUpdate()));
    this.registerEvent(
      app.vault.on("config-changed", (key: string) => {
        if (key === "formattingToolbar") this.sync(true);
      }),
    );
    this.registerDomEvent(document, "selectionchange", () => this.scheduleActiveUpdate());
    app.workspace.onLayoutReady(() => this.sync());
    this.register(() => this.removeAll());
  }

  // internal
  async setCommandIds(ids: string[]) {
    this.instance.options.commands = ids;
    await this.instance.saveOptions();
    this.sync(true);
  }

  private enabled(): boolean {
    if (Platform.isMobile || document.body.hasClass("is-mobile")) return false;
    if (this.app.vault.getConfig("formattingToolbar") !== "fixed") return false;
    const plugins = this.app.plugins;
    return !TOOLBAR_PLUGINS.some((id) => plugins?.enabledPlugins?.has?.(id) && plugins?.plugins?.[id]);
  }

  private removeAll() {
    for (const bar of this.bars.values()) bar.el.remove();
    this.bars.clear();
  }

  /** Add or remove a bar on every open Markdown view. `rebuild` redraws existing bars (commands changed). */
  // internal
  sync(rebuild = false) {
    if (!this.enabled()) {
      this.removeAll();
      return;
    }
    const seen = new Set<MarkdownLike>();
    this.app.workspace.iterateAllLeaves((leaf: any) => {
      const view = leaf.view as MarkdownLike | undefined;
      if (!view || view.getViewType?.() !== "markdown" || !view.editor) return;
      seen.add(view);
      let bar = this.bars.get(view);
      if (bar && (rebuild || !bar.el.isConnected)) {
        bar.el.remove();
        this.bars.delete(view);
        bar = undefined;
      }
      if (!bar) {
        bar = this.build(view);
        this.bars.set(view, bar);
        view.contentEl.insertBefore(bar.el, view.contentEl.firstChild);
      }
      this.updateActive(view);
    });
    for (const [view, bar] of this.bars) {
      if (!seen.has(view)) {
        bar.el.remove();
        this.bars.delete(view);
      }
    }
  }

  private build(view: MarkdownLike) {
    const el = createDiv({ cls: TOOLBAR_CLS, attr: { role: "toolbar", "aria-label": "Formatting" } });
    const inner = el.createDiv({ cls: `${TOOLBAR_CLS}-inner` });
    const buttons: { id: string; el: HTMLElement }[] = [];
    for (const id of this.commandIds) {
      const item = toolbarItemFor(this.app, id);
      if (!item) continue;
      const b = inner.createDiv({ cls: "clickable-icon vault-toolbar-button", attr: { "aria-label": item.name, "data-command": item.id, role: "button", tabindex: "-1" } });
      setIcon(b, item.icon);
      if (item.children?.length) b.addClass("has-dropdown");
      // Keep the editor's focus and selection.
      b.addEventListener("mousedown", (evt) => evt.preventDefault());
      b.addEventListener("click", (evt) => {
        evt.preventDefault();
        this.run(view, item, b);
      });
      buttons.push({ id: item.id, el: b });
    }
    return { el, buttons };
  }

  private run(view: MarkdownLike, item: ToolbarItem, anchor: HTMLElement) {
    const ws = this.app.workspace;
    if (ws.activeLeaf !== view.leaf) ws.setActiveLeaf(view.leaf, { focus: false });
    if (view.getMode() !== "source") return;
    if (item.children?.length) {
      showDropdown(item, anchor, (child) => this.runOne(view, child.id), activeFormats(view.editor.cm.state));
      return;
    }
    this.runOne(view, item.id);
  }

  private runOne(view: MarkdownLike, id: string) {
    if (!view.editor.hasFocus()) view.editor.focus();
    runCommandOn(this.app, id, view.editor, view);
    this.updateActive(view);
  }

  private scheduleActiveUpdate() {
    if (!this.bars.size || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const view = this.app.workspace.activeLeaf?.view as MarkdownLike | undefined;
      if (view && this.bars.has(view)) this.updateActive(view);
    });
  }

  private updateActive(view: MarkdownLike) {
    const bar = this.bars.get(view);
    const cm = view.editor?.cm;
    if (!bar || !cm) return;
    const active = activeFormats(cm.state);
    for (const b of bar.buttons) b.el.toggleClass("is-active", active.has(b.id));
  }

  private registerFallbackCommands() {
    const commands = this.app.commands;
    const has = (id: string) => !!commands.findCommand(id);
    if (!has("editor:undo")) this.addCommand({ id: "editor:undo", name: "Undo", icon: "lucide-undo-2", editorCallback: (editor: any) => editor.undo() });
    if (!has("editor:redo")) this.addCommand({ id: "editor:redo", name: "Redo", icon: "lucide-redo-2", editorCallback: (editor: any) => editor.redo() });
    if (!has("editor:set-heading")) {
      this.addCommand({
        id: "editor:set-heading",
        name: "Toggle heading",
        icon: "lucide-heading",
        editorCallback: (editor: any, info: any) => {
          const cm = editor.cm;
          const head = cm?.state.selection.main.head ?? 0;
          const coords = cm?.coordsAtPos(head);
          const item = { id: "editor:set-heading", name: "Heading", icon: "lucide-heading", children: HEADING_ITEMS };
          const menu = new Menu();
          const active = cm ? activeFormats(cm.state) : new Set<string>();
          for (const child of item.children) menu.addItem((i) => i.setTitle(child.name).setIcon(child.icon).setChecked(active.has(child.id)).onClick(() => runCommandOn(this.app, child.id, editor, info)));
          menu.showAtPosition({ x: coords?.left ?? 100, y: coords?.bottom ?? 100 });
        },
      });
    }
    if (!has("editor:context-menu")) {
      this.addCommand({
        id: "editor:context-menu",
        name: "Show context menu under cursor",
        icon: "lucide-menu",
        editorCallback: (editor: any) => {
          const cm = editor.cm;
          if (!cm) return;
          const coords = cm.coordsAtPos(cm.state.selection.main.head);
          if (!coords) return;
          const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: coords.left, clientY: coords.bottom, button: 2 });
          (evt as MouseEvent & { vaultEditorMenu?: boolean }).vaultEditorMenu = true;
          cm.contentDOM.dispatchEvent(evt);
        },
      });
    }
  }
}

function showDropdown(item: ToolbarItem, anchor: HTMLElement, run: (child: ToolbarItem) => void, active?: Set<string>) {
  const menu = new Menu();
  for (const child of item.children ?? []) {
    menu.addItem((i) =>
      i
        .setTitle(child.name)
        .setIcon(child.icon)
        .setChecked(active ? active.has(child.id) : null)
        .onClick(() => run(child)),
    );
  }
  const r = anchor.getBoundingClientRect();
  menu.showAtPosition({ x: r.left, y: r.bottom + 4 }, anchor.ownerDocument);
}

/** Settings → Editor → "Toolbar buttons": reorder, remove, add, reset. */
class ToolbarManagerModal extends Modal {
  private ids: string[];
  constructor(
    app: any,
    private plugin: FormattingToolbarPlugin,
  ) {
    super(app);
    this.ids = [...plugin.commandIds];
    this.setTitle("Formatting toolbar buttons");
    this.modalEl.addClass("vault-toolbar-manager");
  }

  override onOpen() {
    this.render();
  }

  private save() {
    void this.plugin.setCommandIds([...this.ids]);
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    const list = contentEl.createDiv({ cls: "vault-toolbar-manager-list" });
    this.ids.forEach((id, i) => {
      const item = toolbarItemFor(this.app, id);
      const s = new Setting(list).setName(item?.name ?? id).setDesc(id);
      const iconEl = createDiv({ cls: "vault-toolbar-manager-icon" });
      if (item) setIcon(iconEl, item.icon);
      s.nameEl.prepend(iconEl);
      s.addExtraButton((b) =>
        b.setIcon("lucide-arrow-up").setTooltip("Move up").setDisabled(i === 0).onClick(() => {
          [this.ids[i - 1], this.ids[i]] = [this.ids[i]!, this.ids[i - 1]!];
          this.save();
        }),
      );
      s.addExtraButton((b) =>
        b.setIcon("lucide-arrow-down").setTooltip("Move down").setDisabled(i === this.ids.length - 1).onClick(() => {
          [this.ids[i + 1], this.ids[i]] = [this.ids[i]!, this.ids[i + 1]!];
          this.save();
        }),
      );
      s.addExtraButton((b) =>
        b.setIcon("lucide-x").setTooltip("Remove").onClick(() => {
          this.ids.splice(i, 1);
          this.save();
        }),
      );
    });
    if (!this.ids.length) list.createDiv({ cls: "setting-item-description", text: "No buttons. Add a command below." });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons)
      .setButtonText("Add command")
      .setCta()
      .onClick(() =>
        new CommandPicker(this.app, (id) => {
          if (!this.ids.includes(id)) this.ids.push(id);
          this.save();
        }).open(),
      );
    new ButtonComponent(buttons).setButtonText("Reset to default").onClick(() => {
      this.ids = [...DEFAULT_TOOLBAR_IDS];
      this.save();
    });
  }
}

class CommandPicker extends FuzzySuggestModal<{ id: string; name: string }> {
  constructor(
    app: any,
    private onPick: (id: string) => void,
  ) {
    super(app);
    this.setPlaceholder("Select a command to add to the toolbar...");
  }
  getItems() {
    return (Object.values(this.app.commands.commands) as { id: string; name: string }[]).sort((a, b) => a.name.localeCompare(b.name));
  }
  getItemText(item: { id: string; name: string }) {
    return item.name;
  }
  onChooseItem(item: { id: string; name: string }) {
    this.onPick(item.id);
  }
}

export const formattingToolbar: CorePluginDefinition = {
  id: "formatting-toolbar",
  name: "Formatting toolbar",
  description: "A desktop formatting toolbar for the editor.",
  defaultOn: true,
  hidden: true,
  defaultOptions: {},
  create: (app) => new FormattingToolbarPlugin(app, { id: "formatting-toolbar", name: "Formatting toolbar", version: "", minAppVersion: "", author: "", description: "" }),
};
