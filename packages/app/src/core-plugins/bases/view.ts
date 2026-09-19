/**
 * The `bases` view: a `.base` file open in a tab (or a sidebar). Keeps the
 * YAML as its view data; `this` is the base file, or the active file when the
 * base sits in a sidebar.
 */
import type { ViewStateResult } from "obsidian";
import type { Menu } from "../../obsidian/ui/menu";
import type { TFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { TextFileView } from "../../obsidian/workspace/view";
import { BasesHost } from "./host";
import { copyTable, exportCsv } from "./toolbar";
import type { BasesPluginHost } from "./types";

export const VIEW_TYPE_BASES = "bases";

export class BasesFileView extends TextFileView {
  host: BasesHost;
  private viewName: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: BasesPluginHost,
  ) {
    super(leaf);
    this.icon = "lucide-table";
    this.contentEl.addClass("bases-view-content");
    this.host = new BasesHost(this.app, plugin, this.contentEl.createDiv({ cls: "bases-file-host" }), {
      embedded: false,
      baseFile: null,
      getThisFile: () => (this.inSidebar() ? (this.app.workspace.getActiveFile() as TFile | null) : this.file),
      save: (yaml) => {
        this.data = yaml;
        void this.save();
      },
      onViewChanged: (name) => {
        this.viewName = name;
        this.app.workspace.requestSaveLayout?.();
      },
    });
  }

  getViewType(): string {
    return VIEW_TYPE_BASES;
  }

  override getIcon(): string {
    return "lucide-table";
  }

  private inSidebar(): boolean {
    const ws = this.app.workspace;
    const root = (this.leaf as unknown as { getRoot?: () => unknown }).getRoot?.();
    return !!root && (root === ws.leftSplit || root === ws.rightSplit);
  }

  override onload() {
    super.onload();
    this.addChild(this.host);
    const follow = () => {
      if (this.inSidebar()) this.host.setThisFile(this.app.workspace.getActiveFile());
    };
    this.registerEvent(this.app.workspace.on("file-open", follow));
    this.registerEvent(this.app.workspace.on("active-leaf-change", follow));
  }

  override async onLoadFile(file: TFile): Promise<void> {
    this.host.options.baseFile = file;
    await super.onLoadFile(file);
  }

  getViewData(): string {
    return this.data;
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (clear) this.host.options.initialViewName = this.viewName;
    this.host.setSource(data);
  }

  clear(): void {}

  override onResize(): void {
    (this.host.view as { onResize?: () => void } | null)?.onResize?.();
  }

  override getState(): Record<string, unknown> {
    const state = super.getState();
    const name = this.host.controller.currentView?.name ?? this.viewName;
    if (name) state.viewName = name;
    return state;
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    if (state && typeof state.viewName === "string") {
      this.viewName = state.viewName;
      this.host.options.initialViewName = state.viewName;
      const idx = this.host.controller.views.findIndex((v: any) => v?.name === state.viewName);
      if (idx >= 0 && idx !== this.host.controller.viewIndex) this.host.selectView(idx);
    }
    await super.setState(state, result);
  }

  override setEphemeralState(state: any): void {
    const sub = typeof state?.subpath === "string" ? decodeURIComponent(state.subpath.replace(/^#/, "")) : "";
    if (sub) {
      const idx = this.host.controller.views.findIndex((v: any) => v?.name === sub);
      if (idx >= 0) this.host.selectView(idx);
      else this.host.options.initialViewName = sub;
    }
  }

  override onPaneMenu(menu: Menu, source: string): void {
    menu.addItem((i) => i.setSection("action").setTitle("Copy table to clipboard").setIcon("lucide-copy").onClick(() => void copyTable(this.host)));
    menu.addItem((i) => i.setSection("action").setTitle("Export CSV...").setIcon("lucide-download").onClick(() => exportCsv(this.host)));
    super.onPaneMenu(menu, source);
  }
}
