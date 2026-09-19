// Templater (templater-obsidian): a template using tp.date.now and
// tp.file.title is inserted into the open note through "Open insert template
// modal"; "Create new note from template" makes a note and renders it; the
// tp.file.cursor jump works. (User scripts and system commands are desktop-only.)
import { openNote, writeNote } from "./lib.mjs";

const TEMPLATE = '# <% tp.file.title %>\n\nCreated <% tp.date.now("YYYY-MM-DD") %>\nTomorrow <% tp.date.tomorrow("YYYY-MM-DD") %>\nFolder: <% tp.file.folder(true) %>\n<% tp.file.cursor() %>\n';

async function pickSuggestion(page, text) {
  await page.waitForSelector(".prompt .suggestion-item", { timeout: 5000 });
  await page.keyboard.type(text);
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
}

export default {
  ignoreErrors: [/unsupported MIME type/],
  plugins: ["templater-obsidian"],
  async run({ page, check, shot }) {
    await writeNote(page, "Templates/Meeting.md", TEMPLATE);
    await page.evaluate(async () => {
      const p = app.plugins.plugins["templater-obsidian"];
      p.settings.templates_folder = "Templates";
      await p.save_settings?.();
    });
    const today = await page.evaluate(() => moment().format("YYYY-MM-DD"));
    const tomorrow = await page.evaluate(() => moment().add(1, "d").format("YYYY-MM-DD"));

    // Insert into an existing note.
    await writeNote(page, "Projects/Standup.md", "");
    await openNote(page, "Projects/Standup.md", "source", false);
    await page.evaluate(() => app.workspace.activeEditor.editor.focus());
    await page.evaluate(() => app.commands.executeCommandById("templater-obsidian:insert-templater"));
    await pickSuggestion(page, "Meeting");
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => app.workspace.activeEditor.editor.getValue());
    check.ok("tp.file.title renders", text.startsWith("# Standup\n"), JSON.stringify(text));
    check.ok("tp.date.now renders", text.includes(`Created ${today}`), JSON.stringify(text));
    check.ok("tp.date.tomorrow renders", text.includes(`Tomorrow ${tomorrow}`), JSON.stringify(text));
    check.ok("tp.file.folder renders", text.includes("Folder: Projects"), JSON.stringify(text));
    // tp.file.cursor stays until "Jump to next cursor location" (auto-jump is off by default).
    await page.evaluate(() => app.commands.executeCommandById("templater-obsidian:jump-to-next-cursor-location"));
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({ text: app.workspace.activeEditor.editor.getValue(), cur: app.workspace.activeEditor.editor.getCursor() }));
    check.ok("jump-to-cursor removes tp.file.cursor and places the cursor", !after.text.includes("tp.file.cursor") && after.cur.line === 5, JSON.stringify(after));
    await shot("inserted");

    // New note from template.
    await page.waitForTimeout(500);
    const cmd = await page.evaluate(() => app.commands.executeCommandById("templater-obsidian:create-new-note-from-template"));
    await page.waitForTimeout(500);
    const prompt = await page.evaluate(() => document.querySelectorAll(".prompt").length);
    check.ok("create-from-template opens the template picker", cmd && prompt === 1, `${cmd} ${prompt}`);
    await pickSuggestion(page, "Meeting");
    await page.waitForTimeout(2000);
    const created = await page.evaluate(async () => {
      const f = app.workspace.getActiveFile();
      return f ? { path: f.path, text: await app.vault.read(f) } : null;
    });
    check.ok("creates a new note from the template", created && /^Untitled/.test(created.path.split("/").pop()) && created.text.includes(`Created ${today}`), JSON.stringify(created));
    check.ok("the new note's title is rendered", created && created.text.startsWith(`# ${created.path.split("/").pop().replace(/\.md$/, "")}`), JSON.stringify(created));
    await shot("created");

  },
};
