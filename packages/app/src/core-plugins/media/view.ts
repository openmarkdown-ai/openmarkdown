/**
 * The media player pane (`media-player`): one player beside the note, driven
 * by the Media commands and by clicks on timestamp links.
 *
 * DOM: `.workspace-leaf-content[data-type="media-player"] > .view-content.vault-media-view`
 * holding `.vault-media-stage` (the player) and `.vault-media-controls`.
 */
import { ItemView } from "../../obsidian/workspace/view";
import { setIcon } from "../../obsidian/ui/icons";
import { formatDuration } from "./timefrag";
import { createPlayer, type MediaPlayer, type MediaSource } from "./player";
import { classifyUrl } from "./urls";

export const VIEW_TYPE_MEDIA = "media-player";

export interface MediaViewHost {
  options: { seekStep: number; speedStep: number };
  onPlayerChanged(view: MediaPlayerView): void;
}

export class MediaPlayerView extends ItemView {
  player: MediaPlayer | null = null;
  source: MediaSource | null = null;
  private stageEl!: HTMLElement;
  private timeEl!: HTMLElement;
  private rateEl!: HTMLElement;
  private playBtn!: HTMLElement;
  private emptyEl!: HTMLElement;
  private pendingTime = 0;

  constructor(
    leaf: any,
    private host: MediaViewHost,
  ) {
    super(leaf);
    this.icon = "lucide-clapperboard";
    this.navigation = false;
  }

  getViewType() {
    return VIEW_TYPE_MEDIA;
  }

  getDisplayText() {
    return this.source?.title ?? "Media player";
  }

  override getState(): Record<string, unknown> {
    if (!this.source) return {};
    return { url: this.source.url, path: this.source.path, time: this.player ? Math.round(this.player.getCurrentTime() * 100) / 100 : this.pendingTime };
  }

  override async setState(state: any, _result: any): Promise<void> {
    const time = typeof state?.time === "number" ? state.time : 0;
    if (typeof state?.path === "string" && state.path) {
      const file = this.app.vault.getFileByPath(state.path);
      if (file) this.loadSource({ path: file.path, src: this.app.vault.getResourcePath(file), title: file.name, audio: ["mp3", "wav", "m4a", "ogg", "flac", "3gp", "oga", "opus", "aac"].includes(file.extension.toLowerCase()) }, time);
    } else if (typeof state?.url === "string" && state.url) {
      this.loadSource(sourceFromUrl(state.url), time);
    }
  }

  override async onOpen() {
    const content = this.contentEl;
    content.empty();
    content.addClass("vault-media-view");
    // Controls sit above the player: the floating status bar covers the bottom edge of a pane.
    const controls = content.createDiv({ cls: "vault-media-controls" });
    this.stageEl = content.createDiv({ cls: "vault-media-stage" });
    this.emptyEl = this.stageEl.createDiv({ cls: "vault-media-empty", text: "Open a video or audio file, or a YouTube or Vimeo link, with “Media: Open media…”." });
    const button = (icon: string, label: string, run: () => void, cls = "") => {
      const b = controls.createEl("button", { cls: `clickable-icon vault-media-button ${cls}`.trim(), attr: { "aria-label": label, type: "button" } });
      setIcon(b, icon);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        run();
      });
      return b;
    };
    button("lucide-rewind", `Back ${this.host.options.seekStep} seconds`, () => this.seekBy(-this.host.options.seekStep), "mod-seek-back");
    this.playBtn = button("lucide-play", "Play", () => this.togglePlay(), "mod-play");
    button("lucide-fast-forward", `Forward ${this.host.options.seekStep} seconds`, () => this.seekBy(this.host.options.seekStep), "mod-seek-forward");
    this.timeEl = controls.createDiv({ cls: "vault-media-time", text: "00:00" });
    controls.createDiv({ cls: "vault-media-spacer" });
    button("lucide-minus", "Slower", () => this.changeRate(-this.host.options.speedStep), "mod-slower");
    this.rateEl = controls.createDiv({ cls: "vault-media-rate", text: "1×", attr: { "aria-label": "Reset speed", role: "button", tabindex: "0" } });
    this.rateEl.addEventListener("click", () => this.setRate(1));
    button("lucide-plus", "Faster", () => this.changeRate(this.host.options.speedStep), "mod-faster");
    button("lucide-clock", "Insert timestamp link", () => this.app.commands.executeCommandById("media:take-timestamp"), "mod-timestamp");

    this.registerDomEvent(content, "keydown", (evt: KeyboardEvent) => {
      if ((evt.target as HTMLElement).closest("input, textarea")) return;
      if (evt.key === " " || evt.key === "k") this.togglePlay();
      else if (evt.key === "ArrowLeft" || evt.key === "j") this.seekBy(-this.host.options.seekStep);
      else if (evt.key === "ArrowRight" || evt.key === "l") this.seekBy(this.host.options.seekStep);
      else if (evt.key === ">" ) this.changeRate(this.host.options.speedStep);
      else if (evt.key === "<") this.changeRate(-this.host.options.speedStep);
      else return;
      evt.preventDefault();
    });
    content.setAttr("tabindex", "-1");
    if (this.source) this.loadSource(this.source, this.pendingTime);
  }

  override async onClose() {
    this.player?.destroy();
    this.player = null;
    this.setMediaSession(false);
  }

  /** Load a source (replacing the current player) and start at `time` seconds. */
  loadSource(source: MediaSource, time = 0) {
    this.source = source;
    this.pendingTime = time;
    if (!this.stageEl) return; // not open yet: onOpen loads it
    this.player?.destroy();
    this.emptyEl.hide();
    this.stageEl.toggleClass("mod-audio", !!source.audio);
    this.player = createPlayer(this.stageEl, source, time);
    this.stageEl.setAttr("data-kind", this.player.kind);
    this.player.onChange(() => this.refresh());
    this.updateHeader();
    this.setMediaSession(true);
    this.refresh();
    this.host.onPlayerChanged(this);
  }

  isSameSource(source: MediaSource): boolean {
    if (!this.source) return false;
    if (source.path || this.source.path) return source.path === this.source.path;
    const a = classifyUrl(source.url ?? "");
    const b = classifyUrl(this.source.url ?? "");
    if (a?.id && b?.id) return a.kind === b.kind && a.id === b.id;
    return (source.url ?? "").replace(/#.*$/, "") === (this.source.url ?? "").replace(/#.*$/, "");
  }

  seekTo(seconds: number) {
    this.player?.seek(seconds);
    this.refresh();
  }

  seekBy(delta: number) {
    if (!this.player) return;
    this.seekTo(Math.max(0, this.player.getCurrentTime() + delta));
  }

  togglePlay() {
    if (!this.player) return;
    if (this.player.isPaused()) this.player.play();
    else this.player.pause();
    this.refresh();
  }

  changeRate(delta: number) {
    if (!this.player) return;
    this.setRate(this.player.getRate() + delta);
  }

  setRate(rate: number) {
    if (!this.player) return;
    this.player.setRate(Math.round(Math.min(16, Math.max(0.1, rate)) * 100) / 100);
    this.refresh();
  }

  private refresh() {
    if (!this.player || !this.timeEl) return;
    const t = this.player.getCurrentTime();
    const d = this.player.getDuration();
    this.timeEl.setText(d > 0 ? `${formatDuration(t)} / ${formatDuration(d)}` : formatDuration(t));
    this.rateEl.setText(`${Math.round(this.player.getRate() * 100) / 100}×`);
    const paused = this.player.isPaused();
    if (this.playBtn.getAttr("aria-label") !== (paused ? "Play" : "Pause") || !this.playBtn.firstChild) {
      setIcon(this.playBtn, paused ? "lucide-play" : "lucide-pause");
      this.playBtn.setAttr("aria-label", paused ? "Play" : "Pause");
    }
  }

  private setMediaSession(active: boolean) {
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    if (!ms || typeof MediaMetadata === "undefined") return;
    try {
      if (!active) {
        ms.metadata = null;
        for (const a of ["play", "pause", "seekbackward", "seekforward"] as MediaSessionAction[]) ms.setActionHandler(a, null);
        return;
      }
      ms.metadata = new MediaMetadata({ title: this.source?.title ?? "" });
      ms.setActionHandler("play", () => this.player?.play());
      ms.setActionHandler("pause", () => this.player?.pause());
      ms.setActionHandler("seekbackward", () => this.seekBy(-this.host.options.seekStep));
      ms.setActionHandler("seekforward", () => this.seekBy(this.host.options.seekStep));
    } catch {
      /* Media Session is decoration */
    }
  }
}

export function sourceFromUrl(url: string): MediaSource {
  const info = classifyUrl(url);
  let title = url;
  try {
    const u = new URL(url);
    title = info?.kind === "youtube" ? `YouTube · ${info.id}` : info?.kind === "vimeo" ? `Vimeo · ${info.id}` : decodeURIComponent(u.pathname.split("/").pop() || u.hostname);
  } catch {
    /* keep */
  }
  return { url, src: url.replace(/#.*$/, ""), title, audio: info?.kind === "audio" };
}
