/**
 * Live Preview widgets. DOM shapes follow Obsidian's (the classes themes
 * target): `label.task-list-label > input.task-list-item-checkbox`,
 * `div.cm-embed-block.cm-callout > div.markdown-rendered + div.embed-actions`,
 * `div.cm-embed-block.cm-table-widget.markdown-rendered > div.table-wrapper >
 * table.table-editor`, `div.math.math-block.cm-embed-block`, `span.math`,
 * `span.code-block-flair`, `div.internal-embed`, `div.hr.cm-line`.
 *
 * Heavy widgets compare by source text in `eq`, so a rebuild of the
 * decoration set does not re-render a callout the user did not touch.
 */
import { EditorSelection } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import type { EditorHost } from "../host";
import { drawIcon } from "./icons";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

function safeRender(fn: () => void | Promise<void>, container: HTMLElement) {
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((e) => showError(container, e));
  } catch (e) {
    showError(container, e);
  }
}

function showError(container: HTMLElement, e: unknown) {
  console.error(e);
  const err = el("div", "vault-render-error", container);
  err.textContent = String((e as Error)?.message ?? e);
}

/** Put the cursor at `pos` (used by edit buttons and clicks that reveal source). */
export function revealAt(view: EditorView, pos: number) {
  view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: false, userEvent: "select" });
  view.focus();
}

function addEditButton(view: EditorView, host: EditorHost | null, dom: HTMLElement, getPos: () => number) {
  const actions = el("div", "embed-actions", dom);
  const btn = el("div", "embed-action edit-block-button", actions);
  btn.setAttribute("aria-label", "Edit this block");
  drawIcon(host, btn, "code-2");
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    revealAt(view, getPos());
  });
}

// ---------------------------------------------------------------------------

export class CheckboxWidget extends WidgetType {
  constructor(readonly ch: string) {
    super();
  }
  override eq(other: CheckboxWidget) {
    return other.ch === this.ch;
  }
  toDOM(view: EditorView) {
    const label = el("label", "task-list-label");
    const input = el("input", "task-list-item-checkbox", label);
    input.type = "checkbox";
    input.checked = this.ch !== " ";
    input.setAttribute("data-task", this.ch);
    input.addEventListener("mousedown", (e) => e.preventDefault());
    input.addEventListener("click", (e) => {
      // The click must reach listeners on the editor DOM first: plugins take
      // over task toggling there (Tasks listens on `view.dom`, rewrites the
      // line with a done date and calls preventDefault). Only a click nobody
      // claimed toggles the status here, once dispatch has finished.
      const was = !input.checked;
      setTimeout(() => {
        if (e.defaultPrevented || !view.dom.isConnected) return;
        const pos = view.posAtDOM(label);
        const text = view.state.doc.sliceString(pos, pos + 3);
        if (!/^\[.\]$/.test(text)) {
          input.checked = was;
          return;
        }
        const next = text[1] === " " ? "x" : " ";
        view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: next }, userEvent: "input" });
      }, 0);
    });
    return label;
  }
  override ignoreEvent() {
    return true;
  }
}

export class MathWidget extends WidgetType {
  constructor(
    readonly host: EditorHost | null,
    readonly source: string,
    readonly display: boolean,
    readonly block: boolean,
    readonly from: number,
  ) {
    super();
  }
  override eq(other: MathWidget) {
    return other.source === this.source && other.display === this.display && other.block === this.block;
  }
  override updateDOM(_dom: HTMLElement) {
    return false;
  }
  toDOM(view: EditorView) {
    const dom = this.block ? el("div", "math math-block cm-embed-block") : el("span", "math");
    if (!this.block && this.display) dom.classList.add("math-block");
    if (this.host) {
      safeRender(() => {
        dom.appendChild(this.host!.renderMath(this.source.trim(), this.display));
      }, dom);
    } else dom.textContent = this.source;
    if (this.block) {
      dom.setAttribute("contenteditable", "false");
      addEditButton(view, this.host, dom, () => view.posAtDOM(dom) + 2);
      dom.addEventListener("mousedown", (e) => {
        if ((e.target as HTMLElement).closest(".edit-block-button")) return;
        e.preventDefault();
        revealAt(view, view.posAtDOM(dom) + 2);
      });
    }
    return dom;
  }
  override get estimatedHeight() {
    return this.block ? 48 : -1;
  }
  override ignoreEvent(e: Event) {
    return this.block || e.type !== "mousedown";
  }
}

export class CodeFlairWidget extends WidgetType {
  constructor(
    readonly host: EditorHost | null,
    readonly label: string,
    readonly code: string,
  ) {
    super();
  }
  override eq(other: CodeFlairWidget) {
    return other.label === this.label && other.code === this.code;
  }
  toDOM() {
    const flair = el("span", "code-block-flair");
    flair.setAttribute("aria-label", "Copy");
    if (this.label) flair.textContent = this.label;
    else drawIcon(this.host, flair, "copy");
    flair.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void navigator.clipboard?.writeText(this.code).catch(() => {});
      flair.classList.add("is-copied");
      setTimeout(() => flair.classList.remove("is-copied"), 1200);
    });
    return flair;
  }
  override ignoreEvent() {
    return true;
  }
}

export class ExternalLinkIconWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const s = el("span", "cm-link external-link");
    return s;
  }
}

export class TextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: TextWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const s = el("span");
    s.textContent = this.text;
    return s;
  }
  override ignoreEvent() {
    return false;
  }
}

export class HiddenQuoteMarkWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const s = el("span", "cm-blockquote-border cm-transparent");
    s.textContent = ">";
    return s;
  }
}

export function parseEmbedSize(alt: string): { width?: string; height?: string; alt: string } {
  const m = /^(?:(.*)\|)?\s*(\d+)(?:x(\d+))?\s*$/.exec(alt);
  if (!m) return { alt };
  return { width: m[2], height: m[3], alt: m[1] ?? "" };
}

export class EmbedWidget extends WidgetType {
  constructor(
    readonly host: EditorHost | null,
    readonly linktext: string,
    readonly alt: string,
    readonly sourcePath: string,
    readonly block: boolean,
    readonly from: number,
  ) {
    super();
  }
  override eq(other: EmbedWidget) {
    return other.linktext === this.linktext && other.alt === this.alt && other.block === this.block && other.sourcePath === this.sourcePath;
  }
  toDOM(view: EditorView) {
    const dom = this.block ? el("div", "internal-embed") : el("span", "internal-embed");
    dom.setAttribute("src", this.linktext);
    dom.setAttribute("alt", this.alt);
    dom.setAttribute("tabindex", "-1");
    dom.setAttribute("contenteditable", "false");
    const size = parseEmbedSize(this.alt);
    if (size.width) dom.setAttribute("width", size.width);
    if (size.height) dom.setAttribute("height", size.height);
    if (this.host) safeRender(() => this.host!.renderEmbed(dom, this.linktext, this.sourcePath, this.alt), dom);
    dom.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("a, button, input, textarea, select, video, audio, .markdown-embed-link, iframe")) return;
      e.preventDefault();
      if (this.block) revealAt(view, view.posAtDOM(dom));
    });
    return dom;
  }
  override get estimatedHeight() {
    return this.block ? 120 : -1;
  }
  override ignoreEvent() {
    return true;
  }
}

/** Renderers for `![alt](url)` that is not a plain image; return null to fall back to `<img>`. Registered by the app. */
export const externalEmbedRenderers: Array<(url: string, alt: string) => HTMLElement | null> = [];

export class ExternalImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
  ) {
    super();
  }
  override eq(other: ExternalImageWidget) {
    return other.url === this.url && other.alt === this.alt;
  }
  toDOM() {
    // Extension point: the app renders YouTube/Vimeo/tweet/remote-media URLs as embeds.
    for (const render of externalEmbedRenderers) {
      const custom = render(this.url, this.alt);
      if (custom) return custom;
    }
    const img = el("img");
    const size = parseEmbedSize(this.alt);
    img.src = this.url;
    img.alt = size.alt;
    img.referrerPolicy = "no-referrer";
    if (size.width) img.setAttribute("width", size.width);
    if (size.height) img.setAttribute("height", size.height);
    img.setAttribute("contenteditable", "false");
    return img;
  }
  override ignoreEvent() {
    return true;
  }
}

/** Markdown rendered by the host inside an embed block (callout, code block processor, HTML). */
export class RenderedBlockWidget extends WidgetType {
  constructor(
    readonly host: EditorHost | null,
    readonly kind: "callout" | "code" | "html",
    readonly markdown: string,
    readonly sourcePath: string,
    readonly lang: string,
    readonly contentOffset: number,
  ) {
    super();
  }
  override eq(other: RenderedBlockWidget) {
    return other.kind === this.kind && other.markdown === this.markdown && other.sourcePath === this.sourcePath;
  }
  toDOM(view: EditorView) {
    let dom: HTMLElement;
    let target: HTMLElement;
    if (this.kind === "callout") {
      dom = el("div", "cm-embed-block cm-callout");
      target = el("div", "markdown-rendered", dom);
    } else if (this.kind === "code") {
      dom = el("div", `cm-preview-code-block cm-embed-block markdown-rendered cm-lang-${this.lang.replace(/[^\w-]/g, "")}`);
      target = dom;
    } else {
      dom = el("div", "cm-html-embed cm-embed-block");
      target = dom;
    }
    dom.setAttribute("tabindex", "-1");
    dom.setAttribute("contenteditable", "false");
    if (this.host) safeRender(() => this.host!.renderMarkdown(this.markdown, target, this.sourcePath), target);
    addEditButton(view, this.host, dom, () => view.posAtDOM(dom) + this.contentOffset);
    dom.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("a, button, input, textarea, select, .callout-fold, .edit-block-button, iframe, video, audio, .internal-embed")) return;
      if (this.kind === "code") return; // diagrams and processor output are interactive
      e.preventDefault();
      revealAt(view, view.posAtDOM(dom) + this.contentOffset);
    });
    return dom;
  }
  override get estimatedHeight() {
    return 80;
  }
  override ignoreEvent() {
    return true;
  }
}

export class TableWidget extends WidgetType {
  constructor(
    readonly host: EditorHost | null,
    readonly markdown: string,
    readonly sourcePath: string,
  ) {
    super();
  }
  override eq(other: TableWidget) {
    return other.markdown === this.markdown && other.sourcePath === this.sourcePath;
  }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-embed-block cm-table-widget markdown-rendered");
    dom.setAttribute("contenteditable", "false");
    const wrapper = el("div", "table-wrapper", dom);
    const scratch = el("div");
    const shape = () => {
      const table = scratch.querySelector("table");
      if (!table) {
        wrapper.replaceChildren(...Array.from(scratch.childNodes));
        return;
      }
      table.classList.add("table-editor");
      table.setAttribute("tabindex", "-1");
      for (const cell of Array.from(table.querySelectorAll("th, td"))) {
        const inner = el("div", "table-cell-wrapper");
        inner.append(...Array.from(cell.childNodes));
        cell.appendChild(inner);
      }
      wrapper.replaceChildren(table);
    };
    if (this.host) {
      safeRender(() => {
        const r = this.host!.renderMarkdown(this.markdown, scratch, this.sourcePath);
        if (r && typeof (r as Promise<void>).then === "function") void (r as Promise<void>).then(shape);
        else shape();
      }, wrapper);
    }
    dom.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("a, input, button, .internal-embed")) return;
      e.preventDefault();
      // Reveal the source, placing the cursor in the clicked cell when we can tell which.
      const cell = t.closest("th, td") as HTMLTableCellElement | null;
      const base = view.posAtDOM(dom);
      let pos = base;
      if (cell) {
        const row = cell.parentElement as HTMLTableRowElement;
        const isHead = !!cell.closest("thead");
        const rowIndex = isHead ? 0 : Array.from(row.parentElement!.children).indexOf(row) + 2;
        pos = cellOffset(view.state.doc.sliceString(base, base + this.markdown.length), rowIndex, cell.cellIndex) + base;
      }
      revealAt(view, pos);
    });
    return dom;
  }
  override get estimatedHeight() {
    return 36 * Math.max(2, this.markdown.split("\n").length - 1);
  }
  override ignoreEvent() {
    return true;
  }
}

/** Offset of the first content character of cell (row, col) in table source. */
export function cellOffset(source: string, row: number, col: number): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let i = 0; i < row && i < lines.length; i++) offset += lines[i]!.length + 1;
  const line = lines[Math.min(row, lines.length - 1)] ?? "";
  let c = line.trimStart().startsWith("|") ? -1 : 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && line[i - 1] !== "\\") {
      c++;
      if (c === col) {
        let j = i + 1;
        while (line[j] === " ") j++;
        return offset + j;
      }
    }
  }
  return offset + (col === 0 ? line.length - line.trimStart().length + (line.trimStart().startsWith("|") ? 2 : 0) : 0);
}

export class HrWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM(view: EditorView) {
    const dom = el("div", "hr cm-line");
    el("br", undefined, dom);
    el("hr", undefined, dom);
    dom.addEventListener("mousedown", (e) => {
      e.preventDefault();
      revealAt(view, view.posAtDOM(dom));
    });
    return dom;
  }
  override get estimatedHeight() {
    return 24;
  }
  override ignoreEvent() {
    return true;
  }
}

export class FoldIndicatorWidget extends WidgetType {
  constructor(
    readonly host: EditorHost | null,
    readonly folded: boolean,
    readonly onToggle: (view: EditorView, pos: number) => void,
  ) {
    super();
  }
  override eq(other: FoldIndicatorWidget) {
    return other.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const dom = el("div", "cm-fold-indicator" + (this.folded ? " is-collapsed" : ""));
    const inner = el("div", "collapse-indicator collapse-icon" + (this.folded ? " is-collapsed" : ""), dom);
    drawIcon(this.host, inner, "right-triangle");
    dom.setAttribute("contenteditable", "false");
    dom.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onToggle(view, view.posAtDOM(dom));
    });
    return dom;
  }
  override ignoreEvent() {
    return true;
  }
}

/** Invisible zero-height block used to hide frontmatter when properties render outside the content. */
export class EmptyBlockWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const d = el("div", "vault-hidden-block");
    d.style.display = "none";
    return d;
  }
  override get estimatedHeight() {
    return 0;
  }
}
