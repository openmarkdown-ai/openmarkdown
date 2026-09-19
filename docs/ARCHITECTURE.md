# Architecture

A browser-first, open-source Markdown vault application that reads and writes
the same folder Obsidian does (`.md` files plus `.obsidian/`), renders the same
syntax, and loads Obsidian community plugins and themes unmodified.

Working name in code: **vault**. The product name is not settled (the word
"Obsidian" is a trademark of Dynalist Inc. and cannot be the product name); it
lives in one constant, `PRODUCT_NAME` in `packages/app/src/product.ts`.

```
crates/                       Rust. Pure, no I/O, native + wasm32.
  vault-types/                CachedMetadata & friends, LineIndex (UTF-16 positions)
  vault-ofm/                  Obsidian Flavored Markdown → metadata + HTML sections
  vault-index/                link resolution, backlinks, tags, search language,
                              fuzzy match, graph data + force layout, rename edits
  vault-bases/                .base files: YAML schema, expression language, views
  vault-clip/                 readable extraction, HTML → Markdown, clipper
                              template language, importers (ENEX, Notion, …)
  vault-publish/              note → standalone HTML; vault → static site
  vault-wasm/                 wasm-bindgen surface over all of the above
  vault-cli/                  native `vault` binary over the same crates
packages/
  engine/                     TS wrapper over the wasm module (typed, sync API)
  app/                        the application: the `obsidian` API implemented as
                              the real app, the CM6 editor, core plugins, settings,
                              community plugin/theme store, default theme CSS
apps/
  web/                        Vite static PWA (dev/e2e port 5200)
  clipper/                    MV3 browser extension: clip a page into the vault
e2e/                          Playwright against the built apps
docs/research/                what the design is based on
```

## Rules every crate follows

1. **No I/O.** Functions take strings/bytes and return values. The browser and
   the CLI own files.
2. **Positions are UTF-16.** Every `offset` and `col` that leaves Rust counts
   UTF-16 code units, because plugins feed them to JS string APIs. Build a
   `vault_types::LineIndex` and convert at the edge. A test with an emoji before
   a link is mandatory in any crate that emits positions.
3. **JSON shapes match `obsidian.d.ts`.** `node_modules/obsidian/obsidian.d.ts`
   (v1.13.1) is the contract. Field names are camelCase on the wire.
4. **Compiles to `wasm32-unknown-unknown`** with no extra features. No
   `std::fs`, no threads, no `SystemTime::now()` (take `now_ms` as a parameter),
   no C dependencies. Prefer small crates: wasm size is shipped to every user.
5. **Tests are native** (`cargo test -p <crate>`), and every crate has an
   `examples/inspect.rs` that runs its real pipeline over real input on disk.
6. Each crate owns only its own directory. Shared shapes go in `vault-types`
   (ask the integrator rather than editing it from a feature crate).
7. Use a private `CARGO_TARGET_DIR` when building in parallel with other work.

## vault-ofm

```rust
pub fn parse(text: &str) -> vault_types::CachedMetadata;
pub fn parse_frontmatter(text: &str) -> Frontmatter { data: Option<Map>, position: Option<Pos>, body_start_byte: usize, error: Option<String> }
pub fn render(text: &str, opts: &RenderOptions) -> Rendered;
pub struct RenderOptions { pub strict_line_breaks: bool }
pub struct Rendered { pub sections: Vec<RenderedSection> }
pub struct RenderedSection { pub kind: String, pub line_start: u32, pub line_end: u32, pub html: String }
pub fn word_count(text: &str) -> WordCount { words: u32, characters: u32 }
pub fn yaml_parse(src: &str) -> Result<serde_json::Value, String>;     // parseYaml
pub fn yaml_stringify(v: &serde_json::Value) -> String;               // stringifyYaml
```

Rendered HTML is a contract with `packages/app` (the reading view fills in the
parts that need the vault). Exact shapes:

| Construct | HTML |
|---|---|
| `[[Note#H\|Alias]]` | `<a data-href="Note#H" href="Note#H" class="internal-link" target="_blank" rel="noopener nofollow">Alias</a>` (no alias → text `Note > H`) |
| `![[file.png\|100x80]]`, `![[Note#^id]]` | `<span class="internal-embed" src="file.png" alt="100x80" tabindex="-1"></span>` — the app resolves it |
| `![alt](local/path.png)` (no URL scheme) | same `internal-embed` span, `src` percent-decoded, `alt` = alt text |
| `![alt](https://…)` | `<img src="https://…" alt="alt" referrerpolicy="no-referrer">` |
| `[x](https://…)` | `<a href="…" class="external-link" target="_blank" rel="noopener nofollow">x</a>` |
| `[x](Note.md)` / `[x](Note%20A)` | internal-link as above, `data-href` percent-decoded |
| `#tag/sub` | `<a href="#tag/sub" class="tag" target="_blank" rel="noopener nofollow">#tag/sub</a>` |
| `==hi==` | `<mark>hi</mark>` |
| `~~x~~` | `<del>x</del>` |
| `%%c%%` (inline or block) | omitted |
| `$x$` / `$$x$$` | `<span class="math math-inline">x</span>` / `<div class="math math-block">x</div>` (TeX HTML-escaped) |
| fenced code | `<pre class="language-js"><code class="language-js">…escaped…</code></pre>` (no lang → no class) |
| heading | `<h2 data-heading="Text" dir="auto">Text</h2>` |
| list item | `<li data-line="N" dir="auto">` ; task: `<li data-line="N" data-task="x" class="task-list-item is-checked" dir="auto"><input data-line="N" type="checkbox" class="task-list-item-checkbox" checked>` (`is-checked` + `checked` for any non-space status) ; `<ul class="contains-task-list">` when any child is a task |
| callout `> [!tip]- Title` | `<div data-callout-metadata="" data-callout-fold="-" data-callout="tip" class="callout is-collapsible is-collapsed"><div class="callout-title" dir="auto"><div class="callout-icon"></div><div class="callout-title-inner">Title</div><div class="callout-fold is-collapsed"></div></div><div class="callout-content" style="display: none;">…</div></div>` ; type lower-cased, metadata is the text after `\|` in `[!type\|meta]`, default title is the capitalised type |
| footnote ref | `<sup data-footnote-id="fnref-1" class="footnote-ref" id="fnref-1"><a href="#fn-1" class="footnote-link" target="_blank" rel="noopener nofollow">1</a></sup>` |
| footnotes | a final section, kind `footnotes`: `<section class="footnotes"><hr><ol><li data-footnote-id="fn-1" id="fn-1">… <a href="#fnref-1" class="footnote-backref footnote-link">↩︎</a></li></ol></section>` |
| `^block-id` at end of a block | hidden (not rendered) |
| raw HTML | passed through unchanged; the app sanitises with DOMPurify |
| frontmatter | not rendered (the app shows the properties widget) |
| single newline | `<br>` unless `strict_line_breaks` |

One `RenderedSection` per top-level block, with the same `kind` names and line
ranges as `CachedMetadata.sections`, so a post-processor's `getSectionInfo()`
can be answered from them.

## vault-index

```rust
pub struct FileEntry { pub path: String, pub size: u64, pub ctime: f64, pub mtime: f64 }
pub struct VaultIndex;
impl VaultIndex {
  pub fn new() -> Self;
  pub fn upsert_file(&mut self, e: FileEntry);                 // any file, incl. attachments
  pub fn remove_file(&mut self, path: &str);
  pub fn rename_file(&mut self, old: &str, new: &str);
  pub fn set_note(&mut self, path: &str, text: String, meta: CachedMetadata); // markdown content
  pub fn resolve_link(&self, linkpath: &str, source: &str) -> Option<String>; // getFirstLinkpathDest
  pub fn resolved_links(&self) -> BTreeMap<String, BTreeMap<String, u32>>;
  pub fn unresolved_links(&self) -> BTreeMap<String, BTreeMap<String, u32>>;
  pub fn backlinks(&self, path: &str) -> Vec<Backlink>;         // source path + LinkCache refs
  pub fn unlinked_mentions(&self, path: &str) -> Vec<Mention>;
  pub fn tags(&self) -> BTreeMap<String, u32>;                  // "#tag" → count (body + frontmatter)
  pub fn linktext(&self, target: &str, source: &str, format: LinkFormat) -> String; // fileToLinktext
  pub fn rename_edits(&self, old: &str, new: &str, opts) -> Vec<FileEdit>;        // auto-update links
  pub fn search(&self, query: &str, opts: &SearchOptions) -> SearchOutput;       // Obsidian search syntax
  pub fn graph(&self, opts: &GraphOptions) -> GraphData;       // global or local (depth), filters, groups
}
pub mod fuzzy { pub fn fuzzy(query: &str, text: &str) -> Option<SearchResult>; pub fn simple(query: &str, text: &str) -> Option<SearchResult>; pub fn rank(query: &str, items: &[String], limit: usize) -> Vec<(usize, SearchResult)>; }
pub mod layout { pub struct ForceLayout; /* new(n_nodes, edges, params); step(iterations); positions() -> &[f32]; set_params; pin(node, x, y) */ }
```

## vault-bases

```rust
pub fn parse_base(yaml: &str) -> Result<BaseFile, BaseError>;   // filters, formulas, properties, summaries, views
pub fn serialize_base(base: &BaseFile) -> String;
pub struct FileRecord { path, name, basename, folder, ext, size, ctime, mtime,
                        properties: Map, tags: Vec<String>, links: Vec<String>,
                        embeds: Vec<String>, backlinks: Vec<String> }
pub fn run_view(base: &BaseFile, view: usize, files: &[FileRecord], this: Option<&FileRecord>, now_ms: f64) -> ViewResult;
pub fn eval(expr: &str, ctx: &EvalContext) -> Result<Value, BaseError>;
```

## vault-clip

```rust
pub fn extract(html: &str, url: &str) -> Extracted;            // title, author, published, description, image,
                                                               // site, domain, favicon, content_html, word count,
                                                               // meta tags, schema.org JSON-LD
pub fn html_to_markdown(html: &str, base_url: Option<&str>) -> String;
pub fn render_template(tpl: &str, ctx: &TemplateContext) -> Result<String, TemplateError>; // Web Clipper syntax + filters
pub mod import { enex, notion_zip, roam_json, keep_takeout, bear, html_files, … }
```

## packages/app

The `obsidian` module *is* the application. `App`, `Vault`, `Workspace`,
`MetadataCache`, `FileManager` are the real implementations, and every core
feature (file explorer, search, graph, canvas, Bases, daily notes …) is written
as an internal plugin against the same public API a community plugin sees. That
is the compatibility test that runs every time the app starts.

Community plugins are CommonJS: `main.js` is evaluated with a `require` that
resolves `obsidian`, `@codemirror/*`, `@lezer/*` to the app's own module
instances (one copy of each — a second copy of `@codemirror/state` breaks every
editor extension), and `module`/`exports`. Desktop-only plugins are refused
with a message, as Obsidian mobile does.

Storage adapters behind `DataAdapter`:

| Adapter | Where | Notes |
|---|---|---|
| File System Access | Chromium: a real folder on disk | handle persisted in IndexedDB; permission re-requested on a gesture |
| OPFS | every modern browser | private to the origin; import/export zip |
| Memory | tests, demo vault | |

## packages/app layout and conventions

```
packages/app/src/
  obsidian/                 the `obsidian` module — one file per API area
    index.ts                re-exports every public name in obsidian.d.ts (the module plugins `require`)
    dom.ts                  global DOM/prototype helpers (installDomExtensions)
    events.ts               Events, Component
    util.ts                 normalizePath, parseLinktext, debounce, requestUrl, base64, yaml, frontmatter helpers …
    app.ts                  App (+ the undocumented internals plugins use: app.plugins, app.commands, app.setting …)
    vault/                  TAbstractFile/TFile/TFolder, adapters, Vault, FileManager, MetadataCache
    workspace/              Workspace, WorkspaceLeaf, splits/tabs/sidedocks/ribbon, View/ItemView/FileView/TextFileView
    markdown/               MarkdownView, MarkdownRenderer, MarkdownPreviewView, post-processors, embeds
    ui/                     icons, tooltip, Notice, Modal, Menu, Setting + components, suggest family, HoverPopover, Keymap/Scope, SettingTab
    bases/                  Bases API classes (Value family, BasesView, QueryController …)
  editor/                   CodeMirror 6: OFM syntax, live preview, source mode, Editor implementation, commands, vim
  core-plugins/<id>/        one folder per core plugin, each a Plugin subclass using only the public API where possible
  settings/                 the Settings modal and its built-in tabs
  community/                plugin loader (CommonJS require), plugin + theme browser, CSS snippets
  styles/                   the default theme: Obsidian's DOM classes and CSS variables
```

- **Vanilla DOM + the Obsidian helpers.** No UI framework: the DOM *is* the
  compatibility surface for themes, and plugins call `createDiv` on our nodes.
- **Class names are Obsidian's** (see docs/research/dom-and-css.md). Our own
  additions use the `vault-` prefix so they never collide with a theme's rules.
- **Colours only through CSS variables** (`--background-primary`,
  `--text-normal`, `--interactive-accent` …); never a literal in a component.
- **Icons are Lucide** via `setIcon(el, "lucide-name")` / `setIcon(el, "name")`.
- **Internal APIs** a class needs beyond obsidian.d.ts are public fields/methods
  with a leading comment `// internal (used by plugins: …)`.
- Strict TypeScript. `import type` for types. Tests are Playwright e2e against
  the built app, plus unit tests in `e2e/unit/*.spec.ts` run in the browser.

## Core plugins and pre-installed plugins

Every built-in feature is a `CorePluginDefinition` registered on `app.internalPlugins` (`core-plugins/index.ts`), but there are two kinds:

- **Core plugins** are Obsidian's own (research doc §3.0: backlinks, bases, bookmarks, canvas, daily notes, graph, templates, slides, web viewer, word count …) plus hidden, always-on app internals (`markdown`, `media-views`, `external-embeds`, `note-titles`, `link-tabs`, `export-pdf`). Settings → Core plugins lists the non-hidden ones; state is `.obsidian/core-plugins.json`, which never contains hidden or pre-installed ids (older builds' entries are stripped on load).
- **Pre-installed plugins** are what OpenMarkdown adds: `formatting-toolbar`, `writing-focus`, `grammar`, `natural-dates`, `periodic-notes`, `calendar`, `trash`, `smart-paste`, `media`, `local-images`, `export`, `citations`, `quick-capture`, `importer`, `ocr`, `voice`, `ai-tools`, `reminders`, `backup`, `opensync`, `semantic`, `vault-chat`, `ai-suggest`, `ai-query`, `ai-review`, `transcribe`. `core-plugins/preinstalled.ts` marks their definitions (`definition.preinstalled`: author = product, version = `APP_VERSION`, `replaces` = community plugin ids they step aside for, `removes` = words for the uninstall confirmation, `onUninstall(app)` clean-up, and for Sync a separately confirmed `disconnect`). Ids, command ids and `.obsidian/<id>.json` options are unchanged. Per-vault state is `.obsidian/openmarkdown-plugins.json` `{ "uninstalled": [...], "enabled": {...} }`; the first load without it carries over their entries from `core-plugins.json`. Settings → Community plugins lists them ("Pre-installed plugins", unaffected by restricted mode) with toggle, gear, hotkeys and Uninstall, and "Removed pre-installed plugins" with Reinstall; their setting tabs sit under the sidebar's Community plugins heading (`AppSetting.isPreinstalledTab`).
- `internalPlugins.setEnabled(id, on)` works for both kinds and writes the right file. `internalPlugins.uninstall(id, {disconnect?})` closes the plugin's views, unloads it (commands, ribbon, status bar, setting tabs go with it), deletes `.obsidian/<id>.json`, runs `onUninstall`, and moves the wrapper from `plugins` to `removed`, so `getPluginById`/`getEnabledPluginById` return null; `reinstall(id)` puts a fresh wrapper back (default options, default enabled state) without a reload. Events: `plugin-uninstalled`, `plugin-installed`, `plugin-state-change`. Code that uses another plugin goes through `getEnabledPluginById(...)?.` and must cope with null (e.g. `ai-suggest` without `semantic`, Chat with vault's notice, Editor settings' toolbar manager).

## Mobile layout (obsidian/workspace/mobile)

`App.initialize` installs `MobileLayout` before plugins load, so `Platform.isMobile/isPhone/isTablet` and
`app.isMobile` are final when plugins read them. Mode = touch-first device or iOS/Android UA, overridden per
device by Settings → Appearance → Mobile layout (`localStorage["vault-mobile-layout"]`; `app.emulateMobile()`
sets it and switches live). The sidedocks stay the same `WorkspaceSidedock` objects, moved into
`.workspace-drawer` wrappers; phones show one tab group (`.mod-visible`), a `.mobile-navbar`, and a
`.mobile-toolbar` driven by `mobileToolbarCommands`. Mobile layouts save to `workspace-mobile.json`.
Leaves serialise `state.eState` (cursor, scroll) so a reload restores them.

## Writing features in the editor (editor/features.ts)

Every Markdown editor installs `writingFeatures()`: search panel (`search-panel.ts`, Obsidian's
`.document-search-container` DOM on @codemirror/search), smart typography (`typography.ts`), word
completion (`word-complete.ts`, @codemirror/autocomplete, vocabulary from `host.getVocabulary`),
grammar underlines (`grammar-lint.ts`, issues from `host.lintGrammar`, Harper loaded lazily by core
plugin `grammar`), focus dimming and typewriter scrolling (`focus.ts`), the table toolbar and table
keys (`table-toolbar.ts`, table model in `commands.ts`) and the floating selection toolbar
(`toolbar-commands.ts`, which also exports the command lists the desktop and mobile toolbars share).
Each extension is always installed and reads its switch from `configFacet` at run time; the keys are
OpenMarkdown additions to `app.json` (`EditorConfig` in `editor/host.ts`: `smartTypography`,
`wordCompletion`, `grammarCheck`, `tableAutoFormat`, `tableToolbar`, `focusDim`, `typewriterScroll`,
`typewriterOffset`, `formattingToolbar`, `nativeSpellMenu`). Features that replace a community plugin
ask `host.isPluginEnabled(id)` and step aside. App-side pieces are pre-installed plugins (on by default, uninstallable; see above):
`writing-focus` (focus mode, zen, per-note cursor memory), `formatting-toolbar`, `grammar`.

## Paste & media (W6a)

- **External embeds** (`core-plugins/media/embeds.ts`, hidden always-on `external-embeds`): `![](youtube|youtu.be|shorts|vimeo|x.com/twitter status|remote .mp4/.mp3/.pdf)` become embeds. Reading view: `registerExternalEmbedHandler` in `obsidian/markdown/renderer.ts` runs on the sanitised fragment before it joins the document (so the `<img>` never loads). Live Preview: `externalEmbedRenderers` in `editor/live-preview/widgets.ts` (`ExternalImageWidget.toDOM`). YouTube uses youtube-nocookie, Vimeo `dnt=1`; tweets render publish.twitter.com oEmbed text (scripts dropped) or a link card. Also registers Obsidian's `editor:download-attachments` when nothing else has.
- **Smart paste** (`smart-paste`, off by default): `editor-paste`/`editor-drop` handlers writing Auto Link Title / Paste URL into selection / Auto Card Link Markdown; `cardlink` and `embed` code-block cards. Network goes through `core-plugins/smart-paste/network.ts` (`requestUrl` → bridge or fetch; a failure without the bridge is reported as CORS and the user is told once).
- **Media** (`media`, off by default): `media-player` view; YouTube/Vimeo driven over their postMessage APIs (no third-party script in the app origin), HTML media for vault files; timestamp links in Media Extended's format (`core-plugins/media/timefrag.ts`); clicks on `#t=` links seek the player (document capture listener for rendered Markdown, a `Prec.highest` mousedown handler for Live Preview).
- **Local images** (`local-images`, off by default): `core-plugins/local-images/download.ts` — content-hash names, attachment-folder setting, link format per `useMarkdownLinks`, one editor transaction per note.

## Knowledge (W5)

- **Note titles** (`core-plugins/file-explorer/note-titles.ts`, hidden `note-titles`): `app.json` `displayTitle` (`filename` | `property` | `heading`) and `displayTitleProperty` (default `title`). `customTitle(app, file)` is read by the file explorer (`FileItem.titleOf`, and sorting), quick switcher (extra `title` entries), `SearchResultDOM` titles (search, backlinks) and bookmarks. Tab headers: the plugin overrides `leaf.getDisplayText` per leaf; the view header and inline title keep the file name because they rename. Steps aside for `obsidian-front-matter-title-plugin`.
- **Link tabs** (`core-plugins/switcher/link-tabs.ts`, hidden `link-tabs`): `app.json` `openLinksInNewTab` wraps `workspace.openLinkText` (switches to a tab that already shows the note). Steps aside for `open-tab-settings`.
- **Vault replace** (`core-plugins/global-search/replace.ts`): matches are the query's content ranges from the index; `/regex/` terms replace with `$1` syntax. File recovery snapshot, then one `vault.process` per file that only applies if the text is unchanged since planning. `global-search:replace` (Mod+Shift+H), `global-search:undo-replace`. Preview rows are `SearchResultDOM.replacePreview`. Search results have keyboard focus (`.has-focus`) driven from the query input; a `Scope` owns Mod+Enter while the view has focus.
- **Tag rename** (`core-plugins/tag-pane/rename.ts`): text-level rewrite of body tags (skipping fences, inline code, `%%` comments, `$$` math) and frontmatter `tags:`/`tag:` lines (block, flow, string), dedupe on merge. Tag view context menu; steps aside for `tag-wrangler`. Property rename/type/delete (All properties view) take a File recovery snapshot first.
- **Custom order** (file explorer sort `custom`): `.obsidian/file-explorer.json` → `manualOrder: { "<folder path or />": ["child name.ext", …] }`. The Custom File Explorer sorting plugin keeps its order in a `sortspec.md` note per folder, which would write notes into every folder, so it is not used; unlisted children follow alphabetically. Drag in the top/bottom part of a row to reorder; renames and deletes keep the lists current.
- **Nested properties** (`properties/widgets.ts` `renderUnknownWidget`): objects and lists holding objects render as a collapsible key/value tree; scalars keep their YAML type; the whole value is written back, so unknown shapes survive.
- **Trash** (`core-plugins/trash`): view type `trash` lists `.trash` via the adapter; origins recorded at delete time in `.obsidian/trash.json` `origins`; restore renames back through the adapter and reconciles the vault tree. Steps aside for `trash-explorer`.
- **Periodic notes** (`core-plugins/periodic-notes`, off by default): `.obsidian/periodic-notes.json` has the Periodic Notes `data.json` shape and is seeded from it; command ids are the plugin's (`periodic-notes:open-weekly-note` …). `periods.ts` holds path/format/template logic shared with Calendar. `yield.ts` registers commands under a community plugin's ids and re-adds them when that plugin unloads.
- **Calendar** (`core-plugins/calendar`, off by default): view type `calendar-view` (the plugin's own `calendar` stays free), Calendar plugin DOM classes and `data.json` keys, command ids `calendar:show-calendar-view`, `calendar:open-weekly-note`, `calendar:reveal-active-note`.
- **Natural language dates** (`core-plugins/natural-dates`, off by default): `@` EditorSuggest and `parse.ts` (no dependency); NLDates' settings keys and command ids; links use the Daily notes format.

## Web app shell (W2)

- **Service worker** (`apps/web/src/sw.ts`, one classic script with no imports). `apps/web/precache-plugin.ts` lists every emitted file plus `public/` with content hashes at the end of `vite build`, writes `{buildId, files}` into `sw.js` in place of `self.__OM_PRECACHE__`, and puts `<meta name="openmarkdown-build">` in `index.html`. Install caches the list in `openmarkdown-app-<buildId>` (no `skipWaiting`); consent-gated downloads (tesseract, harper, pandoc, onnx …) and files over 8 MB are left out and cached on first fetch. `assets/*` are served cache-first from any retained build; navigations network-first (4 s) with the cached `index.html` as fallback. A build's cache is deleted only when no open window answers `openmarkdown-which-build` with that id. Dev (`vite`) serves the same worker without a manifest (resources and share target only).
- **Update flow** (`packages/app/src/pwa/sw-client.ts`): a waiting worker whose build equals the tab's is activated silently; otherwise `.vault-update-notice` offers Reload, which flushes saves (`workspace.flushSaves()` when W1 provides it, else dirty `TextFileView.save()`), asks when `app.saveStatus.hasUnsaved()`/a dirty view/`registerUnsavedCheck` says so, then posts `openmarkdown-skip-waiting` and reloads on `controllerchange`. `vite:preloadError` reloads at most once a minute and only when nothing is dirty.
- **Routes in `boot.ts`** (before any vault loads): `?capture=1` and `?share=<id>|1` → `pwa/capture-page.ts` (writes through the storage adapter with `core-plugins/quick-capture/capture.ts`, no App, no engine); `?launch=file|message|<id>` → `pwa/launch.ts` (a known folder vault with permission opens on the file; otherwise single-file mode: `LaunchedFilesAdapter`, a `MemoryAdapter` that writes back to the `FileSystemFileHandle`s); `?uri=obsidian://…` naming a vault picks that vault; `?action=capture|new|daily|…` aliases. `installPwaShell()` runs first (launch queue consumer, `beforeinstallprompt`, installed-window keys, worker); `installPwaInApp(app)` adds `app:install`, `app:share-file`, the file-menu Share item, Window Controls Overlay classes and the Safari storage banner.
- **IndexedDB `openmarkdown-pwa`** (`pwa/store.ts`, shared with the worker): `shares` (share-target payloads, deleted after capture) and `launch` (file handles, so a single-file window reloads onto the same files). A running window hands launched files to a new window by `postMessage`.
- **Quick capture** (`core-plugins/quick-capture`, id `quick-capture`, on by default): commands `quick-capture:open` (Mod+Alt+N) and `quick-capture:open-floating` (Document Picture-in-Picture → pop-up → sheet); options in `.obsidian/quick-capture.json`; `instance.capture(text, {destination, attachments})`. Daily note path/template from the Daily notes options. See docs/quick-capture.md.
- **Pop-outs** (`obsidian/workspace/popout.ts`): `installPopouts(Workspace)` replaces `openPopoutLeaf`/`moveLeafToPopout` on the prototype. A `window.open("")` document gets the main head's styles (kept in sync), body classes plus `is-popout-window`, the dom.ts helpers copied onto its realm's prototypes, keydown forwarded to `app`, `activeWindow`/`activeDocument` on focus, CodeMirror `setRoot`, and a vault-resource responder. The leaf lives in a `WorkspaceWindow` in `floatingSplit`; `window-open`/`window-close` fire. Blocked → split + notice. Not serialised into `workspace.json`.
- **Manifest** (`apps/web/public/manifest.webmanifest`): `display_override` WCO, `launch_handler` focus-existing, `file_handlers` (.md/.markdown/.canvas/.base → `?launch=file`), `protocol_handlers` web+obsidian → `?uri=%s` (the per-load `registerProtocolHandler` call is gone; Settings → General → App has a Set up button), `share_target` POST multipart → `./share-target`, `shortcuts`, `note_taking.new_note_url`, PNG icons.

## Device & AI (W6c)

All in `core-plugins/group-device.ts`, off by default and code-split: each definition is a `LazyCorePlugin` shell that `import()`s its implementation when enabled and loads it as a child (tests reach it as `instance.plugin.impl`). Shared dialogs (consent before a download, progress with cancel) in `core-plugins/ai-tools/ui.ts`; styles in `styles/device.css`.

- **Text recognition** (`ocr`): `ocr/engine.ts` lazily imports `tesseract.js/dist/tesseract.esm.min.js` with the worker and `tesseract-core-simd-lstm.wasm.js` as Vite `?url` assets (self-hosted). Language data (`@tesseract.js-data/<lang>/4.0.0_best_int`) is fetched only after consent into Cache Storage `openmarkdown-ocr-v1`; tesseract.js 7 cannot take `{code,data}` (its `initialize` joins `.data`), so the bytes are copied into its idb-keyval key `openmarkdown-ocr/<lang>.traineddata` just before a worker starts (`cacheMethod: "readOnly"`, `langPath` pointed at an invalid host so a miss never silently downloads) and deleted after. `TextDetector` is tried first. PDFs: PDF.js text, OCR for pages without text. Results cached in `idb` store `cache` (`ocr:<vault>:<path>:<mtime>:<size>:<langs>`). `app.plugins.plugins["text-extractor"]` is a non-enumerable accessor returning `{ api: { extractText, canFileBeExtracted, isInCache, getOcrLangs } }` only while Text Extractor is not installed; a real assignment replaces it.
- **Voice** (`voice`): `SpeechRecognition.available/install({langs, processLocally})` (also the older `availableOnDevice`), server recognition only when the user allows it; interim text is a CM6 widget and the sentence being read a CM6 mark (`voice/editor-marks.ts`); `voice/text.ts` has spoken punctuation and sentence segmentation with source offsets (`Intl.Segmenter` on a copy with links/embeds masked). No transcription of recordings (no local speech-to-text path). `available()` is only called when dictation starts: it crashes the renderer of headless Chromium 153, so Settings does not probe it.
- **AI tools** (`ai-tools`): `ai-tools/engines.ts` — `availability()` (with a 10 s cap: Chromium 153 headless never settles `Translator.availability`), `createWithConsent` (consent + `monitor` `downloadprogress`), Summarizer/Translator(+LanguageDetector)/Rewriter/Writer/Proofreader with the Prompt API standing in, and an optional OpenAI-compatible endpoint (key in localStorage). `AiModal` previews; actions apply as one editor change. `ai-tools-chat` view streams `promptStreaming` over the editor buffer.
- **Reminders** (`reminders`): `reminders/parse.ts` (Reminder, Tasks `⏰`/`📅`, Kanban `@{}` syntax; snooze/done rewrites; RFC 5545 `.ics` with floating local times and VALARM). Index from `metadataCache` `changed`; a 10 s tick fires an in-app card, `Notification` and `navigator.setAppBadge`; fired keys in localStorage `reminders-fired`. View `reminders-list`. Steps aside while `obsidian-reminder-plugin` is loaded.
- **Backups** (`backup`): `backup/zip-writer.ts` streams entries (deflate-raw via `CompressionStream` when smaller) into a `FileSystemWritableFileStream` in OPFS `openmarkdown-backups/<vaultId>/` or a picked folder (handle in `idb` `handles`); `navigator.locks` `openmarkdown-backup:<vaultId>` with `ifAvailable`; retention in `backup/store.ts` (`keepLast` ∪ newest per day ∪ newest per ISO week; named backups kept). Restore reads with `settings/zip.ts`, makes a "before restore" snapshot first, overwrites/creates only.
- **Web panes** (`webviewer/frames.ts`): `webviewer` options `frames[]`; commands `webviewer:open-frame-<id>`; view state `{url, frame}`. Preset framing headers were probed on 2026-09-14; without the companion the pane shows the known refusal with "Try anyway".
- **Load anyway** (`obsidian/app-internals/plugins.ts`): `desktopOnlyOverrides` (localStorage `desktop-only-load-anyway`), `canRun` honours it, and `makeRequire` returns `desktopModuleStub` proxies for Node/Electron module ids that throw (with a Notice naming plugin and API) when called. Settings → Community plugins shows "Try to load anyway" / "Stop loading anyway".


## Data safety (W1)

- **Saving** (`obsidian/workspace/view.ts` `TextFileView`): `requestSave` debounces 1.5 s idle / 2 s max-wait. `lastSavedData`/`dirty` change only after a write resolves; a failure keeps the buffer dirty and retries (1 s, 5 s, 30 s …). Each view keeps `safetyBase` (`\n` text, mtime, size of the disk version it is based on). `vault/save.ts` `checkedWrite` stats first and, if the file moved on, reads it and runs `vault/merge.ts` `merge3` (line diff3 on File recovery's Myers diff): clean → written (Markdown/txt only), conflict or an emptied file → nothing written. A `modify` event while dirty merges into the editor at once (cursor kept: `MarkdownView.setEditorText` applies per-line changes). Conflicts show `.vault-safety-banner.mod-conflict` + `ConflictModal` (keep mine / theirs / both); a dirty file deleted outside keeps its tab (`mod-deleted`, Restore / Discard). Internal view fields are `safety*`-prefixed so subclass fields (Kanban, Excalidraw, Canvas) cannot collide.
- **Bytes** (`vault/text-format.ts`): each adapter has a `codec` remembering BOM, dominant EOL and UTF-8 validity per path from the last string read (`TextDecoder` fatal); string writes re-apply BOM/EOL and refuse non-UTF-8 files (`NotUtf8Error`), which open read-only. Comparisons use `normalizeEol`, so opening a note never rewrites it.
- **App-wide** (`vault/safety.ts`, installed from `App.initialize`; `app.saveStatus`, `app.workspace.flushSaves()`): status bar `.vault-save-status`, sticky failure notices, `beforeunload` only while writes are pending, flush on `visibilitychange`→hidden/`pagehide`/`freeze`, orphan retries for closed views (unresolved conflict → `<name> (conflict <stamp>).md`), snapshots before in-app deletes, `navigator.storage.persist()` after the first note in a browser vault, the mass-delete question.
- **Journal** (`vault/journal.ts`): IDB store `journal` (DB version 4, strict durability), key `${vaultId}:${tabId}:${path}` → `{text, base, baseMtime, ts, dismissed?}`, put 250 ms after an edit, deleted when a write of that text is confirmed **or whenever every buffer on the note equals what was just confirmed on disk** (`DataSafety.onSaved`), so conflicts resolved with Keep both / Keep disk version, restored deleted files and adopted outside edits leave no stale entry. On startup, entries from tabs that do not answer a BroadcastChannel ping are handled per path: disk already equals the entry → dropped; disk still equals the entry's `base` (the edits never landed and nothing else changed the file) → written back silently with a "Restored" notice; otherwise → `RecoveryModal`. A restore never overwrites newer disk text without a compare: an unchanged file takes the edits, a clean `merge3` takes both, anything else opens `ConflictModal` (only a choice made in a compare writes the entry as-is). "Later" (or closing the prompt) marks the entries `dismissed`; they are not prompted for again but show `.vault-safety-banner.mod-recovery` (Restore / Compare… / Discard) when their note is opened. Off for memory vaults.
- **Leaving the page** (reload, navigate away, close tab): `beforeunload`, `pagehide` and `visibilitychange`→hidden each run `flushAll()`, which first puts every dirty buffer's journal entry with `idb.setNow` (transaction created synchronously on the already-open connection, then `IDBTransaction.commit()` so it does not wait for the put's result to reach a page that is going away), then starts each view's save. The disk write itself is asynchronous (check-before-write reads the file, OPFS/File System Access writes are promise-based) and usually cannot finish during unload; when it does not, the journal entry is on disk and the next load puts the text back without a prompt (above). Regression tests: `e2e/daily/regressions.spec.ts` "N1", "N6", "#1: typing then navigating away".
- **Tabs, panes, outside changes**: `vault/tabs.ts` BroadcastChannel `openmarkdown-vault:<id>` carries every adapter mutation (`vault` event `local-change`) and rescan/observer findings (`external-change`); receivers call `vault.applyRemoteChange`. Web Lock `openmarkdown-vault-leader:<id>` picks the tab that runs `vault/observer.ts` (FileSystemObserver on folder vaults); `vault.syncGate` spaces out unforced rescans (`sync(true)` forces). `vault/mirror.ts` forwards each editor change set to other Markdown views of the same file in the tab.
- **Rescans** (`vault.sync`): scan entries with `error` (and folders that fail to list) are kept; each missing path is confirmed with `stat`; removing more than 20 % (> 20 files) or every file of a vault at once triggers `mass-delete` instead. `HandleAdapter` stat rethrows anything but not-found, skips `*.crswap`, returns NFC paths and resolves NFC names to NFD disk names.
- **IndexedDB** (`vault/idb.ts`): `onversionchange` closes and notifies, `onblocked` notifies, failed/closed connections reopen, missing stores are added by a version bump.
- File recovery registers `vault.snapshotHooks`; merges, conflict resolutions, restores and deletes snapshot both sides regardless of the interval. Tests: `e2e/daily/data-safety.spec.ts`.

## Export & write-ups (W6b)

Every export starts from `core-plugins/export/render.ts` `renderNotes(app, files, opts)`: Reading-view render (MarkdownRenderer) into an off-screen `body > .vault-export-stage` (or `.print`), `settle()` waits for math, Mermaid, note embeds and images, the citations hook `internalPlugins.getEnabledPluginById("citations").renderBibliography(el, md, path)` runs, and `cleanRendered()` strips chrome. `export/portable.ts`: image bytes via `fetch(img.src)`, `standaloneSvg()` (copies MathJax glyph `<use>` targets from the document or `MathJax.startup.output.fontCache.getCache()` into local `<defs>`), `svgToPng()`.

- **Core plugin `export`** (on by default; options `.obsidian/export.json`; settings tab "Export"): `editor:copy-as-html` "Copy as rich text" (ClipboardItem with promised `text/html` + `text/plain` Markdown; inline styles; images ≤ 2 MB as data URLs; math/Mermaid → PNG; selection if any), `publish:copy-html-source`, `publish:export-docx`, `publish:export-epub`, `publish:export-pandoc`; file-menu items for notes and folders, files-menu for multi-select. `instance.buildBlob(files, "docx"|"epub")`, `instance.richCopyPayload(file)`.
- **DOCX** (`export/docx.ts`, lazy; library chunk `export/docx-lib.ts` → `docx` 9.7 MIT): headings → Heading1–6 with `_Ref_hN` bookmarks (built from `BookmarkStart/End` — `Bookmark` numbers every id 1), lists → numbering `vault-ol` (instance per list) / `vault-ul`, tables, `VaultCode` style, callouts as shaded + left-bordered paragraphs, real footnotes, images/math/Mermaid as PNG `ImageRun`s with explicit `altText.id` (docx reuses docPr id 1 otherwise).
- **EPUB 3** (`export/epub.ts`, lazy): `publish/zip.ts` store-only zip, `mimetype` first; OPF + `nav.xhtml` + `toc.ncx`; one chapter per note, or per H1 of a single note; math as inline SVG (`properties="svg"`), links rewritten across chapters. Passes epubcheck 5.2.1 with no errors or warnings.
- **Pandoc** (`export/pandoc.ts` + `pandoc-worker.ts`, lazy): consent modal (59 MB, GPL) → `fetch(pandoc.org/app/pandoc.wasm)`, else `requestUrl` (pandoc.org sends no CORS), or a user-picked file; SHA-256 pinned (`PANDOC_SHA256`, pandoc 3.9); kept in Cache Storage `vault-pandoc-v1`. The worker runs the WASI binary with `@bjorn3/browser_wasi_shim` (MIT/Apache): `hs_init_with_rtsopts`, then `convert(ptr,len)` on a JSON defaults document with `stdin`/`stdout`/`stderr`/`warnings`/output files in its root dir. Input Markdown from `portableMarkdown()` (wikilinks → text, image embeds → files, note embeds inlined, callouts → quotes).
- **PDF** (`publish/export-pdf.ts`, `workspace:export-pdf`, hidden `export-pdf` plugin, options in `.obsidian/export-pdf.json`): `PdfExportModal` (title, properties, TOC, page size, landscape, margins presets/custom mm, page numbers, header/footer `left | center | right` with `{{title}} {{date}} {{page}} {{pages}}`); `printNotes()` injects `<style id="vault-print-style">` with `@page { size; margin; @top-*/@bottom-* { content: … counter(page) … } }` — Chromium 131+ prints margin boxes (verified by `page.pdf()` text in the e2e), other browsers get a note instead of the options. Better Export PDF frontmatter `headerTemplate`/`footerTemplate` spans become tokens. Folder / multi-select → one PDF, `break-before: page` per note. `instance.exportPdf(files, options)`.
- **Slides** (`core-plugins/slides`): `advanced.ts` parses Advanced Slides syntax (`---`/`--`/`note:` and frontmatter `separator`/`verticalSeparator`/`notesSeparator`, `<!-- slide … -->`, `<!-- element … -->` → `span.vault-slide-element[data-attrs]` markers, `+` list items → fragments). `isAdvancedDeck()` routes `slides:start` to `deck.ts` (reveal.js 6 MIT, lazy; `body > .vault-reveal-container > .reveal > .slides`, `embedded`, theme CSS `reveal.js/theme/*.css?inline` with remote `@import`s removed; frontmatter `css` from the vault); plain notes keep the built-in presenter. `slides:speaker-view` (same-origin popup driven directly: current/next previews, notes, timer), `slides:export-html` (one self-contained file: reveal inline as a module, images as data URLs, math SVG). `instance.parseDeck(text)`, `instance.getReveal()`, `instance.exportHtml(file)`.
- **Citations** (`core-plugins/citations`, off by default, steps aside while `obsidian-citation-plugin` or `obsidian-zotero-desktop-connector` is enabled): options use obsidian-citation-plugin's keys (`citationExportPath`, `literatureNote*Template`, `markdownCitationTemplate` …) plus `cslStyle`, `zoteroUserId`, `zoteroApiKeySecret` (Keychain id). Sources: `.bib` (`bibtex.ts`, lazy), CSL-JSON, Better BibTeX JSON, Zotero web API (`include=data,csljson`, citekey from `citationKey`/`extra`). `library.ts` `findCitations()` (Pandoc `[@a, p. 4; -@b]` and narrative `@a`), Handlebars-subset templates. `cite.ts` `Formatter` over citeproc-js (lazy) with bundled APA/Chicago author-date + en-US locale (`csl/`, CC BY-SA), other CSL ids downloaded to `.obsidian/citations/styles/`. Editor: `[@` EditorSuggest, CM6 `hoverTooltip`; Reading view: post-processor → `span.vault-citation` + `div.vault-bibliography` in the last section; commands `citations:open-literature-note`, `insert-citation`, `insert-link`, `insert-content`, `insert-bibliography`, `update-bib-data`.
- Styles: `styles/export.css`. Tests: `e2e/daily/export.spec.ts` (`PANDOC_WASM=<file>` runs the pandoc conversion, `EPUBCHECK=<jar>` runs epubcheck).
