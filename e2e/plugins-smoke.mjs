// Installs real community plugin bundles into the demo vault and enables them.
// Usage: node e2e/plugins-smoke.mjs <bundles-dir> <out-dir> id1 id2 ...
import { chromium } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
const [bundles, out, ...ids] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 300)}`); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 300)} ${e.stack?.split("\n").slice(1, 3).join(" | ")}`));
await page.goto("http://localhost:5200/?vault=demo");
await page.waitForSelector(".nav-file-title", { timeout: 15000 });
await page.evaluate(() => window.app.plugins.setEnable(true));
for (const id of ids) {
  const files = ["manifest.json", "main.js", "styles.css"].filter((f) => existsSync(`${bundles}/${id}/${f}`)).map((f) => ({ name: f, data: readFileSync(`${bundles}/${id}/${f}`, "utf8") }));
  const before = errors.length;
  const res = await page.evaluate(async ({ files }) => { try {
    const m = await window.app.plugins.installFromFiles(files);
    const ok = await window.app.plugins.enablePluginAndSave(m.id);
    return { id: m.id, ok, loaded: !!window.app.plugins.plugins[m.id] }; } catch (e) { return { id: "?", ok: false, loaded: false, error: String(e) }; }
  }, { files });
  await page.waitForTimeout(1500);
  console.log(`${res.loaded ? "LOADED" : "FAILED"} ${id}${errors.length > before ? `  (${errors.length - before} errors)` : ""}`);
  for (const e of errors.slice(before, before + 4)) console.log("   " + e);
}
await page.evaluate(() => window.app.workspace.openLinkText("Formatting", "", false));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/plugins-1.png` });
console.log("commands:", await page.evaluate(() => Object.keys(window.app.commands.commands).filter((c) => !/^(editor|app|workspace|markdown|file-explorer|global-search|switcher|command-palette|graph|canvas|bookmarks|backlink|outline|tag-pane|properties|daily-notes|templates|note-composer|workspaces|random-note|zk-prefixer|page-preview|slides|publish|webviewer|audio-recorder|file-recovery|outgoing-links|footnotes|importer|markdown-importer|theme|window|insert|bases|slash-command)/.test(c)).length));
await browser.close();
