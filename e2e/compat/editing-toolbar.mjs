// Editing Toolbar (editing-toolbar): the "top" toolbar is mounted in the active
// Markdown view; its buttons run formatting on the selection (bold, H2,
// highlight, undo); the "following" style pops up next to a selection.
import { openNote, writeNote } from "./lib.mjs";

const value = (page) => page.evaluate(() => app.workspace.activeEditor.editor.getValue());
async function select(page, line, from, to) {
  await page.evaluate(({ line, from, to }) => {
    const ed = app.workspace.activeEditor.editor;
    ed.focus();
    ed.setSelection({ line, ch: from }, { line, ch: to });
  }, { line, from, to });
}
const click = (page, label) =>
  page.evaluate((label) => {
    const b = [...document.querySelectorAll(".workspace-leaf.mod-active .editingToolbarModalBar .editingToolbarCommandItem")].find((x) => x.getAttribute("aria-label") === label);
    if (!b) return false;
    b.click();
    return true;
  }, label);

export default {
  ignoreErrors: [/unsupported MIME type/],
  plugins: ["editing-toolbar"],
  async run({ page, check, shot }) {
    // First-run onboarding modal (plugin UI); dismiss it.
    await page.waitForTimeout(800);
    await page.evaluate(() => document.querySelectorAll(".modal-container").forEach((m) => [...m.querySelectorAll("button")].find((b) => /not now/i.test(b.textContent))?.click()));
    await writeNote(page, "Tool.md", "# Tool\n\nhello world\n\nsecond line\n");
    await openNote(page, "Tool.md", "source", false);
    await page.waitForTimeout(800);
    const bar = await page.evaluate(() => {
      const b = document.querySelector(".workspace-leaf.mod-active .editingToolbarModalBar");
      return b ? { style: b.dataset.toolbarStyle, buttons: b.querySelectorAll(".editingToolbarCommandItem").length, visible: b.getBoundingClientRect().height > 10 } : null;
    });
    check.ok("top toolbar mounted in the active note", bar?.visible && bar.buttons > 10, JSON.stringify(bar));

    await select(page, 2, 0, 5);
    check.ok("Bold button found", await click(page, "Bold"));
    await page.waitForTimeout(300);
    let t = await value(page);
    check.ok("Bold wraps the selection", t.includes("**hello** world"), JSON.stringify(t));

    await select(page, 4, 0, 6);
    await click(page, "Highlight");
    await page.waitForTimeout(300);
    t = await value(page);
    check.ok("Highlight wraps the selection", t.includes("==second== line"), JSON.stringify(t));

    await select(page, 4, 0, 0);
    await click(page, "Header 2");
    await page.waitForTimeout(300);
    t = await value(page);
    check.ok("Header 2 sets the heading", t.includes("## ==second== line"), JSON.stringify(t));

    await click(page, "Undo Edit");
    await page.waitForTimeout(300);
    t = await value(page);
    check.ok("Undo reverts the last edit", !t.includes("## ==second"), JSON.stringify(t));
    await shot("top");

    // "following" style: a floating bar near the selection.
    await page.evaluate(async () => {
      const p = app.plugins.plugins["editing-toolbar"];
      p.settings.enableFollowingToolbar = true;
      await p.saveSettings?.();
    });
    await page.waitForTimeout(500);
    const ln = await page.evaluate(() => {
      const el = [...document.querySelectorAll(".workspace-leaf.mod-active .cm-line")].find((l) => l.textContent.includes("world"));
      const r = el.getBoundingClientRect();
      return { x: r.left + 5, y: r.top + r.height / 2, w: r.width };
    });
    await page.mouse.move(ln.x, ln.y);
    await page.mouse.down();
    await page.mouse.move(ln.x + 90, ln.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const follow = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.editingToolbarModalBar[data-toolbar-style="following"]')].find((e) => e.style.display !== "none" && e.getBoundingClientRect().height > 0);
      return b ? { top: b.getBoundingClientRect().top, sel: app.workspace.activeEditor.editor.getSelection() } : { sel: app.workspace.activeEditor.editor.getSelection() };
    });
    check.ok("following toolbar appears for a mouse selection", follow.top !== undefined, JSON.stringify(follow));
    await shot("following");
  },
};
