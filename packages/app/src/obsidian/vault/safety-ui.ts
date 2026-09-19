/**
 * The few pieces of UI data safety needs: the compare modal for a conflict,
 * the "recover unsaved changes" modal at startup, and the banner a note view
 * shows while its file is in conflict, deleted underneath it, or read-only.
 *
 * Built from the app's Obsidian-compatible Modal and Obsidian DOM classes; the
 * diff table reuses File recovery's `.vault-diff` styles.
 */
import { diffLineOps } from "../../core-plugins/file-recovery/diff";
import { setIcon } from "../ui/icons";
import { Modal } from "../ui/modal";
import { moment } from "../util";

export type ConflictChoice = "mine" | "theirs" | "both";

export interface CompareOptions {
  title: string;
  description: string;
  path: string;
  /** The version on disk. */
  theirs: string;
  theirsLabel?: string;
  /** The buffer / unsaved version. */
  mine: string;
  mineLabel?: string;
  onChoose: (choice: ConflictChoice) => void | Promise<void>;
  /** Closed without a choice. */
  onCancel?: () => void;
  /** Offer "Keep both" (false for structured files, where joining both would not parse). */
  allowBoth?: boolean;
}

export class ConflictModal extends Modal {
  private chosen = false;

  constructor(
    app: any,
    private opts: CompareOptions,
  ) {
    super(app);
    this.modalEl.addClass("vault-conflict-modal");
    this.setTitle(opts.title);
  }

  override onOpen() {
    const { contentEl, opts } = this;
    contentEl.empty();
    contentEl.createDiv({ cls: "vault-conflict-description setting-item-description", text: opts.description });
    const table = contentEl.createDiv({ cls: "vault-diff vault-diff-split vault-conflict-diff" });
    renderSplitDiff(table, opts.theirs, opts.mine, opts.theirsLabel ?? "On disk", opts.mineLabel ?? "Your version");
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const choose = (choice: ConflictChoice) => {
      this.chosen = true;
      this.close();
      void opts.onChoose(choice);
    };
    if (opts.allowBoth !== false) buttons.createEl("button", { text: "Keep both" }).addEventListener("click", () => choose("both"));
    buttons.createEl("button", { text: `Keep ${opts.theirsLabel ? opts.theirsLabel.toLowerCase() : "disk version"}` }).addEventListener("click", () => choose("theirs"));
    const mine = buttons.createEl("button", { cls: "mod-cta", text: `Keep ${opts.mineLabel ? opts.mineLabel.toLowerCase() : "your version"}` });
    mine.addEventListener("click", () => choose("mine"));
  }

  override onClose() {
    if (!this.chosen) this.opts.onCancel?.();
  }
}

function renderSplitDiff(table: HTMLElement, left: string, right: string, leftLabel: string, rightLabel: string) {
  const header = table.createDiv({ cls: "vault-diff-row vault-diff-header" });
  header.createDiv({ cls: "vault-diff-cell", text: leftLabel });
  header.createDiv({ cls: "vault-diff-cell", text: rightLabel });
  const ops = diffLineOps(left, right);
  let l = 0;
  let r = 0;
  const cell = (row: HTMLElement, cls: string, no: number | null, text: string | null) => {
    const c = row.createDiv({ cls: `vault-diff-cell ${cls}` });
    c.createSpan({ cls: "vault-diff-gutter", text: no === null ? "" : String(no) });
    c.createSpan({ cls: "vault-diff-text", text: text === null ? "" : text || " " });
    if (text === null) c.addClass("is-empty");
  };
  // Long unchanged stretches collapse to a marker so the differences stay in view.
  const CONTEXT = 3;
  for (let i = 0; i < ops.length; ) {
    const op = ops[i]!;
    if (op.type === "equal") {
      let j = i;
      while (j < ops.length && ops[j]!.type === "equal") j++;
      const run = j - i;
      const showHead = i === 0 ? 0 : CONTEXT;
      const showTail = j === ops.length ? 0 : CONTEXT;
      for (let k = i; k < j; k++) {
        if (run > showHead + showTail + 1 && k === i + showHead) {
          const skipped = run - showHead - showTail;
          const row = table.createDiv({ cls: "vault-diff-row vault-diff-skip" });
          row.createDiv({ cls: "vault-diff-cell", text: `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
          row.createDiv({ cls: "vault-diff-cell" });
          l += skipped;
          r += skipped;
          k = j - showTail - 1;
          continue;
        }
        const row = table.createDiv({ cls: "vault-diff-row" });
        cell(row, "", ++l, ops[k]!.line);
        cell(row, "", ++r, ops[k]!.line);
      }
      i = j;
      continue;
    }
    const dels: string[] = [];
    const ins: string[] = [];
    while (i < ops.length && ops[i]!.type !== "equal") {
      (ops[i]!.type === "delete" ? dels : ins).push(ops[i]!.line);
      i++;
    }
    for (let k = 0; k < Math.max(dels.length, ins.length); k++) {
      const row = table.createDiv({ cls: "vault-diff-row" });
      const d = dels[k];
      const n = ins[k];
      cell(row, d === undefined ? "" : "mod-removed", d === undefined ? null : ++l, d ?? null);
      cell(row, n === undefined ? "" : "mod-added", n === undefined ? null : ++r, n ?? null);
    }
  }
}

export interface RecoveryItem {
  path: string;
  text: string;
  ts: number;
  /** Current text on disk, or null when the file no longer exists. */
  disk: string | null;
  /** The disk changed since the unsaved edits were made. */
  diskChanged: boolean;
}

export interface RecoveryActions {
  /** `force`: the user chose the unsaved edits in a compare, so write them as they are. */
  restore(item: RecoveryItem, force?: boolean): Promise<void>;
  discard(item: RecoveryItem): Promise<void>;
  /** The prompt was closed ("Later", ×, Escape) with these items still undecided. */
  later(items: RecoveryItem[]): Promise<void>;
}

export class RecoveryModal extends Modal {
  private listEl!: HTMLElement;

  constructor(
    app: any,
    private items: RecoveryItem[],
    private actions: RecoveryActions,
  ) {
    super(app);
    this.modalEl.addClass("vault-recovery-modal");
    this.setTitle("Recover unsaved changes");
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv({
      cls: "setting-item-description vault-recovery-description",
      text: "These notes had edits that were not saved when the app last closed. Nothing has been changed yet. Discarded edits stay in File recovery. Later keeps them and offers them again on the note.",
    });
    this.listEl = contentEl.createDiv({ cls: "vault-recovery-list" });
    const footer = contentEl.createDiv({ cls: "modal-button-container" });
    footer.createEl("button", { text: "Later" }).addEventListener("click", () => this.close());
    this.render();
  }

  override onClose() {
    const rest = this.items.slice();
    this.items.length = 0;
    if (rest.length) void this.actions.later(rest);
  }

  private render() {
    this.listEl.empty();
    if (!this.items.length) {
      this.close();
      return;
    }
    for (const item of this.items.slice()) {
      const row = this.listEl.createDiv({ cls: "vault-recovery-item" });
      const info = row.createDiv({ cls: "vault-recovery-info" });
      const name = info.createDiv({ cls: "vault-recovery-name" });
      setIcon(name.createSpan({ cls: "vault-recovery-icon" }), "lucide-file-text");
      name.createSpan({ text: item.path });
      const state = item.disk === null ? "The file no longer exists" : item.diskChanged ? "The file changed on disk since" : "";
      info.createDiv({ cls: "vault-recovery-meta", text: [`Edited ${moment(item.ts).fromNow()}`, `${item.text.length.toLocaleString()} characters`, state].filter(Boolean).join(" · ") });
      const actions = row.createDiv({ cls: "vault-recovery-actions" });
      const done = () => {
        this.items.remove(item);
        this.render();
      };
      const compare = actions.createEl("button", { text: "Compare" });
      compare.addEventListener("click", () =>
        new ConflictModal(this.app, {
          title: `Compare “${item.path}”`,
          description: "Left: the file as it is now. Right: your unsaved edits.",
          path: item.path,
          theirs: item.disk ?? "",
          theirsLabel: item.disk === null ? "Deleted" : "On disk",
          mine: item.text,
          mineLabel: "Unsaved edits",
          allowBoth: false,
          onChoose: async (choice) => {
            try {
              if (choice === "theirs") await this.actions.discard(item);
              else await this.actions.restore(item, true);
              done();
            } catch {
              /* cancelled */
            }
          },
        }).open(),
      );
      actions.createEl("button", { text: "Discard" }).addEventListener("click", async () => {
        await this.actions.discard(item);
        done();
      });
      actions.createEl("button", { cls: "mod-cta", text: item.disk === null ? "Recreate" : "Restore" }).addEventListener("click", async () => {
        try {
          await this.actions.restore(item);
          done();
        } catch {
          /* the user closed the compare dialog: keep the row */
        }
      });
    }
  }
}

export interface BannerAction {
  text: string;
  cta?: boolean;
  onClick: () => void;
}

/** The strip at the top of a note view: an icon, a message and a few buttons. */
export function renderBanner(parent: HTMLElement, kind: "conflict" | "deleted" | "encoding" | "recovery", message: string, actions: BannerAction[]): HTMLElement {
  const el = createDiv({ cls: `vault-safety-banner mod-${kind}`, attr: { role: kind === "recovery" ? "status" : "alert" } });
  setIcon(el.createDiv({ cls: "vault-safety-banner-icon" }), kind === "encoding" ? "lucide-lock" : kind === "deleted" ? "lucide-file-x" : kind === "recovery" ? "lucide-history" : "lucide-git-merge");
  el.createDiv({ cls: "vault-safety-banner-message", text: message });
  const buttons = el.createDiv({ cls: "vault-safety-banner-actions" });
  for (const a of actions) {
    const b = buttons.createEl("button", { text: a.text, cls: a.cta ? "mod-cta" : "" });
    b.addEventListener("click", a.onClick);
  }
  parent.prepend(el);
  return el;
}
