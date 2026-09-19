/**
 * Line-based three-way merge (diff3), for "the file changed on disk while you
 * were editing it".
 *
 * `base` is the text both sides started from, `ours` the editor's buffer and
 * `theirs` the text now on disk. Each side is diffed against the base (Myers,
 * from File recovery's diff), giving hunks that replace a base line range.
 * Hunks from the two sides that overlap — or insert at the same base position —
 * form one region: taken from whichever side changed it, once if both made the
 * same change, and otherwise a conflict.
 *
 * `text` is the merge with conflicts resolved as ours; `bothText` keeps both
 * sides of every conflict, ours first, with no markers.
 */
import { diffLineOps } from "../../core-plugins/file-recovery/diff";

export interface MergeConflict {
  base: string[];
  ours: string[];
  theirs: string[];
}

export interface MergeResult {
  clean: boolean;
  text: string;
  bothText: string;
  conflicts: MergeConflict[];
}

interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

function lines(s: string): string[] {
  return s === "" ? [] : s.split("\n");
}

function hunks(base: string, other: string): Hunk[] {
  const out: Hunk[] = [];
  let pos = 0;
  let cur: Hunk | null = null;
  for (const op of diffLineOps(base, other)) {
    if (op.type === "equal") {
      if (cur) out.push(cur);
      cur = null;
      pos++;
      continue;
    }
    cur ??= { start: pos, end: pos, lines: [] };
    if (op.type === "delete") {
      pos++;
      cur.end = pos;
    } else cur.lines.push(op.line);
  }
  if (cur) out.push(cur);
  return out;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

/** Apply `hs` (sorted, non-overlapping) to base[from, to). */
function applyHunks(base: string[], from: number, to: number, hs: Hunk[]): string[] {
  const out: string[] = [];
  let pos = from;
  for (const h of hs) {
    for (; pos < h.start; pos++) out.push(base[pos]!);
    out.push(...h.lines);
    pos = h.end;
  }
  for (; pos < to; pos++) out.push(base[pos]!);
  return out;
}

export function merge3(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs) return { clean: true, text: ours, bothText: ours, conflicts: [] };
  if (base === ours) return { clean: true, text: theirs, bothText: theirs, conflicts: [] };
  if (base === theirs) return { clean: true, text: ours, bothText: ours, conflicts: [] };
  const b = lines(base);
  const a = hunks(base, ours);
  const t = hunks(base, theirs);
  const merged: string[] = [];
  const both: string[] = [];
  const conflicts: MergeConflict[] = [];
  let pos = 0;
  let i = 0;
  let j = 0;
  // Two insertions at the same point overlap; an insertion overlaps a range
  // only strictly inside it (at either edge it simply goes before or after).
  const overlaps = (h: Hunk, start: number, end: number) => {
    const hEmpty = h.start === h.end;
    const rEmpty = start === end;
    if (hEmpty && rEmpty) return h.start === start;
    if (hEmpty) return start < h.start && h.start < end;
    if (rEmpty) return h.start < start && start < h.end;
    return h.start < end && h.end > start;
  };
  const before = (x: Hunk, y: Hunk) => x.start < y.start || (x.start === y.start && x.start === x.end);
  while (i < a.length || j < t.length) {
    // Start a region at the earliest hunk, then grow it while hunks of either side touch it.
    const first = j >= t.length || (i < a.length && before(a[i]!, t[j]!)) ? a[i]! : t[j]!;
    let start = first.start;
    let end = first.end;
    const ra: Hunk[] = [];
    const rt: Hunk[] = [];
    let grew = true;
    while (grew) {
      grew = false;
      while (i < a.length && overlaps(a[i]!, start, end)) {
        ra.push(a[i]!);
        start = Math.min(start, a[i]!.start);
        end = Math.max(end, a[i]!.end);
        i++;
        grew = true;
      }
      while (j < t.length && overlaps(t[j]!, start, end)) {
        rt.push(t[j]!);
        start = Math.min(start, t[j]!.start);
        end = Math.max(end, t[j]!.end);
        j++;
        grew = true;
      }
    }
    for (; pos < start; pos++) {
      merged.push(b[pos]!);
      both.push(b[pos]!);
    }
    const oursLines = applyHunks(b, start, end, ra);
    const theirLines = applyHunks(b, start, end, rt);
    if (!rt.length || sameLines(oursLines, theirLines)) {
      merged.push(...oursLines);
      both.push(...oursLines);
    } else if (!ra.length) {
      merged.push(...theirLines);
      both.push(...theirLines);
    } else {
      conflicts.push({ base: b.slice(start, end), ours: oursLines, theirs: theirLines });
      merged.push(...oursLines);
      both.push(...oursLines, ...theirLines);
    }
    pos = end;
  }
  for (; pos < b.length; pos++) {
    merged.push(b[pos]!);
    both.push(b[pos]!);
  }
  return { clean: conflicts.length === 0, text: merged.join("\n"), bothText: both.join("\n"), conflicts };
}
