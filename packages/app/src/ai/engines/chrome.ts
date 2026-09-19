/**
 * Chrome's built-in AI APIs as an `app.ai` engine, feature-detected, with
 * consent (through `app.ai`) before the browser downloads a model.
 *
 * Status on 2026-09-14 (docs/research/web-platform-and-robustness.md A.4):
 * Summarizer, Translator and LanguageDetector are stable since Chrome 138;
 * the Prompt API (`LanguageModel`) since 148; Writer, Rewriter and
 * Proofreader are still trials, so they are used only when present, and the
 * Prompt API stands in for them otherwise.
 */
import { Notice } from "../../obsidian/ui/notice";
import type { AiProvider, Capability, ProviderContext, ProviderStatus } from "../provider";
import { AiUnavailableError, type AiTaskHint, type GenerateRequest } from "../types";
import { formatBytes, isAbort, ProgressModal } from "../ui";

export type ApiName = "Summarizer" | "Translator" | "LanguageDetector" | "LanguageModel" | "Writer" | "Rewriter" | "Proofreader";
export type Availability = "available" | "downloadable" | "downloading" | "unavailable" | "missing";

export const API_LABELS: Record<ApiName, string> = {
  Summarizer: "Summarizer",
  Translator: "Translator",
  LanguageDetector: "Language detector",
  LanguageModel: "Prompt API",
  Writer: "Writer",
  Rewriter: "Rewriter",
  Proofreader: "Proofreader",
};

export function api(name: ApiName): any {
  return (globalThis as Record<string, unknown>)[name] ?? null;
}

export function hasApi(name: ApiName): boolean {
  const a = api(name);
  return !!a && typeof a.create === "function";
}

export async function availability(name: ApiName, opts?: Record<string, unknown>): Promise<Availability> {
  const a = api(name);
  if (!a || typeof a.create !== "function") return "missing";
  if (typeof a.availability !== "function") return "available";
  try {
    // Some builds never settle availability() for unsupported configurations; do not hang the UI on it.
    const answer = await Promise.race([a.availability(opts ?? {}), new Promise((r) => setTimeout(() => r("unavailable"), 10_000))]);
    const v = String(answer);
    // Early builds answered "readily" / "after-download" / "no".
    if (v === "readily") return "available";
    if (v === "after-download") return "downloadable";
    if (v === "no") return "unavailable";
    return v as Availability;
  } catch {
    return "unavailable";
  }
}

/**
 * Creates an API object (summarizer, translator, session …). When the model
 * must be downloaded first, asks through `app.ai` and shows the progress.
 * Throws an AbortError when the user declines or cancels.
 */
export async function createWithConsent(app: any, name: ApiName, opts: Record<string, unknown>, askDownload: ProviderContext["askDownload"]): Promise<any> {
  const a = api(name);
  if (!a) throw new AiUnavailableError("unsupported", `${API_LABELS[name]} is not available in this browser.`);
  const state = await availability(name, opts);
  if (state === "unavailable") throw new AiUnavailableError("unsupported", `${API_LABELS[name]} cannot run here${name === "Translator" ? " for this language pair" : ""}: the browser reports the model as unavailable (it needs a desktop with enough disk space, memory and GPU).`);
  if (state === "available") return a.create(opts);
  const ok = await askDownload({ what: `the browser's built-in ${API_LABELS[name]} model`, size: "it can be several gigabytes", from: "the browser vendor" });
  if (!ok) throw new DOMException("Cancelled", "AbortError");
  const modal = new ProgressModal(app, `Downloading the ${API_LABELS[name]} model`);
  modal.open();
  modal.setProgress(null, "Starting download…");
  try {
    const created = await a.create({
      ...opts,
      signal: modal.signal,
      monitor(m: EventTarget) {
        m.addEventListener("downloadprogress", (e: Event) => {
          const { loaded, total } = e as unknown as { loaded: number; total?: number };
          // The spec reports `loaded` as a 0..1 fraction; early builds sent bytes with `total`.
          const fraction = total && total > 1 ? loaded / total : loaded;
          modal.setProgress(fraction, fraction >= 1 ? "Preparing the model…" : `Downloading… ${Math.round(fraction * 100)}%`, total && total > 1 ? `${formatBytes(loaded)} of ${formatBytes(total)}` : "");
        });
      },
    });
    modal.finish("Ready.");
    modal.close();
    return created;
  } catch (e) {
    modal.done = true;
    modal.close();
    throw e;
  }
}

/** Reads a streaming API result; chunks are deltas in current Chrome, cumulative in early builds. Calls `onDelta` with new text only. */
export async function readStream(stream: ReadableStream<string> | AsyncIterable<string>, onDelta?: (s: string) => void, signal?: AbortSignal): Promise<string> {
  let out = "";
  const reader = (stream as ReadableStream<string>).getReader?.();
  const next = reader
    ? () => reader.read()
    : (() => {
        const it = (stream as AsyncIterable<string>)[Symbol.asyncIterator]();
        return () => it.next();
      })();
  for (;;) {
    if (signal?.aborted) {
      await reader?.cancel().catch(() => {});
      throw new DOMException("Cancelled", "AbortError");
    }
    const { done, value } = await next();
    if (done) break;
    const chunk = String(value);
    const cumulative = chunk.startsWith(out) && out.length > 0;
    const delta = cumulative ? chunk.slice(out.length) : chunk;
    out = cumulative ? chunk : out + chunk;
    if (delta) onDelta?.(delta);
  }
  return out;
}

/** Paragraphs are translated one by one; code blocks, math blocks and blank runs are kept. */
export function splitForTranslation(text: string): { text: string; translate: boolean }[] {
  const out: { text: string; translate: boolean }[] = [];
  const re = /(^|\n)( {0,3}(```+|~~~+)[^\n]*\n[\s\S]*?\n {0,3}\3[ \t]*(?=\n|$)|\$\$[\s\S]*?\$\$)|\n{2,}/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    const start = m[2] ? m.index + m[1]!.length : m.index;
    if (start > last) out.push({ text: text.slice(last, start), translate: /[\p{L}]/u.test(text.slice(last, start)) });
    out.push({ text: text.slice(start, m.index + m[0].length), translate: false });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), translate: /[\p{L}]/u.test(text.slice(last)) });
  return out;
}

const TASK_API: Record<AiTaskHint["kind"], ApiName> = {
  summarize: "Summarizer",
  translate: "Translator",
  "detect-language": "LanguageDetector",
  rewrite: "Rewriter",
  proofread: "Proofreader",
  write: "Writer",
};

function lastUserText(req: GenerateRequest): string {
  const last = req.messages[req.messages.length - 1];
  return last?.content ?? "";
}

async function withObject<T>(obj: any, fn: (o: any) => Promise<T>): Promise<T> {
  try {
    return await fn(obj);
  } finally {
    obj?.destroy?.();
  }
}

/** Runs a task on its dedicated API. Returns null when the API is missing (the Prompt API then stands in). */
async function runTask(req: GenerateRequest, ctx: ProviderContext): Promise<{ text: string; data?: { language?: string; confidence?: number } } | null> {
  const task = req.task!;
  const name = TASK_API[task.kind];
  if (!hasApi(name)) return null;
  const app = ctx.app;
  const signal = req.signal;
  const onToken = req.onToken;
  const text = lastUserText(req);
  const create = (opts: Record<string, unknown>) => createWithConsent(app, name, opts, ctx.askDownload);
  switch (task.kind) {
    case "summarize": {
      // Chrome's Summarizer writes English, Spanish or Japanese; use the UI language when it is one of them.
      const ui = (navigator.language || "en").split("-")[0]!;
      const opts = { type: task.type, length: task.length, format: "markdown", sharedContext: "A note from a personal Markdown knowledge base.", outputLanguage: ["en", "es", "ja"].includes(ui) ? ui : "en" };
      return withObject(await create(opts), async (s) => {
        if (typeof s.summarizeStreaming === "function") return { text: await readStream(s.summarizeStreaming(text, { signal }), onToken, signal) };
        const out = String(await s.summarize(text, { signal }));
        onToken?.(out);
        return { text: out };
      });
    }
    case "detect-language": {
      return withObject(await create({}), async (d) => {
        const results = (await d.detect(text.slice(0, 4000))) as { detectedLanguage: string; confidence: number }[];
        const best = results.find((r) => r.detectedLanguage !== "und") ?? results[0];
        if (!best) return { text: "" };
        return { text: best.detectedLanguage, data: { language: best.detectedLanguage, confidence: best.confidence } };
      });
    }
    case "translate": {
      let from = task.source;
      if (!from) {
        if (hasApi("LanguageDetector")) {
          const detected = await runTask({ ...req, task: { kind: "detect-language" }, onToken: undefined }, ctx);
          from = detected?.data?.language;
        }
        if (!from) return null;
      }
      if (from.split("-")[0] === task.target.split("-")[0]) {
        new Notice("The text is already in that language.");
        onToken?.(text);
        return { text };
      }
      return withObject(await create({ sourceLanguage: from, targetLanguage: task.target }), async (t) => {
        let out = "";
        for (const part of splitForTranslation(text)) {
          if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
          const piece = part.translate ? String(await t.translate(part.text, { signal })) : part.text;
          out += piece;
          onToken?.(piece);
        }
        return { text: out };
      });
    }
    case "rewrite": {
      const mode = task.mode;
      const opts = { tone: mode.startsWith("more-") ? mode : "as-is", length: mode === "shorter" || mode === "longer" ? mode : "as-is", format: "as-is" };
      return withObject(await create(opts), async (r) => {
        if (typeof r.rewriteStreaming === "function") return { text: await readStream(r.rewriteStreaming(text, { signal }), onToken, signal) };
        const out = String(await r.rewrite(text, { signal }));
        onToken?.(out);
        return { text: out };
      });
    }
    case "proofread": {
      return withObject(await create({ expectedInputLanguages: ["en"] }), async (p) => {
        const result = await p.proofread(text, { signal });
        const out = typeof result === "string" ? result : String(result?.correctedInput ?? result?.corrected ?? text);
        onToken?.(out);
        return { text: out };
      });
    }
    case "write": {
      return withObject(await create({ tone: "neutral", format: "markdown", length: "medium", sharedContext: "Writing in a personal Markdown note." }), async (w) => {
        const opts = { context: task.context.slice(0, 4000), signal };
        if (typeof w.writeStreaming === "function") return { text: await readStream(w.writeStreaming(task.request, opts), onToken, signal) };
        const out = String(await w.write(task.request, opts));
        onToken?.(out);
        return { text: out };
      });
    }
  }
}

export const chromeProvider: AiProvider = {
  id: "chrome-builtin",
  label: "Built-in AI in this browser",
  description: "Chrome's on-device models (Gemini Nano): summarize, translate, detect language, and the Prompt API. Needs Chrome on a desktop with enough memory and disk.",
  location: "device",
  leavesDevice: false,
  capabilities: ["generate"],
  enabledByDefault: true,
  model: () => "gemini-nano",
  // A session's `inputQuota` is about 6,000 tokens on current Chrome builds; it is only readable from a live session.
  contextWindow: () => 6000,
  present: () => (Object.keys(API_LABELS) as ApiName[]).some(hasApi),
  canTask: (kind) => hasApi("LanguageModel") || (kind in TASK_API && hasApi(TASK_API[kind as AiTaskHint["kind"]])),
  async pendingDownload(cap: Capability) {
    if (cap !== "generate" || !hasApi("LanguageModel")) return null;
    const state = await availability("LanguageModel", { expectedInputs: [{ type: "text" }], expectedOutputs: [{ type: "text" }] });
    return state === "downloadable" ? { bytes: null, from: "the browser vendor", what: "the browser's built-in language model" } : null;
  },
  async status(): Promise<ProviderStatus> {
    const states = await Promise.all((Object.keys(API_LABELS) as ApiName[]).map(async (n) => [n, await availability(n, n === "Translator" ? { sourceLanguage: "en", targetLanguage: "es" } : undefined)] as const));
    const ready = states.filter(([, s]) => s === "available").map(([n]) => API_LABELS[n]);
    const downloadable = states.filter(([, s]) => s === "downloadable" || s === "downloading").map(([n]) => API_LABELS[n]);
    if (!ready.length && !downloadable.length) {
      const present = states.some(([, s]) => s !== "missing");
      return present ? { state: "unavailable", message: "This browser has built-in AI but cannot run its models on this device." } : { state: "unavailable", message: "Not in this browser (needs Chrome on a capable desktop)." };
    }
    const parts: string[] = [];
    if (ready.length) parts.push(`Ready: ${ready.join(", ")}.`);
    if (downloadable.length) parts.push(`One-time download first: ${downloadable.join(", ")}.`);
    return { state: ready.length ? "ready" : "needs-download", message: parts.join(" ") };
  },
  async generate(req, ctx) {
    if (req.messages.some((m) => m.images?.length)) throw new AiUnavailableError("unsupported", "The browser's built-in AI cannot read images here. Pick another engine for this feature in Settings → AI.");
    if (req.task) {
      const done = await runTask(req, ctx);
      if (done) return done;
    }
    if (!hasApi("LanguageModel")) throw new AiUnavailableError("unsupported", "This browser has no built-in Prompt API (Chrome 148 or newer on a capable desktop). Pick another engine in Settings → AI.");
    const history = req.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
    const initialPrompts = [...(req.system ? [{ role: "system", content: req.system }] : []), ...history];
    const session = await createWithConsent(ctx.app, "LanguageModel", { initialPrompts, expectedInputs: [{ type: "text" }], expectedOutputs: [{ type: "text" }] }, ctx.askDownload);
    return withObject(session, async (s) => {
      const text = lastUserText(req);
      const opts: Record<string, unknown> = { signal: req.signal };
      if (req.json) opts.responseConstraint = { type: "object" };
      try {
        if (typeof s.promptStreaming === "function") return { text: await readStream(s.promptStreaming(text, opts), req.onToken, req.signal) };
        const out = String(await s.prompt(text, opts));
        req.onToken?.(out);
        return { text: out };
      } catch (e) {
        if (isAbort(e)) throw e;
        const name = (e as { name?: string }).name;
        if (name === "QuotaExceededError") throw new AiUnavailableError("quota", "The text is too long for the browser's built-in model. Try a shorter selection.");
        throw e;
      }
    });
  },
};
