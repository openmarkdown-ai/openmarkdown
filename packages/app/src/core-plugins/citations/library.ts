/**
 * The citation library: entries loaded from a vault bibliography (.bib,
 * CSL-JSON, Better BibTeX JSON) and/or the Zotero web API, keyed by citekey,
 * with the Citations plugin's template variables.
 */
import type { CslItem, CslName } from "./bibtex";

export interface Entry {
  citekey: string;
  csl: CslItem;
  title: string;
  authorString: string;
  year: string;
  containerTitle: string;
  source: "file" | "zotero";
  zoteroKey?: string;
}

export function nameToString(n: CslName): string {
  if (n.literal) return n.literal;
  return [n.given, n["non-dropping-particle"], n.family, n.suffix].filter(Boolean).join(" ");
}

function yearOf(item: CslItem): string {
  const issued = item.issued as { "date-parts"?: (number | string)[][]; literal?: string; raw?: string } | undefined;
  const y = issued?.["date-parts"]?.[0]?.[0];
  if (y !== undefined && y !== "") return String(y);
  const m = /\d{4}/.exec(issued?.literal ?? issued?.raw ?? "");
  return m ? m[0] : "";
}

export function toEntry(item: CslItem, source: Entry["source"] = "file"): Entry {
  const authors = (item.author as CslName[] | undefined) ?? (item.editor as CslName[] | undefined) ?? [];
  return {
    citekey: String(item.id),
    csl: item,
    title: typeof item.title === "string" ? item.title : "",
    authorString: authors.map(nameToString).join(", "),
    year: yearOf(item),
    containerTitle: typeof item["container-title"] === "string" ? (item["container-title"] as string) : "",
    source,
  };
}

/** Citations plugin template variables for an entry. */
export function templateVariables(e: Entry): Record<string, string> {
  const c = e.csl;
  const str = (k: string) => (c[k] === undefined || c[k] === null ? "" : String(c[k]));
  return {
    citekey: e.citekey,
    abstract: str("abstract"),
    authorString: e.authorString,
    containerTitle: e.containerTitle,
    DOI: str("DOI"),
    eprint: str("eprint"),
    eprinttype: str("eprinttype"),
    eventPlace: str("event-place"),
    note: str("note"),
    page: str("page"),
    publisher: str("publisher"),
    publisherPlace: str("publisher-place"),
    title: e.title,
    titleShort: str("title-short") || e.title,
    type: str("type"),
    URL: str("URL"),
    year: e.year,
    zoteroSelectURI: e.zoteroKey ? `zotero://select/items/${e.zoteroKey}` : `zotero://select/items/@${e.citekey}`,
  };
}

/**
 * The Handlebars subset Citations templates use: `{{var}}`, `{{{var}}}`,
 * `{{#if var}}…{{else}}…{{/if}}`, `{{#unless var}}…{{/unless}}`.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (let guard = 0; guard < 20; guard++) {
    const next = out.replace(/\{\{#(if|unless)\s+(\w+)\s*\}\}((?:(?!\{\{#(?:if|unless)\b)[\s\S])*?)\{\{\/\1\}\}/g, (_m, kind: string, name: string, body: string) => {
      const [yes, no = ""] = body.split(/\{\{else\}\}/);
      const truthy = !!vars[name];
      return (kind === "if" ? truthy : !truthy) ? yes! : no;
    });
    if (next === out) break;
    out = next;
  }
  return out.replace(/\{\{\{?\s*([\w.]+)\s*\}?\}\}/g, (_m, name: string) => vars[name] ?? "");
}

// ---- loading ----------------------------------------------------------------------

/** Parse a bibliography file's text by extension or by sniffing. */
export async function parseBibliography(text: string, path: string): Promise<CslItem[]> {
  const trimmed = text.trimStart();
  if (/\.(bib|bibtex|biblatex)$/i.test(path) || trimmed.startsWith("@") || trimmed.startsWith("%")) return (await import("./bibtex")).bibtexToCsl(text);
  const data = JSON.parse(text) as unknown;
  if (Array.isArray(data)) return data.filter((d): d is CslItem => !!d && typeof d === "object" && "id" in d).map((d) => ({ ...d, id: String((d as CslItem)["citation-key"] ?? d.id) }));
  const items = (data as { items?: unknown[] })?.items;
  if (Array.isArray(items)) return items.map(betterBibtexJsonToCsl).filter((i): i is CslItem => !!i);
  throw new Error("The bibliography is neither BibTeX nor CSL-JSON.");
}

const ZOTERO_TYPES: Record<string, string> = {
  journalArticle: "article-journal",
  book: "book",
  bookSection: "chapter",
  conferencePaper: "paper-conference",
  thesis: "thesis",
  report: "report",
  webpage: "webpage",
  blogPost: "post-weblog",
  magazineArticle: "article-magazine",
  newspaperArticle: "article-newspaper",
  manuscript: "manuscript",
  preprint: "article",
  dataset: "dataset",
  computerProgram: "software",
  document: "document",
};

/** Better BibTeX JSON / Zotero item data → CSL-JSON. */
export function betterBibtexJsonToCsl(raw: unknown): CslItem | null {
  const d = raw as Record<string, any>;
  if (!d || typeof d !== "object") return null;
  const key = d.citationKey ?? d.citekey ?? /Citation Key:\s*(\S+)/i.exec(String(d.extra ?? ""))?.[1];
  if (!key || d.itemType === "attachment" || d.itemType === "note") return null;
  const creators = Array.isArray(d.creators) ? d.creators : [];
  const names = (type: string) => creators.filter((c: any) => (c.creatorType ?? "author") === type).map((c: any) => (c.name ? { literal: c.name } : { family: c.lastName, given: c.firstName }));
  const date = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(String(d.date ?? ""));
  const item: CslItem = {
    id: String(key),
    type: ZOTERO_TYPES[d.itemType] ?? "document",
    title: d.title,
    "title-short": d.shortTitle,
    "container-title": d.publicationTitle ?? d.bookTitle ?? d.proceedingsTitle ?? d.websiteTitle ?? d.blogTitle,
    volume: d.volume,
    issue: d.issue,
    page: d.pages,
    publisher: d.publisher ?? d.university ?? d.institution,
    "publisher-place": d.place,
    DOI: d.DOI,
    URL: d.url,
    ISBN: d.ISBN,
    abstract: d.abstractNote,
    author: names("author"),
    editor: names("editor"),
  };
  if (date) item.issued = { "date-parts": [[Number(date[1]), ...(date[2] ? [Number(date[2])] : []), ...(date[3] ? [Number(date[3])] : [])]] };
  for (const k of Object.keys(item)) if (item[k] === undefined || item[k] === "" || (Array.isArray(item[k]) && (item[k] as unknown[]).length === 0)) delete item[k];
  return item;
}

export interface ZoteroConfig {
  userId: string;
  apiKey: string;
  /** "users" or "groups" */
  libraryType: "users" | "groups";
}

/** All regular items of a Zotero library through the web API (CORS-enabled), as entries. */
export async function loadZotero(cfg: ZoteroConfig, fetchImpl: typeof fetch = fetch): Promise<Entry[]> {
  const out: Entry[] = [];
  const used = new Set<string>();
  for (let start = 0; start < 20_000; start += 100) {
    const url = `https://api.zotero.org/${cfg.libraryType}/${encodeURIComponent(cfg.userId)}/items?itemType=-attachment%20||%20note&include=data,csljson&limit=100&start=${start}`;
    const res = await fetchImpl(url, { headers: { "Zotero-API-Version": "3", ...(cfg.apiKey ? { "Zotero-API-Key": cfg.apiKey } : {}) } });
    if (!res.ok) throw new Error(res.status === 403 ? "Zotero refused the API key (403)." : `Zotero returned ${res.status}.`);
    const page = (await res.json()) as { key: string; data: Record<string, any>; csljson: CslItem }[];
    for (const it of page) {
      const csl = { ...(it.csljson ?? betterBibtexJsonToCsl(it.data)) } as CslItem;
      let key: string = it.data?.citationKey || /Citation Key:\s*(\S+)/i.exec(String(it.data?.extra ?? ""))?.[1] || csl["citation-key"] || "";
      if (!key) {
        const first = (csl.author as CslName[] | undefined)?.[0];
        const base = `${(first?.family ?? first?.literal ?? "anon").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")}${yearOf(csl)}`;
        key = base;
        for (let n = 0; used.has(key); n++) key = base + String.fromCharCode(97 + n);
      }
      used.add(String(key));
      csl.id = String(key);
      const entry = toEntry(csl, "zotero");
      entry.zoteroKey = it.key;
      out.push(entry);
    }
    const total = Number(res.headers.get("Total-Results") ?? page.length);
    if (page.length < 100 || start + 100 >= total) break;
  }
  return out;
}

// ---- citation syntax ----------------------------------------------------------------

export interface CiteItem {
  key: string;
  prefix?: string;
  suffix?: string;
  locator?: string;
  label?: string;
  suppressAuthor?: boolean;
}

export interface CiteCluster {
  start: number;
  end: number;
  items: CiteItem[];
  /** `@key` outside brackets: "Author (Year)". */
  narrative: boolean;
}

const KEY = String.raw`[\p{L}\p{N}_][\p{L}\p{N}_:.#$%&\-+?<>~/]*`;
const LABELS: [RegExp, string][] = [
  [/^(pp?\.?|pages?)$/i, "page"],
  [/^(ch\.?|chap\.?|chapters?)$/i, "chapter"],
  [/^(sec\.?|§+|sections?)$/i, "section"],
  [/^(vols?\.?|volumes?)$/i, "volume"],
  [/^(figs?\.?|figures?)$/i, "figure"],
  [/^(l\.|ll\.|lines?)$/i, "line"],
  [/^(n\.|nn\.|notes?)$/i, "note"],
  [/^(para\.?|paras\.?|paragraphs?|¶+)$/i, "paragraph"],
  [/^(col\.?|columns?)$/i, "column"],
  [/^(bk\.?|books?)$/i, "book"],
];

function trimKey(key: string): string {
  return key.replace(/[.:?]+$/, "");
}

function parseItem(raw: string): CiteItem | null {
  const m = new RegExp(String.raw`^(.*?)(-?)@(${KEY})(.*)$`, "su").exec(raw.trim());
  if (!m) return null;
  let key = m[3]!;
  let rest = m[4]!;
  const trimmed = trimKey(key);
  rest = key.slice(trimmed.length) + rest;
  key = trimmed;
  const item: CiteItem = { key };
  if (m[2] === "-") item.suppressAuthor = true;
  if (m[1]!.trim()) item.prefix = m[1]!.trim();
  let suffix = rest.replace(/^\s*,\s*/, "").trim();
  if (suffix) {
    const lm = /^([^\s\d]+)\s*([\d\p{L}][\w\s\-–,.]*?)$/u.exec(suffix);
    const label = lm ? LABELS.find(([re]) => re.test(lm[1]!))?.[1] : undefined;
    if (lm && label) {
      item.label = label;
      item.locator = lm[2]!.trim();
      suffix = "";
    } else if (/^\d[\d\s\-–,]*$/.test(suffix)) {
      item.label = "page";
      item.locator = suffix;
      suffix = "";
    }
    if (suffix) item.suffix = suffix;
  }
  return item;
}

/** Pandoc citations in a text: `[@a, p. 4; see @b]`, `[-@a]`, and narrative `@a` (only keys in `known`). */
export function findCitations(text: string, known?: (key: string) => boolean): CiteCluster[] {
  const out: CiteCluster[] = [];
  const bracket = /\[([^\[\]\n]*?@[^\[\]\n]*?)\](?![(:\[])/gu;
  let m: RegExpExecArray | null;
  const covered: [number, number][] = [];
  while ((m = bracket.exec(text))) {
    if (m.index > 0 && (text[m.index - 1] === "!" || text[m.index - 1] === "]")) continue;
    const items = m[1]!.split(";").map(parseItem);
    if (!items.length || items.some((i) => !i)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, items: items as CiteItem[], narrative: false });
    covered.push([m.index, m.index + m[0].length]);
  }
  if (known) {
    const narrative = new RegExp(String.raw`(^|[\s(])@(${KEY})`, "gu");
    while ((m = narrative.exec(text))) {
      const at = m.index + m[1]!.length;
      if (covered.some(([s, e]) => at >= s && at < e)) continue;
      const key = trimKey(m[2]!);
      if (!known(key)) continue;
      out.push({ start: at, end: at + 1 + key.length, items: [{ key }], narrative: true });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Every citekey cited in `text`, in order of first appearance. */
export function citedKeys(text: string, known?: (key: string) => boolean): string[] {
  const keys: string[] = [];
  for (const c of findCitations(text, known)) for (const i of c.items) if (!keys.includes(i.key)) keys.push(i.key);
  return keys;
}
