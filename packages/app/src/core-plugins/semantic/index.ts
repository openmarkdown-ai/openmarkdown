/**
 * Core plugin Related notes (`semantic`): a semantic index of the vault, the
 * Related notes view, and search by meaning in the Search view.
 *
 * Off by default. Does nothing until AI is on and "related" has an embedding
 * engine (`app.ai.isAvailable("related", "embed")`), and steps aside while
 * the Smart Connections community plugin is enabled.
 *
 * Instance API (for Chat with vault and plugins):
 *   instance.search(text, { k, kind, excludePaths, onlyPaths }) → PassageHit[]
 *   instance.passageText(keys) → Map<key, text>
 *   instance.getStatus() → IndexStatus
 *   instance.index (internal) → SemanticIndex
 */
import { Plugin } from "../../obsidian/plugin";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import type { TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { GlobalSearchView, searchViewExtensions, VIEW_TYPE_SEARCH } from "../global-search/search-view";
import { getAi, SemanticIndex, type IndexStatus } from "./engine";
import { engineLabel, RelatedNotesView, statusText, VIEW_TYPE_RELATED } from "./related-view";
import { SearchByMeaning } from "./search-meaning";

export interface SemanticPluginOptions {
  excludeFolders: string[];
  respectExcludedFiles: boolean;
  relatedMode: "note" | "paragraph";
  showScores: boolean;
  relatedLimit: number;
}

export const SEMANTIC_DEFAULTS: SemanticPluginOptions = {
  excludeFolders: [],
  respectExcludedFiles: true,
  relatedMode: "note",
  showScores: true,
  relatedLimit: 12,
};

/** Community plugins that do this job; while one is enabled, the built-in index steps aside. */
export const SEMANTIC_REPLACED_PLUGINS = ["smart-connections"];

export class SemanticPlugin extends Plugin {
  instance!: any;
  index!: SemanticIndex;
  private searchExt!: SearchByMeaning;
  private statusEl: HTMLElement | null = null;
  private asideWas = false;

  get options(): SemanticPluginOptions {
    const o = this.instance.options as Partial<SemanticPluginOptions>;
    for (const [k, v] of Object.entries(SEMANTIC_DEFAULTS)) if ((o as Record<string, unknown>)[k] === undefined) (o as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
    return o as SemanticPluginOptions;
  }

  saveOptions() {
    void this.instance.saveOptions?.();
  }

  steppedAside(): boolean {
    const enabled: Set<string> | undefined = this.app.plugins?.enabledPlugins;
    return !!enabled && SEMANTIC_REPLACED_PLUGINS.some((id) => enabled.has(id));
  }

  openAiSettings() {
    this.app.setting?.open?.();
    this.app.setting?.openTabById?.("ai");
  }

  override async onload() {
    this.index = new SemanticIndex(this.app, () => this.options, () => !this.steppedAside());
    this.asideWas = this.steppedAside();
    this.registerView(VIEW_TYPE_RELATED, (leaf: WorkspaceLeaf) => new RelatedNotesView(leaf, this));

    this.addCommand({
      id: "semantic:open-related",
      name: "Related notes: Show related notes",
      icon: "lucide-waypoints",
      callback: () => void this.openRelated(),
    });
    this.addCommand({
      id: "semantic:search-by-meaning",
      name: "Related notes: Search by meaning",
      icon: "lucide-sparkles",
      callback: () => void this.openSearchByMeaning(),
    });
    this.addCommand({
      id: "semantic:toggle-indexing",
      name: "Related notes: Pause or resume indexing",
      icon: "lucide-pause",
      checkCallback: (checking) => {
        const s = this.index.getStatus();
        if (!this.index.isPaused() && s.state !== "indexing") return false;
        if (!checking) this.togglePause();
        return true;
      },
    });
    this.addCommand({
      id: "semantic:rebuild-index",
      name: "Related notes: Rebuild the index",
      icon: "lucide-refresh-cw",
      checkCallback: (checking) => {
        if (!this.index.isAvailable()) return false;
        if (!checking) void this.index.rebuild();
        return true;
      },
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("semantic-status-bar", "mod-clickable");
    this.statusEl.hide();
    this.registerDomEvent(this.statusEl, "click", () => this.togglePause());
    this.registerEvent(this.index.on("status", (s: IndexStatus) => this.renderStatusBar(s)));

    const vault = this.app.vault;
    this.registerEvent(vault.on("create", (f: TAbstractFile) => this.index.onCreate(f)));
    this.registerEvent(vault.on("modify", (f: TAbstractFile) => this.index.onModify(f)));
    this.registerEvent(vault.on("delete", (f: TAbstractFile) => this.index.onDelete(f)));
    this.registerEvent(vault.on("rename", (f: TAbstractFile, old: string) => this.index.onRename(f, old)));

    this.searchExt = new SearchByMeaning(this.app, this.index, () => this.options.showScores, () => this.steppedAside());
    searchViewExtensions.add(this.searchExt);
    for (const view of this.searchViews()) this.searchExt.attach(view);
    this.registerEvent(this.index.on("updated", () => this.searchExt.refreshAll(this.searchViews())));

    const ai = getAi(this.app);
    if (ai) {
      const ref = ai.on("change", () => {
        void this.index.start();
        this.searchExt.refreshAll(this.searchViews());
      });
      this.register(() => ai.offref(ref));
    }
    // Smart Connections can be switched on or off at any time.
    this.registerInterval(
      window.setInterval(() => {
        const aside = this.steppedAside();
        if (aside === this.asideWas) return;
        this.asideWas = aside;
        void this.index.start({ askConsent: false });
        this.searchExt.refreshAll(this.searchViews());
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RELATED)) void (leaf.view as RelatedNotesView).update?.();
      }, 3000),
    );

    this.addSettingTab(new SemanticSettingTab(this.app, this));

    this.instance.index = this.index;
    this.instance.search = (text: string, opts?: Parameters<SemanticIndex["searchText"]>[1]) => this.index.searchText(text, opts);
    this.instance.passageText = (keys: number[]) => this.index.passageText(keys);
    this.instance.getStatus = () => this.index.getStatus();
    this.instance.searchByMeaning = this.searchExt;

    this.app.workspace.onLayoutReady(() => {
      this.app.metadataCache.onInitialized?.(() => void this.index.start());
    });
  }

  override onunload() {
    searchViewExtensions.delete(this.searchExt);
    for (const view of this.searchViews()) this.searchExt.detach(view);
    this.index.destroy();
    for (const k of ["index", "search", "passageText", "getStatus", "searchByMeaning"]) delete this.instance[k];
  }

  private searchViews(): GlobalSearchView[] {
    return (this.app.workspace.getLeavesOfType(VIEW_TYPE_SEARCH) as WorkspaceLeaf[]).map((l) => l.view).filter((v): v is GlobalSearchView => v instanceof GlobalSearchView);
  }

  private togglePause() {
    if (this.index.isPaused()) this.index.resume();
    else this.index.pause();
  }

  private renderStatusBar(s: IndexStatus) {
    const el = this.statusEl;
    if (!el) return;
    const show = s.state === "indexing" || s.state === "paused" || s.state === "error";
    el.toggle(show);
    if (!show) return;
    el.setText(s.state === "indexing" && s.total ? `Indexing ${Math.min(s.done, s.total).toLocaleString()}/${s.total.toLocaleString()}` : s.state === "paused" ? "Indexing paused" : s.state === "error" ? "Indexing stopped" : "Indexing…");
    el.setAttr("aria-label", `${statusText(s)}${s.state === "indexing" ? " — click to pause" : s.state === "paused" ? " — click to resume" : ""}`);
    el.setAttr("data-tooltip-position", "top");
    el.toggleClass("mod-error", s.state === "error");
  }

  async openRelated() {
    const leaf = (await this.app.workspace.ensureSideLeaf(VIEW_TYPE_RELATED, "right", { active: true, reveal: true })) as WorkspaceLeaf;
    await leaf.loadIfDeferred?.();
  }

  async openSearchByMeaning() {
    if (!this.index.isAvailable()) {
      new Notice(this.steppedAside() ? "Smart Connections is enabled; use its lookup instead." : "Turn on AI in Settings → AI and choose an engine for related notes.");
      return;
    }
    const search = this.app.internalPlugins.getEnabledPluginById("global-search");
    if (!search?.openGlobalSearch) return;
    await search.openGlobalSearch(null);
    const view = this.searchViews()[0];
    if (view) this.searchExt.setOn(view, true);
  }
}

class SemanticSettingTab extends PluginSettingTab {
  private ref: unknown = null;

  constructor(
    app: any,
    private owner: SemanticPlugin,
  ) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const index = this.owner.index;
    const ai = getAi(this.app);

    containerEl.createDiv({
      cls: "setting-item-description",
      text: "Related notes compares the meaning of your notes using an embedding model. The index is kept in this browser and updates as you write. Choose where embeddings run in Settings → AI.",
    });
    if (this.owner.steppedAside()) containerEl.createDiv({ cls: "setting-item-description mod-warning", text: "Smart Connections is enabled, so this index is paused." });

    const status = new Setting(containerEl).setName("Index");
    const renderStatus = () => {
      const s = index.getStatus();
      const engine = engineLabel(s.engine ?? ai?.engineFor("related", "embed") ?? null);
      status.setDesc(`${statusText(s) || (ai?.isAvailable("related", "embed") ? "Not started." : "AI is off, or no engine is chosen for related notes.")}${engine ? ` — ${engine}` : ""}`);
    };
    renderStatus();
    if (this.ref) index.offref(this.ref as never);
    this.ref = index.on("status", renderStatus);
    status.addButton((b) => b.setButtonText(index.isPaused() ? "Resume" : "Pause").onClick(() => {
      if (index.isPaused()) index.resume();
      else index.pause();
      this.display();
    }));
    status.addButton((b) => b.setButtonText("Rebuild").setWarning().onClick(() => void index.rebuild()));
    if (!ai?.isAvailable("related", "embed")) status.addButton((b) => b.setButtonText("AI settings").setCta().onClick(() => this.owner.openAiSettings()));

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("One folder per line. Notes in these folders are not indexed and never appear as related.")
      .addTextArea((t) => {
        t.setPlaceholder("Templates\nArchive/Old").setValue(o.excludeFolders.join("\n"));
        t.inputEl.rows = 4;
        t.inputEl.addEventListener("blur", () => {
          o.excludeFolders = t.getValue().split("\n").map((s) => s.trim()).filter(Boolean);
          this.owner.saveOptions();
          index.reconcile();
        });
      });
    new Setting(containerEl)
      .setName("Skip excluded files")
      .setDesc("Also leave out the files excluded in Settings → Files and links.")
      .addToggle((t) =>
        t.setValue(o.respectExcludedFiles).onChange((v) => {
          o.respectExcludedFiles = v;
          this.owner.saveOptions();
          index.reconcile();
        }),
      );
    new Setting(containerEl)
      .setName("Show similarity scores")
      .addToggle((t) =>
        t.setValue(o.showScores).onChange((v) => {
          o.showScores = v;
          this.owner.saveOptions();
        }),
      );
    new Setting(containerEl)
      .setName("Number of related notes")
      .addSlider((s) =>
        s.setLimits(5, 30, 1).setValue(o.relatedLimit).setDynamicTooltip().onChange((v) => {
          o.relatedLimit = v;
          this.owner.saveOptions();
        }),
      );
  }

  override hide(): void {
    if (this.ref) this.owner.index.offref(this.ref as never);
    this.ref = null;
    super.hide?.();
  }
}
