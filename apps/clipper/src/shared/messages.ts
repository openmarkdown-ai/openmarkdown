/** Messages between the extension's own pages, content scripts and background. */
import type { ClipBehavior, ClipInterpreterRequest, InterpreterOutcome, VaultRef } from "../../../../packages/app/src/companion/protocol";
import type { PageCapture } from "./capture";
import type { Settings, StoredHighlight, Template } from "./settings";

declare global {
  /** Set by the build: true in dist-firefox. */
  const __FIREFOX__: boolean;
}

export interface OutgoingClip {
  path: string;
  content: string;
  behavior: ClipBehavior;
  silent?: boolean;
  /** Prompt variables for the app to fill (see `ClipRequest.interpreter`). */
  interpreter?: ClipInterpreterRequest;
}

export interface DeliverResult {
  ok: boolean;
  path?: string;
  error?: string;
  interpreter?: InterpreterOutcome;
}

export type ClipIntentMode = "page" | "selection" | "link";

export interface ClipIntent {
  mode: ClipIntentMode;
  tabId: number;
  linkUrl?: string;
  at: number;
}

export type RuntimeMessage =
  | { kind: "deliver-clip"; clip: OutgoingClip; origin?: string; vaultId?: string }
  | { kind: "consent-answer"; origin: string; granted: boolean }
  | { kind: "settings-changed" }
  | { kind: "bridge-reconnect" }
  | { kind: "connected-vaults" }
  | { kind: "build-note"; target: "offscreen"; page: PageCapture; template: Template; settings: Settings; highlights: StoredHighlight[] };

export interface ConnectedVaults {
  tabs: { tabId: number; origin: string; vault?: VaultRef }[];
}
