/**
 * Splits a note into passages for embedding.
 *
 * Passages follow the note's structure: a new passage starts at every heading,
 * and a section longer than MAX_CHARS is split at paragraph boundaries (at
 * line boundaries for a single huge paragraph). Each passage after the first
 * in a section repeats the tail of the previous one (OVERLAP_CHARS) so a
 * sentence that straddles a split is still found. Tiny sections merge into the
 * next one under the same parent heading. Frontmatter is skipped; fenced code
 * is kept but never split on a "#" inside it.
 */

export interface Chunk {
  /** Heading texts from the top level down to this passage ([] above the first heading). */
  headings: string[];
  /** 0-based, inclusive line range in the note. */
  startLine: number;
  endLine: number;
  /** The passage text as written in the note (plus the overlap from the previous passage). */
  text: string;
}

export const MAX_CHARS = 1200;
export const MIN_CHARS = 120;
export const OVERLAP_CHARS = 160;

interface Block {
  startLine: number;
  endLine: number;
  text: string;
}

interface Section {
  headings: string[];
  blocks: Block[];
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

function stripInline(s: string): string {
  return s
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~=]/g, "")
    .trim();
}

function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trimEnd() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!.trimEnd();
    if (l === "---" || l === "...") return i + 1;
  }
  return 0;
}

function sections(text: string): Section[] {
  const lines = text.split("\n");
  const out: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let current: Section = { headings: [], blocks: [] };
  let block: Block | null = null;
  let fence: string | null = null;
  const flush = () => {
    if (block && block.text.trim()) current.blocks.push(block);
    block = null;
  };
  for (let i = frontmatterEnd(lines); i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1]!.startsWith(fence)) fence = null;
    } else if (f) {
      fence = f[1]!.slice(0, 3);
    } else {
      const h = HEADING.exec(line);
      if (h) {
        flush();
        if (current.blocks.length) out.push(current);
        const level = h[1]!.length;
        while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
        stack.push({ level, text: stripInline(h[2]!) });
        current = { headings: stack.map((s) => s.text), blocks: [] };
        // The heading line belongs to its section's first passage.
        block = { startLine: i, endLine: i, text: line };
        continue;
      }
      if (!line.trim()) {
        // A blank line ends a paragraph, but a heading line stays with the paragraph under it.
        if (block && !HEADING.test(block.text)) flush();
        continue;
      }
    }
    if (!block) block = { startLine: i, endLine: i, text: line };
    else {
      block.text += "\n" + line;
      block.endLine = i;
    }
  }
  flush();
  if (current.blocks.length) out.push(current);
  return out;
}

/** Splits one over-long block at line boundaries (or hard, for a single enormous line). */
function splitBlock(b: Block): Block[] {
  if (b.text.length <= MAX_CHARS) return [b];
  const out: Block[] = [];
  const lines = b.text.split("\n");
  let cur: Block | null = null;
  lines.forEach((line, j) => {
    const n = b.startLine + j;
    for (let k = 0; k < Math.max(1, Math.ceil(line.length / MAX_CHARS)); k++) {
      const piece = line.slice(k * MAX_CHARS, (k + 1) * MAX_CHARS);
      if (cur && cur.text.length + piece.length + 1 > MAX_CHARS) {
        out.push(cur);
        cur = null;
      }
      if (!cur) cur = { startLine: n, endLine: n, text: piece };
      else {
        cur.text += "\n" + piece;
        cur.endLine = n;
      }
    }
  });
  if (cur) out.push(cur);
  return out;
}

function tail(text: string): string {
  if (text.length <= OVERLAP_CHARS) return text;
  const cut = text.slice(-OVERLAP_CHARS);
  const space = cut.search(/\s/);
  return space > 0 && space < OVERLAP_CHARS / 2 ? cut.slice(space + 1) : cut;
}

export function chunkNote(text: string): Chunk[] {
  const out: Chunk[] = [];
  let pending: Chunk | null = null;
  for (const section of sections(text)) {
    const blocks = section.blocks.flatMap(splitBlock);
    let cur: Chunk | null = null;
    // A small passage left over from the previous section joins this one if it is its parent.
    if (pending) {
      const p: Chunk = pending;
      const isParent = p.headings.length < section.headings.length && p.headings.every((h, i) => section.headings[i] === h);
      if (isParent && p.text.length + (blocks[0]?.text.length ?? 0) < MAX_CHARS) cur = { ...p, headings: section.headings };
      else out.push(p);
      pending = null;
    }
    for (const b of blocks) {
      if (cur && cur.text.length + b.text.length + 2 > MAX_CHARS) {
        out.push(cur);
        const overlap = tail(cur.text);
        cur = { headings: section.headings, startLine: b.startLine, endLine: b.endLine, text: `${overlap}\n\n${b.text}` };
        continue;
      }
      if (!cur) cur = { headings: section.headings, startLine: b.startLine, endLine: b.endLine, text: b.text };
      else {
        cur.text += "\n\n" + b.text;
        cur.endLine = b.endLine;
      }
    }
    if (!cur) continue;
    if (cur.text.length < MIN_CHARS) pending = cur;
    else out.push(cur);
  }
  if (pending) out.push(pending);
  return out;
}

/** The text sent to the embedding model: where the passage sits, then the passage. */
export function embeddingText(title: string, chunk: Chunk): string {
  const where = [title, ...chunk.headings].join(" > ");
  return `${where}\n${chunk.text}`;
}

/** A fast 53-bit string hash (cyrb53), as a base-36 string. Not cryptographic. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
