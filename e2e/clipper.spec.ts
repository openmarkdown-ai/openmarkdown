/**
 * The companion extension (apps/clipper) end to end, in Chromium with the
 * unpacked build loaded.
 *
 *   npm run build -w @vault/clipper && npm run build -w @vault/web
 *   npx playwright test e2e/clipper.spec.ts
 *
 * The web app must call installCompanionBridge(app) at boot. To test against
 * another build of the app, set CLIPPER_APP_URL (default http://localhost:5200).
 * Test pages are served on 127.0.0.1:5201 (the clipper's registered e2e port).
 *
 * One deliberate difference from a user's install: the copy of the extension
 * under test lists `<all_urls>` as granted, standing in for the user accepting
 * the browser's permission prompt in the options page, which automation cannot
 * click. Everything after that prompt — the options toggle, the per-origin
 * consent window, the fetch itself — runs for real.
 */
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIST = join(ROOT, "apps/clipper/dist");
const FIXTURES = join(ROOT, "apps/clipper/test/fixtures");
const APP_URL = (process.env.CLIPPER_APP_URL ?? "http://localhost:5200").replace(/\/$/, "");
const PAGE_ORIGIN = "http://127.0.0.1:5201";
const ARTICLE_URL = `${PAGE_ORIGIN}/2024/09/05/Rust-1.81.0/`;
const SHOTS = join(ROOT, "test-results/clipper");
const CALENDAR_MANIFEST = "https://github.com/liamcain/obsidian-calendar-plugin/releases/download/1.5.10/manifest.json";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let server: Server;
let context: BrowserContext;
let sw: Worker;
let extId: string;
let tmp: string;

async function article(): Promise<Page> {
  const existing = context.pages().find((p) => p.url().startsWith(ARTICLE_URL));
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto(ARTICLE_URL);
  return page;
}

async function appPage(): Promise<Page> {
  const existing = context.pages().find((p) => p.url().startsWith(APP_URL));
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto(`${APP_URL}/?vault=demo`);
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 30_000 });
  return page;
}

async function tabIdFor(url: string): Promise<number> {
  return sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))!.id!, url);
}

async function openClipper(tabUrl: string): Promise<Page> {
  const tabId = await tabIdFor(tabUrl);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.goto(`chrome-extension://${extId}/clipper.html?tab=${tabId}`);
  await expect(popup.locator("#note-name")).not.toHaveValue("", { timeout: 20_000 });
  return popup;
}

async function vaultFile(app: Page, path: string): Promise<string | null> {
  return app.evaluate(async (p) => {
    const a = (window as any).app;
    const f = a.vault.getFileByPath(p);
    return f ? a.vault.read(f) : null;
  }, path);
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", PAGE_ORIGIN).pathname;
    if (path.startsWith("/2024/09/05/Rust-1.81.0")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(readFileSync(join(FIXTURES, "rust-blog.html")));
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(5201, "127.0.0.1", r));

  tmp = mkdtempSync(join(tmpdir(), "vault-clipper-e2e-"));
  const ext = join(tmp, "ext");
  cpSync(EXT_DIST, ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));

  context = await chromium.launchPersistentContext(join(tmp, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extId = new URL(sw.url()).host;

  const app = await appPage();
  const bridged = await app
    .waitForFunction(() => (window as any).__vaultCompanion?.connected === true, null, { timeout: 15_000 })
    .then(() => true, () => false);
  test.skip(!bridged, `${APP_URL} does not call installCompanionBridge(app) at boot yet`);
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("the app answers the extension's handshake", async () => {
  // The extension learned the vault list from the hello.
  await expect.poll(() => sw.evaluate(async () => ((await chrome.storage.local.get("settings")).settings as any)?.knownVaults ?? [])).toContainEqual(
    expect.objectContaining({ id: "demo", origin: APP_URL }),
  );
});

test("clips a saved article into the demo vault with the default template", async () => {
  const app = await appPage();
  await article();
  const popup = await openClipper(ARTICLE_URL);
  await expect(popup.locator("#note-name")).toHaveValue(/Announcing Rust 1\.81\.0/);
  await expect(popup.locator("#folder")).toHaveValue("Clippings");
  await expect(popup.locator("#preview")).toContainText("The Rust team is happy to announce a new version of Rust, 1.81.0");
  await expect(popup.locator('.prop[data-name="source"] .prop-value')).toHaveValue(ARTICLE_URL);
  await popup.screenshot({ path: join(SHOTS, "popup-default.png") });

  await popup.locator("#note-name").fill("Rust 1.81.0");
  await popup.locator("#add-to-vault").click();
  await expect(popup.locator(".banner--ok")).toContainText("Added to Clippings/Rust 1.81.0.md", { timeout: 30_000 });

  const text = await vaultFile(app, "Clippings/Rust 1.81.0.md");
  expect(text).toMatch(/^---\ntitle: "Announcing Rust 1\.81\.0/);
  expect(text).toContain(`source: "${ARTICLE_URL}"`);
  expect(text).toMatch(/tags:\n  - "clippings"/);
  expect(text).toContain("rustup update stable");
  expect(text).toContain("## What's in 1.81.0 stable");
  await popup.close();
});

test("options page imports a Web Clipper template whose trigger then matches", async () => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html#templates`);
  const tpl = {
    schemaVersion: "0.1.0",
    name: "Rust releases",
    behavior: "create",
    noteContentFormat: "> [!info] {{site}}\n\n{{content}}",
    properties: [
      { name: "source", value: "{{url}}", type: "text" },
      { name: "words", value: "{{words}}", type: "number" },
    ],
    triggers: [`${PAGE_ORIGIN}/2024/`],
    noteNameFormat: '{{title|replace:" | Rust Blog":""}}',
    path: "Releases/{{date|date:\"YYYY\"}}",
  };
  const file = join(tmp, "rust-releases-clipper.json");
  writeFileSync(file, JSON.stringify(tpl, null, "\t"));
  await options.locator("#import-file").setInputFiles(file);
  await expect(options.locator(".template-item .template-name").last()).toHaveText("Rust releases");
  await expect(options.locator("#tpl-triggers")).toHaveValue(`${PAGE_ORIGIN}/2024/`);
  await options.screenshot({ path: join(SHOTS, "options-templates.png"), fullPage: true });

  const download = options.waitForEvent("download");
  await options.getByRole("button", { name: "Export" }).click();
  const exported = JSON.parse(readFileSync((await (await download).path())!, "utf8"));
  expect(exported).toEqual(tpl);

  const app = await appPage();
  const popup = await openClipper(ARTICLE_URL);
  await expect(popup.locator("#template")).toHaveValue(/.+/);
  await expect(popup.locator("#template option:checked")).toHaveText("Rust releases");
  await expect(popup.locator("#note-name")).toHaveValue("Announcing Rust 1.81.0");
  await expect(popup.locator("#folder")).toHaveValue(`Releases/${new Date().getFullYear()}`);
  await popup.locator("#add-to-vault").click();
  await expect(popup.locator(".banner--ok")).toBeVisible({ timeout: 30_000 });
  const text = await vaultFile(app, `Releases/${new Date().getFullYear()}/Announcing Rust 1.81.0.md`);
  expect(text).toMatch(/words: \d+\n/);
  expect(text).toContain("> [!info] 127.0.0.1\n"); // {{site}} falls back to the domain
  await popup.close();
  // Leave the default template first again for the tests below.
  await options.goto(`chrome-extension://${extId}/options.html#templates`);
  await options.locator(".template-item").last().locator("button").first().click();
  await options.on("dialog", (d) => void d.accept());
  await options.getByRole("button", { name: "Delete" }).click();
  await expect(options.locator(".template-item")).toHaveCount(1);
  await options.close();
});

test("prompt variables (Web Clipper Interpreter) are filled by the app's AI when the clip arrives", async () => {
  const app = await appPage();
  // A stand-in for app.ai (docs/PLAN-ai.md): answers every prompt with "answer: <prompt>".
  await app.evaluate(() => {
    const engine = { provider: "ollama", model: "llama3.2", location: "local-server", leavesDevice: false };
    const w = window as any;
    w.__clipperCalls = [];
    w.__realAi = w.app.ai;
    w.app.ai = {
      isAvailable: () => true,
      engineFor: () => engine,
      ensureConsent: async () => true,
      async generate(req: any) {
        w.__clipperCalls.push(req.messages.map((m: any) => m.content));
        const { prompts } = JSON.parse(req.messages[1].content);
        const answers = Object.fromEntries(Object.entries(prompts).map(([k, v]) => [k, v === "three tags" ? "rust, release, compiler" : `answer: ${v}`]));
        return { text: JSON.stringify({ prompts_responses: answers }), engine };
      },
      embed: async () => { throw new Error("no"); },
      transcribe: async () => { throw new Error("no"); },
      on: () => ({}),
      offref: () => {},
    };
  });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html#templates`);
  const tpl = {
    schemaVersion: "0.1.0",
    name: "Interpreted",
    behavior: "create",
    noteContentFormat: '## Summary\n\n{{"a one sentence summary"|blockquote}}\n\nTags: {{ "three tags" | split:", " | join:" #" }}\n\nBy {{model}}',
    properties: [{ name: "summary", value: '{{"a one sentence summary"}}', type: "text" }],
    triggers: [`${PAGE_ORIGIN}/2024/`],
    noteNameFormat: "Interpreted {{title|slice:0,13}}",
    path: "Interpreted",
    context: "{{title}}",
  };
  const file = join(tmp, "interpreted-clipper.json");
  writeFileSync(file, JSON.stringify(tpl));
  await options.locator("#import-file").setInputFiles(file);
  await expect(options.locator("#tpl-context")).toHaveValue("{{title}}");

  const popup = await openClipper(ARTICLE_URL);
  await expect(popup.locator("#template option:checked")).toHaveText("Interpreted");
  await expect(popup.locator(".banner--info")).toContainText("2 prompt variables will be filled");
  await popup.screenshot({ path: join(SHOTS, "popup-prompts.png") });
  await popup.locator("#add-to-vault").click();
  await expect(popup.locator(".banner--ok")).toContainText("Filled 2 prompt variables · Ollama on this computer · llama3.2", { timeout: 30_000 });
  const text = await vaultFile(app, "Interpreted/Interpreted Announcing Ru.md");
  expect(text).toBe('---\nsummary: "answer: a one sentence summary"\n---\n## Summary\n\n> answer: a one sentence summary\n\nTags: rust #release #compiler\n\nBy llama3.2');
  const calls = await app.evaluate(() => (window as any).__clipperCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toContain("Announcing Rust 1.81.0");
  await popup.close();

  await options.goto(`chrome-extension://${extId}/options.html#templates`);
  await options.locator(".template-item").last().locator("button").first().click();
  options.on("dialog", (d) => void d.accept());
  await options.getByRole("button", { name: "Delete" }).click();
  await expect(options.locator(".template-item")).toHaveCount(1);
  await options.close();
  await app.evaluate(() => ((window as any).app.ai = (window as any).__realAi));
});

test("highlighter marks passages, stores them per URL, and they reach the note", async () => {
  const page = await article();
  await page.bringToFront();
  const tabId = await tabIdFor(ARTICLE_URL);
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["content/highlighter.js"] }), tabId);
  const phrase = "Rust is a programming language empowering everyone to build reliable and efficient software";
  await page.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const at = node.data.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return;
    }
    throw new Error("phrase not found");
  }, phrase);
  await expect(page.locator("mark.vault-clipper-highlight")).toHaveText(phrase);
  await page.screenshot({ path: join(SHOTS, "highlighter.png") });
  const stored = await sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], `highlights:${ARTICLE_URL}`);
  expect(stored).toEqual([expect.objectContaining({ text: phrase })]);

  const popup = await openClipper(ARTICLE_URL);
  await expect(popup.locator(".highlights-line")).toContainText("1 highlight on this page");
  await popup.getByRole("tab", { name: "Markdown" }).click();
  await expect(popup.locator("#markdown")).toHaveValue(new RegExp(`==${phrase}==`));
  await popup.screenshot({ path: join(SHOTS, "popup-highlights.png") });
  await popup.close();

  // Toggle off: marks go, the stored highlight stays.
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["content/highlighter.js"] }), tabId);
  await expect(page.locator("mark.vault-clipper-highlight")).toHaveCount(0);
  await sw.evaluate(async (key) => chrome.storage.local.remove(key), `highlights:${ARTICLE_URL}`);
});

test("a selection becomes the note content", async () => {
  const page = await article();
  await page.evaluate(() => {
    const p = document.getElementById("expect-lint")!.nextElementSibling!;
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  });
  const popup = await openClipper(ARTICLE_URL);
  await popup.getByRole("tab", { name: "Markdown" }).click();
  const md = await popup.locator("#markdown").inputValue();
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
  expect(body).toContain("1.81 stabilizes a new lint level, `expect`");
  expect(body).not.toContain("rustup update stable");
  await popup.close();
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
});

test("reader view renders the extracted article over the page", async () => {
  const page = await article();
  const tabId = await tabIdFor(ARTICLE_URL);
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["content/reader.js"] }), tabId);
  const frame = page.frameLocator("iframe[data-vault-clipper]");
  await expect(frame.locator(".reader-title")).toContainText("Announcing Rust 1.81.0");
  await expect(frame.locator(".reader-article")).toContainText("rustup update stable");
  await page.screenshot({ path: join(SHOTS, "reader.png") });
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ["content/reader.js"] }), tabId);
  await expect(page.locator("iframe[data-vault-clipper]")).toHaveCount(0);
});

test("append to daily note goes through the Daily notes core plugin", async () => {
  const app = await appPage();
  const popup = await openClipper(ARTICLE_URL);
  await popup.locator("#behavior").selectOption("append-daily");
  await popup.locator("#add-to-vault").click();
  await expect(popup.locator(".banner--ok")).toBeVisible({ timeout: 30_000 });
  const path = await app.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("daily-notes").getDailyNotePath());
  const text = await vaultFile(app, path);
  expect(text).toContain("- Opened the demo vault");
  expect(text).toContain("rustup update stable");
  expect(text).not.toContain("tags:\n"); // appended clips carry no frontmatter
  await popup.close();
});

test("with no app tab open, the extension opens one and delivers the clip", async () => {
  for (const p of context.pages()) if (p.url().startsWith(APP_URL)) await p.close();
  const popup = await openClipper(ARTICLE_URL);
  await popup.locator("#vault").selectOption(`${APP_URL}#demo`);
  await popup.locator("#note-name").fill("Delivered to a new tab");
  const opened = context.waitForEvent("page", { predicate: (p) => p.url().startsWith(APP_URL) });
  await popup.locator("#add-to-vault").click();
  const app = await opened;
  expect(app.url()).toMatch(/[?&]clip=[0-9a-f]{16}/);
  await expect(popup.locator(".banner--ok")).toContainText("Clippings/Delivered to a new tab.md", { timeout: 45_000 });
  expect(await vaultFile(app, "Clippings/Delivered to a new tab.md")).toContain("rustup update stable");
  expect(app.url()).not.toContain("clip=");
  await app.screenshot({ path: join(SHOTS, "app-after-clip.png") });
  await popup.close();
});

test("quick clip builds the note in the offscreen document and delivers it", async () => {
  const app = await appPage();
  await article();
  const tabId = await tabIdFor(ARTICLE_URL);
  await sw.evaluate((id) => (globalThis as any).__vaultClipper.quickClip(id), tabId);
  await expect
    .poll(() => app.evaluate(() => (window as any).app.vault.getMarkdownFiles().map((f: any) => f.path)), { timeout: 30_000 })
    .toContain("Clippings/Announcing Rust 1.81.0  Rust Blog.md");
  const contexts = await sw.evaluate(() => (chrome.runtime as any).getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }));
  expect(contexts).toHaveLength(1);
});

test("side panel and general settings render", async () => {
  const tabId = await tabIdFor(ARTICLE_URL);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 860 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tab=${tabId}`);
  await expect(panel.locator("#note-name")).toHaveValue(/Announcing Rust 1\.81\.0/, { timeout: 20_000 });
  await expect(panel.locator("#preview")).toContainText("rustup update stable");
  await panel.screenshot({ path: join(SHOTS, "side-panel.png") });
  await panel.close();

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html#general`);
  await expect(options.locator("#origins .origin-row")).toHaveCount(3);
  await expect(options.locator("#origins")).toContainText("http://localhost:5200");
  await options.screenshot({ path: join(SHOTS, "options-general.png"), fullPage: true });
  await options.close();
});

test("network bridge: requestUrl and plugin installs reach GitHub release assets", async () => {
  const app = await appPage();
  // Without the bridge a page cannot read a release asset (no CORS headers).
  expect(await app.evaluate((u) => fetch(u).then(() => "ok", () => "blocked"), CALENDAR_MANIFEST)).toBe("blocked");

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options.html#bridge`);
  await options.locator("#bridge-enabled").check();
  await expect(options.locator("#bridge-enabled")).toBeChecked();
  await options.screenshot({ path: join(SHOTS, "options-bridge.png"), fullPage: true });
  await app.waitForFunction(() => (window as any).__vaultCompanion?.bridgeEnabled === true);

  // A community plugin calling requestUrl, exactly as plugins do.
  await app.evaluate(async () => {
    const a = (window as any).app;
    await a.plugins.installFromFiles([
      { name: "manifest.json", data: JSON.stringify({ id: "bridge-probe", name: "Bridge probe", version: "1.0.0", minAppVersion: "0.15.0", author: "e2e", description: "" }) },
      {
        name: "main.js",
        data: `const { Plugin, requestUrl } = require("obsidian");
module.exports = class extends Plugin { async fetchJson(url) { const r = await requestUrl({ url }); return { status: r.status, json: r.json }; } };`,
      },
    ]);
    await a.plugins.setEnable(true);
    await a.plugins.enablePlugin("bridge-probe");
  });
  const consentPage = context.waitForEvent("page", { predicate: (p) => p.url().includes("consent.html") });
  const result = app.evaluate((u) => (window as any).app.plugins.plugins["bridge-probe"].fetchJson(u), CALENDAR_MANIFEST);
  const consent = await consentPage;
  await expect(consent.locator("#consent-origin")).toHaveText(APP_URL);
  await consent.screenshot({ path: join(SHOTS, "consent.png") });
  await consent.getByRole("button", { name: "Allow", exact: true }).click();
  const r = await result;
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ id: "calendar", version: "1.5.10" });

  // The plugin store's install path uses the same transport.
  await app.evaluate(() => (window as any).app.plugins.installPlugin("liamcain/obsidian-calendar-plugin", "1.5.10", { id: "calendar" }));
  const mainJs = await app.evaluate(() => (window as any).app.vault.adapter.read(".obsidian/plugins/calendar/main.js"));
  expect(mainJs.length).toBeGreaterThan(10_000);

  // Turning the bridge off unregisters the transport in the app.
  await options.locator("#bridge-enabled").uncheck();
  await app.waitForFunction(() => (window as any).__vaultCompanion?.bridgeEnabled === false);
  await options.close();
});
