/**
 * CodeMirror decorations for the voice plugin: the interim (not yet final)
 * dictation text shown as a ghost at the cursor, and the sentence being read
 * aloud.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

class InterimWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: InterimWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "vault-voice-interim";
    el.setAttribute("aria-live", "polite");
    el.textContent = this.text;
    return el;
  }
  override ignoreEvent() {
    return true;
  }
}

export const setInterim = StateEffect.define<{ pos: number; text: string } | null>();
export const setSpeaking = StateEffect.define<{ from: number; to: number } | null>();

const interimField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setInterim)) {
        deco = e.value && e.value.text ? Decoration.set([Decoration.widget({ widget: new InterimWidget(e.value.text), side: 1 }).range(Math.min(e.value.pos, tr.state.doc.length))]) : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const speakingMark = Decoration.mark({ class: "vault-voice-speaking" });
const speakingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSpeaking)) {
        const len = tr.state.doc.length;
        deco = e.value && e.value.to > e.value.from ? Decoration.set([speakingMark.range(Math.min(e.value.from, len), Math.min(e.value.to, len))]) : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const voiceEditorExtension: Extension = [interimField, speakingField];
