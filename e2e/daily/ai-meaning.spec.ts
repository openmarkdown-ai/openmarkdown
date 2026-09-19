/**
 * A2 Meaning: the semantic index, Related notes, search by meaning and Chat
 * with vault (docs/PLAN-ai.md).
 *
 * `app.ai` is a deterministic stub (fixtures/ai/stub-ai.js): hashed
 * bag-of-words embeddings and a generator that quotes its first passage, so no
 * model, GPU or network is needed. Screenshots go to $A2_SHOTS (or the test
 * output folder).
 */
import { devices, expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const STUB = fileURLToPath(new URL("./fixtures/ai/stub-ai.js", import.meta.url));

const NOTES: Record<string, string> = {
  "Meaning/Sourdough baking.md":
    "# Sourdough baking\n\nFeed the sourdough starter with flour and water every day. The starter ferments and makes the bread rise.\n\n## Oven\n\nBake the loaf in a hot oven with steam so the bread crust gets crisp.\n",
  "Meaning/Bread recipes.md":
    "# Bread recipes\n\nA simple bread needs flour, water, salt and yeast or a sourdough starter. Knead the dough, let it ferment, shape the loaf.\n\n## Baking\n\nBake the bread loaf in the oven until the crust is brown.\n",
  "Meaning/Marathon training.md":
    "# Marathon training\n\nRun easy miles most days and one long run each week. Keep the pace slow so running stays aerobic before the marathon.\n\n## Race day\n\nStart the marathon at goal pace and drink water at every station.\n",
  "Meaning/Running shoes.md":
    "# Running shoes\n\nGood running shoes have cushioning for long miles. Replace shoes after 500 miles of running; marathon runners wear through them faster.\n",
  "Meaning/Tax return.md":
    "# Tax return\n\nCollect receipts for deductions and send the tax forms to the accountant before the deadline.\n",
  "Archive/Old bread notes.md": "# Old bread notes\n\nSourdough starter flour bread loaf oven ferment knead dough.\n",
};

async function shot(page: Page, name: string) {
  const dir = process.env.A2_SHOTS;
  await page.screenshot({ path: dir ? `${dir}/${name}.png` : test.info().outputPath(`${name}.png`) });
}

/** Loads the in-memory demo vault with the AI stub script available (not yet installed). */
async function openDemo(page: Page, opts: { dark?: boolean; offline?: string[] } = {}) {
  await page.routeWebSocket(/.*/, () => {});
  if (opts.offline) {
    page.on("request", (req) => {
      const url = req.url();
      if (!/^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/|data:|blob:|about:)/.test(url)) opts.offline!.push(url);
    });
  }
  await page.addInitScript({ path: STUB });
  if (opts.dark) await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized, null, { timeout: 60_000 });
  if (opts.dark) await page.evaluate(() => (window as any).app.changeTheme?.("obsidian"));
  await page.waitForTimeout(300);
}

async function installStub(page: Page, config: Record<string, unknown> = {}) {
  await page.evaluate((config) => (window as any).__installAiStub((window as any).app, config), config);
}

async function seed(page: Page, files: Record<string, string> = NOTES) {
  await page.evaluate(async (files) => {
    const app = (window as any).app;
    for (const [path, text] of Object.entries(files)) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
      await app.vault.create(path, text);
    }
  }, files);
  await page.waitForFunction((paths) => paths.every((p) => { const app = (window as any).app; const f = app.vault.getFileByPath(p); return f && app.metadataCache.getFileCache(f); }), Object.keys(files), { timeout: 10_000 });
}

async function enable(page: Page, id: string) {
  await page.evaluate((id) => (window as any).app.internalPlugins.setEnabled(id, true), id);
  await page.waitForFunction((id) => !!(window as any).app.internalPlugins.getEnabledPluginById(id), id, { timeout: 10_000 });
}

const status = (page: Page) => page.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("semantic")?.getStatus());

async function waitReady(page: Page) {
  await page.waitForFunction(
    () => {
      const inst = (window as any).app.internalPlugins.getEnabledPluginById("semantic");
      const s = inst?.getStatus();
      return s && s.state === "ready" && s.notes > 0;
    },
    null,
    { timeout: 30_000 },
  );
}

async function openFile(page: Page, path: string) {
  await page.evaluate(async (p) => {
    const app = (window as any).app;
    await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(p), { active: true });
  }, path);
  await page.waitForFunction((p) => (window as any).app.workspace.getActiveFile()?.path === p, path, { timeout: 10_000 });
}

async function command(page: Page, id: string) {
  const ok = await page.evaluate((id) => (window as any).app.commands.executeCommandById(id), id);
  expect(ok, `command ${id} ran`).toBeTruthy();
}

test.describe("off by default", () => {
  test("both plugins are off, nothing is embedded, and without AI the views explain what to turn on", async ({ page }) => {
    const external: string[] = [];
    await openDemo(page, { offline: external });
    await installStub(page, { available: false });
    const state = await page.evaluate(() => {
      const ip = (window as any).app.internalPlugins;
      return { semantic: !!ip.getEnabledPluginById("semantic"), chat: !!ip.getEnabledPluginById("vault-chat"), commands: Object.keys((window as any).app.commands.commands).filter((c) => c.startsWith("semantic:") || c.startsWith("vault-chat:")) };
    });
    expect(state).toEqual({ semantic: false, chat: false, commands: [] });

    await enable(page, "semantic");
    await enable(page, "vault-chat");
    await page.waitForTimeout(800);
    expect((await status(page)).state).toBe("unavailable");
    await command(page, "semantic:open-related");
    await expect(page.locator(".semantic-related-view .semantic-empty")).toContainText("Turn on AI");
    await command(page, "vault-chat:open");
    await expect(page.locator(".vault-chat-notice")).toContainText("needs AI");
    await expect(page.locator(".vault-chat-input")).toBeDisabled();
    expect(await page.evaluate(() => (window as any).__aiStub.embedCalls)).toBe(0);
    await expect(page.locator(".semantic-status-bar")).toBeHidden();

    // Turning AI on starts indexing without a reload.
    await page.evaluate(() => (window as any).__aiStub.setAvailable(true));
    await waitReady(page);
    expect(external).toEqual([]);
  });
});

test.describe("semantic index", () => {
  test("shows progress, can pause, updates incrementally, excludes folders, and resumes from IndexedDB", async ({ page }) => {
    const external: string[] = [];
    await openDemo(page, { offline: external });
    await seed(page);
    await installStub(page, { embedDelay: 250 });
    await enable(page, "semantic");
    await page.evaluate(() => {
      const inst = (window as any).app.internalPlugins.getEnabledPluginById("semantic");
      inst.options.excludeFolders = ["Archive"];
      inst.index.reconcile();
    });

    const bar = page.locator(".status-bar-item.semantic-status-bar");
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar).toHaveText(/Indexing \d+\/\d+/);

    // Pause: progress stops; resume: it finishes.
    await bar.click();
    await expect(bar).toHaveText("Indexing paused");
    const paused = await status(page);
    await page.waitForTimeout(800);
    expect((await status(page)).notes).toBe(paused.notes);
    await bar.click();
    await waitReady(page);
    await expect(bar).toBeHidden();

    const md = await page.evaluate(() => (window as any).app.vault.getMarkdownFiles().filter((f: any) => !f.path.startsWith("Archive/")).length);
    const s = await status(page);
    expect(s.notes).toBe(md);
    expect(s.model).toMatch(/(^|:)stub-bow-256$/);
    const indexed = await page.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("semantic").index.isIndexed("Archive/Old bread notes.md"));
    expect(indexed).toBe(false);

    // Edit one paragraph: only the changed passage is embedded again.
    await page.evaluate(() => ((window as any).__aiStub.embeddedTexts = 0));
    await page.evaluate(async () => {
      const app = (window as any).app;
      const f = app.vault.getFileByPath("Meaning/Tax return.md");
      await app.vault.process(f, (t: string) => t + "\n## Refund\n\nThe refund arrives by bank transfer after the tax office checks the return, usually within a few weeks of filing the forms.\n");
    });
    await page.waitForFunction(() => (window as any).__aiStub.embeddedTexts > 0, null, { timeout: 15_000 });
    await waitReady(page);
    expect(await page.evaluate(() => (window as any).__aiStub.embeddedTexts)).toBeLessThanOrEqual(2);

    // Create, rename (no re-embedding), delete.
    await page.evaluate(() => (window as any).app.vault.create("Meaning/Cycling.md", "# Cycling\n\nRide the bike on hills to build leg strength for long cycling tours and races.\n"));
    await page.waitForFunction(() => (window as any).app.internalPlugins.getEnabledPluginById("semantic").index.isIndexed("Meaning/Cycling.md"), null, { timeout: 15_000 });
    const before = await page.evaluate(() => (window as any).__aiStub.embeddedTexts);
    await page.evaluate(async () => {
      const app = (window as any).app;
      await app.fileManager.renameFile(app.vault.getFileByPath("Meaning/Cycling.md"), "Meaning/Bike rides.md");
    });
    await page.waitForFunction(() => (window as any).app.internalPlugins.getEnabledPluginById("semantic").index.isIndexed("Meaning/Bike rides.md"), null, { timeout: 10_000 });
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => (window as any).__aiStub.embeddedTexts)).toBe(before);
    const hits = await page.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("semantic").search("bike hills cycling", { k: 3 }));
    expect(hits[0].path).toBe("Meaning/Bike rides.md");
    await page.evaluate(async () => {
      const app = (window as any).app;
      await app.vault.delete(app.vault.getFileByPath("Meaning/Bike rides.md"));
    });
    await page.waitForFunction(() => !(window as any).app.internalPlugins.getEnabledPluginById("semantic").index.isIndexed("Meaning/Bike rides.md"), null, { timeout: 10_000 });
    const after = await page.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("semantic").search("bike hills cycling", { k: 5 }));
    expect(after.map((h: any) => h.path)).not.toContain("Meaning/Bike rides.md");

    expect(external).toEqual([]);
  });

  test("a reload resumes from the stored index without embedding unchanged notes again; a new model rebuilds", async ({ page }) => {
    await openDemo(page);
    await installStub(page);
    await enable(page, "semantic");
    await waitReady(page);
    const first = await status(page);
    expect(first.notes).toBeGreaterThan(0);

    await page.reload();
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized, null, { timeout: 60_000 });
    await installStub(page);
    await enable(page, "semantic");
    await waitReady(page);
    expect(await page.evaluate(() => (window as any).__aiStub.embeddedTexts)).toBe(0);
    expect((await status(page)).passages).toBe(first.passages);

    // A different embedding model: vectors are not comparable, so everything is embedded again.
    await page.evaluate(() => {
      const stub = (window as any).__aiStub;
      stub.cfg.model = "stub-bow-256-v2";
      stub.setAvailable(true);
    });
    await page.waitForFunction(() => (window as any).app.internalPlugins.getEnabledPluginById("semantic").getStatus().model?.endsWith("stub-bow-256-v2"), null, { timeout: 10_000 });
    await waitReady(page);
    expect(await page.evaluate(() => (window as any).__aiStub.embeddedTexts)).toBeGreaterThanOrEqual(first.passages);
  });

  test("steps aside while Smart Connections is enabled", async ({ page }) => {
    await openDemo(page);
    await installStub(page);
    await enable(page, "semantic");
    await waitReady(page);
    await page.evaluate(() => (window as any).app.plugins.enabledPlugins.add("smart-connections"));
    await page.waitForFunction(() => (window as any).app.internalPlugins.getEnabledPluginById("semantic").getStatus().state === "unavailable", null, { timeout: 10_000 });
    await command(page, "semantic:open-related");
    await expect(page.locator(".semantic-related-view .semantic-empty")).toContainText("Smart Connections");
  });
});

test.describe("related notes", () => {
  test("lists the most similar notes and passages with scores; insert link and drag carry a link", async ({ page }) => {
    const external: string[] = [];
    await openDemo(page, { offline: external });
    await seed(page);
    await installStub(page);
    await enable(page, "semantic");
    await waitReady(page);
    await openFile(page, "Meaning/Sourdough baking.md");
    await command(page, "semantic:open-related");
    const view = page.locator(".semantic-related-view");
    const titles = view.locator(".semantic-result .search-result-file-title .tree-item-inner");
    await expect(titles.first()).toHaveText("Bread recipes", { timeout: 10_000 });
    await expect(view.locator(".semantic-result").first().locator(".semantic-score")).toHaveText(/^0\.\d\d$/);
    await expect(view.locator(".semantic-result").first().locator(".semantic-passage").first()).toContainText(/flour|oven|loaf/i);
    const order = await titles.allTextContents();
    expect(order.indexOf("Bread recipes")).toBeLessThan(order.indexOf("Tax return") === -1 ? Infinity : order.indexOf("Tax return"));
    expect(order).not.toContain("Sourdough baking");
    await expect(view.locator(".semantic-subject")).toContainText("Sourdough baking");
    await shot(page, "related-notes-desktop-light");

    // Insert link at the cursor in the note.
    await page.evaluate(() => {
      const editor = (window as any).app.workspace.activeEditor?.editor ?? (window as any).app.workspace.getLeavesOfType("markdown")[0].view.editor;
      editor.setCursor({ line: editor.lastLine(), ch: 0 });
    });
    await view.locator(".semantic-result").first().locator(".search-result-file-title").hover();
    await view.locator(".semantic-result").first().locator(".semantic-insert-link").click();
    const text = await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("markdown")[0].view.editor.getValue());
    expect(text).toContain("[[Bread recipes]]");

    // Dragging a passage carries a link to its heading.
    const dragged = await page.evaluate(() => {
      const row = document.querySelector(".semantic-related-view .semantic-passage[draggable='true']") as HTMLElement;
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      const out = dt.getData("text/plain");
      window.dispatchEvent(new DragEvent("dragend"));
      return out;
    });
    expect(dragged).toMatch(/^\[\[(Bread recipes|Sourdough baking)(#[^\]]+)?\]\]$/);

    // Paragraph mode: related to the paragraph under the cursor.
    await openFile(page, "Meaning/Tax return.md");
    await page.evaluate(async () => {
      const app = (window as any).app;
      const view = app.workspace.getLeavesOfType("markdown")[0].view;
      view.editor.setValue("# Mixed\n\nReceipts for the accountant.\n\nMy marathon pace and running miles for the long run this week.\n");
      view.editor.setCursor({ line: 4, ch: 5 });
    });
    await view.locator(".nav-action-button").first().click();
    await expect(view.locator(".semantic-subject")).toContainText("paragraph", { timeout: 10_000 });
    await expect(titles.first()).toHaveText(/Marathon training|Running shoes/, { timeout: 10_000 });
    expect(external).toEqual([]);
  });
});

test.describe("search by meaning", () => {
  test("keyword search stays the default; the toggle adds ranked results by meaning, clearly labelled", async ({ page }) => {
    await openDemo(page);
    await seed(page);
    await installStub(page);
    await enable(page, "semantic");
    await waitReady(page);
    await page.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("global-search").openGlobalSearch("running shoes"));
    const search = page.locator(".workspace-leaf-content[data-type='search']");
    const toggle = search.locator(".semantic-search-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toHaveClass(/is-active/);
    await expect(search.locator(".semantic-search-section")).toBeHidden();
    await expect(search.locator(".search-result-file-title").first()).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveClass(/is-active/);
    const section = search.locator(".semantic-search-section");
    await expect(section).toBeVisible();
    await expect(section.locator(".semantic-search-header")).toContainText("By meaning");
    await expect(search.locator(".semantic-keyword-label")).toBeVisible();
    const first = section.locator(".semantic-result .search-result-file-title .tree-item-inner").first();
    await expect(first).toHaveText(/Running shoes|Marathon training/, { timeout: 10_000 });
    await expect(section.locator(".semantic-search-engine")).toContainText("On this device");

    // A query with no shared keyword still finds notes by meaning; operators are ignored.
    await page.evaluate(() => (window as any).app.internalPlugins.getEnabledPluginById("global-search").openGlobalSearch("path:Meaning loaf oven crust"));
    await expect(first).toHaveText(/Bread recipes|Sourdough baking/, { timeout: 10_000 });
    await shot(page, "search-by-meaning-desktop-light");

    await toggle.click();
    await expect(section).toBeHidden();
    await expect(search.locator(".semantic-keyword-label")).toBeHidden();
  });
});

test.describe("chat with vault", () => {
  async function setupChat(page: Page, stub: Record<string, unknown> = {}, opts: { dark?: boolean; offline?: string[] } = {}) {
    await openDemo(page, opts);
    await seed(page);
    await installStub(page, stub);
    await enable(page, "semantic");
    await enable(page, "vault-chat");
    await waitReady(page);
  }

  test("answers with streamed text, citations that open real notes, sources and the engine", async ({ page }) => {
    const external: string[] = [];
    await setupChat(page, { generateDelay: 30 }, { offline: external });
    await openFile(page, "Meaning/Tax return.md");
    await command(page, "vault-chat:open");
    const chat = page.locator(".vault-chat-view");
    await expect(chat.locator(".vault-chat-input")).toBeEnabled();
    await chat.locator(".vault-chat-input").fill("How do I feed the sourdough starter?");
    await chat.locator(".vault-chat-input").press("Enter");
    await expect(chat.locator(".vault-chat-message.mod-assistant.is-streaming")).toBeVisible();
    const answer = chat.locator(".vault-chat-message.mod-assistant").last();
    await expect(answer).not.toHaveClass(/is-streaming/, { timeout: 15_000 });
    await expect(answer.locator(".vault-chat-answer")).toContainText("From your notes");

    // Every rendered citation resolves to a real note; the invented one is plain text.
    const links = await answer.locator("a.internal-link").evaluateAll((els) => els.map((e) => e.getAttribute("data-href")));
    expect(links.length).toBeGreaterThan(0);
    const resolved = await page.evaluate((links) => links.map((l) => !!(window as any).app.metadataCache.getFirstLinkpathDest(String(l).split("#")[0], "")), links);
    expect(resolved.every(Boolean)).toBe(true);
    expect(links.some((l) => String(l).startsWith("Sourdough baking"))).toBe(true);
    await expect(answer).toContainText("Invented note that does not exist");
    expect(links.join(" ")).not.toContain("Invented");
    await expect(answer.locator(".vault-chat-engine")).toHaveText("Answered on this device · stub-writer");
    await expect(answer.locator(".vault-chat-sources summary")).toContainText("source");

    // Small context window: at most 4 passages, and the prompt stays within budget.
    const req = await page.evaluate(() => (window as any).__aiStub.lastRequest);
    const passages = (req.messages[req.messages.length - 1].content.match(/Passage \d+ — link/g) ?? []).length;
    expect(passages).toBeGreaterThan(0);
    expect(passages).toBeLessThanOrEqual(4);
    expect(req.messages[req.messages.length - 1].content.length).toBeLessThan(4096 * 3);

    await shot(page, "vault-chat-desktop-light");

    // A citation opens its note.
    await answer.locator("a.internal-link").first().click();
    await page.waitForFunction(() => (window as any).app.workspace.getActiveFile()?.path === "Meaning/Sourdough baking.md", null, { timeout: 10_000 });
    expect(external).toEqual([]);
  });

  test("pinned folders limit the context; insert into note previews first; the conversation saves as a note", async ({ page }) => {
    await setupChat(page);
    await seed(page, { "Other/Bread elsewhere.md": "# Bread elsewhere\n\nSourdough starter flour water bread feed daily.\n" });
    await page.waitForFunction(() => (window as any).app.internalPlugins.getEnabledPluginById("semantic").index.isIndexed("Other/Bread elsewhere.md"), null, { timeout: 15_000 });
    await openFile(page, "Meaning/Tax return.md");
    await command(page, "vault-chat:open");
    const chat = page.locator(".vault-chat-view");
    await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("vault-chat")[0].view.pin("Other"));
    await expect(chat.locator(".vault-chat-pin")).toContainText("Other");
    await chat.locator(".vault-chat-input").fill("How do I feed the sourdough starter?");
    await chat.locator(".vault-chat-send").click();
    const answer = chat.locator(".vault-chat-message.mod-assistant").last();
    await expect(answer).not.toHaveClass(/is-streaming/, { timeout: 15_000 });
    const sources = await answer.locator(".vault-chat-source").evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((p) => String(p).startsWith("Other/"))).toBe(true);

    // Insert into note: a preview first, then one edit.
    await page.evaluate(() => {
      const editor = (window as any).app.workspace.getLeavesOfType("markdown")[0].view.editor;
      editor.setCursor({ line: editor.lastLine(), ch: 0 });
    });
    await answer.locator(".vault-chat-actions [aria-label='Insert into note']").click();
    const modal = page.locator(".modal.vault-chat-insert-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator(".vault-chat-insert-preview")).toContainText("From your notes");
    const unchanged = await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("markdown")[0].view.editor.getValue());
    expect(unchanged).not.toContain("From your notes");
    await modal.getByRole("button", { name: "Insert" }).click();
    const inserted = await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("markdown")[0].view.editor.getValue());
    expect(inserted).toContain("From your notes");
    expect(inserted).toContain("[[Bread elsewhere");

    // Save the conversation.
    await chat.locator(".vault-chat-pin-remove").click();
    const path = await page.evaluate(async () => (await (window as any).app.workspace.getLeavesOfType("vault-chat")[0].view.saveConversation())?.path);
    expect(path).toMatch(/^AI chats\/Chat \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.md$/);
    const saved = await page.evaluate((p) => (window as any).app.vault.adapter.read(p), path);
    expect(saved).toContain("> [!question] You");
    expect(saved).toContain("How do I feed the sourdough starter?");
    expect(saved).toContain("Sources: [[Bread elsewhere");
    expect(saved).toContain("Answered on this device");
  });
});

test.describe("screenshots", () => {
  for (const dark of [false, true]) {
    test(`related notes and chat, desktop ${dark ? "dark" : "light"}`, async ({ page }) => {
      await openDemo(page, { dark });
      await seed(page);
      await installStub(page);
      await enable(page, "semantic");
      await enable(page, "vault-chat");
      await waitReady(page);
      await openFile(page, "Meaning/Sourdough baking.md");
      await command(page, "semantic:open-related");
      await expect(page.locator(".semantic-result").first()).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".semantic-subject")).toContainText("Sourdough baking");
      await shot(page, `related-desktop-${dark ? "dark" : "light"}`);
      await command(page, "vault-chat:open");
      await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("vault-chat")[0].view.pin("Meaning"));
      await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("vault-chat")[0].view.ask("What do my notes say about baking bread in the oven?"));
      await expect(page.locator(".vault-chat-engine").first()).toBeVisible({ timeout: 10_000 });
      await shot(page, `chat-desktop-${dark ? "dark" : "light"}`);
    });
  }
});

test.describe("screenshots on a phone", () => {
  const { defaultBrowserType: _ignored, ...phone } = devices["iPhone 13"];
  test.use({ ...phone, viewport: { width: 390, height: 844 } });
  for (const dark of [false, true]) {
    test(`related notes and chat, phone ${dark ? "dark" : "light"}`, async ({ page }) => {
      await openDemo(page, { dark });
      await seed(page);
      await installStub(page);
      await enable(page, "semantic");
      await enable(page, "vault-chat");
      await waitReady(page);
      await openFile(page, "Meaning/Sourdough baking.md");
      await command(page, "semantic:open-related");
      await expect(page.locator(".semantic-result").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot(page, `related-phone-${dark ? "dark" : "light"}`);
      await command(page, "vault-chat:open");
      await page.evaluate(() => (window as any).app.workspace.getLeavesOfType("vault-chat")[0].view.ask("What do my notes say about baking bread in the oven?"));
      await expect(page.locator(".vault-chat-engine").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot(page, `chat-phone-${dark ? "dark" : "light"}`);
    });
  }
});
