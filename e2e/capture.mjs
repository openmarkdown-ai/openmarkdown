// Screenshots for the test guide, from the built app on :5200.
// Usage: node e2e/capture.mjs <out-dir> [bundles-dir]
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const [out, bundles] = process.argv.slice(2);
if (!out) throw new Error("usage: node e2e/capture.mjs <out-dir> [bundles-dir]");
mkdirSync(out, { recursive: true });
const URL = process.env.CAPTURE_URL ?? "http://localhost:5200/";

const browser = await chromium.launch();

async function session(colorScheme) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme });
  const page = await context.newPage();
  return { context, page };
}

const ready = (page) => page.waitForFunction(() => window.app?.workspace?.layoutReady && window.app?.metadataCache?.initialized, null, { timeout: 30000 });
const settle = (page, ms = 800) => page.waitForTimeout(ms);
// Park the pointer so hover tooltips and previews do not sit on the image.
const shot = async (page, name) => {
  await page.mouse.move(1439, 899);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/${name}.png` });
};
const run = (page, fn, arg) => page.evaluate(fn, arg);

// ---- light --------------------------------------------------------------------
{
  const { context, page } = await session("light");
  await page.goto(`${URL}?choose=1`);
  await page.waitForSelector(".vault-starter");
  await shot(page, "01-starter");

  await page.goto(`${URL}?vault=demo`);
  await ready(page);
  await run(page, () => window.app.workspace.rightSplit.expand());
  await page.click('.nav-file-title[data-path="Welcome.md"]');
  await page.waitForSelector(".cm-content .cm-line");
  await settle(page, 1500);
  await shot(page, "02-live-preview");

  await run(page, () => window.app.workspace.openLinkText("Formatting", "", false, { state: { mode: "preview" } }));
  await page.waitForSelector(".markdown-reading-view .callout");
  await page.waitForFunction(() => document.querySelector(".markdown-reading-view .math mjx-container, .markdown-reading-view .math svg"), null, { timeout: 20000 }).catch(() => {});
  await settle(page, 1500);
  await shot(page, "03-reading-view");

  await run(page, () => window.app.commands.executeCommandById("global-search:open"));
  await page.keyboard.type("tag:#project OR rating");
  await settle(page, 1200);
  await shot(page, "04-search");

  await page.keyboard.press("Meta+o");
  await page.keyboard.type("garden");
  await settle(page, 500);
  await shot(page, "05-quick-switcher");
  await page.keyboard.press("Escape");

  await run(page, () => window.app.commands.executeCommandById("graph:open"));
  await settle(page, 3500);
  await shot(page, "06-graph");

  await run(page, () => window.app.workspace.openLinkText("Ideas.canvas", "", true));
  await settle(page, 2500);
  await shot(page, "07-canvas");

  await run(page, () => window.app.workspace.openLinkText("Reading list.base", "", true));
  await settle(page, 2500);
  await shot(page, "08-bases");

  await run(page, () => window.app.setting.open());
  await settle(page, 600);
  await run(page, () => window.app.setting.openTabById("community-plugins"));
  await settle(page, 600);
  await shot(page, "09-settings-community");
  await page.keyboard.press("Escape");

  await context.close();
}

// ---- community plugins and a theme ------------------------------------------------
if (bundles && existsSync(bundles)) {
  const { context, page } = await session("light");
  await page.goto(`${URL}?vault=demo`);
  await ready(page);
  await run(page, () => window.app.plugins.setEnable(true));
  for (const id of ["dataview", "obsidian-tasks-plugin", "calendar", "obsidian-kanban"]) {
    const files = ["manifest.json", "main.js", "styles.css"].filter((f) => existsSync(`${bundles}/${id}/${f}`)).map((f) => ({ name: f, data: readFileSync(`${bundles}/${id}/${f}`, "utf8") }));
    await run(page, async (files) => {
      const m = await window.app.plugins.installFromFiles(files);
      await window.app.plugins.enablePluginAndSave(m.id);
    }, files);
  }
  await settle(page, 2000);
  await run(page, async () => {
    const text = "# Community plugins\n\nDataview, unmodified:\n\n```dataview\nTABLE author, rating FROM \"Books\" SORT rating DESC\n```\n\nTasks, unmodified:\n\n```tasks\nnot done\n```\n";
    const f = await window.app.vault.create("Community plugins.md", text);
    await window.app.workspace.getLeaf(false).openFile(f, { state: { mode: "preview" } });
    window.app.workspace.rightSplit.expand();
    const cal = window.app.workspace.getLeavesOfType("calendar")[0];
    if (cal) await window.app.workspace.revealLeaf(cal);
  });
  await settle(page, 5000);
  await shot(page, "10-plugins-dataview-tasks-calendar");

  await run(page, async () => {
    await window.app.commands.executeCommandById("obsidian-kanban:create-new-kanban-board");
  });
  await settle(page, 2500);
  await run(page, async () => {
    const view = window.app.workspace.activeLeaf?.view;
    const text = "---\nkanban-plugin: board\n---\n\n## To do\n\n- [ ] Write the guide\n- [ ] Record a demo\n\n## Doing\n\n- [ ] Plugin compatibility\n\n## Done\n\n- [x] Rust core\n\n";
    if (view?.file) await window.app.vault.modify(view.file, text);
  });
  await settle(page, 2500);
  await shot(page, "11-plugins-kanban");

  const minimal = `${bundles}/../obsidian-minimal/Minimal.css`;
  if (existsSync(minimal)) {
    await run(page, async (css) => {
      const a = window.app;
      await a.vault.adapter.mkdir(".obsidian/themes/Minimal");
      await a.vault.adapter.write(".obsidian/themes/Minimal/manifest.json", JSON.stringify({ name: "Minimal", version: "0", author: "kepano" }));
      await a.vault.adapter.write(".obsidian/themes/Minimal/theme.css", css);
      await a.customCss.readThemes();
      await a.customCss.setCssTheme("Minimal");
      a.customCss.setTheme("obsidian");
      await a.workspace.openLinkText("Formatting", "", false, { state: { mode: "source" } });
    }, readFileSync(minimal, "utf8"));
    await settle(page, 2500);
    await shot(page, "12-theme-minimal-dark");
  }
  await context.close();
}

// ---- dark, and a large vault --------------------------------------------------------
{
  const { context, page } = await session("dark");
  await page.goto(`${URL}?vault=demo`);
  await ready(page);
  await run(page, async () => {
    const a = window.app;
    const words = "garden reading systems programming notes canvas graph links tasks ideas".split(" ");
    for (let i = 0; i < 1500; i++) {
      const links = [1, 2].map((k) => `[[Big ${(i * 7 + k * 131) % 1500}]]`).join(" ");
      await a.vault.adapter.write(`Big/Big ${i}.md`, `# Big ${i}\n\n${words[i % 10]} ${links} #group${i % 12}\n`);
    }
    await new Promise((r) => setTimeout(r, 2000));
    await a.commands.executeCommandById("graph:open");
  });
  await settle(page, 6000);
  // Zoom out to show the whole graph.
  await page.mouse.move(900, 500);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(60);
  }
  await settle(page, 1500);
  await shot(page, "13-graph-1500-notes-dark");
  await context.close();
}

await browser.close();
console.log("captured to", out);
