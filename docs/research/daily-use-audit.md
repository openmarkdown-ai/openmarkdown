# Daily-use audit: OpenMarkdown as a daily Markdown editor

Date: 2026-09-14. Build: `apps/web/dist` served by `e2e/server.mjs` on :5200.

## How this was done

I drove the built app with Playwright (Chromium, 1440×900, and 390×844 with touch),
using real keyboard and mouse input: `keyboard.type`/`press`, mouse drags, the
real clipboard (`navigator.clipboard.write` + `Meta+V`), synthetic paste and drop
events for files, and CDP `Input.imeSetComposition` for IME. After each step I
took a screenshot and looked at it. Console errors and page errors were logged
throughout. Expected behaviour comes from Obsidian's public documentation as
summarised in `docs/research/obsidian-features.md`.

Scripts, logs and all 120 screenshots are in the session scratchpad:
`/private/tmp/claude-501/-Users-dariuskohsg-Downloads-sharing-folder-openapps-openobsidian/e1a6d318-3001-4922-8817-6fd71c57aee0/scratchpad/audit/`
(`NN-*.mjs`, `results.log`, `errors.log`, `shots/`). Screenshot names below are
relative to `shots/`. The scratchpad is temporary. Re-run a script to get its
screenshots again.

Limits: headless Chromium does not map `Cmd+Shift+V` to "paste and match style",
so plain-text paste could not be checked. It also does not do browser zoom, and
`Ctrl+Tab` is taken by real browsers anyway. None of these three is reported as
a defect.

Totals: **62 checks**, **33 defects** (5 data-loss, 4 broken, 17 annoying,
7 cosmetic), and 12 missing daily-use features.

---

## Defects (sorted by severity)

| # | Sev. | Area | Repro | Expected | Actual | Evidence | Likely cause |
|---|---|---|---|---|---|---|---|
| 1 | **data-loss** | Saving | Browser-stored vault. Type in a note, then reload, close the tab, or navigate away within about 2 s. | The last keystrokes are on disk. Obsidian flushes on window close. | Lost. "Second line then reload fast", " +navaway" and " +closepage" were all missing after reopening. Closing a *pane* (Mod+W) does save. | `13-after-fast-reload.png`; `results.log` "after fast reload disk" | `packages/app/src/obsidian/workspace/view.ts:311` only saves from a 2 s debounce. Nothing in `packages/app/src` listens for `beforeunload`, `pagehide` or `visibilitychange` to flush dirty views. |
| 2 | **data-loss** | Saving | Type without a 2 s pause (a word every ~200 ms) for 12 s, then check the file with `adapter.read`. | Periodic saves while typing. | The disk copy stayed at **0 bytes** for all 12 s while the editor held 255 chars. Combined with #1, a crash, tab discard or reload during a long writing burst loses everything since the last pause. | `results.log` "continuous typing samples" | `view.ts:311` calls `debounce(save, 2000, true)`. The `resetTimer=true` restarts the timer on every keystroke, and there is no maximum wait. |
| 3 | **data-loss** | Multi-tab | Open the same browser vault in two browser tabs and the same note in both. Type "From tab A" in A, wait 3 s, then type "From tab B" in B, wait, then type in A again. | The other tab picks up changes, or at least warns about a conflict. | Tab B never shows A's edit. Each save overwrites the other: the final file was `…From tab A\nA again`, so **"From tab B" was silently lost**. A note created in tab A never appears in tab B. | `13-two-tabs-B.png`; `results.log` "disk after both" / "disk after A again" / "B sees new file? false" | `view.ts` `save()` calls `vault.modify` with no mtime or content check. The OPFS adapter has no change notification (`BroadcastChannel` or polling). |
| 4 | **data-loss** | Panes | In one window, open a note, split it (`workspace:split-vertical`) so both panes show it. Type "RIGHT edit" in the right pane, then within 2 s type "LEFT edit" in the left. Wait 4 s. | Panes on the same file mirror keystrokes live, as in Obsidian. | Panes do not mirror: right showed its text, left still showed the old text. After both saved, the file was `start\nLEFT edit` and **"RIGHT edit" was gone** from disk and from both panes. | `21-panes-conflict.png`, `20-two-panes.png` | Each MarkdownView keeps its own CM document. `view.ts:319-325` only reloads from disk on `modify` when the view is not dirty, so the last saver wins. |
| 5 | data-loss (minor) | Delete | Type in an open note, then delete it (`fileManager.trashFile`, the same path as the file menu) within 2 s. | The `.trash` copy includes the last edits. | " unsaved-before-delete" was missing from `.trash/A.md`. | `20-after-delete-open.png`; `results.log` "trash content of A" | The view is not saved before the trash move. |
| 6 | **broken** | Editor: code blocks | In Live Preview or Source mode, type <code>```js</code> and press Enter. | Three backticks (Obsidian auto-closes the fence). | Typing three backticks gives **four**: <code>```js`</code>, then <code>`</code> on the next line. The fence is never closed, so everything typed after it becomes code. In the long-note test a callout, list and paragraphs all turned into a code block. | `02-callout.png`, `03-fence.png`; `results.log` "fence after `" | `packages/app/src/editor/input.ts:52-62`. The 1st backtick pairs to <code>``</code>, the 2nd types over, and the 3rd sees no word character on either side and pairs again. Nothing checks for a fence being typed. |
| 7 | **broken** | Mobile | 390×844, `isMobile`, `hasTouch`, iPhone UA. Open the demo vault, tap a file, tap in the editor, open the right sidebar. | Mobile layout: drawer sidebars, full-width editor, mobile toolbar. | The desktop layout is squeezed. The left sidebar takes ~60% of the width and stays open after tapping a file, so the title wraps one syllable per line ("Wel/co/me"). There is no `.mobile-toolbar` and no `is-mobile` body class. The right sidebar leaves a 2-character editor column. Typing does work. | `15-mobile-open.png`, `15-mobile-note.png`, `15-mobile-right.png`, `15-mobile-palette.png` | No mobile layout exists. `packages/app/src/obsidian/app.ts:68` has `isMobile = false`. `Platform.isMobile` (`util.ts:262`) is never used to switch layout. |
| 8 | **broken** | Properties | Open a note and press Mod+; (Add file property). Type `due`, Tab, `2026-09-20`, Enter. | An empty row with the **key** input focused and the key suggester open. | The command writes a property literally named `property` and focuses its **value**. Typing "due" produced `property: due` and the date went nowhere. (The "+ Add property" button behaves correctly.) | `06-prop-add.png`, `06-prop-due.png` | `packages/app/src/core-plugins/markdown-core.ts:126-137` writes `nextPropertyName()` ("property") to the file and focuses the last input, which is the value. |
| 9 | **broken** (compat) | Commands | List `app.commands.commands`. | `templates:insert-template`, `templates:insert-current-date`, `templates:insert-current-time`. | Registered as `insert-template`, `insert-current-date`, `insert-current-time`. An existing vault's `hotkeys.json` binding for Insert template does nothing, and `executeCommandById("templates:insert-template")` fails. | `results.log` "commands without colon" | `packages/app/src/core-plugins/templates/index.ts:44,50,56`. AGENT-BRIEF says core plugin command ids must be passed in full. |
| 10 | annoying | Editor: links | Cursor inside `[[Welcome]]`, press Mod+Enter. | Open the link in a new tab (`editor:open-link-in-new-leaf`, default Mod+Enter per §8.1). | Nothing opens. Mod+Enter runs "Cycle bullet/checkbox", and open-in-new-tab is bound to Mod+Alt+Enter, which is Obsidian's key for "to the right". | `results.log` "Mod+Enter ->" | `packages/app/src/editor/commands.ts:799` (cycle bound to Mod+Enter) and `:828` (new-leaf bound to `mod("Enter","Alt")`). |
| 11 | annoying | Editor: tables | Table `\| 1 \| 2 \|`, cursor in the last cell, Tab, type X. | A new row with the cursor at the start of the first cell. | The cursor lands after the cell's padding, giving `\|    X \|     \|`. Tab into a filled cell puts the cursor before its text (`Y2`). | `02-table-tab.png`, `18-table.png` | `commands.ts:657`. `rowOffsets` adds `padded.length - padded.trimStart().length`, which for an empty cell is the whole padding. |
| 12 | annoying | Editor: lists | `1. first` Enter `2. second` Enter Tab, type `sub`. | The nested item renumbers to `1. sub`. | Stays `\t3. sub`. | `02-lists.png`; `results.log` "Tab on new ordered item" | `packages/app/src/editor/lists.ts:191`. The first item of each ordered list keeps its own number as the start, so a freshly indented item keeps its old number. |
| 13 | annoying | Editor: lists | `1. a / 2. b / 3. c / 4. d`, cursor on `2. b`, Mod+D (Delete paragraph). | The rest renumbers to 2, 3. | `1. a / 3. c / 4. d`. | `results.log` "Mod+D delete paragraph in ordered list" | `commands.ts:465` `deleteParagraph` calls `deleteLine` without `renumberOrderedLists`. |
| 14 | annoying | Editor: lists | `- one` / `\t- two`, cursor right after `\t- `, Backspace. | Remove the marker or outdent the item. | `\t-two`: only the space is deleted and the item becomes plain text. Backspace on an empty `- ` also leaves a bare `-`. | `results.log` "Backspace on nested item content start" | `lists.ts:219` delegates to lang-markdown's `deleteMarkupBackward`, which does not fit the OFM list tree here. |
| 15 | annoying | Properties | At the top of an empty note, type `---` then Enter. | A properties block appears (Obsidian turns a leading `---` into frontmatter). | A horizontal rule. Typing `status` Enter `draft` gives two body lines. | `07-hand-frontmatter2.png`, `18-frontmatter-typed.png` | The editor has no handling for a leading `---`. |
| 16 | annoying | Properties | "+ Add property", type `read` (a checkbox-typed key in this vault) or `due` (date), Enter, type a value. | The row uses the key's known type: a checkbox, or a date picker. | A Text widget until the note re-renders. Pressing Space stored `read: " "`. | `07-reviewed-date.png`; `results.log` "checkbox via space" | The widget is picked before the vault-wide inferred type is applied. |
| 17 | annoying | Properties | Focus a property key, Escape, Mod+Backspace. Then Mod+Z in the editor after property edits. | Mod+Backspace deletes the property. Mod+Z undoes property edits (§2.4 keyboard). | Neither does anything. | `results.log` "Mod+Backspace delete title property", "Mod+Z in editor after property edits" | `core-plugins/properties/metadata-editor.ts` keyboard handling. |
| 18 | annoying | Reload | In a browser vault, put the cursor on line 150 of a long note, scroll there, wait 2.5 s, reload. | Tabs, cursor and scroll are restored. | Tabs and split restored. **Cursor reset to 0:0 and the view scrolled to the top.** | `13-reload-restore.png`; `results.log` "reload restore" | `MarkdownView.getEphemeralState` (`markdown-view.ts:410`) exists, but its state is not written to or read from `workspace.json` on restore. |
| 19 | annoying | Reading view | Footnote `note[^1]`, hover the superscript in Reading view (with and without Mod) and in Live Preview. | A hover popover with the footnote text (§3 page preview: "Footnote refs preview footnote"). | No popover in any mode. Clicking the ref does scroll to the footnote. | `09-footnote-hover.png`, `10-footnote-meta-hover.png`, `18-fn-hover-lp.png` | `renderer.ts:514` handles footnote click only; page-preview has no footnote source. |
| 20 | annoying | Search | Mod+Shift+F, type `garden`, ArrowDown, Enter. | Move into the results and open the selected one. | Nothing happens: focus stays in the input and no file opens. | `10-search.png`; `results.log` "after search arrow+enter" | `core-plugins/global-search/search-view.ts:151`. The input keydown handles only Enter (re-run search). The results have no keyboard navigation. |
| 21 | annoying | Find in file | Mod+F / Mod+H. | Obsidian's document search bar: themed, match counter, Enter in Replace replaces the next match. | The stock, unstyled CodeMirror panel with lower-case `next / previous / all / match case / regexp / by word / replace / replace all`. No "3 of 4" counter. Enter in the Replace field did not replace. Replace all works and undoes in one step. | `04-replace.png`, `04-find-apple.png` | `@codemirror/search` default panel used unthemed. |
| 22 | annoying | Multi-cursor | Alt(Option)+click on two more lines, type `!`. Mod+Shift+L on a selection. | Alt/Option+click adds cursors (§8.3). Mod+Shift+L selects all occurrences. | Alt+click only moves the cursor (Cmd+click does add cursors). Mod+Shift+L does nothing. `editor:add-cursor-below` works. | `04-multicursor.png`; `results.log` "alt-click cursors", "Mod+Shift+L" | CM's default `clickAddsSelectionRange` (Meta on macOS) is not overridden. No select-all-occurrences binding. |
| 23 | annoying | Workspace | Drag a tab header onto the right edge of the editor area. | A drop overlay, then a split. | No overlay, no split. Dragging onto another tab bar does work. | `12-tab-drag-split-overlay.png`, `12-tab-drag-split.png` | `packages/app/src/obsidian/workspace/items.ts:168-169`. `dragover`/`drop` are only on `tabHeaderContainerEl`. |
| 24 | annoying | Rename | Inline title: type a name with `:` or an existing name, press Enter. | One notice. | Every error notice appears **twice**. | `08-invalid-rename.png`, `08-rename-existing.png` | `markdown-view.ts:259-267`. Enter calls `commit()`, then `editor.focus()` fires `blur`, which calls `commit()` again. |
| 25 | annoying | Rename | Click the view-header title, rename, Enter. | Focus returns to the editor. | The file renames but focus stays in the header title. | `08-header-rename.png`; `results.log` "after header rename … view-header-title" | View header title handler. |
| 26 | annoying | Page preview | Hold Mod while clicking a file in the explorer and keep the pointer there. | The preview sits beside the sidebar. | The popover opens *over* the file tree (x=50–510), covering the files below the pointer, with a tooltip stacked on top. While it is up, clicking the next file hits the popover. | `12-modclick-popover.png` | Popover placement in `obsidian/ui/popover.ts`. |
| 27 | cosmetic | Editor: paste | Put the cursor on an empty `- ` item and paste `- pasted item\n- second`. | No duplicated marker (§8.3, 1.14). | `- - pasted item`. | `results.log` "paste list onto '- '" | `input.ts` paste handler. |
| 28 | cosmetic | Empty tab | Open a vault with no file open. | Platform key names (⌘N). | Literal "Create new note (Mod+N)", "Go to file (Mod+O)" etc. | `01-demo-open.png`, `15-mobile-open.png` | Empty-state view text. |
| 29 | cosmetic | Tab menu | Right-click the active tab. | One entry per action. | "Export to PDF…" and "Close" each appear twice. "Find…/Replace…/Add file property" are mixed into the tab menu, and "Close all" has no icon. | `12-tab-menu.png` | Pane menu and tab menu items merged. |
| 30 | cosmetic | Properties | Date property row. | One date affordance. | Two near-identical calendar icons: the native picker and "Open daily note". | `07-reviewed-date.png` | `core-plugins/properties/widgets.ts`. |
| 31 | cosmetic | Live Preview | Paste an HTML table and move the cursor out of it. | The header row is styled as a header. | Header cells look like body cells. The demo embed's table header is bold. | `05-drop.png` | Live Preview table widget CSS. |
| 32 | cosmetic | Settings | Settings → Hotkeys, start typing. | The filter field has focus. | Keystrokes go nowhere until you click the filter. | `10-hotkeys-search.png` | `settings/tabs/hotkeys.ts`. |
| 33 | cosmetic | Console | Open any note with math, or the demo `Ideas.canvas`. | A clean console. | `console.warn` "No version information available for component [tex]/noerrors" and "[tex]/noundefined" on each math render. The canvas web card iframe loads `https://jsoncanvas.org` on open, which throws `ReferenceError: Prism is not defined` into the page's errors. A remote page loading on open is also at odds with "no server". | `errors.log` | The MathJax loader config. The demo canvas has a link node. |

No other uncaught page errors occurred in about 60 minutes of scripted use.

---

## Missing daily-use features noticed

1. **A mobile layout**: drawer sidebars, the mobile toolbar, a bottom navbar, and long-press menus (see #7).
2. **Live Preview table editor**: tables drop to raw pipes while the cursor is inside, with no cell widgets or row/column right-click menu. The `editor:table-*` commands exist.
3. **Rename this heading** (`editor:rename-heading`): missing, so heading links cannot be renamed safely.
4. **Footnote autocomplete** after `[^`, plus the footnote hover preview (#19).
5. **Keyboard navigation of search results** (#20).
6. **Restore cursor and scroll per tab on reload** (#18).
7. **Cross-tab or external change detection** with a "file changed on disk" merge or prompt (#3).
8. **Live mirroring of one note across panes** (#4).
9. **Trash browser / restore UI** for `.trash`. Obsidian lacks one too, but a browser vault has no Finder to fall back on.
10. **In-file search counter** ("3 of 12") and an Obsidian-styled search bar (#21).
11. **Select all occurrences** (Mod+Shift+L) and Alt/Option+click cursors (#22).
12. **Zoom hotkeys**: `window:zoom-in/out/reset-zoom` have no default keys. In a browser, Cmd+= zooms the whole page, which is acceptable, but that is not stated anywhere.

---

## What worked well

- **Smart lists**: Enter continuation, an empty item exits, Tab/Shift+Tab nesting three levels deep, task continuation (`- [x]` continues as `- [ ]`), splitting an item mid-line, and renumbering when inserting mid-list.
- **Autocomplete**: `[[` file suggest with typed closing brackets, `[[Note#` heading suggest, `[[Note#^` block suggest, `![[` embed suggest, `#tag` suggest with counts, and accepting inside an existing `[[Welc]]`. Unresolved links create the note when clicked.
- **Formatting**: Mod+B/I toggle on and off around a selection, Mod+L cycles checkboxes, Mod+/ comments, Alt+↑ moves a line, and heading folding works. Brackets and double quotes auto-pair and wrap selections, with type-over. Apostrophes are not paired.
- **Undo/redo**: 30 typed lines undone with 200× Mod+Z back to empty, then redone exactly.
- **Paste and drop**: HTML converts to Markdown (headings, bold, links, lists, tables). A URL pasted over a selection makes `[text](url)`. Clipboard images and synthetic image pastes become `Pasted image YYYYMMDDHHmmss.png` embeds. Dropped `.md` and `.pdf` files are copied into the vault and embedded. Pasted images persist in a browser vault and render after reload.
- **IME**: Japanese composition in plain text, in a list item and inside `[[` all commit correctly.
- **Inline title / Mod+N**: a new "Untitled" note has its title selected; Enter moves to the body. Renames rewrite backlinks (`[[Renamed via header 2]]`), invalid characters and name collisions are refused, and explorer rename via the context menu works.
- **File explorer**: drag a note onto a folder to move it. Context menus are complete. Deleting asks for confirmation and moves the file to `.trash`.
- **File recovery**: snapshots are taken, and Settings → File recovery → View shows versions with Show changes, Copy and Restore.
- **Templates**: the folder suggester, the template picker, and `{{title}}`/`{{date}}`/`{{time}}` all work, and template properties merge into existing frontmatter. **Daily notes**: "Open today's daily note" opens `Daily/2026-09-14.md`.
- **Reading view**: scroll position syncs with Live Preview when toggling with Mod+E (Section 38 in both). Checkboxes toggle in both modes without the view jumping. Embeds render, Mod+hover page previews work, heading links scroll to the heading, and Back (Mod+Alt+←) restores the note, mode and scroll.
- **Navigation**: the quick switcher fuzzy-matches ("gardn pln"), matches aliases ("Home" → Welcome), supports Mod+Enter for a new tab and Shift+Enter to create. The command palette fuzzy-matches ("tgl rd") and shows hotkeys. Back/forward work from the editor too, and Mod+W and Mod+Shift+T reopen closed tabs.
- **Workspace**: splits, dragging tabs between groups, pinned tabs (clicking a file opens a new tab), stacked tabs, sidebar resizing (300 → 417 px), and tabs and splits restored on reload in a browser vault.
- **Settings**: recording a hotkey saves to `hotkeys.json`, conflicts are shown in red, and the custom key works in the editor. Light/dark toggle, font-size slider, readable line length (720 → 1034 px), spellcheck and line numbers all apply at once.
- **Performance**: a 5,000-line / 324 KB note opens in 158 ms. Typing takes about one frame (median 16.6 ms, p95 16.9 ms), 20 Enter presses take 149 ms, and scrolling end to end had a worst frame of 64 ms (Live Preview) and 84 ms (Reading). A vault of 3,000 notes starts in 2.4 s with links resolved at start-up. The quick switcher takes 12–22 ms per keystroke over 3,000 notes, and engine search 7 ms.

---

## Checks performed (62)

Editor typing: headings · bullet Enter continuation · empty item exits · Tab/Shift-Tab nesting · task continuation · numbered continuation · nested numbered renumber ✗ · table typing · table Tab ✗ · code fence ✗ · tilde fence · Tab in code block · callout/blockquote continuation · `[[` suggest · heading suggest · block suggest · embed suggest · alias typing · `#tag` suggest · unresolved link create · Mod+B/Mod+I toggle · bracket/quote pairs and wrap · undo/redo ×200 · Alt+click cursors ✗ · add-cursor-below · Mod+Shift+L ✗ · Mod+F ✗ (styling) · Mod+H replace ✗ (Enter) · paste text · paste HTML · URL over selection · paste image (event and clipboard) · drop files · IME ×3 · Backspace list markup ✗ · Mod+D renumber ✗ · Mod+L · Alt+↑ · Alt+Enter follow · Mod+Enter ✗ · Mod+click LP link · drag file from explorer into editor · fold heading · Mod+/ comment.

Notes and files: daily note · templates (folder, picker, variables) · Mod+; add property ✗ · Add property button (date, list, checkbox) ✗ (types) · property type menu · `---` frontmatter ✗ · rename via header ✗ (focus) · rename via inline title ✗ (double notice) · rename via explorer · drag to folder · delete → .trash · file recovery view.

Reading view: scroll sync · checkbox click · footnote hover ✗ · footnote click · embeds · link hover · heading link · back restores scroll.

Navigation and settings: quick switcher (fuzzy, alias, new tab, create) · command palette · global search keyboard ✗ · hotkey record/conflict · theme toggle · font slider · readable line length · spellcheck · line numbers.

Workspace: Mod+click new tab · split · tab drag between groups · tab drag to split ✗ · pin · stacked · back/forward · Mod+W / Mod+Shift+T · sidebar resize/toggle · reload restore ✗ (cursor) · same note in two panes ✗.

Mobile: layout ✗ · open note · type · toolbar ✗ · palette · sidebars ✗.

Persistence: save after 3 s · reload within 150 ms ✗ · close tab ✗ · navigate away ✗ · continuous typing ✗ · two browser tabs ✗ · delete with unsaved edits ✗ · image persists after reload.

Performance: 5,000-line note open/type/scroll/reading · 3,000-note startup · quick switcher latency · search latency.
