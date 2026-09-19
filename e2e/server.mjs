// Static server for apps/web/dist on port 5200 (the e2e and screenshot target).
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "../apps/web/dist");
const port = Number(process.env.PORT ?? 5200);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".map": "application/json",
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  // Production serves the app under /app/ (https://openmarkdown.ai/app/); the
  // same build answers there too, so a test can check what only happens there.
  if (path === "/app") {
    res.writeHead(301, { Location: "/app/" + url.search }).end();
    return;
  }
  if (path.startsWith("/app/")) path = path.slice(4);
  let file = join(root, path);
  // `/account` is account.html, as nginx's `try_files $uri $uri.html` serves it.
  if ((!existsSync(file) || statSync(file).isDirectory()) && existsSync(`${file}.html`)) file = `${file}.html`;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // A missing hashed asset is a 404, not the app shell: the service worker must see
    // the failure to fall back to its cached copy from an older build.
    if (path.startsWith("/assets/") || extname(path) === ".wasm" || path === "/sw.js") {
      res.writeHead(404).end();
      return;
    }
    file = join(root, "index.html");
  }
  res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
