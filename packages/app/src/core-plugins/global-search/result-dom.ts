/**
 * The result tree shared by Search, Backlinks, Outgoing links and embedded
 * queries.
 *
 * DOM (Obsidian's classes, which themes and plugins target):
 *
 *   .search-result-container
 *     .search-results-info > .search-results-result-count      (optional)
 *     .search-results-children
 *       .tree-item.search-result[.is-collapsed]
 *         .tree-item-self.search-result-file-title.is-clickable
 *           .tree-item-icon.collapse-icon
 *           .tree-item-inner
 *           .tree-item-flair-outer > .tree-item-flair
 *         .search-result-file-matches
 *           .search-result-file-match.tappable
 *             … .search-result-file-matched-text …
 *
 * Snippets need the file's text, which is read lazily (`vault.cachedRead`)
 * when a result scrolls into view, so a search over a large vault renders
 * its file list at once and its excerpts as you scroll.
 */
import { Component } from "../../obsidian/events";
import { setIcon } from "../../obsidian/ui/icons";
import { Keymap } from "../../obsidian/ui/keymap";
import { Menu } from "../../obsidian/ui/menu";
import type { TFile } from "../../obsidian/vault/files";
import { customTitle } from "../file-explorer/note-titles";
import { lineOf, lineStarts, sortFiles, type PropertyHit, type Range, type SortOrder } from "./engine";

export interface ResultData {
  /** UTF-16 ranges in the file's content. */
  content: Range[];
  /** UTF-16 ranges in the file name. */
  filename?: Range[];
  properties?: PropertyHit[];
  /** Extra rows that are not content ranges (frontmatter links in backlinks). */
  rows?: { text: string; matches: Range[]; line: number }[];
  /** Excerpts from the index (file offset of `text`, matches in file offsets); used until the file is read. */
  snippets?: { text: string; offset: number; matches: Range[] }[];
}

/** Groups index excerpts that share a line into one snippet each. */
export function snippetsFromHits(hits: { start: number; end: number; context?: { text: string; offset: number } }[]): ResultData["snippets"] {
  const out: NonNullable<ResultData["snippets"]> = [];
  const byKey = new Map<string, NonNullable<ResultData["snippets"]>[number]>();
  for (const h of hits) {
    if (!h.context) return undefined;
    const key = `${h.context.offset}:${h.context.text.length}`;
    let sn = byKey.get(key);
    if (!sn) {
      sn = { text: h.context.text, offset: h.context.offset, matches: [] };
      byKey.set(key, sn);
      out.push(sn);
    }
    sn.matches.push([h.start, h.end]);
  }
  return out;
}

export interface MatchGroup {
  start: number;
  end: number;
  matches: Range[];
}

export interface ResultDOMOptions {
  app: any;
  /** `hover-link` source id. */
  hoverSource: string;
  hoverParent: { hoverPopover: any };
  /** Merge nearby matches into one excerpt (search) or keep one row per match (unlinked mentions). */
  mergeMatches?: boolean;
  /** Adds a "Link" button to every excerpt. */
  linkButton?: (item: SearchResultItemDOM, range: Range, evt: MouseEvent) => void;
  linkButtonText?: (item: SearchResultItemDOM) => string;
  /** Overrides how an excerpt opens its file. */
  onMatchClick?: (item: SearchResultItemDOM, group: MatchGroup, evt: MouseEvent) => void;
  /** The query blocks of this path's own text are ignored (embedded queries). */
  menuSource?: string;
  emptyStateText?: string;
  showInfo?: boolean;
  /** Title override (e.g. unresolved link text). */
  titleText?: (item: SearchResultItemDOM) => string;
}

const MAX_GROUPS = 25;
const LINE_WINDOW = 100;
const EXTRA_LINES = 2;
const RENDER_BATCH = 200;

/** Excerpt ranges around `matches`, merged when they overlap. */
export function buildMatchGroups(text: string, matches: Range[], extraContext: boolean, merge: boolean, starts = lineStarts(text)): MatchGroup[] {
  const lineEnd = (l: number) => (l + 1 < starts.length ? starts[l + 1]! - 1 : text.length);
  const groups: MatchGroup[] = [];
  const sorted = matches.slice().sort((a, b) => a[0] - b[0]);
  for (const m of sorted) {
    const s = Math.max(0, Math.min(m[0], text.length));
    const e = Math.max(s, Math.min(m[1], text.length));
    let ls = lineOf(starts, s);
    let le = lineOf(starts, Math.max(s, e - 1));
    if (extraContext) {
      ls = Math.max(0, ls - EXTRA_LINES);
      le = Math.min(starts.length - 1, le + EXTRA_LINES);
    }
    let from = starts[ls]!;
    let to = lineEnd(le);
    if (to > text.length) to = text.length;
    const window = extraContext ? LINE_WINDOW * 3 : LINE_WINDOW;
    if (s - from > window) {
      from = s - window;
      const sp = text.indexOf(" ", from);
      if (sp !== -1 && sp < s) from = sp + 1;
    }
    if (to - e > window) {
      to = e + window;
      const sp = text.lastIndexOf(" ", to);
      if (sp > e) to = sp;
    }
    while (from < s && /\s/.test(text[from]!)) from++;
    while (to > e && /\s/.test(text[to - 1]!)) to--;
    const prev = groups[groups.length - 1];
    if (merge && prev && from <= prev.end) {
      prev.end = Math.max(prev.end, to);
      prev.matches.push([s, e]);
    } else groups.push({ start: from, end: to, matches: [[s, e]] });
  }
  return groups;
}

/** Text with `.search-result-file-matched-text` spans; ranges are relative to `offset`. */
export function renderHighlighted(el: HTMLElement, text: string, matches: Range[], offset = 0) {
  let pos = 0;
  for (const [s0, e0] of matches.slice().sort((a, b) => a[0] - b[0])) {
    const s = Math.max(pos, s0 - offset);
    const e = Math.min(text.length, e0 - offset);
    if (e <= s) continue;
    if (s > pos) el.appendText(text.slice(pos, s));
    el.createSpan({ cls: "search-result-file-matched-text", text: text.slice(s, e) });
    pos = e;
  }
  if (pos < text.length) el.appendText(text.slice(pos));
}

export class SearchResultItemDOM extends Component {
  parentDom: SearchResultDOM;
  file: TFile;
  result: ResultData;
  content: string | null = null;
  collapsed: boolean;
  el: HTMLElement;
  containerEl: HTMLElement;
  collapseEl: HTMLElement;
  innerEl: HTMLElement;
  flairEl: HTMLElement;
  childrenEl: HTMLElement;
  // internal
  showAll = false;
  private rendered = false;
  private loading = false;

  constructor(parentDom: SearchResultDOM, file: TFile, result: ResultData, content: string | null) {
    super();
    this.parentDom = parentDom;
    this.file = file;
    this.result = result;
    this.content = content;
    this.collapsed = parentDom.collapseAll;
    const app = parentDom.options.app;

    this.el = createDiv({ cls: "tree-item search-result" });
    this.containerEl = this.el.createDiv({ cls: "tree-item-self search-result-file-title is-clickable" });
    this.collapseEl = this.containerEl.createDiv({ cls: "tree-item-icon collapse-icon" });
    setIcon(this.collapseEl, "right-triangle");
    this.innerEl = this.containerEl.createDiv({ cls: "tree-item-inner" });
    this.flairEl = this.containerEl.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair" });
    this.childrenEl = this.el.createDiv({ cls: "search-result-file-matches" });
    this.renderTitle();

    this.collapseEl.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.setCollapse(!this.collapsed, true);
    });
    this.containerEl.addEventListener("click", (evt) => {
      if (evt.defaultPrevented) return;
      void this.openFile(evt);
    });
    this.containerEl.addEventListener("auxclick", (evt) => {
      if (evt.button === 1) void this.openFile(evt);
    });
    this.containerEl.addEventListener("mouseover", (evt) => {
      app.workspace.trigger("hover-link", {
        event: evt,
        source: parentDom.options.hoverSource,
        hoverParent: parentDom.options.hoverParent,
        targetEl: this.containerEl,
        linktext: file.path,
        sourcePath: "",
      });
    });
    this.containerEl.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      app.workspace.trigger("file-menu", menu, file, parentDom.options.menuSource ?? "search-view", null);
      menu.showAtMouseEvent(evt);
    });
    app.dragManager?.handleDrag?.(this.containerEl, (evt: DragEvent) => app.dragManager.dragFile(evt, file));
    this.updateCollapsed();
  }

  renderTitle() {
    this.innerEl.empty();
    const custom = this.parentDom.options.titleText ? null : customTitle(this.parentDom.options.app, this.file);
    const title = this.parentDom.options.titleText?.(this) ?? custom ?? (this.file.extension === "md" ? this.file.basename : this.file.name);
    // File-name match ranges do not apply to a display title.
    const fm = custom ? [] : (this.result.filename ?? []);
    renderHighlighted(this.innerEl, title, fm.filter((r) => r[1] <= title.length));
    this.innerEl.setAttr("aria-label", this.file.path);
    this.flairEl.setText(String(this.getMatchCount()));
    this.flairEl.toggle(this.getMatchCount() > 0);
  }

  getMatchCount(): number {
    return this.result.content.length + (this.result.properties?.length ?? 0) + (this.result.rows?.length ?? 0);
  }

  async openFile(evt: MouseEvent) {
    await this.parentDom.options.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(this.file, { active: true });
  }

  setResult(result: ResultData, content: string | null) {
    this.result = result;
    this.content = content;
    this.rendered = false;
    this.renderTitle();
    if (this.el.isConnected) this.parentDom.observe(this);
  }

  setCollapse(collapsed: boolean, userAction = false) {
    if (this.collapsed === collapsed) return;
    this.collapsed = collapsed;
    this.updateCollapsed();
    if (userAction) this.parentDom.onItemToggled?.(this);
  }

  private updateCollapsed() {
    this.el.toggleClass("is-collapsed", this.collapsed);
    this.collapseEl.toggleClass("is-collapsed", this.collapsed);
    this.childrenEl.toggle(!this.collapsed);
    const hasMatches = this.getMatchCount() > 0;
    this.collapseEl.toggleVisibility(hasMatches);
    if (!this.collapsed) this.parentDom.observe(this);
  }

  /** Called when the item is visible and expanded. */
  async ensureRendered() {
    if (this.rendered || this.collapsed || this.loading) return;
    const canUseSnippets = !!this.result.snippets?.length && !this.parentDom.extraContext && !this.parentDom.replacePreview;
    if (this.content === null && this.result.content.length && !canUseSnippets) {
      this.loading = true;
      try {
        this.content = await this.parentDom.options.app.vault.cachedRead(this.file);
      } catch {
        this.content = "";
      } finally {
        this.loading = false;
      }
    }
    this.renderMatches();
  }

  // internal
  async getContent(): Promise<string> {
    if (this.content === null) {
      try {
        this.content = await this.parentDom.options.app.vault.cachedRead(this.file);
      } catch {
        this.content = "";
      }
    }
    return this.content!;
  }

  // internal (defined below)
  declare renderReplacePreview: (text: string, preview: ReplacePreview) => void;

  // internal: re-render the excerpts (replace preview toggled, replacement typed)
  rerender() {
    this.rendered = false;
    this.el.removeClass("vault-replace-preview");
    this.containerEl.querySelector("input.vault-replace-file-checkbox")?.remove();
    if (!this.collapsed) void this.ensureRendered();
  }

  renderMatches() {
    this.rendered = true;
    const dom = this.parentDom;
    const app = dom.options.app;
    this.childrenEl.empty();
    const rows = this.result.rows ?? [];
    for (const row of rows) {
      const el = this.childrenEl.createDiv({ cls: "search-result-file-match tappable" });
      renderHighlighted(el, row.text, row.matches);
      el.addEventListener("click", (evt) => {
        evt.preventDefault();
        void app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(this.file, { active: true, eState: { line: row.line } });
      });
    }
    for (const p of this.result.properties ?? []) {
      const el = this.childrenEl.createDiv({ cls: "search-result-file-match tappable mod-property" });
      const fm = app.metadataCache.getFileCache(this.file)?.frontmatter ?? {};
      let value = fm[p.key];
      if (Array.isArray(value) && p.subkey?.length) value = value[p.subkey[0]!];
      const valueText = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
      el.createSpan({ cls: "search-result-file-match-property-key", text: `${p.key}: ` });
      const v = el.createSpan({ cls: "search-result-file-match-property-value" });
      renderHighlighted(v, valueText, p.pos ? [p.pos] : []);
      el.addEventListener("click", (evt) => {
        void app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(this.file, { active: true, eState: { line: 0 } });
      });
    }
    if (!this.result.content.length) return;
    const text = this.content;
    if (dom.replacePreview && text !== null) {
      this.renderReplacePreview(text, dom.replacePreview);
      return;
    }
    let groups: (MatchGroup & { text: string })[];
    if (text !== null) {
      groups = buildMatchGroups(text, this.result.content, dom.extraContext, dom.options.mergeMatches !== false).map((g) => ({ ...g, text: text.slice(g.start, g.end) }));
    } else {
      groups = (this.result.snippets ?? []).map((sn) => {
        let from = 0;
        let to = sn.text.length;
        const first = Math.min(...sn.matches.map((m) => m[0] - sn.offset));
        const last = Math.max(...sn.matches.map((m) => m[1] - sn.offset));
        while (from < first && /\s/.test(sn.text[from]!)) from++;
        while (to > last && /\s/.test(sn.text[to - 1]!)) to--;
        return { start: sn.offset + from, end: sn.offset + to, matches: sn.matches, text: sn.text.slice(from, to) };
      });
      if (dom.options.mergeMatches === false) {
        groups = groups.flatMap((g) => g.matches.map((m) => ({ ...g, matches: [m] })));
      }
    }
    const shown = this.showAll ? groups : groups.slice(0, MAX_GROUPS);
    for (const g of shown) {
      const el = this.childrenEl.createDiv({ cls: "search-result-file-match tappable" });
      renderHighlighted(el, g.text, g.matches, g.start);
      el.addEventListener("click", (evt) => {
        if ((evt.target as HTMLElement).closest(".search-result-hover-button")) return;
        evt.preventDefault();
        if (dom.options.onMatchClick) dom.options.onMatchClick(this, g, evt);
        else void this.getContent().then((content) => openMatch(app, this.file, content, g, evt, true));
      });
      if (dom.options.linkButton) {
        const btn = el.createEl("button", { cls: "search-result-hover-button mod-top", text: dom.options.linkButtonText?.(this) ?? "Link" });
        btn.addEventListener("click", (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          dom.options.linkButton!(this, g.matches[0]!, evt);
        });
      }
    }
    if (groups.length > shown.length) {
      const more = this.childrenEl.createDiv({ cls: "search-result-file-match search-result-file-match-more tappable", text: `${groups.length - shown.length} more matches…` });
      more.addEventListener("click", () => {
        this.showAll = true;
        this.renderMatches();
      });
    }
  }
}

export interface ReplacePreview {
  /** Replacement text for a matched string. */
  replacer: (matched: string) => string;
  key: (path: string, start: number, end: number) => string;
  /** Why a match is left out by default (inside a link, a tag…), or null. */
  protection: (file: TFile, text: string) => (start: number, end: number) => string | null;
  /** Whether the match is ticked; `reason` is its protection. */
  isIncluded: (key: string, reason: string | null) => boolean;
  setIncluded: (key: string, on: boolean) => void;
  onToggle?: () => void;
}

const PREVIEW_CONTEXT = 40;

/** Before/after rows with checkboxes, one per match (vault-wide replace). */
SearchResultItemDOM.prototype.renderReplacePreview = function (this: SearchResultItemDOM, text: string, preview: ReplacePreview) {
  const app = this.parentDom.options.app;
  const starts = lineStarts(text);
  const ranges = this.result.content.slice().sort((a, b) => a[0] - b[0]);
  const matches: Range[] = [];
  let lastEnd = -1;
  for (const r of ranges) {
    if (r[0] < lastEnd || r[1] <= r[0] || r[1] > text.length) continue;
    matches.push(r);
    lastEnd = r[1];
  }
  this.el.addClass("vault-replace-preview");
  const fileBox = this.containerEl.querySelector<HTMLInputElement>("input.vault-replace-file-checkbox") ?? createEl("input", { cls: "vault-replace-file-checkbox", type: "checkbox", attr: { "aria-label": "Replace in this file" } });
  if (!fileBox.isConnected) {
    this.containerEl.insertBefore(fileBox, this.innerEl);
    fileBox.addEventListener("click", (evt) => evt.stopPropagation());
  }
  const keys = matches.map(([s, e]) => preview.key(this.file.path, s, e));
  const protect = preview.protection(this.file, text);
  const reasons = matches.map(([s, e]) => protect(s, e));
  // The file box stands for the matches replaced by default: protected ones are ticked one by one.
  const idx = keys.map((_, i) => i);
  const boxed = idx.some((i) => !reasons[i]) ? idx.filter((i) => !reasons[i]) : idx;
  const syncFileBox = () => {
    const on = boxed.filter((i) => preview.isIncluded(keys[i]!, reasons[i]!)).length;
    fileBox.checked = on === boxed.length;
    fileBox.indeterminate = on > 0 && on < boxed.length;
  };
  fileBox.onchange = () => {
    if (fileBox.checked) for (const i of boxed) preview.setIncluded(keys[i]!, true);
    else for (const k of keys) preview.setIncluded(k, false);
    this.renderMatches();
    preview.onToggle?.();
  };
  syncFileBox();
  const shown = this.showAll ? matches : matches.slice(0, MAX_GROUPS);
  shown.forEach(([s, e], i) => {
    const key = keys[i]!;
    const reason = reasons[i]!;
    const line = lineOf(starts, s);
    const lineStart = starts[line]!;
    const lineEnd = line + 1 < starts.length ? starts[line + 1]! - 1 : text.length;
    const from = Math.max(lineStart, s - PREVIEW_CONTEXT);
    const to = Math.min(lineEnd, e + PREVIEW_CONTEXT);
    const matched = text.slice(s, e);
    const included = preview.isIncluded(key, reason);
    const row = this.childrenEl.createDiv({ cls: "search-result-file-match tappable vault-replace-match" });
    row.toggleClass("is-excluded", !included);
    row.toggleClass("is-protected", !!reason);
    const box = row.createEl("input", { cls: "vault-replace-checkbox", type: "checkbox", attr: { "aria-label": reason ? `Replace this match (${reason.toLowerCase()})` : "Replace this match" } });
    box.checked = included;
    box.addEventListener("click", (evt) => evt.stopPropagation());
    box.addEventListener("change", () => {
      preview.setIncluded(key, box.checked);
      row.toggleClass("is-excluded", !box.checked);
      syncFileBox();
      preview.onToggle?.();
    });
    const body = row.createSpan({ cls: "vault-replace-text" });
    if (from > lineStart) body.appendText("…");
    body.appendText(text.slice(from, s));
    body.createEl("del", { cls: "vault-replace-old search-result-file-matched-text", text: matched });
    const replacement = preview.replacer(matched);
    if (replacement) body.createEl("ins", { cls: "vault-replace-new", text: replacement });
    body.appendText(text.slice(e, to));
    if (to < lineEnd) body.appendText("…");
    if (reason) body.createDiv({ cls: "vault-replace-reason", text: reason });
    row.addEventListener("click", (evt) => {
      if (evt.target === box) return;
      evt.preventDefault();
      void openMatch(app, this.file, text, { start: s, end: e, matches: [[s, e]] }, evt, true);
    });
  });
  if (matches.length > shown.length) {
    const more = this.childrenEl.createDiv({ cls: "search-result-file-match search-result-file-match-more tappable", text: `${matches.length - shown.length} more matches…` });
    more.addEventListener("click", () => {
      this.showAll = true;
      this.renderMatches();
    });
  }
};

/** Open `file` at the excerpt: eState carries Obsidian's `match` plus a line/cursor for our views. */
export async function openMatch(app: any, file: TFile, content: string, group: MatchGroup, evt: MouseEvent | null, exactMatch: boolean) {
  const starts = lineStarts(content);
  const first = group.matches[0] ?? [group.start, group.start];
  const fromLine = lineOf(starts, first[0]);
  const toLine = lineOf(starts, first[1]);
  const eState = {
    match: { content, matches: exactMatch ? group.matches : group.matches.slice(0, 1) },
    line: fromLine,
    cursor: {
      from: { line: fromLine, ch: first[0] - starts[fromLine]! },
      to: { line: toLine, ch: first[1] - starts[toLine]! },
    },
    scroll: fromLine,
  };
  const leaf = app.workspace.getLeaf(evt ? Keymap.isModEvent(evt) : false);
  await leaf.openFile(file, { active: true, eState });
}

export class SearchResultDOM {
  options: ResultDOMOptions;
  el: HTMLElement;
  infoEl: HTMLElement;
  resultCountEl: HTMLElement;
  childrenEl: HTMLElement;
  emptyStateEl: HTMLElement;
  resultDomLookup = new Map<TFile, SearchResultItemDOM>();
  vChildren: SearchResultItemDOM[] = [];
  collapseAll = false;
  extraContext = false;
  sortOrder: SortOrder = "alphabetical";
  // internal: vault-wide replace preview (Search view)
  replacePreview: ReplacePreview | null = null;
  // internal (set by owners that persist fold state)
  onItemToggled: ((item: SearchResultItemDOM) => void) | null = null;
  private observer: IntersectionObserver | null = null;
  private renderQueued = false;
  private renderedCount = 0;
  private sortQueued = true;

  constructor(options: ResultDOMOptions, parentEl?: HTMLElement) {
    this.options = options;
    this.el = createDiv({ cls: "search-result-container" });
    this.infoEl = this.el.createDiv({ cls: "search-results-info" });
    this.resultCountEl = this.infoEl.createDiv({ cls: "search-results-result-count" });
    this.infoEl.toggle(!!options.showInfo);
    this.childrenEl = this.el.createDiv({ cls: "search-results-children" });
    this.emptyStateEl = this.el.createDiv({ cls: "search-empty-state", text: options.emptyStateText ?? "No matches found." });
    this.emptyStateEl.hide();
    if (parentEl) parentEl.appendChild(this.el);
    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = (entry.target as HTMLElement & { __searchItem?: SearchResultItemDOM }).__searchItem;
          if (item) {
            this.observer?.unobserve(entry.target);
            void item.ensureRendered();
          }
        }
        this.maybeRenderMore(entries);
      });
    }
  }

  destroy() {
    this.observer?.disconnect();
    this.observer = null;
    this.emptyResults();
    this.el.detach();
  }

  // internal
  observe(item: SearchResultItemDOM) {
    (item.el as HTMLElement & { __searchItem?: SearchResultItemDOM }).__searchItem = item;
    if (!this.observer) {
      void item.ensureRendered();
      return;
    }
    this.observer.observe(item.el);
  }

  getFiles(): TFile[] {
    return this.vChildren.map((c) => c.file);
  }

  getMatchCount(): number {
    let n = 0;
    for (const c of this.vChildren) n += c.getMatchCount();
    return n;
  }

  addResult(file: TFile, result: ResultData, content: string | null = null): SearchResultItemDOM {
    const existing = this.resultDomLookup.get(file);
    if (existing) {
      existing.setResult(result, content);
      this.changed();
      return existing;
    }
    const item = new SearchResultItemDOM(this, file, result, content);
    this.resultDomLookup.set(file, item);
    this.vChildren.push(item);
    this.sortQueued = true;
    this.changed();
    return item;
  }

  removeResult(file: TFile) {
    const item = this.resultDomLookup.get(file);
    if (!item) return;
    this.resultDomLookup.delete(file);
    this.vChildren.remove(item);
    this.observer?.unobserve(item.el);
    item.el.detach();
    item.unload();
    this.renderedCount = Math.min(this.renderedCount, this.vChildren.length);
    this.changed();
  }

  emptyResults() {
    for (const item of this.vChildren) {
      this.observer?.unobserve(item.el);
      item.unload();
    }
    this.vChildren = [];
    this.resultDomLookup.clear();
    this.childrenEl.empty();
    this.renderedCount = 0;
    this.changed();
  }

  setCollapseAll(collapse: boolean) {
    this.collapseAll = collapse;
    for (const c of this.vChildren) c.setCollapse(collapse);
  }

  setExtraContext(extra: boolean) {
    if (this.extraContext === extra) return;
    this.extraContext = extra;
    for (const c of this.vChildren) {
      c.setResult(c.result, c.content);
    }
  }

  setSortOrder(order: SortOrder) {
    this.sortOrder = order;
    this.sortQueued = true;
    this.changed();
  }

  setEmptyStateText(text: string) {
    this.emptyStateEl.setText(text);
  }

  /** Re-sorts and renders; batched to one frame. */
  changed() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  // internal: render synchronously (tests, first paint)
  render() {
    if (this.sortQueued) {
      const files = sortFiles(this.vChildren.map((c) => c.file), this.sortOrder);
      this.vChildren = files.map((f) => this.resultDomLookup.get(f)!);
      this.sortQueued = false;
    }
    // Render the first batches directly; the rest follow as the list scrolls.
    const target = Math.min(this.vChildren.length, Math.max(this.renderedCount, RENDER_BATCH));
    const els = this.vChildren.slice(0, target).map((c) => c.el);
    this.childrenEl.setChildrenInPlace(els);
    for (let i = this.renderedCount; i < target; i++) this.observe(this.vChildren[i]!);
    // Items whose DOM stayed but whose content changed re-observe themselves in setResult.
    this.renderedCount = target;
    if (target < this.vChildren.length) this.observeTail();
    this.emptyStateEl.toggle(this.vChildren.length === 0);
    this.childrenEl.toggle(this.vChildren.length > 0);
  }

  private tailEl: HTMLElement | null = null;

  private observeTail() {
    const last = this.vChildren[this.renderedCount - 1];
    if (!last || !this.observer) {
      this.renderedCount = this.vChildren.length;
      this.render();
      return;
    }
    this.tailEl = last.el;
    this.observer.observe(last.el);
  }

  private maybeRenderMore(entries: IntersectionObserverEntry[]) {
    if (!this.tailEl) return;
    if (!entries.some((e) => e.target === this.tailEl && e.isIntersecting)) return;
    this.tailEl = null;
    this.renderedCount = Math.min(this.vChildren.length, this.renderedCount + RENDER_BATCH);
    this.render();
  }
}
