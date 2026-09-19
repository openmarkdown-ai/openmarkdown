/**
 * W1 Data safety: every data-loss repro from docs/research/web-platform-and-robustness.md
 * (V1–V9, B.2) and the daily-use audit (#1–#5) as a regression test.
 *
 * Each test builds its own browser-stored (OPFS) vault by writing files and the
 * vault record directly, so "outside the app" writes are real OPFS writes the
 * app did not make.
 */
import { expect, test, type Page } from "@playwright/test";

type Files = Record<string, string | number[]>;

async function createVault(page: Page, files: Files): Promise<string> {
  await page.goto("/?choose=1");
  await page.waitForSelector(".vault-starter", { timeout: 30_000 });
  return page.evaluate(async (files) => {
    const id = "ds" + Math.random().toString(16).slice(2, 12);
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle("vaults", { create: true })).getDirectoryHandle(id, { create: true });
    for (const [path, content] of Object.entries(files)) {
      const segs = path.split("/");
      const name = segs.pop()!;
      let d = dir;
      for (const s of segs) d = await d.getDirectoryHandle(s, { create: true });
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(typeof content === "string" ? content : new Uint8Array(content));
      await w.close();
    }
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("vault-app");
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction("handles", "readwrite");
        t.objectStore("handles").put({ id, name: `Safety ${id}`, kind: "browser", lastOpened: Date.now() }, `vault:${id}`);
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
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 30_000 });
}

async function openNote(page: Page, path: string) {
  await page.evaluate(async (p) => {
    const app = (window as any).app;
    await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(p));
  }, path);
  await page.waitForFunction((p) => (window as any).app.workspace.getActiveFile()?.path === p, path);
  await page.waitForTimeout(150);
}

/** Put the cursor at the end of the active note. */
async function focusEnd(page: Page) {
  await page.locator(".workspace-leaf.mod-active .cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+End");
}

async function diskBytes(page: Page, id: string, path: string): Promise<number[] | null> {
  return page.evaluate(
    async ({ id, path }) => {
      try {
        const root = await navigator.storage.getDirectory();
        let d = await (await root.getDirectoryHandle("vaults")).getDirectoryHandle(id);
        const segs = path.split("/");
        const name = segs.pop()!;
        for (const s of segs) d = await d.getDirectoryHandle(s);
        const f = await (await d.getFileHandle(name)).getFile();
        return Array.from(new Uint8Array(await f.arrayBuffer()));
      } catch {
        return null;
      }
    },
    { id, path },
  );
}

async function diskText(page: Page, id: string, path: string): Promise<string | null> {
  const b = await diskBytes(page, id, path);
  return b === null ? null : Buffer.from(b).toString("utf8");
}

/** Write a file the way another program would: straight to storage, not through the app. */
async function writeOutside(page: Page, id: string, path: string, text: string) {
  await page.evaluate(
    async ({ id, path, text }) => {
      const root = await navigator.storage.getDirectory();
      const d = await (await root.getDirectoryHandle("vaults")).getDirectoryHandle(id);
      const w = await (await d.getFileHandle(path, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    },
    { id, path, text },
  );
}

async function removeOutside(page: Page, id: string, path: string) {
  await page.evaluate(
    async ({ id, path }) => {
      const root = await navigator.storage.getDirectory();
      const d = await (await root.getDirectoryHandle("vaults")).getDirectoryHandle(id);
      await d.removeEntry(path);
    },
    { id, path },
  );
}

const activeText = (page: Page) => page.evaluate(() => (window as any).app.workspace.activeLeaf.view.getViewData() as string);

test.describe("data safety", () => {
  test("V3: a failed write is shown, retried, and the next save is not skipped", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    const id = await createVault(page, { "A.md": "hello\n" });
    await openVault(page, id);
    await openNote(page, "A.md");
    await page.evaluate(() => {
      const adapter = (window as any).app.vault.adapter;
      const original = adapter.write;
      (window as any).__failWrites = true;
      adapter.write = async function (...args: unknown[]) {
        if ((window as any).__failWrites) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return original.apply(this, args);
      };
    });
    await focusEnd(page);
    await page.keyboard.type("WORLD");
    await expect(page.locator(".status-bar-item.vault-save-status.mod-error")).toBeVisible({ timeout: 8000 });
    await expect(page.locator(".notice", { hasText: "Could not save" })).toBeVisible();
    await expect(page.locator(".notice", { hasText: "Storage is full" })).toBeVisible();
    expect(await diskText(page, id, "A.md")).toBe("hello\n");
    await page.evaluate(() => ((window as any).__failWrites = false));
    await expect.poll(() => diskText(page, id, "A.md"), { timeout: 15_000 }).toBe("hello\nWORLD");
    await expect(page.locator(".status-bar-item.vault-save-status.mod-error")).toHaveCount(0);
    // Settings written while typing (word counts) hit the same full disk; none may surface as an uncaught error.
    expect(pageErrors).toEqual([]);
  });

  test("closing a tab whose save is failing keeps retrying until the text lands", async ({ page }) => {
    const id = await createVault(page, { "Close.md": "keep\n", "Other.md": "o" });
    await openVault(page, id);
    await openNote(page, "Close.md");
    await page.evaluate(() => {
      const adapter = (window as any).app.vault.adapter;
      const original = adapter.write;
      (window as any).__failWrites = true;
      adapter.write = async function (...args: unknown[]) {
        if ((window as any).__failWrites) throw new DOMException("locked", "NoModificationAllowedError");
        return original.apply(this, args);
      };
    });
    await focusEnd(page);
    await page.keyboard.type("typed before closing");
    await page.evaluate(() => (window as any).app.workspace.activeLeaf.detach());
    await expect(page.locator(".notice", { hasText: "Could not save" })).toBeVisible({ timeout: 8000 });
    expect(await page.evaluate(() => (window as any).app.saveStatus.hasUnsaved())).toBe(true);
    await page.evaluate(() => ((window as any).__failWrites = false));
    await expect.poll(() => diskText(page, id, "Close.md"), { timeout: 15_000 }).toBe("keep\ntyped before closing");
    await expect.poll(() => page.evaluate(() => (window as any).app.saveStatus.hasUnsaved())).toBe(false);
  });

  test("switching files right after typing writes the text first", async ({ page }) => {
    const id = await createVault(page, { "One.md": "1\n", "Two.md": "2" });
    await openVault(page, id);
    await openNote(page, "One.md");
    await focusEnd(page);
    await page.keyboard.type("quick");
    await openNote(page, "Two.md");
    await expect.poll(() => diskText(page, id, "One.md"), { timeout: 3000 }).toBe("1\nquick");
  });

  test("audit #2: continuous typing is saved at least every ~2 s", async ({ page }) => {
    const id = await createVault(page, { "A.md": "" });
    await openVault(page, id);
    await openNote(page, "A.md");
    await focusEnd(page);
    const start = Date.now();
    let sawWrite = false;
    while (Date.now() - start < 5000) {
      await page.keyboard.type("word ", { delay: 30 });
      if (Date.now() - start > 3200 && ((await diskText(page, id, "A.md")) ?? "").length > 0) sawWrite = true;
    }
    expect(sawWrite).toBe(true);
  });

  test("V4: typing then reloading at once keeps the text (flush on leave or journal restore)", async ({ page }) => {
    const id = await createVault(page, { "A.md": "first line\n" });
    await openVault(page, id);
    await openNote(page, "A.md");
    await focusEnd(page);
    await page.keyboard.type("typed then reloaded");
    page.on("dialog", (d) => void d.accept());
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    const onDisk = await diskText(page, id, "A.md");
    if (!onDisk?.includes("typed then reloaded")) {
      const modal = page.locator(".modal.vault-recovery-modal");
      await expect(modal).toBeVisible();
      await modal.getByRole("button", { name: "Restore" }).click();
    }
    await expect.poll(() => diskText(page, id, "A.md")).toBe("first line\ntyped then reloaded");
  });

  test("journal: unsaved edits from a closed tab are offered for restore, not applied silently", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const page = await context.newPage();
    const id = await createVault(page, { "Note.md": "base\n" });
    await openVault(page, id);
    await openNote(page, "Note.md");
    // Every write fails, so only the journal holds the text.
    await page.evaluate(() => {
      const adapter = (window as any).app.vault.adapter;
      adapter.write = async () => {
        throw new DOMException("denied", "NotAllowedError");
      };
    });
    await focusEnd(page);
    await page.keyboard.type("only in the journal");
    await page.waitForTimeout(800);
    await page.close({ runBeforeUnload: false });
    const page2 = await context.newPage();
    // The note changed on disk meanwhile. (When the disk is still the text the edits were based on,
    // they are put back without asking: regressions.spec.ts "#1: typing then navigating away".)
    await page2.goto("/?choose=1");
    await writeOutside(page2, id, "Note.md", "top\nbase\n");
    await openVault(page2, id);
    const modal = page2.locator(".modal.vault-recovery-modal");
    await expect(modal).toBeVisible({ timeout: 8000 });
    await expect(modal).toContainText("Note.md");
    expect(await diskText(page2, id, "Note.md")).toBe("top\nbase\n");
    await page2.screenshot({ path: test.info().outputPath("recovery-modal.png") });
    await modal.getByRole("button", { name: "Restore" }).click();
    await expect.poll(() => diskText(page2, id, "Note.md")).toBe("top\nbase\nonly in the journal");
    await context.close();
  });

  test("V1: opening a BOM + CRLF note does not rewrite it; an edit keeps BOM and CRLF", async ({ page }) => {
    const bytes = [0xef, 0xbb, 0xbf, ...Buffer.from("# Title\r\nline one\r\nline two\r\n")];
    const id = await createVault(page, { "Crlf.md": bytes, "Other.md": "other\n" });
    await openVault(page, id);
    await openNote(page, "Crlf.md");
    await page.waitForTimeout(500);
    await openNote(page, "Other.md");
    await page.waitForTimeout(2500);
    expect(await diskBytes(page, id, "Crlf.md")).toEqual(bytes);
    await openNote(page, "Crlf.md");
    await focusEnd(page);
    await page.keyboard.type("added");
    await expect.poll(() => diskText(page, id, "Crlf.md"), { timeout: 8000 }).toBe("﻿# Title\r\nline one\r\nline two\r\nadded");
  });

  test("V2: a Latin-1 note opens read-only and its bytes are never changed", async ({ page }) => {
    const bytes = [0x63, 0x61, 0x66, 0xe9, 0x0a];
    const id = await createVault(page, { "Latin.md": bytes });
    await openVault(page, id);
    await openNote(page, "Latin.md");
    await expect(page.locator(".workspace-leaf.mod-active .vault-safety-banner.mod-encoding")).toBeVisible();
    await page.locator(".workspace-leaf.mod-active .cm-content").first().click();
    await page.keyboard.type("x");
    await page.waitForTimeout(2500);
    expect(await diskBytes(page, id, "Latin.md")).toEqual(bytes);
    await page.evaluate(async () => {
      const app = (window as any).app;
      await app.vault.process(app.vault.getFileByPath("Latin.md"), (t: string) => t + "plugin").catch(() => {});
    });
    expect(await diskBytes(page, id, "Latin.md")).toEqual(bytes);
  });

  test("V5: an outside edit while the note is dirty is merged, keeping both edits and the cursor", async ({ page }) => {
    const id = await createVault(page, { "M.md": "one\ntwo\nthree\nfour\n" });
    await openVault(page, id);
    await openNote(page, "M.md");
    await focusEnd(page);
    await page.keyboard.type("mine");
    // Another program changes the first line before the autosave.
    await writeOutside(page, id, "M.md", "ONE outside\ntwo\nthree\nfour\n");
    await page.evaluate(() => (window as any).app.vault.sync(true));
    await expect.poll(() => activeText(page), { timeout: 8000 }).toBe("ONE outside\ntwo\nthree\nfour\nmine");
    await page.keyboard.type("!");
    await expect.poll(() => diskText(page, id, "M.md"), { timeout: 8000 }).toBe("ONE outside\ntwo\nthree\nfour\nmine!");
    const snaps = await page.evaluate(async () => {
      const fr = (window as any).app.internalPlugins.getEnabledPluginById("file-recovery");
      return ((await fr.getSnapshots("M.md")) as { data: string }[]).map((s) => s.data);
    });
    expect(snaps).toContain("ONE outside\ntwo\nthree\nfour\n");
  });

  test("Kanban/Tasks-style adapter.write while the view is dirty merges instead of losing either side", async ({ page }) => {
    const id = await createVault(page, { "Tasks.md": "- [ ] a\n- [ ] b\n\nnotes\n" });
    await openVault(page, id);
    await openNote(page, "Tasks.md");
    await focusEnd(page);
    await page.keyboard.type("typed");
    await page.evaluate(() => (window as any).app.vault.adapter.write("Tasks.md", "- [x] a\n- [ ] b\n\nnotes\n"));
    await expect.poll(() => diskText(page, id, "Tasks.md"), { timeout: 8000 }).toBe("- [x] a\n- [ ] b\n\nnotes\ntyped");
    expect(await activeText(page)).toBe("- [x] a\n- [ ] b\n\nnotes\ntyped");
  });

  test("conflict: same line changed outside and in the editor — nothing overwritten, compare, keep both", async ({ page }) => {
    const id = await createVault(page, { "C.md": "alpha\nbeta\ngamma\n" });
    await openVault(page, id);
    await openNote(page, "C.md");
    await page.locator(".workspace-leaf.mod-active .cm-content").first().click();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.type(" mine");
    await writeOutside(page, id, "C.md", "alpha\nbeta theirs\ngamma\n");
    await page.evaluate(() => (window as any).app.vault.sync(true));
    const banner = page.locator(".workspace-leaf.mod-active .vault-safety-banner.mod-conflict");
    await expect(banner).toBeVisible({ timeout: 8000 });
    // The note is on screen, so the banner speaks for itself: no notice over its buttons.
    await expect(page.locator(".notice.vault-conflict-notice")).toHaveCount(0);
    await page.waitForTimeout(2500);
    expect(await diskText(page, id, "C.md")).toBe("alpha\nbeta theirs\ngamma\n");
    expect(await activeText(page)).toBe("alpha\nbeta mine\ngamma\n");
    await expect(page.locator(".status-bar-item.vault-save-status.mod-warning")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("conflict-banner.png") });
    await banner.getByRole("button", { name: /Compare/ }).click();
    const modal = page.locator(".modal.vault-conflict-modal");
    await expect(modal).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("conflict-modal.png") });
    await modal.getByRole("button", { name: "Keep both" }).click();
    await expect.poll(() => diskText(page, id, "C.md"), { timeout: 8000 }).toBe("alpha\nbeta mine\nbeta theirs\ngamma\n");
    await expect(banner).toHaveCount(0);
  });

  test("V9: a note deleted outside the app with unsaved edits keeps its tab and can be restored", async ({ page }) => {
    const id = await createVault(page, { "D.md": "keep me\n", "Other.md": "x" });
    await openVault(page, id);
    await openNote(page, "D.md");
    await focusEnd(page);
    await page.keyboard.type("unsaved");
    await removeOutside(page, id, "D.md");
    await page.evaluate(() => (window as any).app.vault.sync(true));
    const banner = page.locator(".workspace-leaf.mod-active .vault-safety-banner.mod-deleted");
    await expect(banner).toBeVisible({ timeout: 8000 });
    expect(await activeText(page)).toBe("keep me\nunsaved");
    await page.screenshot({ path: test.info().outputPath("deleted-banner.png") });
    await banner.getByRole("button", { name: "Restore file" }).click();
    await expect.poll(() => diskText(page, id, "D.md"), { timeout: 8000 }).toBe("keep me\nunsaved");
    await expect(banner).toHaveCount(0);
  });

  test("audit #5: trashing a note from the app includes its last keystrokes", async ({ page }) => {
    const id = await createVault(page, { "T.md": "start\n", "Other.md": "x" });
    await openVault(page, id);
    await openNote(page, "T.md");
    await focusEnd(page);
    await page.keyboard.type("last words");
    await page.evaluate(async () => {
      const app = (window as any).app;
      await app.fileManager.trashFile(app.vault.getFileByPath("T.md"));
    });
    await expect.poll(() => diskText(page, id, ".trash/T.md")).toBe("start\nlast words");
  });

  test("mass-delete guard: a rescan that loses most files removes nothing and asks", async ({ page }) => {
    const files: Files = {};
    for (let i = 0; i < 30; i++) files[`n${i}.md`] = `note ${i}`;
    const id = await createVault(page, files);
    await openVault(page, id);
    const before = await page.evaluate(() => (window as any).app.vault.getFiles().length);
    expect(before).toBe(30);
    await page.evaluate(async () => {
      const adapter = (window as any).app.vault.adapter;
      const scan = adapter.scan.bind(adapter);
      adapter.scan = async () => (await scan()).filter((e: any) => e.path === "n0.md" || e.path === "n1.md");
      adapter.stat = async () => null;
      await (window as any).app.vault.sync(true);
    });
    expect(await page.evaluate(() => (window as any).app.vault.getFiles().length)).toBe(30);
    await expect(page.locator(".notice", { hasText: "disappeared" })).toBeVisible();
  });

  test("unreadable entries in a rescan are not treated as deleted", async ({ page }) => {
    const id = await createVault(page, { "a.md": "a", "b.md": "b", "c.md": "c", "d.md": "d" });
    await openVault(page, id);
    await page.evaluate(async () => {
      // b.md is present but cannot be read (a cloud placeholder, a lock held by another program).
      const proto = FileSystemFileHandle.prototype as any;
      const getFile = proto.getFile;
      proto.getFile = function (this: FileSystemFileHandle) {
        return this.name === "b.md" ? Promise.reject(new DOMException("busy", "NotReadableError")) : getFile.call(this);
      };
      try {
        await (window as any).app.vault.sync(true);
      } finally {
        proto.getFile = getFile;
      }
    });
    expect(await page.evaluate(() => !!(window as any).app.vault.getFileByPath("b.md"))).toBe(true);
  });

  test("V7: the same note in two browser tabs — both edits survive and each tab sees the other's", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const a = await context.newPage();
    const id = await createVault(a, { "Shared.md": "start\n" });
    await openVault(a, id);
    await openNote(a, "Shared.md");
    const b = await context.newPage();
    await openVault(b, id);
    await openNote(b, "Shared.md");
    await a.bringToFront();
    await focusEnd(a);
    await a.keyboard.type("From tab A");
    await expect.poll(() => diskText(a, id, "Shared.md"), { timeout: 8000 }).toContain("From tab A");
    await expect.poll(() => activeText(b), { timeout: 5000 }).toContain("From tab A");
    await b.bringToFront();
    await focusEnd(b);
    await b.keyboard.type("\nFrom tab B");
    await expect.poll(() => diskText(b, id, "Shared.md"), { timeout: 8000 }).toContain("From tab B");
    await expect.poll(() => activeText(a), { timeout: 5000 }).toContain("From tab B");
    await a.bringToFront();
    await focusEnd(a);
    await a.keyboard.type("\nA again");
    await expect.poll(() => diskText(a, id, "Shared.md"), { timeout: 8000 }).toBe("start\nFrom tab A\nFrom tab B\nA again");
    // A note created in one tab appears in the other.
    await a.evaluate(() => (window as any).app.vault.create("Made in A.md", "hello"));
    await expect.poll(() => b.evaluate(() => !!(window as any).app.vault.getFileByPath("Made in A.md")), { timeout: 5000 }).toBe(true);
    // One leader for rescans.
    const leaders = await a.evaluate(async () => (await navigator.locks.query()).held!.filter((l) => l.name?.startsWith("openmarkdown-vault-leader:")).length);
    expect(leaders).toBe(1);
    await context.close();
  });

  test("audit #4: the same note in two panes stays mirrored and both edits are saved", async ({ page }) => {
    const id = await createVault(page, { "P.md": "start\n" });
    await openVault(page, id);
    await openNote(page, "P.md");
    await page.evaluate(() => (window as any).app.commands.executeCommandById("workspace:split-vertical"));
    await page.waitForTimeout(500);
    const leaves = page.locator(".workspace-split.mod-root .workspace-leaf-content[data-type=markdown] .cm-content");
    await expect(leaves).toHaveCount(2);
    await leaves.nth(1).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("RIGHT edit");
    await leaves.nth(0).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" LEFT edit", { delay: 250 });
    await page.waitForTimeout(3000);
    const texts = await page.evaluate(() => {
      const out: string[] = [];
      (window as any).app.workspace.iterateAllLeaves((l: any) => {
        if (l.view?.getViewType?.() === "markdown") out.push(l.view.getViewData());
      });
      return out;
    });
    expect(texts).toEqual(["start\nRIGHT edit LEFT edit", "start\nRIGHT edit LEFT edit"]);
    expect(await diskText(page, id, "P.md")).toBe("start\nRIGHT edit LEFT edit");
    // Saves from one pane are not reported as outside changes in the other.
    await expect(page.locator(".notice", { hasText: "changed outside" })).toHaveCount(0);
  });

  test("V8: a decomposed (NFD) file name is found by its NFC path and links resolve", async ({ page }) => {
    const nfd = "Café.md";
    const id = await createVault(page, { [nfd]: "coffee", "Link.md": "[[Café]]" });
    await openVault(page, id);
    const result = await page.evaluate(() => {
      const app = (window as any).app;
      return {
        nfc: !!app.vault.getFileByPath("Café.md"),
        nfd: !!app.vault.getFileByPath("Café.md"),
        link: app.metadataCache.getFirstLinkpathDest("Café", "Link.md")?.path ?? null,
        linkNfd: app.metadataCache.getFirstLinkpathDest("Café", "Link.md")?.path ?? null,
      };
    });
    expect(result).toEqual({ nfc: true, nfd: true, link: "Café.md", linkNfd: "Café.md" });
    await openNote(page, "Café.md");
    await focusEnd(page);
    await page.keyboard.type(" time");
    await expect.poll(() => diskText(page, id, nfd), { timeout: 8000 }).toBe("coffee time");
    // Not duplicated under the NFC spelling.
    expect(await diskBytes(page, id, "Café.md")).toBeNull();
  });

  test("a normal save leaves nothing to recover after a reload", async ({ page }) => {
    const id = await createVault(page, { "N.md": "a\n" });
    await openVault(page, id);
    await openNote(page, "N.md");
    await focusEnd(page);
    await page.keyboard.type("saved normally");
    await expect.poll(() => diskText(page, id, "N.md"), { timeout: 8000 }).toBe("a\nsaved normally");
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 30_000 });
    await page.waitForTimeout(2000);
    await expect(page.locator(".modal.vault-recovery-modal")).toHaveCount(0);
    const left = await page.evaluate(async () => (await (window as any).app.vault.safety.journal.list()).length);
    expect(left).toBe(0);
  });

  test("outside changes arrive through FileSystemObserver without a rescan", async ({ page }) => {
    const id = await createVault(page, { "W.md": "watched\n" });
    await openVault(page, id);
    await openNote(page, "W.md");
    const supported = await page.evaluate(async () => {
      const app = (window as any).app;
      // Stop rescans so only the observer can deliver the change.
      app.vault.syncGate = () => false;
      return app.vault.safety.watchDirectory(app.vault.adapter.root);
    });
    test.skip(!supported, "FileSystemObserver is not available in this browser");
    await writeOutside(page, id, "W.md", "watched\nchanged outside\n");
    await expect.poll(() => activeText(page), { timeout: 5000 }).toBe("watched\nchanged outside\n");
    await writeOutside(page, id, "New from outside.md", "x");
    await expect.poll(() => page.evaluate(() => !!(window as any).app.vault.getFileByPath("New from outside.md")), { timeout: 5000 }).toBe(true);
  });

  test("an invalid inline-title rename shows one notice, not two", async ({ page }) => {
    const id = await createVault(page, { "R.md": "r", "Taken.md": "t" });
    await openVault(page, id);
    await openNote(page, "R.md");
    const title = page.locator(".workspace-leaf.mod-active .inline-title").first();
    await title.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Taken");
    await page.keyboard.press("Enter");
    await expect(page.locator(".notice", { hasText: /exists/i }).first()).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator(".notice", { hasText: /exists/i })).toHaveCount(1);
  });

  test("the leave prompt appears only while a write is pending", async ({ page }) => {
    const id = await createVault(page, { "L.md": "x\n" });
    await openVault(page, id);
    await openNote(page, "L.md");
    const prompt = () =>
      page.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      });
    expect(await prompt()).toBe(false);
    await focusEnd(page);
    await page.keyboard.type("y");
    expect(await prompt()).toBe(true);
    await expect.poll(() => diskText(page, id, "L.md"), { timeout: 8000 }).toBe("x\ny");
    await page.waitForTimeout(300);
    expect(await prompt()).toBe(false);
  });

  test("storage persistence is requested after the first note is created in a browser vault", async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__persistCalls = 0;
      const storage = navigator.storage as any;
      storage.persisted = async () => false;
      storage.persist = async () => {
        (window as any).__persistCalls++;
        return true;
      };
    });
    const id = await createVault(page, { "Welcome.md": "hi" });
    await openVault(page, id);
    await page.evaluate(() => (window as any).app.vault.create("New note.md", ""));
    await expect.poll(() => page.evaluate(() => (window as any).__persistCalls)).toBe(1);
  });

  test("IndexedDB: an upgrade from another tab closes this connection instead of blocking", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const a = await context.newPage();
    const id = await createVault(a, { "A.md": "a" });
    await openVault(a, id);
    // Make sure the app holds its connection.
    await a.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("file-recovery")?.getSnapshots("A.md"));
    const b = await context.newPage();
    await b.goto("/?choose=1");
    const upgraded = await b.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const probe = indexedDB.open("vault-app");
          probe.onsuccess = () => {
            const v = probe.result.version;
            probe.result.close();
            const req = indexedDB.open("vault-app", v + 1);
            req.onsuccess = () => {
              req.result.close();
              resolve("ok");
            };
            req.onblocked = () => setTimeout(() => resolve("blocked"), 3000);
            req.onerror = () => resolve("error");
          };
        }),
    );
    expect(upgraded).toBe("ok");
    await context.close();
  });
});
