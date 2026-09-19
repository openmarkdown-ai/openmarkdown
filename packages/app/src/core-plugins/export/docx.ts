/**
 * Word (.docx) export, written in the browser with the `docx` package (MIT),
 * loaded on first use. Input is the Reading-view DOM from `render.ts`, so
 * embeds, callouts and math arrive already resolved.
 *
 * Mapping: headings → Heading1–6 styles (with bookmarks for in-document links),
 * lists → numbering definitions (ordered lists restart), tables → Word tables,
 * code → shaded monospace paragraphs, callouts and quotes → shaded / bordered
 * paragraphs, footnotes → real Word footnotes, images / math / Mermaid →
 * inline pictures (SVG rasterised to PNG).
 */
import type * as Docx from "docx";
import type { TFile } from "../../obsidian/vault/files";
import { calloutRgb, imageBytes, PRINT_TEXT, rasterise, standaloneSvg, svgToPng, dataUrl } from "./portable";
import { renderNotes, type RenderedNote } from "./render";

type D = typeof Docx;
type ParagraphChild = Docx.ParagraphChild;
type Block = Docx.Paragraph | Docx.Table;

interface Fmt {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  highlight?: boolean;
  code?: boolean;
  superScript?: boolean;
  subScript?: boolean;
  underline?: boolean;
  color?: string;
  link?: boolean;
}

interface BlockCtx {
  listLevel: number;
  /** Paragraph properties inherited from a quote or callout. */
  para: Record<string, unknown>;
  inTable: boolean;
}

export interface DocxOptions {
  includeTitle: boolean;
  includeProperties: boolean;
}

/** The note's first block is a level-1 heading with the title's text, so a generated title would repeat it. */
function startsWithTitle(note: RenderedNote): boolean {
  const norm = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  let el: Element | null = note.bodyEl.firstElementChild;
  while (el) {
    const text = norm(el.textContent);
    const isFrontmatter = el.matches(".frontmatter-container, .mod-frontmatter, .metadata-container, pre.frontmatter") || !!el.querySelector(":scope > .frontmatter, :scope > .metadata-container");
    if (text || el.querySelector("img, svg, iframe, video, table")) {
      if (isFrontmatter) {
        el = el.nextElementSibling;
        continue;
      }
      const heading = el.matches("h1") ? el : el.querySelector(":scope > h1");
      return !!heading && norm(heading.textContent) === norm(note.title);
    }
    el = el.nextElementSibling;
  }
  return false;
}

const MAX_IMAGE_WIDTH = 600; // px, about the text width of an A4/Letter page
const MONO = "Consolas";

class DocxWriter {
  private footnoteSources: HTMLElement[] = [];
  private footnoteIds = new Map<HTMLElement, number>();
  private olInstance = 0;
  private bookmarkFor = new Map<HTMLElement, string>();
  private bookmarkCount = 0;
  private bookmarkSeq = 0;
  private drawingSeq = 0;
  private note!: RenderedNote;

  constructor(
    private d: D,
    private notes: RenderedNote[],
  ) {}

  async build(opts: DocxOptions): Promise<Docx.Document> {
    const d = this.d;
    const children: Block[] = [];
    for (const [i, note] of this.notes.entries()) {
      this.note = note;
      note.viewEl.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6").forEach((h) => this.bookmarkFor.set(h, `_Ref_h${++this.bookmarkCount}`));
      if ((opts.includeTitle || this.notes.length > 1) && !startsWithTitle(note)) {
        children.push(new d.Paragraph({ heading: d.HeadingLevel.TITLE, pageBreakBefore: i > 0, children: [new d.TextRun(note.title)] }));
      }
      const props = note.viewEl.querySelector<HTMLElement>(":scope > .vault-export-properties");
      if (opts.includeProperties && props) children.push(...(await this.blocks(props, { listLevel: 0, para: {}, inTable: false })));
      children.push(...(await this.blocks(note.bodyEl, { listLevel: 0, para: {}, inTable: false })));
    }
    const footnotes: Record<string, { children: Docx.Paragraph[] }> = {};
    for (let k = 0; k < this.footnoteSources.length; k++) {
      const li = this.footnoteSources[k]!;
      const clone = li.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(".footnote-backref").forEach((b) => b.remove());
      const paras = (await this.blocks(clone, { listLevel: 0, para: {}, inTable: true })).filter((b): b is Docx.Paragraph => b instanceof d.Paragraph);
      footnotes[String(k + 1)] = { children: paras.length ? paras : [new d.Paragraph("")] };
    }
    const first = this.notes[0]!;
    const fm = first.frontmatter ?? {};
    const author = [fm.author, fm.authors].flat().filter((a) => typeof a === "string").join(", ");
    const levels = (bullet: boolean) =>
      Array.from({ length: 9 }, (_, level) => ({
        level,
        format: bullet ? d.LevelFormat.BULLET : [d.LevelFormat.DECIMAL, d.LevelFormat.LOWER_LETTER, d.LevelFormat.LOWER_ROMAN][level % 3]!,
        text: bullet ? ["•", "◦", "▪"][level % 3]! : `%${level + 1}.`,
        alignment: d.AlignmentType.START,
        style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
      }));
    return new d.Document({
      title: this.notes.length === 1 ? first.title : undefined,
      creator: author || undefined,
      description: typeof fm.description === "string" ? fm.description : undefined,
      styles: {
        default: { document: { run: { font: "Calibri", size: 22 } } },
        paragraphStyles: [
          { id: "VaultCode", name: "Code", basedOn: "Normal", run: { font: MONO, size: 19 }, paragraph: { spacing: { before: 60, after: 120 }, shading: { type: d.ShadingType.CLEAR, fill: "F4F4F4", color: "auto" } } },
          { id: "VaultBibliography", name: "Bibliography", basedOn: "Normal", paragraph: { indent: { left: 720, hanging: 720 }, spacing: { after: 120 } } },
        ],
      },
      numbering: { config: [{ reference: "vault-ol", levels: levels(false) }, { reference: "vault-ul", levels: levels(true) }] },
      footnotes,
      sections: [{ children }],
    });
  }

  // ---- blocks ------------------------------------------------------------------

  private async blocks(container: HTMLElement, ctx: BlockCtx): Promise<Block[]> {
    const out: Block[] = [];
    let inline: Node[] = [];
    const flush = async () => {
      if (!inline.length) return;
      const nodes = inline;
      inline = [];
      if (nodes.every((n) => n.nodeType === Node.TEXT_NODE && !n.textContent?.trim())) return;
      out.push(this.paragraph(await this.inlines(nodes, {}), ctx));
    };
    for (const node of Array.from(container.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        inline.push(node);
        continue;
      }
      if (!(node instanceof Element)) continue;
      if (isInline(node)) {
        inline.push(node);
        continue;
      }
      await flush();
      out.push(...(await this.block(node as HTMLElement, ctx)));
    }
    await flush();
    return out;
  }

  private paragraph(children: ParagraphChild[], ctx: BlockCtx, extra: Record<string, unknown> = {}): Docx.Paragraph {
    return new this.d.Paragraph({ ...ctx.para, ...extra, children } as Docx.IParagraphOptions);
  }

  private async block(el: HTMLElement, ctx: BlockCtx): Promise<Block[]> {
    const d = this.d;
    const tag = el.tagName.toLowerCase();
    if (el.matches("section.footnotes, .footnotes, .inline-title, .markdown-embed-title, .frontmatter-container, .vault-export-toc")) return [];
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const runs = await this.inlines(Array.from(el.childNodes), {});
      const id = this.bookmarkFor.get(el);
      const heading = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4, d.HeadingLevel.HEADING_5, d.HeadingLevel.HEADING_6][level - 1];
      // docx 9.7 numbers every Bookmark 1; Word needs unique ids, so build the markers directly.
      const n = ++this.bookmarkSeq;
      const children = id ? ([new d.BookmarkStart(id, n), ...runs, new d.BookmarkEnd(n)] as unknown as ParagraphChild[]) : runs;
      return [new d.Paragraph({ heading, children })];
    }
    if (tag === "p") return [this.paragraph(await this.inlines(Array.from(el.childNodes), {}), ctx)];
    if (tag === "ul" || tag === "ol") return this.list(el, ctx);
    if (tag === "pre") {
      const text = (el.querySelector("code") ?? el).textContent ?? "";
      const lines = text.replace(/\n$/, "").split("\n");
      const runs = lines.map((line, i) => new d.TextRun({ text: line, font: MONO, break: i > 0 ? 1 : undefined }));
      return [new d.Paragraph({ ...ctx.para, style: "VaultCode", children: runs } as Docx.IParagraphOptions)];
    }
    if (tag === "blockquote") {
      const para = { ...ctx.para, indent: { left: 360 * (ctx.listLevel + 1) }, border: { left: { style: d.BorderStyle.SINGLE, size: 18, color: "BBBBBB", space: 8 } } };
      return this.blocks(el, { ...ctx, para });
    }
    if (el.classList.contains("callout")) {
      const rgb = calloutRgb(el);
      const hex = (c: number[]) => c.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("").toUpperCase();
      const tint = rgb.map((n) => n + (255 - n) * 0.88);
      const para = { ...ctx.para, shading: { type: d.ShadingType.CLEAR, fill: hex(tint), color: "auto" }, border: { left: { style: d.BorderStyle.SINGLE, size: 24, color: hex(rgb), space: 8 } }, indent: { left: 240, right: 120 } };
      const out: Block[] = [];
      const title = el.querySelector<HTMLElement>(":scope > .callout-title .callout-title-inner") ?? el.querySelector<HTMLElement>(":scope > .callout-title");
      if (title) out.push(new d.Paragraph({ ...para, spacing: { before: 120 }, children: await this.inlines(Array.from(title.childNodes), { bold: true, color: hex(rgb) }) } as Docx.IParagraphOptions));
      const content = el.querySelector<HTMLElement>(":scope > .callout-content");
      if (content) out.push(...(await this.blocks(content, { ...ctx, para })));
      return out;
    }
    if (tag === "table") return [await this.table(el as HTMLTableElement, ctx)];
    if (tag === "hr") return [new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 1 } }, children: [] })];
    if (el.classList.contains("math-block") || el.classList.contains("mermaid") || tag === "img" || tag === "svg" || tag === "figure") {
      const runs = await this.inlines([el], {});
      return runs.length ? [this.paragraph(runs, ctx, { alignment: el.classList.contains("math-block") || el.classList.contains("mermaid") ? d.AlignmentType.CENTER : undefined })] : [];
    }
    if (el.classList.contains("csl-entry")) return [new d.Paragraph({ style: "VaultBibliography", children: await this.inlines(Array.from(el.childNodes), {}) })];
    if (tag === "details" || tag === "section" || tag === "div" || tag === "article" || tag === "span" || tag === "figure" || tag === "summary" || tag === "tbody") {
      return this.blocks(el, ctx);
    }
    // Unknown block-level element: its text.
    return this.blocks(el, ctx);
  }

  private async list(el: HTMLElement, ctx: BlockCtx): Promise<Block[]> {
    const d = this.d;
    const ordered = el.tagName === "OL";
    const instance = ordered ? ++this.olInstance : 0;
    const level = Math.min(8, ctx.listLevel);
    const out: Block[] = [];
    for (const li of Array.from(el.children)) {
      if (li.tagName !== "LI") continue;
      const numbering = { reference: ordered ? "vault-ol" : "vault-ul", level, instance: ordered ? instance : undefined };
      const inline: Node[] = [];
      const rest: HTMLElement[] = [];
      for (const n of Array.from(li.childNodes)) {
        if (n instanceof Element && !isInline(n)) rest.push(n as HTMLElement);
        else if (!rest.length) inline.push(n);
        else if (n.textContent?.trim()) rest.push(wrapInline(n));
      }
      let first: ParagraphChild[] = [];
      const checkbox = li.querySelector<HTMLInputElement>(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
      if (inline.some((n) => n.textContent?.trim() || n instanceof HTMLImageElement)) {
        first = await this.inlines(inline, {});
      } else if (rest[0]?.tagName === "P") {
        first = await this.inlines(Array.from(rest.shift()!.childNodes), {});
      }
      if (checkbox && !first.length) first = [new d.TextRun(checkbox.checked ? "☑ " : "☐ ")];
      out.push(new d.Paragraph({ ...ctx.para, numbering, children: first } as Docx.IParagraphOptions));
      for (const child of rest) {
        const inner = { ...ctx, listLevel: ctx.listLevel + 1, para: { ...ctx.para, indent: { left: 720 * (level + 1) } } };
        if (child.tagName === "UL" || child.tagName === "OL") out.push(...(await this.list(child, { ...ctx, listLevel: ctx.listLevel + 1 })));
        else out.push(...(await this.block(child, inner)));
      }
    }
    return out;
  }

  private async table(el: HTMLTableElement, ctx: BlockCtx): Promise<Docx.Table> {
    const d = this.d;
    const rows: Docx.TableRow[] = [];
    const border = { style: d.BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
    for (const tr of Array.from(el.querySelectorAll<HTMLTableRowElement>(":scope > thead > tr, :scope > tbody > tr, :scope > tr"))) {
      const header = tr.parentElement?.tagName === "THEAD" || Array.from(tr.cells).every((c) => c.tagName === "TH");
      const cells = Array.from(tr.cells).map(async (cell) => {
        const align = (cell.getAttribute("align") ?? cell.style.textAlign) || "";
        const alignment = align === "center" ? d.AlignmentType.CENTER : align === "right" ? d.AlignmentType.RIGHT : undefined;
        const paras = header
          ? [new d.Paragraph({ alignment, children: await this.inlines(Array.from(cell.childNodes), { bold: true }) })]
          : await this.blocks(cell, { ...ctx, inTable: true, para: { alignment } });
        return new d.TableCell({
          children: paras.length ? paras : [new d.Paragraph("")],
          columnSpan: cell.colSpan > 1 ? cell.colSpan : undefined,
          rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
          shading: header ? { type: d.ShadingType.CLEAR, fill: "F2F2F2", color: "auto" } : undefined,
          margins: { top: 40, bottom: 40, left: 80, right: 80 },
        });
      });
      rows.push(new d.TableRow({ tableHeader: header, children: await Promise.all(cells) }));
    }
    return new d.Table({ rows, width: { size: 100, type: d.WidthType.PERCENTAGE }, borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border } });
  }

  // ---- inlines -----------------------------------------------------------------

  private async inlines(nodes: Node[], fmt: Fmt): Promise<ParagraphChild[]> {
    const out: ParagraphChild[] = [];
    for (const n of nodes) out.push(...(await this.inline(n, fmt)));
    return out;
  }

  private run(text: string, fmt: Fmt): Docx.TextRun {
    return new this.d.TextRun({
      text,
      bold: fmt.bold,
      italics: fmt.italics,
      strike: fmt.strike,
      highlight: fmt.highlight ? "yellow" : undefined,
      font: fmt.code ? MONO : undefined,
      shading: fmt.code ? { type: this.d.ShadingType.CLEAR, fill: "F2F2F2", color: "auto" } : undefined,
      superScript: fmt.superScript,
      subScript: fmt.subScript,
      underline: fmt.underline || fmt.link ? {} : undefined,
      color: fmt.link ? "1A61D6" : fmt.color,
    });
  }

  private async inline(node: Node, fmt: Fmt): Promise<ParagraphChild[]> {
    const d = this.d;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\s*\n\s*/g, " ");
      return text ? [this.run(text, fmt)] : [];
    }
    if (!(node instanceof Element)) return [];
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const kids = () => this.inlines(Array.from(el.childNodes), fmt);
    switch (tag) {
      case "strong":
      case "b":
        return this.inlines(Array.from(el.childNodes), { ...fmt, bold: true });
      case "em":
      case "i":
        return this.inlines(Array.from(el.childNodes), { ...fmt, italics: true });
      case "del":
      case "s":
        return this.inlines(Array.from(el.childNodes), { ...fmt, strike: true });
      case "u":
      case "ins":
        return this.inlines(Array.from(el.childNodes), { ...fmt, underline: true });
      case "mark":
        return this.inlines(Array.from(el.childNodes), { ...fmt, highlight: true });
      case "code":
      case "kbd":
        return [this.run(el.textContent ?? "", { ...fmt, code: true })];
      case "sub":
        return this.inlines(Array.from(el.childNodes), { ...fmt, subScript: true });
      case "br":
        return [new d.TextRun({ text: "", break: 1 })];
      case "input":
        return (el as HTMLInputElement).type === "checkbox" ? [this.run((el as HTMLInputElement).checked ? "☑ " : "☐ ", fmt)] : [];
      case "button":
      case "script":
      case "style":
        return [];
      case "img":
        return this.image(el as HTMLImageElement);
      case "svg":
        return this.svg(el as unknown as SVGSVGElement);
    }
    if (tag === "sup") {
      if (el.classList.contains("footnote-ref")) return this.footnoteRef(el, fmt);
      return this.inlines(Array.from(el.childNodes), { ...fmt, superScript: true });
    }
    if (tag === "mjx-container") {
      const svg = el.querySelector("svg");
      return svg ? this.svg(svg) : [];
    }
    if (tag === "a") {
      const a = el as HTMLAnchorElement;
      if (a.classList.contains("footnote-backref")) return [];
      const href = a.getAttribute("href") ?? "";
      if (a.classList.contains("internal-link")) {
        const anchor = this.internalAnchor(a);
        const children = await this.inlines(Array.from(el.childNodes), { ...fmt, link: !!anchor });
        return anchor ? [new d.InternalHyperlink({ anchor, children })] : await kids();
      }
      if (/^(https?|mailto|tel):/i.test(href)) {
        return [new d.ExternalHyperlink({ link: href, children: await this.inlines(Array.from(el.childNodes), { ...fmt, link: true }) })];
      }
      return kids();
    }
    if (el.classList.contains("math") || el.classList.contains("mermaid")) {
      const svg = el.querySelector("svg");
      if (svg) return this.svg(svg);
      return [this.run(el.textContent ?? "", { ...fmt, code: true })];
    }
    if (el.classList.contains("callout-icon")) return [];
    return kids();
  }

  private internalAnchor(a: HTMLAnchorElement): string | null {
    const href = a.getAttribute("data-href") ?? "";
    const hash = href.indexOf("#");
    const path = hash >= 0 ? href.slice(0, hash) : href;
    const sub = hash >= 0 ? href.slice(hash + 1) : "";
    let note: RenderedNote | undefined = this.note;
    if (path) {
      const app = (globalThis as { app?: any }).app;
      const target = app?.metadataCache?.getFirstLinkpathDest?.(path, this.note.file.path);
      note = this.notes.find((n) => n.file.path === target?.path);
    }
    if (!note) return null;
    const heads = Array.from(note.viewEl.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
    const h = sub && !sub.startsWith("^") ? heads.find((x) => (x.getAttribute("data-heading") ?? x.textContent) === sub) : path ? heads[0] : undefined;
    return h ? (this.bookmarkFor.get(h) ?? null) : null;
  }

  private async footnoteRef(sup: HTMLElement, fmt: Fmt): Promise<ParagraphChild[]> {
    const d = this.d;
    const link = sup.querySelector("a");
    const id = (link?.getAttribute("href") ?? "").replace(/^#/, "") || (sup.getAttribute("data-footnote-id") ?? "").replace(/^fnref/, "fn");
    const root = sup.closest(".vault-export-note") ?? this.note.viewEl;
    const li = Array.from(root.querySelectorAll<HTMLElement>(".footnotes li")).find((x) => x.id === id || x.getAttribute("data-footnote-id") === id);
    if (!li) return this.inlines(Array.from(sup.childNodes), { ...fmt, superScript: true });
    let n = this.footnoteIds.get(li);
    if (!n) {
      this.footnoteSources.push(li);
      n = this.footnoteSources.length;
      this.footnoteIds.set(li, n);
    }
    return [new d.FootnoteReferenceRun(n)];
  }

  private async image(img: HTMLImageElement): Promise<ParagraphChild[]> {
    const d = this.d;
    const bytes = await imageBytes(img);
    if (!bytes) return img.alt ? [new d.TextRun(`[${img.alt}]`)] : [];
    let { width, height } = bytes;
    if (width > MAX_IMAGE_WIDTH) {
      height = Math.round((height * MAX_IMAGE_WIDTH) / width);
      width = MAX_IMAGE_WIDTH;
    }
    const kind = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp" } as Record<string, "png" | "jpg" | "gif" | "bmp">)[bytes.mime];
    let data = bytes.data;
    let type = kind;
    if (!type) {
      const png = await rasterise(dataUrl(bytes.data, bytes.mime), width, height, 2);
      if (!png) return img.alt ? [new d.TextRun(`[${img.alt}]`)] : [];
      data = png;
      type = "png";
    }
    return [new d.ImageRun({ type, data, transformation: { width, height }, altText: { id: String(++this.drawingSeq), name: img.alt || `Picture ${this.drawingSeq}`, description: img.alt, title: img.alt } })];
  }

  private async svg(svg: SVGSVGElement): Promise<ParagraphChild[]> {
    const { markup, width, height } = standaloneSvg(svg);
    const png = await svgToPng(markup, width, height, 3, PRINT_TEXT);
    if (!png) return [];
    let w = width;
    let h = height;
    if (w > MAX_IMAGE_WIDTH) {
      h = Math.round((h * MAX_IMAGE_WIDTH) / w);
      w = MAX_IMAGE_WIDTH;
    }
    return [new this.d.ImageRun({ type: "png", data: png, transformation: { width: w, height: h }, altText: { id: String(++this.drawingSeq), name: `Picture ${this.drawingSeq}` } })];
  }
}

const INLINE_TAGS = new Set(["a", "abbr", "b", "br", "code", "del", "em", "i", "img", "input", "kbd", "label", "mark", "s", "small", "span", "strong", "sub", "sup", "u", "ins", "mjx-container", "svg", "time", "q", "cite"]);

function isInline(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "span" && (el.classList.contains("internal-embed") || el.classList.contains("math-block"))) {
    return !el.querySelector("div, p, table, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6");
  }
  return INLINE_TAGS.has(tag);
}

function wrapInline(n: Node): HTMLElement {
  const p = document.createElement("p");
  p.appendChild(n.cloneNode(true));
  return p;
}

/** Render `files` and build a .docx Blob. */
export async function exportDocx(app: any, files: TFile[], opts: DocxOptions): Promise<Blob> {
  const d = (await import("./docx-lib")) as unknown as D;
  const session = await renderNotes(app, files, { includeTitle: false, includeProperties: opts.includeProperties, width: 720 });
  try {
    const doc = await new DocxWriter(d, session.notes).build(opts);
    return await d.Packer.toBlob(doc);
  } finally {
    session.dispose();
  }
}
