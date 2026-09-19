// Static server for a built app, for the PWA e2e specs (offline start, updates, share target).
//   node e2e/daily/pwa-server.mjs <dist dir> [port]
// Unlike e2e/server.mjs it answers a missing /assets/* file with 404 (as hosting
// must, so a stale chunk fails loudly instead of returning index.html), and it
// has one test hook: GET /__om_test__/bump-sw changes the build id inside sw.js,
// which makes the browser see a new service worker (an "update").
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "apps/web/dist");
const port = Number(process.argv[3] ?? process.env.PORT ?? 5221);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".map": "application/json",
};
let swVariant = 0;

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/__om_test__/bump-sw" || url.pathname === "/__om_test__/reset-sw") {
    swVariant = url.pathname.endsWith("reset-sw") ? 0 : swVariant + 1;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ variant: swVariant }));
    return;
  }
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, path);
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/sw.js" && swVariant) {
    const code = readFileSync(file, "utf8").replace(/"buildId":"([^"]+)"/, (_m, id) => `"buildId":"${id}-v${swVariant}"`);
    res.setHeader("Content-Type", "text/javascript");
    res.end(code);
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (url.pathname.startsWith("/assets/") || req.method !== "GET") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    file = join(root, "index.html");
  }
  res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
