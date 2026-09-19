/**
 * Reading view rendering.
 *
 * The Rust core turns Markdown into one HTML fragment per top-level block
 * (`vault_ofm::render`). This module turns those fragments into live DOM: it
 * reuses the element of any section whose HTML did not change (so typing in a
 * long note re-renders one paragraph, and plugin widgets elsewhere survive),
 * resolves embeds and links against the vault, and runs post-processors on
 * each section — per section, as Obsidian does, because plugins call
 * `ctx.getSectionInfo(el)` and expect `el` to be one block.
 */
import type { MarkdownPostProcessor, MarkdownPostProcessorContext, MarkdownSectionInformation } from "obsidian";
import { getEngine, type RenderedSection } from "@vault/engine";
import { Component } from "../events";
import { setIcon } from "../ui/icons";
import { parseLinktext, sanitizeHTMLToDom } from "../util";
import { TFile } from "../vault/files";
import { finishRenderMath, loadMermaid, loadPrism, renderMath } from "./loaders";

export class MarkdownRenderChild extends Component {
  containerEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.containerEl = containerEl;
  }
}

type CodeBlockHandler = (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void;

interface Section {
  el: HTMLElement;
  html: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  children: Component[];
  processed: boolean;
}

let docCounter = 0;

export const CALLOUT_ICONS: Record<string, string> = {
  note: "lucide-pencil",
  abstract: "lucide-clipboard-list", summary: "lucide-clipboard-list", tldr: "lucide-clipboard-list",
  info: "lucide-info",
  todo: "lucide-check-circle-2",
  tip: "lucide-flame", hint: "lucide-flame", important: "lucide-flame",
  success: "lucide-check", check: "lucide-check", done: "lucide-check",
  question: "lucide-help-circle", help: "lucide-help-circle", faq: "lucide-help-circle",
  warning: "lucide-alert-triangle", caution: "lucide-alert-triangle", attention: "lucide-alert-triangle",
  failure: "lucide-x", fail: "lucide-x", missing: "lucide-x",
  danger: "lucide-zap", error: "lucide-zap",
  bug: "lucide-bug",
  example: "lucide-list",
  quote: "lucide-quote", cite: "lucide-quote",
};

export class MarkdownPreviewRenderer {
  static postProcessors: MarkdownPostProcessor[] = [];
  static codeBlockPostProcessors: Record<string, CodeBlockHandler> = {};

  static registerPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder?: number): void {
    if (sortOrder !== undefined) postProcessor.sortOrder = sortOrder;
    const list = MarkdownPreviewRenderer.postProcessors;
    if (!list.includes(postProcessor)) list.push(postProcessor);
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  static unregisterPostProcessor(postProcessor: MarkdownPostProcessor): void {
    MarkdownPreviewRenderer.postProcessors.remove(postProcessor);
  }

  static registerCodeBlockPostProcessor(language: string, handler: CodeBlockHandler) {
    MarkdownPreviewRenderer.codeBlockPostProcessors[language] = handler;
  }

  static unregisterCodeBlockPostProcessor(language: string) {
    delete MarkdownPreviewRenderer.codeBlockPostProcessors[language];
  }

  static createCodeBlockPostProcessor(language: string, handler: CodeBlockHandler): (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void {
    return (el, ctx) => {
      const codes = el.querySelectorAll<HTMLElement>(`pre > code.language-${cssEscape(language)}`);
      codes.forEach((code) => {
        const pre = code.parentElement!;
        const div = createDiv({ cls: `block-language-${language}` });
        pre.replaceWith(div);
        const source = code.textContent ?? "";
        try {
          const r = handler(source, div, ctx);
          if (r instanceof Promise) r.catch((e) => renderError(div, e));
        } catch (e) {
          renderError(div, e);
        }
      });
    };
  }

  // ---- instance: one per reading view or rendered element ----------------------

  app: any;
  owner: Component;
  containerEl: HTMLElement;
  sizerEl: HTMLElement;
  sections: Section[] = [];
  text = "";
  sourcePath = "";
  docId = `doc-${++docCounter}-${Date.now().toString(36)}`;
  frontmatter: Record<string, unknown> | null = null;
  // internal
  embedDepth = 0;

  constructor(app: any, owner: Component, containerEl: HTMLElement, sizerEl?: HTMLElement) {
    this.app = app;
    this.owner = owner;
    this.containerEl = containerEl;
    this.sizerEl = sizerEl ?? containerEl;
  }

  /** Render `text`, reusing unchanged sections. */
  async set(text: string, sourcePath: string, strictLineBreaks?: boolean) {
    this.text = text;
    this.sourcePath = sourcePath;
    const strict = strictLineBreaks ?? !!this.app.vault.getConfig("strictLineBreaks");
    const rendered = getEngine().render(text, { strictLineBreaks: strict });
    this.frontmatter = (() => {
      const f = this.app.vault.getFileByPath(sourcePath);
      return f ? (this.app.metadataCache.getFileCache(f)?.frontmatter ?? null) : null;
    })();

    const old = new Map<string, Section[]>();
    for (const s of this.sections) {
      const list = old.get(s.html) ?? [];
      list.push(s);
      old.set(s.html, list);
    }
    const next: Section[] = [];
    const fresh: Section[] = [];
    for (const r of rendered) {
      const reuse = old.get(r.html)?.shift();
      if (reuse) {
        reuse.lineStart = r.lineStart;
        reuse.lineEnd = r.lineEnd;
        next.push(reuse);
      } else {
        const s = this.createSection(r);
        next.push(s);
        fresh.push(s);
      }
    }
    for (const leftovers of old.values()) for (const s of leftovers) this.destroySection(s);
    this.sections = next;
    this.sizerEl.setChildrenInPlace(next.map((s) => s.el));
    await Promise.all(fresh.map((s) => this.processSection(s)));
    if (fresh.length) void finishRenderMath();
  }

  clear() {
    for (const s of this.sections) this.destroySection(s);
    this.sections = [];
    this.sizerEl.empty();
  }

  private createSection(r: RenderedSection): Section {
    const el = createDiv();
    el.addClass(`el-${sectionTag(r.kind)}`);
    el.appendChild(applyExternalEmbeds(sanitizeHTMLToDom(r.html)));
    return { el, html: r.html, kind: r.kind, lineStart: r.lineStart, lineEnd: r.lineEnd, children: [], processed: false };
  }

  private destroySection(s: Section) {
    for (const c of s.children) {
      this.owner.removeChild(c);
      c.unload();
    }
    s.children = [];
    s.el.detach();
  }

  private context(section: Section): MarkdownPostProcessorContext {
    return {
      docId: this.docId,
      sourcePath: this.sourcePath,
      frontmatter: this.frontmatter,
      addChild: (child) => {
        section.children.push(child as unknown as Component);
        this.owner.addChild(child as unknown as Component);
      },
      getSectionInfo: (el: HTMLElement): MarkdownSectionInformation | null => {
        const s = this.sections.find((x) => x.el === el || x.el.contains(el));
        if (!s) return null;
        return { text: this.text, lineStart: s.lineStart, lineEnd: s.lineEnd };
      },
      // internal (used by plugins: dataview checks ctx.el)
      el: section.el,
      remainingNestLevel: 4 - this.embedDepth,
    } as MarkdownPostProcessorContext;
  }

  private async processSection(s: Section) {
    const ctx = this.context(s);
    const el = s.el;
    this.processBuiltins(el, ctx);
    // Code blocks registered by plugins before the generic post-processors.
    for (const [lang, handler] of Object.entries(MarkdownPreviewRenderer.codeBlockPostProcessors)) {
      if (el.querySelector(`pre > code.language-${cssEscape(lang)}`)) {
        MarkdownPreviewRenderer.createCodeBlockPostProcessor(lang, handler)(el, ctx);
      }
    }
    for (const pp of MarkdownPreviewRenderer.postProcessors) {
      try {
        const r = pp(el, ctx);
        if (r instanceof Promise) await r.catch((e) => console.error(e));
      } catch (e) {
        console.error("Post-processor failed", e);
      }
    }
    s.processed = true;
  }

  private processBuiltins(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    // Links
    el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
      const href = a.getAttr("data-href") ?? "";
      const { path } = parseLinktext(href);
      if (path && !this.app.metadataCache.getFirstLinkpathDest(path, this.sourcePath)) a.addClass("is-unresolved");
    });
    // Callouts
    el.querySelectorAll<HTMLElement>(".callout").forEach((callout) => {
      const type = callout.getAttr("data-callout") ?? "note";
      const icon = callout.querySelector<HTMLElement>(":scope > .callout-title > .callout-icon");
      if (icon && !icon.firstChild) setIcon(icon, CALLOUT_ICONS[type] ?? "lucide-pencil");
      const fold = callout.querySelector<HTMLElement>(":scope > .callout-title > .callout-fold");
      if (fold && !fold.firstChild) setIcon(fold, "lucide-chevron-down");
    });
    // Math
    el.querySelectorAll<HTMLElement>(".math").forEach((m) => {
      if (m.hasClass("is-loaded")) return;
      const display = m.hasClass("math-block");
      const source = m.textContent ?? "";
      m.empty();
      m.addClass("is-loaded");
      renderMath(source, display).then((node) => m.appendChild(node), (e) => renderError(m, e));
    });
    // Mermaid and code highlighting
    el.querySelectorAll<HTMLElement>("pre > code.language-mermaid").forEach((code) => {
      const pre = code.parentElement!;
      const holder = createDiv({ cls: "mermaid" });
      pre.replaceWith(holder);
      void renderMermaid(holder, code.textContent ?? "");
    });
    el.querySelectorAll<HTMLElement>("pre > code[class*='language-']").forEach((code) => {
      const pre = code.parentElement!;
      if (pre.querySelector(".copy-code-button")) return;
      const lang = Array.from(code.classList).find((c) => c.startsWith("language-"))?.slice(9) ?? "";
      if (MarkdownPreviewRenderer.codeBlockPostProcessors[lang]) return;
      void highlight(code, lang);
      addCopyButton(pre, code);
    });
    el.querySelectorAll<HTMLElement>("pre:not(:has(code[class*='language-'])) > code").forEach((code) => addCopyButton(code.parentElement!, code));
    // Embeds
    el.querySelectorAll<HTMLElement>(".internal-embed").forEach((embed) => {
      if (!embed.hasClass("is-loaded")) this.loadEmbed(embed, ctx);
    });
  }

  // internal
  loadEmbed(embed: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const src = embed.getAttr("src") ?? "";
    const alt = embed.getAttr("alt") ?? "";
    const { path, subpath } = parseLinktext(src);
    const file: TFile | null = path ? this.app.metadataCache.getFirstLinkpathDest(path, this.sourcePath) : this.app.vault.getFileByPath(this.sourcePath);
    embed.addClass("is-loaded");
    if (!file) {
      embed.addClasses(["file-embed", "mod-empty"]);
      const title = embed.createDiv({ cls: "file-embed-title" });
      const icon = title.createSpan({ cls: "file-embed-icon" });
      setIcon(icon, "lucide-file-question");
      title.appendText(` “${path}” could not be found.`);
      embed.addEventListener("click", () => void this.app.workspace.openLinkText(src, this.sourcePath));
      return;
    }
    // Notes use the richer reading-view embed below; the registry's `md`
    // creator exists for plugins that build embeds themselves.
    const creator = file.extension === "md" ? null : this.app.embedRegistry?.getEmbedCreator(file);
    if (creator) {
      const component = creator({ app: this.app, containerEl: embed, linktext: src, sourcePath: this.sourcePath, depth: this.embedDepth + 1 }, file, subpath);
      if (component instanceof Component) ctx.addChild(component as never);
      if (alt) applyEmbedSize(embed, alt);
      void component.loadFile?.();
      return;
    }
    if (file.extension === "md") {
      this.renderMarkdownEmbed(embed, file, subpath, ctx);
      return;
    }
    embed.addClasses(["file-embed", "mod-generic"]);
    const title = embed.createDiv({ cls: "file-embed-title" });
    setIcon(title.createSpan({ cls: "file-embed-icon" }), "lucide-file");
    title.appendText(" " + file.name);
    embed.addEventListener("click", () => void this.app.workspace.openLinkText(src, this.sourcePath));
  }

  private renderMarkdownEmbed(embed: HTMLElement, file: TFile, subpath: string, ctx: MarkdownPostProcessorContext) {
    embed.addClasses(["markdown-embed", "inline-embed", "is-loaded"]);
    if (this.embedDepth >= 4) {
      embed.createDiv({ cls: "markdown-embed-content", text: "Embed depth limit reached." });
      return;
    }
    const titleEl = embed.createDiv({ cls: "markdown-embed-title" });
    const contentEl = embed.createDiv({ cls: "markdown-embed-content" });
    const linkEl = embed.createDiv({ cls: "markdown-embed-link", attr: { "aria-label": "Open link" } });
    setIcon(linkEl, "lucide-link");
    linkEl.addEventListener("click", (evt) => {
      evt.stopPropagation();
      void this.app.workspace.openLinkText(file.path + subpath, this.sourcePath, evt.ctrlKey || evt.metaKey);
    });
    if (subpath) titleEl.setText(file.basename + subpath.replace(/^#\^?/, " › "));
    const preview = contentEl.createDiv({ cls: "markdown-preview-view markdown-rendered" });
    const sizer = preview.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    const child = new MarkdownRenderChild(embed);
    ctx.addChild(child as never);
    const renderer = new MarkdownPreviewRenderer(this.app, child, preview, sizer);
    renderer.embedDepth = this.embedDepth + 1;
    const render = async () => {
      let text = await this.app.vault.cachedRead(file);
      if (subpath) {
        const cache = this.app.metadataCache.getFileCache(file);
        const res = cache ? getEngine().resolveSubpath(cache, subpath) : null;
        if (!res) {
          sizer.empty();
          sizer.createDiv({ cls: "markdown-embed-empty", text: `Unable to find “${subpath.slice(1)}” in ${file.basename}.` });
          return;
        }
        text = sliceUtf16(text, res.start.offset, res.end ? res.end.offset : text.length);
      } else {
        const info = /^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text);
        if (info) text = text.slice(info[0].length);
      }
      await renderer.set(text, file.path);
    };
    void render();
    child.registerEvent(
      this.app.metadataCache.on("changed", (f: TFile) => {
        if (f === file) void render();
      }),
    );
  }
}

/** Render a single `![[linktext|alt]]` embed into `container` (used by the Live Preview editor). */
export function renderEmbedInto(app: any, owner: Component, container: HTMLElement, linktext: string, sourcePath: string, alt: string) {
  const renderer = new MarkdownPreviewRenderer(app, owner, container);
  renderer.sourcePath = sourcePath;
  const span = container.createSpan({ cls: "internal-embed", attr: { src: linktext, alt, tabindex: "-1" } });
  const ctx = {
    docId: renderer.docId,
    sourcePath,
    frontmatter: null,
    addChild: (child: Component) => owner.addChild(child),
    getSectionInfo: () => null,
  } as unknown as MarkdownPostProcessorContext;
  renderer.loadEmbed(span, ctx);
  installInteractions(app, container, sourcePath, owner as never);
}

function sliceUtf16(text: string, start: number, end: number) {
  return text.slice(start, end);
}

function sectionTag(kind: string): string {
  switch (kind) {
    case "heading": return "h";
    case "paragraph": return "p";
    case "list": return "ul";
    case "code": return "pre";
    case "blockquote": return "blockquote";
    case "callout": return "div";
    case "table": return "table";
    case "thematicBreak": return "hr";
    case "math": return "div";
    case "footnotes": return "section";
    default: return "div";
  }
}

/**
 * External-embed hook. A handler turns the `<img>` of `![alt](https://…)`
 * into another element (an iframe player, a tweet card, `<video>`), or
 * returns null to leave the image alone.
 */
export type ExternalEmbedHandler = (url: string, alt: string) => HTMLElement | null;
const externalEmbedHandlers: ExternalEmbedHandler[] = [];

/**
 * Runs on the sanitised fragment while it still belongs to DOMPurify's inert
 * document, so a replaced `<img src="https://youtube…">` never starts loading.
 */
function applyExternalEmbeds(fragment: DocumentFragment): DocumentFragment {
  if (!externalEmbedHandlers.length) return fragment;
  fragment.querySelectorAll<HTMLImageElement>("img[src^='http:'], img[src^='https:']").forEach((img) => {
    const url = img.getAttribute("src") ?? "";
    // The engine moves `|WxH` into width/height attributes; hand handlers the alt text as written.
    const width = img.getAttribute("width");
    const height = img.getAttribute("height");
    const alt = (img.getAttribute("alt") ?? "") + (width ? `|${width}${height ? `x${height}` : ""}` : "");
    for (const handler of externalEmbedHandlers) {
      const replacement = handler(url, alt);
      if (replacement) {
        img.replaceWith(replacement);
        break;
      }
    }
  });
  return fragment;
}

export function registerExternalEmbedHandler(handler: ExternalEmbedHandler): () => void {
  externalEmbedHandlers.push(handler);
  return () => externalEmbedHandlers.remove(handler);
}

export function applyEmbedSize(el: HTMLElement, alt: string) {
  const m = /^(\d+)(?:x(\d+))?$/.exec(alt.trim());
  if (!m) return;
  el.setAttr("width", m[1]!);
  if (m[2]) el.setAttr("height", m[2]);
  const media = el.querySelector("img, video");
  if (media) {
    media.setAttribute("width", m[1]!);
    if (m[2]) media.setAttribute("height", m[2]);
  }
}

function cssEscape(s: string) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&");
}

export function renderError(el: HTMLElement, e: unknown) {
  el.empty();
  el.createEl("pre", { cls: "vault-render-error", text: String((e as Error)?.message ?? e) });
}

function addCopyButton(pre: HTMLElement, code: HTMLElement) {
  if (pre.querySelector(".copy-code-button")) return;
  const btn = pre.createEl("button", { cls: "copy-code-button", attr: { "aria-label": "Copy" } });
  setIcon(btn, "lucide-copy");
  btn.addEventListener("click", async (evt) => {
    evt.stopPropagation();
    await navigator.clipboard.writeText(code.textContent ?? "");
    btn.addClass("is-copied");
    setTimeout(() => btn.removeClass("is-copied"), 1200);
  });
}

async function highlight(code: HTMLElement, lang: string) {
  if (!lang) return;
  try {
    const Prism = await loadPrism();
    const grammar = Prism.languages[lang];
    if (!grammar) return;
    code.innerHTML = Prism.highlight(code.textContent ?? "", grammar, lang);
    code.addClass("is-loaded");
  } catch {
    /* highlighting is decoration */
  }
}

let mermaidCounter = 0;
async function renderMermaid(holder: HTMLElement, source: string) {
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`mermaid-${++mermaidCounter}`, source);
    holder.innerHTML = svg;
  } catch (e) {
    renderError(holder, e);
  }
}

/**
 * MarkdownRenderer — the public static entry points, and the abstract base of
 * MarkdownPreviewView.
 */
export abstract class MarkdownRenderer extends MarkdownRenderChild {
  app: any;
  hoverPopover: any = null;
  abstract get file(): TFile;

  constructor(app: any, containerEl: HTMLElement) {
    super(containerEl);
    this.app = app;
  }

  static async render(app: any, markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
    const renderer = new MarkdownPreviewRenderer(app, component, el);
    // Append after anything the caller already put in `el`.
    const holder = document.createDocumentFragment();
    const tmp = createDiv();
    renderer.sizerEl = tmp;
    await renderer.set(markdown, sourcePath);
    // Unlike the reading view, a standalone render has no per-section wrapper
    // divs: the block elements land directly in `el`. Plugins depend on it —
    // Tasks unwraps `el > p` with `el.insertBefore(p.firstChild, p)`, Dataview
    // inlines a single-paragraph result by checking `el.firstElementChild`.
    // Post-processors ran on the wrappers; their nodes keep their identity.
    for (const section of Array.from(tmp.children)) {
      while (section.firstChild) holder.appendChild(section.firstChild);
    }
    el.appendChild(holder);
    installInteractions(app, el, sourcePath, null);
  }

  /** @deprecated use render */
  static async renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component): Promise<void> {
    const app = (globalThis as { app?: unknown }).app;
    return MarkdownRenderer.render(app, markdown, el, sourcePath, component);
  }
}

/**
 * Clicks, hovers, checkboxes and folding inside rendered Markdown. Delegated
 * on the container so post-processor output gets the same behaviour.
 */
export function installInteractions(app: any, el: HTMLElement, sourcePath: string, view: { file: TFile | null; hoverPopover?: unknown } | null) {
  if ((el as { __vaultInteractions?: boolean }).__vaultInteractions) return;
  (el as { __vaultInteractions?: boolean }).__vaultInteractions = true;

  el.addEventListener("click", (evt) => {
    const target = evt.target as HTMLElement;
    const internal = target.closest<HTMLAnchorElement>("a.internal-link");
    if (internal) {
      evt.preventDefault();
      const href = internal.getAttr("data-href") ?? internal.getAttr("href") ?? "";
      const newLeaf = evt.ctrlKey || evt.metaKey ? (evt.altKey ? "split" : "tab") : false;
      void app.workspace.openLinkText(href, view?.file?.path ?? sourcePath, newLeaf);
      return;
    }
    const tag = target.closest<HTMLAnchorElement>("a.tag");
    if (tag) {
      evt.preventDefault();
      app.internalPlugins.getEnabledPluginById("global-search")?.openGlobalSearch?.(`tag:${tag.getText()}`);
      return;
    }
    const external = target.closest<HTMLAnchorElement>("a.external-link, a[href^='http']");
    if (external) {
      evt.preventDefault();
      window.open(external.href, "_blank", "noopener");
      return;
    }
    const footnote = target.closest<HTMLAnchorElement>("a.footnote-link, a.footnote-backref");
    if (footnote) {
      evt.preventDefault();
      const id = (footnote.getAttr("href") ?? "").slice(1);
      el.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const fold = target.closest<HTMLElement>(".callout-title");
    if (fold) {
      const callout = fold.parentElement!;
      if (callout.hasClass("is-collapsible")) {
        const collapsed = !callout.hasClass("is-collapsed");
        callout.toggleClass("is-collapsed", collapsed);
        fold.querySelector(".callout-fold")?.toggleClass("is-collapsed", collapsed);
        const content = callout.querySelector<HTMLElement>(":scope > .callout-content");
        content?.toggle(!collapsed);
      }
    }
    const headingFold = target.closest<HTMLElement>(".heading-collapse-indicator");
    if (headingFold) toggleHeadingFold(headingFold);
  });

  el.addEventListener("change", (evt) => {
    const box = evt.target as HTMLInputElement;
    if (!box.matches("input.task-list-item-checkbox")) return;
    const file = view?.file;
    if (!file) return;
    // A MarkdownView keeps its renderer on the reading-mode child.
    const owner = view as { renderer?: MarkdownPreviewRenderer; previewMode?: { renderer?: MarkdownPreviewRenderer } };
    const renderer = owner.renderer ?? owner.previewMode?.renderer;
    // Boxes inside plugin output (a Dataview TASK list, a Tasks query) belong to
    // the plugin, which handles them itself; only the note's own lists count.
    if (box.closest(".block-language-dataview, .block-language-tasks, [class*='block-language-']")) return;
    const s = renderer?.sections.find((x) => x.el.contains(box));
    const rel = Number(box.getAttr("data-line") ?? "-1");
    if (!s || rel < 0) return;
    const line = s.lineStart + rel;
    void app.vault.process(file, (text: string) => {
      const lines = text.split("\n");
      const current = lines[line];
      if (current === undefined) return text;
      lines[line] = current.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\])/, (_m, a, c, b) => `${a}${c === " " ? "x" : " "}${b}`);
      return lines.join("\n");
    });
  });

  el.addEventListener("mouseover", (evt) => {
    const link = (evt.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
    if (!link) return;
    app.workspace.trigger("hover-link", {
      event: evt,
      source: "preview",
      hoverParent: view ?? { hoverPopover: null },
      targetEl: link,
      linktext: link.getAttr("data-href") ?? "",
      sourcePath: view?.file?.path ?? sourcePath,
    });
  });

  el.addEventListener("contextmenu", (evt) => {
    const link = (evt.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
    if (!link) return;
    evt.preventDefault();
    void import("../ui/menu").then(({ Menu }) => {
      const menu = new Menu();
      app.workspace.handleLinkContextMenu(menu, link.getAttr("data-href") ?? "", view?.file?.path ?? sourcePath);
      menu.showAtMouseEvent(evt);
    });
  });
}

function toggleHeadingFold(indicator: HTMLElement) {
  const section = indicator.closest<HTMLElement>(".markdown-preview-sizer > div");
  if (!section) return;
  const heading = section.querySelector("h1,h2,h3,h4,h5,h6");
  if (!heading) return;
  const level = Number(heading.tagName[1]);
  const collapsed = !section.hasClass("is-collapsed");
  section.toggleClass("is-collapsed", collapsed);
  let next = section.nextElementSibling as HTMLElement | null;
  while (next) {
    const h = next.querySelector("h1,h2,h3,h4,h5,h6");
    if (h && Number(h.tagName[1]) <= level) break;
    next.toggle(!collapsed);
    next = next.nextElementSibling as HTMLElement | null;
  }
}
