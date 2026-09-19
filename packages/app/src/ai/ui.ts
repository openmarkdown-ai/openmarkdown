/**
 * Small UI pieces shared by the device plugins (OCR, voice, AI tools,
 * backups): a consent dialog for big downloads and a progress dialog with a
 * cancel button.
 */
import { Modal } from "../obsidian/ui/modal";
import { ButtonComponent, ProgressBarComponent } from "../obsidian/ui/setting";

/** Asks before a download. Resolves true only when the user clicks the call to action. */
export function askToDownload(app: any, opts: { title: string; message: string | DocumentFragment; cta: string; detail?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const modal = new Modal(app);
    modal.modalEl.addClass("mod-confirmation", "vault-device-consent");
    modal.setTitle(opts.title);
    const p = modal.contentEl.createEl("p");
    if (typeof opts.message === "string") p.setText(opts.message);
    else p.appendChild(opts.message);
    if (opts.detail) modal.contentEl.createEl("p", { cls: "setting-item-description", text: opts.detail });
    const buttons = modal.modalEl.createDiv({ cls: "modal-button-container" });
    const ok = new ButtonComponent(buttons).setButtonText(opts.cta).setCta();
    ok.onClick(() => {
      decided = true;
      modal.close();
      resolve(true);
    });
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => modal.close());
    modal.onClose = () => {
      if (!decided) resolve(false);
    };
    modal.open();
    ok.buttonEl.focus();
  });
}

/** A modal with a status line, a progress bar and Cancel. `signal` aborts when cancelled or closed. */
export class ProgressModal extends Modal {
  private controller = new AbortController();
  private statusEl: HTMLElement;
  private bar: ProgressBarComponent;
  private detailEl: HTMLElement;
  private cancelBtn: ButtonComponent;
  done = false;

  constructor(app: any, title: string) {
    super(app);
    this.modalEl.addClass("vault-device-progress");
    this.setTitle(title);
    this.statusEl = this.contentEl.createDiv({ cls: "vault-device-progress-status" });
    this.bar = new ProgressBarComponent(this.contentEl.createDiv({ cls: "vault-device-progress-bar" }));
    this.detailEl = this.contentEl.createDiv({ cls: "vault-device-progress-detail setting-item-description" });
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    this.cancelBtn = new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** `fraction` in 0..1, or null for an indeterminate bar. */
  setProgress(fraction: number | null, status?: string, detail?: string): void {
    this.modalEl.toggleClass("is-indeterminate", fraction === null);
    this.bar.setValue(fraction === null ? 0 : Math.round(Math.max(0, Math.min(1, fraction)) * 100));
    if (status !== undefined) this.statusEl.setText(status);
    if (detail !== undefined) this.detailEl.setText(detail);
  }

  finish(status: string): void {
    this.done = true;
    this.setProgress(1, status);
    this.cancelBtn.setButtonText("Close");
  }

  override onClose(): void {
    if (!this.done) this.controller.abort();
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Aborts with a DOMException named AbortError, like fetch does. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "AbortError";
}
