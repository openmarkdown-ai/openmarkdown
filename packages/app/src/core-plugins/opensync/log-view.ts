/** Sync activity: what arrived, what was sent, what went wrong, newest first. */
import { ItemView } from "../../obsidian/workspace/view";
import { setIcon } from "../../obsidian/ui/icons";
import type { SyncPlugin } from "./index";
import { readLog, type LogEntry } from "./store";

export const SYNC_LOG_VIEW = "opensync-log";

const ICONS: Record<LogEntry["kind"], string> = {
  synced: "lucide-check",
  pulled: "lucide-download",
  published: "lucide-upload",
  merged: "lucide-git-merge",
  error: "lucide-alert-circle",
  info: "lucide-info",
};

export class SyncLogView extends ItemView {
  private offref: (() => void) | null = null;

  constructor(
    leaf: any,
    private readonly plugin: SyncPlugin,
  ) {
    super(leaf);
  }

  getViewType() {
    return SYNC_LOG_VIEW;
  }
  getDisplayText() {
    return "Sync activity";
  }
  override getIcon() {
    return "lucide-refresh-cw";
  }

  override async onOpen() {
    const ref = this.plugin.changes.on("change", () => void this.render());
    this.offref = () => this.plugin.changes.offref(ref);
    await this.render();
  }

  override async onClose() {
    this.offref?.();
  }

  private rendering = false;
  private async render() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      const entries = (await readLog(this.plugin.vaultId)).slice().reverse();
      const el = this.contentEl;
      el.empty();
      el.addClass("vault-sync-log");
      const head = el.createDiv({ cls: "vault-sync-log-head" });
      head.createDiv({ cls: "vault-sync-log-status", text: this.plugin.statusText().text });
      if (!entries.length) {
        el.createDiv({ cls: "pane-empty", text: this.plugin.record ? "Nothing has synced yet." : "Sync is not set up for this vault." });
        return;
      }
      const list = el.createDiv({ cls: "vault-sync-log-list" });
      for (const e of entries) {
        const row = list.createDiv({ cls: `vault-sync-log-entry mod-${e.kind}` });
        setIcon(row.createDiv({ cls: "vault-sync-log-icon" }), ICONS[e.kind]);
        const body = row.createDiv({ cls: "vault-sync-log-body" });
        body.createDiv({ cls: "vault-sync-log-text", text: e.text });
        body.createDiv({ cls: "vault-sync-log-time", text: new Date(e.at).toLocaleString() });
        if (e.paths?.length) {
          const details = body.createEl("details", { cls: "vault-sync-log-paths" });
          details.createEl("summary", { text: `${e.paths.length} file${e.paths.length === 1 ? "" : "s"}` });
          for (const p of e.paths) details.createDiv({ text: p });
        }
      }
    } finally {
      this.rendering = false;
    }
  }
}
