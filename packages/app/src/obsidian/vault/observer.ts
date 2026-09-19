/**
 * Outside changes to a folder vault, pushed by the browser where it can.
 *
 * Chromium desktop (133+) has `FileSystemObserver`: a recursive observation of
 * the vault's directory handle reports each file that appeared, changed,
 * disappeared or moved, and the vault reconciles just those paths. Records
 * the observer cannot describe (`unknown`, `errored`) trigger one full rescan.
 * Where there is no observer (Firefox, Safari, OPFS-only vaults) the periodic
 * and on-focus rescan remains the mechanism; `syncAllowed()` spaces those out
 * when an observer is active and leaves them to the leader tab otherwise.
 */
import type { Vault } from "./vault";

interface ObserverRecord {
  type: "appeared" | "disappeared" | "modified" | "moved" | "unknown" | "errored";
  relativePathComponents: string[];
  relativePathMovedFrom?: string[];
}

interface FileSystemObserverLike {
  observe(handle: FileSystemHandle, options?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
}

type ObserverCtor = new (cb: (records: ObserverRecord[]) => void) => FileSystemObserverLike;

export class ChangeObserver {
  active = false;
  private observer: FileSystemObserverLike | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rescan = false;

  constructor(
    private vault: Vault,
    private onExternal: (paths: string[]) => void,
  ) {}

  static supported(): boolean {
    return typeof (globalThis as { FileSystemObserver?: unknown }).FileSystemObserver === "function";
  }

  async start(root: FileSystemDirectoryHandle): Promise<boolean> {
    const Ctor = (globalThis as { FileSystemObserver?: ObserverCtor }).FileSystemObserver;
    if (!Ctor) return false;
    try {
      this.observer = new Ctor((records) => this.onRecords(records));
      await this.observer.observe(root, { recursive: true });
      this.active = true;
    } catch (e) {
      console.warn("FileSystemObserver unavailable; using periodic rescans.", e);
      this.observer = null;
      this.active = false;
    }
    return this.active;
  }

  private onRecords(records: ObserverRecord[]) {
    for (const r of records) {
      if (r.type === "unknown" || r.type === "errored") {
        this.rescan = true;
        if (r.type === "errored") this.active = false;
        continue;
      }
      this.pending.add(r.relativePathComponents.join("/").normalize("NFC"));
      if (r.relativePathMovedFrom) this.pending.add(r.relativePathMovedFrom.join("/").normalize("NFC"));
    }
    this.timer ??= setTimeout(() => void this.drain(), 100);
  }

  private async drain() {
    this.timer = null;
    const paths = Array.from(this.pending).sort((a, b) => a.length - b.length);
    this.pending.clear();
    if (this.rescan) {
      this.rescan = false;
      await this.vault.sync(true).catch((e) => console.error(e));
      return;
    }
    const changed: string[] = [];
    for (const p of paths) {
      if (!p || p.endsWith(".crswap")) continue;
      if (await this.vault.reconcilePath(p).then((c) => c, () => false)) changed.push(p);
    }
    this.onExternal(changed);
  }

  stop() {
    this.observer?.disconnect();
    this.observer = null;
    this.active = false;
  }
}
