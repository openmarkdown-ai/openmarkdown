/**
 * app.customCss — the colour scheme, accent, fonts, community theme and CSS
 * snippets.
 *
 * Stylesheet order is part of the contract with themes: app styles, then
 * plugin styles, then the theme, then snippets. A theme overrides a plugin and
 * a snippet overrides both (docs/research/plugin-compat.md §1.4, §6.1).
 */
import { Events } from "../events";
import { fetchCommunityThemes, fetchRaw } from "./plugins";

export interface ThemeManifest {
  name: string;
  version: string;
  minAppVersion?: string;
  author?: string;
  authorUrl?: string;
  fundingUrl?: string;
}

export class CustomCSS extends Events {
  theme = "";
  themes: Record<string, ThemeManifest> = {};
  snippets: string[] = [];
  enabledSnippets = new Set<string>();
  // internal: the theme's <style>, which plugin styles are inserted before
  styleEl: HTMLStyleElement;
  extraStyleEls: HTMLStyleElement[] = [];
  private pluginAnchor: Comment;
  private variablesEl: HTMLStyleElement;
  private media = window.matchMedia("(prefers-color-scheme: dark)");

  constructor(private app: any) {
    super();
    this.variablesEl = document.createElement("style");
    this.variablesEl.id = "vault-appearance-variables";
    this.pluginAnchor = document.createComment("plugin styles");
    this.styleEl = document.createElement("style");
    this.styleEl.id = "vault-theme";
    document.head.append(this.variablesEl, this.pluginAnchor, this.styleEl);
    this.media.addEventListener("change", () => this.applyColorScheme());
  }

  getThemeFolder() {
    return `${this.app.vault.configDir}/themes`;
  }

  getSnippetsFolder() {
    return `${this.app.vault.configDir}/snippets`;
  }

  // internal: called by Plugin.loadCSS
  insertPluginStyle(el: HTMLStyleElement) {
    document.head.insertBefore(el, this.styleEl);
  }

  async load() {
    const v = this.app.vault;
    this.theme = String(v.getConfig("cssTheme") ?? "");
    this.enabledSnippets = new Set((v.getConfig("enabledCssSnippets") as string[]) ?? []);
    await this.readThemes();
    await this.readSnippets();
    this.applyColorScheme();
    this.applyAppearance();
    await this.loadTheme(this.theme);
    await this.loadSnippets();
  }

  // ---- colour scheme and appearance ---------------------------------------------

  getTheme(): "obsidian" | "moonstone" | "system" {
    return (this.app.vault.getConfig("theme") as "obsidian" | "moonstone" | "system") ?? "system";
  }

  isDarkMode(): boolean {
    const t = this.getTheme();
    return t === "obsidian" || (t === "system" && this.media.matches);
  }

  setTheme(mode: "obsidian" | "moonstone" | "system") {
    this.app.vault.setConfig("theme", mode);
    this.applyColorScheme();
  }

  applyColorScheme() {
    const dark = this.isDarkMode();
    document.body.toggleClass("theme-dark", dark);
    document.body.toggleClass("theme-light", !dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    this.app.workspace?.trigger("css-change");
    this.syncThemeColor();
  }

  /** The installed window paints its title-bar area (behind the window buttons) with theme-color. */
  syncThemeColor() {
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    // Custom properties read back unresolved ("var(--color-base-20)"), so resolve through a real property.
    const probe = document.body.createDiv({ attr: { style: "position:absolute;visibility:hidden;background-color:var(--background-secondary)" } });
    const bg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    meta.content = bg && bg !== "rgba(0, 0, 0, 0)" ? bg : this.isDarkMode() ? "#262626" : "#ffffff";
  }

  applyAppearance() {
    const v = this.app.vault;
    const rules: string[] = [];
    const accent = String(v.getConfig("accentColor") ?? "");
    if (accent) {
      const hsl = hexToHsl(accent);
      if (hsl) rules.push(`--accent-h: ${hsl.h}; --accent-s: ${hsl.s}%; --accent-l: ${hsl.l}%;`);
    }
    const font = (key: string, variable: string) => {
      const value = String(v.getConfig(key) ?? "");
      if (value) rules.push(`${variable}: ${value};`);
    };
    font("interfaceFontFamily", "--font-interface-override");
    font("textFontFamily", "--font-text-override");
    font("monospaceFontFamily", "--font-monospace-override");
    const size = Number(v.getConfig("baseFontSize") ?? 16);
    rules.push(`--font-text-size: ${size}px;`);
    this.variablesEl.textContent = rules.length ? `body { ${rules.join(" ")} }` : "";
    document.body.toggleClass("is-translucent", !!v.getConfig("translucency"));
    this.app.workspace?.trigger("css-change");
    this.syncThemeColor();
  }

  setAccentColor(hex: string) {
    this.app.vault.setConfig("accentColor", hex);
    this.applyAppearance();
  }

  // ---- themes -----------------------------------------------------------------

  async readThemes() {
    const adapter = this.app.vault.adapter;
    const folder = this.getThemeFolder();
    this.themes = {};
    if (!(await adapter.exists(folder))) return;
    const { folders } = await adapter.list(folder);
    for (const dir of folders) {
      try {
        const m = JSON.parse(await adapter.read(`${dir}/manifest.json`)) as ThemeManifest;
        this.themes[m.name] = m;
      } catch {
        const name = dir.slice(dir.lastIndexOf("/") + 1);
        if (await adapter.exists(`${dir}/theme.css`)) this.themes[name] = { name, version: "0.0.0" };
      }
    }
  }

  async loadTheme(name: string) {
    this.theme = name;
    if (!name) {
      this.styleEl.textContent = "";
    } else {
      try {
        this.styleEl.textContent = await this.app.vault.adapter.read(`${this.getThemeFolder()}/${name}/theme.css`);
      } catch {
        this.styleEl.textContent = "";
      }
    }
    this.trigger("theme-change");
    this.app.workspace?.trigger("css-change");
    this.syncThemeColor();
  }

  async setCssTheme(name: string) {
    this.app.vault.setConfig("cssTheme", name);
    await this.loadTheme(name);
  }

  /** Themes download from raw.githubusercontent.com, which sends CORS headers. */
  async installTheme(info: { name: string; repo: string }, use = true): Promise<void> {
    let manifest: ThemeManifest;
    let css: string;
    try {
      manifest = JSON.parse(await fetchRaw(info.repo, "manifest.json")) as ThemeManifest;
      css = await fetchRaw(info.repo, "theme.css");
    } catch {
      css = await fetchRaw(info.repo, "obsidian.css");
      manifest = { name: info.name, version: "0.0.0", minAppVersion: "0.16.0" };
    }
    if (manifest.name !== info.name) throw new Error("Theme name mismatch");
    const dir = `${this.getThemeFolder()}/${info.name}`;
    await this.app.vault.adapter.mkdir(dir);
    await this.app.vault.adapter.write(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
    await this.app.vault.adapter.write(`${dir}/theme.css`, css);
    this.themes[info.name] = manifest;
    if (use) await this.setCssTheme(info.name);
    this.trigger("themes-updated");
  }

  async removeTheme(name: string) {
    await this.app.vault.adapter.rmdir(`${this.getThemeFolder()}/${name}`, true).catch(() => {});
    delete this.themes[name];
    if (this.theme === name) await this.setCssTheme("");
    this.trigger("themes-updated");
  }

  listCommunityThemes() {
    return fetchCommunityThemes();
  }

  // ---- snippets ----------------------------------------------------------------

  async readSnippets() {
    const adapter = this.app.vault.adapter;
    const folder = this.getSnippetsFolder();
    this.snippets = [];
    if (!(await adapter.exists(folder))) return;
    const { files } = await adapter.list(folder);
    this.snippets = files
      .filter((f: string) => f.endsWith(".css"))
      .map((f: string) => f.slice(f.lastIndexOf("/") + 1, -4))
      .sort();
  }

  async loadSnippets() {
    for (const el of this.extraStyleEls) el.remove();
    this.extraStyleEls = [];
    for (const name of this.snippets) {
      if (!this.enabledSnippets.has(name)) continue;
      try {
        const css = await this.app.vault.adapter.read(`${this.getSnippetsFolder()}/${name}.css`);
        const el = document.createElement("style");
        el.setAttribute("data-snippet", name);
        el.textContent = css;
        document.head.appendChild(el);
        this.extraStyleEls.push(el);
      } catch {
        /* snippet removed since readSnippets */
      }
    }
    this.app.workspace?.trigger("css-change");
    this.syncThemeColor();
  }

  setCssEnabledStatus(name: string, enabled: boolean) {
    if (enabled) this.enabledSnippets.add(name);
    else this.enabledSnippets.delete(name);
    this.app.vault.setConfig("enabledCssSnippets", Array.from(this.enabledSnippets));
    void this.loadSnippets();
  }

  async requestLoadSnippets() {
    await this.readSnippets();
    await this.loadSnippets();
  }
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}
