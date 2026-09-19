// Renders public/icons/icon-{16,32,48,128}.png from the web app's favicon
// (a document glyph on the suite blue #15b9eb rounded square) with Playwright.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(here, "../../web/public/favicon.svg"), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.locator("svg").screenshot({ path: join(here, `../public/icons/icon-${size}.png`), omitBackground: true });
}
await browser.close();
console.log("icons written");
