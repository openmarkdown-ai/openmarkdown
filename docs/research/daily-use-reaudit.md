# Daily-use re-audit: OpenMarkdown after the nine workstreams

Date: 2026-09-15. Build: `apps/web/dist` served by `e2e/server.mjs` on :5200 (not rebuilt).
Baseline: `docs/research/daily-use-audit.md` (2026-09-14, 33 defects) and `docs/PLAN-daily.md`.

## How this was done

Same method as the first audit. Playwright drove Chromium at 1440×900, and at 390×844
with `isMobile`, `hasTouch` and an iPhone UA. Input was real keyboard, mouse and touch
(`keyboard.type/press`, `mouse.click/down/move`, `touchscreen.tap`), plus the real
clipboard. One browser ran at a time. I looked at every screenshot cited below with the
Read tool. `pageerror` and console errors and warnings were logged throughout.

Scripts, logs and screenshots are in the session scratchpad (temporary):
`/private/tmp/claude-501/-Users-dariuskohsg-Downloads-sharing-folder-openapps-openobsidian/e1a6d318-3001-4922-8817-6fd71c57aee0/scratchpad/reaudit/`
(`NN-*.mjs`, `results.log` and its per-run copies, `shots/`, `dl/`). Screenshot names below
are relative to `shots/`.

Totals: of the 33 original defects, **23 are FIXED, 4 PARTIAL and 6 STILL BROKEN**. The
fresh pass found **12 new defects**: 1 data-loss risk, 3 broken, 3 annoying and 5 cosmetic.
There were no uncaught page errors from the app itself. The only `pageerror` still comes
from the remote jsoncanvas.org page embedded in the demo canvas (#33).

Some findings are already fixed in source but not in this build: the vault replace with
unquoted words, the conflict notice covering the banner, and the duplicate calendar icon on
date properties. They are marked **"fixed in source, not in this build"**. The coordinator
also named an uncaught quota error and a backup restore that did not show changed files. I
did not reproduce either one; this pass did not exercise quota exhaustion or backup restore.

---

## (a) The 33 original defects

| # | Orig. sev. | Area | Status | Evidence (re-run) |
|---|---|---|---|---|
| 1 | data-loss | Save on reload / close / navigate | **PARTIAL** | Reload within 150 ms: the text is on disk (`"…Second line then reload fast"`). Mod+W then reload: on disk. **Navigate away and closing the tab still do not reach disk.** The next load opens "Recover unsaved changes" listing the note (65 / 76 characters). Restore put `+navaway` and `+closepage` on disk. So nothing is lost, but the user has to act. `01-after-navaway.png`, `01-after-closepage.png`; `results.log` "#1 …" |
| 2 | data-loss | Continuous typing | **FIXED** | Typing a word every ~200 ms for 14 s, the disk trails the editor by at most ~2 s: `2s disk=45 editor=55 … 13s disk=271 editor=280`. |
| 3 | data-loss | Two browser tabs | **FIXED** | Tab B shows tab A's edit within 2.5 s. Edits from both tabs survive (`…From tab A\nA again\nFrom tab B`). A file created in A appears in B. Near-simultaneous typing in both tabs gives a conflict banner ("Nothing has been overwritten", Keep mine / Keep both / Compare) instead of a silent overwrite. `01-two-tabs-B.png`, `01-sim-B.png` |
| 4 | data-loss | Two panes, same note | **FIXED** | Panes mirror live (`["start\nRIGHT edit","start\nRIGHT edit"]` before the left pane was touched). Disk ends as `start\nRIGHT editLEFT edit`. `04-panes.png` |
| 5 | data-loss (minor) | Delete with unsaved edits | **FIXED** | `.trash/A.md` = `"delete me\n unsaved-before-delete"`. |
| 6 | broken | Code fence | **FIXED** | `` ` `` → `` `` `` → ` ``` `, then `js` Enter gives ` ```js\n\n``` ` with the fence closed. `02-fence.png` |
| 7 | broken | Mobile layout | **FIXED** | `is-mobile is-phone is-ios` body classes, a bottom navbar (back, forward, new tab, tab overview, menu), a drawer sidebar that closes when a file is tapped, and a 21-button toolbar above the keyboard that follows the viewport height (y=447 at h=500). No horizontal overflow (390/390). `07-mobile-open.png`, `07-mobile-left-drawer.png`, `07-mobile-typing.png`, `07-mobile-kbd-sim.png` |
| 8 | broken | Mod+; add property | **PARTIAL** | Mod+; now focuses the **key** input and opens the key suggester. Enter after the key moves to the value (`status: draft` saved). **The original repro still fails:** `due`, **Tab**, `2026-09-20`, Enter. Tab while the suggester is open drops focus to `<body>`, and the value goes nowhere (`---\ndue:\n---`). See new defect N4. `03-8-after-tab.png`, `03-8b-final.png` |
| 9 | broken (compat) | Template command ids | **FIXED** | `templates:insert-template`, `templates:insert-current-date`, `templates:insert-current-time`. |
| 10 | annoying | Mod+Enter on link | **FIXED** | Markdown leaves went 1 → 2, with `Welcome.md` opened in a new tab. `02-mod-enter.png` |
| 11 | annoying | Table Tab | **FIXED** | Tab in the last cell adds a row with the cursor at the start of its first cell (`3:2`). Tab into a filled cell selects its content and the table re-aligns. `02-table-tab.png` |
| 12 | annoying | Nested ordered renumber | **FIXED** | `1. one\n2. two\n\t1. sub` |
| 13 | annoying | Mod+D in ordered list | **FIXED** | `1. a\n2. c\n3. d` |
| 14 | annoying | Backspace on list markup | **FIXED** | `- one\n\t- |two` + Backspace gives `- one\n- two` (outdent). Backspace on an empty `- ` removes the marker. |
| 15 | annoying | `---` at top | **FIXED** | `---` Enter gives a Properties block with the key input focused. The following `status` Tab `draft` loses the value because of N4. `02-frontmatter-typed.png` |
| 16 | annoying | Property widget from vault type | **STILL BROKEN** | `metadataTypeManager` reports `read` as checkbox and `due` as date (inferred). A new `read` row still renders `metadata-input-longtext`, and Space stores `read: " "`. Even a re-rendered note with `read:` / `due:` empty shows text widgets. `03-16-read.png`, `03b-rerender.png`. Cause: `core-plugins/properties/types.ts:37`. `typeFor` uses only `getAssignedType` (types.json), then `inferType(key, value)` from the row's own value, never the vault-wide inferred type. |
| 17 | annoying | Mod+Backspace / Mod+Z on properties | **PARTIAL** | Mod+Z in the editor now undoes property edits (the deleted `title` came back). Mod+Backspace deletes a *selected* row (icon click, then Escape). **The original repro still fails:** click the key, Escape, Mod+Backspace. The first Escape only closes the key suggester (`metadata-editor.ts:153` returns while `keySuggest.isOpen`), so focus stays in the input and nothing is deleted. |
| 18 | annoying | Cursor/scroll restore on reload | **FIXED** | Cursor `150:8` and scrollTop 2878 are restored, and typing `Z` lands on line 150. `05-reload-cursor.png`, `01-reload-restore.png` |
| 19 | annoying | Footnote hover | **FIXED** | The popover shows "The footnote." in both Live Preview and Reading view. `02-fn-hover-lp.png`, `02-fn-hover-reading.png` |
| 20 | annoying | Search keyboard nav | **FIXED** | ArrowDown selects "Garden plan", and Enter opens `Projects/Garden plan.md` with focus in the editor. `04-search-arrow.png` |
| 21 | annoying | Find / replace bar | **PARTIAL** | The bar is themed, with case / word / regex icons and a "1 of 4" counter. Replace all works. **Enter in the Replace field replaces only from the 2nd press.** The 1st press just selects the first match (`after Enter 1: unchanged`, `after Enter 2: PEAR banana apple…`). `02-replace.png`, `05-replace-enter.png` |
| 22 | annoying | Alt+click / Mod+Shift+L | **FIXED** | Alt+click adds cursors, and `!` was typed on 3 lines. Mod+Shift+L selects all 3 occurrences of `foo`. `02-multicursor.png` |
| 23 | annoying | Drag tab to editor edge | **FIXED** | A `workspace-drop-overlay` covers the right half, and the drop creates a split (groups 1 → 2). `04-tab-drag-split-overlay.png`, `04-tab-drag-split.png` |
| 24 | annoying | Double rename notice | **FIXED** | One notice each for an invalid character and an existing name. `04-invalid-rename.png`, `04-rename-existing.png` |
| 25 | annoying | Focus after header rename | **STILL BROKEN** | The file renames, but `activeElement` stays `view-header-title`. A `Z` typed next is lost (not in the note). `04-header-rename.png`. Cause: `obsidian/workspace/view.ts:212-227`. `finish()` removes `contenteditable` but never focuses the editor. |
| 26 | annoying | Mod+click popover placement | **STILL BROKEN** | The popover sits at x=50–510 over the file tree, with the explorer tooltip on top. `04-modclick-popover.png`. Placement is in `obsidian/ui/popover.ts` (~l.252 anchors to the target rect). |
| 27 | cosmetic | Paste list onto `- ` | **FIXED** | `- pasted item\n- second` |
| 28 | cosmetic | Empty tab key names | **FIXED** (desktop) | "Create new note (⌘N)". `00-demo-open.png`. On iPhone it reads "Ctrl+N" (new N10). |
| 29 | cosmetic | Tab context menu duplicates | **FIXED** | 20 distinct items, each with an icon; no Find/Replace mixed in. `04-tab-menu.png` |
| 30 | cosmetic | Two calendar icons on date property | **STILL BROKEN** (*fixed in source, not in this build*) | The `created` row shows the native picker plus the daily-note icon. `07-mobile-typing.png`, `02-props-keyboard.png` |
| 31 | cosmetic | LP table header style | **FIXED** | `TH` weight 600, `TD` weight 400. `02-lp-table-header.png` |
| 32 | cosmetic | Hotkeys filter focus | **STILL BROKEN** | After opening the Hotkeys tab, focus is on the nav item and `bold` went nowhere; the filter is empty. `04-hotkeys-filter.png`. `settings/tabs/hotkeys.ts` never focuses the filter input on display. |
| 33 | cosmetic | Console noise / remote canvas page | **STILL BROKEN** | `console.warn` "No version information available for component [tex]/noerrors" and "[tex]/noundefined" on every math render. Opening `Ideas.canvas` loads `https://jsoncanvas.org/` (9 requests), which throws `PAGEERROR: Prism is not defined`. `05-canvas.png`. Source: `packages/app/src/demo-vault.ts:200` (link node). |

Counts: FIXED 23 (#2–7, 9–15, 18–20, 22–24, 27–29, 31). PARTIAL 4 (#1, 8, 17, 21).
STILL BROKEN 6 (#16, 25, 26, 30, 32, 33).

---

## (b) New defects (fresh daily-use pass), by severity

| # | Sev. | Area | Exact repro | Expected | Actual | Screenshot | Likely cause |
|---|---|---|---|---|---|---|---|
| N1 | **data-loss (risk)** | Unsaved-edit journal | Browser vault. Open `K.md` (`a\nb\nc\n`), wait 2.5 s, type `mine`. Right away run `app.vault.adapter.write("K.md","a\nb\nc\ntheirs")`. Wait 4 s. Click **Keep both** in the conflict banner (disk becomes `a\nb\nc\nmine\ntheirs`), wait 4 s, reload. | No recovery prompt; the conflict was resolved and saved. | "Recover unsaved changes" lists `K.md · 10 characters · The file changed on disk since`. It comes back on every load. In `10-safety.mjs` the same stale entry for `Ext.md` survived a later clean external replace (`replaced cleanly`). Its Restore opens a compare whose primary button, **Keep unsaved edits**, would overwrite the newer disk text with the already-resolved buffer. Keep mine does not leave an entry. | `11-S1-stale-journal.png` (log), `10-F-modal-again.png`, `10-F-after-restore.png` | `obsidian/vault/journal.ts:90`. `confirm()` returns early when `written` holds a different text. After Keep both, `safetyResolveConflict` (`workspace/view.ts:652-676`) calls `setViewData(bothText)` and saves, so the confirmed text never equals the journalled `mine` text, and the entry is never deleted. |
| N2 | **broken** | Vault replace | Demo vault. Mod+Shift+F, `garden`, run `global-search:replace`, type `GROVE` in Replace, click **Replace all**. | Replace prose matches; do not silently break links (or at least warn). | "Replaced 6 matches in 4 files". It rewrote link targets and tags: `[[Projects/Garden plan]]` → `[[Projects/GROVE plan]]` in Kitchen shelves, `![[Projects/Garden plan#Beds]]` in Linking notes, and `[[Projects/Garden plan\|…]]` in Welcome. Every one became an unresolved link, and `tags: [project, garden]` became `GROVE`. The preview does show these rows, but nothing flags them as links. Undo restored all 4 files. | `14-replace-preview.png`, `14-replace-done.png`, `14-replace-undone.png` | `core-plugins/global-search/replace.ts:92-105`. `planReplace` takes every content hit, with no exclusion of wikilink/embed targets or frontmatter. |
| N3 | **broken** (*fixed in source, not in this build*) | Vault replace, unquoted words | In the replace view, change the query to `garden plan` (unquoted). | One phrase, or clearly AND-ed terms replaced consistently. | The preview (13 results) lists overlapping per-term matches for the same text: `# GardenGROVE plan` and `# Garden planGROVE`, `[[Projects/GardenGROVE plan]]` and `[[Projects/Garden planGROVE]]`. | `14-replace-multiword.png` | `replace.ts` `replaceQuery`/`matchesFor` on multi-term queries. |
| N4 | **broken** | Properties keyboard | Any note: Mod+; (or `---` Enter at the top, or "+ Add property"). Type a known key (`due`, `status`), which opens the key suggester, press **Tab**, type a value, Enter. | Tab moves to the value input, as Enter does. | Focus drops to `<body>` and the typed value is lost. `due` stays empty and `status` stays empty. Enter instead of Tab works. | `03-8-after-tab.png`, `02-frontmatter-typed.png` | `core-plugins/properties/metadata-editor.ts:153`. The keydown handler returns while `keySuggest.isOpen`, and the suggester (`suggests.ts`) does not handle Tab, so the browser's default Tab moves focus away. |
| N5 | annoying (privacy) | External embeds | Demo vault: create a note containing `![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)` and `![](https://x.com/jack/status/20)`, then just open it. | Per PLAN principle 5 ("Nothing leaves the machine unless the user asks… network features opt-in"), nothing loads until a click. | Before any click the page requests `youtube-nocookie.com/embed/…` and `publish.twitter.com/oembed?...`. In Reading view it adds Google (`google.com/js/th`, `jnn-pa.googleapis.com`), `i.ytimg.com`, `fonts.gstatic.com` and YouTube stats/log_event beacons. `external-embeds` is on by default. There is also console noise: `Unrecognized feature: 'web-share'` and `ERR_NAME_NOT_RESOLVED` ×8. In Live Preview at 2.5 s the tweet line was blank (no card, no link), while Reading view showed the card. | `15-embeds-lp.png`, `15-embeds-reading.png`; `results.log` "external requests on render" | `core-plugins/media/embeds.ts` (~l.125-186) renders the iframe / fetches oEmbed on render. The click-to-load button (`vault-embed-load-icon`, l.81) is not the default. |
| N6 | annoying | Recovery prompt | After any unsaved-at-close entry (for example `Fail.md` after closing the tab while saves fail), close the prompt with ×, reopen the note, keep writing (it saves), reload. | Once dismissed, keep the pending text reachable (a banner on the note or File recovery) but stop interrupting; or ask "keep for later / discard". | The modal returns on every load with every entry, including superseded ones (N1). The note itself shows the disk text with no hint that journalled text is pending. | `10-E-reopen.png`, `10-F-modal-again.png` | `obsidian/vault/safety.ts` (~l.480-555, startup offer). There is no "dismissed" state per entry. |
| N7 | annoying | Focus mode + formatting toolbar | Settings → Editor → Formatting toolbar = Fixed. Open a note, press Mod+Shift+Enter (focus mode). | The toolbar stays available, or the mode explains it hides chrome. | The toolbar is `display:none` in focus mode (only "Focus mode — Esc to exit" shows), so toolbar users lose formatting while writing. Escape leaves focus mode. Typewriter scrolling, paragraph dimming, table keys/toolbar and vim (`gg dd u A`, `:w`, Tab in a table) all worked together. | `12-focus-typewriter.png`, `13-vim-focus.png` | `styles/writing.css` / `core-plugins/writing-focus` hides view chrome, including `.vault-formatting-toolbar`. |
| N8 | cosmetic | Note titles | Settings → Files and links → "Show note title from" = First heading. Open a note whose first line is `# My Real Title`. | Only file lists and note tabs use the heading. | The right sidebar's **Backlinks, Outgoing links and Outline** tab headers get `aria-label` / tooltip "My Real Title" instead of their view names. | `14b-right-sidebar-titles.png`; log `R:backlink=My Real Title/My Real Title` | `core-plugins/file-explorer/note-titles.ts:120-128` patches every leaf whose `view.file` is set, including linked sidebar views. |
| N9 | cosmetic (*fixed in source, not in this build*) | Conflict notice | Same note open in two panes in tab B. Type in tab A and tab B within ~1 s. | One notice, not covering the banner. | Two identical "changed outside the app… Compare…" toasts stack at the top right, covering the right pane's banner buttons ("Compare…") and the view-header menu. | `01-sim-B.png` | Conflict notice raised per view. |
| N10 | cosmetic | Mobile empty state | 390×844 iPhone UA, `?vault=demo`, no file open. | No hotkey hints on a phone (Obsidian mobile shows none), or ⌘ on iOS. | "Create new note (Ctrl+N)", "Go to file (Ctrl+O)", "See recent files (Ctrl+O)", "Close (Ctrl+W)". | `07-mobile-open.png` | `obsidian/workspace/view.ts:801`. `keyName` checks only `Platform.isMacOS`, not mobile. |
| N11 | cosmetic | DOCX export | Demo vault, open Formatting, run `publish:export-docx`. | The title once. | `Formatting.docx` (61 KB, valid zip) starts "Formatting Formatting": the file-name title plus the note's own `# Formatting`. Math and diagrams are embedded as images, fine. EPUB (34 KB) also exported. | `16-docx.png`; `dl/Formatting.docx` | `core-plugins/export/docx.ts`. The title is added without checking for a matching leading H1, and there is no "include file name" option as the PDF dialog has. |
| N12 | cosmetic | Settings on phone | 390×844, Settings → Voice. | Consistent row layout. | Some toggles sit under their description ("Allow server-based recognition", "Spoken punctuation") and others sit inline at the right ("Highlight the sentence being read"). No overflow in any of the 37 tabs. | `17-phone-voice.png` | Mobile settings CSS for rows with long descriptions. |

### Checked and working in the fresh pass (no defect)

- **Data safety.** An external non-overlapping write while dirty auto-merges, with a notice. An overlapping one shows a conflict banner, and Keep both keeps both. An external write when clean reloads the editor. An external delete while dirty shows "Your text is still here" with Discard / Restore file. A failing adapter write shows "Could not save… Retrying in 5 s — your text is kept" and status "Not saved", and saves once the adapter recovers. Closing the tab while writes fail shows `beforeunload`, and the text is offered on reopen. Rename while dirty (API and inline title) keeps the text. Switching notes then reloading within 100 ms is on disk. Another tab deleting the note shows a deleted banner, and another tab renaming it follows the rename.
  (`10-A-ext-nonoverlap.png`, `10-B-ext-overlap.png`, `10-C2-ext-delete.png`, `10-D-failing.png`, `10-E-reopen.png`, `11-J-other-tab-delete.png`, `11-K-other-tab-rename.png`)
- **Editor.** Every formatting-toolbar button runs; Heading opens a menu. All 16 table-toolbar buttons work: rows, columns, align, sort, format. Zen mode enters and Escape exits. Vim needs the `:q!` confirmation, then normal/insert/undo/`:w` work, and turning it off restores normal typing.
- **Knowledge.** Title from H1 appears in explorer, tab and quick switcher ("My Real Title Edited / xyz renamed"), and follows H1 edits and inline-title renames. Tag rename rewrote frontmatter (`#demo` → `#showcase`, "2 changes in 1 note") and rejected `bad tag` with a clear notice. Vault replace preview, Replace all and Undo ("Restored 4 files") work.
- **Paste and media.** URL over a selection gives `[selected words](url)`. Clipboard image becomes `![[Pasted image …png]]`. `local-images:download-current` downloaded a remote image ("Downloaded 1 image"). Smart paste against a CORS-blocked site explains that the companion extension is needed. The pandoc export asks before downloading 59 MB. The PDF dialog has page size, margins, TOC, header/footer and page numbers, and hands off to the print dialog.
- **Settings.** All 37 tabs (with every optional core plugin enabled) render at 1440×900 and at 390×844 with no element past the viewport and no horizontal scroll. Every toggle outside Sync, community plugins, grammar and vim was flipped on and back off with no errors and no toggle that failed to change. Mobile toolbar: all 21 buttons act on the text, and Configure opens.

Not verified here: "Paste URL as link card" against a page with a readable `<title>` (the only reachable page was the app itself, and the command left a plain URL with no notice). Also storage-quota exhaustion and backup restore.

---

## (c) Verdict

The data-loss class from the first audit is essentially closed. Nothing typed was lost to a
reload, a second tab, a second pane, an external write, an external delete, a rename or a
failing disk. The one remaining gap in #1 (navigate away / close tab) is covered by the
journal and a recovery prompt rather than a disk write. The new safety machinery has one
sharp edge, N1: a conflict resolved with **Keep both** leaves a stale journal entry, and its
Restore path can overwrite newer text. Fix that before calling data safety done.

The editor, mobile layout, search, tables, lists, find/replace and workspace defects are
largely fixed, and the new writing, knowledge, export and settings features hold up together
under real input. The largest correctness problem in the new features is N2: vault replace
silently breaks wikilinks. Next come the property keyboard flow (N4, and the still-broken
#16 widget types), and the privacy stance of on-by-default external embeds (N5), which
contradicts the plan's own principle. The rest is polish: header-rename focus, popover
placement, hotkeys filter focus, console noise, and a few cosmetic items.
