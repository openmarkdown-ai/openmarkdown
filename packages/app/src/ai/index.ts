/**
 * `app.ai`: the AI service every AI feature uses (contract in ./types.ts,
 * plan in docs/PLAN-ai.md).
 *
 * ── Test hook: stub providers for e2e ───────────────────────────────────────────────
 *
 * Tests never need the network or a GPU. Register a stub engine and route
 * features to it, either before the app starts (init script) or at runtime.
 *
 *   // 1. Before boot — read once when `app.ai` is installed:
 *   await page.addInitScript(() => {
 *     (window as any).__openmarkdownAiTest = {
 *       providers: [{
 *         id: "stub", label: "Stub", location: "device",        // or "cloud" to exercise the "sent to" consent
 *         capabilities: ["generate", "embed", "transcribe"],
 *         async generate(req) { req.onToken?.("Hello "); req.onToken?.("world"); return { text: "Hello world" }; },
 *         async embed(req) { return { vectors: req.texts.map(() => new Float32Array([1, 0, 0])), dims: 3 }; },
 *         async transcribe(req) { return { text: "hi", segments: [{ start: 0, end: 1, text: "hi" }] }; },
 *       }],
 *       // Turns AI on, turns every feature on, and routes every feature and capability to "stub"
 *       // (pass a partial AiConfig as `config` instead for finer control):
 *       route: "stub",
 *       consent: "grant",   // "grant" | "deny" | undefined (undefined shows the real consent dialog)
 *     };
 *   });
 *
 *   // 2. At runtime, after `window.app` exists:
 *   await page.evaluate(() => {
 *     const ai = (window as any).app.ai;
 *     ai.registerProvider({ id: "stub", label: "Stub", location: "device", capabilities: ["generate"], generate: async () => ({ text: "ok" }) });
 *     ai.testing.routeAll("stub");        // enable AI + all features, route everything to "stub"
 *     ai.testing.consent = "grant";       // or "deny", or null for the real dialog
 *   });
 *
 * A stub is an `AiProvider` (./provider.ts); only id, label, location, capabilities
 * and the methods you use are needed. `model` defaults to "<id>-model". A stub with
 * `pendingDownload: async () => ({ bytes: 5e6, from: "Test", what: "a test model" })`
 * exercises the download consent. `ai.testing.reset()` clears config, consents and stubs.
 *
 * ── Where things are kept ───────────────────────────────────────────────────────────
 *
 * The AI config (on/off, per-feature switches and routing, provider base URLs and
 * model names, consents) is per vault *and* per browser (localStorage, prefixed by
 * the vault id), not in `.obsidian/`: turning AI on or agreeing to send text to a
 * provider on one device must not do so on another. API keys are in ./keys.ts.
 */
import { Events } from "../obsidian/events";
import { askConsent } from "./consent";
import { chromeProvider } from "./engines/chrome";
import { anthropicProvider, geminiProvider } from "./engines/cloud";
import { compatProvider, lmstudioProvider, ollamaProvider, openaiProvider } from "./engines/openai";
import { transformersProvider } from "./engines/transformers";
import { AiKeychain } from "./keys";
import { isAbort, type AiProvider, type Capability, type ProviderContext, type ProviderSettings, type ProviderStatus } from "./provider";
import { AiUnavailableError, type AiFeature, type AiService, type EmbedRequest, type EmbedResult, type EngineInfo, type GenerateRequest, type GenerateResult, type TranscribeRequest, type TranscribeResult } from "./types";
import { formatBytes } from "./ui";

export type { AiProvider, Capability, ProviderSettings, ProviderStatus } from "./provider";
export * from "./types";

export type RoutedCapability = "generate" | "embed" | "transcribe";

export const FEATURES: { id: AiFeature; name: string; desc: string; needs: RoutedCapability[] }[] = [
  { id: "tools", name: "Writing tools", desc: "Summarize, translate, rewrite, proofread and write.", needs: ["generate"] },
  { id: "chat", name: "Chat", desc: "Ask about this note, and chat with the vault.", needs: ["generate"] },
  { id: "related", name: "Related notes and search by meaning", desc: "An index of what notes are about.", needs: ["embed"] },
  { id: "suggest", name: "Suggestions", desc: "Links, tags, properties, titles and image alt text to accept or dismiss.", needs: ["generate", "embed"] },
  { id: "transcribe", name: "Transcription", desc: "Recordings and videos to text.", needs: ["transcribe"] },
  { id: "clipper", name: "Web clipper prompts", desc: "Prompt variables in clipper templates.", needs: ["generate"] },
  { id: "query", name: "Plain-language queries", desc: "Describe a Bases filter or a Dataview/Tasks query in words.", needs: ["generate"] },
  { id: "review", name: "Periodic reviews", desc: "Summaries of a week's or month's daily notes.", needs: ["generate"] },
];

export const BUILTIN_PROVIDERS: AiProvider[] = [chromeProvider, transformersProvider, ollamaProvider, lmstudioProvider, compatProvider, anthropicProvider, openaiProvider, geminiProvider];

/** Automatic routing tries these in order: this device first, then local servers, then the cloud providers the user set up. */
const AUTO_ORDER: Record<RoutedCapability, string[]> = {
  generate: ["chrome-builtin", "ollama", "lmstudio", "openai-compatible", "anthropic", "openai", "gemini"],
  embed: ["transformers", "ollama", "lmstudio", "openai-compatible", "openai", "gemini"],
  transcribe: ["transformers"],
};

export interface AiConfig {
  v: 1;
  enabled: boolean;
  features: Partial<Record<AiFeature, boolean>>;
  /** Provider id per feature and capability; missing or "auto" routes automatically. */
  routes: Partial<Record<AiFeature, Partial<Record<RoutedCapability, string>>>>;
  providers: Record<string, Partial<ProviderSettings>>;
  /** Provider ids with a key in the keychain (never the key). */
  keys: Record<string, boolean>;
  /** Consent keys the user agreed to. */
  consents: Record<string, number>;
  migrated: Record<string, boolean>;
}

const CONFIG_KEY = "ai-config";

function defaultConfig(): AiConfig {
  return { v: 1, enabled: false, features: {}, routes: {}, providers: {}, keys: {}, consents: {}, migrated: {} };
}

const PROVIDER_NAMES: Record<string, string> = {
  "chrome-builtin": "the browser's built-in AI",
  transformers: "transformers.js",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  "openai-compatible": "your AI server",
};

/** Labels of engines registered at runtime (plugins, test stubs). */
const EXTRA_LABELS = new Map<string, string>();

/** "On this device", "Ollama on this computer", "Sent to Anthropic". */
export function describeEngine(engine: EngineInfo | null): string {
  if (!engine) return "No AI engine";
  const name = PROVIDER_NAMES[engine.provider] ?? EXTRA_LABELS.get(engine.provider) ?? engine.provider;
  if (engine.location === "device") return "On this device";
  if (engine.location === "local-server" && !engine.leavesDevice) return `${name[0]!.toUpperCase()}${name.slice(1)} on this computer`;
  return `Sent to ${name}`;
}

/** The same label under the name other features use (`engineLabel(info)`). */
export const engineLabel = describeEngine;

function capOf(cap: Capability): RoutedCapability {
  return cap === "vision" ? "generate" : cap;
}

function valueOf<T>(v: T | ((s: ProviderSettings) => T), s: ProviderSettings): T {
  return typeof v === "function" ? (v as (s: ProviderSettings) => T)(s) : v;
}

function mergeDeep(target: any, patch: any) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) mergeDeep((target[k] ??= {}), v);
    else target[k] = v;
  }
  return target;
}

export class AiServiceImpl extends Events implements AiService {
  private providers = new Map<string, AiProvider>();
  private stubIds = new Set<string>();
  config: AiConfig;
  readonly keychain: AiKeychain;
  /** Test hook, see the top of this file. */
  readonly testing: { consent: "grant" | "deny" | null; routeAll: (id: string) => void; reset: () => void };

  constructor(readonly app: any) {
    super();
    this.keychain = new AiKeychain(String(app?.appId ?? "default"));
    this.config = mergeDeep(defaultConfig(), app?.loadLocalStorage?.(CONFIG_KEY) ?? {});
    for (const p of BUILTIN_PROVIDERS) this.providers.set(p.id, p);
    this.testing = {
      consent: null,
      routeAll: (id) => {
        const c = this.config;
        c.enabled = true;
        for (const f of FEATURES) {
          c.features[f.id] = true;
          c.routes[f.id] = { generate: id, embed: id, transcribe: id };
        }
        (c.providers[id] ??= {}).enabled = true;
        this.save();
      },
      reset: () => {
        this.config = defaultConfig();
        for (const id of this.stubIds) this.providers.delete(id);
        this.stubIds.clear();
        this.testing.consent = null;
        this.save();
      },
    };
  }

  // ---- config ---------------------------------------------------------------------------

  save(): void {
    this.app?.saveLocalStorage?.(CONFIG_KEY, this.config);
    this.trigger("change");
  }

  /** Merges a partial config and saves. */
  configure(patch: Partial<AiConfig> | Record<string, unknown>): void {
    mergeDeep(this.config, patch);
    this.save();
  }

  /** Adds an engine (a test stub, or a plugin's). Returns a function that removes it. */
  registerProvider(provider: AiProvider): () => void {
    this.providers.set(provider.id, provider);
    if (!BUILTIN_PROVIDERS.some((p) => p.id === provider.id)) {
      this.stubIds.add(provider.id);
      if (provider.label) EXTRA_LABELS.set(provider.id, provider.label);
    }
    this.trigger("change");
    return () => {
      if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id);
      this.stubIds.delete(provider.id);
      this.trigger("change");
    };
  }

  listProviders(): AiProvider[] {
    return [...this.providers.values()];
  }

  getProvider(id: string): AiProvider | null {
    return this.providers.get(id) ?? null;
  }

  settingsOf(id: string): ProviderSettings {
    const p = this.providers.get(id);
    const stored = this.config.providers[id] ?? {};
    const out: ProviderSettings = { enabled: stored.enabled ?? (!!p?.enabledByDefault || this.stubIds.has(id)) };
    for (const k of ["baseUrl", "model", "embedModel", "transcribeModel"] as const) {
      const v = stored[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  }

  setProviderSettings(id: string, patch: Partial<ProviderSettings>): void {
    Object.assign((this.config.providers[id] ??= {}), patch);
    this.save();
  }

  async setKey(id: string, key: string | null): Promise<void> {
    if (key && key.trim()) {
      await this.keychain.set(id, key.trim());
      this.config.keys[id] = true;
    } else {
      await this.keychain.remove(id);
      delete this.config.keys[id];
    }
    this.forgetConsents(id);
    this.save();
  }

  hasKey(id: string): boolean {
    return !!this.config.keys[id];
  }

  isFeatureOn(feature: AiFeature): boolean {
    return this.config.enabled && !!this.config.features[feature];
  }

  forgetConsents(providerId: string): void {
    for (const k of Object.keys(this.config.consents)) if (k.split("|")[2] === providerId) delete this.config.consents[k];
  }

  // ---- routing ---------------------------------------------------------------------------

  private supports(p: AiProvider, cap: Capability): boolean {
    const s = this.settingsOf(p.id);
    return valueOf(p.capabilities, s).includes(cap) && (p.present?.(cap) ?? true);
  }

  /** Enabled, set up, present in this browser, and able to do `cap`. */
  usable(p: AiProvider, cap: Capability, taskKind?: string): boolean {
    const s = this.settingsOf(p.id);
    if (!s.enabled || !this.supports(p, cap)) return false;
    const hasKey = this.hasKey(p.id);
    const configured = p.configured ? p.configured(s, hasKey) : !p.needsKey || hasKey;
    if (!configured || (p.needsKey && !hasKey)) return false;
    if (taskKind && p.canTask && !p.canTask(taskKind)) return false;
    return true;
  }

  routeOf(feature: AiFeature, cap: RoutedCapability): string {
    return this.config.routes[feature]?.[cap] || "auto";
  }

  /** The provider a request would use now (ignores the on/off switches). */
  resolve(feature: AiFeature, cap: Capability, taskKind?: string): AiProvider | null {
    const route = this.routeOf(feature, capOf(cap));
    if (route !== "auto") {
      const p = this.providers.get(route);
      return p && this.usable(p, cap, taskKind) ? p : null;
    }
    const order = [...AUTO_ORDER[capOf(cap)], ...this.stubIds];
    for (const id of order) {
      const p = this.providers.get(id);
      if (p && this.usable(p, cap, taskKind)) return p;
    }
    return null;
  }

  engineOf(p: AiProvider, cap: Capability): EngineInfo {
    const s = this.settingsOf(p.id);
    const location = valueOf(p.location, s);
    const leaves = p.leavesDevice === undefined ? location === "cloud" : valueOf(p.leavesDevice, s);
    const info: EngineInfo = { provider: p.id, model: p.model ? p.model(cap, s) : `${p.id}-model`, location, leavesDevice: leaves };
    const window = p.contextWindow?.(cap, s);
    if (window) info.contextWindow = window;
    return info;
  }

  isAvailable(feature: AiFeature, capability: Capability = "generate"): boolean {
    return this.isFeatureOn(feature) && !!this.resolve(feature, capability);
  }

  /** Like isAvailable, for a task hint: Chrome can summarize without the Prompt API, but not rewrite. */
  canDoTask(feature: AiFeature, taskKind: string): boolean {
    return this.isFeatureOn(feature) && !!this.resolve(feature, "generate", taskKind);
  }

  engineFor(feature: AiFeature, capability: Capability = "generate"): EngineInfo | null {
    if (!this.isFeatureOn(feature)) return null;
    const p = this.resolve(feature, capability);
    return p ? this.engineOf(p, capability) : null;
  }

  describe(engine: EngineInfo | null): string {
    return describeEngine(engine);
  }

  // ---- consent ---------------------------------------------------------------------------

  private consentKey(feature: AiFeature, cap: Capability, p: AiProvider, extra = ""): string {
    const s = this.settingsOf(p.id);
    return [feature, capOf(cap), p.id, p.model ? p.model(cap, s) : "", s.baseUrl ?? "", extra].join("|");
  }

  private async decide(key: string, ask: Parameters<typeof askConsent>[1]): Promise<boolean> {
    if (this.config.consents[key]) return true;
    const test = this.testing.consent;
    const ok = test === "grant" ? true : test === "deny" ? false : await askConsent(this.app, ask);
    if (ok) {
      this.config.consents[key] = Date.now();
      this.save();
    }
    return ok;
  }

  private featureName(feature: AiFeature): string {
    return FEATURES.find((f) => f.id === feature)?.name ?? feature;
  }

  async ensureConsent(feature: AiFeature, capability: Capability = "generate", taskKind?: string): Promise<boolean> {
    if (!this.isFeatureOn(feature)) return false;
    const p = this.resolve(feature, capability, taskKind);
    if (!p) return false;
    return this.consentFor(feature, capability, p);
  }

  private async consentFor(feature: AiFeature, capability: Capability, p: AiProvider): Promise<boolean> {
    const engine = this.engineOf(p, capability);
    const key = this.consentKey(feature, capability, p);
    if (this.config.consents[key]) return true;
    if (engine.leavesDevice) {
      const s = this.settingsOf(p.id);
      let host: string | undefined;
      try {
        host = s.baseUrl ? new URL(s.baseUrl).host : undefined;
      } catch {
        /* keep the provider name */
      }
      return this.decide(key, { kind: "cloud", feature: this.featureName(feature), provider: p.id === "openai-compatible" ? host ?? "your AI server" : p.label, model: engine.model, host });
    }
    const dl = await p.pendingDownload?.(capability, this.settingsOf(p.id)).catch(() => null);
    if (!dl) return true;
    return this.decide(key, { kind: "download", feature: this.featureName(feature), what: dl.what, size: dl.bytes ? formatBytes(dl.bytes) : null, from: dl.from });
  }

  // ---- requests ---------------------------------------------------------------------------

  private async prepare(feature: AiFeature, cap: Capability, taskKind?: string): Promise<{ p: AiProvider; engine: EngineInfo; ctx: ProviderContext }> {
    if (!this.config.enabled) throw new AiUnavailableError("disabled", "AI is turned off. Turn it on in Settings → AI.");
    if (!this.config.features[feature]) throw new AiUnavailableError("disabled", `${this.featureName(feature)} is turned off in Settings → AI.`);
    const p = this.resolve(feature, cap, taskKind);
    if (!p) {
      const route = this.routeOf(feature, capOf(cap));
      const chosen = route !== "auto" ? this.providers.get(route) : null;
      if (chosen && !this.supports(chosen, cap)) throw new AiUnavailableError("unsupported", `${chosen.label} cannot do this (${cap === "vision" ? "read images" : cap}). Pick another engine for ${this.featureName(feature)} in Settings → AI.`);
      if (chosen && chosen.needsKey && !this.hasKey(chosen.id)) throw new AiUnavailableError("auth", `Add your ${chosen.label} API key in Settings → AI.`);
      if (chosen) throw new AiUnavailableError("no-engine", `${chosen.label} is not set up. Finish setting it up in Settings → AI, or pick another engine.`);
      const what = cap === "embed" ? "embeddings" : cap === "transcribe" ? "transcription" : cap === "vision" ? "reading images" : "writing text";
      throw new AiUnavailableError("no-engine", `No AI engine for ${what} is available here. Set one up in Settings → AI.`);
    }
    const engine = this.engineOf(p, cap);
    if (engine.leavesDevice && typeof navigator !== "undefined" && navigator.onLine === false) throw new AiUnavailableError("offline", `You are offline, so ${p.label} cannot be reached.`);
    if (!(await this.consentFor(feature, cap, p))) throw new AiUnavailableError("consent-declined", engine.leavesDevice ? `Nothing was sent to ${p.label}.` : "The model was not downloaded.");
    const settings = this.settingsOf(p.id);
    const ctx: ProviderContext = {
      app: this.app,
      feature,
      settings,
      key: () => (p.needsKey || this.hasKey(p.id) ? this.keychain.get(p.id) : Promise.resolve(null)),
      askDownload: (o) => this.decide(this.consentKey(feature, cap, p, o.what), { kind: "download", feature: this.featureName(feature), what: o.what, size: o.size ?? null, from: o.from }),
    };
    return { p, engine, ctx };
  }

  private wrap(e: unknown, p: AiProvider): never {
    if (isAbort(e) || e instanceof AiUnavailableError) throw e;
    const msg = (e as Error)?.message || String(e);
    throw new AiUnavailableError("failed", `${p.label}: ${msg}`);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const cap: Capability = req.messages.some((m) => m.images?.length) ? "vision" : "generate";
    const { p, engine, ctx } = await this.prepare(req.feature, cap, req.task?.kind);
    if (!p.generate) throw new AiUnavailableError("unsupported", `${p.label} cannot write text.`);
    try {
      const out = await p.generate(req, ctx);
      if (req.json && parseJson(out.text) === undefined) {
        const retry = await p.generate({ ...req, onToken: undefined, messages: [...req.messages, { role: "assistant", content: out.text }, { role: "user", content: "That was not valid JSON. Reply again with only the JSON." }] }, ctx);
        if (parseJson(retry.text) === undefined) throw new AiUnavailableError("failed", `${p.label} did not answer in the expected format. Try again.`);
        return { text: retry.text, engine, data: retry.data };
      }
      return { text: out.text, engine, data: out.data };
    } catch (e) {
      this.wrap(e, p);
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    const feature = req.feature ?? "related";
    const { p, engine, ctx } = await this.prepare(feature, "embed");
    if (!p.embed) throw new AiUnavailableError("unsupported", `${p.label} cannot make embeddings.`);
    try {
      const out = await p.embed(req, ctx);
      const dims = out.dims ?? out.vectors[0]?.length ?? 0;
      // One form everywhere (types.ts): the bare model id, the same string in `model` and `engine.model`.
      const model = out.model ?? engine.model;
      return { vectors: out.vectors, dims, model, engine: { ...engine, model } };
    } catch (e) {
      this.wrap(e, p);
    }
  }

  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    const { p, engine, ctx } = await this.prepare("transcribe", "transcribe");
    if (!p.transcribe) throw new AiUnavailableError("unsupported", `${p.label} cannot transcribe.`);
    try {
      const out = await p.transcribe(req, ctx);
      return { ...out, engine };
    } catch (e) {
      this.wrap(e, p);
    }
  }

  /** Status for Settings → AI ("Test connection"). */
  async status(id: string): Promise<ProviderStatus> {
    const p = this.providers.get(id);
    if (!p) return { state: "unknown", message: "Unknown engine." };
    const settings = this.settingsOf(id);
    if (!p.status) return { state: "ready", message: "Ready." };
    try {
      return await p.status({ app: this.app, settings, key: () => this.keychain.get(id) });
    } catch (e) {
      return { state: "unavailable", message: (e as Error).message };
    }
  }
}

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

declare module "../obsidian/app" {
  interface App {
    ai: AiServiceImpl;
  }
}

/** Creates `app.ai`. Called once at boot (settings/index.ts), before core plugins load. */
export function installAi(app: any): AiServiceImpl {
  if (app.ai instanceof AiServiceImpl) return app.ai;
  const ai = new AiServiceImpl(app);
  app.ai = ai;
  const hook = (globalThis as { __openmarkdownAiTest?: { providers?: AiProvider[]; config?: Partial<AiConfig>; route?: string; consent?: "grant" | "deny" } }).__openmarkdownAiTest;
  if (hook) {
    for (const p of hook.providers ?? []) ai.registerProvider(p);
    if (hook.route) ai.testing.routeAll(hook.route);
    if (hook.config) ai.configure(hook.config);
    if (hook.consent) ai.testing.consent = hook.consent;
  }
  return ai;
}

/**
 * Carries the AI tools plugin's settings from before `app.ai` into the AI config,
 * once: turning the plugin on meant on-device AI for its tools and "Ask about this
 * note"; its optional OpenAI-compatible endpoint becomes that engine, and its key
 * moves from localStorage (plain text) into the keychain.
 */
export async function migrateAiToolsSettings(app: any, options: { remoteEnabled?: boolean; remoteBaseUrl?: string; remoteModel?: string }): Promise<void> {
  const ai = app.ai as AiServiceImpl | undefined;
  if (!ai || ai.config.migrated["ai-tools"]) return;
  const c = ai.config;
  c.migrated["ai-tools"] = true;
  c.enabled = true;
  c.features.tools ??= true;
  c.features.chat ??= true;
  if (options.remoteBaseUrl || options.remoteModel || options.remoteEnabled) {
    const prov = (c.providers["openai-compatible"] ??= {});
    prov.enabled = !!options.remoteEnabled;
    if (options.remoteBaseUrl) prov.baseUrl = options.remoteBaseUrl;
    if (options.remoteModel) prov.model = options.remoteModel;
  }
  const oldKey = app.loadLocalStorage?.("ai-tools-remote-key");
  if (typeof oldKey === "string" && oldKey) {
    try {
      await ai.keychain.set("openai-compatible", oldKey);
      c.keys["openai-compatible"] = true;
      app.saveLocalStorage("ai-tools-remote-key", null);
    } catch (e) {
      console.error("Could not move the AI endpoint key into the keychain", e);
    }
  }
  ai.save();
}
