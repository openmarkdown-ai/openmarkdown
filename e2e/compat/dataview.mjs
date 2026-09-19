// Dataview (blacksmithgu/obsidian-dataview): DQL TABLE / LIST / TASK blocks,
// DataviewJS, inline queries in reading view and Live Preview, and toggling a
// task from a TASK result (Dataview rewrites the source file).
import { openNote, writeNote } from "./lib.mjs";

const NOTE = [
  "# Dataview check",
  "",
  "```dataview",
  'TABLE author, rating FROM "Books" SORT rating DESC',
  "```",
  "",
  "Inline: `= this.file.name` and `= 1 + 2`",
  "",
  "```dataview",
  "LIST FROM #demo",
  "```",
  "",
  "```dataview",
  'TASK FROM "Projects" WHERE !completed',
  "```",
  "",
  "```dataviewjs",
  'dv.paragraph("js pages: " + dv.pages(\'"Books"\').length)',
  "```",
  "",
  "JS inline: `$= dv.current().file.name.length`",
  "",
].join("\n");

export default {
  plugins: ["dataview"],
  async run({ page, check, shot }) {
    await page.evaluate(async () => {
      const dv = app.plugins.plugins.dataview;
      await dv.updateSettings({ enableDataviewJs: true, enableInlineDataviewJs: true });
    });
    await writeNote(page, "Dataview check.md", NOTE);
    await openNote(page, "Dataview check.md", "preview");
    await page.waitForTimeout(3500);
    const view = ".workspace-leaf.mod-active .markdown-reading-view";
    const r = await page.evaluate((view) => {
      const root = document.querySelector(view);
      const inline = [...root.querySelectorAll(".dataview-inline-query, .dataview.dataview-inline")].map((e) => ({ text: e.textContent, display: getComputedStyle(e).display, parent: e.parentElement?.tagName }));
      return {
        rows: root.querySelectorAll(".block-language-dataview table tbody tr").length,
        list: [...root.querySelectorAll(".block-language-dataview ul.dataview-ul > li, .block-language-dataview ul.list-view-ul > li")].map((l) => l.textContent.trim()),
        tasks: [...root.querySelectorAll(".block-language-dataview .task-list-item")].map((l) => l.textContent.trim()),
        js: root.querySelector(".block-language-dataviewjs")?.textContent.trim(),
        inline,
        para: [...root.querySelectorAll("p")].map((p) => p.textContent).filter((t) => t.startsWith("Inline") || t.startsWith("JS inline")),
      };
    }, view);
    check.ok("TABLE renders one row per book", r.rows === 3, r.rows);
    check.ok("LIST FROM #demo lists Welcome", r.list.some((t) => t.includes("Welcome")), JSON.stringify(r.list));
    check.ok("TASK lists open tasks in Projects", r.tasks.some((t) => t.includes("Order seeds")) && !r.tasks.some((t) => t.includes("south bed")), JSON.stringify(r.tasks));
    check.ok("DataviewJS block runs", r.js === "js pages: 3", r.js);
    check.ok("inline `= this.file.name` renders inline in its paragraph", r.para[0] === "Inline: Dataview check and 3", JSON.stringify(r.para));
    check.ok("inline JS query renders", r.para[1] === "JS inline: 14", JSON.stringify(r.para));
    check.ok("inline results are inline elements", r.inline.length >= 2 && r.inline.every((i) => i.display.startsWith("inline") && i.parent === "P"), JSON.stringify(r.inline));
    await shot("reading");

    // Toggle "Order seeds" from the TASK result: Dataview edits Projects/Garden plan.md.
    const box = page.locator(`${view} .block-language-dataview .task-list-item`, { hasText: "Order seeds" }).locator("input.task-list-item-checkbox");
    await box.click();
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => app.vault.cachedRead(app.vault.getFileByPath("Projects/Garden plan.md")));
    check.ok("checking a TASK result completes the task in its source file", /- \[x\] Order seeds/.test(text), text.split("\n").find((l) => l.includes("Order seeds")));
    // Dataview re-runs views after its index settles (refreshInterval, 2.5 s by default).
    await page.waitForTimeout(3500);
    const after = await page.evaluate((view) => [...document.querySelectorAll(`${view} .block-language-dataview .task-list-item`)].map((l) => l.textContent.trim()), view);
    check.ok("the TASK query refreshes and drops the completed task", !after.some((t) => t.includes("Order seeds")), JSON.stringify(after));

    // Live Preview: blocks and inline queries render as widgets away from the cursor.
    await page.mouse.move(5, 5);
    await openNote(page, "Dataview check.md", "source", false);
    await page.evaluate(() => app.workspace.activeEditor.editor.setCursor({ line: 0, ch: 0 }));
    await page.waitForTimeout(2500);
    const lp = await page.evaluate(() => {
      const root = document.querySelector(".workspace-leaf.mod-active .markdown-source-view.is-live-preview");
      return {
        table: root?.querySelectorAll(".block-language-dataview table tbody tr").length ?? 0,
        inline: [...(root?.querySelectorAll(".cm-line") ?? [])].map((l) => l.textContent).filter((t) => t.startsWith("Inline") || t.startsWith("JS inline")),
      };
    });
    check.ok("Live Preview renders the TABLE block", lp.table === 3, lp.table);
    check.ok("Live Preview renders inline queries in the line", lp.inline[0] === "Inline: Dataview check and 3", JSON.stringify(lp.inline));
    await shot("live-preview");
  },
};
