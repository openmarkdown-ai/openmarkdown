/**
 * In-file search & replace (Mod+F / Mod+H) with Obsidian's document search DOM:
 *
 *   div.document-search-container
 *     div.document-search
 *       div.search-input-container.document-search-input
 *         input[type=search][placeholder="Find..."]
 *         div.document-search-count            "3 of 12" / "12 results" / "No results"
 *       div.document-search-buttons
 *         .clickable-icon.document-search-toggle × Match case / Whole word / Regex [.is-active]
 *         button.document-search-button × Previous / Next / All / Toggle replace
 *         button.document-search-close-button
 *     div.document-replace                     (hidden unless replacing)
 *       div.search-input-container.document-replace-input > input[placeholder="Replace..."]
 *       div.document-replace-buttons > button.document-replace-button "Replace" / "Replace all"
 *
 * Built on @codemirror/search (`search({ createPanel })`), so matches are
 * highlighted with `.cm-searchMatch` and every command stays CM's.
 *
 * Keys inside the panel are taken in a window capture listener, ahead of the
 * app's hotkey dispatcher (which would otherwise run e.g. Mod+Enter as an
 * editor command while the find field has focus): Enter / Shift+Enter next /
 * previous, Enter in Replace replaces the next match, Mod+Enter or Alt+Enter
 * in Replace replaces all (Enter in Replace replaces the current match at once), F3 / Shift+F3 next / previous, Escape closes.
 */
import type { Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { Panel, ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { hostFacet } from "./facets";

const COUNT_LIMIT = 10_000;
const panels = new WeakMap<EditorView, DocumentSearchPanel>();

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/**
 * Replace the current match and select the next one. CodeMirror's `replaceNext` only selects the next
 * match when the selection is not already on one, so the first Enter in Replace replaced nothing.
 */
function replaceCurrent(view: EditorView): boolean {
  const query = getSearchQuery(view.state);
  if (!query.search || !query.valid) return false;
  const { from, to } = view.state.selection.main;
  const r = query.getCursor(view.state, from, to).next();
  const onMatch = !r.done && r.value.from === from && r.value.to === to;
  if (!onMatch && !findNext(view)) return false;
  return replaceNext(view);
}

class DocumentSearchPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private query: SearchQuery;
  private findInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private countEl: HTMLElement;
  private replaceEl: HTMLElement;
  private toggles: Record<"caseSensitive" | "wholeWord" | "regexp", HTMLElement>;
  private replaceToggle: HTMLElement;
  private win: Window;
  private countDirty = true;

  constructor(readonly view: EditorView) {
    const doc = view.dom.ownerDocument;
    this.win = doc.defaultView ?? window;
    this.query = getSearchQuery(view.state);
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, attrs: Record<string, string> = {}) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      parent?.appendChild(e);
      return e;
    };
    const icon = (target: HTMLElement, name: string, fallback: string) => {
      const host = view.state.facet(hostFacet);
      if (host?.setIcon) host.setIcon(target, name);
      else target.textContent = fallback;
    };

    this.dom = el("div", "document-search-container");
    const searchRow = el("div", "document-search", this.dom);
    const findBox = el("div", "search-input-container document-search-input", searchRow);
    this.findInput = el("input", "", findBox, { type: "search", placeholder: "Find...", "main-field": "true", spellcheck: "false", "aria-label": "Find" });
    this.findInput.value = this.query.search;
    this.countEl = el("div", "document-search-count", findBox);

    const buttons = el("div", "document-search-buttons", searchRow);
    const toggle = (key: "caseSensitive" | "wholeWord" | "regexp", label: string, iconName: string, fallback: string) => {
      const t = el("div", "clickable-icon document-search-toggle", buttons, { "aria-label": label, role: "button", tabindex: "0", "data-option": key });
      icon(t, iconName, fallback);
      t.addEventListener("mousedown", (e) => e.preventDefault());
      t.addEventListener("click", () => {
        this.commit({ [key]: !this.query[key] });
        this.findInput.focus();
      });
      return t;
    };
    this.toggles = {
      caseSensitive: toggle("caseSensitive", "Match case", "lucide-case-sensitive", "Aa"),
      wholeWord: toggle("wholeWord", "Match whole word", "lucide-whole-word", "ab"),
      regexp: toggle("regexp", "Use regular expression", "lucide-regex", ".*"),
    };
    const button = (cls: string, label: string, iconName: string | null, text: string, run: () => void, parent = buttons) => {
      const b = el("button", cls, parent, { "aria-label": label });
      if (iconName) icon(b, iconName, text);
      else b.textContent = text;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", run);
      return b;
    };
    button("document-search-button", "Previous", "lucide-arrow-up", "↑", () => findPrevious(view));
    button("document-search-button", "Next", "lucide-arrow-down", "↓", () => findNext(view));
    button("document-search-button", "Select all matches", "lucide-text-cursor-input", "All", () => {
      if (selectMatches(view)) view.focus();
    });
    this.replaceToggle = button("document-search-button mod-replace-toggle", "Toggle replace", "lucide-replace", "Replace", () => {
      this.setReplaceVisible(this.replaceEl.hidden);
      (this.replaceEl.hidden ? this.findInput : this.replaceInput).focus();
    });
    button("document-search-close-button", "Close", "lucide-x", "×", () => this.close());

    this.replaceEl = el("div", "document-replace", this.dom);
    const replaceBox = el("div", "search-input-container document-replace-input", this.replaceEl);
    this.replaceInput = el("input", "", replaceBox, { type: "text", placeholder: "Replace...", spellcheck: "false", "aria-label": "Replace" });
    this.replaceInput.value = this.query.replace;
    const replaceButtons = el("div", "document-replace-buttons", this.replaceEl);
    button("document-replace-button", "Replace", null, "Replace", () => replaceCurrent(view), replaceButtons);
    button("document-replace-button", "Replace all", null, "Replace all", () => replaceAll(view), replaceButtons);
    this.replaceEl.hidden = true;

    this.findInput.addEventListener("input", () => this.commit({ search: this.findInput.value }));
    this.replaceInput.addEventListener("input", () => this.commit({ replace: this.replaceInput.value }));
    this.onKeyDown = this.onKeyDown.bind(this);
    panels.set(view, this);
    this.syncToggles();
  }

  mount() {
    this.win.addEventListener("keydown", this.onKeyDown, true);
    this.findInput.select();
    this.renderCount();
  }

  destroy() {
    this.win.removeEventListener("keydown", this.onKeyDown, true);
    if (panels.get(this.view) === this) panels.delete(this.view);
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const e of tr.effects) {
        if (e.is(setSearchQuery) && !e.value.eq(this.query)) this.setQuery(e.value);
      }
    }
    if (update.docChanged || update.selectionSet || update.transactions.some((t) => t.effects.some((e) => e.is(setSearchQuery)))) {
      this.countDirty = true;
      this.renderCount();
    }
  }

  // internal
  setReplaceVisible(visible: boolean) {
    this.replaceEl.hidden = !visible;
    this.dom.classList.toggle("mod-replace", visible);
    this.replaceToggle.classList.toggle("is-active", visible);
  }

  // internal
  focus(replace: boolean) {
    const target = replace && this.findInput.value ? this.replaceInput : this.findInput;
    target.focus();
    target.select();
  }

  private setQuery(query: SearchQuery) {
    this.query = query;
    if (this.findInput.value !== query.search) this.findInput.value = query.search;
    if (this.replaceInput.value !== query.replace) this.replaceInput.value = query.replace;
    this.syncToggles();
  }

  private commit(change: Partial<{ search: string; replace: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }>) {
    const q = this.query;
    const next = new SearchQuery({
      search: change.search ?? q.search,
      replace: change.replace ?? q.replace,
      caseSensitive: change.caseSensitive ?? q.caseSensitive,
      wholeWord: change.wholeWord ?? q.wholeWord,
      regexp: change.regexp ?? q.regexp,
      literal: q.literal,
    });
    if (next.eq(q)) return;
    this.query = next;
    this.syncToggles();
    this.view.dispatch({ effects: setSearchQuery.of(next) });
  }

  private syncToggles() {
    for (const [key, t] of Object.entries(this.toggles) as ["caseSensitive" | "wholeWord" | "regexp", HTMLElement][]) {
      const on = !!this.query[key];
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-pressed", String(on));
    }
  }

  private renderCount() {
    if (!this.countDirty) return;
    this.countDirty = false;
    const q = this.query;
    const input = this.findInput.parentElement!;
    input.classList.toggle("is-invalid", !!q.search && !q.valid);
    if (!q.search) {
      this.countEl.textContent = "";
      this.dom.classList.remove("has-no-results");
      return;
    }
    if (!q.valid) {
      this.countEl.textContent = "Invalid pattern";
      this.dom.classList.add("has-no-results");
      return;
    }
    const state = this.view.state;
    const main = state.selection.main;
    const cursor = q.getCursor(state.doc);
    let total = 0;
    let current = 0;
    for (let r = cursor.next(); !r.done; r = cursor.next()) {
      total++;
      if (r.value.from === main.from && r.value.to === main.to) current = total;
      if (total >= COUNT_LIMIT) break;
    }
    const more = total >= COUNT_LIMIT ? "+" : "";
    this.dom.classList.toggle("has-no-results", total === 0);
    this.countEl.textContent = total === 0 ? "No results" : current ? `${current} of ${total}${more}` : `${total}${more} ${total === 1 ? "result" : "results"}`;
  }

  private close() {
    closeSearchPanel(this.view);
    this.view.focus();
  }

  private onKeyDown(evt: KeyboardEvent) {
    const target = evt.target as Node | null;
    if (!target || !this.dom.contains(target) || evt.isComposing) return;
    const mod = isMac() ? evt.metaKey : evt.ctrlKey;
    const inReplace = target === this.replaceInput;
    const consume = () => {
      evt.preventDefault();
      evt.stopPropagation();
    };
    if (evt.key === "Escape") {
      consume();
      this.close();
    } else if (evt.key === "Enter" && (target === this.findInput || inReplace)) {
      consume();
      if (inReplace) {
        if (mod || evt.altKey) replaceAll(this.view);
        else replaceCurrent(this.view);
      } else if (evt.shiftKey) findPrevious(this.view);
      else findNext(this.view);
    } else if (evt.key === "F3") {
      consume();
      if (evt.shiftKey) findPrevious(this.view);
      else findNext(this.view);
    } else if ((evt.key === "g" || evt.key === "G") && mod && !evt.altKey) {
      consume();
      if (evt.shiftKey) findPrevious(this.view);
      else findNext(this.view);
    }
  }
}

/** Open (or focus) the document search for `view`; `replace` shows the Replace row. */
export function openDocumentSearch(view: EditorView, replace = false): boolean {
  const wasOpen = searchPanelOpen(view.state);
  openSearchPanel(view);
  const panel = panels.get(view);
  if (!panel) return false;
  panel.setReplaceVisible(replace);
  if (wasOpen || replace) panel.focus(replace);
  return true;
}

export function searchPanel(): Extension {
  return [
    search({ top: true, createPanel: (view) => new DocumentSearchPanel(view) }),
    // F3 / Shift+F3 from the editor while the panel is open.
    keymap.of([
      { key: "F3", run: (v) => searchPanelOpen(v.state) && findNext(v), shift: (v) => searchPanelOpen(v.state) && findPrevious(v), preventDefault: false },
    ]),
  ];
}
