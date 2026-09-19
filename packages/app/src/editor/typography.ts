/**
 * Smart typography (setting `smartTypography`, off by default) and small
 * auto-pair refinements (always on with "Auto-pair Markdown syntax").
 *
 * While typing, as the Smart Typography plugin does:
 *   "   → “ or ” (opening after whitespace/start/opening bracket, else closing)
 *   '   → ‘ or ’ (an apostrophe inside a word is ’)
 *   --  → –   (en dash);  –-  → —  (em dash)
 *   ... → …
 * Never inside code (inline, fenced, indented), math, frontmatter, HTML,
 * comments, links/URLs, or on a line made only of dashes (`---` rules and
 * frontmatter fences). Backspace straight after a replacement puts the typed
 * characters back.
 *
 * The Smart Typography community plugin (`obsidian-smart-typography`) wins
 * when it is enabled.
 *
 * Auto-pair: Backspace between an empty pair of backticks or dollars deletes
 * both.
 */
import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { configFacet, hostFacet } from "./facets";
import { ofmTree } from "./syntax/language";
import { OFM } from "./syntax/ofm";

export const SMART_TYPOGRAPHY_PLUGIN = "obsidian-smart-typography";

const SKIP = new Set<string>([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "CodeText",
  "HTMLBlock",
  "HTMLTag",
  "Comment",
  "CommentBlock",
  "URL",
  "Autolink",
  "LinkMark",
  OFM.InlineMath,
  OFM.MathBlock,
  OFM.Frontmatter,
  OFM.ObsidianComment,
  OFM.ObsidianCommentBlock,
  OFM.Wikilink,
  OFM.Embed,
  OFM.Tag,
]);

function inSkippedSyntax(state: EditorState, pos: number): boolean {
  const tree = ofmTree(state);
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (SKIP.has(n.name)) {
        // The boundary of a node does not count as inside it (text right after `code`).
        if (n.to === pos && side === -1 && n.name !== "FencedCode" && n.name !== OFM.Frontmatter && n.name !== OFM.MathBlock && n.name !== "CodeBlock") continue;
        if (n.from === pos && side === 1) continue;
        return true;
      }
    }
  }
  // An unclosed inline code span on this line (the parser only sees closed ones).
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(line.from, pos);
  if (((before.match(/`/g)?.length ?? 0) % 2) === 1) return true;
  // A bare URL being typed.
  if (/[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(before)) return true;
  return false;
}

/** The last replacement, so Backspace can undo it: position after the inserted char and the original text. */
interface Replacement {
  at: number;
  inserted: string;
  original: string;
}
const setReplacement = StateEffect.define<Replacement | null>();
const replacementField = StateField.define<Replacement | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setReplacement)) return e.value;
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
});

const OPENING_CONTEXT = /[\s([{<“‘—–\-/]|^$/u;

function smartReplacement(state: EditorState, pos: number, text: string): { from: number; insert: string; original: string } | null {
  const line = state.doc.lineAt(pos);
  const before = state.sliceDoc(line.from, pos);
  const prev = before.slice(-1);
  if (text === '"') return { from: pos, insert: OPENING_CONTEXT.test(prev) ? "“" : "”", original: '"' };
  if (text === "'") {
    // Apostrophe inside a word or after a closing quote/number: right single quote.
    if (/[\p{L}\p{N}.,!?;:)\]”’]/u.test(prev)) return { from: pos, insert: "’", original: "'" };
    return { from: pos, insert: OPENING_CONTEXT.test(prev) ? "‘" : "’", original: "'" };
  }
  if (text === "-") {
    // A line of dashes is a rule or a frontmatter fence.
    if (/^[ \t]*-*$/.test(before)) return null;
    if (prev === "-") return { from: pos - 1, insert: "–", original: "--" };
    if (prev === "–") return { from: pos - 1, insert: "—", original: "–-" };
    return null;
  }
  if (text === ".") {
    if (before.endsWith("..")) return { from: pos - 2, insert: "…", original: "..." };
    return null;
  }
  return null;
}

const typographyInput = EditorView.inputHandler.of((view, from, to, text) => {
  const state = view.state;
  if (!state.facet(configFacet).smartTypography) return false;
  if (text.length !== 1 || !`"'-.`.includes(text) || view.composing) return false;
  if (state.selection.ranges.length !== 1) return false;
  const host = state.facet(hostFacet);
  if (host?.isPluginEnabled?.(SMART_TYPOGRAPHY_PLUGIN)) return false;
  // Straight quotes around a selection are left to auto-pair.
  if (from !== to) return false;
  if (inSkippedSyntax(state, from)) return false;
  const r = smartReplacement(state, from, text);
  if (!r) return false;
  const end = r.from + r.insert.length;
  view.dispatch({
    changes: { from: r.from, to, insert: r.insert },
    selection: EditorSelection.cursor(end),
    effects: setReplacement.of({ at: end, inserted: r.insert, original: r.original }),
    userEvent: "input.type",
  });
  return true;
});

function undoReplacement(view: EditorView): boolean {
  const state = view.state;
  const rep = state.field(replacementField, false);
  const sel = state.selection;
  if (!rep || sel.ranges.length !== 1 || !sel.main.empty || sel.main.head !== rep.at) return false;
  const from = rep.at - rep.inserted.length;
  if (state.sliceDoc(from, rep.at) !== rep.inserted) return false;
  view.dispatch({ changes: { from, to: rep.at, insert: rep.original }, selection: EditorSelection.cursor(from + rep.original.length), effects: setReplacement.of(null), userEvent: "delete.backward" });
  return true;
}

/** Backspace inside an empty `` ` ` `` or `$$` pair removes both characters. */
function deleteEmptyPair(view: EditorView): boolean {
  const state = view.state;
  if (!state.facet(configFacet).autoPairMarkdown) return false;
  const tr = state.changeByRange((range) => {
    if (!range.empty) return { range };
    const pos = range.head;
    const pair = state.sliceDoc(pos - 1, pos + 1);
    const line = state.doc.lineAt(pos);
    // Not the middle of a fence being typed ("``|`").
    if ((pair === "``" || pair === "$$") && state.sliceDoc(Math.max(line.from, pos - 2), pos - 1) !== pair[0] && state.sliceDoc(pos + 1, pos + 2) !== pair[0]) {
      return { changes: { from: pos - 1, to: pos + 1 }, range: EditorSelection.cursor(pos - 1) };
    }
    return { range };
  });
  if (tr.changes.empty) return false;
  view.dispatch(state.update(tr, { userEvent: "delete.backward", scrollIntoView: true }));
  return true;
}

export function smartTypography(): Extension {
  return [replacementField, Prec.high(typographyInput), Prec.highest(keymap.of([{ key: "Backspace", run: (v) => undoReplacement(v) || deleteEmptyPair(v) }]))];
}
