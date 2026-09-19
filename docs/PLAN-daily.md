# Plan: robust, browser-native, daily-driver OpenMarkdown

Written 2026-09-14 from five research reports. Read the one(s) named for your
workstream before writing code — they carry the evidence, file:line causes and
detailed specs this plan only points at.

| Report | What it holds |
|---|---|
| `docs/research/web-platform-and-robustness.md` | Web API support table (Part A), data-loss risks with repros and file:line (Part B), 20 prioritised fixes (Part C) |
| `docs/research/daily-use-audit.md` | 33 defects found by using the app (5 data-loss), missing features, what works |
| `docs/research/daily-markdown-users.md` | Forum top requests, table stakes vs Typora/iA Writer/Bear, 25 prioritised features with specs, HAS/PARTIAL/MISSING |
| `docs/research/browser-native-plugins.md` | Plugins that exist because Obsidian is desktop; 15 features to build in, keeping those plugins' Markdown formats |
| `docs/research/opensync-integration.md` | How the OpenSync plugin works, compatibility test, hybrid design, engine changes |

## Principles

1. **No silent data loss, ever.** A save that fails says so and retries; nothing typed is lost to a reload, a second tab, a second pane, an external edit or delete. Workstream W1 lands first in priority, but all streams run in parallel.
2. **Built-in, off-by-default where it replaces a plugin.** A built-in feature that overlaps a popular community plugin keeps that plugin's Markdown output/syntax and settings shape, and **steps aside when that plugin is enabled** (check `app.plugins.enabledPlugins.has(id)`).
3. **Obsidian compatibility is not negotiable.** Obsidian ids, DOM classes and CSS variables (see `docs/AGENT-BRIEF.md`). Never touch `/Applications/Obsidian.app` or its files — ToS forbids reverse engineering; public docs, `obsidian.d.ts` and public plugin source only.
4. **Browser-first means using the platform**, with a working fallback in Firefox/Safari for every Chromium-only API (Part A of the robustness report).
5. **Nothing leaves the machine unless the user asks.** Network features (link titles, embeds, AI via remote models) are opt-in or triggered by a user action, and go through `requestUrl` (which uses the companion extension bridge when present). On-device first.
6. **Heavy things load lazily** (dynamic `import()`); the main bundle may not grow by more than ~150 KB gzip across all streams combined. Big optional downloads (pandoc wasm, tesseract language data, Harper grammar wasm) are fetched on first use after the user agrees, and cached.

## Workstreams and file ownership

Each stream owns its files. **Shared registry files** (listed below) may be edited by anyone, but only with small additive `Edit` calls, re-reading the file immediately before each edit. Anything else outside your list: describe the needed change in your final reply.

Shared registries: `packages/app/src/core-plugins/index.ts`, `packages/app/src/core-plugins/group-*.ts`, `packages/app/src/styles/index.css`, `packages/app/src/obsidian/app.ts` (only to add a field/init line), `packages/app/src/settings/tabs/*` (add rows in your own section), `docs/ARCHITECTURE.md` (append a section), `README.md` (feature table rows).

| Stream | Scope | Owns | Dev port |
|---|---|---|---|
| **W1 Data safety** | Robustness Part C items on saving, conflicts, encoding, multi-tab, multi-pane, external changes, storage | `obsidian/vault/**`, `obsidian/workspace/view.ts`, `obsidian/markdown/markdown-view.ts` (save/load/sync-between-panes parts), `core-plugins/file-recovery/**`, new `obsidian/vault/{journal,merge,tabs,observer}.ts` etc., `styles/safety.css` | 5220 |
| **W2 PWA shell** | Offline app shell + update flow, file handlers/launch queue, share target, protocol/URI handling, quick capture, install prompts, storage persistence prompt, installed-window shortcuts, pop-out windows | `apps/web/**`, `settings/uri.ts`, `boot.ts`, `starter.ts` (W7 adds one entry), new `core-plugins/quick-capture/**`, pop-out code `obsidian/workspace/popout.ts`, `styles/pwa.css` | 5221 |
| **W3 Editor** | Audit editor defects (code fence, Mod+;, Mod+Enter, tables, numbered indent, backspace, `---`, Alt+click, native context menu for spelling, styled find/replace, footnote hover), template command ids; focus + typewriter mode, writing goals + reading time, desktop formatting toolbar, Advanced-Tables-grade tables, smart typography, word completion, optional grammar (Harper) | `packages/app/src/editor/**`, `obsidian/markdown/editor-host.ts`, `core-plugins/markdown-core.ts`, `core-plugins/templates/**`, `core-plugins/word-count/**`, `core-plugins/footnotes/**`, `core-plugins/editor-status/**`, new `core-plugins/{writing-focus,formatting-toolbar,grammar}/**`, `styles/editor.css`, `styles/writing.css` | 5222 |
| **W4 Mobile & workspace** | Phone/tablet layout with Obsidian mobile DOM (`is-mobile`, `is-phone`, drawers, navbar, mobile toolbar above the keyboard via `visualViewport`), touch gestures, cursor/scroll restore after reload, tab/split polish from the audit | `obsidian/workspace/{workspace,leaf,items,base}.ts`, `obsidian/ui/**` (mobile variants), `styles/app.css`, new `styles/mobile.css`, new `obsidian/workspace/mobile/**` | 5223 |
| **W5 Knowledge** | Forum top requests: note title from `title`/H1 (setting), vault-wide search & replace, bulk tag rename + property rename/retype, manual file sort, nested properties display, trash view, periodic notes (weekly/monthly/quarterly/yearly, Periodic Notes-compatible config) + calendar view (Calendar-plugin-compatible), keyboard navigation in search results, duplicate rename notice, natural-language dates | `core-plugins/{file-explorer,global-search,tag-pane,properties,daily-notes,switcher,bookmarks,backlink}/**`, new `core-plugins/{periodic-notes,calendar,trash,natural-dates}/**`, `obsidian/vault/file-manager.ts` **only** for rename notices (coordinate: W1 owns the rest of vault/), `styles/navigation.css`, `styles/knowledge.css` | 5224 |
| **W6a Paste & media** | Smart paste (Auto Link Title `[title](url)`, paste URL into selection, cardlink blocks), YouTube/Vimeo/tweet `![](url)` embeds, media player + Media Extended timestamp links, transcripts, download remote images into the vault (Local Images Plus behaviour) | new `core-plugins/{smart-paste,media,local-images}/**`, `obsidian/markdown/renderer.ts` **only** to add an external-embed hook, `styles/media.css` | 5225 |
| **W6b Export & write-ups** | Copy as rich HTML, DOCX (lazy `docx`-style writer or pandoc wasm on consent) + EPUB, PDF headers/footers/page numbers/TOC, slides with Advanced Slides syntax, citations (.bib/CSL-JSON, Zotero web API, citekey autocomplete, bibliography) | `core-plugins/{publish,slides}/**`, new `core-plugins/{export,citations}/**`, `styles/export.css` | 5226 |
| **W6c Device & AI** | OCR (tesseract.js lazily; expose Text Extractor's API shape), dictation + read aloud (Web Speech; fallback message), translation + language detection + summarise/rewrite/proofread via Chrome built-in AI (feature-detected, clear fallback), reminders (Reminder plugin syntax → Notifications while open, `.ics` export), vault backups (zip snapshots to a folder/OPFS, restore), "Load anyway" for desktop-only plugins whose flag looks unnecessary, Custom Frames presets for the web viewer | new `core-plugins/{ocr,voice,ai-tools,reminders,backup}/**`, `core-plugins/webviewer/**`, `obsidian/app-internals/plugins.ts` (desktop-only override only), `styles/device.css` | 5227 |
| **W7 OpenSync** | Hybrid design from the integration report: engine changes in `../opensync/packages/client` (shared vault sync loop, no HEAD flood, fetch timeouts, live pointer, staged changes, wasm from URL) keeping `opensync/checks` green; hidden core plugin `opensync` in OpenMarkdown using the client **by relative path** (no copy; build without sync if `../opensync` is absent); Settings → Sync, status bar, "Open a synced vault" on the starter, explorer badges, conflict review, Web Locks single syncing tab, keys in IndexedDB wrapped by a non-extractable key; two-context e2e against a local relay. Do not change the hosted relay or `opensync-obsidian`; list follow-ups. | `../opensync/packages/client/**` (not other opensync dirs without need), new `core-plugins/opensync/**`, `apps/web/vite.config.ts` alias lines only, `styles/sync.css` | 5228 |

`packages/app/src/` is implied before `obsidian/`, `core-plugins/`, `styles/`, `settings/`, `editor/`.

## How to work

- **Dev server:** from `apps/web`, `npx vite --port <your port> --strictPort` (background). Never run `vite build` into `apps/web/dist` and never stop the server on :5200 — the integrator builds.
- **Typecheck:** `npx tsc -p packages/app --noEmit` from the repo root. Other streams may be mid-edit; zero errors in *your* files.
- **Tests:** add Playwright specs at `e2e/daily/<stream>.spec.ts` using relative URLs (`/?vault=demo`, or a browser-stored vault created in the test). Run: `OM_URL=http://localhost:<port> npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/<stream>.spec.ts`. Use real keyboard/mouse input for editor behaviour. Every data-loss repro in the research becomes a regression test that failed before your fix.
- **Look at it:** screenshot every UI you add (desktop 1440×900 light + dark; phone 390×844 where relevant), open the screenshots with the Read tool, fix what looks wrong.
- **Rust:** if you need it, `CARGO_TARGET_DIR=/private/tmp/claude-501/-Users-dariuskohsg-Downloads-sharing-folder-openapps-openobsidian/e1a6d318-3001-4922-8817-6fd71c57aee0/scratchpad/target-main`. Rebuilding wasm (`npm run build:wasm`) affects everyone — only if essential, and say so.
- **npm dependencies:** prefer none; otherwise small, MIT/Apache/BSD, lazily imported. Nine streams share one `node_modules`, so serialise installs with a lock: `S=/private/tmp/claude-501/-Users-dariuskohsg-Downloads-sharing-folder-openapps-openobsidian/e1a6d318-3001-4922-8817-6fd71c57aee0/scratchpad; until mkdir $S/npm.lock 2>/dev/null; do perl -e 'select(undef,undef,undef,5)'; done; npm install <pkg> -w @vault/app; rmdir $S/npm.lock` (always remove the lock, even on failure). Check the CodeMirror `overrides` in the root `package.json` still hold afterwards (`npm ls @codemirror/state` shows one version).
- **Don't commit, push, publish or deploy anything.**
- **Final reply** (≤40 lines): what you built (commands/settings users see), tests added and their results, screenshots you checked, known gaps, and any changes you need in files you don't own.

## Decisions already made

- Hosted relay admission is not changed; the Sync UI explains an unadmitted account plainly and supports a self-hosted relay URL.
- `opensync/packages/client` may be refactored so both apps share one sync loop; `opensync-obsidian` is not modified (follow-up listed).
- OpenMarkdown builds without the sync feature when `../opensync` is missing (public clones), rather than vendoring the engine.
- Product name is OpenMarkdown (`packages/app/src/product.ts`).
