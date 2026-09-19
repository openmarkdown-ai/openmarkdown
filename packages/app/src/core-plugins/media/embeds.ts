/**
 * External embeds — Obsidian renders `![](https://www.youtube.com/watch?v=…)`,
 * `![](https://x.com/…/status/…)` and remote media as embeds rather than
 * broken images. One element builder serves the reading view (through
 * `registerExternalEmbedHandler` in obsidian/markdown/renderer.ts) and Live
 * Preview (through `externalEmbedRenderers` in editor/live-preview/widgets.ts).
 *
 * Privacy: nothing third-party loads just because a note is open (PLAN
 * principle 5). By default YouTube, Vimeo, X posts, remote PDFs and link-card
 * images show a placeholder and load on click; remote audio/video do not
 * preload. "Click to load embeds" (Media settings, or the external-embeds
 * plugin's `clickToLoad` option) turned off loads them on render. When they
 * load, YouTube comes from youtube-nocookie.com and Vimeo with `dnt=1`.
 * Plain remote images `![](https://…png)` load as in any Markdown app.
 */
import { setIcon } from "../../obsidian/ui/icons";
import { sanitizeHTMLToDom } from "../../obsidian/util";
import { fetchJson } from "../smart-paste/network";
import { startTimeOf } from "./timefrag";
import { classifyUrl, parseAltSize, type MediaUrlInfo } from "./urls";

export interface ExternalEmbedOptions {
  clickToLoad: boolean;
  /** Set while the Media plugin is on: adds an "Open in media player" button to players. */
  openInPlayer: ((url: string) => void) | null;
}

export const embedOptions: ExternalEmbedOptions = { clickToLoad: true, openInPlayer: null };

export function youtubeEmbedSrc(id: string, start: number, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  if (start > 0) params.set("start", String(Math.floor(start)));
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const q = params.toString();
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}${q ? "?" + q : ""}`;
}

export function vimeoEmbedSrc(id: string, hash: string | undefined, start: number, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ dnt: "1" });
  if (hash) params.set("h", hash);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return `https://player.vimeo.com/video/${encodeURIComponent(id)}?${params.toString()}${start > 0 ? `#t=${Math.floor(start)}s` : ""}`;
}

const IFRAME_ALLOW = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen";

function frame(src: string, title: string): HTMLIFrameElement {
  return createEl("iframe", {
    cls: "external-embed mod-receives-events",
    attr: { src, title, allow: IFRAME_ALLOW, allowfullscreen: "", referrerpolicy: "strict-origin-when-cross-origin", loading: "lazy", frameborder: "0" },
  });
}

function applySize(container: HTMLElement, alt: string) {
  const size = parseAltSize(alt);
  if (size.width) {
    container.style.width = `${size.width}px`;
    container.setAttr("width", String(size.width));
  }
  if (size.height) {
    container.style.height = `${size.height}px`;
    container.style.aspectRatio = "auto";
    container.setAttr("height", String(size.height));
  }
}

function hostLabel(info: MediaUrlInfo): string {
  switch (info.kind) {
    case "youtube": return "YouTube";
    case "vimeo": return "Vimeo";
    case "tweet": return "X (Twitter)";
    default:
      try {
        return new URL(info.url).hostname;
      } catch {
        return info.url;
      }
  }
}

const LOAD_ICONS: Partial<Record<MediaUrlInfo["kind"], string>> = { tweet: "lucide-message-square", pdf: "lucide-file-text" };

/** Placeholder shown instead of a third-party frame when "Click to load embeds" is on (the default). */
function clickToLoad(container: HTMLElement, info: MediaUrlInfo, load: () => void) {
  container.addClass("is-deferred");
  const btn = container.createEl("button", { cls: "vault-embed-load-button", attr: { type: "button", title: `Loads content from ${hostLabel(info)}` } });
  setIcon(btn.createSpan({ cls: "vault-embed-load-icon" }), LOAD_ICONS[info.kind] ?? "lucide-play");
  btn.createSpan({ cls: "vault-embed-load-label", text: info.kind === "pdf" ? `Load PDF from ${hostLabel(info)}` : `Load ${hostLabel(info)} embed` });
  btn.createSpan({ cls: "vault-embed-load-host", text: info.url });
  btn.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    container.removeClass("is-deferred");
    container.empty();
    load();
  });
}

function addPlayerButton(container: HTMLElement, url: string) {
  if (!embedOptions.openInPlayer) return;
  const open = embedOptions.openInPlayer;
  const btn = container.createDiv({ cls: "vault-embed-open-player clickable-icon", attr: { "aria-label": "Open in media player" } });
  setIcon(btn, "lucide-panel-right-open");
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    open(url);
  });
}

/** The element for `![alt](url)`, or null when the URL is an ordinary image or not media. */
export function createExternalEmbed(url: string, alt: string): HTMLElement | null {
  const info = classifyUrl(url);
  if (!info || info.kind === "image") return null;
  const start = startTimeOf(url);
  switch (info.kind) {
    case "youtube":
    case "vimeo": {
      const container = createDiv({ cls: `media-embed external-embed-container vault-external-embed mod-${info.kind}`, attr: { "data-url": url, contenteditable: "false" } });
      applySize(container, alt);
      const load = () => {
        const src = info.kind === "youtube" ? youtubeEmbedSrc(info.id!, start) : vimeoEmbedSrc(info.id!, info.hash, start);
        container.appendChild(frame(src, info.kind === "youtube" ? "YouTube video player" : "Vimeo video player"));
        addPlayerButton(container, url);
      };
      if (embedOptions.clickToLoad) clickToLoad(container, info, load);
      else load();
      return container;
    }
    case "tweet": {
      const container = createDiv({ cls: "vault-external-embed vault-tweet-embed", attr: { "data-url": url, contenteditable: "false" } });
      const load = () => void renderTweet(container, info);
      if (embedOptions.clickToLoad) clickToLoad(container, info, load);
      else load();
      return container;
    }
    case "audio": {
      const container = createDiv({ cls: "media-embed audio-embed vault-external-embed mod-audio", attr: { "data-url": url, contenteditable: "false" } });
      container.createEl("audio", { attr: { controls: "", preload: embedOptions.clickToLoad ? "none" : "metadata", src: url } });
      addPlayerButton(container, url);
      return container;
    }
    case "video": {
      const container = createDiv({ cls: "media-embed video-embed vault-external-embed mod-video", attr: { "data-url": url, contenteditable: "false" } });
      // preload=none: the file is requested when the user presses play.
      const video = container.createEl("video", { attr: { controls: "", preload: embedOptions.clickToLoad ? "none" : "metadata", src: url } });
      const size = parseAltSize(alt);
      if (size.width) video.setAttr("width", String(size.width));
      if (size.height) video.setAttr("height", String(size.height));
      addPlayerButton(container, url);
      return container;
    }
    case "pdf": {
      const container = createDiv({ cls: "pdf-embed vault-external-embed mod-pdf", attr: { "data-url": url, contenteditable: "false" } });
      const load = () => void container.createEl("iframe", { cls: "vault-pdf-embed-frame", attr: { src: url, title: alt || url, loading: "lazy" } });
      applySize(container, alt);
      if (embedOptions.clickToLoad) clickToLoad(container, info, load);
      else load();
      return container;
    }
  }
  return null;
}

const tweetCache = new Map<string, Promise<{ html: string; author_name?: string; author_url?: string }>>();

async function renderTweet(container: HTMLElement, info: MediaUrlInfo) {
  const dark = document.body.hasClass("theme-dark");
  const key = info.url;
  let pending = tweetCache.get(key);
  if (!pending) {
    const endpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(info.url)}&omit_script=1&dnt=true${dark ? "&theme=dark" : ""}`;
    pending = fetchJson(endpoint);
    tweetCache.set(key, pending);
    pending.catch(() => tweetCache.delete(key));
  }
  try {
    const data = await pending;
    if (!data || typeof data.html !== "string") throw new Error("no html");
    container.empty();
    container.addClass("is-loaded");
    const card = container.createDiv({ cls: "vault-tweet-card" });
    const head = card.createDiv({ cls: "vault-tweet-head" });
    setIcon(head.createSpan({ cls: "vault-tweet-icon" }), "lucide-message-square");
    head.createSpan({ cls: "vault-tweet-author", text: data.author_name ?? "Post on X" });
    const body = card.createDiv({ cls: "vault-tweet-body" });
    // Scripts are never kept: the post renders as its quoted text, not Twitter's widget.
    body.appendChild(sanitizeHTMLToDom(data.html));
    body.querySelectorAll("a").forEach((a) => {
      a.addClass("external-link");
      a.setAttr("target", "_blank");
      a.setAttr("rel", "noopener nofollow");
    });
    card.createEl("a", { cls: "vault-tweet-link external-link", text: "View on X", attr: { href: info.url, target: "_blank", rel: "noopener nofollow" } });
  } catch {
    renderLinkCard(container, info);
  }
}

/** Fallback when the post cannot be fetched: a card that links to it. */
function renderLinkCard(container: HTMLElement, info: MediaUrlInfo) {
  container.empty();
  container.addClasses(["is-loaded", "mod-fallback"]);
  let handle = "";
  try {
    handle = new URL(info.url).pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    /* keep */
  }
  const card = container.createEl("a", { cls: "vault-tweet-card vault-tweet-fallback", attr: { href: info.url, target: "_blank", rel: "noopener nofollow" } });
  const head = card.createDiv({ cls: "vault-tweet-head" });
  setIcon(head.createSpan({ cls: "vault-tweet-icon" }), "lucide-message-square");
  head.createSpan({ cls: "vault-tweet-author", text: handle ? `@${handle}` : "Post on X" });
  card.createDiv({ cls: "vault-tweet-body", text: "This post could not be loaded here. Open it on X." });
  card.createDiv({ cls: "vault-tweet-url", text: info.url });
}
