/**
 * Workspace — the layout tree, the active leaf, and opening things.
 */
import type { OpenViewState, ViewState } from "obsidian";
import { Events } from "../events";
import { Menu } from "../ui/menu";
import { EditorSuggests } from "../ui/suggest";
import { debounce, normalizePath, parseLinktext } from "../util";
import { TFile, type TAbstractFile } from "../vault/files";
import type { SerializedItem } from "./base";
import {
  WorkspaceFloating,
  WorkspaceParent,
  WorkspaceRibbon,
  WorkspaceRoot,
  WorkspaceSidedock,
  WorkspaceSplit,
  WorkspaceTabs,
  type SplitDirection,
} from "./items";
import { WorkspaceLeaf } from "./leaf";
import type { View } from "./view";

type PaneType = "tab" | "split" | "window";
type DropZone = "left" | "right" | "top" | "bottom" | "center";

function findLeafData(data: any, id: string): any {
  if (!data || typeof data !== "object") return null;
  if (data.type === "leaf") return data.id === id ? data : null;
  for (const c of data.children ?? []) {
    const hit = findLeafData(c, id);
    if (hit) return hit;
  }
  return null;
}

export class Workspace extends Events {
  app: any;
  leftSplit: WorkspaceSidedock;
  rightSplit: WorkspaceSidedock;
  leftRibbon: WorkspaceRibbon;
  rightRibbon: WorkspaceRibbon;
  rootSplit: WorkspaceRoot;
  // internal (used by plugins: popouts)
  floatingSplit: WorkspaceFloating;
  activeLeaf: WorkspaceLeaf | null = null;
  containerEl: HTMLElement;
  layoutReady = false;
  requestSaveLayout: ReturnType<typeof debounce<[], Promise<void>>>;
  activeEditor: any = null;
  // internal
  activeTabGroup: WorkspaceTabs | null = null;
  // internal (used by plugins: kanban reads editorSuggest.suggests)
  editorSuggest: EditorSuggests;
  // internal
  hoverLinkSources: Record<string, { display: string; defaultMod: boolean }> = {};
  // internal
  protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();
  // internal
  recentFiles: string[] = [];
  // internal
  ribbonConfig: Record<string, unknown> = {};
  // internal
  onLayoutReadyCallbacks: { pluginId?: string; callback: () => unknown }[] | null = [];
  private lastActiveFile: TFile | null = null;
  // internal
  undoHistory: { state: ViewState; parentId: string | null; index: number }[] = [];

  constructor(app: any) {
    super();
    this.app = app;
    this.editorSuggest = new EditorSuggests(app);
    this.containerEl = createDiv({ cls: "workspace" });
    this.leftRibbon = new WorkspaceRibbon(this, "left");
    this.rightRibbon = new WorkspaceRibbon(this, "right");
    this.leftSplit = new WorkspaceSidedock(this, "left");
    this.rightSplit = new WorkspaceSidedock(this, "right");
    this.rootSplit = new WorkspaceRoot(this);
    this.floatingSplit = new WorkspaceFloating(this);
    this.containerEl.append(
      this.leftRibbon.containerEl,
      this.leftSplit.containerEl,
      this.rootSplit.containerEl,
      this.rightSplit.containerEl,
      this.rightRibbon.containerEl,
    );
    this.rightRibbon.containerEl.addClass("is-collapsed");
    this.requestSaveLayout = debounce(() => this.saveLayout(), 1000, true);

    app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      const i = this.recentFiles.indexOf(oldPath);
      if (i !== -1) this.recentFiles[i] = file.path;
    });
    app.vault.on("delete", (file: TAbstractFile) => this.recentFiles.remove(file.path));
    window.addEventListener("resize", () => {
      this.trigger("resize");
      this.rootSplit.onResize();
    });

    // Cursor and scroll are ephemeral view state, but a reload should bring
    // them back, so moving either schedules a layout save (debounced).
    const ephemeralChanged = () => {
      if (this.layoutReady) this.requestSaveLayout();
    };
    this.containerEl.addEventListener("scroll", ephemeralChanged, { capture: true, passive: true });
    this.containerEl.addEventListener("keyup", ephemeralChanged, true);
    this.containerEl.addEventListener("pointerup", ephemeralChanged, true);
    // Leaving the page: write the layout now rather than after the debounce.
    const flush = () => {
      if (this.layoutReady) void this.saveLayout();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });

    // Dragging a tab over a pane shows where it will land: an edge splits,
    // the middle moves the tab into that group.
    this.containerEl.addEventListener("dragover", (evt) => this.onPaneDragOver(evt));
    this.containerEl.addEventListener("drop", (evt) => this.onPaneDrop(evt));
    this.containerEl.addEventListener("dragleave", (evt) => {
      if (!evt.relatedTarget || !this.containerEl.contains(evt.relatedTarget as Node)) this.hideDropOverlay();
    });
  }

  // internal: one pane at a time (the phone layout)
  isSinglePane(): boolean {
    return !!this.app.isMobile && document.body.hasClass("is-phone");
  }

  // internal: the phone and tablet layout is kept apart from the desktop one, as Obsidian does
  getLayoutFileName(): string {
    return this.app.isMobile ? "workspace-mobile.json" : "workspace.json";
  }

  // internal: the saved layout for this form factor (mobile falls back to the desktop layout once)
  async readSavedLayout(): Promise<any> {
    const own = await this.app.vault.readConfigJson(this.getLayoutFileName()).catch(() => null);
    if (own || !this.app.isMobile) return own;
    return this.app.vault.readConfigJson("workspace.json").catch(() => null);
  }

  // ---- layout ready -----------------------------------------------------------

  onLayoutReady(callback: () => any): void {
    if (this.layoutReady) {
      // Obsidian defers even when ready, so plugins see a consistent order.
      setTimeout(() => callback(), 0);
      return;
    }
    this.onLayoutReadyCallbacks?.push({ pluginId: this.app.plugins?.loadingPluginId, callback });
  }

  // internal
  setLayoutReady() {
    if (this.layoutReady) return;
    this.layoutReady = true;
    const cbs = this.onLayoutReadyCallbacks ?? [];
    this.onLayoutReadyCallbacks = null;
    for (const { callback } of cbs) {
      try {
        callback();
      } catch (e) {
        console.error(e);
      }
    }
    this.trigger("layout-ready");
  }

  // ---- serialisation ------------------------------------------------------------

  getLayout(): Record<string, unknown> {
    return {
      main: this.rootSplit.serialize(),
      left: this.leftSplit.serialize(),
      right: this.rightSplit.serialize(),
      "left-ribbon": this.leftRibbon.serialize(),
      ...(this.activeLeaf ? { active: this.activeLeaf.id } : {}),
      lastOpenFiles: this.getLastOpenFiles(),
    };
  }

  // internal
  async saveLayout(): Promise<void> {
    if (!this.layoutReady) return;
    try {
      await this.app.vault.writeConfigJson(this.getLayoutFileName(), this.getLayout());
    } catch (e) {
      console.error("Failed to save workspace layout", e);
    }
  }

  async changeLayout(layout: any): Promise<void> {
    this.clearLayout();
    const leaves: WorkspaceLeaf[] = [];
    const build = (data: any, parent: WorkspaceParent) => {
      if (!data || typeof data !== "object") return;
      if (data.type === "leaf") {
        const leaf = new WorkspaceLeaf(this.app);
        if (data.id) leaf.id = data.id;
        parent.insertChild(parent.children.length, leaf);
        if (typeof data.dimension === "number") leaf.setDimension(data.dimension);
        if (data.pinned) leaf.setPinned(true);
        if (data.group) leaf.group = data.group;
        const state = data.state ?? { type: "empty" };
        leaf.setDeferredState({ type: state.type, state: state.state ?? {} }, state.title ?? "", state.icon ?? "", state.eState ?? undefined);
        leaves.push(leaf);
        return;
      }
      if (data.type === "tabs") {
        const tabs = new WorkspaceTabs(this);
        if (data.id) tabs.id = data.id;
        parent.insertChild(parent.children.length, tabs);
        if (typeof data.dimension === "number") tabs.setDimension(data.dimension);
        for (const child of data.children ?? []) build(child, tabs);
        if (data.stacked) tabs.setStacked(true);
        tabs.selectTabIndex(data.currentTab ?? 0);
        if (tabs.children.length === 0) parent.removeChild(tabs);
        return;
      }
      if (data.type === "split") {
        const split = new WorkspaceSplit(this, data.direction === "horizontal" ? "horizontal" : "vertical");
        if (data.id) split.id = data.id;
        parent.insertChild(parent.children.length, split);
        if (typeof data.dimension === "number") split.setDimension(data.dimension);
        for (const child of data.children ?? []) build(child, split);
        if (split.children.length === 0) parent.removeChild(split);
      }
    };
    const fill = (dock: WorkspaceSplit, data: any) => {
      for (const child of data?.children ?? []) build(child, dock);
    };
    fill(this.rootSplit, layout?.main);
    fill(this.leftSplit, layout?.left);
    fill(this.rightSplit, layout?.right);
    if (layout?.left?.width) this.leftSplit.setSize(layout.left.width);
    if (layout?.right?.width) this.rightSplit.setSize(layout.right.width);
    if (layout?.left?.collapsed) this.leftSplit.collapse();
    if (layout?.right?.collapsed) this.rightSplit.collapse();
    if (Array.isArray(layout?.lastOpenFiles)) this.recentFiles = layout.lastOpenFiles.slice(0, 50);
    this.ensureRootLeaf();

    // Sidebar views load immediately (they are small and plugins expect them);
    // background tabs in the main area stay deferred until selected.
    for (const leaf of leaves) {
      const inRoot = leaf.getRoot() === this.rootSplit;
      const tabs = leaf.parent as WorkspaceTabs;
      if (!inRoot || tabs.getActiveLeaf() === leaf) await leaf.loadIfDeferred().catch((e) => console.error(e));
    }
    const active = (layout?.active && this.getLeafById(layout.active)) || this.getMostRecentLeaf(this.rootSplit);
    if (active) {
      (active.parent as WorkspaceTabs)?.selectTab?.(active);
      await active.loadIfDeferred();
      this.setActiveLeaf(active, { focus: false });
    }
    // A view restores its scroll before the browser has laid it out; apply the
    // saved scroll again once it has, for every tab that is showing.
    const shown = leaves.filter((l) => !l.isDeferred && l.getRoot() === this.rootSplit);
    const scrolls = new Map<WorkspaceLeaf, number>();
    for (const l of shown) {
      const e = (layout ? findLeafData(layout.main, l.id)?.state?.eState : null) as { scroll?: unknown } | null;
      if (e && typeof e.scroll === "number") scrolls.set(l, e.scroll);
    }
    if (scrolls.size) {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          for (const [l, scroll] of scrolls) {
            try {
              l.view?.setEphemeralState({ scroll, focus: false });
            } catch (e) {
              console.error(e);
            }
          }
        }),
      );
    }
    this.app.mobile?.onLayoutRestored?.();
    this.trigger("layout-change");
  }

  private clearLayout() {
    const detachAll = (p: WorkspaceParent) => {
      for (const child of p.children.slice()) {
        if (child instanceof WorkspaceLeaf) {
          void child.view?.close();
          child.containerEl.detach();
          child.tabHeaderEl.detach();
        } else if (child instanceof WorkspaceParent) detachAll(child);
        child.containerEl.detach();
      }
      p.children = [];
    };
    detachAll(this.rootSplit);
    detachAll(this.leftSplit);
    detachAll(this.rightSplit);
    this.activeLeaf = null;
  }

  // internal
  ensureRootLeaf() {
    if (this.getLeavesIn(this.rootSplit).length > 0) return;
    const tabs = new WorkspaceTabs(this);
    this.rootSplit.insertChild(0, tabs);
    const leaf = new WorkspaceLeaf(this.app);
    tabs.insertChild(0, leaf);
    void leaf.setViewState({ type: "empty" });
    if (!this.activeLeaf || !this.activeLeaf.parent) this.setActiveLeaf(leaf, { focus: false });
  }

  // ---- leaves -------------------------------------------------------------------

  private getLeavesIn(parent: WorkspaceParent): WorkspaceLeaf[] {
    const out: WorkspaceLeaf[] = [];
    const walk = (p: WorkspaceParent) => {
      for (const c of p.children) {
        if (c instanceof WorkspaceLeaf) out.push(c);
        else if (c instanceof WorkspaceParent) walk(c);
      }
    };
    walk(parent);
    return out;
  }

  iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => any): void {
    for (const l of this.getLeavesIn(this.rootSplit)) if (callback(l) === true) return;
    for (const w of this.floatingSplit.children) {
      for (const l of this.getLeavesIn(w as WorkspaceParent)) if (callback(l) === true) return;
    }
  }

  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => any): void {
    for (const root of [this.rootSplit, this.leftSplit, this.rightSplit]) {
      for (const l of this.getLeavesIn(root)) if (callback(l) === true) return;
    }
    for (const w of this.floatingSplit.children) {
      for (const l of this.getLeavesIn(w as WorkspaceParent)) if (callback(l) === true) return;
    }
  }

  // internal
  iterateTabs(tabs: WorkspaceParent, cb: (leaf: WorkspaceLeaf) => unknown) {
    for (const l of this.getLeavesIn(tabs)) cb(l);
  }

  getLeafById(id: string): WorkspaceLeaf | null {
    let found: WorkspaceLeaf | null = null;
    this.iterateAllLeaves((l) => {
      if (l.id === id) {
        found = l;
        return true;
      }
    });
    return found;
  }

  getGroupLeaves(group: string): WorkspaceLeaf[] {
    const out: WorkspaceLeaf[] = [];
    this.iterateAllLeaves((l) => {
      if (l.group === group) out.push(l);
    });
    return out;
  }

  getMostRecentLeaf(root: WorkspaceParent = this.rootSplit): WorkspaceLeaf | null {
    let best: WorkspaceLeaf | null = null;
    for (const l of this.getLeavesIn(root)) if (!best || l.activeTime > best.activeTime) best = l;
    return best;
  }

  getLeavesOfType(viewType: string): WorkspaceLeaf[] {
    const out: WorkspaceLeaf[] = [];
    this.iterateAllLeaves((l) => {
      if (l.getViewState().type === viewType) out.push(l);
    });
    return out;
  }

  detachLeavesOfType(viewType: string): void {
    for (const l of this.getLeavesOfType(viewType)) l.detach();
  }

  getActiveViewOfType<T extends View>(type: new (...args: any[]) => T): T | null {
    const view = this.activeLeaf?.view;
    return view instanceof type ? view : null;
  }

  getActiveFile(): TFile | null {
    const view = this.activeLeaf?.view as { file?: TFile | null } | undefined;
    if (view && "file" in view && view.file) return view.file;
    return this.lastActiveFile && !this.lastActiveFile.deleted ? this.lastActiveFile : null;
  }

  // internal
  getActiveFileView(): any {
    const view = this.activeLeaf?.view as { file?: TFile | null } | undefined;
    return view && "file" in view ? view : null;
  }

  private newLeafInTabs(tabs: WorkspaceTabs, index?: number): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this.app);
    const at = index ?? tabs.currentTab + 1;
    tabs.insertChild(Math.min(at, tabs.children.length), leaf);
    return leaf;
  }

  private activeRootTabs(): WorkspaceTabs {
    const active = this.activeLeaf;
    if (active && active.getRoot() === this.rootSplit && active.parent instanceof WorkspaceTabs) return active.parent;
    const recent = this.getMostRecentLeaf(this.rootSplit);
    if (recent?.parent instanceof WorkspaceTabs) return recent.parent;
    this.ensureRootLeaf();
    return this.getLeavesIn(this.rootSplit)[0]!.parent as WorkspaceTabs;
  }

  getUnpinnedLeaf(): WorkspaceLeaf {
    const active = this.activeLeaf;
    if (active && active.getRoot() === this.rootSplit && !active.pinned) return active;
    const recent = this.getMostRecentLeaf(this.rootSplit);
    if (recent && !recent.pinned) return recent;
    return this.newLeafInTabs(this.activeRootTabs());
  }

  getLeaf(newLeaf?: PaneType | boolean, direction: SplitDirection = "vertical"): WorkspaceLeaf {
    // A phone shows one pane: "to the right" and "new window" open a tab.
    if ((newLeaf === "split" || newLeaf === "window") && this.isSinglePane()) newLeaf = "tab";
    if (newLeaf === "split") return this.createLeafBySplit(this.getUnpinnedLeafOrActive(), direction);
    if (newLeaf === "window") return this.openPopoutLeaf();
    if (newLeaf === true || newLeaf === "tab") return this.newLeafInTabs(this.activeRootTabs());
    return this.getUnpinnedLeaf();
  }

  private getUnpinnedLeafOrActive(): WorkspaceLeaf {
    const active = this.activeLeaf;
    if (active && active.getRoot() === this.rootSplit) return active;
    return this.getUnpinnedLeaf();
  }

  createLeafInParent(parent: WorkspaceSplit, index: number): WorkspaceLeaf {
    const tabs = new WorkspaceTabs(this);
    parent.insertChild(index, tabs);
    const leaf = new WorkspaceLeaf(this.app);
    tabs.insertChild(0, leaf);
    return leaf;
  }

  createLeafBySplit(leaf: WorkspaceLeaf, direction: SplitDirection = "vertical", before = false): WorkspaceLeaf {
    const newTabs = this.insertTabsBeside(leaf.parent as WorkspaceTabs, direction, before);
    const newLeaf = new WorkspaceLeaf(this.app);
    newTabs.insertChild(0, newLeaf);
    return newLeaf;
  }

  // internal: a new, empty tab group next to `tabs`
  insertTabsBeside(tabs: WorkspaceTabs, direction: SplitDirection, before: boolean): WorkspaceTabs {
    const split = tabs.parent as WorkspaceSplit;
    const newTabs = new WorkspaceTabs(this);
    if (split.direction === direction) {
      const i = split.children.indexOf(tabs);
      split.insertChild(before ? i : i + 1, newTabs);
    } else {
      // Wrap the tab group in a new split of the requested direction.
      const i = split.children.indexOf(tabs);
      const wrapper = new WorkspaceSplit(this, direction);
      wrapper.setDimension(tabs.dimension);
      split.replaceChild(i, wrapper);
      tabs.setDimension(null);
      wrapper.insertChild(0, tabs);
      wrapper.insertChild(before ? 0 : 1, newTabs);
    }
    return newTabs;
  }

  splitActiveLeaf(direction: SplitDirection = "vertical"): WorkspaceLeaf {
    const leaf = this.getUnpinnedLeafOrActive();
    const created = this.isSinglePane() ? this.newLeafInTabs(this.activeRootTabs()) : this.createLeafBySplit(leaf, direction);
    void created.setViewState(leaf.getViewState(), leaf.getEphemeralState());
    return created;
  }

  async duplicateLeaf(leaf: WorkspaceLeaf, leafType?: PaneType | boolean | SplitDirection, direction?: SplitDirection): Promise<WorkspaceLeaf> {
    let target: WorkspaceLeaf;
    if (this.isSinglePane() && leafType !== false && leafType !== undefined) leafType = "tab";
    if (leafType === "vertical" || leafType === "horizontal") target = this.createLeafBySplit(leaf, leafType);
    else if (leafType === "split") target = this.createLeafBySplit(leaf, direction ?? "vertical");
    else if (leafType === "window") target = this.openPopoutLeaf();
    else target = this.newLeafInTabs(leaf.parent instanceof WorkspaceTabs ? leaf.parent : this.activeRootTabs());
    await target.setViewState({ ...leaf.getViewState(), active: true }, leaf.getEphemeralState());
    return target;
  }

  moveLeafToPopout(leaf: WorkspaceLeaf, _data?: unknown): any {
    // Browsers give a page no control over a second top-level window's
    // chrome, and a leaf's DOM cannot keep its event listeners across
    // documents reliably. A new tab group on the right is the honest fallback.
    const target = this.createLeafBySplit(leaf, "vertical");
    void target.setViewState(leaf.getViewState(), leaf.getEphemeralState()).then(() => leaf.detach());
    return this.rootSplit;
  }

  openPopoutLeaf(_data?: unknown): WorkspaceLeaf {
    return this.createLeafBySplit(this.getUnpinnedLeafOrActive(), "vertical");
  }

  getLeftLeaf(split: boolean): WorkspaceLeaf | null {
    return this.getSideLeaf(this.leftSplit, split);
  }

  getRightLeaf(split: boolean): WorkspaceLeaf | null {
    return this.getSideLeaf(this.rightSplit, split);
  }

  private getSideLeaf(dock: WorkspaceSidedock, split: boolean): WorkspaceLeaf {
    let tabs = dock.children.find((c): c is WorkspaceTabs => c instanceof WorkspaceTabs) ?? null;
    if (!tabs || split) {
      tabs = new WorkspaceTabs(this);
      dock.insertChild(dock.children.length, tabs);
    }
    const leaf = new WorkspaceLeaf(this.app);
    tabs.insertChild(tabs.children.length, leaf);
    return leaf;
  }

  async ensureSideLeaf(type: string, side: "left" | "right", options: { active?: boolean; split?: boolean; reveal?: boolean; state?: any } = {}): Promise<WorkspaceLeaf> {
    const existing = this.getLeavesOfType(type).find((l) => l.getRoot() === (side === "left" ? this.leftSplit : this.rightSplit));
    const leaf = existing ?? this.getSideLeaf(side === "left" ? this.leftSplit : this.rightSplit, !!options.split);
    if (!existing || options.state) await leaf.setViewState({ type, state: options.state, active: options.active });
    if (options.reveal !== false) await this.revealLeaf(leaf);
    if (options.active) this.setActiveLeaf(leaf, { focus: true });
    return leaf;
  }

  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    const root = leaf.getRoot();
    if (root instanceof WorkspaceSidedock && root.collapsed) root.expand();
    (leaf.parent as WorkspaceTabs)?.selectTab?.(leaf);
    await leaf.loadIfDeferred();
  }

  setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean } | boolean, focusArg?: boolean): void {
    const focus = typeof params === "object" ? !!params.focus : !!focusArg;
    if (!leaf.parent) return;
    // Focusing a leaf inside a collapsed sidebar opens that sidebar: a focused
    // view must be visible. Copilot opens its chat with
    // `getRightLeaf(false).setViewState({ type, active: true })` and no reveal.
    // Passive activation (focus: false, e.g. layout restore) leaves it closed.
    if (focus) {
      const root = leaf.getRoot();
      if (root instanceof WorkspaceSidedock && root.collapsed) root.expand();
    }
    const prev = this.activeLeaf;
    leaf.activeTime = Date.now();
    (leaf.parent as WorkspaceTabs)?.selectTab?.(leaf);
    if (prev !== leaf) {
      // A view's own key scope is active while its leaf is.
      const prevScope = (prev?.view as { scope?: unknown } | undefined)?.scope;
      if (prevScope) this.app.keymap.popScope(prevScope);
      const nextScope = (leaf.view as { scope?: unknown } | undefined)?.scope;
      if (nextScope) this.app.keymap.pushScope(nextScope);
      prev?.containerEl.removeClass("mod-active");
      prev?.tabHeaderEl.removeClass("mod-active");
      (prev?.parent as WorkspaceTabs | null)?.containerEl?.removeClass("mod-active");
      this.activeLeaf = leaf;
      leaf.containerEl.addClass("mod-active");
      leaf.tabHeaderEl.addClass("mod-active");
      const tabs = leaf.parent as WorkspaceTabs;
      tabs.containerEl.addClass("mod-active");
      this.activeTabGroup = tabs;
      const view = leaf.view as { file?: TFile | null; editor?: unknown } | undefined;
      if (view && "file" in view) {
        this.activeEditor = view.editor ? view : null;
        if (view.file) {
          this.lastActiveFile = view.file;
          this.touchRecent(view.file.path);
        }
      } else if (leaf.getRoot() === this.rootSplit) {
        this.activeEditor = null;
      }
      this.trigger("active-leaf-change", leaf);
      const prevFile = (prev?.view as { file?: TFile | null } | undefined)?.file ?? null;
      const nextFile = view && "file" in view ? (view.file ?? null) : null;
      if (prevFile !== nextFile && leaf.getRoot() === this.rootSplit) this.trigger("file-open", nextFile);
      this.requestSaveLayout();
    }
    if (focus) (leaf.view as { focus?: () => void } | undefined)?.focus?.();
  }

  // internal: called by FileView when it loads a file
  onFileOpenInLeaf(leaf: WorkspaceLeaf, file: TFile) {
    if (this.activeLeaf === leaf) {
      this.lastActiveFile = file;
      this.activeEditor = (leaf.view as { editor?: unknown }).editor ? leaf.view : null;
    } else if (
      leaf.getRoot() === this.rootSplit &&
      this.activeLeaf?.getRoot() !== this.rootSplit &&
      this.getMostRecentLeaf(this.rootSplit) === leaf
    ) {
      // A sidebar view (recent files, calendar, bookmarks …) opened a file in
      // the main area without activating it. That leaf still holds "the most
      // recently active file", so getActiveFile() and `file-open` follow it.
      const prev = this.lastActiveFile;
      this.lastActiveFile = file;
      this.activeEditor = (leaf.view as { editor?: unknown }).editor ? leaf.view : null;
      if (prev !== file) queueMicrotask(() => this.trigger("file-open", file));
    }
    this.touchRecent(file.path);
  }

  // internal: linked tabs follow the file of the leaf that changed
  syncGroup(source: WorkspaceLeaf) {
    const file = (source.view as { file?: TFile | null }).file;
    if (!file || !source.group) return;
    for (const other of this.getGroupLeaves(source.group)) {
      if (other === source) continue;
      const state = other.getViewState();
      if ((state.state as { file?: string } | undefined)?.file === file.path) continue;
      void other.setViewState({ ...state, state: { ...(state.state ?? {}), file: file.path } });
    }
  }

  private touchRecent(path: string) {
    this.recentFiles.remove(path);
    this.recentFiles.unshift(path);
    if (this.recentFiles.length > 50) this.recentFiles.length = 50;
  }

  getLastOpenFiles(): string[] {
    return this.recentFiles.slice(0, 10);
  }

  // internal
  onLeafDetached(leaf: WorkspaceLeaf) {
    const state = leaf.getViewState();
    if (state.type !== "empty") {
      this.undoHistory.push({ state, parentId: null, index: 0 });
      if (this.undoHistory.length > 20) this.undoHistory.shift();
    }
    if (this.activeLeaf === leaf) {
      this.activeLeaf = null;
      const next = this.getMostRecentLeaf(this.rootSplit);
      if (next) this.setActiveLeaf(next, { focus: true });
    }
    this.ensureRootLeaf();
    this.trigger("layout-change");
    this.requestSaveLayout();
  }

  // internal
  async undoCloseTab() {
    const entry = this.undoHistory.pop();
    if (!entry) return;
    const leaf = this.getLeaf("tab");
    await leaf.setViewState({ ...entry.state, active: true });
  }

  // internal
  onLayoutMutated() {
    if (this.layoutReady) this.requestSaveLayout();
  }

  // internal
  onSidedockToggled(dock: WorkspaceSidedock) {
    this.containerEl.toggleClass(`is-${dock.side}-sidedock-open`, !dock.collapsed);
    const ribbon = dock.side === "left" ? this.leftRibbon : this.rightRibbon;
    ribbon.containerEl.toggleClass("is-collapsed", dock.collapsed);
    this.app.mobile?.onDockToggled?.(dock);
    this.trigger("resize");
    this.requestSaveLayout();
  }

  // internal
  saveRibbonConfig(ribbon: WorkspaceRibbon) {
    this.ribbonConfig = ribbon.serialize();
    this.requestSaveLayout();
  }

  // ---- opening links ------------------------------------------------------------

  async openLinkText(linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, openViewState: OpenViewState = {}): Promise<void> {
    const { path, subpath } = parseLinktext(linktext);
    let file: TFile | null = path === "" ? this.app.vault.getFileByPath(sourcePath) : this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    if (!file) {
      // Clicking an unresolved link creates the note, as Obsidian does.
      const target = path.endsWith(".md") ? path : `${path}.md`;
      const hasFolder = target.includes("/");
      const folder = hasFolder ? null : this.app.fileManager.getNewFileParent(sourcePath);
      const fullPath = normalizePath(hasFolder ? target : folder.isRoot() ? target : `${folder.path}/${target}`);
      try {
        if (hasFolder) {
          const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
          if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
        }
        file = await this.app.vault.create(fullPath, "");
      } catch (e) {
        console.error(e);
        return;
      }
    }
    const leaf = this.getLeaf(newLeaf);
    await leaf.openFile(file!, { active: true, ...openViewState, eState: { ...(openViewState.eState ?? {}), ...(subpath ? { subpath } : {}) } });
  }

  // internal
  async openFile(file: TFile, newLeaf?: PaneType | boolean) {
    await this.getLeaf(newLeaf).openFile(file, { active: true });
  }

  // internal (used by plugins: tag-wrangler, kanban)
  registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }) {
    this.hoverLinkSources[id] = info;
  }

  // internal
  unregisterHoverLinkSource(id: string) {
    delete this.hoverLinkSources[id];
  }

  // internal: extensions from Plugin.registerEditorExtension
  editorExtensions: unknown[] = [];

  // internal
  registerEditorExtension(extension: unknown) {
    this.editorExtensions.push(extension);
    this.updateOptions();
  }

  // internal
  unregisterEditorExtension(extension: unknown) {
    this.editorExtensions.remove(extension);
    this.updateOptions();
  }

  updateOptions(): void {
    this.iterateAllLeaves((leaf) => (leaf.view as { updateOptions?: () => void } | undefined)?.updateOptions?.());
    this.trigger("options-change");
  }

  handleLinkContextMenu(menu: Menu, linktext: string, sourcePath: string, leaf?: WorkspaceLeaf): boolean {
    const file = this.app.metadataCache.getFirstLinkpathDest(parseLinktext(linktext).path, sourcePath);
    menu.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => this.openLinkText(linktext, sourcePath, "tab")));
    menu.addItem((i) => i.setSection("open").setTitle("Open to the right").setIcon("lucide-separator-vertical").onClick(() => this.openLinkText(linktext, sourcePath, "split")));
    if (file) this.trigger("file-menu", menu, file, "link-context-menu", leaf);
    return true;
  }

  // ---- tab drag and drop ------------------------------------------------------------

  private draggingLeaf: WorkspaceLeaf | null = null;

  // internal
  onTabDragStart(evt: DragEvent, leaf: WorkspaceLeaf) {
    this.draggingLeaf = leaf;
    evt.dataTransfer?.setData("text/plain", leaf.getDisplayText());
    if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
    document.body.addClass("is-dragging");
    const end = () => {
      document.body.removeClass("is-dragging");
      this.draggingLeaf = null;
      this.hideDropOverlay();
      window.removeEventListener("dragend", end);
    };
    window.addEventListener("dragend", end);
  }

  // internal
  onTabDragOver(evt: DragEvent, tabs: WorkspaceTabs) {
    if (!this.draggingLeaf) return;
    evt.preventDefault();
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
    tabs.tabHeaderContainerEl.addClass("is-drop-target");
    const clear = () => tabs.tabHeaderContainerEl.removeClass("is-drop-target");
    tabs.tabHeaderContainerEl.addEventListener("dragleave", clear, { once: true });
  }

  // internal
  onTabDrop(evt: DragEvent, tabs: WorkspaceTabs) {
    const leaf = this.draggingLeaf;
    tabs.tabHeaderContainerEl.removeClass("is-drop-target");
    if (!leaf) return;
    evt.preventDefault();
    const headers = Array.from(tabs.tabHeaderContainerInnerEl.children) as HTMLElement[];
    let index = headers.length;
    for (let i = 0; i < headers.length; i++) {
      const r = headers[i]!.getBoundingClientRect();
      if (evt.clientX < r.left + r.width / 2) {
        index = i;
        break;
      }
    }
    const from = leaf.parent as WorkspaceTabs;
    if (from === tabs && tabs.children.indexOf(leaf) < index) index--;
    from.removeChild(leaf);
    tabs.insertChild(index, leaf);
    this.setActiveLeaf(leaf, { focus: true });
    this.draggingLeaf = null;
  }

  private dropOverlayEl: HTMLElement | null = null;
  private dropTarget: { tabs: WorkspaceTabs; zone: DropZone } | null = null;

  private tabsForElement(el: Element | null): WorkspaceTabs | null {
    const tabsEl = el?.closest(".workspace-tabs");
    if (!tabsEl) return null;
    let found: WorkspaceTabs | null = null;
    const walk = (p: WorkspaceParent) => {
      for (const c of p.children) {
        if (found) return;
        if (c instanceof WorkspaceTabs && c.containerEl === tabsEl) found = c;
        else if (c instanceof WorkspaceParent) walk(c);
      }
    };
    for (const root of [this.rootSplit, this.leftSplit, this.rightSplit]) walk(root);
    return found;
  }

  private onPaneDragOver(evt: DragEvent) {
    const leaf = this.draggingLeaf;
    if (!leaf) return;
    const target = evt.target instanceof Element ? evt.target : null;
    // The tab bar handles its own drops (reordering).
    if (!target || target.closest(".workspace-tab-header-container")) return this.hideDropOverlay();
    const tabs = this.tabsForElement(target);
    if (!tabs) return this.hideDropOverlay();
    const r = tabs.tabsContainerEl.getBoundingClientRect();
    if (!r.width || !r.height) return this.hideDropOverlay();
    const x = (evt.clientX - r.left) / r.width;
    const y = (evt.clientY - r.top) / r.height;
    const inDock = tabs.getRoot() !== this.rootSplit;
    const edges: [DropZone, number][] = inDock
      ? [["top", y], ["bottom", 1 - y]]
      : [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]];
    let zone: DropZone = "center";
    let best = 0.25;
    for (const [z, d] of edges) {
      if (d < best) {
        best = d;
        zone = z;
      }
    }
    if (this.isSinglePane()) zone = "center";
    const from = leaf.parent as WorkspaceTabs | null;
    const noop = zone === "center" ? from === tabs : from === tabs && tabs.children.length === 1;
    if (noop) return this.hideDropOverlay();
    evt.preventDefault();
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
    this.dropTarget = { tabs, zone };
    const el = (this.dropOverlayEl ??= createDiv({ cls: "workspace-drop-overlay" }));
    if (!el.isConnected) document.body.appendChild(el);
    const box = { left: r.left, top: r.top, width: r.width, height: r.height };
    if (zone === "left" || zone === "right") box.width = r.width / 2;
    if (zone === "right") box.left = r.left + r.width / 2;
    if (zone === "top" || zone === "bottom") box.height = r.height / 2;
    if (zone === "bottom") box.top = r.top + r.height / 2;
    el.dataset.zone = zone;
    Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  }

  private hideDropOverlay() {
    this.dropTarget = null;
    this.dropOverlayEl?.detach();
  }

  private onPaneDrop(evt: DragEvent) {
    const leaf = this.draggingLeaf;
    const target = this.dropTarget;
    this.hideDropOverlay();
    if (!leaf || !target) return;
    evt.preventDefault();
    const from = leaf.parent as WorkspaceTabs;
    if (target.zone === "center") {
      from.removeChild(leaf);
      target.tabs.insertChild(target.tabs.children.length, leaf);
    } else {
      const direction: SplitDirection = target.zone === "left" || target.zone === "right" ? "vertical" : "horizontal";
      const newTabs = this.insertTabsBeside(target.tabs, direction, target.zone === "left" || target.zone === "top");
      from.removeChild(leaf);
      newTabs.insertChild(0, leaf);
    }
    this.draggingLeaf = null;
    document.body.removeClass("is-dragging");
    this.setActiveLeaf(leaf, { focus: true });
    this.trigger("layout-change");
    this.requestSaveLayout();
  }

  // internal: build the leaf for a newly serialised state (used by workspaces plugin)
  static serializeState(items: SerializedItem) {
    return items;
  }
}
