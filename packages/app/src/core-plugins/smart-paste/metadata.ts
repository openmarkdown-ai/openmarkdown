/**
 * Page titles and link-card metadata.
 *
 * Title order (Auto Link Title's result, browser-shaped):
 *   1. YouTube / Vimeo oEmbed — both send CORS headers, so no bridge needed;
 *   2. the page itself through `requestUrl`: `og:title`, then `<title>`;
 *      a non-HTML response gives the last path segment.
 */
import { fetchJson, fetchUrl, NetError } from "./network";
import { classifyUrl } from "../media/urls";

export interface LinkMetadata {
  url: string;
  title: string;
  description?: string;
  host?: string;
  favicon?: string;
  image?: string;
}

function oembedEndpoint(url: string): string | null {
  const info = classifyUrl(url);
  if (info?.kind === "youtube") return `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  if (info?.kind === "vimeo") return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
  return null;
}

function lastSegment(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : u.hostname;
  } catch {
    return url;
  }
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function meta(doc: Document, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = doc.querySelector<HTMLMetaElement>(`meta[property='${k}'], meta[name='${k}']`)?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return undefined;
}

function clean(s: string | undefined | null): string {
  return (s ?? "").replace(/(\r\n|\n|\r)/gm, "").trim();
}

/** Fetch a page's title. Throws NetError when the page cannot be read. */
export async function fetchTitle(url: string): Promise<string> {
  const oembed = oembedEndpoint(url);
  if (oembed) {
    try {
      const data = await fetchJson<{ title?: string }>(oembed);
      if (data?.title) return clean(data.title);
    } catch {
      /* fall through to the page */
    }
  }
  const res = await fetchUrl(url, { maxBytes: 8 * 1048576 });
  if (res.contentType && !/html|xml/.test(res.contentType)) return lastSegment(url);
  const doc = parseHtml(res.text());
  const title = clean(meta(doc, "og:title")) || clean(doc.querySelector("title")?.textContent) || clean(doc.querySelector("[no-title]")?.getAttribute("no-title"));
  if (!title) throw new NetError("invalid", "The page has no title");
  return title;
}

function absolute(href: string | undefined | null, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

/** Metadata for a `cardlink` block (Auto Card Link's fields). Throws NetError when unreadable. */
export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  })();
  const oembed = oembedEndpoint(url);
  if (oembed) {
    try {
      const data = await fetchJson<{ title?: string; author_name?: string; thumbnail_url?: string; provider_url?: string }>(oembed);
      if (data?.title) {
        return {
          url,
          title: clean(data.title),
          description: data.author_name ? clean(data.author_name) : undefined,
          host,
          favicon: data.provider_url ? absolute("/favicon.ico", data.provider_url) : undefined,
          image: data.thumbnail_url,
        };
      }
    } catch {
      /* fall through */
    }
  }
  const res = await fetchUrl(url, { maxBytes: 8 * 1048576 });
  const doc = parseHtml(res.text());
  const title = clean(meta(doc, "og:title")) || clean(doc.querySelector("title")?.textContent);
  if (!title) throw new NetError("invalid", "The page has no title");
  const description = clean(meta(doc, "og:description", "description")) || undefined;
  const iconHref = doc.querySelector("link[rel='icon'], link[rel='shortcut icon'], link[rel~='icon']")?.getAttribute("href");
  return {
    url,
    title,
    description,
    host,
    favicon: absolute(iconHref, url),
    image: absolute(meta(doc, "og:image", "twitter:image"), url),
  };
}

/** Auto Link Title's escaping: `* _ \` | < > ~ \ [ ]` get a backslash. */
export function escapeMarkdown(text: string): string {
  const unescaped = text.replace(/\\(\*|_|`|~|\\|\[|\])/g, "$1");
  return unescaped.replace(/(\*|_|`|\||<|>|~|\\|\[|\])/g, "\\$1");
}

export function shortTitle(title: string, max: number): string {
  if (!max || title.length < max + 3) return title;
  return `${title.slice(0, max)}...`;
}

/** Auto Card Link's code block text, byte for byte. */
export function cardlinkBlock(m: LinkMetadata): string {
  const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = ["\n```cardlink", `url: ${m.url}`, `title: "${q(m.title)}"`];
  if (m.description) lines.push(`description: "${q(m.description)}"`);
  if (m.host) lines.push(`host: ${m.host}`);
  if (m.favicon) lines.push(`favicon: ${m.favicon}`);
  if (m.image) lines.push(`image: ${m.image}`);
  lines.push("```\n");
  return lines.join("\n");
}
