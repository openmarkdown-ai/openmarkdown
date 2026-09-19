/**
 * MetadataCache — parsed structure of every note, and the link graph.
 *
 * Parsing happens in Rust (`vault-ofm`), inside the same wasm index that
 * answers link resolution, backlinks and search, so the text a query runs over
 * and the metadata a plugin reads can never disagree.
 *
 * Event order matters to plugins and is kept as Obsidian's: `changed` for the
 * file, then `resolve` for it once its links are resolved, then `resolved`
 * when nothing is left in the queue. Dataview in particular waits for
 * `resolved` before its first index.
 */
import type { CachedMetadata, LinkCache } from "obsidian";
import { getEngine, type VaultIndexHandle } from "@vault/engine";
import { Events } from "../events";
import { getAllTags, parseFrontMatterAliases } from "../util";
import { TFile, type TAbstractFile } from "./files";
import type { Vault } from "./vault";

const PARSE_CONCURRENCY = 16;

export class MetadataCache extends Events {
  vault: Vault;
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  // internal (used by plugins: wait-for-index logic)
  initialized = false;
  // internal
  resolved = false;
  // internal: path → metadata (Obsidian keys this by content hash; plugins only read through getFileCache)
  metadataCache: Record<string, CachedMetadata> = {};
  // internal: path → { mtime, size, hash }
  fileCache: Record<string, { mtime: number; size: number; hash: string }> = {};
  // internal
  inProgressTaskCount = 0;
  index: VaultIndexHandle;
  private queue = new Set<string>();
  private running = false;

  constructor(vault: Vault) {
    super();
    this.vault = vault;
    this.index = getEngine().createIndex();

    vault.on("create", (f: TAbstractFile) => {
      if (!(f instanceof TFile)) return;
      this.index.upsertFile({ path: f.path, size: f.stat.size, ctime: f.stat.ctime, mtime: f.stat.mtime });
      if (f.extension === "md") this.enqueue(f.path);
      else if (this.initialized) this.scheduleFullResolve();
    });
    vault.on("modify", (f: TAbstractFile) => {
      if (!(f instanceof TFile)) return;
      this.index.upsertFile({ path: f.path, size: f.stat.size, ctime: f.stat.ctime, mtime: f.stat.mtime });
      if (f.extension === "md") this.enqueue(f.path);
    });
    vault.on("delete", (f: TAbstractFile) => {
      if (!(f instanceof TFile)) return;
      const prev = this.metadataCache[f.path] ?? null;
      this.index.removeFile(f.path);
      delete this.metadataCache[f.path];
      delete this.fileCache[f.path];
      delete this.resolvedLinks[f.path];
      delete this.unresolvedLinks[f.path];
      this.trigger("deleted", f, prev);
      this.scheduleFullResolve();
    });
    vault.on("rename", (f: TAbstractFile, oldPath: string) => {
      if (!(f instanceof TFile)) return;
      this.index.renameFile(oldPath, f.path);
      if (this.metadataCache[oldPath]) {
        this.metadataCache[f.path] = this.metadataCache[oldPath]!;
        delete this.metadataCache[oldPath];
      }
      if (this.fileCache[oldPath]) {
        this.fileCache[f.path] = this.fileCache[oldPath]!;
        delete this.fileCache[oldPath];
      }
      this.scheduleFullResolve();
    });
  }

  private enqueue(path: string) {
    this.queue.add(path);
    this.resolved = false;
    if (!this.running) void this.drain();
  }

  private async drain() {
    this.running = true;
    try {
      while (this.queue.size) {
        const batch = Array.from(this.queue).slice(0, PARSE_CONCURRENCY);
        for (const p of batch) this.queue.delete(p);
        this.inProgressTaskCount = this.queue.size + batch.length;
        await Promise.all(batch.map((p) => this.computeFile(p)));
      }
    } finally {
      this.running = false;
      this.inProgressTaskCount = 0;
    }
    if (!this.initialized) {
      this.initialized = true;
      this.recomputeAllLinks();
      this.trigger("initialized");
    }
    this.resolved = true;
    this.trigger("resolved");
  }

  private async computeFile(path: string) {
    const file = this.vault.getFileByPath(path);
    if (!file) return;
    let text: string;
    try {
      text = await this.vault.cachedRead(file);
    } catch (e) {
      console.error(`Failed to read ${path}`, e);
      return;
    }
    const meta = this.index.setNote(path, text);
    this.metadataCache[path] = meta;
    this.fileCache[path] = { mtime: file.stat.mtime, size: file.stat.size, hash: String(file.stat.mtime) };
    this.trigger("changed", file, text, meta);
    if (this.initialized) {
      this.recomputeLinksFor(path);
      this.trigger("resolve", file);
    }
  }

  private fullResolveTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleFullResolve() {
    if (!this.initialized || this.fullResolveTimer) return;
    this.fullResolveTimer = setTimeout(() => {
      this.fullResolveTimer = null;
      this.recomputeAllLinks();
      this.trigger("resolved");
    }, 50);
  }

  private recomputeLinksFor(path: string) {
    const resolved: Record<string, number> = {};
    const unresolved: Record<string, number> = {};
    const meta = this.metadataCache[path];
    if (meta) {
      const visit = (ref: { link: string }) => {
        const linkpath = ref.link.split("#")[0]!;
        if (linkpath === "") return;
        const dest = this.index.resolveLink(linkpath.normalize("NFC"), path);
        if (dest) resolved[dest] = (resolved[dest] ?? 0) + 1;
        else unresolved[linkpath] = (unresolved[linkpath] ?? 0) + 1;
      };
      meta.links?.forEach(visit);
      meta.embeds?.forEach(visit);
      meta.frontmatterLinks?.forEach(visit);
    }
    this.resolvedLinks[path] = resolved;
    this.unresolvedLinks[path] = unresolved;
  }

  private recomputeAllLinks() {
    const resolved = this.index.resolvedLinks();
    const unresolved = this.index.unresolvedLinks();
    // Mutate in place: plugins hold references to these two objects.
    for (const k of Object.keys(this.resolvedLinks)) if (!(k in resolved)) delete this.resolvedLinks[k];
    for (const k of Object.keys(this.unresolvedLinks)) if (!(k in unresolved)) delete this.unresolvedLinks[k];
    for (const f of this.vault.getMarkdownFiles()) {
      this.resolvedLinks[f.path] = resolved[f.path] ?? {};
      this.unresolvedLinks[f.path] = unresolved[f.path] ?? {};
    }
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    // Vault paths are NFC; a link typed or pasted decomposed (NFD) still resolves.
    const dest = this.index.resolveLink(linkpath.normalize("NFC"), sourcePath.normalize("NFC"));
    return dest ? this.vault.getFileByPath(dest) : null;
  }

  // internal (used by plugins: link suggestion UIs)
  getLinkpathDest(linkpath: string, sourcePath: string): TFile[] {
    const f = this.getFirstLinkpathDest(linkpath, sourcePath);
    return f ? [f] : [];
  }

  // internal (used by plugins: excalidraw) — paths of every file with metadata
  getCachedFiles(): string[] {
    return Object.keys(this.metadataCache);
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.metadataCache[file.path] ?? null;
  }

  getCache(path: string): CachedMetadata | null {
    return this.metadataCache[path] ?? null;
  }

  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
    const format = (this.vault.getConfig("newLinkFormat") as "shortest" | "relative" | "absolute") ?? "shortest";
    let text = this.index.linktext(file.path, sourcePath, format);
    if (!omitMdExtension && file.extension === "md" && !text.endsWith(".md")) text += ".md";
    return text;
  }

  // internal (used by plugins: backlink views)
  getBacklinksForFile(file: TFile) {
    const data = new Map<string, LinkCache[]>();
    for (const b of this.index.backlinks(file.path)) data.set(b.source, b.refs as unknown as LinkCache[]);
    return {
      data,
      keys: () => Array.from(data.keys()),
      get: (k: string) => data.get(k) ?? null,
      count: () => data.size,
    };
  }

  // internal (used by plugins: tag panes)
  getTags(): Record<string, number> {
    return this.index.tags();
  }

  // internal
  getFrontmatterPropertyValuesForKey(key: string): string[] {
    const values = new Set<string>();
    for (const meta of Object.values(this.metadataCache)) {
      const v = meta.frontmatter?.[key];
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? v : [v]) if (item !== null && typeof item !== "object") values.add(String(item));
    }
    return Array.from(values).sort();
  }

  // internal (used by plugins: link suggesters)
  getLinkSuggestions(): { file: TFile | null; path: string; alias?: string }[] {
    const out: { file: TFile | null; path: string; alias?: string }[] = [];
    for (const f of this.vault.getFiles()) {
      out.push({ file: f, path: f.path });
      const aliases = parseFrontMatterAliases(this.metadataCache[f.path]?.frontmatter ?? null);
      for (const alias of aliases ?? []) out.push({ file: f, path: f.path, alias });
    }
    for (const links of Object.values(this.unresolvedLinks)) {
      for (const link of Object.keys(links)) out.push({ file: null, path: link });
    }
    return out;
  }

  // internal
  isUserIgnored(path: string): boolean {
    const filters = this.vault.getConfig("userIgnoreFilters") as string[] | null;
    if (!filters) return false;
    return filters.some((f) => {
      if (f.startsWith("/") && f.length > 2 && f.lastIndexOf("/") > 0) {
        try {
          return new RegExp(f.slice(1, f.lastIndexOf("/")), f.slice(f.lastIndexOf("/") + 1)).test(path);
        } catch {
          return false;
        }
      }
      return path.startsWith(f);
    });
  }

  // internal
  getAllTagsForFile(file: TFile): string[] {
    const meta = this.metadataCache[file.path];
    return meta ? (getAllTags(meta) ?? []) : [];
  }

  /** Wait until the first full index is complete. */
  // internal
  onInitialized(cb: () => void) {
    if (this.initialized) cb();
    else {
      const ref = this.on("initialized", () => {
        this.offref(ref);
        cb();
      });
    }
  }

  // internal: mark startup complete for an empty vault
  finishStartupIfIdle() {
    if (!this.running && this.queue.size === 0 && !this.initialized) void this.drain();
  }
}
