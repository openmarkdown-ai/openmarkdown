/**
 * Which selection Live Preview uses to decide what markup to reveal.
 *
 * It follows the real selection, except while a mouse drag is in progress:
 * revealing markup under a moving pointer would shift the text being
 * selected. Pointer selections are held back until the button is released
 * (`mouseReleased`, dispatched by `livePreviewState`).
 */
import { EditorSelection, StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { mouseReleased } from "../fields";

export const revealSelectionField = StateField.define<EditorSelection>({
  create: (state) => state.selection,
  update(value, tr) {
    if (tr.effects.some((e) => e.is(mouseReleased))) return tr.state.selection;
    if (tr.isUserEvent("select.pointer")) return tr.docChanged ? value.map(tr.changes) : value;
    if (tr.selection || tr.docChanged) return tr.state.selection;
    return value;
  },
});

export function revealSelection(state: EditorState): EditorSelection {
  return state.field(revealSelectionField, false) ?? state.selection;
}

/** True when any selection range touches [from, to] (inclusive at both ends). */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const r of revealSelection(state).ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

/** True when any selection range touches a line in [from, to]. */
export function selectionOnLines(state: EditorState, from: number, to: number): boolean {
  const doc = state.doc;
  return selectionTouches(state, doc.lineAt(from).from, doc.lineAt(to).to);
}
