// Linter (obsidian-linter): with a few rules enabled in its settings, "Lint the
// current file" rewrites the open note through the editor; its settings tab opens.
import { openNote, writeNote } from "./lib.mjs";

const MESSY = "# Title\nSome text   \n\n\n\n## Section\n- item\n";

export default {
  ignoreErrors: [/unsupported MIME type/],
  plugins: ["obsidian-linter"],
  async run({ page, check, shot }) {
    await page.waitForTimeout(1000);
    const enabled = await page.evaluate(async () => {
      const p = app.plugins.plugins["obsidian-linter"];
      const rc = p.settings.ruleConfigs;
      for (const id of ["trailing-spaces", "consecutive-blank-lines", "heading-blank-lines", "yaml-timestamp"]) if (rc[id]) rc[id].enabled = true;
      if (rc["yaml-timestamp"]) Object.assign(rc["yaml-timestamp"], { "date-created": true, "date-modified": false });
      await p.saveSettings?.();
      return Object.keys(rc).filter((k) => rc[k].enabled);
    });
    check.ok("rules can be enabled through its settings object", enabled.includes("trailing-spaces"), enabled.join(","));
    await writeNote(page, "Lint me.md", MESSY);
    await openNote(page, "Lint me.md", "source", false);
    await page.evaluate(() => app.workspace.activeEditor.editor.focus());
    const ran = await page.evaluate(() => app.commands.executeCommandById("obsidian-linter:lint-file"));
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => app.workspace.activeEditor.editor.getValue());
    check.ok("lint-file command runs", ran === true, ran);
    check.ok("trailing spaces removed", !/text {2,}/.test(text), JSON.stringify(text));
    check.ok("consecutive blank lines collapsed", !text.includes("\n\n\n"), JSON.stringify(text));
    check.ok("blank lines around headings", text.includes("# Title\n\nSome text") || text.includes("\n\n## Section\n\n- item"), JSON.stringify(text));
    check.ok("yaml timestamp inserted", /^---\n[\s\S]*date created:/.test(text), JSON.stringify(text));
    await shot("linted");
    await page.waitForTimeout(2500);
    const saved = await page.evaluate(() => app.vault.adapter.read("Lint me.md"));
    check.ok("the linted text is saved to disk", saved === text, JSON.stringify(saved));

    // Lint on save: Linter wraps the checkCallback of the core "editor:save-file" command.
    await page.evaluate(() => (app.plugins.plugins["obsidian-linter"].settings.lintOnSave = true));
    await page.evaluate(() => {
      const ed = app.workspace.activeEditor.editor;
      ed.focus();
      ed.setCursor({ line: ed.lastLine(), ch: 0 });
    });
    await page.keyboard.type("tail   ");
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+s`);
    await page.waitForTimeout(1200);
    const afterSave = await page.evaluate(() => app.workspace.activeEditor.editor.getValue());
    check.ok("Mod+S lints on save (lintOnSave)", afterSave.endsWith("tail\n") || afterSave.endsWith("tail"), JSON.stringify(afterSave));

    await page.evaluate(() => { app.setting.open(); app.setting.openTabById("obsidian-linter"); });
    await page.waitForTimeout(1200);
    const tab = await page.evaluate(() => {
      const el = document.querySelector(".modal.mod-settings .vertical-tab-content");
      return el ? { settings: el.querySelectorAll(".setting-item").length, text: el.textContent.slice(0, 200) } : null;
    });
    check.ok("settings tab renders", tab && tab.settings > 5, JSON.stringify(tab));
    await shot("settings");
  },
};
