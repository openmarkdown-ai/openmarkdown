/**
 * One canvas card: its DOM (`.canvas-node` > `.canvas-node-container` >
 * `.canvas-node-content`), content rendering per node type, and in-place
 * editing of text cards and Markdown notes.
 */
import { getEngine } from "@vault/engine";
import { createMarkdownEditor, type MarkdownEditorHandle } from "../../editor/create";
import { Component } from "../../obsidian/events";
import { MarkdownRenderer } from "../../obsidian/markdown/renderer";
import { setIcon } from "../../obsidian/ui/icons";
import { debounce } from "../../obsidian/util";
import { embedOptions } from "../media/embeds";
import type { TFile } from "../../obsidian/vault/files";
import { cssColor, isPresetColor, SIDES, type CanvasNodeData } from "./data";
import { CanvasEditorInfo, createCanvasEditorHost } from "./editor-host";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"];
export const VIDEO_EXTENSIONS = ["mp4", "webm", "ogv", "mov", "mkv"];
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "flac", "3gp", "aac"];
export const DOCUMENT_EXTENSIONS = ["md", "canvas", "base"];

export interface NodeHost {
  app: any;
  /** The canvas file (source path for links). */
  file: TFile | null;
  owner: Component;
  readOnly: boolean;
  onNodeTextEdited(node: CanvasNodeView, text: string): void;
  onEditingEnd(node: CanvasNodeView): void;
}

const RESIZE_HANDLES = ["n", "e", "s", "w", "ne", "nw", "se", "sw"] as const;

export class CanvasNodeView {
  el: HTMLElement;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  labelEl: HTMLElement | null = null;
  editing = false;
  private component: Component | null = null;
  private contentKey = "";
  private editor: MarkdownEditorHandle | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private fileWrite: ReturnType<typeof debounce<[TFile, string], void>> | null = null;

  constructor(
    public data: CanvasNodeData,
    private host: NodeHost,
    parentEl: HTMLElement,
  ) {
    this.el = parentEl.createDiv({ cls: "canvas-node" });
    this.el.dataset.id = data.id;
    this.containerEl = this.el.createDiv({ cls: "canvas-node-container" });
    this.contentEl = this.containerEl.createDiv({ cls: "canvas-node-content" });
    const resizer = this.el.createDiv({ cls: "canvas-node-resizer" });
    for (const h of RESIZE_HANDLES) resizer.createDiv({ cls: `canvas-node-resizer-handle mod-${h}`, attr: { "data-resize": h } });
    for (const side of SIDES) this.el.createDiv({ cls: `canvas-node-connection-point mod-${side}`, attr: { "data-side": side } });
    this.update(data, 0);
  }

  // internal (used by: the canvas internal API's `node.child.editor`)
  get activeEditor() {
    return this.editor?.editor ?? null;
  }

  get isGroup() {
    return this.data.type === "group";
  }

  rect() {
    const d = this.data;
    return { x: d.x, y: d.y, width: d.width, height: d.height };
  }

  file(): TFile | null {
    if (this.data.type !== "file" || !this.data.file) return null;
    return this.host.app.vault.getFileByPath(this.data.file);
  }

  /** Apply geometry, colour and (when changed) content. */
  update(data: CanvasNodeData, z: number) {
    this.data = data;
    this.layout(z);
    const el = this.el;
    el.toggleClass("canvas-node-group", data.type === "group");
    el.toggleClass("canvas-node-file", data.type === "file");
    el.toggleClass("canvas-node-text", data.type === "text");
    el.toggleClass("canvas-node-link", data.type === "link");
    for (let i = 1; i <= 6; i++) el.removeClass(`mod-canvas-color-${i}`);
    const color = cssColor(data.color);
    el.toggleClass("is-themed", !!color);
    if (isPresetColor(data.color)) el.addClass(`mod-canvas-color-${data.color}`);
    if (color) el.style.setProperty("--canvas-color", color);
    else el.style.removeProperty("--canvas-color");

    const key = JSON.stringify([data.type, data.text, data.file, data.subpath, data.url, data.label, data.background, data.backgroundStyle]);
    if (key !== this.contentKey && !this.editing) {
      this.contentKey = key;
      void this.renderContent();
    }
  }

  layout(z?: number) {
    const d = this.data;
    const s = this.el.style;
    s.transform = `translate(${d.x}px, ${d.y}px)`;
    s.width = `${d.width}px`;
    s.height = `${d.height}px`;
    if (z !== undefined) s.zIndex = String(z);
  }

  /** Force the content to render again (file changed on disk, settings…). */
  invalidate() {
    this.contentKey = "";
    this.update(this.data, Number(this.el.style.zIndex) || 0);
  }

  destroy() {
    this.stopEditing(false);
    this.disposeComponent();
    this.el.remove();
  }

  private disposeComponent() {
    if (this.component) {
      this.host.owner.removeChild(this.component);
      this.component = null;
    }
  }

  private freshComponent(): Component {
    this.disposeComponent();
    const c = new Component();
    this.host.owner.addChild(c);
    this.component = c;
    return c;
  }

  // ---- content ----------------------------------------------------------------------------

  async renderContent() {
    const d = this.data;
    const app = this.host.app;
    const component = this.freshComponent();
    this.contentEl.empty();
    this.contentEl.className = "canvas-node-content";
    this.labelEl?.remove();
    this.labelEl = null;
    this.containerEl.style.removeProperty("background-image");
    this.containerEl.removeClass("mod-background-cover", "mod-background-ratio", "mod-background-repeat");

    switch (d.type) {
      case "text":
        await this.renderMarkdownInto(d.text ?? "", this.host.file?.path ?? "", component);
        break;
      case "file":
        await this.renderFile(component);
        break;
      case "link":
        this.renderLink(d.url ?? "");
        break;
      case "group": {
        this.contentEl.addClass("canvas-group-content");
        this.labelEl = this.el.createDiv({ cls: "canvas-group-label", text: d.label ?? "" });
        this.labelEl.toggleClass("is-empty", !d.label);
        if (d.background) {
          const bg = app.vault.getFileByPath(d.background) as TFile | null;
          if (bg) {
            this.containerEl.style.backgroundImage = `url("${app.vault.getResourcePath(bg)}")`;
            this.containerEl.addClass(`mod-background-${d.backgroundStyle ?? "cover"}`);
          }
        }
        break;
      }
      default:
        this.contentEl.createDiv({ cls: "canvas-node-placeholder", text: `Unsupported card type “${d.type}”.` });
    }
  }

  private async renderMarkdownInto(markdown: string, sourcePath: string, component: Component) {
    this.contentEl.addClass("markdown-embed");
    const embed = this.contentEl.createDiv({ cls: "markdown-embed-content node-insert-event" });
    const preview = embed.createDiv({ cls: "markdown-preview-view markdown-rendered node-insert-event show-indentation-guide allow-fold-headings allow-fold-lists" });
    const sizer = preview.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    try {
      await MarkdownRenderer.render(this.host.app, markdown, sizer, sourcePath, component);
    } catch (e) {
      sizer.createEl("pre", { cls: "vault-render-error", text: String((e as Error)?.message ?? e) });
    }
  }

  private async renderFile(component: Component) {
    const d = this.data;
    const app = this.host.app;
    const file = this.file();
    const name = d.file ?? "";
    this.labelEl = this.el.createDiv({ cls: "canvas-node-label" });
    this.labelEl.setText((file ? (file.extension === "md" ? file.basename : file.name) : name.split("/").pop() ?? name) + (d.subpath ?? ""));
    if (!file) {
      this.contentEl.addClass("mod-empty");
      const ph = this.contentEl.createDiv({ cls: "canvas-node-placeholder" });
      setIcon(ph.createDiv({ cls: "canvas-node-placeholder-icon" }), "lucide-file-question");
      ph.createDiv({ text: `“${name}” could not be found.` });
      return;
    }
    const ext = file.extension.toLowerCase();
    if (ext === "md") {
      let text = await app.vault.cachedRead(file);
      if (d.subpath) {
        const cache = app.metadataCache.getFileCache(file);
        const res = cache ? getEngine().resolveSubpath(cache, d.subpath) : null;
        if (res) text = text.slice(res.start.offset, res.end ? res.end.offset : text.length);
        else text = `Unable to find “${d.subpath.slice(1)}” in ${file.basename}.`;
      } else {
        const fm = /^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text);
        if (fm) text = text.slice(fm[0].length);
      }
      if (this.component !== component) return;
      this.contentEl.empty();
      await this.renderMarkdownInto(text, file.path, component);
      return;
    }
    const src = app.vault.getResourcePath(file);
    if (IMAGE_EXTENSIONS.includes(ext)) {
      this.contentEl.addClass("media-embed", "image-embed");
      this.contentEl.createEl("img", { attr: { src, alt: file.name, draggable: "false" } });
      return;
    }
    if (VIDEO_EXTENSIONS.includes(ext)) {
      this.contentEl.addClass("media-embed", "video-embed");
      this.contentEl.createEl("video", { attr: { src, controls: "", preload: "metadata" } });
      return;
    }
    if (AUDIO_EXTENSIONS.includes(ext)) {
      this.contentEl.addClass("media-embed", "audio-embed");
      this.contentEl.createEl("audio", { attr: { src, controls: "" } });
      return;
    }
    const creator = app.embedRegistry?.getEmbedCreator(file);
    if (creator) {
      const holder = this.contentEl.createDiv({ cls: `internal-embed file-embed is-loaded mod-${ext}`, attr: { src: file.path } });
      try {
        const embed = creator({ app, containerEl: holder, linktext: file.path, sourcePath: this.host.file?.path ?? "", depth: 1 }, file, d.subpath ?? "");
        if (embed instanceof Component) component.addChild(embed);
        await embed.loadFile?.();
      } catch (e) {
        holder.setText(String((e as Error)?.message ?? e));
      }
      return;
    }
    if (ext === "pdf") {
      this.contentEl.addClass("pdf-embed");
      this.contentEl.createEl("iframe", { attr: { src, title: file.name } });
      return;
    }
    const generic = this.contentEl.createDiv({ cls: "canvas-node-placeholder file-embed mod-generic" });
    setIcon(generic.createDiv({ cls: "canvas-node-placeholder-icon" }), "lucide-file");
    generic.createDiv({ text: file.name });
  }

  private renderLink(url: string) {
    this.contentEl.addClass("canvas-link");
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* not a URL */
    }
    const card = this.contentEl.createDiv({ cls: "vault-canvas-link-card" });
    setIcon(card.createDiv({ cls: "vault-canvas-link-icon" }), "lucide-globe");
    card.createDiv({ cls: "vault-canvas-link-host", text: host });
    card.createDiv({ cls: "vault-canvas-link-url", text: url });
    if (/^https?:\/\//i.test(url)) {
      const load = () => {
        this.contentEl.removeClass("is-deferred");
        this.contentEl.createEl("iframe", {
          attr: { src: url, loading: "lazy", sandbox: "allow-scripts allow-same-origin allow-popups allow-forms", referrerpolicy: "no-referrer", title: host },
        });
      };
      // Same privacy default as embeds in notes: the page loads when asked, not when the canvas opens.
      if (embedOptions.clickToLoad) {
        this.contentEl.addClass("is-deferred");
        const btn = card.createEl("button", { cls: "vault-canvas-link-load", text: "Load page", attr: { type: "button", "aria-label": `Load ${host} in this card` } });
        btn.addEventListener("pointerdown", (e) => e.stopPropagation());
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          btn.remove();
          load();
        });
      } else load();
    }
    this.contentEl.createDiv({ cls: "vault-canvas-link-cover" });
  }

  // ---- editing --------------------------------------------------------------------------------

  canEdit(): boolean {
    if (this.host.readOnly) return false;
    if (this.data.type === "text") return true;
    return this.data.type === "file" && this.file()?.extension === "md";
  }

  async startEditing() {
    if (this.editing || !this.canEdit()) return;
    const app = this.host.app;
    const d = this.data;
    let initial = d.text ?? "";
    let target: TFile | null = null;
    if (d.type === "file") {
      target = this.file();
      if (!target) return;
      initial = await app.vault.read(target);
      this.fileWrite = debounce((f: TFile, text: string) => void app.vault.modify(f, text), 800, true);
    }
    this.editing = true;
    this.el.addClass("is-editing");
    this.disposeComponent();
    this.contentEl.empty();
    this.contentEl.className = "canvas-node-content markdown-embed";
    this.disposeComponent();
    const onChange = (text: string) => {
      if (target) this.fileWrite?.(target, text);
      else this.host.onNodeTextEdited(this, text);
    };
    try {
      const info = new CanvasEditorInfo(app, () => target ?? this.host.file, onChange);
      this.host.owner.addChild(info);
      this.component = info;
      this.editor = createMarkdownEditor(this.contentEl, createCanvasEditorHost(info), initial, {});
      info.editor = this.editor.editor;
      this.editor.containerEl.addClass("is-live-preview");
      this.editor.view.dom.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.stopEditing(true);
        }
      });
      this.editor.view.focus();
      const end = this.editor.view.state.doc.length;
      this.editor.view.dispatch({ selection: { anchor: end } });
    } catch (e) {
      console.warn("Canvas: the Markdown editor failed; using a plain text area", e);
      this.editor = null;
      const ta = this.contentEl.createEl("textarea", { cls: "vault-canvas-textarea" });
      ta.value = initial;
      ta.addEventListener("input", () => onChange(ta.value));
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.stopEditing(true);
        }
        e.stopPropagation();
      });
      this.textarea = ta;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }

  stopEditing(notify = true) {
    if (!this.editing) return;
    const text = this.editor ? this.editor.view.state.doc.toString() : this.textarea ? this.textarea.value : null;
    const target = this.data.type === "file" ? this.file() : null;
    if (target && text !== null && this.fileWrite) {
      this.fileWrite.cancel();
      void this.host.app.vault.modify(target, text);
    } else if (text !== null) {
      this.host.onNodeTextEdited(this, text);
    }
    this.editor?.destroy();
    this.editor = null;
    this.textarea = null;
    this.fileWrite = null;
    this.editing = false;
    this.el.removeClass("is-editing");
    this.contentKey = "";
    this.update(this.data, Number(this.el.style.zIndex) || 0);
    if (notify) this.host.onEditingEnd(this);
  }
}
