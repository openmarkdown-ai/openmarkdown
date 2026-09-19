# Plan: AI built in

Written 2026-09-17. Nine AI features, one shared service. Read `docs/PLAN-daily.md`
("How to work", principles) and `docs/AGENT-BRIEF.md` first — every rule there still
applies (ownership, dev ports, tests, screenshots, no reverse engineering of the
Obsidian app, no commits).

## Principles for AI

1. **Off by default; one switch, then per feature.** Settings → AI turns AI on; each
   feature is then enabled on its own. Nothing runs, downloads or sends until then.
2. **On-device first.** Every feature works with an on-device engine where one can do the
   job (Chrome built-in models, transformers.js on WebGPU/WASM). Local servers
   (Ollama, LM Studio) and cloud providers (Anthropic, OpenAI, Google) are opt-in.
3. **Say where it runs.** Every result shows its engine ("On this device", "Ollama on
   this computer", "Sent to Anthropic"). The first request that would send text off the
   device, and the first model download (with its size), ask first — through
   `app.ai.ensureConsent`, never ad hoc.
4. **Never write without a preview.** Suggestions are accept/dismiss; generated text,
   queries and reviews are shown before they touch a note, and land as one undo step.
5. **Step aside** for the community plugin a feature replaces (Smart Connections,
   Copilot, Text Generator, Smart Composer, Whisper plugins) while it is enabled.
6. **Keys never in the vault.** API keys live in the app keychain (`app.secretStorage`),
   wrapped by a non-extractable WebCrypto key in IndexedDB — never in `.obsidian/`.
7. **Heavy things lazy.** Model runtimes and weights load on first use; the main bundle
   may grow by at most ~40 KB gzip for all of this. Downloads are cached (Cache Storage)
   and not precached by the service worker (add patterns to `apps/web/precache-plugin.ts`
   `OPTIONAL`).
8. **Tests never need the network or a GPU.** Stub engines in e2e via a test hook
   (`app.ai` provider registry) and `page.route`; at most one opt-in real-model smoke run.

## The contract

`packages/app/src/ai/types.ts` — `AiService`, `AiFeature`, `EngineInfo`, requests and
results, `AiUnavailableError`. **Don't change it without saying so in your final
reply;** additive fields are fine. `app.ai` is the instance.

Before the platform stream lands, other streams code against the interface and test with
a stub: `window.app.ai = <object implementing AiService>` set in `page.addInitScript`
after `app` exists, or via the provider registry once it exists.

## Streams

| Stream | Builds | Owns | Port |
|---|---|---|---|
| **A1 Platform** | `app.ai` service; provider registry; engines: Chrome built-in (move from `core-plugins/ai-tools/engines.ts`), transformers.js (embeddings + Whisper, on WebGPU with WASM fallback, in a worker), Ollama / LM Studio, Anthropic, OpenAI, Google Gemini, OpenAI-compatible; per-feature routing; consent; key storage; Settings → AI (enable, engines with test-connection, keys, per-feature routing table, downloads with sizes and delete); migrate AI tools and Ask-about-note onto it (keep their command ids and existing settings) | `packages/app/src/ai/**` (except `types.ts` additions), `core-plugins/ai-tools/**`, `settings/tabs/ai.ts`, `styles/ai.css` | 5220 |
| **A2 Meaning** | Semantic index (chunk by heading/paragraph, incremental on vault events, IndexedDB per vault keyed by model, top-k in a worker); **Related notes** view; **search by meaning** toggle in Search; **Chat with vault** (retrieval + generation, streaming, citations as `[[note#heading]]` links, "insert into note" with preview, conversation saved as a note on request) | new `core-plugins/semantic/**`, `core-plugins/vault-chat/**`; `core-plugins/global-search/**` only a small hook for the meaning toggle | 5221 |
| **A3 Assist** | Suggestions: links for unlinked mentions and semantically related notes, tags, properties, a title for "Untitled" notes, image alt text — accept/dismiss chips, nothing automatic; **plain-language queries** → Bases filter or Dataview/Tasks query shown and editable before insert; **periodic review** → summary of a week's/month's daily notes into the periodic note with links to source days | new `core-plugins/ai-suggest/**`, `core-plugins/ai-query/**`, `core-plugins/ai-review/**` | 5222 |
| **A4 Audio & clipper** | **Transcribe recordings** (audio recorder files, any audio/video in the vault) with Whisper through `app.ai.transcribe`; transcript note with timestamp links in the media plugin's format that seek the player; **clipper prompt variables** compatible with Obsidian Web Clipper's Interpreter (`{{"prompt"}}` variables and filters, interpreter settings, context), run through the app's `app.ai` when clipping into the app | new `core-plugins/transcribe/**`; `core-plugins/audio-recorder/**` and `core-plugins/media/**` only small hooks; `apps/clipper/**` interpreter parts; `packages/app/src/companion/**` additive protocol | 5223 |
| **A5 Agents (MCP)** | `vault mcp <vault-folder>`: an MCP server over stdio in `crates/vault-cli` — tools for search, read (whole note or section), list, backlinks, outgoing links, tags, properties, create/edit/append, rename with link rewrites, daily note; resources for notes; path confinement to the vault; tests; `docs/mcp.md` with Claude Code / Claude Desktop config | `crates/vault-cli/**`, `docs/mcp.md` | — |

Rust builds currently fail on this Mac until the Xcode licence is accepted
(`sudo xcodebuild -license accept`); A5 writes and tests code once `cargo build` works,
and reports if it is still blocked.

## Memory and processes

The machine ran out of memory once with nine agents. Each stream: one dev server with
HMR off (copy the pattern in `scratchpad/vite.w6a.config.mjs` if present, or pass
`server.hmr=false` via a config), one browser at a time, close contexts, kill your dev
server when done, run Playwright with `--output` in your own scratchpad folder, give
every wait a timeout, run commands in the foreground with the Bash timeout parameter.

## Model and API facts to verify, not assume

Check current docs before coding: transformers.js version and WebGPU support; embedding
model choice (size, licence, multilingual); Whisper model sizes; Chrome built-in AI API
status; Anthropic browser access (`anthropic-dangerous-direct-browser-access` header),
OpenAI / Gemini browser CORS, Ollama `OLLAMA_ORIGINS`; current model ids from each
provider's docs (for Anthropic, the `claude-api` skill). Existing notes:
`~/.claude/projects/-Users-dariuskohsg-Downloads-sharing-folder-openapps/memory/whisper-transformersjs-defects.md`
and `onnx-in-browser-gotchas.md` (solved code in `openapps/opensubs`).
