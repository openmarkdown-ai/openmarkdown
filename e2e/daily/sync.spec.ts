/**
 * W7 Sync: built-in sync (core plugin `opensync`) between browser contexts,
 * against a real OpenSync relay started here on an OS-assigned port.
 *
 *   A — "Laptop A": sets sync up, shows a pairing code
 *   B — "Tablet B": joins by code from the vault chooser, never edits first
 *   C — the unmodified community plugin bundle (../opensync-obsidian/main.js),
 *       standing in for Obsidian desktop, joined to the same account
 *
 * Skips, saying why, when the relay binary is missing and cannot be built.
 *   OM_URL=http://localhost:5228 npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/sync.spec.ts
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APPS = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ENGINE = join(APPS, "opensync");
const PLUGIN = join(APPS, "opensync-obsidian");
const SHOTS = process.env.W7_SHOTS ?? "test-results/sync-shots";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

// ---- relay --------------------------------------------------------------------------

interface Relay {
  ws: string;
  http: string;
  address: string;
  stop(): void;
}

function relayBinary(): string | null {
  const candidates = [
    process.env.OPENSYNC_RELAY_BIN,
    join(ENGINE, "target/release/opensync-relay"),
    process.env.CARGO_TARGET_DIR && join(process.env.CARGO_TARGET_DIR, "release/opensync-relay"),
  ].filter(Boolean) as string[];
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  if (!existsSync(join(ENGINE, "Cargo.toml"))) return null;
  const built = spawnSync("cargo", ["build", "--release", "-p", "opensync-relay", "--manifest-path", join(ENGINE, "Cargo.toml")], { stdio: "inherit", timeout: 15 * 60_000 });
  if (built.status !== 0) return null;
  return candidates.find((p) => existsSync(p)) ?? null;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

async function startRelay(bin: string, extra: string[] = []): Promise<Relay> {
  const dir = mkdtempSync(join(tmpdir(), "om-sync-relay-"));
  const port = await freePort();
  const cfg = join(dir, "relay.toml");
  writeFileSync(cfg, [`bind = "127.0.0.1:${port}"`, `data_dir = ${JSON.stringify(dir)}`, `database_url = ${JSON.stringify(`sqlite://${dir}/relay.db?mode=rwc`)}`, "require_auth = true", ...extra].join("\n"));
  const child: ChildProcess = spawn(bin, [cfg], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += d));
  const http = `http://127.0.0.1:${port}`;
  for (const until = Date.now() + 15_000; Date.now() < until; ) {
    try {
      if ((await fetch(http, { headers: { Accept: "application/nostr+json" } })).ok) {
        return { ws: `ws://127.0.0.1:${port}/`, http, address: `127.0.0.1:${port}`, stop: () => (child.kill(), rmSync(dir, { recursive: true, force: true })) };
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`relay did not start: ${stderr}`);
}

// ---- page helpers -------------------------------------------------------------------------

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500); // let modal and menu transitions finish
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function newVault(page: Page, name: string): Promise<string> {
  await page.goto("/?choose=1");
  await page.waitForSelector(".vault-starter");
  await page.locator(".vault-starter-name").fill(name);
  await page.locator(".vault-starter-action", { hasText: "Create new vault" }).getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/[?&]vault=/);
  await waitApp(page);
  return page.evaluate(() => (window as any).app.appId as string);
}

async function waitApp(page: Page) {
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true, null, { timeout: 60_000 });
}

const read = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    const app = (window as any).app;
    const f = app.vault.getFileByPath(p);
    return f ? ((await app.vault.read(f)) as string) : null;
  }, path);

const write = (page: Page, path: string, text: string) =>
  page.evaluate(
    async ({ path, text }) => {
      const app = (window as any).app;
      const f = app.vault.getFileByPath(path);
      if (f) return app.vault.modify(f, text);
      const dir = path.split("/").slice(0, -1).join("/");
      if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
      await app.vault.create(path, text);
    },
    { path, text },
  );

// Built-in sync and the community plugin both get `plugin-opensync` (the class themes target); the built-in item also has `vault-sync-status`.
const statusText = (page: Page) => page.locator(".status-bar-item.plugin-opensync.vault-sync-status").innerText().catch(() => "");
const pluginStatusText = (page: Page) => page.locator(".status-bar-item.plugin-opensync:not(.vault-sync-status)").innerText().catch(() => "");

async function waitStatus(page: Page, re: RegExp, timeout = 60_000) {
  await expect.poll(() => statusText(page), { timeout, intervals: [250] }).toMatch(re);
}

async function openSyncSettings(page: Page) {
  await page.evaluate(() => {
    const app = (window as any).app;
    app.setting.open();
    app.setting.openTabById("sync");
  });
  await page.waitForSelector(".vault-sync-settings");
}

async function closeSettings(page: Page) {
  await page.evaluate(() => (window as any).app.setting.close());
}

async function chooseOwnServer(scope: ReturnType<Page["locator"]>, address: string) {
  const row = scope.locator(".setting-item", { hasText: "Sync server" }).first();
  await row.locator("select").selectOption("own");
  await row.locator("input.vault-sync-server-address").fill(address);
}

/** Every string a vault, localStorage or the DOM holds, for the "no key ever leaks" checks. */
async function everythingStored(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const app = (window as any).app;
    const parts: string[] = [document.body.innerText, document.documentElement.outerHTML];
    for (let i = 0; i < localStorage.length; i++) parts.push(localStorage.getItem(localStorage.key(i)!) ?? "");
    const walk = async (dir: string) => {
      const listing = await app.vault.adapter.list(dir);
      for (const f of listing.files) parts.push(await app.vault.adapter.read(f).catch(() => ""));
      for (const d of listing.folders) await walk(d);
    };
    await walk("/");
    return parts.join("\n");
  });
}

// ---- the run ------------------------------------------------------------------------------

let relay: Relay | null = null;
let skipReason = "";
let ctxA: BrowserContext, ctxB: BrowserContext, ctxC: BrowserContext;
let A: Page, B: Page, C: Page;
let vaultA = "";
let vaultB = "";
const keys = { account: "", vault: "" };
const errors: string[] = [];

function watchErrors(page: Page, name: string) {
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const bin = relayBinary();
  if (!bin) {
    skipReason = `No opensync-relay binary at ${join(ENGINE, "target/release/opensync-relay")}, and \`cargo build --release -p opensync-relay --manifest-path ${join(ENGINE, "Cargo.toml")}\` did not produce one.`;
    return;
  }
  relay = await startRelay(bin);
  ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  A = await ctxA.newPage();
  B = await ctxB.newPage();
  watchErrors(A, "A");
  watchErrors(B, "B");
});

test.afterAll(async () => {
  await ctxA?.close();
  await ctxB?.close();
  await ctxC?.close();
  relay?.stop();
});

test.beforeEach(() => {
  test.skip(!!skipReason, skipReason);
});

test("A turns sync on with its own server, and no key is ever shown or stored in the vault", async () => {
  vaultA = await newVault(A, "Sync A");
  await write(A, "Hello.md", "# Hello\n\nwritten on A\n");
  await write(A, "Projects/Plan.md", "- [ ] one\n- [ ] two\n");

  await openSyncSettings(A);
  await expect(A.locator(".vault-sync-settings")).toContainText("Sync this vault between your devices");
  await shot(A, "sync-01-settings-not-set-up");
  await A.locator(".setting-item", { hasText: "Turn on sync" }).getByRole("button", { name: "Turn on" }).click();
  const modal = A.locator(".modal.vault-sync-modal");
  await chooseOwnServer(modal, relay!.address);
  await modal.locator("input.vault-sync-device-name").fill("Laptop A");
  await shot(A, "sync-02-turn-on");
  await modal.getByRole("button", { name: "Turn on sync" }).click();

  const kit = A.locator(".modal.vault-sync-modal", { hasText: "print your recovery kit" });
  await expect(kit).toBeVisible({ timeout: 30_000 });
  await expect(kit).toContainText(/reads back as account \w{4}-\w{4}/);
  await shot(A, "sync-03-recovery-kit");
  // The kit is printed from a hidden frame; read it to learn the keys this test must never find anywhere else.
  const kitText = await A.locator("iframe.vault-sync-kit-frame").evaluate((f: HTMLIFrameElement) => f.contentDocument!.body.innerText);
  keys.account = (/nsec1[\s\S]*?(?=\n\n|VAULT KEY)/.exec(kitText)?.[0] ?? "").replace(/\s+/g, "");
  keys.vault = (/ovault1[\s\S]*?(?=\n\n|HOW TO)/.exec(kitText)?.[0] ?? "").replace(/\s+/g, "");
  expect(keys.account).toMatch(/^nsec1[a-z0-9]{50,}$/);
  expect(keys.vault).toMatch(/^ovault1[a-z0-9]{50,}$/);
  await kit.getByRole("button", { name: "I've saved it" }).click();
  await closeSettings(A);

  await waitStatus(A, /^Synced/);
  const stored = await everythingStored(A);
  expect(stored).not.toContain(keys.account);
  expect(stored).not.toContain(keys.vault);
  expect(stored).not.toMatch(/nsec1|ovault1/);
  // Keys live in IndexedDB, wrapped by a key script cannot export.
  const wrapping = await A.evaluate(async () => {
    const db: IDBDatabase = await new Promise((ok, fail) => {
      const r = indexedDB.open("openmarkdown-sync");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
    const get = (key: string) => new Promise<any>((ok) => {
      const req = db.transaction("sync").objectStore("sync").get(key);
      req.onsuccess = () => ok(req.result);
    });
    const key: CryptoKey = await get("wrapkey");
    const record = await get(`device:${(window as any).app.appId}`);
    let exportable = true;
    try {
      await crypto.subtle.exportKey("raw", key);
    } catch {
      exportable = false;
    }
    return { extractable: key.extractable, exportable, recordText: JSON.stringify(record) };
  });
  expect(wrapping.extractable).toBe(false);
  expect(wrapping.exportable).toBe(false);
  expect(wrapping.recordText).not.toMatch(/nsec1|ovault1/);
});

test("B opens a synced vault from the chooser with a ten-character code", async () => {
  await openSyncSettings(A);
  await A.locator(".setting-item", { hasText: "Add a device" }).getByRole("button", { name: "Add a device" }).click();
  const pair = A.locator(".modal.vault-sync-pair-modal");
  const codeEl = pair.locator(".vault-sync-code");
  await expect(codeEl).toHaveText(/^[0-9a-z]{4}-[0-9a-z]{6}$/, { timeout: 30_000 });
  await shot(A, "sync-04-pairing-code");
  const code = (await codeEl.innerText()).trim();

  await B.goto("/?choose=1");
  await B.waitForSelector(".vault-starter-sync");
  await B.locator(".vault-starter-sync").getByRole("button", { name: "Join" }).click();
  const form = B.locator(".vault-starter-sync-form");
  await form.locator("input.vault-sync-code-input").fill(code);
  await chooseOwnServer(form, relay!.address);
  await form.locator("input.vault-sync-vault-name").fill("Sync B");
  await shot(B, "sync-05-starter-join");
  await form.getByRole("button", { name: "Join and open" }).click();
  await waitApp(B);
  vaultB = await B.evaluate(() => (window as any).app.appId as string);
  expect(vaultB).not.toBe(vaultA);

  await expect(pair).toContainText("that device now syncs this vault", { timeout: 30_000 });
  await pair.locator("button.mod-cta", { hasText: "Close" }).click();
  await closeSettings(A);

  await expect.poll(() => read(B, "Hello.md"), { timeout: 30_000 }).toBe("# Hello\n\nwritten on A\n");
  await expect.poll(() => read(B, "Projects/Plan.md")).toBe("- [ ] one\n- [ ] two\n");
  await waitStatus(B, /^Synced/);
  const storedB = await everythingStored(B);
  expect(storedB).not.toContain(keys.account);
  expect(storedB).not.toContain(keys.vault);

  // Name this device, so conflict copies say which device they came from.
  await openSyncSettings(B);
  const name = B.locator(".vault-sync-settings input.vault-sync-device-name");
  await name.fill("Tablet B");
  await name.press("Enter");
  await name.blur();
  await expect.poll(() => B.evaluate(() => (window as any).app.internalPlugins.plugins.opensync.instance.plugin.record?.deviceLabel)).toBe("Tablet B");
  await closeSettings(B);
});

test("an edit on A reaches B while B does nothing (live pull)", async () => {
  await waitStatus(B, /^Synced/);
  await write(A, "Hello.md", "# Hello\n\nedited on A while B was idle\n");
  await expect.poll(() => read(B, "Hello.md"), { timeout: 30_000 }).toBe("# Hello\n\nedited on A while B was idle\n");
});

test("status menu", async () => {
  await waitStatus(A, /^Synced/);
  await A.locator(".status-bar-item.vault-sync-status").click();
  const menu = A.locator(".menu");
  await expect(menu).toContainText("Sync now");
  await expect(menu).toContainText("Pause sync");
  await expect(menu).toContainText("Sync settings");
  await shot(A, "sync-06-status-menu");
  await A.keyboard.press("Escape");
});

test("concurrent edits become a conflict that can be reviewed and resolved", async () => {
  const pause = (page: Page, paused: boolean) =>
    page.evaluate((p) => (window as any).app.internalPlugins.plugins.opensync.instance.plugin.controller.setPaused(p), paused);
  const syncedSince = (page: Page, t: number) =>
    page.evaluate((t) => {
      const c = (window as any).app.internalPlugins.plugins.opensync.instance.plugin.controller;
      return c.idle && c.pending.size === 0 && (c.lastSyncAt ?? 0) > t && c.status.state === "synced";
    }, t);
  await pause(B, true);
  await waitStatus(B, /paused/);
  await write(B, "Projects/Plan.md", "- [x] one\n- [ ] two\n- [ ] three (from B)\n");
  const t0 = await A.evaluate(() => Date.now());
  await write(A, "Projects/Plan.md", "- [ ] one\n- [x] two\n");
  await expect.poll(() => syncedSince(A, t0), { timeout: 30_000 }).toBe(true);
  await pause(B, false);

  const copy = "Projects/Plan (conflict";
  await expect.poll(() => B.evaluate((c) => (window as any).app.vault.getFiles().map((f: any) => f.path).find((p: string) => p.startsWith(c)) ?? null, copy), { timeout: 30_000 }).toMatch(/from Laptop A\)\.md$/);
  await waitStatus(B, /conflict/);
  // …and A receives the copy too, both versions intact.
  await expect.poll(() => A.evaluate(() => (window as any).app.vault.getFiles().filter((f: any) => /conflict/.test(f.path)).length), { timeout: 30_000 }).toBe(1);

  await B.evaluate(() => (window as any).app.commands.executeCommandById("opensync:review-conflicts"));
  const modal = B.locator(".modal.vault-sync-conflict-modal");
  await expect(modal.locator(".vault-diff-row").first()).toBeVisible();
  await expect(modal).toContainText("From Laptop A");
  await shot(B, "sync-07-conflict-review-light");
  await B.evaluate(() => document.body.classList.replace("theme-light", "theme-dark"));
  await shot(B, "sync-08-conflict-review-dark");
  await B.evaluate(() => document.body.classList.replace("theme-dark", "theme-light"));

  await modal.getByRole("button", { name: "Keep version from Laptop A" }).click();
  await expect(modal).toContainText("No conflicts left.");
  await B.keyboard.press("Escape");
  expect(await read(B, "Projects/Plan.md")).toBe("- [ ] one\n- [x] two\n");
  // Resolution is an ordinary edit: A converges, and the copy is gone on both sides.
  await expect.poll(() => A.evaluate(() => (window as any).app.vault.getFiles().filter((f: any) => /conflict/.test(f.path)).length), { timeout: 30_000 }).toBe(0);
  expect(await read(A, "Projects/Plan.md")).toBe("- [ ] one\n- [x] two\n");
  // B's replaced text is in local history.
  const snapshots = await B.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("file-recovery")?.getSnapshots("Projects/Plan.md"));
  expect(JSON.stringify(snapshots ?? [])).toContain("three (from B)");
});

test("an attachment syncs on a self-hosted server, and a deletion goes to the trash", async () => {
  const bytes = Array.from({ length: 4096 }, (_, i) => (i * 31) % 256);
  await A.evaluate(async (b) => {
    await (window as any).app.vault.createBinary("Attachments/photo.png", new Uint8Array(b).buffer);
  }, bytes);
  await expect
    .poll(
      () =>
        B.evaluate(async () => {
          const app = (window as any).app;
          const f = app.vault.getFileByPath("Attachments/photo.png");
          return f ? Array.from(new Uint8Array(await app.vault.readBinary(f))).slice(0, 8).join(",") + `/${f.stat.size}` : null;
        }),
      { timeout: 30_000 },
    )
    .toBe(`${bytes.slice(0, 8).join(",")}/4096`);

  await A.evaluate(async () => {
    const app = (window as any).app;
    await app.fileManager.trashFile(app.vault.getFileByPath("Attachments/photo.png"));
  });
  await expect.poll(() => B.evaluate(() => !!(window as any).app.vault.getFileByPath("Attachments/photo.png")), { timeout: 30_000 }).toBe(false);
  expect(await B.evaluate(() => (window as any).app.vault.adapter.exists(".trash/photo.png"))).toBe(true);
});

test("two tabs of one vault: exactly one syncs", async () => {
  const A2 = await ctxA.newPage();
  watchErrors(A2, "A2");
  await A2.goto(`/?vault=${vaultA}`);
  await waitApp(A2);
  await waitStatus(A2, /Syncing in another tab/);
  const held = await A2.evaluate(async () => (await navigator.locks.query()).held?.map((l) => l.name) ?? []);
  expect(held.filter((n) => n === `opensync:${vaultA}`)).toHaveLength(1);
  expect(await statusText(A)).not.toMatch(/another tab/);

  // An edit in the follower tab is published by the leader.
  await write(A2, "From the second tab.md", "typed in tab two\n");
  await expect.poll(() => read(B, "From the second tab.md"), { timeout: 40_000 }).toBe("typed in tab two\n");

  // Closing the leader hands over.
  await A.close();
  await waitStatus(A2, /^Synced|^Sync starting|^Syncing/, 20_000);
  A = A2;
});

test("a reload keeps sync set up, and the account's keys stay out of the vault", async () => {
  await B.reload();
  await waitApp(B);
  await waitStatus(B, /^Synced/);
  await openSyncSettings(B);
  await expect(B.locator(".vault-sync-settings")).toContainText("Add a device");
  await expect(B.locator(".vault-sync-settings")).toContainText("Laptop A");
  await closeSettings(B);
  await write(B, "After reload.md", "still syncing\n");
  await expect.poll(() => read(A, "After reload.md"), { timeout: 40_000 }).toBe("still syncing\n");
});

test("interop: the unmodified OpenSync plugin joins the same account and syncs both ways", async ({ browser }) => {
  test.skip(!existsSync(join(PLUGIN, "main.js")), `No plugin bundle at ${join(PLUGIN, "main.js")}`);
  ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  C = await ctxC.newPage();
  watchErrors(C, "C");
  await newVault(C, "Plugin C");
  const files = ["manifest.json", "main.js", "styles.css"].filter((f) => existsSync(join(PLUGIN, f))).map((f) => ({ name: f, data: readFileSync(join(PLUGIN, f), "utf8") }));
  await C.evaluate(async (files) => {
    const app = (window as any).app;
    await app.plugins.setEnable(true);
    const m = await app.plugins.installFromFiles(files);
    await app.plugins.enablePluginAndSave(m.id);
  }, files);
  await C.waitForSelector(".status-bar-item.plugin-opensync:not(.vault-sync-status)");

  // Built-in sync steps aside while the plugin is enabled, and says why.
  await C.evaluate(() => {
    const app = (window as any).app;
    app.setting.open();
    app.setting.openTabById("sync");
  });
  const builtIn = C.locator(".vault-sync-settings");
  await expect(builtIn).toContainText("Synced by the OpenSync plugin");
  await shot(C, "sync-09-plugin-owns-sync");
  await closeSettings(C);

  // A shows a code; the plugin joins with the link form (it carries the server).
  await openSyncSettings(A);
  await A.locator(".setting-item", { hasText: "Add a device" }).getByRole("button", { name: "Add a device" }).click();
  const pair = A.locator(".modal.vault-sync-pair-modal");
  await expect(pair.locator(".vault-sync-code")).toHaveText(/^[0-9a-z]{4}-[0-9a-z]{6}$/, { timeout: 30_000 });
  const code = (await pair.locator(".vault-sync-code").innerText()).trim();
  const uri = `opensync://pair?ws=${encodeURIComponent(relay!.ws)}#${code}`;

  await C.evaluate(() => {
    const app = (window as any).app;
    app.setting.open();
    app.setting.openTabById("opensync");
  });
  const row = (name: string) => C.locator(".vertical-tab-content .setting-item").filter({ has: C.locator(".setting-item-name", { hasText: new RegExp(`^${name}$`) }) });
  await row("Relay address").locator("input").fill(relay!.ws);
  await row("Storage address").locator("input").fill(relay!.http);
  await row("Join from a code").locator("input").fill(uri);
  await row("Join from a code").locator("button").click();
  await expect.poll(() => C.evaluate(() => !!(window as any).app.plugins.plugins.opensync?.settings?.namespaceKey), { timeout: 40_000 }).toBe(true);
  await expect(pair).toContainText("that device now syncs this vault", { timeout: 30_000 });
  await pair.locator("button.mod-cta", { hasText: "Close" }).click();
  await closeSettings(A);
  await closeSettings(C);
  await C.evaluate(async () => {
    const p = (window as any).app.plugins.plugins.opensync;
    p.settings.syncAttachments = true;
    await p.saveSettings();
  });

  const syncC = async () => {
    await C.evaluate(() => (window as any).app.commands.executeCommandById("opensync:sync-now"));
    await expect.poll(() => pluginStatusText(C), { timeout: 60_000 }).toMatch(/up to date|error/);
    expect(await pluginStatusText(C)).toMatch(/up to date/);
  };
  await syncC();
  expect(await read(C, "Hello.md")).toBe("# Hello\n\nedited on A while B was idle\n");
  expect(await read(C, "After reload.md")).toBe("still syncing\n");

  // Plugin → built-in (A and B pull it live).
  await write(C, "From the plugin.md", "written by the Obsidian plugin\n");
  await syncC();
  await expect.poll(() => read(A, "From the plugin.md"), { timeout: 30_000 }).toBe("written by the Obsidian plugin\n");
  await expect.poll(() => read(B, "From the plugin.md"), { timeout: 30_000 }).toBe("written by the Obsidian plugin\n");

  // Built-in → plugin.
  await write(B, "Hello.md", "# Hello\n\nfrom B to the plugin\n");
  await expect.poll(() => read(A, "Hello.md"), { timeout: 30_000 }).toBe("# Hello\n\nfrom B to the plugin\n");
  await syncC();
  expect(await read(C, "Hello.md")).toBe("# Hello\n\nfrom B to the plugin\n");

  // Same bytes everywhere.
  const list = (page: Page) => page.evaluate(() => (window as any).app.vault.getFiles().map((f: any) => f.path).sort());
  expect(await list(C)).toEqual(await list(B));
  expect(await list(A)).toEqual(await list(B));
});

test("plain-language errors: a server that has not admitted the account, and one that is down (phone width)", async ({ browser }) => {
  const roster = await startRelay(relayBinary()!, [`admission = "roster"`]);
  const ctxD = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const D = await ctxD.newPage();
    watchErrors(D, "D");
    await newVault(D, "Sync D");
    await write(D, "Note.md", "not admitted\n");
    await openSyncSettings(D);
    await D.locator(".setting-item", { hasText: "Turn on sync" }).getByRole("button", { name: "Turn on" }).click();
    const modal = D.locator(".modal.vault-sync-modal");
    await chooseOwnServer(modal, roster.address);
    await modal.getByRole("button", { name: "Turn on sync" }).click();
    const kit = D.locator(".modal.vault-sync-modal", { hasText: "print your recovery kit" });
    await expect(kit).toBeVisible({ timeout: 30_000 });
    await kit.getByRole("button", { name: "Later" }).click();
    await expect(D.locator(".vault-sync-settings .vault-sync-callout.mod-not-admitted")).toContainText("does not accept this account", { timeout: 30_000 });
    await expect(D.locator(".vault-sync-settings")).toContainText("Run your own sync server");
    await shot(D, "sync-10-not-admitted-phone");
    await D.locator(".vault-sync-settings").getByRole("button", { name: "Run your own sync server" }).click();
    await expect(D.locator(".modal.vault-sync-selfhost")).toContainText("opensync-relay relay.toml admit");
    await expect(D.locator(".modal.vault-sync-selfhost")).not.toContainText(/nsec1|ovault1/);
  } finally {
    await ctxD.close();
    roster.stop();
  }

  // The main server goes away: A says offline, in words, and keeps its edits.
  relay!.stop();
  await write(A, "Offline.md", "typed while the server was down\n");
  await waitStatus(A, /offline/i, 40_000);
  const tip = await A.evaluate(() => (window as any).app.internalPlugins.plugins.opensync.instance.plugin.controller.status.text as string);
  expect(tip).toMatch(/Cannot reach the sync server|Offline/);
  expect(await read(A, "Offline.md")).toBe("typed while the server was down\n");
  relay = null;
});

test("no page errors", async () => {
  expect(errors).toEqual([]);
});
