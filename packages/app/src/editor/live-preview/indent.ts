/**
 * List indentation: indentation guides (`span.cm-indent`, the one under the
 * cursor's list block gets `.cm-active-indent`; partial runs are left
 * unmarked) and the hanging indent Obsidian
 * puts on list lines (`text-indent:-Npx; padding-inline-start:Npx`) so
 * wrapped text aligns with the text after the bullet.
 */
import { getIndentUnit } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { configFacet } from "../facets";
import { ofmTree } from "../syntax/language";
import { editorLivePreviewField } from "../fields";

const indentMark = Decoration.mark({ class: "cm-indent" });
const activeIndentMark = Decoration.mark({ class: "cm-indent cm-active-indent" });

function enclosingList(state: EditorState, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = ofmTree(state).resolveInner(pos, 1);
  while (node && node.name !== "BulletList" && node.name !== "OrderedList") node = node.parent;
  return node;
}

/** Depth (number of ListItem ancestors) of the list item holding `pos`. */
function listDepthAt(state: EditorState, pos: number): number {
  let depth = 0;
  for (let n: SyntaxNode | null = ofmTree(state).resolveInner(pos, 1); n; n = n.parent) if (n.name === "ListItem") depth++;
  return depth;
}

function build(view: EditorView): DecorationSet {
  const state = view.state;
  const config = state.facet(configFacet);
  const tabSize = state.tabSize;
  const unit = Math.max(1, getIndentUnit(state));
  const ranges: Range<Decoration>[] = [];
  const lp = state.field(editorLivePreviewField, false);
  const charWidth = view.defaultCharacterWidth || 8;

  // The active indent block: the list containing the cursor's item, at the cursor item's level.
  const head = state.selection.main.head;
  const cursorLine = state.doc.lineAt(head);
  const cursorList = enclosingList(state, cursorLine.from + (cursorLine.text.length - cursorLine.text.trimStart().length));
  const activeLevel = cursorList ? listDepthAt(state, cursorLine.from + (cursorLine.text.length - cursorLine.text.trimStart().length)) - 1 : -1;
  const activeFrom = cursorList ? state.doc.lineAt(cursorList.from).number : -1;
  const activeTo = cursorList ? state.doc.lineAt(cursorList.to).number : -1;

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      const text = line.text;
      const lead = /^[ \t]*/.exec(text)![0];
      const list = enclosingList(state, line.from + lead.length);
      if (!list) continue;

      // Hanging indent for bullet lines.
      const marker = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[.\][ \t]+)?/.exec(text);
      if (marker) {
        const cols = columns(marker[1]!, tabSize) + marker[2]!.length + marker[3]!.length + (marker[4] && !lp ? marker[4].length : 0);
        const px = Math.round(cols * charWidth + (marker[4] && lp ? 22 : 0));
        ranges.push(
          Decoration.line({ attributes: { style: `text-indent:-${px}px;padding-inline-start:${px}px` } }).range(line.from),
        );
      }

      // Indent runs are marked whether or not guides are shown (the guide itself is
      // CSS under `.show-indentation-guide`): `.cm-indent` is inline-block, so a tab
      // inside it measures its own tab stop instead of one shifted by the hanging
      // `text-indent` above, which otherwise collapses a leading tab to a few pixels.
      if (!lead.length) continue;
      // One guide per tab or per full indent unit of spaces.
      let col = 0;
      let i = 0;
      let level = 0;
      while (i < lead.length) {
        const start = i;
        if (lead[i] === "\t") {
          i++;
          col += tabSize - (col % tabSize);
        } else {
          let n = 0;
          while (i < lead.length && lead[i] === " " && n < unit) {
            i++;
            n++;
          }
          col += n;
          if (n < unit) {
            continue;
          }
        }
        const active = level === activeLevel - 1 && line.number > activeFrom && line.number <= activeTo;
        ranges.push((active ? activeIndentMark : indentMark).range(line.from + start, line.from + i));
        level++;
      }
    }
  }
  return Decoration.set(ranges, true);
}

function columns(ws: string, tabSize: number) {
  let col = 0;
  for (const ch of ws) col = ch === "\t" ? col + tabSize - (col % tabSize) : col + 1;
  return col;
}

export const listIndentation = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    charWidth: number;
    constructor(view: EditorView) {
      this.decorations = build(view);
      this.charWidth = view.defaultCharacterWidth;
    }
    update(u: ViewUpdate) {
      const widthChanged = u.geometryChanged && u.view.defaultCharacterWidth !== this.charWidth;
      if (widthChanged) this.charWidth = u.view.defaultCharacterWidth;
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        widthChanged ||
        ofmTree(u.state) !== ofmTree(u.startState) ||
        u.state.facet(configFacet) !== u.startState.facet(configFacet) ||
        u.state.field(editorLivePreviewField, false) !== u.startState.field(editorLivePreviewField, false)
      ) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
