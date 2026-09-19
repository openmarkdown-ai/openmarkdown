/**
 * The capture surface: a text box, a destination, Save. The same DOM serves
 * three hosts — the full-page route `/?capture=1` (opened by a manifest
 * shortcut, an iOS Shortcut, the share target), the in-app modal, and the
 * floating Picture-in-Picture window.
 *
 * Enter saves; Shift+Enter starts a new line; Mod+Enter saves and keeps the
 * surface open for another entry.
 */
import { setIcon } from "../../obsidian/ui/icons";
import type { CaptureDestination, CaptureResult } from "./capture";

export interface CaptureSurfaceOptions {
  parent: HTMLElement;
  mode: "page" | "modal" | "floating";
  vaultName: string;
  initialText?: string;
  attachments?: { name: string; size: number }[];
  destination: CaptureDestination;
  inboxPath: string;
  save(text: string, destination: CaptureDestination): Promise<CaptureResult>;
  openNote?(path: string): void;
  close?(): void;
}

export interface CaptureSurface {
  el: HTMLElement;
  input: HTMLTextAreaElement;
  focus(): void;
  hasUnsavedText(): boolean;
}

const DESTINATIONS: { value: CaptureDestination; label: (inbox: string) => string }[] = [
  { value: "daily", label: () => "Today's daily note" },
  { value: "inbox", label: (inbox) => `Inbox (${inbox.replace(/\.md$/i, "")})` },
  { value: "new", label: () => "New note" },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function renderCaptureSurface(o: CaptureSurfaceOptions): CaptureSurface {
  const el = o.parent.createDiv({ cls: `vault-capture mod-${o.mode}` });
  const header = el.createDiv({ cls: "vault-capture-header" });
  const titleIcon = header.createDiv({ cls: "vault-capture-header-icon" });
  setIcon(titleIcon, "lucide-zap");
  const titles = header.createDiv({ cls: "vault-capture-titles" });
  titles.createDiv({ cls: "vault-capture-title", text: "Quick capture" });
  titles.createDiv({ cls: "vault-capture-vault", text: o.vaultName });
  if (o.close) {
    const close = header.createDiv({ cls: "clickable-icon vault-capture-close", attr: { "aria-label": "Close" } });
    setIcon(close, "lucide-x");
    close.addEventListener("click", () => o.close?.());
  }

  const input = el.createEl("textarea", {
    cls: "vault-capture-input",
    attr: { placeholder: "Write it down…", rows: o.mode === "floating" ? "4" : "6", "aria-label": "Capture text", spellcheck: "true", autocapitalize: "sentences" },
  });
  input.value = o.initialText ?? "";
  let savedText = "";

  if (o.attachments?.length) {
    const list = el.createDiv({ cls: "vault-capture-attachments" });
    for (const a of o.attachments) {
      const chip = list.createDiv({ cls: "vault-capture-attachment" });
      setIcon(chip.createSpan({ cls: "vault-capture-attachment-icon" }), "lucide-paperclip");
      chip.createSpan({ cls: "vault-capture-attachment-name", text: a.name });
      chip.createSpan({ cls: "vault-capture-attachment-size", text: formatSize(a.size) });
    }
  }

  const footer = el.createDiv({ cls: "vault-capture-footer" });
  const select = footer.createEl("select", { cls: "dropdown vault-capture-destination", attr: { "aria-label": "Destination" } });
  for (const d of DESTINATIONS) select.createEl("option", { value: d.value, text: d.label(o.inboxPath) });
  select.value = o.destination;
  footer.createDiv({ cls: "vault-capture-hint", text: "Enter to save · Shift+Enter for a new line" });
  const saveBtn = footer.createEl("button", { cls: "mod-cta vault-capture-save", text: "Save" });

  const status = el.createDiv({ cls: "vault-capture-status", attr: { role: "status", "aria-live": "polite" } });

  let saving = false;
  const save = async (keepOpen: boolean) => {
    if (saving) return;
    const text = input.value;
    if (!text.trim() && !o.attachments?.length) {
      input.focus();
      return;
    }
    saving = true;
    saveBtn.disabled = true;
    status.empty();
    status.removeClass("mod-error");
    status.setText("Saving…");
    try {
      const result = await o.save(text, select.value as CaptureDestination);
      savedText = text;
      status.empty();
      const check = status.createSpan({ cls: "vault-capture-status-icon" });
      setIcon(check, "lucide-check");
      status.createSpan({ text: `Saved to ${result.path}` });
      el.addClass("is-saved");
      if (o.mode === "modal" && !keepOpen) {
        o.close?.();
        return;
      }
      input.value = "";
      savedText = "";
      if (o.mode === "page") {
        const actions = status.createDiv({ cls: "vault-capture-status-actions" });
        if (o.openNote) {
          const open = actions.createEl("button", { text: "Open note" });
          open.addEventListener("click", () => o.openNote?.(result.path));
        }
      }
      if (o.attachments?.length) {
        el.querySelector(".vault-capture-attachments")?.remove();
        o.attachments = [];
      }
      input.focus();
    } catch (e) {
      status.empty();
      status.addClass("mod-error");
      status.setText(`Not saved: ${(e as Error)?.message ?? e}`);
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  };

  saveBtn.addEventListener("click", () => void save(false));
  input.addEventListener("keydown", (evt) => {
    if (evt.key !== "Enter" || evt.isComposing || evt.shiftKey || evt.altKey) return;
    evt.preventDefault();
    evt.stopPropagation();
    void save(evt.metaKey || evt.ctrlKey);
  });
  input.addEventListener("input", () => el.removeClass("is-saved"));
  el.addEventListener("keydown", (evt) => {
    if (evt.key === "Escape" && o.close) {
      evt.preventDefault();
      o.close();
    }
  });

  return {
    el,
    input,
    focus: () => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    hasUnsavedText: () => input.value.trim() !== "" && input.value !== savedText,
  };
}
