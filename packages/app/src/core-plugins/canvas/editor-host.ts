/**
 * The Markdown editor host for editing canvas cards in place: the app's own
 * `createEditorHost` (the one MarkdownView uses), over a small info object
 * that plays the view's part (file, editor, component, change callback).
 */
import type { EditorHost } from "../../editor/host";
import { Component } from "../../obsidian/events";
import { createEditorHost } from "../../obsidian/markdown/editor-host";
import type { TFile } from "../../obsidian/vault/files";

export class CanvasEditorInfo extends Component {
  editor: any = null;
  constructor(
    public app: any,
    private getFile: () => TFile | null,
    private onChange: (text: string) => void,
  ) {
    super();
  }
  get file(): TFile | null {
    return this.getFile();
  }
  // internal (called by the editor host)
  onEditorDocChanged(text: string) {
    this.onChange(text);
  }
  onEditorSelectionChanged() {}
}

export function createCanvasEditorHost(info: CanvasEditorInfo): EditorHost {
  return createEditorHost(info.app, info);
}
