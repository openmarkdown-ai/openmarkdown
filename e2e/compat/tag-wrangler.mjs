// tag-wrangler: right-click a tag in the core tag pane → "Rename #demo" → type
// a new name → every note's body tags and frontmatter `tags` are rewritten.
export default {
  plugins: ["tag-wrangler"],
  async run({ page, check, shot }) {
    await page.evaluate(() => window.app.commands.executeCommandById("tag-pane:open"));
    await page.waitForTimeout(800);
    const tag = page.locator(".tag-pane-tag").filter({ has: page.locator(".tag-pane-tag-text", { hasText: /^demo$/ }) }).first();
    check.ok("tag pane lists #demo", (await tag.count()) === 1);
    await tag.click({ button: "right" });
    await page.waitForTimeout(500);
    const items = await page.locator(".menu .menu-item-title").allTextContents();
    check.ok("context menu has tag-wrangler items", items.some((t) => /Rename #demo/.test(t)), items.join(" | "));
    await shot("menu");
    await page.locator(".menu .menu-item").filter({ hasText: "Rename #demo" }).click();
    await page.waitForTimeout(500);
    const input = page.locator(".modal input[type=text], .modal input:not([type])").first();
    check.ok("rename prompt opens", (await input.count()) === 1);
    await input.fill("showcase");
    await shot("prompt");
    await input.press("Enter");
    await page.waitForTimeout(1500);
    // A merge-confirmation or progress notice may appear; accept a confirm button if shown.
    const confirm = page.locator(".modal button.mod-cta, .modal button.mod-warning");
    if (await confirm.count()) {
      await confirm.first().click();
      await page.waitForTimeout(1500);
    }
    const welcome = await page.evaluate(() => window.app.vault.cachedRead(window.app.vault.getFileByPath("Welcome.md")));
    check.ok("frontmatter tag renamed", /tags: \[start, showcase\]|tags:\s*\n(?:\s*- .*\n)*\s*- showcase/.test(welcome), welcome.split("\n").slice(0, 3).join(" / "));
    check.ok("body tag renamed", /#showcase/.test(welcome) && !/#demo\b/.test(welcome));
    await page.waitForTimeout(500);
    const names = await page.locator(".tag-pane-tag-text").allTextContents();
    check.ok("tag pane shows the new tag", names.includes("showcase") && !names.includes("demo"), names.join(","));
  },
};
