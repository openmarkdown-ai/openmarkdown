/**
 * Turns HyperMD token data into decorations for the visible ranges.
 *
 * Runs at the lowest precedence so its spans are the *outer* elements and
 * Live Preview's marks (`.list-bullet`, `.cm-underline`) nest inside, the
 * nesting themes expect (`.cm-formatting-list .list-bullet`).
 */
import { RangeSetBuilder, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import { computeTokens } from "./hypermd";
import { ofmTree } from "./language";
import { editorLivePreviewField } from "../fields";

const markCache = new Map<string, Decoration>();
function markFor(classes: string[]): Decoration {
  const key = classes.join(" ");
  let d = markCache.get(key);
  if (!d) {
    d = Decoration.mark({ class: classes.map((c) => "cm-" + c).join(" ") });
    if (markCache.size < 5000) markCache.set(key, d);
  }
  return d;
}

const lineCache = new Map<string, Decoration>();
function lineFor(classes: string[], attrs?: Record<string, string>): Decoration {
  const key = classes.join(" ") + (attrs ? JSON.stringify(attrs) : "");
  let d = lineCache.get(key);
  if (!d) {
    d = Decoration.line({ class: classes.join(" "), attributes: attrs });
    if (lineCache.size < 5000) lineCache.set(key, d);
  }
  return d;
}

function build(view: EditorView): DecorationSet {
  const tree = ofmTree(view.state);
  const lp = view.state.field(editorLivePreviewField, false) ?? false;
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  // Visible ranges, expanded to whole lines and merged.
  const ranges: { from: number; to: number }[] = [];
  for (const r of view.visibleRanges) {
    const from = doc.lineAt(r.from).from, to = doc.lineAt(r.to).to;
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }
  for (const { from, to } of ranges) {
    const { spans, lines } = computeTokens(tree, doc, from, to, lp);
    // Line decorations must be added before marks starting at the same position.
    const lineNums = [...lines.keys()].sort((a, b) => a - b);
    let li = 0;
    for (const span of spans) {
      while (li < lineNums.length && doc.line(lineNums[li]!).from <= span.from) {
        addLine(builder, doc.line(lineNums[li]!).from, lines.get(lineNums[li]!)!);
        li++;
      }
      builder.add(span.from, span.to, markFor(span.classes));
    }
    while (li < lineNums.length) {
      addLine(builder, doc.line(lineNums[li]!).from, lines.get(lineNums[li]!)!);
      li++;
    }
  }
  return builder.finish();
}

function addLine(builder: RangeSetBuilder<Decoration>, pos: number, info: { classes: Set<string>; attrs?: Record<string, string> }) {
  if (!info.classes.size && !info.attrs) return;
  builder.add(pos, pos, lineFor([...info.classes].sort(), info.attrs));
}

export const hypermdHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        ofmTree(u.state) !== ofmTree(u.startState) ||
        u.state.field(editorLivePreviewField, false) !== u.startState.field(editorLivePreviewField, false)
      ) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Obsidian's `cm-active` on every line holding a selection head. */
const activeLine = Decoration.line({ class: "cm-active" });
export const activeLineClass = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      let last = -1;
      const heads = view.state.selection.ranges.map((r) => view.state.doc.lineAt(r.head).from).sort((a, b) => a - b);
      for (const from of heads) {
        if (from === last) continue;
        builder.add(from, from, activeLine);
        last = from;
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

export function syntaxClasses(): Extension {
  return [Prec.lowest(hypermdHighlighter), activeLineClass];
}
