/**
 * Trash (`trash`): browse the vault's `.trash` folder, restore files, delete
 * them permanently, or empty the trash.
 *
 * Deleting a file moves it to `.trash` (Settings → Files and links → Deleted
 * files). A browser cannot reach the system trash, so "Move to system trash"
 * lands in `.trash` too, and this view is where both are found again.
 *
 * `.trash` is flat, so the folder a file came from is remembered at deletion
 * time in `.obsidian/trash.json` → `origins` (trash path → original path).
 * Restore puts a file back there (creating the folder if needed), or at the
 * vault root when the origin is unknown, and never overwrites an existing
 * file. Trash Explorer users get the same actions; this plugin steps aside
 * (no view, no commands) when `trash-explorer` is enabled.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { ConfirmationModal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { moment, normalizePath } from "../../obsidian/util";
import { TFolder, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ItemView } from "../../obsidian/workspace/view";

export const VIEW_TYPE_TRASH = "trash";
export const TRASH_EXPLORER_PLUGIN = "trash-explorer";
const TRASH = ".trash";

export interface TrashEntry {
  path: string;
  name: string;
  type: "file" | "folder";
  size: number;
  mtime: number;
  items: number;
  origin: string | null;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: "" };
}

export class TrashPlugin extends Plugin {
  instance!: any;

  get origins(): Record<string, string> {
    const o = this.instance.options;
    if (!o.origins || typeof o.origins !== "object") o.origins = {};
    return o.origins as Record<string, string>;
  }

  private get adapter(): any {
    return this.app.vault.adapter;
  }

  override async onload() {
    this.registerView(VIEW_TYPE_TRASH, (leaf: WorkspaceLeaf) => new TrashView(leaf, this));
    this.addCommand({
      id: "trash:open",
      name: "Trash: Show trash",
      icon: "lucide-trash-2",
      checkCallback: (checking) => {
        if (this.steppedAside()) return false;
        if (!checking) void this.openView();
        return true;
      },
    });
    this.addCommand({
      id: "trash:empty",
      name: "Trash: Empty trash",
      icon: "lucide-trash",
      checkCallback: (checking) => {
        if (this.steppedAside()) return false;
        if (!checking) this.confirmEmpty();
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: any, file: TAbstractFile) => {
        if (!(file instanceof TFolder) || !file.isRoot() || this.steppedAside()) return;
        menu.addItem((item: any) => item.setSection("system").setTitle("Show trash").setIcon("lucide-trash-2").onClick(() => void this.openView()));
      }),
    );
    this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => void this.rememberOrigin(file)));
    this.instance.listTrash = () => this.list();
    this.instance.restore = (path: string) => this.restore(path);
    this.instance.deletePermanently = (path: string) => this.deletePermanently(path);
    this.instance.emptyTrash = () => this.emptyTrash();
    this.instance.openView = () => this.openView();
  }

  override onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_TRASH);
  }

  steppedAside(): boolean {
    return !!this.app.plugins?.enabledPlugins?.has?.(TRASH_EXPLORER_PLUGIN);
  }

  async openView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TRASH)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE_TRASH, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    await this.app.workspace.revealLeaf?.(leaf);
  }

  private async rememberOrigin(file: TAbstractFile) {
    if (this.app.vault.getConfig("trashOption") === "none") return;
    try {
      if (!(await this.adapter.exists(TRASH))) return;
      const { files, folders } = await this.adapter.list(TRASH);
      const known = new Set(Object.keys(this.origins));
      const { base, ext } = splitName(file.name);
      const candidates = [...files, ...folders]
        .map((p: string) => normalizePath(p))
        .filter((p: string) => !known.has(p))
        .map((p: string) => ({ p, name: p.slice(TRASH.length + 1) }))
        .filter(({ name }) => {
          if (name === file.name) return true;
          const m = /^(.*) (\d+)(\.[^.]*)?$/.exec(name);
          if (!m) return false;
          return (m[1] === base && (m[3] ?? "") === ext) || m[1] === file.name;
        });
      if (!candidates.length) return;
      const num = (n: string) => Number(/ (\d+)(\.[^.]*)?$/.exec(n)?.[1] ?? 0);
      candidates.sort((a, b) => num(b.name) - num(a.name));
      this.origins[candidates[0]!.p] = file.path;
      await this.instance.saveOptions();
    } catch (e) {
      console.error("Trash: could not record where a file came from", e);
    }
  }

  async list(): Promise<TrashEntry[]> {
    if (!(await this.adapter.exists(TRASH))) return [];
    const { files, folders } = await this.adapter.list(TRASH);
    const out: TrashEntry[] = [];
    const count = async (dir: string): Promise<{ items: number; size: number }> => {
      const l = await this.adapter.list(dir);
      let items = l.files.length;
      let size = 0;
      for (const f of l.files) size += (await this.adapter.stat(f))?.size ?? 0;
      for (const d of l.folders) {
        const c = await count(d);
        items += c.items;
        size += c.size;
      }
      return { items, size };
    };
    for (const p of files as string[]) {
      const path = normalizePath(p);
      const st = await this.adapter.stat(path);
      out.push({ path, name: path.slice(TRASH.length + 1), type: "file", size: st?.size ?? 0, mtime: st?.mtime ?? 0, items: 1, origin: this.origins[path] ?? null });
    }
    for (const p of folders as string[]) {
      const path = normalizePath(p);
      const st = await this.adapter.stat(path);
      const c = await count(path);
      out.push({ path, name: path.slice(TRASH.length + 1), type: "folder", size: c.size, mtime: st?.mtime ?? 0, items: c.items, origin: this.origins[path] ?? null });
    }
    // Prune origins of entries that are gone.
    const present = new Set(out.map((e) => e.path));
    let pruned = false;
    for (const k of Object.keys(this.origins)) {
      if (!present.has(k)) {
        delete this.origins[k];
        pruned = true;
      }
    }
    if (pruned) await this.instance.saveOptions();
    return out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  }

  /** Moves a trashed entry back into the vault. Returns the restored path. */
  async restore(trashPath: string): Promise<string> {
    trashPath = normalizePath(trashPath);
    const vault = this.app.vault;
    const st = await this.adapter.stat(trashPath);
    if (!st) throw new Error("This item is no longer in the trash.");
    const name = trashPath.slice(TRASH.length + 1);
    let target = this.origins[trashPath] ?? name;
    const slash = target.lastIndexOf("/");
    const dir = slash === -1 ? "" : target.slice(0, slash);
    if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => {});
    if (vault.getAbstractFileByPathInsensitive(target) || (await this.adapter.exists(target))) {
      const { base, ext } = st.type === "folder" ? { base: target, ext: "" } : splitName(target);
      target = vault.getAvailablePath(base, ext.replace(/^\./, ""));
    }
    await this.adapter.rename(trashPath, target);
    if (st.type === "folder") await this.reconcileTree(target);
    delete this.origins[trashPath];
    await this.instance.saveOptions();
    return target;
  }

  private async reconcileTree(dir: string) {
    const vault = this.app.vault as any;
    await vault.reconcilePath?.(dir);
    const { files, folders } = await this.adapter.list(dir);
    for (const d of folders) await this.reconcileTree(normalizePath(d));
    for (const f of files) await vault.reconcilePath?.(normalizePath(f));
  }

  async deletePermanently(trashPath: string) {
    trashPath = normalizePath(trashPath);
    if (!trashPath.startsWith(TRASH + "/")) throw new Error("Only items in the trash can be deleted here.");
    const st = await this.adapter.stat(trashPath);
    if (!st) return;
    if (st.type === "folder") await this.adapter.rmdir(trashPath, true);
    else await this.adapter.remove(trashPath);
    delete this.origins[trashPath];
    await this.instance.saveOptions();
  }

  async emptyTrash(): Promise<number> {
    const entries = await this.list();
    for (const e of entries) await this.deletePermanently(e.path);
    return entries.length;
  }

  confirmEmpty(onDone?: () => void) {
    const modal = new ConfirmationModal(this.app);
    modal.setTitle("Empty trash?");
    modal.setContent("Every file in the trash is deleted permanently. This cannot be undone.");
    modal.addButton((b) =>
      b
        .setButtonText("Empty trash")
        .setWarning()
        .onClick(async () => {
          const n = await this.emptyTrash();
          new Notice(`Deleted ${n} item${n === 1 ? "" : "s"} permanently.`);
          onDone?.();
        }),
    );
    modal.addCancelButton();
    modal.open();
  }
}

export class TrashView extends ItemView {
  listEl!: HTMLElement;
  trashHeaderEl!: HTMLElement;
  private rendering = false;
  private queued = false;

  constructor(
    leaf: WorkspaceLeaf,
    private owner: TrashPlugin,
  ) {
    super(leaf);
    this.icon = "lucide-trash-2";
    this.navigation = false;
  }

  getViewType() {
    return VIEW_TYPE_TRASH;
  }

  getDisplayText() {
    return "Trash";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("vault-trash-view");
    this.trashHeaderEl = this.contentEl.createDiv({ cls: "vault-trash-header" });
    this.listEl = this.contentEl.createDiv({ cls: "vault-trash-list" });
    this.registerEvent(this.app.vault.on("delete", () => this.requestRender()));
    this.registerEvent(
      this.app.vault.on("raw", (path: string) => {
        if (path === TRASH || path.startsWith(TRASH + "/")) this.requestRender();
      }),
    );
    await this.render();
  }

  requestRender() {
    if (this.rendering) {
      this.queued = true;
      return;
    }
    window.setTimeout(() => void this.render(), 50);
  }

  async render() {
    if (this.rendering) return;
    this.rendering = true;
    try {
      const entries = await this.owner.list();
      this.renderHeader(entries);
      this.renderList(entries);
    } catch (e) {
      console.error(e);
    } finally {
      this.rendering = false;
      if (this.queued) {
        this.queued = false;
        void this.render();
      }
    }
  }

  private renderHeader(entries: TrashEntry[]) {
    const h = this.trashHeaderEl;
    h.empty();
    const title = h.createDiv({ cls: "vault-trash-title" });
    title.createDiv({ cls: "vault-trash-heading", text: "Trash" });
    const total = entries.reduce((n, e) => n + e.size, 0);
    title.createDiv({
      cls: "vault-trash-summary",
      text: entries.length ? `${entries.length} item${entries.length === 1 ? "" : "s"} · ${formatSize(total)}` : "Deleted files appear here.",
    });
    const actions = h.createDiv({ cls: "vault-trash-actions" });
    const refresh = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Refresh" } });
    setIcon(refresh, "lucide-refresh-cw");
    refresh.addEventListener("click", () => void this.render());
    const empty = actions.createEl("button", { cls: "mod-warning vault-trash-empty-button", text: "Empty trash" });
    empty.disabled = entries.length === 0;
    empty.addEventListener("click", () => this.owner.confirmEmpty(() => void this.render()));
  }

  private renderList(entries: TrashEntry[]) {
    const list = this.listEl;
    list.empty();
    if (!entries.length) {
      const empty = list.createDiv({ cls: "vault-trash-empty-state" });
      setIcon(empty.createDiv({ cls: "vault-trash-empty-icon" }), "lucide-trash-2");
      empty.createDiv({ text: "The trash is empty." });
      return;
    }
    for (const entry of entries) {
      const item = list.createDiv({ cls: "tree-item vault-trash-item", attr: { "data-path": entry.path } });
      const self = item.createDiv({ cls: "tree-item-self vault-trash-item-self" });
      setIcon(self.createDiv({ cls: "vault-trash-icon" }), entry.type === "folder" ? "lucide-folder" : entry.name.endsWith(".md") ? "lucide-file-text" : "lucide-file");
      const inner = self.createDiv({ cls: "vault-trash-inner" });
      inner.createDiv({ cls: "vault-trash-name", text: entry.type === "file" && entry.name.endsWith(".md") ? entry.name.slice(0, -3) : entry.name });
      const meta: string[] = [];
      meta.push(entry.origin ? `from ${entry.origin.includes("/") ? entry.origin.slice(0, entry.origin.lastIndexOf("/")) : "vault root"}` : "origin unknown");
      if (entry.mtime) meta.push(`modified ${moment(entry.mtime).format("YYYY-MM-DD HH:mm")}`);
      meta.push(entry.type === "folder" ? `${entry.items} file${entry.items === 1 ? "" : "s"}, ${formatSize(entry.size)}` : formatSize(entry.size));
      inner.createDiv({ cls: "vault-trash-meta", text: meta.join(" · ") });
      const actions = self.createDiv({ cls: "vault-trash-item-actions" });
      const restore = actions.createEl("button", { cls: "vault-trash-restore", text: "Restore" });
      restore.addEventListener("click", async (evt) => {
        evt.stopPropagation();
        try {
          const path = await this.owner.restore(entry.path);
          new Notice(`Restored to “${path}”.`);
        } catch (e) {
          new Notice(String((e as Error)?.message ?? e));
        }
        await this.render();
      });
      const del = actions.createDiv({ cls: "clickable-icon vault-trash-delete", attr: { "aria-label": "Delete permanently" } });
      setIcon(del, "lucide-x");
      del.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const modal = new ConfirmationModal(this.app);
        modal.setTitle("Delete permanently?");
        modal.setContent(`“${entry.name}” will be deleted permanently. This cannot be undone.`);
        modal.addButton((b) =>
          b
            .setButtonText("Delete")
            .setWarning()
            .onClick(async () => {
              await this.owner.deletePermanently(entry.path);
              await this.render();
            }),
        );
        modal.addCancelButton();
        modal.open();
      });
      if (entry.type === "file" && /\.(md|txt|canvas|base|json|css|csv)$/i.test(entry.name)) {
        self.addClass("is-clickable");
        self.addEventListener("click", () => void this.togglePreview(item, entry));
      }
    }
  }

  private async togglePreview(item: HTMLElement, entry: TrashEntry) {
    const existing = item.querySelector(".vault-trash-preview");
    if (existing) {
      existing.remove();
      item.removeClass("is-expanded");
      return;
    }
    let text = "";
    try {
      text = await this.owner.app.vault.adapter.read(entry.path);
    } catch {
      text = "";
    }
    item.addClass("is-expanded");
    item.createEl("pre", { cls: "vault-trash-preview", text: text.length > 4000 ? text.slice(0, 4000) + "\n…" : text || "(empty)" });
  }
}

export const trash: CorePluginDefinition = {
  id: "trash",
  name: "Trash",
  description: "Browse deleted files, restore them, or empty the trash.",
  icon: "lucide-trash-2",
  defaultOn: true,
  defaultOptions: { origins: {} },
  create: (app) => new TrashPlugin(app, { id: "trash", name: "Trash", version: "", minAppVersion: "", author: "", description: "" }),
};
