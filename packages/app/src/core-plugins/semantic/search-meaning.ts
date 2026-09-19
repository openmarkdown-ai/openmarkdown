/**
 * Search by meaning: a toggle in the Search view. Keyword search stays the
 * default and keeps its results; with the toggle on, a "By meaning" section
 * above them lists the passages closest in meaning to the query, and the
 * keyword results get a "Keyword matches" label so the two are never confused.
 */
import { MarkdownView } from "../../obsidian/markdown/markdown-view";
import { setIcon } from "../../obsidian/ui/icons";
import { debounce } from "../../obsidian/util";
import type { GlobalSearchView, SearchViewExtension } from "../global-search/search-view";
import { getAi, groupByNote, type SemanticIndex } from "./engine";
import { engineLabel } from "./related-view";
import { renderNoteHits } from "./results-ui";

const STORAGE_KEY = "semantic-search-by-meaning";

interface ViewParts {
  toggleEl: HTMLElement;
  sectionEl: HTMLElement;
  headerEl: HTMLElement;
  countEl: HTMLElement;
  engineEl: HTMLElement;
  listEl: HTMLElement;
  keywordLabelEl: HTMLElement;
  run: number;
  lastQuery: string;
  request: ReturnType<typeof debounce>;
}

/** Plain words from a search query: operators (`path:`, `tag:`), quotes and parentheses dropped. */
export function meaningText(query: string): string {
  return query
    .replace(/-?\b[a-z-]+:("[^"]*"|\S+)/gi, " ")
    .replace(/\/(?:[^/\\]|\\.)+\/[a-z]*/g, " ")
    .replace(/["()]/g, " ")
    .replace(/\b(OR|AND)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class SearchByMeaning implements SearchViewExtension {
  private parts = new WeakMap<GlobalSearchView, ViewParts>();

  constructor(
    private app: any,
    private index: SemanticIndex,
    private showScores: () => boolean,
    private steppedAside: () => boolean,
  ) {}

  isOn(): boolean {
    return this.app.loadLocalStorage(STORAGE_KEY) === true;
  }

  // internal (used by the command and tests)
  setOn(view: GlobalSearchView, on: boolean) {
    this.app.saveLocalStorage(STORAGE_KEY, on ? true : null);
    const p = this.parts.get(view);
    if (!p) return;
    p.lastQuery = "";
    this.apply(view, p);
  }

  attach(view: GlobalSearchView) {
    if (this.parts.has(view) || !view.settingsButtonEl) return;
    const toggleEl = createDiv({ cls: "clickable-icon semantic-search-toggle", attr: { "aria-label": "Search by meaning" } });
    setIcon(toggleEl, "lucide-sparkles");
    view.settingsButtonEl.before(toggleEl);
    const sectionEl = createDiv({ cls: "semantic-search-section" });
    const headerEl = sectionEl.createDiv({ cls: "tree-item-self semantic-search-header" });
    headerEl.createDiv({ cls: "tree-item-inner", text: "By meaning" });
    const countEl = headerEl.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair" });
    const engineEl = sectionEl.createDiv({ cls: "semantic-search-engine" });
    const listEl = sectionEl.createDiv({ cls: "search-result-container semantic-search-list" });
    view.searchInfoEl.after(sectionEl);
    const keywordLabelEl = createDiv({ cls: "tree-item-self semantic-keyword-label" });
    keywordLabelEl.createDiv({ cls: "tree-item-inner", text: "Keyword matches" });
    sectionEl.after(keywordLabelEl);
    const parts: ViewParts = {
      toggleEl,
      sectionEl,
      headerEl,
      countEl,
      engineEl,
      listEl,
      keywordLabelEl,
      run: 0,
      lastQuery: "",
      request: debounce(() => void this.runQuery(view, parts), 450, true),
    };
    toggleEl.addEventListener("click", () => this.setOn(view, !this.isOn()));
    this.parts.set(view, parts);
    this.apply(view, parts);
  }

  detach(view: GlobalSearchView) {
    const p = this.parts.get(view);
    if (!p) return;
    p.request.cancel();
    p.toggleEl.remove();
    p.sectionEl.remove();
    p.keywordLabelEl.remove();
    this.parts.delete(view);
  }

  onQuery(view: GlobalSearchView) {
    const p = this.parts.get(view);
    if (p) this.apply(view, p);
  }

  /** Re-runs every attached view (index updated, AI settings changed). */
  refreshAll(views: GlobalSearchView[]) {
    for (const v of views) {
      const p = this.parts.get(v);
      if (!p) continue;
      p.lastQuery = "";
      this.apply(v, p);
    }
  }

  private apply(view: GlobalSearchView, p: ViewParts) {
    const available = !!getAi(this.app)?.isAvailable("related", "embed") && !this.steppedAside();
    const on = this.isOn() && available;
    p.toggleEl.toggle(available);
    p.toggleEl.toggleClass("is-active", on);
    const query = meaningText(view.getQuery());
    p.sectionEl.toggle(on && !!query);
    p.keywordLabelEl.toggle(on && !!query);
    view.contentEl.toggleClass("mod-search-by-meaning", on);
    if (!on || !query) {
      p.run++;
      p.lastQuery = "";
      p.listEl.empty();
      return;
    }
    if (query === p.lastQuery) return;
    p.request();
  }

  private async runQuery(view: GlobalSearchView, p: ViewParts) {
    const query = meaningText(view.getQuery());
    if (!query) return;
    p.lastQuery = query;
    const run = ++p.run;
    p.sectionEl.addClass("is-loading");
    p.engineEl.setText(this.index.isQueryable() ? "" : statusHint(this.index));
    try {
      const hits = await this.index.searchText(query, { kind: "query", k: 60 });
      if (run !== p.run) return;
      const notes = groupByNote(hits, 15, 2);
      const texts = await this.index.passageText(notes.flatMap((n) => n.passages.map((x) => x.key)));
      if (run !== p.run) return;
      p.countEl.setText(String(notes.length));
      p.engineEl.setText(notes.length ? engineLabel(this.index.getStatus().engine) : this.index.isQueryable() ? "Nothing close in meaning." : statusHint(this.index));
      renderNoteHits(p.listEl, notes, {
        app: this.app,
        hoverParent: view,
        hoverSource: "search",
        sourcePath: "",
        texts,
        targetEditor: () => this.app.workspace.getActiveViewOfType(MarkdownView),
        showScores: this.showScores(),
      });
    } catch (e) {
      if (run !== p.run) return;
      p.lastQuery = "";
      p.listEl.empty();
      p.engineEl.setText((e as Error)?.message ?? String(e));
    } finally {
      if (run === p.run) p.sectionEl.removeClass("is-loading");
    }
  }
}

function statusHint(index: SemanticIndex): string {
  const s = index.getStatus();
  if (s.state === "indexing" || s.state === "loading") return "The index is still being built; results will improve.";
  return s.message || "No notes are indexed yet.";
}
