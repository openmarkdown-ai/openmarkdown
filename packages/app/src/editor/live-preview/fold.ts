/**
 * Heading and indent (list) folding with Obsidian's in-line fold indicators:
 * `div.cm-fold-indicator[.is-collapsed] > div.collapse-indicator.collapse-icon > svg.right-triangle`,
 * placed after the line's leading whitespace. Folded ranges use
 * @codemirror/language's fold state, so `foldedRanges`, `foldEffect` and
 * `unfoldEffect` work for plugins, and the placeholder is `.cm-foldPlaceholder`.
 */
import { codeFolding, foldEffect, foldService, foldedRanges, foldState, unfoldEffect } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { configFacet, hostFacet } from "../facets";
import { ofmTree } from "../syntax/language";
import { FoldIndicatorWidget } from "./widgets";

const HEADING = /^ATXHeading(\d)$/;

function trimTrailingBlank(state: EditorState, lineStartNo: number, endLineNo: number): number {
  let n = endLineNo;
  while (n > lineStartNo && state.doc.line(n).text.trim() === "") n--;
  return n;
}

/** Range folded by the line starting at `lineFrom` (heading section or list item body), or null. */
export function foldRangeAt(state: EditorState, lineFrom: number): { from: number; to: number } | null {
  const config = state.facet(configFacet);
  const doc = state.doc;
  const line = doc.lineAt(lineFrom);
  const tree = ofmTree(state);
  if (config.foldHeading) {
    const m = /^(#{1,6})[ \t]/.exec(line.text);
    if (m) {
      const node = tree.resolveInner(line.from, 1);
      let heading: SyntaxNode | null = node;
      while (heading && !HEADING.test(heading.name)) heading = heading.parent;
      if (heading && heading.from === line.from) {
        const level = Number(HEADING.exec(heading.name)![1]);
        let endLine = doc.lines;
        // Next heading of the same or a higher level ends the section.
        for (let sib = topLevel(heading).nextSibling; sib; sib = sib.nextSibling) {
          const hm = HEADING.exec(sib.name);
          if (hm && Number(hm[1]) <= level) {
            endLine = doc.lineAt(sib.from).number - 1;
            break;
          }
        }
        endLine = trimTrailingBlank(state, line.number, endLine);
        if (endLine > line.number) return { from: line.to, to: doc.line(endLine).to };
        return null;
      }
    }
  }
  if (config.foldIndent) {
    const node = tree.resolveInner(line.from + (line.text.length - line.text.trimStart().length), 1);
    let item: SyntaxNode | null = node;
    while (item && item.name !== "ListItem") item = item.parent;
    if (item && doc.lineAt(item.from).number === line.number) {
      const endLine = trimTrailingBlank(state, line.number, doc.lineAt(item.to).number);
      if (endLine > line.number) return { from: line.to, to: doc.line(endLine).to };
    }
  }
  return null;
}

function topLevel(node: SyntaxNode): SyntaxNode {
  let n = node;
  while (n.parent && n.parent.name !== "Document") n = n.parent;
  return n;
}

function isFolded(state: EditorState, range: { from: number; to: number }): boolean {
  let found = false;
  foldedRanges(state).between(range.from, range.from, (from, to) => {
    if (from === range.from) found = true;
    void to;
  });
  return found;
}

export function toggleFoldAt(view: EditorView, lineFrom: number): boolean {
  const range = foldRangeAt(view.state, lineFrom);
  if (!range) return false;
  if (isFolded(view.state, range)) {
    const effects = [] as ReturnType<typeof unfoldEffect.of>[];
    foldedRanges(view.state).between(range.from, range.from, (from, to) => {
      if (from === range.from) effects.push(unfoldEffect.of({ from, to }));
    });
    view.dispatch({ effects });
  } else {
    view.dispatch({ effects: foldEffect.of(range) });
  }
  return true;
}

export function toggleFoldCommand(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  // Try the cursor line, then enclosing headings/items above it.
  for (let n = line.number; n >= 1; n--) {
    const l = view.state.doc.line(n);
    const range = foldRangeAt(view.state, l.from);
    if (range && (n === line.number || range.to >= line.from)) return toggleFoldAt(view, l.from);
  }
  return false;
}

export function foldAllCommand(view: EditorView): boolean {
  const effects = [];
  const state = view.state;
  let covered = -1;
  for (let n = 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    if (l.from <= covered) continue;
    const range = foldRangeAt(state, l.from);
    if (range && !isFolded(state, range)) {
      effects.push(foldEffect.of(range));
      covered = range.to;
    }
  }
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

export function unfoldAllCommand(view: EditorView): boolean {
  const effects: ReturnType<typeof unfoldEffect.of>[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }));
  });
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
}

/** Fold one level deeper / shallower (Obsidian's "Fold more" / "Fold less"). */
export function foldLessCommand(view: EditorView): boolean {
  // Unfold the innermost folded ranges first.
  const ranges: { from: number; to: number }[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    ranges.push({ from, to });
  });
  if (!ranges.length) return false;
  const inner = ranges.filter((r) => !ranges.some((o) => o !== r && o.from > r.from && o.to <= r.to));
  view.dispatch({ effects: inner.map((r) => unfoldEffect.of(r)) });
  return true;
}

export function foldMoreCommand(view: EditorView): boolean {
  // Fold the deepest unfolded foldable ranges.
  const state = view.state;
  const all: { from: number; to: number }[] = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const r = foldRangeAt(state, state.doc.line(n).from);
    if (r && !isFolded(state, r)) all.push(r);
  }
  const deepest = all.filter((r) => !all.some((o) => o !== r && o.from > r.from && o.to <= r.to));
  if (!deepest.length) return false;
  view.dispatch({ effects: deepest.map((r) => foldEffect.of(r)) });
  return true;
}

const foldIndicators = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        ofmTree(u.state) !== ofmTree(u.startState) ||
        u.state.field(foldState, false) !== u.startState.field(foldState, false) ||
        u.state.facet(configFacet) !== u.startState.facet(configFacet)
      ) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const state = view.state;
      const config = state.facet(configFacet);
      if (!config.foldHeading && !config.foldIndent) return Decoration.none;
      const host = state.facet(hostFacet);
      const ranges: Range<Decoration>[] = [];
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = state.doc.lineAt(pos);
          const text = line.text;
          if (/^\s*(#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t])/.test(text)) {
            const range = foldRangeAt(state, line.from);
            if (range) {
              const indent = text.length - text.trimStart().length;
              ranges.push(
                Decoration.widget({ widget: new FoldIndicatorWidget(host, isFolded(state, range), onToggle), side: -1 }).range(line.from + indent),
              );
            }
          }
          pos = line.to + 1;
        }
      }
      return Decoration.set(ranges, true);
    }
  },
  { decorations: (v) => v.decorations },
);

function onToggle(view: EditorView, pos: number) {
  toggleFoldAt(view, view.state.doc.lineAt(pos).from);
}

export function folding(): Extension {
  return [
    codeFolding({
      placeholderDOM(view, onclick) {
        const span = document.createElement("span");
        span.className = "cm-foldPlaceholder";
        span.title = "unfold";
        span.textContent = "…";
        span.onclick = onclick;
        void view;
        return span;
      },
    }),
    foldIndicators,
    // The same ranges through CM6's fold service, so `foldable(state, from, to)`
    // answers for headings and list items as in Obsidian (Outliner folds with
    // `foldable` + `foldEffect`, and `foldCode`/`foldAll` commands use it).
    foldService.of((state, lineStart) => foldRangeAt(state, lineStart)),
  ];
}
