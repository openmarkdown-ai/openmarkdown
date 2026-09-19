/**
 * Tags view (`tag-pane`, view type `tag`).
 *
 * DOM per tag (Tag Wrangler and themes target these):
 *
 *   .tree-item[data-tag="parent/child"]
 *     .tree-item-self.tag-pane-tag.is-clickable[.mod-collapsible]
 *       .tree-item-icon.collapse-icon            (only with children)
 *       .tree-item-inner
 *         .tree-item-inner-text.tag-pane-tag-text
 *           .tag-pane-tag-parent  "parent/"      (hidden in the nested tree)
 *           .tag-pane-tag-self    "child"
 *       .tree-item-flair-outer > .tree-item-flair.tag-pane-tag-count
 *     .tree-item-children
 *
 * `.tag-pane-tag-text`'s textContent is always the full tag without "#".
 * Counts come from `metadataCache.getTags()`; tags are case-insensitive and
 * show the casing seen first. A nested parent counts itself plus children.
 *
 * View state (Obsidian's keys): sortOrder, useHierarchy, showSearch, searchQuery.
 */
import type { ViewStateResult } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Keymap } from "../../obsidian/ui/keymap";
import { Menu } from "../../obsidian/ui/menu";
import { RenameTagModal, TAG_WRANGLER_PLUGIN, renameTag } from "./rename";
import { debounce } from "../../obsidian/util";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ItemView } from "../../obsidian/workspace/view";
import { FilterBox, NavHeader, setButtonState, showSideView, showSortMenu } from "../global-search/common";
import { compareNames } from "../global-search/engine";

export const VIEW_TYPE_TAG = "tag";

type TagSort = "alphabetical" | "alphabeticalReverse" | "frequency" | "frequencyReverse";

const TAG_SORTS: [TagSort, string][] = [
  ["alphabetical", "Tag name (A to Z)"],
  ["alphabeticalReverse", "Tag name (Z to A)"],
  ["frequency", "Frequency (high to low)"],
  ["frequencyReverse", "Frequency (low to high)"],
];

interface TagNode {
  /** Full tag without "#", in display casing. */
  tag: string;
  name: string;
  own: number;
  total: number;
  children: Map<string, TagNode>;
}

export function buildTagTree(tags: Record<string, number>, nested: boolean): TagNode[] {
  const root = new Map<string, TagNode>();
  const flat = new Map<string, TagNode>();
  for (const [raw, count] of Object.entries(tags)) {
    const tag = raw.replace(/^#/, "");
    if (!tag) continue;
    if (!nested) {
      const key = tag.toLowerCase();
      const n = flat.get(key) ?? { tag, name: tag, own: 0, total: 0, children: new Map() };
      n.own += count;
      n.total += count;
      flat.set(key, n);
      continue;
    }
    const parts = tag.split("/");
    let level = root;
    let path = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      path = path ? `${path}/${part}` : part;
      const key = part.toLowerCase();
      let node = level.get(key);
      if (!node) {
        node = { tag: path, name: part, own: 0, total: 0, children: new Map() };
        level.set(key, node);
      }
      node.total += count;
      if (i === parts.length - 1) node.own += count;
      path = node.tag;
      level = node.children;
    }
  }
  return Array.from((nested ? root : flat).values());
}

export class TagPaneView extends ItemView {
  sortOrder: TagSort = "frequency";
  useHierarchy = true;
  showSearch = false;
  searchQuery = "";
  hoverPopover: any = null;
  headerDom!: NavHeader;
  filter!: FilterBox;
  containerTagEl!: HTMLElement;
  private collapsed = new Set<string>();
  private buttons: Record<string, HTMLElement> = {};
  private requestRender = debounce(() => this.render(), 300, true);

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "lucide-tags";
  }

  getViewType() {
    return VIEW_TYPE_TAG;
  }

  getDisplayText() {
    return "Tags";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.headerDom = new NavHeader(this.contentEl, false);
    this.buttons.search = this.headerDom.addButton("lucide-search", "Show search filter", () => {
      this.showSearch = !this.showSearch;
      if (!this.showSearch && this.searchQuery) {
        this.searchQuery = "";
        this.filter.component.setValue("");
      }
      this.applyButtons();
      if (this.showSearch) this.filter.component.inputEl.focus();
      this.render();
      this.app.workspace.requestSaveLayout();
    });
    this.buttons.sort = this.headerDom.addButton("lucide-arrow-up-narrow-wide", "Change sort order", (evt) =>
      showSortMenu(evt, TAG_SORTS, this.sortOrder, (v) => {
        this.sortOrder = v;
        this.render();
        this.app.workspace.requestSaveLayout();
      }),
    );
    this.buttons.nested = this.headerDom.addButton("lucide-folder-tree", "Show nested tags", () => {
      this.useHierarchy = !this.useHierarchy;
      this.applyButtons();
      this.render();
      this.app.workspace.requestSaveLayout();
    });
    this.buttons.collapse = this.headerDom.addButton("lucide-chevrons-down-up", "Collapse all", () => {
      const parents = this.allParents();
      const anyExpanded = parents.some((t) => !this.collapsed.has(t));
      if (anyExpanded) for (const t of parents) this.collapsed.add(t);
      else this.collapsed.clear();
      setButtonState(this.buttons.collapse!, false, anyExpanded ? "lucide-chevrons-up-down" : "lucide-chevrons-down-up", anyExpanded ? "Expand all" : "Collapse all");
      this.render();
    });
    this.filter = new FilterBox(this.contentEl, "Search...", (v) => {
      this.searchQuery = v;
      this.render();
      this.app.workspace.requestSaveLayout();
    });
    this.containerTagEl = this.contentEl.createDiv({ cls: "tag-container" });
    this.applyButtons();
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.requestRender()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.requestRender()));
    this.registerEvent(this.app.metadataCache.on("deleted", () => this.requestRender()));
    this.render();
  }

  override getState(): Record<string, unknown> {
    return { sortOrder: this.sortOrder, useHierarchy: this.useHierarchy, showSearch: this.showSearch, searchQuery: this.searchQuery };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    if (state && typeof state === "object") {
      if (TAG_SORTS.some(([k]) => k === state.sortOrder)) this.sortOrder = state.sortOrder;
      if (typeof state.useHierarchy === "boolean") this.useHierarchy = state.useHierarchy;
      if (typeof state.showSearch === "boolean") this.showSearch = state.showSearch;
      if (typeof state.searchQuery === "string") this.searchQuery = state.searchQuery;
      if (this.containerTagEl) {
        this.filter.component.setValue(this.searchQuery);
        this.applyButtons();
        this.render();
      }
    }
    await super.setState(state, result);
  }

  private applyButtons() {
    setButtonState(this.buttons.search!, this.showSearch);
    setButtonState(this.buttons.nested!, this.useHierarchy, undefined, this.useHierarchy ? "Show flat tags" : "Show nested tags");
    this.buttons.collapse!.toggle(this.useHierarchy);
    this.filter.show(this.showSearch);
    if (this.filter.component.getValue() !== this.searchQuery) this.filter.component.setValue(this.searchQuery);
  }

  private allParents(): string[] {
    const out: string[] = [];
    const walk = (nodes: Iterable<TagNode>) => {
      for (const n of nodes) {
        if (n.children.size) {
          out.push(n.tag.toLowerCase());
          walk(n.children.values());
        }
      }
    };
    walk(buildTagTree(this.app.metadataCache.getTags(), true));
    return out;
  }

  private sortNodes(nodes: TagNode[]): TagNode[] {
    const byName = (a: TagNode, b: TagNode) => compareNames(a.name, b.name);
    switch (this.sortOrder) {
      case "alphabeticalReverse":
        return nodes.sort((a, b) => byName(b, a));
      case "frequency":
        return nodes.sort((a, b) => b.total - a.total || byName(a, b));
      case "frequencyReverse":
        return nodes.sort((a, b) => a.total - b.total || byName(a, b));
      default:
        return nodes.sort(byName);
    }
  }

  render() {
    if (!this.containerTagEl) return;
    const scroll = this.contentEl.scrollTop;
    const tags: Record<string, number> = this.app.metadataCache.getTags() ?? {};
    const nodes = buildTagTree(tags, this.useHierarchy);
    const q = this.searchQuery.trim().toLowerCase().replace(/^#/, "");
    const matches = (n: TagNode): boolean => !q || n.tag.toLowerCase().includes(q) || Array.from(n.children.values()).some(matches);
    this.containerTagEl.empty();
    const renderLevel = (list: TagNode[], parentEl: HTMLElement) => {
      for (const node of this.sortNodes(list.filter(matches))) this.renderTag(node, parentEl, q, matches, renderLevel);
    };
    renderLevel(nodes, this.containerTagEl);
    if (!this.containerTagEl.firstChild) this.containerTagEl.createDiv({ cls: "pane-empty", text: q ? "No matching tags." : "No tags found." });
    this.contentEl.scrollTop = scroll;
  }

  private renderTag(node: TagNode, parentEl: HTMLElement, q: string, matches: (n: TagNode) => boolean, renderLevel: (list: TagNode[], el: HTMLElement) => void) {
    const key = node.tag.toLowerCase();
    const hasChildren = this.useHierarchy && node.children.size > 0;
    const collapsed = hasChildren && this.collapsed.has(key) && !q;
    const item = parentEl.createDiv({ cls: "tree-item", attr: { "data-tag": node.tag } });
    item.toggleClass("mod-collapsible", hasChildren);
    item.toggleClass("is-collapsed", collapsed);
    const self = item.createDiv({ cls: "tree-item-self tag-pane-tag is-clickable", attr: { draggable: "true", "data-tag": node.tag } });
    self.toggleClass("mod-collapsible", hasChildren);
    if (hasChildren) {
      const icon = self.createDiv({ cls: "tree-item-icon collapse-icon" });
      icon.toggleClass("is-collapsed", collapsed);
      setIcon(icon, "right-triangle");
      icon.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (this.collapsed.has(key)) this.collapsed.delete(key);
        else this.collapsed.add(key);
        this.render();
      });
    }
    const inner = self.createDiv({ cls: "tree-item-inner" });
    const text = inner.createSpan({ cls: "tree-item-inner-text tag-pane-tag-text" });
    const slash = node.tag.lastIndexOf("/");
    const parentPart = this.useHierarchy && slash !== -1 ? node.tag.slice(0, slash + 1) : "";
    const parentSpan = text.createSpan({ cls: "tag-pane-tag-parent", text: parentPart });
    parentSpan.hide();
    const selfText = parentPart ? node.tag.slice(slash + 1) : node.tag;
    const selfSpan = text.createSpan({ cls: "tag-pane-tag-self" });
    const idx = q ? selfText.toLowerCase().indexOf(q) : -1;
    if (idx >= 0) {
      selfSpan.appendText(selfText.slice(0, idx));
      selfSpan.createSpan({ cls: "search-result-file-matched-text", text: selfText.slice(idx, idx + q.length) });
      selfSpan.appendText(selfText.slice(idx + q.length));
    } else selfSpan.setText(selfText);
    const count = this.useHierarchy ? node.total : node.own;
    self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair tag-pane-tag-count", text: String(count) });

    self.addEventListener("click", (evt) => this.onTagClick(evt, node.tag));
    self.addEventListener("contextmenu", (evt) => this.onTagContextMenu(evt, node.tag, self));
    self.addEventListener("dragstart", (evt) => {
      evt.dataTransfer?.setData("text/plain", `#${node.tag}`);
      if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "copy";
      this.app.dragManager?.onDragStart?.(evt, { type: "link", icon: "lucide-tag", title: `#${node.tag}`, linktext: `#${node.tag}` });
    });

    if (hasChildren) {
      const children = item.createDiv({ cls: "tree-item-children" });
      if (!collapsed) renderLevel(Array.from(node.children.values()), children);
    }
  }

  /** "Rename tag…" and "Search for tag"; Tag Wrangler, when enabled, owns this menu. */
  private onTagContextMenu(evt: MouseEvent, tag: string, el: HTMLElement) {
    if (this.app.plugins?.enabledPlugins?.has?.(TAG_WRANGLER_PLUGIN)) return;
    evt.preventDefault();
    const menu = new Menu();
    menu.addItem((i) => i.setSection("action").setTitle("Rename tag...").setIcon("lucide-pencil").onClick(() => new RenameTagModal(this.app, tag).open()));
    menu.addItem((i) =>
      i
        .setSection("action")
        .setTitle("Search for tag")
        .setIcon("lucide-search")
        .onClick(() => this.app.internalPlugins.getEnabledPluginById("global-search")?.openGlobalSearch?.(`tag:#${tag}`)),
    );
    menu.setParentElement?.(el);
    menu.showAtMouseEvent(evt);
  }

  private onTagClick(evt: MouseEvent, tag: string) {
    const search = this.app.internalPlugins.getEnabledPluginById("global-search");
    if (!search?.openGlobalSearch) return;
    const term = `tag:#${tag}`;
    if (Keymap.isModEvent(evt)) {
      // Mod+click toggles the tag in the current query.
      const current: string = search.getGlobalSearchQuery?.() ?? "";
      const escaped = term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      const re = new RegExp(`(^|\\s)-?${escaped}(?=\\s|$)`, "i");
      const next = re.test(current) ? current.replace(re, "").replace(/\s+/g, " ").trim() : `${current.trim()} ${term}`.trim();
      search.openGlobalSearch(next);
      return;
    }
    search.openGlobalSearch(term);
  }
}

class TagPanePlugin extends Plugin {
  instance!: any;
  override async onload() {
    this.registerView(VIEW_TYPE_TAG, (leaf: WorkspaceLeaf) => new TagPaneView(leaf));
    this.addCommand({ id: "tag-pane:open", name: "Tags: Show tags", icon: "lucide-tags", callback: () => void showSideView(this.app, VIEW_TYPE_TAG) });
    // internal (used by tests and plugins): rename a tag across the vault
    this.instance.renameTag = (from: string, to: string) => renameTag(this.app, from, to);
    this.instance.openRenameTag = (tag: string) => new RenameTagModal(this.app, tag).open();
  }
}

export const tagPane: CorePluginDefinition = {
  id: "tag-pane",
  name: "Tags view",
  description: "Show a list of all tags and their number of occurrences.",
  icon: "lucide-tags",
  defaultOn: true,
  defaultOptions: {},
  create: (app) => new TagPanePlugin(app, { id: "tag-pane", name: "Tags view", version: "", minAppVersion: "", author: "", description: "" }),
};
