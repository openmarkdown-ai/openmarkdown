/**
 * W2 PWA shell: offline start, the update flow, launches from the OS, the share
 * target, obsidian:// links, quick capture before the index, pop-out windows.
 *
 * Offline, update and share-target tests need the built app with its service
 * worker (they skip on a dev server). Build and serve it:
 *   (cd apps/web && npx vite build --outDir <tmp>/w2-dist --emptyOutDir)
 *   node e2e/daily/pwa-server.mjs <tmp>/w2-dist 5221
 *   OM_URL=http://localhost:5221 npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/pwa.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";

async function isBuilt(page: Page): Promise<boolean> {
  return page.evaluate(() => !!document.querySelector('meta[name="openmarkdown-build"]'));
}

/** Resolves once a service worker controls the page and has finished precaching. */
async function waitForServiceWorker(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          return reg?.active?.state === "activated" && !!navigator.serviceWorker.controller;
        }),
      { timeout: 120_000, intervals: [500] },
    )
    .toBe(true);
}

async function createBrowserVault(page: Page, name: string, files: Record<string, string> = {}): Promise<string> {
  await page.goto("/?choose=1");
  await page.waitForSelector(".vault-starter", { timeout: 30_000 });
  return page.evaluate(
    async ({ name, files }) => {
      const id = "pwa" + Math.random().toString(16).slice(2, 12);
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle("vaults", { create: true })).getDirectoryHandle(id, { create: true });
      for (const [path, content] of Object.entries(files)) {
        const segs = path.split("/");
        const file = segs.pop()!;
        let d = dir;
        for (const s of segs) d = await d.getDirectoryHandle(s, { create: true });
        const w = await (await d.getFileHandle(file, { create: true })).createWritable();
        await w.write(content);
        await w.close();
      }
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("vault-app");
        req.onsuccess = () => {
          const db = req.result;
          const t = db.transaction("handles", "readwrite");
          t.objectStore("handles").put({ id, name, kind: "browser", lastOpened: Date.now() }, `vault:${id}`);
          t.oncomplete = () => {
            db.close();
            resolve();
          };
          t.onerror = () => reject(t.error);
        };
        req.onerror = () => reject(req.error);
      });
      return id;
    },
    { name, files },
  );
}

/** Reads a file of a browser vault straight from OPFS (not through the app). */
async function readVaultFile(page: Page, vaultId: string, path: string): Promise<string | null> {
  return page.evaluate(
    async ({ vaultId, path }) => {
      try {
        let dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("vaults")).getDirectoryHandle(vaultId);
        const segs = path.split("/");
        const name = segs.pop()!;
        for (const s of segs) dir = await dir.getDirectoryHandle(s);
        return await (await (await dir.getFileHandle(name)).getFile()).text();
      } catch {
        return null;
      }
    },
    { vaultId, path },
  );
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function openDemo(page: Page) {
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
}

test.describe("offline app shell", () => {
  test("precaches the whole build and reloads offline into the demo vault", async ({ page, context, request }) => {
    await request.get("/__om_test__/reset-sw").catch(() => null);
    await page.goto("/?vault=demo");
    test.skip(!(await isBuilt(page)), "needs the built app (service worker precache)");
    await waitForServiceWorker(page);
    const info = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const build = await new Promise<{ buildId: string; precached: number }>((resolve) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = (e) => resolve(e.data);
        reg!.active!.postMessage({ type: "openmarkdown-get-build" }, [ch.port2]);
      });
      const cache = await caches.open(`openmarkdown-app-${build.buildId}`);
      const keys = await cache.keys();
      const page = document.querySelector<HTMLMetaElement>('meta[name="openmarkdown-build"]')!.content;
      return { ...build, cached: keys.filter((k) => !k.url.includes("__openmarkdown_cache_meta__")).length, page, lazy: keys.filter((k) => /mermaid|katex/.test(k.url)).length };
    });
    expect(info.buildId).toBe(info.page);
    expect(info.cached).toBe(info.precached);
    expect(info.lazy).toBeGreaterThan(0); // lazy chunks are in the shell too

    await context.setOffline(true);
    try {
      await page.reload();
      await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
      await page.evaluate(() => (window as any).app.workspace.openLinkText("Formatting", "", false));
      await expect(page.locator(".workspace-leaf.mod-active .cm-content")).toContainText("Formatting", { timeout: 20_000 });
      // A lazy chunk (Mermaid) loads from the cache while offline.
      const lazyOk = await page.evaluate(async () => {
        const url = (await caches.keys()).length ? (await (await caches.open((await caches.keys()).find((k) => k.startsWith("openmarkdown-app-"))!)).keys()).map((r) => r.url).find((u) => /mermaid\.core/.test(u)) : null;
        if (!url) return "no mermaid chunk";
        const res = await fetch(url);
        return res.ok;
      });
      expect(lazyOk).toBe(true);
    } finally {
      await context.setOffline(false);
    }
  });

  test("an update shows a notice, never reloads a tab with unsaved work, and reloads on request", async ({ page, request }) => {
    await openDemo(page);
    test.skip(!(await isBuilt(page)), "needs the built app (service worker)");
    const hook = await request.get("/__om_test__/bump-sw").catch(() => null);
    test.skip(!hook || !hook.ok() || !(await hook.text()).includes("variant"), "needs e2e/daily/pwa-server.mjs");
    // The bump happened before the worker installed only if this was the first load; wait, then bump again.
    await waitForServiceWorker(page);
    await request.get("/__om_test__/bump-sw");
    await page.evaluate(() => {
      (window as any).__marker = "still here";
      // Unsaved work, as W1's save status reports it.
      (window as any).app.saveStatus = { hasUnsaved: () => true };
    });
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
    const notice = page.locator(".vault-update-notice");
    await expect(notice).toBeVisible({ timeout: 120_000 });
    await expect(notice).toContainText("Update available");
    await page.waitForTimeout(5000);
    expect(await page.evaluate(() => (window as any).__marker)).toBe("still here");

    await notice.getByRole("button", { name: "Reload" }).click();
    await expect(notice).toContainText("not saved");
    await page.waitForTimeout(4500);
    expect(await page.evaluate(() => (window as any).__marker)).toBe("still here");

    const reloaded = page.waitForEvent("framenavigated", { timeout: 30_000 });
    await notice.getByRole("button", { name: "Reload anyway" }).click();
    await reloaded;
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
    expect(await page.evaluate(() => (window as any).__marker)).toBeUndefined();
    await expect(page.locator(".vault-update-notice")).toHaveCount(0);
    // The reloaded tab runs under the new worker.
    const active = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => resolve(e.data.buildId);
          navigator.serviceWorker.controller!.postMessage({ type: "openmarkdown-get-build" }, [ch.port2]);
        }),
    );
    expect(active).toMatch(/-v\d+$/);
    await request.get("/__om_test__/reset-sw");
  });
});

test.describe("share target", () => {
  test("a POST from the share sheet goes through the service worker into a capture note", async ({ page }) => {
    const id = await createBrowserVault(page, "Share inbox", { "Welcome.md": "# Hi\n" });
    await page.goto(`/?vault=${id}`);
    test.skip(!(await isBuilt(page)), "needs the built app (service worker handles the POST)");
    await waitForServiceWorker(page);
    // The OS share sheet navigates with a multipart POST to the manifest's action.
    await page.evaluate(() => {
      const form = document.createElement("form");
      form.method = "POST";
      form.enctype = "multipart/form-data";
      form.action = "./share-target";
      const add = (name: string, value: string) => {
        const i = document.createElement("input");
        i.type = "hidden";
        i.name = name;
        i.value = value;
        form.appendChild(i);
      };
      add("title", "An article");
      add("text", "Worth reading");
      add("url", "https://example.com/article");
      const file = document.createElement("input");
      file.type = "file";
      file.name = "files";
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "photo.png", { type: "image/png" }));
      file.files = dt.files;
      form.appendChild(file);
      document.body.appendChild(form);
      form.submit();
    });
    await page.waitForURL(/[?&]share=|capture/, { timeout: 30_000 }).catch(() => {});
    const input = page.locator(".vault-capture-input");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await expect(input).toHaveValue(/Worth reading\n\[An article\]\(https:\/\/example\.com\/article\)/);
    await expect(page.locator(".vault-capture-attachment-name")).toHaveText("photo.png");
    expect(await page.evaluate(() => (window as any).app)).toBeUndefined();
    await page.locator(".vault-capture-save").click();
    await expect(page.locator(".vault-capture-status")).toContainText(`Saved to ${today()}.md`);
    const note = await readVaultFile(page, id, `${today()}.md`);
    expect(note).toMatch(/^- \d\d:\d\d Worth reading\n {2}\[An article\]\(https:\/\/example\.com\/article\)\n {2}!\[\[photo\.png\]\]\n$/);
    expect(await readVaultFile(page, id, "photo.png")).not.toBeNull();
  });

  test("GET share parameters fill the capture page without a service worker", async ({ page }) => {
    const id = await createBrowserVault(page, "Share get");
    await page.goto(`/?share=1&vault=${id}&title=Hello&url=${encodeURIComponent("https://example.org/")}`);
    await expect(page.locator(".vault-capture-input")).toHaveValue("[Hello](https://example.org/)");
  });
});

test.describe("quick capture", () => {
  test("writes to today's daily note before the vault is indexed", async ({ page }) => {
    const id = await createBrowserVault(page, "Capture vault", {
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Journal", format: "YYYY-MM-DD" }),
      [`Journal/${today()}.md`]: "---\ntags: daily\n---\n# Today\n",
    });
    await page.goto(`/?capture=1&vault=${encodeURIComponent("Capture vault")}&text=${encodeURIComponent("Call the plumber")}`);
    const input = page.locator(".vault-capture-input");
    await expect(input).toHaveValue("Call the plumber");
    // Nothing of the app has started: no App, no index.
    expect(await page.evaluate(() => ({ app: typeof (window as any).app, layout: document.querySelector(".workspace") }))).toEqual({ app: "undefined", layout: null });
    await input.press("Enter");
    await expect(page.locator(".vault-capture-status")).toContainText(`Saved to Journal/${today()}.md`);
    expect(await page.evaluate(() => typeof (window as any).app)).toBe("undefined");
    const text = await readVaultFile(page, id, `Journal/${today()}.md`);
    expect(text).toMatch(/^---\ntags: daily\n---\n# Today\n- \d\d:\d\d Call the plumber\n$/);

    // Then the vault opens on the note and indexes it.
    await page.getByRole("button", { name: "Open note" }).click();
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
    await expect(page.locator(".workspace-leaf.mod-active .cm-content")).toContainText("Call the plumber", { timeout: 20_000 });
  });

  test("inbox destination, heading and save=1 automation", async ({ page }) => {
    const id = await createBrowserVault(page, "Inbox vault", {
      ".obsidian/quick-capture.json": JSON.stringify({ destination: "inbox", inboxPath: "Inbox/Captured", heading: "## Thoughts", timestampFormat: "" }),
      "Inbox/Captured.md": "# Inbox\n\n## Thoughts\n- earlier\n\n## Later\n- other\n",
    });
    await page.goto(`/?capture=1&vault=${id}&save=1&text=${encodeURIComponent("from a shortcut")}`);
    await expect(page.locator(".vault-capture-status")).toContainText("Saved to Inbox/Captured.md");
    expect(await readVaultFile(page, id, "Inbox/Captured.md")).toBe("# Inbox\n\n## Thoughts\n- earlier\n- from a shortcut\n\n## Later\n- other\n");
  });

  test("the in-app sheet (Mod+Alt+N command) captures into the vault", async ({ page }) => {
    const id = await createBrowserVault(page, "Sheet vault");
    await page.goto(`/?vault=${id}`);
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
    await page.evaluate(() => (window as any).app.commands.executeCommandById("quick-capture:open"));
    const input = page.locator(".modal .vault-capture-input");
    await expect(input).toBeFocused();
    await page.keyboard.type("Sheet entry");
    await page.keyboard.press("Enter");
    await expect(page.locator(".modal .vault-capture")).toHaveCount(0);
    await expect.poll(() => readVaultFile(page, id, `${today()}.md`)).toMatch(/- \d\d:\d\d Sheet entry\n$/);
    await expect.poll(() => page.evaluate((p) => !!(window as any).app.vault.getFileByPath(p), `${today()}.md`)).toBe(true);
  });
});

test.describe("obsidian:// links", () => {
  test("open, new with content, search and web+obsidian via ?uri=", async ({ page }) => {
    await page.goto(`/?vault=demo&uri=${encodeURIComponent("obsidian://open?vault=Demo%20vault&file=Formatting")}`);
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Formatting.md");
    expect(page.url()).not.toContain("uri=");

    await page.evaluate(() => {
      location.hash = "#obsidian://new?file=Links%2FFrom%20a%20link&content=Made%20by%20a%20URI";
    });
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Links/From a link.md");
    expect(await page.evaluate(() => (window as any).app.vault.adapter.read("Links/From a link.md"))).toBe("Made by a URI");

    await page.evaluate(() => {
      location.hash = "#web+obsidian://open?file=Links%2FFrom%20a%20link&append=true&content=and%20more&silent=true";
    });
    await expect.poll(() => page.evaluate(() => (window as any).app.vault.adapter.read("Links/From a link.md"))).toBe("Made by a URI\nand more");

    await page.evaluate(() => {
      location.hash = "#obsidian://search?query=garden";
    });
    await expect(page.locator('.workspace-leaf-content[data-type="search"] input[type="search"], .workspace-leaf-content[data-type="search"] input').first()).toHaveValue("garden", { timeout: 10_000 });

    await page.evaluate(() => {
      location.hash = "#obsidian://hook-get-address";
    });
    await expect(page.locator(".notice").filter({ hasText: "hook-get-address" })).toBeVisible();
  });

  test("a link naming another vault opens that vault directly", async ({ page }) => {
    const id = await createBrowserVault(page, "Linked vault", { "Target note.md": "# Target\n" });
    await page.goto(`/?uri=${encodeURIComponent("obsidian://open?vault=Linked%20vault&file=Target%20note")}`);
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
    expect(await page.evaluate(() => (window as any).app.appId)).toBe(id);
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Target note.md");
  });
});

test.describe("files launched from the OS", () => {
  async function opfsFile(page: Page, name: string, text: string) {
    await page.evaluate(
      async ({ name, text }) => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("launch-test", { create: true });
        const h = await dir.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
      },
      { name, text },
    );
  }
  async function readOpfs(page: Page, name: string) {
    return page.evaluate(async (name) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("launch-test");
      return (await (await dir.getFileHandle(name)).getFile()).text();
    }, name);
  }

  test("a launch into a running window opens the file in single-file mode and saves back to it", async ({ page, context }) => {
    await openDemo(page);
    await opfsFile(page, "Loose note.md", "# Loose\n\nfrom disk\n");
    const popup = context.waitForEvent("page");
    await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("launch-test");
      (window as any).__openmarkdownPwa.deliverLaunch([await dir.getFileHandle("Loose note.md")]);
    });
    const win = await popup;
    await win.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
    await expect(win.locator(".vault-single-file-bar")).toContainText("Loose note.md");
    await expect(win.locator(".workspace-leaf.mod-active .cm-content")).toContainText("from disk");
    await win.locator(".workspace-leaf.mod-active .cm-content").click();
    await win.keyboard.press("ControlOrMeta+End");
    await win.keyboard.type("edited in the app");
    await expect.poll(() => readOpfs(win, "Loose note.md"), { timeout: 20_000 }).toContain("edited in the app");
    // The handles are kept for a reload (reading them back is not exercised here:
    // Chromium crashes deserialising a stored handle in Playwright's off-the-record contexts).
    expect(win.url()).toMatch(/launch=[a-z0-9]{8,}/);
  });

  test("?launch=file waits for the launch queue before choosing a vault", async ({ page }) => {
    await page.goto("/?choose=1");
    await opfsFile(page, "Queued.md", "queued text\n");
    await page.goto("/?launch=file");
    await page.waitForFunction(() => !!(window as any).__openmarkdownPwa, null, { timeout: 30_000 });
    await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("launch-test");
      (window as any).__openmarkdownPwa.deliverLaunch([await dir.getFileHandle("Queued.md")]);
    });
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
    await expect(page.locator(".workspace-leaf.mod-active .cm-content")).toContainText("queued text");
  });
});

test.describe("pop-out windows", () => {
  test("Open in new window shares the app instance and edits the same vault", async ({ page, context }) => {
    await openDemo(page);
    await page.evaluate(() => (window as any).app.workspace.openLinkText("Welcome", "", false));
    await expect(page.locator(".workspace-leaf.mod-active .cm-content")).toBeVisible();
    const popupPromise = context.waitForEvent("page");
    await page.evaluate(() => (window as any).app.commands.executeCommandById("workspace:open-in-new-window"));
    const popup = await popupPromise;
    await expect(popup.locator("body.is-popout-window .workspace-leaf .cm-content")).toContainText("Welcome", { timeout: 20_000 });
    const info = await page.evaluate(() => {
      const app = (window as any).app;
      let leaf: any = null;
      app.workspace.iterateAllLeaves((l: any) => {
        if (l.getRoot() === app.workspace.floatingSplit) leaf = l;
      });
      const container = leaf?.getContainer();
      return { found: !!leaf, other: container?.win !== window, docMatches: leaf?.view.containerEl.doc === container?.doc, win: leaf?.view.containerEl.win === container?.win };
    });
    expect(info).toEqual({ found: true, other: true, docMatches: true, win: true });
    // DOM helpers exist in the other window's realm (plugins call activeDocument.createElement(...).createDiv()).
    expect(await popup.evaluate(() => typeof (document.createElement("div") as any).createDiv)).toBe("function");

    await popup.locator(".cm-content").click();
    await popup.keyboard.press("ControlOrMeta+End");
    await popup.keyboard.type(" typed in the pop-out");
    await expect.poll(() => page.evaluate(() => (window as any).app.vault.adapter.read("Welcome.md")), { timeout: 15_000 }).toContain("typed in the pop-out");
  });

  test("falls back to a split with a notice when the window is blocked", async ({ page }) => {
    await openDemo(page);
    await page.evaluate(() => (window as any).app.workspace.openLinkText("Welcome", "", false));
    const before = await page.locator(".mod-root .workspace-tabs").count();
    await page.evaluate(() => {
      window.open = () => null;
      (window as any).app.commands.executeCommandById("workspace:open-in-new-window");
    });
    await expect(page.locator(".notice").filter({ hasText: "blocked" })).toBeVisible();
    await expect(page.locator(".mod-root .workspace-tabs")).toHaveCount(before + 1);
  });
});

test.describe("install and storage", () => {
  test("Settings → General shows the App section; Safari browser vaults get the Home Screen banner", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      baseURL: test.info().project.use.baseURL,
    });
    const page = await ctx.newPage();
    const id = await createBrowserVault(page, "Phone vault");
    await page.goto(`/?vault=${id}`);
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
    await expect(page.locator(".vault-storage-banner")).toContainText("Add to Home Screen");
    await page.locator(".vault-storage-banner-close").click();
    await expect(page.locator(".vault-storage-banner")).toHaveCount(0);
    await page.evaluate(() => {
      const app = (window as any).app;
      app.setting.open();
      app.setting.openTabById("general");
    });
    await expect(page.locator(".vault-install-row")).toContainText("Add to Home Screen");
    await ctx.close();
  });
});
