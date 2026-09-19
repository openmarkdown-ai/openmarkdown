/**
 * Canvas core plugin (`canvas`): the `.canvas` view, "Create new canvas" from
 * the ribbon, command palette and file explorer, canvas embeds in notes, file
 * rename propagation, and the canvas settings page.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import type { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { normalizePath } from "../../obsidian/util";
import { TFile, TFolder, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { parseCanvas, serializeCanvas } from "./data";
import { CanvasEmbed } from "./embed";
import { ExportImageModal } from "./export";
import { CanvasView, DEFAULT_CANVAS_SETTINGS, VIEW_TYPE_CANVAS, type CanvasPluginHost, type CanvasSettings } from "./view";

const EMPTY_CANVAS = serializeCanvas({ nodes: [], edges: [] });

class CanvasPlugin extends Plugin implements CanvasPluginHost {
  instance!: { options: Record<string, any>; saveOptions(): Promise<void> } & Record<string, any>;

  canvasSettings(): CanvasSettings {
    return { ...DEFAULT_CANVAS_SETTINGS, ...(this.instance?.options ?? {}) } as CanvasSettings;
  }

  exportImage(view: CanvasView) {
    new ExportImageModal(this.app, view).open();
  }

  override async onload() {
    this.registerView(VIEW_TYPE_CANVAS, (leaf) => new CanvasView(leaf, this));
    this.registerExtensions(["canvas"], VIEW_TYPE_CANVAS);

    this.app.embedRegistry.registerExtension("canvas", (ctx: any, file: TFile) => new CanvasEmbed(ctx, file));
    this.register(() => this.app.embedRegistry.unregisterExtension("canvas"));

    this.addRibbonIcon("lucide-layout-dashboard", "Create new canvas", (evt) => void this.createCanvas(null, evt.ctrlKey || evt.metaKey));

    this.addCommand({ id: "canvas:new-file", name: "Create new canvas", icon: "lucide-layout-dashboard", callback: () => void this.createCanvas(null) });
    this.addCommand({
      id: "canvas:export-as-image",
      name: "Export as image",
      icon: "lucide-image-down",
      checkCallback: (checking) => this.withActiveCanvas(checking, (v) => this.exportImage(v)),
    });
    this.addCommand({
      id: "canvas:jump-to-group",
      name: "Jump to group",
      icon: "lucide-box-select",
      checkCallback: (checking) => this.withActiveCanvas(checking, (v) => v.jumpToGroup()),
    });
    this.addCommand({
      id: "canvas:convert-to-file",
      name: "Convert to file...",
      icon: "lucide-file-input",
      checkCallback: (checking) => {
        const view = this.activeCanvas();
        if (!view || view.readOnly || view.selectedNodes.size !== 1) return false;
        const id = [...view.selectedNodes][0]!;
        if (view.canvasData.nodes.find((n) => n.id === id)?.type !== "text") return false;
        if (!checking) view.convertToFile(id);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string) => {
        if (!(file instanceof TFolder) || source === "canvas-menu") return;
        menu.addItem((item) =>
          item
            .setSection("action-primary")
            .setTitle("New canvas")
            .setIcon("lucide-layout-dashboard")
            .onClick(() => void this.createCanvas(file)),
        );
      }),
    );

    this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => void this.onRename(file, oldPath)));

    if (this.app.setting?.addSettingTab) this.addSettingTab(new CanvasSettingTab(this.app, this));

    this.instance.createCanvas = (folder?: TFolder) => this.createCanvas(folder ?? null);
  }

  private activeCanvas(): CanvasView | null {
    const view = this.app.workspace.activeLeaf?.view;
    return view instanceof CanvasView ? view : null;
  }

  private withActiveCanvas(checking: boolean, run: (v: CanvasView) => void): boolean {
    const view = this.activeCanvas();
    if (!view) return false;
    if (!checking) run(view);
    return true;
  }

  private newFileFolder(): TFolder {
    const s = this.canvasSettings();
    const vault = this.app.vault;
    if (s.newFileLocation === "current") {
      const active = this.app.workspace.getActiveFile() as TFile | null;
      if (active?.parent) return active.parent;
    }
    if (s.newFileLocation === "folder" && s.newFileFolderPath) {
      const f = vault.getFolderByPath(normalizePath(s.newFileFolderPath));
      if (f) return f;
    }
    return vault.getRoot();
  }

  async createCanvas(folder: TFolder | null, newTab = false): Promise<TFile | null> {
    const target = folder ?? this.newFileFolder();
    const base = target.isRoot() ? "Untitled" : `${target.path}/Untitled`;
    try {
      const path = this.app.vault.getAvailablePath(base, "canvas");
      const file = (await this.app.vault.create(path, EMPTY_CANVAS)) as TFile;
      const leaf: WorkspaceLeaf = this.app.workspace.getLeaf(newTab ? "tab" : false);
      await leaf.openFile(file, { active: true });
      return file;
    } catch (e) {
      new Notice(`Could not create the canvas: ${(e as Error).message}`);
      return null;
    }
  }

  /** Keep file cards and group backgrounds pointing at renamed files. */
  private async onRename(file: TAbstractFile, oldPath: string) {
    const renames: [string, string][] = [];
    if (file instanceof TFile) renames.push([oldPath, file.path]);
    else if (file instanceof TFolder) {
      const walk = (f: TAbstractFile) => {
        if (f instanceof TFile) renames.push([`${oldPath}/${f.path.slice(file.path.length + 1)}`, f.path]);
        else if (f instanceof TFolder) f.children.forEach(walk);
      };
      walk(file);
    }
    if (!renames.length) return;
    const openViews = (this.app.workspace.getLeavesOfType(VIEW_TYPE_CANVAS) as WorkspaceLeaf[]).map((l) => l.view).filter((v): v is CanvasView => v instanceof CanvasView);
    const openPaths = new Set(openViews.map((v) => v.file?.path));
    for (const view of openViews) for (const [a, b] of renames) view.applyRename(a, b);
    const map = new Map(renames);
    let count = 0;
    for (const canvas of this.app.vault.getFiles() as TFile[]) {
      if (canvas.extension !== "canvas" || openPaths.has(canvas.path)) continue;
      const text: string = await this.app.vault.cachedRead(canvas);
      if (!renames.some(([a]) => text.includes(JSON.stringify(a).slice(1, -1)))) continue;
      try {
        const data = parseCanvas(text);
        let changed = false;
        for (const n of data.nodes) {
          if (n.file && map.has(n.file)) {
            n.file = map.get(n.file)!;
            changed = true;
          }
          if (n.background && map.has(n.background)) {
            n.background = map.get(n.background)!;
            changed = true;
          }
        }
        if (changed) {
          count++;
          await this.app.vault.modify(canvas, serializeCanvas(data));
        }
      } catch {
        /* leave unreadable canvases alone */
      }
    }
    if (count) new Notice(`Canvas detected file renames affecting ${count} canvas file${count === 1 ? "" : "s"}, updating...`);
  }
}

class CanvasSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private canvas: CanvasPlugin,
  ) {
    super(app, canvas as never);
    this.id = "canvas";
    this.name = "Canvas";
    this.icon = "lucide-layout-dashboard";
  }

  private set<K extends keyof CanvasSettings>(key: K, value: CanvasSettings[K]) {
    this.canvas.instance.options[key] = value;
    void this.canvas.instance.saveOptions();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CANVAS) as WorkspaceLeaf[]) (leaf.view as CanvasView).applyTransform?.();
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    const s = this.canvas.canvasSettings();
    new Setting(el)
      .setName("Default location for new canvas files")
      .addDropdown((d) =>
        d
          .addOptions({ root: "Vault folder", current: "Same folder as current file", folder: "In the folder specified below" })
          .setValue(s.newFileLocation)
          .onChange((v) => {
            this.set("newFileLocation", v as CanvasSettings["newFileLocation"]);
            this.display();
          }),
      );
    if (s.newFileLocation === "folder")
      new Setting(el)
        .setName("Folder to create new canvas files in")
        .addText((t) => t.setPlaceholder("Example: folder 1/folder 2").setValue(s.newFileFolderPath).onChange((v) => this.set("newFileFolderPath", v)));
    new Setting(el)
      .setName("Default mouse wheel behavior")
      .addDropdown((d) => d.addOptions({ pan: "Pan", zoom: "Zoom" }).setValue(s.defaultWheelBehavior).onChange((v) => this.set("defaultWheelBehavior", v as "pan" | "zoom")));
    new Setting(el)
      .setName("Default Mod+Drag behavior")
      .addDropdown((d) =>
        d
          .addOptions({ menu: "Show menu", card: "Add card", note: "Add note from vault", media: "Add media from vault", webpage: "Add web page", group: "Create group" })
          .setValue(s.defaultModDragBehavior)
          .onChange((v) => this.set("defaultModDragBehavior", v as CanvasSettings["defaultModDragBehavior"])),
      );
    new Setting(el)
      .setName("Show card names")
      .addDropdown((d) => d.addOptions({ always: "Always", hover: "On hover", never: "Never" }).setValue(s.cardNameVisibility).onChange((v) => this.set("cardNameVisibility", v as CanvasSettings["cardNameVisibility"])));
    new Setting(el).setName("Snap to grid").addToggle((t) => t.setValue(s.snapToGrid).onChange((v) => this.set("snapToGrid", v)));
    new Setting(el).setName("Snap to objects").addToggle((t) => t.setValue(s.snapToObjects).onChange((v) => this.set("snapToObjects", v)));
    new Setting(el)
      .setName("Zoom threshold for hiding card content")
      .setDesc("Card content is hidden when zoomed out past this level.")
      .addSlider((sl) => sl.setLimits(-0.7, 2.4, 0.1).setValue(s.zoomThreshold).onChange((v) => this.set("zoomThreshold", v)));
  }
}

export const canvas: CorePluginDefinition = {
  id: "canvas",
  name: "Canvas",
  description: "Arrange and connect notes on an infinite canvas.",
  icon: "lucide-layout-dashboard",
  defaultOn: true,
  defaultOptions: {},
  create: (app) => new CanvasPlugin(app, { id: "canvas", name: "Canvas", version: "", minAppVersion: "", author: "", description: "" }),
};
