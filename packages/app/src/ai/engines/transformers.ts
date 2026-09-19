/**
 * On-device embeddings and Whisper transcription with transformers.js, in a
 * worker (transformers-worker.ts), loaded on first use after consent.
 *
 * Default models (checked 2026-09-17 against the Hugging Face file listings):
 * - Embeddings: `Xenova/multilingual-e5-small` (MIT, ~100 languages, 384
 *   dimensions), 8-bit weights, 118 MB + tokenizer. Always run on WASM, so the
 *   vectors are the same on every machine (an index built on one device stays
 *   comparable with queries on another). e5 expects "query: " / "passage: "
 *   prefixes, which is what `EmbedRequest.kind` is for.
 * - Transcription: `onnx-community/whisper-base` (Apache-2.0, 99 languages).
 *   On WebGPU the 8-bit export (~77 MB); on WASM the full-precision export
 *   (~291 MB), because the 8-bit Whisper exports fail to load on ONNX Runtime's
 *   WASM backend (measured in openapps/opensubs).
 */
import { Notice } from "../../obsidian/ui/notice";
import type { AiProvider, Capability, ProviderSettings } from "../provider";
import { AiUnavailableError, type EmbedRequest, type TranscribeRequest, type TranscriptSegment } from "../types";
import { formatBytes } from "../ui";

export const EMBED_MODEL = "Xenova/multilingual-e5-small";
export const WHISPER_MODEL = "onnx-community/whisper-base";
export const TRANSFORMERS_CACHE = "transformers-cache";
const HF = "https://huggingface.co";
const MB = 1024 * 1024;

/** Weight files and sizes of the default models, so consent can state the size before anything is fetched. */
const KNOWN: Record<string, { files: Record<string, number>; extra: number }> = {
  [`${EMBED_MODEL}|q8`]: { files: { "onnx/model_quantized.onnx": 118_308_185 }, extra: 17 * MB },
  [`${WHISPER_MODEL}|q8`]: { files: { "onnx/encoder_model_quantized.onnx": 23_201_314, "onnx/decoder_model_merged_quantized.onnx": 53_693_315 }, extra: 3 * MB },
  [`${WHISPER_MODEL}|fp32`]: { files: { "onnx/encoder_model.onnx": 82_468_078, "onnx/decoder_model_merged.onnx": 208_521_528 }, extra: 3 * MB },
};
/** The ONNX Runtime WebAssembly binary, served by this app but cached with the models. */
const RUNTIME_BYTES = 27 * MB;

let webgpu: Promise<boolean> | null = null;
function hasWebGpu(): Promise<boolean> {
  webgpu ??= (async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    try {
      return !!(await gpu.requestAdapter());
    } catch {
      return false;
    }
  })();
  return webgpu;
}

async function plan(cap: Capability, s: ProviderSettings): Promise<{ model: string; device: "wasm" | "webgpu"; dtype: string }> {
  if (cap === "embed") return { model: s.embedModel?.trim() || EMBED_MODEL, device: "wasm", dtype: "q8" };
  const gpu = await hasWebGpu();
  return { model: s.transcribeModel?.trim() || WHISPER_MODEL, device: gpu ? "webgpu" : "wasm", dtype: gpu ? "q8" : "fp32" };
}

async function cachedUrls(): Promise<Set<string>> {
  if (typeof caches === "undefined") return new Set();
  try {
    const cache = await caches.open(TRANSFORMERS_CACHE);
    return new Set((await cache.keys()).map((r) => r.url));
  } catch {
    return new Set();
  }
}

/** Downloaded models in Cache Storage, grouped by repository, with sizes (for Settings → AI). */
export async function downloadedModels(): Promise<{ id: string; bytes: number; files: number }[]> {
  if (typeof caches === "undefined") return [];
  const cache = await caches.open(TRANSFORMERS_CACHE);
  const groups = new Map<string, { bytes: number; files: number }>();
  for (const req of await cache.keys()) {
    const m = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\//.exec(req.url);
    const id = m ? m[1]! : "ONNX Runtime (WebAssembly)";
    const res = await cache.match(req);
    let bytes = Number(res?.headers.get("content-length") ?? NaN);
    if (!Number.isFinite(bytes) && res) bytes = (await res.blob()).size;
    const g = groups.get(id) ?? { bytes: 0, files: 0 };
    g.bytes += Number.isFinite(bytes) ? bytes : 0;
    g.files++;
    groups.set(id, g);
  }
  return [...groups].map(([id, g]) => ({ id, ...g })).sort((a, b) => b.bytes - a.bytes);
}

export async function deleteDownloadedModel(id: string): Promise<void> {
  const cache = await caches.open(TRANSFORMERS_CACHE);
  for (const req of await cache.keys()) {
    const isRepo = req.url.startsWith(`${HF}/${id}/resolve/`);
    const isRuntime = id === "ONNX Runtime (WebAssembly)" && !req.url.startsWith(`${HF}/`);
    if (isRepo || isRuntime) await cache.delete(req);
  }
  terminateWorker();
}

// ---- worker ----------------------------------------------------------------------------------------

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve(v: any): void; reject(e: unknown): void; onProgress?(done: number, total: number): void; onDownload?(loaded: number, total: number): void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./transformers-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (evt) => {
    const msg = evt.data as { id: number; type: string; [k: string]: any };
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === "download") p.onDownload?.(msg.loaded, msg.total);
    else if (msg.type === "progress") p.onProgress?.(msg.done, msg.total);
    else {
      pending.delete(msg.id);
      if (msg.type === "error") p.reject(new AiUnavailableError("failed", `The on-device model failed: ${msg.message}`));
      else p.resolve(msg);
    }
  };
  worker.onerror = (evt) => {
    const err = new AiUnavailableError("failed", `The on-device model could not start: ${evt.message || "worker error"}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    terminateWorker();
  };
  return worker;
}

export function terminateWorker(): void {
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(new DOMException("Cancelled", "AbortError"));
  pending.clear();
}

function call<T>(message: Record<string, unknown>, opts: { signal?: AbortSignal; onProgress?: (d: number, t: number) => void; label: string; transfer?: Transferable[]; terminateOnAbort?: boolean }): Promise<T> {
  if (typeof Worker === "undefined") return Promise.reject(new AiUnavailableError("unsupported", "This browser cannot run on-device models (no Web Workers)."));
  if (opts.signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  const id = nextId++;
  let notice: Notice | null = null;
  return new Promise<T>((resolve, reject) => {
    const done = () => {
      notice?.hide();
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      pending.delete(id);
      done();
      // The worker stops at its next checkpoint (between Whisper windows) and keeps the model loaded.
      if (opts.terminateOnAbort) worker?.postMessage({ id: nextId++, type: "cancel", target: id });
      reject(new DOMException("Cancelled", "AbortError"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      resolve: (v) => (done(), resolve(v)),
      reject: (e) => (done(), reject(e)),
      onProgress: opts.onProgress,
      onDownload: (loaded, total) => {
        if (loaded >= total) return notice?.hide();
        const text = `Downloading the ${opts.label}… ${Math.round((loaded / total) * 100)}% of ${formatBytes(total)}`;
        if (notice) notice.setMessage(text);
        else notice = new Notice(text, 0);
      },
    });
    getWorker().postMessage({ id, ...message }, opts.transfer ?? []);
  });
}

/** Decodes any audio or video the browser can play to 16 kHz mono, which Whisper expects. */
async function decodeAudio(blob: Blob): Promise<Float32Array> {
  const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctx) throw new AiUnavailableError("unsupported", "This browser cannot decode audio (no Web Audio).");
  const bytes = await blob.arrayBuffer();
  let decoded: AudioBuffer;
  try {
    decoded = await new Ctx(1, 1, 16000).decodeAudioData(bytes);
  } catch {
    throw new AiUnavailableError("unsupported", "This browser cannot decode this recording's audio format.");
  }
  const length = Math.ceil(decoded.duration * 16000);
  const ctx = new Ctx(1, Math.max(1, length), 16000);
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

export const transformersProvider: AiProvider = {
  id: "transformers",
  label: "On-device models (transformers.js)",
  description: "Embeddings for related notes and search by meaning, and Whisper transcription, running in this browser. The models download once from Hugging Face.",
  location: "device",
  leavesDevice: false,
  capabilities: ["embed", "transcribe"],
  enabledByDefault: true,
  fields: ["embedModel", "transcribeModel"],
  defaults: { embedModel: EMBED_MODEL, transcribeModel: WHISPER_MODEL },
  model: (cap, s) => (cap === "embed" ? s.embedModel || EMBED_MODEL : s.transcribeModel || WHISPER_MODEL),
  // e5 and most small sentence encoders read at most 512 tokens per text.
  contextWindow: (cap) => (cap === "embed" ? 512 : undefined),
  present: () => typeof Worker !== "undefined" && typeof WebAssembly !== "undefined",
  async pendingDownload(cap, s) {
    if (cap !== "embed" && cap !== "transcribe") return null;
    const p = await plan(cap, s);
    const known = KNOWN[`${p.model}|${p.dtype}`];
    const urls = await cachedUrls();
    const what = cap === "embed" ? `the embedding model ${p.model}` : `the speech model ${p.model}${p.device === "webgpu" ? " (for WebGPU)" : ""}`;
    if (!known) {
      const any = [...urls].some((u) => u.startsWith(`${HF}/${p.model}/resolve/`) && u.endsWith(".onnx"));
      return any ? null : { bytes: null, from: "Hugging Face (huggingface.co)", what };
    }
    const missing = Object.entries(known.files).filter(([f]) => !urls.has(`${HF}/${p.model}/resolve/main/${f}`));
    if (!missing.length) return null;
    const runtimeCached = [...urls].some((u) => /ort-wasm.*\.wasm/.test(u));
    const bytes = missing.reduce((n, [, b]) => n + b, 0) + known.extra + (runtimeCached ? 0 : RUNTIME_BYTES);
    return { bytes, from: "Hugging Face (huggingface.co)", what };
  },
  async status(ctx) {
    const parts: string[] = [];
    for (const cap of ["embed", "transcribe"] as const) {
      const p = await plan(cap, ctx.settings);
      const pendingDl = await transformersProvider.pendingDownload!(cap, ctx.settings);
      const label = cap === "embed" ? "Embeddings" : "Transcription";
      parts.push(`${label}: ${p.model} on ${p.device === "webgpu" ? "WebGPU" : "WebAssembly"}${pendingDl ? `, ${pendingDl.bytes ? formatBytes(pendingDl.bytes) + " " : ""}download on first use` : ", downloaded"}.`);
    }
    return { state: "ready", message: parts.join(" ") };
  },
  async embed(req: EmbedRequest, ctx) {
    const p = await plan("embed", ctx.settings);
    const e5 = /e5/i.test(p.model);
    const texts = e5 ? req.texts.map((t) => `${req.kind === "query" ? "query" : "passage"}: ${t}`) : req.texts;
    const res = await call<{ vectors: Float32Array[]; dims: number }>({ type: "embed", model: p.model, dtype: p.dtype, texts }, { signal: req.signal, onProgress: req.onProgress, label: "embedding model" });
    return { vectors: res.vectors, dims: res.dims, model: p.model };
  },
  async transcribe(req: TranscribeRequest, ctx) {
    const p = await plan("transcribe", ctx.settings);
    const audio = await decodeAudio(req.audio);
    if (req.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    // Whisper's own language detection runs in the worker when there is no hint (engines/whisper.ts).
    const res = await call<{ text: string; segments: TranscriptSegment[]; language?: string }>({ type: "transcribe", model: p.model, device: p.device, dtype: p.dtype, audio, language: req.language }, { signal: req.signal, onProgress: req.onProgress, label: "speech model", transfer: [audio.buffer], terminateOnAbort: true });
    return { text: res.text, segments: res.segments, language: res.language };
  },
};
