/**
 * Text extraction from images and PDFs, all in the browser.
 *
 * - Images: the Shape Detection API's `TextDetector` when the browser has it
 *   (fast, no download), else Tesseract.js (Apache-2.0) in a worker. The
 *   worker script and the wasm core ship with the app and load lazily; only
 *   the per-language model (`<lang>.traineddata.gz`, 0.5–15 MB) is downloaded,
 *   after the user agrees, and kept in Cache Storage.
 * - PDFs: PDF.js text content per page; a page with no text layer is rendered
 *   to a canvas and OCR'd.
 *
 * Tesseract.js only accepts language data through its own IndexedDB cache or
 * a URL (its `{code, data}` form is broken in 7.0: `initialize` joins `.data`).
 * So the cached model is copied into that IndexedDB key right before a worker
 * starts and removed once the worker has read it.
 */
import { loadPdfJs } from "../../obsidian/markdown/loaders";
import { isAbort, throwIfAborted } from "../ai-tools/ui";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.includes(ext(path));
}
export function isPdfPath(path: string): boolean {
  return ext(path) === "pdf";
}
/** Text Extractor's `canFileBeExtracted` (Office files are not supported here). */
export function canFileBeExtracted(path: string): boolean {
  return isImagePath(path) || isPdfPath(path);
}
function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i + 1).toLowerCase();
}

/** Tesseract language codes, as Text Extractor's `getOcrLangs()` returns them. */
export const OCR_LANGS = "afr amh ara asm aze aze_cyrl bel ben bod bos bul cat ceb ces chi_sim chi_tra chr cym dan deu dzo ell eng enm epo est eus fas fin fra frk frm gle glg grc guj hat heb hin hrv hun iku ind isl ita ita_old jav jpn kan kat kat_old kaz khm kir kor kur lao lat lav lit mal mar mkd mlt msa mya nep nld nor ori pan pol por pus ron rus san sin slk slv spa spa_old sqi srp srp_latn swa swe syr tam tel tgk tgl tha tir tur uig ukr urd uzb uzb_cyrl vie yid".split(" ");

const LANG_NAMES: Record<string, string> = {
  eng: "English", deu: "German", fra: "French", spa: "Spanish", ita: "Italian", por: "Portuguese", nld: "Dutch", swe: "Swedish", dan: "Danish", nor: "Norwegian",
  fin: "Finnish", pol: "Polish", ces: "Czech", slk: "Slovak", hun: "Hungarian", ron: "Romanian", rus: "Russian", ukr: "Ukrainian", bul: "Bulgarian", ell: "Greek",
  tur: "Turkish", ara: "Arabic", heb: "Hebrew", fas: "Persian", hin: "Hindi", ben: "Bengali", tha: "Thai", vie: "Vietnamese", ind: "Indonesian", msa: "Malay",
  jpn: "Japanese", kor: "Korean", chi_sim: "Chinese (simplified)", chi_tra: "Chinese (traditional)", lat: "Latin", cat: "Catalan", hrv: "Croatian", srp: "Serbian",
  slv: "Slovenian", lit: "Lithuanian", lav: "Latvian", est: "Estonian", isl: "Icelandic", gle: "Irish", cym: "Welsh", tam: "Tamil", tel: "Telugu", urd: "Urdu",
};
export function langName(code: string): string {
  return LANG_NAMES[code] ? `${LANG_NAMES[code]} (${code})` : code;
}

/** UI language → Tesseract code, for the default language list. */
export function tesseractCodeFor(locale: string): string | null {
  const map: Record<string, string> = { en: "eng", de: "deu", fr: "fra", es: "spa", it: "ita", pt: "por", nl: "nld", sv: "swe", da: "dan", nb: "nor", no: "nor", fi: "fin", pl: "pol", cs: "ces", sk: "slk", hu: "hun", ro: "ron", ru: "rus", uk: "ukr", bg: "bul", el: "ell", tr: "tur", ar: "ara", he: "heb", fa: "fas", hi: "hin", th: "tha", vi: "vie", id: "ind", ms: "msa", ja: "jpn", ko: "kor", zh: "chi_sim" };
  const lower = locale.toLowerCase();
  if (lower.startsWith("zh-tw") || lower.startsWith("zh-hant") || lower.startsWith("zh-hk")) return "chi_tra";
  return map[lower.split("-")[0]!] ?? null;
}

// ---- language data -------------------------------------------------------------------

export const LANG_DATA_HOST = "cdn.jsdelivr.net";
const CACHE_NAME = "openmarkdown-ocr-v1";
export function langDataUrl(lang: string): string {
  return `https://${LANG_DATA_HOST}/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`;
}

export async function isLangCached(lang: string): Promise<boolean> {
  if (!("caches" in globalThis)) return !!memoryLangs.get(lang);
  try {
    const cache = await caches.open(CACHE_NAME);
    return !!(await cache.match(langDataUrl(lang)));
  } catch {
    return !!memoryLangs.get(lang);
  }
}

export async function missingLangs(langs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of langs) if (!(await isLangCached(l))) out.push(l);
  return out;
}

// Where Cache Storage is unavailable (some private windows) keep data for the session.
const memoryLangs = new Map<string, Uint8Array>();

/** Downloads one language model into the cache, reporting bytes. */
export async function downloadLang(lang: string, onProgress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(langDataUrl(lang), { signal });
  if (!res.ok) throw new Error(`Could not download ${langName(lang)} text recognition data (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  if (reader) {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    chunks.push(buf);
    loaded = buf.length;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(langDataUrl(lang), new Response(bytes, { headers: { "content-type": "application/gzip" } }));
  } catch {
    memoryLangs.set(lang, bytes);
  }
}

export async function deleteLangData(): Promise<void> {
  memoryLangs.clear();
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    /* no Cache Storage */
  }
}

async function readLang(lang: string): Promise<Uint8Array> {
  const mem = memoryLangs.get(lang);
  if (mem) return mem;
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(langDataUrl(lang));
  if (!hit) throw new Error(`${langName(lang)} text recognition data is not downloaded.`);
  return new Uint8Array(await hit.arrayBuffer());
}

// ---- tesseract's IndexedDB (idb-keyval defaults) ----------------------------------------

const TESS_CACHE_PATH = "openmarkdown-ocr";

function keyvalStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => void): Promise<T | void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("keyval-store");
    req.onupgradeneeded = () => req.result.createObjectStore("keyval");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("keyval", mode);
      fn(tx.objectStore("keyval"));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// ---- tesseract worker ------------------------------------------------------------------

type TessWorker = { recognize(image: unknown): Promise<{ data: { text: string } }>; terminate(): Promise<unknown> };
let worker: { langs: string; ready: Promise<TessWorker> } | null = null;
let idleTimer: number | null = null;
let progressSink: ((p: number, status: string) => void) | null = null;

async function getWorker(langs: string[]): Promise<TessWorker> {
  const key = langs.join("+");
  if (worker && worker.langs === key) return worker.ready;
  if (worker) {
    const old = worker.ready;
    worker = null;
    void old.then((w) => w.terminate()).catch(() => {});
  }
  const ready = (async () => {
    const [tesseract, workerUrl, coreUrl] = await Promise.all([
      import("tesseract.js/dist/tesseract.esm.min.js" as string),
      import("tesseract.js/dist/worker.min.js?url" as string),
      import("tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url" as string),
    ]);
    const data = await Promise.all(langs.map(readLang));
    await keyvalStore("readwrite", (s) => langs.forEach((l, i) => s.put(data[i], `${TESS_CACHE_PATH}/${l}.traineddata`)));
    try {
      const mod = tesseract as { createWorker?: Function; default?: { createWorker: Function } };
      const createWorker = mod.default?.createWorker ?? mod.createWorker!;
      const w = (await createWorker(key, 1, {
        workerPath: (workerUrl as { default: string }).default,
        corePath: (coreUrl as { default: string }).default,
        workerBlobURL: false,
        cachePath: TESS_CACHE_PATH,
        cacheMethod: "readOnly",
        // Never fall back to a silent network fetch: the data must come from the cache above.
        langPath: "https://offline.invalid/tessdata",
        logger: (m: { status: string; progress: number }) => progressSink?.(m.progress, m.status),
      })) as TessWorker;
      return w;
    } finally {
      await keyvalStore("readwrite", (s) => langs.forEach((l) => s.delete(`${TESS_CACHE_PATH}/${l}.traineddata`))).catch(() => {});
    }
  })();
  worker = { langs: key, ready };
  ready.catch(() => {
    if (worker?.ready === ready) worker = null;
  });
  return ready;
}

function scheduleIdleShutdown() {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => void terminateOcr(), 90_000);
}

export async function terminateOcr(): Promise<void> {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
  const w = worker;
  worker = null;
  if (w) await w.ready.then((x) => x.terminate()).catch(() => {});
}

// Only one recognition at a time: tesseract workers are single-job.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export interface ExtractOptions {
  langs: string[];
  useTextDetector: boolean;
  onProgress?: (fraction: number | null, status: string) => void;
  signal?: AbortSignal;
}

/** `TextDetector` from the Shape Detection API (Chromium behind a flag, some Android builds). */
export function hasTextDetector(): boolean {
  return typeof (globalThis as { TextDetector?: unknown }).TextDetector === "function";
}

async function detectWithTextDetector(bitmap: ImageBitmap): Promise<string | null> {
  try {
    const Detector = (globalThis as unknown as { TextDetector: new () => { detect(src: ImageBitmap): Promise<{ rawValue?: string; boundingBox: DOMRectReadOnly }[]> } }).TextDetector;
    const found = await new Detector().detect(bitmap);
    const blocks = found.filter((b) => b.rawValue && b.rawValue.trim());
    if (!blocks.length) return null;
    // Reading order: top to bottom, then left to right on roughly the same line.
    blocks.sort((a, b) => (Math.abs(a.boundingBox.top - b.boundingBox.top) < Math.min(a.boundingBox.height, b.boundingBox.height) / 2 ? a.boundingBox.left - b.boundingBox.left : a.boundingBox.top - b.boundingBox.top));
    const lines: string[] = [];
    let lastTop = -Infinity;
    let lastHeight = 0;
    for (const b of blocks) {
      if (lines.length && Math.abs(b.boundingBox.top - lastTop) < Math.max(4, lastHeight / 2)) lines[lines.length - 1] += ` ${b.rawValue!.trim()}`;
      else lines.push(b.rawValue!.trim());
      lastTop = b.boundingBox.top;
      lastHeight = b.boundingBox.height;
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

export async function recognizeImage(data: ArrayBuffer | Blob, opts: ExtractOptions): Promise<string> {
  const blob = data instanceof Blob ? data : new Blob([data]);
  if (opts.useTextDetector && hasTextDetector()) {
    try {
      const bitmap = await createImageBitmap(blob);
      const text = await detectWithTextDetector(bitmap);
      bitmap.close();
      if (text) return text;
    } catch {
      /* fall through to tesseract */
    }
  }
  return serial(async () => {
    throwIfAborted(opts.signal);
    progressSink = (p, status) => opts.onProgress?.(p, status);
    opts.onProgress?.(null, "Starting text recognition…");
    try {
      const w = await getWorker(opts.langs);
      throwIfAborted(opts.signal);
      // Tesseract reads a Blob via FileReader; transparent PNGs OCR badly, so flatten on white.
      const input = await flattenImage(blob).catch(() => blob);
      const { data: result } = await w.recognize(input);
      scheduleIdleShutdown();
      return cleanText(result.text);
    } finally {
      progressSink = null;
    }
  });
}

async function flattenImage(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** PDF text: the text layer where there is one, OCR for scanned pages. */
export async function extractPdf(data: ArrayBuffer, opts: ExtractOptions & { ocrScannedPages: boolean }): Promise<string> {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const pages: string[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      throwIfAborted(opts.signal);
      opts.onProgress?.((n - 1) / doc.numPages, `Reading page ${n} of ${doc.numPages}…`);
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str !== "string") continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      text = cleanText(text);
      if (!text && opts.ocrScannedPages) {
        const viewport = page.getViewport({ scale: 2 });
        const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
        const png = await canvas.convertToBlob({ type: "image/png" });
        text = await recognizeImage(png, { ...opts, onProgress: (p, s) => opts.onProgress?.((n - 1 + (p ?? 0)) / doc.numPages, `Page ${n}: ${s}`) });
      }
      page.cleanup?.();
      if (text) pages.push(text);
    }
  } finally {
    void doc.destroy?.();
  }
  return pages.join("\n\n");
}

export { isAbort };
