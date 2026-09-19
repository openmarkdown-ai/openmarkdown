/**
 * A3 AI assist: suggestions (links, tags, properties, title, alt text),
 * plain-language queries, and periodic reviews.
 *
 * `app.ai` is a deterministic stub (canned answers keyed by the "Task: …"
 * line each prompt starts with), so nothing needs a model, a GPU or the
 * network; every test also fails if a request leaves localhost.
 *
 * Runs against the in-memory demo vault. Screenshots go to $A3_SHOTS (or the
 * test output folder).
 */
import { devices, expect, test, type Page } from "@playwright/test";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

async function shot(page: Page, name: string) {
  // Let modal and pane transitions finish.
  await page.waitForTimeout(400);
  const dir = process.env.A3_SHOTS;
  await page.screenshot({ path: dir ? `${dir}/${name}.png` : test.info().outputPath(`${name}.png`) });
}

/** Records (and blocks) every request that isn't to the dev server. */
async function guardNetwork(page: Page): Promise<string[]> {
  const offsite: string[] = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    offsite.push(url.href);
    return route.abort();
  });
  return offsite;
}

async function openDemo(page: Page, opts: { dark?: boolean } = {}) {
  await page.routeWebSocket(/.*/, () => {});
  if (opts.dark) await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady && (window as any).app?.metadataCache?.initialized, null, { timeout: 60_000 });
  if (opts.dark) await page.evaluate(() => (window as any).app.changeTheme?.("obsidian"));
  await page.waitForTimeout(300);
}

type Answers = Record<string, string[]>;

/**
 * Installs a stub engine through `app.ai`'s test hook (packages/app/src/ai/index.ts:
 * registerProvider + testing.routeAll + consent "grant"), or a whole stub service when
 * the platform isn't there. Answers are queues per task; the last answer repeats.
 */
async function installAi(page: Page, answers: Answers, opts: { vision?: boolean } = {}) {
  await page.evaluate(
    ({ answers, vision }) => {
      const w = window as any;
      w.__aiCalls = [];
      w.__aiAnswers = answers;
      async function generate(req: any) {
        const task = /^Task: ([\w-]+)/.exec(req.system ?? "")?.[1] ?? "";
        w.__aiCalls.push({ task, feature: req.feature, messages: req.messages.map((m: any) => ({ role: m.role, content: m.content, images: m.images?.length ?? 0 })) });
        const queue: string[] = w.__aiAnswers[task] ?? [""];
        return { text: queue.length > 1 ? queue.shift()! : queue[0]! };
      }
      const ai = w.app.ai;
      if (ai?.registerProvider && ai?.testing) {
        ai.registerProvider({ id: "stub", label: "Stub", location: "device", capabilities: vision ? ["generate", "vision"] : ["generate"], generate });
        ai.testing.routeAll("stub");
        ai.testing.consent = "grant";
        return;
      }
      const engine = { provider: "stub", model: "stub-1", location: "device", leavesDevice: false };
      w.app.ai = {
        isAvailable: (_f: string, cap?: string) => (cap === "vision" ? !!vision : cap !== "embed" && cap !== "transcribe"),
        engineFor: () => engine,
        ensureConsent: async () => true,
        generate: async (req: any) => ({ ...(await generate(req)), engine }),
        embed: async () => { throw new Error("no embeddings in tests"); },
        transcribe: async () => { throw new Error("no transcription in tests"); },
        on: (_name: string, cb: () => void) => cb,
        offref: () => {},
      };
    },
    { answers, vision: !!opts.vision },
  );
}

async function create(page: Page, files: Record<string, string>) {
  await page.evaluate(async (files) => {
    const app = (window as any).app;
    for (const [path, text] of Object.entries(files)) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
      await app.vault.create(path, text);
    }
  }, files);
  await page.waitForFunction((paths) => paths.every((p) => { const app = (window as any).app; const f = app.vault.getFileByPath(p); return f && !!app.metadataCache.getFileCache(f); }), Object.keys(files), { timeout: 10_000 });
  await page.waitForTimeout(300);
}

const read = (page: Page, path: string) => page.evaluate((p) => (window as any).app.vault.adapter.read(p), path);

async function openFile(page: Page, path: string) {
  await page.evaluate(async (p) => {
    const app = (window as any).app;
    await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(p), { active: true });
  }, path);
  await page.waitForFunction((p) => (window as any).app.workspace.getActiveFile()?.path === p, path, { timeout: 10_000 });
  await page.waitForTimeout(300);
}

async function enableCore(page: Page, ...ids: string[]) {
  await page.evaluate(async (ids) => {
    const app = (window as any).app;
    for (const id of ids) await app.internalPlugins.setEnabled(id, true);
  }, ids);
  await page.waitForFunction((ids) => ids.every((id) => (window as any).app.internalPlugins.getPluginById(id)?.enabled), ids, { timeout: 10_000 });
  await page.waitForTimeout(300);
}

async function command(page: Page, id: string) {
  const ok = await page.evaluate((id) => (window as any).app.commands.executeCommandById(id), id);
  expect(ok, `command ${id} ran`).toBeTruthy();
}

async function frontmatter(page: Page, path: string): Promise<Record<string, unknown>> {
  await page.waitForTimeout(400);
  return page.evaluate(async (p) => {
    const app = (window as any).app;
    const text: string = await app.vault.adapter.read(p);
    const m = /^---\n([\s\S]*?)\n?---\n?/.exec(text);
    return m ? (app.metadataCache.getFileCache(app.vault.getFileByPath(p))?.frontmatter ?? {}) : {};
  }, path);
}

// A 2×2 red PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwAAAHv8CBFK1oo8AAAAASUVORK5CYII=";

test.describe("AI assist", () => {
  test("off by default: no plugin enabled, no commands, nothing runs without app.ai", async ({ page }) => {
    const offsite = await guardNetwork(page);
    await openDemo(page);
    const state = await page.evaluate(() => {
      const app = (window as any).app;
      const ids = ["ai-suggest", "ai-query", "ai-review"];
      return {
        enabled: ids.map((id) => !!app.internalPlugins.getPluginById(id)?.enabled),
        registered: ids.map((id) => !!app.internalPlugins.getPluginById(id)),
        commands: ["ai-suggest:suggest", "ai-query:write-query", "ai-review:review-week"].map((id) => !!app.commands.findCommand(id)),
      };
    });
    expect(state.registered).toEqual([true, true, true]);
    expect(state.enabled).toEqual([false, false, false]);
    expect(state.commands).toEqual([false, false, false]);

    // Enabled, but AI itself is not on: the commands stay unavailable.
    await enableCore(page, "ai-suggest", "ai-query", "ai-review");
    expect(await page.evaluate(() => ["suggest", "query", "review"].map((f) => !!(window as any).app.ai?.isAvailable(f)))).toEqual([false, false, false]);
    const ran = await page.evaluate(() => ["ai-suggest:suggest", "ai-query:write-query", "ai-review:review-week"].map((id) => (window as any).app.commands.executeCommandById(id)));
    expect(ran).toEqual([false, false, false]);
    expect(offsite).toEqual([]);
  });

  test("suggestions: accept and dismiss write exactly what was accepted; rename keeps links; one undo step", async ({ page }) => {
    const offsite = await guardNetwork(page);
    await openDemo(page);
    await create(page, {
      "Books index.md": "---\ntags: [books]\n---\n# Books\n",
      "Untitled 2.md": "# Reading\n\nToday I read Thinking in Systems and sketched the Garden plan again.\n\n![[pic.png]]\n",
      "Linker.md": "See [[Untitled 2]] for my reading notes.\n",
    });
    await page.evaluate(async (b64) => {
      const app = (window as any).app;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await app.vault.createBinary("pic.png", bytes.buffer);
    }, PNG_BASE64);
    await installAi(
      page,
      {
        "suggest-note-metadata": [
          JSON.stringify({ tags: ["books", "not-a-vault-tag", "#Project"], newTags: ["systems-thinking", "second-new"], properties: { rating: 4, read: "true", author: "Donella Meadows", unknownprop: "x" }, title: "Systems: reading notes" }),
        ],
        "image-alt-text": ["A small red square"],
      },
      { vision: true },
    );
    await enableCore(page, "ai-suggest");
    await openFile(page, "Untitled 2.md");
    await command(page, "ai-suggest:suggest");

    const pane = page.locator(".ai-suggest-view");
    await expect(pane.locator(".ai-suggest-chip").first()).toBeVisible({ timeout: 15_000 });
    await expect(pane.locator(".ai-assist-engine")).toContainText("On this device");
    const chip = (kind: string, text: string) => pane.locator(`.ai-suggest-chip[data-kind="${kind}"]`, { hasText: text });

    // What was offered: vault tags only (plus one new tag), known properties only, a clean title.
    await expect(chip("link", "Thinking in Systems")).toBeVisible();
    await expect(chip("link", "Garden plan")).toBeVisible();
    await expect(chip("tag", "#books")).toBeVisible();
    await expect(chip("tag", "#project")).toBeVisible();
    await expect(chip("tag", "#systems-thinking")).toBeVisible();
    await expect(pane.locator('.ai-suggest-chip[data-kind="tag"]')).toHaveCount(3);
    await expect(chip("property", "rating: 4")).toBeVisible();
    await expect(chip("property", "read: true")).toBeVisible();
    await expect(pane.locator('.ai-suggest-chip[data-kind="property"]', { hasText: "unknownprop" })).toHaveCount(0);
    await expect(chip("title", "Systems reading notes")).toBeVisible();
    await expect(chip("alt", "A small red square")).toBeVisible();
    const altCall = await page.evaluate(() => (window as any).__aiCalls.find((c: any) => c.task === "image-alt-text"));
    expect(altCall.messages[0].images).toBe(1);
    await shot(page, "suggest-light");

    const before = await read(page, "Untitled 2.md");
    // Dismissals change nothing.
    await chip("link", "Thinking in Systems").locator(".ai-suggest-dismiss").click();
    await chip("tag", "#systems-thinking").locator(".ai-suggest-dismiss").click();
    await chip("tag", "#project").locator(".ai-suggest-dismiss").click();
    await chip("property", "read: true").locator(".ai-suggest-dismiss").click();
    await expect(chip("link", "Thinking in Systems")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await read(page, "Untitled 2.md")).toBe(before);

    // Link: only the first mention of the accepted note becomes a link.
    await chip("link", "Garden plan").locator(".ai-suggest-accept").click();
    await expect(chip("link", "Garden plan")).toHaveCount(0);
    await expect.poll(() => read(page, "Untitled 2.md")).toBe(before.replace("the Garden plan again", "the [[Garden plan]] again"));

    // Tag and property: frontmatter gets exactly those values; the body is untouched.
    await chip("tag", "#books").locator(".ai-suggest-accept").click();
    await expect.poll(async () => (await frontmatter(page, "Untitled 2.md")).tags).toEqual(["books"]);
    await chip("property", "rating: 4").locator(".ai-suggest-accept").click();
    await expect.poll(async () => await frontmatter(page, "Untitled 2.md")).toEqual({ tags: ["books"], rating: 4 });
    const afterProps = await read(page, "Untitled 2.md");
    expect(afterProps.slice(afterProps.indexOf("\n---\n") + 5)).toBe(before.replace("the Garden plan again", "the [[Garden plan]] again"));

    // One undo step takes back the property and nothing else.
    await page.locator(".workspace-leaf-content[data-type=\"markdown\"] .cm-content").first().click({ timeout: 10_000 });
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(async () => await frontmatter(page, "Untitled 2.md")).toEqual({ tags: ["books"] });
    await page.keyboard.press(`${MOD}+Shift+z`);
    await expect.poll(async () => await frontmatter(page, "Untitled 2.md")).toEqual({ tags: ["books"], rating: 4 });

    // Alt text on the image embed.
    await chip("alt", "A small red square").locator(".ai-suggest-accept").click();
    await expect.poll(() => read(page, "Untitled 2.md")).toContain("![[pic.png|A small red square]]");

    // Title: renamed through the file manager; links elsewhere follow.
    await chip("title", "Systems reading notes").locator(".ai-suggest-accept").click();
    await page.waitForFunction(() => !!(window as any).app.vault.getFileByPath("Systems reading notes.md"), null, { timeout: 10_000 });
    expect(await page.evaluate(() => !!(window as any).app.vault.getFileByPath("Untitled 2.md"))).toBe(false);
    await expect.poll(() => read(page, "Linker.md")).toBe("See [[Systems reading notes]] for my reading notes.\n");
    const final = await read(page, "Systems reading notes.md");
    expect(final).not.toContain("systems-thinking");
    expect(final).not.toContain("read:");
    expect(final).not.toContain("[[Thinking in Systems]]");
    expect(offsite).toEqual([]);
  });

  test("suggestions without a vision engine hide image descriptions", async ({ page }) => {
    await guardNetwork(page);
    await openDemo(page);
    await create(page, { "Pics.md": "Look: ![[pic.png]]\n" });
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await (window as any).app.vault.createBinary("pic.png", bytes.buffer);
    }, PNG_BASE64);
    await installAi(page, { "suggest-note-metadata": [JSON.stringify({ tags: [], newTags: [], properties: {}, title: null })] }, { vision: false });
    await enableCore(page, "ai-suggest");
    await openFile(page, "Pics.md");
    await command(page, "ai-suggest:suggest");
    await expect(page.locator(".ai-suggest-status")).toContainText(/No suggestions|Nothing changes/, { timeout: 15_000 });
    await expect(page.locator('.ai-suggest-chip[data-kind="alt"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__aiCalls.some((c: any) => c.task === "image-alt-text"))).toBe(false);
  });

  test("query: generated Bases view is validated (retried with the error), previewed live, and inserted as one block", async ({ page }) => {
    const offsite = await guardNetwork(page);
    await openDemo(page);
    const bad = "views:\n  - type: table\n    name: Unread\n    filters:\n      and:\n        - 'read == false'\n        - 'stars >= 4'\n";
    const good = "views:\n  - type: table\n    name: Unread, rated 4+\n    filters:\n      and:\n        - 'read == false'\n        - 'rating >= 4'\n    order:\n      - file.name\n      - rating\n";
    await installAi(page, { "query-base": [bad, "```yaml\n" + good + "```"] });
    await enableCore(page, "bases", "ai-query");
    await create(page, { "Queries.md": "# Queries\n\nIntro line.\n" });
    await openFile(page, "Queries.md");
    await page.evaluate(() => {
      const editor = (window as any).app.workspace.activeEditor.editor;
      editor.setCursor({ line: 3, ch: 0 });
    });
    await command(page, "ai-query:write-query");
    const modal = page.locator(".ai-query-modal");
    await expect(modal).toBeVisible();
    await modal.locator(".ai-query-description").fill("unread books rated 4+");
    await modal.locator(".ai-query-generate").click();

    const preview = modal.locator(".ai-query-preview");
    await expect(preview).toContainText("The Overstory", { timeout: 15_000 });
    await expect(preview).not.toContainText("Thinking in Systems");
    await expect(modal.locator(".ai-assist-engine")).toContainText("On this device");
    await expect(modal.locator(".ai-query-validation")).toBeEmpty();
    const calls = await page.evaluate(() => (window as any).__aiCalls);
    expect(calls).toHaveLength(2);
    expect(calls[0].messages[0].content).toContain("- rating (number)");
    expect(calls[1].messages.at(-1).content).toContain('"stars"');
    expect(await modal.locator(".ai-query-source").inputValue()).toBe(good.trimEnd());
    await shot(page, "query-light");

    // Editing the query updates the preview and the validation.
    await modal.locator(".ai-query-source").fill(good.replace("rating >= 4", "stars >= 4"));
    await expect(modal.locator(".ai-query-validation")).toContainText('"stars"');
    await modal.locator(".ai-query-source").fill(good);
    await expect(modal.locator(".ai-query-validation")).toBeEmpty();
    await expect(preview).toContainText("The Overstory");

    const before = await read(page, "Queries.md");
    expect(before).toBe("# Queries\n\nIntro line.\n");
    await modal.locator(".ai-query-insert").click();
    await expect(modal).toHaveCount(0);
    await expect.poll(() => read(page, "Queries.md")).toBe("# Queries\n\nIntro line.\n```base\n" + good + "```\n");
    // One undo step removes the whole block.
    await page.locator(".workspace-leaf-content[data-type=\"markdown\"] .cm-content").first().click({ timeout: 10_000 });
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(() => read(page, "Queries.md")).toBe(before);
    expect(offsite).toEqual([]);
  });

  test("query: a Tasks query fills the code block the cursor is in", async ({ page }) => {
    await guardNetwork(page);
    await openDemo(page);
    await installAi(page, { "query-tasks": ["not done\ndue before tomorrow\nsort by due"] });
    await enableCore(page, "ai-query");
    await create(page, { "Todo.md": "# Todo\n\n```tasks\noverdue work\n```\n" });
    await openFile(page, "Todo.md");
    await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.setCursor({ line: 3, ch: 2 }));
    await command(page, "ai-query:write-query");
    const modal = page.locator(".ai-query-modal");
    await expect(modal.locator(".ai-query-kind")).toHaveValue("tasks");
    await expect(modal.locator(".ai-query-description")).toHaveValue("overdue work");
    await expect(modal.locator(".ai-query-source")).toHaveValue("not done\ndue before tomorrow\nsort by due", { timeout: 15_000 });
    await expect(modal.locator(".ai-query-validation")).toBeEmpty();
    await expect(modal.locator(".ai-query-preview")).toContainText("Tasks plugin");
    await modal.locator(".ai-query-insert").click();
    await expect.poll(() => read(page, "Todo.md")).toBe("# Todo\n\n```tasks\nnot done\ndue before tomorrow\nsort by due\n```\n");
  });

  test("review: this week's daily notes become a linked review in the weekly note", async ({ page }) => {
    const offsite = await guardNetwork(page);
    await openDemo(page);
    const days = await page.evaluate(() => {
      const m = (window as any).moment;
      const start = m().startOf("week");
      return { d1: start.format("YYYY-MM-DD"), d2: start.clone().add(1, "day").format("YYYY-MM-DD"), old: start.clone().subtract(3, "day").format("YYYY-MM-DD"), week: start.format("gggg-[W]ww") };
    });
    await create(page, {
      [`Daily/${days.d1}.md`]: "Planted tomatoes in the new bed.\n\n- [x] Order seeds\n- [ ] Call the plumber\n",
      [`Daily/${days.d2}.md`]: "Decided to build raised beds instead of pots.\n",
      [`Daily/${days.old}.md`]: "Last week's note.\n\n- [ ] Old task that must not appear\n",
    });
    await installAi(page, {
      "periodic-review": [
        JSON.stringify({
          highlights: [
            { text: "Planted tomatoes", sources: [days.d1] },
            { text: "Something without a source", sources: ["1999-01-01"] },
          ],
          decisions: [{ text: "Raised beds instead of pots", sources: [`[[${days.d2}]]`] }],
          themes: [{ text: "Garden work", sources: [days.d1, days.d2] }],
        }),
      ],
    });
    await enableCore(page, "periodic-notes", "ai-review");
    await command(page, "ai-review:review-week");
    const modal = page.locator(".ai-review-modal");
    const source = modal.locator(".ai-review-source");
    await expect(source).not.toHaveValue("", { timeout: 15_000 });
    const review = await source.inputValue();
    expect(review).toContain("## Weekly review");
    expect(review).toContain(`- Planted tomatoes ([[${days.d1}]])`);
    expect(review).toContain(`- Raised beds instead of pots ([[${days.d2}]])`);
    expect(review).toContain(`- Garden work ([[${days.d1}]], [[${days.d2}]])`);
    expect(review).toContain(`- Call the plumber ([[${days.d1}]])`);
    expect(review).toContain(`- Order seeds ([[${days.d1}]])`);
    expect(review).not.toContain("without a source");
    expect(review).not.toContain("Old task");
    const prompt = await page.evaluate(() => (window as any).__aiCalls[0].messages[0].content as string);
    expect(prompt).not.toContain("Last week's note");
    await expect(modal.locator(".ai-review-preview")).toContainText("Planted tomatoes");
    await expect(modal.locator(".ai-assist-engine")).toContainText("On this device");
    await shot(page, "review-light");

    await modal.locator(".ai-review-insert").click();
    await expect(modal).toHaveCount(0);
    const weekly = `${days.week}.md`;
    await page.waitForFunction((p) => !!(window as any).app.vault.getFileByPath(p), weekly, { timeout: 10_000 });
    await expect.poll(() => read(page, weekly)).toBe(review);
    await page.waitForTimeout(600);
    const links = await page.evaluate((p) => {
      const app = (window as any).app;
      return { resolved: Object.keys(app.metadataCache.resolvedLinks[p] ?? {}), unresolved: Object.keys(app.metadataCache.unresolvedLinks[p] ?? {}) };
    }, weekly);
    expect(links.resolved.sort()).toEqual([`Daily/${days.d1}.md`, `Daily/${days.d2}.md`]);
    expect(links.unresolved).toEqual([]);
    expect(offsite).toEqual([]);
  });
});

const { defaultBrowserType: _browser, ...IPHONE } = devices["iPhone 13"];
const PHONE = { ...IPHONE, viewport: { width: 390, height: 844 } };

async function screenshotTour(page: Page, name: string, dark: boolean, phone: boolean) {
  await guardNetwork(page);
  await openDemo(page, { dark });
  await create(page, { "Untitled 3.md": "# Reading\n\nNotes on Thinking in Systems for the Garden plan.\n" });
  const d1 = await page.evaluate(() => (window as any).moment().startOf("week").format("YYYY-MM-DD"));
  await create(page, { [`Daily/${d1}.md`]: "Planted tomatoes.\n\n- [ ] Call the plumber\n" });
  await installAi(page, {
    "suggest-note-metadata": [JSON.stringify({ tags: ["project"], newTags: ["reading"], properties: { rating: 4 }, title: "Thinking in Systems notes" })],
    "query-base": ["views:\n  - type: table\n    name: Unread, rated 4+\n    filters:\n      and:\n        - 'read == false'\n        - 'rating >= 4'\n    order:\n      - file.name\n      - rating\n"],
    "periodic-review": [JSON.stringify({ highlights: [{ text: "Planted tomatoes", sources: [d1] }], decisions: [], themes: [] })],
  });
  await enableCore(page, "ai-suggest", "ai-query", "periodic-notes", "ai-review");
  await openFile(page, "Untitled 3.md");
  await command(page, "ai-suggest:suggest");
  await expect(page.locator(".ai-suggest-chip").first()).toBeVisible({ timeout: 15_000 });
  await shot(page, `suggest-${name}`);
  if (phone) await page.evaluate(() => (window as any).app.workspace.rightSplit?.collapse?.());

  await command(page, "ai-query:write-query");
  const q = page.locator(".ai-query-modal");
  await q.locator(".ai-query-description").fill("unread books rated 4+");
  await q.locator(".ai-query-generate").click();
  await expect(q.locator(".ai-query-preview")).toContainText("The Overstory", { timeout: 15_000 });
  await expect(q.locator(".ai-query-insert")).toBeVisible();
  await shot(page, `query-${name}`);
  await q.locator(".modal-button-container button", { hasText: "Cancel" }).click();
  await expect(q).toHaveCount(0);

  await command(page, "ai-review:review-week");
  const r = page.locator(".ai-review-modal");
  await expect(r.locator(".ai-review-preview")).toContainText("Planted tomatoes", { timeout: 15_000 });
  await shot(page, `review-${name}`);
}

test.describe("AI assist screenshots", () => {
  test("desktop dark", async ({ page }) => {
    await screenshotTour(page, "dark", true, false);
  });
});

test.describe("AI assist screenshots on a phone", () => {
  test.use(PHONE);
  test("phone light", async ({ page }) => {
    await screenshotTour(page, "phone", false, true);
  });
  test("phone dark", async ({ page }) => {
    await screenshotTour(page, "phone-dark", true, true);
  });
});
