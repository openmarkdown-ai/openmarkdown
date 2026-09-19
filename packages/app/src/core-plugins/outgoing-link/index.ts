/**
 * Outgoing links (`outgoing-link`): every link in the active note, resolved
 * and not yet created, and "unlinked mentions" — other notes' names or
 * aliases written as plain text in this note, each with a button that turns
 * the mention into a link.
 *
 * View state (Obsidian's keys): file, linksCollapsed, unlinkedCollapsed.
 */
import type { CachedMetadata, ViewStateResult } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Keymap } from "../../obsidian/ui/keymap";
import { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { debounce, parseFrontMatterAliases, parseLinktext } from "../../obsidian/util";
import { TFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ensureKnowledgeIcons, FileInfoView, openLinkedView, showSideView } from "../global-search/common";
import { compareNames, isWordChar, type Range } from "../global-search/engine";
import { openMatch, SearchResultDOM, type SearchResultItemDOM } from "../global-search/result-dom";

export const VIEW_TYPE_OUTGOING = "outgoing-link";

interface LinkEntry {
  linkpath: string;
  file: TFile | null;
  count: number;
}

/** The links of `cache`, grouped by destination in order of first appearance. */
export function collectOutgoingLinks(app: any, file: TFile, cache: CachedMetadata | null): LinkEntry[] {
  const out = new Map<string, LinkEntry>();
  const refs = [...(cache?.frontmatterLinks ?? []), ...(cache?.links ?? []), ...(cache?.embeds ?? [])].sort((a, b) => {
    const pa = (a as { position?: { start: { offset: number } } }).position?.start.offset ?? -1;
    const pb = (b as { position?: { start: { offset: number } } }).position?.start.offset ?? -1;
    return pa - pb;
  });
  for (const ref of refs) {
    const { path } = parseLinktext(ref.link);
    if (!path) continue;
    const dest = app.metadataCache.getFirstLinkpathDest(path, file.path) as TFile | null;
    const key = dest ? `f:${dest.path}` : `u:${path.toLowerCase()}`;
    const e = out.get(key);
    if (e) e.count++;
    else out.set(key, { linkpath: path, file: dest, count: 1 });
  }
  return Array.from(out.values());
}

/**
 * Whole-word, case-insensitive mentions of other notes' names and aliases in
 * `text`, outside links, embeds and frontmatter. Longest name wins at a
 * position. Returns ranges grouped by the note they name.
 */
export function findUnlinkedMentions(app: any, file: TFile, text: string, cache: CachedMetadata | null): Map<TFile, { name: string; ranges: Range[] }> {
  const excluded: Range[] = [];
  for (const r of [...(cache?.links ?? []), ...(cache?.embeds ?? [])]) excluded.push([r.position.start.offset, r.position.end.offset]);
  if (cache?.frontmatterPosition) excluded.push([cache.frontmatterPosition.start.offset, cache.frontmatterPosition.end.offset]);
  excluded.sort((a, b) => a[0] - b[0]);

  const tokenRe = /[\p{L}\p{N}_]+/gu;
  const byFirst = new Map<string, { file: TFile; name: string; lower: string; lead: number }[]>();
  for (const f of app.vault.getMarkdownFiles() as TFile[]) {
    if (f === file || app.metadataCache.isUserIgnored?.(f.path)) continue;
    const names = [f.basename, ...(parseFrontMatterAliases(app.metadataCache.getFileCache(f)?.frontmatter ?? null) ?? [])];
    for (const name of names) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      tokenRe.lastIndex = 0;
      const first = tokenRe.exec(trimmed);
      if (!first) continue;
      const key = first[0].toLowerCase();
      const list = byFirst.get(key) ?? [];
      list.push({ file: f, name: trimmed, lower: trimmed.toLowerCase(), lead: first.index });
      byFirst.set(key, list);
    }
  }
  const lower = text.toLowerCase();
  const found: { start: number; end: number; file: TFile; name: string }[] = [];
  tokenRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text))) {
    const cands = byFirst.get(m[0].toLowerCase());
    if (!cands) continue;
    for (const c of cands) {
      const start = m.index - c.lead;
      if (start < 0) continue;
      const end = start + c.lower.length;
      if (lower.slice(start, end) !== c.lower) continue;
      if (isWordChar(c.lower[0]) && isWordChar(text[start - 1])) continue;
      if (isWordChar(c.lower[c.lower.length - 1]) && isWordChar(text[end])) continue;
      found.push({ start, end, file: c.file, name: c.name });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out = new Map<TFile, { name: string; ranges: Range[] }>();
  let lastEnd = -1;
  let ex = 0;
  for (const f of found) {
    if (f.start < lastEnd) continue;
    while (ex < excluded.length && excluded[ex]![1] <= f.start) ex++;
    if (ex < excluded.length && excluded[ex]![0] < f.end && excluded[ex]![1] > f.start) continue;
    lastEnd = f.end;
    const entry = out.get(f.file) ?? { name: f.file.basename, ranges: [] };
    entry.ranges.push([f.start, f.end]);
    out.set(f.file, entry);
  }
  return out;
}

export class OutgoingLinkView extends FileInfoView {
  hoverPopover: any = null;
  linksCollapsed = false;
  unlinkedCollapsed = true;
  paneEl!: HTMLElement;
  linksHeaderEl!: HTMLElement;
  linksCountEl!: HTMLElement;
  linksContainerEl!: HTMLElement;
  unlinkedHeaderEl!: HTMLElement;
  unlinkedCountEl!: HTMLElement;
  unlinkedDom!: SearchResultDOM;
  private text = "";
  private requestUpdate = debounce(() => void this.update(), 300, true);

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "links-going-out";
  }

  getViewType() {
    return VIEW_TYPE_OUTGOING;
  }

  getDisplayText() {
    return this.file ? `Outgoing links from ${this.file.basename}` : "Outgoing links";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.paneEl = this.contentEl.createDiv({ cls: "outgoing-link-pane" });
    const header = (title: string, onClick: () => void) => {
      const self = this.paneEl.createDiv({ cls: "tree-item-self is-clickable" });
      setIcon(self.createDiv({ cls: "tree-item-icon collapse-icon" }), "right-triangle");
      self.createDiv({ cls: "tree-item-inner", text: title });
      const count = self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair" });
      self.addEventListener("click", onClick);
      return { self, count };
    };
    const links = header("Links", () => this.setCollapsed("links", !this.linksCollapsed));
    this.linksHeaderEl = links.self;
    this.linksCountEl = links.count;
    this.linksContainerEl = this.paneEl.createDiv({ cls: "search-result-container" }).createDiv({ cls: "search-results-children" });
    const unlinked = header("Unlinked mentions", () => this.setCollapsed("unlinked", !this.unlinkedCollapsed));
    this.unlinkedHeaderEl = unlinked.self;
    this.unlinkedCountEl = unlinked.count;
    this.unlinkedDom = new SearchResultDOM(
      {
        app: this.app,
        hoverSource: "search",
        hoverParent: this,
        mergeMatches: false,
        emptyStateText: "No unlinked mentions found.",
        menuSource: "outgoing-link",
        linkButton: (item, range) => void this.linkMention(item, range),
        linkButtonText: (item) => item.file.basename,
        onMatchClick: (_item, group, evt) => {
          if (this.file) void openMatch(this.app, this.file, this.text, group, evt, true);
        },
      },
      this.paneEl,
    );
    this.applyCollapsed();

    const update = () => this.requestUpdate();
    this.registerEvent(this.app.metadataCache.on("changed", (f: TFile) => f === this.file && update()));
    this.registerEvent(this.app.metadataCache.on("resolved", update));
    this.registerEvent(this.app.vault.on("rename", update));
    await super.onOpen();
  }

  override async onClose(): Promise<void> {
    this.unlinkedDom?.destroy();
  }

  onFileChanged(): void {
    this.unlinkedDom?.emptyResults();
    void this.update();
  }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), linksCollapsed: this.linksCollapsed, unlinkedCollapsed: this.unlinkedCollapsed };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    if (state && typeof state.linksCollapsed === "boolean") this.linksCollapsed = state.linksCollapsed;
    if (state && typeof state.unlinkedCollapsed === "boolean") this.unlinkedCollapsed = state.unlinkedCollapsed;
    if (this.paneEl) this.applyCollapsed();
    await super.setState(state, result);
  }

  private setCollapsed(which: "links" | "unlinked", collapsed: boolean) {
    if (which === "links") this.linksCollapsed = collapsed;
    else this.unlinkedCollapsed = collapsed;
    this.applyCollapsed();
    if (which === "unlinked" && !collapsed) void this.update();
    this.app.workspace.requestSaveLayout();
  }

  private applyCollapsed() {
    const fold = (header: HTMLElement, body: HTMLElement, collapsed: boolean) => {
      header.toggleClass("is-collapsed", collapsed);
      header.querySelector(".collapse-icon")?.toggleClass("is-collapsed", collapsed);
      body.toggle(!collapsed);
    };
    fold(this.linksHeaderEl, this.linksContainerEl.parentElement!, this.linksCollapsed);
    fold(this.unlinkedHeaderEl, this.unlinkedDom.el, this.unlinkedCollapsed);
  }

  async update() {
    if (!this.paneEl) return;
    const file = this.file;
    this.linksContainerEl.empty();
    if (!file || file.extension !== "md") {
      this.linksCountEl.setText("0");
      this.unlinkedCountEl.setText("");
      this.unlinkedDom.emptyResults();
      this.linksContainerEl.createDiv({ cls: "search-empty-state", text: "No outgoing links found." });
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file) as CachedMetadata | null;
    const links = collectOutgoingLinks(this.app, file, cache);
    this.linksCountEl.setText(String(links.length));
    if (!links.length) this.linksContainerEl.createDiv({ cls: "search-empty-state", text: "No outgoing links found." });
    for (const link of links) this.renderLink(file, link);

    if (this.unlinkedCollapsed) {
      this.unlinkedCountEl.setText("");
      return;
    }
    this.text = await this.app.vault.cachedRead(file);
    if (this.file !== file) return;
    const mentions = findUnlinkedMentions(this.app, file, this.text, cache);
    const targets = Array.from(mentions.keys()).sort((a, b) => compareNames(a.basename, b.basename));
    for (const existing of Array.from(this.unlinkedDom.resultDomLookup.keys())) if (!mentions.has(existing)) this.unlinkedDom.removeResult(existing);
    for (const target of targets) this.unlinkedDom.addResult(target, { content: mentions.get(target)!.ranges }, this.text);
    this.unlinkedCountEl.setText(String(targets.length));
  }

  private renderLink(source: TFile, link: LinkEntry) {
    const item = this.linksContainerEl.createDiv({ cls: "tree-item search-result" });
    const self = item.createDiv({ cls: "tree-item-self search-result-file-title is-clickable" });
    if (!link.file) self.addClass("is-unresolved");
    const inner = self.createDiv({ cls: "tree-item-inner", text: link.file ? (link.file.extension === "md" ? link.file.basename : link.file.name) : link.linkpath });
    inner.setAttr("aria-label", link.file ? link.file.path : "Not created yet");
    if (link.count > 1) self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: String(link.count) });
    self.addEventListener("click", (evt) => {
      if (link.file) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(link.file, { active: true });
      else void this.app.workspace.openLinkText(link.linkpath, source.path, Keymap.isModEvent(evt));
    });
    self.addEventListener("mouseover", (evt) => {
      this.app.workspace.trigger("hover-link", { event: evt, source: "search", hoverParent: this, targetEl: self, linktext: link.file ? link.file.path : link.linkpath, sourcePath: source.path });
    });
    self.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      if (link.file) this.app.workspace.trigger("file-menu", menu, link.file, "outgoing-link", this.leaf);
      else this.app.workspace.handleLinkContextMenu(menu, link.linkpath, source.path);
      menu.showAtMouseEvent(evt);
    });
    if (link.file) this.app.dragManager?.handleDrag?.(self, (evt: DragEvent) => this.app.dragManager.dragFile(evt, link.file!, source.path));
  }

  private async linkMention(item: SearchResultItemDOM, range: Range) {
    const source = this.file;
    const target = item.file;
    if (!source) return;
    const names = [target.basename, ...(parseFrontMatterAliases(this.app.metadataCache.getFileCache(target)?.frontmatter ?? null) ?? [])];
    let ok = false;
    await this.app.vault.process(source, (text: string) => {
      const matched = text.slice(range[0], range[1]);
      if (!names.some((n) => n.toLowerCase() === matched.toLowerCase())) return text;
      ok = true;
      const alias = matched === target.basename ? undefined : matched;
      return text.slice(0, range[0]) + this.app.fileManager.generateMarkdownLink(target, source.path, undefined, alias) + text.slice(range[1]);
    });
    if (!ok) new Notice("The mention has changed since it was found. Try again.");
  }
}

class OutgoingLinkPlugin extends Plugin {
  instance!: any;
  override async onload() {
    ensureKnowledgeIcons();
    this.registerView(VIEW_TYPE_OUTGOING, (leaf: WorkspaceLeaf) => new OutgoingLinkView(leaf));
    this.addCommand({ id: "outgoing-links:open", name: "Outgoing links: Show outgoing links", icon: "links-going-out", callback: () => void showSideView(this.app, VIEW_TYPE_OUTGOING) });
    this.addCommand({
      id: "outgoing-links:open-for-current",
      name: "Outgoing links: Open outgoing links for the current file",
      icon: "links-going-out",
      checkCallback: (checking: boolean) => {
        if (!this.app.workspace.getActiveFile()) return false;
        if (!checking) void openLinkedView(this.app, VIEW_TYPE_OUTGOING);
        return true;
      },
    });
  }
}

export const outgoingLink: CorePluginDefinition = {
  id: "outgoing-link",
  name: "Outgoing links",
  description: "Show outgoing links and detect unlinked mentions of other notes in the current file.",
  icon: "links-going-out",
  defaultOn: true,
  defaultOptions: {},
  create: (app) => new OutgoingLinkPlugin(app, { id: "outgoing-link", name: "Outgoing links", version: "", minAppVersion: "", author: "", description: "" }),
};
