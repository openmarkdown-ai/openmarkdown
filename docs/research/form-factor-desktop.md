# Should OpenMarkdown ship a desktop app, and how?

Researched 2026-09-17. Sources are linked inline; measurements of this repo were
run today.

## TL;DR

**Yes — one desktop build, and it has to be Electron.**

The only reason to build a desktop app is the one thing a browser cannot be
argued into: **91 of the top 600 community plugins are desktop-only**
(11,331,517 downloads) because they need Node or Electron in the renderer's
reach ([browser-native-plugins.md](browser-native-plugins.md) §TL;DR). Roughly
25 of those are desktop-only for reasons the browser already answers, and that
doc's §5 builds them in. The residual — Claudian (2,104,168), Terminal
(419,099), Local REST API with MCP (724,142), Shell commands (94,311), Agent
Client (263,765), Zotero Integration's PDF pipeline, Templater system commands,
obsidian-git's real `git`, Advanced Slides' express server — all want the same
four things: **spawn a process and stream its stdio, read and write arbitrary
paths, listen on a TCP port, and `require()` whatever they like.**

A Tauri 2 shell can give the first three through Rust IPC. It cannot give the
fourth, and the fourth is the product promise. "Runs unmodified Obsidian
plugins" stops being true the moment a plugin bundle calls
`require('express')`, `require('ws')` or `require('node:dgram')` — and the real
bundles do (§3.2). Electron is the only shell where `window.require` is Node,
which is the exact contract [plugin-compat.md](plugin-compat.md) §1.3 records
Obsidian honouring.

Electron also removes a second risk that is easy to underprice: **our app and
every community plugin and theme are Chromium-targeted**. Tauri would put
macOS and Linux users on WKWebView and WebKitGTK, where our own File System
Access, `FileSystemObserver`, Document Picture-in-Picture, `@page` margin-box
PDF export and Chrome built-in AI code paths all fall away, and where 7,736
plugins and 753 themes have never been tested by anyone.

The cost is real and should be stated plainly. Measured today from their own
release feeds: Obsidian ships a 217.8 MB macOS `.dmg` and a 315.7 MB Windows
`.exe`; Joplin 197 MB / 344 MB; Logseq 161 MB; Zettlr 183 MB; Anytype 275 MB.
The one neighbour that ships Tauri — `openmarkdown.dev` — ships a 12.7 MB
`.dmg` and a 4.0 MB `.exe`, and has no plugin ecosystem at all. On top of the
download: an Apple Developer membership ($99/yr), a Windows signing
arrangement, a second CI matrix, and a build in which arbitrary plugin code has
full Node privileges. §5 prices it, §8 states the security consequence.

| Option | Desktop-only plugins | Engine risk | Size | Verdict |
|---|---|---|---|---|
| **Stay browser-only** | Refused, as today | none | 0 MB | Viable, and correct until [browser-native-plugins.md](browser-native-plugins.md) §5's build-ins land |
| **Tauri 2 shell** | Still refused, or an allowlist on a Node emulation we maintain forever | WKWebView + WebKitGTK for 7,736 untested plugins; our own PDF page numbers, Document PiP and on-device AI paths fall away on macOS/Linux | ~15–80 MB | **No.** It costs a second engine and buys nothing the PWA + companion extension does not already do |
| **Electron shell** | All of them, by construction | none (Chromium everywhere) | ~150–250 MB | **Yes**, after the build-ins, and only after a two-week spike proves it |

**Recommendation: build `apps/desktop` as an Electron shell over the existing
`apps/web` bundle, after the build-ins of [browser-native-plugins.md](browser-native-plugins.md) §5 land, and ship it as the second
artefact of the same product — not as a different product.**

---

## 1. What the browser build already is, measured

Sizes are lines of code counted today; `apps/web/dist` is the production build
already on disk.

| Layer | Size | Reused by a desktop shell |
|---|---:|---|
| `crates/*` (Rust, no I/O, native + wasm32) | 76,211 lines | **100 %.** Already compiled natively for `vault-cli`. |
| `packages/engine` (typed TS wrapper over wasm) | 1,933 lines | **100 %**, unchanged (see §7.4 for why it stays wasm). |
| `packages/app` (the `obsidian` module *is* the app) | 105,899 lines | **≈ 99 %.** Five files touch platform gating (below). |
| `apps/web` (Vite PWA entry + service worker) | 341 lines | Entry reused; the service worker is replaced by the shell's updater. |
| `apps/clipper` (MV3 companion extension) | 5,761 lines | Becomes optional — the shell supplies the network bridge. |
| `apps/web/dist` (production build) | 68 MB, 296 files | Shipped as-is inside the app. `main-*.js` is 3.3 MB; the rest is lazy wasm (ONNX 25.6 MB, Harper 15.2 MB, tesseract 3.7 MB, `vault_wasm` 2.9 MB, MathJax 2.2 MB). |

The seams that make a shell cheap already exist, because they were built for
the browser's own variability:

| Seam | File | What a desktop shell does with it |
|---|---|---|
| `VaultAdapter` interface (24 methods) | `packages/app/src/obsidian/vault/adapter.ts` | Add a `NodeAdapter` beside `HandleAdapter`/`MemoryAdapter`. |
| `FileSystemAdapter` / `CapacitorAdapter` stubs, present only so plugins' `instanceof` checks run | `packages/app/src/obsidian/vault/adapter-classes.ts` | Make the desktop adapter a real `FileSystemAdapter` with a real `getBasePath()`, `fs`, `fsPromises`, `path`. 8 of the top 25 bundles read `adapter.basePath`. |
| `RequestTransport` injection (`setRequestTransport`) | `packages/app/src/obsidian/util.ts` | Register a Node-backed transport; `requestUrl` becomes CORS-free, as in Obsidian. |
| `Platform` object with `isDesktopApp: false`, `isWeb: true` | `packages/app/src/obsidian/util.ts` | Flip both. This is the single most consequential line in the project (§3.5). |
| `boot(opts)` | `packages/app/src/boot.ts` | The shell calls the same `boot()` with a desktop vault list. |
| Companion bridge protocol | `packages/app/src/companion/` | The shell answers the same protocol locally, so clip/fetch/framing code is untouched. |

Only **five files** in the whole tree mention `Platform.isDesktopApp`,
`Platform.isWeb`, `supportsFolders` or `showDirectoryPicker`: `boot.ts`,
`starter.ts`, `obsidian/vault/adapter.ts`, `obsidian/app-internals/plugins.ts`,
`core-plugins/backup/store.ts`. `Platform.isDesktopApp` itself is read in
exactly one place (`plugins.ts:165`).

That is the good news. §3.5 is the bad news about the same line.

---

## 2. The shells

### 2.1 Measured, not estimated

Installer sizes below were read from each project's own GitHub release assets
today (`Content-Length` via the GitHub API), not from marketing pages.

| Shell | Engine per OS | Real installer sizes (measured today) |
|---|---|---|
| **Electron 44.4.1** (Chromium 152.0.7977.78, Node 24.21.0 — [releases.electronjs.org](https://releases.electronjs.org/releases.json)) | Chromium + Node, bundled, identical on all three OSes | Obsidian 1.13.7: **217.8 MB** dmg (universal), **315.7 MB** exe, **130.6 MB** AppImage, **102.1 MB** deb. Joplin 3.7.18: 197 MB dmg / 344 MB exe. Logseq 2.0.1: 161 MB arm64 dmg. SiYuan 3.8.4: 242 MB AppImage. Zettlr 4.7.0: 183 MB dmg. Anytype 0.56.9: 262 MB dmg |
| **Tauri 2.11.5** (crate, 2026-07-01; [release index](https://v2.tauri.app/release/)) | WKWebView (macOS), WebView2/Chromium (Windows), WebKitGTK (Linux) — the OS's engine, not bundled | `openmarkdown.dev` v0.13.11 (a Tauri app — its `latest.json` carries `"signature from tauri secret key"`): **12.7 MB** universal dmg, **4.0 MB** NSIS exe, **78.4 MB** AppImage (which has to carry WebKitGTK) |
| *(Tauri, second datapoint)* | as above | Spacedrive `v2.0.0-alpha.2`: 51.7 MB `.exe`, 77.5 MB `.dmg`, **114.5 MB `.deb`** — the Linux number is the tell: WebKitGTK has to be carried |
| **Wails v3** | Same system webviews as Tauri, Go backend | Comparable to Tauri; irrelevant here — it would add Go to a Rust+TS codebase |
| **Neutralino** | Same system webviews, tiny runtime | Smallest of all; no plugin story, no native module story, a much smaller ecosystem. Not a serious candidate for a 108k-line app |
| **Installed PWA** | The user's own browser | **0 MB.** Already shipped |

RAM and startup were not measured here and should be measured in the spike
(§7.6). The public shape of the difference is well known and not in dispute:
Electron carries a Chromium per app, Tauri borrows the OS's.

### 2.2 How the existing web app would be reused

| Shell | Reuse | What changes |
|---|---|---|
| Electron | `apps/web/dist` loaded from disk over a custom protocol; `packages/app` and `packages/engine` untouched | New `apps/desktop` main + preload; `NodeAdapter`; `Platform` flags; service worker replaced by the updater |
| Tauri | Same bundle, loaded over `tauri://` / the asset protocol | Same new adapter work, plus: every Chromium-only code path needs a WebKit fallback (§2.3), and the Node shim (§3.3) |
| Wails / Neutralino | Same | Same as Tauri, with a smaller ecosystem to borrow from |
| PWA | Everything, as today | Nothing. That is the point, and the limit |

### 2.3 The engine question, which is the second decisive one

Our app is not engine-neutral. It was built browser-first *against Chromium*,
and the README already says so ("Real folders need a Chromium browser"). Counting
today's source, these Chromium-only APIs appear in `packages/app`/`apps/web`:

| API | Files using it | Safari/WKWebView | Consequence under Tauri on macOS & Linux |
|---|---:|---|---|
| File System Access (`showDirectoryPicker`) | 3 | ✗ ([caniuse](https://caniuse.com/native-filesystem-api)) | Must be replaced by `tauri-plugin-fs` — fine, and arguably better |
| `FileSystemObserver` | 4 | ✗ ([caniuse](https://caniuse.com/mdn-api_filesystemobserver), Chromium 133+ only) | Replaced by a native watcher — also better |
| Document Picture-in-Picture | 2 | ✗ ([caniuse](https://caniuse.com/mdn-api_documentpictureinpicture); Firefox 151+, Safari never) | Quick capture's floating window and the media pop-out need a native window instead |
| `@page` margin boxes (PDF page numbers/headers) | 1 | ✗ (Chromium 131+ only) | **PDF export loses page numbers, headers and footers on macOS and Linux.** No native replacement in WKWebView |
| Built-in AI: `Summarizer`, `Translator`, `LanguageModel`, `Proofreader` | 3 + 4 + 2 + 2 | ✗ | Settings → AI's whole on-device tier disappears on macOS/Linux |
| `SpeechRecognition.install/available` (on-device dictation) | 1 | partial | Degrades |
| `TextDetector` | 3 | ✗ | Falls back to the Tesseract wasm path (already the fallback) |
| `CompressionStream`, `navigator.locks`, `BroadcastChannel`, `structuredClone`, `:has()`, container queries | 1–6 each | ✓ | Fine |
| WebGL2 graph renderer | 2 | ✓ (and we already fall back to Canvas2D) | Fine |
| WebGPU (local Whisper, ONNX) | 2 | ✓ Safari 26 | Probably fine; unverified in WKWebView-in-Tauri |

The deeper risk is not our code — it is **7,736 community plugins and 753
themes that have only ever run on Chromium**, because Obsidian is Electron and
Obsidian mobile is Chromium on Android / WKWebView only on iOS. Every plugin
that was "desktop-tested" was tested on Chromium. Shipping them on WKWebView or,
worse, on whatever WebKitGTK the user's distro froze, converts our single
compatibility surface into three.

CodeMirror 6 itself is the best-behaved part of this: it is designed for
`contenteditable` across engines and Obsidian mobile already runs it on
WKWebView on iOS (mobile is Capacitor — Obsidian's public API exports a
[`CapacitorAdapter`](https://docs.obsidian.md/Reference/TypeScript+API/CapacitorAdapter)),
so CM6 is not the thing that would break. The CSS, the Chromium-only APIs and
the long tail of plugin assumptions are.

**Tauri documents the Linux problem itself**, which is the most honest source
available: [Linux graphics debugging](https://v2.tauri.app/develop/debug/linux-graphics/)
exists because "on some setups, most often NVIDIA GPUs, WebKitGTK and the
graphics driver disagree and you get anything from a blank window to subtle
rendering problems", with `WEBKIT_DISABLE_DMABUF_RENDERER=1` offered as a fix
"at the cost of the faster rendering path" and
`WEBKIT_DISABLE_COMPOSITING_MODE=1` as a "last resort for the silent crash on
resize" (see also tauri-apps/tauri
[#11076](https://github.com/tauri-apps/tauri/issues/11076),
[#9304](https://github.com/tauri-apps/tauri/issues/9304)). Its
[webview versions table](https://v2.tauri.app/reference/webview-versions/) adds
that macOS WebKit is pinned to the OS's Safari version and unsupported macOS
versions "do not receive WebKit updates", while for Linux "the diverse nature
of the Linux ecosystem means it is very hard to compile accurate information
about WebKitGTK on the various distros". A notes app whose graph view is a
WebGL2 canvas should read that page twice.

### 2.4 Updates, signing, packaging — mechanism per shell

| | Electron | Tauri 2 |
|---|---|---|
| Updater | `electron-updater` or Squirrel against a static feed; Logseq publishes `latest-*.yml` files to GitHub Releases, Obsidian ships a signed `asar.gz` (see §7.5) | `tauri-plugin-updater` against a static `latest.json` with a minisign signature — exactly what `openmarkdown.dev` publishes |
| macOS | Developer ID + hardened runtime + notarisation + stapling | Identical requirements (`openmarkdown.dev`'s release notes: "Developer ID signed + notarized") |
| Windows | Authenticode over the NSIS/Squirrel installer | Identical |
| Linux | AppImage self-updates; deb/rpm do not; Flatpak via Flathub | Identical, plus WebKitGTK version fragmentation |

Nothing about signing or updating discriminates between the shells. Engine
compatibility and Node availability are the only things that do.

---

## 3. The decisive question: desktop-only plugins

This section is the whole decision. Everything in §4 (no CORS, watchers, tray,
MCP, native Rust) can be had from any shell, and most of it can be had with no
shell at all. Only plugin compatibility discriminates between the shells.

### 3.1 What "desktop-only" actually means in the loader

From [plugin-compat.md](plugin-compat.md) §1.3, confirmed against our own
implementation in `packages/app/src/obsidian/app-internals/plugins.ts`:

- `main.js` is CommonJS, evaluated through indirect `eval` with a `require`
  that maps exactly 13 module ids (`obsidian`, the `@codemirror/*` set, the
  `@lezer/*` set) to the host's own instances.
- **Anything else falls through to `window.require(id)` — real Node on
  desktop.** On mobile `window.require` is undefined, so the call returns
  `undefined` and never throws. Our browser build reproduces the mobile
  behaviour exactly (`makeRequire` returns `undefined`), which is why 24 of the
  top 25 plugins load.
- `manifest.isDesktopOnly` is honoured the way mobile honours it: the loader
  refuses to enable the plugin. One line, `plugins.ts:165`:
  `return !!manifest.isDesktopOnly && !Platform.isDesktopApp;`

So "desktop-only" is not a capability list. It is a promise the plugin author
makes that **the whole of Node is present**, and the plugin then uses whatever
part of it the author felt like using.

### 3.2 What real desktop-only plugins actually need

Dependency sets fetched today from each repo's `package.json`. `main.js` is an
esbuild CJS bundle with `external: [...builtinModules, 'electron']`, so pure-JS
dependencies are inlined and **only Node builtins and Electron survive as
`require()` calls** — but the inlined libraries then call those builtins.

| Plugin | Downloads | Inlined libraries | Node/Electron surface they require |
|---|---:|---|---|
| **Claudian** (`realclaudian`, desktop-only) | 2,104,168 | `@anthropic-ai/claude-agent-sdk`, `cross-spawn`, `ws` 8, `bonjour-service`, `hono` + `@hono/node-server`, `node-forge`, `sql.js`, `@modelcontextprotocol/sdk` | `child_process.spawn` with streamed stdio (the `claude`/`codex`/`opencode` CLI); `net.Server` + `http.Server` upgrade for a WebSocket **server**; `dgram` UDP multicast for mDNS discovery; `http2`; `node:sqlite`; `crypto` |
| **Local REST API with MCP** (desktop-only, `engines.node >= 22`) | 724,142 | `express` 4, `cors`, `node-forge`, `mime-types`, `json-logic-js`, MCP SDK | `https.createServer` on 127.0.0.1:27124 with a CA it generates on first run, `http` on :27123, plus everything express touches (`net`, `stream`, `zlib`, `querystring`, `events`, `buffer`) |
| **Advanced Slides** (desktop-only) | 836,818 | `express` 4.15, `fs-extra`, `glob`, `request`, `jszip` | `http.createServer` on :3000, recursive `fs` |
| **Zotero Integration** (desktop-only) | 556,487 | `execa`, `download`, `which`, `shell-path`, `nunjucks` | `child_process` to run a **downloaded binary** it fetches and unzips to disk; PATH resolution through a login shell |
| **Shell commands** (desktop-only) | 94,311 | — | `child_process` with user-authored command lines |
| **Templater** (not desktop-only; its desktop paths are) | 5,590,650 | — | `child_process` for "system commands"; Node `require` of user `.js` files in the vault for user functions |
| **obsidian-git** (not desktop-only) | 3,139,721 | `simple-git` **and** `isomorphic-git` | `simple-git` spawns the system `git`; the mobile fallback is `isomorphic-git` over `requestUrl` — which is why it half-works in our browser build today |
| **Omnisearch** | 1,875,036 | — | optional `http` server for its local API |
| **TaskNotes** | 1,510,372 | — | optional `electron`/`http` API server |
| **Excalidraw**, **Kanban**, **Copilot**, **Importer**, **Smart Connections** | — | — | `@electron/remote` dialogs and always-on-top, `<webview>`, `fs/promises`, `node:original-fs`, `worker_threads` |

Four capability classes, in increasing order of how hard they are to fake:

1. **Spawn + stdio streaming** — git, pandoc, `claude`, Zotero's PDF utility,
   arbitrary shell commands.
2. **Arbitrary filesystem** — absolute paths outside the vault, `fs-extra`
   recursive copies, writing executables, `fs.readFileSync`.
3. **Listening sockets** — `http.Server`, `https.Server` with a self-signed CA,
   `net.Server` for WebSocket upgrades, `dgram` for mDNS.
4. **`require()` of anything** — `node:sqlite`, `http2`, `worker_threads`,
   `original-fs`, and native addons.

### 3.3 Could a Tauri build satisfy them?

Three candidate mechanisms, each of which fails for a different reason.

**(a) A Node-compatible shim over Rust IPC.** The idea: make `window.require`
return hand-written modules whose methods call Tauri commands.

- The pure-computation half is solved off the shelf: `path`, `buffer`,
  `events`, `stream`, `util`, `querystring`, `url`, `string_decoder`, `assert`,
  `zlib` and a partial `crypto` all exist as browser implementations
  ([node-stdlib-browser](https://www.npmjs.com/package/node-stdlib-browser)).
- The I/O half does not. That package's own documentation lists
  `child_process, cluster, dgram, dns, fs, module, net, readline, repl, tls` as
  **not supported**, for the obvious reason. Those are exactly the modules our
  target plugins need, so we would be writing them ourselves, over IPC, against
  Node's observable semantics.
- **Tauri's IPC is asynchronous only.** `invoke()` returns a Promise; there is
  no synchronous channel ([Tauri architecture](https://v2.tauri.app/concept/architecture/)).
  `fs.readFileSync`, `fs.existsSync`, `spawnSync` and `execSync` therefore
  cannot be implemented faithfully. The workarounds — `Atomics.wait` on a
  `SharedArrayBuffer` (forbidden on the main thread) or synchronous `XHR`
  against a localhost server (a deprecated main-thread block per call) — are
  each a new class of bug in an editor that must not jank.
- Even the async half is deep: `express` needs `http.Server` +
  `IncomingMessage`/`ServerResponse` as real streams; `ws` needs `net.Socket`
  and HTTP upgrade; `bonjour-service` needs UDP multicast; `node-forge` needs
  `crypto` primitives; Claudian's agent SDK needs a long-lived child with
  interleaved stdout/stderr and a working `kill`. This is not a shim. It is a
  reimplementation of Node's runtime library on top of a message channel, and
  every plugin update is a chance to discover a corner of it we did not write.

**(b) A bundled Node sidecar.** Tauri supports shipping a `pkg`-compiled Node
binary as an `externalBin` sidecar
([Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)). This does
not help: a plugin is one bundle whose UI code and Node code share a closure,
the DOM, the CodeMirror instances and the `App` object. You cannot run half of
`main.js` in another process. A sidecar is the right shape for *our* code (the
MCP server, §4.4), and the wrong shape for *their* code.

**(c) A real Node runtime inside the webview.** There is none. WKWebView,
WebView2 and WebKitGTK are browser engines; nothing embeds Node in them. (A
WebContainer-style wasm Node runtime is a separate JS realm and hits the same
wall as (b).)

Verdict: Tauri can serve classes 1–3 for **plugins we write or patch**, and can
serve class 1–3 for a hand-picked allowlist if we accept per-plugin shimming.
It cannot serve class 4, and class 4 is where Claudian, Local REST API and
Advanced Slides actually live.

### 3.4 What breaks, concretely, and what does not

| Need | Browser today | Tauri 2 + best-effort shim | Electron |
|---|---|---|---|
| `require('fs')` async | ✗ | ✓ via `tauri-plugin-fs` scopes | ✓ real |
| `fs.readFileSync` / `existsSync` | ✗ | ✗ (no sync IPC) | ✓ real |
| `child_process.spawn` + stdio | ✗ | ✓ via `tauri-plugin-shell` | ✓ real |
| `child_process.execSync` | ✗ | ✗ | ✓ real |
| `http.createServer` / `net.Server` | ✗ | ~ (write an `http`/`net` emulation over a Rust listener) | ✓ real |
| `dgram` (mDNS) | ✗ | ~ (Rust UDP + a `dgram` emulation) | ✓ real |
| `require('node:sqlite')`, `http2`, `worker_threads`, `original-fs` | ✗ | ✗ | ✓ real |
| `require('@electron/remote')`, `electron.shell`, `clipboard`, `Notification` | ✗ | ~ (map a few names to Tauri plugins) | ✓ real |
| `<webview>` tag (Surfing, Smart Connections, Media Extended) | ✗ (`<iframe>`, honours XFO) | ✗ | ✓ (though Electron [discourages it](https://www.electronjs.org/docs/latest/api/webview-tag) in favour of `WebContentsView`) |
| Electron `printToPDF` (Better Export PDF) | ✗ (we use `@page` margin boxes) | ✗ on WKWebView/WebKitGTK | ✓ |
| **Native addons** — `better-sqlite3`, `sharp`, `nodegit`, `node-pty` | ✗ | ✗ | ✓ with per-platform prebuilds |
| `isomorphic-git` (pure JS) | ✓ once `Buffer` exists | ✓ | ✓ |

Native modules deserve a separate note, because they are the one thing that is
hard even in Electron. `better-sqlite3`, `sharp`, `nodegit` and `node-pty` are
compiled against a specific Node ABI, and a plugin that ships one would need a
prebuild for our Electron version on six platform triples. In practice the
top-600 desktop-only set avoids them: Claudian uses `node:sqlite` (a Node 22+
builtin) and `sql.js` (wasm); Local REST API uses `node-forge` (pure JS);
obsidian-git uses `isomorphic-git` (pure JS) plus a spawned `git` binary rather
than `nodegit`. **The ecosystem has already converged on "spawn a binary or use
wasm" instead of native addons**, which is good news for Electron and does not
rescue Tauri.

### 3.5 The switch that cuts both ways

`Platform.isDesktopApp` is read once in our code, but it is read constantly in
plugin code. Today it is `false`, and that is *why* 24 of the top 25 plugins
work: Kanban, Copilot, Templater, Importer, Omnisearch and TaskNotes all guard
their Node paths with `Platform.isDesktopApp` and take the mobile branch.

Setting it to `true` — which any desktop build must do, because the loader test
for `isDesktopOnly` is exactly that flag — **routes every one of those plugins
onto its Node branch at once**. obsidian-git stops using `isomorphic-git` and
starts spawning `git`. Templater exposes system commands. Importer asks
`@electron/remote` for a file dialog. Omnisearch starts an HTTP server.
TaskNotes starts its API.

Under Electron that is fine: those branches then work, as they do in Obsidian.
Under Tauri with a partial shim it is a **regression** — plugins that pass our
245-check compat suite today would start failing on paths we had never
exercised. A desktop build on an incomplete Node is worse than no desktop
build.

There is no clean way to make the flag per-plugin. `Platform` is a module-level
object plugins read at any time, including from async callbacks and timers, so
a "current plugin" getter is not reliable; and giving each plugin its own realm
is ruled out by the requirement that all plugins share one `@codemirror/state`
and one `obsidian` module instance ([plugin-compat.md](plugin-compat.md) §1.3).

### 3.6 So: does true compatibility require Electron?

Yes, if "compatibility" means what the README currently claims — *runs Obsidian
community plugins unmodified*. A real Node in the renderer's reach is the
contract those 91 plugins are written against, and Electron is the only shell
that provides it. Everything else is an allowlist with a maintenance treadmill.

The honest alternative is to **not claim it**: ship a Tauri shell that keeps
`isDesktopApp = false`, sells the browser-plugin experience with native file
access and no CORS, and continues to refuse desktop-only plugins. That is a
coherent product — but it is worth noticing that it unlocks nothing a Chromium
PWA plus the companion extension does not already do (§4), which is why it is
not the recommendation.

---

## 4. What else a desktop build unlocks

Each row states what the browser build does today, so the delta is visible
rather than assumed. "Any shell" means Tauri would do it too.

| Capability | Browser today | Desktop | Shell needed |
|---|---|---|---|
| **No CORS** | `requestUrl` goes through the companion extension's bridge or a proxy (`obsidian/util.ts` `RequestTransport`); without one, Git remotes, Remotely Save, RSS, ICS, DeepL and plugin installs from GitHub release assets all fail ([plugin-compat.md](plugin-compat.md) §2.3) | The shell makes the request from the main process, exactly as Obsidian does. **The companion extension stops being required** for `requestUrl` and for plugin installs. | Any |
| **Plugin install from GitHub** | Blocked: release assets send no `Access-Control-Allow-Origin`, so the store needs the bridge or a proxy | Direct. The whole Tier-2 proxy design in [plugin-compat.md](plugin-compat.md) §2.5 becomes optional. | Any |
| **Real file watcher** | `FileSystemObserver` (Chromium-only, 4 files), one leader tab elected by a Web Lock, plus `vault.syncGate` rescans | Native recursive watch on every OS, no leader election, no rescans, no Chromium requirement | Any |
| **Firefox/Safari users get real folders** | They get OPFS with import/export; only Chromium has File System Access | Every desktop user gets a real folder | Any |
| **Local REST API plugins** | Impossible: a page cannot listen on a port | Works (Local REST API with MCP: 724,142 downloads; Omnisearch's and TaskNotes' APIs) | Electron (it is `https.createServer` in plugin code) |
| **MCP server inside the app** | Separate `vault mcp` CLI process the user installs and configures with an absolute path (`docs/mcp.md`) | Ship `vault` as a sidecar binary and offer "Enable MCP server" in Settings, writing the client config for the user. The crates are already native. | Any |
| **Tray + global hotkey quick capture** | `quick-capture:open` needs the app focused; Document PiP gives a floating window but no global hotkey. Replaces Tray (45,239) and Second Window (38,209), both desktop-only | Real tray icon, real global shortcut, real always-on-top window | Any |
| **Pop-out windows** | `window.open` same-origin windows driven by the main tab; they close with it and are not restored (README "Limits"). Kanban and Excalidraw fall back to a split | Real `BrowserWindow`s; Excalidraw's always-on-top trick works | Any (Electron gets the plugin-visible `@electron/remote` API too) |
| **`obsidian://` protocol** | `web+obsidian://` only, and only for an installed PWA in Chromium; Settings → General has a "Set up" button | Register the real `obsidian://` scheme. Advanced URI (649,949), Remotely Save's OAuth callback and Zotero's `zotero://` round-trips work as written | Any |
| **Background sync / scheduled backup** | Only while a tab is open; backups take a Web Lock and skip if no tab is running | A background process can sync and back up with the window closed | Any |
| **Spotlight / Windows Search indexing** | Nothing — the vault may be in OPFS | Notes are plain files in a real folder, so the OS indexes them with no work from us. (Chromium folder vaults already get this.) | Any |
| **`<webview>` web panes** | `<iframe>`, which honours `X-Frame-Options`; the companion extension strips those headers for allowed hosts (`core-plugins/webviewer/view.ts`) | Full parity with Obsidian's web viewer, and Surfing / Custom Frames / Smart Connections' onboarding work | Electron |
| **Rust core natively** | `vault_wasm_bg.wasm`, 2.9 MB, instantiated before the first plugin loads | See §7.4 — this is the *least* valuable item on the list, and Tauri is worse at it than Electron | — |

Two honest observations about this table.

**Most of it is "any shell", and much of it is already solved.** The CORS
bridge, the file watcher, the pop-outs, the protocol handler and the quick
capture all have working browser implementations with stated limits. A desktop
build makes them better; it does not make them possible. If desktop-only
plugins were off the table, the case for shipping a desktop app would rest on
"Firefox and Safari users get real folders" and "no extension needed", which is
not enough to justify §5.

**The MCP story is the one genuinely new product surface.** `crates/vault-cli`
already serves MCP over stdio with path confinement, atomic writes and a
read-only mode (`docs/mcp.md`). Today that is a `cargo install` the user must
discover. In a desktop app it is a checkbox, and the vault the agent sees is
the vault the user has open. That is worth having regardless of which shell
wins — and it is available as a sidecar in either.

---

## 5. What it costs

### 5.1 Money

| Item | 2026 price | Verified |
|---|---|---|
| Apple Developer Program (Developer ID cert + notarisation) | **$99/year**, same for individual and organisation | [developer.apple.com/programs](https://developer.apple.com/programs/), fetched today |
| Windows code signing — Azure Artifact Signing (the service formerly called Trusted Signing) | Two tiers, Basic (5,000 signatures/month) and Premium (100,000/month). **It now accepts *Individual* identity validation**, via Microsoft Verified ID + AU10TIX, not only established organisations — this is the change that matters for a solo project. It does **not** issue EV certificates. Requires a paid (not free/trial) Azure subscription. | Tiers, individual validation, EV statement and subscription requirement: [Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/trusted-signing/faq), fetched today. **The published prices did not render on the pricing page** — get a quote before committing |
| Windows code signing — traditional OV/EV certificate from a commercial CA | Low hundreds of dollars a year, plus a hardware token or cloud HSM since the 2023 key-storage rules | Not verified today; treat as a fallback if Artifact Signing rejects us |
| Update hosting | **$0** — a static feed on GitHub Releases, which is what Logseq (`latest-*.yml`), Obsidian (`desktop-releases.json`) and `openmarkdown.dev` (`latest.json`) all do | Observed today |
| Notarisation, CI minutes | $0–small on GitHub Actions public runners; macOS runners are the expensive ones | — |

So the cash floor is about **$99/year plus a Windows signing arrangement**. That
is not the real cost.

### 5.2 Engineering

| Cost | Detail |
|---|---|
| A second build matrix | macOS arm64 + x64 (or universal), Windows x64 + arm64, Linux x64 + arm64 → 6 artefacts, each signed, each smoke-tested. Today: one `vite build`. |
| A second test target | `e2e/` is 20 spec files plus `e2e/compat/` (245 checks, 24 scenarios) against Chromium on `localhost:5200`. Playwright's `_electron` fixture keeps them reusable under Electron. Under Tauri they would not be: `tauri-driver` supports [only Windows and Linux](https://v2.tauri.app/develop/tests/webdriver/) because "macOS has no WKWebView driver tool available", so the suite would have to be ported to WebdriverIO. |
| New compat scenarios | The whole point of the build is the previously-refused plugins, so each needs a scenario: Claudian, Local REST API, Advanced Slides, Shell commands, Zotero Integration, Templater system commands, obsidian-git with real `git`. These involve spawning binaries in CI. |
| Release engineering | Version bumps across `apps/web` and `apps/desktop`, signed artefacts, a feed, release notes, and a rollback story. Currently: push a static site. |
| Support surface | "It won't open" (Gatekeeper), "SmartScreen blocked it", "the AppImage won't run", "my antivirus quarantined it" — a class of issue a static site does not have. |
| Ongoing | Electron majors land roughly every 8 weeks and carry Chromium majors with them; each is a regression risk for 7,736 plugins we do not control. |

### 5.3 The cost that is not on the list

The project currently ships **one artefact, to every platform, with no install
and no account**, and that is the argument in [docs/why.md](../why.md). A
download button is a second product with a second support burden and a second
identity. It should be taken on only for the thing that cannot be done any
other way — which is §3, and nothing else.

---

## 6. What competitors do

### 6.1 Every comparable product is Electron

Sizes read from each project's GitHub releases today.

| Product | Shell | Latest | Largest desktop artefact |
|---|---|---|---|
| **Obsidian** | Electron (closed source) | 1.13.7 / 1.14.2 beta | 315.7 MB `.exe`, 217.8 MB universal `.dmg`, 130.6 MB AppImage, 102.1 MB `.deb` — **plus an 8.4 MB `obsidian-1.13.7.asar.gz`**, the app-code-only update payload fetched from `desktop-releases.json` with a `hash` and a `signature` |
| **Logseq** | Electron, `electron-updater` (`latest-x64-mac.yml` …) | 2.0.1 (2026-07-13) | 161.0 MB arm64 `.dmg` |
| **Joplin** | Electron | 3.7.18 (2026-09-11) | 344.1 MB `.exe`, 197.0 MB `.dmg`, 155.1 MB `.deb` |
| **SiYuan** | Electron UI + a Go kernel process | 3.8.4 (2026-09-17) | 242 MB AppImage, 193 MB `.deb` |
| **Zettlr** | Electron | 4.7.0 (2026-07-26) | 183.4 MB arm64 `.dmg`, 145.2 MB `.exe` |
| **Anytype** | Electron client over a Go middleware | 0.56.9-alpha (2026-09-07) | 275.4 MB x64 `.dmg`, 258 MB AppImage |
| **`openmarkdown.dev`** | **Tauri 2** | 0.13.11 (2026-08-29) | **12.7 MB** universal `.dmg`, **4.0 MB** `.exe`, 78.4 MB AppImage |

And they are on **current** Chromium, not a frozen one (versions from each
project's own `package.json` / changelog):

| Product | Electron | ≈ Chromium |
|---|---|---|
| SiYuan 3.8.4 | 44.4.1 | 152 |
| Obsidian 1.13.6+ ([changelog](https://obsidian.md/changelog/): "the installer has been updated to use Electron v43.3.0") | 43.3.0 | 150 (Node 24.18.1) |
| Zettlr 4.7.0 (Vue 3 + CodeMirror 6) | ^43.6.0 | 150 |
| Joplin 3.7.18 (React 19 + CodeMirror **5**) | 42.3.0 | 148 |
| Logseq 2.0.1 (React 19 + ClojureScript, `better-sqlite3`, Capacitor 8 on mobile) | electron-builder/updater | — |
| Anytype 0.53.28 (React 18 + MobX) | ^39.2.7 | — |

The implication is uncomfortable but clear: **everyone who needs a plugin
ecosystem in JavaScript ships Electron and eats 150–300 MB**, and the one
neighbour that ships Tauri ships no plugin ecosystem at all. There is no
migration-away-from-Electron trend to ride.

Three details worth stealing or avoiding:

- **Obsidian splits the app version from the installer version.** The JS bundle
  auto-updates silently; the Electron binary only changes if the user
  re-downloads and reinstalls ([Update Obsidian](https://obsidian.md/help/updates)).
  That is exactly the two-layer model proposed in §7.5, and it has a cost worth
  knowing: **Obsidian's install base runs a long tail of old Chromiums**, so
  plugin authors target the oldest supported installer, not the newest. If we
  do the same, our renderer baseline is the oldest Electron we still support.
- **Obsidian already ships a two-runtime plugin ecosystem** — full Node on
  desktop, no Node on Capacitor mobile, with `isDesktopOnly` as the declared
  boundary ([mobile development](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)).
  A web-versus-desktop capability split is therefore not novel and not fatal;
  the community has absorbed it for years. Our browser build already *is* the
  mobile profile.
- **SiYuan and Anytype run a native local server beside the UI** — SiYuan's Go
  kernel is a Gin HTTP + WebSocket server on `localhost:6806` with token auth
  and a 200-endpoint [public API](https://github.com/siyuan-note/siyuan/blob/master/API.md),
  which is also what gives it a browser-only Docker mode; Anytype ships
  `anytype-heart` as a per-platform Go binary (73.4 MB on darwin-arm64) spoken
  to over gRPC-web. That is the shape of our Electron-UI-plus-`vault`-sidecar
  plan — and Anytype's 70 MB sidecar is a warning about what a native core
  costs on top of the shell. Ours is a 4 MB CLI, not a 70 MB middleware.

Note what they gave up to get there: Logseq's file-based edition is now
**maintenance-only** (security and Electron upgrades, no new features) and the
DB edition "will support Markdown files in the future" but does not today
([split announcement](https://logseq.io/page/b2ad9ce1-9cb7-4436-8083-54cb4516d324/df4dc09d-0a12-4c87-904e-22a9bf4c350a));
SiYuan stores `.sy` JSON plus four SQLite indexes; Anytype stores objects.
**Nobody except Obsidian currently occupies "plain Markdown files on disk, with
plugins" — and Obsidian is closed source.** That is the position this project
holds, and a desktop build should not endanger it.

### 6.2 The Rust-native path (Zed, Lapce)

Zed and Lapce prove a Rust desktop editor can be excellent without a webview —
and that is precisely why they are not a model for us. They render their own
UI on the GPU, which means **none of `packages/app`'s 105,899 lines, none of
its CSS, and none of the Obsidian plugin or theme ecosystem could come along**.
Our entire compatibility claim is that plugins get a real DOM, a real
CodeMirror 6 and a real `document.head` for their `styles.css`
([plugin-compat.md](plugin-compat.md) §1.4). A native GUI discards the product.

The cost is measurable. Zed's repo was created 2021-02-20 and reached a
cross-platform 1.0 in 2026, with a funded full-time team — and its current
release (v1.20.2, 2026-09-17) shows **40,873 downloads of the macOS dmg against
488 of the Windows exe**, so platform parity arrived late and thin. Lapce is
still `0.4.x` after eight years, and **Floem**, the Rust UI library it wrote for
itself, has a latest tagged release from 2024-11-15. Rolling your own UI layer
is a decade-scale commitment.

AppFlowy (Flutter + Rust) is the same trade with a different toolkit — and it
kills the "avoid Electron to get a small app" argument outright: AppFlowy
0.14.3 ships a **103.0 MB macOS dmg, a 130.3 MB `.deb` and a 176.4 MB `.rpm`**,
the same order as the Electron apps, because the weight is the Flutter engine
plus the Rust core rather than Chromium.

*(Zed/Lapce/Floem/AppFlowy figures are from their GitHub release metadata and
repo timestamps read 2026-09-17.)*

### 6.3 Prior attempts to run Obsidian plugins elsewhere

From [plugin-compat.md](plugin-compat.md) §7.1 (recorded 2026-09-13, not
re-verified today): `OpenObsidian/OpenObsidian` 301-redirects to
`OpenOnyx/OpenOnyx` — an Apache-2.0 **Electron 41 + React 19 + CM6** desktop app
with a `plugin-runtime` subsystem explicitly targeting "Obsidian plugin
compatibility through a tested runtime layer". **The closest prior art to this
idea chose Electron.**

Otherwise the ground is empty: a fresh sweep today found no project that runs
Obsidian community plugins outside Obsidian. The state of the art for
"Obsidian in a browser" remains
[obsidian-remote](https://github.com/sytone/obsidian-remote) — the real,
unmodified Electron binary in Docker, streamed over KasmVNC (2,631★;
`linuxserver/obsidian` 517k+ pulls). That anyone bothers to ship
Electron-over-VNC is itself the measure of how tightly the plugin ecosystem is
bound to the Electron runtime. SilverBullet, Foam and Dendron all have (or had)
their own plugin systems, not Obsidian's; Dendron's own issue tracker has
"Development stopped?" threads.

### 6.4 Who actually downloads a desktop notes app

Download counts per point release, read from GitHub release metadata today.
They include re-downloads and CI, and exclude Homebrew/winget/Flatpak/AUR, so
they are directional only.

| Release | macOS | Windows | Linux |
|---|---:|---:|---:|
| Logseq 2.0.1 | 258,301 (arm64 dmg) | 53,220 | 1,151 |
| Zettlr 4.7.0 | 57,487 + 9,619 | 24,560 | 1,893 AppImage + 3,667 deb |
| Joplin 3.7.18 | 24,835 | **64,456** | 11,650 + 1,538 |
| Zed 1.20.2 | 40,873 | 488 | 13,828 |
| Helix 25.07.1 | 5,095–11,322 | 71,427 | 83,123 |
| `openmarkdown.dev` 0.13.11 | 117 + 60 | 40 | 30 |

Two readings. First, **a Markdown/PKM desktop app draws tens of thousands of
downloads per point release** — the demand for a download is not hypothetical,
and note-taking audiences skew to macOS while developer-tool audiences invert
to Windows and Linux. Second, and more usefully for us: **nobody in this
category ships web-only**, which is precisely why the browser build is the
differentiated product and the desktop build is the compatibility escape hatch,
not the other way round.

### 6.5 The naming collision is now real

`openmarkdown.dev` is a **proprietary Tauri 2 Markdown editor** ("Feather-light.
Light-speed.", "a native Rust core", "built for you and your agent"), shipping
since 2026-07-05, 61★ on its releases-only repo
(`OpenMarkdown-dev/OpenMarkdown-releases`), Developer ID signed and notarised,
with a Tauri updater feed. Its LICENSE reads "Copyright © 2026 Xueyan Zhang.
All rights reserved… OpenMarkdown is proprietary software… It does not contain
source code, and no source license is granted", and it **explicitly reserves
the brand name and logos**. It is small — the latest release's `latest.json`
(which the updater polls) has ~871 hits, so the installed base is in the
hundreds — and it positions itself as deliberately narrower than Obsidian,
naming Obsidian as the better tool "if you want a wiki graph, backlinks, or an
infinite canvas". Its hook is agent co-editing over MCP plus an `openmd` CLI,
which is adjacent to our own MCP plan. It has no Obsidian plugin compatibility. It is not a competitor on features, but it **is** an active
product with our working name, a `.dev` domain and a GitHub org — the same
failure mode as OpenObsidian → OpenOnyx. `PRODUCT_NAME` lives in one constant
(`packages/app/src/product.ts`); this should be raised with whoever owns naming,
independently of the desktop decision.

---

## 7. The plan, if we build it

### 7.1 Shape

```
apps/desktop/                       NEW — the only new package
  src/main/                         Electron main process
    index.ts                        windows, menus, tray, global shortcut, protocol
    vaults.ts                       remembered vault folders (replaces the IDB handle store)
    net.ts                          requestUrl over Node (no CORS) + release-asset fetch
    mcp.ts                          starts/stops the `vault` sidecar, writes client config
    updater.ts                      update check + apply
    watch.ts                        recursive fs watch → renderer
  src/preload/                      the ONE security-relevant file
    index.ts                        exposes window.require, the vault root, and nothing else new
  src/renderer/
    entry.ts                        imports @vault/app/boot, same as apps/web/src/main.ts
  resources/bin/vault[.exe]         the vault-cli sidecar, per platform
  electron-builder.yml
```

Everything else is reused unchanged. No fork of `packages/app`, no second copy
of the editor, no second theme.

### 7.2 What is actually new code

| Piece | Where | Rough size |
|---|---|---|
| `NodeAdapter implements VaultAdapter` | `packages/app/src/obsidian/vault/adapter-node.ts` | ~400 lines — the 24 `VaultAdapter` methods over `fs/promises`, reusing `TextCodec` from `text-format.ts` for BOM/EOL/UTF-8 handling |
| Make `FileSystemAdapter` real | `obsidian/vault/adapter-classes.ts` | ~60 lines — `getBasePath()`, `getFullPath()`, `fs`, `fsPromises`, `path`, static `readLocalFile`/`mkdir`. 8 of the top 25 bundles read these. |
| `Platform` desktop values | `obsidian/util.ts` | ~10 lines — `isDesktopApp: true`, `isWeb: false`, `resourcePathPrefix` |
| Node `RequestTransport` | `apps/desktop/src/main/net.ts` + preload | ~150 lines — the existing `setRequestTransport` seam |
| Desktop vault picker / recents | `packages/app/src/boot.ts` branch | ~150 lines |
| Native watcher → `vault.applyRemoteChange` | `apps/desktop/src/main/watch.ts` + a small `observer.ts` branch | ~200 lines |
| Electron main + preload + menus + tray + protocol + updater | `apps/desktop/src/main`, `src/preload` | ~1,500 lines |
| MCP sidecar control | `apps/desktop/src/main/mcp.ts` + a settings tab | ~300 lines |
| **Total new** | | **≈ 3,000 lines**, against 108,000 reused |

Deletions/simplifications the desktop build gets for free: no service worker,
no precache manifest, no IndexedDB handle persistence, no leader-tab election,
no BroadcastChannel tab sync (one process), no `navigator.storage.persist`, no
companion-extension requirement.

### 7.3 How plugins load

Unchanged, except that `require` falls through to Node:

```ts
// packages/app/src/obsidian/app-internals/plugins.ts — makeRequire()
if (id in mods) return mods[id];              // obsidian, @codemirror/*, @lezer/*
const mapped = DEPRECATED_CM[id]; …
return (window as any).require?.(id);         // NEW: real Node on desktop, undefined on web
```

That is the whole change, and it is the change Obsidian's own loader makes
([plugin-compat.md](plugin-compat.md) §1.3 step 3). Three things go with it:

1. **`Platform.isDesktopApp = true`**, so `plugins.ts:165` stops refusing
   `isDesktopOnly` manifests and every plugin's own guards take their desktop
   branch. `desktopModuleStub` and the "Try to load anyway" override
   (`desktopOnlyOverrides`) become dead code on desktop and stay for the web.
2. **`window.require` must be the real thing**, which means a renderer with
   Node — `sandbox: false`, `contextIsolation: false`, `nodeIntegration: true`
   for the vault window. This is Obsidian's configuration and Electron's
   documented "incompatible with the sandbox" case
   ([Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)).
   §8 states the risk; it is not hideable.
3. **`.obsidian/plugins/<id>/` is a real folder**, so a user's existing vault
   brings its plugins with it and the store's install path writes files rather
   than IndexedDB blobs.

The compat suite (`e2e/compat/run.mjs`, 245 checks across 24 scenarios) gains a
desktop target and a new set of scenarios for the previously-refused plugins:
Claudian, Local REST API, Advanced Slides, Shell commands, Zotero Integration,
Templater system commands, obsidian-git with the real `git`.

### 7.4 How the Rust core is used

**It stays wasm, and that is the right answer.** Three reasons:

1. `packages/engine` is explicitly a **synchronous** API — "every call is
   synchronous once `initEngine()` has resolved: the plugin API has synchronous
   entry points (`metadataCache.getFileCache`, `prepareFuzzySearch(q)(text)`)".
   Anything that crosses a process boundary is async, so a Tauri-style IPC core
   would require rewriting the plugin-facing metadata API — which we cannot,
   because it is `obsidian.d.ts`.
2. In Electron a native addon (napi-rs over the same crates) *would* be
   synchronous and is therefore possible later. But it costs prebuilds for six
   triples and an ABI pin, for a module that is 2.9 MB of wasm doing string
   parsing. Measure first: the graph view already falls back from WebGL2 to
   Canvas2D, and the 1,500-note graph screenshot exists.
3. `crates/vault-cli` **is** the native use of the core, and the desktop app
   ships it as a sidecar for MCP. That is where native Rust earns its keep —
   indexing a vault outside the renderer, for an agent, without blocking the UI.

So: wasm in the renderer, native `vault` binary beside it. If profiling later
shows the wasm boundary hurting (large vault open, search), napi-rs is an
additive change behind the existing `packages/engine` interface.

### 7.5 How updates ship

- **Two layers, like Obsidian's own.** Obsidian ships its *app* as a signed
  `.asar.gz` fetched from `desktop-releases.json` (`hash` + `signature` fields,
  fetched today), separately from the Electron shell. We can do the same: the
  renderer bundle is a versioned, signed archive the shell can swap without a
  full reinstall; the shell itself updates rarely.
- **Layer 1, the shell:** `electron-updater` against a static feed published to
  GitHub Releases — no update server to run. macOS requires the update to be
  signed and notarised for Squirrel.Mac to accept it; Windows uses NSIS
  differential updates.
- **Layer 2, the app bundle:** reuses the mental model already in
  `packages/app/src/pwa/sw-client.ts` — check, download, then offer a reload
  only after `workspace.flushSaves()` and the unsaved-work checks pass. The
  same `.vault-update-notice` UI, driven by the shell instead of a service
  worker.
- **Linux:** AppImage updates itself via the same feed; `.deb`/`.rpm` do not,
  and should say so rather than nagging. Flatpak, if we publish one, updates
  through Flathub and must have the in-app updater disabled.
- **Never auto-restart.** A notes app with unsaved buffers gets the same
  treatment the PWA already gives: ask, flush, then reload.

### 7.6 Sequencing

1. **Do not start yet.** Finish [browser-native-plugins.md](browser-native-plugins.md)
   §5. Those 15 build-ins remove ~25 of the 91 desktop-only plugins from the
   argument and are useful to every user, including the ~half who will never
   download anything.
2. **Then prove the thesis cheaply.** A two-week spike: Electron window, Node
   adapter, `window.require` passthrough, `isDesktopApp = true`. Run the
   existing 245-check compat suite under Playwright's `_electron` fixture, plus
   new scenarios for Claudian, Local REST API and obsidian-git-with-real-git.
   The pass/fail of *that* is the real decision; this document only argues it
   is the right experiment.
3. **Then pay for signing** — not before. Certificates are only needed to
   distribute, and the spike distributes to nobody.
4. **Ship macOS + Windows first.** Linux `.AppImage` + `.deb` as best effort;
   Flathub later if someone volunteers to maintain it.

---

## 8. Risks and unknowns

**The security posture changes character.** The browser build's best property is
that a plugin downloaded from GitHub runs in an origin sandbox: it can ruin the
vault, but it cannot read `~/.ssh` or spawn `curl`. A desktop build with
`nodeIntegration: true` gives every plugin — including one that updates itself
overnight — full user privileges. Obsidian has the same exposure, and
[docs/why.md](../why.md) quotes users who distrust it ("plugins that have full
Node access"). We inherit that criticism the day we ship. Mitigations worth
committing to before launch: keep restricted mode on by default; pin and
display the SHA-256 of every installed `main.js` (already planned in
[plugin-compat.md](plugin-compat.md) §2.5) and warn when it changes; show, per
plugin, which Node modules its bundle references, computed at install time from
the same `isNodeOrElectronModule` list we already have; and consider running
the *web* profile by default with an explicit per-plugin "allow Node" consent —
noting §3.5's warning that the flag is global, so this is a real design problem,
not a checkbox.

**The `isDesktopApp = true` regression risk is the top engineering risk.** 24 of
the top 25 plugins currently pass 245 checks on the mobile-shaped path. Every
one of them will take a different branch on desktop. The spike in §7.6 exists
to measure this before anything is promised.

**Two products, one team.** Today one `vite build` produces everything. After
this there are macOS arm64/x64, Windows x64/arm64 and Linux x64/arm64 artefacts,
each signed, each needing a smoke test. The e2e suite runs against Chromium on
`localhost:5200`; Playwright's `_electron` fixture keeps it reusable, but it is
still a second matrix. (This is also a quiet argument against Tauri: `tauri-driver`
supports [only Windows and Linux](https://v2.tauri.app/develop/tests/webdriver/) —
"macOS has no WKWebView driver tool available" — so our Playwright suite would
have to be rewritten in WebdriverIO or not run on macOS at all.)

**Dilution of the positioning.** "No install, no server, no account" is the
product's answer to the most-viewed Obsidian feature request ever
([docs/why.md](../why.md)). A download button next to it invites "so it is just
another Electron notes app". The framing has to be deliberate: *the web app is
the product; the desktop build is for the 91 plugins and the agents.*

**Unknowns this document did not settle:**

- Whether the top desktop-only plugins actually work under our host once Node is
  present. They exercise `app.plugins`, `internalPlugins`, `FileSystemAdapter`
  internals and `@electron/remote` in combinations our 245 checks have never
  touched. Unknown until the spike.
- ~~Whether `node:sqlite` is available in the Electron version we would ship~~ —
  resolved: Electron 44.4.1 bundles Node 24.21.0
  ([releases.electronjs.org](https://releases.electronjs.org/releases.json)),
  which has `node:sqlite`. Claudian's other builtins (`http2`, `dgram`) ship
  with it too. What is *not* resolved is whether they behave in a renderer.
- Whether Claudian's mDNS (`bonjour-service`) and WebSocket server work inside
  an Electron renderer at all, or only in its main process.
- The real memory delta for a 10,000-note vault: Electron's baseline plus our
  2.9 MB wasm plus the plugin set, versus the same tab in Chrome today. Not
  measured here.
- Whether a signed-but-new Windows certificate clears SmartScreen quickly
  enough that the first month of downloads is not a support burden.
- What Chromium baseline we would be committing to. If we copy Obsidian's
  app/installer split (§7.5), most users will keep an old shell for a long
  time, so the renderer baseline becomes "the oldest Electron we still support"
  rather than the newest — which is how Obsidian's plugin authors already
  think. Decide the support window before shipping, not after.
- What fraction of the target audience is desktop at all. The download mix in
  §6.4 shows demand exists, but no public Obsidian desktop-vs-mobile split was
  found; the community stats pages
  (`publish.obsidian.md/hub/…/Obsidian+ecosystem+statistics`,
  `nevernotmove.github.io/obsidian-stats/`) are the places to look.
- Whether we want the Mac App Store at all. Sandboxing there forbids arbitrary
  folder access and process spawning, which would defeat the point; direct
  distribution with notarisation is the assumption throughout.

---

## Appendix: method and sources

Everything marked "measured today" was read on 2026-09-17 with the commands
below. Prices and versions change; re-run before acting on them.

```sh
# installer sizes, per project
curl -sSL "https://api.github.com/repos/<owner>/<repo>/releases/latest" \
  | python3 -c "import json,sys;[print(a['name'], round(a['size']/1048576,1)) for a in json.load(sys.stdin)['assets']]"
# Obsidian's own feed
curl -sSL https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json
# is openmarkdown.dev a Tauri app?
curl -sSL https://github.com/OpenMarkdown-dev/OpenMarkdown-releases/releases/download/v0.13.11/latest.json
#   -> platforms[].signature base64-decodes to "untrusted comment: signature from tauri secret key"
# plugin dependency sets
curl -sSL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/package.json
# this repo
grep -rn "Platform.isDesktopApp" packages/app/src        # one hit: plugins.ts:165
find apps/web/dist -type f -size +1M | xargs ls -la      # 68 MB total, 296 files
```

**Primary sources**

- Electron version, Chromium and Node: <https://releases.electronjs.org/releases.json>
- Electron renderer sandboxing and `nodeIntegration`: <https://www.electronjs.org/docs/latest/tutorial/sandbox>
- Electron `<webview>` discouraged: <https://www.electronjs.org/docs/latest/api/webview-tag>
- Tauri WebKitGTK/NVIDIA rendering problems: <https://v2.tauri.app/develop/debug/linux-graphics/> · webview version fragmentation per OS: <https://v2.tauri.app/reference/webview-versions/>
- Obsidian changelog (Electron version) : <https://obsidian.md/changelog/> · app-vs-installer versions: <https://obsidian.md/help/updates> · mobile is Capacitor: <https://docs.obsidian.md/Reference/TypeScript+API/CapacitorAdapter> · `isDesktopOnly` and mobile: <https://docs.obsidian.md/Plugins/Getting+started/Mobile+development>
- Logseq OG/DB split: <https://logseq.io/page/b2ad9ce1-9cb7-4436-8083-54cb4516d324/df4dc09d-0a12-4c87-904e-22a9bf4c350a>
- SiYuan kernel API: <https://github.com/siyuan-note/siyuan/blob/master/API.md>
- Obsidian-in-Docker prior art: <https://github.com/sytone/obsidian-remote>
- Tauri releases: <https://v2.tauri.app/release/> · architecture (async IPC): <https://v2.tauri.app/concept/architecture/> · sidecar: <https://v2.tauri.app/learn/sidecar-nodejs/> · WebDriver platform support: <https://v2.tauri.app/develop/tests/webdriver/>
- Node builtins that cannot be polyfilled in a browser: <https://www.npmjs.com/package/node-stdlib-browser>
- Apple Developer Program fee: <https://developer.apple.com/programs/>
- Azure Artifact Signing (ex-Trusted Signing) FAQ — individual identity validation, no EV, SmartScreen behaviour: <https://learn.microsoft.com/en-us/azure/trusted-signing/faq> · pricing: <https://azure.microsoft.com/pricing/details/artifact-signing/>
- Engine support: <https://caniuse.com/native-filesystem-api> · <https://caniuse.com/mdn-api_filesystemobserver> · <https://caniuse.com/mdn-api_documentpictureinpicture>
- Plugin sources: [claudian](https://github.com/yishentu/claudian) · [obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) · [obsidian-advanced-slides](https://github.com/MSzturc/obsidian-advanced-slides) · [obsidian-zotero-integration](https://github.com/mgmeyers/obsidian-zotero-integration) · [obsidian-git](https://github.com/Vinzent03/obsidian-git) · [obsidian-shellcommands](https://github.com/Taitava/obsidian-shellcommands)
- `openmarkdown.dev` and its releases repo: <https://openmarkdown.dev/> · <https://github.com/OpenMarkdown-dev/OpenMarkdown-releases>

**In this repo**

- [docs/research/browser-native-plugins.md](browser-native-plugins.md) — the 91-of-600 desktop-only census and the 15 build-ins
- [docs/research/plugin-compat.md](plugin-compat.md) — the loader contract, CORS evidence, internals map
- [docs/plugin-compatibility.md](../plugin-compatibility.md) — the 245-check compat results
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) · [docs/mcp.md](../mcp.md) · [docs/why.md](../why.md)

**Not established here** — RAM and cold-start measurements for either shell,
behaviour of the top desktop-only plugins under our host once Node is present,
and current Windows signing prices. All three belong to the spike in §7.6.
