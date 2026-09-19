// Style Settings + Minimal Theme Settings with the Minimal theme installed.
// The theme's `/* @settings */` YAML must be discovered from the loaded
// stylesheets, listed in the Style Settings tab, and a change must apply to
// the document (a body class for a class-toggle, a CSS variable for a text).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const minimalDir = process.env.MINIMAL_DIR;

export default {
  plugins: ["obsidian-style-settings", "obsidian-minimal-settings"],
  // The Vite dev server has no service worker script; the built app does.
  ignoreErrors: [/unsupported MIME type/],
  options: {
    async before(page) {
      const dir = minimalDir ?? join(process.argv[2], "../obsidian-minimal");
      const css = readFileSync(existsSync(join(dir, "theme.css")) ? join(dir, "theme.css") : join(dir, "Minimal.css"), "utf8");
      const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
      await page.evaluate(async ({ css, manifest }) => {
        const a = window.app.vault.adapter;
        await a.mkdir(".obsidian/themes/Minimal");
        await a.write(".obsidian/themes/Minimal/manifest.json", manifest);
        await a.write(".obsidian/themes/Minimal/theme.css", css);
        await window.app.customCss.readThemes();
        await window.app.customCss.setCssTheme("Minimal");
      }, { css, manifest });
    },
  },
  async run({ page, check, shot }) {
    check.ok("Minimal theme active", await page.evaluate(() => window.app.customCss.theme === "Minimal" && (document.getElementById("vault-theme")?.textContent?.length ?? 0) > 100000));
    await page.waitForTimeout(800);
    const parsed = await page.evaluate(() => {
      const p = window.app.plugins.plugins["obsidian-style-settings"];
      return (p?.settingsList ?? []).map((s) => s.id);
    });
    check.ok("Style Settings parsed the theme's @settings blocks", parsed.includes("minimal-style"), parsed.join(","));

    await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById("obsidian-style-settings"); });
    await page.waitForTimeout(800);
    const tabText = await page.evaluate(() => document.querySelector(".vertical-tab-content")?.textContent ?? "");
    check.ok("Style Settings tab lists Minimal", /Minimal/.test(tabText), tabText.slice(0, 120));
    // Expand the Minimal section and its "Headings" group, then flip "H1 divider line".
    const toggled = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const root = document.querySelector(".vertical-tab-content");
      const headingByText = (t) => Array.from(root.querySelectorAll(".style-settings-heading")).find((h) => h.textContent.trim().startsWith(t));
      for (const name of ["Minimal", "Headings", "Level 1 Headings"]) {
        headingByText(name)?.click();
        await sleep(300);
      }
      const item = Array.from(root.querySelectorAll(".setting-item")).find((s) => s.querySelector(".setting-item-name")?.textContent.trim() === "H1 divider line");
      if (!item) return "no setting";
      item.querySelector(".checkbox-container")?.click();
      await sleep(300);
      return document.body.classList.contains("h1-l");
    });
    check.ok("toggling “H1 divider line” adds body.h1-l", toggled === true, toggled);
    await shot("style-settings-tab");
    // A variable-text setting writes a CSS variable.
    const variable = await page.evaluate(async () => {
      const p = window.app.plugins.plugins["obsidian-style-settings"];
      p.settingsManager.setSetting("minimal-cards-style", "cards-min-width", "250px");
      await new Promise((r) => setTimeout(r, 300));
      return getComputedStyle(document.body).getPropertyValue("--cards-min-width").trim();
    });
    check.ok("variable setting applies --cards-min-width", variable === "250px", variable);
    await page.evaluate(() => window.app.setting.close());

    // Minimal Theme Settings: its settings tab opens and a colour scheme toggle changes the body.
    await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById("obsidian-minimal-settings"); });
    await page.waitForTimeout(600);
    const mst = await page.evaluate(() => document.querySelector(".vertical-tab-content")?.querySelectorAll(".setting-item").length ?? 0);
    check.ok("Minimal Theme Settings tab renders settings", mst > 10, mst);
    await page.evaluate(() => window.app.setting.close());
    const cmd = await page.evaluate(async () => {
      const before = document.body.classList.contains("minimal-focus-mode");
      window.app.commands.executeCommandById("obsidian-minimal-settings:toggle-minimal-focus-mode");
      await new Promise((r) => setTimeout(r, 300));
      return { before, after: document.body.classList.contains("minimal-focus-mode"), cls: document.body.className };
    });
    check.ok("Minimal command toggles focus mode class", cmd.before !== cmd.after, JSON.stringify(cmd).slice(0, 200));
    await page.evaluate(() => window.app.workspace.openLinkText("Formatting", "", false));
    await page.waitForTimeout(800);
    await shot("minimal-formatting");
  },
};
