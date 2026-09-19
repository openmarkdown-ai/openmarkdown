/**
 * Conflict review.
 *
 * When two devices change one file before either has synced, sync keeps both:
 * one at the path, the other beside it as `name (conflict <date> from
 * <device>).md`. This lists those pairs, shows the two versions side by side,
 * and resolves each the way a person would by hand — so the resolution is an
 * ordinary edit and syncs like one. Replacing text snapshots it into file
 * recovery first.
 */
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { setIcon } from "../../obsidian/ui/icons";
import { TFile } from "../../obsidian/vault/files";
import { diffLineOps } from "../file-recovery/diff";
import type { ConflictPair } from "./controller";
import type { SyncPlugin } from "./index";

const TEXT = new Set(["md", "canvas", "base", "txt", "json", "csv", "css", "svg", "yaml", "yml", "bib", "excalidraw", "drawio"]);

export class ConflictModal extends Modal {
  private selected: string | null;
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;

  constructor(
    private readonly plugin: SyncPlugin,
    initialCopy?: string,
  ) {
    super(plugin.app);
    this.selected = initialCopy ?? null;
    this.modalEl.addClass("vault-sync-modal", "vault-sync-conflict-modal");
    this.setTitle("Sync conflicts");
  }

  private get pairs(): ConflictPair[] {
    return this.plugin.controller?.conflicts ?? [];
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const root = contentEl.createDiv({ cls: "vault-sync-conflicts" });
    this.listEl = root.createDiv({ cls: "vault-sync-conflict-list" });
    this.detailEl = root.createDiv({ cls: "vault-sync-conflict-detail" });
    void this.render();
  }

  private async render() {
    const pairs = this.pairs;
    if (!pairs.find((p) => p.copy === this.selected)) this.selected = pairs[0]?.copy ?? null;
    this.listEl.empty();
    if (!pairs.length) {
      this.detailEl.empty();
      const done = this.detailEl.createDiv({ cls: "vault-sync-done" });
      setIcon(done.createDiv({ cls: "vault-sync-done-icon" }), "lucide-check-circle");
      done.createDiv({ text: "No conflicts left." });
      return;
    }
    for (const p of pairs) {
      const item = this.listEl.createDiv({ cls: "vault-sync-conflict-item tappable", attr: { tabindex: "0", "data-copy": p.copy } });
      item.toggleClass("is-active", p.copy === this.selected);
      item.createDiv({ cls: "vault-sync-conflict-item-name", text: p.path.split("/").pop() ?? p.path });
      item.createDiv({ cls: "vault-sync-conflict-item-meta", text: `${p.path.includes("/") ? p.path.slice(0, p.path.lastIndexOf("/")) + " · " : ""}from ${p.from}, ${p.date}` });
      item.addEventListener("click", () => {
        this.selected = p.copy;
        void this.render();
      });
    }
    const pair = pairs.find((p) => p.copy === this.selected)!;
    await this.renderPair(pair);
  }

  private async renderPair(pair: ConflictPair) {
    const el = this.detailEl;
    el.empty();
    const vault = this.app.vault;
    const original = vault.getFileByPath(pair.path) as TFile | null;
    const copy = vault.getFileByPath(pair.copy) as TFile | null;
    const head = el.createDiv({ cls: "vault-sync-conflict-head" });
    head.createDiv({ cls: "vault-sync-conflict-title", text: pair.path });
    head.createDiv({
      cls: "setting-item-description",
      text: `Changed on two devices before they synced. The version from ${pair.from} was kept beside it as “${pair.copy.split("/").pop()}”.`,
    });

    const ext = pair.path.split(".").pop()?.toLowerCase() ?? "";
    if (original && copy && TEXT.has(ext)) {
      const [a, b] = await Promise.all([vault.read(original), vault.read(copy)]);
      const table = el.createDiv({ cls: "vault-diff vault-diff-split vault-sync-diff" });
      const header = table.createDiv({ cls: "vault-diff-row vault-diff-header" });
      header.createDiv({ cls: "vault-diff-cell", text: `At ${pair.path.split("/").pop()}` });
      header.createDiv({ cls: "vault-diff-cell", text: `From ${pair.from}` });
      renderSplit(table, diffLineOps(a, b));
    } else if (!original) {
      el.createDiv({ cls: "setting-item-description", text: `${pair.path} no longer exists; only the copy from ${pair.from} is left.` });
    } else {
      el.createDiv({ cls: "setting-item-description", text: "These files are not text, so they cannot be compared here. Open both to decide." });
    }

    const row = el.createDiv({ cls: "modal-button-container vault-sync-conflict-actions" });
    const keepMine = row.createEl("button", { text: `Keep ${pair.path.split("/").pop()}`, attr: { "data-action": "keep-path" } });
    const keepTheirs = row.createEl("button", { text: `Keep version from ${pair.from}`, attr: { "data-action": "keep-copy" } });
    const keepBoth = row.createEl("button", { text: "Keep both", attr: { "data-action": "keep-both" } });
    keepMine.disabled = !copy;
    keepTheirs.disabled = !copy;
    keepMine.addEventListener("click", () => void this.act(pair, "path"));
    keepTheirs.addEventListener("click", () => void this.act(pair, "copy"));
    keepBoth.addEventListener("click", () => void this.act(pair, "both"));
  }

  private async act(pair: ConflictPair, keep: "path" | "copy" | "both") {
    const { vault, fileManager } = this.app;
    const controller = this.plugin.controller;
    try {
      const copy = vault.getFileByPath(pair.copy) as TFile | null;
      const original = vault.getFileByPath(pair.path) as TFile | null;
      if (keep === "both") {
        await controller?.dismissConflict(pair.copy);
      } else if (keep === "path") {
        if (copy) await fileManager.trashFile(copy);
      } else if (copy) {
        const bytes = await vault.readBinary(copy);
        if (original) {
          const recovery: any = this.app.internalPlugins?.getEnabledPluginById?.("file-recovery");
          const ext = pair.path.split(".").pop()?.toLowerCase() ?? "";
          if (TEXT.has(ext)) {
            const current = await vault.read(original);
            await recovery?.forceAdd?.(pair.path, current);
            await vault.modify(original, await vault.read(copy));
          } else {
            await vault.modifyBinary(original, bytes);
          }
        } else {
          await vault.rename(copy, pair.path);
        }
        const leftover = vault.getFileByPath(pair.copy);
        if (leftover) await fileManager.trashFile(leftover);
      }
      await controller?.refreshConflicts();
      await this.render();
    } catch (e) {
      new Notice(`Could not resolve the conflict: ${(e as Error)?.message ?? e}`);
    }
  }
}

function renderSplit(table: HTMLElement, ops: ReturnType<typeof diffLineOps>) {
  let oldNo = 0;
  let newNo = 0;
  const cell = (row: HTMLElement, cls: string, no: number | null, text: string | null) => {
    const c = row.createDiv({ cls: `vault-diff-cell ${cls}` });
    c.createSpan({ cls: "vault-diff-gutter", text: no === null ? "" : String(no) });
    c.createSpan({ cls: "vault-diff-text", text: text === null ? "" : text || " " });
    if (text === null) c.addClass("is-empty");
  };
  for (let i = 0; i < ops.length; ) {
    const op = ops[i]!;
    if (op.type === "equal") {
      const row = table.createDiv({ cls: "vault-diff-row" });
      cell(row, "", ++oldNo, op.line);
      cell(row, "", ++newNo, op.line);
      i++;
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
      cell(row, d === undefined ? "" : "mod-removed", d === undefined ? null : ++oldNo, d ?? null);
      cell(row, n === undefined ? "" : "mod-added", n === undefined ? null : ++newNo, n ?? null);
    }
  }
}
