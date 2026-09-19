/**
 * Outline (`outline`): the headings of the active Markdown note as a tree.
 *
 * DOM: `.outline > .tree-item > .tree-item-self.is-clickable[.is-active] >
 * (.tree-item-icon.collapse-icon) .tree-item-inner`, children in
 * `.tree-item-children`.
 *
 * Click scrolls the note to the heading; the heading under the cursor (or at
 * the top of the viewport) is highlighted; dragging a heading onto another
 * moves its section in the note, and dragging it out creates a link.
 *
 * View state (Obsidian's keys): file, followCursor, showSearch, searchQuery.
 */
import type { CachedMetadata, HeadingCache, ViewStateResult } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { debounce, stripHeadingForLink } from "../../obsidian/util";
import { TFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { FileInfoView, FilterBox, findViewForFile, NavHeader, openLinkedView, setButtonState, showSideView, stripInlineMarkdown } from "../global-search/common";

export const VIEW_TYPE_OUTLINE = "outline";

interface HeadingNode {
  index: number;
  heading: HeadingCache;
  text: string;
  key: string;
  children: HeadingNode[];
  el?: HTMLElement;
  selfEl?: HTMLElement;
}

export function buildHeadingTree(headings: HeadingCache[]): HeadingNode[] {
  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  const seen = new Map<string, number>();
  headings.forEach((h, index) => {
    const base = `${h.level}:${h.heading}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const node: HeadingNode = { index, heading: h, text: stripInlineMarkdown(h.heading), key: `${base}:${n}`, children: [] };
    while (stack.length && stack[stack.length - 1]!.heading.level >= h.level) stack.pop();
    if (stack.length) stack[stack.length - 1]!.children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  return roots;
}

/** ATX headings of `text` (outside frontmatter and code fences): [lineStartOffset, level, text]. */
function scanHeadings(text: string): { start: number; level: number; text: string }[] {
  const out: { start: number; level: number; text: string }[] = [];
  let offset = 0;
  let fence: string | null = null;
  const lines = text.split("\n");
  let i = 0;
  if (lines[0] === "---" || lines[0] === "---\r") {
    for (i = 1; i < lines.length; i++) {
      offset += lines[i - 1]!.length + 1;
      if (/^(---|\.\.\.)\s*$/.test(lines[i]!)) {
        offset += lines[i]!.length + 1;
        i++;
        break;
      }
    }
    if (i >= lines.length) {
      i = 0;
      offset = 0;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]!;
      else if (f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
    } else if (!fence) {
      const h = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*\r?$/.exec(line);
      if (h) out.push({ start: offset, level: h[1]!.length, text: h[2]!.trim() });
    }
    offset += line.length + 1;
  }
  return out;
}

export class OutlineView extends FileInfoView {
  followCursor = false;
  showSearch = false;
  searchQuery = "";
  hoverPopover: any = null;
  headerDom!: NavHeader;
  filter!: FilterBox;
  outlineEl!: HTMLElement;
  private nodes: HeadingNode[] = [];
  private flat: HeadingNode[] = [];
  private collapsed = new Set<string>();
  private buttons: Record<string, HTMLElement> = {};
  private activeIndex = -1;
  private dragging: HeadingNode | null = null;
  private requestRender = debounce(() => this.render(), 200, true);
  private requestTrack = debounce(() => this.trackCurrentHeading(), 50, true);
  private trackedView: any = null;
  private detachTracking: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "lucide-list";
  }

  getViewType() {
    return VIEW_TYPE_OUTLINE;
  }

  getDisplayText() {
    return this.file ? `Outline of ${this.file.basename}` : "Outline";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.headerDom = new NavHeader(this.contentEl, false);
    this.buttons.collapse = this.headerDom.addButton("lucide-chevrons-down-up", "Collapse all", () => {
      const parents = this.flat.filter((n) => n.children.length);
      const anyExpanded = parents.some((n) => !this.collapsed.has(n.key));
      if (anyExpanded) for (const n of parents) this.collapsed.add(n.key);
      else this.collapsed.clear();
      setButtonState(this.buttons.collapse!, false, anyExpanded ? "lucide-chevrons-up-down" : "lucide-chevrons-down-up", anyExpanded ? "Expand all" : "Collapse all");
      this.render();
    });
    this.buttons.follow = this.headerDom.addButton("lucide-locate-fixed", "Auto-scroll to current section", () => {
      this.followCursor = !this.followCursor;
      this.applyButtons();
      this.trackCurrentHeading();
      this.app.workspace.requestSaveLayout();
    });
    this.buttons.search = this.headerDom.addButton("lucide-search", "Show search filter", () => {
      this.showSearch = !this.showSearch;
      if (!this.showSearch) this.searchQuery = "";
      this.applyButtons();
      if (this.showSearch) this.filter.component.inputEl.focus();
      this.render();
      this.app.workspace.requestSaveLayout();
    });
    this.filter = new FilterBox(this.contentEl, "Search...", (v) => {
      this.searchQuery = v;
      this.render();
      this.app.workspace.requestSaveLayout();
    });
    this.outlineEl = this.contentEl.createDiv({ cls: "outline" });
    this.applyButtons();
    this.registerEvent(
      this.app.metadataCache.on("changed", (f: TFile) => {
        if (f === this.file) this.requestRender();
      }),
    );
    this.registerEvent(this.app.workspace.on("layout-change", () => this.attachTracking()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.attachTracking()));
    this.registerDomEvent(document, "selectionchange", () => this.requestTrack());
    this.register(() => this.detachTracking?.());
    await super.onOpen();
  }

  onFileChanged(): void {
    this.activeIndex = -1;
    this.render();
    this.attachTracking();
  }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), followCursor: this.followCursor, showSearch: this.showSearch, searchQuery: this.searchQuery };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    if (state && typeof state === "object") {
      if (typeof state.followCursor === "boolean") this.followCursor = state.followCursor;
      if (typeof state.showSearch === "boolean") this.showSearch = state.showSearch;
      if (typeof state.searchQuery === "string") this.searchQuery = state.searchQuery;
      if (this.outlineEl) {
        this.applyButtons();
        this.render();
      }
    }
    await super.setState(state, result);
  }

  private applyButtons() {
    setButtonState(this.buttons.follow!, this.followCursor);
    setButtonState(this.buttons.search!, this.showSearch);
    this.filter.show(this.showSearch);
    if (this.filter.component.getValue() !== this.searchQuery) this.filter.component.setValue(this.searchQuery);
  }

  render() {
    if (!this.outlineEl) return;
    const file = this.file;
    this.outlineEl.empty();
    this.nodes = [];
    this.flat = [];
    if (!file || file.extension !== "md") {
      this.outlineEl.createDiv({ cls: "pane-empty", text: "No headings found." });
      return;
    }
    const cache = this.app.metadataCache.getFileCache(file) as CachedMetadata | null;
    const headings = cache?.headings ?? [];
    this.nodes = buildHeadingTree(headings);
    const walk = (list: HeadingNode[]) => {
      for (const n of list) {
        this.flat.push(n);
        walk(n.children);
      }
    };
    walk(this.nodes);
    this.flat.sort((a, b) => a.index - b.index);
    const q = this.searchQuery.trim().toLowerCase();
    const visible = (n: HeadingNode): boolean => !q || n.text.toLowerCase().includes(q) || n.children.some(visible);
    const renderLevel = (list: HeadingNode[], parentEl: HTMLElement) => {
      for (const n of list) if (visible(n)) this.renderNode(n, parentEl, q, renderLevel);
    };
    renderLevel(this.nodes, this.outlineEl);
    if (!this.outlineEl.firstChild) this.outlineEl.createDiv({ cls: "pane-empty", text: q ? "No matching headings." : "No headings found." });
    this.highlight(this.activeIndex, false);
    this.requestTrack();
  }

  private renderNode(node: HeadingNode, parentEl: HTMLElement, q: string, renderLevel: (list: HeadingNode[], el: HTMLElement) => void) {
    const hasChildren = node.children.length > 0;
    const collapsed = hasChildren && this.collapsed.has(node.key) && !q;
    const item = parentEl.createDiv({ cls: "tree-item", attr: { "data-level": String(node.heading.level) } });
    item.toggleClass("is-collapsed", collapsed);
    const self = item.createDiv({ cls: "tree-item-self is-clickable", attr: { draggable: "true", "data-line": String(node.heading.position.start.line) } });
    self.toggleClass("mod-collapsible", hasChildren);
    node.el = item;
    node.selfEl = self;
    if (hasChildren) {
      const icon = self.createDiv({ cls: "tree-item-icon collapse-icon" });
      icon.toggleClass("is-collapsed", collapsed);
      setIcon(icon, "right-triangle");
      icon.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (this.collapsed.has(node.key)) this.collapsed.delete(node.key);
        else this.collapsed.add(node.key);
        this.render();
      });
    }
    const inner = self.createDiv({ cls: "tree-item-inner" });
    const idx = q ? node.text.toLowerCase().indexOf(q) : -1;
    if (idx >= 0) {
      inner.appendText(node.text.slice(0, idx));
      inner.createSpan({ cls: "search-result-file-matched-text", text: node.text.slice(idx, idx + q.length) });
      inner.appendText(node.text.slice(idx + q.length));
    } else inner.setText(node.text);

    self.addEventListener("click", () => this.navigate(node));
    self.addEventListener("dragstart", (evt) => this.onDragStart(evt, node));
    self.addEventListener("dragend", () => {
      this.dragging = null;
      this.outlineEl.findAll(".is-drop-before, .is-drop-after").forEach((el) => el.removeClasses(["is-drop-before", "is-drop-after"]));
    });
    self.addEventListener("dragover", (evt) => this.onDragOver(evt, node, self));
    self.addEventListener("dragleave", () => self.removeClasses(["is-drop-before", "is-drop-after"]));
    self.addEventListener("drop", (evt) => this.onDrop(evt, node, self));
    if (hasChildren) {
      const children = item.createDiv({ cls: "tree-item-children" });
      if (!collapsed) renderLevel(node.children, children);
    }
  }

  // ---- navigation ---------------------------------------------------------------

  /** The Markdown view showing this outline's file (the linked partner first, then the most recent). */
  private targetView(): any {
    return findViewForFile(this.app, this.leaf, this.file);
  }

  async navigate(node: HeadingNode) {
    const file = this.file;
    if (!file) return;
    const line = node.heading.position.start.line;
    const view = this.targetView();
    if (!view) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file, { active: true, eState: { line } });
      return;
    }
    const leaf = view.leaf as WorkspaceLeaf;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    leaf.setEphemeralState({ line, focus: true });
    const editor = view.editor;
    const mode = typeof view.getMode === "function" ? view.getMode() : "source";
    if (editor && mode !== "preview") {
      try {
        const pos = { line, ch: 0 };
        editor.setCursor(pos);
        editor.scrollIntoView({ from: pos, to: pos }, true);
        editor.focus();
      } catch {
        /* the view handles eState itself */
      }
    } else if (mode === "preview") {
      const headingsEls = this.previewHeadingEls(view);
      headingsEls[node.index]?.scrollIntoView({ block: "start" });
    }
    this.highlight(node.index, true);
  }

  // ---- current heading ----------------------------------------------------------

  private attachTracking() {
    const view = this.targetView();
    if (view === this.trackedView) return;
    this.detachTracking?.();
    this.detachTracking = null;
    this.trackedView = view;
    if (!view?.containerEl) return;
    const el: HTMLElement = view.containerEl;
    const onScroll = () => this.requestTrack();
    el.addEventListener("scroll", onScroll, true);
    el.addEventListener("keyup", onScroll, true);
    el.addEventListener("mouseup", onScroll, true);
    this.detachTracking = () => {
      el.removeEventListener("scroll", onScroll, true);
      el.removeEventListener("keyup", onScroll, true);
      el.removeEventListener("mouseup", onScroll, true);
    };
    this.requestTrack();
  }

  private previewHeadingEls(view: any): HTMLElement[] {
    const root: HTMLElement | undefined = view?.containerEl;
    if (!root) return [];
    return root.findAll(".markdown-reading-view .markdown-preview-sizer > div > :is(h1,h2,h3,h4,h5,h6), .markdown-preview-view .markdown-preview-sizer > div > :is(h1,h2,h3,h4,h5,h6)") as HTMLElement[];
  }

  private currentLine(view: any): number | null {
    const mode = typeof view.getMode === "function" ? view.getMode() : "source";
    if (mode === "preview") return null;
    const editor = view.editor;
    const cm = editor?.cm;
    if (!cm) return null;
    if (editor.hasFocus?.()) return editor.getCursor().line;
    const rect = cm.scrollDOM.getBoundingClientRect();
    const block = cm.lineBlockAtHeight(rect.top - cm.documentTop + 4);
    return cm.state.doc.lineAt(block.from).number - 1;
  }

  trackCurrentHeading() {
    if (!this.file || !this.flat.length) return;
    const view = this.trackedView ?? this.targetView();
    if (!view || view.file !== this.file) return;
    let index = -1;
    const line = this.currentLine(view);
    if (line !== null) {
      for (const n of this.flat) if (n.heading.position.start.line <= line) index = n.index;
    } else {
      const els = this.previewHeadingEls(view);
      const container = view.containerEl.querySelector(".markdown-preview-view") as HTMLElement | null;
      const top = (container?.getBoundingClientRect().top ?? 0) + 8;
      els.forEach((el, i) => {
        if (el.getBoundingClientRect().top <= top) index = i;
      });
      if (index === -1 && els.length) index = -1;
    }
    this.highlight(index, this.followCursor);
  }

  private highlight(index: number, scroll: boolean) {
    this.activeIndex = index;
    for (const n of this.flat) n.selfEl?.toggleClass("is-active", n.index === index);
    if (scroll && index >= 0) {
      const node = this.flat.find((n) => n.index === index);
      node?.selfEl?.scrollIntoView({ block: "nearest" });
    }
  }

  // ---- drag -----------------------------------------------------------------------

  private onDragStart(evt: DragEvent, node: HeadingNode) {
    const file = this.file;
    if (!file) return;
    this.dragging = node;
    const linktext = `${this.app.metadataCache.fileToLinktext(file, "", true)}#${stripHeadingForLink(node.heading.heading)}`;
    const dm = this.app.dragManager;
    const data = dm?.dragLink?.(evt, linktext, "", node.text);
    if (data) dm.onDragStart(evt, data);
    else evt.dataTransfer?.setData("text/plain", `[[${linktext}]]`);
    if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "copyMove";
  }

  private isInside(node: HeadingNode, maybeChild: HeadingNode): boolean {
    if (node === maybeChild) return true;
    return node.children.some((c) => this.isInside(c, maybeChild));
  }

  private onDragOver(evt: DragEvent, node: HeadingNode, self: HTMLElement) {
    const drag = this.dragging;
    if (!drag || this.isInside(drag, node)) return;
    evt.preventDefault();
    if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
    const r = self.getBoundingClientRect();
    const before = evt.clientY < r.top + r.height / 2;
    self.toggleClass("is-drop-before", before);
    self.toggleClass("is-drop-after", !before);
  }

  private async onDrop(evt: DragEvent, node: HeadingNode, self: HTMLElement) {
    const drag = this.dragging;
    self.removeClasses(["is-drop-before", "is-drop-after"]);
    if (!drag || !this.file || this.isInside(drag, node)) return;
    evt.preventDefault();
    evt.stopPropagation();
    const r = self.getBoundingClientRect();
    const before = evt.clientY < r.top + r.height / 2;
    this.dragging = null;
    await this.moveSection(drag.index, node.index, before, drag.heading.level, node.heading.level);
  }

  /** Moves heading `from`'s section before heading `to` or after `to`'s whole section. */
  async moveSection(from: number, to: number, before: boolean, fromLevel?: number, toLevel?: number) {
    const file = this.file;
    if (!file) return;
    const transform = (text: string): string | null => {
      const hs = scanHeadings(text);
      const a = hs[from];
      const b = hs[to];
      if (!a || !b) return null;
      if ((fromLevel !== undefined && a.level !== fromLevel) || (toLevel !== undefined && b.level !== toLevel)) return null;
      const sectionEnd = (i: number) => {
        const lvl = hs[i]!.level;
        for (let j = i + 1; j < hs.length; j++) if (hs[j]!.level <= lvl) return hs[j]!.start;
        return text.length;
      };
      const s = a.start;
      const e = sectionEnd(from);
      const insertAt = before ? b.start : sectionEnd(to);
      if (insertAt >= s && insertAt <= e) return null;
      let chunk = text.slice(s, e);
      if (!chunk.endsWith("\n")) chunk += "\n";
      let rest = text.slice(0, s) + text.slice(e);
      let at = insertAt > e ? insertAt - (e - s) : insertAt;
      if (at > 0 && rest[at - 1] !== "\n") {
        rest = rest.slice(0, at) + "\n" + rest.slice(at);
        at++;
      }
      rest = rest.slice(0, at) + chunk + rest.slice(at);
      return rest.endsWith("\n\n") && !text.endsWith("\n\n") ? rest.slice(0, -1) : rest;
    };
    const view = this.targetView();
    const editor = view?.editor;
    if (editor && view.file === file && typeof editor.getValue === "function") {
      const text = editor.getValue();
      const next = transform(text);
      if (next === null || next === text) return;
      let p = 0;
      while (p < text.length && p < next.length && text[p] === next[p]) p++;
      let q = 0;
      while (q < text.length - p && q < next.length - p && text[text.length - 1 - q] === next[next.length - 1 - q]) q++;
      editor.replaceRange(next.slice(p, next.length - q), editor.offsetToPos(p), editor.offsetToPos(text.length - q));
      return;
    }
    await this.app.vault.process(file, (text: string) => transform(text) ?? text);
  }
}

class OutlinePlugin extends Plugin {
  instance!: any;
  override async onload() {
    this.registerView(VIEW_TYPE_OUTLINE, (leaf: WorkspaceLeaf) => new OutlineView(leaf));
    this.addCommand({ id: "outline:open", name: "Outline: Show outline", icon: "lucide-list", callback: () => void showSideView(this.app, VIEW_TYPE_OUTLINE) });
    this.addCommand({
      id: "outline:open-for-current",
      name: "Outline: Open outline of the current file",
      icon: "lucide-list",
      checkCallback: (checking: boolean) => {
        const f = this.app.workspace.getActiveFile() as TFile | null;
        if (!f || f.extension !== "md") return false;
        if (!checking) void openLinkedView(this.app, VIEW_TYPE_OUTLINE);
        return true;
      },
    });
  }
}

export const outline: CorePluginDefinition = {
  id: "outline",
  name: "Outline",
  description: "Show the table of contents for the current note.",
  icon: "lucide-list",
  defaultOn: true,
  defaultOptions: {},
  create: (app) => new OutlinePlugin(app, { id: "outline", name: "Outline", version: "", minAppVersion: "", author: "", description: "" }),
};
