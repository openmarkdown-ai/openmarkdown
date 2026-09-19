/**
 * The Bookmarks view (`bookmarks`).
 *
 *   .workspace-leaf-content[data-type="bookmarks"]
 *     .nav-header > .nav-buttons-container > .clickable-icon.nav-action-button × 3
 *     .search-input-container > input + .search-input-clear-button
 *     .view-content
 *       .tree-item[.is-collapsed]
 *         .tree-item-self.bookmark.is-clickable[.mod-collapsible][.is-unresolved][.is-active][draggable]
 *           .tree-item-icon[.collapse-icon] > svg
 *           .tree-item-inner > .tree-item-inner-text
 *         .tree-item-children                       (groups)
 *
 * Dragging a bookmark reorders it (top/bottom half of a row: before/after;
 * middle of a group: into it). Files dragged in from the explorer are
 * bookmarked where they are dropped. A file bookmark dragged out behaves like
 * a file, so dropping it into a note inserts a link.
 */
import type { ViewStateResult } from "obsidian";
import { Keymap, Scope } from "../../obsidian/ui/keymap";
import { setIcon } from "../../obsidian/ui/icons";
import { Menu } from "../../obsidian/ui/menu";
import { TFolder, type TAbstractFile } from "../../obsidian/vault/files";
import { ItemView } from "../../obsidian/workspace/view";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import type { BookmarksPlugin } from "./index";
import { findParent, iconFor, isDescendant, type BookmarkItem } from "./model";

export const VIEW_TYPE_BOOKMARKS = "bookmarks";

interface Row {
  item: BookmarkItem;
  el: HTMLElement;
  selfEl: HTMLElement;
  innerEl: HTMLElement;
  parent: BookmarkItem | null;
}

type DropPosition = "before" | "after" | "into";

export class BookmarksView extends ItemView {
  // internal
  navHeaderEl!: HTMLElement;
  filterInputEl!: HTMLInputElement;
  collapseAllButtonEl!: HTMLElement;
  /** Group ctimes the user collapsed. */
  collapsedGroups = new Set<number>();

  private rows: Row[] = [];
  private rowBySelf = new WeakMap<HTMLElement, Row>();
  private focused: BookmarkItem | null = null;
  private focusVisible = false;
  private keyScope: Scope;
  private scopePushed = false;
  private renderQueued = false;
  private renaming: BookmarkItem | null = null;
  private dropTarget: { selfEl: HTMLElement | null; cls: string } | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: BookmarksPlugin,
  ) {
    super(leaf);
    this.icon = "lucide-bookmark";
    this.keyScope = new Scope(this.app.scope);
  }

  getViewType(): string {
    return VIEW_TYPE_BOOKMARKS;
  }

  getDisplayText(): string {
    return "Bookmarks";
  }

  override getState(): Record<string, unknown> {
    return { collapsedGroups: Array.from(this.collapsedGroups) };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    if (Array.isArray(state?.collapsedGroups)) {
      this.collapsedGroups = new Set(state.collapsedGroups.filter((n: unknown) => typeof n === "number"));
      this.render();
    }
  }

  override async onOpen(): Promise<void> {
    this.buildHeader();
    this.contentEl.setAttr("tabindex", "-1");
    this.render();
    this.registerKeys();

    this.registerEvent(this.plugin.events.on("changed", () => this.queueRender()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.updateActive()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateActive()));

    const el = this.contentEl;
    this.registerDomEvent(el, "click", (evt) => this.onClick(evt));
    this.registerDomEvent(el, "auxclick", (evt) => {
      const row = this.rowFromEvent(evt);
      if (evt.button === 1 && row && row.item.type !== "group") void this.plugin.openBookmark(row.item, "tab");
    });
    this.registerDomEvent(el, "mousedown", () => {
      if (!this.renaming) el.focus({ preventScroll: true });
    });
    this.registerDomEvent(el, "contextmenu", (evt) => this.onContextMenu(evt));
    this.registerDomEvent(el, "mouseover", (evt) => {
      const row = this.rowFromEvent(evt);
      if (row?.item.type !== "file") return;
      this.app.workspace.trigger("hover-link", {
        event: evt,
        source: VIEW_TYPE_BOOKMARKS,
        hoverParent: this,
        targetEl: row.selfEl,
        linktext: (row.item.path ?? "") + (row.item.subpath ?? ""),
      });
    });
    this.registerDomEvent(el, "dragstart", (evt) => this.onDragStart(evt));
    this.registerDomEvent(el, "dragover", (evt) => this.onDragOver(evt));
    this.registerDomEvent(el, "dragleave", (evt) => {
      if (!(evt.relatedTarget instanceof Node) || !el.contains(evt.relatedTarget)) this.setDropTarget(null, "");
    });
    this.registerDomEvent(el, "drop", (evt) => this.onDrop(evt));
    this.registerDomEvent(window, "dragend", () => this.setDropTarget(null, ""));
    this.registerDomEvent(el, "focusin", () => {
      if (this.scopePushed) return;
      this.app.keymap.pushScope(this.keyScope);
      this.scopePushed = true;
    });
    this.registerDomEvent(el, "focusout", (evt) => {
      if (evt.relatedTarget instanceof Node && el.contains(evt.relatedTarget)) return;
      this.popScope();
    });
  }

  override async onClose(): Promise<void> {
    this.popScope();
  }

  private popScope() {
    if (!this.scopePushed) return;
    this.app.keymap.popScope(this.keyScope);
    this.scopePushed = false;
  }

  // ---- header ----------------------------------------------------------------------------

  private buildHeader() {
    this.navHeaderEl = createDiv({ cls: "nav-header" });
    this.containerEl.insertBefore(this.navHeaderEl, this.contentEl);
    const buttons = this.navHeaderEl.createDiv({ cls: "nav-buttons-container" });
    const button = (icon: string, label: string, onClick: (evt: MouseEvent) => void) => {
      const el = buttons.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": label } });
      setIcon(el, icon);
      el.addEventListener("click", onClick);
      return el;
    };
    button("lucide-bookmark-plus", "Bookmark the active tab...", () => this.bookmarkActiveTab());
    button("lucide-folder-plus", "New group", () => {
      const group = this.plugin.newGroup();
      this.render();
      this.startRename(group);
    });
    this.collapseAllButtonEl = button("lucide-chevrons-down-up", "Collapse all", () => this.toggleCollapseAll());

    const search = this.containerEl.createDiv({ cls: "search-input-container" });
    this.containerEl.insertBefore(search, this.contentEl);
    this.filterInputEl = search.createEl("input", { type: "search", attr: { placeholder: "Search bookmarks...", spellcheck: "false" } });
    const clear = search.createDiv({ cls: "search-input-clear-button", attr: { "aria-label": "Clear search" } });
    clear.hide();
    this.filterInputEl.addEventListener("input", () => {
      clear.toggle(this.filterInputEl.value !== "");
      this.render();
    });
    clear.addEventListener("click", () => {
      this.filterInputEl.value = "";
      clear.hide();
      this.render();
      this.filterInputEl.focus();
    });
  }

  private bookmarkActiveTab() {
    const { workspace } = this.app;
    const leaf = workspace.getMostRecentLeaf(workspace.rootSplit);
    const item = this.plugin.itemForLeaf(leaf);
    if (item) this.plugin.promptAdd(item);
  }

  private groups(): BookmarkItem[] {
    const out: BookmarkItem[] = [];
    const walk = (items: BookmarkItem[]) => {
      for (const i of items) if (i.type === "group") (out.push(i), walk(i.items ?? []));
    };
    walk(this.plugin.items);
    return out;
  }

  private toggleCollapseAll() {
    const groups = this.groups();
    const anyOpen = groups.some((g) => !this.collapsedGroups.has(g.ctime));
    this.collapsedGroups = anyOpen ? new Set(groups.map((g) => g.ctime)) : new Set();
    this.render();
    this.app.workspace.requestSaveLayout();
  }

  // ---- rendering ----------------------------------------------------------------------------

  private queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    void Promise.resolve().then(() => {
      this.renderQueued = false;
      if (!this.renaming) this.render();
    });
  }

  // internal
  render() {
    const scrollTop = this.contentEl.scrollTop;
    this.contentEl.empty();
    this.rows = [];
    const query = this.filterInputEl?.value.trim().toLowerCase() ?? "";
    const matches = (item: BookmarkItem): boolean => {
      if (!query) return true;
      if (this.plugin.getItemTitle(item).toLowerCase().includes(query)) return true;
      return item.type === "group" && !!item.items?.some(matches);
    };
    const renderList = (items: BookmarkItem[], parentEl: HTMLElement, parent: BookmarkItem | null) => {
      for (const item of items) {
        if (!matches(item)) continue;
        const row = this.renderRow(item, parentEl, parent);
        if (item.type === "group") {
          const childrenEl = row.el.createDiv({ cls: "tree-item-children" });
          const collapsed = !query && this.collapsedGroups.has(item.ctime);
          row.el.toggleClass("is-collapsed", collapsed);
          row.selfEl.querySelector(".collapse-icon")?.toggleClass("is-collapsed", collapsed);
          if (!collapsed) renderList(item.items ?? [], childrenEl, item);
        }
      }
    };
    renderList(this.plugin.items, this.contentEl, null);
    if (this.plugin.items.length === 0) {
      const empty = this.contentEl.createDiv({ cls: "pane-empty" });
      empty.setText("No bookmarks yet. Bookmark notes, headings, searches and more to find them here quickly.");
    }
    const anyOpen = this.groups().some((g) => !this.collapsedGroups.has(g.ctime));
    this.collapseAllButtonEl?.setAttr("aria-label", anyOpen ? "Collapse all" : "Expand all");
    if (this.collapseAllButtonEl) setIcon(this.collapseAllButtonEl, anyOpen ? "lucide-chevrons-down-up" : "lucide-chevrons-up-down");
    this.contentEl.scrollTop = scrollTop;
    this.updateActive();
  }

  private renderRow(item: BookmarkItem, parentEl: HTMLElement, parent: BookmarkItem | null): Row {
    const el = parentEl.createDiv({ cls: "tree-item" });
    const selfEl = el.createDiv({ cls: "tree-item-self bookmark is-clickable", attr: { draggable: "true" } });
    const target: TAbstractFile | null = item.type === "file" || item.type === "folder" ? this.app.vault.getAbstractFileByPath(item.path || "/") : null;
    if (item.type === "group") {
      selfEl.addClass("mod-collapsible");
      const collapse = selfEl.createDiv({ cls: "tree-item-icon collapse-icon" });
      setIcon(collapse, "right-triangle");
    } else {
      const icon = selfEl.createDiv({ cls: "tree-item-icon" });
      setIcon(icon, iconFor(item, target));
      if ((item.type === "file" || item.type === "folder") && !target) selfEl.addClass("is-unresolved");
    }
    const innerEl = selfEl.createDiv({ cls: "tree-item-inner" });
    innerEl.createDiv({ cls: "tree-item-inner-text", text: this.plugin.getItemTitle(item) });
    if (item.type === "search" || item.type === "url" || item.type === "file") {
      selfEl.setAttr("aria-label", item.type === "search" ? item.query ?? "" : item.type === "url" ? item.url ?? "" : (item.path ?? "") + (item.subpath ?? ""));
      selfEl.setAttr("data-tooltip-position", "right");
      selfEl.setAttr("data-tooltip-delay", "1000");
    }
    if (item === this.focused && this.focusVisible) selfEl.addClass("has-focus");
    const row: Row = { item, el, selfEl, innerEl, parent };
    this.rows.push(row);
    this.rowBySelf.set(selfEl, row);
    return row;
  }

  private updateActive() {
    const file = this.app.workspace.getActiveFile();
    for (const row of this.rows) {
      row.selfEl.toggleClass("is-active", !!file && row.item.type === "file" && !row.item.subpath && row.item.path === file.path);
    }
  }

  private rowFromEvent(evt: Event): Row | null {
    const self = evt.target instanceof Element ? evt.target.closest<HTMLElement>(".tree-item-self") : null;
    return self ? (this.rowBySelf.get(self) ?? null) : null;
  }

  private rowFor(item: BookmarkItem | null): Row | null {
    return item ? (this.rows.find((r) => r.item === item) ?? null) : null;
  }

  /** Move the keyboard cursor; the focus ring shows only for keyboard moves. */
  private setFocused(item: BookmarkItem | null, visible = true) {
    this.rowFor(this.focused)?.selfEl.removeClass("has-focus");
    this.focused = item;
    this.focusVisible = visible;
    const row = this.rowFor(item);
    row?.selfEl.toggleClass("has-focus", visible);
    row?.selfEl.scrollIntoView({ block: "nearest" });
  }

  private setCollapsed(group: BookmarkItem, collapsed: boolean) {
    if (collapsed) this.collapsedGroups.add(group.ctime);
    else this.collapsedGroups.delete(group.ctime);
    this.render();
    this.app.workspace.requestSaveLayout();
  }

  // ---- mouse and menus ---------------------------------------------------------------------------

  private onClick(evt: MouseEvent) {
    const row = this.rowFromEvent(evt);
    if (!row || this.renaming === row.item) return;
    this.setFocused(row.item, false);
    if (row.item.type === "group") {
      this.setCollapsed(row.item, !this.collapsedGroups.has(row.item.ctime));
      return;
    }
    void this.plugin.openBookmark(row.item, Keymap.isModEvent(evt));
  }

  private onContextMenu(evt: MouseEvent) {
    evt.preventDefault();
    const row = this.rowFromEvent(evt);
    const menu = new Menu();
    if (!row) {
      menu.addItem((i) => i.setTitle("New group").setIcon("lucide-folder-plus").onClick(() => {
        const group = this.plugin.newGroup();
        this.render();
        this.startRename(group);
      }));
      menu.addItem((i) => i.setTitle("Bookmark the active tab...").setIcon("lucide-bookmark-plus").onClick(() => this.bookmarkActiveTab()));
      menu.showAtMouseEvent(evt);
      return;
    }
    const { item } = row;
    if (item.type === "group") {
      menu.addItem((i) => i.setSection("action").setTitle("Rename").setIcon("lucide-edit-3").onClick(() => this.startRename(item)));
      menu.addItem((i) => i.setSection("action").setTitle("New group").setIcon("lucide-folder-plus").onClick(() => {
        const group = this.plugin.newGroup(item);
        this.setCollapsed(item, false);
        this.startRename(group);
      }));
      const files = (item.items ?? []).filter((c) => c.type === "file");
      if (files.length) {
        menu.addItem((i) => i.setSection("open").setTitle("Open all in new tabs").setIcon("lucide-files").onClick(async () => {
          for (const c of files) await this.plugin.openBookmark(c, "tab");
        }));
      }
    } else {
      if (item.type !== "folder" && item.type !== "search") {
        menu.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => void this.plugin.openBookmark(item, "tab")));
        menu.addItem((i) => i.setSection("open").setTitle("Open to the right").setIcon("lucide-separator-vertical").onClick(() => void this.plugin.openBookmark(item, "split")));
        menu.addItem((i) => i.setSection("open").setTitle("Open in new window").setIcon("lucide-picture-in-picture-2").onClick(() => void this.plugin.openBookmark(item, "window")));
      }
      menu.addItem((i) => i.setSection("action").setTitle("Edit...").setIcon("lucide-edit-3").onClick(() => this.plugin.editItem(item)));
    }
    menu.addItem((i) => i.setSection("danger").setTitle("Remove").setIcon("lucide-x").setWarning(true).onClick(() => this.plugin.removeItem(item)));
    if (item.type === "file" || item.type === "folder") {
      const file = this.app.vault.getAbstractFileByPath(item.path || "/");
      if (file) this.app.workspace.trigger("file-menu", menu, file, "bookmarks", this.leaf);
    }
    menu.setParentElement(row.selfEl);
    menu.showAtMouseEvent(evt);
  }

  // ---- rename (inline title) ----------------------------------------------------------------------

  private startRename(item: BookmarkItem) {
    const row = this.rowFor(item);
    if (!row) return;
    const textEl = row.innerEl.querySelector<HTMLElement>(".tree-item-inner-text") ?? row.innerEl;
    this.renaming = item;
    this.setFocused(item, false);
    row.selfEl.addClass("is-being-renamed");
    row.selfEl.setAttr("draggable", "false");
    textEl.setText(item.title ?? "");
    textEl.setAttr("contenteditable", "true");
    textEl.setAttr("data-placeholder", this.plugin.getItemTitle({ ...item, title: undefined }));
    textEl.focus();
    const range = document.createRange();
    range.selectNodeContents(textEl);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const finish = (commit: boolean) => {
      if (this.renaming !== item) return;
      this.renaming = null;
      textEl.removeEventListener("keydown", onKey);
      textEl.removeEventListener("blur", onBlur);
      textEl.removeAttribute("contenteditable");
      const title = (textEl.textContent ?? "").replace(/\n/g, "").trim();
      if (commit) {
        if (title) item.title = title;
        else delete item.title;
        this.plugin.onItemsChanged(true);
      }
      this.render();
      this.contentEl.focus({ preventScroll: true });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        finish(e.key === "Enter");
      }
      e.stopPropagation();
    };
    const onBlur = () => finish(true);
    textEl.addEventListener("keydown", onKey);
    textEl.addEventListener("blur", onBlur);
  }

  // ---- keyboard ----------------------------------------------------------------------------------------

  private registerKeys() {
    const s = this.keyScope;
    const guard = (fn: () => void) => (evt: KeyboardEvent) => {
      if (this.renaming || !(evt.target instanceof Node) || !this.contentEl.contains(evt.target)) return;
      fn();
      return false;
    };
    const move = (delta: number) =>
      guard(() => {
        if (this.rows.length === 0) return;
        const i = this.focused ? this.rows.findIndex((r) => r.item === this.focused) : -1;
        const next = i === -1 ? (delta > 0 ? 0 : this.rows.length - 1) : Math.max(0, Math.min(this.rows.length - 1, i + delta));
        this.setFocused(this.rows[next]!.item);
      });
    s.register([], "ArrowDown", move(1));
    s.register([], "ArrowUp", move(-1));
    s.register([], "ArrowRight", guard(() => {
      const f = this.focused;
      if (f?.type === "group" && this.collapsedGroups.has(f.ctime)) this.setCollapsed(f, false);
    }));
    s.register([], "ArrowLeft", guard(() => {
      const f = this.focused;
      if (!f) return;
      if (f.type === "group" && !this.collapsedGroups.has(f.ctime)) this.setCollapsed(f, true);
      else {
        const parent = findParent(this.plugin.items, f);
        if (parent) this.setFocused(parent);
      }
    }));
    s.register([], "Enter", guard(() => {
      const f = this.focused;
      if (!f) return;
      if (f.type === "group") this.setCollapsed(f, !this.collapsedGroups.has(f.ctime));
      else void this.plugin.openBookmark(f, false);
    }));
    s.register([], "F2", guard(() => this.focused && this.startRename(this.focused)));
    const remove = guard(() => {
      const f = this.focused;
      if (!f) return;
      const i = this.rows.findIndex((r) => r.item === f);
      this.plugin.removeItem(f);
      this.render();
      const next = this.rows[Math.min(i, this.rows.length - 1)];
      if (next) this.setFocused(next.item);
    });
    s.register([], "Delete", remove);
    s.register(["Mod"], "Backspace", remove);
    s.register([], "Escape", guard(() => this.setFocused(null)));
  }

  // ---- drag and drop ----------------------------------------------------------------------------------------

  private onDragStart(evt: DragEvent) {
    const row = this.rowFromEvent(evt);
    if (!row || this.renaming) return;
    const dm = this.app.dragManager;
    const { item } = row;
    const file = item.type === "file" ? this.app.vault.getFileByPath(item.path ?? "") : null;
    const folder = item.type === "folder" ? this.app.vault.getFolderByPath(item.path || "/") : null;
    let data: any;
    if (file) data = dm.dragFile(evt, file, VIEW_TYPE_BOOKMARKS);
    else if (folder) data = dm.dragFolder(evt, folder, VIEW_TYPE_BOOKMARKS);
    else {
      const text = item.type === "url" ? (item.url ?? "") : item.type === "search" ? (item.query ?? "") : this.plugin.getItemTitle(item);
      evt.dataTransfer?.setData("text/plain", text);
      data = { type: "bookmarks", icon: iconFor(item, null), title: this.plugin.getItemTitle(item) };
    }
    // internal: lets this view recognise its own items on drop
    data.bookmarkItems = [item];
    row.selfEl.addClass("is-being-dragged");
    dm.onDragStart(evt, data);
  }

  private dropInfo(evt: DragEvent): { row: Row | null; position: DropPosition } {
    const row = this.rowFromEvent(evt);
    if (!row) return { row: null, position: "after" };
    const rect = row.selfEl.getBoundingClientRect();
    const y = (evt.clientY - rect.top) / Math.max(1, rect.height);
    if (row.item.type === "group" && y > 0.25 && y < 0.75) return { row, position: "into" };
    return { row, position: y < 0.5 ? "before" : "after" };
  }

  private dragged(): { items: BookmarkItem[] | null; files: TAbstractFile[] | null } {
    const data: any = this.app.dragManager.draggable;
    if (!data) return { items: null, files: null };
    if (Array.isArray(data.bookmarkItems)) return { items: data.bookmarkItems, files: null };
    if ((data.type === "file" || data.type === "folder") && data.file) return { items: null, files: [data.file] };
    if (data.type === "files" && data.files) return { items: null, files: data.files };
    return { items: null, files: null };
  }

  private onDragOver(evt: DragEvent) {
    const { items, files } = this.dragged();
    if (!items && !files) return;
    const { row, position } = this.dropInfo(evt);
    // Not onto itself, and never a group into its own subtree.
    if (items && row && items.some((i) => i === row.item || (i.type === "group" && isDescendant(i, row.item)))) {
      this.setDropTarget(null, "");
      return;
    }
    evt.preventDefault();
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = items ? "move" : "link";
    this.app.dragManager.setAction(items ? "Move bookmark" : "Bookmark");
    if (!row) this.setDropTarget(null, "is-being-dragged-over");
    else this.setDropTarget(row.selfEl, position === "into" ? "is-being-dragged-over" : position === "before" ? "vault-drop-before" : "vault-drop-after");
  }

  private setDropTarget(selfEl: HTMLElement | null, cls: string) {
    if (this.dropTarget) {
      (this.dropTarget.selfEl ?? this.contentEl).removeClass(this.dropTarget.cls);
    }
    this.dropTarget = cls ? { selfEl, cls } : null;
    if (this.dropTarget) (selfEl ?? this.contentEl).addClass(cls);
  }

  private onDrop(evt: DragEvent) {
    const { items, files } = this.dragged();
    this.setDropTarget(null, "");
    if (!items && !files) return;
    evt.preventDefault();
    const { row, position } = this.dropInfo(evt);
    let group: BookmarkItem | null = null;
    let index = this.plugin.items.length;
    if (row) {
      if (position === "into") {
        group = row.item;
        index = row.item.items?.length ?? 0;
        this.collapsedGroups.delete(row.item.ctime);
      } else {
        group = row.parent;
        const list = group ? (group.items ?? []) : this.plugin.items;
        index = list.indexOf(row.item) + (position === "after" ? 1 : 0);
      }
    }
    if (items) {
      for (const item of items) {
        if (group && isDescendant(item, group)) continue;
        this.plugin.moveItem(item, group, index);
        const list = group ? (group.items ?? []) : this.plugin.items;
        index = list.indexOf(item) + 1;
      }
    } else if (files) {
      for (const f of files) {
        if (this.plugin.findBookmarkByPath(f.path)) continue;
        this.plugin.addItem({ type: f instanceof TFolder ? "folder" : "file", ctime: Date.now(), path: f.path }, group, index++);
      }
    }
    this.render();
  }
}
