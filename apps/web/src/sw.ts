/// <reference lib="webworker" />
/**
 * The app's service worker. Three jobs:
 *
 * 1. **Offline app shell.** `self.__OM_PRECACHE__` is replaced at build time
 *    (apps/web/precache-plugin.ts) with `{ buildId, files }`. `install` caches
 *    every file of the build in `openmarkdown-app-<buildId>`. Hashed assets are
 *    served cache-first from *any* retained build, so a tab still running the
 *    previous build keeps loading its lazy chunks after a deploy. A build's
 *    cache is deleted only once no open tab reports running it. Navigations go
 *    to the network first and fall back to the cached `index.html` (or
 *    `account.html` for the account page).
 *    A new worker waits; the page shows "Update available" and asks it to
 *    `skip-waiting` when the user chooses to reload (packages/app/src/pwa/sw-client.ts).
 * 2. **Vault resources.** `__vault_resource__/<vault>/<path>` is answered by
 *    asking the page that owns the vault for the bytes
 *    (packages/app/src/obsidian/vault/resource.ts).
 * 3. **Share target.** The manifest's `share_target` POSTs multipart form data
 *    to `./share-target`; the worker stores it in IndexedDB and redirects to
 *    `./?share=<id>`, where the capture surface picks it up.
 *
 * No imports: the file must stay a single classic script.
 */
interface PrecacheManifest {
  buildId: string;
  builtAt: number;
  files: [string, string][];
}

const sw = self as unknown as ServiceWorkerGlobalScope;
const MANIFEST = readManifest();
const BUILD_ID = MANIFEST?.buildId ?? "dev";
const CACHE_PREFIX = "openmarkdown-app-";
const CACHE_NAME = CACHE_PREFIX + BUILD_ID;
const META_URL = "__openmarkdown_cache_meta__";
const RESOURCE_PREFIX = "__vault_resource__/";
const SCOPE = new URL(sw.registration.scope);
const PRECACHED = new Set((MANIFEST?.files ?? []).map(([f]) => new URL(f, SCOPE).pathname));
const INDEX_URL = new URL("index.html", SCOPE).toString();
/** The account page is a second document; offline, its own cached copy answers for it, never the app's. */
const ACCOUNT_PATHS = new Set([new URL("account", SCOPE).pathname, new URL("account.html", SCOPE).pathname]);
const ACCOUNT_URL = new URL("account.html", SCOPE).toString();
/** Old builds kept when some tab cannot say which build it runs. */
const KEEP_UNKNOWN_BUILDS = 2;

function readManifest(): PrecacheManifest | null {
  // The build replaces this expression with the manifest; on the dev server it stays undefined.
  const m = (self as unknown as { __OM_PRECACHE__?: PrecacheManifest }).__OM_PRECACHE__;
  return m && typeof m === "object" ? m : null;
}

// ---- install / activate --------------------------------------------------------------

sw.addEventListener("install", (event) => {
  if (!MANIFEST) {
    // Dev server: nothing to cache, nothing to wait for.
    event.waitUntil(sw.skipWaiting());
    return;
  }
  event.waitUntil(precache(MANIFEST));
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await sw.clients.claim();
      await cleanup();
    })(),
  );
});

async function precache(manifest: PrecacheManifest) {
  const cache = await caches.open(CACHE_NAME);
  const queue = manifest.files.map(([file]) => file);
  const failures: string[] = [];
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const url = new URL(file, SCOPE).toString();
      if (await cache.match(url)) continue;
      // Another retained build may already hold the identical hashed file.
      const hashed = /(^|\/)assets\//.test(file) ? await caches.match(url) : undefined;
      if (hashed) {
        await cache.put(url, hashed);
        continue;
      }
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const res = await fetch(new Request(url, { cache: "reload", credentials: "same-origin" }));
          if (res.ok) {
            await cache.put(url, res);
            ok = true;
          }
        } catch {
          /* retry once */
        }
      }
      if (!ok) failures.push(file);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (failures.length) {
    // A partial shell would break offline start; fail the install so the
    // browser retries on the next navigation.
    await caches.delete(CACHE_NAME);
    throw new Error(`Precache failed for ${failures.length} file(s): ${failures.slice(0, 5).join(", ")}`);
  }
  await cache.put(META_URL, new Response(JSON.stringify({ buildId: manifest.buildId, builtAt: manifest.builtAt, installedAt: Date.now() }), { headers: { "Content-Type": "application/json" } }));
}

/** Delete the caches of builds no open tab runs any more. */
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCleanup() {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    void cleanup();
  }, 2000);
}

async function cleanup() {
  const names = (await caches.keys()).filter((n) => n.startsWith(CACHE_PREFIX));
  if (!names.length) return;
  const inUse = new Set<string>([BUILD_ID]);
  let unknown = 0;
  const clients = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  await Promise.all(
    clients.map(async (client) => {
      const reply = await ask<{ buildId?: string }>(client, { type: "openmarkdown-which-build" }, 1500);
      if (reply?.buildId) inUse.add(reply.buildId);
      else unknown++;
    }),
  );
  const stale: { name: string; builtAt: number }[] = [];
  for (const name of names) {
    if (inUse.has(name.slice(CACHE_PREFIX.length))) continue;
    const meta = await (await caches.open(name)).match(META_URL);
    const info = meta ? ((await meta.json().catch(() => ({}))) as { builtAt?: number }) : {};
    stale.push({ name, builtAt: info.builtAt ?? 0 });
  }
  // A tab that did not answer may be an old build still starting: keep the newest few.
  stale.sort((a, b) => b.builtAt - a.builtAt);
  const doomed = unknown ? stale.slice(KEEP_UNKNOWN_BUILDS) : stale;
  await Promise.all(doomed.map((s) => caches.delete(s.name)));
}

// ---- messages ------------------------------------------------------------------------

sw.addEventListener("message", (event) => {
  const msg = event.data as { type?: string } | null;
  if (!msg || typeof msg !== "object") return;
  const port = event.ports[0];
  switch (msg.type) {
    case "openmarkdown-skip-waiting":
      event.waitUntil(sw.skipWaiting());
      break;
    case "openmarkdown-get-build":
      port?.postMessage({ buildId: BUILD_ID, builtAt: MANIFEST?.builtAt ?? 0, precached: PRECACHED.size });
      break;
    case "openmarkdown-hello":
      scheduleCleanup();
      break;
  }
});

function ask<T>(client: Client, message: unknown, timeout: number): Promise<T | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeout);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data as T);
    };
    try {
      client.postMessage(message, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

// ---- fetch ---------------------------------------------------------------------------

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return;
  if (request.url.includes(RESOURCE_PREFIX)) {
    event.respondWith(serveResource(event));
    return;
  }
  if (request.method === "POST" && url.pathname === new URL("share-target", SCOPE).pathname) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (!MANIFEST || request.method !== "GET" || !url.pathname.startsWith(SCOPE.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  if (PRECACHED.has(url.pathname) || url.pathname.startsWith(new URL("assets/", SCOPE).pathname)) {
    event.respondWith(cacheFirst(request, url));
  }
});

async function cacheFirst(request: Request, url: URL): Promise<Response> {
  const key = url.origin + url.pathname;
  // Unhashed files (manifest, icons) come from this build; hashed assets from any build.
  const own = await (await caches.open(CACHE_NAME)).match(key);
  if (own) return own;
  const any = await caches.match(key);
  if (any) return any;
  const res = await fetch(request);
  // Hashed files left out of the precache (optional downloads) are kept once fetched.
  if (res.ok && res.status === 200 && url.pathname.startsWith(new URL("assets/", SCOPE).pathname) && !request.headers.has("range")) {
    const copy = res.clone();
    void caches.open(CACHE_NAME).then((c) => c.put(key, copy)).catch(() => {});
  }
  return res;
}

async function navigate(request: Request): Promise<Response> {
  const shell = ACCOUNT_PATHS.has(new URL(request.url).pathname) ? ACCOUNT_URL : INDEX_URL;
  const cached = async () => (await (await caches.open(CACHE_NAME)).match(shell)) ?? (await caches.match(shell));
  try {
    const res = await withTimeout(fetch(request), 4000);
    if (res.ok || res.status === 304) return res;
    return (await cached()) ?? res;
  } catch {
    const hit = await cached();
    if (hit) return hit;
    return new Response("OpenMarkdown is offline and has not been cached yet.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ---- share target --------------------------------------------------------------------

interface StoredShare {
  id: string;
  title: string;
  text: string;
  url: string;
  files: { name: string; type: string; blob: Blob }[];
  receivedAt: number;
}

function openShareDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("openmarkdown-pwa", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("shares")) db.createObjectStore("shares", { keyPath: "id" });
      if (!db.objectStoreNames.contains("launch")) db.createObjectStore("launch", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function receiveShare(request: Request): Promise<Response> {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  try {
    const form = await request.formData();
    const str = (k: string) => {
      const v = form.get(k);
      return typeof v === "string" ? v : "";
    };
    const files: StoredShare["files"] = [];
    for (const v of form.getAll("files")) {
      if (typeof v !== "string") files.push({ name: v.name || "shared-file", type: v.type, blob: v });
    }
    const share: StoredShare = { id, title: str("title"), text: str("text"), url: str("url"), files, receivedAt: Date.now() };
    const db = await openShareDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("shares", "readwrite", { durability: "strict" } as IDBTransactionOptions);
      tx.objectStore("shares").put(share);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    const back = new URL("./", SCOPE);
    back.searchParams.set("share-error", String((e as Error)?.message ?? e));
    return Response.redirect(back.toString(), 303);
  }
  const target = new URL("./", SCOPE);
  target.searchParams.set("share", id);
  return Response.redirect(target.toString(), 303);
}

// ---- vault resources -----------------------------------------------------------------

async function serveResource(event: FetchEvent): Promise<Response> {
  const candidates: Client[] = [];
  if (event.clientId) {
    const c = await sw.clients.get(event.clientId);
    if (c) candidates.push(c);
  }
  for (const c of await sw.clients.matchAll({ type: "window" })) if (!candidates.some((x) => x.id === c.id)) candidates.push(c);
  for (const client of candidates) {
    // The requesting tab answers fast; a pop-out window or another tab may not own the vault.
    const res = await ask<{ status: number; type?: string; data?: ArrayBuffer }>(client, { type: "vault-resource", url: event.request.url }, client.id === event.clientId ? 10000 : 3000);
    if (res && res.status === 200) {
      const headers: Record<string, string> = { "Content-Type": res.type ?? "application/octet-stream", "Cache-Control": "no-store" };
      return rangeResponse(event.request, new Uint8Array(res.data!), headers);
    }
  }
  return new Response("Not found", { status: 404 });
}

/** Media elements seek with Range requests; answer them or video will not scrub. */
function rangeResponse(request: Request, bytes: Uint8Array, headers: Record<string, string>): Response {
  const range = request.headers.get("Range");
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (!m) return new Response(bytes as unknown as BodyInit, { status: 200, headers: { ...headers, "Accept-Ranges": "bytes", "Content-Length": String(bytes.length) } });
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? Math.min(parseInt(m[2], 10), bytes.length - 1) : bytes.length - 1;
  return new Response(bytes.slice(start, end + 1) as unknown as BodyInit, {
    status: 206,
    headers: { ...headers, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": String(end - start + 1) },
  });
}
