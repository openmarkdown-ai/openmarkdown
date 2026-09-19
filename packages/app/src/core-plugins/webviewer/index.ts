/**
 * Web viewer (`webviewer`) — open web pages in a tab, save them as notes.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { Notice } from "../../obsidian/ui/notice";
import { customFrame, type FrameConfig, FRAME_PRESETS, frameFromPreset, knownFraming } from "./frames";
import { saveUrlToVault } from "./save";
import { VIEW_TYPE_WEBVIEWER, WebviewerView, resolveAddress } from "./view";

export interface WebviewerOptions {
  openExternalURLs: boolean;
  homepage: string;
  savedPageFolder: string;
  searchEngine: string;
  customSearchUrl: string;
  /** Web panes (Custom Frames–style). */
  frames: FrameConfig[];
}

const DEFAULT_OPTIONS: WebviewerOptions = {
  openExternalURLs: false,
  homepage: "",
  savedPageFolder: "Clippings",
  searchEngine: "duckduckgo",
  customSearchUrl: "",
  frames: [],
};

class WebviewerPlugin extends Plugin {
  instance!: any;
  private frameCommandIds: string[] = [];
  private frameRibbonEls: HTMLElement[] = [];

  get options(): WebviewerOptions {
    return this.instance.options as WebviewerOptions;
  }

  override async onload() {
    this.registerView(VIEW_TYPE_WEBVIEWER, (leaf) => new WebviewerView(leaf, this));

    const withView = (run: (view: WebviewerView) => void) => (checking: boolean) => {
      const view = this.app.workspace.getActiveViewOfType(WebviewerView);
      if (!view) return false;
      if (!checking) run(view);
      return true;
    };

    this.addCommand({ id: "webviewer:open", name: "Open web viewer", icon: "lucide-globe", callback: () => void this.openUrl(this.options.homepage ? resolveAddress(this.options, this.options.homepage) : "", "tab") });
    this.addCommand({ id: "webviewer:open-history", name: "Show history", checkCallback: withView((v) => new HistoryModal(this.app, v).open()) });
    this.addCommand({ id: "webviewer:focus-address-bar", name: "Focus address bar", checkCallback: withView((v) => v.focusAddressBar()) });
    this.addCommand({
      id: "webviewer:search",
      name: "Search the web",
      callback: async () => {
        let view = this.app.workspace.getActiveViewOfType(WebviewerView);
        if (!view) view = await this.openUrl("", "tab");
        view?.focusAddressBar();
      },
    });
    this.addCommand({ id: "webviewer:save-to-vault", name: "Save to vault", checkCallback: withView((v) => void this.saveToVault(v)) });
    this.addCommand({ id: "webviewer:zoom-in", name: "Zoom in", checkCallback: withView((v) => v.setZoom(v.zoom + 0.1)) });
    this.addCommand({ id: "webviewer:zoom-out", name: "Zoom out", checkCallback: withView((v) => v.setZoom(v.zoom - 0.1)) });
    this.addCommand({ id: "webviewer:reset-zoom", name: "Reset zoom", checkCallback: withView((v) => v.setZoom(1)) });

    this.instance.openUrl = (url: string, newLeaf?: boolean | string) => this.openUrl(url, newLeaf ?? "tab");

    // "Open external links": http(s) links in notes open in a web viewer tab.
    this.registerDomEvent(
      document,
      "click",
      (evt: MouseEvent) => {
        if (!this.options.openExternalURLs || evt.button !== 0) return;
        const target = evt.target as HTMLElement | null;
        const a = target?.closest?.<HTMLAnchorElement>("a.external-link, a[href^='http://'], a[href^='https://']");
        if (!a || !a.closest(".markdown-rendered, .cm-editor, .markdown-preview-view")) return;
        const href = a.getAttribute("href") ?? "";
        if (!/^https?:\/\//i.test(href)) return;
        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();
        void this.openUrl(href, evt.ctrlKey || evt.metaKey ? "split" : "tab");
      },
      true,
    );

    if (!Array.isArray(this.options.frames)) this.options.frames = [];
    this.registerFrames();
    this.app.workspace.onLayoutReady(() => {
      for (const frame of this.options.frames) {
        if (frame.openOnStartup && !this.frameLeaf(frame.id)) void this.openFrame(frame, false);
      }
    });
    this.instance.openFrame = (id: string) => {
      const frame = this.getFrame(id);
      return frame ? this.openFrame(frame) : null;
    };

    this.addSettingTab(new WebviewerSettingTab(this.app, this));
  }

  // ---- web panes ----------------------------------------------------------------------

  getFrame(id: string): FrameConfig | null {
    return this.options.frames?.find((f) => f.id === id) ?? null;
  }

  /** (Re)creates the command and ribbon icon of every web pane. */
  registerFrames() {
    for (const id of this.frameCommandIds.splice(0)) this.removeCommand(id);
    for (const el of this.frameRibbonEls.splice(0)) el.remove();
    for (const frame of this.options.frames) {
      const id = `webviewer:open-frame-${frame.id}`;
      this.addCommand({ id, name: `Open ${frame.name}`, icon: frame.icon || "lucide-globe", callback: () => void this.openFrame(frame) });
      this.frameCommandIds.push(id);
      if (frame.addRibbonIcon) this.frameRibbonEls.push(this.addRibbonIcon(frame.icon || "lucide-globe", `Open ${frame.name}`, () => void this.openFrame(frame)));
    }
  }

  private frameLeaf(id: string): any {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_WEBVIEWER).find((l: any) => l.view instanceof WebviewerView && l.view.frameId === id) ?? null;
  }

  async openFrame(frame: FrameConfig, reveal = true): Promise<WebviewerView | null> {
    if (!/^https?:\/\/[^/]+/i.test(frame.url)) {
      new Notice(`“${frame.name}” has no valid address. Set it in Settings → Web viewer.`);
      return null;
    }
    const existing = this.frameLeaf(frame.id);
    if (existing) {
      if (reveal) await this.app.workspace.revealLeaf(existing);
      return existing.view as WebviewerView;
    }
    const leaf = frame.inSidebar ? this.app.workspace.getRightLeaf(false) : this.app.workspace.getLeaf("tab");
    if (!leaf) return null;
    await leaf.setViewState({ type: VIEW_TYPE_WEBVIEWER, state: { url: frame.url, frame: frame.id }, active: reveal });
    if (reveal) await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof WebviewerView ? leaf.view : null;
  }

  async openUrl(url: string, newLeaf: boolean | string): Promise<WebviewerView | null> {
    const leaf = this.app.workspace.getLeaf(newLeaf);
    await leaf.setViewState({ type: VIEW_TYPE_WEBVIEWER, state: { url }, active: true });
    const view = leaf.view instanceof WebviewerView ? leaf.view : null;
    if (view && !url) view.focusAddressBar();
    return view;
  }

  async saveToVault(view: WebviewerView): Promise<void> {
    if (!view.url || !/^https?:/i.test(view.url)) return;
    const cached = view.cachedHtml?.url === view.url ? view.cachedHtml.html : null;
    await saveUrlToVault(this.app, view.url, this.options.savedPageFolder, cached);
  }
}

class HistoryModal extends Modal {
  constructor(app: any, private view: WebviewerView) {
    super(app);
  }
  override onOpen() {
    this.setTitle("Web history");
    const list = this.contentEl.createDiv({ cls: "webviewer-history" });
    const entries = this.view.getHistory().reverse();
    if (!entries.length) list.createDiv({ cls: "suggestion-empty", text: "No history yet." });
    for (const url of entries) {
      const row = list.createDiv({ cls: "webviewer-history-item tappable", text: url });
      row.addEventListener("click", () => {
        this.close();
        void this.view.navigate(url);
      });
    }
  }
  override onClose() {
    this.contentEl.empty();
  }
}

class WebviewerSettingTab extends PluginSettingTab {
  constructor(app: any, private owner: WebviewerPlugin) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();
    new Setting(containerEl)
      .setName("Open external links")
      .setDesc("Open links to web pages in a web viewer tab instead of the browser.")
      .addToggle((t) => t.setValue(o.openExternalURLs).onChange((v) => ((o.openExternalURLs = v), save())));
    new Setting(containerEl)
      .setName("Homepage")
      .setDesc("The page a new web viewer tab opens.")
      .addText((t) => t.setPlaceholder("https://example.com").setValue(o.homepage).onChange((v) => ((o.homepage = v.trim()), save())));
    new Setting(containerEl)
      .setName("Saved page folder")
      .setDesc("Where “Save to vault” puts new notes.")
      .addText((t) => t.setPlaceholder("Clippings").setValue(o.savedPageFolder).onChange((v) => ((o.savedPageFolder = v.trim()), save())));
    new Setting(containerEl)
      .setName("Search engine")
      .setDesc("Used when the address bar text is not a URL.")
      .addDropdown((d) =>
        d
          .addOptions({ duckduckgo: "DuckDuckGo", google: "Google", bing: "Bing", kagi: "Kagi", custom: "Custom" })
          .setValue(o.searchEngine)
          .onChange((v) => {
            o.searchEngine = v;
            save();
            this.display();
          }),
      );
    if (o.searchEngine === "custom") {
      new Setting(containerEl)
        .setName("Custom search URL")
        .setDesc("Use %s where the search terms go.")
        .addText((t) => t.setPlaceholder("https://search.example/?q=%s").setValue(o.customSearchUrl).onChange((v) => ((o.customSearchUrl = v.trim()), save())));
    }
    this.displayFrames(containerEl);
  }

  private displayFrames(containerEl: HTMLElement) {
    const o = this.owner.options;
    const saveFrames = () => {
      void this.owner.instance.saveOptions();
      this.owner.registerFrames();
    };
    new Setting(containerEl).setName("Web panes").setHeading();
    containerEl.createDiv({
      cls: "setting-item-description vault-web-panes-intro",
      text: "Keep web apps you use next to your notes, each with its own command. Many sites refuse to be shown inside another page (X-Frame-Options or CSP frame-ancestors); the pane then says so and offers to open the site in the browser. The companion extension can only lift that for sites you allow, when it supports it.",
    });
    const ids = () => o.frames.map((f) => f.id);
    new Setting(containerEl)
      .setName("Add a web pane")
      .setDesc("Start from a preset or an empty pane.")
      .addDropdown((d) => {
        d.addOption("", "Choose…");
        for (const p of FRAME_PRESETS) d.addOption(p.key, `${p.name}${p.framing ? " (refuses framing)" : ""}`);
        d.addOption("custom", "Custom…");
        d.onChange((v) => {
          if (!v) return;
          const preset = FRAME_PRESETS.find((p) => p.key === v);
          o.frames.push(preset ? frameFromPreset(preset, ids()) : customFrame(ids()));
          saveFrames();
          this.display();
        });
      });
    for (const frame of o.frames) {
      const box = containerEl.createDiv({ cls: "vault-web-pane-settings", attr: { "data-frame": frame.id } });
      const framing = knownFraming(frame.url);
      const head = new Setting(box).setName(frame.name || "Untitled pane").setDesc(framing ? `This site refused framing when checked: ${framing}.` : `Command: “Open ${frame.name}”.`);
      head.settingEl.addClass("vault-web-pane-head");
      head.addButton((b) => b.setButtonText("Open").onClick(() => void this.owner.openFrame(frame)));
      head.addExtraButton((b) =>
        b
          .setIcon("lucide-trash-2")
          .setTooltip("Remove pane")
          .onClick(() => {
            o.frames = o.frames.filter((f) => f !== frame);
            saveFrames();
            this.display();
          }),
      );
      new Setting(box).setName("Name").addText((t) => t.setValue(frame.name).onChange((v) => ((frame.name = v.trim() || frame.name), saveFrames())));
      new Setting(box).setName("Address").addText((t) => {
        t.inputEl.type = "url";
        t.setValue(frame.url).onChange((v) => ((frame.url = v.trim()), saveFrames()));
      });
      new Setting(box).setName("Icon").setDesc("A Lucide icon name, such as calendar or list-checks.").addText((t) => t.setValue(frame.icon.replace(/^lucide-/, "")).onChange((v) => ((frame.icon = v.trim() ? `lucide-${v.trim().replace(/^lucide-/, "")}` : "lucide-globe"), saveFrames())));
      new Setting(box).setName("Open in the right sidebar").addToggle((t) => t.setValue(frame.inSidebar).onChange((v) => ((frame.inSidebar = v), saveFrames())));
      new Setting(box).setName("Open when the app starts").addToggle((t) => t.setValue(frame.openOnStartup).onChange((v) => ((frame.openOnStartup = v), saveFrames())));
      new Setting(box).setName("Ribbon icon").addToggle((t) => t.setValue(frame.addRibbonIcon).onChange((v) => ((frame.addRibbonIcon = v), saveFrames())));
      new Setting(box)
        .setName("Zoom")
        .addSlider((s) => s.setLimits(0.5, 2, 0.05).setValue(frame.zoom || 1).setDynamicTooltip().onChange((v) => ((frame.zoom = v), saveFrames())));
      new Setting(box)
        .setName("Custom CSS")
        .setDesc("Saved with the pane, but not applied: a web page cannot style another site's page. Only a browser extension could inject it.")
        .addTextArea((t) => {
          t.inputEl.rows = 3;
          t.setValue(frame.customCss).onChange((v) => ((frame.customCss = v), void this.owner.instance.saveOptions()));
        });
    }
  }
}

export const webviewer: CorePluginDefinition = {
  id: "webviewer",
  name: "Web viewer",
  description: "Open external links to web pages inside the app.",
  icon: "lucide-globe",
  defaultOn: false,
  defaultOptions: { ...DEFAULT_OPTIONS },
  create: (app) => new WebviewerPlugin(app, { id: "webviewer", name: "Web viewer", version: "", minAppVersion: "", author: "", description: "" }),
};
