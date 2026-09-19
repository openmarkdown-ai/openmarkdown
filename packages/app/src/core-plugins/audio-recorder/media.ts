/**
 * Media support that Obsidian builds into the app: embeds and tabs for
 * images, audio, video and PDF. Loaded as an always-on, hidden core plugin so
 * it is torn down cleanly and a community plugin can still replace a type.
 */
import { Plugin } from "../../obsidian/plugin";
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  PDF_EXTENSIONS,
  VIDEO_EXTENSIONS,
  audioEmbedCreator,
  imageEmbedCreator,
  pdfEmbedCreator,
  videoEmbedCreator,
} from "./embeds";
import { PdfView } from "./pdf-view";
import { AudioView, ImageView, VideoView } from "./views";

export class MediaViewsPlugin extends Plugin {
  instance!: any;

  override async onload() {
    const registry = this.app.embedRegistry;
    const embeds: [string[], unknown][] = [
      [IMAGE_EXTENSIONS, imageEmbedCreator],
      [AUDIO_EXTENSIONS, audioEmbedCreator],
      [VIDEO_EXTENSIONS, videoEmbedCreator],
      [PDF_EXTENSIONS, pdfEmbedCreator],
    ];
    for (const [exts, creator] of embeds) {
      // Leave extensions a community plugin claimed first alone.
      const free = exts.filter((e) => !registry.isExtensionRegistered(e));
      registry.registerExtensions(free, creator);
      this.register(() => registry.unregisterExtensions(free));
    }

    const views: [string, string[], (leaf: any) => any][] = [
      ["image", IMAGE_EXTENSIONS, (leaf) => new ImageView(leaf)],
      ["audio", AUDIO_EXTENSIONS, (leaf) => new AudioView(leaf)],
      ["video", VIDEO_EXTENSIONS, (leaf) => new VideoView(leaf)],
      ["pdf", PDF_EXTENSIONS, (leaf) => new PdfView(leaf)],
    ];
    for (const [type, exts, create] of views) {
      try {
        this.registerView(type, create);
        const free = exts.filter((e) => !this.app.viewRegistry.isExtensionRegistered(e));
        this.registerExtensions(free, type);
      } catch (e) {
        console.error(`Media view "${type}" could not be registered`, e);
      }
    }
  }
}
