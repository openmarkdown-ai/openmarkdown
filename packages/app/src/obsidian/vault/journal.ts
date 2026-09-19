/**
 * The unsaved-edit journal: a write-ahead copy of every dirty buffer, in
 * IndexedDB (`journal` store, strict durability), so text typed just before a
 * crash, a reload, a discarded tab or a failed save survives.
 *
 * One entry per tab and path, keyed `${vaultId}:${tabId}:${path}`. It is put
 * 250 ms after an edit (immediately on page hide) and deleted once a write of
 * exactly that text is confirmed, or once the buffer and the disk agree again
 * (a resolved conflict, a restored or discarded file). On startup, entries left
 * by tabs that are no longer running are compared with the file on disk: put
 * back silently when the disk is still the text they were based on, otherwise
 * offered for restore (safety.ts). An entry the user put off ("Later") is marked
 * `dismissed` and shown as a banner on its note instead of a prompt.
 */
import { idb } from "./idb";

export interface JournalEntry {
  vaultId: string;
  tabId: string;
  path: string;
  /** The buffer (`\n` line endings). */
  text: string;
  /** The text the buffer was based on, for a three-way merge on restore. */
  base: string | null;
  baseMtime: number;
  ts: number;
  /** The user chose "Later" in the recovery prompt: offer it on the note, not at startup. */
  dismissed?: boolean;
}

const DELAY = 250;

export class Journal {
  private timers = new Map<string, { timer: ReturnType<typeof setTimeout>; get: () => JournalEntry | null }>();
  /** Last text put per path, so an unchanged buffer is not rewritten. */
  private written = new Map<string, string>();

  constructor(
    readonly vaultId: string,
    readonly tabId: string,
    /** False for in-memory vaults (the demo), which start fresh on every load. */
    readonly enabled = true,
  ) {
    // Open the database now, so a put from a page-hide handler can start its transaction synchronously.
    if (enabled) void idb.warm();
  }

  private key(path: string, tabId = this.tabId): string {
    return `${this.vaultId}:${tabId}:${path}`;
  }

  /** Put the entry `get()` returns, 250 ms from now (coalesced per path). */
  schedule(path: string, get: () => JournalEntry | null) {
    if (!this.enabled) return;
    const pending = this.timers.get(path);
    if (pending) {
      pending.get = get;
      return;
    }
    const timer = setTimeout(() => {
      const p = this.timers.get(path);
      this.timers.delete(path);
      const entry = p?.get();
      if (entry) void this.put(entry);
    }, DELAY);
    this.timers.set(path, { timer, get });
  }

  /** Put any scheduled entries now (page hide). The IndexedDB request starts synchronously. */
  flush() {
    for (const [path, p] of Array.from(this.timers)) {
      clearTimeout(p.timer);
      this.timers.delete(path);
      const entry = p.get();
      if (entry) void this.put(entry, true);
    }
  }

  /**
   * `force` writes even when the same text was put before: on page hide an earlier put of that text
   * may still be waiting for its transaction, which an unloading page never starts.
   */
  async put(entry: JournalEntry, force = false): Promise<void> {
    if (!this.enabled) return;
    if (!force && this.written.get(entry.path) === entry.text) return;
    this.written.set(entry.path, entry.text);
    try {
      // Started synchronously when the connection is open: flushAll() runs in page-hide handlers.
      await idb.setNow("journal", this.key(entry.path), entry);
    } catch (e) {
      this.written.delete(entry.path);
      console.error("Unsaved-edit journal: could not write", e);
    }
  }

  /** A write of `text` to `path` is confirmed: drop the entry if it holds that text. */
  async confirm(path: string, text: string): Promise<void> {
    if (!this.enabled) return;
    const pending = this.timers.get(path);
    if (pending && pending.get()?.text === text) {
      clearTimeout(pending.timer);
      this.timers.delete(path);
    }
    if (this.written.has(path) && this.written.get(path) !== text) return;
    this.written.delete(path);
    await idb.deleteIf<JournalEntry>("journal", this.key(path), (v) => !v || v.text === text).catch(() => {});
  }

  /** Mark another tab's entry as put off by the user (kept, but no longer prompted for at startup). */
  async dismiss(entry: JournalEntry): Promise<void> {
    if (!this.enabled) return;
    await idb.setNow("journal", this.key(entry.path, entry.tabId), { ...entry, dismissed: true }).catch(() => {});
  }

  /** Move another tab's entry to a new path (its note was renamed). */
  async move(entry: JournalEntry, to: string): Promise<JournalEntry> {
    const moved = { ...entry, path: to };
    if (!this.enabled) return moved;
    await idb.delete("journal", this.key(entry.path, entry.tabId)).catch(() => {});
    await idb.set("journal", this.key(to, entry.tabId), moved).catch(() => {});
    return moved;
  }

  /** Drop this tab's entry for `path` whatever it holds (the user discarded the text, or the disk has the buffer). */
  async discard(path: string, tabId = this.tabId): Promise<void> {
    if (tabId === this.tabId) {
      const pending = this.timers.get(path);
      if (pending) clearTimeout(pending.timer);
      this.timers.delete(path);
      this.written.delete(path);
    }
    if (!this.enabled) return;
    await idb.delete("journal", this.key(path, tabId)).catch(() => {});
  }

  async rename(from: string, to: string): Promise<void> {
    if (!this.enabled) return;
    const pending = this.timers.get(from);
    if (pending) {
      this.timers.delete(from);
      clearTimeout(pending.timer);
    }
    this.written.delete(from);
    const entry = await idb.get<JournalEntry>("journal", this.key(from)).catch(() => undefined);
    if (!entry) return;
    await idb.delete("journal", this.key(from)).catch(() => {});
    await this.put({ ...entry, path: to });
  }

  /** Every entry of this vault, from every tab. */
  async list(): Promise<JournalEntry[]> {
    if (!this.enabled) return [];
    try {
      return (await idb.entries<JournalEntry>("journal", `${this.vaultId}:`)).map(([, v]) => v).filter((v) => v && typeof v.path === "string");
    } catch {
      return [];
    }
  }
}
