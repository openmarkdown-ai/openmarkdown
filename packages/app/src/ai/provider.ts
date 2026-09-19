/**
 * What an engine implements to be routed to by `app.ai` (see index.ts), and
 * the HTTP helpers the server and cloud engines share: streaming Server-Sent
 * Events, and turning HTTP and network failures into `AiUnavailableError`s a
 * user can act on.
 */
import { AiUnavailableError, type AiFeature, type EmbedRequest, type EngineLocation, type GenerateRequest, type GenerateResult, type TranscribeRequest, type TranscriptSegment } from "./types";

export type Capability = "generate" | "embed" | "transcribe" | "vision";

/** Per-provider settings, kept with the AI config (never the key: that is in the keychain). */
export interface ProviderSettings {
  enabled: boolean;
  baseUrl?: string;
  model?: string;
  embedModel?: string;
  transcribeModel?: string;
}

export type ProviderState = "ready" | "needs-key" | "needs-setup" | "needs-download" | "not-running" | "blocked" | "unavailable" | "off" | "unknown";

export interface ProviderStatus {
  state: ProviderState;
  /** One sentence for the user. */
  message: string;
  /** Model ids the server offers, when it lists them. */
  models?: string[];
}

export interface ProviderContext {
  app: any;
  feature: AiFeature;
  settings: ProviderSettings;
  /** The API key from the keychain, or null. */
  key(): Promise<string | null>;
  /** Asks (once per feature and engine) before a download the provider manages itself, e.g. Chrome's built-in models. */
  askDownload(opts: { what: string; size?: string; from: string }): Promise<boolean>;
}

export interface AiProvider {
  /** "chrome-builtin", "transformers", "ollama", "lmstudio", "anthropic", "openai", "gemini", "openai-compatible", or a test stub's id. */
  id: string;
  label: string;
  description?: string;
  location: EngineLocation | ((s: ProviderSettings) => EngineLocation);
  /** Defaults to `location === "cloud"`. */
  leavesDevice?: boolean | ((s: ProviderSettings) => boolean);
  capabilities: Capability[] | ((s: ProviderSettings) => Capability[]);
  needsKey?: boolean;
  /** Where to get a key. */
  keyUrl?: string;
  /** Turned on when AI is first turned on. */
  enabledByDefault?: boolean;
  defaults?: Partial<ProviderSettings>;
  /** Fields the settings show: base URL, model names. */
  fields?: ("baseUrl" | "model" | "embedModel" | "transcribeModel")[];
  /** The model a capability runs on. */
  model?(cap: Capability, s: ProviderSettings): string;
  /** Input tokens the model accepts, when known (`EngineInfo.contextWindow`). */
  contextWindow?(cap: Capability, s: ProviderSettings): number | undefined;
  /** Set up enough to be routed to (a base URL, a model, a key). Defaults to true (plus a key when `needsKey`). */
  configured?(s: ProviderSettings, hasKey: boolean): boolean;
  /** Can this browser run it at all (synchronous; e.g. Chrome's APIs exist). Defaults to true. */
  present?(cap: Capability): boolean;
  /** Bytes to download before the first use of `cap`, or null when nothing needs downloading now. */
  pendingDownload?(cap: Capability, s: ProviderSettings): Promise<{ bytes: number | null; from: string; what: string } | null>;
  status?(ctx: Omit<ProviderContext, "feature" | "askDownload">): Promise<ProviderStatus>;
  generate?(req: GenerateRequest, ctx: ProviderContext): Promise<{ text: string; data?: GenerateResult["data"] }>;
  embed?(req: EmbedRequest, ctx: ProviderContext): Promise<{ vectors: Float32Array[]; dims?: number; model?: string }>;
  transcribe?(req: TranscribeRequest, ctx: ProviderContext): Promise<{ text: string; segments: TranscriptSegment[]; language?: string }>;
  /** For task hints: whether this engine can do `kind` right now (Chrome: the matching API or the Prompt API exists). Defaults to true. */
  canTask?(kind: string): boolean;
}

// ---- HTTP -----------------------------------------------------------------------------------

export function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "AbortError";
}

/** Reads a provider's error body for its own message ("Incorrect API key provided …"). */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      const m = j?.error?.message ?? j?.error ?? j?.message;
      if (typeof m === "string") return m.slice(0, 300);
    } catch {
      /* not JSON */
    }
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * `fetch` with errors a user can act on. `name` is how the user knows the
 * service ("Anthropic", "Ollama"); `hint` explains a network failure (CORS,
 * the server not running).
 */
export async function aiFetch(url: string, init: RequestInit, name: string, hint?: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new AiUnavailableError("offline", `You are offline, so ${name} cannot be reached.`);
    throw new AiUnavailableError("offline", hint ?? `Could not reach ${name}. Check your connection.`);
  }
  if (res.ok) return res;
  const detail = await errorDetail(res);
  const suffix = detail ? ` (${detail})` : "";
  if (res.status === 401 || res.status === 403) throw new AiUnavailableError("auth", `${name} did not accept the API key. Check it in Settings → AI.${suffix}`);
  if (res.status === 429) throw new AiUnavailableError("quota", `${name} says you are over your rate limit or quota. Try again later.${suffix}`);
  if (res.status === 404) throw new AiUnavailableError("failed", `${name} does not know this model or address. Check the model name in Settings → AI.${suffix}`);
  if (res.status >= 500) throw new AiUnavailableError("failed", `${name} had a server error (HTTP ${res.status}). Try again later.${suffix}`);
  throw new AiUnavailableError("failed", `${name} answered HTTP ${res.status}.${suffix}`);
}

/** Yields each `data:` payload of a Server-Sent Events response. */
export async function* sseData(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    for (const line of text.split("\n")) if (line.startsWith("data:")) yield line.slice(5).trim();
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    if (buffer.startsWith("data:")) yield buffer.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

export function signalTimeout(ms: number, parent?: AbortSignal): AbortSignal {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  parent?.addEventListener("abort", () => c.abort(), { once: true });
  c.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  return c.signal;
}

/** Base64 of a Blob, for image inputs. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
