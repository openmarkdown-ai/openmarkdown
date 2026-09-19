// Remotely Save: settings tab renders its service choices; sync itself needs
// CORS-free requestUrl (the companion extension) and real credentials.
export default {
  plugins: ["remotely-save"],
  ignoreErrors: [/unsupported MIME type/, /blocked by CORS policy/],
  async run({ page, check, shot }) {
    await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById("remotely-save"); });
    await page.waitForTimeout(1000);
    const info = await page.evaluate(() => {
      const c = document.querySelector(".vertical-tab-content");
      const select = Array.from(c?.querySelectorAll("select") ?? []).find((s) => Array.from(s.options).some((o) => /s3|webdav|dropbox/i.test(o.value)));
      return { items: c?.querySelectorAll(".setting-item").length ?? 0, services: select ? Array.from(select.options).map((o) => o.value) : [], text: c?.textContent.slice(0, 80) };
    });
    check.ok("settings tab renders", info.items > 10, info.items);
    check.ok("lists remote services", info.services.length >= 3, info.services.join(","));
    await shot("settings");
    // Switching the service re-renders the matching section.
    const switched = await page.evaluate(async () => {
      const c = document.querySelector(".vertical-tab-content");
      const select = Array.from(c.querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.value === "webdav"));
      if (!select) return false;
      select.value = "webdav";
      select.dispatchEvent(new Event("change"));
      await new Promise((r) => setTimeout(r, 500));
      return /webdav/i.test(Array.from(c.querySelectorAll(".setting-item-name, h2, h3, summary")).filter((e) => e.offsetParent).map((e) => e.textContent).join(" "));
    });
    check.ok("choosing WebDAV shows WebDAV settings", switched);
    await page.evaluate(() => window.app.setting.close());
  },
};
