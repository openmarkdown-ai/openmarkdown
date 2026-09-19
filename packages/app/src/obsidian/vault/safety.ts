/**
 * Data safety: the app-wide half of "nothing typed is ever lost silently".
 *
 * Views (`TextFileView` in workspace/view.ts) own their buffer, save it with a
 * check-before-write (save.ts) and merge outside changes into it. This module
 * gives them what outlives a single view:
 *
 * - **Save status**: a status bar item and a sticky Notice while any write is
 *   failing (retries continue in the view, with backoff), a conflict count, and
 *   the `beforeunload` prompt — shown only while a write is still pending.
 * - **Flush on leave**: `visibilitychange` → hidden, `pagehide` and `freeze`
 *   write every dirty view and put its journal entry at once.
 * - **Journal** (journal.ts): the write-ahead copy of each dirty buffer. On
 *   startup, entries left by tabs that are gone are put back silently when the
 *   file is still the text they were based on; otherwise they are offered for
 *   restore. "Later" keeps an entry and shows a banner on its note instead.
 * - **Orphans**: text a closing view could not write keeps retrying here; if it
 *   conflicts, it is written next to the note as a conflict copy.
 * - **Tabs** (tabs.ts): changes broadcast to other tabs on the vault, one
 *   leader tab for rescans and the FileSystemObserver (observer.ts).
 * - **Panes** (mirror.ts), the mass-delete question, storage persistence and
 *   snapshots before a delete.
 */
import { Notice } from "../ui/notice";
import { moment } from "../util";
import { TFile, TFolder, type TAbstractFile } from "./files";
import { Journal, type JournalEntry } from "./journal";
import { merge3 } from "./merge";
import { mirrorExtension } from "./mirror";
import { ChangeObserver } from "./observer";
import { checkedWrite, describeSaveError, type SaveBase } from "./save";
import { ConflictModal, RecoveryModal, type RecoveryItem } from "./safety-ui";
import { TabChannel } from "./tabs";
import { normalizeEol } from "./text-format";
import type { Vault } from "./vault";

/** The parts of a TextFileView this module reads (duck-typed to avoid an import cycle). */
export interface SafeView {
  file: TFile | null;
  dirty: boolean;
  safetySaving: boolean;
  safetySaveError: unknown;
  safetyConflict: { theirs: string } | null;
  safetyDeletedPath: string | null;
  safetyReadOnly: string | null;
  lastSavedData: string | null;
  safetyBase: SaveBase | null;
  leaf: any;
  getViewData(): string;
  save(clear?: boolean): Promise<void>;
  safetyOpenConflict?(): void;
}

interface Orphan {
  file: TFile;
  text: string;
  base: SaveBase | null;
  attempts: number;
  timer: number | null;
  error: unknown;
}

const RETRY_DELAYS = [1000, 5000, 30000];
const SNAPSHOT_EXTENSIONS = new Set(["md", "canvas"]);

export function isSafeView(v: unknown): v is SafeView {
  return !!v && typeof (v as SafeView).getViewData === "function" && typeof (v as SafeView).save === "function" && "safetyBase" in (v as object);
}

export class DataSafety {
  readonly vault: Vault;
  readonly journal: Journal;
  readonly tabs: TabChannel;
  observer: ChangeObserver | null = null;
  statusEl: HTMLElement;
  private failureNotices = new Map<string, Notice>();
  private orphans = new Map<string, Orphan>();
  private remoteQueue: Promise<void> = Promise.resolve();
  private persistRequested = false;
  private massNotice: Notice | null = null;

  constructor(readonly app: any) {
    this.vault = app.vault;
    this.vault.safety = this;
    // internal (used by the PWA update flow: pwa/sw-client.ts)
    app.saveStatus = this;
    this.tabs = new TabChannel(this.vault.adapter.vaultId, (op, paths) => this.onRemoteChange(op, paths));
    this.journal = new Journal(this.vault.adapter.vaultId, this.tabs.tabId, this.vault.adapter.kind !== "memory");
    this.statusEl = app.statusBar.createStatusBarItem();
    this.statusEl.addClass("vault-save-status");
    this.statusEl.addEventListener("click", () => this.onStatusClick());
    this.render();
    this.installLifecycle();
    this.installVaultHooks();
    const ws = app.workspace;
    // internal (used by the PWA update flow): settles once every pending write has been attempted
    if (ws) ws.flushSaves = () => this.flushSaves();
    if (ws?.editorExtensions) {
      ws.editorExtensions.push(mirrorExtension(app));
      ws.updateOptions?.();
    }
    ws?.onLayoutReady?.(() => {
      this.tabs.electLeader(() => void this.becomeLeader());
      window.setTimeout(() => void this.recover(), 300);
    });
  }

  // ---- views ---------------------------------------------------------------

  views(): SafeView[] {
    const out: SafeView[] = [];
    this.app.workspace?.iterateAllLeaves?.((leaf: { view?: unknown }) => {
      if (isSafeView(leaf.view)) out.push(leaf.view);
    });
    return out;
  }

  private viewUnsaved(v: SafeView): boolean {
    if (!v.file || v.safetyReadOnly) return false;
    if (v.dirty || v.safetySaving || v.safetySaveError || v.safetyConflict || v.safetyDeletedPath) return true;
    return v.lastSavedData !== null && normalizeEol(v.getViewData()) !== normalizeEol(v.lastSavedData);
  }

  /** A write is still pending somewhere: unsaved buffers, failing saves, conflicts, orphans. */
  hasPending(): boolean {
    return this.orphans.size > 0 || this.views().some((v) => this.viewUnsaved(v));
  }

  private localWrites = new Map<string, string>();

  /** A view in this tab is about to write `text` to `path`. */
  noteLocalWrite(path: string, text: string) {
    this.localWrites.set(path, text);
  }

  /** `text` is what a view in this tab last wrote to `path`. */
  isLocalWrite(path: string, text: string): boolean {
    return this.localWrites.get(path) === text;
  }

  /** Alias of `hasPending()` (app.saveStatus.hasUnsaved, used by the PWA update flow). */
  hasUnsaved(): boolean {
    return this.hasPending();
  }

  /** `flushAll()`, then wait until each of those writes (and any orphan retry) has settled. */
  async flushSaves(): Promise<void> {
    this.flushAll();
    await Promise.all([
      ...this.views().map((v) => v.save().catch(() => {})),
      ...Array.from(this.orphans.values()).map((o) => {
        if (o.timer) clearTimeout(o.timer);
        return this.retryOrphan(o);
      }),
    ]);
  }

  /** Write every dirty buffer now, and put its journal entry synchronously first. */
  flushAll() {
    for (const v of this.views()) {
      if (!this.viewUnsaved(v)) continue;
      const entry = this.entryFor(v);
      if (entry) void this.journal.put(entry, true);
      if (!v.safetyConflict && !v.safetyDeletedPath) void v.save().catch(() => {});
    }
    this.journal.flush();
    try {
      this.app.workspace?.requestSaveLayout?.run?.();
    } catch {
      /* layout save is best effort */
    }
  }

  private installLifecycle() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flushAll();
    });
    window.addEventListener("pagehide", () => this.flushAll());
    document.addEventListener("freeze", () => this.flushAll());
    window.addEventListener("beforeunload", (evt) => {
      if (!this.hasPending()) return;
      this.flushAll();
      evt.preventDefault();
      evt.returnValue = "";
    });
  }

  // ---- journal ---------------------------------------------------------------

  entryFor(v: SafeView): JournalEntry | null {
    const file = v.file;
    if (!file || v.safetyReadOnly) return null;
    const text = normalizeEol(v.getViewData());
    return {
      vaultId: this.journal.vaultId,
      tabId: this.tabs.tabId,
      path: file.path,
      text,
      // Very large notes keep only the buffer; restore then compares instead of merging.
      base: text.length > 2_000_000 ? null : (v.safetyBase?.text ?? (v.lastSavedData === null ? null : normalizeEol(v.lastSavedData))),
      baseMtime: v.safetyBase?.mtime ?? file.stat.mtime,
      ts: Date.now(),
    };
  }

  /** Called by a view on every edit. */
  onDirty(v: SafeView) {
    const file = v.file;
    if (!file) return;
    this.journal.schedule(file.path, () => (v.file === file && this.viewUnsaved(v) ? this.entryFor(v) : null));
  }

  /** Called by a view after `text` is confirmed on disk for `file`. */
  onSaved(v: SafeView, file: TFile, text: string) {
    // When every buffer on the note now equals the disk, whatever the journal holds for it is settled,
    // including text it never held (a conflict resolved with Keep both writes the joined text).
    const settled =
      !this.orphans.has(file.path) &&
      this.views()
        .filter((x) => x.file === file)
        .every((x) => !x.safetyConflict && !x.safetyDeletedPath && normalizeEol(x.getViewData()) === text);
    if (settled && v.file === file) void this.journal.discard(file.path);
    else void this.journal.confirm(file.path, text);
    const notice = this.failureNotices.get(file.path);
    if (notice) {
      notice.hide();
      this.failureNotices.delete(file.path);
      new Notice(`Saved “${file.basename}”.`, 2500);
    }
    this.renderView(v);
    this.render();
  }

  onSaveFailed(v: SafeView, file: TFile, error: unknown, retryMs: number) {
    const entry = this.entryFor(v);
    if (entry) void this.journal.put(entry);
    this.showFailure(file, error, retryMs);
    this.renderView(v);
    this.render();
  }

  private showFailure(file: TFile, error: unknown, retryMs: number) {
    console.error(`Could not save ${file.path}`, error);
    const msg = `Could not save “${file.basename}”: ${describeSaveError(error)} Retrying in ${Math.round(retryMs / 1000)} s — your text is kept.`;
    const existing = this.failureNotices.get(file.path);
    if (existing && !existing.isHidden) existing.setMessage(msg);
    else {
      const n = new Notice(msg, 0);
      n.containerEl.addClass("vault-save-failed-notice");
      this.failureNotices.set(file.path, n);
    }
  }

  // ---- orphans: text a closed view could not write -----------------------------

  adopt(file: TFile, text: string, base: SaveBase | null, conflictTheirs: string | null) {
    const entry: JournalEntry = { vaultId: this.journal.vaultId, tabId: this.tabs.tabId, path: file.path, text, base: base?.text ?? null, baseMtime: base?.mtime ?? 0, ts: Date.now() };
    void this.journal.put(entry);
    if (conflictTheirs !== null) {
      void this.writeConflictCopy(file, text);
      return;
    }
    const prev = this.orphans.get(file.path);
    if (prev?.timer) clearTimeout(prev.timer);
    const orphan: Orphan = { file, text, base, attempts: 0, timer: null, error: null };
    this.orphans.set(file.path, orphan);
    this.render();
    void this.retryOrphan(orphan);
  }

  private async retryOrphan(o: Orphan) {
    o.timer = null;
    if (this.orphans.get(o.file.path) !== o) return;
    // A view opened on the file again takes the text back.
    const reopened = this.views().find((v) => v.file === o.file);
    if (o.file.deleted) {
      this.orphans.delete(o.file.path);
      await this.vault.snapshot(o.file.path, o.text);
      await this.journal.discard(o.file.path);
      new Notice(`“${o.file.basename}” was deleted before its last edits were saved. They are kept in File recovery.`, 0);
      this.render();
      return;
    }
    try {
      const out = await checkedWrite(this.vault, o.file, o.text, o.base ?? { text: "", mtime: -1, size: -1 });
      if (out.kind === "conflict") {
        await this.writeConflictCopy(o.file, o.text);
      } else if (out.kind === "deleted") {
        await this.vault.snapshot(o.file.path, o.text);
        new Notice(`“${o.file.basename}” was deleted before its last edits were saved. They are kept in File recovery.`, 0);
        await this.journal.discard(o.file.path);
      } else {
        await this.journal.confirm(o.file.path, out.text);
        const notice = this.failureNotices.get(o.file.path);
        if (notice) {
          notice.hide();
          this.failureNotices.delete(o.file.path);
          new Notice(`Saved “${o.file.basename}”.`, 2500);
        }
      }
      this.orphans.delete(o.file.path);
      if (reopened) void reopened.save();
    } catch (e) {
      o.error = e;
      const delay = RETRY_DELAYS[Math.min(o.attempts, RETRY_DELAYS.length - 1)]!;
      o.attempts++;
      this.showFailure(o.file, e, delay);
      o.timer = window.setTimeout(() => void this.retryOrphan(o), delay);
    }
    this.render();
  }

  /** Keep both sides of an unresolved conflict: write the unsaved text next to the note. */
  async writeConflictCopy(file: TFile, text: string): Promise<TFile | null> {
    const stamp = moment().format("YYYY-MM-DD HHmmss");
    const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
    const path = this.vault.getAvailablePath(`${dir}${file.basename} (conflict ${stamp})`, file.extension);
    try {
      const copy = await this.vault.create(path, text);
      await this.journal.discard(file.path);
      new Notice(`“${file.basename}” changed on disk while it had unsaved edits. Your version was saved as “${copy.basename}”.`, 0);
      return copy;
    } catch (e) {
      await this.vault.snapshot(file.path, text);
      new Notice(`Could not save a conflict copy of “${file.basename}”: ${describeSaveError(e)} Your text is kept in File recovery.`, 0);
      return null;
    }
  }

  // ---- status bar -------------------------------------------------------------

  render() {
    const views = this.views();
    const failing = views.filter((v) => v.safetySaveError).length + Array.from(this.orphans.values()).filter((o) => o.error).length;
    const conflicts = views.filter((v) => v.safetyConflict).length;
    const el = this.statusEl;
    el.empty();
    el.removeClass("mod-error", "mod-warning", "mod-clickable");
    for (const v of views) v.leaf?.tabHeaderEl?.toggleClass?.("vault-save-failed", !!(v.safetySaveError || v.safetyConflict));
    if (failing) {
      el.addClass("mod-error", "mod-clickable");
      el.setText(failing === 1 ? "Not saved" : `${failing} notes not saved`);
      el.setAttr("aria-label", "Saving failed and is being retried. Click to retry now.");
    } else if (conflicts) {
      el.addClass("mod-warning", "mod-clickable");
      el.setText(conflicts === 1 ? "Conflict" : `${conflicts} conflicts`);
      el.setAttr("aria-label", "A note changed on disk while you were editing it. Click to compare.");
    } else if (this.orphans.size) {
      el.setText("Saving…");
      el.removeAttribute("aria-label");
    } else {
      el.removeAttribute("aria-label");
    }
    el.toggle(!!(failing || conflicts || this.orphans.size));
  }

  renderView(v: SafeView) {
    (v as unknown as { renderSafetyBanner?: () => void }).renderSafetyBanner?.();
  }

  private onStatusClick() {
    const views = this.views();
    const conflicted = views.find((v) => v.safetyConflict);
    if (views.some((v) => v.safetySaveError) || this.orphans.size) {
      for (const v of views) if (v.safetySaveError) void v.save();
      for (const o of this.orphans.values()) {
        if (o.timer) clearTimeout(o.timer);
        void this.retryOrphan(o);
      }
    } else if (conflicted) conflicted.safetyOpenConflict?.();
  }

  // ---- vault hooks -------------------------------------------------------------

  private installVaultHooks() {
    const vault = this.vault;
    vault.on("local-change", (op: string, paths: string[]) => this.tabs.broadcast(op, paths));
    vault.on("external-change", (paths: string[]) => this.tabs.broadcast("external", paths));
    vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      if (file instanceof TFile) void this.journal.rename(oldPath, file.path);
      const pending = this.pending.get(oldPath);
      if (pending && file instanceof TFile) {
        this.pending.delete(oldPath);
        void this.journal.move(pending, file.path).then((moved) => {
          this.pending.set(file.path, moved);
          this.renderPending(file.path);
        });
      }
      const notice = this.failureNotices.get(oldPath);
      if (notice) {
        this.failureNotices.delete(oldPath);
        this.failureNotices.set(file.path, notice);
      }
    });
    vault.on("mass-delete", (paths: string[], total: number) => this.askMassDelete(paths, total));
    vault.on("create", (file: TAbstractFile) => {
      if (file instanceof TFile && this.app.workspace?.layoutReady) void this.requestPersistence();
    });
    // In-app deletes: write any open editor's last keystrokes first, and snapshot the file.
    vault.beforeDeleteHooks.add(async (target: TAbstractFile) => {
      const inside = (f: TFile | null) => !!f && (f === target || (target instanceof TFolder && f.path.startsWith(target.path + "/")));
      for (const v of this.views()) if (inside(v.file) && !v.safetyConflict && !v.safetyDeletedPath) await v.save();
      if (target instanceof TFile && SNAPSHOT_EXTENSIONS.has(target.extension)) {
        try {
          await vault.snapshot(target.path, await vault.cachedRead(target));
        } catch {
          /* unreadable: nothing to keep */
        }
      }
    });
    vault.syncGate = () => this.syncAllowed();
  }

  private onRemoteChange(op: string, paths: string[]) {
    this.remoteQueue = this.remoteQueue.then(() => this.vault.applyRemoteChange(op, paths)).catch((e) => console.error("Could not apply a change from another tab", e));
  }

  private async becomeLeader() {
    const adapter = this.vault.adapter as { kind: string; root?: FileSystemDirectoryHandle };
    // Browser (OPFS) vaults change only through this origin's tabs, which broadcast.
    if (adapter.kind !== "folder" || !adapter.root) return;
    await this.watchDirectory(adapter.root);
  }

  /** Reconcile outside changes under `root` as FileSystemObserver reports them. Resolves false where unsupported. */
  // internal
  async watchDirectory(root: FileSystemDirectoryHandle): Promise<boolean> {
    if (!ChangeObserver.supported()) return false;
    this.observer?.stop();
    this.observer = new ChangeObserver(this.vault, (paths) => {
      if (paths.length) this.tabs.broadcast("external", paths);
    });
    return this.observer.start(root);
  }

  /** Whether an unforced rescan (focus, interval) should run in this tab. */
  syncAllowed(): boolean {
    const since = Date.now() - this.vault.lastSyncTime;
    const focused = typeof document.hasFocus === "function" && document.hasFocus();
    if (!this.tabs.leader) return focused && since > 2000;
    if (this.observer?.active) return since > (focused ? 5000 : 60000);
    return true;
  }

  private askMassDelete(paths: string[], total: number) {
    this.massNotice?.hide();
    const frag = document.createDocumentFragment();
    const wrap = frag.createDiv({ cls: "vault-mass-delete-notice" });
    wrap.createDiv({ text: `${paths.length} of ${total} files disappeared from the vault at once. Is a sync client, cloud drive or disk disconnected? Nothing was removed from the app.` });
    const buttons = wrap.createDiv({ cls: "vault-safety-notice-actions" });
    const notice = new Notice(frag, 0);
    this.massNotice = notice;
    buttons.createEl("button", { text: "Rescan" }).addEventListener("click", (evt) => {
      evt.stopPropagation();
      notice.hide();
      this.vault.dismissMassDelete();
      void this.vault.sync(true);
    });
    buttons.createEl("button", { cls: "mod-warning", text: "They were deleted" }).addEventListener("click", (evt) => {
      evt.stopPropagation();
      notice.hide();
      void this.vault.acceptMassDelete();
    });
  }

  /** Ask the browser not to evict a browser-stored vault, once its first note exists. */
  async requestPersistence() {
    if (this.persistRequested || this.vault.adapter.kind !== "browser") return;
    this.persistRequested = true;
    const storage = navigator.storage as StorageManager | undefined;
    try {
      if (!storage?.persist || (await storage.persisted?.())) return;
      await storage.persist();
    } catch {
      /* best effort: Settings shows the state */
    }
  }

  /** Called by a view when a merge brought outside changes into it. */
  notifyMerged(file: TFile) {
    new Notice(`“${file.basename}” changed outside the app. The changes were merged into your edits; the earlier versions are in File recovery.`, 4000);
  }

  // ---- startup recovery --------------------------------------------------------

  /** Entries the user put off ("Later"), by path: shown as a banner on the note. */
  private pending = new Map<string, JournalEntry>();

  async recover(): Promise<void> {
    const entries = (await this.journal.list()).filter((e) => e.tabId !== this.tabs.tabId);
    if (!entries.length) return;
    const alive = await this.tabs.alivePeers();
    const byPath = new Map<string, JournalEntry[]>();
    for (const e of entries) {
      if (alive.has(e.tabId)) continue;
      const list = byPath.get(e.path) ?? [];
      list.push(e);
      byPath.set(e.path, list);
    }
    const items: (RecoveryItem & { entry: JournalEntry })[] = [];
    for (const [path, list] of byPath) {
      list.sort((a, b) => b.ts - a.ts);
      const [newest, ...older] = list as [JournalEntry, ...JournalEntry[]];
      for (const o of older) {
        if (o.text !== newest.text) await this.vault.snapshot(path, o.text);
        await this.journal.discard(path, o.tabId);
      }
      const disk = await this.readDisk(path);
      if (disk !== null && disk === newest.text) {
        await this.journal.discard(path, newest.tabId);
        continue;
      }
      const item = { entry: newest, path, text: newest.text, ts: newest.ts, disk, diskChanged: disk !== null && newest.base !== null && disk !== newest.base };
      if (!newest.dismissed && disk !== null && newest.base !== null && disk === newest.base) {
        // The edits never reached the disk and nothing else changed it since (the tab was closed or
        // navigated away before its write finished): put them back without asking.
        try {
          await this.restoreEntry(newest, disk);
          continue;
        } catch {
          /* could not write: offer it below */
        }
      }
      if (newest.dismissed) {
        this.pending.set(path, newest);
        this.renderPending(path);
      } else items.push(item);
    }
    if (!items.length) return;
    new RecoveryModal(this.app, items, {
      restore: (item, force) => this.restoreEntry((item as (typeof items)[number]).entry, item.disk, force),
      discard: (item) => this.discardEntry((item as (typeof items)[number]).entry),
      later: async (rest) => {
        const entries = rest.map((item) => ({ ...(item as (typeof items)[number]).entry, dismissed: true }));
        for (const entry of entries) {
          this.pending.set(entry.path, entry);
          this.renderPending(entry.path);
        }
        await Promise.all(entries.map((entry) => this.journal.dismiss(entry)));
      },
    }).open();
  }

  private async readDisk(path: string): Promise<string | null> {
    if (!this.vault.getFileByPath(path)) return null;
    try {
      return normalizeEol(await this.vault.adapter.read(path));
    } catch {
      return null;
    }
  }

  // ---- put-off entries (a banner on the note) ------------------------------------

  /** The unsaved edits from an earlier session the user put off for `path`, if any. */
  pendingRecovery(path: string): { text: string; ts: number } | null {
    const e = this.pending.get(path);
    return e ? { text: e.text, ts: e.ts } : null;
  }

  private renderPending(path: string) {
    for (const v of this.views()) if (v.file?.path === path) this.renderView(v);
  }

  private settlePending(entry: JournalEntry) {
    if (this.pending.get(entry.path) === entry) this.pending.delete(entry.path);
    this.renderPending(entry.path);
  }

  async restorePending(path: string): Promise<void> {
    const entry = this.pending.get(path);
    if (!entry) return;
    try {
      await this.restoreEntry(entry, await this.readDisk(path));
      this.settlePending(entry);
    } catch {
      /* the user closed the compare dialog: keep the banner */
    }
  }

  async discardPending(path: string): Promise<void> {
    const entry = this.pending.get(path);
    if (!entry) return;
    await this.discardEntry(entry);
    this.settlePending(entry);
  }

  async comparePending(path: string): Promise<void> {
    const entry = this.pending.get(path);
    if (!entry) return;
    const disk = await this.readDisk(path);
    new ConflictModal(this.app, {
      title: `Compare “${path}”`,
      description: "Left: the file as it is now. Right: the unsaved edits from an earlier session.",
      path,
      theirs: disk ?? "",
      theirsLabel: disk === null ? "Deleted" : "On disk",
      mine: entry.text,
      mineLabel: "Unsaved edits",
      allowBoth: false,
      onChoose: async (choice) => {
        try {
          if (choice === "theirs") await this.discardEntry(entry);
          else await this.restoreEntry(entry, disk, true);
          this.settlePending(entry);
        } catch {
          /* cancelled */
        }
      },
    }).open();
  }

  private async discardEntry(entry: JournalEntry) {
    await this.vault.snapshot(entry.path, entry.text);
    await this.journal.discard(entry.path, entry.tabId);
  }

  /**
   * Put a journal entry back on disk. Unless `force` (the user chose it in a compare), text on disk
   * that is newer than the entry is never overwritten: an unchanged file takes the edits, a clean
   * merge takes both, and anything else asks with a compare.
   */
  private async restoreEntry(entry: JournalEntry, disk: string | null, force = false) {
    const vault = this.vault;
    try {
      let file = vault.getFileByPath(entry.path);
      if (!file) {
        const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
        if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
        file = await vault.create(entry.path, entry.text);
      } else {
        const current = disk ?? normalizeEol(await vault.adapter.read(entry.path));
        if (current !== entry.text) await vault.snapshot(entry.path, current);
        const text = /\.(md|txt)$/i.test(entry.path);
        const m = entry.base === null ? null : merge3(entry.base, entry.text, current);
        if (current === entry.text) {
          /* already there */
        } else if (force || current === entry.base) await vault.modify(file, entry.text);
        else if (m?.clean && text) {
          if (m.text !== current) await vault.modify(file, m.text);
        } else {
          // The file changed since and the edits cannot be merged cleanly: ask.
          const target = file;
          await new Promise<void>((resolve, reject) => {
            new ConflictModal(this.app, {
              onCancel: () => reject(new Error("cancelled")),
              title: `“${target.basename}” changed since these edits`,
              description: "The file on disk changed after these edits were made. Choose what to keep; both versions are also kept in File recovery.",
              path: entry.path,
              theirs: current,
              mine: entry.text,
              mineLabel: "Unsaved edits",
              allowBoth: text && !!m,
              onChoose: async (choice) => {
                try {
                  if (choice === "mine") await vault.modify(target, entry.text);
                  else if (choice === "both" && m) await vault.modify(target, m.bothText);
                  else await vault.snapshot(entry.path, entry.text);
                  resolve();
                } catch (e) {
                  reject(e);
                }
              },
            }).open();
          });
        }
      }
      await this.journal.discard(entry.path, entry.tabId);
      new Notice(`Restored unsaved changes to “${file.basename}”.`);
    } catch (e) {
      if ((e as Error)?.message === "cancelled") throw e;
      new Notice(`Could not restore “${entry.path}”: ${describeSaveError(e)}`, 0);
      throw new Error("cancelled");
    }
  }
}

export function installDataSafety(app: any): DataSafety {
  return new DataSafety(app);
}
