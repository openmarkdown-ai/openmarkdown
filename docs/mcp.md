# `vault mcp` — your vault as an MCP server

`vault mcp <vault-folder>` gives an AI agent the same access to an
Obsidian-compatible vault that the OpenMarkdown app has: search, links, tags,
properties, Bases, canvases, the graph, daily and periodic notes, publishing,
clipping and importing. Supported clients include Claude Code, Claude Desktop
and anything else that speaks the
[Model Context Protocol](https://modelcontextprotocol.io).

The answers match the app's because they come from the same crates —
`vault-index` (link resolution, search syntax, graph, rename edits),
`vault-ofm` (metadata, sections, rendering), `vault-bases`, `vault-publish`
and `vault-clip`. A rename made over MCP updates links exactly as a rename in
the app does.

```
vault mcp ~/Notes              # 36 tools: read and write
vault mcp ~/Notes --read-only  # 20 tools: the write tools are not offered
```

The server speaks JSON-RPC over stdin/stdout, one message per line. The client
starts it; it exits when the client closes stdin. Log lines go to stderr.

## Install

```sh
cargo install --path crates/vault-cli        # puts `vault` in ~/.cargo/bin
# or
cargo build --release -p vault-cli           # target/release/vault
```

MCP clients start the server without your shell's `PATH`. Configure it with an
**absolute path** to the binary, such as `/Users/you/.cargo/bin/vault`. Run
`which vault` to find it.

## What an agent can do with this vault

Everything below is one tool call, against the real files on disk.

- **Get its bearings.** `vault_stats` gives the counts, words, broken links,
  orphans and top tags; `list_folders` and `list_notes` the structure;
  `graph_image` a picture of how it all hangs together.
- **Find things the way you would.** `search` takes the same query language as
  the app's search pane, down to `tag:#x`, `[status:done]`, `task-todo:""`,
  `section:(…)` and `/regex/`.
- **Follow the links.** `backlinks`, `outgoing_links`, and
  `unlinked_mentions` for the notes that name this one without linking it.
- **Read it as you see it.** `read_note` for the Markdown, `render_note` for
  the reading view as text or HTML, `run_base` to run a `.base` view and get
  the rows (or a Markdown table), `canvas_read` and `canvas_image` for a
  canvas.
- **Write like the app.** `create_note`, `edit_note`, `append_note`,
  `set_property`, `canvas_edit`; `rename_note` and `move_note` update every
  link across the vault; `delete_note` goes to `.trash` and `restore_note`
  brings it back.
- **Change many notes at once, safely.** `replace_in_vault` and `rename_tag`
  show you exactly what they would do before they do it, and skip the matches
  that would break links.
- **Keep a journal.** `daily_note` and `periodic_note` use the vault's own
  Daily notes and Periodic Notes settings, templates included.
- **Send something out.** `export_note` (one HTML file), `export_vault` (a
  whole static site), `clip_html` (a web page → a note), `import_notes` (an
  export from Evernote, Notion, Roam, Keep, Bear, Logseq, a CSV or a
  TextBundle), and `open_in_app` for a link a person can click.

Four **prompts** package the common jobs: `vault_tour`, `open_questions`,
`note_review` and `weekly_summary`. In Claude Code they appear under `/mcp`.

## Tools

**W** marks a tool that writes; those are not offered at all under
`--read-only`. Paths are vault-relative (`Projects/Alpha.md`); `.md` may be
omitted, and a bare name resolves the way a `[[wikilink]]` does.

### Reading the vault

| Tool | Arguments | What it does |
| --- | --- | --- |
| `search` | `query`, `limit`, `case_sensitive`, `snippets_per_file` | Obsidian search syntax: words, `"phrase"`, `OR`, `-x`, `/regex/`, `path:`, `file:`, `content:`, `tag:#t`, `line:( )`, `block:( )`, `section:( )`, `task:`, `task-todo:`, `task-done:`, `[prop]`, `[prop:value]`. Returns files with match counts and line snippets. |
| `read_note` | `path`, `heading`, `block` | The whole note, one heading's section (nested as `Parent#Child`), or one `^block`. |
| `list_notes` | `folder`, `glob`, `limit`, `sort`, `include_attachments` | Notes under a folder, filtered by a glob (`*`, `**`, `?`; a glob without `/` matches the file name). `sort: modified` puts the newest first. |
| `list_folders` | `folder`, `depth` | Every folder with its note and attachment counts. Empty folders included; hidden ones never. |
| `vault_stats` | `top` | Notes, attachments, bytes, words, characters, links, broken links and the most-wanted missing notes, orphans, tags, largest and most recently changed notes, and the vault's link settings. What `vault info` prints, as JSON. |
| `tags` | `path` | Without `path`: every tag with counts. With `path`: that note's tags. |
| `properties` | `path` | Without `path`: every property name with the number of notes using it. With `path`: that note's frontmatter as JSON. |
| `backlinks` | `path` | Notes that link to or embed a file, with the line and context of each reference. |
| `outgoing_links` | `path` | Resolved targets with counts, plus unresolved link targets. |
| `unlinked_mentions` | `path`, `limit` | Whole-word, case-insensitive occurrences of the note's name or an alias in other notes, excluding links, embeds and frontmatter — the app's Unlinked mentions pane. |
| `render_note` | `path`, `format`, `theme` | `text` (default, the readable reading-view text), `html` (a standalone document with styles and embedded images) or `fragment` (the body's HTML). Refuses above 2 MB and points at `export_note`. |
| `run_base` | `path` \| `yaml`, `view`, `format`, `limit` | Runs a `.base` view: filters, formulas, sorting, grouping and summaries, as the Bases plugin evaluates them. `format: "markdown"` also returns a Markdown table. |
| `graph` | `note`, `depth`, `filter`, `include_tags`, `include_attachments`, `include_unresolved`, `include_orphans`, `incoming`, `outgoing`, `neighbor_links`, `limit` | The link graph as data. With `note` it is the local graph, `depth` hops out. `filter` is a search query. Same options as the graph view's panel. |
| `graph_image` | the same, plus `labels`, `width` | An **SVG** of that graph: circles sized by degree, labelled, tags green, unresolved notes dashed outlines, the local-graph centre ringed. Laid out with `vault-index`'s force simulation — the one the app runs — so it looks like the graph view, and it is deterministic. |
| `canvas_read` | `path` | A `.canvas` (JSON Canvas) board as JSON: cards (`text`, `file`, `link`), groups and edges with labels. File cards also report the note their `file` resolves to. |
| `canvas_image` | `path`, `width`, `snippets` | An **SVG** of the board at its own coordinates: groups behind, cards with their text, file cards with the note's name and first lines, edges with arrows and labels. |
| `list_trash` | `limit` | What is in `.trash`, with the name to pass to `restore_note` and, when `.obsidian/trash.json` records it, the path it came from. |
| `open_in_app` | `path`, `heading`, `block`, `query`, `action`, `base_url` | Builds `https://openmarkdown.ai/?uri=obsidian://…` and the `obsidian://` equivalent. Returns links only; nothing is opened or fetched. |
| `daily_note` | `action`, `date`, `content` | `read` (and, unless read-only, `create`/`append`) the daily note for `today`, `yesterday`, `tomorrow` or `YYYY-MM-DD`. Folder, format and template come from `.obsidian/daily-notes.json`. |
| `periodic_note` | `period`, `action`, `date`, `content` | The same for `weekly`, `monthly`, `quarterly` and `yearly`, from `.obsidian/periodic-notes.json`, with the app's defaults when it has none (`gggg-[W]ww`, `YYYY-MM`, `YYYY-[Q]Q`, `YYYY`). `date` takes `this`, `last`, `next` or a `YYYY-MM-DD` inside the period. Templates get `{{title}}`, `{{date}}`, `{{time}}` and `{{monday:…}}`…`{{sunday:…}}`. |

### Changing the vault (W)

| Tool | Arguments | What it does | Safety |
| --- | --- | --- | --- |
| `create_note` | `path`, `content` | Creates a note and any missing folders. | Fails if it exists. |
| `edit_note` | `path`, `old_string`+`new_string`, or `heading`/`block`+`content` | Exact replacement (must match once), or replace one heading's section or one block. | Atomic; line endings and BOM preserved. |
| `append_note` | `path`, `content`, `heading`, `create_if_missing` | Appends to the note, or to the end of a heading's section. | Only adds. |
| `set_property` | `path`, `name`, `value` | Sets one frontmatter property; `null` removes it. Only that property's lines change, so comments and ordering survive. | Refuses if the frontmatter is not valid YAML, and if the value would not read back identically. |
| `create_folder` | `path` | An empty folder (with parents). | Idempotent. |
| `rename_note` | `path`, `new_path` | Renames a note or attachment, updating every link, following `newLinkFormat`. | Fails if the destination exists; refuses if a note to rewrite changed on disk. |
| `move_note` | `path`, `to`, `dry_run` | The same machinery for moving a note, an attachment **or a whole folder**. `to` with no extension is a destination folder; a full path with an extension is taken as written. | `dry_run: true` lists the moves and the link rewrites first. Never overwrites. |
| `delete_note` | `path` | Moves a note, attachment or folder to `.trash`, as the app's Delete does (flat, with ` 1`, ` 2` on a clash). | **Reversible** with `restore_note`; nothing is erased. There is no permanent delete — empty the trash from the app. Reports how many backlinks it breaks. |
| `restore_note` | `path`, `to` | Moves something out of `.trash`. Without `to` it uses the origin the app recorded, else the vault root. | Never overwrites. |
| `replace_in_vault` | `query`, `replacement`, `apply`, `case_sensitive`, `include_links_and_tags`, `limit` | Search-and-replace across every matching note — the Search view's Replace all. | **Previews by default.** Without `apply: true` nothing is written and you get the before/after lines. Skips matches inside link and embed targets, tags, property names and URLs, with a reason for each. Refuses a file that changed since the preview. |
| `rename_tag` | `from`, `to`, `dry_run` | Renames a tag everywhere: inline `#tags` and frontmatter `tags:`/`tag:`. Case-insensitive, child tags follow, duplicates merged. Code blocks, `$$` math and `%%comments%%` untouched. | `dry_run: true` reports the notes and counts first. |
| `canvas_edit` | `path`, `create_if_missing`, `add_nodes`, `update_nodes`, `remove_nodes`, `add_edges`, `remove_edges` | Adds, changes and removes cards and edges on a `.canvas`. | Validated as the app validates: unique ids, sizes ≥ 1, both ends of an edge must exist. Written in the app's exact file layout, so diffs stay small and Obsidian opens it unchanged. |
| `export_note` | `path`, `to`, `outside_vault`, `overwrite`, `theme` | One note as a standalone HTML file. | `to` is vault-relative unless `outside_vault: true`; never overwrites without `overwrite: true`. |
| `export_vault` | `to`, `outside_vault`, `site_name`, `home`, `base_url`, `include`, `exclude`, `noindex`, `dry_run` | The whole vault as a static site: a page per note, navigation, search, graph, backlinks, RSS, attachments. | Refuses a target inside the vault, and a folder that is not empty. `dry_run: true` lists the pages. Nothing in the vault changes. |
| `clip_html` | `url` \| `html`, `folder`, `name`, `template`, `dry_run` | A web page → a Markdown note with frontmatter, through the Web Clipper pipeline. | **`url` makes a network request** (the page is fetched with `curl`); `html` does not. The note lands at a free path, so it only ever adds a file. `dry_run: true` returns the Markdown instead. |
| `import_notes` | `kind`, `source`, `to`, `apply`, `options`, `limit` | `enex`, `html`, `notion`, `roam`, `keep`, `bear`, `logseq`, `csv`, `textbundle` → notes in a vault folder, converting links, attachments and frontmatter. | **Previews by default**; `apply: true` writes. `source` is a path on this computer — the one tool that reads outside the vault. Never overwrites: a clash becomes `Note 1.md`. |

### Prompts

`prompts/list` offers `open_questions` (unanswered questions, unfinished
tasks, broken links), `note_review` (`path`: read a note with its links and
mentions and suggest edits), `vault_tour` (a first look at an unfamiliar
vault) and `weekly_summary` (`days`: what changed, offered for the weekly
note). Each is a static template that names the tools to use, so listing and
filling one costs nothing.

### Resources

Every note is `vault://<percent-encoded path>` with MIME type `text/markdown`.
`resources/list` is paginated in pages of 1000, and there is one template,
`vault://{+path}`.

### Results

Tool results carry `structuredContent` plus the same JSON as text.
`read_note`, `render_note` and `run_base` (with `format: "markdown"`) return
plain text instead. `graph_image` and `canvas_image` return the SVG source as
text **and** an `image` content block with the same bytes base64-encoded and
`mimeType: "image/svg+xml"` — an image over 4 MB is refused with advice to
lower `limit` or `width`. PNG is not offered: rasterising would need a browser
or an image library, and the binary has neither.

Two kinds of failure are kept apart:

- **Tool errors** (`isError: true`) are things the model can fix: a missing
  note, a heading that is not in the note, an `old_string` that matches zero
  or several times, an invalid path, a bad search query, a destination that
  exists. The message says what to do next — it lists the note's headings, the
  vault's canvases, the base's views, or the paths that look similar.
- **Protocol errors** (`-32602`) are an unknown tool name, or a write tool
  called while the server runs with `--read-only`.

## Security model

The server is a local process running with your user's permissions. Its
authority is limited to the vault folder you name on the command line, with
two opt-in exceptions that say so in their own descriptions (`export_*` with
`outside_vault: true`, and `import_notes`, which reads the export you point it
at).

- **Path confinement.** A path from a client must be vault-relative. The
  server rejects absolute paths (`/…`, `C:…`, `~`), `.` and `..` segments, NUL
  characters, and any segment that starts with `.`. That last rule makes
  `.obsidian`, `.trash`, `.git` and dot-files unreachable through every tool
  and resource. Before any read or write, the deepest existing part of the
  path is resolved with `canonicalize`, and the operation is refused unless
  that resolved path is still inside the vault. A symlinked folder that points
  outside the vault is therefore refused. Symlinked files and folders are
  never indexed or listed, and the writer refuses to replace a symlink.
- **The trash is server-built, not client-addressed.** `delete_note` and
  `restore_note` are the only way to reach `.trash`, and both construct the
  path themselves from a cleaned name, so a client cannot walk out of it.
- **`.obsidian/` is off limits.** The server *reads* `app.json`
  (`newLinkFormat`, for rename), `daily-notes.json`, `periodic-notes.json`,
  `templates.json`, `types.json` and `trash.json`. It never writes there — so
  a delete made over MCP is not recorded in the app's trash origins, and
  restoring it from the app's Trash view puts it at the vault root. Restore
  over MCP instead, or pass `to`. Paths computed from those settings, such as
  the weekly-notes folder, go through the same confinement check as client
  paths.
- **`--read-only`.** The 16 write tools are left out of `tools/list`, and
  calling one is a protocol error. `daily_note` and `periodic_note` stay
  available with `action: "read"` only.
- **Destructive work is reversible or preview-first.** `delete_note` moves to
  the trash and is undone by `restore_note`. `replace_in_vault` and
  `import_notes` do nothing until `apply: true`, and `rename_tag` and
  `move_note` take `dry_run: true`. `replace_in_vault` and `rename_tag` refuse
  to write a file that changed since the preview was computed. Nothing here
  deletes bytes from disk.
- **Writes are atomic.** The new content is written to a temporary dot-file in
  the same folder, flushed with `fsync`, and renamed over the target, so no
  reader ever sees a half-written note. The existing file's permissions are
  kept.
- **Encoding is preserved.** Notes are decoded as strict UTF-8. The server
  refuses to read or edit a file that is not valid UTF-8 rather than replacing
  characters. A UTF-8 BOM and CRLF line endings are detected, edits are made
  on `\n` text, and the file is written back with its original BOM and line
  endings. A rename or move only rewrites links in files whose bytes on disk
  still match the index; otherwise the whole operation is refused before
  anything changes.
- **Network and subprocesses.** One tool reaches the network, and only when
  asked: `clip_html` with a `url` fetches that address with `curl`. Otherwise
  the only subprocess is `date +%z`, for the local time-zone offset; set
  `VAULT_TZ_OFFSET_MINUTES` to skip it. The SVG pictures are written by hand,
  so no browser or image library is ever launched.
- **The model is not the user.** Tool annotations tell clients which tools are
  safe: read tools carry `readOnlyHint`, and `edit_note`, `set_property`,
  `delete_note`, `replace_in_vault`, `rename_tag` and `canvas_edit` carry
  `destructiveHint`. Clients such as Claude Code ask for approval before
  calling a tool unless you allow it. Use `--read-only` for vaults an agent
  should only look at. Note text is written by whoever wrote the note and can
  contain instructions aimed at the model (prompt injection), so review write
  operations on vaults with content from untrusted sources.

The index is built when the server starts. Before every tool call and every
resource request, the server rescans file sizes and modification times, so
changes made in Obsidian, OpenMarkdown or an editor show up on the next call.

## Configuration

Replace `/Users/you/.cargo/bin/vault` and `/Users/you/Notes` with your own
absolute paths.

### Claude Code

```sh
claude mcp add --transport stdio notes -- /Users/you/.cargo/bin/vault mcp /Users/you/Notes
```

Add `--read-only` at the end for a read-only server. Add `--scope user`
(before `notes`) to make it available in every project. To share it with a
project, use `--scope project`, which writes `.mcp.json`:

```json
{
  "mcpServers": {
    "notes": {
      "type": "stdio",
      "command": "/Users/you/.cargo/bin/vault",
      "args": ["mcp", "/Users/you/Notes"]
    }
  }
}
```

Check it with `claude mcp list`, or with `/mcp` inside a session. The tools
appear as `mcp__notes__search`, `mcp__notes__read_note` and so on, and the
prompts as `/mcp__notes__vault_tour`.

### Claude Desktop

Open Settings → Developer → Edit Config, or edit the file directly:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "notes": {
      "command": "/Users/you/.cargo/bin/vault",
      "args": ["mcp", "/Users/you/Notes"]
    }
  }
}
```

Restart Claude Desktop. The vault's tools then appear under the tools/connectors
menu. On Windows, use a path such as
`"C:\\Users\\you\\.cargo\\bin\\vault.exe"` and `"C:\\Users\\you\\Notes"`.

### Other MCP clients

Any client that can launch a stdio server needs the same two things: the
command `/abs/path/to/vault` and the arguments `["mcp", "/abs/path/to/vault-folder"]`.

- **Cursor** (`~/.cursor/mcp.json`) and **Windsurf** use the same
  `mcpServers` object as Claude Desktop.
- **VS Code** (`.vscode/mcp.json`):
  `{"servers": {"notes": {"type": "stdio", "command": "/abs/vault", "args": ["mcp", "/abs/Notes"]}}}`
- **OpenAI Codex CLI** (`~/.codex/config.toml`):
  ```toml
  [mcp_servers.notes]
  command = "/abs/vault"
  args = ["mcp", "/abs/Notes"]
  ```
- **MCP Inspector** (for trying it by hand):
  `npx @modelcontextprotocol/inspector /abs/vault mcp /abs/Notes`

## Protocol support

The server supports two generations of the protocol ("dual-era"):

- **`2026-07-28` (current, stateless).** Each request carries
  `_meta["io.modelcontextprotocol/protocolVersion"]` and
  `…/clientCapabilities`. A request that lacks the capabilities gets `-32602`,
  and an unknown version gets `-32022` with `data.supported` listing the
  versions the server accepts. `server/discover` returns `supportedVersions`,
  capabilities and instructions. Every result includes
  `resultType: "complete"` and `_meta["io.modelcontextprotocol/serverInfo"]`.
  List, read and discover results also carry `ttlMs` and `cacheScope`: tool
  and prompt lists are `public`, and note contents are `private` with a TTL of
  0. A resource that is not found gets `-32602`.
- **`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (handshake).**
  `initialize` agrees on the client's version when the server knows it, and
  otherwise on `2025-11-25`. Results have no `resultType`, `ping` is
  answered, and a resource that is not found gets `-32002`. A request without
  modern `_meta` is also served this way when no `initialize` came first,
  which keeps simple scripts working.

The server advertises `tools`, `resources` and `prompts`. It does not use
listChanged notifications, subscriptions, sampling, elicitation or logging.
JSON-RPC batches are rejected with `-32600`, as the protocol has not allowed
them since 2025-06-18.

## Why a hand-written server instead of the Rust SDK

The official Rust SDK, [`rmcp`](https://crates.io/crates/rmcp) (Apache-2.0,
`modelcontextprotocol/rust-sdk`, v3.4 in September 2026), is maintained and
widely used. It is still the wrong fit for this binary:

- **Size and dependencies.** `rmcp` always depends on `tokio`, `futures`,
  `tokio-util`, `tracing`, `thiserror`, `chrono` and `indexmap`, and its
  server macros add `schemars`. `vault` is a small synchronous binary built
  for size (`opt-level = "s"`, LTO) that avoids even `clap`. The stdio
  transport is one JSON message per line, which needs nothing beyond the
  `serde_json` the workspace already uses. This server, pictures included,
  added **no new dependencies**.
- **No async runtime needed.** `VaultIndex` is deliberately single-threaded:
  it caches link tables in `Rc<RefCell<…>>`, so it is not `Send`. Requests on
  stdio arrive one at a time, and a blocking loop fits exactly. An async SDK
  would need the index to be restructured or kept on a local-set thread.
- **Spec churn.** Revision `2026-07-28` replaced the `initialize` handshake
  with per-request `_meta` and added `server/discover`, `resultType` and
  caching fields. Supporting both generations in one place, which is what
  current Claude Code, Claude Desktop and older clients need, is about 450
  lines here (`crates/vault-cli/src/mcp/mod.rs`). With `rmcp` it would depend
  on the SDK's release timing.

The cost is that protocol changes must be followed by hand. The unit tests
pin both generations (`legacy_handshake_and_calls`,
`modern_stateless_requests`), and `crates/vault-cli/tests/mcp_stdio.rs`
drives the real binary over pipes, listing every tool and calling one from
each group.

## What is deliberately not here

- **Browser-only features.** File recovery snapshots live in IndexedDB, sync
  keys in the browser's storage, and the AI plugins call a model from the
  page. None of them mean anything to a process on the other side of a pipe.
- **Permanent deletion.** `delete_note` only ever moves to `.trash`. Emptying
  it is a decision for a person, in the app.
- **PDF, DOCX, EPUB and pandoc export.** The app's exporters run in the
  browser (pandoc is a ~59 MB WASM download). `export_note` and
  `export_vault` cover HTML, which is what the Rust crates produce.
- **PNG pictures.** `graph_image` and `canvas_image` return SVG, which is text
  and needs no renderer. A PNG would mean a browser or an image library.
- **Editor state.** Open tabs, the cursor, workspaces, themes and hotkeys are
  the app's, not the vault's.

## Code map

- `crates/vault-cli/src/mcp/mod.rs`: the JSON-RPC loop, protocol eras,
  resources, prompts dispatch, and index refresh.
- `crates/vault-cli/src/mcp/tools.rs`: the tool registry, the read/write
  split, the core note tools, and the section, block, frontmatter and glob
  helpers.
- `crates/vault-cli/src/mcp/ops.rs`: move, trash, folders, unlinked mentions,
  vault statistics, periodic notes, and `open_in_app`.
- `crates/vault-cli/src/mcp/replace.rs`: vault-wide replace and tag rename,
  with the protected-range rules ported from the app's
  `core-plugins/global-search/replace.ts` and `core-plugins/tag-pane/rename.ts`.
- `crates/vault-cli/src/mcp/content.rs`: render, Bases, export, clip, import.
- `crates/vault-cli/src/mcp/visual.rs`: the graph and JSON Canvas, as data and
  as pictures.
- `crates/vault-cli/src/mcp/svg.rs`: the hand-written SVG writer.
- `crates/vault-cli/src/mcp/prompts.rs`: the prompt templates.
- `crates/vault-cli/src/mcp/fsx.rs`: path confinement, UTF-8/BOM/CRLF
  handling, and atomic writes.
- `crates/vault-cli/src/mcp/tests.rs` and `crates/vault-cli/tests/mcp_stdio.rs`:
  the tests.
