/**
 * transformers.js in a Web Worker: sentence embeddings and Whisper
 * transcription, off the main thread.
 *
 * Loaded only after the user agreed to the download (engines/transformers.ts).
 * Weights come from the Hugging Face CDN and transformers.js keeps them in
 * Cache Storage (`transformers-cache`), so they download once. The ONNX
 * Runtime WebAssembly files are served from this app's own origin rather than
 * transformers.js's default (a jsDelivr URL): the only third party contacted is
 * the one the consent dialog names.
 *
 * Protocol: { id, type: "embed", model, dtype, texts } → { id, type: "result", vectors, dims }
 *           { id, type: "transcribe", model, device, dtype, audio (16 kHz mono), language? } → { id, type: "result", text, segments, language }
 *           progress: { id, type: "download", loaded, total } and { id, type: "progress", done, total }
 *           failure: { id, type: "error", message }
 */
// The asyncify build is what transformers.js picks for WebGPU and WASM alike.
import ortWasmUrl from "../../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "../../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url";

type Lib = typeof import("@huggingface/transformers");

let libPromise: Promise<Lib> | null = null;
function lib(): Promise<Lib> {
  libPromise ??= import("@huggingface/transformers").then((m) => {
    m.env.allowLocalModels = false;
    m.env.allowRemoteModels = true;
    m.env.useBrowserCache = true;
    const wasm = m.env.backends?.onnx?.wasm as { wasmPaths?: unknown } | undefined;
    if (wasm) wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href, mjs: new URL(ortMjsUrl, self.location.href).href };
    return m;
  });
  return libPromise;
}

const pipelines = new Map<string, Promise<any>>();

function pipelineFor(task: "feature-extraction" | "automatic-speech-recognition", model: string, device: string, dtype: string, id: number) {
  const key = `${task}|${model}|${device}|${dtype}`;
  let p = pipelines.get(key);
  if (!p) {
    const files = new Map<string, { loaded: number; total: number }>();
    p = lib().then((m) =>
      m.pipeline(task, model, {
        device: device as "wasm" | "webgpu",
        dtype: dtype as "q8",
        // Sum bytes over files: they download concurrently and report separately.
        progress_callback: (ev: { status?: string; file?: string; loaded?: number; total?: number }) => {
          if (ev.status !== "progress" || !ev.file || typeof ev.loaded !== "number" || typeof ev.total !== "number") return;
          files.set(ev.file, { loaded: ev.loaded, total: ev.total });
          let loaded = 0;
          let total = 0;
          for (const f of files.values()) {
            loaded += f.loaded;
            total += f.total;
          }
          (self as unknown as Worker).postMessage({ id, type: "download", loaded, total });
        },
      } as Record<string, unknown>),
    );
    p.catch(() => pipelines.delete(key));
    pipelines.set(key, p);
  }
  return p;
}

self.onmessage = async (evt: MessageEvent) => {
  const msg = evt.data as { id: number; type: string; [k: string]: any };
  const post = (data: Record<string, unknown>, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ id: msg.id, ...data }, transfer);
  try {
    if (msg.type === "embed") {
      const pipe = await pipelineFor("feature-extraction", msg.model, "wasm", msg.dtype, msg.id);
      const texts = msg.texts as string[];
      const vectors: Float32Array[] = [];
      let dims = 0;
      const BATCH = 16;
      for (let i = 0; i < texts.length; i += BATCH) {
        const out = await pipe(texts.slice(i, i + BATCH), { pooling: "mean", normalize: true });
        dims = out.dims[out.dims.length - 1];
        const data = out.data as Float32Array;
        for (let r = 0; r < data.length / dims; r++) vectors.push(data.slice(r * dims, (r + 1) * dims));
        post({ type: "progress", done: Math.min(i + BATCH, texts.length), total: texts.length });
      }
      post({ type: "result", vectors, dims }, vectors.map((v) => v.buffer));
    } else if (msg.type === "transcribe") {
      const pipe = await pipelineFor("automatic-speech-recognition", msg.model, msg.device, msg.dtype, msg.id);
      const signal = { get aborted() {
        return cancelled.has(msg.id);
      } };
      const { transcribeWhisper } = await import("./whisper");
      const result = await transcribeWhisper(pipe, msg.audio as Float32Array, {
        language: msg.language,
        englishOnly: /\.en$/.test(msg.model),
        signal,
        onProgress: (f) => post({ type: "progress", done: Math.round(f * 1000), total: 1000 }),
      });
      post({ type: "result", ...result });
    } else if (msg.type === "cancel") {
      cancelled.add(msg.target);
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") post({ type: "error", message: "Cancelled", aborted: true });
    else post({ type: "error", message: (e as Error)?.message ?? String(e) });
  } finally {
    cancelled.delete(msg.id);
  }
};

const cancelled = new Set<number>();
