// Quick end-to-end smoke run against apps/web/dist on :5200 (node e2e/server.mjs).
// Usage: node e2e/smoke.mjs <out-dir>
import { chromium } from "@playwright/test";
const out = process.argv[2] ?? "test-results/smoke";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message} ${e.stack?.split("\n").slice(1, 3).join(" | ")}`));
const shot = (n) => page.screenshot({ path: `${out}/${n}.png` });
const step = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}: ${e.message.split("\n")[0]}`); }
};
await page.goto("http://localhost:5200/?vault=demo");
await page.waitForSelector(".nav-file-title", { timeout: 15000 });
await step("open Welcome", async () => {
  await page.click('.nav-file-title[data-path="Welcome.md"]');
  await page.waitForSelector(".cm-content", { timeout: 5000 });
  await page.waitForTimeout(800);
  await shot("02-welcome-live");
});
await step("open Formatting", async () => {
  await page.click('.nav-file-title[data-path="Formatting.md"]');
  await page.waitForTimeout(1500);
  await shot("03-formatting-live");
});
await step("reading view", async () => {
  await page.keyboard.press("Meta+e");
  await page.waitForTimeout(2500);
  await shot("04-formatting-reading");
});
await step("command palette", async () => {
  await page.keyboard.press("Meta+p");
  await page.waitForSelector(".prompt", { timeout: 3000 });
  await page.keyboard.type("graph");
  await page.waitForTimeout(300);
  await shot("05-palette");
  await page.keyboard.press("Escape");
});
await step("graph", async () => {
  await page.evaluate(() => window.app.commands.executeCommandById("graph:open"));
  await page.waitForTimeout(2500);
  await shot("06-graph");
});
await step("canvas", async () => {
  await page.evaluate(() => window.app.workspace.openLinkText("Ideas.canvas", "", true));
  await page.waitForTimeout(2000);
  await shot("07-canvas");
});
await step("base", async () => {
  await page.evaluate(() => window.app.workspace.openLinkText("Reading list.base", "", true));
  await page.waitForTimeout(2000);
  await shot("08-base");
});
await step("settings", async () => {
  await page.evaluate(() => window.app.setting.open());
  await page.waitForTimeout(800);
  await shot("09-settings");
  await page.keyboard.press("Escape");
});
console.log("--- errors ---\n" + [...new Set(errors)].slice(0, 40).join("\n"));
await browser.close();
