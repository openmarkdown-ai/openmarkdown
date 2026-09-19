/**
 * Startup: choose a vault, then build the App around it.
 *
 * Three kinds of vault, by what the browser can do:
 *
 * - **folder** — a real directory on disk via the File System Access API
 *   (Chromium). The same folder Obsidian opens; edits show up in both.
 * - **browser** — a directory inside the origin-private file system. Works in
 *   every current browser, including Safari and Firefox, which do not expose
 *   real folders. Import and export move data in and out.
 * - **demo** — a browser vault seeded with sample notes.
 *
 * Directory handles are kept in IndexedDB. A folder handle needs permission
 * re-granted after a reload, and the browser only allows asking during a user
 * gesture, so a folder vault that has lost permission is reopened from a
 * button rather than automatically.
 */
import * as cmAutocomplete from "@codemirror/autocomplete";
import * as cmCollab from "@codemirror/collab";
import * as cmCommands from "@codemirror/commands";
import * as cmLanguage from "@codemirror/language";
import * as cmLint from "@codemirror/lint";
import * as cmSearch from "@codemirror/search";
import * as cmState from "@codemirror/state";
import * as cmView from "@codemirror/view";
import * as lezerCommon from "@lezer/common";
import * as lezerHighlight from "@lezer/highlight";
import * as lezerLr from "@lezer/lr";
import { Buffer } from "buffer";
import moment from "moment";
import { initEngine } from "@vault/engine";
import { exposeVimAdapter } from "./editor/vim";
import { tokenClassNodeProp } from "./editor/syntax/token-prop";
import { installDomExtensions } from "./obsidian/dom";
import { i18next } from "./obsidian/i18n";
import * as obsidian from "./obsidian/index";
import { App } from "./obsidian/app";
import { HandleAdapter, MemoryAdapter, type VaultAdapter } from "./obsidian/vault/adapter";
import { idb } from "./obsidian/vault/idb";
import { installResourceBridge, installResourceFallback } from "./obsidian/vault/resource";
import { setSharedModules } from "./obsidian/app-internals/plugins";
import { registerCorePlugins } from "./core-plugins/index";
import { installSettings, installUriHandling, parseObsidianUri } from "./settings/index";
import { installPwaInApp, installPwaShell } from "./pwa/index";
import { installPopouts } from "./obsidian/workspace/popout";
import { Workspace } from "./obsidian/workspace/workspace";
import { installCompanionBridge } from "./companion/index";
import { PRODUCT_NAME } from "./product";
import { demoVaultFiles } from "./demo-vault";
import { installStarterChrome, installWorkspaceChrome, type ChromeOptions } from "./chrome/account";

export interface VaultRecord {
  id: string;
  name: string;
  kind: "folder" | "browser";
  handle?: FileSystemDirectoryHandle;
  lastOpened: number;
}

export const supportsFolders = typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

function newId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function listVaults(): Promise<VaultRecord[]> {
  const entries = await idb.entries<VaultRecord>("handles", "vault:");
  return entries.map(([, v]) => v).sort((a, b) => b.lastOpened - a.lastOpened);
}

async function saveVault(v: VaultRecord) {
  await idb.set("handles", `vault:${v.id}`, v);
}

export async function forgetVault(id: string) {
  await idb.delete("handles", `vault:${id}`);
}

async function browserVaultsRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("vaults", { create: true });
}

export async function createBrowserVault(name: string, seed?: Record<string, string>): Promise<VaultRecord> {
  const id = newId();
  const dir = await (await browserVaultsRoot()).getDirectoryHandle(id, { create: true });
  const record: VaultRecord = { id, name, kind: "browser", lastOpened: Date.now() };
  await saveVault(record);
  if (seed) {
    const adapter = new HandleAdapter(dir, id, name, "browser");
    for (const [path, content] of Object.entries(seed)) await adapter.write(path, content);
  }
  try {
    await navigator.storage.persist?.();
  } catch {
    /* best effort */
  }
  return record;
}

export async function pickFolderVault(): Promise<VaultRecord> {
  const handle = await (window as unknown as { showDirectoryPicker(o: unknown): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: "readwrite", id: "vault" });
  for (const v of await listVaults()) {
    if (v.kind === "folder" && v.handle && (await v.handle.isSameEntry(handle))) {
      v.lastOpened = Date.now();
      await saveVault(v);
      return v;
    }
  }
  const record: VaultRecord = { id: newId(), name: handle.name, kind: "folder", handle, lastOpened: Date.now() };
  await saveVault(record);
  return record;
}

async function adapterFor(v: VaultRecord, requestPermission: boolean): Promise<VaultAdapter | "needs-permission"> {
  if (v.kind === "folder") {
    const handle = v.handle!;
    const h = handle as unknown as { queryPermission(o: unknown): Promise<string>; requestPermission(o: unknown): Promise<string> };
    let state = await h.queryPermission({ mode: "readwrite" });
    if (state !== "granted" && requestPermission) state = await h.requestPermission({ mode: "readwrite" });
    if (state !== "granted") return "needs-permission";
    const a = new HandleAdapter(handle, v.id, v.name, "folder");
    await a.init();
    return a;
  }
  const dir = await (await browserVaultsRoot()).getDirectoryHandle(v.id, { create: true });
  const a = new HandleAdapter(dir, v.id, v.name, "browser");
  await a.init();
  return a;
}

let booted = false;

function installGlobals() {
  installDomExtensions();
  const w = window as unknown as Record<string, unknown>;
  w.moment = moment;
  w.i18next ??= i18next;
  // Bundled npm libraries (isomorphic-git's buffer shim, for one) reference
  // Node's `global`; Obsidian's mobile runtime provides it as the window.
  w.global ??= window;
  // Node's Buffer, as Obsidian's mobile runtime provides it: obsidian-git's
  // isomorphic-git path and several sync plugins use it unguarded.
  w.Buffer ??= Buffer;
  // A CodeMirror 5 facade: several plugins register syntax modes on it for
  // code block highlighting. The modes are accepted and unused.
  class StringStream {
    pos = 0;
    start = 0;
    constructor(public string: string, public tabSize = 4) {}
    eol() { return this.pos >= this.string.length; }
    sol() { return this.pos === 0; }
    peek() { return this.string.charAt(this.pos) || undefined; }
    next() { return this.pos < this.string.length ? this.string.charAt(this.pos++) : undefined; }
    eat(m: string | RegExp) { const c = this.string.charAt(this.pos); const ok = typeof m === "string" ? c === m : m.test(c); if (ok) { this.pos++; return c; } return undefined; }
    eatWhile(m: string | RegExp) { const s = this.pos; while (this.eat(m)); return this.pos > s; }
    eatSpace() { const s = this.pos; while (/\s/.test(this.string.charAt(this.pos))) this.pos++; return this.pos > s; }
    skipToEnd() { this.pos = this.string.length; }
    skipTo(ch: string) { const i = this.string.indexOf(ch, this.pos); if (i > -1) { this.pos = i; return true; } return false; }
    backUp(n: number) { this.pos -= n; }
    column() { return this.start; }
    indentation() { return this.string.match(/^\s*/)?.[0].length ?? 0; }
    match(p: string | RegExp, consume = true) { if (typeof p === "string") { const ok = this.string.substr(this.pos, p.length) === p; if (ok && consume) this.pos += p.length; return ok; } const m = this.string.slice(this.pos).match(p); if (m && m.index === 0 && consume) this.pos += m[0].length; return m && m.index === 0 ? m : null; }
    current() { return this.string.slice(this.start, this.pos); }
  }
  const noop = () => {};
  w.CodeMirror ??= {
    defineMode: noop, defineMIME: noop, defineExtension: noop, defineOption: noop, defineSimpleMode: noop,
    registerHelper: noop, registerGlobalHelper: noop,
    getMode() { return { name: "null", token(s: StringStream) { s.skipToEnd(); return null; } }; },
    runMode: noop, startState: () => ({}), copyState: (_m: unknown, s: unknown) => (s && typeof s === "object" ? { ...s } : s),
    innerMode: (mode: unknown, state: unknown) => ({ mode, state }), extendMode: noop, resolveMode: (m: unknown) => m,
    modeInfo: [], findModeByName: () => null, findModeByExtension: () => null, findModeByMIME: () => null,
    modes: {}, mimeModes: {}, StringStream, Pass: {}, commands: {}, keyMap: {},
  };
  exposeVimAdapter();
  setSharedModules({
    obsidian,
    "@codemirror/autocomplete": cmAutocomplete,
    "@codemirror/collab": cmCollab,
    "@codemirror/commands": cmCommands,
    "@codemirror/language": { ...cmLanguage, tokenClassNodeProp },
    "@codemirror/lint": cmLint,
    "@codemirror/search": cmSearch,
    "@codemirror/state": cmState,
    "@codemirror/view": cmView,
    "@lezer/common": lezerCommon,
    "@lezer/highlight": lezerHighlight,
    "@lezer/lr": lezerLr,
  });
}

export interface BootOptions {
  root: HTMLElement;
  wasmUrl?: string | URL;
  serviceWorkerUrl?: string;
  /** The account control and brand mark (chrome/account.ts). Absent: neither is shown. */
  chrome?: ChromeOptions;
}

let chrome: ChromeOptions | null = null;

export async function boot(opts: BootOptions) {
  if (booted) return;
  booted = true;
  chrome = opts.chrome ?? null;
  installGlobals();
  document.body.addClass("theme-light");
  installResourceBridge();
  // First: the launch queue and install prompt must be listening before anything awaits.
  // Registration is not awaited; a returning visitor's page is already controlled.
  installPwaShell({ serviceWorkerUrl: opts.serviceWorkerUrl });
  installPopouts(Workspace);
  installResourceFallback();
  const enginePromise = initEngine(opts.wasmUrl);

  const params = new URLSearchParams(location.search);
  aliasActionParam(params);
  const vaults = await listVaults();

  // Quick capture and the share target write before the vault loads (pwa/capture-page.ts).
  if (params.has("capture") || params.has("share")) {
    const { showCapturePage } = await import("./pwa/capture-page");
    const { takeIncomingShare } = await import("./pwa/share");
    await showCapturePage({
      root: opts.root,
      params,
      vaults,
      share: await takeIncomingShare(params),
      adapterFor,
      demoAdapter: () => new MemoryAdapter("demo", "Demo vault", demoVaultFiles()),
    });
    return;
  }

  let requested = params.get("vault");
  let choose = params.has("choose");
  // An obsidian:// link naming another vault opens that vault directly instead of bouncing through the last one.
  const uri = params.get("uri");
  const parsedUri = uri ? parseObsidianUri(uri) : null;
  if (parsedUri && !requested) {
    if (parsedUri.action === "choose-vault") choose = true;
    const want = parsedUri.params.vault;
    const hit = want ? vaults.find((v) => v.id === want || v.name === want) : undefined;
    if (hit) requested = hit.id;
  }

  // Files opened from the operating system (pwa/launch.ts).
  const launchParam = params.get("launch");
  if (launchParam !== null) {
    const launched = await bootLaunchedFiles(opts.root, launchParam, vaults, enginePromise);
    if (launched === "opened") return;
    if (launched) requested = launched;
  }

  const target = choose
    ? null
    : requested === "demo"
      ? "demo"
      : (vaults.find((v) => v.id === requested) ?? (requested ? null : (vaults[0] ?? null)));

  if (target === "demo") {
    await enginePromise;
    await openVault(opts.root, new MemoryAdapter("demo", "Demo vault", demoVaultFiles()));
    return;
  }
  if (target) {
    const adapter = await adapterFor(target, false).catch(() => "needs-permission" as const);
    if (adapter !== "needs-permission") {
      await enginePromise;
      target.lastOpened = Date.now();
      await saveVault(target);
      await openVault(opts.root, adapter);
      return;
    }
  }
  await enginePromise;
  const { showStarter } = await import("./starter");
  showStarter(opts.root, {
    vaults: await listVaults(),
    supportsFolders,
    reopen: async (v) => {
      const adapter = await adapterFor(v, true);
      if (adapter === "needs-permission") throw new Error("Permission to the folder was not granted.");
      v.lastOpened = Date.now();
      await saveVault(v);
      navigateToVault(v.id);
    },
    openFolder: async () => navigateToVault((await pickFolderVault()).id),
    createBrowserVault: async (name) => navigateToVault((await createBrowserVault(name)).id),
    openDemo: () => navigateToVault("demo"),
    importFolder: async (files) => {
      const name = files[0]?.webkitRelativePath.split("/")[0] || "Imported vault";
      const record = await createBrowserVault(name);
      const adapter = (await adapterFor(record, false)) as VaultAdapter;
      for (const f of files) {
        const rel = f.webkitRelativePath.split("/").slice(1).join("/");
        if (rel) await adapter.writeBinary(rel, await f.arrayBuffer());
      }
      navigateToVault(record.id);
    },
    forget: async (id) => {
      await forgetVault(id);
    },
  });
  if (chrome) installStarterChrome(opts.root, chrome);
}

/** `?action=capture|new|daily|search` (manifest shortcuts, research §5) maps onto the routes the app has. */
function aliasActionParam(params: URLSearchParams) {
  const action = params.get("action");
  if (!action) return;
  if (action === "capture") params.set("capture", "1");
  else if (["new", "daily", "unique", "search", "open", "choose-vault"].includes(action) && !params.has("uri")) {
    const q = new URLSearchParams(params);
    for (const k of ["action", "vault", "uri", "choose"]) q.delete(k);
    const vault = params.get("vault");
    if (vault) q.set("vault", vault);
    const rest = Array.from(q, ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    params.set("uri", `obsidian://${action}${rest ? `?${rest}` : ""}`);
  }
  const url = new URL(location.href);
  url.search = params.toString();
  url.searchParams.delete("action");
  history.replaceState(history.state, "", url.toString());
}

/**
 * `?launch=file` (the manifest's file handler) or `?launch=<id>` (handles kept
 * in IndexedDB). Returns the id of the folder vault to open, "opened" when the
 * files opened in single-file mode, or null to boot normally.
 */
async function bootLaunchedFiles(root: HTMLElement, launchParam: string, vaults: VaultRecord[], enginePromise: Promise<unknown>): Promise<string | "opened" | null> {
  const launch = await import("./pwa/launch");
  // `file`: the manifest's file handler (launchQueue); `message`: handed over by another window; else an id in IndexedDB.
  const stored = !!launchParam && !["file", "message", "1"].includes(launchParam);
  const handles = stored ? await launch.recallLaunch(launchParam) : await launch.waitForLaunchFiles(launchParam === "message" ? 10_000 : 3000);
  const url = new URL(location.href);
  if (!handles?.length) {
    url.searchParams.delete("launch");
    history.replaceState(history.state, "", url.toString());
    return null;
  }
  const containing = await launch.findContainingVault(vaults, handles);
  if (containing?.granted) {
    launch.setPendingOpen(containing.vault.id, containing.paths);
    url.searchParams.delete("launch");
    url.searchParams.set("vault", containing.vault.id);
    history.replaceState(history.state, "", url.toString());
    return containing.vault.id;
  }
  // Kept so a reload of this window reopens the same files.
  const id = stored ? launchParam : await launch.rememberLaunch(handles).catch(() => `once-${Date.now().toString(36)}`);
  if (id.startsWith("once-")) url.searchParams.delete("launch");
  else url.searchParams.set("launch", id);
  url.searchParams.delete("vault");
  history.replaceState(history.state, "", url.toString());

  let files: Awaited<ReturnType<typeof launch.readLaunchedFiles>>;
  try {
    files = await launch.readLaunchedFiles(handles);
  } catch {
    // After a reload the browser wants a click before reading the file again.
    await clickToContinue(root, `Open ${handles.map((h) => h.name).join(", ")}`, async () => {
      for (const h of handles) await (h as unknown as { requestPermission(o: unknown): Promise<string> }).requestPermission({ mode: "readwrite" }).catch(() => "denied");
    });
    files = await launch.readLaunchedFiles(handles);
  }
  await enginePromise;
  const name = files.length === 1 ? files[0]!.path : `${files.length} files`;
  const adapter = new launch.LaunchedFilesAdapter(`launch-${id}`, name, files);
  await openVault(root, adapter, { singleFile: { containing: containing ? { id: containing.vault.id, name: containing.vault.name, paths: containing.paths } : null } });
  return "opened";
}

function clickToContinue(root: HTMLElement, label: string, onClick: () => Promise<void>): Promise<void> {
  root.empty();
  const wrap = root.createDiv({ cls: "vault-loading" });
  wrap.createDiv({ cls: "vault-loading-title", text: PRODUCT_NAME });
  const btn = wrap.createEl("button", { cls: "mod-cta", text: label });
  return new Promise((resolve) => {
    btn.addEventListener("click", async () => {
      await onClick();
      resolve();
    });
  });
}

export function navigateToVault(id: string) {
  const url = new URL(location.href);
  url.searchParams.set("vault", id);
  url.searchParams.delete("choose");
  location.href = url.toString();
}

interface OpenVaultExtras {
  singleFile?: { containing: { id: string; name: string; paths: string[] } | null };
}

async function openVault(root: HTMLElement, adapter: VaultAdapter, extras: OpenVaultExtras = {}) {
  root.empty();
  const loading = root.createDiv({ cls: "vault-loading" });
  loading.createDiv({ cls: "vault-loading-title", text: PRODUCT_NAME });
  const status = loading.createDiv({ cls: "vault-loading-status", text: "Starting…" });
  const app = new App(adapter, root);
  (window as unknown as { app: App }).app = app;
  // The companion extension: clips into this vault, and CORS-free requests
  // for plugin installs and `requestUrl`. Waits for layout-ready itself.
  installCompanionBridge(app);
  app.vaultSwitcher = {
    open: () => {
      const url = new URL(location.href);
      url.searchParams.delete("vault");
      url.searchParams.set("choose", "1");
      location.href = url.toString();
    },
    list: () => [],
    switchTo: navigateToVault,
  };
  const configDir = app.loadLocalStorage("config-dir");
  if (typeof configDir === "string" && configDir.startsWith(".")) app.vault.configDir = configDir;
  registerCorePlugins(app);
  // Core plugins add setting tabs while loading, so the Settings window must exist first.
  installSettings(app);
  installUriHandling(app);
  installPwaInApp(app);
  if (extras.singleFile) void import("./pwa/single-file").then((m) => m.installSingleFileMode(app, extras.singleFile!));
  try {
    await app.initialize((m) => status.setText(m));
  } catch (e) {
    console.error(e);
    status.setText(`Could not open the vault: ${(e as Error).message}`);
    return;
  }
  // The workspace exists only once initialize() has built it.
  if (chrome) installWorkspaceChrome(app, chrome);
  loading.remove();
}
