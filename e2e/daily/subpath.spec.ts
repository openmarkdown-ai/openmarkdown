/**
 * The hosted app is served under a sub-path (https://openmarkdown.ai/app/), not
 * at the origin root. This serves the built app (apps/web/dist) under /app/ on
 * its own port — the landing page's place, /, is a 404 here — and checks that
 * nothing reaches outside /app/: the service worker's scope, the manifest,
 * ?vault= / ?choose=1 navigation, vault resource URLs and an offline reload.
 *
 *   (cd apps/web && npx vite build)
 *   npx playwright test e2e/daily/subpath.spec.ts
 */
import { expect, test } from "@playwright/test";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../../apps/web/dist", import.meta.url));
const BASE = "/app/";
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".map": "application/json",
};

let server: Server;
let origin = "";
/** Every path the browser asked for, to prove nothing was requested outside /app/. */
const requested: string[] = [];

test.beforeAll(async () => {
  test.skip(!existsSync(join(dist, "index.html")), "needs the built app in apps/web/dist");
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requested.push(url.pathname);
    if (url.pathname === "/app") {
      res.writeHead(301, { Location: "/app/" + url.search }).end();
      return;
    }
    if (!url.pathname.startsWith(BASE)) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("landing page, not the app");
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname.slice(BASE.length))).replace(/^(\.\.[/\\])+/, "");
    let file = join(dist, rel);
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (rel.startsWith("assets/") || extname(rel) === ".wasm" || rel === "sw.js") {
        res.writeHead(404).end();
        return;
      }
      file = join(dist, "index.html");
    }
    res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

test("the app runs under /app/: service worker, manifest, navigation, resources, offline", async ({ page, context }) => {
  test.setTimeout(180_000);
  const app = `${origin}${BASE}`;

  // ?choose=1 shows the vault picker and stays inside /app/.
  await page.goto(`${app}?choose=1`);
  await page.waitForSelector(".vault-starter", { timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe(BASE);

  // The manifest's start_url and scope resolve inside /app/.
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href;
    const m = await (await fetch(href)).json();
    return { href, start: new URL(m.start_url, href).href, scope: new URL(m.scope, href).href, id: new URL(m.id, href).href };
  });
  expect(manifest.href).toBe(`${app}manifest.webmanifest`);
  expect(manifest.start).toBe(app);
  expect(manifest.scope).toBe(app);
  expect(manifest.id).toBe(app);

  // The service worker registers with scope /app/ and takes control.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          return reg?.active?.state === "activated" && !!navigator.serviceWorker.controller ? reg.scope : null;
        }),
      { timeout: 120_000, intervals: [500] },
    )
    .toBe(app);
  const swUrl = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL);
  expect(swUrl).toBe(`${app}sw.js`);

  // ?vault=demo opens the demo vault, still inside /app/.
  await page.goto(`${app}?vault=demo`);
  await page.waitForSelector(".nav-file-title", { timeout: 30_000 });
  await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true);
  expect(new URL(page.url()).pathname).toBe(BASE);

  // Vault resource URLs live under /app/ and the service worker answers them.
  const resource = await page.evaluate(async () => {
    const a = (window as any).app;
    const f = await a.vault.create("subpath-check.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
    const url: string = a.vault.getResourcePath(f);
    const r = await fetch(url);
    return { url, status: r.status, body: await r.text() };
  });
  expect(resource.url.startsWith(`${app}__vault_resource__/`)).toBe(true);
  expect(resource.status).toBe(200);
  expect(resource.body).toContain("<svg");

  // Offline reload: the precached app starts with the network gone.
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector(".nav-file-title", { timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe(BASE);
  await context.setOffline(false);

  // Nothing was fetched from the origin root (the landing page's territory).
  const outside = requested.filter((p) => p !== "/app" && !p.startsWith(BASE));
  expect(outside).toEqual([]);
});
