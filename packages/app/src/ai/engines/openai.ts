/**
 * Engines that speak OpenAI's HTTP API: OpenAI itself, any OpenAI-compatible
 * server, and the two local servers people run (Ollama, LM Studio), which
 * offer the same `/v1/chat/completions` and `/v1/embeddings` endpoints.
 *
 * Browser access: api.openai.com answers CORS preflights. Ollama allows
 * `localhost` and `127.0.0.1` origins by default; any other origin (this app
 * on its own domain) must be added with `OLLAMA_ORIGINS`. LM Studio has a
 * "CORS" switch in its server settings.
 */
import { aiFetch, blobToBase64, isLocalUrl, signalTimeout, sseData, trimSlash, type AiProvider, type ProviderSettings, type ProviderStatus } from "../provider";
import { AiUnavailableError, type EmbedRequest, type GenerateRequest } from "../types";

/** Models that read images, by name: servers do not say, so only these are offered for image features. */
const VISION_MODEL = /llava|vision|[-_.]vl\b|vl[:-]|gemma-?3|qwen2\.5-?vl|qwen3-?vl|minicpm-v|moondream|pixtral|mistral-small-?3\.[12]|llama-?4|gpt-4o|gpt-4\.1|gpt-5|claude|gemini/i;

function capsFor(model: string | undefined): ("generate" | "embed" | "vision")[] {
  return model && VISION_MODEL.test(model) ? ["generate", "embed", "vision"] : ["generate", "embed"];
}

interface OpenAiStyle {
  name: string;
  baseUrl(s: ProviderSettings): string;
  /** Explains a network failure. */
  unreachable(s: ProviderSettings): string;
  /** Resolves an empty model setting (local servers: the first model they have). */
  pickModel?(s: ProviderSettings, kind: "chat" | "embed", key: string | null, signal?: AbortSignal): Promise<string>;
}

function headers(key: string | null): Record<string, string> {
  return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

async function toOpenAiMessages(req: GenerateRequest) {
  const out: unknown[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    if (!m.images?.length) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const parts: unknown[] = [{ type: "text", text: m.content }];
    for (const img of m.images) parts.push({ type: "image_url", image_url: { url: `data:${img.type || "image/png"};base64,${await blobToBase64(img)}` } });
    out.push({ role: m.role, content: parts });
  }
  return out;
}

async function chat(style: OpenAiStyle, s: ProviderSettings, key: string | null, req: GenerateRequest): Promise<string> {
  const model = s.model?.trim() || (await style.pickModel?.(s, "chat", key, req.signal)) || "";
  if (!model) throw new AiUnavailableError("no-engine", `Choose a model for ${style.name} in Settings → AI.`);
  const body: Record<string, unknown> = { model, messages: await toOpenAiMessages(req), stream: true };
  if (req.maxTokens) body[style.name === "OpenAI" ? "max_completion_tokens" : "max_tokens"] = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.json) body.response_format = { type: "json_object" };
  const res = await aiFetch(`${style.baseUrl(s)}/chat/completions`, { method: "POST", headers: headers(key), body: JSON.stringify(body), signal: req.signal }, style.name, style.unreachable(s));
  let text = "";
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("event-stream")) {
    // A server that ignored `stream: true`.
    const data = await res.json();
    text = String(data?.choices?.[0]?.message?.content ?? "");
    if (text) req.onToken?.(text);
    return text;
  }
  for await (const data of sseData(res, req.signal)) {
    if (data === "[DONE]") break;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk?.error) throw new AiUnavailableError("failed", `${style.name}: ${chunk.error.message ?? chunk.error}`);
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      text += delta;
      req.onToken?.(delta);
    }
  }
  return text;
}

async function embed(style: OpenAiStyle, s: ProviderSettings, key: string | null, req: EmbedRequest, fallbackModel: string) {
  const model = s.embedModel?.trim() || (await style.pickModel?.(s, "embed", key, req.signal)) || fallbackModel;
  if (!model) throw new AiUnavailableError("no-engine", `Choose an embedding model for ${style.name} in Settings → AI.`);
  const vectors: Float32Array[] = [];
  const BATCH = 64;
  for (let i = 0; i < req.texts.length; i += BATCH) {
    const input = req.texts.slice(i, i + BATCH);
    const res = await aiFetch(`${style.baseUrl(s)}/embeddings`, { method: "POST", headers: headers(key), body: JSON.stringify({ model, input }), signal: req.signal }, style.name, style.unreachable(s));
    const data = await res.json();
    const rows = (data?.data ?? []) as { index?: number; embedding: number[] }[];
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== input.length) throw new AiUnavailableError("failed", `${style.name} returned ${rows.length} embeddings for ${input.length} texts.`);
    for (const r of rows) vectors.push(Float32Array.from(r.embedding));
    req.onProgress?.(Math.min(i + BATCH, req.texts.length), req.texts.length);
  }
  return { vectors, dims: vectors[0]?.length ?? 0, model };
}

async function listModels(style: OpenAiStyle, s: ProviderSettings, key: string | null, signal?: AbortSignal): Promise<string[]> {
  const res = await aiFetch(`${style.baseUrl(s)}/models`, { headers: headers(key), signal: signalTimeout(8000, signal) }, style.name, style.unreachable(s));
  const data = await res.json();
  return ((data?.data ?? []) as { id: string }[]).map((m) => m.id).filter(Boolean);
}

/** Tells "not running" from "running but CORS blocks this page": a no-cors request succeeds when the server is up. */
async function probe(url: string): Promise<"up" | "down"> {
  try {
    await fetch(url, { mode: "no-cors", signal: signalTimeout(4000) });
    return "up";
  } catch {
    return "down";
  }
}

function localStatus(name: string, corsHelp: string) {
  return async (style: OpenAiStyle, s: ProviderSettings, key: string | null): Promise<ProviderStatus> => {
    try {
      const models = await listModels(style, s, key);
      if (!models.length) return { state: "needs-setup", message: `${name} is running but has no models. Download one in ${name} first.`, models };
      return { state: "ready", message: `${name} is running with ${models.length} model${models.length === 1 ? "" : "s"}.`, models };
    } catch (e) {
      if (e instanceof AiUnavailableError && e.reason === "offline") {
        const up = await probe(style.baseUrl(s));
        return up === "up" ? { state: "blocked", message: corsHelp } : { state: "not-running", message: `${name} is not running at ${style.baseUrl(s)}.` };
      }
      return { state: "unavailable", message: (e as Error).message };
    }
  };
}

function remoteStatus(style: OpenAiStyle) {
  return async (s: ProviderSettings, key: string | null): Promise<ProviderStatus> => {
    try {
      const models = await listModels(style, s, key);
      return { state: "ready", message: `Connected to ${style.name}.`, models };
    } catch (e) {
      return { state: (e as AiUnavailableError).reason === "auth" ? "needs-key" : "unavailable", message: (e as Error).message };
    }
  };
}

// ---- OpenAI -----------------------------------------------------------------------------------

const openaiStyle: OpenAiStyle = {
  name: "OpenAI",
  baseUrl: () => "https://api.openai.com/v1",
  unreachable: () => "Could not reach OpenAI. Check your connection.",
};

export const openaiProvider: AiProvider = {
  id: "openai",
  label: "OpenAI",
  description: "GPT models with your own API key. Text you use with a feature routed here is sent to OpenAI.",
  location: "cloud",
  capabilities: ["generate", "embed", "vision"],
  contextWindow: (cap) => (cap === "embed" ? 8191 : 272_000),
  needsKey: true,
  keyUrl: "https://platform.openai.com/api-keys",
  defaults: { model: "gpt-5.6-luna", embedModel: "text-embedding-3-small" },
  fields: ["model", "embedModel"],
  model: (cap, s) => (cap === "embed" ? s.embedModel || "text-embedding-3-small" : s.model || "gpt-5.6-luna"),
  async status(ctx) {
    const key = await ctx.key();
    if (!key) return { state: "needs-key", message: "Add your OpenAI API key." };
    return remoteStatus(openaiStyle)(ctx.settings, key);
  },
  async generate(req, ctx) {
    const s = { ...ctx.settings, model: ctx.settings.model || "gpt-5.6-luna" };
    return { text: await chat(openaiStyle, s, await ctx.key(), req) };
  },
  embed: async (req, ctx) => embed(openaiStyle, ctx.settings, await ctx.key(), req, "text-embedding-3-small"),
};

// ---- OpenAI-compatible --------------------------------------------------------------------------

const compatStyle: OpenAiStyle = {
  name: "your AI server",
  baseUrl: (s) => trimSlash(s.baseUrl ?? ""),
  unreachable: (s) => `Could not reach ${trimSlash(s.baseUrl ?? "")}. Check that the server is running and allows requests from this site (CORS).`,
};

export const compatProvider: AiProvider = {
  id: "openai-compatible",
  label: "OpenAI-compatible server",
  description: "Any server with OpenAI's API: vLLM, llama.cpp, LocalAI, Groq, OpenRouter, a server on your network…",
  location: (s) => (isLocalUrl(s.baseUrl ?? "") ? "local-server" : "cloud"),
  leavesDevice: (s) => !isLocalUrl(s.baseUrl ?? ""),
  capabilities: (s) => capsFor(s.model),
  fields: ["baseUrl", "model", "embedModel"],
  defaults: { baseUrl: "" },
  model: (cap, s) => (cap === "embed" ? s.embedModel || "" : s.model || ""),
  configured: (s) => /^https?:\/\//i.test(s.baseUrl ?? "") && !!s.model?.trim(),
  async status(ctx) {
    if (!/^https?:\/\//i.test(ctx.settings.baseUrl ?? "")) return { state: "needs-setup", message: "Enter a base URL starting with http:// or https://, such as http://localhost:8080/v1." };
    const key = await ctx.key();
    const st = await remoteStatus(compatStyle)(ctx.settings, key);
    if (st.state === "ready" && !ctx.settings.model) return { ...st, state: "needs-setup", message: "Connected. Enter the model name to use." };
    return st;
  },
  generate: async (req, ctx) => ({ text: await chat(compatStyle, ctx.settings, await ctx.key(), req) }),
  embed: async (req, ctx) => embed(compatStyle, ctx.settings, await ctx.key(), req, ""),
};

// ---- Ollama ----------------------------------------------------------------------------------

export const OLLAMA_CORS_HELP =
  "Ollama is running but blocks requests from this site. Quit Ollama, then start it with this site allowed, e.g. OLLAMA_ORIGINS=\"" +
  (typeof location !== "undefined" ? location.origin : "https://your-site") +
  "\" ollama serve (on macOS: launchctl setenv OLLAMA_ORIGINS \"…\" and restart the Ollama app).";

async function ollamaTags(s: ProviderSettings, signal?: AbortSignal): Promise<{ name: string; embedding: boolean }[]> {
  const base = trimSlash(s.baseUrl || "http://localhost:11434").replace(/\/v1$/, "");
  const res = await aiFetch(`${base}/api/tags`, { signal: signalTimeout(8000, signal) }, "Ollama", ollamaStyle.unreachable(s));
  const data = await res.json();
  return ((data?.models ?? []) as { name: string; details?: { family?: string; families?: string[] } }[]).map((m) => ({
    name: m.name,
    embedding: /embed|bge|e5|minilm|nomic-bert/i.test(`${m.name} ${m.details?.family ?? ""} ${(m.details?.families ?? []).join(" ")}`),
  }));
}

const ollamaStyle: OpenAiStyle = {
  name: "Ollama",
  baseUrl: (s) => `${trimSlash(s.baseUrl || "http://localhost:11434").replace(/\/v1$/, "")}/v1`,
  unreachable: (s) => `Could not reach Ollama at ${trimSlash(s.baseUrl || "http://localhost:11434")}. Start Ollama; if it is running, it may be blocking this site (see Settings → AI).`,
  async pickModel(s, kind, _key, signal) {
    const tags = await ollamaTags(s, signal);
    const pick = tags.find((t) => (kind === "embed" ? t.embedding : !t.embedding));
    if (!pick) throw new AiUnavailableError("no-engine", kind === "embed" ? "Ollama has no embedding model. Run: ollama pull embeddinggemma" : "Ollama has no chat model. Run, for example: ollama pull gemma3");
    return pick.name;
  },
};

export const ollamaProvider: AiProvider = {
  id: "ollama",
  label: "Ollama",
  description: "Models running in Ollama on this computer. Nothing leaves the device.",
  location: "local-server",
  leavesDevice: (s) => !isLocalUrl(s.baseUrl || "http://localhost:11434"),
  capabilities: (s) => capsFor(s.model),
  // Ollama's default context (num_ctx) unless the model or server is configured otherwise.
  contextWindow: (cap) => (cap === "embed" ? undefined : 4096),
  fields: ["baseUrl", "model", "embedModel"],
  defaults: { baseUrl: "http://localhost:11434" },
  model: (cap, s) => (cap === "embed" ? s.embedModel || "(first embedding model)" : s.model || "(first model)"),
  async status(ctx) {
    const st = await localStatus("Ollama", OLLAMA_CORS_HELP)(ollamaStyle, ctx.settings, null);
    return st;
  },
  generate: async (req, ctx) => ({ text: await chat(ollamaStyle, ctx.settings, null, req) }),
  embed: async (req, ctx) => embed(ollamaStyle, ctx.settings, null, req, ""),
};

// ---- LM Studio ---------------------------------------------------------------------------------

const LMSTUDIO_CORS_HELP = "LM Studio is running but blocks requests from this site. In LM Studio's Developer tab, open server settings and turn on “Enable CORS”.";

const lmstudioStyle: OpenAiStyle = {
  name: "LM Studio",
  baseUrl: (s) => `${trimSlash(s.baseUrl || "http://localhost:1234").replace(/\/v1$/, "")}/v1`,
  unreachable: (s) => `Could not reach LM Studio at ${trimSlash(s.baseUrl || "http://localhost:1234")}. Start its server (Developer tab); if it is running, turn on CORS.`,
  async pickModel(s, kind, key, signal) {
    const models = await listModels(lmstudioStyle, s, key, signal);
    const pick = models.find((m) => (kind === "embed" ? /embed/i.test(m) : !/embed/i.test(m)));
    if (!pick) throw new AiUnavailableError("no-engine", kind === "embed" ? "LM Studio has no embedding model loaded." : "LM Studio has no chat model loaded.");
    return pick;
  },
};

export const lmstudioProvider: AiProvider = {
  id: "lmstudio",
  label: "LM Studio",
  description: "Models served by LM Studio on this computer. Nothing leaves the device.",
  location: "local-server",
  leavesDevice: (s) => !isLocalUrl(s.baseUrl || "http://localhost:1234"),
  capabilities: (s) => capsFor(s.model),
  // LM Studio loads models with a 4,096-token context by default.
  contextWindow: (cap) => (cap === "embed" ? undefined : 4096),
  fields: ["baseUrl", "model", "embedModel"],
  defaults: { baseUrl: "http://localhost:1234" },
  model: (cap, s) => (cap === "embed" ? s.embedModel || "(first embedding model)" : s.model || "(first loaded model)"),
  status: async (ctx) => localStatus("LM Studio", LMSTUDIO_CORS_HELP)(lmstudioStyle, ctx.settings, null),
  generate: async (req, ctx) => ({ text: await chat(lmstudioStyle, ctx.settings, null, req) }),
  embed: async (req, ctx) => embed(lmstudioStyle, ctx.settings, null, req, ""),
};
