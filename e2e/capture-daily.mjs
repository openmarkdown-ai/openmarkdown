// Screenshots of the daily-driver features (docs/PLAN-daily.md) for the test guide, from the built app on :5200.
// Usage: node e2e/capture-daily.mjs <out-dir>            (ONLY=1,3,9 limits it to those sections)
// Section 8 starts a local OpenSync relay (../opensync/target/release/opensync-relay) and is skipped without it;
// the update notice in section 9 starts e2e/daily/pwa-server.mjs on a spare port (its bump-sw hook fakes a new build).
import { chromium, devices } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [out] = process.argv.slice(2);
if (!out) throw new Error("usage: node e2e/capture-daily.mjs <out-dir>");
mkdirSync(out, { recursive: true });
const URL = (process.env.CAPTURE_URL ?? "http://localhost:5200/").replace(/\/?$/, "/");
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",").map(Number)) : null;
const want = (n) => !ONLY || ONLY.has(n);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MOD = "Meta"; // Chromium on this Mac; Mod maps to Meta
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const { defaultBrowserType: _d, ...iphone } = devices["iPhone 13"];
const PHONE = { ...iphone, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

const browser = await chromium.launch();
const errors = [];

async function session(opts = {}) {
  const { colorScheme = "light", base = URL, device = DESKTOP, init = [] } = opts;
  const context = await browser.newContext({ ...device, colorScheme, baseURL: base });
  for (const fn of init) await context.addInitScript(fn);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${e.message}`));
  return { context, page };
}

const ready = (page) => page.waitForFunction(() => window.app?.workspace?.layoutReady && window.app?.metadataCache?.initialized, null, { timeout: 60000 });
const settle = (page, ms = 800) => page.waitForTimeout(ms);
const run = (page, fn, arg) => page.evaluate(fn, arg);
const clearNotices = (page) => page.evaluate(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
async function shot(page, name, opts = {}) {
  const vp = page.viewportSize();
  await page.mouse.move(vp.width - 1, vp.height - 1);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}.png`, ...opts });
  console.log("shot", name);
}

async function openDemo(page) {
  await page.goto(`${URL}?vault=demo`);
  await ready(page);
  await settle(page, 400);
}

/** Create a note (or overwrite it) and open it; mode "source" is Live Preview. */
async function openNote(page, path, content, mode = "source", config = {}) {
  await run(
    page,
    async ({ path, content, mode, config }) => {
      const a = window.app;
      for (const [k, v] of Object.entries(config)) a.vault.setConfig(k, v);
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !a.vault.getAbstractFileByPath(dir)) await a.vault.createFolder(dir);
      let f = a.vault.getFileByPath(path);
      if (f && content !== undefined) await a.vault.modify(f, content);
      if (!f) f = await a.vault.create(path, content ?? "");
      for (let i = 0; i < 60 && !a.metadataCache.getFileCache(f); i++) await new Promise((r) => setTimeout(r, 50));
      const leaf = a.workspace.getLeaf(false);
      await leaf.openFile(f, { state: { mode } });
      a.workspace.setActiveLeaf(leaf, { focus: true });
    },
    { path, content, mode, config },
  );
  if (mode === "source") {
    await page.waitForSelector(".workspace-leaf.mod-active .cm-content");
    await run(page, () => window.app.workspace.activeEditor.editor.focus());
  } else await page.waitForSelector(".workspace-leaf.mod-active .markdown-reading-view .markdown-preview-sizer");
}

async function createFiles(page, files) {
  await run(
    page,
    async (files) => {
      const a = window.app;
      for (const [path, text] of Object.entries(files)) {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir && !a.vault.getAbstractFileByPath(dir)) await a.vault.createFolder(dir);
        const f = a.vault.getFileByPath(path);
        if (f) await a.vault.modify(f, text);
        else await a.vault.create(path, text);
      }
      for (let i = 0; i < 80; i++) {
        if (Object.keys(files).every((p) => !p.endsWith(".md") || a.metadataCache.getFileCache(a.vault.getFileByPath(p)))) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    files,
  );
  await settle(page, 400);
}

const cursorAt = (page, line, ch) =>
  run(page, ({ line, ch }) => {
    const e = window.app.workspace.activeEditor.editor;
    e.focus();
    e.setCursor({ line, ch: ch < 0 ? e.getLine(line).length : ch });
  }, { line, ch });

const command = (page, id) => run(page, (id) => window.app.commands.executeCommandById(id), id);
const enableCore = (page, ...ids) => run(page, async (ids) => { for (const id of ids) await window.app.internalPlugins.setEnabled(id, true); }, ids);

/** A browser-stored (OPFS) vault written directly, so later "outside" writes are real storage writes. */
async function createBrowserVault(page, name, files) {
  await page.goto(`${URL}?choose=1`);
  await page.waitForSelector(".vault-starter", { timeout: 30000 });
  return run(
    page,
    async ({ name, files }) => {
      const id = "cap" + Math.random().toString(16).slice(2, 12);
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle("vaults", { create: true })).getDirectoryHandle(id, { create: true });
      for (const [path, content] of Object.entries(files)) {
        const segs = path.split("/");
        const file = segs.pop();
        let d = dir;
        for (const s of segs) d = await d.getDirectoryHandle(s, { create: true });
        const w = await (await d.getFileHandle(file, { create: true })).createWritable();
        await w.write(content);
        await w.close();
      }
      await new Promise((ok, fail) => {
        const req = indexedDB.open("vault-app");
        req.onsuccess = () => {
          const t = req.result.transaction("handles", "readwrite");
          t.objectStore("handles").put({ id, name, kind: "browser", lastOpened: Date.now() }, `vault:${id}`);
          t.oncomplete = () => (req.result.close(), ok());
          t.onerror = () => fail(t.error);
        };
        req.onerror = () => fail(req.error);
      });
      return id;
    },
    { name, files },
  );
}

// ---- plausible content ------------------------------------------------------------------------

const ESSAY = `# Why we walk

The first thing you notice on a long walk is how loud your own head is. For the first hour the mind keeps arguing with emails that have not arrived yet, rehearsing conversations that will never happen, and counting the things left undone.

Somewhere in the second hour it gets quieter. The rhythm of the feet takes over the rhythm of the thoughts, and the landscape starts to arrive on its own terms: the smell of cut hay, a dog barking two farms away, the way the light goes flat just before rain.

Writers have known this for a long time. Wordsworth is said to have walked more than a hundred and seventy thousand miles in his life, composing as he went, and Nietzsche claimed that only thoughts reached by walking had any value.

There is a practical reason for it. Walking raises the heart rate just enough to wake the brain without asking it to concentrate on the body. Studies of creative tasks find that people come up with more ideas while walking than while sitting, and that the effect lingers for a while after they sit down again.

But the real gift is permission. On a walk nobody expects you to be productive. There is no inbox on the footpath, and a problem you have been circling for a week can simply be carried along, turned over, and put down again without anyone asking for a status update.

I started walking to the office two years ago because the bus was unreliable. Forty minutes each way felt like a cost at first. Now it is the part of the day I protect most fiercely, and the part where most of my decent ideas turn up.

The trick, if there is one, is to leave the headphones at home at least once a week. A podcast fills the silence that the mind needs in order to wander, and wandering is the whole point.

So this is an argument for inefficiency: for the long way round, for the detour past the canal, for arriving a little late with a head that feels lighter than when you left.

Next week I will write about the routes themselves, and about the one stretch of towpath where I have solved more bugs than anywhere else.
`;

const TRIP = `# Portugal trip — October

## Lisbon
- Three nights in Lisbon, staying near Alfama
- Tram 28 early in the morning, before the queues
- Day trip from Lisbon to Sintra on the Friday

## Porto
- Train from Lisbon to Porto (about 3 hours)
- Port lodges in Vila Nova de Gaia
- Livraria Lello — book tickets online

## Budget
Flights to Lisbon are cheapest on Tuesdays. Keep a note of the Lisbon card price before deciding.
`;

const READING_LOG = `# Reading log 2026

Books finished this year, sorted by rating. Pages are from the edition I read.

| Title | Author | Pages | Rating |
| --- | --- | ---: | :---: |
| The Left Hand of Darkness | Ursula K. Le Guin | 304 | 5 |
| Piranesi | Susanna Clarke | 272 | 5 |
| The Overstory | Richard Powers | 502 | 4 |
| Klara and the Sun | Kazuo Ishiguro | 303 | 4 |
| Project Hail Mary | Andy Weir | 476 | 4 |

Next up: *The Dispossessed* and *A Psalm for the Wild-Built*.
`;

const words = (n) => Array.from({ length: n }, (_, i) => ["the", "draft", "chapter", "garden", "river", "morning", "letter", "quiet", "window", "harbour"][i % 10]).join(" ");

// ---- 1. data safety ---------------------------------------------------------------------------
if (want(1)) {
  const { context, page } = await session();
  const meeting = "# Design review — 14 September\n\nAttendees: Priya, Tom, Alex\n\n## Decisions\n- Ship the new onboarding flow on 1 October\n- Keep the old settings page for one more release\n\n## Actions\n- Tom: update the empty-state illustrations\n- Alex: write the migration guide\n";
  const id = await createBrowserVault(page, "Work notes", {
    "Design review.md": meeting,
    "Project brief.md": "# Project brief\n\nA calmer onboarding for first-time users.\n\n## Goals\n- Fewer steps before the first note\n- No account needed to start\n",
    "Weekly plan.md": "# Week 38\n\n- [ ] Draft the migration guide\n- [ ] Review Tom's illustrations\n- [x] Book the design review room\n",
    "Archive/Old ideas.md": "# Old ideas\n",
  });
  await page.goto(`${URL}?vault=${id}`);
  await ready(page);
  await run(page, async () => {
    const a = window.app;
    await a.workspace.getLeaf(false).openFile(a.vault.getFileByPath("Design review.md"));
  });
  await page.waitForSelector(".workspace-leaf.mod-active .cm-content");
  await settle(page, 600);
  // Edit "Ship the new onboarding flow on 1 October" in the app…
  await cursorAt(page, 5, -1);
  await page.keyboard.type(" (after the beta feedback)");
  // …while another program (a sync client, another editor) changes the same line on disk.
  await run(page, async ({ id, text }) => {
    const root = await navigator.storage.getDirectory();
    const d = await (await root.getDirectoryHandle("vaults")).getDirectoryHandle(id);
    const w = await (await d.getFileHandle("Design review.md")).createWritable();
    await w.write(text);
    await w.close();
    await window.app.vault.sync(true);
  }, { id, text: meeting.replace("on 1 October", "on 8 October — moved by Priya") });
  await page.waitForSelector(".workspace-leaf.mod-active .vault-safety-banner.mod-conflict", { timeout: 10000 });
  // A note on screen shows only the banner (no notice over its buttons).
  await settle(page, 1500);
  await clearNotices(page);
  await shot(page, "01-conflict-banner");
  await page.locator(".workspace-leaf.mod-active .vault-safety-banner.mod-conflict").getByRole("button", { name: "Compare…" }).click();
  await page.waitForSelector(".modal.vault-conflict-modal");
  await settle(page, 600);
  await shot(page, "02-conflict-compare");
  await page.locator(".modal.vault-conflict-modal").getByRole("button", { name: "Keep both" }).click();
  await settle(page, 1500);
  await clearNotices(page);

  // A write that fails (storage full): the status bar and a notice say so, and it keeps retrying.
  await run(page, async () => {
    const a = window.app;
    await a.workspace.getLeaf(false).openFile(a.vault.getFileByPath("Weekly plan.md"));
    const adapter = a.vault.adapter;
    const original = adapter.write;
    adapter.write = async function (...args) {
      if (window.__failWrites !== false) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await page.waitForSelector(".workspace-leaf.mod-active .cm-content");
  await cursorAt(page, 4, -1);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Send the agenda for Thursday");
  await page.waitForSelector(".status-bar-item.vault-save-status.mod-error", { timeout: 10000 });
  await page.locator(".notice", { hasText: "Could not save" }).first().waitFor();
  await settle(page, 600);
  await shot(page, "03-not-saved-retrying");
  await run(page, () => (window.__failWrites = false));
  await context.close();
}

// ---- 2. editor --------------------------------------------------------------------------------
if (want(2)) {
  const { context, page } = await session();
  await openDemo(page);

  await openNote(page, "Portugal trip.md", TRIP);
  await cursorAt(page, 0, 0);
  await page.keyboard.press(`${MOD}+h`);
  await page.keyboard.type("Lisbon");
  await page.keyboard.press("Enter");
  await page.keyboard.press(`${MOD}+h`);
  await page.keyboard.type("Lisboa");
  await settle(page, 500);
  await shot(page, "04-find-replace");
  await page.keyboard.press("Escape");

  await openNote(page, "Reading log 2026.md", READING_LOG);
  await cursorAt(page, 6, 4);
  await page.waitForSelector(".workspace-leaf.mod-active .vault-table-toolbar");
  await settle(page, 500);
  await shot(page, "05-table-toolbar");

  await openNote(page, "Why we walk.md", ESSAY, "source", { typewriterScroll: true, typewriterOffset: 50 });
  await cursorAt(page, 10, -1);
  await page.keyboard.press(`${MOD}+Shift+Enter`);
  await page.waitForFunction(() => document.body.classList.contains("vault-focus-mode"));
  await page.keyboard.type(" It also helps to have somewhere to go.");
  await settle(page, 800);
  await shot(page, "06-focus-typewriter");
  await page.keyboard.press("Escape");
  await run(page, () => window.app.vault.setConfig("typewriterScroll", false));

  await run(page, () => window.app.vault.setConfig("formattingToolbar", "fixed"));
  await openNote(page, "Why we walk.md");
  await page.waitForSelector(".workspace-leaf.mod-active .vault-formatting-toolbar");
  await run(page, () => {
    const e = window.app.workspace.activeEditor.editor;
    e.setSelection({ line: 2, ch: 49 }, { line: 2, ch: 67 }); // "loud your own head"
    e.cm.scrollDOM.scrollTop = 0;
  });
  await settle(page, 500);
  await shot(page, "07-formatting-toolbar");
  await run(page, () => window.app.vault.setConfig("formattingToolbar", "off"));

  await openNote(page, "Novel/Chapter 3.md", `---\nword-goal: 1500\n---\n# Chapter 3 — The harbour\n\n${ESSAY.split("\n\n").slice(1, 7).join("\n\n")}\n`);
  await run(page, async () => {
    const p = window.app.internalPlugins.getPluginById("word-count");
    p.instance.options.dailyWordGoal = 500;
    p.instance.plugin.update();
  });
  await cursorAt(page, 13, -1);
  await page.keyboard.type(" The harbour lights came on one by one as the ferry turned for home.");
  await page.waitForSelector(".status-bar .plugin-word-count .vault-word-goal");
  await settle(page, 600);
  await shot(page, "08-word-goal");
  await shot(page, "08b-word-goal-status-bar", { clip: { x: 900, y: 860, width: 540, height: 40 } });
  await context.close();

  // Dark editor
  const dark = await session({ colorScheme: "dark" });
  await openDemo(dark.page);
  await run(dark.page, () => window.app.workspace.rightSplit.expand());
  await run(dark.page, () => window.app.vault.setConfig("formattingToolbar", "fixed"));
  await openNote(dark.page, "Reading log 2026.md", READING_LOG);
  await cursorAt(dark.page, 6, 4);
  await dark.page.waitForSelector(".workspace-leaf.mod-active .vault-table-toolbar");
  await settle(dark.page, 1000);
  await shot(dark.page, "09-dark-editor");
  await dark.context.close();
}

// ---- 3. phone ---------------------------------------------------------------------------------
async function phoneNote(page, name, content) {
  await createFiles(page, { [name]: content });
  await run(page, (n) => window.app.workspace.openLinkText(n, "", false), name.replace(/\.md$/, ""));
  await page.waitForSelector(".mod-root .workspace-leaf.mod-active .cm-content");
  await run(page, () => {
    const e = window.app.workspace.activeEditor?.editor;
    e?.setCursor({ line: 1, ch: 0 }); // a blank line: keeps the heading's # hidden and the top in view
    document.activeElement?.blur();
  });
  await settle(page, 300);
}
const ERRANDS = "# Saturday errands\n\n## Market\n- [x] Sourdough loaf\n- [ ] Tomatoes, basil, mozzarella\n- [ ] Flowers for Mum\n\n## Hardware shop\n- [ ] Picture hooks\n- [ ] Sandpaper (fine)\n\n## Calls\n- [ ] Book the boiler service\n- [ ] Ask Sam about the bike rack\n\nRemember the reusable bags. The market closes at **1 pm**.\n";

if (want(3)) {
  const { context, page } = await session({ device: PHONE });
  await openDemo(page);
  await phoneNote(page, "Saturday errands.md", ERRANDS);
  await page.locator(".mod-root .workspace-leaf.mod-active .cm-line").nth(4).tap();
  await page.waitForSelector(".mobile-toolbar", { state: "visible" });
  await run(page, () => {
    const e = window.app.workspace.activeEditor.editor;
    e.setCursor({ line: 5, ch: e.getLine(5).length });
  });
  await page.keyboard.type(", olives");
  await page.setViewportSize({ width: 390, height: 500 });
  await settle(page, 700);
  await shot(page, "10-phone-keyboard-toolbar");
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page, 500);
  await run(page, () => document.activeElement?.blur());
  await settle(page, 300);

  await page.locator(".vault-mobile-sidebar-toggle.mod-left").tap();
  await page.waitForFunction(() => document.querySelector(".workspace-drawer.mod-left")?.classList.contains("is-open"));
  await settle(page, 600);
  await shot(page, "11-phone-left-drawer");
  await page.mouse.click(370, 500);
  await settle(page, 500);

  await run(page, async () => {
    await window.app.workspace.openLinkText("Formatting", "", "tab");
    await window.app.workspace.openLinkText("Linking notes", "", "tab");
  });
  await settle(page, 400);
  await run(page, () => document.activeElement?.blur());
  await page.locator(".mobile-navbar-tabs-action").tap();
  await page.waitForSelector(".mobile-tab-switcher", { state: "visible" });
  await settle(page, 700);
  await shot(page, "12-phone-tab-switcher");
  await context.close();

  const dark = await session({ device: PHONE, colorScheme: "dark" });
  await openDemo(dark.page);
  await phoneNote(dark.page, "Saturday errands.md", ERRANDS);
  await settle(dark.page, 600);
  await shot(dark.page, "13-phone-dark");
  await dark.context.close();
}

// ---- 4. knowledge -----------------------------------------------------------------------------
if (want(4)) {
  const { context, page } = await session();
  await openDemo(page);
  await createFiles(page, {
    "Inbox/202609141030.md": "# Spaced repetition beats rereading\n\nTesting yourself is what makes things stick.\n",
    "Inbox/202609141122.md": "# Offline-first is a product feature\n\nUsers notice when the app works on the train.\n",
    "Inbox/202609150905.md": "# Small notes link better than long ones\n\nOne idea per note.\n",
    "Inbox/untitled-3.md": "# Questions for the garden club\n\n- When do we order seed potatoes?\n",
  });
  await run(page, () => window.app.vault.setConfig("displayTitle", "heading"));
  await run(page, async () => {
    const a = window.app;
    a.internalPlugins.getPluginById("file-explorer").instance.revealInFolder(a.vault.getFileByPath("Inbox/202609141030.md"));
    await a.workspace.getLeaf(false).openFile(a.vault.getFileByPath("Inbox/202609141122.md"));
    a.workspace.activeEditor?.editor?.setCursor({ line: 1, ch: 0 });
  });
  await settle(page, 1000);
  await shot(page, "14-titles-from-h1");
  await run(page, () => window.app.vault.setConfig("displayTitle", undefined));

  await openDemo(page);
  await createFiles(page, {
    "Clients/Acme onboarding.md": "# Acme onboarding\n\nKick-off with Acme Corp on Monday. Acme Corp wants weekly updates.\n\nContract signed by Acme Corp legal.\n",
    "Clients/Invoices.md": "# Invoices\n\n- Acme Corp — August, paid\n- Northwind — August, due\n",
    "Meetings/2026-09-10 sync.md": "# Sync\n\nAcme Corp asked for the roadmap. Send it Friday.\n\n```\nlegacy id: Acme Corp (do not change)\n```\n",
  });
  await run(page, async () => {
    const a = window.app;
    await a.workspace.getLeaf(false).openFile(a.vault.getFileByPath("Clients/Acme onboarding.md"));
    a.workspace.activeEditor?.editor?.setCursor({ line: 1, ch: 0 });
  });
  await page.keyboard.press(`${MOD}+Shift+h`);
  await page.keyboard.type('"Acme Corp"');
  await page.waitForSelector(".search-result-file-title");
  await page.locator(".vault-replace-input").fill("Acme Inc.");
  await page.waitForSelector(".vault-replace-match");
  await settle(page, 600);
  await page.locator('.search-result:has(.tree-item-inner:text-is("2026-09-10 sync")) .vault-replace-match').last().locator(".vault-replace-checkbox").uncheck();
  await settle(page, 400);
  await shot(page, "15-vault-replace-preview");

  await openDemo(page);
  const dates = await run(page, () => [0, 1, 2, 4, 6, 8, 11, 13].map((d) => window.moment().subtract(d, "day").format("YYYY-MM-DD")));
  const daily = {};
  const entries = [
    "- Planted garlic in bed 3\n- Called Mum about Sunday lunch\n- [ ] Order seed potatoes",
    "Long run along the canal, 12 km. Knee felt fine.\n\n## Work\n- Finished the migration guide draft\n- Design review moved to Thursday\n\n## Reading\nStarted *Piranesi* — the house is wonderful.",
    "- Dentist at 9:30\n- Lunch with Priya: talked about the onboarding research",
    "Rainy. Stayed in and sorted the photos from Porto.\n\nIdeas for the garden club talk:\n1. Composting in small spaces\n2. Saving seeds from tomatoes\n3. Rainwater tanks on a budget\n\nNeed to ask the council about the lease before November.",
    "- Book club: *The Overstory*. Everyone loved the first part, fewer liked the ending.",
    "Quiet day. Fixed the bike brakes and cleaned the shed.\n\n- [x] Pay council tax\n- [x] Return library books\n- [ ] Email the landlord about the boiler",
    "- Train to Leeds for the workshop\n- Good session on accessible forms; notes in [[Projects]]",
    "Weekly review.\n\n## Went well\n- Shipped the settings page fix\n- Three runs this week\n\n## To change\n- Fewer meetings on Mondays\n- Start the essay about walking",
  ];
  dates.forEach((d, i) => (daily[`Daily/${d}.md`] = `# ${d}\n\n${entries[i]}\n`));
  await createFiles(page, daily);
  await run(page, async () => {
    const inst = window.app.internalPlugins.getPluginById("daily-notes").instance;
    inst.options.folder = "Daily";
    await inst.saveOptions();
  });
  await enableCore(page, "calendar");
  await command(page, "calendar:show-calendar-view");
  await page.waitForSelector(".vault-calendar-view table.calendar");
  await run(page, async () => {
    window.app.workspace.getLeavesOfType("calendar-view")[0].view.render();
    await window.app.workspace.getLeaf(false).openFile(window.app.vault.getFileByPath(`Daily/${window.moment().subtract(1, "day").format("YYYY-MM-DD")}.md`));
    window.app.workspace.activeEditor?.editor?.setCursor({ line: 1, ch: 0 });
  });
  await settle(page, 1000);
  await shot(page, "16-calendar-daily-notes");

  await openDemo(page);
  await createFiles(page, {
    "Garden/Tomatoes.md": "---\ntags:\n  - garden\n  - garden/vegetables\n---\n# Tomatoes\n\nSow indoors in March. #garden/vegetables\n",
    "Garden/Compost.md": "---\ntags: [garden]\n---\n# Compost\n\nTurn it every two weeks. #garden\n",
    "Journal/2026-09-12.md": "Spent the morning in the #garden, picked the last beans.\n",
  });
  await command(page, "tag-pane:open");
  await page.locator('.tag-pane-tag[data-tag="garden"]').click({ button: "right" });
  await page.locator(".menu-item", { hasText: "Rename tag" }).click();
  await page.waitForSelector(".vault-rename-tag-modal");
  await page.locator(".vault-rename-tag-input").fill("home/garden");
  await settle(page, 600);
  await shot(page, "17-tag-rename");
  await context.close();
}

// ---- 5. paste & media -------------------------------------------------------------------------
if (want(5)) {
  const { context, page } = await session();
  const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  const COVER = svg(600, 315, '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8c39e"/><stop offset="1" stop-color="#8a5a3b"/></linearGradient></defs><rect width="600" height="315" fill="url(#g)"/><ellipse cx="300" cy="175" rx="170" ry="95" fill="#f3e3cf"/><path d="M180 160 q60 -40 120 0 q60 40 120 0" stroke="#b98758" stroke-width="10" fill="none"/>');
  const FAVICON = svg(32, 32, '<rect width="32" height="32" rx="6" fill="#8a5a3b"/><circle cx="16" cy="16" r="8" fill="#f3e3cf"/>');
  // Nothing leaves the machine: every non-local request is refused or answered here.
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort("blockedbyclient"));
  await page.route(/^https:\/\/example\.com\//, (r) => {
    const p = new globalThis.URL(r.request().url()).pathname;
    if (p === "/cover.svg") return r.fulfill({ contentType: "image/svg+xml", body: COVER });
    if (p === "/favicon.svg") return r.fulfill({ contentType: "image/svg+xml", body: FAVICON });
    return r.fulfill({ status: 404, body: "" });
  });
  const requests = [];
  page.on("request", (r) => /youtube|ytimg|vimeo/.test(r.url()) && requests.push(r.url()));
  await openDemo(page);
  await enableCore(page, "media", "smart-paste");
  await run(page, async () => {
    const inst = window.app.internalPlugins.getPluginById("media").instance;
    inst.options.clickToLoadEmbeds = true;
    await inst.saveOptions();
    await window.app.internalPlugins.setEnabled("media", false);
    await window.app.internalPlugins.setEnabled("media", true);
  });
  const note = [
    "# Sourdough workshop",
    "",
    "Notes from Saturday's class. The starter should double in 4–6 hours at 24 °C.",
    "",
    "## Shaping demo",
    "",
    "![|560x315](https://www.youtube.com/watch?v=Xq2bT7mLk9A&t=95)",
    "",
    "## Further reading",
    "",
    "```cardlink",
    "url: https://example.com/sourdough-guide",
    'title: "A beginner\'s guide to sourdough hydration"',
    'description: "How much water to use, why it changes with flour, and a simple schedule for your first loaf."',
    "host: example.com",
    "favicon: https://example.com/favicon.svg",
    "image: https://example.com/cover.svg",
    "```",
    "",
  ].join("\n");
  await openNote(page, "Sourdough workshop.md", note, "preview");
  await page.waitForSelector(".workspace-leaf.mod-active .markdown-reading-view .vault-embed-load-button");
  await page.waitForSelector(".workspace-leaf.mod-active .markdown-reading-view .auto-card-link-card");
  await settle(page, 1200);
  await shot(page, "18-youtube-click-to-load-link-card");
  if (requests.length) errors.push(`click-to-load: requests made before a click: ${requests.join(", ")}`);
  await context.close();
}

// ---- 6. export --------------------------------------------------------------------------------
if (want(6)) {
  const { context, page } = await session();
  await openDemo(page);
  const proposal = "---\ntitle: Community garden proposal\nauthor: Riverside Residents' Association\n---\n# Summary\n\nWe propose turning the empty lot on Mill Lane into a community garden with twelve raised beds, a tool shed and a rainwater tank.\n\n## Budget\n\n| Item | Cost |\n| --- | ---: |\n| Raised beds (12) | £1,440 |\n| Tool shed | £620 |\n| Rainwater tank | £310 |\n\n## Timeline\n\n1. Clear the site in October\n2. Build the beds in November\n3. First planting in March\n\n> [!note] Council approval\n> The lease needs sign-off at the November planning meeting.\n\n# Appendix\n\nVolunteer rota and contacts.\n";
  await openNote(page, "Community garden proposal.md", proposal, "preview");
  await run(page, () => (window.print = () => {}));
  await command(page, "workspace:export-pdf");
  const modal = page.locator(".modal.mod-pdf-export");
  await modal.waitFor();
  await modal.locator(".setting-item", { hasText: "Table of contents" }).locator(".checkbox-container").click();
  await modal.locator(".setting-item", { hasText: "Page size" }).locator("select").selectOption("A4");
  await modal.locator(".setting-item", { hasText: "Header" }).locator("input").fill("{{title}} | | {{date}}");
  await settle(page, 600);
  await shot(page, "19-pdf-export-options");
  await page.keyboard.press("Escape");

  await enableCore(page, "slides");
  const deck = `---\ntheme: night\ntransition: fade\n---\n<!-- slide bg="#1f3a4d" -->\n# Riverside Community Garden\n\nAutumn update · September 2026 <!-- element class="fragment" -->\n\nnote: Thank the volunteers first.\n\n---\n\n## What we did this summer\n\n+ 12 raised beds built\n+ 38 volunteers signed up\n+ 140 kg of vegetables donated\n\n---\n\n## Next steps\n\nApply for the rainwater grant by 30 October.\n`;
  await openNote(page, "Garden update deck.md", deck);
  await command(page, "slides:start");
  await page.locator(".vault-reveal-container .reveal.ready").waitFor({ timeout: 30000 });
  await page.keyboard.press("ArrowRight"); // fragment
  await page.keyboard.press("ArrowRight"); // slide 2
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight"); // its three bullets
  await settle(page, 1200);
  await shot(page, "20-slides-reveal");
  await page.keyboard.press("Escape");
  await context.close();
}

// ---- 7. device & AI ---------------------------------------------------------------------------
function aiFakes() {
  const w = window;
  const stream = (chunks) => new ReadableStream({ async start(c) { for (const x of chunks) { await new Promise((r) => setTimeout(r, 30)); c.enqueue(x); } c.close(); } });
  const make = (factory) => ({ availability: async () => "available", create: async (o = {}) => ({ ...factory(o), destroy() {} }) });
  const fix = (q) => q.replace(/\brecieve\b/g, "receive").replace(/\bteh\b/g, "the").replace(/\bdefinately\b/g, "definitely").replace(/\bseperately\b/g, "separately");
  w.Summarizer = make(() => ({ summarizeStreaming: () => stream(["* summary"]), summarize: async () => "* summary" }));
  w.Translator = make((o) => ({ translate: async (t) => t }));
  w.LanguageDetector = make(() => ({ detect: async () => [{ detectedLanguage: "en", confidence: 0.97 }] }));
  w.LanguageModel = make((o) => {
    const system = o.initialPrompts?.[0]?.content ?? "";
    const reply = (q) => (/^Correct spelling/.test(system) ? fix(q) : "OK.");
    return { prompt: async (q) => reply(q), promptStreaming: (q) => { const r = reply(q); return stream([r.slice(0, 12), r.slice(12)]); } };
  });
}

if (want(7)) {
  const { context, page } = await session({ init: [aiFakes] });
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort("blockedbyclient"));
  await openDemo(page);

  // Backups: two snapshots, then a damaged vault, then the restore dialog.
  await run(page, async () => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("openmarkdown-backups", { recursive: true }).catch(() => {});
  });
  await enableCore(page, "backup");
  for (let i = 0; i < 2; i++) {
    await command(page, "backup:create-now");
    const progress = page.locator(".modal.vault-device-progress");
    await progress.locator(".vault-device-progress-status", { hasText: "Saved" }).waitFor({ timeout: 30000 });
    await progress.locator(".modal-button-container button", { hasText: "Close" }).click();
    await settle(page, 1200);
    if (i === 0) await createFiles(page, { "Journal/2026-09-15.md": "# Tuesday\n\nFinished the proposal draft.\n" });
  }
  await run(page, async () => {
    const a = window.app;
    await a.vault.modify(a.vault.getFileByPath("Welcome.md"), "# Welcome\n\n(accidentally overwritten)\n");
    await a.vault.delete(a.vault.getFileByPath("Formatting.md"));
  });
  await command(page, "backup:restore");
  const restore = page.locator(".modal.vault-backup-restore");
  await restore.locator(".vault-backup-item").first().click();
  await restore.locator('.vault-backup-file[data-path="Formatting.md"] .vault-backup-file-state').waitFor();
  await settle(page, 600);
  await shot(page, "21-backups-restore");
  await page.keyboard.press("Escape");
  await run(page, () => document.querySelectorAll(".modal-container").forEach((m) => m.remove()));

  // Reminders, relative to now.
  const fmt = (d, time = true) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}${time ? ` ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : ""}`;
  const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
  const later = new Date(Date.now() + 2 * 3600e3);
  later.setMinutes(later.getMinutes() < 30 ? 30 : 0, 0, 0);
  if (later.getMinutes() === 0) later.setHours(later.getHours() + 1);
  await createFiles(page, {
    "Tasks.md": [
      "# Tasks",
      "",
      `- [ ] Call the dentist to move the appointment (@${fmt(later)})`,
      `- [ ] Send the invoice to Northwind (@${fmt(at(1, 9, 30))})`,
      `- [ ] Water the seedlings (@${fmt(at(1, 18))})`,
      `- [ ] Renew the car insurance (@${fmt(at(5, 0), false)})`,
      `- [ ] Book train tickets for the Porto trip (@${fmt(at(9, 12))})`,
      `- [x] Pay the electricity bill (@${fmt(at(-1, 10))})`,
    ].join("\n") + "\n",
  });
  await enableCore(page, "reminders");
  await run(page, async () => {
    const a = window.app;
    await a.workspace.getLeaf(false).openFile(a.vault.getFileByPath("Tasks.md"));
    a.workspace.activeEditor?.editor?.setCursor({ line: 1, ch: 0 });
  });
  await command(page, "reminders:show-list");
  await page.locator(".vault-reminders-view", { hasText: "Northwind" }).waitFor();
  await settle(page, 800);
  await shot(page, "22-reminders-list");

  // AI tools: proofread shows a diff before anything changes.
  await run(page, () => window.app.workspace.rightSplit.collapse());
  await enableCore(page, "ai-tools");
  await openNote(page, "Letter to the allotment committee.md", "# Letter to the allotment committee\n\nDear committee,\n\nThank you for the plot on the east side. I will recieve teh seeds on Friday and will definately plant the beans seperately from the herbs.\n\nBest wishes,\nSam\n");
  await run(page, () => {
    const e = window.app.workspace.activeEditor.editor;
    e.setSelection({ line: 4, ch: 0 }, { line: 4, ch: e.getLine(4).length });
  });
  await command(page, "ai-tools:proofread");
  await page.locator(".modal.vault-ai-modal .vault-ai-output ins").first().waitFor({ timeout: 10000 });
  await settle(page, 800);
  await shot(page, "23-ai-proofread-diff");
  await context.close();
}

// ---- 8. sync ----------------------------------------------------------------------------------
const freePort = () => new Promise((ok, fail) => { const s = createServer(); s.on("error", fail); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });

if (want(8)) {
  const bin = process.env.OPENSYNC_RELAY_BIN ?? join(root, "../opensync/target/release/opensync-relay");
  if (!existsSync(bin)) console.log("section 8: no relay binary at", bin, "— skipped");
  else {
    const dir = mkdtempSync(join(tmpdir(), "om-capture-relay-"));
    const port = await freePort();
    writeFileSync(join(dir, "relay.toml"), [`bind = "127.0.0.1:${port}"`, `data_dir = ${JSON.stringify(dir)}`, `database_url = ${JSON.stringify(`sqlite://${dir}/relay.db?mode=rwc`)}`, "require_auth = true"].join("\n"));
    const relay = spawn(bin, [join(dir, "relay.toml")], { stdio: "ignore" });
    try {
      for (let until = Date.now() + 15000; Date.now() < until; ) {
        try { if ((await fetch(`http://127.0.0.1:${port}`, { headers: { Accept: "application/nostr+json" } })).ok) break; } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      const { context, page } = await session();
      await page.goto(`${URL}?choose=1`);
      await page.waitForSelector(".vault-starter");
      await page.locator(".vault-starter-name").fill("Household");
      await page.locator(".vault-starter-action", { hasText: "Create new vault" }).getByRole("button", { name: "Create" }).click();
      await page.waitForURL(/[?&]vault=/);
      await ready(page);
      await createFiles(page, { "Recipes/Lentil soup.md": "# Lentil soup\n\n- 200 g red lentils\n- 1 onion\n", "Bills.md": "# Bills\n\n- Council tax: 1st of the month\n", "Holiday ideas.md": "# Holiday ideas\n\n- Porto in October\n" });
      await run(page, async () => { await window.app.workspace.getLeaf(false).openFile(window.app.vault.getFileByPath("Holiday ideas.md")); });
      const openSync = () => run(page, () => { window.app.setting.open(); window.app.setting.openTabById("sync"); });
      await openSync();
      await page.waitForSelector(".vault-sync-settings");
      await settle(page, 600);
      await shot(page, "24-sync-settings-before-setup");
      await page.locator(".setting-item", { hasText: "Turn on sync" }).getByRole("button", { name: "Turn on" }).click();
      const modal = page.locator(".modal.vault-sync-modal");
      const row = modal.locator(".setting-item", { hasText: "Sync server" }).first();
      await row.locator("select").selectOption("own");
      await row.locator("input.vault-sync-server-address").fill(`127.0.0.1:${port}`);
      await modal.locator("input.vault-sync-device-name").fill("Kitchen laptop");
      await settle(page, 500);
      await shot(page, "25-sync-turn-on");
      await modal.getByRole("button", { name: "Turn on sync" }).click();
      const kit = page.locator(".modal.vault-sync-modal", { hasText: "print your recovery kit" });
      await kit.waitFor({ timeout: 30000 });
      await kit.getByRole("button", { name: "I've saved it" }).click();
      await run(page, () => window.app.setting.close());
      await page.waitForFunction(() => /^Synced/.test(document.querySelector(".status-bar-item.vault-sync-status")?.textContent ?? ""), null, { timeout: 60000 });
      await openSync();
      await page.waitForSelector(".vault-sync-status-lines");
      await settle(page, 800);
      await shot(page, "25b-sync-status-after-setup");
      await page.locator(".setting-item", { hasText: "Add a device" }).getByRole("button", { name: "Add a device" }).click();
      const pair = page.locator(".modal.vault-sync-pair-modal");
      await page.waitForFunction(() => /^[0-9a-z]{4}-[0-9a-z]{6}$/.test(document.querySelector(".modal.vault-sync-pair-modal .vault-sync-code")?.textContent?.trim() ?? ""), null, { timeout: 30000 });
      await settle(page, 600);
      await shot(page, "26-sync-pairing-code");
      await pair.waitFor();
      await context.close();
    } finally {
      relay.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ---- 9. quick capture, App settings, update notice ----------------------------------------------
if (want(9)) {
  const { context, page } = await session();
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const id = await createBrowserVault(page, "Personal", {
    [`${iso}.md`]: "# Today\n\n- 08:12 Ran 5 km along the canal\n- 09:40 Idea: a shared shopping list for the flat\n",
    "Projects/Garden.md": "# Garden\n\n- [ ] Order seed potatoes\n",
    "Reading list.md": "# Reading list\n\n- Piranesi\n",
  });
  await page.goto(`${URL}?vault=${id}`);
  await ready(page);
  await run(page, async () => { const a = window.app; await a.workspace.getLeaf(false).openFile(a.vault.getFileByPath(a.vault.getFiles().find((f) => /^\d{4}-\d\d-\d\d\.md$/.test(f.path)).path)); a.workspace.activeEditor?.editor?.setCursor({ line: 1, ch: 0 }); });
  await settle(page, 500);
  await command(page, "quick-capture:open");
  await page.locator(".modal .vault-capture-input").waitFor();
  await page.keyboard.type("Call the plumber about the dripping kitchen tap");
  await settle(page, 500);
  await shot(page, "27-quick-capture-sheet");
  await page.keyboard.press("Escape");
  await run(page, () => document.querySelectorAll(".modal-container").forEach((m) => m.remove()));

  await run(page, () => { window.app.setting.open(); window.app.setting.openTabById("general"); });
  const install = page.locator(".vault-install-row").first();
  await install.waitFor({ timeout: 10000 }).catch(() => {});
  const appHeading = page.locator(".vertical-tab-content .setting-item-heading", { hasText: /^App$/ }).first();
  if (await appHeading.count()) await appHeading.scrollIntoViewIfNeeded();
  else if (await install.count()) await install.scrollIntoViewIfNeeded();
  await settle(page, 600);
  await shot(page, "28-settings-general-app");
  await context.close();

  // Update available: a second static server whose test hook makes sw.js look like a new build.
  const port = await freePort();
  const server = spawn(process.execPath, [join(here, "daily/pwa-server.mjs"), join(root, "apps/web/dist"), String(port)], { stdio: "ignore" });
  try {
    const base = `http://localhost:${port}/`;
    for (let until = Date.now() + 10000; Date.now() < until; ) {
      try { if ((await fetch(base)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const s = await session({ base });
    await s.page.goto(`${base}?vault=demo`);
    await ready(s.page);
    await s.page.waitForFunction(async () => { const reg = await navigator.serviceWorker.getRegistration(); return reg?.active?.state === "activated" && !!navigator.serviceWorker.controller; }, null, { timeout: 120000, polling: 500 });
    await run(s.page, () => window.app.workspace.openLinkText("Welcome", "", false));
    await settle(s.page, 800);
    await fetch(`${base}__om_test__/bump-sw`);
    await run(s.page, async () => (await navigator.serviceWorker.getRegistration()).update());
    await s.page.locator(".vault-update-notice").waitFor({ timeout: 120000 });
    await settle(s.page, 800);
    await shot(s.page, "29-update-available");
    await s.context.close();
  } finally {
    server.kill();
  }
}

await browser.close();
if (errors.length) console.log("page errors:\n" + [...new Set(errors)].join("\n"));
console.log("captured to", out);
