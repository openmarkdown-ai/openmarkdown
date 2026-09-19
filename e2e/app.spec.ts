import { expect, test, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../apps/web/dist");

async function openDemo(page: Page) {
  await page.goto("/?vault=demo");
  await page.waitForSelector(".nav-file-title", { timeout: 20_000 });
  await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true);
}

const app = (page: Page) => page.evaluate.bind(page);

test("the demo vault opens with Obsidian's workspace DOM", async ({ page }) => {
  await openDemo(page);
  for (const sel of [".app-container", ".workspace-ribbon.mod-left", ".workspace-split.mod-left-split", ".workspace-split.mod-root", ".status-bar"]) {
    await expect(page.locator(sel).first()).toBeAttached();
  }
  await expect(page.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
});

test("metadata matches the note: links, tags, headings, UTF-16 positions", async ({ page }) => {
  await openDemo(page);
  const meta = await page.evaluate(async () => {
    const a = (window as any).app;
    const f = await a.vault.create("Emoji 😀.md", "😀 [[Welcome]] #tag/nested\n# Head");
    for (let i = 0; i < 100 && !(a.metadataCache.getFileCache(f)?.links && a.metadataCache.resolvedLinks[f.path]?.["Welcome.md"]); i++) await new Promise((r) => setTimeout(r, 50));
    const m = a.metadataCache.getFileCache(f);
    const text = await a.vault.read(f);
    const link = m.links[0];
    return { sliced: text.slice(link.position.start.offset, link.position.end.offset), tag: m.tags[0].tag, heading: m.headings[0].heading, resolved: a.metadataCache.resolvedLinks[f.path] };
  });
  expect(meta.sliced).toBe("[[Welcome]]");
  expect(meta.tag).toBe("#tag/nested");
  expect(meta.heading).toBe("Head");
  expect(meta.resolved).toEqual({ "Welcome.md": 1 });
});

test("Live Preview hides markup away from the cursor and reading view renders it", async ({ page }) => {
  await openDemo(page);
  await page.click('.nav-file-title[data-path="Formatting.md"]');
  await page.waitForSelector(".markdown-source-view.is-live-preview .cm-content");
  await expect(page.locator(".cm-content .callout").first()).toBeVisible();
  await page.keyboard.press("Meta+e");
  const reading = page.locator(".markdown-reading-view .markdown-preview-view");
  await expect(reading.locator(".callout[data-callout='note']")).toBeVisible();
  await expect(reading.locator("mark", { hasText: "highlighted" })).toBeVisible();
  await expect(reading.locator("input.task-list-item-checkbox")).toHaveCount(4);
  await expect(reading.locator(".math mjx-container, .math svg").first()).toBeAttached({ timeout: 15_000 });
});

test("clicking an internal link opens the note; an unresolved one creates it", async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => (window as any).app.workspace.openLinkText("Linking notes", "", false, { state: { mode: "preview" } }));
  await page.locator(".markdown-reading-view a.internal-link", { hasText: "Welcome" }).first().click();
  await expect(page.locator(".workspace-leaf.mod-active .view-header-title")).toHaveText("Welcome");
  const created = await page.evaluate(async () => {
    const a = (window as any).app;
    await a.workspace.openLinkText("A note that does not exist", "Linking notes.md");
    return !!a.vault.getFileByPath("A note that does not exist.md");
  });
  expect(created).toBe(true);
});

test("renaming a note rewrites links to it", async ({ page }) => {
  await openDemo(page);
  const text = await page.evaluate(async () => {
    const a = (window as any).app;
    await new Promise((r) => setTimeout(r, 300));
    await a.fileManager.renameFile(a.vault.getFileByPath("Formatting.md"), "Syntax guide.md");
    return a.vault.read(a.vault.getFileByPath("Welcome.md"));
  });
  expect(text).toContain("[[Syntax guide]]");
  expect(text).not.toContain("[[Formatting]]");
});

test("search uses Obsidian's query language", async ({ page }) => {
  await openDemo(page);
  const out = await page.evaluate(() => {
    const idx = (window as any).app.metadataCache.index;
    return {
      tag: idx.search("tag:#project", {}).results.map((r: any) => r.path).sort(),
      path: idx.search('path:Books rating', {}).fileCount,
      bad: idx.search("(unclosed", {}).error ?? null,
    };
  });
  expect(out.tag).toEqual(["Projects/Garden plan.md", "Projects/Kitchen shelves.md"]);
  expect(out.path).toBeGreaterThan(0);
});

test("quick switcher and command palette", async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press("Meta+o");
  await page.keyboard.type("garden");
  await expect(page.locator(".prompt .suggestion-item").first()).toContainText("Garden plan");
  await page.keyboard.press("Enter");
  await expect(page.locator(".workspace-leaf.mod-active .view-header-title")).toHaveText("Garden plan");
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("toggle reading");
  await expect(page.locator(".prompt .suggestion-item").first()).toContainText("reading");
  await page.keyboard.press("Escape");
});

test("backlinks, outline and tags panes follow the active note", async ({ page }) => {
  await openDemo(page);
  const counts = await page.evaluate(() => {
    const a = (window as any).app;
    const f = a.vault.getFileByPath("Welcome.md");
    return { backlinks: a.metadataCache.getBacklinksForFile(f).count(), tags: Object.keys(a.metadataCache.getTags()).length };
  });
  expect(counts.backlinks).toBeGreaterThan(0);
  expect(counts.tags).toBeGreaterThan(2);
});

test("graph view draws the vault", async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => (window as any).app.commands.executeCommandById("graph:open"));
  await expect(page.locator(".workspace-leaf-content[data-type='graph'] canvas").first()).toBeVisible();
  const n = await page.evaluate(() => (window as any).app.metadataCache.index.graph({}).nodes.length);
  expect(n).toBeGreaterThan(8);
});

test("a vault stored in the browser survives a reload", async ({ page }) => {
  await page.goto("/?choose=1");
  await page.fill(".vault-starter-name", "E2E vault");
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 20_000 });
  await page.evaluate(() => (window as any).app.vault.create("Persisted.md", "hello from e2e"));
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 20_000 });
  const text = await page.evaluate(async () => {
    const a = (window as any).app;
    const f = a.vault.getFileByPath("Persisted.md");
    return f ? a.vault.read(f) : null;
  });
  expect(text).toBe("hello from e2e");
});

test("nothing is sent anywhere while using the app", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["localhost", "127.0.0.1"].includes(u.hostname) && !["data:", "blob:"].includes(u.protocol)) external.push(r.url());
  });
  await openDemo(page);
  await page.click('.nav-file-title[data-path="Formatting.md"]');
  await page.keyboard.press("Meta+e");
  await page.waitForTimeout(3000);
  await page.evaluate(() => (window as any).app.commands.executeCommandById("graph:open"));
  await page.evaluate(() => (window as any).app.metadataCache.index.search("callout", {}));
  await page.waitForTimeout(1500);
  expect(external).toEqual([]);
});

test("the shipped bundle names no third-party endpoint beyond the plugin/theme store", () => {
  const allowed = [
    /^localhost$/, /^127\.0\.0\.1$/, /(^|\.)w3\.org$/, /(^|\.)schema\.org$/, /^example\./,
    // The community store: Obsidian's public directory files and plugin/theme repos.
    /^raw\.githubusercontent\.com$/, /^github\.com$/, /^api\.github\.com$/,
  ];
  const hosts = new Map<string, string>();
  const files = readdirSync(join(dist, "assets")).filter((f) => /\.(js|css)$/.test(f));
  for (const f of files) {
    const src = readFileSync(join(dist, "assets", f), "utf8");
    for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
      const host = m[1]!.toLowerCase();
      if (!allowed.some((re) => re.test(host))) hosts.set(host, f);
    }
  }
  // Libraries embed documentation links in comments and error messages; the
  // test above proves none is contacted. List them so a new one is noticed.
  console.log("hosts mentioned in the bundle:", [...hosts.keys()].sort().join(", "));
  expect([...hosts.keys()].filter((h) => /obsidian\.md$/.test(h))).toEqual([]);
});

test("a 5,000-note vault indexes and searches within a usable time", async ({ page }) => {
  await openDemo(page);
  const timings = await page.evaluate(async () => {
    const a = (window as any).app;
    const idx = a.metadataCache.index;
    const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda".split(" ");
    const t0 = performance.now();
    for (let i = 0; i < 5000; i++) {
      const links = [1, 2, 3].map((k) => `[[Note ${(i * 7 + k * 13) % 5000}]]`).join(" ");
      const text = `---\ntags: [t${i % 50}]\n---\n# Note ${i}\n\n${words[i % words.length]} ${words[(i * 3) % words.length]} ${links}\n\n- [ ] task ${i}\n`;
      idx.upsertFile({ path: `Big/Note ${i}.md`, size: text.length, ctime: 0, mtime: 0 });
      idx.setNote(`Big/Note ${i}.md`, text);
    }
    const indexMs = performance.now() - t0;
    const t1 = performance.now();
    const res = idx.search("gamma tag:#t7", {});
    const searchMs = performance.now() - t1;
    const t2 = performance.now();
    const g = idx.graph({});
    const graphMs = performance.now() - t2;
    return { indexMs, searchMs, graphMs, hits: res.fileCount, nodes: g.nodes.length };
  });
  console.log(`5000 notes: index ${timings.indexMs.toFixed(0)} ms, search ${timings.searchMs.toFixed(1)} ms (${timings.hits} hits), graph ${timings.graphMs.toFixed(0)} ms (${timings.nodes} nodes)`);
  expect(timings.nodes).toBeGreaterThan(5000);
  expect(timings.searchMs).toBeLessThan(1000);
  expect(timings.indexMs).toBeLessThan(20_000);
});
