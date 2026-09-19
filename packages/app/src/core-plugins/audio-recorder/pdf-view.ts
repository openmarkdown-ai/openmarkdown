/**
 * The `pdf` view: PDF.js pages with a toolbar (page navigation, zoom, find),
 * a thumbnail sidebar, and a selectable text layer.
 *
 *   .pdf-container
 *     .pdf-toolbar
 *     .pdf-content
 *       .pdf-sidebar-container > .pdf-thumbnail-view > .pdf-thumbnail[data-page-number]
 *       .pdf-viewer-container > .pdf-viewer > .page[data-page-number] > canvas + .textLayer
 *
 * Pages render when they scroll near the viewport and release their canvas
 * when they scroll far away, so a 500-page document costs a few canvases.
 * If PDF.js cannot load or render the file the view falls back to the
 * browser's own viewer in an iframe.
 */
import { Component } from "../../obsidian/events";
import { setIcon } from "../../obsidian/ui/icons";
import { loadPdfJs } from "../../obsidian/markdown/loaders";
import { FileView } from "../../obsidian/workspace/view";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import type { TFile } from "../../obsidian/vault/files";
import { parsePdfSubpath } from "./embeds";

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const PAGE_GAP = 12;

interface PageState {
  num: number;
  el: HTMLElement;
  width: number; // unscaled
  height: number;
  renderedScale: number;
  rendering: Promise<void> | null;
  task: { cancel(): void } | null;
  textLayer: { cancel(): void; textDivs: HTMLElement[] } | null;
  visible: boolean;
}

interface PageText {
  text: string;
  offsets: number[]; // start of each item in `text`
  lengths: number[];
}

interface Match {
  page: number;
  start: number;
  end: number;
}

export class PdfViewer extends Component {
  app: any;
  containerEl: HTMLElement;
  toolbarEl!: HTMLElement;
  sidebarEl!: HTMLElement;
  viewerContainerEl!: HTMLElement;
  viewerEl!: HTMLElement;
  pageInputEl!: HTMLInputElement;
  pageCountEl!: HTMLElement;
  findInputEl!: HTMLInputElement;
  findCountEl!: HTMLElement;
  zoomLabelEl!: HTMLElement;

  private pdfjs: any = null;
  private doc: any = null;
  private loadingTask: any = null;
  private pages: PageState[] = [];
  private scale = 1;
  private fitWidth = true;
  private observer: IntersectionObserver | null = null;
  private thumbObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pendingPage: number | null = null;
  private currentPage = 1;
  private texts = new Map<number, Promise<PageText>>();
  private matches: Match[] = [];
  private matchIndex = -1;
  private query = "";
  private generation = 0;
  private keysInstalled = false;

  constructor(app: any, containerEl: HTMLElement) {
    super();
    this.app = app;
    this.containerEl = containerEl;
  }

  override onunload(): void {
    this.close();
  }

  private close() {
    this.generation++;
    this.observer?.disconnect();
    this.thumbObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.observer = this.thumbObserver = this.resizeObserver = null;
    for (const p of this.pages) {
      p.task?.cancel();
      p.textLayer?.cancel();
    }
    this.pages = [];
    this.texts.clear();
    this.matches = [];
    this.matchIndex = -1;
    try {
      void this.loadingTask?.destroy?.();
    } catch {
      /* already gone */
    }
    this.loadingTask = null;
    this.doc = null;
    this.containerEl.empty();
  }

  async open(file: TFile): Promise<void> {
    this.close();
    const gen = this.generation;
    this.buildChrome();
    try {
      this.pdfjs = await loadPdfJs();
      const buf: ArrayBuffer = await this.app.vault.readBinary(file);
      if (gen !== this.generation) return;
      this.loadingTask = this.pdfjs.getDocument({ data: new Uint8Array(buf) });
      this.doc = await this.loadingTask.promise;
      if (gen !== this.generation) return;
      await this.buildPages();
    } catch (e) {
      if (gen !== this.generation) return;
      console.error("PDF.js failed; using the browser viewer", e);
      this.fallback(file);
    }
  }

  private fallback(file: TFile) {
    this.close();
    this.containerEl.addClass("pdf-container", "mod-fallback");
    const page = this.pendingPage ? `#page=${this.pendingPage}` : "";
    this.containerEl.createEl("iframe", { cls: "vault-pdf-fallback-frame", attr: { src: this.app.vault.getResourcePath(file) + page, title: file.name } });
  }

  private button(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const btn = parent.createEl("button", { cls: "clickable-icon pdf-toolbar-button", attr: { "aria-label": label } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private buildChrome() {
    const root = this.containerEl;
    root.empty();
    root.removeClass("mod-fallback");
    root.addClass("pdf-container");
    root.setAttr("tabindex", "-1");

    const toolbar = (this.toolbarEl = root.createDiv({ cls: "pdf-toolbar" }));
    const left = toolbar.createDiv({ cls: "pdf-toolbar-left" });
    this.button(left, "lucide-panel-left", "Toggle sidebar", () => root.toggleClass("is-sidebar-open", !root.hasClass("is-sidebar-open")));
    this.button(left, "lucide-chevron-up", "Previous page", () => this.goToPage(this.currentPage - 1));
    this.button(left, "lucide-chevron-down", "Next page", () => this.goToPage(this.currentPage + 1));
    this.pageInputEl = left.createEl("input", { cls: "pdf-page-input", type: "text", attr: { inputmode: "numeric", "aria-label": "Page" } });
    this.pageInputEl.value = "1";
    this.pageCountEl = left.createSpan({ cls: "pdf-page-count", text: "of 0" });
    this.pageInputEl.addEventListener("keydown", (evt) => {
      if (evt.key !== "Enter") return;
      evt.preventDefault();
      const n = parseInt(this.pageInputEl.value, 10);
      if (Number.isFinite(n)) this.goToPage(n);
      else this.pageInputEl.value = String(this.currentPage);
    });
    this.pageInputEl.addEventListener("focus", () => this.pageInputEl.select());

    const middle = toolbar.createDiv({ cls: "pdf-toolbar-middle" });
    this.button(middle, "lucide-zoom-out", "Zoom out", () => this.setScale(this.scale / 1.2));
    this.zoomLabelEl = middle.createSpan({ cls: "pdf-zoom-label", text: "100%" });
    this.button(middle, "lucide-zoom-in", "Zoom in", () => this.setScale(this.scale * 1.2));
    this.button(middle, "lucide-move-horizontal", "Fit width", () => {
      this.fitWidth = true;
      this.applyFitWidth();
    });

    const right = toolbar.createDiv({ cls: "pdf-toolbar-right" });
    const find = right.createDiv({ cls: "pdf-findbar search-input-container" });
    this.findInputEl = find.createEl("input", { type: "search", cls: "pdf-find-input", attr: { placeholder: "Find in document", spellcheck: "false" } });
    this.findCountEl = right.createSpan({ cls: "pdf-find-count" });
    this.button(right, "lucide-arrow-up", "Previous match", () => this.findStep(-1));
    this.button(right, "lucide-arrow-down", "Next match", () => this.findStep(1));
    let findTimer: number | null = null;
    this.findInputEl.addEventListener("input", () => {
      if (findTimer !== null) window.clearTimeout(findTimer);
      findTimer = window.setTimeout(() => void this.find(this.findInputEl.value), 200);
    });
    this.findInputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        if (this.findInputEl.value !== this.query) void this.find(this.findInputEl.value);
        else this.findStep(evt.shiftKey ? -1 : 1);
      } else if (evt.key === "Escape" && this.findInputEl.value) {
        evt.preventDefault();
        evt.stopPropagation();
        this.findInputEl.value = "";
        void this.find("");
      }
    });

    const content = root.createDiv({ cls: "pdf-content" });
    this.sidebarEl = content.createDiv({ cls: "pdf-sidebar-container" }).createDiv({ cls: "pdf-thumbnail-view" });
    this.viewerContainerEl = content.createDiv({ cls: "pdf-viewer-container" });
    this.viewerEl = this.viewerContainerEl.createDiv({ cls: "pdf-viewer" });

    if (!this.keysInstalled) {
      this.keysInstalled = true;
      root.addEventListener("keydown", (evt) => this.onKeyDown(evt));
    }
    this.viewerContainerEl.addEventListener("scroll", () => this.updateCurrentPage());
    this.viewerContainerEl.addEventListener(
      "wheel",
      (evt) => {
        if (!evt.ctrlKey && !evt.metaKey) return;
        evt.preventDefault();
        this.setScale(this.scale * (evt.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false },
    );
  }

  private onKeyDown(evt: KeyboardEvent) {
    const root = this.containerEl;
    {
      const mod = evt.metaKey || evt.ctrlKey;
      if (evt.key === "F3" || (mod && evt.key.toLowerCase() === "g")) {
        evt.preventDefault();
        this.findStep(evt.shiftKey ? -1 : 1);
      } else if (mod && evt.key.toLowerCase() === "f") {
        evt.preventDefault();
        this.findInputEl.focus();
        this.findInputEl.select();
      } else if (evt.target === root || evt.target === this.viewerContainerEl) {
        if (evt.key === "PageDown" || (evt.key === "ArrowRight" && !mod)) {
          evt.preventDefault();
          this.goToPage(this.currentPage + 1);
        } else if (evt.key === "PageUp" || (evt.key === "ArrowLeft" && !mod)) {
          evt.preventDefault();
          this.goToPage(this.currentPage - 1);
        }
      }
    }
  }

  private async buildPages() {
    const gen = this.generation;
    const doc = this.doc;
    const count: number = doc.numPages;
    this.pageCountEl.setText(`of ${count}`);
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    if (gen !== this.generation) return;

    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), { root: this.viewerContainerEl, rootMargin: "150% 0px" });
    this.thumbObserver = new IntersectionObserver((entries) => this.onThumbIntersect(entries), { root: this.sidebarEl.parentElement, rootMargin: "100% 0px" });

    for (let n = 1; n <= count; n++) {
      const el = this.viewerEl.createDiv({ cls: "page", attr: { "data-page-number": String(n), "aria-label": `Page ${n}` } });
      el.style.marginBottom = `${PAGE_GAP}px`;
      const state: PageState = { num: n, el, width: vp.width, height: vp.height, renderedScale: 0, rendering: null, task: null, textLayer: null, visible: false };
      this.pages.push(state);
      this.observer.observe(el);

      const thumb = this.sidebarEl.createDiv({ cls: "pdf-thumbnail", attr: { "data-page-number": String(n), "aria-label": `Page ${n}` } });
      thumb.createDiv({ cls: "pdf-thumbnail-image" });
      thumb.createDiv({ cls: "pdf-thumbnail-label", text: String(n) });
      thumb.addEventListener("click", () => this.goToPage(n));
      this.thumbObserver.observe(thumb);
    }

    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitWidth) this.applyFitWidth();
    });
    this.resizeObserver.observe(this.viewerContainerEl);
    this.applyFitWidth();
    if (this.pendingPage) {
      const p = this.pendingPage;
      this.pendingPage = null;
      this.goToPage(p);
    }
  }

  private applyFitWidth() {
    const first = this.pages[0];
    if (!first) return;
    const avail = this.viewerContainerEl.clientWidth - 32;
    if (avail <= 0) return;
    this.setScale(avail / first.width, true);
  }

  setScale(scale: number, keepFit = false) {
    if (!keepFit) this.fitWidth = false;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    if (!this.pages.length) {
      this.scale = scale;
      return;
    }
    const anchor = this.currentPage;
    const container = this.viewerContainerEl;
    const anchorEl = this.pages[anchor - 1]?.el;
    const offsetInPage = anchorEl ? (container.scrollTop - anchorEl.offsetTop) / Math.max(1, anchorEl.offsetHeight) : 0;
    const changed = Math.abs(scale - this.scale) > 0.001;
    this.scale = scale;
    this.zoomLabelEl.setText(`${Math.round(scale * 100)}%`);
    for (const p of this.pages) this.sizePage(p);
    if (anchorEl) container.scrollTop = anchorEl.offsetTop + offsetInPage * anchorEl.offsetHeight;
    if (changed) for (const p of this.pages) if (p.visible) void this.renderPage(p);
  }

  private sizePage(p: PageState) {
    const s = this.scale;
    const el = p.el;
    el.style.width = `${Math.floor(p.width * s)}px`;
    el.style.height = `${Math.floor(p.height * s)}px`;
    el.style.setProperty("--scale-factor", String(s));
    el.style.setProperty("--total-scale-factor", String(s));
    el.style.setProperty("--scale-round-x", "1px");
    el.style.setProperty("--scale-round-y", "1px");
    const canvas = el.querySelector<HTMLCanvasElement>("canvas");
    if (canvas) {
      canvas.style.width = el.style.width;
      canvas.style.height = el.style.height;
    }
  }

  private onIntersect(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      const n = Number((entry.target as HTMLElement).dataset.pageNumber);
      const p = this.pages[n - 1];
      if (!p) continue;
      p.visible = entry.isIntersecting;
      if (entry.isIntersecting) void this.renderPage(p);
      else this.releasePage(p);
    }
  }

  private releasePage(p: PageState) {
    p.task?.cancel();
    p.textLayer?.cancel();
    p.task = null;
    p.textLayer = null;
    p.renderedScale = 0;
    p.el.empty();
  }

  private renderPage(p: PageState): Promise<void> {
    if (p.renderedScale === this.scale) return Promise.resolve();
    if (p.rendering) return p.rendering;
    const gen = this.generation;
    p.rendering = (async () => {
      try {
        const scale = this.scale;
        const page = await this.doc.getPage(p.num);
        if (gen !== this.generation || !p.visible) return;
        const base = page.getViewport({ scale: 1 });
        if (base.width !== p.width || base.height !== p.height) {
          p.width = base.width;
          p.height = base.height;
          this.sizePage(p);
        }
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        const canvas = createEl("canvas");
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
        p.task = task;
        await task.promise;
        p.task = null;
        if (gen !== this.generation || !p.visible) return;
        const textEl = createDiv({ cls: "textLayer" });
        p.el.empty();
        p.el.append(canvas, textEl);
        p.renderedScale = scale;
        const textLayer = new this.pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textEl, viewport });
        p.textLayer = textLayer;
        await textLayer.render();
        if (gen !== this.generation) return;
        this.highlightPage(p);
      } catch (e) {
        if ((e as { name?: string })?.name !== "RenderingCancelledException") console.error(e);
      } finally {
        p.rendering = null;
      }
      if (gen === this.generation && p.visible && p.renderedScale !== this.scale) void this.renderPage(p);
    })();
    return p.rendering;
  }

  private onThumbIntersect(entries: IntersectionObserverEntry[]) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target as HTMLElement;
      this.thumbObserver?.unobserve(el);
      void this.renderThumb(el, Number(el.dataset.pageNumber));
    }
  }

  private async renderThumb(el: HTMLElement, n: number) {
    const gen = this.generation;
    try {
      const page = await this.doc.getPage(n);
      if (gen !== this.generation) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 120 / base.width });
      const dpr = window.devicePixelRatio || 1;
      const canvas = createEl("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      await page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      if (gen !== this.generation) return;
      el.querySelector(".pdf-thumbnail-image")?.replaceChildren(canvas);
    } catch (e) {
      if ((e as { name?: string })?.name !== "RenderingCancelledException") console.error(e);
    }
  }

  goToPage(n: number) {
    if (!this.pages.length) {
      this.pendingPage = n;
      return;
    }
    n = Math.min(this.pages.length, Math.max(1, Math.floor(n)));
    const p = this.pages[n - 1]!;
    this.viewerContainerEl.scrollTop = p.el.offsetTop - 8;
    this.setCurrentPage(n);
  }

  private updateCurrentPage() {
    const top = this.viewerContainerEl.scrollTop + this.viewerContainerEl.clientHeight / 3;
    let lo = 0;
    let hi = this.pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pages[mid]!.el.offsetTop <= top) lo = mid;
      else hi = mid - 1;
    }
    if (this.pages.length) this.setCurrentPage(lo + 1);
  }

  private setCurrentPage(n: number) {
    if (this.currentPage === n && this.pageInputEl.value === String(n)) return;
    this.currentPage = n;
    if (document.activeElement !== this.pageInputEl) this.pageInputEl.value = String(n);
    this.sidebarEl.querySelectorAll(".pdf-thumbnail.is-selected").forEach((el) => el.removeClass("is-selected"));
    const thumb = this.sidebarEl.querySelector<HTMLElement>(`.pdf-thumbnail[data-page-number="${n}"]`);
    if (thumb) {
      thumb.addClass("is-selected");
      if (this.containerEl.hasClass("is-sidebar-open")) thumb.scrollIntoView({ block: "nearest" });
    }
  }

  getCurrentPage(): number {
    return this.currentPage;
  }

  // ---- find ---------------------------------------------------------------------

  private pageText(n: number): Promise<PageText> {
    let t = this.texts.get(n);
    if (!t) {
      t = (async () => {
        const page = await this.doc.getPage(n);
        const content = await page.getTextContent();
        let text = "";
        const offsets: number[] = [];
        const lengths: number[] = [];
        for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
          // Marked-content entries have no `str`; they produce no text div either.
          if (typeof item.str !== "string") continue;
          offsets.push(text.length);
          lengths.push(item.str.length);
          text += item.str;
          if (item.hasEOL) text += "\n";
        }
        return { text, offsets, lengths };
      })();
      this.texts.set(n, t);
    }
    return t;
  }

  async find(query: string) {
    this.query = query;
    const gen = this.generation;
    this.matches = [];
    this.matchIndex = -1;
    if (!query.trim() || !this.doc) {
      this.findCountEl.setText("");
      this.findCountEl.removeClass("mod-warning");
      for (const p of this.pages) this.highlightPage(p);
      return;
    }
    const needle = normalize(query);
    const found: Match[] = [];
    for (let n = 1; n <= this.pages.length; n++) {
      const t = await this.pageText(n);
      if (gen !== this.generation || this.query !== query) return;
      const hay = normalize(t.text);
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + Math.max(1, needle.length))) {
        found.push({ page: n, start: i, end: i + needle.length });
      }
    }
    this.matches = found;
    this.findCountEl.toggleClass("mod-warning", found.length === 0);
    if (found.length === 0) {
      this.findCountEl.setText("No results");
      for (const p of this.pages) this.highlightPage(p);
      return;
    }
    // Start from the first match at or after the current page.
    const i = found.findIndex((m) => m.page >= this.currentPage);
    this.selectMatch(i === -1 ? 0 : i);
  }

  findStep(dir: number) {
    if (this.findInputEl.value !== this.query) {
      void this.find(this.findInputEl.value);
      return;
    }
    if (!this.matches.length) return;
    this.selectMatch((this.matchIndex + dir + this.matches.length) % this.matches.length);
  }

  private selectMatch(i: number) {
    this.matchIndex = i;
    const m = this.matches[i]!;
    this.findCountEl.setText(`${i + 1} of ${this.matches.length}`);
    for (const p of this.pages) this.highlightPage(p);
    const p = this.pages[m.page - 1]!;
    const reveal = () => {
      const cur = p.el.querySelector<HTMLElement>(".vault-pdf-highlight.is-current");
      if (cur) cur.scrollIntoView({ block: "center" });
    };
    if (p.renderedScale === this.scale && p.textLayer) reveal();
    else {
      this.viewerContainerEl.scrollTop = p.el.offsetTop - 8;
      p.visible = true;
      void this.renderPage(p).then(reveal);
    }
  }

  private highlightPage(p: PageState) {
    const layer = p.textLayer;
    if (!layer) return;
    const divs = layer.textDivs;
    // Undo previous highlights.
    for (const div of divs) {
      if (div.querySelector(".vault-pdf-highlight")) div.textContent = div.textContent ?? "";
    }
    const pageMatches = this.matches.map((m, idx) => ({ m, idx })).filter(({ m }) => m.page === p.num);
    if (!pageMatches.length) return;
    const text = this.texts.get(p.num);
    if (!text) return;
    void text.then((t) => {
      if (p.textLayer !== layer) return;
      const perDiv = new Map<number, { start: number; end: number; current: boolean }[]>();
      for (const { m, idx } of pageMatches) {
        for (let d = 0; d < t.offsets.length && d < divs.length; d++) {
          const s = t.offsets[d]!;
          const e = s + t.lengths[d]!;
          if (e <= m.start || s >= m.end) continue;
          const list = perDiv.get(d) ?? [];
          list.push({ start: Math.max(0, m.start - s), end: Math.min(e, m.end) - s, current: idx === this.matchIndex });
          perDiv.set(d, list);
        }
      }
      for (const [d, ranges] of perDiv) {
        const div = divs[d]!;
        const str = div.textContent ?? "";
        div.empty();
        let pos = 0;
        for (const r of ranges.sort((a, b) => a.start - b.start)) {
          if (r.start < pos) continue;
          if (r.start > pos) div.appendText(str.slice(pos, r.start));
          div.createSpan({ cls: r.current ? "vault-pdf-highlight is-current" : "vault-pdf-highlight", text: str.slice(r.start, r.end) });
          pos = r.end;
        }
        if (pos < str.length) div.appendText(str.slice(pos));
      }
    });
  }
}

/** Case- and diacritic-insensitive, one UTF-16 unit per input unit so offsets survive. */
function normalize(s: string): string {
  let out = "";
  for (const ch of s) {
    const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    out += base.length === ch.length ? base : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch;
  }
  return out;
}

export class PdfView extends FileView {
  viewer: PdfViewer;
  override icon = "lucide-file-text";

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.contentEl.addClass("vault-pdf-view");
    this.viewer = new PdfViewer(this.app, this.contentEl.createDiv());
  }

  getViewType(): string {
    return "pdf";
  }

  override getIcon(): string {
    return "lucide-file-text";
  }

  override canAcceptExtension(extension: string): boolean {
    return extension.toLowerCase() === "pdf";
  }

  override onload(): void {
    super.onload();
    this.addChild(this.viewer);
    this.registerEvent(
      this.app.vault.on("modify", (f: TFile) => {
        if (f === this.file) void this.viewer.open(f);
      }),
    );
  }

  override async onLoadFile(file: TFile): Promise<void> {
    await this.viewer.open(file);
  }

  override async onUnloadFile(_file: TFile): Promise<void> {
    this.viewer.containerEl.empty();
  }

  override getEphemeralState(): Record<string, unknown> {
    return { subpath: `#page=${this.viewer.getCurrentPage()}` };
  }

  override setEphemeralState(state: any): void {
    const subpath = typeof state?.subpath === "string" ? state.subpath : "";
    const { page } = parsePdfSubpath(subpath);
    if (page) this.viewer.goToPage(page);
  }
}
