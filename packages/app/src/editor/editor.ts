/**
 * CMEditor — the CodeMirror 6 implementation of obsidian's `Editor`.
 *
 * Positions are `{ line, ch }` with 0-based lines and UTF-16 `ch`, clamped to
 * the document like Obsidian does, so a plugin passing `ch: Infinity` lands
 * at the end of the line.
 */
import { EditorSelection } from "@codemirror/state";
import type { ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  cursorCharLeft,
  cursorCharRight,
  cursorDocEnd,
  cursorDocStart,
  cursorGroupLeft,
  cursorGroupRight,
  cursorLineDown,
  cursorLineUp,
  deleteLine,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
  moveLineDown,
  moveLineUp,
  redo,
  undo,
} from "@codemirror/commands";
import { Editor } from "./editor-base";
import type {
  EditorChange,
  EditorCommandName,
  EditorPosition,
  EditorRange,
  EditorRangeOrCaret,
  EditorScrollInfo,
  EditorSelection as ObsidianSelection,
  EditorSelectionOrCaret,
  EditorTransaction,
} from "./editor-base";
import { foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { foldAllCommand, foldLessCommand, foldMoreCommand, foldRangeAt, toggleFoldCommand, unfoldAllCommand } from "./live-preview/fold";
import { clickableTokenAt } from "./live-preview/links";
import type { ClickableToken } from "./live-preview/links";
import {
  indentList,
  insertCallout,
  insertCodeBlock,
  insertMarkdownLink,
  insertMathBlock,
  insertWikilink,
  setHeading,
  toggleBlockquote,
  toggleBulletList,
  toggleChecklistStatus,
  toggleFormatting,
  toggleNumberedList,
  unindentList,
} from "./commands";
import type { FormatType } from "./commands";

const COMMANDS: Record<EditorCommandName, (view: EditorView) => boolean> = {
  goUp: cursorLineUp,
  goDown: cursorLineDown,
  goLeft: cursorCharLeft,
  goRight: cursorCharRight,
  goStart: cursorDocStart,
  goEnd: cursorDocEnd,
  goWordLeft: cursorGroupLeft,
  goWordRight: cursorGroupRight,
  indentMore: indentMore,
  indentLess: indentLess,
  newlineAndIndent: insertNewlineAndIndent,
  swapLineUp: moveLineUp,
  swapLineDown: moveLineDown,
  deleteLine: deleteLine,
  toggleFold: toggleFoldCommand,
  foldAll: foldAllCommand,
  unfoldAll: unfoldAllCommand,
};

function userEvent(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  // CM5-style origins ("+input", "+delete", "*compose") map onto CM6 user events.
  if (origin === "+input" || origin === "input") return "input";
  if (origin === "+delete" || origin === "delete") return "delete";
  if (origin === "*compose") return "input.type.compose";
  if (origin === "paste") return "input.paste";
  return origin;
}

const editors = new WeakMap<EditorView, CMEditor>();

/** The CMEditor wrapping a view (null for views not created by createMarkdownEditor). */
export function editorOf(view: EditorView): CMEditor | null {
  return editors.get(view) ?? null;
}

export class CMEditor extends Editor {
  /** The CodeMirror 6 view (`editor.cm`, used directly by many plugins). */
  cm: EditorView;
  /** `.markdown-source-view` root element. */
  containerEl: HTMLElement;
  /** internal (used by plugins: obsidian-outliner, various) — the owning MarkdownView/MarkdownFileInfo. */
  editorComponent: unknown = null;

  constructor(cm: EditorView, containerEl: HTMLElement) {
    super();
    this.cm = cm;
    this.containerEl = containerEl;
    editors.set(cm, this);
  }

  // ---- positions ---------------------------------------------------------

  private clampPos(pos: EditorPosition): { line: number; ch: number } {
    const doc = this.cm.state.doc;
    let line = Math.floor(Number.isFinite(pos.line) ? pos.line : pos.line > 0 ? doc.lines - 1 : 0);
    line = Math.max(0, Math.min(doc.lines - 1, line));
    const len = doc.line(line + 1).length;
    let ch = Number.isFinite(pos.ch) ? Math.floor(pos.ch) : pos.ch > 0 ? len : 0;
    ch = Math.max(0, Math.min(len, ch));
    return { line, ch };
  }

  posToOffset(pos: EditorPosition): number {
    const p = this.clampPos(pos);
    return this.cm.state.doc.line(p.line + 1).from + p.ch;
  }

  offsetToPos(offset: number): EditorPosition {
    const doc = this.cm.state.doc;
    const o = Math.max(0, Math.min(doc.length, Math.floor(offset)));
    const line = doc.lineAt(o);
    return { line: line.number - 1, ch: o - line.from };
  }

  private posIn(doc: EditorView["state"]["doc"], pos: EditorPosition): number {
    const line = Math.max(0, Math.min(doc.lines - 1, Math.floor(pos.line)));
    const l = doc.line(line + 1);
    return l.from + Math.max(0, Math.min(l.length, Number.isFinite(pos.ch) ? Math.floor(pos.ch) : pos.ch > 0 ? l.length : 0));
  }

  // ---- document ----------------------------------------------------------

  refresh(): void {
    this.cm.requestMeasure();
  }

  getValue(): string {
    return this.cm.state.doc.toString();
  }

  setValue(content: string): void {
    this.cm.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: content } });
  }

  getLine(line: number): string {
    const doc = this.cm.state.doc;
    if (line < 0 || line >= doc.lines || !Number.isInteger(line)) return "";
    return doc.line(line + 1).text;
  }

  override setLine(n: number, text: string): void {
    const doc = this.cm.state.doc;
    if (n < 0 || n >= doc.lines) return;
    const l = doc.line(n + 1);
    this.cm.dispatch({ changes: { from: l.from, to: l.to, insert: text } });
  }

  lineCount(): number {
    return this.cm.state.doc.lines;
  }

  lastLine(): number {
    return this.cm.state.doc.lines - 1;
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    let a = this.posToOffset(from), b = this.posToOffset(to);
    if (a > b) [a, b] = [b, a];
    return this.cm.state.sliceDoc(a, b);
  }

  // ---- selection ---------------------------------------------------------

  getSelection(): string {
    const state = this.cm.state;
    return state.selection.ranges.map((r) => state.sliceDoc(r.from, r.to)).join("\n");
  }

  override somethingSelected(): boolean {
    return this.cm.state.selection.ranges.some((r) => !r.empty);
  }

  replaceSelection(replacement: string, origin?: string): void {
    this.cm.dispatch(this.cm.state.replaceSelection(replacement), {
      scrollIntoView: true,
      userEvent: userEvent(origin) ?? "input",
    });
  }

  replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, origin?: string): void {
    let a = this.posToOffset(from);
    let b = to ? this.posToOffset(to) : a;
    if (a > b) [a, b] = [b, a];
    this.cm.dispatch({ changes: { from: a, to: b, insert: replacement }, userEvent: userEvent(origin) });
  }

  getCursor(side: "from" | "to" | "head" | "anchor" = "head"): EditorPosition {
    const r = this.cm.state.selection.main;
    const offset = side === "from" ? r.from : side === "to" ? r.to : side === "anchor" ? r.anchor : r.head;
    return this.offsetToPos(offset);
  }

  listSelections(): ObsidianSelection[] {
    return this.cm.state.selection.ranges.map((r) => ({ anchor: this.offsetToPos(r.anchor), head: this.offsetToPos(r.head) }));
  }

  override setCursor(pos: EditorPosition | number, ch?: number): void {
    const p = typeof pos === "number" ? { line: pos, ch: ch ?? 0 } : pos;
    this.setSelection(p, p);
  }

  setSelection(anchor: EditorPosition, head?: EditorPosition): void {
    const a = this.posToOffset(anchor);
    const h = head ? this.posToOffset(head) : a;
    this.cm.dispatch({ selection: EditorSelection.single(a, h), scrollIntoView: true });
  }

  setSelections(ranges: EditorSelectionOrCaret[], main?: number): void {
    if (!ranges.length) return;
    const sel = EditorSelection.create(
      ranges.map((r) => EditorSelection.range(this.posToOffset(r.anchor), this.posToOffset(r.head ?? r.anchor))),
      Math.max(0, Math.min(ranges.length - 1, main ?? ranges.length - 1)),
    );
    this.cm.dispatch({ selection: sel, scrollIntoView: true });
  }

  // ---- focus & scrolling -------------------------------------------------

  focus(): void {
    this.cm.focus();
  }

  blur(): void {
    this.cm.contentDOM.blur();
  }

  hasFocus(): boolean {
    return this.cm.hasFocus;
  }

  getScrollInfo(): EditorScrollInfo {
    const s = this.cm.scrollDOM;
    return {
      top: s.scrollTop,
      left: s.scrollLeft,
      width: s.scrollWidth,
      height: s.scrollHeight,
      clientWidth: s.clientWidth,
      clientHeight: s.clientHeight,
    };
  }

  scrollTo(x?: number | null, y?: number | null): void {
    const s = this.cm.scrollDOM;
    if (typeof x === "number") s.scrollLeft = x;
    if (typeof y === "number") s.scrollTop = y;
  }

  scrollIntoView(range: EditorRange, center?: boolean): void {
    const from = this.posToOffset(range.from), to = this.posToOffset(range.to);
    this.cm.dispatch({
      effects: EditorView.scrollIntoView(EditorSelection.range(from, to), { y: center ? "center" : "nearest" }),
    });
  }

  // ---- history & commands ------------------------------------------------

  undo(): void {
    undo(this.cm);
  }

  redo(): void {
    redo(this.cm);
  }

  exec(command: EditorCommandName): void {
    const fn = COMMANDS[command];
    if (fn) fn(this.cm);
  }

  transaction(tx: EditorTransaction, origin?: string): void {
    const state = this.cm.state;
    // All change positions are in the current document; selections are in the resulting one.
    const changes: ChangeSpec[] = (tx.changes ?? []).map((c) => this.changeSpec(c));
    if (tx.replaceSelection !== undefined) {
      for (const r of state.selection.ranges) changes.push({ from: r.from, to: r.to, insert: tx.replaceSelection });
    }
    const changeSet = state.changes(changes);
    const newDoc = changeSet.apply(state.doc);
    const toRange = (r: EditorRangeOrCaret) => EditorSelection.range(this.posIn(newDoc, r.from), this.posIn(newDoc, r.to ?? r.from));
    let selection: EditorSelection | undefined;
    if (tx.selections?.length) selection = EditorSelection.create(tx.selections.map(toRange), tx.selections.length - 1);
    else if (tx.selection) selection = EditorSelection.create([toRange(tx.selection)]);
    else if (tx.replaceSelection !== undefined)
      selection = EditorSelection.create(state.selection.ranges.map((r) => EditorSelection.cursor(changeSet.mapPos(r.to, 1))), state.selection.mainIndex);
    this.cm.dispatch({ changes: changeSet, selection, scrollIntoView: true, userEvent: userEvent(origin) });
  }

  private changeSpec(c: EditorChange): ChangeSpec {
    let a = this.posToOffset(c.from);
    let b = c.to ? this.posToOffset(c.to) : a;
    if (a > b) [a, b] = [b, a];
    return { from: a, to: b, insert: c.text };
  }

  wordAt(pos: EditorPosition): EditorRange | null {
    const r = this.cm.state.wordAt(this.posToOffset(pos));
    return r ? { from: this.offsetToPos(r.from), to: this.offsetToPos(r.to) } : null;
  }

  // ---- internals plugins use (not in obsidian.d.ts) -------------------------

  /** internal (used by plugins: various, e.g. floating toolbars) — screen coordinates of a position. */
  coordsAtPos(pos: EditorPosition, side: -1 | 1 = 1): { left: number; right: number; top: number; bottom: number } | null {
    return this.cm.coordsAtPos(this.posToOffset(pos), side);
  }

  /** internal — document position at screen coordinates. */
  posAtCoords(left: number, top: number): EditorPosition {
    const off = this.cm.posAtCoords({ x: left, y: top }, false);
    return this.offsetToPos(off);
  }

  /** internal — document position under a mouse event. */
  posAtMouse(evt: MouseEvent): EditorPosition {
    return this.posAtCoords(evt.clientX, evt.clientY);
  }

  /** internal (used by plugins: link openers) — link, URL or tag at a position. */
  getClickableTokenAt(pos: EditorPosition): (ClickableToken & { start: EditorPosition; end: EditorPosition }) | null {
    const tok = clickableTokenAt(this.cm.state, this.posToOffset(pos));
    return tok ? { ...tok, start: this.offsetToPos(tok.from), end: this.offsetToPos(tok.to) } : null;
  }

  /** internal — fold one level more / less. */
  foldMore(): void {
    foldMoreCommand(this.cm);
  }
  foldLess(): void {
    foldLessCommand(this.cm);
  }

  /**
   * internal (used by plugins: Templater keeps folds across its cursor jump;
   * app.foldManager persists them) — folded ranges as 0-based line pairs.
   */
  getFoldInfo(): { folds: { from: number; to: number }[]; lines: number } {
    const doc = this.cm.state.doc;
    const folds: { from: number; to: number }[] = [];
    foldedRanges(this.cm.state).between(0, doc.length, (from, to) => {
      folds.push({ from: doc.lineAt(from).number - 1, to: doc.lineAt(to).number - 1 });
    });
    return { folds, lines: doc.lines };
  }

  /** internal — replace the folds with `info` (as returned by getFoldInfo). */
  applyFoldInfo(info: { folds?: { from: number; to: number }[]; lines?: number } | null): void {
    const state = this.cm.state;
    const doc = state.doc;
    const effects: import("@codemirror/state").StateEffect<unknown>[] = [];
    foldedRanges(state).between(0, doc.length, (from, to) => void effects.push(unfoldEffect.of({ from, to })));
    for (const f of info?.folds ?? []) {
      if (f.from < 0 || f.from >= doc.lines || f.to >= doc.lines || f.to <= f.from) continue;
      const line = doc.line(f.from + 1);
      // Prefer the heading/list range starting on that line; fall back to the stored lines.
      const range = foldRangeAt(state, line.from) ?? { from: line.to, to: doc.line(f.to + 1).to };
      effects.push(foldEffect.of(range));
    }
    if (effects.length) this.cm.dispatch({ effects });
  }

  // ---- internal formatting API ---------------------------------------------
  // Obsidian's Editor carries the formatting commands as methods, and toolbar
  // plugins (editing-toolbar, cMenu …) call them instead of running the
  // `editor:*` commands. Each is the same function the command runs.

  /** internal (used by plugins: editing-toolbar) */
  toggleMarkdownFormatting(syntax: FormatType): void {
    toggleFormatting(this.cm, syntax);
  }
  /** internal (used by plugins: editing-toolbar) */
  toggleBulletList(): void {
    toggleBulletList(this.cm);
  }
  /** internal (used by plugins: editing-toolbar) */
  toggleNumberList(): void {
    toggleNumberedList(this.cm);
  }
  /** internal (used by plugins: editing-toolbar) — checkbox syntax on the lines under the cursor. */
  toggleCheckList(_ignoreNonEmpty?: boolean): void {
    toggleChecklistStatus(this.cm);
  }
  /** internal */
  toggleBlockquote(): void {
    toggleBlockquote(this.cm);
  }
  /** internal */
  setHeading(level: number): void {
    setHeading(this.cm, level);
  }
  /** internal */
  insertCallout(): void {
    insertCallout(this.cm);
  }
  /** internal */
  insertCodeblock(): void {
    insertCodeBlock(this.cm);
  }
  /** internal */
  insertMathBlock(): void {
    insertMathBlock(this.cm);
  }
  /** internal */
  insertLink(): void {
    insertMarkdownLink(this.cm);
  }
  /** internal */
  triggerWikiLink(embed: boolean): void {
    insertWikilink(this.cm, embed);
  }
  /** internal */
  indentList(): void {
    indentList(this.cm);
  }
  /** internal */
  unindentList(): void {
    unindentList(this.cm);
  }
  /** internal */
  insertText(text: string): void {
    this.replaceSelection(text);
  }
}
