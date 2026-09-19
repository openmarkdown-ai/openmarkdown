/**
 * Embeds of non-Markdown files: `![[pic.png|100x80]]`, `![[rec.webm]]`,
 * `![[clip.mp4]]`, `![[doc.pdf#page=3]]`. Registered on `app.embedRegistry`,
 * which the reading view (and Live Preview) consult for every internal embed.
 */
import { Component } from "../../obsidian/events";
import type { TFile } from "../../obsidian/vault/files";
import { collectImages, openLightbox } from "./lightbox";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"];
export const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "ogg", "3gp", "flac"];
export const VIDEO_EXTENSIONS = ["mp4", "webm", "ogv", "mov", "mkv"];
export const PDF_EXTENSIONS = ["pdf"];

interface EmbedContext {
  app: any;
  containerEl: HTMLElement;
  linktext: string;
  sourcePath: string;
  showInline?: boolean;
  depth?: number;
}

/** `100` → width; `100x200` → width and height. Anything else is alt text. */
export function parseSize(alt: string): { width?: number; height?: number } | null {
  const m = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(alt);
  if (!m) return null;
  return { width: Number(m[1]), height: m[2] ? Number(m[2]) : undefined };
}

/** A webm file is either audio (the recorder's output) or video; the container does not say which. */
export function isAudioOnlyName(file: TFile): boolean {
  return file.extension.toLowerCase() === "webm" && file.basename.startsWith("Recording ");
}

/**
 * Called after an audio or video embed renders, so features can add controls
 * to it (Transcribe adds its button). Hooks return nothing; errors are ignored.
 */
export const mediaEmbedHooks: ((el: HTMLElement, file: TFile, ctx: { app: any; sourcePath: string }) => void)[] = [];

function runMediaEmbedHooks(el: HTMLElement, file: TFile, ctx: EmbedContext) {
  for (const hook of mediaEmbedHooks) {
    try {
      hook(el, file, { app: ctx.app, sourcePath: ctx.sourcePath });
    } catch (e) {
      console.error(e);
    }
  }
}

abstract class FileEmbed extends Component {
  constructor(
    protected ctx: EmbedContext,
    protected file: TFile,
    protected subpath: string,
  ) {
    super();
  }
  get app(): any {
    return this.ctx.app;
  }
  get containerEl(): HTMLElement {
    return this.ctx.containerEl;
  }
  abstract loadFile(): void | Promise<void>;
  override onload(): void {
    // A modified file gets a new resource URL (it carries the mtime).
    this.registerEvent(
      this.app.vault.on("modify", (f: TFile) => {
        if (f === this.file) void this.loadFile();
      }),
    );
  }
}

class ImageEmbed extends FileEmbed {
  override loadFile() {
    const el = this.containerEl;
    el.addClasses(["media-embed", "image-embed", "is-loaded"]);
    const alt = el.getAttr("alt") ?? "";
    el.empty();
    const img = el.createEl("img", { attr: { src: this.app.vault.getResourcePath(this.file), alt: parseSize(alt) || !alt ? this.file.name : alt } });
    const size = parseSize(alt);
    if (size?.width) img.setAttr("width", String(size.width));
    if (size?.height) img.setAttr("height", String(size.height));
    img.addEventListener("click", (evt) => {
      if (evt.button !== 0 || evt.ctrlKey || evt.metaKey) return;
      // Inside the editor a click places the caret; let the widget decide. In reading view open the viewer.
      evt.preventDefault();
      evt.stopPropagation();
      const { images, index } = collectImages(img);
      openLightbox(this.app, images, index);
    });
  }
}

class AudioEmbed extends FileEmbed {
  override loadFile() {
    const el = this.containerEl;
    el.removeClass("video-embed");
    el.addClasses(["media-embed", "audio-embed", "is-loaded"]);
    el.empty();
    el.createEl("audio", { attr: { controls: "", src: this.app.vault.getResourcePath(this.file), preload: "metadata" } });
    runMediaEmbedHooks(el, this.file, this.ctx);
  }
}

class VideoEmbed extends FileEmbed {
  override loadFile() {
    const el = this.containerEl;
    if (isAudioOnlyName(this.file)) {
      new AudioEmbed(this.ctx, this.file, this.subpath).loadFile();
      return;
    }
    el.removeClass("audio-embed");
    el.addClasses(["media-embed", "video-embed", "is-loaded"]);
    el.empty();
    const src = this.app.vault.getResourcePath(this.file);
    const video = el.createEl("video", { attr: { controls: "", src, preload: "metadata" } });
    const size = parseSize(el.getAttr("alt") ?? "");
    if (size?.width) video.setAttr("width", String(size.width));
    if (size?.height) video.setAttr("height", String(size.height));
    runMediaEmbedHooks(el, this.file, this.ctx);
    if (this.file.extension.toLowerCase() === "webm") {
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (video.videoWidth !== 0) return;
          el.removeClass("video-embed");
          el.addClass("audio-embed");
          const audio = createEl("audio", { attr: { controls: "", src, preload: "metadata" } });
          video.replaceWith(audio);
        },
        { once: true },
      );
    }
  }
}

/** `#page=3`, `#height=400`, `#page=3&height=400` */
export function parsePdfSubpath(subpath: string): { page?: number; height?: number } {
  const out: { page?: number; height?: number } = {};
  const params = new URLSearchParams(subpath.replace(/^#/, ""));
  const page = Number(params.get("page"));
  const height = Number(params.get("height"));
  if (Number.isFinite(page) && page > 0) out.page = Math.floor(page);
  if (Number.isFinite(height) && height > 0) out.height = height;
  return out;
}

class PdfEmbed extends FileEmbed {
  override loadFile() {
    const el = this.containerEl;
    el.addClasses(["pdf-embed", "is-loaded"]);
    el.empty();
    const { page, height } = parsePdfSubpath(this.subpath);
    const src = this.app.vault.getResourcePath(this.file) + (page ? `#page=${page}` : "");
    const iframe = el.createEl("iframe", { cls: "vault-pdf-embed-frame", attr: { src, title: this.file.name, loading: "lazy" } });
    if (height) iframe.style.height = `${height}px`;
  }
}

type EmbedClass = new (ctx: EmbedContext, file: TFile, subpath: string) => FileEmbed;

function creator(cls: EmbedClass) {
  return (ctx: EmbedContext, file: TFile, subpath: string) => new cls(ctx, file, subpath);
}

export const imageEmbedCreator = creator(ImageEmbed);
export const audioEmbedCreator = creator(AudioEmbed);
export const videoEmbedCreator = creator(VideoEmbed);
export const pdfEmbedCreator = creator(PdfEmbed);
