import { expect, test } from "@playwright/test";

// Defects found while integrating the daily-driver work, each with the test that failed before its fix.

test("code blocks whose Prism grammar extends another highlight without reloading the page", async ({ page }) => {
  // Prism components were imported in parallel; in the production build `cpp` could evaluate before
  // `c` and throw. Vite reports that as `vite:preloadError`, which the update handler took for a
  // deployed update and answered with location.reload() — so opening such a note reloaded the app.
  const errors: string[] = [];
  let navigations = 0;
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized);
  await page.evaluate(async () => {
    const a = (window as any).app;
    const text = [
      "# Code",
      "```cpp\n#include <vector>\nclass Point { public: int x; };\n```",
      "```tsx\nconst App = (p: { n: number }) => <div className=\"a\">{p.n}</div>;\n```",
      "```php\n<?php class User { public function name(): string { return 'a'; } } ?>\n```",
      "```js\nconst answer = 42;\n```",
    ].join("\n\n");
    const f = await a.vault.create("Code blocks.md", text);
    await a.workspace.getLeaf(false).openFile(f, { state: { mode: "preview" } });
  });
  for (const lang of ["cpp", "tsx", "php", "js"]) {
    await expect(page.locator(`.markdown-reading-view pre code.language-${lang} .token`).first()).toBeVisible({ timeout: 15_000 });
  }
  await page.waitForTimeout(1000);
  expect(navigations).toBe(1);
  expect(errors).toEqual([]);
});

test("an error thrown inside a lazily loaded module does not reload the app", async ({ page }) => {
  let navigations = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations++;
  });
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
  await page.evaluate(() => {
    const ev = new Event("vite:preloadError", { cancelable: true }) as Event & { payload?: unknown };
    ev.payload = new TypeError("Cannot set properties of undefined (setting 'class-name')");
    window.dispatchEvent(ev);
  });
  await page.waitForTimeout(1500);
  expect(navigations).toBe(1);
});

test("replace in all files treats plain words as the phrase typed, not each word", async ({ page }) => {
  // "Acme Corp" → "Acme Inc." used to replace every highlighted word on its own: "Acme Inc. Corp".
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized);
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.vault.create("Clients.md", "Acme Corp signed. Corp policy, not Acme.\n");
    await a.workspace.getLeaf(false).openFile(a.vault.getFileByPath("Clients.md"));
  });
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+h`);
  await page.keyboard.type("Acme Corp");
  await page.locator(".vault-replace-input").fill("Acme Inc.");
  await expect(page.locator(".vault-replace-match")).toHaveCount(1);
  await page.locator(".vault-replace-all").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).app.vault.cachedRead((window as any).app.vault.getFileByPath("Clients.md"))))
    .toBe("Acme Inc. signed. Corp policy, not Acme.\n");
});

test("replace in all files leaves link targets, embeds, tags and property names alone unless asked", async ({ page }) => {
  // Replacing "garden" with "GROVE" in the demo vault rewrote [[Projects/Garden plan]] into a dead link,
  // the ![[…#Beds]] embed and `tags: [project, garden]`, with nothing in the preview to say so.
  await page.routeWebSocket(/.*/, () => {});
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized, null, { timeout: 60_000 });
  const read = (p: string) => page.evaluate((p) => (window as any).app.vault.adapter.read(p) as Promise<string>, p);
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.vault.create("Shed.md", "---\ngarden: yes\nsee: \"[[Projects/Garden plan]]\"\n---\nThe garden shed. [the garden](Projects/Garden%20plan.md) https://garden.example/x\n");
  });
  await page.waitForFunction(() => { const a = (window as any).app; return !!a.metadataCache.getFileCache(a.vault.getFileByPath("Shed.md")); }, null, { timeout: 10_000 });
  const before = { welcome: await read("Welcome.md"), kitchen: await read("Projects/Kitchen shelves.md"), linking: await read("Linking notes.md"), plan: await read("Projects/Garden plan.md") };
  await page.evaluate(() => (window as any).app.workspace.getLeaf(false).openFile((window as any).app.vault.getFileByPath("Welcome.md")));
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+h`);
  await page.keyboard.type("garden");
  await page.locator(".vault-replace-input").fill("GROVE");
  await expect(page.locator(".vault-replace-match.is-protected").first()).toBeVisible({ timeout: 10_000 });
  // Protected matches are unticked with a reason; the option is off.
  await expect(page.locator(".vault-replace-in-links")).not.toBeChecked();
  const protectedRows = page.locator(".vault-replace-match.is-protected");
  expect(await protectedRows.locator(".vault-replace-checkbox:checked").count()).toBe(0);
  await expect(page.locator(".vault-replace-reason", { hasText: "Inside a link" }).first()).toBeVisible();
  await expect(page.locator(".vault-replace-reason", { hasText: "A tag" }).first()).toBeVisible();
  const shots = process.env.REG_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/replace-protected-light.png` });
  await page.locator(".vault-replace-all").click();
  await expect(page.locator(".notice", { hasText: /Replaced \d+ match/ })).toBeVisible({ timeout: 10_000 });

  const welcome = await read("Welcome.md");
  expect(welcome).toContain("[[Projects/Garden plan|The GROVE plan]]");
  expect(await read("Projects/Kitchen shelves.md")).toBe(before.kitchen);
  expect(await read("Linking notes.md")).toBe(before.linking);
  const plan = await read("Projects/Garden plan.md");
  expect(plan).toContain("tags: [project, garden]");
  expect(plan).toContain("# GROVE plan");
  expect(await read("Shed.md")).toBe("---\ngarden: yes\nsee: \"[[Projects/Garden plan]]\"\n---\nThe GROVE shed. [the GROVE](Projects/Garden%20plan.md) https://garden.example/x\n");
  // Every link still resolves.
  expect(await page.evaluate(() => Object.keys((window as any).app.metadataCache.unresolvedLinks["Welcome.md"] ?? {}))).not.toContain("Projects/GROVE plan");

  // Opting in replaces inside links and tags too.
  await page.evaluate(() => (window as any).app.commands.executeCommandById("global-search:undo-replace"));
  await expect.poll(() => read("Welcome.md"), { timeout: 10_000 }).toBe(before.welcome);
  await page.locator(".vault-replace-in-links").check();
  await expect.poll(() => page.locator(".vault-replace-match.is-protected .vault-replace-checkbox:not(:checked)").count(), { timeout: 10_000 }).toBe(0);
  await page.locator(".vault-replace-all").click();
  await expect.poll(() => read("Projects/Kitchen shelves.md"), { timeout: 10_000 }).toContain("[[Projects/GROVE plan]]");
});

// ---- Daily-use re-audit (docs/research/daily-use-reaudit.md): data safety, properties, workspace polish ----

type RPage = import("@playwright/test").Page;
const R_MOD = process.platform === "darwin" ? "Meta" : "Control";

/** A browser-stored (OPFS) vault written straight to storage, so the journal is on (the demo vault is in memory). */
async function reauditVault(page: RPage, files: Record<string, string>): Promise<string> {
  await page.goto("/?choose=1");
  await page.waitForSelector(".vault-starter", { timeout: 30_000 });
  return page.evaluate(async (files) => {
    const id = "ra" + Math.random().toString(16).slice(2, 12);
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle("vaults", { create: true })).getDirectoryHandle(id, { create: true });
    for (const [path, content] of Object.entries(files)) {
      const w = await (await dir.getFileHandle(path, { create: true })).createWritable();
      await w.write(content);
      await w.close();
    }
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("vault-app");
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction("handles", "readwrite");
        t.objectStore("handles").put({ id, name: `Reaudit ${id}`, kind: "browser", lastOpened: Date.now() }, `vault:${id}`);
        t.oncomplete = () => (db.close(), resolve());
        t.onerror = () => reject(t.error);
      };
      req.onerror = () => reject(req.error);
    });
    return id;
  }, files);
}

async function reauditOpen(page: RPage, id: string) {
  await page.goto(`/?vault=${id}`);
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 30_000 });
}

async function reauditOpenNote(page: RPage, path: string) {
  await page.evaluate(async (p) => {
    const app = (window as any).app;
    await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(p));
  }, path);
  await page.waitForFunction((p) => (window as any).app.workspace.getActiveFile()?.path === p, path, { timeout: 10_000 });
  await page.waitForTimeout(150);
}

async function reauditDisk(page: RPage, id: string, path: string): Promise<string | null> {
  return page.evaluate(
    async ({ id, path }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const d = await (await root.getDirectoryHandle("vaults")).getDirectoryHandle(id);
        return await (await (await d.getFileHandle(path)).getFile()).text();
      } catch {
        return null;
      }
    },
    { id, path },
  );
}

const journalPaths = (page: RPage) => page.evaluate(async () => ((await (window as any).app.vault.safety.journal.list()) as { path: string }[]).map((e) => e.path));

/** Put a journal entry left by a tab that is no longer running. */
async function putStaleJournalEntry(page: RPage, entry: { path: string; text: string; base: string | null }) {
  await page.evaluate(async (entry) => {
    const vaultId = (window as any).app.vault.adapter.vaultId;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("vault-app");
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction("journal", "readwrite");
        t.objectStore("journal").put({ vaultId, tabId: "deadbeef0000", path: entry.path, text: entry.text, base: entry.base, baseMtime: 1, ts: Date.now() - 60_000 }, `${vaultId}:deadbeef0000:${entry.path}`);
        t.oncomplete = () => (db.close(), resolve());
        t.onerror = () => reject(t.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, entry);
}

test("N1: a conflict resolved with Keep both or Keep disk version leaves no stale journal entry", async ({ page }) => {
  const id = await reauditVault(page, { "K.md": "a\nb\nc\n", "T.md": "x\ny\n" });
  await reauditOpen(page, id);
  page.on("dialog", (d) => void d.accept());
  for (const [path, theirs, choose] of [
    ["K.md", "a\nb\nc\ntheirs", "both"],
    ["T.md", "x\ny\ntheirs", "theirs"],
  ] as const) {
    await reauditOpenNote(page, path);
    await page.waitForTimeout(2500);
    await page.locator(".workspace-leaf.mod-active .cm-content").first().click({ timeout: 5000 });
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("mine");
    await page.evaluate(({ path, theirs }) => (window as any).app.vault.adapter.write(path, theirs), { path, theirs });
    const banner = page.locator(".workspace-leaf.mod-active .vault-safety-banner.mod-conflict");
    await expect(banner).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(600); // the journal entry for "mine" is put
    if (choose === "both") await banner.getByRole("button", { name: "Keep both" }).click({ timeout: 5000 });
    else {
      await banner.getByRole("button", { name: "Compare…" }).click({ timeout: 5000 });
      await page.locator(".modal.vault-conflict-modal").getByRole("button", { name: "Keep disk version" }).click({ timeout: 5000 });
    }
    await expect.poll(() => reauditDisk(page, id, path), { timeout: 8000 }).toBe(choose === "both" ? `${theirs.replace("theirs", "mine")}\ntheirs` : theirs);
    await expect.poll(() => journalPaths(page), { timeout: 5000 }).not.toContain(path);
  }
  await page.reload();
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await expect(page.locator(".modal.vault-recovery-modal")).toHaveCount(0);
});

test("N1: restoring a journal entry over a file that changed since asks with a compare instead of overwriting", async ({ page }) => {
  const id = await reauditVault(page, { "R.md": "a\nnewer on disk\n" });
  await reauditOpen(page, id);
  await putStaleJournalEntry(page, { path: "R.md", text: "a\nold unsaved\n", base: "a\n" });
  await reauditOpen(page, id);
  const modal = page.locator(".modal.vault-recovery-modal");
  await expect(modal).toBeVisible({ timeout: 8000 });
  await modal.getByRole("button", { name: "Restore" }).click({ timeout: 5000 });
  await expect(page.locator(".modal.vault-conflict-modal")).toBeVisible({ timeout: 5000 });
  expect(await reauditDisk(page, id, "R.md")).toBe("a\nnewer on disk\n");
});

test("N6: dismissing the recovery prompt stops it returning; the note offers Restore / Compare / Discard in a banner", async ({ page }) => {
  const id = await reauditVault(page, { "Later.md": "base\nchanged since\n" });
  await reauditOpen(page, id);
  await putStaleJournalEntry(page, { path: "Later.md", text: "base\npending text\n", base: "base\n" });
  await reauditOpen(page, id);
  const modal = page.locator(".modal.vault-recovery-modal");
  await expect(modal).toBeVisible({ timeout: 8000 });
  await modal.getByRole("button", { name: "Later" }).click({ timeout: 5000 });
  await expect(modal).toHaveCount(0);
  await reauditOpen(page, id);
  await page.waitForTimeout(2000);
  await expect(modal).toHaveCount(0);
  await reauditOpenNote(page, "Later.md");
  const banner = page.locator(".workspace-leaf.mod-active .vault-safety-banner.mod-recovery");
  await expect(banner).toBeVisible({ timeout: 5000 });
  await expect(banner.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(banner.getByRole("button", { name: "Compare…" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("recovery-banner.png") });
  expect(await journalPaths(page)).toContain("Later.md");
  await banner.getByRole("button", { name: "Discard" }).click({ timeout: 5000 });
  await expect(banner).toHaveCount(0);
  await expect.poll(() => journalPaths(page)).toEqual([]);
  expect(await reauditDisk(page, id, "Later.md")).toBe("base\nchanged since\n");
});

test("#1: typing then navigating away at once keeps the text without a prompt", async ({ page }) => {
  const id = await reauditVault(page, { "Nav.md": "first line\n" });
  await reauditOpen(page, id);
  await reauditOpenNote(page, "Nav.md");
  await page.locator(".workspace-leaf.mod-active .cm-content").first().click({ timeout: 5000 });
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("typed then navigated");
  await page.goto("about:blank");
  await reauditOpen(page, id);
  await expect.poll(() => reauditDisk(page, id, "Nav.md"), { timeout: 8000 }).toBe("first line\ntyped then navigated");
  await page.waitForTimeout(800);
  await expect(page.locator(".modal.vault-recovery-modal")).toHaveCount(0);
  await expect.poll(() => journalPaths(page)).toEqual([]);
});

/** Demo vault with `files` created and the last one open in Live Preview. */
async function demoWith(page: RPage, files: Record<string, string>) {
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized, null, { timeout: 30_000 });
  await page.evaluate(async (files) => {
    const a = (window as any).app;
    let last: any = null;
    for (const [path, content] of Object.entries(files)) {
      last = await a.vault.create(path, content);
      for (let i = 0; i < 100 && !a.metadataCache.getFileCache(last); i++) await new Promise((r) => setTimeout(r, 30));
    }
    const leaf = a.workspace.getLeaf(false);
    await leaf.openFile(last, { state: { mode: "source", source: false } });
    a.workspace.setActiveLeaf(leaf, { focus: true });
  }, files);
  await page.waitForSelector(".workspace-leaf.mod-active .cm-content", { timeout: 10_000 });
}

const activeDoc = (page: RPage) => page.evaluate(() => (window as any).app.workspace.activeEditor?.editor?.getValue() as string);

test("N4: Mod+; then a known name, Tab with its suggestion open, and a value writes name: value", async ({ page }) => {
  await demoWith(page, { "Has status.md": "---\nstatus: draft\n---\n", "Tab props.md": "Body\n" });
  await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.focus());
  await page.keyboard.press(`${R_MOD}+;`);
  const keyInput = page.locator(".workspace-leaf.mod-active .metadata-property-key-input").last();
  await expect(keyInput).toBeFocused({ timeout: 5000 });
  await page.keyboard.type("stat");
  await expect(page.locator(".suggestion-container .suggestion-item", { hasText: "status" })).toBeVisible({ timeout: 5000 });
  await page.keyboard.press("Tab");
  await page.keyboard.type("done");
  await page.keyboard.press("Enter");
  await expect.poll(() => activeDoc(page), { timeout: 5000 }).toMatch(/^---\nstatus: done\n---\nBody/);
});

test("#17: focus a property name, Escape, Mod+Backspace removes the property", async ({ page }) => {
  await demoWith(page, { "Del prop.md": "---\ntitle: remove me\nkeep: other\n---\nBody\n" });
  await page.locator('.workspace-leaf.mod-active .metadata-property[data-property-key="title"] .metadata-property-key-input').click({ timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${R_MOD}+Backspace`);
  await expect.poll(() => activeDoc(page), { timeout: 5000 }).toBe("---\nkeep: other\n---\nBody\n");
});

test("#16: property widgets use the vault-wide type for empty values", async ({ page }) => {
  await demoWith(page, { "Typed.md": "---\nread: true\ndue: 2026-01-01\n---\n", "Empty typed.md": "---\nread:\ndue:\n---\nBody\n" });
  const row = (k: string) => page.locator(`.workspace-leaf.mod-active .metadata-property[data-property-key="${k}"]`);
  await expect(row("read")).toHaveAttribute("data-property-type", "checkbox", { timeout: 5000 });
  await expect(row("read").locator("input.metadata-input-checkbox")).toHaveCount(1);
  await expect(row("due")).toHaveAttribute("data-property-type", "date");
});

test("#25: renaming from the view header title returns focus to the editor; nothing typed is lost", async ({ page }) => {
  await demoWith(page, { "Header name.md": "Body" });
  await page.locator(".workspace-leaf.mod-active .view-header-title").click({ timeout: 5000 });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Header renamed");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Z");
  await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveFile()?.path), { timeout: 5000 }).toBe("Header renamed.md");
  await expect.poll(() => activeDoc(page), { timeout: 5000 }).toContain("Z");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".cm-content"))).toBe(true);
});

test("#26: the page preview from the file explorer opens beside the file tree, not over it", async ({ page }) => {
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized, null, { timeout: 30_000 });
  const item = page.locator(".nav-file-title", { hasText: "Welcome" }).first();
  const box = (await item.boundingBox())!;
  await page.keyboard.down(R_MOD);
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.move(box.x + 30, box.y + box.height / 2);
  const pop = page.locator(".popover.hover-popover");
  await expect(pop).toBeVisible({ timeout: 5000 });
  await page.keyboard.up(R_MOD);
  const popBox = (await pop.boundingBox())!;
  const tree = (await page.locator(".workspace-split.mod-left-split").boundingBox())!;
  await page.screenshot({ path: test.info().outputPath("explorer-popover.png") });
  expect(popBox.x).toBeGreaterThanOrEqual(tree.x + tree.width - 2);
});

test("#32: Settings → Hotkeys puts the cursor in its filter", async ({ page }) => {
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady, null, { timeout: 30_000 });
  await page.evaluate(() => (window as any).app.setting.open());
  await page.locator(".vertical-tab-nav-item", { hasText: /^Hotkeys$/ }).click({ timeout: 5000 });
  await page.keyboard.type("bold");
  await expect(page.locator(".vault-hotkey-search input")).toHaveValue("bold", { timeout: 5000 });
});

test("N7: focus mode keeps the formatting toolbar when it is turned on", async ({ page }) => {
  await demoWith(page, { "Focus toolbar.md": "Some text\n" });
  await page.evaluate(() => (window as any).app.vault.setConfig("formattingToolbar", "fixed"));
  const bar = page.locator(".workspace-leaf.mod-active .vault-formatting-toolbar");
  await expect(bar).toBeVisible({ timeout: 5000 });
  await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.focus());
  await page.keyboard.press(`${R_MOD}+Shift+Enter`);
  await expect(page.locator("body")).toHaveClass(/vault-focus-mode/);
  await expect(bar).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("focus-toolbar.png") });
});

test("N8: note titles from the first heading do not relabel Backlinks, Outgoing links or Outline", async ({ page }) => {
  await demoWith(page, { "Heading title.md": "# My Real Title\n\nText\n" });
  await page.evaluate(() => (window as any).app.vault.setConfig("displayTitle", "heading"));
  await page.waitForTimeout(500);
  const texts = await page.evaluate(() => {
    const out: Record<string, string> = {};
    (window as any).app.workspace.iterateAllLeaves((leaf: any) => {
      const t = leaf.view?.getViewType?.();
      if (["markdown", "backlink", "outgoing-link", "outline"].includes(t) && leaf.view?.file?.path === "Heading title.md") out[t] = leaf.getDisplayText();
    });
    return out;
  });
  expect(texts.markdown).toBe("My Real Title");
  for (const t of ["backlink", "outgoing-link", "outline"]) if (texts[t] !== undefined) expect(texts[t], t).not.toBe("My Real Title");
  expect(Object.keys(texts).length).toBeGreaterThan(1);
});

test("N10: on an iPhone the empty tab's key hints use ⌘, not Ctrl", async ({ browser }) => {
  const { devices } = await import("@playwright/test");
  const { defaultBrowserType: _d, ...phone } = devices["iPhone 13"] as Record<string, unknown>;
  const ctx = await browser.newContext({ ...(phone as object), viewport: { width: 390, height: 844 }, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "Linux armv8l" }));
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady, null, { timeout: 30_000 });
  await page.evaluate(() => {
    const ws = (window as any).app.workspace;
    const leaves: any[] = [];
    ws.iterateRootLeaves((l: any) => leaves.push(l));
    for (const l of leaves) l.detach();
  });
  const actions = page.locator(".empty-state-action");
  await expect(actions.first()).toBeVisible({ timeout: 5000 });
  const text = (await actions.allTextContents()).join(" | ");
  expect(text).toContain("⌘N");
  expect(text).not.toContain("Ctrl");
  await ctx.close();
});

test("N11: DOCX export does not repeat a title that the note's first heading already shows", async ({ page }) => {
  await demoWith(page, { "Docx title.md": "# Docx title\n\nBody paragraph.\n" });
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await page.evaluate(() => (window as any).app.commands.executeCommandById("publish:export-docx"));
  const dl = await download;
  const { readFileSync } = await import("node:fs");
  const { inflateRawSync } = await import("node:zlib");
  const buf = readFileSync((await dl.path())!);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  let doc = "";
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (name === "word/document.xml") doc = (method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  expect(doc).toContain("Body paragraph.");
  expect(doc.match(/>Docx title</g)?.length).toBe(1);
});

test("N12: on a phone, settings rows with a toggle keep the toggle at the right of the name and description", async ({ browser }) => {
  const { devices } = await import("@playwright/test");
  const { defaultBrowserType: _d, ...phone } = devices["iPhone 13"] as Record<string, unknown>;
  const ctx = await browser.newContext({ ...(phone as object), viewport: { width: 390, height: 844 }, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady, null, { timeout: 30_000 });
  const bad: string[] = [];
  for (const tab of ["editor", "file", "voice"]) {
    await page.evaluate(async (tab) => {
      const a = (window as any).app;
      if (tab === "voice" && !a.internalPlugins.getPluginById("voice")?.enabled) await a.internalPlugins.getPluginById("voice")?.enable?.(true);
      a.setting.open();
      a.setting.openTabById(tab);
    }, tab);
    await page.waitForTimeout(400);
    if (tab === "voice") await page.screenshot({ path: test.info().outputPath("phone-voice-settings.png") });
    bad.push(
      ...(await page.evaluate(() => {
        const out: string[] = [];
        for (const row of Array.from(document.querySelectorAll<HTMLElement>(".vertical-tab-content .setting-item"))) {
          const control = row.querySelector<HTMLElement>(":scope > .setting-item-control");
          const info = row.querySelector<HTMLElement>(":scope > .setting-item-info");
          if (!control || !info || control.children.length !== 1 || !control.firstElementChild!.matches(".checkbox-container") || !row.offsetParent) continue;
          const r = row.getBoundingClientRect();
          const c = control.firstElementChild!.getBoundingClientRect();
          const i = info.getBoundingClientRect();
          if (c.left < i.right - 1 || r.right - c.right > 24 || c.top > i.bottom) out.push(info.querySelector(".setting-item-name")?.textContent ?? "?");
        }
        return out;
      })),
    );
  }
  expect(bad).toEqual([]);
  await ctx.close();
});

test("#21: Enter in the Replace field replaces the first match at once and moves to the next", async ({ page }) => {
  await demoWith(page, { "Fruit.md": "pear banana apple\napple pie\n" });
  await page.evaluate(() => {
    const e = (window as any).app.workspace.activeEditor.editor;
    e.focus();
    e.setCursor({ line: 0, ch: 0 });
  });
  await page.keyboard.press(`${R_MOD}+h`);
  const find = page.locator(".workspace-leaf.mod-active .document-search-input input");
  await expect(find).toBeFocused({ timeout: 5000 });
  await page.keyboard.type("apple");
  await page.locator(".workspace-leaf.mod-active .document-replace-input input").click({ timeout: 5000 });
  await page.keyboard.type("PEAR");
  await page.keyboard.press("Enter");
  await expect.poll(() => activeDoc(page), { timeout: 3000 }).toBe("pear banana PEAR\napple pie\n");
  await page.keyboard.press("Enter");
  await expect.poll(() => activeDoc(page), { timeout: 3000 }).toBe("pear banana PEAR\nPEAR pie\n");
});

const THIRD_PARTY = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|ytimg\.com|googlevideo\.com|google\.com|googleapis\.com|gstatic\.com|vimeo\.com|vimeocdn\.com|x\.com|twitter\.com|twimg\.com)$/;

test("opening a note with YouTube, Vimeo and X embeds or a link card contacts none of those sites until a click", async ({ page }) => {
  // external-embeds rendered youtube-nocookie iframes and fetched publish.twitter.com oEmbed on render,
  // and the YouTube player then pulled in google.com, googleapis.com, ytimg.com and gstatic.com.
  const contacted: string[] = [];
  const consoleWarnings: string[] = [];
  page.on("request", (r) => {
    try {
      if (THIRD_PARTY.test(new URL(r.url()).hostname)) contacted.push(r.url());
    } catch {
      /* data: etc. */
    }
  });
  page.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") consoleWarnings.push(m.text());
  });
  await page.routeWebSocket(/.*/, () => {});
  // Nothing may really leave the machine during the test: everything off-host is aborted (and still recorded).
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort("blockedbyclient"));
  await page.route(/^https:\/\/www\.youtube-nocookie\.com\/embed\//, (route) => route.fulfill({ contentType: "text/html", body: "<body>stub player</body>" }));
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized, null, { timeout: 60_000 });
  const note = [
    "# Watch later",
    "",
    "![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
    "",
    "![](https://vimeo.com/123456789)",
    "",
    "![](https://x.com/jack/status/20)",
    "",
    "```cardlink",
    "url: https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "title: A video",
    "host: www.youtube.com",
    "favicon: https://www.google.com/s2/favicons?domain=youtube.com",
    "image: https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    "```",
    "",
    "end",
  ].join("\n");
  await page.evaluate(async (note) => {
    const a = (window as any).app;
    await a.internalPlugins.setEnabled("smart-paste", true);
    const f = await a.vault.create("Watch later.md", note);
    await a.workspace.getLeaf(false).openFile(f, { state: { mode: "source" } });
  }, note);
  const lp = page.locator(".workspace-leaf.mod-active .cm-content");
  await expect(lp.locator(".vault-embed-load-button").first()).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.setCursor({ line: 18, ch: 0 }));
  await expect(lp.locator(".auto-card-link-card")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  const shots = process.env.REG_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/embeds-click-to-load-lp-light.png` });
  // Reading view too.
  await page.evaluate(() => (window as any).app.workspace.activeLeaf.setViewState({ type: "markdown", state: { file: "Watch later.md", mode: "preview" } }));
  const reading = page.locator(".workspace-leaf.mod-active .markdown-reading-view");
  await expect(reading.locator(".vault-embed-load-button")).toHaveCount(3, { timeout: 15_000 });
  await expect(reading.locator(".vault-tweet-embed .vault-embed-load-button")).toContainText("X (Twitter)");
  await expect(reading.locator(".auto-card-link-title")).toHaveText("A video");
  await expect(reading.locator(".auto-card-link-favicon, .auto-card-link-thumbnail")).toHaveCount(0);
  await page.waitForTimeout(1500);
  if (shots) {
    await page.screenshot({ path: `${shots}/embeds-click-to-load-reading-light.png` });
    await page.evaluate(() => (window as any).app.changeTheme?.("obsidian"));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/embeds-click-to-load-reading-dark.png` });
  }
  expect(contacted).toEqual([]);

  // A click is the user asking: the player loads.
  await reading.locator(".vault-external-embed.mod-youtube .vault-embed-load-button").click({ timeout: 5000 });
  await expect(reading.locator("iframe[src^='https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ']")).toHaveCount(1, { timeout: 10_000 });
  // Serve the card's images once asked for: an aborted request makes the card drop the broken <img>,
  // and whether that happened before the check below was a race under a loaded full-suite run.
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  await page.route(/^https:\/\/(i\.ytimg\.com|www\.google\.com\/s2\/favicons)/, (route) => route.fulfill({ contentType: "image/png", body: pixel }));
  await reading.locator(".auto-card-link-load-images").click({ timeout: 5000 });
  await expect(reading.locator(".auto-card-link-thumbnail, .auto-card-link-favicon")).not.toHaveCount(0, { timeout: 10_000 });
  expect(contacted.some((u) => u.startsWith("https://www.youtube-nocookie.com/embed/"))).toBe(true);
  expect(consoleWarnings.filter((w) => /web-share/.test(w))).toEqual([]);
});

test("nothing is sent anywhere while using the demo vault, including its canvas, and math renders without console warnings", async ({ page }) => {
  // Opening Ideas.canvas loaded https://jsoncanvas.org in its link card (9 requests and a page error from
  // that site), and every math render warned "No version information available for component [tex]/noerrors".
  const external: string[] = [];
  const warnings: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["localhost", "127.0.0.1"].includes(u.hostname) && !["data:", "blob:"].includes(u.protocol)) external.push(r.url());
  });
  page.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") warnings.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.routeWebSocket(/.*/, () => {});
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort("blockedbyclient"));
  await page.goto("/?vault=demo");
  await page.waitForSelector(".nav-file-title", { timeout: 30_000 });
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized === true, null, { timeout: 30_000 });
  await page.click('.nav-file-title[data-path="Formatting.md"]', { timeout: 10_000 });
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+e`);
  await expect(page.locator(".workspace-leaf.mod-active .markdown-reading-view mjx-container").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).app.metadataCache.index.search("callout", {}));
  await page.evaluate(() => void (window as any).app.workspace.getLeaf(true).openFile((window as any).app.vault.getFileByPath("Ideas.canvas")));
  const link = page.locator(".canvas-node.canvas-node-link").first();
  await expect(link.locator(".vault-canvas-link-load")).toBeVisible({ timeout: 15_000 });
  await expect(link.locator(".vault-canvas-link-url")).toHaveText("https://jsoncanvas.org");
  await page.waitForTimeout(1500);
  const shots = process.env.REG_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/canvas-link-click-to-load.png` });
  expect(external).toEqual([]);
  expect(warnings.filter((w) => /No version information available/.test(w))).toEqual([]);
  expect(pageErrors).toEqual([]);
  // The graph sends nothing either.
  await page.evaluate(() => void (window as any).app.commands.executeCommandById("graph:open"));
  await page.waitForTimeout(1500);
  expect(external).toEqual([]);
  // Asking loads the page.
  await page.evaluate(() => { const a = (window as any).app; const leaf = a.workspace.getLeavesOfType("canvas")[0]; if (leaf) a.workspace.setActiveLeaf(leaf, { focus: true }); });
  await link.locator(".vault-canvas-link-load").click({ timeout: 10_000 });
  await expect(link.locator("iframe[src^='https://jsoncanvas.org']")).toHaveCount(1, { timeout: 10_000 });
});

test("File recovery keeps every snapshot taken in the same millisecond", async ({ page }) => {
  // Two snapshots of one note started back to back (a merge snapshots disk and editor) picked the same
  // timestamp and the second overwrote the first, so the outside version of a merge sometimes vanished.
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady, null, { timeout: 30_000 });
  const kept = await page.evaluate(async () => {
    const fr = (window as any).app.internalPlugins.getEnabledPluginById("file-recovery");
    const realNow = Date.now;
    Date.now = () => 1_800_000_000_000;
    try {
      await Promise.all(["first", "second", "third"].map((t) => fr.forceAdd("Same.md", t)));
    } finally {
      Date.now = realNow;
    }
    return ((await fr.getSnapshots("Same.md")) as { data: string }[]).map((s) => s.data).sort();
  });
  expect(kept).toEqual(["first", "second", "third"]);
});
