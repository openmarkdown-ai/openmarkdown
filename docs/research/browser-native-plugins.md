# Browser-native plugins: what OpenMarkdown should build in

Researched 2026-09-14. Question: which popular Obsidian community plugins exist because Obsidian is an Electron desktop app without a browser's capabilities, or can be done better by a browser app? And which should OpenMarkdown ship as first-party features?

Sources:
- `obsidianmd/obsidian-releases` `community-plugins.json` (7,639 plugins) and `community-plugin-stats.json` (7,612 entries), fetched today. Every download number below is the `downloads` field from the stats file.
- `manifest.json` from the default branch (`HEAD`) of each of the top 600 repos, for `isDesktopOnly`.
- The public README, docs and source of each candidate plugin.
- CORS probes: curl from origin `https://openmarkdown.app`, run today (§2).
- No part of the Obsidian app was inspected.

## TL;DR

- **91 of the top 600 plugins are desktop-only** (11,331,517 downloads), so OpenMarkdown refuses them. That is 11 of the top 100 and 56 of the top 400. About 25 of them are desktop-only only because they need something the browser already has:
  - **reveal.js** (Advanced Slides runs a local HTTP server just to show it)
  - **print CSS** (Better Export PDF uses Electron `printToPDF`)
  - **pandoc**, which now ships as a WebAssembly build (Pandoc, Enhancing Export)
  - **fetch** and **the File System Access API** (Local Images Plus, Local Backup)
  - **iframes** and **HTML media** (Media Extended, Timestamp Notes, Media Notes, Surfing)
  - **a file read** (Citations, Kindle's `My Clippings.txt`)
- **Most network plugins that aren't desktop-only already work.** OpenAI, Anthropic (with its browser header), Gemini, Dropbox, Google Drive, Microsoft Graph, the GitHub REST API, Readwise, Raindrop, Zotero's web API, LanguageTool, Wikipedia, OpenStreetMap tiles and YouTube/Vimeo oEmbed all send CORS headers (§2).
- **Arbitrary web pages, RSS feeds, Google ICS feeds, git smart-HTTP and DeepL do not send CORS headers.** Plugins that read them (link titles, feeds, calendars, Git) need the companion bridge.
- **A browser can do things Electron Obsidian never exposed.** Built-in AI (Translator, Language Detector and Summarizer are stable since Chrome 138; the Prompt API is stable on the web since Chrome 148), Web Speech (speech-to-text and text-to-speech), the Web Share Target, the Notification API with service workers, Document Picture-in-Picture and the Media Session API. Each maps onto a popular plugin category (TTS, Whisper, Translate, Copilot, ReadItLater, Reminder).
- **Build in the 15 features in §5.** Each one keeps the markdown the popular plugin writes, so notes stay portable between OpenMarkdown, Obsidian and the plugin. Each also stands down when that plugin is installed and enabled.

## 1. Why these plugins exist

| Cause | Examples | What OpenMarkdown has instead |
|---|---|---|
| Electron/Node API used for something the web platform does | Advanced Slides (local `http` server), Better Export PDF (`printToPDF`), Local Images Plus (Node fs), Local Backup (fs + archivers), Media Extended (`<webview>` for YouTube/bilibili), Surfing (`<webview>`) | iframes, `window.print` + `@page`, `fetch`, File System Access, OPFS, `CompressionStream` |
| Native binary on `PATH` | Pandoc, Enhancing Export | `pandoc.wasm` (59,163,604 bytes, served at `pandoc.org/app/pandoc.wasm`, last modified 2026-08-29; npm `pandoc-wasm` 1.1.0) |
| Local desktop app on localhost | Zotero Integration (Better BibTeX :23119), Image auto upload (PicGo), Flashcards (AnkiConnect) | The companion extension already holds `http://localhost/*` and `http://127.0.0.1/*` host permission |
| Obsidian never exposed the capability | TTS, Whisper, Translate, Reminder (system notifications are Electron-only: `src/plugin/ui/system-notification.ts`), Tray (global quick note), Second Window | Web Speech, Translator API, Notification API + service worker, installed-PWA window, `window.open`, Document PiP |
| Needs a network path CORS blocks | Auto Link Title, RSS Dashboard, ICS, Obsidian Git remotes, YTranscript | Companion network bridge (`FetchRequest` in `packages/app/src/companion/protocol.ts`) |
| Spawns a process | Claudian, Agent Client, Terminal, Shell commands, Execute Code, Open in VS Code | Nothing: out of reach by design |

## 2. CORS, measured today

`ACAO` means the `access-control-allow-origin` header on the response (curl, origin `https://openmarkdown.app`, preflight and GET).

| Works direct (ACAO present) | Blocked (needs bridge) |
|---|---|
| `youtube.com/oembed`, `vimeo.com/api/oembed.json`, `noembed.com`, `api.microlink.io` | Arbitrary HTML pages (e.g. `github.com/...`) |
| `api.github.com` | git smart-HTTP (`github.com/*.git/info/refs`) |
| `api.openai.com`, `api.anthropic.com` (preflight allows `anthropic-dangerous-direct-browser-access`), `generativelanguage.googleapis.com` | `api-free.deepl.com` |
| `api.dropboxapi.com`, `www.googleapis.com` (Drive, Books), `graph.microsoft.com` | `calendar.google.com/.../basic.ics` |
| `readwise.io/api`, `api.raindrop.io`, `api.hypothes.is`, `api.zotero.org`, `openlibrary.org` | RSS (`feeds.bbci.co.uk`, `hnrss.org`) |
| `api.languagetool.org`, `en.wikipedia.org/w/api.php?origin=*` | `icons.duckduckgo.com` favicons (fine as `<img>`, not as `fetch`) |
| `tile.openstreetmap.org`, `nominatim.openstreetmap.org` | `share.note.sx` (root; API not probed) |
| Image CDNs: `upload.wikimedia.org`, `images.unsplash.com`, `i.ytimg.com`, `avatars.githubusercontent.com`, `pbs.twimg.com`, `obsidian.md/images` | Anything that 403s without a referrer (e.g. `cdn.sanity.io` sample) |

Consequence: a built-in feature should **try a direct request first, then use the bridge, then degrade** with a stated reason. It should never fail silently.

## 3. Ranked table

Columns:
- **DO**: `isDesktopOnly` in the repo manifest (Y means currently refused).
- **Bridge**: whether the companion network bridge is needed.
- **Rec**:
  - **BUILD-IN**: a first-party feature (§5 item number in brackets).
  - **KEEP**: keep it as a plugin. It works today or should; "untested" means outside the 25 compat scenarios.
  - **SKIP**: don't build it, and it can't work here.

Effort: S ≤ 3 days, M ≤ 2 weeks, L > 2 weeks.

| # | Plugin (id) | Downloads | DO | What users use it for | Native browser approach | Bridge | Effort | Rec |
|---|---|---:|:-:|---|---|---|:-:|---|
| 6 | Git (`obsidian-git`) | 3,139,721 | N | Versioned backup to a remote | isomorphic-git already in plugin; host needs a `Buffer` global (compat doc) | Yes for git smart-HTTP | S (polyfill) | KEEP + host fix; REST alternative in [13] |
| 10 | Remotely Save | 2,229,260 | N | Sync via S3/WebDAV/Dropbox/OneDrive/Drive | Dropbox/Drive/Graph have CORS; S3/WebDAV need server CORS | Partial | – | KEEP |
| 13 | Claudian (`realclaudian`) | 2,104,168 | Y | Claude Code CLI inside vault | Needs process spawn | – | – | SKIP (see [10]) |
| 14 | Copilot | 1,886,085 | N | AI chat / agents, BYO key | Provider APIs have CORS | No | – | KEEP; no-key path in [10] |
| 16 | Omnisearch | 1,875,036 | N | Ranked search incl. PDFs/OCR | Works (8/8); OCR through Text Extractor API shim | No | – | KEEP; feed it via [7] |
| 22 | Smart Connections | 1,199,725 | N | Related notes via local embeddings | Works (4/4); model from HF CDN | No | – | KEEP |
| 29 | Self-hosted LiveSync | 931,938 | N | CouchDB / WebRTC sync | Server-side CORS config; WebRTC native | No | – | KEEP (untested) |
| 33 | Advanced Slides | 836,818 | **Y** | reveal.js decks from notes, speaker view, export | reveal.js (MIT) in page; speaker view in `window.open` | No | M | **BUILD-IN [5]** |
| 35 | PDF++ | 791,420 | N | Annotate PDFs by linking selections | Depends on Obsidian PDF-viewer internals, not a browser gap | No | L | KEEP (untested) |
| 37 | Local REST API with MCP | 724,142 | **Y** | Scripts/agents read & write vault | A page cannot listen on a port; WebMCP (`navigator.modelContext`, early preview) or a native host | – | M | SKIP now; watch WebMCP |
| 40 | Advanced URI | 649,949 | N | URI automation | `web+obsidian://` + `registerObsidianProtocolHandler` (`settings/uri.ts`) | No | – | KEEP |
| 43 | Annotator | 596,796 | N | PDF/EPUB annotation (hypothes.is client) | iframe; hypothes.is API has CORS | No | – | KEEP (untested) |
| 48 | Text Generator | 581,980 | N | LLM generation, BYO key | CORS OK | No | – | KEEP |
| 49 | Zotero Integration | 556,487 | **Y** | Citations, bibliographies, PDF annotations from Zotero | Zotero web API (CORS) or local API via bridge | Local only | M | **BUILD-IN [6]** |
| 50 | Pandoc Plugin | 552,826 | **Y** | Export DOCX/EPUB/LaTeX/PPTX | `pandoc.wasm`, lazy-loaded | No | M | **BUILD-IN [4]** |
| 52 | Image Converter | 526,693 | N | Compress/resize/annotate images | Canvas / OffscreenCanvas | No | – | KEEP (untested) |
| 55 | Paste URL into selection | 495,016 | N | Paste URL over text → link | Core already links a selection (`editor/input.ts`); add nothing-selected modes | No | S | **BUILD-IN [1]** |
| 57 | Full Calendar | 461,232 | N | Calendar of event notes + ICS/CalDAV | Works locally; remote ICS/CalDAV blocked | Yes (remote) | – | KEEP; feeds in [14] |
| 61 | Enhancing Export | 448,964 | **Y** | Pandoc export presets (Hugo, LaTeX, DOCX) | `pandoc.wasm` | No | M | **BUILD-IN [4]** |
| 64 | Terminal | 419,099 | N | Shell in a pane | No process access | – | – | SKIP |
| 65 | Auto Link Title | 382,106 | N | Paste URL → `[page title](url)` | oEmbed (CORS) → bridge fetch `<title>`/`og:title` | Yes (most sites) | S | **BUILD-IN [1]** |
| 66 | Media Extended | 379,513 | **Y** | Video/audio notes, timestamp links, screenshots, transcripts | YouTube IFrame API, Vimeo Player, `<video>`, Media Session, Document PiP, canvas frame grab | oEmbed direct; transcripts bridge | M–L | **BUILD-IN [2]** |
| 78 | Reminder | 332,681 | N | `(@2021-08-14 09:37)` TODO reminders | Notification API + service worker `showNotification` with actions | No | M | **BUILD-IN [14]** |
| 79 | Better Export PDF | 332,536 | **Y** | PDF with page numbers, margins, header/footer, multi-file | `@page` margin boxes (Chrome 131+), print dialog | No | S–M | **BUILD-IN [4]** |
| 81 | Text Extractor | 328,064 | N | OCR of images/PDFs, API for Omnisearch (fails on mobile; unmaintained) | Tesseract.js (Apache-2.0) wasm in a worker; PDF.js text layer | No (self-host traineddata) | M | **BUILD-IN [7]** |
| 85 | LanguageTool Integration | 311,924 | N | Grammar check | `api.languagetool.org` CORS `*` | No | – | KEEP |
| 86 | Leaflet | 311,029 | N | Interactive maps | OSM tiles CORS | No | – | KEEP |
| 91 | Custom Frames | 269,253 | N | Web apps (Keep, Calendar, Todoist, Notion) as panes | iframe; most presets send XFO/`frame-ancestors`, so extension `declarativeNetRequest` strips them for app-initiated sub-frames | New bridge rule | M | **BUILD-IN [11]** |
| 92 | Agent Client | 263,765 | Y | ACP agents via CLI | Process spawn | – | – | SKIP |
| 94 | Readwise Official | 243,466 | N | Highlights sync | CORS OK | No | – | KEEP |
| 97 | Citations | 235,637 | **Y** | Literature notes from `.bib`/CSL-JSON | Read the export file from the vault or a remembered file handle | No | S | **BUILD-IN [6]** |
| 100 | Book Search | 231,203 | N | Book metadata notes | Google Books/Open Library CORS | No | – | KEEP |
| 108 | Diagrams (draw.io) | 214,638 | Y | draw.io diagrams | embed.diagrams.net `?embed=1&proto=json` or self-hosted drawio (Apache-2.0) | No | M | BUILD-IN (next tier) |
| 115 | Excel to Markdown Table | 202,563 | N | Paste spreadsheet cells as table | Clipboard `text/html` table → existing HTML→MD; TSV fallback | No | S | BUILD-IN [1] (verify core covers) |
| 116 | Relay | 202,482 | N | Real-time collaboration | WebSocket/Yjs | No | – | KEEP (untested) |
| 117 | Google Calendar | 198,532 | N | Google Calendar via OAuth | googleapis CORS | No | – | KEEP |
| 118 | Weread | 196,667 | N | Tencent WeRead highlights (cookie login) | Extension reads session | Yes | M | SKIP (after Kindle) |
| 123 | Meld Encrypt | 186,408 | N | Encrypt notes/sections | WebCrypto | No | – | KEEP |
| 129 | Google Drive Sync | 174,385 | N | Vault in Drive | Drive API CORS | No | – | KEEP |
| 132 | Map View | 167,524 | N | Geo notes on a map, GPS | Leaflet, Geolocation API | No | – | KEEP |
| 134 | Mousewheel Image zoom | 166,893 | Y | Wheel-zoom images | CSS transform | No | S | BUILD-IN (next tier) |
| 135 | Kindle Highlights | 166,493 | **Y** | Highlights via Amazon login or `My Clippings.txt` | File parse; cloud via extension on `read.amazon.com/notebook` in user's session | Cloud only | S (file), M (cloud) | **BUILD-IN [12]** |
| 140 | Execute Code | 161,852 | Y | Run code blocks | Sandboxed iframe JS, Pyodide | No | M | SKIP (Code Emitter runs in sandbox) |
| 141 | Local Images Plus | 160,562 | **Y** | Download remote images into vault | `fetch` (many CDNs CORS `*`), bridge fallback | Fallback | S | **BUILD-IN [3]** |
| 148 | Webpage HTML Export | 153,253 | Y | Vault → static site with search/graph | Core `publish` + `vault-publish` already | No | – | BUILD-IN (exists; parity gaps) |
| 159 | RSS Dashboard | 139,360 | N | RSS/YouTube/podcast reader | Feeds lack CORS | Yes | – | KEEP (bridge) |
| 163 | Image auto upload | 136,292 | N | Upload via PicGo localhost | Bridge has localhost permission | Yes | – | KEEP |
| 165 | ReadItLater | 135,210 | N | URL → templated note, share-menu capture (image download desktop-only) | `vault-clip` extraction + Web Share Target | Yes | M | **BUILD-IN [12]** |
| 166 | Omnivore | 133,434 | N | Omnivore sync | Service shut down (Nov 2024) | – | – | SKIP |
| 167 | Image Toolkit | 132,300 | Y | Lightbox zoom/rotate/flip/copy | Extend `audio-recorder/lightbox.ts` | No | S | BUILD-IN (next tier) |
| 174 | Surfing | 118,890 | **Y** | Browse web in panes, search selection, bookmarklet | Core `webviewer` + search-selection + `web-open` URI | Frames rule | S | **BUILD-IN [11]** |
| 176 | Harper | 114,780 | N | Local grammar (wasm) | Works as-is | No | – | KEEP |
| 180 | Docxer | 113,008 | N | Preview/convert `.docx` | mammoth/docx-preview in page | No | – | KEEP |
| 181 | Share Note | 112,889 | N | Encrypted public share via note.sx | Their server | ? | – | KEEP (untested) |
| 189 | Convert url to preview (iframe) | 108,019 | N | URL → iframe | Part of external embeds | No | S | BUILD-IN [2] |
| 190 | Link Embed | 107,211 | N | `embed` code-block link previews | Render block; metadata via bridge | Yes | S | BUILD-IN [1] |
| 192 | Actions URI | 101,599 | N | x-callback-url | `web+obsidian` | No | – | KEEP (untested) |
| 195 | Local GPT | 98,387 | N | Ollama on localhost | `OLLAMA_ORIGINS` or bridge | Maybe | – | KEEP |
| 200 | Shell commands | 94,311 | Y | Run system commands | – | – | – | SKIP |
| 206 | Digital Garden | 90,818 | N | Publish via GitHub | GitHub API CORS | No | – | KEEP |
| 208 | Local Backup | 88,929 | **Y** | Interval zip backups with retention | File System Access dir handle + `publish/zip.ts`; OPFS fallback | No | S | **BUILD-IN [13]** |
| 209 | Pandoc Reference List | 87,756 | Y | Sidebar of formatted citekeys | citeproc-js on CSL-JSON | No | S | BUILD-IN [6] |
| 224 | Auto Card Link | 79,022 | N | `cardlink` code-block cards | Render block; metadata via bridge | Yes | S | BUILD-IN [1] |
| 225 | Claude Sidebar | 78,413 | Y | Claude Code in sidebar | Process spawn | – | – | SKIP |
| 231 | Clipper | 76,215 | N | Web highlight capture | `apps/clipper` already | – | – | KEEP (companion covers) |
| 233 | Translate | 75,014 | N | Translate selection/notes via 10 services | Translator + LanguageDetector API (Chrome 138+) | No (DeepL needs bridge) | S | **BUILD-IN [9]** |
| 235 | ZotLit | 74,378 | Y | Zotero literature notes | as [6] | Local only | – | BUILD-IN [6] |
| 269 | Export Image | 65,992 | N | Note → PNG | DOM → SVG foreignObject → canvas | No | – | KEEP (untested) |
| 274 | Link Favicons | 65,180 | N | Favicons beside external links | Bridge-fetched icon cache; opt-in icon service | Yes | S | BUILD-IN [1] |
| 276 | PodNotes | 64,614 | N | Podcast player + timestamps | Feeds lack CORS | Yes | – | KEEP (bridge) |
| 283 | Fit | 62,773 | N | GitHub sync without git | GitHub REST CORS | No | – | KEEP; see [13] |
| 291 | Language Translator | 60,129 | N | Translate selection | as [9] | No | S | BUILD-IN [9] |
| 307 | Whisper | 56,269 | N | Dictation → OpenAI Whisper API | Web Speech `SpeechRecognition`; local Whisper (WebGPU) | No | M | **BUILD-IN [8]** |
| 313 | Open Gate | 53,929 | – | Embed websites | as [11] | Frames rule | – | BUILD-IN [11] |
| 318 | YTranscript | 53,144 | N | Insert YouTube transcript with timestamps | Transcript endpoints lack CORS | Yes | S | BUILD-IN [2] |
| 319 | Copy as HTML | 52,886 | N | Copy selection as HTML | `ClipboardItem` `text/html` | No | S | BUILD-IN [4] |
| 328 | GitHub Sync | 51,085 | Y | Vault → GitHub | GitHub REST (CORS) | No | M | BUILD-IN [13] |
| 333 | Telegram Sync | 49,594 | Y | Telegram messages → notes | Needs an always-on poller | – | – | SKIP |
| 345 | Print | 47,616 | N | Print notes | `window.print` (core export PDF) | No | – | BUILD-IN (exists) |
| 347 | Text to Speech | 47,087 | N | Read notes aloud (OS voices) | `speechSynthesis` | No | S | **BUILD-IN [8]** |
| 354 | Diagrams.net | 45,453 | Y | draw.io embedded editor | as #108 | No | M | BUILD-IN (next tier) |
| 356 | Tray | 45,239 | Y | Global quick-note window | Installed-PWA window / Document PiP (no global hotkey) | No | M | BUILD-IN [15] |
| 359 | Slides Extended | 44,921 | Y | Fork of Advanced Slides | as [5] | No | – | BUILD-IN [5] |
| 360 | Local images | 44,488 | Y | Download remote images | as [3] | Fallback | – | BUILD-IN [3] |
| 363 | Epub Importer | 43,798 | Y | EPUB → Markdown | zip + `vault-clip` HTML→MD | No | S | BUILD-IN (importer) |
| 378 | Copy document as HTML | 41,433 | Y | Paste notes into Gmail with images | `ClipboardItem` with inlined data URIs | No | S | BUILD-IN [4] |
| 395 | Voice | 38,714 | N | Cloud TTS audiobook player | Cloud providers, BYO key | Varies | – | KEEP; local TTS in [8] |
| 398 | Second Window | 38,209 | Y | Notes/images in new windows | `window.open` same-origin + `activeWindow`/`activeDocument` API | No | M | BUILD-IN [15] |
| 441 | Edge TTS | 32,929 | N | Microsoft neural voices | Edge's `speechSynthesis` already exposes them | No | – | KEEP; [8] covers Edge |
| 444 | Transcription | 32,801 | N | Transcribe linked audio | Local Whisper | No | M | BUILD-IN [8] |
| 449 | Rich Links | 32,312 | N | URL → rich preview | as [1] | Yes | – | BUILD-IN [1] |
| 459 | QuickShare | 31,331 | N | E2E-encrypted share link | Their server | ? | – | KEEP |
| 460 | Simple RSS | 31,131 | N | RSS → notes | Feeds lack CORS | Yes | – | KEEP (bridge) |
| 463 | ICS Calendar | 31,063 | N | ICS events into daily notes | ICS parse; Google ICS lacks CORS | Yes | M | **BUILD-IN [14]** |
| 466 | Search on Internet | 30,908 | Y | Search note title/selection on web | webviewer search | No | S | BUILD-IN [11] |
| 482 | Audio Notes | 29,036 | N | Transcripts while listening | as [8] | No | – | BUILD-IN [8] |
| 494 | Taskbone | 27,388 | N | OCR text + equations | as [7] | No | – | BUILD-IN [7] |
| 499 | Thumbnails | 27,002 | N | YouTube thumbnails | `i.ytimg.com` CORS | No | S | BUILD-IN [2] |
| 504 | Slurp | 26,284 | N | Web page → clean Markdown | `vault-clip` | Yes | – | BUILD-IN [12] |
| 507 | Timestamp Notes | 26,021 | Y | Side-by-side video + timestamps | as [2] | No | – | BUILD-IN [2] |
| 508 | Media Notes | 26,006 | Y | `media_link` note + `[02:01]()` timestamps | as [2] | No | – | BUILD-IN [2] |
| 588 | Marp | 20,265 | Y | Marp decks | `@marp-team/marp-core` (MIT) in page | No | S | BUILD-IN [5] (optional) |
| 615 | Scribe | 19,103 | N | Record → transcribe → summarize | [8] + [10] | No | – | BUILD-IN [8] |
| 634 | iCal | 18,193 | N | Tasks with dates → `.ics` | Generate ICS file in vault | No | S | BUILD-IN [14] |
| 700 | Camera | 16,067 | N | Photo/video into vault | `getUserMedia` + `MediaRecorder` | No | S | BUILD-IN (next tier) |
| 787 | Latex OCR | 13,725 | N | Image → LaTeX | ONNX model on WebGPU | No | L | SKIP for now |
| 841 | QR Code Generator | 12,672 | N | QR codes of notes/links | JS encoder; `BarcodeDetector` for scanning | No | S | SKIP (low demand) |

### Other desktop-only plugins in the top 600

These set `isDesktopOnly` but their READMEs describe no Node or Electron need. The reasons are unverified:
- Image Toolkit (132,300), Mousewheel Image zoom (166,893)
- cMenu (238,679), Quick Explorer (163,951), Pane Relief (162,681)
- Simple CanvaSearch (114,123), Icons (109,513), Editor Width Slider (86,678), Completr (85,846)
- Extended Graph (70,880), Status Bar Pomodoro (66,169)
- Theme Picker (40,599), MySnippets (39,771), ProZen (37,265)

**Host recommendation:** add a per-plugin "Load anyway (desktop-only)" override in Community plugins.
- It should be off by default, and turning it on should show a warning.
- If the plugin touches `require("electron")`, `require("fs")` or `process`, the load should fail with a clear notice.
- It would be a cheap robustness win, independent of §5.

## 4. Browser support used by §5 (as of Sept 2026; "verify" = check at build time)

| API | Chromium (Chrome/Edge) | Firefox | Safari |
|---|---|---|---|
| `speechSynthesis` | Yes (Edge adds MS neural voices) | Yes | Yes |
| `SpeechRecognition` | Yes; server-based by default, `processLocally`/`available()`/`install()` for on-device (MDN) | No | Yes (`webkitSpeechRecognition`) |
| Translator, LanguageDetector, Summarizer | Chrome 138+ desktop (developer.chrome.com, today) | No | No |
| Prompt API (web) | Chrome 148+ stable; Proofreader origin trial; Writer/Rewriter dev trial | No | No |
| WebGPU (local Whisper, OCR models) | Yes | Windows shipped; others verify | Safari 26 |
| Notification + SW `showNotification` actions | Yes (actions yes) | Yes (no actions) | macOS yes; iOS 16.4+ home-screen apps only; no actions |
| Web Share (`navigator.share`) / Share Target (manifest) | Share: yes; Target: installed PWA on Android, ChromeOS (Windows: verify) | Share: Android only; Target: no | Share: yes; Target: no |
| Document Picture-in-Picture | Desktop 116+ | No | No |
| `window.open` same-origin window | Yes | Yes | Yes |
| `ClipboardItem` `text/html` write | Yes | Yes | Yes |
| `@page` margin boxes (page numbers) | 131+ | No | No |
| `showSaveFilePicker` / directory handles | Desktop | No (download fallback) | No (download fallback) |
| Media Session, `getUserMedia`, `CompressionStream`, WebCrypto | Yes | Yes | Yes |
| Extension `declarativeNetRequest` `modifyHeaders` | Yes (MV3) | Yes | Partial |
| 3rd-party cookies in iframes (logged-in frames) | Allowed by default | Partitioned | Blocked |
| Private/Local Network Access prompt for localhost fetch | Prompt in recent Chrome (verify version) | – | – |

## 5. Top recommendations: build these in

The same rules apply to every item:

1. **It is a core plugin.** It lives under `packages/app/src/core-plugins/<id>/`, can be toggled in Settings → Core plugins, and its command ids are `<id>:<command>`.
2. **It defers to the community plugin.**
   - When the listed community plugin is installed and enabled, the core feature turns off its overlapping handlers (paste, drop, code-block processors, commands). Its settings page then says "Handled by <plugin>".
   - On first enable, it offers "Import settings from <plugin>". This reads `.obsidian/plugins/<plugin-id>/data.json` and maps the fields listed below.
3. **It keeps the plugin's markdown.** Notes written by the plugin render and behave the same, and notes written by the core feature render in Obsidian when the plugin is installed there.
4. **Network is direct → bridge → degrade.** It tries a direct `fetch` first (§2), then `getRequestTransport()`. Otherwise it shows a Notice naming what is missing ("Install the companion extension to fetch page titles"). No third-party metadata service is used unless the user enables it.
5. **Browser APIs are feature-detected.** Unavailable commands are hidden (`checkCallback` returns false), not failing. The settings page shows one line on what the browser lacks.

### [1] Smart paste: link titles, link cards, favicons
Replaces Auto Link Title (382,106), Paste URL into selection (495,016), Link Embed (107,211), Auto Card Link (79,022), Link Favicons (65,180), Rich Links (32,312), Excel to Markdown Table (202,563). Core id `smart-paste`. Effort S–M.

**Paste and drop behaviour:**

| Clipboard | Context | Result |
|---|---|---|
| URL | Selection | `[selection](url)`. This exists in `editor/input.ts`. For hosts in "Image embed hosts" it writes `![selection](url)` instead. |
| URL | No selection, "Fetch title on paste" on | Insert `[Fetching Title#<4 chars>](url)` immediately, then replace the placeholder with the title. If the placeholder was edited away, do nothing. |
| URL | Cursor inside `[..](` or after `"`/`'`, image URL (`\.(gif\|jpe?g\|tiff?\|png\|webp\|bmp\|tga\|psd\|ai)$`), or blocklisted host | Paste as-is. A blocklisted host gets `[hostname](url)`. |
| HTML table / TSV from a spreadsheet | Any | GFM table. |
| Mod+Shift+V | Any | Plain paste (exists). |

**Title resolution:**
1. YouTube/Vimeo oEmbed `title` (direct CORS).
2. Bridge GET: `og:title`, then `<title>`, then `no-title` attribute; reuse `webviewer/save.ts` parsing. A non-HTML content-type gives the last URL path segment.
3. Opt-in microlink.
4. On failure, leave `<url>` and show a Notice.

The title is escaped exactly as Auto Link Title does it (`* _ \` | < > ~ \ [ ]` backslash-escaped) and truncated to "Maximum title length" plus `...`.

**Commands:**
- `smart-paste:paste-with-title` ("Paste URL and fetch title").
- `smart-paste:enhance-url` ("Add title to link under cursor"), default Mod+Shift+E. It turns a bare URL into `[title](url)` and replaces the title of an existing `[x](url)`.
- `smart-paste:create-card` ("Convert link to card"), which writes a `cardlink` block.
- `smart-paste:copy-as-plain-url`.

**Settings, with import from `obsidian-auto-link-title` / `url-into-selection` data.json:**

| Setting | Default | Imports from |
|---|---|---|
| Fetch title on paste | on | `enhanceDefaultPaste` |
| Fetch title on drop | on | `enhanceDropEvents` |
| Keep selection as title | off | `shouldPreserveSelectionAsTitle` |
| Maximum title length | 0 | `maximumTitleLength` |
| Hosts that never fetch (one per line) | – | `websiteBlacklist` |
| When pasting a URL with nothing selected | Fetch title | `nothingSelected`: 0 Paste as-is · 1 Select word · 2 `[](url)` · 3 `<url>` |
| Image embed hosts | – | `listForImgEmbed` |
| Show favicons on external links | **off** | – |
| Favicon source | Bridge | Bridge / DuckDuckGo icon service (warns that it leaks hostnames) |
| Use microlink.io when the bridge is missing | **off** | – |

**Cards:** render these two code blocks read-only in Reading view and Live Preview. The layout is a card with image right, title, description, host + favicon, and a click opens the url. Remote images load as `<img>`, which needs no CORS.
- ` ```cardlink ` (YAML keys `url` required, `title` required, `description`, `host`, `favicon`, `image`, which may be `"[[local.png]]"`).
- ` ```embed ` (Link Embed keys `title`, `image`, `description`, `url`, `favicon`, `aspectRatio`, `metadata`, `parser`, `date`, `custom_date`).

`[text|nofavicon](url)` suppresses the favicon, as Link Embed does. Favicons are cached in IndexedDB by host for 30 days.

### [2] Media: external embeds, media player, timestamp links, transcripts
Replaces Media Extended (379,513, desktop-only), Timestamp Notes (26,021, desktop-only), Media Notes (26,006, desktop-only), Convert url to preview (108,019), YTranscript (53,144), Thumbnails (27,002). Core id `media`. Effort M–L.

1. **Embeds (Obsidian core parity; missing today).**
   - `![](https://www.youtube.com/watch?v=ID)`, `youtu.be/ID`, `/shorts/ID` and `![](https://vimeo.com/N)` render an iframe. Use `youtube-nocookie.com/embed/ID?enablejsapi=1`, with `start` taken from `t=`/`#t=`.
   - `![](https://twitter.com|x.com/.../status/N)` renders the tweet embed.
   - Size uses the image alt rules (`![|640x360](url)`).
   - Direct media URLs (`.mp4 .webm .mp3 .m4a .ogg .wav`) render `<video>`/`<audio>`.
2. **Media fragments on embeds and links**, parsed as Media Extended does (`#t=` plus `&loop&mute&play&noctrl&controls&vol=0-100`).
   - `t` accepts `S[.ms]`, `MM:SS[.ms]`, `H:MM:SS[.ms]`, a range `start,end` or `,end`, with `e` meaning end.
   - This applies to web URLs and to `![[clip.mp4#t=1:23,1:45]]`.
3. **Player view** (`media:player`). It opens beside the note with one shared player. Pinning the tab keeps it as the target for timestamp commands.
   - Sources: YouTube IFrame Player API, Vimeo Player API, HTML media.
   - Media Session metadata and controls.
   - "Pop out" uses Document PiP where available, otherwise [15].
4. **Timestamp links, written in Media Extended's exact format:**
   - Web: `[01:23](https://www.youtube.com/watch?v=ID#t=01:23.47)`.
     - Link text is `HH:mm:ss` with a leading `00:` removed.
     - The fragment is `t=<h>:<mm>:<ss.ff>`, `t=<mm>:<ss.ff>` or `t=<ss.ff>`.
   - Vault file: `app.fileManager.generateMarkdownLink(file, notePath, "#t=01:23.47", "01:23")` with any leading `!` stripped, so it follows the wikilink setting.
   - Inserted with template `\n- {{TIMESTAMP}} ` and offset 0 s. Both are settings, imported from Media Extended's `timestampTemplate`, `timestampOffset` and `insertBefore`.
   - Clicking a timestamp link seeks the shared player, opening it if needed. Media Notes' `[02:01]()` empty-target links seek the player of the note's `media_link` property.
5. **Commands:**
   - `media:open` (URL or vault file prompt)
   - `media:take-timestamp`
   - `media:play-pause`
   - `media:seek-back-5` / `media:seek-forward-5` (seconds are a setting)
   - `media:speed-up` / `media:speed-down` (0.1 step) / `media:speed-reset`
   - `media:save-screenshot`. It works for vault/direct media only, because a cross-origin iframe cannot be drawn to canvas; the command is hidden for YouTube.
     - It saves `webp` to the attachment folder.
     - It inserts `\n- !{{SCREENSHOT}} {{TIMESTAMP}} ` (Media Extended's default).
   - `media:insert-transcript`. It inserts a YouTube transcript as `[mm:ss](url#t=…) text` lines, grouping lines every N (default 32, as YTranscript). YouTube transcript endpoints need the bridge.
   - `media:open-subtitles`. Sidecar `.srt`/`.vtt` next to vault media shows as a clickable, searchable transcript panel.
6. **URI:** `web+obsidian://mx-open?url=<encoded>` opens the player, mirroring Media Extended's `obsidian://mx-open`.
7. **Privacy:** YouTube/Vimeo embeds load third-party frames only when the note is rendered. Offer a "Click to load embeds" setting, off by default.

### [3] Download remote attachments
Replaces Local Images Plus (160,562, desktop-only), Local images (44,488, desktop-only), and ReadItLater's desktop-only image download. Core id `localize-attachments`. Effort S.

**Commands:**
- `localize-attachments:current-file`: "Download remote images in this note".
- `localize-attachments:all-files`: "Download remote images in all notes". It confirms "N links in M notes", respects the Include glob, and shows progress with a cancel button.

**Setting "Download on paste"** (off). After an HTML paste or a URL paste resolves to `![...](http…)`, process just the inserted range.

**Finding links:**
- Matches `![alt](http…)`, `![alt|300](http…)` and `<img src="http…">` in HTML blocks.
- Also matches `data:` image URIs (written out as files).
- Skips code spans and blocks.

**Fetching:**
- Order is direct `fetch`, then bridge. Content-type decides the extension.
- Max size is a setting (default 25 MB).
- Name: `<first 16 hex of SHA-256>.<ext>`. An existing identical file is reused (dedup).
- Saved via `app.fileManager.getAvailablePathForAttachment` (Obsidian's attachment-folder setting).

**Rewriting links:**
- Format follows "Use [[Wikilinks]]": `![[a1b2….png|300]]` or `![alt|300](path)`, preserving the size and the alt text where the syntax allows.
- All rewrites in one note are a single editor transaction (one undo). Notes that are not open use `vault.process`.

**Failures:** the report modal lists URL, status and reason (e.g. "blocked by CORS, companion not installed").

### [4] Export: DOCX/EPUB/LaTeX via pandoc.wasm, better PDF, copy as rich text
Replaces Pandoc Plugin (552,826, desktop-only), Enhancing Export (448,964, desktop-only), Better Export PDF (332,536, desktop-only), Copy as HTML (52,886), Copy document as HTML (41,433, desktop-only). Extends core `publish`. Effort M.

**Commands:**
- `publish:export-docx`, `publish:export-epub`, `publish:export-odt`, `publish:export-latex`, `publish:export-pptx`. These match the Pandoc plugin's format set.
- `publish:export-pandoc` ("Export with pandoc…"): picks any output format and takes extra args.
- `publish:copy-rich-text`: selection, else whole note.

**Pandoc pipeline:**
1. Resolve the note to portable Markdown with the `vault-publish` transforms: wikilinks become relative links, embeds are inlined, callouts become blockquote divs, `%%comments%%` are stripped, Dataview output is rendered to static Markdown where the view is open.
2. Mount the note and its attachments in the wasm FS.
3. Run `pandoc -f markdown+wikilinks_title_after_pipe -t <fmt> --resource-path=<embed dirs> [--reference-doc]`.
4. Save next to the note (Pandoc plugin default), or via `showSaveFilePicker` / a download when "Ask where to save" is on.

**Pandoc settings:**
- Reference doc path in the vault, default `.obsidian/pandoc/reference.docx` if present.
- Extra args.
- Custom presets with Enhancing Export's variables (`${outputPath}`, `${outputDir}`, `${outputFileName}`, `${currentPath}`, `${currentDir}`, `${currentFileName}`, `${vaultDir}`, `${attachmentFolderPath}`, `${embedDirs}`, `${metadata.<key>}`). Only pandoc args are accepted, not shell.

**pandoc.wasm:**
- It is **GPL-2.0-or-later**. Do not bundle it with the MIT/Apache app.
- Fetch it on first use, after a consent dialog showing its size (≈59 MB), from a pinned version, and verify SHA-256.
- Cache it in the Cache Storage API. The core plugin stays licence-clean because it only invokes the separate binary.

**PDF (extend the `workspace:export-pdf` modal):**
- Page size, margins, "Include page numbers", header and footer text.
- Header/footer map Better Export PDF's frontmatter `headerTemplate`/`footerTemplate`. Their `<span class="pageNumber|totalPages|title|date">` become `@page` margin-box `content` (`counter(page)`, `counter(pages)`, strings). Margin boxes take text only, and only Chromium supports them; elsewhere the options are hidden.
- "Export folder as one PDF" concatenates notes with `break-before: page`.
- The print dialog cannot be told to write PDF bookmarks; say so in the modal.

**Copy as rich text:**
- Render as in Reading view.
- Inline vault images and `<img>` as data URIs (remote via direct/bridge fetch). Rasterise Mermaid/math SVG to PNG for Gmail.
- Apply a small inline stylesheet (setting) and write `ClipboardItem({"text/html", "text/plain"})`.

### [5] Presentations compatible with Advanced Slides
Replaces Advanced Slides (836,818, desktop-only because it runs a local server on port 3000), Slides Extended (44,921, desktop-only), Marp (20,265, desktop-only). Extends core `slides`. Effort M.

**Detection:** a note is an Advanced Slides deck if its frontmatter has any of the keys below, or if it uses `<!-- slide` / `<!-- element` annotations or `note:` lines. Otherwise the current core Slides behaviour stays.

**Syntax, all of it Advanced Slides' own:**
- Separators: `separator` (default `^( ?| )---( ?| )$`), `verticalSeparator` (default `^( ?| )--( ?| )$`), `notesSeparator` (default `note:`).
- `<!-- slide bg="…" data-background-opacity="0.5" … -->`, where `bg` accepts a colour, a URL or `[[image.jpg]]`.
- `<!-- element class="fragment fade-up" data-fragment-index="1" style="…" -->` applies attributes to the preceding element.
- Frontmatter: `theme` (default black), `highlightTheme` (zenburn), `width` 960, `height` 700, `margin` 0.04, `minScale`, `maxScale`, `controls`, `controlsLayout`, `progress`, `slideNumber`, `overview`, `center`, `loop`, `rtl`, `shuffle`, `fragments`, `showNotes`, `transition`, `css`, `enableLinks`, `enableChalkboard`, `enableOverview`.
- Layout tags `<split>` and `<grid>` are phase 2.

**Rendering:** reveal.js (MIT) in page. Slide content goes through `MarkdownRenderer`, so callouts, embeds, math, Mermaid and Excalidraw work.

**Commands:**
- `slides:start` (exists)
- `slides:preview`: a live preview in a split that follows the cursor's slide.
- `slides:speaker-view`: reveal notes plugin in `window.open`; the same-origin window gets live sync via BroadcastChannel.
- `slides:export-html`: zip of `index.html`, reveal assets and attachments, built on `publish/zip.ts`.
- `slides:export-pdf`: reveal `?print-pdf` layout + `window.print`.

**Optional:** the frontmatter `marp: true` renders with `@marp-team/marp-core` (MIT), lazy-loaded.

### [6] Citations and Zotero
Replaces Zotero Integration (556,487, desktop-only), Citations (235,637, desktop-only), Pandoc Reference List (87,756, desktop-only), ZotLit (74,378, desktop-only). Core id `citations`. Effort M.

**Sources:**
- **Bibliography file:** a `.bib` or CSL-JSON file in the vault (setting "Bibliography file", as Citations' "Citation export path"). It re-reads on `vault.on("modify")`, so Better BibTeX "Keep updated" into the vault folder just works.
- **Zotero web API:** user ID + API key, stored in the keychain settings tab. `api.zotero.org` has CORS, so it works on every device.
- **Zotero desktop:** the Zotero 7 local API at `http://localhost:23119/api/` through the bridge (localhost permission already granted), for collections and annotations without a key.

**Commands and hotkeys (Citations' hotkeys; no default binding where they would collide with core):**
- `citations:open-literature-note`, Ctrl/Cmd+Shift+O in Citations.
- `citations:insert-link`, Ctrl/Cmd+Shift+E in Citations; conflicts with [1], so leave it unbound.
- `citations:insert-content`.
- `citations:insert-citation`, which writes the Pandoc citation `[@citekey]`; the format is a template setting.
- `citations:insert-bibliography`: citeproc-js with a CSL style (default APA), rendered as Markdown.

**Templates** use Citations' variables: `{{citekey}} {{abstract}} {{authorString}} {{containerTitle}} {{DOI}} {{eprint}} {{eprinttype}} {{eventPlace}} {{page}} {{publisher}} {{publisherPlace}} {{title}} {{titleShort}} {{URL}} {{year}} {{zoteroSelectURI}}`. The literature note title template defaults to `@{{citekey}}` and the folder is a setting. Import settings from `obsidian-citation-plugin`.

**Sidebar `citations:references`:** formatted references for every `[@key]` in the active note, as Pandoc Reference List does. Hovering a citekey shows the reference.

**Annotations (Zotero API/local):** "Import annotations" writes highlight quotes as `> text` with `zotero://open-pdf/library/items/<key>?page=<p>` links.

### [7] OCR and text extraction, with the Text Extractor API
Replaces Text Extractor (328,064; unmaintained, fails on mobile), Taskbone (27,388). Core id `text-extractor`. Effort M.

**Engines:**
- Images (`png jpg jpeg webp gif bmp`): Tesseract.js (Apache-2.0) in a Worker, with `traineddata` self-hosted in the app bundle. There is no jsDelivr fetch; the privacy story matches "no server".
- PDFs: PDF.js `getTextContent`, falling back to OCR of rendered pages when a page has no text layer.
- `.docx`: mammoth raw text.

**Languages** are a multi-select setting (default: UI language + English). Data downloads per language on selection.

**API compatibility, which is the point.** Expose the same object at `app.plugins.plugins["text-extractor"].api`:
```ts
{ extractText(file: TFile): Promise<string>; canFileBeExtracted(path: string): boolean; isInCache(file: TFile): Promise<boolean> }
```
Omnisearch and others then pick it up unmodified. When the real plugin is installed and enabled, the real one wins.

**Cache:** IndexedDB keyed by path + mtime + size. Option "Store cache in vault" writes `.obsidian/text-extractor-cache/<hash>.json` so other devices reuse results.

**Commands:**
- `text-extractor:copy-text` (image/PDF under cursor or active file)
- `text-extractor:extract-to-note`: creates `<name> (text).md` with an embed of the source plus the text.
- File-menu "Extract text".

**Core search** matches extracted text when "Search inside images and PDFs" is on (off by default, CPU cost).

### [8] Voice: read aloud, dictation, transcription
Replaces Text to Speech (47,087), Whisper (56,269), Transcription (32,801), Audio Notes (29,036), Scribe (19,103). Voice (38,714) and Edge TTS (32,929) stay as plugins for cloud voices. Core id `voice`. Effort S (TTS) + M (STT).

**Read aloud (`speechSynthesis`):**
- Commands: `voice:read-note`, `voice:read-selection`, `voice:pause-resume`, `voice:stop`.
- Status-bar play/pause item.
- It skips frontmatter, code blocks and `%%comments%%`. Links read their display text.
- Language comes from the frontmatter `lang: <ISO 639-1>` (Text to Speech's convention). Otherwise it comes from LanguageDetector when available, otherwise the UI language.
- Settings: voice per language, rate, pitch.
- The spoken sentence is highlighted using `boundary` events, and Media Session controls work.
- Plugin API: `app.plugins.plugins.tts`-style `say(title, text, lang?)`, `pause()`, `resume()`, `stop()`, `isSpeaking()`, `isPaused()`, matching Text to Speech's published `TTSService`.

**Dictation:** `voice:dictate` toggles, with no default hotkey (Whisper uses Alt+Q; users rebind).
- Engine order, with the choice in settings:
  1. Web Speech on-device (`processLocally = true`, `SpeechRecognition.install()`).
  2. Local Whisper (transformers.js on WebGPU; port the solved code from `openapps/opensubs` and its four known defects).
  3. Web Speech server-based. It is off by default, and the setting says audio goes to the browser vendor.
- Interim text shows as a ghost widget; final text is inserted at the cursor.

**Transcribe:** `voice:transcribe-file` and a file-menu item on audio/video. It is also on the core Audio recorder's saved recording.
- Output uses Whisper plugin template variables `{{title}} {{audioFile}} {{transcription}} {{date}} {{time}} {{datetime}}`.
- Default: insert at cursor.
- "Create note file" option with the template.
- Segments are written as Media-Extended timestamp links (`[01:23](<audio link>#t=01:23.00) text`), so clicking plays from there via [2].

**URI:** `web+obsidian://whisper?command=start|stop|pause|cancel`, matching the Whisper plugin's.

### [9] Translation and language detection
Replaces Translate (75,014), Language Translator (60,129), DeepL (22,264), Translator (15,974). Core id `translate`. Effort S.

**Engine:** Chrome Translator + LanguageDetector APIs (stable 138+, desktop). Model download progress comes from `monitor` `downloadprogress`. Elsewhere, commands are hidden unless the user sets a BYO service: DeepL via the bridge, or LibreTranslate URL with CORS.

**Commands:**
- `translate:selection`: a modal with target language, preview, and **Replace / Insert below / Copy**.
- `translate:note`: creates `<name> (<lang>).md`, keeping frontmatter keys, translating only string values listed in the setting "Translate properties" (default `title, description`), and preserving code, links, math and embeds by translating per text node of the rendered Markdown AST.
- `translate:detect-language`: sets the `lang` property.

**Settings:** default target language, "Show translate in selection context menu" (on).

### [10] On-device AI writing actions
A no-key, no-server alternative to the basic uses of Copilot (1,886,085), Text Generator (581,980), Smart Composer (172,734), ChatGPT MD (139,964). Those plugins stay supported for BYO-key power users. Core id `ai`. Effort M.

**Engines, feature-detected:**
- Summarizer (138+).
- Prompt API `LanguageModel` (web 148+).
- Proofreader (origin trial; register the OT token for the app origin).
- Writer/Rewriter when shipped.

Hardware limits apply (Gemini Nano: desktop only, large disk and GPU/RAM requirements). Settings show availability via `availability()` and a "Download model" button.

**Commands:**
- `ai:summarize-note`: inserts `> [!summary]` callout at top. Types `key-points|tldr|teaser|headline` come from the Summarizer `type` option.
- `ai:rewrite-selection`: shorter / longer / more formal / more casual, with a preview diff and Accept/Discard.
- `ai:proofread`: underlines corrections as CodeMirror diagnostics, each with a quick-fix.
- `ai:ask-note`: side panel chat grounded on the active note plus linked notes (Prompt API, context trimmed to model quota).
- `ai:suggest-tags` / `ai:suggest-title`: writes to properties after confirmation.

**Rules:**
- No network ever.
- Output never auto-applies.
- Every insertion is one undo step.

### [11] Web panes: frames, presets, search
Replaces Custom Frames (269,253), Surfing (118,890, desktop-only), Open Gate (53,929), Search on Internet (30,908, desktop-only). Extends core `webviewer`. Effort M.

**Extension frame rule.** Add `declarativeNetRequest` to the companion.
- The dynamic rule removes `x-frame-options` and `content-security-policy` response headers for `resourceTypes: ["sub_frame"]` and `initiatorDomains: [app origin]`, only for hosts in the user's "Allow framing" list.
- Adding a host requires an explicit confirmation naming the clickjacking trade-off.
- `webviewer/view.ts` keeps its clear refusal message when no rule applies.
- Logged-in frames only work where third-party cookies are allowed; see §4.

**Frames:**
- Setting "Frames": name, URL, icon, custom CSS applied by the extension via `scripting.insertCSS` into that frame, "Open in sidebar", "Add ribbon icon".
- Presets copied from Custom Frames' list: Google Keep, Google Calendar, Todoist, Notion, Twitter, Readwise Daily Review.
- Command per frame: `webviewer:open-frame-<name>`.
- Render Custom Frames' block ` ```custom-frames ` with `frame:`, `style:`, `urlSuffix:`.

**Search:**
- `webviewer:search-selection` in the editor context menu.
- `webviewer:search-note-title`.

**URI:** `web+obsidian://web-open?url=<url>`, as Surfing. It opens in the web viewer, with a copyable bookmarklet in settings.

### [12] Capture in: share target, clipboard URL to note, Kindle
Replaces ReadItLater (135,210), Slurp (26,284), Kindle Highlights (166,493, desktop-only). Core id `capture`. Effort S–M.

**Web Share Target** in `apps/web/public/manifest.webmanifest`:
```json
"share_target": { "action": "./?share-target", "method": "POST", "enctype": "multipart/form-data",
  "params": { "title": "title", "text": "text", "url": "url", "files": [{ "name": "files", "accept": ["image/*", "application/pdf", "text/*", "audio/*"] }] } }
```
- The service worker stashes the POST in IndexedDB and redirects to `./?share-target=<id>`.
- The app opens a "Save to vault" sheet with vault, folder, "Create note / Append to daily note", and template.
- Where Share Target is unsupported, the sheet explains using the companion extension instead.

**`capture:create-from-clipboard` (ReadItLater's command name "Create from clipboard"):**
- A URL is fetched via bridge → `vault-clip` readable extraction → template. YouTube/Vimeo use oEmbed + [2] embeds. Plain text becomes a snippet note.
- `capture:batch-from-clipboard` handles one URL per line.
- `capture:insert-at-cursor` inserts the content instead of creating a note.
- Template variables are ReadItLater's for articles: `{{articleTitle}} {{articleURL}} {{articleReadingTime}} {{articleContent}} {{date}} {{previewURL}} {{publishedTime}}`. Settings "Inbox dir" and "Assets dir" accept `{{date}} {{fileName}} {{contentType}}`. Images go through [3].

**Kindle** (Importer entry "Kindle"):
- `My Clippings.txt` file: parse highlights, notes and bookmarks per book, de-duplicated by location.
- "Amazon Kindle notebook (via companion)": the extension opens `read.amazon.<region>/notebook` in the user's own session and scrapes the highlight list. No credentials pass through OpenMarkdown.
- Output: one note per book. The frontmatter uses Kindle Highlights' template variable names (`title`, `author`, `publicationDate`, `lastAnnotatedDate`, `authorUrl`, …). Take the exact property set from its default template before implementing.
- Highlights are `> text` blocks with `location` and optional `note`.
- Re-import appends only new highlights, matched by location.

### [13] Backups and GitHub sync without git
Replaces Local Backup (88,929, desktop-only), GitHub Sync (51,085, desktop-only). Fit (62,773) and GitHub Gitless Sync (18,203) already work. Core ids `backup`, `github-sync`. Effort S (backup) + M (sync). Coordinate with `openapps/opensync` before writing a sync engine.

**Backup:**
- Commands: `backup:create-now`, `backup:create-named` (kept forever, as Local Backup's specific backup), `backup:restore` (pick a zip and a folder, dry-run list first).
- Settings:

| Setting | Default |
|---|---|
| Backup folder | A directory handle (Chromium); OPFS elsewhere, with "Download latest backup" |
| Interval | Minutes, 0 = off; recommend ≥ 10 |
| Backup on open | – |
| Keep last N | 10 |
| Include / exclude | Comma-separated globs, Local Backup semantics; default exclude `.git, .trash` |

- File name: `<vault>-<YYYYMMDDHHmmss>.zip`, streamed through `publish/zip.ts`, with a Web Lock so two tabs never back up at once.

**GitHub sync:**
- Setup: repo, branch, fine-grained token (keychain).
- Pull: `GET /repos/{o}/{r}/git/trees/{branch}?recursive=1` compared by blob SHA with a local index.
- Push: create blobs → tree → commit → update ref. `api.github.com` has CORS, so there is no git smart-HTTP and no bridge.
- A conflict writes `<name> (conflict <device> <date>).md`.
- Commands: `github-sync:sync`, `github-sync:pull`, `github-sync:push`. Auto-sync interval setting.

**Host fix:** the `Buffer` polyfill for Obsidian Git (compat doc).

### [14] Reminders and calendar feeds
Replaces Reminder (332,681; its system notifications are Electron-only), ICS Calendar (31,063), iCal (18,193). Full Calendar remote sources (461,232) keep working. Core id `reminders`. Effort M. Reuse the RRULE/VTIMEZONE code in `openapps/openweeks`.

**Reminder syntax** (read and write exactly as the Reminder plugin):
- `- [ ] task (@YYYY-MM-DD)` and `(@YYYY-MM-DD HH:mm)`.
- Also read Tasks `📅 YYYY-MM-DD` and Kanban `@{YYYY-MM-DD}`.
- Checked items never fire.
- Settings: default time for date-only reminders (09:00), "Remind me later" presets (import from Reminder's settings), "Also use Tasks due dates" (off).

**Notifications:**
- Uses service worker `showNotification`. Actions are "Mark as done" (writes `[x]`, plus Tasks' `✅ date` when a Tasks marker is present) and "Remind me later".
- Browsers without actions get a click to open the note plus an in-app modal.
- Limitation, stated in settings: reminders fire only while an OpenMarkdown tab or installed window is open. There is no push server by design.

**Export:** `reminders:export-ics` writes `Reminders.ics` (VTODO/VEVENT + VALARM) to the vault. The OS calendar can subscribe to that synced file, so alarms fire when the app is closed.

**Calendar feeds** (`reminders:import-events`, ICS plugin behaviour):
- Setting "Calendars": name, ICS URL (direct fetch → bridge; Google/Outlook secret URLs need the bridge) or vault `.ics` file.
- The command inserts events for the open daily note's date, one line per event as the ICS plugin emits them: `- [ ] <time> <summary> <location>`, as in its README Templater examples. Checkbox, end time and calendar name are per-calendar toggles, so Day Planner parses them.
- Optional Dataview inline start/end fields.
- Expose `getEvents(date)` returning objects with the ICS plugin's field names (`time`, `endTime`, `summary`, `location`, `startDateTime`, `endDateTime`, `utime`, `endUtime`) so Templater scripts written for it keep working.

### [15] Pop-out windows and floating quick capture
Replaces Second Window (38,209, desktop-only) and Tray (45,239, desktop-only). It also fixes the compat gaps "Popout windows fall back to a split" (Kanban) and Excalidraw's always-on-top. Host work in `workspace`. Effort M.

**`workspace:move-to-new-window` / `workspace:open-in-new-window` via `window.open("", "_blank", "popup")`.**
- A same-origin window whose DOM is owned by the main realm.
- Copy `<head>` styles and theme classes into it, then mount a `WorkspaceWindow` there.
- Implement `activeWindow`, `activeDocument`, `el.win`, `el.doc` and `el.instanceOf()` so plugins written for Obsidian popouts work.
- Closing the main tab closes children (`beforeunload`).

**`workspace:quick-capture`:**
- A small always-on-top window via Document Picture-in-Picture (Chromium desktop), else a popup.
- It holds a one-line/multiline editor that appends to the daily note or a chosen note (QuickAdd-compatible target setting), with Mod+Enter to save.
- Installed PWA users get it as a manifest `shortcuts` entry, so it is reachable from the dock/taskbar jump list. A web app cannot register a global hotkey; say so.

## 6. Next tier (build after §5)

| Feature | Replaces | Approach | Effort |
|---|---|---|---|
| draw.io diagrams | Diagrams (214,638, DO), draw.io (52,208, DO), Diagrams.net (45,453, DO) | `.drawio`/`.drawio.svg` view using embed.diagrams.net JSON protocol; offline option self-hosts drawio (Apache-2.0) | M |
| Image viewer zoom/rotate/flip/copy, wheel zoom | Image Toolkit (132,300, DO), Mousewheel Image zoom (166,893, DO) | Extend `audio-recorder/lightbox.ts` | S |
| "Load anyway" for desktop-only plugins | §3 list | Per-plugin override with warning | S |
| Camera / document scan | Camera (16,067) | `getUserMedia`; reuse `openapps/opendocscan` pipeline | S |
| Serverless encrypted share link | Share Note (112,889), QuickShare (31,331) | Compress + AES-GCM note into a static viewer URL `#fragment` (key never sent); size-limited | S–M |
| WebMCP vault tools | Local REST API with MCP (724,142, DO) | Register read/search/append tools via `navigator.modelContext` when present | S (speculative) |
| EPUB import | Epub Importer (43,798, DO) | Importer: zip + `vault-clip` | S |

## 7. Explicitly not built in

**Process-spawning plugins** (Claudian 2,104,168; Agent Client 263,765; Terminal 419,099; Shell commands 94,311; Claude Sidebar 78,413; GitHub Copilot 45,630): a browser cannot run them.

**Plugins that already work through CORS-enabled APIs** (Remotely Save, Copilot, Readwise, LanguageTool, Digital Garden, Meld Encrypt, Map View): building them in adds nothing.

**Plugins that would need an always-on server** (Telegram Sync, email-to-note): they break the zero-server product shape.

**Omnivore:** the service is shut down.

## Appendix: reproduction

```sh
D=<scratch>/research-plugins; mkdir -p $D && cd $D
curl -sSLO https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json
curl -sSLO https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json
# rank by stats[id].downloads; for the top 600 fetch https://raw.githubusercontent.com/<repo>/HEAD/manifest.json and read isDesktopOnly
# CORS: curl -s -o /dev/null -D - -H 'Origin: https://openmarkdown.app' [-X OPTIONS -H 'Access-Control-Request-Method: GET'] <url> | grep -i access-control-allow-origin
```
