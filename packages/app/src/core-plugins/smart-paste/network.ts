/**
 * Network for the paste and media features: `requestUrl`, which goes through
 * the companion extension's bridge when it is installed and switched on, and
 * plain `fetch` otherwise. A web page cannot read most sites directly (they
 * send no CORS headers), so a refused request is reported as `cors` and the
 * caller degrades — and the user is told once, per session, how to get titles.
 */
import { Notice } from "../../obsidian/ui/notice";
import { getRequestTransport, requestUrl } from "../../obsidian/util";
import { PRODUCT_NAME } from "../../product";

export type NetFailure = "cors" | "offline" | "status" | "too-large" | "invalid";

export class NetError extends Error {
  constructor(
    readonly kind: NetFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
  text(): string;
  contentType: string;
}

export async function fetchUrl(url: string, opts: { maxBytes?: number; headers?: Record<string, string> } = {}): Promise<NetResponse> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new NetError("offline", "No internet connection");
  let res;
  try {
    res = await requestUrl({ url, method: "GET", headers: opts.headers, throw: false });
  } catch (e) {
    // fetch rejects with a TypeError for both CORS refusals and network faults;
    // without the bridge the first is by far the likelier on a web page.
    const bridged = !!getRequestTransport();
    throw new NetError(bridged ? "status" : "cors", bridged ? `Request failed: ${(e as Error)?.message ?? e}` : "Blocked by CORS (companion extension not installed)");
  }
  if (res.status >= 400) throw new NetError("status", `HTTP ${res.status}`, res.status);
  const body = res.arrayBuffer;
  if (opts.maxBytes && body.byteLength > opts.maxBytes) throw new NetError("too-large", `Larger than ${Math.round(opts.maxBytes / 1048576)} MB`);
  let decoded: string | undefined;
  return {
    status: res.status,
    headers: res.headers,
    body,
    contentType: (res.headers["content-type"] ?? "").toLowerCase(),
    text: () => (decoded ??= new TextDecoder().decode(body)),
  };
}

export async function fetchJson<T = any>(url: string): Promise<T> {
  const res = await fetchUrl(url);
  try {
    return JSON.parse(res.text()) as T;
  } catch {
    throw new NetError("invalid", "Response is not JSON");
  }
}

let bridgeHintShown = false;

/** Tell the user, once per session, why a site could not be read and how to fix it. */
export function showBridgeHint(what: string): void {
  if (bridgeHintShown) return;
  bridgeHintShown = true;
  new Notice(
    `${PRODUCT_NAME} could not read this site from the browser, so ${what}. Install the ${PRODUCT_NAME} companion extension and switch on its network bridge to enable this.`,
    9000,
  );
}

// internal (tests reset the once-per-session hint)
export function resetBridgeHint(): void {
  bridgeHintShown = false;
}

/** Whether a community plugin with this id is installed and enabled (core features step aside). */
export function communityPluginEnabled(app: any, id: string): boolean {
  // A plugin listed as enabled but refused (desktop-only) or failed to load handles nothing.
  return !!app?.plugins?.enabledPlugins?.has?.(id) && !!app?.plugins?.plugins?.[id];
}
