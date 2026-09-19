// obsidian-icon-folder (Iconize): right-click a folder in the file explorer →
// "Change icon" → search the picker → choose an icon → the folder title shows
// it, it survives a re-render of the explorer, and "Remove icon" takes it away.
export default {
  plugins: ["obsidian-icon-folder"],
  async run({ page, check, shot }) {
    const folder = page.locator('.nav-folder-title[data-path="Books"]');
    await folder.click({ button: "right" });
    await page.waitForTimeout(400);
    const items = await page.locator(".menu .menu-item-title").allTextContents();
    check.ok("folder menu has Change icon", items.includes("Change icon"), items.join(" | "));
    await page.locator(".menu .menu-item").filter({ hasText: "Change icon" }).click();
    await page.waitForTimeout(600);
    const input = page.locator(".prompt input.prompt-input, .modal input").first();
    check.ok("icon picker opens", (await input.count()) === 1);
    await input.fill("book");
    await page.waitForTimeout(800);
    const suggestions = page.locator(".prompt-results .suggestion-item, .iconize-icon-preview");
    const n = await suggestions.count();
    check.ok("picker lists matching icons with previews", n > 0 && (await page.locator(".prompt-results svg").count()) > 0, `${n} results`);
    await shot("picker");
    await page.locator(".prompt-results .suggestion-item").first().click();
    await page.waitForTimeout(800);
    const icon = page.locator('.nav-folder-title[data-path="Books"] .iconize-icon svg');
    check.ok("folder title shows the icon", (await icon.count()) === 1);
    const saved = await page.evaluate(() => window.app.plugins.plugins["obsidian-icon-folder"].getData?.()?.Books ?? window.app.plugins.plugins["obsidian-icon-folder"].data?.Books);
    check.ok("icon saved in plugin data", !!saved, saved);
    await shot("explorer");
    // Collapse and expand the root / re-render: icon must come back.
    await page.locator('.nav-folder-title[data-path="Projects"]').click();
    await page.waitForTimeout(400);
    await page.locator('.nav-folder-title[data-path="Books"]').click();
    await page.waitForTimeout(400);
    check.ok("icon survives expanding the folder", (await icon.count()) === 1);
    await folder.click({ button: "right" });
    await page.waitForTimeout(400);
    await page.locator(".menu .menu-item").filter({ hasText: "Remove icon" }).click();
    await page.waitForTimeout(600);
    check.ok("Remove icon removes it", (await icon.count()) === 0);
  },
};
