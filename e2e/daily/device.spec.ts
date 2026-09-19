/**
 * W6c Device & AI — text recognition (real Tesseract run), voice (dictation and
 * read aloud), on-device AI tools, reminders with notifications, vault backups,
 * web panes, and "Try to load anyway" for desktop-only plugins.
 *
 *   OM_URL=http://localhost:5227 npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/device.spec.ts
 *
 * Browser APIs that headless Chromium lacks or that need hardware (Web Speech,
 * built-in AI, Notification permission, Badging) are replaced with fakes via
 * page.addInitScript. Nothing touches the internet: non-local requests are
 * aborted, and the one download the OCR test needs (English Tesseract data)
 * is served from a local cache (fetched once into node_modules/.cache if it is
 * missing; the real-OCR test is skipped when that is impossible).
 */
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIcs, markDoneLine, parseReminderLine, parseReminders, snoozeLine } from "../../packages/app/src/core-plugins/reminders/parse";
import { excludeMatcher, parseSnapshotName, snapshotName, snapshotsToDelete } from "../../packages/app/src/core-plugins/backup/store";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "openmarkdown-device-shots");
const TESS_URL = "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz";
const TESS_CACHE = join(root, "node_modules/.cache/openmarkdown-e2e/eng.traineddata.gz");

// ---- helpers ----------------------------------------------------------------------------

async function offline(page: Page) {
  // Other streams edit files while tests run: keep Vite's HMR socket from reloading the page mid-test.
  await page.routeWebSocket(/.*/, () => {});
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort("blockedbyclient"));
}

async function openDemo(page: Page) {
  await offline(page);
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true, null, { timeout: 60_000 });
  await page.waitForSelector(".nav-file-title", { timeout: 30_000 });
}

async function enableCore(page: Page, id: string) {
  await page.evaluate(async (id) => {
    await (window as any).app.internalPlugins.setEnabled(id, true);
  }, id);
}

function corePlugin(id: string) {
  return `(window.app.internalPlugins.plugins[${JSON.stringify(id)}].instance.plugin.impl ?? window.app.internalPlugins.plugins[${JSON.stringify(id)}].instance.plugin)`;
}

async function openNote(page: Page, path: string, content?: string) {
  await page.evaluate(
    async ({ path, content }) => {
      const a = (window as any).app;
      let f = a.vault.getFileByPath(path);
      if (!f && content !== undefined) f = await a.vault.create(path, content);
      else if (f && content !== undefined) await a.vault.modify(f, content);
      const leaf = a.workspace.getLeaf(false);
      await leaf.openFile(f, { state: { mode: "source" } });
      a.workspace.setActiveLeaf(leaf, { focus: true });
    },
    { path, content },
  );
  await page.waitForSelector(".workspace-leaf.mod-active .cm-content");
}

async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getValue());
}

async function setCursor(page: Page, line: number, ch: number, toLine?: number, toCh?: number) {
  await page.evaluate(
    ({ line, ch, toLine, toCh }) => {
      const e = (window as any).app.workspace.activeEditor.editor;
      if (toLine === undefined) e.setCursor({ line, ch });
      else e.setSelection({ line, ch }, { line: toLine, ch: toCh });
      e.focus();
    },
    { line, ch, toLine, toCh },
  );
}

async function command(page: Page, id: string): Promise<boolean> {
  return page.evaluate((id) => (window as any).app.commands.executeCommandById(id), id);
}

async function commandAvailable(page: Page, id: string): Promise<boolean> {
  return page.evaluate((id) => {
    const c = (window as any).app.commands;
    const cmd = c.findCommand(id);
    return !!cmd && c.isAvailable(cmd);
  }, id);
}

/** The text under the read-aloud highlight (Live Preview may split it into several marks). */
async function speakingText(page: Page): Promise<string> {
  return page.evaluate(() => Array.from(document.querySelectorAll(".vault-voice-speaking"), (e) => e.textContent).join(""));
}

async function setDark(page: Page, dark: boolean) {
  await page.evaluate((dark) => {
    document.body.toggleClass("theme-dark", dark);
    document.body.toggleClass("theme-light", !dark);
  }, dark);
}

/** Screenshots in light and dark; `target` is a selector (element shot) or the page. */
async function shots(page: Page, name: string, target?: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const dark of [false, true]) {
    await setDark(page, dark);
    await page.waitForTimeout(200);
    const path = join(SHOTS, `${name}-${dark ? "dark" : "light"}.png`);
    if (target) await page.locator(target).first().screenshot({ path });
    else await page.screenshot({ path });
  }
  await setDark(page, false);
}

async function openSettingsTab(page: Page, id: string) {
  await page.evaluate((id) => {
    const s = (window as any).app.setting;
    s.open();
    s.openTabById(id);
  }, id);
  await page.waitForSelector(".modal.mod-settings .vertical-tab-content", { timeout: 10_000 });
}

async function closeModals(page: Page) {
  await page.evaluate(() => {
    const a = (window as any).app;
    a.setting?.close?.();
    document.querySelectorAll(".modal-container").forEach((m) => m.remove());
  });
}

// ---- fakes --------------------------------------------------------------------------------

/** Web Speech: a controllable SpeechRecognition and speechSynthesis. */
function speechFakes() {
  const w = window as any;
  w.__speech = { recognitions: [], spoken: [], paused: false, cancelled: 0, installs: [] };
  class FakeRecognition {
    lang = "";
    continuous = false;
    interimResults = false;
    processLocally = false;
    started = false;
    onresult: any = null;
    onend: any = null;
    onerror: any = null;
    constructor() {
      w.__speech.recognitions.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.started = false;
      this.onend?.();
    }
    abort() {
      this.stop();
    }
    static async available(o: any) {
      w.__speech.lastAvailable = o;
      return w.__speechAvailability ?? "available";
    }
    static async install(o: any) {
      w.__speech.installs.push(o);
      w.__speechAvailability = "available";
      return true;
    }
  }
  w.SpeechRecognition = FakeRecognition;
  w.__emitSpeech = (items: [string, boolean][]) => {
    const rec = w.__speech.recognitions.filter((r: any) => r.started).pop();
    const results = items.map(([t, final]) => Object.assign([{ transcript: t, confidence: 0.9 }], { isFinal: final }));
    rec.onresult({ resultIndex: 0, results });
  };
  let current: any = null;
  const queue: any[] = [];
  const startNext = () => {
    if (current || !queue.length) return;
    current = queue.shift();
    setTimeout(() => current?.onstart?.(), 0);
  };
  const synth = {
    speak(u: any) {
      w.__speech.spoken.push(u.text);
      queue.push(u);
      startNext();
    },
    pause() {
      w.__speech.paused = true;
    },
    resume() {
      w.__speech.paused = false;
    },
    cancel() {
      w.__speech.cancelled++;
      queue.length = 0;
      const c = current;
      current = null;
      c?.onerror?.({ error: "canceled" });
    },
    getVoices: () => [{ voiceURI: "test-en", name: "Test English", lang: "en-US", localService: true, default: true }],
    addEventListener() {},
    removeEventListener() {},
    get speaking() {
      return !!current;
    },
  };
  Object.defineProperty(w, "speechSynthesis", { value: synth, configurable: true });
  w.__finishUtterance = () => {
    const c = current;
    current = null;
    c?.onend?.();
    startNext();
  };
}

/** Chrome built-in AI: Summarizer, Translator, LanguageDetector, LanguageModel (no Rewriter/Writer/Proofreader). */
function aiFakes() {
  const w = window as any;
  w.__ai = { created: [], progress: [] };
  const stream = (chunks: string[]) =>
    new ReadableStream<string>({
      async start(controller) {
        for (const c of chunks) {
          await new Promise((r) => setTimeout(r, 30));
          controller.enqueue(c);
        }
        controller.close();
      },
    });
  const make = (name: string, factory: (opts: any) => any) => ({
    availability: async () => w.__aiAvailability?.[name] ?? "available",
    create: async (opts: any = {}) => {
      w.__ai.created.push([name, opts]);
      if ((w.__aiAvailability?.[name] ?? "available") !== "available" && opts.monitor) {
        const target = new EventTarget();
        opts.monitor(target);
        for (const loaded of [0, 0.4, 1]) {
          await new Promise((r) => setTimeout(r, 40));
          w.__ai.progress.push(loaded);
          target.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded }));
        }
        w.__aiAvailability[name] = "available";
      }
      return { ...factory(opts), destroy() {} };
    },
  });
  w.Summarizer = make("Summarizer", (o) => ({
    summarizeStreaming: () => stream(["* The garden needs ", "tomatoes\n", `* Summary type ${o.type}`]),
    summarize: async () => "* summary",
  }));
  w.Translator = make("Translator", (o) => ({ translate: async (t: string) => `[${o.sourceLanguage}→${o.targetLanguage}] ${t}` }));
  w.LanguageDetector = make("LanguageDetector", () => ({ detect: async () => [{ detectedLanguage: "en", confidence: 0.97 }] }));
  w.LanguageModel = make("LanguageModel", (o) => {
    const system = o.initialPrompts?.[0]?.content ?? "";
    const reply = (q: string) => {
      if (/^Rewrite/.test(system)) return "A shorter version.";
      if (/^Correct spelling/.test(system)) return q.replace(/\bteh\b/g, "the").replace(/\brecieve\b/g, "receive");
      const note = /NOTE "([^"]+)"/.exec(system)?.[1] ?? "?";
      return `The note “${note}” answers: ${q.length} characters asked.`;
    };
    return {
      prompt: async (q: string) => reply(q),
      promptStreaming: (q: string) => {
        const r = reply(q);
        return stream([r.slice(0, 10), r.slice(10, 25), r.slice(25)]);
      },
    };
  });
}

function notificationFakes() {
  const w = window as any;
  w.__notifications = [];
  class FakeNotification {
    static permission = "granted";
    static requestPermission = async () => "granted";
    onclick: any = null;
    constructor(title: string, opts: any) {
      w.__notifications.push({ title, ...opts });
    }
    close() {}
  }
  w.Notification = FakeNotification;
  (navigator as any).setAppBadge = async (n: number) => (w.__badge = n);
  (navigator as any).clearAppBadge = async () => (w.__badge = 0);
}

// ---- pure logic (Node) ----------------------------------------------------------------------

test.describe("pure logic", () => {
  test("Reminder plugin syntax parses, snoozes and completes like the plugin", () => {
    const opts = { defaultTime: "09:00", tasks: false, kanban: false };
    const r = parseReminderLine("- [ ] Call Sam (@2026-09-15 14:30)", 0, opts)!;
    expect(r.title).toBe("Call Sam");
    expect(new Date(r.time)).toEqual(new Date(2026, 8, 15, 14, 30));
    expect(r.hasTime).toBe(true);
    const dateOnly = parseReminderLine("* [ ] Water plants (@2026-09-16 🔁every monday)", 3, opts)!;
    expect(new Date(dateOnly.time)).toEqual(new Date(2026, 8, 16, 9, 0));
    expect(dateOnly.title).toBe("Water plants");
    expect(parseReminderLine("- [ ] Linked (@[[2026-09-15]] 20:40)", 0, opts)?.hasTime).toBe(true);
    expect(parseReminderLine("- [x] Done (@2026-09-15)", 0, opts)?.done).toBe(true);
    expect(parseReminderLine("- [-] Cancelled (@2026-09-15)", 0, opts)?.done).toBe(true);
    expect(parseReminderLine("Not a task (@2026-09-15)", 0, opts)).toBeNull();
    expect(parseReminderLine("- [ ] Tasks due 📅 2026-09-16", 0, opts)).toBeNull();
    const withTasks = { ...opts, tasks: true, kanban: true };
    const tasks = parseReminderLine("- [ ] Report ⏰ 2026-09-16 10:00 📅 2026-09-17", 0, withTasks)!;
    expect(tasks.format).toBe("tasks-reminder");
    expect(new Date(tasks.time)).toEqual(new Date(2026, 8, 16, 10, 0));
    expect(tasks.title).toBe("Report");
    const kanban = parseReminderLine("- [ ] Card @{2026-09-18} @@{20:26}", 0, withTasks)!;
    expect(kanban.format).toBe("kanban");
    expect(new Date(kanban.time)).toEqual(new Date(2026, 8, 18, 20, 26));
    // Code blocks are skipped.
    expect(parseReminders("```\n- [ ] no (@2026-09-15)\n```\n- [ ] yes (@2026-09-15)", opts).map((x) => x.title)).toEqual(["yes"]);
    // Snooze keeps the recurrence; Tasks snooze writes ⏰ and keeps 📅.
    expect(snoozeLine(dateOnly, dateOnly.raw, new Date(2026, 8, 17, 8, 5).getTime())).toBe("* [ ] Water plants (@2026-09-17 08:05 🔁every monday)");
    const due = parseReminderLine("- [ ] Pay 📅 2026-09-16", 0, withTasks)!;
    expect(snoozeLine(due, due.raw, new Date(2026, 8, 16, 12, 0).getTime())).toBe("- [ ] Pay ⏰ 2026-09-16 12:00 📅 2026-09-16");
    expect(markDoneLine(due, due.raw, new Date(2026, 8, 16).getTime())).toBe("- [x] Pay 📅 2026-09-16 ✅ 2026-09-16");
    expect(markDoneLine(r, r.raw, 0)).toBe("- [x] Call Sam (@2026-09-15 14:30)");
    const ics = buildIcs([{ title: "Call Sam, again; now", time: r.time, path: "Tasks.md" }], Date.UTC(2026, 8, 14));
    expect(ics).toContain("DTSTART:20260915T143000\r\n");
    expect(ics).toContain("SUMMARY:Call Sam\\, again\\; now\r\n");
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });

  test("backup names, retention and exclusions", () => {
    const at = (d: number, h: number) => new Date(2026, 8, d, h, 0, 0).getTime();
    const name = snapshotName("My Vault", at(14, 9), "before restore");
    expect(name).toBe("My-Vault-20260914090000-before-restore.zip");
    expect(parseSnapshotName(name)).toEqual({ time: at(14, 9), label: "before-restore" });
    const snaps = [
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].flatMap((d) => [9, 17].map((h) => ({ name: `v-${d}-${h}.zip`, size: 1, time: at(d, h), label: null }))),
      { name: "named.zip", size: 1, time: at(1, 1), label: "keep" },
    ];
    const doomed = snapshotsToDelete(snaps, { keepLast: 3, keepDaily: 5, keepWeekly: 3 });
    const kept = snaps.filter((s) => !doomed.includes(s)).map((s) => s.name);
    // newest 3 (14-17, 14-9, 13-17), newest per day for 5 days (14..10 at 17), newest per ISO week for 3 weeks
    // (Mon 14 → 14-17; 7–13 → 13-17; 31 Aug–6 Sep → 6-17), and the named one
    expect(kept).toEqual(expect.arrayContaining(["v-14-17.zip", "v-14-9.zip", "v-13-17.zip", "v-12-17.zip", "v-11-17.zip", "v-10-17.zip", "named.zip"]));
    expect(kept).toContain("v-6-17.zip");
    expect(kept).toHaveLength(8);
    const skip = excludeMatcher(".git, .trash, *.mp4, Archive/old");
    expect(skip(".git/config")).toBe(true);
    expect(skip("notes/.trash/x.md")).toBe(true);
    expect(skip("media/clip.mp4")).toBe(true);
    expect(skip("Archive/old/a.md")).toBe(true);
    expect(skip("Archive/new/a.md")).toBe(false);
    expect(skip("Welcome.md")).toBe(false);
  });
});

// ---- desktop-only plugins -------------------------------------------------------------------

test("desktop-only plugin: refused, “Try to load anyway” on request, Node modules throw on use", async ({ page }) => {
  await openDemo(page);
  const fixture = join(here, "fixtures/device/mousewheel-image-zoom");
  const files = ["manifest.json", "main.js"].map((name) => ({ name, data: readFileSync(join(fixture, name), "utf8") }));
  const fsPlugin = [
    { name: "manifest.json", data: JSON.stringify({ id: "desktop-fs-probe", name: "Desktop FS probe", version: "1.0.0", minAppVersion: "0.15.0", author: "test", description: "Uses fs when its command runs.", isDesktopOnly: true }) },
    {
      name: "main.js",
      data: `const { Plugin } = require("obsidian"); const fs = require("fs"); const { shell } = require("electron");
module.exports = class extends Plugin { onload() { this.addCommand({ id: "read", name: "Read a file", callback: () => { window.__fsResult = "ran"; fs.readFileSync("/etc/hosts", "utf8"); } }); } };`,
    },
  ];
  await page.evaluate(
    async ({ files, fsPlugin }) => {
      const p = (window as any).app.plugins;
      await p.setEnable(true);
      await p.installFromFiles(files);
      await p.installFromFiles(fsPlugin);
    },
    { files, fsPlugin },
  );
  await openSettingsTab(page, "community-plugins");
  const row = page.locator('.vault-installed-plugin[data-plugin-id="mousewheel-image-zoom"]');
  await expect(row).toContainText("only works in the desktop app");
  await expect(row.locator(".checkbox-container")).toHaveClass(/is-disabled/);
  await shots(page, "load-anyway-refused", '.vault-installed-plugin[data-plugin-id="mousewheel-image-zoom"]');

  await row.getByRole("button", { name: "Try to load anyway" }).click();
  const confirm = page.locator(".modal.mod-confirmation");
  await expect(confirm).toContainText("marked this plugin as desktop-only");
  await shots(page, "load-anyway-confirm", ".modal.mod-confirmation");
  await confirm.getByRole("button", { name: "Try to load anyway" }).click();
  await expect(row).toContainText("Loading anyway on this device");
  // Never enabled automatically.
  expect(await page.evaluate(() => ({ enabled: (window as any).app.plugins.enabledPlugins.has("mousewheel-image-zoom"), loaded: !!(window as any).app.plugins.plugins["mousewheel-image-zoom"] }))).toEqual({ enabled: false, loaded: false });
  await shots(page, "load-anyway-on", '.vault-installed-plugin[data-plugin-id="mousewheel-image-zoom"]');
  await row.locator(".checkbox-container").click();
  await expect.poll(() => page.evaluate(() => (window as any).app.plugins.plugins["mousewheel-image-zoom"]?.constructor?.name ?? null)).toBeTruthy();
  const settingsTab = await page.evaluate(() => (window as any).app.setting.pluginTabs.some((t: any) => t.id === "mousewheel-image-zoom"));
  expect(settingsTab).toBe(true);

  // The override is remembered per plugin across a reload, and still does not enable anything by itself.
  await closeModals(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true, null, { timeout: 60_000 });
  expect(await page.evaluate(() => (window as any).app.plugins.hasDesktopOnlyOverride("mousewheel-image-zoom"))).toBe(true);
  expect(await page.evaluate(() => (window as any).app.plugins.hasDesktopOnlyOverride("desktop-fs-probe"))).toBe(false);
  // The demo vault lives in memory, so its plugin files are gone after the reload; reinstall them.
  await page.evaluate(
    async ({ files, fsPlugin }) => {
      const p = (window as any).app.plugins;
      await p.setEnable(true);
      await p.installFromFiles(files);
      await p.installFromFiles(fsPlugin);
    },
    { files, fsPlugin },
  );
  expect(await page.evaluate(async () => (window as any).app.plugins.enablePluginAndSave("mousewheel-image-zoom"))).toBe(true);

  // A plugin that really needs Node loads (top-level require is harmless) and fails clearly when it uses fs.
  const refused = await page.evaluate(async () => (window as any).app.plugins.enablePluginAndSave("desktop-fs-probe"));
  expect(refused).toBe(false);
  await page.evaluate(async () => {
    const p = (window as any).app.plugins;
    await p.setDesktopOnlyOverride("desktop-fs-probe", true);
    await p.enablePluginAndSave("desktop-fs-probe");
  });
  const outcome = await page.evaluate(() => {
    try {
      (window as any).app.commands.executeCommandById("desktop-fs-probe:read");
      return { threw: null, ran: (window as any).__fsResult };
    } catch (e) {
      return { threw: (e as Error).message, ran: (window as any).__fsResult };
    }
  });
  expect(outcome.ran).toBe("ran");
  await expect(page.locator(".notice", { hasText: "tried to use fs.readFileSync" })).toBeVisible();
  // Turning the override off unloads the plugin again.
  await page.evaluate(() => (window as any).app.plugins.setDesktopOnlyOverride("desktop-fs-probe", false));
  expect(await page.evaluate(() => !!(window as any).app.plugins.plugins["desktop-fs-probe"])).toBe(false);
});

// ---- OCR ------------------------------------------------------------------------------------

async function tessData(): Promise<Buffer | null> {
  if (existsSync(TESS_CACHE)) return readFileSync(TESS_CACHE);
  try {
    const res = await fetch(TESS_URL);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(TESS_CACHE), { recursive: true });
    writeFileSync(TESS_CACHE, buf);
    return buf;
  } catch {
    return null;
  }
}

/** Draws text into a PNG in the page and saves it to the vault. */
async function makeTextImage(page: Page, path: string, lines: string[]) {
  await page.evaluate(
    async ({ path, lines }) => {
      const canvas = new OffscreenCanvas(900, 90 + lines.length * 70);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#111";
      ctx.font = "bold 48px Arial, Helvetica, sans-serif";
      lines.forEach((l, i) => ctx.fillText(l, 40, 80 + i * 70));
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const a = (window as any).app;
      const existing = a.vault.getFileByPath(path);
      if (existing) await a.vault.modifyBinary(existing, await blob.arrayBuffer());
      else await a.vault.createBinary(path, await blob.arrayBuffer());
    },
    { path, lines },
  );
}

test("OCR: consent, real Tesseract recognition, insert below the embed, Text Extractor API", async ({ page }) => {
  test.setTimeout(180_000);
  const data = await tessData();
  test.skip(!data, "English Tesseract data is not cached and could not be downloaded");
  let downloads = 0;
  await openDemo(page);
  await page.route(TESS_URL, (route) => {
    downloads++;
    return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/gzip", "content-length": String(data!.length) }, body: data! });
  });
  await enableCore(page, "ocr");
  await page.evaluate(async () => {
    const inst = (window as any).app.internalPlugins.plugins.ocr.instance;
    inst.options.ocrLanguages = ["eng"];
    await inst.saveOptions();
  });
  await makeTextImage(page, "scan.png", ["HELLO OPENMARKDOWN", "Invoice 2026"]);
  await openNote(page, "Scanned.md", "# Scanned\n\n![[scan.png]]\n\nAfter the image.");
  await setCursor(page, 2, 3);

  // Nothing is downloaded before the user agrees.
  expect(await command(page, "ocr:insert-below")).toBe(true);
  const consent = page.locator(".modal.vault-device-consent");
  await expect(consent).toContainText("English (eng)");
  await expect(consent).toContainText("cdn.jsdelivr.net");
  expect(downloads).toBe(0);
  await shots(page, "ocr-consent", ".modal.vault-device-consent");
  await consent.getByRole("button", { name: "Download" }).click();
  await expect.poll(() => editorValue(page), { timeout: 120_000 }).toMatch(/OPENMARKDOWN/i);
  expect(downloads).toBe(1);
  const value = await editorValue(page);
  expect(value).toMatch(/!\[\[scan\.png\]\]\n[\s\S]*HELLO[\s\S]*Invoice 2026[\s\S]*After the image\./i);
  await page.waitForTimeout(300);
  await shots(page, "ocr-inserted", ".workspace-leaf.mod-active .view-content");

  // Omnisearch's access path: the API answers from the cache, and the shim is not a real plugin entry.
  const api = await page.evaluate(async () => {
    const a = (window as any).app;
    const te = a.plugins.plugins["text-extractor"];
    const file = a.vault.getFileByPath("scan.png");
    return {
      hasApi: typeof te?.api?.extractText === "function",
      inCache: await te.api.isInCache(file),
      text: await te.api.extractText(file),
      pdf: te.api.canFileBeExtracted("paper.pdf"),
      md: te.api.canFileBeExtracted("note.md"),
      langs: te.api.getOcrLangs().length,
      enumerated: Object.keys(a.plugins.plugins).includes("text-extractor"),
    };
  });
  expect(api).toMatchObject({ hasApi: true, inCache: true, pdf: true, md: false, enumerated: false });
  expect(api.text).toMatch(/OPENMARKDOWN/i);
  expect(api.langs).toBeGreaterThan(100);

  // Right-click on the rendered image offers the commands.
  await page.evaluate(() => (window as any).app.workspace.activeLeaf.setViewState({ type: "markdown", state: { file: "Scanned.md", mode: "preview" } }));
  const img = page.locator(".markdown-reading-view .internal-embed img").first();
  await expect(img).toBeVisible();
  await img.click({ button: "right" });
  await expect(page.locator(".menu")).toContainText("Copy text from image");
  await shots(page, "ocr-context-menu");
  await page.keyboard.press("Escape");

  // A real Text Extractor install wins: the shim steps aside.
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.plugins.installFromFiles([
      { name: "manifest.json", data: JSON.stringify({ id: "text-extractor", name: "Text Extractor", version: "0.0.1", minAppVersion: "0.15.0", author: "x", description: "" }) },
      { name: "main.js", data: "module.exports = class extends require('obsidian').Plugin {}" },
    ]);
    a.plugins.trigger("plugin-installed", "text-extractor");
  });
  expect(await page.evaluate(() => (window as any).app.plugins.plugins["text-extractor"])).toBeUndefined();
});

test("OCR: the browser's TextDetector is used first and needs no download", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).TextDetector = class {
      async detect() {
        return [
          { rawValue: "second line", boundingBox: { top: 60, left: 10, height: 20, width: 100 } },
          { rawValue: "First", boundingBox: { top: 10, left: 10, height: 20, width: 50 } },
          { rawValue: "line", boundingBox: { top: 12, left: 70, height: 20, width: 40 } },
        ];
      }
    };
  });
  await openDemo(page);
  await enableCore(page, "ocr");
  await makeTextImage(page, "detect.png", ["anything"]);
  const text = await page.evaluate(async () => {
    const a = (window as any).app;
    return a.plugins.plugins["text-extractor"].api.extractText(a.vault.getFileByPath("detect.png"));
  });
  expect(text).toBe("First line\nsecond line");
  await expect(page.locator(".modal.vault-device-consent")).toHaveCount(0);
});

// ---- voice ----------------------------------------------------------------------------------

test("voice: on-device dictation with interim ghost text and spoken punctuation", async ({ page }) => {
  await page.addInitScript(speechFakes);
  await openDemo(page);
  await enableCore(page, "voice");
  await openNote(page, "Dictation.md", "Notes from the call.");
  await setCursor(page, 0, 20);
  expect(await command(page, "voice:dictate")).toBe(true);
  await expect(page.locator(".vault-voice-status.is-dictating")).toContainText("on device");
  const rec = await page.evaluate(() => {
    const r = (window as any).__speech.recognitions.at(-1);
    return { lang: r.lang, local: r.processLocally, interim: r.interimResults, started: r.started, asked: (window as any).__speech.lastAvailable };
  });
  expect(rec).toMatchObject({ local: true, interim: true, started: true, asked: { processLocally: true } });

  await page.evaluate(() => (window as any).__emitSpeech([["we agreed to ship on friday comma", false]]));
  await expect(page.locator(".vault-voice-interim")).toHaveText(/^\s?We agreed to ship on friday comma$/);
  await shots(page, "voice-interim", ".workspace-leaf.mod-active .view-content");
  await page.evaluate(() => (window as any).__emitSpeech([["we agreed to ship on friday comma then review period new line next steps", true]]));
  await expect(page.locator(".vault-voice-interim")).toHaveCount(0);
  expect(await editorValue(page)).toBe("Notes from the call. We agreed to ship on friday, then review.\nNext steps");
  // One undo removes the dictated phrase.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  expect(await editorValue(page)).toBe("Notes from the call.");

  expect(await command(page, "voice:dictate")).toBe(true);
  await expect(page.locator(".vault-voice-status")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__speech.recognitions.at(-1).started)).toBe(false);

  // Language pack download asks first; unavailable on-device refuses without sending audio.
  await page.evaluate(() => ((window as any).__speechAvailability = "downloadable"));
  await command(page, "voice:dictate");
  await expect(page.locator(".modal.vault-device-consent")).toContainText("language pack");
  await page.locator(".modal.vault-device-consent").getByRole("button", { name: "Download" }).click();
  await expect(page.locator(".vault-voice-status.is-dictating")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__speech.installs.length)).toBe(1);
  await command(page, "voice:dictate");
  await page.evaluate(() => ((window as any).__speechAvailability = "unavailable"));
  const before = await page.evaluate(() => (window as any).__speech.recognitions.length);
  await command(page, "voice:dictate");
  await expect(page.locator(".notice", { hasText: "Allow server-based recognition" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__speech.recognitions.length)).toBe(before);
});

test("voice: read aloud sentence by sentence with highlight, pause and stop", async ({ page }) => {
  await page.addInitScript(speechFakes);
  await openDemo(page);
  await enableCore(page, "voice");
  await openNote(page, "Read.md", "---\nlang: en\n---\n# Garden plan\n\nPlant tomatoes in May. Water them daily!\n\n```js\nskip();\n```\n- See [[Welcome|the welcome note]]");
  expect(await command(page, "voice:read-note")).toBe(true);
  await expect.poll(() => speakingText(page)).toMatch(/^(# )?Garden plan$/);
  expect(await page.evaluate(() => (window as any).__speech.spoken)).toEqual(["Garden plan"]);
  await page.evaluate(() => (window as any).__finishUtterance());
  await expect.poll(() => speakingText(page)).toBe("Plant tomatoes in May.");
  await expect(page.locator(".vault-voice-status.is-reading")).toContainText("Reading aloud · 2/4");
  await shots(page, "voice-read-aloud");
  expect(await command(page, "voice:pause-resume")).toBe(true);
  expect(await page.evaluate(() => (window as any).__speech.paused)).toBe(true);
  await expect(page.locator(".vault-voice-status.is-reading")).toContainText("Paused");
  await command(page, "voice:pause-resume");
  await page.evaluate(() => (window as any).__finishUtterance());
  await page.evaluate(() => (window as any).__finishUtterance());
  expect(await page.evaluate(() => (window as any).__speech.spoken)).toEqual(["Garden plan", "Plant tomatoes in May.", "Water them daily!", "See the welcome note"]);
  expect(await command(page, "voice:stop")).toBe(true);
  await expect(page.locator(".vault-voice-speaking")).toHaveCount(0);
  await expect(page.locator(".vault-voice-status")).toHaveCount(0);
  expect(await commandAvailable(page, "voice:stop")).toBe(false);

  // Read selection only.
  await setCursor(page, 5, 23, 5, 40);
  expect(await command(page, "voice:read-selection")).toBe(true);
  expect(await page.evaluate(() => (window as any).__speech.spoken.at(-1))).toBe("Water them daily!");
  await command(page, "voice:stop");
});

test("voice: missing Web Speech hides the commands and says why", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
  });
  await openDemo(page);
  await enableCore(page, "voice");
  await openNote(page, "Welcome.md");
  expect(await commandAvailable(page, "voice:dictate")).toBe(false);
  expect(await commandAvailable(page, "voice:read-note")).toBe(true);
  await openSettingsTab(page, "voice");
  await expect(page.locator(".vertical-tab-content")).toContainText("This browser has no speech recognition (Web Speech API)");
  await shots(page, "voice-settings", ".modal.mod-settings");
});

// ---- AI tools -------------------------------------------------------------------------------

test("AI tools: summarize with model download consent, translate, rewrite, proofread, ask", async ({ page }) => {
  await page.addInitScript(aiFakes);
  await page.addInitScript(() => ((window as any).__aiAvailability = { Summarizer: "downloadable" }));
  await openDemo(page);
  await enableCore(page, "ai-tools");
  const note = "# Garden plan\n\nWe plant tomatoes and basil in May.\nI will recieve teh seeds on Friday.";
  await openNote(page, "Projects/Garden plan.md", note);

  // Summarize: consent → progress events → streamed preview → insert as callout (not before the click).
  expect(await command(page, "ai-tools:summarize")).toBe(true);
  const consent = page.locator(".modal.vault-device-consent");
  await expect(consent).toContainText("download");
  await shots(page, "ai-consent", ".modal.vault-device-consent");
  await consent.getByRole("button", { name: "Download" }).click();
  const modal = page.locator(".modal.vault-ai-modal");
  await expect(modal.locator(".vault-ai-output")).toContainText("Summary type key-points", { timeout: 10_000 });
  expect(await page.evaluate(() => (window as any).__ai.progress)).toEqual([0, 0.4, 1]);
  expect(await editorValue(page)).toBe(note);
  await shots(page, "ai-summary", ".modal.vault-ai-modal");
  await modal.getByRole("button", { name: "Insert at top" }).click();
  expect(await editorValue(page)).toBe("> [!summary]\n> * The garden needs tomatoes\n> * Summary type key-points\n\n# Garden plan\n\nWe plant tomatoes and basil in May.\nI will recieve teh seeds on Friday.");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  expect(await editorValue(page)).toBe(note);

  // Translate the selection into French and replace it.
  await setCursor(page, 2, 0, 2, 35);
  expect(await command(page, "ai-tools:translate")).toBe(true);
  await modal.locator("select.vault-ai-target-language").selectOption("fr");
  await modal.getByRole("button", { name: "Translate" }).click();
  await expect(modal.locator(".vault-ai-output")).toHaveText("[en→fr] We plant tomatoes and basil in May.");
  await shots(page, "ai-translate", ".modal.vault-ai-modal");
  await modal.getByRole("button", { name: "Replace selection" }).click();
  expect((await editorValue(page)).split("\n")[2]).toBe("[en→fr] We plant tomatoes and basil in May.");
  const translator = await page.evaluate(() => (window as any).__ai.created.find((c: any) => c[0] === "Translator")[1]);
  expect(translator).toMatchObject({ sourceLanguage: "en", targetLanguage: "fr" });

  // Rewrite falls back to the Prompt API (no Rewriter in this browser).
  await setCursor(page, 3, 0, 3, 35);
  expect(await command(page, "ai-tools:rewrite")).toBe(true);
  await expect(modal.locator(".vault-ai-output")).toHaveText("A shorter version.");
  await modal.getByRole("button", { name: "Insert below" }).click();
  expect(await editorValue(page)).toContain("I will recieve teh seeds on Friday.\n\nA shorter version.\n");

  // Proofread shows a diff and applies only on Accept.
  await setCursor(page, 3, 0, 3, 35);
  expect(await command(page, "ai-tools:proofread")).toBe(true);
  await expect(modal.locator(".vault-ai-output ins")).toHaveCount(2);
  await expect(modal.locator(".vault-ai-output del").first()).toHaveText("recieve");
  await shots(page, "ai-proofread", ".modal.vault-ai-modal");
  await modal.getByRole("button", { name: "Accept corrections" }).click();
  expect((await editorValue(page)).split("\n")[3]).toBe("I will receive the seeds on Friday.");

  // Ask about this note: side pane, streamed answer grounded on the note.
  expect(await command(page, "ai-tools:ask-note")).toBe(true);
  const pane = page.locator(".vault-ai-chat");
  await expect(pane.locator(".vault-ai-chat-context")).toContainText("Garden plan");
  await pane.locator("textarea").fill("When do the seeds arrive?");
  await pane.locator("textarea").press("Enter");
  await expect(pane.locator(".vault-ai-chat-message.mod-assistant")).toHaveText("The note “Garden plan” answers: 25 characters asked.");
  const system = await page.evaluate(() => (window as any).__ai.created.filter((c: any) => c[0] === "LanguageModel").at(-1)[1].initialPrompts[0].content);
  expect(system).toContain("I will receive the seeds on Friday.");
  await shots(page, "ai-ask-pane", ".workspace-split.mod-right-split");

  await openSettingsTab(page, "ai-tools");
  await expect(page.locator('.vault-ai-api-row[data-api="Summarizer"]')).toHaveAttribute("data-state", "available");
  await expect(page.locator('.vault-ai-api-row[data-api="Rewriter"]')).toHaveAttribute("data-state", "missing");
  await shots(page, "ai-settings", ".modal.mod-settings");
});

test("AI tools: without built-in AI the commands are hidden and nothing is sent", async ({ page }) => {
  // Headless Chromium 153 exposes Summarizer, LanguageDetector and LanguageModel ("downloadable"); model a browser without them.
  await page.addInitScript(() => {
    for (const n of ["Summarizer", "Translator", "LanguageDetector", "LanguageModel", "Writer", "Rewriter", "Proofreader"]) delete (window as any)[n];
  });
  const requests: string[] = [];
  page.on("request", (r) => {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(r.url())) requests.push(r.url());
  });
  await openDemo(page);
  await enableCore(page, "ai-tools");
  await openNote(page, "Welcome.md");
  for (const id of ["ai-tools:summarize", "ai-tools:translate", "ai-tools:proofread", "ai-tools:ask-note"]) expect(await commandAvailable(page, id)).toBe(false);
  await openSettingsTab(page, "ai-tools");
  await expect(page.locator('.vault-ai-api-row[data-api="LanguageModel"]')).toHaveAttribute("data-state", "missing");
  await expect(page.locator(".vertical-tab-content")).toContainText("Not in this browser.");
  expect(requests).toEqual([]);
});

// ---- reminders -------------------------------------------------------------------------------

test("reminders: list, notification when due (fake clock), snooze, done, .ics export", async ({ page }) => {
  await page.addInitScript(notificationFakes);
  await page.clock.install({ time: new Date(2026, 8, 15, 8, 58, 0) });
  await openDemo(page);
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.vault.create(
      "Tasks.md",
      ["# Tasks", "- [ ] Call Sam (@2026-09-15 09:00)", "- [x] Already done (@2026-09-15 08:00)", "- [ ] Pay rent (@2026-09-20)", "- [ ] Tasks due only 📅 2026-09-15", "```", "- [ ] In code (@2026-09-15 08:00)", "```"].join("\n"),
    );
  });
  await enableCore(page, "reminders");
  expect(await command(page, "reminders:show-list")).toBe(true);
  const list = page.locator(".vault-reminders-view");
  await expect(list.locator(".vault-reminders-group.mod-today")).toContainText("Call Sam");
  await expect(list.locator(".vault-reminders-group.mod-later")).toContainText("Pay rent");
  await expect(list).not.toContainText("Already done");
  await expect(list).not.toContainText("In code");
  await expect(list).not.toContainText("Tasks due only");
  await shots(page, "reminders-list", ".workspace-split.mod-right-split");
  expect(await page.evaluate(() => (window as any).__notifications.length)).toBe(0);

  await page.clock.fastForward("02:30");
  const toast = page.locator(".vault-reminder-toast");
  await expect(toast).toContainText("Call Sam");
  const notes = await page.evaluate(() => (window as any).__notifications);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ title: "Call Sam", requireInteraction: true });
  expect(await page.evaluate(() => (window as any).__badge)).toBe(1);
  await expect(page.locator(".vault-reminders-status")).toContainText("1");
  await shots(page, "reminders-toast", ".vault-reminder-toast");

  // Remind me later → the line is rewritten in Reminder syntax; it fires again at the new time.
  await toast.getByRole("button", { name: "Remind me later" }).click();
  await page.locator(".menu .menu-item", { hasText: "In 5 minutes" }).click();
  const tasks = () => page.evaluate(() => (window as any).app.vault.adapter.read("Tasks.md"));
  await expect.poll(tasks).toMatch(/- \[ \] Call Sam \(@2026-09-15 09:0[5-6]\)/);
  await expect(toast).toHaveCount(0);
  await page.clock.fastForward("06:00");
  await expect(page.locator(".vault-reminder-toast")).toContainText("Call Sam");
  expect(await page.evaluate(() => (window as any).__notifications.length)).toBe(2);
  await page.locator(".vault-reminder-toast").getByRole("button", { name: "Mark as done" }).click();
  await expect.poll(tasks).toMatch(/- \[x\] Call Sam \(@2026-09-15 09:0[5-6]\)/);
  await expect.poll(() => page.evaluate(() => (window as any).__badge)).toBe(0);

  // A reload does not fire the same reminder twice.
  // Export .ics.
  const [download] = await Promise.all([page.waitForEvent("download"), command(page, "reminders:export-ics")]);
  expect(download.suggestedFilename()).toBe("Reminders.ics");
  const ics = readFileSync((await download.path())!, "utf8");
  expect(ics).toContain("SUMMARY:Pay rent");
  expect(ics).toContain("DTSTART:20260920T090000");
  expect(ics).not.toContain("Call Sam");

  // Per-task "Add to calendar" from the editor.
  await openNote(page, "Tasks.md");
  await setCursor(page, 3, 5);
  const [one] = await Promise.all([page.waitForEvent("download"), command(page, "reminders:add-to-calendar")]);
  expect(one.suggestedFilename()).toBe("Pay rent.ics");

  // Steps aside while the Reminder plugin is enabled.
  await page.evaluate(async () => {
    const a = (window as any).app;
    a.plugins.enabledPlugins.add("obsidian-reminder-plugin");
    a.plugins.plugins["obsidian-reminder-plugin"] = { unload() {} };
    a.plugins.trigger("plugin-loaded", "obsidian-reminder-plugin");
    await a.vault.append(a.vault.getFileByPath("Tasks.md"), "\n- [ ] Handled elsewhere (@2026-09-15 09:00)");
  });
  await page.clock.fastForward("00:30");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__notifications.length)).toBe(2);
  await expect(list).toContainText("Handled by the Reminder plugin");
});

// ---- backups -------------------------------------------------------------------------------

test("backups: snapshot to OPFS, valid zip, single-file and whole restore, one tab at a time", async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await page.evaluate(async () => {
    const a = (window as any).app;
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("openmarkdown-backups", { recursive: true }).catch(() => {});
    await a.vault.createBinary("media/pixel.bin", new Uint8Array([0, 1, 2, 250, 251, 252]).buffer);
    await a.vault.create("Unicode ✓ note.md", "Ünïcödé 😀\n".repeat(50));
  });
  await enableCore(page, "backup");
  expect(await command(page, "backup:create-now")).toBe(true);
  const progress = page.locator(".modal.vault-device-progress");
  await expect(progress.locator(".vault-device-progress-status")).toContainText("Saved", { timeout: 30_000 });
  await shots(page, "backup-progress", ".modal.vault-device-progress");
  await progress.locator(".modal-button-container button", { hasText: "Close" }).click();

  const snaps = await page.evaluate(`${corePlugin("backup")}.store(true).then((s) => s.list())`);
  expect(snaps as any[]).toHaveLength(1);
  const name = (snaps as any[])[0].name as string;
  expect(name).toMatch(/-\d{14}\.zip$/);

  // The archive is a valid zip: CRCs checked by `unzip -t`, UTF-8 names and bytes by Python's zipfile
  // (macOS's unzip ignores the UTF-8 name flag when listing).
  const b64 = (await page.evaluate(`${corePlugin("backup")}.store(true).then((s) => s.read(${JSON.stringify(name)})).then((buf) => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); })`)) as string;
  const zipPath = join(tmpdir(), `om-backup-${Date.now()}.zip`);
  writeFileSync(zipPath, Buffer.from(b64, "base64"));
  expect(execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" })).toContain("No errors detected");
  const py = `import zipfile, sys, json, base64
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "names": z.namelist(), "bin": base64.b64encode(z.read("media/pixel.bin")).decode(), "uni": z.read("Unicode ✓ note.md").decode("utf-8"), "methods": sorted({i.compress_type for i in z.infolist()})}))`;
  const zipInfo = JSON.parse(execFileSync("python3", ["-c", py, zipPath], { encoding: "utf8" }));
  expect(zipInfo.bad).toBeNull();
  expect(zipInfo.names).toEqual(expect.arrayContaining(["Welcome.md", "media/pixel.bin", "Unicode ✓ note.md", ".obsidian/openmarkdown-plugins.json"]));
  expect(Buffer.from(zipInfo.bin, "base64")).toEqual(Buffer.from([0, 1, 2, 250, 251, 252]));
  expect(zipInfo.uni).toBe("Ünïcödé 😀\n".repeat(50));
  expect(zipInfo.methods).toEqual([0, 8]); // small/binary files stored, text deflated
  const original = await page.evaluate(() => (window as any).app.vault.adapter.read("Welcome.md"));

  // Damage the vault, then restore one file and then everything.
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.vault.modify(a.vault.getFileByPath("Welcome.md"), "overwritten");
    await a.vault.delete(a.vault.getFileByPath("Formatting.md"));
  });
  expect(await command(page, "backup:restore")).toBe(true);
  const restore = page.locator(".modal.vault-backup-restore");
  await restore.locator(".vault-backup-item").first().click();
  await expect(restore.locator('.vault-backup-file[data-path="Formatting.md"] .vault-backup-file-state')).toHaveText("missing");
  await shots(page, "backup-restore", ".modal.vault-backup-restore");
  await restore.locator('.vault-backup-file[data-path="Formatting.md"]').getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).app.vault.getFileByPath("Formatting.md"))).toBe(true);
  expect(await page.evaluate(() => (window as any).app.vault.adapter.read("Welcome.md"))).toBe("overwritten");

  await restore.getByRole("button", { name: "Restore all files" }).click();
  await page.locator(".modal.mod-confirmation").getByRole("button", { name: "Restore all" }).click();
  await expect(page.locator(".modal.vault-device-progress .vault-device-progress-status", { hasText: "Restored" })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as any).app.vault.adapter.read("Welcome.md"))).toBe(original);
  await closeModals(page);
  const after = (await page.evaluate(`${corePlugin("backup")}.store(true).then((s) => s.list())`)) as any[];
  expect(after.map((s) => s.label)).toContain("before-restore");

  // Web Locks: a second backup while one runs is skipped.
  const results = await page.evaluate(`Promise.all([${corePlugin("backup")}.backup({ interactive: false }), ${corePlugin("backup")}.backup({ interactive: false })]).then((r) => r.map((x) => x && x.name))`);
  expect((results as (string | null)[]).filter(Boolean)).toHaveLength(1);

  await openSettingsTab(page, "backup");
  await expect(page.locator(".vault-backup-row").first()).toBeVisible();
  await shots(page, "backup-settings", ".modal.mod-settings");
});

// ---- web panes -------------------------------------------------------------------------------

test("web viewer: web panes from presets get a command, open in the sidebar, note framing refusals", async ({ page }) => {
  await openDemo(page);
  await page.route("https://detexify.kirelabs.org/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><body style='font:20px system-ui;padding:20px'>Detexify (test stub)</body>" }));
  await enableCore(page, "webviewer");
  await openSettingsTab(page, "webviewer");
  const content = page.locator(".vertical-tab-content");
  const addPane = content.locator(".setting-item", { hasText: "Add a web pane" }).locator("select");
  await addPane.selectOption("detexify");
  await content.locator(".setting-item", { hasText: "Add a web pane" }).locator("select").selectOption("keep");
  await expect(content.locator('.vault-web-pane-settings[data-frame="keep"]')).toContainText("refused framing when checked: X-Frame-Options: SAMEORIGIN");
  await shots(page, "web-panes-settings", ".modal.mod-settings");
  const frames = await page.evaluate(() => (window as any).app.internalPlugins.plugins.webviewer.instance.options.frames.map((f: any) => f.id));
  expect(frames).toEqual(["detexify", "keep"]);
  await closeModals(page);
  expect(await command(page, "webviewer:open-frame-detexify")).toBe(true);
  const leaf = page.locator('.workspace-split.mod-right-split .workspace-leaf-content[data-type="webviewer"]');
  await expect(leaf.locator("iframe.webviewer-iframe")).toHaveAttribute("src", "https://detexify.kirelabs.org/classify.html");
  const state = await page.evaluate(() => {
    const l = (window as any).app.workspace.getLeavesOfType("webviewer")[0];
    return { state: l.view.getState(), title: l.view.getDisplayText(), icon: l.view.getIcon() };
  });
  expect(state).toMatchObject({ state: { frame: "detexify" }, title: "Detexify", icon: "lucide-type" });
  // Opening again reveals the same pane instead of a second one.
  await command(page, "webviewer:open-frame-detexify");
  expect(await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("webviewer").length)).toBe(1);
  await page.waitForTimeout(500);
  await shots(page, "web-pane-open");

  // Google Keep refused framing when probed: without the extension the pane says so instead of showing a blank frame.
  expect(await command(page, "webviewer:open-frame-keep")).toBe(true);
  const refusal = page.locator('.workspace-leaf-content[data-type="webviewer"] .webviewer-message', { hasText: "When last checked" });
  await expect(refusal).toContainText("X-Frame-Options: SAMEORIGIN");
  await expect(refusal.getByRole("button", { name: "Try anyway" })).toBeVisible();
  await shots(page, "web-pane-refused", '.workspace-leaf-content[data-type="webviewer"]:has(.webviewer-message:not([style*="none"]))');
});
