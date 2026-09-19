/**
 * W3 Editor — keyboard-driven regression tests for the editor defects in
 * docs/research/daily-use-audit.md and the daily writing features.
 *
 *   OM_URL=http://localhost:5222 npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/editor.spec.ts
 *
 * Every test types with the real keyboard (page.keyboard) into a note created
 * in the in-memory demo vault; the document is read back through the Editor API.
 */
import { expect, test, type Page } from "@playwright/test";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** Open the demo vault, create `name` with `content`, open it in Live Preview and focus the editor. */
export async function openNote(page: Page, content = "", opts: { name?: string; source?: boolean; config?: Record<string, unknown> } = {}) {
  // A second note in the same test reuses the loaded app (a reload could stop on an unsaved-changes prompt).
  const loaded = await page.evaluate(() => (window as any).app?.metadataCache?.initialized === true).catch(() => false);
  if (!loaded) await page.goto("/?vault=demo");
  await page.waitForSelector(".nav-file-title", { timeout: 30_000 });
  await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true && (window as any).app.workspace.layoutReady === true, null, { timeout: 30_000 });
  const name = opts.name ?? `Test ${Math.random().toString(36).slice(2, 8)}.md`;
  await page.evaluate(
    async ({ name, content, source, config }) => {
      const a = (window as any).app;
      for (const [k, v] of Object.entries(config ?? {})) a.vault.setConfig(k, v);
      const f = await a.vault.create(name, content);
      const leaf = a.workspace.getLeaf(false);
      await leaf.openFile(f, { state: { mode: "source", source: !!source } });
      a.workspace.setActiveLeaf(leaf, { focus: true });
    },
    { name, content, source: !!opts.source, config: opts.config ?? {} },
  );
  await page.waitForSelector(".workspace-leaf.mod-active .cm-content");
  await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.focus());
  return name;
}

export const docText = (page: Page) =>
  page.evaluate(() => {
    const ws = (window as any).app.workspace;
    return ((ws.activeEditor ?? ws.activeLeaf?.view)?.editor?.getValue() ?? null) as string;
  });

/** Put the cursor at (line, ch) — 0-based; ch may be -1 for end of line. */
export async function cursorAt(page: Page, line: number, ch: number) {
  await page.evaluate(
    ({ line, ch }) => {
      const e = (window as any).app.workspace.activeEditor.editor;
      e.focus();
      e.setCursor({ line, ch: ch < 0 ? e.getLine(line).length : ch });
    },
    { line, ch },
  );
}

export const cursor = (page: Page) => page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getCursor());

const settle = (page: Page, ms = 120) => page.waitForTimeout(ms);

// ============================================================================
// [W3:defects] Part 1 — audit defects
// ============================================================================
test.describe("editor defects", () => {
  test("#6 typing ``` gives a three-backtick fence, and Enter closes it", async ({ page }) => {
    await openNote(page, "");
    await page.keyboard.type("```js");
    expect(await docText(page)).toBe("```js");
    await page.keyboard.press("Enter");
    await page.keyboard.type("let a = 1;");
    expect(await docText(page)).toBe("```js\nlet a = 1;\n```");
  });

  test("#10 Mod+Enter opens the link under the cursor in a new tab; elsewhere it toggles the checkbox (Mod+L still toggles)", async ({ page }) => {
    await openNote(page, "See [[Welcome]] here\n- [ ] task\n");
    const leaves = () => page.evaluate(() => (window as any).app.workspace.getLeavesOfType("markdown").length);
    const before = await leaves();
    await cursorAt(page, 0, 8);
    await page.keyboard.press(`${MOD}+Enter`);
    await expect.poll(leaves).toBe(before + 1);
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.basename)).toBe("Welcome");
    // Back to the test note: Mod+Enter on a task line toggles it, Mod+L toggles it back.
    await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("markdown").find((l: any) => /^Test /.test(l.view.file?.basename))?.view.leaf && (window as any).app.workspace.setActiveLeaf((window as any).app.workspace.getLeavesOfType("markdown").find((l: any) => /^Test /.test(l.view.file?.basename)), { focus: true }));
    await cursorAt(page, 1, 8);
    await page.keyboard.press(`${MOD}+Enter`);
    expect((await docText(page)).split("\n")[1]).toBe("- [x] task");
    await page.keyboard.press(`${MOD}+l`);
    expect((await docText(page)).split("\n")[1]).toBe("- [ ] task");
    const hotkeys = await page.evaluate(() => {
      const a = (window as any).app;
      return { leaf: a.hotkeyManager.getHotkeys?.("editor:open-link-in-new-leaf") ?? a.commands.findCommand("editor:open-link-in-new-leaf")?.hotkeys, split: a.commands.findCommand("editor:open-link-in-new-split")?.hotkeys, cycle: a.commands.findCommand("editor:cycle-list-checklist")?.hotkeys };
    });
    expect(JSON.stringify(hotkeys.leaf)).toContain('"Enter"');
    expect(JSON.stringify(hotkeys.leaf)).not.toContain("Alt");
    expect(hotkeys.cycle ?? []).toEqual([]);
  });

  test("#8 Mod+; adds an empty property with its name focused; typing a name and value writes that property", async ({ page }) => {
    await openNote(page, "Body text\n");
    await cursorAt(page, 0, 4);
    await page.keyboard.press(`${MOD}+;`);
    const keyInput = page.locator(".workspace-leaf.mod-active .metadata-property-key-input").last();
    await expect(keyInput).toBeFocused();
    await page.keyboard.type("mood");
    await page.keyboard.press("Enter"); // Enter moves from the name to the value (Tab loses focus: properties widget, W5)
    await page.keyboard.type("calm");
    await page.keyboard.press("Enter");
    await expect.poll(() => docText(page)).toMatch(/^---\nmood: calm\n---\nBody text/);
    expect(await docText(page)).not.toContain("property");
  });

  test("#9 Templates commands use Obsidian's full ids", async ({ page }) => {
    await openNote(page, "");
    const ids = await page.evaluate(() => Object.keys((window as any).app.commands.commands).filter((id) => /insert-(template|current-date|current-time)$/.test(id)));
    expect(ids.sort()).toEqual(["templates:insert-current-date", "templates:insert-current-time", "templates:insert-template"]);
    await page.evaluate(() => (window as any).app.commands.executeCommandById("templates:insert-current-date"));
    expect(await docText(page)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("#11 Tab into a new table row puts the cursor at the start of its first cell", async ({ page }) => {
    await openNote(page, "| 1 | 2 |\n| --- | --- |\n| a | b |\n", { source: true });
    await cursorAt(page, 2, -1);
    await page.keyboard.press("Tab");
    await page.keyboard.type("X");
    expect((await docText(page)).split("\n")[3]).toMatch(/^\| X +\| +\|$/);
    // Tab re-aligns and moves on; a filled cell's content is selected, so typing replaces it.
    await page.keyboard.press("Tab");
    await page.keyboard.type("Y");
    expect((await docText(page)).split("\n")[3]).toMatch(/^\| X {3}\| Y +\|$/);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("Z");
    expect((await docText(page)).split("\n")[3]).toMatch(/^\| Z {3}\| Y {3}\|$/);
  });

  test("#12 a newly indented numbered item renumbers to 1, and Shift+Tab puts it back in sequence", async ({ page }) => {
    await openNote(page, "");
    await page.keyboard.type("1. first");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type("sub");
    expect(await docText(page)).toBe("1. first\n2. second\n\t1. sub");
    await page.keyboard.press("Enter");
    await page.keyboard.type("sub two");
    expect(await docText(page)).toBe("1. first\n2. second\n\t1. sub\n\t2. sub two");
    await page.keyboard.press("Shift+Tab");
    expect(await docText(page)).toBe("1. first\n2. second\n\t1. sub\n3. sub two");
  });

  test("#13 Mod+D (delete paragraph) renumbers the rest of an ordered list", async ({ page }) => {
    await openNote(page, "1. a\n2. b\n3. c\n4. d\n");
    await cursorAt(page, 1, 3);
    await page.keyboard.press(`${MOD}+d`);
    expect(await docText(page)).toBe("1. a\n2. c\n3. d\n");
  });

  test("#14 Backspace right after a nested list marker outdents; at the top level it removes the marker", async ({ page }) => {
    await openNote(page, "- one\n\t- two\n");
    await cursorAt(page, 1, 3);
    await page.keyboard.press("Backspace");
    expect(await docText(page)).toBe("- one\n- two\n");
    await page.keyboard.press("Backspace");
    expect(await docText(page)).toBe("- one\ntwo\n");
    await cursorAt(page, 0, -1);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Backspace");
    expect(await docText(page)).toBe("- one\n\ntwo\n");
    await openNote(page, "- [ ] task\n");
    await cursorAt(page, 0, 6);
    await page.keyboard.press("Backspace");
    expect(await docText(page)).toBe("- task\n");
  });

  test("#15 typing --- and Enter on the first line starts properties with a name field focused", async ({ page }) => {
    await openNote(page, "");
    await page.keyboard.type("---");
    await page.keyboard.press("Enter");
    const keyInput = page.locator(".workspace-leaf.mod-active .metadata-property-key-input").last();
    await expect(keyInput).toBeFocused();
    await page.keyboard.type("status");
    await page.keyboard.press("Enter");
    await page.keyboard.type("draft");
    await page.keyboard.press("Enter");
    await expect.poll(() => docText(page)).toMatch(/^---\nstatus: draft\n---/);
    // Source mode: the fences are written with the cursor between them.
    await openNote(page, "", { source: true });
    await page.keyboard.type("---");
    await page.keyboard.press("Enter");
    await page.keyboard.type("tags: x");
    expect(await docText(page)).toBe("---\ntags: x\n---");
  });

  test("#22 Alt+click adds cursors; Mod+Alt+Down adds a cursor below; Mod+Shift+L selects all occurrences", async ({ page }) => {
    await openNote(page, "alpha\nbeta\ngamma\ndelta\n", { source: true });
    await cursorAt(page, 0, 5);
    const lineBox = async (n: number) => (await page.locator(".workspace-leaf.mod-active .cm-line").nth(n).boundingBox())!;
    for (const n of [1, 2]) {
      const b = await lineBox(n);
      await page.keyboard.down("Alt");
      await page.mouse.click(b.x + b.width - 2, b.y + b.height / 2);
      await page.keyboard.up("Alt");
    }
    await page.evaluate(() => {
      const e = (window as any).app.workspace.activeEditor.editor;
      e.setSelections(e.listSelections().map((s: any) => ({ anchor: { line: s.head.line, ch: e.getLine(s.head.line).length } })));
    });
    await page.keyboard.type("!");
    expect(await docText(page)).toBe("alpha!\nbeta!\ngamma!\ndelta\n");
    await cursorAt(page, 0, 0);
    await page.keyboard.press(`${MOD}+Alt+ArrowDown`);
    expect(await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.listSelections().length)).toBe(2);
    await openNote(page, "cat dog cat bird cat\n", { source: true });
    await cursorAt(page, 0, 1);
    await page.keyboard.press(`${MOD}+Shift+l`);
    expect(await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.listSelections().length)).toBe(3);
  });

  test("#27 pasting list items onto an empty list marker does not duplicate the marker", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openNote(page, "- ");
    await cursorAt(page, 0, 2);
    await page.evaluate(() => navigator.clipboard.writeText("- pasted item\n- second"));
    await page.keyboard.press(`${MOD}+v`);
    expect(await docText(page)).toBe("- pasted item\n- second");
  });

  test("[[ link suggestions show and match a note's display title; the link keeps the file name", async ({ page }) => {
    await openNote(page, "", { config: { displayTitle: "property" } });
    await page.evaluate(async () => {
      const a = (window as any).app;
      const f = await a.vault.create("2026-01-01 log.md", "---\ntitle: Morning routine\n---\nwake up\n");
      for (let i = 0; i < 100 && a.metadataCache.getFileCache(f)?.frontmatter?.title !== "Morning routine"; i++) await new Promise((r) => setTimeout(r, 50));
    });
    await page.keyboard.type("[[Morning rou");
    const item = page.locator(".suggestion-container .suggestion-item").first();
    await expect(item.locator(".suggestion-title")).toHaveText("Morning routine");
    await expect(item.locator(".suggestion-note")).toContainText("2026-01-01 log");
    await page.keyboard.press("Enter");
    expect(await docText(page)).toBe("[[2026-01-01 log]]");
    await page.evaluate(() => (window as any).app.vault.setConfig("displayTitle", "filename"));
  });
  // [/W3:defects]
});

// ============================================================================
// [W3:search-panel] find & replace, footnote hover
// ============================================================================
test.describe("find and replace, footnote hover", () => {
  const panel = (page: Page) => page.locator(".workspace-leaf.mod-active .document-search-container");
  const count = (page: Page) => panel(page).locator(".document-search-count");

  test("#21 Mod+F opens Obsidian's styled search bar with a match counter; Enter/Shift+Enter step; Escape returns to the editor", async ({ page }) => {
    await openNote(page, "apple pie\nbanana\napple tart\nApple juice\n");
    await cursorAt(page, 1, 0);
    await page.keyboard.press(`${MOD}+f`);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator(".document-search .document-search-input input[placeholder='Find...']")).toBeFocused();
    await expect(panel(page).locator(".document-replace")).toBeHidden();
    await expect(panel(page).locator(".document-search-toggle")).toHaveCount(3);
    await page.keyboard.type("apple");
    await expect(count(page)).toHaveText("3 results");
    await page.keyboard.press("Enter");
    await expect(count(page)).toHaveText("2 of 3");
    await page.keyboard.press("Enter");
    await expect(count(page)).toHaveText("3 of 3");
    await page.keyboard.press("Shift+Enter");
    await expect(count(page)).toHaveText("2 of 3");
    expect(await cursor(page)).toEqual({ line: 2, ch: 5 });
    await page.keyboard.press("F3");
    await expect(count(page)).toHaveText("3 of 3");
    // Match case: "Apple juice" drops out.
    await panel(page).locator(".document-search-toggle[aria-label='Match case']").click();
    await expect(panel(page).locator(".document-search-toggle[aria-label='Match case']")).toHaveClass(/is-active/);
    await expect(count(page)).toHaveText(/^(2 results|\d of 2)$/);
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await page.keyboard.type("!");
    expect(await docText(page)).toContain("!");
  });

  test("#21 whole word and regex toggles; no results is shown", async ({ page }) => {
    await openNote(page, "cat catalog cat\ndog\n");
    await page.keyboard.press(`${MOD}+f`);
    await page.keyboard.type("cat");
    await expect(count(page)).toHaveText("3 results");
    await panel(page).locator(".document-search-toggle[aria-label='Match whole word']").click();
    await expect(count(page)).toHaveText("2 results");
    await panel(page).locator(".document-search-input input").fill("d.g");
    await expect(count(page)).toHaveText("No results");
    await panel(page).locator(".document-search-toggle[aria-label='Use regular expression']").click();
    await expect(count(page)).toHaveText("1 result");
  });

  test("#21 Mod+H: Enter in Replace replaces the next match, Mod+Enter replaces all in one undo step", async ({ page }) => {
    await openNote(page, "apple one\napple two\napple three\n");
    await cursorAt(page, 0, 0);
    await page.keyboard.press(`${MOD}+h`);
    await expect(panel(page).locator(".document-replace")).toBeVisible();
    await expect(panel(page).locator(".document-search-input input")).toBeFocused();
    await page.keyboard.type("apple");
    await expect(count(page)).toHaveText("3 results");
    // Mod+H again moves to the Replace field.
    await page.keyboard.press(`${MOD}+h`);
    await expect(panel(page).locator(".document-replace-input input")).toBeFocused();
    await page.keyboard.type("pear");
    await page.keyboard.press("Enter"); // replaces the first match at once (it used to take two presses)
    await expect.poll(() => docText(page)).toBe("pear one\napple two\napple three\n");
    await page.keyboard.press(`${MOD}+Enter`);
    await expect.poll(() => docText(page)).toBe("pear one\npear two\npear three\n");
    await expect(count(page)).toHaveText("No results");
    await page.keyboard.press("Escape");
    await page.keyboard.press(`${MOD}+z`);
    expect(await docText(page)).toBe("pear one\napple two\napple three\n");
  });

  test("#21 the selection prefills the search, and the replace row can be toggled", async ({ page }) => {
    await openNote(page, "alpha beta gamma beta\n");
    await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.setSelection({ line: 0, ch: 6 }, { line: 0, ch: 10 }));
    await page.keyboard.press(`${MOD}+f`);
    await expect(panel(page).locator(".document-search-input input")).toHaveValue("beta");
    await expect(count(page)).toHaveText(/of 2|2 results/);
    await panel(page).locator("button[aria-label='Toggle replace']").click();
    await expect(panel(page).locator(".document-replace")).toBeVisible();
    await expect(panel(page).locator(".document-replace-input input")).toBeFocused();
  });

  test("#19 hovering a footnote ref previews the footnote in Live Preview and Reading view", async ({ page }) => {
    await openNote(page, "Intro line.\n\nA claim[^1] and an aside^[inline note text].\n\n[^1]: The **source** of the claim.\n");
    await cursorAt(page, 0, 0);
    const ref = page.locator(".workspace-leaf.mod-active .cm-content .cm-footref").filter({ hasText: "1" }).first();
    await ref.hover();
    const pop = page.locator(".popover.hover-popover.mod-footnote");
    await expect(pop).toBeVisible();
    await expect(pop).toContainText("The source of the claim.");
    await expect(pop.locator("strong")).toHaveText("source");
    await page.mouse.move(5, 5);
    await expect(pop).toHaveCount(0);
    const inline = page.locator(".workspace-leaf.mod-active .cm-content .cm-footref.cm-inline-footnote").first();
    await inline.hover();
    await expect(pop).toContainText("inline note text");
    await page.mouse.move(5, 5);
    await expect(pop).toHaveCount(0);

    await page.keyboard.press(`${MOD}+e`);
    const sup = page.locator(".workspace-leaf.mod-active .markdown-reading-view sup.footnote-ref").first();
    await sup.hover();
    await expect(pop).toBeVisible();
    await expect(pop).toContainText("The source of the claim.");
    await expect(pop).not.toContainText("↩");
    await page.mouse.move(5, 5);
    await expect(pop).toHaveCount(0);
  });
  // [/W3:search-panel]
});

// ============================================================================
// [W3:toolbar] formatting toolbar, context menu
// ============================================================================
test.describe("formatting toolbar and context menu", () => {
  const bar = (page: Page) => page.locator(".workspace-leaf.mod-active .vault-formatting-toolbar");
  /** Viewport point in the middle of document offset range [from, to). */
  const pointAt = (page: Page, from: number, to: number) =>
    page.evaluate(
      ({ from, to }) => {
        const cm = (window as any).app.workspace.activeEditor.editor.cm;
        const a = cm.coordsAtPos(from, 1), b = cm.coordsAtPos(to, -1);
        return { x: (a.left + b.right) / 2, y: (a.top + a.bottom) / 2 };
      },
      { from, to },
    );

  test("toolbar is off by default; Fixed shows it and Bold wraps the selection", async ({ page }) => {
    await openNote(page, "make this bold\n");
    await expect(page.locator(".vault-formatting-toolbar")).toHaveCount(0);
    await page.evaluate(() => (window as any).app.vault.setConfig("formattingToolbar", "fixed"));
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).locator(".vault-toolbar-button")).toHaveCount(17);
    await cursorAt(page, 0, 10);
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
    await bar(page).locator('[data-command="editor:toggle-bold"]').click();
    expect(await docText(page)).toBe("make this **bold**\n");
    await expect(bar(page).locator('[data-command="editor:toggle-bold"]')).toHaveClass(/is-active/);
    // Focus stayed in the editor: typing replaces the still-selected word.
    await page.keyboard.type("x");
    expect(await docText(page)).toBe("make this **x**\n");
    // Heading dropdown, then Undo from the bar.
    await bar(page).locator('[data-command="editor:set-heading"]').click();
    await page.locator(".menu .menu-item", { hasText: "Heading 2" }).click();
    expect(await docText(page)).toBe("## make this **x**\n");
    await bar(page).locator('[data-command="editor:undo"]').click();
    expect(await docText(page)).toBe("make this **x**\n");
    // Hidden in reading view; removed when turned off.
    await page.keyboard.press(`${MOD}+e`);
    await expect(bar(page)).toBeHidden();
    await page.keyboard.press(`${MOD}+e`);
    await expect(bar(page)).toBeVisible();
    await page.evaluate(() => (window as any).app.vault.setConfig("formattingToolbar", "off"));
    await expect(page.locator(".vault-formatting-toolbar")).toHaveCount(0);
  });

  test("toolbar buttons follow formatting-toolbar.json and step aside for Editing Toolbar", async ({ page }) => {
    await openNote(page, "text\n", { config: { formattingToolbar: "fixed" } });
    await page.evaluate(() => (window as any).app.internalPlugins.getPluginById("formatting-toolbar").instance.setCommandIds(["editor:toggle-italics", "editor:insert-table"]));
    await expect(bar(page).locator(".vault-toolbar-button")).toHaveCount(2);
    await page.evaluate(() => {
      const p = (window as any).app.plugins;
      p.enabledPlugins.add("editing-toolbar");
      p.plugins["editing-toolbar"] = {};
      (window as any).app.workspace.trigger("layout-change");
    });
    await expect(page.locator(".vault-formatting-toolbar")).toHaveCount(0);
  });

  test("On selection: a floating bar appears for a keyboard selection and applies italics", async ({ page }) => {
    await openNote(page, "one two three\n", { config: { formattingToolbar: "selection" } });
    await cursorAt(page, 0, 4);
    await expect(page.locator(".vault-selection-toolbar")).toHaveCount(0);
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
    const floating = page.locator(".workspace-leaf.mod-active .vault-selection-toolbar");
    await expect(floating).toBeVisible();
    await floating.locator('[data-command="editor:toggle-italics"]').click();
    expect(await docText(page)).toBe("one *two* three\n");
    // Collapsing the selection hides it.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".vault-selection-toolbar")).toHaveCount(0);
    // A mouse drag shows it only once the button is released.
    const a = await pointAt(page, 10, 11), b = await pointAt(page, 14, 15);
    await page.mouse.move(a.x - 3, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await expect(page.locator(".vault-selection-toolbar")).toHaveCount(0);
    await page.mouse.up();
    await expect(floating).toBeVisible();
  });

  test("context menu: Format ▸ Bold, Paragraph ▸ Heading, Insert ▸ Table", async ({ page }) => {
    await openNote(page, "alpha beta\n", { config: { spellcheck: false } });
    await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.setSelection({ line: 0, ch: 6 }, { line: 0, ch: 10 }));
    const p = await pointAt(page, 7, 8);
    await page.mouse.click(p.x, p.y, { button: "right" });
    const menu = page.locator(".menu").first();
    await expect(menu).toBeVisible();
    for (const title of ["Cut", "Copy", "Paste", "Paste as plain text", "Select all", "Format", "Paragraph", "Insert", "Add file property"]) {
      await expect(menu.locator(".menu-item-title", { hasText: new RegExp(`^${title}$`) })).toHaveCount(1);
    }
    await menu.locator(".menu-item", { hasText: "Format" }).hover();
    await page.locator(".menu .menu-item", { hasText: /^Bold$/ }).click();
    expect(await docText(page)).toBe("alpha **beta**\n");
    await expect(page.locator(".menu")).toHaveCount(0);

    await page.mouse.click(p.x, p.y, { button: "right" });
    await page.locator(".menu .menu-item", { hasText: "Paragraph" }).hover();
    await page.locator(".menu .menu-item", { hasText: /^Heading 3$/ }).click();
    expect(await docText(page)).toBe("### alpha **beta**\n");

    await cursorAt(page, 0, 0);
    await page.mouse.click(p.x, p.y, { button: "right" });
    await page.locator(".menu .menu-item", { hasText: "Insert" }).hover();
    await page.locator(".menu .menu-item", { hasText: /^Table$/ }).click();
    expect(await docText(page)).toContain("| --- | --- |");
  });

  test("right-click on a word with spellcheck on leaves the browser's spelling menu; Shift+right-click always does", async ({ page }) => {
    await openNote(page, "a mispeled word here\n", { config: { spellcheck: true } });
    await cursorAt(page, 1, 0);
    const word = await pointAt(page, 3, 6);
    // Our menu must not open (the native menu with suggestions does; Playwright cannot see it).
    const prevented = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)!;
      const evt = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 });
      target.dispatchEvent(evt);
      return evt.defaultPrevented;
    }, word);
    expect(prevented).toBe(false);
    await expect(page.locator(".menu")).toHaveCount(0);
    await page.mouse.click(word.x, word.y, { button: "right" });
    await expect(page.locator(".menu")).toHaveCount(0);
    // The setting turns it off: our menu opens on the same word.
    await page.evaluate(() => (window as any).app.vault.setConfig("nativeSpellMenu", false));
    await page.mouse.click(word.x, word.y, { button: "right" });
    await expect(page.locator(".menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as any).app.vault.setConfig("nativeSpellMenu", true));
    // With a real selection of several words, our menu opens…
    await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.setSelection({ line: 0, ch: 2 }, { line: 0, ch: 14 }));
    await page.mouse.click(word.x, word.y, { button: "right" });
    await expect(page.locator(".menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".menu")).toHaveCount(0);
    // …but Shift+right-click still gives the browser's menu.
    await page.keyboard.down("Shift");
    await page.mouse.click(word.x, word.y, { button: "right" });
    await page.keyboard.up("Shift");
    await expect(page.locator(".menu")).toHaveCount(0);
  });

  test("editor:context-menu opens the editor menu at the cursor", async ({ page }) => {
    await openNote(page, "hello\n");
    await cursorAt(page, 0, 2);
    await page.evaluate(() => (window as any).app.commands.executeCommandById("editor:context-menu"));
    await expect(page.locator(".menu .menu-item", { hasText: "Format" })).toBeVisible();
  });
  // [/W3:toolbar]
});

// ============================================================================
// [W3:focus] focus mode, typewriter, zen, word count, goals, cursor memory
// ============================================================================
test.describe("focus, typewriter, word count", () => {
  /** Is the editor line holding the main cursor dimmed? */
  const cursorLineDimmed = (page: Page) =>
    page.evaluate(() => {
      const cm = (window as any).app.workspace.activeEditor.editor.cm;
      const { node } = cm.domAtPos(cm.state.selection.main.head);
      const line = (node.nodeType === 1 ? node : node.parentElement).closest(".cm-line");
      return !!line && (line.classList.contains("cm-dimmed") || !!line.querySelector(".cm-dimmed"));
    });

  test("Mod+Shift+Enter toggles focus mode: chrome hidden, other paragraphs dimmed, Esc exits", async ({ page }) => {
    await openNote(page, "First paragraph line one\nline two\n\nSecond paragraph here.\n\nThird paragraph.\n");
    await cursorAt(page, 3, 4);
    await page.keyboard.press(`${MOD}+Shift+Enter`);
    await expect(page.locator("body")).toHaveClass(/vault-focus-mode/);
    await expect(page.locator(".workspace-ribbon.mod-left")).toBeHidden();
    await expect(page.locator(".status-bar")).toBeHidden();
    await expect(page.locator(".workspace-leaf.mod-active .view-header")).toBeHidden();
    // Para 1 (2 lines), the blank lines, para 3 and the trailing empty line: everything but "Second paragraph".
    await expect(page.locator(".workspace-leaf.mod-active .cm-line.cm-dimmed")).toHaveCount(6);
    expect(await cursorLineDimmed(page)).toBe(false);
    // Moving into the first paragraph moves the focus.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => cursorLineDimmed(page)).toBe(false);
    await expect(page.locator(".workspace-leaf.mod-active .cm-line.cm-dimmed", { hasText: "Second paragraph" })).toHaveCount(1);
    // Typing still works in focus mode.
    await page.keyboard.type("X");
    expect(await docText(page)).toContain("X");
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveClass(/vault-focus-mode/);
    await expect(page.locator(".workspace-leaf.mod-active .cm-dimmed")).toHaveCount(0);
    await expect(page.locator(".status-bar")).toBeVisible();
  });

  test("sentence dimming keeps only the current sentence bright", async ({ page }) => {
    await openNote(page, "First sentence here. Second one is this! Third comes last.\n", { config: { focusDim: "sentence" } });
    await cursorAt(page, 0, 25);
    await page.keyboard.press(`${MOD}+Shift+Enter`);
    const dimmed = page.locator(".workspace-leaf.mod-active .cm-content .cm-line").first().locator(".cm-dimmed");
    await expect(dimmed).toHaveCount(2);
    const texts = await dimmed.allTextContents();
    expect(texts.join("|")).toContain("First sentence here.");
    expect(texts.join("|")).toContain("Third comes last.");
    expect(texts.join("|")).not.toContain("Second one");
    await page.keyboard.press(`${MOD}+Shift+Enter`);
    await expect(dimmed).toHaveCount(0);
  });

  test("typewriter scrolling keeps the typing line near the middle", async ({ page }) => {
    await openNote(page, "", { config: { typewriterScroll: true, typewriterOffset: 50 } });
    for (let i = 0; i < 45; i++) {
      await page.keyboard.type(`Line number ${i} of a long draft`);
      await page.keyboard.press("Enter");
    }
    await page.keyboard.type("the last line");
    await page.waitForTimeout(250);
    const pos = await page.evaluate(() => {
      const cm = (window as any).app.workspace.activeEditor.editor.cm;
      const c = cm.coordsAtPos(cm.state.selection.main.head);
      const box = cm.scrollDOM.getBoundingClientRect();
      return { rel: ((c.top + c.bottom) / 2 - box.top) / cm.scrollDOM.clientHeight, scrollTop: cm.scrollDOM.scrollTop };
    });
    expect(pos.scrollTop).toBeGreaterThan(100);
    expect(Math.abs(pos.rel - 0.5)).toBeLessThan(0.08);
    // Arrow keys keep it centred too.
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(250);
    const rel = await page.evaluate(() => {
      const cm = (window as any).app.workspace.activeEditor.editor.cm;
      const c = cm.coordsAtPos(cm.state.selection.main.head);
      const box = cm.scrollDOM.getBoundingClientRect();
      return ((c.top + c.bottom) / 2 - box.top) / cm.scrollDOM.clientHeight;
    });
    expect(Math.abs(rel - 0.5)).toBeLessThan(0.08);
  });

  test("status bar shows words, characters, reading time and selection counts", async ({ page }) => {
    await openNote(page, "---\ntags: [a]\n---\none two three four five\n");
    const bar = page.locator(".status-bar .plugin-word-count");
    await expect(bar).toContainText("5 words");
    await expect(bar).toContainText("characters");
    await expect(bar.locator(".vault-reading-time")).toHaveText("< 1 min read");
    await cursorAt(page, 3, 0);
    for (let i = 0; i < 7; i++) await page.keyboard.press("Shift+ArrowRight");
    await expect(bar).toContainText("2 of 5 words");
    await expect(bar).toContainText("7 of 24 characters");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.type(" 漢字");
    await expect(bar).toContainText("7 words");
  });

  test("word-goal frontmatter shows progress toward the goal", async ({ page }) => {
    await openNote(page, "---\nword-goal: 10\n---\none two three four five");
    const goal = page.locator(".status-bar .plugin-word-count .vault-word-goal");
    await expect(goal).toBeVisible();
    await expect(goal).toHaveText("5 / 10");
    await expect(goal).not.toHaveClass(/is-complete/);
    await cursorAt(page, 3, -1);
    await page.keyboard.type(" six seven eight nine ten");
    await expect(goal).toHaveText("10 / 10");
    await expect(goal).toHaveClass(/is-complete/);
    // Daily goal counts the words written today.
    await page.evaluate(async () => {
      const p = (window as any).app.internalPlugins.getPluginById("word-count");
      p.instance.options.dailyWordGoal = 20;
      p.instance.plugin.update();
    });
    await expect(page.locator(".status-bar .vault-daily-goal")).toHaveText("Today +5 / 20");
  });

  test("reopening a note after closing its tab restores the cursor and scroll", async ({ page }) => {
    const lines = Array.from({ length: 220 }, (_, i) => `Line ${i} with some words to fill the width`).join("\n");
    const name = await openNote(page, lines);
    await cursorAt(page, 150, 0);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.waitForTimeout(700);
    const before = await page.evaluate(() => {
      const e = (window as any).app.workspace.activeEditor.editor;
      return { cursor: e.getCursor(), scroll: e.cm.scrollDOM.scrollTop };
    });
    expect(before.cursor.line).toBe(151);
    expect(before.scroll).toBeGreaterThan(500);
    await page.keyboard.press(`${MOD}+w`);
    await expect(page.locator(`.workspace-leaf.mod-active .inline-title`, { hasText: name.replace(/\.md$/, "") })).toHaveCount(0);
    await page.locator(`.nav-file-title[data-path="${name}"]`).click();
    await page.waitForSelector(".workspace-leaf.mod-active .cm-content");
    await expect
      .poll(() => page.evaluate(() => (window as any).app.workspace.activeEditor?.editor?.getCursor()))
      .toEqual(before.cursor);
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.activeEditor.editor.cm.scrollDOM.scrollTop)).toBeGreaterThan(before.scroll - 60);
    const scroll = await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.cm.scrollDOM.scrollTop);
    expect(Math.abs(scroll - before.scroll)).toBeLessThan(60);
    // The view's ephemeral state is Obsidian-shaped (what workspace.json persists).
    const eState = await page.evaluate(() => (window as any).app.workspace.activeLeaf.getEphemeralState());
    expect(eState.cursor).toEqual({ from: before.cursor, to: before.cursor });
  });
  // [/W3:focus]
});

// ============================================================================
// [W3:completion] word completion, grammar
// ============================================================================
test.describe("word completion and grammar", () => {
  const popup = (page: Page) => page.locator(".cm-tooltip-autocomplete.vault-word-completion");

  /** A vault note with the vocabulary, then the note under test (source text `content`). */
  async function withVocabulary(page: Page, content = "", config: Record<string, unknown> = { wordCompletion: true }) {
    await page.goto("/?vault=demo");
    await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true, null, { timeout: 30_000 });
    await page.evaluate(() => (window as any).app.vault.create("Vocabulary.md", "Photosynthesis explains photosynthesis. photosynthesis photosynthetic.\n"));
    return openNote(page, content, { config });
  }

  test("word completion is off by default", async ({ page }) => {
    await withVocabulary(page, "", {});
    expect(await page.evaluate(() => (window as any).app.vault.getConfig("wordCompletion") ?? false)).toBe(false);
    await page.keyboard.type("photo");
    await page.waitForTimeout(500);
    await expect(popup(page)).toHaveCount(0);
  });

  test("suggests vault words after three letters; Tab accepts the first, keeping the typed case", async ({ page }) => {
    await withVocabulary(page);
    await page.keyboard.type("Some ph");
    await page.waitForTimeout(300);
    await expect(popup(page)).toHaveCount(0);
    await page.keyboard.type("o");
    await expect(popup(page).locator("li")).toHaveText(["photosynthesis", "photosynthetic"]);
    await page.keyboard.press("Tab");
    await expect(popup(page)).toHaveCount(0);
    expect(await docText(page)).toBe("Some photosynthesis");
    // Capitalised prefix keeps its capital.
    await page.keyboard.type(" Photosyntheti");
    await expect(popup(page).locator("li")).toHaveText(["Photosynthetic"]);
    await page.keyboard.press("Tab");
    expect(await docText(page)).toBe("Some photosynthesis Photosynthetic");
  });

  test("Enter makes a newline unless you arrowed into the list; Escape closes", async ({ page }) => {
    await withVocabulary(page);
    await page.keyboard.type("pho");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.press("Enter");
    expect(await docText(page)).toBe("pho\n");
    await page.keyboard.type("pho");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(await docText(page)).toBe("pho\nphotosynthetic");
    await page.keyboard.type(" pho");
    await expect(popup(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup(page)).toHaveCount(0);
    expect(await docText(page)).toBe("pho\nphotosynthetic pho");
  });

  test("no suggestions inside code, links or tags", async ({ page }) => {
    await withVocabulary(page);
    for (const typed of ["`pho", "#pho", "[[pho"]) {
      await page.keyboard.type(typed);
      await page.waitForTimeout(400);
      await expect(popup(page)).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Enter");
    }
  });

  test("grammar check underlines an issue and applying the suggestion fixes it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/?vault=demo");
    await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true, null, { timeout: 30_000 });
    // Consent to the one-time model download for this device (the setting's dialog does this).
    await page.evaluate(() => (window as any).app.saveLocalStorage("grammar-model-consent", true));
    await openNote(page, "", { config: { grammarCheck: true } });
    await page.keyboard.type("This is an test.");
    const underline = page.locator(".workspace-leaf.mod-active .cm-lint-grammar", { hasText: "an" });
    await expect(underline).toBeVisible({ timeout: 90_000 });
    const pop = page.locator(".cm-tooltip .vault-grammar-tooltip .vault-grammar-popover, .cm-tooltip.vault-grammar-tooltip .vault-grammar-popover");
    // Hovering the underline opens the popover (re-hover if the underline was re-rendered under the pointer).
    await expect(async () => {
      const box = (await underline.boundingBox())!;
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await expect(pop).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 15_000 });
    await expect(pop.locator(".vault-grammar-suggestion").first()).toHaveText("a");
    await pop.locator(".vault-grammar-suggestion").first().click();
    await expect.poll(() => docText(page)).toBe("This is a test.");
    await expect(page.locator(".workspace-leaf.mod-active .cm-lint-grammar")).toHaveCount(0, { timeout: 10_000 });
  });

  test("grammar check skips code and links; Ignore hides an issue; turning it off clears underlines", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/?vault=demo");
    await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true, null, { timeout: 30_000 });
    await page.evaluate(() => (window as any).app.saveLocalStorage("grammar-model-consent", true));
    await openNote(page, "Run `this is an test` and see [[an test note]].\n\nThis is an test.\n", { config: { grammarCheck: true } });
    const lints = page.locator(".workspace-leaf.mod-active .cm-lint-grammar");
    await expect(lints.first()).toBeVisible({ timeout: 90_000 });
    // Only the prose sentence is flagged.
    const flagged = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".workspace-leaf.mod-active .cm-lint-grammar")).map((e) => e.closest(".cm-line")?.textContent),
    );
    expect(flagged.every((t) => t === "This is an test.")).toBe(true);
    await lints.first().click();
    const pop = page.locator(".cm-tooltip .vault-grammar-tooltip .vault-grammar-popover, .cm-tooltip.vault-grammar-tooltip .vault-grammar-popover");
    await expect(pop).toBeVisible();
    await pop.locator("button.mod-ignore").click();
    await expect(lints).toHaveCount(0);
    await page.keyboard.press("End");
    await page.keyboard.type(" It is is fine.");
    await expect(lints.first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => (window as any).app.commands.executeCommandById("editor:toggle-grammar"));
    await expect(lints).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).app.vault.getConfig("grammarCheck"))).toBe(false);
  });
  // [/W3:completion]
});

// ============================================================================
// [W3:tables] tables and typography
// ============================================================================
test.describe("tables and typography", () => {
  const TABLE = "| Name | Qty |\n| --- | --- |\n| pear | 5 |\n| apple | 12 |\n";
  const lines = async (page: Page) => (await docText(page)).split("\n");

  test("Enter moves to the same column of the next row, adds a row after the last, and leaves the table from an empty row", async ({ page }) => {
    await openNote(page, TABLE, { source: true });
    await cursorAt(page, 2, 12); // in "5"
    await page.keyboard.press("Enter");
    expect(await cursor(page)).toMatchObject({ line: 3 });
    // The cell's content is selected: typing replaces it.
    await page.keyboard.type("13");
    expect((await lines(page))[3]).toMatch(/^\| apple +\| 13 +\|$/);
    await page.keyboard.press("Enter");
    const t = await lines(page);
    expect(t[4]).toMatch(/^\| +\| +\|$/);
    await page.keyboard.type("9");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("kiwi");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter"); // empty last row → out of the table
    await page.keyboard.type("after");
    expect(await docText(page)).toBe("| Name  | Qty |\n| ----- | --- |\n| pear  | 5   |\n| apple | 13  |\n| kiwi  | 9   |\nafter\n");
  });

  test("Tab re-aligns columns and Shift+Enter puts a line break in the cell", async ({ page }) => {
    await openNote(page, "| a | b |\n|:-|-:|\n| long text | 1 |\n", { source: true });
    await cursorAt(page, 2, 3);
    await page.keyboard.press("Tab");
    expect(await docText(page)).toBe("| a         |   b |\n| :-------- | --: |\n| long text |   1 |\n");
    await page.keyboard.press("Shift+Enter");
    expect((await lines(page))[2]).toContain("<br>");
  });

  test("the table toolbar appears in a table and sorts, aligns and adds columns", async ({ page }) => {
    await openNote(page, "Intro\n\n" + TABLE + "\nOutro\n");
    await cursorAt(page, 0, 0);
    const bar = page.locator(".workspace-leaf.mod-active .vault-table-toolbar");
    await expect(bar).toHaveCount(0);
    await cursorAt(page, 4, 3); // "pear" row, first column (Live Preview reveals the source)
    await expect(bar).toBeVisible();
    await bar.locator("[data-action=sort-desc]").click();
    expect((await lines(page)).slice(4, 6).map((l) => l.split("|")[1]!.trim())).toEqual(["pear", "apple"]);
    await bar.locator("[data-action=sort-asc]").click();
    expect((await lines(page)).slice(4, 6).map((l) => l.split("|")[1]!.trim())).toEqual(["apple", "pear"]);
    await cursorAt(page, 4, 12);
    await bar.locator("[data-action=align-right]").click();
    expect((await lines(page))[3]).toMatch(/\| -+ \| -+: \|$/);
    await bar.locator("[data-action=col-after]").click();
    expect((await lines(page))[2].split("|").length).toBe(5);
    // Numbers sort numerically.
    await cursorAt(page, 4, 12);
    await page.evaluate(() => (window as any).app.commands.executeCommandById("editor:table-sort-desc"));
    expect((await lines(page)).slice(4, 6).map((l) => l.split("|")[2]!.trim())).toEqual(["12", "5"]);
    await cursorAt(page, 9, 0);
    await expect(bar).toHaveCount(0);
  });

  test("tab-separated cells paste as a Markdown table", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openNote(page, "");
    await page.evaluate(() => navigator.clipboard.writeText("City\tPop\nOslo\t709000\nBergen\t291000\n"));
    await page.keyboard.press(`${MOD}+v`);
    expect(await docText(page)).toBe("| City   | Pop    |\n| ------ | ------ |\n| Oslo   | 709000 |\n| Bergen | 291000 |");
  });

  test("with Advanced Tables enabled, its toolbar replaces ours in Source mode (ours stays in Live Preview)", async ({ page }) => {
    await openNote(page, TABLE, { source: true });
    await page.evaluate(() => {
      const a = (window as any).app;
      a.plugins.enabledPlugins.add("table-editor-obsidian");
      a.plugins.plugins["table-editor-obsidian"] ??= { manifest: { id: "table-editor-obsidian" } };
    });
    await cursorAt(page, 2, 3);
    await expect(page.locator(".workspace-leaf.mod-active .vault-table-toolbar")).toHaveCount(0);
    await openNote(page, TABLE);
    await cursorAt(page, 2, 3);
    await expect(page.locator(".workspace-leaf.mod-active .vault-table-toolbar")).toBeVisible();
    await page.keyboard.press("Tab");
    expect((await lines(page))[2]).toMatch(/^\| pear  \| 5   \|$/);
    await page.evaluate(() => {
      const a = (window as any).app;
      a.plugins.enabledPlugins.delete("table-editor-obsidian");
      delete a.plugins.plugins["table-editor-obsidian"];
    });
  });

  test("smart typography is off by default; on, it curls quotes and makes dashes and ellipses, but not in code", async ({ page }) => {
    await openNote(page, "");
    await page.keyboard.type('say "hi" -- ok...');
    expect(await docText(page)).toBe('say "hi" -- ok...');
    await openNote(page, "", { config: { smartTypography: true } });
    await page.keyboard.type(`"Hello," she said -- it's fine... really --- yes`);
    expect(await docText(page)).toBe("“Hello,” she said – it’s fine… really — yes");
    // Backspace right after a replacement restores what was typed.
    await page.keyboard.type(" wait...");
    await page.keyboard.press("Backspace");
    expect(await docText(page)).toMatch(/ wait\.\.\.$/);
    await page.keyboard.press("Enter");
    await page.keyboard.type("`a \"b\" -- c` and ");
    expect((await lines(page))[1]).toBe('`a "b" -- c` and ');
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("---");
    expect((await lines(page))[3]).toBe("---");
    await page.keyboard.press("Enter");
    await page.keyboard.type("```");
    await page.keyboard.press("Enter");
    await page.keyboard.type('x = "y" -- z');
    expect((await lines(page))[5]).toBe('x = "y" -- z');
    await page.evaluate(() => (window as any).app.vault.setConfig("smartTypography", false));
  });

  test("Backspace inside an empty pair of backticks removes both", async ({ page }) => {
    await openNote(page, "");
    await page.keyboard.type("a `");
    expect(await docText(page)).toBe("a ``");
    await page.keyboard.press("Backspace");
    expect(await docText(page)).toBe("a ");
  });
  // [/W3:tables]
});

void MOD;
void settle;
