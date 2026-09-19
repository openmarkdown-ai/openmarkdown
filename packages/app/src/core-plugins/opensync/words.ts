/**
 * What sync says to people, and the small decisions that shape it — kept free
 * of any engine import so the dormant plugin can use them without loading it.
 */

export const HOSTED_WS = "wss://relay.opensync.network/";

/** "Edge on macOS" — a device, never a vault, so conflict copies say where they came from. */
export function defaultDeviceLabel(): string {
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string }[]; platform?: string } };
  const ua = navigator.userAgent;
  const brands = nav.userAgentData?.brands?.map((b) => b.brand) ?? [];
  const browser =
    brands.find((b) => /Edge/i.test(b)) ? "Edge"
    : brands.find((b) => /Opera/i.test(b)) ? "Opera"
    : brands.find((b) => /Brave/i.test(b)) ? "Brave"
    : /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) || brands.some((b) => /Chrom/i.test(b)) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const platform = nav.userAgentData?.platform || ua;
  const os =
    /Android/i.test(platform) ? "Android"
    : /iPhone|iPad|iOS/i.test(platform) ? "iOS"
    : /Mac/i.test(platform) ? "macOS"
    : /Win/i.test(platform) ? "Windows"
    : /CrOS|Chrome OS/i.test(platform) ? "ChromeOS"
    : /Linux/i.test(platform) ? "Linux"
    : "this device";
  return `${browser} on ${os}`;
}

export interface Endpoint {
  ws: string;
  http: string;
}

/**
 * A server address as typed — `relay.example.net`, `192.168.0.10:4848`,
 * `wss://…` — as the socket and storage addresses. Mirrors the client's
 * `assumeTls`: a name with a dot is on the internet, an IP or a bare name is
 * on your own network, and a typed scheme always wins.
 */
export function endpointFor(address: string): Endpoint {
  let a = address.trim();
  if (!a) throw new Error("Type the address of your sync server.");
  if (/^https?:\/\//i.test(a)) a = a.replace(/^http/i, "ws");
  if (!/^wss?:\/\//i.test(a)) {
    const bare = a.replace(/\/+$/, "");
    const host = bare.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    const local = host === "localhost" || host.endsWith(".local") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || !host.includes(".");
    a = `${local ? "ws" : "wss"}://${bare}`;
  }
  let url: URL;
  try {
    url = new URL(a);
  } catch {
    throw new Error(`“${address}” is not a server address.`);
  }
  const ws = `${url.protocol}//${url.host}${url.pathname === "/" ? "/" : url.pathname}`;
  const http = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  return { ws, http };
}

/**
 * A reason this page cannot reach `ws` at all, before anything tries.
 *
 * An `https:` page may not open `ws://` or fetch `http://` except to this
 * computer; the browser refuses silently, and the socket error that follows
 * says nothing about why.
 */
export function mixedContentProblem(ws: string): string | null {
  if (typeof location === "undefined" || location.protocol !== "https:") return null;
  if (!ws.startsWith("ws://")) return null;
  const host = ws.slice(5).split(/[/:]/)[0];
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return null;
  return "This page is served over https, so the browser will not connect to a plain ws:// server on your network. Put the server behind TLS (wss://) — for example with `tailscale serve` or a reverse proxy — and use that address.";
}

export function isHosted(ws: string): boolean {
  try {
    return new URL(ws).host === new URL(HOSTED_WS).host;
  } catch {
    return false;
  }
}

export type Attention = "offline" | "not-admitted" | "quota" | "locked-out" | "error";

/** A thrown error as a category and a sentence a person can act on. */
export function explain(e: unknown, relayWs: string): { kind: Attention; text: string } {
  const err = e as { name?: string; message?: string } | null;
  const name = err?.name ?? "";
  const msg = String(err?.message ?? e ?? "");
  if (name === "NotAdmittedError" || /does not serve your account|restricted:/i.test(msg)) {
    return {
      kind: "not-admitted",
      text: isHosted(relayWs)
        ? "The OpenSync server has not admitted this account yet. Hosted sync is invite-only for now, so nothing was uploaded. You can run your own sync server instead — it is one small program — and point this vault at it."
        : "This sync server does not accept this account. Ask whoever runs it to admit the account, or use a different server.",
    };
  }
  if (name === "QuotaError" || /quota exceeded|storage is full/i.test(msg)) {
    return {
      kind: "quota",
      text: "Sync storage on this server is full. Notes keep syncing once there is room: turn attachments off, remove large files, or use your own sync server, where there is no limit.",
    };
  }
  if (/decryption|could not open|authentication tag|cannot open/i.test(msg)) {
    return {
      kind: "locked-out",
      text: "This device can no longer read the vault — its encryption key was changed on another device. Join again with a code from a device that still syncs.",
    };
  }
  if (name === "RelayUnreachableError" || name === "TypeError" || /cannot reach|did not answer|closed the connection|Failed to fetch|NetworkError|network/i.test(msg)) {
    return { kind: "offline", text: navigator.onLine === false ? "Offline — will sync when the connection is back." : `Cannot reach the sync server — will retry. (${msg})` };
  }
  return { kind: "error", text: msg || "Sync failed." };
}

/** "3 minutes ago", for a status line. */
export function ago(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleString();
}

/** A conflict copy's name, as the engine writes it: `name (conflict 2026-09-14 from Phone).md`. */
export const CONFLICT_RE = /^(.*) \(conflict (\d{4}-\d{2}-\d{2}) from (.+)\)(\.[^./]+)?$/;

export function parseConflict(path: string): { original: string; date: string; from: string } | null {
  const m = CONFLICT_RE.exec(path);
  if (!m) return null;
  return { original: `${m[1]}${m[4] ?? ""}`, date: m[2]!, from: m[3]! };
}
