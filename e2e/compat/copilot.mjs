// Copilot: the chat view opens in the right sidebar with an input; model calls
// need a provider key and CORS-free requestUrl, so none are made.
export default {
  plugins: ["copilot"],
  ignoreErrors: [/unsupported MIME type/, /blocked by CORS policy/],
  async run({ page, check, shot }) {
    await page.evaluate(() => window.app.commands.executeCommandById("copilot:chat-open-window"));
    await page.waitForTimeout(2500);
    const info = await page.evaluate(() => {
      const leaf = window.app.workspace.getLeavesOfType("copilot-chat-view")[0];
      const el = leaf?.view?.containerEl;
      return { leaf: !!leaf, input: !!el?.querySelector("textarea, [contenteditable=true]"), text: el?.textContent.slice(0, 120) };
    });
    check.ok("chat view opens", info.leaf, info.text);
    check.ok("chat input renders", info.input);
    await shot("chat");
    await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById("copilot"); });
    await page.waitForTimeout(1200);
    const items = await page.evaluate(() => document.querySelector(".vertical-tab-content")?.textContent.length ?? 0);
    check.ok("settings tab renders", items > 200, items);
    await page.evaluate(() => window.app.setting.close());
  },
};
