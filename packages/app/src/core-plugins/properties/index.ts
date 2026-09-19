/**
 * Properties view (`properties`): All properties (`all-properties`) and File
 * properties (`file-properties`), plus the property commands of the Markdown
 * editor when nothing else registered them.
 *
 * Importing this module installs the metadata editor into the Markdown view
 * (see metadata-editor.ts), so properties render in notes even with the
 * plugin disabled — as in Obsidian, where the widget is part of the editor.
 */
import type { ViewStateResult } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Menu } from "../../obsidian/ui/menu";
import { ConfirmationModal, Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import { debounce } from "../../obsidian/util";
import { TFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ItemView } from "../../obsidian/workspace/view";
import { FileInfoView, FilterBox, findViewForFile, NavHeader, setButtonState, showSideView, showSortMenu } from "../global-search/common";
import { compareNames } from "../global-search/engine";
import { frontmatterYamlOf, renderMetadataEditor, replaceFrontmatter, type MetadataEditor } from "./metadata-editor";
import { iconForType, isCompatible, RESERVED_KEYS, TYPE_INFO, USER_TYPES, convertValue, type PropertyType } from "./types";

export { renderMetadataEditor } from "./metadata-editor";

export const VIEW_TYPE_ALL_PROPERTIES = "all-properties";
export const VIEW_TYPE_FILE_PROPERTIES = "file-properties";

type PropSort = "alphabetical" | "alphabeticalReverse" | "frequency" | "frequencyReverse";
const PROP_SORTS: [PropSort, string][] = [
  ["alphabetical", "Property name (A to Z)"],
  ["alphabeticalReverse", "Property name (Z to A)"],
  ["frequency", "Frequency (high to low)"],
  ["frequencyReverse", "Frequency (low to high)"],
];

interface PropInfo {
  name: string;
  type: PropertyType;
  count: number;
}

// ---- vault-wide operations ---------------------------------------------------------

function filesWithProperty(app: any, name: string): TFile[] {
  const lower = name.toLowerCase();
  return (app.vault.getMarkdownFiles() as TFile[]).filter((f) => {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    return fm && Object.keys(fm).some((k) => k.toLowerCase() === lower);
  });
}

/** File recovery snapshot before a vault-wide property edit rewrites a note. */
async function snapshotBefore(app: any, file: TFile) {
  const recovery = app.internalPlugins?.getEnabledPluginById?.("file-recovery");
  if (!recovery?.forceAdd) return;
  try {
    await recovery.forceAdd(file.path, await app.vault.read(file));
  } catch (e) {
    console.error("Properties: could not snapshot", file.path, e);
  }
}

/** Renames (or merges) property `from` into `to` in every note, keeping key order. */
export async function renameProperty(app: any, from: string, to: string) {
  const lowerFrom = from.toLowerCase();
  const lowerTo = to.toLowerCase();
  let changed = 0;
  for (const file of filesWithProperty(app, from)) {
    await snapshotBefore(app, file);
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const entries = Object.entries(fm);
      const srcKey = entries.find(([k]) => k.toLowerCase() === lowerFrom)?.[0];
      if (srcKey === undefined) return;
      const dstKey = lowerFrom === lowerTo ? undefined : entries.find(([k]) => k.toLowerCase() === lowerTo)?.[0];
      for (const [k] of entries) delete fm[k];
      for (const [k, v] of entries) {
        if (k === srcKey) {
          if (dstKey !== undefined) continue;
          fm[to] = v;
        } else if (k === dstKey) {
          const src = entries.find(([kk]) => kk === srcKey)![1];
          fm[k] = mergeValues(v, src);
        } else fm[k] = v;
      }
    });
    changed++;
  }
  const mtm = app.metadataTypeManager;
  const oldType = mtm?.types?.[lowerFrom];
  if (oldType && lowerFrom !== lowerTo) {
    if (!mtm.types[lowerTo]) mtm.setType(to, oldType);
    mtm.unsetType(from);
  }
  return changed;
}

function mergeValues(a: unknown, b: unknown): unknown {
  if (a === null || a === undefined || a === "") return b;
  if (b === null || b === undefined || b === "") return a;
  if (Array.isArray(a) || Array.isArray(b)) {
    const out = [...(Array.isArray(a) ? a : [a])];
    for (const x of Array.isArray(b) ? b : [b]) if (!out.includes(x)) out.push(x);
    return out;
  }
  return a;
}

export async function deleteProperty(app: any, name: string) {
  const lower = name.toLowerCase();
  for (const file of filesWithProperty(app, name)) {
    await snapshotBefore(app, file);
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      for (const k of Object.keys(fm)) if (k.toLowerCase() === lower) delete fm[k];
    });
  }
}

async function changePropertyType(app: any, info: PropInfo, type: PropertyType) {
  const files = filesWithProperty(app, info.name);
  const incompatible = files.filter((f) => {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter ?? {};
    const k = Object.keys(fm).find((kk) => kk.toLowerCase() === info.name.toLowerCase());
    return k !== undefined && !isCompatible(type, fm[k]);
  });
  const apply = async () => {
    app.metadataTypeManager.setType(info.name, type);
    for (const f of incompatible) {
      await snapshotBefore(app, f);
      await app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
        for (const k of Object.keys(fm)) if (k.toLowerCase() === info.name.toLowerCase()) fm[k] = convertValue(type, fm[k]);
      });
    }
  };
  if (!incompatible.length) {
    await apply();
    return;
  }
  const modal = new ConfirmationModal(app);
  modal.setTitle(`Display as ${TYPE_INFO[type].name.toLowerCase()}?`);
  modal.setContent(`Your ${TYPE_INFO[info.type]?.name.toLowerCase() ?? "existing"} data is not compatible in ${incompatible.length} file${incompatible.length === 1 ? "" : "s"}. It will be adapted to fit the new format.`);
  modal.addButton((b) => b.setButtonText("Update").setCta().onClick(() => apply()));
  modal.addCancelButton();
  modal.open();
}

class RenamePropertyModal extends Modal {
  constructor(
    app: any,
    private info: PropInfo,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle("Rename property");
    let value = this.info.name;
    const submit = async () => {
      const next = value.trim();
      if (!next || next === this.info.name) {
        this.close();
        return;
      }
      const existing = Object.values((this.app as any).metadataTypeManager.getAllProperties() as Record<string, PropInfo>).find(
        (p) => p.name.toLowerCase() === next.toLowerCase() && p.name.toLowerCase() !== this.info.name.toLowerCase(),
      );
      const run = async () => {
        const n = await renameProperty(this.app, this.info.name, next);
        new Notice(`Updated ${n} file${n === 1 ? "" : "s"}.`);
      };
      this.close();
      if (existing) {
        const confirm = new ConfirmationModal(this.app);
        confirm.setTitle("Merge property");
        confirm.setContent(`Merge property “${this.info.name}” with “${existing.name}”? This affects ${this.info.count} file${this.info.count === 1 ? "" : "s"}.`);
        confirm.addButton((b) => b.setButtonText("Merge").setCta().onClick(run));
        confirm.addCancelButton();
        confirm.open();
      } else await run();
    };
    new Setting(this.contentEl).setName("Property name").addText((t) => {
      t.setValue(value).onChange((v) => (value = v));
      t.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          void submit();
        }
      });
      window.setTimeout(() => t.inputEl.select(), 0);
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Rename").setCta().onClick(() => void submit()))
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

// ---- All properties -------------------------------------------------------------------

export class AllPropertiesView extends ItemView {
  sortOrder: PropSort = "frequency";
  showSearch = false;
  searchQuery = "";
  headerDom!: NavHeader;
  filter!: FilterBox;
  listEl!: HTMLElement;
  private buttons: Record<string, HTMLElement> = {};
  private items: { info: PropInfo; el: HTMLElement }[] = [];
  private selected = new Set<string>();
  private requestRender = debounce(() => this.render(), 300, true);

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "lucide-archive";
  }

  getViewType() {
    return VIEW_TYPE_ALL_PROPERTIES;
  }

  getDisplayText() {
    return "All properties";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.headerDom = new NavHeader(this.contentEl, false);
    this.buttons.sort = this.headerDom.addButton("lucide-arrow-up-narrow-wide", "Change sort order", (evt) =>
      showSortMenu(evt, PROP_SORTS, this.sortOrder, (v) => {
        this.sortOrder = v;
        this.render();
        this.app.workspace.requestSaveLayout();
      }),
    );
    this.buttons.search = this.headerDom.addButton("lucide-search", "Show search filter", () => {
      this.showSearch = !this.showSearch;
      if (!this.showSearch) this.searchQuery = "";
      this.applyButtons();
      if (this.showSearch) this.filter.component.inputEl.focus();
      this.render();
      this.app.workspace.requestSaveLayout();
    });
    this.filter = new FilterBox(this.contentEl, "Search properties...", (v) => {
      this.searchQuery = v;
      this.render();
    });
    this.listEl = this.contentEl.createDiv({ cls: "all-properties-container", attr: { tabindex: "0" } });
    this.listEl.addEventListener("keydown", (evt) => this.onKey(evt));
    this.applyButtons();
    this.registerEvent(this.app.metadataTypeManager.on("changed", () => this.requestRender()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.requestRender()));
    this.render();
  }

  override getState(): Record<string, unknown> {
    return { sortOrder: this.sortOrder, showSearch: this.showSearch, searchQuery: this.searchQuery };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    if (state && typeof state === "object") {
      if (PROP_SORTS.some(([k]) => k === state.sortOrder)) this.sortOrder = state.sortOrder;
      if (typeof state.showSearch === "boolean") this.showSearch = state.showSearch;
      if (typeof state.searchQuery === "string") this.searchQuery = state.searchQuery;
      if (this.listEl) {
        this.applyButtons();
        this.render();
      }
    }
    await super.setState(state, result);
  }

  private applyButtons() {
    setButtonState(this.buttons.search!, this.showSearch);
    this.filter.show(this.showSearch);
    if (this.filter.component.getValue() !== this.searchQuery) this.filter.component.setValue(this.searchQuery);
  }

  private props(): PropInfo[] {
    const all = Object.values(this.app.metadataTypeManager.getAllProperties() ?? {}) as PropInfo[];
    const q = this.searchQuery.trim().toLowerCase();
    const list = all.filter((p) => !q || p.name.toLowerCase().includes(q));
    const byName = (a: PropInfo, b: PropInfo) => compareNames(a.name, b.name);
    switch (this.sortOrder) {
      case "alphabetical":
        return list.sort(byName);
      case "alphabeticalReverse":
        return list.sort((a, b) => byName(b, a));
      case "frequencyReverse":
        return list.sort((a, b) => a.count - b.count || byName(a, b));
      default:
        return list.sort((a, b) => b.count - a.count || byName(a, b));
    }
  }

  render() {
    if (!this.listEl) return;
    const focused = this.listEl.querySelector<HTMLElement>(".has-focus")?.dataset.propertyKey ?? null;
    this.listEl.empty();
    this.items = [];
    const q = this.searchQuery.trim().toLowerCase();
    for (const info of this.props()) {
      const item = this.listEl.createDiv({ cls: "tree-item" });
      const self = item.createDiv({ cls: "tree-item-self is-clickable", attr: { "data-property-key": info.name, "data-property-type": info.type, draggable: "true" } });
      setIcon(self.createDiv({ cls: "tree-item-icon" }), iconForType(info.type));
      const inner = self.createDiv({ cls: "tree-item-inner" });
      const i = q ? info.name.toLowerCase().indexOf(q) : -1;
      if (i >= 0) {
        inner.appendText(info.name.slice(0, i));
        inner.createSpan({ cls: "search-result-file-matched-text", text: info.name.slice(i, i + q.length) });
        inner.appendText(info.name.slice(i + q.length));
      } else inner.setText(info.name);
      self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: String(info.count) });
      self.toggleClass("is-selected", this.selected.has(info.name));
      if (focused === info.name) self.addClass("has-focus");
      self.addEventListener("click", (evt) => {
        if (evt.shiftKey || evt.altKey) {
          this.toggleSelected(info.name);
          return;
        }
        this.selected.clear();
        this.setFocus(info.name);
        this.openSearch(info);
      });
      self.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        this.setFocus(info.name);
        this.showMenu(info, evt);
      });
      self.addEventListener("dragstart", (evt) => evt.dataTransfer?.setData("text/plain", `[${info.name}]`));
      this.items.push({ info, el: self });
    }
    if (!this.items.length) this.listEl.createDiv({ cls: "pane-empty", text: q ? "No matching properties." : "No properties found." });
  }

  private toggleSelected(name: string) {
    if (this.selected.has(name)) this.selected.delete(name);
    else this.selected.add(name);
    for (const it of this.items) it.el.toggleClass("is-selected", this.selected.has(it.info.name));
  }

  private setFocus(name: string) {
    for (const it of this.items) it.el.toggleClass("has-focus", it.info.name === name);
  }

  private openSearch(info: PropInfo) {
    const name = /[\s:\]"]/.test(info.name) ? `"${info.name}"` : info.name;
    this.app.internalPlugins.getEnabledPluginById("global-search")?.openGlobalSearch?.(`[${name}]`);
  }

  private showMenu(info: PropInfo, evt: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) => i.setSection("action").setTitle("Rename...").setIcon("lucide-pencil").onClick(() => new RenamePropertyModal(this.app, info).open()));
    menu.addItem((item) => {
      item.setSection("action").setTitle("Property type").setIcon(iconForType(info.type));
      const sub = item.setSubmenu();
      const reserved = RESERVED_KEYS[info.name.toLowerCase()];
      for (const t of USER_TYPES) {
        sub.addItem((s) =>
          s
            .setTitle(TYPE_INFO[t].name)
            .setIcon(TYPE_INFO[t].icon)
            .setChecked(info.type === t)
            .setDisabled(!!reserved)
            .onClick(() => void changePropertyType(this.app, info, t)),
        );
      }
    });
    menu.addItem((i) => i.setSection("action").setTitle("Search").setIcon("lucide-search").onClick(() => this.openSearch(info)));
    menu.addItem((i) => i.setSection("danger").setTitle("Delete").setIcon("lucide-trash-2").setWarning(true).onClick(() => this.confirmDelete(this.selected.size ? Array.from(this.selected) : [info.name])));
    menu.showAtMouseEvent(evt);
  }

  private confirmDelete(names: string[]) {
    const infos = (Object.values(this.app.metadataTypeManager.getAllProperties()) as PropInfo[]).filter((p) => names.includes(p.name));
    const files = new Set<TFile>();
    for (const p of infos) for (const f of filesWithProperty(this.app, p.name)) files.add(f);
    const modal = new ConfirmationModal(this.app);
    modal.setTitle(names.length === 1 ? `Delete property “${names[0]}”?` : `Delete ${names.length} properties?`);
    modal.setContent(`This removes it from ${files.size} file${files.size === 1 ? "" : "s"}. File recovery keeps the previous version of each note.`);
    modal.addButton((b) =>
      b
        .setButtonText("Delete")
        .setWarning()
        .onClick(async () => {
          for (const n of names) await deleteProperty(this.app, n);
          this.selected.clear();
        }),
    );
    modal.addCancelButton();
    modal.open();
  }

  private onKey(evt: KeyboardEvent) {
    if (!this.items.length) return;
    const idx = this.items.findIndex((it) => it.el.hasClass("has-focus"));
    const move = (i: number) => {
      const it = this.items[Math.max(0, Math.min(this.items.length - 1, i))]!;
      this.setFocus(it.info.name);
      it.el.scrollIntoView({ block: "nearest" });
    };
    if (evt.key === "ArrowDown") {
      evt.preventDefault();
      move(idx + 1);
    } else if (evt.key === "ArrowUp") {
      evt.preventDefault();
      move(idx - 1);
    } else if (evt.key === "Enter" && idx >= 0) {
      evt.preventDefault();
      this.openSearch(this.items[idx]!.info);
    } else if ((evt.key === "Backspace" || evt.key === "Delete") && idx >= 0) {
      evt.preventDefault();
      this.confirmDelete(this.selected.size ? Array.from(this.selected) : [this.items[idx]!.info.name]);
    } else if (evt.key === "Escape") {
      this.selected.clear();
      this.render();
    }
  }
}

// ---- File properties ----------------------------------------------------------------------

export class FilePropertiesView extends FileInfoView {
  hoverPopover: any = null;
  editor: MetadataEditor | null = null;
  bodyEl!: HTMLElement;
  private renderedPath: string | null = null;
  private requestRefresh = debounce(() => void this.refresh(), 200, true);

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "lucide-info";
  }

  getViewType() {
    return VIEW_TYPE_FILE_PROPERTIES;
  }

  getDisplayText() {
    return this.file ? `File properties for ${this.file.basename}` : "File properties";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("file-properties-view");
    this.bodyEl = this.contentEl.createDiv({ cls: "metadata-properties-container" });
    this.registerEvent(
      this.app.metadataCache.on("changed", (f: TFile) => {
        if (f === this.file) this.requestRefresh();
      }),
    );
    await super.onOpen();
  }

  override async onClose(): Promise<void> {
    this.editor?.unload();
    this.editor = null;
  }

  onFileChanged(): void {
    void this.refresh();
  }

  async refresh() {
    if (!this.bodyEl) return;
    const file = this.file;
    if (!file || file.extension !== "md") {
      this.editor?.unload();
      this.editor = null;
      this.renderedPath = null;
      this.bodyEl.empty();
      this.bodyEl.createDiv({ cls: "pane-empty", text: file ? "Properties are only available for Markdown files." : "No file is open." });
      return;
    }
    const open = findViewForFile(this.app, this.leaf, file);
    const text: string = open && typeof open.getViewData === "function" && open.file === file ? open.getViewData() : await this.app.vault.cachedRead(file);
    if (file !== this.file) return;
    const { yaml } = frontmatterYamlOf(text);
    if (this.editor && this.renderedPath === file.path) {
      this.editor.update(yaml);
      return;
    }
    this.editor?.unload();
    this.bodyEl.empty();
    this.renderedPath = file.path;
    this.editor = renderMetadataEditor(this.app, this.bodyEl, file, yaml, (newYaml) => void this.write(file, newYaml), {
      sidebar: true,
      showHeading: false,
      hoverParent: this,
    });
  }

  private async write(file: TFile, yaml: string) {
    const open = findViewForFile(this.app, this.leaf, file);
    if (open && open.file === file && typeof open.replaceFrontmatter === "function") {
      open.replaceFrontmatter(yaml);
      return;
    }
    await this.app.vault.process(file, (text: string) => replaceFrontmatter(text, yaml));
  }
}

// ---- plugin ------------------------------------------------------------------------------

/** The live metadata editor of a Markdown view, if its properties are showing. */
function metadataEditorOf(view: any): MetadataEditor | null {
  const root: HTMLElement | undefined = view?.containerEl;
  if (!root) return null;
  const mode = typeof view.getMode === "function" ? view.getMode() : "source";
  const scope = root.querySelector<HTMLElement>(mode === "preview" ? ".markdown-reading-view" : ".markdown-source-view") ?? root;
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>(".metadata-container"))) {
    const ed = (el as HTMLElement & { __metadataEditor?: MetadataEditor }).__metadataEditor;
    if (ed && el.isConnected && !el.hidden) return ed;
  }
  return null;
}

class PropertiesPlugin extends Plugin {
  instance!: any;

  override async onload() {
    this.registerView(VIEW_TYPE_ALL_PROPERTIES, (leaf: WorkspaceLeaf) => new AllPropertiesView(leaf));
    this.registerView(VIEW_TYPE_FILE_PROPERTIES, (leaf: WorkspaceLeaf) => new FilePropertiesView(leaf));
    this.addCommand({ id: "properties:open", name: "Properties view: Show all properties", icon: "lucide-archive", callback: () => void showSideView(this.app, VIEW_TYPE_ALL_PROPERTIES) });
    this.addCommand({
      id: "properties:open-local",
      name: "Properties view: Show file properties",
      icon: "lucide-info",
      callback: () => void showSideView(this.app, VIEW_TYPE_FILE_PROPERTIES),
    });

    // Markdown property commands, unless the Markdown view registered its own.
    const cmds = this.app.commands.commands as Record<string, unknown>;
    if (!cmds["markdown:add-metadata-property"]) {
      this.addCommand({
        id: "markdown:add-metadata-property",
        name: "Add file property",
        icon: "lucide-plus-circle",
        hotkeys: [{ modifiers: ["Mod"], key: ";" }],
        checkCallback: (checking: boolean) => {
          const view = this.activeMarkdownView();
          if (!view) return false;
          if (!checking) void this.addProperty(view);
          return true;
        },
      });
    }
    if (!cmds["markdown:add-alias"]) {
      this.addCommand({
        id: "markdown:add-alias",
        name: "Add alias",
        icon: "lucide-forward",
        checkCallback: (checking: boolean) => {
          const view = this.activeMarkdownView();
          if (!view) return false;
          if (!checking) void this.addProperty(view, "aliases");
          return true;
        },
      });
    }
    if (!cmds["markdown:clear-metadata-properties"]) {
      this.addCommand({
        id: "markdown:clear-metadata-properties",
        name: "Clear file properties",
        icon: "lucide-eraser",
        checkCallback: (checking: boolean) => {
          const view = this.activeMarkdownView();
          const file = view?.file as TFile | undefined;
          if (!file || !this.app.metadataCache.getFileCache(file)?.frontmatterPosition) return false;
          if (!checking) {
            if (typeof view.replaceFrontmatter === "function") view.replaceFrontmatter("");
            else void this.app.vault.process(file, (t: string) => replaceFrontmatter(t, ""));
          }
          return true;
        },
      });
    }
    this.instance.renderMetadataEditor = renderMetadataEditor;
  }

  private activeMarkdownView(): any {
    const view = this.app.workspace.activeLeaf?.view;
    return view && view.getViewType?.() === "markdown" && view.file ? view : null;
  }

  private async addProperty(view: any, key?: string) {
    let ed = metadataEditorOf(view);
    if (!ed) {
      const data: string = typeof view.getViewData === "function" ? view.getViewData() : "";
      const { exists } = frontmatterYamlOf(data);
      if (!exists) {
        if (key) {
          if (typeof view.replaceFrontmatter === "function") view.replaceFrontmatter(`${key}:\n`);
        } else if (view.editor && (typeof view.getMode !== "function" || view.getMode() === "source")) {
          view.editor.replaceRange("---\n\n---\n", { line: 0, ch: 0 });
        } else if (typeof view.replaceFrontmatter === "function") {
          // Reading view: an empty block is not rendered, so start in editing mode.
          view.editor?.replaceRange?.("---\n\n---\n", { line: 0, ch: 0 });
        }
      }
      for (let i = 0; i < 10 && !ed; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        ed = metadataEditorOf(view);
      }
    }
    if (!ed) {
      new Notice("Properties are hidden in this note. Change “Properties in document” in Settings → Editor to edit them here.");
      return;
    }
    ed.addProperty(key);
  }
}

export const properties: CorePluginDefinition = {
  id: "properties",
  name: "Properties view",
  description: "Show the metadata for your files in the sidebar.",
  icon: "lucide-archive",
  defaultOn: true,
  defaultOptions: {},
  create: (app) => new PropertiesPlugin(app, { id: "properties", name: "Properties view", version: "", minAppVersion: "", author: "", description: "" }),
};
