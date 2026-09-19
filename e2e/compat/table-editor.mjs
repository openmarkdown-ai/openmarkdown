// Advanced Tables (table-editor-obsidian): Tab formats and moves to the next
// cell, Enter adds/moves to the next row (source mode, as in Obsidian), the
// "Advanced Tables Toolbar" sidebar view opens and its buttons act on the table.
import { openNote, writeNote } from "./lib.mjs";

const TABLE = "# Table\n\n| a | bb |\n| - | - |\n| ccc | d |\n";

async function cursor(page, line, ch) {
  await page.evaluate(({ line, ch }) => {
    const ed = app.workspace.activeEditor.editor;
    ed.focus();
    ed.setCursor({ line, ch });
  }, { line, ch });
}
const text = (page) => page.evaluate(() => app.workspace.activeEditor.editor.getValue());

export default {
  ignoreErrors: [/unsupported MIME type/],
  plugins: ["table-editor-obsidian"],
  async run({ page, check, shot }) {
    await writeNote(page, "Table.md", TABLE);
    await openNote(page, "Table.md", "source", true);
    await cursor(page, 2, 3);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    let t = await text(page);
    check.ok("Tab formats the table", t.includes("| a   | bb  |") && t.includes("| --- | --- |") && t.includes("| ccc | d   |"), JSON.stringify(t));
    const pos = await page.evaluate(() => app.workspace.activeEditor.editor.getCursor());
    check.ok("Tab moves to the next cell", pos.line === 2 && pos.ch >= 8, JSON.stringify(pos));
    await cursor(page, 4, 3);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    t = await text(page);
    check.ok("Enter on the last row adds a row", t.split("\n").filter((l) => l.startsWith("|")).length === 4, JSON.stringify(t));
    await page.keyboard.type("x");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);
    t = await text(page);
    check.ok("typing in the new row and Tab re-formats", /\| x {3}\| {5}\|/.test(t), JSON.stringify(t));
    await shot("formatted");

    // Sidebar toolbar view.
    await page.evaluate(() => app.commands.executeCommandById("table-editor-obsidian:table-control-bar"));
    await page.waitForTimeout(800);
    const view = await page.evaluate(() => {
      const leaf = app.workspace.getLeavesOfType("advanced-tables-toolbar")[0];
      return leaf ? { inRight: leaf.getRoot() === app.workspace.rightSplit, buttons: leaf.view.containerEl.querySelectorAll("button, .clickable-icon, .advanced-tables-button").length } : null;
    });
    check.ok("toolbar view opens in the right sidebar", view?.inRight && view.buttons > 5, JSON.stringify(view));
    // Keep the note focused, then click "sort ascending"-like button: insert column.
    await openNote(page, "Table.md", "source", true);
    await cursor(page, 2, 3);
    const clicked = await page.evaluate(() => {
      const leaf = app.workspace.getLeavesOfType("advanced-tables-toolbar")[0];
      const btn = [...leaf.view.containerEl.querySelectorAll(".advanced-tables-button")].find((b) => /insert column/i.test(b.getAttribute("title")));
      if (!btn) return "no insert-column button";
      btn.click();
      return true;
    });
    await page.waitForTimeout(300);
    t = await text(page);
    check.ok("toolbar 'insert column' acts on the table", clicked === true && t.split("\n")[2].split("|").length === 5, `${clicked} ${JSON.stringify(t)}`);
    await shot("toolbar");
  },
};
