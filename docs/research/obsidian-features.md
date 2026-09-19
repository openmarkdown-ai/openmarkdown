# Obsidian feature inventory (for an open-source, browser-first clone)

Research date: 2026-09-13. Target of the inventory: Obsidian **1.13.7 public** (desktop, released 2026-08-12), with notes on **1.14.0/1.14.1 early access** (2026-09-02/08) where they add features.

## 0. Sources and confidence

| Source | What it gave | Confidence |
|---|---|---|
| `obsidianmd/obsidian-help` repo, `en/` (176 pages, master branch, fetched 2026-09-13) | User-facing behaviour, syntax, Bases, CLI, URI, Publish, Sync, Importer, mobile | High — official |
| Obsidian 1.13.7 app bundle (`obsidian-1.13.7.asar`, already installed on the research Mac): `i18n.js` (2,666 English UI strings), `app.js` (command registry, default hotkeys, default config object, Bases function registry, filter operator table, search operator table, URI handlers), `app.css` (callout types) | Exact command names/IDs, default hotkeys, every setting label, default values, full formula function list | High — read from the shipped code, but minified; anything inferred from code is marked "(code)" |
| `obsidian.md/changelog.xml` (488 entries, to 2026-09-08) | Features added 2024–2026 and their versions | High |
| JSON Canvas spec 1.0 (`obsidianmd/jsoncanvas/spec/1.0.md`, 2024-03-11) | `.canvas` file format | High |

Conventions below: `Mod` = Ctrl on Windows/Linux, Cmd on macOS. "Default: on/off" is the shipped default. Where docs and code disagree, both are given and flagged **AMBIGUOUS**.

---

## 1. Obsidian Flavored Markdown (OFM)

Obsidian parses **CommonMark + GitHub Flavored Markdown + LaTeX math + Obsidian extensions**. Markdown is **not** rendered inside HTML blocks (design decision).

### 1.1 Base CommonMark/GFM elements

| Element | Syntax | Implementation notes |
|---|---|---|
| Paragraph | Text separated by a blank line | Multiple spaces/newlines collapse in Reading view and Publish; use `&nbsp;` or `<br>` to force |
| Soft line break | Single `Enter` | Governed by **Strict line breaks** (§1.15) |
| Hard line break | Two+ trailing spaces then newline, or `Shift+Enter` in editor | Always `<br>` |
| Headings | `#` … `######` + space | Levels 1–6 feed Outline, heading links, folding. Setext headings (`===`/`---` underlines) are CommonMark and parsed (**AMBIGUOUS** — not mentioned in docs) |
| Bold | `**text**` or `__text__` | Formatting commands recognise both (since 1.5.8) |
| Italic | `*text*` or `_text_` | |
| Bold+italic | `***text***` or `___text___`; nesting `**bold _italic_**` | |
| Strikethrough | `~~text~~` (GFM); HTML `<s>` also works | |
| Inline code | `` `code` ``; double backticks to include a backtick | |
| Fenced code block | ≥3 backticks or ≥3 tildes; info string = language | Outer fence must be longer, or use the other fence char, to nest |
| Indented code block | 4 spaces or a tab | |
| Blockquote | `> text` | Enter continues the quote (fixed 1.8.4) |
| Unordered list | `-`, `*`, `+` | |
| Ordered list | `1.` or `1)` | Auto-renumbering preserves custom start numbers (1.8.9); disabled when Smart lists is off. `Shift+Enter` inserts a break without renumbering |
| Nested lists | Indent with Tab (or spaces) | `Tab` / `Shift+Tab` indent/unindent |
| Horizontal rule | `***`, `---`, `___` (3+), spaces allowed between (`- - -`) | `- - -` renders as HR in Live Preview (1.8.9). In Slides, `---` on its own line separates slides |
| Links (external) | `[text](https://url)`; spaces must be `%20` or wrap destination in angle brackets `[t](<a b.md>)` | |
| Autolinks | Bare URLs are linkified (GFM autolink) | |
| Reference links | `[text][ref]` + `[ref]: url` | Live Preview renders them (1.8.0); no space allowed before the definition (1.11) |
| Images (external) | `![alt](https://…)` | Size via alt: `![alt\|640x480](url)`, `![alt\|100](url)` (width only keeps ratio). Since 1.13, `![200](url)` (size with no alt) also works in Reading mode |
| Tables | GFM pipe tables; header separator needs ≥2 hyphens per column; outer pipes optional; alignment `:--`, `:--:`, `--:` | Escape the pipe inside cells with a backslash — required for aliased links and sized image embeds inside tables. Live Preview right-click adds/deletes/moves/sorts/aligns rows & columns |
| Escaping | Backslash before `*`, `_`, `#`, backtick, pipe, `~`; before `.` in `1\.` to prevent a list | Live Preview only escapes special chars, not letters/numbers (1.7.2) |
| HTML | Inline and block HTML, sanitized (see §1.10) | |

### 1.2 Obsidian extensions (complete)

| Syntax | Meaning |
|---|---|
| `[[Note]]`, `[[Note.md]]` | Internal link (wikilink) |
| `[[Folder/Note]]` | Link with vault-root path (forward slashes even on Windows) |
| `[[Note\|Display text]]` | Link with display text |
| `[[Note#Heading]]` | Link to heading |
| `[[Note#Heading#Subheading]]` | Link to nested subheading (multiple `#`) |
| `[[#Heading]]` | Heading in the same note |
| `[[Note#^block-id]]` | Link to block |
| `[[#^block-id]]` | Block in the same note |
| `[[## query]]` | Editor-only suggester trick: search headings across the whole vault |
| `[[^^query]]` | Editor-only suggester trick: search blocks across the whole vault |
| `[text](Note.md)`, `[text](Folder/My%20Note.md#Heading)` | Markdown-format internal link (URL-encoded destination) |
| `![[File]]` | Embed (transclusion) — see §1.4 |
| `^block-id` | Block identifier (Latin letters, digits, dash only) |
| `#tag`, `#nested/tag` | Tag |
| `==text==` | Highlight |
| `%%text%%` / multi-line `%%` … `%%` | Comment (hidden in Reading view / Publish; exactly two `%` — `%%%%` is not a comment opener since 1.13) |
| `[^1]`, `[^name]` + `[^1]: text` | Footnote (named footnotes still render as numbers; continuation lines indented 2 spaces). Footnote IDs are case-insensitive (1.8.0) |
| `^[inline footnote]` | Inline footnote (caret outside brackets). **Reading view only**, not Live Preview (per docs) |
| `> [!type]`, `> [!type]+`, `> [!type]-`, `> [!type] Title` | Callouts |
| `- [ ]`, `- [x]`, `- [?]` (any char) | Task list with custom status characters |
| `$inline$`, `$$ block $$` | Math |
| Fenced code block with language `mermaid` | Mermaid diagram |
| Fenced code block with language `query` | Embedded search results |
| Fenced code block with language `base` | Embedded Base (inline `.base` YAML) |
| Frontmatter `---` YAML `---` (also JSON between `---`) | Properties |
| `==🔴text==` (1.14 EA) | **Colored highlight**: a color emoji 🔴 🟠 🟢 🔵 🟣 at the start of a highlight sets its color; typing `==` suggests colors; formatting submenu color picker; Live Preview shows an inline swatch when the cursor overlaps |

### 1.3 Internal links — resolution and editor behaviour

- Two formats: wikilink (default) and Markdown link. Setting **Use [[Wikilinks]]** (default on; config `useMarkdownLinks:false`). With wikilinks off, typing `[[` still autocompletes but inserts a Markdown link.
- **New link format** (config `newLinkFormat`, default `shortest`): *Shortest path when possible* / *Path from current file* (`relative`) / *Path from vault folder* (`absolute`).
- Links to non-`.md` files must include the extension (`[[Figure 1.png]]`). `.md` extension optional.
- Link to a non-existent note is allowed (unresolved link, styled differently); clicking creates it. If the link includes a folder path, the note is created in that folder (ignores "Default location for new notes").
- Characters that break links: `#`, `|`, `^`, `:`, `%%`, `[[`, `]]` — Obsidian warns on unsafe characters in filenames (1.11: only a warning). Invalid filename characters are stripped on import (1.11).
- Resolution: link text resolves by basename anywhere in the vault, preferring the closest/shortest unique match (code: `metadataCache.getFirstLinkpathDest(linkpath, sourcePath)`).
- **Creating links in the editor**: type `[[` (suggester of files, aliases shown with curved-arrow icon, unresolved link targets; footer hints "Type # to link heading", "Type ^ to link blocks", "Type | to change display text"); select text then type `[[` to wrap it; command **Add internal link**; command **Insert Markdown link** (`Mod+K`).
- Selecting an alias in the suggester inserts `[[Real name|Alias]]` (not `[[Alias]]`) for interoperability.
- Pasting a URL while text is selected creates `[selected](url)` (1.11; multi-cursor aware 1.12.5).
- Excluded files are deprioritised in link suggestions. Autocomplete switches to a simpler algorithm above 10,000 items.
- **Rename propagation**: on file rename/move, links are updated automatically (setting **Automatically update internal links**; when off, a dialog: *Always update / Just once / Do not update*, with "This will affect N links in M files"). Heading rename ("Rename this heading...") and block ID rename ("Rename this block ID...") also update links. Canvas embeds update too.
- **Opening links with modifiers**: click = current tab; `Mod`+click = new tab (in Source mode add Shift); `Mod+Alt`+click = new tab group (split right); `Mod+Alt+Shift`+click = new window. Middle-click = new tab.
- **Follow link under cursor** `Alt+Enter`; open in new tab `Mod+Enter`; to the right `Mod+Alt+Enter`; new window `Mod+Alt+Shift+Enter`.
- Link context menu (editor): Open link, Open in new tab, Open to the right, Open in new window, Edit link, Copy URL, Copy path / Copy relative path (1.9), Create this file (unresolved), Bookmark.

### 1.4 Embeds (`![[...]]`)

| Target | Syntax | Behaviour |
|---|---|---|
| Whole note | `![[Note]]` | Rendered inline, live-updating; frontmatter hidden in embeds (1.7) |
| Heading section | `![[Note#Heading]]` | Section until the next heading of same/higher level |
| Block | `![[Note#^id]]` | Single block (paragraph, list item, list, quote, callout, table) |
| List | Put `^id` on its own line after the list (blank line before and after) then `![[Note#^id]]` | |
| Image | `![[img.png]]`, `![[img.png\|100]]` (width), `![[img.png\|100x145]]` (w×h) | Formats: avif, bmp, gif, jpeg, jpg, png, svg, webp. Live Preview: drag corner to resize (1.12), double-click corner resets; 1.13: images selectable by keyboard, `+`/`-` resize, `0` reset, Enter edit, Tab edit size, Space/click opens **image lightbox** (full-screen viewer, arrow keys through all images in note, click-drag pan, shows filename). Context menu: Copy image, Reset size, Remove image, Delete image |
| Audio | `![[rec.ogg]]` | flac, m4a, mp3, ogg, wav, webm, 3gp → `<audio>` player |
| Video | `![[clip.mp4]]` | mkv, mov, mp4, ogv, webm → `<video>` |
| PDF | `![[doc.pdf]]`, `![[doc.pdf#page=3]]`, `![[doc.pdf#height=400]]` | Embedded PDF.js viewer |
| Canvas | `![[board.canvas]]` | Renders shapes only (no card text) |
| Base | `![[file.base]]`, `![[file.base#View name]]` | First view unless a view name is given |
| External image/video/tweet | `![](https://…jpg)`, `![](https://www.youtube.com/watch?v=…)`, `![](https://twitter.com/…/status/…)` or x.com | YouTube and Twitter/X become embeds |
| Web page | `<iframe src="…"></iframe>` | Sanitized iframe |
| Search results | Fenced `query` code block | See §3.21 |

Embed rules: an embed of a missing file shows "Cannot find: …"; missing section shows "Unable to find “subpath” in file". Non-renderable files show an "Open in default app" affordance. Embedded Markdown has an edit button in Live Preview. Export to PDF fully exports embedded Bases (1.11).

### 1.5 Block identifiers

- Paragraph: append ` ^id` at the end of the line.
- Structured blocks (lists, quotes, callouts, tables): `^id` on its own line with a blank line before and after.
- List item: `^id` at the end of that item (can be on a continuation line).
- Allowed chars: Latin letters, digits, `-` ("Block ID can only contain alphanumeric characters or dash"). Picking a block in the `[[Note#^` suggester auto-generates a 6-char random ID (e.g. `^37066d`) and **writes it into the target file**.
- Links into parts of quotes/callouts/tables are **not supported**.

### 1.6 Tags

- Inline `#tag` or frontmatter `tags:` list (YAML list only since 1.9; `tag:` singular removed).
- Allowed characters: letters (Unicode), digits, `_`, `-`, `/` (nesting), and "commonly accepted Unicode characters including emoji". No spaces. Must contain at least one non-digit (`#1984` invalid, `#y1984` valid).
- Case-insensitive; Tags view displays the casing first encountered.
- Nested: `#inbox/to-read`. Search `tag:inbox` matches `#inbox` and `#inbox/…`; Bases `hasTag("a")` matches `#a` and `#a/b`. Search `tag:#work` does **not** match `#myjob/work` (prefix-anchored).
- Tags are not recognised inside code, inside text properties, or in non-Markdown content. Spellcheck is disabled for inline tags (1.7.1).
- Clicking a tag opens Search with `tag:#tag`. Tag suggester on `#`; `Tab` completes by path segment (1.5).
- Tag context menu: Edit tag (editor), Search tag.

### 1.7 Callouts

```md
> [!type] Optional title
> Body, supports **Markdown**, [[links]], ![[embeds]]
```

- Type identifier is **case-insensitive**; unknown types fall back to `note` styling (keeping their `data-callout` attribute so CSS can style them).
- Title defaults to the type in Title Case. Title-only callouts allowed (no body).
- Foldable: `[!type]+` expanded by default, `[!type]-` collapsed.
- Nesting: `> > [!todo]` etc., any depth.
- DOM: `.callout[data-callout="type"]` with `.callout-title`, `.callout-icon`, `.callout-content`; CSS vars `--callout-color` (since 1.13 any CSS color; previously an `r,g,b` triplet — breaking change), `--callout-icon` (Lucide id or inline SVG), `--callout-border-width`, `--callout-border-opacity`, `--callout-blend-mode`, `--callout-content-padding`, `--callout-content-background`.
- Command **Insert callout** (wraps selection; default `[!note]`, cursor placed in the type). Live Preview: right-click callout → change type (menu: Info, Important, Tip, Success, Question, Warning, Quote, Example, None, Other… free text), or remove callout formatting (1.8).

Built-in types (from `app.css`, 1.13.7):

| Type | Aliases | Color token | Lucide icon |
|---|---|---|---|
| `note` (default) | — | `--color-blue` | `pencil` |
| `abstract` | `summary`, `tldr` | cyan | `clipboard-list` |
| `info` | — | blue | `info` |
| `todo` | — | blue | `check-circle-2` |
| `tip` | `hint` | cyan | `flame` |
| `important` | docs list it as an alias of tip; CSS gives it its own selector with the same icon | cyan | `flame` |
| `success` | `check`, `done` | green | `check` |
| `question` | `help`, `faq` | orange | `help-circle` |
| `warning` | `caution`, `attention` | orange | `alert-triangle` |
| `failure` | `fail`, `missing` | red | `x` |
| `danger` | `error` | red | `zap` |
| `bug` | — | red | `bug` |
| `example` | — | purple | `list` |
| `quote` | `cite` | `#9e9e9e` grey | `quote-glyph` |

### 1.8 Math

- MathJax + LaTeX in 1.13.7; **1.14 EA replaces MathJax with Temml** for Live Preview and Reading mode (each `$$` line gets `.HyperMD-math`).
- Inline `$e^{i\pi}$`; block `$$ … $$` (multi-line).
- Commands: Insert math block; mobile toolbar Toggle inline math / Toggle math block.

### 1.9 Diagrams (Mermaid)

- ```` ```mermaid ```` code blocks, Mermaid 11.13.0 (1.13).
- Setting **Show Mermaid diagrams in notes** (Editor). Since 1.13, a one-time per-vault banner "Display Mermaid diagrams in this vault? Only allow if you trust this vault's contents." — off until allowed; renders immediately after allowing (1.13.1).
- Internal links inside diagrams: add class `internal-link` to nodes (`class A,B internal-link;`); node text becomes the link target; quote names with special characters. These links do not appear in Graph view.
- CSS var `--font-mermaid`.

### 1.10 HTML

- Sanitized (no `<script>`, event handlers, etc.). Common uses: `<u>`, `<s>`, `<span style>`, `<div class>`, `<iframe>`, `<br>`, `<!-- -->` HTML comments, `<details>`.
- No Markdown inside HTML elements. HTML blocks must not contain blank lines. Inline tags like `<span>` may *look* like they render Markdown but the Markdown is outside the HTML context.
- 1.13: warning before loading HTML resources pointing at a network drive.

### 1.11 Task lists and statuses

- `- [ ]` incomplete, `- [x]` complete. **Any single character** inside the brackets is allowed and treated as "checked" (e.g. `[?]`, `[-]`, `[/]`, `[>]`). Core does not style custom statuses (themes do, via the `data-task` attribute).
- Ordered checklists `1. [ ]` supported.
- Toggle by clicking the checkbox in Reading view and Live Preview.
- Commands: **Toggle checkbox status** (`Mod+L`), **Cycle bullet/checkbox**, **Toggle bullet list**, **Toggle numbered list**.
- Search: `task:`, `task-todo:` (space status), `task-done:` (any non-space status). CLI `tasks status="?"`.

### 1.12 Code blocks and highlighting

- Reading view uses **Prism.js** (all Prism languages). Source mode / Live Preview use CodeMirror 6 language modes, so highlighting may differ.
- Copy button on code blocks (Reading view/Live Preview).
- Languages with core renderers: `mermaid`, `query`, `base`; plugins register more (`registerMarkdownCodeBlockProcessor`).

### 1.13 Frontmatter / properties syntax

See §2. YAML between `---` lines at the very top (no blank lines before it, since 1.4.10). A JSON object between `---` is accepted and re-saved as YAML. YAML aliasing is disabled when Obsidian writes (1.9).

### 1.14 Comments

`%%inline%%` and block `%%` … `%%`. Visible only in editing views. **Toggle comment** `Mod+/`. HTML comments `<!-- -->` also hidden.

### 1.15 Line breaks and "Strict line breaks"

- Config `strictLineBreaks` default **false** → single newlines render as `<br>` in Reading view (non-CommonMark).
- On → CommonMark: single newline = space; 2 trailing spaces = `<br>`; blank line = new `<p>`.
- **AMBIGUOUS**: the Basic formatting syntax help page says a single Enter is "a continuation of the same paragraph" by default, but the setting description ("Markdown specs ignore single line breaks in reading view. Turn this off to make single line breaks visible") and the shipped default (`false`) mean single newlines *are* visible by default. Implement the code behaviour.
- Also a Publish site option; strict line breaks now render properly in the first paragraph of a callout (1.9).

### 1.16 External and special links

- `[text](https://…)`, `mailto:`, `file:///` (dragging a file from the OS with `Ctrl`/`Option` creates an absolute `file:///` link instead of importing), `obsidian://open?vault=…&file=…`.
- Opening non-http schemes shows "Open external link? … Always open scheme:// links" (1.12). Executable files prompt "Run executable file?" (1.12). Remote-file warning; network-drive access prompt (1.13).

### 1.17 Headings / folding

- **Fold heading** (`foldHeading`, default on) and **Fold indent** (`foldIndent`, default on): hover the gutter arrow; folded sections always show the arrow. Fold state persisted per file (and between reading/editing modes, 1.8.9). Navigating into a fold opens it (1.5.8).
- Commands: Toggle fold on the current line, Fold all headings and lists, Unfold all headings and lists, Fold more, Fold less, Toggle fold properties in current file.

### 1.18 Supported file formats (vault)

`.md`, `.base`, `.canvas`, images (avif bmp gif jpeg jpg png svg webp), audio (flac m4a mp3 ogg wav webm 3gp), video (mkv mov mp4 ogv webm), `.pdf`. Setting **Show all file types** (`showUnsupportedFiles`, default off) lists any extension in File explorer and Quick switcher (opened in default app). Markdown files > 2 MB are not indexed (1.6.0).

### 1.19 PDF viewer (built-in, PDF.js)

Toolbar/features (from i18n): find (Highlight all, Match diacritics, Whole words; F3 / Shift+F3, macOS Cmd+G / Cmd+Shift+G), sidebar with Thumbnails and Table of contents (Reveal page in TOC), previous/next page, page number "of N", zoom, Fit width / Fit height, spreads (Single page, Two-page odd, Two-page even), **Adapt to theme** (dark-mode inversion), **Save current position in document**, password-protected PDF prompt. Selection context: **Copy as quote**, **Copy link to selection** (creates `[[doc.pdf#page=3&selection=…|…]]`), Copy link to annotation, Copy annotation, Copy link to section/page.

---

## 2. Properties

### 2.1 Storage format

```yaml
---
title: A New Hope          # text
link: "[[Episode IV]]"      # internal links in properties MUST be quoted
url: https://example.com
cast:                       # list
  - Mark Hamill
  - "[[Harrison Ford]]"
year: 1977                  # number (literal only, no expressions)
favorite: true              # checkbox
last:                       # empty → indeterminate checkbox (sorted with false)
date: 2020-08-21            # date
time: 2020-08-21T10:30:00   # date & time (seconds included since 1.4.10)
tags: [journal, personal]   # tags (list)
aliases: [Doggo, Woofer]
cssclasses: [wide]
---
```

- Property names unique per note; order irrelevant. Nested objects not editable in the UI (view in Source). Markdown not rendered in properties (by design), **but** Markdown links `[t](url)` and `[[wikilinks]]` inside text/list properties are rendered and **tracked/updated on rename** (1.11). Hashtags inside text properties are not tags.
- JSON frontmatter accepted, saved back as YAML. ISO 8601 with timezone offsets parsed (1.10).

### 2.2 Property types

| UI name | Internal (types.json) | Notes |
|---|---|---|
| Text | `text` | Single line |
| List | `multitext` | One value per `- ` line; duplicates allowed (1.10); individual values copyable (1.8); double-click an item to edit (1.6) |
| Number | `number` | Integer or decimal; "Invalid number" validation |
| Checkbox | `checkbox` | true / false / empty = indeterminate |
| Date | `date` | Date picker in OS locale format; stored `YYYY-MM-DD`. With Daily notes enabled, a date value links to that day's daily note |
| Date & time | `datetime` | Stored `YYYY-MM-DDTHH:mm:ss` |
| Tags | `tags` | Only for the `tags` property; tag suggester; "Invalid tag name" validation |
| Aliases | `aliases` | Only for `aliases` |
| Unknown | — | Shown when no type is assigned and the value can't be inferred |

(`file`, `folder`, `property` widget types exist in code for settings/plugins, not user-facing.)

- A type is assigned **per property name, vault-wide**, stored in `.obsidian/types.json` as `{"types": {"name": "text", …}}` (code: config key `types`; reloaded when edited externally since 1.6). Unassigned types are **inferred** ("Automatic (type)", clarified 1.13). Changing to an incompatible type prompts "Display as {type}? Your {oldType} data is not compatible. It will be adapted to fit the new format." Mismatches show "Type mismatch, expected …".
- Default types cannot be unassigned for `tags`, `aliases`, `cssclasses`.

### 2.3 Default / reserved property names

| Property | Type | Purpose |
|---|---|---|
| `tags` | tags (list) | Tags |
| `aliases` | aliases (list) | Alternate names; link suggester, Quick switcher, unlinked mentions; Publish uses full-path aliases as redirects |
| `cssclasses` | list | CSS classes added to the note's view container |
| `publish` | checkbox | Publish auto-select (true) / exclude (false) |
| `permalink` | text | Publish URL slug |
| `description` | text | Publish meta description / OG / Twitter |
| `image`, `cover` | text | Publish OG image (vault path, case-sensitive, or URL) |
| Deprecated, removed 1.9: `tag`, `alias`, `cssclass` | | Format converter migrates them |

### 2.4 Property editor UI ("Properties in document")

- Setting **Properties in document**: Visible (default) / Hidden / Source (raw YAML).
- Add: command **Add file property** `Mod+;`, tab "More options" → Add file property, type `---` at the top of a file, right-click the Properties heading. Also **Add alias** and **Clear file properties** commands.
- Row = type icon (click to change type) + name (suggester of existing names) + value (type-specific widget; link suggester when typing `[[`).
- Heading "Properties" is foldable. Invalid YAML shows "Syntax error. Your frontmatter is invalid." with the error location highlighted. Available inside page preview and Canvas cards (1.9).
- Templates: inserting a template merges its properties into the note.
- Keyboard (property focused): Down/Tab next, Up/Shift+Tab previous, Alt+Down jump to editor; Shift+Up/Down extend selection; Mod+A select all; Left edit name, Right edit value; Escape focus row; Mod+Backspace delete property (or selection); Mod+Z / Mod+Shift+Z undo/redo. Vim: `j`/`k` move, `h` key, `l` value, `A` value cursor at end, `i` value cursor at start, `o` new property.
- Context menu on a property: cut/copy/paste, property type, delete; on list links: edit/remove.

### 2.5 Properties view (core plugin) — see §3.17

### 2.6 Not supported (by design, per docs)

Nested property editing; bulk editing (except rename/merge/delete across the vault in All properties view); Markdown formatting in property values.


---

## 3. Core plugins (every setting and command)

### 3.0 Registry

Internal IDs and default state (from `app.js`, 1.13.7). Core plugin toggles live in Settings → Core plugins (search filter; per-plugin gear = settings, plus-circle = hotkeys). State stored in `.obsidian/core-plugins.json`.

| Plugin (UI name) | Internal ID | Default | Description string |
|---|---|---|---|
| Audio recorder | `audio-recorder` | off | Record audio notes and save them as attachments |
| Backlinks | `backlink` | on | Show links from other files to the current file… |
| Bases | `bases` | on | Create custom views that let you edit, sort, and filter files using their properties |
| Bookmarks | `bookmarks` | on (not verifiable from minified code; on in fresh vaults) | Save shortcuts to files, searches, headings, and graphs |
| Canvas | `canvas` | on | Arrange and connect notes on an infinite canvas |
| Command palette | `command-palette` | on | Use Cmd/Ctrl+P and begin typing to invoke a command |
| Daily notes | `daily-notes` | on | Create or open today's daily note |
| Editor status ("Show editing mode in status bar") | `editor-status` | on | Show the editing mode toggle in the status bar |
| File explorer ("Files") | `file-explorer` | on | Browse the files and folders in your vault |
| File recovery | `file-recovery` | on | Restore recent snapshots… (Markdown/canvas only) |
| Footnotes view | `footnotes` | off | Show a list of footnotes from the current note (1.9) |
| Format converter | `markdown-importer` | off | Convert Markdown from other apps to Obsidian format |
| Graph view | `graph` | on | Visualize the relationships between your notes |
| Note composer | `note-composer` | on | Merge two notes or split one into two |
| Open in default app | `open-with-default-app` | not listed in Settings → Core plugins in recent builds; behaves as always-on (**AMBIGUOUS**) | Button/commands to open current file in its default app / reveal in Finder/Explorer |
| Outgoing links | `outgoing-link` | on | Show outgoing links and detect unlinked mentions |
| Outline | `outline` | on | Show the table of contents for the current note |
| Page preview | `page-preview` | on | Hover an internal link to preview its content |
| Properties view | `properties` | on (since 1.10) | Show the metadata for your files in the sidebar |
| Publish | `publish` | off | Paid service |
| Quick switcher | `switcher` | on | Jump to other files with your keyboard |
| Random note | `random-note` | off | Open a random note |
| Search | `global-search` | on | Search for a keyword in all the notes |
| Slash commands | `slash-command` | off | Trigger commands in the editor by using the forward slash key |
| Slides | `slides` | off | Create a presentation by using "---" to separate slides |
| Sync | `sync` | off | Paid service |
| Tags view | `tag-pane` | on | Show a list of all tags and their number of occurrences |
| Templates | `templates` | on | Insert template content from a folder of template files |
| Unique note creator | `zk-prefixer` | off | Create notes with unique timestamp prefixes (zettelkasten) |
| Web viewer | `webviewer` | off | Open external links to web pages inside Obsidian (desktop only, 1.8) |
| Word count | `word-count` | on | Show word count in the status bar |
| Workspaces | `workspaces` | off | Save and load workspace layouts |
| (Translucent window) | `translucency` | setting | Now an Appearance setting, not a plugin |
| (Custom CSS) | `custom-css` | always | Themes + CSS snippets machinery |

Officially maintained **community** plugins: **Importer** (`obsidian-importer`), **Maps** (`maps`, adds Bases Map layout).

### 3.1 Audio recorder

- Ribbon: **Start/stop recording** (mic icon changes color while recording). Commands: **Start recording audio** (`audio-recorder:start`), **Stop recording audio** (`audio-recorder:stop`).
- Saves `Recording YYYYMMDDHHmmss.<ext>` (code: name confirmed; extension comes from the platform MediaRecorder mime type, typically `.webm` on desktop, `.m4a` on iOS — **AMBIGUOUS**) to the default attachment location and embeds `![[…]]` at the **end** of the active note (docs) — file remains if embed removed.
- Errors: "Microphone access was denied…", "Please grant microphone permission…", "No microphone is connected."
- No settings.

### 3.2 Backlinks

- Right sidebar tab. Two collapsible sections: **Linked mentions** (files containing a link to active note) and **Unlinked mentions** (plain-text occurrences of the note name **or any alias**; each has a **Link** button to convert to `[[Note]]` / `[[Note|alias]]`).
- Toolbar options: **Collapse results**, **Show more context**, **Change sort order** (File name A→Z/Z→A, Modified new→old/old→new, Created new→old/old→new), **Show search filter** (search syntax filter).
- Commands: **Show backlinks** (`backlink:open`), **Open backlinks for the current note** (`backlink:open-backlinks` → linked backlinks tab next to note, with link icon), **Toggle backlinks in document** (`backlink:toggle-backlinks-in-document` → panel at bottom of note; state saved per file since 1.8).
- Setting: **Show backlinks at the bottom of notes** — "Make backlinks visible in new tabs by default."
- Status bar item "N backlinks" (clickable).
- Excluded files never appear in Unlinked mentions. Canvas files contribute backlinks since 1.12. Text-only canvas cards don't.

### 3.3 Bases — full detail in §4

Commands: **Create new base** (`bases:new-file`, in active file's folder), **Insert new base** (`bases:insert`, creates and embeds), **Copy table to clipboard** (`bases:copy-table`), **Switch view...** (`bases:change-view`), **Add view** (`bases:add-view`), **Add item** (`bases:add-item`). Ribbon: **Create new base**. File explorer context: **New base**.

### 3.4 Bookmarks (formerly Starred, internal `starred`/`bookmarks`)

- Bookmarkable item types: **file, folder, graph (global only, with its settings), search (query), heading, block, URL/link**. Stored in `.obsidian/bookmarks.json` (items with `type`, `title`, `path`, `subpath`, `query`, `url`, nested `group` with `items`).
- View (left sidebar): tree with groups, drag to reorder / move into groups, expand/collapse, filter/search box (1.13), keyboard navigation, cut/copy/paste of items, Cmd-Backspace delete. Clicking a URL bookmark opens external browser unless Web viewer is set to open external links.
- Top actions: **Bookmark the active tab...** (bookmark-plus), **New group** (folder-plus), **Collapse all**.
- **Add bookmark / Edit bookmark** dialog: Title (optional), Bookmark group; for search: Query; for file: Path.
- Commands: **Show bookmarks** (`bookmarks:open`), **Bookmark...** (`bookmarks:bookmark-current-view`), **Bookmark current search...** (`bookmarks:bookmark-current-search`), **Remove bookmark for the current file** (`bookmarks:unbookmark-current-view`), **Bookmark block under cursor...** (`bookmarks:bookmark-current-section`), **Bookmark heading under cursor...** (`bookmarks:bookmark-current-heading`), **Bookmark all tabs...** (`bookmarks:bookmark-all-tabs`).
- Other entry points: file explorer context **Bookmark** (multi-select supported), heading context **Bookmark this heading...**, search results "…" menu **Bookmark**, graph tab context **Bookmark this graph...**, tab-group menu **Bookmark N tabs...**, web viewer "…" **Bookmark page**, drag files onto Bookmarks view.
- Remove: context **Remove** (items or groups with contents), or Edit dialog.

### 3.5 Canvas — full detail in §5

Commands: **Create new canvas** (`canvas:new-file`), **Export as image** (`canvas:export-as-image`), **Jump to group** (`canvas:jump-to-group`), **Convert to file...** (`canvas:convert-to-file`). Ribbon **Create new canvas**. File explorer **New canvas**.

Settings: **Default location for new canvas files** (Vault folder / Same folder as current file / In the folder specified below) + **Folder to create new canvas files in**; **Default mouse wheel behavior** (Pan / Zoom; default Pan); **Default Mod+Drag behavior** (Show menu / Add card / Add note from vault / Add media from vault / Add web page / Create group; default Show menu); **Show card names** (Always / On hover / Never); **Snap to grid** (toggle); **Snap to objects** (toggle); **Zoom threshold for hiding card content** (slider −0.7…2.4, default 0).

### 3.6 Command palette

- `Mod+P` (`command-palette:open`), ribbon terminal icon. Fuzzy matching ("scf" → Save current file). Shows hotkeys next to commands. Recently used commands on top (1.8.3); results alphabetical by default with recency boost (1.9). Instructions: ↑↓ navigate, ↵ use, esc dismiss. Ctrl-N/Ctrl-P navigate on all platforms (1.13).
- Settings: **Pinned commands** (list with reorder via drag / Alt-Up/Down, remove X) + **Add a command...** — pinned commands appear at top.

### 3.7 Daily notes

- Commands: **Open today's daily note** (`daily-notes`), **Open previous daily note** (`daily-notes:goto-prev`), **Open next daily note** (`daily-notes:goto-next`). Ribbon calendar icon. Mobile/Android/iOS widgets and URI `daily`.
- Settings: **Date format** dropdown with predefined formats (1.11): `YYYY-MM-DD` (default), `YYYY.MM.DD`, `YYYY/MM/DD`, `YYYY/MM/YYYY-MM-DD`, **Custom** → **Custom format** (Moment.js tokens, live preview "Your current syntax looks like this: …"; slashes create subfolders, e.g. `YYYY/MMMM/YYYY-MMM-DD`); **New file location** (folder); **Template file location** (file). "Open daily note on startup" was moved to Files & links → **Default file to open → Daily note** (1.11).
- Behaviour: opens if exists, else creates from template (template variables processed: `{{date}}`, `{{time}}`, `{{title}}`, `{{date:FORMAT}}`). Previous/next navigate by parsing existing filenames in the folder with the format.
- With Daily notes enabled, date-type property values render as links to that day's note.
- Errors: invalid format, folder not found, template not found, "There's no daily note before/after this one."
- Other: "Today's daily note" / "Insert link into daily note" (mobile share actions).

### 3.8 File explorer ("Files")

- Header buttons: **New note** (in default new-note location), **New folder**, **Change sort order** (File name A→Z, Z→A; Modified time new→old, old→new; Created time new→old, old→new), **Auto-reveal current file**, **Expand all / Collapse all**.
- File context menu (typical, 1.13): Open in new tab, Open to the right, Open in new window, Rename..., Move file to..., Make a copy / Duplicate (macOS), Bookmark, Merge entire file with... (Note composer), Copy path ▸ (from vault folder / from system root / as Obsidian URL) (1.11), Open in default app, Reveal in Finder / Show in system explorer, Open version history (Sync), Publish/Unpublish, Delete. Folder context: New note, New folder, New canvas, New base, Search in folder, Set as attachment folder ("Attachments will be saved to …"), Rename, Move folder to..., Bookmark, Delete. Empty-space context menu: New note, New folder, New canvas, New base (1.9). Multi-selection: Move N items to..., New folder with selection (N items) (1.8), Bookmark, Delete.
- Selection: `Alt`/`Option`+click toggles, `Shift`+click range; Escape clears (1.13). Keyboard: arrows move focus, Mod+arrows opens file under cursor (1.9), Enter opens (Win/Linux) / renames (macOS), F2 renames, Mod+Down opens (macOS). Copy/paste files with Mod+C / Mod+V (1.12).
- Drag and drop: files/folders into folders (move; auto-expand collapsed folder on hover, 1.8); into editor (insert link); onto tab header (open there); onto Bookmarks; from OS (import copy into that folder; whole folder structure since 1.13); drag links from a Base into explorer to move file (1.13).
- Rename validation: invalid chars ("File name cannot contain any of these characters: …" — `* " \ / < > : | ?` on Windows, `\ / :` elsewhere), unsafe-for-links chars warning (`# ^ [ ] |`), name exists, empty name, cannot start with dot.
- Tooltips: "Last modified at …", "Created at …". New files named `Untitled`, `Untitled 1`, …
- Commands: **Show file explorer** (`file-explorer:open`), **Reveal current file in navigation** (`file-explorer:reveal-active-file`), **Create new note** (`file-explorer:new-file`, `Mod+N`), **Create new note in current tab** (`file-explorer:new-file-in-current-tab`), **Create note to the right** (`file-explorer:new-file-in-new-pane`, `Mod+Shift+N`), **Create new folder** (`file-explorer:new-folder`), **Move current file to another folder** (`file-explorer:move-file`; suggester with Tab path completion), **Make a copy of the current file / Duplicate current file** (`file-explorer:duplicate-file`).

### 3.9 File recovery

- Snapshots of `.md` and `.canvas` files saved to global app data (IndexedDB/system folder, **not** the vault; device-local, not synced).
- Settings: **Snapshot interval** (minimum minutes between snapshots, default **5**), **History length** (days kept, default **7**), **Snapshots → View** (modal: file suggester on left, snapshot list with timestamps, preview, **Show changes** diff toggle, **Copy**, **Restore**; keyboard navigation 1.13), **Clear history → Clear** (confirm).
- Command: **Open local history** (`file-recovery:open`).
- Limitations: unavailable in Apple Lockdown Mode; tied to absolute path of vault.

### 3.10 Footnotes view

- Sidebar tab listing all footnotes in the active note; click to edit text inline; navigate to position. Command **Show footnotes** (`footnotes:open`). Empty state "No footnotes found."
- Related editor features: **Insert footnote** command (creates `[^n]` and definition), hovering a footnote reference shows its content (1.6), clicking a missing footnote's hover creates it (1.7), context menu **Delete footnote and reference** (1.7.1), link suggester offers "New footnote...".

### 3.11 Format converter

- Command/ribbon **Open format converter** (`markdown-importer:open`). Converts **entire vault** (warning + backup advice).
- Options (toggles): **Roam Research tag fixer** (`#tag`, `#[[tag]]` → `[[tag]]`), **Roam Research highlight fixer** (`^^x^^` → `==x==`), **Roam Research TODO converter** (`{{[[TODO]]}}` → `[ ]`), **Bear highlight fixer** (`::x::` → `==x==`), **Zettelkasten link fixer** (`[[UID]]` → `[[UID File Name]]`), **Zettelkasten link beautifier** (`[[UID]]` → `[[UID File Name|File Name]]`), **Frontmatter migration** (tag/alias/cssclass → tags/aliases/cssclasses lists, splitting comma strings; 1.9.3).
- Run UI: Start conversion / Stop; progress "Processed files, Modified files, Total replacements, Failed".

### 3.12 Graph view

- Open: ribbon **Open graph view**, command (`graph:open`, `Mod+G`), **Open local graph** (`graph:open-local`), **Start graph timelapse animation** (`graph:animate`). Local graph is a linked view of the active note ("Graph of {note}").
- Rendering: nodes = notes (size grows with number of incoming links), edges = links; optional tag nodes, attachment nodes, unresolved (non-existent) nodes. Hover highlights neighbours; click opens (modifiers respected, 1.10); right-click = file menu; drag nodes; scroll/`+`/`-` zoom; drag/arrow keys pan; Shift speeds keyboard movement. Canvas links count since 1.12. Mermaid internal-links excluded. Excluded files hidden. Renderer: PIXI.js (bundled `pixi.min.js`) with force simulation in a worker.
- Settings panel (cog; "Restore default settings" button; sections collapsible):
  - **Filters**: Search files (full search syntax); (local only) **Depth** slider (default 1; "Show nodes this number of links away"), **Incoming links** (default on), **Outgoing links** (default on), **Neighbor links** (default off, "Show links between neighbors"); **Tags** (default off); **Attachments** (default off); **Existing files only** (default off = show unresolved); **Orphans** (default on).
  - **Groups**: **New group** → query + color swatch (click to change color, drag to reorder; first matching group wins); delete group.
  - **Display**: **Arrows** (show direction when zoomed in; default off), **Text fade threshold** (−3…3 step 0.1), **Node size** (0.1…5), **Link thickness** (0.1…5), **Animate** button (time-lapse ordered by file creation time).
  - **Forces**: **Center force** (0…1, default 0.1), **Repel force** (0…20, default 10), **Link force** (0…1, default 1), **Link distance** (30…500, default 250).
- Extra: **Copy screenshot** (graph menu), bookmark graph (saves options). Settings stored in `.obsidian/graph.json`; local graph options per view.

### 3.13 Note composer

- **Merge**: command **Merge current file with another file...** (`note-composer:merge-file`), file menu **Merge entire file with...**. Suggester instructions: ↵ merge (append to end), Shift+↵ merge at top, Mod+↵ create new. Confirmation "Are you sure you want to merge X into Y? X will be deleted." (setting). Updates all links to point at destination; merges frontmatter.
- **Extract**: command **Extract current selection...** (`note-composer:split-file`), editor context **Extract current selection...**; **Extract this heading...** (`note-composer:extract-heading`, from heading context menu). Same ↵ / Shift+↵ / Mod+↵ semantics ("to move to bottom/top", "create new"). Links inside the extracted section are rewritten relative to new location (1.13).
- Settings: **Confirm file merge** (toggle), **Text after extraction** (Link to new file / Embed new file / None), **Template file location** — variables `{{content}}` (if absent, content appended after template), `{{fromTitle}}`, `{{newTitle}}`, `{{date:FORMAT}}`.

### 3.14 Outgoing links

- Sidebar tab: **Links** (all links in the active note, resolved + unresolved with "Not created yet"), **Unlinked mentions** (text in the active note matching other notes' names or aliases; button with the note name creates the link; hover shows full path). Right-click links shows file menu (1.8.7).
- Commands: **Show outgoing links** (`outgoing-links:open`), **Open outgoing links for the current file** (`outgoing-links:open-for-current`).
- Links inside code blocks can be created from unlinked mentions but don't list under Links.

### 3.15 Outline

- Sidebar tab listing headings as a collapsible tree (fold state preserved while editing, 1.9). Click to navigate; **drag headings to rearrange sections** in the note; filter box; **Auto-scroll to current section** toggle (highlights current section). Handles footnotes correctly (1.9).
- Commands: **Show outline** (`outline:open`), **Open outline of the current file** (`outline:open-for-current`, linked view).

### 3.16 Page preview

- Hover an internal link → popover with rendered content (editable in place since 1.7; nested popovers; button to open preview in a tab, 1.9; Esc closes). Footnote refs preview footnote. Unresolved: "“x” is not created yet. Click to create."
- Settings (per source): toggle **Require Mod to trigger page preview on hover** for each of: **Editing view** (default requires Mod), **Reading view**, **Search, Backlinks, and Outgoing links**, **Tab header**, plus entries registered by other core/community plugins (file explorer, graph, canvas, bookmarks, etc.).

### 3.17 Properties view

The **Properties view** plugin adds two sidebar views:
- **All properties** (`properties:open`, "Show all properties"): list of every property name with type icon and usage count; sort by Property name A→Z/Z→A or Frequency high→low/low→high (sort persisted); filter box; click → opens Search with `[property]`; right-click → **Rename** (renames across vault; if target name exists, "Merge property X with Y?"), **Property type** submenu, **Delete** (removes from all notes, 1.10); keyboard nav, Backspace deletes selection (1.13); collapse/expand all.
- **File properties** (`properties:open-local`, "Show file properties"): property editor for the active file in the sidebar (useful when Properties in document = Hidden). Linked view "File properties for {note}". Shows "Invalid properties" when YAML is broken.
- Command **Open daily note** from a date property (code: `actionOpenDailyNote`).

### 3.18 Publish (core plugin UI — service in §10)

- Ribbon **Publish changes** (send icon). Commands: **Publish changes...** (`publish:view-changes`), **Publish current file** (`publish:publish-file`), **Open in live site** (`publish:open-in-live-site`).
- Publish changes dialog: tabs/filters **NEW**, **CHANGED**, **DELETED**, **UNCHANGED**; checkboxes per file; **Add linked**; **Manage publish filters** (Included folders / Excluded folders); **Change site options** (cog); **Switch site**; right-click/long-press a change → **Use live version** (overwrite local); Publish button with progress. Deletions never pre-selected.
- File menu: Publish / Unpublish / Open in live site.

### 3.19 Quick switcher

- `Mod+O` (`switcher:open`), ribbon **Open quick switcher**; mobile: centre "+" in nav bar. Placeholder "Find or create a note...".
- Matches file names **and aliases** (fuzzy; improved with spaces 1.12). Empty query lists recent files (toggle between two notes: open, ↓, ↵). `Tab` completes path segment (1.6). Excluded files deprioritised. Simpler algorithm above 10k items. Results draggable (1.12).
- Keys: ↵ open; Mod+↵ open in new tab; Mod+Alt+↵ open to the right; Shift+↵ create note with the exact typed name even if matches exist; ↵ on no match creates note ("Enter to create"). Unresolved link targets are shown ("Not created yet, select to create").
- Settings: **Show existing only** (hide unresolved link targets), **Show attachments**, **Show all file types** (open non-native files in default app).

### 3.20 Random note

- Ribbon dice icon / command **Open random note** (`random-note`). CLI `random folder=… newtab`. No settings in 1.13.7 (**AMBIGUOUS** — older versions had "Open in new tab" option).

### 3.21 Search

- Left sidebar (`global-search:open` "Search in all files", `Mod+Shift+F`). If text is selected when opened via hotkey, searches the selection. Empty query shows **History** (recent searches, clear history). Search suggestions popup lists operators with descriptions ("match path of the file", "match file name", "search for tags", "search keywords on same line", "search keywords under same heading", "match property") plus Properties and Tags groups.
- Searches contents of notes (**and canvases**) plus, by default, paths/filenames of notes and canvases. Stops after 100,000 results (1.9). Excluded files never appear.

**Query language** (from code operator table `DP` + docs):

| Syntax | Semantics |
|---|---|
| `word1 word2` | AND (each word matched independently, anywhere in file) |
| `"exact phrase"` | Exact phrase; `\"` escapes a quote inside |
| `a OR b` | OR (uppercase keyword) |
| `-term`, `-(a b)` | Negation |
| `( … )` | Grouping/priority, e.g. `meeting (work OR meetup) personal` |
| `/regex/` | JavaScript regular expression; combinable with operators (`path:/\d{4}/`) |
| `file:` | Match file **name** (any file type in vault), e.g. `file:.jpg`, `file:202209` |
| `path:` | Match full file path (any file type), e.g. `path:"Daily notes/2022-07"` |
| `content:` | Match file content only |
| `match-case:` | Case-sensitive sub-query |
| `ignore-case:` | Case-insensitive sub-query |
| `tag:` | Tag match using metadata cache (ignores code blocks; faster than text search); `tag:#work` / `tag:work`; parent tag matches children; must be followed by plain text |
| `line:( … )` | All terms on the same line; `-line:x` = no line matches |
| `block:( … )` | Same Markdown block (slow: parses every file) |
| `section:( … )` | Same section (text between two headings) |
| `task:` | Within a task item (block-by-block) |
| `task-todo:` | Within an uncompleted task (`[ ]`) |
| `task-done:` | Within a completed task (any non-space status) |
| `[property]` | File has property |
| `[property:value]` | Property value matches; value supports sub-queries (`OR`, parens, quotes, regex): `[status:Draft OR Published]` |
| `[property:null]` | Property exists but empty (`key:`), not `""`/`[]` |
| `[prop:>5]`, `[prop:<5]` | Numeric comparison (must be inside `[]` or quotes) |
| `[prop:TRUE]`, `[prop:FALSE]`, `[prop:EMPTY]` | Boolean / empty (1.5) |

Operators are "exclusive" (cannot nest another content operator) except `section:` (allowSelf). Nested sub-queries in parens: `task:(call OR email)`.

- UI controls: **Match case** toggle (Aa icon), **Search settings** (sliders icon) → **Explain search terms** (plain-language breakdown: "Match all of:", "Match any of:", "Excluding:", "Matches regex:", etc.), **Collapse results**, **Show more context**; sort dropdown (File name A→Z [default], Z→A, Modified new→old, old→new, Created new→old, old→new); result count "N results"; "…" menu: **Copy search results** (dialog options: **Show path**, **Link style** None/Wikilink/Markdown link, **List prefix** None/Dash/Asterisk/Numbered), **Bookmark**; clear search button.
- Results: file groups with matched snippets (highlighted), "... and N more matches", click to jump to match, drag results out, hover preview.
- Editor context: **Search for "{selection}"**; folder context **Search in folder** (`path:"folder"`). Tag click → `tag:#x`. Property click in All properties → `[prop]`.
- **In-file search** (separate from plugin, editor): **Search current file** `Mod+F` (`editor:open-search`), **Search & replace in current file** `Mod+H` / `Mod+Alt+F` (`editor:open-search-replace`): Find..., Replace..., Previous (Shift+F3), Next (F3 / Mod+G), Find all, Replace, Replace all, match case/regex toggles (**AMBIGUOUS** regex toggle not in i18n), Exit search. CodeMirror: `Mod+D` select next occurrence, `Mod+Shift+L` select all occurrences, `Mod+Alt+G` go to line (code keymaps).
- **Embedded query**: ```` ```query\n<search term>\n``` ```` renders a live search-results panel with header showing the query; newlines inside the block are joined with spaces (code: `query.replace(/\r?\n/g," ")`); the containing note's own query blocks are blanked out to avoid self-matching. **No option lines** are parsed in 1.13.7 (older third-party docs mention `collapse:`/`sort:`/`explain:`/`context:` — not present in current code; **AMBIGUOUS/legacy**). Not supported on Publish.

### 3.22 Slash commands

- Type `/` at line start or after whitespace → command suggester (fuzzy) filtered to editor-applicable commands; ↑↓ ↵; Esc or Space exits. No settings. (Default off.)

### 3.23 Slides

- **Start presentation** (`slides:start`), tab context menu. Uses reveal.js (bundled `lib/reveal`). Slides separated by `---` on its own line surrounded by blank lines. Navigation: bottom-right arrows, ← →, Space next; Esc or top-right × exits. Renders normal Markdown (embeds, callouts, math, code). No settings.

### 3.24 Sync (core plugin UI — service in §10)

Commands: **Set up Sync** (`sync:setup`), **View version history** (`sync:view-version-history`), **Show Sync history** (`sync:open-sync-view`, sidebar), **Open activity log** (`sync:open-sync-log`). Status bar icon (Synced green / Syncing purple / Paused / Disconnected red) → menu: Pause/Resume, Version history, Open Sync log, Deleted files, Sync settings. File menu **Open version history**.

### 3.25 Tags view

- Sidebar list of all tags with counts ("Show tags", `tag-pane:open`). Options: sort (Tag name A→Z, Z→A, Frequency high→low, low→high), **Show nested tags** (tree vs flat), **Expand all / Collapse all**, per-level expanders, filter box. Click tag → Search `tag:#x`; Mod+click toggles the tag in the current search query. Excluded files not counted.

### 3.26 Templates

- Settings: **Template folder location**; **Date format** (default `YYYY-MM-DD`; "`{{date}}` in the template file will be replaced with this value. You can also use `{{date:YYYY-MM-DD}}` to override the format once"); **Time format** (default `HH:mm`).
- Variables: `{{title}}` (active note title), `{{date}}`, `{{time}}`, `{{date:FORMAT}}`, `{{time:FORMAT}}` (Moment.js tokens; both accept any format). Also usable in Daily notes and Unique note creator templates. Note composer adds `{{content}}`, `{{fromTitle}}`, `{{newTitle}}`.
- Commands: **Insert template** (`insert-template`, ribbon; suggester "Type name of a template..."), **Insert current date** (`insert-current-date`), **Insert current time** (`insert-current-time`).
- Behaviour: inserts at cursor (last cursor position if not focused); merges template properties with the note's; unquoted variables in property values can be clobbered by the Live Preview property editor — edit templates in Source mode.
- Errors: no folder set, folder not found/invalid, template properties unreadable, "No templates found".

### 3.27 Unique note creator

- Command/ribbon **Create new unique note** (`zk-prefixer`); **Add unique internal link** (`insert-unique-link`, links selected text to a new unique note, 1.9). URI `unique`. CLI `unique`.
- Settings: **Unique prefix format** (Moment format, default `YYYYMMDDHHmm`; if name exists uses next available timestamp), **New file location**, **Template file location**.

### 3.28 Web viewer (desktop only)

- Opens http(s) links as tabs (Electron `<webview>`), splittable/pop-out. Address bar with **Search the web**, Backward, Forward, Reload, **Reader view** (glasses icon; Mozilla Readability/Defuddle cleaned view), "…" menu: **Save to vault** (converts page to Markdown via Defuddle/Turndown into Saved page folder), **Bookmark page**, **Open in default browser**, Copy URL, zoom in/out/reset.
- Page context menu: Open link / in new tab / to the right / in new window / in default browser / in web viewer, Copy link address, Bookmark link, Search for "{query}", **Extract selection to new note**, Copy/Cut/Paste/Delete/Select all, **Save image to vault**, Copy image link.
- Settings: **Open external links** (toggle: open links in Obsidian rather than system browser), **Homepage**, **Saved page folder**, **Search engine** (presets + **Custom** with `%s`), **Enable ad blocker** (toggle), **Ad blocking rules** (one filter-list URL per line, e.g. EasyList; shared by all vaults), **Ad block update frequency** (days, 0 = disabled), **Clear web viewer data** (Cookies, Cached data, History, All web viewer data).
- Commands: **Open web viewer** (`webviewer:open`), **Show history** (`webviewer:open-history`, "Web history" sidebar: remove entry, clear history), **Toggle reader mode**, **Focus address bar**, **Search the web**, **Save to vault**, **Zoom in/out/reset** (`webviewer:*`).
- Security: plugins have access to its cookies; cookie encryption requires 1.11 installer; audited by Cure53.

### 3.29 Word count

- Status bar "N words · N characters"; counts current **selection** when text is selected (1.6); ignores frontmatter (1.5); CJK-aware counting (regex covering Hangul, Tamil etc.). On mobile shown at top of right sidebar (file info). No settings. CLI `wordcount`.

### 3.30 Workspaces

- Saves layout: open files/tabs, splits, sidebars' width/visibility/tabs, active tab. Stored in `.obsidian/workspaces.json`.
- Commands: **Manage workspace layouts** (`workspaces:open-modal`, ribbon; modal lists saved layouts with Modified time, **Load**, **Delete layout** ×, name field "Save current workspace layout as..." + **Save**; active one highlighted), **Load workspace layout** (`workspaces:load`, suggester), **Save layout** (`workspaces:save`, 1.5.11), **Save and load another layout** (`workspaces:save-and-load`). Saving with an existing name overwrites.

### 3.31 Open in default app

Commands **Open in default app** (`open-with-default-app:open`; on mobile "Share") and **Show in system explorer / Reveal in Finder** (`open-with-default-app:show`). Confirmation dialog when opening files externally (1.12).

### 3.32 Editor status

Status bar indicator (pencil/book/code icons) showing Reading / Live Preview / Source mode; click → menu to switch. (Plugin "Show editing mode in status bar".)


---

## 4. Bases (`.base` files and ```` ```base ```` blocks)

History: 1.9.0 EA (2025-05-21) → public 1.9.10 (2025-08-18) with Table + Cards; 1.10 added Group by, summaries, List view, Bases API, Maps plugin, table selection/keyboard/copy-paste/undo, `reduce/mean/stddev/median/html/random`; 1.12 added search toolbar, drag-and-drop import into Bases, row context menu; 1.14 EA adds Kanban layout and collapsible groups.

### 4.1 Data model

- A base is a **query over every file in the vault** (no `FROM`); rows are files (all file types, not only Markdown). Filters narrow the set.
- Columns are **properties** of three kinds:
  1. **Note properties** — frontmatter, `note.price`, `note["price"]`, or bare `price` (default namespace).
  2. **File properties** — `file.*`, available for every file type.
  3. **Formula properties** — `formula.name`, defined in the base.
- Editing a note-property cell writes to that note's frontmatter. Formula and file properties are read-only.
- **`this`** context: base opened as a tab → the `.base` file itself; embedded → the **embedding** note/canvas; in a sidebar → the **active file** in the main area (e.g. `file.hasLink(this.file)` reproduces backlinks).

### 4.2 File properties

| Property | Type | Notes |
|---|---|---|
| `file.name` | string | Name with extension (UI label "file name") |
| `file.basename` | string | Name without extension ("file base name") |
| `file.path` | string | Vault-relative path |
| `file.folder` | string | Parent folder path |
| `file.ext` | string | Extension |
| `file.size` | number | Bytes |
| `file.ctime` | date | Created |
| `file.mtime` | date | Modified |
| `file.properties` | object | All frontmatter (does not auto-refresh on vault change) |
| `file.tags` | list | Inline + frontmatter tags |
| `file.links` | list | Internal links incl. frontmatter links |
| `file.embeds` | list | Embeds in the note |
| `file.backlinks` | list | Backlinking files (expensive; periodically refreshed since 1.10) |
| `file.file` | file | File object for functions |
| (UI label "file full name") | | Appears in property picker (code), **AMBIGUOUS** mapping |

### 4.3 YAML schema

```yaml
filters:            # string | {and: [...]} | {or: [...]} | {not: [...]}  (applies to all views)
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:           # name -> expression string
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:         # per-property config used by views
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:          # custom summary formulas; `values` = list of column values
  customAverage: 'values.mean().round(3)'
views:
  - type: table     # table | cards | list | kanban (1.14) | map (Maps plugin) | plugin types
    name: "My table"   # required, unique; used for ![[file.base#My table]]
    limit: 10
    groupBy:
      property: note.age
      direction: DESC  # ASC | DESC
    filters:           # view filters, ANDed with global filters
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:             # visible columns/properties, in order
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    sort:              # list of {property, direction ASC|DESC}; legacy key `column` accepted (code)
      - property: file.mtime
        direction: DESC
    summaries:         # property -> summary name (built-in or custom)
      formula.ppu: Average
    # view-type specific keys, e.g. table: rowHeight, columnSize; cards: cardSize, image, imageFit, imageAspectRatio;
    # list: markers, indentProperties, separator; map: coordinates, markerIcon, markerColor, mapTiles, center, zoom…
```

Validation errors surfaced to user (from i18n): "Views must be an array", "\"filters\" must be a string or an object", "\"filters\" may only have one of an \"and\", \"or\", or \"not\" keys", "\"{conjunction}\" filter must be an array", "Formula values must be strings", "Display values must be strings", "Missing or invalid \"name\" in view N", "\"key\" is required in view …", "Unknown view type", "View \"x\" not found", "Infinite loop detected in formula", "Failed to compute value of property", "Query is an invalid format. It should be a YAML object."

`not` semantics: **None of the following are true** — excludes if *any* listed condition matches.

Other view-level config keys seen in code: `newItemFolder` ("New item folder"), `newItemTemplate` ("New item template file"), `rowHeight`, `order`, `summaries`, `limit`. Serialized view keys confirmed in code: `type`, `name`, `filters`, `groupBy {property, direction}`, `order`, `sort [{property, direction}]`, `limit`, `summaries`; table `rowHeight`, `columnSize {property: px}`; cards `cardSize` (default 200 px), `image`, `imageFit` (`cover`|`contain`), `imageAspectRatio` (number, default 1); list `markers` (`bullet`|`number`|`none`), `indentProperties`, `separator`.

### 4.4 Expression language

Formulas, filter statements and summary formulas share one expression language ("follows JavaScript behaviour").

**Literals**: strings `"x"`/`'x'`; numbers `1`, `(2.5)`; booleans `true`/`false`; lists `[1, 2, 3]`; objects `{"a": 1}`; regex `/abc/g`; `null`.

**Access**: `list[0]` (0-based), `obj.key`, `obj["key with space"]`, method calls `value.fn(args)`, fields `date.year`, `str.length`.

**Operators**

| Kind | Operators |
|---|---|
| Arithmetic | `+ - * / %` and `( )`; `+` concatenates strings |
| Comparison | `== != > < >= <=` (`==`/`!=` on any type; ordering on numbers & dates) |
| Boolean | `!`, `&&`, `\|\|` |
| Date arithmetic | `date + "1M"`, `date - "2h"`; `date - date` → milliseconds; duration strings with units `y/year/years`, `M/month/months`, `d/day/days`, `w/week/weeks`, `h/hour/hours`, `m/minute/minutes`, `s/second/seconds`, combinable (`"1 day"`, `"7d"`) |
| Duration math | `duration('1d') * 2` (duration must be on the left) |

**Link equality**: links equal if they resolve to the same file (or identical text if unresolved); `author == this` compares link to file; `authors.contains(this)` works.

### 4.5 Function reference (complete, verified against the 1.13.7 function registry)

Type keys used in the registry: Any, Null, String, Number, Boolean, Date, List, Object, RegExp, File, Link, Tag (plus render types Image, Icon, HTML, URL).

**Global functions**

| Function | Signature | Returns / notes |
|---|---|---|
| `now()` | → date | Current moment |
| `today()` | → date | Today, time 00:00 |
| `date(input)` | string\|date → date | Parses `YYYY-MM-DD HH:mm:ss` / ISO 8601 (offsets allowed) |
| `duration(value)` | string → duration | Explicit duration parse |
| `if(condition, trueResult, falseResult?)` | → any | Truthy check; missing false branch → `null` |
| `min(a, b, …)` / `max(a, b, …)` | numbers → number | Variadic |
| `number(input)` | any → number | Dates → epoch ms; booleans → 1/0; string parse (error if invalid) |
| `list(element)` | any → list | Wraps non-lists |
| `link(path, display?)` | string\|file, any → Link | `display` may be string or `icon()` |
| `file(input)` | string\|link\|file → file | Locate file by path/link |
| `image(input)` | string\|file\|link\|url → image | Renders image in views |
| `icon(name)` | string → icon | Lucide icon name |
| `html(input)` | string → html | Render raw (sanitised) HTML |
| `escapeHTML(input)` | string → string | Escape `& < > " '` |
| `random()` | → number | 0–1, re-rolls on view load |

**Any**

| Method | Notes |
|---|---|
| `toString()` | String form |
| `isTruthy()` | Coerce to boolean |
| `isType(type)` | `"string"`, `"number"`, `"boolean"`, `"date"`, `"list"`, `"object"`, `"link"`, `"file"`, `"null"`… |

**Null**: `isEmpty()` → true.

**String** (field `length`)

| Method | Notes |
|---|---|
| `contains(value)` | Substring |
| `containsAll(...values)` | All substrings |
| `containsAny(...values)` | Any substring |
| `startsWith(query)`, `endsWith(query)` | |
| `isEmpty()` | Empty or absent |
| `lower()` | Lowercase (no `upper()` exists) |
| `title()` | Title Case |
| `trim()` | |
| `replace(pattern, replacement)` | String pattern → **all** occurrences; RegExp → respects `g`; `$1`, `$2` capture refs |
| `repeat(count)` | |
| `reverse()` | |
| `slice(start, end?)` | |
| `split(separator, n?)` | separator string or RegExp; keep first n |

**Number**

| Method | Notes |
|---|---|
| `abs()`, `ceil()`, `floor()` | |
| `round(digits?)` | Optional decimal places |
| `toFixed(precision)` | → string |
| `isEmpty()` | Absent |

**Date** (fields `year`, `month` 1–12, `day`, `hour`, `minute`, `second`, `millisecond`)

| Method | Notes |
|---|---|
| `date()` | Strip time |
| `time()` | `"HH:mm:ss"` string |
| `format(fmt)` | Moment.js format |
| `relative()` | "3 days ago" |
| `isEmpty()` | Always false |

**List** (field `length`)

| Method | Notes |
|---|---|
| `contains(value)`, `containsAll(...values)`, `containsAny(...values)` | |
| `filter(expr)` | Uses implicit `value`, `index` → keep if true |
| `map(expr)` | Uses `value`, `index` |
| `reduce(expr, initial)` | Uses `value`, `index`, `acc` |
| `flat()` | Flatten one level |
| `join(separator)` | |
| `reverse()` | In place |
| `slice(start, end?)` | |
| `sort()` | Ascending |
| `unique()` | |
| `isEmpty()` | |
| `sum()`, `mean()`, `median()`, `min()`, `max()`, `stddev()` | Number aggregates (used by summaries; callable directly) |
| `earliest()`, `latest()` | Date aggregates |

**Object**: `isEmpty()`, `keys()`, `values()`, `map(expr)` (uses `key`, `value` → list), `filter(expr)` (uses `key`, `value`).

**RegExp**: `matches(value)`.

**File** (fields as in §4.2)

| Method | Notes |
|---|---|
| `asLink(display?)` | → Link |
| `hasLink(dest)` | dest: file, link or path string |
| `hasTag(...tags)` | Any of; includes nested children |
| `hasProperty(name)` | |
| `inFolder(folder)` | Includes subfolders |

**Link**: `asFile()`, `linksTo(file)`.

**Tag**: `matches(tag)` (tag-aware match incl. nesting).

(i18n also contains a `markdown()` global doc string — "Converts a string into a code snippet that renders as Markdown" — but no registered function in 1.13.7; treat as upcoming.)

### 4.6 Summaries

Built-in (name → input type): **Average, Min, Max, Sum, Range, Median, Stddev** (numbers); **Earliest, Latest, Range** (dates); **Checked, Unchecked** (booleans); **Empty, Filled, Unique** (any). Custom summaries: formula over `values`, e.g. `values.reduce(acc + value, 0)`. Summaries are per view; shown as a bottom summary bar; when grouped, per-group summary at top of each group. Right-click column header → **Summarize...** / **Add summary**; click summary cell to change; bar hides when all removed.

### 4.7 Toolbar and UI operations

Toolbar (left→right): **View menu** (current view name; list of views with drag-to-reorder, **Add view**, per-view arrow → **Configure view**: Layout, View name, layout settings, **Default view**, **Duplicate view**, **Delete view**; right-click view name = settings), **Results** ("Showing N" → **Limit number of results**, **Copy to clipboard** (TSV/Markdown table pasteable into spreadsheets), **Export CSV...**), **Sort** (Sort by list with drag priority + direction per type: A→Z/Z→A, 0→1/1→0, Old to new/New to old; **Group by** one property; trash to remove), **Filter** (two sections **All views** = global filters, **This view**; conjunction dropdown **All the following are true / Any of the following are true / None of the following are true**; **Add filter**, **Add filter group** (nesting), each filter = Property + Operator (type-dependent) + Value (supports expressions); **Advanced filter** code toggle shows raw expression editor; "This filter cannot be represented by the simple filter builder"), **Properties** (checklist of properties with drag reorder, Find or create..., **Add formula**, Hide all / Show all, per property: Display name, Property type, Edit formula, Delete formula), **Search** (1.12, filters rows by displayed values), **New** (create file matching view; New item folder & template; warns "This note will be filtered out because it doesn't match your criteria").

Formula editor: autocomplete for functions (with doc strings) and properties, live validation with green check.

Filter operators (verified from code): comparison operators by value type — **is / is not** (numbers show `=` / `≠`, dates **on / not on**, lists **is exactly / is not exactly**), and for numbers & dates **< ≤ > ≥** (dates: **before / on or before / after / on or after**). Function operators (each with an inverse): **has property / does not have property**, **is empty / is not empty**, **starts with / does not start with**, **ends with / does not end with**, **contains / does not contain**, **contains any of / does not contain any of**, **contains all of / does not contain all of**, **matches / does not match** (regex), **links to / does not link to**, **in folder / is not in folder**, **has tag / does not have tag**. The operator list for a property is derived from which registered functions accept its value type (so plugins' functions can appear). Inverse operators presumably serialize as a negated expression (`!fn(...)`) — **AMBIGUOUS**.

### 4.8 Layouts

**Table** (1.9): rows = files, columns = `order`. Column header menu: Sort A→Z / Z→A, Clear sort, **Group by this property**, **Summarize...**, **Edit property...**/**Edit formula...**, **Hide column**, **Resize column...**, **Reset column size**; drag headers to reorder, drag edges to resize. Setting **Row height**: Short / Medium / Tall / Extra tall. Inline cell editing with type widgets (checkbox, date picker, list chips, link suggester). Selection & keyboard: Shift-click range; Mod+C / Mod+V copy/paste cells; Mod+Z / Mod+Shift+Z undo/redo property edits; Mod+A select all in group; Mod+Shift+Arrow extend to edge; Ctrl+Space select column; Shift+Space select row; Enter focus cell (toggles checkbox / opens formula editor); Home/End first/last column; PageUp/PageDown; Esc clear selection; Backspace clear cells ("Clear values"); Tab / Shift+Tab next/prev cell. Right-click row/selection → file context menu for those files (1.12). Drag rows/links out (to editor, explorer). Virtualised rendering.

**Cards** (1.9): grid; settings **Card size** (width), **Image property** (local attachment link `"[[img.jpg]]"`, external URL, or hex color `#000000` → colored cover), **Image fit** (Cover crops / Contain), **Image aspect ratio** (default 1:1). Properties shown under title; first property = title.

**List** (1.10): settings **Markers** (Bullet / Number / None), **Indent properties** (nested sub-items vs inline), **Property separator** (default comma). First property in Properties menu is the primary item (reorder with drag or Alt+Up/Down). Multi-line content supported.

**Kanban** (1.14 early access): requires Group by; columns = group values, "None" column for empty. Drag card between columns → rewrites the grouped property (Markdown notes only; not for formula/file properties). Plus icon in column header / **New** at column bottom → create note with that value. Drag column headers to reorder; right-click column → **Reset order**. First property = card title. Settings: **Hide empty columns**, **Column width**, **Image property**, **Image fit**, **Image aspect ratio**. Also 1.14: groups collapsible in table/cards/list.

**Map** (1.10, official **Maps** community plugin, MapLibre): settings **Embedded height**, **Center coordinates**, **Zoom constraints** (min/max/default), **Marker coordinates** property (text `"lat, lng"` or list `["lat","lng"]`; formula `[latitude, longitude]`), **Marker icon** property (Lucide name), **Marker color** property (CSS color / `var(--color-blue)`), **Map tiles** / Background (raster/vector tile URL, TileJSON; e.g. OpenFreeMap `https://tiles.openfreemap.org/styles/liberty`). Marker click shows a property preview; right-click map → **Copy coordinates**.

### 4.9 Embedding

- `![[File.base]]` (first view) / `![[File.base#View]]`.
- Inline ```` ```base ```` code block containing the same YAML.
- In Canvas: file card for a `.base`; card context **Pin view...** to fix a view (code).
- Publish support for Bases: planned, **not available** in 1.13.7 (roadmap mention in 1.9.0 notes).

### 4.10 CLI & API touchpoints

CLI: `bases`, `base:views`, `base:create file= view= name= content= open newtab`, `base:query file= view= format=json|csv|tsv|md|paths`. Plugin API: custom view types (`registerView` with `options` factory), plugin-provided functions ("plugins can add additional functions").

---

## 5. Canvas (`.canvas`, JSON Canvas 1.0)

### 5.1 File format (JSON Canvas spec 1.0, 2024-03-11)

```json
{
  "nodes": [
    {"id":"a1","type":"text","x":0,"y":0,"width":250,"height":60,"color":"1","text":"# Markdown"},
    {"id":"b2","type":"file","x":300,"y":0,"width":400,"height":400,"file":"Notes/Idea.md","subpath":"#Heading"},
    {"id":"c3","type":"link","x":0,"y":500,"width":400,"height":300,"url":"https://obsidian.md"},
    {"id":"g4","type":"group","x":-50,"y":-50,"width":900,"height":900,"label":"Cluster","background":"bg.png","backgroundStyle":"cover"}
  ],
  "edges": [
    {"id":"e1","fromNode":"a1","fromSide":"right","fromEnd":"none","toNode":"b2","toSide":"left","toEnd":"arrow","color":"#FF0000","label":"supports"}
  ]
}
```

| Object | Field | Req | Type / values |
|---|---|---|---|
| Top level | `nodes` | opt | array, **z-order ascending** (first = bottom) |
| | `edges` | opt | array |
| Any node | `id` | req | unique string (Obsidian writes 16-hex ids) |
| | `type` | req | `text` \| `file` \| `link` \| `group` |
| | `x`, `y` | req | integer px (top-left) |
| | `width`, `height` | req | integer px |
| | `color` | opt | canvasColor |
| text | `text` | req | Markdown string |
| file | `file` | req | vault path |
| | `subpath` | opt | starts with `#` (heading or `#^block`) |
| link | `url` | req | string |
| group | `label` | opt | string |
| | `background` | opt | image path |
| | `backgroundStyle` | opt | `cover` \| `ratio` \| `repeat` |
| Edge | `id` | req | string |
| | `fromNode`, `toNode` | req | node ids |
| | `fromSide`, `toSide` | opt | `top` \| `right` \| `bottom` \| `left` |
| | `fromEnd` | opt | `none` (default) \| `arrow` |
| | `toEnd` | opt | `arrow` (default) \| `none` |
| | `color` | opt | canvasColor |
| | `label` | opt | string |
| canvasColor | | | hex `"#RRGGBB"` or preset `"1"` red, `"2"` orange, `"3"` yellow, `"4"` green, `"5"` cyan, `"6"` purple (exact RGB left to app) |

Obsidian extensions beyond spec: file nodes for `.base` files may store a pinned view (**AMBIGUOUS** key); unknown extra keys should be preserved on round-trip.

### 5.2 Canvas UI operations

**Create / add cards**
- Bottom toolbar: **Drag to add card** (text; also double-click empty canvas), **Drag to add note from vault**, **Drag to add media from vault** (click or drag icon, then suggester).
- Canvas context menu: Add card, Add note from vault, Add media from vault, **Add web page** (URL prompt), **Create group**, **Create a card with specific size** (code), Paste.
- Drag in: files from File explorer or OS (any type, unrecognised files too), **folders** (adds all files), URLs from browser (link card), text/HTML.
- `Mod`+drag on canvas → configurable default (menu / card / note / media / webpage / group).
- Dragging an edge end into empty space creates a new card there.

**Edit**: double-click text/note card (or context **Edit**) enters edit mode (full editor with properties, 1.9); Esc or click outside exits. Link card: Mod+click label or **Open in browser** / **Change URL...** / **Reload page**; can open as Web viewer tab. Note card: **Swap file...**, **Narrow to heading...** / **Narrow to block...** (sets `subpath`; "Show entire file"), open file. Text card → **Convert to file...** (becomes note card). Base card → **Pin view...**. Card name label visibility per setting.

**Select**: click; Shift+click add/remove; drag marquee; `Mod+A` select all. Must select a card before scrolling its content. Selecting brings card to front.

**Arrange**: drag to move (snap to grid / objects, hold **Space** to disable snapping); **Alt/Option**+drag duplicates ("Clone card"); **Shift**+drag constrains to axis; resize from edges/corners (Shift keeps aspect ratio, Space disables snapping). Selection controls (floating toolbar above selection): **Remove** (trash), **Set color** (palette: 6 presets + custom), **Zoom to selection**, **Edit label** (edges), **Align** (left, center, right, top, middle, bottom), **Distribute** horizontal/vertical spacing, **Justify** horizontally/vertically, **Arrange** in a row / column / grid. Context **Duplicate**, **Delete** (Backspace/Delete). Copy/cut/paste cards (Mod+C/X/V, also across canvases/windows).

**Connect**: hover a card edge → filled circle → drag to another card (creates directed edge, `toEnd: arrow`). Move an endpoint by dragging its handle; drag handle off a card to disconnect. Edge context: **Edit label** (or double-click edge; Esc to finish), **Remove label**, **Set color**, **Line direction** (Nondirectional / Unidirectional / Bidirectional → `fromEnd`/`toEnd`), **Go to target / Go to source** ("Follow connection"), **Remove**.

**Groups**: **Create group** from selection or empty; double-click label to rename (Enter saves); moving a group moves contained cards; group background: **Set background**, **Edit/Replace/Remove background**, style Cover / Keep aspect ratio / Repeat. **Jump to group** command (suggester "to navigate to group").

**Navigate**: pan with Space+drag, middle-mouse drag, scroll (vertical) / Shift+scroll (horizontal) when wheel = pan; zoom with Space/Mod+scroll or pinch; zoom controls top-right: **Zoom in**, **Zoom out**, **Reset zoom**, **Zoom to fit** (`Shift+1`), **Zoom to selection** (`Shift+2`), **Read-only** toggle ("Disable read-only"), **Canvas settings**, **Canvas help** (shortcut sheet: Pan, Pan horizontally, Zoom, Select all, Add to/remove from selection, Clone card, Constrain card movement to axis, Disable snapping while dragging, Remove card; touch: Touch and hold to add/move/select, Drag to pan, Pinch to zoom). Card content hidden below zoom threshold.

**Export**: **Export as image** → PNG dialog: **Show logo**, **Privacy mode** (obscure text), **Zoom** (resolution), **Viewport** (Full canvas / Viewport only), estimated dimensions.

**Integration**: canvases are searchable (content search), contribute backlinks/graph links (1.12), rename of embedded files updates canvas (notice "Canvas detected file renames affecting N canvas files, updating..."), embeddable in notes (`![[x.canvas]]`, shapes only), file recovery supports `.canvas`, Sync merges canvases by last-modified-wins.


---

## 6. Settings (every tab and option)

Since 1.13 Settings opens in its **own window** by default (Interface → **Open settings in new window**), is **searchable** ("Search settings...", core + core plugins; community plugins via new Settings API), fully keyboard navigable (arrows, Enter opens tab, Mod+F refocus search, Vim keys, mouse back button, Alt+Up/Down reorders list items, Escape closes). Sections have icons (1.11). Vault settings persist in `.obsidian/app.json` (Editor/Files), `appearance.json`, `hotkeys.json`, `core-plugins.json`, `community-plugins.json`, `types.json`, per-plugin `<id>.json` / `plugins/<id>/data.json`.

Sidebar order (1.13.4+): **Options**: General, Interface, Editor, Files and links, Appearance, Hotkeys, Keychain; **Core plugins**; **Community plugins**; **Plugin options** (one page per enabled plugin with settings).

### 6.1 General (was "About")

| Setting | Type | Notes |
|---|---|---|
| Current version / installer version | info | **Check for updates**, **Read the changelog** |
| Automatic updates | toggle | |
| Receive early access versions | toggle | Catalyst license only |
| Language | dropdown | UI language (≈40 locales); also chosen at vault creation |
| Help | button | Open help |
| Command line interface | toggle | 1.12+ (installer 1.12.7+): registers `obsidian` CLI on PATH |
| Account → Your account | login/logout, Manage | Email + password, 2FA |
| Catalyst license | info | Tier |
| Commercial license | Activate / Purchase | License key |
| Advanced → Notify if startup takes longer than expected | toggle + timer icon (startup time breakdown) | 1.7.1 |

### 6.2 Interface (new page, 1.13)

| Setting | Default | Notes |
|---|---|---|
| Open settings in new window | on | |
| Show tab title bar | on | Header with back/forward, title/breadcrumb, view switcher, "More options" |
| Show ribbon | on | |
| Ribbon menu configuration → Manage | | Modal: toggle and drag-reorder ribbon items ("Other ribbon items") |
| Inline title (`showInlineTitle`) | on | Editable filename as title |
| Mobile: Floating navigation | on | Navigation buttons float over content |
| Mobile: Sliding sidebars | on | Sidebars slide content instead of overlaying |
| Mobile: Full screen (`autoFullScreen`) | on | Auto-hide chrome while reading |
| Mobile: Quick access ribbon item | "Open ribbon menu" | Short-press action; menu moves to long-press |
| Mobile: Toolbar → Manage toolbar options / Configure mobile Quick Action | | See §11 |
| Advanced: Native menus, Window frame style, Custom app icon, Zoom level, Hardware acceleration, Translucent window | | Some shown under Appearance → Advanced in docs (**AMBIGUOUS** exact page after 1.13 move) |

### 6.3 Editor

Code defaults from `app.json` defaults object (1.13.7).

| Group | Setting | Config key | Default | Options / notes |
|---|---|---|---|---|
| General | Always focus new tabs | `focusNewTab` | on | |
| | Default view for new tabs | `defaultViewMode` | `source` = Editing view | Editing view / Reading view (command "Toggle default mode for new tabs") |
| | Default editing mode | `livePreview` | true = Live Preview | Live Preview / Source mode |
| | Show editing mode in status bar | (core plugin `editor-status`) | on | |
| Display | Readable line length | `readableLineLength` | on | Max width ~700px (`--file-line-width`) |
| | Strict line breaks | `strictLineBreaks` | off | See §1.15 |
| | Properties in document | `propertiesInDocument` | `visible` | Visible / Hidden / Source |
| | Fold heading | `foldHeading` | on | |
| | Fold indent | `foldIndent` | on | |
| | Line numbers | `showLineNumber` | off | Gutter; also gutter right-click menu |
| | Indentation guides | `showIndentGuide` | on | Vertical list relationship lines |
| | Right-to-left (RTL) | `rightToLeft` | off | Default text direction |
| | Show Mermaid diagrams in notes | (per-vault allow) | off until allowed (1.13) | |
| Behavior | Spellcheck | `spellcheck` | on | Gear → remove custom dictionary words |
| | Spellcheck languages | `spellcheckLanguages` | null | Win/Linux list (+ / ×); macOS auto |
| | Auto-pair brackets | `autoPairBrackets` | on | `() [] {} "" ''` (not `'` after `[[…]]`) |
| | Auto-pair Markdown syntax | `autoPairMarkdown` | on | Pairs `**`, `__`, `~~`, `==`, backtick, `$` around selections |
| | Smart lists | `smartIndentList` | on | Auto indentation, continue lists, renumber |
| | Indent using tabs | `useTab` | on | Off = 4 spaces |
| | Indent visual width | `tabSize` | 4 | |
| | Convert pasted HTML to Markdown | `autoConvertHtml` | on | `Mod+Shift+V` pastes without converting |
| Advanced | Vim key bindings | `vimMode` | off | Confirmation modal quiz: must type `:q!` to enable ("Let me enable Vim"); per-device on mobile. Vim supports `:image grow/shrink/reset` (1.13) |

(Older "Show frontmatter" and "Use legacy editor" settings are removed.)

### 6.4 Files and links

| Setting | Config key | Default | Options |
|---|---|---|---|
| Default file to open (1.11) | `openBehavior` | `""` = Last opened | Last opened (`""`) / New note (`new`) / Specific file (`file:<path>`, + **File to open**) / Daily note (`daily`, only when Daily notes enabled) |
| Default location for new notes | `newFileLocation` | `root` | Vault folder / Same folder as current file (`current`) / In the folder specified below (`folder`) + **Folder to create new notes in** (`newFileFolderPath`) |
| New link format | `newLinkFormat` | `shortest` | Shortest path when possible / Path from current file (`relative`) / Path from vault folder (`absolute`) |
| Use [[Wikilinks]] | `useMarkdownLinks` (inverted) | Wikilinks | |
| Automatically update internal links | `alwaysUpdateLinks` | code default **false** | false → rename shows a dialog (Always update / Just once / Do not update; "Always update" sets true). Docs describe the setting as on by default — **AMBIGUOUS**; fresh vaults may write `true` |
| Default location for new attachments | `attachmentFolderPath` | `/` (vault root) | UI choices `root` / `current` / `subfolder` / `folder` (code), persisted in the single `attachmentFolderPath` string: `/` = Vault folder, `./` = Same folder as current file, `./<name>` = In subfolder under current folder (+ **Subfolder name**), `<path>` = In the folder specified below (+ **Attachment folder path**) — string encoding per long-standing behaviour, **AMBIGUOUS** in 1.13 code |
| Show all file types | `showUnsupportedFiles` | off | |
| Trash: Confirm before deleting files | `promptDelete` | on | |
| Trash: Deleted files | `trashOption` | `system` | Move to system trash / Move to Obsidian trash (`.trash` folder, `local`) / Permanently delete (`none`) |
| Trash: Delete attachments when deleting files (1.12) | `deleteUnlinkedAttachments` | `ask` | Always / Ask each time / Never; orphan dialog "Delete file attachments?" |
| Advanced: Excluded files | `userIgnoreFilters` | null | Manage → list of paths or regex (`/daily-.*/`); hides from Search, Graph, Unlinked mentions, Tags/Properties counts; deprioritises in Quick switcher and link suggestions |
| Advanced: Override config folder | (localStorage, not app.json) | `.obsidian` | Must start with `.`; relaunch required; used for per-device settings profiles |
| Advanced: Allow URI callbacks | `uriCallbacks` | off | Enables `x-success` / `x-error` |
| Advanced: Rebuild vault cache | button | | Clears IndexedDB metadata cache and reloads (1.6.5) |

Paste/drop naming: pasted images are saved as `Pasted image YYYYMMDDHHmmss.png` in the attachment location (code). URI allow-list management existed in 1.13.0–1.13.5 but the URI confirmation dialog was **removed in 1.13.6**.

### 6.5 Appearance

| Setting | Config key | Default | Notes |
|---|---|---|---|
| Base color scheme | `theme` | `system` | Adapt to system (`system`) / Light (`moonstone`) / Dark (`obsidian`) |
| Accent color | `accentColor` | "" (purple) | Color picker + reset |
| Themes → Manage | `cssTheme` | "" (Default) | Community theme browser (filter, Dark/Light only, sort, screenshot, README, **Install and use**, **Use this theme**, **Stop using this theme**, Update, Remove); folder icon opens `.obsidian/themes` |
| Current community themes | | | Count + **Check for updates** / **Update all** |
| Interface font | `interfaceFontFamily` | "" | Manage: ordered font list, first available applied, "detected on your system" check |
| Text font | `textFontFamily` | "" | Editing + reading |
| Monospace font | `monospaceFontFamily` | "" | Code, frontmatter |
| Font size | `baseFontSize` | 16 | Slider (px) |
| Quick font size adjustment | `baseFontSizeAction` | off (since 1.5.8) | Mod+scroll / pinch |
| Zoom level | (electron zoom) | 0 | Slider; commands Zoom in/out/Reset zoom |
| Native menus | `nativeMenus` | null (OS default: on macOS) | |
| Window frame style | (main-process setting) | `hidden` | Hidden (default) / Obsidian frame (`custom`) / Native frame (`native`); Relaunch button |
| Custom app icon | | | `.icns .ico .png .svg`, Relaunch |
| Translucent window | `translucency` | off | macOS only (removed on Windows 1.5.11/1.15.11 note) |
| Hardware acceleration | | on | |
| CSS snippets | `enabledCssSnippets` | [] | List of `.obsidian/snippets/*.css` with toggles, search, **Reload snippets**, **Open snippets folder**; live-reloads on file save |

### 6.6 Hotkeys

- Searchable list of **all commands** (core + plugins) with assigned hotkeys; filter chips **All / Assigned / Assigned by me / Unassigned / Conflicts**; "+" add (records key press "Press hotkey..."), multiple hotkeys per command, × delete, **Restore default**, conflict warnings ("This hotkey conflicts with …"), "Blank" hotkey (remove default). Displayed in US layout but matched by physical key. Stored in `.obsidian/hotkeys.json` as `{ "<command-id>": [ {"modifiers": ["Mod","Shift"], "key": "F"} ] }`.

### 6.7 Keychain (1.11)

Vault/app-level secret storage for plugin API keys ("SecretStorage"/"SecretComponent" API); UI lists named secrets. Encryption falls back when unavailable on Linux.

### 6.8 Core plugins

Search box; toggles; gear to plugin options; plus-circle to plugin hotkeys. See §3.

### 6.9 Community plugins

| Item | Notes |
|---|---|
| Restricted mode | On by default; "Turn on community plugins" / "Turn on and reload" (enabling Restricted mode reloads). Since 1.13 can exit Restricted mode **without re-enabling** plugins; "Re-enable installed plugins" option; debug info "Enabled plugins" |
| Automatically check for plugin updates (1.11) | Background check every 3 days / after app update |
| Community plugins → Browse | Directory modal: search (name/author/description), sort Most downloaded / Recently released / Recently updated / Alphabetical, **Show installed only**, details (version, author, repo, last update, downloads, README, Scorecard link, funding/Donate, Copy share link, Open community page), **Install**, **Enable**, **Disable**, **Update**, "This plugin does not support your device" |
| Current plugins | Count, **Check for updates**, **Update all** |
| Installed plugins | Search; per plugin: settings gear, hotkeys, funding heart, uninstall trash, enable toggle; **Reload plugins**, **Open plugins folder** |
| Trust dialog | Opening a vault with plugins for the first time: "Do you trust the author of this vault?" → **Trust author and enable plugins** / **Browse vault in Restricted Mode** |
| Plugin files | `.obsidian/plugins/<id>/{manifest.json, main.js, styles.css, data.json}`; enabled list `community-plugins.json` |

### 6.10 Per-plugin option pages

Audio recorder (none), Backlinks, Bookmarks (none), Canvas, Command palette, Daily notes, File recovery, Graph (in-view), Note composer, Page preview, Quick switcher, Templates, Unique note creator, Web viewer, Sync, Publish — all detailed in §3.

---

## 7. Workspace and UI

### 7.1 Layout (desktop)

- **Ribbon** (vertical strip at far left, visible even when left sidebar collapsed). Default items (depending on enabled plugins): Open quick switcher, Open graph view, Create new canvas, Create new base, Open today's daily note, Insert template, Open command palette, Create new unique note, Start/stop recording, Open random note, Manage workspace layouts, Open format converter, Publish changes. Bottom (1.6+ moved into sidebar footer): **Vault profile / vault switcher** (chevrons; menu **Manage vaults...**, recent vaults), **Help**, **Settings**. Drag to reorder; right-click empty ribbon → toggle items, **Hide ribbon**. Modifier-click ribbon items opening files: Mod = new tab, Mod+Alt = split, Mod+Alt+Shift = window (1.10).
- **Left sidebar** (default tabs: Files, Search, Bookmarks) and **right sidebar** (default: Backlinks, Outgoing links, Tags, Outline, All properties / File properties, Footnotes if enabled, Sync history if shown). Collapse/expand buttons at top corners (`app:toggle-left-sidebar`, `app:toggle-right-sidebar`). Resizable by dragging edges. Sidebars hold **tab groups** that can be split vertically (drag a tab icon above/below a group); sidebar tabs show icons only with tooltips; empty sidebar text "The sidebar is empty, try dragging a tab here." Notes and Bases can be dragged into sidebars (desktop). Pinning in sidebar: pinned note/base tab never replaced; pinned pane (Backlinks/Outline) stops following active note. Since 1.14 EA the whole workspace mirrors for RTL UI languages.
- **Main area**: tab groups (splits) arranged in any nested horizontal/vertical layout; resizable dividers.
- **Status bar** (bottom right): Sync status icon, backlinks count, editing mode indicator, word/character count, plugin items. Some items clickable.
- **Title bar**: with Hidden frame, window controls + tab header row in one line; macOS traffic lights offset CSS vars.

### 7.2 Tabs

- **New tab** (+ button, `Mod+T`) shows empty state: "No file is open" → **Create new note** (`Mod+N`), **Go to file** (`Mod+O`), **See recent files**, **Close**.
- **Tab header** (per tab group): tabs with icon + title, close ×, drag to reorder / move to another group / out of window (new pop-out) / to sidebar; middle-click closes; overflow scroll; tab list dropdown (down arrow, top-right of group) → tab list, **Stack tabs / Unstack tabs**, **Bookmark N tabs...**, close all.
- **Tab context menu**: Close, Close others, Close tabs after, Close all, **Pin/Unpin**, **Link with tab.../Unlink tab**, Split right, Split down, Open in new window, Move to new window, Bookmark, Rename, Move file to..., Reveal file in navigation, Copy path, Open in default app, Reveal in Finder, Start presentation, Delete file, plus plugin items.
- **Pinned tab**: links opened from it open in a new tab; "Close current tab" first unpins (1.9); not closed by "Close all other tabs" (1.7).
- **Stacked tabs** (`workspace:toggle-stacked-tabs`): Andy-Matuschak-style sliding panes with vertical spine titles; also Publish option.
- **Linked views**: from "More options" → **Open linked view** → Backlinks / Outgoing links / Outline / Local graph / File properties; or tab menu **Link with tab...**; linked tabs show a link icon and follow the source tab's file; **Open linked view** for Source + Reading side-by-side: `Mod`+click the view switcher.
- Switching: `Ctrl+Tab` / `Ctrl+Shift+Tab` (also `Ctrl+PageDown/PageUp`, macOS `Cmd+Shift+]`/`[`), `Mod+1..8` nth tab, `Mod+9` last tab, **Undo close tab** `Mod+Shift+T` (reopens in correct group, 1.13.5). Closing a tab activates the tab to its right (1.10). Mobile: tab switcher via nav-bar tab counter ("Show tab overview").
- Focus between groups: commands **Focus on tab group above/below/to the left/to the right** (`editor:focus-top|bottom|left|right`), no default keys.

### 7.3 View header (tab title bar) of a note

Back/forward buttons (right-click shows history list), breadcrumb title (folder path segments truncated first, click filename to rename, `F2`), **view switcher** (book / pencil icon; Mod+click = open a second linked view side-by-side), **More options** "⋮" menu: Open linked view ▸, Reading view / Source mode toggles, Backlinks in document, Add file property, Find... / Replace..., Bookmark, Rename, Move file to..., Merge entire file with..., Copy path ▸, Open in default app, Reveal in Finder, Open version history, Export to PDF..., Start presentation, Split right/down, Open in new window, Move to new window, Delete file, Pin. Right-click empty space beside editor: Toggle line numbers, Toggle inline title (1.12); gutter right-click: line numbers / readable line width (1.7).

### 7.4 View modes

| Mode | Behaviour |
|---|---|
| **Reading view** | Fully rendered HTML (Prism highlighting, clickable checkboxes/links/tags, folding with persistence, footnote section, backlinks-in-document). Mod+C with no selection copies full note source (1.10). `Mod+E` toggles with editing |
| **Live Preview** (editing mode) | CodeMirror 6 with inline rendering; syntax revealed when cursor enters an element (per-token); widgets for tables (row/column editor), callouts, embeds, images (resize handles, lightbox), math, mermaid, code blocks with copy button, properties editor, checkboxes, horizontal rules, links (Mod+hover preview) |
| **Source mode** (editing mode) | Plain Markdown with syntax highlighting and styled headings; tables auto-formatted as you type (1.5.8) |
| Commands | **Toggle reading view** (`markdown:toggle-preview`, `Mod+E`), **Toggle Live Preview/Source mode** (`editor:toggle-source`), **Toggle editing/reading view**, **Toggle default mode for new tabs** |

Inline title: editable H1-styled filename (not written into the file); ↑/↓ moves between inline title, properties, editor.

### 7.5 Live Preview table editor (1.5+)

Right-click cell → Row: Add row above/below, Move row up/down, Duplicate row, Delete row; Column: Add column left/right, Move column left/right, Duplicate column, Delete column, Align left/center/right (multi-column), Sort by column A→Z / Z→A; selection: Delete cells, Clear cells. Commands `editor:table-row-before`, `-row-after`, `-row-up`, `-row-down`, `-col-before`, `-col-after`, `-col-left`, `-col-right`, … (prefix "Table: …"). Cell selection with drag/Shift, copy/paste cell ranges, Tab/Shift+Tab between cells, Enter new row, quadruple-click selects all cells, backspace after table selects then deletes table, drag content into cells, links/tags clickable.

### 7.6 Editor context menu (Live Preview/Source)

Top: Cut, Copy, Paste, **Paste as plain text**, Select all; **Look up "selection"** (macOS); spellcheck suggestions + **Add to dictionary**; **Format** ▸ Bold, Italic, Strikethrough, Highlight, Code, Math, Comment, **Clear formatting** (1.14 adds highlight colors); **Paragraph** ▸ Bullet list, Numbered list, Task list, Heading 1–6, Body, Quote; **Insert** ▸ Footnote, Table, Callout, Code block, Math block, Horizontal rule, Add link / Add external link (Markdown link), Insert attachment (desktop/mobile), plus Template (if Templates on); **Extract current selection...** (Note composer); **Search for "…"**; **Bookmark this heading... / block**; on links: Open link / new tab / right / window, Edit link, Copy URL, Copy path; on tags: Edit tag, Search tag; on headings: **Rename this heading...**, **Extract this heading...**, Bookmark heading; on block IDs: **Rename this block ID...**; on images: Copy image, Reset size, Remove image, Delete image, Open in default app; on footnotes: Delete footnote and reference; on callouts: Callout type ▸, Remove callout; macOS Writing Tools / Autofill (native menus). Command **Show context menu under cursor** (`editor:context-menu`).

### 7.7 Editor behaviours (implementer checklist)

- Multiple cursors: `Alt`/`Option`+click adds cursor; `Shift+Alt`+drag or middle-mouse drag = rectangular selection; **Add cursor above/below** commands; `Mod+Alt+↑/↓` (CM keymap); `Mod+D` select next occurrence; `Mod+Shift+L` all occurrences; Escape collapses to single cursor.
- List behaviour (Smart lists): Enter continues list/task (empty item Enter ends list), Tab/Shift+Tab indent/unindent (also `Mod+]`/`Mod+[`), auto-renumber ordered lists, paste of list item onto existing marker doesn't duplicate (1.14).
- **Move line up/down** (`editor:swap-line-up/down`, CM `Alt+↑/↓`), copy line up/down (CM `Shift+Alt+↑/↓`), **Delete paragraph** `Mod+D` (Obsidian command wins over CM select-next? — **AMBIGUOUS**: both registered; Obsidian hotkey `Mod+D` = Delete paragraph), delete line `Mod+Shift+K`.
- Copy/cut with no selection copies/cuts the whole line/paragraph; copying rich text includes HTML (1.12).
- Undo/redo `Mod+Z` / `Mod+Shift+Z` (`Mod+Y` Win/Linux); `Mod+U` undo selection (CM).
- Autocomplete popovers: `[[` links, `![[` embeds, `#` tags, `[[x#` headings, `[[x#^` blocks, `[[x|` display text, `[^` footnotes, `/` slash commands, ```` ``` ```` language (code block autocomplete respects indentation), `==` highlight colors (1.14), property names/values.
- Drag and drop into editor: files from explorer → link (`[[ ]]` per link settings, "Insert link here"/"Insert links here"); files from OS → copy into attachment folder + embed (hold `Ctrl`/`Option` → `file:///` link); `.webloc`/`.url` → Markdown link (1.7.1); HTML from browser → converted Markdown; images/URLs.
- Paste: images → attachment file + embed; HTML → Markdown (setting); URL over selection → Markdown link.
- External changes to open file merged automatically ("has been modified externally, merging changes automatically").
- **Export to PDF...** (`workspace:export-pdf`, settings persisted in `pdfExportSettings`): Page size (A3, A4, A5, Legal, Letter [default], Tabloid), **Include file name as title**, **Landscape**, **Margin** (Default / Minimal / None), **Downscale percent** (100); renders Reading view incl. Bases/Mermaid.
- Vim mode with `codemirror-vim` (+ langmap), Ex commands incl. `:image`.
- Spellcheck (Chromium), RTL per note (`dir` auto-detect per paragraph).
- Auto-save: files saved continuously (debounced ~2s) — there is no manual save requirement; **Save current file** (`Mod+S`) forces save.

### 7.8 Navigation

Back/forward per tab (`Mod+Alt+←/→`, mouse back/forward buttons, header arrows with history dropdown). **Navigate back/forward** commands. Recent files in Quick switcher. Mobile nav bar back/forward.

### 7.9 Pop-out windows (desktop)

Open via file menu **Open in new window**, command **Open current tab in new window** / **Move current tab to new window**, tab menu, link `Mod+Alt+Shift`+click, dragging tab outside window. Pop-outs belong to the vault window (closing main closes them); files move only between windows of the same vault; windows restored on relaunch. **Toggle window always on top** command.

### 7.10 Drag-and-drop matrix

| Source → Destination | Result |
|---|---|
| Tab → tab bar/drop zones (center, edges) | Reorder / new split / merge into group |
| Tab → outside window | New pop-out window |
| Tab → sidebar | Pin note in sidebar |
| File(s) (explorer, search result, backlinks, Quick switcher result, Base row, link in preview) → tab header | Open there ("Open in this tab"); hold `Alt` (`Shift` macOS) to drop anywhere in tab ("Open as new tab") |
| File(s) → folder in explorer | Move ("Move into …") |
| File(s) → editor | Insert link(s) respecting link format settings |
| File(s) → Bookmarks view | Bookmark ("Star this file" legacy strings) |
| File(s)/folder → Canvas | Add cards |
| OS file(s)/folder → editor / explorer | Import copy (+ embed in editor); folder structure preserved (1.13) |
| Browser HTML → editor | Converted Markdown |
| Obsidian note → external app | `obsidian://open?...` URL |
| Files → Base (1.12) | Import into base folder |
| Base row link → File explorer (1.13) | Move file |

### 7.11 Hover preview

See §3.16. Popover: resizable, draggable, nested, editable, "open in tab" button, Esc to close; stays open when window loses focus (1.7.1).

### 7.12 Notices, modals, prompts

Toast notices (top-right, hover keeps open), confirmation modals (delete, merge, external link, executable, remote file, network drive, vault trust), suggester modals (fuzzy list with instruction footer: "↑↓ to navigate, ↵ to open, esc to dismiss").

### 7.13 Vault management

- Start screen / **Manage vaults** window: **Create new vault** (name + location), **Open folder as vault**, **Open vault from Obsidian Sync**, recent vault list with "⋮" → **Rename vault** (renames folder), **Move vault**, **Remove from list**, **Copy vault ID**, reveal in Finder; language picker; Quick start (sample vault with welcome.md + graph).
- **Sandbox vault** (**Open sandbox vault** command): a read-and-discard demo vault ("Changes you make in this vault will be lost").
- Commands: **Manage vaults** (`app:open-vault`), **Change vault...** (`app:switch-vault`, keyboard switcher, 1.12), **Open vault...** (`app:open-another-vault`, keeps current open, 1.12).
- Vault = plain folder; `.obsidian` config folder; global app data (`obsidian.json` vault registry keyed by 16-hex vault ID, File recovery snapshots, IndexedDB metadata cache).
- Symlinks/junctions: allowed with caveats (no loops, targets must be disjoint).
- Metadata cache: headings, links, embeds, tags, blocks, frontmatter, list items/tasks, sections per file; rebuilt on demand; Markdown files > 2 MB not indexed.

---

## 8. Hotkeys and commands

### 8.1 Default Obsidian hotkeys (customizable; extracted from the 1.13.7 command registry)

| Command (name) | Command ID | Default hotkey |
|---|---|---|
| Open command palette | `command-palette:open` | `Mod+P` |
| Open quick switcher | `switcher:open` | `Mod+O` |
| Search in all files | `global-search:open` | `Mod+Shift+F` |
| Open graph view | `graph:open` | `Mod+G` |
| Create new note | `file-explorer:new-file` | `Mod+N` |
| Create note to the right | `file-explorer:new-file-in-new-pane` | `Mod+Shift+N` |
| Save current file | `editor:save-file` | `Mod+S` |
| Open settings | `app:open-settings` | `Mod+,` |
| Open help | `app:open-help` | `F1` |
| Rename file | `workspace:edit-file-title` | `F2` |
| Toggle reading view | `markdown:toggle-preview` | `Mod+E` |
| Add file property | `markdown:add-metadata-property` | `Mod+;` |
| Search current file | `editor:open-search` | `Mod+F` |
| Search & replace in current file | `editor:open-search-replace` | `Mod+H` and `Mod+Alt+F` |
| Insert Markdown link | `editor:insert-link` | `Mod+K` |
| Toggle bold | `editor:toggle-bold` | `Mod+B` |
| Toggle italic | `editor:toggle-italics` | `Mod+I` |
| Toggle comment | `editor:toggle-comments` | `Mod+/` |
| Toggle checkbox status | `editor:toggle-checklist-status` | `Mod+L` |
| Delete paragraph | `editor:delete-paragraph` | `Mod+D` |
| Follow link under cursor | `editor:follow-link` | `Alt+Enter` |
| Open link under cursor in new tab | `editor:open-link-in-new-leaf` | `Mod+Enter` |
| Open link under cursor to the right | `editor:open-link-in-new-split` | `Mod+Alt+Enter` |
| Open link under cursor in new window | `editor:open-link-in-new-window` | `Mod+Alt+Shift+Enter` |
| Navigate back | `app:go-back` | `Mod+Alt+←` |
| Navigate forward | `app:go-forward` | `Mod+Alt+→` |
| New tab | `workspace:new-tab` | `Mod+T` |
| Close current tab | `workspace:close` | `Mod+W` |
| Close window | `workspace:close-window` | `Mod+Shift+W` |
| Undo close tab | `workspace:undo-close-pane` | `Mod+Shift+T` |
| Go to next tab | `workspace:next-tab` | `Ctrl+Tab`; plus `Cmd+Shift+]` (macOS) / `Ctrl+PageDown` (others) |
| Go to previous tab | `workspace:previous-tab` | `Ctrl+Shift+Tab`; plus `Cmd+Shift+[` (macOS) / `Ctrl+PageUp` |
| Go to tab #1 … #8 | `workspace:goto-tab-1` … `-8` | `Mod+1` … `Mod+8` |
| Go to last tab | `workspace:goto-last-tab` | `Mod+9` |
| Canvas: Zoom to fit / Zoom to selection | (canvas view keys) | `Shift+1` / `Shift+2` |
| Find next / previous (in-file search & PDF) | (view keys) | `F3` / `Shift+F3` (macOS PDF: `Cmd+G` / `Cmd+Shift+G`; CM also `Mod+G` in search panel) |

Non-command editor keys (CodeMirror/OS, not customizable in Hotkeys): see §8.3.

### 8.2 Complete command list (1.13.7 core; name — id)

**App / window**
Open settings — `app:open-settings`; Open help — `app:open-help`; Reload app without saving — `app:reload`; Show debug info — `app:show-debug-info`; Show release notes — `app:show-release-notes`; Open sandbox vault — `app:open-sandbox-vault`; Manage vaults — `app:open-vault`; Change vault... — `app:switch-vault`; Open vault... — `app:open-another-vault`; Delete current file — `app:delete-file`; Toggle ribbon — `app:toggle-ribbon`; Toggle left sidebar — `app:toggle-left-sidebar`; Toggle right sidebar — `app:toggle-right-sidebar`; Toggle default mode for new tabs — `app:toggle-default-new-pane-mode`; Navigate back — `app:go-back`; Navigate forward — `app:go-forward`; Show tab overview (mobile) — `app:show-tab-switcher`; Toggle light/dark mode — `theme:toggle-light-dark` (replaced "Use light/dark mode" in 1.10); Change theme... — `theme:switch`; Toggle window always on top — `window:toggle-always-on-top`; Zoom in / Zoom out / Reset zoom — `window:zoom-in|zoom-out|reset-zoom`; Configure mobile Quick Action — `mobile:quick-action`.

**Workspace / tabs**
New tab — `workspace:new-tab`; New window — `workspace:new-window`; Close current tab — `workspace:close`; Close all other tabs — `workspace:close-others`; Close this tab group — `workspace:close-tab-group`; Close others in tab group — `workspace:close-others-tab-group`; Close window — `workspace:close-window`; Undo close tab — `workspace:undo-close-pane`; Toggle pin — `workspace:toggle-pin`; Split right — `workspace:split-vertical`; Split down — `workspace:split-horizontal`; Toggle stacked tabs — `workspace:toggle-stacked-tabs`; Go to next/previous/last tab, Go to tab #n — `workspace:next-tab|previous-tab|goto-last-tab|goto-tab-n`; Focus on tab group above/below/left/right — `editor:focus-top|bottom|left|right`; Open current tab in new window — `workspace:open-in-new-window`; Move current tab to new window — `workspace:move-to-new-window`; Rename file — `workspace:edit-file-title`; Copy current file path from vault folder — `workspace:copy-path`; Copy current file path from system root — `workspace:copy-full-path` (1.11); Copy Obsidian URL for current file — `workspace:copy-url`; Export to PDF... — `workspace:export-pdf`; Show trash — `workspace:show-trash`; Focus on last note — `editor:focus`.

**Markdown / properties**
Toggle reading view — `markdown:toggle-preview`; Add file property — `markdown:add-metadata-property`; Add alias — `markdown:add-alias`; Clear file properties — `markdown:clear-metadata-properties`.

**Editor**
Save current file — `editor:save-file`; Download attachments for current file — `editor:download-attachments` (1.8: fetch external images into vault, rewrite embeds); Follow link under cursor — `editor:follow-link`; Open link under cursor in new tab / to the right / in new window — `editor:open-link-in-new-leaf|new-split|new-window`; Rename this heading... — `editor:rename-heading`; Toggle Live Preview/Source mode — `editor:toggle-source`; Search current file — `editor:open-search`; Search & replace in current file — `editor:open-search-replace`; Toggle fold properties in current file — `editor:toggle-fold-properties`; Toggle fold on the current line — `editor:toggle-fold`; Fold all headings and lists — `editor:fold-all`; Unfold all headings and lists — `editor:unfold-all`; Fold more — `editor:fold-more`; Fold less — `editor:fold-less`; Add internal link — `editor:insert-wikilink`; Add embed — `editor:insert-embed`; Insert Markdown link — `editor:insert-link`; Add tag — `editor:insert-tag`; Toggle heading (menu) — `editor:set-heading`; Remove heading — `editor:set-heading-0`; Set as heading 1…6 — `editor:set-heading-1…6`; Toggle bold — `editor:toggle-bold`; Toggle italic — `editor:toggle-italics`; Toggle strikethrough — `editor:toggle-strikethrough`; Toggle highlight — `editor:toggle-highlight`; Toggle code — `editor:toggle-code`; Toggle inline math — `editor:toggle-inline-math`; Toggle blockquote — `editor:toggle-blockquote`; Toggle comment — `editor:toggle-comments`; Clear formatting — `editor:clear-formatting`; Toggle bullet list — `editor:toggle-bullet-list`; Toggle numbered list — `editor:toggle-numbered-list`; Toggle checkbox status — `editor:toggle-checklist-status`; Cycle bullet/checkbox — `editor:cycle-list-checklist`; Insert callout — `editor:insert-callout`; Insert code block — `editor:insert-codeblock`; Insert horizontal rule — `editor:insert-horizontal-rule`; Insert math block — `editor:insert-mathblock`; Insert table — `editor:insert-table`; Insert footnote — `editor:insert-footnote`; Indent list item — `editor:indent-list`; Unindent list item — `editor:unindent-list`; Move line up — `editor:swap-line-up`; Move line down — `editor:swap-line-down`; Undo / Redo — `editor:undo|redo`; Delete paragraph — `editor:delete-paragraph`; Add cursor below / above — `editor:add-cursor-below|above`; Toggle spellcheck — `editor:toggle-spellcheck`; Toggle readable line length — `editor:toggle-readable-line-length` (1.9); Toggle line numbers — `editor:toggle-line-numbers`; Cut / Copy / Paste — `editor:cut|copy|paste`; Show context menu under cursor — `editor:context-menu`; Insert attachment — `editor:attach-file`; mobile-only toolbar commands: Move caret up/down/left/right — `editor:move-caret-*`, Go to first line / last line — `editor:go-start|go-end`, Toggle keyboard — `editor:toggle-keyboard`, Configure mobile toolbar — `editor:configure-toolbar`; Table: Add row above/below, Move row up/down, Add column left/right, Move column left/right, Duplicate row/column, Delete row/column, Align left/center/right, Sort A→Z/Z→A, Delete/Clear cells — `editor:table-*`.

**Plugin commands** (see §3 for ids): Audio recorder (Start/Stop recording audio); Backlinks (Show backlinks, Open backlinks for the current note, Toggle backlinks in document); Bases (Create new base, Insert new base, Copy table to clipboard, Switch view..., Add view, Add item); Bookmarks (Show bookmarks, Bookmark..., Bookmark current search..., Remove bookmark for the current file, Bookmark block under cursor..., Bookmark heading under cursor..., Bookmark all tabs...); Canvas (Create new canvas, Export as image, Jump to group, Convert to file...); Daily notes (Open today's daily note, Open previous/next daily note); File explorer (Show file explorer, Reveal current file in navigation, Create new note, Create new note in current tab, Create note to the right, Create new folder, Move current file to another folder, Make a copy of the current file / Duplicate current file); File recovery (Open local history); Footnotes (Show footnotes); Format converter (Open format converter); Graph (Open graph view, Open local graph, Start graph timelapse animation); Note composer (Merge current file with another file..., Extract current selection..., Extract this heading...); Open in default app (Open in default app, Show in system explorer / Reveal in Finder); Outgoing links (Show outgoing links, Open outgoing links for the current file); Outline (Show outline, Open outline of the current file); Properties (Show all properties, Show file properties); Publish (Publish changes..., Publish current file, Open in live site); Random note (Open random note); Slides (Start presentation); Sync (Set up Sync, View version history, Show Sync history, Open activity log); Tags (Show tags); Templates (Insert template, Insert current date, Insert current time); Unique note creator (Create new unique note, Add unique internal link); Web viewer (Open web viewer, Show history, Toggle reader mode, Focus address bar, Search the web, Save to vault, Zoom in/out/reset); Workspaces (Manage workspace layouts, Load workspace layout, Save layout, Save and load another layout).

### 8.3 Built-in editing keys (not customizable; OS/CodeMirror)

| Action | Win/Linux | macOS |
|---|---|---|
| Copy / Cut / Paste | Ctrl+C / X / V | Cmd+C / X / V |
| Paste without formatting | Ctrl+Shift+V | Cmd+Shift+V |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y | Cmd+Z / Cmd+Shift+Z |
| Copy/cut paragraph (no selection) | Ctrl+C / Ctrl+X | Cmd+C / Cmd+X |
| Line break within paragraph/list | Shift+Enter | Shift+Enter |
| Delete previous / next word | Ctrl+Backspace / Ctrl+Delete | Option+Backspace / Option+Delete |
| Delete to line start / end | — | Cmd+Backspace / Cmd+Delete |
| Delete current line (no selection) | Ctrl+Shift+K | Cmd+Shift+K |
| Word left/right | Ctrl+← / → | Option+← / → |
| Line start/end | Home / End | Cmd+← / → |
| Doc start/end | Ctrl+Home / End | Cmd+↑ / ↓ |
| Page up/down | PageUp / PageDown | Fn+↑ / ↓ |
| Extend selection (add Shift to any of the above) | | |
| Select all | Ctrl+A | Cmd+A |
| Simplify selection / drop extra cursors | Escape | Escape |
| Add cursor | Alt+click | Option+click |
| Rectangular selection | Shift+Alt+drag / middle-drag | Shift+Option+drag |
| Indent / unindent | Tab / Shift+Tab (also Mod+] / Mod+[) | same |
| Move line up/down (CM) | Alt+↑ / ↓ | Option+↑ / ↓ |
| Copy line up/down (CM) | Shift+Alt+↑ / ↓ | Shift+Option+↑ / ↓ |
| Add cursor above/below (CM) | Ctrl+Alt+↑ / ↓ | Cmd+Option+↑ / ↓ |
| Select next occurrence / all occurrences (CM search keymap) | Ctrl+D / Ctrl+Shift+L | Cmd+D / Cmd+Shift+L |
| Go to matching bracket (CM) | Ctrl+Shift+\ | Cmd+Shift+\ |
| Quick font size | Ctrl+scroll (if enabled) | Cmd+scroll / pinch |
| Suggestion navigation | ↑/↓ or Ctrl+N / Ctrl+P | same |

Canvas keys: Space+drag pan, Shift+scroll horizontal pan, Mod/Space+scroll zoom, Shift+1 fit, Shift+2 selection, Mod+A select all, Shift+click multi-select, Alt+drag clone, Shift+drag axis-lock, Space while dragging disables snap, Backspace/Delete remove, Esc exit edit. Graph: +/- zoom, arrows pan, Shift accelerates. Bases table: see §4.8. Properties: see §2.4.

---

## 9. Obsidian URI scheme (`obsidian://`)

Format `obsidian://ACTION?param=value&…` (values percent-encoded; `/` → `%2F`, space → `%20`). Registered handlers in 1.13.7 code: `open`, `new`, `search`, `hook-get-address`, `show-plugin`, `show-theme`, `show-release-notes`, `debug-info`, `publish-sites`, `sync-setup`, `vault-setup`; plugin-registered: `daily` (Daily notes), `unique` (Unique note creator, 1.12); `choose-vault` handled in main process. Plugins can register more (`registerObsidianProtocolHandler`). A URI confirmation dialog with allow-list shipped in 1.13.0 and was removed in 1.13.6.

| Action | Parameters | Behaviour |
|---|---|---|
| `open` | `vault` (name or 16-hex ID), `file` (name or vault path; `.md` optional; `%23Heading` / `%23%5Eblock` subpaths), `path` (absolute FS path; overrides vault+file, picks most specific containing vault), `paneType` (`tab` \| `split` \| `window`; absent = replace last active tab) (1.11), `prepend`, `append` (docs list these on open; merge properties) | Opens/focuses vault; opens file; notice "Opened file …" or "File … not found." |
| `new` | `vault`, `name` (uses default new-note location), `file` (vault path incl. name; overrides `name`; creates folders; rejects `../`), `path` (absolute), `content`, `clipboard` (use clipboard as content), `silent` (don't open), `append`, `prepend` (1.7.2; merge properties), `overwrite` (only if not append), `paneType`, `x-success` | Creates note (or appends/prepends to existing), opens in source mode with rename-all state |
| `daily` | same as `new` (`content`, `clipboard`, `append`, `prepend`, `overwrite`, `silent`, `paneType`, `x-success`) | Requires Daily notes; create/open today's note (1.7.2) |
| `unique` | `vault`, `content`, `clipboard`, `paneType`, `x-success` | Requires Unique note creator (1.12) |
| `search` | `vault`, `query` | Opens Search view with query |
| `choose-vault` | — | Opens vault manager |
| `hook-get-address` | `vault` (optional), `x-success`, `x-error` | For Hook app: returns current file via x-success, else copies `[basename](obsidian://open…)` to clipboard; error code `NotFound` |
| `show-plugin` | `id` | Opens community plugin page in directory (enables community plugins screen if restricted) |
| `show-theme` | `name` | Opens community theme page |
| `show-release-notes` | `version` | Opens release notes tab |
| `debug-info` | — | Shows debug info modal |
| `publish-sites`, `sync-setup`, `vault-setup` | (internal) | Account/service onboarding flows (**AMBIGUOUS** params) |

- **x-callback-url** (requires Settings → Files and links → **Allow URI callbacks**): on success Obsidian calls `x-success` with `name` (basename), `url` (`obsidian://open…`), `file` (`file://…`, desktop only); on failure `x-error` with `errorCode`, `errorMessage`.
- **Shorthands**: `obsidian://vault/my vault/my note` ≡ `open?vault=my vault&file=my note`; `obsidian:///absolute/path/to/my note` ≡ `open?path=/absolute/path/to/my note`.
- Linux registration requires `.desktop` file with `Exec=… %u`.
- Command **Copy Obsidian URL for current file** and file menu **Copy path ▸ as Obsidian URL**; dragging a note into another app produces the URI.


---

## 10. Other products

### 10.1 Obsidian Publish (paid hosting; `publish.obsidian.md/<site-id>`)

**Sites**: create (Site ID = URL slug; number of sites limited by subscription), delete (notes stay local), switch, change site ID. Hosted on Cloudflare (SF). 4 GB per site, **50 MB per file**.

**Publishing workflow** (Publish changes dialog, see §3.18): select NEW / CHANGED / DELETED / UNCHANGED; **Add linked** (respects excludes); auto-select via `publish: true`; exclude via `publish: false` (overrides folder filters in both directions: `publish: true` beats excluded folders); **Included folders** / **Excluded folders** filters; deletions of renamed/removed files must be ticked manually; `publish.css`, `publish.js`, favicons published from the dialog even though hidden in explorer. Collaborators: **Use live version** to pull remote changes (no automatic sync between collaborators).

**Site options**

| Section | Option | Type | Notes |
|---|---|---|---|
| General | Site name | text | Title |
| | Homepage file | file | Landing page (`index-file`) |
| | Logo | image | Must be published |
| | Site collaboration | Manage | Invite by Obsidian account email; collaborators can publish new/changed/unpublish and edit content-related options (1.7), not site options/permissions |
| | Custom domain | Manage | Own domain/subdomain or subpath via proxy; required for `publish.js` and analytics |
| | Disallow search engine indexing | toggle | `robots.txt` |
| Appearance | Theme | dropdown | Light / Dark / Adapt to system |
| | Light/dark toggle | toggle | Visitor theme switch |
| Reading experience | Show hover preview | toggle | |
| | Hide page title | toggle | Inline title hidden |
| | Readable line length | toggle | |
| | Strict line breaks | toggle | |
| | Stack pages | toggle | Sliding stacked pages (Andy Matuschak style) |
| Components | Show navigation | toggle | File-tree sidebar |
| | Customize navigation | Manage | Drag reorder within folders, **Hide in navigation**, Show hidden, Restore default (alphabetical / unhide) |
| | Show search bar | toggle | Searches file names, aliases, headings first, then plain text; no embedded query support |
| | Show graph view | toggle | Local graph in right sidebar; color via CSS variables only |
| | Show table of contents | toggle | Outline |
| | Show backlinks | toggle | |
| Other | Passwords | Manage | Site-wide passwords with nicknames (no per-note passwords) |
| | Google Analytics tracking code | text | Custom domain only |

**Customization**: `publish.css` (root, custom CSS / copied community theme; Style Settings plugin not supported), `publish.js` (root, custom domain only, e.g. Plausible/Fathom/GTM/cookie banners), favicons `favicon-32x32.png`, `favicon-32.png`, `favicon.ico` (+ recommended 128/152/167/180/192/196 sizes, anywhere in vault).

**Metadata/SEO**: `permalink` (redirects old URL to slug), aliases containing full old paths act as redirects, `description` (meta/OG/Twitter), `image`/`cover` (OG image; vault path case-sensitive or URL; served only to crawlers), automatic descriptions, `/sitemap.xml`, `/rss.xml`, Google Search Console friendly.

**Rendering support**: callouts, embeds, math, mermaid, graph, backlinks, hover previews, tags; **not supported**: community-plugin code blocks (Dataview etc.), embedded `query` search, Bases (planned), per-note passwords; limited PDF on mobile; media streaming discouraged.

**Visitor privacy**: no cookies/analytics by default. Network: `publish.obsidian.md`, `publish-main.obsidian.md`, `publish-01…100.obsidian.md`.

**Headless Publish** (`npm i -g obsidian-headless`, Node 22+, open beta): `ob login [--email --password --mfa]`, `ob logout`, `ob publish-list-sites`, `ob publish-create-site --slug`, `ob publish-setup [--site] [--path]`, `ob publish [--path] [--all] [--dry-run] [--yes]` (default only `publish: true` files), `ob publish-config [--includes] [--excludes]`, `ob publish-site-options [--site-name --index-file --logo --show-navigation --show-graph --show-outline --show-search --show-backlinks --show-hover-preview --show-theme-toggle --default-theme light|dark --readable-line-length --strict-line-breaks --hide-title --sliding-window --nav-order --nav-hidden]`, `ob publish-unlink`.

CLI (desktop app) Publish commands: `publish:site`, `publish:list [total]`, `publish:status [total new changed deleted]`, `publish:add [file path changed]`, `publish:remove`, `publish:open`.

### 10.2 Obsidian Sync (paid, end-to-end encrypted)

**Plans**

| | Sync Standard | Sync Plus |
|---|---|---|
| Synced (remote) vaults | 1 | 10 |
| Max file size | 5 MB | 200 MB |
| Total storage (account-wide, incl. version history & attachments) | 1 GB | 10 GB, expandable to 100 GB |
| Version history | 1 month (attachments 2 weeks) | 12 months (attachments 2 weeks) |
| Devices | Unlimited | Unlimited |
| Shared vaults | Yes (max 20 collaborators; all need Sync; joining doesn't count toward vault limit) | Yes |

**Security**: per remote vault choose **End-to-end encryption** (default; password never stored; lost password = unrecoverable) or **Standard encryption** (Obsidian-managed key). AES-256-GCM contents, scrypt KDF with salt; file paths/hashes AES-SIV (2025-08 upgrade, migration assistant in 1.9.11). Metadata not E2E: uploading device, timestamps, path↔content mapping. Deterministic encrypted hashes for dedup. Hosts `sync-xx.obsidian.md` (DigitalOcean), regions Automatic / Asia (Singapore) / Europe (Frankfurt) / North America (San Francisco) / Oceania (Sydney), region move supported.

**Setup**: Settings → Sync → **Remote vault → Manage/Choose** (list incl. shared vaults, storage used per vault), **Create new vault** (name, encryption, region), connect with password, warning if vault already in a third-party sync folder, merge warning when connecting a non-empty vault. **Disconnect**, delete remote vault.

**Sync settings page**: Remote vault (Disconnect/Manage), **Sync status** (Pause/Resume), **Device name** (device-local; shown in logs/history), **Conflict resolution** (device-local; **Automatically merge** [default, diff-match-patch for Markdown; last-modified-wins for other files incl. canvas; JSON config merged key-wise local-over-remote] or **Create conflict file** `name (Conflicted copy <device> YYYYMMDDHHMM).md`), **Deleted files → View** (restore, bulk restore with checkboxes/Shift+click), **Storage usage** bar (≤30 min lag), **Vault size over limit → View largest files / Prune**, **Excluded folders → Manage**, **Selective sync** file types: Images, Audio, Videos, PDFs (default on), **Sync all other types** (off); **Vault configuration sync**: Main settings, Appearance, Themes and snippets, Hotkeys, Active core plugin list, Core plugin settings (default on); Active community plugin list, Installed community plugin list (default off; warning dialog since 1.13); **Settings version history → View/Restore**; **Activity log**; **Contact support** (Copy debug info, Email support). Only `data.json`, `main.js`, `styles.css`, `manifest.json` inside plugin folders are synced (1.6). Hidden files/folders (`.git`, `.vscode`…) never synced except config folder. Settings profiles by syncing multiple config folders (`.obsidian-mobile`). Some settings hot-reload (hotkeys, properties, appearance, enabled plugins' config); CSS/themes, graph config, plugin enable states need reload.

**Sync history / version history**: **Sync history** sidebar (1.7; recent synced files with editor avatars/"who last edited" on hover, **hide my changes** in shared vaults 1.8, rename before/after, context menu with full file actions, drag into editor, multi-select, delete key, search 1.13, button to open File recovery). **Version history** modal per file (file menu **Open version history**): version list with device/time, preview, **Show changes** diff (whitespace visible), **Restore**, copy. Deleted/renamed files via Deleted files. Settings file history.

**Status icon & log**: Synced (green check) / Syncing / Paused / Disconnected (red); menu Pause|Resume, Version history, Open Sync log, Deleted files, Sync settings. Activity log (non-persistent): filters All / Errors / Skipped / Merge Conflicts, search; message types General ("Connecting to server", "Connected to server. Detecting changes...", "Fully synced", "Merging conflicted file", "Rejected server change"), Error ("Out of memory"), Skipped ("Unable to download file with illegal name", too-large files 1.12), Account ("Vault limit exceeded", "Vault not found", subscription expired, not logged in), Network ("Unable to connect to server").

**Headless Sync** (`ob`, Node 22+, open beta, public 2026-02-27): `ob sync-list-remote`, `ob sync-list-local`, `ob sync-create-remote --name [--encryption standard|e2ee] [--password] [--region]`, `ob sync-setup --vault [--path] [--password] [--device-name] [--config-dir]`, `ob sync [--path] [--continuous]`, `ob sync-config [--mode bidirectional|pull-only|mirror-remote] [--conflict-strategy merge|conflict] [--file-types image,audio,video,pdf,unsupported] [--configs app,appearance,appearance-data,hotkey,core-plugin,core-plugin-data,community-plugin,community-plugin-data] [--excluded-folders] [--device-name] [--config-dir]`, `ob sync-status`, `ob sync-unlink`. Preserves birthtime on Win/macOS via native addon.

CLI (desktop app) Sync: `sync on|off`, `sync:status`, `sync:history [total]`, `sync:read version=`, `sync:restore version=`, `sync:open`, `sync:deleted [total]`.

Teams: Obsidian Commercial license, team deployment (config folder distribution, restricted mode policies), Syncing/Publishing for teams guides.

### 10.3 Obsidian Web Clipper (brief — covered by another researcher)

Free, open-source browser extension (Chrome/Chromium, Firefox incl. mobile, Safari macOS/iOS/iPadOS, Edge). Features: clip page/selection/highlights to a vault via `obsidian://new` (clipboard), **Highlighter** (highlight passages/elements, persistent), **Reader** mode, **Interpreter** (LLM prompts over page content with user-supplied API keys), **Templates** with per-site triggers (URL patterns/schema.org), **Variables** (`{{title}}`, `{{url}}`, `{{content}}`, `{{selection}}`, `{{highlights}}`, `{{published}}`, `{{author}}`, meta/schema/selector variables…), **Filters** (pipe syntax `{{date|date:"YYYY-MM-DD"}}`, dozens of string/list/date/HTML filters), **Logic** (`{% if %}`, `{% for %}`, `{% set %}`) using the **Knap** template language shared with Importer; Defuddle extraction; no telemetry. Obsidian desktop bundles `defuddle.full.js` and `turndown.js` for Web viewer "Save to vault".

### 10.4 Obsidian Importer (official community plugin, open source)

Import sources (File format dropdown):

| Source | Input | Notes |
|---|---|---|
| Notion | **Notion account** (API integration token; preserves databases + formulas → Bases) or **File import** (`.zip` HTML export; no databases) | |
| Airtable | API personal access token (`data.records:read`, `schema.bases:read`) | Each table → folder of notes + a Base recreating table & views |
| Microsoft OneNote | **Microsoft account** (OneDrive-synced notebooks you own) or **File import** (`.onepkg`, `.one`) | |
| Evernote | `.enex` | |
| Apple Notes | macOS only; grants access to `group.com.apple.notes` folder | |
| Apple Journal | Journal export (iPhone / Mac Tahoe) | |
| Google Keep | Google Takeout `.zip` | |
| Bear | `.bear2bk` (macOS backup) or `ApplicationData.zip` (iOS) | |
| Craft | Markdown export → Markdown importer | |
| Roam Research | JSON export (`.json`), optional attachments download | |
| Logseq | File-based ("Logseq OG") graph folder (`pages`, `journals`, `assets`) | Converts Logseq-specific syntax; DB graphs unsupported |
| Tomboy / Gnote | `.note` XML files/folder | |
| HTML | `.html` files or folders | |
| CSV | `.csv` | One note per row + a Base table |
| Markdown | `.md` files, folders, `.zip` | Standardize formatting, move inline tags to properties, apply template |
| Textbundle | `.textbundle`, `.textpack` | |

Community migration guides (not built in): Day One, Diaro, RemNote, Samsung Notes, TiddlyWiki, TheBrain, Ulysses, Zim, zkn3.

**Importer templates** (Knap syntax, like Web Clipper): edit default template (note name, properties, content) or load one from the vault; live preview of up to 10 samples. Variables: `{{body}}`, `{{content}}`, `{{ctime}}`, `{{date}}`/`{{time}}`, `{{importer}}` (e.g. `keep`, `html`, `notion-api`), `{{folder}}`, `{{mtime}}`, `{{noteName}}`, `{{path}}`, `{{properties}}`, `{{source}}` (`{{source["Field name"]}}`), `{{sourceId}}`, `{{title}}`, plus source fields as top-level variables. Filters (`{{ctime|date:"YYYY-MM-DD"}}`) and logic (`{% if tags %}…{% for tag in tags %}…`).

### 10.5 Obsidian CLI (desktop app controller, 1.12, installer 1.12.7+)

Enable: Settings → General → **Command line interface** (registers: macOS symlink `/usr/local/bin/obsidian` → `Obsidian.app/Contents/MacOS/obsidian-cli`; Windows `Obsidian.com` redirector + PATH; Linux copies to `~/.local/bin/obsidian`; flatpak fixed 1.13). Requires the app running (first command launches it). Communicates over a hidden socket file.

Usage: `obsidian <command> param=value flag`; `obsidian` alone opens a **TUI** (autocomplete, history, `Ctrl+R` reverse search, readline keys); `vault=<name|id>` as first arg (else cwd vault, else active); `file=<name>` (wikilink resolution) or `path=<exact path>`; `--copy` copies output; `\n`/`\t` escapes in content.

| Area | Commands |
|---|---|
| General | `help [command]`, `version`, `reload`, `restart` |
| Bases | `bases`, `base:views`, `base:create`, `base:query format=json\|csv\|tsv\|md\|paths` |
| Bookmarks | `bookmarks [total verbose format]`, `bookmark file= subpath= folder= search= url= title=` |
| Commands/hotkeys | `commands [filter=prefix]`, `command id=` (runs any command incl. plugins), `hotkeys [total verbose format]`, `hotkey id= [verbose]` |
| Daily notes | `daily [paneType]`, `daily:path`, `daily:read`, `daily:append content= [inline open]`, `daily:prepend` |
| File history | `diff [file path from to filter=local\|sync]`, `history`, `history:list`, `history:read version=`, `history:restore version=`, `history:open` |
| Files & folders | `file`, `files [folder ext total]`, `folder path= [info=files\|folders\|size]`, `folders`, `open [newtab]`, `create name\|path content template [overwrite open newtab]`, `read`, `append content [inline]`, `prepend` (after frontmatter), `move to=`, `rename name=`, `delete [permanent]` |
| Links | `backlinks [counts total format]`, `links [total]`, `unresolved [total counts verbose format]`, `orphans [total]`, `deadends [total]` |
| Outline | `outline [format=tree\|md\|json total]` |
| Plugins | `plugins [filter=core\|community versions format]`, `plugins:enabled`, `plugins:restrict on\|off`, `plugin id=`, `plugin:enable`, `plugin:disable`, `plugin:install id= [enable]`, `plugin:uninstall`, `plugin:reload` |
| Properties | `aliases [active verbose total]`, `properties [name sort=count format=yaml\|json\|tsv counts total active]`, `property:set name= value= type=text\|list\|number\|checkbox\|date\|datetime`, `property:remove`, `property:read` |
| Publish | `publish:site`, `publish:list`, `publish:status`, `publish:add`, `publish:remove`, `publish:open` |
| Random | `random [folder newtab]`, `random:read` |
| Search | `search query= [path limit format=text\|json total case]`, `search:context` (grep-style `path:line: text`), `search:open [query]` |
| Sync | `sync on\|off`, `sync:status`, `sync:history`, `sync:read`, `sync:restore`, `sync:open`, `sync:deleted` |
| Tags | `tags [sort=count counts format active]`, `tag name= [total verbose]` |
| Tasks | `tasks [file path status="<char>" done todo verbose format active daily total]`, `task ref=path:line \| file line \| daily [toggle done todo status=]` |
| Templates | `templates`, `template:read name= [title resolve]`, `template:insert name=` |
| Themes/snippets | `themes`, `theme [name]`, `theme:set`, `theme:install [enable]`, `theme:uninstall`, `snippets`, `snippets:enabled`, `snippet:enable`, `snippet:disable` |
| Unique notes | `unique [name content paneType open]` |
| Vault | `vault [info=name\|path\|files\|folders\|size]`, `vaults [total verbose]`, `vault:open` (TUI) |
| Web viewer | `web url= [newtab]` |
| Word count | `wordcount [words characters]` |
| Workspace | `workspace [ids]`, `workspaces`, `workspace:save`, `workspace:load`, `workspace:delete`, `tabs [ids]`, `tab:open [group file view]`, `recents` |
| Developer | `devtools`, `dev:debug on\|off`, `dev:cdp method= params=`, `dev:errors [clear]`, `dev:screenshot path=`, `dev:console [limit level clear]`, `dev:css selector= [prop]`, `dev:dom selector= [attr css total text inner all]`, `dev:mobile on\|off`, `eval code=` |

Plugins can register CLI handlers (`registerCliHandler`). **Obsidian Headless** (`ob`) is a separate standalone Node client for Sync/Publish (§10.1–10.2).

### 10.6 Accounts, licenses, misc

Obsidian account (email/password, 2FA), Catalyst license (early access, badges), Commercial license (optional since 2025 "free for work"), Obsidian Credit, education discount, refund policy. Community directory `community.obsidian.md` with plugin/theme listing pages, automated **Scorecard** (health: hygiene/maintenance/responsiveness/adoption; review: passed checks, disclosures like clipboard/network access), Updates tab, pricing labels Free / Optional payment / Paid, archiving. Early access versions. Sandbox vault. Help vault (the help site is itself a Publish site).

---

## 11. Mobile-specific features (iOS/iPadOS, Android)

- **Navigation bar** (bottom, when not editing): Back, Forward, **+** (new note / Quick switcher), **tab counter** (tab overview/switcher, new tab), **Menu** (ribbon actions). Setting **Floating navigation**.
- **Mobile toolbar** (above keyboard while editing): horizontally scrollable; **Configure mobile toolbar** (wrench) → Settings → Toolbar/Mobile → **Manage toolbar options**: add/remove/reorder; **Add global command** (any command). Default items (`mobileToolbarCommands`): Undo, Redo, Add internal link, Add embed, Add tag, Insert attachment, Toggle heading, Toggle bold, Toggle italic, Toggle strikethrough, Toggle highlight, Toggle code, Toggle blockquote, Toggle comment, Insert Markdown link, Toggle bullet list, Toggle numbered list, Toggle checkbox status, Indent list item, Unindent list item, Configure mobile toolbar. Other available: Toggle inline math, Toggle math block, Move caret up/down/left/right, Go to first/last line, Toggle keyboard.
- **Quick Action**: pull down from top of the app triggers a configurable command (default **Open command palette**; `mobilePullAction`); "None" disables.
- **Ribbon menu**: quick access item (short press) vs full menu (long press); Manage: reorder (drag handle), show/hide (red minus / green plus).
- **Sidebars**: swipe left/right (Sliding sidebars setting), Toggle left/right commands; word count and file info at top of right sidebar; Sync status in right sidebar.
- **Full screen** reading mode auto-hides chrome.
- **Share / import**: share files/text into Obsidian ("Import into vault", "Add text to file: …", "Insert link into …"); iOS 18+ native **Share Sheet** (1.13): Locations (New note in vault/folder, Daily note append/prepend, Bookmarked note append/prepend, existing Note, New bookmark), per-location vault/folder/template/bookmark group/position/Full Text vs URL; template placeholders `{{author}} {{description}} {{domain}} {{favicon}} {{image}} {{published}} {{published: FORMAT}} {{site}} {{title}} {{url}} {{wordCount}} {{date}} {{date: FORMAT}} {{time}} {{time: FORMAT}}`.
- **iOS**: Widgets (iOS 18+; Lock Screen/Control Center: New note, Open note, Daily note, Search, Open Obsidian; Home Screen: Create note, View note, Daily note; unavailable with "Require Face ID"), **Shortcuts app actions** (Open Bookmark, Open New Note, Open Daily Note, Capture to Daily Note, Capture to Bookmark, Get Bookmarked Note, Get Daily Note, Search Vault, Bookmark Link, Open Obsidian), Siri phrases, Spotlight quick actions, iCloud vault storage (reload prompt when config changes), Require Face ID app lock.
- **Android** (5.1+): vault in **device storage** (All-files access; works with Syncthing etc.) or **app storage** (sandboxed, deleted on uninstall); widgets (Open Note, New Note, Search, Daily Note, Open Obsidian; configurable, resizable); Quick Settings tile (7.0+); app shortcuts (Open note, Daily note; 7.1+); back button "Press back again to exit".
- Mobile-only settings: per-device Vim mode, Quick access ribbon item, toolbar config. Mobile file menus via long-press; version history, publish etc. via long-press menus. Canvas touch gestures (touch-and-hold add/move/select, drag pan, pinch zoom).
- Web viewer, pop-out windows, CLI, custom app icon, translucency: **desktop only**. Apple Lockdown Mode breaks IndexedDB unless Obsidian is exempted (reindex on each start, no Sync/File recovery).

---

## 12. Vault data layout reference (for file-format compatibility)

| Path | Contents |
|---|---|
| `<vault>/**/*.md, *.canvas, *.base, attachments` | User data (plain files; external edits auto-detected and merged) |
| `<vault>/.obsidian/app.json` | Editor + Files & links config (keys in §6.3–6.4) |
| `.obsidian/appearance.json` | `theme`, `accentColor`, `cssTheme`, `enabledCssSnippets`, fonts, `baseFontSize`, `baseFontSizeAction`, `translucency`, `nativeMenus`… |
| `.obsidian/hotkeys.json` | `{commandId: [{modifiers, key}]}` overrides |
| `.obsidian/core-plugins.json` | Enabled core plugin IDs (older: map id→bool; `core-plugins-migration.json`) |
| `.obsidian/community-plugins.json` | Enabled community plugin IDs |
| `.obsidian/plugins/<id>/` | `manifest.json`, `main.js`, `styles.css`, `data.json` |
| `.obsidian/themes/<name>/` | `theme.css`, `manifest.json` |
| `.obsidian/snippets/*.css` | CSS snippets |
| `.obsidian/types.json` | Property types `{types:{name:type}}` |
| `.obsidian/bookmarks.json` | Bookmarks tree |
| `.obsidian/graph.json` | Global graph settings |
| `.obsidian/<core-plugin-id>.json` (e.g. `daily-notes.json`, `templates.json`, `zk-prefixer.json`, `note-composer.json`, `page-preview.json`, `canvas.json`, `backlink.json`, `switcher.json`) | Core plugin options (one file per plugin id, written once options differ from defaults) |
| `.obsidian/workspace.json`, `workspace-mobile.json` | Current layout (tabs, splits, sidebars, active leaf, recent files) — not synced |
| `.obsidian/workspaces.json` | Saved workspaces |
| `<vault>/.trash/` | Obsidian trash (if selected) |
| Global app data (`~/Library/Application Support/obsidian`, `%APPDATA%\Obsidian`, `~/.config/obsidian`) | `obsidian.json` vault registry `{vaults:{<16-hex id>:{path, ts, open}}}`, per-vault `<id>.json` window state, IndexedDB (metadata cache, File recovery snapshots, Sync state), installer `obsidian-<ver>.asar` |

Browser-first clone implications: File System Access API / OPFS for the vault folder; IndexedDB for metadata cache & snapshots; keep `.obsidian` JSON formats identical for round-trip with desktop Obsidian.

---

## 13. Implementation priority

Priority reflects what an Obsidian user expects on day one of a faithful clone, then depth, then long tail. "Browser-first" constraints (no Electron webview, no native menus, no OS trash) are noted.

### P0 — table stakes (a user switching from Obsidian would leave without these)

1. **Vault = local folder** (File System Access API + OPFS fallback), plain `.md` round-trip, external change detection, auto-save, `.obsidian` config read/write compatible with desktop (`app.json`, `appearance.json`, `hotkeys.json`, `core-plugins.json`, `types.json`, `bookmarks.json`, `workspace.json`).
2. **Markdown engine**: CommonMark + GFM (tables, strikethrough, task lists, autolinks, footnotes), highlights, comments, callouts (all 13 types + aliases, foldable, nested, custom CSS types), math (KaTeX/Temml), Mermaid (with trust gate), sanitized HTML, Strict line breaks setting, escaping, Prism code highlighting.
3. **Internal links**: wikilinks + Markdown links, heading/block/subheading links, display text, aliases, unresolved links + click-to-create, link resolution by shortest path, **rename/move updates links** (files, headings, block IDs), New link format setting.
4. **Embeds**: notes, headings, blocks, images (with `|W` / `|WxH` sizing), audio, video, PDF (`#page=`, `#height=`), external images/YouTube.
5. **Editor** (CodeMirror 6): **Live Preview**, **Source mode**, **Reading view**, `Mod+E` toggle; autocomplete for `[[`, `![[`, `#`, `#^`, `|`, `[^`; smart lists, auto-pair brackets/Markdown, Tab indent, folding (headings/indent), multiple cursors, find/replace in file, paste/drag images → attachment folder, HTML→Markdown paste, inline title, readable line length, spellcheck, undo/redo, all formatting commands (§8.2 Editor list) with default hotkeys (§8.1).
6. **Properties**: YAML frontmatter editor with all types (text, list, number, checkbox, date, datetime, tags, aliases, cssclasses), vault-wide type registry (`types.json`), Properties in document (visible/hidden/source), property keyboard navigation, links in properties.
7. **Tags**: inline + frontmatter, nested, validation rules, Tags view.
8. **Workspace**: left/right sidebars with tabs, main area tabs + splits (right/down), drag tabs, tab context menu, pinned tabs, back/forward history, status bar, ribbon, empty tab state.
9. **File explorer**: create/rename/move/delete/duplicate, drag-and-drop, multi-select, sort orders, auto-reveal, context menus, trash behaviour (vault `.trash` / permanent; no OS trash in browser).
10. **Quick switcher** (`Mod+O`, fuzzy, aliases, create-on-enter, Shift+Enter, recent files) and **Command palette** (`Mod+P`, fuzzy, recents, pinned commands).
11. **Search** plugin with the full operator language (§3.21), regex, property search, sort, explain, copy results, embedded `query` blocks.
12. **Backlinks** (linked + unlinked mentions with Link button, backlinks in document) and **Outgoing links**; **Outline** (with drag-to-reorder).
13. **Settings UI** for Editor, Files & links, Appearance (light/dark/system, accent color, fonts, font size, CSS snippets), Hotkeys editor, Core plugins toggles.
14. **Page preview** (hover with Mod in editor), **Templates** (`{{title}}`, `{{date[:fmt]}}`, `{{time[:fmt]}}`, property merge), **Daily notes** (format, folder, template, prev/next), **Bookmarks** (files, folders, headings, blocks, searches, groups).
15. **Metadata cache** in IndexedDB (links, embeds, headings, blocks, tags, frontmatter, sections, list items/tasks) + Rebuild cache; excluded files setting.

### P1 — core differentiators and depth (needed to be called "an Obsidian clone")

1. **Graph view** (global + local, filters, groups, display, forces with exact ranges/defaults, timelapse animation, depth/neighbor/incoming/outgoing for local).
2. **Canvas** with JSON Canvas 1.0 round-trip: text/file/link/group nodes, edges with sides/ends/labels/colors, selection, snapping, align/distribute/arrange, groups with backgrounds, zoom controls & shortcuts, convert card to file, narrow to heading/block, export PNG, canvas settings, canvas backlinks/search integration.
3. **Bases**: `.base` parser + ```` ```base ```` blocks, full expression language and **every function in §4.5**, global/view filters (simple builder + advanced editor with the verified operator list), formulas, properties display names, sort, group by, limit, summaries (built-in + custom), **Table** (inline editing, keyboard nav, selection, copy/paste, undo, row heights, column resize), **Cards**, **List**, `this` context, embeds with `#View`, CSV export, copy to clipboard, New item (folder/template), search toolbar.
4. **Properties view** (All properties with rename/merge/delete/type, File properties sidebar).
5. **Note composer** (merge, extract selection, extract heading, link/embed/none replacement, template vars).
6. **File recovery** (IndexedDB snapshots, interval/retention, diff, restore).
7. **Linked views**, **stacked tabs**, **Workspaces** save/load, **Unique note creator**, **Random note**, **Slash commands**, **Word count** (CJK-aware, selection), **Footnotes view**, **Tags view** options, **Format converter**.
8. **Obsidian URI** equivalent: handle `open/new/daily/unique/search` via a web route/protocol handler (`web+obsidian:` / app URLs) with `x-success`, plus Copy URL command.
9. **Live Preview table editor** and image lightbox/resize handles; PDF viewer with selection-link copy; Export to PDF (print CSS).
10. **Community plugin compatibility layer** (subset of `obsidian` API: `Plugin`, `addCommand`, `registerView`, `MarkdownPostProcessor`, `Vault`, `MetadataCache`, `Workspace`, settings tabs), **themes** (CSS variables parity so community themes/snippets work), Restricted mode + trust dialog.
11. **Vim key bindings** (codemirror-vim), RTL, Mermaid internal links, Mod-click open modes (new tab / split / window→new browser tab).
12. **Importer**-equivalent for Markdown folders/zip, Notion zip, Evernote enex, CSV→Base, HTML.

### P2 — long tail / service parity / platform extras

1. **Kanban** (1.14) and **Map** Bases layouts; collapsible groups; colored highlights (1.14).
2. **Slides** presentation mode; **Audio recorder** (MediaRecorder).
3. **Sync-like service** (E2EE, version history, selective sync, conflict merge via diff-match-patch, sync history sidebar, shared vaults) — or pluggable sync (Git, WebDAV, CRDT); settings profiles via config-folder override.
4. **Publish-like static site export** (navigation customisation, graph, backlinks, search, hover preview, stacked pages, permalinks/alias redirects, OG metadata, sitemap/RSS, `publish.css`/`publish.js`, passwords).
5. **Web viewer** equivalent (limited in browsers: iframe + reader mode via Defuddle/Readability, save page to vault, web history, bookmarks for URLs).
6. **CLI/Headless** equivalents (Node CLI operating on the vault + a local socket/API to a running tab), `eval`/dev tooling.
7. **Importer** API-based sources (Notion API, Airtable, OneNote account, Apple Notes/Journal, Google Keep Takeout, Bear, Roam JSON, Logseq, Tomboy/Gnote, Textbundle) and Knap template language.
8. **Mobile** PWA: navigation bar, configurable mobile toolbar, pull-down Quick Action, share target (Web Share Target API), widgets/shortcuts where platform permits.
9. **Web Clipper** integration (accept `obsidian://new`-style payloads), Keychain secret storage, startup diagnostics, sandbox vault, release-notes viewer, community directory scorecards, custom app icon, translucency/native menus/window frame (desktop-shell only).
10. Accounts/licensing, early-access channel, multi-window pop-outs (browser windows sharing one vault via BroadcastChannel).

