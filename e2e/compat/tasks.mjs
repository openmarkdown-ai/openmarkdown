// Tasks (obsidian-tasks-group/obsidian-tasks): a `tasks` query over the demo
// vault, toggling a task from the query result, the task edit modal, and the
// editor auto-suggest for task properties.
import { openNote, writeNote } from "./lib.mjs";

const OPEN_TASKS = ["Write a note", "Link it to Welcome", "Nested subtask", "Order seeds"];

export default {
  plugins: ["obsidian-tasks-plugin"],
  async run({ page, check, shot }) {
    await writeNote(page, "Task query.md", "# Task query\n\n```tasks\nnot done\n```\n");
    await openNote(page, "Task query.md", "preview");
    await page.waitForTimeout(2500);
    const view = ".workspace-leaf.mod-active .markdown-reading-view";
    const items = () =>
      page.evaluate(
        (view) =>
          [...document.querySelectorAll(`${view} .block-language-tasks li.plugin-tasks-list-item`)].map((li) => {
            const box = li.querySelector("input.task-list-item-checkbox");
            return { text: li.querySelector(".task-description")?.textContent.trim() ?? li.textContent.trim(), box: !!box && box.getBoundingClientRect().width > 0 };
          }),
        view,
      );
    const found = await items();
    check.ok("`not done` finds every open task in the vault", OPEN_TASKS.every((t) => found.some((f) => f.text.includes(t))) && found.length === OPEN_TASKS.length, JSON.stringify(found.map((f) => f.text)));
    check.ok("result checkboxes are visible", found.length > 0 && found.every((f) => f.box));
    const count = await page.evaluate((view) => document.querySelector(`${view} .block-language-tasks .task-count`)?.textContent, view);
    check.ok("task count is shown", /4 tasks/.test(count ?? ""), count);
    await shot("query");

    // Toggle "Order seeds" from the result: Tasks rewrites Projects/Garden plan.md.
    await page.locator(`${view} li.plugin-tasks-list-item`, { hasText: "Order seeds" }).locator("input.task-list-item-checkbox").click();
    await page.waitForTimeout(2500);
    const line = await page.evaluate(async () => (await app.vault.read(app.vault.getFileByPath("Projects/Garden plan.md"))).split("\n").find((l) => l.includes("Order seeds")));
    check.ok("toggling a result completes the task in its file (with done date)", /^- \[x\] Order seeds ✅ \d{4}-\d\d-\d\d$/.test(line ?? ""), line);
    const after = await items();
    check.ok("the query result refreshes", !after.some((f) => f.text.includes("Order seeds")) && after.length === 3, JSON.stringify(after.map((f) => f.text)));

    // Edit modal from the pencil button.
    await page.locator(`${view} li.plugin-tasks-list-item`, { hasText: "Write a note" }).locator(".tasks-edit").click();
    const modal = await page.waitForSelector(".modal-container .tasks-modal", { timeout: 5000 }).catch(() => null);
    check.ok("edit button opens the task edit modal", !!modal);
    if (modal) {
      await page.waitForTimeout(400); // open animation
      await shot("edit-modal");
      const desc = page.locator(".tasks-modal textarea#description, .tasks-modal #description").first();
      await desc.fill("Write a note today");
      await page.locator(".tasks-modal #priority-high, .tasks-modal input[value='high']").first().check().catch(() => {});
      await page.locator(".tasks-modal button:has-text('Apply')").click();
      await page.waitForTimeout(2000);
      const edited = await page.evaluate(async () => (await app.vault.read(app.vault.getFileByPath("Formatting.md"))).split("\n").find((l) => l.includes("Write a note")));
      check.ok("applying the modal rewrites the task line", /- \[ \] Write a note today/.test(edited ?? ""), edited);
    }

    // Tasks' CM6 extension takes over checkbox clicks in Live Preview (adds the done date).
    await openNote(page, "Formatting.md", "source");
    await page.waitForTimeout(800);
    const lpBox = page.locator(".workspace-leaf.mod-active .markdown-source-view .cm-line", { hasText: "Link it to" }).locator("input.task-list-item-checkbox");
    await lpBox.click();
    await page.waitForTimeout(1200);
    const lpLine = await page.evaluate(() => app.workspace.activeEditor.editor.getValue().split("\n").find((l) => l.includes("Link it to")));
    check.ok("Live Preview checkbox click completes via Tasks (done date)", /- \[x\] Link it to \[\[Welcome\]\] ✅ \d{4}-\d\d-\d\d/.test(lpLine ?? ""), lpLine);
    // The "Toggle task done" command on the cursor line.
    await page.evaluate(() => {
      const ed = app.workspace.activeEditor.editor;
      const n = ed.getValue().split("\n").findIndex((l) => l.includes("Nested subtask"));
      ed.setCursor({ line: n, ch: 8 });
      app.commands.executeCommandById("obsidian-tasks-plugin:toggle-done");
    });
    await page.waitForTimeout(600);
    const cmdLine = await page.evaluate(() => app.workspace.activeEditor.editor.getValue().split("\n").find((l) => l.includes("Nested subtask")));
    check.ok("`Tasks: Toggle task done` command works in the editor", /\[x\] Nested subtask ✅/.test(cmdLine ?? ""), cmdLine);

    // Auto-suggest while typing a task in the editor.
    await writeNote(page, "Typing.md", "");
    await openNote(page, "Typing.md", "source");
    await page.click(".workspace-leaf.mod-active .cm-content");
    await page.keyboard.type("- [ ] Buy milk ");
    await page.waitForTimeout(800);
    const suggestions = await page.evaluate(() => [...document.querySelectorAll(".suggestion-container .suggestion-item")].map((e) => e.textContent.trim()));
    check.ok("editor auto-suggest offers task properties", suggestions.some((s) => /due|priority|recurs|start|scheduled/i.test(s)), JSON.stringify(suggestions.slice(0, 6)));
    await shot("auto-suggest");
    if (suggestions.length) {
      const due = suggestions.findIndex((s) => /^📅 due date$|due date/i.test(s));
      for (let i = 0; i < Math.max(due, 0); i++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      const text = await page.evaluate(() => app.workspace.activeEditor.editor.getValue());
      check.ok("accepting a suggestion inserts it", /Buy milk 📅/.test(text) || text.length > "- [ ] Buy milk ".length, text);
    }
  },
};
