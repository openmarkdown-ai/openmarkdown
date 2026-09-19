# Why OpenMarkdown

*(Working name. "Obsidian" is Dynalist Inc.'s trademark and cannot be the
product name; see "Risks".)*

## The problem

> "There are plenty companies that don't allow programs to be installed on the
> company computer. Having a browser-version is a way to make Obsidian work on
> these computers as well." — forum.obsidian.md #2049, 91 likes

Obsidian is the notes app a few million people have built their working lives
around: a folder of Markdown files, plus 7,616 community plugins and 753 themes
that turn it into a task manager, a database, a whiteboard. It is closed
source and ships only as an installed Electron or Capacitor app. The
most-viewed feature request on its forum — "Obsidian for web", open since June
2020, 257,097 views, 273 votes — has never had an answer. The second is "Open
Sourcing of Obsidian" (179 votes, 130,209 views).

## Who has it

- **People on locked-down machines** — corporate laptops, school Chromebooks,
  client sites — who cannot install software but can open a browser. They keep
  asking on Reddit ("My work won't allow us to install obsidian on our work PCs").
- **People on platforms Obsidian serves badly**: Linux ARM, Raspberry Pi,
  Chromebooks (forum #99817, rendering still broken in 2025).
- **People who will not trust a closed core** with years of notes, or with
  plugins that have full Node access (HN, May 2026: "Obsidian not being open
  source makes it harder to verify their security model").

What they do today: run the real Obsidian in Docker and stream its pixels to a
browser (obsidian-remote 2,631★; linuxserver/obsidian 517k+ pulls), or use
Ignis/Markport, which load Obsidian's own proprietary bundle and so cannot be
offered as a public site.

## What exists today

Condensed from `docs/research/market.md` §3.3 (38 rows) and
`docs/research/obsidian-features.md` (every core plugin, setting and command).

| Function | Obsidian | Logseq | SilverBullet | Joplin | Us | Class | Note |
|---|---|---|---|---|---|---|---|
| Plain Markdown folder on disk | ✓ | dialect | ✓ (server) | ✗ DB | ✓ | must | the vault is the product |
| Open an existing vault in a browser, write back | ✗ | ◐ | ✗ | ✗ | ✓ Chromium | must | File System Access API |
| No server | ✓ (desktop) | ✓ | ✗ | ✓ | ✓ | must | SilverBullet needs one |
| Wikilinks, heading/block links, embeds | ✓ | ✓ | ◐ | ✗ | ✓ | must | |
| Live preview + source + reading | ✓ | ◐ | ✓ | ◐ | ✓ | must | CodeMirror 6 |
| Backlinks, unlinked mentions, outline, tags | ✓ | ✓ | ✓ | 🧩 | ✓ | must | Rust index |
| Search operators (`path:` `tag:` `line:` regex) | ✓ | ◐ | ✓ | ✓ | ✓ | must | Rust query engine |
| Properties with types | ✓ | ◐ | ✓ | ✗ | ✓ | must | `types.json` |
| Daily notes, templates, quick switcher, command palette | ✓ | ✓ | ✓ | 🧩 | ✓ | must | |
| Graph view (global, local, groups, forces) | ✓ | ✓ | 🧩 | 🧩 | ✓ | must | Barnes–Hut in wasm |
| Canvas (JSON Canvas) | ✓ | whiteboards | ✗ | 🧩 | ✓ | must | open spec |
| Bases (`.base` database views) | ✓ | ◐ | ✓ Lua | ✗ | ✓ | must | Rust evaluator |
| **Obsidian community plugins, unmodified** | ✓ 7,616 | ✗ | ✗ | ✗ | ✓ (mobile-compatible set) | must | the wedge |
| **Obsidian themes and CSS snippets** | ✓ 753 | ✗ | ✗ | ✗ | ✓ | must | same DOM + variables |
| Web clipper to Markdown | ✓ MIT | ✗ | ✗ | ✓ | ✓ | must | Rust HTML→Markdown |
| Import from Evernote, Notion, Roam, Keep, Bear | 🧩 | ◐ | ✗ | ✓ | ✓ | edge | Rust importers |
| Publish to a website | $8/mo | ✓ | ✓ | ◐ | ✓ static export | edge | Rust site generator |
| Vim mode, math, Mermaid, callouts, footnotes | ✓ | ◐ | ✓ | ◐ | ✓ | must | |
| File recovery snapshots | ✓ | ✗ | ✗ | ✓ | ✓ | edge | IndexedDB |
| Sync | $4/mo | paid | server | ✓ | bring your own | edge | folder sync, git, LiveSync plugin |
| Real-time collaboration | ◐ | ✗ | ◐ | ◐ | ✗ | bloat (v1) | |
| Accounts, licences, telemetry | ✓ | ✓ | ✗ | ✓ | ✗ | bloat | |

## The gap

**Obsidian cannot ship this.** A serverless web client over the user's own
folder makes Sync — the business — optional, and a hosted client over Sync
breaks Sync's end-to-end encryption. Opening the core would hand a fork the
same plugin API. Six years of silence on the most-viewed request is consistent
with that.

**The open alternatives cannot either.** Every one of them has its own plugin
API (Logseq ~500 plugins, SiYuan 502, Joplin 351 — against 7,616), and most
store notes in a database, so a user cannot point them at a vault and keep using
Obsidian beside them. The lock-in is the plugin workflow, not the file format.

**The two projects that do run Obsidian plugins in a browser** (Ignis,
Markport) do it by loading Obsidian's proprietary `app.js`, so neither can be a
public website. A clean-room implementation of the MIT-licensed API is the
unoccupied position.

## Demand evidence

- Forum #2049 "Obsidian for web": 273 votes, 247 posts, 257,097 views, last post
  2026-09-04. #1515 "Open Sourcing of Obsidian": 179 votes, 130,209 views. #20975
  self-hosted sync: 81 votes, 139,919 views.
- Workarounds with real usage: obsidian-remote 2,631★, linuxserver/obsidian
  517k Docker pulls, Ignis 1,404★ / 159k pulls, obsidian-livesync 12,318★.
- HN rewards the category: "Files.md – open-source alternative to Obsidian"
  730 points / 356 comments (May 2026).
- Paid market: Obsidian Sync $4–5/month and Publish $8–10/month on an estimated
  1.5M monthly actives.
- Feasibility: of the 299 most-downloaded plugins, 89% already run without
  Node (they are not `isDesktopOnly`), because Obsidian mobile has none.

## Why us

- **A Rust core does the parts that are genuinely hard**: Obsidian Flavored
  Markdown with UTF-16 positions that match what plugins expect, link
  resolution and rename rewrites, the search query language, the Bases formula
  language, a force-directed layout for 20k-node graphs, HTML→Markdown and the
  importers — compiled once to WebAssembly for the browser and natively for the
  `vault` CLI.
- **The plugin API is implemented as the application**, not as a shim: every
  core feature is a plugin written against the same `App`/`Vault`/`Workspace`
  objects a community plugin receives, so the compatibility layer is exercised
  every time the app starts.
- **A browser host gives plugins a sandbox Obsidian desktop cannot**: no `fs`,
  no `child_process`, a page CSP.

## What we will not build (v1)

- A hosted sync service or accounts. Vaults live in a real folder, in browser
  storage, or wherever the user's own sync puts them.
- Real-time collaboration.
- Desktop-only plugins (`isDesktopOnly: true`, ~8% of downloads) — refused with
  a message, exactly as Obsidian mobile does.
- A general CORS proxy. Plugin downloads and `requestUrl` go through the
  optional companion extension or a proxy the user configures.
- Pop-out windows as separate OS windows (browsers cannot move a live DOM
  between windows reliably); they open as a split instead.

## Scorecard

| Gate | |
|---|---|
| Does not duplicate a suite territory | ✓ — no notes app in openapps/ (opensync-obsidian is a sync plugin *for* Obsidian) |
| No server, no account, no API key | ✓ — static site; network only for the plugin/theme store |
| Core is a pure function over files | ✓ — crates/vault-* have no I/O |
| Payoff in under 30 seconds | ✓ — "Open folder as vault" on an existing vault, or the demo vault |
| One-screenshot demo | ✓ — an existing Obsidian vault, with its theme and Dataview running, in a browser tab |
| Structural incumbent weakness | ✓ — Sync revenue and a closed core |

| Dimension | Score | Weight | |
|---|---|---|---|
| Demand | 5 | ×2 | 10 |
| Gap | 5 | ×2 | 10 |
| Fit (Rust/wasm core) | 4 | ×1 | 4 |
| Demo | 5 | ×1 | 5 |
| **Total** | | | **29 / 30** |

## Risks

- **Trademark.** The public name must not contain "Obsidian" (Markport and
  OpenObsidian→OpenOnyx were both renamed). Describe compatibility nominatively:
  "opens Obsidian vaults; runs many Obsidian community plugins".
- **Chromium-only real folders.** Firefox and Safari get browser storage with
  import/export. The locked-down-laptop segment is overwhelmingly Chrome/Edge.
- **A moving API.** 1.13 added a declarative settings API and a CLI; each
  release needs a pass over `obsidian.d.ts`.
- **Plugins that need CORS-free networking** (Git, Remotely Save, Copilot) need
  the companion extension or a proxy.

## Verdict

Build it: the demand is six years old and unanswered, the incumbent is
structurally unable to serve it, and the only route that reaches Obsidian's
plugin ecosystem without shipping Obsidian's code is the one this project takes.
