/**
 * `vault.getResourcePath()` is synchronous and must return a URL an `<img>` can
 * load. Neither a directory handle nor OPFS can mint one synchronously, so the
 * URL points at a path the app's service worker answers: it asks the page that
 * owns the vault for the bytes over a MessageChannel and streams them back.
 *
 * Without a controlling service worker (first visit, a private window, a
 * browser that refuses one) `installResourceFallback()` watches the DOM and
 * swaps such URLs for blob URLs, so images still appear — a frame later.
 */

export const RESOURCE_PREFIX = "__vault_resource__";

type Reader = (path: string) => Promise<ArrayBuffer>;
const readers = new Map<string, Reader>();

function base(): string {
  const b = (globalThis as { __VAULT_RESOURCE_BASE__?: string }).__VAULT_RESOURCE_BASE__;
  if (b) return b;
  const url = new URL(document.baseURI);
  return url.origin + url.pathname.replace(/[^/]*$/, "");
}

export function resourceUrl(vaultId: string, path: string, mtime: number): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${base()}${RESOURCE_PREFIX}/${encodeURIComponent(vaultId)}/${encoded}?${mtime}`;
}

export function parseResourceUrl(url: string): { vaultId: string; path: string } | null {
  const i = url.indexOf(RESOURCE_PREFIX + "/");
  if (i === -1) return null;
  const rest = url.slice(i + RESOURCE_PREFIX.length + 1).split("?")[0]!.split("#")[0]!;
  const [vault, ...segs] = rest.split("/");
  if (!vault) return null;
  return { vaultId: decodeURIComponent(vault), path: segs.map(decodeURIComponent).join("/") };
}

export function registerResourceReader(vaultId: string, reader: Reader) {
  readers.set(vaultId, reader);
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp",
  svg: "image/svg+xml", webp: "image/webp", avif: "image/avif", ico: "image/x-icon",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", "3gp": "audio/3gpp",
  flac: "audio/flac", webm: "video/webm", mp4: "video/mp4", ogv: "video/ogg", mov: "video/quicktime",
  mkv: "video/x-matroska", pdf: "application/pdf", md: "text/markdown", txt: "text/plain",
  json: "application/json", css: "text/css", js: "text/javascript", html: "text/html",
  canvas: "application/json", base: "text/yaml",
};

export function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

export async function readResource(url: string): Promise<{ data: ArrayBuffer; type: string } | null> {
  const parsed = parseResourceUrl(url);
  if (!parsed) return null;
  const reader = readers.get(parsed.vaultId);
  if (!reader) return null;
  return { data: await reader(parsed.path), type: mimeFor(parsed.path) };
}

/** Answer the service worker's requests for vault files. */
export function installResourceBridge() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", async (ev: MessageEvent) => {
    const msg = ev.data as { type?: string; url?: string } | null;
    if (!msg || msg.type !== "vault-resource" || !msg.url) return;
    const port = ev.ports[0];
    if (!port) return;
    try {
      const res = await readResource(msg.url);
      if (!res) port.postMessage({ status: 404 });
      else port.postMessage({ status: 200, type: res.type, data: res.data }, [res.data]);
    } catch (e) {
      port.postMessage({ status: 404, error: String(e) });
    }
  });
}

const blobCache = new Map<string, string>();

async function toBlobUrl(url: string): Promise<string | null> {
  const cached = blobCache.get(url);
  if (cached) return cached;
  const res = await readResource(url);
  if (!res) return null;
  const blobUrl = URL.createObjectURL(new Blob([res.data], { type: res.type }));
  blobCache.set(url, blobUrl);
  return blobUrl;
}

function swap(el: Element, attr: "src" | "href" | "data" | "poster") {
  const value = el.getAttribute(attr);
  if (!value || !value.includes(RESOURCE_PREFIX)) return;
  toBlobUrl(value).then((b) => {
    if (b && el.getAttribute(attr) === value) el.setAttribute(attr, b);
  });
}

/** For when no service worker controls the page. */
export function installResourceFallback(root: Node = document) {
  if (navigator.serviceWorker?.controller) return;
  const scan = (node: Node) => {
    if (!(node instanceof Element)) return;
    for (const el of [node, ...Array.from(node.querySelectorAll("img,video,audio,source,iframe,embed,object,link"))]) {
      for (const attr of ["src", "href", "data", "poster"] as const) swap(el, attr);
    }
  };
  new MutationObserver((records) => {
    if (navigator.serviceWorker?.controller) return;
    for (const r of records) {
      if (r.type === "attributes" && r.target instanceof Element) scan(r.target);
      r.addedNodes.forEach(scan);
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href", "data", "poster"] });
}
