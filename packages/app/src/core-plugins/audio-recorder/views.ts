/**
 * Tabs for media files: Obsidian's `image`, `audio` and `video` view types.
 */
import { FileView } from "../../obsidian/workspace/view";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import type { TFile } from "../../obsidian/vault/files";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, isAudioOnlyName } from "./embeds";
import { openLightbox } from "./lightbox";

abstract class MediaFileView extends FileView {
  protected abstract extensions: string[];

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  override canAcceptExtension(extension: string): boolean {
    return this.extensions.includes(extension.toLowerCase());
  }

  override onload(): void {
    super.onload();
    this.registerEvent(
      this.app.vault.on("modify", (f: TFile) => {
        if (f === this.file) void this.onLoadFile(f);
      }),
    );
  }

  override async onUnloadFile(_file: TFile): Promise<void> {
    this.contentEl.empty();
  }
}

export class ImageView extends MediaFileView {
  protected extensions = IMAGE_EXTENSIONS;
  override icon = "lucide-image";

  getViewType(): string {
    return "image";
  }

  override getIcon(): string {
    return "lucide-image";
  }

  override async onLoadFile(file: TFile): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("vault-media-view");
    const container = el.createDiv({ cls: "image-container" });
    const img = container.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), alt: file.name, draggable: "false" } });
    img.addEventListener("click", () => openLightbox(this.app, [{ src: img.currentSrc || img.src, name: file.name }], 0));
  }
}

export class AudioView extends MediaFileView {
  protected extensions = AUDIO_EXTENSIONS;
  override icon = "lucide-file-audio";

  getViewType(): string {
    return "audio";
  }

  override getIcon(): string {
    return "lucide-file-audio";
  }

  override async onLoadFile(file: TFile): Promise<void> {
    renderAudio(this.contentEl, this.app.vault.getResourcePath(file));
  }
}

function renderAudio(el: HTMLElement, src: string) {
  el.empty();
  el.addClass("vault-media-view");
  const container = el.createDiv({ cls: "audio-container" });
  container.createEl("audio", { attr: { controls: "", src, preload: "metadata" } });
}

export class VideoView extends MediaFileView {
  protected extensions = VIDEO_EXTENSIONS;
  override icon = "lucide-file-video";

  getViewType(): string {
    return "video";
  }

  override getIcon(): string {
    return "lucide-file-video";
  }

  override async onLoadFile(file: TFile): Promise<void> {
    const el = this.contentEl;
    const src = this.app.vault.getResourcePath(file);
    if (isAudioOnlyName(file)) {
      renderAudio(el, src);
      return;
    }
    el.empty();
    el.addClass("vault-media-view");
    const container = el.createDiv({ cls: "video-container" });
    const video = container.createEl("video", { attr: { controls: "", src, preload: "metadata" } });
    if (file.extension.toLowerCase() === "webm") {
      video.addEventListener("loadedmetadata", () => {
        if (video.videoWidth === 0 && video.isConnected) renderAudio(el, src);
      }, { once: true });
    }
  }
}
