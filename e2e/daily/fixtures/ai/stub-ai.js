/*
 * A deterministic stand-in for `app.ai` (packages/app/src/ai/types.ts) for e2e
 * tests: no network, no model. Embeddings are a hashed bag of words, so texts
 * sharing words are similar; generation quotes the first passage it is given
 * and cites passages by their links.
 *
 * Installed by `window.__installAiStub(app, config)`: through the platform's provider
 * registry when `app.ai` exists, else as `app.ai` itself. State in `window.__aiStub`.
 */
(() => {
  const STOP = new Set("a an and are as at be but by for from has have i in is it its of on or that the this to was were will with you your my we our not what which who how does do did about into than then there their them they".split(" "));
  function words(text) {
    return (text.toLowerCase().match(/\p{L}[\p{L}\p{N}]*/gu) || []).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, ""));
  }
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function embedOne(text, dims) {
    const v = new Float32Array(dims);
    for (const w of words(text)) {
      const h = hash(w);
      v[h % dims] += (h >>> 16) & 1 ? 1 : -1;
    }
    let n = 0;
    for (let i = 0; i < dims; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < dims; i++) v[i] /= n;
    return v;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__installAiStub = (app, config = {}) => {
    const cfg = Object.assign({ available: true, dims: 256, model: "stub-bow-256", embedDelay: 0, generateDelay: 10, contextWindow: 4096, location: "device" }, config);
    const state = { cfg, embedCalls: 0, embeddedTexts: 0, generateCalls: 0, lastRequest: null };
    window.__aiStub = state;
    async function embed(req) {
      state.embedCalls++;
      state.embeddedTexts += req.texts.length;
      if (cfg.embedDelay) await sleep(cfg.embedDelay);
      if (req.signal && req.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { vectors: req.texts.map((t) => embedOne(t, cfg.dims)), model: cfg.model, dims: cfg.dims };
    }
    async function generate(req) {
      state.generateCalls++;
      state.lastRequest = { system: req.system, messages: req.messages.map((m) => ({ role: m.role, content: m.content })), maxTokens: req.maxTokens };
      const last = req.messages[req.messages.length - 1].content;
      const passages = [...last.matchAll(/Passage (\d+) — link: \[\[([^\]]+)\]\]\n([^\n]*)/g)];
      let text;
      if (!passages.length) text = "Your notes don't cover that.";
      else {
        const first = passages[0];
        const sentence = first[3].replace(/^#+\s*/, "").split(/(?<=[.!?])\s/)[0];
        text = `From your notes: ${sentence} [[${first[2]}]]`;
        if (passages[1]) text += `\n\nSee also [2] and [[Invented note that does not exist]].`;
      }
      let out = "";
      for (const piece of text.match(/.{1,12}/gs)) {
        if (req.signal && req.signal.aborted) throw new DOMException("Aborted", "AbortError");
        out += piece;
        req.onToken && req.onToken(piece);
        await sleep(cfg.generateDelay);
      }
      return { text: out };
    }

    if (app.ai && typeof app.ai.registerProvider === "function") {
      // The platform's test hook (packages/app/src/ai/index.ts): a stub engine routed for every feature.
      const ai = app.ai;
      ai.testing.reset();
      ai.registerProvider({
        id: "stub",
        label: "Stub",
        location: cfg.location,
        capabilities: ["generate", "embed"],
        model: (cap) => (cap === "embed" ? cfg.model : "stub-writer"),
        embed,
        generate,
      });
      ai.testing.consent = "grant";
      state.setAvailable = (v) => {
        cfg.available = v;
        if (v) ai.testing.routeAll("stub");
        else ai.configure({ enabled: false });
      };
      state.setAvailable(cfg.available);
    } else {
      // Before the platform lands: stand in for `app.ai` itself.
      const listeners = new Set();
      const engine = (cap) => ({ provider: "stub", model: cap === "embed" ? cfg.model : "stub-writer", location: cfg.location, leavesDevice: cfg.location === "cloud", contextWindow: cfg.contextWindow });
      app.ai = {
        isAvailable: (feature, cap) => !!cfg.available && cap !== "transcribe",
        engineFor: (feature, cap) => (cfg.available ? engine(cap) : null),
        ensureConsent: async () => true,
        embed: async (req) => ({ ...(await embed(req)), engine: engine("embed") }),
        generate: async (req) => ({ ...(await generate(req)), engine: engine("generate") }),
        transcribe: async () => {
          throw new Error("Not in the stub.");
        },
        on(name, cb) {
          listeners.add(cb);
          return cb;
        },
        offref(ref) {
          listeners.delete(ref);
        },
      };
      state.setAvailable = (v) => {
        cfg.available = v;
        for (const cb of listeners) cb();
      };
    }
    state.embedForTest = (t) => Array.from(embedOne(t, cfg.dims));
    return state;
  };
})();
