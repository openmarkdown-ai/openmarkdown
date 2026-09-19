/** Result notice and failure report for remote image downloads. */
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import type { DownloadResult } from "./download";

export function summary(results: DownloadResult[], cancelled: boolean): string {
  const downloaded = results.reduce((n, r) => n + r.downloaded, 0);
  const reused = results.reduce((n, r) => n + r.reused, 0);
  const failed = results.reduce((n, r) => n + r.failures.length, 0);
  const found = results.reduce((n, r) => n + r.found, 0);
  if (!found) return "No remote images found.";
  const parts = [`Downloaded ${downloaded} image${downloaded === 1 ? "" : "s"}`];
  if (reused) parts.push(`reused ${reused} already in the vault`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(", ") + (cancelled ? " (cancelled)." : ".");
}

export function showReport(app: any, results: DownloadResult[], cancelled: boolean) {
  const failed = results.filter((r) => r.failures.length);
  if (!failed.length) {
    new Notice(summary(results, cancelled));
    return;
  }
  new DownloadReportModal(app, results, cancelled).open();
}

export class DownloadReportModal extends Modal {
  constructor(
    app: any,
    private results: DownloadResult[],
    private cancelled: boolean,
  ) {
    super(app);
  }
  override onOpen() {
    this.setTitle("Remote images");
    this.modalEl.addClass("vault-local-images-report");
    this.contentEl.createEl("p", { text: summary(this.results, this.cancelled) });
    const wrap = this.contentEl.createDiv({ cls: "vault-local-images-table-wrap" });
    const table = wrap.createEl("table", { cls: "vault-local-images-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const h of ["Note", "Image", "Status", "Reason"]) head.createEl("th", { text: h });
    const body = table.createEl("tbody");
    for (const r of this.results) {
      for (const f of r.failures) {
        const row = body.createEl("tr");
        row.createEl("td", { text: r.file });
        row.createEl("td", { cls: "vault-local-images-url", text: f.url });
        row.createEl("td", { text: f.status ? String(f.status) : "–" });
        row.createEl("td", { text: f.reason });
      }
    }
  }
  override onClose() {
    this.contentEl.empty();
  }
}
