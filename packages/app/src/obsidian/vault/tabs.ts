/**
 * Several tabs (or windows) on one vault.
 *
 * - A `BroadcastChannel` per vault carries "this path changed" from the tab
 *   that wrote it (or noticed an outside change) to every other tab, which
 *   reconciles that path at once. An open editor then reloads, or merges if
 *   it has unsaved edits, through the same path an external edit takes.
 * - A Web Lock per vault elects one tab to run the periodic rescan and the
 *   FileSystemObserver; the others rely on its broadcasts. Without Web Locks
 *   every tab behaves as the leader, as before.
 * - `alivePeers()` asks the channel which tabs are running, so startup
 *   recovery never offers to restore another live tab's unsaved buffer.
 *
 * BroadcastChannel and Web Locks are in Chromium, Firefox (96+) and Safari
 * (15.4+).
 */

export type TabMessage =
  | { type: "change"; from: string; op: string; paths: string[] }
  | { type: "ping"; from: string; nonce: string }
  | { type: "pong"; from: string; nonce: string };

export function newTabId(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class TabChannel {
  readonly tabId = newTabId();
  leader = false;
  private channel: BroadcastChannel | null = null;
  private waiters = new Map<string, Set<string>>();
  private releaseLeader: (() => void) | null = null;

  constructor(
    private vaultId: string,
    private onChange: (op: string, paths: string[]) => void,
  ) {
    if (typeof BroadcastChannel === "function") {
      this.channel = new BroadcastChannel(`openmarkdown-vault:${vaultId}`);
      this.channel.onmessage = (evt) => this.onMessage(evt.data as TabMessage);
    }
  }

  private onMessage(msg: TabMessage) {
    if (!msg || msg.from === this.tabId) return;
    if (msg.type === "change") this.onChange(msg.op, msg.paths);
    else if (msg.type === "ping") this.post({ type: "pong", from: this.tabId, nonce: msg.nonce });
    else if (msg.type === "pong") this.waiters.get(msg.nonce)?.add(msg.from);
  }

  private post(msg: TabMessage) {
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* closed */
    }
  }

  broadcast(op: string, paths: string[]) {
    if (paths.length) this.post({ type: "change", from: this.tabId, op, paths });
  }

  /** Tab ids of the other running tabs on this vault. */
  async alivePeers(timeoutMs = 400): Promise<Set<string>> {
    if (!this.channel) return new Set();
    const nonce = newTabId();
    const seen = new Set<string>();
    this.waiters.set(nonce, seen);
    this.post({ type: "ping", from: this.tabId, nonce });
    await new Promise((r) => setTimeout(r, timeoutMs));
    this.waiters.delete(nonce);
    return seen;
  }

  /** Become the vault's leader when no other tab is; `onLeader` runs once that happens. */
  electLeader(onLeader: () => void) {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    if (!locks?.request) {
      this.leader = true;
      onLeader();
      return;
    }
    void locks
      .request(`openmarkdown-vault-leader:${this.vaultId}`, () => {
        this.leader = true;
        onLeader();
        return new Promise<void>((resolve) => (this.releaseLeader = resolve));
      })
      .catch(() => {
        this.leader = true;
        onLeader();
      });
  }

  close() {
    this.releaseLeader?.();
    this.channel?.close();
    this.channel = null;
  }
}
