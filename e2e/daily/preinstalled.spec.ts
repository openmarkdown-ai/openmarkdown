/**
 * Core plugins vs pre-installed plugins.
 *
 * Obsidian's own core plugins stay in Settings → Core plugins. Features
 * OpenMarkdown adds are pre-installed plugins: listed in Settings → Community
 * plugins, toggleable, uninstallable and reinstallable, with their state in
 * `.obsidian/openmarkdown-plugins.json` so the files Obsidian reads stay clean.
 *
 * Screenshots go to $PRE_SHOTS (or the test output folder).
 */
import { expect, test, type Page } from "@playwright/test";

/** Obsidian's core plugins that OpenMarkdown implements (research doc §3.0). */
const OBSIDIAN_CORE = [
  "audio-recorder",
  "backlink",
  "bases",
  "bookmarks",
  "canvas",
  "command-palette",
  "daily-notes",
  "editor-status",
  "file-explorer",
  "file-recovery",
  "footnotes",
  "global-search",
  "graph",
  "markdown-importer",
  "note-composer",
  "outgoing-link",
  "outline",
  "page-preview",
  "properties",
  "publish",
  "random-note",
  "slash-command",
  "slides",
  "switcher",
  "tag-pane",
  "templates",
  "webviewer",
  "word-count",
  "workspaces",
  "zk-prefixer",
];

const PREINSTALLED = [
  "ai-query",
  "ai-review",
  "ai-suggest",
  "ai-tools",
  "backup",
  "calendar",
  "citations",
  "export",
  "formatting-toolbar",
  "grammar",
  "importer",
  "local-images",
  "media",
  "natural-dates",
  "ocr",
  "opensync",
  "periodic-notes",
  "quick-capture",
  "reminders",
  "semantic",
  "smart-paste",
  "transcribe",
  "trash",
  "vault-chat",
  "voice",
  "writing-focus",
];

const STATE = ".obsidian/openmarkdown-plugins.json";

async function waitReady(page: Page) {
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
  await page.waitForTimeout(300);
}

async function openDemo(page: Page) {
  await page.routeWebSocket(/.*/, () => {});
  await page.goto("/?vault=demo");
  await waitReady(page);
}

/** A browser (OPFS) vault that survives reloads, optionally with starting files. */
async function createVault(page: Page, files: Record<string, string> = {}): Promise<string> {
  await page.routeWebSocket(/.*/, () => {});
  await page.goto("/?choose=1");
  await page.waitForSelector(".vault-starter", { timeout: 30_000 });
  return page.evaluate(async (files) => {
    const id = "pre" + Math.random().toString(16).slice(2, 12);
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle("vaults", { create: true })).getDirectoryHandle(id, { create: true });
    for (const [path, content] of Object.entries({ "Welcome.md": "# Welcome\n", ...files })) {
      const segs = path.split("/");
      const name = segs.pop()!;
      let d = dir;
      for (const s of segs) d = await d.getDirectoryHandle(s, { create: true });
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(content);
      await w.close();
    }
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("vault-app");
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction("handles", "readwrite");
        t.objectStore("handles").put({ id, name: `Pre ${id}`, kind: "browser", lastOpened: Date.now() }, `vault:${id}`);
        t.oncomplete = () => {
          db.close();
          resolve();
        };
        t.onerror = () => reject(t.error);
      };
      req.onerror = () => reject(req.error);
    });
    return id;
  }, files);
}

async function openVault(page: Page, id: string) {
  await page.goto(`/?vault=${id}`);
  await waitReady(page);
}

async function readJson(page: Page, path: string): Promise<any> {
  return page.evaluate(async (p) => {
    const a = (window as any).app.vault.adapter;
    return (await a.exists(p)) ? JSON.parse(await a.read(p)) : null;
  }, path);
}

async function openSettings(page: Page, tab: string) {
  await page.evaluate((tab) => {
    const s = (window as any).app.setting;
    s.open();
    s.openTabById(tab);
  }, tab);
  await page.waitForSelector(".modal.mod-settings .vertical-tab-content", { timeout: 10_000 });
}

async function closeSettings(page: Page) {
  await page.evaluate(() => (window as any).app.setting.close());
}

/** Ids of the setting tabs listed under a sidebar heading. */
async function sidebarGroup(page: Page, title: string): Promise<string[]> {
  return page.evaluate((title) => {
    const groups = Array.from(document.querySelectorAll<HTMLElement>(".modal.mod-settings .vertical-tab-header-group"));
    const g = groups.find((el) => el.querySelector(".vertical-tab-header-group-title")?.textContent === title);
    return g ? Array.from(g.querySelectorAll<HTMLElement>(".vertical-tab-nav-item")).map((el) => el.dataset.settingId ?? "") : [];
  }, title);
}

async function shots(page: Page, name: string) {
  const dir = process.env.PRE_SHOTS;
  const path = dir ? `${dir}/${name}.png` : test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
}

test("Core plugins lists only Obsidian's core plugins; Community plugins lists every pre-installed plugin", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openDemo(page);

  await openSettings(page, "plugins");
  const core = await page.locator(".vertical-tab-content .setting-item[data-plugin-id]").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.pluginId!));
  expect(core.sort()).toEqual([...OBSIDIAN_CORE].sort());
  await expect(page.locator(".vault-preinstalled-pointer")).toBeVisible();

  await openSettings(page, "community-plugins");
  const rows = page.locator(".vault-preinstalled-plugin");
  const ids = await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.pluginId!));
  expect(ids.sort()).toEqual([...PREINSTALLED].sort());
  for (const id of PREINSTALLED) {
    const row = page.locator(`.vault-preinstalled-plugin[data-plugin-id="${id}"]`);
    await expect(row.locator(".vault-plugin-tag")).toHaveText("Pre-installed");
    await expect(row.locator(".vault-plugin-meta").first()).toContainText("By OpenMarkdown");
    await expect(row.locator(".checkbox-container")).toHaveCount(1);
    await expect(row.locator(".vault-preinstalled-uninstall")).toHaveCount(1);
  }

  // The app API still reaches them, with manifest-like metadata.
  const api = await page.evaluate((ids) => {
    const ip = (window as any).app.internalPlugins;
    return ids.map((id: string) => {
      const w = ip.getPluginById(id);
      return { id, found: !!w, author: w?.manifest.author, version: w?.manifest.version, pre: ip.isPreinstalled(id) };
    });
  }, PREINSTALLED);
  for (const r of api) expect(r).toEqual({ id: r.id, found: true, author: "OpenMarkdown", version: expect.stringMatching(/^\d+\.\d+\.\d+/), pre: true });
  const coreApi = await page.evaluate((ids) => ids.map((id: string) => (window as any).app.internalPlugins.isPreinstalled(id)), OBSIDIAN_CORE);
  expect(coreApi.every((x: boolean) => !x)).toBe(true);

  // Setting tabs of pre-installed plugins sit under Community plugins in the sidebar.
  const communityTabs = await sidebarGroup(page, "Community plugins");
  const coreTabs = await sidebarGroup(page, "Core plugins");
  expect(communityTabs).toEqual(expect.arrayContaining(["quick-capture", "export"]));
  expect(coreTabs).not.toContain("quick-capture");
  expect(coreTabs).not.toContain("export");
  expect(coreTabs).toEqual(expect.arrayContaining(["daily-notes", "templates"]));
  expect(errors).toEqual([]);
});

test("toggle, uninstall and reinstall a pre-installed plugin from Settings → Community plugins", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openDemo(page);
  await page.evaluate(() => (window as any).app.saveLocalStorage("reminders-fired", ["x"]));

  // Toggle on (Reminders is off by default).
  await openSettings(page, "community-plugins");
  const row = page.locator('.vault-preinstalled-plugin[data-plugin-id="reminders"]');
  await row.scrollIntoViewIfNeeded();
  await row.locator(".checkbox-container").click();
  await expect.poll(() => page.evaluate(() => !!(window as any).app.internalPlugins.getEnabledPluginById("reminders")), { timeout: 15_000 }).toBe(true);
  await expect(page.locator('.vault-preinstalled-plugin[data-plugin-id="reminders"] .checkbox-container')).toHaveClass(/is-enabled/);
  await expect(page.locator('.vault-preinstalled-plugin[data-plugin-id="reminders"] [aria-label="Options"]')).toHaveCount(1);
  expect(await sidebarGroup(page, "Community plugins")).toContain("reminders");
  expect((await readJson(page, STATE)).enabled.reminders).toBe(true);
  const core = await readJson(page, ".obsidian/core-plugins.json");
  expect(core === null || !("reminders" in core)).toBe(true);

  // Give it options, a view and a status bar item.
  await page.evaluate(async () => {
    const a = (window as any).app;
    const inst = a.internalPlugins.getPluginById("reminders").instance;
    inst.options.defaultTime = "08:15";
    await inst.saveOptions();
    a.statusBar.containerEl.querySelector(".plugin-reminders")?.setAttribute("data-test", "1");
  });
  await closeSettings(page);
  expect(await page.evaluate(() => (window as any).app.commands.executeCommandById("reminders:show-list"))).toBeTruthy();
  await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getLeavesOfType("reminders-list").length), { timeout: 10_000 }).toBe(1);
  expect(await page.evaluate(() => (window as any).app.vault.adapter.exists(".obsidian/reminders.json"))).toBe(true);
  await expect(page.locator(".status-bar .plugin-reminders")).toHaveCount(1);

  // Uninstall: the confirmation says what goes.
  await openSettings(page, "community-plugins");
  await page.locator('.vault-preinstalled-plugin[data-plugin-id="reminders"] .vault-preinstalled-uninstall').click();
  const modal = page.locator(".modal.mod-confirmation");
  await expect(modal).toContainText("Uninstall Reminders?");
  await expect(modal).toContainText(".obsidian/reminders.json");
  await expect(modal).toContainText("reminders already shown");
  await page.waitForTimeout(400);
  await shots(page, "uninstall-confirm");
  await modal.getByRole("button", { name: "Uninstall" }).click();
  await expect(page.locator('.vault-removed-plugin[data-plugin-id="reminders"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('.vault-preinstalled-plugin[data-plugin-id="reminders"]')).toHaveCount(0);
  expect(await sidebarGroup(page, "Community plugins")).not.toContain("reminders");

  const gone = await page.evaluate(async () => {
    const a = (window as any).app;
    return {
      byId: a.internalPlugins.getPluginById("reminders"),
      enabled: a.internalPlugins.getEnabledPluginById("reminders"),
      commands: Object.keys(a.commands.commands).filter((c) => c.startsWith("reminders:")),
      leaves: a.workspace.getLeavesOfType("reminders-list").length,
      view: !!a.viewRegistry.getViewCreatorByType?.("reminders-list"),
      status: a.statusBar.containerEl.querySelectorAll(".plugin-reminders").length,
      tab: a.setting.pluginTabs.some((t: any) => t.plugin?.manifest?.id === "reminders"),
      options: await a.vault.adapter.exists(".obsidian/reminders.json"),
      fired: a.loadLocalStorage("reminders-fired"),
    };
  });
  expect(gone).toEqual({ byId: null, enabled: null, commands: [], leaves: 0, view: false, status: 0, tab: false, options: false, fired: null });
  const state = await readJson(page, STATE);
  expect(state.uninstalled).toContain("reminders");
  expect(state.enabled.reminders).toBeUndefined();
  // Turning it on through the API while uninstalled does nothing.
  await page.evaluate(() => (window as any).app.internalPlugins.setEnabled("reminders", true));
  expect(await page.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("reminders"))).toBeNull();

  // Reinstall: offline and instant, default settings, default state (off), then on again.
  await page.locator('.vault-removed-plugin[data-plugin-id="reminders"] button', { hasText: "Reinstall" }).click();
  await expect(page.locator('.vault-preinstalled-plugin[data-plugin-id="reminders"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator(".vault-removed-plugin")).toHaveCount(0);
  expect((await readJson(page, STATE)).uninstalled).not.toContain("reminders");
  await page.locator('.vault-preinstalled-plugin[data-plugin-id="reminders"] .checkbox-container').click();
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).app.commands.commands).filter((c) => c.startsWith("reminders:")).length), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as any).app.internalPlugins.getPluginById("reminders").instance.options.defaultTime)).toBe("09:00");
  expect(await sidebarGroup(page, "Community plugins")).toContain("reminders");
  expect(errors).toEqual([]);
});

test("uninstalling an on-by-default plugin removes its ribbon icon and commands; reinstall brings them back", async ({ page }) => {
  await openDemo(page);
  const probe = () =>
    page.evaluate(() => {
      const a = (window as any).app;
      return {
        ribbon: a.workspace.leftRibbon.items.some((i: any) => i.id.startsWith("quick-capture:")),
        commands: !!a.commands.commands["quick-capture:open"],
        tab: a.setting.pluginTabs.some((t: any) => t.id === "quick-capture"),
      };
    });
  expect(await probe()).toEqual({ ribbon: true, commands: true, tab: true });
  expect(await page.evaluate(() => (window as any).app.internalPlugins.uninstall("quick-capture"))).toBe(true);
  expect(await probe()).toEqual({ ribbon: false, commands: false, tab: false });
  await expect(page.locator('.side-dock-ribbon-action[aria-label="Quick capture"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).app.internalPlugins.reinstall("quick-capture"))).toBe(true);
  expect(await probe()).toEqual({ ribbon: true, commands: true, tab: true });
});

test("state survives a reload, migrates out of core-plugins.json once, and Obsidian's config files stay clean", async ({ page }) => {
  const id = await createVault(page, {
    ".obsidian/core-plugins.json": JSON.stringify({ backlink: true, graph: false, calendar: true, "writing-focus": false, markdown: true, sync: false }),
    ".obsidian/community-plugins.json": "[]",
  });
  await openVault(page, id);

  // Migration: pre-installed entries moved, app internals dropped, Obsidian ids kept.
  const migrated = await readJson(page, STATE);
  expect(migrated.enabled).toMatchObject({ calendar: true, "writing-focus": false });
  const core1 = await readJson(page, ".obsidian/core-plugins.json");
  expect(core1).toMatchObject({ backlink: true, graph: false, sync: false, templates: true });
  expect(Object.keys(core1).filter((k) => !OBSIDIAN_CORE.includes(k)).sort()).toEqual(["sync"]);
  const live = await page.evaluate(() => {
    const ip = (window as any).app.internalPlugins;
    return { calendar: !!ip.getEnabledPluginById("calendar"), focus: !!ip.getEnabledPluginById("writing-focus"), graph: !!ip.getEnabledPluginById("graph") };
  });
  expect(live).toEqual({ calendar: true, focus: false, graph: false });

  // Change things, then reload.
  await page.evaluate(async () => {
    const ip = (window as any).app.internalPlugins;
    await ip.uninstall("trash");
    await ip.setEnabled("natural-dates", true);
    await ip.setEnabled("calendar", false);
    await ip.setEnabled("graph", true);
  });
  await openVault(page, id);
  const after = await page.evaluate(() => {
    const a = (window as any).app;
    const ip = a.internalPlugins;
    return {
      trash: ip.getPluginById("trash"),
      trashCommands: Object.keys(a.commands.commands).filter((c) => c.startsWith("trash:")),
      dates: !!ip.getEnabledPluginById("natural-dates"),
      calendar: !!ip.getEnabledPluginById("calendar"),
      graph: !!ip.getEnabledPluginById("graph"),
    };
  });
  expect(after).toEqual({ trash: null, trashCommands: [], dates: true, calendar: false, graph: true });

  // A second load does not re-migrate (core-plugins.json edits of pre-installed ids are ignored).
  const core2 = await readJson(page, ".obsidian/core-plugins.json");
  const community = await readJson(page, ".obsidian/community-plugins.json");
  const all = [...PREINSTALLED, "markdown", "media-views", "external-embeds", "note-titles", "link-tabs", "export-pdf"];
  expect(Object.keys(core2).filter((k) => all.includes(k))).toEqual([]);
  expect(core2).toMatchObject({ backlink: true, graph: true });
  expect(community).toEqual([]);
  const state = await readJson(page, STATE);
  expect(state).toEqual({ uninstalled: ["trash"], enabled: expect.objectContaining({ "natural-dates": true, calendar: false }) });

  await openSettings(page, "community-plugins");
  await expect(page.locator('.vault-removed-plugin[data-plugin-id="trash"]')).toHaveCount(1);
  await page.locator('.vault-removed-plugin[data-plugin-id="trash"] button', { hasText: "Reinstall" }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).app.commands.commands["trash:open"]), { timeout: 15_000 }).toBe(true);
  expect((await readJson(page, STATE)).uninstalled).toEqual([]);
});

test("restricted mode does not hide or disable pre-installed plugins", async ({ page }) => {
  await openDemo(page);
  expect(await page.evaluate(() => (window as any).app.plugins.isEnabled())).toBe(false);
  await openSettings(page, "community-plugins");
  await expect(page.locator(".vault-restricted-mode")).toContainText("Restricted mode is on");
  await expect(page.locator(".vault-preinstalled-plugin")).toHaveCount(PREINSTALLED.length);
  const toggle = page.locator('.vault-preinstalled-plugin[data-plugin-id="natural-dates"] .checkbox-container');
  await expect(toggle).not.toHaveClass(/is-disabled/);
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  await expect.poll(() => page.evaluate(() => !!(window as any).app.internalPlugins.getEnabledPluginById("natural-dates")), { timeout: 10_000 }).toBe(true);

  // Turning community plugins on and back off leaves pre-installed plugins running.
  await page.evaluate(async () => {
    const p = (window as any).app.plugins;
    await p.setEnable(true);
    await p.setEnable(false);
  });
  expect(await page.evaluate(() => !!(window as any).app.internalPlugins.getEnabledPluginById("natural-dates"))).toBe(true);
  expect(await page.evaluate(() => !!(window as any).app.internalPlugins.getEnabledPluginById("quick-capture"))).toBe(true);
});

test("uninstall runs clean-up; other plugins degrade when one they use is gone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openDemo(page);
  // Backups: schedule state and folder handle go; nothing else is touched.
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.internalPlugins.setEnabled("backup", true);
    a.saveLocalStorage("backup-last", 123);
  });
  await expect.poll(() => page.evaluate(() => !!(window as any).app.commands.commands["backup:create-now"]), { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => (window as any).app.internalPlugins.uninstall("backup"));
  expect(await page.evaluate(() => (window as any).app.loadLocalStorage("backup-last"))).toBeNull();
  expect(await page.evaluate(() => !!(window as any).app.commands.commands["backup:create-now"])).toBe(false);

  // Related notes: its index database is deleted.
  const dbName = await page.evaluate(() => `openmarkdown-semantic:${(window as any).app.appId}`);
  await page.evaluate(
    (name) =>
      new Promise<void>((resolve) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore("probe");
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
      }),
    dbName,
  );
  const hasDb = () => page.evaluate(async (name) => ((await indexedDB.databases()) as { name?: string }[]).some((d) => d.name === name), dbName);
  expect(await hasDb()).toBe(true);
  await page.evaluate(() => (window as any).app.internalPlugins.uninstall("semantic"));
  expect(await hasDb()).toBe(false);

  // Chat with vault and AI suggestions still load, and say what is missing.
  await page.evaluate(async () => {
    const ip = (window as any).app.internalPlugins;
    await ip.setEnabled("vault-chat", true);
    await ip.setEnabled("ai-suggest", true);
  });
  await expect.poll(() => page.evaluate(() => !!(window as any).app.internalPlugins.getEnabledPluginById("vault-chat")?.plugin?.impl), { timeout: 15_000 }).toBe(true);
  const chatCommand = await page.evaluate(() => Object.keys((window as any).app.commands.commands).find((c) => c.startsWith("vault-chat:") && /open|show/.test(c)) ?? null);
  expect(chatCommand).not.toBeNull();
  await page.evaluate((c) => (window as any).app.commands.executeCommandById(c), chatCommand);
  await expect(page.locator(".vault-chat-view")).toBeVisible({ timeout: 10_000 });
  // The AI platform is off in a fresh vault, so the first reason may be "needs AI"; the uninstall reason shows once AI is ready.
  await expect(page.locator(".vault-chat-notice")).not.toBeEmpty({ timeout: 10_000 });
  expect(await page.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("semantic"))).toBeNull();
  expect(errors).toEqual([]);
});

test("uninstalling Sync on a synced vault asks before forgetting this device's keys", async ({ page }) => {
  await openDemo(page);
  const appId = await page.evaluate(() => (window as any).app.appId);
  const putRecord = () =>
    page.evaluate(
      (appId) =>
        new Promise<void>((resolve, reject) => {
          const r = indexedDB.open("openmarkdown-sync", 1);
          r.onupgradeneeded = () => {
            if (!r.result.objectStoreNames.contains("sync")) r.result.createObjectStore("sync");
          };
          r.onsuccess = () => {
            const t = r.result.transaction("sync", "readwrite");
            t.objectStore("sync").put({ v: 1, vaultId: appId, accountId: "test-acct", namespace: "n", deviceLabel: "Test" }, `device:${appId}`);
            t.oncomplete = () => {
              r.result.close();
              resolve();
            };
            t.onerror = () => reject(t.error);
          };
        }),
      appId,
    );
  const hasRecord = () =>
    page.evaluate(
      (appId) =>
        new Promise<boolean>((resolve) => {
          const r = indexedDB.open("openmarkdown-sync", 1);
          r.onsuccess = () => {
            const g = r.result.transaction("sync").objectStore("sync").get(`device:${appId}`);
            g.onsuccess = () => {
              r.result.close();
              resolve(!!g.result);
            };
            g.onerror = () => resolve(false);
          };
          r.onerror = () => resolve(false);
        }),
      appId,
    );
  await putRecord();
  expect(await hasRecord()).toBe(true);

  await openSettings(page, "community-plugins");
  const uninstall = page.locator('.vault-preinstalled-plugin[data-plugin-id="opensync"] .vault-preinstalled-uninstall');
  await uninstall.scrollIntoViewIfNeeded();
  await uninstall.click();
  await page.locator(".modal.mod-confirmation").getByRole("button", { name: "Uninstall" }).click();
  const second = page.locator(".modal.mod-confirmation", { hasText: "Disconnect this vault from sync?" });
  await expect(second).toBeVisible({ timeout: 10_000 });
  await second.getByRole("button", { name: "Cancel" }).click();
  // Declined: nothing is uninstalled and the keys stay.
  expect(await page.evaluate(() => !!(window as any).app.internalPlugins.getPluginById("opensync"))).toBe(true);
  expect(await hasRecord()).toBe(true);

  await uninstall.click();
  await page.locator(".modal.mod-confirmation").getByRole("button", { name: "Uninstall" }).click();
  await page.locator(".modal.mod-confirmation", { hasText: "Disconnect this vault from sync?" }).getByRole("button", { name: "Disconnect and uninstall" }).click();
  await expect(page.locator('.vault-removed-plugin[data-plugin-id="opensync"]')).toHaveCount(1, { timeout: 15_000 });
  expect(await hasRecord()).toBe(false);
  expect(await sidebarGroup(page, "Community plugins")).not.toContain("sync");
});

test("screenshots: pre-installed plugins in Community plugins (phone, light and dark)", async ({ browser }) => {
  for (const dark of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: dark ? "dark" : "light", baseURL: test.info().project.use.baseURL, hasTouch: true });
    const page = await ctx.newPage();
    await openDemo(page);
    await page.evaluate(async (dark) => {
      const a = (window as any).app;
      document.body.toggleClass("theme-dark", dark);
      document.body.toggleClass("theme-light", !dark);
      await a.internalPlugins.uninstall("ai-review");
    }, dark);
    await openSettings(page, "community-plugins");
    await page.evaluate(() => {
      const intro = document.querySelector<HTMLElement>(".vault-preinstalled-intro");
      intro?.scrollIntoView({ block: "start" });
      const scroller = intro?.closest<HTMLElement>(".vertical-tab-content-container");
      if (scroller) scroller.scrollTop -= 110;
    });
    await page.waitForTimeout(300);
    await shots(page, `preinstalled-phone-${dark ? "dark" : "light"}`);
    await page.locator(".vault-removed-plugin").first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await shots(page, `removed-phone-${dark ? "dark" : "light"}`);
    await ctx.close();
  }
});
