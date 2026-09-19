/**
 * The community plugin browser.
 *
 * Directory data comes from raw.githubusercontent.com, which sends CORS
 * headers: `community-plugins.json` (7,600+ entries), the download stats, and
 * each plugin's HEAD `manifest.json` and `README.md`. Installing needs the
 * release assets, which do not — `app.plugins.installPlugin` tries the
 * companion extension, then the configured proxy, and otherwise fails with a
 * message this modal shows next to a link to the release and the "Install
 * from files" route.
 *
 * DOM (Obsidian's class names, which themes style):
 *
 *   .modal.mod-community-modal.mod-community-plugin.mod-sidebar-layout
 *     .modal-content
 *       .community-modal-sidebar
 *         .community-modal-controls   search, sort, "Show installed only", summary
 *         .community-modal-search-results-wrapper      (virtualised scroller)
 *           .community-modal-search-results > .community-item[.is-selected]
 *       .community-modal-details
 *         .community-modal-info       name, stats, buttons, description
 *         .community-modal-readme.markdown-rendered
 */
import type { PluginManifest } from "obsidian";
import type { App } from "../obsidian/app";
import {
  compareVersions,
  fetchCommunityPlugins,
  fetchPluginStats,
  fetchRaw,
  resolveInstallable,
  type CommunityPluginListing,
} from "../obsidian/app-internals/plugins";
import { Component } from "../obsidian/events";
import { MarkdownRenderer } from "../obsidian/markdown/renderer";
import { setIcon } from "../obsidian/ui/icons";
import { Modal } from "../obsidian/ui/modal";
import { Notice } from "../obsidian/ui/notice";
import { ButtonComponent, DropdownComponent, SearchComponent, ToggleComponent } from "../obsidian/ui/setting";
import { copyText, formatCount, formatDate, matchesAll, tokens } from "./helpers";
import { enableWithPrompt, fundingLink } from "./tabs/community-plugins";

type PluginSort = "download" | "update" | "release" | "alpha";

interface Entry {
  listing: CommunityPluginListing;
  index: number;
  downloads: number;
  updated: number;
  search: string;
}

const ROW_HEIGHT = 112;
const OVERSCAN = 6;

/** Rewrites a README's relative image and link targets to GitHub URLs. */
export function absolutiseReadme(markdown: string, repo: string): string {
  const raw = `https://raw.githubusercontent.com/${repo}/HEAD/`;
  const blob = `https://github.com/${repo}/blob/HEAD/`;
  const isRelative = (url: string) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url);
  const clean = (url: string) => url.replace(/^\.?\//, "");
  return markdown
    .replace(/(!\[[^\]]*\]\()\s*<?([^)\s>]+)>?/g, (m, pre: string, url: string) => (isRelative(url) ? `${pre}${raw}${clean(url)}` : m))
    .replace(/((?<!!)\[[^\]]*\]\()\s*<?([^)\s>]+)>?/g, (m, pre: string, url: string) => (isRelative(url) ? `${pre}${blob}${clean(url)}` : m))
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (m, pre: string, url: string, post: string) => (isRelative(url) ? `${pre}${raw}${clean(url)}${post}` : m));
}

export async function renderReadme(app: App, el: HTMLElement, repo: string, component: Component): Promise<void> {
  el.empty();
  el.createDiv({ cls: "vault-community-loading", text: "Loading README…" });
  let markdown: string;
  try {
    markdown = await fetchRaw(repo, "README.md");
  } catch {
    try {
      markdown = await fetchRaw(repo, "readme.md");
    } catch {
      el.empty();
      el.createDiv({ cls: "vault-empty-state", text: "This repository has no README." });
      return;
    }
  }
  el.empty();
  try {
    await MarkdownRenderer.render(app, absolutiseReadme(markdown, repo), el, "", component);
    for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      if (/^https?:/i.test(a.getAttribute("href") ?? "")) {
        a.setAttr("target", "_blank");
        a.setAttr("rel", "noopener");
      }
    }
    for (const img of Array.from(el.querySelectorAll("img"))) img.setAttr("referrerpolicy", "no-referrer");
  } catch (e) {
    console.error(e);
    el.createEl("pre", { cls: "vault-community-readme-raw", text: markdown });
  }
}

export class PluginBrowserModal extends Modal {
  private entries: Entry[] = [];
  private filtered: Entry[] = [];
  private query = "";
  private sort: PluginSort = "download";
  private installedOnly = false;
  private selected: Entry | null = null;
  private readmeComponent: Component | null = null;
  private detailSeq = 0;

  private summaryEl!: HTMLElement;
  private scrollerEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private detailsEl!: HTMLElement;
  private rendered = new Map<number, HTMLElement>();
  private rafPending = false;
  private offs: (() => void)[] = [];

  constructor(
    app: App,
    private initialId: string | null = null,
  ) {
    super(app);
    this.modalEl.addClasses(["mod-community-modal", "mod-community-plugin", "mod-sidebar-layout"]);
    this.scope.register(["Mod"], "f", () => {
      (this.modalEl.querySelector(".community-modal-controls input[type=search]") as HTMLInputElement | null)?.focus();
      return false;
    });
    this.scope.register([], "ArrowDown", (evt) => this.moveSelection(evt, 1));
    this.scope.register([], "ArrowUp", (evt) => this.moveSelection(evt, -1));
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const sidebar = contentEl.createDiv({ cls: "community-modal-sidebar" });
    const controls = sidebar.createDiv({ cls: "community-modal-controls" });
    const searchRow = controls.createDiv({ cls: "setting-item community-modal-search" });
    const search = new SearchComponent(searchRow).setPlaceholder("Search community plugins...");
    search.onChange((v) => {
      this.query = v;
      this.applyFilter();
    });
    const optionsRow = controls.createDiv({ cls: "community-modal-options" });
    const sortWrap = optionsRow.createDiv({ cls: "community-modal-sort" });
    sortWrap.createSpan({ cls: "community-modal-option-label", text: "Sort by" });
    new DropdownComponent(sortWrap)
      .addOptions({ download: "Most downloaded", update: "Recently updated", release: "Recently released", alpha: "Alphabetical" })
      .setValue(this.sort)
      .onChange((v) => {
        this.sort = v as PluginSort;
        this.applyFilter();
      });
    const installedWrap = optionsRow.createDiv({ cls: "community-modal-installed-only" });
    installedWrap.createSpan({ cls: "community-modal-option-label", text: "Show installed only" });
    new ToggleComponent(installedWrap).setValue(this.installedOnly).onChange((v) => {
      this.installedOnly = v;
      this.applyFilter();
    });
    this.summaryEl = controls.createDiv({ cls: "community-modal-search-summary", text: "Loading community plugins…" });
    this.scrollerEl = sidebar.createDiv({ cls: "community-modal-search-results-wrapper" });
    this.resultsEl = this.scrollerEl.createDiv({ cls: "community-modal-search-results" });
    this.scrollerEl.addEventListener("scroll", () => this.scheduleRender());
    const onResize = () => this.scheduleRender();
    window.addEventListener("resize", onResize);
    this.offs.push(() => window.removeEventListener("resize", onResize));
    this.detailsEl = contentEl.createDiv({ cls: "community-modal-details" });
    this.detailsEl.createDiv({ cls: "vault-empty-state", text: "Select a plugin to see its details." });

    for (const name of ["plugin-installed", "plugin-uninstalled", "plugin-loaded", "plugin-unloaded", "restricted-change", "updates-checked"]) {
      const ref = this.app.plugins.on(name, () => {
        this.refreshRows();
        if (this.selected) void this.renderDetails(this.selected, false);
      });
      this.offs.push(() => this.app.plugins.offref(ref));
    }
    window.setTimeout(() => search.inputEl.focus(), 0);

    try {
      const [list, stats] = await Promise.all([fetchCommunityPlugins(), fetchPluginStats().catch(() => ({}) as Record<string, { downloads: number; updated: number }>)]);
      this.entries = list.map((listing, index) => {
        const s = stats[listing.id];
        return {
          listing,
          index,
          downloads: s?.downloads ?? 0,
          updated: s?.updated ?? 0,
          search: `${listing.name} ${listing.author} ${listing.description} ${listing.id}`.toLowerCase(),
        };
      });
    } catch (e) {
      this.summaryEl.setText(`Could not load the plugin directory: ${(e as Error).message}. Check your connection and try again.`);
      this.summaryEl.addClass("mod-warning");
      return;
    }
    if (!this.isOpen) return;
    this.applyFilter();
    const initial = this.initialId ? this.entries.find((e) => e.listing.id === this.initialId) : null;
    if (initial) {
      this.select(initial);
      this.scrollToSelected();
    }
  }

  override onClose(): void {
    for (const off of this.offs.splice(0)) off();
    this.readmeComponent?.unload();
    this.readmeComponent = null;
    this.rendered.clear();
  }

  // ---- list --------------------------------------------------------------------------------

  private applyFilter() {
    const toks = tokens(this.query);
    const manifests = this.app.plugins.manifests;
    let list = this.entries.filter((e) => (!this.installedOnly || manifests[e.listing.id]) && matchesAll(e.search, toks));
    const byName = (a: Entry, b: Entry) => a.listing.name.localeCompare(b.listing.name);
    switch (this.sort) {
      case "download":
        list = list.sort((a, b) => b.downloads - a.downloads || byName(a, b));
        break;
      case "update":
        list = list.sort((a, b) => b.updated - a.updated || byName(a, b));
        break;
      case "release":
        // The directory is append-only: a later index was submitted later.
        list = list.sort((a, b) => b.index - a.index);
        break;
      case "alpha":
        list = list.sort(byName);
        break;
    }
    this.filtered = list;
    this.summaryEl.removeClass("mod-warning");
    this.summaryEl.setText(`Showing ${list.length.toLocaleString()} plugin${list.length === 1 ? "" : "s"}${toks.length || this.installedOnly ? ` of ${this.entries.length.toLocaleString()}` : ""}:`);
    this.resultsEl.style.height = `${list.length * ROW_HEIGHT}px`;
    this.resultsEl.empty();
    this.rendered.clear();
    this.scrollerEl.scrollTop = 0;
    this.renderVisible();
  }

  private scheduleRender() {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.renderVisible();
    });
  }

  private renderVisible() {
    if (!this.isOpen) return;
    const top = this.scrollerEl.scrollTop;
    const height = this.scrollerEl.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(this.filtered.length - 1, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    for (const [i, el] of this.rendered) {
      if (i < first || i > last) {
        el.remove();
        this.rendered.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (this.rendered.has(i)) continue;
      const entry = this.filtered[i];
      if (!entry) continue;
      const el = this.createItem(entry);
      el.style.top = `${i * ROW_HEIGHT}px`;
      this.resultsEl.appendChild(el);
      this.rendered.set(i, el);
    }
  }

  private refreshRows() {
    for (const [i, el] of this.rendered) {
      const entry = this.filtered[i];
      if (!entry) continue;
      const fresh = this.createItem(entry);
      fresh.style.top = el.style.top;
      el.replaceWith(fresh);
      this.rendered.set(i, fresh);
    }
  }

  private createItem(entry: Entry): HTMLElement {
    const { listing } = entry;
    const plugins = this.app.plugins;
    const installed = plugins.manifests[listing.id];
    const el = createDiv({ cls: "community-item", attr: { "data-plugin-id": listing.id, role: "option", tabindex: -1 } });
    el.toggleClass("is-selected", this.selected?.listing.id === listing.id);
    const nameEl = el.createDiv({ cls: "community-item-name", text: listing.name });
    if (installed) {
      const flair = plugins.updates[listing.id] ? "Update" : plugins.enabledPlugins.has(listing.id) ? "Enabled" : "Installed";
      nameEl.createSpan({ cls: `flair${flair === "Update" ? " mod-pop" : ""}`, text: flair });
    }
    el.createDiv({ cls: "community-item-author", text: `By ${listing.author}` });
    const stats = el.createDiv({ cls: "community-item-stats" });
    if (entry.downloads) {
      const dl = stats.createSpan({ cls: "community-item-downloads" });
      setIcon(dl.createSpan({ cls: "community-item-downloads-icon" }), "lucide-download");
      dl.createSpan({ cls: "community-item-downloads-text", text: formatCount(entry.downloads) });
    }
    if (entry.updated) stats.createSpan({ cls: "community-item-updated", text: `Updated ${formatDate(entry.updated)}` });
    el.createDiv({ cls: "community-item-desc", text: listing.description.replace(/\s*This plugin has not been manually reviewed by Obsidian staff\.\s*$/, "") });
    el.addEventListener("click", () => this.select(entry));
    return el;
  }

  private select(entry: Entry) {
    this.selected = entry;
    for (const el of Array.from(this.resultsEl.querySelectorAll(".community-item.is-selected"))) el.removeClass("is-selected");
    this.resultsEl.querySelector(`.community-item[data-plugin-id="${CSS.escape(entry.listing.id)}"]`)?.addClass("is-selected");
    void this.renderDetails(entry, true);
  }

  private scrollToSelected() {
    const i = this.filtered.findIndex((e) => e === this.selected);
    if (i < 0) return;
    const top = i * ROW_HEIGHT;
    const view = this.scrollerEl;
    if (top < view.scrollTop || top + ROW_HEIGHT > view.scrollTop + view.clientHeight) view.scrollTop = Math.max(0, top - view.clientHeight / 2);
    this.renderVisible();
  }

  private moveSelection(evt: KeyboardEvent, delta: number): false | undefined {
    const target = evt.target as HTMLElement | null;
    if (target && target.closest(".community-modal-details")) return undefined;
    if (target instanceof HTMLSelectElement) return undefined;
    if (!this.filtered.length) return undefined;
    const i = this.selected ? this.filtered.indexOf(this.selected) : -1;
    const next = this.filtered[Math.max(0, Math.min(this.filtered.length - 1, i + delta))];
    if (next) {
      this.select(next);
      this.scrollToSelected();
    }
    return false;
  }

  // ---- details ---------------------------------------------------------------------------

  private async renderDetails(entry: Entry, reloadReadme: boolean) {
    const seq = ++this.detailSeq;
    const { listing } = entry;
    const app = this.app;
    const plugins = app.plugins;
    const el = this.detailsEl;
    let readmeEl = el.querySelector<HTMLElement>(".community-modal-readme");
    const keepReadme = !reloadReadme && readmeEl && el.getAttr("data-plugin-id") === listing.id;
    if (!keepReadme) {
      el.empty();
      el.setAttr("data-plugin-id", listing.id);
      el.scrollTop = 0;
    } else {
      el.querySelector(".community-modal-info")?.remove();
    }
    const info = createDiv({ cls: "community-modal-info" });
    el.prepend(info);
    info.createDiv({ cls: "community-modal-info-name", text: listing.name });
    const meta = info.createDiv({ cls: "community-modal-info-meta" });
    const versionEl = meta.createDiv({ cls: "community-modal-info-version", text: "Version …" });
    if (entry.downloads) meta.createDiv({ cls: "community-modal-info-downloads", text: `${entry.downloads.toLocaleString()} downloads` });
    if (entry.updated) meta.createDiv({ cls: "community-modal-info-updated", text: `Updated ${formatDate(entry.updated)}` });
    const authorEl = info.createDiv({ cls: "community-modal-info-author" });
    authorEl.appendText("By ");
    authorEl.createSpan({ text: listing.author });
    const links = info.createDiv({ cls: "community-modal-info-repo" });
    links.appendText("Repository: ");
    links.createEl("a", { text: listing.repo, href: `https://github.com/${listing.repo}`, attr: { target: "_blank", rel: "noopener" } });
    const badges = info.createDiv({ cls: "community-modal-info-badges" });
    const buttons = info.createDiv({ cls: "community-modal-button-container" });
    const errorEl = info.createDiv({ cls: "vault-community-error" });
    errorEl.hide();
    info.createDiv({ cls: "community-modal-info-desc", text: listing.description });

    if (!keepReadme) {
      readmeEl = el.createDiv({ cls: "community-modal-readme markdown-rendered markdown-preview-view" });
      this.readmeComponent?.unload();
      this.readmeComponent = new Component();
      this.readmeComponent.load();
      void renderReadme(app, readmeEl, listing.repo, this.readmeComponent);
    }

    let remote: { version: string; manifest: PluginManifest } | null = null;
    let remoteError: string | null = null;
    try {
      remote = await resolveInstallable(listing.repo);
    } catch (e) {
      remoteError = (e as Error).message;
    }
    if (seq !== this.detailSeq || !this.isOpen) return;

    const installed = plugins.manifests[listing.id];
    const enabled = plugins.enabledPlugins.has(listing.id) && !!plugins.plugins[listing.id];
    versionEl.setText(installed ? `Installed ${installed.version}${remote && compareVersions(remote.version, installed.version) > 0 ? ` · ${remote.version} available` : ""}` : remote ? `Version ${remote.version}` : "Version unknown");
    const manifest = remote?.manifest ?? installed ?? null;
    if (manifest?.authorUrl) {
      authorEl.empty();
      authorEl.appendText("By ");
      authorEl.createEl("a", { text: listing.author, href: manifest.authorUrl, attr: { target: "_blank", rel: "noopener" } });
    }
    const desktopOnly = !!manifest?.isDesktopOnly;
    if (desktopOnly) badges.createSpan({ cls: "flair mod-warning vault-desktop-only", text: "Desktop only" });
    if (remote && remote.manifest.minAppVersion) badges.createSpan({ cls: "flair", text: `Requires ${remote.manifest.minAppVersion}+` });

    const showError = (message: string) => {
      errorEl.empty();
      errorEl.show();
      errorEl.createDiv({ cls: "vault-community-error-message", text: message });
      const help = errorEl.createDiv({ cls: "vault-community-error-help" });
      if (remote) {
        help.appendText("You can download the release files yourself from ");
        help.createEl("a", { text: `${listing.repo} ${remote.version}`, href: `https://github.com/${listing.repo}/releases/tag/${remote.version}`, attr: { target: "_blank", rel: "noopener" } });
        help.appendText(" and use Install from files in Settings → Community plugins, or set a plugin download proxy there.");
      }
      new ButtonComponent(errorEl).setButtonText("Open community plugin settings").onClick(() => {
        this.close();
        app.setting.open();
        app.setting.openTabById("community-plugins");
      });
    };

    if (desktopOnly && !installed) {
      new ButtonComponent(buttons).setButtonText("Install").setDisabled(true);
      buttons.createDiv({ cls: "community-modal-button-note mod-warning", text: "This plugin does not support your device." });
    } else if (!installed) {
      new ButtonComponent(buttons)
        .setButtonText("Install")
        .setCta()
        .setDisabled(!remote)
        .onClick(async (evt) => {
          const btn = evt.currentTarget as HTMLButtonElement;
          if (!remote) return;
          btn.disabled = true;
          btn.setText("Installing…");
          try {
            await plugins.installPlugin(listing.repo, remote.version, remote.manifest);
            new Notice(`Installed "${listing.name}".`);
          } catch (e) {
            btn.disabled = false;
            btn.setText("Install");
            showError((e as Error).message);
            return;
          }
          if (seq === this.detailSeq) void this.renderDetails(entry, false);
        });
    } else {
      if (enabled) {
        new ButtonComponent(buttons).setButtonText("Disable").onClick(async () => {
          await plugins.disablePluginAndSave(listing.id);
          app.setting?.updatePluginSection?.();
          void this.renderDetails(entry, false);
        });
      } else {
        new ButtonComponent(buttons)
          .setButtonText("Enable")
          .setCta()
          .setDisabled(!!plugins.canRun(installed))
          .onClick(async () => {
            await enableWithPrompt(app, listing.id);
            app.setting?.updatePluginSection?.();
            void this.renderDetails(entry, false);
          });
      }
      if (remote && compareVersions(remote.version, installed.version) > 0) {
        new ButtonComponent(buttons)
          .setButtonText("Update")
          .setCta()
          .onClick(async (evt) => {
            const btn = evt.currentTarget as HTMLButtonElement;
            btn.disabled = true;
            btn.setText("Updating…");
            try {
              await plugins.installPlugin(listing.repo, remote!.version, remote!.manifest);
              new Notice(`Updated "${listing.name}" to ${remote!.version}.`);
            } catch (e) {
              btn.disabled = false;
              btn.setText("Update");
              showError((e as Error).message);
              return;
            }
            void this.renderDetails(entry, false);
          });
      }
      const tab = enabled ? app.setting?.pluginTabs.find((t: { id: string }) => t.id === listing.id) : null;
      if (tab) {
        new ButtonComponent(buttons).setButtonText("Options").onClick(() => {
          this.close();
          app.setting.open();
          app.setting.openTab(tab);
        });
      }
      if (enabled) {
        new ButtonComponent(buttons).setButtonText("Hotkeys").onClick(async () => {
          this.close();
          const { openHotkeysFor } = await import("./tabs/community-plugins");
          openHotkeysFor(app, listing.name, listing.id);
        });
      }
      new ButtonComponent(buttons)
        .setButtonText("Uninstall")
        .setWarning()
        .onClick(async () => {
          await plugins.uninstallPlugin(listing.id);
          new Notice(`Uninstalled "${listing.name}".`);
          app.setting?.updatePluginSection?.();
          void this.renderDetails(entry, false);
        });
    }
    const funding = fundingLink(manifest);
    if (funding) {
      new ButtonComponent(buttons).setButtonText("Donate").onClick(() => window.open(funding, "_blank", "noopener"));
    }
    new ButtonComponent(buttons)
      .setIcon("lucide-link")
      .setTooltip("Copy share link")
      .onClick(async () => {
        const ok = await copyText(`obsidian://show-plugin?id=${encodeURIComponent(listing.id)}`);
        new Notice(ok ? "Link copied." : "Could not copy the link.");
      });
    if (remoteError && !installed) {
      showError(`Could not read this plugin's manifest from GitHub: ${remoteError}`);
    }
  }
}
