// QuickAdd (quickadd): a Capture choice is added from its settings tab, pointed
// at a note, and run from "QuickAdd: Run QuickAdd" — the choice picker, the
// value prompt, and the text appended to the target note.
import { openNote, writeNote } from "./lib.mjs";

export default {
  ignoreErrors: [/unsupported MIME type/],
  plugins: ["quickadd"],
  async run({ page, check, shot }) {
    await writeNote(page, "Inbox.md", "# Inbox\n");
    await page.evaluate(() => { app.setting.open(); app.setting.openTabById("quickadd"); });
    await page.waitForTimeout(1200);
    const tab = await page.evaluate(() => {
      const el = document.querySelector(".modal.mod-settings .vertical-tab-content");
      return { text: el?.textContent.slice(0, 120), inputs: el?.querySelectorAll("input[type=text], input:not([type])").length, selects: el?.querySelectorAll("select").length, buttons: [...(el?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 10) };
    });
    check.ok("settings tab renders the choice builder", tab.inputs > 0, JSON.stringify(tab));
    await shot("settings");
    // Add a Capture choice through the UI: "New choice" ▸ Capture, then name it.
    await page.click(".modal.mod-settings button:has-text('New choice')");
    await page.waitForTimeout(400);
    const menu = await page.evaluate(() => [...document.querySelectorAll(".menu .menu-item")].map((e) => e.textContent.trim()));
    check.ok("New choice opens a menu of choice types", menu.some((t) => /capture/i.test(t)), JSON.stringify(menu));
    await shot("menu");
    await page.click(".menu .menu-item:has-text('Capture')");
    await page.waitForTimeout(500);
    // The choice builder opens; set "Capture to" through its input and press Done.
    const target = page.locator(".modal input[placeholder*='DATE']").first();
    check.ok("the choice builder opens with a Capture-to field", (await target.count()) === 1);
    await target.click();
    await target.fill("Inbox.md");
    await page.waitForTimeout(300);
    await shot("builder");
    await page.click(".modal button:has-text('Done')");
    await page.waitForTimeout(600);
    const added = await page.evaluate(() => app.plugins.plugins.quickadd.settings.choices.map((c) => `${c.name}:${c.type}:${c.captureTo}`).join(","));
    check.ok("Add Choice creates a Capture choice", /New capture:Capture:Inbox\.md/.test(added), added);
    await page.evaluate(() => { document.querySelectorAll(".modal-container").forEach((m) => m !== document.querySelector(".modal.mod-settings")?.parentElement && m.querySelector(".modal-close-button")?.click()); app.setting.close(); });
    await page.waitForTimeout(300);
    await openNote(page, "Welcome.md", "source");
    await page.evaluate(() => app.commands.executeCommandById("quickadd:runQuickAdd"));
    await page.waitForTimeout(600);
    const picker = await page.evaluate(() => [...document.querySelectorAll(".prompt .suggestion-item")].map((e) => e.textContent.trim()));
    check.ok("Run QuickAdd lists the choice", picker.some((t) => t.includes("New capture")), JSON.stringify(picker));
    await page.keyboard.type("New capture");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    const prompt = await page.evaluate(() => {
      const m = [...document.querySelectorAll(".modal-container .modal")].pop();
      return m ? { cls: m.className, text: m.textContent.slice(0, 80), input: !!m.querySelector("input, textarea") } : null;
    });
    check.ok("the capture prompt asks for a value", prompt?.input, JSON.stringify(prompt));
    await shot("prompt");
    await page.keyboard.type("buy milk");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    const inbox = await page.evaluate(() => app.vault.adapter.read("Inbox.md"));
    check.ok("the value is captured into the note", inbox.includes("buy milk"), JSON.stringify(inbox));
  },
};
