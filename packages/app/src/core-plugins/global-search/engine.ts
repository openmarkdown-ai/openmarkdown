/**
 * The Rust index as the knowledge plugins see it.
 *
 * `app.metadataCache.index` answers search, backlinks and unlinked mentions.
 * Its JSON has moved as the crate grew (`results` vs `files`, `matchCount` vs
 * `totalMatches`, snippet objects vs strings), so every caller goes through
 * these normalisers and sees one stable shape. All offsets are UTF-16.
 */
import type { TFile } from "../../obsidian/vault/files";

export type Range = [number, number];

export interface ContentHit {
  start: number;
  end: number;
  line: number;
  /** The index's excerpt around the match (`text` starts at file offset `offset`). */
  context?: { text: string; offset: number };
}

export interface PropertyHit {
  key: string;
  subkey?: number[];
  pos?: Range;
}

export interface FileHit {
  path: string;
  filenameMatches: Range[];
  filepathMatches: Range[];
  content: ContentHit[];
  properties: PropertyHit[];
  matchCount: number;
}

export interface Explanation {
  label: string;
  children?: Explanation[];
}

export interface SearchRun {
  files: FileHit[];
  fileCount: number;
  matchCount: number;
  error?: string;
  explanation?: Explanation;
}

export type SortOrder = "alphabetical" | "alphabeticalReverse" | "byModifiedTime" | "byModifiedTimeReverse" | "byCreatedTime" | "byCreatedTimeReverse";

export const SORT_LABELS: [SortOrder, string][] = [
  ["alphabetical", "File name (A to Z)"],
  ["alphabeticalReverse", "File name (Z to A)"],
  ["byModifiedTime", "Modified time (new to old)"],
  ["byModifiedTimeReverse", "Modified time (old to new)"],
  ["byCreatedTime", "Created time (new to old)"],
  ["byCreatedTimeReverse", "Created time (old to new)"],
];

/** Obsidian stops a search after this many results. */
export const RESULT_LIMIT = 100_000;

function ranges(v: unknown): Range[] {
  if (!Array.isArray(v)) return [];
  const out: Range[] = [];
  for (const r of v) {
    if (Array.isArray(r) && r.length >= 2) out.push([Number(r[0]), Number(r[1])]);
    else if (r && typeof r === "object" && "start" in r) out.push([Number((r as { start: number }).start), Number((r as { end: number }).end)]);
  }
  return out;
}

function contentHits(v: unknown): ContentHit[] {
  if (!Array.isArray(v)) return [];
  const out: ContentHit[] = [];
  for (const m of v) {
    if (Array.isArray(m)) out.push({ start: Number(m[0]), end: Number(m[1]), line: -1 });
    else if (m && typeof m === "object") {
      const o = m as { start?: number; end?: number; line?: number; context?: { text?: string; offset?: number }; position?: { start: { offset: number; line: number }; end: { offset: number } } };
      const context = o.context && typeof o.context.text === "string" && typeof o.context.offset === "number" ? { text: o.context.text, offset: o.context.offset } : undefined;
      if (o.position) out.push({ start: o.position.start.offset, end: o.position.end.offset, line: o.position.start.line, context });
      else out.push({ start: Number(o.start ?? 0), end: Number(o.end ?? 0), line: Number(o.line ?? -1), context });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function runSearch(app: any, query: string, opts: { caseSensitive?: boolean; sort?: SortOrder; explain?: boolean; limit?: number } = {}): SearchRun {
  const index = app.metadataCache?.index;
  if (!index || typeof index.search !== "function") return { files: [], fileCount: 0, matchCount: 0, error: "Search is not available yet." };
  let raw: any;
  try {
    raw = index.search(query, {
      caseSensitive: !!opts.caseSensitive,
      sort: opts.sort ?? "alphabetical",
      explain: !!opts.explain,
      limit: opts.limit ?? RESULT_LIMIT,
    });
  } catch (e) {
    return { files: [], fileCount: 0, matchCount: 0, error: String((e as Error)?.message ?? e) };
  }
  if (!raw || typeof raw !== "object") return { files: [], fileCount: 0, matchCount: 0 };
  const list: any[] = raw.results ?? raw.files ?? [];
  const files: FileHit[] = [];
  for (const r of list) {
    if (!r || typeof r.path !== "string") continue;
    if (app.metadataCache.isUserIgnored?.(r.path)) continue;
    const content = contentHits(r.contentMatches ?? r.content);
    const filenameMatches = ranges(r.filenameMatches);
    const properties: PropertyHit[] = Array.isArray(r.properties) ? r.properties : [];
    files.push({
      path: r.path,
      filenameMatches,
      filepathMatches: ranges(r.filepathMatches),
      content,
      properties,
      matchCount: typeof r.matchCount === "number" ? r.matchCount : content.length + filenameMatches.length + properties.length,
    });
  }
  const matchCount = typeof raw.matchCount === "number" ? raw.matchCount : typeof raw.totalMatches === "number" ? raw.totalMatches : files.reduce((n, f) => n + f.matchCount, 0);
  return {
    files,
    fileCount: typeof raw.fileCount === "number" ? raw.fileCount : files.length,
    matchCount,
    error: raw.error || undefined,
    explanation: raw.explanation ?? undefined,
  };
}

// ---- backlinks ------------------------------------------------------------------

export interface LinkRef {
  kind: "link" | "embed" | "frontmatter";
  link: string;
  original: string;
  displayText?: string;
  key?: string;
  start: number;
  end: number;
  line: number;
  context?: { text: string; offset: number };
}

export interface BacklinkGroup {
  source: string;
  refs: LinkRef[];
}

export function getBacklinks(app: any, path: string): BacklinkGroup[] {
  const index = app.metadataCache?.index;
  let raw: any[] = [];
  try {
    raw = index?.backlinks?.(path) ?? [];
  } catch (e) {
    console.error(e);
  }
  const out: BacklinkGroup[] = [];
  for (const b of raw) {
    if (!b || typeof b.source !== "string") continue;
    const refs: LinkRef[] = [];
    for (const r of b.refs ?? []) {
      const pos = r.position;
      const kind = r.kind ?? (r.key ? "frontmatter" : typeof r.original === "string" && r.original.startsWith("!") ? "embed" : "link");
      refs.push({
        kind,
        link: r.link,
        original: r.original ?? "",
        displayText: r.displayText,
        key: r.key,
        start: pos?.start?.offset ?? -1,
        end: pos?.end?.offset ?? -1,
        line: pos?.start?.line ?? r.line ?? -1,
        context: r.context && typeof r.context.text === "string" && typeof r.context.offset === "number" ? { text: r.context.text, offset: r.context.offset } : undefined,
      });
    }
    out.push({ source: b.source, refs });
  }
  return out;
}

export interface MentionGroup {
  source: string;
  matches: ContentHit[];
}

export function getUnlinkedMentions(app: any, path: string): MentionGroup[] {
  const index = app.metadataCache?.index;
  let raw: any[] = [];
  try {
    raw = index?.unlinkedMentions?.(path) ?? [];
  } catch (e) {
    console.error(e);
  }
  const out: MentionGroup[] = [];
  for (const m of raw) {
    if (!m || typeof m.source !== "string") continue;
    if (app.metadataCache.isUserIgnored?.(m.source)) continue;
    const matches = contentHits(m.matches ?? m.refs);
    if (matches.length) out.push({ source: m.source, matches });
  }
  return out;
}

// ---- sorting --------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

export function sortFiles(files: TFile[], order: SortOrder): TFile[] {
  const byName = (a: TFile, b: TFile) => compareNames(a.basename, b.basename) || compareNames(a.path, b.path);
  const sorted = files.slice();
  switch (order) {
    case "alphabeticalReverse":
      sorted.sort((a, b) => byName(b, a));
      break;
    case "byModifiedTime":
      sorted.sort((a, b) => b.stat.mtime - a.stat.mtime || byName(a, b));
      break;
    case "byModifiedTimeReverse":
      sorted.sort((a, b) => a.stat.mtime - b.stat.mtime || byName(a, b));
      break;
    case "byCreatedTime":
      sorted.sort((a, b) => b.stat.ctime - a.stat.ctime || byName(a, b));
      break;
    case "byCreatedTimeReverse":
      sorted.sort((a, b) => a.stat.ctime - b.stat.ctime || byName(a, b));
      break;
    default:
      sorted.sort(byName);
  }
  return sorted;
}

/** Whole-word, case-insensitive occurrences of any of `names` in `text` (UTF-16 ranges). */
const WORD = /[\p{L}\p{N}_]/u;

export function isWordChar(ch: string | undefined): boolean {
  return !!ch && WORD.test(ch);
}

export function findWholeWord(text: string, lower: string, term: string): Range[] {
  const t = term.toLowerCase();
  const out: Range[] = [];
  if (!t) return out;
  let i = lower.indexOf(t);
  while (i !== -1) {
    const end = i + t.length;
    const beforeOk = !isWordChar(t[0]) || !isWordChar(text[i - 1]);
    const afterOk = !isWordChar(t[t.length - 1]) || !isWordChar(text[end]);
    if (beforeOk && afterOk) out.push([i, end]);
    i = lower.indexOf(t, i + 1);
  }
  return out;
}

/** Line number of `offset` given a prebuilt array of line start offsets. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
