// recent-files-obsidian: its sidebar view lists the notes opened most recently,
// newest first, and clicking an entry opens that note.
import { openNote } from "./lib.mjs";

export default {
  plugins: ["recent-files-obsidian"],
  async run({ page, check, shot }) {
    await openNote(page, "Welcome.md");
    await openNote(page, "Formatting.md");
    await openNote(page, "Linking notes.md");
    await page.evaluate(() => window.app.commands.executeCommandById("recent-files-obsidian:recent-files-open"));
    await page.waitForTimeout(800);
    const view = page.locator('.workspace-leaf-content[data-type="recent-files"]');
    check.ok("view opens", (await view.count()) > 0);
    const names = await view.locator(".nav-file-title-content, .tree-item-inner").allTextContents();
    check.ok("lists opened notes newest first", names[0] === "Linking notes" && names.includes("Formatting") && names.includes("Welcome"), names.join(", "));
    await shot("view");
    const entry = view.locator(".nav-file-title, .tree-item-self").filter({ hasText: "Welcome" }).first();
    await entry.click();
    await page.waitForTimeout(600);
    check.ok("clicking an entry opens the note", await page.evaluate(() => window.app.workspace.getActiveFile()?.path) === "Welcome.md");
  },
};
