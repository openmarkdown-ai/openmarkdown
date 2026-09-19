/**
 * Transcript text: segments → paragraphs → Markdown with timestamp links in
 * the Media plugin's (Media Extended's) exact format, so a click seeks the
 * player here and in Obsidian with Media Extended:
 *
 *   [[Recording 20260917.webm#t=01:23.47|01:23]] What was said…
 *
 * Pure functions; no app or DOM access.
 */
import type { EngineInfo, TranscriptSegment } from "../../ai/types";
import { formatDuration, toTempFragString } from "../media/timefrag";

export interface Paragraph {
  start: number;
  end: number;
  text: string;
}

export interface GroupOptions {
  /** A pause at least this long (seconds) starts a new paragraph. */
  pause: number;
  /** A paragraph longer than this (seconds) breaks at the next sentence end. */
  maxSeconds: number;
  /** …or longer than this many characters. */
  maxChars: number;
}

export const DEFAULT_GROUP: GroupOptions = { pause: 2, maxSeconds: 60, maxChars: 600 };

const SENTENCE_END = /[.!?。！？…]["'”’)\]]*$/;
/** Scripts written without spaces between words. */
const NO_SPACE = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const last = a[a.length - 1]!;
  const first = b[0]!;
  return NO_SPACE.test(last) && NO_SPACE.test(first) ? a + b : `${a} ${b}`;
}

/** Whisper segment text comes with stray leading spaces and bracketed non-speech tags. */
export function cleanSegmentText(text: string): string {
  return text
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NO_SPEECH|SILENCE|Music|music)\]|\((?:music|silence)\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function groupParagraphs(segments: TranscriptSegment[], opts: GroupOptions = DEFAULT_GROUP): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: Paragraph | null = null;
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  for (const seg of sorted) {
    const text = cleanSegmentText(seg.text);
    if (!text) continue;
    if (cur) {
      const gap = seg.start - cur.end;
      const long = cur.end - cur.start >= opts.maxSeconds || cur.text.length >= opts.maxChars;
      const hardLimit = cur.end - cur.start >= opts.maxSeconds * 2 || cur.text.length >= opts.maxChars * 2;
      if (gap >= opts.pause || (long && SENTENCE_END.test(cur.text)) || hardLimit) {
        out.push(cur);
        cur = null;
      }
    }
    if (!cur) cur = { start: Math.max(0, seg.start), end: seg.end, text };
    else {
      cur.text = join(cur.text, text);
      cur.end = Math.max(cur.end, seg.end);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** `t=01:23.47`; `t=0` at the very start (Media Extended's formatter has no form for zero). */
export function timeFragment(seconds: number): string {
  const s = Math.max(0, Math.round(seconds * 100) / 100);
  return s > 0 ? toTempFragString({ start: s, end: -1 })! : "t=0";
}

export type LinkMaker = (hash: string, text: string) => string;

/** Paragraphs as Markdown, each opening with its timestamp link. */
export function transcriptMarkdown(paragraphs: Paragraph[], link: LinkMaker): string {
  return paragraphs.map((p) => `${link(`#${timeFragment(p.start)}`, formatDuration(Math.floor(p.start)))} ${p.text}`).join("\n\n");
}

/** "On this device · Whisper base", "Ollama on this computer", "Sent to OpenAI · whisper-1". */
export function engineLabel(e: EngineInfo | null | undefined): string {
  if (!e) return "";
  const provider = PROVIDER_NAMES[e.provider] ?? e.provider;
  const model = e.model ? ` · ${e.model}` : "";
  if (e.location === "device") return `On this device${model}`;
  if (e.location === "local-server") return e.leavesDevice ? `Sent to ${provider}${model}` : `${provider} on this computer${model}`;
  return `Sent to ${provider}${model}`;
}

const PROVIDER_NAMES: Record<string, string> = {
  "chrome-builtin": "Chrome built-in AI",
  transformers: "Transformers.js",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "lm-studio": "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  "openai-compatible": "OpenAI-compatible server",
};

/** Text for a summary request: timestamps as `[mm:ss]` so the model can refer to them. */
export function transcriptForPrompt(paragraphs: Paragraph[]): string {
  return paragraphs.map((p) => `[${formatDuration(Math.floor(p.start))}] ${p.text}`).join("\n\n");
}

/** Read paragraphs back from a transcript note (for "Summarize transcript" on a note written earlier). */
export function paragraphsFromMarkdown(markdown: string): Paragraph[] {
  const out: Paragraph[] = [];
  const re = /^(?:\[\[[^\]|#]+#t=([\d:.]+)\|[^\]]*\]\]|\[[^\]]*\]\([^)#\s]+#t=([\d:.]+)\))\s+(.+)$/gm;
  for (const m of markdown.matchAll(re)) {
    const raw = (m[1] ?? m[2])!;
    const parts = raw.split(":").map(Number);
    const start = parts.reduce((acc, n) => acc * 60 + n, 0);
    out.push({ start, end: start, text: m[3]!.trim() });
  }
  return out;
}

export interface ChunkPlan {
  start: number;
  end: number;
}

/**
 * Split `duration` seconds into chunks of about `target` seconds, moving each
 * cut to the quietest moment within `slack` seconds of it so words are not
 * cut in half. `quietAt(from, to)` returns the quietest time in that range.
 */
export function planChunks(duration: number, target: number, slack: number, quietAt: (from: number, to: number) => number): ChunkPlan[] {
  if (!(duration > 0)) return [];
  if (duration <= target + slack) return [{ start: 0, end: duration }];
  const chunks: ChunkPlan[] = [];
  let start = 0;
  while (duration - start > target + slack) {
    const ideal = start + target;
    let cut = quietAt(Math.max(start + 1, ideal - slack), Math.min(duration - 1, ideal + slack));
    if (!(cut > start && cut < duration)) cut = ideal;
    chunks.push({ start, end: cut });
    start = cut;
  }
  chunks.push({ start, end: duration });
  return chunks;
}
