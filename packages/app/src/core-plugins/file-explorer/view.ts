/**
 * The "Files" view (`file-explorer`).
 *
 *   .workspace-leaf-content[data-type="file-explorer"]
 *     .view-header                      (hidden in sidebars by the theme)
 *     .nav-header > .nav-buttons-container > .clickable-icon.nav-action-button × 5
 *     .view-content.nav-files-container
 *       .tree-item.nav-folder.mod-root > … (see items.ts)
 *
 * Items exist for every visible file (plugins read `fileItems[path]` for
 * collapsed folders too), but a collapsed folder's children are not attached
 * to the DOM. Vault events update the map and queue a re-sort of the affected
 * folder; renders are batched into one microtask so a sync that adds a
 * thousand files re-sorts each folder once.
 *
 * Mouse: click opens (Mod = new tab, Mod+Alt = split, middle = new tab) or
 * toggles a folder; Alt+click toggles selection; Shift+click selects a range.
 * Keyboard (while the tree has focus): ↑/↓ move, Shift+↑/↓ extend, Mod+↑/↓
 * move and open, ←/→ collapse/expand, Home/End, Enter opens (renames on
 * macOS), F2 renames, Delete / Mod+Backspace deletes, Escape clears the
 * selection, Mod+C / Mod+V copy and paste files.
 */
import type { ViewStateResult } from "obsidian";
import { Keymap, Scope, isMacPlatform } from "../../obsidian/ui/keymap";
import { setIcon } from "../../obsidian/ui/icons";
import { Menu, MenuItem } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { moment } from "../../obsidian/util";
import { TFile, TFolder, type TAbstractFile } from "../../obsidian/vault/files";
import { ItemView } from "../../obsidian/workspace/view";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import {
  MoveToFolderModal,
  canMoveInto,
  childPath,
  copyText,
  createNewFileOfType,
  createNewFolder,
  createNewNote,
  deleteFiles,
  duplicateFile,
  duplicateLabel,
  moveFiles,
  obsidianUrl,
  validateName,
} from "./actions";
import { ExplorerItem, FileItem, FolderItem } from "./items";
import { customTitle, displayTitleSource } from "./note-titles";
import { SORT_MENU, applyManualOrder, compareFiles, isSortOrder, manualOrderKey, type ManualOrder, type SortOrder } from "./sort";

export const VIEW_TYPE_FILE_EXPLORER = "file-explorer";
export const FILE_EXPLORER_MENU_SOURCE = "file-explorer-context-menu";

/** Extensions the app opens natively even before a view registers them. */
const NATIVE_EXTENSIONS = new Set(["md", "canvas", "base"]);

const DEFAULT_BASE = "views:\n  - type: table\n    name: Table\n";

/**
 * Canvas and Bases may add their own "New canvas" / "New base" items through
 * `file-menu`; when a title appears twice, keep the plugin's (the later one).
 */
function dedupeMenu(menu: Menu) {
  const seen = new Map<string, number>();
  const drop = new Set<number>();
  menu.items.forEach((item, i) => {
    if (!(item instanceof MenuItem)) return;
    const key = `${item.section}\u0000${item.titleEl.getText()}`;
    const prev = seen.get(key);
    if (prev !== undefined) drop.add(prev);
    seen.set(key, i);
  });
  if (drop.size) menu.items = menu.items.filter((_, i) => !drop.has(i));
}

export class FileExplorerView extends ItemView {
  // internal (used by plugins: Iconize, File Color, Folder Notes read `fileItems[path].selfEl`)
  fileItems: Record<string, ExplorerItem> = {};
  sortOrder: SortOrder = "alphabetical";
  autoReveal = false;
  // internal
  navHeaderEl!: HTMLElement;
  navButtonsContainerEl!: HTMLElement;
  newFileButtonEl!: HTMLElement;
  newFolderButtonEl!: HTMLElement;
  sortButtonEl!: HTMLElement;
  autoRevealButtonEl!: HTMLElement;
  collapseAllButtonEl!: HTMLElement;
  rootItem!: FolderItem;
  /** Selection state, shaped like Obsidian's `view.tree` (used by plugins: multi-select helpers). */
  tree = {
    selectedDoms: new Set<ExplorerItem>(),
    focusedItem: null as ExplorerItem | null,
    activeDom: null as ExplorerItem | null,
  };

  private itemBySelfEl = new WeakMap<HTMLElement, ExplorerItem>();
  private pendingRender = new Set<FolderItem>();
  private renderQueued = false;
  private keyScope: Scope;
  private scopePushed = false;
  private renaming: { item: ExplorerItem; finish: (commit: boolean) => Promise<void> } | null = null;
  private dragOver: FolderItem | null = null;
  private dragExpandTimer: number | null = null;
  private hoverItem: ExplorerItem | null = null;
  private clipboard: TAbstractFile[] = [];
  /** Custom order: where a drag would reorder (null: move into a folder). */
  private dropSlot: { item: ExplorerItem; after: boolean } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: { app: any },
  ) {
    super(leaf);
    this.icon = "lucide-folder-closed";
    this.keyScope = new Scope(this.app.scope);
  }

  getViewType(): string {
    return VIEW_TYPE_FILE_EXPLORER;
  }

  getDisplayText(): string {
    return "Files";
  }

  // ---- lifecycle ----------------------------------------------------------------

  override async onOpen(): Promise<void> {
    this.buildHeader();
    this.contentEl.addClasses(["nav-files-container", "node-insert-event"]);
    this.contentEl.setAttr("tabindex", "-1");
    this.contentEl.style.position = "relative";
    this.buildTree();
    this.registerKeys();

    const { vault, workspace, viewRegistry } = this.app;
    this.registerEvent(vault.on("create", (f: TAbstractFile) => this.onCreate(f)));
    this.registerEvent(vault.on("delete", (f: TAbstractFile) => this.onDelete(f)));
    this.registerEvent(vault.on("rename", (f: TAbstractFile, old: string) => this.onRename(f, old)));
    this.registerEvent(vault.on("modify", (f: TAbstractFile) => this.onModify(f)));
    this.registerEvent(
      vault.on("config-changed", (key: string) => {
        if (key === "showUnsupportedFiles" || key === "userIgnoreFilters") this.rebuild();
      }),
    );
    this.registerEvent(viewRegistry.on("extensions-updated", () => this.rebuild()));
    this.registerEvent(
      vault.on("config-changed", (key: string) => {
        if (key === "displayTitle" || key === "displayTitleProperty") this.refreshTitles();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (f: TAbstractFile) => {
        if (displayTitleSource(this.app) === "filename") return;
        const item = this.fileItems[f.path];
        if (!(item instanceof FileItem)) return;
        const before = item.innerEl.getText();
        if (this.renaming?.item !== item) item.updateTitle();
        if (item.parent && item.innerEl.getText() !== before) this.queueRender(item.parent);
      }),
    );
    this.registerEvent(workspace.on("file-open", (file: TFile | null) => this.onFileOpen(file)));
    this.registerEvent(workspace.on("active-leaf-change", () => this.updateActive()));

    const el = this.contentEl;
    this.registerDomEvent(el, "click", (evt) => this.onClick(evt));
    this.registerDomEvent(el, "auxclick", (evt) => this.onAuxClick(evt));
    this.registerDomEvent(el, "mousedown", (evt) => {
      if (evt.button === 1) evt.preventDefault();
      if (!this.renaming) el.focus({ preventScroll: true });
    });
    this.registerDomEvent(el, "contextmenu", (evt) => this.onContextMenu(evt));
    this.registerDomEvent(el, "pointerover", (evt) => this.onPointerOver(evt));
    this.registerDomEvent(el, "mouseover", (evt) => this.onMouseOver(evt));
    this.registerDomEvent(el, "dragstart", (evt) => this.onDragStart(evt));
    this.registerDomEvent(el, "dragover", (evt) => this.onDragOver(evt));
    this.registerDomEvent(el, "dragleave", (evt) => {
      if (!(evt.relatedTarget instanceof Node) || !el.contains(evt.relatedTarget)) this.setDragOver(null);
    });
    this.registerDomEvent(el, "drop", (evt) => void this.onDrop(evt));
    this.registerDomEvent(window, "dragend", () => {
      this.setDragOver(null);
      this.setDropSlot(null);
      el.findAll(".is-being-dragged").forEach((n) => n.removeClass("is-being-dragged"));
    });
    this.registerDomEvent(el, "focusin", () => {
      if (this.scopePushed) return;
      this.app.keymap.pushScope(this.keyScope);
      this.scopePushed = true;
    });
    this.registerDomEvent(el, "focusout", (evt) => {
      if (evt.relatedTarget instanceof Node && el.contains(evt.relatedTarget)) return;
      this.popScope();
    });
    this.updateActive();
  }

  override async onClose(): Promise<void> {
    this.popScope();
    this.setDragOver(null);
  }

  private popScope() {
    if (!this.scopePushed) return;
    this.app.keymap.popScope(this.keyScope);
    this.scopePushed = false;
  }

  override getState(): Record<string, unknown> {
    const expandedFolders: string[] = [];
    for (const item of Object.values(this.fileItems)) {
      if (item instanceof FolderItem && item !== this.rootItem && !item.collapsed) expandedFolders.push(item.file.path);
    }
    return { sortOrder: this.sortOrder, autoReveal: this.autoReveal, expandedFolders };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    if (!state || typeof state !== "object") return;
    if (isSortOrder(state.sortOrder)) this.sortOrder = state.sortOrder;
    if (typeof state.autoReveal === "boolean") this.autoReveal = state.autoReveal;
    if (Array.isArray(state.expandedFolders) && this.rootItem) {
      const expanded = new Set(state.expandedFolders.filter((p: unknown): p is string => typeof p === "string"));
      for (const item of Object.values(this.fileItems)) {
        if (item instanceof FolderItem && item !== this.rootItem) item.applyCollapsed(!expanded.has(item.file.path));
      }
    }
    this.updateHeaderButtons();
    if (this.rootItem) this.renderFolder(this.rootItem, true);
    if (this.autoReveal) {
      const file = this.app.workspace.getActiveFile();
      if (file) this.revealInFolder(file, false);
    }
  }

  // ---- header ---------------------------------------------------------------------

  private buildHeader() {
    this.navHeaderEl = createDiv({ cls: "nav-header" });
    this.containerEl.insertBefore(this.navHeaderEl, this.contentEl);
    this.navButtonsContainerEl = this.navHeaderEl.createDiv({ cls: "nav-buttons-container" });
    const button = (icon: string, label: string, onClick: (evt: MouseEvent) => void) => {
      const el = this.navButtonsContainerEl.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": label } });
      setIcon(el, icon);
      el.addEventListener("click", onClick);
      return el;
    };
    this.newFileButtonEl = button("lucide-edit", "New note", (evt) => {
      const parent = this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
      void createNewNote(this.app, parent, Keymap.isModEvent(evt) || undefined).then((f) => f && this.revealInFolder(f, false));
    });
    this.newFolderButtonEl = button("lucide-folder-plus", "New folder", () => {
      const parent = this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
      void this.newFolderIn(parent);
    });
    this.sortButtonEl = button("lucide-sort-asc", "Change sort order", (evt) => this.showSortMenu(evt));
    this.autoRevealButtonEl = button("lucide-gallery-vertical", "Auto-reveal current file", () => {
      this.autoReveal = !this.autoReveal;
      this.updateHeaderButtons();
      if (this.autoReveal) {
        const file = this.app.workspace.getActiveFile();
        if (file) this.revealInFolder(file, false);
      }
      this.app.workspace.requestSaveLayout();
    });
    this.collapseAllButtonEl = button("lucide-chevrons-down-up", "Collapse all", () => this.toggleCollapseAll());
    this.updateHeaderButtons();
  }

  private showSortMenu(evt: MouseEvent) {
    const menu = new Menu();
    SORT_MENU.forEach((group, i) => {
      if (i > 0) menu.addSeparator();
      for (const { order, title } of group) {
        menu.addItem((item) =>
          item
            .setTitle(title)
            .setChecked(this.sortOrder === order)
            .onClick(() => this.setSortOrder(order)),
        );
      }
    });
    menu.setParentElement(this.sortButtonEl);
    const rect = this.sortButtonEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
    void evt;
  }

  // internal (used by plugins: sort helpers call view.setSortOrder)
  setSortOrder(order: SortOrder) {
    if (!isSortOrder(order) || order === this.sortOrder) return;
    this.sortOrder = order;
    this.requestSort();
    this.app.workspace.requestSaveLayout();
  }

  // internal (used by plugins: after changing what they sort on)
  requestSort() {
    for (const item of Object.values(this.fileItems)) if (item instanceof FolderItem) this.pendingRender.add(item);
    this.queueRender();
  }

  // internal
  sort() {
    this.requestSort();
    this.flushRender();
  }

  private updateHeaderButtons() {
    if (!this.autoRevealButtonEl) return;
    this.autoRevealButtonEl.toggleClass("is-active", this.autoReveal);
    const anyExpanded = this.hasExpandedFolder();
    this.collapseAllButtonEl.setAttr("aria-label", anyExpanded ? "Collapse all" : "Expand all");
    setIcon(this.collapseAllButtonEl, anyExpanded ? "lucide-chevrons-down-up" : "lucide-chevrons-up-down");
  }

  private hasExpandedFolder(): boolean {
    for (const item of Object.values(this.fileItems)) {
      if (item instanceof FolderItem && item !== this.rootItem && !item.collapsed) return true;
    }
    return false;
  }

  private toggleCollapseAll() {
    const collapse = this.hasExpandedFolder();
    for (const item of Object.values(this.fileItems)) {
      if (item instanceof FolderItem && item !== this.rootItem) item.applyCollapsed(collapse);
    }
    this.renderFolder(this.rootItem, true);
    this.updateHeaderButtons();
    this.app.workspace.requestSaveLayout();
  }

  // ---- building and rendering --------------------------------------------------------

  /** Whether the explorer lists a file: folders and native files always; others per "Show all file types". */
  isVisible(file: TAbstractFile): boolean {
    if (file instanceof TFolder) return true;
    if (!(file instanceof TFile)) return false;
    const ext = file.extension.toLowerCase();
    if (NATIVE_EXTENSIONS.has(ext) || this.app.viewRegistry.isExtensionRegistered(ext)) return true;
    return !!this.app.vault.getConfig("showUnsupportedFiles");
  }

  private buildTree() {
    this.fileItems = {};
    this.tree.selectedDoms.clear();
    this.tree.focusedItem = null;
    this.tree.activeDom = null;
    const root = this.app.vault.getRoot() as TFolder;
    this.rootItem = this.createItem(root, null) as FolderItem;
    const walk = (folder: TFolder, parentItem: FolderItem) => {
      for (const child of folder.children) {
        if (!this.isVisible(child)) continue;
        const item = this.createItem(child, parentItem);
        if (child instanceof TFolder) walk(child, item as FolderItem);
      }
    };
    walk(root, this.rootItem);
    this.contentEl.empty();
    this.contentEl.appendChild(this.rootItem.el);
    this.renderFolder(this.rootItem, true);
  }

  /** Rebuild after the set of visible files changed, keeping expanded folders. */
  private rebuild() {
    const state = this.getState();
    this.buildTree();
    void this.setState(state, { history: false });
    this.updateActive();
  }

  /** Name used for sorting: the display title when one is shown. */
  private sortName = (f: TAbstractFile): string => (f instanceof TFile ? (customTitle(this.app, f) ?? f.name) : f.name);

  // internal: re-title every file after the display-title setting changed
  refreshTitles() {
    for (const item of Object.values(this.fileItems)) if (item instanceof FileItem && this.renaming?.item !== item) item.updateTitle();
    this.requestSort();
  }

  // internal (used by the plugin): the persisted custom order
  get manualOrder(): ManualOrder {
    const options = (this.plugin as { instance?: { options: Record<string, unknown> } }).instance?.options;
    if (!options) return {};
    if (!options.manualOrder || typeof options.manualOrder !== "object") options.manualOrder = {};
    return options.manualOrder as ManualOrder;
  }

  private createItem(file: TAbstractFile, parent: FolderItem | null): ExplorerItem {
    const item = file instanceof TFolder ? new FolderItem(file) : new FileItem(file as TFile, (f) => customTitle(this.app, f));
    item.parent = parent;
    if (item instanceof FolderItem) item.owner = this;
    this.fileItems[file.path] = item;
    this.itemBySelfEl.set(item.selfEl, item);
    item.el.toggleClass("vault-is-excluded", !(file instanceof TFolder && file.isRoot()) && !!this.app.metadataCache?.isUserIgnored?.(file.path));
    return item;
  }

  /** Sort a folder's children into its DOM; `deep` also renders expanded subfolders. */
  private renderFolder(item: FolderItem, deep: boolean) {
    const children: ExplorerItem[] = [];
    for (const child of item.file.children) {
      const c = this.fileItems[child.path];
      if (c && c.parent === item) children.push(c);
    }
    const sorted = this.sortOrder === "custom" ? applyManualOrder(this.manualOrder, item.file, children, this.sortName) : children.sort((a, b) => compareFiles(this.sortOrder, a.file, b.file, this.sortName));
    children.splice(0, children.length, ...sorted);
    item.vChildren = children;
    this.pendingRender.delete(item);
    if (item.collapsed && item !== this.rootItem) {
      item.childrenEl.empty();
      return;
    }
    item.childrenEl.setChildrenInPlace(children.map((c) => c.el));
    if (deep) for (const c of children) if (c instanceof FolderItem && !c.collapsed) this.renderFolder(c, true);
  }

  private queueRender(item?: FolderItem) {
    if (item) this.pendingRender.add(item);
    if (this.renderQueued) return;
    this.renderQueued = true;
    void Promise.resolve().then(() => this.flushRender());
  }

  private flushRender() {
    this.renderQueued = false;
    const items = Array.from(this.pendingRender);
    this.pendingRender.clear();
    for (const item of items) {
      if (this.fileItems[item.file.path] !== item) continue;
      // A folder whose parent is collapsed is rendered when the parent opens.
      this.renderFolder(item, false);
    }
    this.updateHeaderButtons();
  }

  // internal: FolderItem.setCollapsed lands here
  setCollapsed(item: FolderItem, collapsed: boolean) {
    if (item === this.rootItem || item.collapsed === collapsed) return;
    item.applyCollapsed(collapsed);
    this.renderFolder(item, true);
    this.updateHeaderButtons();
    this.app.workspace.requestSaveLayout();
  }

  /** Items in on-screen order (folders' children only when expanded). */
  private visibleItems(): ExplorerItem[] {
    this.flushRender();
    const out: ExplorerItem[] = [];
    const walk = (folder: FolderItem) => {
      for (const c of folder.vChildren) {
        out.push(c);
        if (c instanceof FolderItem && !c.collapsed) walk(c);
      }
    };
    walk(this.rootItem);
    return out;
  }

  // ---- vault events ----------------------------------------------------------------------

  private onCreate(file: TAbstractFile) {
    if (this.fileItems[file.path] || !this.isVisible(file) || !file.parent) return;
    const parent = this.fileItems[file.parent.path];
    if (!(parent instanceof FolderItem)) return;
    const item = this.createItem(file, parent);
    // A folder that arrives with contents (a copy, an external sync) brings its children.
    if (file instanceof TFolder) {
      const walk = (folder: TFolder, folderItem: FolderItem) => {
        for (const child of folder.children) {
          if (this.fileItems[child.path] || !this.isVisible(child)) continue;
          const c = this.createItem(child, folderItem);
          if (child instanceof TFolder) walk(child, c as FolderItem);
        }
      };
      walk(file, item as FolderItem);
    }
    this.queueRender(parent);
  }

  private onDelete(file: TAbstractFile) {
    const item = this.fileItems[file.path];
    if (!item) return;
    this.removeItem(item);
  }

  private removeItem(item: ExplorerItem) {
    const drop = (it: ExplorerItem) => {
      if (this.fileItems[it.file.path] === it) delete this.fileItems[it.file.path];
      this.tree.selectedDoms.delete(it);
      if (this.tree.focusedItem === it) this.tree.focusedItem = null;
      if (this.tree.activeDom === it) this.tree.activeDom = null;
      if (it instanceof FolderItem) {
        for (const child of it.file.children) {
          const c = this.fileItems[child.path];
          if (c && c.parent === it) drop(c);
        }
      }
    };
    drop(item);
    item.el.detach();
    if (item.parent) {
      item.parent.vChildren.remove(item);
      this.queueRender(item.parent);
    }
  }

  private onRename(file: TAbstractFile, oldPath: string) {
    const item = this.fileItems[oldPath];
    if (!item) {
      this.onCreate(file); // e.g. an attachment renamed to a supported extension
      return;
    }
    if (this.fileItems[oldPath] === item) delete this.fileItems[oldPath];
    if (!this.isVisible(file)) {
      this.fileItems[file.path] = item;
      this.removeItem(item);
      return;
    }
    this.fileItems[file.path] = item;
    item.updatePath();
    const newParent = file.parent ? this.fileItems[file.parent.path] : null;
    if (!(newParent instanceof FolderItem)) {
      this.removeItem(item);
      return;
    }
    if (item.parent !== newParent) {
      const oldParent = item.parent;
      item.el.detach();
      if (oldParent) {
        oldParent.vChildren.remove(item);
        this.queueRender(oldParent);
      }
      item.parent = newParent;
    }
    this.queueRender(newParent);
    if (this.tree.activeDom === item) item.selfEl.addClass("is-active");
  }

  private onModify(file: TAbstractFile) {
    if (!this.sortOrder.startsWith("byModifiedTime") || !file.parent) return;
    const parent = this.fileItems[file.parent.path];
    if (parent instanceof FolderItem) this.queueRender(parent);
  }

  private onFileOpen(file: TFile | null) {
    this.updateActive();
    if (file && this.autoReveal) this.revealInFolder(file, false);
  }

  private updateActive() {
    const file = this.app.workspace.getActiveFile() as TFile | null;
    const item = file ? (this.fileItems[file.path] ?? null) : null;
    if (this.tree.activeDom === item) return;
    this.tree.activeDom?.selfEl.removeClass("is-active");
    this.tree.activeDom = item;
    item?.selfEl.addClass("is-active");
  }

  // ---- reveal, focus, selection ---------------------------------------------------------------

  /** Expand the folders above `file`, scroll it into view and give it keyboard focus. */
  revealInFolder(file: TAbstractFile, focus = true) {
    const item = this.fileItems[file.path];
    if (!item) return;
    const chain: FolderItem[] = [];
    for (let p = item.parent; p && p !== this.rootItem; p = p.parent) chain.unshift(p);
    for (const folder of chain) if (folder.collapsed) folder.applyCollapsed(false);
    if (chain.length) this.renderFolder(chain[0]!.parent ?? this.rootItem, true);
    this.flushRender();
    this.updateHeaderButtons();
    this.setFocusedItem(item, true);
    if (focus) this.contentEl.focus({ preventScroll: true });
    if (chain.length) this.app.workspace.requestSaveLayout();
  }

  /**
   * Move the keyboard cursor. The focus ring shows only for keyboard moves
   * (`visible`); a click moves the cursor silently, as Obsidian does.
   */
  private setFocusedItem(item: ExplorerItem | null, scroll: boolean, visible = true) {
    this.tree.focusedItem?.selfEl.removeClass("has-focus");
    this.tree.focusedItem = item;
    if (!item) return;
    item.selfEl.toggleClass("has-focus", visible);
    if (scroll && item.selfEl.isConnected) item.selfEl.scrollIntoView({ block: "nearest" });
  }

  private selectItem(item: ExplorerItem) {
    if (item === this.rootItem) return;
    this.tree.selectedDoms.add(item);
    item.selfEl.addClass("is-selected");
  }

  private deselectItem(item: ExplorerItem) {
    this.tree.selectedDoms.delete(item);
    item.selfEl.removeClass("is-selected");
  }

  // internal (used by plugins: clear the explorer selection)
  clearSelectedDoms() {
    for (const item of this.tree.selectedDoms) item.selfEl.removeClass("is-selected");
    this.tree.selectedDoms.clear();
  }

  private selectRange(from: ExplorerItem, to: ExplorerItem) {
    const items = this.visibleItems();
    let a = items.indexOf(from);
    let b = items.indexOf(to);
    if (a === -1) a = b;
    if (a > b) [a, b] = [b, a];
    for (let i = a; i <= b; i++) this.selectItem(items[i]!);
  }

  /** The files an action applies to: the selection when `item` is part of it, else `item`. */
  private targetFiles(item: ExplorerItem): TAbstractFile[] {
    if (this.tree.selectedDoms.size > 1 && this.tree.selectedDoms.has(item)) {
      return this.visibleItems()
        .filter((i) => this.tree.selectedDoms.has(i))
        .map((i) => i.file);
    }
    return [item.file];
  }

  private itemFromEvent(evt: Event): ExplorerItem | null {
    const target = evt.target instanceof Element ? evt.target.closest<HTMLElement>(".tree-item-self") : null;
    return target ? (this.itemBySelfEl.get(target) ?? null) : null;
  }

  // ---- mouse ----------------------------------------------------------------------------------

  private onClick(evt: MouseEvent) {
    const item = this.itemFromEvent(evt);
    if (!item || item === this.rootItem) {
      if (!evt.altKey && !evt.shiftKey) this.clearSelectedDoms();
      return;
    }
    if (this.renaming?.item === item) return;
    const mod = Keymap.isModifier(evt, "Mod");
    if (evt.altKey && !mod) {
      // Alt+click toggles the item in the selection.
      if (this.tree.selectedDoms.has(item)) this.deselectItem(item);
      else this.selectItem(item);
      this.setFocusedItem(item, false, false);
      evt.preventDefault();
      return;
    }
    if (evt.shiftKey && !mod) {
      const anchor = this.tree.focusedItem ?? this.tree.activeDom ?? item;
      this.clearSelectedDoms();
      this.selectRange(anchor, item);
      evt.preventDefault();
      return;
    }
    this.clearSelectedDoms();
    this.setFocusedItem(item, false, false);
    if (item instanceof FolderItem) {
      this.setCollapsed(item, !item.collapsed);
      return;
    }
    void this.openFile(item.file as TFile, Keymap.isModEvent(evt), true);
  }

  private onAuxClick(evt: MouseEvent) {
    if (evt.button !== 1) return;
    const item = this.itemFromEvent(evt);
    if (item instanceof FileItem) void this.openFile(item.file, "tab", true);
  }

  private async openFile(file: TFile, newLeaf: ReturnType<typeof Keymap.isModEvent>, focus: boolean) {
    const leaf = this.app.workspace.getLeaf(newLeaf);
    if (focus) {
      await leaf.openFile(file, { active: true });
    } else {
      await leaf.openFile(file);
      this.app.workspace.setActiveLeaf(leaf, { focus: false });
      this.contentEl.focus({ preventScroll: true });
    }
  }

  private onPointerOver(evt: PointerEvent) {
    // Label rows lazily, before the tooltip's own mouseover reads aria-label.
    const item = this.itemFromEvent(evt);
    if (!(item instanceof FileItem) || item.selfEl.hasAttribute("aria-label")) return;
    const { mtime, ctime } = item.file.stat;
    const fmt = (t: number) => moment(t).format("YYYY-MM-DD HH:mm");
    item.selfEl.setAttr("aria-label", `Last modified at ${fmt(mtime)}\nCreated at ${fmt(ctime)}`);
    item.selfEl.setAttr("data-tooltip-position", "right");
    item.selfEl.setAttr("data-tooltip-delay", "1000");
  }

  private onMouseOver(evt: MouseEvent) {
    const item = this.itemFromEvent(evt);
    if (item === this.hoverItem) return;
    this.hoverItem = item;
    if (!(item instanceof FileItem)) return;
    // Page preview on Mod+hover.
    this.app.workspace.trigger("hover-link", {
      event: evt,
      source: VIEW_TYPE_FILE_EXPLORER,
      hoverParent: this,
      targetEl: item.selfEl,
      linktext: item.file.path,
    });
  }

  // ---- rename -------------------------------------------------------------------------------------

  // internal (used by commands and plugins)
  startRename(item: ExplorerItem) {
    if (item === this.rootItem) return;
    void this.renaming?.finish(true);
    this.revealInFolder(item.file, false);
    const { file, innerEl, selfEl } = item;
    // A note shown by its title is renamed by its file name.
    if (file instanceof TFile && file.extension === "md") innerEl.setText(file.basename);
    const original = innerEl.getText();
    selfEl.addClass("is-being-renamed");
    selfEl.setAttr("draggable", "false");
    innerEl.setAttr("contenteditable", "plaintext-only");
    if (innerEl.contentEditable !== "plaintext-only") innerEl.setAttr("contenteditable", "true");
    innerEl.setAttr("spellcheck", "false");
    innerEl.focus();
    const range = document.createRange();
    range.selectNodeContents(innerEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void finish(false);
      }
      e.stopPropagation();
    };
    const onBlur = () => void finish(true);
    const finish = async (commit: boolean) => {
      if (this.renaming?.item !== item) return;
      this.renaming = null;
      innerEl.removeEventListener("keydown", onKey);
      innerEl.removeEventListener("blur", onBlur);
      const name = (innerEl.textContent ?? "").replace(/\n/g, "").trim();
      innerEl.removeAttribute("contenteditable");
      selfEl.removeClass("is-being-renamed");
      selfEl.setAttr("draggable", "true");
      item.updateTitle();
      if (innerEl.isActiveElement() || document.activeElement === document.body) this.contentEl.focus({ preventScroll: true });
      if (!commit || name === original) return;
      const error = validateName(name, file instanceof TFolder);
      if (error) {
        new Notice(error);
        return;
      }
      const newName = file instanceof TFile && file.extension ? `${name}.${file.extension}` : name;
      const newPath = file.getNewPathAfterRename(newName);
      const clash = this.app.vault.getAbstractFileByPathInsensitive(newPath);
      if (clash && clash !== file) {
        new Notice("There's already a file with the same name");
        return;
      }
      try {
        await this.app.fileManager.renameFile(file, newPath);
      } catch (e) {
        new Notice(String((e as Error).message ?? e));
      }
    };
    innerEl.addEventListener("keydown", onKey);
    innerEl.addEventListener("blur", onBlur);
    this.renaming = { item, finish };
  }

  private async newFolderIn(parent: TFolder) {
    const folder = await createNewFolder(this.app, parent);
    if (!folder) return;
    this.flushRender();
    const item = this.fileItems[folder.path];
    if (item) this.startRename(item);
  }

  // ---- keyboard -------------------------------------------------------------------------------------

  private registerKeys() {
    const s = this.keyScope;
    const guard = (fn: (evt: KeyboardEvent) => void) => (evt: KeyboardEvent) => {
      if (this.renaming || !(evt.target instanceof Node) || !this.contentEl.contains(evt.target)) return;
      fn(evt);
      return false;
    };
    const move = (delta: number, extend: boolean, open: boolean) =>
      guard(() => {
        const items = this.visibleItems();
        if (items.length === 0) return;
        const current = this.tree.focusedItem ?? this.tree.activeDom;
        let i = current ? items.indexOf(current) : -1;
        i = i === -1 ? (delta > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + delta));
        const next = items[i]!;
        if (extend) {
          if (current && !this.tree.selectedDoms.has(current)) this.selectItem(current);
          this.selectItem(next);
        } else if (!open) this.clearSelectedDoms();
        this.setFocusedItem(next, true);
        if (open && next instanceof FileItem) void this.openFile(next.file, false, false);
      });
    s.register([], "ArrowDown", move(1, false, false));
    s.register([], "ArrowUp", move(-1, false, false));
    s.register(["Shift"], "ArrowDown", move(1, true, false));
    s.register(["Shift"], "ArrowUp", move(-1, true, false));
    s.register(["Mod"], "ArrowDown", move(1, false, true));
    s.register(["Mod"], "ArrowUp", move(-1, false, true));
    s.register([], "Home", guard(() => {
      const items = this.visibleItems();
      if (items[0]) this.setFocusedItem(items[0], true);
    }));
    s.register([], "End", guard(() => {
      const items = this.visibleItems();
      const last = items[items.length - 1];
      if (last) this.setFocusedItem(last, true);
    }));
    s.register([], "ArrowRight", guard(() => {
      const item = this.tree.focusedItem;
      if (!(item instanceof FolderItem)) return;
      if (item.collapsed) this.setCollapsed(item, false);
      else if (item.vChildren[0]) this.setFocusedItem(item.vChildren[0], true);
    }));
    s.register([], "ArrowLeft", guard(() => {
      const item = this.tree.focusedItem;
      if (!item) return;
      if (item instanceof FolderItem && !item.collapsed) this.setCollapsed(item, true);
      else if (item.parent && item.parent !== this.rootItem) this.setFocusedItem(item.parent, true);
    }));
    s.register([], "Enter", guard(() => {
      const item = this.tree.focusedItem;
      if (!item) return;
      if (isMacPlatform()) this.startRename(item);
      else if (item instanceof FolderItem) this.setCollapsed(item, !item.collapsed);
      else void this.openFile(item.file as TFile, false, true);
    }));
    s.register(["Mod"], "Enter", guard(() => {
      const item = this.tree.focusedItem;
      if (item instanceof FileItem) void this.openFile(item.file, "tab", true);
    }));
    s.register([], "F2", guard(() => {
      if (this.tree.focusedItem) this.startRename(this.tree.focusedItem);
    }));
    const del = guard(() => {
      const item = this.tree.focusedItem;
      const files = this.tree.selectedDoms.size ? this.visibleItems().filter((i) => this.tree.selectedDoms.has(i)).map((i) => i.file) : item ? [item.file] : [];
      void deleteFiles(this.app, files);
    });
    s.register([], "Delete", del);
    s.register(["Mod"], "Backspace", del);
    s.register([], "Escape", guard(() => this.clearSelectedDoms()));
    s.register(["Mod"], "c", guard(() => {
      const item = this.tree.focusedItem;
      const files = this.tree.selectedDoms.size ? Array.from(this.tree.selectedDoms).map((i) => i.file) : item ? [item.file] : [];
      this.clipboard = files.filter((f) => f instanceof TFile);
      if (this.clipboard.length) {
        const source = this.app.workspace.getActiveFile()?.path ?? "";
        const text = (this.clipboard as TFile[]).map((f) => this.app.fileManager.generateMarkdownLink(f, source)).join("\n");
        void navigator.clipboard?.writeText(text).catch(() => {});
      }
    }));
    s.register(["Mod"], "v", guard(() => void this.pasteFiles()));
  }

  private async pasteFiles() {
    const item = this.tree.focusedItem;
    const folder = item instanceof FolderItem ? item.file : ((item?.file.parent as TFolder | null) ?? this.app.vault.getRoot());
    for (const file of this.clipboard) {
      if (!(file instanceof TFile) || file.deleted) continue;
      const target = this.app.vault.getAvailablePath(childPath(folder, file.basename), file.extension);
      try {
        await this.app.vault.copy(file, target);
      } catch (e) {
        new Notice(String((e as Error).message ?? e));
      }
    }
  }

  // ---- context menus ----------------------------------------------------------------------------------

  private onContextMenu(evt: MouseEvent) {
    evt.preventDefault();
    const item = this.itemFromEvent(evt);
    const menu = new Menu();
    if (!item || item === this.rootItem) {
      this.clearSelectedDoms();
      this.addCreateItems(menu, this.app.vault.getRoot());
      this.app.workspace.trigger("file-menu", menu, this.app.vault.getRoot(), FILE_EXPLORER_MENU_SOURCE, this.leaf);
      dedupeMenu(menu);
    } else {
      if (!this.tree.selectedDoms.has(item)) this.clearSelectedDoms();
      const files = this.targetFiles(item);
      if (files.length > 1) this.buildMultiMenu(menu, files);
      else this.buildItemMenu(menu, item);
      menu.setParentElement(item.selfEl);
    }
    menu.showAtMouseEvent(evt);
  }

  private addCreateItems(menu: Menu, folder: TFolder) {
    menu.addItem((i) =>
      i.setSection("action-primary").setTitle("New note").setIcon("lucide-edit").onClick(async () => {
        const file = await createNewNote(this.app, folder);
        if (file) this.revealInFolder(file, false);
      }),
    );
    menu.addItem((i) => i.setSection("action-primary").setTitle("New folder").setIcon("lucide-folder-plus").onClick(() => void this.newFolderIn(folder)));
    const plugins = this.app.internalPlugins;
    if (plugins.getEnabledPluginById("canvas")) {
      menu.addItem((i) =>
        i.setSection("action-primary").setTitle("New canvas").setIcon("lucide-layout-dashboard").onClick(async () => {
          const file = await createNewFileOfType(this.app, folder, "canvas", "{}");
          if (file) this.revealInFolder(file, false);
        }),
      );
    }
    if (plugins.getEnabledPluginById("bases")) {
      menu.addItem((i) =>
        i.setSection("action-primary").setTitle("New base").setIcon("lucide-table").onClick(async () => {
          const file = await createNewFileOfType(this.app, folder, "base", DEFAULT_BASE);
          if (file) this.revealInFolder(file, false);
        }),
      );
    }
  }

  private buildItemMenu(menu: Menu, item: ExplorerItem) {
    const file = item.file;
    const { workspace } = this.app;
    if (file instanceof TFile) {
      menu.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => void this.openFile(file, "tab", true)));
      menu.addItem((i) => i.setSection("open").setTitle("Open to the right").setIcon("lucide-separator-vertical").onClick(() => void this.openFile(file, "split", true)));
      menu.addItem((i) => i.setSection("open").setTitle("Open in new window").setIcon("lucide-picture-in-picture-2").onClick(() => void this.openFile(file, "window", true)));
      menu.addItem((i) => i.setSection("action").setTitle(duplicateLabel()).setIcon("lucide-files").onClick(() => void duplicateFile(this.app, file)));
    } else if (file instanceof TFolder) {
      this.addCreateItems(menu, file);
      // "Search in folder" comes from the Search plugin's own file-menu handler.
      menu.addItem((i) =>
        i.setSection("action").setTitle("Set as attachment folder").setIcon("lucide-paperclip").onClick(() => {
          this.app.vault.setConfig("attachmentFolderPath", file.path);
          new Notice(`Attachments will be saved to “${file.path}”`);
        }),
      );
    }
    menu.addItem((i) =>
      i.setSection("action").setTitle(file instanceof TFolder ? "Move folder to..." : "Move file to...").setIcon("lucide-folder-tree").onClick(() => new MoveToFolderModal(this.app, [file]).open()),
    );
    menu.addItem((i) => i.setSection("action").setTitle("Rename...").setIcon("lucide-edit-3").onClick(() => this.startRename(item)));
    menu.addItem((i) => {
      i.setSection("info").setTitle("Copy path").setIcon("lucide-copy");
      const sub = i.setSubmenu();
      sub.addItem((s) => s.setTitle("From vault folder").setIcon("lucide-folder").onClick(() => void copyText(file.path)));
      sub.addItem((s) => s.setTitle("As Obsidian URL").setIcon("lucide-link").onClick(() => void copyText(obsidianUrl(this.app, file), "URL")));
    });
    menu.addItem((i) =>
      i.setSection("danger").setTitle("Delete").setIcon("lucide-trash-2").setWarning(true).onClick(() => void deleteFiles(this.app, [file])),
    );
    workspace.trigger("file-menu", menu, file, FILE_EXPLORER_MENU_SOURCE, this.leaf);
    dedupeMenu(menu);
  }

  private buildMultiMenu(menu: Menu, files: TAbstractFile[]) {
    const n = files.length;
    menu.addItem((i) => i.setSection("action").setTitle(`Move ${n} items to...`).setIcon("lucide-folder-tree").onClick(() => new MoveToFolderModal(this.app, files).open()));
    menu.addItem((i) =>
      i.setSection("action").setTitle(`New folder with selection (${n} items)`).setIcon("lucide-folder-plus").onClick(async () => {
        const parents = new Set(files.map((f) => f.parent));
        const parent = parents.size === 1 ? ((files[0]!.parent as TFolder | null) ?? this.app.vault.getRoot()) : this.app.vault.getRoot();
        const folder = await createNewFolder(this.app, parent);
        if (!folder) return;
        await moveFiles(this.app, files, folder);
        this.clearSelectedDoms();
        this.flushRender();
        const item = this.fileItems[folder.path];
        if (item) this.startRename(item);
      }),
    );
    menu.addItem((i) => i.setSection("danger").setTitle("Delete").setIcon("lucide-trash-2").setWarning(true).onClick(() => void deleteFiles(this.app, files)));
    this.app.workspace.trigger("files-menu", menu, files, FILE_EXPLORER_MENU_SOURCE, this.leaf);
    dedupeMenu(menu);
  }

  // ---- drag and drop -----------------------------------------------------------------------------------------

  private onDragStart(evt: DragEvent) {
    const item = this.itemFromEvent(evt);
    if (!item || item === this.rootItem || this.renaming) {
      if (this.renaming) evt.preventDefault();
      return;
    }
    const dm = this.app.dragManager;
    const files = this.targetFiles(item);
    let data;
    if (files.length > 1) data = dm.dragFiles(evt, files, VIEW_TYPE_FILE_EXPLORER);
    else if (item.file instanceof TFolder) data = dm.dragFolder(evt, item.file, VIEW_TYPE_FILE_EXPLORER);
    else data = dm.dragFile(evt, item.file, VIEW_TYPE_FILE_EXPLORER);
    for (const f of files) this.fileItems[f.path]?.selfEl.addClass("is-being-dragged");
    dm.onDragStart(evt, data);
  }

  /** The folder a drop lands in: the folder under the pointer, a file's folder, or the vault root. */
  private dropFolderFor(evt: DragEvent): FolderItem {
    const item = this.itemFromEvent(evt);
    if (item instanceof FolderItem) return item;
    if (item?.parent) return item.parent;
    return this.rootItem;
  }

  private draggedFiles(): TAbstractFile[] | null {
    const data = this.app.dragManager.draggable;
    if (!data) return null;
    if ((data.type === "file" || data.type === "folder") && data.file) return [data.file];
    if (data.type === "files" && data.files) return data.files;
    if (data.type === "link" && data.linktext) {
      // Links dragged from elsewhere (a Base row, a search result) move the file they point to.
      const file = this.app.metadataCache.getFirstLinkpathDest(data.linktext, data.sourcePath ?? "");
      return file ? [file] : null;
    }
    return null;
  }

  private onDragOver(evt: DragEvent) {
    const dt = evt.dataTransfer;
    if (!dt) return;
    const files = this.draggedFiles();
    const slot = files ? this.reorderSlotFor(evt, files) : null;
    this.setDropSlot(slot);
    if (slot && files) {
      dt.dropEffect = "move";
      this.app.dragManager.setAction(`Move ${slot.after ? "after" : "before"} ${slot.item.innerEl.getText()}`);
      evt.preventDefault();
      this.setDragOver(null);
      return;
    }
    const folder = this.dropFolderFor(evt);
    const name = folder === this.rootItem ? this.app.vault.getName() : folder.file.name;
    if (files) {
      if (!files.some((f) => canMoveInto(f, folder.file))) {
        dt.dropEffect = "none";
        this.setDragOver(null);
        return;
      }
      dt.dropEffect = "move";
      this.app.dragManager.setAction(`Move into ${name}`);
    } else if (!this.app.dragManager.draggable && Array.from(dt.types).includes("Files")) {
      dt.dropEffect = "copy";
      this.app.dragManager.setAction(`Copy into ${name}`);
    } else {
      return;
    }
    evt.preventDefault();
    this.setDragOver(folder);
  }

  /**
   * Custom order: the pointer in the top or bottom part of a row reorders
   * (files: halves; folders: quarters, the middle still moves into the folder).
   */
  private reorderSlotFor(evt: DragEvent, files: TAbstractFile[]): { item: ExplorerItem; after: boolean } | null {
    if (this.sortOrder !== "custom") return null;
    const item = this.itemFromEvent(evt);
    if (!item || item === this.rootItem || !item.parent || files.includes(item.file)) return null;
    const target = item.parent.file;
    if (!files.every((f) => f.parent === target || canMoveInto(f, target))) return null;
    const rect = item.selfEl.getBoundingClientRect();
    const ratio = rect.height ? (evt.clientY - rect.top) / rect.height : 0.5;
    if (item instanceof FolderItem) {
      if (ratio < 0.25) return { item, after: false };
      if (ratio > 0.75 && item.collapsed) return { item, after: true };
      return null;
    }
    return { item, after: ratio >= 0.5 };
  }

  private setDropSlot(slot: { item: ExplorerItem; after: boolean } | null) {
    const prev = this.dropSlot;
    if (prev && slot && prev.item === slot.item && prev.after === slot.after) return;
    prev?.item.selfEl.removeClasses(["vault-drop-before", "vault-drop-after"]);
    this.dropSlot = slot;
    slot?.item.selfEl.addClass(slot.after ? "vault-drop-after" : "vault-drop-before");
  }

  /** Custom order: put `files` before or after `target` in its folder, moving them there first if needed. */
  // internal (used by tests and plugins)
  async reorder(files: TAbstractFile[], target: ExplorerItem, after: boolean) {
    const parentItem = target.parent;
    if (!parentItem) return;
    const folder = parentItem.file;
    const outside = files.filter((f) => f.parent !== folder);
    if (outside.length) await moveFiles(this.app, outside, folder);
    const moving = files.filter((f) => f.parent === folder).map((f) => f.name);
    this.flushRender();
    const names = parentItem.vChildren.map((c) => c.file.name).filter((n) => !moving.includes(n));
    let at = names.indexOf(target.file.name);
    if (at === -1) at = names.length;
    else if (after) at++;
    names.splice(at, 0, ...moving);
    this.manualOrder[manualOrderKey(folder)] = names;
    await (this.plugin as { instance?: { saveOptions(): Promise<void> } }).instance?.saveOptions();
    this.queueRender(parentItem);
    this.flushRender();
  }

  private setDragOver(folder: FolderItem | null) {
    if (this.dragOver === folder) return;
    this.dragOver?.el.removeClass("is-being-dragged-over");
    this.contentEl.removeClass("is-being-dragged-over");
    if (this.dragExpandTimer !== null) window.clearTimeout(this.dragExpandTimer);
    this.dragExpandTimer = null;
    this.dragOver = folder;
    if (!folder) return;
    if (folder === this.rootItem) this.contentEl.addClass("is-being-dragged-over");
    else folder.el.addClass("is-being-dragged-over");
    // Hovering a collapsed folder while dragging opens it.
    if (folder.collapsed && folder !== this.rootItem) {
      this.dragExpandTimer = window.setTimeout(() => {
        if (this.dragOver === folder) this.setCollapsed(folder, false);
      }, 800);
    }
  }

  private async onDrop(evt: DragEvent) {
    const dt = evt.dataTransfer;
    const folder = this.dropFolderFor(evt);
    this.setDragOver(null);
    const files = this.draggedFiles();
    const slot = this.dropSlot;
    this.setDropSlot(null);
    if (files && slot) {
      evt.preventDefault();
      this.clearSelectedDoms();
      await this.reorder(files, slot.item, slot.after);
      return;
    }
    if (files) {
      evt.preventDefault();
      this.clearSelectedDoms();
      await moveFiles(this.app, files, folder.file);
      return;
    }
    if (!dt || this.app.dragManager.draggable || !Array.from(dt.types).includes("Files")) return;
    evt.preventDefault();
    // Entries must be taken synchronously: the DataTransfer is emptied after the event.
    const entries = Array.from(dt.items)
      .map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null))
      .filter((e): e is FileSystemEntry => !!e);
    const plainFiles = entries.length ? [] : Array.from(dt.files);
    for (const entry of entries) await this.importEntry(entry, folder.file);
    for (const file of plainFiles) await this.importFile(file, folder.file);
  }

  private async importFile(file: File, folder: TFolder) {
    const dot = file.name.lastIndexOf(".");
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    const ext = dot > 0 ? file.name.slice(dot + 1) : "";
    const path = this.app.vault.getAvailablePath(childPath(folder, base), ext);
    try {
      await this.app.vault.createBinary(path, await file.arrayBuffer());
    } catch (e) {
      new Notice(String((e as Error).message ?? e));
    }
  }

  /** Import a dropped OS file or folder, keeping the folder structure. */
  private async importEntry(entry: FileSystemEntry, folder: TFolder) {
    if (entry.name.startsWith(".")) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)).catch(() => null);
      if (file) await this.importFile(file, folder);
      return;
    }
    if (!entry.isDirectory) return;
    let target: TFolder;
    try {
      target = await this.app.vault.createFolder(this.app.vault.getAvailablePath(childPath(folder, entry.name), ""));
    } catch (e) {
      new Notice(String((e as Error).message ?? e));
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (batch.length === 0) break;
      for (const child of batch) await this.importEntry(child, target);
    }
  }
}
