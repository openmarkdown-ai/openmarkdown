/**
 * Players behind one small interface: HTML media (vault files, direct URLs),
 * YouTube and Vimeo. The two iframe players are driven over their documented
 * postMessage protocols, so no third-party script runs in the app's origin
 * (YouTube's `iframe_api` and Vimeo's `player.js` would).
 */
import { vimeoEmbedSrc, youtubeEmbedSrc } from "./embeds";
import { classifyUrl } from "./urls";

export interface MediaPlayer {
  readonly kind: "html" | "youtube" | "vimeo";
  readonly el: HTMLElement;
  getCurrentTime(): number;
  getDuration(): number;
  isPaused(): boolean;
  seek(seconds: number): void;
  play(): void;
  pause(): void;
  getRate(): number;
  setRate(rate: number): void;
  /** Frame grab (HTML video only; cross-origin frames cannot be drawn). */
  canScreenshot(): boolean;
  onChange(cb: () => void): void;
  destroy(): void;
}

export interface MediaSource {
  /** Vault file path, when the media is a vault file */
  path?: string;
  /** Resolved URL (resource URL for vault files) */
  src: string;
  /** Original web URL (for timestamp links) */
  url?: string;
  title: string;
  audio?: boolean;
}

class HtmlPlayer implements MediaPlayer {
  readonly kind = "html" as const;
  readonly el: HTMLElement;
  readonly media: HTMLMediaElement;
  private listeners: (() => void)[] = [];
  constructor(parent: HTMLElement, source: MediaSource, start: number) {
    this.el = parent.createDiv({ cls: "vault-media-player-html" });
    this.media = this.el.createEl(source.audio ? "audio" : "video", { attr: { controls: "", preload: "metadata", src: source.src } });
    if (start > 0) {
      const apply = () => (this.media.currentTime = start);
      // Before metadata this sets the default playback start position; re-apply once it loads.
      apply();
      if (this.media.readyState < 1) this.media.addEventListener("loadedmetadata", apply, { once: true });
    }
    for (const ev of ["timeupdate", "play", "pause", "ratechange", "loadedmetadata", "seeked"]) this.media.addEventListener(ev, () => this.emit());
  }
  private emit() {
    for (const l of this.listeners) l();
  }
  getCurrentTime() {
    return this.media.currentTime;
  }
  getDuration() {
    return Number.isFinite(this.media.duration) ? this.media.duration : 0;
  }
  isPaused() {
    return this.media.paused;
  }
  seek(s: number) {
    this.media.currentTime = Math.max(0, s);
  }
  play() {
    void this.media.play()?.catch(() => {});
  }
  pause() {
    this.media.pause();
  }
  getRate() {
    return this.media.playbackRate;
  }
  setRate(r: number) {
    this.media.playbackRate = r;
  }
  canScreenshot() {
    return this.media instanceof HTMLVideoElement && this.media.videoWidth > 0;
  }
  onChange(cb: () => void) {
    this.listeners.push(cb);
  }
  destroy() {
    this.media.pause();
    this.media.removeAttribute("src");
    this.media.load();
    this.el.remove();
  }
}

/** Common bookkeeping for players living in a cross-origin iframe. */
abstract class FramePlayer implements MediaPlayer {
  abstract readonly kind: "youtube" | "vimeo";
  readonly el: HTMLElement;
  readonly iframe: HTMLIFrameElement;
  protected time = 0;
  protected duration = 0;
  protected paused = true;
  protected rate = 1;
  private listeners: (() => void)[] = [];
  private onMessage = (evt: MessageEvent) => {
    if (evt.source !== this.iframe.contentWindow) return;
    let data: any = evt.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        return;
      }
    }
    if (data && typeof data === "object") {
      this.handle(data);
      for (const l of this.listeners) l();
    }
  };
  constructor(parent: HTMLElement, src: string, title: string) {
    this.el = parent.createDiv({ cls: "vault-media-player-frame" });
    this.iframe = this.el.createEl("iframe", {
      cls: "external-embed",
      attr: { src, title, allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: "", referrerpolicy: "strict-origin-when-cross-origin" },
    });
    window.addEventListener("message", this.onMessage);
    this.iframe.addEventListener("load", () => this.onFrameLoad());
  }
  protected abstract handle(data: any): void;
  protected abstract onFrameLoad(): void;
  protected post(message: unknown) {
    this.iframe.contentWindow?.postMessage(JSON.stringify(message), "*");
  }
  getCurrentTime() {
    return this.time;
  }
  getDuration() {
    return this.duration;
  }
  isPaused() {
    return this.paused;
  }
  getRate() {
    return this.rate;
  }
  canScreenshot() {
    return false;
  }
  onChange(cb: () => void) {
    this.listeners.push(cb);
  }
  abstract seek(s: number): void;
  abstract play(): void;
  abstract pause(): void;
  abstract setRate(r: number): void;
  destroy() {
    window.removeEventListener("message", this.onMessage);
    this.el.remove();
  }
}

/** YouTube IFrame Player API over postMessage (`enablejsapi=1`). */
class YoutubePlayer extends FramePlayer {
  readonly kind = "youtube" as const;
  private ticker: number | null = null;
  constructor(parent: HTMLElement, id: string, start: number) {
    super(parent, youtubeEmbedSrc(id, start, { enablejsapi: "1", origin: location.origin, playsinline: "1", rel: "0" }), "YouTube video player");
    this.time = start;
  }
  protected onFrameLoad() {
    this.post({ event: "listening", id: "vault-media", channel: "widget" });
    // YouTube answers "listening" with infoDelivery messages only while it thinks someone listens.
    this.ticker ??= window.setInterval(() => this.post({ event: "listening", id: "vault-media", channel: "widget" }), 1000);
  }
  private command(func: string, args: unknown[] = []) {
    this.post({ event: "command", func, args, id: "vault-media", channel: "widget" });
  }
  protected handle(data: any) {
    const info = data.event === "infoDelivery" || data.event === "initialDelivery" ? data.info : null;
    if (!info) return;
    if (typeof info.currentTime === "number") this.time = info.currentTime;
    if (typeof info.duration === "number") this.duration = info.duration;
    if (typeof info.playbackRate === "number") this.rate = info.playbackRate;
    if (typeof info.playerState === "number") this.paused = info.playerState !== 1 && info.playerState !== 3;
  }
  seek(s: number) {
    this.time = Math.max(0, s);
    this.command("seekTo", [this.time, true]);
  }
  play() {
    this.paused = false;
    this.command("playVideo");
  }
  pause() {
    this.paused = true;
    this.command("pauseVideo");
  }
  setRate(r: number) {
    this.rate = r;
    this.command("setPlaybackRate", [r]);
  }
  override destroy() {
    if (this.ticker !== null) window.clearInterval(this.ticker);
    super.destroy();
  }
}

/** Vimeo Player API over postMessage. */
class VimeoPlayer extends FramePlayer {
  readonly kind = "vimeo" as const;
  constructor(parent: HTMLElement, id: string, hash: string | undefined, start: number) {
    super(parent, vimeoEmbedSrc(id, hash, start, { api: "1" }), "Vimeo video player");
    this.time = start;
  }
  protected onFrameLoad() {
    for (const event of ["timeupdate", "play", "pause", "playbackratechange", "loaded"]) this.post({ method: "addEventListener", value: event });
    this.post({ method: "getDuration" });
  }
  protected handle(data: any) {
    if (data.event === "timeupdate" && data.data) {
      if (typeof data.data.seconds === "number") this.time = data.data.seconds;
      if (typeof data.data.duration === "number") this.duration = data.data.duration;
    } else if (data.event === "play") this.paused = false;
    else if (data.event === "pause") this.paused = true;
    else if (data.event === "playbackratechange" && typeof data.data?.playbackRate === "number") this.rate = data.data.playbackRate;
    else if (data.method === "getDuration" && typeof data.value === "number") this.duration = data.value;
    else if (data.event === "ready") this.onFrameLoad();
  }
  seek(s: number) {
    this.time = Math.max(0, s);
    this.post({ method: "setCurrentTime", value: this.time });
  }
  play() {
    this.paused = false;
    this.post({ method: "play" });
  }
  pause() {
    this.paused = true;
    this.post({ method: "pause" });
  }
  setRate(r: number) {
    this.rate = r;
    this.post({ method: "setPlaybackRate", value: r });
  }
}

export function createPlayer(parent: HTMLElement, source: MediaSource, start: number): MediaPlayer {
  if (!source.path && source.url) {
    const info = classifyUrl(source.url);
    if (info?.kind === "youtube") return new YoutubePlayer(parent, info.id!, start);
    if (info?.kind === "vimeo") return new VimeoPlayer(parent, info.id!, info.hash, start);
    if (info?.kind === "audio") return new HtmlPlayer(parent, { ...source, audio: true }, start);
  }
  return new HtmlPlayer(parent, source, start);
}
