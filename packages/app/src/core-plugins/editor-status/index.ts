/**
 * Core plugin "Show editing mode in status bar" (`editor-status`).
 *
 *   .status-bar-item.plugin-editor-status.mod-clickable[aria-label] > .status-bar-item-icon > svg
 *
 * Shows whether the active note is in Reading view, Live Preview or Source
 * mode; clicking opens a menu to switch. Hidden when no note is active.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Menu } from "../../obsidian/ui/menu";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";

type Mode = "preview" | "live" | "source";

const MODES: { mode: Mode; title: string; icon: string }[] = [
  { mode: "preview", title: "Reading view", icon: "lucide-book-open" },
  { mode: "live", title: "Live Preview", icon: "lucide-edit-3" },
  { mode: "source", title: "Source mode", icon: "lucide-code-2" },
];

interface MarkdownLikeView {
  leaf: WorkspaceLeaf;
  getViewType(): string;
  getMode?(): "source" | "preview";
  getState(): Record<string, unknown>;
}

class EditorStatusPlugin extends Plugin {
  instance!: any;
  private el!: HTMLElement;
  private view: MarkdownLikeView | null = null;

  override onload() {
    this.el = this.addStatusBarItem();
    this.el.addClasses(["plugin-editor-status", "mod-clickable"]);
    this.el.setAttr("data-tooltip-position", "top");
    this.el.hide();
    this.registerDomEvent(this.el, "click", (evt) => this.showMenu(evt));

    const { workspace, vault } = this.app;
    this.registerEvent(workspace.on("active-leaf-change", () => this.update()));
    this.registerEvent(workspace.on("layout-change", () => this.update()));
    this.registerEvent(workspace.on("file-open", () => this.update()));
    this.registerEvent(vault.on("config-changed", (key: string) => key === "livePreview" && this.update()));
    workspace.onLayoutReady(() => this.update());
  }

  /** The note the status describes: the active leaf if it is a note, else the last one (while a sidebar has focus). */
  private currentView(): MarkdownLikeView | null {
    const { workspace } = this.app;
    const active = workspace.activeLeaf?.view as MarkdownLikeView | undefined;
    if (active?.getViewType() === "markdown") return active;
    if (active && workspace.activeLeaf.getRoot() === workspace.rootSplit) return null;
    const last = this.view;
    return last && last.leaf.parent && last.leaf.view === (last as unknown) ? last : null;
  }

  private modeOf(view: MarkdownLikeView): Mode {
    const state = view.getState() ?? {};
    const mode = view.getMode?.() ?? (state.mode as string | undefined);
    if (mode === "preview") return "preview";
    const source = typeof state.source === "boolean" ? state.source : !this.app.vault.getConfig("livePreview");
    return source ? "source" : "live";
  }

  private update() {
    const view = this.currentView();
    this.view = view;
    if (!view) {
      this.el.hide();
      return;
    }
    const info = MODES.find((m) => m.mode === this.modeOf(view))!;
    this.el.show();
    this.el.setAttr("aria-label", info.title);
    let iconEl = this.el.querySelector<HTMLElement>(".status-bar-item-icon");
    iconEl ??= this.el.createSpan({ cls: "status-bar-item-icon status-bar-item-segment" });
    setIcon(iconEl, info.icon);
  }

  private showMenu(evt: MouseEvent) {
    const view = this.view;
    if (!view) return;
    const current = this.modeOf(view);
    const menu = new Menu();
    for (const m of MODES) {
      menu.addItem((item) =>
        item
          .setTitle(m.title)
          .setIcon(m.icon)
          .setChecked(m.mode === current)
          .onClick(() => void this.setMode(view, m.mode)),
      );
    }
    const rect = this.el.getBoundingClientRect();
    menu.setParentElement(this.el);
    menu.showAtPosition({ x: rect.left, y: rect.top });
    void evt;
  }

  private async setMode(view: MarkdownLikeView, mode: Mode) {
    const leaf = view.leaf;
    const state = { ...(view.getState() ?? {}) };
    if (mode === "preview") state.mode = "preview";
    else {
      state.mode = "source";
      state.source = mode === "source";
    }
    await leaf.setViewState({ ...leaf.getViewState(), state }, leaf.getEphemeralState());
    this.update();
  }
}

export const editorStatus: CorePluginDefinition = {
  id: "editor-status",
  name: "Show editing mode in status bar",
  description: "Show the editing mode toggle in the status bar.",
  icon: "lucide-edit-3",
  defaultOn: true,
  defaultOptions: {},
  create: (app) =>
    new EditorStatusPlugin(app, { id: "editor-status", name: "Show editing mode in status bar", version: "", minAppVersion: "", author: "", description: "" }),
};
