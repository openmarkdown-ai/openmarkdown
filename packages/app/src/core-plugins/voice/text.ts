/**
 * Pure text helpers for the voice plugin: spoken punctuation for dictation,
 * and splitting a note into speakable sentences with their source offsets
 * (so the sentence being read can be highlighted in the editor).
 */
import { getFrontMatterInfo } from "../../obsidian/util";

// ---- dictation ------------------------------------------------------------------------

const SPOKEN: [RegExp, string][] = [
  [/\bnew paragraph\b/gi, "\n\n"],
  [/\bnew line\b/gi, "\n"],
  [/\b(?:full stop|period)\b/gi, "."],
  [/\bcomma\b/gi, ","],
  [/\bquestion mark\b/gi, "?"],
  [/\bexclamation (?:mark|point)\b/gi, "!"],
  [/\bsemicolon\b/gi, ";"],
  [/\bcolon\b/gi, ":"],
  [/\bopen (?:quote|quotes)\b/gi, "“"],
  [/\bclose (?:quote|quotes)\b/gi, "”"],
  [/\bopen (?:bracket|parenthesis)\b/gi, "("],
  [/\bclose (?:bracket|parenthesis)\b/gi, ")"],
  [/\b(?:dash|em dash)\b/gi, "—"],
  [/\bhyphen\b/gi, "-"],
];

/** Replaces spoken punctuation words ("comma", "new line" …) with the characters. */
export function applySpokenPunctuation(text: string): string {
  let out = text;
  for (const [re, ch] of SPOKEN) out = out.replace(re, `\u0001${ch}\u0002`);
  out = out
    .replace(/\s*\u0001([.,?!;:)”])\u0002/g, "$1") // closing marks attach to the previous word
    .replace(/\u0001([(“])\u0002\s*/g, "$1") // opening marks attach to the next word
    .replace(/[ \t]*\u0001(\n+)\u0002[ \t]*/g, "$1")
    .replace(/\s*\u0001(—)\u0002\s*/g, " $1 ")
    .replace(/\s*\u0001(-)\u0002\s*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/([.!?]\s+|\n)(\p{Ll})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  return out.replace(/^[ \t]+|[ \t]+$/g, "");
}

/**
 * The text to insert for a final recognition result, given the character
 * before the cursor: adds a separating space and capitalises a new sentence.
 */
export function joinDictation(text: string, before: string, punctuation: boolean): string {
  let t = punctuation ? applySpokenPunctuation(text) : text.trim();
  if (!t) return "";
  const prev = before.replace(/[ \t]+$/, "");
  const lastChar = prev.slice(-1);
  const startsSentence = !prev || /[.!?\n]$/.test(prev);
  if (startsSentence && /^\p{Ll}/u.test(t)) t = t[0]!.toUpperCase() + t.slice(1);
  const needsSpace = before.length > 0 && !/\s$/.test(before) && !/^[\n.,?!;:)”]/.test(t) && lastChar !== "(" && lastChar !== "“";
  return (needsSpace ? " " : "") + t;
}

// ---- read aloud -----------------------------------------------------------------------

export interface SpeechSegment {
  /** Offsets in the note text (UTF-16), for highlighting. */
  from: number;
  to: number;
  /** What is spoken. */
  text: string;
}

/** Markdown source of one sentence → the words to say. */
export function speakable(md: string): string {
  return md
    .replace(/%%[\s\S]*?%%/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]#]*)(?:#[^\]]*)?\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s{0,3}>\s*\[![^\]]*\][+-]?\s*/gm, "")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s*|[-*+]\s+\[.\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/(\*\*|__|==|~~|\*|_|`)/g, "")
    .replace(/(^|\s)#([\p{L}\p{N}_/-]+)/gu, "$1$2")
    .replace(/\^[\w-]+\s*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits `text` (optionally only `[rangeFrom, rangeTo)`) into sentences to read. */
export function speechSegments(text: string, rangeFrom = 0, rangeTo = text.length, locale?: string): SpeechSegment[] {
  const skip: [number, number][] = [];
  const fm = getFrontMatterInfo(text);
  if (fm.exists) skip.push([0, fm.contentStart]);
  const fence = /^( {0,3})(```+|~~~+)[^\n]*\n[\s\S]*?(?:\n\1\2[ \t]*(?:\n|$)|$)/gm;
  for (let m; (m = fence.exec(text)); ) skip.push([m.index, m.index + m[0].length]);
  const math = /\$\$[\s\S]*?\$\$/g;
  for (let m; (m = math.exec(text)); ) skip.push([m.index, m.index + m[0].length]);
  const comment = /%%[\s\S]*?%%/g;
  for (let m; (m = comment.exec(text)); ) skip.push([m.index, m.index + m[0].length]);
  skip.sort((a, b) => a[0] - b[0]);

  // Readable spans between skipped regions, then blocks separated by blank lines or line breaks.
  const spans: [number, number][] = [];
  let pos = rangeFrom;
  for (const [a, b] of skip) {
    if (b <= pos) continue;
    if (a >= rangeTo) break;
    if (a > pos) spans.push([pos, Math.min(a, rangeTo)]);
    pos = Math.max(pos, b);
  }
  if (pos < rangeTo) spans.push([pos, rangeTo]);

  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new (Intl as any).Segmenter(locale, { granularity: "sentence" }) : null;
  const out: SpeechSegment[] = [];
  for (const [a, b] of spans) {
    // Each line is its own unit (headings, list items, table rows); sentences split within.
    const lineRe = /[^\n]+/g;
    const chunk = text.slice(a, b);
    for (let lm; (lm = lineRe.exec(chunk)); ) {
      const lineStart = a + lm.index;
      const line = lm[0];
      // Sentence boundaries are found on a masked copy: embeds are blanked and
      // the dots inside links, URLs and code do not end a sentence.
      const masked = line
        .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, (m) => " ".repeat(m.length))
        .replace(/\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|`[^`]*`/g, (m) => m.replace(/[.!?]/g, "_"));
      const pieces: [number, string][] = [];
      if (segmenter) {
        for (const s of segmenter.segment(masked) as Iterable<{ segment: string; index: number }>) pieces.push([s.index, line.slice(s.index, s.index + s.segment.length)]);
      } else {
        const re = /[^.!?]+[.!?]*\s*/g;
        for (let sm; (sm = re.exec(masked)); ) pieces.push([sm.index, line.slice(sm.index, sm.index + sm[0].length)]);
      }
      for (const [idx, seg] of pieces) {
        const spoken = speakable(seg);
        if (!spoken || !/[\p{L}\p{N}]/u.test(spoken)) continue;
        const lead = seg.length - seg.trimStart().length;
        out.push({ from: lineStart + idx + lead, to: lineStart + idx + seg.trimEnd().length, text: spoken });
      }
    }
  }
  return out;
}
