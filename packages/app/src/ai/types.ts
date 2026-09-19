/**
 * The contract every AI feature codes against: `app.ai` (docs/PLAN-ai.md).
 *
 * Features never talk to a model directly. They ask the service for text,
 * embeddings or a transcript for a named feature; the service picks the engine
 * the user chose for that feature (on this device, a local server, or a cloud
 * provider), asks for consent before the first download or the first time text
 * would leave the device, and reports which engine answered.
 */

/** Every AI feature, so the user can route each one to a different engine. */
export type AiFeature =
  | "tools" // summarize, translate, rewrite, proofread, write
  | "chat" // ask about a note, chat with the vault
  | "related" // semantic index: related notes, search by meaning
  | "suggest" // link, tag, property, title and alt-text suggestions
  | "transcribe" // audio recordings to text
  | "clipper" // prompt variables in web clipper templates
  | "query" // plain language to Bases / Dataview queries
  | "review"; // periodic note reviews

/** Where an engine runs — shown to the user wherever a result appears. */
export type EngineLocation = "device" | "local-server" | "cloud";

export interface EngineInfo {
  /** Stable id, e.g. "chrome-builtin", "transformers", "ollama", "openai", "anthropic", "gemini", "openai-compatible". */
  provider: string;
  /** Model id as the provider names it, e.g. "claude-sonnet-5", "gpt-5-mini", "Xenova/bge-small-en-v1.5". */
  model: string;
  location: EngineLocation;
  /** True when text or audio is sent off this device (a cloud provider, or a server on another machine). */
  leavesDevice: boolean;
  /** Input tokens the model accepts, when known (e.g. Chrome's on-device model is small). Features trim retrieved context to fit. */
  contextWindow?: number;
}

export interface AiMessage {
  role: "user" | "assistant";
  content: string;
  /** Images for vision-capable engines (alt text). Ignored, with `unsupported` raised, by engines without vision. */
  images?: Blob[];
}

export interface GenerateRequest {
  feature: AiFeature;
  system?: string;
  messages: AiMessage[];
  /** Upper bound on the answer; engines may stop earlier. */
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object; the service validates it parses and retries once if not. */
  json?: boolean;
  signal?: AbortSignal;
  /** Streaming: called with each new piece of text as it arrives. */
  onToken?: (text: string) => void;
  /**
   * Optional hint for engines with task-specific models (Chrome's Summarizer,
   * Translator, Rewriter …). Other engines ignore it and use `system` + `messages`,
   * so a request must always carry a complete prompt too.
   */
  task?: AiTaskHint;
}

export type AiTaskHint =
  | { kind: "summarize"; type: "key-points" | "tldr" | "teaser" | "headline"; length: "short" | "medium" | "long" }
  | { kind: "translate"; target: string; source?: string }
  | { kind: "rewrite"; mode: "shorter" | "longer" | "more-formal" | "more-casual" }
  | { kind: "proofread" }
  | { kind: "write"; request: string; context: string }
  | { kind: "detect-language" };

export interface GenerateResult {
  text: string;
  engine: EngineInfo;
  /** Structured extras some tasks return, e.g. `{ language: "en", confidence: 0.97 }` for "detect-language". */
  data?: { language?: string; confidence?: number };
}

export interface EmbedRequest {
  /** Which feature's route to use; defaults to "related". */
  feature?: AiFeature;
  texts: string[];
  /** Some models embed queries and documents differently (e.g. an instruction prefix). */
  kind: "document" | "query";
  signal?: AbortSignal;
  /** Progress for long batches, 0..1. */
  onProgress?: (done: number, total: number) => void;
}

export interface EmbedResult {
  vectors: Float32Array[];
  /**
   * Vectors from different models are not comparable: indexes key on this.
   * Always the bare model id as the provider names it, the same string as
   * `engine.model` (e.g. "Xenova/multilingual-e5-small", "text-embedding-3-small",
   * "nomic-embed-text"), never prefixed with the provider. `engineFor(...).model`
   * returns the same string whenever the model is configured; a local server with
   * no model chosen reports a placeholder there until the first request picks one.
   */
  model: string;
  dims: number;
  engine: EngineInfo;
}

export interface TranscribeRequest {
  audio: Blob;
  /** BCP-47 hint, or undefined to detect. */
  language?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
}

export interface TranscribeResult {
  text: string;
  segments: TranscriptSegment[];
  language?: string;
  engine: EngineInfo;
}

/** Why a request did not run. Features show `message` as-is; it is written for the user. */
export class AiUnavailableError extends Error {
  constructor(
    readonly reason: "disabled" | "no-engine" | "consent-declined" | "unsupported" | "offline" | "auth" | "quota" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export interface AiService {
  /** The user turned AI on and routed this feature to an engine that can do it. */
  isAvailable(feature: AiFeature, capability?: "generate" | "embed" | "transcribe" | "vision"): boolean;
  /** The engine a request for this feature would use now, or null. For "runs on this device" / "sent to X" labels. */
  engineFor(feature: AiFeature, capability?: "generate" | "embed" | "transcribe" | "vision"): EngineInfo | null;
  /**
   * Resolves true once the user has agreed to what this feature needs: a model download
   * (with its size), or sending text to the named provider. Asks at most once per
   * feature+engine; remembered until the engine changes.
   */
  ensureConsent(feature: AiFeature, capability?: "generate" | "embed" | "transcribe" | "vision"): Promise<boolean>;
  /** Throws AiUnavailableError. */
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** Throws AiUnavailableError. */
  embed(req: EmbedRequest): Promise<EmbedResult>;
  /** Throws AiUnavailableError. */
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>;
  /** Raised as `app.ai.on("change", …)` when settings, keys or engines change. */
  on(name: "change", callback: () => void): unknown;
  offref(ref: unknown): void;
}
