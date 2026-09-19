// TaskNotes: create a task through its modal (it becomes a note with task
// frontmatter), and open the non-Bases views. Its task list, kanban, calendar
// and agenda views are Bases views (registerBasesView).
export default {
  plugins: ["tasknotes"],
  ignoreErrors: [/unsupported MIME type/, /blocked by CORS policy/],
  async run({ page, check, shot }) {
    await page.waitForTimeout(1500);
    // Its modal builds CodeMirror fields from the Markdown embed's editor
    // prototype, which it (as in Obsidian) resolves through the active file.
    await page.evaluate(() => window.app.workspace.openLinkText("Welcome", "", false));
    await page.waitForTimeout(800);
    await page.evaluate(() => window.app.commands.executeCommandById("tasknotes:create-new-task"));
    await page.waitForTimeout(1000);
    const modal = await page.evaluate(() => {
      const m = document.querySelector(".modal-container .modal");
      return { open: !!m, cls: m?.className, inputs: m?.querySelectorAll("input, textarea, [contenteditable=true]").length ?? 0 };
    });
    check.ok("create-task modal opens", modal.open && modal.inputs > 0, JSON.stringify(modal));
    await shot("create-modal");
    if (modal.open) {
      const title = await page.$(".modal-container .modal .cm-content, .modal-container .modal textarea, .modal-container .modal input[type=text]");
      await title?.click();
      await page.keyboard.type("Water the tomatoes", { delay: 20 });
      await page.waitForTimeout(300);
      const saved = await page.evaluate(async () => {
        const m = document.querySelector(".modal-container .modal");
        const btn = Array.from(m.querySelectorAll("button")).find((b) => /^(save|create)/i.test(b.textContent.trim()));
        if (!btn) return "no button: " + Array.from(m.querySelectorAll("button")).map((b) => b.textContent.trim()).join("|");
        btn.click();
        await new Promise((r) => setTimeout(r, 1500));
        const f = window.app.vault.getMarkdownFiles().find((f) => /Water the tomatoes/.test(f.basename));
        return f ? { path: f.path, fm: window.app.metadataCache.getFileCache(f)?.frontmatter } : "no file";
      });
      check.ok("saving creates a task note with frontmatter", typeof saved === "object" && saved.fm && (saved.fm.status || saved.fm.tags), JSON.stringify(saved).slice(0, 200));
    }
    for (const [cmd, type] of [["tasknotes:open-pomodoro-view", "tasknotes-pomodoro-view"], ["tasknotes:open-statistics", "tasknotes-stats-view"]]) {
      await page.evaluate((cmd) => window.app.commands.executeCommandById(cmd), cmd);
      await page.waitForTimeout(1200);
      const info = await page.evaluate((type) => {
        const leaf = window.app.workspace.getLeavesOfType(type)[0];
        return { leaf: !!leaf, n: leaf?.view?.containerEl.querySelectorAll("*").length ?? 0 };
      }, type);
      check.ok(`${type} opens`, info.leaf && info.n > 5, JSON.stringify(info));
    }
    await shot("pomodoro");
    const bases = await page.evaluate(() => !!window.app.internalPlugins.getEnabledPluginById?.("bases"));
    if (bases) {
      await page.evaluate(() => window.app.commands.executeCommandById("tasknotes:open-tasks-view"));
      await page.waitForTimeout(2500);
      const info = await page.evaluate(() => {
        const leaf = window.app.workspace.getLeavesOfType("bases").find((l) => /tasks-default/.test(l.view?.file?.path ?? ""));
        return { type: leaf?.view?.getViewType(), file: leaf?.view?.file?.path, text: leaf?.view?.containerEl.textContent.replace(/\s+/g, " ").slice(0, 160) };
      });
      check.ok("tasks view (a .base) opens", /bases/.test(info.type ?? "") && /Water the tomatoes/.test(info.text ?? ""), JSON.stringify(info));
      await shot("tasks-base");
    }
  },
};
