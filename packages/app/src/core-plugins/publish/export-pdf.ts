/**
 * Export to PDF (`workspace:export-pdf`), with Better Export PDF's options.
 *
 * Notes are rendered as in Reading view into `body > .print`; print CSS hides
 * everything else and the browser's print dialog ("Save as PDF") does the rest.
 * Page size and margins come from `@page`. Headers, footers and page numbers
 * are CSS page-margin boxes (`@top-left` … `@bottom-right` with
 * `counter(page)` / `counter(pages)`), which Chromium 131+ prints; other
 * browsers ignore them, so the modal hides those options there.
 *
 * Better Export PDF's frontmatter `headerTemplate` / `footerTemplate`
 * (`<span class="title|date|pageNumber|totalPages">`) are honoured: margin
 * boxes take text only, so the spans become text and counters.
 */
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import type { TFile } from "../../obsidian/vault/files";
import { assignHeadingIds, renderNotes } from "../export/render";

export type PageSize = "A4" | "Letter" | "Legal" | "A3" | "A5" | "Tabloid";
export type MarginPreset = "default" | "none" | "narrow" | "wide" | "custom";

export interface PdfOptions {
  pageSize: PageSize;
  landscape: boolean;
  margin: MarginPreset;
  /** Custom margins in millimetres: top, right, bottom, left. */
  customMargins: [number, number, number, number];
  includeTitle: boolean;
  includeProperties: boolean;
  toc: boolean;
  pageNumbers: boolean;
  /** `left | center | right`, with {{title}} {{date}} {{page}} {{pages}} {{file}}. */
  header: string;
  footer: string;
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = {
  pageSize: "A4",
  landscape: false,
  margin: "default",
  customMargins: [20, 18, 20, 18],
  includeTitle: true,
  includeProperties: false,
  toc: false,
  pageNumbers: true,
  header: "",
  footer: "",
};

const MARGINS: Record<Exclude<MarginPreset, "custom">, [number, number, number, number]> = {
  default: [18, 16, 18, 16],
  none: [0, 0, 0, 0],
  narrow: [10, 10, 10, 10],
  wide: [25, 30, 25, 30],
};

const STYLE_ID = "vault-print-style";
let printing = false;

/** Chromium 131+ prints `@page` margin boxes; nothing else does yet. */
export function supportsMarginBoxes(): boolean {
  const brands = (navigator as unknown as { userAgentData?: { brands?: { brand: string; version: string }[] } }).userAgentData?.brands;
  const chromium = brands?.find((b) => b.brand === "Chromium");
  if (chromium) return Number(chromium.version) >= 131;
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent);
  return !!m && Number(m[1]) >= 131 && !/Firefox\//.test(navigator.userAgent);
}

const cssString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;

/** Better Export PDF's HTML templates → our text template. */
export function fromBetterExportTemplate(html: string): string {
  return html
    .replace(/<span[^>]*class=["'][^"']*\bpageNumber\b[^"']*["'][^>]*>\s*<\/span>/gi, "{{page}}")
    .replace(/<span[^>]*class=["'][^"']*\btotalPages\b[^"']*["'][^>]*>\s*<\/span>/gi, "{{pages}}")
    .replace(/<span[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>\s*<\/span>/gi, "{{title}}")
    .replace(/<span[^>]*class=["'][^"']*\bdate\b[^"']*["'][^>]*>\s*<\/span>/gi, "{{date}}")
    .replace(/<span[^>]*class=["'][^"']*\burl\b[^"']*["'][^>]*>\s*<\/span>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

/** A template part → CSS `content` value. */
export function templateToContent(part: string, vars: { title: string; date: string; file: string }): string {
  const out: string[] = [];
  const re = /\{\{\s*(title|date|page|pages|file)\s*\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(part))) {
    if (m.index > last) out.push(cssString(part.slice(last, m.index)));
    const key = m[1]!;
    out.push(key === "page" ? "counter(page)" : key === "pages" ? "counter(pages)" : cssString(vars[key as "title" | "date" | "file"]));
    last = m.index + m[0].length;
  }
  if (last < part.length) out.push(cssString(part.slice(last)));
  return out.join(" ") || '""';
}

function marginBoxes(position: "top" | "bottom", template: string, vars: { title: string; date: string; file: string }): string {
  if (!template.trim()) return "";
  const parts = template.split("|").map((p) => p.trim());
  const [left, center, right] = parts.length === 1 ? ["", parts[0]!, ""] : parts.length === 2 ? [parts[0]!, "", parts[1]!] : [parts[0]!, parts[1]!, parts.slice(2).join("|")];
  const box = (name: string, text: string, align: string) => (text ? `  @${position}-${name} { content: ${templateToContent(text, vars)}; font-size: 9pt; color: #555; text-align: ${align}; font-family: var(--font-text, sans-serif); }\n` : "");
  return box("left", left, "left") + box("center", center, "center") + box("right", right, "right");
}

export function buildPrintCss(opts: PdfOptions, vars: { title: string; date: string; file: string }, frontmatter?: Record<string, unknown> | null): string {
  const [t, r, b, l] = opts.margin === "custom" ? opts.customMargins : MARGINS[opts.margin];
  let header = opts.header;
  let footer = opts.footer;
  if (typeof frontmatter?.headerTemplate === "string") header = fromBetterExportTemplate(frontmatter.headerTemplate);
  if (typeof frontmatter?.footerTemplate === "string") footer = fromBetterExportTemplate(frontmatter.footerTemplate);
  if (opts.pageNumbers && !/\{\{\s*page\s*\}\}/.test(header + footer)) {
    footer = footer.trim() ? `${footer} | {{page}} / {{pages}}` : "{{page}} / {{pages}}";
  }
  const boxes = supportsMarginBoxes() || (globalThis as { __vaultForceMarginBoxes?: boolean }).__vaultForceMarginBoxes ? marginBoxes("top", header, vars) + marginBoxes("bottom", footer, vars) : "";
  return `@page {
  size: ${opts.pageSize} ${opts.landscape ? "landscape" : "portrait"};
  margin: ${t}mm ${r}mm ${b}mm ${l}mm;
${boxes}}
@media print {
  body > .print .vault-pdf-note + .vault-pdf-note { break-before: page; }
  body > .print .vault-export-toc { break-after: page; }
}
`;
}

function buildToc(notes: { title: string; viewEl: HTMLElement }[]): HTMLElement {
  const nav = createEl("nav", { cls: "vault-export-toc" });
  nav.createEl("h1", { text: "Contents" });
  const root = nav.createEl("ol");
  const multi = notes.length > 1;
  for (const note of notes) {
    let parent = root;
    if (multi) {
      const li = root.createEl("li");
      const titleEl = note.viewEl.querySelector<HTMLElement>(".vault-export-title");
      li.createEl("a", { text: note.title, href: titleEl ? `#${titleEl.id}` : undefined });
      parent = li.createEl("ol");
    }
    const stack: { level: number; list: HTMLElement }[] = [{ level: multi ? 1 : 0, list: parent }];
    for (const h of Array.from(note.viewEl.querySelectorAll<HTMLElement>(".markdown-preview-sizer > h1, .markdown-preview-sizer > h2, .markdown-preview-sizer > h3"))) {
      const level = Number(h.tagName[1]);
      while (stack.length > 1 && stack[stack.length - 1]!.level >= level) stack.pop();
      let list = stack[stack.length - 1]!.list;
      if (stack[stack.length - 1]!.level < level - 1 && list.lastElementChild) {
        list = list.lastElementChild.createEl("ol");
      }
      const li = list.createEl("li");
      li.createEl("a", { text: h.textContent ?? "", href: `#${h.id}` });
      stack.push({ level, list: li.createEl("ol") });
    }
  }
  nav.querySelectorAll("ol:empty").forEach((ol) => ol.remove());
  return nav;
}

/**
 * Render `files` into the print container with `opts` and open the print
 * dialog. Returns once the dialog has been opened; cleanup happens on
 * `afterprint`.
 */
export async function printNotes(app: any, files: TFile[], opts: PdfOptions): Promise<void> {
  if (printing || files.length === 0) return;
  printing = true;
  let session: Awaited<ReturnType<typeof renderNotes>> | null = null;
  const styleEl = document.head.createEl("style", { attr: { id: STYLE_ID } });
  const cleanup = () => {
    session?.dispose();
    styleEl.remove();
    document.body.removeClass("is-printing");
    printing = false;
  };
  try {
    session = await renderNotes(app, files, { stageClass: "print", includeTitle: opts.includeTitle || files.length > 1, includeProperties: opts.includeProperties });
    const used = new Set<string>();
    session.notes.forEach((n, i) => {
      n.viewEl.addClass("vault-pdf-note");
      assignHeadingIds(n.viewEl, files.length > 1 ? `n${i + 1}-` : "", used);
    });
    if (opts.toc) session.stage.prepend(buildToc(session.notes));
    // Links inside the document jump to their heading.
    session.stage.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
      const href = a.getAttribute("data-href") ?? "";
      const hash = href.indexOf("#");
      if (hash < 0) return;
      const heading = href.slice(hash + 1);
      const owner = session!.notes.find((n) => n.viewEl.contains(a));
      const target = owner?.viewEl.querySelector<HTMLElement>(`[data-heading="${CSS.escape(heading)}"]`);
      if (target?.id && (hash === 0 || href.slice(0, hash) === owner?.file.basename)) a.setAttribute("href", `#${target.id}`);
    });
    const first = files[0]!;
    const title = files.length > 1 ? (first.parent?.name || app.vault.getName()) : session.notes[0]!.title;
    const moment = (window as unknown as { moment?: (d?: Date) => { format(f: string): string } }).moment;
    const date = moment ? moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10);
    styleEl.textContent = buildPrintCss(opts, { title, date, file: files.length > 1 ? title : first.path }, files.length === 1 ? session.notes[0]!.frontmatter : null);

    document.body.addClass("is-printing");
    const prevTitle = document.title;
    document.title = title;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.title = prevTitle;
      window.removeEventListener("afterprint", finish);
      cleanup();
    };
    window.addEventListener("afterprint", finish);
    window.print();
    // Some browsers never fire afterprint (or print() returns immediately).
    setTimeout(finish, 60_000);
  } catch (e) {
    cleanup();
    new Notice(`Export to PDF failed: ${(e as Error)?.message ?? e}`);
  }
}

export class PdfExportModal extends Modal {
  constructor(
    app: any,
    private files: TFile[],
    private options: PdfOptions,
    private save: () => void,
  ) {
    super(app);
    this.modalEl.addClass("mod-pdf-export", "vault-export-modal");
  }

  override onOpen() {
    const o = this.options;
    const files = this.files;
    this.setTitle(files.length === 1 ? "Export to PDF" : `Export ${files.length} notes to PDF`);
    const { contentEl } = this;
    const changed = () => this.save();

    new Setting(contentEl)
      .setName("Include file name as title")
      .addToggle((t) => t.setValue(o.includeTitle).onChange((v) => ((o.includeTitle = v), changed())));
    new Setting(contentEl)
      .setName("Include properties")
      .setDesc("Print the note's properties as a table under the title.")
      .addToggle((t) => t.setValue(o.includeProperties).onChange((v) => ((o.includeProperties = v), changed())));
    new Setting(contentEl)
      .setName("Table of contents")
      .setDesc("A first page listing headings, each one a link.")
      .addToggle((t) => t.setValue(o.toc).onChange((v) => ((o.toc = v), changed())));
    new Setting(contentEl).setName("Page size").addDropdown((d) => {
      for (const s of ["A4", "Letter", "Legal", "A3", "A5", "Tabloid"]) d.addOption(s, s);
      d.setValue(o.pageSize).onChange((v) => ((o.pageSize = v as PageSize), changed()));
    });
    new Setting(contentEl).setName("Landscape").addToggle((t) => t.setValue(o.landscape).onChange((v) => ((o.landscape = v), changed())));
    const custom = createDiv({ cls: "vault-pdf-custom-margins" });
    new Setting(contentEl).setName("Margins").addDropdown((d) => {
      d.addOptions({ default: "Default", none: "None", narrow: "Narrow", wide: "Wide", custom: "Custom" });
      d.setValue(o.margin).onChange((v) => {
        o.margin = v as MarginPreset;
        custom.toggle(v === "custom");
        changed();
      });
    });
    contentEl.appendChild(custom);
    const labels = ["Top", "Right", "Bottom", "Left"];
    labels.forEach((label, i) => {
      const wrap = custom.createEl("label", { text: label });
      const input = wrap.createEl("input", { type: "number", attr: { min: "0", max: "80", step: "1", "aria-label": `${label} margin in millimetres` } });
      input.value = String(o.customMargins[i]);
      input.addEventListener("change", () => {
        o.customMargins[i] = Math.max(0, Math.min(80, Number(input.value) || 0));
        changed();
      });
      wrap.appendText(" mm");
    });
    custom.toggle(o.margin === "custom");

    if (supportsMarginBoxes()) {
      new Setting(contentEl)
        .setName("Page numbers")
        .setDesc("“1 / 3” in the footer.")
        .addToggle((t) => t.setValue(o.pageNumbers).onChange((v) => ((o.pageNumbers = v), changed())));
      const tokens = "Use {{title}}, {{date}}, {{page}} and {{pages}}. Separate left | center | right with a bar.";
      new Setting(contentEl)
        .setName("Header")
        .setDesc(tokens)
        .addText((t) => t.setPlaceholder("{{title}} | | {{date}}").setValue(o.header).onChange((v) => ((o.header = v), changed())));
      new Setting(contentEl)
        .setName("Footer")
        .addText((t) => t.setPlaceholder("| {{page}} / {{pages}} |").setValue(o.footer).onChange((v) => ((o.footer = v), changed())));
    } else {
      contentEl.createEl("p", {
        cls: "setting-item-description vault-export-note-text",
        text: "Headers, footers and page numbers are printed by Chrome, Edge and other Chromium browsers (version 131 or later). In this browser, turn on “Headers and footers” in the print dialog instead.",
      });
    }
    contentEl.createEl("p", {
      cls: "setting-item-description vault-export-note-text",
      text: "Choose “Save as PDF” as the destination in the print dialog. Links and the table of contents stay clickable; whether PDF bookmarks are added is up to the browser.",
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const run = buttons.createEl("button", { cls: "mod-cta", text: "Export to PDF" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    run.addEventListener("click", () => {
      this.close();
      void printNotes(this.app, files, o);
    });
  }

  override onClose() {
    this.contentEl.empty();
  }
}

/** Kept for callers of the old single-note entry point: prints with defaults. */
export async function exportToPdf(app: any, file: TFile, options: PdfOptions = DEFAULT_PDF_OPTIONS): Promise<void> {
  await printNotes(app, [file], options);
}
