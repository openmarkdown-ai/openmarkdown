/**
 * The app side of the companion browser extension (apps/clipper).
 *
 * The extension injects a small bridge content script into the app's origin
 * (only the origins the user configured). This module talks to it through
 * `window.postMessage` and does three things:
 *
 * 1. **Handshake.** Announces the open vault (and every vault this origin
 *    knows) so the extension can offer them as clip targets, and answers the
 *    extension's own hello whichever side loads first.
 * 2. **Clips.** Writes notes the Web Clipper sends — create, overwrite,
 *    append/prepend to a note, append/prepend to the daily note — through
 *    `app.vault`, and acknowledges each one.
 * 3. **Network bridge.** Registers a `RequestTransport` so `requestUrl`
 *    (plugins) and `fetchReleaseAsset` (plugin installs) reach hosts that send
 *    no CORS headers, via the extension's service worker. It is registered only
 *    while the user has switched the bridge on and has not refused this origin.
 *
 * Call `installCompanionBridge(app)` once, right after the App is constructed.
 */
import type { App } from "../obsidian/app";
import { arrayBufferToBase64, base64ToArrayBuffer, getRequestTransport, setRequestTransport, type RequestTransport } from "../obsidian/util";
import { whenLayoutReady } from "../settings/helpers";
import { PRODUCT_NAME } from "../product";
import {
  APP_SOURCE,
  EXT_SOURCE,
  PROTOCOL_VERSION,
  type AppToExt,
  type ClipRequest,
  type ExtStatus,
  type ExtToApp,
  type FetchResponse,
  type FramingResult,
  type VaultRef,
} from "./protocol";
import { writeClip } from "./write-note";
import { Notice } from "../obsidian/ui/notice";
import type { AiService } from "../ai/types";
import type { InterpreterOutcome } from "./protocol";

export type { ClipBehavior, ClipRequest } from "./protocol";
export { writeClip } from "./write-note";

export interface CompanionStatus {
  /** The extension's bridge script answered in this tab. */
  connected: boolean;
  extensionVersion: string | null;
  bridgeEnabled: boolean;
  consent: ExtStatus["consent"] | null;
  /** Hosts the web viewer may frame, as the extension last reported. */
  framingHosts: string[];
}

let framingSetter: ((hosts: string[]) => Promise<string[]>) | null = null;

/**
 * Ask the companion extension to let `hosts` load in the web viewer despite their
 * framing headers (replaces the list). Null when the extension's network bridge is
 * not usable in this tab.
 */
export function companionFraming(): { hosts: string[]; set(hosts: string[]): Promise<string[]> } | null {
  const status = (window as unknown as { __vaultCompanion?: CompanionStatus }).__vaultCompanion;
  if (!framingSetter || !status?.bridgeEnabled || status.consent !== "granted") return null;
  return { hosts: status.framingHosts, set: framingSetter };
}

const REQUEST_TIMEOUT_MS = 5 * 60_000; // a first request can wait on the consent prompt
const SEEN_KEY = "vault-companion-seen-clips";

let installed: (() => void) | null = null;

function newId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function seenClips(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function rememberClip(id: string) {
  try {
    const ids = [...seenClips(), id].slice(-200);
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable: duplicates are still refused within this page */
  }
}

export function installCompanionBridge(app: App): () => void {
  if (installed) return installed;

  const status: CompanionStatus = { connected: false, extensionVersion: null, bridgeEnabled: false, consent: null, framingHosts: [] };
  const pending = new Map<string, { resolve: (r: FetchResponse) => void; timer: number }>();
  const handled = new Set<string>();
  const params = new URL(location.href).searchParams;
  const pendingClip = params.get("clip") ?? undefined;

  const post = (msg: AppToExt) => window.postMessage({ source: APP_SOURCE, ...msg }, location.origin);

  const vaultList = async (): Promise<VaultRef[]> => {
    const current = { id: app.appId, name: app.vault.getName() };
    try {
      const { listVaults } = await import("../boot");
      const list = (await listVaults()).map((v) => ({ id: v.id, name: v.name }));
      if (!list.some((v) => v.id === current.id)) list.unshift(current);
      return list;
    } catch {
      return [current];
    }
  };

  const hello = async () => {
    post({
      type: "app-hello",
      protocol: PROTOCOL_VERSION,
      product: PRODUCT_NAME,
      vault: { id: app.appId, name: app.vault.getName() },
      vaults: await vaultList(),
      pendingClip,
    });
  };

  const transport: RequestTransport = {
    name: "companion-extension",
    request: (p) =>
      new Promise((resolve, reject) => {
        const id = newId();
        let body: string | undefined;
        if (typeof p.body === "string") body = arrayBufferToBase64(new TextEncoder().encode(p.body).buffer as ArrayBuffer);
        else if (p.body instanceof ArrayBuffer) body = arrayBufferToBase64(p.body);
        const headers: Record<string, string> = { ...(p.headers ?? {}) };
        if (p.contentType && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = p.contentType;
        const timer = window.setTimeout(() => {
          pending.delete(id);
          reject(new Error("The companion extension did not answer."));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, {
          timer,
          resolve: (r) => {
            if (r.error !== undefined || r.status === undefined) {
              reject(Object.assign(new Error(r.error ?? "The companion extension could not make the request."), { code: r.code }));
              return;
            }
            resolve({ status: r.status, headers: r.headers ?? {}, body: base64ToArrayBuffer(r.body ?? "") });
          },
        });
        post({ type: "fetch", id, url: p.url, method: p.method, headers, body });
      }),
  };

  const applyStatus = (s: ExtStatus) => {
    status.bridgeEnabled = s.bridgeEnabled;
    status.consent = s.consent;
    status.framingHosts = s.framingHosts ?? [];
    const usable = s.bridgeEnabled && s.consent !== "denied";
    if (usable && getRequestTransport() !== transport) setRequestTransport(transport);
    else if (!usable && getRequestTransport() === transport) setRequestTransport(null);
  };

  const framingWaiters = new Map<string, (r: FramingResult) => void>();
  framingSetter = (hosts) =>
    new Promise((resolve, reject) => {
      const id = newId();
      const timer = window.setTimeout(() => {
        framingWaiters.delete(id);
        reject(new Error("The companion extension did not answer."));
      }, 30_000);
      framingWaiters.set(id, (r) => {
        window.clearTimeout(timer);
        if (!r.ok) reject(new Error(r.error ?? "The companion extension refused."));
        else {
          status.framingHosts = r.hosts;
          resolve(r.hosts);
        }
      });
      post({ type: "set-framing-hosts", id, hosts });
    });

  const onClip = (clip: ClipRequest) => {
    if (clip.vaultId && clip.vaultId !== app.appId) {
      post({ type: "clip-result", id: clip.id, ok: false, error: `wrong-vault:${app.appId}` });
      return;
    }
    if (handled.has(clip.id) || seenClips().has(clip.id)) {
      post({ type: "clip-result", id: clip.id, ok: true });
      return;
    }
    handled.add(clip.id);
    whenLayoutReady(app, () => {
      let outcome: InterpreterOutcome | undefined;
      const write = async () => {
        if (!clip.interpreter) return writeClip(app, clip);
        post({ type: "clip-progress", id: clip.id, stage: "interpreting" });
        const { interpretClip } = await import("./interpreter");
        const daily = clip.behavior === "append-daily" || clip.behavior === "prepend-daily";
        const ai = (app as unknown as { ai?: AiService }).ai;
        const done = await interpretClip(ai, clip.interpreter, daily, (engine) => post({ type: "clip-progress", id: clip.id, stage: "interpreting", engine }));
        outcome = done.outcome;
        const file = await writeClip(app, { ...clip, content: done.content, path: done.path ?? clip.path });
        if (outcome.prompts) {
          if (outcome.message) new Notice(outcome.message, 10_000);
          else new Notice(`Filled ${outcome.filled} prompt variable${outcome.filled === 1 ? "" : "s"} · ${outcome.engine ?? "AI"}`);
        }
        return file;
      };
      write().then(
        (file) => {
          rememberClip(clip.id);
          post({ type: "clip-result", id: clip.id, ok: true, path: file.path, interpreter: outcome });
        },
        (e: unknown) => {
          handled.delete(clip.id);
          post({ type: "clip-result", id: clip.id, ok: false, error: e instanceof Error ? e.message : String(e) });
        },
      );
    });
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as ({ source?: string } & ExtToApp) | null;
    if (!data || typeof data !== "object" || data.source !== EXT_SOURCE) return;
    switch (data.type) {
      case "ext-hello":
        status.connected = true;
        status.extensionVersion = data.version;
        void hello();
        break;
      case "ext-status":
        status.connected = true;
        applyStatus(data);
        break;
      case "fetch-result": {
        const entry = pending.get(data.id);
        if (!entry) break;
        pending.delete(data.id);
        window.clearTimeout(entry.timer);
        entry.resolve(data);
        break;
      }
      case "clip":
        onClip(data);
        break;
      case "framing-result": {
        const waiter = framingWaiters.get(data.id);
        framingWaiters.delete(data.id);
        waiter?.(data);
        break;
      }
    }
  };

  window.addEventListener("message", onMessage);
  void hello();
  if (pendingClip) {
    const url = new URL(location.href);
    url.searchParams.delete("clip");
    history.replaceState(history.state, "", url.toString());
  }
  // internal (read by e2e tests and the Community plugins tab's diagnostics)
  (window as unknown as { __vaultCompanion?: CompanionStatus }).__vaultCompanion = status;

  installed = () => {
    window.removeEventListener("message", onMessage);
    if (getRequestTransport() === transport) setRequestTransport(null);
    for (const [, entry] of pending) window.clearTimeout(entry.timer);
    pending.clear();
    framingSetter = null;
    installed = null;
  };
  return installed;
}
