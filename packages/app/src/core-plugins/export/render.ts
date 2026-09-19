/**
 * The shared first half of every export: a note rendered as in Reading view
 * into an off-screen stage, with embeds, math, diagrams and images finished,
 * then cleaned of interactive chrome so the DOM describes only the document.
 *
 * Rich copy, DOCX, EPUB, PDF and slide export all start here, so they show
 * what Reading view shows (callouts, embeds, plugin post-processor output).
 */
import { Component } from "../../obsidian/events";
import { finishRenderMath } from "../../obsidian/markdown/loaders";
import { MarkdownRenderer } from "../../obsidian/markdown/renderer";
import { getFrontMatterInfo } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";

export interface RenderedNote {
  file: TFile;
  title: string;
  /** Markdown source that was rendered (frontmatter removed). */
  markdown: string;
  frontmatter: Record<string, unknown> | null;
  /** `.markdown-preview-view` wrapper (inline title, properties, sizer). */
  viewEl: HTMLElement;
  /** The rendered blocks. */
  bodyEl: HTMLElement;
}

export interface RenderOptions {
  /** Class of the stage element on `body` (default `vault-export-stage`). */
  stageClass?: string;
  includeTitle?: boolean;
  includeProperties?: boolean;
  /** Render this Markdown instead of the file's contents (e.g. the editor selection). */
  markdown?: string;
  /** Stage width in CSS px; images and diagrams lay out at this size. */
  width?: number;
}

export interface RenderSession {
  stage: HTMLElement;
  notes: RenderedNote[];
  dispose(): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function noteTitle(app: any, file: TFile): string {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
  const t = fm?.title;
  return typeof t === "string" && t.trim() ? t.trim() : file.basename;
}

export function stripFrontmatter(text: string): string {
  const info = getFrontMatterInfo(text);
  return info.exists ? text.slice(info.contentStart) : text;
}

export async function renderNotes(app: any, files: TFile[], opts: RenderOptions = {}): Promise<RenderSession> {
  const component = new Component();
  component.load();
  const stage = document.body.createDiv({ cls: opts.stageClass ?? "vault-export-stage" });
  if (opts.width) stage.style.width = `${opts.width}px`;
  const notes: RenderedNote[] = [];
  const dispose = () => {
    stage.remove();
    component.unload();
  };
  try {
    for (const file of files) {
      const raw = opts.markdown ?? (await app.vault.cachedRead(file));
      const markdown = stripFrontmatter(raw);
      const frontmatter = (app.metadataCache.getFileCache(file)?.frontmatter ?? null) as Record<string, unknown> | null;
      const viewEl = stage.createDiv({ cls: "markdown-preview-view markdown-rendered vault-export-note" });
      viewEl.dataset.path = file.path;
      const cssclasses = frontmatter?.cssclasses;
      if (Array.isArray(cssclasses)) for (const c of cssclasses) if (typeof c === "string" && c) viewEl.addClass(c);
      const title = noteTitle(app, file);
      if (opts.includeTitle) viewEl.createEl("h1", { cls: "inline-title vault-export-title", text: title });
      if (opts.includeProperties && frontmatter) renderProperties(viewEl, frontmatter);
      const bodyEl = viewEl.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
      await MarkdownRenderer.render(app, markdown, bodyEl, file.path, component);
      notes.push({ file, title, markdown, frontmatter, viewEl, bodyEl });
    }
    await settle(stage);
    const citations = app.internalPlugins?.getEnabledPluginById?.("citations");
    for (const n of notes) {
      if (typeof citations?.renderBibliography === "function") {
        try {
          await citations.renderBibliography(n.bodyEl, n.markdown, n.file.path);
        } catch (e) {
          console.error("Bibliography failed", e);
        }
      }
      cleanRendered(n.bodyEl);
    }
    return { stage, notes, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

function renderProperties(parent: HTMLElement, fm: Record<string, unknown>) {
  const entries = Object.entries(fm).filter(([k]) => !["position", "cssclasses", "cssclass"].includes(k));
  if (!entries.length) return;
  const table = parent.createEl("table", { cls: "vault-export-properties" });
  const tbody = table.createEl("tbody");
  for (const [k, v] of entries) {
    const tr = tbody.createEl("tr");
    tr.createEl("th", { text: k });
    tr.createEl("td", { text: Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v) });
  }
}

/** Wait for asynchronous parts of a render: math, Mermaid, note embeds, images. */
export async function settle(root: HTMLElement, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  await sleep(60);
  const pendingSelector = [
    ".math.is-loaded:empty",
    ".mermaid:empty",
    ".internal-embed:not(.is-loaded)",
    ".markdown-embed .markdown-preview-sizer:empty",
  ].join(",");
  while (Date.now() - start < timeoutMs) {
    if (!root.querySelector(pendingSelector)) break;
    await sleep(80);
  }
  await finishRenderMath().catch(() => {});
  await waitForImages(root, Math.max(1000, timeoutMs - (Date.now() - start)));
}

export function waitForImages(root: HTMLElement, timeoutMs: number): Promise<void> {
  const pending = Array.from(root.querySelectorAll("img")).filter((img) => !img.complete);
  if (pending.length === 0) return Promise.resolve();
  const all = Promise.all(
    pending.map(
      (img) =>
        new Promise<void>((r) => {
          img.addEventListener("load", () => r(), { once: true });
          img.addEventListener("error", () => r(), { once: true });
        }),
    ),
  );
  return Promise.race([all.then(() => undefined), sleep(timeoutMs)]);
}

/**
 * Remove interactive chrome and expand folded content. Leaves Obsidian's
 * semantic classes (callout, footnotes, internal-link …) for the writers.
 */
export function cleanRendered(root: HTMLElement) {
  root.querySelectorAll(".copy-code-button, .heading-collapse-indicator, .collapse-indicator, .markdown-embed-link, .callout-fold, .edit-block-button, .list-bullet, .list-collapse-indicator, .vault-citation-popover").forEach((el) => el.remove());
  root.querySelectorAll<HTMLElement>(".callout-content").forEach((el) => el.style.removeProperty("display"));
  root.querySelectorAll<HTMLElement>(".callout.is-collapsed").forEach((el) => el.removeClass("is-collapsed"));
  root.querySelectorAll<HTMLElement>("[contenteditable]").forEach((el) => el.removeAttribute("contenteditable"));
  root.querySelectorAll<HTMLElement>(".is-hidden").forEach((el) => el.removeClass("is-hidden"));
}

export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section";
}

/** Give every heading a unique id (for TOCs and in-document links). */
export function assignHeadingIds(root: HTMLElement, prefix = "", used = new Set<string>()): HTMLElement[] {
  const heads = Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")).filter((h) => !h.closest(".vault-export-toc"));
  for (const h of heads) {
    let id = prefix + slugify(h.getAttribute("data-heading") ?? h.textContent ?? "");
    let n = 1;
    while (used.has(id)) id = `${prefix}${slugify(h.textContent ?? "")}-${++n}`;
    used.add(id);
    h.id = id;
  }
  return heads;
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "export";
}
