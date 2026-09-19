/**
 * W5 Knowledge: note titles, vault-wide search & replace, tag and property
 * wrangling, manual file order, nested properties, trash, periodic notes,
 * calendar, natural-language dates, search keyboard navigation, link tabs and
 * the rename notice.
 *
 * Runs against the in-memory demo vault (`/?vault=demo`), which starts fresh
 * on every load. Screenshots go to $W5_SHOTS (or the test output folder).
 */
import { expect, test, type Page } from "@playwright/test";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function shot(page: Page, name: string) {
  const dir = process.env.W5_SHOTS;
  const path = dir ? `${dir}/${name}.png` : test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
}

async function openDemo(page: Page, opts: { dark?: boolean } = {}) {
  // Vite's dev server reloads the page when other files change; keep it still.
  await page.routeWebSocket(/.*/, () => {});
  if (opts.dark) await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized, null, { timeout: 60_000 });
  if (opts.dark) await page.evaluate(() => (window as any).app.changeTheme?.("obsidian"));
  await page.waitForTimeout(300);
}

async function create(page: Page, files: Record<string, string>) {
  await page.evaluate(async (files) => {
    const app = (window as any).app;
    for (const [path, text] of Object.entries(files)) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
      await app.vault.create(path, text);
    }
  }, files);
  // Let the metadata cache index the new notes.
  await page.waitForFunction(
    (paths) => paths.every((p) => { const app = (window as any).app; const f = app.vault.getFileByPath(p); return !f || f.extension !== "md" || !!app.metadataCache.getFileCache(f); }),
    Object.keys(files),
  );
  await page.waitForTimeout(400);
}

const read = (page: Page, path: string) => page.evaluate((p) => (window as any).app.vault.adapter.read(p), path);

async function openFile(page: Page, path: string) {
  await page.evaluate(async (p) => {
    const app = (window as any).app;
    await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(p), { active: true });
  }, path);
  await page.waitForFunction((p) => (window as any).app.workspace.getActiveFile()?.path === p, path);
}

async function enableCore(page: Page, id: string) {
  await page.evaluate(async (id) => {
    const app = (window as any).app;
    await app.internalPlugins.setEnabled(id, true);
  }, id);
  await page.waitForTimeout(300);
}

async function command(page: Page, id: string) {
  const ok = await page.evaluate((id) => (window as any).app.commands.executeCommandById(id), id);
  expect(ok, `command ${id} ran`).toBeTruthy();
}

test.describe("note titles", () => {
  test("title property and first heading show in explorer, tabs, switcher and search; files keep their names", async ({ page }) => {
    await openDemo(page);
    await create(page, {
      "zz-note.md": "---\ntitle: Aardvark Title\n---\n# Heading One\n\nThe unique marker quokka lives here.\n",
      "Folder/plain.md": "# Plain Heading\n\nquokka again\n",
    });
    await page.evaluate(() => (window as any).app.vault.setConfig("displayTitle", "property"));
    await openFile(page, "zz-note.md");
    await page.waitForTimeout(300);
    const explorer = page.locator('.nav-file-title[data-path="zz-note.md"] .nav-file-title-content');
    await expect(explorer).toHaveText("Aardvark Title");
    await expect(page.locator(".mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title").first()).toHaveText("Aardvark Title");
    // The view header keeps the file name because clicking it renames the file.
    await expect(page.locator(".workspace-leaf.mod-active .view-header-title")).toHaveText("zz-note");
    // Explorer is sorted by what it shows: "Aardvark Title" comes before "Formatting".
    const order = await page.evaluate(() => [...document.querySelectorAll(".nav-folder.mod-root > .nav-folder-children > .nav-file .nav-file-title-content")].map((e) => e.textContent));
    expect(order.indexOf("Aardvark Title")).toBeLessThan(order.indexOf("Formatting"));
    await shot(page, "titles-property");

    // Quick switcher finds the note by title and by path.
    await page.keyboard.press(`${MOD}+o`);
    await page.keyboard.type("aardvark");
    await expect(page.locator(".prompt .suggestion-item").first()).toContainText("Aardvark Title");
    await page.locator(".prompt-input").fill("zz-note");
    await expect(page.locator(".prompt .suggestion-item").first()).toContainText("zz-note");
    await shot(page, "titles-switcher");
    await page.keyboard.press("Escape");

    // First heading mode, in search results too.
    await page.evaluate(() => (window as any).app.vault.setConfig("displayTitle", "heading"));
    await expect(page.locator('.nav-file-title[data-path="Folder/plain.md"] .nav-file-title-content')).toHaveText("Plain Heading", { timeout: 5000 }).catch(async () => {
      await page.evaluate(() => (window as any).app.internalPlugins.getPluginById("file-explorer").instance.revealInFolder((window as any).app.vault.getFileByPath("Folder/plain.md")));
      await expect(page.locator('.nav-file-title[data-path="Folder/plain.md"] .nav-file-title-content')).toHaveText("Plain Heading");
    });
    await expect(explorer).toHaveText("Heading One");
    await page.evaluate(() => (window as any).app.internalPlugins.getPluginById("global-search").instance.openGlobalSearch("quokka"));
    await expect(page.locator(".search-result-file-title .tree-item-inner").filter({ hasText: "Plain Heading" })).toHaveCount(1);

    // Renaming from the explorer edits the file name, not the title.
    await page.evaluate(() => (window as any).app.internalPlugins.getPluginById("file-explorer").instance.revealInFolder((window as any).app.vault.getFileByPath("zz-note.md")));
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const view = (window as any).app.internalPlugins.getPluginById("file-explorer").instance.getExplorerView();
      view.startRename(view.fileItems["zz-note.md"]);
    });
    await expect(page.locator('.nav-file-title[data-path="zz-note.md"] .nav-file-title-content')).toHaveText("zz-note");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => !!(window as any).app.vault.getFileByPath("zz-note.md"))).toBe(true);

    // Back to file names.
    await page.evaluate(() => (window as any).app.vault.setConfig("displayTitle", undefined));
    await expect(explorer).toHaveText("zz-note");
    await expect(page.locator(`.workspace-tab-header .workspace-tab-header-inner-title`, { hasText: "Aardvark" })).toHaveCount(0);
  });
});

test.describe("search", () => {
  test("arrow keys move through results, Enter opens, Mod+Enter opens in a new tab", async ({ page }) => {
    await openDemo(page);
    await create(page, { "K1.md": "wombat one\n\nwombat two\n", "K2.md": "a wombat\n" });
    await page.keyboard.press(`${MOD}+Shift+f`);
    await page.keyboard.type("wombat");
    await expect(page.locator(".search-result-file-title")).toHaveCount(2);
    await page.waitForTimeout(400);
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".search-result-container .has-focus")).toHaveClass(/search-result-file-title/);
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".search-result-container .search-result-file-match.has-focus")).toContainText("wombat one");
    await shot(page, "search-keyboard");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("K1.md");

    const tabsBefore = await page.locator(".mod-root .workspace-tab-header").count();
    await page.keyboard.press(`${MOD}+Shift+f`);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    // Up from the first result goes back to the query; down again and Mod+Enter.
    await expect(page.locator(".global-search-input-container input")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press(`${MOD}+Enter`);
    await expect.poll(() => page.locator(".mod-root .workspace-tab-header").count()).toBe(tabsBefore + 1);
  });

  test("replace in all files: preview with checkboxes, replace selected, snapshot first, undo", async ({ page }) => {
    await openDemo(page);
    await create(page, { "R1.md": "apple pie and apple tart\nno fruit\napple", "R2.md": "Apple crumble\n", "R3.md": "```\napple in code\n```\n" });
    await openFile(page, "R1.md");
    await page.keyboard.press(`${MOD}+Shift+h`);
    await page.keyboard.type("apple");
    await expect(page.locator(".search-result-file-title")).toHaveCount(3);
    await page.locator(".vault-replace-input").fill("pear");
    await expect(page.locator(".vault-replace-match")).toHaveCount(5);
    await expect(page.locator(".vault-replace-match").first().locator(".vault-replace-new")).toHaveText("pear");
    // Keep the match inside the code block and the second apple in R1.
    await page.locator('.search-result:has(.tree-item-inner:text-is("R3")) .vault-replace-checkbox').first().uncheck();
    await page.locator('.search-result:has(.tree-item-inner:text-is("R1")) .vault-replace-match').nth(1).locator(".vault-replace-checkbox").uncheck();
    await expect(page.locator(".vault-replace-selected")).toHaveText("Replace selected (3)");
    await shot(page, "replace-preview");
    await page.locator(".vault-replace-selected").click();
    await expect.poll(() => read(page, "R1.md")).toBe("pear pie and apple tart\nno fruit\npear");
    expect(await read(page, "R2.md")).toBe("pear crumble\n");
    expect(await read(page, "R3.md")).toBe("```\napple in code\n```\n");
    await expect(page.locator(".notice", { hasText: "Replaced 3 matches in 2 files" })).toBeVisible();
    // The open editor shows the new text.
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.activeEditor?.editor?.getValue())).toBe("pear pie and apple tart\nno fruit\npear");
    const snaps = await page.evaluate(async () => {
      const inst = (window as any).app.internalPlugins.getEnabledPluginById("file-recovery");
      return inst ? (await inst.getSnapshots("R2.md")).map((s: any) => s.data) : null;
    });
    if (snaps) expect(snaps).toContain("Apple crumble\n");
    await shot(page, "replace-done");

    await command(page, "global-search:undo-replace");
    await expect.poll(() => read(page, "R1.md")).toBe("apple pie and apple tart\nno fruit\napple");
    expect(await read(page, "R2.md")).toBe("Apple crumble\n");
    expect(await page.evaluate(() => (window as any).app.commands.findCommand("global-search:undo-replace").checkCallback(true))).toBe(false);
  });

  test("regex replace uses capture groups and respects match case", async ({ page }) => {
    await openDemo(page);
    await create(page, { "Dates.md": "due 2026-09-14 and 2025-01-02\nDue 1999-12-31\n" });
    await page.keyboard.press(`${MOD}+Shift+h`);
    await page.keyboard.type("path:Dates /(\\d{4})-(\\d{2})-(\\d{2})/");
    await expect(page.locator(".search-result-file-title")).toHaveCount(1);
    await page.locator(".vault-replace-input").fill("$3.$2.$1");
    await expect(page.locator(".vault-replace-new").first()).toHaveText("14.09.2026");
    await page.locator(".vault-replace-all").click();
    await expect.poll(() => read(page, "Dates.md")).toBe("due 14.09.2026 and 02.01.2025\nDue 31.12.1999\n");

    // Match case on: "due" does not replace "Due".
    await page.locator(".global-search-input-container input").fill("path:Dates due");
    await page.locator(".global-search-input-container .input-right-decorator").click();
    await expect(page.locator(".vault-replace-match")).toHaveCount(1);
    await page.locator(".vault-replace-input").fill("by");
    await page.locator(".vault-replace-all").click();
    await expect.poll(() => read(page, "Dates.md")).toBe("by 14.09.2026 and 02.01.2025\nDue 31.12.1999\n");
  });
});

test.describe("tags and properties", () => {
  test("rename tag renames nested tags and frontmatter, skips code, merges into an existing tag", async ({ page }) => {
    await openDemo(page);
    await create(page, {
      "T1.md": "---\ntags:\n  - proj\n  - proj/alpha\n  - other\n---\nBody #proj and #proj/beta and #project stays.\n\n`#proj in code`\n\n```\n#proj in fence\n```\n",
      "T2.md": "---\ntags: [proj, work]\n---\n#Proj text\n",
      "T3.md": "---\ntags: proj\n---\nplain\n",
      "T4.md": "#work and #proj\n",
    });
    await page.evaluate(() => (window as any).app.commands.executeCommandById("tag-pane:open"));
    const tag = page.locator('.tag-pane-tag[data-tag="proj"]');
    await expect(tag).toBeVisible();
    await tag.click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Rename tag" }).click();
    await expect(page.locator(".vault-rename-tag-modal")).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, "tag-rename-modal");
    await page.locator(".vault-rename-tag-input").fill("work");
    await page.keyboard.press("Enter");
    await expect(page.locator(".modal-title", { hasText: "Merge tags?" })).toBeVisible();
    await page.locator(".modal-button-container button", { hasText: "Merge" }).click();
    await expect.poll(() => read(page, "T4.md")).toBe("#work and #work\n");
    expect(await read(page, "T1.md")).toBe("---\ntags:\n  - work\n  - work/alpha\n  - other\n---\nBody #work and #work/beta and #project stays.\n\n`#proj in code`\n\n```\n#proj in fence\n```\n");
    expect(await read(page, "T2.md")).toBe("---\ntags: [work]\n---\n#work text\n");
    expect(await read(page, "T3.md")).toBe("---\ntags: work\n---\nplain\n");
    await expect(page.locator(".notice", { hasText: "Renamed #proj to #work" })).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator('.tag-pane-tag[data-tag="proj"]')).toHaveCount(0);
    await shot(page, "tag-renamed");
  });

  test("the tags view leaves its menu to Tag Wrangler when that plugin is enabled", async ({ page }) => {
    await openDemo(page);
    await page.evaluate(() => (window as any).app.plugins.enabledPlugins.add("tag-wrangler"));
    await page.evaluate(() => (window as any).app.commands.executeCommandById("tag-pane:open"));
    await page.locator('.tag-pane-tag[data-tag="demo"]').click({ button: "right" });
    await expect(page.locator(".menu-item", { hasText: "Rename tag" })).toHaveCount(0);
  });

  test("property rename, type change and delete across the vault", async ({ page }) => {
    await openDemo(page);
    await create(page, { "P1.md": "---\nstage: 3\nkeep: a\n---\nx\n", "P2.md": "---\nstage: 4\n---\ny\n" });
    await page.evaluate(() => (window as any).app.commands.executeCommandById("properties:open"));
    const row = page.locator('.all-properties-container .tree-item-self[data-property-key="stage"]');
    await expect(row).toBeVisible();
    await row.click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Rename" }).click();
    await page.locator(".modal input[type=text]").fill("phase");
    await page.keyboard.press("Enter");
    await expect.poll(() => read(page, "P1.md")).toBe("---\nphase: 3\nkeep: a\n---\nx\n");
    expect(await read(page, "P2.md")).toBe("---\nphase: 4\n---\ny\n");
    const phase = page.locator('.all-properties-container .tree-item-self[data-property-key="phase"]');
    await expect(phase).toBeVisible();
    await phase.click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Property type" }).hover();
    await page.locator(".menu-item", { hasText: /^Text$/ }).click();
    await expect.poll(() => page.evaluate(() => (window as any).app.metadataTypeManager.getAssignedType?.("phase"))).toBe("text");
    await phase.click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Delete" }).click();
    await page.locator(".modal-button-container button", { hasText: "Delete" }).click();
    await expect.poll(() => read(page, "P2.md")).toBe("y\n");
    expect(await read(page, "P1.md")).toBe("---\nkeep: a\n---\nx\n");
  });

  test("nested properties show as a tree, edit in place and keep every shape", async ({ page }) => {
    await openDemo(page);
    const yaml = "---\nbook:\n  author: Ursula\n  year: 1969\n  series:\n    name: Hainish\n    order: 4\nreviews:\n  - who: A\n    stars: 5\n  - who: B\n    stars: 3\nplain: text\n---\nBody\n";
    await create(page, { "Nested.md": yaml });
    await openFile(page, "Nested.md");
    const book = page.locator('.workspace-leaf.mod-active .metadata-property[data-property-key="book"]');
    await expect(book.locator(".vault-nested-property")).toBeVisible();
    await expect(book.locator("input.vault-nested-key")).toHaveCount(5);
    await expect(page.locator('.workspace-leaf.mod-active .metadata-property[data-property-key="reviews"] .vault-nested-count').first()).toHaveText("2 items");
    await shot(page, "nested-properties");
    // Edit a number in place: it stays a number.
    const year = book.locator('.vault-nested-row[data-key="year"] input.vault-nested-input');
    await year.fill("1970");
    await year.press("Enter");
    await expect.poll(() => read(page, "Nested.md")).toContain("year: 1970");
    const text = await read(page, "Nested.md");
    expect(text).toContain("series:\n    name: Hainish\n    order: 4");
    expect(text).toContain("reviews:\n  - who: A\n    stars: 5\n  - who: B\n    stars: 3");
    expect(text).toContain("plain: text");
    // Collapse a branch.
    await book.locator(".vault-nested-summary").first().click();
    await expect(book.locator(".vault-nested-rows")).toHaveCount(0);
  });
});

test.describe("file explorer custom order", () => {
  test("drag to reorder is kept in .obsidian/file-explorer.json and follows renames", async ({ page }) => {
    await openDemo(page);
    await create(page, { "Order/a.md": "", "Order/b.md": "", "Order/c.md": "" });
    await page.evaluate(() => {
      const inst = (window as any).app.internalPlugins.getPluginById("file-explorer").instance;
      inst.revealInFolder((window as any).app.vault.getFileByPath("Order/a.md"));
    });
    await page.locator(".nav-files-container").focus();
    await page.locator(".workspace-leaf-content[data-type='file-explorer'] .nav-action-button[aria-label='Change sort order']").click();
    await page.locator(".menu-item", { hasText: "Custom order" }).click();
    const names = () => page.evaluate(() => [...document.querySelectorAll('.nav-folder-title[data-path="Order"] + .nav-folder-children .nav-file-title-content')].map((e) => e.textContent));
    await expect.poll(names).toEqual(["a", "b", "c"]);
    const c = page.locator('.nav-file-title[data-path="Order/c.md"]');
    const a = page.locator('.nav-file-title[data-path="Order/a.md"]');
    await c.dragTo(a, { targetPosition: { x: 20, y: 2 } });
    await expect.poll(names).toEqual(["c", "a", "b"]);
    await shot(page, "custom-order");
    expect(JSON.parse(await read(page, ".obsidian/file-explorer.json")).manualOrder.Order).toEqual(["c.md", "a.md", "b.md"]);
    await page.evaluate(() => (window as any).app.fileManager.renameFile((window as any).app.vault.getFileByPath("Order/a.md"), "Order/z.md"));
    await expect.poll(names).toEqual(["c", "z", "b"]);
    // The layout remembers the sort order.
    expect(await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("file-explorer")[0].view.getState().sortOrder)).toBe("custom");
  });
});

test.describe("trash", () => {
  test("deleted files can be restored to their folder, deleted permanently, or emptied", async ({ page }) => {
    await openDemo(page);
    await create(page, { "Keep/one.md": "one body", "two.md": "two body", "three.md": "three" });
    await page.evaluate(async () => {
      const app = (window as any).app;
      app.vault.setConfig("trashOption", "local");
      for (const p of ["Keep/one.md", "two.md", "three.md"]) await app.fileManager.trashFile(app.vault.getFileByPath(p));
    });
    await page.waitForTimeout(300);
    await command(page, "trash:open");
    const items = page.locator(".vault-trash-item");
    await expect(items).toHaveCount(3);
    await expect(page.locator(".vault-trash-item", { hasText: "one" }).first().locator(".vault-trash-meta")).toContainText("from Keep");
    await page.locator(".vault-trash-item", { hasText: "two" }).locator(".vault-trash-item-self").click();
    await expect(page.locator(".vault-trash-preview")).toHaveText("two body");
    await shot(page, "trash-view");

    await page.locator('.vault-trash-item[data-path=".trash/one.md"] .vault-trash-restore').click();
    await expect.poll(() => page.evaluate(() => !!(window as any).app.vault.getFileByPath("Keep/one.md"))).toBe(true);
    expect(await read(page, "Keep/one.md")).toBe("one body");
    await expect(items).toHaveCount(2);

    await page.locator('.vault-trash-item[data-path=".trash/two.md"] .vault-trash-delete').click();
    await page.locator(".modal-button-container button", { hasText: "Delete" }).click();
    await expect(items).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).app.vault.adapter.exists(".trash/two.md"))).toBe(false);

    await page.locator(".vault-trash-empty-button").click();
    await page.locator(".modal-button-container button", { hasText: "Empty trash" }).click();
    await expect(page.locator(".vault-trash-empty-state")).toBeVisible();
  });
});

test.describe("periodic notes and calendar", () => {
  test("weekly, monthly, quarterly and yearly notes use Periodic Notes' settings shape and command ids", async ({ page }) => {
    await openDemo(page);
    await create(page, { "Templates/Week.md": "# Week of {{monday:YYYY-MM-DD}}\n" });
    await enableCore(page, "periodic-notes");
    await page.evaluate(async () => {
      const inst = (window as any).app.internalPlugins.getPluginById("periodic-notes").instance;
      inst.options.weekly = { enabled: true, format: "gggg-[W]ww", folder: "Weekly", template: "Templates/Week" };
      inst.options.quarterly.enabled = true;
      inst.options.yearly.enabled = true;
      await inst.saveOptions();
    });
    await command(page, "periodic-notes:open-weekly-note");
    const weekly = await page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path);
    expect(weekly).toMatch(/^Weekly\/\d{4}-W\d{2}\.md$/);
    await expect.poll(() => read(page, weekly)).toMatch(/^# Week of \d{4}-\d{2}-\d{2}\n$/);
    await command(page, "periodic-notes:open-monthly-note");
    expect(await page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toMatch(/^\d{4}-\d{2}\.md$/);
    await command(page, "periodic-notes:open-quarterly-note");
    expect(await page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toMatch(/^\d{4}-Q[1-4]\.md$/);
    await command(page, "periodic-notes:open-next-yearly-note");
    const year = new Date().getFullYear();
    expect(await page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe(`${year + 1}.md`);
    await command(page, "periodic-notes:prev-yearly-note");
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe(`${year + 1}.md`);
    const saved = JSON.parse(await read(page, ".obsidian/periodic-notes.json"));
    expect(saved.weekly).toEqual({ enabled: true, format: "gggg-[W]ww", folder: "Weekly", template: "Templates/Week" });
    expect(Object.keys(saved)).toEqual(expect.arrayContaining(["daily", "weekly", "monthly", "quarterly", "yearly"]));

    // With the community plugin enabled the commands step aside.
    await page.evaluate(() => (window as any).app.plugins.enabledPlugins.add("periodic-notes"));
    expect(await page.evaluate(() => (window as any).app.commands.findCommand("periodic-notes:open-weekly-note").checkCallback(true))).toBe(false);
  });

  test("calendar shows the month with dots for daily notes and opens or creates notes", async ({ page }) => {
    await openDemo(page);
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const iso = await page.evaluate(() => (window as any).moment().subtract(1, "day").format("YYYY-MM-DD"));
    await create(page, { [`Daily/${iso}.md`]: words });
    await page.evaluate(async () => {
      const inst = (window as any).app.internalPlugins.getPluginById("daily-notes").instance;
      inst.options.folder = "Daily";
      await inst.saveOptions();
    });
    await enableCore(page, "calendar");
    await page.evaluate(async () => {
      const inst = (window as any).app.internalPlugins.getPluginById("calendar").instance;
      inst.options.showWeeklyNote = true;
      await inst.saveOptions();
    });
    await command(page, "calendar:show-calendar-view");
    const view = page.locator(".vault-calendar-view");
    await expect(view.locator("table.calendar")).toBeVisible();
    await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("calendar-view")[0].view.render());
    const day = view.locator(`.day[data-date="${iso}"]`);
    await expect(day).toHaveClass(/has-note/);
    await expect(day.locator(".dot")).toHaveCount(2);
    await expect(view.locator(".day.today")).toHaveCount(1);
    await expect(view.locator(".week-num-cell").first()).toBeVisible();
    await shot(page, "calendar");

    await day.click();
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe(`Daily/${iso}.md`);
    await expect(view.locator(`.day[data-date="${iso}"]`)).toHaveClass(/active/);

    const future = await page.evaluate(() => (window as any).moment().add(2, "day").format("YYYY-MM-DD"));
    const futureDay = view.locator(`.day[data-date="${future}"]`);
    if (await futureDay.count()) {
      await futureDay.click();
      await expect(page.locator(".modal-title", { hasText: "New note" })).toBeVisible();
      await page.locator(".modal-button-container button", { hasText: "Create" }).click();
      await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe(`Daily/${future}.md`);
    }
  });
});

test.describe("natural language dates", () => {
  test("@tomorrow inserts a link named with the daily note format; Shift+Enter inserts text", async ({ page }) => {
    await openDemo(page);
    await enableCore(page, "natural-dates");
    await create(page, { "Plan.md": "" });
    await openFile(page, "Plan.md");
    await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.focus());
    await page.keyboard.type("Call on @tom");
    await expect(page.locator(".suggestion-container .vault-date-suggestion").first()).toContainText("Tomorrow");
    await shot(page, "natural-dates");
    await page.keyboard.press("Enter");
    const tomorrow = await page.evaluate(() => (window as any).moment().add(1, "day").format("YYYY-MM-DD"));
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getValue())).toBe(`Call on [[${tomorrow}]]`);
    await page.keyboard.type(" and @next monday");
    await expect(page.locator(".suggestion-container .vault-date-suggestion").first()).toContainText("Next monday", { ignoreCase: true });
    await page.keyboard.press("Shift+Enter");
    const value = await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getValue());
    expect(value).toMatch(new RegExp(`^Call on \\[\\[${tomorrow}\\]\\] and \\d{4}-\\d{2}-\\d{2}$`));
    const parsed = await page.evaluate(() => {
      const inst = (window as any).app.internalPlugins.getPluginById("natural-dates").instance;
      const ref = (window as any).moment();
      return ["today", "yesterday", "in 3 days", "2 weeks ago", "next week", "sep 20 2026"].map((t) => inst.parseDate(t)?.format("YYYY-MM-DD") ?? null).concat(ref.format("YYYY-MM-DD"));
    });
    expect(parsed.every((p: string | null) => p !== null)).toBe(true);
    expect(parsed[5]).toBe("2026-09-20");
  });

  test("off by default, and quiet when the Natural Language Dates plugin is enabled", async ({ page }) => {
    await openDemo(page);
    expect(await page.evaluate(() => !!(window as any).app.internalPlugins.getEnabledPluginById("natural-dates"))).toBe(false);
    await enableCore(page, "natural-dates");
    await page.evaluate(() => (window as any).app.plugins.enabledPlugins.add("nldates-obsidian"));
    await create(page, { "Quiet.md": "" });
    await openFile(page, "Quiet.md");
    await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.focus());
    await page.keyboard.type("@tod");
    await page.waitForTimeout(300);
    await expect(page.locator(".vault-date-suggestion")).toHaveCount(0);
  });
});

test.describe("navigation settings", () => {
  test("open links in a new tab, and switch to a tab that already shows the note", async ({ page }) => {
    await openDemo(page);
    await page.evaluate(() => (window as any).app.vault.setConfig("openLinksInNewTab", true));
    await openFile(page, "Welcome.md");
    const tabs = () => page.locator(".mod-root .workspace-tab-header").count();
    const before = await tabs();
    await page.evaluate(() => (window as any).app.workspace.openLinkText("Formatting", "Welcome.md", false));
    await expect.poll(tabs).toBe(before + 1);
    expect(await page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Formatting.md");
    // Back to Welcome's tab, then the same link again focuses the open Formatting tab.
    await page.locator(".mod-root .workspace-tab-header", { hasText: "Welcome" }).click();
    await page.evaluate(() => (window as any).app.workspace.openLinkText("Formatting", "Welcome.md", false));
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Formatting.md");
    expect(await tabs()).toBe(before + 1);
    // Setting off: the current tab is reused.
    await page.evaluate(() => (window as any).app.vault.setConfig("openLinksInNewTab", undefined));
    await page.evaluate(() => (window as any).app.workspace.openLinkText("Linking notes", "Formatting.md", false));
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Linking notes.md");
    expect(await tabs()).toBe(before + 1);
  });

  test("the settings rows are in Files and links", async ({ page }) => {
    await openDemo(page);
    await page.keyboard.press(`${MOD}+,`);
    await page.locator(".vertical-tab-nav-item", { hasText: /^Files and links$/ }).click();
    await expect(page.locator(".setting-item-name", { hasText: "Show note title from" })).toBeVisible();
    await expect(page.locator(".setting-item-name", { hasText: "Open links in a new tab" })).toBeVisible();
    await page.locator(".setting-item", { hasText: "Show note title from" }).locator("select").selectOption("property");
    await expect(page.locator(".setting-item-name", { hasText: "Title property" })).toBeVisible();
    await page.locator(".setting-item", { hasText: "Show note title from" }).scrollIntoViewIfNeeded();
    await shot(page, "settings-files-links");
    expect(await page.evaluate(() => (window as any).app.vault.getConfig("displayTitle"))).toBe("property");
  });

  test("quick switcher lists recent files when the query is empty", async ({ page }) => {
    await openDemo(page);
    await openFile(page, "Formatting.md");
    await openFile(page, "Linking notes.md");
    await page.keyboard.press(`${MOD}+o`);
    // The open note first, then the one before it, so ↓ ↵ flips back.
    await expect(page.locator(".prompt .suggestion-item").nth(0)).toContainText("Linking notes");
    await expect(page.locator(".prompt .suggestion-item").nth(1)).toContainText("Formatting");
    await page.keyboard.press("Escape");
  });

  test("a failed rename shows one notice", async ({ page }) => {
    await openDemo(page);
    await create(page, { "Dup A.md": "a", "Dup B.md": "b" });
    const errors = await page.evaluate(async () => {
      const app = (window as any).app;
      const file = app.vault.getFileByPath("Dup A.md");
      const results = await Promise.allSettled([app.fileManager.renameFile(file, "Dup B.md"), app.fileManager.renameFile(file, "Dup B.md")]);
      return results.filter((r) => r.status === "rejected").length;
    });
    expect(errors).toBe(1);
    // Explorer rename onto an existing name: Enter then blur, one notice.
    await page.evaluate(() => {
      const app = (window as any).app;
      const inst = app.internalPlugins.getPluginById("file-explorer").instance;
      inst.revealInFolder(app.vault.getFileByPath("Dup A.md"));
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const view = (window as any).app.internalPlugins.getPluginById("file-explorer").instance.getExplorerView();
      view.startRename(view.fileItems["Dup A.md"]);
    });
    await page.keyboard.press(`${MOD}+a`);
    await page.keyboard.type("Dup B");
    await page.keyboard.press("Enter");
    await page.locator(".workspace-leaf-content[data-type='empty'], .mod-root").first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    await expect(page.locator(".notice", { hasText: "already a file" })).toHaveCount(1);
  });
});

test.describe("screens", () => {
  test("dark theme: replace preview, calendar, trash", async ({ page }) => {
    await openDemo(page, { dark: true });
    await page.evaluate(() => document.body.removeClass("theme-light") || document.body.addClass("theme-dark"));
    await create(page, { "R1.md": "apple pie\n", "Daily/2026-09-10.md": "hello world" });
    await page.keyboard.press(`${MOD}+Shift+h`);
    await page.keyboard.type("apple");
    await page.locator(".vault-replace-input").fill("pear");
    await expect(page.locator(".vault-replace-match")).toHaveCount(1);
    await enableCore(page, "calendar");
    await command(page, "calendar:show-calendar-view");
    await page.waitForTimeout(400);
    await shot(page, "dark-replace-calendar");
    await page.evaluate(async () => {
      const app = (window as any).app;
      await app.fileManager.trashFile(app.vault.getFileByPath("R1.md"));
    });
    await command(page, "trash:open");
    await expect(page.locator(".vault-trash-item")).toHaveCount(1);
    await shot(page, "dark-trash");
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("trash, calendar and nested properties fit a phone screen", async ({ page }) => {
    await openDemo(page);
    await create(page, { "Gone.md": "bye", "Nested.md": "---\nbook:\n  author: Ursula\n  year: 1969\n---\nBody\n" });
    await page.evaluate(async () => {
      const app = (window as any).app;
      await app.fileManager.trashFile(app.vault.getFileByPath("Gone.md"));
    });
    await command(page, "trash:open");
    await expect(page.locator(".vault-trash-item")).toHaveCount(1);
    await page.waitForTimeout(400);
    await shot(page, "phone-trash");
    await openFile(page, "Nested.md");
    await page.waitForTimeout(400);
    await shot(page, "phone-nested");
    await enableCore(page, "calendar");
    await command(page, "calendar:show-calendar-view");
    await page.waitForTimeout(600);
    await shot(page, "phone-calendar");
  });
});
