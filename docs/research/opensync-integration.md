# OpenSync in OpenMarkdown

Researched 2026-09-14. How the OpenSync Obsidian plugin syncs a vault, whether it runs inside OpenMarkdown today, and how sync should be built into OpenMarkdown.

Sources: `../opensync` (the engine: README, PLAN, QUICKSTART, `packages/client/src/*`, `crates/opensync-relay/src/http.rs` and `config.rs`, and the wasm bindings `opensync_wasm.d.ts`), and `../opensync-obsidian` (`src/main.ts`, `scripts/*.mjs`, `docs/*.md`, `checks/harness.mjs`). The proprietary Obsidian app was not opened or run. Every compatibility result below comes from OpenMarkdown's own build, served on :5200, with a local `opensync-relay`.

---

## 0. The answer

1. **The unmodified plugin works in OpenMarkdown today.**
   - It loads, pairs two browser contexts with a ten-character code, and syncs a note both ways.
   - A conflict produces a copy, an attachment syncs, a deletion goes to the trash, and the recovery kit parses back.
   - State survives a disable and re-enable.
   - No API is missing. The only console errors are expected 404s from `HEAD` probes on blobs (§2).
2. **Do not ship the plugin as the built-in feature.** It needs Restricted mode turned off, and it keeps both keys in plaintext inside the vault folder. Its UI shows raw `nsec1…`/`ovault1…` keys, so the engine is visible. It cannot enrol a device before a vault exists, and it has no multi-tab lock. It also ships a *vendored* copy of the engine client.
3. **Recommended design: hybrid (c).**
   - Build a native, hidden core plugin `opensync` in OpenMarkdown. It uses `../opensync/packages/client` by relative path and has OpenMarkdown-native UI.
   - The vault sync loop, which today lives only in `opensync-obsidian/src/main.ts`, moves into `opensync/packages/client/src/vault.ts` (§6, change E1). The plugin and OpenMarkdown then run the same loop over the same wasm. Interop with Obsidian desktop holds by construction, not by keeping two copies in step.
   - The community plugin stays loadable. It is mutually exclusive with the built-in sync, and the compat suite guards it.
4. **Measured performance problems apply to both hosts.** A one-line edit in a 2,000-note vault costs **2,012 `HEAD` requests**, one per blob, sent one at a time. A device with no local edits **never pulls** remote changes on its interval. Both need engine or loop changes, listed in §6.

---

## 1. How opensync-obsidian syncs a vault

### 1.1 Build and how it reaches the engine

- **It does not reach the engine by relative path any more.**
  - `src/main.ts:12-31` imports from `../vendor/opensync-client`.
  - That folder is a generated copy of `../opensync/packages/client/src`, made by `scripts/vendor-client.mjs` (`SOURCE` at :30, `FILES` at :39).
  - The copy was introduced in commit `5dfc889` ("Vendor the engine's client, so this repository builds alone"), because the Obsidian community directory's build check clones one repository.
  - `npm run vendor:check` fails if the copy drifts. It passed on 2026-09-14: "vendored client matches the engine (10 files)".
  - This contradicts the rule "no second copy of the engine" and `opensync/README.md` ("Each reaches in here by relative path"). The owner should know that the rule is already bent, and why.
- **Bundling.** esbuild bundles everything into one CommonJS `main.js` of 1.75 MB (`scripts/build.mjs`).
  - `obsidian`, `electron`, `@codemirror/*` and `@lezer/*` are external.
  - `import.meta.url` is defined as `""`.
  - `__HOSTED_RELAY__` defaults to `wss://relay.opensync.network/` (:30-31).
  - `__TEST_BUILD__` adds a Plan dropdown.
  - `main.js` at the repo root is the production build. `dist-install/opensync/` is a test build pointed at a tailnet relay.
- **Wasm loading.** The compiled core, 1.24 MB, is stored as base64 in `wasm/inline.ts` (`packages/client/scripts/inline-wasm.mjs`).
  - `ready()` (`session.ts:37-40`) decodes it and calls wasm-bindgen's `init({ module_or_path: bytes })`. That ends in `WebAssembly.instantiate`.
  - Nothing is fetched, and there is no worker, no `.wasm` URL and no streaming compile.
  - `init` returns early once instantiated (`opensync_wasm.js:2355-2357`).
- **Dependencies.**
  - `@noble/curves` (secp256k1 Schnorr) and `@noble/hashes` handle the Nostr signing in `relay.ts:1-46`.
  - Everything else (XChaCha20-Poly1305, BLAKE3, HKDF, SPAKE2, CBOR, merge, QR) is inside the wasm.
  - WebCrypto is used only indirectly, through `crypto.getRandomValues`.

### 1.2 Platform APIs it calls

| Area | What it uses | Where |
|---|---|---|
| Vault events | `vault.on("modify"\|"create"\|"delete"\|"rename")`. Each only sets a `dirty` flag. | `main.ts:284-290` |
| Vault reads | `vault.getFiles()` then `vault.readBinary(file)` for **every** file in scope on **every** sync | `main.ts:396-405` |
| Vault writes | `getAbstractFileByPath`, `createFolder`, `modifyBinary`, `createBinary`, `normalizePath` | `main.ts:421-437` |
| Deletion | `app.fileManager.trashFile(file)` | `main.ts:717` |
| Persistence | `loadData()`/`saveData()`. The settings, **both keys in plaintext**, the pointer and the full merge-base manifest all go to `.obsidian/plugins/opensync/data.json` | `main.ts:305-316`, `666-672` |
| UI | `addStatusBarItem`, `addCommand({id:"sync-now"})`, `PluginSettingTab`, `Setting` (text, button, toggle, dropdown, heading, `setCta`/`setWarning`), `Notice`, `createEl`, `containerEl.empty()`, `Platform.isMobile` | `main.ts:269-279`, `774-1202` |
| Timers | `registerInterval(window.setInterval(…, max(15, intervalSeconds)·1000))`, which **only syncs when `dirty`**; `workspace.onLayoutReady(sync)` | `main.ts:292-298` |
| Network | Browser `WebSocket` for pointers, AUTH and pairing; browser `fetch` for blobs (`HEAD`/`GET`/`PUT /upload`/`DELETE`). It does **not** use `requestUrl`, so it relies on the relay's CORS headers. | `relay.ts:111-317`, `pairing.ts:69-151` |
| Canvas | `drawInvitation(canvas, …)` for the pairing QR | `main.ts:1071-1072`, `qr.ts` |
| IndexedDB, Workers, Node, Electron | **None.** Declaring `isDesktopOnly: false` is honest. | — |

### 1.3 The sync loop (`runSync`, `main.ts:554-639`)

1. **Stage the whole vault.** It reads every in-scope file, calls `ns.clear()` and `ns.stage(path, bytes)` for each, then `ns.commit(generation+1, now, deviceLabel, scope)`. The commit returns every blob plus the sealed pointer. Hidden paths are never staged, because `getFiles()` excludes dot-folders, so `.obsidian/` does not sync (see `docs/security.md`).
2. **Read before writing.** `relay.fetchPointer("vault:main")` sends a REQ for kind 30078, `#d` = namespace, `limit:1`, and waits for EOSE.
3. **Nothing remote.** It publishes and stores the base.
4. **Remote exists.** It opens the pointer, `GET`s the manifest blob and opens it. If the content equals ours (chunk hashes only, `sameContent` :722-737), it adopts their pointer.
5. **We did not diverge from the base.** It fast-forwards with `applyRemote`:
   - It writes files whose bytes differ.
   - It trashes local files absent from the manifest, **but only if the manifest's `scope` covers that extension** (`covers`, :243-250, which mirrors `Manifest::covers` in Rust).
6. **We diverged.** It calls `ns.mergeManifests(base, ours, theirs, deviceLabel, localDate, now)`, applies the merged result and shows a Notice with the conflict count. It then re-reads the vault, commits at `incoming.generation+1` and publishes.
7. **Publish** (:642-657). For **each blob, one after another**, it sends `HEAD`, then `PUT /upload` if the blob is missing. It then publishes the pointer event and saves the pointer and base to `data.json`.

The pointer is the commit: blobs are durable before the pointer names them. `Relay.nextCreatedAt` (`relay.ts:57-99`) keeps a per-instance watermark, so two writes in the same second do not tie on `created_at`.

### 1.4 Conflicts

- Resolution is whole-file last-writer-wins with conflict copies, decided in wasm.
- The local side keeps the path. The remote version is written beside it as `name (conflict YYYY-MM-DD from <device>).md`, named after the device whose version is inside it. That name comes from the `device` field the publisher sealed into its manifest.
- A deletion never beats an edit (README "What happens when two devices disagree").
- There is no conflict review UI, only a Notice (:621-626).

### 1.5 Attachments and the paid tier

- **What the free plan carries.** `FREE_EXTENSIONS` (:72-86) is an allow-list: `md canvas base excalidraw json csv txt svg css yaml yml bib drawio`.
- **What this device carries.** `carriesEverything = syncAttachments && !metered` (:358-360).
- **When the plan applies.** `metered` is true only when `plan !== "supporter"`, a hosted relay is configured, *and* the relay host equals the hosted host (:369-383). **A self-hosted relay is never metered.**
- **Scope.** A device that filters sends `scope` with its commit, so another device reads a missing attachment as silence, not as a deletion. There is a warning on turning attachments off, because of version skew (:65-70).
- **Enforcement.**
  - The relay cannot see file types. It meters bytes only.
  - A full quota returns `413 quota exceeded`, which the client raises as `QuotaError`. An account the relay does not serve returns `403` / `restricted:`, raised as `NotAdmittedError` (`relay.ts:269-292`).
  - `plan` is a settings flag. No account or billing server exists yet.

### 1.6 Pairing, recovery and rotation

- **Join** (`pairing.ts:162-216`).
  - It takes either ten characters or `opensync://pair?ws=…#code`.
  - It opens its own WebSocket, authenticates with a **throwaway keypair**, and subscribes to kind 20079 (ephemeral) on the code's channel.
  - It repeats `joinMessage` every 2 s until an `offer` arrives, then sends `accept` and waits for the `grant`.
  - `session.open(grant)` returns `{accountSecret, namespaceKey, namespace, relayWs, relayHttp, grantedBy, accountId}`.
  - `endpointsFor` (:271-281) keeps the relay address that actually worked.
- **Grant** (`pairing.ts:224-260`). The granting device answers exactly one join. One code allows one attempt (SPAKE2 in `crates/opensync-core/src/enroll.rs`).
- **Plugin UI.**
  - A device with no keys sees "Set up / Join from a code" (:994-1048).
  - A device with keys sees "Add a device / Show a code", with a QR, the URI, the code and the relay, plus a loopback warning (:1051-1115).
  - "Rotate the vault key" takes two presses (:1117-1168). It re-seals the vault under a new key, publishes without reading, then sweeps old blobs (:459-526).
  - "Recovery kit / Show it" renders the kit and reads it back (:1170-1200).
- **First device.** You press **Generate** beside each key field (:838-875).
- **Gap: no restore from a kit.** The kit says "Run `opensync restore`", but the plugin has no import-from-kit control. The only way back is pasting keys into the fields.

### 1.7 Relay configuration and the hosted relay

- **Settings.** `relayWs` and `relayHttp`; the storage address is the same host with the other scheme (`storageFor`, :111-116). There is also `namespace` (default `vault:main`), `deviceLabel` (default is the vault's name), `syncOnSave`, `intervalSeconds` (120), `syncAttachments`, `plan` and `hostedRelay`.
- **`packages/client/src/hosted.ts`.**
  - It defines only `HOSTED_RELAY_HOST = "relay.opensync.network"` with its `wss://` and `https://` forms (:13-16), plus `assumeTls()`, which decides the scheme for an address typed without one (:32-42).
  - **There are no billing or account endpoints anywhere** in the client or the relay.
  - The relay's HTTP surface (`http.rs:83-92`) is `/` (NIP-11 or WebSocket), `/upload`, `/list/{pubkey}`, `/admin/roster` (GET/POST), `/admin/roster/{pubkey}` (DELETE) and `/{sha256}` (GET/HEAD/DELETE).
  - CORS is `Any` origin, method and header, set on the router, so the embedded relay has it too (`http.rs:94-105`).
- **The production relay** runs `admission = "roster"`. An account nobody has admitted cannot store anything, and on first run that surfaces as a quota-like error (`docs/testing.md`, `docs/troubleshooting.md`).

### 1.8 Defects and gaps found while reading, then confirmed by running

| # | Finding | Evidence |
|---|---|---|
| G1 | **A device that edits nothing never pulls.** The interval syncs only if `dirty`, so remote changes arrive only at startup, on "Sync now", or after a local edit. A freshly joined device sat at "OpenSync: idle" (screenshot `B-07`). | `main.ts:292-296` |
| G2 | **Publishing sends one `HEAD` per blob, one at a time, on every changed sync.** On a 2,000-note vault, a one-line edit made 2,012 `HEAD` + 2 `PUT` + 1 `GET` (1.5 s on loopback). At 40 ms round-trip time that is about 80 s. | `main.ts:643-646`, §2.3 |
| G3 | **Every sync re-reads and re-seals every file.** `ns.stage` needs bytes for every path, because a commit rebuilds the whole manifest. | `main.ts:396-405`, `opensync_wasm.d.ts` `commit` |
| G4 | **Keys are in plaintext inside the vault folder** (`.obsidian/plugins/opensync/data.json`). A vault kept in iCloud, Dropbox or git, or zipped for export, carries the vault key with it. | `main.ts:666-672`; measured: `hasPlaintextVaultKey: true` |
| G5 | **No request timeout on `fetch`**, so the status can sit on "syncing…" forever while offline. The socket exchange has a 20 s timeout. | `relay.ts:257-292`, `docs/testing.md` "What is already known" |
| G6 | The device label defaults to the vault name. Two devices on the same vault get the same label, so the conflict copy read "from Demo vault" on both sides. | `main.ts:313`; screenshot `B-09` |
| G7 | After joining, the pane shows the vault key in a text field, although the pairing copy says it "is never displayed". | screenshot `B-07` |
| G8 | No restore-from-recovery-kit control (§1.6). | — |
| G9 | No live updates, although the relay broadcasts stored events to live subscribers (`http.rs:41-46`). `Relay.exchange` swaps `socket.onmessage` per request, so the client cannot hold a subscription open. | `relay.ts:180-208` |
| G10 | One namespace (`vault:main`) per account, so an account syncs exactly one vault. | `main.ts:172`; the grant carries it |

---

## 2. Compatibility test: the built plugin inside OpenMarkdown

### 2.1 Set-up

- **App.** The built OpenMarkdown (`apps/web/dist`) served by `node e2e/server.mjs` on http://localhost:5200 (it was already running).
- **Plugin.** `../opensync-obsidian/{manifest.json, main.js, styles.css}`, the production build (`main.js` 1,745,138 bytes, 13 Sep 13:07, `__TEST_BUILD__` off). It was installed with `app.plugins.installFromFiles()` and `enablePluginAndSave()` after `plugins.setEnable(true)`, as in `e2e/compat/lib.mjs`.
- **Relay.** `../opensync/target/release/opensync-relay` on an OS-assigned loopback port, with `require_auth = true` (the same config as the plugin's own `checks/harness.mjs`).
- **Devices.** Two isolated Playwright Chromium contexts, "A" and "B", each on `?vault=demo` (the in-memory adapter). Then two tabs of one OPFS vault, then a 2,000-note vault.
- **Scripts and output** live in the session scratchpad (`…/scratchpad/research-sync/`). `compat.mjs` covers the end-to-end run, `compat2.mjs` two tabs and the hosted relay, and `compat3.mjs` request counts. Raw results are in `out/results*.json`, screenshots in `out/*.png`.

### 2.2 Results

| Step | Result |
|---|---|
| Install and enable (A and B) | ✅ `{"ok":true,"id":"opensync","instance":true}` in about 50 ms, wasm instantiation included. The `opensync:sync-now` command, the settings tab and the status bar item ("OpenSync: idle") are all present. |
| Settings tab renders (screenshot `A-02`) | ✅ All controls render with OpenMarkdown's `Setting` components: text, button, `setCta`, toggle, heading. The hosted relay is pre-filled. |
| Configure A: local relay and storage fields, **Generate** vault key and account key | ✅ The pane re-renders into "Your devices". `metered:false` (self-hosted). `data.json` was written to `.obsidian/plugins/opensync/data.json` and contains the `ovault1` key in plaintext. |
| A: create `OpenSync test/hello.md`, then **Sync now** | ✅ "OpenSync: up to date"; the relay holds 17 blobs (demo vault plus the note). |
| A: **Add a device → Show a code** (`A-05`) | ✅ QR drawn on a canvas; `opensync://pair?ws=ws%3A%2F%2F127.0.0.1%3A…#<code>` shown, plus the loopback warning. |
| B: paste the URI into **Join from a code** (`B-06` → `B-07`) | ✅ Joined in **2.3 s**. Notice "Joined the account on Demo vault (yy2k-gffw)". A's pane reads "Done — that device now has this account." B kept `ws://127.0.0.1:…/` and `http://127.0.0.1:…`. |
| B: Sync now | ✅ `hello.md` arrives with the same bytes. **No conflict copies**, although B already held an identical demo vault with no merge base. |
| B edits, B syncs, A syncs | ✅ A sees "edited on B". |
| Concurrent edit: A and B both change `hello.md`; A syncs, B syncs, A syncs | ✅ Both keep "B's concurrent edit" at the path, plus `hello (conflict 2026-09-14 from Demo vault).md` containing A's text. Notice "1 conflict — both versions kept" (`B-09`). The label is useless (G6). |
| Attachments on the self-hosted relay: toggle on in both, A creates a 4,096-byte `blob.bin` | ✅ It reaches B with 4,096 bytes. |
| Delete on A, sync both | ✅ On B, `blob.bin` is removed from the vault and appears in `.trash/blob.bin` (OpenMarkdown's `trashFile` honours `trashOption`). |
| Recovery kit (`A-10`) | ✅ Rendered and read back: "Reads back as account yy2k-gffw. Print this page." |
| Disable, then re-enable the plugin | ✅ Pointer and base kept; status returns to "up to date". |
| **Console errors** | Only `Failed to load resource: 404` (18 on A, 5 on B). All come from `HEAD http://127.0.0.1:…/<sha256>`, i.e. `hasBlob` probing for blobs before upload, which is expected. **No page errors, no warnings, no missing API.** |

**Two tabs of one OPFS vault** (`compat2.mjs`):

- The second tab loaded the plugin automatically, because `community-plugins.json` and `data.json` are shared storage and `enable-plugin` is in localStorage.
- So both tabs ran their own sync loop, and **no Web Lock was held** (`navigator.locks.query()` returned `held: []`).
- Three rounds of both tabs editing different notes and syncing simultaneously: no data loss and no conflict copies, and both tabs finished at generation 4.
- That is benign only because both tabs read the same files. The risks are duplicated work, two `Relay` watermarks racing on same-second pointer events (`relay.ts:57-65`), and `data.json` being last-writer-wins.

### 2.3 Cost on a 2,000-note vault (memory adapter, loopback relay, `compat3.mjs`)

2,000 notes of about 2.2 KB each, 4.4 MB in total.

| Sync | Wall time | Requests to the relay |
|---|---|---|
| First sync | 6.7 s | 2,012 `HEAD` + 2,012 `PUT` |
| After a one-line edit to one note | 1.5 s | **2,012 `HEAD`** + 2 `PUT` + 1 `GET` |
| Nothing changed | 0.21 s | 1 `GET` |

Sealing is cheap: a no-change sync re-stages all 4.4 MB in about 200 ms. The round trips are the cost (G2). On a folder vault the full re-read (G3) adds one File System Access read per file per sync.

### 2.4 Hosted relay reachability from a page origin

This was checked read-only from `http://localhost:5200`.

- `GET https://relay.opensync.network/` (NIP-11): **200**, readable, so CORS is permitted. The document declares `auth_required: true` and `restricted_writes: true`. Its description still says "OpenObsidian".
- `HEAD /<64 zeros>`: **404**, readable.
- `new WebSocket("wss://relay.opensync.network/")`: **opens**.

Nothing was published to production.

### 2.5 What this test did not cover

- **Folder vaults** (File System Access). Headless automation cannot grant `showDirectoryPicker`. The plugin talks only to `app.vault`, so the adapter is transparent to it, but external-change reconciliation (`vault.sync()` on focus) is untested with sync.
- **Obsidian desktop in the loop.** Not run, by rule. Interop is inferred: the bundle, wasm and namespace are the ones the plugin's own `checks/obsidiancheck.mjs` verifies inside Obsidian.
- Mobile browsers, mixed-content relays, an unadmitted account on the production roster, and quota.

---

## 3. Browser constraints that shape the design

| Constraint | Consequence |
|---|---|
| **CORS** | The relay already sends `Access-Control-Allow-Origin: *` on every route, embedded relay included, and WebSockets are not subject to CORS. No proxy and no companion extension are needed. A third-party Blossom server without CORS would fail; that is not in scope. |
| **Mixed content** | OpenMarkdown served over `https://` **cannot** open `ws://192.168.x.x` or fetch `http://` blob URLs. A LAN relay needs `wss://` (e.g. `tailscale serve`, as `opensync-obsidian/docs/testing.md` already recommends for mobile Obsidian). Only `localhost` is exempt. The UI must say so before the user types a LAN address, not after the socket fails. |
| **Local Network Access / Private Network Access (Chromium)** | A public HTTPS origin reaching a loopback or private-IP relay may trigger a browser permission prompt or preflight. The copy for "use your own relay" needs to warn about it. |
| **Wasm under CSP and the service worker** | The app sets no CSP today. Community plugins need `eval`, so a strict CSP is impossible anyway; if one is added, it needs `'wasm-unsafe-eval'` and a `connect-src` that allows arbitrary user relays. `apps/web/src/sw.ts` intercepts only `__vault_resource__/…`, so the relay and a `.wasm` asset pass through. A future precache worker must not cache relay traffic. |
| **Wasm size** | `inline.ts` is 1.65 MB of base64 and the loose `.wasm` is 1.24 MB. The built-in feature must load **lazily**, only for enrolled vaults or when setup opens, and should fetch the `.wasm` as an asset with `instantiateStreaming` rather than parse base64. |
| **Background sync** | None worth promising. Periodic Background Sync is Chromium-only, installed-PWA-only and engagement-throttled to hours. A service worker cannot prompt for folder permission. So sync runs while a tab is open. It pulls immediately on open and on focus, flushes on `visibilitychange: hidden`, and `beforeunload` warns when changes are unpublished. |
| **Multiple tabs** | Every tab loads every enabled plugin (measured, §2.2). Built-in sync must elect **one syncing tab per vault** with `navigator.locks` and coordinate over `BroadcastChannel`. |
| **OPFS vs folder vaults** | OPFS lives only in this browser profile and can be evicted (`navigator.storage.persist()` is already requested in `boot.ts`). Sync turns an OPFS vault into something recoverable: re-join and pull. A folder vault needs its permission re-granted with a gesture after a reload. Sync starts only after the vault opens, which already handles `needs-permission`. |
| **The same folder open in Obsidian desktop** | One set of files with two apps is **one device**. If both run the community plugin they share `data.json` and behave like the two-tab case. If OpenMarkdown ran *built-in* sync with its own state while desktop ran the plugin, the result would be two devices writing one folder, with conflict copies from every overlapping edit. This must be detected (§5.4). |
| **Same-realm community plugins** | Any community plugin runs in the page's global scope. It can read IndexedDB, call a non-extractable `CryptoKey`, or patch `app.internalPlugins`. No in-page key storage survives hostile same-origin code; the plugin's `docs/security.md` says the same about Obsidian. |

---

## 4. Options compared

| | (a) Ship the plugin preinstalled as the built-in feature | (b) Native core plugin with its own copy of the sync loop | **(c) Hybrid: native core plugin over a sync loop shared in `opensync/packages/client`, plus the plugin kept loadable** |
|---|---|---|---|
| Engineering now | Almost none; it works (§2) | Large: port the loop, the tier gate and rotation | Medium: extract the loop in opensync (E1), then build UI and host glue here |
| One engine copy | ✗ unless rebuilt from source with the `vendor/` import aliased, because the plugin imports its vendored copy | ✓ for the client, but **✗ for the loop**: `covers`, scope and generation handling copied. A divergence there loses data exactly as a wire-format copy would; `opensync/checks/plugincheck.ts` is already a hand-kept mirror of it | ✓ one client, one loop, one wasm |
| Interop with Obsidian desktop | ✓ same bytes | Only as long as the two loops agree | ✓ by construction |
| Restricted mode | Must be off for a first-party feature | Not involved | Not involved |
| Keys at rest | Plaintext in `.obsidian/plugins/opensync/data.json`, inside the vault folder (G4) | IndexedDB, outside the vault | IndexedDB, outside the vault |
| "Engine stays invisible" | ✗ raw `nsec1`/`ovault1` fields, "Nostr key", relay jargon | ✓ | ✓ |
| Onboarding before a vault exists ("Open a synced vault") | ✗ | ✓ | ✓ |
| Multi-tab lock, live pull, file-explorer badges, conflict review, file-recovery hook | ✗ | ✓ | ✓ |
| Startup cost for users who do not sync | 1.75 MB evaluated on every load for anyone who enables it | Lazy | Lazy |
| Same folder open in Obsidian desktop with the plugin | Shares `data.json`, so it works like two tabs | Two devices on one folder unless detected | Detected, so the plugin keeps syncing that folder (§5.4) |

**Decision: (c).**

- (a) fails three of the owner's rules at once: Restricted mode for a first-party feature, a visible engine, and a second engine copy. It also leaves keys in the vault folder.
- (b) trades a second wire-format copy for a second copy of the merge and deletion logic, which fails the same way: silently, as lost files.
- Extracting the loop into the engine lets the plugin, OpenMarkdown and any future web surface run one implementation, verified once against a real relay.

**Fallback if E1 is refused.** Build (b), but make the §5.11 interop test, which runs the community-plugin bundle as the peer device, a required gate, and pin the loop to the plugin's version in a comment. Treat it as debt, not as the design.

---

## 5. Implementation spec

### 5.1 Prerequisites in the engine

E1 is required. E2–E6 are needed for acceptable performance. All are specified in §6.

E1 creates `opensync/packages/client/src/vault.ts` with this surface (proposed):

```ts
export const FREE_EXTENSIONS: readonly string[];
export function covers(manifest: ManifestJson, path: string): boolean;
export function storageFor(ws: string): string;
export function isMetered(relayWs: string, hostedRelay: string, plan: "free" | "supporter"): boolean;

export interface VaultHost {
  list(): Promise<{ path: string; size: number; mtime: number }[]>;   // visible files; the loop applies scope
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;              // creates parent folders
  trash(path: string): Promise<void>;
  beforeReplace?(path: string, current: Uint8Array, reason: "remote-update" | "remote-delete"): Promise<void>;
}
export interface SyncState { pointer: Pointer | null; base: ManifestJson | null; uploaded?: string[] /* E3 */ }
export interface StateStore { load(): Promise<SyncState>; save(s: SyncState): Promise<void> }
export interface SyncOutcome { pulled: string[]; pushed: number; deleted: string[]; conflicts: { path: string; copy_path: string }[]; heldBack: string[]; generation: number }

export class VaultSync {
  constructor(o: { keys: Keys; endpoint: Endpoint; namespace: string; device: string;
                   carryAll: boolean; host: VaultHost; state: StateStore; signal?: AbortSignal });
  sync(): Promise<SyncOutcome>;
  rotate(onProgress: (line: string) => void): Promise<string>;
  watch(onRemote: () => void): () => void;   // E4 live pointer subscription
  close(): void;
}
```

The body is `runSync`, `applyRemote`, `publish` and `rotate` from `opensync-obsidian/src/main.ts:459-719`, unchanged in behaviour, with `app.vault` replaced by `VaultHost`.

### 5.2 Files in openobsidian

```
packages/app/src/core-plugins/opensync/
  index.ts          CorePluginDefinition { id:"opensync", name:"Sync", hidden:true, defaultOn:true }; tiny, no engine import.
                    Reads the device record; registers the status bar, commands, settings tab, file-menu and explorer hooks;
                    dynamic-imports ./engine only when enrolled or when setup opens.
  engine.ts         Loads @opensync/client, pre-initialises wasm from the asset URL, builds VaultSync with the host and state below.
  host.ts           VaultHost over app.vault: list() = vault.getFiles(); read = readBinary; write = modifyBinary/createBinary + createFolder;
                    trash = fileManager.trashFile; beforeReplace → file-recovery forceAdd for md/canvas.
  store.ts          IndexedDB records: device record (wrapped keys), sync state, per-file index; wrap/unwrap with a non-extractable AES-GCM key.
  scheduler.ts      Dirty tracking, debounce, focus/online/visibility triggers, backoff, live watch, pause.
  leader.ts         navigator.locks leader election + BroadcastChannel protocol (§5.6).
  status.ts         Status bar item and its menu; mobile ribbon fallback.
  settings-tab.ts   Settings → Sync (§5.7).
  pair.ts           "Add a device" (QR/URI/code) and "Join" flows over grantAccount/joinAccount; scan button when canScan().
  kit.ts            Recovery kit view: print-friendly, read-back check; "Restore from a recovery kit" (readRecoveryKit).
  conflicts.ts      Conflict review modal, reusing core-plugins/file-recovery/diff.ts.
  explorer.ts       Per-file sync badges through a file-explorer decorator hook.
  coexist.ts        Detection of the community plugin `opensync` and the refusal rules (§5.4).
  opensync.css      vault-sync-* classes, colours only via Obsidian CSS variables.
  unavailable.ts    Stub used when ../opensync is absent at build time (§5.3).
packages/app/src/starter.ts             + "Open a synced vault" action (join → create browser vault or pick folder → first pull).
packages/app/src/core-plugins/group-*.ts  register `opensync`.
packages/app/src/obsidian/vault/idb.ts   STORES += "sync"; DB_VERSION 3 → 4.
packages/app/src/obsidian/app-internals/plugins.ts  canRun(): refuse community `opensync` when built-in sync is enrolled for this vault.
packages/app/src/core-plugins/file-explorer/*       internal decorator hook: instance.registerDecorator((file, titleEl) => void).
apps/web/vite.config.ts                  alias + fs.allow + dedupe (§5.3).
packages/app/tsconfig.json               paths for @opensync/client.
e2e/sync.spec.ts, e2e/sync-interop.spec.ts, e2e/sync-tabs.spec.ts, e2e/compat/opensync.mjs, e2e/relay.mjs (§5.10).
```

### 5.3 Build wiring by relative path

- **`apps/web/vite.config.ts`**
  - `resolve.alias["@opensync/client"] = resolve(__dirname, "../../../opensync/packages/client/src/index.ts")`, and the same for `@opensync/client/scan` and `@opensync/client/qr` if split.
  - **When `../../../opensync/packages/client/src` does not exist**, alias to `packages/app/src/core-plugins/opensync/unavailable.ts` and print one build warning. A public clone then builds without sync, and there is still **no second copy**. The Sync tab says "This build does not include sync." CI for the release build must fail if the alias fell back (`OPENMARKDOWN_REQUIRE_SYNC=1`).
  - `server.fs.allow`: the repo root plus `../opensync/packages/client`, for `vite dev`.
  - `resolve.dedupe: ["@noble/curves", "@noble/hashes"]`, and add both to `packages/app` dependencies at the client's ranges (`^1.6.0`, `^1.5.0`). Files under `../opensync` otherwise resolve `@noble/*` from `opensync/packages/client/node_modules`, which exists only on machines that ran `npm install` there.
  - **Wasm asset.** `import wasmUrl from "@opensync-wasm/opensync_wasm_bg.wasm?url"` (alias to `../opensync/packages/client/src/wasm/`). `engine.ts` calls the glue's `init({ module_or_path: wasmUrl })` before anything calls `ready()`. `init` is idempotent (`opensync_wasm.js:2355`).
  - Until E6 lands, alias the exact file `…/client/src/wasm/inline.ts` to a local stub exporting `WASM_BASE64 = ""`, so the 1.65 MB base64 is not bundled. `ready()` then calls `init` with empty bytes and returns early, because wasm is already instantiated. This works but is brittle, and E6 replaces it.
- **`packages/app/tsconfig.json`.** `"paths": { "@opensync/client": ["../../../opensync/packages/client/src/index.ts"] }`. The client typechecks cleanly under `tsconfig.base.json` today: `tsc` over `packages/client/src/index.ts` with OpenMarkdown's base config reported 0 errors.
- **Lazy chunk.** `index.ts` must import only types from `@opensync/client`. Everything else goes through `await import("./engine")`, which makes one lazy chunk (client, noble, glue) plus the `.wasm` asset.
- **`e2e/relay.mjs`.** Starts `../opensync/target/release/opensync-relay` on a free port, as `opensync-obsidian/checks/harness.mjs:66-100` does. If the binary is missing it prints the exact build command (`cargo build --release -p opensync-relay --manifest-path ../opensync/Cargo.toml`) and marks the sync specs skipped. It must not report them as passing.

### 5.4 Identity, lifecycle and coexistence with the community plugin

- **Core plugin id `opensync`, `hidden: true`.**
  - Not `sync`: Obsidian's own Sync core plugin is `sync` (`obsidian-features.md` §3.24). Writing `"sync": true` into a shared `.obsidian/core-plugins.json` would switch Obsidian Sync on in desktop Obsidian, and plugins that probe `internalPlugins.plugins.sync` expect Obsidian's object.
  - Hidden means it is always registered, **dormant until this vault is enrolled on this device**, and writes nothing to `core-plugins.json`.
  - Whether a vault syncs is device state in IndexedDB, not vault config.
- **Command ids reuse the plugin's.** `opensync:sync-now` is the plugin's command id, so hotkeys bound in `.obsidian/hotkeys.json` carry over. That is also why the two must never be loaded together.
- **Mutual exclusion** (`coexist.ts` plus a hook in `plugins.ts` `canRun`):
  1. **Built-in enrolled for this vault.** The community `opensync` is refused with the Notice: "Sync is built in and already syncing this vault. The OpenSync plugin was not loaded."
  2. **Community plugin enabled in `community-plugins.json` and its `data.json` has an `accountSecret`.** Built-in stays dormant. The status bar says "Synced by the OpenSync plugin". Settings → Sync offers two ways out:
     - **Use built-in sync instead** (only for a browser vault, or a folder vault the user confirms is not also open in Obsidian desktop). This imports `accountSecret`, `namespaceKey`, `namespace`, relay, `_pointer` and `_base` from `data.json` into IndexedDB. No key is typed: the keys already live on this device. It then disables the plugin, and for a browser vault only, removes the keys from its `data.json`.
     - **Leave it**, which is the default for folder vaults. Removing keys from a folder's `data.json` would break Obsidian desktop's copy of the plugin.
  3. Neither: offer set-up.
- **One vault per account per browser** (G10). Enrolling a second OpenMarkdown vault on an account already linked in this browser is refused. Otherwise both vaults would merge into `vault:main`. Lifting this needs E7.

### 5.5 Data model and key storage

| Record (IndexedDB `vault-app` → store `sync`) | Contents |
|---|---|
| `wrapkey` | `CryptoKey` AES-GCM 256, **`extractable: false`**, generated once per origin by `crypto.subtle.generateKey`, stored by structured clone |
| `device:<vaultId>` | `{ v:1, accountId (kit fingerprint), namespace, relayWs, relayHttp, hostedRelay, deviceLabel, plan, carryAttachments, paused, enrolledAt, wrapped: { iv, ct } }`, where `ct = AES-GCM(wrapkey, JSON{accountSecret, namespaceKey})` |
| `state:<vaultId>` | `{ pointer, base, uploaded (E3), lastSyncAt, lastError }` |
| `index:<vaultId>` | `path → { size, mtime, contentHash }` for the last published or applied version (explorer badges, E5 incremental staging) |
| `conflicts:<vaultId>` | Unresolved `{ path, copy_path, at, from }` |

- **What the wrapping key buys, stated honestly.** The keys are not in the vault folder, not in exports or zips, and not in anything that syncs the folder. Script cannot *export* the raw wrapping key.
- **What it does not buy.** Same-origin code can still ask the key to decrypt, and a copy of the browser profile's IndexedDB still holds the key material. The secp256k1 account key and the vault key are used in JS and wasm memory while sync runs. Neither WebCrypto nor wasm can keep them non-extractable, so both are unwrapped into memory per session.
- **The Keychain tab.** OpenMarkdown's `SecretStorage` is plain localStorage (`public-classes.ts:4-30`), and the Keychain settings tab lists it. **Do not store sync keys there.**
- **v2: passkey lock.** Wrap with a WebAuthn PRF-derived key, so opening a synced vault needs a passkey tap.
- **"Disconnect this device"** deletes `device`, `state`, `index` and `conflicts`, and leaves the files.

### 5.6 Engine host behaviour

- **Scheduling.**
  - Vault `create`, `modify`, `delete` and `rename` mark the vault dirty. `raw` events from `vault.sync()` reconciliation of external edits count too.
  - A dirty vault syncs after **5 s** of quiet, capped at 60 s of continuous editing.
  - Sync also runs on layout-ready, on window `focus`, on `visibilitychange` to visible (after `vault.sync()` has reconciled), and on `online`.
  - When the vault becomes hidden, it flushes if dirty.
  - While visible it pulls every 60 s, until E4 provides a live subscription; with E4 it pulls on push and polls every 5 min as a fallback.
  - Errors back off exponentially: 5 s → 5 min.
  - This fixes G1.
- **Leader election** (`leader.ts`).
  - Every tab calls `navigator.locks.request("opensync:" + vaultId, { mode: "exclusive" }, () => leaderLife)`. The holder is the leader and only the leader constructs `VaultSync`.
  - Followers show "Syncing in another tab". They post `{ t: "dirty" }` on `BroadcastChannel("opensync:" + vaultId)` when their vault changes.
  - The leader posts `{ t: "status", … }` and `{ t: "applied", paths }`. Followers answer `applied` with `app.vault.sync()`, since OPFS and folder storage are shared.
  - When the leader tab closes, the browser releases the lock and the next tab takes over.
  - A second lock, `opensync:account:<accountId>`, enforces one vault per account (§5.4).
- **Remote writes and file recovery.** Before `VaultSync` overwrites or trashes a local `.md` or `.canvas`, `beforeReplace` calls `internalPlugins.getEnabledPluginById("file-recovery")?.forceAdd(path, text)` (exists: `file-recovery/index.ts:45`). Every remote change is then undoable from "Open local history".
- **Conflicts.** `SyncOutcome.conflicts` is appended to `conflicts:<vaultId>`. A Notice appears, "1 conflict — both versions kept", with a **Review** button.
- **Errors mapped to words.**
  - `QuotaError` → "Sync storage is full" with the tier choices.
  - `NotAdmittedError` → "This sync server has not admitted your account", with self-host help. Production runs a roster.
  - Network failure → "Offline — will retry".
  - Loopback on a phone → the existing `Relay.unreachable` text.
  - Mixed content (`https:` page, `ws:` relay) is caught *before* connecting.
- **Default device label.** "<Browser> on <OS>" from `navigator.userAgentData` or the UA, e.g. "Edge on macOS", never the vault name (G6). The user can edit it.

### 5.7 UI surfaces

Names use "Sync", so the engine stays invisible. "OpenSync" appears only in the About or Advanced text and in the recovery kit, where the CLI is named.

- **Settings → Sync** (`addSettingTab`, id `opensync`, listed under Options).
  - **Not set up.**
    - **Turn on sync.** Generates both keys silently, then shows the recovery kit step: "Print it now", with Print and "I've saved it". The sync server is the hosted one by default.
    - **Join from another device.** A code or URI field, **Scan** when `canScan()` (otherwise the `whyNotScannable()` text), and **Join**. After joining it pulls immediately.
    - **Restore from a recovery kit.** A textarea, `readRecoveryKit`, a fingerprint shown for confirmation.
    - **Use my own sync server** (disclosure): one address field (`mirror()` semantics from `ui/settings.ts`), with wss and HTTPS guidance.
  - **Set up.**
    - **Status.** Last synced, account fingerprint (`yy2k-gffw`), server host, this device's name, Pause/Resume, **Sync now**.
    - **Devices.** **Add a device**: QR, the URI line with a copy button, the code, and the loopback, LAN and mixed-content warning. It runs until answered or it times out, and a Cancel button abandons it.
    - **What syncs.** Notes and other text (always). **Attachments**: a toggle with the tier text from §5.10, the held-back count and a **View** button. "Settings and plugins (`.obsidian`)" is shown disabled with "Not yet" (§5.9).
    - **Recovery kit.** Show or print, with read-back.
    - **Advanced.** Server and storage addresses; **Rotate encryption key** (two presses, same copy and namespace warning as the plugin); **Show keys** (confirm, then masked with a reveal, the escape hatch the plugin's fields are); **Disconnect this device**.
- **Status bar** (`addStatusBarItem`, class `plugin-opensync`, so themes and snippets aimed at the plugin keep working).
  - States: icon plus "Synced" / "Syncing…" / "Offline" / "Paused" / "Needs attention" / "Syncing in another tab" / "Synced by the OpenSync plugin". Hidden when not set up.
  - Clicking opens a menu: Sync now, Pause or Resume, Review conflicts (n), Files not synced (n), Sync settings.
  - Tooltip: last synced time and the last error.
- **Ribbon.** None on desktop layout, as Obsidian's Sync has none. With `Platform.isMobile`, where the status bar is hidden, a `refresh-cw` ribbon action opens the same menu.
- **File explorer.**
  - A small badge on `.nav-file-title` via the new decorator hook: `vault-sync-pending` (differs from the last synced index), `vault-sync-held` (outside the plan's scope), `vault-sync-conflict` (a conflict copy, or a file with an unresolved conflict). Synced files show nothing.
  - File menu: "Sync status…" (last synced, from which device when known), and "Resolve conflict…" on conflict files.
- **Conflict review modal.**
  - Lists unresolved pairs. For text files it shows a side-by-side diff of the original and the copy, using `file-recovery/diff.ts`.
  - Actions: **Keep this device's**, which deletes the copy. **Keep other device's**, which writes the copy's content to the path and deletes the copy; file recovery snapshots first. **Keep both**, which dismisses.
  - Resolution is ordinary editing, so it syncs normally.
- **Starter screen** (`starter.ts`). A new action, **Open a synced vault**: join by code, then "Store it in this browser" (creates an OPFS vault named after the grant's device) or "Choose a folder" (with a merge warning if the folder is not empty). It enrols, pulls, then opens the vault.
- **Files not synced view.** A modal listing held-back paths with sizes, and why ("Attachments are part of the paid plan on the hosted server").

### 5.8 Commands

Core plugin commands carry full ids and are not prefixed.

| Id | Name | Available when |
|---|---|---|
| `opensync:sync-now` | Sync: Sync now | enrolled (same id as the plugin, so hotkeys carry over) |
| `opensync:pause` | Sync: Pause sync | enrolled, running |
| `opensync:resume` | Sync: Resume sync | enrolled, paused |
| `opensync:open-settings` | Sync: Open sync settings | always |
| `opensync:add-device` | Sync: Add a device… | enrolled |
| `opensync:join` | Sync: Join a synced vault… | not enrolled |
| `opensync:show-recovery-kit` | Sync: Show recovery kit | enrolled |
| `opensync:review-conflicts` | Sync: Review conflicts | enrolled and conflicts > 0 |
| `opensync:show-held-back` | Sync: Show files not synced | enrolled and held back > 0 |

### 5.9 Settings and what lives where

| Setting | Stored in | Default |
|---|---|---|
| Enrolled, keys, account id, namespace | IndexedDB `device:<vaultId>` (device) | not enrolled |
| Server (ws) and storage (http) | IndexedDB (device) | `HOSTED_RELAY_WS` / `HOSTED_RELAY_HTTP` from `hosted.ts` |
| Device name | IndexedDB (device) | "<Browser> on <OS>" |
| Sync automatically / paused | IndexedDB (device) | on / not paused |
| Attachments wanted | IndexedDB (device), matching the plugin, where it is per device | off |
| Plan | from the account once one exists; until then a test-build-only control, as in the plugin | free |

**`.obsidian/` is not synced in v1.** It is not a choice that can be deferred casually:

- The plugin never stages hidden paths.
- A manifest from a desktop device therefore lacks `.obsidian/app.json` while its `scope` (the free list includes `json` and `css`) *covers* it.
- An OpenMarkdown device that published config would see desktop's manifest as deleting that config and trash it.

Config sync needs E8, a manifest scope that can express path classes, or a separate namespace rotated together with the vault. Even then, `.obsidian/plugins/opensync/data.json`, `workspace*.json`, `.trash/` and plugin `main.js` files must never sync.

### 5.10 Tiers and billing

- **The gate.** `carryAll = carryAttachments && !isMetered(relayWs, hostedRelay, plan)`, from E1. Scope semantics are identical to the plugin's, so mixed plugin and OpenMarkdown devices on different plans cannot delete each other's attachments.
- **The hosted server.** The Attachments toggle is disabled on free and explains the paid plan or the self-hosting option.
- **Buying.** There is no billing endpoint, account server or entitlement API to call (§1.7). Do **not** build a purchase flow; show "Coming soon" text only.
- **Credits.** When the openapps credits and account integration exists, `plan` comes from it (`openapps-integration`). The relay's allowance binding is the open item in `opensync/PLAN.md` "Next 1".
- **Admission.** Production admits accounts by roster. A fresh "Turn on sync" on the hosted server fails with `NotAdmittedError` until someone admits the npub. **This blocks shipping the hosted default**: the owner needs a signup or auto-admit path first (Q1).

### 5.11 Test plan

**Unit tests** (`e2e/unit/*.spec.ts`, in the browser):
- `store.ts` wrap and unwrap round-trip. The CryptoKey is non-extractable: `exportKey` rejects.
- The leader protocol with two `BroadcastChannel`s.
- Default device label formatting.
- Mixed-content detection: `https:` page with `ws:` relay → refused before connecting.
- `coexist.ts` decision table: the plugin enabled with and without keys, crossed with browser and folder vaults.

**End-to-end** against a local relay started by `e2e/relay.mjs`, auth on:

1. **`e2e/sync.spec.ts`**, two browser contexts on OPFS vaults.
   - A: Turn on sync, set the server to the local relay, check the kit step shows and reads back, write a note, and see "Synced".
   - A: Add a device. B: starter → Open a synced vault → paste the URI → "Store it in this browser". B opens with A's note and **no key was ever typed**. Assert that neither key appears in B's DOM, in `localStorage`, or in any vault file (`adapter.scan()` plus grep).
   - **Live pull (G1):** B makes no edits; A edits; B's note updates within 10 s without "Sync now".
   - **Conflict:** B goes offline with `context.setOffline(true)`, both edit, B comes back online. Assert both versions, the copy named after A's label, the Review modal, "Keep other device's" converging on both, and a file-recovery snapshot of the replaced text.
   - **Delete:** the file goes to `.trash` on the other side, with a snapshot.
   - **Tiers:** A on free with a hosted-relay alias (build flag pointing `hostedRelay` at the test relay's host), B carrying everything. B adds an image. Assert A never receives it, *and* A's publish does not delete it on B. Then A→B→A plan flips; nothing disappears anywhere, mirroring `opensync-obsidian/checks/tierscheck.mjs`.
   - **Rotation:** A rotates; B shows "Needs attention" and cannot read anything; after re-pairing, B syncs.
   - **Errors:** relay killed → "Offline", recovers when restarted; relay with `admission = "roster"` and the account not admitted → the not-admitted message; a small `max_blob_bytes` or quota → the quota message.
   - **Screenshots** of every surface, embedded in the test guide (per `openapps-ship`).
2. **`e2e/sync-interop.spec.ts`: the wire-compatibility gate.**
   - Context A runs built-in sync. Context B runs the **community plugin bundle `../opensync-obsidian/main.js`**, installed as in §2.1. B stands in for Obsidian desktop, because the plugin is what desktop runs.
   - Pair in both directions (A grants B joins, then a fresh pair with B granting A joining), edit, conflict, delete, attachments with scope mismatch.
   - Assert byte-identical vaults and `generation` agreement.
   - Also assert mutual exclusion: enrolling built-in sync in B while the plugin holds keys is refused; installing the plugin in A while built-in is enrolled is refused.
3. **`e2e/sync-tabs.spec.ts`.** Two pages of one OPFS vault in one context.
   - Exactly one `navigator.locks.query().held` entry named `opensync:<vaultId>`; the follower's status bar reads "Syncing in another tab"; follower edits are published by the leader.
   - Closing the leader page promotes the follower within 2 s.
   - 20 concurrent edit rounds leave 0 conflict copies, and the relay receives exactly one publish per round.
4. **Cost regression (after E2, E3, E5).** A 2,000-note vault with a one-note edit makes **≤ 10 HTTP requests** and finishes in < 500 ms on loopback; a no-change sync makes 1 request. The request counter is `context.on("request")`, as in `compat3.mjs`.
5. **`e2e/compat/opensync.mjs`.** Add the plugin to the community compatibility suite: load, settings tab, generate, sync to a local relay, pair, and 0 page errors, ignoring `HEAD` 404s. Any regression in OpenMarkdown's plugin API that breaks it then fails CI, independent of the built-in feature.
6. **Folder vaults.** Headless Chromium cannot grant `showDirectoryPicker`. Run the same flow through a test hook that opens a `HandleAdapter` over an OPFS subdirectory with `kind: "folder"`, and do a manual pass in Edge on a real folder that is also open, read-only, in a text editor. The manual pass checks external-edit reconciliation followed by sync.

---

## 6. Changes needed in opensync and opensync-obsidian

Listed only. None were made.

| # | Repo and file | Change | Why |
|---|---|---|---|
| **E1** | `opensync/packages/client/src/vault.ts` (new) plus the `index.ts` export | Move `runSync`, `applyRemote`, `publish`, `rotate`, `covers`, `sameContent`, `FREE_EXTENSIONS`, `storageFor`, the metered gate, and the `Pointer`/`ManifestJson`/`Commit` types out of `opensync-obsidian/src/main.ts:72-116, 199-250, 459-737` behind `VaultHost` and `StateStore` (§5.1). Fold `checks/plugincheck.ts` into a check that drives `VaultSync` itself. | One loop, not two (§4). `plugincheck.ts` is already a hand mirror. |
| E1b | `opensync-obsidian/src/main.ts` | Become a thin adapter: `VaultHost` over `app.vault`, `StateStore` over `saveData`. Add `vault.ts` to `FILES` in `scripts/vendor-client.mjs`. | The same loop in Obsidian. |
| **E2** | `opensync/packages/client/src/relay.ts` (or the loop's `publish`) | Stop sending a `HEAD` per blob per sync: skip blobs the base manifest already names, keep an `uploaded` set, use `Namespace.missingBlobs(manifest, have)`, and run the remaining `HEAD`/`PUT` with bounded parallelism (e.g. 6). Optionally use `GET /list/{pubkey}` once for a cold start. | 2,012 `HEAD`s for a one-line edit (§2.3). |
| **E3** | `relay.ts` | An `AbortSignal` with a timeout on every `fetch`, and a `close()` that aborts in-flight requests. | G5. |
| **E4** | `relay.ts` | `subscribePointer(namespace, onEvent): () => void`: a standing `REQ` with no `limit` on the shared socket, a message router instead of the per-exchange `onmessage` swap, and reconnect with resubscribe. The relay already broadcasts (`http.rs:41-46`). | G1, G9: live pull. |
| **E5** | `crates/opensync-wasm` + `opensync_wasm.d.ts` | `Namespace.stageEntry(path, entry)` (or `commitFrom(base, changed, removed)`), so unchanged files are carried from the base manifest without re-reading their bytes. | G3: large folder vaults. |
| **E6** | `opensync/packages/client/src/session.ts` | `ready(source?: URL \| Uint8Array \| WebAssembly.Module)`, with the inline base64 moved to its own entry (e.g. `@opensync/client/inline`) so a bundler that serves `.wasm` never pulls in `inline.ts`. The plugin keeps importing the inline entry. | Removes the stub alias hack (§5.3) and 1.65 MB of base64. |
| **E7** | `crates/opensync-core` rotate, `pairing` grant | Multiple vaults per account: a namespace per vault (`vault:<id>`), the namespace choice carried in the invitation, and rotation across every vault namespace. | G10. |
| **E8** | `crates/opensync-core` manifest scope | Scope that can express path classes (e.g. `{ ext:[…], hidden:["."+configDir] }`) so config sync cannot read as deletion. Alternatively a config namespace rotated atomically with the vault. | §5.9. |
| P1 | `opensync-obsidian/src/main.ts:292-296` | Pull on the interval even when not dirty (or adopt E4). Sync immediately after a successful Join. | G1; a joined device sat idle. |
| P2 | `opensync-obsidian/src/main.ts:313`, `:877-887` | Default device label from the platform ("Obsidian on Android", "Obsidian on macOS"), not the vault name. | G6. |
| P3 | `opensync-obsidian/src/main.ts:824-875` | Mask the key fields behind a "Show keys" control after enrolment. | G7; also keeps keys out of screenshots. |
| P4 | `opensync-obsidian/src/main.ts` | "Restore from a recovery kit" control using `readRecoveryKit`. | G8. |
| P5 | `opensync-obsidian/src/main.ts:666-672` | Move `accountSecret` and `namespaceKey` out of `data.json` into `app.secretStorage` (Obsidian ≥ 1.11.4; bump `minAppVersion` and add to `versions.json`). Keep the pointer and base in `data.json`. | G4: keys leave the vault folder on desktop too. OpenMarkdown's `SecretStorage` would then need a wrapped IndexedDB backend (§5.5) before the plugin relies on it here. |
| D1 | `opensync/README.md` (the "Each reaches in here by relative path" paragraph) and `QUICKSTART.md` (the stale "OpenObsidian … never loaded by Obsidian itself" row) | Say that opensync-obsidian vendors the client with a drift check. Add OpenMarkdown as the in-tree consumer by relative path. Update the relay's NIP-11 description ("OpenObsidian") to the current product names. | The docs contradict the repos. |

---

## 7. Open questions for the owner

1. **Admission on the hosted relay.** Should a new OpenMarkdown account be auto-admitted to the free (notes-only) allowance, or go through a signup page backed by `/admin/roster`? Without an answer, "Turn on sync" on the default server fails for everyone.
2. **E1 ownership.** Is moving the sync loop into `opensync/packages/client` acceptable? It is the change that keeps one implementation. The alternative, (b) plus an interop gate, is debt.
3. **Public build of OpenMarkdown.** Is "builds without sync when `../opensync` is absent" acceptable for public clones? The alternative is vendoring, as opensync-obsidian did, which the one-copy rule forbids.
4. **Naming in the UI.** Is it "Sync" everywhere, with "OpenSync" only in the kit and help? And is sharing the `opensync:sync-now` command id with the plugin, so hotkeys carry over, wanted?
5. **Folder vaults also open in Obsidian desktop.** Is "leave it to the plugin" the right default, or should built-in sync take over and tell the user to disable the plugin in Obsidian?
