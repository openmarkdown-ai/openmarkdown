// Ad-hoc DOM probe: node e2e/probe.mjs "<js expression run after demo boot>"
import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto("http://localhost:5200/?vault=demo");
await page.waitForSelector(".nav-file-title", { timeout: 15000 });
for (const expr of process.argv.slice(2)) {
  if (expr.startsWith("hover:")) { await page.hover(expr.slice(6)); await page.waitForTimeout(1200); continue; }
  if (expr.startsWith("click:")) { await page.click(expr.slice(6)); await page.waitForTimeout(1200); continue; }
  console.log(JSON.stringify(await page.evaluate(expr), null, 1));
}
await browser.close();
