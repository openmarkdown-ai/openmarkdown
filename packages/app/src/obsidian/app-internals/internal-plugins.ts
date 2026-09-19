/**
 * app.internalPlugins — the core plugins (File explorer, Search, Graph …) and
 * OpenMarkdown's pre-installed plugins.
 *
 * Two kinds of definition live here:
 *
 * - **Core plugins** are Obsidian's own (§3.0 of the research doc). They are
 *   toggled in Settings → Core plugins and their state is `core-plugins.json`.
 * - **Pre-installed plugins** (`definition.preinstalled`) are features
 *   OpenMarkdown adds. They ship with the app and are installed in every vault,
 *   but the user can uninstall and reinstall them in Settings → Community
 *   plugins. Their state is `openmarkdown-plugins.json`
 *   (`{ "uninstalled": [...], "enabled": {...} }`), never `core-plugins.json`,
 *   so a vault opened in Obsidian sees a clean core plugin config. While
 *   uninstalled a definition is kept in `removed` (not `plugins`), so
 *   `getPluginById` returns null and everything it registered is gone.
 *
 * Each core plugin is a `CorePluginDefinition` whose implementation is an
 * ordinary `Plugin` subclass. Community plugins reach core plugin settings
 * through `getPluginById("daily-notes").instance.options`, so every core
 * plugin exposes an `instance` with `options` persisted to
 * `.obsidian/<id>.json`, as in Obsidian.
 */
import type { PluginManifest } from "obsidian";
import { Events } from "../events";
import type { Plugin } from "../plugin";
import { APP_VERSION, PRODUCT_NAME } from "../../product";

/** Per-vault state of the pre-installed plugins. */
export const PREINSTALLED_STATE_FILE = "openmarkdown-plugins.json";

/** What makes a definition a pre-installed plugin rather than a core plugin. */
export interface PreinstalledInfo {
  /** Shown as the plugin's author; always the product. */
  author?: string;
  /** The app version the plugin shipped with. */
  version?: string;
  /** Community plugin ids this plugin steps aside for while they are enabled. */
  replaces?: string[];
  /**
   * What uninstalling removes besides `.obsidian/<id>.json`, in words for the
   * confirmation ("the Related notes index kept in this browser").
   */
  removes?: string[];
  /** Clean-up after the plugin is unloaded and its settings file deleted. Must not throw. */
  onUninstall?(app: any): Promise<void> | void;
  /**
   * A destructive step that needs its own confirmation (Sync: forget this
   * device's keys). `needed` says whether it applies to this vault; `run` only
   * happens when the caller passes `{ disconnect: true }`.
   */
  disconnect?: {
    needed(app: any): Promise<boolean>;
    title: string;
    message: string;
    cta: string;
    run(app: any): Promise<void>;
  };
}

export interface CorePluginDefinition {
  id: string;
  name: string;
  description: string;
  icon?: string;
  defaultOn: boolean;
  /** Always-on app features packaged as core plugins; not listed in Settings → Core plugins. */
  hidden?: boolean;
  /** Set for OpenMarkdown's own features: uninstallable, listed under Community plugins. */
  preinstalled?: PreinstalledInfo;
  /** Settings stored in `.obsidian/<id>.json` */
  defaultOptions?: Record<string, unknown>;
  create(app: any, wrapper: InternalPluginWrapper): Plugin;
}

export class InternalPluginInstance {
  id: string;
  name: string;
  description: string;
  options: Record<string, any>;
  plugin: Plugin | null = null;
  constructor(def: CorePluginDefinition, private app: any) {
    this.id = def.id;
    this.name = def.name;
    this.description = def.description;
    this.options = { ...(def.defaultOptions ?? {}) };
  }
  async loadOptions() {
    const data = await this.app.vault.readConfigJson(`${this.id}.json`);
    if (data && typeof data === "object") Object.assign(this.options, data);
  }
  /**
   * Settings writes never reject: callers fire them from input handlers and timers
   * (`void saveOptions()`), and a full disk would otherwise surface as an uncaught
   * error on every keystroke. The options stay in memory and are written next time.
   */
  async saveOptions() {
    try {
      await this.app.vault.writeConfigJson(`${this.id}.json`, this.options);
    } catch (e) {
      console.error(`Could not save settings for ${this.id}`, e);
    }
  }
}

export class InternalPluginWrapper extends Events {
  instance: InternalPluginInstance;
  enabled = false;
  _loaded = false;
  // internal (used by plugins: Excalidraw builds a detached canvas through
  // `internalPlugins.plugins.canvas.views.canvas(leaf)`) — view type → creator
  views: Record<string, (leaf: any) => any> = {};
  constructor(
    public app: any,
    public definition: CorePluginDefinition,
  ) {
    super();
    this.instance = new InternalPluginInstance(definition, app);
  }

  get manifest(): PluginManifest {
    const pre = this.definition.preinstalled;
    return {
      id: this.definition.id,
      name: this.definition.name,
      description: this.definition.description,
      author: pre ? (pre.author ?? PRODUCT_NAME) : "",
      version: pre ? (pre.version ?? APP_VERSION) : "",
      minAppVersion: "",
    };
  }

  async enable(_userAction = false): Promise<void> {
    if (this.enabled) return;
    // An uninstalled pre-installed plugin cannot be turned on through a stale reference.
    if (this.definition.preinstalled && this.app.internalPlugins?.isUninstalled?.(this.definition.id)) return;
    this.enabled = true;
    await this.instance.loadOptions();
    const plugin = this.definition.create(this.app, this);
    (plugin as unknown as { isCorePlugin: boolean }).isCorePlugin = true;
    this.instance.plugin = plugin;
    // Core plugins publish their public methods onto `instance` in onload(),
    // the way plugins reach e.g. `getPluginById("bookmarks").instance.addItem(…)`.
    (plugin as unknown as { instance: InternalPluginInstance }).instance = this.instance;
    const registerView = plugin.registerView.bind(plugin);
    plugin.registerView = (type, creator) => {
      this.views[type] = creator;
      registerView(type, creator);
    };
    await plugin.load();
    this._loaded = true;
    this.trigger("enabled");
  }

  // internal (used by plugins: `plugin._loaded || await plugin.load()`)
  async load(): Promise<void> {
    await this.enable();
  }

  async disable(_userAction = false): Promise<void> {
    if (!this.enabled) return;
    this.enabled = false;
    this.instance.plugin?.unload();
    this.instance.plugin = null;
    this.views = {};
    this._loaded = false;
    this.trigger("disabled");
  }
}

export class InternalPlugins extends Events {
  plugins: Record<string, InternalPluginWrapper> = {};
  /** Obsidian's core plugin config (`core-plugins.json`); pre-installed ids are never in it. */
  config: Record<string, boolean> = {};
  // internal: uninstalled pre-installed plugins, kept so they can be reinstalled offline
  removed: Record<string, InternalPluginWrapper> = {};
  // internal: `openmarkdown-plugins.json`
  preinstalledState: { uninstalled: string[]; enabled: Record<string, boolean> } = { uninstalled: [], enabled: {} };

  constructor(private app: any) {
    super();
  }

  register(def: CorePluginDefinition) {
    this.plugins[def.id] = new InternalPluginWrapper(this.app, def);
  }

  // ---- classification -------------------------------------------------------------

  /** internal: the definition of a registered plugin, installed or not. */
  getDefinition(id: string): CorePluginDefinition | null {
    return (this.plugins[id] ?? this.removed[id])?.definition ?? null;
  }

  /** internal: whether `id` is one of OpenMarkdown's pre-installed plugins (installed or not). */
  isPreinstalled(id: string): boolean {
    return !!this.getDefinition(id)?.preinstalled;
  }

  /** internal */
  isUninstalled(id: string): boolean {
    return !!this.removed[id];
  }

  /** internal: every pre-installed definition, installed first then removed, by name. */
  getPreinstalledDefinitions(): CorePluginDefinition[] {
    return [...Object.values(this.plugins), ...Object.values(this.removed)]
      .map((w) => w.definition)
      .filter((d) => d.preinstalled)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- startup --------------------------------------------------------------------

  async enable() {
    const saved = await this.app.vault.readConfigJson("core-plugins.json");
    const savedCore: Record<string, boolean> = {};
    if (Array.isArray(saved)) for (const id of saved) savedCore[id] = true;
    else if (saved && typeof saved === "object") Object.assign(savedCore, saved);

    // Pre-installed state; the first time, carry over what core-plugins.json said.
    const rawState = await this.app.vault.readConfigJson(PREINSTALLED_STATE_FILE);
    const state = { uninstalled: [] as string[], enabled: {} as Record<string, boolean> };
    if (rawState && typeof rawState === "object") {
      if (Array.isArray(rawState.uninstalled)) state.uninstalled = rawState.uninstalled.filter((x: unknown) => typeof x === "string");
      if (rawState.enabled && typeof rawState.enabled === "object") {
        for (const [k, v] of Object.entries(rawState.enabled)) if (typeof v === "boolean") state.enabled[k] = v;
      }
    }
    let stateDirty = false;
    let coreDirty = false;
    for (const [id, wrapper] of Object.entries(this.plugins)) {
      const def = wrapper.definition;
      if (!(id in savedCore)) continue;
      if (def.preinstalled) {
        if (!rawState && typeof savedCore[id] === "boolean") {
          state.enabled[id] = savedCore[id]!;
          stateDirty = true;
        }
        delete savedCore[id];
        coreDirty = true;
      } else if (def.hidden) {
        // App internals were written here by earlier builds; Obsidian has no such plugins.
        delete savedCore[id];
        coreDirty = true;
      }
    }
    this.preinstalledState = state;
    for (const id of state.uninstalled) {
      const wrapper = this.plugins[id];
      if (!wrapper?.definition.preinstalled) continue;
      delete this.plugins[id];
      this.removed[id] = wrapper;
    }

    const config: Record<string, boolean> = { ...savedCore };
    for (const [id, wrapper] of Object.entries(this.plugins)) {
      const def = wrapper.definition;
      if (def.preinstalled || def.hidden) continue;
      if (!(id in config)) config[id] = def.defaultOn;
    }
    this.config = config;
    if (stateDirty) await this.savePreinstalledState().catch(() => {});
    if (coreDirty) await this.saveConfig().catch(() => {});

    for (const [id, wrapper] of Object.entries(this.plugins)) {
      if (this.shouldBeEnabled(id)) await wrapper.enable().catch((e) => console.error(`Core plugin ${id} failed`, e));
    }
  }

  private shouldBeEnabled(id: string): boolean {
    const def = this.plugins[id]?.definition;
    if (!def) return false;
    if (def.hidden) return true;
    if (def.preinstalled) return this.preinstalledState.enabled[id] ?? def.defaultOn;
    return !!this.config[id];
  }

  // ---- lookups ----------------------------------------------------------------------

  getPluginById(id: string): InternalPluginWrapper | null {
    return this.plugins[id] ?? null;
  }

  getEnabledPluginById(id: string): InternalPluginInstance | null {
    const p = this.plugins[id];
    return p?.enabled ? p.instance : null;
  }

  getEnabledPlugins(): InternalPluginInstance[] {
    return Object.values(this.plugins)
      .filter((p) => p.enabled)
      .map((p) => p.instance);
  }

  // ---- enabling -----------------------------------------------------------------------

  async setEnabled(id: string, enabled: boolean) {
    const p = this.plugins[id];
    if (!p) return;
    if (enabled) await p.enable(true);
    else await p.disable(true);
    if (p.definition.preinstalled) {
      this.preinstalledState.enabled[id] = enabled;
      await this.savePreinstalledState();
    } else {
      this.config[id] = enabled;
      await this.saveConfig();
    }
    this.trigger("plugin-state-change", id);
  }

  async saveConfig() {
    const out: Record<string, boolean> = {};
    for (const [id, on] of Object.entries(this.config)) {
      const def = this.getDefinition(id);
      if (def?.preinstalled || def?.hidden) continue;
      out[id] = on;
    }
    await this.app.vault.writeConfigJson("core-plugins.json", out);
  }

  requestSaveConfig() {
    void this.saveConfig();
  }

  // internal
  async savePreinstalledState() {
    const s = this.preinstalledState;
    await this.app.vault.writeConfigJson(PREINSTALLED_STATE_FILE, { uninstalled: [...s.uninstalled].sort(), enabled: s.enabled });
  }

  // ---- install / uninstall (pre-installed plugins) ----------------------------------------

  /**
   * internal: uninstalls a pre-installed plugin. Unloads it (commands, views,
   * ribbon icons, status bar items, setting tabs), closes its views, deletes
   * `.obsidian/<id>.json`, runs its clean-up, and records it as uninstalled.
   * `disconnect: true` also runs its confirmed destructive step (Sync keys).
   */
  async uninstall(id: string, opts: { disconnect?: boolean } = {}): Promise<boolean> {
    const wrapper = this.plugins[id];
    const pre = wrapper?.definition.preinstalled;
    if (!wrapper || !pre) return false;
    const viewTypes = Object.keys(wrapper.views);
    for (const type of viewTypes) {
      try {
        this.app.workspace?.detachLeavesOfType?.(type);
      } catch (e) {
        console.error(e);
      }
    }
    try {
      await wrapper.disable(true);
    } catch (e) {
      console.error(`Could not unload ${id}`, e);
    }
    delete this.plugins[id];
    this.removed[id] = wrapper;
    const s = this.preinstalledState;
    if (!s.uninstalled.includes(id)) s.uninstalled.push(id);
    delete s.enabled[id];
    delete this.config[id];
    await this.savePreinstalledState().catch((e) => console.error(e));

    const vault = this.app.vault;
    const optionsPath = `${vault.configDir}/${id}.json`;
    try {
      if (await vault.adapter.exists(optionsPath)) await vault.adapter.remove(optionsPath);
    } catch (e) {
      console.error(`Could not delete ${optionsPath}`, e);
    }
    try {
      if (opts.disconnect && pre.disconnect && (await pre.disconnect.needed(this.app))) await pre.disconnect.run(this.app);
    } catch (e) {
      console.error(`Could not disconnect ${id}`, e);
    }
    try {
      await pre.onUninstall?.(this.app);
    } catch (e) {
      console.error(`Clean-up of ${id} failed`, e);
    }
    this.trigger("plugin-uninstalled", id);
    this.trigger("plugin-state-change", id);
    return true;
  }

  /** internal: puts an uninstalled pre-installed plugin back, with default settings. No download. */
  async reinstall(id: string): Promise<boolean> {
    const old = this.removed[id];
    if (!old) return false;
    delete this.removed[id];
    const wrapper = new InternalPluginWrapper(this.app, old.definition);
    this.plugins[id] = wrapper;
    const s = this.preinstalledState;
    s.uninstalled = s.uninstalled.filter((x) => x !== id);
    delete s.enabled[id];
    await this.savePreinstalledState().catch((e) => console.error(e));
    if (wrapper.definition.defaultOn) await wrapper.enable(true).catch((e) => console.error(`Core plugin ${id} failed`, e));
    this.trigger("plugin-installed", id);
    this.trigger("plugin-state-change", id);
    return true;
  }
}
