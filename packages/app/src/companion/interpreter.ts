/**
 * Web Clipper's Interpreter, run by the app when a clip arrives: the template's
 * prompt variables (`{{"a summary of the page"}}`, `{{prompt:"…"|filters}}`) are
 * sent with the page context to the engine the user routed "Web clipper" to in
 * Settings → AI, in one request, and filled in before the note is written.
 * `{{model}}`, `{{modelId}}` and `{{modelProvider}}` name the engine that
 * answered.
 *
 * Compatible with obsidian-clipper (MIT) `src/utils/interpreter.ts`: the same
 * system prompt, `prompts_responses` JSON with `prompt_1`… keys, filters applied
 * after the response, object answers pretty-printed as JSON. When AI is off,
 * declined or fails, prompt variables stay in the note as `{{"…"}}` so nothing
 * is lost and the clip still succeeds.
 *
 * Loaded on demand (only clips with prompt variables need it).
 */
import type { AiService, EngineInfo } from "../ai/types";
import { AiUnavailableError } from "../ai/types";
import { getEngine, isEngineReady } from "@vault/engine";
import { engineLabel } from "../core-plugins/transcribe/format";
import { generateFrontmatter, joinPath, sanitizeFileName } from "./clip-format";
import type { ClipInterpreterRequest, InterpreterOutcome } from "./protocol";

export interface PromptVariable {
  key: string;
  prompt: string;
}

/** `{{"…"|filters}}` / `{{prompt:"…"}}` as the engine leaves them (quotes inside escaped as `\"`). */
const PROMPT_RE = /\{\{(?:prompt:)?"((?:[^"\\]|\\[\s\S])*)"(\|[\s\S]*?)?\}\}/g;
const MODEL_RE = /\{\{(modelProvider|modelId|model)(\|[\s\S]*?)?\}\}/g;

const unescapePrompt = (s: string) => s.replace(/\\(["\\])/g, "$1");

export const SYSTEM_PROMPT =
  'You are a helpful assistant. Please respond with one JSON object named `prompts_responses` — no explanatory text before or after. Use the keys provided, e.g. `prompt_1`, `prompt_2`, and fill in the values. Values should be Markdown strings unless otherwise specified. Make your responses concise. For example, your response should look like: {"prompts_responses":{"prompt_1":"tag1, tag2, tag3","prompt_2":"- bullet1\\n- bullet 2\\n- bullet3"}}';

/** Distinct prompts in order of appearance, keyed `prompt_1`… (Web Clipper's `collectPromptVariables`). */
export function collectPrompts(texts: string[]): PromptVariable[] {
  const out: PromptVariable[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(PROMPT_RE)) {
      const prompt = unescapePrompt(m[1]!);
      if (!out.some((p) => p.prompt === prompt)) out.push({ key: `prompt_${out.length + 1}`, prompt });
    }
  }
  return out;
}

export function hasPromptVariables(req: ClipInterpreterRequest): boolean {
  return collectPrompts(texts(req)).length > 0;
}

function texts(req: ClipInterpreterRequest): string[] {
  return [req.body, ...req.properties.map((p) => p.value), req.noteName];
}

/** The model's answer → `prompt_n` → value. Tolerates text around the JSON and a bare object of keys. */
export function parseResponses(text: string): Record<string, unknown> {
  const attempt = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let parsed = attempt(text.trim());
  if (parsed === undefined) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fenced) parsed = attempt(fenced[1]!.trim());
  }
  if (parsed === undefined) {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) parsed = attempt(m[0]) ?? attempt(m[0].replace(/[“”]/g, '"').replace(/\r?\n/g, "\\n"));
  }
  if (!parsed || typeof parsed !== "object") throw new Error("The model's answer could not be read.");
  const obj = parsed as Record<string, unknown>;
  const inner = obj.prompts_responses;
  const responses = (inner && typeof inner === "object" ? inner : obj) as Record<string, unknown>;
  if (!Object.keys(responses).some((k) => /^prompt_\d+$/.test(k))) throw new Error("The model's answer did not contain any prompt responses.");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(responses)) out[k] = typeof v === "string" ? v.replace(/\\n/g, "\n").replace(/\r/g, "") : v;
  return out;
}

interface FilterEnv {
  url: string;
  nowMs: number;
  tzOffsetMinutes: number;
}

/** Filters run through the engine's template language, as in the extension. */
function applyFilters(value: string, filters: string | undefined, env: FilterEnv): string {
  if (!filters || !isEngineReady()) return value;
  const r = getEngine().renderTemplate(`{{interpreter_value${filters}}}`, { url: env.url, nowMs: env.nowMs, tzOffsetMinutes: env.tzOffsetMinutes, variables: { interpreter_value: value } });
  return r.errors.length && !r.output ? value : r.output;
}

/** Replace answered prompt variables; unanswered ones stay as they are. */
export function fillPrompts(text: string, prompts: PromptVariable[], responses: Record<string, unknown>, env: FilterEnv): string {
  return text.replace(PROMPT_RE, (whole, raw: string, filters: string | undefined) => {
    const variable = prompts.find((p) => p.prompt === unescapePrompt(raw));
    if (!variable || responses[variable.key] === undefined || responses[variable.key] === null) return whole;
    let value = responses[variable.key];
    if (typeof value === "object") value = JSON.stringify(value, null, 2);
    return applyFilters(String(value), filters, env);
  });
}

export function fillModelVariables(text: string, engine: EngineInfo, env: FilterEnv): string {
  const values: Record<string, string> = { model: engine.model, modelId: engine.model, modelProvider: PROVIDERS[engine.provider] ?? engine.provider };
  return text.replace(MODEL_RE, (_w, name: string, filters: string | undefined) => applyFilters(values[name] ?? "", filters, env));
}

const PROVIDERS: Record<string, string> = {
  "chrome-builtin": "Chrome built-in AI",
  transformers: "Transformers.js",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  "openai-compatible": "OpenAI-compatible",
};

/** Page context one request may carry, by where the engine runs (on-device models have small windows). */
export function contextBudget(engine: EngineInfo | null): number {
  if (!engine || engine.location === "device") return 12_000;
  if (engine.location === "local-server") return 48_000;
  return 400_000;
}

export interface InterpretedClip {
  content: string;
  /** Note path (without `.md`) when the note name held prompts; otherwise null (keep the extension's path). */
  path: string | null;
  outcome: InterpreterOutcome;
}

const AI_OFF = "AI is off for the web clipper, so prompt variables were left as {{\"…\"}}. Turn it on in Settings → AI.";

/**
 * Fill a clip's prompt variables. Never throws: failures come back as an
 * outcome message with the placeholders left in place.
 */
export async function interpretClip(ai: AiService | null | undefined, req: ClipInterpreterRequest, isDaily: boolean, onEngine?: (label: string) => void): Promise<InterpretedClip> {
  const env: FilterEnv = { url: req.url, nowMs: req.nowMs, tzOffsetMinutes: req.tzOffsetMinutes };
  const prompts = collectPrompts(texts(req));
  const assemble = (fill: (s: string) => string) => {
    const properties = req.properties.map((p) => {
      const value = fill(p.value);
      // A placeholder left in a number, checkbox or date property would be dropped by its formatting.
      PROMPT_RE.lastIndex = 0;
      const placeholder = PROMPT_RE.test(value);
      PROMPT_RE.lastIndex = 0;
      return { ...p, value, type: placeholder && p.type !== "multitext" ? "text" : p.type };
    });
    const types = { ...req.propertyTypes, ...Object.fromEntries(properties.map((p) => [p.name, p.type])) };
    const fm = req.frontmatter ? generateFrontmatter(properties, types) : "";
    const body = fill(req.body);
    const nameHadPrompts = collectPrompts([req.noteName]).length > 0 || MODEL_RE.test(req.noteName);
    MODEL_RE.lastIndex = 0;
    return { content: fm + body, path: !isDaily && nameHadPrompts ? joinPath(req.folder, sanitizeFileName(fill(req.noteName))) : null };
  };
  const unfilled = (message: string, engine?: string): InterpretedClip => ({ ...assemble((s) => s), outcome: { prompts: prompts.length, filled: 0, engine, message } });

  if (!prompts.length) {
    const engine = ai?.engineFor("clipper", "generate");
    return { ...assemble((s) => (engine ? fillModelVariables(s, engine, env) : s)), outcome: { prompts: 0, filled: 0 } };
  }
  if (!ai || !ai.isAvailable("clipper", "generate")) return unfilled(AI_OFF);
  const expected = ai.engineFor("clipper", "generate");
  const label = engineLabel(expected);
  if (label) onEngine?.(label);
  try {
    if (!(await ai.ensureConsent("clipper", "generate"))) return unfilled("Prompt variables were left as {{\"…\"}}: the AI request was not allowed.", label);
    const budget = contextBudget(expected);
    const context = req.context.length > budget ? req.context.slice(0, budget) : req.context;
    const promptContent = { prompts: Object.fromEntries(prompts.map((p) => [p.key, p.prompt])) };
    const r = await ai.generate({
      feature: "clipper",
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: context },
        { role: "user", content: JSON.stringify(promptContent) },
      ],
      json: true,
      temperature: 0.2,
    });
    const responses = parseResponses(r.text);
    const filled = prompts.filter((p) => responses[p.key] !== undefined && responses[p.key] !== null).length;
    const fill = (s: string) => fillModelVariables(fillPrompts(s, prompts, responses, env), r.engine, env);
    return {
      ...assemble(fill),
      outcome: {
        prompts: prompts.length,
        filled,
        engine: engineLabel(r.engine),
        message: filled < prompts.length ? `${prompts.length - filled} of ${prompts.length} prompt variables got no answer and were left as {{"…"}}.` : undefined,
      },
    };
  } catch (e) {
    const why = e instanceof AiUnavailableError ? e.message : `The AI request failed: ${(e as Error)?.message ?? e}`;
    return unfilled(`Prompt variables were left as {{"…"}}. ${why}`, label);
  }
}
