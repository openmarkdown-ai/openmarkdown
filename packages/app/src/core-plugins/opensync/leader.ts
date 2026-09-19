/**
 * One syncing tab per vault.
 *
 * Every tab of a vault loads every plugin, so without this each tab runs its
 * own loop over the same files: duplicated uploads, two same-second pointer
 * events racing, and state saved last-writer-wins. The tab holding the Web
 * Lock `opensync:<vaultId>` syncs; the others say "Syncing in another tab",
 * forward their edits over a BroadcastChannel, and reload files the leader
 * wrote. Closing the leader releases the lock and the next tab in the queue
 * takes over — the browser does the election.
 */

export type LeaderMessage =
  | { t: "hello" }
  | { t: "dirty"; path: string }
  | { t: "applied"; paths: string[] }
  | { t: "status"; status: unknown }
  | { t: "sync-now" };

export class Leadership {
  private release: (() => void) | null = null;
  private readonly abort = new AbortController();
  private readonly channel: BroadcastChannel | null;
  isLeader = false;

  constructor(
    readonly vaultId: string,
    private readonly hooks: { onLeader(): void; onFollower(): void; onMessage(m: LeaderMessage): void },
  ) {
    this.channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(`opensync:${vaultId}`) : null;
    if (this.channel) this.channel.onmessage = (ev) => hooks.onMessage(ev.data as LeaderMessage);
  }

  start(): void {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks?.request) {
      // No Web Locks (very old browsers): every tab leads, as before.
      this.isLeader = true;
      this.hooks.onLeader();
      return;
    }
    const waiting = window.setTimeout(() => {
      if (!this.isLeader) this.hooks.onFollower();
    }, 400);
    locks
      .request(`opensync:${this.vaultId}`, { mode: "exclusive", signal: this.abort.signal }, () => {
        window.clearTimeout(waiting);
        this.isLeader = true;
        this.hooks.onLeader();
        return new Promise<void>((resolve) => (this.release = resolve));
      })
      .catch(() => {
        /* aborted on stop */
      });
    this.post({ t: "hello" });
  }

  post(message: LeaderMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      /* a closed channel */
    }
  }

  stop(): void {
    this.abort.abort();
    this.release?.();
    this.release = null;
    this.isLeader = false;
    this.channel?.close();
  }
}
