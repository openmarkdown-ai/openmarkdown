/**
 * Formatting with citeproc-js and a CSL style, loaded on first use.
 *
 * Bundled: APA 7th and Chicago author-date, with the en-US locale. Any other
 * style id from the official CSL repository is downloaded when chosen and kept
 * in `.obsidian/citations/styles/`, as are locales it needs. A `.csl` file in
 * the vault can be named instead.
 */
import type { CslItem } from "./bibtex";
import type { CiteItem } from "./library";

export const BUNDLED_STYLES: Record<string, { label: string; load: () => Promise<{ default: string }> }> = {
  apa: { label: "APA 7th edition", load: () => import("./csl/apa.csl?raw") },
  "chicago-author-date": { label: "Chicago author-date", load: () => import("./csl/chicago-author-date.csl?raw") },
};

const STYLE_REPO = "https://raw.githubusercontent.com/citation-style-language/styles/master";
const LOCALE_REPO = "https://raw.githubusercontent.com/citation-style-language/locales/master";
const STYLE_DIR = "citations/styles";

interface CiteprocEngine {
  setOutputFormat(f: "html" | "text"): void;
  updateItems(ids: string[]): void;
  makeCitationCluster(items: Record<string, unknown>[]): string;
  makeBibliography(): [Record<string, unknown>, string[]] | false;
}

let citeprocPromise: Promise<any> | null = null;
function loadCiteproc(): Promise<any> {
  citeprocPromise ??= import("citeproc").then((m: any) => m.default ?? m);
  return citeprocPromise;
}

const localeCache = new Map<string, string>();

async function adapterRead(app: any, path: string): Promise<string | null> {
  try {
    const adapter = app.vault.adapter;
    if (await adapter.exists(path)) return await adapter.read(path);
  } catch {
    /* not there */
  }
  return null;
}

async function adapterWrite(app: any, path: string, text: string) {
  const adapter = app.vault.adapter;
  const dir = path.slice(0, path.lastIndexOf("/"));
  try {
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
  } catch {
    /* exists */
  }
  await adapter.write(path, text);
}

/** Load a style: bundled id, a vault .csl path, or a CSL repository id (downloaded once). */
export async function loadStyle(app: any, style: string): Promise<string> {
  const id = style.trim() || "apa";
  if (BUNDLED_STYLES[id]) return (await BUNDLED_STYLES[id]!.load()).default;
  if (/\.csl$/i.test(id)) {
    const file = app.vault.getFileByPath(id) ?? app.metadataCache.getFirstLinkpathDest(id, "");
    if (file) return app.vault.cachedRead(file);
    throw new Error(`Style file “${id}” is not in the vault.`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`“${id}” is not a CSL style id.`);
  const cachePath = `${app.vault.configDir}/${STYLE_DIR}/${id}.csl`;
  let xml = await adapterRead(app, cachePath);
  if (!xml) {
    const res = await fetch(`${STYLE_REPO}/${id}.csl`);
    if (!res.ok) throw new Error(`Style “${id}” was not found in the CSL repository.`);
    xml = await res.text();
    await adapterWrite(app, cachePath, xml);
  }
  // Dependent styles only point at their parent.
  const parent = /<link[^>]*rel="independent-parent"[^>]*href="[^"]*\/styles\/([^"/]+)"/.exec(xml) ?? /<link[^>]*href="[^"]*\/styles\/([^"/]+)"[^>]*rel="independent-parent"/.exec(xml);
  if (parent && !/<citation\b/.test(xml)) return loadStyle(app, parent[1]!);
  return xml;
}

async function ensureLocale(app: any, lang: string): Promise<void> {
  if (localeCache.has(lang)) return;
  if (lang === "en-US") {
    localeCache.set(lang, (await import("./csl/locales-en-US.xml?raw")).default);
    return;
  }
  const cachePath = `${app.vault.configDir}/citations/locales/locales-${lang}.xml`;
  let xml = await adapterRead(app, cachePath);
  if (!xml) {
    try {
      const res = await fetch(`${LOCALE_REPO}/locales-${lang}.xml`);
      if (res.ok) {
        xml = await res.text();
        await adapterWrite(app, cachePath, xml);
      }
    } catch {
      /* offline: en-US */
    }
  }
  if (xml) localeCache.set(lang, xml);
}

export class Formatter {
  private engine: CiteprocEngine | null = null;
  private previewEngine: CiteprocEngine | null = null;
  private registered = "";

  private constructor(private items: (id: string) => CslItem | undefined) {}

  static async create(app: any, style: string, items: (id: string) => CslItem | undefined): Promise<Formatter> {
    const [CSL, xml] = await Promise.all([loadCiteproc(), loadStyle(app, style)]);
    const lang = /default-locale="([^"]+)"/.exec(xml)?.[1] ?? "en-US";
    await ensureLocale(app, "en-US");
    await ensureLocale(app, lang);
    const f = new Formatter(items);
    const sys = {
      retrieveLocale: (l: string) => localeCache.get(l) ?? localeCache.get("en-US"),
      retrieveItem: (id: string) => {
        const it = f.items(id);
        return it ? { ...it, id } : { id, type: "document", title: id };
      },
    };
    f.engine = new CSL.Engine(sys, xml, lang) as CiteprocEngine;
    f.engine.setOutputFormat("html");
    f.previewEngine = new CSL.Engine(sys, xml, lang) as CiteprocEngine;
    f.previewEngine.setOutputFormat("html");
    return f;
  }

  private toCiteproc(i: CiteItem): Record<string, unknown> {
    return { id: i.key, prefix: i.prefix, suffix: i.suffix ? ` ${i.suffix}` : undefined, locator: i.locator, label: i.label, "suppress-author": i.suppressAuthor || undefined };
  }

  /** In-text citation HTML for a cluster. Narrative citations read "Author (Year)". */
  cluster(items: CiteItem[], narrative = false): string {
    const engine = this.engine!;
    if (narrative && items.length === 1) {
      const author = engine.makeCitationCluster([{ id: items[0]!.key, "author-only": true }]);
      const rest = engine.makeCitationCluster([{ ...this.toCiteproc(items[0]!), "suppress-author": true }]);
      return `${author} ${rest}`;
    }
    return engine.makeCitationCluster(items.map((i) => this.toCiteproc(i)));
  }

  /** Bibliography entries (HTML strings) for `keys`, sorted by the style. */
  bibliography(keys: string[]): string[] {
    if (!keys.length) return [];
    const sig = keys.join("\u0000");
    if (sig !== this.registered) {
      this.engine!.updateItems(keys);
      this.registered = sig;
    }
    const out = this.engine!.makeBibliography();
    return out ? out[1] : [];
  }

  /** One formatted reference, without disturbing the document's registry. */
  reference(key: string): string {
    this.previewEngine!.updateItems([key]);
    const out = this.previewEngine!.makeBibliography();
    return out ? (out[1][0] ?? "") : "";
  }
}

/** HTML → plain text (for Markdown bibliographies). */
export function htmlToText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** HTML from citeproc → Markdown with *italics* and **bold**. */
export function htmlToMarkdown(html: string): string {
  return html
    .replace(/<\/?div[^>]*>/g, "")
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/g, "*$2*")
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/g, "**$2**")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}
