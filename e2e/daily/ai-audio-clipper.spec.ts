/**
 * A4 Audio & clipper — Transcribe (transcript notes with timestamp links that
 * seek, progress with cancel, chunking and cache, transcript below an embed,
 * summary with preview, AI off) and the web clipper's prompt variables filled
 * by the app's AI when a clip arrives (and left as placeholders when AI is off).
 *
 *   OM_URL=http://localhost:5223 npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/ai-audio-clipper.spec.ts
 *
 * `app.ai` is a stub (docs/PLAN-ai.md "The contract"): canned segments and
 * generations, set once `app` exists. No network: every non-local request is
 * aborted. Recordings are real WAV files generated here, so decoding, chunking
 * at a pause and seeking run for real.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "openmarkdown-a4-shots");

// ---- fixtures -----------------------------------------------------------------------------

/** 16 kHz mono WAV: tone, a 4 s pause at 10–14 s, tone again. */
function wavBase64(seconds: number): string {
  const rate = 16_000;
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const quiet = t >= 10 && t < 14;
    buf.writeInt16LE(quiet ? 0 : Math.round(Math.sin(2 * Math.PI * 220 * t) * 8000), 44 + i * 2);
  }
  return buf.toString("base64");
}

/** The stub AI service. `window.__ai` controls it from tests. */
function installAiStub() {
  const w = window as any;
  w.__ai = { enabled: true, transcribeCalls: [] as any[], generateCalls: [] as any[], delayMs: 0, clipperAnswer: null as string | null, summary: "" };
  const engine = { provider: "transformers", model: "whisper-base", location: "device", leavesDevice: false };
  const textEngine = { provider: "ollama", model: "llama3.2", location: "local-server", leavesDevice: false };
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))), { once: true });
    });
  const unavailable = () => Object.assign(new Error("AI is off."), { name: "AiUnavailableError", reason: "disabled" });
  const service = {
    isAvailable: () => w.__ai.enabled,
    engineFor: (_f: string, cap?: string) => (w.__ai.enabled ? (cap === "transcribe" ? engine : textEngine) : null),
    ensureConsent: async () => w.__ai.enabled,
    async generate(req: any) {
      if (!w.__ai.enabled) throw unavailable();
      w.__ai.generateCalls.push({ feature: req.feature, system: req.system, messages: req.messages.map((m: any) => m.content), json: req.json });
      await sleep(w.__ai.delayMs, req.signal);
      if (req.feature === "clipper") return { text: w.__ai.clipperAnswer, engine: textEngine };
      return { text: w.__ai.summary, engine: textEngine };
    },
    async embed() {
      throw unavailable();
    },
    async transcribe(req: any) {
      if (!w.__ai.enabled) throw unavailable();
      const duration = (req.audio.size - 44) / 32_000;
      w.__ai.transcribeCalls.push({ size: req.audio.size, type: req.audio.type, language: req.language, duration });
      for (let i = 1; i <= 4; i++) {
        await sleep(w.__ai.delayMs / 4, req.signal);
        req.onProgress?.(i, 4);
      }
      const segments = [
        { start: 0, end: 2, text: " Hello there." },
        { start: 2.2, end: 4, text: " This continues the thought." },
        { start: 7, end: 9, text: " After a pause, a new paragraph." },
      ].filter((s) => s.start < duration);
      return { text: segments.map((s) => s.text).join(""), segments, language: "en", engine };
    },
    on: () => ({}),
    offref: () => {},
  };
  const timer = setInterval(() => {
    if (!w.app) return;
    w.app.ai = service;
    clearInterval(timer);
  }, 5);
}

async function open(page: Page) {
  await page.routeWebSocket(/.*/, () => {});
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort("blockedbyclient"));
  await page.addInitScript(installAiStub);
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true && !!(window as any).app?.ai, null, { timeout: 60_000 });
}

async function enableTranscribe(page: Page, options: Record<string, unknown> = {}) {
  await page.evaluate(async (options) => {
    const a = (window as any).app;
    await a.internalPlugins.setEnabled("transcribe", true);
    Object.assign(a.internalPlugins.getPluginById("transcribe").instance.options, { chunkMinutes: 0.25 }, options);
  }, options);
}

async function addRecording(page: Page, path: string, seconds = 30) {
  await page.evaluate(
    async ({ path, b64 }) => {
      const a = (window as any).app;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !a.vault.getAbstractFileByPath(dir)) await a.vault.createFolder(dir);
      await a.vault.createBinary(path, bytes.buffer);
    },
    { path, b64: wavBase64(seconds) },
  );
}

async function transcribeFile(page: Page, path: string) {
  await page.evaluate(async (path) => {
    const a = (window as any).app;
    await a.workspace.getLeaf("tab").openFile(a.vault.getFileByPath(path), { active: true });
    a.commands.executeCommandById("transcribe:transcribe-recording");
  }, path);
}

const read = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const a = (window as any).app;
    const f = a.vault.getFileByPath(path);
    return f ? ((await a.vault.read(f)) as string) : null;
  }, path);

async function setDark(page: Page, dark: boolean) {
  await page.evaluate((dark) => {
    document.body.toggleClass("theme-dark", dark);
    document.body.toggleClass("theme-light", !dark);
  }, dark);
}

async function shots(page: Page, name: string, target?: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const dark of [false, true]) {
    await setDark(page, dark);
    await page.waitForTimeout(250);
    const path = join(SHOTS, `${name}-${dark ? "dark" : "light"}.png`);
    if (target) await page.locator(target).first().screenshot({ path });
    else await page.screenshot({ path });
  }
  await setDark(page, false);
}

// ---- transcribe ------------------------------------------------------------------------------

test("a recording becomes a transcript note: paragraphs, Media-format timestamp links, chunks cut at the pause", async ({ page }) => {
  await open(page);
  await enableTranscribe(page);
  await addRecording(page, "Recordings/Meeting.wav");
  await transcribeFile(page, "Recordings/Meeting.wav");

  await expect.poll(() => read(page, "Recordings/Meeting (transcript).md"), { timeout: 20_000 }).not.toBeNull();
  const text = (await read(page, "Recordings/Meeting (transcript).md"))!;
  const calls = await page.evaluate(() => (window as any).__ai.transcribeCalls);
  // 30 s in parts of ~15 s, cut inside the 10–14 s pause; each part sent as 16 kHz WAV with no language hint.
  expect(calls).toHaveLength(2);
  expect(calls[0].type).toBe("audio/wav");
  expect(calls[0].language).toBeUndefined();
  expect(calls[0].duration).toBeGreaterThanOrEqual(10);
  expect(calls[0].duration).toBeLessThanOrEqual(14);
  const cut = calls[0].duration as number;

  expect(text).toMatch(/^---\nrecording: "\[\[Meeting\.wav\]\]"\nlanguage: "en"\ntranscribed-with: "On this device · whisper-base"\n---\n!\[\[Meeting\.wav\]\]\n\n## Transcript\n\n/);
  const paragraphs = text.split("## Transcript\n\n")[1]!.trim().split("\n\n");
  expect(paragraphs).toHaveLength(4);
  expect(paragraphs[0]).toBe("[[Meeting.wav#t=0|00:00]] Hello there. This continues the thought.");
  expect(paragraphs[1]).toBe("[[Meeting.wav#t=7.00|00:07]] After a pause, a new paragraph.");
  // The second part's times are offset by where the first part ended.
  const m = /^\[\[Meeting\.wav#t=(\d+\.\d\d)\|00:(\d\d)\]\] Hello there\. This continues the thought\.$/.exec(paragraphs[2]!);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBeCloseTo(cut, 1);
  expect(Number(m![2])).toBe(Math.floor(cut));
  expect(paragraphs[3]).toMatch(/^\[\[Meeting\.wav#t=(19|20|21)\.\d\d\|00:(19|20|21)\]\] After a pause, a new paragraph\.$/);

  await shots(page, "transcript-note");

  // Reading view: a timestamp link seeks the recording's embed in the note (Media plugin off).
  await page.evaluate(async () => {
    const leaf = (window as any).app.workspace.activeLeaf;
    await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: "preview" } });
  });
  const audio = page.locator(".markdown-preview-view audio").first();
  await expect(audio).toBeVisible();
  await page.locator(".markdown-preview-view a.internal-link", { hasText: "00:07" }).click();
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime), { timeout: 5000 }).toBeCloseTo(7, 0);
  await shots(page, "transcript-reading", ".workspace-leaf.mod-active");

  // With the Media plugin on, the same link opens its player at that time instead.
  await page.evaluate(() => (window as any).app.internalPlugins.setEnabled("media", true));
  await page.locator(".markdown-preview-view a.internal-link", { hasText: "00:07" }).click();
  await expect(page.locator('.workspace-leaf-content[data-type="media-player"]')).toHaveCount(1, { timeout: 10_000 });
  await expect
    .poll(() => page.evaluate(() => (window as any).app.workspace.getLeavesOfType("media-player")[0]?.view?.getState?.().time ?? -1), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(6.9);
});

test("progress shows the engine and a cancel; finished parts are cached, so a re-run resumes and a second run is instant", async ({ page }) => {
  await open(page);
  await enableTranscribe(page);
  await addRecording(page, "Talk.wav");
  await page.evaluate(() => ((window as any).__ai.delayMs = 2500));
  await transcribeFile(page, "Talk.wav");

  const progress = page.locator(".notice.vault-transcribe-notice");
  await expect(progress).toBeVisible();
  await expect(progress.locator(".vault-transcribe-engine")).toHaveText("On this device · whisper-base");
  await expect(progress.locator(".vault-transcribe-status")).toContainText("Part 1 of 2");
  await page.waitForTimeout(900);
  await shots(page, "transcribe-progress", ".notice.vault-transcribe-notice");
  // Part 1 finishes, then cancel during part 2.
  await expect(progress.locator(".vault-transcribe-status")).toContainText("Part 2 of 2", { timeout: 10_000 });
  await progress.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".notice", { hasText: "cancelled" })).toBeVisible();
  await expect(progress).toHaveCount(0);
  expect(await read(page, "Talk (transcript).md")).toBeNull();
  expect(await page.evaluate(() => (window as any).__ai.transcribeCalls.length)).toBe(2);

  // Re-run: part 1 comes from the cache, only part 2 is transcribed.
  await page.evaluate(() => ((window as any).__ai.delayMs = 0));
  await transcribeFile(page, "Talk.wav");
  await expect.poll(() => read(page, "Talk (transcript).md"), { timeout: 20_000 }).not.toBeNull();
  expect(await page.evaluate(() => (window as any).__ai.transcribeCalls.length)).toBe(3);

  // Third run: nothing is transcribed at all.
  const started = Date.now();
  await transcribeFile(page, "Talk.wav");
  await expect.poll(() => read(page, "Talk (transcript) 1.md"), { timeout: 10_000 }).not.toBeNull();
  expect(Date.now() - started).toBeLessThan(3000);
  expect(await page.evaluate(() => (window as any).__ai.transcribeCalls.length)).toBe(3);
  await expect(page.locator(".notice", { hasText: "(from cache)" })).toBeVisible();
  expect(await read(page, "Talk (transcript) 1.md")).toBe((await read(page, "Talk (transcript).md"))!.replace(/\n$/, "\n"));
});

test("an embedded recording: the embed's button inserts the transcript below it; Summarize previews, then inserts with timestamp links", async ({ page }) => {
  await open(page);
  await enableTranscribe(page, { language: "fr" });
  await addRecording(page, "Voice memo.wav", 8);
  await page.evaluate(async () => {
    const a = (window as any).app;
    const f = await a.vault.create("Memo.md", "# Standup\n\n![[Voice memo.wav]]\n\nNotes after.\n");
    await a.workspace.getLeaf("tab").setViewState({ type: "markdown", state: { file: f.path, mode: "preview" }, active: true });
  });
  const button = page.locator(".markdown-preview-view .internal-embed .vault-transcribe-embed-button");
  await expect(button).toBeVisible();
  await shots(page, "embed-button", ".markdown-preview-view .internal-embed");
  await button.click();
  await expect.poll(() => read(page, "Memo.md"), { timeout: 15_000 }).toContain("After a pause");
  expect(await read(page, "Memo.md")).toBe(
    "# Standup\n\n![[Voice memo.wav]]\n\n[[Voice memo.wav#t=0|00:00]] Hello there. This continues the thought.\n\n[[Voice memo.wav#t=7.00|00:07]] After a pause, a new paragraph.\n\nNotes after.\n",
  );
  expect(await page.evaluate(() => (window as any).__ai.transcribeCalls[0].language)).toBe("fr");

  await page.evaluate(() => ((window as any).__ai.summary = "A short standup.\n\n- Greeting [00:00]\n- A new point after a pause [00:07]"));
  await page.evaluate(() => (window as any).app.commands.executeCommandById("transcribe:summarize-transcript"));
  const modal = page.locator(".modal.vault-transcribe-summary-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".vault-transcribe-engine")).toHaveText("Ollama on this computer · llama3.2");
  await expect(modal.locator("textarea")).toHaveValue(/\[\[Voice memo\.wav#t=7\.00\|00:07\]\]/);
  await shots(page, "summary-preview", ".modal.vault-transcribe-summary-modal");
  const call = await page.evaluate(() => (window as any).__ai.generateCalls[0]);
  expect(call.feature).toBe("transcribe");
  expect(call.messages[0]).toContain("[00:07] After a pause, a new paragraph.");
  // Nothing is written before Insert.
  expect(await read(page, "Memo.md")).not.toContain("Summary");
  await modal.getByRole("button", { name: "Insert" }).click();
  await expect.poll(() => read(page, "Memo.md")).toContain("> [!summary] Summary\n> A short standup.\n>\n> - Greeting [[Voice memo.wav#t=0|00:00]]\n> - A new point after a pause [[Voice memo.wav#t=7.00|00:07]]\n\n[[Voice memo.wav#t=0|00:00]] Hello there.");
});

test("with AI off, Transcribe explains where to turn it on and writes nothing", async ({ page }) => {
  await open(page);
  await enableTranscribe(page);
  await addRecording(page, "Off.wav", 4);
  await page.evaluate(() => ((window as any).__ai.enabled = false));
  await transcribeFile(page, "Off.wav");
  await expect(page.locator(".notice", { hasText: "Settings → AI" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await read(page, "Off (transcript).md")).toBeNull();
  expect(await page.evaluate(() => (window as any).__ai.transcribeCalls.length)).toBe(0);
});

test("the file menu of an audio file offers Transcribe recording, and the plugin is off by default", async ({ page }) => {
  await open(page);
  expect(await page.evaluate(() => !!(window as any).app.internalPlugins.getPluginById("transcribe")?.enabled)).toBe(false);
  await enableTranscribe(page);
  await addRecording(page, "Menu.wav", 4);
  const titles = await page.evaluate(() => {
    const a = (window as any).app;
    const items: string[] = [];
    const menu = { addItem: (cb: any) => { const item: any = { setSection: () => item, setTitle: (t: string) => (items.push(t), item), setIcon: () => item, onClick: () => item }; cb(item); return menu; }, addSeparator: () => menu };
    a.workspace.trigger("file-menu", menu, a.vault.getFileByPath("Menu.wav"), "file-explorer");
    return items;
  });
  expect(titles).toContain("Transcribe recording");
});

// ---- clipper prompt variables ---------------------------------------------------------------

async function sendClip(page: Page, clip: Record<string, unknown>): Promise<{ result: any; progress: any[] }> {
  return page.evaluate(
    (clip) =>
      new Promise((resolve) => {
        const progress: any[] = [];
        const onMessage = (e: MessageEvent) => {
          const d = e.data;
          if (d?.source !== "vault-companion-app") return;
          if (d.type === "clip-progress" && d.id === clip.id) progress.push(d);
          if (d.type === "clip-result" && d.id === clip.id) {
            window.removeEventListener("message", onMessage);
            resolve({ result: d, progress });
          }
        };
        window.addEventListener("message", onMessage);
        window.postMessage({ source: "vault-companion-ext", type: "ext-hello", protocol: 1, extensionId: "test", version: "0" }, location.origin);
        window.postMessage({ source: "vault-companion-ext", ...clip }, location.origin);
      }),
    clip,
  ) as Promise<{ result: any; progress: any[] }>;
}

/** What the extension sends for a template with prompt variables (canonical tokens as the engine leaves them). */
function promptClip(id: string) {
  const properties = [
    { name: "title", value: "Rust 1.81", type: "text" },
    { name: "summary", value: '{{"a one sentence summary"}}', type: "text" },
    { name: "topics", value: '{{"three topics, comma separated"|split:", "}}', type: "multitext" },
    { name: "rating", value: '{{"a rating from 1 to 5"}}', type: "number" },
  ];
  return {
    type: "clip",
    id,
    path: "Clippings/{{short title}}",
    content: "unused fallback",
    behavior: "create",
    silent: true,
    interpreter: {
      context: "<h1>Announcing Rust 1.81.0</h1><p>The Rust team is happy to announce a new version.</p>",
      body: '## Summary\n\n{{"a three bullet summary"|blockquote}}\n\n{{"a one sentence summary"}}\n\nAnswered by {{model}} ({{modelProvider|lower}}).\n',
      properties,
      propertyTypes: { title: "text", tags: "multitext" },
      frontmatter: true,
      noteName: '{{"a short title for the note"}}',
      folder: "Clippings",
      url: "https://blog.rust-lang.org/2024/09/05/Rust-1.81.0.html",
      nowMs: Date.UTC(2024, 8, 5),
      tzOffsetMinutes: 0,
    },
  };
}

test("clipper: prompt variables are filled by the app's AI, with filters, before the note is written", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    (window as any).__ai.clipperAnswer =
      'Sure! {"prompts_responses":{"prompt_1":"- New lints\\n- Faster sort\\n- Stable APIs","prompt_2":"Rust 1.81 stabilises new lints and sorts.","prompt_3":"lints, sorting, apis","prompt_4":"4","prompt_5":"Rust 1.81 released"}}';
  });
  const { result, progress } = await sendClip(page, promptClip("clip-ai-1"));
  expect(result.ok).toBe(true);
  expect(result.path).toBe("Clippings/Rust 1.81 released.md");
  expect(result.interpreter).toEqual({ prompts: 5, filled: 5, engine: "Ollama on this computer · llama3.2" });
  expect(progress.map((p) => p.engine).filter(Boolean)).toEqual(["Ollama on this computer · llama3.2"]);

  const note = await read(page, "Clippings/Rust 1.81 released.md");
  expect(note).toBe(
    '---\ntitle: "Rust 1.81"\nsummary: "Rust 1.81 stabilises new lints and sorts."\ntopics:\n  - "lints"\n  - "sorting"\n  - "apis"\nrating: 4\n---\n' +
      "## Summary\n\n> - New lints\n> - Faster sort\n> - Stable APIs\n\nRust 1.81 stabilises new lints and sorts.\n\nAnswered by llama3.2 (ollama).\n",
  );
  // One request, Web Clipper's shape: system prompt, the page context, then the prompts as JSON.
  const calls = await page.evaluate(() => (window as any).__ai.generateCalls);
  expect(calls).toHaveLength(1);
  expect(calls[0].feature).toBe("clipper");
  expect(calls[0].json).toBe(true);
  expect(calls[0].system).toContain("prompts_responses");
  expect(calls[0].messages[0]).toContain("Announcing Rust 1.81.0");
  expect(JSON.parse(calls[0].messages[1])).toEqual({
    prompts: {
      prompt_1: "a three bullet summary",
      prompt_2: "a one sentence summary",
      prompt_3: "three topics, comma separated",
      prompt_4: "a rating from 1 to 5",
      prompt_5: "a short title for the note",
    },
  });
  await expect(page.locator(".notice", { hasText: "Filled 5 prompt variables · Ollama on this computer" })).toBeVisible();
  await shots(page, "clipper-filled-notice", ".notice-container");
});

test("clipper: with AI off the clip is still written, prompt variables stay as placeholders, and a notice says why", async ({ page }) => {
  await open(page);
  await page.evaluate(() => ((window as any).__ai.enabled = false));
  const { result } = await sendClip(page, promptClip("clip-ai-off"));
  expect(result.ok).toBe(true);
  expect(result.interpreter.filled).toBe(0);
  expect(result.interpreter.message).toContain("Settings → AI");
  const path = result.path as string;
  expect(path).toMatch(/^Clippings\/.*\.md$/);
  const note = (await read(page, path))!;
  expect(note).toContain('summary: "{{\\"a one sentence summary\\"}}"');
  // A placeholder in a number property is kept as text rather than dropped.
  expect(note).toContain('rating: "{{\\"a rating from 1 to 5\\"}}"');
  expect(note).toContain('{{"a three bullet summary"|blockquote}}');
  expect(await page.evaluate(() => (window as any).__ai.generateCalls.length)).toBe(0);
  await expect(page.locator(".notice", { hasText: "AI is off for the web clipper" })).toBeVisible();
  await shots(page, "clipper-ai-off-notice", ".notice-container");
});

test("clipper: a model answer that cannot be read leaves placeholders and reports the failure", async ({ page }) => {
  await open(page);
  await page.evaluate(() => ((window as any).__ai.clipperAnswer = "I cannot help with that."));
  const clip = promptClip("clip-ai-bad");
  const { result } = await sendClip(page, clip);
  expect(result.ok).toBe(true);
  expect(result.interpreter.filled).toBe(0);
  expect(result.interpreter.message).toContain("could not be read");
  expect(await read(page, result.path)).toContain('{{"a three bullet summary"|blockquote}}');
});
