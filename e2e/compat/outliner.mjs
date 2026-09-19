// Outliner (obsidian-outliner): Mod+Shift+Up/Down move an item with its
// children, Tab/Shift+Tab indent the subtree, Mod+Up/Down fold and unfold,
// vertical indentation lines are drawn, and dragging a bullet moves the item.
import { openNote, writeNote } from "./lib.mjs";

const LIST = "# Outline\n\n- one\n- two\n\t- two.a\n\t- two.b\n- three\n";
const mod = process.platform === "darwin" ? "Meta" : "Control";
const value = (page) => page.evaluate(() => app.workspace.activeEditor.editor.getValue());
async function cursor(page, line, ch) {
  await page.evaluate(({ line, ch }) => {
    const ed = app.workspace.activeEditor.editor;
    ed.focus();
    ed.setCursor({ line, ch });
  }, { line, ch });
}

export default {
  ignoreErrors: [/unsupported MIME type/],
  plugins: ["obsidian-outliner"],
  async run({ page, check, shot }) {
    await writeNote(page, "Outline.md", LIST);
    await openNote(page, "Outline.md", "source", false);
    await cursor(page, 3, 4);
    await page.keyboard.press(`${mod}+Shift+ArrowUp`);
    await page.waitForTimeout(200);
    let t = await value(page);
    check.ok("Mod+Shift+Up moves the item with its children", t === "# Outline\n\n- two\n\t- two.a\n\t- two.b\n- one\n- three\n", JSON.stringify(t));
    const c = await page.evaluate(() => app.workspace.activeEditor.editor.getCursor());
    check.ok("the cursor moves with the item", c.line === 2 && c.ch === 4, JSON.stringify(c));
    await page.keyboard.press(`${mod}+Shift+ArrowDown`);
    await page.waitForTimeout(200);
    t = await value(page);
    check.ok("Mod+Shift+Down moves it back", t === LIST, JSON.stringify(t));

    // Tab indents the item under its previous sibling (subtree included).
    await cursor(page, 3, 4);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);
    t = await value(page);
    check.ok("Tab indents the subtree", t === "# Outline\n\n- one\n\t- two\n\t\t- two.a\n\t\t- two.b\n- three\n", JSON.stringify(t));
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(200);
    check.ok("Shift+Tab outdents it back", (await value(page)) === LIST, JSON.stringify(await value(page)));

    // Vertical lines between a parent and its last child ("Draw vertical indentation lines" setting).
    await page.evaluate(() => (app.plugins.plugins["obsidian-outliner"].settings.verticalLines = true));
    await page.waitForTimeout(1500);
    const lines = await page.evaluate(() => [...document.querySelectorAll(".workspace-leaf.mod-active .outliner-plugin-list-line")].filter((e) => e.style.display === "block" && e.getBoundingClientRect().height > 10).length);
    check.ok("vertical indentation lines are drawn", lines >= 1, lines);
    const geometry = await page.evaluate(() => {
      const line = document.querySelector(".workspace-leaf.mod-active .outliner-plugin-list-line").getBoundingClientRect();
      const rows = [...document.querySelectorAll(".workspace-leaf.mod-active .cm-line")];
      const two = rows.find((l) => l.textContent.trim() === "- two" || l.textContent.trim() === "two" || l.textContent.endsWith("two")).getBoundingClientRect();
      const twoB = rows.find((l) => l.textContent.endsWith("two.b")).getBoundingClientRect();
      const twoA = rows.find((l) => l.textContent.endsWith("two.a")).querySelector(".list-bullet").getBoundingClientRect();
      const one = rows.find((l) => l.textContent.endsWith("one")).querySelector(".list-bullet").getBoundingClientRect();
      return { top: line.top, bottom: line.bottom, twoBottom: two.bottom, twoBBottom: twoB.bottom, nested: twoA.left - one.left };
    });
    check.ok("the line spans the children of its item", geometry.top >= geometry.twoBottom - 12 && geometry.bottom <= geometry.twoBBottom + 4 && geometry.bottom > geometry.top + 20, JSON.stringify(geometry));
    check.ok("a tab-indented child is visibly indented", geometry.nested > 15, JSON.stringify(geometry));
    await shot("lines");

    // Fold with Mod+Up, unfold with Mod+Down.
    await cursor(page, 3, 4);
    await page.keyboard.press(`${mod}+ArrowUp`);
    await page.waitForTimeout(300);
    const folded = await page.evaluate(() => app.workspace.activeEditor.editor.cm.state.doc.lineAt(0) && [...document.querySelectorAll(".workspace-leaf.mod-active .cm-line")].map((l) => l.textContent));
    check.ok("Mod+Up folds the item", !folded.some((l) => l.includes("two.a")), JSON.stringify(folded));
    await shot("folded");
    await page.keyboard.press(`${mod}+ArrowDown`);
    await page.waitForTimeout(300);
    const unfolded = await page.evaluate(() => [...document.querySelectorAll(".workspace-leaf.mod-active .cm-line")].map((l) => l.textContent));
    check.ok("Mod+Down unfolds it", unfolded.some((l) => l.includes("two.a")), JSON.stringify(unfolded));

    // Drag "three" by its bullet above "two".
    const box = async (text) =>
      page.evaluate((text) => {
        const line = [...document.querySelectorAll(".workspace-leaf.mod-active .cm-line")].find((l) => l.textContent.trim().endsWith(text));
        const bullet = line?.querySelector(".cm-formatting-list");
        const r = (bullet ?? line).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, bullet: !!bullet, lineTop: line.getBoundingClientRect().top };
      }, text);
    const from = await box("three");
    const to = await box("two");
    check.ok("list bullets carry .cm-formatting-list (drag handle)", from.bullet, JSON.stringify(from));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y - 5, { steps: 4 });
    await page.mouse.move(to.x + 40, to.lineTop + 3, { steps: 8 });
    await page.waitForTimeout(150);
    const dropZone = await page.evaluate(() => {
      const z = document.querySelector(".outliner-plugin-drop-zone");
      return z ? getComputedStyle(z).display : null;
    });
    await shot("dragging");
    await page.mouse.up();
    await page.waitForTimeout(300);
    t = await value(page);
    check.ok("dragging a bullet moves the item", t.indexOf("- three") < t.indexOf("- two") && t.includes("- three"), `${dropZone} ${JSON.stringify(t)}`);
  },
};
