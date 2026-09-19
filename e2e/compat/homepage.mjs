// homepage: "Set as homepage" from the active note, then "Open homepage" from
// elsewhere replaces the open note; the ribbon button does the same. (Opening
// on startup needs a persistent vault; the demo vault is in memory.)
import { openNote } from "./lib.mjs";

export default {
  plugins: ["homepage"],
  async run({ page, check, shot }) {
    await openNote(page, "Linking notes.md");
    const set = await page.evaluate(() => window.app.commands.executeCommandById("homepage:set-to-active-file"));
    check.ok("set-to-active-file command runs", set);
    await page.waitForTimeout(400);
    const saved = await page.evaluate(() => window.app.plugins.plugins.homepage.settings?.homepages?.["Main Homepage"]?.value);
    check.ok("homepage saved as the active note", saved === "Linking notes", saved);
    await openNote(page, "Formatting.md");
    await page.evaluate(() => window.app.commands.executeCommandById("homepage:open-homepage"));
    await page.waitForTimeout(1000);
    check.ok("open-homepage opens it", (await page.evaluate(() => window.app.workspace.getActiveFile()?.path)) === "Linking notes.md");
    await openNote(page, "Welcome.md");
    const ribbon = page.locator('.side-dock-ribbon-action[aria-label="Open homepage"]');
    check.ok("ribbon button exists", (await ribbon.count()) === 1);
    if (await ribbon.count()) {
      await ribbon.click();
      await page.waitForTimeout(1000);
      check.ok("ribbon button opens homepage", (await page.evaluate(() => window.app.workspace.getActiveFile()?.path)) === "Linking notes.md");
    }
    await page.evaluate(() => window.app.setting.open() || window.app.setting.openTabById("homepage"));
    await page.evaluate(() => window.app.setting.openTabById("homepage"));
    await page.waitForTimeout(600);
    check.ok("settings tab renders", (await page.locator(".modal .setting-item").count()) > 3);
    await shot("settings");
  },
};
