// Dataview + Tasks + Calendar together, as a real vault would have them: every
// note in the demo vault opens in reading view and Live Preview without a page
// error, and the query note renders all three plugins' output at once.
import { openNote, writeNote } from "./lib.mjs";

export default {
  plugins: ["dataview", "obsidian-tasks-plugin", "calendar"],
  async run({ page, check, shot, errors }) {
    await writeNote(
      page,
      "Plugin check.md",
      '# Plugin check\n\n```dataview\nTABLE author, rating FROM "Books" SORT rating DESC\n```\n\nInline: `= this.file.name`\n\n```tasks\nnot done\n```\n',
    );
    const notes = await page.evaluate(() => app.vault.getMarkdownFiles().map((f) => f.path));
    for (const path of notes) {
      const before = errors.length;
      await openNote(page, path, "preview");
      await openNote(page, path, "source");
      check.ok(`${path} opens in reading view and Live Preview`, errors.length === before, errors.slice(before).join(" || "));
    }
    await openNote(page, "Plugin check.md", "preview");
    await page.waitForTimeout(3000);
    const r = await page.evaluate(() => {
      const root = document.querySelector(".workspace-leaf.mod-active .markdown-reading-view");
      return {
        rows: root.querySelectorAll(".block-language-dataview tbody tr").length,
        tasks: root.querySelectorAll(".block-language-tasks li.plugin-tasks-list-item").length,
        inline: [...root.querySelectorAll("p")].find((p) => p.textContent.startsWith("Inline"))?.textContent,
      };
    });
    check.ok("dataview table rows", r.rows === 3, r.rows);
    check.ok("tasks query finds all 4 open tasks", r.tasks === 4, r.tasks);
    check.ok("inline query renders inline", r.inline === "Inline: Plugin check", r.inline);
    await page.evaluate(() => app.workspace.revealLeaf(app.workspace.getLeavesOfType("calendar")[0]));
    await page.waitForTimeout(800);
    check.ok("calendar shows in the right sidebar", await page.locator(".mod-right-split #calendar-container .day.today").isVisible());
    await shot("all-three");
  },
};
