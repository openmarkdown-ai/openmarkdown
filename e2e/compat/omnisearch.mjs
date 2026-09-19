// Omnisearch: indexes the vault (MiniSearch, cached in IndexedDB via Dexie)
// and its modal must return ranked results for a word in the demo notes.
export default {
  plugins: ["omnisearch"],
  // Omnisearch starts its local HTTP API unless Platform.isMobile, and logs the
  // (caught) failure when require("http") is absent — a desktop-only feature.
  ignoreErrors: [/unsupported MIME type/, /Failed to load API server/, /sponsors\/scambier\/button/],
  async run({ page, check, shot }) {
    // Omnisearch indexes on layout-ready / after install; give it time.
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.app.commands.executeCommandById("omnisearch:show-modal"));
    await page.waitForTimeout(800);
    const modal = await page.$(".omnisearch-modal, .modal-container .prompt");
    check.ok("search modal opens", !!modal);
    await page.keyboard.type("callouts", { delay: 30 });
    await page.waitForTimeout(2500);
    const results = await page.evaluate(() => Array.from(document.querySelectorAll(".omnisearch-result, .suggestion-item")).map((e) => e.textContent.trim().slice(0, 60)));
    check.ok("query returns results", results.length > 0, results.slice(0, 3).join(" | "));
    check.ok("the Formatting note is among them", results.some((r) => /Formatting/.test(r)), results.length);
    await shot("modal");
    if (results.length) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
      const active = await page.evaluate(() => window.app.workspace.getActiveFile()?.path);
      check.ok("Enter opens the result", !!active && /Formatting|Linking/.test(active), active);
    }
    // In-file search command.
    await page.evaluate(() => window.app.commands.executeCommandById("omnisearch:show-modal-infile"));
    await page.waitForTimeout(600);
    check.ok("in-file modal opens", !!(await page.$(".modal-container")));
    await page.keyboard.press("Escape");
    await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById("omnisearch"); });
    await page.waitForTimeout(600);
    const n = await page.evaluate(() => document.querySelectorAll(".vertical-tab-content .setting-item").length);
    check.ok("settings tab renders", n > 5, n);
  },
};
