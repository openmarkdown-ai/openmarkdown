/**
 * The popover under the search box: search operators with their
 * descriptions, then tags, property names/values and files once an operator
 * is typed, and the search history when the box is empty.
 */
import { renderMatches } from "../../obsidian/util";
import { AbstractInputSuggest } from "../../obsidian/ui/suggest";
import { compareNames } from "./engine";

export interface QuerySuggestion {
  kind: "operator" | "tag" | "property" | "value" | "file" | "folder" | "history" | "clear-history";
  /** Text inserted in place of the token under the caret. */
  insert: string;
  title: string;
  note?: string;
  matches?: [number, number][];
}

export const SEARCH_OPERATORS: { op: string; desc: string }[] = [
  { op: "path:", desc: "match path of the file" },
  { op: "file:", desc: "match file name" },
  { op: "tag:", desc: "search for tags" },
  { op: "line:", desc: "search keywords on same line" },
  { op: "section:", desc: "search keywords under same heading" },
  { op: "[property]", desc: "match property" },
  { op: "content:", desc: "match file content" },
  { op: "block:", desc: "search keywords in same block" },
  { op: "task:", desc: "search keywords in tasks" },
  { op: "task-todo:", desc: "search keywords in uncompleted tasks" },
  { op: "task-done:", desc: "search keywords in completed tasks" },
  { op: "match-case:", desc: "case-sensitive match" },
  { op: "ignore-case:", desc: "case-insensitive match" },
];

const LIMIT = 30;

export class SearchQuerySuggest extends AbstractInputSuggest<QuerySuggestion> {
  private inputEl: HTMLInputElement;
  constructor(
    app: any,
    inputEl: HTMLInputElement,
    private getHistory: () => string[],
    private clearHistory: () => void,
  ) {
    super(app, inputEl);
    this.inputEl = inputEl;
    this.suggestEl.addClass("mod-search-suggestion");
    this.limit = LIMIT * 2;
  }

  /** The token the caret is in: [start, end) in the input value. */
  private token(): { start: number; end: number; text: string } {
    const value = this.inputEl.value;
    const caret = this.inputEl.selectionStart ?? value.length;
    let start = caret;
    let inQuote = false;
    for (let i = 0; i < caret; i++) if (value[i] === '"') inQuote = !inQuote;
    while (start > 0) {
      const ch = value[start - 1]!;
      if (!inQuote && (ch === " " || ch === "(" || ch === ")")) break;
      if (inQuote && ch === '"' && start - 1 < caret) {
        // include the opening quote and whatever operator precedes it
        start--;
        while (start > 0 && !/[\s()]/.test(value[start - 1]!)) start--;
        break;
      }
      start--;
    }
    let end = caret;
    while (end < value.length && !/[\s()]/.test(value[end]!)) end++;
    return { start, end, text: value.slice(start, caret) };
  }

  protected getSuggestions(query: string): QuerySuggestion[] {
    const app = this.app as any;
    if (query.trim() === "") {
      const out: QuerySuggestion[] = SEARCH_OPERATORS.slice(0, 6).map((o) => ({ kind: "operator" as const, insert: o.op === "[property]" ? "[" : o.op, title: o.op, note: o.desc }));
      const history = this.getHistory();
      if (history.length) {
        for (const h of history) out.push({ kind: "history", insert: h, title: h });
        out.push({ kind: "clear-history", insert: "", title: "Clear history" });
      }
      return out;
    }
    const { text } = this.token();
    const bare = text.replace(/^-/, "");
    const lower = bare.toLowerCase();

    // tag:
    const tagM = /^tag:#?(.*)$/i.exec(bare);
    if (tagM) {
      const q = tagM[1]!.toLowerCase();
      const tags = Object.keys(app.metadataCache.getTags?.() ?? {}).sort(compareNames);
      return tags
        .filter((t) => t.slice(1).toLowerCase().includes(q))
        .slice(0, LIMIT)
        .map((t) => ({ kind: "tag" as const, insert: `${text.startsWith("-") ? "-" : ""}tag:${t}`, title: t }));
    }
    // [property or [property:value
    const propM = /^\[([^\]:]*)(?::([^\]]*))?$/.exec(bare);
    if (propM) {
      const key = propM[1]!;
      if (propM[2] === undefined) {
        const props = Object.values(app.metadataTypeManager?.getAllProperties?.() ?? {}) as { name: string; count: number }[];
        return props
          .filter((p) => p.name.toLowerCase().includes(key.toLowerCase()))
          .sort((a, b) => compareNames(a.name, b.name))
          .slice(0, LIMIT)
          .map((p) => ({ kind: "property" as const, insert: `${text.startsWith("-") ? "-" : ""}[${p.name}:`, title: p.name, note: String(p.count) }));
      }
      const vq = propM[2].toLowerCase();
      const values: string[] = app.metadataCache.getFrontmatterPropertyValuesForKey?.(key) ?? [];
      return values
        .filter((v) => v.toLowerCase().includes(vq))
        .slice(0, LIMIT)
        .map((v) => ({ kind: "value" as const, insert: `${text.startsWith("-") ? "-" : ""}[${key}:${/[\s()]/.test(v) ? `"${v}"` : v}]`, title: v }));
    }
    // file: / path:
    const fileM = /^(file|path):"?(.*)$/i.exec(bare);
    if (fileM) {
      const op = fileM[1]!.toLowerCase();
      const q = fileM[2]!.replace(/"$/, "").toLowerCase();
      const items: QuerySuggestion[] = [];
      if (op === "path") {
        for (const folder of app.vault.getAllFolders?.(false) ?? []) {
          if (folder.path.toLowerCase().includes(q)) items.push({ kind: "folder", insert: `${text.startsWith("-") ? "-" : ""}path:"${folder.path}"`, title: folder.path });
          if (items.length >= LIMIT) break;
        }
      }
      for (const f of app.vault.getFiles()) {
        if (items.length >= LIMIT) break;
        const target = op === "file" ? f.name : f.path;
        if (!target.toLowerCase().includes(q)) continue;
        const v = /[\s()]/.test(target) ? `"${target}"` : target;
        items.push({ kind: "file", insert: `${text.startsWith("-") ? "-" : ""}${op}:${v}`, title: target });
      }
      return items;
    }
    // operator prefix
    if (bare.length > 0 && !bare.includes(":") && !bare.startsWith('"') && !bare.startsWith("/")) {
      const ops = SEARCH_OPERATORS.filter((o) => o.op.startsWith(lower) || (o.op === "[property]" && lower.startsWith("[")));
      if (ops.length) {
        return ops.map((o) => ({
          kind: "operator" as const,
          insert: (text.startsWith("-") ? "-" : "") + (o.op === "[property]" ? "[" : o.op),
          title: o.op,
          note: o.desc,
          matches: o.op.startsWith(lower) ? [[0, lower.length]] : undefined,
        }));
      }
    }
    return [];
  }

  renderSuggestion(value: QuerySuggestion, el: HTMLElement): void {
    el.addClass("search-suggest-item");
    if (value.kind === "operator") {
      el.addClass("mod-group");
      const title = el.createSpan({ cls: "search-suggest-item-operator" });
      renderMatches(title, value.title, value.matches ?? null);
      el.createSpan({ cls: "search-suggest-info-text", text: value.note ?? "" });
      return;
    }
    if (value.kind === "clear-history") {
      el.addClass("mod-clear-history");
      el.createSpan({ cls: "search-suggest-info-text", text: value.title });
      return;
    }
    if (value.kind === "history") el.addClass("mod-history");
    el.createSpan({ text: value.title });
    if (value.note) el.createSpan({ cls: "suggestion-flair search-suggest-info-text", text: value.note });
  }

  override selectSuggestion(value: QuerySuggestion, evt: MouseEvent | KeyboardEvent): void {
    if (value.kind === "clear-history") {
      this.clearHistory();
      this.close();
      return;
    }
    const input = this.inputEl;
    if (value.kind === "history") {
      input.value = value.insert;
    } else {
      const { start, end } = this.token();
      const before = input.value.slice(0, start);
      const after = input.value.slice(end);
      const closesToken = value.kind === "tag" || value.kind === "value" || value.kind === "file" || value.kind === "folder";
      const insert = value.insert + (closesToken && !after.startsWith(" ") ? " " : "");
      input.value = before + insert + after;
      const caret = before.length + insert.length;
      input.setSelectionRange(caret, caret);
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (value.kind === "history") this.close();
    void evt;
  }
}
