/**
 * Graph view core plugin (`graph`): the global graph, the local graph as a
 * linked view, the ribbon button and the three commands.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import type { Menu } from "../../obsidian/ui/menu";
import type { TAbstractFile, TFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { DEFAULT_GRAPH_OPTIONS } from "./options";
import { GraphView, VIEW_TYPE_GRAPH, VIEW_TYPE_LOCAL_GRAPH, type GraphPluginHost } from "./view";

const LINKED_VIEW_SOURCES = new Set(["more-options", "pane-more-options", "tab-header", "view-header"]);

class GraphPlugin extends Plugin implements GraphPluginHost {
  instance!: { options: Record<string, any>; saveOptions(): Promise<void> } & Record<string, any>;

  override async onload() {
    this.registerView(VIEW_TYPE_GRAPH, (leaf) => new GraphView(leaf, this, false));
    this.registerView(VIEW_TYPE_LOCAL_GRAPH, (leaf) => new GraphView(leaf, this, true));

    this.addRibbonIcon("lucide-git-fork", "Open graph view", () => void this.openGraph());

    this.addCommand({
      id: "graph:open",
      name: "Open graph view",
      icon: "lucide-git-fork",
      hotkeys: [{ modifiers: ["Mod"], key: "G" }],
      callback: () => void this.openGraph(),
    });
    this.addCommand({
      id: "graph:open-local",
      name: "Open local graph",
      icon: "lucide-git-fork",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile() as TFile | null;
        if (!file) return false;
        if (!checking) void this.openLocalGraph(file, this.app.workspace.activeLeaf);
        return true;
      },
    });
    this.addCommand({
      id: "graph:animate",
      name: "Start graph timelapse animation",
      icon: "lucide-play",
      checkCallback: (checking) => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof GraphView)) return false;
        if (!checking) view.onAnimate();
        return true;
      },
    });

    // "Open linked view → Open local graph" in a note's more-options menu.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string, leaf?: WorkspaceLeaf) => {
        if (!leaf || !LINKED_VIEW_SOURCES.has(source) || !("extension" in file)) return;
        if (leaf.view?.getViewType() === VIEW_TYPE_LOCAL_GRAPH) return;
        menu.addItem((item) =>
          item
            .setSection("view.linked")
            .setTitle("Open local graph")
            .setIcon("lucide-git-fork")
            .onClick(() => void this.openLocalGraph(file as TFile, leaf)),
        );
      }),
    );

    // Public methods other code reaches through `instance`.
    this.instance.openGraphView = () => this.openGraph();
    this.instance.openLocalGraph = (file: TFile, leaf?: WorkspaceLeaf) => this.openLocalGraph(file, leaf ?? null);
  }

  async openGraph(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GRAPH).find((l: WorkspaceLeaf) => l.getRoot?.() === this.app.workspace.rootSplit);
    if (existing) {
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      await this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf: WorkspaceLeaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_GRAPH, state: {}, active: true });
  }

  /** Local graph of `file` in a split to the right, linked to `source` when given. */
  async openLocalGraph(file: TFile, source: WorkspaceLeaf | null): Promise<void> {
    const ws = this.app.workspace;
    const anchor = source && source.getRoot?.() === ws.rootSplit ? source : null;
    const leaf: WorkspaceLeaf = anchor ? ws.createLeafBySplit(anchor, "vertical") : ws.getLeaf("split");
    await leaf.setViewState({ type: VIEW_TYPE_LOCAL_GRAPH, state: { file: file.path } });
    if (anchor) leaf.setGroupMember(anchor);
    ws.setActiveLeaf(leaf, { focus: true });
  }

  onGlobalOptionsChanged(source: GraphView) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GRAPH) as WorkspaceLeaf[]) {
      const view = leaf.view;
      if (view instanceof GraphView && view !== source) view.syncFromGlobal();
    }
  }
}

export const graph: CorePluginDefinition = {
  id: "graph",
  name: "Graph view",
  description: "Visualize the relationships between your notes.",
  icon: "lucide-git-fork",
  defaultOn: true,
  defaultOptions: { ...DEFAULT_GRAPH_OPTIONS },
  create: (app) => new GraphPlugin(app, { id: "graph", name: "Graph view", version: "", minAppVersion: "", author: "", description: "" }),
};
