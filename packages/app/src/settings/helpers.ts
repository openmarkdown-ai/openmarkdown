/**
 * Small pieces shared by the settings window, its tabs and the store modals:
 * confirmation and prompt dialogs, file pickers, number formatting, and the
 * hook that runs code once the app's workspace exists.
 */
import type { App } from "../obsidian/app";
import { Modal } from "../obsidian/ui/modal";
import { ButtonComponent, TextComponent } from "../obsidian/ui/setting";

/** The product site; it links to the README until a documentation page exists. */
export const HELP_URL = "https://openmarkdown.ai";

/**
 * Runs `cb` once `app.workspace` exists. `installSettings` may be called before
 * `app.initialize()` (it must be, so core plugins can add setting tabs), when
 * the workspace has not been constructed yet.
 */
export function whenWorkspace(app: App, cb: () => void): void {
  const holder = app as unknown as { workspace?: unknown; __vaultWorkspaceWaiters?: (() => void)[] };
  if (holder.workspace) {
    cb();
    return;
  }
  if (holder.__vaultWorkspaceWaiters) {
    holder.__vaultWorkspaceWaiters.push(cb);
    return;
  }
  const waiters: (() => void)[] = [cb];
  holder.__vaultWorkspaceWaiters = waiters;
  Object.defineProperty(app, "workspace", {
    configurable: true,
    enumerable: true,
    get: () => undefined,
    set(value: unknown) {
      Object.defineProperty(app, "workspace", { value, writable: true, configurable: true, enumerable: true });
      delete holder.__vaultWorkspaceWaiters;
      for (const w of waiters) {
        try {
          w();
        } catch (e) {
          console.error(e);
        }
      }
    },
  });
}

/** Runs `cb` after the layout is ready (immediately when it already is). */
export function whenLayoutReady(app: App, cb: () => void): void {
  whenWorkspace(app, () => {
    if (app.workspace.layoutReady) cb();
    else app.workspace.onLayoutReady(cb);
  });
}

export function confirmModal(
  app: App,
  opts: { title: string; message: string | DocumentFragment; cta: string; warning?: boolean; cancel?: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const modal = new Modal(app);
    modal.modalEl.addClass("mod-confirmation");
    modal.setTitle(opts.title);
    const p = modal.contentEl.createEl("p");
    if (typeof opts.message === "string") p.setText(opts.message);
    else p.appendChild(opts.message);
    const buttons = modal.modalEl.createDiv({ cls: "modal-button-container" });
    const ok = new ButtonComponent(buttons).setButtonText(opts.cta);
    if (opts.warning) ok.setWarning();
    else ok.setCta();
    ok.onClick(() => {
      decided = true;
      modal.close();
      resolve(true);
    });
    new ButtonComponent(buttons).setButtonText(opts.cancel ?? "Cancel").onClick(() => modal.close());
    modal.onClose = () => {
      if (!decided) resolve(false);
    };
    modal.open();
    ok.buttonEl.focus();
  });
}

export function promptModal(
  app: App,
  opts: { title: string; placeholder?: string; value?: string; cta?: string; validate?: (v: string) => string | null },
): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const modal = new Modal(app);
    modal.setTitle(opts.title);
    const input = new TextComponent(modal.contentEl).setPlaceholder(opts.placeholder ?? "").setValue(opts.value ?? "");
    input.inputEl.addClass("vault-prompt-input");
    const error = modal.contentEl.createDiv({ cls: "vault-prompt-error" });
    const buttons = modal.modalEl.createDiv({ cls: "modal-button-container" });
    const submit = () => {
      const v = input.getValue().trim();
      const msg = opts.validate?.(v) ?? (v ? null : "Enter a value.");
      if (msg) {
        error.setText(msg);
        return;
      }
      result = v;
      modal.close();
    };
    new ButtonComponent(buttons).setButtonText(opts.cta ?? "Save").setCta().onClick(submit);
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => modal.close());
    input.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.isComposing) {
        evt.preventDefault();
        submit();
      }
    });
    modal.onClose = () => resolve(result);
    modal.open();
    input.inputEl.focus();
    input.inputEl.select();
  });
}

/** Opens the browser's file picker. Resolves with the chosen files (empty when cancelled). */
export function pickFiles(opts: { accept?: string; multiple?: boolean; directory?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (opts.accept) input.accept = opts.accept;
    input.multiple = !!opts.multiple;
    if (opts.directory) input.setAttribute("webkitdirectory", "");
    input.style.display = "none";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(Array.from(input.files ?? []));
    };
    input.addEventListener("change", finish);
    input.addEventListener("cancel", finish);
    document.body.appendChild(input);
    input.click();
  });
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}

export function formatDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 31) return `${days} days ago`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Lower-cased search tokens; every token must appear for a match. */
export function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesAll(text: string, toks: string[]): boolean {
  if (!toks.length) return true;
  const hay = text.toLowerCase();
  return toks.every((t) => hay.includes(t));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a font is installed, by measuring text against generic fallbacks —
 * `document.fonts.check` answers true for any font it does not need to load.
 */
export function isFontAvailable(name: string): boolean {
  const family = name.trim().replace(/^["']|["']$/g, "");
  if (!family) return false;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const sample = "mmmmmmmmmmlli1WQ@#";
  for (const base of ["monospace", "serif", "sans-serif"]) {
    ctx.font = `72px ${base}`;
    const baseWidth = ctx.measureText(sample).width;
    ctx.font = `72px "${family}", ${base}`;
    if (ctx.measureText(sample).width !== baseWidth) return true;
  }
  return false;
}

/** Splits a stored font list (`"Inter,Helvetica Neue"`) into names. */
export function parseFontList(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export function serializeFontList(names: string[]): string {
  return names.map((n) => n.trim()).filter(Boolean).join(",");
}
