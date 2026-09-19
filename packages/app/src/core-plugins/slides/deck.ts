/**
 * Advanced Slides decks presented with reveal.js (MIT), loaded from the npm
 * package as a lazy chunk on first use — no CDN, no local server.
 *
 *   body > .vault-reveal-container.vault-slides.mod-reveal
 *     .reveal > .slides > section[data-*] (> section for vertical stacks)
 *       .vault-slide-content (rendered Markdown)   aside.notes
 *
 * Slide Markdown goes through MarkdownRenderer, so callouts, embeds, math and
 * Mermaid render as in Reading view. The speaker view is a same-origin popup
 * the deck drives directly. Export writes one self-contained HTML file.
 */
import type { RevealApi, RevealConfig } from "reveal.js";
import { Component } from "../../obsidian/events";
import { MarkdownRenderer } from "../../obsidian/markdown/renderer";
import { Scope, keymapFor } from "../../obsidian/ui/keymap";
import { Notice } from "../../obsidian/ui/notice";
import { getFrontMatterInfo, parseLinktext } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";
import { cleanRendered, settle } from "../export/render";
import { dataUrl, imageBytes, standaloneSvg } from "../export/portable";
import { fromB64, parseDeck, type DeckSpec, type SlideSpec } from "./advanced";

export const BUILTIN_THEMES = ["black", "white", "league", "beige", "sky", "night", "serif", "simple", "solarized", "blood", "moon", "dracula", "black-contrast", "white-contrast"] as const;

const themeLoaders: Record<string, () => Promise<{ default: string }>> = {
  black: () => import("reveal.js/theme/black.css?inline"),
  white: () => import("reveal.js/theme/white.css?inline"),
  league: () => import("reveal.js/theme/league.css?inline"),
  beige: () => import("reveal.js/theme/beige.css?inline"),
  sky: () => import("reveal.js/theme/sky.css?inline"),
  night: () => import("reveal.js/theme/night.css?inline"),
  serif: () => import("reveal.js/theme/serif.css?inline"),
  simple: () => import("reveal.js/theme/simple.css?inline"),
  solarized: () => import("reveal.js/theme/solarized.css?inline"),
  blood: () => import("reveal.js/theme/blood.css?inline"),
  moon: () => import("reveal.js/theme/moon.css?inline"),
  dracula: () => import("reveal.js/theme/dracula.css?inline"),
  "black-contrast": () => import("reveal.js/theme/black-contrast.css?inline"),
  "white-contrast": () => import("reveal.js/theme/white-contrast.css?inline"),
};

/** Web fonts are fetched only when the user asks for network; themes fall back to local fonts. */
function withoutRemoteImports(css: string): string {
  // Minified builds write `@import"https://…"` with no space, and some themes use `//host` URLs.
  return css.replace(/@import\s*(?:url\()?\s*["']?(?:https?:)?\/\/[^;]*;?/g, "");
}

async function themeCss(app: any, theme: unknown, sourcePath: string): Promise<string> {
  const name = typeof theme === "string" && theme ? theme.trim() : "black";
  const key = name.toLowerCase().replace(/\.css$/, "");
  if (themeLoaders[key]) return withoutRemoteImports((await themeLoaders[key]!()).default);
  // A vault CSS file (Advanced Slides accepts a path to a custom theme).
  const file: TFile | null = app.metadataCache.getFirstLinkpathDest(name, sourcePath) ?? app.vault.getFileByPath(name);
  if (file) {
    const own = await app.vault.cachedRead(file);
    return withoutRemoteImports((await themeLoaders.black!()).default) + "\n" + own;
  }
  return withoutRemoteImports((await themeLoaders.black!()).default);
}

async function extraCss(app: any, css: unknown, sourcePath: string): Promise<string> {
  const list = Array.isArray(css) ? css : typeof css === "string" ? css.split(",") : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const file: TFile | null = app.metadataCache.getFirstLinkpathDest(entry.trim(), sourcePath) ?? app.vault.getFileByPath(entry.trim());
    if (file) out.push(await app.vault.cachedRead(file));
  }
  return out.join("\n");
}

function resolveBackground(app: any, value: string, sourcePath: string): { image?: string; color?: string } {
  const v = value.trim();
  const wiki = /^!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(v);
  const target = wiki ? wiki[1]! : v;
  if (wiki || /\.(png|jpe?g|gif|svg|webp|avif|bmp)(\?.*)?$/i.test(target) || /^https?:\/\//.test(target)) {
    if (/^https?:\/\//.test(target)) return { image: target };
    const file: TFile | null = app.metadataCache.getFirstLinkpathDest(parseLinktext(target).path, sourcePath);
    return file ? { image: app.vault.getResourcePath(file) } : {};
  }
  return { color: v };
}

function applySlideAttrs(app: any, section: HTMLElement, attrs: Record<string, string>, sourcePath: string) {
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "bg") {
      const bg = resolveBackground(app, v, sourcePath);
      if (bg.image) section.setAttribute("data-background-image", bg.image);
      if (bg.color) section.setAttribute("data-background-color", bg.color);
    } else if (k === "class") {
      section.addClasses(v.split(/\s+/).filter(Boolean));
    } else if (/^(data-[\w-]+|style|id)$/.test(k)) {
      section.setAttribute(k, v);
    }
  }
}

/** Element annotations and `+` fragments, applied after rendering. */
function applyElementAnnotations(content: HTMLElement, spec: SlideSpec) {
  content.querySelectorAll<HTMLElement>("span.vault-slide-element").forEach((marker) => {
    let attrs: Record<string, string> = {};
    try {
      attrs = JSON.parse(fromB64(marker.getAttribute("data-attrs") ?? ""));
    } catch {
      /* malformed */
    }
    const parent = marker.parentElement;
    let target: Element | null = parent;
    const alone = parent && Array.from(parent.childNodes).every((n) => n === marker || (n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()) || (n instanceof HTMLBRElement));
    if (!parent || parent === content) {
      target = marker.previousElementSibling;
    } else if (alone) {
      target = parent.previousElementSibling ?? (parent.parentElement !== content ? parent.parentElement : null);
      parent.remove();
    } else if (parent.tagName === "P" && parent.parentElement?.tagName === "LI") {
      target = parent.parentElement;
    }
    marker.remove();
    if (!target) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") target.classList.add(...v.split(/\s+/).filter(Boolean));
      else if (k === "style") target.setAttribute("style", `${target.getAttribute("style") ?? ""};${v}`);
      else if (/^(data-[\w-]+|id|title)$/.test(k)) target.setAttribute(k, v);
    }
  });
  if (spec.listFragments.includes(true)) {
    // List items render in source order, so the n-th <li> is the n-th list line.
    content.querySelectorAll<HTMLElement>("li").forEach((li, i) => {
      if (spec.listFragments[i]) li.addClass("fragment");
    });
  }
}

export interface BuiltDeck {
  slidesEl: HTMLElement;
  component: Component;
  spec: DeckSpec;
  frontmatter: Record<string, unknown>;
}

/** Render a deck's sections into `slidesEl` (a `.slides` element). */
export async function buildDeck(app: any, file: TFile, slidesEl: HTMLElement, component: Component): Promise<BuiltDeck> {
  const raw: string = await app.vault.cachedRead(file);
  const info = getFrontMatterInfo(raw);
  const body = info.exists ? raw.slice(info.contentStart) : raw;
  const frontmatter = (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
  const spec = parseDeck(body, frontmatter);
  for (const stack of spec.stacks) {
    const parent = stack.length > 1 ? slidesEl.createEl("section") : slidesEl;
    for (const s of stack) {
      const section = parent.createEl("section");
      applySlideAttrs(app, section, s.attrs, file.path);
      const content = section.createDiv({ cls: "vault-slide-content" });
      await MarkdownRenderer.render(app, s.markdown, content, file.path, component);
      applyElementAnnotations(content, s);
      if (s.notes) {
        const aside = section.createEl("aside", { cls: "notes" });
        await MarkdownRenderer.render(app, s.notes, aside, file.path, component);
      }
    }
  }
  return { slidesEl, component, spec, frontmatter };
}

async function loadReveal(): Promise<{ Reveal: typeof import("reveal.js").default; css: string }> {
  const [mod, css] = await Promise.all([import("reveal.js"), import("reveal.js/reveal.css?inline")]);
  return { Reveal: mod.default, css: css.default };
}

function revealConfig(spec: DeckSpec, extra: Record<string, unknown> = {}): RevealConfig {
  return {
    width: 960,
    height: 700,
    margin: 0.04,
    controls: true,
    progress: true,
    slideNumber: false,
    center: true,
    transition: "slide",
    hash: false,
    history: false,
    respondToHashChanges: false,
    ...spec.options,
    ...extra,
  } as RevealConfig;
}

export class RevealPresentation extends Component {
  containerEl: HTMLElement;
  deck: RevealApi | null = null;
  built: BuiltDeck | null = null;
  private styleEls: HTMLStyleElement[] = [];
  private scope = new Scope();
  private closed = false;
  private speaker: Window | null = null;
  private startedAt = Date.now();

  constructor(
    private app: any,
    private file: TFile,
    private onClosed: () => void,
  ) {
    super();
    this.containerEl = createDiv({ cls: "vault-reveal-container vault-slides mod-reveal", attr: { tabindex: "-1" } });
  }

  async start(): Promise<void> {
    const { Reveal, css } = await loadReveal();
    const revealEl = this.containerEl.createDiv({ cls: "reveal" });
    const slidesEl = revealEl.createDiv({ cls: "slides" });
    document.body.appendChild(this.containerEl);
    this.load();
    this.built = await buildDeck(this.app, this.file, slidesEl, this);
    const fm = this.built.frontmatter;
    for (const text of [css, await themeCss(this.app, fm.theme, this.file.path), await extraCss(this.app, fm.css, this.file.path)]) {
      if (text) this.styleEls.push(document.head.createEl("style", { attr: { "data-vault-reveal": "" }, text }));
    }
    await settle(this.containerEl, 4000);
    cleanRendered(slidesEl);

    const close = this.containerEl.createEl("button", { cls: "clickable-icon slides-close-button", attr: { "aria-label": "Close" } });
    close.setText("✕");
    close.addEventListener("click", () => this.close());

    this.scope.register([], "Escape", () => (this.close(), false));
    keymapFor(this.app).pushScope(this.scope);

    this.deck = new Reveal(revealEl, revealConfig(this.built.spec, { embedded: true, keyboardCondition: null, keyboard: { 27: () => this.close() } }));
    await this.deck.initialize();
    const sync = () => this.syncSpeaker();
    this.deck.on("slidechanged", sync);
    this.deck.on("fragmentshown", sync);
    this.deck.on("fragmenthidden", sync);
    this.registerDomEvent(document, "fullscreenchange", () => {
      if (!document.fullscreenElement && this.fullscreenRequested && !this.closed) this.close();
    });
    this.registerDomEvent(slidesEl, "click", (evt) => {
      if ((evt.target as HTMLElement).closest("a.internal-link")) this.close();
    });
    try {
      await this.containerEl.requestFullscreen?.();
      this.fullscreenRequested = true;
    } catch {
      /* no user gesture: the overlay already covers the window */
    }
    this.containerEl.focus();
    this.deck.layout();
  }

  private fullscreenRequested = false;

  openSpeakerView(): Window | null {
    if (!this.deck || !this.built) return null;
    const win = window.open("", "vault-speaker-view", "popup,width=1100,height=720");
    if (!win) {
      new Notice("The browser blocked the speaker view. Allow pop-ups for this site and try again.");
      return null;
    }
    this.speaker = win;
    const doc = win.document;
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><title>Speaker view</title></head><body class="vault-speaker-view"></body></html>');
    doc.close();
    // Same origin: carry the app's and the theme's styles across.
    for (const el of Array.from(document.head.querySelectorAll("style, link[rel=stylesheet]"))) doc.head.appendChild(el.cloneNode(true));
    doc.body.className = `${document.body.className} vault-speaker-view`;
    // The popup has plain DOM (the app's createDiv helpers live on this window's prototypes).
    const h = (parent: Element, tag: string, cls: string, text?: string) => {
      const el = doc.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined) el.textContent = text;
      parent.appendChild(el);
      return el;
    };
    const root = h(doc.body, "div", "vault-speaker");
    const current = h(root, "div", "vault-speaker-current");
    h(current, "div", "vault-speaker-label", "Current");
    h(current, "div", "vault-speaker-stage reveal");
    const side = h(root, "div", "vault-speaker-side");
    const next = h(side, "div", "vault-speaker-next");
    h(next, "div", "vault-speaker-label", "Next");
    h(next, "div", "vault-speaker-stage reveal");
    const meta = h(side, "div", "vault-speaker-meta");
    h(meta, "div", "vault-speaker-counter");
    h(meta, "div", "vault-speaker-timer", "0:00");
    const nav = h(meta, "div", "vault-speaker-nav");
    h(nav, "button", "", "◀ Previous").addEventListener("click", () => this.deck?.prev());
    h(nav, "button", "", "Next ▶").addEventListener("click", () => this.deck?.next());
    h(side, "div", "vault-speaker-label", "Notes");
    h(side, "div", "vault-speaker-notes markdown-rendered");
    win.addEventListener("keydown", (evt) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(evt.key)) this.deck?.next();
      else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(evt.key)) this.deck?.prev();
      else return;
      evt.preventDefault();
    });
    const timer = win.setInterval(() => {
      const s = Math.floor((Date.now() - this.startedAt) / 1000);
      const el = doc.querySelector(".vault-speaker-timer");
      if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
    win.addEventListener("beforeunload", () => win.clearInterval(timer));
    win.addEventListener("resize", () => this.syncSpeaker());
    this.syncSpeaker();
    return win;
  }

  private syncSpeaker() {
    const win = this.speaker;
    if (!win || win.closed || !this.deck) return;
    const doc = win.document;
    const slide = this.deck.getCurrentSlide();
    const all = Array.from(this.containerEl.querySelectorAll<HTMLElement>(".slides section:not(.stack)")).filter((s) => !s.querySelector(":scope > section"));
    const index = all.indexOf(slide);
    const nextSlide = all[index + 1] ?? null;
    const show = (stage: Element | null, src: HTMLElement | null) => {
      if (!stage) return;
      stage.replaceChildren();
      if (!src) {
        const end = doc.createElement("div");
        end.className = "vault-speaker-end";
        end.textContent = "End of presentation";
        stage.appendChild(end);
        return;
      }
      const wrap = doc.createElement("div");
      wrap.className = "slides";
      stage.appendChild(wrap);
      wrap.style.transform = `scale(${(stage as HTMLElement).clientWidth / 960})`;
      const clone = doc.importNode(src, true) as HTMLElement;
      clone.querySelectorAll("aside.notes").forEach((n) => n.remove());
      // MathJax glyphs live in a font cache in this document; give the popup self-contained SVG.
      const srcMath = Array.from(src.querySelectorAll<SVGSVGElement>("mjx-container > svg"));
      Array.from(clone.querySelectorAll<SVGSVGElement>("mjx-container > svg")).forEach((svg, i) => {
        if (srcMath[i]) svg.replaceWith(doc.importNode(standaloneSvg(srcMath[i]!).el, true));
      });
      for (const el of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>("section"))]) {
        el.removeAttribute("hidden");
        el.removeAttribute("inert");
        el.removeAttribute("aria-hidden");
        el.classList.remove("past", "future");
      }
      clone.style.cssText = "display:block;position:relative;opacity:1;transform:none;top:auto;left:auto;";
      clone.classList.add("present");
      wrap.appendChild(clone);
    };
    show(doc.querySelector(".vault-speaker-current .vault-speaker-stage"), slide);
    show(doc.querySelector(".vault-speaker-next .vault-speaker-stage"), nextSlide);
    const notes = doc.querySelector(".vault-speaker-notes");
    if (notes) {
      notes.replaceChildren();
      const aside = slide.querySelector(":scope > aside.notes");
      if (aside) for (const n of Array.from(aside.childNodes)) notes.appendChild(doc.importNode(n, true));
      else {
        const empty = doc.createElement("div");
        empty.className = "vault-speaker-empty";
        empty.textContent = "No notes for this slide.";
        notes.appendChild(empty);
      }
    }
    const counter = doc.querySelector(".vault-speaker-counter");
    if (counter) counter.textContent = `Slide ${index + 1} of ${all.length}`;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    keymapFor(this.app).popScope(this.scope);
    if (document.fullscreenElement === this.containerEl) void document.exitFullscreen?.().catch(() => {});
    try {
      this.deck?.destroy();
    } catch {
      /* already torn down */
    }
    if (this.speaker && !this.speaker.closed) this.speaker.close();
    for (const s of this.styleEls) s.remove();
    this.unload();
    this.containerEl.remove();
    document.documentElement.removeClass("reveal-full-page");
    this.onClosed();
  }
}

// ---- export ---------------------------------------------------------------------------

const EXPORT_EXTRA_CSS = `
html,body{margin:0;height:100%;overflow:hidden}
.reveal .callout{border-left:4px solid rgb(var(--callout-color,68,138,255));background:rgba(var(--callout-color,68,138,255),.12);padding:.4em .8em;margin:.6em 0;text-align:left;font-size:.8em;border-radius:4px}
.reveal .callout-title{font-weight:700;display:flex;gap:.3em}.reveal .callout-icon{display:none}
.reveal .vault-slide-content mark{background:#ffe066;color:#222}
.reveal img{max-width:100%}
.reveal .task-list-item{list-style:none}
`;

/** One self-contained HTML file: reveal.js inline, images as data URLs, math as SVG. */
export async function exportDeckHtml(app: any, file: TFile): Promise<string> {
  const component = new Component();
  component.load();
  const stage = document.body.createDiv({ cls: "vault-export-stage reveal" });
  try {
    const slidesEl = stage.createDiv({ cls: "slides" });
    const built = await buildDeck(app, file, slidesEl, component);
    await settle(stage, 5000);
    cleanRendered(slidesEl);
    for (const svg of Array.from(slidesEl.querySelectorAll<SVGSVGElement>("mjx-container svg, .mermaid svg"))) {
      if (svg.parentElement?.closest("svg")) continue;
      const { el } = standaloneSvg(svg);
      (svg.closest("mjx-container") ?? svg).replaceWith(el);
    }
    slidesEl.querySelectorAll("svg:not([xmlns])").forEach((s) => {
      if (!s.parentElement?.closest("svg")) s.remove();
    });
    for (const img of Array.from(slidesEl.querySelectorAll<HTMLImageElement>("img"))) {
      const bytes = await imageBytes(img);
      if (bytes) img.setAttribute("src", dataUrl(bytes.data, bytes.mime));
    }
    for (const section of Array.from(slidesEl.querySelectorAll<HTMLElement>("section[data-background-image]"))) {
      const src = section.getAttribute("data-background-image")!;
      if (/^https?:/i.test(src) && !src.startsWith(location.origin)) continue;
      try {
        const res = await fetch(src);
        const data = new Uint8Array(await res.arrayBuffer());
        section.setAttribute("data-background-image", dataUrl(data, res.headers.get("content-type") || "image/png"));
      } catch {
        /* keep the URL */
      }
    }
    slidesEl.querySelectorAll("a.internal-link").forEach((a) => a.replaceWith(...Array.from(a.childNodes)));
    const [{ css }, js, theme, extra] = await Promise.all([loadReveal(), import("reveal.js?raw"), themeCss(app, built.frontmatter.theme, file.path), extraCss(app, built.frontmatter.css, file.path)]);
    const revealJs = (js as { default: string }).default.replace(/export\s*\{\s*(\w+)\s+as\s+default\s*\};?\s*$/, "window.Reveal = $1;");
    const title = typeof built.frontmatter.title === "string" ? built.frontmatter.title : file.basename;
    const config = JSON.stringify(revealConfig(built.spec, { hash: true }));
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    const scriptSafe = (s: string) => s.replace(/<\/script/gi, "<\\/script");
    const styleSafe = (s: string) => s.replace(/<\/style/gi, "<\\/style");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="OpenMarkdown slides">
<title>${esc(title)}</title>
<style>${styleSafe(css)}</style>
<style>${styleSafe(theme)}</style>
<style>${styleSafe(EXPORT_EXTRA_CSS)}${styleSafe(extra)}</style>
</head>
<body>
<div class="reveal"><div class="slides">
${slidesEl.innerHTML}
</div></div>
<script type="module">
${scriptSafe(revealJs)}
</script>
<script type="module">
window.Reveal.initialize(${config});
</script>
</body>
</html>
`;
  } finally {
    stage.remove();
    component.unload();
  }
}
