/**
 * Modal and ConfirmationModal.
 *
 * DOM:
 *
 *   body > .modal-container.mod-dim
 *     .modal-bg
 *     .modal
 *       .modal-close-button.modal-header-button   (both names are targeted by themes)
 *       .modal-header > .modal-title
 *       .modal-content
 *
 * The modal's scope is pushed while it is open, so Escape closes it and keys
 * do not reach workspace hotkeys underneath. Tab cycles focus inside the modal.
 * A click that both starts and ends on the backdrop closes it (a text
 * selection dragged out of an input does not).
 */
import type { App } from "../app";
import type { HistoryHandler } from "obsidian";
import { setIcon } from "./icons";
import { Scope, keymapFor } from "./keymap";
import { ButtonComponent } from "./setting";

function activeDoc(): Document {
  return (globalThis as { activeDocument?: Document }).activeDocument ?? document;
}

export class Modal implements HistoryHandler {
  app: App;
  scope: Scope;
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  shouldRestoreSelection = false;

  // internal (used by plugins: some style or reposition these)
  bgEl: HTMLElement;
  // internal
  headerEl: HTMLElement;
  // internal
  closeButtonEl: HTMLElement;
  // internal (used by plugins: `modal.isOpen` guards against double-open)
  isOpen = false;
  // internal
  dimBackground = true;
  // internal
  selection: Range[] | null = null;
  // internal
  lastFocusEl: HTMLElement | null = null;
  // internal
  closeCallback: (() => any) | null = null;

  constructor(app: App) {
    this.app = app;
    this.scope = new Scope();
    this.scope.register([], "Escape", (evt) => {
      if (evt.isComposing) return;
      this.onEscapeKey();
      return false;
    });

    this.containerEl = createDiv({ cls: "modal-container" });
    this.bgEl = this.containerEl.createDiv({ cls: "modal-bg" });
    this.modalEl = this.containerEl.createDiv({ cls: "modal" });
    this.modalEl.setAttr("tabindex", -1);
    this.closeButtonEl = this.modalEl.createDiv({ cls: ["modal-close-button", "modal-header-button"], attr: { "aria-label": "Close", role: "button", tabindex: -1, "data-tooltip-disabled": "" } });
    setIcon(this.closeButtonEl, "lucide-x");
    this.closeButtonEl.addEventListener("click", () => this.close());
    this.headerEl = this.modalEl.createDiv({ cls: "modal-header" });
    this.titleEl = this.headerEl.createDiv({ cls: "modal-title" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
    this.scope.setTabFocusContainerEl(this.modalEl);

    let downOutside = false;
    this.containerEl.addEventListener("pointerdown", (evt) => {
      downOutside = !(evt.target instanceof Node && this.modalEl.contains(evt.target));
    });
    this.containerEl.addEventListener("click", (evt) => {
      const outside = !(evt.target instanceof Node && this.modalEl.contains(evt.target));
      if (outside && downOutside && evt.target instanceof Node && this.containerEl.contains(evt.target)) {
        this.close();
      }
      downOutside = false;
    });
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    const doc = activeDoc();
    const active = doc.activeElement;
    this.lastFocusEl = active instanceof HTMLElement && active !== doc.body ? active : null;
    if (this.shouldRestoreSelection) {
      const sel = doc.getSelection();
      this.selection = [];
      if (sel) for (let i = 0; i < sel.rangeCount; i++) this.selection.push(sel.getRangeAt(i).cloneRange());
    }
    this.containerEl.toggleClass("mod-dim", this.dimBackground);
    keymapFor(this.app).pushScope(this.scope);
    doc.body.appendChild(this.containerEl);

    let result: unknown;
    try {
      result = this.onOpen();
    } catch (e) {
      console.error(e);
    }
    const focusFallback = () => {
      if (!this.isOpen) return;
      const focused = doc.activeElement;
      if (!(focused instanceof Node) || !this.modalEl.contains(focused)) this.modalEl.focus({ preventScroll: true });
    };
    if (result instanceof Promise) result.catch((e) => console.error(e)).finally(focusFallback);
    else focusFallback();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    keymapFor(this.app).popScope(this.scope);
    this.containerEl.detach();
    try {
      this.onClose();
    } catch (e) {
      console.error(e);
    }
    if (this.closeCallback) {
      try {
        const r = this.closeCallback();
        if (r instanceof Promise) r.catch((e) => console.error(e));
      } catch (e) {
        console.error(e);
      }
    }
    const doc = this.containerEl.ownerDocument;
    if (this.shouldRestoreSelection && this.selection) {
      const sel = doc.getSelection();
      if (sel) {
        sel.removeAllRanges();
        for (const r of this.selection) sel.addRange(r);
      }
      this.selection = null;
    }
    if (this.lastFocusEl && this.lastFocusEl.isConnected) {
      const focused = doc.activeElement;
      if (!focused || focused === doc.body) this.lastFocusEl.focus({ preventScroll: true });
    }
    this.lastFocusEl = null;
  }

  onOpen(): Promise<void> | void {}

  onClose(): void {}

  // internal
  onEscapeKey(): void {
    this.close();
  }

  onHistoryBack(): void {
    this.close();
  }

  setTitle(title: string): this {
    this.titleEl.setText(title);
    return this;
  }

  setContent(content: string | DocumentFragment): this {
    this.contentEl.setText(content);
    return this;
  }

  setCloseCallback(callback: () => any): this {
    this.closeCallback = callback;
    return this;
  }
}

/**
 * A button in a ConfirmationModal's button row. Clicking closes the modal
 * once the handler resolves, unless the handler returns a truthy value.
 */
export class ConfirmationButton extends ButtonComponent {
  // internal
  modal: ConfirmationModal;
  // internal
  handler: ((evt: MouseEvent) => unknown | Promise<unknown>) | null = null;
  // internal
  busy = false;

  /** Private in the API: use `ConfirmationModal.addButton`. */
  constructor(containerEl: HTMLElement, modal: ConfirmationModal) {
    super(containerEl);
    this.modal = modal;
    this.buttonEl.addEventListener("click", (evt) => void this.run(evt));
  }

  private async run(evt: MouseEvent) {
    if (this.disabled || this.busy) return;
    this.busy = true;
    let keepOpen: unknown = false;
    try {
      keepOpen = this.handler ? await this.handler(evt) : false;
    } catch (e) {
      console.error(e);
      keepOpen = true;
    } finally {
      this.busy = false;
    }
    if (!keepOpen) this.modal.close();
  }

  override onClick(handler: (evt: MouseEvent) => unknown | Promise<unknown>): this {
    this.handler = handler;
    return this;
  }

  setInitialFocus(): this {
    this.modal.initialFocusEl = this.buttonEl;
    return this;
  }

  setSecondary(): this {
    this.buttonEl.addClass("mod-secondary");
    const container = this.modal.buttonContainerEl;
    const firstNonCheckbox = Array.from(container.children).find((c) => !c.classList.contains("mod-checkbox") && !c.classList.contains("mod-secondary"));
    container.insertBefore(this.buttonEl, firstNonCheckbox ?? null);
    return this;
  }

  setCancel(): this {
    this.buttonEl.addClass("mod-cancel");
    return this;
  }
}

export class ConfirmationModal extends Modal {
  buttonContainerEl: HTMLElement;
  // internal
  initialFocusEl: HTMLElement | null = null;

  constructor(app: App) {
    super(app);
    this.modalEl.addClass("mod-confirmation");
    this.buttonContainerEl = this.modalEl.createDiv({ cls: "modal-button-container" });
  }

  addClass(cls: string): this {
    this.modalEl.addClass(cls);
    return this;
  }

  addCheckbox(label: string, cb: (value: boolean) => any | Promise<any>): this {
    const labelEl = createEl("label", { cls: "mod-checkbox" });
    const input = labelEl.createEl("input", { type: "checkbox", attr: { tabindex: -1 } });
    labelEl.appendText(label);
    input.addEventListener("change", () => {
      try {
        const r = cb(input.checked);
        if (r instanceof Promise) r.catch((e: unknown) => console.error(e));
      } catch (e) {
        console.error(e);
      }
    });
    this.buttonContainerEl.insertBefore(labelEl, this.buttonContainerEl.firstChild);
    return this;
  }

  addButton(cb: (btn: ConfirmationButton) => any): this {
    const btn = new ConfirmationButton(this.buttonContainerEl, this);
    cb(btn);
    return this;
  }

  addCancelButton(text = "Cancel"): this {
    return this.addButton((btn) => btn.setButtonText(text).setCancel());
  }

  override open(): void {
    const wasOpen = this.isOpen;
    super.open();
    if (!wasOpen && this.isOpen) {
      const target = this.initialFocusEl ?? this.buttonContainerEl.querySelector<HTMLElement>("button.mod-cta") ?? null;
      target?.focus({ preventScroll: true });
    }
  }
}
