/**
 * The workspace containers: splits, tab groups, side docks, the root, and the
 * ribbons. Layout is flexbox; sizes are flex-grow shares stored as
 * `dimension`, which is also what `workspace.json` records.
 */
import { setIcon } from "../ui/icons";
import { Menu } from "../ui/menu";
import { WorkspaceItem, type SerializedItem } from "./base";
import { WorkspaceLeaf } from "./leaf";

export type SplitDirection = "vertical" | "horizontal";

export abstract class WorkspaceParent extends WorkspaceItem {
  children: WorkspaceItem[] = [];
  parent: any = null;
  // internal: where children's elements go
  childrenEl!: HTMLElement;

  insertChild(index: number, child: WorkspaceItem, _resize = true) {
    if (child.parent && child.parent !== this) child.parent.removeChild(child, false);
    const existing = this.children.indexOf(child);
    if (existing !== -1) this.children.splice(existing, 1);
    index = Math.max(0, Math.min(index, this.children.length));
    this.children.splice(index, 0, child);
    child.parent = this;
    const ref = this.children[index + 1]?.containerEl ?? null;
    this.childrenEl.insertBefore(child.containerEl, ref && ref.parentElement === this.childrenEl ? ref : null);
    this.onChildrenChanged();
  }

  removeChild(child: WorkspaceItem, _resize = true) {
    const i = this.children.indexOf(child);
    if (i === -1) return;
    this.children.splice(i, 1);
    child.containerEl.detach();
    if (child.parent === this) child.parent = null;
    this.onChildrenChanged();
    if (this.children.length === 0) this.onEmptied();
  }

  replaceChild(index: number, child: WorkspaceItem, _resize = true) {
    const old = this.children[index];
    if (!old) return this.insertChild(index, child);
    this.children[index] = child;
    child.parent = this;
    old.containerEl.replaceWith(child.containerEl);
    old.parent = null;
    this.onChildrenChanged();
  }

  // internal
  onChildrenChanged() {}

  // internal: a parent with no children removes itself, except the root and the docks
  onEmptied() {
    if ((this as { keepWhenEmpty?: boolean }).keepWhenEmpty) return;
    this.parent?.removeChild(this);
  }

  override onResize(): void {
    for (const c of this.children) c.onResize();
  }
}

export class WorkspaceSplit extends WorkspaceParent {
  direction: SplitDirection;

  constructor(workspace: any, direction: SplitDirection) {
    super();
    this.workspace = workspace;
    this.app = workspace.app;
    this.direction = direction;
    this.containerEl = createDiv({ cls: `workspace-split mod-${direction}` });
    this.childrenEl = this.containerEl;
  }

  override onChildrenChanged() {
    // Resize handles live at the end of every child except the last.
    this.children.forEach((c, i) => {
      const handle = c.resizeHandleEl ?? this.ensureHandle(c);
      handle.toggle(i < this.children.length - 1);
    });
    this.workspace?.onLayoutMutated?.();
  }

  private ensureHandle(child: WorkspaceItem): HTMLElement {
    const handle = child.containerEl.createEl("hr", { cls: "workspace-leaf-resize-handle" });
    child.resizeHandleEl = handle;
    handle.addEventListener("mousedown", (evt) => this.startResize(evt, child));
    return handle;
  }

  private startResize(evt: MouseEvent, child: WorkspaceItem) {
    evt.preventDefault();
    const i = this.children.indexOf(child);
    const next = this.children[i + 1];
    if (!next) return;
    const horizontal = this.direction === "vertical";
    const a = child.containerEl.getBoundingClientRect();
    const b = next.containerEl.getBoundingClientRect();
    const total = horizontal ? a.width + b.width : a.height + b.height;
    const shares = (child.dimension ?? 50) + (next.dimension ?? 50);
    const start = horizontal ? evt.clientX : evt.clientY;
    const startA = horizontal ? a.width : a.height;
    document.body.addClass("is-grabbing");
    const move = (e: MouseEvent) => {
      const delta = (horizontal ? e.clientX : e.clientY) - start;
      const sizeA = Math.max(60, Math.min(total - 60, startA + delta));
      child.setDimension((sizeA / total) * shares);
      next.setDimension(((total - sizeA) / total) * shares);
      this.onResize();
    };
    const up = () => {
      document.body.removeClass("is-grabbing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      this.workspace.requestSaveLayout();
      this.workspace.trigger("resize");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  serialize(): SerializedItem {
    return {
      id: this.id,
      type: "split",
      children: this.children.map((c) => c.serialize()),
      direction: this.direction,
      ...(this.dimension !== null ? { dimension: this.dimension } : {}),
    };
  }
}

export class WorkspaceTabs extends WorkspaceParent {
  currentTab = 0;
  tabHeaderContainerEl: HTMLElement;
  tabHeaderContainerInnerEl: HTMLElement;
  tabsContainerEl: HTMLElement;
  // internal
  isStacked = false;
  newTabButtonEl: HTMLElement;
  tabListEl: HTMLElement;

  constructor(workspace: any) {
    super();
    this.workspace = workspace;
    this.app = workspace.app;
    this.containerEl = createDiv({ cls: "workspace-tabs mod-top" });
    this.tabHeaderContainerEl = this.containerEl.createDiv({ cls: "workspace-tab-header-container" });
    this.tabHeaderContainerInnerEl = this.tabHeaderContainerEl.createDiv({ cls: "workspace-tab-header-container-inner" });
    this.newTabButtonEl = this.tabHeaderContainerEl.createDiv({ cls: "workspace-tab-header-new-tab" });
    const newBtn = this.newTabButtonEl.createSpan({ cls: "clickable-icon", attr: { "aria-label": "New tab" } });
    setIcon(newBtn, "lucide-plus");
    newBtn.addEventListener("click", () => {
      const leaf = new WorkspaceLeaf(this.app);
      this.insertChild(this.children.length, leaf);
      void leaf.setViewState({ type: "empty" }).then(() => this.workspace.setActiveLeaf(leaf, { focus: true }));
    });
    this.tabHeaderContainerEl.createDiv({ cls: "workspace-tab-header-spacer" });
    this.tabListEl = this.tabHeaderContainerEl.createDiv({ cls: "workspace-tab-header-tab-list" });
    const listBtn = this.tabListEl.createSpan({ cls: "clickable-icon", attr: { "aria-label": "Tab list" } });
    setIcon(listBtn, "lucide-chevron-down");
    listBtn.addEventListener("click", (evt) => this.showTabList(evt));
    this.tabsContainerEl = this.containerEl.createDiv({ cls: "workspace-tab-container" });
    this.childrenEl = this.tabsContainerEl;

    this.tabHeaderContainerEl.addEventListener("dragover", (evt) => this.workspace.onTabDragOver?.(evt, this));
    this.tabHeaderContainerEl.addEventListener("drop", (evt) => this.workspace.onTabDrop?.(evt, this));
    this.tabHeaderContainerEl.addEventListener("dblclick", (evt) => {
      if (evt.target === this.tabHeaderContainerEl || (evt.target as HTMLElement).hasClass("workspace-tab-header-spacer")) {
        this.newTabButtonEl.querySelector<HTMLElement>(".clickable-icon")?.click();
      }
    });
  }

  private showTabList(evt: MouseEvent) {
    const menu = new Menu();
    this.children.forEach((leaf, i) => {
      const l = leaf as WorkspaceLeaf;
      menu.addItem((item) =>
        item
          .setTitle(l.getDisplayText())
          .setIcon(l.getIcon())
          .setChecked(i === this.currentTab)
          .onClick(() => {
            this.selectTab(l);
            this.workspace.setActiveLeaf(l, { focus: true });
          }),
      );
    });
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle(this.isStacked ? "Unstack tabs" : "Stack tabs").setIcon("lucide-layers").onClick(() => this.setStacked(!this.isStacked)),
    );
    menu.showAtMouseEvent(evt);
  }

  // internal
  setStacked(stacked: boolean) {
    this.isStacked = stacked;
    this.containerEl.toggleClass("mod-stacked", stacked);
    this.placeTabHeaders();
    this.selectTabIndex(this.currentTab);
    this.workspace.requestSaveLayout();
  }

  /**
   * Tab headers live in the header bar, except in stacked mode, where each
   * header becomes a spine in front of its own leaf inside the tab container
   * (`.mod-stacked .workspace-tab-container .workspace-tab-header`, the DOM
   * themes style).
   */
  // internal
  placeTabHeaders() {
    this.children.forEach((c, i) => {
      const leaf = c as WorkspaceLeaf;
      if (this.isStacked) {
        this.tabsContainerEl.insertBefore(leaf.tabHeaderEl, leaf.containerEl);
        leaf.tabHeaderEl.style.setProperty("--vault-stack-index", String(i));
        leaf.containerEl.style.setProperty("--vault-stack-index", String(i));
      } else {
        leaf.tabHeaderEl.style.removeProperty("--vault-stack-index");
        leaf.containerEl.style.removeProperty("--vault-stack-index");
        this.tabHeaderContainerInnerEl.appendChild(leaf.tabHeaderEl);
      }
    });
    this.tabsContainerEl.style.setProperty("--vault-stack-count", String(this.children.length));
  }

  override insertChild(index: number, child: WorkspaceItem, resize = true) {
    super.insertChild(index, child, resize);
    const leaf = child as WorkspaceLeaf;
    const i = this.children.indexOf(child);
    if (this.isStacked) {
      this.placeTabHeaders();
    } else {
      const ref = this.tabHeaderContainerInnerEl.children[i] ?? null;
      this.tabHeaderContainerInnerEl.insertBefore(leaf.tabHeaderEl, ref === leaf.tabHeaderEl ? ref.nextSibling : ref);
    }
    this.selectTabIndex(i);
  }

  override removeChild(child: WorkspaceItem, resize = true) {
    const i = this.children.indexOf(child);
    if (i === -1) return;
    (child as WorkspaceLeaf).tabHeaderEl.detach();
    super.removeChild(child, resize);
    if (this.children.length) {
      if (this.isStacked) this.placeTabHeaders();
      // Closing a tab activates the one to its right (or the new last one).
      this.selectTabIndex(Math.min(i, this.children.length - 1));
    }
  }

  override onChildrenChanged() {
    this.containerEl.toggleClass("mod-has-single-tab", this.children.length === 1);
    this.workspace?.onLayoutMutated?.();
  }

  selectTab(leaf: WorkspaceLeaf) {
    const i = this.children.indexOf(leaf);
    if (i !== -1) this.selectTabIndex(i);
  }

  selectTabIndex(index: number) {
    this.currentTab = Math.max(0, Math.min(index, this.children.length - 1));
    this.children.forEach((c, i) => {
      const leaf = c as WorkspaceLeaf;
      const active = i === this.currentTab;
      leaf.tabHeaderEl.toggleClass("is-active", active);
      leaf.containerEl.toggle(active || this.isStacked);
      if (active && leaf.isDeferred) void leaf.loadIfDeferred();
    });
    const current = this.children[this.currentTab] as WorkspaceLeaf | undefined;
    current?.onResize();
    if (current) this.revealTabHeader(current);
  }

  /** Keep the selected tab visible when the header bar (or a stack) overflows. */
  private revealTabHeader(leaf: WorkspaceLeaf) {
    if (!this.containerEl.isConnected) return;
    if (this.isStacked) {
      const scroller = this.tabsContainerEl;
      const i = this.children.indexOf(leaf);
      const spine = leaf.tabHeaderEl.offsetWidth || 0;
      const left = leaf.tabHeaderEl.offsetLeft - i * spine;
      const right = leaf.containerEl.offsetLeft + leaf.containerEl.offsetWidth;
      if (left < scroller.scrollLeft) scroller.scrollLeft = left;
      else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
      return;
    }
    const bar = this.tabHeaderContainerInnerEl;
    if (bar.scrollWidth <= bar.clientWidth) return;
    const el = leaf.tabHeaderEl;
    if (el.offsetLeft < bar.scrollLeft) bar.scrollLeft = el.offsetLeft;
    else if (el.offsetLeft + el.offsetWidth > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = el.offsetLeft + el.offsetWidth - bar.clientWidth;
  }

  getActiveLeaf(): WorkspaceLeaf | null {
    return (this.children[this.currentTab] as WorkspaceLeaf) ?? null;
  }

  serialize(): SerializedItem {
    return {
      id: this.id,
      type: "tabs",
      ...(this.dimension !== null ? { dimension: this.dimension } : {}),
      children: this.children.map((c) => c.serialize()),
      ...(this.currentTab ? { currentTab: this.currentTab } : {}),
      ...(this.isStacked ? { stacked: true } : {}),
    };
  }
}

export abstract class WorkspaceContainer extends WorkspaceSplit {
  isContainer = true;
  abstract win: Window;
  abstract doc: Document;
}

export class WorkspaceRoot extends WorkspaceContainer {
  win: Window = window;
  doc: Document = document;
  keepWhenEmpty = true;
  isRootContainer = true;

  constructor(workspace: any) {
    super(workspace, "vertical");
    this.containerEl.addClass("mod-root");
  }

  override onEmptied() {
    // The main area always holds at least one (empty) tab.
    this.workspace?.ensureRootLeaf?.();
  }
}

export class WorkspaceWindow extends WorkspaceContainer {
  win: Window;
  doc: Document;
  constructor(workspace: any, win: Window) {
    super(workspace, "vertical");
    this.win = win;
    this.doc = win.document;
    this.containerEl.addClass("mod-root");
  }
  override onEmptied() {
    this.parent?.removeChild(this);
    this.win.close();
  }
}

export class WorkspaceFloating extends WorkspaceParent {
  keepWhenEmpty = true;
  constructor(workspace: any) {
    super();
    this.workspace = workspace;
    this.app = workspace.app;
    this.containerEl = createDiv({ cls: "workspace-floating" });
    this.childrenEl = this.containerEl;
  }
  serialize(): SerializedItem {
    return { id: this.id, type: "floating", children: [] };
  }
}

export class WorkspaceSidedock extends WorkspaceSplit {
  collapsed = false;
  keepWhenEmpty = true;
  isRootContainer = true;
  side: "left" | "right";
  size = 300;

  constructor(workspace: any, side: "left" | "right") {
    super(workspace, "horizontal");
    this.side = side;
    this.containerEl.addClasses(["mod-sidedock", `mod-${side}-split`]);
    const handle = this.containerEl.createEl("hr", { cls: "workspace-leaf-resize-handle mod-sidedock-handle" });
    handle.addEventListener("mousedown", (evt) => this.startDockResize(evt));
    this.setSize(this.size);
  }

  override insertChild(index: number, child: WorkspaceItem, resize = true) {
    super.insertChild(index, child, resize);
    // Keep the dock's own resize handle last.
    const handle = this.containerEl.querySelector(":scope > .mod-sidedock-handle");
    if (handle) this.containerEl.appendChild(handle);
  }

  // internal
  setSize(size: number) {
    this.size = Math.max(160, Math.min(size, window.innerWidth * 0.6));
    this.containerEl.style.width = `${this.size}px`;
  }

  private startDockResize(evt: MouseEvent) {
    evt.preventDefault();
    const startX = evt.clientX;
    const start = this.size;
    document.body.addClass("is-grabbing");
    const move = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      this.setSize(this.side === "left" ? start + delta : start - delta);
      this.workspace.trigger("resize");
    };
    const up = () => {
      document.body.removeClass("is-grabbing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      this.workspace.requestSaveLayout();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  toggle(): void {
    if (this.collapsed) this.expand();
    else this.collapse();
  }

  collapse(): void {
    this.collapsed = true;
    this.containerEl.addClass("is-sidedock-collapsed");
    this.containerEl.style.width = "0px";
    this.workspace.onSidedockToggled?.(this);
  }

  expand(): void {
    this.collapsed = false;
    this.containerEl.removeClass("is-sidedock-collapsed");
    this.setSize(this.size);
    this.workspace.onSidedockToggled?.(this);
  }

  override serialize(): SerializedItem {
    return { ...super.serialize(), width: this.size, ...(this.collapsed ? { collapsed: true } : {}) };
  }
}

/** Mobile layouts use drawers; in this app the side docks serve both. */
export class WorkspaceMobileDrawer extends WorkspaceSidedock {}

export interface RibbonItem {
  id: string;
  icon: string;
  title: string;
  callback: (evt: MouseEvent) => unknown;
  buttonEl: HTMLElement;
  hidden: boolean;
}

export class WorkspaceRibbon {
  containerEl: HTMLElement;
  // internal (used by plugins: editing-toolbar, iconize)
  ribbonActionsEl: HTMLElement;
  ribbonSettingEl: HTMLElement;
  items: RibbonItem[] = [];
  side: "left" | "right";
  private workspace: any;

  constructor(workspace: any, side: "left" | "right") {
    this.workspace = workspace;
    this.side = side;
    this.containerEl = createDiv({ cls: `workspace-ribbon side-dock-ribbon mod-${side}` });
    const toggle = this.containerEl.createDiv({ cls: `sidebar-toggle-button mod-${side}` });
    const toggleBtn = toggle.createDiv({ cls: "clickable-icon", attr: { "aria-label": side === "left" ? "Expand" : "Expand" } });
    setIcon(toggleBtn, side === "left" ? "lucide-sidebar-left" : "lucide-sidebar-right");
    toggleBtn.addEventListener("click", () => (side === "left" ? workspace.leftSplit : workspace.rightSplit).toggle());
    this.ribbonActionsEl = this.containerEl.createDiv({ cls: "side-dock-actions" });
    this.ribbonSettingEl = this.containerEl.createDiv({ cls: "side-dock-settings" });
    this.containerEl.addEventListener("contextmenu", (evt) => {
      if ((evt.target as HTMLElement).closest(".side-dock-ribbon-action")) return;
      evt.preventDefault();
      this.showConfigMenu(evt);
    });
  }

  // internal (used by plugins: Plugin.addRibbonIcon goes through here)
  addRibbonItemButton(id: string, icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const buttonEl = createDiv({ cls: "clickable-icon side-dock-ribbon-action", attr: { "aria-label": title, "data-tooltip-position": "right" } });
    setIcon(buttonEl, icon);
    buttonEl.addEventListener("click", (evt) => callback(evt));
    const hiddenItems = (this.workspace.ribbonConfig?.hiddenItems ?? {}) as Record<string, boolean>;
    const hidden = !!hiddenItems[id];
    const item: RibbonItem = { id, icon, title, callback, buttonEl, hidden };
    this.items.push(item);
    const order = (this.workspace.ribbonConfig?.order ?? []) as string[];
    this.ribbonActionsEl.appendChild(buttonEl);
    if (order.length) this.applyOrder(order);
    buttonEl.toggle(!hidden);
    return buttonEl;
  }

  // internal
  removeRibbonAction(id: string) {
    const i = this.items.findIndex((it) => it.id === id);
    if (i === -1) return;
    this.items[i]!.buttonEl.detach();
    this.items.splice(i, 1);
  }

  private applyOrder(order: string[]) {
    const rank = (id: string) => {
      const r = order.indexOf(id);
      return r === -1 ? Number.MAX_SAFE_INTEGER : r;
    };
    this.items.sort((a, b) => rank(a.id) - rank(b.id));
    for (const it of this.items) this.ribbonActionsEl.appendChild(it.buttonEl);
  }

  private showConfigMenu(evt: MouseEvent) {
    const menu = new Menu();
    for (const it of this.items) {
      menu.addItem((m) =>
        m
          .setTitle(it.title)
          .setIcon(it.icon)
          .setChecked(!it.hidden)
          .onClick(() => {
            it.hidden = !it.hidden;
            it.buttonEl.toggle(!it.hidden);
            this.workspace.saveRibbonConfig?.(this);
          }),
      );
    }
    menu.addSeparator();
    menu.addItem((m) => m.setTitle("Hide ribbon").onClick(() => this.workspace.app.vault.setConfig("showRibbon", false)));
    menu.showAtMouseEvent(evt);
  }

  // internal
  serialize() {
    const hiddenItems: Record<string, boolean> = {};
    for (const it of this.items) hiddenItems[it.id] = it.hidden;
    return { hiddenItems, order: this.items.map((i) => i.id) };
  }
}
