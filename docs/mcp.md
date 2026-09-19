# `vault mcp` — your vault as an MCP server

`vault mcp <vault-folder>` lets AI agents read and edit an Obsidian-compatible
vault. Supported clients include Claude Code, Claude Desktop, and any other
client that speaks the [Model Context Protocol](https://modelcontextprotocol.io).
The agent gets the same link resolution, search syntax, tag and property
handling, and link-updating rename as the OpenMarkdown app, because the server
uses the same crates (`vault-index`, `vault-ofm`).

```
vault mcp ~/Notes              # read and write
vault mcp ~/Notes --read-only  # no write tools at all
```

The server speaks JSON-RPC over stdin/stdout. The client starts it, and it
exits when the client closes stdin. Log lines go to stderr.

## Install

```sh
cargo install --path crates/vault-cli        # puts `vault` in ~/.cargo/bin
# or
cargo build --release -p vault-cli           # target/release/vault
```

MCP clients start the server without your shell's `PATH`. Configure it with an
**absolute path** to the binary, such as `/Users/you/.cargo/bin/vault`. Run
`which vault` to find it.

## Tools

| Tool | What it does |
| --- | --- |
| `search` | Obsidian search syntax: words, `"phrase"`, `OR`, `-x`, `/regex/`, `path:`, `file:`, `tag:#t`, `line:( )`, `section:( )`, `task-todo:`, `[prop:value]`. Returns files with match counts and line snippets. Takes `limit`, `case_sensitive` and `snippets_per_file`. |
| `read_note` | Returns a whole note, one heading's section (`heading`, nested as `Parent#Child`), or one block (`block: "^id"`). |
| `list_notes` | Lists notes under a `folder` (recursive), filtered by `glob` (`*`, `**`, `?`; a glob without `/` matches the file name). Takes `limit`, `sort: path \| modified` and `include_attachments`. |
| `backlinks` | Lists notes that link to or embed a file, with the line and context of each reference. |
| `outgoing_links` | Lists a note's resolved targets with counts, plus its unresolved link targets. |
| `tags` | Without `path`: every tag in the vault with counts. With `path`: that note's tags. |
| `properties` | Without `path`: every property name with the number of notes that use it. With `path`: that note's frontmatter as JSON. |
| `create_note` | Creates a new note and any missing folders. Fails if the note exists. |
| `edit_note` | Either `old_string` → `new_string`, where old_string must match exactly once, or `heading`/`block` + `content` to replace one section or block. |
| `append_note` | Appends to the end of a note, or to the end of a heading's section. With `create_if_missing` it creates the note first. |
| `set_property` | Sets one frontmatter property, or removes it when the value is `null`. Only that property's lines change, so other properties and their comments stay as they are. Frontmatter is created if the note has none. |
| `rename_note` | Renames or moves a note or attachment and updates every link to it across the vault. It uses the same rules as the app and `vault rename`, and follows the vault's `newLinkFormat` setting. |
| `daily_note` | `read`, `create` or `append` the daily note for `today`, `yesterday`, `tomorrow` or `YYYY-MM-DD`. Folder, date format and template come from `.obsidian/daily-notes.json`. |

You can refer to notes by vault-relative path (`Projects/Alpha.md`), by the
path without `.md`, or by a bare name that resolves the way a `[[wikilink]]`
does. When a note is not found, the error suggests similar paths.

Tool results carry `structuredContent` plus the same JSON as text.
`read_note` is the exception: it returns only the Markdown. Two kinds of
failure are kept apart:

- **Tool errors** (`isError: true`) cover things the model can fix: a missing
  note, a heading that is not in the note, an `old_string` that matches 0 or
  more than once, an invalid path, or a bad search query. The message says
  what to do next, for example by listing the note's headings.
- **Protocol errors** (`-32602`) cover an unknown tool name, or a write tool
  called while the server runs with `--read-only`.

**Resources:** every note is available as `vault://<percent-encoded path>`
with MIME type `text/markdown`. The server supports `resources/list`
(paginated in pages of 1000), `resources/read` and one template,
`vault://{+path}`.

## Security model

The server is a local process running with your user's permissions. Its
authority is limited to the vault folder you name on the command line.

- **Path confinement.** A path from a client must be vault-relative. The
  server rejects absolute paths (`/…`, `C:…`, `~`), `.` and `..` segments, NUL
  characters, and any segment that starts with `.`. That last rule makes
  `.obsidian`, `.trash`, `.git` and dot-files unreachable through every tool
  and resource. Before any read or write, the deepest existing part of the
  path is resolved with `canonicalize`, and the operation is refused unless
  that resolved path is still inside the vault. A symlinked folder that points
  outside the vault is therefore refused. Symlinked files and folders are
  never indexed or listed, and the writer refuses to replace a symlink.
- **`.obsidian/` is off limits.** The server reads `app.json`
  (`newLinkFormat`, for rename), `daily-notes.json` and `templates.json` (date
  formats). It never writes there. Paths computed from those settings, such as
  the daily-notes folder, go through the same confinement check as client
  paths.
- **`--read-only`.** The write tools are left out of `tools/list`, and calling
  one is a protocol error. `daily_note` stays available, but only with
  `action: "read"`.
- **Writes are atomic.** The new content is written to a temporary dot-file in
  the same folder, flushed to disk with `fsync`, and renamed over the target,
  so no reader ever sees a half-written note. The server keeps the existing
  file's permissions.
- **Encoding is preserved.** Notes are decoded as strict UTF-8. The server
  refuses to read or edit a file that is not valid UTF-8, rather than
  replacing characters. A UTF-8 BOM and CRLF line endings are detected, edits
  are made on `\n` text, and the file is written back with its original BOM
  and line endings. A rename only rewrites links in files whose bytes on disk
  still match the index; otherwise the whole rename is refused before anything
  changes.
- **No network, no shell.** The server never makes network requests or runs
  shell commands. Its only subprocess is `date +%z`, which gives the local
  time-zone offset for daily notes. Set `VAULT_TZ_OFFSET_MINUTES` to skip it.
- **The model is not the user.** Tool annotations tell clients which tools are
  safe to call: read tools are marked `readOnlyHint`, while `edit_note` and
  `set_property` are marked `destructiveHint`. Clients such as Claude Code ask
  for approval before calling a tool unless you allow it. Use `--read-only`
  for vaults an agent should only look at. Note text is data written by
  whoever wrote the note. A note can contain instructions aimed at the model
  (prompt injection), so review write operations on vaults with content from
  untrusted sources.

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
appear as `mcp__notes__search`, `mcp__notes__read_note` and so on.

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
  lists are `public`, and note contents are `private` with a TTL of 0. A
  resource that is not found gets `-32602`.
- **`2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (handshake).**
  `initialize` agrees on the client's version when the server knows it, and
  otherwise on `2025-11-25`. Results have no `resultType`, `ping` is
  answered, and a resource that is not found gets `-32002`. A request without
  modern `_meta` is also served this way when no `initialize` came first,
  which keeps simple scripts working.

The server does not use listChanged notifications, subscriptions, prompts,
sampling, elicitation or logging. JSON-RPC batches are rejected with
`-32600`, as the protocol has not allowed them since 2025-06-18.

## Why a hand-written server instead of the Rust SDK

The official Rust SDK, [`rmcp`](https://crates.io/crates/rmcp) (Apache-2.0,
`modelcontextprotocol/rust-sdk`, v3.4 in September 2026), is maintained and
widely used. It is still the wrong fit for this binary:

- **Size and dependencies.** `rmcp` always depends on `tokio`, `futures`,
  `tokio-util`, `tracing`, `thiserror`, `chrono` and `indexmap`, and its
  server macros add `schemars`. `vault` is a small synchronous binary built
  for size (`opt-level = "s"`, LTO) that avoids even `clap`. The stdio
  transport is one JSON message per line, which needs nothing beyond the
  `serde_json` the workspace already uses. This server added **no new
  dependencies**.
- **No async runtime needed.** `VaultIndex` is deliberately single-threaded:
  it caches link tables in `Rc<RefCell<…>>`, so it is not `Send`. Requests on
  stdio arrive one at a time, and a blocking loop fits exactly. An async SDK
  would need the index to be restructured or kept on a local-set thread.
- **Spec churn.** Revision `2026-07-28` replaced the `initialize` handshake
  with per-request `_meta` and added `server/discover`, `resultType` and
  caching fields. Supporting both generations in one place, which is what
  current Claude Code, Claude Desktop and older clients need, is about 400
  lines here (`crates/vault-cli/src/mcp/mod.rs`). With `rmcp` it would depend
  on the SDK's release timing.

The cost is that protocol changes must be followed by hand. The unit tests
pin both generations (`legacy_handshake_and_calls`,
`modern_stateless_requests`), and `crates/vault-cli/tests/mcp_stdio.rs`
drives the real binary over pipes. If the server later needs HTTP transport
or OAuth, switching to `rmcp` becomes worth reconsidering.

## Code map

- `crates/vault-cli/src/mcp/mod.rs`: the JSON-RPC loop, protocol eras,
  resources, and index refresh.
- `crates/vault-cli/src/mcp/tools.rs`: tool schemas and implementations, plus
  the section, block, frontmatter and glob helpers.
- `crates/vault-cli/src/mcp/fsx.rs`: path confinement, UTF-8/BOM/CRLF
  handling, and atomic writes.
- `crates/vault-cli/src/mcp/tests.rs` and `crates/vault-cli/tests/mcp_stdio.rs`:
  the tests.
