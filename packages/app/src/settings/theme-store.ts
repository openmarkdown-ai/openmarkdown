/**
 * The community theme browser, and theme update checks.
 *
 * Everything a theme needs is on raw.githubusercontent.com, which sends CORS
 * headers (docs/research/plugin-compat.md §6.2): the directory, screenshots,
 * `manifest.json` and `theme.css`. Download counts live on Obsidian's own
 * servers without CORS, so this browser sorts by name and by submission order.
 *
 * DOM: `.modal.mod-community-modal.mod-community-theme` with the same sidebar /
 * details layout as the plugin browser, and a grid of
 * `.community-item.mod-theme` cards (`.community-item-screenshot`).
 */
import type { App } from "../obsidian/app";
import { compareVersions, fetchCommunityThemes, fetchRaw } from "../obsidian/app-internals/plugins";
import type { ThemeManifest } from "../obsidian/app-internals/custom-css";
import { Component } from "../obsidian/events";
import { setIcon } from "../obsidian/ui/icons";
import { Modal } from "../obsidian/ui/modal";
import { Notice } from "../obsidian/ui/notice";
import { ButtonComponent, DropdownComponent, SearchComponent } from "../obsidian/ui/setting";
import { matchesAll, tokens } from "./helpers";
import { renderReadme } from "./community-store";

export interface ThemeListing {
  name: string;
  author: string;
  repo: string;
  screenshot: string;
  modes: string[];
  legacy?: boolean;
}

type ThemeSort = "alpha" | "release" | "author";
type ModeFilter = "all" | "dark" | "light";

const updates: Record<string, { version: string; listing: ThemeListing }> = {};

/** Theme updates found by the last check, by theme name. */
export function themeUpdates(): Record<string, { version: string; listing: ThemeListing }> {
  return updates;
}

export function screenshotUrl(t: ThemeListing): string {
  return `https://raw.githubusercontent.com/${t.repo}/HEAD/${t.screenshot.split("/").map(encodeURIComponent).join("/")}`;
}

/** The version a theme's default branch offers, or null for a legacy theme with no manifest. */
async function remoteThemeVersion(listing: ThemeListing): Promise<string | null> {
  try {
    const manifest = JSON.parse(await fetchRaw(listing.repo, "manifest.json")) as ThemeManifest;
    return manifest.name === listing.name ? manifest.version : null;
  } catch {
    return null;
  }
}

export async function checkThemeUpdates(app: App): Promise<Record<string, { version: string; listing: ThemeListing }>> {
  const list = (await fetchCommunityThemes()) as ThemeListing[];
  const byName = new Map(list.map((t) => [t.name, t]));
  for (const key of Object.keys(updates)) delete updates[key];
  await Promise.all(
    Object.values(app.customCss.themes).map(async (installed) => {
      const listing = byName.get(installed.name);
      if (!listing) return;
      const version = await remoteThemeVersion(listing);
      if (version && compareVersions(version, installed.version ?? "0.0.0") > 0) updates[installed.name] = { version, listing };
    }),
  );
  return updates;
}

export async function updateTheme(app: App, name: string): Promise<void> {
  const u = updates[name];
  if (!u) return;
  const css = app.customCss;
  await css.installTheme(u.listing, css.theme === name);
  delete updates[name];
}

export class ThemeBrowserModal extends Modal {
  private themes: ThemeListing[] = [];
  private query = "";
  private sort: ThemeSort = "release";
  private mode: ModeFilter = "all";
  private selected: ThemeListing | null = null;
  private summaryEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private detailsEl!: HTMLElement;
  private readmeComponent: Component | null = null;
  private detailSeq = 0;

  constructor(
    app: App,
    private onDone?: () => void,
    private initialName: string | null = null,
  ) {
    super(app);
    this.modalEl.addClasses(["mod-community-modal", "mod-community-theme", "mod-sidebar-layout"]);
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const sidebar = contentEl.createDiv({ cls: "community-modal-sidebar" });
    const controls = sidebar.createDiv({ cls: "community-modal-controls" });
    const searchRow = controls.createDiv({ cls: "setting-item community-modal-search" });
    const search = new SearchComponent(searchRow).setPlaceholder("Search community themes...");
    search.onChange((v) => {
      this.query = v;
      this.renderGrid();
    });
    const options = controls.createDiv({ cls: "community-modal-options" });
    const modeWrap = options.createDiv({ cls: "community-modal-mode" });
    modeWrap.createSpan({ cls: "community-modal-option-label", text: "Show" });
    new DropdownComponent(modeWrap)
      .addOptions({ all: "All themes", dark: "Dark themes", light: "Light themes" })
      .setValue(this.mode)
      .onChange((v) => {
        this.mode = v as ModeFilter;
        this.renderGrid();
      });
    const sortWrap = options.createDiv({ cls: "community-modal-sort" });
    sortWrap.createSpan({ cls: "community-modal-option-label", text: "Sort by" });
    new DropdownComponent(sortWrap)
      .addOptions({ release: "Recently released", alpha: "Alphabetical", author: "Author" })
      .setValue(this.sort)
      .onChange((v) => {
        this.sort = v as ThemeSort;
        this.renderGrid();
      });
    this.summaryEl = controls.createDiv({ cls: "community-modal-search-summary", text: "Loading community themes…" });
    const wrapper = sidebar.createDiv({ cls: "community-modal-search-results-wrapper" });
    this.gridEl = wrapper.createDiv({ cls: "community-modal-search-results mod-grid" });
    this.detailsEl = contentEl.createDiv({ cls: "community-modal-details" });
    this.detailsEl.createDiv({ cls: "vault-empty-state", text: "Select a theme to see its details." });
    window.setTimeout(() => search.inputEl.focus(), 0);

    try {
      this.themes = (await fetchCommunityThemes()) as ThemeListing[];
    } catch (e) {
      this.summaryEl.setText(`Could not load the theme directory: ${(e as Error).message}`);
      this.summaryEl.addClass("mod-warning");
      return;
    }
    if (!this.isOpen) return;
    this.renderGrid();
    const initial = this.initialName ? this.themes.find((t) => t.name.toLowerCase() === this.initialName!.toLowerCase()) : null;
    if (initial) this.select(initial);
  }

  override onClose(): void {
    this.readmeComponent?.unload();
    this.readmeComponent = null;
    this.onDone?.();
  }

  private renderGrid() {
    const toks = tokens(this.query);
    const indexOf = new Map(this.themes.map((t, i) => [t, i]));
    let list = this.themes.filter((t) => (this.mode === "all" || t.modes.includes(this.mode)) && matchesAll(`${t.name} ${t.author} ${t.repo}`, toks));
    if (this.sort === "alpha") list.sort((a, b) => a.name.localeCompare(b.name));
    else if (this.sort === "author") list.sort((a, b) => a.author.localeCompare(b.author) || a.name.localeCompare(b.name));
    else list.sort((a, b) => (indexOf.get(b) ?? 0) - (indexOf.get(a) ?? 0));
    list = list.filter(Boolean);
    this.summaryEl.removeClass("mod-warning");
    this.summaryEl.setText(`Showing ${list.length} theme${list.length === 1 ? "" : "s"}:`);
    this.gridEl.empty();
    if (!toks.length && this.mode === "all") this.createDefaultCard();
    for (const theme of list) this.createCard(theme);
  }

  private createDefaultCard() {
    const css = this.app.customCss;
    const el = this.gridEl.createDiv({ cls: "community-item mod-theme vault-default-theme" });
    el.toggleClass("is-selected", this.selected === null && this.detailsEl.getAttr("data-theme") === "");
    const shot = el.createDiv({ cls: "community-item-screenshot vault-default-theme-preview" });
    setIcon(shot.createDiv({ cls: "vault-default-theme-icon" }), "lucide-sun-moon");
    const nameEl = el.createDiv({ cls: "community-item-name", text: "Default" });
    if (!css.theme) nameEl.createSpan({ cls: "flair mod-pop", text: "Current" });
    el.createDiv({ cls: "community-item-author", text: "Built in" });
    el.addEventListener("click", () => {
      this.selected = null;
      for (const s of Array.from(this.gridEl.querySelectorAll(".community-item.is-selected"))) s.removeClass("is-selected");
      el.addClass("is-selected");
      this.renderDefaultDetails();
    });
  }

  private createCard(theme: ThemeListing) {
    const css = this.app.customCss;
    const el = this.gridEl.createDiv({ cls: "community-item mod-theme", attr: { "data-theme-name": theme.name } });
    el.toggleClass("is-selected", this.selected?.name === theme.name);
    const shot = el.createDiv({ cls: "community-item-screenshot" });
    if (theme.screenshot) {
      const img = shot.createEl("img", { attr: { src: screenshotUrl(theme), alt: `${theme.name} screenshot`, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" } });
      img.addEventListener("error", () => shot.addClass("is-broken"));
    }
    const nameEl = el.createDiv({ cls: "community-item-name", text: theme.name });
    if (css.theme === theme.name) nameEl.createSpan({ cls: "flair mod-pop", text: "Current" });
    else if (css.themes[theme.name]) nameEl.createSpan({ cls: "flair", text: updates[theme.name] ? "Update" : "Installed" });
    el.createDiv({ cls: "community-item-author", text: `By ${theme.author}` });
    const modes = el.createDiv({ cls: "community-item-modes" });
    for (const m of theme.modes) modes.createSpan({ cls: `community-item-mode mod-${m}`, text: m === "dark" ? "Dark" : "Light" });
    el.addEventListener("click", () => this.select(theme));
  }

  private select(theme: ThemeListing) {
    this.selected = theme;
    for (const s of Array.from(this.gridEl.querySelectorAll(".community-item.is-selected"))) s.removeClass("is-selected");
    this.gridEl.querySelector(`.community-item[data-theme-name="${CSS.escape(theme.name)}"]`)?.addClass("is-selected");
    void this.renderDetails(theme, true);
  }

  private refreshCards() {
    this.renderGrid();
  }

  private renderDefaultDetails() {
    const el = this.detailsEl;
    const css = this.app.customCss;
    el.empty();
    el.setAttr("data-theme", "");
    const info = el.createDiv({ cls: "community-modal-info" });
    info.createDiv({ cls: "community-modal-info-name", text: "Default" });
    info.createDiv({ cls: "community-modal-info-desc", text: "The built-in theme, in light and dark. Community themes replace it; CSS snippets apply on top of either." });
    const buttons = info.createDiv({ cls: "community-modal-button-container" });
    if (css.theme) {
      new ButtonComponent(buttons)
        .setButtonText("Use")
        .setCta()
        .onClick(async () => {
          await css.setCssTheme("");
          this.refreshCards();
          this.renderDefaultDetails();
        });
    } else {
      buttons.createDiv({ cls: "community-modal-button-note", text: "This is the current theme." });
    }
  }

  private async renderDetails(theme: ThemeListing, reloadReadme: boolean) {
    const seq = ++this.detailSeq;
    const app = this.app;
    const css = app.customCss;
    const el = this.detailsEl;
    const keepReadme = !reloadReadme && el.getAttr("data-theme") === theme.name && el.querySelector(".community-modal-readme");
    if (!keepReadme) {
      el.empty();
      el.setAttr("data-theme", theme.name);
      el.scrollTop = 0;
    } else {
      el.querySelector(".community-modal-info")?.remove();
      el.querySelector(".community-modal-screenshot")?.remove();
    }
    const info = createDiv({ cls: "community-modal-info" });
    el.prepend(info);
    if (theme.screenshot) {
      const shot = createDiv({ cls: "community-modal-screenshot" });
      shot.createEl("img", { attr: { src: screenshotUrl(theme), alt: `${theme.name} screenshot`, referrerpolicy: "no-referrer" } });
      info.after(shot);
    }
    info.createDiv({ cls: "community-modal-info-name", text: theme.name });
    const meta = info.createDiv({ cls: "community-modal-info-meta" });
    const versionEl = meta.createDiv({ cls: "community-modal-info-version", text: "Version …" });
    meta.createDiv({ cls: "community-modal-info-modes", text: theme.modes.map((m) => (m === "dark" ? "Dark" : "Light")).join(" and ") });
    info.createDiv({ cls: "community-modal-info-author", text: `By ${theme.author}` });
    const repo = info.createDiv({ cls: "community-modal-info-repo" });
    repo.appendText("Repository: ");
    repo.createEl("a", { text: theme.repo, href: `https://github.com/${theme.repo}`, attr: { target: "_blank", rel: "noopener" } });
    const buttons = info.createDiv({ cls: "community-modal-button-container" });
    const errorEl = info.createDiv({ cls: "vault-community-error" });
    errorEl.hide();

    if (!keepReadme) {
      const readmeEl = el.createDiv({ cls: "community-modal-readme markdown-rendered markdown-preview-view" });
      this.readmeComponent?.unload();
      this.readmeComponent = new Component();
      this.readmeComponent.load();
      void renderReadme(app, readmeEl, theme.repo, this.readmeComponent);
    }

    const installed = css.themes[theme.name];
    const isCurrent = css.theme === theme.name;
    const remote = theme.legacy ? null : await remoteThemeVersion(theme);
    if (seq !== this.detailSeq || !this.isOpen) return;
    versionEl.setText(
      installed
        ? `Installed ${installed.version}${remote && compareVersions(remote, installed.version ?? "0.0.0") > 0 ? ` · ${remote} available` : ""}`
        : remote
          ? `Version ${remote}`
          : theme.legacy
            ? "Legacy theme"
            : "Version unknown",
    );

    const run = async (btn: ButtonComponent, busy: string, fn: () => Promise<void>) => {
      btn.setDisabled(true).setButtonText(busy);
      errorEl.hide();
      try {
        await fn();
      } catch (e) {
        errorEl.empty();
        errorEl.show();
        errorEl.createDiv({ cls: "vault-community-error-message", text: `Something went wrong: ${(e as Error).message}` });
      }
      this.refreshCards();
      if (seq === this.detailSeq || this.selected === theme) void this.renderDetails(theme, false);
    };

    if (!installed) {
      const b = new ButtonComponent(buttons).setButtonText("Install and use").setCta();
      b.onClick(() =>
        run(b, "Installing…", async () => {
          await css.installTheme(theme, true);
          new Notice(`Installed and switched to "${theme.name}".`);
        }),
      );
      const b2 = new ButtonComponent(buttons).setButtonText("Install");
      b2.onClick(() => run(b2, "Installing…", () => css.installTheme(theme, false)));
    } else {
      if (isCurrent) {
        const b = new ButtonComponent(buttons).setButtonText("Stop using this theme");
        b.onClick(() => run(b, "Switching…", () => css.setCssTheme("")));
      } else {
        const b = new ButtonComponent(buttons).setButtonText("Use this theme").setCta();
        b.onClick(() => run(b, "Switching…", () => css.setCssTheme(theme.name)));
      }
      if (remote && compareVersions(remote, installed.version ?? "0.0.0") > 0) {
        const b = new ButtonComponent(buttons).setButtonText("Update").setCta();
        b.onClick(() =>
          run(b, "Updating…", async () => {
            await css.installTheme(theme, isCurrent);
            delete updates[theme.name];
            new Notice(`Updated "${theme.name}".`);
          }),
        );
      }
      const b = new ButtonComponent(buttons).setButtonText("Remove").setWarning();
      b.onClick(() => run(b, "Removing…", () => css.removeTheme(theme.name)));
    }
  }
}
