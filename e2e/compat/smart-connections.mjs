// Smart Connections: the environment loads, embeds the vault (transformers.js
// in a worker/iframe; the model is fetched from the network on first run),
// and the connections view lists notes related to the active one.
export default {
  plugins: ["smart-connections"],
  // The new-user "Getting started" story is an Electron <webview>; it stays blank.
  ignoreErrors: [/unsupported MIME type/, /blocked by CORS policy/],
  async run({ page, check, shot }) {
    await page.evaluate(() => window.app.workspace.openLinkText("Formatting", "", false));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.app.commands.executeCommandById("smart-connections:smart-connections-view"));
    const info = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let last = null;
      for (let i = 0; i < 60; i++) {
        const leaf = window.app.workspace.getLeavesOfType("smart-connections-view")[0];
        const el = leaf?.view?.containerEl;
        const results = el ? Array.from(el.querySelectorAll(".sc-result")).map((r) => r.textContent.trim().slice(0, 40)) : [];
        last = { leaf: !!leaf, results, text: el?.textContent.replace(/\s+/g, " ").slice(0, 160) };
        if (results.length) break;
        await sleep(1000);
      }
      return last;
    });
    check.ok("connections view opens", info.leaf, info.text);
    check.ok("lists connections for the active note", info.results.length > 0, info.results.slice(0, 4).join(" | "));
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
    await shot("view");
  },
};
