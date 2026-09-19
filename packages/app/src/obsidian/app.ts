/**
 * App — the root object handed to every plugin, and the startup sequence.
 *
 * Startup order is what plugins observe, so it follows Obsidian's:
 * vault tree → config → core plugins → community plugins (each `onload`) →
 * workspace layout restored → metadata cache indexing → `onLayoutReady`
 * callbacks. A plugin that registers a view in `onload` must find the view
 * type known before the saved layout tries to reopen it.
 */
import { Events } from "./events";
import { Commands, HotkeyManager } from "./app-internals/commands";
import { CustomCSS } from "./app-internals/custom-css";
import { InternalPlugins } from "./app-internals/internal-plugins";
import { CliRegistry, DragManager, FoldManager, MetadataTypeManager, StatusBar } from "./app-internals/misc";
import { SecretStorage } from "./app-internals/public-classes";
import { Plugins } from "./app-internals/plugins";
import { EmbedRegistry, ViewRegistry } from "./app-internals/view-registry";
import { Keymap, Scope } from "./ui/keymap";
import type { VaultAdapter } from "./vault/adapter";
import { FileManager } from "./vault/file-manager";
import { MetadataCache } from "./vault/metadata-cache";
import { registerResourceReader } from "./vault/resource";
import { Vault } from "./vault/vault";
import { installDataSafety } from "./vault/safety";
import { Workspace } from "./workspace/workspace";
import { installMobileLayout, type MobileLayout } from "./workspace/mobile/index";

export class App {
  keymap: Keymap;
  scope: Scope;
  workspace!: Workspace;
  vault: Vault;
  metadataCache!: MetadataCache;
  fileManager: FileManager;
  lastEvent: UIEvent | null = null;
  renderContext = { hoverPopover: null };
  secretStorage: SecretStorage;

  // ---- internals plugins use (docs/research/plugin-compat.md §4) -------------
  appId: string;
  title = "";
  plugins: Plugins;
  internalPlugins: InternalPlugins;
  commands: Commands;
  hotkeyManager: HotkeyManager;
  viewRegistry = new ViewRegistry();
  embedRegistry = new EmbedRegistry();
  customCss: CustomCSS;
  metadataTypeManager: MetadataTypeManager;
  statusBar = new StatusBar();
  dragManager: DragManager;
  foldManager: FoldManager;
  cli = new CliRegistry();
  // Replaced by the Settings window (settings/app-setting.ts) at boot; this
  // stand-in keeps `addSettingTab` working if that has not happened yet.
  setting: any = {
    pluginTabs: [] as unknown[],
    settingTabs: [] as unknown[],
    addSettingTab(tab: unknown) {
      this.pluginTabs.push(tab);
    },
    removeSettingTab(tab: unknown) {
      this.pluginTabs.remove(tab);
    },
    open() {},
    close() {},
    openTabById() {},
  };
  basesRegistry: any = null;
  isMobile = false;
  // internal: the phone/tablet layout controller (workspace/mobile)
  mobile: MobileLayout | null = null;
  // internal (used by plugins: null on desktop)
  mobileNavbar: unknown = null;
  mobileToolbar: unknown = null;
  mobileTabSwitcher: unknown = null;
  dom: { appContainerEl: HTMLElement; horizontalMainContainerEl: HTMLElement; workspaceEl: HTMLElement; statusBarEl: HTMLElement };
  // internal: events not tied to a specific object
  events = new Events();
  // internal: data safety — `hasUnsaved()`, `flushSaves()` (vault/safety.ts; used by pwa/sw-client.ts)
  saveStatus: any = null;
  // internal: vault switching lives outside the app
  vaultSwitcher: { open(): void; list(): { id: string; name: string }[]; switchTo(id: string): void } | null = null;

  constructor(adapter: VaultAdapter, rootEl: HTMLElement) {
    this.appId = adapter.vaultId;
    this.vault = new Vault(adapter);
    this.scope = new Scope();
    this.keymap = new Keymap(this.scope);
    this.fileManager = new FileManager(this);
    this.secretStorage = new SecretStorage(this);
    this.plugins = new Plugins(this);
    this.internalPlugins = new InternalPlugins(this);
    this.commands = new Commands(this);
    this.hotkeyManager = new HotkeyManager(this);
    this.customCss = new CustomCSS(this);
    this.metadataTypeManager = new MetadataTypeManager(this);
    this.dragManager = new DragManager(this);
    this.foldManager = new FoldManager(this);

    const appContainerEl = rootEl.createDiv({ cls: "app-container" });
    const horizontalMainContainerEl = appContainerEl.createDiv({ cls: "horizontal-main-container" });
    this.dom = { appContainerEl, horizontalMainContainerEl, workspaceEl: horizontalMainContainerEl, statusBarEl: this.statusBar.containerEl };
    registerResourceReader(adapter.vaultId, (path) => adapter.readBinary(path));
  }

  // internal (used by plugins: switches the phone layout on or off for testing)
  emulateMobile(emulate: boolean): void {
    this.mobile?.emulate(emulate);
  }

  isDarkMode(): boolean {
    return document.body.hasClass("theme-dark");
  }

  loadLocalStorage(key: string): any | null {
    try {
      const raw = localStorage.getItem(`${this.appId}-${key}`);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }

  saveLocalStorage(key: string, data: unknown | null): void {
    try {
      if (data === null || data === undefined) localStorage.removeItem(`${this.appId}-${key}`);
      else localStorage.setItem(`${this.appId}-${key}`, JSON.stringify(data));
    } catch {
      /* storage can be unavailable in private windows */
    }
  }

  // internal
  getTheme() {
    return this.customCss.getTheme();
  }
  // internal
  changeTheme(mode: "obsidian" | "moonstone" | "system") {
    this.customCss.setTheme(mode);
  }
  // internal
  // internal (used by plugins: Excalidraw derives its UI palette from it, so
  // it must always be a parseable colour — the default accent when unset)
  getAccentColor(): string {
    const custom = String(this.vault.getConfig("accentColor") ?? "");
    if (custom) return custom;
    const cs = getComputedStyle(document.body);
    const h = parseFloat(cs.getPropertyValue("--accent-h"));
    const s = parseFloat(cs.getPropertyValue("--accent-s"));
    const l = parseFloat(cs.getPropertyValue("--accent-l"));
    if ([h, s, l].some((n) => Number.isNaN(n))) return "#8a5cf5";
    // hsl → #rrggbb
    const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, "0");
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }
  // internal
  setAccentColor(hex: string) {
    this.customCss.setAccentColor(hex);
  }
  // internal
  isVimEnabled(): boolean {
    return !!this.vault.getConfig("vimMode");
  }
  // internal
  getAppTitle(fileTitle?: string): string {
    return fileTitle ? `${fileTitle} - ${this.vault.getName()}` : this.vault.getName();
  }
  // internal (used by plugins: open settings buttons)
  openWithDefaultApp(path: string) {
    const file = this.vault.getFileByPath(path);
    if (file) window.open(this.vault.getResourcePath(file), "_blank", "noopener");
  }
  // internal
  showInFolder(path: string) {
    const file = this.vault.getAbstractFileByPath(path);
    if (file) (this.internalPlugins.getEnabledPluginById("file-explorer") as { revealInFolder?: (f: unknown) => void } | null)?.revealInFolder?.(file);
  }
  // internal
  async saveAttachment(name: string, extension: string, data: ArrayBuffer): Promise<any> {
    const active = this.workspace.getActiveFile();
    const path = await this.fileManager.getAvailablePathForAttachment(`${name}.${extension}`, active?.path ?? "");
    return this.vault.createBinary(path, data);
  }

  /** Mount the UI and run the startup sequence. */
  // internal
  async initialize(onProgress?: (msg: string) => void): Promise<void> {
    const report = (m: string) => onProgress?.(m);
    report("Reading vault…");
    await this.vault.loadConfig();
    this.metadataCache = new MetadataCache(this.vault);
    this.workspace = new Workspace(this);
    installDataSafety(this); // save status, journal, tabs, flush on leave (vault/safety.ts)
    this.dom.horizontalMainContainerEl.appendChild(this.workspace.containerEl);
    this.dom.appContainerEl.appendChild(this.statusBar.containerEl);
    // Before plugins load, so `Platform.isMobile` and `app.isMobile` are final when they read them.
    this.mobile = installMobileLayout(this);
    document.body.toggleClass("show-inline-title", !!this.vault.getConfig("showInlineTitle"));
    document.body.toggleClass("show-view-header", this.vault.getConfig("showViewHeader") !== false);
    document.body.toggleClass("show-ribbon", this.vault.getConfig("showRibbon") !== false);
    this.vault.on("config-changed", (key: string) => this.onConfigChanged(key));

    await this.customCss.load();
    await this.hotkeyManager.load();
    await this.metadataTypeManager.load();

    // The tree raises `create` for every file, which queues each note for parsing.
    await this.vault.load();
    this.metadataCache.finishStartupIfIdle();
    this.metadataCache.on("resolved", () => this.metadataTypeManager.updatePropertyInfoCache());

    report("Loading core plugins…");
    await this.internalPlugins.enable();

    report("Loading community plugins…");
    await this.plugins.initialize();
    await this.plugins.loadEnabledPlugins();

    report("Restoring layout…");
    const layout = await this.workspace.readSavedLayout();
    this.workspace.ribbonConfig = layout?.["left-ribbon"] ?? {};
    await this.workspace.changeLayout(layout ?? defaultLayout());
    this.workspace.leftSplit.containerEl.toggleClass("is-sidedock-collapsed", this.workspace.leftSplit.collapsed);
    this.workspace.onSidedockToggled(this.workspace.leftSplit);
    this.workspace.onSidedockToggled(this.workspace.rightSplit);

    document.addEventListener("keydown", (evt) => this.onKeyDown(evt), true);
    window.addEventListener("focus", () => void this.vault.sync().catch(() => {}));
    setInterval(() => {
      if (document.visibilityState === "visible") void this.vault.sync().catch(() => {});
    }, 15000);
    this.watchPluginData();

    this.workspace.setLayoutReady();
    this.updateTitle();
    this.workspace.on("file-open", () => this.updateTitle());
    this.workspace.on("active-leaf-change", () => this.updateTitle());
  }

  private onKeyDown(evt: KeyboardEvent) {
    this.lastEvent = evt;
    this.keymap.updateModifiers(evt);
    if (evt.isComposing || evt.keyCode === 229) return;
    // Scopes pushed by modals and views get first refusal. Command hotkeys run
    // only when the active scope descends from the app scope — a modal's own
    // scope does not, so Mod+P does nothing while a modal is open.
    const active = this.keymap.getActiveScope();
    const result = active.handleKey(evt, Keymap.getContext(evt));
    if (result === false) {
      evt.preventDefault();
      evt.stopPropagation();
      return;
    }
    let s: Scope | undefined = active;
    while (s && s !== this.scope) s = s.parent;
    if (s === this.scope && this.hotkeyManager.onTrigger(evt)) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  }

  private onConfigChanged(key: string) {
    if (key === "showInlineTitle") document.body.toggleClass("show-inline-title", !!this.vault.getConfig(key));
    if (key === "showViewHeader") document.body.toggleClass("show-view-header", !!this.vault.getConfig(key));
    if (key === "showRibbon") document.body.toggleClass("show-ribbon", !!this.vault.getConfig(key));
    if (["accentColor", "baseFontSize", "textFontFamily", "interfaceFontFamily", "monospaceFontFamily", "translucency"].includes(key)) this.customCss.applyAppearance();
    if (key === "theme") this.customCss.applyColorScheme();
    this.workspace.updateOptions();
  }

  private updateTitle() {
    const file = this.workspace.getActiveFile();
    this.title = this.getAppTitle(file?.basename);
    document.title = this.title;
  }

  /** `onExternalSettingsChange` when a plugin's data.json changes on disk. */
  private watchPluginData() {
    const lastSeen = new Map<string, number>();
    setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      for (const plugin of Object.values(this.plugins.plugins)) {
        if (typeof plugin.onExternalSettingsChange !== "function" || !plugin.manifest.dir) continue;
        const st = await this.vault.adapter.stat(`${plugin.manifest.dir}/data.json`).catch(() => null);
        if (!st) continue;
        const prev = lastSeen.get(plugin.manifest.id);
        lastSeen.set(plugin.manifest.id, st.mtime);
        if (prev !== undefined && st.mtime !== prev && Math.abs(st.mtime - plugin._lastDataModifiedTime) > 1000) {
          try {
            await plugin.onExternalSettingsChange();
          } catch (e) {
            console.error(e);
          }
        }
      }
    }, 3000);
  }
}

function defaultLayout() {
  return {
    main: { id: "main", type: "split", direction: "vertical", children: [{ id: "tabs", type: "tabs", children: [{ id: "leaf", type: "leaf", state: { type: "empty", state: {} } }] }] },
    left: {
      id: "left",
      type: "split",
      direction: "horizontal",
      width: 300,
      children: [
        {
          id: "left-tabs",
          type: "tabs",
          children: [
            { id: "files", type: "leaf", state: { type: "file-explorer", state: { sortOrder: "alphabetical" } } },
            { id: "search", type: "leaf", state: { type: "search", state: {} } },
            { id: "bookmarks", type: "leaf", state: { type: "bookmarks", state: {} } },
          ],
        },
      ],
    },
    right: {
      id: "right",
      type: "split",
      direction: "horizontal",
      width: 300,
      collapsed: true,
      children: [
        {
          id: "right-tabs",
          type: "tabs",
          children: [
            { id: "backlinks", type: "leaf", state: { type: "backlink", state: {} } },
            { id: "outgoing", type: "leaf", state: { type: "outgoing-link", state: {} } },
            { id: "tags", type: "leaf", state: { type: "tag", state: {} } },
            { id: "outline", type: "leaf", state: { type: "outline", state: {} } },
          ],
        },
      ],
    },
  };
}
