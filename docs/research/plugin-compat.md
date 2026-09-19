# Running Obsidian community plugins and themes, unmodified, in a browser

Research date: 2026-09-13. Everything here was checked with commands run on that date, and the evidence is quoted inline.

| Artefact | Version / value |
|---|---|
| `obsidian` npm package (API type definitions) | **1.13.1** (npm `latest`, published 2026-06-09). The GitHub `master` branch of `obsidianmd/obsidian-api` is at **1.13.2** (unpublished, commit `cc17443`, 2026-07-14) |
| Saved type file | `docs/research/obsidian.d.ts` = npm 1.13.1 `obsidian.d.ts`, 8,482 lines, sha256 `250cb2e990a34735b89a209ae9dc31c2f38acadceff1d59803ec94d506e3860b` |
| Current Obsidian desktop app | **1.13.7** stable, 1.14.1 beta (`obsidian-releases/desktop-releases.json`) |
| CodeMirror 6 that plugins must share (from `obsidian` peerDependencies) | npm 1.13.1: `@codemirror/state 6.5.0`, `@codemirror/view 6.38.6`, `moment 2.29.4`. master 1.13.2 ("latest used in Obsidian 1.13.2"): `@codemirror/state 6.7.0`, `@codemirror/view 6.43.5`, `moment 2.30.1` |
| Community store | 7,616 plugins, 753 themes, 147,696,396 total plugin downloads |
| Highest `minAppVersion` in the top 25 | `1.13.3` (Omnisearch), which is above the npm types version |

## TL;DR

1. **The loader contract is small and fully observable.** `main.js` is CommonJS. It is evaluated as `(function anonymous(require,module,exports){…})` through an indirect `window.eval`, with a `require` that maps exactly 13 module ids (`obsidian`, 8 `@codemirror/*`, the alias `@codemirror/text`, 3 `@lezer/*`) plus 12 deprecated CM6 package names. Everything else goes to Node `require` on desktop and returns `undefined` on mobile. The plugin's default export is constructed with `new P(app, manifest)`. It must be `instanceof Plugin`, and then `load()` and `loadCSS()` run.
2. **CORS verdict: a static site cannot download plugin code from GitHub.** `main.js` exists only as a GitHub **release asset**: 0 of the top 25 plugins commit `main.js` to the repo. Release assets are served by `github.com` (302) and then `release-assets.githubusercontent.com` (200), and **neither sends `Access-Control-Allow-Origin`**. A real-browser `fetch()` from `https://example.com` fails in Chromium 153, Firefox 155 and WebKit 26.6. `raw.githubusercontent.com`, `api.github.com` JSON and `cdn.jsdelivr.net/gh` all send `ACAO: *`, so **metadata, manifests, versions.json, and every theme** can be fetched CORS-safely, but plugin bytes cannot.
3. **Recommended strategy:**
   - (a) Open the user's existing vault, where `.obsidian/plugins/<id>/` already holds the files, so no network is needed.
   - (b) Use a tiny optional allowlisted proxy (Cloudflare Worker or similar) for release assets, which also serves `requestUrl`.
   - (c) As an optional fallback, mirror the files to GitHub Pages or jsDelivr through a scheduled GitHub Action, only for plugins whose licence permits redistribution.
4. **The API surface is 338 exports** (102 classes, 112 interfaces, 47 functions, 8 consts, 29 types, 1 enum) with 1,153 members, plus 39 `declare global` DOM/prototype augmentations. The checklist is in section 3.
5. **Undocumented internals are used everywhere.** Across the 25 most downloaded plugins:
   - `app.plugins`: 15 of 25
   - `app.internalPlugins`: 15
   - `vault.getConfig`: 12
   - `app.commands`: 8
   - `adapter.basePath`: 8
   - `app.setting`: 7
   - `editor.cm`: 7
   - `window.CodeMirror` (CM5): 6
   - `app.dragManager`: 6
   - `requestUrl`: 12 (bypasses CORS in Obsidian, but will not in a browser)
6. **Legal position:**
   - The API typings are MIT (Copyright 2022 Dynalist Inc.).
   - The Obsidian app (`app.js`, `"license": "UNLICENSED"`) is proprietary, and its Terms of Service forbid reverse engineering except "for the purpose of developing Third Party Plugins for non-commercial use".
   - "Obsidian" is a trademark of Dynalist Inc. It has US serial 98063360, Canadian application 2266181 (filed 2023-06-27) and an EU filing listed. I could not confirm the registration status because the USPTO mirror returned 403.
   - **The GitHub org `OpenObsidian/OpenObsidian` now 301-redirects to `OpenOnyx/OpenOnyx`.** A project with the same idea and the same name renamed itself. The name "OpenObsidian" should be treated as unusable for a public product.

> **Clean-room note.** For this research I downloaded the official app bundle (`obsidian-1.13.7.asar.gz`, public GitHub release asset) and grepped `app.js` and `enhance.js` to confirm loader behaviour. This doc records only interface-level facts: URLs, module-id maps, file names and call order, which any running plugin can observe. **No Obsidian code may be copied into our implementation.** Implement from `obsidian.d.ts` (MIT), the public developer docs, and black-box behaviour of real plugins. Given the ToS clause quoted in section 7, further decompilation should not be a routine part of development. The auto-updated bundle installed on this Mac, `~/Library/Application Support/obsidian/obsidian-1.13.7.asar`, is byte-identical to the downloaded copy (sha256 `a52a7daf…4059d` for both), so every loader fact here applies to the installed app.

---

## 1. Plugin loading contract

### 1.1 `manifest.json`

Source: `obsidian-developer-docs/en/Reference/Manifest.md` and the `PluginManifest` interface in `obsidian.d.ts`. The sample plugin's manifest is shown after the table.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | Lowercase letters and hyphens only. Must not end with `plugin` and must not contain `obsidian`, for new submissions; legacy ids such as `obsidian-git` remain. The id is the key in `community-plugins.json` and the prefix of command ids (`<id>:<cmd>`). |
| `name` | string | yes | Display name. Command names are shown as `"<name>: <cmd name>"`. Must not include the word "Obsidian". |
| `version` | string | yes | semver `x.y.z`. **Must equal the GitHub release tag exactly**, because the download URL is `releases/download/<version>/…`. |
| `minAppVersion` | string | yes | Compared with the app version. If the app is older, the store consults `versions.json`. |
| `description` | string | yes | |
| `author` | string | yes | The loader blanks `author` when it equals "obsidian" (case-insensitive). |
| `authorUrl` | string | no | |
| `fundingUrl` | string or `{label: url}` | no | |
| `isDesktopOnly` | boolean | yes | On non-desktop-app platforms the store shows "unsupported" and the loader **skips enabling** the plugin: `if(!Platform.isDesktopApp && manifest.isDesktopOnly) return false`. |
| `helpUrl` | string | no (undocumented) | Seen in 7 of the top 25 (Excalidraw, Templater, Dataview, Tasks, Kanban, QuickAdd, Linter). |
| `dir` | string | (runtime only) | Set by the loader to the plugin folder path, e.g. `.obsidian/plugins/<folder>`. `loadData` and `loadCSS` use `manifest.dir`, not the id. |

```json
{ "id": "sample-plugin", "name": "Sample Plugin", "version": "1.0.0", "minAppVersion": "1.0.0",
  "description": "Demonstrates some of the capabilities of the Obsidian API.", "author": "Obsidian",
  "authorUrl": "https://obsidian.md", "fundingUrl": "https://obsidian.md/pricing", "isDesktopOnly": false }
```

`versions.json` (repo root) maps plugin version to minAppVersion, for example `{"0.1.0":"1.0.0","0.12.0":"1.1.0"}`. The installer's version resolution works in three steps:

1. Fetch `raw.githubusercontent.com/<repo>/HEAD/manifest.json`.
2. If `appVersion >= minAppVersion`, use `manifest.version`.
3. Otherwise fetch `raw…/HEAD/versions.json` and pick the highest version whose minAppVersion the app satisfies.

`manifest-beta.json` **is not read by Obsidian**: the string has 0 hits in `app.js` 1.13.7. It is the BRAT plugin's convention. 5 of the top 25 ship one (Excalidraw, Dataview, Remotely Save, Omnisearch, Linter).

### 1.2 Build contract (`obsidian-sample-plugin/esbuild.config.mjs`, fetched today)

```js
format: 'cjs', target: 'es2021', bundle: true, outfile: 'main.js',
external: ['obsidian','electron','@codemirror/autocomplete','@codemirror/collab','@codemirror/commands',
  '@codemirror/language','@codemirror/lint','@codemirror/search','@codemirror/state','@codemirror/view',
  '@lezer/common','@lezer/highlight','@lezer/lr', ...builtinModules]
```

The consequence is that a plugin bundle contains top-level `require("obsidian")`, `require("@codemirror/view")` and similar calls. It also contains `require("fs")`, `require("electron")` and so on whenever the plugin (or a dependency) touches Node, **usually unguarded at module top level**. esbuild CJS output evaluates `var import_fs = require("fs")` eagerly.

Measured `require()` targets in the release `main.js` of the top 25 (`grep require("…")`):

- **Pure Obsidian + CM6 (browser-clean):** calendar, style-settings, quickadd, minimal-settings, homepage, recent-files, tag-wrangler, linter, dataview, tasks, iconize, outliner, excalidraw.
- **Node or Electron imports present** (mostly guarded at call sites by `Platform.isDesktopApp`):
  - obsidian-git: `child_process fs fs/promises os path node:*`
  - kanban: `electron fs/promises path`
  - templater: `child_process util`
  - copilot: `electron fs child_process crypto worker_threads …`
  - importer: `node:child_process node:crypto node:original-fs node:os node:path node:url node:zlib`
  - tasknotes: `electron http node:http2 node:stream`
  - smart-connections: `electron`
  - omnisearch: `http url`
  - editing-toolbar: `node:http`
  - remotely-save: `@aws-sdk/signature-v4-crt util`
  - realclaudian: 50+ Node modules (it is `isDesktopOnly: true`)

### 1.3 How `main.js` is evaluated

Observed in `app.js` 1.13.7, function `loadPlugin`. This is paraphrased, not copied:

1. `code = await app.vault.adapter.read(manifest.dir + "/main.js")`.
2. Unless the code ends with `\n/* nosourcemap */`, strip inline `//# sourceMappingURL=data:application/json;base64,…` lines. At install time the installer strips them and appends `\n/* nosourcemap */`.
3. Build `require(id)`:
   - **Deprecated CM6 id → returns the modern module** and logs `[CM6][<plugin>] Using a deprecated package`. The ids are `@codemirror/closebrackets`, `comment`, `fold`, `gutter`, `highlight`, `history`, `matchbrackets`, `panel`, `rangeset`, `rectangular-selection`, `stream-parser` and `tooltip`, mapped to `autocomplete`, `commands`, `language`, `view` or `state` accordingly.
   - **Known id → shared module instance.** The map is exactly: `obsidian`, `@codemirror/autocomplete`, `@codemirror/collab`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/lint`, `@codemirror/search`, `@codemirror/state`, `@codemirror/text` (maps to state), `@codemirror/view`, `@lezer/common`, `@lezer/lr`, `@lezer/highlight`.
   - **`body.emulate-mobile`:** shows a Notice `"<id> attempted to load NodeJS package"`, logs an error, and returns `null`.
   - **Otherwise:** returns `window.require(id)`. That is Node on desktop. On real mobile `window.require` is undefined, so the call **returns `undefined` and never throws**.
4. `fn = window.eval("(function anonymous(require,module,exports){" + code + "\n})\n//# sourceURL=plugin:" + encodeURIComponent(id) + "\n")`. This is an **indirect global eval**, so plugin code sees globals such as `app`, `moment` and `createDiv`, and our CSP needs `'unsafe-eval'`. The alternative is a `blob:` script with the same wrapper and a registry callback.
5. `module = {exports: {}}`, then `fn(require, module, module.exports)`.
6. `PluginClass = module.exports.default || module.exports`. If that is missing, the loader throws "No exports detected".
7. `plugin = new PluginClass(app, manifest)`. **It must be `instanceof` the host's `Plugin` class**, otherwise "Failed to load plugin". Our `require('obsidian').Plugin` must therefore be the same object the host checks against.
8. `app.plugins.plugins[id] = plugin`, then `await plugin.load()`. `load()` awaits `onload()` and then loads child components.
9. `await plugin.loadCSS()`, then `onUserEnable()` if the user just enabled it.

**Implications for our shim:**

- `require` for unknown ids must return `undefined` or `null`, never throw. Throwing would kill Kanban, Git and Copilot at their top-level imports even though they guard all actual use.
- CM6 packages must be **one shared instance** of each. Plugins pass `StateField`, `Facet` and `ViewPlugin` objects into our editor, and CM6 uses identity checks. Pin to the versions in the table at the top.
- Set `Platform.isDesktopApp = false`, `Platform.isMobileApp = false`, `isDesktop = true` (desktop layout) and `isMobile = false`. Desktop-only plugins then skip Node paths behind their `Platform.isDesktopApp` guards. Honour `isDesktopOnly` exactly as mobile does.

**Deprecation and blocklists** also run before loading:

- `community-plugin-deprecation.json` (id → array of broken versions) is fetched from `obsidian-releases`. Matching versions are disabled and saved.
- Hardcoded refusals: `obsidian-toolkit` ≤ 1.4.3, `settings-search` (always), `better-pdf-plugin` 1.4.0.

### 1.4 `styles.css` injection

`loadCSS()` checks `vault.exists(dir + "/styles.css")`, reads it with `readRaw`, and creates `<style type="text/css">` with that text. The element is inserted into `document.head` **before `app.customCss.styleEl`** (the theme's `<style>`). The ordering is: app.css, then plugin styles, then the theme, then snippets. Snippets are inserted after the theme style element. **Themes override plugin CSS**, and the style element is removed through `plugin.register(() => el.detach())` on unload.

### 1.5 `loadData` / `saveData`

- `loadData()` calls `vault.readPluginData(manifest.dir)`, which reads `normalizePath(dir + "/data.json")` through `readJson`. It returns `null` if the file is absent.
- `saveData(obj)` calls `vault.writePluginData(dir, obj, {mtime: Date.now()})`, which writes JSON to `<dir>/data.json`.
- If `data.json` changes on disk (the vault `raw` event for `<pluginFolder>/<id>/data.json`), the loader calls `plugin.onExternalSettingsChange()`, debounced by 50 ms. It skips the call when mtime equals the last self-write (`_lastDataModifiedTime`).

### 1.6 Where things live: the `.obsidian/` config directory

`vault.configDir` is `.obsidian` by default and configurable. File categories come from the app's own sync classifier:

| Path (relative to configDir) | Content |
|---|---|
| `plugins/<id>/manifest.json`, `main.js`, `styles.css`, `data.json` | Community plugin. The folder name is normally the id and must match it for `onExternalSettingsChange`. |
| `community-plugins.json` | JSON array of **enabled** community plugin ids, e.g. `["dataview","calendar"]`. |
| `core-plugins.json` | Enabled core plugins. Older vaults use an array of ids; newer ones use `{id: boolean}`. Also `core-plugins-migration.json`. |
| `<core-plugin-id>.json` (one path segment) | Core plugin settings, e.g. `graph.json`, `bookmarks.json`, `daily-notes.json`, `templates.json`, `backlink.json`, `page-preview.json`, `switcher.json`, `command-palette.json`, `canvas.json`, `note-composer.json`, `zk-prefixer.json`, `workspaces.json`, `file-recovery.json`, `webviewer.json`, `bases.json`. Core plugin ids per obsidian-typings: `audio-recorder backlink bases bookmarks canvas command-palette daily-notes editor-status file-explorer file-recovery footnotes global-search graph markdown-importer note-composer outgoing-link outline page-preview properties publish random-note slash-command slides switcher sync tag-pane templates webviewer word-count workspaces zk-prefixer`. |
| `app.json` | `vault.getConfig` keys, including: `alwaysUpdateLinks`, `attachmentFolderPath` ("/"), `newFileLocation` ("root"), `newFileFolderPath`, `newLinkFormat` ("shortest"), `useMarkdownLinks`, `showUnsupportedFiles`, `autoPairBrackets`, `autoPairMarkdown`, `smartIndentList`, `foldHeading`, `foldIndent`, `showLineNumber`, `showIndentGuide`, `useTab`, `tabSize`, `rightToLeft`, `vimMode`, `livePreview`, `defaultViewMode` ("source"), `promptDelete`, `trashOption` ("system"), `deleteUnlinkedAttachments`, `userIgnoreFilters`, `focusNewTab`, `pdfExportSettings`, `mobileToolbarCommands`, `mobilePullAction` and others. |
| `appearance.json` | `theme` ("system", "obsidian"=dark or "moonstone"=light), `accentColor`, `cssTheme` (theme folder name), `enabledCssSnippets` (array of snippet basenames), `translucency`, `textFontFamily`, `interfaceFontFamily`, `monospaceFontFamily`, `baseFontSize` (16), `baseFontSizeAction`. |
| `types.json` | Property (frontmatter) type assignments, `{types: {key: "text"|"multitext"|"number"|"checkbox"|"date"|"datetime"|"aliases"|"tags"}}`. It belongs to the `app` category. |
| `hotkeys.json` | `{ "<commandId>": [{modifiers: ["Mod","Shift"], key: "K"}], … }`. An empty array unbinds a default. |
| `workspace.json` / `workspace-mobile.json` | Serialized layout (`main`, `left`, `right`, `left-ribbon`, `active`, `lastOpenFiles`). Excluded from sync. |
| `snippets/*.css` | CSS snippets. Enabled ones are listed in `appearance.json.enabledCssSnippets`. |
| `themes/<Theme Name>/manifest.json` + `theme.css` | Installed community theme. The folder name is the theme **name**, not the repo. Legacy installs used `themes/<name>.css`, which the installer deletes on upgrade. |

Vault `getConfig` and `setConfig` read and write one merged key space backed by `app.json` and `appearance.json`. The app has a single defaults object (`alwaysUpdateLinks … showViewHeader, showRibbon, nativeMenus … theme, cssTheme, baseFontSize … types`), and which file persists a given key is not derivable from that object. Read both files, merge them, and write each key back to the file it came from. Default new keys by the table above, and check against a real vault.

---

## 2. The community store and downloads

### 2.1 Directory files

Fetched from `https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/…`:

| File | Size | Schema | Count |
|---|---|---|---|
| `community-plugins.json` | 2,260,865 B | `[{id, name, author, description, repo}]` where `repo` is `"owner/name"` | 7,616 |
| `community-plugin-stats.json` | 2,264,981 B | `{ "<id>": { "downloads": N, "updated": epochMs, "<version>": downloadsOfThatVersion, … } }` | 7,612 keys |
| `community-css-themes.json` | 131,712 B | `[{name, author, repo, screenshot, modes: ["dark","light"], legacy?: true}]` | 753 (17 `legacy`; modes: 510 both, 211 dark-only, 32 light-only) |
| `community-plugin-deprecation.json` | n/a | `{ "<id>": ["badVersion", …] }` | n/a |
| `desktop-releases.json` | n/a | `{minimumVersion, latestVersion, downloadUrl, hash, signature, beta:{…}}` | n/a |

New in 2026: 5,023 of 7,616 plugin descriptions end with *"This plugin has not been manually reviewed by Obsidian staff."* The web directory now lives at `community.obsidian.md`.

Headers for `community-plugins.json` from raw: `HTTP/2 200`, `cache-control: max-age=300`, `access-control-allow-origin: *`, `cross-origin-resource-policy: cross-origin`, `content-type: text/plain; charset=utf-8`. The app caches these lists for 5 minutes.

### 2.2 Exactly how Obsidian downloads a plugin (app.js 1.13.7)

URL builders:

- `raw(repo, file, ref = "HEAD")` = `https://raw.githubusercontent.com/<repo>/HEAD/<file>`
- `release(repo, version, file)` = `https://github.com/<repo>/releases/download/<version>/<file>`

Install sequence:

1. Browse: `community-plugins.json` and `community-plugin-stats.json` (raw, `master` via HEAD).
2. Plugin detail: fetch `raw(repo, "manifest.json")`. This HEAD manifest is used for `isDesktopOnly`, `version` and `minAppVersion`.
3. Resolve the version as described in section 1.1, using `raw(repo, "versions.json")` when needed.
4. `installPlugin(repo, version, manifest)`:
   1. Fetch `release(repo, version, "manifest.json")` and **abort with "Plugin ID mismatch"** if its `id` differs.
   2. Create `.obsidian/plugins/<id>/` and write `manifest.json`.
   3. Fetch `release(…, "main.js")`, strip the inline source map, append `/* nosourcemap */`, and write it. A missing `main.js` is only logged.
   4. Fetch `release(…, "styles.css")`, which is optional.
   5. `loadManifest`. If the plugin was already loaded, disable and then re-enable it.
5. Update check: for each installed plugin in `community-plugins.json`, fetch the raw HEAD manifest, verify the id, resolve the version, and flag an update if it is newer than the installed version.
6. The fetch helper uses Electron/Capacitor native HTTP (no CORS). **On a non-404 failure for a github.com or raw URL it retries through `https://releases.obsidian.md/proxy?url=<url>`.** When I probed that proxy it returned 200 for a raw URL and 404 for release-asset URLs, and sent **no ACAO**. It is Obsidian's private infrastructure and must not be used by us.

Observed consequence: `dataview`'s HEAD `manifest.json` says `0.5.68`, while `api.github.com …/releases/latest` says `0.5.70`. **Obsidian installs 0.5.68.** The default-branch manifest is the source of truth, not "latest release".

### 2.3 CORS feasibility: evidence

All commands used `-H 'Origin: https://example.com'`.

**github.com release download** (Dataview 0.5.68 main.js):

```
$ curl -sSI -H "$O" https://github.com/blacksmithgu/obsidian-dataview/releases/download/0.5.68/main.js
HTTP/2 302
content-type: text/html; charset=utf-8
vary: X-PJAX, X-PJAX-Container, Turbo-Visit, Turbo-Frame, X-Requested-With, X-GitHub-Client-Version, Sec-Fetch-Site,Accept-Encoding, Accept, X-Requested-With
cache-control: no-cache
strict-transport-security: max-age=31536000; includeSubdomains; preload
x-frame-options: deny
x-content-type-options: nosniff
referrer-policy: no-referrer-when-downgrade
server: github.com
location: https://release-assets.githubusercontent.com/github-production-release-asset/329202727/0c5433f1-…?sp=r&sv=2018-11-09&sr=b&spr=https&se=2026-09-14T05%3A32%3A00Z&rscd=attachment%3B+filename%3Dmain.js&…&jwt=…
            (no access-control-allow-origin)
$ curl -X OPTIONS … (preflight)  ->  HTTP/2 404
```

**The redirect target, release-assets.githubusercontent.com** (Azure Blob behind Fastly):

```
HTTP/2 200
server: Windows-Azure-Blob/1.0 Microsoft-HTTPAPI/2.0
x-ms-blob-type: BlockBlob
via: 1.1 varnish, 1.1 varnish
content-disposition: attachment; filename=main.js
content-type: application/octet-stream
content-length: 2377639
            (no access-control-allow-origin; same for GET with Range -> 206, and with Sec-Fetch-Mode: cors)
OPTIONS -> HTTP/2 405 (server: Varnish)
```

`objects.githubusercontent.com`, the legacy asset host, is no longer used as a redirect target: its root returns 404 and every redirect observed pointed at `release-assets.githubusercontent.com`. `releases/latest/download/<file>` adds one more 302 on github.com, still without ACAO.

**api.github.com**:

```
$ curl -sS -D - -H "$O" https://api.github.com/repos/blacksmithgu/obsidian-dataview/releases/latest
HTTP/2 200
access-control-allow-origin: *
access-control-expose-headers: ETag, Link, Location, Retry-After, …, X-RateLimit-Limit, X-RateLimit-Remaining, …
x-ratelimit-limit: 60
x-ratelimit-remaining: 56
x-ratelimit-resource: core
   -> tag 0.5.70; assets main.js id 244337758 (2,377,634 B), manifest.json 244337760, styles.css 244337761

$ curl -sS -D - -H "$O" -H 'Accept: application/octet-stream' https://api.github.com/repos/blacksmithgu/obsidian-dataview/releases/assets/244337758
HTTP/2 302
access-control-allow-origin: *
location: https://release-assets.githubusercontent.com/github-production-release-asset/329202727/60956dd9-…
   -> the 302 is CORS-OK, but the browser follows it to release-assets, which has no ACAO -> fetch fails.

OPTIONS preflight on api.github.com -> 204, access-control-allow-origin: *, access-control-allow-methods: GET, POST, PATCH, PUT, DELETE,
  access-control-allow-headers: Authorization, Content-Type, If-Match, …, X-GitHub-Api-Version, …, access-control-max-age: 86400
GET /rate_limit -> {'limit': 60, 'remaining': 54, 'reset': 1789365146, 'used': 6}
```

**raw.githubusercontent.com**: `manifest.json` at HEAD returns `200`, `access-control-allow-origin: *`, `cross-origin-resource-policy: cross-origin`. `main.js` at tag `1.5.10` (calendar) returns **404** (not committed), still with `ACAO: *`.

**cdn.jsdelivr.net/gh**:

- `…/gh/blacksmithgu/obsidian-dataview@0.5.70/manifest.json` returns 200, `access-control-allow-origin: *`, `x-jsd-version: 0.5.70`.
- `…@0.5.70/main.js` returns **404**, because jsDelivr serves the git tree, not release assets.
- `…/gh/…/versions.json` returns 200 with ACAO `*`.

**GitHub Pages** (`octocat.github.io`): `access-control-allow-origin: *`, even on 404. **jsDelivr npm** (`/npm/obsidian@1.13.1/obsidian.d.ts`): 200, `ACAO: *`.

**Is `main.js` ever in the repo?** For each of the top 25, `raw.githubusercontent.com/<repo>/HEAD/main.js` returned **404 for all 25**. `styles.css` returned 200 for 16, `versions.json` for 22 and `manifest-beta.json` for 5.

**Real browsers** (Playwright; page at `https://example.com/`, then `fetch()`; script `scratchpad/cors.cjs`):

| Request | Chromium 153 | Firefox 155 | WebKit 26.6 |
|---|---|---|---|
| `github.com/<repo>/releases/download/<v>/main.js` | FAIL "Failed to fetch" | FAIL NetworkError | FAIL "Load failed" |
| `github.com/<repo>/releases/latest/download/manifest.json` | FAIL | FAIL | FAIL |
| `api.github.com/repos/<repo>/releases/latest` (JSON) | OK 200 7,823 B | OK | OK |
| `api.github.com/…/releases/assets/<id>` + `Accept: application/octet-stream` | **FAIL** (redirect to release-assets) | FAIL | FAIL |
| `raw.githubusercontent.com/<repo>/HEAD/manifest.json` | OK 306 B | OK | OK |
| `raw…/obsidian-releases/master/community-plugins.json` | OK 2,260,865 B | OK | OK |
| `cdn.jsdelivr.net/gh/<repo>@<tag>/manifest.json` | OK | OK | OK |
| `api.github.com/repos/<repo>/contents/manifest.json` (base64 JSON) | OK | OK | OK |

### 2.4 CORS summary

| Host | Sends `Access-Control-Allow-Origin`? | Usable from a static site for |
|---|---|---|
| `raw.githubusercontent.com` | **Yes, `*`** | Store JSON, HEAD `manifest.json`, `versions.json`, theme `manifest.json` / `theme.css` / `obsidian.css`, screenshots |
| `api.github.com` (JSON) | **Yes, `*`** (60 req/h per IP unauthenticated; 5,000/h with a user token) | Release metadata, asset ids and sizes |
| `api.github.com/…/releases/assets/<id>` octet-stream | Yes on the 302, **no on the target** | Not usable |
| `github.com/…/releases/download/…` | **No** (302, and OPTIONS returns 404) | Not usable |
| `release-assets.githubusercontent.com` | **No** (OPTIONS returns 405) | Not usable |
| `objects.githubusercontent.com` | Legacy; no longer a redirect target | Not usable |
| `cdn.jsdelivr.net/gh/<repo>@<ref>/…` | **Yes, `*`** | Only files committed to git, so manifest and versions but never `main.js` for the top 25 |
| `releases.obsidian.md/proxy` / `/stats/theme` | **No** | Not usable (and not ours) |
| `*.github.io` (GitHub Pages) | **Yes, `*`** | A mirror we publish ourselves |

### 2.5 Recommended download strategy for a backend-less static app

**Tier 0: bring your own vault (primary, zero network).** Almost every target user already has Obsidian with plugins installed. Open the vault folder with the File System Access API (Chromium) or `<input webkitdirectory>` or a drag-drop of a folder (Firefox and Safari, read-only). `.obsidian/community-plugins.json` and `.obsidian/plugins/<id>/{manifest.json,main.js,styles.css,data.json}` are already on disk. Also accept a dropped `.zip` or the three files for a single plugin.

**Tier 1: store browsing (CORS-safe, static).**

- Directory: `raw…/obsidian-releases/master/community-plugins.json` + `community-plugin-stats.json`, cached 5 min.
- Detail: `raw…/<repo>/HEAD/manifest.json` (+ `versions.json`) and `README.md`.
- Keep `api.github.com` out of the hot path because of the 60/h limit.

**Tier 2: plugin bytes through an optional, allowlisted proxy.** A ~40-line Cloudflare Worker (or Deno Deploy, Vercel Edge or similar) that:

- Accepts only `GET /gh/<owner>/<repo>/<version>/(manifest.json|main.js|styles.css)`.
- Checks that `<owner>/<repo>` appears in a cached copy of `community-plugins.json`, **so it is not an open proxy**.
- Fetches `https://github.com/<repo>/releases/download/<version>/<file>` server-side, following redirects.
- Returns the body with `Access-Control-Allow-Origin: <our origin>`, `Cache-Control: public, max-age=31536000, immutable` for versioned paths, and an `ETag`.
- Lets the client **pin a SHA-256 of `main.js` at install**, because release assets are mutable, and show a diff warning on change.

The proxy URL must be user-configurable (self-hostable), and the app must work without it via Tier 0. The same Worker can optionally serve **`requestUrl` for plugins**: Obsidian's `requestUrl` is CORS-free, and 12 of the top 25 use it (Git's isomorphic-git, Remotely Save, Copilot and others need it). Keep that a separate, explicitly-enabled route with its own allowlist or user consent, because it is a general egress proxy.

**Tier 3: static mirror (optional fallback, no server we run).** A scheduled GitHub Action in our own repo:

1. Reads `community-plugins.json`.
2. For a curated allowlist (for example our compatibility test set), downloads release assets server-side.
3. Commits them to a Pages branch as `/<id>/<version>/{manifest.json,main.js,styles.css}` plus a `sha256` index.

GitHub Pages and jsDelivr `gh/` both send `ACAO: *`. **Only mirror plugins whose LICENSE permits redistribution** (MIT, Apache-2.0, GPL with source link, etc.). Obsidian's policy requires every listed plugin to "Include a LICENSE file", but some are not OSS-compatible, and the mirror must credit authors.

**Do not use:**

- Public CORS proxies (corsproxy.io and similar): code-integrity and privacy risk for executable code.
- `releases.obsidian.md/proxy`: Obsidian's infrastructure, no ACAO, and it does not serve release assets.

**Themes need none of this.** See section 6.

---

## 3. The full public API surface (`obsidian` 1.13.1)

Enumerated with the TypeScript compiler API over `obsidian.d.ts` (script `scratchpad/enum.cjs`). This covers every top-level statement in the module and in the `declare global` block. I diffed GitHub `master` (1.13.2) against npm 1.13.1: 26 diff lines. The only additions are `SettingSecretControl` and `SettingControl` gaining `| SettingSecretControl<K>`, and `SecretComponent#onChange(cb: (value: string | null) => …)`. The table includes the 1.13.2 export, marked as such.

Totals:

- **Module exports:** 102 classes (26 abstract), 112 interfaces, 47 functions, 8 consts, 29 type aliases and 1 enum, for **338 exports** and **1,153 distinct members**. These counts come from master 1.13.2; npm 1.13.1 has 337 exports and 111 interfaces, because `SettingSecretControl` is absent.
- **`declare global`:** 24 interface augmentations, 13 functions and 2 consts.
- **Imports:** `Extension, StateField` from `@codemirror/state`, `EditorView, ViewPlugin` from `@codemirror/view`, and `* as Moment` from `moment`.

Also shipped in the package:

- `canvas.d.ts`: `.canvas` JSON types (`CanvasData`, `CanvasNodeData`, `CanvasFileData`, `CanvasTextData`, `CanvasLinkData`, `CanvasGroupData`, `CanvasEdgeData`, `CanvasColor`, `AllCanvasNodeData`, `BackgroundStyle`, `NodeSide`, `EdgeEnd`).
- `publish.d.ts`: the Obsidian Publish site API, not needed here.

**Typed events** (the overloads of `on(name, …)`):

- `Vault`: `create`, `modify`, `delete`, `rename`. `raw` is internal but used by the loader.
- `MetadataCache`: `changed`, `deleted`, `resolve`, `resolved`.
- `Workspace`: `quick-preview`, `resize`, `active-leaf-change`, `file-open`, `layout-change`, `window-open`, `window-close`, `css-change`, `file-menu`, `files-menu`, `url-menu`, `editor-menu`, `editor-change`, `editor-paste`, `editor-drop`, `quit`.
- `WorkspaceLeaf`: `pinned-change`, `group-change`.

Plugins also trigger and listen to untyped custom events on these buses, for example `dataview:index-ready`, `dataview:metadata-change`, `leaf-menu`, `post-processor-change` and `css-change`.

**Runtime globals that are not in the d.ts but that plugins read** (set by `app.js`, `enhance.js` and `lib/*.js`):

- `window.app` (8 of 25 bundles reference it).
- `window.moment` (10 of 25). `moment` is also exported from `obsidian`.
- `window.CodeMirror`, the CM5 global from `lib/codemirror/*.js`, plus `CodeMirrorAdapter` (CM6 vim adapter). 6 of 25 bundles reference CM5 for `defineMode`/`runMode` syntax highlighting.
- `i18next`, `DOMPurify`, `Prism` (lazy), `MathJax` (lazy), `PIXI` (graph), `TurndownService`, `scrypt`, `mermaid` (lazy), `pdfjsLib` (lazy).
- `Notice`, `request` and `requestUrl` on `window`.
- `activeWindow` and `activeDocument`, reassigned when a popout window gains focus.
- `globalEnhance` (the function that installs the DOM augmentations into new windows).
- `Object.hasOwn` and `Array.combine` polyfills; a no-op `TouchEvent` if absent; a `ResizeObserver` stub if absent.

**Status legend:** every row starts `[ ]` (unimplemented). Version tags in brackets are the `@since` values from the d.ts; `[deprecated]` marks deprecated members.

#### App & lifecycle (4 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | const | `apiVersion`: `string` |  |
| [ ] | class | `App` [0.9.7] | `keymap [0.9.7]`, `scope [0.9.7]`, `workspace [0.9.7]`, `vault [0.9.7]`, `metadataCache [0.9.7]`, `fileManager [0.11.0]`, `lastEvent [0.12.17]`, `renderContext [1.10.0]`, `secretStorage [1.11.4]`, `isDarkMode() [1.10.0]`, `loadLocalStorage(key) [1.8.7]`, `saveLocalStorage(key, data) [1.8.7]` |
| [ ] | type | `Constructor` = `abstract new (...args: any[]) => T` |  |
| [ ] | function | `requireApiVersion(version)` |  |

#### Component & Events (5 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | class | `Component` [0.9.7] | `load() [0.9.7]`, `onload() [0.9.7]`, `unload() [0.9.7]`, `onunload() [0.9.7]`, `addChild(component) [0.12.0]`, `removeChild(component) [0.12.0]`, `register(cb) [0.9.7]`, `registerEvent(eventRef) [0.9.7]`, `registerDomEvent(el, type, callback, options?) [0.14.8]`, `registerInterval(id) [0.13.8]` |
| [ ] | function | `debounce(cb, timeout?, resetTimer?)` |  |
| [ ] | interface | `Debouncer<T,V>` | `(call)`, `cancel()`, `run() [1.4.4]` |
| [ ] | interface | `EventRef` |  |
| [ ] | class | `Events` [0.9.7] | `on(name, callback, ctx?) [0.9.7]`, `off(name, callback) [0.9.7]`, `offref(ref) [0.9.7]`, `trigger(name, data) [0.9.7]`, `tryTrigger(evt, args) [0.9.7]` |

#### Plugin & manifest & settings tab (14 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | interface | `CliData` [1.12.2] | `[index] [1.12.2]` |
| [ ] | interface | `CliFlag` [1.12.2] | `value? [1.12.2]`, `description [1.12.2]`, `required? [1.12.2]` |
| [ ] | type | `CliFlags` [1.12.2] = `Record<string, CliFlag>` |  |
| [ ] | type | `CliHandler` [1.12.2] = `(params: CliData) => string \| Promise<string>` |  |
| [ ] | interface | `Command` | `id`, `name`, `icon?`, `mobileOnly?`, `repeatable?`, `callback?`, `checkCallback?`, `editorCallback? [0.12.2]`, `editorCheckCallback? [0.12.2]`, `hotkeys?` |
| [ ] | interface | `Hotkey` | `modifiers`, `key` |
| [ ] | type | `Modifier` = `'Mod' \| 'Ctrl' \| 'Meta' \| 'Shift' \| 'Alt'` |  |
| [ ] | interface | `ObsidianProtocolData` | `action`, `[index]` |
| [ ] | type | `ObsidianProtocolHandler` = `(params: ObsidianProtocolData) => any` |  |
| [ ] | abstract class | `Plugin` extends Component [0.9.7] | `app [0.9.7]`, `manifest [0.9.7]`, `settings? [1.13.0]`, `constructor(app, manifest)`, `onload() [0.9.7]`, `addRibbonIcon(icon, title, callback) [0.9.7]`, `addStatusBarItem() [0.9.7]`, `addCommand(command) [0.9.7]`, `removeCommand(commandId) [1.7.2]`, `addSettingTab(settingTab) [0.9.7]`, `registerView(type, viewCreator) [0.9.7]`, `registerHoverLinkSource(id, info) [1.1.0]`, `registerExtensions(extensions, viewType) [0.9.7]`, `registerMarkdownPostProcessor(postProcessor, sortOrder?) [0.9.7]`, `registerMarkdownCodeBlockProcessor(language, handler, sortOrder?) [0.9.7]`, `registerBasesView(viewId, registration) [1.10.0]`, `registerEditorExtension(extension) [0.12.8]`, `registerObsidianProtocolHandler(action, handler) [0.11.0]`, `registerEditorSuggest(editorSuggest) [0.12.7]`, `registerCliHandler(command, description, flags, handler) [1.12.2]`, `loadData() [0.9.7]`, `saveData(data) [0.9.7]`, `onUserEnable() [1.7.2]`, `onExternalSettingsChange?() [1.5.7]` |
| [ ] | interface | `PluginManifest` | `dir?`, `id`, `name`, `author`, `version`, `minAppVersion`, `description`, `authorUrl?`, `isDesktopOnly?` |
| [ ] | abstract class | `PluginSettingTab` extends SettingTab [0.9.7] | `constructor(app, plugin)`, `getSettingDefinitions() [1.13.0]`, `getControlValue(key) [1.13.0]`, `setControlValue(key, value) [1.13.0]` |
| [ ] | abstract class | `SettingTab` [0.9.7] | `icon [1.11.0]`, `app`, `containerEl`, `settingItems [1.13.0]`, `getSettingDefinitions() [1.13.0]`, `update() [1.13.0]`, `getControlValue(key) [1.13.0]`, `setControlValue(key, value) [1.13.0]`, `refreshDomState() [1.13.0]`, `display() [deprecated]`, `hide()` |
| [ ] | type | `UserEvent` = `MouseEvent \| KeyboardEvent \| TouchEvent \| PointerEvent` |  |

#### Vault, files & adapters (13 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | class | `CapacitorAdapter` implements DataAdapter [1.7.2] | `getName() [1.7.2]`, `mkdir(normalizedPath) [1.7.2]`, `trashSystem(normalizedPath) [1.7.2]`, `trashLocal(normalizedPath) [1.7.2]`, `rmdir(normalizedPath, recursive) [1.7.2]`, `read(normalizedPath) [1.7.2]`, `readBinary(normalizedPath) [1.7.2]`, `write(normalizedPath, data, options?) [1.7.2]`, `writeBinary(normalizedPath, data, options?) [1.7.2]`, `append(normalizedPath, data, options?) [1.7.2]`, `appendBinary(normalizedPath, data, options?) [1.12.3]`, `process(normalizedPath, fn, options?) [1.7.2]`, `getResourcePath(normalizedPath) [1.7.2]`, `remove(normalizedPath) [1.7.2]`, `rename(normalizedPath, normalizedNewPath) [1.7.2]`, `copy(normalizedPath, normalizedNewPath) [1.7.2]`, `exists(normalizedPath, sensitive?) [1.7.2]`, `stat(normalizedPath) [1.7.2]`, `list(normalizedPath) [1.7.2]`, `getFullPath(normalizedPath) [1.7.2]` |
| [ ] | interface | `DataAdapter` | `getName()`, `exists(normalizedPath, sensitive?)`, `stat(normalizedPath) [0.12.2]`, `list(normalizedPath)`, `read(normalizedPath)`, `readBinary(normalizedPath)`, `write(normalizedPath, data, options?)`, `writeBinary(normalizedPath, data, options?)`, `append(normalizedPath, data, options?)`, `appendBinary(normalizedPath, data, options?) [1.12.3]`, `process(normalizedPath, fn, options?)`, `getResourcePath(normalizedPath)`, `mkdir(normalizedPath)`, `trashSystem(normalizedPath)`, `trashLocal(normalizedPath)`, `rmdir(normalizedPath, recursive)`, `remove(normalizedPath)`, `rename(normalizedPath, normalizedNewPath)`, `copy(normalizedPath, normalizedNewPath)` |
| [ ] | interface | `DataWriteOptions` | `ctime?`, `mtime?` |
| [ ] | interface | `FileStats` | `ctime`, `mtime`, `size` |
| [ ] | class | `FileSystemAdapter` implements DataAdapter | `getName()`, `getBasePath()`, `mkdir(normalizedPath)`, `trashSystem(normalizedPath)`, `trashLocal(normalizedPath)`, `rmdir(normalizedPath, recursive)`, `read(normalizedPath)`, `readBinary(normalizedPath)`, `write(normalizedPath, data, options?)`, `writeBinary(normalizedPath, data, options?)`, `append(normalizedPath, data, options?)`, `appendBinary(normalizedPath, data, options?) [1.12.3]`, `process(normalizedPath, fn, options?)`, `getResourcePath(normalizedPath)`, `getFilePath(normalizedPath) [0.14.3]`, `remove(normalizedPath)`, `rename(normalizedPath, normalizedNewPath)`, `copy(normalizedPath, normalizedNewPath)`, `exists(normalizedPath, sensitive?)`, `stat(normalizedPath) [0.12.2]`, `list(normalizedPath)`, `getFullPath(normalizedPath)`, `static readLocalFile(path)`, `static mkdir(path)` |
| [ ] | interface | `ListedFiles` | `files`, `folders` |
| [ ] | function | `normalizePath(path)` |  |
| [ ] | class | `SecretStorage` extends Events [1.11.4] | `setSecret(id, secret) [1.11.4]`, `getSecret(id) [1.11.4]`, `listSecrets() [1.11.4]` |
| [ ] | interface | `Stat` | `type`, `ctime`, `mtime`, `size` |
| [ ] | abstract class | `TAbstractFile` [0.9.7] | `vault [0.9.7]`, `path [0.9.7]`, `name [0.9.7]`, `parent [0.9.7]` |
| [ ] | class | `TFile` extends TAbstractFile [0.9.7] | `stat [0.9.7]`, `basename [0.9.7]`, `extension [0.9.7]` |
| [ ] | class | `TFolder` extends TAbstractFile [0.9.7] | `children [0.9.7]`, `isRoot() [0.9.7]` |
| [ ] | class | `Vault` extends Events [0.9.7] | `adapter [0.9.7]`, `configDir [0.11.1]`, `getName() [0.9.7]`, `getFileByPath(path) [1.5.7]`, `getFolderByPath(path) [1.5.7]`, `getAbstractFileByPath(path) [0.11.11]`, `getRoot() [0.9.7]`, `create(path, data, options?) [0.9.7]`, `createBinary(path, data, options?) [0.9.7]`, `createFolder(path) [1.4.0]`, `read(file) [0.9.7]`, `cachedRead(file) [0.9.7]`, `readBinary(file) [0.9.7]`, `getResourcePath(file) [0.9.7]`, `delete(file, force?) [0.9.7]`, `trash(file, system) [0.9.7]`, `rename(file, newPath) [0.9.11]`, `modify(file, data, options?) [0.9.7]`, `modifyBinary(file, data, options?) [0.9.7]`, `append(file, data, options?) [0.13.0]`, `appendBinary(file, data, options?) [1.12.3]`, `process(file, fn, options?) [1.1.0]`, `copy(file, newPath) [1.8.7]`, `getAllLoadedFiles() [0.9.7]`, `getAllFolders(includeRoot?) [1.6.6]`, `static recurseChildren(root, cb) [0.9.7]`, `getMarkdownFiles() [0.9.7]`, `getFiles() [0.9.7]`, `on(name, callback, ctx?) [0.9.7]` |

#### FileManager (1 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | class | `FileManager` [0.9.7] | `getNewFileParent(sourcePath, newFilePath?) [1.1.13]`, `renameFile(file, newPath) [0.11.0]`, `promptForDeletion(file) [0.15.0]`, `trashFile(file) [1.6.6]`, `generateMarkdownLink(file, sourcePath, subpath?, alias?) [0.12.0]`, `processFrontMatter(file, fn, options?) [1.4.4]`, `getAvailablePathForAttachment(filename, sourcePath?) [1.5.7]` |

#### MetadataCache & link/frontmatter parsing (40 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | interface | `BlockCache` extends CacheItem [0.11.13] | `id` |
| [ ] | interface | `BlockSubpathResult` extends SubpathResult [0.13.26] | `type`, `block`, `list?` |
| [ ] | interface | `CachedMetadata` | `links?`, `embeds?`, `tags?`, `headings?`, `footnotes? [1.6.6]`, `footnoteRefs? [1.8.7]`, `referenceLinks? [1.8.7]`, `sections?`, `listItems?`, `frontmatter?`, `frontmatterPosition? [1.4.0]`, `frontmatterLinks? [1.4.0]`, `blocks?` |
| [ ] | interface | `CacheItem` | `position` |
| [ ] | interface | `EmbedCache` extends ReferenceCache [0.9.7] |  |
| [ ] | interface | `FootnoteCache` extends CacheItem | `id` |
| [ ] | interface | `FootnoteRefCache` extends CacheItem | `id` |
| [ ] | interface | `FootnoteSubpathResult` extends SubpathResult [1.7.2] | `type`, `footnote` |
| [ ] | interface | `FrontMatterCache` | `[index]` |
| [ ] | interface | `FrontMatterInfo` | `exists`, `frontmatter`, `from`, `to`, `contentStart` |
| [ ] | interface | `FrontmatterLinkCache` extends Reference | `key` |
| [ ] | function | `getAllTags(cache)` |  |
| [ ] | function | `getFrontMatterInfo(content)` [1.5.7] |  |
| [ ] | function | `getLinkpath(linktext)` |  |
| [ ] | interface | `HeadingCache` extends CacheItem | `heading`, `level` |
| [ ] | interface | `HeadingSubpathResult` extends SubpathResult [0.9.16] | `type [0.9.16]`, `current [0.9.16]`, `next [0.9.16]` |
| [ ] | function | `iterateCacheRefs(cache, cb)` [deprecated] |  |
| [ ] | function | `iterateRefs(refs, cb)` |  |
| [ ] | interface | `LinkCache` extends ReferenceCache [0.9.7] |  |
| [ ] | interface | `ListItemCache` extends CacheItem | `id?`, `task?`, `parent` |
| [ ] | interface | `Loc` | `line`, `col`, `offset` |
| [ ] | class | `MetadataCache` extends Events | `getFirstLinkpathDest(linkpath, sourcePath) [0.12.5]`, `getFileCache(file) [0.9.21]`, `getCache(path) [0.14.5]`, `fileToLinktext(file, sourcePath, omitMdExtension?)`, `resolvedLinks`, `unresolvedLinks`, `on(name, callback, ctx?)` |
| [ ] | function | `parseFrontMatterAliases(frontmatter)` |  |
| [ ] | function | `parseFrontMatterEntry(frontmatter, key)` |  |
| [ ] | function | `parseFrontMatterStringArray(frontmatter, key)` |  |
| [ ] | function | `parseFrontMatterTags(frontmatter)` |  |
| [ ] | function | `parseLinktext(linktext)` |  |
| [ ] | function | `parsePropertyId(propertyId)` [1.10.0] |  |
| [ ] | function | `parseYaml(yaml)` |  |
| [ ] | interface | `Pos` | `start`, `end` |
| [ ] | interface | `Reference` | `link`, `original`, `displayText?` |
| [ ] | interface | `ReferenceCache` extends Reference, CacheItem |  |
| [ ] | interface | `ReferenceLinkCache` extends CacheItem [1.8.7] | `id`, `link` |
| [ ] | function | `resolveSubpath(cache, subpath)` |  |
| [ ] | interface | `SectionCache` extends CacheItem | `id?`, `type` |
| [ ] | function | `stringifyYaml(obj)` |  |
| [ ] | function | `stripHeading(heading)` |  |
| [ ] | function | `stripHeadingForLink(heading)` |  |
| [ ] | interface | `SubpathResult` | `start`, `end` |
| [ ] | interface | `TagCache` extends CacheItem [0.9.7] | `tag` |

#### Workspace & layout (24 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | interface | `HoverLinkSource` | `display`, `defaultMod` |
| [ ] | interface | `HoverParent` [0.11.13] | `hoverPopover [0.11.13]` |
| [ ] | class | `HoverPopover` extends Component [0.15.0] | `hoverEl`, `state`, `constructor(parent, targetEl, waitTime?, staticPos?)` |
| [ ] | interface | `OpenViewState` | `state?`, `eState?`, `active?`, `group?` |
| [ ] | type | `PaneType` = `'tab' \| 'split' \| 'window'` |  |
| [ ] | enum | `PopoverState` |  |
| [ ] | type | `Side` = `'left' \| 'right'` |  |
| [ ] | type | `SplitDirection` = `'vertical' \| 'horizontal'` |  |
| [ ] | interface | `ViewState` | `type`, `state?`, `active?`, `pinned?`, `group?` |
| [ ] | interface | `ViewStateResult` | `history` |
| [ ] | class | `Workspace` extends Events [0.9.7] | `leftSplit [0.9.7]`, `rightSplit [0.9.7]`, `leftRibbon [0.9.7]`, `rightRibbon [deprecated]`, `rootSplit [0.9.7]`, `activeLeaf [0.9.7] [deprecated]`, `containerEl [0.9.7]`, `layoutReady [0.9.7]`, `requestSaveLayout [0.16.0]`, `activeEditor`, `onLayoutReady(callback) [0.11.0]`, `changeLayout(workspace) [0.9.7]`, `getLayout() [0.9.7]`, `createLeafInParent(parent, index) [0.9.11]`, `createLeafBySplit(leaf, direction?, before?) [0.9.7]`, `splitActiveLeaf(direction?) [0.9.7] [deprecated]`, `duplicateLeaf(leaf, direction?) [0.13.8] [deprecated]`, `duplicateLeaf(leaf, leafType, direction?) [1.1.0]`, `getUnpinnedLeaf() [deprecated]`, `getLeaf(newLeaf?, direction?) [0.16.0]`, `getLeaf(newLeaf?) [0.16.0]`, `moveLeafToPopout(leaf, data?) [0.15.4]`, `openPopoutLeaf(data?) [0.15.4]`, `openLinkText(linktext, sourcePath, newLeaf?, openViewState?) [0.16.0]`, `setActiveLeaf(leaf, params?) [0.16.3]`, `setActiveLeaf(leaf, pushHistory, focus) [deprecated]`, `getLeafById(id) [1.5.1]`, `getGroupLeaves(group) [0.9.7]`, `getMostRecentLeaf(root?) [0.15.4]`, `getLeftLeaf(split) [0.9.7]`, `getRightLeaf(split) [0.9.7]`, `ensureSideLeaf(type, side, options?) [1.7.2]`, `getActiveViewOfType(type) [0.9.16]`, `getActiveFile()`, `iterateRootLeaves(callback) [0.9.7]`, `iterateAllLeaves(callback) [0.9.7]`, `getLeavesOfType(viewType) [0.9.7]`, `detachLeavesOfType(viewType) [0.9.7]`, `revealLeaf(leaf) [1.7.2]`, `getLastOpenFiles() [0.9.7]`, `updateOptions() [0.13.21]`, `handleLinkContextMenu(menu, linktext, sourcePath, leaf?) [0.12.10]`, `on(name, callback, ctx?) [0.9.7]`, `on(name, callback, ctx?) [0.10.9]`, `on(name, callback, ctx?) [0.9.20]`, `on(name, callback, ctx?) [0.15.3]`, `on(name, callback, ctx?) [0.9.12]`, `on(name, callback, ctx?) [1.4.10]`, `on(name, callback, ctx?) [1.5.1]`, `on(name, callback, ctx?) [1.1.0]`, `on(name, callback, ctx?) [1.1.1]`, `on(name, callback, ctx?) [0.10.2]` |
| [ ] | abstract class | `WorkspaceContainer` extends WorkspaceSplit [0.15.4] | `abstract win [0.15.4]`, `abstract doc [0.15.4]` |
| [ ] | class | `WorkspaceFloating` extends WorkspaceParent [0.15.2] | `parent [0.15.2]` |
| [ ] | abstract class | `WorkspaceItem` extends Events [0.10.2] | `abstract parent [1.6.6]`, `getRoot() [0.10.2]`, `getContainer() [0.15.4]` |
| [ ] | class | `WorkspaceLeaf` extends WorkspaceItem implements HoverParent | `parent`, `view`, `hoverPopover`, `openFile(file, openState?)`, `open(view)`, `getViewState()`, `setViewState(viewState, eState?)`, `isDeferred [1.7.2]`, `loadIfDeferred() [1.7.2]`, `getEphemeralState()`, `setEphemeralState(state)`, `togglePinned()`, `setPinned(pinned)`, `setGroupMember(other)`, `setGroup(group)`, `detach()`, `getIcon()`, `getDisplayText()`, `onResize()`, `on(name, callback, ctx?)` |
| [ ] | class | `WorkspaceMobileDrawer` extends WorkspaceParent [1.6.6] | `parent`, `collapsed`, `expand()`, `collapse()`, `toggle()` |
| [ ] | abstract class | `WorkspaceParent` extends WorkspaceItem [0.9.7] |  |
| [ ] | class | `WorkspaceRibbon` |  |
| [ ] | class | `WorkspaceRoot` extends WorkspaceContainer [0.15.2] | `win`, `doc` |
| [ ] | class | `WorkspaceSidedock` extends WorkspaceSplit [0.15.4] | `collapsed [0.12.11]`, `toggle() [0.12.11]`, `collapse() [0.12.11]`, `expand() [0.12.11]` |
| [ ] | class | `WorkspaceSplit` extends WorkspaceParent [0.9.7] | `parent` |
| [ ] | class | `WorkspaceTabs` extends WorkspaceParent | `parent` |
| [ ] | class | `WorkspaceWindow` extends WorkspaceContainer [0.15.4] | `win`, `doc` |
| [ ] | interface | `WorkspaceWindowInitData` | `x?`, `y?`, `size?` |

#### Views (11 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | abstract class | `EditableFileView` extends FileView [0.9.7] |  |
| [ ] | abstract class | `FileView` extends ItemView | `allowNoFile`, `file`, `navigation`, `constructor(leaf)`, `getDisplayText()`, `onload()`, `getState()`, `setState(state, result) [0.9.7]`, `onLoadFile(file)`, `onUnloadFile(file)`, `onRename(file)`, `canAcceptExtension(extension) [0.9.7]` |
| [ ] | abstract class | `ItemView` extends View [0.9.7] | `contentEl`, `constructor(leaf)`, `addAction(icon, title, callback) [1.1.0]` |
| [ ] | class | `MarkdownEditView` implements MarkdownSubView, HoverParent, MarkdownFileInfo | `app`, `hoverPopover`, `constructor(view)`, `clear()`, `get()`, `set(data, clear)`, `file`, `getSelection()`, `getScroll()`, `applyScroll(scroll)` |
| [ ] | interface | `MarkdownFileInfo` extends HoverParent | `app`, `file`, `editor?` |
| [ ] | interface | `MarkdownSubView` | `getScroll()`, `applyScroll(scroll)`, `get()`, `set(data, clear)` |
| [ ] | class | `MarkdownView` extends TextFileView implements MarkdownFileInfo | `editor`, `previewMode`, `currentMode`, `hoverPopover`, `constructor(leaf)`, `getViewType()`, `getMode()`, `getViewData()`, `clear()`, `setViewData(data, clear)`, `showSearch(replace?)` |
| [ ] | type | `MarkdownViewModeType` = `'source' \| 'preview'` |  |
| [ ] | abstract class | `TextFileView` extends EditableFileView [0.10.12] | `data [0.10.12]`, `requestSave [0.10.12]`, `constructor(leaf)`, `onUnloadFile(file) [0.10.12]`, `onLoadFile(file) [0.10.12]`, `save(clear?) [0.10.12]`, `abstract getViewData() [0.10.12]`, `abstract setViewData(data, clear) [0.10.12]`, `abstract clear() [0.10.12]` |
| [ ] | abstract class | `View` extends Component [0.9.7] | `app [0.9.7]`, `icon [1.1.0]`, `navigation [0.15.1]`, `leaf [0.9.7]`, `containerEl [0.9.7]`, `scope [1.5.7]`, `constructor(leaf) [0.9.7]`, `onOpen() [0.9.7]`, `onClose() [0.9.7]`, `abstract getViewType() [0.9.7]`, `getState() [0.9.7]`, `setState(state, result) [0.9.7]`, `getEphemeralState() [0.9.7]`, `setEphemeralState(state) [0.9.7]`, `getIcon() [1.1.0]`, `onResize() [0.9.7]`, `abstract getDisplayText() [0.9.7]`, `onPaneMenu(menu, source) [0.15.3]` |
| [ ] | type | `ViewCreator` = `(leaf: WorkspaceLeaf) => View` |  |

#### Editor (CM6 abstraction) (16 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | abstract class | `Editor` [0.11.11] | `getDoc() [0.11.11]`, `abstract refresh() [0.11.11]`, `abstract getValue() [0.11.11]`, `abstract setValue(content) [0.11.11]`, `abstract getLine(line) [0.11.11]`, `setLine(n, text) [0.11.11]`, `abstract lineCount() [0.11.11]`, `abstract lastLine() [0.11.11]`, `abstract getSelection() [0.11.11]`, `somethingSelected() [0.11.11]`, `abstract getRange(from, to) [0.11.11]`, `abstract replaceSelection(replacement, origin?) [0.11.11]`, `abstract replaceRange(replacement, from, to?, origin?) [0.11.11]`, `abstract getCursor(side?) [0.11.11]`, `abstract listSelections() [0.11.11]`, `setCursor(pos, ch?) [0.11.11]`, `abstract setSelection(anchor, head?) [0.11.11]`, `abstract setSelections(ranges, main?) [0.12.11]`, `abstract focus() [0.11.11]`, `abstract blur() [0.11.11]`, `abstract hasFocus() [0.11.11]`, `abstract getScrollInfo() [0.11.11]`, `abstract scrollTo(x?, y?) [0.11.11]`, `abstract scrollIntoView(range, center?) [0.13.0]`, `abstract undo() [0.11.11]`, `abstract redo() [0.11.11]`, `abstract exec(command) [0.12.2]`, `abstract transaction(tx, origin?) [0.13.0]`, `abstract wordAt(pos) [0.11.11]`, `abstract posToOffset(pos) [0.11.11]`, `abstract offsetToPos(offset) [0.11.11]`, `processLines(read, write, ignoreEmpty?) [0.13.26]` |
| [ ] | interface | `EditorChange` extends EditorRangeOrCaret [0.12.11] | `text` |
| [ ] | type | `EditorCommandName` = `'goUp' \| 'goDown' \| 'goLeft' \| 'goRight' \| 'goStart' \| 'goEnd' \| 'goWordLeft' \| 'goWordRight' \| 'indentMore' \| 'indentLess' \| 'newlineAndInd` |  |
| [ ] | const | `editorEditorField`: `StateField<EditorView>` |  |
| [ ] | const | `editorInfoField`: `StateField<MarkdownFileInfo>` |  |
| [ ] | const | `editorLivePreviewField`: `StateField<boolean>` |  |
| [ ] | interface | `EditorPosition` [0.12.11] | `line`, `ch` |
| [ ] | interface | `EditorRange` [0.12.11] | `from`, `to` |
| [ ] | interface | `EditorRangeOrCaret` [0.12.11] | `from`, `to?` |
| [ ] | interface | `EditorScrollInfo` [0.15.0] | `left`, `top`, `width`, `height`, `clientWidth`, `clientHeight` |
| [ ] | interface | `EditorSelection` [0.12.11] | `anchor`, `head` |
| [ ] | interface | `EditorSelectionOrCaret` [0.12.11] | `anchor`, `head?` |
| [ ] | interface | `EditorTransaction` | `replaceSelection?`, `changes?`, `selections?`, `selection?` |
| [ ] | const | `editorViewField` [deprecated]: `StateField<MarkdownFileInfo>` |  |
| [ ] | const | `livePreviewState`: `ViewPlugin<LivePreviewStateType, undefined>` |  |
| [ ] | interface | `LivePreviewStateType` | `mousedown` |

#### Markdown rendering & post-processing (16 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | function | `finishRenderMath()` |  |
| [ ] | function | `htmlToMarkdown(html)` |  |
| [ ] | function | `loadMathJax()` |  |
| [ ] | function | `loadMermaid()` |  |
| [ ] | function | `loadPdfJs()` |  |
| [ ] | function | `loadPrism()` |  |
| [ ] | interface | `MarkdownPostProcessor` [0.10.12] | `(call)`, `sortOrder?` |
| [ ] | interface | `MarkdownPostProcessorContext` | `docId`, `sourcePath`, `frontmatter`, `addChild(child)`, `getSectionInfo(el)` |
| [ ] | interface | `MarkdownPreviewEvents` extends Component |  |
| [ ] | class | `MarkdownPreviewRenderer` [0.9.7] | `static registerPostProcessor(postProcessor, sortOrder?) [0.10.12]`, `static unregisterPostProcessor(postProcessor) [0.9.7]`, `static createCodeBlockPostProcessor(language, handler) [0.12.11]` |
| [ ] | class | `MarkdownPreviewView` extends MarkdownRenderer implements MarkdownSubView, MarkdownPreviewEvents | `containerEl`, `file`, `get()`, `set(data, clear)`, `clear()`, `rerender(full?)`, `getScroll()`, `applyScroll(scroll)` |
| [ ] | class | `MarkdownRenderChild` extends Component | `containerEl`, `constructor(containerEl)` |
| [ ] | abstract class | `MarkdownRenderer` extends MarkdownRenderChild implements MarkdownPreviewEvents, HoverParent [0.9.7] | `app`, `hoverPopover`, `abstract file`, `static renderMarkdown(markdown, el, sourcePath, component) [0.10.6] [deprecated]`, `static render(app, markdown, el, sourcePath, component)` |
| [ ] | interface | `MarkdownSectionInformation` | `text`, `lineStart`, `lineEnd` |
| [ ] | function | `renderMath(source, display)` |  |
| [ ] | function | `sanitizeHTMLToDom(html)` |  |

#### Modal, Notice, Menu, tooltip (11 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | class | `ConfirmationModal` extends Modal [1.13.0] | `buttonContainerEl [1.13.0]`, `constructor(app) [1.13.0]`, `addClass(cls) [1.13.0]`, `addCheckbox(label, cb) [1.13.0]`, `addButton(cb) [1.13.0]`, `addCancelButton(text?) [1.13.0]` |
| [ ] | function | `displayTooltip(newTargetEl, content, options?)` [1.8.7] |  |
| [ ] | class | `Menu` extends Component implements HistoryHandler | `constructor()`, `setNoIcon()`, `setUseNativeMenu(useNativeMenu) [0.16.0]`, `addItem(cb) [0.15.3]`, `addSeparator() [0.15.3]`, `setParentElement(el) [0.16.0]`, `showAtMouseEvent(evt) [0.12.6]`, `showAtPosition(position, doc?) [1.1.0]`, `hide()`, `close()`, `onHide(callback)`, `static forEvent(evt) [1.6.0]` |
| [ ] | class | `MenuItem` | `constructor()`, `setTitle(title)`, `setIcon(icon) [0.16.2]`, `setChecked(checked) [0.16.2]`, `setDisabled(disabled) [0.15.0]`, `setWarning(isWarning) [0.15.0]`, `setIsLabel(isLabel) [0.15.0]`, `onClick(callback)`, `setSection(section) [0.15.3]` |
| [ ] | interface | `MenuPositionDef` [1.1.0] | `x`, `y`, `width?`, `overlap?`, `left?` |
| [ ] | class | `MenuSeparator` [0.15.3] |  |
| [ ] | class | `Modal` implements HistoryHandler | `app`, `scope`, `containerEl`, `modalEl`, `titleEl`, `contentEl`, `shouldRestoreSelection [0.9.16]`, `constructor(app)`, `open()`, `close()`, `onOpen()`, `onClose()`, `setTitle(title)`, `setContent(content)`, `setCloseCallback(callback) [1.10.0]` |
| [ ] | class | `Notice` [0.9.7] | `noticeEl [0.9.7] [deprecated]`, `containerEl [1.8.7]`, `messageEl [1.8.7]`, `constructor(message, duration?)`, `setMessage(message) [0.9.7]`, `hide() [0.9.7]` |
| [ ] | function | `setTooltip(el, tooltip, options?)` [1.4.4] |  |
| [ ] | interface | `TooltipOptions` | `placement?`, `classes? [1.8.7]`, `gap? [1.8.7]`, `delay? [1.4.11]` |
| [ ] | type | `TooltipPlacement` = `'bottom' \| 'right' \| 'left' \| 'top'` |  |

#### Suggest & fuzzy search (19 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | abstract class | `AbstractInputSuggest<T>` extends PopoverSuggest<T> [1.4.10] | `limit [1.4.10]`, `constructor(app, textInputEl)`, `setValue(value) [1.4.10]`, `getValue() [1.4.10]`, `abstract getSuggestions(query) [1.5.7]`, `selectSuggestion(value, evt) [1.6.6]`, `onSelect(callback) [1.4.10]` |
| [ ] | abstract class | `EditorSuggest<T>` extends PopoverSuggest<T> [0.12.17] | `context [0.12.17]`, `limit [0.12.17]`, `constructor(app)`, `setInstructions(instructions) [0.13.0]`, `abstract onTrigger(cursor, editor, file) [1.1.13]`, `abstract getSuggestions(context) [0.12.17]` |
| [ ] | interface | `EditorSuggestContext` extends EditorSuggestTriggerInfo [0.12.17] | `editor`, `file` |
| [ ] | interface | `EditorSuggestTriggerInfo` [0.12.17] | `start`, `end`, `query` |
| [ ] | interface | `FuzzyMatch<T>` [0.9.20] | `item [0.9.20]`, `match` |
| [ ] | abstract class | `FuzzySuggestModal<T>` extends SuggestModal<FuzzyMatch<T>> [0.9.20] | `getSuggestions(query) [0.9.20]`, `renderSuggestion(item, el) [0.9.20]`, `onChooseSuggestion(item, evt) [0.9.20]`, `abstract getItems() [0.9.20]`, `abstract getItemText(item) [0.9.20]`, `abstract onChooseItem(item, evt) [0.9.20]` |
| [ ] | interface | `Instruction` [0.9.20] | `command [0.9.20]`, `purpose [0.9.20]` |
| [ ] | interface | `ISuggestOwner<T>` | `renderSuggestion(value, el)`, `selectSuggestion(value, evt)` |
| [ ] | abstract class | `PopoverSuggest<T>` implements ISuggestOwner<T>, HistoryHandler | `app`, `scope`, `constructor(app, scope?)`, `open()`, `close()`, `abstract renderSuggestion(value, el)`, `abstract selectSuggestion(value, evt)` |
| [ ] | function | `prepareFuzzySearch(query)` |  |
| [ ] | function | `prepareSimpleSearch(query)` |  |
| [ ] | function | `renderMatches(el, text, matches, offset?)` |  |
| [ ] | function | `renderResults(el, text, result, offset?)` |  |
| [ ] | type | `SearchMatches` = `SearchMatchPart[]` |  |
| [ ] | type | `SearchMatchPart` = `[number, number]` |  |
| [ ] | interface | `SearchResult` [0.9.21] | `score`, `matches` |
| [ ] | interface | `SearchResultContainer` [0.9.21] | `match` |
| [ ] | function | `sortSearchResults(results)` |  |
| [ ] | abstract class | `SuggestModal<T>` extends Modal implements ISuggestOwner<T> | `limit`, `emptyStateText [0.9.20]`, `inputEl`, `resultContainerEl [0.9.20]`, `constructor(app)`, `setPlaceholder(placeholder) [0.9.20]`, `setInstructions(instructions) [0.9.20]`, `onNoSuggestion() [0.9.20]`, `selectSuggestion(value, evt) [0.9.20]`, `selectActiveSuggestion(evt) [1.7.2]`, `abstract getSuggestions(query) [1.5.7]`, `abstract renderSuggestion(value, el) [1.5.7]`, `abstract onChooseSuggestion(item, evt) [1.5.7]` |

#### Setting UI components (47 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | class | `AbstractTextComponent<T>` extends ValueComponent<string> [0.9.21] | `inputEl [0.9.7]`, `constructor(inputEl)`, `setDisabled(disabled) [1.2.3]`, `getValue() [0.9.7]`, `setValue(value) [0.9.7]`, `setPlaceholder(placeholder) [0.9.7]`, `onChanged() [0.9.21]`, `onChange(callback) [0.9.7]` |
| [ ] | abstract class | `BaseComponent` [0.10.3] | `disabled [0.10.3]`, `then(cb) [0.9.7]`, `setDisabled(disabled) [1.2.3]` |
| [ ] | class | `ButtonComponent` extends BaseComponent [0.9.7] | `buttonEl [0.9.7]`, `constructor(containerEl)`, `setDisabled(disabled) [1.2.3]`, `setCta() [0.9.7]`, `removeCta() [0.9.20]`, `setWarning() [0.11.0] [deprecated]`, `setDestructive() [1.13.0]`, `removeDestructive() [1.13.0]`, `setTooltip(tooltip, options?) [1.1.0]`, `setButtonText(name) [0.9.7]`, `setIcon(icon) [1.1.0]`, `setClass(cls) [0.9.7]`, `onClick(callback) [0.12.16]` |
| [ ] | class | `ColorComponent` extends ValueComponent<string> [1.0.0] | `constructor(containerEl)`, `setDisabled(disabled) [1.2.3]`, `getValue() [1.0.0]`, `getValueRgb() [1.0.0]`, `getValueHsl() [1.0.0]`, `setValue(value) [1.0.0]`, `setValueRgb(rgb) [1.0.0]`, `setValueHsl(hsl) [1.0.0]`, `onChange(callback) [1.0.0]` |
| [ ] | class | `ConfirmationButton` extends ButtonComponent [1.13.0] | `constructor()`, `onClick(handler) [1.13.0]`, `setInitialFocus() [1.13.0]`, `setSecondary() [1.13.0]`, `setCancel() [1.13.0]` |
| [ ] | class | `DisplayValueComponent` [1.13.1] | `valueEl [1.13.1]`, `constructor(containerEl)`, `setValue(value) [1.13.1]`, `setStatus(status) [1.13.1]` |
| [ ] | class | `DropdownComponent` extends ValueComponent<string> [0.9.7] | `selectEl [0.9.7]`, `constructor(containerEl)`, `setDisabled(disabled) [1.2.3]`, `addOption(value, display) [0.9.7]`, `addOptions(options) [0.9.7]`, `getValue() [0.9.7]`, `setValue(value) [0.9.7]`, `onChange(callback) [0.9.7]` |
| [ ] | class | `ExtraButtonComponent` extends BaseComponent [0.9.7] | `extraSettingsEl [0.9.7]`, `constructor(containerEl)`, `setDisabled(disabled) [1.2.3]`, `setTooltip(tooltip, options?) [1.1.0]`, `setIcon(icon) [0.9.7]`, `onClick(callback) [0.9.7]` |
| [ ] | type | `HexString` = `string` |  |
| [ ] | interface | `HSL` [0.16.0] | `h [0.16.0]`, `s [0.16.0]`, `l [0.16.0]` |
| [ ] | class | `MomentFormatComponent` extends TextComponent [0.9.7] | `sampleEl [0.9.7]`, `setDefaultFormat(defaultFormat) [0.9.7]`, `setSampleEl(sampleEl) [0.9.7]`, `setValue(value) [0.9.7]`, `onChanged() [0.9.7]`, `updateSample() [0.9.7]` |
| [ ] | class | `ProgressBarComponent` extends ValueComponent<number> [1.4.4] | `constructor(containerEl)`, `getValue()`, `setValue(value)` |
| [ ] | interface | `RGB` [0.16.0] | `r`, `g`, `b` |
| [ ] | class | `SearchComponent` extends AbstractTextComponent<HTMLInputElement> [0.9.21] | `clearButtonEl [0.9.21]`, `constructor(containerEl)`, `onChanged()` |
| [ ] | class | `SecretComponent` extends BaseComponent [1.11.1] | `constructor(app, containerEl)`, `setValue(value) [1.11.4]`, `onChange(cb) [1.11.4]` |
| [ ] | class | `Setting` [0.9.7] | `settingEl [0.9.7]`, `infoEl [0.9.7]`, `nameEl [0.9.7]`, `descEl [0.9.7]`, `controlEl [0.9.7]`, `components [0.9.7]`, `errorEl [1.13.0]`, `constructor(containerEl)`, `setErrorMessage(message) [1.13.0]`, `addDisplayValue(cb) [1.13.1]`, `setName(name) [0.9.7]`, `setName(name) [0.12.16]`, `setDesc(desc) [0.9.7]`, `setClass(cls) [0.9.7]`, `setTooltip(tooltip, options?) [1.1.0]`, `setHeading() [0.9.16]`, `setDisabled(disabled) [1.2.3]`, `addButton(cb) [0.9.7]`, `addExtraButton(cb) [0.9.16]`, `addToggle(cb) [0.9.7]`, `addText(cb) [0.9.7]`, `addComponent(cb) [1.11.0]`, `addSearch(cb) [0.9.21]`, `addTextArea(cb) [0.9.7]`, `addMomentFormat(cb) [0.9.7]`, `addDropdown(cb)`, `addColorPicker(cb)`, `addProgressBar(cb)`, `addSlider(cb) [0.9.7]`, `then(cb) [0.9.20]`, `clear() [0.13.8]` |
| [ ] | interface | `SettingColorControl<K>` extends SettingControlBase<HexString, K> [1.13.0] | `type [1.13.0]` |
| [ ] | type | `SettingControl` [1.13.0] = `SettingToggleControl<K> \| SettingDropdownControl<K> \| SettingTextControl<K> \| SettingTextAreaControl<K> \| SettingNumberControl<K> \| SettingF` |  |
| [ ] | interface | `SettingControlBase<V,K>` [1.13.0] | `key [1.13.0]`, `defaultValue? [1.13.0]`, `validate? [1.13.0]`, `disabled? [1.13.0]` |
| [ ] | type | `SettingDefinition` [1.13.0] = `SettingDefinitionControl<K> \| SettingDefinitionRender \| SettingDefinitionAction \| SettingDefinitionEmpty` |  |
| [ ] | interface | `SettingDefinitionAction` extends SettingDefinitionBase [1.13.0] | `action [1.13.0]`, `disabled? [1.13.0]`, `control? [1.13.0]`, `render? [1.13.0]` |
| [ ] | interface | `SettingDefinitionAddItem` [1.13.0] | `name [1.13.0]`, `action [1.13.0]` |
| [ ] | interface | `SettingDefinitionBase` [1.13.0] | `name [1.13.0]`, `desc? [1.13.0]`, `aliases? [1.13.0]`, `searchable? [1.13.0]`, `visible? [1.13.0]` |
| [ ] | interface | `SettingDefinitionControl<K>` extends SettingDefinitionBase [1.13.0] | `control [1.13.0]`, `action? [1.13.0]`, `render? [1.13.0]` |
| [ ] | interface | `SettingDefinitionEmpty` extends SettingDefinitionBase [1.13.0] | `control? [1.13.0]`, `action? [1.13.0]`, `render? [1.13.0]` |
| [ ] | interface | `SettingDefinitionGroup<K>` [1.13.0] | `type [1.13.0]`, `heading? [1.13.0]`, `cls? [1.13.0]`, `search? [1.13.1]`, `extraButtons? [1.13.0]`, `items? [1.13.0]`, `visible? [1.13.0]` |
| [ ] | type | `SettingDefinitionItem` [1.13.0] = `SettingDefinition<K> \| SettingDefinitionGroup<K> \| SettingDefinitionList<K> \| SettingDefinitionPage<K>` |  |
| [ ] | interface | `SettingDefinitionList<K>` extends SettingDefinitionGroup<K> [1.13.0] | `type [1.13.0]`, `emptyState? [1.13.0]`, `onReorder? [1.13.0]`, `onDelete? [1.13.0]`, `addItem? [1.13.0]` |
| [ ] | interface | `SettingDefinitionPage<K>` [1.13.0] | `type [1.13.0]`, `name [1.13.0]`, `desc? [1.13.0]`, `displayValue? [1.13.1]`, `status? [1.13.1]`, `items? [1.13.0]`, `page? [1.13.0]`, `visible? [1.13.0]` |
| [ ] | interface | `SettingDefinitionRender` extends SettingDefinitionBase [1.13.0] | `control? [1.13.0]`, `action? [1.13.0]`, `render [1.13.0]` |
| [ ] | interface | `SettingDropdownControl<K>` extends SettingControlBase<string, K> [1.13.0] | `type [1.13.0]`, `options [1.13.0]` |
| [ ] | interface | `SettingFileControl<K>` extends SettingControlBase<string, K> [1.13.0] | `type [1.13.0]`, `placeholder? [1.13.0]`, `filter? [1.13.0]` |
| [ ] | interface | `SettingFolderControl<K>` extends SettingControlBase<string, K> [1.13.0] | `type [1.13.0]`, `placeholder? [1.13.0]`, `filter? [1.13.0]`, `includeRoot? [1.13.0]` |
| [ ] | class | `SettingGroup` [1.11.0] | `listEl [1.11.0]`, `constructor(containerEl) [1.11.0]`, `setHeading(text) [1.11.0]`, `addClass(classes) [1.11.0]`, `addSetting(cb) [1.11.0]`, `addSearch(cb) [1.11.0]`, `addExtraButton(cb) [1.11.0]` |
| [ ] | type | `SettingGroupItem` [1.13.0] = `SettingDefinition<K> \| SettingDefinitionPage<K>` |  |
| [ ] | interface | `SettingNumberControl<K>` extends SettingControlBase<number, K> [1.13.0] | `type [1.13.0]`, `placeholder? [1.13.0]`, `min? [1.13.0]`, `max? [1.13.0]`, `step? [1.13.0]` |
| [ ] | abstract class | `SettingPage` [1.13.0] | `rootEl [1.13.0]`, `titlebarEl [1.13.0]`, `containerEl [1.13.0]`, `title [1.13.0]`, `constructor() [1.13.0]`, `abstract display() [1.13.0]`, `hide() [1.13.0]` |
| [ ] | interface | `SettingSecretControl<K>` **(GitHub master 1.13.2 only — not in npm 1.13.1)** extends SettingControlBase<string, K> [1.13.2] | `type [1.13.2]` |
| [ ] | interface | `SettingSliderControl<K>` extends SettingControlBase<number, K> [1.13.0] | `type [1.13.0]`, `min [1.13.0]`, `max [1.13.0]`, `step [1.13.0]`, `displayFormat? [1.13.1]` |
| [ ] | interface | `SettingTextAreaControl<K>` extends SettingControlBase<string, K> [1.13.0] | `type [1.13.0]`, `placeholder? [1.13.0]`, `rows? [1.13.0]` |
| [ ] | interface | `SettingTextControl<K>` extends SettingControlBase<string, K> [1.13.0] | `type [1.13.0]`, `placeholder? [1.13.0]` |
| [ ] | interface | `SettingToggleControl<K>` extends SettingControlBase<boolean, K> [1.13.0] | `type [1.13.0]` |
| [ ] | class | `SliderComponent` extends ValueComponent<number> [0.9.7] | `sliderEl`, `constructor(containerEl)`, `setDisabled(disabled) [1.2.3]`, `setInstant(instant) [1.6.6]`, `setLimits(min, max, step) [0.9.7]`, `getValue() [0.9.7]`, `setValue(value) [0.9.7]`, `getValuePretty() [0.9.7]`, `setDisplayFormat(format) [1.13.0]`, `setDynamicTooltip() [0.9.7] [deprecated]`, `onChange(callback) [0.9.7]` |
| [ ] | class | `TextAreaComponent` extends AbstractTextComponent<HTMLTextAreaElement> [0.9.7] | `constructor(containerEl)` |
| [ ] | class | `TextComponent` extends AbstractTextComponent<HTMLInputElement> [0.9.21] | `constructor(containerEl)` |
| [ ] | class | `ToggleComponent` extends ValueComponent<boolean> [0.9.7] | `toggleEl [0.9.7]`, `constructor(containerEl) [0.9.7]`, `setDisabled(disabled) [1.2.3]`, `getValue() [0.9.7]`, `setValue(on) [0.9.7]`, `setTooltip(tooltip, options?) [1.1.1]`, `onClick() [0.9.7]`, `onChange(callback) [0.9.7]` |
| [ ] | abstract class | `ValueComponent<T>` extends BaseComponent [0.9.7] | `registerOptionListener(listeners, key) [0.9.7]`, `abstract getValue() [0.9.7]`, `abstract setValue(value) [0.9.7]` |

#### Keymap & Scope (6 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | class | `Keymap` [0.13.9] | `pushScope(scope) [0.13.9]`, `popScope(scope) [0.13.9]`, `static isModifier(evt, modifier) [0.12.17]`, `static isModEvent(evt?) [0.16.0]` |
| [ ] | interface | `KeymapContext` extends KeymapInfo | `vkey` |
| [ ] | interface | `KeymapEventHandler` extends KeymapInfo | `scope` |
| [ ] | type | `KeymapEventListener` = `(evt: KeyboardEvent, ctx: KeymapContext) => false \| any` |  |
| [ ] | interface | `KeymapInfo` [0.10.4] | `modifiers [0.10.4]`, `key [0.10.4]` |
| [ ] | class | `Scope` | `constructor(parent?)`, `register(modifiers, key, func)`, `unregister(handler)` |

#### Icons (6 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | function | `addIcon(iconId, svgContent)` |  |
| [ ] | function | `getIcon(iconId)` |  |
| [ ] | function | `getIconIds()` |  |
| [ ] | function | `removeIcon(iconId)` |  |
| [ ] | function | `setIcon(parent, iconId)` |  |
| [ ] | type | `IconName` = `string` |  |

#### Network (5 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | function | `request(request)` [0.12.11] |  |
| [ ] | function | `requestUrl(request)` |  |
| [ ] | interface | `RequestUrlParam` | `url`, `method?`, `contentType?`, `body?`, `headers?`, `throw?` |
| [ ] | interface | `RequestUrlResponse` | `status`, `headers`, `arrayBuffer`, `json`, `text` |
| [ ] | interface | `RequestUrlResponsePromise` extends Promise<RequestUrlResponse> | `arrayBuffer`, `json`, `text` |

#### Platform, moment, i18n, binary utils (11 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | function | `arrayBufferToBase64(buffer)` |  |
| [ ] | function | `arrayBufferToHex(data)` |  |
| [ ] | function | `base64ToArrayBuffer(base64)` |  |
| [ ] | function | `getBlobArrayBuffer(blob)` |  |
| [ ] | function | `getLanguage()` [1.8.7] |  |
| [ ] | function | `hexToArrayBuffer(hex)` |  |
| [ ] | interface | `HistoryHandler` | `onHistoryBack()`, `onHistoryForward?()` |
| [ ] | const | `moment`: `typeof Moment` |  |
| [ ] | const | `Platform` [0.12.2] | `isDesktop`, `isMobile`, `isDesktopApp`, `isMobileApp`, `isIosApp`, `isAndroidApp`, `isPhone`, `isTablet`, `isMacOS`, `isWin`, `isLinux`, `isSafari`, `resourcePathPrefix` |
| [ ] | interface | `Point` | `x`, `y` |
| [ ] | class | `Tasks` [0.10.2] | `add(callback) [0.10.2]`, `addPromise(promise) [0.10.2]`, `isEmpty() [0.10.2]`, `promise() [0.10.2]` |

#### Bases API (50 exports)

| Done | Kind | Export | Members |
|---|---|---|---|
| [ ] | type | `BasesAllOptions` [1.10.0] = `BasesOptions \| BasesOptionGroup<BasesOptions>` |  |
| [ ] | interface | `BasesConfigFile` [1.10.0] | `filters? [1.10.0]`, `properties? [1.10.0]`, `formulas? [1.10.0]`, `summaries? [1.10.0]`, `views? [1.10.0]` |
| [ ] | type | `BasesConfigFileFilter` [1.10.0] = `string \| { /** * @public * @since 1.10.0 */ and: BasesConfigFileFilter[]; } \| { /** * @public * @since 1.10.0 */ or: BasesConfigFileFilter[]` |  |
| [ ] | interface | `BasesConfigFileView` [1.10.0] | `type [1.10.0]`, `name [1.10.0]`, `filters? [1.10.0]`, `groupBy? [1.10.0]`, `order? [1.10.0]`, `summaries? [1.10.0]` |
| [ ] | interface | `BasesDropdownOption` extends BasesOption [1.10.0] | `type [1.10.0]`, `default? [1.10.0]`, `options [1.10.0]` |
| [ ] | class | `BasesEntry` implements FormulaContext [1.10.0] | `file [1.10.0]`, `getValue(propertyId) [1.10.0]` |
| [ ] | class | `BasesEntryGroup` [1.10.0] | `key? [1.10.0]`, `entries [1.10.0]`, `hasKey() [1.10.0]` |
| [ ] | interface | `BasesFileOption` extends BasesOption [1.10.2] | `type [1.10.2]`, `default? [1.10.2]`, `placeholder? [1.10.2]`, `filter? [1.10.2]` |
| [ ] | interface | `BasesFolderOption` extends BasesOption [1.10.2] | `type [1.10.2]`, `default? [1.10.2]`, `placeholder? [1.10.2]`, `filter? [1.10.2]` |
| [ ] | interface | `BasesFormulaOption` extends BasesOption [1.10.2] | `type [1.10.2]`, `default? [1.10.2]`, `placeholder? [1.10.2]` |
| [ ] | interface | `BasesMultitextOption` extends BasesOption [1.10.0] | `type [1.10.0]`, `default? [1.10.0]` |
| [ ] | interface | `BasesOption` [1.10.0] | `key [1.10.0]`, `type [1.10.0]`, `displayName [1.10.0]`, `shouldHide? [1.10.2]` |
| [ ] | interface | `BasesOptionGroup<T>` [1.10.0] | `type [1.10.0]`, `displayName [1.10.0]`, `items [1.10.0]`, `shouldHide? [1.10.2]` |
| [ ] | type | `BasesOptions` [1.10.0] = `BasesDropdownOption \| BasesFileOption \| BasesFolderOption \| BasesFormulaOption \| BasesMultitextOption \| BasesPropertyOption \| BasesSliderOpt` |  |
| [ ] | interface | `BasesProperty` [1.10.0] | `type [1.10.0]`, `name [1.10.0]` |
| [ ] | type | `BasesPropertyId` [1.10.0] = ``${BasesPropertyType}.${string}`` |  |
| [ ] | interface | `BasesPropertyOption` extends BasesOption [1.10.0] | `type [1.10.0]`, `default? [1.10.0]`, `placeholder? [1.10.0]`, `filter? [1.10.0]` |
| [ ] | type | `BasesPropertyType` [1.10.0] = `'note' \| 'formula' \| 'file'` |  |
| [ ] | class | `BasesQueryResult` [1.10.0] | `data [1.10.0]`, `groupedData [1.10.0]`, `properties [1.10.0]`, `getSummaryValue(queryController, entries, prop, summaryKey) [1.10.0]` |
| [ ] | interface | `BasesSliderOption` extends BasesOption [1.10.0] | `type [1.10.0]`, `default? [1.10.0]`, `min? [1.10.0]`, `max? [1.10.0]`, `step? [1.10.0]`, `instant? [1.10.0]` |
| [ ] | type | `BasesSortConfig` [1.10.0] = `{ /** * @public * @since 1.10.0 */ property: BasesPropertyId; /** * @public * @since 1.10.0 */ direction: 'ASC' \| 'DESC'; }` |  |
| [ ] | interface | `BasesTextOption` extends BasesOption [1.10.0] | `type [1.10.0]`, `default? [1.10.0]`, `placeholder? [1.10.0]` |
| [ ] | interface | `BasesToggleOption` extends BasesOption [1.10.0] | `type [1.10.0]`, `default? [1.10.0]` |
| [ ] | abstract class | `BasesView` extends Component [1.10.0] | `abstract type [1.10.0]`, `app [1.10.0]`, `config [1.10.0]`, `allProperties [1.10.0]`, `data [1.10.0]`, `constructor(controller) [1.10.0]`, `abstract onDataUpdated() [1.10.0]`, `createFileForView(baseFileName?, frontmatterProcessor?) [1.10.2]` |
| [ ] | class | `BasesViewConfig` [1.10.0] | `name [1.10.0]`, `get(key) [1.10.0]`, `getAsPropertyId(key) [1.10.0]`, `getEvaluatedFormula(view, key) [1.10.2]`, `set(key, value) [1.10.0]`, `getOrder() [1.10.0]`, `getSort() [1.10.0]`, `getDisplayName(propertyId) [1.10.0]` |
| [ ] | type | `BasesViewFactory` [1.10.0] = `(controller: QueryController, containerEl: HTMLElement) => BasesView` |  |
| [ ] | interface | `BasesViewRegistration` [1.10.0] | `name [1.10.0]`, `icon [1.10.0]`, `factory [1.10.0]`, `options? [1.10.0]` |
| [ ] | class | `BooleanValue` extends PrimitiveValue<boolean> [1.10.0] | `static type [1.10.0]` |
| [ ] | class | `DateValue` extends NotNullValue [1.10.0] | `toString() [1.10.0]`, `dateOnly() [1.10.0]`, `relative() [1.10.0]`, `isTruthy() [1.10.0]`, `static parseFromString(input) [1.10.0]` |
| [ ] | class | `DurationValue` extends NotNullValue [1.10.0] | `toString() [1.10.0]`, `isTruthy() [1.10.0]`, `addToDate(value, subtract?) [1.10.0]`, `getMilliseconds() [1.10.0]`, `static parseFromString(input) [1.10.0]`, `static fromMilliseconds(milliseconds) [1.10.0]` |
| [ ] | class | `FileValue` extends NotNullValue [1.10.0] | `toString() [1.10.0]`, `isTruthy() [1.10.0]` |
| [ ] | interface | `FormulaContext` [1.10.0] |  |
| [ ] | class | `HTMLValue` extends StringValue [1.10.0] |  |
| [ ] | class | `IconValue` extends StringValue [1.10.0] |  |
| [ ] | class | `ImageValue` extends StringValue [1.10.0] |  |
| [ ] | class | `LinkValue` extends StringValue [1.10.0] | `static parseFromString(app, input, sourcePath) [1.10.0]` |
| [ ] | class | `ListValue` extends NotNullValue [1.10.0] | `static type [1.10.0]`, `constructor(value) [1.10.0]`, `toString() [1.10.0]`, `isTruthy() [1.10.0]`, `includes(value) [1.10.0]`, `length() [1.10.0]`, `get(index) [1.10.0]`, `concat(other) [1.10.0]` |
| [ ] | abstract class | `NotNullValue` extends Value [1.10.0] |  |
| [ ] | class | `NullValue` extends Value [1.10.0] | `toString() [1.10.0]`, `isTruthy() [1.10.0]`, `static value [1.10.0]` |
| [ ] | class | `NumberValue` extends PrimitiveValue<number> [1.10.0] | `static type [1.10.0]` |
| [ ] | class | `ObjectValue` extends NotNullValue [1.10.0] | `static type [1.10.0]`, `toString() [1.10.0]`, `isTruthy() [1.10.0]`, `isEmpty() [1.10.0]`, `get(key) [1.10.0]` |
| [ ] | abstract class | `PrimitiveValue<T>` extends NotNullValue [1.10.0] | `constructor(value) [1.10.0]`, `toString() [1.10.0]`, `isTruthy() [1.10.0]` |
| [ ] | class | `QueryController` extends Component [1.10.0] |  |
| [ ] | class | `RegExpValue` extends NotNullValue [1.10.0] | `toString() [1.10.0]`, `isTruthy() [1.10.0]` |
| [ ] | class | `RelativeDateValue` extends DateValue [1.10.0] |  |
| [ ] | class | `RenderContext` implements HoverParent [1.10.0] | `hoverPopover [1.10.0]` |
| [ ] | class | `StringValue` extends PrimitiveValue<string> [1.10.0] | `static type [1.10.0]` |
| [ ] | class | `TagValue` extends StringValue [1.10.0] | `constructor(value) [1.10.0]` |
| [ ] | class | `UrlValue` extends StringValue [1.10.0] |  |
| [ ] | abstract class | `Value` [1.10.0] | `static type [1.10.0]`, `static equals(a, b) [1.10.0]`, `static looseEquals(a, b) [1.10.0]`, `abstract toString() [1.10.0]`, `abstract isTruthy() [1.10.0]`, `equals(other) [1.10.0]`, `looseEquals(other) [1.10.0]`, `renderTo(el, ctx) [1.10.0]` |

#### `declare global` augmentations (39 declarations)

| Done | Kind | Declaration | Members |
|---|---|---|---|
| [ ] | interface | `ObjectConstructor` | `isEmpty(object)`, `each(object, callback, context?)` |
| [ ] | interface | `ArrayConstructor` | `combine(arrays)` |
| [ ] | interface | `Array<T>` | `first()`, `last()`, `contains(target)`, `remove(target)`, `shuffle()`, `unique()`, `findLastIndex(predicate) [1.4.4]` |
| [ ] | interface | `Math` | `clamp(value, min, max)`, `square(value)` |
| [ ] | interface | `StringConstructor` | `isString(obj)` |
| [ ] | interface | `String` | `contains(target)`, `startsWith(searchString, position?)`, `endsWith(target, length?)`, `format(args)` |
| [ ] | interface | `NumberConstructor` | `isNumber(obj)` |
| [ ] | interface | `Node` | `detach()`, `empty()`, `insertAfter(node, child)`, `indexOf(other)`, `setChildrenInPlace(children)`, `appendText(val)`, `instanceOf(type)`, `doc`, `win`, `constructorWin` |
| [ ] | interface | `Element` extends Node | `getText()`, `setText(val)`, `addClass(classes)`, `addClasses(classes)`, `removeClass(classes)`, `removeClasses(classes)`, `toggleClass(classes, value)`, `hasClass(cls)`, `setAttr(qualifiedName, value)`, `setAttrs(obj)`, `getAttr(qualifiedName)`, `matchParent(selector, lastParent?)`, `getCssPropertyValue(property, pseudoElement?)`, `isActiveElement()` |
| [ ] | interface | `HTMLElement` extends Element | `show()`, `hide()`, `toggle(show)`, `toggleVisibility(visible)`, `isShown()`, `setCssStyles(styles)`, `setCssProps(props)`, `readonly innerWidth`, `readonly innerHeight` |
| [ ] | interface | `SVGElement` extends Element | `setCssStyles(styles)`, `setCssProps(props)` |
| [ ] | function | `isBoolean(obj)` |  |
| [ ] | function | `fish(selector)` |  |
| [ ] | function | `fishAll(selector)` |  |
| [ ] | interface | `Element` extends Node | `find(selector)`, `findAll(selector)`, `findAllSelf(selector)` |
| [ ] | interface | `HTMLElement` extends Element | `find(selector)`, `findAll(selector)`, `findAllSelf(selector)` |
| [ ] | interface | `DocumentFragment` extends Node, NonElementParentNode, ParentNode | `find(selector)`, `findAll(selector)` |
| [ ] | interface | `DomElementInfo` | `cls?`, `text?`, `attr?`, `title?`, `parent?`, `value?`, `type?`, `prepend?`, `placeholder?`, `href?` |
| [ ] | interface | `SvgElementInfo` | `cls?`, `attr?`, `parent?`, `prepend?` |
| [ ] | interface | `Node` | `createEl(tag, o?, callback?)`, `createDiv(o?, callback?)`, `createSpan(o?, callback?)`, `createSvg(tag, o?, callback?)` |
| [ ] | function | `createEl(tag, o?, callback?)` |  |
| [ ] | function | `createDiv(o?, callback?)` |  |
| [ ] | function | `createSpan(o?, callback?)` |  |
| [ ] | function | `createSvg(tag, o?, callback?)` |  |
| [ ] | function | `createFragment(callback?)` |  |
| [ ] | interface | `EventListenerInfo` | `selector`, `listener`, `options?`, `callback` |
| [ ] | interface | `HTMLElement` extends Element | `_EVENTS?`, `on(this, type, selector, listener, options?)`, `off(this, type, selector, listener, options?)`, `onClickEvent(this, listener, options?)`, `onNodeInserted(this, listener, once?)`, `onWindowMigrated(this, listener)`, `trigger(eventType)` |
| [ ] | interface | `Document` | `_EVENTS?`, `on(this, type, selector, listener, options?)`, `off(this, type, selector, listener, options?)` |
| [ ] | interface | `UIEvent` extends Event | `targetNode`, `win`, `doc`, `instanceOf(type)` |
| [ ] | interface | `AjaxOptions` | `method?`, `url`, `success?`, `error?`, `data?`, `headers?`, `withCredentials?`, `req?` |
| [ ] | function | `ajax(options)` |  |
| [ ] | function | `ajaxPromise(options)` |  |
| [ ] | function | `ready(fn)` |  |
| [ ] | function | `sleep(ms)` |  |
| [ ] | function | `nextFrame()` |  |
| [ ] | const | `activeWindow`: `Window` |  |
| [ ] | const | `activeDocument`: `Document` |  |
| [ ] | interface | `Window` extends EventTarget, AnimationFrameProvider, GlobalEventHandlers, WindowEventHandlers, WindowLocalStorage, WindowOrWorkerGlobalScope, WindowSessionStorage | `activeWindow`, `activeDocument`, `sleep(ms)`, `nextFrame()` |
| [ ] | interface | `Touch` | `touchType` |

---

## 4. Undocumented internals that popular plugins rely on

### 4.1 Measured usage in the top 25 release bundles

I downloaded each plugin's release `main.js` for the version in its HEAD manifest and ran a regex scan (`scratchpad/internals.txt`). Property names survive minification, so these counts are reliable to within false positives on generic names. `isMobile` also matches the public `Platform.isMobile`, and `titleEl` also matches the public `Modal.titleEl`.

| Internal | Bundles (of 25) | Typical use |
|---|---|---|
| `app.plugins` (`plugins.plugins[id]`, `getPlugin`, `enabledPlugins`, `manifests`, `enablePlugin*`) | 15 | Cross-plugin APIs (`app.plugins.plugins.dataview.api`), feature detection |
| `app.internalPlugins` (`getPluginById`, `getEnabledPluginById`, `.plugins[id].instance.options`) | 15 | Daily notes and templates settings, file-explorer and bookmarks instances |
| `vault.getConfig` / `setConfig` | 12 | `attachmentFolderPath`, `useMarkdownLinks`, `cssTheme`, `baseFontSize`, `tabSize` |
| `window.moment` global | 10 | Date formatting without importing `moment` |
| `app.loadLocalStorage` / `saveLocalStorage` | 9 | Public since 1.8.7. Values are namespaced per vault (`appId`) in `localStorage`. |
| `app.commands` (`executeCommandById`, `commands`, `listCommands`, `findCommand`) | 8 | Run core commands, command pickers |
| `adapter.basePath` (FileSystemAdapter) | 8 | Absolute paths for Node/child_process, which are desktop-only |
| `window.app` global | 8 | Accessing app from non-plugin modules |
| `process.*` / Node globals | 8 | Environment detection |
| `app.setting` (`open`, `openTabById`, `activeTab`, `pluginTabs`) | 7 | "Open settings" buttons |
| `editor.cm` (the CM6 `EditorView` behind `Editor`) | 7 | Direct dispatch, coordinates, decorations |
| `MarkdownRenderer.renderMarkdown` (deprecated static) | 7 | Legacy rendering path, still present |
| `window.CodeMirror` (CM5 global: `defineMode`, `runMode`) | 6 | Syntax-highlight modes for code blocks (Dataview DQL, Templater) |
| `app.dragManager` (`dragFile`, `onDragStart`, `handleDrop`) | 6 | Drag files out of custom views |
| `view.currentMode` / `sourceMode` / `previewMode.renderer.sections` | 6 | Reading-view section access |
| `adapter.getFullPath` / `getFilePath` | 5 | Absolute paths |
| `app.metadataTypeManager` (`properties`, `setType`, `getAllProperties`) | 5 | Property types (`types.json`) |
| `app.viewRegistry` (`viewByType`, `typeByExtension`, `getTypeByExtension`) | 4 | Detect or claim file extensions |
| `app.statusBar` | 4 | Status-bar DOM |
| `workspace.leftSplit` / `rightSplit` | 4 | Public in the d.ts (`WorkspaceSidedock`: `collapsed`, `toggle`, `collapse`, `expand`). Bundles also reach undocumented properties such as `containerEl`. |
| `workspace.floatingSplit` | 4 | Popout windows |
| `app.foldManager` | 4 | Fold state |
| `metadataCache.getTags()` | 4 | All tags with counts |
| `vault.config` / `vault.getAvailablePath` | 3 / 3 | Raw config object; unique filenames |
| `app.appId` | 3 | Namespacing IndexedDB/localStorage per vault |
| `app.hotkeyManager` | 3 | Show or print hotkeys |
| `metadataCache.initialized` / `resolved`, `dataview:*` events | 3 | Wait-for-index logic |
| `leaf.id` / `leaf.width` | 3 | Layout persistence |
| `app.embedRegistry` | 2 | Custom embeds (`![[file.ext]]`) |
| `metadataCache.getBacklinksForFile` | 2 | Backlinks |
| `app.openWithDefaultApp` / `showInFolder` | 2 | Desktop-only |
| `@electron/remote` | 2 | Desktop-only dialogs and windows |
| `app.dom`, `workspace.editorSuggest.suggests`, `workspace.protocolHandler`, `leaf.tabHeaderEl`, `leaf.parentSplit`, `vault.fileMap`, `fileManager.createNewMarkdownFile`, `metadataCache.getLinkSuggestions`, `workspace.leftRibbon` internals | 1 each | n/a |

Non-API platform features in the same bundles:

- `eval` / `new Function`: 13 of 25
- `fetch`: 10
- `localStorage`: 10
- Workers or blob URLs: 7
- XHR: 5
- WebAssembly: 4
- IndexedDB: 4

### 4.2 The internals map (obsidian-typings)

[`obsidian-typings`](https://github.com/obsidian-typings/obsidian-typings) (MIT, npm `obsidian-typings` 6.36.0, 2026-08-31) augments the `obsidian` module with reverse-engineered internal types. The per-app-version package `@obsidian-typings/obsidian-public-1.13.7` (1.9.0, 19 MB) contains 1,304 exported declarations (939 interfaces, 173 functions, 94 types, 55 classes, 41 variables, 2 enums). It is the most complete public map of what a compatible host needs to expose beyond `obsidian.d.ts`. Members it adds to key objects, extracted from `dist/cjs/types.d.cts`:

- **App (86):** `appId appMenuBarManager changeTheme cli commands customCss debugMode disableCssTransition dom dragManager embedRegistry emulateMobile enableCssTransition fileManager fixFileLinks foldManager garbleText getAccentColor getAppTitle getObsidianUrl getSpellcheckLanguages getTheme getWebviewPartition hotkeyManager importAttachments importDirectory initializeWithAdapter internalPlugins isDarkMode isMobile isVimEnabled keymap lastEvent loadLocalStorage metadataCache metadataTypeManager mobileNavbar mobileQuickActions mobileTabSwitcher mobileToolbar nextFrame … openHelp openVaultChooser openWithDefaultApp plugins registerCommands registerQuitHook relaunch renderContext runOpeningBehavior saveAttachment saveLocalStorage scope secretStorage setAccentColor setSpellcheckLanguages setTheme setting shareReceiver showInFolder showReleaseNotes statusBar title update* vault viewRegistry workspace`
- **Plugins (`app.plugins`, 33):** `autoCheckForUpdates checkForDeprecations checkForUpdates disablePlugin disablePluginAndSave enablePlugin enablePluginAndSave enabledPlugins getPlugin getPluginFolder initialize installPlugin isDeprecated isEnabled lastUpdateCheck loadManifest loadManifests loadPlugin loadingPluginId manifests onRaw plugins requestSaveConfig saveConfig setAutomaticUpdateCheck setEnable uninstallPlugin unloadPlugin updates`
- **Commands (`app.commands`):** `addCommand commands editorCommands executeCommand executeCommandById findCommand listCommands removeCommand`
- **InternalPlugins:** `config enable getEnabledPluginById getEnabledPlugins getPluginById loadPlugin plugins requestSaveConfig saveConfig`
- **ViewRegistry:** `getTypeByExtension getViewCreatorByType isExtensionRegistered registerExtensions registerView registerViewWithExtensions typeByExtension unregisterExtensions unregisterView viewByType`
- **AppSetting (`app.setting`, 57):** `open openTabById openTab close activeTab addSettingTab removeSettingTab pluginTabs settingTabs tabContentContainer tabHeadersEl communityPluginTabContainer corePluginTabContainer lastTabId searchComponent …`
- **CustomCSS (`app.customCss`, 44):** `theme themes oldThemes snippets enabledSnippets styleEl extraStyleEls setTheme setCssEnabledStatus loadTheme loadSnippets readThemes readSnippets getThemeFolder getSnippetsFolder installTheme installLegacyTheme downloadLegacyTheme checkForUpdate(s) isDarkMode setTranslucency updates …`
- **HotkeyManager:** `bakedHotkeys bakedIds customKeys defaultKeys getDefaultHotkeys getHotkeys printHotkeyForCommand setHotkeys removeHotkeys save load …`
- **DragManager (32):** `dragFile dragFiles dragFolder dragLink draggable handleDrag handleDrop onDragStart setAction showOverlay hideOverlay …`
- **MetadataTypeManager:** `properties getAllProperties getPropertyInfo getTypeInfo getWidget registeredTypeWidgets setType unsetType save load …`
- **EmbedRegistry:** `embedByExtension getEmbedCreator isExtensionRegistered registerExtension(s) unregisterExtension(s)`
- **FoldManager:** `load loadPath save savePath cleanup`
- **Vault (67 total):** adds `config configTs fileMap getConfig setConfig getAvailablePath getAvailablePathForAttachments getAbstractFileByPathInsensitive readConfigJson writeConfigJson readPluginData writePluginData readJson writeJson readRaw reloadConfig saveConfig setConfigDir cacheLimit checkPath resolveFilePath resolveFileUrl …`
- **Workspace (118 total):** adds `activeTabGroup floatingSplit editorSuggest{suggests} protocolHandler recentFileTracker backlinkInDocument getActiveFileView hoverLinkSources undoHistory leftSidebarToggleButtonEl rightSidebarToggleButtonEl onLayoutReadyCallbacks iterateTabs iterateCodeMirrors openPopout registerUriHook handleLinkContextMenu …`
- **MetadataCache (70 total):** adds `fileCache metadataCache uniqueFileLookup linkResolverQueue getBacklinksForFile getTags getLinkSuggestions getFileInfo getFrontmatterPropertyValuesForKey getAllPropertyInfos initialized inProgressTaskCount worker workQueue userIgnoreFilters isUserIgnored …`
- **WorkspaceLeaf (51):** `id`, `parent`, `group`, `width`, `height`, `tabHeaderEl`, `tabHeaderInnerTitleEl`, `tabHeaderInnerIconEl`, `tabHeaderCloseEl`, `tabHeaderStatus*El`, `pinned`, `history`, `working`, `activeTime`, `highlight`, `rebuildView`, `setDimension`, `updateHeader`, …
- **MarkdownView (61):** `currentMode editMode sourceMode previewMode modes backlinks inlineTitleEl metadataEditor modeButtonEl rawFrontmatter setMode toggleMode printToPdf showSearch …`
- **Editor (69):** `cm editorComponent containerEl coordsAtPos posAtCoords posAtMouse getClickableTokenAt insertBlock insertCallout insertCodeblock insertLink insertMathBlock toggleBulletList toggleCheckList toggleMarkdownFormatting triggerWikiLink searchCursor addHighlights removeHighlights foldMore foldLess …`
- **FileSystemAdapter (46):** `basePath`(via `getBasePath`) `fs fsPromises path url btime ipcRenderer getFullPath getFilePath watchers watcher startWatchPath listAll listRecursiveChild reconcileFileCreation trash …`
- **CapacitorAdapter (34):** `fs getFullPath getNativePath quickList watchAndList …`
- **ItemView (19):** `headerEl titleEl titleContainerEl titleParentEl actionsEl iconEl backButtonEl forwardButtonEl moreOptionsButtonEl leftSidebarToggleEl onMoreOptionsMenu updateNavButtons`
- **Modal (31):** `bgEl headerEl bgOpacity dimBackground shouldAnimate animateOpen animateClose onEscapeKey onWindowClose setBackgroundOpacity setDimBackground win …`
- **Menu (46):** `items sections dom bgEl scrollEl submenuConfigs currentSubmenu parentMenu openSubmenu select unselect onArrow* setUseNativeMenu …`
- **Setting (34):** `components errorEl setErrorMessage setNavigable setNoInfo setVisibility addComponent …`
- **Component (15):** `_children _events _loaded` (plugins occasionally touch `_loaded`)
- **Plugin (34):** `_lastDataModifiedTime _onConfigFileChange _userDisabled getModifiedTime loadCSS onConfigFileChange settingTab registerGlobalFunc registerInstanceFunc registerCliHandler …`
- **Keymap / Scope:** `rootScope pushScope popScope modifiers updateModifiers hasModifier` / `keys parent handleKey cb tabFocusContainerEl`

**Priority for the shim**, driven by 4.1: `app.plugins`, `app.internalPlugins` (at least `daily-notes`, `templates`, `file-explorer`, `bookmarks`, `page-preview`, `workspaces` instances with `.instance.options`), `app.commands`, `app.setting`, `vault.getConfig`/`config`, `editor.cm`, `window.CodeMirror` (CM5 mode registry stub or the real CM5 runMode), `app.dragManager`, `app.metadataTypeManager`, `app.viewRegistry`, `metadataCache.getTags`/`getBacklinksForFile`, `workspace.floatingSplit`, `leaf.tabHeaderEl`, and the ItemView header elements.

---

## 5. Compatibility test set: the top 25 by downloads

Source: `community-plugin-stats.json`, sorted by `downloads` and restricted to ids present in `community-plugins.json`. The table records the manifest from `raw…/<repo>/HEAD/manifest.json` and the release bundle at `github.com/<repo>/releases/download/<version>/…`, all fetched today.

**24 of 25 are `isDesktopOnly: false`.** Only `realclaudian` is desktop-only. However, `isDesktopOnly: false` means "survives on Obsidian mobile", not "works without native HTTP": Git, Remotely Save, Copilot and Iconize still need a CORS-free `requestUrl`.

| # | id (repo) | downloads | version (HEAD manifest) | minAppVersion | isDesktopOnly | main.js / styles.css | What it needs |
|---|---|---|---|---|---|---|---|
| 1 | `obsidian-excalidraw-plugin` ([zsviczian/obsidian-excalidraw-plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin)) | 7,955,022 | 2.27.3 | 1.8.7 | false | 4.88 MB / 333 KB | Custom `TextFileView` for `.excalidraw.md`, MPP + code block + CM6 extension + EditorSuggest. Requires all CM6/lezer packages. Heaviest internals user: `app.plugins`, `internalPlugins`, `commands`, `setting`, `viewRegistry`, `hotkeyManager`, `dragManager`, `metadataTypeManager`, `leftSplit`/`floatingSplit`, `leaf.tabHeaderEl`, `getBacklinksForFile`, `getTags`. Also `@electron/remote` (guarded), Workers, IndexedDB. React bundled. Late target. |
| 2 | `templater-obsidian` ([silentvoid13/Templater](https://github.com/silentvoid13/Templater)) | 5,590,650 | 2.25.0 | 1.13.0 | false | 0.45 MB / 4 KB | CM6 extension + MPP + EditorSuggest. Executes user templates with `new Function`/eval, and uses WASM (Rust parser). "System command" user functions use `child_process` (desktop-guarded). `window.CodeMirror` CM5 mode for syntax, `editor.cm`, `adapter.basePath`, `internalPlugins` (templates, daily notes), `vault.getConfig`. minAppVersion 1.13.0. |
| 3 | `dataview` ([blacksmithgu/obsidian-dataview](https://github.com/blacksmithgu/obsidian-dataview)) | 4,961,515 | 0.5.68 | 0.13.11 | false | 2.38 MB / 3 KB | `registerMarkdownPostProcessor` + `registerMarkdownCodeBlockProcessor` (`dataview`, `dataviewjs`) + CM6 extension (inline queries in Live Preview). Blob-URL Web Worker for indexing, IndexedDB (localforage) cache, eval for DataviewJS, CM5 `window.CodeMirror.defineMode` for DQL highlighting. Triggers `dataview:*` events on `metadataCache`. Exposes API via `app.plugins.plugins.dataview.api`. |
| 4 | `obsidian-tasks-plugin` ([obsidian-tasks-group/obsidian-tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)) | 4,237,228 | 8.4.0 | 1.8.7 | false | 0.94 MB / 30 KB | CM6 extension (`@codemirror/view` only), MPP + `tasks` code block, EditorSuggest (auto-suggest), `metadataTypeManager`, `window.moment`, i18next, `editor.cm`. React-free. Good core test. |
| 5 | `table-editor-obsidian` ([tgrosinger/advanced-tables-obsidian](https://github.com/tgrosinger/advanced-tables-obsidian)) | 3,191,464 | 0.23.2 | 1.0.0 | false | 0.27 MB / 2 KB | CM6 extension (state + view) for table editing, sidebar ItemView, `require('util')` inside a try/catch (lodash's Node detection), so a shim that throws is survivable here but not in general. Small. |
| 6 | `obsidian-git` ([vinzent03/obsidian-git](https://github.com/vinzent03/obsidian-git)) | 3,139,721 | 2.39.0 | None | false | 0.73 MB / 18 KB | Desktop: `child_process` git. Mobile path: isomorphic-git over `requestUrl`/`fetch`, so **CORS proxy required in browser**. 4 views (source control, history, diff), status bar, CM6 gutter extension (line authoring), `adapter.basePath`/`getFullPath`, `vault.getConfig`. Needs a writable FS adapter with `.git` access. |
| 7 | `calendar` ([liamcain/obsidian-calendar-plugin](https://github.com/liamcain/obsidian-calendar-plugin)) | 3,101,324 | 1.5.10 | 0.9.11 | false | 0.14 MB / 0 KB | Right-sidebar `ItemView` (Svelte), `window.moment`, `app.plugins` (periodic-notes), `internalPlugins.getPluginById('daily-notes')`, `vault.getConfig`, `file-menu`. No styles.css. 141 KB, simplest view test. |
| 8 | `obsidian-style-settings` ([obsidian-community/obsidian-style-settings](https://github.com/obsidian-community/obsidian-style-settings)) | 2,680,077 | 1.0.9 | 0.11.5 | false | 0.15 MB / 14 KB | Parses `/* @settings */` YAML blocks out of all loaded CSS (theme, snippets, plugin styles), then writes CSS variables and body classes. Settings tab + view, `app.plugins`, `commands`, `vault.getConfig`. **Key theme-compat test.** |
| 9 | `obsidian-kanban` ([obsidian-community/obsidian-kanban](https://github.com/obsidian-community/obsidian-kanban)) | 2,664,453 | 2.0.51 | 1.0.0 | false | 0.99 MB / 61 KB | `TextFileView` over Markdown (React-style hooks UI), `require('electron')`, `fs/promises`, `path` at top level (must not throw). `dragManager`, `embedRegistry`, `floatingSplit` (popouts), `workspace.editorSuggest.suggests`, `vault.config`, `fileManager.createNewMarkdownFile`, CM6 editor in cards, `internalPlugins`. |
| 10 | `remotely-save` ([remotely-save/remotely-save](https://github.com/remotely-save/remotely-save)) | 2,229,260 | 0.5.25 | 0.13.21 | false | 4.25 MB / 3 KB | Sync to S3/Dropbox/OneDrive/WebDAV/etc. via `requestUrl`+`fetch`+XHR, so **CORS-dependent**. OAuth callback via `registerObsidianProtocolHandler` (obsidian:// URIs, which need a web equivalent). IndexedDB (localforage), WASM. Browser: works only with the requestUrl proxy. |
| 11 | `obsidian-icon-folder` ([florianwoelki/obsidian-iconize](https://github.com/florianwoelki/obsidian-iconize)) | 2,221,410 | 2.14.7 | 0.9.12 | false | 1.00 MB / 2 KB | Iconize. CM6 extensions + MPP (icons in text), decorates **file-explorer DOM** (`internalPlugins.getPluginById('file-explorer')`, `.nav-file-title` classes), `view.titleEl`/tab headers, `requestUrl` to download icon packs (CORS). |
| 12 | `quickadd` ([chhoumann/quickadd](https://github.com/chhoumann/quickadd)) | 2,109,631 | 2.25.0 | 1.13.0 | false | 1.21 MB / 39 KB | Macros and user scripts (eval), `app.commands.executeCommandById`, `internalPlugins`, `app.dom`, `vault.fileMap`, `metadataTypeManager`, `window.require` (guarded), `requestUrl` (AI assistant). Many modals/suggesters. |
| 13 | `realclaudian` ([yishentu/claudian](https://github.com/yishentu/claudian)) | 2,104,168 | 2.2.7 | 1.13.0 | **true** | 5.28 MB / 192 KB | **isDesktopOnly: true.** Spawns the Claude Code CLI (`child_process`, `net`, `node:sqlite`, `http2`…). Out of scope for a browser host. |
| 14 | `copilot` ([logancyang/obsidian-copilot](https://github.com/logancyang/obsidian-copilot)) | 1,886,085 | 4.0.8 | 1.11.4 | false | 4.87 MB / 76 KB | LLM chat `ItemView` (React), `requestUrl`/`fetch` to model APIs (CORS varies by provider), CM6, Workers. Node modules (`fs`, `child_process`, `electron`, `worker_threads`) imported but desktop-guarded. `app.plugins`, `commands`, `setting`, `dragManager`, `getBacklinksForFile`, `editor.cm`. |
| 15 | `editing-toolbar` ([pkm-er/obsidian-editing-toolbar](https://github.com/pkm-er/obsidian-editing-toolbar)) | 1,884,727 | 4.1.4 | 1.4.5 | false | 1.70 MB / 84 KB | Floating formatting toolbar. CM6 extensions, `commands.executeCommandById` (15 call sites), `app.setting.open/openTabById`, `hotkeyManager`, `statusBar`, ribbon/`leftSplit` DOM, `node:http` import. |
| 16 | `omnisearch` ([scambier/obsidian-omnisearch](https://github.com/scambier/obsidian-omnisearch)) | 1,875,036 | 1.31.0 | 1.13.3 | false | 0.72 MB / 3 KB | Full-text search modal (MiniSearch). IndexedDB (Dexie), optional local HTTP server (desktop, `http`), `app.plugins` (Text Extractor for PDFs/images), `loadLocalStorage`, `app.appId`. **minAppVersion 1.13.3.** |
| 17 | `obsidian-minimal-settings` ([kepano/obsidian-minimal-settings](https://github.com/kepano/obsidian-minimal-settings)) | 1,801,002 | 9.0.0 | 1.13.0 | false | 0.03 MB / 0 KB | 26 KB. Toggles body classes and CSS variables for the Minimal theme; `vault.getConfig('cssTheme'/'baseFontSize')`, `app.setting`, `app.plugins` (style-settings). Theme-compat test. |
| 18 | `obsidian-importer` ([obsidianmd/obsidian-importer](https://github.com/obsidianmd/obsidian-importer)) | 1,665,980 | 3.1.5 | 1.13.0 | false | 5.00 MB / 45 KB | Official Obsidian importer (Evernote, Notion, …). Many `node:*` imports guarded by `Platform.isDesktopApp`, `@electron/remote` dialogs (desktop), web path uses `<input type=file>`. WASM (sql.js), Workers, `requestUrl`. |
| 19 | `tasknotes` ([callumalpass/tasknotes](https://github.com/callumalpass/tasknotes)) | 1,510,372 | 4.13.0 | 1.12.2 | false | 5.27 MB / 616 KB | **Uses the Bases API** (`registerBasesView` ×3), 6 views, CM6 extensions incl. `@codemirror/autocomplete`, ajv, optional HTTP API server (`electron`/`http`, guarded). 5.3 MB JS + 616 KB CSS. minAppVersion 1.12.2. |
| 20 | `obsidian-outliner` ([vslinko/obsidian-outliner](https://github.com/vslinko/obsidian-outliner)) | 1,406,940 | 4.10.2 | 1.11.7 | false | 0.48 MB / 2 KB | 11 CM6 extensions (list keymaps, drag-and-drop, vertical lines). `vault.config` internals, CM5 detection. **Best pure-editor stress test.** |
| 21 | `homepage` ([mirnovov/obsidian-homepage](https://github.com/mirnovov/obsidian-homepage)) | 1,330,417 | 4.5.0 | 1.13.0 | false | 0.06 MB / 4 KB | Opens a note/workspace on `onLayoutReady`. `commands.executeCommandById`, `internalPlugins` (workspaces, daily-notes), `viewRegistry`, `leftSplit`/`floatingSplit`, `leaf.parentSplit`, `app.plugins` (dataview, periodic-notes). minAppVersion 1.13.0. |
| 22 | `smart-connections` ([brianpetro/obsidian-smart-connections](https://github.com/brianpetro/obsidian-smart-connections)) | 1,199,725 | 4.7.2 | 1.8.7 | false | 1.53 MB / 113 KB | Local embeddings (transformers.js in Worker/iframe), 4 views, code block, `electron` import, `adapter.basePath`/`getFullPath`, protocol handler, `commands.executeCommandById`, `setting.open`. Heavy. |
| 23 | `recent-files-obsidian` ([tgrosinger/recent-files-obsidian](https://github.com/tgrosinger/recent-files-obsidian)) | 1,187,629 | 1.7.10 | 0.16.3 | false | 0.05 MB / 1 KB | Simple `ItemView` list, `registerHoverLinkSource`, `file-menu`, `dragManager.dragFile`, `internalPlugins`. Easy. |
| 24 | `tag-wrangler` ([pjeby/tag-wrangler](https://github.com/pjeby/tag-wrangler)) | 1,091,019 | 0.6.5 | 1.12.7 | false | 0.13 MB / 0 KB | Context menus on the **core tag-pane DOM** (`.tag-pane-tag`), `metadataCache.getTags` (internal), hover link source, `dragManager`, `vault.getAvailablePath`, i18next. No styles.css. |
| 25 | `obsidian-linter` ([platers/obsidian-linter](https://github.com/platers/obsidian-linter)) | 1,054,460 | 1.33.0 | 1.13.0 | false | 0.90 MB / 3 KB | Settings-heavy; lints on save via `editor.cm` transactions, `commands`, `vault.getConfig`, CM5 check, `window.moment`, `requestUrl`. minAppVersion 1.13.0. |

### 5.1 First eight to test

All eight are mobile-compatible (`isDesktopOnly: false`), make no Node calls on their main paths, and together exercise the core surfaces.

| Order | Plugin | Why first | Direct release URLs (version = HEAD manifest today) |
|---|---|---|---|
| 1 | `calendar` 1.5.10 | Smallest real `ItemView` (Svelte), `moment`, `internalPlugins` daily-notes, `file-menu`. No styles.css. | https://github.com/liamcain/obsidian-calendar-plugin/releases/download/1.5.10/manifest.json · https://github.com/liamcain/obsidian-calendar-plugin/releases/download/1.5.10/main.js |
| 2 | `recent-files-obsidian` 1.7.10 | Simple view, hover link source, drag manager, file menu | https://github.com/tgrosinger/recent-files-obsidian/releases/download/1.7.10/manifest.json · …/main.js · …/styles.css |
| 3 | `dataview` 0.5.68 | Post-processors, code blocks, CM6 extension, Worker, IndexedDB, eval, CM5 mode, metadata cache fidelity | https://github.com/blacksmithgu/obsidian-dataview/releases/download/0.5.68/manifest.json · …/main.js · …/styles.css |
| 4 | `obsidian-tasks-plugin` 8.4.0 | CM6 extension, EditorSuggest, code-block queries, `metadataTypeManager` | https://github.com/obsidian-tasks-group/obsidian-tasks/releases/download/8.4.0/manifest.json · …/main.js · …/styles.css |
| 5 | `table-editor-obsidian` 0.23.2 | CM6 state/view extension, sidebar view | https://github.com/tgrosinger/advanced-tables-obsidian/releases/download/0.23.2/manifest.json · …/main.js · …/styles.css |
| 6 | `obsidian-outliner` 4.10.2 | 11 CM6 extensions (keymaps, list drag and drop), which puts the most stress on the editor | https://github.com/vslinko/obsidian-outliner/releases/download/4.10.2/manifest.json · …/main.js · …/styles.css |
| 7 | `obsidian-style-settings` 1.0.9 | Reads every loaded stylesheet's `@settings` block, so it tests CSS ordering and theme vars | https://github.com/obsidian-community/obsidian-style-settings/releases/download/1.0.9/manifest.json · …/main.js · …/styles.css |
| 8 | `obsidian-kanban` 2.0.51 | `TextFileView`, top-level `require('electron'/'fs/promises'/'path')` (must not throw), drag manager, embed registry, popouts | https://github.com/obsidian-community/obsidian-kanban/releases/download/2.0.51/manifest.json · …/main.js · …/styles.css |

Next wave: `tag-wrangler` (core tag-pane DOM), `homepage` (layout-ready and commands), `obsidian-minimal-settings` with the Minimal theme, `templater-obsidian` (WASM and eval), `obsidian-linter`, `obsidian-icon-folder` (file-explorer DOM), then Excalidraw and TaskNotes (Bases API). Git, Remotely Save and Copilot need the `requestUrl` proxy. `realclaudian` is out of scope.

These are browser URLs for humans and for the proxy or mirror; they cannot be `fetch()`ed from our origin (section 2.3). Copies downloaded for inspection are in `scratchpad/bundles/<id>/`.

---

## 6. Themes

### 6.1 Download mechanics (app.js 1.13.7)

- **Directory:** `raw…/obsidianmd/obsidian-releases/master/community-css-themes.json`, schema `{name, author, repo, screenshot, modes, legacy?}`.
  - The screenshot is `raw…/<repo>/HEAD/<screenshot>`.
  - Download counts come from `https://releases.obsidian.md/stats/theme`, which sends **no ACAO** and is not ours anyway. The store POSTs `releases.obsidian.md/stats/theme/<name>/download` on install.
- **Update check:** fetch `raw(repo, "manifest.json")`.
  - If present and `name` matches, resolve the version via `versions.json` (the same logic as plugins).
  - If absent, it is a legacy theme: download `raw(repo, "obsidian.css")` and compare the text with the installed CSS.
- **`installTheme(themeInfo, version)`:**
  - If there is no version (legacy), call `installLegacyTheme`. It fetches `raw(repo, "obsidian.css")` and writes `themes/<name>/theme.css` plus a synthesized `manifest.json` (`{name, version:"0.0.0", minAppVersion:"0.16.0", author}`).
  - Otherwise fetch `release(repo, version, "manifest.json")` and `release(…, "theme.css")`. **If the release fetch returns 404, fall back to `raw(repo, "manifest.json")` and `raw(repo, "theme.css")`.**
  - Verify `manifest.name === themeInfo.name` ("Theme name mismatch").
  - Write `.obsidian/themes/<name>/manifest.json` and `theme.css`, and delete the old `.obsidian/themes/<name>.css`.
- **Activation:** `appearance.json.cssTheme = "<name>"`. `customCss.loadTheme()` reads `themes/<name>/theme.css` into `customCss.styleEl`, which comes after plugin `<style>` elements and before snippet `<style>`s, then triggers `css-change` and `resize` on the workspace. Snippets are `snippets/<file>.css`, enabled via `enabledCssSnippets`.
- **Theme `manifest.json`:** `{name, version, minAppVersion, author, authorUrl?, fundingUrl?}` (no `id`). Themes are released with `gh release create "$tag" … manifest.json theme.css` per the docs. **Policy:** "Themes may not load assets from the network", so fonts and images are embedded as data URIs. That means `theme.css` works offline and needs no extra fetches.

### 6.2 CORS for themes: fully static-site-safe

Sample of 11 popular themes today:

| Theme (repo) | raw `manifest.json` | raw `theme.css` | raw `obsidian.css` | release `theme.css` |
|---|---|---|---|---|
| Minimal (kepano/obsidian-minimal) | 200 | 200 (265,574 B) | 200 | 200 |
| AnuPpuccin (anubisnekhet/AnuPpuccin) | 200 | 200 (370,085 B) | 200 | 200 |
| Blue Topaz (pkm-er/Blue-Topaz_Obsidian-css) | 200 | 200 (1,281,675 B) | 200 | 404 |
| Primary (primary-theme/obsidian) | 200 | 200 (1,719,235 B) | 404 | 404 |
| Catppuccin (catppuccin/obsidian) | 200 | 200 (2,306,367 B) | 200 | 404 |
| Things, Border, Sanctum, ITS, Obsidianite, Cybertron | 200 | 200 | 200 (Border: 404) | 404 |

`curl -sI -H 'Origin: https://example.com' https://raw.githubusercontent.com/kepano/obsidian-minimal/HEAD/theme.css` returns `HTTP/2 200`, `content-type: text/plain; charset=utf-8`, `access-control-allow-origin: *`. **The host should fetch themes from `raw…/HEAD/{manifest.json,theme.css}` directly.** That is exactly Obsidian's 404 fallback path, and it works in every browser. Release assets are only "more exact" when a theme's default branch is ahead of its latest release. Apply CSS by setting `textContent` on a `<style>`, never as a `<link>` to raw, because raw serves `text/plain` with `nosniff`.

### 6.3 DOM requirement

Themes (and Style Settings, Minimal Settings, Iconize, Tag Wrangler) target Obsidian's **class names, DOM nesting and CSS variables** (`body.theme-dark`, `.workspace-split`, `.workspace-leaf-content[data-type]`, `.nav-file-title`, `.markdown-preview-view`, `.cm-editor`/`.HyperMD-*`, `--background-primary`, `--interactive-accent`, …). Themes cannot work unless the host reproduces that structure. The class and variable inventory belongs to the DOM/CSS research doc alongside this file (see also `obsidian-features.md` in `docs/research/`), and the public list is in `obsidian-developer-docs/en/Reference/CSS variables/`. This doc covers only fetch and install mechanics.

---

## 7. Prior art, licensing and trademark

### 7.1 Projects that run Obsidian plugins outside Obsidian

| Project | Approach | What it teaches |
|---|---|---|
| **WebObsidian** ([xnohat/webobsidian](https://github.com/xnohat/webobsidian), MIT, 253 stars, created 2026-06-03, pushed 2026-06-27; fork blueberry6401/webobsidian) | Self-hosted Node/Express + React + CM6. **Server-side** plugin install via `api.github.com/repos/<repo>/releases/latest`, followed by the asset `browser_download_url` (no CORS issue because the server fetches). The browser shim `web/src/lib/plugins.ts` is **165 lines**: `Events`, `Notice`, `TFile`, `Vault`, `Workspace`, `App`, `Component`, `Plugin`, `PluginSettingTab`, `Modal`, `Setting`, with `MarkdownView`/`ItemView` as empty classes and `new Function('module','exports','require', code)`. `require` **throws** on anything but `obsidian`. | README: "Community-plugin support is a **subset** of the Obsidian API; plugins relying on Electron/Node internals may not work." A throwing `require` and a thin shim rule out essentially all of the top 25 (every one imports CM6 or Node modules). It uses `releases/latest` rather than the HEAD manifest version, which diverges from Obsidian (the Dataview case above). |
| **Ignis** ([AiTH-Solutions/obsidian-webapp-ignis](https://github.com/AiTH-Solutions/obsidian-webapp-ignis), AGPL-3.0 per README, 0 stars) | **Runs the real Obsidian app in a browser.** The Docker container downloads the official Obsidian build at first run, and Ignis provides "browser-compatible implementations of the Electron APIs used by Obsidian". It has `server/routes/proxy.js` for `requestUrl`/`fetch`. | Proves that shimming Electron/Node under the proprietary app works for "most community plugins" (not Node-native or `child_process`). Streaming zlib is missing, and sync dialogs need workarounds. Legal stance: "not affiliated with … Dynalist Inc.", relying on EU Directive 2009/24/EC Art. 6. **Not an option for us**: it depends on running Obsidian's proprietary code, which is ToS-restricted for commercial use. |
| **OpenObsidian → OpenOnyx** (`github.com/OpenObsidian/OpenObsidian` now **HTTP 301 → `github.com/OpenOnyx/OpenOnyx`**; Apache-2.0; ~121 stars, v1.0.5) | Electron 41 + React 19 + CM6 desktop app with a `plugin-runtime` subsystem targeting "Obsidian plugin compatibility through a tested runtime layer", plus IndexedDB, Transformers.js and optional Supabase. | **The same product name and concept already renamed away from "Obsidian".** That is the strongest signal that the name is a trademark liability. It is also Electron, not web. |
| **obsidian-remote** ([sytone/obsidian-remote](https://github.com/sytone/obsidian-remote)) | The real Obsidian desktop in Docker over KasmVNC. | Remote desktop, not a web app. Irrelevant architecturally. |
| **Testing mocks:** [jest-environment-obsidian](https://github.com/obsidian-community/jest-environment-obsidian), [obsimian](https://github.com/motif-software/obsimian), [obsidian-mock](https://github.com/dianedef/obsidian-mock) | Partial in-memory implementations of `App`/`Vault`/`MetadataCache` and the DOM prototype augmentations for unit tests. | Useful references for the DOM helpers (`createEl`, `empty`, `addClass`, …) and in-memory vault semantics. Check their licences before borrowing. |
| **[obsidian-typings](https://github.com/obsidian-typings/obsidian-typings)** (MIT) and **obsidian-dev-utils** (npm 104.0.0) | Typings and helpers for internals. | Specification source for section 4. The typings are derived by reverse engineering, so treat them as documentation, not code to copy. |
| **SilverBullet, Lokus, Notesnook, Logseq** | Own plugin systems (SilverBullet "plugs" run in Web Workers; Lokus is a Tauri app with its own marketplace). | **No Obsidian plugin compatibility.** SilverBullet was partly motivated by the security model of Obsidian plugins (full DOM and Node access). |

No existing web-only (no server, no Electron) project loads the top Obsidian plugins unmodified. The two real attempts either run a thin subset (WebObsidian) or run the proprietary app itself (Ignis).

### 7.2 Is it legal to implement the API?

- **Type definitions:** `obsidianmd/obsidian-api` and the npm `obsidian` package are **MIT**, "Copyright 2022 Dynalist Inc." (`LICENSE.md` in the tarball; GitHub API reports `spdx_id: MIT`). The file header says "automatically generated … do not modify or send pull requests". MIT permits copying, modifying and redistributing the `.d.ts`, with the notice retained. Implementing classes that satisfy those declarations is ordinary interoperability work.
- **The app itself is proprietary:** `app.asar/package.json` has `"license": "UNLICENSED"`, `"private": true`. The [Terms of Service](https://obsidian.md/terms) (Dynalist Inc., governed by Ontario law) prohibit users from "disassemble, reverse engineer or decompile the Services or Software … except developers may do so for the purpose of developing Third Party Plugins for non-commercial use", and from creating "derivative works based on or otherwise modify the Services or Software". Therefore:
  - **Never copy, bundle or redistribute** `app.js`, `app.css`, `enhance.js`, fonts, icons, i18n files, or the bundled `lib/*` from the asar, even though some bundled libraries (CodeMirror, moment, pixi, turndown, pdf.js, MathJax, mermaid) are themselves open source. Take those from npm under their own licences.
  - Base the implementation on the MIT `.d.ts`, the public docs (the `obsidian-developer-docs` repo), and **black-box observation of plugins**. For evidence about internals, prefer running plugins against our shim and logging property accesses (a `Proxy` on `app`) over reading `app.js`.
  - Ignis's EU Directive 2009/24/EC Art. 6 interoperability argument exists, but it concerns decompilation for interoperability in the EU. Get proper legal advice before relying on it, and do not relitigate it here.
  - **`app.css` and Obsidian's DOM/CSS variable names:** class names and CSS custom-property names are functional identifiers, needed for themes to work, and are also listed in the public docs (`Reference/CSS variables`). Re-authoring our own stylesheet that uses the same names is interoperability. Copying `app.css` wholesale is not.
- **Community plugins and themes** are each under their own licence. Policy requires "Include a LICENSE file" for directory listing. Executing them locally for a user is like Obsidian doing so. **Redistributing** them (a mirror, pre-bundled plugins) requires honouring each licence.
- **Plugin authors' expectations:** the developer policies prohibit plugins from client-side telemetry and from auto-updating themselves. Our host should similarly never inject code into plugins, never modify `main.js`, and show plugin network use as Obsidian does.

### 7.3 Trademark limits on "Obsidian"

- [Brand guidelines](https://obsidian.md/brand): "The Obsidian name, logo and app icon are trademarks." "Please do not edit, change, distort, recolor, or reconfigure the Obsidian logo." "If you want to use Obsidian assets for commercial purposes, please contact us."
- [Developer policies](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Community%20directory/Developer%20policies.md): "Respect Obsidian's trademark policy. Don't use the 'Obsidian' trademark in a way that could confuse users into thinking your plugin or theme is a first-party creation." The manifest docs say plugin and theme names must "not include the word 'Obsidian' or variations like 'Obsi-' and '-sidian'", and new plugin ids "can't contain `obsidian`".
- Registrations and filings by Dynalist Inc.:
  - USPTO serial [98063360](https://uspto.report/TM/98063360), for downloadable software for document management and collaboration. The page returned 403 to my fetch, so status is unverified.
  - Canadian application 2266181 (filed 2023-06-27).
  - An EU listing on trademarkia.eu.
- **Conclusion:**
  - A product named **"OpenObsidian"** (or "Obsidian Web", "Obsi-…", "…sidian") would very likely draw a trademark complaint. The OpenObsidian → OpenOnyx rename is direct precedent.
  - Use a distinct name (run the `openapps-product-name` skill) and descriptive, nominative compatibility wording only, e.g. "opens Obsidian vaults; runs many Obsidian community plugins", with a non-affiliation notice.
  - Never use the Obsidian logo or purple gem iconography.
  - The repo and folder name `openobsidian` is fine as an internal codename but should not ship publicly.

---

## Appendix: reproduction

Scratchpad (session-local): `/private/tmp/claude-501/-Users-dariuskohsg-Downloads-sharing-folder-openapps-openobsidian/e1a6d318-3001-4922-8817-6fd71c57aee0/scratchpad/`

| File | What it is |
|---|---|
| `obs/package/*` | `npm pack obsidian@1.13.1` (`obsidian.d.ts`, `canvas.d.ts`, `publish.d.ts`, `CHANGELOG.md`, `LICENSE.md`) |
| `master-obsidian.d.ts` | GitHub master 1.13.2 |
| `enum.cjs`, `api.json`, `gen.py`, `api-section.md` | TypeScript-compiler enumeration and the checklist generator |
| `community-plugins.json`, `community-plugin-stats.json`, `community-css-themes.json`, `top25.txt`, `manifests/`, `bundles/<id>/` | Store data, top 25 manifests and release bundles |
| `cors.cjs` | Playwright three-engine CORS test (run with `node cors.cjs`; uses `openapps/opencrowd/node_modules/playwright`) |
| `internals.txt` | Bundle scan output |
| `typings3/` | `@obsidian-typings/obsidian-public-1.13.7` |
| `obsidian-1.13.7.asar.gz` (sha256 `69253e39…d25a`), `asar/` | Extracted official app, **inspection only, never copy** |
