/**
 * Vault — the file tree, and the only writer.
 *
 * Every write goes through here so every write raises the event plugins listen
 * for. The tree mirrors the adapter. External edits (another app writing the
 * same folder) are reconciled by `sync()`, a full rescan the app runs on focus
 * and on an interval, and — in the leader tab of a folder vault on Chromium —
 * path by path from FileSystemObserver records (`observer.ts`). Other tabs on
 * the same vault learn of changes over a BroadcastChannel (`tabs.ts`).
 *
 * A rescan never turns "could not read" into "deleted": unreadable entries are
 * kept, a missing path is confirmed with `stat` first, and a rescan that would
 * remove a large share of the vault at once stops and asks (`mass-delete`).
 */
import type { DataWriteOptions } from "obsidian";
import { Events } from "../events";
import { normalizePath } from "../util";
import type { ScanEntry, VaultAdapter } from "./adapter";
import { TAbstractFile, TFile, TFolder, parentPath } from "./files";
import { applyEol } from "./text-format";

export const DEFAULT_APP_CONFIG: Record<string, unknown> = {
  // Editor
  focusNewTab: true,
  defaultViewMode: "source",
  livePreview: true,
  readableLineLength: true,
  strictLineBreaks: false,
  propertiesInDocument: "visible",
  foldHeading: true,
  foldIndent: true,
  showLineNumber: false,
  showIndentGuide: true,
  rightToLeft: false,
  spellcheck: true,
  autoPairBrackets: true,
  autoPairMarkdown: true,
  smartIndentList: true,
  useTab: true,
  tabSize: 4,
  autoConvertHtml: true,
  vimMode: false,
  // Interface
  showInlineTitle: true,
  showViewHeader: true,
  showRibbon: true,
  // Files and links
  openBehavior: "",
  newFileLocation: "root",
  newFileFolderPath: "",
  newLinkFormat: "shortest",
  useMarkdownLinks: false,
  alwaysUpdateLinks: true,
  attachmentFolderPath: "/",
  showUnsupportedFiles: false,
  promptDelete: true,
  trashOption: "local",
  deleteUnlinkedAttachments: "ask",
  userIgnoreFilters: null,
  uriCallbacks: false,
  // Appearance (stored in appearance.json)
  theme: "system",
  accentColor: "",
  cssTheme: "",
  interfaceFontFamily: "",
  textFontFamily: "",
  monospaceFontFamily: "",
  baseFontSize: 16,
  baseFontSizeAction: false,
  translucency: false,
  enabledCssSnippets: [],
};

const APPEARANCE_KEYS = new Set([
  "theme",
  "accentColor",
  "cssTheme",
  "interfaceFontFamily",
  "textFontFamily",
  "monospaceFontFamily",
  "baseFontSize",
  "baseFontSizeAction",
  "translucency",
  "enabledCssSnippets",
  "nativeMenus",
  "showRibbon",
]);

export class Vault extends Events {
  adapter: VaultAdapter;
  configDir = ".obsidian";
  // internal
  fileMap: Record<string, TAbstractFile> = {};
  // internal
  root: TFolder;
  // internal (used by plugins: settings readers)
  config: Record<string, unknown> = {};
  private contentCache = new Map<string, { mtime: number; data: string }>();
  private writing = new Set<string>();
  // internal: data safety (save status, journal, tabs); set by installDataSafety
  safety: any = null;
  // internal: when set and false, an unforced sync() is skipped (another tab leads, or an observer is active)
  syncGate: (() => boolean) | null = null;
  // internal: File recovery registers here; awaited before a merge, a conflict resolution or a delete
  snapshotHooks = new Set<(path: string, text: string) => Promise<void>>();
  // internal: awaited before delete/trash, so an open editor's unsaved text lands first
  beforeDeleteHooks = new Set<(file: TAbstractFile) => Promise<void>>();
  // internal
  lastSyncTime = 0;
  private massDeleteAccepted = false;
  private massDeletePending = false;

  constructor(adapter: VaultAdapter) {
    super();
    this.adapter = adapter;
    this.root = new TFolder(this, "/");
    this.fileMap["/"] = this.root;
    this.watchAdapterWrites();
  }

  /**
   * Plugins write through `vault.adapter` directly (Dataview and Tasks rewrite
   * task lines with `adapter.write`, Kanban and Excalidraw create files with
   * it). In Obsidian the file watcher then raises `raw`, and `create` /
   * `modify` / `delete` for vault files, so the editor, metadata cache and
   * views catch up. A browser adapter has no watcher, so the vault wraps the
   * adapter's mutating methods and reconciles the touched paths itself. Writes
   * the vault makes are inside `guard()` and skipped; nested adapter calls
   * (process → write, trashLocal → rename) reconcile once, at the outer call.
   */
  private watchAdapterWrites() {
    const adapter = this.adapter as unknown as Record<string, unknown>;
    const busy = new Map<string, number>();
    const wrap = (name: string, pathsOf: (args: unknown[]) => string[], written: boolean) => {
      const original = adapter[name];
      if (typeof original !== "function") return;
      adapter[name] = async (...args: unknown[]) => {
        const paths = pathsOf(args).map((p) => normalizePath(String(p)));
        const outer = paths.filter((p) => !busy.has(p));
        for (const p of paths) busy.set(p, (busy.get(p) ?? 0) + 1);
        let ok = false;
        try {
          const result = await (original as (...a: unknown[]) => Promise<unknown>).apply(this.adapter, args);
          ok = true;
          return result;
        } finally {
          for (const p of paths) {
            const n = (busy.get(p) ?? 1) - 1;
            if (n) busy.set(p, n);
            else busy.delete(p);
          }
          for (const p of outer) await this.reconcilePath(p, written).catch((e) => console.error(e));
          // internal event: other tabs on this vault reconcile these paths (tabs.ts)
          if (ok && outer.length) this.trigger("local-change", name, outer);
        }
      };
    };
    const one = (args: unknown[]) => [String(args[0])];
    const two = (args: unknown[]) => [String(args[0]), String(args[1])];
    for (const name of ["write", "writeBinary", "append", "appendBinary", "process"]) wrap(name, one, true);
    for (const name of ["mkdir", "remove", "rmdir", "trashLocal", "trashSystem"]) wrap(name, one, false);
    for (const name of ["rename", "copy"]) wrap(name, two, false);
  }

  /**
   * Bring one path of the tree in line with the adapter (see
   * `watchAdapterWrites`, the observer and other tabs). Resolves true when the
   * tree changed. A `stat` that fails for any reason other than "not found"
   * rejects rather than deleting the entry.
   */
  // internal
  async reconcilePath(path: string, written = false): Promise<boolean> {
    path = normalizePath(path);
    this.trigger("raw", path);
    if (path === "/" || this.isHiddenPath(path) || this.writing.has(path)) return false;
    const st = await this.adapter.stat(path);
    const existing = this.fileMap[path];
    if (!st) {
      if (existing && !existing.deleted) {
        this.detach(existing);
        this.trigger("delete", existing);
        return true;
      }
      return false;
    }
    if (st.type === "folder") {
      if (!existing) {
        this.ensureFolder(path, false);
        return true;
      }
      return false;
    }
    if (!existing) {
      this.addEntry({ path, type: "file", size: st.size, mtime: st.mtime, ctime: st.ctime }, false);
      return true;
    } else if (existing instanceof TFile && (written || existing.stat.mtime !== st.mtime || existing.stat.size !== st.size)) {
      existing.stat = { ctime: existing.stat.ctime || st.ctime, mtime: st.mtime, size: st.size };
      this.contentCache.delete(path);
      this.trigger("modify", existing);
      return true;
    }
    return false;
  }

  /** A change another tab made (tabs.ts): apply renames as renames, reconcile the rest. */
  // internal
  async applyRemoteChange(op: string, paths: string[]): Promise<void> {
    if (op === "rename" && paths.length === 2) {
      const [from, to] = paths.map((p) => normalizePath(p)) as [string, string];
      const file = this.fileMap[from];
      if (file && !this.fileMap[to] && !this.isHiddenPath(to) && !(await this.adapter.stat(from)) && (await this.adapter.stat(to))) {
        this.applyRename(file, to);
        return;
      }
    }
    if ((op === "rename" || op === "copy" || op === "rmdir") && paths.some((p) => this.fileMap[normalizePath(p)] instanceof TFolder)) {
      await this.sync(true);
      return;
    }
    for (const p of paths) await this.reconcilePath(p);
    if (op === "copy" || op === "rename") {
      const target = paths[paths.length - 1];
      const st = target ? await this.adapter.stat(target).catch(() => null) : null;
      if (st?.type === "folder") await this.sync(true);
    }
  }

  /** Snapshot `text` as the current version of `path` in File recovery (before it is replaced). */
  // internal
  async snapshot(path: string, text: string): Promise<void> {
    for (const hook of Array.from(this.snapshotHooks)) {
      try {
        await hook(path, text);
      } catch (e) {
        console.error("Snapshot failed", e);
      }
    }
  }

  private async runBeforeDelete(file: TAbstractFile) {
    for (const hook of Array.from(this.beforeDeleteHooks)) {
      try {
        await hook(file);
      } catch (e) {
        console.error(e);
      }
    }
  }

  getName(): string {
    return this.adapter.getName();
  }

  // ---- config ---------------------------------------------------------------

  // internal
  async loadConfig() {
    const read = async (name: string) => {
      try {
        return JSON.parse(await this.adapter.read(`${this.configDir}/${name}`)) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    this.config = { ...(await read("app.json")), ...(await read("appearance.json")) };
  }

  // internal (used by plugins: many read getConfig("useMarkdownLinks"), "attachmentFolderPath", "tabSize"…)
  getConfig(key: string): any {
    return key in this.config ? this.config[key] : DEFAULT_APP_CONFIG[key];
  }

  // internal
  setConfig(key: string, value: unknown) {
    if (value === undefined) delete this.config[key];
    else this.config[key] = value;
    this.saveConfigSoon(APPEARANCE_KEYS.has(key) ? "appearance.json" : "app.json");
    this.trigger("config-changed", key, value);
  }

  private pendingConfig = new Set<string>();
  private configTimer: ReturnType<typeof setTimeout> | null = null;

  private saveConfigSoon(file: string) {
    this.pendingConfig.add(file);
    if (this.configTimer) return;
    this.configTimer = setTimeout(() => {
      this.configTimer = null;
      const files = Array.from(this.pendingConfig);
      this.pendingConfig.clear();
      for (const f of files) {
        const subset: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(this.config)) {
          if ((f === "appearance.json") === APPEARANCE_KEYS.has(k)) subset[k] = v;
        }
        this.writeConfigJson(f, subset).catch((e) => console.error(e));
      }
    }, 300);
  }

  // internal
  async readConfigJson(name: string): Promise<any | null> {
    try {
      return JSON.parse(await this.adapter.read(`${this.configDir}/${name}`));
    } catch {
      return null;
    }
  }

  // internal
  async writeConfigJson(name: string, data: unknown): Promise<void> {
    await this.adapter.mkdir(this.configDir);
    await this.adapter.write(`${this.configDir}/${name}`, JSON.stringify(data, null, 2));
  }

  // ---- tree -------------------------------------------------------------------

  /** Build the tree from the adapter, raising `create` for every file as Obsidian does at startup. */
  // internal
  async load(): Promise<void> {
    await this.loadConfig();
    const entries = await this.adapter.scan();
    entries.sort((a, b) => a.path.length - b.path.length);
    for (const e of entries) {
      if (this.isHiddenPath(e.path)) continue;
      this.addEntry(e, true);
    }
  }

  // internal
  isHiddenPath(path: string): boolean {
    return path.split("/").some((seg) => seg.startsWith("."));
  }

  private ensureFolder(path: string, silent: boolean): TFolder {
    if (path === "" || path === "/") return this.root;
    const existing = this.fileMap[path];
    if (existing instanceof TFolder) return existing;
    const parent = this.ensureFolder(parentPath(path), silent);
    const folder = new TFolder(this, path);
    folder.parent = parent;
    parent.children.push(folder);
    this.fileMap[path] = folder;
    if (!silent || true) this.trigger("create", folder);
    return folder;
  }

  private addEntry(e: ScanEntry, silent: boolean): TAbstractFile {
    if (e.type === "folder") return this.ensureFolder(e.path, silent);
    const existing = this.fileMap[e.path];
    if (existing instanceof TFile) {
      existing.stat = { ctime: e.ctime, mtime: e.mtime, size: e.size };
      return existing;
    }
    const parent = this.ensureFolder(parentPath(e.path), silent);
    const file = new TFile(this, e.path);
    file.stat = { ctime: e.ctime, mtime: e.mtime, size: e.size };
    file.parent = parent;
    parent.children.push(file);
    this.fileMap[e.path] = file;
    this.trigger("create", file);
    return file;
  }

  private detach(file: TAbstractFile) {
    const parent = file.parent;
    if (parent) parent.children.remove(file);
    const walk = (f: TAbstractFile) => {
      delete this.fileMap[f.path];
      this.contentCache.delete(f.path);
      f.deleted = true;
      if (f instanceof TFolder) f.children.forEach(walk);
    };
    walk(file);
  }

  /**
   * Reconcile with changes made outside the app. Unforced calls (the app's
   * focus and interval rescans) pass through `syncGate` first.
   */
  // internal
  async sync(force = false): Promise<void> {
    if (!force && this.syncGate && !this.syncGate()) return;
    this.lastSyncTime = Date.now();
    const entries = await this.adapter.scan();
    const seen = new Set<string>();
    const unreadableDirs: string[] = [];
    const changed: string[] = [];
    entries.sort((a, b) => a.path.length - b.path.length);
    for (const e of entries) {
      if (this.isHiddenPath(e.path)) continue;
      seen.add(e.path);
      if (e.error) {
        // Present but unreadable (a cloud placeholder, a lock, lost access): keep what we know.
        if (e.type === "folder") unreadableDirs.push(e.path + "/");
        continue;
      }
      if (this.writing.has(e.path)) continue;
      const existing = this.fileMap[e.path];
      if (!existing) {
        this.addEntry(e, false);
        changed.push(e.path);
      } else if (existing instanceof TFile && e.type === "file" && (existing.stat.mtime !== e.mtime || existing.stat.size !== e.size)) {
        existing.stat = { ctime: existing.stat.ctime, mtime: e.mtime, size: e.size };
        this.contentCache.delete(e.path);
        this.trigger("modify", existing);
        changed.push(e.path);
      }
    }
    const missing: string[] = [];
    for (const path of Object.keys(this.fileMap)) {
      if (path === "/" || seen.has(path) || this.writing.has(path)) continue;
      if (unreadableDirs.some((d) => path.startsWith(d))) continue;
      const f = this.fileMap[path];
      if (!f || f.deleted) continue;
      missing.push(path);
    }
    // Confirm each disappearance with a direct lookup; one that errors is not a deletion.
    const gone: string[] = [];
    let checks = 0;
    for (const path of missing) {
      if (checks++ >= 200) {
        gone.push(path);
        continue;
      }
      try {
        if (await this.adapter.stat(path)) continue;
      } catch {
        continue;
      }
      gone.push(path);
    }
    const total = this.getFiles().length;
    const goneFiles = gone.filter((p) => this.fileMap[p] instanceof TFile).length;
    const mass = (goneFiles > 20 && goneFiles > total * 0.2) || (total >= 3 && goneFiles === total);
    if (mass && !this.massDeleteAccepted) {
      if (!this.massDeletePending) {
        this.massDeletePending = true;
        // internal event: data safety asks the user (safety.ts)
        this.trigger("mass-delete", gone.slice(), total);
      }
    } else {
      this.massDeleteAccepted = false;
      this.massDeletePending = false;
      for (const path of gone) {
        const f = this.fileMap[path];
        if (!f || f.deleted) continue;
        this.detach(f);
        this.trigger("delete", f);
        changed.push(path);
      }
    }
    if (changed.length) this.trigger("external-change", changed);
    this.trigger("raw", "");
  }

  /** The user confirmed that the files a rescan found missing really are gone. */
  // internal
  async acceptMassDelete(): Promise<void> {
    this.massDeleteAccepted = true;
    this.massDeletePending = false;
    await this.sync(true);
  }

  // internal
  dismissMassDelete() {
    this.massDeletePending = false;
  }

  getFileByPath(path: string): TFile | null {
    const f = this.fileMap[normalizePath(path)];
    return f instanceof TFile ? f : null;
  }

  getFolderByPath(path: string): TFolder | null {
    const f = this.fileMap[normalizePath(path)];
    return f instanceof TFolder ? f : null;
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.fileMap[normalizePath(path)] ?? null;
  }

  // internal (used by plugins: case-insensitive lookups)
  getAbstractFileByPathInsensitive(path: string): TAbstractFile | null {
    const norm = normalizePath(path);
    const exact = this.fileMap[norm];
    if (exact) return exact;
    const lower = norm.toLowerCase();
    for (const [k, v] of Object.entries(this.fileMap)) if (k.toLowerCase() === lower) return v;
    return null;
  }

  getRoot(): TFolder {
    return this.root;
  }

  getAllLoadedFiles(): TAbstractFile[] {
    return Object.values(this.fileMap);
  }

  getAllFolders(includeRoot = false): TFolder[] {
    return Object.values(this.fileMap).filter((f): f is TFolder => f instanceof TFolder && (includeRoot || !f.isRoot()));
  }

  static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => any): void {
    const stack: TAbstractFile[] = [root];
    while (stack.length) {
      const f = stack.pop()!;
      cb(f);
      if (f instanceof TFolder) stack.push(...f.children);
    }
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === "md");
  }

  getFiles(): TFile[] {
    return Object.values(this.fileMap).filter((f): f is TFile => f instanceof TFile);
  }

  // internal (used by plugins: "Untitled 1" style names)
  getAvailablePath(pathWithoutExt: string, extension: string): string {
    const suffix = extension ? `.${extension}` : "";
    let candidate = normalizePath(pathWithoutExt + suffix);
    for (let i = 1; this.getAbstractFileByPathInsensitive(candidate); i++) {
      candidate = normalizePath(`${pathWithoutExt} ${i}${suffix}`);
    }
    return candidate;
  }

  // ---- writes -------------------------------------------------------------------

  private async guard<T>(path: string, fn: () => Promise<T>): Promise<T> {
    this.writing.add(path);
    try {
      return await fn();
    } finally {
      this.writing.delete(path);
    }
  }

  private validateNewPath(path: string) {
    if (path === "" || path === "/") throw new Error("Invalid path");
    if (/[\\:]/.test(path.split("/").pop() ?? "")) throw new Error("File name cannot contain any of the following characters: \\ / :");
    if (this.getAbstractFileByPathInsensitive(path)) throw new Error("File already exists.");
  }

  async create(path: string, data: string, options?: DataWriteOptions): Promise<TFile> {
    path = normalizePath(path);
    this.validateNewPath(path);
    return this.guard(path, async () => {
      await this.adapter.write(path, data, options);
      const st = await this.adapter.stat(path);
      this.contentCache.set(path, { mtime: st?.mtime ?? Date.now(), data });
      return this.addEntry({ path, type: "file", size: st?.size ?? data.length, mtime: st?.mtime ?? Date.now(), ctime: st?.ctime ?? Date.now() }, false) as TFile;
    });
  }

  async createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<TFile> {
    path = normalizePath(path);
    this.validateNewPath(path);
    return this.guard(path, async () => {
      await this.adapter.writeBinary(path, data, options);
      const st = await this.adapter.stat(path);
      return this.addEntry({ path, type: "file", size: st?.size ?? data.byteLength, mtime: st?.mtime ?? Date.now(), ctime: st?.ctime ?? Date.now() }, false) as TFile;
    });
  }

  async createFolder(path: string): Promise<TFolder> {
    path = normalizePath(path);
    if (this.getAbstractFileByPathInsensitive(path)) throw new Error("Folder already exists.");
    await this.guard(path, () => this.adapter.mkdir(path));
    return this.ensureFolder(path, false);
  }

  async read(file: TFile): Promise<string> {
    const data = await this.adapter.read(file.path);
    this.contentCache.set(file.path, { mtime: file.stat.mtime, data });
    return data;
  }

  async cachedRead(file: TFile): Promise<string> {
    const c = this.contentCache.get(file.path);
    if (c && c.mtime === file.stat.mtime) return c.data;
    return this.read(file);
  }

  /** internal: the last text read or written for `path`, if still current; synchronous. */
  getCachedText(path: string): string | null {
    const file = this.fileMap[path];
    const c = this.contentCache.get(path);
    return file instanceof TFile && c && c.mtime === file.stat.mtime ? c.data : null;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  getResourcePath(file: TFile): string {
    return this.adapter.getResourcePath(file.path);
  }

  private async afterWrite(file: TFile, data?: string) {
    const st = await this.adapter.stat(file.path);
    if (st) file.stat = { ctime: file.stat.ctime || st.ctime, mtime: st.mtime, size: st.size };
    // Cache what a read returns: the file's own line endings, not the editor's `\n`.
    const format = this.adapter.codec?.get(file.path);
    if (data !== undefined) this.contentCache.set(file.path, { mtime: file.stat.mtime, data: format ? applyEol(data, format.eol) : data });
    else this.contentCache.delete(file.path);
    this.trigger("modify", file);
  }

  async modify(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
    await this.guard(file.path, () => this.adapter.write(file.path, data, options));
    await this.afterWrite(file, data);
  }

  async modifyBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    await this.guard(file.path, () => this.adapter.writeBinary(file.path, data, options));
    await this.afterWrite(file);
  }

  async append(file: TFile, data: string, options?: DataWriteOptions): Promise<void> {
    await this.guard(file.path, () => this.adapter.append(file.path, data, options));
    await this.afterWrite(file);
  }

  async appendBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    await this.guard(file.path, () => this.adapter.appendBinary(file.path, data, options));
    await this.afterWrite(file);
  }

  async process(file: TFile, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> {
    const data = await this.guard(file.path, () => this.adapter.process(file.path, fn, options));
    await this.afterWrite(file, data);
    return data;
  }

  async delete(file: TAbstractFile, force = false): Promise<void> {
    await this.runBeforeDelete(file);
    await this.guard(file.path, async () => {
      if (file instanceof TFolder) await this.adapter.rmdir(file.path, force || true);
      else await this.adapter.remove(file.path);
    });
    this.detach(file);
    this.trigger("delete", file);
  }

  async trash(file: TAbstractFile, system: boolean): Promise<void> {
    await this.runBeforeDelete(file);
    await this.guard(file.path, async () => {
      if (!(system && (await this.adapter.trashSystem(file.path)))) await this.adapter.trashLocal(file.path);
    });
    this.detach(file);
    this.trigger("delete", file);
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    newPath = normalizePath(newPath);
    const oldPath = file.path;
    if (newPath === oldPath) return;
    const clash = this.getAbstractFileByPathInsensitive(newPath);
    if (clash && clash !== file) throw new Error("Destination file already exists!");
    await this.guard(oldPath, () => this.guard(newPath, () => this.adapter.rename(oldPath, newPath)));
    this.applyRename(file, newPath);
  }

  /** Move `file` (and its subtree) in the tree and raise `rename`; the adapter has already moved it. */
  // internal
  applyRename(file: TAbstractFile, newPath: string) {
    const newParent = this.ensureFolder(parentPath(newPath), false);
    file.parent?.children.remove(file);
    file.parent = newParent;
    newParent.children.push(file);

    const moves: [TAbstractFile, string][] = [];
    const walk = (f: TAbstractFile, path: string) => {
      moves.push([f, f.path]);
      delete this.fileMap[f.path];
      const cached = this.contentCache.get(f.path);
      this.contentCache.delete(f.path);
      f.setPath(path);
      this.fileMap[path] = f;
      if (cached) this.contentCache.set(path, cached);
      if (f instanceof TFolder) for (const c of f.children) walk(c, `${path}/${c.name}`);
    };
    walk(file, newPath);
    for (const [f, old] of moves) this.trigger("rename", f, old);
  }

  async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    newPath = normalizePath(newPath);
    this.validateNewPath(newPath);
    await this.guard(newPath, () => this.adapter.copy(file.path, newPath));
    if (file instanceof TFile) {
      const st = await this.adapter.stat(newPath);
      return this.addEntry({ path: newPath, type: "file", size: st?.size ?? 0, mtime: st?.mtime ?? Date.now(), ctime: Date.now() }, false) as unknown as T;
    }
    await this.sync(true);
    return this.getAbstractFileByPath(newPath) as T;
  }
}
