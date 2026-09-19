/**
 * EPUB 3 export on the store-only zip writer in `publish/zip.ts`.
 *
 *   mimetype                      first entry, stored, no extra field
 *   META-INF/container.xml        → OEBPS/content.opf
 *   OEBPS/content.opf             metadata, manifest, spine
 *   OEBPS/nav.xhtml               EPUB 3 navigation document
 *   OEBPS/toc.ncx                 for EPUB 2 reading systems
 *   OEBPS/style.css
 *   OEBPS/chapter-NNN.xhtml       one per note, or per H1 of a single note
 *   OEBPS/images/…                pictures; math stays inline SVG
 */
import type { TFile } from "../../obsidian/vault/files";
import { buildZip } from "../publish/zip";
import { imageBytes, rasterise, dataUrl, standaloneSvg } from "./portable";
import { assignHeadingIds, renderNotes, type RenderedNote } from "./render";

export interface EpubOptions {
  title?: string;
  author?: string;
  language?: string;
  includeProperties: boolean;
}

interface Chapter {
  id: string;
  href: string;
  title: string;
  nodes: Node[];
  headings: { id: string; text: string; level: number }[];
  hasSvg: boolean;
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";

const EPUB_CSS = `body{font-family:serif;line-height:1.5;margin:0 5%}
h1,h2,h3,h4,h5,h6{font-family:sans-serif;line-height:1.25;page-break-after:avoid}
pre{font-family:monospace;font-size:0.85em;white-space:pre-wrap;background:#f4f4f4;padding:0.6em;border-radius:3px}
code{font-family:monospace;font-size:0.9em}
blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #bbb;color:#444}
table{border-collapse:collapse;margin:1em 0}th,td{border:1px solid #aaa;padding:0.25em 0.5em}th{background:#eee}
img,svg{max-width:100%;height:auto}
mark{background:#fff3a3}
.callout{margin:1em 0;padding:0.5em 0.8em;border-left:4px solid #448aff;background:#eef4ff}
.callout-title{font-weight:bold;margin-bottom:0.3em}
.math-block{text-align:center;margin:1em 0}
.footnotes{font-size:0.9em;border-top:1px solid #ccc;margin-top:2em}
.csl-entry{margin:0 0 0.5em 2em;text-indent:-2em}
.task-list-item{list-style:none}
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const KEEP_ATTRS = new Set(["id", "class", "href", "src", "alt", "title", "width", "height", "colspan", "rowspan", "lang", "dir", "start", "type", "checked", "disabled", "style", "role"]);

function uuid(): string {
  return crypto.randomUUID?.() ?? "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16));
}

class EpubBuilder {
  private images: { path: string; data: Uint8Array; mime: string; id: string }[] = [];
  private chapters: Chapter[] = [];
  private headingChapter = new Map<Element, Chapter>();

  constructor(
    private app: any,
    private notes: RenderedNote[],
    private opts: EpubOptions,
  ) {}

  async build(): Promise<Blob> {
    this.splitChapters();
    await this.prepareMedia();
    this.fixLinks();
    const bookId = `urn:uuid:${uuid()}`;
    const first = this.notes[0]!;
    const fm = first.frontmatter ?? {};
    const title = this.opts.title || (this.notes.length === 1 ? first.title : this.app.vault.getName());
    const author = this.opts.author || [fm.author, fm.authors].flat().filter((a) => typeof a === "string").join(", ");
    const lang = this.opts.language || (typeof fm.lang === "string" ? fm.lang : typeof fm.language === "string" ? fm.language : "") || document.documentElement.lang || "en";
    const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");

    const files: { path: string; data: Uint8Array | string }[] = [
      { path: "mimetype", data: "application/epub+zip" },
      {
        path: "META-INF/container.xml",
        data: `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>\n`,
      },
      { path: "OEBPS/style.css", data: EPUB_CSS },
    ];
    for (const ch of this.chapters) files.push({ path: `OEBPS/${ch.href}`, data: this.chapterXhtml(ch, lang) });
    files.push({ path: "OEBPS/nav.xhtml", data: this.nav(title, lang) });
    files.push({ path: "OEBPS/toc.ncx", data: this.ncx(bookId, title) });
    for (const img of this.images) files.push({ path: `OEBPS/${img.path}`, data: img.data });

    const manifest = [
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
      `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
      `<item id="css" href="style.css" media-type="text/css"/>`,
      ...this.chapters.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"${c.hasSvg ? ' properties="svg"' : ""}/>`),
      ...this.images.map((i) => `<item id="${i.id}" href="${i.path}" media-type="${i.mime}"/>`),
    ];
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${esc(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${bookId}</dc:identifier>
    <dc:title>${esc(title)}</dc:title>
    <dc:language>${esc(lang)}</dc:language>
${author ? `    <dc:creator>${esc(author)}</dc:creator>\n` : ""}    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifest.join("\n    ")}
  </manifest>
  <spine toc="ncx">
    ${this.chapters.map((c) => `<itemref idref="${c.id}"/>`).join("\n    ")}
  </spine>
</package>
`;
    files.splice(3, 0, { path: "OEBPS/content.opf", data: opf });
    return buildZip(files);
  }

  /** One chapter per note; a single note with several H1s splits at each H1. */
  private splitChapters() {
    const used = new Set<string>();
    const add = (title: string, nodes: Node[]) => {
      const n = this.chapters.length + 1;
      const ch: Chapter = { id: `chapter-${n}`, href: `chapter-${String(n).padStart(3, "0")}.xhtml`, title, nodes, headings: [], hasSvg: false };
      this.chapters.push(ch);
      return ch;
    };
    for (const note of this.notes) {
      assignHeadingIds(note.viewEl, "", used);
      const body = note.bodyEl;
      const footnotes = body.querySelector(":scope > section.footnotes, :scope > .footnotes");
      const blocks = Array.from(body.childNodes).filter((n) => n !== footnotes);
      const h1s = blocks.filter((n) => n instanceof HTMLElement && n.tagName === "H1");
      const props = this.opts.includeProperties ? note.viewEl.querySelector(":scope > .vault-export-properties") : null;
      if (this.notes.length === 1 && h1s.length > 1) {
        let current: Node[] = [];
        let title = note.title;
        const flush = () => {
          if (current.some((n) => n.textContent?.trim())) add(title, current);
          current = [];
        };
        for (const n of blocks) {
          if (n instanceof HTMLElement && n.tagName === "H1") {
            flush();
            title = n.textContent ?? note.title;
          }
          current.push(n);
        }
        if (footnotes) current.push(footnotes);
        flush();
        if (props) this.chapters[0]?.nodes.unshift(props);
      } else {
        const heading = document.createElement("h1");
        heading.textContent = note.title;
        heading.id = `title-${this.chapters.length + 1}`;
        const firstIsTitle = h1s.length === 1 && blocks.find((n) => n instanceof HTMLElement) === h1s[0];
        add(note.title, [...(firstIsTitle ? [] : [heading]), ...(props ? [props] : []), ...blocks, ...(footnotes ? [footnotes] : [])]);
      }
    }
    for (const ch of this.chapters) {
      for (const n of ch.nodes) {
        if (!(n instanceof HTMLElement)) continue;
        const heads = n.matches("h1,h2,h3,h4,h5,h6") ? [n] : Array.from(n.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
        for (const h of heads) {
          if (h.closest(".markdown-embed, .callout")) continue;
          ch.headings.push({ id: h.id, text: h.textContent ?? "", level: Number(h.tagName[1]) });
          this.headingChapter.set(h, ch);
        }
      }
    }
  }

  private async prepareMedia() {
    let counter = 0;
    for (const ch of this.chapters) {
      for (const node of ch.nodes) {
        if (!(node instanceof HTMLElement)) continue;
        // Inline math and diagrams: self-contained SVG.
        for (const svg of Array.from(node.querySelectorAll<SVGSVGElement>("mjx-container svg, .mermaid svg"))) {
          if (svg.parentElement?.closest("svg")) continue;
          const { el } = standaloneSvg(svg);
          el.removeAttribute("style");
          el.setAttribute("style", "vertical-align:middle");
          (svg.closest("mjx-container") ?? svg).replaceWith(el);
          ch.hasSvg = true;
        }
        node.querySelectorAll("svg").forEach((s) => {
          if (!s.parentElement?.closest("svg") && !s.hasAttribute("xmlns")) s.remove(); // UI icons
          else ch.hasSvg = true;
        });
        for (const img of Array.from(node.querySelectorAll<HTMLImageElement>("img"))) {
          const bytes = await imageBytes(img);
          if (!bytes) {
            img.replaceWith(document.createTextNode(img.alt ? `[${img.alt}]` : ""));
            continue;
          }
          let { data, mime } = bytes;
          if (!["image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp"].includes(mime)) {
            const png = await rasterise(dataUrl(data, mime), bytes.width, bytes.height, 1);
            if (!png) continue;
            data = png;
            mime = "image/png";
          }
          const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp" }[mime];
          const path = `images/image-${++counter}.${ext}`;
          this.images.push({ path, data, mime, id: `img-${counter}` });
          const fresh = document.createElement("img");
          fresh.setAttribute("src", path);
          fresh.setAttribute("alt", img.alt || "");
          if (bytes.width) fresh.setAttribute("width", String(bytes.width));
          const embed = img.closest(".internal-embed");
          if (embed && embed !== node && node.contains(embed)) embed.replaceWith(fresh);
          else img.replaceWith(fresh);
        }
      }
    }
  }

  private fixLinks() {
    for (const ch of this.chapters) {
      for (const node of ch.nodes) {
        if (!(node instanceof HTMLElement)) continue;
        node.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => {
          if (a.classList.contains("internal-link")) {
            const href = a.getAttribute("data-href") ?? "";
            const hash = href.indexOf("#");
            const path = hash >= 0 ? href.slice(0, hash) : href;
            const sub = hash >= 0 ? href.slice(hash + 1) : "";
            let target: Chapter | undefined;
            let anchor = "";
            const note = path ? this.notes.find((n) => n.file.path === this.app.metadataCache.getFirstLinkpathDest(path, n.file.path)?.path) : this.notes.find((n) => n.viewEl.contains(a));
            if (note) {
              const heads = Array.from(note.viewEl.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
              const h = sub ? heads.find((x) => (x.getAttribute("data-heading") ?? x.textContent) === sub) : undefined;
              if (h) {
                target = this.headingChapter.get(h);
                anchor = h.id;
              } else target = this.chapters.find((c) => c.nodes.some((n) => note.bodyEl.contains(n) || n === note.bodyEl));
            }
            if (target) a.setAttribute("href", `${target.href}${anchor ? `#${anchor}` : ""}`);
            else {
              a.replaceWith(...Array.from(a.childNodes));
              return;
            }
          } else if (a.classList.contains("tag")) {
            a.replaceWith(document.createTextNode(a.textContent ?? ""));
            return;
          }
          const href = a.getAttribute("href") ?? "";
          if (href.startsWith("#")) {
            const id = href.slice(1);
            const owner = this.chapters.find((c) => c.nodes.some((n) => n instanceof Element && (n.id === id || n.querySelector(`[id="${CSS.escape(id)}"]`))));
            if (owner) a.setAttribute("href", `${owner.href}#${id}`);
          }
        });
      }
    }
  }

  private serialize(node: Node): string {
    const clone = node.cloneNode(true);
    const scrub = (n: Node) => {
      if (!(n instanceof Element)) return;
      if (n.namespaceURI === XHTML_NS) {
        const align = n.getAttribute("align");
        if (align && /^(TD|TH)$/.test(n.tagName)) (n as HTMLElement).style.textAlign = align;
        for (const attr of Array.from(n.attributes)) if (!KEEP_ATTRS.has(attr.name)) n.removeAttribute(attr.name);
        if (n.tagName === "INPUT") {
          n.replaceWith(document.createTextNode((n as HTMLInputElement).checked ? "☑ " : "☐ "));
          return;
        }
        if (n.tagName === "BUTTON") {
          n.remove();
          return;
        }
      }
      for (const c of Array.from(n.childNodes)) scrub(c);
    };
    const holder = document.createElement("div");
    holder.appendChild(clone);
    scrub(clone);
    if (clone instanceof Element && clone.matches(".footnotes, section.footnotes")) {
      clone.setAttribute("epub:type", "footnotes");
    }
    return Array.from(holder.childNodes)
      .map((c) => new XMLSerializer().serializeToString(c))
      .join("")
      .replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, "");
  }

  private chapterXhtml(ch: Chapter, lang: string): string {
    const body = ch.nodes.map((n) => this.serialize(n)).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(lang)}" xml:lang="${esc(lang)}">
<head>
<meta charset="utf-8"/>
<title>${esc(ch.title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
<section epub:type="chapter">
${body}
</section>
</body>
</html>
`;
  }

  private nav(title: string, lang: string): string {
    const items = this.chapters
      .map((c) => {
        const sub = c.headings.filter((h) => h.level === 2);
        const inner = sub.length ? `\n<ol>${sub.map((h) => `<li><a href="${c.href}#${esc(h.id)}">${esc(h.text)}</a></li>`).join("")}</ol>` : "";
        return `<li><a href="${c.href}">${esc(c.title)}</a>${inner}</li>`;
      })
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(lang)}" xml:lang="${esc(lang)}">
<head><meta charset="utf-8"/><title>${esc(title)}</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1>
<ol>
${items}
</ol>
</nav>
</body>
</html>
`;
  }

  private ncx(bookId: string, title: string): string {
    let order = 0;
    const points = this.chapters.map((c) => `<navPoint id="nav-${++order}" playOrder="${order}"><navLabel><text>${esc(c.title)}</text></navLabel><content src="${c.href}"/></navPoint>`).join("\n    ");
    return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${bookId}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
  <docTitle><text>${esc(title)}</text></docTitle>
  <navMap>
    ${points}
  </navMap>
</ncx>
`;
  }
}

export async function exportEpub(app: any, files: TFile[], opts: EpubOptions): Promise<Blob> {
  const session = await renderNotes(app, files, { includeProperties: opts.includeProperties, width: 720 });
  try {
    return await new EpubBuilder(app, session.notes, opts).build();
  } finally {
    session.dispose();
  }
}
