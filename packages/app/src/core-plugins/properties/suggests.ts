/** Suggest popovers used by the metadata editor: property names, values, and `[[` links. */
import { AbstractInputSuggest } from "../../obsidian/ui/suggest";
import { setIcon } from "../../obsidian/ui/icons";
import { prepareFuzzySearch, renderMatches } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";
import { compareNames } from "../global-search/engine";
import { iconForType } from "./types";

const LIMIT = 50;

/** Caret offset within an input or a plain-text contenteditable. */
export function caretOffset(el: HTMLInputElement | HTMLDivElement): number {
  if (el instanceof HTMLInputElement) return el.selectionStart ?? el.value.length;
  const sel = el.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return (el.textContent ?? "").length;
  const range = sel.getRangeAt(0).cloneRange();
  const pre = el.ownerDocument.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

export function setCaret(el: HTMLInputElement | HTMLDivElement, offset: number) {
  if (el instanceof HTMLInputElement) {
    el.setSelectionRange(offset, offset);
    return;
  }
  const doc = el.ownerDocument;
  const sel = doc.getSelection();
  if (!sel) return;
  let remaining = offset;
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  const range = doc.createRange();
  while ((node = walker.nextNode())) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      range.setStart(node, remaining);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= len;
  }
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function getValue(el: HTMLInputElement | HTMLDivElement): string {
  return el instanceof HTMLInputElement ? el.value : (el.textContent ?? "");
}

function setValue(el: HTMLInputElement | HTMLDivElement, v: string) {
  if (el instanceof HTMLInputElement) el.value = v;
  else el.textContent = v;
}

interface LinkItem {
  file: TFile | null;
  path: string;
  alias?: string;
  score: number;
  matches: [number, number][] | null;
}

/** `[[` completion inside a text value. */
export class LinkValueSuggest extends AbstractInputSuggest<LinkItem> {
  constructor(
    app: any,
    private el: HTMLInputElement | HTMLDivElement,
    private sourcePath: () => string,
  ) {
    super(app, el);
    this.limit = LIMIT;
  }

  protected getSuggestions(value: string): LinkItem[] {
    const before = value.slice(0, caretOffset(this.el));
    const open = before.lastIndexOf("[[");
    if (open < 0 || before.indexOf("]]", open) !== -1) return [];
    const q = before.slice(open + 2);
    if (q.includes("\n") || q.includes("|")) return [];
    const app = this.app as any;
    const all: { file: TFile | null; path: string; alias?: string }[] = app.metadataCache.getLinkSuggestions?.() ?? [];
    if (!q) {
      return all
        .filter((s) => s.file && !s.alias && s.file.extension === "md")
        .slice(0, LIMIT)
        .map((s) => ({ ...s, score: 0, matches: null }));
    }
    const fuzzy = prepareFuzzySearch(q);
    const out: LinkItem[] = [];
    for (const s of all) {
      const text = s.alias ?? (s.file ? (s.file.extension === "md" ? s.file.path.replace(/\.md$/, "") : s.file.path) : s.path);
      const r = fuzzy(text);
      if (r) out.push({ ...s, score: r.score, matches: r.matches });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, LIMIT);
  }

  renderSuggestion(item: LinkItem, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createDiv({ cls: "suggestion-content" });
    const title = content.createDiv({ cls: "suggestion-title" });
    const text = item.alias ?? (item.file ? (item.file.extension === "md" ? item.file.path.replace(/\.md$/, "") : item.file.path) : item.path);
    renderMatches(title, text, item.matches);
    if (item.alias && item.file) content.createDiv({ cls: "suggestion-note", text: item.file.path });
    if (!item.file) content.createDiv({ cls: "suggestion-note", text: "Not created yet" });
    if (item.alias) setIcon(el.createDiv({ cls: "suggestion-aux" }).createDiv({ cls: "suggestion-flair" }), "lucide-forward");
  }

  override selectSuggestion(item: LinkItem, _evt: MouseEvent | KeyboardEvent): void {
    const app = this.app as any;
    const value = getValue(this.el);
    const caret = caretOffset(this.el);
    const open = value.slice(0, caret).lastIndexOf("[[");
    if (open < 0) return;
    let end = caret;
    const close = value.indexOf("]]", caret);
    if (close !== -1 && !value.slice(caret, close).includes("[[")) end = close + 2;
    const linktext = item.file ? app.metadataCache.fileToLinktext(item.file, this.sourcePath(), true) : item.path;
    const link = `[[${linktext}${item.alias ? `|${item.alias}` : ""}]]`;
    setValue(this.el, value.slice(0, open) + link + value.slice(end));
    setCaret(this.el, open + link.length);
    this.close();
    this.el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/** Plain value completion (existing values of a list property, or tags). */
export class ListValueSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: any,
    private el: HTMLInputElement | HTMLDivElement,
    private source: () => string[],
    private onPick: (value: string) => void,
  ) {
    super(app, el);
    this.limit = LIMIT;
  }

  protected getSuggestions(query: string): string[] {
    const q = query.trim().replace(/^#/, "").toLowerCase();
    if (query.includes("[[")) return [];
    const values = this.source();
    return values.filter((v) => v.toLowerCase().includes(q) && v.toLowerCase() !== q).slice(0, LIMIT);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    const q = getValue(this.el).trim().replace(/^#/, "").toLowerCase();
    const i = q ? value.toLowerCase().indexOf(q) : -1;
    renderMatches(el, value, i >= 0 ? [[i, i + q.length]] : null);
  }

  override selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
    this.close();
    this.onPick(value);
  }
}

export interface PropertyInfo {
  name: string;
  type: string;
  count: number;
}

/** Property names known to the vault (`metadataTypeManager`). */
export class PropertyKeySuggest extends AbstractInputSuggest<PropertyInfo> {
  constructor(
    app: any,
    private el: HTMLInputElement,
    private exclude: () => Set<string>,
    private onPick: (info: PropertyInfo) => void,
    /** Escape while the list is open: after closing it, also leave the name (the row's own Escape). */
    onEscape?: () => void,
  ) {
    super(app, el);
    this.limit = LIMIT;
    if (onEscape) {
      // Ahead of the base class's Escape, which only closes the list and swallows the key.
      const handler = this.scope.register([], "Escape", (evt) => {
        if (evt.isComposing) return;
        this.close();
        onEscape();
        return false;
      });
      this.scope.keys.splice(this.scope.keys.indexOf(handler as (typeof this.scope.keys)[number]), 1);
      this.scope.keys.unshift(handler as (typeof this.scope.keys)[number]);
    }
  }

  protected getSuggestions(query: string): PropertyInfo[] {
    const app = this.app as any;
    const q = query.trim().toLowerCase();
    const excluded = this.exclude();
    const all = Object.values(app.metadataTypeManager?.getAllProperties?.() ?? {}) as PropertyInfo[];
    const list = all.filter((p) => !excluded.has(p.name.toLowerCase()) && p.name.toLowerCase().includes(q));
    list.sort((a, b) => {
      const as = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bs = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return as - bs || b.count - a.count || compareNames(a.name, b.name);
    });
    return list.slice(0, LIMIT);
  }

  renderSuggestion(info: PropertyInfo, el: HTMLElement): void {
    el.addClass("mod-complex");
    setIcon(el.createDiv({ cls: "suggestion-icon" }), iconForType(info.type));
    const content = el.createDiv({ cls: "suggestion-content" });
    const q = this.el.value.trim().toLowerCase();
    const i = q ? info.name.toLowerCase().indexOf(q) : -1;
    renderMatches(content.createDiv({ cls: "suggestion-title" }), info.name, i >= 0 ? [[i, i + q.length]] : null);
    el.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: "suggestion-flair", text: String(info.count) });
  }

  override selectSuggestion(info: PropertyInfo, _evt: MouseEvent | KeyboardEvent): void {
    this.el.value = info.name;
    this.close();
    this.onPick(info);
  }
}
