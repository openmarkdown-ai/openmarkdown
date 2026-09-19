/**
 * The rows every base queries: one vault-bases `FileRecord` per file in the
 * vault, built from `app.vault` and `app.metadataCache`, rebuilt lazily after
 * any change and announced (debounced) through the "changed" event.
 */
import { Events } from "../../obsidian/events";
import { debounce, getAllTags } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";

export interface FileRecordJson {
  path: string;
  size: number;
  ctime: number;
  mtime: number;
  properties: Record<string, unknown>;
  tags: string[];
  links: string[];
  embeds: string[];
  backlinks: string[];
}

export class FileRecordStore extends Events {
  private records: Map<string, FileRecordJson> | null = null;
  private list: FileRecordJson[] = [];
  private offs: (() => void)[] = [];
  private announce = debounce(() => this.trigger("changed"), 150, true);

  constructor(private app: any) {
    super();
    const listen = (target: any, name: string) => {
      const ref = target.on(name, () => this.invalidate());
      this.offs.push(() => target.offref(ref));
    };
    listen(app.metadataCache, "changed");
    listen(app.metadataCache, "resolved");
    listen(app.metadataCache, "deleted");
    listen(app.vault, "create");
    listen(app.vault, "delete");
    listen(app.vault, "rename");
  }

  dispose() {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.announce.cancel();
  }

  invalidate() {
    this.records = null;
    this.announce();
  }

  all(): FileRecordJson[] {
    this.ensure();
    return this.list;
  }

  get(path: string | null | undefined): FileRecordJson | null {
    if (!path) return null;
    this.ensure();
    return this.records!.get(path) ?? null;
  }

  private ensure() {
    if (this.records) return;
    const app = this.app;
    const cache = app.metadataCache;
    const files = app.vault.getFiles() as TFile[];
    const backlinks = new Map<string, string[]>();
    for (const [source, dests] of Object.entries(cache.resolvedLinks as Record<string, Record<string, number>>)) {
      for (const dest of Object.keys(dests)) {
        const list = backlinks.get(dest);
        if (list) list.push(source);
        else backlinks.set(dest, [source]);
      }
    }
    const records = new Map<string, FileRecordJson>();
    const resolve = (link: string, source: string) => {
      const linkpath = link.split("#")[0]!.split("|")[0]!;
      if (!linkpath) return source;
      const dest = cache.getFirstLinkpathDest(linkpath, source) as TFile | null;
      return dest ? dest.path : linkpath;
    };
    for (const file of files) {
      const meta = file.extension === "md" ? cache.getFileCache(file) : null;
      const links: string[] = [];
      const embeds: string[] = [];
      if (meta) {
        for (const l of meta.links ?? []) links.push(resolve(l.link, file.path));
        for (const l of meta.frontmatterLinks ?? []) links.push(resolve(l.link, file.path));
        for (const e of meta.embeds ?? []) embeds.push(resolve(e.link, file.path));
      }
      const properties: Record<string, unknown> = {};
      if (meta?.frontmatter) for (const [k, v] of Object.entries(meta.frontmatter as Record<string, unknown>)) if (k !== "position") properties[k] = v;
      records.set(file.path, {
        path: file.path,
        size: file.stat.size,
        ctime: file.stat.ctime,
        mtime: file.stat.mtime,
        properties,
        tags: meta ? (getAllTags(meta) ?? []) : [],
        links: Array.from(new Set(links)),
        embeds: Array.from(new Set(embeds)),
        backlinks: backlinks.get(file.path) ?? [],
      });
    }
    this.records = records;
    this.list = Array.from(records.values());
  }
}
