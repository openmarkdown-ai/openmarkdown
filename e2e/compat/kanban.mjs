// obsidian-kanban: create a board, add two lists and cards through the inline
// Markdown editors (built on the host's internal embeddable editor), drag a
// card to the other list, edit a card in place, and check the Markdown file.
// TextFileView saves are debounced (2 s), so poll the file.
async function boardText(page, re) {
  let md = "";
  for (let i = 0; i < 20; i++) {
    md = await page.evaluate(() => window.app.vault.cachedRead(window.app.workspace.getActiveFile()));
    if (!re || re.test(md)) break;
    await page.waitForTimeout(250);
  }
  return md;
}

export default {
  plugins: ["obsidian-kanban"],
  async run({ page, check, shot }) {
    await page.evaluate(() => window.app.commands.executeCommandById("obsidian-kanban:create-new-kanban-board"));
    await page.waitForTimeout(1500);
    check.ok("new board opens in the kanban view", (await page.evaluate(() => window.app.workspace.activeLeaf?.view?.getViewType())) === "kanban");
    const laneInput = page.locator(".kanban-plugin__lane-input .cm-content");
    check.ok("lane form shows an inline editor", (await laneInput.count()) === 1);
    const laneBox = await page.locator(".kanban-plugin__lane-input").boundingBox();
    check.ok("inline editor is compact (no file margins)", laneBox && laneBox.height < 60, laneBox && laneBox.height);
    for (const name of ["Todo", "Done"]) {
      await laneInput.click();
      await page.keyboard.type(name);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const lanes = await page.locator(".kanban-plugin__lane-title-text, .kanban-plugin__lane-title .markdown-preview-view").allTextContents();
    check.ok("two lists created", lanes.map((s) => s.trim()).join(",").includes("Todo") && lanes.join(",").includes("Done"), lanes.join(","));
    const todo = page.locator(".kanban-plugin__lane").filter({ hasText: "Todo" }).first();
    await todo.locator(".kanban-plugin__lane-footer button, button.kanban-plugin__new-item-button").first().click();
    await page.waitForTimeout(400);
    const itemInput = todo.locator(".kanban-plugin__item-input .cm-content");
    check.ok("card editor opens", (await itemInput.count()) === 1);
    await itemInput.click();
    await page.keyboard.type("Buy milk");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    await page.keyboard.type("Write report");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
    const cards = await todo.locator(".kanban-plugin__item-title").allTextContents();
    check.ok("cards added to Todo", cards.length === 2, cards.join(","));
    await shot("board");
    let md = await boardText(page, /Write report/);
    check.ok("board saved as Markdown", /## Todo\n\n- \[ \] Buy milk\n- \[ \] Write report/.test(md), md.replace(/\n/g, "⏎").slice(0, 200));
    // Drag "Buy milk" to Done (kanban uses its own pointer-event DnD).
    const card = todo.locator(".kanban-plugin__item").filter({ hasText: "Buy milk" }).first();
    const done = page.locator(".kanban-plugin__lane").filter({ hasText: "Done" }).first();
    const from = await card.boundingBox();
    const to = await done.locator(".kanban-plugin__lane-items").boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(from.x + from.width / 2 + ((to.x + to.width / 2 - from.x - from.width / 2) * i) / 15, from.y + from.height / 2 + ((to.y + 20 - from.y - from.height / 2) * i) / 15);
      await page.waitForTimeout(30);
    }
    await shot("dragging");
    await page.mouse.up();
    await page.waitForTimeout(1500);
    md = await boardText(page, /## Done\n\n- \[ \] Buy milk/);
    check.ok("drag moves the card to Done", /## Done\n\n- \[ \] Buy milk/.test(md), md.replace(/\n/g, "⏎").slice(0, 240));
    // Edit a card inline: double-click the title → editor → change text → Enter.
    const report = page.locator(".kanban-plugin__item").filter({ hasText: "Write report" }).first();
    await report.locator(".kanban-plugin__item-title").dblclick();
    await page.waitForTimeout(500);
    const editor = report.locator(".cm-content");
    check.ok("double-click opens the inline card editor", (await editor.count()) === 1);
    if (await editor.count()) {
      await page.keyboard.press("End");
      await page.keyboard.type(" today");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1500);
    }
    md = await boardText(page, /report today/);
    check.ok("inline edit saved", /- \[ \] Write report today/.test(md), md.replace(/\n/g, "⏎").slice(0, 240));
    await shot("edited");
    // A card with a link and a tag: the [[ suggester works in the card editor,
    // and the card renders the link and tag as Markdown.
    await done.locator(".kanban-plugin__lane-footer button, button.kanban-plugin__new-item-button").first().click();
    await page.waitForTimeout(400);
    await done.locator(".kanban-plugin__item-input .cm-content").click();
    await page.keyboard.type("Read [[Wel");
    await page.waitForTimeout(700);
    const suggest = page.locator(".suggestion-container .suggestion-item");
    check.ok("link suggester opens in the card editor", (await suggest.count()) > 0);
    await shot("suggest");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await page.keyboard.press("End");
    await page.keyboard.type(" #demo");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter"); // accepts the tag suggestion
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter"); // submits the card
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
    const linkCard = done.locator(".kanban-plugin__item").filter({ hasText: "Read" }).first();
    check.ok("card renders the internal link", (await linkCard.locator("a.internal-link").count()) === 1, await linkCard.innerText().catch(() => ""));
    check.ok("card renders the tag", (await linkCard.locator("a.tag").count()) === 1);
    md = await boardText(page, /Read \[\[Welcome\]\] #demo/);
    check.ok("link card saved", /- \[ \] Read \[\[Welcome\]\] #demo/.test(md), md.replace(/\n/g, "⏎").slice(0, 260));
    await page.evaluate(() => window.app.commands.executeCommandById("obsidian-kanban:toggle-kanban-view"));
    await page.waitForTimeout(1000);
    check.ok("toggle opens the board as Markdown", (await page.evaluate(() => window.app.workspace.activeLeaf?.view?.getViewType())) === "markdown");
    await page.evaluate(() => window.app.commands.executeCommandById("obsidian-kanban:toggle-kanban-view"));
    await page.waitForTimeout(1000);
    check.ok("toggle back to the board", (await page.evaluate(() => window.app.workspace.activeLeaf?.view?.getViewType())) === "kanban");
  },
};
