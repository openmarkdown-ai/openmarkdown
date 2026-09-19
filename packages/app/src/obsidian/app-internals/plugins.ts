/**
 * app.plugins — community plugins: discovery, loading, enabling, installing.
 *
 * Loading follows Obsidian's observable contract exactly (see
 * docs/research/plugin-compat.md §1.3): `main.js` is CommonJS, evaluated with a
 * `require` that returns the app's own module instances for `obsidian`,
 * `@codemirror/*` and `@lezer/*`, maps deprecated CodeMirror package names,
 * and returns `undefined` — never throws — for anything else, because several
 * popular plugins import `fs` or `electron` at top level behind runtime guards.
 */
import type { PluginManifest } from "obsidian";
import { Events } from "../events";
import { Notice } from "../ui/notice";
import { Plugin } from "../plugin";
import { Platform, apiVersion, normalizePath, requireApiVersion } from "../util";
import { getRequestTransport } from "../util";

type ModuleMap = Record<string, unknown>;

let sharedModules: ModuleMap | null = null;

/** Called once at startup with the app's module instances. */
export function setSharedModules(mods: ModuleMap) {
  sharedModules = mods;
}

const DEPRECATED_CM: Record<string, string> = {
  "@codemirror/closebrackets": "@codemirror/autocomplete",
  "@codemirror/comment": "@codemirror/commands",
  "@codemirror/fold": "@codemirror/language",
  "@codemirror/gutter": "@codemirror/view",
  "@codemirror/highlight": "@codemirror/language",
  "@codemirror/history": "@codemirror/commands",
  "@codemirror/matchbrackets": "@codemirror/language",
  "@codemirror/panel": "@codemirror/view",
  "@codemirror/rangeset": "@codemirror/state",
  "@codemirror/rectangular-selection": "@codemirror/view",
  "@codemirror/stream-parser": "@codemirror/language",
  "@codemirror/tooltip": "@codemirror/view",
  "@codemirror/text": "@codemirror/state",
};

export function makeRequire(pluginId: string, desktopStubs?: { pluginName: string }) {
  return function require(id: string): unknown {
    const mods = sharedModules ?? {};
    if (id in mods) return mods[id];
    const mapped = DEPRECATED_CM[id];
    if (mapped && mapped in mods) {
      console.warn(`[CM6][${pluginId}] Using a deprecated package: "${id}".`);
      return mods[mapped];
    }
    // A desktop-only plugin loaded anyway gets stand-ins that throw a clear
    // error at the moment the plugin really uses Node or Electron.
    if (desktopStubs && isNodeOrElectronModule(id)) return desktopModuleStub(desktopStubs.pluginName, id);
    // Node and Electron modules do not exist here, as on Obsidian mobile.
    return undefined;
  };
}

const NODE_MODULES = new Set(
  "assert buffer child_process cluster constants crypto dgram dns electron events fs http http2 https module net os path perf_hooks process querystring readline stream string_decoder timers tls tty url util v8 vm worker_threads zlib original-fs @electron/remote".split(" "),
);

export function isNodeOrElectronModule(id: string): boolean {
  const bare = id.replace(/^node:/, "");
  return NODE_MODULES.has(bare) || NODE_MODULES.has(bare.split("/")[0]!);
}

/**
 * A stand-in for a Node/Electron module: any property chain can be read (so
 * `const { shell } = require("electron")` at the top of a bundle still loads),
 * but calling or constructing anything throws, and says which plugin and API.
 */
export function desktopModuleStub(pluginName: string, moduleId: string): unknown {
  const reported = new Set<string>();
  const fail = (path: string): never => {
    const api = `${moduleId}${path}`;
    const message = `“${pluginName}” tried to use ${api}, which only exists in the desktop app. It was loaded anyway although it is marked desktop-only.`;
    if (!reported.has(api)) {
      reported.add(api);
      new Notice(message, 8000);
    }
    throw new Error(message);
  };
  const make = (path: string): unknown =>
    new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then" || prop === Symbol.iterator || prop === Symbol.asyncIterator) return undefined;
        if (prop === Symbol.toPrimitive) return () => `[${moduleId}${path} is not available]`;
        if (prop === "__esModule") return false;
        if (prop === "default") return make(path);
        return make(`${path}.${String(prop)}`);
      },
      apply: () => fail(path),
      construct: () => fail(path),
      set: () => fail(path),
    });
  return make("");
}

/** Removes inline source maps, which can be megabytes and slow the eval. */
export function stripSourceMap(code: string): string {
  if (code.endsWith("\n/* nosourcemap */")) return code;
  return code.replace(/\n\/\/# sourceMappingURL=data:application\/json;base64,[A-Za-z0-9+/=]+\s*$/, "") + "\n/* nosourcemap */";
}

export function evaluatePlugin(code: string, id: string, desktopStubs?: { pluginName: string }): any {
  const wrapped = `(function anonymous(require,module,exports){${code}\n})\n//# sourceURL=plugin:${encodeURIComponent(id)}\n`;
  // Indirect eval: the plugin runs in global scope and sees `app`, `moment`,
  // `createDiv` … exactly as it would in Obsidian.
  const fn = (0, eval)(wrapped) as (req: unknown, module: { exports: any }, exports: any) => void;
  const module = { exports: {} as any };
  fn(makeRequire(id, desktopStubs), module, module.exports);
  return module.exports;
}

export interface CommunityPluginListing {
  id: string;
  name: string;
  author: string;
  description: string;
  repo: string;
}

export class Plugins extends Events {
  manifests: Record<string, PluginManifest> = {};
  plugins: Record<string, Plugin> = {};
  enabledPlugins = new Set<string>();
  loadingPluginId: string | null = null;
  updates: Record<string, { version: string; repo: string; manifest: PluginManifest }> = {};
  // internal: set in restricted mode
  private restricted = true;

  constructor(private app: any) {
    super();
  }

  getPluginFolder(): string {
    return `${this.app.vault.configDir}/plugins`;
  }

  getPlugin(id: string): Plugin | null {
    return this.plugins[id] ?? null;
  }

  // internal: "Restricted mode" off means community plugins may run
  isEnabled(): boolean {
    return !this.restricted;
  }

  async setEnable(enabled: boolean) {
    this.restricted = !enabled;
    this.app.saveLocalStorage("enable-plugin", enabled ? "true" : null);
    if (enabled) await this.loadEnabledPlugins();
    else for (const id of Object.keys(this.plugins)) await this.unloadPlugin(id);
    this.trigger("restricted-change", !enabled);
  }

  // internal: desktop-only plugins the user chose to "Try to load anyway" on
  // this device (localStorage, per vault). Never set automatically.
  desktopOnlyOverrides = new Set<string>();

  // internal
  isDesktopOnlyBlocked(manifest: PluginManifest): boolean {
    return !!manifest.isDesktopOnly && !Platform.isDesktopApp;
  }

  // internal
  hasDesktopOnlyOverride(id: string): boolean {
    return this.desktopOnlyOverrides.has(id);
  }

  // internal: turning the override off also unloads the plugin
  async setDesktopOnlyOverride(id: string, on: boolean): Promise<void> {
    if (on) this.desktopOnlyOverrides.add(id);
    else {
      this.desktopOnlyOverrides.delete(id);
      const manifest = this.manifests[id];
      if (manifest && this.isDesktopOnlyBlocked(manifest)) await this.unloadPlugin(id);
    }
    this.app.saveLocalStorage("desktop-only-load-anyway", this.desktopOnlyOverrides.size ? Array.from(this.desktopOnlyOverrides) : null);
    this.trigger("desktop-only-override", id, on);
  }

  async initialize() {
    const overrides = this.app.loadLocalStorage("desktop-only-load-anyway");
    this.desktopOnlyOverrides = new Set(Array.isArray(overrides) ? overrides.filter((x: unknown) => typeof x === "string") : []);
    this.restricted = this.app.loadLocalStorage("enable-plugin") !== "true";
    await this.loadManifests();
    const enabled = await this.app.vault.readConfigJson("community-plugins.json");
    this.enabledPlugins = new Set(Array.isArray(enabled) ? enabled : []);
  }

  async loadManifests() {
    const adapter = this.app.vault.adapter;
    const folder = this.getPluginFolder();
    this.manifests = {};
    if (!(await adapter.exists(folder))) return;
    const { folders } = await adapter.list(folder);
    for (const dir of folders) await this.loadManifest(dir);
  }

  async loadManifest(dir: string): Promise<PluginManifest | null> {
    try {
      const manifest = JSON.parse(await this.app.vault.adapter.read(normalizePath(`${dir}/manifest.json`))) as PluginManifest;
      if (!manifest.id) return null;
      manifest.dir = normalizePath(dir);
      if (String(manifest.author ?? "").toLowerCase() === "obsidian") manifest.author = "";
      this.manifests[manifest.id] = manifest;
      return manifest;
    } catch {
      return null;
    }
  }

  async loadEnabledPlugins() {
    if (this.restricted) return;
    for (const id of this.enabledPlugins) {
      if (!this.plugins[id]) await this.loadPlugin(id).catch((e) => console.error(e));
    }
  }

  // internal
  canRun(manifest: PluginManifest): string | null {
    if (this.isDesktopOnlyBlocked(manifest) && !this.desktopOnlyOverrides.has(manifest.id)) return `“${manifest.name}” only works in the desktop app.`;
    if (manifest.minAppVersion && !requireApiVersion(manifest.minAppVersion)) {
      return `“${manifest.name}” needs app version ${manifest.minAppVersion} or newer; this is ${apiVersion}.`;
    }
    return null;
  }

  async loadPlugin(id: string): Promise<Plugin | null> {
    const manifest = this.manifests[id];
    if (!manifest) return null;
    const refusal = this.canRun(manifest);
    if (refusal) {
      new Notice(refusal);
      return null;
    }
    if (this.plugins[id]) return this.plugins[id]!;
    this.loadingPluginId = id;
    try {
      const code = await this.app.vault.adapter.read(normalizePath(`${manifest.dir}/main.js`));
      const loadAnyway = this.isDesktopOnlyBlocked(manifest) && this.desktopOnlyOverrides.has(id);
      if (loadAnyway) console.warn(`[${id}] Marked desktop-only; loading anyway because the user asked to. Node and Electron modules throw when used.`);
      const exports = evaluatePlugin(stripSourceMap(code), id, loadAnyway ? { pluginName: manifest.name } : undefined);
      const PluginClass = exports?.default ?? exports;
      if (typeof PluginClass !== "function") throw new Error("No exports detected");
      const plugin = new PluginClass(this.app, manifest);
      if (!(plugin instanceof Plugin)) throw new Error("Failed to load plugin: the default export is not a Plugin");
      this.plugins[id] = plugin;
      await plugin.load();
      await plugin.loadCSS();
      this.trigger("plugin-loaded", id);
      return plugin;
    } catch (e) {
      console.error(`Plugin failure: ${id}`, e);
      new Notice(`Failed to load plugin “${manifest.name}”. ${(e as Error).message ?? ""}`);
      delete this.plugins[id];
      return null;
    } finally {
      this.loadingPluginId = null;
    }
  }

  async unloadPlugin(id: string) {
    const plugin = this.plugins[id];
    if (!plugin) return;
    try {
      plugin.unload();
    } catch (e) {
      console.error(e);
    }
    delete this.plugins[id];
    this.trigger("plugin-unloaded", id);
  }

  async enablePlugin(id: string): Promise<boolean> {
    const plugin = await this.loadPlugin(id);
    return !!plugin;
  }

  async disablePlugin(id: string) {
    await this.unloadPlugin(id);
  }

  async enablePluginAndSave(id: string): Promise<boolean> {
    if (this.restricted) return false;
    this.enabledPlugins.add(id);
    await this.saveConfig();
    const ok = await this.enablePlugin(id);
    if (ok) this.plugins[id]?.onUserEnable();
    return ok;
  }

  async disablePluginAndSave(id: string) {
    this.enabledPlugins.delete(id);
    await this.saveConfig();
    await this.disablePlugin(id);
  }

  async saveConfig() {
    await this.app.vault.writeConfigJson("community-plugins.json", Array.from(this.enabledPlugins));
  }

  requestSaveConfig() {
    void this.saveConfig();
  }

  async uninstallPlugin(id: string) {
    await this.disablePluginAndSave(id);
    const manifest = this.manifests[id];
    if (manifest?.dir) await this.app.vault.adapter.rmdir(manifest.dir, true).catch(() => {});
    delete this.manifests[id];
    this.trigger("plugin-uninstalled", id);
  }

  // ---- store --------------------------------------------------------------------

  /** Install from files the user already has (a dropped folder or zip, or another vault). */
  async installFromFiles(files: { name: string; data: string }[]): Promise<PluginManifest> {
    const manifestFile = files.find((f) => f.name === "manifest.json");
    if (!manifestFile) throw new Error("manifest.json is missing");
    const manifest = JSON.parse(manifestFile.data) as PluginManifest;
    const dir = `${this.getPluginFolder()}/${manifest.id}`;
    await this.app.vault.adapter.mkdir(dir);
    for (const f of files) {
      if (!["manifest.json", "main.js", "styles.css", "data.json"].includes(f.name)) continue;
      await this.app.vault.adapter.write(`${dir}/${f.name}`, f.name === "main.js" ? stripSourceMap(f.data) : f.data);
    }
    const loaded = await this.loadManifest(dir);
    if (this.plugins[manifest.id]) {
      await this.unloadPlugin(manifest.id);
      await this.loadPlugin(manifest.id);
    }
    return loaded ?? manifest;
  }

  async installPlugin(repo: string, version: string, manifest: PluginManifest): Promise<void> {
    const get = (file: string) => fetchReleaseAsset(this.app, repo, version, file);
    const releaseManifest = JSON.parse(await get("manifest.json")) as PluginManifest;
    if (releaseManifest.id !== manifest.id) throw new Error("Plugin ID mismatch");
    const files: { name: string; data: string }[] = [{ name: "manifest.json", data: JSON.stringify(releaseManifest, null, 2) }];
    files.push({ name: "main.js", data: await get("main.js") });
    try {
      files.push({ name: "styles.css", data: await get("styles.css") });
    } catch {
      /* styles.css is optional */
    }
    await this.installFromFiles(files);
    delete this.updates[manifest.id];
    this.trigger("plugin-installed", manifest.id);
  }

  async checkForUpdates(): Promise<void> {
    const list = await fetchCommunityPlugins();
    const byId = new Map(list.map((p) => [p.id, p]));
    for (const [id, manifest] of Object.entries(this.manifests)) {
      const listing = byId.get(id);
      if (!listing) continue;
      try {
        const remote = await resolveInstallable(listing.repo);
        if (remote && remote.manifest.id === id && compareVersions(remote.version, manifest.version) > 0) {
          this.updates[id] = { version: remote.version, repo: listing.repo, manifest: remote.manifest };
        }
      } catch {
        /* offline or rate limited */
      }
    }
    this.trigger("updates-checked");
  }
}

// ---- store network ------------------------------------------------------------------

const RAW = "https://raw.githubusercontent.com";
const RELEASES = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master";
const cache = new Map<string, { at: number; value: unknown }>();

async function cachedJson<T>(url: string, ttlMs = 5 * 60_000): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const value = (await res.json()) as T;
  cache.set(url, { at: Date.now(), value });
  return value;
}

export function fetchCommunityPlugins(): Promise<CommunityPluginListing[]> {
  return cachedJson(`${RELEASES}/community-plugins.json`);
}

export function fetchPluginStats(): Promise<Record<string, { downloads: number; updated: number }>> {
  return cachedJson(`${RELEASES}/community-plugin-stats.json`);
}

export function fetchCommunityThemes(): Promise<{ name: string; author: string; repo: string; screenshot: string; modes: string[]; legacy?: boolean }[]> {
  return cachedJson(`${RELEASES}/community-css-themes.json`);
}

export async function fetchRaw(repo: string, file: string): Promise<string> {
  const res = await fetch(`${RAW}/${repo}/HEAD/${file}`);
  if (!res.ok) throw new Error(`${res.status} ${file}`);
  return res.text();
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The version Obsidian would install: the default branch's manifest, or the newest compatible entry of versions.json. */
export async function resolveInstallable(repo: string): Promise<{ version: string; manifest: PluginManifest } | null> {
  const manifest = JSON.parse(await fetchRaw(repo, "manifest.json")) as PluginManifest;
  if (!manifest.minAppVersion || requireApiVersion(manifest.minAppVersion)) return { version: manifest.version, manifest };
  try {
    const versions = JSON.parse(await fetchRaw(repo, "versions.json")) as Record<string, string>;
    const ok = Object.entries(versions)
      .filter(([, min]) => requireApiVersion(min))
      .map(([v]) => v)
      .sort(compareVersions);
    const best = ok.pop();
    return best ? { version: best, manifest } : null;
  } catch {
    return null;
  }
}

/**
 * GitHub release assets carry no CORS header, so a web page cannot download
 * them directly. In order: the companion extension (no CORS), a proxy the user
 * configured, then a direct fetch (which works only for CORS-enabled mirrors).
 */
export async function fetchReleaseAsset(app: any, repo: string, version: string, file: string): Promise<string> {
  const url = `https://github.com/${repo}/releases/download/${version}/${file}`;
  const transport = getRequestTransport();
  if (transport) {
    const res = await transport.request({ url, method: "GET" });
    if (res.status === 200) return new TextDecoder().decode(res.body);
    if (res.status === 404) throw new Error(`${file} not found in release ${version}`);
  }
  const proxy = String(app.loadLocalStorage("plugin-proxy-url") ?? "").replace(/\/$/, "");
  if (proxy) {
    const res = await fetch(`${proxy}/gh/${repo}/${version}/${file}`);
    if (res.ok) return res.text();
    if (res.status === 404) throw new Error(`${file} not found in release ${version}`);
  }
  try {
    const res = await fetch(url);
    if (res.ok) return res.text();
    throw new Error(`${res.status}`);
  } catch {
    throw new Error(
      "This browser cannot download plugin files from GitHub directly. Install the companion browser extension, set a plugin download proxy in Settings → Community plugins, or drop the plugin's files onto this window.",
    );
  }
}
