/**
 * "Copy as rich text": the note (or the editor selection) rendered as in
 * Reading view, written to the clipboard as `text/html` with inline styles —
 * the only styling Google Docs, Word, Gmail and Notion keep on paste — plus the
 * Markdown source as `text/plain`.
 */
import type { TFile } from "../../obsidian/vault/files";
import { calloutRgb, dataUrl, imageBytes, PRINT_TEXT, standaloneSvg, svgToPng } from "./portable";
import { assignHeadingIds, renderNotes } from "./render";

export interface RichCopyOptions {
  /** Largest single image inlined as a data URL, in bytes. */
  maxImageBytes: number;
  /** Stop inlining once this many bytes of images are in the clipboard. */
  maxTotalBytes: number;
  includeTitle: boolean;
}

export const DEFAULT_RICH_COPY: RichCopyOptions = { maxImageBytes: 2_000_000, maxTotalBytes: 12_000_000, includeTitle: false };

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const TAG_STYLES: Record<string, string> = {
  h1: "font-size:2em;font-weight:700;margin:0.67em 0 0.4em",
  h2: "font-size:1.6em;font-weight:700;margin:0.8em 0 0.4em",
  h3: "font-size:1.3em;font-weight:700;margin:0.8em 0 0.3em",
  h4: "font-size:1.1em;font-weight:700;margin:0.8em 0 0.3em",
  h5: "font-size:1em;font-weight:700;margin:0.8em 0 0.3em",
  h6: "font-size:0.9em;font-weight:700;margin:0.8em 0 0.3em",
  p: "margin:0 0 0.8em",
  pre: `font-family:${MONO};font-size:0.9em;background:#f5f5f5;padding:10px 12px;border-radius:4px;white-space:pre-wrap;margin:0 0 0.8em`,
  code: `font-family:${MONO};font-size:0.9em;background:#f2f2f2;padding:0 3px;border-radius:3px`,
  blockquote: "border-left:3px solid #c8c8c8;margin:0 0 0.8em;padding:0 0 0 12px;color:#555",
  table: "border-collapse:collapse;margin:0 0 0.8em",
  th: "border:1px solid #bbb;padding:4px 8px;background:#f2f2f2;font-weight:700;text-align:left",
  td: "border:1px solid #bbb;padding:4px 8px",
  mark: "background:#fff3a3;color:inherit",
  hr: "border:0;border-top:1px solid #ccc;margin:1em 0",
  a: "color:#1a61d6;text-decoration:underline",
  img: "max-width:100%",
  ul: "margin:0 0 0.8em;padding-left:1.6em",
  ol: "margin:0 0 0.8em;padding-left:1.6em",
};

async function buildHtml(root: HTMLElement, opts: RichCopyOptions): Promise<string> {
  let total = 0;
  // Math and diagrams become PNG: Docs, Word and Gmail drop inline SVG.
  for (const svg of Array.from(root.querySelectorAll<SVGSVGElement>(".math svg, .mermaid svg, mjx-container svg"))) {
    if (svg.parentElement?.closest("svg")) continue;
    const holder = svg.closest<HTMLElement>("mjx-container") ?? svg;
    const { markup, width, height } = standaloneSvg(svg);
    const png = await svgToPng(markup, width, height, 2, PRINT_TEXT);
    if (!png) continue;
    total += png.length;
    const img = createEl("img", { attr: { src: dataUrl(png, "image/png"), width: String(width), height: String(height), alt: holder.closest(".math")?.getAttribute("data-source") ?? "" } });
    img.style.verticalAlign = holder.closest(".math-block") ? "" : "middle";
    holder.replaceWith(img);
  }
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (src.startsWith("data:")) continue;
    const bytes = await imageBytes(img);
    const size = { width: img.width || img.naturalWidth, height: img.height || img.naturalHeight };
    if (bytes && bytes.data.length <= opts.maxImageBytes && total + bytes.data.length <= opts.maxTotalBytes) {
      total += bytes.data.length;
      img.setAttribute("src", dataUrl(bytes.data, bytes.mime));
    } else if (!/^https?:/i.test(src)) {
      img.replaceWith(document.createTextNode(img.alt ? `[${img.alt}]` : ""));
      continue;
    }
    if (size.width) img.setAttribute("width", String(Math.round(size.width)));
  }
  // Embedded images are wrapped by the app; keep only the picture.
  root.querySelectorAll<HTMLElement>(".internal-embed.image-embed, .internal-embed.media-embed").forEach((el) => {
    const img = el.querySelector("img");
    if (img) el.replaceWith(img);
  });
  root.querySelectorAll<HTMLElement>(".markdown-embed-title").forEach((el) => el.remove());
  // Links into the vault mean nothing elsewhere.
  root.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
    const href = a.getAttribute("data-href") ?? "";
    const heading = href.startsWith("#") ? href.slice(1) : "";
    const target = heading ? root.querySelector<HTMLElement>(`[data-heading="${CSS.escape(heading)}"]`) : null;
    if (target?.id) {
      a.setAttribute("href", `#${target.id}`);
      a.removeAttribute("target");
    } else {
      a.replaceWith(...Array.from(a.childNodes));
    }
  });
  root.querySelectorAll<HTMLElement>("a.tag").forEach((a) => a.replaceWith(createSpan({ text: a.textContent ?? "" })));
  root.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((c) => c.replaceWith(document.createTextNode(c.checked ? "☑ " : "☐ ")));
  root.querySelectorAll<HTMLElement>(".callout").forEach((c) => {
    const rgb = calloutRgb(c).join(", ");
    c.setAttribute("style", `border-left:4px solid rgb(${rgb});background:rgba(${rgb},0.1);padding:8px 12px;margin:0 0 0.8em;border-radius:4px`);
    c.querySelectorAll(".callout-icon").forEach((i) => i.remove());
    const title = c.querySelector<HTMLElement>(".callout-title");
    if (title) title.setAttribute("style", `font-weight:700;color:rgb(${rgb});margin-bottom:4px`);
  });
  root.querySelectorAll("svg").forEach((s) => {
    if (!s.closest(".mermaid") && !s.closest("mjx-container")) s.remove(); // leftover icons
  });
  root.querySelectorAll("button, script, style").forEach((el) => el.remove());
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const tag = el.tagName.toLowerCase();
    const base = TAG_STYLES[tag];
    if (tag === "code" && el.parentElement?.tagName === "PRE") {
      el.setAttribute("style", `font-family:${MONO}`);
    } else if (base && !el.hasAttribute("style")) {
      el.setAttribute("style", base);
    }
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-") || attr.name === "dir" || attr.name === "aria-label" || attr.name === "tabindex") el.removeAttribute(attr.name);
    }
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      const base = location.href.split("#")[0]!;
      if (href.startsWith(base + "#")) el.setAttribute("href", href.slice(base.length));
      el.removeAttribute("target");
      el.removeAttribute("rel");
    }
    el.removeAttribute("class");
  }
  return root.innerHTML;
}

export interface RichCopyResult {
  html: string;
  text: string;
}

/** Render `file` (or `markdown`) and produce the clipboard payload. */
export async function richCopyPayload(app: any, file: TFile, markdown: string | undefined, opts: RichCopyOptions): Promise<RichCopyResult> {
  const session = await renderNotes(app, [file], { markdown, includeTitle: opts.includeTitle && markdown === undefined, width: 720 });
  try {
    const note = session.notes[0]!;
    assignHeadingIds(note.viewEl);
    const body = await buildHtml(note.viewEl, opts);
    const html = `<meta charset="utf-8"><div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11pt;line-height:1.5;color:${PRINT_TEXT}">${body}</div>`;
    return { html, text: markdown ?? note.markdown };
  } finally {
    session.dispose();
  }
}

/**
 * Write both flavours. `ClipboardItem` takes promises so the write stays inside
 * the user gesture while rendering finishes (Safari requires it). Falls back to
 * a `copy` event for browsers without `clipboard.write`.
 */
export async function writeRichClipboard(payload: Promise<RichCopyResult>): Promise<RichCopyResult> {
  const ClipboardItemCtor = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (ClipboardItemCtor && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItemCtor({
        "text/html": payload.then((p) => new Blob([p.html], { type: "text/html" })),
        "text/plain": payload.then((p) => new Blob([p.text], { type: "text/plain" })),
      });
      await navigator.clipboard.write([item]);
      return payload;
    } catch (e) {
      // Some browsers reject promise values; retry with resolved blobs.
      const p = await payload;
      try {
        await navigator.clipboard.write([new ClipboardItemCtor({ "text/html": new Blob([p.html], { type: "text/html" }), "text/plain": new Blob([p.text], { type: "text/plain" }) })]);
        return p;
      } catch {
        if (!copyViaEvent(p)) throw e;
        return p;
      }
    }
  }
  const p = await payload;
  if (!copyViaEvent(p)) throw new Error("This browser does not allow writing to the clipboard.");
  return p;
}

function copyViaEvent(p: RichCopyResult): boolean {
  let ok = false;
  const onCopy = (evt: ClipboardEvent) => {
    evt.preventDefault();
    evt.clipboardData?.setData("text/html", p.html);
    evt.clipboardData?.setData("text/plain", p.text);
    ok = true;
  };
  document.addEventListener("copy", onCopy, { once: true });
  try {
    document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy);
  }
  return ok;
}
