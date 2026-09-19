/**
 * Per-note cursor, selection and scroll memory ("Remember cursor position").
 *
 * The ephemeral state of the active note (`MarkdownView.getEphemeralState()`,
 * Obsidian's `{ cursor: { from, to }, scroll }`) is recorded, throttled, for
 * the last 500 notes in localStorage (`<appId>-vault-cursor-memory`), follows
 * renames and deletes, and is put back when a note is opened without an
 * explicit position — clicking it in the explorer after its tab was closed,
 * the quick switcher, a plain `[[link]]`. Opening at a heading, block, search
 * match or restored layout position wins (the view marks those as explicit).
 *
 * Steps aside while the "Remember cursor position" community plugin is on.
 */
import type { Plugin } from "../../obsidian/plugin";
import type { TAbstractFile, TFile } from "../../obsidian/vault/files";

const KEY = "vault-cursor-memory";
const LIMIT = 500;
const COMMUNITY_ID = "remember-cursor-position";

interface Entry {
  cursor?: unknown;
  selections?: unknown;
  scroll?: number;
  /** Last touched (ms), for the LRU limit. */
  t: number;
}

interface NoteView {
  leaf: any;
  file: TFile | null;
  editor?: { getCursor(side?: string): { line: number; ch: number }; somethingSelected(): boolean; cm?: { scrollDOM: HTMLElement } };
  getViewType(): string;
  getMode?(): string;
  getEphemeralState(): Record<string, unknown>;
  setEphemeralState(state: unknown): void;
  currentMode?: { getScroll(): number };
  explicitEStateAt?: number;
}

export class CursorMemory {
  private entries: Record<string, Entry> = {};
  private saveTimer = 0;
  private recordTimer = 0;
  /** The path each view last recorded or restored, so switching tabs does not re-restore. */
  private handled = new WeakMap<object, string>();

  constructor(private plugin: Plugin) {}

  private get app(): any {
    return this.plugin.app;
  }

  private get disabled(): boolean {
    const p = this.app.plugins;
    return !!(p?.enabledPlugins?.has?.(COMMUNITY_ID) && p?.plugins?.[COMMUNITY_ID]);
  }

  load() {
    const data = this.app.loadLocalStorage(KEY);
    this.entries = data && typeof data === "object" ? data : {};
    const { workspace, vault } = this.app;
    const p = this.plugin;
    p.registerEvent(workspace.on("file-open", (file: TFile | null) => this.onFileOpen(file)));
    p.registerEvent(workspace.on("editor-change", () => this.scheduleRecord()));
    p.registerEvent(
      vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        const e = this.entries[oldPath];
        if (!e) return;
        delete this.entries[oldPath];
        this.entries[file.path] = e;
        this.scheduleSave();
      }),
    );
    p.registerEvent(
      vault.on("delete", (file: TAbstractFile) => {
        if (!this.entries[file.path]) return;
        delete this.entries[file.path];
        this.scheduleSave();
      }),
    );
    p.registerDomEvent(document, "selectionchange", () => this.scheduleRecord());
    // Scroll does not bubble; listen in the capture phase for every scroller.
    p.registerDomEvent(document, "scroll", () => this.scheduleRecord(), { capture: true, passive: true } as AddEventListenerOptions);
    p.register(() => {
      this.recordNow();
      this.flush();
    });
    p.registerDomEvent(window, "pagehide", () => {
      this.recordNow();
      this.flush();
    });
  }

  private activeNote(): NoteView | null {
    const view = this.app.workspace.activeLeaf?.view as NoteView | undefined;
    return view?.getViewType?.() === "markdown" && view.file ? view : null;
  }

  private scheduleRecord() {
    if (this.recordTimer) return;
    this.recordTimer = window.setTimeout(() => {
      this.recordTimer = 0;
      this.recordNow();
    }, 250);
  }

  private recordNow() {
    if (this.disabled) return;
    const view = this.activeNote();
    if (!view?.file) return;
    // Until a freshly opened note has been restored, its (0, 0) state must not overwrite the memory.
    if (this.handled.get(view) !== view.file.path) return;
    let state: Record<string, unknown>;
    try {
      state = view.getEphemeralState();
    } catch {
      return;
    }
    const entry: Entry = { cursor: state.cursor, selections: state.selections, scroll: typeof state.scroll === "number" ? state.scroll : 0, t: Date.now() };
    const prev = this.entries[view.file.path];
    if (prev && JSON.stringify({ ...prev, t: 0 }) === JSON.stringify({ ...entry, t: 0 })) return;
    this.entries[view.file.path] = entry;
    this.scheduleSave();
  }

  private scheduleSave() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 1000);
  }

  private flush() {
    window.clearTimeout(this.saveTimer);
    const paths = Object.keys(this.entries);
    if (paths.length > LIMIT) {
      paths.sort((a, b) => this.entries[b]!.t - this.entries[a]!.t);
      for (const p of paths.slice(LIMIT)) delete this.entries[p];
    }
    this.app.saveLocalStorage(KEY, this.entries);
  }

  private onFileOpen(file: TFile | null) {
    const view = this.activeNote();
    if (!file || !view || view.file !== file) return;
    if (this.handled.get(view) === file.path) return;
    this.handled.set(view, file.path);
    if (this.disabled) return;
    // Opened at a heading, block, search match, or a restored layout position.
    if (view.explicitEStateAt && Date.now() - view.explicitEStateAt < 1500) return;
    const entry = this.entries[file.path];
    if (!entry) return;
    // Only a freshly loaded note (cursor at the top, not scrolled) is moved.
    const editor = view.editor;
    const atTop = !editor || (editor.getCursor("head").line === 0 && editor.getCursor("head").ch === 0 && !editor.somethingSelected());
    const scroll = view.currentMode?.getScroll() ?? 0;
    if (!atTop || scroll > 1) return;
    entry.t = Date.now();
    view.setEphemeralState({ cursor: entry.cursor, selections: entry.selections, scroll: entry.scroll, focus: true });
    this.scheduleSave();
  }

  // internal (tests): what is remembered for a path
  get(path: string): Entry | undefined {
    return this.entries[path];
  }
}
