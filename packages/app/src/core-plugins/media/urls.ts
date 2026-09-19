/**
 * Recognising media URLs: YouTube (watch, youtu.be, shorts, embed, live),
 * Vimeo, Twitter/X status pages, and direct audio/video/PDF/image files.
 */

export const REMOTE_AUDIO = ["mp3", "m4a", "ogg", "oga", "wav", "flac", "aac", "opus"];
export const REMOTE_VIDEO = ["mp4", "webm", "ogv", "mov", "m4v"];
export const REMOTE_IMAGE = ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"];

export type MediaUrlKind = "youtube" | "vimeo" | "tweet" | "audio" | "video" | "pdf" | "image";

export interface MediaUrlInfo {
  kind: MediaUrlKind;
  url: string;
  /** YouTube video id, Vimeo numeric id, or tweet id */
  id?: string;
  /** Vimeo unlisted hash (`vimeo.com/123/abcdef`) */
  hash?: string;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
  const seg = u.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") return seg.length === 1 ? seg[0]! : null;
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (seg.length === 1 && seg[0] === "watch") return u.searchParams.get("v");
    if (seg.length === 2 && ["shorts", "embed", "v", "live"].includes(seg[0]!)) return seg[1]!;
  }
  return null;
}

export function extensionOf(u: URL): string {
  const last = u.pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

export function classifyUrl(url: string): MediaUrlInfo | null {
  const u = parse(url);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  const yt = youtubeId(u);
  if (yt && /^[\w-]{6,}$/.test(yt)) return { kind: "youtube", url, id: yt };
  const host = u.hostname.replace(/^www\./, "");
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const seg = u.pathname.split("/").filter(Boolean);
    const i = seg[0] === "video" ? 1 : 0;
    if (seg[i] && /^\d+$/.test(seg[i]!)) return { kind: "vimeo", url, id: seg[i]!, hash: seg[i + 1] && /^[0-9a-f]+$/i.test(seg[i + 1]!) ? seg[i + 1] : (u.searchParams.get("h") ?? undefined) };
  }
  if (host === "twitter.com" || host === "x.com" || host === "mobile.twitter.com") {
    const m = /^\/[^/]+\/status(?:es)?\/(\d+)/.exec(u.pathname);
    if (m) return { kind: "tweet", url, id: m[1]! };
  }
  const ext = extensionOf(u);
  if (REMOTE_AUDIO.includes(ext)) return { kind: "audio", url };
  if (REMOTE_VIDEO.includes(ext)) return { kind: "video", url };
  if (ext === "pdf") return { kind: "pdf", url };
  if (REMOTE_IMAGE.includes(ext)) return { kind: "image", url };
  return null;
}

/** `640x360`, `640`, `alt|640x360` → size and remaining alt text. */
export function parseAltSize(alt: string): { width?: number; height?: number; alt: string } {
  const m = /^(?:(.*)\|)?\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(alt);
  if (!m) return { alt };
  return { width: Number(m[2]), height: m[3] ? Number(m[3]) : undefined, alt: m[1] ?? "" };
}
