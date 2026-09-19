/**
 * "Save to vault": the page's readable content as a Markdown note.
 *
 * Obsidian runs Defuddle + Turndown; here the Rust clipper does both
 * (`extract` then `htmlToMarkdown`). When the engine is unavailable a crude
 * DOMParser extraction still produces a usable note.
 */
import { getEngine } from "@vault/engine";
import { Notice } from "../../obsidian/ui/notice";
import { getRequestTransport, moment, normalizePath, stringifyYaml } from "../../obsidian/util";

export interface SavedPage {
  title: string;
  author: string;
  published: string;
  description: string;
  markdown: string;
}

export async function fetchHtml(url: string): Promise<string> {
  const transport = getRequestTransport();
  if (transport) {
    try {
      const res = await transport.request({ url, method: "GET" });
      if (res.status < 400) return new TextDecoder().decode(res.body);
    } catch {
      /* fall back to fetch */
    }
  }
  const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new Error(`Request failed, status ${res.status}`);
  return res.text();
}

export function convertPage(html: string, url: string): SavedPage {
  try {
    const engine = getEngine();
    const ex = engine.extract(html, url) as Record<string, unknown>;
    const str = (k: string, alt?: string) => {
      const v = ex[k] ?? (alt ? ex[alt] : undefined);
      return typeof v === "string" ? v : "";
    };
    const content = str("contentHtml", "content_html") || html;
    const markdown = engine.htmlToMarkdown(content, url);
    const page = { title: str("title"), author: str("author"), published: str("published"), description: str("description"), markdown };
    if (page.markdown.trim() || page.title) return page;
  } catch {
    /* engine not available: fall through */
  }
  return crudeConvert(html);
}

function crudeConvert(html: string): SavedPage {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, nav, header, footer, aside, iframe, svg, form").forEach((el) => el.remove());
  const meta = (name: string) => doc.querySelector<HTMLMetaElement>(`meta[name="${name}"], meta[property="${name}"]`)?.content?.trim() ?? "";
  const root = doc.querySelector("article") ?? doc.querySelector("main") ?? doc.body;
  const blocks: string[] = [];
  root?.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre").forEach((el) => {
    const text = (el as HTMLElement).textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!text) return;
    const tag = el.tagName.toLowerCase();
    if (/^h\d$/.test(tag)) blocks.push(`${"#".repeat(Number(tag[1]))} ${text}`);
    else if (tag === "li") blocks.push(`- ${text}`);
    else if (tag === "blockquote") blocks.push(`> ${text}`);
    else if (tag === "pre") blocks.push("```\n" + ((el as HTMLElement).textContent ?? "") + "\n```");
    else blocks.push(text);
  });
  const markdown = blocks.length ? blocks.join("\n\n") : (root?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    title: doc.title?.trim() || meta("og:title"),
    author: meta("author"),
    published: meta("article:published_time"),
    description: meta("description") || meta("og:description"),
    markdown,
  };
}

export function sanitizeTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || "Untitled page";
}

export async function saveUrlToVault(app: any, url: string, folder: string, cached?: string | null): Promise<any | null> {
  const notice = new Notice("Saving page…", 0);
  try {
    let html = cached ?? null;
    if (!html) {
      try {
        html = await fetchHtml(url);
      } catch (e) {
        notice.hide();
        new Notice(`Could not download the page. The site may block requests from other origins (CORS). ${(e as Error)?.message ?? ""}`.trim());
        return null;
      }
    }
    const page = convertPage(html, url);
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* keep url */
    }
    const title = page.title || host;
    const fm: Record<string, unknown> = { title, source: url };
    if (page.author) fm.author = page.author;
    if (page.published) fm.published = page.published;
    fm.created = moment().format("YYYY-MM-DD");
    if (page.description) fm.description = page.description;
    fm.tags = ["clippings"];
    const content = `---\n${stringifyYaml(fm)}---\n${page.markdown.trim()}\n`;
    const dir = normalizePath(folder || "/");
    if (dir !== "/" && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
    const base = dir === "/" ? sanitizeTitle(title) : `${dir}/${sanitizeTitle(title)}`;
    const path = app.vault.getAvailablePath(base, "md");
    const file = await app.vault.create(path, content);
    notice.hide();
    new Notice(`Saved “${file.basename}”`);
    await app.workspace.getLeaf("tab").openFile(file, { active: true });
    return file;
  } catch (e) {
    notice.hide();
    new Notice(`Could not save the page: ${(e as Error)?.message ?? e}`);
    return null;
  }
}
