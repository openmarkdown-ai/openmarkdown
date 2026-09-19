/**
 * Notice — a transient message in the top-right corner.
 *
 * DOM: `body > .notice-container > .notice > .notice-message`. `containerEl`
 * is the `.notice`, `messageEl` the message inside it, and the deprecated
 * `noticeEl` is the same element as `messageEl` (plugins that wrote into
 * `noticeEl` keep writing the message). Clicking a notice dismisses it; a
 * duration of 0 keeps it until then.
 */

const DEFAULT_DURATION = 5000;
const HIDE_ANIMATION_MS = 150;

function noticeContainer(doc: Document): HTMLElement {
  let container = doc.body.querySelector<HTMLElement>(":scope > .notice-container");
  if (!container) {
    container = doc.createElement("div");
    container.className = "notice-container";
    doc.body.appendChild(container);
  }
  return container;
}

export class Notice {
  /** @deprecated Use `messageEl` instead. */
  noticeEl: HTMLElement;
  containerEl: HTMLElement;
  messageEl: HTMLElement;
  // internal
  hideTimer: number | null = null;
  // internal
  isHidden = false;

  constructor(message: string | DocumentFragment, duration?: number) {
    const doc = (globalThis as { activeDocument?: Document }).activeDocument ?? document;
    const container = noticeContainer(doc);
    this.containerEl = doc.createElement("div");
    this.containerEl.className = "notice";
    this.messageEl = doc.createElement("div");
    this.messageEl.className = "notice-message";
    this.containerEl.appendChild(this.messageEl);
    this.noticeEl = this.messageEl;
    this.setMessage(message);
    this.containerEl.addEventListener("click", () => this.hide());
    container.appendChild(this.containerEl);

    const ms = duration === undefined || duration === null ? DEFAULT_DURATION : Number(duration);
    if (ms > 0 && Number.isFinite(ms)) {
      this.hideTimer = window.setTimeout(() => this.hide(), ms);
    }
  }

  setMessage(message: string | DocumentFragment): this {
    this.messageEl.textContent = "";
    if (typeof message === "string") this.messageEl.textContent = message;
    else if (message) this.messageEl.appendChild(message);
    return this;
  }

  hide(): void {
    if (this.isHidden) return;
    this.isHidden = true;
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const el = this.containerEl;
    el.classList.add("mod-hiding");
    const remove = () => {
      const container = el.parentElement;
      el.remove();
      if (container && container.classList.contains("notice-container") && container.childElementCount === 0) container.remove();
    };
    // Animate out when motion is allowed; remove regardless after the timeout.
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !el.isConnected) remove();
    else window.setTimeout(remove, HIDE_ANIMATION_MS);
  }
}
