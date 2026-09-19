/**
 * Vault-wide search and replace, driven by the Search view's query.
 *
 * Every content match of the query (the same ranges the results highlight) is
 * a candidate. A `/regex/` term in the query replaces with JavaScript
 * replacement syntax (`$1`, `$<name>`, `$&`); anything else is replaced
 * literally. Match case follows the view's toggle.
 *
 * Writing: each file gets a File recovery snapshot first, then one
 * `vault.process` call (atomic per file) that only applies when the text is
 * still what the preview was computed from. The last run can be undone
 * ("Search: Undo last vault replace"), file by file, where the file has not
 * changed since.
 */
import { Notice } from "../../obsidian/ui/notice";
import { TFile } from "../../obsidian/vault/files";
import { runSearch, type Range } from "./engine";

export interface ReplaceMatch {
  start: number;
  end: number;
  text: string;
  replacement: string;
  /**
   * Set when the match sits where replacing it would break something: a link
   * or embed target, a tag, a property name, a URL. Such matches are left out
   * unless the user asks for them ("Also replace inside links and tags", or
   * ticking the row).
   */
  reason?: string;
}

export interface ReplaceFilePlan {
  file: TFile;
  text: string;
  matches: ReplaceMatch[];
}

export interface ReplaceRecord {
  query: string;
  files: { path: string; before: string; after: string }[];
  count: number;
}

let lastRecord: ReplaceRecord | null = null;

export function lastReplace(): ReplaceRecord | null {
  return lastRecord;
}

/** `/pattern/` terms of an Obsidian search query, as their source strings. */
export function regexTerms(query: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s(:-])\/((?:\\.|[^/\\\n])+)\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) out.push(m[1]!);
  return out;
}

/** A function from matched text to its replacement. */
export function buildReplacer(query: string, replacement: string, caseSensitive: boolean): (matched: string) => string {
  const regexes: RegExp[] = [];
  for (const src of regexTerms(query)) {
    try {
      regexes.push(new RegExp(`^(?:${src})$`, caseSensitive ? "u" : "iu"));
    } catch {
      try {
        regexes.push(new RegExp(`^(?:${src})$`, caseSensitive ? "" : "i"));
      } catch {
        /* invalid pattern: the search reports it */
      }
    }
  }
  return (matched: string) => {
    for (const re of regexes) if (re.test(matched)) return matched.replace(re, replacement);
    return replacement;
  };
}

export function matchKey(path: string, start: number, end: number): string {
  return `${path}::${start}:${end}`;
}

/**
 * The query replace searches with. Plain words with no search syntax (`Acme Corp`) are
 * replaced as the phrase the user typed, as every editor's replace does; otherwise
 * search's "all of these words" meaning highlights each word, and each would be
 * replaced on its own ("Acme Inc. Corp"). Queries with operators, quotes or regex
 * keep their search meaning.
 */
export function replaceQuery(query: string): string {
  const q = query.trim();
  if (!/\s/.test(q)) return q;
  if (/["/():\[\]]|(^|\s)-\S|\bOR\b/.test(q)) return q;
  return `"${q.replace(/\s+/g, " ")}"`;
}

export const REASON_LINK = "Inside a link — renaming the file updates links";
export const REASON_EMBED = "Inside an embed — renaming the file updates embeds";
export const REASON_TAG = "A tag — rename tags from the Tags view";
export const REASON_PROPERTY = "A property name — rename properties from All properties";
export const REASON_URL = "Inside a web address";

interface Protected {
  start: number;
  end: number;
  reason: string;
}

type Loc = { start: { offset: number }; end: { offset: number } };

/** The parts of a wikilink / Markdown link that are its target: everything but the display text. */
function linkTargetSpans(original: string, start: number, end: number): [number, number][] {
  if (original.startsWith("[[")) {
    const bar = original.indexOf("|");
    // [[target|display]]: the display text is prose; the target and brackets are not.
    return bar < 0 ? [[start, end]] : [[start, start + bar + 1], [end - 2, end]];
  }
  const mid = original.lastIndexOf("](");
  if (original.startsWith("[") && mid > 0) return [[start, start + 1], [start + mid, end]];
  return [[start, end]];
}

/**
 * Ranges of `text` a vault replace must not rewrite by default, from the metadata
 * cache's link, embed, tag and frontmatter positions (UTF-16 offsets, as `text`),
 * plus web addresses, which the cache does not record.
 */
export function protectedRanges(cache: any, text: string): Protected[] {
  const out: Protected[] = [];
  const add = (start: number, end: number, reason: string) => {
    if (end > start) out.push({ start, end, reason });
  };
  const cached = (loc: Loc | undefined) => (loc && typeof loc.start?.offset === "number" ? [loc.start.offset, loc.end.offset] : null);
  for (const l of (cache?.links ?? []) as { original?: string; position?: Loc }[]) {
    const r = cached(l.position);
    if (!r) continue;
    const original = text.slice(r[0], r[1]);
    for (const [s, e] of linkTargetSpans(original || l.original || "", r[0]!, r[1]!)) add(s, e, REASON_LINK);
  }
  for (const l of (cache?.embeds ?? []) as { position?: Loc }[]) {
    const r = cached(l.position);
    if (r) add(r[0]!, r[1]!, REASON_EMBED);
  }
  for (const t of (cache?.tags ?? []) as { position?: Loc }[]) {
    const r = cached(t.position);
    if (r) add(r[0]!, r[1]!, REASON_TAG);
  }
  const fm = cached(cache?.frontmatterPosition);
  if (fm) {
    // Property names, tag values, and wikilinks in values. The cache has no per-key positions.
    let offset = fm[0]!;
    let key = "";
    for (const line of text.slice(fm[0], fm[1]).split("\n")) {
      const top = /^([^\s#:\-][^:\n]*?)\s*:(?=\s|$)/.exec(line);
      let valueFrom = 0;
      if (top && line !== "---") {
        key = top[1]!.replace(/^["']|["']$/g, "").toLowerCase();
        add(offset, offset + top[1]!.length, REASON_PROPERTY);
        valueFrom = top[0].length;
      }
      if ((key === "tags" || key === "tag") && line !== "---") {
        const value = line.slice(valueFrom);
        for (const m of value.matchAll(/[^\s,\[\]"'\-][^,\[\]"'\s]*/g)) add(offset + valueFrom + m.index!, offset + valueFrom + m.index! + m[0].length, REASON_TAG);
      }
      for (const m of line.matchAll(/\[\[[^\]\n]*\]\]/g)) for (const [s, e] of linkTargetSpans(m[0], offset + m.index!, offset + m.index! + m[0].length)) add(s, e, REASON_LINK);
      offset += line.length + 1;
    }
  }
  for (const m of text.matchAll(/\b(?:https?|ftp|file|mailto|obsidian):(?:\/\/)?[^\s<>()\[\]"'`]+/gi)) add(m.index!, m.index! + m[0].length, REASON_URL);
  return out.sort((a, b) => a.start - b.start);
}

/** A function from a match range to the reason it is protected, or null. */
export function protectionFor(app: any, file: TFile, text: string): (start: number, end: number) => string | null {
  const ranges = protectedRanges(app.metadataCache?.getFileCache?.(file), text);
  if (!ranges.length) return () => null;
  return (start, end) => {
    for (const r of ranges) {
      if (r.start >= end) break;
      if (r.end > start) return r.reason;
    }
    return null;
  };
}

/** The matches of `query` in every file, with their replacements (reads each file). */
export async function planReplace(app: any, query: string, replacement: string, caseSensitive: boolean): Promise<ReplaceFilePlan[]> {
  query = replaceQuery(query);
  const run = runSearch(app, query, { caseSensitive });
  if (run.error) throw new Error(run.error);
  const replacer = buildReplacer(query, replacement, caseSensitive);
  const plans: ReplaceFilePlan[] = [];
  for (const hit of run.files) {
    const file = app.vault.getFileByPath(hit.path);
    if (!(file instanceof TFile) || !hit.content.length) continue;
    const text: string = await app.vault.read(file);
    plans.push({ file, text, matches: matchesFor(text, hit.content.map((c) => [c.start, c.end] as Range), replacer, protectionFor(app, file, text)) });
  }
  return plans.filter((p) => p.matches.length);
}

/** Non-overlapping matches in `text` with their replacements. */
export function matchesFor(text: string, ranges: Range[], replacer: (matched: string) => string, protection?: (start: number, end: number) => string | null): ReplaceMatch[] {
  const out: ReplaceMatch[] = [];
  let lastEnd = -1;
  for (const [start, end] of ranges.slice().sort((a, b) => a[0] - b[0])) {
    if (start < lastEnd || end <= start || end > text.length) continue;
    const matched = text.slice(start, end);
    const m: ReplaceMatch = { start, end, text: matched, replacement: replacer(matched) };
    const reason = protection?.(start, end);
    if (reason) m.reason = reason;
    out.push(m);
    lastEnd = end;
  }
  return out;
}

export function applyToText(text: string, matches: ReplaceMatch[]): string {
  let out = text;
  for (const m of matches.slice().sort((a, b) => b.start - a.start)) out = out.slice(0, m.start) + m.replacement + out.slice(m.end);
  return out;
}

async function snapshot(app: any, file: TFile, text: string) {
  const recovery = app.internalPlugins?.getEnabledPluginById?.("file-recovery");
  try {
    await recovery?.forceAdd?.(file.path, text);
  } catch (e) {
    console.error("Replace: could not snapshot", file.path, e);
  }
}

/** Writes the plans. `include` filters matches (Replace selected). */
export async function executeReplace(app: any, query: string, plans: ReplaceFilePlan[], include: (file: TFile, m: ReplaceMatch) => boolean): Promise<ReplaceRecord> {
  const record: ReplaceRecord = { query, files: [], count: 0 };
  let skipped = 0;
  for (const plan of plans) {
    const chosen = plan.matches.filter((m) => include(plan.file, m));
    if (!chosen.length || plan.file.deleted) continue;
    await snapshot(app, plan.file, plan.text);
    let after = null as string | null;
    await app.vault.process(plan.file, (current: string) => {
      if (current !== plan.text) {
        after = null;
        return current;
      }
      after = applyToText(current, chosen);
      return after;
    });
    if (after === null) {
      skipped++;
      continue;
    }
    record.files.push({ path: plan.file.path, before: plan.text, after });
    record.count += chosen.length;
  }
  if (record.files.length) lastRecord = record;
  if (skipped) new Notice(`${skipped} file${skipped === 1 ? "" : "s"} changed since the preview and ${skipped === 1 ? "was" : "were"} not replaced. Search again to include ${skipped === 1 ? "it" : "them"}.`);
  return record;
}

/** Reverts the last run in every file that has not changed since. */
export async function undoLastReplace(app: any): Promise<{ restored: number; conflicts: number }> {
  const record = lastRecord;
  if (!record) return { restored: 0, conflicts: 0 };
  let restored = 0;
  let conflicts = 0;
  for (const f of record.files) {
    const file = app.vault.getFileByPath(f.path);
    if (!(file instanceof TFile)) {
      conflicts++;
      continue;
    }
    let ok = false as boolean;
    await app.vault.process(file, (current: string) => {
      if (current !== f.after) return current;
      ok = true;
      return f.before;
    });
    if (ok) restored++;
    else conflicts++;
  }
  lastRecord = null;
  return { restored, conflicts };
}

export async function undoWithNotice(app: any) {
  const { restored, conflicts } = await undoLastReplace(app);
  let msg = `Restored ${restored} file${restored === 1 ? "" : "s"}.`;
  if (conflicts) msg += ` ${conflicts} file${conflicts === 1 ? " was" : "s were"} edited since and left as they are; File recovery has the version from before the replace.`;
  new Notice(msg);
}
