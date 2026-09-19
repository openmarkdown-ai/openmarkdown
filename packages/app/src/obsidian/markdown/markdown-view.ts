/**
 * MarkdownView — a note in a tab: the CodeMirror editor (Live Preview or
 * Source) and the reading view, with the inline title and properties on top.
 *
 * DOM follows Obsidian's so themes apply:
 *
 *   .workspace-leaf-content[data-type=markdown][data-mode=source|preview]
 *     .view-header …
 *     .view-content
 *       .markdown-source-view.mod-cm6(.is-live-preview) > .cm-editor > .cm-scroller > .cm-sizer > .inline-title, .metadata-container, .cm-contentContainer
 *       .markdown-reading-view > .markdown-preview-view.markdown-rendered > .markdown-preview-sizer.markdown-preview-section > .inline-title, .metadata-container, sections…
 */
import { openSearchPanel } from "@codemirror/search";
import { Compartment, EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { openDocumentSearch } from "../../editor/search-panel";
import { getEngine } from "@vault/engine";
import type { MarkdownEditorHandle } from "../../editor/create";
import { createMarkdownEditor } from "../../editor/create";
import type { Editor } from "../../editor/editor-base";
import { setIcon } from "../ui/icons";
import type { Menu } from "../ui/menu";
import { getFrontMatterInfo } from "../util";
import type { TFile } from "../vault/files";
import type { WorkspaceLeaf } from "../workspace/leaf";
import { TextFileView } from "../workspace/view";
import { diffLineOps } from "../../core-plugins/file-recovery/diff";
import { mirrorAnnotation } from "../vault/mirror";
import { createEditorHost, getMetadataEditorRenderer } from "./editor-host";
import { MarkdownPreviewRenderer, MarkdownRenderer, installInteractions } from "./renderer";

export type MarkdownViewModeType = "source" | "preview";

export class MarkdownEditView {
  app: any;
  hoverPopover: any = null;
  constructor(private view: MarkdownView) {
    this.app = view.app;
  }
  clear() {
    this.view.handle.setText("", true);
  }
  get() {
    return this.view.handle.view.state.doc.toString();
  }
  set(data: string, clear: boolean) {
    this.view.setEditorText(data, clear);
  }
  get file(): TFile {
    return this.view.file!;
  }
  getSelection() {
    return this.view.editor.getSelection();
  }
  getScroll() {
    return this.view.editor.getScrollInfo().top;
  }
  applyScroll(scroll: number) {
    this.view.editor.scrollTo(null, scroll);
  }
  // internal (used by plugins: `view.editMode.editor`, `view.sourceMode.cmEditor`)
  get editor() {
    return this.view.editor;
  }
  get containerEl() {
    return this.view.handle.containerEl;
  }
  // internal (used by plugins: Advanced Tables handles Tab/Enter only when
  // `currentMode.sourceMode` is true, leaving Live Preview to the host) —
  // true when Live Preview rendering is off.
  get sourceMode(): boolean {
    return !this.view.handle.isLivePreview();
  }
  // internal (used by plugins: `editMode.cm`, the CM6 EditorView)
  get cm() {
    return this.view.handle.view;
  }
  // internal (used by plugins: Templater's cursor jump) — folds as 0-based line pairs
  getFoldInfo() {
    return this.view.handle.editor.getFoldInfo();
  }
  // internal
  applyFoldInfo(info: { folds?: { from: number; to: number }[]; lines?: number } | null) {
    this.view.handle.editor.applyFoldInfo(info);
  }
}

export class MarkdownPreviewView extends MarkdownRenderer {
  override containerEl: HTMLElement;
  previewEl: HTMLElement;
  sizerEl: HTMLElement;
  renderer: MarkdownPreviewRenderer;
  // internal
  inlineTitleEl: HTMLElement;
  metadataEl: HTMLElement;
  private rendered = "";

  constructor(private view: MarkdownView) {
    const containerEl = createDiv({ cls: "markdown-reading-view" });
    super(view.app, containerEl);
    this.containerEl = containerEl;
    this.previewEl = containerEl.createDiv({ cls: "markdown-preview-view markdown-rendered node-insert-event allow-fold-headings allow-fold-lists show-indentation-guide show-properties" });
    this.sizerEl = this.previewEl.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    this.inlineTitleEl = createDiv({ cls: "inline-title", attr: { tabindex: "-1" } });
    this.metadataEl = createDiv({ cls: "metadata-container" });
    // Sections live in their own element so the renderer can reorder them
    // without disturbing the title and properties above.
    const sectionsEl = createDiv({ cls: "markdown-preview-pusher" });
    this.renderer = new MarkdownPreviewRenderer(view.app, view, this.previewEl, sectionsEl);
    this.sizerEl.append(this.inlineTitleEl, this.metadataEl, sectionsEl);
    sectionsEl.style.display = "contents";
    installInteractions(view.app, this.previewEl, "", view);
  }

  get file(): TFile {
    return this.view.file!;
  }

  get(): string {
    return this.view.data;
  }

  set(data: string, _clear: boolean): void {
    if (data === this.rendered) return;
    this.rendered = data;
    this.renderHeader(data);
    void this.renderer.set(data, this.view.file?.path ?? "");
  }

  private renderHeader(data: string) {
    this.inlineTitleEl.setText(this.view.file?.basename ?? "");
    const info = getFrontMatterInfo(data);
    this.metadataEl.empty();
    const mode = this.view.app.vault.getConfig("propertiesInDocument");
    if (!info.exists || mode === "hidden" || info.frontmatter.trim() === "") {
      this.metadataEl.hide();
      return;
    }
    this.metadataEl.show();
    const renderer = getMetadataEditorRenderer();
    if (renderer) renderer(this.view.app, this.metadataEl, this.view.file, info.frontmatter, (yaml) => this.view.replaceFrontmatter(yaml), { source: "preview" });
    else this.metadataEl.createEl("pre", { text: info.frontmatter });
  }

  clear(): void {
    this.rendered = "";
    this.renderer.clear();
  }

  rerender(full?: boolean): void {
    if (full) this.renderer.clear();
    this.rendered = "";
    this.set(this.view.data, false);
  }

  getScroll(): number {
    return this.previewEl.scrollTop;
  }

  // internal (used by plugins: `currentMode.getFoldInfo()` is called on either mode)
  getFoldInfo(): { folds: { from: number; to: number }[]; lines: number } | null {
    return null;
  }

  // internal
  applyFoldInfo(_info: unknown): void {}

  applyScroll(scroll: number): void {
    this.previewEl.scrollTop = scroll;
  }

  /** Scroll so the section containing `line` is at the top. */
  // internal
  scrollToLine(line: number) {
    const s = this.renderer.sections.find((x) => x.lineStart <= line && line <= x.lineEnd) ?? this.renderer.sections.find((x) => x.lineStart >= line);
    s?.el.scrollIntoView({ block: "start" });
  }
}

export class MarkdownView extends TextFileView {
  editor: Editor;
  previewMode: MarkdownPreviewView;
  currentMode: MarkdownEditView | MarkdownPreviewView;
  hoverPopover: any = null;
  // internal (used by plugins)
  sourceMode: MarkdownEditView;
  editMode: MarkdownEditView;
  modes: { source: MarkdownEditView; preview: MarkdownPreviewView };
  inlineTitleEl: HTMLElement;
  modeButtonEl: HTMLElement;
  handle: MarkdownEditorHandle;
  private mode: MarkdownViewModeType = "source";
  // internal (data safety): true while the app, not the user, changes the text
  settingText = false;
  private mirroring = false;
  private readOnlyCompartment = new Compartment();

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "lucide-file-text";
    this.inlineTitleEl = createDiv({ cls: "inline-title", attr: { contenteditable: "true", spellcheck: "false", tabindex: "-1", autocapitalize: "on" } });
    this.handle = createMarkdownEditor(this.contentEl, createEditorHost(this.app, this), "", { keymap: false, inlineTitleEl: this.inlineTitleEl });
    this.editor = this.handle.editor as unknown as Editor;
    this.sourceMode = new MarkdownEditView(this);
    this.editMode = this.sourceMode;
    this.previewMode = new MarkdownPreviewView(this);
    this.contentEl.appendChild(this.previewMode.containerEl);
    this.modes = { source: this.sourceMode, preview: this.previewMode };
    this.currentMode = this.sourceMode;
    this.modeButtonEl = this.addAction("lucide-book-open", "Current view: editing. Click to read.", (evt) => {
      if (evt.metaKey || evt.ctrlKey) void this.app.workspace.duplicateLeaf(this.leaf, "split", "vertical").then((l: WorkspaceLeaf) => (l.view as MarkdownView).setMode(this.mode === "source" ? "preview" : "source"));
      else this.toggleMode();
    });
    this.previewMode.containerEl.hide();
    this.previewMode.previewEl.toggleClass("is-readable-line-width", !!this.app.vault.getConfig("readableLineLength"));
    this.setupInlineTitle();
  }

  getViewType(): string {
    return "markdown";
  }

  override getIcon(): string {
    return this.icon;
  }

  override onload(): void {
    super.onload();
    this.addChild(this.previewMode);
    this.register(() => this.handle.destroy());
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        if (this.mode === "preview") this.previewMode.renderer.sections.forEach((s) => this.refreshLinks(s.el));
      }),
    );
  }

  private refreshLinks(el: HTMLElement) {
    el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
      const path = (a.getAttr("data-href") ?? "").split("#")[0]!;
      a.toggleClass("is-unresolved", !!path && !this.app.metadataCache.getFirstLinkpathDest(path, this.file?.path ?? ""));
    });
  }

  private setupInlineTitle() {
    const el = this.inlineTitleEl;
    // Enter commits and then focuses the editor, which blurs the title and
    // would commit again: one rename attempt (and one error notice) per edit.
    let committing = false;
    const commit = async () => {
      const file = this.file;
      const name = el.getText().replace(/[\n\r]/g, "").trim();
      if (committing) return;
      if (!file || !name || name === file.basename) {
        el.setText(file?.basename ?? "");
        return;
      }
      committing = true;
      try {
        await renameTo(file, name);
      } finally {
        committing = false;
      }
    };
    const renameTo = async (file: TFile, name: string) => {
      if (/[\\/:]/.test(name)) {
        const { Notice } = await import("../ui/notice");
        new Notice("File names cannot contain any of these characters: \\ / :");
        el.setText(file.basename);
        return;
      }
      try {
        await this.app.fileManager.renameFile(file, file.getNewPathAfterRename(`${name}.${file.extension}`));
      } catch (e) {
        const { Notice } = await import("../ui/notice");
        new Notice(String((e as Error).message ?? e));
        el.setText(file.basename);
      }
    };
    el.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === "ArrowDown") {
        evt.preventDefault();
        void commit();
        this.editor.focus();
        this.editor.setCursor({ line: 0, ch: 0 });
      } else if (evt.key === "Escape") {
        el.setText(this.file?.basename ?? "");
        this.editor.focus();
      }
    });
    el.addEventListener("blur", () => void commit());
    el.addEventListener("paste", (evt) => {
      evt.preventDefault();
      const text = evt.clipboardData?.getData("text/plain")?.replace(/[\n\r]/g, " ") ?? "";
      document.execCommand("insertText", false, text);
    });
  }

  // ---- data ----------------------------------------------------------------

  getViewData(): string {
    return this.handle.view.state.doc.toString();
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    this.setEditorText(data, clear);
    if (this.mode === "preview") this.previewMode.set(data, clear);
    this.inlineTitleEl.setText(this.file?.basename ?? "");
  }

  // internal
  setEditorText(data: string, clear: boolean) {
    const current = this.handle.view.state.doc.toString();
    if (current === data) return;
    this.settingText = true;
    try {
      if (clear) {
        this.handle.setText(data, true);
      } else {
        // Replace only the changed lines so the cursor, selection and undo
        // history survive an outside edit or a merge anywhere in the note.
        this.handle.view.dispatch({ changes: lineChanges(current, data) });
        if (this.handle.view.state.doc.toString() !== data) {
          this.handle.view.dispatch({ changes: middleChange(this.handle.view.state.doc.toString(), data) });
        }
      }
    } finally {
      this.settingText = false;
    }
  }

  // internal (data safety): the same edit, made in another pane showing this file
  applyMirroredUpdate(update: ViewUpdate) {
    const cm = this.handle.view;
    this.mirroring = true;
    try {
      if (cm.state.doc.eq(update.startState.doc)) {
        cm.dispatch({ changes: update.changes, annotations: [mirrorAnnotation.of(true), Transaction.addToHistory.of(false)] });
      } else if (!cm.state.doc.eq(update.state.doc)) {
        const next = update.state.doc.toString();
        cm.dispatch({ changes: lineChanges(cm.state.doc.toString(), next), annotations: [mirrorAnnotation.of(true), Transaction.addToHistory.of(false)] });
      }
    } finally {
      this.mirroring = false;
    }
  }

  // internal (data safety): a file that must not be written opens read-only
  override safetySetReadOnly(readOnly: boolean): void {
    const cm = this.handle.view;
    const ext = readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
    this.inlineTitleEl.setAttr("contenteditable", readOnly ? "false" : "true");
    const present = this.readOnlyCompartment.get(cm.state) !== undefined;
    if (!present && !readOnly) return;
    cm.dispatch({ effects: present ? this.readOnlyCompartment.reconfigure(ext) : StateEffect.appendConfig.of(this.readOnlyCompartment.of(ext)) });
  }

  clear(): void {
    this.data = "";
    this.handle.setText("", true);
    this.previewMode.clear();
  }

  // internal: from the editor host
  onEditorDocChanged(text: string) {
    if (this.settingText) return;
    this.data = text;
    this.requestSave();
    if (!this.mirroring) this.app.workspace.trigger("editor-change", this.editor, this);
  }

  // internal: properties widget edits in reading view
  replaceFrontmatter(yaml: string) {
    const text = this.data;
    const info = getFrontMatterInfo(text);
    const body = info.exists ? text.slice(info.contentStart) : text;
    const next = yaml.trim() ? `---\n${yaml.replace(/\n?$/, "\n")}---\n${body}` : body;
    this.setViewData(next, false);
    this.requestSave();
  }

  override async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    this.handle.refreshInfo();
    this.inlineTitleEl.setText(file.basename);
    const folds = this.app.foldManager.load(file);
    if (folds?.folds?.length) (this.editor as unknown as { applyFoldInfo?: (f: unknown) => void }).applyFoldInfo?.(folds);
  }

  override async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    this.inlineTitleEl.setText(file.basename);
    this.handle.refreshInfo();
  }

  // ---- modes -----------------------------------------------------------------

  getMode(): MarkdownViewModeType {
    return this.mode;
  }

  // internal
  setMode(mode: MarkdownViewModeType | MarkdownEditView | MarkdownPreviewView) {
    const m: MarkdownViewModeType = mode === "preview" || mode === this.previewMode ? "preview" : "source";
    const prevScroll = this.currentMode.getScroll();
    this.mode = m;
    this.currentMode = m === "preview" ? this.previewMode : this.sourceMode;
    this.containerEl.setAttr("data-mode", m);
    this.handle.containerEl.toggle(m === "source");
    this.previewMode.containerEl.toggle(m === "preview");
    if (m === "preview") {
      this.data = this.getViewData();
      this.previewMode.set(this.data, false);
      setIcon(this.modeButtonEl, "lucide-edit-3");
      this.modeButtonEl.setAttr("aria-label", "Current view: reading. Click to edit.");
    } else {
      setIcon(this.modeButtonEl, "lucide-book-open");
      this.modeButtonEl.setAttr("aria-label", "Current view: editing. Click to read.");
    }
    this.currentMode.applyScroll(prevScroll);
    this.app.workspace.requestSaveLayout();
    this.app.workspace.trigger("layout-change");
  }

  // internal
  toggleMode() {
    this.setMode(this.mode === "source" ? "preview" : "source");
    if (this.mode === "source") this.editor.focus();
  }

  // internal
  toggleSource() {
    this.handle.setMode(!this.handle.isLivePreview());
    this.app.workspace.requestSaveLayout();
    this.app.workspace.trigger("layout-change");
  }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), mode: this.mode, source: !this.handle.isLivePreview() };
  }

  override async setState(state: any, result: { history: boolean }): Promise<void> {
    await super.setState(state, result);
    const mode = state?.mode ?? this.app.vault.getConfig("defaultViewMode") ?? "source";
    if (typeof state?.source === "boolean") this.handle.setMode(!state.source);
    if (mode !== this.mode) this.setMode(mode);
    this.containerEl.setAttr("data-mode", this.mode);
  }

  // internal (used by the writing-focus plugin's cursor memory): when an explicit position was last applied
  explicitEStateAt = 0;

  /** Obsidian's shape: `{ cursor: { from, to }, scroll }` (from = anchor, to = head); `selections` (internal) keeps extra cursors. */
  override getEphemeralState(): Record<string, unknown> {
    const out: Record<string, unknown> = { scroll: this.currentMode.getScroll() };
    const editor = this.editor as Editor & { listSelections?: () => { anchor: { line: number; ch: number }; head: { line: number; ch: number } }[] };
    if (this.file) {
      out.cursor = { from: editor.getCursor("anchor"), to: editor.getCursor("head") };
      const all = editor.listSelections?.() ?? [];
      if (all.length > 1) out.selections = all;
    }
    return out;
  }

  override setEphemeralState(state: any): void {
    if (!state) return;
    const file = this.file;
    if (typeof state.line === "number" || state.subpath || state.match || state.cursor || typeof state.scroll === "number" || state.rename) {
      this.explicitEStateAt = Date.now();
    }
    // A position can arrive before the note's text is in the editor (a layout
    // restored while the file is still being read): apply it once it is.
    if (file && !state.__deferred && (state.cursor || typeof state.scroll === "number" || typeof state.line === "number") && this.getViewData().length === 0 && (file.stat?.size ?? 0) > 0) {
      let frames = 0;
      const retry = () => {
        if (this.file !== file) return;
        if (this.getViewData().length > 0 || ++frames > 120) this.setEphemeralState({ ...state, __deferred: true });
        else requestAnimationFrame(retry);
      };
      requestAnimationFrame(retry);
      return;
    }
    let line: number | undefined = typeof state.line === "number" ? state.line : undefined;
    if (state.subpath && file) {
      const cache = this.app.metadataCache.getFileCache(file);
      try {
        const resolved = cache ? getEngine().resolveSubpath(cache, state.subpath) : null;
        if (resolved) line = resolved.start.line;
      } catch {
        /* unknown subpath: open at the top */
      }
    }
    if (state.match && this.mode === "preview" && line !== undefined) {
      this.previewMode.scrollToLine(line);
    } else if (state.match?.matches?.[0] && this.mode === "source") {
      const [from, to] = state.match.matches[0] as [number, number];
      this.editor.setSelection(this.editor.offsetToPos(from), this.editor.offsetToPos(to));
      this.editor.scrollIntoView({ from: this.editor.offsetToPos(from), to: this.editor.offsetToPos(to) }, true);
    } else if (line !== undefined) {
      if (this.mode === "source") {
        this.editor.setCursor({ line, ch: 0 });
        this.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      } else {
        this.previewMode.scrollToLine(line);
      }
    } else if (state.cursor && this.mode === "source") {
      const pos = (p: any) => (p && typeof p.line === "number" && Number.isFinite(p.line) ? { line: Math.max(0, p.line), ch: typeof p.ch === "number" && Number.isFinite(p.ch) ? Math.max(0, p.ch) : 0 } : null);
      const anchor = pos(state.cursor.from ?? state.cursor.anchor);
      const head = pos(state.cursor.to ?? state.cursor.head) ?? anchor;
      const extra = Array.isArray(state.selections) ? state.selections.map((s: any) => ({ anchor: pos(s?.anchor), head: pos(s?.head) })).filter((s: any) => s.anchor) : [];
      // Positions are clamped to the document by the editor.
      if (extra.length > 1) this.editor.setSelections(extra.map((s: any) => ({ anchor: s.anchor, head: s.head ?? s.anchor })));
      else if (anchor) this.editor.setSelection(anchor, head!);
    }
    if (typeof state.scroll === "number" && line === undefined && !state.match) {
      const scroll = state.scroll;
      this.currentMode.applyScroll(scroll);
      // Selecting scrolls the cursor into view in the next measure; the saved scroll wins.
      requestAnimationFrame(() => {
        if (this.file === file) this.currentMode.applyScroll(scroll);
      });
    }
    if (state.focus !== false && this.mode === "source" && this.app.workspace.activeLeaf === this.leaf) this.editor.focus();
    if (state.rename === "all" || state.rename === "start" || state.rename === "end") this.focusInlineTitle(state.rename);
  }

  // internal: after "New note", the title is selected for typing
  focusInlineTitle(where: "all" | "start" | "end" = "all") {
    const el = this.inlineTitleEl;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    if (where !== "all") range.collapse(where === "start");
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  // internal
  focus() {
    if (this.mode === "source") this.editor.focus();
    else this.previewMode.previewEl.focus();
  }

  showSearch(replace = false): void {
    if (this.mode !== "source") this.setMode("source");
    if (!openDocumentSearch(this.handle.view, replace)) openSearchPanel(this.handle.view);
  }

  // internal: called by Workspace.updateOptions
  updateOptions() {
    this.handle.reconfigure();
    const readable = !!this.app.vault.getConfig("readableLineLength");
    this.previewMode.previewEl.toggleClass("is-readable-line-width", readable);
    if (this.mode === "preview") this.previewMode.rerender(true);
  }

  override onResize(): void {
    this.handle.view.requestMeasure();
  }

  override onPaneMenu(menu: Menu, source: string): void {
    const cmd = (section: string, title: string, icon: string, id: string) =>
      menu.addItem((i) => i.setSection(section).setTitle(title).setIcon(icon).onClick(() => this.app.commands.executeCommandById(id)));
    menu.addItem((i) =>
      i
        .setSection("view")
        .setTitle(this.mode === "source" ? "Reading view" : "Editing view")
        .setIcon(this.mode === "source" ? "lucide-book-open" : "lucide-edit-3")
        .onClick(() => this.toggleMode()),
    );
    if (this.mode === "source") {
      menu.addItem((i) =>
        i
          .setSection("view")
          .setTitle(this.handle.isLivePreview() ? "Source mode" : "Live Preview")
          .setIcon("lucide-code-2")
          .onClick(() => this.toggleSource()),
      );
    }
    menu.addItem((i) => {
      i.setSection("pane").setTitle("Open linked view").setIcon("lucide-link");
      const sub = (i as unknown as { setSubmenu(): Menu }).setSubmenu();
      const linked = (type: string, title: string, icon: string) =>
        sub.addItem((s) =>
          s.setTitle(title).setIcon(icon).onClick(async () => {
            const leaf = this.app.workspace.getLeaf("split", "vertical");
            await leaf.setViewState({ type, state: { file: this.file?.path }, group: this.leaf } as never);
          }),
        );
      linked("backlink", "Open backlinks", "lucide-links-coming-in");
      linked("outgoing-link", "Open outgoing links", "lucide-links-going-out");
      linked("outline", "Open outline", "lucide-list");
      linked("localgraph", "Open local graph", "lucide-git-fork");
      linked("file-properties", "Open file properties", "lucide-info");
    });
    // Note actions belong to the view's "More options" menu, not the tab header's context menu.
    if (source === "more-options") {
      cmd("action", "Find…", "lucide-search", "editor:open-search");
      cmd("action", "Replace…", "lucide-replace", "editor:open-search-replace");
      cmd("action", "Add file property", "lucide-list-plus", "markdown:add-metadata-property");
      cmd("action", "Export to PDF…", "lucide-file-output", "workspace:export-pdf");
    }
    super.onPaneMenu(menu, source);
  }
}

/** Changes turning `from` into `to`, one per run of changed lines. */
function lineChanges(from: string, to: string): { from: number; to: number; insert: string }[] {
  if (from === "" || to === "") return [{ from: 0, to: from.length, insert: to }];
  const oldLines = from.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of oldLines) {
    starts.push(off);
    off += l.length + 1;
  }
  const n = oldLines.length;
  const changes: { from: number; to: number; insert: string }[] = [];
  const ops = diffLineOps(from, to);
  let a = 0;
  for (let i = 0; i < ops.length; ) {
    if (ops[i]!.type === "equal") {
      a++;
      i++;
      continue;
    }
    const startLine = a;
    const inserted: string[] = [];
    while (i < ops.length && ops[i]!.type !== "equal") {
      if (ops[i]!.type === "delete") a++;
      else inserted.push(ops[i]!.line);
      i++;
    }
    const endLine = a;
    if (endLine < n) {
      // Replace whole lines [startLine, endLine) including their newlines.
      changes.push({ from: starts[startLine]!, to: starts[endLine]!, insert: inserted.length ? inserted.join("\n") + "\n" : "" });
    } else if (startLine < n) {
      // The run reaches the end of the document.
      const f = inserted.length || startLine === 0 ? starts[startLine]! : starts[startLine]! - 1;
      changes.push({ from: f, to: from.length, insert: inserted.join("\n") });
    } else {
      changes.push({ from: from.length, to: from.length, insert: "\n" + inserted.join("\n") });
    }
  }
  return changes;
}

/** One change replacing the differing middle of two texts. */
function middleChange(current: string, data: string): { from: number; to: number; insert: string } {
  let start = 0;
  while (start < current.length && start < data.length && current[start] === data[start]) start++;
  let endA = current.length;
  let endB = data.length;
  while (endA > start && endB > start && current[endA - 1] === data[endB - 1]) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: data.slice(start, endB) };
}
