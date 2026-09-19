/**
 * WorkspaceLeaf — one tab: a view, its tab header, and its navigation history.
 */
import type { OpenViewState, ViewState } from "obsidian";
import { setIcon } from "../ui/icons";
import { Menu } from "../ui/menu";
import type { TFile } from "../vault/files";
import { WorkspaceItem, type SerializedItem } from "./base";
import type { View } from "./view";

interface HistoryEntry {
  state: ViewState;
  eState: unknown;
  title: string;
  icon: string;
}

export class LeafHistory {
  backHistory: HistoryEntry[] = [];
  forwardHistory: HistoryEntry[] = [];
  constructor(private leaf: WorkspaceLeaf) {}

  push(entry: HistoryEntry) {
    this.backHistory.push(entry);
    if (this.backHistory.length > 50) this.backHistory.shift();
    this.forwardHistory = [];
    this.leaf.updateNav();
  }

  async back() {
    const entry = this.backHistory.pop();
    if (!entry) return;
    this.forwardHistory.push(this.leaf.snapshot());
    await this.leaf.setViewState(entry.state, entry.eState, false);
    this.leaf.updateNav();
  }

  async forward() {
    const entry = this.forwardHistory.pop();
    if (!entry) return;
    this.backHistory.push(this.leaf.snapshot());
    await this.leaf.setViewState(entry.state, entry.eState, false);
    this.leaf.updateNav();
  }

  serialize() {
    return { backHistory: this.backHistory, forwardHistory: this.forwardHistory };
  }
}

/**
 * A stand-in view for a leaf whose real view does not exist yet — a tab being
 * created, or a restored tab not yet shown. Every leaf always has a `view`,
 * because plugins iterate leaves at arbitrary moments (inside an editor
 * extension's constructor, for one) and call methods on it.
 */
function placeholderView(leaf: WorkspaceLeaf, type: string, title: string, icon: string, state?: ViewState): View {
  const containerEl = createDiv({ cls: "workspace-leaf-content" });
  return {
    app: leaf.app,
    leaf,
    containerEl,
    icon,
    navigation: false,
    getViewType: () => type,
    getState: () => state?.state ?? {},
    setState: async () => {},
    getEphemeralState: () => ({}),
    setEphemeralState: () => {},
    getDisplayText: () => title,
    getIcon: () => icon,
    onResize: () => {},
    onPaneMenu: () => {},
    close: async () => containerEl.detach(),
    isPlaceholder: true,
    state,
  } as unknown as View;
}

/**
 * A tab menu is filled by the leaf, the view's pane menu and `file-menu`
 * handlers; the same action can arrive from two of them ("Close", "Export to
 * PDF…"). Keep the first of each title.
 */
function dedupeMenuItems(menu: Menu) {
  const seen = new Set<string>();
  menu.items = menu.items.filter((item) => {
    const title = (item as { titleEl?: HTMLElement }).titleEl?.textContent;
    if (!title) return true;
    const key = title.trim().replace(/…$/, "...").toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class WorkspaceLeaf extends WorkspaceItem {
  parent: any = null;
  view!: View;
  hoverPopover: any = null;
  // internal (used by plugins: iconize, tab decorations)
  tabHeaderEl: HTMLElement;
  tabHeaderInnerIconEl: HTMLElement;
  tabHeaderInnerTitleEl: HTMLElement;
  tabHeaderCloseEl: HTMLElement;
  tabHeaderStatusContainerEl: HTMLElement;
  // internal
  pinned = false;
  group: string | null = null;
  working = false;
  activeTime = 0;
  history: LeafHistory;
  private deferredState: { state: ViewState; eState?: unknown } | null = null;

  constructor(app: any) {
    super();
    this.app = app;
    this.workspace = app.workspace;
    this.history = new LeafHistory(this);
    this.view = placeholderView(this, "empty", "New tab", "lucide-file");
    this.containerEl = createDiv({ cls: "workspace-leaf" });
    this.resizeHandleEl = this.containerEl.createEl("hr", { cls: "workspace-leaf-resize-handle" });

    this.tabHeaderEl = createDiv({ cls: "workspace-tab-header tappable", attr: { draggable: "true" } });
    const inner = this.tabHeaderEl.createDiv({ cls: "workspace-tab-header-inner" });
    this.tabHeaderInnerIconEl = inner.createDiv({ cls: "workspace-tab-header-inner-icon" });
    this.tabHeaderInnerTitleEl = inner.createDiv({ cls: "workspace-tab-header-inner-title" });
    this.tabHeaderStatusContainerEl = inner.createDiv({ cls: "workspace-tab-header-status-container" });
    this.tabHeaderCloseEl = inner.createDiv({ cls: "workspace-tab-header-inner-close-button", attr: { "aria-label": "Close" } });
    setIcon(this.tabHeaderCloseEl, "lucide-x");

    this.tabHeaderEl.addEventListener("mousedown", (evt) => {
      if (evt.button === 1) evt.preventDefault();
    });
    this.tabHeaderEl.addEventListener("auxclick", (evt) => {
      if (evt.button === 1) this.detach();
    });
    this.tabHeaderEl.addEventListener("click", (evt) => {
      if ((evt.target as HTMLElement).closest(".workspace-tab-header-inner-close-button")) {
        evt.stopPropagation();
        this.detach();
        return;
      }
      this.parent?.selectTab?.(this);
      this.workspace.setActiveLeaf(this, { focus: true });
    });
    this.tabHeaderEl.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      this.onTabMenu(menu);
      menu.showAtMouseEvent(evt);
    });
    this.tabHeaderEl.addEventListener("dragstart", (evt) => this.workspace.onTabDragStart?.(evt, this));
    this.containerEl.addEventListener("mousedown", () => {
      if (this.workspace.activeLeaf !== this) this.workspace.setActiveLeaf(this, { focus: false });
    }, true);
  }

  // internal (used by plugins: tab context menus)
  onTabMenu(menu: Menu) {
    const siblings = (): WorkspaceLeaf[] => (this.parent?.children ?? []).slice();
    menu.addItem((i) => i.setSection("close").setTitle("Close").setIcon("lucide-x").onClick(() => this.detach()));
    menu.addItem((i) =>
      i.setSection("close").setTitle("Close others").setIcon("lucide-x-circle").onClick(() => {
        for (const leaf of siblings()) if (leaf !== this && !leaf.pinned) leaf.detach();
      }),
    );
    menu.addItem((i) =>
      i.setSection("close").setTitle("Close tabs to the right").setIcon("lucide-arrow-right-to-line").onClick(() => {
        const all = siblings();
        for (const leaf of all.slice(all.indexOf(this) + 1)) if (!leaf.pinned) leaf.detach();
      }),
    );
    menu.addItem((i) =>
      i.setSection("close").setTitle("Close all").setIcon("lucide-copy-x").onClick(() => {
        for (const leaf of siblings()) if (!leaf.pinned) leaf.detach();
      }),
    );
    menu.addItem((i) => i.setSection("pin").setTitle(this.pinned ? "Unpin" : "Pin").setIcon(this.pinned ? "lucide-pin-off" : "lucide-pin").onClick(() => this.togglePinned()));
    // A phone shows one pane, so splitting from a tab is not offered there.
    if (!this.workspace.isSinglePane?.()) {
      menu.addItem((i) => i.setSection("split").setTitle("Split right").setIcon("lucide-separator-vertical").onClick(() => this.workspace.duplicateLeaf(this, "split", "vertical")));
      menu.addItem((i) => i.setSection("split").setTitle("Split down").setIcon("lucide-separator-horizontal").onClick(() => this.workspace.duplicateLeaf(this, "split", "horizontal")));
      menu.addItem((i) => i.setSection("window").setTitle("Open in new window").setIcon("lucide-picture-in-picture-2").onClick(() => this.workspace.duplicateLeaf(this, "window")));
    }
    this.view?.onTabMenu?.(menu);
    dedupeMenuItems(menu);
  }

  get isDeferred(): boolean {
    return this.deferredState !== null;
  }

  async loadIfDeferred(): Promise<void> {
    const d = this.deferredState;
    if (!d) return;
    this.deferredState = null;
    // A restored cursor and scroll position must not pull focus (on a phone,
    // focusing the editor raises the keyboard).
    const eState = d.eState && typeof d.eState === "object" ? { ...(d.eState as Record<string, unknown>), focus: false } : d.eState;
    await this.setViewState(d.state, eState, false);
  }

  // internal: restore a tab without instantiating its view
  setDeferredState(state: ViewState, title: string, icon: string, eState?: unknown) {
    this.deferredState = { state, eState };
    // Plugins iterate leaves and call `leaf.view.getViewType()` on tabs that
    // have not loaded; Obsidian gives those a placeholder view, and so do we.
    this.view = placeholderView(this, "deferred", title, icon, state);
    this.tabHeaderInnerTitleEl.setText(title);
    setIcon(this.tabHeaderInnerIconEl, icon || "lucide-file");
    this.tabHeaderEl.setAttr("aria-label", title);
  }

  // internal
  snapshot(): HistoryEntry {
    return { state: this.getViewState(), eState: this.getEphemeralState(), title: this.getDisplayText(), icon: this.getIcon() };
  }

  async openFile(file: TFile, openState: OpenViewState = {}): Promise<void> {
    const type = this.app.viewRegistry.getTypeByExtension(file.extension) ?? (file.extension === "md" ? "markdown" : null);
    if (!type) {
      const { Notice } = await import("../ui/notice");
      new Notice(`No view is registered for “.${file.extension}” files.`);
      return;
    }
    const state: ViewState = {
      type,
      state: { ...(openState.state ?? {}), file: file.path },
      active: openState.active,
      group: openState.group,
    };
    await this.setViewState(state, openState.eState);
  }

  async open(view: View): Promise<View> {
    await this.replaceView(view);
    return view;
  }

  private async replaceView(view: View) {
    const old = this.view;
    if (old) await old.close();
    this.view = view;
    await view.open(this.containerEl);
    this.updateHeader();
  }

  getViewState(): ViewState {
    if (this.deferredState) return { ...this.deferredState.state, pinned: this.pinned || undefined };
    return {
      type: this.view ? this.view.getViewType() : "empty",
      state: this.view ? this.view.getState() : {},
      pinned: this.pinned || undefined,
      active: this.workspace.activeLeaf === this || undefined,
    };
  }

  async setViewState(viewState: ViewState, eState?: unknown, pushHistory = true): Promise<void> {
    this.deferredState = null;
    const placeholder = !!(this.view as { isPlaceholder?: boolean } | undefined)?.isPlaceholder;
    const prevEntry = this.view && !placeholder ? this.snapshot() : null;
    const prevFile = (this.view as { file?: TFile | null } | undefined)?.file ?? null;

    this.working = true;
    try {
      if (!this.view || placeholder || this.view.getViewType() !== viewState.type) {
        const creator = this.app.viewRegistry.getViewCreatorByType(viewState.type);
        const view: View = creator ? creator(this) : this.app.viewRegistry.createEmptyView(this);
        await this.replaceView(view);
      }
      const result = { history: false };
      await this.view.setState(viewState.state ?? {}, result);
      if (pushHistory && result.history && prevEntry && prevEntry.state.type !== "empty") this.history.push(prevEntry);
      if (viewState.pinned !== undefined) this.setPinned(!!viewState.pinned);
      if (viewState.group) this.setGroupMember(viewState.group as unknown as WorkspaceLeaf);
    } finally {
      this.working = false;
    }
    this.updateHeader();
    if (viewState.active) this.workspace.setActiveLeaf(this, { focus: true });
    // After activation: activating focuses the editor, and an ephemeral state
    // may want focus elsewhere (a selected inline title after "New note").
    if (eState) this.view.setEphemeralState(eState);
    const file = (this.view as { file?: TFile | null }).file ?? null;
    if (file !== prevFile && this.workspace.activeLeaf === this) this.workspace.trigger("file-open", file);
    if (file && this.group) this.workspace.syncGroup?.(this);
    this.workspace.trigger("layout-change");
    this.workspace.requestSaveLayout();
  }

  getEphemeralState(): any {
    return this.view ? this.view.getEphemeralState() : {};
  }

  setEphemeralState(state: any): void {
    this.view?.setEphemeralState(state);
  }

  togglePinned(): void {
    this.setPinned(!this.pinned);
  }

  setPinned(pinned: boolean): void {
    if (this.pinned === pinned) return;
    this.pinned = pinned;
    this.containerEl.toggleClass("is-pinned", pinned);
    this.tabHeaderEl.toggleClass("is-pinned", pinned);
    this.updateHeader();
    this.trigger("pinned-change", pinned);
    this.workspace.requestSaveLayout();
  }

  setGroupMember(other: WorkspaceLeaf): void {
    const group = other.group ?? other.id;
    other.setGroup(group);
    this.setGroup(group);
  }

  setGroup(group: string | null): void {
    this.group = group;
    this.tabHeaderEl.toggleClass("has-group", !!group);
    this.trigger("group-change", group);
    this.workspace.requestSaveLayout();
  }

  detach(): void {
    const parent = this.parent;
    void this.view?.close();
    this.containerEl.detach();
    this.tabHeaderEl.detach();
    if (parent) parent.removeChild(this);
    this.parent = null;
    this.workspace.onLeafDetached?.(this);
  }

  getIcon(): string {
    if (this.deferredState) return this.tabHeaderInnerIconEl.dataset.icon ?? "lucide-file";
    return this.view?.getIcon() || "lucide-file";
  }

  getDisplayText(): string {
    if (this.deferredState) return this.tabHeaderInnerTitleEl.getText();
    return this.view?.getDisplayText() ?? "";
  }

  override onResize(): void {
    this.view?.onResize();
  }

  // internal
  updateHeader() {
    const title = this.getDisplayText();
    this.tabHeaderInnerTitleEl.setText(title);
    this.tabHeaderEl.setAttr("aria-label", title);
    this.tabHeaderEl.setAttr("data-type", this.view?.getViewType() ?? "empty");
    const icon = this.getIcon();
    this.tabHeaderInnerIconEl.dataset.icon = icon;
    setIcon(this.tabHeaderInnerIconEl, icon);
    this.tabHeaderStatusContainerEl.empty();
    if (this.pinned) {
      const pin = this.tabHeaderStatusContainerEl.createDiv({ cls: "mod-pinned clickable-icon", attr: { "aria-label": "Unpin" } });
      setIcon(pin, "lucide-pin");
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setPinned(false);
      });
    }
    if (this.group) {
      const link = this.tabHeaderStatusContainerEl.createDiv({ cls: "mod-linked clickable-icon", attr: { "aria-label": "Linked" } });
      setIcon(link, "lucide-link");
    }
    this.updateNav();
  }

  // internal
  updateNav() {
    (this.view as { updateNavButtons?: () => void } | undefined)?.updateNavButtons?.();
  }

  // internal
  setDimensionSize(size: number) {
    this.setDimension(size);
  }

  /**
   * internal: the view's ephemeral state (cursor, scroll) as plain JSON, so
   * `workspace.json` can restore it after a reload. A tab that has not loaded
   * yet keeps the state it was restored with.
   */
  serializeEphemeralState(): Record<string, unknown> | undefined {
    let raw: unknown;
    if (this.deferredState) raw = this.deferredState.eState;
    else if ((this.view as { isPlaceholder?: boolean } | undefined)?.isPlaceholder) return undefined;
    else {
      try {
        raw = this.view?.getEphemeralState();
      } catch {
        return undefined;
      }
    }
    if (!raw || typeof raw !== "object") return undefined;
    try {
      const plain = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
      // One-shot instructions, not state.
      for (const k of ["focus", "rename", "match", "subpath", "line"]) delete plain[k];
      return Object.keys(plain).length ? plain : undefined;
    } catch {
      return undefined;
    }
  }

  serialize(): SerializedItem {
    const state = this.getViewState();
    const eState = this.serializeEphemeralState();
    return {
      id: this.id,
      type: "leaf",
      state: { type: state.type, state: state.state ?? {}, icon: this.getIcon(), title: this.getDisplayText(), ...(eState ? { eState } : {}) },
      ...(this.pinned ? { pinned: true } : {}),
      ...(this.group ? { group: this.group } : {}),
      ...(this.dimension !== null ? { dimension: this.dimension } : {}),
    };
  }
}
