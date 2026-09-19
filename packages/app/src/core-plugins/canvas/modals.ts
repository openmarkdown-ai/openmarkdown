/** Suggesters and prompts the canvas opens. */
import { Modal } from "../../obsidian/ui/modal";
import { ButtonComponent, TextComponent } from "../../obsidian/ui/setting";
import { FuzzySuggestModal } from "../../obsidian/ui/suggest";
import type { TFile } from "../../obsidian/vault/files";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "./node-view";

export const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, "pdf"];

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: any,
    private filter: (f: TFile) => boolean,
    private onChoose: (f: TFile) => void,
    placeholder: string,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to choose" },
      { command: "esc", purpose: "to dismiss" },
    ]);
  }
  getItems(): TFile[] {
    return (this.app as any).vault.getFiles().filter(this.filter);
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.onChoose(f);
  }
}

export class ItemSuggestModal<T> extends FuzzySuggestModal<T> {
  constructor(
    app: any,
    private items: T[],
    private text: (t: T) => string,
    private onChoose: (t: T) => void,
    placeholder: string,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getItems(): T[] {
    return this.items;
  }
  getItemText(t: T): string {
    return this.text(t);
  }
  onChooseItem(t: T): void {
    this.onChoose(t);
  }
}

/** A one-field prompt ("Convert to file", "Add web page", …). */
export class PromptModal extends Modal {
  private value: string;
  constructor(
    app: any,
    title: string,
    private placeholder: string,
    initial: string,
    private cta: string,
    private onSubmit: (value: string) => void,
  ) {
    super(app);
    this.value = initial;
    this.setTitle(title);
  }
  override onOpen() {
    const input = new TextComponent(this.contentEl).setPlaceholder(this.placeholder).setValue(this.value);
    input.inputEl.addClass("vault-canvas-prompt-input");
    input.onChange((v) => (this.value = v));
    const submit = () => {
      const v = this.value.trim();
      if (!v) return;
      this.close();
      this.onSubmit(v);
    };
    input.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons).setButtonText(this.cta).setCta().onClick(submit);
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    setTimeout(() => {
      input.inputEl.focus();
      input.inputEl.select();
    }, 0);
  }
  override onClose() {
    this.contentEl.empty();
  }
}

export class CanvasHelpModal extends Modal {
  constructor(app: any) {
    super(app);
    this.setTitle("Canvas help");
  }
  override onOpen() {
    const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl";
    const rows: [string, string][] = [
      ["Pan", "Space + drag, middle-click drag, or scroll"],
      ["Pan horizontally", "Shift + scroll"],
      ["Zoom", `${mod} + scroll, or pinch`],
      ["Zoom to fit", "Shift + 1"],
      ["Zoom to selection", "Shift + 2"],
      ["Select all", `${mod} + A`],
      ["Add to/remove from selection", "Shift + click"],
      ["Clone card", "Alt + drag"],
      ["Constrain card movement to axis", "Shift + drag"],
      ["Disable snapping while dragging", "Space"],
      ["Remove card", "Backspace / Delete"],
      ["Undo / redo", `${mod} + Z / ${mod} + Shift + Z`],
      ["Add card", "Double-click the canvas"],
    ];
    const table = this.contentEl.createEl("table", { cls: "vault-canvas-help" });
    for (const [what, how] of rows) {
      const tr = table.createEl("tr");
      tr.createEl("td", { text: what });
      tr.createEl("td", { text: how });
    }
  }
}
