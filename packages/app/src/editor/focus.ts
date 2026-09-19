/**
 * Focus-mode dimming and typewriter scrolling.
 *
 * Focus mode is an app-wide, transient state (not saved): the writing-focus
 * core plugin calls `setFocusModeActive(on)`, which records it here (editors
 * created later start with it) and pushes `setFocusModeEffect` into every
 * live editor. While it is on and `focusDim` is not "off", everything outside
 * the current paragraph / sentence / line gets the class `cm-dimmed`
 * (opacity from `--focus-dim-opacity`), per selection range.
 *
 * Typewriter scrolling (`typewriterScroll`, `typewriterOffset` percent) keeps
 * the caret line at a fixed height of the scroller after keyboard edits and
 * keyboard cursor moves; pointer selections are left alone. The sizer gets
 * bottom padding so the last line can reach that height. It steps aside when
 * a typewriter community plugin is enabled.
 */
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { configFacet, hostFacet } from "./facets";
import { ofmTree } from "./syntax/language";

// ---------------------------------------------------------------------------
// Focus mode state
// ---------------------------------------------------------------------------

let focusModeActive = false;
const liveViews = new Set<EditorView>();

/** Toggle focus mode in every editor (and in editors created afterwards). */
export const setFocusModeEffect = StateEffect.define<boolean>();

export const focusModeField = StateField.define<boolean>({
  create: () => focusModeActive,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocusModeEffect)) value = e.value;
    return value;
  },
});

export function setFocusModeActive(on: boolean): void {
  focusModeActive = on;
  for (const view of liveViews) {
    if (view.state.field(focusModeField, false) !== on) view.dispatch({ effects: setFocusModeEffect.of(on) });
  }
}

export function isFocusModeActive(): boolean {
  return focusModeActive;
}

// ---------------------------------------------------------------------------
// Dimming
// ---------------------------------------------------------------------------

const dimLine = Decoration.line({ class: "cm-dimmed" });
const dimMark = Decoration.mark({ class: "cm-dimmed" });

const BLOCK_NODES = new Set(["Paragraph", "FencedCode", "CodeBlock", "Table", "Blockquote", "HTMLBlock", "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6", "SetextHeading1", "SetextHeading2", "HorizontalRule"]);

function lineRangeOf(state: EditorState, from: number, to: number) {
  return { from: state.doc.lineAt(from).from, to: state.doc.lineAt(Math.max(from, to)).to };
}

/** The paragraph-like block around `pos`: a list item (without its sub-lists), a top-level block, or the line. */
export function paragraphAt(state: EditorState, pos: number): { from: number; to: number } {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  if (!line.text.trim()) return { from: line.from, to: line.to };
  const tree = ofmTree(state);
  const start = line.from + (line.text.length - line.text.trimStart().length);
  let item: SyntaxNode | null = null;
  let block: SyntaxNode | null = null;
  for (let n: SyntaxNode | null = tree.resolveInner(Math.min(Math.max(pos, start), line.to), 1); n; n = n.parent) {
    if (!item && n.name === "ListItem") item = n;
    if (n.parent && n.parent.name === "Document") block = n;
  }
  if (!block) {
    for (let n: SyntaxNode | null = tree.resolveInner(start, 1); n; n = n.parent) if (n.parent && n.parent.name === "Document") block = n;
  }
  if (item) {
    let end = item.to;
    for (let c = item.firstChild; c; c = c.nextSibling) {
      if (c.name === "BulletList" || c.name === "OrderedList") {
        end = Math.max(item.from, c.from - 1);
        break;
      }
    }
    const r = lineRangeOf(state, item.from, end);
    if (r.from <= pos && pos <= r.to) return trimBlank(state, r);
  }
  if (block && (BLOCK_NODES.has(block.name) || block.name.startsWith("ATXHeading") || /Callout|Math|Frontmatter/.test(block.name))) {
    return trimBlank(state, lineRangeOf(state, block.from, block.to));
  }
  // Fallback: contiguous non-blank lines.
  let a = line.number, b = line.number;
  while (a > 1 && doc.line(a - 1).text.trim()) a--;
  while (b < doc.lines && doc.line(b + 1).text.trim()) b++;
  return { from: doc.line(a).from, to: doc.line(b).to };
}

function trimBlank(state: EditorState, r: { from: number; to: number }) {
  const doc = state.doc;
  let last = doc.lineAt(r.to);
  while (last.from > r.from && !last.text.trim()) last = doc.line(last.number - 1);
  return { from: r.from, to: last.to };
}

const TERMINATOR = /[.!?…。！？]/;

/** The sentence around `pos`, within its paragraph. */
export function sentenceAt(state: EditorState, pos: number): { from: number; to: number } {
  const para = paragraphAt(state, pos);
  const text = state.sliceDoc(para.from, para.to);
  const rel = pos - para.from;
  // Start: after the last terminator (followed by whitespace, or CJK) before the caret.
  let start = 0;
  for (let i = rel - 1; i >= 0; i--) {
    const c = text[i]!;
    if (TERMINATOR.test(c) && (i + 1 >= text.length || /\s/.test(text[i + 1]!) || /[。！？]/.test(c))) {
      // The caret sitting right after the terminator still belongs to that sentence.
      if (i + 1 >= rel) continue;
      start = i + 1;
      break;
    }
  }
  while (start < rel && /\s/.test(text[start]!)) start++;
  let end = text.length;
  for (let i = Math.max(rel, start); i < text.length; i++) {
    const c = text[i]!;
    if (TERMINATOR.test(c)) {
      let j = i + 1;
      while (j < text.length && TERMINATOR.test(text[j]!)) j++;
      if (j >= text.length || /\s/.test(text[j]!) || /[。！？]/.test(c)) {
        end = j;
        break;
      }
    }
  }
  return { from: para.from + start, to: para.from + end };
}

function focusRanges(state: EditorState, mode: "paragraph" | "sentence" | "line"): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const r of state.selection.ranges) {
    if (mode === "line") out.push(lineRangeOf(state, r.from, r.to));
    else if (mode === "sentence") {
      const a = sentenceAt(state, r.from);
      const b = r.empty ? a : sentenceAt(state, r.to);
      out.push({ from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) });
    } else {
      const a = paragraphAt(state, r.from);
      const b = r.empty ? a : paragraphAt(state, r.to);
      out.push({ from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) });
    }
  }
  out.sort((x, y) => x.from - y.from);
  const merged: { from: number; to: number }[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

function buildDimming(view: EditorView): DecorationSet {
  const state = view.state;
  const mode = state.facet(configFacet).focusDim;
  if (!state.field(focusModeField, false) || !mode || mode === "off") return Decoration.none;
  const focus = focusRanges(state, mode);
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      const inside = focus.filter((f) => f.from <= line.to && f.to >= line.from);
      if (!inside.length) {
        decos.push(dimLine.range(line.from));
      } else if (line.length) {
        // Dim the parts of the line outside the focused ranges (sentence mode).
        let cursor = line.from;
        for (const f of inside) {
          if (f.from > cursor) decos.push(dimMark.range(cursor, Math.min(f.from, line.to)));
          cursor = Math.max(cursor, f.to);
        }
        if (cursor < line.to) decos.push(dimMark.range(cursor, line.to));
      }
      pos = line.to + 1;
    }
  }
  const builder = new RangeSetBuilder<Decoration>();
  decos.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  for (const d of decos) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

class DimmingPlugin {
  decorations: DecorationSet;
  constructor(readonly view: EditorView) {
    liveViews.add(view);
    this.decorations = buildDimming(view);
    // An editor created before a toggle it missed catches up.
    if (view.state.field(focusModeField, false) !== focusModeActive) queueMicrotask(() => liveViews.has(view) && view.dispatch({ effects: setFocusModeEffect.of(focusModeActive) }));
  }
  update(u: ViewUpdate) {
    const active = u.state.field(focusModeField, false);
    const changed = active !== u.startState.field(focusModeField, false) || u.state.facet(configFacet).focusDim !== u.startState.facet(configFacet).focusDim;
    if (changed || (active && (u.docChanged || u.selectionSet || u.viewportChanged))) this.decorations = buildDimming(u.view);
    u.view.dom.classList.toggle("is-focus-mode", !!active);
  }
  destroy() {
    liveViews.delete(this.view);
  }
}

export function focusDimming(): Extension {
  return [focusModeField, ViewPlugin.fromClass(DimmingPlugin, { decorations: (p) => p.decorations })];
}

// ---------------------------------------------------------------------------
// Typewriter scrolling
// ---------------------------------------------------------------------------

const TYPEWRITER_PLUGINS = ["obsidian-typewriter-mode", "typewriter-scroll-obsidian"];

function typewriterOn(view: EditorView): boolean {
  const c = view.state.facet(configFacet);
  if (!c.typewriterScroll) return false;
  const host = view.state.facet(hostFacet);
  return !TYPEWRITER_PLUGINS.some((id) => host?.isPluginEnabled?.(id));
}

function offsetFraction(view: EditorView): number {
  const n = Number(view.state.facet(configFacet).typewriterOffset);
  return Math.max(0.1, Math.min(0.9, (Number.isFinite(n) ? n : 50) / 100));
}

class TypewriterPlugin {
  private padded = false;
  constructor(readonly view: EditorView) {
    this.syncPadding();
  }

  private sizer(): HTMLElement | null {
    return this.view.scrollDOM.querySelector<HTMLElement>(":scope > .cm-sizer");
  }

  private syncPadding() {
    const on = typewriterOn(this.view);
    if (!on && !this.padded) return;
    this.view.requestMeasure({
      key: this,
      read: () => this.view.scrollDOM.clientHeight,
      write: (height) => {
        const sizer = this.sizer();
        if (!sizer) return;
        if (on) {
          sizer.style.paddingBottom = `${Math.round(height * (1 - offsetFraction(this.view)))}px`;
          this.padded = true;
        } else if (this.padded) {
          sizer.style.paddingBottom = "";
          this.padded = false;
        }
      },
    });
  }

  update(u: ViewUpdate) {
    const cfg = u.state.facet(configFacet), prev = u.startState.facet(configFacet);
    if (cfg.typewriterScroll !== prev.typewriterScroll || cfg.typewriterOffset !== prev.typewriterOffset || u.geometryChanged) this.syncPadding();
    if (!typewriterOn(u.view) || !u.selectionSet) return;
    const byKeyboard = u.transactions.some((tr) => tr.selection && !tr.isUserEvent("select.pointer")) && !u.transactions.some((tr) => tr.isUserEvent("select.pointer"));
    if (!byKeyboard) return;
    const view = u.view;
    const head = u.state.selection.main.head;
    view.requestMeasure({
      key: "typewriter-scroll",
      read: () => {
        const coords = view.coordsAtPos(head, -1) ?? view.coordsAtPos(head, 1);
        if (!coords) return null;
        const box = view.scrollDOM.getBoundingClientRect();
        const target = box.top + view.scrollDOM.clientHeight * offsetFraction(view);
        const lineMid = (coords.top + coords.bottom) / 2;
        return lineMid - target;
      },
      write: (delta) => {
        if (delta === null || Math.abs(delta) < 2) return;
        view.scrollDOM.scrollTop += delta;
      },
    });
  }

  destroy() {
    const sizer = this.sizer();
    if (sizer && this.padded) sizer.style.paddingBottom = "";
  }
}

export function typewriterScrolling(): Extension {
  return ViewPlugin.fromClass(TypewriterPlugin);
}
