/**
 * The Search view (`search`).
 *
 * View state keys are Obsidian's (`query`, `matchingCase`, `explainSearch`,
 * `collapseAll`, `extraContext`, `sortOrder`) so a vault's workspace.json
 * restores the same search. Queries run in the Rust index; results update as
 * the vault changes, keeping each file's fold state.
 */
import type { ViewStateResult } from "obsidian";
import { setIcon } from "../../obsidian/ui/icons";
import { Menu } from "../../obsidian/ui/menu";
import { SearchComponent, Setting } from "../../obsidian/ui/setting";
import { debounce } from "../../obsidian/util";
import { TFile, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ItemView } from "../../obsidian/workspace/view";
import { CopySearchResultsModal } from "./copy-modal";
import { runSearch, SORT_LABELS, type Explanation, type FileHit, type SortOrder } from "./engine";
import { SearchQuerySuggest } from "./query-suggest";
import { SearchResultDOM, snippetsFromHits, type ResultData } from "./result-dom";
import { showSortMenu } from "./common";
import { buildReplacer, executeReplace, matchKey, planReplace, protectionFor, replaceQuery, undoWithNotice } from "./replace";
import { Keymap, Scope, isMacPlatform } from "../../obsidian/ui/keymap";
import { Notice } from "../../obsidian/ui/notice";

export const VIEW_TYPE_SEARCH = "search";

/**
 * Additions other features make to every Search view (search by meaning adds
 * a toggle and a section of its own). `attach` runs when a view opens or when
 * the extension is added; `onQuery` after each query starts; `detach` when
 * either goes away.
 */
export interface SearchViewExtension {
  attach(view: GlobalSearchView): void;
  onQuery?(view: GlobalSearchView, query: string): void;
  detach?(view: GlobalSearchView): void;
}
export const searchViewExtensions = new Set<SearchViewExtension>();
const HISTORY_KEY = "search-history";
const HISTORY_MAX = 10;

export function hitToResult(hit: FileHit): ResultData {
  return {
    content: hit.content.map((c) => [c.start, c.end] as [number, number]),
    filename: hit.filenameMatches,
    properties: hit.properties,
    snippets: snippetsFromHits(hit.content),
  };
}

function sameResult(a: ResultData, b: ResultData): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function renderExplanation(el: HTMLElement, exp: Explanation | undefined) {
  el.empty();
  if (!exp) return;
  const walk = (node: Explanation, parent: HTMLElement) => {
    const item = parent.createDiv({ cls: "search-explanation-item" });
    item.createDiv({ cls: "search-explanation-label", text: node.label });
    if (node.children?.length) {
      const children = item.createDiv({ cls: "search-explanation-children" });
      for (const c of node.children) walk(c, children);
    }
  };
  walk(exp, el);
}

export class GlobalSearchView extends ItemView {
  plugin: any;
  hoverPopover: any = null;
  searchComponent!: SearchComponent;
  // internal (plugins read these)
  matchingCase = false;
  explainSearch = false;
  collapseAll = false;
  extraContext = false;
  sortOrder: SortOrder = "alphabetical";
  dom!: SearchResultDOM;
  searchInfoEl!: HTMLElement;
  searchParamsContainerEl!: HTMLElement;
  matchCaseButtonEl!: HTMLElement;
  settingsButtonEl!: HTMLElement;
  // internal
  lastQuery = "";
  private suggest!: SearchQuerySuggest;
  private requestSearch = debounce(() => this.startSearch(), 300, true);
  private requestRefresh = debounce(() => this.refresh(), 500, true);
  private stamps = new WeakMap<object, number>();
  private toggles: Record<string, { setValue(v: boolean): unknown }> = {};
  // internal: vault-wide replace
  replaceOpen = false;
  replaceRowEl!: HTMLElement;
  replaceInputEl!: HTMLInputElement;
  replaceButtonEl!: HTMLElement;
  replaceAllButtonEl!: HTMLButtonElement;
  replaceSelectedButtonEl!: HTMLButtonElement;
  replaceInLinksEl!: HTMLInputElement;
  /** Ticks the user changed, by match key; everything else follows the defaults. */
  private replaceChoices = new Map<string, boolean>();
  /** "Also replace inside links and tags": protected matches are ticked by default. */
  private replaceInLinks = false;
  /** Protection of every match of the current results (key → reason), filled as files are read. */
  private replaceReasons = new Map<string, string | null>();
  private reasonsRun = 0;
  private replacing = false;
  private requestPreview = debounce(() => this.updateReplacePreview(), 250, true);
  /** Keyboard cursor in the results (a file title or a match row). */
  private focusedResultEl: HTMLElement | null = null;
  // Mod+Enter belongs to the results while the view has focus, not to the note's editor hotkeys.
  private keyScope: Scope | null = null;
  private scopePushed = false;

  constructor(leaf: WorkspaceLeaf, plugin: any) {
    super(leaf);
    this.plugin = plugin;
    this.icon = "lucide-search";
    this.navigation = false;
  }

  getViewType() {
    return VIEW_TYPE_SEARCH;
  }

  getDisplayText() {
    return "Search";
  }

  override async onOpen(): Promise<void> {
    const content = this.contentEl;
    content.empty();
    const row = content.createDiv({ cls: "search-row" });
    this.searchComponent = new SearchComponent(row);
    this.searchComponent.containerEl.addClass("global-search-input-container");
    this.searchComponent.setPlaceholder("Search...");
    const input = this.searchComponent.inputEl;
    this.matchCaseButtonEl = this.searchComponent.containerEl.createDiv({ cls: "input-right-decorator clickable-icon", attr: { "aria-label": "Match case" } });
    setIcon(this.matchCaseButtonEl, "lucide-case-sensitive");
    this.matchCaseButtonEl.addEventListener("click", () => this.setMatchingCase(!this.matchingCase));
    this.replaceButtonEl = row.createDiv({ cls: "clickable-icon vault-replace-toggle", attr: { "aria-label": "Replace in all files" } });
    setIcon(this.replaceButtonEl, "lucide-replace");
    this.replaceButtonEl.addEventListener("click", () => this.setReplaceOpen(!this.replaceOpen, true));
    this.settingsButtonEl = row.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Search settings" } });
    setIcon(this.settingsButtonEl, "lucide-sliders-horizontal");
    this.settingsButtonEl.addEventListener("click", () => {
      const shown = !this.searchParamsContainerEl.isShown();
      this.searchParamsContainerEl.toggle(shown);
      this.settingsButtonEl.toggleClass("is-active", shown);
    });

    this.buildReplaceRow(content);

    this.searchParamsContainerEl = content.createDiv({ cls: "search-params" });
    this.searchParamsContainerEl.hide();
    const addToggle = (key: string, name: string, get: () => boolean, set: (v: boolean) => void) => {
      new Setting(this.searchParamsContainerEl)
        .setName(name)
        .setClass("mod-toggle")
        .addToggle((t) => {
          this.toggles[key] = t;
          t.setValue(get()).onChange(set);
        });
    };
    addToggle("explain", "Explain search term", () => this.explainSearch, (v) => this.setExplainSearch(v));
    addToggle("collapse", "Collapse results", () => this.collapseAll, (v) => this.setCollapseAll(v));
    addToggle("context", "Show more context", () => this.extraContext, (v) => this.setExtraContext(v));

    this.searchInfoEl = content.createDiv({ cls: "search-info-container" });
    this.searchInfoEl.hide();

    this.dom = new SearchResultDOM(
      { app: this.app, hoverSource: "search", hoverParent: this, showInfo: true, emptyStateText: "No matches found.", menuSource: "search-view" },
      content,
    );
    this.dom.el.addClass("mod-global-search");
    this.dom.collapseAll = this.collapseAll;
    this.dom.extraContext = this.extraContext;
    this.dom.sortOrder = this.sortOrder;
    const actions = this.dom.infoEl.createDiv({ cls: "search-results-info-actions" });
    const sortBtn = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Change sort order" } });
    setIcon(sortBtn, "lucide-arrow-up-narrow-wide");
    sortBtn.addEventListener("click", (evt) => showSortMenu(evt, SORT_LABELS, this.sortOrder, (v) => this.setSortOrder(v)));
    const moreBtn = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": "More options" } });
    setIcon(moreBtn, "lucide-more-horizontal");
    moreBtn.addEventListener("click", (evt) => {
      const menu = new Menu();
      this.addResultMenuItems(menu);
      menu.showAtMouseEvent(evt);
    });
    this.dom.infoEl.hide();

    this.searchComponent.onChange(() => {
      this.setResultFocus(null);
      this.requestSearch();
    });
    input.addEventListener("keydown", (evt) => {
      if (evt.isComposing || this.suggestOpen()) return;
      if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
        evt.preventDefault();
        this.moveResultFocus(evt.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (evt.key === "Enter" && this.focusedResultEl?.isConnected) {
        evt.preventDefault();
        this.saveHistory(input.value);
        this.openFocusedResult(evt);
        return;
      }
      if (evt.key === "Enter") {
        evt.preventDefault();
        this.requestSearch.cancel();
        this.suggest.close();
        this.startSearch();
        this.saveHistory(input.value);
      }
    });
    input.addEventListener("blur", () => this.saveHistory(input.value));
    this.keyScope = new Scope(this.app.scope);
    this.keyScope.register(["Mod"], "Enter", (evt) => {
      if (evt.isComposing) return;
      if (evt.target === this.replaceInputEl) {
        void this.runReplace(false);
        return false;
      }
      if (!this.focusedResultEl?.isConnected) return;
      this.openFocusedResult(evt);
      return false;
    });
    this.registerDomEvent(content, "focusin", () => {
      if (this.scopePushed || !this.keyScope) return;
      this.app.keymap.pushScope(this.keyScope);
      this.scopePushed = true;
    });
    this.registerDomEvent(content, "focusout", (evt) => {
      if (evt.relatedTarget instanceof Node && content.contains(evt.relatedTarget)) return;
      this.popKeyScope();
    });
    this.dom.el.setAttr("tabindex", "-1");
    this.dom.el.addEventListener("keydown", (evt) => this.onResultsKey(evt));
    this.suggest = new SearchQuerySuggest(this.app, input, () => this.getHistory(), () => this.app.saveLocalStorage(HISTORY_KEY, null));

    this.searchComponent.setValue(this.lastQuery);
    this.updateButtons();

    const refresh = () => {
      if (this.lastQuery) this.requestRefresh();
    };
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
    this.registerEvent(this.app.metadataCache.on("deleted", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    this.registerEvent(
      this.app.vault.on("create", (f: TAbstractFile) => {
        if (f instanceof TFile && f.extension !== "md") refresh();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f: TAbstractFile) => {
        if (f instanceof TFile) this.dom.removeResult(f);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        if (this.lastQuery && this.dom.vChildren.length === 0) this.requestRefresh();
      }),
    );
    for (const ext of searchViewExtensions) ext.attach(this);
    if (this.lastQuery) this.startSearch();
  }

  private popKeyScope() {
    if (!this.scopePushed || !this.keyScope) return;
    this.app.keymap.popScope(this.keyScope);
    this.scopePushed = false;
  }

  override async onClose(): Promise<void> {
    this.popKeyScope();
    for (const ext of searchViewExtensions) ext.detach?.(this);
    this.suggest?.close();
    this.dom?.destroy();
  }

  private suggestOpen(): boolean {
    return !!this.suggest?.isOpen && this.suggest.chooser.hasValues();
  }

  // ---- state ------------------------------------------------------------------

  override getState(): Record<string, unknown> {
    return {
      query: this.getQuery(),
      matchingCase: this.matchingCase,
      explainSearch: this.explainSearch,
      collapseAll: this.collapseAll,
      extraContext: this.extraContext,
      sortOrder: this.sortOrder,
    };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    if (state && typeof state === "object") {
      if (typeof state.matchingCase === "boolean") this.matchingCase = state.matchingCase;
      if (typeof state.explainSearch === "boolean") this.explainSearch = state.explainSearch;
      if (typeof state.collapseAll === "boolean") this.collapseAll = state.collapseAll;
      if (typeof state.extraContext === "boolean") this.extraContext = state.extraContext;
      if (typeof state.sortOrder === "string" && SORT_LABELS.some(([k]) => k === state.sortOrder)) this.sortOrder = state.sortOrder;
      if (this.dom) {
        this.dom.setCollapseAll(this.collapseAll);
        this.dom.setExtraContext(this.extraContext);
        this.dom.setSortOrder(this.sortOrder);
        this.updateButtons();
      }
      if (typeof state.query === "string") this.setQuery(state.query);
    }
    await super.setState(state, result);
  }

  getQuery(): string {
    return this.searchComponent ? this.searchComponent.getValue() : this.lastQuery;
  }

  setQuery(query: string) {
    if (!this.searchComponent) {
      this.lastQuery = query;
      return;
    }
    this.searchComponent.setValue(query);
    this.suggest?.close();
    this.requestSearch.cancel();
    this.startSearch();
  }

  private updateButtons() {
    this.matchCaseButtonEl?.toggleClass("is-active", this.matchingCase);
    this.toggles.explain?.setValue(this.explainSearch);
    this.toggles.collapse?.setValue(this.collapseAll);
    this.toggles.context?.setValue(this.extraContext);
  }

  setMatchingCase(v: boolean) {
    this.matchingCase = v;
    this.updateButtons();
    this.startSearch(true);
    this.app.workspace.requestSaveLayout();
  }

  setExplainSearch(v: boolean) {
    this.explainSearch = v;
    this.updateButtons();
    this.startSearch(true);
    this.app.workspace.requestSaveLayout();
  }

  setCollapseAll(v: boolean) {
    this.collapseAll = v;
    this.dom.setCollapseAll(v);
    this.updateButtons();
    this.app.workspace.requestSaveLayout();
  }

  setExtraContext(v: boolean) {
    this.extraContext = v;
    this.dom.setExtraContext(v);
    this.updateButtons();
    this.app.workspace.requestSaveLayout();
  }

  setSortOrder(v: SortOrder) {
    this.sortOrder = v;
    this.dom.setSortOrder(v);
    this.app.workspace.requestSaveLayout();
  }

  // ---- history ----------------------------------------------------------------

  getHistory(): string[] {
    const h = this.app.loadLocalStorage(HISTORY_KEY);
    return Array.isArray(h) ? h.filter((x) => typeof x === "string") : [];
  }

  saveHistory(query: string) {
    const q = query.trim();
    if (!q) return;
    const h = this.getHistory().filter((x) => x !== q);
    h.unshift(q);
    this.app.saveLocalStorage(HISTORY_KEY, h.slice(0, HISTORY_MAX));
  }

  // ---- running ----------------------------------------------------------------

  /** Runs the query; `force` re-renders even when the query text did not change. */
  startSearch(force = false) {
    if (!this.dom) return;
    const query = this.getQuery();
    const changed = query !== this.lastQuery;
    this.lastQuery = query;
    if (changed || force) {
      this.dom.emptyResults();
      this.focusedResultEl = null;
      this.replaceChoices.clear();
    }
    this.app.workspace.requestSaveLayout();
    for (const ext of searchViewExtensions) ext.onQuery?.(this, query);
    if (query.trim() === "") {
      this.dom.emptyResults();
      this.dom.emptyStateEl.hide();
      this.dom.infoEl.hide();
      this.searchInfoEl.hide();
      return;
    }
    this.runAndApply(query);
  }

  /** Re-runs the current query after vault changes, updating results in place. */
  refresh() {
    if (!this.dom || !this.lastQuery.trim()) return;
    this.runAndApply(this.lastQuery);
  }

  // ---- keyboard navigation of results ----------------------------------------------

  private navigableResultEls(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const item of this.dom.vChildren) {
      if (!item.el.isConnected) continue;
      out.push(item.containerEl);
      if (item.collapsed) continue;
      for (const m of Array.from(item.childrenEl.children)) if (m instanceof HTMLElement && m.hasClass("search-result-file-match")) out.push(m);
    }
    return out;
  }

  private setResultFocus(el: HTMLElement | null) {
    this.focusedResultEl?.removeClass("has-focus");
    this.focusedResultEl = el;
    if (!el) return;
    el.addClass("has-focus");
    el.scrollIntoView({ block: "nearest" });
  }

  // internal
  moveResultFocus(delta: number) {
    const els = this.navigableResultEls();
    if (!els.length) return;
    const current = this.focusedResultEl?.isConnected ? els.indexOf(this.focusedResultEl) : -1;
    if (current === -1) {
      this.setResultFocus(delta > 0 ? els[0]! : els[els.length - 1]!);
      return;
    }
    const next = current + delta;
    if (next < 0) {
      // Up from the first result returns to the query.
      this.setResultFocus(null);
      this.searchComponent.inputEl.focus();
      return;
    }
    this.setResultFocus(els[Math.min(els.length - 1, next)]!);
  }

  private openFocusedResult(evt: KeyboardEvent) {
    const el = this.focusedResultEl;
    if (!el?.isConnected) return;
    const mod = Keymap.isModEvent(evt);
    if (el.hasClass("search-result-file-title")) {
      const item = this.dom.vChildren.find((c) => c.containerEl === el);
      if (item) void this.app.workspace.getLeaf(mod).openFile(item.file, { active: true });
      return;
    }
    const mac = isMacPlatform();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: !!mod && mac, ctrlKey: !!mod && !mac });
    (el.querySelector(".vault-replace-text") ?? el).dispatchEvent(click);
  }

  private onResultsKey(evt: KeyboardEvent) {
    if (evt.isComposing || (evt.target instanceof HTMLInputElement && evt.target !== this.searchComponent.inputEl)) return;
    const el = this.focusedResultEl?.isConnected ? this.focusedResultEl : null;
    const item = el ? this.dom.vChildren.find((c) => c.containerEl === el || c.childrenEl.contains(el)) : null;
    if (evt.key === "ArrowDown" || evt.key === "ArrowUp") {
      evt.preventDefault();
      this.moveResultFocus(evt.key === "ArrowDown" ? 1 : -1);
    } else if (evt.key === "Enter" && el) {
      evt.preventDefault();
      this.openFocusedResult(evt);
    } else if (evt.key === "ArrowLeft" && item) {
      evt.preventDefault();
      item.setCollapse(true, true);
      this.setResultFocus(item.containerEl);
    } else if (evt.key === "ArrowRight" && item) {
      evt.preventDefault();
      item.setCollapse(false, true);
    } else if (evt.key === " " && el?.hasClass("vault-replace-match")) {
      evt.preventDefault();
      el.querySelector<HTMLInputElement>("input.vault-replace-checkbox")?.click();
    }
  }

  // ---- replace ----------------------------------------------------------------------

  private buildReplaceRow(content: HTMLElement) {
    this.replaceRowEl = content.createDiv({ cls: "search-row vault-replace-row" });
    const box = this.replaceRowEl.createDiv({ cls: "search-input-container vault-replace-input-container" });
    this.replaceInputEl = box.createEl("input", { cls: "vault-replace-input", type: "text", attr: { placeholder: "Replace...", spellcheck: "false", enterkeyhint: "done" } });
    const option = this.replaceRowEl.createEl("label", { cls: "vault-replace-option" });
    this.replaceInLinksEl = option.createEl("input", { cls: "vault-replace-in-links", type: "checkbox" });
    option.createSpan({ text: "Also replace inside links and tags" });
    option.setAttr("aria-label", "Off: link and embed targets, tags, property names and web addresses are left as they are, so links keep working. Rename a file to update its links.");
    this.replaceInLinksEl.addEventListener("change", () => {
      this.replaceInLinks = this.replaceInLinksEl.checked;
      this.replaceChoices.clear();
      this.updateReplacePreview();
    });
    const actions = this.replaceRowEl.createDiv({ cls: "vault-replace-actions" });
    this.replaceSelectedButtonEl = actions.createEl("button", { cls: "vault-replace-selected", text: "Replace selected" });
    this.replaceAllButtonEl = actions.createEl("button", { cls: "vault-replace-all mod-warning", text: "Replace all" });
    this.replaceInputEl.addEventListener("input", () => this.requestPreview());
    this.replaceInputEl.addEventListener("keydown", (evt) => {
      if (evt.isComposing) return;
      if (evt.key === "Enter" && Keymap.isModEvent(evt)) {
        evt.preventDefault();
        void this.runReplace(false);
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        evt.stopPropagation();
        this.searchComponent.inputEl.focus();
      } else if (evt.key === "ArrowDown") {
        evt.preventDefault();
        this.moveResultFocus(1);
        this.dom.el.focus({ preventScroll: true });
      }
    });
    this.replaceSelectedButtonEl.addEventListener("click", () => void this.runReplace(true));
    this.replaceAllButtonEl.addEventListener("click", () => void this.runReplace(false));
    this.replaceRowEl.hide();
  }

  // internal (used by the "Replace in all files" command)
  setReplaceOpen(open: boolean, focus = false) {
    this.replaceOpen = open;
    this.replaceRowEl.toggle(open);
    this.replaceButtonEl.toggleClass("is-active", open);
    this.dom.el.toggleClass("vault-is-replacing", open);
    this.replaceChoices.clear();
    if (this.lastQuery.trim()) this.runAndApply(this.lastQuery);
    this.updateReplacePreview();
    if (open && focus) {
      if (this.getQuery().trim()) {
        this.replaceInputEl.focus();
        this.replaceInputEl.select();
      } else this.searchComponent.inputEl.focus();
    }
  }

  private updateReplacePreview() {
    if (!this.dom) return;
    const on = this.replaceOpen;
    this.dom.replacePreview = on
      ? {
          replacer: buildReplacer(this.lastQuery, this.replaceInputEl.value, this.matchingCase),
          key: matchKey,
          protection: (file, text) => protectionFor(this.app, file, text),
          isIncluded: (key, reason) => this.isReplaceIncluded(key, reason),
          setIncluded: (key, on) => void this.replaceChoices.set(key, on),
          onToggle: () => this.updateReplaceButtons(),
        }
      : null;
    for (const item of this.dom.vChildren) item.rerender();
    this.updateReplaceButtons();
  }

  private isReplaceIncluded(key: string, reason: string | null): boolean {
    return this.replaceChoices.get(key) ?? (!reason || this.replaceInLinks);
  }

  /** Reads the result files to learn which matches are protected, then updates the counts. */
  private async classifyForReplace() {
    const run = ++this.reasonsRun;
    for (const item of this.dom.vChildren.slice()) {
      if (!item.result.content.length) continue;
      const first = item.result.content[0]!;
      if (this.replaceReasons.has(matchKey(item.file.path, first[0], first[1]))) continue;
      const text = await item.getContent();
      if (run !== this.reasonsRun) return;
      const protect = protectionFor(this.app, item.file, text);
      for (const [s, e] of item.result.content) this.replaceReasons.set(matchKey(item.file.path, s, e), protect(s, e));
    }
    this.updateReplaceButtons();
  }

  private selectedMatchCount(): { total: number; selected: number } {
    // total: what "Replace all" writes (the default ticks); selected: what is ticked now.
    let total = 0;
    let selected = 0;
    for (const item of this.dom.vChildren) {
      for (const [s, e] of item.result.content) {
        const key = matchKey(item.file.path, s, e);
        const reason = this.replaceReasons.get(key) ?? null;
        const chosen = this.replaceChoices.get(key);
        if (!reason || this.replaceInLinks || chosen) total++;
        if (this.isReplaceIncluded(key, reason)) selected++;
      }
    }
    return { total, selected };
  }

  private updateReplaceButtons() {
    if (!this.replaceAllButtonEl) return;
    const { total, selected } = this.selectedMatchCount();
    const busy = this.replacing || !this.lastQuery.trim();
    this.replaceAllButtonEl.disabled = busy || total === 0;
    this.replaceSelectedButtonEl.disabled = busy || selected === 0 || selected === total;
    this.replaceAllButtonEl.setText(total ? `Replace all (${total})` : "Replace all");
    this.replaceSelectedButtonEl.setText(selected && selected !== total ? `Replace selected (${selected})` : "Replace selected");
  }

  /** Writes the replacement into every matching file (or only the ticked matches). */
  // internal
  async runReplace(selectedOnly: boolean) {
    const query = this.lastQuery;
    if (this.replacing || !query.trim()) return;
    this.replacing = true;
    this.updateReplaceButtons();
    try {
      const plans = await planReplace(this.app, query, this.replaceInputEl.value, this.matchingCase);
      const choices = new Map(this.replaceChoices);
      const inLinks = this.replaceInLinks;
      const record = await executeReplace(this.app, query, plans, (file, m) => {
        const chosen = choices.get(matchKey(file.path, m.start, m.end));
        const byDefault = !m.reason || inLinks;
        // Replace all writes the default ticks plus protected matches ticked by hand; Replace selected writes the ticks.
        return selectedOnly ? (chosen ?? byDefault) : byDefault || chosen === true;
      });
      this.replaceChoices.clear();
      if (!record.count) {
        new Notice("Nothing was replaced.");
        return;
      }
      const frag = createFragment((f) => {
        f.appendText(`Replaced ${record.count} match${record.count === 1 ? "" : "es"} in ${record.files.length} file${record.files.length === 1 ? "" : "s"}. `);
        const undo = f.createEl("button", { cls: "mod-cta vault-replace-undo", text: "Undo" });
        undo.addEventListener("click", (evt) => {
          evt.stopPropagation();
          void undoWithNotice(this.app);
          notice.hide();
        });
      });
      const notice = new Notice(frag, 10000);
    } catch (e) {
      new Notice(String((e as Error)?.message ?? e));
    } finally {
      this.replacing = false;
      this.updateReplaceButtons();
      this.refresh();
    }
  }

  private runAndApply(query: string) {
    // While replacing, plain words are matched as the typed phrase, so the preview shows what will be written.
    const run = runSearch(this.app, this.replaceOpen ? replaceQuery(query) : query, { caseSensitive: this.matchingCase, sort: this.sortOrder, explain: this.explainSearch });
    this.searchInfoEl.toggle(this.explainSearch && !!run.explanation);
    if (this.explainSearch) renderExplanation(this.searchInfoEl, run.explanation);
    if (run.error) {
      this.dom.emptyResults();
      this.dom.setEmptyStateText(run.error);
      this.dom.infoEl.hide();
      return;
    }
    this.dom.setEmptyStateText("No matches found.");
    const seen = new Set<TFile>();
    for (const hit of run.files) {
      const file = this.app.vault.getFileByPath(hit.path);
      if (!(file instanceof TFile)) continue;
      seen.add(file);
      const data = hitToResult(hit);
      const existing = this.dom.resultDomLookup.get(file);
      if (existing && sameResult(existing.result, data) && this.stamps.get(existing) === file.stat.mtime) continue;
      const item = this.dom.addResult(file, data, null);
      this.stamps.set(item, file.stat.mtime);
    }
    for (const file of Array.from(this.dom.resultDomLookup.keys())) if (!seen.has(file)) this.dom.removeResult(file);
    this.dom.infoEl.show();
    this.dom.resultCountEl.setText(`${run.matchCount.toLocaleString()} result${run.matchCount === 1 ? "" : "s"}`);
    this.dom.changed();
    if (this.replaceOpen) {
      const replacer = buildReplacer(query, this.replaceInputEl.value, this.matchingCase);
      if (this.dom.replacePreview) this.dom.replacePreview.replacer = replacer;
      this.replaceReasons.clear();
      this.updateReplaceButtons();
      void this.classifyForReplace();
    }
  }

  // ---- menus ------------------------------------------------------------------

  private addResultMenuItems(menu: Menu) {
    menu.addItem((item) =>
      item
        .setTitle("Copy search results")
        .setIcon("lucide-copy")
        .onClick(() => new CopySearchResultsModal(this.app, this.dom.getFiles()).open()),
    );
    if (this.app.internalPlugins.getEnabledPluginById("bookmarks")) {
      menu.addItem((item) =>
        item
          .setTitle("Bookmark")
          .setIcon("lucide-bookmark")
          .onClick(() => this.app.commands.executeCommandById("bookmarks:bookmark-current-search")),
      );
    }
  }

  override onPaneMenu(menu: Menu, source: string): void {
    if (this.lastQuery) this.addResultMenuItems(menu);
    super.onPaneMenu(menu, source);
  }

  // internal
  focus() {
    this.searchComponent?.inputEl.focus();
  }
}
