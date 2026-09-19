// Shared helpers for the community-plugin compatibility scenarios.
// Every scenario boots `?vault=demo`, installs real, unmodified release bundles
// from a local folder, drives the plugin through the UI, and asserts on what a
// user would see. Console errors and page errors are collected per scenario.
import { chromium } from "@playwright/test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const BASE = process.env.COMPAT_URL ?? "http://localhost:5200/";

export function bundleFiles(bundles, id) {
  const dir = join(bundles, id);
  return ["manifest.json", "main.js", "styles.css", "data.json"]
    .filter((f) => existsSync(join(dir, f)))
    .map((f) => ({ name: f, data: readFileSync(join(dir, f), "utf8") }));
}

export async function launch() {
  return chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
}

/** A fresh page on the demo vault with `ids` installed and enabled. */
export async function openVault(browser, bundles, ids, { width = 1440, height = 900, before } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  // Network noise, CM6 deprecation warnings, and the service worker a Vite dev
  // server cannot serve (sw.js falls back to index.html) are not plugin faults.
  const ignore = /favicon|ERR_INTERNET_DISCONNECTED|net::ERR|Failed to load resource|\[CM6\]|^The script has an unsupported MIME type \('text\/html'\)\.$/;
  page.on("console", (m) => {
    if (m.type() === "error" && !ignore.test(m.text())) errors.push(`console: ${m.text().slice(0, 400)}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 300)} @ ${(e.stack ?? "").split("\n").slice(1, 4).join(" | ").slice(0, 400)}`));
  await page.goto(`${BASE}?vault=demo`);
  await page.waitForSelector(".nav-file-title", { timeout: 30000 });
  if (before) await before(page);
  await page.evaluate(() => window.app.plugins.setEnable(true));
  const loaded = {};
  for (const id of ids) {
    const files = bundleFiles(bundles, id);
    loaded[id] = await page.evaluate(async (files) => {
      try {
        const m = await window.app.plugins.installFromFiles(files);
        await window.app.plugins.enablePluginAndSave(m.id);
        return !!window.app.plugins.plugins[m.id];
      } catch (e) {
        return String(e);
      }
    }, files);
  }
  await page.waitForTimeout(1000);
  return { context, page, errors, loaded };
}

export async function openNote(page, path, mode = "source", source = false) {
  await page.evaluate(
    async ({ path, mode, source }) => {
      const f = window.app.vault.getFileByPath(path);
      const leaf = window.app.workspace.getLeaf(false);
      await leaf.openFile(f, { active: true, state: { mode, source } });
    },
    { path, mode, source },
  );
  await page.waitForTimeout(600);
}

export async function writeNote(page, path, text) {
  await page.evaluate(
    async ({ path, text }) => {
      const f = window.app.vault.getFileByPath(path);
      if (f) await window.app.vault.modify(f, text);
      else {
        const dir = path.split("/").slice(0, -1).join("/");
        if (dir && !window.app.vault.getAbstractFileByPath(dir)) await window.app.vault.createFolder(dir);
        await window.app.vault.create(path, text);
      }
    },
    { path, text },
  );
}

export class Checks {
  constructor(name) {
    this.name = name;
    this.results = [];
  }
  ok(label, cond, detail = "") {
    this.results.push({ label, pass: !!cond, detail: String(detail ?? "") });
    console.log(`  ${cond ? "PASS" : "FAIL"} ${label}${detail !== "" ? ` — ${String(detail).slice(0, 200)}` : ""}`);
    return !!cond;
  }
  get passed() {
    return this.results.filter((r) => r.pass).length;
  }
}

export function allBundles(bundles) {
  return readdirSync(bundles).filter((d) => statSync(join(bundles, d)).isDirectory());
}
