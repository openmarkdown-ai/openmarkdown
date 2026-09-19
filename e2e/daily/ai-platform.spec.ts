/**
 * A1 AI platform: `app.ai` — routing, consent, keys, streaming, errors, the
 * AI tools migration, Settings → AI, and the AI tools running on a stub engine.
 *
 *   OM_URL=http://localhost:5220 npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/ai-platform.spec.ts
 *
 * No network: every non-local request is aborted, and the cloud providers'
 * HTTP APIs (Anthropic, OpenAI, Gemini, Ollama) are answered by page.route with
 * recorded-shape responses, so the real engine code runs against them.
 *
 * Opt-in real smoke run (downloads ~135 MB from Hugging Face into the test
 * browser): AI_REAL_SMOKE=1 … -g "real transformers.js".
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleLabels, smoothLabels, toSimplified } from "../../packages/app/src/ai/engines/whisper";

const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "openmarkdown-ai-platform-shots");
const MOD = process.platform === "darwin" ? "Meta" : "Control";

// ---- helpers ------------------------------------------------------------------------------

/** Blocks the internet; returns the list of URLs that were attempted. */
async function offline(page: Page): Promise<string[]> {
  const attempted: string[] = [];
  await page.routeWebSocket(/.*/, () => {});
  await page.route(/^https?:\/\/(?!localhost:52|127\.0\.0\.1:52)/, (route) => {
    attempted.push(route.request().url());
    return route.abort("internetdisconnected");
  });
  return attempted;
}

async function openDemo(page: Page) {
  await page.goto("/?vault=demo");
  await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true, null, { timeout: 60_000 });
  await page.waitForSelector(".nav-file-title", { timeout: 30_000 });
}

async function openNote(page: Page, path: string, content: string) {
  await page.evaluate(
    async ({ path, content }) => {
      const a = (window as any).app;
      let f = a.vault.getFileByPath(path);
      if (!f) f = await a.vault.create(path, content);
      else await a.vault.modify(f, content);
      const leaf = a.workspace.getLeaf(false);
      await leaf.openFile(f, { state: { mode: "source" } });
      a.workspace.setActiveLeaf(leaf, { focus: true });
    },
    { path, content },
  );
  await page.waitForSelector(".workspace-leaf.mod-active .cm-content");
}

const editorValue = (page: Page) => page.evaluate(() => (window as any).app.workspace.activeEditor.editor.getValue());
const command = (page: Page, id: string) => page.evaluate((id) => (window as any).app.commands.executeCommandById(id), id);

async function setSelection(page: Page, line: number, ch: number, toLine: number, toCh: number) {
  await page.evaluate(
    ({ line, ch, toLine, toCh }) => {
      const e = (window as any).app.workspace.activeEditor.editor;
      e.setSelection({ line, ch }, { line: toLine, ch: toCh });
      e.focus();
    },
    { line, ch, toLine, toCh },
  );
}

async function openSettingsTab(page: Page, id: string) {
  await page.evaluate((id) => {
    const s = (window as any).app.setting;
    s.open();
    s.openTabById(id);
  }, id);
  await page.waitForSelector(".modal.mod-settings .vertical-tab-content", { timeout: 10_000 });
}

async function setDark(page: Page, dark: boolean) {
  await page.evaluate((dark) => {
    document.body.toggleClass("theme-dark", dark);
    document.body.toggleClass("theme-light", !dark);
  }, dark);
}

async function shots(page: Page, name: string, target?: string, fullPage = false) {
  mkdirSync(SHOTS, { recursive: true });
  for (const dark of [false, true]) {
    await setDark(page, dark);
    await page.waitForTimeout(150);
    const path = join(SHOTS, `${name}-${dark ? "dark" : "light"}.png`);
    if (target) await page.locator(target).first().screenshot({ path });
    else await page.screenshot({ path, fullPage });
  }
  await setDark(page, false);
}

/** Removes Chrome's built-in AI so routing is deterministic (headless Chromium exposes some of it). */
function noBuiltinAi() {
  for (const n of ["Summarizer", "Translator", "LanguageDetector", "LanguageModel", "Writer", "Rewriter", "Proofreader"]) delete (window as any)[n];
}

/** Stub engines, installed through the documented test hook. */
function stubHook(opts: { route?: string; consent?: "grant" | "deny" }) {
  const w = window as any;
  w.__stubCalls = [];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const reply = (req: any): string => {
    const sys: string = req.system ?? "";
    const user: string = req.messages[req.messages.length - 1]?.content ?? "";
    if (sys.startsWith("You summarize")) return "* The garden needs tomatoes\n* Plant in May";
    if (sys.startsWith("Translate")) return `[fr] ${user}`;
    if (sys.startsWith("Rewrite")) return "A shorter version.";
    if (sys.startsWith("Correct spelling")) return user.replace(/\bteh\b/g, "the").replace(/\brecieve\b/g, "receive");
    if (sys.startsWith("You write Markdown")) return `Written: ${user}`;
    if (sys.startsWith("Identify the language")) return "de";
    if (sys.startsWith("You answer questions")) return `Answer from ${/NOTE "([^"]+)"/.exec(sys)?.[1]} to: ${user}`;
    return `echo: ${user}`;
  };
  const gen = (id: string) => async (req: any) => {
    w.__stubCalls.push({ provider: id, feature: req.feature, system: req.system, messages: req.messages, task: req.task });
    const text = reply(req);
    // Stream in word-sized pieces, slowly enough to observe partial output.
    const pieces = text.match(/\S+\s*|\s+/g) ?? [text];
    for (const p of pieces) {
      if (req.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      await wait(w.__stubDelay ?? 20);
      req.onToken?.(p);
    }
    return { text };
  };
  w.__openmarkdownAiTest = {
    providers: [
      { id: "stub", label: "Device Stub", location: "device", capabilities: ["generate", "embed", "transcribe"], generate: gen("stub"), embed: async (req: any) => ({ vectors: req.texts.map((t: string) => new Float32Array([t.length, 1, 0])), dims: 3 }), transcribe: async () => ({ text: "hello", segments: [{ start: 0, end: 1, text: "hello" }] }) },
      { id: "cloudstub", label: "Cloud Stub", location: "cloud", capabilities: ["generate"], model: () => "cloud-model-1", generate: gen("cloudstub") },
      {
        id: "dlstub",
        label: "Download Stub",
        location: "device",
        capabilities: ["embed"],
        model: () => "tiny-embedder",
        pendingDownload: async () => (w.__dlDone ? null : { bytes: 118_308_185, from: "Hugging Face (huggingface.co)", what: "the embedding model tiny-embedder" }),
        embed: async (req: any) => ((w.__dlDone = true), { vectors: req.texts.map(() => new Float32Array([0, 1])), dims: 2 }),
      },
    ],
    route: opts.route,
    consent: opts.consent,
  };
}

function cors(extra: Record<string, string> = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, anthropic-beta, x-goog-api-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...extra,
  };
}

async function preflightOr(route: Route, fn: () => Promise<void>) {
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors() });
  return fn();
}

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
}

/** Calls app.ai.generate in the page and returns { text, tokens, engine } or { error: { reason, message } }. */
async function generateIn(page: Page, req: Record<string, unknown>) {
  return page.evaluate(async (req: any) => {
    const tokens: string[] = [];
    try {
      const r = await (window as any).app.ai.generate({ ...req, onToken: (t: string) => tokens.push(t) });
      return { text: r.text, tokens, engine: r.engine };
    } catch (e: any) {
      return { error: { name: e.name, reason: e.reason, message: e.message } };
    }
  }, req);
}

// ---- tests ------------------------------------------------------------------------------------

test("whisper fixes: language labels settle over silence and stray cells; Chinese normalised to one script", () => {
  // A lone stray cell, at the edges too.
  expect(smoothLabels(["en", "en", "zh", "zh", "zh", "ko"])).toEqual(["en", "en", "zh", "zh", "zh", "zh"]);
  expect(smoothLabels(["en", "ja", "ja", "ja"])).toEqual(["ja", "ja", "ja", "ja"]);
  // Quiet cells (null) inherit a neighbour; a language with under 4% and under 25 s is folded away.
  const labels: (string | null)[] = [...Array(40).fill("zh"), null, null, "th", ...Array(20).fill("zh"), ...Array(10).fill("en")];
  expect(new Set(settleLabels(labels, 4))).toEqual(new Set(["zh", "en"]));
  expect(settleLabels([null, "en", "en", null], 4)).toEqual(["en", "en", "en", "en"]);
  // A real 40 s second language survives.
  expect(settleLabels([...Array(30).fill("en"), ...Array(10).fill("zh")], 4).filter((l) => l === "zh")).toHaveLength(10);
  // Traditional → Simplified, one for one; Japanese (kana) untouched.
  expect(toSimplified("這個時候我們發現")).toBe("这个时候我们发现");
  expect(toSimplified("時間を見る")).toBe("時間を見る");
  expect(toSimplified("Hello")).toBe("Hello");
});

test("off by default: nothing is available, requests explain how to turn AI on", async ({ page }) => {
  const attempted = await offline(page);
  await page.addInitScript(noBuiltinAi);
  await openDemo(page);
  const state = await page.evaluate(() => {
    const ai = (window as any).app.ai;
    return { enabled: ai.config.enabled, tools: ai.isAvailable("tools"), engine: ai.engineFor("chat") };
  });
  expect(state).toEqual({ enabled: false, tools: false, engine: null });
  const r = await generateIn(page, { feature: "tools", messages: [{ role: "user", content: "hi" }] });
  expect(r.error).toMatchObject({ name: "AiUnavailableError", reason: "disabled", message: "AI is turned off. Turn it on in Settings → AI." });
  await openSettingsTab(page, "ai");
  await expect(page.locator(".vault-ai-summary")).toContainText("AI is off. Nothing runs, downloads or leaves this device.");
  await expect(page.locator(".vault-ai-feature")).toHaveCount(0);
  expect(attempted).toEqual([]);
});

test("routing: automatic prefers this device, per-feature routes, capability checks, engine labels", async ({ page }) => {
  await offline(page);
  await page.addInitScript(noBuiltinAi);
  await page.addInitScript(stubHook, { consent: "grant" });
  await openDemo(page);
  const r = await page.evaluate(() => {
    const ai = (window as any).app.ai;
    ai.configure({ enabled: true, features: { tools: true, chat: true, related: true }, providers: { stub: { enabled: true }, cloudstub: { enabled: true }, dlstub: { enabled: false } } });
    const auto = ai.engineFor("tools");
    ai.configure({ routes: { chat: { generate: "cloudstub" } } });
    return {
      auto,
      chat: ai.engineFor("chat"),
      chatLabel: ai.describe(ai.engineFor("chat")),
      toolsLabel: ai.describe(auto),
      related: ai.engineFor("related", "embed")?.provider,
      transcribeOnCloud: (ai.configure({ routes: { transcribe: { transcribe: "cloudstub" } } }), ai.isAvailable("transcribe", "transcribe")),
      visionOnStub: ai.isAvailable("tools", "vision"),
      reviewOff: ai.isAvailable("review"),
    };
  });
  expect(r.auto).toEqual({ provider: "stub", model: "stub-model", location: "device", leavesDevice: false });
  expect(r.chat).toEqual({ provider: "cloudstub", model: "cloud-model-1", location: "cloud", leavesDevice: true });
  expect(r.toolsLabel).toBe("On this device");
  expect(r.chatLabel).toBe("Sent to Cloud Stub");
  // Embeddings: automatic picks the built-in on-device engine (transformers.js) before any stub or server.
  expect(r.related).toBe("transformers");
  expect(r.transcribeOnCloud).toBe(false);
  expect(r.visionOnStub).toBe(false);
  expect(r.reviewOff).toBe(false);

  const err = await generateIn(page, { feature: "transcribe", messages: [] });
  expect(err.error?.message).toContain("Transcription is turned off");
  const unsupported = await page.evaluate(async () => {
    const ai = (window as any).app.ai;
    ai.configure({ features: { transcribe: true } });
    try {
      await ai.transcribe({ audio: new Blob([]) });
    } catch (e: any) {
      return { reason: e.reason, message: e.message };
    }
  });
  expect(unsupported).toEqual({ reason: "unsupported", message: "Cloud Stub cannot do this (transcribe). Pick another engine for Transcription in Settings → AI." });

  // Anthropic routed but no key: a user-readable auth error, nothing sent.
  const noKey = await page.evaluate(async () => {
    const ai = (window as any).app.ai;
    ai.configure({ routes: { tools: { generate: "anthropic" } }, providers: { anthropic: { enabled: true } } });
    try {
      await ai.generate({ feature: "tools", messages: [{ role: "user", content: "x" }] });
    } catch (e: any) {
      return { reason: e.reason, message: e.message, available: ai.isAvailable("tools") };
    }
  });
  expect(noKey).toEqual({ reason: "auth", message: "Add your Anthropic API key in Settings → AI.", available: false });

  // Vision is explicit: only engines (and, for local servers, models) that read images.
  const vision = await page.evaluate(async () => {
    const ai = (window as any).app.ai;
    ai.configure({ features: { suggest: true }, providers: { ollama: { enabled: true, model: "llama3.2" }, "chrome-builtin": { enabled: true } } });
    const out: Record<string, boolean | number | undefined> = {};
    for (const [id, model] of [["ollama", "llama3.2"], ["ollama", "gemma3:4b"], ["stub", ""]] as const) {
      if (model) ai.setProviderSettings(id, { model });
      ai.configure({ routes: { suggest: { generate: id } } });
      out[`${id}:${model}`] = ai.isAvailable("suggest", "vision");
    }
    ai.configure({ routes: { suggest: { generate: "ollama" } } });
    out.ollamaContext = ai.engineFor("suggest")?.contextWindow;
    // Chrome's built-in model never reads images, even where the Prompt API exists.
    (window as any).LanguageModel = { create: async () => ({}), availability: async () => "available" };
    ai.configure({ routes: { suggest: { generate: "chrome-builtin" } } });
    out.chromeText = ai.isAvailable("suggest", "generate");
    out.chromeVision = ai.isAvailable("suggest", "vision");
    out.chromeContext = ai.engineFor("suggest")?.contextWindow;
    delete (window as any).LanguageModel;
    return out;
  });
  expect(vision).toEqual({ "ollama:llama3.2": false, "ollama:gemma3:4b": true, "stub:": false, ollamaContext: 4096, chromeText: true, chromeVision: false, chromeContext: 6000 });

  // Routing through the Settings table.
  await page.evaluate(() => (window as any).app.ai.configure({ routes: { tools: { generate: "auto" } } }));
  await openSettingsTab(page, "ai");
  const chatRow = page.locator('.vault-ai-feature[data-feature="chat"]');
  await expect(chatRow).toContainText("Sent to Cloud Stub");
  await chatRow.locator("select.vault-ai-route").selectOption("stub");
  await expect(page.locator('.vault-ai-feature[data-feature="chat"]')).toContainText("On this device");
  expect(await page.evaluate(() => (window as any).app.ai.engineFor("chat").provider)).toBe("stub");
});

test("consent: asked once per feature and engine before text leaves the device, and before a download", async ({ page }) => {
  await offline(page);
  await page.addInitScript(noBuiltinAi);
  await page.addInitScript(stubHook, { route: "cloudstub" });
  await openDemo(page);
  await page.evaluate(() => (window as any).app.ai.configure({ routes: { related: { embed: "dlstub" } }, providers: { dlstub: { enabled: true } } }));

  // Cloud: Cancel → consent-declined, nothing reached the provider.
  let pending = generateIn(page, { feature: "chat", messages: [{ role: "user", content: "secret note text" }] });
  const modal = page.locator(".modal.vault-ai-consent");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".modal-title")).toHaveText("Send text to Cloud Stub?");
  await expect(modal).toContainText("Chat is set to use Cloud Stub (cloud-model-1)");
  await shots(page, "consent-cloud", ".modal.vault-ai-consent");
  await modal.getByRole("button", { name: "Cancel" }).click();
  expect((await pending).error).toEqual({ name: "AiUnavailableError", reason: "consent-declined", message: "Nothing was sent to Cloud Stub." });
  expect(await page.evaluate(() => (window as any).__stubCalls.length)).toBe(0);

  // Accept → runs; the second request does not ask again.
  pending = generateIn(page, { feature: "chat", messages: [{ role: "user", content: "hello" }] });
  await modal.getByRole("button", { name: "Send to Cloud Stub" }).click();
  expect((await pending).text).toBe("echo: hello");
  expect((await generateIn(page, { feature: "chat", messages: [{ role: "user", content: "again" }] })).text).toBe("echo: again");
  await expect(modal).toHaveCount(0);

  // Another feature on the same engine asks separately.
  pending = generateIn(page, { feature: "tools", messages: [{ role: "user", content: "x" }] });
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Writing tools is set to use Cloud Stub");
  await modal.getByRole("button", { name: "Send to Cloud Stub" }).click();
  await pending;

  // Changing the engine's model asks again for that feature.
  await page.evaluate(() => {
    const ai = (window as any).app.ai;
    ai.getProvider("cloudstub").model = () => "cloud-model-2";
  });
  pending = generateIn(page, { feature: "chat", messages: [{ role: "user", content: "y" }] });
  await expect(modal).toContainText("(cloud-model-2)");
  await modal.getByRole("button", { name: "Cancel" }).click();
  expect((await pending).error?.reason).toBe("consent-declined");

  // ensureConsent: download with its size, remembered; nothing to download → true without asking.
  const ensure = page.evaluate(() => (window as any).app.ai.ensureConsent("related", "embed"));
  await expect(modal.locator(".modal-title")).toHaveText("Download the on-device model?");
  await expect(modal).toContainText("Related notes and search by meaning runs on this device with the embedding model tiny-embedder. It needs a one-time download first: 112.8 MB.");
  await expect(modal).toContainText("Downloaded from Hugging Face (huggingface.co)");
  await shots(page, "consent-download", ".modal.vault-ai-consent");
  await modal.getByRole("button", { name: "Download (112.8 MB)" }).click();
  expect(await ensure).toBe(true);
  expect(await page.evaluate(() => (window as any).app.ai.ensureConsent("related", "embed"))).toBe(true);
  await expect(modal).toHaveCount(0);

  // Remembered across a reload (per vault, per browser).
  await page.reload();
  await page.waitForFunction(() => (window as any).app?.metadataCache?.initialized === true, null, { timeout: 60_000 });
  expect((await generateIn(page, { feature: "chat", messages: [{ role: "user", content: "after reload" }] })).error?.reason).toBeUndefined();
  await expect(modal).toHaveCount(0);
});

test("streaming, JSON retry and provider errors through the real engines (mocked HTTP)", async ({ page }) => {
  await offline(page);
  await page.addInitScript(noBuiltinAi);
  await page.addInitScript(() => ((window as any).__openmarkdownAiTest = { consent: "grant" }));
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  await page.route("https://api.anthropic.com/v1/messages", (route) =>
    preflightOr(route, async () => {
      const req = route.request();
      seen.push({ url: req.url(), headers: req.headers(), body: req.postDataJSON() });
      await route.fulfill({
        status: 200,
        headers: cors({ "content-type": "text/event-stream" }),
        body:
          "event: message_start\n" +
          sse([
            { type: "message_start", message: { id: "msg_1" } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " from Claude" } },
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
            { type: "message_stop" },
          ]),
      });
    }),
  );
  let openaiCalls = 0;
  await page.route("https://api.openai.com/v1/chat/completions", (route) =>
    preflightOr(route, async () => {
      openaiCalls++;
      const body = route.request().postDataJSON();
      seen.push({ url: route.request().url(), headers: route.request().headers(), body });
      // First answer is not JSON: the service retries once.
      const content = body.response_format ? (openaiCalls === 1 ? "Sure! here it is" : '{"tags":["garden"]}') : "Hi";
      await route.fulfill({ status: 200, headers: cors({ "content-type": "text/event-stream" }), body: sse([{ choices: [{ delta: { content: content.slice(0, 5) } }] }, { choices: [{ delta: { content: content.slice(5) } }] }, "[DONE]"]) });
    }),
  );
  await page.route("https://generativelanguage.googleapis.com/**", (route) =>
    preflightOr(route, async () => {
      const url = route.request().url();
      seen.push({ url, headers: route.request().headers(), body: route.request().postDataJSON() });
      if (url.includes(":batchEmbedContents")) return route.fulfill({ status: 200, headers: cors({ "content-type": "application/json" }), body: JSON.stringify({ embeddings: [{ values: [3, 4] }, { values: [0, 2] }] }) });
      if (url.includes("bad-model")) return route.fulfill({ status: 404, headers: cors({ "content-type": "application/json" }), body: JSON.stringify({ error: { code: 404, message: "models/bad-model is not found" } }) });
      return route.fulfill({ status: 200, headers: cors({ "content-type": "text/event-stream" }), body: sse([{ candidates: [{ content: { parts: [{ text: "Gem" }] } }] }, { candidates: [{ content: { parts: [{ text: "ini" }] }, finishReason: "STOP" }] }]) });
    }),
  );
  await page.route("http://localhost:11434/**", async (route) => {
    // Ollama up but without this origin in OLLAMA_ORIGINS: the browser blocks CORS requests
    // (a fulfilled response would bypass that check, so fail them), while a no-cors probe gets through.
    // CORS-mode requests carry Origin; the no-cors GET probe does not.
    if ((await route.request().allHeaders()).origin) return route.abort("accessdenied");
    return route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ object: "list", data: [{ id: "gemma3" }] }) });
  });
  await openDemo(page);

  const setup = async (provider: string, key?: string, extra: Record<string, unknown> = {}) =>
    page.evaluate(
      async ({ provider, key, extra }) => {
        const ai = (window as any).app.ai;
        ai.configure({ enabled: true, features: { tools: true, related: true }, routes: { tools: { generate: provider }, related: { embed: provider } }, providers: { [provider]: { enabled: true, ...extra } } });
        if (key) await ai.setKey(provider, key);
      },
      { provider, key, extra },
    );

  // Anthropic: streamed deltas, browser-access header, key sent, current default model.
  await setup("anthropic", "sk-ant-test-0000000000001234");
  const a = await generateIn(page, { feature: "tools", system: "Be brief.", messages: [{ role: "user", content: "Hi" }] });
  expect(a.text).toBe("Hello from Claude");
  expect(a.tokens).toEqual(["Hello", " from Claude"]);
  expect(a.engine).toEqual({ provider: "anthropic", model: "claude-opus-5", location: "cloud", leavesDevice: true, contextWindow: 1_000_000 });
  const sent = seen.find((s) => s.url.includes("anthropic"))!;
  expect(sent.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  expect(sent.headers["x-api-key"]).toBe("sk-ant-test-0000000000001234");
  expect(sent.body).toMatchObject({ model: "claude-opus-5", system: "Be brief.", stream: true, messages: [{ role: "user", content: "Hi" }] });

  // OpenAI: JSON mode, invalid first answer retried once.
  await setup("openai", "sk-openai-test-99999999");
  const o = await generateIn(page, { feature: "tools", json: true, messages: [{ role: "user", content: "tags?" }] });
  expect(o.text).toBe('{"tags":["garden"]}');
  expect(openaiCalls).toBe(2);
  expect(seen.filter((s) => s.url.includes("openai")).at(-1)!.headers.authorization).toBe("Bearer sk-openai-test-99999999");

  // Gemini: streaming and embeddings (normalised), and a readable 404.
  await setup("gemini", "AIza-test-key-5678");
  expect((await generateIn(page, { feature: "tools", messages: [{ role: "user", content: "x" }] })).text).toBe("Gemini");
  const emb = await page.evaluate(async () => {
    const r = await (window as any).app.ai.embed({ feature: "related", texts: ["a", "b"], kind: "query" });
    return { vectors: r.vectors.map((v: Float32Array) => Array.from(v)), dims: r.dims, model: r.model, engineModel: r.engine.model, routed: (window as any).app.ai.engineFor("related", "embed").model };
  });
  // One model string everywhere: the index key equals engine.model and engineFor(...).model.
  expect(emb).toEqual({ vectors: [[0.6000000238418579, 0.800000011920929], [0, 1]], dims: 2, model: "gemini-embedding-001", engineModel: "gemini-embedding-001", routed: "gemini-embedding-001" });
  expect(seen.find((s) => s.url.includes("batchEmbedContents"))!.body.requests[0]).toMatchObject({ taskType: "RETRIEVAL_QUERY" });
  await page.evaluate(() => (window as any).app.ai.setProviderSettings("gemini", { model: "bad-model" }));
  const bad = await generateIn(page, { feature: "tools", messages: [{ role: "user", content: "x" }] });
  expect(bad.error).toEqual({ name: "AiUnavailableError", reason: "failed", message: "Google Gemini does not know this model or address. Check the model name in Settings → AI. (models/bad-model is not found)" });

  // A 401 names the provider and where to fix the key.
  await page.route("https://api.openai.com/v1/chat/completions", (route) => preflightOr(route, () => route.fulfill({ status: 401, headers: cors({ "content-type": "application/json" }), body: JSON.stringify({ error: { message: "Incorrect API key provided" } }) })));
  await setup("openai");
  const unauthorized = await generateIn(page, { feature: "tools", messages: [{ role: "user", content: "x" }] });
  expect(unauthorized.error).toEqual({ name: "AiUnavailableError", reason: "auth", message: "OpenAI did not accept the API key. Check it in Settings → AI. (Incorrect API key provided)" });

  // Ollama blocking this origin: the request fails, and Test connection explains OLLAMA_ORIGINS.
  await setup("ollama", undefined, { model: "gemma3" });
  const blocked = await generateIn(page, { feature: "tools", messages: [{ role: "user", content: "x" }] });
  expect(blocked.error?.reason).toBe("offline");
  expect(blocked.error?.message).toContain("Could not reach Ollama at http://localhost:11434");
  await openSettingsTab(page, "ai");
  const ollama = page.locator('.vault-ai-provider[data-provider="ollama"]');
  await ollama.getByRole("button", { name: "Test connection" }).click();
  await expect(ollama.locator(".vault-ai-provider-status")).toHaveAttribute("data-state", "blocked");
  await expect(ollama.locator(".vault-ai-provider-status")).toContainText("OLLAMA_ORIGINS=");

  // Offline: a cloud engine fails fast with a plain message.
  await page.evaluate(() => (window as any).app.setting.close());
  await setup("anthropic");
  await page.context().setOffline(true);
  const off = await generateIn(page, { feature: "tools", messages: [{ role: "user", content: "x" }] });
  await page.context().setOffline(false);
  expect(off.error).toEqual({ name: "AiUnavailableError", reason: "offline", message: "You are offline, so Anthropic cannot be reached." });
});

test("keys: saved from Settings → AI, masked, encrypted in IndexedDB, never in localStorage or the vault", async ({ page }) => {
  await offline(page);
  await page.addInitScript(noBuiltinAi);
  await openDemo(page);
  const KEY = "sk-ant-api03-PLAINTEXT-SHOULD-NOT-APPEAR-9876";
  await openSettingsTab(page, "ai");
  await page.locator(".vault-ai-master .checkbox-container").click();
  const row = page.locator('.vault-ai-provider[data-provider="anthropic"]');
  await row.locator(".checkbox-container").click();
  const keyRow = page.locator('.vault-ai-key[data-provider="anthropic"]');
  await keyRow.locator("input.vault-ai-key-input").fill(KEY);
  await expect(keyRow.locator("input.vault-ai-key-input")).toHaveAttribute("type", "password");
  await keyRow.getByRole("button", { name: "Save key" }).click();
  await expect(page.locator('.vault-ai-key[data-provider="anthropic"] .vault-ai-key-masked')).toHaveText("••••9876");
  await expect(page.locator(".vertical-tab-content")).not.toContainText("PLAINTEXT");

  const where = await page.evaluate(async (KEY) => {
    const a = (window as any).app;
    const local = Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? "").includes(KEY) || (localStorage.getItem(k) ?? "").includes("PLAINTEXT"));
    const inVault: string[] = [];
    const walk = async (dir: string) => {
      const listed = await a.vault.adapter.list(dir);
      for (const f of listed.files) if ((await a.vault.adapter.read(f).catch(() => "")).includes("PLAINTEXT")) inVault.push(f);
      for (const d of listed.folders) await walk(d);
    };
    await walk("");
    const idb = await new Promise<any>((resolve) => {
      const req = indexedDB.open("openmarkdown-ai");
      req.onsuccess = () => {
        const t = req.result.transaction("keys", "readonly").objectStore("keys");
        const all = t.getAll();
        const keys = t.getAllKeys();
        all.onsuccess = () => keys.onsuccess = () => resolve({ values: all.result, keys: keys.result });
      };
    });
    const record = idb.values.find((v: any) => v?.ct);
    const plainInIdb = new TextDecoder().decode(record.ct).includes("PLAINTEXT");
    const wrap = idb.values.find((v: any) => v instanceof CryptoKey) as CryptoKey;
    const exportable = await crypto.subtle.exportKey("raw", wrap).then(() => true, () => false);
    return { local, inVault, plainInIdb, extractable: wrap.extractable, exportable, idbKeys: idb.keys, decrypted: await a.ai.keychain.get("anthropic"), configKeys: a.ai.config.keys };
  }, KEY);
  expect(where.local).toBe(false);
  expect(where.inVault).toEqual([]);
  expect(where.plainInIdb).toBe(false);
  expect(where.extractable).toBe(false);
  expect(where.exportable).toBe(false);
  expect(where.decrypted).toBe(KEY);
  expect(where.configKeys).toEqual({ anthropic: true });
  expect(where.idbKeys).toContain("key:demo:anthropic");

  // Remove.
  await page.locator('.vault-ai-key[data-provider="anthropic"] .clickable-icon').click();
  await page.locator(".modal.mod-confirmation").getByRole("button", { name: "Remove" }).click();
  await expect(page.locator('.vault-ai-key[data-provider="anthropic"] input.vault-ai-key-input')).toBeVisible();
  expect(await page.evaluate(() => (window as any).app.ai.keychain.get("anthropic"))).toBeNull();
});

test("migration: AI tools' endpoint settings and plain-text key move into app.ai once", async ({ page }) => {
  await offline(page);
  await page.addInitScript(noBuiltinAi);
  await page.addInitScript(() => ((window as any).__openmarkdownAiTest = { consent: "grant" }));
  let body: any = null;
  let auth = "";
  await page.route("https://llm.example.test/v1/chat/completions", (route) =>
    preflightOr(route, async () => {
      body = route.request().postDataJSON();
      auth = route.request().headers().authorization;
      await route.fulfill({ status: 200, headers: cors({ "content-type": "application/json" }), body: JSON.stringify({ choices: [{ message: { content: "* migrated summary" } }] }) });
    }),
  );
  await openDemo(page);
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.vault.writeConfigJson("ai-tools.json", { targetLanguage: "fr", summaryType: "tldr", summaryLength: "short", rewriteMode: "shorter", remoteEnabled: true, remoteBaseUrl: "https://llm.example.test/v1", remoteModel: "my-model" });
    a.saveLocalStorage("ai-tools-remote-key", "sk-old-endpoint-key-4321");
    await a.internalPlugins.setEnabled("ai-tools", true);
  });
  await page.waitForFunction(() => (window as any).app.ai.config.migrated["ai-tools"] && (window as any).app.ai.config.keys["openai-compatible"], null, { timeout: 10_000 });
  const cfg = await page.evaluate(async () => {
    const a = (window as any).app;
    return { enabled: a.ai.config.enabled, features: a.ai.config.features, compat: a.ai.config.providers["openai-compatible"], oldKey: a.loadLocalStorage("ai-tools-remote-key"), key: await a.ai.keychain.get("openai-compatible"), engine: a.ai.engineFor("tools") };
  });
  expect(cfg).toEqual({
    enabled: true,
    features: { tools: true, chat: true },
    compat: { enabled: true, baseUrl: "https://llm.example.test/v1", model: "my-model" },
    oldKey: null,
    key: "sk-old-endpoint-key-4321",
    engine: { provider: "openai-compatible", model: "my-model", location: "cloud", leavesDevice: true },
  });
  // The command id is unchanged and runs on the migrated endpoint.
  await openNote(page, "Garden.md", "# Garden\n\nTomatoes in May.");
  expect(await command(page, "ai-tools:summarize")).toBe(true);
  const modal = page.locator(".modal.vault-ai-modal");
  await expect(modal.locator(".vault-ai-output")).toHaveText("* migrated summary");
  await expect(modal.locator(".vault-ai-status")).toContainText("Sent to your AI server");
  expect(body).toMatchObject({ model: "my-model", stream: true });
  expect(body.messages[0].content).toContain("a short TL;DR paragraph, short length");
  expect(auth).toBe("Bearer sk-old-endpoint-key-4321");

  // Once: a later change is not overwritten on the next load.
  await page.evaluate(async () => {
    const a = (window as any).app;
    a.ai.setProviderSettings("openai-compatible", { model: "changed" });
    await a.internalPlugins.setEnabled("ai-tools", false);
    await a.internalPlugins.setEnabled("ai-tools", true);
  });
  expect(await page.evaluate(() => (window as any).app.ai.config.providers["openai-compatible"].model)).toBe("changed");
});

test("AI tools on a stub engine: same command ids, streaming preview, one undo step, ask about this note", async ({ page }) => {
  await offline(page);
  await page.addInitScript(noBuiltinAi);
  await page.addInitScript(stubHook, { route: "stub", consent: "grant" });
  await openDemo(page);
  await page.evaluate(() => (window as any).app.internalPlugins.setEnabled("ai-tools", true));
  const note = "# Garden plan\n\nWe plant tomatoes and basil in May.\nI will recieve teh seeds on Friday.";
  await openNote(page, "Projects/Garden plan.md", note);

  // Summarize: partial output streams in before the final text.
  await page.evaluate(() => ((window as any).__stubDelay = 150));
  expect(await command(page, "ai-tools:summarize")).toBe(true);
  const modal = page.locator(".modal.vault-ai-modal");
  const partial = await page.waitForFunction(
    () => {
      const out = document.querySelector(".modal.vault-ai-modal .vault-ai-output.is-running");
      const text = out?.textContent ?? "";
      const status = document.querySelector(".modal.vault-ai-modal .vault-ai-status")?.textContent;
      const insert = [...document.querySelectorAll<HTMLButtonElement>(".modal.vault-ai-modal button")].find((b) => b.textContent === "Insert at top");
      return text.includes("The garden") && !text.includes("May") ? { text, status, insertDisabled: insert?.disabled } : null;
    },
    null,
    { timeout: 5000, polling: 20 },
  );
  expect(await partial.jsonValue()).toMatchObject({ status: "Working on this device…", insertDisabled: true });
  await expect(modal.locator(".vault-ai-output")).toHaveText("* The garden needs tomatoes\n* Plant in May", { timeout: 10_000 });
  await expect(modal.locator(".vault-ai-status")).toHaveText("Done. On this device. Nothing changes until you pick an action.");
  await page.evaluate(() => ((window as any).__stubDelay = 5));
  expect(await editorValue(page)).toBe(note);
  await modal.getByRole("button", { name: "Insert at top" }).click();
  expect(await editorValue(page)).toBe(`> [!summary]\n> * The garden needs tomatoes\n> * Plant in May\n\n${note}`);
  await page.keyboard.press(`${MOD}+z`);
  expect(await editorValue(page)).toBe(note);
  const call = await page.evaluate(() => (window as any).__stubCalls.at(-1));
  expect(call).toMatchObject({ provider: "stub", feature: "tools", task: { kind: "summarize", type: "key-points", length: "medium" } });

  // Translate the selection.
  await setSelection(page, 2, 0, 2, 35);
  expect(await command(page, "ai-tools:translate")).toBe(true);
  await modal.locator("select.vault-ai-target-language").selectOption("fr");
  await modal.getByRole("button", { name: "Translate" }).click();
  await expect(modal.locator(".vault-ai-output")).toHaveText("[fr] We plant tomatoes and basil in May.");
  await modal.getByRole("button", { name: "Replace selection" }).click();
  expect((await editorValue(page)).split("\n")[2]).toBe("[fr] We plant tomatoes and basil in May.");

  // Rewrite, proofread (diff), write.
  await setSelection(page, 3, 0, 3, 35);
  expect(await command(page, "ai-tools:rewrite")).toBe(true);
  await expect(modal.locator(".vault-ai-output")).toHaveText("A shorter version.");
  await modal.getByRole("button", { name: "Insert below" }).click();
  await setSelection(page, 3, 0, 3, 35);
  expect(await command(page, "ai-tools:proofread")).toBe(true);
  await expect(modal.locator(".vault-ai-output ins")).toHaveCount(2);
  await modal.getByRole("button", { name: "Accept corrections" }).click();
  expect((await editorValue(page)).split("\n")[3]).toBe("I will receive the seeds on Friday.");
  await page.evaluate(() => (window as any).app.workspace.activeEditor.editor.setCursor({ line: 0, ch: 0 }));
  expect(await command(page, "ai-tools:write")).toBe(true);
  await modal.locator("textarea.vault-ai-write-request").fill("an intro");
  await modal.getByRole("button", { name: "Write", exact: true }).click();
  await expect(modal.locator(".vault-ai-output")).toHaveText("Written: an intro");
  await modal.getByRole("button", { name: "Insert at cursor" }).click();
  expect(await editorValue(page)).toMatch(/^Written: an intro# Garden plan/);

  // Detect language → notice.
  expect(await command(page, "ai-tools:detect-language")).toBe(true);
  await expect(page.locator(".notice").filter({ hasText: "Detected German (de)" })).toBeVisible();

  // Ask about this note: streamed answer grounded on the note, with where it ran.
  expect(await command(page, "ai-tools:ask-note")).toBe(true);
  const pane = page.locator(".vault-ai-chat");
  await expect(pane.locator(".vault-ai-chat-context")).toContainText("Garden plan");
  await expect(pane.locator(".vault-ai-chat-context .vault-ai-engine")).toHaveText("On this device");
  await pane.locator("textarea").fill("When?");
  await pane.locator("textarea").press("Enter");
  await expect(pane.locator(".vault-ai-chat-message.mod-assistant")).toHaveText("Answer from Garden plan to: When?");
  const chatCall = await page.evaluate(() => (window as any).__stubCalls.at(-1));
  expect(chatCall.feature).toBe("chat");
  expect(chatCall.system).toContain("I will receive the seeds on Friday.");

  // Turning AI off hides the commands.
  await page.evaluate(() => (window as any).app.ai.configure({ enabled: false }));
  expect(await page.evaluate(() => {
    const c = (window as any).app.commands;
    return ["ai-tools:summarize", "ai-tools:ask-note"].map((id) => c.isAvailable(c.findCommand(id)));
  })).toEqual([false, false]);
  await expect(pane.locator(".vault-ai-chat-unavailable")).toContainText("No AI engine is set up for Chat");
});

test("Settings → AI renders at 1440 and 390 px, with downloads listed and deletable", async ({ page }) => {
  await offline(page);
  await page.addInitScript(noBuiltinAi);
  await page.addInitScript(stubHook, { route: "stub", consent: "grant" });
  await openDemo(page);
  await page.evaluate(async () => {
    const ai = (window as any).app.ai;
    ai.configure({ routes: { chat: { generate: "cloudstub" }, transcribe: { transcribe: "transformers" }, related: { embed: "transformers" } }, providers: { anthropic: { enabled: true }, cloudstub: { enabled: true } } });
    // A downloaded embedding model in Cache Storage, as transformers.js stores it.
    const cache = await caches.open("transformers-cache");
    await cache.put("https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/onnx/model_quantized.onnx", new Response(new Uint8Array(2048), { headers: { "content-length": "118308185" } }));
    await cache.put("https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/tokenizer.json", new Response("{}", { headers: { "content-length": "17082660" } }));
  });
  await openSettingsTab(page, "ai");
  const content = page.locator(".vertical-tab-content");
  await expect(page.locator(".vault-ai-feature")).toHaveCount(8);
  await expect(page.locator(".vault-ai-summary")).toHaveClass(/mod-sends/);
  await expect(page.locator(".vault-ai-summary")).toContainText("Chat: sent to Cloud Stub, when you use it.");
  await expect(page.locator(".vault-ai-summary")).toContainText("Model downloads (once, from Hugging Face, after you agree)");
  await expect(page.locator('.vault-ai-provider[data-provider="transformers"] .vault-ai-provider-status')).toContainText("Embeddings: Xenova/multilingual-e5-small on WebAssembly, downloaded.");
  const dl = page.locator('.vault-ai-download[data-model="Xenova/multilingual-e5-small"]');
  await expect(dl).toContainText("129.1 MB · 2 files");
  // Nothing to download now → embedding consent does not ask.
  expect(await page.evaluate(() => (window as any).app.ai.getProvider("transformers").pendingDownload("embed", {}))).toBeNull();

  await shots(page, "settings-ai-1440", ".modal.mod-settings");
  await content.evaluate((el) => (el.parentElement!.scrollTop = 900));
  await shots(page, "settings-ai-1440-engines", ".modal.mod-settings");
  await content.evaluate((el) => (el.parentElement!.scrollTop = 99999));
  await shots(page, "settings-ai-1440-downloads", ".modal.mod-settings");

  await dl.getByRole("button", { name: "Delete" }).click();
  await page.locator(".modal.mod-confirmation").getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".vault-ai-download-empty")).toBeVisible();
  expect(await page.evaluate(async () => (await (await caches.open("transformers-cache")).keys()).length)).toBe(0);
  expect(await page.evaluate(async () => (await (window as any).app.ai.getProvider("transformers").pendingDownload("embed", {}))?.bytes)).toBe(118308185 + 17 * 1024 * 1024 + 27 * 1024 * 1024);

  // Phone width: nothing overflows horizontally.
  await page.evaluate(() => (window as any).app.setting.close());
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettingsTab(page, "ai");
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => {
    const el = document.querySelector(".vertical-tab-content") as HTMLElement;
    const wide = [...el.querySelectorAll<HTMLElement>(".vault-ai-feature, .vault-ai-provider, .vault-ai-summary")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).map((e) => e.className);
    return { scroll: el.scrollWidth - el.clientWidth, wide };
  });
  expect(overflow).toEqual({ scroll: 0, wide: [] });
  await shots(page, "settings-ai-390");
});

test("real transformers.js embedding in headless Chromium (opt-in, downloads ~135 MB)", async ({ page }) => {
  test.skip(!process.env.AI_REAL_SMOKE, "set AI_REAL_SMOKE=1 to run");
  test.setTimeout(600_000);
  const hosts = new Set<string>();
  page.context().on("request", (r) => {
    const u = new URL(r.url());
    if (/^https?:$/.test(u.protocol) && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") hosts.add(u.hostname);
  });
  await page.addInitScript(noBuiltinAi);
  await page.addInitScript(() => ((window as any).__openmarkdownAiTest = { consent: "grant" }));
  await openDemo(page);
  const r = await page.evaluate(async () => {
    const ai = (window as any).app.ai;
    ai.configure({ enabled: true, features: { related: true } });
    const t0 = performance.now();
    const docs = await ai.embed({ feature: "related", kind: "document", texts: ["Tomatoes need full sun and warm soil.", "Die Steuererklärung ist bis Juli fällig."] });
    const q = await ai.embed({ feature: "related", kind: "query", texts: ["Wann muss ich meine Steuern abgeben?"] });
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);
    return { ms: Math.round(performance.now() - t0), dims: docs.dims, model: docs.model, engine: docs.engine, simGarden: dot(q.vectors[0], docs.vectors[0]), simTax: dot(q.vectors[0], docs.vectors[1]) };
  });
  console.log("real embedding smoke", r);
  expect(r.dims).toBe(384);
  expect(r.engine.location).toBe("device");
  expect(r.simTax).toBeGreaterThan(r.simGarden);
  // Only Hugging Face (and the storage it redirects to): the ONNX runtime comes from this app, not a CDN.
  console.log("hosts contacted", [...hosts]);
  expect([...hosts].filter((h) => !/(^|\.)(huggingface\.co|hf\.co)$/.test(h))).toEqual([]);
});
