/**
 * Making rendered DOM portable: images become bytes or data URLs, MathJax and
 * Mermaid SVG become self-contained SVG or PNG, links stop pointing into the app.
 */

export interface ImageBytes {
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

const XLINK = "http://www.w3.org/1999/xlink";

/** Fetch an `<img>`'s bytes (blob:, data:, same-origin or CORS-enabled URL). */
export async function imageBytes(img: HTMLImageElement): Promise<ImageBytes | null> {
  const src = img.currentSrc || img.src;
  if (!src) return null;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    const data = new Uint8Array(await blob.arrayBuffer());
    const mime = sniffMime(data) ?? blob.type ?? "application/octet-stream";
    const { width, height } = displaySize(img);
    return { data, mime, width, height };
  } catch {
    return null;
  }
}

export function displaySize(el: HTMLImageElement | SVGSVGElement | HTMLElement): { width: number; height: number } {
  const rect = el.getBoundingClientRect();
  let width = rect.width;
  let height = rect.height;
  if (el instanceof HTMLImageElement) {
    const nw = el.naturalWidth || 0;
    const nh = el.naturalHeight || 0;
    const attrW = Number(el.getAttribute("width")) || 0;
    if (!width || !height) {
      width = attrW || nw;
      height = attrW && nw ? (attrW * nh) / nw : nh;
    }
  }
  return { width: Math.round(width) || 1, height: Math.round(height) || 1 };
}

export function sniffMime(d: Uint8Array): string | null {
  if (d.length < 12) return null;
  if (d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return "image/png";
  if (d[0] === 0xff && d[1] === 0xd8) return "image/jpeg";
  if (d[0] === 0x47 && d[1] === 0x49 && d[2] === 0x46) return "image/gif";
  if (d[0] === 0x42 && d[1] === 0x4d) return "image/bmp";
  if (d[0] === 0x52 && d[1] === 0x49 && d[2] === 0x46 && d[3] === 0x46 && d[8] === 0x57 && d[9] === 0x45) return "image/webp";
  const head = new TextDecoder().decode(d.subarray(0, Math.min(d.length, 512))).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

export function bytesToBase64(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

export function dataUrl(data: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(data)}`;
}

/**
 * A standalone copy of an inline SVG: MathJax's global font cache (`<use
 * href="#MJX-…">`) is copied into local `<defs>`, and width/height are set in
 * px from the laid-out size so it renders the same outside the app.
 */
export function standaloneSvg(svg: SVGSVGElement): { markup: string; width: number; height: number; el: SVGSVGElement } {
  const { width, height } = displaySize(svg);
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const ids = new Set<string>();
  const collect = (root: Element) => {
    root.querySelectorAll("use").forEach((u) => {
      const href = u.getAttribute("href") ?? u.getAttributeNS(XLINK, "href") ?? "";
      if (href.startsWith("#")) ids.add(href.slice(1));
    });
  };
  collect(clone);
  if (ids.size) {
    let defs = clone.querySelector(":scope > defs");
    if (!defs) {
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      clone.insertBefore(defs, clone.firstChild);
    }
    const done = new Set<string>();
    const queue = [...ids];
    while (queue.length) {
      const id = queue.shift()!;
      if (done.has(id) || clone.querySelector(`[id="${CSS.escape(id)}"]`)) continue;
      done.add(id);
      const src = document.getElementById(id) ?? mathJaxGlyph(id);
      if (!src) continue;
      const copy = src.cloneNode(true) as Element;
      defs.appendChild(copy);
      copy.querySelectorAll("use").forEach((u) => {
        const href = u.getAttribute("href") ?? u.getAttributeNS(XLINK, "href") ?? "";
        if (href.startsWith("#")) queue.push(href.slice(1));
      });
    }
  }
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  // Not laid out (e.g. a hidden slide): keep MathJax's ex-based size.
  if (svg.getBoundingClientRect().width > 0) {
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
  }
  // MathJax colours with currentColor; outside the app that is black.
  const color = getComputedStyle(svg).color;
  if (color) clone.style.color = color;
  clone.removeAttribute("focusable");
  return { markup: new XMLSerializer().serializeToString(clone), width, height, el: clone };
}

/** MathJax (fontCache: "global") keeps glyph paths in a <defs> that is not always in the document. */
function mathJaxGlyph(id: string): Element | null {
  const cache = (window as unknown as { MathJax?: { startup?: { output?: { fontCache?: { getCache?: () => Element | null } } } } }).MathJax?.startup?.output?.fontCache?.getCache?.();
  return cache?.querySelector(`[id="${CSS.escape(id)}"]`) ?? null;
}

/** Rasterise SVG markup to PNG at `scale`× for targets that cannot show SVG (Word, Gmail). */
export async function svgToPng(markup: string, width: number, height: number, scale = 2, color = "#000"): Promise<Uint8Array | null> {
  const fixed = markup.replace(/currentColor/g, color);
  const url = `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(fixed))}`;
  return rasterise(url, width, height, scale);
}

export async function rasterise(src: string, width: number, height: number, scale = 2): Promise<Uint8Array | null> {
  try {
    const img = new Image();
    img.decoding = "sync";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = src;
    });
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** PNG dimensions from the IHDR chunk. */
export function pngSize(d: Uint8Array): { width: number; height: number } | null {
  if (d.length < 24 || d[0] !== 0x89) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

/** Text colour to use for rasterised math: the document's normal text colour in print (black). */
export const PRINT_TEXT = "#1a1a1a";

/** A callout's accent as [r, g, b], whatever form `--callout-color` takes. */
export function calloutRgb(el: HTMLElement): [number, number, number] {
  const raw = getComputedStyle(el).getPropertyValue("--callout-color").trim();
  const nums = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  let c = /^[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+$/.test(raw) ? nums(raw) : [];
  if (c.length !== 3 && raw) {
    const probe = document.body.createDiv();
    probe.style.color = raw.includes(",") && !raw.includes("(") ? `rgb(${raw})` : raw;
    c = nums(getComputedStyle(probe).color);
    probe.remove();
  }
  return c.length === 3 && c.every((n) => Number.isFinite(n)) ? (c as [number, number, number]) : [68, 138, 255];
}
