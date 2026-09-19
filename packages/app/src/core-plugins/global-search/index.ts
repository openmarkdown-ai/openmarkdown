/**
 * Search (`global-search`): the Search view, the ```query code block, and the
 * entry points other features use (tag clicks, "Search in folder", "Search
 * for …" in the editor menu).
 *
 * Instance API (as in Obsidian, reached through
 * `app.internalPlugins.getPluginById("global-search").instance`):
 *   openGlobalSearch(query)   reveal the Search view and run `query`
 *   getGlobalSearchQuery()    the query in the Search view ("" if none)
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import type { Menu } from "../../obsidian/ui/menu";
import { TFolder, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { queryCodeBlockProcessor } from "./embedded-query";
import { lastReplace, undoWithNotice } from "./replace";
import { GlobalSearchView, VIEW_TYPE_SEARCH } from "./search-view";

function quoteIfNeeded(s: string): string {
  return /[\s"()]/.test(s) || s === "" ? `"${s.replace(/"/g, '\\"')}"` : s;
}

class GlobalSearchPlugin extends Plugin {
  instance!: any;

  override async onload() {
    this.registerView(VIEW_TYPE_SEARCH, (leaf: WorkspaceLeaf) => new GlobalSearchView(leaf, this));
    this.registerMarkdownCodeBlockProcessor("query", queryCodeBlockProcessor(this.app));

    this.addCommand({
      id: "global-search:open",
      name: "Search: Search in all files",
      icon: "lucide-search",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "F" }],
      callback: () => {
        const editor = this.app.workspace.activeEditor?.editor;
        const selection: string = editor?.getSelection?.() ?? "";
        if (selection && !selection.includes("\n")) void this.openGlobalSearch(selection);
        else void this.openGlobalSearch(null);
      },
    });

    this.addCommand({
      id: "global-search:replace",
      name: "Search: Replace in all files",
      icon: "lucide-replace",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "H" }],
      callback: async () => {
        const editor = this.app.workspace.activeEditor?.editor;
        const selection: string = editor?.getSelection?.() ?? "";
        await this.openGlobalSearch(selection && !selection.includes("\n") ? selection : null);
        this.getView()?.setReplaceOpen(true, true);
      },
    });
    this.addCommand({
      id: "global-search:undo-replace",
      name: "Search: Undo last vault replace",
      icon: "lucide-undo-2",
      checkCallback: (checking) => {
        if (!lastReplace()) return false;
        if (!checking) void undoWithNotice(this.app);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) =>
          item
            .setSection("action")
            .setTitle("Search in folder")
            .setIcon("lucide-search")
            .onClick(() => void this.openGlobalSearch(`path:${quoteIfNeeded(file.isRoot() ? "/" : file.path)} `)),
        );
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: any) => {
        const selection: string = editor?.getSelection?.() ?? "";
        if (!selection.trim() || selection.includes("\n")) return;
        const shown = selection.length > 30 ? selection.slice(0, 30) + "…" : selection;
        menu.addItem((item) =>
          item
            .setSection("selection")
            .setTitle(`Search for "${shown}"`)
            .setIcon("lucide-search")
            .onClick(() => void this.openGlobalSearch(selection)),
        );
      }),
    );

    this.instance.openGlobalSearch = (query: string) => this.openGlobalSearch(query);
    this.instance.getGlobalSearchQuery = () => this.getGlobalSearchQuery();
    // internal (used by plugins: some reach the view through the instance)
    this.instance.getSearchView = () => this.getView();
  }

  override onunload() {
    delete this.instance.openGlobalSearch;
    delete this.instance.getGlobalSearchQuery;
    delete this.instance.getSearchView;
  }

  getView(): GlobalSearchView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH)[0] as WorkspaceLeaf | undefined;
    const view = leaf?.view;
    return view instanceof GlobalSearchView ? view : null;
  }

  getGlobalSearchQuery(): string {
    return this.getView()?.getQuery() ?? "";
  }

  async openGlobalSearch(query: string | null) {
    const leaf = (await this.app.workspace.ensureSideLeaf(VIEW_TYPE_SEARCH, "left", { active: true, reveal: true })) as WorkspaceLeaf;
    await leaf.loadIfDeferred();
    const view = leaf.view;
    if (!(view instanceof GlobalSearchView)) return;
    if (query !== null && query !== undefined) view.setQuery(query);
    const input = view.searchComponent.inputEl;
    input.focus();
    if (query === null) input.select();
    else input.setSelectionRange(input.value.length, input.value.length);
  }
}

export const globalSearch: CorePluginDefinition = {
  id: "global-search",
  name: "Search",
  description: "Search for a keyword in all the notes.",
  icon: "lucide-search",
  defaultOn: true,
  defaultOptions: {},
  create: (app) => new GlobalSearchPlugin(app, { id: "global-search", name: "Search", version: "", minAppVersion: "", author: "", description: "" }),
};
