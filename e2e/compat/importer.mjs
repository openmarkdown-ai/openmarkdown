// Importer: the modal opens, lists its formats, and a format shows its file picker.
export default {
  plugins: ["obsidian-importer"],
  ignoreErrors: [/unsupported MIME type/],
  async run({ page, check, shot }) {
    await page.evaluate(() => window.app.commands.executeCommandById("obsidian-importer:open-modal"));
    await page.waitForTimeout(800);
    const info = await page.evaluate(() => {
      const modal = document.querySelector(".modal-container .modal");
      return { open: !!modal, title: modal?.querySelector(".modal-title")?.textContent, rows: Array.from(modal?.querySelectorAll(".setting-item-name") ?? []).map((e) => e.textContent).filter(Boolean) };
    });
    check.ok("importer modal opens", info.open, info.title);
    check.ok("lists import formats", info.rows.length >= 5, info.rows.slice(0, 6).join(","));
    await page.fill(".modal-container .modal input[type=search], .modal-container .modal input", "markdown");
    await page.waitForTimeout(300);
    const filtered = await page.evaluate(() => Array.from(document.querySelectorAll(".modal-container .modal .setting-item-name")).map((e) => e.textContent).filter(Boolean));
    check.ok("filter narrows the list", filtered.length >= 1 && filtered.length < info.rows.length && /Markdown/.test(filtered[0]), filtered.join(","));
    await page.evaluate(() => Array.from(document.querySelectorAll(".modal-container .modal .setting-item")).find((s) => /^Markdown/.test(s.querySelector(".setting-item-name")?.textContent ?? ""))?.click());
    await page.waitForTimeout(600);
    const picked = await page.evaluate(() => {
      const modal = document.querySelector(".modal-container .modal");
      return { title: modal.querySelector(".modal-title")?.textContent, buttons: Array.from(modal.querySelectorAll("button")).map((b) => b.textContent.trim()).filter(Boolean), settings: modal.querySelectorAll(".setting-item").length };
    });
    check.ok("choosing a format shows its settings and import button", picked.settings >= 2 && picked.buttons.some((b) => /import|continue/i.test(b)), JSON.stringify(picked));
    await shot("modal");
    // Import a real Markdown file through the browser file picker it falls back to.
    const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
    await page.evaluate(() => Array.from(document.querySelectorAll(".modal-container .modal .setting-item")).find((s) => /Choose files/.test(s.textContent))?.click());
    const fc = await chooser.catch(() => null);
    check.ok("“Choose files” opens a browser file picker", !!fc);
    if (fc) {
      await fc.setFiles([{ name: "Imported note.md", mimeType: "text/markdown", buffer: Buffer.from("# Imported note\n\nHello from the importer. [[Welcome]]\n") }]);
      await page.waitForTimeout(600);
      await page.evaluate(() => Array.from(document.querySelectorAll(".modal-container .modal button")).find((b) => /continue/i.test(b.textContent))?.click());
      await page.waitForTimeout(800);
      // Later screens (output folder, then Import) — press the primary button until the file exists.
      const imported = await page.evaluate(async () => {
        for (let i = 0; i < 6; i++) {
          const f = window.app.vault.getMarkdownFiles().find((f) => f.basename === "Imported note");
          if (f) return { path: f.path, text: await window.app.vault.read(f) };
          const btn = Array.from(document.querySelectorAll(".modal-container .modal button.mod-cta, .modal-container .modal button")).find((b) => /^(start import|import|continue|done)/i.test(b.textContent.trim()) && !b.disabled);
          btn?.click();
          await new Promise((r) => setTimeout(r, 1200));
        }
        return Array.from(document.querySelectorAll(".modal-container .modal")).map((m) => m.textContent.slice(0, 200)).join("");
      });
      check.ok("the file is imported into the vault", typeof imported === "object" && /Hello from the importer/.test(imported.text), JSON.stringify(imported).slice(0, 200));
      await shot("imported");
    }
  },
};
