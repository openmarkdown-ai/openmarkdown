/**
 * Settings → Community plugins (§6.9).
 *
 * The browser cannot download plugin code from GitHub on its own: `main.js`
 * exists only as a release asset, and GitHub's release asset hosts send no
 * CORS header (docs/research/plugin-compat.md §2.3). So besides the store, this
 * tab offers "Install from files…" (a plugin folder, its three files, or a
 * release .zip), a user-configurable download proxy, and a note when the
 * companion browser extension (which is not bound by CORS) is present.
 */
import type { PluginManifest } from "obsidian";
import type { App } from "../../obsidian/app";
import { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { getRequestTransport } from "../../obsidian/util";
import { confirmModal, matchesAll, pickFiles, tokens } from "../helpers";
import { AppSettingTab, descFragment } from "../tab-base";
import { readZip } from "../zip";
import { PluginBrowserModal } from "../community-store";
import { PRODUCT_NAME } from "../../product";

const PLUGIN_FILES = ["manifest.json", "main.js", "styles.css", "data.json"];
const AUTO_CHECK_KEY = "check-plugin-updates";
const LAST_CHECK_KEY = "plugin-updates-last-check";
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

/** The first funding link of a manifest (`fundingUrl` is a string or `{label: url}`). */
export function fundingLink(manifest: PluginManifest | null | undefined): string | null {
  const f = (manifest as { fundingUrl?: string | Record<string, string> } | null | undefined)?.fundingUrl;
  if (!f) return null;
  return typeof f === "string" ? f : (Object.values(f)[0] ?? null);
}

/** Opens Settings → Hotkeys filtered to one plugin's commands. */
export function openHotkeysFor(app: App, _name: string, id: string): void {
  const setting = app.setting;
  if (!setting.isOpen) setting.open();
  const tab = setting.openTabById("hotkeys") as { searchComponent?: { setValue(v: string): unknown }; updateHotkeyVisibility?: () => void } | null;
  tab?.searchComponent?.setValue(`${id}:`);
  tab?.updateHotkeyVisibility?.();
}

/** Turns off Restricted mode after asking, as Obsidian does before enabling a plugin. */
export async function ensureCommunityPluginsOn(app: App): Promise<boolean> {
  if (app.plugins.isEnabled()) return true;
  const ok = await confirmModal(app, {
    title: "Turn on community plugins?",
    message: "Restricted mode is on, so community plugins cannot run. Community plugins are made by third parties and can access your vault's files.",
    cta: "Turn on community plugins",
  });
  if (!ok) return false;
  await app.plugins.setEnable(true);
  return true;
}

export async function enableWithPrompt(app: App, id: string): Promise<boolean> {
  if (!(await ensureCommunityPluginsOn(app))) return false;
  const ok = await app.plugins.enablePluginAndSave(id);
  if (!ok) new Notice(`Could not enable "${app.plugins.manifests[id]?.name ?? id}". See the developer console for details.`);
  return ok;
}

/** Collects plugin files from a picked folder, a set of files, or a .zip, and installs them. */
export async function installFromPicked(app: App, kind: "folder" | "files" | "zip"): Promise<PluginManifest | null> {
  const picked = await pickFiles(
    kind === "folder" ? { directory: true, multiple: true } : kind === "zip" ? { accept: ".zip,application/zip" } : { accept: ".json,.js,.css", multiple: true },
  );
  if (!picked.length) return null;
  try {
    let files: { name: string; data: string }[] = [];
    if (kind === "zip") {
      const entries = await readZip(await picked[0]!.arrayBuffer());
      const manifests = entries.filter((e) => e.path === "manifest.json" || e.path.endsWith("/manifest.json")).sort((a, b) => a.path.length - b.path.length);
      const manifest = manifests[0];
      if (!manifest) throw new Error("The zip does not contain a manifest.json.");
      const dir = manifest.path.slice(0, manifest.path.length - "manifest.json".length);
      const decoder = new TextDecoder();
      for (const entry of entries) {
        const name = entry.path.slice(dir.length);
        if (!entry.path.startsWith(dir) || !PLUGIN_FILES.includes(name)) continue;
        files.push({ name, data: decoder.decode(await entry.read()) });
      }
    } else {
      const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      let candidates = picked;
      if (kind === "folder") {
        const manifests = picked.filter((f) => f.name === "manifest.json").sort((a, b) => rel(a).length - rel(b).length);
        const manifest = manifests[0];
        if (!manifest) throw new Error("The folder does not contain a manifest.json.");
        const dir = rel(manifest).slice(0, rel(manifest).length - "manifest.json".length);
        candidates = picked.filter((f) => rel(f) === dir + f.name);
      }
      files = await Promise.all(candidates.filter((f) => PLUGIN_FILES.includes(f.name)).map(async (f) => ({ name: f.name, data: await f.text() })));
    }
    if (!files.some((f) => f.name === "manifest.json")) throw new Error("manifest.json is missing.");
    if (!files.some((f) => f.name === "main.js")) throw new Error("main.js is missing.");
    const manifest = await app.plugins.installFromFiles(files);
    new Notice(`Installed "${manifest.name}" ${manifest.version}.`);
    return manifest;
  } catch (e) {
    new Notice(`Could not install the plugin: ${(e as Error).message}`);
    return null;
  }
}

/** Background update check: at most every three days, when turned on and community plugins run. */
export function maybeAutoCheckPluginUpdates(app: App): void {
  if (app.loadLocalStorage(AUTO_CHECK_KEY) === false) return;
  if (!app.plugins.isEnabled() || !Object.keys(app.plugins.manifests).length) return;
  const last = Number(app.loadLocalStorage(LAST_CHECK_KEY) ?? 0);
  if (Date.now() - last < THREE_DAYS) return;
  app.saveLocalStorage(LAST_CHECK_KEY, Date.now());
  void app.plugins
    .checkForUpdates()
    .then(() => {
      const n = Object.keys(app.plugins.updates).length;
      if (n) new Notice(`${n} community plugin update${n === 1 ? " is" : "s are"} available. Open Settings → Community plugins to update.`);
    })
    .catch(() => {});
}

export class CommunityPluginsSettingTab extends AppSettingTab {
  private query = "";
  private preQuery = "";
  // internal: set while this tab changes a pre-installed plugin, so it re-renders once at the end
  private busy = false;
  private unsubscribe: (() => void)[] = [];

  constructor(app: App) {
    super(app, "community-plugins", "Community plugins", "lucide-puzzle");
  }

  override display(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    const plugins = this.app.plugins;
    for (const name of ["plugin-installed", "plugin-uninstalled", "restricted-change", "updates-checked"]) {
      const ref = plugins.on(name, () => this.rerender());
      this.unsubscribe.push(() => plugins.offref(ref));
    }
    const internal = this.app.internalPlugins;
    const ref = internal.on("plugin-state-change", () => {
      if (!this.busy) this.rerender();
    });
    this.unsubscribe.push(() => internal.offref(ref));
    super.display();
  }

  override hide(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    super.hide();
  }

  render(el: HTMLElement): void {
    const app = this.app;
    const plugins = app.plugins;
    const restricted = !plugins.isEnabled();

    // Restricted mode
    const restrictedGroup = this.group(el);
    const r = this.row(
      restrictedGroup,
      "Restricted mode",
      restricted
        ? "Restricted mode is on. Community plugins are not loaded, so your vault is only changed by the app itself."
        : "Restricted mode is off. Community plugins can run. Only install plugins from authors you trust: they can read and change every file in your vault.",
    );
    r.settingEl.addClass("vault-restricted-mode");
    r.addButton((b) => {
      b.setButtonText(restricted ? "Turn on community plugins" : "Turn on restricted mode");
      if (restricted) b.setCta();
      b.onClick(async () => {
        b.setDisabled(true);
        await plugins.setEnable(restricted);
        this.rerender();
        app.setting?.updatePluginSection?.();
      });
    });

    // Store and updates
    const store = this.group(el, "Community plugins");
    this.row(store, "Community plugins", "Discover and install plugins made by the community.").addButton((b) =>
      b
        .setButtonText("Browse")
        .setCta()
        .onClick(() => new PluginBrowserModal(app).open()),
    );
    this.row(store, "Automatically check for plugin updates", "Check for new versions of installed plugins every few days.").addToggle((t) =>
      t.setValue(app.loadLocalStorage(AUTO_CHECK_KEY) !== false).onChange((v) => app.saveLocalStorage(AUTO_CHECK_KEY, v ? null : false)),
    );
    const installedIds = Object.keys(plugins.manifests);
    const updateIds = Object.keys(plugins.updates).filter((id) => plugins.manifests[id]);
    const current = this.row(
      store,
      "Current plugins",
      `${installedIds.length} installed.${updateIds.length ? ` ${updateIds.length} update${updateIds.length === 1 ? "" : "s"} available.` : ""}`,
    );
    current.addButton((b) =>
      b
        .setButtonText("Check for updates")
        .setDisabled(!installedIds.length)
        .onClick(async () => {
          b.setDisabled(true).setButtonText("Checking…");
          try {
            await plugins.checkForUpdates();
            const n = Object.keys(plugins.updates).length;
            new Notice(n ? `${n} plugin update${n === 1 ? "" : "s"} available.` : "All plugins are up to date.");
          } catch (e) {
            new Notice(`Could not check for updates: ${(e as Error).message}`);
          }
          this.rerender();
        }),
    );
    if (updateIds.length) {
      current.addButton((b) =>
        b
          .setButtonText("Update all")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true).setButtonText("Updating…");
            for (const id of updateIds) await this.updatePlugin(id);
            this.rerender();
          }),
      );
    }

    // Downloads
    const downloads = this.group(el, "Plugin downloads");
    if (getRequestTransport()) {
      this.row(downloads, "Companion extension detected", "Plugins download directly from GitHub through the browser extension. No proxy is needed.").settingEl.addClass("vault-extension-detected");
    }
    this.row(
      downloads,
      "Plugin download proxy URL",
      descFragment([
        "GitHub serves plugin files (main.js, styles.css) as release assets without CORS headers, so a web page cannot download them directly. ",
        "Point this at a proxy you trust that answers ",
        { text: "<proxy>/gh/<owner>/<repo>/<version>/<file>", code: true },
        " with the release asset and an Access-Control-Allow-Origin header. Leave empty to install plugins from files instead.",
      ]),
    ).addText((t) => {
      t.setPlaceholder("https://plugins.example.com").setValue(String(app.loadLocalStorage("plugin-proxy-url") ?? ""));
      t.inputEl.type = "url";
      t.onChange((v) => {
        const value = v.trim().replace(/\/+$/, "");
        if (value && !/^https?:\/\//i.test(value)) {
          t.inputEl.setCustomValidity("Enter an http:// or https:// URL.");
          t.inputEl.reportValidity();
          return;
        }
        t.inputEl.setCustomValidity("");
        app.saveLocalStorage("plugin-proxy-url", value || null);
      });
    });

    // Installed plugins
    const installed = this.group(el, "Installed plugins");
    installed.addSearch((s) =>
      s
        .setPlaceholder("Search installed plugins...")
        .setValue(this.query)
        .onChange((v) => {
          this.query = v;
          filter();
        }),
    );
    installed.addExtraButton((b) =>
      b
        .setIcon("lucide-refresh-cw")
        .setTooltip("Reload plugins")
        .onClick(async () => {
          await plugins.loadManifests();
          new Notice("Reloaded the plugin list.");
          this.rerender();
        }),
    );
    installed.addExtraButton((b) => {
      b.setIcon("lucide-folder-input")
        .setTooltip("Install from files…")
        .onClick(() => {
          const menu = new Menu();
          menu.addItem((i) => i.setTitle("Select plugin folder…").setIcon("lucide-folder").onClick(() => void this.installPicked("folder")));
          menu.addItem((i) => i.setTitle("Select manifest.json, main.js, styles.css…").setIcon("lucide-files").onClick(() => void this.installPicked("files")));
          menu.addItem((i) => i.setTitle("Select release .zip…").setIcon("lucide-file-archive").onClick(() => void this.installPicked("zip")));
          const rect = b.extraSettingsEl.getBoundingClientRect();
          menu.showAtPosition({ x: rect.left, y: rect.bottom });
        });
    });

    const manifests = Object.values(plugins.manifests).sort((a, b) => a.name.localeCompare(b.name));
    if (!manifests.length) {
      this.row(installed, "No community plugins installed", "Browse the community plugins, or install a plugin from its files.");
    }
    const rows: { el: HTMLElement; text: string }[] = [];
    for (const manifest of manifests) {
      const id = manifest.id;
      const enabled = plugins.enabledPlugins.has(id);
      const loaded = !!plugins.plugins[id];
      const refusal = plugins.canRun(manifest);
      const desc = createFragment();
      desc.createDiv({ cls: "vault-plugin-meta", text: `Version ${manifest.version}${manifest.author ? ` · By ${manifest.author}` : ""}` });
      desc.createDiv({ text: manifest.description ?? "" });
      if (refusal) desc.createDiv({ cls: "vault-plugin-warning mod-warning", text: refusal });
      else if (enabled && !loaded && !restricted) desc.createDiv({ cls: "vault-plugin-warning mod-warning", text: "Failed to load. See the developer console for details." });
      // W6c: desktop-only plugins can be tried anyway, one plugin at a time, never automatically.
      const desktopOnly = plugins.isDesktopOnlyBlocked(manifest);
      const loadAnyway = desktopOnly && plugins.hasDesktopOnlyOverride(id);
      if (loadAnyway) {
        desc.createDiv({
          cls: "vault-plugin-warning vault-load-anyway-note mod-warning",
          text: "Marked desktop-only. Loading anyway on this device: anything that needs Node or Electron fails with a notice when the plugin uses it.",
        });
      }
      const s = this.row(installed, manifest.name, desc);
      s.settingEl.setAttr("data-plugin-id", id);
      s.settingEl.addClass("vault-installed-plugin");
      if (desktopOnly) {
        s.addButton((b) => {
          b.buttonEl.addClass("vault-load-anyway-button");
          b.setButtonText(loadAnyway ? "Stop loading anyway" : "Try to load anyway").onClick(async () => {
            if (!loadAnyway) {
              const ok = await confirmModal(app, {
                title: `Load “${manifest.name}” anyway?`,
                message:
                  "Its author marked this plugin as desktop-only. Many such plugins work in the browser, but if it needs Node.js or Electron (files outside the vault, shell commands, native windows) those parts throw an error when used, and it could misbehave. The plugin is not turned on until you enable it.",
                cta: "Try to load anyway",
                warning: true,
              });
              if (!ok) return;
            }
            await plugins.setDesktopOnlyOverride(id, !loadAnyway);
            this.rerender();
            app.setting?.updatePluginSection?.();
          });
        });
      }

      if (plugins.updates[id]) {
        s.addButton((b) =>
          b
            .setButtonText(`Update to ${plugins.updates[id]!.version}`)
            .setCta()
            .onClick(async () => {
              b.setDisabled(true).setButtonText("Updating…");
              await this.updatePlugin(id);
              this.rerender();
            }),
        );
      }
      const tab = loaded ? app.setting?.pluginTabs.find((t: { id: string }) => t.id === id) : null;
      if (tab) {
        s.addExtraButton((b) =>
          b
            .setIcon("lucide-settings")
            .setTooltip("Options")
            .onClick(() => app.setting.openTab(tab)),
        );
      }
      if (loaded) {
        s.addExtraButton((b) =>
          b
            .setIcon("lucide-plus-circle")
            .setTooltip("Hotkeys")
            .onClick(() => openHotkeysFor(app, manifest.name, id)),
        );
      }
      const funding = fundingLink(manifest);
      if (funding) {
        s.addExtraButton((b) =>
          b
            .setIcon("lucide-heart")
            .setTooltip("Support the author")
            .onClick(() => window.open(funding, "_blank", "noopener")),
        );
      }
      s.addExtraButton((b) =>
        b
          .setIcon("lucide-trash-2")
          .setTooltip("Uninstall")
          .onClick(async () => {
            const ok = await confirmModal(app, {
              title: "Uninstall plugin",
              message: `Uninstall "${manifest.name}"? Its folder, including its settings (data.json), is deleted from the vault.`,
              cta: "Uninstall",
              warning: true,
            });
            if (!ok) return;
            await plugins.uninstallPlugin(id);
            new Notice(`Uninstalled "${manifest.name}".`);
            this.rerender();
            app.setting?.updatePluginSection?.();
          }),
      );
      s.addToggle((t) => {
        t.setValue(enabled && (loaded || restricted))
          .setDisabled(restricted || !!refusal)
          .onChange(async (v) => {
            t.setDisabled(true);
            if (v) await enableWithPrompt(app, id);
            else await plugins.disablePluginAndSave(id);
            this.rerender();
            app.setting?.updatePluginSection?.();
          });
        if (restricted) t.setTooltip("Turn off restricted mode to enable plugins");
      });
      rows.push({ el: s.settingEl, text: `${manifest.name} ${manifest.author ?? ""} ${manifest.description ?? ""} ${id}` });
    }
    const filter = () => {
      const toks = tokens(this.query);
      for (const row of rows) row.el.toggle(matchesAll(row.text, toks));
    };
    filter();

    this.renderPreinstalled(el);
  }

  /**
   * OpenMarkdown's pre-installed plugins: first-party, so restricted mode does
   * not apply. Each can be turned off, or uninstalled and reinstalled offline.
   */
  private renderPreinstalled(el: HTMLElement) {
    const app = this.app;
    const internal = app.internalPlugins;
    const defs = internal.getPreinstalledDefinitions();
    const installedDefs = defs.filter((d) => !internal.isUninstalled(d.id));
    const removedDefs = defs.filter((d) => internal.isUninstalled(d.id));

    const group = this.group(el, "Pre-installed plugins");
    group.addSearch((s) =>
      s
        .setPlaceholder("Search pre-installed plugins...")
        .setValue(this.preQuery)
        .onChange((v) => {
          this.preQuery = v;
          filter();
        }),
    );
    const intro = this.row(
      group,
      `Made by ${PRODUCT_NAME}`,
      "These plugins come with the app and are installed in every vault. They run in restricted mode too. Uninstall any you do not use; you can reinstall them here at any time, without a download.",
    );
    intro.settingEl.addClass("vault-preinstalled-intro");
    const rows: { el: HTMLElement; text: string }[] = [];
    for (const def of installedDefs) {
      const wrapper = internal.getPluginById(def.id)!;
      const manifest = wrapper.manifest;
      const enabled = wrapper.enabled;
      const desc = createFragment();
      const meta = desc.createDiv({ cls: "vault-plugin-meta" });
      meta.createSpan({ cls: "vault-plugin-tag", text: "Pre-installed" });
      meta.appendText(`Version ${manifest.version} · By ${manifest.author}`);
      desc.createDiv({ text: def.description });
      const standing = (def.preinstalled?.replaces ?? []).filter((id) => app.plugins.enabledPlugins.has(id) && app.plugins.manifests[id]);
      if (standing.length) {
        const names = standing.map((id) => app.plugins.manifests[id]?.name ?? id).join(", ");
        desc.createDiv({ cls: "vault-plugin-meta vault-standing-aside", text: `Steps aside while ${names} ${standing.length === 1 ? "is" : "are"} enabled.` });
      }
      const s = this.row(group, def.name, desc);
      s.settingEl.setAttr("data-plugin-id", def.id);
      s.settingEl.addClass("vault-preinstalled-plugin");
      const tab = enabled ? app.setting?.pluginTabs.find((t: { id: string; plugin?: { manifest?: { id?: string } } }) => t.plugin?.manifest?.id === def.id || t.id === def.id) : null;
      if (tab) {
        s.addExtraButton((b) =>
          b
            .setIcon("lucide-settings")
            .setTooltip("Options")
            .onClick(() => app.setting.openTab(tab)),
        );
      }
      if (enabled) {
        s.addExtraButton((b) =>
          b
            .setIcon("lucide-plus-circle")
            .setTooltip("Hotkeys")
            .onClick(() => openHotkeysFor(app, def.name, def.id)),
        );
      }
      s.addExtraButton((b) => {
        b.extraSettingsEl.addClass("vault-preinstalled-uninstall");
        b.setIcon("lucide-trash-2")
          .setTooltip("Uninstall")
          .onClick(() => void this.uninstallPreinstalled(def.id));
      });
      s.addToggle((t) =>
        t.setValue(enabled).onChange(async (v) => {
          t.setDisabled(true);
          this.busy = true;
          try {
            await internal.setEnabled(def.id, v);
          } catch (e) {
            console.error(e);
          } finally {
            this.busy = false;
          }
          this.rerender();
          app.setting?.updatePluginSection?.();
        }),
      );
      rows.push({ el: s.settingEl, text: `${def.name} ${def.description} ${def.id}` });
    }
    if (!installedDefs.length) this.row(group, "No pre-installed plugins", "Every pre-installed plugin was uninstalled. Reinstall them below.");
    const filter = () => {
      const toks = tokens(this.preQuery);
      for (const row of rows) row.el.toggle(matchesAll(row.text, toks));
    };
    filter();

    if (!removedDefs.length) return;
    const removed = this.group(el, "Removed pre-installed plugins");
    for (const def of removedDefs) {
      const s = this.row(removed, def.name, def.description);
      s.settingEl.setAttr("data-plugin-id", def.id);
      s.settingEl.addClass("vault-removed-plugin");
      s.addButton((b) =>
        b.setButtonText("Reinstall").onClick(async () => {
          b.setDisabled(true);
          this.busy = true;
          try {
            await internal.reinstall(def.id);
            new Notice(`Reinstalled "${def.name}".`);
          } finally {
            this.busy = false;
          }
          this.rerender();
          app.setting?.updatePluginSection?.();
        }),
      );
    }
  }

  private async uninstallPreinstalled(id: string) {
    const app = this.app;
    const internal = app.internalPlugins;
    const def = internal.getDefinition(id);
    const pre = def?.preinstalled;
    if (!def || !pre) return;
    const message = createFragment();
    message.createDiv({ text: `“${def.name}” is removed from this vault: its commands, views, ribbon icons and settings tab go away.` });
    const list = message.createEl("ul", { cls: "vault-uninstall-removes" });
    list.createEl("li").append("Its settings file, ", createEl("code", { text: `${app.vault.configDir}/${id}.json` }));
    for (const item of pre.removes ?? []) list.createEl("li", { text: item.charAt(0).toUpperCase() + item.slice(1) });
    message.createDiv({ text: "Your notes are not changed. You can reinstall it from this list later, with default settings." });
    const ok = await confirmModal(app, { title: `Uninstall ${def.name}?`, message, cta: "Uninstall", warning: true });
    if (!ok) return;
    let disconnect = false;
    if (pre.disconnect && (await pre.disconnect.needed(app).catch(() => false))) {
      disconnect = await confirmModal(app, { title: pre.disconnect.title, message: pre.disconnect.message, cta: pre.disconnect.cta, warning: true });
      if (!disconnect) return;
    }
    this.busy = true;
    try {
      await internal.uninstall(id, { disconnect });
      new Notice(`Uninstalled "${def.name}".`);
    } finally {
      this.busy = false;
    }
    this.rerender();
    app.setting?.updatePluginSection?.();
  }

  private async installPicked(kind: "folder" | "files" | "zip") {
    const manifest = await installFromPicked(this.app, kind);
    this.rerender();
    if (!manifest || this.app.plugins.enabledPlugins.has(manifest.id)) return;
    const ok = await confirmModal(this.app, { title: `Enable "${manifest.name}"?`, message: "The plugin is installed. Enable it now?", cta: "Enable", cancel: "Not now" });
    if (ok) await enableWithPrompt(this.app, manifest.id);
    this.rerender();
    this.app.setting?.updatePluginSection?.();
  }

  private async updatePlugin(id: string) {
    const u = this.app.plugins.updates[id];
    if (!u) return;
    try {
      await this.app.plugins.installPlugin(u.repo, u.version, u.manifest);
      new Notice(`Updated "${u.manifest.name}" to ${u.version}.`);
    } catch (e) {
      new Notice(`Could not update "${u.manifest.name}": ${(e as Error).message}`, 10000);
    }
  }
}
