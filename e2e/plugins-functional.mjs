// Installs Dataview + Tasks + Calendar, writes a note with live queries, and photographs the result.
// Usage: node e2e/plugins-functional.mjs <bundles-dir> <out-dir>
import { chromium } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
const [bundles, out] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
await page.goto("http://localhost:5200/?vault=demo");
await page.waitForSelector(".nav-file-title", { timeout: 15000 });
await page.evaluate(() => window.app.plugins.setEnable(true));
for (const id of ["dataview", "obsidian-tasks-plugin", "calendar"]) {
  const files = ["manifest.json", "main.js", "styles.css"].filter((f) => existsSync(`${bundles}/${id}/${f}`)).map((f) => ({ name: f, data: readFileSync(`${bundles}/${id}/${f}`, "utf8") }));
  await page.evaluate(async (files) => { const m = await window.app.plugins.installFromFiles(files); await window.app.plugins.enablePluginAndSave(m.id); }, files);
}
await page.waitForTimeout(3000);
await page.evaluate(async () => {
  const text = "# Plugin check\n\n## Dataview\n\n```dataview\nTABLE author, rating FROM \"Books\" SORT rating DESC\n```\n\nInline: `= this.file.name`\n\n## Tasks\n\n```tasks\nnot done\n```\n";
  const f = await window.app.vault.create("Plugin check.md", text);
  const leaf = window.app.workspace.getLeaf(false);
  await leaf.openFile(f, { state: { mode: "preview" } });
});
await page.waitForTimeout(5000);
await page.evaluate(() => window.app.commands.executeCommandById("calendar:show-calendar-view"));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/plugins-functional.png` });
console.log(JSON.stringify(await page.evaluate(() => ({
  dataviewRows: document.querySelectorAll(".block-language-dataview tbody tr, .dataview.table-view-table tbody tr").length,
  tasks: document.querySelectorAll(".block-language-tasks li, .plugin-tasks-query-result li").length,
  calendar: !!document.querySelector(".calendar, #calendar-container"),
}))));
console.log(errors.slice(0, 10).join("\n"));
await browser.close();
