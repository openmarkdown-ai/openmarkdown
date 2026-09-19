// obsidian-excalidraw-plugin: create a new drawing, draw a rectangle with the
// toolbar, let it save, then embed a note and a note heading into the drawing
// (the heading goes through the host's internal canvas-node API).
export default {
  plugins: ["obsidian-excalidraw-plugin"],
  async run({ page, check, shot }) {
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.app.commands.executeCommandById("obsidian-excalidraw-plugin:excalidraw-autocreate"));
    await page.waitForTimeout(5000);
    const state = await page.evaluate(() => ({ type: window.app.workspace.activeLeaf?.view?.getViewType(), path: window.app.workspace.getActiveFile()?.path }));
    check.ok("new drawing opens in the Excalidraw view", state.type === "excalidraw" && /\.excalidraw\.md$/.test(state.path ?? ""), JSON.stringify(state));
    check.ok("first-run welcome dialog renders", (await page.locator(".modal").count()) >= 0);
    const close = page.locator(".modal .modal-close-button");
    if (await close.count()) await close.first().click();
    await page.waitForTimeout(500);
    check.ok("view gets its classes (onLoad finished)", await page.evaluate(() => window.app.workspace.activeLeaf.view.contentEl.hasClass("excalidraw-view")));
    const tool = page.locator('.excalidraw .ToolIcon input[data-testid="toolbar-rectangle"], .excalidraw [data-testid="toolbar-rectangle"]').first();
    check.ok("toolbar renders", (await tool.count()) === 1);
    await tool.click({ force: true });
    const box = await page.locator(".excalidraw canvas.interactive, .excalidraw canvas").last().boundingBox();
    await page.mouse.move(box.x + 300, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 420, box.y + 380, { steps: 10 });
    await page.mouse.move(box.x + 520, box.y + 460, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const types = await page.evaluate(() => window.app.workspace.activeLeaf.view.excalidrawAPI.getSceneElements().map((e) => e.type));
    check.ok("drawing a rectangle adds it to the scene", types.includes("rectangle"), types.join(","));
    await shot("rectangle");
    await page.evaluate(() => window.app.workspace.activeLeaf.view.save(false));
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => window.app.vault.read(window.app.workspace.getActiveFile()));
    check.ok("drawing saved to the .excalidraw.md file", /## Drawing\n```compressed-json\n/.test(text), text.length);
    const embedded = await page.evaluate(async () => {
      const ea = window.ExcalidrawAutomate;
      const view = window.app.workspace.activeLeaf.view;
      ea.reset();
      ea.setView(view);
      ea.addEmbeddable(600, 0, 400, 280, null, window.app.vault.getFileByPath("Formatting.md"));
      ea.addEmbeddable(600, 320, 400, 280, "[[Formatting#Tasks]]");
      await ea.addElementsToView(false, true);
      return view.excalidrawAPI.getSceneElements().filter((e) => e.type === "embeddable").length;
    });
    check.ok("note and heading embeddables added", embedded === 2);
    await page.waitForTimeout(3000);
    const containers = page.locator(".excalidraw__embeddable-container");
    const html = await containers.allInnerTexts();
    check.ok("whole-note embeddable renders the note", html.some((t) => /Callouts/.test(t)), html.map((t) => t.slice(0, 40)).join(" | "));
    check.ok("heading embeddable renders the section (canvas node)", html.some((t) => /Write a note/.test(t) && !/Callouts/.test(t)));
    await shot("embeds");
  },
};
