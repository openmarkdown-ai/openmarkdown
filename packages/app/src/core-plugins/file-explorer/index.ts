/**
 * Core plugin "Files" (`file-explorer`): the explorer view, its commands, and
 * the "Reveal file in navigation" item other views' file menus get.
 *
 * Published on `instance` (reached through
 * `app.internalPlugins.getPluginById("file-explorer").instance`):
 * `revealInFolder(file)`, `fileItems` (the open view's path → item map),
 * `getExplorerView()`.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import type { Menu } from "../../obsidian/ui/menu";
import { TFile, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { MoveToFolderModal, createNewFolder, createNewNote, duplicateFile, duplicateLabel } from "./actions";
import type { ManualOrder } from "./sort";
import { FILE_EXPLORER_MENU_SOURCE, FileExplorerView, VIEW_TYPE_FILE_EXPLORER } from "./view";

class FileExplorerPlugin extends Plugin {
  instance!: any;

  override async onload() {
    this.registerView(VIEW_TYPE_FILE_EXPLORER, (leaf: WorkspaceLeaf) => new FileExplorerView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE_FILE_EXPLORER, { display: "Files", defaultMod: true });

    const instance = this.instance;
    instance.revealInFolder = (file: TAbstractFile) => void this.revealInFolder(file);
    instance.getExplorerView = () => this.getView();
    Object.defineProperty(instance, "fileItems", {
      configurable: true,
      enumerable: false,
      get: () => this.getView()?.fileItems ?? {},
    });
    this.register(() => {
      delete instance.revealInFolder;
      delete instance.getExplorerView;
      delete instance.fileItems;
    });

    this.addCommands();
    this.trackManualOrder();

    // Other views' file menus (tab header, "More options", links) can reveal the file here.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string) => {
        if (source === FILE_EXPLORER_MENU_SOURCE || source === "link-context-menu") return;
        menu.addItem((item) =>
          item
            .setSection("system")
            .setTitle("Reveal file in navigation")
            .setIcon("lucide-folder-open")
            .onClick(() => void this.revealInFolder(file)),
        );
      }),
    );

    // A vault without the view in its saved layout still gets one in the left sidebar.
    this.app.workspace.onLayoutReady(() => {
      if (this.app.workspace.getLeavesOfType(VIEW_TYPE_FILE_EXPLORER).length === 0) {
        void this.app.workspace.ensureSideLeaf(VIEW_TYPE_FILE_EXPLORER, "left", { reveal: false });
      }
    });
  }

  override onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_FILE_EXPLORER);
  }

  /** Keep "Custom order" lists in step with renames, moves and deletions (even with the view closed). */
  private trackManualOrder() {
    const order = (): ManualOrder => {
      const o = this.instance.options;
      if (!o.manualOrder || typeof o.manualOrder !== "object") o.manualOrder = {};
      return o.manualOrder as ManualOrder;
    };
    const save = () => void this.instance.saveOptions();
    const parentKey = (path: string) => {
      const i = path.lastIndexOf("/");
      return i === -1 ? "/" : path.slice(0, i);
    };
    const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        const map = order();
        let changed = false;
        const oldKey = parentKey(oldPath);
        const list = map[oldKey];
        if (list) {
          const i = list.indexOf(nameOf(oldPath));
          if (i !== -1) {
            if (parentKey(file.path) === oldKey) list[i] = file.name;
            else list.splice(i, 1);
            changed = true;
          }
        }
        // A renamed folder keeps the order of everything inside it.
        for (const key of Object.keys(map)) {
          if (key === oldPath || key.startsWith(oldPath + "/")) {
            map[file.path + key.slice(oldPath.length)] = map[key]!;
            delete map[key];
            changed = true;
          }
        }
        if (changed) save();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        const map = order();
        const list = map[parentKey(file.path)];
        const i = list ? list.indexOf(file.name) : -1;
        if (i === -1) return;
        list!.splice(i, 1);
        delete map[file.path];
        save();
      }),
    );
  }

  getView(): FileExplorerView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_FILE_EXPLORER)[0];
    const view = leaf?.view;
    return view instanceof FileExplorerView ? view : null;
  }

  async showExplorer(): Promise<{ leaf: WorkspaceLeaf; view: FileExplorerView } | null> {
    const leaf: WorkspaceLeaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_FILE_EXPLORER, "left", { reveal: true });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof FileExplorerView ? { leaf, view: leaf.view } : null;
  }

  async revealInFolder(file: TAbstractFile) {
    const shown = await this.showExplorer();
    shown?.view.revealInFolder(file, true);
  }

  private newFileParent() {
    return this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
  }

  private addCommands() {
    const { workspace } = this.app;
    const activeFile = (): TFile | null => {
      const f = workspace.getActiveFile();
      return f instanceof TFile ? f : null;
    };

    this.addCommand({
      id: "file-explorer:open",
      name: "Files: Show file explorer",
      callback: () => void this.showExplorer().then((s) => s && workspace.setActiveLeaf(s.leaf, { focus: true })),
    });
    this.addCommand({
      id: "file-explorer:reveal-active-file",
      name: "Files: Reveal current file in navigation",
      checkCallback: (checking) => {
        const file = activeFile();
        if (!file) return false;
        if (!checking) void this.revealInFolder(file);
        return true;
      },
    });
    this.addCommand({
      id: "file-explorer:new-file",
      name: "Files: Create new note",
      icon: "lucide-edit",
      hotkeys: [{ modifiers: ["Mod"], key: "n" }],
      callback: () => void createNewNote(this.app, this.newFileParent()),
    });
    this.addCommand({
      id: "file-explorer:new-file-in-current-tab",
      name: "Files: Create new note in current tab",
      icon: "lucide-edit",
      callback: () => void createNewNote(this.app, this.newFileParent(), false),
    });
    this.addCommand({
      id: "file-explorer:new-file-in-new-pane",
      name: "Files: Create note to the right",
      icon: "lucide-separator-vertical",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "n" }],
      callback: () => void createNewNote(this.app, this.newFileParent(), "split"),
    });
    this.addCommand({
      id: "file-explorer:new-folder",
      name: "Files: Create new folder",
      icon: "lucide-folder-plus",
      callback: async () => {
        const folder = await createNewFolder(this.app, this.newFileParent());
        if (!folder) return;
        const shown = await this.showExplorer();
        if (!shown) return;
        shown.view.revealInFolder(folder, true);
        const item = shown.view.fileItems[folder.path];
        if (item) shown.view.startRename(item);
      },
    });
    this.addCommand({
      id: "file-explorer:move-file",
      name: "Files: Move current file to another folder",
      icon: "lucide-folder-tree",
      checkCallback: (checking) => {
        const file = activeFile();
        if (!file) return false;
        if (!checking) new MoveToFolderModal(this.app, [file]).open();
        return true;
      },
    });
    this.addCommand({
      id: "file-explorer:duplicate-file",
      name: duplicateLabel() === "Duplicate" ? "Files: Duplicate current file" : "Files: Make a copy of the current file",
      icon: "lucide-files",
      checkCallback: (checking) => {
        const file = activeFile();
        if (!file) return false;
        if (!checking) void duplicateFile(this.app, file);
        return true;
      },
    });
  }
}

export const fileExplorer: CorePluginDefinition = {
  id: "file-explorer",
  name: "Files",
  description: "Browse the files and folders in your vault.",
  icon: "lucide-folder-closed",
  defaultOn: true,
  defaultOptions: { manualOrder: {} },
  create: (app) =>
    new FileExplorerPlugin(app, { id: "file-explorer", name: "Files", version: "", minAppVersion: "", author: "", description: "" }),
};
