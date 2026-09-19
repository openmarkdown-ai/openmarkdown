# Mobile: what the platforms and the stores actually allow

Research 17 September 2026. The agent that produced this hit a session limit before writing the
file; this is its report, condensed by the coordinator, with its citations and its own
"could not verify" list kept. Anything marked *unverified* must not be quoted as fact.

## 1. The precedent that matters: plugins on iOS are allowed

Obsidian ships an open community-plugin browser on iOS today
(https://apps.apple.com/us/app/obsidian-connected-notes/id1557175442, seller Dynalist Inc.,
v1.13.7, updated 2026-08-15). Its own docs tell plugin authors that Node and Electron are
absent on mobile and that a plugin needing them must set `isDesktopOnly`
(https://docs.obsidian.md/Plugins/Getting+started/Mobile+development). Plugins are plain
runtime-loaded `main.js` files from the vault's `.obsidian/plugins`.

**But Joplin, reading the same rules, restricts iOS to a curated set.** Its docs state:
"To adhere to AppStore guidelines, the iOS app only allows installing recommended plugins"
(https://joplinapp.org/help/apps/plugins/). The issue that decided it quotes guideline 4.7
and proposes the vetted subdirectory (https://github.com/laurent22/joplin/issues/10154);
there is no record of an Apple rejection — it was pre-emptive.

The governing text, verbatim from https://developer.apple.com/app-store/review/guidelines/:

- **4.7** permits "HTML5 and JavaScript mini apps … and plug-ins", and makes the host app
  responsible for all of it.
- **4.7.2** "Your app may not extend or expose native platform APIs or technologies to the
  software without prior permission from Apple." → a mobile plugin must never receive a handle
  to a native file bridge; it may touch web APIs and our own JS abstraction only.
- **4.7.4** "You must provide an index of software and metadata available in your app. It must
  include universal links that lead to all of the software offered in your app." → an unbounded
  mirror of someone else's registry is hard to square with this; a curated index is not.
- **2.5.2** forbids downloading code "which introduces or changes features or functionality".
  The industry's defence rests on the Developer Program License Agreement §3.3.2, which is behind
  account authentication — *the agent could not read it, and neither should we quote it.*
- **4.2** now reads "elevate it beyond a repackaged website"; the older "web site bundled as an
  app" phrasing is gone. A bare WKWebView pointing at our URL fails it; an offline editor with
  local file access, a share extension and widgets does not.

## 2. What competitors ship

| App | iOS | Android | Mobile tech | Plugins on mobile |
|---|---|---|---|---|
| Obsidian | yes | Play | Capacitor *(community-attested, never vendor-confirmed)* | **yes, open store** |
| Joplin | yes (seller: an individual) | Play + F-Droid | React Native (in-repo proof) | yes — **iOS limited to "recommended"** |
| SiYuan | yes | Play + F-Droid (AGPL, no anti-features) | Go kernel via gomobile + native WebView shell | yes (issue-tracker evidence) |
| Logseq | yes but **frozen since 2024-04-23** | no Play listing found; APK only | Capacitor (in-repo proof) | no |
| Standard Notes | yes | Play | React Native shell = "a function that renders a webview" (https://standardnotes.com/blog/react-native-is-not-the-future) | by architecture (inferred) |
| Anytype | yes | Play | native Swift + Kotlin over a Go middleware | none found |
| AppFlowy | yes | Play | Flutter + Rust | none documented |
| SilverBullet | **PWA only, deliberately** | PWA | — | presumably |
| Zettlr / Trilium | none | none / 3rd-party | — | — |

Two lessons: everyone who runs a web editor on mobile runs it in a WebView, and **Logseq's iOS
build rotted for two and a half years while its desktop shipped a 2.0** — a second pipeline needs
an owner every week.

## 3. The file-access gap

`@capacitor/filesystem` offers a fixed set of app-owned sandboxes
(https://capacitorjs.com/docs/apis/filesystem). **There is no `Directory` value meaning "the
folder the user picked"**, and the agent found no maintained plugin granting persistent access to
an arbitrary directory tree (Android SAF persisted URIs, iOS security-scoped bookmarks).
Obsidian and Logseq both ship their own native plugins for this
(e.g. https://github.com/logseq/capacitor-file-sync). **Assume we write it.**

## 4. Android has a cheaper road than iOS

A **Trusted Web Activity** (https://developer.chrome.com/docs/android/trusted-web-activity/)
renders our PWA in *the user's Chrome*, not the System WebView: current wasm, OPFS, and no
WebView fragmentation. Ownership is proved by a static `/.well-known/assetlinks.json`, which a
static host can serve. The limit is sharp: "The host app doesn't have direct access to web
content in a Trusted Web Activity" — no JS bridge, only intents. Tooling is Bubblewrap
(https://github.com/GoogleChromeLabs/bubblewrap, "not an officially supported Google product").

Play's webview clause bites only "without permission from the website owner"
(https://support.google.com/googleplay/android-developer/answer/9899034) — we are the owner.

Tauri 2's Android target uses the *System* WebView, not Chrome
(https://v2.tauri.app/reference/webview-versions/), and Tauri's own 2.0 post still says
"We are not completely happy about the developer experience at the moment" for mobile; v3.0.0
alphas landed 13–15 September 2026.

## 5. Money and friction

- Apple: **$99/yr**; the fee waiver excludes individuals and sole proprietors
  (https://developer.apple.com/support/membership-fee-waiver/). Free app with no IAP: no
  commission. **3.1.3(f)** lets a free app act as companion to a paid *web* service ("Cloud
  Storage" is Apple's own example) with no IAP — at the cost of no in-app upsell at all.
- Google: **$25 once**; "97% of developers distribute … at no charge"
  (https://support.google.com/googleplay/android-developer/answer/112622). New personal accounts
  must run **a closed test with 12 testers for 14 continuous days** before the first production
  release (https://support.google.com/googleplay/android-developer/answer/14151465).
- Review: Apple "90% of submissions … in less than 24 hours"
  (https://developer.apple.com/distribute/app-review/). Play "a few hours or up to seven days",
  and submitting while a review is in flight sends you to the back of the queue
  (https://support.google.com/googleplay/android-developer/answer/9859654). Turn on **managed
  publishing** from day one.
- EU: the Core Technology Fee exempts "developers that earn no revenue whatsoever"
  (https://developer.apple.com/support/core-technology-fee/) — but that ends the day we sell
  sync, and the CTF itself is superseded by DPLA Attachment 14 on **1 October 2026**; whether the
  exemption survives is *unverified*.
- F-Droid takes this shape of app (SiYuan, Joplin are both listed), but its policy says apps
  "must not download additional executable binary files … without explicit user consent"
  (https://f-droid.org/docs/Inclusion_Policy/) — a plugin browser likely earns an anti-feature.
- Android developer verification: in force for participating stores in BR/ID/SG/TH from
  **30 September 2026**, global 2027+ (https://developer.android.com/developer-verification).
  A free "limited distribution" tier exists but caps at 20 devices.

## 6. Could not verify (the agent's own list, trimmed)

Apple DPLA §3.3.2 text; any Ionic page claiming 2.5.2 compliance for OTA updates (both
`live-updates` URLs 404); Appflow pricing; AltStore PAL fees; Apple's commission on US
external-link purchases; **WKWebView internals — JIT, SharedArrayBuffer/cross-origin isolation,
OPFS durability, memory ceilings** (these decide whether our Rust/wasm core is happy in an iOS
shell: test on a device before choosing); a Capacitor plugin for arbitrary-folder access; Tauri's
mobile filesystem plugin coverage; CodeMirror 6's mobile IME limitations (no first-party list;
Obsidian and Joplin shipping it is the evidence); Logseq's Play listing; whether F-Droid's
buildserver has Node/cargo preinstalled.
