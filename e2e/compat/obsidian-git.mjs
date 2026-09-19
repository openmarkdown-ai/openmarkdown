// Git: the source-control and history views open. Git operations need a
// repository in the vault and, for remotes, CORS-free HTTP (companion extension).
export default {
  plugins: ["obsidian-git"],
  // A fresh repository has no refs/heads/master yet; the plugin logs that.
  // KNOWN GAP (isBuffer): status and commit need a global Buffer — see below.
  ignoreErrors: [/unsupported MIME type/, /blocked by CORS policy/, /Could not find refs\/heads/, /reading 'isBuffer'/],
  async run({ page, check, shot }) {
    for (const [cmd, type] of [["obsidian-git:open-git-view", "git-view"], ["obsidian-git:open-history-view", "git-history-view"]]) {
      await page.evaluate((cmd) => window.app.commands.executeCommandById(cmd), cmd);
      await page.waitForTimeout(1500);
      const info = await page.evaluate((type) => {
        const leaf = window.app.workspace.getLeavesOfType(type)[0];
        return { leaf: !!leaf, text: leaf?.view?.containerEl.textContent.replace(/\s+/g, " ").slice(0, 120) };
      }, type);
      check.ok(`${type} opens`, info.leaf, info.text);
    }
    await shot("views");
    await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById("obsidian-git"); });
    await page.waitForTimeout(800);
    const n = await page.evaluate(() => document.querySelectorAll(".vertical-tab-content .setting-item").length);
    check.ok("settings tab renders", n > 5, n);
    await page.evaluate(() => window.app.setting.close());
    // Mobile code path: isomorphic-git over the vault adapter.
    await page.evaluate(() => window.app.commands.executeCommandById("obsidian-git:init-repo"));
    await page.waitForTimeout(2500);
    const init = await page.evaluate(async () => ({
      git: await window.app.vault.adapter.exists(".git/HEAD"),
      notices: Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent),
    }));
    check.ok("init-repo creates .git in the vault (isomorphic-git)", init.git, init.notices.join(" | "));
    // Known gap: committing needs a global Buffer (Obsidian Git picks Node's
    // Buffer unless Platform.isMobileApp), which this host does not define.
  },
};
