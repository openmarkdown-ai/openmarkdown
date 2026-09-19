# What people who write Markdown every day need — and what makes them leave a web editor

Researched 2026-09-14. This builds on [market.md](market.md), which covers demand for a web version and the competitors, and [obsidian-features.md](obsidian-features.md), which lists what Obsidian itself ships; neither is repeated here. The question is narrower: **what should OpenMarkdown build in, beyond Obsidian's core, so that someone who writes in it all day stays?**

Sources and method:
- **Forum votes** come from the Discourse JSON API on forum.obsidian.md (`/c/feature-requests/8/l/latest.json?order=op_likes&status=open`, plus `/t/<id>.json` for single threads), pulled today. The forum uses likes on the first post as votes.
- **Plugin downloads** come from `community-plugin-stats.json` joined to `community-plugins.json` in `obsidianmd/obsidian-releases`, pulled today: 7,612 plugins, 147.7M downloads.
- **The HAS / PARTIAL / MISSING marks** come from grepping and reading `packages/app/src`, `apps/web` and `crates/`. Short paths below are relative to `packages/app/src/`.
- **Browser support** comes from `mdn/browser-compat-data`.
- The Obsidian app was not inspected.

---

## 1. The most-voted open feature requests on the Obsidian forum

Only requests still marked open are counted. Ranking is by votes. Legend for **Web?**: **B** = a browser app can build it now · **H** = buildable but hard · **P** = limited by the platform · **—** = not a daily-writing item, not audited. The **OM** column is OpenMarkdown's status today.

| # | Request | Votes | Views | Web? | OM | Evidence / note |
|---|---|---|---|---|---|---|
| 1 | [Use H1 or `title` property as the display name](https://forum.obsidian.md/t/687) | 386 | 54,794 | B | MISSING | Tab/inline title = basename (`obsidian/markdown/markdown-view.ts:99`). Plugin: Front Matter Title (73k) |
| 2 | [Nested (multi-level) YAML in Properties & Bases](https://forum.obsidian.md/t/63826) | 293 | 30,445 | B | MISSING | Objects shown as JSON strings (`core-plugins/properties/types.ts:67`) |
| 3 | [Tag mass action: rename / merge / delete across files](https://forum.obsidian.md/t/567) | 290 | 46,769 | B | MISSING | Nothing in `core-plugins/tag-pane/`. Plugin: Tag Wrangler (1.09M) |
| 4 | [Open links/files in a new tab by default](https://forum.obsidian.md/t/7347) | 289 | 90,567 | B | PARTIAL | Only `focusNewTab` (`settings/tabs/editor.ts:18`) |
| 5 | [Edit embedded notes in place](https://forum.obsidian.md/t/15339) | 279 | 31,141 | H | MISSING | Embeds are read-only renders |
| 6 | [Obsidian for web](https://forum.obsidian.md/t/2049) | 273 | 257,232 | — | HAS | This product |
| 7 | [Vault-wide search & replace](https://forum.obsidian.md/t/4395) | 267 | 48,184 | B | MISSING | Replace is current-file only (`core-plugins/markdown-core.ts:45`) |
| 8 | [File explorer custom (manual) sort](https://forum.obsidian.md/t/1602) | 250 | 53,300 | B | MISSING | 6 fixed orders (`core-plugins/file-explorer/sort.ts:7-29`) |
| 9 | [IDE-style tabs: reuse / switch to an already-open note](https://forum.obsidian.md/t/46671) | 239 | 22,201 | B | MISSING | `workspace.ts:593-613` always calls `getLeaf` |
| 10 | [Render block embeds inline](https://forum.obsidian.md/t/27093) | 210 | 19,285 | B | MISSING | CSS/render option |
| 11 | [Properties wrangler: insert / rename / remove in all files](https://forum.obsidian.md/t/63806) | 210 | 18,489 | B | PARTIAL | Rename and delete exist (`core-plugins/properties/index.ts:57,100`); bulk insert does not |
| 12 | [`[[links]]` to folders](https://forum.obsidian.md/t/874) | 203 | 82,975 | B | MISSING | Link format must stay readable by Obsidian |
| 13 | [Default template for new notes](https://forum.obsidian.md/t/10332) | 202 | 21,233 | B | MISSING | Templates only for daily/unique notes |
| 14 | [Custom date/time display in Properties](https://forum.obsidian.md/t/64139) | 197 | 29,124 | B | MISSING | |
| 15 | [Canvas: pen drawing](https://forum.obsidian.md/t/50245) | 186 | 62,260 | B | — | Excalidraw/Ink plugins cover this |
| 16 | [Link types / link metadata](https://forum.obsidian.md/t/6994) | 183 | 49,936 | B | — | Changes the file format; wait for Obsidian |
| 17 | [Checkboxes in tables](https://forum.obsidian.md/t/554) | 178 | 47,260 | B | MISSING | |
| 18 | [Canvas: card links in Graph](https://forum.obsidian.md/t/49697) | 164 | 15,943 | B | — | |
| 19 | [Drawing/sketching with a stylus](https://forum.obsidian.md/t/3090) | 162 | 144,644 | B | — | Plugins |
| 20 | [Ignore accents/diacritics in suggestions, switcher, search](https://forum.obsidian.md/t/1655) | 158 | 11,518 | B | MISSING | "ASCII-only case folding" (`crates/vault-index/src/util.rs:223`) |
| 21 | [Same settings/themes/plugins across vaults](https://forum.obsidian.md/t/41789) | 148 | 24,663 | B | — | An IndexedDB profile could provide this |
| 22 | [Definition lists](https://forum.obsidian.md/t/224) | 147 | 21,990 | B | MISSING | Renderer extension, off by default |
| 23 | [Bases: "New" button uses a template](https://forum.obsidian.md/t/102639) | 144 | 8,424 | B | HAS | `newItemTemplate` (`core-plugins/bases/controller.ts:239`) |
| 24 | [Update heading/block links inline when renamed](https://forum.obsidian.md/t/25412) | 136 | 12,127 | B | MISSING | No `rename-heading` command; `crates/vault-index/src/rename.rs` handles files only |
| 25 | [Portable mode](https://forum.obsidian.md/t/915) | 127 | 97,315 | — | HAS | A browser app is portable by nature |
| 26 | [Canvas: tags in cards](https://forum.obsidian.md/t/51315) | 115 | 10,587 | B | — | |
| 27 | [Manage the trash inside the app](https://forum.obsidian.md/t/2227) | 114 | 8,391 | B | MISSING | Setting only (`settings/tabs/files-links.ts:169`) |
| 28 | [Be the handler for `.md` files outside a vault](https://forum.obsidian.md/t/314) | 113 | 28,999 | P | PARTIAL | Manifest has `file_handlers`, but nothing reads `launchQueue`. Works on Chromium desktop only |
| 29 | [PDF highlighting/annotation](https://forum.obsidian.md/t/31015) | 113 | 66,593 | H | MISSING | Plugin: PDF++ (791k) |
| 30 | [Search text inside PDFs](https://forum.obsidian.md/t/511) | 110 | 20,754 | B | MISSING | pdf.js text layer |
| 31 | [PDF export: working internal links](https://forum.obsidian.md/t/16384) | 109 | 20,907 | B | PARTIAL | Print dialog only (`core-plugins/publish/export-pdf.ts:65`) |
| 32 | [Sync in the background on mobile](https://forum.obsidian.md/t/25906) | 107 | 16,488 | P | — | A PWA has no reliable background execution |
| 33 | [Render Markdown in backlinks/search results](https://forum.obsidian.md/t/195) | 104 | 11,808 | B | MISSING | Results are highlighted plain text (`global-search/result-dom.ts:131`) |
| 34 | [Canvas-level properties](https://forum.obsidian.md/t/49619) | 101 | 9,733 | B | — | |
| 35 | [PDF export on mobile](https://forum.obsidian.md/t/15753) | 100 | 23,845 | P | PARTIAL | Android print-to-PDF works; iOS goes through Share → Print |
| 36 | [Remove unused/orphan attachments](https://forum.obsidian.md/t/4856) | 99 | 23,054 | B | MISSING | |
| 37 | [Full preview when a canvas is embedded](https://forum.obsidian.md/t/51614) | 97 | 10,409 | B | — | |
| 38 | [Exclude files completely from all indexers](https://forum.obsidian.md/t/52025) | 95 | 25,684 | B | PARTIAL | `userIgnoreFilters` hides files but does not skip parsing (`settings/tabs/files-links.ts:222`) |
| 39 | [Remember cursor/scroll position per note](https://forum.obsidian.md/t/962) | 93 | 19,674 | B | PARTIAL | Kept for open tabs and history only (`obsidian/markdown/markdown-view.ts:410-443`) |
| 40 | [Nested tags in Graph](https://forum.obsidian.md/t/11386) | 92 | 17,393 | B | — | |

Smaller writing-specific threads, fetched one by one:

| Thread | Votes |
|---|---|
| [Export PDF with TOC/bookmarks](https://forum.obsidian.md/t/9282) | 60 |
| [Android camera button in toolbar](https://forum.obsidian.md/t/30351) | 58 |
| [Obsidian Send (share a note)](https://forum.obsidian.md/t/23899) | 54 |
| [Split down/right on phone](https://forum.obsidian.md/t/45865) | 49 |
| [Live team collaborative editing](https://forum.obsidian.md/t/6058) | 43 (43,842 views) |
| [Citations & bibliography](https://forum.obsidian.md/t/11495) | 43 (45,937 views) |
| [Adjustable readable line length](https://forum.obsidian.md/t/7564) | 43 |
| [Reorder paragraphs by drag](https://forum.obsidian.md/t/5049) | 41 |
| [Code blocks: wrap/scroll/smart indent in Live Preview](https://forum.obsidian.md/t/33718) | 39 |
| [OCR images to make them searchable](https://forum.obsidian.md/t/6854) | 36 |
| [Zoom into bullets](https://forum.obsidian.md/t/1657) | 36 |
| [Move/indent by heading](https://forum.obsidian.md/t/4202) | 35 |
| [iA Writer-style authorship annotations](https://forum.obsidian.md/t/72232) | 28 |
| [Sync spellcheck user dictionary](https://forum.obsidian.md/t/29796) | 26 |
| [macOS autocorrect](https://forum.obsidian.md/t/68567) | 22 |
| [Word count of rendered text](https://forum.obsidian.md/t/4758) | 19 |
| [Zen + typewriter mode](https://forum.obsidian.md/t/2788) | 16 |
| [Formatting toolbar on desktop](https://forum.obsidian.md/t/49950) | 15 |

**Reading.** The highest-voted requests are about *managing* a vault of notes, not typing: display titles, bulk tag and property edits, search & replace, sort order, tab behaviour. The typing aids (focus mode, toolbar, typewriter) get few forum votes. They show up instead as huge plugin download counts (§4). People install a plugin for these rather than wait for Obsidian.

---

## 2. What the daily-driver editors are praised for

✅ built in · ◐ partial · ❌ absent · 🧩 via plugin/extension.

| Capability | Typora | iA Writer | Bear | Ulysses | Zettlr | MarkText | Notion | Logseq | SilverBullet | HackMD | VS Code | Drafts | Apple Notes | Obsidian core | **OM today** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Syntax hidden while typing (WYSIWYG / Live Preview) | ✅ | ◐ | ✅ | ◐ | ◐ | ✅ | ✅ | ◐ | ✅ | ❌ split | ❌ split | ❌ | ✅ | ✅ | ✅ |
| Focus mode (dim everything but current line/sentence) | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | 🧩 | ❌ | ❌ | 🧩 | **MISSING** |
| Typewriter scrolling | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | 🧩 | ✅ | ❌ | 🧩 | **MISSING** |
| Word count + reading time | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | 🧩 | ✅ | ❌ | ◐ | PARTIAL (no reading time) |
| Writing goals | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 🧩 | **MISSING** |
| Style/grammar check | ❌ | ✅ Style Check | ❌ | ✅ | ◐ LanguageTool | ❌ | ◐ AI | ❌ | ❌ | ❌ | 🧩 | ❌ | ◐ OS | 🧩 | **MISSING** |
| Visual table editing (rows/cols, drag, align) | ✅ | ✅ Smart Tables | ✅ | ❌ | ◐ | ✅ | ✅ | ❌ | ◐ | ❌ | 🧩 | ❌ | ✅ | ✅ | PARTIAL |
| Paste/drag image → local file | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ upload | ✅ | ◐ | ✅ | ✅ | HAS |
| Formatting toolbar / slash menu | ◐ menu | ◐ | ✅ | ✅ | ✅ | ◐ | ✅ `/` | ✅ `/` | ✅ `/` | ✅ | ❌ | ✅ keys row | ✅ | `/` + mobile bar | PARTIAL (`/` only) |
| Export: PDF / DOCX / HTML, with styles | ✅ | ✅ | ✅ | ✅ styles | ✅ Pandoc | ◐ | ✅ | ◐ | ❌ | ✅ | 🧩 | ✅ | ◐ | ◐ PDF | PARTIAL (print, HTML) |
| Copy as rich text / HTML | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ | ❌ | ✅ | 🧩 | ✅ | ✅ | ✅ (1.12) | **MISSING** |
| Tags with nesting | ❌ | ◐ | ✅ | ✅ keywords | ✅ | ❌ | ◐ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | HAS |
| Search inside images/PDFs (OCR) | ❌ | ❌ | ✅ Pro | ❌ | ❌ | ❌ | ◐ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | 🧩 | **MISSING** |
| Journal / daily page front and centre | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ◐ | ✅ | ✅ | ❌ | ❌ | ◐ | ❌ | ✅ | HAS |
| Outliner block moves / zoom | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | 🧩 | PARTIAL |
| Queries over notes | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ DB | ✅ | ✅ Lua | ❌ | ❌ | ❌ | ❌ | ✅ Bases | HAS |
| Citations (Zotero/CSL) | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | 🧩 | ❌ | ❌ | 🧩 | 🧩 |
| Quick capture (widget, share sheet, capture window) | ❌ | ◐ | ✅ | ✅ | ❌ | ❌ | ✅ | ◐ | ❌ | ❌ | ❌ | ✅ signature | ✅ Quick Note | ✅ mobile | PARTIAL (URI + clipper) |
| Share a note by link / real-time collaboration | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ◐ DB | ❌ | ✅ signature | 🧩 Live Share | ❌ | ✅ | ◐ paid Publish | **MISSING** |
| Version history | ❌ | ✅ | ◐ | ✅ | ✅ | ❌ | ✅ | ◐ | ❌ | ✅ | ✅ git | ✅ | ❌ | ✅ | HAS |
| Offline-first | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | ◐ | ❌ | ✅ | ✅ | ✅ | ✅ | **MISSING** (see §3) |
| Custom themes / CSS | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ◐ | ✅ | ✅ | ❌ | ✅ | HAS |

Sources:
- **Typora:** [Focus & Typewriter](https://support.typora.io/Focus-and-Typewriter-Mode/) ("fade out other contents except current line/block"), [Table Editing](https://support.typora.io/Table-Editing/) (Ctrl+Enter adds a row; drag a row or column border to move it), [Quick Start](https://support.typora.io/Quick-Start/) (Pandoc export, Copy as HTML).
- **iA Writer:** [feature list](https://ia.net/writer/support/basics/features) (Focus Mode, Content Blocks, Syntax Highlight, Style Check, Smart MD Tables, Writing Goals, Authorship, DOCX export) and [Syntax Highlight](https://ia.net/writer/support/editor/syntax-highlight) (adjectives, adverbs, weak verbs; Style Check covers "fillers, clichés, and redundancies").
- **Bear:** [Pro OCR search in images/PDFs](https://blog.bear.app/2026/04/bear-beyond-text-working-with-images-pdfs-and-more/) and the [FAQ](https://bear.app/faq/).
- **Ulysses:** [sheets, goals, glue, export styles](https://zapier.com/blog/ulysses-markdown-writing-guide/).
- **Zettlr:** [Zotero + Pandoc workflow](https://augmentedscholars.com/tools/zettlr/).
- **MarkText:** [typewriter/focus/source modes](https://ostechnix.com/marktext-markdown-editor/).
- **Notion:** [`/` menu and Markdown shortcuts](https://www.notion.com/help/keyboard-shortcuts).
- **Logseq:** [journals-first](https://itsfoss.com/logseq-journals-contents/).
- **SilverBullet:** [PWA, slash commands, queries](https://silverbullet.md/Manual).
- **HackMD:** [collaboration and share links](https://hackmd.io/).
- **StackEdit:** [Drive/Dropbox/GitHub sync](https://stackedit.io/).
- **VS Code:** [paste image, link validation, update links on move](https://code.visualstudio.com/docs/languages/markdown) and [markdownlint](https://github.com/DavidAnson/vscode-markdownlint).
- **Drafts:** [capture, then append to other notes with actions](https://www.macstories.net/reviews/drafts-5-mac/).
- **Craft:** [share links, export to PDF/Word/Markdown](https://support.craft.do/en/import-and-export/export/document).
- **Apple Notes:** [Quick Note, tables, OCR search](https://www.macrumors.com/guide/apple-notes/).

**Table stakes in 2026**, meaning at least 3 of the 4 writing-first apps (Typora, iA, Ulysses, Bear) have it, or every web-first app does:
1. focus and typewriter modes;
2. word count with reading time;
3. visual table editing;
4. export to PDF and DOCX, plus copy as rich text;
5. a formatting toolbar or `/` menu;
6. quick capture;
7. offline.

**Differentiators OpenMarkdown can take cheaply:** style check (iA), writing goals (iA, Ulysses), OCR search (Bear, Apple Notes). Real-time collaboration and share-by-link are HackMD's and Notion's whole reason to exist. They need a relay server, so they sit outside a serverless v1 (§3).

---

## 3. What makes people leave (a web) editor

**How this was gathered.**
- Reddit through the Arctic Shift archive, which rate-limited the search, so coverage is partial.
- HN through Algolia; blogs; GitHub issues; vendor docs.
- The sample is small and self-selected: people who leave post more than people who stay. Vendor blogs are flagged.

### 3.1 Why people leave Obsidian (≈22 leaving stories, 2024–2026, one count per reason per source)

| Rank | Reason | Sources | What it means for OpenMarkdown |
|---|---|---|---|
| 1 | Plugin fatigue: setup, upkeep, updates breaking plugins | 10 | **Build the universal daily-writing plugins in (§4)**, so a new vault is useful without 15 installs |
| 2 | Sync: setup friction more than price, plus reliability | 7 | Out of scope here (another track). Never lose data locally (§6 #1) |
| 3= | No collaboration or team sharing | 5 | Needs a relay; deferred. Obsidian lists "Multiplayer" as *Planned* ([roadmap](https://obsidian.md/roadmap/)) |
| 3= | Not WYSIWYG enough: syntax flicker, no toolbar | 5 | Formatting toolbar, table editing (§6 #4, #7) |
| 3= | Mobile: clunky, slow start, no PDF export on Android | 5 | Mobile shell, fast cold start (§5, §6 #6) |
| 6 | No databases, kanban or rich tables | 4 | Bases exists; tables (§6 #7) |
| 7 | Performance with a large vault or many plugins | 3 | Keep the cold-start budget |
| 8 | Learning curve / blank canvas | 2 | Sensible defaults, templates for new notes (§6 #14) |

**Quotes:**
- *"Then plugins became my nightmare… you get more and more maintenance to do as you keep growing your workflow."* ([r/ObsidianMD "Leaving Obsidian", 2024-01-07, 203 pts](https://www.reddit.com/r/ObsidianMD/comments/191193f/))
- *"I left for 2 weeks leave and when I went back I forgot how much of my configuration and plugin worked."* ([r/PKMS, 2024-10-22](https://www.reddit.com/r/PKMS/comments/1g8huw7/_/lt52a8q/))
- *"I needed WYSIWYG style editor… I did not want to see markdown when writing."* ([r/PKMS, 2025-03-17](https://www.reddit.com/r/PKMS/comments/1jdjnyr/))
- *"Some of the features that should have been a part of Obsidian from day one are locked behind third-party plugins."* ([XDA, 2024-12-19](https://www.xda-developers.com/reasons-looking-obsidian-alternatives/))
- *"I'd love to know in what reality markdown tables are better than WYSIWYG tables."* ([r/ObsidianMD, 2024-01-08](https://www.reddit.com/r/ObsidianMD/comments/191193f/_/kgv61b3/))
- *"The first real Obsidian alternative would allow use of existing Obsidian plugins."* ([HN, 2026-05-18](https://news.ycombinator.com/item?id=48181381))

### 3.2 Why people abandon *web* Markdown editors

Ranked by how much evidence was found.

1. **Local data disappears.**
   - Clearing browsing data wiped a StackEdit workspace: *"its IndexedDB…was also wiped out. Completely gone."* ([stackedit#1646](https://github.com/benweet/stackedit/issues/1646)).
   - Safari deletes script-created data after seven days without interaction. MDN: *"If an origin has no user interaction… in the last seven days of browser use, its script-created data will be deleted"*, and OPFS falls under the same rule ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)). Home-screen apps keep a separate counter ([WebKit](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)).
   - SilverBullet's sync mode *"wiped the entire page"* ([silverbullet#1040](https://github.com/silverbulletmd/silverbullet/issues/1040)).
   - **Fix:** OpenMarkdown's real-folder mode avoids this. Browser-storage vaults need the §6 #1 banner and backup prompt.
2. **The browser takes the shortcuts.**
   - Chrome reserves keys like Ctrl+N. Keyboard Lock *"is only available when JavaScript-initiated full screen is active"* ([Chrome docs](https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock)).
   - VS Code's PWA loses Ctrl+W and Ctrl+N ([vscode#150735](https://github.com/microsoft/vscode/issues/150735)).
   - Cmd+L opens the address bar in Safari and Arc ([HN](https://news.ycombinator.com/item?id=40854657)).
   - code-server enables these shortcuts only when it runs as an installed PWA ([code-server#2586](https://github.com/coder/code-server/issues/2586)).
   - **Fix:** detect `display-mode: standalone`, prompt to install, and pick defaults that avoid DevTools, zoom and address-bar keys (§6).
3. **No real files outside Chromium, and re-granting permission every visit** ([forum #2049/252](https://forum.obsidian.md/t/2049/252)).
4. **PWA sync and offline are flaky.** OpenMarkdown's service worker does no app-shell caching today (`apps/web/src/sw.ts`).
5. **Forced sign-up, or notes uploaded to a server.** *"Why do I have to sign up?"* ([HN](https://news.ycombinator.com/item?id=44938471)). OpenMarkdown already avoids this; say so on first run.
6. **No working spellcheck** ([codimd#95](https://github.com/hackmdio/codimd/issues/95)). OpenMarkdown blocks the native spelling menu (§6 #2).
7. **The mobile toolbar disappears behind the keyboard** ([standardnotes/forum#420](https://github.com/standardnotes/forum/issues/420); SiYuan in §5).
8. **Lossy export, and lock-in** ([Notion export quirks, vendor blog](https://mdstill.com/blog/notion-markdown-export-quirks)). Plain `.md` files avoid it.

### 3.3 Must-haves in "best Markdown editor" talk

Crude signal: keyword counts over 1,133 HN comments, 3 roundups, the r/Markdown "#1 thing" thread, and plugin downloads.

| Rank | Must-have | Evidence |
|---|---|---|
| 1 | Sync | Ask HN notes threads 20.6% |
| 2 | Mobile | Ask HN notes threads 18.6% |
| 3 | Real WYSIWYG / live preview | [r/Markdown "NO true WYSIWYG?", 124 comments](https://www.reddit.com/r/Markdown/comments/1v0qd3b/): *"as soon as you start moving around a document a HEADING suddenly becomes a ###HEADING"* |
| 4 | Plain `.md`, offline, no lock-in | |
| 5 | Search | |
| 6 | Collaboration / sharing | |
| 7 | Tables | |
| 8 | AI | |
| 9 | Version history | |
| 10 | PDF/DOCX export | |
| 11 | Image paste | |
| 12 | Vim | |
| 13 | Math | |
| 14 | Diagrams | |
| 15 | Spellcheck | |
| 16 | Focus mode | |

Focus mode and spellcheck rank low in discussion but high in plugin installs (§4). People expect them to exist and do not argue about them.

### 3.4 Quick capture is a latency problem

- *"the actual problem here isn't capture, it's latency. any solution that requires an app to open and index a vault has already lost the race against the thought."* ([top comment, r/ObsidianMD "Quick capture", 2026-08-13](https://www.reddit.com/r/ObsidianMD/comments/1vnjopo/_/p3i7jml/))
- A 5 MB capture window that opens in under 400 ms got 245 pts ([r/ObsidianMD, 2025-12-23](https://www.reddit.com/r/ObsidianMD/comments/1ptxywa/)).
- What people use instead: iOS Shortcuts appending to a file, Drafts, Google Keep as a buffer, Telegram bots.
- **Obsidian is closing this gap on iOS:**
  - iOS Share Sheet (1.13, 2026-07-30);
  - native Quick Capture "without waiting for your vault to load" (1.14 mobile, 2026-09-02);
  - a Home Screen capture widget (1.14.1).
  
  Source: [changelog](https://obsidian.md/changelog/). Android parity is unverified.
- **Consequence:** OpenMarkdown's capture sheet must write without waiting for the index (§6 #5). An install-free, cross-device capture URL is still an advantage.

### 3.5 Collaboration and share-by-link

Demand is real but mid-sized:
- [live collaborative editing](https://forum.obsidian.md/t/6058): 43 votes, 43,842 views;
- Relay 202k downloads (free for up to 3 users, then $5–18/mo, [relay.md](https://relay.md/));
- Share Note 113k downloads.

The top workaround is *"I export mine as pdf and send it that way"* ([r/ObsidianMD, 2026-04-09, 29 pts](https://www.reddit.com/r/ObsidianMD/comments/1sgom74/_/of6m6y9/)). That is why §6 #17 includes PDF export and `navigator.share` now and defers live multiplayer.

---

## 4. Plugin capabilities common enough to build in

The table lists plugins that fill daily-writing gaps, ranked by downloads. It leaves out plugins for browser capabilities (sync, Git, AI, network) and domain niches (TTRPG, Zotero). **Rule for building in:** the capability ships built in and off by default where it changes typing. It keeps the plugin's Markdown output, and does not claim the plugin's command ids, so the plugin still loads and wins when enabled.

| Plugin (rank) | Downloads | Capability | OM today | Build in? |
|---|---|---|---|---|
| Advanced Tables (#5) + Excel to Markdown Table (#115) + Sheets Extended | 3.19M + 203k | Tab auto-format, Enter to next row, sort/move columns, paste spreadsheet cells | PARTIAL (`editor/commands.ts:829-842`: row/col ops, `table-format`; no Enter-down, sort, or TSV paste) | **Yes** |
| Calendar (#7) + Periodic Notes (#36) | 3.10M + 758k | Month calendar of daily notes; weekly/monthly/quarterly/yearly notes | MISSING (daily only) | **Yes** |
| Style Settings (#8) + Minimal Theme Settings (#17) | 2.68M + 1.80M | Theme variables UI from `/* @settings */` comments | plugin loads | No: keep plugin |
| QuickAdd (#12) | 2.11M | Capture text to a note/heading, macros | PARTIAL (URI `append`/`prepend`, `settings/uri.ts:204-264`) | **Capture only** |
| Editing Toolbar (#15) + cMenu (#95) + Note Toolbar (#68) | 1.88M + 239k + 363k | Formatting toolbar | MISSING (desktop and mobile) | **Yes** |
| Outliner (#20) + Zoom (#182) + Dragger (#218) | 1.41M + 112k + 86k | Move item with children, select subtree, zoom into item, drag blocks | PARTIAL (`swap-line-*`, indent, fold) | **Yes** |
| Homepage (#21) | 1.33M | Open a note on startup | HAS (`openBehavior`, `settings/tabs/files-links.ts:79-98`) | Done |
| Recent Files (#23) | 1.19M | Recent files sidebar | PARTIAL (switcher recents only) | **Yes** (small) |
| Tag Wrangler (#24) | 1.09M | Rename/merge tags | MISSING | **Yes** |
| Linter (#25) + Markdown prettifier + Easy Typing (#71) | 1.05M + 57k + 350k | Format document / on save | MISSING | **Yes** (small rule set) |
| Notebook Navigator (#28) | 967k | Apple Notes-style list with previews | MISSING | Later |
| Highlightr (#38) + Colored Text (#89) | 719k + 282k | Coloured highlights | MISSING | **Yes**, using Obsidian 1.14 syntax `==🔴text==` |
| Commander (#39) | 705k | Put any command in ribbon/title bar/menus/status bar | MISSING (ribbon reorder only, `settings/tabs/interface.ts:40-80`) | **Yes** (with toolbar work) |
| Better Word Count (#41) + Novel word count (#119) + Reading Time (#186) + Writing Goals + Keep the Rhythm | 613k + 196k + 111k + 34k + 33k | Selection/folder counts, reading time, goals, daily stats | PARTIAL (`core-plugins/word-count/index.ts:30-95`, CJK-aware) | **Yes** |
| Spaced Repetition (#44) | 597k | Flashcards | plugin | No |
| Various Complements (#46) + Completr + Autocomplete | 592k + 86k + 38k | Word completion from vault/dictionary | MISSING (`editor/suggest.ts` does links/tags only) | **Yes**, off by default |
| Hover Editor (#47) | 588k | Editable page preview | PARTIAL (read-only popover, `core-plugins/page-preview/index.ts:147`) | Later |
| Pandoc (#50) + Enhancing Export (#61) + Better Export PDF (#79) | 553k + 449k + 333k | DOCX/EPUB, PDF with TOC/headers | PARTIAL (print dialog) | **DOCX + PDF options** |
| Natural Language Dates (#53) | 519k | `@today` → date link | PARTIAL (`insert-current-date`, `core-plugins/templates/index.ts:49-60`) | **Yes** |
| Emoji Toolbar (#54) + Emoji Shortcodes (#155) | 496k + 141k | `:smile:` → 😄 | MISSING | **Yes** |
| Paste URL into selection (#55) | 495k | `[text](url)` on paste | HAS (`editor/input.ts:125-135`) | Done |
| Quick Switcher++ (#56) | 472k | Symbols/headings in switcher | — | Later |
| Auto Link Title (#65) | 382k | Fetch page title on URL paste | MISSING | Needs the network bridge; skip |
| Quiet Outline (#77) | 334k | Rendered headings, no auto-expand | PARTIAL (filter + drag exist, `core-plugins/outline/index.ts:137,415`) | Small |
| LanguageTool (#85) + Harper (#176) | 312k + 115k | Grammar | MISSING | **Yes**, Harper in wasm |
| Text Format (#101) + Sort & Permute lines (#259) | 228k + 69k | Case transforms, sort lines | MISSING | **Yes** (small) |
| Find orphaned files (#103) + Clear Unused Images (#149) + File Cleaner Redux | 226k + 153k + 96k | Unused attachments | MISSING | **Yes** |
| Table of Contents (#104) + Automatic TOC (#144) + Number Headings (#199) + Heading Shifter | 225k + 159k + 95k + 41k | TOC insert, heading shift/numbering | MISSING | **Yes** |
| Custom File Explorer sorting (#112) + File Order | 207k + 51k | Manual order | MISSING | **Yes** |
| Remember cursor position (#125) | 184k | Per-note cursor/scroll | PARTIAL | **Yes** |
| Smart Typography (#131) | 169k | Curly quotes, dashes, ellipsis | MISSING | **Yes**, off by default |
| Paste image rename (#143) + Custom Attachment Location (#188) | 160k + 109k | Name pattern, per-note folder | PARTIAL (fixed `Pasted image …`, `obsidian/markdown/editor-host.ts:167`) | **Yes** |
| Rollover Daily Todos (#150) | 149k | Carry unchecked tasks into today | MISSING | **Yes** (option in Daily notes) |
| Footnote Shortcut (#156) | 141k | Insert or jump to footnote | PARTIAL (`editor:insert-footnote`) | Small |
| Typewriter Scroll (#177) + Typewriter Mode (#191) + Focus Mode (#237) + ProZen + Stille + Fullscreen | 114k + 104k + 73k + 37k + 32k + 46k (≈406k) | Typewriter, dimming, zen | MISSING | **Yes** |
| Share Note (#181) + QuickShare + Relay (#116) | 113k + 31k + 202k | Share by link, multiplayer | MISSING | Needs a server; out of v1 |
| Tab Switcher (#210) + Open Tab Settings (#290) + Mononote (#443) | 88k + 60k + 33k | MRU Ctrl+Tab, new tab by default, one tab per note | PARTIAL | **Yes** |
| Global Search and Replace (#265) | 67k | Vault replace | MISSING | **Yes** |
| Trash Explorer (#271) | 65k | Restore from `.trash` | MISSING | **Yes** (small) |
| Image Captions (#279) | 63k | Alt text as caption | MISSING | Small |
| Copy as HTML + Copy document as HTML | 53k + 41k | Rich copy | MISSING | **Yes** |
| Text Snippets | 50k | Text expansion | MISSING | Later (Templater covers it) |

**Grouped sums by capability** (total downloads of the plugins in each group):
- toolbar family: 2.5M
- word counting and goals: 0.99M
- tables: 3.4M
- outliner: 1.6M
- typewriter/focus: 0.41M
- export: 1.3M

**Kept as plugins** because they are ecosystems in their own right: Excalidraw, Templater, Dataview, Tasks, Kanban, Style Settings, Spaced Repetition, Zotero.

---

## 5. Mobile and PWA: capture on phones and tablets

What Obsidian mobile ships is listed in [obsidian-features.md §11](obsidian-features.md). What a PWA can actually do, per `mdn/browser-compat-data`:

| Capability | Chromium desktop | Chrome Android | Safari iOS/iPadOS | Firefox | OM today |
|---|---|---|---|---|---|
| Manifest `shortcuts` (long-press icon: New note, Capture, Today) | 96+ | 84+ | ❌ (macOS Dock 17.4+) | ❌ | MISSING |
| `share_target` (appear in the OS share sheet) | 89+ | 76+ | ❌ | ❌ | MISSING |
| `file_handlers` (open `.md` from Files/Explorer) | 102+ | ❌ | ❌ | ❌ | PARTIAL: declared in `apps/web/public/manifest.webmanifest`, `launchQueue` unhandled |
| `protocol_handlers` (`web+openmd://`) | 96+ | ❌ | ❌ | ❌ | MISSING |
| VirtualKeyboard API (`overlaysContent`, `geometrychange`) | 94+ | 94+ | ❌: use `visualViewport` resize | ❌ | MISSING |
| Persistent storage `navigator.storage.persist()` | ✅ | ✅ | 17+ ([WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)) | ✅ | HAS (`boot.ts:92`) |
| Offline app shell (service-worker precache) | ✅ | ✅ | ✅ | ✅ | **MISSING**: `apps/web/src/sw.ts` only serves vault files |

**Safari eviction.** Safari's 7-day cap deletes script-writable storage (IndexedDB, OPFS) for sites not used for 7 days, but "home screen web applications are exempt" ([WebKit](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)). For iOS users the install prompt is a data-safety feature, not decoration.

**Keyboard handling.** On iOS a `position: fixed; bottom: 0` toolbar ends up under the keyboard. SiYuan hit exactly this ([siyuan#13743](https://github.com/siyuan-note/siyuan/issues/13743)), and BlockNote solved it with VirtualKeyboard plus CSS variables ([BlockNote#2616](https://github.com/TypeCellOS/BlockNote/discussions/2616)).

A PWA used for daily capture must:
1. **Open straight into a writable note in under 1 s from cold**, offline. Precache the shell and wasm; restore the last note from IndexedDB before the vault index finishes.
2. **Keyboard toolbar**: a horizontally scrollable bar pinned above the keyboard, positioned with `visualViewport` on iOS and `navigator.virtualKeyboard` on Chromium. It reads Obsidian's `mobileToolbarCommands` list so vaults round-trip. Defaults as in Obsidian §11, plus **Camera** (`<input type=file accept=image/* capture>`; the [Android camera thread](https://forum.obsidian.md/t/30351) has 58 votes).
3. **Bottom navigation bar**: Back, Forward, **+** (new note), Capture, Tabs, Menu. Swipe from the edges for sidebars. Pull down to run a configurable command (Obsidian's `mobilePullAction`). Touch targets ≥ 44 px.
4. **Capture entry points**:
   - manifest `shortcuts`: `?action=capture`, `?action=new`, `?action=daily`;
   - `share_target` (Android and desktop Chromium), mapping `title`/`text`/`url`/files into the capture sheet;
   - on iOS, a documented Apple Shortcuts recipe that opens `https://<app>/?action=capture&text=…`. iOS has no share target, so this is the only path.
5. **Hide the keyboard toolbar when a hardware keyboard is attached** (iPad). Detect with `visualViewport` height and a `keydown` heuristic ([forum #27114](https://forum.obsidian.md/t/27114)).
6. **Split right/down on tablets**, and stacked single-pane layout on phones (49 votes, [#45865](https://forum.obsidian.md/t/45865)).

---

## 6. What to build: 25 features, in priority order

Each entry gives the user-facing spec, the status today, and the evidence behind it. Hotkeys were checked against the defaults OpenMarkdown already registers (`editor/commands.ts`, `settings/commands.ts`) and against Chromium's DevTools and zoom keys. Where a plugin owns the obvious key, no default is set. Settings persist in `.obsidian/app.json`, or in `.obsidian/<core-plugin-id>.json` for plugin-scoped options, so desktop Obsidian ignores them harmlessly.

### P0: people leave without these

**1. Never lose a word** · MISSING / PARTIAL
- **Offline shell:** the service worker precaches the app shell, wasm and fonts, so the app opens offline. Today `sw.ts` serves vault files only.
- **Unsaved-changes guard:** while a write is pending, `beforeunload` asks before closing.
- **Status bar save state:** shows "Saved", "Saving…" or "Not saved — retry".
- **Storage warning:** in browser-storage vaults, if `navigator.storage.persisted()` is false, a banner reads "This browser may delete this vault. Install the app or export a backup" and offers **Install** / **Export vault (.zip)**.
- **Browser-reserved shortcuts:** Mod+N/T/W are taken by the browser in a normal tab. On first run in a tab, a notice explains that installing the app frees these shortcuts.
- **Evidence:** §3 and §5.

**2. Spelling and grammar that work in a browser** · PARTIAL
- **The problem:** the editor's custom context menu always calls `preventDefault` (`obsidian/markdown/editor-host.ts:203-227`, `editor/input.ts:163-169`). Browser spelling suggestions and "Add to dictionary" appear only in the native menu, so they cannot be reached.
- **Setting `Editor → Spelling suggestions on right-click`** (`nativeSpellMenu`, default **on**). When the click lands on plain text with no selection, and not on a link, tag or embed, let the native menu open. **Shift+right-click** always opens the native menu.
- **Command "Check grammar and style"** (`editor:toggle-grammar`, no default hotkey) toggles Harper ([Apache-2.0, runs in wasm, "milliseconds to lint a document", offline](https://github.com/Automattic/harper)). It is English only, setting `grammarCheck` off by default.
  - Underlines use class `cm-lint-grammar`.
  - A popover shows the suggestions plus **Ignore** and **Add to vault dictionary**.
  - The vault dictionary lives in `.obsidian/dictionary.txt`, one word per line, and is synced with the vault. This answers the [user-dictionary sync](https://forum.obsidian.md/t/29796) request.
- **Style check (iA-style)**, setting `styleCheck`: flags fillers, redundancies and repeated words from an editable list in `.obsidian/style-check.txt`.

**3. Focus mode and typewriter scrolling** · MISSING
- **"Toggle focus mode"** (`editor:toggle-focus-mode`, **Mod+Shift+Enter**, free today) hides the ribbon, sidebars, tab bar and status bar. Esc exits.
- **"Toggle typewriter scrolling"** (`editor:toggle-typewriter`, no hotkey) keeps the caret line at `typewriterOffset` (default 50% of the viewport).
- **Setting `focusDim`**: Off / Paragraph / Sentence / Line, default Paragraph when focus mode is on. Dimmed text gets class `.cm-dimmed` with opacity from `--focus-dim-opacity: .35`, so themes can style it.
- **Evidence:** ≈406k downloads across 6 plugins; built into Typora, iA Writer, Ulysses, MarkText and Zettlr.

**4. Keyboard toolbar (mobile) and formatting toolbar (desktop)** · MISSING
- **Mobile:** the keyboard toolbar from §5 item 2, configured under **Settings → Toolbar**, read and written as `mobileToolbarCommands`.
- **Desktop: setting `formattingToolbar`**, with three values:
  - Off (default);
  - On selection: a floating bar with Bold, Italic, Strikethrough, Highlight ▸ colours, Code, Link, Heading ▸, List ▸, Callout ▸;
  - Fixed: the bar sits under the tab header.
- **"Add command to…"** (Commander-style): in the Hotkeys tab, each command's ⋯ menu gets entries for Ribbon, Title bar, Toolbar, Editor menu and File menu. The choices are stored in `.obsidian/app.json` `commandPlacements`.
- **Editor context menu:** add the Obsidian **Format ▸ / Paragraph ▸ / Insert ▸** submenus, which it lacks today (`editor-host.ts:203-227`).
- **Evidence:** 2.5M toolbar-plugin downloads; [desktop toolbar thread](https://forum.obsidian.md/t/49950).

**5. Quick capture** · PARTIAL
- **"Quick capture"** (`capture:open`, **Mod+Alt+N**; Mod+Shift+I/C open DevTools in Chromium) opens a sheet with a text box, a **Destination** field and a template picker.
  - Destinations: Daily note (append under heading `captureHeading`, default none = end of file), Inbox note (`captureInboxPath`, default `Inbox.md`), New note in folder.
  - Output: `- HH:mm text` when setting `captureTimestamp` is on (the default).
  - Enter saves and closes; Mod+Enter saves and keeps the sheet open.
- **Routes:** URL `?action=capture&text=&dest=daily|inbox|new`, manifest `shortcuts`, `share_target`, and handling of `launchQueue` for `.md` files.
- **Latency rule:** the sheet opens and saves before the vault index is built. It appends through the adapter; the index catches up afterwards. The budget is under 1 s from a cold start (§3.4).
- **Evidence:** QuickAdd 2.11M; Drafts' and Apple Quick Note's signature feature.

**6. Mobile shell** · MISSING
- Bottom navigation bar, edge-swipe sidebars, pull-down action (`mobilePullAction`), iPad hardware-keyboard detection, and split right/down on tablets. Details in §5 items 3, 5 and 6.
- Everything is gated on `Platform.isMobile` (`obsidian/util.ts:262-278`).

**7. Tables that behave like Advanced Tables** · PARTIAL
- **Keys in a table:** Enter moves to the same column in the next row, adding a row at the end. Mod+Enter inserts a line break `<br>` in the cell.
- **Setting `tableAutoFormat`** (default on): pads and aligns columns on Tab/Enter, leaving untouched any table where the cursor never went.
- **New commands:** `editor:table-sort-asc` / `-desc` ("Table: Sort by column A→Z / Z→A", matching Obsidian's names), and `editor:table-paste-as-table` ("Paste TSV/CSV as table"), which also runs automatically when clipboard text contains tabs on ≥2 lines.
- **Checkboxes in cells:** `[ ]` and `[x]` render as clickable checkboxes in Live Preview and Reading view, output stays literal. This is the [178-vote request](https://forum.obsidian.md/t/554).
- **Evidence:** Advanced Tables 3.19M + Excel to Markdown Table 203k.

**8. Vault-wide search & replace** · MISSING
- **"Replace in all files"** (`global-search:replace`, **Mod+Shift+H**) adds a Replace field to the Search view that uses the current query, including regex and `$1` groups.
  - Each match shows a before/after preview with a checkbox.
  - **Replace selected** or **Replace all (N files)**.
  - Before writing, it takes a File recovery snapshot of every affected file (`core-plugins/file-recovery/store.ts`), then shows a notice with **Undo**.
- **Evidence:** 267 votes; Global Search and Replace 67k.

**9. Tag and property wrangling** · PARTIAL
- **Tags view context menu:** **Rename tag…** (merges when the target already exists; nested children are renamed too: `#a/b` → `#c/b`), **Delete tag from all notes…**, **Open search for tag**.
- **What gets rewritten:** inline `#tag` and frontmatter `tags:`. Code blocks are skipped. A snapshot is taken first.
- **Properties view:** add **Add property to notes in folder…** and **Set value in all notes…**. Rename and delete already exist.
- **Evidence:** 290 + 210 votes; Tag Wrangler 1.09M, Multi Properties 115k.

**10. Note titles from frontmatter or H1** · MISSING
- **Setting `Files & links → Display title`:** File name (default) / `title` property / First heading, then file name.
- **Where it applies:** tab headers, inline title (read-only when not the file name, with a pencil icon for **Rename file to match**), file explorer, quick switcher, link suggestions, graph labels and backlinks.
- **Link suggestions insert** `[[file-name|Display title]]`.
- **Evidence:** #1 forum request (386 votes); Front Matter Title 73k.

### P1: what makes it feel like a writer's tool

**11. Writing stats and goals** · PARTIAL
- **Status bar:** words · characters · **reading time** (setting `readingWpm`, default 238) · **today +N words**.
- **Per-note goal:** property `word-goal: 1500` shows a progress ring in the status bar and a bar under the inline title.
- **Setting `dailyWordGoal`** (0 = off).
- **Command "Show writing stats"** (`word-count:stats`) shows a 12-week heatmap of words added per day, stored in `.obsidian/word-count.json`.
- **Counting:** still done by the CJK-aware Rust counter (`crates/vault-ofm/src/wordcount.rs:84`).

**12. Outliner operations** · PARTIAL
- **Move with children:** "Move list item and children up/down" (`editor:move-list-item-up|down`, **Mod+Shift+↑/↓**). Outside a list the same keys move the section under the current heading ([move by heading, 35 votes](https://forum.obsidian.md/t/4202)).
- **Selection:** "Select list item subtree" (`editor:select-list-item`) and **Mod+A** cycling: item → subtree → document.
- **Zoom:** "Zoom into list item or heading" (`editor:zoom-in`, **Mod+.**) and "Zoom out" (`editor:zoom-out`, **Mod+Shift+.**). They hide everything else via CM6 decorations, with a breadcrumb.
- **Drag:** a handle appears on hover left of a bullet or paragraph (setting `blockDragHandles`, default off).
- **Collision with plugins:** when the Outliner or Zoom plugin is enabled, the built-in commands leave their hotkeys to the plugin.
- **Evidence:** 1.6M downloads across the group.

**13. Tabs that behave** · PARTIAL
- **Setting `openLinksInNewTab`** (default off): clicking a link opens a new tab.
- **Setting `switchToOpenTab`** (default on): if the note is already open in the tab group, focus that tab.
- **Setting `tabCycleOrder`**: Tab-bar order / Most recently used. Applies to Ctrl+Tab.
- **Per-note memory:** cursor, scroll and fold state for the last 500 notes are kept in IndexedDB, surviving close and reopen.
- **Evidence:** 289 + 239 + 93 votes.

**14. Templates for new notes** · MISSING
- **Setting `Templates → Template for new notes`**, applied by Mod+N, clicking an unresolved link, and the quick switcher's create.
- **"Folder templates"** list: folder → template, most specific wins.
- **Evidence:** 202 votes.

**15. Inline suggestions: dates, emoji, callouts, words** · PARTIAL
- **Dates:** typing `@` suggests today, tomorrow, yesterday, next Monday, in 3 days, and so on. It inserts `[[2026-09-14]]` using the daily-note format, or plain text with Shift+Enter (Natural Language Dates behaviour).
- **Emoji:** `:smi` suggests 😄. Setting `emojiShortcodes`, default on.
- **Callouts:** `> [!` suggests every callout type, including CSS-defined custom types. `editor:insert-callout` opens the same picker instead of always inserting `note`.
- **Footnotes:** `[^` suggests existing footnote labels.
- **Words:** setting `wordCompletion`, default **off**. After 3 letters it suggests words from the vault's index; Tab accepts.

**16. Calendar and periodic notes** · MISSING
- **Calendar** right-sidebar view (`calendar:open`): a dot marks days with daily notes, click opens or creates the note, week numbers are optional.
- **Periodic notes:** Weekly / Monthly / Quarterly / Yearly, each with format, folder and template. Settings are compatible with the Periodic Notes plugin's `data.json` keys. Commands "Open this week's note" and so on.
- **Rollover:** setting `Daily notes → Carry over unchecked tasks`, off by default.
- **Evidence:** Calendar 3.10M, Periodic Notes 758k, Rollover 149k.

**17. Export and share** · PARTIAL
- **"Export to PDF…"** gets options: page size, margins, **Include file name as title**, **Headers/footers** (title, page numbers via `@page` margin boxes), **Table of contents**.
- **"Export to Word (.docx)"** (`publish:export-docx`): headings, lists, tables, images and footnotes, written in wasm (`crates/vault-publish`).
- **"Copy as rich text"** (`editor:copy-as-html`, no default hotkey: Cmd+Opt+C is Chrome's element inspector on macOS) writes `text/html` and `text/plain` to the clipboard, with embeds resolved.
- **"Share…"** (`workspace:share`) calls `navigator.share` with the `.md` file, or with a PDF when "as PDF" is chosen. It is hidden where unsupported.
- **Evidence:** PDF TOC 60 votes, mobile PDF 100 votes; export plugins 1.3M.

**18. Attachment hygiene** · PARTIAL
- **Setting `attachmentNamePattern`**, default `Pasted image {{date:YYYYMMDDHHmmss}}`. Variables `{{notename}}`, `{{date:…}}`, `{{n}}`. `attachmentFolderPath` gains `./{{notename}}`.
- **Setting `renameOnPaste`**, default off: ask for a name after pasting.
- **"Find unused attachments"** (`file-explorer:unused-attachments`): lists files with no backlinks and moves the selected ones to `.trash`.
- **Images:** drag-to-resize writes `|W` (Obsidian 1.12 behaviour). Setting `imageCaptions` renders alt text as `<figcaption>`.
- **Evidence:** 99 + 86 votes; roughly 700k downloads across the group.

**19. File explorer manual order, Recent files, Trash** · MISSING
- **Sort order "Manual"**: drag to reorder. Stored in `.obsidian/file-explorer.json` `manualOrder`, so no files are renamed.
- **"Recent files"** left-sidebar view (`recent-files:open`).
- **"Show trash"** (`workspace:show-trash`): a view of `.trash` with Restore / Delete permanently.
- **Evidence:** 250 + 114 votes; Recent Files 1.19M.

**20. Format document (Linter-lite)** · MISSING
- **"Format document"** (`editor:format-document`, no default hotkey: Cmd+Opt+L opens Chrome's Downloads on macOS, and Linter sets none). It runs on the whole file or on the selection.
- **Rules**, each toggleable in **Settings → Editor → Formatting**:
  - trim trailing spaces;
  - one blank line around headings, lists, code and tables;
  - consistent list marker (`-`);
  - ordered-list renumbering;
  - align tables;
  - heading levels increment by one;
  - `tags` and `aliases` as YAML lists;
  - final newline.
- **Setting `formatOnSave`**, default off.
- Implemented in Rust (`crates/vault-ofm`) so the CLI gets `vault fmt`.

### P2: polish with measurable demand

**21. Smart typography and text transforms** · MISSING
- **Setting `smartTypography`**, default off: `"`→“”, `'`→‘’, `--`→—, `...`→…. Skipped in code, math, frontmatter and links. Backspace right after a replacement undoes it.
- **Commands:** "Transform to uppercase / lowercase / Title Case" (`editor:transform-*`), "Sort lines" (`editor:sort-lines`), "Increase / Decrease heading level" (`editor:heading-increase|decrease`, no default hotkey: Mod+Shift+=/- is browser zoom).
- **"Insert table of contents"** outputs a nested list of `[[#Heading]]` links (Markdown links under the Markdown-link setting), wrapped in `%% toc %%` … `%% /toc %%` so re-running updates it in place.

**22. Coloured highlights** · MISSING
- Uses Obsidian 1.14's syntax `==🔴text==` (🔴 🟠 🟢 🔵 🟣): `==` suggests colours, and the toolbar has a colour submenu.
- Renders as `<mark data-color="red">`.
- Plain `==text==` stays default yellow.
- **Evidence:** Highlightr 719k + Colored Text 282k.

**23. Accent-insensitive matching** · MISSING
- **Setting `Search → Ignore accents`**, default on. Folds diacritics (NFD, strip combining marks) in the quick switcher, link suggestions, in-file find and global search, in `crates/vault-index/src/util.rs`.
- **Evidence:** 158 votes.

**24. Rename heading and block links** · MISSING
- **"Rename this heading…"** (`editor:rename-heading`, in the context menu on a heading) and **"Rename this block ID…"** rewrite every `[[note#Heading]]` and `#^id` link across the vault. This extends `rename_edits` in `crates/vault-index/src/rename.rs` to subpaths.
- **Setting `updateHeadingLinks`**, default Ask / Always / Never. When on, links are also updated when a heading line is edited and the cursor leaves it.
- **Evidence:** 136 votes; Obsidian itself has "Rename this heading…".

**25. Editable hover preview** · PARTIAL
- **Setting `Page preview → Editable popovers`**, default off: the popover hosts a full embeddable editor (`obsidian/markdown/embeddable-editor.ts`), pinnable and resizable.
- The same component later enables in-place editing of embeds (forum #5, 279 votes).
- **Evidence:** Hover Editor 588k.

**Deliberately left out of the 25:**
- **Real-time collaboration and share-by-link:** they need a relay. Revisit with an optional self-hostable Yjs relay.
- **OCR search:** a large wasm model; revisit with an on-device model.
- **Citations:** Zotero plugins work.
- **Nested YAML properties:** wait for Obsidian's format.
- **Link types:** a file-format change.
- **Definition lists:** would diverge from Obsidian rendering. Add only behind a setting.
