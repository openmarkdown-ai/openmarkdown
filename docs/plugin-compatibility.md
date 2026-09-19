# Community plugin compatibility

Checked on 2026-09-14. The bundles tested are the top 25 by download count, as real, unmodified release copies of `main.js`, `manifest.json` and `styles.css`. Each one was installed into `?vault=demo` and driven through the UI with Playwright.

**Result:** all 24 plugins that are not desktop-only load. On the production build (`apps/web/dist`, served on port 5200), every check in the 24 scenarios passes: **245 of 245**. The only desktop-only plugin, `realclaudian`, is refused, as it is on Obsidian mobile.

## How to run

```sh
cd apps/web && npx vite build && cd ../..
node e2e/server.mjs &                                   # port 5200
node e2e/compat/run.mjs <bundles-dir> <out-dir>         # every scenario
node e2e/compat/run.mjs <bundles-dir> <out-dir> tasks dataview
```

- **Scenario files.** Each scenario is `e2e/compat/<name>.mjs`. It lists the plugins it installs, exercises them, and asserts on what a user would see.
- **Output.** Screenshots go to `<out-dir>/<name>-<n>-<label>.png`. Results, including console errors and page errors, go to `<out-dir>/compat-results.json`.
- **Page errors.** "No page errors" is a check in every scenario. The only errors a scenario may ignore are listed in its `ignoreErrors`, and each one is a network limit covered below.
- **Other targets.** `COMPAT_URL` points the runner at another server, such as a Vite dev server.
- **Style Settings.** The scenario expects the Minimal theme at `<bundles-dir>/../obsidian-minimal/Minimal.css`.

## Results

| Plugin | Loads | Core flows that work (all asserted) | Known gaps |
|---|---|---|---|
| **dataview** 0.5.68 | yes | <ul><li>DQL `TABLE`, `LIST FROM #tag` and `TASK … WHERE !completed`</li><li>DataviewJS blocks and inline `$=` queries, once enabled in settings</li><li>Inline `= this.file.name` renders inline in its paragraph in both reading view and Live Preview</li><li>Queries render inside callouts and inside embedded notes</li><li>Checking a task in a `TASK` result completes it in the source file, and the query refreshes</li></ul> (13/13) | none found |
| **obsidian-tasks-plugin** 8.4.0 | yes | <ul><li>A ` ```tasks not done``` ` query finds all 4 open tasks in the demo vault and shows visible checkboxes and a task count</li><li>Toggling a task in a result writes `[x] … ✅ date` to its file, and the result refreshes</li><li>The edit modal opens, and Apply rewrites the task line</li><li>A Live Preview checkbox click goes through Tasks, which adds the done date</li><li>The `Toggle task done` command works</li><li>Editor auto-suggest offers dates and priorities, and accepting one inserts it</li></ul> (13/13) | none found |
| **calendar** 1.5.10 | yes | <ul><li>The view is created in the right sidebar on load</li><li>Existing daily notes show a dot</li><li>Clicking a day asks for confirmation, then creates the note in the Daily notes folder (`Daily/`) and opens it; the new note gets its dot</li><li>Clicking today opens the existing note</li></ul> (9/9) | As in Obsidian, `calendar:show-calendar-view` has a `checkCallback` that hides it once the view exists. The view is a tab in the right sidebar, which starts collapsed in the demo layout. |
| dataview + tasks + calendar | yes | Every demo note opens in reading view and Live Preview without a page error. A single note renders all three plugins' output. (18/18) | none found |
| **table-editor-obsidian** 0.23.2 | yes | <ul><li>Tab formats the table and moves to the next cell</li><li>Enter on the last row adds a row</li><li>Tab re-formats after typing</li><li>The sidebar toolbar opens, and "insert column left" works</li></ul> (8/8) | <ul><li>Tab and Enter act only in source mode, which is the plugin's own behaviour.</li><li>A just-added row can fall outside a table action until the file saves. The plugin reads the metadata cache, as it does in Obsidian.</li></ul> |
| **obsidian-outliner** 4.10.2 | yes | <ul><li>Mod+Shift+Up/Down move an item with its children</li><li>Tab and Shift+Tab indent the subtree</li><li>Mod+Up/Down fold and unfold</li><li>Vertical lines span the children</li><li>Dragging a bullet moves the item</li></ul> (14/14) | The vertical line sits a few px right of the parent bullet. |
| **obsidian-linter** 1.33.0 | yes | <ul><li>"Lint the current file" fixes trailing spaces, blank lines and heading spacing, adds a YAML timestamp, and saves</li><li>Lint on Mod+S works</li><li>The settings tab renders</li></ul> (11/11) | The plugin's own setting text says "Ctrl + S" on Mac. |
| **editing-toolbar** 4.1.4 | yes | <ul><li>The toolbar mounts</li><li>Bold, Highlight, Header 2 and Undo act on the selection</li><li>The "following" toolbar appears next to a mouse selection</li></ul> (9/9) | AI features need network access. |
| **templater-obsidian** 2.25.0 | yes | <ul><li>The insert-template picker works</li><li>`tp.file.title`, `tp.date.now`, `tp.date.tomorrow` and `tp.file.folder` render</li><li>`tp.file.cursor` places the cursor</li><li>"Create new note from template" works</li></ul> (10/10) | <ul><li>User scripts and system commands are desktop-only by design.</li><li>`<% %>` syntax highlighting needs CodeMirror 5 modes; our `window.CodeMirror` is a stub.</li></ul> |
| **quickadd** 2.25.0 | yes | <ul><li>A new Capture choice can be created and its target set</li><li>Run QuickAdd asks for a value and writes it to the target file</li></ul> (9/9) | The AI assistant needs network access. Macros and user scripts were not exercised. |
| **obsidian-kanban** 2.0.51 | yes | <ul><li>Create a board, add lists and cards, and drag a card between lists</li><li>Double-click edits a card inline in the embedded Markdown editor</li><li>`[[` link suggest and tag suggest work inside a card</li><li>The board saves as Markdown</li></ul> (18/18) | Popout windows fall back to a split, because a browser page cannot own a second window. |
| **obsidian-excalidraw-plugin** 2.27.3 | yes | <ul><li>A new drawing opens, and the rectangle tool adds a shape</li><li>The drawing saves as compressed JSON</li><li>Note embeds and heading embeds render in the drawing</li></ul> (11/11) | <ul><li>Fonts and script libraries fetched from the network are unavailable.</li><li>The Electron always-on-top trick is unavailable.</li></ul> |
| **obsidian-icon-folder** (Iconize) 2.14.7 | yes | <ul><li>The folder menu has "Change icon"</li><li>The picker searches Lucide icons and emoji</li><li>The icon appears on the folder, persists and survives expanding the folder</li><li>"Remove icon" works</li></ul> (9/9) | Downloading extra icon packs needs a CORS-free `requestUrl`: the companion extension or a proxy. |
| **tag-wrangler** 0.6.5 | yes | Right-clicking a tag in the tag pane shows "Rename #tag". Renaming rewrites body and frontmatter tags, and the tag pane updates. (8/8) | none found |
| **recent-files-obsidian** 1.7.10 | yes | The view lists notes newest first. Clicking an entry opens that note and makes it the active file. (5/5) | none found |
| **homepage** 4.5.0 | yes | <ul><li>"Set to active file" works</li><li>"Open homepage" works from the command and from the ribbon</li><li>The settings tab renders</li></ul> (8/8) | Open-on-startup cannot be tested against the in-memory demo vault, because a reload wipes it. |
| **obsidian-style-settings** 1.0.9 | yes | <ul><li>Reads the `@settings` blocks from the installed Minimal theme</li><li>The Style Settings tab lists Minimal's sections</li><li>A toggle adds its body class (`h1-l`)</li><li>A variable setting writes its CSS variable</li></ul> (10/10) | none found |
| **obsidian-minimal-settings** 9.0.0 (with Minimal) | yes | The settings tab renders all its rows. The focus-mode command toggles its body class. | Minimal callouts in Live Preview have slightly more bottom padding than they should. The cause is paragraph margins; it is cosmetic. |
| **omnisearch** 1.31.0 | yes | <ul><li>Indexes the vault, using IndexedDB and MiniSearch</li><li>The search modal returns ranked results with excerpts, and Enter opens the note</li><li>The in-file modal and the settings tab work</li></ul> (8/8) | <ul><li>Its local HTTP API needs Node `http`; the plugin catches the failure.</li><li>The sponsor iframe is blocked.</li></ul> |
| **obsidian-importer** 3.1.5 | yes | <ul><li>The modal opens, and the format list and filter work</li><li>A Markdown import through the browser file picker writes the note</li></ul> (8/8) | Importers that need desktop file dialogs or Node use the web path only. |
| **remotely-save** 0.5.25 | yes | The settings tab renders. Switching the service, for example to WebDAV, shows its settings. (5/5) | Actual sync needs a CORS-free `requestUrl` (the companion extension) and credentials. |
| **copilot** 4.0.8 | yes | The chat view opens in the right sidebar with its input and model picker. The settings tab renders. (5/5) | <ul><li>Model calls need a provider key and CORS-free requests.</li><li>Its update check to github.com is CORS-blocked (console noise only).</li></ul> |
| **smart-connections** 4.7.2 | yes | Embeds the vault locally. The connections view lists related notes with scores. (4/4) | <ul><li>The "Getting started" story is an Electron `<webview>` and stays blank.</li><li>The embedding model downloads from the network on first run.</li></ul> |
| **tasknotes** 4.13.0 | yes | <ul><li>The create-task modal, with its CodeMirror field, creates a task note with frontmatter</li><li>The Pomodoro and statistics views open</li><li>The default tasks Bases view lists the new task</li></ul> (7/7) | Bases belongs to another agent. The Bases toolbar (Sort/Filter/Properties/New) renders unstyled. The Kanban, calendar and agenda Bases views were not exercised. |
| **obsidian-git** 2.39.0 | yes | The source-control and history views open. The settings tab renders. "Initialize repo" creates `.git` through isomorphic-git. (6/6) | <ul><li>**Status and commit fail** with `reading 'isBuffer'`. The plugin uses Node's global `Buffer` unless `Platform.isMobileApp` is true, and the host defines none. The fix is a `Buffer` polyfill (npm `buffer`, MIT) installed before plugins run. It is not added yet because it is a new dependency.</li><li>Push and pull need the companion extension.</li></ul> |
| realclaudian 2.2.7 | refused | n/a | `isDesktopOnly: true`: it spawns the Claude Code CLI. It cannot work in a browser by design. |

## Host fixes made

The four failures reported at the start:

| # | Symptom | Cause and fix |
|---|---|---|
| 1 | The Tasks query found 1 of 4 tasks, and checkboxes were missing | Not a metadata problem: `listItems`, `task`, `parent` and positions were already right. Tasks renders each result with `MarkdownRenderer.render` and then unwraps `el > p` with `el.insertBefore(p.firstChild, p)`. Our render wrapped every block in a reading-view section `<div>`, so `insertBefore` threw on the first task and the rest of the list was never drawn. |
| 2 | Dataview `` `= this.file.name` `` rendered "-" on its own line | Same cause. Dataview inlines a single-paragraph result by checking the render container's first child. |
| 3 | The `insertBefore` page error | Same cause. The host path was `MarkdownRenderer.render` in `renderer.ts`. |
| 4 | Calendar could not create daily notes | The daily-notes helper calls `app.foldManager.save(file, null)` when there is no template, and our `FoldManager.save` dereferenced `info.folds`. Separately, the demo vault had `Daily/` notes but no `daily-notes.json`. |

All fixes, file by file:

**Obsidian API and core**
- `packages/app/src/obsidian/markdown/renderer.ts`:
  - `MarkdownRenderer.render` puts block elements directly into `el`, with no section wrapper divs, as Tasks and Dataview expect.
  - Reading-view checkbox toggling ignores boxes inside plugin code-block output, finds the renderer on `previewMode`, and matches nested sections. Before this, a Dataview or Tasks result checkbox was toggled a second time by the host.
- `packages/app/src/obsidian/vault/vault.ts` — writes made directly through `vault.adapter` (`write`, `process`, `remove`, `rename`, `mkdir` …) now raise `raw` and `create`/`modify`/`delete`. In Obsidian the file watcher does this. Dataview and Tasks rewrite task lines through the adapter, and before this change the file changed on disk but no view or cache noticed.
- `packages/app/src/obsidian/app-internals/misc.ts` — `FoldManager.save` accepts the `null` that `load()` returns. Calendar and Periodic Notes daily-note creation threw.
- `packages/app/src/obsidian/ui/suggest.ts`:
  - `EditorSuggest` positions its popover inside a CodeMirror `requestMeasure`. Reading layout from the update listener threw on every keystroke, which broke Tasks auto-suggest.
  - A reused picker clears the previous query on reopen. Templater's second pick found nothing.
- `packages/app/src/obsidian/ui/setting.ts` — added the internal `Setting` methods `setNavigable`, `setIcon`, `setAction` (Importer) and `setVisibility` (Excalidraw).
- `packages/app/src/obsidian/workspace/workspace.ts`:
  - `setActiveLeaf` with focus expands a collapsed sidebar, so Copilot's chat is visible.
  - When a sidebar view opens a file in the main area, `getActiveFile()` and `file-open` follow that file (Recent Files).
- `packages/app/src/obsidian/markdown/markdown-view.ts` — the edit mode exposes `sourceMode` and `cm` (Advanced Tables), and both modes have `getFoldInfo`/`applyFoldInfo` (Templater).
- `packages/app/src/obsidian/markdown/embeddable-editor.ts`:
  - Plugin-supplied extensions live in a compartment. They are built eagerly for Kanban and lazily for TaskNotes, which sets `options` after `super()`.
  - Embedded editors get the class `vault-embedded-editor`.
- `packages/app/src/obsidian/i18n.ts` (new) and `packages/app/src/boot.ts` — a small global `i18next` (`t`, `language`, `exists`, `getFixedT`). Tag Wrangler's dialogs crashed without it.
- `packages/app/src/obsidian/app.ts` — `getAccentColor()` returns the default accent as hex, never `""`. Excalidraw's colour code crashed on the empty string.
- `packages/app/src/obsidian/app-internals/internal-plugins.ts` — core plugin wrappers expose `views` and `load()`. Excalidraw's view setup threw part-way without them.

**Core plugins**
- `packages/app/src/core-plugins/canvas/internal-api.ts` (new), plus `canvas/view.ts` and `canvas/node-view.ts` — Obsidian's internal `view.canvas` object: create and remove file nodes, render, and start and stop editing. Excalidraw builds its note and heading embeds on it.

**Editor**
- `packages/app/src/editor/live-preview/widgets.ts` — a Live Preview task checkbox lets the click reach editor listeners first and toggles only if nobody called `preventDefault`. Tasks takes over the toggle to add the done date.
- `packages/app/src/editor/editor.ts` — added Obsidian's editor formatting methods (`toggleMarkdownFormatting`, `toggleBulletList`, `toggleNumberList`, `toggleCheckList` …) for editing-toolbar, and `getFoldInfo`/`applyFoldInfo`.
- `packages/app/src/editor/live-preview/fold.ts` — heading and list folds are registered as a CodeMirror fold service, so `foldable()` answers. Outliner's fold commands need it.
- `packages/app/src/editor/commands.ts` — "Move line up/down" no longer claims Mod+Shift+Up/Down, which Obsidian leaves unbound (`obsidian-features.md` §8). The binding was taking Outliner's shortcut.
- `packages/app/src/editor/live-preview/indent.ts` — leading indentation in Live Preview lists is wrapped in an inline-block `.cm-indent`, so a leading tab no longer collapses under the hanging indent.

**Styles**
- `packages/app/src/styles/editor.css`:
  - `img.cm-widgetBuffer` is pinned to zero width. Minimal's full-width-image rule stretched them into blank lines.
  - `.cm-contentContainer` no longer has `position: relative`. Outliner's vertical lines measure against the scroller.
  - Embedded editors (Kanban cards) get no page margins or full-height sizer.
- `packages/app/src/styles/theme.css` — defined the list, indentation-guide, collapse-icon and checkbox-hover variables that `editor.css` used but nothing defined.
- `packages/app/src/styles/controls.css` — base styles for plain links and for password, email, url, tel and time inputs (Remotely Save, Smart Connections).
- `packages/app/src/styles/reading.css` — no focus ring on the inline title.

**Demo vault**
- `packages/app/src/demo-vault.ts` — added `.obsidian/daily-notes.json` with folder `Daily`, so Calendar, Homepage and the core plugin agree on where daily notes live.

No `crates/vault-ofm` change was needed. The metadata Tasks and Dataview read (`listItems[].task`, `parent`, positions, `sections`) was already correct.

## Cannot work in a browser by design, or needs the companion extension

| Capability | Plugins affected | Why |
|---|---|---|
| Node `child_process`, `fs`, local HTTP servers, Electron `<webview>` and `@electron/remote` | Templater user scripts and system commands, Omnisearch HTTP API, Smart Connections "Getting started", realclaudian | There is no Node or Electron in a web page. The plugins guard these paths, so apart from realclaudian they degrade instead of failing. |
| CORS-free `requestUrl` | obsidian-git remotes, Remotely Save sync, Copilot and QuickAdd and editing-toolbar AI, Iconize icon packs, Excalidraw libraries | Browsers enforce CORS. The companion extension, or a user-configured proxy, provides a CORS-free transport. |
| Popout windows | Kanban, Excalidraw | Popouts fall back to a split in the main window. |
| CodeMirror 5 modes (`window.CodeMirror.defineMode`) | Templater and Dataview syntax highlighting | The shim is a stub, so it is decoration only. |

## Open items

- **obsidian-git needs a `Buffer` global.** Add the MIT `buffer` polyfill before plugins load. This needs approval, because it is a new dependency.
- **Bases toolbar styling for TaskNotes views** is reported to the Bases owner (`packages/app/src/core-plugins/bases/`).
- **Editor layout.**
  - The Live Preview hanging indent for space-indented wrapped lines uses an average character width, so wrapped lines under nested items misalign.
  - With line numbers on, the gutter number beside a large heading sits about one line low.
- **Undefined theme variables.** About 30 variables used in `editor.css` (tables, tags, links, blockquotes) are still undefined in `theme.css`.
