/**
 * app.setting — the Settings window.
 *
 * DOM (Obsidian's class names; themes and plugin CSS target them):
 *
 *   .modal-container > .modal.mod-settings.mod-sidebar-layout
 *     .modal-close-button
 *     .modal-content
 *       .vertical-tab-header                                 (tabHeadersEl)
 *         .vault-settings-search > .search-input-container
 *         .vertical-tab-header-group                         Options / Core plugins / Community plugins
 *           .vertical-tab-header-group-title
 *           .vertical-tab-header-group-items
 *             .vertical-tab-nav-item[.is-active]             (tab.navEl)
 *               .vertical-tab-nav-item-icon
 *               .vertical-tab-nav-item-title
 *       .vertical-tab-content-container                      (tabContentContainer)
 *         .vertical-tab-content                              (tab.containerEl)
 *
 * The internal API is the one plugins call: `open()`, `close()`,
 * `openTabById(id)`, `openTab(tab)`, `activeTab`, `addSettingTab(tab)`,
 * `removeSettingTab(tab)`, `pluginTabs`, `settingTabs`, `lastTabId`,
 * `tabContentContainer`, `tabHeadersEl`.
 *
 * Search renders every searchable tab (the built-in ones, core plugin tabs, and
 * tabs that use the declarative settings API) stacked in the content area and
 * hides the rows whose name and description do not match, so the controls
 * that remain are the live ones.
 */
import type { App } from "../obsidian/app";
import { setIcon } from "../obsidian/ui/icons";
import { Modal } from "../obsidian/ui/modal";
import { SearchComponent } from "../obsidian/ui/setting";
import type { SettingTab } from "../obsidian/ui/setting-tab";
import { matchesAll, tokens } from "./helpers";

const TAB_ALIASES: Record<string, string> = { about: "general", "files-and-links": "file", "core-plugins": "plugins" };
const HIDDEN = "vault-search-hidden";

interface SearchSection {
  tab: SettingTab;
  sectionEl: HTMLElement;
}

export class AppSetting extends Modal {
  // internal (used by plugins: the built-in tabs)
  settingTabs: SettingTab[] = [];
  // internal (used by plugins: every tab added through Plugin.addSettingTab)
  pluginTabs: SettingTab[] = [];
  // internal (used by plugins: `app.setting.activeTab.containerEl`)
  activeTab: SettingTab | null = null;
  // internal
  lastTabId = "general";
  // internal
  tabHeadersEl: HTMLElement;
  // internal: the Options group's items
  tabContainer: HTMLElement;
  // internal
  tabContentContainer: HTMLElement;
  // internal
  corePluginTabHeaderGroup: HTMLElement;
  // internal
  corePluginTabContainer: HTMLElement;
  // internal
  communityPluginTabHeaderGroup: HTMLElement;
  // internal
  communityPluginTabContainer: HTMLElement;
  // internal
  searchComponent: SearchComponent;
  private searchSections: SearchSection[] | null = null;
  private searchEmptyEl: HTMLElement | null = null;

  constructor(app: App) {
    super(app);
    this.modalEl.addClasses(["mod-settings", "mod-sidebar-layout"]);
    this.tabHeadersEl = this.contentEl.createDiv({ cls: "vertical-tab-header" });
    const searchEl = this.tabHeadersEl.createDiv({ cls: "vault-settings-search" });
    this.searchComponent = new SearchComponent(searchEl).setPlaceholder("Search settings...");
    this.searchComponent.onChange((q) => this.onSearch(q));

    const makeGroup = (title: string) => {
      const groupEl = this.tabHeadersEl.createDiv({ cls: "vertical-tab-header-group" });
      groupEl.createDiv({ cls: "vertical-tab-header-group-title", text: title });
      const itemsEl = groupEl.createDiv({ cls: "vertical-tab-header-group-items" });
      return { groupEl, itemsEl };
    };
    this.tabContainer = makeGroup("Options").itemsEl;
    const core = makeGroup("Core plugins");
    this.corePluginTabHeaderGroup = core.groupEl;
    this.corePluginTabContainer = core.itemsEl;
    const community = makeGroup("Community plugins");
    this.communityPluginTabHeaderGroup = community.groupEl;
    this.communityPluginTabContainer = community.itemsEl;
    this.tabContentContainer = this.contentEl.createDiv({ cls: "vertical-tab-content-container" });

    this.scope.register(["Mod"], "f", () => {
      this.searchComponent.inputEl.focus();
      this.searchComponent.inputEl.select();
      return false;
    });
    this.scope.register([], "ArrowDown", (evt) => this.moveNav(evt, 1));
    this.scope.register([], "ArrowUp", (evt) => this.moveNav(evt, -1));
    this.scope.register([], "Enter", (evt) => {
      const target = evt.target as HTMLElement | null;
      if (target === this.searchComponent.inputEl) {
        const first = this.visibleNavItems()[0];
        first?.click();
        return false;
      }
      return undefined;
    });
  }

  // ---- lifecycle ---------------------------------------------------------------------

  override onOpen(): void {
    this.renderNav();
    const tab = this.findTab(this.lastTabId) ?? this.settingTabs[0] ?? null;
    if (tab) this.openTab(tab);
  }

  override onClose(): void {
    if (this.searchSections) this.exitSearch(false);
    this.searchComponent.setValue("");
    const last = this.activeTab?.id;
    this.closeActiveTab();
    if (last) this.lastTabId = last;
  }

  // ---- tabs ------------------------------------------------------------------------------

  // internal
  addBuiltinTab(tab: SettingTab): void {
    this.settingTabs.push(tab);
    if (this.isOpen) this.renderNav();
  }

  addSettingTab(tab: SettingTab): void {
    if (!tab || this.pluginTabs.includes(tab)) return;
    const withPlugin = tab as SettingTab & { plugin?: { manifest?: { id?: string; name?: string } } };
    if (!tab.id) tab.id = withPlugin.plugin?.manifest?.id ?? `tab-${this.pluginTabs.length}`;
    if (!tab.name) tab.name = withPlugin.plugin?.manifest?.name ?? tab.id;
    this.pluginTabs.push(tab);
    if (this.isOpen) this.updatePluginSection();
  }

  removeSettingTab(tab: SettingTab): void {
    const i = this.pluginTabs.indexOf(tab);
    if (i === -1) return;
    const wasActive = this.activeTab === tab;
    if (this.searchSections) this.exitSearch(false);
    if (wasActive) this.closeActiveTab();
    this.pluginTabs.splice(i, 1);
    tab.navEl?.detach();
    tab.navEl = null;
    if (this.isOpen) {
      this.updatePluginSection();
      if (wasActive || !this.activeTab) {
        const next = this.findTab("community-plugins") ?? this.settingTabs[0];
        if (next) this.openTab(next);
      }
    }
  }

  // internal
  isPluginSettingTab(tab: SettingTab): boolean {
    return this.pluginTabs.includes(tab);
  }

  // internal: a tab of one of Obsidian's core plugins (listed under "Core plugins")
  isCoreTab(tab: SettingTab): boolean {
    if (this.isPreinstalledTab(tab)) return false;
    const plugin = (tab as SettingTab & { plugin?: { isCorePlugin?: boolean } }).plugin;
    if (plugin?.isCorePlugin) return true;
    return !!this.app.internalPlugins.plugins[tab.id] && !this.app.plugins.manifests[tab.id];
  }

  // internal: a tab of an OpenMarkdown pre-installed plugin (listed under "Community plugins")
  isPreinstalledTab(tab: SettingTab): boolean {
    const plugin = (tab as SettingTab & { plugin?: { isCorePlugin?: boolean; manifest?: { id?: string } } }).plugin;
    const internal = this.app.internalPlugins as { isPreinstalled?: (id: string) => boolean };
    if (!internal.isPreinstalled) return false;
    if (plugin?.isCorePlugin && plugin.manifest?.id) return internal.isPreinstalled(plugin.manifest.id);
    return !plugin && internal.isPreinstalled(tab.id) && !this.app.plugins.manifests[tab.id];
  }

  // internal
  findTab(id: string): SettingTab | null {
    const want = TAB_ALIASES[id] ?? id;
    return this.settingTabs.find((t) => t.id === want) ?? this.pluginTabs.find((t) => t.id === want) ?? null;
  }

  openTabById(id: string): SettingTab | null {
    const tab = this.findTab(id);
    if (!tab) return null;
    if (this.isOpen) this.openTab(tab);
    else this.lastTabId = tab.id;
    return tab;
  }

  openTab(tab: SettingTab): void {
    if (this.searchSections) {
      this.exitSearch(false);
      this.searchComponent.setValue("");
    }
    if (this.activeTab === tab && tab.containerEl.parentElement === this.tabContentContainer) return;
    this.closeActiveTab();
    this.activeTab = tab;
    this.lastTabId = tab.id;
    tab.navEl?.addClass("is-active");
    tab.navEl?.scrollIntoView({ block: "nearest" });
    this.tabContentContainer.appendChild(tab.containerEl);
    this.showTabContent(tab);
    this.tabContentContainer.scrollTop = 0;
  }

  // internal
  closeActiveTab(): void {
    const tab = this.activeTab;
    if (!tab) return;
    this.activeTab = null;
    tab.navEl?.removeClass("is-active");
    this.hideTabContent(tab);
  }

  private showTabContent(tab: SettingTab) {
    try {
      const t = tab as SettingTab & { showTab?: () => void };
      if (typeof t.showTab === "function") t.showTab();
      else tab.display();
    } catch (e) {
      console.error(`Settings tab "${tab.id}" failed to display`, e);
    }
  }

  private hideTabContent(tab: SettingTab) {
    try {
      const t = tab as SettingTab & { hideTab?: () => void };
      if (typeof t.hideTab === "function") t.hideTab();
      else tab.hide();
    } catch (e) {
      console.error(e);
    }
    // Obsidian's default hide() empties the container; plugins rely on it.
    tab.containerEl.empty();
    tab.containerEl.detach();
  }

  // ---- navigation --------------------------------------------------------------------------

  private renderNav() {
    this.tabContainer.empty();
    for (const tab of this.settingTabs) this.createNavItem(tab, this.tabContainer);
    this.updatePluginSection();
  }

  // internal
  updatePluginSection(): void {
    this.corePluginTabContainer.empty();
    this.communityPluginTabContainer.empty();
    const byName = (a: SettingTab, b: SettingTab) => a.name.localeCompare(b.name);
    const core = this.pluginTabs.filter((t) => this.isCoreTab(t)).sort(byName);
    const community = this.pluginTabs.filter((t) => !this.isCoreTab(t)).sort(byName);
    for (const tab of core) this.createNavItem(tab, this.corePluginTabContainer);
    for (const tab of community) this.createNavItem(tab, this.communityPluginTabContainer);
    this.corePluginTabHeaderGroup.toggle(core.length > 0);
    this.communityPluginTabHeaderGroup.toggle(community.length > 0);
    if (this.searchSections) this.applySearch();
  }

  private createNavItem(tab: SettingTab, parent: HTMLElement) {
    const el = parent.createDiv({ cls: "vertical-tab-nav-item tappable", attr: { tabindex: 0, "data-setting-id": tab.id } });
    const iconEl = el.createDiv({ cls: "vertical-tab-nav-item-icon" });
    setIcon(iconEl, tab.icon || "lucide-settings");
    el.createDiv({ cls: "vertical-tab-nav-item-title", text: tab.name });
    el.addEventListener("click", () => this.openTab(tab));
    el.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        this.openTab(tab);
      }
    });
    el.toggleClass("is-active", this.activeTab === tab);
    tab.navEl = el;
  }

  private visibleNavItems(): HTMLElement[] {
    return Array.from(this.tabHeadersEl.querySelectorAll<HTMLElement>(".vertical-tab-nav-item")).filter((el) => !el.hasClass(HIDDEN) && el.offsetParent !== null);
  }

  private moveNav(evt: KeyboardEvent, delta: number): false | undefined {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.tabHeadersEl.contains(active)) return undefined;
    const items = this.visibleNavItems();
    if (!items.length) return false;
    let i = items.indexOf(active);
    if (i === -1) i = items.findIndex((el) => el.hasClass("is-active"));
    const next = items[Math.max(0, Math.min(items.length - 1, i + delta))];
    if (next) {
      next.focus();
      next.click();
    }
    evt.preventDefault();
    return false;
  }

  // ---- search ---------------------------------------------------------------------------

  private onSearch(query: string) {
    if (!tokens(query).length) {
      if (this.searchSections) this.exitSearch(true);
      return;
    }
    if (!this.searchSections) this.enterSearch();
    this.applySearch();
  }

  private searchableTabs(): SettingTab[] {
    const out = this.settingTabs.slice();
    for (const tab of this.pluginTabs) {
      if (this.isCoreTab(tab) || this.isPreinstalledTab(tab)) {
        out.push(tab);
        continue;
      }
      try {
        if ((tab.getSettingDefinitions?.() ?? []).length > 0) out.push(tab);
      } catch {
        /* a broken definitions getter is not searchable */
      }
    }
    return out;
  }

  private enterSearch() {
    const current = this.activeTab;
    this.closeActiveTab();
    if (current) this.lastTabId = current.id;
    this.modalEl.addClass("is-searching");
    const sections: SearchSection[] = [];
    for (const tab of this.searchableTabs()) {
      const sectionEl = this.tabContentContainer.createDiv({ cls: "vault-settings-search-section" });
      const titleEl = sectionEl.createDiv({ cls: "vault-settings-search-section-title", attr: { role: "button", tabindex: 0 } });
      setIcon(titleEl.createSpan({ cls: "vault-settings-search-section-icon" }), tab.icon || "lucide-settings");
      titleEl.createSpan({ text: tab.name });
      titleEl.addEventListener("click", () => this.openTab(tab));
      sectionEl.appendChild(tab.containerEl);
      this.showTabContent(tab);
      sections.push({ tab, sectionEl });
    }
    this.searchSections = sections;
    this.searchEmptyEl = this.tabContentContainer.createDiv({ cls: "vault-settings-search-empty", text: "No settings match your search." });
  }

  private exitSearch(restore: boolean) {
    const sections = this.searchSections ?? [];
    this.searchSections = null;
    for (const { tab, sectionEl } of sections) {
      this.hideTabContent(tab);
      sectionEl.remove();
    }
    this.searchEmptyEl?.remove();
    this.searchEmptyEl = null;
    this.modalEl.removeClass("is-searching");
    for (const el of Array.from(this.tabHeadersEl.querySelectorAll<HTMLElement>(`.${HIDDEN}`))) el.removeClass(HIDDEN);
    if (restore && this.isOpen) {
      const tab = this.findTab(this.lastTabId) ?? this.settingTabs[0];
      if (tab) this.openTab(tab);
    }
  }

  /** internal: filter the rendered rows by the current query (tabs call this after re-rendering). */
  applySearch(): void {
    const sections = this.searchSections;
    if (!sections) return;
    const toks = tokens(this.searchComponent.getValue());
    let total = 0;
    const searched = new Set<SettingTab>();
    for (const { tab, sectionEl } of sections) {
      searched.add(tab);
      const n = filterRows(tab.containerEl, toks);
      total += n;
      sectionEl.toggleClass(HIDDEN, n === 0);
      tab.navEl?.toggleClass(HIDDEN, n === 0 && !matchesAll(tab.name, toks));
    }
    for (const tab of this.pluginTabs) {
      if (!searched.has(tab)) tab.navEl?.toggleClass(HIDDEN, !matchesAll(tab.name, toks));
    }
    for (const group of [this.tabContainer, this.corePluginTabContainer, this.communityPluginTabContainer]) {
      const groupEl = group.parentElement;
      const anyVisible = Array.from(group.children).some((el) => !el.hasClass(HIDDEN));
      groupEl?.toggleClass(HIDDEN, !anyVisible);
    }
    this.searchEmptyEl?.toggle(total === 0);
  }
}

/** Hides non-matching `.setting-item`s under `root`; returns how many rows match. */
export function filterRows(root: HTMLElement, toks: string[]): number {
  const all = Array.from(root.querySelectorAll<HTMLElement>(".setting-item"));
  let count = 0;
  for (const item of all) {
    if (item.hasClass("setting-item-heading")) continue;
    const name = item.querySelector(":scope > .setting-item-info > .setting-item-name")?.textContent ?? "";
    const desc = item.querySelector(":scope > .setting-item-info > .setting-item-description")?.textContent ?? "";
    const match = matchesAll(`${name} ${desc}`, toks);
    item.toggleClass(HIDDEN, !match);
    if (match) count++;
  }
  const visibleRow = `.setting-item:not(.setting-item-heading):not(.${HIDDEN})`;
  for (const heading of all.filter((el) => el.hasClass("setting-item-heading"))) {
    const group = heading.parentElement;
    if (group?.hasClass("setting-group")) {
      heading.toggleClass(HIDDEN, !group.querySelector(visibleRow));
      continue;
    }
    // A loose heading owns the rows after it, up to the next heading.
    let any = false;
    for (let el = heading.nextElementSibling; el && !el.hasClass("setting-item-heading"); el = el.nextElementSibling) {
      if ((el.matches(visibleRow) || el.querySelector(visibleRow)) && !el.hasClass(HIDDEN)) {
        any = true;
        break;
      }
    }
    heading.toggleClass(HIDDEN, !any);
  }
  for (const group of Array.from(root.querySelectorAll<HTMLElement>(".setting-group"))) {
    group.toggleClass(HIDDEN, !group.querySelector(visibleRow));
  }
  for (const child of Array.from(root.children) as HTMLElement[]) {
    if (child.hasClass("setting-item") || child.hasClass("setting-group")) continue;
    child.toggleClass(HIDDEN, !(child.matches(visibleRow) || child.querySelector(visibleRow)));
  }
  return count;
}
