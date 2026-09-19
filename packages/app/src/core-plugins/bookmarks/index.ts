/**
 * Core plugin Bookmarks (`bookmarks`).
 *
 * Instance API (`app.internalPlugins.getPluginById("bookmarks").instance`),
 * as community plugins use it:
 *   items                       the top-level tree (live; mutate through the methods)
 *   getBookmarks()              every non-group bookmark, flattened
 *   addItem(item, group?, i?)   add (to a group, at an index)
 *   removeItem(item)            remove an item or a group with its contents
 *   moveItem(item, group, i)    reorder / regroup
 *   editItem(item)              open the Edit bookmark dialog
 *   getItemTitle(item)          the shown title
 *   openBookmark(item, newLeaf) open it as a click would
 *   findBookmarkByPath(path)    the file/folder bookmark for a path, if any
 *   saveData() / onItemsChanged(save)
 *   on("changed", cb) / off / trigger
 */
import type { Editor } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Events } from "../../obsidian/events";
import { Plugin } from "../../obsidian/plugin";
import type { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { debounce } from "../../obsidian/util";
import { TFile, TFolder, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { BookmarkModal } from "./modal";
import { customTitle } from "../file-explorer/note-titles";
import { defaultTitle, findParent, sanitizeItems, walkItems, type BookmarkItem } from "./model";
import { BookmarksView, VIEW_TYPE_BOOKMARKS } from "./view";

type PaneType = "tab" | "split" | "window" | boolean;

export class BookmarksPlugin extends Plugin {
  instance!: any;
  items: BookmarkItem[] = [];
  // internal
  events = new Events();
  private requestSave = debounce(() => void this.saveBookmarks(), 500, true);

  override async onload() {
    await this.loadItems();
    this.registerView(VIEW_TYPE_BOOKMARKS, (leaf: WorkspaceLeaf) => new BookmarksView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE_BOOKMARKS, { display: "Bookmarks", defaultMod: true });
    this.publishInstance();
    this.addCommands();
    this.registerMenus();

    // Keep paths current when files move; a deleted file's bookmark stays (shown unresolved).
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        let changed = false;
        walkItems(this.items, (item) => {
          if ((item.type === "file" || item.type === "folder") && item.path === oldPath) {
            item.path = file.path;
            changed = true;
          }
        });
        if (changed) this.onItemsChanged(true);
      }),
    );
    this.registerEvent(this.app.vault.on("delete", () => this.events.trigger("changed")));
    this.registerEvent(this.app.vault.on("create", () => this.events.trigger("changed")));
  }

  override onunload() {
    this.requestSave.run();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_BOOKMARKS);
  }

  // ---- storage ---------------------------------------------------------------------

  private async loadItems() {
    const data = await this.app.vault.readConfigJson("bookmarks.json");
    if (data && typeof data === "object") {
      this.items = sanitizeItems(data.items);
      return;
    }
    // Vaults from before Obsidian 1.2 have "Starred" instead.
    const starred = await this.app.vault.readConfigJson("starred.json");
    if (starred && Array.isArray(starred.items)) {
      this.items = sanitizeItems(
        starred.items.map((s: { type?: string; path?: string; query?: string; title?: string }) => ({ ...s, ctime: Date.now() })),
      );
      if (this.items.length) await this.saveBookmarks();
    }
  }

  async saveBookmarks() {
    await this.app.vault.writeConfigJson("bookmarks.json", { items: this.items });
  }

  onItemsChanged(save: boolean) {
    if (save) this.requestSave();
    this.events.trigger("changed");
  }

  private publishInstance() {
    const inst = this.instance;
    const methods: Record<string, unknown> = {
      getBookmarks: () => this.getBookmarks(),
      addItem: (item: BookmarkItem, group?: BookmarkItem | null, index?: number) => this.addItem(item, group ?? null, index),
      removeItem: (item: BookmarkItem) => this.removeItem(item),
      moveItem: (item: BookmarkItem, group: BookmarkItem | null, index?: number) => this.moveItem(item, group, index),
      editItem: (item: BookmarkItem) => this.editItem(item),
      getItemTitle: (item: BookmarkItem) => this.getItemTitle(item),
      openBookmark: (item: BookmarkItem, newLeaf?: PaneType) => this.openBookmark(item, newLeaf ?? false),
      findBookmarkByPath: (path: string) => this.findBookmarkByPath(path),
      saveData: () => this.saveBookmarks(),
      onItemsChanged: (save = true) => this.onItemsChanged(save),
      on: (name: string, cb: (...a: unknown[]) => unknown, ctx?: unknown) => this.events.on(name, cb, ctx),
      off: (name: string, cb: (...a: unknown[]) => unknown) => this.events.off(name, cb),
      offref: (ref: any) => this.events.offref(ref),
      trigger: (name: string, ...args: unknown[]) => this.events.trigger(name, ...args),
    };
    Object.assign(inst, methods);
    Object.defineProperty(inst, "items", { configurable: true, enumerable: false, get: () => this.items });
    this.register(() => {
      for (const k of Object.keys(methods)) delete inst[k];
      delete inst.items;
    });
  }

  // ---- tree operations -----------------------------------------------------------------

  getBookmarks(): BookmarkItem[] {
    const out: BookmarkItem[] = [];
    walkItems(this.items, (i) => {
      if (i.type !== "group") out.push(i);
    });
    return out;
  }

  private childrenOf(group: BookmarkItem | null): BookmarkItem[] {
    if (!group) return this.items;
    group.items ??= [];
    return group.items;
  }

  addItem(item: BookmarkItem, group: BookmarkItem | null = null, index?: number) {
    item.ctime ??= Date.now();
    if (item.type === "group") item.items ??= [];
    const list = this.childrenOf(group);
    list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, item);
    this.onItemsChanged(true);
  }

  removeItem(item: BookmarkItem) {
    const parent = findParent(this.items, item);
    if (parent === undefined) return;
    this.childrenOf(parent).remove(item);
    this.onItemsChanged(true);
  }

  moveItem(item: BookmarkItem, group: BookmarkItem | null, index?: number) {
    const parent = findParent(this.items, item);
    if (parent === undefined) return;
    const from = this.childrenOf(parent);
    const to = this.childrenOf(group);
    let at = index ?? to.length;
    const oldIndex = from.indexOf(item);
    if (from === to && oldIndex < at) at--;
    from.splice(oldIndex, 1);
    to.splice(Math.max(0, Math.min(at, to.length)), 0, item);
    this.onItemsChanged(true);
  }

  getItemTitle(item: BookmarkItem): string {
    if (!item.title && item.type === "file" && !item.subpath && item.path) {
      const title = customTitle(this.app, this.app.vault.getFileByPath(item.path));
      if (title) return title;
    }
    return item.title || defaultTitle(item, () => this.app.vault.getName());
  }

  findBookmarkByPath(path: string, subpath?: string): BookmarkItem | null {
    let found: BookmarkItem | null = null;
    walkItems(this.items, (i) => {
      if ((i.type === "file" || i.type === "folder") && i.path === path && (i.subpath ?? "") === (subpath ?? "")) {
        found = i;
        return true;
      }
    });
    return found;
  }

  async openBookmark(item: BookmarkItem, newLeaf: PaneType) {
    const { workspace, vault } = this.app;
    switch (item.type) {
      case "file": {
        const file = vault.getFileByPath(item.path ?? "");
        if (!file) {
          new Notice(`“${item.path}” was not found in the vault.`);
          return;
        }
        const leaf = workspace.getLeaf(newLeaf);
        await leaf.openFile(file, { active: true, eState: item.subpath ? { subpath: item.subpath } : undefined });
        return;
      }
      case "folder": {
        const folder = vault.getAbstractFileByPath(item.path || "/");
        const explorer = this.app.internalPlugins.getEnabledPluginById("file-explorer");
        if (folder && explorer?.revealInFolder) explorer.revealInFolder(folder);
        else new Notice(`“${item.path}” was not found in the vault.`);
        return;
      }
      case "search": {
        const search = this.app.internalPlugins.getEnabledPluginById("global-search");
        if (search?.openGlobalSearch) search.openGlobalSearch(item.query ?? "");
        else new Notice("Enable the Search core plugin to open search bookmarks.");
        return;
      }
      case "graph": {
        if (!this.app.internalPlugins.getEnabledPluginById("graph")) {
          new Notice("Enable the Graph view core plugin to open graph bookmarks.");
          return;
        }
        const leaf = workspace.getLeaf(newLeaf);
        await leaf.setViewState({ type: "graph", active: true, state: item.options ? { options: item.options } : {} });
        return;
      }
      case "url": {
        const url = item.url ?? "";
        const web = this.app.internalPlugins.getEnabledPluginById("webviewer");
        if (web?.options?.openExternalURLs && /^https?:/i.test(url)) {
          await workspace.getLeaf(newLeaf || "tab").setViewState({ type: "webviewer", active: true, state: { url, navigate: true } });
        } else window.open(url, "_blank", "noopener");
        return;
      }
      case "group":
        return;
    }
  }

  // ---- dialogs ------------------------------------------------------------------------

  /** "Add bookmark" for a new item; edits instead when the same target is bookmarked. */
  promptAdd(item: BookmarkItem) {
    const existing = item.type === "file" || item.type === "folder" ? this.findBookmarkByPath(item.path ?? "", item.subpath) : null;
    if (existing) {
      this.editItem(existing);
      return;
    }
    new BookmarkModal(this, {
      heading: "Add bookmark",
      item,
      group: null,
      onSave: ({ title, target, group }) => {
        if (title) item.title = title;
        this.applyTarget(item, target);
        this.addItem(item, group);
      },
    }).open();
  }

  editItem(item: BookmarkItem) {
    const current = findParent(this.items, item) ?? null;
    new BookmarkModal(this, {
      heading: "Edit bookmark",
      item,
      group: current,
      onSave: ({ title, target, group }) => {
        if (title) item.title = title;
        else delete item.title;
        this.applyTarget(item, target);
        if (group !== current) this.moveItem(item, group);
        else this.onItemsChanged(true);
      },
    }).open();
  }

  private applyTarget(item: BookmarkItem, target: string) {
    if (!target) return;
    if (item.type === "search") item.query = target;
    else if (item.type === "url") item.url = target;
    else if (item.type === "file" || item.type === "folder") {
      const hash = item.type === "file" ? target.indexOf("#") : -1;
      item.path = hash === -1 ? target : target.slice(0, hash);
      if (hash === -1) delete item.subpath;
      else item.subpath = target.slice(hash);
    }
  }

  /** Bookmark several files at once, into a chosen group. */
  promptAddMany(files: TAbstractFile[]) {
    new BookmarkModal(this, {
      heading: `Bookmark ${files.length} items`,
      item: null,
      group: null,
      onSave: ({ group }) => {
        for (const f of files) {
          if (this.findBookmarkByPath(f.path)) continue;
          this.childrenOf(group).push({ type: f instanceof TFolder ? "folder" : "file", ctime: Date.now(), path: f.path });
        }
        this.onItemsChanged(true);
      },
    }).open();
  }

  newGroup(parent: BookmarkItem | null = null): BookmarkItem {
    const group: BookmarkItem = { type: "group", ctime: Date.now(), items: [], title: "" };
    this.addItem(group, parent);
    return group;
  }

  // ---- current view ------------------------------------------------------------------

  /** What "Bookmark..." would bookmark for a leaf, or null. */
  itemForLeaf(leaf: WorkspaceLeaf | null): BookmarkItem | null {
    const view: any = leaf?.view;
    if (!view) return null;
    const type = view.getViewType();
    const ctime = Date.now();
    if (type === "search") {
      const query = view.getQuery?.() ?? "";
      return query ? { type: "search", ctime, query } : null;
    }
    if (type === "graph") return { type: "graph", ctime, options: view.getState?.()?.options ?? {} };
    if (type === "webviewer") {
      const url = view.getState?.()?.url;
      return typeof url === "string" && url ? { type: "url", ctime, url, title: view.getDisplayText?.() } : null;
    }
    if (view.file instanceof TFile) return { type: "file", ctime, path: view.file.path };
    return null;
  }

  private addCommands() {
    const { workspace } = this.app;
    this.addCommand({
      id: "bookmarks:open",
      name: "Bookmarks: Show bookmarks",
      callback: async () => {
        const leaf = await workspace.ensureSideLeaf(VIEW_TYPE_BOOKMARKS, "left", { reveal: true });
        workspace.setActiveLeaf(leaf, { focus: true });
      },
    });
    this.addCommand({
      id: "bookmarks:bookmark-current-view",
      name: "Bookmarks: Bookmark...",
      icon: "lucide-bookmark",
      checkCallback: (checking) => {
        const item = this.itemForLeaf(workspace.activeLeaf);
        if (!item) return false;
        if (!checking) this.promptAdd(item);
        return true;
      },
    });
    this.addCommand({
      id: "bookmarks:bookmark-current-search",
      name: "Bookmarks: Bookmark current search...",
      icon: "lucide-bookmark",
      checkCallback: (checking) => {
        const query = this.app.internalPlugins.getEnabledPluginById("global-search")?.getGlobalSearchQuery?.() ?? "";
        if (!query) return false;
        if (!checking) this.promptAdd({ type: "search", ctime: Date.now(), query });
        return true;
      },
    });
    this.addCommand({
      id: "bookmarks:unbookmark-current-view",
      name: "Bookmarks: Remove bookmark for the current file",
      icon: "lucide-bookmark-minus",
      checkCallback: (checking) => {
        const file = workspace.getActiveFile();
        const item = file ? this.findBookmarkByPath(file.path) : null;
        if (!item) return false;
        if (!checking) this.removeItem(item);
        return true;
      },
    });
    this.addCommand({
      id: "bookmarks:bookmark-current-section",
      name: "Bookmarks: Bookmark block under cursor...",
      icon: "lucide-bookmark",
      editorCheckCallback: (checking, editor: Editor, ctx: any) => {
        const file: TFile | null = ctx?.file ?? null;
        if (!file) return false;
        if (!checking) void this.bookmarkBlock(editor, file);
        return true;
      },
    });
    this.addCommand({
      id: "bookmarks:bookmark-current-heading",
      name: "Bookmarks: Bookmark heading under cursor...",
      icon: "lucide-bookmark",
      editorCheckCallback: (checking, editor: Editor, ctx: any) => {
        const file: TFile | null = ctx?.file ?? null;
        const heading = file ? this.headingAt(file, editor.getCursor().line, false) : null;
        if (!file || !heading) return false;
        if (!checking) this.promptAdd({ type: "file", ctime: Date.now(), path: file.path, subpath: `#${heading}` });
        return true;
      },
    });
    this.addCommand({
      id: "bookmarks:bookmark-all-tabs",
      name: "Bookmarks: Bookmark all tabs...",
      icon: "lucide-bookmark",
      checkCallback: (checking) => {
        const items: BookmarkItem[] = [];
        workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
          const item = this.itemForLeaf(leaf);
          if (item) items.push(item);
        });
        if (items.length === 0) return false;
        if (!checking) this.promptGroupOf(items);
        return true;
      },
    });
  }

  private promptGroupOf(items: BookmarkItem[]) {
    new BookmarkModal(this, {
      heading: `Bookmark ${items.length} tabs`,
      item: null,
      group: null,
      nameLabel: "Group name",
      defaultName: "",
      onSave: ({ title, group }) => {
        this.addItem({ type: "group", ctime: Date.now(), title: title || undefined, items }, group);
      },
    }).open();
  }

  /** The heading text covering `line`; with `exact`, only when the line is the heading itself. */
  headingAt(file: TFile, line: number, exact: boolean): string | null {
    const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
    let found: string | null = null;
    for (const h of headings) {
      if (h.position.start.line > line) break;
      if (!exact || h.position.start.line === line) found = h.heading;
    }
    return found;
  }

  /** Bookmark the block under the cursor, giving it a `^id` when it has none. */
  private async bookmarkBlock(editor: Editor, file: TFile) {
    const line = editor.getCursor().line;
    const cache = this.app.metadataCache.getFileCache(file);
    const heading = cache?.headings?.find((h: any) => h.position.start.line === line);
    if (heading) {
      this.promptAdd({ type: "file", ctime: Date.now(), path: file.path, subpath: `#${heading.heading}` });
      return;
    }
    // The innermost list item, else the top-level section, containing the line.
    let start = line;
    let end = line;
    let kind = "paragraph";
    const listItem = (cache?.listItems ?? []).filter((li: any) => li.position.start.line <= line && li.position.end.line >= line).pop();
    const section = (cache?.sections ?? []).find((s: any) => s.position.start.line <= line && s.position.end.line >= line);
    if (listItem) {
      start = listItem.position.start.line;
      end = listItem.position.start.line;
      kind = "list";
    } else if (section) {
      start = section.position.start.line;
      end = section.position.end.line;
      kind = section.type;
    }
    if (kind === "yaml" || editor.getLine(line).trim() === "") {
      new Notice("There is no block under the cursor.");
      return;
    }
    let id: string | null = null;
    for (const block of Object.values<any>(cache?.blocks ?? {})) {
      if (block.position.end.line >= start && block.position.start.line <= end) {
        id = block.id;
        break;
      }
    }
    if (!id) {
      id = Math.random().toString(36).slice(2, 8);
      const lastLine = editor.getLine(end);
      // Tables, code and math take the id on the line after the block.
      const onOwnLine = ["code", "table", "math", "blockquote", "callout"].includes(kind);
      editor.replaceRange(onOwnLine ? `\n^${id}` : ` ^${id}`, { line: end, ch: lastLine.length });
    }
    this.promptAdd({ type: "file", ctime: Date.now(), path: file.path, subpath: `#^${id}` });
  }

  // ---- menus ------------------------------------------------------------------------------

  private registerMenus() {
    const { workspace } = this.app;
    this.registerEvent(
      workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string) => {
        if (source === "bookmarks" || (file instanceof TFolder && file.isRoot())) return;
        const existing = this.findBookmarkByPath(file.path);
        menu.addItem((i) =>
          i
            .setSection("action")
            .setTitle(existing ? "Edit bookmark..." : "Bookmark...")
            .setIcon("lucide-bookmark")
            .onClick(() => (existing ? this.editItem(existing) : this.promptAdd({ type: file instanceof TFolder ? "folder" : "file", ctime: Date.now(), path: file.path }))),
        );
      }),
    );
    this.registerEvent(
      workspace.on("files-menu", (menu: Menu, files: TAbstractFile[]) => {
        menu.addItem((i) => i.setSection("action").setTitle("Bookmark...").setIcon("lucide-bookmark").onClick(() => this.promptAddMany(files)));
      }),
    );
    this.registerEvent(
      workspace.on("editor-menu", (menu: Menu, editor: Editor, info: any) => {
        const file: TFile | null = info?.file ?? null;
        const heading = file ? this.headingAt(file, editor.getCursor().line, true) : null;
        if (!file || !heading) return;
        menu.addItem((i) =>
          i
            .setSection("action")
            .setTitle("Bookmark this heading...")
            .setIcon("lucide-bookmark")
            .onClick(() => this.promptAdd({ type: "file", ctime: Date.now(), path: file.path, subpath: `#${heading}` })),
        );
      }),
    );
  }
}

export const bookmarks: CorePluginDefinition = {
  id: "bookmarks",
  name: "Bookmarks",
  description: "Save shortcuts to files, searches, headings, and graphs.",
  icon: "lucide-bookmark",
  defaultOn: true,
  defaultOptions: {},
  create: (app) => new BookmarksPlugin(app, { id: "bookmarks", name: "Bookmarks", version: "", minAppVersion: "", author: "", description: "" }),
};
