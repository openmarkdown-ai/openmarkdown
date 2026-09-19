/**
 * Backlinks (`backlink`): the Backlinks view, backlinks at the bottom of
 * notes, and the "N backlinks" status bar item.
 *
 * Linked mentions come from `metadataCache.index.backlinks(path)`; unlinked
 * mentions (the note's name or any alias as plain text) from
 * `index.unlinkedMentions(path)`, computed only while that section is open.
 * "Link" turns a mention into a link at its exact UTF-16 offsets.
 *
 * View state (Obsidian's keys): file, collapseAll, extraContext, sortOrder,
 * showSearch, searchQuery, backlinkCollapsed, unlinkedCollapsed.
 */
import type { ViewStateResult } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Component } from "../../obsidian/events";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { debounce, parseFrontMatterAliases } from "../../obsidian/util";
import { TFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ensureKnowledgeIcons, FileInfoView, FilterBox, NavHeader, openLinkedView, setButtonState, showSideView, showSortMenu } from "../global-search/common";
import { getBacklinks, getUnlinkedMentions, runSearch, SORT_LABELS, type Range, type SortOrder } from "../global-search/engine";
import { SearchResultDOM, snippetsFromHits, type ResultData, type SearchResultItemDOM } from "../global-search/result-dom";

export const VIEW_TYPE_BACKLINK = "backlink";
const IN_DOC_KEY = "backlink-in-document";

export interface BacklinkState {
  collapseAll: boolean;
  extraContext: boolean;
  sortOrder: SortOrder;
  showSearch: boolean;
  searchQuery: string;
  backlinkCollapsed: boolean;
  unlinkedCollapsed: boolean;
}

const DEFAULT_STATE: BacklinkState = {
  collapseAll: false,
  extraContext: false,
  sortOrder: "alphabetical",
  showSearch: false,
  searchQuery: "",
  backlinkCollapsed: false,
  unlinkedCollapsed: true,
};

/** Converts an unlinked mention of `target` in `source` at `range` into a link. */
export async function linkMention(app: any, target: TFile, source: TFile, range: Range): Promise<boolean> {
  const names = [target.basename, ...(parseFrontMatterAliases(app.metadataCache.getFileCache(target)?.frontmatter ?? null) ?? [])];
  let ok = false;
  await app.vault.process(source, (text: string) => {
    const matched = text.slice(range[0], range[1]);
    const name = names.find((n) => n.toLowerCase() === matched.toLowerCase());
    if (!name) return text;
    ok = true;
    const alias = matched === target.basename ? undefined : matched;
    const link = app.fileManager.generateMarkdownLink(target, source.path, undefined, alias);
    return text.slice(0, range[0]) + link + text.slice(range[1]);
  });
  if (!ok) new Notice("The mention has changed since it was found. Try again.");
  return ok;
}

/** The two collapsible sections and their result trees. Used by the view and in-document backlinks. */
export class BacklinkComponent extends Component {
  app: any;
  file: TFile | null = null;
  state: BacklinkState;
  el: HTMLElement;
  headerDom: NavHeader;
  filter: FilterBox;
  backlinkDom: SearchResultDOM;
  unlinkedDom: SearchResultDOM;
  backlinkHeaderEl: HTMLElement;
  unlinkedHeaderEl: HTMLElement;
  backlinkCountEl: HTMLElement;
  unlinkedCountEl: HTMLElement;
  hoverParent: { hoverPopover: any };
  private buttons: Record<string, HTMLElement> = {};
  private requestUpdate = debounce(() => this.recomputeBacklink(), 300, true);
  onStateChange: (() => void) | null = null;

  constructor(app: any, parentEl: HTMLElement, hoverParent: { hoverPopover: any }, state?: Partial<BacklinkState>) {
    super();
    this.app = app;
    this.hoverParent = hoverParent;
    this.state = { ...DEFAULT_STATE, ...(state ?? {}) };
    this.headerDom = new NavHeader(parentEl, false);
    this.buttons.collapse = this.headerDom.addButton("lucide-list-collapse", "Collapse results", () => this.setState({ collapseAll: !this.state.collapseAll }));
    this.buttons.context = this.headerDom.addButton("lucide-move-vertical", "Show more context", () => this.setState({ extraContext: !this.state.extraContext }));
    this.buttons.sort = this.headerDom.addButton("lucide-arrow-up-narrow-wide", "Change sort order", (evt) =>
      showSortMenu(evt, SORT_LABELS, this.state.sortOrder, (v) => this.setState({ sortOrder: v })),
    );
    this.buttons.search = this.headerDom.addButton("lucide-search", "Show search filter", () => {
      this.setState({ showSearch: !this.state.showSearch });
      if (this.state.showSearch) this.filter.component.inputEl.focus();
    });
    this.filter = new FilterBox(parentEl, "Search...", (v) => this.setState({ searchQuery: v }));

    this.el = parentEl.createDiv({ cls: "backlink-pane" });
    const section = (title: string, key: "backlinkCollapsed" | "unlinkedCollapsed") => {
      const self = this.el.createDiv({ cls: "tree-item-self is-clickable" });
      const icon = self.createDiv({ cls: "tree-item-icon collapse-icon" });
      setIcon(icon, "right-triangle");
      self.createDiv({ cls: "tree-item-inner", text: title });
      const count = self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair" });
      self.addEventListener("click", () => this.setState({ [key]: !this.state[key] } as Partial<BacklinkState>));
      return { self, count };
    };
    const linked = section("Linked mentions", "backlinkCollapsed");
    this.backlinkHeaderEl = linked.self;
    this.backlinkCountEl = linked.count;
    this.backlinkDom = new SearchResultDOM({ app, hoverSource: "search", hoverParent, emptyStateText: "No backlinks found.", menuSource: "backlinks" }, this.el);
    const unlinked = section("Unlinked mentions", "unlinkedCollapsed");
    this.unlinkedHeaderEl = unlinked.self;
    this.unlinkedCountEl = unlinked.count;
    this.unlinkedDom = new SearchResultDOM(
      {
        app,
        hoverSource: "search",
        hoverParent,
        emptyStateText: "No unlinked mentions found.",
        mergeMatches: false,
        menuSource: "backlinks",
        linkButton: (item, range) => void this.link(item, range),
      },
      this.el,
    );
    this.applyState();
  }

  override onload(): void {
    const update = () => this.requestUpdate();
    this.registerEvent(this.app.metadataCache.on("resolved", update));
    this.registerEvent(this.app.metadataCache.on("changed", update));
    this.registerEvent(this.app.metadataCache.on("deleted", update));
    this.registerEvent(this.app.vault.on("rename", update));
  }

  override onunload(): void {
    this.backlinkDom.destroy();
    this.unlinkedDom.destroy();
  }

  setFile(file: TFile | null) {
    if (file === this.file) return;
    this.file = file;
    this.backlinkDom.emptyResults();
    this.unlinkedDom.emptyResults();
    this.recomputeBacklink();
  }

  setState(partial: Partial<BacklinkState>) {
    const prev = this.state;
    this.state = { ...prev, ...partial };
    this.applyState();
    if (partial.searchQuery !== undefined && partial.searchQuery !== prev.searchQuery) this.recomputeBacklink();
    if (partial.showSearch === false && prev.searchQuery) {
      this.state.searchQuery = "";
      this.filter.component.setValue("");
      this.recomputeBacklink();
    }
    if (partial.unlinkedCollapsed === false && prev.unlinkedCollapsed) this.recomputeUnlinked();
    this.onStateChange?.();
  }

  private applyState() {
    const s = this.state;
    setButtonState(this.buttons.collapse!, s.collapseAll, s.collapseAll ? "lucide-list-tree" : "lucide-list-collapse", s.collapseAll ? "Expand results" : "Collapse results");
    setButtonState(this.buttons.context!, s.extraContext);
    setButtonState(this.buttons.search!, s.showSearch);
    this.filter.show(s.showSearch);
    if (this.filter.component.getValue() !== s.searchQuery) this.filter.component.setValue(s.searchQuery);
    for (const dom of [this.backlinkDom, this.unlinkedDom]) {
      dom.setCollapseAll(s.collapseAll);
      dom.setExtraContext(s.extraContext);
      if (dom.sortOrder !== s.sortOrder) dom.setSortOrder(s.sortOrder);
    }
    const fold = (header: HTMLElement, dom: SearchResultDOM, collapsed: boolean) => {
      header.toggleClass("is-collapsed", collapsed);
      header.querySelector(".collapse-icon")?.toggleClass("is-collapsed", collapsed);
      dom.el.toggle(!collapsed);
    };
    fold(this.backlinkHeaderEl, this.backlinkDom, s.backlinkCollapsed);
    fold(this.unlinkedHeaderEl, this.unlinkedDom, s.unlinkedCollapsed);
  }

  private filterPaths(): Set<string> | null {
    const q = this.state.searchQuery.trim();
    if (!q) return null;
    const run = runSearch(this.app, q, {});
    return new Set(run.files.map((f) => f.path));
  }

  /** Recomputes linked mentions (and unlinked, if open). */
  recomputeBacklink() {
    const file = this.file;
    if (!file) {
      this.backlinkDom.emptyResults();
      this.unlinkedDom.emptyResults();
      this.backlinkCountEl.setText("0");
      this.unlinkedCountEl.setText("");
      return;
    }
    const allowed = this.filterPaths();
    const groups = getBacklinks(this.app, file.path);
    const seen = new Set<TFile>();
    let count = 0;
    for (const g of groups) {
      if (allowed && !allowed.has(g.source)) continue;
      const source = this.app.vault.getFileByPath(g.source);
      if (!(source instanceof TFile)) continue;
      const data: ResultData = { content: [], rows: [] };
      const bodyRefs = g.refs.filter((r) => r.kind !== "frontmatter" && r.start >= 0);
      data.snippets = snippetsFromHits(bodyRefs);
      for (const r of g.refs) {
        if (r.kind === "frontmatter" || r.start < 0) data.rows!.push({ text: `${r.key ?? "property"}: ${r.original}`, matches: [[`${r.key ?? "property"}: `.length, `${r.key ?? "property"}: `.length + r.original.length]], line: 0 });
        else data.content.push([r.start, r.end]);
      }
      seen.add(source);
      count += g.refs.length;
      const existing = this.backlinkDom.resultDomLookup.get(source);
      if (existing && JSON.stringify(existing.result) === JSON.stringify(data) && (existing as any).__mtime === source.stat.mtime) continue;
      const item = this.backlinkDom.addResult(source, data, null);
      (item as any).__mtime = source.stat.mtime;
    }
    for (const f of Array.from(this.backlinkDom.resultDomLookup.keys())) if (!seen.has(f)) this.backlinkDom.removeResult(f);
    this.backlinkCountEl.setText(String(seen.size));
    this.backlinkCount = count;
    if (!this.state.unlinkedCollapsed) this.recomputeUnlinked();
    else this.unlinkedCountEl.setText("");
    this.onCountChange?.(count);
  }

  backlinkCount = 0;
  onCountChange: ((n: number) => void) | null = null;

  recomputeUnlinked() {
    const file = this.file;
    if (!file) return;
    const allowed = this.filterPaths();
    const groups = getUnlinkedMentions(this.app, file.path);
    const seen = new Set<TFile>();
    for (const g of groups) {
      if (allowed && !allowed.has(g.source)) continue;
      const source = this.app.vault.getFileByPath(g.source);
      if (!(source instanceof TFile) || source === file) continue;
      const data: ResultData = { content: g.matches.map((m) => [m.start, m.end] as Range), snippets: snippetsFromHits(g.matches) };
      seen.add(source);
      const existing = this.unlinkedDom.resultDomLookup.get(source);
      if (existing && JSON.stringify(existing.result) === JSON.stringify(data) && (existing as any).__mtime === source.stat.mtime) continue;
      const item = this.unlinkedDom.addResult(source, data, null);
      (item as any).__mtime = source.stat.mtime;
    }
    for (const f of Array.from(this.unlinkedDom.resultDomLookup.keys())) if (!seen.has(f)) this.unlinkedDom.removeResult(f);
    this.unlinkedCountEl.setText(String(seen.size));
  }

  private async link(item: SearchResultItemDOM, range: Range) {
    if (!this.file) return;
    await linkMention(this.app, this.file, item.file, range);
  }
}

export class BacklinkView extends FileInfoView {
  plugin: BacklinkPlugin;
  backlink!: BacklinkComponent;
  hoverPopover: any = null;
  private pendingState: Partial<BacklinkState> = {};

  constructor(leaf: WorkspaceLeaf, plugin: BacklinkPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.icon = "links-coming-in";
  }

  getViewType() {
    return VIEW_TYPE_BACKLINK;
  }

  getDisplayText() {
    return this.file ? `Backlinks for ${this.file.basename}` : "Backlinks";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.backlink = new BacklinkComponent(this.app, this.contentEl, this, this.pendingState);
    this.backlink.onStateChange = () => this.app.workspace.requestSaveLayout();
    this.addChild(this.backlink);
    await super.onOpen();
    this.backlink.setFile(this.file);
  }

  onFileChanged(): void {
    this.backlink?.setFile(this.file);
  }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), ...(this.backlink?.state ?? this.pendingState) };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    const partial: Partial<BacklinkState> = {};
    if (state && typeof state === "object") {
      for (const k of Object.keys(DEFAULT_STATE) as (keyof BacklinkState)[]) if (k in state && typeof state[k] === typeof DEFAULT_STATE[k]) (partial as any)[k] = state[k];
    }
    if (this.backlink) this.backlink.setState(partial);
    else Object.assign(this.pendingState, partial);
    await super.setState(state, result);
  }
}

/** `.embedded-backlinks` at the bottom of a Markdown view. */
class EmbeddedBacklinks extends Component {
  el: HTMLElement;
  backlink: BacklinkComponent;
  hoverPopover: any = null;
  constructor(
    public plugin: BacklinkPlugin,
    public view: any,
  ) {
    super();
    this.el = createDiv({ cls: "embedded-backlinks" });
    this.el.addEventListener("mousedown", (evt) => evt.stopPropagation());
    this.backlink = new BacklinkComponent(plugin.app, this.el, this, { unlinkedCollapsed: true });
    this.addChild(this.backlink);
  }
  attach() {
    const host = findBacklinkHost(this.view);
    if (host && this.el.parentElement !== host.parent) host.parent.appendChild(this.el);
    this.backlink.setFile(this.view.file ?? null);
  }
  override onunload(): void {
    this.el.detach();
  }
}

function findBacklinkHost(view: any): { parent: HTMLElement } | null {
  const root: HTMLElement | undefined = view?.containerEl;
  if (!root) return null;
  const mode = typeof view.getMode === "function" ? view.getMode() : null;
  if (mode === "preview") {
    const preview = root.querySelector<HTMLElement>(".markdown-reading-view .markdown-preview-view, .markdown-preview-view");
    return preview ? { parent: preview } : null;
  }
  const sizer = root.querySelector<HTMLElement>(".markdown-source-view .cm-sizer");
  if (sizer) return { parent: sizer };
  const preview = root.querySelector<HTMLElement>(".markdown-preview-view");
  return preview ? { parent: preview } : null;
}

class BacklinkSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private backlinkPlugin: BacklinkPlugin,
  ) {
    super(app, backlinkPlugin);
    this.name = "Backlinks";
  }
  override display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Show backlinks at the bottom of notes")
      .setDesc("Make backlinks visible in new tabs by default.")
      .addToggle((t) =>
        t.setValue(!!this.backlinkPlugin.instance.options.backlinkInDocument).onChange(async (v) => {
          this.backlinkPlugin.instance.options.backlinkInDocument = v;
          await this.backlinkPlugin.instance.saveOptions();
          this.backlinkPlugin.updateEmbedded();
        }),
      );
  }
}

export class BacklinkPlugin extends Plugin {
  instance!: any;
  private embedded = new Map<any, EmbeddedBacklinks>();
  private statusBarEl: HTMLElement | null = null;
  private requestStatus = debounce(() => this.updateStatusBar(), 300, true);
  private requestEmbedded = debounce(() => this.updateEmbedded(), 50, true);

  override async onload() {
    ensureKnowledgeIcons();
    this.registerView(VIEW_TYPE_BACKLINK, (leaf: WorkspaceLeaf) => new BacklinkView(leaf, this));
    this.addCommand({ id: "backlink:open", name: "Backlinks: Show backlinks", icon: "links-coming-in", callback: () => void showSideView(this.app, VIEW_TYPE_BACKLINK) });
    this.addCommand({
      id: "backlink:open-backlinks",
      name: "Backlinks: Open backlinks for the current note",
      icon: "links-coming-in",
      checkCallback: (checking: boolean) => {
        if (!this.app.workspace.getActiveFile()) return false;
        if (!checking) void openLinkedView(this.app, VIEW_TYPE_BACKLINK);
        return true;
      },
    });
    this.addCommand({
      id: "backlink:toggle-backlinks-in-document",
      name: "Backlinks: Toggle backlinks in document",
      icon: "links-coming-in",
      checkCallback: (checking: boolean) => {
        const view = this.activeMarkdownView();
        if (!view?.file) return false;
        if (!checking) this.toggleInDocument(view.file);
        return true;
      },
    });
    if (this.app.setting) this.addSettingTab(new BacklinkSettingTab(this.app, this));

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.addEventListener("click", () => void showSideView(this.app, VIEW_TYPE_BACKLINK));
    this.registerEvent(this.app.workspace.on("file-open", () => this.requestStatus()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.requestStatus()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.requestStatus()));

    this.registerEvent(this.app.workspace.on("layout-change", () => this.requestEmbedded()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.requestEmbedded()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.requestEmbedded()));
    this.app.workspace.onLayoutReady(() => this.updateEmbedded());

    this.instance.addBacklinkInDocument = (view: any) => this.attachTo(view);
    this.instance.toggleBacklinksInDocument = (file: TFile) => this.toggleInDocument(file);
    this.instance.getBacklinksInDocument = (view: any) => this.embedded.get(view)?.backlink ?? null;
  }

  override onunload() {
    for (const e of this.embedded.values()) e.unload();
    this.embedded.clear();
    delete this.instance.addBacklinkInDocument;
    delete this.instance.toggleBacklinksInDocument;
    delete this.instance.getBacklinksInDocument;
  }

  private activeMarkdownView(): any {
    const view = this.app.workspace.activeLeaf?.view;
    return view && view.getViewType?.() === "markdown" ? view : null;
  }

  private overrides(): Record<string, boolean> {
    const o = this.app.loadLocalStorage(IN_DOC_KEY);
    return o && typeof o === "object" ? o : {};
  }

  toggleInDocument(file: TFile) {
    const o = this.overrides();
    const current = o[file.path] ?? !!this.instance.options.backlinkInDocument;
    o[file.path] = !current;
    this.app.saveLocalStorage(IN_DOC_KEY, o);
    this.updateEmbedded();
  }

  private shouldShow(file: TFile | null): boolean {
    if (!file) return false;
    return this.overrides()[file.path] ?? !!this.instance.options.backlinkInDocument;
  }

  /** Attaches in-document backlinks to `view` if they should show; returns the component or null. */
  attachTo(view: any): BacklinkComponent | null {
    if (!view || view.getViewType?.() !== "markdown") return null;
    let e = this.embedded.get(view);
    if (!this.shouldShow(view.file ?? null)) {
      if (e) {
        e.unload();
        this.embedded.delete(view);
      }
      return null;
    }
    if (!e) {
      e = new EmbeddedBacklinks(this, view);
      e.load();
      this.embedded.set(view, e);
    }
    e.attach();
    return e.backlink;
  }

  updateEmbedded() {
    const live = new Set<any>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown") as WorkspaceLeaf[]) {
      if (leaf.isDeferred) continue;
      live.add(leaf.view);
      this.attachTo(leaf.view);
    }
    for (const [view, e] of this.embedded) {
      if (!live.has(view)) {
        e.unload();
        this.embedded.delete(view);
      }
    }
  }

  private updateStatusBar() {
    const el = this.statusBarEl;
    if (!el) return;
    const file = this.app.workspace.getActiveFile() as TFile | null;
    if (!file || file.extension !== "md") {
      el.hide();
      return;
    }
    let n = 0;
    for (const g of getBacklinks(this.app, file.path)) n += g.refs.length;
    el.show();
    el.setText(`${n} backlink${n === 1 ? "" : "s"}`);
  }
}

export const backlink: CorePluginDefinition = {
  id: "backlink",
  name: "Backlinks",
  description: "Show links from other files to the current file, and plain-text mentions that could be linked.",
  icon: "links-coming-in",
  defaultOn: true,
  defaultOptions: { backlinkInDocument: false },
  create: (app) => new BacklinkPlugin(app, { id: "backlink", name: "Backlinks", version: "", minAppVersion: "", author: "", description: "" }),
};
