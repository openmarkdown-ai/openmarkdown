/**
 * The CM6 state fields and view plugin obsidian.d.ts exports for editor
 * extensions: `editorInfoField`, `editorEditorField`, `editorViewField`,
 * `editorLivePreviewField` and `livePreviewState`.
 *
 * The integrator re-exports these objects from the `obsidian` module; a
 * plugin's `state.field(editorInfoField)` then works because the objects are
 * identical (CM6 compares fields by identity).
 */
import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";

/** Set the value of `editorInfoField` (e.g. after the view's file changes). */
export const setEditorInfo = StateEffect.define<unknown>();
/** Set `editorEditorField` once the view exists. */
export const setEditorView = StateEffect.define<EditorView>();
/** Toggle Live Preview. */
export const setLivePreview = StateEffect.define<boolean>();

/** `MarkdownFileInfo` of this editor (the MarkdownView in the app). */
export const editorInfoField = StateField.define<any>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setEditorInfo)) value = e.value;
    return value;
  },
});

/** Deprecated alias Obsidian keeps: the same field. */
export const editorViewField = editorInfoField;

/** The `EditorView` that owns this state. */
export const editorEditorField = StateField.define<any>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setEditorView)) value = e.value;
    return value;
  },
});

/** True while Live Preview (rather than Source mode) is active. */
export const editorLivePreviewField = StateField.define<boolean>({
  create: () => true,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLivePreview)) value = e.value;
    return value;
  },
});

export interface LivePreviewStateType {
  /** True while the left mouse button is held down in the editor (drag-selecting). */
  mousedown: boolean;
}

class LivePreviewStatePlugin implements LivePreviewStateType {
  mousedown = false;
  private readonly onUp = () => {
    if (!this.mousedown) return;
    this.mousedown = false;
    // Let decorations that were frozen during the drag catch up.
    this.view.dispatch({ effects: mouseReleased.of(null) });
  };
  constructor(readonly view: EditorView) {
    (view.dom.ownerDocument.defaultView ?? window).addEventListener("mouseup", this.onUp, true);
  }
  update(_u: ViewUpdate) {}
  destroy() {
    (this.view.dom.ownerDocument.defaultView ?? window).removeEventListener("mouseup", this.onUp, true);
  }
}

/** Dispatched when a drag-selection ends (Live Preview re-evaluates what to reveal). */
export const mouseReleased = StateEffect.define<null>();

export const livePreviewState = ViewPlugin.fromClass(LivePreviewStatePlugin, {
  eventObservers: {
    mousedown(evt) {
      if (evt.button === 0) this.mousedown = true;
    },
  },
});
