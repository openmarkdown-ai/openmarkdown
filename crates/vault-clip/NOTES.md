# vault-clip notes

What this crate is measured against, what real pages found, and where it
deliberately differs from the reference implementations.

## Reference implementations and how parity is checked

| Area | Reference (MIT) | Parity check |
|---|---|---|
| Template language | `knap` 0.5.0 (obsidianmd/knap), the engine inside Web Clipper | `oracle/gen-knap.mjs` renders 186 templates in Node and generates `src/template/oracle_tests.rs`; `oracle/gen-validate.mjs` generates 41 `engine.validate` cases |
| Clipper layer (variables, selectors, schema, prompts, frontmatter, triggers, template JSON) | obsidian-clipper `src/utils/{template-compiler,shared,resolver,triggers,import-export}.ts`, `src/api.ts` | hand-written tests in `src/template/tests.rs` |
| HTML → Markdown | Defuddle 0.19.3 `createMarkdownContent` (Turndown 7.2.4) | `oracle/gen-markdown.mjs` generates 48 cases; real-page differential (below) |
| Dates | dayjs 1.11 + customParseFormat/advancedFormat/isoWeek/weekOfYear | 45 tests with expected values from dayjs in four time zones |
| Extraction | Defuddle 0.19.3 | see "Extraction" |
| Importers | obsidian-importer | see "Importers" |

The generator scripts need a directory whose `node_modules` holds
`knap@0.5.0 defuddle@0.19.3 linkedom`; run them with that as the cwd
(`TZ=UTC node <crate>/oracle/gen-knap.mjs`). Tests never need Node.

The installed Obsidian application was not used for anything in this crate.

## Real pages

Pages fetched with curl (desktop UA; Stack Overflow and Medium via the
Wayback Machine because both return 403 to scripts): Wikipedia "Euler's
identity" and "Rust (programming language)", GitHub kepano/defuddle and
rust-lang/rust READMEs, a GitHub pull request, MDN `Array.prototype.map()`,
Python `functools` docs, the Stack Overflow "sorted array" question, arXiv
1706.03762 (abs) and 2310.06825 (HTML), a Guardian and a BBC article, a
Substack post, a Medium post, danluu.com, stephango.com, the Rust blog.

### Markdown converter: differential against Defuddle

For each page, Defuddle's own content HTML was converted by Defuddle and by
`clean_html_to_markdown` and the outputs compared byte for byte
(`inspect --clean`). After the fixes below, all 17 pages are identical.

Defects the real pages found (each has a regression test):

1. **No adoption agency algorithm in the HTML parser** (Substack). Tweet
   embeds nest `<p>quote <a>link</a></p>` inside an open `<a>`. Browsers
   reparent the paragraph and clone the outer link into it; the parser popped
   both, so the quote lost its link and moved. Fixed by implementing the list
   of active formatting elements, reconstruction, and the adoption agency
   algorithm. Tests: `html::tests::adoption_agency_moves_blocks_out_of_a_misnested_anchor`,
   `formatting_elements_are_reconstructed_across_blocks`,
   `markdown::tests::misnested_anchor_in_tweet_embed_matches_browser_parse`.
2. **`<template>` content converted** (MDN). "Enable JavaScript to view this
   browser compatibility table." lives in a `<template>`, which browsers keep
   out of the tree. Test: `template_content_is_not_converted`.

3. **Panic on a multibyte character after `</` inside a script** (Guardian,
   found by the extraction work). The raw-text end-tag search sliced the
   string at a byte offset inside `•`. Now compares bytes. Tests:
   `raw_text_end_search_does_not_split_multibyte_chars`,
   `every_prefix_of_tricky_markup_parses_without_panic`; every saved page is
   also parsed and converted by `inspect` without panicking.

Found by oracle fixtures rather than pages: the parser did not insert the
implied `<tbody>`, so complex tables kept as HTML differed
(`complex_table_keeps_implied_tbody`).

### Extraction: differential against Defuddle

`examples/extract_inspect.rs` against Defuddle 0.19.3 under linkedom
(`oracle/page.mjs`) on the 17 pages above plus the Rust book, gwern, Nature,
overreacted, KaTeX docs, mkdocs-material, Hacker News and LWN. Word count
matches exactly on 15 of 17; content is token-identical after attribute and
whitespace normalisation except: MDN (Defuddle-under-linkedom keeps a
`<template>`), Wikipedia math (Defuddle's Node build adds temml MathML; we keep
`data-latex`), Substack (our parser applies the browser's adoption agency
algorithm, linkedom does not), and serialisation-only details on Stack
Overflow/arXiv. HN and LWN differ because their site extractors are not ported.

End to end (`inspect page.html url`: extract → Markdown) the notes equal
Defuddle's own Markdown byte for byte on 16 of the 17 pages; Substack differs
only where linkedom's non-spec parse differs from a browser's.

## Importers

Checked by running `examples/import_inspect.rs` over obsidian-importer's own
test exports (ENEX, Roam, Keep, Bear, Logseq, CSV, Notion HTML and
Markdown/CSV, HTML, TextBundle) and diffing against its recorded output. Roam
and Logseq match exactly (links omit the vault folder unless
`graphFolder`/`vaultFolder` is set); Bear differs only in the attachment
folder name; Keep only in `*` vs `_` italics. Defects the samples found, each
with a regression test: Evernote 10 `<task>` elements dropped; ISO reminder
times unparsed; a list item holding only a nested list became `- - x`;
text-less links vanished; spacer divs left whitespace-only lines; Notion
display math/code inside quotes or lists lost their `> `/indent prefix; Notion
`[!tip]` quotes escaped as `\[!tip\]`; `#_` hashtags unescaped; Notion
Markdown exports imported `index.html` as an attachment and left links to
database views dead; CSV lacked the blank line after frontmatter; TextBundle
wrote the same image once per bundle; a stray backtick paired with one
paragraphs later and unprotected code; the Format converter touched indented
code and read `(#x)` as a tag.

Import gaps: Bear's SQLite-era backups (warning only); Roam-hosted
attachments are not downloaded (no network); no `.base` files; no re-import
source-id properties.

## Deliberate departures

Each is a bug in the reference that would put wrong data in a vault.

- **Nested list indentation** (found by the Evernote import samples): Defuddle
  gives each item one tab per level and its parent `<li>` indents continuation
  lines by another tab, while the list rule's `trim()` strips the first
  item's tab. In the clipper the second and later siblings of any nested list
  are one level too deep (`- a\n\t- b\n\t\t- c`), so Obsidian nests them
  under the first. The enclosing item now supplies the indent. Tests:
  `nested_list_siblings_share_one_indent`,
  `list_nested_directly_in_list_still_indents`; the `md_lists` oracle case is
  marked as a departure in `oracle/markdown-cases.json`.

- **Embeds** (`markdown.rs`): Defuddle treats any `src` containing the
  substring `x.com` as a tweet embed, so images hosted on ex.com, box.com,
  dropbox.com, netflix.com… render as nothing. Only real YouTube/X hosts count.
  Test: `images_on_hosts_containing_x_com_are_not_swallowed`.
- **Task items**: Defuddle checks `getAttribute('checked')` for truthiness, so
  GitHub's `checked=""` became `[ ]`. Presence of the attribute is checked.
  A `<li>` starting with a checkbox is a task even without GitHub's class.
- **Frontmatter text values** escape `\`, newlines and tabs as well as `"`
  (the clipper only escapes `"`, so `C:\new` became a newline).
- **`markdown` filter / `html_to_markdown`**: resolves relative URLs against
  the page URL and does not strip a leading `# H1` (the clipper's filter does
  neither resolution nor keep the H1). `clean_html_to_markdown` keeps the exact
  clipper behaviour for `{{content}}`.
- **Time**: "local time" is an explicit UTC offset (`tz_offset_minutes`); the
  crate has no clock or zone database.
- **File names**: `sanitize_file_name` always applies the non-Windows,
  non-macOS branch (the clipper picks by `navigator.platform`); the
  `safe_name` filter keeps its explicit OS variants.

## Known gaps

- JS regular expressions run on `regex-lite`: no lookaround or
  backreferences. `replace:"/(?<=a)b/"` reports a warning and leaves the text.
- `date`: fixed offsets only (no DST); `z`/`zzz`/`gggg` produce an empty
  string (knap throws for them too).
- HTML parser: no foster parenting of text directly inside `<table>`, no
  `<frameset>` handling, a ~300-entry named character reference table.
- MathML without a TeX annotation or `data-latex`/`alttext` is not converted to
  LaTeX (Defuddle's full bundle uses mathml-to-latex).
- Extraction: no CSS layout (mobile media queries, computed style), so it
  behaves like Defuddle under linkedom; only the Wikipedia, Substack and Medium
  site extractors are ported (HN, Reddit, YouTube, X, GitHub issues, LWN,
  chat apps use the generic pipeline).
- Render limits are approximate (operation and output caps), not knap's exact
  budget accounting.
