/**
 * The mobile toolbar (`app.mobileToolbar`): a horizontally scrolling row of
 * editor commands shown above the on-screen keyboard while a note is being
 * edited.
 *
 *   body.mod-toolbar-open
 *   .mobile-toolbar
 *     .mobile-toolbar-options-container
 *       .mobile-toolbar-options-list
 *         .mobile-toolbar-option.clickable-icon[data-command-id]
 *
 * The commands are Obsidian's `mobileToolbarCommands` list in `app.json`, so a
 * vault's toolbar round-trips with Obsidian mobile, and they are the same
 * command ids the desktop editor registers (`editor:toggle-bold` …). The
 * mobile-only commands Obsidian offers for the toolbar are registered here:
 * move caret, go to start/end, toggle keyboard, configure toolbar, and the
 * heading menu, plus undo and redo if the editor has not registered them.
 */
import type { Command } from "obsidian";
import type { App } from "../../app";
import { setIcon } from "../../ui/icons";
import { Menu } from "../../ui/menu";
import type { MobileLayout } from "./index";

/** Obsidian mobile's default toolbar (`mobileToolbarCommands`). */
export const DEFAULT_TOOLBAR_COMMANDS = [
  "editor:undo",
  "editor:redo",
  "editor:insert-wikilink",
  "editor:insert-embed",
  "editor:insert-tag",
  "editor:attach-file",
  "editor:set-heading",
  "editor:toggle-bold",
  "editor:toggle-italics",
  "editor:toggle-strikethrough",
  "editor:toggle-highlight",
  "editor:toggle-code",
  "editor:toggle-blockquote",
  "editor:toggle-comments",
  "editor:insert-link",
  "editor:toggle-bullet-list",
  "editor:toggle-numbered-list",
  "editor:toggle-checklist-status",
  "editor:indent-list",
  "editor:unindent-list",
  "editor:configure-toolbar",
];

/** Other commands Obsidian lists as available for the toolbar. */
export const EXTRA_TOOLBAR_COMMANDS = [
  "editor:toggle-inline-math",
  "editor:insert-mathblock",
  "editor:move-caret-up",
  "editor:move-caret-down",
  "editor:move-caret-left",
  "editor:move-caret-right",
  "editor:go-start",
  "editor:go-end",
  "editor:toggle-keyboard",
  "editor:insert-callout",
  "editor:insert-table",
  "editor:insert-codeblock",
  "editor:insert-footnote",
  "editor:clear-formatting",
];

/** Icons for toolbar commands registered without one. */
const FALLBACK_ICONS: Record<string, string> = {
  "editor:undo": "lucide-undo-2",
  "editor:redo": "lucide-redo-2",
  "editor:insert-tag": "lucide-tag",
  "editor:attach-file": "lucide-paperclip",
  "editor:set-heading": "lucide-heading",
  "editor:configure-toolbar": "lucide-wrench",
  "editor:toggle-keyboard": "lucide-keyboard",
};

export function getToolbarCommands(app: App): string[] {
  const v = app.vault.getConfig("mobileToolbarCommands");
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : DEFAULT_TOOLBAR_COMMANDS.slice();
}

export function setToolbarCommands(app: App, ids: string[]) {
  app.vault.setConfig("mobileToolbarCommands", ids);
}

export function commandIcon(app: App, id: string): string {
  const cmd = app.commands.findCommand(id) as (Command & { icon?: string }) | undefined;
  return cmd?.icon || FALLBACK_ICONS[id] || "lucide-terminal-square";
}

/** Is focus in an editor the toolbar can act on? */
function focusedEditorEl(): HTMLElement | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  if (el.closest(".modal-container, .menu, .prompt")) return null;
  return el.closest<HTMLElement>(".cm-editor, .markdown-source-view");
}

export class MobileToolbar {
  app: App;
  containerEl: HTMLElement;
  optionsContainerEl: HTMLElement;
  optionsListEl: HTMLElement;
  isVisible = false;
  private layout: MobileLayout;
  private cleanups: (() => void)[] = [];
  private renderedFor = "";

  constructor(app: App, layout: MobileLayout) {
    this.app = app;
    this.layout = layout;
    this.containerEl = createDiv({ cls: "mobile-toolbar" });
    this.optionsContainerEl = this.containerEl.createDiv({ cls: "mobile-toolbar-options-container" });
    this.optionsListEl = this.optionsContainerEl.createDiv({ cls: "mobile-toolbar-options-list", attr: { role: "toolbar", "aria-label": "Formatting" } });
    // Tapping a button must not take focus from the editor: that would close
    // the on-screen keyboard and lose the selection the command acts on.
    const keep = (evt: Event) => evt.preventDefault();
    this.containerEl.addEventListener("pointerdown", keep);
    this.containerEl.addEventListener("mousedown", keep);
    this.optionsListEl.addEventListener("click", (evt) => {
      const option = (evt.target as HTMLElement).closest<HTMLElement>(".mobile-toolbar-option");
      if (!option?.dataset.commandId) return;
      this.run(option.dataset.commandId, evt);
    });
  }

  attach(parent: HTMLElement) {
    parent.appendChild(this.containerEl);
    this.render();
    const onFocus = () => this.updateVisibility();
    // focusout fires before focus lands elsewhere; decide once it has.
    const onBlur = () => window.setTimeout(() => this.updateVisibility(), 0);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    const ref = this.app.vault.on("config-changed", (key: string) => {
      if (key === "mobileToolbarCommands") this.render(true);
    });
    const ws = this.app.workspace;
    const leafRef = ws.on("active-leaf-change", () => this.updateVisibility());
    this.cleanups.push(() => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      this.app.vault.offref(ref);
      ws.offref(leafRef);
    });
    this.updateVisibility();
  }

  detach() {
    for (const c of this.cleanups.splice(0)) c();
    this.containerEl.detach();
    this.setVisible(false);
  }

  render(force = false) {
    const ids = getToolbarCommands(this.app);
    const key = ids.join("|") + "|" + Object.keys(this.app.commands.commands).length;
    if (!force && key === this.renderedFor && this.optionsListEl.childElementCount) return;
    this.renderedFor = key;
    this.optionsListEl.empty();
    for (const id of ids) {
      const cmd = this.app.commands.findCommand(id);
      if (!cmd) continue;
      const el = this.optionsListEl.createDiv({ cls: ["mobile-toolbar-option", "clickable-icon"], attr: { "data-command-id": id, "aria-label": cmd.name, role: "button" } });
      setIcon(el, commandIcon(this.app, id));
    }
  }

  private run(id: string, evt: MouseEvent) {
    const editorInfo = this.app.workspace.activeEditor as { editor?: { focus(): void; hasFocus(): boolean } } | null;
    this.app.commands.executeCommandById(id, evt);
    // Commands that open a modal or menu take focus on purpose; others keep the editor focused.
    window.setTimeout(() => {
      const opened = document.querySelector(".modal-container, body > .menu");
      if (!opened && id !== "editor:toggle-keyboard" && editorInfo?.editor && !editorInfo.editor.hasFocus()) editorInfo.editor.focus();
    }, 0);
  }

  updateVisibility() {
    if (!this.layout.active) return this.setVisible(false);
    const inEditor = !!focusedEditorEl();
    // Keep the bar while one of its own commands has a menu open over the editor.
    this.setVisible(inEditor);
    if (inEditor) this.render();
  }

  private setVisible(visible: boolean) {
    if (this.isVisible === visible) return;
    this.isVisible = visible;
    document.body.toggleClass("mod-toolbar-open", visible);
    this.app.workspace.trigger("resize");
    if (visible) this.layout.keyboard.revealCaret();
  }
}

/** The toolbar-only commands Obsidian registers on mobile. */
export function registerMobileCommands(app: App, layout: MobileLayout) {
  const commands = app.commands;
  type Ed = { exec(c: string): void; focus(): void; blur(): void; hasFocus(): boolean; undo(): void; redo(): void };
  const editorCmd = (id: string, name: string, icon: string, run: (e: Ed) => void, mobileOnly = true) => {
    commands.addCommand({ id, name, icon, mobileOnly, editorCallback: (editor: unknown) => run(editor as Ed) } as Command);
  };
  editorCmd("editor:move-caret-up", "Move caret up", "lucide-arrow-up", (e) => e.exec("goUp"));
  editorCmd("editor:move-caret-down", "Move caret down", "lucide-arrow-down", (e) => e.exec("goDown"));
  editorCmd("editor:move-caret-left", "Move caret left", "lucide-arrow-left", (e) => e.exec("goLeft"));
  editorCmd("editor:move-caret-right", "Move caret right", "lucide-arrow-right", (e) => e.exec("goRight"));
  editorCmd("editor:go-start", "Go to first line", "lucide-arrow-up-to-line", (e) => e.exec("goStart"));
  editorCmd("editor:go-end", "Go to last line", "lucide-arrow-down-to-line", (e) => e.exec("goEnd"));
  editorCmd("editor:toggle-keyboard", "Toggle keyboard", "lucide-keyboard", (e) => (e.hasFocus() ? e.blur() : e.focus()));
  commands.addCommand({
    id: "editor:configure-toolbar",
    name: "Configure mobile toolbar",
    icon: "lucide-wrench",
    mobileOnly: true,
    callback: () => {
      app.setting.open();
      app.setting.openTabById("mobile");
    },
  } as Command);
  commands.addCommand({
    id: "app:show-tab-switcher",
    name: "Show tab overview",
    icon: "lucide-layout-grid",
    mobileOnly: true,
    callback: () => void layout.tabSwitcher.show(),
  } as Command);

  // Registered only if the editor has not provided them by the time the layout is ready.
  app.workspace.onLayoutReady(() => {
    const ifMissing = (id: string, name: string, icon: string, run: (e: Ed) => void) => {
      if (!commands.findCommand(id)) editorCmd(id, name, icon, run, false);
    };
    ifMissing("editor:undo", "Undo", "lucide-undo-2", (e) => e.undo());
    ifMissing("editor:redo", "Redo", "lucide-redo-2", (e) => e.redo());
    if (!commands.findCommand("editor:set-heading")) {
      commands.addCommand({
        id: "editor:set-heading",
        name: "Toggle heading",
        icon: "lucide-heading",
        editorCallback: () => {
          const menu = new Menu();
          for (let n = 1; n <= 6; n++) {
            menu.addItem((i) => i.setTitle(`Heading ${n}`).setIcon(`lucide-heading-${n}`).onClick(() => commands.executeCommandById(`editor:set-heading-${n}`)));
          }
          menu.addItem((i) => i.setTitle("No heading").setIcon("lucide-type").onClick(() => commands.executeCommandById("editor:set-heading-0")));
          const option = document.querySelector<HTMLElement>('.mobile-toolbar-option[data-command-id="editor:set-heading"]');
          const r = option?.getBoundingClientRect();
          if (r && r.width) menu.showAtPosition({ x: r.left, y: r.top });
          else menu.showAtPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        },
      } as Command);
    }
    layout.toolbar.render(true);
  });
}
