/**
 * Snapshot storage for File recovery: IndexedDB store "snapshots", one entry
 * per snapshot, keyed `${appId}:${path}:${ts}` with `ts` zero-padded so keys
 * sort by time. Snapshots live with the browser profile, not in the vault, as
 * Obsidian keeps them in app data rather than the vault folder.
 */
import { idb } from "../../obsidian/vault/idb";

export interface Snapshot {
  path: string;
  ts: number;
  data: string;
}

export function snapshotKey(appId: string, path: string, ts: number): string {
  return `${appId}:${path}:${String(Math.floor(ts)).padStart(15, "0")}`;
}

export class SnapshotStore {
  /** path → snapshot timestamps, ascending */
  index = new Map<string, number[]>();
  private loaded: Promise<void> | null = null;

  constructor(private appId: string) {}

  private prefix(): string {
    return `${this.appId}:`;
  }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      const entries = await idb.entries<Snapshot>("snapshots", this.prefix());
      this.index.clear();
      for (const [, snap] of entries) {
        if (!snap || typeof snap.path !== "string") continue;
        const list = this.index.get(snap.path) ?? [];
        list.push(snap.ts);
        this.index.set(snap.path, list);
      }
      for (const list of this.index.values()) list.sort((a, b) => a - b);
    })();
    return this.loaded;
  }

  latestTs(path: string): number | null {
    const list = this.index.get(path);
    return list && list.length ? list[list.length - 1]! : null;
  }

  async get(path: string, ts: number): Promise<Snapshot | null> {
    return (await idb.get<Snapshot>("snapshots", snapshotKey(this.appId, path, ts))) ?? null;
  }

  async latest(path: string): Promise<Snapshot | null> {
    const ts = this.latestTs(path);
    return ts === null ? null : this.get(path, ts);
  }

  async add(path: string, data: string, ts = Date.now()): Promise<Snapshot> {
    const list = this.index.get(path) ?? [];
    while (list.includes(ts)) ts++;
    // Reserve the timestamp before the write: data safety takes two snapshots of one note
    // (disk and editor) back to back, and a second add that started during this write's
    // await used to pick the same millisecond and overwrite the first under the same key.
    list.push(ts);
    list.sort((a, b) => a - b);
    this.index.set(path, list);
    const snap: Snapshot = { path, ts, data };
    try {
      await idb.set("snapshots", snapshotKey(this.appId, path, ts), snap);
    } catch (e) {
      const i = list.indexOf(ts);
      if (i >= 0) list.splice(i, 1);
      throw e;
    }
    return snap;
  }

  /** Snapshots of `path`, newest first. */
  async list(path: string): Promise<Snapshot[]> {
    const list = this.index.get(path) ?? [];
    const out: Snapshot[] = [];
    for (const ts of list.slice().reverse()) {
      const s = await this.get(path, ts);
      if (s) out.push(s);
    }
    return out;
  }

  /** Paths with snapshots, most recently snapshotted first. */
  paths(): { path: string; latest: number; count: number }[] {
    return Array.from(this.index.entries())
      .filter(([, list]) => list.length > 0)
      .map(([path, list]) => ({ path, latest: list[list.length - 1]!, count: list.length }))
      .sort((a, b) => b.latest - a.latest);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const list = this.index.get(oldPath);
    if (!list || !list.length) return;
    this.index.delete(oldPath);
    const target = this.index.get(newPath) ?? [];
    for (const ts of list) {
      const snap = await this.get(oldPath, ts);
      await idb.delete("snapshots", snapshotKey(this.appId, oldPath, ts));
      if (!snap) continue;
      let t = ts;
      while (target.includes(t)) t++;
      await idb.set("snapshots", snapshotKey(this.appId, newPath, t), { ...snap, path: newPath, ts: t });
      target.push(t);
    }
    target.sort((a, b) => a - b);
    this.index.set(newPath, target);
  }

  async prune(keepDays: number, now = Date.now()): Promise<number> {
    const cutoff = now - Math.max(0, keepDays) * 86_400_000;
    let removed = 0;
    for (const [path, list] of Array.from(this.index.entries())) {
      const keep: number[] = [];
      for (const ts of list) {
        if (ts < cutoff) {
          await idb.delete("snapshots", snapshotKey(this.appId, path, ts));
          removed++;
        } else keep.push(ts);
      }
      if (keep.length) this.index.set(path, keep);
      else this.index.delete(path);
    }
    return removed;
  }

  async clear(): Promise<void> {
    await idb.deletePrefix("snapshots", this.prefix());
    this.index.clear();
  }
}
