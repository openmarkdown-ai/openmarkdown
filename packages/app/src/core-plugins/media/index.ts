/**
 * Media (`media`) — a player pane for YouTube, Vimeo and audio/video files,
 * Media Extended–compatible timestamp links, and playback commands. Off by
 * default; it steps aside when the Media Extended plugin is enabled.
 *
 * External embeds (`external-embeds`, hidden, always on) — `![](youtube url)`
 * and friends render as embeds in the reading view and Live Preview, as in
 * Obsidian. It also provides Obsidian's `editor:download-attachments`.
 */
import { EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Notice } from "../../obsidian/ui/notice";
import { Modal } from "../../obsidian/ui/modal";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { parseLinktext } from "../../obsidian/util";
import { registerExternalEmbedHandler } from "../../obsidian/markdown/renderer";
import { externalEmbedRenderers } from "../../editor/live-preview/widgets";
import { clickableTokenAt } from "../../editor/live-preview/links";
import { editorLivePreviewField } from "../../editor/fields";
import { hostFacet, sourcePathOf } from "../../editor/facets";
import type { TFile } from "../../obsidian/vault/files";
import { communityPluginEnabled } from "../smart-paste/network";
import { downloadRemoteImagesInFile } from "../local-images/download";
import { createExternalEmbed, embedOptions } from "./embeds";
import { parseTempFrag, webTimestampLink, formatDuration, toTempFragString } from "./timefrag";
import { MediaPlayerView, VIEW_TYPE_MEDIA, sourceFromUrl } from "./view";
import type { MediaSource } from "./player";
import { classifyUrl } from "./urls";

export const MEDIA_EXTENDED_ID = "media-extended";
const AUDIO_EXT = ["mp3", "wav", "m4a", "ogg", "oga", "flac", "3gp", "opus", "aac"];
const VIDEO_EXT = ["mp4", "webm", "ogv", "mov", "mkv", "m4v"];

export interface MediaOptions {
  /** Media Extended's `timestampTemplate` */
  timestampTemplate: string;
  /** Media Extended's `screenshotTemplate` */
  screenshotTemplate: string;
  /** Media Extended's `timestampOffset` (seconds) */
  timestampOffset: number;
  /** Media Extended's `insertBefore` */
  insertBefore: boolean;
  seekStep: number;
  /** Media Extended's `speedStep` */
  speedStep: number;
  /** Load YouTube/Vimeo/X embeds only after a click (default: on — nothing loads from those sites until asked) */
  clickToLoadEmbeds: boolean;
}

export const DEFAULT_MEDIA_OPTIONS: MediaOptions = {
  timestampTemplate: "\n- {{TIMESTAMP}} ",
  screenshotTemplate: "\n- !{{SCREENSHOT}} {{TIMESTAMP}} ",
  timestampOffset: 0,
  insertBefore: false,
  seekStep: 5,
  speedStep: 0.1,
  clickToLoadEmbeds: true,
};

/** The external-embeds plugin's "click to load" option (on unless the user turned it off). */
function externalEmbedsClickToLoad(app: any): boolean {
  return app.internalPlugins?.getPluginById?.("external-embeds")?.instance?.options?.clickToLoad !== false;
}

/** Applies "Click to load embeds" everywhere and saves it; open notes re-render. */
export function setClickToLoadEmbeds(app: any, on: boolean) {
  embedOptions.clickToLoad = on;
  const ext = app.internalPlugins?.getPluginById?.("external-embeds")?.instance;
  if (ext && ext.options.clickToLoad !== on) {
    ext.options.clickToLoad = on;
    void ext.saveOptions?.();
  }
  const media = app.internalPlugins?.getPluginById?.("media")?.instance;
  if (media && media.options.clickToLoadEmbeds !== on) {
    media.options.clickToLoadEmbeds = on;
    void media.saveOptions?.();
  }
  app.workspace?.updateOptions?.();
  for (const leaf of app.workspace?.getLeavesOfType?.("markdown") ?? []) leaf.view?.previewMode?.rerender?.(true);
}

export class MediaPlugin extends Plugin {
  instance!: any;
  activeView: MediaPlayerView | null = null;

  get options(): MediaOptions {
    return this.instance.options as MediaOptions;
  }

  /** Media Extended handles all of this when it is enabled. */
  get standingAside(): boolean {
    return communityPluginEnabled(this.app, MEDIA_EXTENDED_ID);
  }

  override async onload() {
    this.registerView(VIEW_TYPE_MEDIA, (leaf) => new MediaPlayerView(leaf, this));
    embedOptions.clickToLoad = this.options.clickToLoadEmbeds !== false;
    embedOptions.openInPlayer = (url) => void this.openMedia(sourceFromUrl(url), undefined);
    this.register(() => {
      embedOptions.clickToLoad = externalEmbedsClickToLoad(this.app);
      embedOptions.openInPlayer = null;
    });

    const withPlayer = (run: (view: MediaPlayerView) => void) => (checking: boolean) => {
      if (this.standingAside) return false;
      const view = this.targetView();
      if (!view?.player) return false;
      if (!checking) run(view);
      return true;
    };

    this.addCommand({ id: "media:open", name: "Open media…", icon: "lucide-clapperboard", checkCallback: (checking) => !this.standingAside && (checking || (new OpenMediaModal(this.app, this).open(), true)) });
    this.addCommand({ id: "media:take-timestamp", name: "Insert timestamp link", icon: "lucide-clock", checkCallback: (checking) => this.takeTimestamp(checking) });
    this.addCommand({ id: "media:play-pause", name: "Play or pause", checkCallback: withPlayer((v) => v.togglePlay()) });
    this.addCommand({ id: "media:seek-back-5", name: "Seek back", checkCallback: withPlayer((v) => v.seekBy(-this.options.seekStep)) });
    this.addCommand({ id: "media:seek-forward-5", name: "Seek forward", checkCallback: withPlayer((v) => v.seekBy(this.options.seekStep)) });
    this.addCommand({ id: "media:speed-up", name: "Speed up", checkCallback: withPlayer((v) => v.changeRate(this.options.speedStep)) });
    this.addCommand({ id: "media:speed-down", name: "Slow down", checkCallback: withPlayer((v) => v.changeRate(-this.options.speedStep)) });
    this.addCommand({ id: "media:speed-reset", name: "Reset playback speed", checkCallback: withPlayer((v) => v.setRate(1)) });
    this.addCommand({
      id: "media:save-screenshot",
      name: "Save screenshot and insert link",
      checkCallback: (checking) => {
        if (this.standingAside) return false;
        const view = this.targetView();
        if (!view?.player?.canScreenshot() || !this.noteEditor()) return false;
        if (!checking) void this.saveScreenshot(view);
        return true;
      },
    });

    this.instance.openMedia = (urlOrPath: string, time?: number) => this.openByText(urlOrPath, time);
    this.instance.getPlayer = () => this.targetView()?.player ?? null;

    // Timestamp links: a click seeks the player instead of navigating.
    this.registerDomEvent(document, "click", (evt: MouseEvent) => this.onDocumentClick(evt), true);
    this.registerEditorExtension(
      Prec.highest(
        EditorView.domEventHandlers({
          mousedown: (evt, view) => this.onEditorMouseDown(evt, view),
        }),
      ),
    );

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: any, file: TFile) => {
        if (this.standingAside || !file || !("extension" in file)) return;
        const ext = file.extension.toLowerCase();
        if (!AUDIO_EXT.includes(ext) && !VIDEO_EXT.includes(ext)) return;
        menu.addItem((i: any) => i.setSection("open").setTitle("Open in media player").setIcon("lucide-clapperboard").onClick(() => void this.openMedia(this.sourceFromFile(file), undefined)));
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf: any) => {
        if (leaf?.view instanceof MediaPlayerView) this.activeView = leaf.view;
      }),
    );

    this.addSettingTab(new MediaSettingTab(this.app, this));
  }

  onPlayerChanged(view: MediaPlayerView) {
    this.activeView = view;
  }

  /** The player commands act on: the last one used, else any open player. */
  targetView(): MediaPlayerView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA) as any[];
    const views = leaves.map((l) => l.view).filter((v) => v instanceof MediaPlayerView) as MediaPlayerView[];
    if (this.activeView && views.includes(this.activeView)) return this.activeView;
    return views.find((v) => v.leaf.pinned) ?? views[0] ?? null;
  }

  /** The note timestamps go into: the active editor, else the most recently used Markdown tab. */
  noteEditor(): { editor: any; file: TFile | null } | null {
    const active = this.app.workspace.activeEditor;
    if (active?.editor && active.file) return { editor: active.editor, file: active.file };
    let best: any = null;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown") as any[]) if (!best || (leaf.activeTime ?? 0) > (best.activeTime ?? 0)) best = leaf;
    const view = best?.view;
    return view?.editor ? { editor: view.editor, file: view.file ?? null } : null;
  }

  sourceFromFile(file: TFile): MediaSource {
    return { path: file.path, src: this.app.vault.getResourcePath(file), title: file.name, audio: AUDIO_EXT.includes(file.extension.toLowerCase()) };
  }

  /** Open (or reuse) the player for `source`; seek to `time` when given. */
  async openMedia(source: MediaSource, time: number | undefined): Promise<MediaPlayerView | null> {
    const existing = (this.app.workspace.getLeavesOfType(VIEW_TYPE_MEDIA) as any[]).map((l) => l.view).find((v) => v instanceof MediaPlayerView && v.isSameSource(source)) as MediaPlayerView | undefined;
    if (existing?.player) {
      if (time !== undefined) {
        existing.seekTo(time);
        existing.player.play();
      }
      this.activeView = existing;
      this.app.workspace.revealLeaf?.(existing.leaf);
      return existing;
    }
    const leaf: any = this.targetView()?.leaf ?? this.app.workspace.getLeaf("split", "vertical");
    await leaf.setViewState({ type: VIEW_TYPE_MEDIA, state: { url: source.url, path: source.path, time: time ?? 0 }, active: false });
    const view = leaf.view instanceof MediaPlayerView ? leaf.view : null;
    if (view) this.activeView = view;
    return view;
  }

  async openByText(text: string, time?: number): Promise<MediaPlayerView | null> {
    const trimmed = text.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      const frag = parseTempFrag(new URL(trimmed).hash);
      return this.openMedia(sourceFromUrl(trimmed), time ?? (frag && frag.start >= 0 ? frag.start : undefined));
    }
    const { path, subpath } = parseLinktext(trimmed);
    const file = this.app.metadataCache.getFirstLinkpathDest(path, "") ?? this.app.vault.getFileByPath(path);
    if (!file) {
      new Notice(`“${trimmed}” is not a URL or a file in this vault.`);
      return null;
    }
    const frag = parseTempFrag(subpath);
    return this.openMedia(this.sourceFromFile(file), time ?? (frag && frag.start >= 0 ? frag.start : undefined));
  }

  /** A timestamp link's target, or null when the link is not one. */
  timestampTarget(href: string, sourcePath: string, external: boolean): { source: MediaSource; time: number } | null {
    if (external) {
      const info = classifyUrl(href);
      if (!info || !["youtube", "vimeo", "audio", "video"].includes(info.kind)) return null;
      let hash = "";
      try {
        hash = new URL(href).hash;
      } catch {
        return null;
      }
      const frag = parseTempFrag(hash);
      if (!frag || frag.start < 0) return null;
      return { source: sourceFromUrl(href), time: frag.start };
    }
    const { path, subpath } = parseLinktext(href);
    const frag = parseTempFrag(subpath);
    if (!frag || frag.start < 0 || !path) return null;
    const file: TFile | null = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    if (!file) return null;
    const ext = file.extension.toLowerCase();
    if (!AUDIO_EXT.includes(ext) && !VIDEO_EXT.includes(ext)) return null;
    return { source: this.sourceFromFile(file), time: frag.start };
  }

  private onDocumentClick(evt: MouseEvent) {
    if (evt.button !== 0 || this.standingAside) return;
    const a = (evt.target as HTMLElement | null)?.closest?.<HTMLAnchorElement>("a.external-link, a.internal-link, a[href^='http']");
    if (!a || a.closest(".cm-editor") || !a.closest(".markdown-rendered, .markdown-preview-view, .markdown-embed, .popover")) return;
    const internal = a.hasClass("internal-link");
    const href = internal ? (a.getAttr("data-href") ?? a.getAttr("href") ?? "") : (a.getAttr("href") ?? "");
    const view = a.closest(".workspace-leaf-content");
    const sourcePath = (view && (this.app.workspace.getLeavesOfType("markdown") as any[]).find((l) => l.view?.containerEl === view)?.view?.file?.path) || this.app.workspace.getActiveFile()?.path || "";
    const target = this.timestampTarget(href, sourcePath, !internal);
    if (!target) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();
    void this.openMedia(target.source, target.time);
  }

  private onEditorMouseDown(evt: MouseEvent, view: EditorView): boolean {
    if (evt.button !== 0 || this.standingAside) return false;
    const el = (evt.target as HTMLElement | null)?.closest?.(".cm-underline, .cm-hmd-internal-link, .cm-link, .cm-url, .external-link") as HTMLElement | null;
    if (!el || !view.contentDOM.contains(el)) return false;
    const lp = view.state.field(editorLivePreviewField, false);
    const mod = evt.metaKey || evt.ctrlKey;
    const rendered = lp && (!!el.closest(".cm-underline") || el.classList.contains("external-link"));
    if (!rendered && !mod) return false;
    const pos = view.posAtDOM(el);
    const tok = clickableTokenAt(view.state, pos + (el.classList.contains("external-link") ? -1 : 0));
    if (!tok || tok.type === "tag") return false;
    const target = this.timestampTarget(tok.text, sourcePathOf(view.state.facet(hostFacet)), tok.type === "external-link");
    if (!target) return false;
    evt.preventDefault();
    void this.openMedia(target.source, target.time);
    return true;
  }

  private takeTimestamp(checking: boolean): boolean {
    if (this.standingAside) return false;
    const view = this.targetView();
    const note = this.noteEditor();
    if (!view?.player || !view.source || !note) return false;
    if (checking) return true;
    const text = this.timestampText(view, note.file);
    if (text === null) return true;
    this.insert(note.editor, this.options.timestampTemplate.replace("{{TIMESTAMP}}", text));
    return true;
  }

  timestampText(view: MediaPlayerView, note: TFile | null): string | null {
    const player = view.player!;
    const duration = player.getDuration() || Infinity;
    let time = player.getCurrentTime() + (Number(this.options.timestampOffset) || 0);
    time = Math.min(Math.max(0, time), duration);
    if (time <= 0) {
      new Notice("Playback not started yet");
      return null;
    }
    const source = view.source!;
    if (source.path) {
      const file = this.app.vault.getFileByPath(source.path);
      if (!file) return null;
      const hash = `#${toTempFragString({ start: time, end: -1 })}`;
      return this.app.fileManager.generateMarkdownLink(file, note?.path ?? "", hash, formatDuration(time)).replace(/^!/, "");
    }
    const info = classifyUrl(source.url ?? "");
    return webTimestampLink(source.url ?? source.src, time, info?.kind === "youtube" ? info.id! : null);
  }

  private insert(editor: any, text: string) {
    const cursor = editor.getCursor();
    if (this.options.insertBefore) {
      // Media Extended's "insert before cursor": the text lands before the caret, which stays after it.
      editor.replaceRange(text, cursor);
      editor.setCursor(editor.offsetToPos(editor.posToOffset(cursor) + text.length));
    } else {
      editor.replaceSelection(text);
    }
    editor.focus?.();
  }

  private async saveScreenshot(view: MediaPlayerView) {
    const note = this.noteEditor();
    const media = (view.player as any)?.media as HTMLVideoElement | undefined;
    if (!note || !media) return;
    const canvas = document.createElement("canvas");
    canvas.width = media.videoWidth;
    canvas.height = media.videoHeight;
    canvas.getContext("2d")!.drawImage(media, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.9));
    if (!blob) {
      new Notice("Could not capture this frame.");
      return;
    }
    const base = (view.source?.title ?? "media").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|#^[\]]/g, " ");
    const name = `${base}-${formatDuration(media.currentTime).replace(/:/g, "-")}.webp`;
    const path = await this.app.fileManager.getAvailablePathForAttachment(name, note.file?.path ?? "");
    const file = await this.app.vault.createBinary(path, await blob.arrayBuffer());
    const shot = this.app.fileManager.generateMarkdownLink(file, note.file?.path ?? "").replace(/^!/, "");
    const ts = this.timestampText(view, note.file) ?? "";
    this.insert(note.editor, this.options.screenshotTemplate.replace("{{SCREENSHOT}}", shot).replace("{{TIMESTAMP}}", ts));
  }
}

class OpenMediaModal extends Modal {
  constructor(
    app: any,
    private plugin: MediaPlugin,
  ) {
    super(app);
  }
  override onOpen() {
    this.setTitle("Open media");
    this.contentEl.addClass("vault-media-open-modal");
    let value = "";
    const files = (this.app.vault.getFiles() as TFile[]).filter((f) => AUDIO_EXT.includes(f.extension.toLowerCase()) || VIDEO_EXT.includes(f.extension.toLowerCase()));
    const submit = async () => {
      if (!value.trim()) return;
      this.close();
      await this.plugin.openByText(value);
    };
    new Setting(this.contentEl)
      .setName("Link or file")
      .setDesc("A YouTube or Vimeo link, a link to an audio or video file, or a media file in this vault.")
      .addText((t) => {
        t.setPlaceholder("https://www.youtube.com/watch?v=…").onChange((v) => (value = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void submit();
        });
        t.inputEl.setAttr("list", "vault-media-files");
        window.setTimeout(() => t.inputEl.focus(), 0);
      });
    const list = this.contentEl.createEl("datalist", { attr: { id: "vault-media-files" } });
    for (const f of files) list.createEl("option", { attr: { value: f.path } });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("Open").setCta().onClick(() => void submit()));
  }
  override onClose() {
    this.contentEl.empty();
  }
}

class MediaSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: MediaPlugin,
  ) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();
    if (this.owner.standingAside) {
      containerEl.createDiv({ cls: "setting-item-description vault-standing-aside", text: "Handled by Media Extended: its player and timestamp links are used while that plugin is enabled." });
    }
    new Setting(containerEl).setName("Timestamps").setHeading();
    new Setting(containerEl)
      .setName("Timestamp template")
      .setDesc("Text inserted by “Insert timestamp link”. {{TIMESTAMP}} is the link. Same setting as Media Extended.")
      .addTextArea((t) => t.setValue(o.timestampTemplate).onChange((v) => ((o.timestampTemplate = v), save())));
    new Setting(containerEl)
      .setName("Timestamp offset")
      .setDesc("Seconds added to the current time (negative to go back).")
      .addText((t) => t.setValue(String(o.timestampOffset)).onChange((v) => ((o.timestampOffset = Number(v) || 0), save())));
    new Setting(containerEl)
      .setName("Insert before cursor")
      .setDesc("Put the timestamp before the caret instead of replacing the selection.")
      .addToggle((t) => t.setValue(o.insertBefore).onChange((v) => ((o.insertBefore = v), save())));
    new Setting(containerEl).setName("Playback").setHeading();
    new Setting(containerEl)
      .setName("Seek step")
      .setDesc("Seconds moved by “Seek back” and “Seek forward”.")
      .addText((t) => t.setValue(String(o.seekStep)).onChange((v) => ((o.seekStep = Math.max(1, Number(v) || 5)), save())));
    new Setting(containerEl)
      .setName("Speed step")
      .setDesc("Change in playback rate for “Speed up” and “Slow down”.")
      .addText((t) => t.setValue(String(o.speedStep)).onChange((v) => ((o.speedStep = Math.max(0.05, Number(v) || 0.1)), save())));
    new Setting(containerEl).setName("Embeds").setHeading();
    new Setting(containerEl)
      .setName("Click to load embeds")
      .setDesc("On: YouTube, Vimeo and X posts, remote PDFs and link-card images load from those sites only after you click them. Off: they load as soon as a note is opened, which tells those sites what you are reading.")
      .addToggle((t) => t.setValue(o.clickToLoadEmbeds !== false).onChange((v) => setClickToLoadEmbeds(this.app, v)));
    new Setting(containerEl)
      .setName("Import settings from Media Extended")
      .setDesc("Reads .obsidian/plugins/media-extended/data.json.")
      .addButton((b) =>
        b.setButtonText("Import").onClick(async () => {
          const imported = await importMediaExtended(this.app, o);
          if (imported) save();
          new Notice(imported ? "Imported Media Extended settings." : "No Media Extended settings found in this vault.");
          this.display();
        }),
      );
    new Setting(containerEl)
      .setName("Transcripts")
      .setDesc("YouTube transcripts are not fetched: YouTube's caption endpoints do not allow a web page to read them.");
  }
}

async function importMediaExtended(app: any, o: MediaOptions): Promise<boolean> {
  const path = `${app.vault.configDir}/plugins/${MEDIA_EXTENDED_ID}/data.json`;
  try {
    if (!(await app.vault.adapter.exists(path))) return false;
    const data = JSON.parse(await app.vault.adapter.read(path));
    if (typeof data.timestampTemplate === "string") o.timestampTemplate = data.timestampTemplate;
    if (typeof data.screenshotTemplate === "string") o.screenshotTemplate = data.screenshotTemplate;
    if (typeof data.timestampOffset === "number") o.timestampOffset = data.timestampOffset;
    if (typeof data.insertBefore === "boolean") o.insertBefore = data.insertBefore;
    if (typeof data.speedStep === "number") o.speedStep = data.speedStep;
    return true;
  } catch {
    return false;
  }
}

/** Hidden, always-on: Obsidian's native external embeds and `editor:download-attachments`. */
class ExternalEmbedsPlugin extends Plugin {
  instance!: any;
  override onload() {
    // Media's own copy of the option wins while Media is on.
    const media = this.app.internalPlugins?.getPluginById?.("media");
    embedOptions.clickToLoad = media?.enabled ? media.instance.options.clickToLoadEmbeds !== false : this.instance?.options?.clickToLoad !== false;
    if (this.instance) this.instance.setClickToLoad = (on: boolean) => setClickToLoadEmbeds(this.app, on);
    this.register(registerExternalEmbedHandler((url, alt) => createExternalEmbed(url, alt)));
    const renderer = (url: string, alt: string) => createExternalEmbed(url, alt);
    externalEmbedRenderers.push(renderer);
    this.register(() => externalEmbedRenderers.remove(renderer));
    this.app.workspace.updateOptions?.();

    if (!this.app.commands.findCommand?.("editor:download-attachments") && !this.app.commands.commands?.["editor:download-attachments"]) {
      this.addCommand({
        id: "editor:download-attachments",
        name: "Download attachments for current file",
        checkCallback: (checking: boolean) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "md") return false;
          if (!checking) void downloadRemoteImagesInFile(this.app, file, { report: true });
          return true;
        },
      });
    }
  }
}

export const media: CorePluginDefinition = {
  id: "media",
  name: "Media",
  description: "Play YouTube, Vimeo, audio and video beside a note, and insert timestamp links that seek the player.",
  icon: "lucide-clapperboard",
  defaultOn: false,
  defaultOptions: { ...DEFAULT_MEDIA_OPTIONS },
  create: (app) => new MediaPlugin(app, { id: "media", name: "Media", version: "", minAppVersion: "", author: "", description: "" }),
};

export const externalEmbeds = {
  id: "external-embeds",
  name: "External embeds",
  description: "Render YouTube, Vimeo, X posts and remote media linked with ![](url).",
  icon: "lucide-youtube",
  defaultOn: true,
  hidden: true,
  defaultOptions: { clickToLoad: true },
  create: (app: any) => new ExternalEmbedsPlugin(app, { id: "external-embeds", name: "External embeds", version: "", minAppVersion: "", author: "", description: "" }),
} as CorePluginDefinition;
