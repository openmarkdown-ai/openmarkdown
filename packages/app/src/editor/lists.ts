/**
 * Smart lists and quotes (Obsidian's "Smart indent lists"):
 *
 *  - Enter continues a bullet, number, task, quote or callout on the next line;
 *    the new task is unchecked and the new number is one higher.
 *  - Enter on an empty item outdents it, or ends the list when it is already
 *    at the top level; on an empty `> ` line it ends the quote.
 *  - Tab / Shift-Tab indent and unindent list items (whole lines, wherever
 *    the cursor is); inside a table they move between cells.
 *  - Ordered lists are renumbered after edits that change their structure.
 */
import { EditorSelection, Prec } from "@codemirror/state";
import type { ChangeSpec, EditorState, Extension, SelectionRange } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { getIndentUnit, indentUnit } from "@codemirror/language";
import { indentLess, indentMore, insertNewlineKeepIndent, insertTab } from "@codemirror/commands";
import { deleteMarkupBackward } from "@codemirror/lang-markdown";
import type { SyntaxNode, Tree } from "@lezer/common";
import { ensureOfmTree, ofmTree } from "./syntax/language";
import { OFM } from "./syntax/ofm";
import { configFacet } from "./facets";
import { editorLivePreviewField } from "./fields";

const LIST_RE = /^([ \t]*(?:>[ \t]?)*[ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(?:\[(.)\]([ \t]+|$))?/;
const QUOTE_RE = /^([ \t]*)((?:>[ \t]?)+)/;
const CALLOUT_HEAD_RE = /^[ \t]*(?:>[ \t]?)+\[![^\]]*\][+-]?/;

function tree(state: EditorState): Tree {
  return ensureOfmTree(state, state.doc.length, 50) ?? ofmTree(state);
}

/** True when `pos` is inside a code block, math block or frontmatter, where Enter is plain. */
export function inRawBlock(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = ofmTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === OFM.MathBlock || n.name === OFM.Frontmatter || n.name === "HTMLBlock") {
      // The opening fence line itself behaves like text.
      if (n.name === "FencedCode" && state.doc.lineAt(pos).from === state.doc.lineAt(n.from).from && pos <= state.doc.lineAt(n.from).to) return false;
      return true;
    }
  }
  return false;
}

function dedentOnce(prefix: string, state: EditorState): string {
  const unit = getIndentUnit(state);
  // Remove one tab or one indent unit of spaces from the indentation after the last `>`.
  const lastQuote = prefix.lastIndexOf(">");
  const head = lastQuote < 0 ? "" : prefix.slice(0, lastQuote + 1) + (/^[ \t]/.test(prefix.slice(lastQuote + 1)) ? prefix[lastQuote + 1] : "");
  const m = [prefix, head, prefix.slice(head.length)];
  let ws = m[2]!;
  if (ws.endsWith("\t")) ws = ws.slice(0, -1);
  else {
    let n = 0;
    while (n < unit && ws.endsWith(" ")) {
      ws = ws.slice(0, -1);
      n++;
    }
  }
  return m[1] + ws;
}

export function smartEnter(view: EditorView, tableEnter?: TableKey): boolean {
  if (tableEnter && inTable(view.state) && view.state.selection.ranges.length === 1) {
    const r = tableEnter(view);
    if (r !== false) return r === true;
  }
  if (closeFenceOnEnter(view) || frontmatterOnEnter(view)) return true;
  const state = view.state;
  const config = state.facet(configFacet);
  if (!config.smartIndentList) return false;
  let handled = false;
  const tr = state.changeByRange((range: SelectionRange) => {
    const plain = () => {
      const insert = "\n";
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
    };
    if (!range.empty || inRawBlock(state, range.head)) return plain();
    const pos = range.head;
    const line = state.doc.lineAt(pos);
    const text = line.text;
    const col = pos - line.from;
    const m = LIST_RE.exec(text);
    const markerEnd = m ? m[1]!.length + (m[2] ?? m[3]! + m[4]!).length : 0;
    if (m && col >= markerEnd) {
      handled = true;
      const contentStart = m[0].length;
      const content = text.slice(contentStart);
      const before = m[1]!;
      if (!content.trim()) {
        // Empty item: outdent, or end the list.
        const lastQuote = before.lastIndexOf(">");
        const ws = lastQuote < 0 ? before : before.slice(lastQuote + 1).replace(/^[ \t]/, "");
        if (ws.length > 0) {
          const newPrefix = dedentOnce(before, state);
          const marker = m[2] ?? `${m[3]}${m[4]}`;
          const task = m[6] !== undefined ? `[${m[6]}] ` : "";
          const insert = `${newPrefix}${marker}${m[5]}${task}`;
          return { changes: { from: line.from, to: line.to, insert }, range: EditorSelection.cursor(line.from + insert.length) };
        }
        const quote = QUOTE_RE.exec(text)?.[0] ?? "";
        return { changes: { from: line.from, to: line.to, insert: quote }, range: EditorSelection.cursor(line.from + quote.length) };
      }
      const nextMarker = m[2] ?? `${Number(m[3]) + 1}${m[4]}`;
      const task = m[6] !== undefined ? "[ ] " : "";
      const prefix = `${before}${nextMarker}${m[5]!.includes("\t") ? m[5] : " "}${task}`;
      // Text after the cursor moves to the new item without its leading spaces.
      let to = pos;
      while (to < line.to && (text[to - line.from] === " " || text[to - line.from] === "\t")) to++;
      const insert = "\n" + prefix;
      return { changes: { from: pos, to, insert }, range: EditorSelection.cursor(pos + insert.length) };
    }
    const q = QUOTE_RE.exec(text);
    if (q && col >= q[0].length) {
      handled = true;
      const rest = text.slice(q[0].length);
      const isCalloutHead = CALLOUT_HEAD_RE.test(text);
      if (!rest.trim() && !isCalloutHead) {
        // Empty quote line: end the quote (one level).
        const shorter = q[0].replace(/>[ \t]?$/, "").replace(/[ \t]+$/, "");
        const insert = shorter ? shorter + " " : "";
        return { changes: { from: line.from, to: line.to, insert }, range: EditorSelection.cursor(line.from + insert.length) };
      }
      const prefix = q[1] + q[2]!.replace(/>(?![ \t])/g, "> ").replace(/[ \t]*$/, " ");
      const insert = "\n" + prefix;
      return { changes: { from: pos, to: pos, insert }, range: EditorSelection.cursor(pos + insert.length) };
    }
    return plain();
  });
  if (!handled) return insertNewlineKeepIndent(view);
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  renumberOrderedLists(view);
  return true;
}

function selectionInList(state: EditorState): boolean {
  return state.selection.ranges.every((r) => {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      if (!LIST_RE.test(state.doc.line(n).text)) return false;
    }
    return true;
  });
}

function inTable(state: EditorState): boolean {
  const pos = state.selection.main.head;
  for (let n: SyntaxNode | null = ofmTree(state).resolveInner(pos, -1); n; n = n.parent) if (n.name === "Table") return true;
  return false;
}

/**
 * A table key handler: true = handled, false = not a table key here (normal
 * Tab/Enter handling continues), "pass" = leave the key to other keymaps (a
 * table plugin such as Advanced Tables is handling tables).
 */
export type TableKey = (view: EditorView) => boolean | "pass";

export function smartTab(view: EditorView, tableNext: TableKey): boolean {
  const state = view.state;
  if (inTable(state) && state.selection.ranges.length === 1) {
    const r = tableNext(view);
    if (r !== false) return r === true;
  }
  const config = state.facet(configFacet);
  if (config.smartIndentList && selectionInList(state)) {
    indentMore(view);
    restartNestedNumbering(view);
    renumberOrderedLists(view);
    return true;
  }
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
  return insertTab(view);
}

export function smartShiftTab(view: EditorView, tablePrev: TableKey): boolean {
  const state = view.state;
  if (inTable(state) && state.selection.ranges.length === 1) {
    const r = tablePrev(view);
    if (r !== false) return r === true;
  }
  const ok = indentLess(view);
  renumberOrderedLists(view);
  return ok;
}

/** Fix the numbering of every ordered list touched by the selection. */
export function renumberOrderedLists(view: EditorView): void {
  const state = view.state;
  const t = tree(state);
  const tops = new Set<SyntaxNode>();
  for (const r of state.selection.ranges) {
    for (const pos of [r.from, r.to]) {
      const line = state.doc.lineAt(pos);
      let top: SyntaxNode | null = null;
      for (let n: SyntaxNode | null = t.resolveInner(line.from + (line.text.length - line.text.trimStart().length), 1); n; n = n.parent) {
        if (n.name === "BulletList" || n.name === "OrderedList") top = n;
      }
      // Also a list directly below the cursor line (after splitting an item).
      if (!top && line.number < state.doc.lines) {
        const next = state.doc.line(line.number + 1);
        for (let n: SyntaxNode | null = t.resolveInner(next.from + (next.text.length - next.text.trimStart().length), 1); n; n = n.parent) {
          if (n.name === "BulletList" || n.name === "OrderedList") top = n;
        }
      }
      if (top) tops.add(top);
    }
  }
  const changes: ChangeSpec[] = [];
  const visit = (list: SyntaxNode) => {
    if (list.name === "OrderedList") {
      let expected = -1;
      for (let item = list.firstChild; item; item = item.nextSibling) {
        if (item.name !== "ListItem") continue;
        const mark = item.firstChild;
        if (!mark || mark.name !== "ListMark") continue;
        const text = state.doc.sliceString(mark.from, mark.to);
        const num = /^(\d+)/.exec(text);
        if (!num) continue;
        if (expected < 0) expected = Number(num[1]);
        else if (Number(num[1]) !== expected) changes.push({ from: mark.from, to: mark.from + num[1]!.length, insert: String(expected) });
        expected++;
      }
    }
    for (let child = list.firstChild; child; child = child.nextSibling) visitDeep(child);
  };
  const visitDeep = (node: SyntaxNode) => {
    if (node.name === "OrderedList" || node.name === "BulletList") visit(node);
    else for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === "ListItem" || c.name === "OrderedList" || c.name === "BulletList") visitDeep(c);
  };
  for (const top of tops) visit(top);
  if (changes.length) view.dispatch({ changes, userEvent: "input" });
}

// ---------------------------------------------------------------------------
// Code fences and frontmatter typed by hand
// ---------------------------------------------------------------------------

const FENCE_OPEN_RE = /^([ \t]*(?:>[ \t]?)*[ \t]*)(`{3,}|~{3,})([^`]*)$/;

/**
 * Enter at the end of an opening fence that has no closing fence: close it and
 * put the cursor on the empty line between (Obsidian's behaviour).
 */
export function closeFenceOnEnter(view: EditorView): boolean {
  const state = view.state;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const pos = sel.main.head;
  const line = state.doc.lineAt(pos);
  if (pos !== line.to) return false;
  const m = FENCE_OPEN_RE.exec(line.text);
  if (!m) return false;
  const t = tree(state);
  let fence: SyntaxNode | null = null;
  for (let n: SyntaxNode | null = t.resolveInner(line.from + m[1]!.length, 1); n; n = n.parent) {
    if (n.name === "FencedCode") {
      fence = n;
      break;
    }
  }
  // Only the opening line of a fence that runs to the end of the document unclosed.
  if (!fence || state.doc.lineAt(fence.from).number !== line.number) return false;
  const marks = fence.getChildren("CodeMark");
  if (marks.length >= 2 && state.doc.lineAt(marks[marks.length - 1]!.from).number !== line.number) return false;
  const prefix = m[1]!;
  const insert = `\n${prefix}\n${prefix}${m[2]}`;
  view.dispatch({ changes: { from: pos, insert }, selection: EditorSelection.cursor(pos + 1 + prefix.length), userEvent: "input", scrollIntoView: true });
  return true;
}

/**
 * Enter after typing `---` on the first line of a note without frontmatter
 * starts the properties block: in Live Preview the Properties widget appears
 * with a new property's name focused; elsewhere the YAML fences are written
 * with the cursor between them.
 */
export function frontmatterOnEnter(view: EditorView): boolean {
  const state = view.state;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const line = state.doc.line(1);
  if (line.text !== "---" || sel.main.head !== line.to) return false;
  // `---` already opens a frontmatter block (a closing fence exists further down).
  const first = tree(state).topNode.firstChild;
  if (first && first.name === OFM.Frontmatter && first.getChildren(OFM.FrontmatterMark).length >= 2) return false;
  const config = state.facet(configFacet);
  const lp = state.field(editorLivePreviewField, false) ?? false;
  if (lp && config.propertiesInDocument === "visible") {
    const rest = state.doc.length > line.to ? "" : "\n";
    view.dispatch({ changes: { from: line.to, insert: "\n---" + rest }, selection: EditorSelection.cursor(Math.min(line.to + 4 + rest.length, line.to + 4 + rest.length)), userEvent: "input" });
    // The properties widget renders synchronously from the update listener.
    const container = view.dom.closest(".markdown-source-view")?.querySelector<HTMLElement>(".metadata-container") as (HTMLElement & { __metadataEditor?: { addProperty(key?: string): void } }) | null;
    const editor = container?.__metadataEditor;
    if (editor) editor.addProperty();
    else container?.querySelector<HTMLElement>(".metadata-add-button")?.click();
    return true;
  }
  view.dispatch({ changes: { from: line.to, insert: "\n\n---" }, selection: EditorSelection.cursor(line.to + 1), userEvent: "input", scrollIntoView: true });
  return true;
}

// ---------------------------------------------------------------------------
// List backspace and numbering
// ---------------------------------------------------------------------------

/**
 * Backspace with the cursor right after a list marker: a task's checkbox is
 * removed first; a nested item is outdented one level; a top-level item loses
 * its marker and becomes plain text.
 */
export function listBackspace(view: EditorView): boolean {
  const state = view.state;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return false;
  const pos = sel.main.head;
  if (inRawBlock(state, pos)) return false;
  const line = state.doc.lineAt(pos);
  const m = LIST_RE.exec(line.text);
  if (!m || pos - line.from !== m[0].length) return false;
  const before = m[1]!;
  const markerFrom = line.from + before.length;
  if (m[6] !== undefined) {
    // `- [ ] |` → `- |`
    const boxFrom = line.from + m[0].length - (m[7]?.length ?? 0) - 3;
    view.dispatch({ changes: { from: boxFrom, to: pos }, selection: EditorSelection.cursor(boxFrom), userEvent: "delete.backward" });
    return true;
  }
  const lastQuote = before.lastIndexOf(">");
  const ws = lastQuote < 0 ? before : before.slice(lastQuote + 1).replace(/^[ \t]/, "");
  if (ws.length > 0) {
    const newPrefix = dedentOnce(before, state);
    view.dispatch({
      changes: { from: line.from, to: markerFrom, insert: newPrefix },
      selection: EditorSelection.cursor(pos - (before.length - newPrefix.length)),
      userEvent: "delete.dedent",
    });
    renumberOrderedLists(view);
    return true;
  }
  view.dispatch({ changes: { from: markerFrom, to: pos }, selection: EditorSelection.cursor(markerFrom), userEvent: "delete.backward" });
  renumberOrderedLists(view);
  return true;
}

/**
 * After indenting: an ordered item that became the first item of a nested
 * list starts again at 1 (it kept its old number before).
 */
export function restartNestedNumbering(view: EditorView): void {
  const state = view.state;
  const doc = state.doc;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  const width = (ws: string) => ws.replace(/\t/g, " ".repeat(state.tabSize)).length;
  for (const r of state.selection.ranges) {
    for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = doc.line(n);
      const m = LIST_RE.exec(line.text);
      if (!m || m[3] === undefined) continue;
      const indent = width(/^[ \t]*/.exec(m[1]!)![0]);
      if (indent === 0) continue;
      // Is there an earlier sibling at the same indentation before a shallower line?
      let first = true;
      for (let k = n - 1; k >= 1; k--) {
        const t = doc.line(k).text;
        if (!t.trim()) continue;
        const km = LIST_RE.exec(t);
        const kIndent = width(/^[ \t]*/.exec(km ? km[1]! : t)![0]);
        if (kIndent < indent) break;
        if (kIndent === indent && km) {
          first = false;
          break;
        }
      }
      if (!first || m[3] === "1") continue;
      const numFrom = line.from + m[1]!.length;
      changes.push({ from: numFrom, to: numFrom + m[3].length, insert: "1" });
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: "input" });
}

export function smartListKeymap(tableNext: TableKey, tablePrev: TableKey, tableEnter?: TableKey, tableShiftEnter?: TableKey): Extension {
  return Prec.high(
    keymap.of([
      {
        key: "Enter",
        run: (v) => smartEnter(v, tableEnter),
        shift: (v) => {
          if (!tableShiftEnter || !inTable(v.state)) return false;
          return tableShiftEnter(v) === true;
        },
      },
      { key: "Tab", run: (v) => smartTab(v, tableNext), shift: (v) => smartShiftTab(v, tablePrev) },
      { key: "Backspace", run: (v) => (v.state.facet(configFacet).smartIndentList ? listBackspace(v) || deleteMarkupBackward(v) : false) },
    ]),
  );
}

export { indentUnit };
