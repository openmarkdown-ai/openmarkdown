/**
 * The wire protocol between the web app and its companion browser extension
 * (apps/clipper). Both sides import these types; nothing here has runtime cost
 * beyond the constants.
 *
 * Transport, page side: `window.postMessage` between the app page and the
 * extension's bridge content script, which the extension injects only into
 * the app origins the user configured. Every message carries `source` so each
 * side ignores its own posts and anything else on the window.
 *
 *   app page  ⇄ (postMessage)  bridge content script  ⇄ (runtime port)  service worker
 *
 * Bodies travel as base64 so the same messages are valid JSON on every hop
 * (Chromium's runtime messaging is JSON; Firefox's is structured clone).
 */

export const APP_SOURCE = "vault-companion-app";
export const EXT_SOURCE = "vault-companion-ext";
export const PROTOCOL_VERSION = 1;

/** Web Clipper's template behaviours (`Template.behavior`). */
export type ClipBehavior = "create" | "overwrite" | "append-specific" | "prepend-specific" | "append-daily" | "prepend-daily";

export interface VaultRef {
  id: string;
  name: string;
}

// ---- app → extension --------------------------------------------------------

export interface AppHello {
  type: "app-hello";
  protocol: number;
  product: string;
  /** The vault open in this tab. */
  vault: VaultRef;
  /** Every vault this origin knows (ids are local to the origin). */
  vaults: VaultRef[];
  /** `?clip=<id>` from the URL the extension opened, if any. */
  pendingClip?: string;
}

export interface FetchRequest {
  type: "fetch";
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  /** base64 */
  body?: string;
}

export interface ClipResult {
  type: "clip-result";
  id: string;
  ok: boolean;
  path?: string;
  error?: string;
  /** Present when the clip carried prompt variables (`ClipRequest.interpreter`). */
  interpreter?: InterpreterOutcome;
}

/** What became of a clip's prompt variables. */
export interface InterpreterOutcome {
  /** Distinct prompts in the template. */
  prompts: number;
  /** Prompts the model answered. */
  filled: number;
  /** "On this device · …", "Sent to Anthropic · …": who answered. */
  engine?: string;
  /** Why prompts were left as `{{"…"}}` placeholders (AI off, declined, failed). The clip is still written. */
  message?: string;
}

/**
 * The app is working on a clip and needs more time than a plain write
 * (running its prompt variables through the app's AI). The extension extends
 * its wait for the `clip-result`.
 */
export interface ClipProgress {
  type: "clip-progress";
  id: string;
  stage: "interpreting";
  engine?: string;
}

/**
 * Let these hosts load inside the app's web viewer frames: the extension
 * removes `X-Frame-Options` and `Content-Security-Policy` from their responses,
 * only for sub-frames the app's own pages load. `hosts` replaces this origin's
 * list; an empty list removes every rule.
 */
export interface SetFramingHosts {
  type: "set-framing-hosts";
  id: string;
  hosts: string[];
}

export type AppToExt = AppHello | FetchRequest | ClipResult | SetFramingHosts | ClipProgress;

// ---- extension → app --------------------------------------------------------

export interface ExtHello {
  type: "ext-hello";
  protocol: number;
  extensionId: string;
  version: string;
}

export type ConsentState = "granted" | "denied" | "ask";

export interface ExtStatus {
  type: "ext-status";
  /** The network bridge is switched on and the extension holds `<all_urls>`. */
  bridgeEnabled: boolean;
  /** This origin's consent to use the network bridge. */
  consent: ConsentState;
  maxResponseBytes: number;
  /** Hosts this origin may show in frames despite their framing headers. */
  framingHosts?: string[];
}

export interface FetchResponse {
  type: "fetch-result";
  id: string;
  status?: number;
  headers?: Record<string, string>;
  /** base64 */
  body?: string;
  error?: string;
  code?: "disabled" | "denied" | "origin" | "too-large" | "network" | "bad-request";
}

export interface ClipRequest {
  type: "clip";
  id: string;
  /** Target vault id; absent means "the vault open in this tab". */
  vaultId?: string;
  /** Vault-relative path of the note, with or without `.md`. Ignored for daily behaviours. */
  path: string;
  content: string;
  behavior: ClipBehavior;
  /** Do not open the note after writing it (Web Clipper's `silentOpen`). */
  silent?: boolean;
  /**
   * Web Clipper Interpreter: the template has prompt variables (`{{"…"}}`), which
   * the app fills with its own AI (feature "clipper") before writing. The app
   * then writes `interpreter.body` under frontmatter built from
   * `interpreter.properties`, and names the note from `interpreter.noteName`;
   * `content` and `path` are the unfilled fallback for apps without this.
   */
  interpreter?: ClipInterpreterRequest;
}

export interface ClipInterpreterRequest {
  /** The template's prompt context, already rendered against the page (Web Clipper's `context` / default prompt context). */
  context: string;
  /** Note body with prompt variables left in, in their canonical form `{{"prompt"|filters}}`. */
  body: string;
  /** Properties with prompt variables left in; the app writes the frontmatter after filling them. */
  properties: { name: string; value: string; type: string }[];
  /** Property types from the extension's settings (frontmatter formatting). */
  propertyTypes: Record<string, string>;
  /** Frontmatter is written (create and overwrite behaviours). */
  frontmatter: boolean;
  /** Unsanitised note name, which may hold prompt variables; ignored for daily behaviours. */
  noteName: string;
  folder: string;
  /** For filters that need them (`date`, relative links). */
  url: string;
  nowMs: number;
  tzOffsetMinutes: number;
}

export interface FramingResult {
  type: "framing-result";
  id: string;
  ok: boolean;
  hosts: string[];
  error?: string;
}

export type ExtToApp = ExtHello | ExtStatus | FetchResponse | ClipRequest | FramingResult;
