/**
 * Sync badges in the file explorer.
 *
 * Classes on Obsidian's own `.nav-file-title[data-path]` rows, not extra
 * nodes: the explorer re-renders rows freely, and a class is cheap to put
 * back. `vault-sync-pending` marks a file changed here since the last sync;
 * `vault-sync-conflict` marks a conflict copy and the file it conflicts with.
 * Synced files show nothing. The dot itself is drawn in `styles/sync.css`.
 */
import type { ConflictPair } from "./controller";

const PENDING = "vault-sync-pending";
const CONFLICT = "vault-sync-conflict";

export class ExplorerBadges {
  private observer: MutationObserver | null = null;
  private pending = new Set<string>();
  private conflicted = new Set<string>();
  private frame = 0;

  constructor(private readonly app: any) {}

  start(): void {
    if (this.observer) return;
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(this.app.workspace.containerEl ?? document.body, { childList: true, subtree: true });
    this.schedule();
  }

  update(pending: Set<string>, conflicts: ConflictPair[]): void {
    this.pending = new Set(pending);
    this.conflicted = new Set(conflicts.flatMap((c) => [c.path, c.copy]));
    this.schedule();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.apply();
    });
  }

  private apply(): void {
    const rows = document.querySelectorAll<HTMLElement>(".nav-file-title[data-path]");
    for (const row of rows) {
      const path = row.dataset.path ?? "";
      const conflict = this.conflicted.has(path);
      const pending = !conflict && this.pending.has(path);
      if (row.classList.contains(CONFLICT) !== conflict) row.classList.toggle(CONFLICT, conflict);
      if (row.classList.contains(PENDING) !== pending) row.classList.toggle(PENDING, pending);
      const title = conflict ? "Sync conflict — review it from the status bar" : pending ? "Not synced yet" : null;
      if (title) row.setAttribute("data-sync-state", title);
      else if (row.hasAttribute("data-sync-state")) row.removeAttribute("data-sync-state");
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.pending.clear();
    this.conflicted.clear();
    this.apply();
  }
}
