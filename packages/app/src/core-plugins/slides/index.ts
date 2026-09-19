/**
 * Slides — present the active note full screen, one slide per section
 * separated by a `---` line with blank lines around it.
 *
 * Notes written in Advanced Slides syntax (frontmatter such as `theme:`,
 * `<!-- slide -->` / `<!-- element -->` annotations, `note:` speaker notes,
 * `--` vertical slides) are presented with reveal.js instead — see
 * `advanced.ts` and `deck.ts`.
 *
 * DOM follows reveal.js's (which Obsidian bundles), so themes and snippets
 * that style `.reveal .slides section` apply:
 *
 *   body > .slides-container.vault-slides
 *     .reveal > .slides > section[.present|.past|.future] > .markdown-preview-view.markdown-rendered
 *     .controls (prev / next)   .slide-number   .slides-close-button
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Component } from "../../obsidian/events";
import { MarkdownRenderer } from "../../obsidian/markdown/renderer";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Scope, keymapFor } from "../../obsidian/ui/keymap";
import { Notice } from "../../obsidian/ui/notice";
import { getFrontMatterInfo, parseYaml } from "../../obsidian/util";
import { downloadBlob } from "../publish/zip";
import { isAdvancedDeck, parseDeck } from "./advanced";
import type { RevealPresentation } from "./deck";
import { TFile } from "../../obsidian/vault/files";

const STAGE_WIDTH = 960;
const STAGE_HEIGHT = 700;

/** Split Markdown into slides on `---` lines surrounded by blank lines, outside code fences. */
export function splitSlides(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const slides: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      const marker = f[1]!;
      if (fence === null) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
    }
    const isRule = fence === null && /^\s*---\s*$/.test(line);
    const prevBlank = i === 0 || lines[i - 1]!.trim() === "";
    const nextBlank = i === lines.length - 1 || lines[i + 1]!.trim() === "";
    if (isRule && prevBlank && nextBlank) {
      slides.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  slides.push(current.join("\n"));
  const trimmed = slides.map((s) => s.trim());
  // Leading/trailing separators do not make empty slides.
  while (trimmed.length > 1 && trimmed[0] === "") trimmed.shift();
  while (trimmed.length > 1 && trimmed[trimmed.length - 1] === "") trimmed.pop();
  return trimmed;
}

class Presentation extends Component {
  containerEl: HTMLElement;
  private slidesEl: HTMLElement;
  private sections: HTMLElement[] = [];
  private index = 0;
  private counterEl: HTMLElement;
  private prevEl: HTMLElement;
  private nextEl: HTMLElement;
  private scope: Scope;
  private closed = false;

  constructor(
    private app: any,
    private file: TFile,
    private onClosed: () => void,
  ) {
    super();
    this.containerEl = createDiv({ cls: "slides-container vault-slides" });
    const reveal = this.containerEl.createDiv({ cls: "reveal" });
    this.slidesEl = reveal.createDiv({ cls: "slides" });

    const controls = this.containerEl.createDiv({ cls: "controls" });
    this.prevEl = controls.createEl("button", { cls: "clickable-icon navigate-left", attr: { "aria-label": "Previous slide" } });
    setIcon(this.prevEl, "lucide-chevron-left");
    this.nextEl = controls.createEl("button", { cls: "clickable-icon navigate-right", attr: { "aria-label": "Next slide" } });
    setIcon(this.nextEl, "lucide-chevron-right");
    this.counterEl = this.containerEl.createDiv({ cls: "slide-number" });
    const close = this.containerEl.createEl("button", { cls: "clickable-icon slides-close-button", attr: { "aria-label": "Close" } });
    setIcon(close, "lucide-x");

    this.prevEl.addEventListener("click", () => this.go(this.index - 1));
    this.nextEl.addEventListener("click", () => this.go(this.index + 1));
    close.addEventListener("click", () => this.close());

    this.scope = new Scope();
    const next = () => (this.go(this.index + 1), false as const);
    const prev = () => (this.go(this.index - 1), false as const);
    for (const key of ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "N", "L", "J"]) this.scope.register([], key, next);
    for (const key of ["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "P", "H", "K"]) this.scope.register([], key, prev);
    this.scope.register(["Shift"], " ", prev);
    this.scope.register([], "Home", () => (this.go(0), false));
    this.scope.register([], "End", () => (this.go(this.sections.length - 1), false));
    this.scope.register([], "Escape", () => (this.close(), false));
  }

  async start() {
    const raw = await this.app.vault.cachedRead(this.file);
    const info = getFrontMatterInfo(raw);
    const body = info.exists ? raw.slice(info.contentStart) : raw;
    const slides = splitSlides(body);

    document.body.appendChild(this.containerEl);
    keymapFor(this.app).pushScope(this.scope);
    this.load();

    for (const markdown of slides) {
      const section = this.slidesEl.createEl("section", { cls: "future" });
      const rendered = section.createDiv({ cls: "markdown-preview-view markdown-rendered" });
      this.sections.push(section);
      await MarkdownRenderer.render(this.app, markdown, rendered, this.file.path, this);
    }
    this.registerDomEvent(window, "resize", () => this.layout());
    this.registerDomEvent(document, "fullscreenchange", () => {
      if (!document.fullscreenElement && !this.closed) this.close();
    });
    // Clicking a link leaves the presentation to open it.
    this.registerDomEvent(this.slidesEl, "click", (evt) => {
      if ((evt.target as HTMLElement).closest("a.internal-link")) this.close();
    });
    this.go(0);
    this.layout();
    try {
      await this.containerEl.requestFullscreen?.();
    } catch {
      /* no gesture or unsupported: the overlay already covers the window */
    }
    this.containerEl.focus();
  }

  private layout() {
    const w = this.containerEl.clientWidth || window.innerWidth;
    const h = this.containerEl.clientHeight || window.innerHeight;
    const scale = Math.min(w / STAGE_WIDTH, h / STAGE_HEIGHT);
    this.slidesEl.setCssStyles({
      width: `${STAGE_WIDTH}px`,
      height: `${STAGE_HEIGHT}px`,
      transform: `translate(-50%, -50%) scale(${scale})`,
    });
  }

  private go(i: number) {
    const n = this.sections.length;
    if (n === 0) return;
    this.index = Math.max(0, Math.min(n - 1, i));
    this.sections.forEach((s, k) => {
      s.toggleClass("present", k === this.index);
      s.toggleClass("past", k < this.index);
      s.toggleClass("future", k > this.index);
      s.setAttr("aria-hidden", k === this.index ? "false" : "true");
    });
    const current = this.sections[this.index]!;
    current.scrollTop = 0;
    this.counterEl.setText(`${this.index + 1} / ${n}`);
    this.prevEl.toggleClass("is-disabled", this.index === 0);
    this.nextEl.toggleClass("is-disabled", this.index === n - 1);
    this.containerEl.setAttr("data-slide", String(this.index + 1));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    keymapFor(this.app).popScope(this.scope);
    if (document.fullscreenElement === this.containerEl) void document.exitFullscreen?.().catch(() => {});
    this.unload();
    this.containerEl.remove();
    this.onClosed();
  }
}

export class SlidesPlugin extends Plugin {
  instance!: any;
  private current: { close(): void } | null = null;
  // internal (used by tests): the running reveal.js deck, if any
  reveal: RevealPresentation | null = null;

  override onload() {
    this.instance.start = (file?: TFile) => this.start(file ?? this.app.workspace.getActiveFile());
    this.instance.parseDeck = (text: string) => {
      const info = getFrontMatterInfo(text);
      const fm = info.exists ? (parseYaml(info.frontmatter) as Record<string, unknown> | null) : null;
      return parseDeck(info.exists ? text.slice(info.contentStart) : text, fm);
    };
    this.instance.isAdvancedDeck = (file: TFile) => this.isDeck(file);
    this.instance.getReveal = () => this.reveal;
    this.instance.exportHtml = (file: TFile) => import("./deck").then((m) => m.exportDeckHtml(this.app, file));

    this.addCommand({
      id: "slides:speaker-view",
      name: "Open speaker view",
      icon: "lucide-monitor-speaker",
      checkCallback: (checking: boolean) => {
        const file: TFile | null = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.startWithSpeakerView(file);
        return true;
      },
    });
    this.addCommand({
      id: "slides:export-html",
      name: "Export presentation as HTML",
      icon: "lucide-file-code",
      checkCallback: (checking: boolean) => {
        const file: TFile | null = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.exportHtml(file);
        return true;
      },
    });

    this.addCommand({
      id: "slides:start",
      name: "Start presentation",
      icon: "lucide-presentation",
      checkCallback: (checking: boolean) => {
        const file: TFile | null = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.start(file);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: any, file: any, source: string) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        if (source !== "tab-header" && source !== "more-options" && source !== "pane-more-options") return;
        menu.addItem((item: any) =>
          item
            .setSection("view.linked")
            .setTitle("Start presentation")
            .setIcon("lucide-presentation")
            .onClick(() => void this.start(file)),
        );
      }),
    );

    this.register(() => this.current?.close());
  }

  /** Advanced Slides syntax (frontmatter keys, annotations, `note:`, `--`) → reveal.js; plain notes keep the core behaviour. */
  async isDeck(file: TFile): Promise<boolean> {
    const raw: string = await this.app.vault.cachedRead(file);
    const info = getFrontMatterInfo(raw);
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
    return isAdvancedDeck(fm, info.exists ? raw.slice(info.contentStart) : raw);
  }

  async start(file: TFile | null): Promise<void> {
    if (!file || file.extension !== "md") {
      new Notice("Open a note to present it.");
      return;
    }
    // Save pending edits so the slides show what is on screen.
    const view = this.app.workspace.getActiveFileView?.();
    if (view?.file === file && typeof view.save === "function") await view.save();
    this.current?.close();
    if (await this.isDeck(file)) {
      const { RevealPresentation } = await import("./deck");
      const p: RevealPresentation = new RevealPresentation(this.app, file, () => {
        if (this.current === p) this.current = null;
        if (this.reveal === p) this.reveal = null;
      });
      this.current = p;
      this.reveal = p;
      try {
        await p.start();
      } catch (e) {
        p.close();
        new Notice(`Could not start the presentation: ${(e as Error)?.message ?? e}`);
      }
      return;
    }
    const p = new Presentation(this.app, file, () => {
      if (this.current === p) this.current = null;
    });
    this.current = p;
    await p.start();
  }

  async startWithSpeakerView(file: TFile) {
    if (!(await this.isDeck(file))) {
      new Notice("The speaker view needs a deck in Advanced Slides format: add speaker notes after a “note:” line.");
    }
    // Open the window inside the user gesture, before the deck renders.
    const win = window.open("", "vault-speaker-view", "popup,width=1100,height=720");
    await this.start(file);
    if (this.reveal) this.reveal.openSpeakerView();
    else win?.close();
  }

  async exportHtml(file: TFile) {
    const notice = new Notice("Exporting presentation…", 0);
    try {
      const { exportDeckHtml } = await import("./deck");
      const html = await exportDeckHtml(this.app, file);
      downloadBlob(new Blob([html], { type: "text/html" }), `${file.basename.replace(/[\\/:*?"<>|]/g, "-")}.html`);
    } catch (e) {
      new Notice(`Export failed: ${(e as Error)?.message ?? e}`);
    } finally {
      notice.hide();
    }
  }
}

export const slides: CorePluginDefinition = {
  id: "slides",
  name: "Slides",
  description: 'Create a presentation by using "---" to separate slides. Advanced Slides decks are presented with reveal.js.',
  icon: "lucide-presentation",
  defaultOn: false,
  create: (app) =>
    new SlidesPlugin(app, { id: "slides", name: "Slides", version: "", minAppVersion: "", author: "", description: 'Create a presentation by using "---" to separate slides.' }),
};
