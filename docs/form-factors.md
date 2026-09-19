# What OpenMarkdown should be, and in what order

Decision note, 17 September 2026, from three research passes:
[`research/form-factor-market.md`](research/form-factor-market.md) (where the users are),
[`research/form-factor-desktop.md`](research/form-factor-desktop.md) (how a desktop build would
have to be made), [`research/form-factor-mobile.md`](research/form-factor-mobile.md) (what the
stores and phones allow). Numbers below are theirs; each is sourced in its report.

## The decision

**One product, five artefacts, shipped in this order: the web app and its extension (built),
the CLI and MCP server (built), mobile as a synced PWA (built), then — only if the evidence
asks for them — an Electron desktop app and a native mobile shell.**

| Form | Status | Verdict |
|---|---|---|
| Web app (PWA) + companion extension | built | **The product.** The only unoccupied position, and the only place the full thing — plugins, themes, Live Preview — can run in a page |
| `vault` CLI + MCP server | built | **Ship now.** Different audience, different channel, near-zero cost; nothing else in the category serves an agent a folder without the app running |
| Mobile as PWA + end-to-end sync | built | **Ship now.** On a phone the vault is a synced browser vault; that matches the jobs phones actually do |
| Extension side panel for capture and search | small | **Later, cheap.** The store listing is the only category-search discovery we have |
| Desktop app | not started | **Only for plugin parity, and then it must be Electron** |
| Native iOS / Android app | not started | **Last, and only if the PWA measurably fails** |
| The app *as* a browser extension | — | **No.** Policy forbids running downloaded plugin code, which removes the differentiator |

## Why this order

**The wedge is a desktop-machine wedge, and it is already built.** The demand ("Obsidian for
web", 273 votes / 257k views, six years, no official answer) comes from locked-down work laptops,
Chromebooks, ARM Linux and borrowed machines. The enabling API — File System Access — is
desktop-Chromium-only. Nothing about a phone or a desktop binary serves that person.

**The CLI and MCP server cost nothing more and reach a different room.** Agent access to a vault
is a fast-growing demand, and every existing option requires Obsidian installed and running.
`vault mcp <folder>` requires a folder.

**Phones want capture, review and search, not writing.** Mobile browsers have no File System
Access API at all, so a phone vault is an in-browser vault kept current by sync — which is what
we have. Measure before paying a store.

## If we build a desktop app, it is Electron — or it is not worth building

The desktop report is unambiguous, and it overturns the market report's assumption that Tauri is
"the cheapest port":

- The only thing a desktop build buys that the browser cannot argue its way to is the **91 of the
  top 600 plugins that are desktop-only** (11.3M downloads). About 25 of those need only what a
  browser already has, and we have built those in. The rest want to **spawn processes, read
  arbitrary paths, listen on a port, and `require()` anything**.
- Tauri can give the first three over Rust IPC. It cannot give the fourth. "Runs unmodified
  Obsidian plugins" stops being true the moment a bundle calls `require('express')`.
- Tauri would also put macOS and Linux users on WKWebView and WebKitGTK, where our File System
  Access, file observer, Document Picture-in-Picture, paged-media PDF export and on-device AI
  paths fall away — and where 7,736 plugins and 753 themes have never been tested.
- Cost, measured from their own release feeds: Obsidian ships 217.8 MB (macOS) / 315.7 MB
  (Windows); Joplin 197/344; Logseq 161. The one Tauri neighbour, openmarkdown.dev, ships 12.7 MB
  — and has no plugin ecosystem at all.
- The security consequence must be stated on the download page: in an Electron build, plugin code
  has full Node privileges, exactly as in Obsidian.

**Trigger to build it:** when the Firefox/Safari fallback or a named desktop-only plugin is the
top complaint from real users. Not before.

## If we build mobile natively, Android first and iOS differently

- **Android is cheap**: a Trusted Web Activity runs our PWA in the user's own Chrome (current
  wasm, OPFS, no WebView fragmentation), proved by a static `assetlinks.json`. Play's webview
  rule bites only "without permission from the website owner" — we are the owner. The friction is
  calendar time: a new personal account needs **12 testers for 14 continuous days** before its
  first release.
- **iOS is not cheap**: no TWA equivalent, so a WKWebView shell (hand-rolled or Capacitor 8), and
  **we write the vault-folder bridge ourselves** — security-scoped bookmarks on iOS, SAF on
  Android. Every competitor did.
- **The plugin store is the review question, not the architecture.** Obsidian ships an open plugin
  browser on iOS; Joplin, reading guideline 4.7.4, restricts iOS to "recommended plugins". Plan
  for a **curated iOS plugin index**, and make sure plugin JS never receives a handle to the
  native bridge (4.7.2).
- Money is not the obstacle ($99/yr, $25 once, 0% on a free app). **Ownership is**: Logseq's iOS
  build sat frozen for two and a half years while its desktop shipped a rewrite.

## What each stage must prove before the next starts

1. **Web + extension:** a stranger's real vault opens with their theme and their top plugins;
   7- and 28-day return rates; extension attach rate among people who try to install a plugin;
   that an installed PWA really does stop the folder re-grant prompt.
2. **CLI + MCP:** that agent-written notes survive a round trip through the app unchanged, and
   that MCP users find the web app.
3. **Mobile PWA:** what share of phone sessions are capture and review rather than writing; the
   Android install rate; whether iOS Safari blocks the capture flow in practice.

## Open questions that decide the later stages

- **The name.** `openmarkdown.dev` is a live product, npm `openmarkdown` is taken, and the name
  owns the search terms. It lives in one file. Settle it before any store listing.
- **Whether `showDirectoryPicker()` works in an extension page** (an afternoon's experiment;
  decides how much a side panel could ever do).
- **WKWebView internals** — JIT, cross-origin isolation, OPFS durability, memory ceilings — which
  decide whether the Rust/wasm core is happy inside an iOS shell. Test on a device.
- **Apple's DPLA §3.3.2** (the clause the whole downloaded-plugin question rests on) is behind
  account authentication and was never read. Worth a lawyer's hour before an iOS build.
