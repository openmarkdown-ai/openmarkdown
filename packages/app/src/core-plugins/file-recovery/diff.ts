/**
 * Line diff for File recovery's "Show changes": Myers' O(ND) algorithm
 * ("An O(ND) Difference Algorithm and Its Variations", 1986) over lines, with
 * the common prefix and suffix trimmed first so typical edits stay cheap.
 *
 * The result is grouped: consecutive lines of the same kind form one entry,
 * whose `text` is those lines joined with "\n".
 */

export type DiffType = "equal" | "insert" | "delete";

export interface DiffPart {
  type: DiffType;
  text: string;
}

export interface DiffLine {
  type: DiffType;
  line: string;
}

function splitLines(s: string): string[] {
  return s === "" ? [] : s.split(/\r?\n/);
}

/** Per-line edit script turning `a` into `b`. */
export function diffLineOps(aText: string, bText: string): DiffLine[] {
  const a = splitLines(aText);
  const b = splitLines(bText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: "equal", line: a[i]! });
  out.push(...myers(a.slice(start, endA), b.slice(start, endB)));
  for (let i = endA; i < a.length; i++) out.push({ type: "equal", line: a[i]! });
  return out;
}

function myers(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ type: "insert" as const, line }));
  if (m === 0) return a.map((line) => ({ type: "delete" as const, line }));
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Backtrack through the saved V arrays. trace[d] holds V as it was before step d.
  const ops: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : vd[offset + prevK]!;
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: "equal", line: a[x - 1]! });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ type: "insert", line: b[y - 1]! });
    else ops.push({ type: "delete", line: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  // Any remaining diagonal at d = 0.
  while (x > 0 && y > 0) {
    ops.push({ type: "equal", line: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

/** Grouped diff of two texts, line by line. */
export function diffLines(a: string, b: string): DiffPart[] {
  const parts: DiffPart[] = [];
  let cur: { type: DiffType; lines: string[] } | null = null;
  for (const op of diffLineOps(a, b)) {
    if (!cur || cur.type !== op.type) {
      if (cur) parts.push({ type: cur.type, text: cur.lines.join("\n") });
      cur = { type: op.type, lines: [] };
    }
    cur.lines.push(op.line);
  }
  if (cur) parts.push({ type: cur.type, text: cur.lines.join("\n") });
  return parts;
}
