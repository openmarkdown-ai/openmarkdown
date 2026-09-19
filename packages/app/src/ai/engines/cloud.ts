/**
 * Anthropic and Google Gemini, called straight from the browser with the
 * user's own key.
 *
 * Anthropic: the Messages API accepts browser requests when the
 * `anthropic-dangerous-direct-browser-access: true` header is sent (the key is
 * the user's own, kept in this browser). Default model `claude-opus-5`; thinking
 * is adaptive by default on it, and these are short note tasks, so requests ask
 * for low effort. Anthropic has no embeddings endpoint.
 *
 * Gemini: `models/{model}:streamGenerateContent?alt=sse` and
 * `:batchEmbedContents` with the `x-goog-api-key` header; both answer CORS.
 */
import { aiFetch, blobToBase64, signalTimeout, sseData, type AiProvider, type ProviderStatus } from "../provider";
import { AiUnavailableError, type GenerateRequest } from "../types";

// ---- Anthropic -------------------------------------------------------------------------------

const ANTHROPIC_MODEL = "claude-opus-5";

function anthropicHeaders(key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

async function anthropicMessages(req: GenerateRequest) {
  const out: unknown[] = [];
  for (const m of req.messages) {
    if (!m.images?.length) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const parts: unknown[] = [];
    for (const img of m.images) parts.push({ type: "image", source: { type: "base64", media_type: img.type || "image/png", data: await blobToBase64(img) } });
    parts.push({ type: "text", text: m.content });
    out.push({ role: m.role, content: parts });
  }
  return out;
}

export const anthropicProvider: AiProvider = {
  id: "anthropic",
  label: "Anthropic",
  description: "Claude models with your own API key. Text you use with a feature routed here is sent to Anthropic.",
  location: "cloud",
  capabilities: ["generate", "vision"],
  needsKey: true,
  keyUrl: "https://console.anthropic.com/settings/keys",
  defaults: { model: ANTHROPIC_MODEL },
  fields: ["model"],
  model: (_cap, s) => s.model || ANTHROPIC_MODEL,
  // Current Claude models (Opus 5, Sonnet 5, Fable 5.x, Opus 4.6+) take 1M tokens; Haiku 4.5 200K.
  contextWindow: (_cap, s) => (/haiku/.test(s.model ?? "") ? 200_000 : /^claude-(opus-5|sonnet-5|fable-5|opus-4-[678]|sonnet-4-6)|^$/.test(s.model ?? "") ? 1_000_000 : 200_000),
  async status(ctx): Promise<ProviderStatus> {
    const key = await ctx.key();
    if (!key) return { state: "needs-key", message: "Add your Anthropic API key." };
    try {
      const res = await aiFetch("https://api.anthropic.com/v1/models?limit=100", { headers: anthropicHeaders(key), signal: signalTimeout(8000) }, "Anthropic");
      const data = await res.json();
      return { state: "ready", message: "Connected to Anthropic.", models: ((data?.data ?? []) as { id: string }[]).map((m) => m.id) };
    } catch (e) {
      return { state: (e as AiUnavailableError).reason === "auth" ? "needs-key" : "unavailable", message: (e as Error).message };
    }
  },
  async generate(req, ctx) {
    const key = await ctx.key();
    if (!key) throw new AiUnavailableError("auth", "Add your Anthropic API key in Settings → AI.");
    const model = ctx.settings.model?.trim() || ANTHROPIC_MODEL;
    const system = req.json ? `${req.system ?? ""}\n\nAnswer with a single JSON object and nothing else.`.trim() : req.system;
    const body: Record<string, unknown> = { model, max_tokens: req.maxTokens ?? 16000, messages: await anthropicMessages(req), stream: true };
    if (system) body.system = system;
    // Sampling parameters are rejected by current Claude models; effort is the control that remains.
    if (/^claude-(opus-5|fable-5|sonnet-5|opus-4-[678])/.test(model)) body.output_config = { effort: "low" };
    const headers = anthropicHeaders(key);
    // On a policy decline the API re-runs the request on a fallback model it picks, inside the same call.
    if (/^claude-(opus-5|fable-5-1)$/.test(model)) {
      body.fallbacks = "default";
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    }
    const res = await aiFetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body), signal: req.signal }, "Anthropic");
    let text = "";
    for await (const data of sseData(res, req.signal)) {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        text += ev.delta.text;
        req.onToken?.(ev.delta.text);
      } else if (ev.type === "message_delta" && ev.delta?.stop_reason === "refusal") {
        throw new AiUnavailableError("failed", "Claude declined this request.");
      } else if (ev.type === "error") {
        const type = ev.error?.type;
        throw new AiUnavailableError(type === "overloaded_error" || type === "rate_limit_error" ? "quota" : "failed", `Anthropic: ${ev.error?.message ?? "the request failed"}.`);
      }
    }
    return { text };
  },
};

// ---- Google Gemini ------------------------------------------------------------------------------

const GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_EMBED = "gemini-embedding-001";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const geminiProvider: AiProvider = {
  id: "gemini",
  label: "Google Gemini",
  description: "Gemini models with your own API key from Google AI Studio. Text you use with a feature routed here is sent to Google.",
  location: "cloud",
  capabilities: ["generate", "embed", "vision"],
  needsKey: true,
  keyUrl: "https://aistudio.google.com/app/apikey",
  defaults: { model: GEMINI_MODEL, embedModel: GEMINI_EMBED },
  fields: ["model", "embedModel"],
  model: (cap, s) => (cap === "embed" ? s.embedModel || GEMINI_EMBED : s.model || GEMINI_MODEL),
  contextWindow: (cap) => (cap === "embed" ? 2048 : 1_048_576),
  async status(ctx) {
    const key = await ctx.key();
    if (!key) return { state: "needs-key", message: "Add your Gemini API key." };
    try {
      const res = await aiFetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal: signalTimeout(8000) }, "Google Gemini");
      const data = await res.json();
      return { state: "ready", message: "Connected to Google Gemini.", models: ((data?.models ?? []) as { name: string }[]).map((m) => m.name.replace(/^models\//, "")) };
    } catch (e) {
      // Gemini answers a bad key with 400 API_KEY_INVALID.
      const msg = (e as Error).message;
      return { state: /API_KEY|API key/i.test(msg) || (e as AiUnavailableError).reason === "auth" ? "needs-key" : "unavailable", message: msg };
    }
  },
  async generate(req, ctx) {
    const key = await ctx.key();
    if (!key) throw new AiUnavailableError("auth", "Add your Gemini API key in Settings → AI.");
    const model = ctx.settings.model?.trim() || GEMINI_MODEL;
    const contents: unknown[] = [];
    for (const m of req.messages) {
      const parts: unknown[] = [];
      for (const img of m.images ?? []) parts.push({ inlineData: { mimeType: img.type || "image/png", data: await blobToBase64(img) } });
      parts.push({ text: m.content });
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
    }
    const generationConfig: Record<string, unknown> = {};
    if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.json) generationConfig.responseMimeType = "application/json";
    const body: Record<string, unknown> = { contents, generationConfig };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const res = await aiFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body), signal: req.signal }, "Google Gemini");
    let text = "";
    for await (const data of sseData(res, req.signal)) {
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk?.error) throw new AiUnavailableError("failed", `Google Gemini: ${chunk.error.message}`);
      const cand = chunk?.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        if (typeof part.text === "string" && !part.thought) {
          text += part.text;
          req.onToken?.(part.text);
        }
      }
      if (cand?.finishReason === "SAFETY" || chunk?.promptFeedback?.blockReason) throw new AiUnavailableError("failed", "Google Gemini blocked this request.");
    }
    return { text };
  },
  async embed(req, ctx) {
    const key = await ctx.key();
    if (!key) throw new AiUnavailableError("auth", "Add your Gemini API key in Settings → AI.");
    const model = ctx.settings.embedModel?.trim() || GEMINI_EMBED;
    const supportsTaskType = /embedding-001|text-embedding-004/.test(model);
    const vectors: Float32Array[] = [];
    const BATCH = 100;
    for (let i = 0; i < req.texts.length; i += BATCH) {
      const batch = req.texts.slice(i, i + BATCH);
      const requests = batch.map((t) => ({
        model: `models/${model}`,
        content: { parts: [{ text: supportsTaskType ? t : `${req.kind === "query" ? "task: search result | query" : "title: none | text"}: ${t}` }] },
        ...(supportsTaskType ? { taskType: req.kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" } : {}),
        outputDimensionality: 768,
      }));
      const res = await aiFetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:batchEmbedContents`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify({ requests }), signal: req.signal }, "Google Gemini");
      const data = await res.json();
      for (const e of (data?.embeddings ?? []) as { values: number[] }[]) {
        // Truncated (768-d) Gemini embeddings are not normalised; normalise so cosine = dot product.
        const v = Float32Array.from(e.values);
        let n = 0;
        for (const x of v) n += x * x;
        n = Math.sqrt(n) || 1;
        for (let k = 0; k < v.length; k++) v[k] = v[k]! / n;
        vectors.push(v);
      }
      req.onProgress?.(Math.min(i + BATCH, req.texts.length), req.texts.length);
    }
    return { vectors, dims: vectors[0]?.length ?? 0, model };
  },
};
