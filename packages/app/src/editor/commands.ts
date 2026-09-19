/**
 * Obsidian's editor commands, as functions of an `Editor` so the command
 * palette (`editorCallback`) and hotkeys can share them.
 *
 * `EDITOR_COMMANDS` lists them with Obsidian's command ids (`editor:toggle-bold`
 * …), names and default hotkeys; the app registers them with its command
 * manager. `editorKeymap()` binds the same hotkeys directly in CM6 for the
 * standalone editor (the app may instead route hotkeys through its own
 * Keymap/Scope and pass `keymap: false` to createMarkdownEditor).
 */
import { EditorSelection } from "@codemirror/state";
import type { ChangeSpec, EditorState, SelectionRange, StateCommand } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  deleteLine,
  indentLess,
  indentMore,
  moveLineDown,
  moveLineUp,
  selectParentSyntax,
} from "@codemirror/commands";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import type { SyntaxNode } from "@lezer/common";
import type { Editor } from "./editor-base";
import { ofmTree } from "./syntax/language";
import { OFM } from "./syntax/ofm";
import { foldAllCommand, foldLessCommand, foldMoreCommand, toggleFoldCommand, unfoldAllCommand } from "./live-preview/fold";
import { clickableTokenAt } from "./live-preview/links";
import { hostFacet, sourcePathOf } from "./facets";
import { renumberOrderedLists, restartNestedNumbering } from "./lists";

type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";
export interface Hotkey {
  modifiers: Modifier[];
  key: string;
}

export interface EditorCommandSpec {
  id: string;
  name: string;
  icon?: string;
  hotkeys?: Hotkey[];
  editorCallback: (editor: Editor) => void;
}

function viewOf(editor: Editor): EditorView {
  const cm = (editor as unknown as { cm?: EditorView }).cm;
  if (!cm) throw new Error("This command needs a CodeMirror 6 editor");
  return cm;
}

function run(cmd: StateCommand | ((view: EditorView) => boolean)) {
  return (editor: Editor) => {
    const view = viewOf(editor);
    (cmd as (v: EditorView) => boolean)(view);
  };
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

export type FormatType = "bold" | "italic" | "strikethrough" | "highlight" | "code" | "comment" | "math";

const FORMATS: Record<FormatType, { open: string; node: string; mark: string; alt?: string }> = {
  bold: { open: "**", node: "StrongEmphasis", mark: "EmphasisMark", alt: "__" },
  italic: { open: "*", node: "Emphasis", mark: "EmphasisMark", alt: "_" },
  strikethrough: { open: "~~", node: "Strikethrough", mark: "StrikethroughMark" },
  highlight: { open: "==", node: OFM.Highlight, mark: OFM.HighlightMark },
  code: { open: "`", node: "InlineCode", mark: "CodeMark" },
  comment: { open: "%%", node: OFM.ObsidianComment, mark: OFM.ObsidianCommentMark },
  math: { open: "$", node: OFM.InlineMath, mark: OFM.MathMark },
};

function enclosing(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  const tree = ofmTree(state);
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(from, side); n; n = n.parent) {
      if (n.name === name && n.from <= from && n.to >= to) return n;
    }
  }
  return null;
}

/** Obsidian's toggleMarkdownFormatting: wrap, unwrap, or insert an empty pair. */
export function toggleFormatting(view: EditorView, type: FormatType): boolean {
  const f = FORMATS[type];
  const state = view.state;
  const tr = state.changeByRange((range) => {
    let { from, to } = range;
    // Multi-line comment/math selections use the block form.
    if ((type === "comment" || type === "math") && state.doc.lineAt(from).number !== state.doc.lineAt(to).number) {
      const open = type === "comment" ? "%%" : "$$";
      const text = state.sliceDoc(from, to);
      if (text.startsWith(open + "\n") && text.endsWith("\n" + open)) {
        const inner = text.slice(open.length + 1, text.length - open.length - 1);
        return { changes: { from, to, insert: inner }, range: EditorSelection.range(from, from + inner.length) };
      }
      const insert = `${open}\n${text}\n${open}`;
      return { changes: { from, to, insert }, range: EditorSelection.range(from + open.length + 1, from + open.length + 1 + text.length) };
    }
    const node = enclosing(state, from, to, f.node);
    if (node) {
      const marks = node.getChildren(f.mark);
      // Bold inside `***x***` resolves to the inner node; remove only its marks.
      const first = marks[0], last = marks[marks.length - 1];
      if (first && last && first !== last) {
        const changes: ChangeSpec[] = [
          { from: first.from, to: first.to },
          { from: last.from, to: last.to },
        ];
        const openLen = first.to - first.from;
        const mapFrom = Math.max(first.from, Math.min(from - openLen, last.from - openLen));
        const mapTo = Math.max(mapFrom, Math.min(to - openLen, last.from - openLen));
        return { changes, range: EditorSelection.range(range.anchor === range.from ? mapFrom : mapTo, range.anchor === range.from ? mapTo : mapFrom) };
      }
    }
    if (range.empty) {
      const word = state.wordAt(from);
      if (word && type !== "code" && type !== "math" && type !== "comment") {
        from = word.from;
        to = word.to;
      } else {
        const insert = f.open + f.open;
        return { changes: { from, insert }, range: EditorSelection.cursor(from + f.open.length) };
      }
    }
    // Text already wrapped in the markers (selection includes them): unwrap.
    const text = state.sliceDoc(from, to);
    if (text.length >= f.open.length * 2 && text.startsWith(f.open) && text.endsWith(f.open) && !(type === "italic" && text.startsWith("**") && !text.startsWith("***"))) {
      const inner = text.slice(f.open.length, text.length - f.open.length);
      return { changes: { from, to, insert: inner }, range: EditorSelection.range(from, from + inner.length) };
    }
    // Keep surrounding whitespace outside the markers.
    const lead = text.length - text.trimStart().length;
    const trail = text.length - text.trimEnd().length;
    const a = from + lead, b = to - trail;
    if (a >= b) return { changes: { from, insert: f.open + f.open }, range: EditorSelection.cursor(from + f.open.length) };
    return {
      changes: [
        { from: a, insert: f.open },
        { from: b, insert: f.open },
      ],
      range: EditorSelection.range(a + f.open.length, b + f.open.length),
    };
  });
  view.dispatch(state.update(tr, { userEvent: "input.format", scrollIntoView: true }));
  return true;
}

/** Remove bold/italic/strike/highlight/code/comment/math markup inside the selection. */
export function clearFormatting(view: EditorView): boolean {
  const state = view.state;
  const tree = ofmTree(state);
  const changes: ChangeSpec[] = [];
  const markNames = new Set(["EmphasisMark", "StrikethroughMark", OFM.HighlightMark, "CodeMark", OFM.ObsidianCommentMark, OFM.MathMark]);
  const parents = new Set(["Emphasis", "StrongEmphasis", "Strikethrough", OFM.Highlight, "InlineCode", OFM.ObsidianComment, OFM.InlineMath]);
  for (const r of state.selection.ranges) {
    const from = r.empty ? state.doc.lineAt(r.from).from : r.from;
    const to = r.empty ? state.doc.lineAt(r.to).to : r.to;
    tree.iterate({
      from,
      to,
      enter(n) {
        if (markNames.has(n.name) && n.node.parent && parents.has(n.node.parent.name)) {
          const p = n.node.parent;
          if (p.from >= from - 3 && p.to <= to + 3) changes.push({ from: n.from, to: n.to });
        }
      },
    });
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input.format" });
  return true;
}

// ---------------------------------------------------------------------------
// Line-prefix commands (lists, quotes, headings, tasks)
// ---------------------------------------------------------------------------

const LIST_RE = /^([ \t]*)((?:>[ \t]?)*)([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(?:\[(.)\]([ \t]+|$))?/;
const QUOTE_RE = /^([ \t]*)((?:>[ \t]?)+)/;

interface LineInfo {
  indent: string;
  quote: string;
  bullet?: string;
  number?: number;
  delim?: string;
  task?: string;
  /** Offset (in line) where content starts. */
  contentStart: number;
  /** Offset where the list marker starts (after indent + quote). */
  markerStart: number;
}

export function parseListLine(text: string): LineInfo | null {
  const m = LIST_RE.exec(text);
  if (!m) return null;
  return {
    indent: m[1]! + m[3]!,
    quote: m[2]!,
    bullet: m[4],
    number: m[5] !== undefined ? Number(m[5]) : undefined,
    delim: m[6],
    task: m[8],
    contentStart: m[0].length,
    markerStart: m[1]!.length + m[2]!.length + m[3]!.length,
  };
}

function selectedLines(state: EditorState): number[] {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    let b = state.doc.lineAt(r.to).number;
    if (b > a && r.to === state.doc.line(b).from) b--;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return [...lines].sort((x, y) => x - y);
}

function mapLines(view: EditorView, fn: (text: string, n: number, index: number, all: string[]) => string | null, userEvent = "input") {
  const state = view.state;
  const lines = selectedLines(state);
  const texts = lines.map((n) => state.doc.line(n).text);
  const changes: ChangeSpec[] = [];
  lines.forEach((n, i) => {
    const line = state.doc.line(n);
    const next = fn(line.text, n, i, texts);
    if (next !== null && next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  });
  if (!changes.length) return false;
  const changeSet = state.changes(changes);
  // Keep cursors at the same distance from the end of their line (after the prefix change).
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => {
      const map = (pos: number) => {
        const line = state.doc.lineAt(pos);
        const fromEnd = line.to - pos;
        const newLineEnd = changeSet.mapPos(line.to, 1);
        const newLine = changeSet.apply(state.doc).lineAt(newLineEnd);
        return Math.max(newLine.from, newLineEnd - fromEnd);
      };
      return EditorSelection.range(map(r.anchor), map(r.head));
    }),
    state.selection.mainIndex,
  );
  view.dispatch({ changes: changeSet, selection, userEvent, scrollIntoView: true });
  return true;
}

function stripListMarker(text: string): string {
  const info = parseListLine(text);
  if (!info) return text;
  return text.slice(0, info.markerStart) + text.slice(info.contentStart);
}

export function toggleBulletList(view: EditorView): boolean {
  const state = view.state;
  const lines = selectedLines(state).map((n) => state.doc.line(n).text);
  const nonEmpty = lines.filter((t) => t.trim());
  const allBullets = nonEmpty.length > 0 && nonEmpty.every((t) => parseListLine(t)?.bullet && parseListLine(t)?.task === undefined);
  return mapLines(view, (text) => {
    if (allBullets) return stripListMarker(text);
    if (!text.trim() && lines.length > 1) return null;
    const info = parseListLine(text);
    if (info?.bullet && info.task === undefined) return null;
    const base = info ? text.slice(0, info.markerStart) + text.slice(info.contentStart) : text;
    const q = QUOTE_RE.exec(base);
    const prefixLen = q ? q[0].length : (/^[ \t]*/.exec(base)![0].length);
    return base.slice(0, prefixLen) + "- " + base.slice(prefixLen);
  });
}

export function toggleNumberedList(view: EditorView): boolean {
  const state = view.state;
  const lines = selectedLines(state).map((n) => state.doc.line(n).text);
  const nonEmpty = lines.filter((t) => t.trim());
  const allNumbered = nonEmpty.length > 0 && nonEmpty.every((t) => parseListLine(t)?.number !== undefined);
  let counter = 0;
  const ok = mapLines(view, (text) => {
    if (allNumbered) return stripListMarker(text);
    if (!text.trim() && lines.length > 1) return null;
    const info = parseListLine(text);
    const base = info ? text.slice(0, info.markerStart) + text.slice(info.contentStart) : text;
    const q = QUOTE_RE.exec(base);
    const prefixLen = q ? q[0].length : (/^[ \t]*/.exec(base)![0].length);
    counter++;
    return base.slice(0, prefixLen) + `${counter}. ` + base.slice(prefixLen);
  });
  if (ok) renumberOrderedLists(view);
  return ok;
}

export function toggleBlockquote(view: EditorView): boolean {
  const state = view.state;
  const lines = selectedLines(state).map((n) => state.doc.line(n).text);
  const allQuoted = lines.every((t) => /^[ \t]*>/.test(t));
  return mapLines(view, (text) => {
    if (allQuoted) return text.replace(/^([ \t]*)>[ \t]?/, "$1");
    return "> " + text;
  });
}

/** Mod-L: plain → `- [ ] `, bullet → task, `[ ]` → `[x]`, checked → `[ ]`. */
export function toggleChecklistStatus(view: EditorView): boolean {
  return mapLines(view, (text) => {
    const info = parseListLine(text);
    if (!info) {
      const q = QUOTE_RE.exec(text);
      const prefixLen = q ? q[0].length : (/^[ \t]*/.exec(text)![0].length);
      return text.slice(0, prefixLen) + "- [ ] " + text.slice(prefixLen);
    }
    const markerEnd = text.indexOf(info.bullet ?? `${info.number}${info.delim}`, info.markerStart) + (info.bullet ? 1 : String(info.number).length + 1);
    const afterMarker = /^[ \t]+/.exec(text.slice(markerEnd))?.[0].length ?? 0;
    const taskStart = markerEnd + afterMarker;
    if (info.task === undefined) return text.slice(0, taskStart) + "[ ] " + text.slice(taskStart);
    const next = info.task === " " ? "x" : " ";
    return text.slice(0, taskStart + 1) + next + text.slice(taskStart + 2);
  });
}

/** Cycle: text → bullet → unchecked task → checked task → text. */
export function cycleListChecklist(view: EditorView): boolean {
  return mapLines(view, (text) => {
    const info = parseListLine(text);
    const q = QUOTE_RE.exec(text);
    const prefixLen = q ? q[0].length : (/^[ \t]*/.exec(text)![0].length);
    if (!info) return text.slice(0, prefixLen) + "- " + text.slice(prefixLen);
    if (info.task === undefined) {
      return text.slice(0, info.contentStart) + "[ ] " + text.slice(info.contentStart);
    }
    if (info.task === " ") {
      const i = text.indexOf("[ ]", info.markerStart);
      return text.slice(0, i + 1) + "x" + text.slice(i + 2);
    }
    return stripListMarker(text);
  });
}

export function setHeading(view: EditorView, level: number): boolean {
  return mapLines(view, (text) => {
    const m = /^([ \t]*(?:>[ \t]?)*)(#{1,6}[ \t]+)?(.*)$/.exec(text)!;
    const content = m[3]!;
    const prefix = level > 0 ? "#".repeat(level) + " " : "";
    return m[1] + prefix + content;
  });
}

// ---------------------------------------------------------------------------
// Inserts
// ---------------------------------------------------------------------------

function replaceSelections(view: EditorView, fn: (text: string, range: SelectionRange) => { insert: string; selFrom: number; selTo: number }) {
  const state = view.state;
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const r = fn(text, range);
    return { changes: { from: range.from, to: range.to, insert: r.insert }, range: EditorSelection.range(range.from + r.selFrom, range.from + r.selTo) };
  });
  view.dispatch(state.update(tr, { userEvent: "input", scrollIntoView: true }));
  return true;
}

export function insertMarkdownLink(view: EditorView): boolean {
  return replaceSelections(view, (text) => {
    if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text)) return { insert: `[](${text})`, selFrom: 1, selTo: 1 };
    if (text) return { insert: `[${text}]()`, selFrom: text.length + 3, selTo: text.length + 3 };
    return { insert: "[]()", selFrom: 1, selTo: 1 };
  });
}

export function insertWikilink(view: EditorView, embed = false): boolean {
  const open = embed ? "![[" : "[[";
  return replaceSelections(view, (text) =>
    text ? { insert: `${open}${text}]]`, selFrom: open.length + text.length + 2, selTo: open.length + text.length + 2 } : { insert: `${open}]]`, selFrom: open.length, selTo: open.length },
  );
}

/** Insert a block on its own lines, replacing the selection. `cursor` is the offset in `block` to place the cursor. */
function insertBlock(view: EditorView, make: (selected: string) => { block: string; cursor: number; cursorEnd?: number }) {
  const state = view.state;
  const tr = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const { block, cursor, cursorEnd } = make(selected);
    const line = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    const needBefore = range.from > line.from && state.sliceDoc(line.from, range.from).trim() !== "";
    const needAfter = range.to < endLine.to && state.sliceDoc(range.to, endLine.to).trim() !== "";
    const before = needBefore ? "\n" : "";
    const after = needAfter ? "\n" : "";
    const insert = before + block + after;
    const base = range.from + before.length;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(base + cursor, base + (cursorEnd ?? cursor)) };
  });
  view.dispatch(state.update(tr, { userEvent: "input", scrollIntoView: true }));
  return true;
}

export function insertCallout(view: EditorView, type = "note"): boolean {
  return insertBlock(view, (sel) => {
    const head = `> [!${type}]`;
    if (!sel) return { block: `${head}\n> `, cursor: head.length + 3 };
    const body = sel.split("\n").map((l) => "> " + l).join("\n");
    return { block: `${head}\n${body}`, cursor: 4, cursorEnd: 4 + type.length };
  });
}

export function insertTable(view: EditorView): boolean {
  return insertBlock(view, () => {
    const block = "|     |     |\n| --- | --- |\n|     |     |";
    return { block, cursor: 2 };
  });
}

export function insertCodeBlock(view: EditorView): boolean {
  return insertBlock(view, (sel) => ({ block: "```\n" + sel + "\n```", cursor: 3 }));
}

export function insertMathBlock(view: EditorView): boolean {
  return insertBlock(view, (sel) => ({ block: "$$\n" + sel + "\n$$", cursor: 3 + (sel ? sel.length : 0) }));
}

export function insertHorizontalRule(view: EditorView): boolean {
  const state = view.state;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const insert = (line.text.trim() ? "\n\n" : "") + "---\n";
  const at = line.text.trim() ? line.to : line.from;
  view.dispatch({ changes: { from: at, to: line.text.trim() ? at : line.to, insert }, selection: EditorSelection.cursor(at + insert.length), userEvent: "input", scrollIntoView: true });
  return true;
}

export function insertFootnote(view: EditorView): boolean {
  const state = view.state;
  const text = state.doc.toString();
  let max = 0;
  for (const m of text.matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(m[1]));
  const n = max + 1;
  const pos = state.selection.main.to;
  const ref = `[^${n}]`;
  const end = state.doc.length;
  const tail = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  const def = `${tail}[^${n}]: `;
  view.dispatch({
    changes: [
      { from: pos, insert: ref },
      { from: end, insert: def },
    ],
    selection: EditorSelection.cursor(end + ref.length + def.length),
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export function deleteParagraph(view: EditorView): boolean {
  const ok = deleteLine(view);
  if (ok) renumberOrderedLists(view);
  return ok;
}

export function duplicateLine(view: EditorView): boolean {
  return copyLineDown(view);
}

export function joinLines(view: EditorView): boolean {
  const state = view.state;
  const changes: ChangeSpec[] = [];
  const ranges: SelectionRange[] = [];
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from);
    let last = state.doc.lineAt(r.to);
    if (last.number === first.number) {
      if (first.number === state.doc.lines) continue;
      last = state.doc.line(first.number + 1);
    }
    for (let n = first.number; n < last.number; n++) {
      const cur = state.doc.line(n);
      const next = state.doc.line(n + 1);
      const info = parseListLine(next.text);
      let skip = info ? info.contentStart : (QUOTE_RE.exec(next.text)?.[0].length ?? 0);
      while (skip < next.text.length && /\s/.test(next.text[skip]!)) skip++;
      const trimmedEnd = cur.text.replace(/[ \t]+$/, "").length;
      changes.push({ from: cur.from + trimmedEnd, to: next.from + skip, insert: " " });
      if (n === first.number) ranges.push(EditorSelection.cursor(cur.from + trimmedEnd));
    }
  }
  if (!changes.length) return false;
  const cs = state.changes(changes);
  view.dispatch({ changes: cs, selection: ranges.length ? EditorSelection.create(ranges.map((r) => r.map(cs))) : undefined, userEvent: "input" });
  return true;
}

/** Word → syntax node → line → paragraph → document. */
export function expandSelection(view: EditorView): boolean {
  const state = view.state;
  const r = state.selection.main;
  if (r.empty) {
    const w = state.wordAt(r.head);
    if (w) {
      view.dispatch({ selection: EditorSelection.single(w.from, w.to) });
      return true;
    }
  }
  const line = state.doc.lineAt(r.from);
  const lineEnd = state.doc.lineAt(r.to);
  if (selectParentSyntax(view)) {
    const n = view.state.selection.main;
    // Syntax parents that span beyond the line are skipped in favour of the line.
    if (n.from >= line.from && n.to <= lineEnd.to && (n.from !== r.from || n.to !== r.to)) return true;
  }
  if (r.from !== line.from || r.to !== lineEnd.to) {
    view.dispatch({ selection: EditorSelection.single(line.from, lineEnd.to) });
    return true;
  }
  // Paragraph: extend over adjacent non-blank lines.
  let a = line.number, b = lineEnd.number;
  while (a > 1 && state.doc.line(a - 1).text.trim()) a--;
  while (b < state.doc.lines && state.doc.line(b + 1).text.trim()) b++;
  const pf = state.doc.line(a).from, pt = state.doc.line(b).to;
  if (pf !== r.from || pt !== r.to) {
    view.dispatch({ selection: EditorSelection.single(pf, pt) });
    return true;
  }
  view.dispatch({ selection: EditorSelection.single(0, state.doc.length) });
  return true;
}

export function indentList(view: EditorView): boolean {
  const ok = indentMore(view);
  restartNestedNumbering(view);
  renumberOrderedLists(view);
  return ok;
}

export function unindentList(view: EditorView): boolean {
  const ok = indentLess(view);
  renumberOrderedLists(view);
  return ok;
}

/**
 * Mod+Enter (Obsidian's "Open link under cursor in new tab"): opens the link,
 * URL or tag under the cursor; with nothing clickable there it toggles the
 * checkbox of the lines under the cursor, as Obsidian does.
 */
export function openLinkInNewLeafOrToggleCheckbox(view: EditorView): boolean {
  if (followLink(view, true)) return true;
  return toggleChecklistStatus(view);
}

export function followLink(view: EditorView, newLeaf: boolean): boolean {
  const tok = clickableTokenAt(view.state, view.state.selection.main.head);
  const host = view.state.facet(hostFacet);
  if (!tok || !host) return false;
  if (tok.type === "internal-link") host.openLink(tok.text, sourcePathOf(host), newLeaf);
  else if (tok.type === "external-link") (host.openExternal ?? ((u: string) => window.open(u, "_blank", "noopener")))(tok.text);
  else host.onTagClick?.(tok.text, new MouseEvent("click"));
  return true;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

type Align = "left" | "center" | "right" | null;

export interface TableModel {
  from: number;
  to: number;
  rows: string[][]; // row 0 = header; the delimiter row is not included
  align: Align[];
  /** Cursor cell: row index into `rows` (delimiter row counts as header row 0), column. */
  row: number;
  col: number;
  indent: string;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let depth = 0; // inside [[ ]] a pipe belongs to the link only when escaped, but be lenient
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
      continue;
    }
    if (c === "[" && s[i + 1] === "[") depth++;
    if (c === "]" && s[i + 1] === "]") depth = Math.max(0, depth - 1);
    if (c === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

export function readTable(state: EditorState, pos: number): TableModel | null {
  const tree = ofmTree(state);
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node && node.name !== "Table") node = node.parent;
  if (!node) {
    node = tree.resolveInner(pos, 1);
    while (node && node.name !== "Table") node = node.parent;
  }
  if (!node) return null;
  const doc = state.doc;
  const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
  const lines: string[] = [];
  for (let n = first.number; n <= last.number; n++) lines.push(doc.line(n).text);
  if (lines.length < 2) return null;
  const indent = /^[ \t]*/.exec(lines[0]!)![0];
  const header = splitRow(lines[0]!);
  const delim = splitRow(lines[1]!);
  const align: Align[] = delim.map((d) => {
    const l = d.startsWith(":"), r = d.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
  const rows = [header, ...lines.slice(2).map(splitRow)];
  const width = Math.max(...rows.map((r) => r.length), align.length);
  for (const r of rows) while (r.length < width) r.push("");
  while (align.length < width) align.push(null);
  const cursorLine = doc.lineAt(pos);
  const lineIdx = cursorLine.number - first.number;
  const row = lineIdx <= 1 ? 0 : lineIdx - 1;
  const before = cursorLine.text.slice(0, pos - cursorLine.from);
  let col = (before.replace(/\\\|/g, "").match(/\|/g)?.length ?? 0) - (cursorLine.text.trimStart().startsWith("|") ? 1 : 0);
  col = Math.max(0, Math.min(width - 1, col));
  return { from: first.from, to: last.to, rows, align, row, col, indent };
}

/** Serialise with padded columns (Obsidian's "format table"). Returns text and cell content offsets. */
export function writeTable(model: TableModel): { text: string; cellOffset(row: number, col: number): number; cellRange(row: number, col: number): { from: number; to: number } } {
  const width = model.align.length;
  const widths = new Array(width).fill(3) as number[];
  for (const r of model.rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i]!, [...c].length)));
  const offsets: number[][] = [];
  const ends: number[][] = [];
  const lines: string[] = [];
  let pos = 0;
  const pad = (s: string, w: number, a: Align) => {
    const len = [...s].length;
    const extra = w - len;
    if (a === "right") return " ".repeat(extra) + s;
    if (a === "center") return " ".repeat(Math.floor(extra / 2)) + s + " ".repeat(Math.ceil(extra / 2));
    return s + " ".repeat(extra);
  };
  const rowText = (cells: string[], rowIndex: number | null) => {
    let t = model.indent + "|";
    const rowOffsets: number[] = [];
    const rowEnds: number[] = [];
    cells.forEach((c, i) => {
      t += " ";
      const padded = pad(c, widths[i]!, model.align[i] ?? null);
      // An empty cell's content starts right after "| " (not after its padding).
      const lead = c ? padded.length - padded.trimStart().length : 0;
      rowOffsets.push(pos + t.length + lead);
      rowEnds.push(pos + t.length + lead + c.length);
      t += padded + " |";
    });
    if (rowIndex !== null) {
      offsets[rowIndex] = rowOffsets;
      ends[rowIndex] = rowEnds;
    }
    return t;
  };
  model.rows.forEach((cells, i) => {
    lines.push(rowText(cells, i));
    pos += lines[lines.length - 1]!.length + 1;
    if (i === 0) {
      const d = model.align.map((a, j) => {
        const w = widths[j]!;
        if (a === "center") return ":" + "-".repeat(Math.max(1, w - 2)) + ":";
        if (a === "right") return "-".repeat(Math.max(1, w - 1)) + ":";
        if (a === "left") return ":" + "-".repeat(Math.max(1, w - 1));
        return "-".repeat(w);
      });
      lines.push(model.indent + "| " + d.join(" | ") + " |");
      pos += lines[lines.length - 1]!.length + 1;
    }
  });
  return {
    text: lines.join("\n"),
    cellOffset: (row, col) => offsets[Math.max(0, Math.min(offsets.length - 1, row))]?.[Math.max(0, Math.min(width - 1, col))] ?? 0,
    cellRange: (row, col) => {
      const r = Math.max(0, Math.min(offsets.length - 1, row));
      const c = Math.max(0, Math.min(width - 1, col));
      const from = offsets[r]?.[c] ?? 0;
      return { from, to: ends[r]?.[c] ?? from };
    },
  };
}

/**
 * A table edit: read the table under the cursor, change the model, write it
 * back formatted. `target` is the cell to land in; navigation (`select`)
 * selects that cell's content, as Advanced Tables does, so typing replaces it.
 */
function tableCommand(fn: (m: TableModel) => { row: number; col: number; select?: boolean; after?: boolean } | null) {
  return (view: EditorView): boolean => {
    const model = readTable(view.state, view.state.selection.main.head);
    if (!model) return false;
    const target = fn(model);
    if (!target) return false;
    const out = writeTable(model);
    const cell = out.cellRange(target.row, target.col);
    const selection = target.select ? EditorSelection.range(model.from + cell.from, model.from + cell.to) : EditorSelection.cursor(model.from + (target.after ? cell.to : cell.from));
    const changes = view.state.sliceDoc(model.from, model.to) === out.text ? undefined : { from: model.from, to: model.to, insert: out.text };
    view.dispatch({ changes, selection, userEvent: changes ? "input.table" : "select", scrollIntoView: true });
    return true;
  };
}

function compareCells(a: string, b: string): number {
  const na = Number(a.replace(/[,\s]/g, "")), nb = Number(b.replace(/[,\s]/g, ""));
  if (a.trim() && b.trim() && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  if (!a.trim() !== !b.trim()) return a.trim() ? -1 : 1; // blanks last
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export const tableCommands = {
  addRowBefore: tableCommand((m) => {
    const at = Math.max(1, m.row);
    m.rows.splice(at, 0, new Array(m.align.length).fill(""));
    return { row: at, col: m.col };
  }),
  addRowAfter: tableCommand((m) => {
    const at = m.row + 1;
    m.rows.splice(at, 0, new Array(m.align.length).fill(""));
    return { row: at, col: m.col };
  }),
  addColumnBefore: tableCommand((m) => {
    for (const r of m.rows) r.splice(m.col, 0, "");
    m.align.splice(m.col, 0, null);
    return { row: m.row, col: m.col };
  }),
  addColumnAfter: tableCommand((m) => {
    for (const r of m.rows) r.splice(m.col + 1, 0, "");
    m.align.splice(m.col + 1, 0, null);
    return { row: m.row, col: m.col + 1 };
  }),
  deleteRow: tableCommand((m) => {
    if (m.row === 0 || m.rows.length <= 1) return null;
    m.rows.splice(m.row, 1);
    return { row: Math.min(m.row, m.rows.length - 1), col: m.col };
  }),
  deleteColumn: tableCommand((m) => {
    if (m.align.length <= 1) return null;
    for (const r of m.rows) r.splice(m.col, 1);
    m.align.splice(m.col, 1);
    return { row: m.row, col: Math.min(m.col, m.align.length - 1) };
  }),
  moveRowUp: tableCommand((m) => {
    if (m.row <= 1) return null;
    [m.rows[m.row - 1], m.rows[m.row]] = [m.rows[m.row]!, m.rows[m.row - 1]!];
    return { row: m.row - 1, col: m.col };
  }),
  moveRowDown: tableCommand((m) => {
    if (m.row === 0 || m.row >= m.rows.length - 1) return null;
    [m.rows[m.row + 1], m.rows[m.row]] = [m.rows[m.row]!, m.rows[m.row + 1]!];
    return { row: m.row + 1, col: m.col };
  }),
  moveColumnLeft: tableCommand((m) => {
    if (m.col === 0) return null;
    for (const r of m.rows) [r[m.col - 1], r[m.col]] = [r[m.col]!, r[m.col - 1]!];
    [m.align[m.col - 1], m.align[m.col]] = [m.align[m.col]!, m.align[m.col - 1]!];
    return { row: m.row, col: m.col - 1 };
  }),
  moveColumnRight: tableCommand((m) => {
    if (m.col >= m.align.length - 1) return null;
    for (const r of m.rows) [r[m.col + 1], r[m.col]] = [r[m.col]!, r[m.col + 1]!];
    [m.align[m.col + 1], m.align[m.col]] = [m.align[m.col]!, m.align[m.col + 1]!];
    return { row: m.row, col: m.col + 1 };
  }),
  alignLeft: tableCommand((m) => ((m.align[m.col] = "left"), { row: m.row, col: m.col })),
  alignCenter: tableCommand((m) => ((m.align[m.col] = "center"), { row: m.row, col: m.col })),
  alignRight: tableCommand((m) => ((m.align[m.col] = "right"), { row: m.row, col: m.col })),
  format: tableCommand((m) => ({ row: m.row, col: m.col, after: true })),
  sortAscending: tableCommand((m) => sortRows(m, 1)),
  sortDescending: tableCommand((m) => sortRows(m, -1)),
  duplicateRow: tableCommand((m) => {
    if (m.row === 0) return null;
    m.rows.splice(m.row + 1, 0, [...m.rows[m.row]!]);
    return { row: m.row + 1, col: m.col };
  }),
  duplicateColumn: tableCommand((m) => {
    for (const r of m.rows) r.splice(m.col + 1, 0, r[m.col] ?? "");
    m.align.splice(m.col + 1, 0, m.align[m.col] ?? null);
    return { row: m.row, col: m.col + 1 };
  }),
  /** Tab inside a table: format, then the next cell (a new row after the last cell). */
  nextCell: tableCommand((m) => {
    if (m.col < m.align.length - 1) return { row: m.row, col: m.col + 1, select: true };
    if (m.row >= m.rows.length - 1) m.rows.push(new Array(m.align.length).fill(""));
    return { row: m.row + 1, col: 0, select: true };
  }),
  previousCell: tableCommand((m) => {
    if (m.col > 0) return { row: m.row, col: m.col - 1, select: true };
    if (m.row === 0) return { row: 0, col: 0, select: true };
    return { row: m.row - 1, col: m.align.length - 1, select: true };
  }),
  /** Enter inside a table: format, then the same column of the next row (a new row after the last). */
  nextRow: tableCommand((m) => {
    if (m.row >= m.rows.length - 1) m.rows.push(new Array(m.align.length).fill(""));
    return { row: m.row + 1, col: m.col, select: true };
  }),
};

function sortRows(m: TableModel, dir: 1 | -1) {
  if (m.rows.length < 3) return { row: m.row, col: m.col };
  const current = m.rows[m.row];
  const body = m.rows.slice(1).sort((a, b) => dir * compareCells(a[m.col] ?? "", b[m.col] ?? ""));
  m.rows.splice(1, body.length, ...body);
  const row = m.row === 0 ? 0 : Math.max(1, m.rows.indexOf(current!));
  return { row, col: m.col };
}

/**
 * Leave the table: Enter on an empty last row removes it and continues on a
 * new paragraph below the table.
 */
export function exitTableOnEmptyRow(view: EditorView): boolean {
  const model = readTable(view.state, view.state.selection.main.head);
  if (!model || model.row < 1 || model.row !== model.rows.length - 1) return false;
  if (model.rows[model.row]!.some((c) => c.trim())) return false;
  const doc = view.state.doc;
  const lastLine = doc.lineAt(model.to);
  const prevEnd = doc.line(lastLine.number - 1).to;
  const insert = "\n";
  view.dispatch({ changes: { from: prevEnd, to: lastLine.to, insert }, selection: EditorSelection.cursor(prevEnd + insert.length), userEvent: "input.table", scrollIntoView: true });
  return true;
}

// ---------------------------------------------------------------------------
// The command table
// ---------------------------------------------------------------------------

const mod = (key: string, ...more: Modifier[]): Hotkey => ({ modifiers: ["Mod", ...more], key });

export const EDITOR_COMMANDS: EditorCommandSpec[] = [
  { id: "editor:toggle-bold", name: "Toggle bold", icon: "lucide-bold", hotkeys: [mod("B")], editorCallback: (e) => void toggleFormatting(viewOf(e), "bold") },
  { id: "editor:toggle-italics", name: "Toggle italics", icon: "lucide-italic", hotkeys: [mod("I")], editorCallback: (e) => void toggleFormatting(viewOf(e), "italic") },
  { id: "editor:toggle-strikethrough", name: "Toggle strikethrough", icon: "lucide-strikethrough", editorCallback: (e) => void toggleFormatting(viewOf(e), "strikethrough") },
  { id: "editor:toggle-highlight", name: "Toggle highlight", icon: "lucide-highlighter", editorCallback: (e) => void toggleFormatting(viewOf(e), "highlight") },
  { id: "editor:toggle-code", name: "Toggle code", icon: "lucide-code-2", editorCallback: (e) => void toggleFormatting(viewOf(e), "code") },
  { id: "editor:toggle-inline-math", name: "Toggle math", icon: "lucide-sigma", editorCallback: (e) => void toggleFormatting(viewOf(e), "math") },
  { id: "editor:toggle-comments", name: "Toggle comment", icon: "lucide-percent", hotkeys: [mod("/")], editorCallback: (e) => void toggleFormatting(viewOf(e), "comment") },
  { id: "editor:clear-formatting", name: "Clear formatting", icon: "lucide-eraser", editorCallback: run(clearFormatting) },
  { id: "editor:insert-link", name: "Insert Markdown link", icon: "lucide-link", hotkeys: [mod("K")], editorCallback: run(insertMarkdownLink) },
  { id: "editor:insert-wikilink", name: "Add internal link", icon: "lucide-link-2", editorCallback: (e) => void insertWikilink(viewOf(e)) },
  { id: "editor:insert-embed", name: "Add embed", icon: "lucide-sticky-note", editorCallback: (e) => void insertWikilink(viewOf(e), true) },
  { id: "editor:insert-callout", name: "Insert callout", icon: "lucide-quote", editorCallback: (e) => void insertCallout(viewOf(e)) },
  { id: "editor:insert-table", name: "Insert table", icon: "lucide-table", editorCallback: run(insertTable) },
  { id: "editor:insert-codeblock", name: "Insert code block", icon: "lucide-code-2", editorCallback: run(insertCodeBlock) },
  { id: "editor:insert-mathblock", name: "Insert math block", icon: "lucide-sigma-square", editorCallback: run(insertMathBlock) },
  { id: "editor:insert-horizontal-rule", name: "Insert horizontal rule", icon: "lucide-minus", editorCallback: run(insertHorizontalRule) },
  { id: "editor:insert-footnote", name: "Insert footnote", icon: "lucide-footprints", editorCallback: run(insertFootnote) },
  { id: "editor:toggle-bullet-list", name: "Toggle bullet list", icon: "lucide-list", editorCallback: run(toggleBulletList) },
  { id: "editor:toggle-numbered-list", name: "Toggle numbered list", icon: "lucide-list-ordered", editorCallback: run(toggleNumberedList) },
  { id: "editor:toggle-checklist-status", name: "Toggle checkbox status", icon: "lucide-check-square", hotkeys: [mod("L")], editorCallback: run(toggleChecklistStatus) },
  { id: "editor:cycle-list-checklist", name: "Cycle bullet/checkbox", icon: "lucide-check-square", editorCallback: run(cycleListChecklist) },
  { id: "editor:toggle-blockquote", name: "Toggle blockquote", icon: "lucide-quote", editorCallback: run(toggleBlockquote) },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    id: `editor:set-heading-${n}`,
    name: `Set heading ${n}`,
    icon: `lucide-heading-${n}`,
    editorCallback: (e: Editor) => void setHeading(viewOf(e), n),
  })),
  { id: "editor:set-heading-0", name: "Remove heading", icon: "lucide-type", editorCallback: (e) => void setHeading(viewOf(e), 0) },
  { id: "editor:indent-list", name: "Indent list", icon: "lucide-indent", hotkeys: [mod("]")], editorCallback: run(indentList) },
  { id: "editor:unindent-list", name: "Unindent list", icon: "lucide-outdent", hotkeys: [mod("[")], editorCallback: run(unindentList) },
  // No default hotkey, as in Obsidian (CM6's Alt+Up/Down moves lines). Mod+Shift+Up/Down
  // is left free for plugins: Outliner binds it to "Move list and sublists up/down".
  { id: "editor:swap-line-up", name: "Move line up", icon: "lucide-arrow-up", hotkeys: [], editorCallback: run(moveLineUp) },
  { id: "editor:swap-line-down", name: "Move line down", icon: "lucide-arrow-down", hotkeys: [], editorCallback: run(moveLineDown) },
  { id: "editor:duplicate-line", name: "Duplicate line", icon: "lucide-copy", editorCallback: run(duplicateLine) },
  { id: "editor:delete-paragraph", name: "Delete paragraph", icon: "lucide-trash", hotkeys: [mod("D")], editorCallback: run(deleteParagraph) },
  { id: "editor:join-lines", name: "Join lines", icon: "lucide-merge", editorCallback: run(joinLines) },
  { id: "editor:toggle-fold", name: "Toggle fold on the current line", icon: "lucide-chevrons-down-up", editorCallback: run(toggleFoldCommand) },
  { id: "editor:fold-all", name: "Fold all headings and lists", icon: "lucide-chevrons-down-up", editorCallback: run(foldAllCommand) },
  { id: "editor:unfold-all", name: "Unfold all headings and lists", icon: "lucide-chevrons-up-down", editorCallback: run(unfoldAllCommand) },
  { id: "editor:fold-more", name: "Fold more", icon: "lucide-chevrons-down-up", editorCallback: run(foldMoreCommand) },
  { id: "editor:fold-less", name: "Fold less", icon: "lucide-chevrons-up-down", editorCallback: run(foldLessCommand) },
  { id: "editor:add-cursor-above", name: "Add cursor above", icon: "lucide-arrow-up", hotkeys: [mod("ArrowUp", "Alt")], editorCallback: run(addCursorAbove) },
  { id: "editor:add-cursor-below", name: "Add cursor below", icon: "lucide-arrow-down", hotkeys: [mod("ArrowDown", "Alt")], editorCallback: run(addCursorBelow) },
  { id: "editor:select-all-occurrences", name: "Select all occurrences", icon: "lucide-text-cursor", hotkeys: [mod("L", "Shift")], editorCallback: run(selectAllOccurrences) },
  { id: "editor:select-next-occurrence", name: "Add next occurrence to selection", icon: "lucide-text-cursor", editorCallback: run(selectNextOccurrence) },
  { id: "editor:expand-selection", name: "Expand selection", icon: "lucide-expand", editorCallback: run(expandSelection) },
  { id: "editor:follow-link", name: "Follow link under cursor", icon: "lucide-link", hotkeys: [{ modifiers: ["Alt"], key: "Enter" }], editorCallback: (e) => void followLink(viewOf(e), false) },
  { id: "editor:open-link-in-new-leaf", name: "Open link under cursor in new tab", icon: "lucide-link", hotkeys: [mod("Enter")], editorCallback: run(openLinkInNewLeafOrToggleCheckbox) },
  { id: "editor:table-row-before", name: "Add row before", icon: "lucide-table", editorCallback: run(tableCommands.addRowBefore) },
  { id: "editor:table-row-after", name: "Add row after", icon: "lucide-table", editorCallback: run(tableCommands.addRowAfter) },
  { id: "editor:table-col-before", name: "Add column before", icon: "lucide-table", editorCallback: run(tableCommands.addColumnBefore) },
  { id: "editor:table-col-after", name: "Add column after", icon: "lucide-table", editorCallback: run(tableCommands.addColumnAfter) },
  { id: "editor:table-row-delete", name: "Delete row", icon: "lucide-table", editorCallback: run(tableCommands.deleteRow) },
  { id: "editor:table-col-delete", name: "Delete column", icon: "lucide-table", editorCallback: run(tableCommands.deleteColumn) },
  { id: "editor:table-row-up", name: "Move row up", icon: "lucide-table", editorCallback: run(tableCommands.moveRowUp) },
  { id: "editor:table-row-down", name: "Move row down", icon: "lucide-table", editorCallback: run(tableCommands.moveRowDown) },
  { id: "editor:table-col-left", name: "Move column left", icon: "lucide-table", editorCallback: run(tableCommands.moveColumnLeft) },
  { id: "editor:table-col-right", name: "Move column right", icon: "lucide-table", editorCallback: run(tableCommands.moveColumnRight) },
  { id: "editor:table-col-align-left", name: "Align column left", icon: "lucide-align-left", editorCallback: run(tableCommands.alignLeft) },
  { id: "editor:table-col-align-center", name: "Align column center", icon: "lucide-align-center", editorCallback: run(tableCommands.alignCenter) },
  { id: "editor:table-col-align-right", name: "Align column right", icon: "lucide-align-right", editorCallback: run(tableCommands.alignRight) },
  { id: "editor:table-format", name: "Format table", icon: "lucide-table", editorCallback: run(tableCommands.format) },
  { id: "editor:table-row-duplicate", name: "Duplicate row", icon: "lucide-copy", editorCallback: run(tableCommands.duplicateRow) },
  { id: "editor:table-col-duplicate", name: "Duplicate column", icon: "lucide-copy", editorCallback: run(tableCommands.duplicateColumn) },
  { id: "editor:table-sort-asc", name: "Sort by column A→Z", icon: "lucide-arrow-down-a-z", editorCallback: run(tableCommands.sortAscending) },
  { id: "editor:table-sort-desc", name: "Sort by column Z→A", icon: "lucide-arrow-up-z-a", editorCallback: run(tableCommands.sortDescending) },
  { id: "editor:table-paste-as-table", name: "Paste tab-separated text as table", icon: "lucide-clipboard-paste", editorCallback: (e) => void pasteAsTable(viewOf(e)) },
];

async function pasteAsTable(view: EditorView): Promise<void> {
  let text = "";
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return;
  }
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const sep = lines.every((l) => l.includes("\t")) ? "\t" : ",";
  const rows = lines.map((l) => l.split(sep).map((c) => c.trim().replace(/\|/g, "\\|")));
  const width = Math.max(...rows.map((r) => r.length));
  if (rows.length < 1 || width < 1) return;
  for (const r of rows) while (r.length < width) r.push("");
  if (rows.length === 1) rows.push(new Array(width).fill(""));
  const out = writeTable({ from: 0, to: 0, rows, align: new Array(width).fill(null), row: 0, col: 0, indent: "" });
  insertBlock(view, () => ({ block: out.text, cursor: out.cellOffset(0, 0) }));
}

function selectAllOccurrences(view: EditorView): boolean {
  const r = view.state.selection.main;
  if (r.empty) {
    const w = view.state.wordAt(r.head);
    if (!w) return false;
    view.dispatch({ selection: EditorSelection.single(w.from, w.to) });
  }
  return selectSelectionMatches(view);
}

/** Hotkey → CM6 key name ("Mod-Shift-ArrowUp"). */
export function hotkeyToKey(h: Hotkey): string {
  const order: Modifier[] = ["Mod", "Ctrl", "Meta", "Alt", "Shift"];
  const mods = order.filter((m) => h.modifiers.includes(m));
  const key = h.key.length === 1 ? h.key.toLowerCase() : h.key;
  return [...mods, key].join("-");
}

/**
 * CM6 bindings for every command with a default hotkey. `getEditor` maps the
 * view to its Editor (the CMEditor created alongside it).
 */
export function editorKeymap(getEditor: (view: EditorView) => Editor): KeyBinding[] {
  return EDITOR_COMMANDS.filter((c) => c.hotkeys?.length).flatMap((c) =>
    c.hotkeys!.map((h) => ({
      key: hotkeyToKey(h),
      preventDefault: true,
      run: (view: EditorView) => {
        c.editorCallback(getEditor(view));
        return true;
      },
    })),
  );
}
