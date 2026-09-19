# OpenObsidian — market research: demand and supply

Researched 2026-09-13. Every GitHub star count, plugin count and forum number below was pulled live that day, from the GitHub API, `obsidianmd/obsidian-releases` JSON, the Discourse JSON API on forum.obsidian.md, the HN Algolia API and crates.io/npm. If a number came from a third party and not from a primary source, the text says so. Matrix cells marked `?` could not be verified and should be checked before anyone quotes them.

---

## 1. Obsidian today

### 1.1 Company, users, revenue

| Fact | Value | Source / confidence |
|---|---|---|
| Developer | Dynalist Inc. (founders Shida Li, Erica Xu; CEO Steph Ango since Feb 2023) | [Wikipedia](https://en.wikipedia.org/wiki/Obsidian_(software)) |
| Team | 7 people, about 3 engineers, no outside funding | Ango on [Dialectic podcast, 2025-02-03](https://jacksondahl.com/dialectic/steph-ango); [36kr, 2026](https://eu.36kr.com/en/p/3755031628005892) |
| Users, 2023 | "approximately one million users based on GitHub download counts" | [Fast Company, 2023-10-13](https://www.fastcompany.com/90960653/why-people-are-obsessed-with-obsidian-the-indie-darling-of-notetaking-apps) |
| Users, Feb 2025 | "I don't actually know how many users we have, but we probably have three or four million users, and we're seven people." | Steph Ango, [Dialectic ep. 8](https://jacksondahl.com/dialectic/steph-ango), primary |
| Users, 2026 | ">1.5 million monthly active users" | [BigGo Finance, 2026-04-06](https://finance.biggo.com/news/iVboYp0Bga3fZL9MJEv_), [note.com](https://note.com/petabyte_ai/n/n080904290d98?hl=en). No primary source; Obsidian runs no analytics, so treat this as an estimate |
| Revenue | "~$25M ARR", "$350M valuation" | [BigGo](https://finance.biggo.com/news/iVboYp0Bga3fZL9MJEv_), [36kr](https://eu.36kr.com/en/p/3755031628005892). Third-party estimates, unsourced |
| Community plugin downloads | 147.7M total across 7,616 plugins | `community-plugin-stats.json`, pulled 2026-09-13. The official blog said "passed 120 million" in May 2026 ([blog](https://obsidian.md/blog/future-of-plugins/)) |
| Latest release | 1.13.6 stable (2026-08-10) | Wikipedia |

A fair working range is 1.5M monthly active users and 3–5M lifetime users.

### 1.2 Pricing, September 2026

The core app is free for everyone. It is closed source: an Electron app on desktop and a Capacitor app on mobile. Paid add-ons, from [obsidian.md/pricing](https://obsidian.md/pricing):

| Product | Annual billing | Monthly billing | Notes |
|---|---|---|---|
| Sync | $4 /user/mo | $5 /user/mo | E2E encryption, version history, shared vaults. The pricing page now shows a single "from $4" card. The help docs still list **Standard** (1 vault, 1 GB, 5 MB max file, 1-month history) and **Plus** (10 vaults, 10–100 GB, 200 MB file, 12-month history; historically $8/mo annual) ([help](https://github.com/obsidianmd/obsidian-help/blob/master/en/Obsidian%20Sync/Plans%20and%20storage%20limits.md), [Standard plan blog](https://obsidian.md/blog/standard-plan/)) |
| Publish | $8 /site/mo | $10 /site/mo | Hosted site with graph and search |
| Catalyst | $25 one-off | — | Early-access builds, badge |
| Commercial licence | $50 /user/yr | — | **Optional since 2025-02-20** |
| Education/non-profit | 40% off Sync and Publish | | |

**Commercial licence change.** On 2025-02-20 Obsidian announced: "Obsidian is now free for work. Starting today, the Obsidian Commercial license is optional. Anyone can use Obsidian for work, for free." Before that, anyone at a company of two or more people was required to buy a $50/yr licence ([blog](https://obsidian.md/blog/free-for-work/), [X post](https://x.com/obsdmd/status/1892586092882276352)). The money now comes from Sync and Publish, plus donations dressed up as licences.

### 1.3 Relevant 2024–2026 product moves

- **Web Clipper** (MIT, open source), launched Oct 2024. It is the only large Obsidian component published under an OSI licence, along with Importer (1,654★), the API typings and the sample plugin.
- **Web viewer** core plugin (1.8.0, Dec 2024). It is an in-app browser, not a web version of Obsidian.
- **Bases**, database views over frontmatter (1.9, 2025).
- **Headless Sync client** `obsidian-headless` / `ob` CLI (2026-02-27): Sync can now run as a daemon on servers ([changelog](https://obsidian.md/changelog/2026-02-27-sync/)). An HN commenter's reaction: "This tool should finally make it possible to setup a good web interface to my obsidian notes… great if I want to read / write notes from a corporate laptop" ([HN](https://news.ycombinator.com/item?id=47200298)).
- **Obsidian Community directory** (2026-05-12). It runs automated security and quality scans on every plugin version, plans capability disclosures ("network, file system, clipboard") and "is not accepting new closed source plugins". It cleared a backlog of more than 2,300 queued submissions, which explains the plugin-count jump in §5.1 ([blog](https://obsidian.md/blog/future-of-plugins/), [HN discussion](https://news.ycombinator.com/item?id=48109970)).
- **Still missing:** a web app, a self-hosted server, an open-source core, and a plugin sandbox. Plugins have full Node/Electron access on desktop; see the 2025 security debate in [BigGo](https://biggo.com/news/202509200713_Obsidian_Plugin_Security_Concerns) and ["Be Careful with Obsidian" on HN](https://news.ycombinator.com/item?id=45679392).

---

## 2. Demand signals

### 2.1 Official forum threads (Discourse API, pulled 2026-09-13)

On forum.obsidian.md, likes on the first post act as votes.

| Thread | Created | OP votes | Posts | Views | Total likes | Last post | Status |
|---|---|---|---|---|---|---|---|
| [Obsidian for web](https://forum.obsidian.md/t/obsidian-for-web/2049) (#2049) | 2020-06-17 | **273** | 247 | **257,097** | 949 | 2026-09-04 | open, no official answer |
| [Open Sourcing of Obsidian](https://forum.obsidian.md/t/open-sourcing-of-obsidian/1515) (#1515) | 2020-06-09 | 179 | 295 | 130,209 | 1,955 | 2026-08-29 | open |
| [Obsidian Sync: Self-Hosted Server (on premise)](https://forum.obsidian.md/t/obsidian-sync-self-hosted-server-on-premise/20975) (#20975) | 2021-07-16 | 81 | 65 | 139,919 | 211 | 2026-04-14 | open |
| [Obsidian Remote: Running Obsidian in docker with browser-based access](https://forum.obsidian.md/t/obsidian-remote-running-obsidian-in-docker-with-browser-based-access/34312) (#34312) | 2022-03-19 | 12 | 13 | 57,061 | 19 | 2024-05 | showcase |
| [Self hosted Docker instance](https://forum.obsidian.md/t/self-hosted-docker-instance/3788) (#3788) | 2020-07-29 | 13 | 22 | 22,696 | 27 | 2024-10 | open |
| [Builds for ARM architectures](https://forum.obsidian.md/t/builds-for-arm-architectures/5942) (#5942) | 2020-09-20 | 10 | 12 | 4,023 | 38 | 2021 | closed (ARM builds shipped) |
| [Crash on Asahi / Raspberry Pi / arm64, 16K pages](https://forum.obsidian.md/t/99817) (#99817) | 2025-04-22 | — | 27 | 1,302 | 6 | 2025-08 | bug: Linux ARM rendering still breaks |
| [I need a Obsidian Web server service](https://forum.obsidian.md/t/97000) (#97000) | 2025-02-20 | 1 | 9 | 3,909 | 4 | 2026-06-04 | open |
| [Web Application](https://forum.obsidian.md/t/web-application/79000) (#79000) | 2024-03-21 | 0 | 2 | 2,651 | 0 | — | closed as duplicate of #2049 |

The #2049 web-app thread is the most-viewed thread these searches turned up, at 257k views. It has been open for 6+ years and people still post in it. Its top replies name the demand segments:

- Locked-down work machines (91 likes): "There are plenty companies that don't allow programs to be installed on the company computer. Having a browser-version is a way to make Obsidian work on these computers as well." ([post 5](https://forum.obsidian.md/t/obsidian-for-web/2049/5))
- Chromebooks and unsupported platforms (49 likes): "Chromebooks (lots of them out there) · Un-supported platforms… Raspberry Pi 4… Locked down corporate machines" ([post 6](https://forum.obsidian.md/t/obsidian-for-web/2049/6))
- Blocked sync services: "our firewall can detect torrent and P2P traffic… apps like Syncthing, Resilio" are blocked ([post 19](https://forum.obsidian.md/t/obsidian-for-web/2049/19))

### 2.2 Reddit (r/ObsidianMD, via the Arctic Shift archive; reddit.com blocks crawlers)

- ["Web Access!!"](https://www.reddit.com/r/ObsidianMD/comments/1mziz4m/web_access/) (2025-08-25): "this Bases is really amazing. But until Obsidian figures out a way to make this *also* fully web-based, it will always come second to Notion. As a professional working in a corporate environment, I can't just download and install it across the five companies I work with."
- ["Web browser version"](https://www.reddit.com/r/ObsidianMD/comments/1d80xvi/web_browser_version/) (2024-06-04): "My work won't allow us to install obsidian on our work PCs… Couldn't obsidian provide a web based application with sync that let's the md files stay on my work PC?"
- ["Prospective user – Question about Obsidian web access"](https://www.reddit.com/r/ObsidianMD/comments/1viyby6/prospective_user_question_about_obsidian_web/) (2026-08-08): a fiction writer who "cannot install Obsidian on my work computer" wants web access.
- ["How To Have Access To Vaults On The Web (Similar To Notion)"](https://www.reddit.com/r/ObsidianMD/comments/1bmp4dy/how_to_have_access_to_vaults_on_the_web_similar/) (2024-03-24) and ["Access through web"](https://www.reddit.com/r/ObsidianMD/comments/1i4yx88/access_through_web/) (2025-01-19).
- ["Why does closed-source Obsidian have 4x more plugins and themes than open-source Logseq?"](https://www.reddit.com/r/ObsidianMD/comments/12k8suu/why_does_closedsource_obsidian_have_4x_more/) (2023-04, 25 comments).

### 2.3 User complaints: closed source and no web version (verbatim)

1. **HN, sdevonoes, 2026-04-11** ([link](https://news.ycombinator.com/item?id=47730288)): "I really want to use Obsidian but it being closed source is a big No for me. I know I can keep all my files in plain text and move on to another platform but the thing is: if a bunch of files and a FS were enough for me to keep my KB, then ofc I wouldn't need something like Obsidian."
2. **HN, colordrops, 2025-08-19** ([link](https://news.ycombinator.com/item?id=44955693)): "And obsidian is not open source either. If you rely on any of the functionality besides just raw text editing, you may lose it one day."
3. **HN, agnishom, 2025-06-08** ([link](https://news.ycombinator.com/item?id=44215804)): "Obsidian is not open source, and the core is maintained by a small group of people, rather than a community. What happens when the company dies?"
4. **HN, antiframe, 2026-05-13**, on the plugin-security post ([link](https://news.ycombinator.com/item?id=48128606)): "Obsidian not being open source makes it harder to verify their security model."
5. **Forum #1515 OP, 2020** (179 votes): "while it's stated that the app only transmits the 'software version' info back to the server, there is no way to confirm…" ([link](https://forum.obsidian.md/t/open-sourcing-of-obsidian/1515)). A later reply with 22 likes reads in full: "Logseq is open source. Bye!" ([post 209](https://forum.obsidian.md/t/open-sourcing-of-obsidian/1515/209))
6. **Reddit "Web Access!!"** (§2.2) for the missing web version, and **HN bshaughn, 2026-02-28** (§1.3).

Counter-signal, for balance: plenty of users say an open file format makes the closed core acceptable. For example: "Obsidian may not be open source, but its file format is definitely more open than Joplin's" ([HN](https://news.ycombinator.com/item?id=48186158)), and "I was also not aware Obsidian is not open source" ([HN](https://news.ycombinator.com/item?id=48180362)). Being open source alone does not pull people away from Obsidian. A browser build plus plugin compatibility is the stronger wedge.

### 2.4 Complaints about competitors (verbatim)

1. **Logseq, slow and stagnant.** HN Valodim, 2026-07-13, on the 2.0 beta ([link](https://news.ycombinator.com/item?id=48896645)): "Logseq remained a buggy mess, is now on an unmaintained (thus insecure) version of electron. And now after several years of complete stagnation, the supposed improvement is a database format to fix their technical issues, so I can no longer keep all my data as markdown files?"
2. **Logseq, performance.** HN holowoodman, 2026-05-26 ([link](https://news.ycombinator.com/item?id=48276696)): "Logseq is cool, but the desktop client is slow and keyboard usability is low." HN setopt, 2026-07-13 ([link](https://news.ycombinator.com/item?id=48898981)): "the interface was slow and buggy". Older forum threads: [Very slow performance with large (local) graph](https://discuss.logseq.com/t/very-slow-performance-with-large-local-graph/1484) and [performance very bad as graph grows](https://discuss.logseq.com/t/logseq-performance-very-bad-as-graph-grows/22314).
3. **Logseq, left the browser.** HN flkiwi, 2026-07-13 ([link](https://news.ycombinator.com/item?id=48898192)): "After Logseq moved to an app focus and abandoned the 'edit anywhere' convenience of being browser-based, I lost interest… Lives in a browser, editable from anything with a browser… No more fooling with sync solutions or not being able to install an app on certain devices."
4. **SilverBullet, needs a server.** [LWN review](https://lwn.net/Articles/1030941/): "Despite being a single-user application, SilverBullet is written as a self-hosted web app and is distributed as a standalone server executable." Offline is only partial, per GitHub issue [#1702 "Offline mode sometimes requires a manual reload"](https://github.com/silverbulletmd/silverbullet/issues/1702) and a user on HN: "works offline (mostly)" ([link](https://news.ycombinator.com/item?id=48180654)). The author also sells a separate desktop wrapper, [SilverBullet+](https://silverbullet.plus), to remove the server step. That product is itself evidence of the gap.

### 2.5 Existing workarounds: people already run Obsidian in a browser

| Project | What it does | Stars / pulls | Licence | Caveat |
|---|---|---|---|---|
| [sytone/obsidian-remote](https://github.com/sytone/obsidian-remote) | Docker; the full desktop app streamed to the browser (KasmVNC-style remote desktop) | 2,631★ | MIT (wrapper) | Pixel streaming, server needed, weak on mobile |
| [linuxserver/docker-obsidian](https://github.com/linuxserver/docker-obsidian) | Same idea on the Selkies base image (formerly KasmVNC), GPU optional | 909★; Docker Hub `linuxserver/obsidian` 517k pulls (most pulls go through lscr.io/ghcr, so this undercounts) | GPL-3.0 | Streaming, HTTPS self-signed, server needed |
| [Nystik-gh/ignis](https://github.com/Nystik-gh/ignis) | Electron-API shim that runs Obsidian's **own JS bundle** in a real browser; the vault stays on a server. "Most community plugins… Plugins needing Node native modules or child_process do not load." | 1,404★; `nobbe/ignis` 159k pulls | none declared | Downloads Obsidian's proprietary code at runtime, cannot be hosted publicly, no auth built in |
| [MusiCode1/markport](https://github.com/MusiCode1/markport) (formerly `obsidian-web`) | Loads Obsidian's unmodified `app.js` in a browser with Node/Electron/Capacitor shims; vault in **OPFS or `showDirectoryPicker` folder**. "There is no public instance. Hosting one would mean serving Obsidian's own application code to strangers." | 144★ | GPL-3.0 | Same legal ceiling. Renamed at Obsidian's request |
| [xnohat/webobsidian](https://github.com/xnohat/webobsidian) | Clean-room self-hosted web app over a real vault: CM6 live preview, graph, search, git sync, "community-plugin support… against an Obsidian-API compatibility shim (subset support)" | 253★ (created 2026-06) | MIT | Server plus password; subset API |
| [vrtmrz/obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync) | Self-hosted sync plugin (CouchDB/S3/WebRTC P2P, E2E) | 12,318★ | MIT | Sync only, not a web UI |
| [secure-77/Perlite](https://github.com/secure-77/Perlite) | Read-only web viewer for vaults | 1,980★ | MIT | Read-only |
| [Screen.garden](https://screen.garden/) | Hosted multiplayer + "web access for Obsidian" (Show HN 2025-04) | — | proprietary | Hosted |
| Plugin [Quilden](https://forum.obsidian.md/t/112544) | "Free Obsidian sync plugin with E2E… and a decent web editor" (2026-03) | — | ? | New |

**What the workarounds prove.** Ignis and Markport show that the Obsidian renderer plus most community plugins *can* run in a browser once Node and Electron are shimmed. Separately, 89% of the 299 most-downloaded plugins I checked do not set `isDesktopOnly`, so they already run on Obsidian mobile, which has no Node (see §5.2). Neither project can ship publicly, because the core is proprietary. A clean-room, API-compatible open core is the unoccupied position.

---

## 3. Supply: open-source (and "open-ish") alternatives

### 3.1 Summary table (stars pulled 2026-09-13)

| Project | Licence | ★ | Stack | Storage | Browser/web | Plugin ecosystem | Obsidian plugin compat |
|---|---|---|---|---|---|---|---|
| **Obsidian** (reference) | Proprietary | (obsidian-releases 21.5k) | Electron/TS, Capacitor | Markdown files | **No** | **7,616 plugins, 753 themes** | — |
| [Logseq](https://github.com/logseq/logseq) (file "OG") | AGPL-3.0 | 44,893 | ClojureScript, Electron | Markdown/Org files (outliner dialect) | Old demo via File System Access; [Docker web app](https://github.com/logseq/logseq/blob/master/docs/docker-web-app-guide.md) | ~500 plugins + ~116 themes (618 marketplace packages) | No |
| Logseq **DB** (2.0 beta, 2026-07-13) | AGPL-3.0 | (same repo) | CLJS + SQLite | **SQLite DB** is canonical; optional markdown mirror | Web app (app.logseq.com, browser storage) | Same marketplace, API changes | No |
| [SilverBullet](https://github.com/silverbulletmd/silverbullet) | MIT | 6,043 | TS client + server binary | Markdown files on server | **Yes (PWA), but a server is required** | Space Lua scripts/"libraries", no marketplace comparable to Obsidian's | No |
| [Joplin](https://github.com/laurent22/joplin) | AGPL-3.0-or-later (server has its own licence) | 56,352 | TS/Electron, React Native | SQLite DB (markdown inside) | **Web app open beta** since Sept 2025 at app.joplincloud.com (mobile app on react-native-web, OPFS + `showDirectoryPicker`) ([docs](https://joplinapp.org/help/apps/web/)) | 351 plugins | No |
| [Zettlr](https://github.com/Zettlr/Zettlr) | GPL-3.0 | 13,507 | TS/Electron, CM6 | Markdown files | No ([#357](https://github.com/Zettlr/Zettlr/issues/357)) | None | No |
| [Foam](https://github.com/foambubble/foam) | MIT | 17,400 | VS Code extension | Markdown files | Partial via vscode.dev | VS Code extensions | No |
| [Dendron](https://github.com/dendronhq/dendron) | Apache-2.0 | 7,467 | VS Code extension | Markdown files (hierarchies) | No | VS Code | No. **Maintenance mode since 2023** ([post](https://randomgeekery.org/post/2023/02/dendron-is-officially-in-maintenance-mode/)) |
| [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy) | AGPL-3.0 | 76,624 | Flutter + Rust | DB (CRDT, SQLite) | Yes (AppFlowy Web/Cloud) | No public plugin marketplace | No |
| [Anytype](https://github.com/anyproto/anytype-ts) | Any Source Available License 1.0 (not OSI) | 8,800 | TS/Electron + Go heart | Object DB, P2P CRDT | **No web app** | API only | No |
| [SiYuan](https://github.com/siyuan-note/siyuan) | AGPL-3.0 | 46,335 | Go kernel + TS | `.sy` JSON block files (not markdown) | Via self-hosted server/Docker | **502 plugins, 54 themes** (bazaar) | No |
| [Trilium Notes (TriliumNext)](https://github.com/TriliumNext/Trilium) | AGPL-3.0 | 37,825 | TS/Electron + Node server | SQLite DB | Yes (server edition) | JS scripting/widgets, no marketplace | No |
| [Notesnook](https://github.com/streetwriters/notesnook) | GPL-3.0 | 14,587 | TS, React Native | Encrypted DB | Yes (web app) | None | No |
| [Outline](https://github.com/outline/outline) | BSL 1.1 (not OSI) | 40,531 | TS/React, Postgres | Postgres | Web-only team wiki | Server-side integrations | No |
| [AFFiNE](https://github.com/toeverything/AFFiNE) | MIT (client) + separate backend licence | 72,537 | TS, BlockSuite, Rust (y-octo) | CRDT DB | Yes | None public | No |
| [Standard Notes](https://github.com/standardnotes/app) | AGPL-3.0 | 6,627 | TS | E2E-encrypted DB | Yes | Editors/"plugins" (paid tier) | No |
| [Tangent](https://github.com/suchnsuch/Tangent) | Apache-2.0 | 550 | Svelte/Electron | Markdown files | No | None | No |
| [Athens Research](https://github.com/athensresearch/athens) | EPL-1.0 | 6,300 | Clojure | Datascript | Was web-capable | — | **Dead**: last push 2023-02 |
| [Lokus](https://github.com/lokus-ai/lokus) | **FCL-1.0-MIT (Fair Source, not OSI)** | 794 | Tauri/Rust + JS | Markdown files | Not yet (a `Lokus-Web` repo appeared Aug 2026) | Own marketplace | No ("point Lokus at your vault") |
| "Otterly" | — | — | — | — | — | — | **Not found** under this name on GitHub, crates, HN or the web |
| "Notemd" | MIT | 308 | TS | — | — | — | It is an Obsidian **plugin** ([Jacobinwwey/obsidian-NotEMD](https://github.com/Jacobinwwey/obsidian-NotEMD), LLM knowledge-base helper), not an alternative app |

### 3.2 2025–2026 "open-source Obsidian alternative" launches (HN Show HN, Algolia API)

| Launch | HN pts / comments | Repo ★ | Licence | Stack / shape | Obsidian compat claim |
|---|---|---|---|---|---|
| [Files.md – Open-source alternative to Obsidian](https://news.ycombinator.com/item?id=48179677) (2026-05-18) | **730 / 356** | [zakirullin/files.md](https://github.com/zakirullin/files.md) 4,143 | MIT | Go, minimal .md app | Plain markdown only, no plugins |
| [OpenKnowledge – AI-first alternative to Obsidian/Notion](https://news.ycombinator.com/item?id=48675435) (2026-06-25) | 381 / 173 | [inkeep/open-knowledge](https://github.com/inkeep/open-knowledge) 4,202 | **GPL-3.0** | TS markdown IDE + web viewer | Markdown vaults; own MCP/skills |
| [Tolaria – macOS app to manage Markdown knowledge bases](https://news.ycombinator.com/item?id=47882697) (2026-04-23) | 318 / 142 | [refactoringhq/tolaria](https://github.com/refactoringhq/tolaria) **19,770** | **AGPL-3.0** | Desktop (macOS/Win/Linux) | Markdown KBs, no plugin API |
| [Atomic Editor – Obsidian-style live preview for CodeMirror 6](https://news.ycombinator.com/item?id=48345201) (2026-05-31) | 67 / 19 | [kenforthewin/atomic-editor](https://github.com/kenforthewin/atomic-editor) 140 | MIT | React + CM6 component | Editor only |
| [Opal Editor – free Obsidian alternative](https://news.ycombinator.com/item?id=46669478) (2026-01-18) | 36 / 6 | [rbbydotdev/opal](https://github.com/rbbydotdev/opal) 89 | MIT | **Browser-first**, git-enabled, CM6 + mdx-editor | No plugins |
| [Ekphos – Rust TUI markdown research tool](https://news.ycombinator.com/item?id=46287722) (2025-12-16) | 34 / 15 | hanebox/ekphos | MIT | Rust TUI | — |
| [Kimün – TUI, Obsidian compatible, Vim friendly](https://news.ycombinator.com/item?id=48542513) (2026-06-15) | 2 / 0 | [nico2sh/kimun](https://github.com/nico2sh/kimun) 57 | MIT | Rust TUI | Vault-compatible |
| [Nimbalyst – "open source Obsidian, Codex app, and Linear"](https://news.ycombinator.com/item?id=48108137) | 7 / 1 | [nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst) 1,707 | MIT | Agent workspace | — |
| [Plainva](https://github.com/plainva/plainva) (2026-07) | — | 36 | AGPL-3.0 | Desktop | "Every file it writes must still open in Obsidian" |
| [WebObsidian](https://github.com/xnohat/webobsidian) (2026-06) | — | 253 | MIT | Self-hosted web | Subset plugin shim (§2.5) |
| [Alexandrie](https://github.com/Smaug6739/Alexandrie) | — | 2,738 | MIT | Vue, multi-tenant server | "Notion, Obsidian & Confluence alternative" |
| [SoloMD](https://www.xda-developers.com/opened-obsidian-vault-in-open-source-markdown-alternative-does-what-obsidian-needs-plugins-for/) | — | ? | MIT | Desktop + AI panel | Opens vault as-is |

The 730-point Files.md thread shows HN still rewards anything framed as an "open-source Obsidian alternative". None of these 2025–2026 launches offers Obsidian **plugin** compatibility **and** a browser build. Only Ignis and Markport run plugins, and both depend on Obsidian's proprietary bundle.

### 3.3 Feature matrix

Legend: ✅ yes/native · 🧩 via plugin/extension · ◐ partial/limited · ❌ no · ? unverified. Prices are the cheapest paid tier, where one exists.

| # | Feature | Obsidian | Logseq (file) | Logseq DB | SilverBullet | Joplin | Zettlr | Foam | AppFlowy | Anytype | SiYuan | Trilium | Notesnook | AFFiNE | Standard Notes | Lokus | **OpenObsidian target** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Open source (OSI) | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ◐ | ✅ | ❌ (Fair Source) | ✅ |
| 2 | Plain markdown files on disk | ✅ | ◐ dialect | ❌ (mirror) | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| 3 | Wikilinks `[[ ]]` | ✅ | ✅ | ✅ | ✅ | 🧩 | ✅ | ✅ | ◐ mentions | ◐ | ✅ | ◐ | ◐ | ◐ | ❌ | ✅ | ✅ |
| 4 | Heading/block links `#`, `#^id` | ✅ | ✅ (block refs) | ✅ | ◐ | ❌ | ◐ | ◐ | ❌ | ❌ | ✅ | ❌ | ❌ | ◐ | ❌ | ? | ✅ |
| 5 | Embeds / transclusion `![[ ]]` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ◐ | ◐ | ◐ | ✅ | ✅ (include) | ❌ | ◐ | ❌ | ? | ✅ |
| 6 | Backlinks panel | ✅ | ✅ | ✅ | ✅ | 🧩 | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ◐ | ✅ | ❌ | ✅ | ✅ |
| 7 | Graph view | ✅ | ✅ | ✅ | 🧩 | 🧩 | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ (note map) | ❌ | ❌ | ❌ | ✅ | ✅ |
| 8 | Canvas / whiteboard | ✅ JSON Canvas | ✅ whiteboards | ? | ❌ | 🧩 | ❌ | ❌ | ◐ board | ❌ | 🧩 | ✅ (canvas note) | ❌ | ✅ edgeless | ❌ | ✅ tldraw | ✅ JSON Canvas |
| 9 | Database views (Bases-like) | ✅ Bases | ◐ queries | ✅ | ✅ Lua queries | ❌ | ❌ | ❌ | ✅ grid/board/calendar | ✅ sets | ✅ attribute views | ◐ collections | ❌ | ✅ | ❌ | ✅ | ✅ `.base` files |
| 10 | Frontmatter/typed properties | ✅ | ◐ | ✅ typed | ✅ | ❌ | ✅ YAML | ✅ | ✅ | ✅ | ✅ | ✅ attributes | ❌ | ◐ | ❌ | ? | ✅ |
| 11 | Plugin API + marketplace | ✅ 7,616 | ✅ ~500 | ✅ | ◐ Lua libs | ✅ 351 | ❌ | 🧩 VS Code | ❌ | ❌ | ✅ 502 | ◐ scripts | ❌ | ❌ | ◐ | ✅ own | ✅ **Obsidian API-compatible** |
| 12 | Themes / CSS snippets | ✅ 753 | ✅ ~116 | ✅ | ◐ | ✅ | ◐ CSS | 🧩 | ◐ | ❌ | ✅ 54 | ✅ | ◐ | ◐ | ✅ | ✅ | ✅ Obsidian-compatible |
| 13 | Web app (browser) | ❌ | ◐ | ✅ | ✅ (server) | ◐ beta | ❌ | ◐ vscode.dev | ✅ | ❌ | ◐ (server) | ✅ (server) | ✅ | ✅ | ✅ | ❌ | ✅ **serverless** |
| 14 | Works fully offline | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ desktop | ✅ | ✅ | ✅ | ✅ | ✅ PWA |
| 15 | Opens an existing local folder in the browser | ❌ | ◐ (FSA, Chrome) | ❌ | ❌ | ◐ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ Chromium; import elsewhere |
| 16 | Desktop app | ✅ | ✅ | ✅ | ◐ (SB+) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ PWA (later Tauri) |
| 17 | Mobile app | ✅ | ✅ | ✅ iOS | ◐ PWA | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ◐ mobile web | ✅ | ✅ | ✅ | ? | ◐ PWA |
| 18 | Linux ARM / Chromebook / RPi | ◐ (bugs, §2.1) | ◐ | ◐ | ✅ (browser) | ◐ | ◐ | ✅ | ◐ | ◐ | ✅ | ✅ | ✅ web | ✅ web | ✅ web | ◐ | ✅ (any browser) |
| 19 | First-party sync | ✅ paid | ✅ paid | ✅ paid RTC | ✅ (server) | ✅ Cloud/any | ❌ | ❌ | ✅ | ✅ P2P | ✅ paid | ✅ self-host | ✅ | ✅ | ✅ | ◐ | ◐ BYO (git/WebDAV/S3/LiveSync-compatible) |
| 20 | E2E-encrypted sync | ✅ | ✅ | ? | ❌ | ✅ | — | — | ❌ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ | ◐ | ✅ planned |
| 21 | Self-hostable sync | ❌ (🧩 LiveSync) | ◐ | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| 22 | Publish to web | ✅ $8/mo | ✅ | ✅ | ✅ | ◐ share | ◐ export | ◐ | ✅ | ✅ | ◐ | ✅ share | ✅ monographs | ✅ | ✅ Listed | ? | ✅ static export |
| 23 | Live preview editor (hide syntax) | ✅ | ◐ block WYSIWYG | ✅ | ✅ | ◐ rich markdown | ✅ | ◐ | ✅ WYSIWYG | ✅ WYSIWYG | ✅ WYSIWYG | ✅ WYSIWYG | ✅ WYSIWYG | ✅ | ◐ | ✅ | ✅ CM6 |
| 24 | Source mode | ✅ | ✅ | ◐ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ◐ | ✅ code notes | ❌ | ❌ | ✅ | ? | ✅ |
| 25 | Vim keybindings | ✅ | ◐ | ◐ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ◐ | ❌ | ❌ | ◐ | ? | ✅ |
| 26 | Math (LaTeX/KaTeX/MathJax) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ | ✅ | ✅ |
| 27 | Mermaid | ✅ | 🧩 | 🧩 | 🧩 | ✅ | ✅ | 🧩 | ? | ? | ✅ | ✅ | ? | ? | ❌ | ? | ✅ |
| 28 | Callouts `> [!note]` | ✅ | ❌ | ❌ | ✅ | 🧩 | ❌ | ◐ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ? | ✅ |
| 29 | Daily notes / journal | ✅ | ✅ | ✅ | ✅ | 🧩 | ❌ | ✅ | ❌ | ◐ | ✅ | ✅ | ❌ | ✅ journal | ❌ | ✅ | ✅ |
| 30 | Templates | ✅ (+Templater) | ✅ | ✅ | ✅ | 🧩 | ◐ snippets | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |
| 31 | Search operators (`path:`, `tag:`, `line:`, regex) | ✅ | ◐ | ✅ queries | ✅ | ✅ | ◐ | 🧩 | ◐ | ◐ | ✅ SQL | ✅ | ◐ | ◐ | ◐ | ◐ | ✅ Obsidian syntax |
| 32 | Outliner / block operations | 🧩 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ◐ | ❌ | ✅ | ❌ | ? | 🧩 via plugins |
| 33 | Official web clipper | ✅ MIT | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ? | ✅ | ✅ | ✅ | ✅ | ? | ✅ | ❌ | ✅ (fork of the MIT clipper) |
| 34 | PDF annotation | 🧩 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ? | 🧩 |
| 35 | Real-time collaboration | ◐ shared vaults | ❌ | ✅ RTC | ◐ | ◐ | ❌ | ❌ | ✅ | ✅ | ◐ | ◐ | ◐ | ✅ | ❌ | ❌ | ❌ (not v1) |
| 36 | AI features | 🧩 | 🧩 | ✅ CLI | 🧩 | ✅ | ❌ | 🧩 | ✅ | ✅ | ✅ | ◐ | ❌ | ✅ | ❌ | ◐ | 🧩 |
| 37 | Price of core | Free | Free | Free | Free | Free | Free | Free | Free | Free | Free | Free | Free | Free | Free | Free | Free |
| 38 | Cheapest paid tier | Sync $4/mo | Sync (paid) | Sync (paid) | SB+ (paid) | Joplin Cloud | — | — | Pro | Membership | Subscription | — | Pro | Pro | Productivity | — | none required |

Obsidian's own column comes from docs. Competitor columns come from project READMEs and docs plus the author's knowledge, spot-checked where linked. Cells marked `?` or ◐ for the less-documented apps (AppFlowy, AFFiNE, Anytype, Lokus) need a re-check before publication.

---

## 4. The structural gap

### 4.1 What Obsidian cannot do, given its business model

1. **Ship a web app without undercutting Sync.** A browser build needs the vault reachable from the browser. That means OPFS/local folder (Chromium-only for real folders) or a server. Obsidian's paid product *is* the server (Sync, Publish). A zero-server web client that reads a git/WebDAV/S3/local folder makes Sync optional. A hosted web client over Sync would break Sync's E2E story, because the server holds only ciphertext; forum moderator WhiteNoise makes exactly this point in [#2049 post 126](https://forum.obsidian.md/t/obsidian-for-web/2049/126). Six years of silence on the most-viewed feature request is consistent with that.
2. **Open-source the core.** The team has argued, since 2020, that it would slow a 3-engineer team and invite forks ([Obsidian Rocks](https://obsidian.rocks/why-isnt-obsidian-open-source/)). A fork of an open core with the same plugin API would compete directly with the paid services.
3. **Allow third parties to host Obsidian.** Ignis and Markport both decline to host a public instance because it "would mean serving Obsidian's own application code to strangers" (Markport README). Their reach stops at people who can run Docker or a setup script.
4. **Run on locked-down machines, Chromebooks and odd architectures.** It is an installed Electron binary. Linux ARM rendering still breaks as of 2025 ([#99817](https://forum.obsidian.md/t/99817)).
5. **Sandbox plugins.** Plugins have full Node access on desktop. The May 2026 directory changes add *disclosure* and scanning, not isolation ([blog](https://obsidian.md/blog/future-of-plugins/)). A browser host gets a sandbox for free: no `fs`, no `child_process`, CSP, and per-plugin workers or iframes are possible.

### 4.2 What the open alternatives lack

- **The plugin ecosystem.** Obsidian has 7,616 plugins and 753 themes. The next largest are Logseq (~500 + ~116 themes), SiYuan (502 + 54) and Joplin (351), each with an incompatible API. The most-downloaded Obsidian plugins are Excalidraw (7.96M), Templater (5.59M), Dataview (4.96M), Tasks (4.24M), Advanced Tables (3.19M), Git (3.14M), Calendar (3.10M), Style Settings (2.68M), Kanban (2.66M), Remotely Save (2.23M). Users replicate these workflows ("I have since built that workflow into obsidian through a bunch of templates and plugins", [HN](https://news.ycombinator.com/item?id=48278744)), and that is the lock-in, not the file format.
- **File-format fidelity.** Logseq DB, Joplin, SiYuan, Trilium, AppFlowy, Anytype, AFFiNE, Notesnook and Standard Notes all use a database, so a user cannot point them at a vault and keep editing in Obsidian as well. Logseq's move to SQLite in July 2026 drew a backlash (§2.4).
- **Serverless browser use.** The browser-capable options either need a server (SilverBullet, Trilium, SiYuan, Outline, Joplin sync) or keep data in their own DB. None opens an Obsidian vault folder directly in the browser and writes back to it.

### 4.3 Plugin and theme counts over time (from `obsidian-releases` git history)

| Date | Plugins | Themes |
|---|---|---|
| 2023-01-01 | 793* | 150 |
| 2024-01-01 | 1,371 | 226 |
| 2025-01-01 | 2,100 | 327 |
| 2025-07-01 | 2,511 | 366 |
| 2026-01-01 | 2,705 | 414 |
| 2026-06-01 | 4,330 | 541 |
| **2026-09-13** | **7,616** | **753** |

\*This is the length of `community-plugins.json` at the last commit before each date. The 2026 jump follows the May 2026 automated review, which cleared a backlog of more than 2,300 submissions. The often-quoted "~2,700" was accurate at the start of 2026 and is now stale.

---

## 5. Implications for OpenObsidian

### 5.1 Positioning

"Obsidian, in any browser, over your own folder, with your plugins" is an **Obsidian-API-compatible, open-source (MIT/Apache) client**. It does not compete with Obsidian's paid services. It works with plain vaults on local disk, git, WebDAV/S3 or LiveSync-compatible CouchDB. No current project occupies this position without redistributing Obsidian's proprietary bundle.

### 5.2 Feasibility evidence for plugin compatibility

- **Mobile-compatible share.** Of the 299 most-downloaded community plugins (83% of all downloads), **34 (11.4%) declare `isDesktopOnly: true`**; weighted by downloads that is 7.7%. The other ~89% already run on Obsidian mobile, which has no Node or Electron. They depend only on the `obsidian` module API and DOM. Method: manifests fetched from each repo's HEAD on 2026-09-13.
- **API surface.** The public `obsidian.d.ts` ([obsidian-api](https://github.com/obsidianmd/obsidian-api), MIT, 2,320★) is 8,498 lines with about 298 exported symbols. It is large but finite and versioned (`@since` tags).
- **Proof that plugins run in a browser.** Ignis ("most community plugins… plugins needing Node native modules or child_process do not load") and Markport already run real plugins there, though on Obsidian's own `app.js`.
- **Editor internals.** Plugins that touch CM6 internals read Obsidian's HyperMD-derived syntax-node names. A GitHub code search for `"hmd-internal-link" syntaxTree` returns 49 TypeScript hits in plugins such as Iconize, Metadata Menu and Codeblock Customizer. The clone must reproduce those token names, not just the rendered output; see clipper-and-browser-fs.md §4.

### 5.3 Risks

- **Trademark.** Obsidian's developer policies ask that project names not include "Obsidian". Markport was renamed from `obsidian-web` for this reason. "OpenObsidian" is exposed to the same request; pick the public name early.
- **Moving API target.** New features ship constantly: Bases, footnote caches since 1.8.7, the Community directory's capability declarations.
- **Chromium-only real-folder access.** Firefox and Safari opposed File System Access; see clipper-and-browser-fs.md §3. Most of the "work computer" segment runs Chrome or Edge, which softens this.
