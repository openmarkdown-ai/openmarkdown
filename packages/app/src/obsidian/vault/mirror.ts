/**
 * One note open in two panes of the same window stays one document: an edit in
 * either editor is applied to the other at once (as Obsidian does), so the two
 * panes can never save different texts over each other.
 *
 * A single editor extension, added to every editor through the workspace's
 * editor extensions, forwards each user change set to the other Markdown views
 * of the same file. Forwarded transactions carry `mirrorAnnotation`, so they are
 * not forwarded again and not added to the receiving editor's undo history.
 */
import { Annotation } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";

export const mirrorAnnotation = Annotation.define<boolean>();

interface MirrorTarget {
  file: unknown;
  handle?: { view: EditorView };
  settingText?: boolean;
  applyMirroredUpdate?(update: ViewUpdate): void;
}

export function mirrorExtension(app: any) {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged || update.transactions.some((tr) => tr.annotation(mirrorAnnotation))) return;
    const views: MirrorTarget[] = [];
    app.workspace?.iterateAllLeaves?.((leaf: { view?: MirrorTarget }) => {
      if (leaf.view?.handle?.view && typeof leaf.view.applyMirroredUpdate === "function") views.push(leaf.view);
    });
    const source = views.find((v) => v.handle!.view === update.view);
    // Text set by the app (loading, reloading or merging a file) reaches each pane on its own.
    if (!source || !source.file || source.settingText) return;
    for (const v of views) {
      if (v !== source && v.file === source.file) {
        try {
          v.applyMirroredUpdate!(update);
        } catch (e) {
          console.error("Could not mirror the edit to another pane", e);
        }
      }
    }
  });
}
