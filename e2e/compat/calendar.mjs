// Calendar (liamcain/obsidian-calendar-plugin): right-sidebar view, dots for
// existing daily notes, and click-a-day to create/open the daily note using the
// Daily notes core plugin's options (folder "Daily" in the demo vault).
export default {
  plugins: ["calendar"],
  async run({ page, check, shot }) {
    const state = await page.evaluate(() => {
      const leaf = app.workspace.getLeavesOfType("calendar")[0];
      return { leaves: app.workspace.getLeavesOfType("calendar").length, inRight: leaf?.getRoot() === app.workspace.rightSplit };
    });
    check.ok("calendar view created in the right sidebar on load", state.leaves === 1 && state.inRight, JSON.stringify(state));
    // As in Obsidian, the command's checkCallback hides it once the view exists;
    // the user reveals the sidebar tab.
    await page.evaluate(() => app.workspace.revealLeaf(app.workspace.getLeavesOfType("calendar")[0]));
    await page.waitForTimeout(800);
    const today = await page.evaluate(() => {
      const el = document.querySelector(".workspace-split.mod-right-split #calendar-container .day.today");
      return el ? { visible: el.getBoundingClientRect().width > 0, dot: !!el.querySelector(".dot") } : null;
    });
    check.ok("calendar visible in the right sidebar", today?.visible, JSON.stringify(today));
    check.ok("today shows a dot for the existing daily note", today?.dot);
    await shot("sidebar");

    const target = await page.evaluate(() => {
      const d = window.moment().date() === 20 ? 21 : 20;
      return { day: d, name: window.moment().date(d).format("YYYY-MM-DD") };
    });
    await page
      .locator("#calendar-container td .day:not(.adjacent-month)")
      .filter({ hasText: new RegExp(`^\\s*${target.day}\\s*$`) })
      .first()
      .click();
    await page.waitForSelector(".modal-container .mod-cta", { timeout: 5000 });
    await shot("confirm");
    await page.click(".modal-container .mod-cta");
    await page.waitForTimeout(1200);
    const created = await page.evaluate((name) => ({ exists: !!app.vault.getFileByPath(`Daily/${name}.md`), active: app.workspace.getActiveFile()?.path }), target.name);
    check.ok("clicking a day creates the daily note in the configured folder", created.exists, JSON.stringify(created));
    check.ok("and opens it", created.active === `Daily/${target.name}.md`, created.active);
    const dot = await page.evaluate((day) => {
      const cells = [...document.querySelectorAll("#calendar-container td .day:not(.adjacent-month)")];
      return !!cells.find((c) => c.firstChild?.textContent?.trim() === String(day))?.querySelector(".dot");
    }, target.day);
    check.ok("the new note gets a dot", dot);
    // Clicking today's cell opens the existing note without a prompt.
    await page.locator("#calendar-container .day.today").click();
    await page.waitForTimeout(800);
    const todayPath = await page.evaluate(() => [app.workspace.getActiveFile()?.path, `Daily/${window.moment().format("YYYY-MM-DD")}.md`]);
    check.ok("clicking today opens the existing daily note", todayPath[0] === todayPath[1], todayPath.join(" vs "));
    await shot("opened");
  },
};
