# Form factors — which products OpenMarkdown should be, and in what order

Researched 2026-09-17. Builds on `docs/research/market.md` (demand and supply,
2026-09-13) and `docs/why.md`; it does not repeat their numbers except where a
figure moved or a new one contradicts them.

Sources are primary wherever a primary exists. Live pulls on 2026-09-17: the
Google Play and App Store listing pages, `obsidianmd/obsidian-releases`
(`community-plugins.json`, `community-plugin-stats.json`), the GitHub API, the
Chrome Web Store listing pages, the HN Algolia API, forum.obsidian.md's
Discourse API, caniuse and StatCounter. **§9 lists, plainly, everything that
could not be verified.** Two of those gaps are load-bearing and should be closed
by experiment, not by more searching.

The repository state this is written against: 76k lines of Rust in `crates/`,
106k lines of TypeScript in `packages/app`, a **518-line** web shell in
`apps/web`, a 3.8k-line extension in `apps/clipper`, and a `vault` CLI with an
MCP server. No commits, no published site. This is a launch-sequencing
question, not a pivot.

---

## 1. Where Markdown/PKM users actually work

### 1.1 Installs and reviews, pulled live 2026-09-17

Google Play listing pages, scraped directly (`play.google.com/store/apps/details?id=…`):

| App | Play downloads | Rating | Reviews |
|---|---|---|---|
| Microsoft OneNote (`com.microsoft.office.onenote`) | **1B+** | 4.6 | 1.5M |
| Evernote (`com.evernote`) | **100M+** | 3.5 | 1.85M |
| Notion (`notion.id`) | **10M+** | 4.6 | 392K |
| **Obsidian** (`md.obsidian`) | **5M+** | **4.4** | **18.6K** |
| Joplin (`net.cozic.joplin`) | 500K+ | 3.9 | 7.11K |
| Notesnook (`com.streetwriters.notesnook`) | 100K+ | 4.5 | 6.98K |
| Anytype (`io.anytype.app`) | 100K+ | 4.0 | 1.17K |
| SiYuan (`org.b3log.siyuan`) | **10K+** | 4.7 | 180 |
| Logseq | **not found** on Play under `com.logseq.app` / `com.logseq.logseq` |

Apple App Store, via the iTunes Lookup API across all 44 storefronts, 2026-09-17:

| | Obsidian | Notion | Drafts | Bear | Logseq | SiYuan |
|---|---|---|---|---|---|---|
| **US ratings** | **2,711** (4.49★) | **90,133** | 10,769 | 6,857 | 264 | 29 |
| All storefronts | **9,146** | — | — | — | — | — |

The [US listing](https://apps.apple.com/us/app/obsidian-connected-notes/id1557175442)
shows 4.5★, #134 in Productivity, 39.6 MB, v1.13.7. Corroboration: Obsidian does
not appear in Apple's US Top-Free Productivity RSS chart (99 entries), where
Notion sits at #47 and Google Keep at #72
([feed](https://itunes.apple.com/us/rss/topfreeapplications/limit=200/genre=6007/json)).

**Obsidian has ~2× more Android ratings (18.6K) than iOS ratings worldwide
(9,146), and ~6.9× more than US iOS ratings.** For a Western developer-leaning
productivity tool that inverts the usual iOS skew. Notion's iOS app has **33×**
Obsidian's US ratings; Drafts — a capture-only tool with no desktop ambitions —
has 4×.

**Logseq is not on Google Play at all**, and the stated reason is a direct
warning for any native Android build of this project: *"the way Logseq accesses
the file system is not accepted by Play Store rules."* It ships APK + F-Droid
only ([F-Droid](https://f-droid.org/en/packages/com.logseq.app/),
[discuss.logseq.com](https://discuss.logseq.com/t/publish-android-beta-app-to-play-store/8217),
[issue #11083](https://github.com/logseq/logseq/issues/11083)). Its iOS app has
264 ratings and was last updated 2024-04-23.

Chrome Web Store, fetched 2026-09-17:

| Extension | Users | Rating | Ratings |
|---|---|---|---|
| [Obsidian Web Clipper](https://chromewebstore.google.com/detail/obsidian-web-clipper/cnjifjpddelmedmihgijeibhnjfabmlf) (official, MIT) | **1,000,000** | **4.8** | 571 |
| [Notion Web Clipper](https://chromewebstore.google.com/detail/notion-web-clipper/knheggckgoiihginacbkhaalnibhilkk) | 1,000,000 | **3.3** | 618 |
| [Evernote Web Clipper](https://chromewebstore.google.com/detail/evernote-web-clipper/pioclpoplcdbaefihamjohnefbikjilc) | 2,000,000 | 4.7 | 129.1K |
| [Raindrop.io](https://chromewebstore.google.com/detail/raindropio/ldgfbffkinooeloadekpmfoklnobpien) | 500,000 | 4.1 | 783 |
| Obsidian Web Clipper on [AMO](https://addons.mozilla.org/en-US/firefox/addon/web-clipper-obsidian/) | 64,503 | 4.9 | 290 |
| Obsidian Web Clipper on the [App Store](https://apps.apple.com/us/app/obsidian-web-clipper/id6720708363) (Safari) | — | 4.3 | 102 |

### 1.2 What those numbers say

**A correction to `market.md` §1.1 first: nobody knows how many users Obsidian
has, including Obsidian.** Steph Ango, [LinkedIn,
2025-07-18](https://www.linkedin.com/posts/stephango_no-one-knows-how-many-users-obsidian-has-activity-7351766158372429825-WH9p):
*"No one knows how many users Obsidian has. I think it's around 5-10 million
people but I'm not sure?"* — there is no account requirement and no built-in
analytics. The ">1.5M MAU" figure carried in `market.md` traces to [an X
post](https://x.com/aakashgupta/status/2040622458651529502) and is recycled from
there; it should be treated as folklore. The **only** company-published usage
figure anywhere is *"People in over 10,000 organizations use Obsidian for work"*
([blog, 2025-02-20](https://obsidian.md/blog/free-for-work/)). No
desktop-vs-mobile split, MAU, or Sync subscriber count has ever been published.

**Obsidian's mobile presence is large in installs and thin in engagement.**
5M+ Play downloads against "5–10 million people" total. Play "downloads" is
cumulative installs across devices and re-installs, so it cannot be read as
users. The engagement proxies are small: **18.6K Play reviews and 9,146 iOS
ratings worldwide** for an app with millions of installs, and **#134 in US
Productivity**. Obsidian mobile is a **companion to a desktop install**, not a
standalone product — and this is the pattern the whole sequencing decision turns
on.

**The single most striking figure in this whole document: Obsidian's browser
extension has as many users as Obsidian plausibly has.** 1,000,000 Chrome users
for the Web Clipper, against ~1.5M estimated MAU for the app. The clipper is
also (a) Obsidian's only browser-shaped product, (b) one of its only MIT-licensed
components, and (c) 4.8★ on 571 ratings. Obsidian will not ship a web app, but
it already ships a browser product, and that product reaches its entire user
base. **The browser is not a fringe channel for this audience; it is the only
channel Obsidian itself has been willing to enter.**

**Web-first competitors are an order of magnitude larger on mobile.** Notion,
which is web-first and has no local-folder story, has 10M+ Play installs and
392K reviews — 21× Obsidian's review count. That is what a web-first PKM product
looks like at scale, and it is the shape r/ObsidianMD users keep comparing
Obsidian to unfavourably (market.md §2.2: *"until Obsidian figures out a way to
make this also fully web-based, it will always come second to Notion"*).

**Traffic overall is a desktop/mobile coin flip.** StatCounter, August 2026,
worldwide: **Mobile 49.36%, Desktop 49.11%, Tablet 1.54%**
([source](https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet)).
That is the whole web, not this category; PKM skews desktop, but it sets the
ceiling on what a desktop-only product can reach.

### 1.3 The hard constraint that decides the mobile question

**The File System Access API does not exist on any mobile browser.**
[caniuse](https://caniuse.com/native-filesystem-api), 2026-09-17: global usage
**30.85%**; Chrome 105+ ✅, Edge 105+ ✅, **Firefox ❌ (all versions through
159), Safari ❌ (all through 27.1/TP), Safari iOS ❌, Chrome for Android ❌,
Samsung Internet ❌**. Mozilla's standards position is `negative`, the API
described as "harmful" ([standards-positions
#154](https://github.com/mozilla/standards-positions/issues/154), open since
2019). WebKit implemented only the OPFS half — `FileSystemDirectoryHandle`
exists but `showDirectoryPicker` does not
([WebKit blog](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/)).

Desktop browsers, StatCounter August 2026: Chrome 73.28%, Edge 10.46%, Firefox
5.31%, Safari 5.24%, Opera 1.99% → **Chromium ≈ 85.7% of desktop**
([source](https://gs.statcounter.com/browser-market-share/desktop/worldwide)).
Worldwide across all platforms, Chromium ≈ 78.7%
([source](https://gs.statcounter.com/browser-market-share)).

**Consequence.** OpenMarkdown's headline capability — *open the same folder
Obsidian opens, write back to it* — is a **desktop Chromium capability and
nothing else**. On a phone the PWA can only offer an OPFS copy plus sync. That
is a real product, but it is a different product, and it should not be sequenced
as if it were the same one.

One mitigation is already documented and favours the PWA over every other
browser form: **persistent folder permission**. Chrome 122+ offers "Allow on
every visit", and — decisively — *"Installed apps will automatically persist
permissions once the user grants access"*
([Chrome blog](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)).
Installing the PWA removes the per-session re-grant that a forum user already
flagged as the obvious objection (Iceman8911, 2025-07-08, thread #2049).

---

## 2. What each form is *for* — the jobs

### 2.1 Evidence from what people install

`community-plugin-stats.json` + `community-plugins.json`, pulled 2026-09-17:
**7,736 plugins, 148,696,933 total downloads** (up from 7,616 / 147.7M on
2026-09-13 — the directory is adding ~30 plugins a day).

Classifying plugins by the job in their name and id:

| Job | Plugins | Downloads | Share of all downloads |
|---|---|---|---|
| Sync / git / remote storage | 489 | 8,196,523 | **5.5%** |
| AI / agent / LLM / MCP / semantic | 309 | 4,326,975 | 2.9% |
| Capture / clip / inbox / quick-add | 114 | 2,965,012 | 2.0% |

(Keyword classification over plugin names and ids; approximate, and a plugin
can serve more than one job.)

**Sync is the largest single add-on job** — larger than AI, larger than capture.
`obsidian-git` is rank 6 (3,152,557), `remotely-save` rank 10 (2,237,665),
`obsidian-livesync` rank 29 (938,028). Obsidian sells Sync at $4/user/month and
users still install 8.2M copies of ways to avoid it. **The job that carries a
notes app across devices is sync, not a mobile app.** OpenMarkdown already has
E2E sync built (`packages/app/src/core-plugins/opensync`, 2,864 lines).

**The fastest-growing job is agents, and on Obsidian it is desktop-only.**
Manifests fetched from each repo's HEAD, 2026-09-17:

| Plugin | Downloads | Rank | `isDesktopOnly` | What it is |
|---|---|---|---|---|
| `realclaudian` (Claudian) | **2,135,277** | **12** | **true** | "Embeds Claude Code/Codex and other local Agents as AI collaborators in your vault" |
| `copilot` | 1,941,912 | 14 | false | "Run AI agents such as Claude Code, Codex, and OpenCode inside your vault" |
| `smart-connections` | 1,203,837 | 22 | false | local embedding, related notes |
| `obsidian-local-rest-api` | 729,037 | 37 | **true** | the API every Obsidian MCP server depends on |
| `agent-client` | 267,218 | 92 | **true** | "Chat with Claude Code, Codex, Gemini CLI… via the Agent Client Protocol" |

Claudian did not exist a year ago and is now the **12th most-downloaded plugin
of 7,736**. Every one of these is a workaround for the fact that Obsidian has no
agent surface of its own: they run a coding agent *inside an Electron app*
because that is the only place the vault is reachable.

The same demand shows in repository stars (GitHub API, 2026-09-17):
[`MarkusPfundstein/mcp-obsidian`](https://github.com/MarkusPfundstein/mcp-obsidian)
**4,423★** (created 2024-11-29), `coddingtonbear/obsidian-local-rest-api`
**2,933★**, `StevenStavrakis/obsidian-mcp` 733★, `cyanheads/obsidian-mcp-server`
680★, `aaronsb/obsidian-mcp-plugin` 465★.

**The whole stack requires Obsidian to be installed and running.** Obsidian's
own CLI ([obsidian.md/help/cli](https://obsidian.md/help/cli)) is explicitly a
remote control for a running app: *"a command line interface that lets you
control Obsidian from your terminal"*, requires the 1.12 installer, and points
elsewhere for headless use: *"Looking to sync without the desktop app? See
Obsidian Headless."* It does not mention MCP. `obsidianmd/obsidian-headless`
(created 2026-02-27, 233★, v0.0.14 on 2026-07-30) **has no licence file** and
**no third-party web frontend has been built on it**.

### 2.2 Evidence from what people complain about

App Store reviews of Obsidian mobile, fetched 2026-09-17, cluster on:
iCloud sync instability and crashes; a required restart on moderately sized
vaults; the paid Sync limit; and readjustment after the UI overhaul. Praise goes
to the **desktop** version's plugins and themes ("the desktop version… offers so
much freedom"). Nobody praises mobile for writing.

Obsidian's own product decisions say the same thing. The official Web Clipper
**does not write files**. Its manifest declares only `activeTab, clipboardWrite,
commands, contextMenus, sidePanel, storage, scripting, declarativeNetRequest` —
no file access, no `downloads`
([manifest.chrome.json](https://raw.githubusercontent.com/obsidianmd/obsidian-clipper/main/src/manifest.chrome.json)).
It builds an `obsidian://new?file=…` URI and passes the note body through the
clipboard
([obsidian-note-creator.ts](https://raw.githubusercontent.com/obsidianmd/obsidian-clipper/main/src/utils/obsidian-note-creator.ts)).
Obsidian, with every resource needed to do it properly, chose to hand capture
off to the installed app rather than write from the browser.

### 2.3 The jobs, assigned

| Job | Where it is done | Evidence |
|---|---|---|
| **Writing at length, organising, plugins, themes** | Laptop | App Store reviews praise desktop for plugins/themes; Live Preview + 7,736 plugins are a keyboard-and-pointer product |
| **Capture from the web** | Browser, any machine | Obsidian Web Clipper 1M users; Notion clipper 1M; Evernote clipper 2M |
| **Capture a thought, review, search** | Phone | Play installs 5M+ with low review/engagement; capture plugins 2.0% of downloads; mobile cannot reach a real folder at all |
| **Move the vault between machines** | Sync | 5.5% of all plugin downloads; Obsidian charges for it and users route around it |
| **Read/edit the vault as an agent** | CLI / MCP, on the machine with the files | Claudian rank 12, mcp-obsidian 4,423★, all of it desktop-only and app-dependent today |

---

## 3. The browser-first wedge

`docs/why.md` already carries the case. What is new, as of 2026-09-17:

**Thread #2049 "Obsidian for web" is still alive and still unanswered.**
Discourse API: **257,875 views** (up ~780 since the 2026-09-13 snapshot), 247
posts, 949 likes, opened 2020-06-17, last post 2026-09-04. **Nine posts in 2026
alone.** Two worth quoting:

- **DDemidov, 2026-08-09:** *"Having a web version would be a major advantage for Obsidian. It would be convenient to have one, at least in the paid version of the cloud sync service."*
- **aisajib, 2026-08-14** — this is the opening, in the community's own words: *"as a user, I really want Obsidian web… I also understand why it's difficult and not something the devs want to tackle anytime soon. I wonder if there's a place for something slightly different, like Obsidian for web, but that will be separate from people's synced vaults."*
- **charles1, 2026-06-14** — defeats the "you are asking us to help you break policy" objection that dominates that thread: *"for my particular firm, we cannot install non-business applications… our firm policy specifically allows usage of firm owned hardware and firm managed BYODs for moderate personal use. I.e., using obsidian for my personal notes on my firm computer is not circumventing firm policy in any way."*
- **aquapendulum, 2025-08-27** — almost a spec for this project: *"I am not requesting a live service to host my Obsidian vaults. I am requesting a local web interface to serve up my local vaults… Everything still stays local, nothing moves off my computer."*

**Obsidian put the Chromebook question on the record six weeks ago, and the
answer was no.** Thread [#116757 "Chromebook incompatibility 🚩"](https://forum.obsidian.md/t/chromebook-incompatibility/116757),
opened 2026-08-01 on 1.13.4 via Crostini ("You can't create a new vault as
browse button not working"). Three minutes later, moderator WhiteNoise:
**"Sorry, We don't support this platform."** The earlier ChromeOS ARM64
rendering bug (#104261, 2025-08-19) sits in the Bug graveyard tagged
`upstream-bug` and `wontfix`. [obsidian.md/download](https://obsidian.md/download)
lists Windows, Mac, Linux, iOS, Android — and, under "web", only the Web
Clipper. Thread #106969 ("Obsidian web app for Google ChromeOS", 2025-10-17)
auto-closed 2026-01-16 with no team response.

**The Chromebook segment was structurally protected in 2026, not eroded.**
Google announced **Aluminium OS** on 2026-05-12 — an Android-based desktop OS
replacing ChromeOS on consumer laptops — and **education and enterprise
Chromebooks are excluded from the migration and stay on ChromeOS**
([Wikipedia](https://en.wikipedia.org/wiki/Aluminium_OS),
[Forbes, 2026-01-31](https://www.forbes.com/sites/paulmonckton/2026/01/31/goodbye-chromeos-leaked-aluminium-os-reveals-googles-android-desktop-future/)).
The exact education install base is aggregator-sourced and should be treated
carefully (§9), but the direction is not in doubt.

**Linux ARM is still broken in 2026.** Forum #99817 auto-closed 2025-09-16 into
the Bug graveyard with an upstream Chromium cause, and thread #112563
(2026-03-23) reports `Exec format error` running the default AppImage on
Raspberry Pi OS 13.4 aarch64 — an ARM64 build exists but the default download
path traps ARM users.

**Somebody in this exact community has already shipped this architecture.** The
Kaper Recipe Manager plugin (2026-05-25) ships a companion web app whose pitch
is: *"The web app reads your files locally via the File System Access API —
there's no upload, no server, no account."* The pattern is understood and
accepted by Obsidian users.

**The lane is open but no longer empty.** `MusiCode1/markport` (144★, created
2026-05-09, pushed 2026-09-07) has repositioned its description to *"Run
Obsidian's desktop app in a standard browser — no Electron needed."* It still
cannot be publicly hosted, because it serves Obsidian's own bundle.

### Does it convert to a desktop user later?

**No published number exists for this, for any comparable product.** Not Figma,
not Excalidraw, not VS Code for the Web, not Photopea. This should not be
asserted. What can be said is narrower and still useful: browser-first
*expands the reachable population*, and there is scale evidence that it works as
a distribution shape — Photopea at 10M+ monthly users with zero installs;
vscode.dev at 2M+ monthly users; Penpot from 250K users in early 2023 to ~1.5M
in early 2026; Figma, where non-designers are two-thirds of 13M+ MAU and 70% of
enterprise deals came bottom-up. PWA install-rate benchmarks in circulation
(3–8% of visitors) are vendor folklore with no published methodology and are not
relied on here.

---

## 4. The browser extension as a product

### 4.1 Extension-as-app is a proven shape at scale

Chrome Web Store, fetched 2026-09-17 — products where the extension *is* the
whole product:

| Product | Users | Rating | Ratings |
|---|---|---|---|
| uBlock Origin Lite | 20,000,000 | 4.5 | 3.6K |
| **Tampermonkey** (a plugin runtime) | **12,000,000** | 4.7 | 73K |
| Dark Reader | 7,000,000 | 4.7 | 13.2K |
| Momentum (new tab page) | 2,000,000 | 4.5 | 13.7K |
| OneTab | 2,000,000 | 4.4 | 14.6K |
| Session Buddy | 1,000,000 | 4.7 | 25.1K |
| **Violentmonkey** (plugin runtime) | 1,000,000 | 4.6 | 750 |
| **Stylus** (installs styles from remote repos) | 1,000,000 | 4.5 | 1.2K |
| Toby | 300,000 | 4.2 | 3.3K |
| Refined GitHub (niche dev tool) | **100,000** | 4.8 | 270 |

Store-wide distribution, for calibration: DebugBear (data 2024-07-19) counts
**111,933 extensions, ~85% under 1,000 installs, 242 (0.2%) over 1M**
([source](https://www.debugbear.com/blog/chrome-extension-statistics)); a March
2026 audit counts **178,299 active extensions, 70.4% at ≤100 users, median 18
users, only 2.63% above 10,000**
([source](https://konabayev.com/blog/chrome-extension-statistics-2026/)).
10,000 users ≈ top 2.6%. 1,000,000 ≈ top 0.2%. Obsidian's clipper is already
in that top bucket; Refined GitHub — a famous, beloved dev tool — is at 100,000.

### 4.2 What an extension buys that a PWA does not

All verified against Chrome's docs, 2026-09-17:

| Capability | Status |
|---|---|
| **Side panel that persists across tabs** | `chrome.sidePanel`, Chrome 114+. A manifest `default_path` panel *"display[s] on all sites"* and "remains open when navigating between tabs". `sidePanel.open()` "may only be called in response to a user action". [docs](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) |
| **Global keyboard shortcuts** | `chrome.commands`, **at most four suggested shortcuts**; truly global (outside Chrome focus) restricted to `Ctrl+Shift+[0..9]`, and **"ChromeOS does not support global commands"**. [docs](https://developer.chrome.com/docs/extensions/reference/api/commands) |
| **Cross-origin fetch (the CORS bridge)** | Confirmed for MV3: *"A script executing in an extension service worker or foreground tab can talk to remote servers outside of its origin, as long as the extension requests host permissions."* Content scripts do **not** get this. [docs](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) |
| **Capture from any page** | `contextMenus` (6 top-level items max), content scripts, `activeTab`, `scripting` |
| **New tab override** | One page per extension; not available in incognito. AMO separately **forbids a remote new tab page**. |

And what the PWA gets that the extension does not: installability and a
standalone window; **`file_handlers`** (double-click a `.md` file — Chrome/Edge
102+, desktop only, *"the application must be installed"*); `share_target`;
`protocol_handlers`; and, above all, **persistent real-folder access** (§1.3).
`apps/web/public/manifest.webmanifest` already declares all four.

Extension-side constraints that matter for a notes app: `storage.local` is
**10 MB** unless `unlimitedStorage` is requested; the MV3 service worker **dies
after 30 seconds of inactivity** and is killed at 5 minutes on a single call,
and *"any global variables you set will be lost"* — so a vault index cannot live
there.

### 4.3 The decisive finding: the plugin store cannot live in an extension

This is settled by two facts that meet exactly.

**Fact one — how OpenMarkdown loads plugins.**
`packages/app/src/obsidian/app-internals/plugins.ts:107`:

```ts
const wrapped = `(function anonymous(require,module,exports){${code}\n})…`;
// Indirect eval: the plugin runs in global scope and sees `app`, `moment`, …
const fn = (0, eval)(wrapped) as (…) => void;
```

`code` is `main.js`, read from the vault after being downloaded from a GitHub
release (`packages/app/src/settings/community-store.ts`). This is not an
incidental choice — `docs/research/plugin-compat.md` §1.3 establishes that it
reproduces Obsidian's observable loader contract, which plugins depend on.

**Fact two — Chrome's policy and CSP.**
The minimum `extension_pages` CSP is `script-src 'self' 'wasm-unsafe-eval';
object-src 'self';` and **"The `extension_pages` policy cannot be relaxed beyond
this minimum value"**; `'unsafe-eval'` causes an *install error*
([docs](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)).
The [MV3 program policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
names two prohibitions that describe a plugin store precisely:

> "JavaScript's `eval()` method or other mechanisms to execute a string fetched from a remote source"
>
> **"Building an interpreter to run complex commands fetched from a remote source"**

and the governing rule: *"The full functionality of an extension must be easily
discernible from its submitted code."* Only two APIs are exempt: Debugger and
User Scripts. Mozilla is no more permissive: **"Add-ons must be self-contained
and not load remote code for execution"**
([AMO policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)).

**Therefore: an extension-hosted OpenMarkdown is an OpenMarkdown without
community plugins — which is the thing `docs/why.md` identifies as the entire
wedge.** The two escape hatches both fail on inspection:

- **Sandboxed iframes** can `eval`, but *"a sandboxed page won't have access to extension APIs, or direct access to non-sandboxed pages"* — only `postMessage`. The full `App`/`Vault`/`Workspace` surface would have to be proxied across a message boundary, and you would still be shipping the interpreter the MV3 policy names. (The RHC page lists sandboxes as an exception while the MV3 policy page lists only two exempt APIs; **these two pages are in tension and the conflict was not resolved from primary sources** — treat it as review risk, not permission.)
- **`chrome.userScripts`** (Chrome 120+) is policy-clean but gated: before Chrome 138 the user had to enable **Developer Mode**; from 138 there is a per-extension "Allow User Scripts" toggle, and *"If the Allow User Scripts toggle is not enabled, `browser.userScripts` is undefined."* A conversion cliff on the primary onboarding path.

The instructive precedent is **Stylus** (1M users), which distributes *styles*
from remote repositories — and the RHC page explicitly excludes data: remote code
*"does not include data or things like JSON or CSS."* Stylus survives because its
payload is not code. Obsidian plugins are code.

Review friction compounds it: Chrome's review page names **broad host
permissions** (`<all_urls>`, which the CORS bridge requires) and **code volume**
(*"The more code an extension contains, the more work it takes to verify"*) as
the two things that slow review
([docs](https://developer.chrome.com/docs/webstore/review-process)). Moving 106k
lines of app into the extension stacks both.

**The extension's correct role is the one it already has, plus a side panel for
the jobs that do not need plugins** — capture, search, read, quick note. That is
cheap: `apps/clipper/dist/manifest.json` already declares `"sidePanel"`, ships a
`sidepanel.html`, carries `vault_wasm_bg.wasm`, uses all four `commands` slots,
and is `externally_connectable` to the app origin. The clip path already works
without the app tab open: the background worker queues a `PendingClip` and opens
a silent app tab to deliver it (`apps/clipper/src/background/index.ts:325-353`).

---

## 5. Distribution reality for a free open-source app

**Reddit is the largest single pool.** r/ObsidianMD is at **~344K–360K members**
([RedditList, July 2026](https://redditli.st/subreddit/ObsidianMD): 343,878;
[reddapi](https://reddapi.dev/subreddits/obsidianmd/insights): 359,968), growing
**~385/day (+3.71% over 30 days), top 1% of tracked subreddits**. It is also the
audience that has been asking for this for six years.

**Hacker News rewards this exact framing, reliably.** HN Algolia API,
2026-09-17, stories above 40 points:

| Points / comments | Date | Title |
|---|---|---|
| **730 / 356** | 2026-05-18 | Show HN: Files.md – Open-source alternative to Obsidian |
| 381 / 173 | 2026-06-25 | Show HN: OpenKnowledge – open source AI-first alternative to Obsidian/Notion |
| 675 / 261 | 2020-07-03 | Zettlr – FOSS markdown editor for PKM |
| 596 / 311 | 2024-02-04 | Browser extensions are underrated: the promise of hackable software |
| 471 / 99 | 2025-08-17 | Show HN: OverType – A Markdown WYSIWYG editor that's just a textarea |
| 418 / 68 | 2025-05-22 | Show HN: Defuddle, an HTML-to-Markdown alternative to Readability |
| 241 / 190 | 2026-01-11 | Show HN: Ferrite – Markdown editor in Rust |

Files.md got 730 points for a Go app with **plain Markdown only and no plugins**.
"Markdown editor" has 88 stories above 40 points. The category is not saturated
at the top of HN; it is reliably rewarded there.

**Web-first OSS in adjacent categories works; web-first OSS *notes* has not.**
GitHub API, 2026-09-17: Excalidraw **132,230★** (browser-first, no install
required); StackEdit **23,100★ but last pushed 2023-07-04** — abandoned; CodiMD
(HackMD's OSS core) 10,143★, last pushed 2025-10-02; SilverBullet 6,043★ and
**requires a server**, with its author selling a desktop wrapper (SilverBullet+)
to remove that step; Dendron in maintenance mode since 2023. The distinguishing
variable is not "web" — it is whether the product needs a server. Excalidraw
does not; SilverBullet does. **OpenMarkdown does not.**

**The Chrome Web Store is a discovery channel the PWA cannot access.** A static
site has no store listing, no category browse, no store search. An extension
does — and 1M users found Obsidian's clipper through it.

**A naming problem worth fixing before launch.** "OpenMarkdown" is crowded:
[openmarkdown.dev](https://openmarkdown.dev) is a shipped product ("A local-first
Markdown editor **built for you and your agent**", macOS/Windows/Linux + an
`openmd` CLI); its releases repo `OpenMarkdown-dev/OpenMarkdown-releases` has
**61★** (created 2026-07-05, `NOASSERTION` licence). The npm package
`openmarkdown` is taken (v0.1.4, MIT), and GitHub has at least eight repos with
the name. Traction is negligible — **61 stars against Files.md's 4,143** — so it
is not a competitive threat. It is a *discovery* threat: shared search terms,
shared package names, shared domain root. The name is held in one file
(`packages/app/src/product.ts`), so this is cheap to change now and expensive to
change later.

---

## 6. Competitive positioning by shape

Which forms each product actually ships, September 2026:

| Product | Web app | Desktop | iOS | Android | Browser ext. | CLI | MCP |
|---|---|---|---|---|---|---|---|
| **Obsidian** | ❌ (six years, no answer) | ✅ | ✅ 2.7K ratings | ✅ 5M+ | ✅ **1M users** (clipper only) | ✅ but it **remote-controls a running app**; headless client unlicensed, 233★ | ❌ (3rd-party only; all require the app) |
| Notion | ✅ web-first | ✅ | ✅ | ✅ 10M+ | ✅ 1M users | ◐ | ✅ |
| Logseq | ◐ `app.logseq.com`, DB version, **beta; "data loss is possible"** | ✅ | ◐ DB app alpha | **not on Play under the known ids** | ❌ | ❌ | ❌ |
| Joplin | ◐ web app, local-first in-browser, **"Clearing your browser's site data… will delete the local copy of your notes"** | ✅ | ✅ | ✅ 500K+ | ✅ | ✅ | ◐ |
| SiYuan | ◐ self-hosted server | ✅ | ✅ | ✅ **10K+** | ✅ | ◐ | ◐ |
| Anytype | ❌ | ✅ | ✅ | ✅ 100K+ | ✅ | ◐ | ◐ |
| SilverBullet | ✅ PWA **but a server is required** | ◐ paid wrapper | ◐ PWA | ◐ PWA | ❌ | ✅ | ❌ |
| Notesnook | ✅ | ✅ | ✅ | ✅ 100K+ | ✅ | ❌ | ❌ |
| **OpenMarkdown** | ✅ **static, no server, real folder** | ◐ installed PWA | ◐ PWA | ◐ PWA | ✅ companion | ✅ **over a bare folder** | ✅ **over a bare folder** |

**Three open lanes, in descending order of how open they are:**

1. **Serverless browser client over a real vault folder, running Obsidian's own plugins.** Nobody occupies it. Logseq's web app is a beta over its own DB; Joplin's is local-first but over its own DB and will silently lose notes to a "clear site data"; SilverBullet needs a server; Markport and Ignis cannot be hosted publicly.
2. **Agent access to a vault with no app running.** Obsidian's CLI drives a running app; its headless client is unlicensed and has spawned no frontends; every third-party MCP server needs the Local REST API plugin (desktop-only, 729K downloads) with Obsidian open. `vault mcp <folder>` needs none of that.
3. **A quality browser-capture product.** Notion's clipper has 1M users at **3.3★**. Obsidian's is 4.8★ but deliberately writes nothing to disk. There is room between them.

---

## 7. Engineering cost against *this* codebase

The architecture makes the cost question unusually easy to answer, because the
app is already platform-agnostic.

- **The whole application boots in four lines.** `apps/web/src/main.ts` imports a stylesheet and calls `boot({root, serviceWorkerUrl})`. A new shell is a new `main.ts`, not a new app.
- **Storage is behind one ~20-method interface.** `VaultAdapter` (`packages/app/src/obsidian/vault/adapter.ts`) already has `HandleAdapter` (File System Access) and `MemoryAdapter`/OPFS behind it. A Tauri or Capacitor filesystem adapter is a bounded, well-specified job — not a port.
- **`Platform` already reports a browser host.** `packages/app/src/obsidian/util.ts:271` — `isDesktop`/`isMobile` describe the *layout*, `isDesktopApp`/`isMobileApp` are both `false`. Mobile layout, share target, file handlers, protocol handlers and PWA install are already implemented (`packages/app/src/pwa/`).
- **Sync is built** (2,864 lines, OpenSync-interoperable, E2E).
- **The CLI and MCP server are built** (`crates/vault-cli`, ~1,700 lines + `src/mcp/`), sharing `vault-index` and `vault-ofm` with the app, so agent results match app results by construction.

| Form | Marginal engineering cost | Why |
|---|---|---|
| **Web PWA** | **Built** | 518-line shell over a finished app |
| **Companion extension** | **Built** | 3.8k lines, side panel + wasm + 4 shortcuts already declared |
| **CLI + MCP** | **Built** | shares the Rust crates |
| **Extension side panel (capture/search/read, no plugins)** | **Low** | mount an existing subset into `sidepanel.html`; the wasm bundle is already shipped inside the extension |
| **Extension-as-app (full editor + plugins)** | **Blocked** | not a cost question — CSP and CWS policy forbid it (§4.3) |
| **Android** | **Medium** | one `VaultAdapter` + a Capacitor/Tauri shell + store listing; Obsidian mobile is a Capacitor app, so the pattern is proven |
| **iOS/iPadOS** | **Medium-high** | same adapter, plus Apple Developer Program, App Review, and a WKWebView that must still run downloaded plugin code |
| **Desktop (Tauri)** | **Medium** | one adapter + packaging/signing/notarisation for three OSes; unlocks Firefox/Safari users and desktop-only plugins |

---

## 8. The forms, scored

Scale 1–5. "Users reached" is reach *this project can realistically convert*,
not total addressable. "Engineering cost" is scored so that 5 = cheap.

| Form | Users reached | Jobs served | Eng. cost (5 = cheap) | Distribution friction (5 = frictionless) | Strategic value | Total |
|---|---|---|---|---|---|---|
| **Web PWA (desktop Chromium)** | 4 — 85.7% of desktop browsers; the only form that serves the locked-down/Chromebook/ARM wedge | 5 — writing, organising, plugins, themes, the full product | **5 — built** | 3 — no store; discovery is Reddit/HN/GitHub; a URL is the lowest-friction *install* in existence | **5 — the only unoccupied position (§6.1)** | **22** |
| **CLI + MCP** | 3 — a smaller, denser, fast-growing audience | 4 — agent read/write, scripting, export, publish | **5 — built** | 4 — `cargo install`, npm, MCP directories, awesome-lists; no review | **5 — lane 2 is wide open; Obsidian's own path needs the app running** | **21** |
| **Companion extension** | 4 — required for the PWA's plugin installs and `requestUrl`; and a CWS listing is a channel the PWA has none of | 3 — capture, CORS bridge, reader, highlighter | **5 — built** | 3 — CWS review, `<all_urls>` scrutiny, mandatory 2FA, AMO source-upload, Safari needs an App Store app | 4 — the channel Obsidian itself validated at 1M users | **19** |
| **Extension side panel (capture/search/read)** | 3 | 3 — always-available capture, 4 global shortcuts, persists across tabs | 4 — low | 3 — same review as above | 3 — cheap differentiation vs. Notion's 3.3★ clipper | **16** |
| **Android** | 3 — Obsidian is at 5M+ installs but 18.6K reviews | 3 — capture, review, search; not writing | 3 | 3 — Play review, but organic PKM search exists | 3 — closes the mobile half of "any device", and is the practical ChromeOS path | **15** |
| **iOS / iPadOS** | 2 — Obsidian iOS is 2.7K ratings, #134 Productivity | 3 — same jobs as Android; iPad adds writing | 2 | 2 — Apple Developer Program, App Review, and downloaded-plugin execution is a review question | 3 | **12** |
| **Desktop app (Tauri)** | 3 — Firefox/Safari users, desktop-only plugins | 4 | 3 | 3 — signing, notarisation, three OSes | **2 — competes with Obsidian where Obsidian is strongest, and contradicts the "no install" claim that is the whole pitch** | **15** |
| **Extension-as-app (full editor + plugin store)** | 4 | **1 — no community plugins (§4.3)** | **1 — blocked by policy, not by effort** | 2 | **1 — would ship the product minus its differentiator** | **9** |

---

## 9. Recommended order, and what each stage must prove

### Stage 1 — Web PWA **and** companion extension, launched together

They are one product, not two. The PWA cannot install plugins or serve
`requestUrl` without the bridge (CORS), and the extension has no home without
the app. Ship to desktop Chromium and say so plainly on the page: Firefox and
Safari get browser storage with import/export.

*Why first:* the wedge is a **desktop-machine** wedge (locked-down laptops,
Chromebooks, ARM Linux, borrowed machines) and the enabling API is
desktop-Chromium-only. The demand is six years old, measured at 257,875 views,
and Obsidian put "we don't support this platform" on the record six weeks ago.
The full product — plugins, themes, Live Preview — only works in a page that can
`eval`, which means the web app and nothing else.

*Must prove before Stage 2 starts:*
1. A stranger's existing Obsidian vault opens, renders with their theme, and their top plugins run — measured on real vaults, not the demo.
2. Returning-vault retention over 7 and 28 days. Reach without return is a demo, not a product.
3. Extension attach rate among users who try to install a plugin. If it is low, the plugin store is a dead end and the positioning must change.
4. That the installed-PWA path actually removes the folder re-grant prompt (Chrome 122+ claims it does; verify).

### Stage 2 — `vault` CLI and MCP server

Ship what is already built: `cargo install`, an npm wrapper, listings in the MCP
directories and awesome-lists, and a one-line Claude Code / Claude Desktop
config.

*Why second:* it costs almost nothing, it reaches a **different audience through
a different channel**, so it cannot cannibalise Stage 1 — and the demand is
visible and growing fast (Claudian at rank 12 of 7,736; mcp-obsidian 4,423★).
Every existing option requires Obsidian installed and running. `vault mcp
<folder>` requires a folder. That is a cleaner product than anything shipping.

*Must prove:* that MCP users find the vault app (measure the path from CLI to
web app), and that agent-written notes survive a round trip through the app
unchanged.

### Stage 3 — Extension side panel for capture, search and reading

Not the editor. A panel that clips, searches the vault, opens a note read-only
and takes a quick note into today's daily note — the jobs that need no plugins.

*Why third:* the store listing is the only category-search discovery channel
available, Obsidian validated it at 1M users, Notion's clipper sits at 3.3★, and
the panel buys four global shortcuts and a surface that survives tab switches.
Cost is low because the manifest, the wasm bundle and `sidepanel.html` already
exist.

*Must prove:* that clipper installs convert to app opens. If they do not, the
extension is a utility, not a funnel, and should be left as a companion.

### Stage 4 — Mobile, as PWA plus sync first; native Android only if the data demands it

Mobile browsers have no File System Access API at all, so on a phone the product
is *an OPFS vault synced from the desktop one* — which is exactly the job the
evidence assigns to phones (capture, review, search) and exactly what the
existing E2E sync delivers. Ship that and measure before paying for a store.

*Must prove before building native:* what share of mobile sessions are capture
and review rather than writing; the PWA install rate on Android; and whether
iOS Safari's PWA limitations actually block the capture flow (the Shortcuts
recipe in `docs/quick-capture.md` is the current workaround). **Build native
Android only if the PWA measurably fails one of these**, and iOS only after
Android, because Obsidian's own iOS footprint (2.7K ratings, #134) is the
smallest surface in this report and Apple's review of an app that downloads and
runs plugin code is an unresolved risk.

### Stage 5 — Desktop app (Tauri), last and optional

It is the cheapest remaining port — one `VaultAdapter` — and it buys Firefox and
Safari users real folders plus the ~8% of plugin downloads that are
`isDesktopOnly`. It is last because it competes with Obsidian where Obsidian is
strongest and because "no install" is the sentence the whole project is built
on. Build it when the web app's Firefox/Safari fallback is demonstrably the top
complaint, and not before.

### Not recommended: extension-as-app

§4.3. The plugin loader needs `eval` on downloaded code; MV3's extension-page CSP
cannot be relaxed past `script-src 'self' 'wasm-unsafe-eval'`; Chrome's policy
bans "building an interpreter to run complex commands fetched from a remote
source"; AMO bans remote code outright. An extension-hosted OpenMarkdown is
OpenMarkdown with the wedge removed.

### One thing to settle before Stage 1 ships

**The name.** `openmarkdown.dev` is a live product with an `openmd` CLI, npm
`openmarkdown` is taken, and eight GitHub repos share the name. The competitor
has 61 stars so it is not a threat, but it owns the search terms. The name lives
in one file. Change it now or accept permanent discovery friction.

---

## 10. What could not be verified

Stated plainly, because several of these would otherwise read as facts.

**Load-bearing, close by experiment (an afternoon each), not by more searching:**

1. **Whether `showDirectoryPicker()` works inside an MV3 extension page, and whether handles persist there.** No primary source exists either way. The strongest indirect evidence is negative: Obsidian's own clipper does not attempt it and routes through `obsidian://` + the clipboard instead. `chrome.downloads` cannot write to an arbitrary folder (*"Absolute paths, empty paths, and paths containing back-references '..' will cause an error"*). This decides how much an extension could ever do on its own.
2. **Side-panel JS context lifetime** across tab switches and navigation. Undocumented. Decides whether a side-panel app can hold state at all.
3. **OPFS availability and quota in an extension context.** IndexedDB and Cache Storage are confirmed available in extension service workers; OPFS is plausible but unproven.

**Numbers deliberately not used above, because they do not hold up:**

4. **"% of knowledge workers who cannot install software on work machines."** This number does not appear to exist publicly. The segment is evidenced only qualitatively — densely, but qualitatively.
5. **Microsoft Intune device count** ("190M" / "200M+"): third-party blogs only, no Microsoft source. **Jamf's 28.4M devices / 67K customers**: the cited article is ~Q2 2021, not 2026. **"Only ~20% of customers use application control"**: Microsoft primary, but from 2017.
6. **Chromebook education figures** (38M in K-12, 22.11M shipped 2025, 60.1% education share): aggregator sites citing IDC; IDC/Canalys primaries not reached. Google's own "50 million students and educators" claim dates to **2022-02-03** and has no newer official successor.
7. **Any web-trial-to-desktop-install conversion rate, for any comparable product.** None is published. PWA install-rate benchmarks (3–8%) are vendor folklore with no methodology.
8. **Excalidraw / Photopea / vscode.dev / Penpot user counts**: secondary sources only.
9. **Chrome Web Store $5 developer fee and Apple's $99/yr Developer Program fee**: neither figure appears on a primary Google or Apple page that could be fetched. Both are near-certainly correct; neither is cited here as fact.
10. **Microsoft Edge Add-ons user counts**: the store renders client-side; every fetch returned only the footer.
11. **Chrome Web Store payments deprecation**: the documentation URL 404s.
12. **The tension between Chrome's RHC page** (sandboxed iframes listed as an exception) **and the MV3 policy page** (only Debugger and User Scripts listed as exempt). Unresolved from primary sources. Treated above as review risk, not as permission — which is the conservative reading, and the right one when the whole product depends on it.
13. **Newer Reddit verbatims (2026)**: reddit.com blocks this crawler and the archive mirrors were unreachable; forum.obsidian.md verbatims were substituted, and are better sourced anyway.
14. **Logseq on Google Play**: not found under `com.logseq.app` or `com.logseq.logseq`. Either delisted, or shipping under an id not found here. Its Android status should be re-checked before being quoted.
15. **Plugin-job classification in §2.1** is keyword-based over plugin names and ids. The shares are indicative, not exact.
