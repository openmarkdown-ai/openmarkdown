# OpenObsidian — Web Clipper, HTML→Markdown, browser filesystem, Markdown engines

Researched 2026-09-13. Sources:

- **Clipper:** `obsidianmd/obsidian-clipper` cloned at `a9d33ce` (v1.7.1, 2026-09-03), plus its `docs/` folder, which is the source of help.obsidian.md/web-clipper/*.
- **Template engine:** `knap` (npm) at the version the clipper pins (0.2.3) and at latest (0.5.0).
- **Defuddle:** 0.19.3.
- **Browser support:** `@mdn/browser-compat-data` 8.1.1 (2026-09-10).
- **Rust crates:** crates.io API. Every Rust crate named in §2 and §4 was **compiled to `wasm32-unknown-unknown` on this machine** (rustc/cargo 1.98, `opt-level="z"`, LTO, `panic=abort`, then `wasm-opt -Oz`) and executed under Node.
- **Markdown engines:** the three Rust engines were each run on the same Obsidian-flavoured sample (§4.2).

---

## 1. Obsidian Web Clipper: complete feature inventory

**Repo:** [obsidianmd/obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper), **MIT**, 5,186★, TypeScript, MV3.

**Stores:** Chrome, Firefox (desktop and Android), Safari (macOS/iOS/iPadOS), Edge. **36 UI locales.** Requires Obsidian ≥ 1.7.2 for the URI features it uses.

**Runtime dependencies** (package.json): `defuddle ^0.19.2` (content extraction and HTML→MD), `knap ^0.2.3` (template language, filters, logic; **MIT**, obsidianmd/knap, 473★, split out of the clipper in Aug 2026 and shared with Obsidian Importer), `dayjs`, `dompurify`, `highlight.js`, `linkedom` (CLI/API only), `lucide`, `lz-string`.

The same repo also publishes an **npm CLI and library** (`obsidian-clipper` bin, `obsidian-clipper/api` with `clip()` and `matchTemplate()`). It runs Defuddle over linkedom, with no browser needed.

### 1.1 Surfaces and modes

| Surface | Details |
|---|---|
| Popup | Default `openBehavior: 'popup'` |
| Embedded | Clipper iframe injected into the page (`openBehavior: 'embedded'`, context menu "open embedded") |
| Side panel | Chrome only (`sidePanel` permission, context menu "Open side panel") |
| **Reader mode** | Defuddle-cleaned reading view of the current page or a standalone `reader.html`. Settings: font size, line height, max width, light/dark theme, appearance auto/light/dark, fonts list, default font, blend images, color links, follow links, pin player, auto-scroll, highlight active line, custom CSS. Has a mobile outline overlay and a transcript/player pin for video. Toggle: Alt+Shift+R |
| **Highlighter mode** | Highlight text, images, video and audio elements. Stored per URL as `{id, xpath, content, notes[] (annotations), groupId, type:'text', startOffset…}` plus surrounding-text context to disambiguate. Options: "always show highlights", export highlights to `.json`. `highlightBehavior` is `highlight-inline` (wraps as `==text==` inside `{{content}}`), `replace-content` (content becomes the highlight list) or `no-highlights` |
| **Interpreter** | LLM post-processing of `{{"prompt"}}` variables (§1.5) |
| Context menu | "Save this page", "Copy to clipboard", Enter/Exit reader, Enter/Exit highlighter, "Add to highlights" (selection / image / video / audio), "Open embedded", "Open side panel" (Chrome) |
| Save behaviours | `addToObsidian`, `saveFile` (download .md), `copyToClipboard`, plus "share". A local history of `{datetime, url, action, title, vault, path}` and usage stats are kept in extension storage |

Content precedence when the popup opens: **custom template for the site → selection (Cmd/Ctrl+A selects all) → highlights → Defuddle main content.** Images are not downloaded; they stay remote URLs. Obsidian's "Download attachments for current file" command localises them afterwards.

### 1.2 Keyboard shortcuts (manifest `commands`)

| Command | macOS | Win/Linux |
|---|---|---|
| Open clipper (`_execute_action`) | Cmd+Shift+O | Ctrl+Shift+O |
| Quick clip (`quick_clip`, no UI) | Alt/Opt+Shift+O | Alt+Shift+O |
| Toggle highlighter | Alt/Opt+Shift+H | Alt+Shift+H |
| Toggle reader | Alt/Opt+Shift+R | Alt+Shift+R |

Shortcuts are remappable in every browser except Safari. MV3 permissions: `activeTab, clipboardWrite, commands, contextMenus, sidePanel, storage, scripting, declarativeNetRequest`, host `<all_urls>`.

### 1.3 Templates

`Template` interface (`src/types/types.ts`):

| Field | Meaning |
|---|---|
| `id`, `name` | |
| `behavior` | `create` · `append-specific` · `prepend-specific` · `append-daily` · `prepend-daily` · `overwrite` (the UI shows "Create new note", "Add to existing note top/bottom", "Add to daily note top/bottom" and overwrite) |
| `noteNameFormat` | Note name, templated (e.g. `{{title}}`), sanitised with `safe_name` rules |
| `path` | Note location/folder, templated |
| `vault` | Target vault name, which must match the vault *name*, not its path. Falls back to the global `vaults[]` list |
| `properties[]` | `{id, name, value (templated), type}`. The type comes from the global `propertyTypes[]` (`{name, type, defaultValue}`); types are Obsidian property types: text, multitext, number, checkbox, date, datetime |
| `noteContentFormat` | Body template: variables, filters and logic |
| `triggers[]` | One rule per line; the first matching template in list order wins, and the list is drag-sortable. **Prefix match:** `https://obsidian.md`. **Regex:** `/^https:\/\/www\.imdb\.com\/title\/tt\d+\/reference\/?$/`. **Schema.org:** `schema:@Recipe`, `schema:@Recipe.name`, `schema:@Recipe.name=Cookie` |
| `context` | Interpreter context override, e.g. `{{selectorHtml:#main}}` |

**Import/export JSON** (`schemaVersion "0.1.0"`, filename `<name>-clipper.json`; import by button or drag-drop of several files; export via download or copy-to-clipboard):

```json
{
  "schemaVersion": "0.1.0",
  "name": "Recipe",
  "behavior": "create",
  "noteContentFormat": "{{content}}",
  "properties": [{ "name": "source", "value": "{{url}}", "type": "text" }],
  "triggers": ["schema:@Recipe"],
  "noteNameFormat": "{{title}}",
  "path": "Clippings/",
  "context": "{{selectorHtml:article}}"
}
```

`noteNameFormat` and `path` are omitted for daily-note behaviours, and `context` only appears when set. Full settings can also be exported and imported, with lz-string compression. Community template packs to stay compatible with: [kepano/clipper-templates](https://github.com/kepano/clipper-templates) (1,448★) and [community-archive/web-clipper-templates](https://github.com/community-archive/web-clipper-templates) (845★).

**Global settings** (`Settings`): `vaults[]`, `showMoreActionsButton`, `betaFeatures`, `legacyMode`, `silentOpen`, `openBehavior`, `highlighterEnabled`, `alwaysShowHighlights`, `highlightBehavior`, `interpreterEnabled`, `interpreterAutoRun`, `interpreterModel`, `defaultPromptContext`, `models[]` (`{id, providerId, providerModelId, name, enabled}`), `providers[]` (`{id, name, baseUrl, apiKey, apiKeyRequired, presetId}`), `propertyTypes[]`, `readerSettings`, `saveBehavior`, `history[]`, `stats`, `ratings[]`.

### 1.4 Variables: the complete list

**Preset variables** (`buildVariables()` in `src/utils/shared.ts`):

| Variable | Value |
|---|---|
| `{{author}}` | Defuddle author |
| `{{content}}` | Main content, or highlights or selection, **as Markdown** |
| `{{contentHtml}}` | Same, as HTML |
| `{{selection}}` / `{{selectionHtml}}` | Selection as MD / HTML |
| `{{date}}` / `{{time}}` | Current timestamp `YYYY-MM-DDTHH:mm:ssZ` (both the same; format with `date`) |
| `{{description}}` | Description/excerpt |
| `{{domain}}` | Hostname |
| `{{favicon}}` | Favicon URL |
| `{{fullHtml}}` | Unprocessed full-page HTML |
| `{{highlights}}` | Array of highlights with text and timestamps (e.g. `{{highlights\|map: item => item.text\|join:"\n\n"}}`) |
| `{{image}}` | Social share image |
| `{{noteName}}` | Sanitised title (undocumented) |
| `{{published}}` | Published date (first value if comma-separated) |
| `{{site}}` | Site name/publisher |
| `{{title}}` | Title |
| `{{url}}` | URL with any `#:~:text=` fragment stripped |
| `{{language}}` | BCP-47 page language (undocumented) |
| `{{words}}` | Word count |
| `{{transcript}}` and other extractor vars | Any key Defuddle's site extractors return in `result.variables` becomes `{{key}}` (e.g. YouTube transcript) |
| `{{model}}`, `{{modelId}}`, `{{modelProvider}}` | Interpreter model info, resolved after Interpreter runs (undocumented) |

**Meta variables:** `{{meta:name:<name>}}` (e.g. `{{meta:name:description}}`) and `{{meta:property:<prop>}}` (e.g. `{{meta:property:og:title}}`).

**Selector variables:** `{{selector:<css>}}` returns text content, and `{{selector:<css>?<attr>}}` returns an attribute (e.g. `{{selector:img.hero?src}}`). `{{selectorHtml:<css>}}` returns outer HTML. Several matches give an array. Selectors also work in logic: `{% for c in selector:.comment %}`, `{% if selector:.premium-badge %}`, `{% set items = selector:.list-item %}`.

**Schema.org variables:** `{{schema:@Type:key}}`, `{{schema:@Type:parent.child}}`, `{{schema:@Type:arr}}` (first item), `{{schema:@Type:arr[0].prop}}`, `{{schema:@Type:arr[*].prop}}` (all). Shorthand without a type: `{{schema:author}}`, `{{schema:author.name}}`, `{{schema:author[*].name}}`.

**Prompt variables:** `{{"a summary of the page"}}`, optionally with filters: `{{"…"|blockquote}}`. The regex also accepts `{{prompt:"…"}}`. All prompts in a template go to the model in **one** request, and they are substituted only after template logic has run, so prompt results cannot feed `if`/`for`.

**Expression syntax** (knap): `{{ a.b }}`, `{{ a[0].b }}`, `{{ m["a:b"] }}`, names containing spaces, `{{ x ?? y ?? "fallback" }}` (filters bind tighter than `??`), whitespace control `{{- x -}}` and `{%- … -%}`, comments `{# … #}`.

### 1.5 Interpreter (LLM)

- **Preset providers:** Anthropic, Azure OpenAI, DeepSeek, Google Gemini, Hugging Face, Meta (Llama API), **Ollama** (no key; requires `OLLAMA_ORIGINS=moz-extension://*,chrome-extension://*,safari-web-extension://* ollama serve`), OpenAI, OpenRouter, Perplexity, xAI Grok.
- **Custom providers:** any OpenAI-compatible `…/chat/completions` base URL.
- **Context:** defaults to the whole page HTML, overridable globally (`defaultPromptContext`) or per template (`context`). `remove_html`, `strip_tags` and `strip_attr` exist to shrink it.
- **Run mode:** manual "interpret" button, or `interpreterAutoRun`.
- **Guidance:** the docs recommend small models (Haiku, Gemini Flash, 3–8B Llama, OpenAI mini). Ollama's default 2,048-token context silently truncates.

### 1.6 Logic (knap tags)

- **Tags:** `{% if %}` / `{% elseif %}` / `{% else %}` / `{% endif %}`, `{% for x in arr %}…{% endfor %}` (nestable), and `{% set name = expr|filters %}`.
- **Operators:** `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains` (substring or array membership), `and`/`&&`, `or`/`||`, `not`/`!`, parentheses.
- **Falsy values:** `false`, `null`, `undefined`, `""`, `0`, `[]`.
- **Loop variables:** `loop.index`, `loop.index0`, `loop.first`, `loop.last`, `loop.length`, plus legacy `<item>_index`.
- **Indexing:** `arr[loop.index0]`, `obj["key"]`.
- **Evaluation order:** logic and variables first, then prompts.
- **Safety:** knap is an AST interpreter with no `eval`. Standalone tag lines are removed from output.

### 1.7 Filters: exhaustive list

**Shipping Web Clipper 1.7.1** (knap 0.2.3 `standardFilters` 50 + `htmlFilters` 2 + clipper `markdown` = **53**):

| Group | Filters (params) |
|---|---|
| Dates | `date:"fmt"` / `date:("out","in")` (dayjs) · `date_modify:"+1 year"` · `duration` / `duration:"HH:mm:ss"` (ISO 8601 or seconds) |
| Text case | `camel` · `capitalize` · `kebab` · `lower` · `pascal` · `snake` · `title` · `uncamel` · `upper` · `trim` · `decode_uri` · `unescape` · `safe_name` / `safe_name:windows\|mac\|linux` |
| Replace | `replace:"a":"b"` · `replace:("a":"b","c":"d")` · regex `replace:"/[aeiou]/g":"*"` (flags g i m s u y; escape `: \| { } ( ) ' "`) |
| Markdown formatting | `blockquote` · `callout:("type","title",foldState)` · `footnote` (array to `[^1]:`, object to `[^slug]:`) · `fragment_link` / `fragment_link:"title"` (text-fragment URL appended; clipper injects the page URL) · `image:"alt"` · `link:"text"` · `list` / `list:task` / `list:numbered` / `list:numbered-task` · `table` / `table:("Col1","Col2")` · `wikilink` / `wikilink:"alias"` |
| Numbers | `calc:"+10"` (`+ - * / **` or `^`) · `length` · `number_format` · `round` / `round:2` |
| HTML | `markdown` (Defuddle `createMarkdownContent`, OFM output, base URL = page) · `remove_attr:("class,style")` · `remove_html:("img,.cls,#id")` (removes elements *and* content; DOM-dependent) · `remove_tags:("a,em")` · `replace_tags:"strong":"h2"` · `strip_attr` / `strip_attr:("class, id")` (keep list) · `strip_md` (alias `stripmd`) · `strip_tags` / `strip_tags:("p,strong")` (keep list) · `html_to_json` (DOM-dependent) |
| Arrays/objects | `first` · `last` · `join` / `join:"\n"` · `map:item => item.prop` / `map:item => ({k: item.v})` / `map:item => "genres/${item}"` · `merge:("c","d")` · `nth:3` / `nth:3n` / `nth:n+3` / `nth:1,2,3:5` · `object:array\|keys\|values` · `reverse` · `slice:1,4` (negative OK) · `split:","` / `split:[0-9]` (regex) · `template:"${a} ${b.c}"` (`${str}` for strings) · `unique` · `yaml` |

**Added in knap 0.5.0** (latest, 2026-09-13; documented on the website but not yet in the shipping clipper, which pins 0.2.3). There are **30 more**, for 80 standard filters:
`bold`, `code`, `code_block`, `comment`, `compact`, `embed` (`![[…]]`), `encode_uri`, `escape_md`, `h1`–`h6`, `hard_break`, `highlight` (`==…==`), `hr`, `indent`, `italic`, `math`, `math_block`, `parse_json`, `sort`, `strike`, `sum`, `table_pretty`, `truncate:(100,"…")`, `truncatewords`, `where` (filter array by property), `yaml_property`.

**Filter notes:**

- Every filter named in the brief exists.
- `markdown` is a clipper *host* filter backed by Defuddle, not a knap standard filter.
- `html_to_json` and `remove_html` need a DOM, so they are unavailable in knap's CLI.
- `truncate` appears in the Logic docs but is only in knap ≥0.5, not in the shipping 0.2.3.
- Embeds (`embed`) have no filter before 0.5.

**Implication.** Re-implementing knap in Rust is possible (it is an AST interpreter plus about 82 filters with dayjs semantics). Using the MIT `knap` package directly is cheaper and guarantees template compatibility.

### 1.8 Handoff to Obsidian (`src/utils/obsidian-note-creator.ts`)

1. **Build the URI.** Daily note: `obsidian://daily?`. Otherwise `obsidian://new?file=<encodeURIComponent(path/ + safeName)>`. Then append `&append=true`, `&prepend=true` or `&overwrite=true`, then `&vault=<name>`, and `&silent=true` if `silentOpen` is set.
2. **Default (clipboard mode).** Write the full note (frontmatter from typed properties, then body) to the clipboard, then open `…&clipboard&content=<error text>`. Obsidian reads the clipboard; the `content` parameter is only a fallback message shown when Obsidian cannot read it (Linux/Wayland).
3. **If every clipboard method fails**, or in **Legacy mode**, put the content directly in the URI: `&content=<encoded note>`. Length is limited by the browser and OS.
4. **CLI path** (`src/utils/cli-utils.ts`): when an `obsidian` CLI is on PATH, the Node CLI shells out to it (`obsidian version`, then create or append). Otherwise it falls back to `open obsidian://…`.

**What OpenObsidian needs instead** (a browser app has no registered `obsidian://` handler):

- **(a)** Extension to app over `externally_connectable` / `runtime.sendMessage` to a known origin, or to an open app tab via `chrome.tabs` + `postMessage`.
- **(b)** A `web+openobsidian://new?…` scheme through `navigator.registerProtocolHandler`, keeping the same query shape so existing templates and URIs keep working.
- **(c)** Clipboard handoff, as today.
- **(d)** Writing the file directly into the vault through the app's service worker, with a BroadcastChannel to the app.

---

## 2. HTML → Markdown and content extraction

### 2.1 Defuddle

- **Repo:** [kepano/defuddle](https://github.com/kepano/defuddle), **MIT**, 9,382★, Show HN 418 pts ([HN](https://news.ycombinator.com/item?id=44067409)). npm 0.19.3, unpacked 2.7 MB, marked "very much a work in progress".
- **What it does:** a Readability replacement that is more forgiving. It uses the page's **mobile CSS** to guess clutter, removes hidden and low-scoring elements, standardises footnotes, code blocks (language kept), math (MathJax/KaTeX to MathML with `data-latex`), headings (first H1 that matches the title removed, H1 demoted to H2) and callouts (GitHub alerts, Obsidian Publish, `aside.callout-*`, Bootstrap alerts, all to Obsidian callouts). It extracts schema.org, meta tags, favicon, image, language and word count.
- **Site extractors (27):** bbcode-data, bilibili, bluesky, c2-wiki, **chatgpt, claude, gemini, grok** (conversations), discourse, github, gmail, hackernews, leetcode, linkedin, lwn, mastodon, medium, nytimes, reddit, substack, threads, twitter, x-article, x-oembed, wikipedia, youtube (transcripts).
- **API:** `new Defuddle(document, {url, markdown, separateMarkdown, debug, removeExactSelectors, removePartialSelectors, removeHiddenElements, removeLowScoring, removeSmallImages, removeImages, standardize, contentSelector, useAsync, language, includeReplies}).parse()` or `parseAsync()`. It returns `{author, content, contentMarkdown?, description, domain, favicon, image, language, metaTags, parseTime, published, site, schemaOrgData, title, wordCount, variables, debug}`.
- **Bundles:**

  | Bundle | Raw | gzip | Notes |
  |---|---|---|---|
  | `defuddle` (core, browser) | 335 KB | 91 KB | No dependencies |
  | `defuddle/full` | 761 KB | 209 KB | Adds `mathml-to-latex`, `temml` and Markdown conversion (uses **Turndown** internally) |
  | `defuddle/node` | — | — | Accepts any DOM `Document` (linkedom, JSDOM, happy-dom) |

  There is also a CLI: `npx defuddle parse <url|file> --markdown --json`.
- **Third-party network:** `parseAsync` may call the FxTwitter API when the local HTML is empty (X articles). `useAsync:false` disables it.
- **Worker / no DOM:** Defuddle **needs a DOM `Document`**. In a Web Worker there is no `DOMParser`, so pair it with linkedom (ISC, 910 KB unpacked). It calls `getComputedStyle` (in `defuddle.js`, `standardize.js`, `utils.js`), so the mobile-style and hidden-element heuristics **degrade without a live, styled DOM**. The best fidelity is in a content script on the live page, which is exactly where the clipper runs it.
- **Measured here** (Node 26, linkedom, cold, markdown on): stephango.com/saw (11 KB HTML) 260 ms; LWN article (29 KB) 90 ms; Wikipedia "Rust (programming language)" (1.02 MB) **2,808 ms**, producing 130,517 chars and 11,179 words. linkedom and cold JIT dominate these times; in-page on a native DOM it is much faster.

### 2.2 JS alternatives

| Library | Version | Licence | Role | Notes |
|---|---|---|---|---|
| [@mozilla/readability](https://github.com/mozilla/readability) | 0.6.0 (2025-03) | Apache-2.0 | Main-content extraction | Needs a DOM; slower release cadence; no OFM standardisation. 11.4k★ |
| [turndown](https://github.com/mixmark-io/turndown) | 7.2.4 (2026-04) | MIT | HTML→MD | Needs a DOM (browser) or domino; `turndown-plugin-gfm` 1.0.2 (2022) for tables. 11.4k★ |
| [linkedom](https://github.com/WebReflection/linkedom) | 0.18.13 | ISC | Lightweight DOM for workers/Node | Used by the clipper CLI |

### 2.3 Rust crates (crates.io 2026-09-13), all compiled to wasm32 and executed

Each crate was wrapped in a minimal `cdylib` export with **zero wasm imports** (no wasm-bindgen glue counted), built `opt-level=z` + LTO + `panic=abort` + `strip`, run through `wasm-opt -Oz`, then executed in Node on real pages.

| Crate | Version (updated) | Licence | What | Builds for wasm32-unknown-unknown | wasm (opt) | gzip | brotli | Wikipedia 1 MB | Notes |
|---|---|---|---|---|---|---|---|---|---|
| [htmd](https://github.com/letmutex/htmd) | 0.5.5 (2026-07) | Apache-2.0 | HTML→MD, turndown port; passes turndown's test suite, tables, custom handlers, "faithful mode" | ✅ | 485 KB | 201 KB | 165 KB | 274 ms | html5ever-only dependency; 2.9M recent downloads |
| [dom_smoothie](https://github.com/niklak/dom_smoothie) | 0.18.1 (2026-09) | MIT | readability.js port, `TextMode::Markdown`, parse policies | ✅ | 764 KB | 329 KB | 269 KB | 410 ms | Built on dom_query/html5ever |
| **dom_smoothie + htmd** (combined) | | | Readability → MD pipeline | ✅ | **925 KB** | **389 KB** | **307 KB** | 559 ms | html5ever shared |
| [readability](https://github.com/kumabook/readability) | 0.3.0 (**2023-12**) | MIT | Old readability port | ✅ (default-features off) | 1,344 KB | 513 KB | 384 KB | — | Stale, heavy |
| [fast_html2md](https://github.com/spider-rs/html2md) (lib `html2md`) | 0.0.63 (2026-09) | MIT | HTML→MD (spider-rs) | ✅ (`scraper` feature) | 1,613 KB | 686 KB | 517 KB | — | Largest |
| [html2md](https://gitlab.com/Kanedias/html2md) | 0.2.17 | **GPL-3.0+** ⚠️ | HTML→MD | not tested | — | — | — | — | **Avoid: GPL** |
| [html-to-markdown-rs](https://github.com/xberg-io/html-to-markdown) | 3.12.4 | MIT | HTML→MD | not tested (1 MB crate) | — | — | — | — | Large |
| [llm_readability](https://github.com/spider-rs/llm-readability) | 0.0.17 | MIT | Readability for LLM | not tested | | | | | |
| [lol_html](https://github.com/cloudflare/lol-html) | 3.0.1 (2026-07) | BSD-3-Clause | Streaming HTML **rewriter** (CSS-selector handlers, no tree) | ✅ | 376 KB | 216 KB | 179 KB | — | Good for sanitising or stripping, not for readability |
| [scraper](https://github.com/rust-scraper/scraper) | 0.27.0 | ISC | html5ever DOM + CSS selectors | ✅ | 499 KB | 208 KB | 170 KB | — | Enough for `{{selector:…}}` outside a browser |
| [html5ever](https://github.com/servo/html5ever) | 0.40.0 (2026-09) | MIT/Apache-2.0 | Spec-compliant HTML5 parser | ✅ (via the above) | — | — | — | — | Foundation of everything above |

The Node harness passed ✅ runs for every row marked ✅. Output sanity on the LWN page: dom_smoothie+htmd produced 10,349 chars of Markdown; Defuddle produced 10,053.

### 2.4 Recommendation: Rust vs JS for clipping

Split by where the HTML comes from:

1. **Browser extension (clipping a live page): keep JS Defuddle + knap. Fork the MIT obsidian-clipper.**
   - Defuddle's quality comes from the live, styled DOM (`getComputedStyle`, mobile CSS), and from 27 site extractors and OFM standardisation (callouts, footnotes, math with `data-latex`) that no Rust crate reproduces.
   - A Rust/wasm port would lose the computed-style signals and would still need the DOM passed across the boundary.
   - Forking keeps **template-JSON compatibility** (schemaVersion 0.1.0, all 53 filters, logic, Interpreter) for free.
   - What changes is the handoff (§1.8) and the product name. MIT permits both.
2. **In-app "paste HTML" / drag-dropped `.html` / clipboard `text/html` → Markdown, inside the wasm core:** use **`htmd`** (Apache-2.0, 165 KB brotli, 274 ms for a 1 MB page). No readability pass is needed for pasted fragments. Add Obsidian-specific handlers (callout `div`s, `mark`→`==`, MathML `data-latex`→`$…$`) as htmd custom handlers.
3. **In-app "import URL" without the extension:** the web app **cannot fetch arbitrary pages because of CORS**. It needs the extension, a user-run proxy, or pasted HTML. For HTML it does obtain, prefer **Defuddle over linkedom in a Worker** for parity with the clipper's output. Fall back to **`dom_smoothie` + `htmd`** (307 KB brotli, all Rust, MIT/Apache) when keeping the JS bundle small matters more than extractor coverage.
4. **Avoid:** `html2md` (GPL-3.0+), `readability` 0.3 (stale since 2023), `fast_html2md` (1.6 MB).

---

## 3. Browser filesystem for a local vault

### 3.1 Support matrix (MDN BCD 8.1.1, 2026-09-10)

Values are the first supporting version; ❌ means not supported.

| API | Chrome | Edge | Firefox | Safari macOS | Safari iOS | Chrome Android | Status |
|---|---|---|---|---|---|---|---|
| `showDirectoryPicker()` / `showOpenFilePicker()` / `showSaveFilePicker()` | 86 | 86 | ❌ | ❌ | ❌ | **132** | Experimental, WICG |
| `FileSystemHandle.queryPermission()` / `requestPermission()` | 86 | 86 | ❌ | ❌ | ❌ | 109 | Experimental |
| `FileSystemDirectoryHandle` (+ `values()`/`entries()`/`getFileHandle`/`getDirectoryHandle`/`removeEntry`/`resolve`) | 86 | 86 | 111 | 15.2 | 15.2 | 109 | Standard (WHATWG FS) |
| `FileSystemFileHandle.createWritable()` / `FileSystemWritableFileStream` | 86 | 86 | 111 | **26** | **26** | 109 | Standard |
| `FileSystemFileHandle.createSyncAccessHandle()` (worker only) | 102 | 102 | 111 | 15.2 | 15.2 | 109 | Standard, OPFS only |
| `navigator.storage.getDirectory()` (**OPFS**) | 86 | 86 | 111 | 15.2 | 15.2 | 109 | Standard |
| `FileSystemHandle.move()` | 102 (partial) | 102 (partial) | 111 | 15.2 | 15.2 | 109 | Non-standard |
| `FileSystemHandle.remove()` | 110 | 110 | ❌ | ❌ | ❌ | 110 | Experimental, non-standard |
| `FileSystemHandle.isSameEntry()` | 86 | 86 | 111 | 15.2 | 15.2 | 109 | Standard |
| **`FileSystemObserver`** | **133** (desktop) | 133 | ❌ | ❌ | ❌ | ❌ | Experimental; shipped desktop Chrome 133 after an origin trial (129–134) ([blink-dev I2S](https://groups.google.com/a/chromium.org/g/blink-dev/c/6oOaFmia2dc), [proposal](https://github.com/whatwg/fs/blob/main/proposals/FileSystemObserver.md)) |
| `DataTransferItem.getAsFileSystemHandle()` (drag-drop a folder, writable handle) | 86 | 86 | ❌ | ❌ | ❌ | 132 | Experimental |
| `DataTransferItem.webkitGetAsEntry()` (drag-drop, read-only entries) | 13 | 14 | 50 | 11.1 | 11.3 | 18 | Widely supported |
| `<input type=file webkitdirectory>` (read-only folder import) | 7 | 13 | 50 | 11.1 | **18.4** | 132 | Widely supported |
| `navigator.storage.persist()` | 55 | 79 | 57 | 15.2 | 15.2 | 55 | Standard |
| `navigator.storage.estimate()` | 61 | 79 | 57 | 17 | 17 | 61 | Standard |
| `StorageBucketManager` | 122 | 122 | ❌ | ❌ | ❌ | 122 | Experimental |
| PWA manifest `file_handlers` + `window.launchQueue` | 102 | 102 | ❌ | ❌ | ❌ | ❌ | Chromium desktop |
| PWA manifest `launch_handler` | 110 | 110 | ❌ | ❌ | ❌ | 110 | |
| PWA manifest `share_target` | 89 | 89 | ❌ | ❌ | ❌ | 76 | |
| `registerProtocolHandler` / manifest `protocol_handlers` | 96 (manifest) | 96 | ❌ (manifest) | ❌ | ❌ | ❌ | |

**Vendor positions** (these will not change soon):

- WebKit: File System Access (local filesystem) is **`position: oppose`** ([WebKit/standards-positions#28](https://github.com/WebKit/standards-positions/issues/28)), and so is `move()` for local files ([#121](https://github.com/WebKit/standards-positions/issues/121)).
- Mozilla: File System Access is **negative** ([mozilla/standards-positions#154](https://github.com/mozilla/standards-positions/issues/154)). A "subset" implementation is deferred (#738). Mozilla is **positive** on OPFS AccessHandles (#562).

In practice, **a real on-disk vault folder with read/write works only in Chromium: Chrome, Edge, Brave, Opera, Arc, and Android Chrome since 132.** Firefox and Safari get OPFS plus import/export.

### 3.2 Permission persistence (Chromium)

- **Handles survive reloads.** `FileSystemDirectoryHandle` objects are structured-cloneable, so store them in **IndexedDB**.
- **Access usually does not.** Before Chrome 122, permission reset every session. Every launch needed `await handle.queryPermission({mode:'readwrite'})`, and if the result was not `'granted'`, a `requestPermission({mode:'readwrite'})` call **inside a user gesture** (for example an "Open vault" button).
- **Chrome 122+ persistent permissions** ([Chrome blog](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)). The prompt offers "Allow this time / **Allow on every visit** / Don't allow". Once granted, a stored handle's `requestPermission()` is auto-granted on later visits. The conditions: a grant existed on the last visit, the handle is stored in IndexedDB, and the app calls `requestPermission()` on the retrieved handle.
- **Request `readwrite` up front** in `showDirectoryPicker({mode:'readwrite', id:'vault', startIn:'documents'})`. Otherwise the first write triggers a second prompt.
- **Blocked folders.** Chromium's blocklist refuses sensitive locations such as OS system directories and some top-level user folders, and it blocks writing some dangerous file types. Test the exact behaviour per OS before promising "any folder". A normal vault folder with `.obsidian/` inside it works.
- **No stat metadata beyond `File.lastModified` and `size`.** Rename is `move()`, which is partial on local files in Chromium, so implement rename as copy + `removeEntry()` with a fallback.
- **Writes are atomic per stream.** `createWritable()` writes to a swap file and commits on `close()`. For big vaults, serialize writes per file.

### 3.3 Watching for external changes

- **Chromium desktop 133+:** `new FileSystemObserver(cb).observe(dirHandle, {recursive:true})`. Records carry `type` (`appeared`, `disappeared`, `modified`, `moved`, `unknown`, `errored`), `changedHandle` and `relativePathComponents`. `unknown` means the event was dropped, so rescan.
- **Everywhere else (Android Chrome, OPFS on Firefox/Safari):** poll on `visibilitychange`/`focus`, plus a throttled interval, diffing `(path, size, lastModified)`. Markport does exactly this: "falls back to refresh on tab focus".
- OPFS changes made from other tabs of the same origin should go out over `BroadcastChannel`.

### 3.4 OPFS details

- `navigator.storage.getDirectory()` returns the origin root. It is invisible to the user's file manager.
- `createSyncAccessHandle()` (Worker only) gives synchronous `read/write/truncate/flush/getSize` and is exclusive per file. It is the fast path for SQLite-wasm or index files and for a Rust/wasm core using a synchronous FS in a worker.
- Chrome 121+ adds `mode: "readwrite-unsafe"` for multiple writers (WebKit #238 is still open; Mozilla positive #861).
- **Safari:** OPFS with `getDirectory` and sync handles since 15.2 (iOS 15.2). `createWritable` only arrived in **Safari 26**; on older Safari, write through `createSyncAccessHandle` in a worker.
- **iOS 17+ Home Screen web apps** get the same ~60% disk quota as Safari. Script-written storage in Safari can be **evicted after 7 days without user interaction** when tracking prevention is on ([WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)).
- iOS has no `webkitdirectory` before 18.4 and no directory picker at all, so "import" there means zip or individual files, or a sync backend.

### 3.5 Quotas and persistence ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria))

| Browser | Per-origin quota | `persist()` |
|---|---|---|
| Chrome/Edge | Up to 60% of disk (both modes) | Auto-granted or denied by engagement heuristics, no prompt (installed PWA or bookmarked ⇒ likely granted) |
| Firefox | Best-effort: min(10% disk, 10 GiB group limit). Persistent: 50% of disk, max 8 TiB | **Shows a permission prompt** |
| Safari 17+/iOS 17+ | ~60% of disk (browser and Home Screen app); ~15% in embedded WebViews; overall 80% | Heuristic, no prompt. Proactive 7-day eviction of script data without interaction |

Eviction is LRU and all-or-nothing per origin. Persistent origins are skipped. **Call `navigator.storage.persist()` after the user creates their first OPFS vault, and show the result.**

### 3.6 Recommended adapter design

```
trait VaultFs (Rust core, async, path-based, UTF-8 paths relative to vault root)
  list(dir) -> [Entry{path, kind, size, mtime}]
  read(path) -> bytes;  write(path, bytes);  mkdir(path)
  rename(from, to);     remove(path, recursive)
  stat(path)
  watch() -> Stream<Change>     // may be Unsupported
  capabilities() -> Caps
Caps { realFolder, writable, persistentPermission, nativeWatch, syncHandles, needsUserGestureOnLaunch, quotaBytes }
```

The core is implemented once in Rust and runs in a dedicated Worker. Each backend lives in TS or Rust behind a message port.

| Backend | Chromium desktop | Chrome Android ≥132 | Firefox | Safari macOS/iOS | Notes |
|---|---|---|---|---|---|
| **`LocalFolderFs`** (File System Access handle) | ✅ primary: RW, persistent grant (122+), `FileSystemObserver` (133+) | ✅ RW, poll watch | ❌ | ❌ | Handle in IndexedDB; "Reconnect vault" button when `queryPermission` ≠ granted; rename = copy + remove |
| **`OpfsFs`** | ✅ (fast sync handles in worker) | ✅ | ✅ primary | ✅ primary (`createWritable` ≥ 26, else sync handles) | `persist()` on creation; `BroadcastChannel` for cross-tab change events |
| **`ImportFs`** (read-only snapshot into OPFS) | ✅ drag-drop `getAsFileSystemHandle` / `webkitGetAsEntry`, `<input webkitdirectory>` | ✅ | ✅ `webkitdirectory`, drag-drop entries | ✅ macOS; iOS ≥ 18.4 `webkitdirectory` | One-shot import. Pair with **Export** (zip download, or `showSaveFilePicker` on Chromium) so non-Chromium users can round-trip |
| **`RemoteFs`** (git over HTTP w/ CORS proxy, WebDAV, S3, CouchDB/LiveSync-compatible) | ✅ | ✅ | ✅ | ✅ | Mirrors into OPFS for offline use; the answer for iOS and Firefox users who want the same vault on desktop Obsidian |
| **`MemoryFs`** | tests, demo vault | | | | |

**Launch integration (Chromium only):** manifest `file_handlers` for `.md`/`.canvas`/`.base`, with `launchQueue.setConsumer` opening the file; `launch_handler: {client_mode: "focus-existing"}`; `share_target` for the clipper and share sheet; `protocol_handlers` for `web+openobsidian`.

**UX rule:** show the vault type ("Folder on this computer" vs "Stored in this browser") and the persistence state in settings. Browser-stored vaults must nag for backup or sync.

---

## 4. Markdown engines (Rust → wasm) and the editor layer

### 4.1 Rust parsers (crates.io 2026-09-13, sizes measured as in §2.3)

| | [pulldown-cmark](https://github.com/pulldown-cmark/pulldown-cmark) | [comrak](https://github.com/kivikakk/comrak) | [markdown-rs](https://github.com/wooorm/markdown-rs) (`markdown`) |
|---|---|---|---|
| Version / updated | **0.13.4** / 2026-05 (repo pushed 2026-09) | **0.55.0** / 2026-09-06 | **1.0.0** / **2025-04-23** (no push since) |
| Licence | MIT | BSD-2-Clause | MIT |
| Downloads (recent) | 151.6M (44.9M) | 7.7M (2.2M) | 10.0M (2.9M) |
| Model | Pull event iterator (no AST) | Arena AST (cmark-gfm port) | mdast AST (micromark port) |
| CommonMark / GFM | ✅ / ✅ tables, tasklists, strikethrough, footnotes, GFM alerts (`ENABLE_GFM`) | ✅ / ✅ (cmark-gfm spec tests) | ✅ 100% / ✅ |
| Footnotes | ✅ (GFM-style; old style optional) | ✅ + **inline footnotes** `^[…]` | ✅ GFM |
| Math `$…$`/`$$` | ✅ `ENABLE_MATH` | ✅ `math_dollars`, `math_code` | ✅ `math_text`/`math_flow` |
| YAML frontmatter | ✅ `ENABLE_YAML_STYLE_METADATA_BLOCKS` | ✅ `front_matter_delimiter` | ✅ `frontmatter` |
| **Wikilinks** | ✅ `ENABLE_WIKILINKS`: `[[a#b\|c]]` as `Link{WikiLink{has_pothole}}`, **and `![[x\|200]]` as `Image{WikiLink}`** | ◐ `wikilinks_title_after/before_pipe`, **no `![[embed]]`** (left as text) | ❌ |
| `==highlight==` | ❌ | ✅ `highlight` | ❌ |
| Callouts `> [!type]± title` | ◐ only the 5 GFM alert kinds; lowercase and custom types fall through as a plain blockquote | ◐ `alerts`: 5 GitHub types; the `-` fold marker leaks into the title (`title: "- Custom fold"`) | ❌ |
| Tags `#tag/nested`, `%%comments%%`, `^block-id` | ❌ (text) | ❌ (text) | ❌ (text) |
| Other extensions | heading attributes, definition lists, super/subscript, smart punctuation | description lists, underline, spoiler, subscript, superscript, `++insert++`, shortcodes, multiline blockquotes, block directives, attributes | MDX (ESM/JSX/expressions) |
| **Source positions** | **Byte `Range` for every event** (`into_offset_iter`); no line/col | `sourcepos` line + column (UTF-8 bytes, or chars with `sourcepos_chars`) on every node; **no byte offset**; inline-footnote definitions got garbage positions (`5:1-5:0`) in the test | **line, column and offset on every node** (`Point{line,column,offset}`) |
| wasm size, parse + offsets only | **173 KB opt / 76 KB gz / 63 KB br** | — | — |
| wasm size, parse + HTML render | **186 KB / 82 KB gz / 67 KB br** | 328 KB / 120 KB gz / 97 KB br | 311 KB / 122 KB gz / 96 KB br (AST + HTML) |
| Speed (1 small OFM sample; relative) | fastest (1.2 ms parse-only, 2.8 ms with HTML, cold) | 4.8 ms | 12.9 ms |

### 4.2 Test: the same Obsidian-flavoured note through all three (native run)

```md
---
tags: [a, b]
---
# Heading ✓ one
Text with [[Note#Sub|alias]] and ![[image.png|200]] and [[Note#^blk]] and #tag/nested and ==hi== and %%hidden%% and ^[inline fn] and $x^2$.

> [!tip]- Custom fold
> body

- [ ] task [[Other]] ^block-id
```

- **pulldown-cmark:** YAML block ✅; wikilink with alias ✅ (`dest_url "Note#Sub"`, byte range 49..67); **embed ✅** (Image WikiLink "image.png", text "200"); block-ref link ✅; InlineMath ✅; TaskListMarker ✅. Tags, highlight, comments, inline footnote, block id: plain Text. The callout became `BlockQuote(None)`. Offsets are **UTF-8 byte** ranges: "✓" shifts every later offset by +2 relative to chars.
- **comrak:** FrontMatter ✅, WikiLink ✅, **embed ❌**, Highlight ✅, inline FootnoteReference ✅, Math ✅, Alert(Tip) with the fold marker mis-parsed, TaskItem ✅; line:col only.
- **markdown-rs:** Yaml ✅, InlineMath ✅, offsets ✅ on every node, but wikilinks, embeds, highlight and callouts all stay plain text.

### 4.3 Recommendation: pulldown-cmark plus an OFM layer

The metadata cache must match Obsidian's `CachedMetadata`: `links`, `embeds`, `tags`, `headings`, `sections`, `listItems`, `blocks`, `frontmatter`, `frontmatterPosition`, `footnotes` (1.6.6+), `footnoteRefs` and `referenceLinks` (1.8.7+). Each position is `Pos{start: Loc, end: Loc}` where `Loc = {line (0-based), col, offset}`. Per `obsidian.d.ts`, `offset` is the "number of characters from the beginning of the file", which means **JavaScript UTF-16 code units**.

Use **pulldown-cmark** as the block and inline tokenizer:

- It is the smallest (≈67 KB brotli with HTML), the fastest and the most used (151M downloads).
- It is the only engine that already handles **both wikilinks and `![[embeds]]`**.
- It gives a byte range for every event, and a cheap line-start table converts that to `{line, col, offset}`.

Add a thin **OFM pass** in Rust:

1. **Pre-scan** for `%%…%%` comments (they can span blocks) and mask them before parsing.
2. **Text-event scanner** for `#tags` (Obsidian's tag grammar: no leading digit-only tag; `/` nesting; stop characters), `==highlight==`, `^[inline footnotes]`, and trailing ` ^block-id` at the end of a paragraph or list item. That last one produces `blocks[id]` and `listItems[].id`.
3. **Callout detection** on a blockquote whose first line matches `^\[!(\w[\w-]*)\]([+-])?\s*(.*)$`, with any type and a fold state.
4. **Wikilink target parsing:** `file#heading#sub`, `#^block`, `|alias`, embed size `|200` or `|200x100`, and `displayText`.
5. **Sections:** top-level events become `SectionCache{type: heading|paragraph|list|code|blockquote|callout|table|math|html|footnoteDefinition|yaml|thematicBreak|comment}`. `listItems` get `parent` (negative for root, as Obsidian does), `task` char and `id`.
6. **Offset conversion:** keep the text as UTF-8, and build a `(byte → utf16)` prefix table only when a file contains non-ASCII. Export UTF-16 offsets across the wasm boundary.

Pin a golden-file suite of real vault notes (kepano's vault, Obsidian Help vault) against Obsidian's actual `app.metadataCache.getFileCache()` output. Per the memory note, only real files find parser bugs.

Use comrak as a secondary candidate only if an AST with rendering plugins becomes more valuable than raw speed. markdown-rs is precise but unmaintained since April 2025 and lacks every OFM construct.

### 4.4 Editor: CodeMirror 6 live preview (licences matter)

**Compatibility constraint.** Obsidian's editor is CM6 with a **HyperMD-derived Markdown mode**. Plugins read node and token names such as `hmd-internal-link`, `formatting-link`, `HyperMD-header_HyperMD-header-1` and `hmd-codeblock` from `syntaxTree()`: GitHub code search finds **49** TypeScript files using `"hmd-internal-link"` with `syntaxTree`, in Iconize, Metadata Menu, Codeblock Customizer and others. For plugin compatibility, the parser that feeds CM6 must **emit HyperMD-compatible node names**, via a custom `@lezer/markdown` extension or a StreamLanguage port of HyperMD's mode, and expose `editorLivePreviewField`, `editorInfoField` and the other `obsidian` CM6 facets.

| Project | Licence | ★ / last activity | What to take | Flag |
|---|---|---|---|---|
| [@lezer/markdown](https://code.haverbeke.berlin/lezer/markdown) 1.7.2 / @codemirror/lang-markdown 6.5.2 | MIT | GitHub mirrors archived 2026-04; moved to code.haverbeke.berlin | Incremental parser with extension API (GFM, custom inline/block parsers) | ✅ base layer |
| [HyperMD](https://github.com/laobubu/HyperMD) (npm `hypermd` 0.3.11) | MIT | 1,590★, **last push 2021** (CM5) | The token-naming scheme Obsidian inherited; port the mode's classes | ✅ reference only |
| [@codemirror/legacy-modes](https://code.haverbeke.berlin/codemirror/legacy-modes) 6.5.4 | MIT | 2026-09 | StreamLanguage wrapper if porting HyperMD's CM5 mode directly | ✅ |
| [atomic-editor](https://github.com/kenforthewin/atomic-editor) (`@atomic-editor/editor`) | MIT | 140★, 2026-09; Show HN 67 pts | Obsidian-style reveal-on-cursor decorations, WYSIWYG tables, wikilinks, virtualised; React | ✅ best recent MIT reference |
| [ink-mde](https://github.com/davidmyersdev/ink-mde) 0.34.0 | MIT | 304★, npm last publish 2024-09 | Hybrid CM6 markdown, images, vim | ✅ |
| [codemirror-rich-markdoc](https://github.com/segphault/codemirror-rich-markdoc) 0.0.2 | MIT | 123★, 2024-11 | Small demo of hide-syntax decorations and block widgets | ✅ tiny |
| [ixora](https://codeberg.org/retronav/ixora) (`@retronav/ixora` 0.3.3) | Apache-2.0 | 29★, npm 2023 | Extension pack: headings, lists, images, blockquotes, hide marks | ✅ (NOTICE requirement) |
| [SilverBullet](https://github.com/silverbulletmd/silverbullet) `client/` | MIT | 6,043★, active | Mature CM6 live preview, wikilinks, custom `markdown_parser/` (lezer extensions, footnotes, tables, tasks), PWA offline sync | ✅ **most complete MIT reference** |
| [WebObsidian](https://github.com/xnohat/webobsidian) | MIT | 253★, 2026-06 | CM6 live/source/reading + Obsidian plugin shim subset | ✅ |
| [Zettlr](https://github.com/Zettlr/Zettlr) `source/common/modules/markdown-editor/renderers/*` (render-links, -math, -mermaid, -tasks, -images, -headings, …) | **GPL-3.0** | 13,507★ | Do **not** copy code; read for ideas only | ⚠️ GPL |
| [Joplin](https://github.com/laurent22/joplin) CM6 rich-markdown editor | **AGPL-3.0** | 56k★ | Do not copy | ⚠️ AGPL |
| [nothingislost/obsidian-codemirror-options](https://github.com/nothingislost/obsidian-codemirror-options) | **GPL-3.0** | 179★, 2022 | HyperMD-in-Obsidian tweaks | ⚠️ GPL |
| [inkeep/open-knowledge](https://github.com/inkeep/open-knowledge) | **GPL-3.0** | 4,202★ | — | ⚠️ GPL |
| [MusiCode1/markport](https://github.com/MusiCode1/markport) | **GPL-3.0** | 144★ | Node/Electron shim ideas; also runs Obsidian's proprietary `app.js` | ⚠️ GPL + proprietary dependency |
| [Tolaria](https://github.com/refactoringhq/tolaria), [Plainva](https://github.com/plainva/plainva) | **AGPL-3.0** | 19.8k★ / 36★ | — | ⚠️ AGPL |
| [codemirror-markdown-hybrid](https://github.com/markdowneditors/codemirror-markdown-hybrid) | **no licence** | 8★ | — | ⚠️ all rights reserved |
| Obsidian's own `app.js` | Proprietary | — | Behavioural reference only through the public API docs and `obsidian.d.ts` (MIT) | ⛔ never copy or bundle |

**Editor recommendation.** Build on MIT **@lezer/markdown** with a custom OFM extension that emits HyperMD-compatible node names. Borrow decoration patterns from **SilverBullet** (MIT) and **atomic-editor** (MIT). Treat Zettlr, Joplin, Markport, OpenKnowledge, Tolaria and Plainva as read-only inspiration at most; do not paste their code. Keep the Rust pulldown-cmark OFM pass (§4.3) as the single source of truth for the metadata cache, and use lezer only for incremental editor highlighting and decorations. Cross-check the two with a test that compares link, heading and tag positions from both parsers on every golden file.
