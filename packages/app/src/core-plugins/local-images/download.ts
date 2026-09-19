/**
 * Download remote images into the vault and rewrite the links (Local Images
 * Plus behaviour, and Obsidian's `editor:download-attachments`).
 *
 * - Finds `![alt](https://…)`, `![alt|300](<https://…>)` and `data:image/…`
 *   URIs outside code spans and fenced code.
 * - Fetches through `requestUrl` (bridge when installed, else `fetch`).
 * - Names files `<first 16 hex of SHA-256>.<ext>`; a file with that name
 *   anywhere in the vault is the same content and is reused.
 * - Saves where Obsidian's "Default location for new attachments" says.
 * - Rewrites links per "Use [[Wikilinks]]", keeping alt text and size, in one
 *   editor transaction (one undo) when the note is open, else `vault.process`.
 * - Every image fails on its own; the rest still download.
 */
import type { TFile } from "../../obsidian/vault/files";
import { fetchUrl, NetError } from "../smart-paste/network";
import { showReport } from "./report";

export interface RemoteImageLink {
  /** Offset of the whole `![…](…)` in the note */
  start: number;
  end: number;
  alt: string;
  url: string;
}

export interface DownloadFailure {
  url: string;
  status?: number;
  reason: string;
}

export interface DownloadResult {
  file: string;
  found: number;
  downloaded: number;
  reused: number;
  failures: DownloadFailure[];
}

export interface DownloadOptions {
  maxBytes?: number;
  /** Only links whose URL is in this set */
  onlyUrls?: Set<string>;
  signal?: { cancelled: boolean };
  report?: boolean;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/tiff": "tiff",
  "image/heic": "heic",
};
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "tif", "tiff", "heic"]);

/** Ranges of fenced code blocks and inline code spans, which are never scanned. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1?\2[`~]*[ \t]*$|(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    ranges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) fence.lastIndex++;
  }
  const inline = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
  while ((m = inline.exec(text))) {
    const s = m.index;
    if (!ranges.some(([a, b]) => s >= a && s < b)) ranges.push([s, s + m[0].length]);
  }
  return ranges;
}

export function findRemoteImages(text: string): RemoteImageLink[] {
  const skip = codeRanges(text);
  const out: RemoteImageLink[] = [];
  const re = /!\[([^\]\n]*)\]\(\s*(?:<((?:https?:\/\/|data:image\/)[^>\n]+)>|((?:https?:\/\/|data:image\/)[^\s)]+(?:\([^\s)]*\)[^\s)]*)*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    if (skip.some(([a, b]) => start >= a && start < b)) continue;
    out.push({ start, end: start + m[0].length, alt: m[1] ?? "", url: (m[2] ?? m[3])! });
  }
  return out;
}

function extFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() ?? "";
    const dot = last.lastIndexOf(".");
    const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
    return IMAGE_EXTS.has(ext) ? (ext === "jpeg" ? "jpg" : ext) : "";
  } catch {
    return "";
  }
}

/** Magic numbers, for servers that send `application/octet-stream`. */
function sniff(bytes: Uint8Array): string {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76) return "avif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  const head = new TextDecoder().decode(b.slice(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return "";
}

async function sha256Hex16(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 8), (x) => x.toString(16).padStart(2, "0")).join("");
}

function decodeDataUri(uri: string): { body: ArrayBuffer; mime: string } | null {
  const m = /^data:([^;,]+)((?:;[^;,]*)*?)(;base64)?,(.*)$/is.exec(uri);
  if (!m) return null;
  const mime = m[1]!.toLowerCase();
  try {
    if (m[3]) {
      const bin = atob(m[4]!.replace(/\s+/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { body: bytes.buffer, mime };
    }
    return { body: new TextEncoder().encode(decodeURIComponent(m[4]!)).buffer as ArrayBuffer, mime };
  } catch {
    return null;
  }
}

function reasonOf(e: unknown): DownloadFailure {
  if (e instanceof NetError) {
    const reasons: Record<string, string> = {
      cors: "Blocked by CORS (companion extension not installed)",
      offline: "No internet connection",
      "too-large": e.message,
      invalid: e.message,
      status: e.status ? `Server answered ${e.status}` : e.message,
    };
    return { url: "", status: e.status, reason: reasons[e.kind] ?? e.message };
  }
  return { url: "", reason: String((e as Error)?.message ?? e) };
}

/** Fetch one image and store it (or find the identical stored copy). */
async function storeImage(app: any, url: string, sourcePath: string, maxBytes: number, cache: Map<string, TFile>): Promise<{ file: TFile; reused: boolean }> {
  const cached = cache.get(url);
  if (cached) return { file: cached, reused: true };
  let body: ArrayBuffer;
  let mime = "";
  if (/^data:/i.test(url)) {
    const decoded = decodeDataUri(url);
    if (!decoded) throw new Error("Malformed data: URI");
    ({ body, mime } = decoded);
    if (body.byteLength > maxBytes) throw new NetError("too-large", `Larger than ${Math.round(maxBytes / 1048576)} MB`);
  } else {
    const res = await fetchUrl(url, { maxBytes });
    body = res.body;
    mime = res.contentType.split(";")[0]!.trim();
  }
  if (!body.byteLength) throw new Error("Empty response");
  const ext = MIME_EXT[mime] ?? sniff(new Uint8Array(body, 0, Math.min(body.byteLength, 512))) ?? "";
  const finalExt = ext || extFromUrl(url);
  if (!finalExt) throw new Error(mime ? `Not an image (${mime})` : "Not an image");
  if (mime && !mime.startsWith("image/") && mime !== "application/octet-stream" && mime !== "binary/octet-stream" && !ext) throw new Error(`Not an image (${mime})`);
  const name = `${await sha256Hex16(body)}.${finalExt}`;
  const existing = (app.vault.getFiles() as TFile[]).find((f) => f.name === name);
  if (existing) {
    cache.set(url, existing);
    return { file: existing, reused: true };
  }
  const path: string = await app.fileManager.getAvailablePathForAttachment(name, sourcePath);
  const file: TFile = await app.vault.createBinary(path, body);
  cache.set(url, file);
  return { file, reused: false };
}

/** `![alt|300](url)` → the vault link for `file`, keeping alt text and size. */
export function linkFor(app: any, file: TFile, sourcePath: string, alt: string): string {
  let text = alt.trim();
  if (!app.vault.getConfig("useMarkdownLinks")) {
    // `![[x.png|alt|300]]` is not wikilink syntax: keep the size when there is one, else the alt text.
    const size = /(?:^|\|)\s*(\d+(?:x\d+)?)\s*$/.exec(text);
    if (size) text = size[1]!;
  }
  return app.fileManager.generateMarkdownLink(file, sourcePath, undefined, text || undefined);
}

function openEditorFor(app: any, file: TFile): any | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown") as any[]) {
    const view = leaf.view;
    if (view?.file === file && view.editor && view.getMode?.() !== "preview") return view.editor;
  }
  for (const leaf of app.workspace.getLeavesOfType("markdown") as any[]) {
    if (leaf.view?.file === file && leaf.view.editor) return leaf.view.editor;
  }
  return null;
}

export async function downloadRemoteImagesInFile(app: any, file: TFile, opts: DownloadOptions = {}): Promise<DownloadResult> {
  const maxBytes = opts.maxBytes ?? 25 * 1048576;
  const editor = openEditorFor(app, file);
  const text: string = editor ? editor.getValue() : await app.vault.read(file);
  let links = findRemoteImages(text);
  if (opts.onlyUrls) links = links.filter((l) => opts.onlyUrls!.has(l.url));
  const result: DownloadResult = { file: file.path, found: links.length, downloaded: 0, reused: 0, failures: [] };
  if (!links.length) {
    if (opts.report) reportResult(app, [result]);
    return result;
  }
  const cache = new Map<string, TFile>();
  const replacements = new Map<string, string>(); // url → stored file path
  for (const url of new Set(links.map((l) => l.url))) {
    if (opts.signal?.cancelled) break;
    try {
      const { file: stored, reused } = await storeImage(app, url, file.path, maxBytes, cache);
      replacements.set(url, stored.path);
      if (reused) result.reused++;
      else result.downloaded++;
    } catch (e) {
      result.failures.push({ ...reasonOf(e), url: url.length > 120 ? url.slice(0, 117) + "…" : url });
    }
  }
  if (replacements.size) {
    const rewrite = (current: string) => {
      // Re-scan: the note may have changed while images downloaded.
      const edits = findRemoteImages(current)
        .filter((l) => replacements.has(l.url))
        .map((l) => {
          const stored = app.vault.getFileByPath(replacements.get(l.url)!);
          return stored ? { start: l.start, end: l.end, text: linkFor(app, stored, file.path, l.alt) } : null;
        })
        .filter((e): e is { start: number; end: number; text: string } => !!e);
      return edits;
    };
    const liveEditor = openEditorFor(app, file);
    if (liveEditor) {
      const edits = rewrite(liveEditor.getValue());
      if (edits.length) {
        liveEditor.transaction({ changes: edits.map((e) => ({ from: liveEditor.offsetToPos(e.start), to: liveEditor.offsetToPos(e.end), text: e.text })) }, "local-images");
      }
    } else {
      await app.vault.process(file, (current: string) => {
        const edits = rewrite(current).sort((a, b) => b.start - a.start);
        let out = current;
        for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
        return out;
      });
    }
  }
  if (opts.report) reportResult(app, [result]);
  return result;
}

/** Notice for a finished run; failures open a report listing URL, status and reason. */
export function reportResult(app: any, results: DownloadResult[], cancelled = false) {
  showReport(app, results, cancelled);
}
