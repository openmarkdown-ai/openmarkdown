/**
 * Related notes (`related-notes`): notes and passages most similar to the
 * active note, or to the paragraph under the cursor. Right sidebar.
 */
import { MarkdownView } from "../../obsidian/markdown/markdown-view";
import type { Menu } from "../../obsidian/ui/menu";
import { debounce } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ItemView } from "../../obsidian/workspace/view";
import { NavHeader, setButtonState } from "../global-search/common";
import { getAi, groupByNote, type IndexStatus, type NoteHit, type SemanticIndex } from "./engine";
import { hashString } from "./chunker";
import { renderNoteHits } from "./results-ui";

export const VIEW_TYPE_RELATED = "related-notes";

export interface RelatedHost {
  index: SemanticIndex;
  options: { relatedMode: "note" | "paragraph"; showScores: boolean; relatedLimit: number };
  saveOptions(): void;
  openAiSettings(): void;
  steppedAside(): boolean;
}

/** Engine label for results: where the embeddings were computed. */
export function engineLabel(engine: { provider: string; model: string; location: string; leavesDevice: boolean } | null): string {
  if (!engine) return "";
  if (engine.location === "device") return `On this device · ${engine.model}`;
  if (engine.location === "local-server" && !engine.leavesDevice) return `${engine.provider} on this computer · ${engine.model}`;
  return `Sent to ${engine.provider} · ${engine.model}`;
}

export function statusText(s: IndexStatus): string {
  if (s.state === "indexing" && s.total) return `Indexing notes: ${Math.min(s.done, s.total).toLocaleString()} of ${s.total.toLocaleString()}`;
  if (s.state === "indexing") return "Indexing notes…";
  if (s.state === "loading") return "Loading the index…";
  if (s.state === "paused") return `Indexing paused${s.total ? `: ${Math.min(s.done, s.total).toLocaleString()} of ${s.total.toLocaleString()}` : ""}`;
  if (s.state === "error" || s.state === "unavailable") return s.message;
  if (s.state === "ready") return `${s.notes.toLocaleString()} note${s.notes === 1 ? "" : "s"} indexed`;
  return "";
}

export class RelatedNotesView extends ItemView {
  hoverPopover: any = null;
  private header!: NavHeader;
  private modeBtn!: HTMLElement;
  private pauseBtn!: HTMLElement;
  private statusEl!: HTMLElement;
  private subjectEl!: HTMLElement;
  private listEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private editorView: MarkdownView | null = null;
  private lastKey = "";
  private run = 0;
  private requestUpdate = debounce(() => void this.update(), 250, true);
  private requestParagraph = debounce(() => void this.update(), 900, true);

  constructor(
    leaf: WorkspaceLeaf,
    private host: RelatedHost,
  ) {
    super(leaf);
    this.icon = "lucide-waypoints";
    this.navigation = false;
  }

  getViewType() {
    return VIEW_TYPE_RELATED;
  }
  getDisplayText() {
    return "Related notes";
  }
  override getIcon() {
    return "lucide-waypoints";
  }

  override async onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass("semantic-related-view");
    this.header = new NavHeader(el, false);
    this.modeBtn = this.header.addButton("lucide-file-text", "", () => {
      this.host.options.relatedMode = this.host.options.relatedMode === "note" ? "paragraph" : "note";
      this.host.saveOptions();
      this.lastKey = "";
      this.updateButtons();
      void this.update();
    });
    this.pauseBtn = this.header.addButton("lucide-pause", "Pause indexing", () => {
      const index = this.host.index;
      if (index.isPaused()) index.resume();
      else index.pause();
      this.updateButtons();
    });
    this.statusEl = el.createDiv({ cls: "semantic-status" });
    this.subjectEl = el.createDiv({ cls: "semantic-subject" });
    this.emptyEl = el.createDiv({ cls: "search-empty-state semantic-empty" });
    this.listEl = el.createDiv({ cls: "search-result-container semantic-related-list" });
    this.updateButtons();

    const ws = this.app.workspace;
    this.registerEvent(
      ws.on("active-leaf-change", () => {
        this.trackEditor();
        this.requestUpdate();
      }),
    );
    this.registerEvent(ws.on("file-open", () => this.requestUpdate()));
    this.registerEvent(
      ws.on("editor-change", () => {
        if (this.host.options.relatedMode === "paragraph") this.requestParagraph();
      }),
    );
    this.registerDomEvent(document, "selectionchange", () => {
      if (this.host.options.relatedMode === "paragraph" && this.editorView?.contentEl.contains(document.activeElement)) this.requestParagraph();
    });
    this.registerEvent(
      this.host.index.on("status", (s: IndexStatus) => {
        this.renderStatus(s);
        this.updateButtons();
      }),
    );
    this.registerEvent(
      this.host.index.on("updated", (paths: string[]) => {
        const current = this.editorView?.file?.path;
        // New neighbours may have appeared: refresh unless the user is mid-hover.
        if (!this.listEl.childElementCount || !current || paths.length) {
          this.lastKey = "";
          this.requestUpdate();
        }
      }),
    );
    const ai = getAi(this.app);
    if (ai) {
      const ref = ai.on("change", () => {
        this.lastKey = "";
        this.requestUpdate();
      });
      this.register(() => ai.offref(ref));
    }
    this.trackEditor();
    this.renderStatus(this.host.index.getStatus());
    void this.update();
  }

  override async onClose() {
    this.requestUpdate.cancel();
    this.requestParagraph.cancel();
  }

  override onPaneMenu(menu: Menu, source: string) {
    menu.addItem((i) => i.setTitle("Rebuild index").setIcon("lucide-refresh-cw").onClick(() => void this.host.index.rebuild()));
    menu.addItem((i) =>
      i
        .setTitle(this.host.options.showScores ? "Hide scores" : "Show scores")
        .setIcon("lucide-percent")
        .onClick(() => {
          this.host.options.showScores = !this.host.options.showScores;
          this.host.saveOptions();
          this.lastKey = "";
          void this.update();
        }),
    );
    super.onPaneMenu(menu, source);
  }

  private trackEditor() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) this.editorView = view;
    else if (this.editorView && !this.editorView.leaf?.parent) this.editorView = null;
  }

  private updateButtons() {
    const para = this.host.options.relatedMode === "paragraph";
    setButtonState(this.modeBtn, para, para ? "lucide-pilcrow" : "lucide-file-text", para ? "Related to: current paragraph (click for whole note)" : "Related to: whole note (click for current paragraph)");
    const s = this.host.index.getStatus();
    const paused = this.host.index.isPaused();
    setButtonState(this.pauseBtn, paused, paused ? "lucide-play" : "lucide-pause", paused ? "Resume indexing" : "Pause indexing");
    this.pauseBtn.toggle(paused || s.state === "indexing");
  }

  private renderStatus(s: IndexStatus) {
    const text = statusText(s);
    const busy = s.state === "indexing" || s.state === "paused";
    this.statusEl.empty();
    this.statusEl.toggle(busy || s.state === "error");
    this.statusEl.toggleClass("mod-error", s.state === "error");
    if (!busy && s.state !== "error") return;
    this.statusEl.createDiv({ cls: "semantic-status-text", text });
    if (busy && s.total) {
      const bar = this.statusEl.createDiv({ cls: "semantic-progress" });
      bar.createDiv({ cls: "semantic-progress-fill" }).style.width = `${Math.round((Math.min(s.done, s.total) / s.total) * 100)}%`;
    }
    if (s.state === "error") {
      const retry = this.statusEl.createEl("button", { text: "Try again" });
      retry.addEventListener("click", () => this.host.index.resume());
    }
  }

  private showEmpty(message: string, action?: { label: string; run: () => void }) {
    this.lastKey = "";
    this.subjectEl.empty();
    this.listEl.empty();
    this.emptyEl.empty();
    this.emptyEl.show();
    this.emptyEl.createDiv({ text: message });
    if (action) {
      const b = this.emptyEl.createEl("button", { cls: "mod-cta", text: action.label });
      b.addEventListener("click", action.run);
    }
  }

  /** The paragraph around the cursor (lines up to the nearest blank lines). */
  private currentParagraph(view: MarkdownView): { text: string; line: number } | null {
    const editor = view.editor;
    if (!editor) return null;
    const line = editor.getCursor().line;
    const count = editor.lineCount();
    let from = line;
    let to = line;
    while (from > 0 && editor.getLine(from - 1).trim()) from--;
    while (to < count - 1 && editor.getLine(to + 1).trim()) to++;
    const lines: string[] = [];
    for (let i = from; i <= to; i++) lines.push(editor.getLine(i));
    const text = lines.join("\n").trim();
    return text.length >= 12 ? { text, line: from } : null;
  }

  // internal (used by tests)
  async update(): Promise<void> {
    const index = this.host.index;
    if (this.host.steppedAside()) return this.showEmpty("Smart Connections is enabled. Its Connections view shows related notes.");
    const ai = getAi(this.app);
    if (!ai || !ai.isAvailable("related", "embed"))
      return this.showEmpty("Related notes use AI to compare meaning. Turn on AI and choose an engine for “Related notes” in Settings → AI.", { label: "Open AI settings", run: () => this.host.openAiSettings() });
    const status = index.getStatus();
    if (status.state === "unavailable") return this.showEmpty(status.message, { label: "Start indexing", run: () => void index.start() });
    const view = this.editorView;
    const file = view?.file ?? (this.app.workspace.getActiveFile() as TFile | null);
    if (!file || file.extension !== "md") return this.showEmpty("Open a note to see related notes.");
    if (!index.isQueryable()) return this.showEmpty(status.state === "indexing" || status.state === "loading" ? "Related notes appear once the first notes are indexed." : "No notes are indexed yet.");

    const mode = this.host.options.relatedMode;
    const para = mode === "paragraph" && view?.file === file ? this.currentParagraph(view) : null;
    const key = `${mode}:${file.path}:${file.stat.mtime}:${para ? hashString(para.text) : ""}:${index.getStatus().passages}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const run = ++this.run;

    this.subjectEl.empty();
    const subject = this.subjectEl.createDiv({ cls: "semantic-subject-inner" });
    subject.createSpan({ cls: "semantic-subject-label", text: para ? "Related to this paragraph in " : "Related to " });
    subject.createSpan({ cls: "semantic-subject-name", text: file.basename });

    let hits;
    try {
      const limit = this.host.options.relatedLimit;
      if (para) hits = await index.searchText(para.text, { kind: "document", k: limit * 4, excludePaths: [file.path] });
      else {
        hits = index.isIndexedCurrent(file) ? await index.similarToNote(file.path, limit * 4) : null;
        if (!hits) {
          const text: string = view?.file === file && view.editor ? view.editor.getValue() : await this.app.vault.cachedRead(file);
          hits = await index.searchText(text.slice(0, 3000), { kind: "document", k: limit * 4, excludePaths: [file.path] });
        }
      }
      if (run !== this.run) return;
      const notes: NoteHit[] = groupByNote(hits, limit, 2);
      if (!notes.length) return this.showEmpty("No related notes found.");
      const texts = await index.passageText(notes.flatMap((n) => n.passages.map((p) => p.key)));
      if (run !== this.run) return;
      this.emptyEl.hide();
      renderNoteHits(this.listEl, notes, {
        app: this.app,
        hoverParent: this,
        hoverSource: "semantic-related",
        sourcePath: file.path,
        texts,
        targetEditor: () => (this.editorView?.leaf?.parent ? this.editorView : this.app.workspace.getActiveViewOfType(MarkdownView)),
        showScores: this.host.options.showScores,
      });
    } catch (e) {
      if (run !== this.run) return;
      this.lastKey = "";
      this.showEmpty((e as Error)?.message ?? String(e));
    }
  }
}
