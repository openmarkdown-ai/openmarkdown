/**
 * Bases core plugin (`bases`): the `bases` view for `.base` files, the view
 * registry behind `Plugin.registerBasesView` (with the built-in Table, Cards,
 * List and Map layouts), ```base code blocks, `![[x.base]]` embeds, commands,
 * the ribbon action and the folder "New base" menu item.
 */
import { BasesRegistry } from "../../obsidian/bases/api";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import type { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { SuggestModal } from "../../obsidian/ui/suggest";
import { TFolder, type TAbstractFile, type TFile } from "../../obsidian/vault/files";
import { BaseFileEmbed, renderBaseCodeBlock } from "./embed";
import { CardsView, cardsOptions } from "./layouts/cards";
import { ListView, listOptions } from "./layouts/list";
import { MapView, mapOptions } from "./layouts/map";
import { TableView, tableOptions } from "./layouts/table";
import { FileRecordStore } from "./records";
import { addView, copyTable } from "./toolbar";
import { BasesFileView, VIEW_TYPE_BASES } from "./view";

export const DEFAULT_BASE = "views:\n  - type: table\n    name: Table\n";

class ViewSuggestModal extends SuggestModal<{ name: string; index: number; icon: string }> {
  constructor(
    app: any,
    private view: BasesFileView,
  ) {
    super(app);
    this.setPlaceholder("Select a view...");
  }
  getSuggestions(query: string) {
    const q = query.toLowerCase();
    const reg = this.view.host.plugin.registry;
    return this.view.host.controller.views
      .map((v: any, index: number) => ({ name: String(v?.name ?? ""), index, icon: reg.get(String(v?.type))?.icon ?? "lucide-table" }))
      .filter((v: { name: string }) => v.name.toLowerCase().includes(q));
  }
  renderSuggestion(item: { name: string; index: number }, el: HTMLElement) {
    el.createDiv({ cls: "suggestion-content" }).createDiv({ cls: "suggestion-title", text: item.name });
    if (item.index === this.view.host.controller.viewIndex) el.addClass("mod-active");
  }
  onChooseSuggestion(item: { index: number }) {
    this.view.host.selectView(item.index);
  }
}

class BasesPlugin extends Plugin {
  instance!: { options: Record<string, any>; saveOptions(): Promise<void> } & Record<string, any>;
  store!: FileRecordStore;
  registry!: BasesRegistry;

  override async onload() {
    const app = this.app;
    this.store = new FileRecordStore(app);
    this.register(() => this.store.dispose());
    this.registry = new BasesRegistry(app);
    app.basesRegistry = this.registry;
    this.register(() => {
      if (app.basesRegistry === this.registry) app.basesRegistry = null;
    });

    this.registry.register("table", { name: "Table", icon: "lucide-table", factory: (c, el) => new TableView(c, el), options: tableOptions });
    this.registry.register("cards", { name: "Cards", icon: "lucide-layout-grid", factory: (c, el) => new CardsView(c, el), options: cardsOptions });
    this.registry.register("list", { name: "List", icon: "lucide-list", factory: (c, el) => new ListView(c, el), options: listOptions });
    // The official Maps plugin registers `map` itself; ours steps aside when it does.
    this.registry.registerFallback("map", { name: "Map", icon: "lucide-map", factory: (c, el) => new MapView(c, el), options: mapOptions });

    this.registerView(VIEW_TYPE_BASES, (leaf) => new BasesFileView(leaf, this));
    this.registerExtensions(["base"], VIEW_TYPE_BASES);

    app.embedRegistry.registerExtension("base", (ctx: any, file: TFile, subpath: string) => new BaseFileEmbed(this, ctx, file, subpath));
    this.register(() => app.embedRegistry.unregisterExtension("base"));

    this.registerMarkdownCodeBlockProcessor("base", (source, el, ctx) => {
      renderBaseCodeBlock(this, source, el, ctx);
    });

    this.addRibbonIcon("lucide-table", "Create new base", (evt) => void this.createBase(null, evt.ctrlKey || evt.metaKey));

    this.addCommand({ id: "bases:new-file", name: "Create new base", icon: "lucide-table", callback: () => void this.createBase(null) });
    this.addCommand({
      id: "bases:insert",
      name: "Insert new base",
      icon: "lucide-table",
      editorCallback: (editor: any, ctx: any) => void this.insertBase(editor, ctx?.file ?? app.workspace.getActiveFile()),
    });
    this.addCommand({
      id: "bases:copy-table",
      name: "Copy table to clipboard",
      icon: "lucide-copy",
      checkCallback: (checking: boolean) => this.withActiveBase(checking, (v) => void copyTable(v.host)),
    });
    this.addCommand({
      id: "bases:change-view",
      name: "Switch view...",
      icon: "lucide-layers",
      checkCallback: (checking: boolean) => this.withActiveBase(checking, (v) => new ViewSuggestModal(app, v).open()),
    });
    this.addCommand({
      id: "bases:add-view",
      name: "Add view",
      icon: "lucide-plus",
      checkCallback: (checking: boolean) => this.withActiveBase(checking, (v) => addView(v.host)),
    });
    this.addCommand({
      id: "bases:add-item",
      name: "Add item",
      icon: "lucide-file-plus",
      checkCallback: (checking: boolean) => this.withActiveBase(checking, (v) => void v.host.controller.createFileForView()),
    });

    this.registerEvent(
      app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) =>
          item
            .setSection("action-primary")
            .setTitle("New base")
            .setIcon("lucide-table")
            .onClick(() => void this.createBase(file)),
        );
      }),
    );

    this.instance.createBase = (folder?: TFolder) => this.createBase(folder ?? null);
  }

  private activeBase(): BasesFileView | null {
    const view = this.app.workspace.activeLeaf?.view;
    return view instanceof BasesFileView ? view : null;
  }

  private withActiveBase(checking: boolean, run: (v: BasesFileView) => void): boolean {
    const view = this.activeBase();
    if (!view) return false;
    if (!checking) run(view);
    return true;
  }

  private targetFolder(): TFolder {
    const active = this.app.workspace.getActiveFile() as TFile | null;
    return active?.parent ?? this.app.vault.getRoot();
  }

  private async newBaseFile(folder: TFolder | null): Promise<TFile | null> {
    const target = folder ?? this.targetFolder();
    const base = target.isRoot() ? "Untitled" : `${target.path}/Untitled`;
    try {
      return (await this.app.vault.create(this.app.vault.getAvailablePath(base, "base"), DEFAULT_BASE)) as TFile;
    } catch (e) {
      new Notice(`Could not create the base: ${(e as Error).message}`);
      return null;
    }
  }

  async createBase(folder: TFolder | null, newTab = false): Promise<TFile | null> {
    const file = await this.newBaseFile(folder);
    if (file) await this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file, { active: true });
    return file;
  }

  private async insertBase(editor: any, source: TFile | null) {
    const file = await this.newBaseFile(source?.parent ?? null);
    if (!file) return;
    const link = this.app.fileManager.generateMarkdownLink(file, source?.path ?? "");
    editor.replaceSelection(`!${link.startsWith("!") ? link.slice(1) : link}`);
  }
}

export const bases: CorePluginDefinition = {
  id: "bases",
  name: "Bases",
  description: "Create custom views that let you edit, sort, and filter files using their properties.",
  icon: "lucide-table",
  defaultOn: true,
  defaultOptions: {},
  create: (app) => new BasesPlugin(app, { id: "bases", name: "Bases", version: "", minAppVersion: "", author: "", description: "" }),
};
