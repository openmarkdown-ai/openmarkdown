/**
 * Page preview (`page-preview`): hover an internal link to see the note.
 *
 * Every view that shows links triggers `workspace.trigger("hover-link",
 * { event, source, hoverParent, targetEl, linktext, sourcePath })`. This
 * plugin decides whether that source needs the Mod key (per-source setting
 * in `.obsidian/page-preview.json`, `{ [sourceId]: requireMod }`, defaulting
 * to the source's `defaultMod`) and calls `instance.onLinkHover(...)` — the
 * method Hover Editor and similar plugins patch — which opens a HoverPopover
 * with the note (or the heading/block the subpath names), an image, a PDF,
 * or any file an embed creator can draw.
 *
 * Holding Mod while already over a link opens its preview, as in Obsidian.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { getEngine } from "@vault/engine";
import { Component } from "../../obsidian/events";
import { Plugin } from "../../obsidian/plugin";
import { installInteractions, MarkdownPreviewRenderer, renderEmbedInto } from "../../obsidian/markdown/renderer";
import { setIcon } from "../../obsidian/ui/icons";
import { Keymap } from "../../obsidian/ui/keymap";
import { HoverPopover, PopoverState, type HoverParent } from "../../obsidian/ui/popover";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { parseLinktext } from "../../obsidian/util";
import { TFile } from "../../obsidian/vault/files";
import { frontmatterYamlOf, renderMetadataEditor, replaceFrontmatter } from "../properties/metadata-editor";

interface HoverLinkEvent {
  event: MouseEvent;
  source: string;
  hoverParent: HoverParent;
  targetEl: HTMLElement | null;
  linktext: string;
  sourcePath?: string;
  state?: unknown;
}

const CORE_SOURCES: Record<string, { display: string; defaultMod: boolean }> = {
  editor: { display: "Editing view", defaultMod: true },
  preview: { display: "Reading view", defaultMod: false },
  search: { display: "Search, Backlinks, and Outgoing links", defaultMod: true },
  "tab-header": { display: "Tab header", defaultMod: true },
};

const IMAGE_EXT = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

/** The popover of a page preview; itself a hover parent, so previews nest. */
export class PagePreviewPopover extends HoverPopover {
  app: any;
  file: TFile | null;
  linktext: string;
  sourcePath: string;
  // internal (used by plugins: hover editor checks these)
  subpath: string;
  private renderer: MarkdownPreviewRenderer | null = null;
  private owner = new Component();

  constructor(app: any, parent: HoverParent, targetEl: HTMLElement | null, file: TFile | null, linktext: string, sourcePath: string, waitTime?: number) {
    super(parent, targetEl, waitTime);
    this.app = app;
    this.file = file;
    this.linktext = linktext;
    this.sourcePath = sourcePath;
    this.subpath = parseLinktext(linktext).subpath;
    this.hoverEl.addClass("page-preview");
  }

  override onShow(): void {
    this.addChild(this.owner);
    this.registerDomEvent(this.hoverEl.ownerDocument, "keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Escape" && this.state !== PopoverState.Hidden && !this.hoverPopover) this.hide();
    });
    void this.renderContent();
  }

  override onHide(): void {
    this.renderer?.clear();
    this.renderer = null;
  }

  private async renderContent() {
    const { hoverEl, app } = this;
    const file = this.file;
    hoverEl.empty();
    if (!file) {
      const path = parseLinktext(this.linktext).path;
      const empty = hoverEl.createDiv({ cls: "markdown-embed is-loaded mod-empty" });
      const msg = empty.createDiv({ cls: "markdown-embed-content" }).createDiv({ cls: "markdown-preview-view markdown-rendered" });
      msg.createDiv({ cls: "markdown-embed-empty", text: `“${path}” is not created yet. Click to create.` });
      empty.addEventListener("click", (evt) => {
        this.hide();
        void app.workspace.openLinkText(this.linktext, this.sourcePath, Keymap.isModEvent(evt));
      });
      return;
    }
    if (file.extension !== "md") {
      this.renderAttachment(file);
      return;
    }
    const embed = hoverEl.createDiv({ cls: "markdown-embed is-loaded" });
    const titleEl = embed.createDiv({ cls: "markdown-embed-title" });
    const content = embed.createDiv({ cls: "markdown-embed-content" });
    const openBtn = embed.createDiv({ cls: "markdown-embed-link clickable-icon", attr: { "aria-label": "Open link" } });
    setIcon(openBtn, "lucide-link");
    openBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.hide();
      void app.workspace.openLinkText(file.path + this.subpath, this.sourcePath, Keymap.isModEvent(evt) || "tab");
    });
    const preview = content.createDiv({ cls: "markdown-preview-view markdown-rendered" });
    const sizer = preview.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    const metadataEl = createDiv({ cls: "metadata-container" });
    this.renderer = new MarkdownPreviewRenderer(app, this.owner, preview, sizer);
    this.renderer.embedDepth = 1;
    installInteractions(app, preview, file.path, this as unknown as { file: TFile | null; hoverPopover: unknown });
    const cls = app.metadataCache.getFileCache(file)?.frontmatter?.cssclasses;
    if (Array.isArray(cls)) for (const c of cls) if (typeof c === "string") preview.addClass(c);
    if (this.subpath) titleEl.setText(file.basename + this.subpath.replace(/^#\^?/, " › ").replace(/#/g, " › "));

    const render = async () => {
      let text: string = await app.vault.cachedRead(file);
      if (this.state === PopoverState.Hidden) return;
      if (this.subpath) {
        const cache = app.metadataCache.getFileCache(file);
        let res: { start: { offset: number }; end: { offset: number } | null } | null = null;
        try {
          res = cache ? getEngine().resolveSubpath(cache, this.subpath) : null;
        } catch {
          res = null;
        }
        if (!res) {
          sizer.empty();
          sizer.createDiv({ cls: "markdown-embed-empty", text: `Unable to find “${this.subpath.replace(/^#\^?/, "")}” in ${file.basename}.` });
          return;
        }
        text = text.slice(res.start.offset, res.end ? res.end.offset : text.length);
        await this.renderer!.set(text, file.path);
      } else {
        const fm = frontmatterYamlOf(text);
        const m = /^---\r?\n[\s\S]*?\r?\n?(?:---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text);
        const body = fm.exists && m ? text.slice(m[0].length) : text;
        const showProps = fm.exists && fm.yaml.trim() !== "" && app.vault.getConfig("propertiesInDocument") !== "hidden";
        await this.renderer!.set(body, file.path);
        if (showProps) {
          if (!metadataEl.isConnected) sizer.prepend(metadataEl);
          renderMetadataEditor(app, metadataEl, file, fm.yaml, (yaml) => void app.vault.process(file, (t: string) => replaceFrontmatter(t, yaml)), {
            hoverParent: this,
            component: this.owner,
          });
        } else metadataEl.detach();
        if (metadataEl.isConnected && metadataEl !== sizer.firstChild) sizer.prepend(metadataEl);
      }
      if (this.state === PopoverState.Shown || this.state === PopoverState.Hiding) this.position();
    };
    await render();
    this.owner.registerEvent(
      app.metadataCache.on("changed", (f: TFile) => {
        if (f === file && !this.hoverEl.contains(this.hoverEl.ownerDocument.activeElement)) void render();
      }),
    );
  }

  private renderAttachment(file: TFile) {
    const { hoverEl, app } = this;
    const ext = file.extension.toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      hoverEl.addClass("mod-image");
      const img = hoverEl.createEl("img", { attr: { src: app.vault.getResourcePath(file), alt: file.name } });
      img.addEventListener("load", () => this.position());
      return;
    }
    if (ext === "pdf") hoverEl.addClass("mod-pdf");
    const holder = hoverEl.createDiv({ cls: "markdown-embed is-loaded" }).createDiv({ cls: "markdown-embed-content" });
    try {
      renderEmbedInto(app, this.owner, holder, file.path + this.subpath, this.sourcePath, "");
    } catch (e) {
      console.error(e);
      holder.setText(file.name);
    }
  }
}

class PagePreviewSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private pp: PagePreviewPlugin,
  ) {
    super(app, pp);
    this.name = "Page preview";
  }
  override display(): void {
    const el = this.containerEl;
    el.empty();
    el.createDiv({ cls: "setting-item-description", text: "Choose which views need the Mod key held to show a page preview on hover." });
    const sources = this.app.workspace.hoverLinkSources as Record<string, { display: string; defaultMod: boolean }>;
    for (const [id, info] of Object.entries(sources)) {
      new Setting(el)
        .setName(info.display)
        .setDesc("Require Mod to trigger page preview on hover")
        .addToggle((t) =>
          t.setValue(this.pp.requiresMod(id)).onChange(async (v) => {
            this.pp.instance.options[id] = v;
            await this.pp.instance.saveOptions();
          }),
        );
    }
  }
}

export class PagePreviewPlugin extends Plugin {
  instance!: any;
  private pending: { evt: HoverLinkEvent; until: number } | null = null;

  override async onload() {
    for (const [id, info] of Object.entries(CORE_SOURCES)) {
      if (!this.app.workspace.hoverLinkSources[id]) this.registerHoverLinkSource(id, info);
    }
    this.instance.onLinkHover = (hoverParent: HoverParent, targetEl: HTMLElement | null, linktext: string, sourcePath: string, state?: unknown, waitTime?: number) =>
      this.onLinkHover(hoverParent, targetEl, linktext, sourcePath, state, waitTime);
    // internal (used by plugins: some call `instance.onHoverLink(evt)` directly)
    this.instance.onHoverLink = (evt: HoverLinkEvent) => this.onHoverLink(evt);
    this.instance.requiresMod = (source: string) => this.requiresMod(source);

    this.registerEvent(this.app.workspace.on("hover-link", (evt: HoverLinkEvent) => this.onHoverLink(evt)));
    this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
      if (evt.key !== "Meta" && evt.key !== "Control") return;
      if (!Keymap.isModifier(evt, "Mod")) return;
      const p = this.pending;
      if (!p || Date.now() > p.until) return;
      const target = p.evt.targetEl;
      if (!target || !target.isConnected || !target.matches(":hover")) return;
      this.pending = null;
      this.show(p.evt, 0);
    });
    if (this.app.setting) this.addSettingTab(new PagePreviewSettingTab(this.app, this));
  }

  override onunload() {
    delete this.instance.onLinkHover;
    delete this.instance.onHoverLink;
    delete this.instance.requiresMod;
  }

  requiresMod(source: string): boolean {
    const v = this.instance.options?.[source];
    if (typeof v === "boolean") return v;
    return !!(this.app.workspace.hoverLinkSources[source]?.defaultMod ?? CORE_SOURCES[source]?.defaultMod ?? false);
  }

  onHoverLink(evt: HoverLinkEvent) {
    if (!evt || !evt.linktext) return;
    if (this.requiresMod(evt.source) && !Keymap.isModEvent(evt.event)) {
      // Pressing Mod while still over the link opens it.
      this.pending = { evt, until: Date.now() + 10_000 };
      return;
    }
    this.pending = null;
    this.show(evt, undefined);
  }

  private show(evt: HoverLinkEvent, waitTime: number | undefined) {
    const open = this.instance.onLinkHover as (p: HoverParent, t: HTMLElement | null, l: string, s: string, st?: unknown, w?: number) => void;
    open(evt.hoverParent ?? { hoverPopover: null }, evt.targetEl, evt.linktext, evt.sourcePath ?? "", evt.state, waitTime);
  }

  onLinkHover(hoverParent: HoverParent, targetEl: HTMLElement | null, linktext: string, sourcePath: string, _state?: unknown, waitTime?: number) {
    const parent = hoverParent ?? { hoverPopover: null };
    const existing = parent.hoverPopover as PagePreviewPopover | null;
    if (existing && existing.state !== PopoverState.Hidden && existing.targetEl === targetEl && (existing as PagePreviewPopover).linktext === linktext) return;
    // A link inside a popover never re-opens that same popover's own parent chain.
    if (targetEl && existing?.hoverEl?.contains(targetEl)) return;
    const { path } = parseLinktext(linktext);
    let file: TFile | null = null;
    if (!path) file = this.app.vault.getFileByPath(sourcePath);
    else {
      file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
      if (!file) {
        const direct = this.app.vault.getAbstractFileByPath(path);
        if (direct instanceof TFile) file = direct;
      }
    }
    if (file && file.path === sourcePath && !parseLinktext(linktext).subpath) return;
    new PagePreviewPopover(this.app, parent, targetEl, file, linktext, sourcePath, waitTime);
  }
}

export const pagePreview: CorePluginDefinition = {
  id: "page-preview",
  name: "Page preview",
  description: "Hover an internal link to preview its content.",
  icon: "lucide-eye",
  defaultOn: true,
  defaultOptions: {},
  create: (app) => new PagePreviewPlugin(app, { id: "page-preview", name: "Page preview", version: "", minAppVersion: "", author: "", description: "" }),
};
