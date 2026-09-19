/**
 * The internal editor classes plugins build their own inline editors from.
 *
 * Kanban (and several other plugins) obtain Obsidian's internal Markdown
 * editor class through the Markdown embed: they create an embed with
 * `app.embedRegistry.embedByExtension.md({app, containerEl}, null, "")`, call
 * `showEditor()`, and take `Object.getPrototypeOf(Object.getPrototypeOf(embed.editMode)).constructor`.
 * They then subclass it, overriding `buildLocalExtensions()` and `onUpdate()`,
 * and construct it as `new Editor(app, containerEl, owner)`. This module
 * provides that shape: a two-level class chain whose base takes
 * `(app, containerEl, owner)` and exposes `cm`, `editor`, `set`, `get`.
 */
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { createMarkdownEditor, type MarkdownEditorHandle } from "../../editor/create";
import { smartEnter } from "../../editor/lists";
import { Component } from "../events";
import type { TFile } from "../vault/files";
import { createEditorHost } from "./editor-host";
import { MarkdownPreviewRenderer, installInteractions } from "./renderer";

export class ScrollableMarkdownEditor extends Component {
  app: any;
  containerEl: HTMLElement;
  owner: any;
  handle: MarkdownEditorHandle;
  editorEl: HTMLElement;
  private localCompartment = new Compartment();
  private localConfigured = false;

  constructor(app: any, containerEl: HTMLElement, owner: any) {
    super();
    this.app = app;
    this.containerEl = containerEl;
    this.owner = owner;
    const hostOwner = {
      get file() {
        return owner?.file ?? null;
      },
      get editor() {
        return self.handle?.editor;
      },
      onEditorDocChanged: () => {},
      containerEl,
    };
    const self = this;
    const host = createEditorHost(app, hostOwner);
    host.getInfo = () => owner ?? hostOwner;
    const updateListener = EditorView.updateListener.of((update) => this.onUpdate(update, update.docChanged));
    // Subclass overrides of buildLocalExtensions() often read fields their own
    // constructor assigns after `super()` (TaskNotes: `this.options.placeholder`),
    // so they cannot always be built here. Build eagerly when possible (Kanban
    // relies on its state field existing straight away); otherwise install them
    // on the first `set()` or, failing that, once construction has finished.
    let local: Extension[] | null = null;
    try {
      local = this.buildLocalExtensions();
    } catch {
      queueMicrotask(() => {
        if (!this.localConfigured && this.handle) this.set(this.get(), true);
      });
    }
    this.localConfigured = local !== null;
    this.handle = createMarkdownEditor(containerEl, host, "", { keymap: false, extensions: [updateListener, this.localCompartment.of(local ?? [])] });
    this.editorEl = this.handle.containerEl;
    this.editorEl.addClass("vault-embedded-editor");
    const editor = this.handle.editor as unknown as Record<string, unknown>;
    // internal (used by plugins: Kanban's Enter handler)
    editor.newlineAndIndentContinueMarkdownList ??= () => smartEnter(this.handle.view);
  }

  get cm(): EditorView {
    return this.handle.view;
  }

  get editor() {
    return this.handle.editor;
  }

  /** Extensions for this editor only; subclasses append to the array. */
  buildLocalExtensions(): Extension[] {
    return [];
  }

  onUpdate(_update: ViewUpdate, changed: boolean): void {
    if (changed) this.owner?.onMarkdownChange?.(this.get());
  }

  updateBottomPadding(): void {}

  set(text: string, clear = true): void {
    this.handle.setText(text, clear);
    // A cleared set starts a fresh state; the local extensions are rebuilt
    // for it, so fields assigned since construction are seen.
    if (clear || !this.localConfigured) {
      this.localConfigured = true;
      this.handle.view.dispatch({ effects: this.localCompartment.reconfigure(this.buildLocalExtensions()) });
    }
  }

  get(): string {
    return this.handle.view.state.doc.toString();
  }

  focus() {
    this.handle.view.focus();
  }

  override onunload(): void {
    this.handle.destroy();
  }

  destroy() {
    this.unload();
  }
}

/** The subclass `editMode` is an instance of. */
export class MarkdownEmbedEditView extends ScrollableMarkdownEditor {}

/** `embedByExtension.md` — a note embedded in another view, readable and optionally editable. */
export class MarkdownEmbed extends Component {
  app: any;
  containerEl: HTMLElement;
  file: TFile | null;
  subpath: string;
  state: Record<string, unknown>;
  editable = false;
  editMode: MarkdownEmbedEditView | null = null;
  previewEl: HTMLElement;
  private renderer: MarkdownPreviewRenderer;

  constructor(ctx: { app: any; containerEl: HTMLElement; state?: Record<string, unknown> }, file: TFile | null, subpath: string) {
    super();
    this.app = ctx.app;
    this.containerEl = ctx.containerEl;
    this.state = ctx.state ?? {};
    this.file = file;
    this.subpath = subpath;
    this.containerEl.addClass("markdown-embed");
    this.previewEl = this.containerEl.createDiv({ cls: "markdown-embed-content markdown-preview-view markdown-rendered" });
    this.renderer = new MarkdownPreviewRenderer(this.app, this, this.previewEl);
    installInteractions(this.app, this.previewEl, file?.path ?? "", this);
  }

  async loadFile(): Promise<void> {
    if (!this.file) return;
    const text = await this.app.vault.cachedRead(this.file);
    await this.renderer.set(text, this.file.path);
  }

  showEditor(): void {
    if (this.editMode) return;
    this.previewEl.hide();
    const holder = this.containerEl.createDiv({ cls: "markdown-embed-editor" });
    this.editMode = this.addChild(new MarkdownEmbedEditView(this.app, holder, this));
  }

  showPreview(): void {
    if (!this.editMode) return;
    this.removeChild(this.editMode);
    this.editMode = null;
    this.previewEl.show();
  }
}
