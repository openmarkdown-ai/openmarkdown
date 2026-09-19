/**
 * Byte-faithful text: what a file's bytes looked like when it was read, so a
 * save writes them back the same way.
 *
 * The app works on `\n` text (CodeMirror joins lines with `\n`, and the
 * TextDecoder drops a byte-order mark). Without this, merely opening a CRLF or
 * BOM note and leaving it rewrote every line ending, and a Latin-1 note was
 * saved with U+FFFD where its accented letters were. Each adapter owns one
 * `TextCodec`, which remembers per path whether the file had a BOM, which line
 * ending dominates, and whether its bytes were valid UTF-8 at all. String
 * writes re-apply the first two and refuse the third.
 */

export interface TextFormat {
  /** The file started with EF BB BF. */
  bom: boolean;
  /** Dominant line ending. */
  eol: "\n" | "\r\n";
  /** The bytes decoded as UTF-8 without error (and hold no NUL in the first 8 KB). */
  valid: boolean;
}

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenient = new TextDecoder("utf-8", { ignoreBOM: true });
const encoder = new TextEncoder();

export class NotUtf8Error extends Error {
  constructor(path: string) {
    super(`“${path}” is not UTF-8 text, so it was opened read-only and was not changed.`);
    this.name = "NotUtf8Error";
  }
}

export function decodeText(buf: ArrayBuffer | Uint8Array): { text: string; format: TextFormat } {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  let valid = true;
  try {
    text = strict.decode(bytes);
  } catch {
    valid = false;
    text = lenient.decode(bytes);
  }
  if (valid) {
    const n = Math.min(bytes.length, 8192);
    for (let i = 0; i < n; i++) {
      if (bytes[i] === 0) {
        valid = false;
        break;
      }
    }
  }
  if (bom && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, format: { bom, eol: detectEol(text), valid } };
}

/** `\r\n` when CRLF line breaks outnumber lone `\n`. */
export function detectEol(text: string): "\n" | "\r\n" {
  if (text.indexOf("\r\n") === -1) return "\n";
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/** Line endings as CodeMirror sees them: `\r\n` and lone `\r` become `\n`. */
export function normalizeEol(text: string): string {
  return text.indexOf("\r") === -1 ? text : text.replace(/\r\n?/g, "\n");
}

export function applyEol(text: string, eol: "\n" | "\r\n"): string {
  return eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
}

export class TextCodec {
  /** Only files that differ from the default (no BOM, `\n`, valid) have an entry. */
  private formats = new Map<string, TextFormat>();

  decode(path: string, buf: ArrayBuffer): string {
    const { text, format } = decodeText(buf);
    if (format.bom || format.eol !== "\n" || !format.valid) this.formats.set(path, format);
    else this.formats.delete(path);
    return text;
  }

  /** Bytes for a whole-file string write, restoring the file's BOM and line endings. */
  encode(path: string, text: string): ArrayBuffer {
    const f = this.formats.get(path);
    if (f && !f.valid) throw new NotUtf8Error(path);
    let out = f ? applyEol(text, f.eol) : text;
    if (f?.bom && out.charCodeAt(0) !== 0xfeff) out = "﻿" + out;
    return encoder.encode(out).buffer as ArrayBuffer;
  }

  /** Bytes for an append: line endings only. */
  encodeAppend(path: string, text: string): ArrayBuffer {
    const f = this.formats.get(path);
    if (f && !f.valid) throw new NotUtf8Error(path);
    return encoder.encode(f ? applyEol(text, f.eol) : text).buffer as ArrayBuffer;
  }

  get(path: string): TextFormat | null {
    return this.formats.get(path) ?? null;
  }

  /** Forget the format (after an explicit conversion to UTF-8, or a binary overwrite). */
  forget(path: string) {
    for (const k of Array.from(this.formats.keys())) if (k === path || k.startsWith(path + "/")) this.formats.delete(k);
  }

  move(from: string, to: string) {
    for (const [k, v] of Array.from(this.formats)) {
      if (k === from || k.startsWith(from + "/")) {
        this.formats.delete(k);
        this.formats.set(to + k.slice(from.length), v);
      }
    }
  }
}

/** A short, fast, non-cryptographic hash of a string (cyrb53). */
export function hashText(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
