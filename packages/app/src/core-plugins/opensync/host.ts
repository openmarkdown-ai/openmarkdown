/**
 * The engine's `VaultHost` over `app.vault`.
 *
 * Everything goes through the vault, never around it: a remote change to a
 * note is `vault.modify`, so an open editor hears `modify` and takes the new
 * text the same way it takes any other external change (and file recovery can
 * snapshot what it replaces); a remote deletion is `fileManager.trashFile`,
 * which honours the vault's trash setting.
 */
import type { FileStat, VaultHost } from "@opensync/client";
import { TFile, type TAbstractFile } from "../../obsidian/vault/files";
import { normalizePath } from "../../obsidian/util";

/** Extensions written as text, so editors and the text cache see a string write. */
const TEXT = new Set(["md", "canvas", "base", "excalidraw", "json", "csv", "txt", "svg", "css", "yaml", "yml", "bib", "drawio", "js", "ts", "html", "xml", "tex"]);
const RECOVERABLE = new Set(["md", "canvas"]);

export class AppVaultHost implements VaultHost {
  constructor(private readonly app: any) {}

  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
  }

  async list(): Promise<FileStat[]> {
    return (this.app.vault.getFiles() as TFile[]).map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
  }

  async stat(path: string): Promise<FileStat | null> {
    const f = this.file(path);
    return f ? { path: f.path, size: f.stat.size, mtime: f.stat.mtime } : null;
  }

  async read(path: string): Promise<Uint8Array> {
    const f = this.file(path);
    if (!f) throw new Error(`${path} is not in the vault`);
    return new Uint8Array(await this.app.vault.readBinary(f));
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    path = normalizePath(path);
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    let text: string | null = null;
    if (TEXT.has(ext)) {
      try {
        // fatal: a file with a text extension and non-UTF-8 bytes is written
        // as bytes, untouched. ignoreBOM: keep a BOM, so bytes round-trip.
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        text = null;
      }
    }
    const existing = this.file(path);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (existing) {
      if (text !== null) await this.app.vault.modify(existing, text);
      else await this.app.vault.modifyBinary(existing, buffer);
      return;
    }
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
      await this.app.vault.createFolder(parent).catch(() => undefined);
    }
    if (text !== null) await this.app.vault.create(path, text);
    else await this.app.vault.createBinary(path, buffer);
  }

  async delete(path: string): Promise<void> {
    const f = this.file(path);
    if (f) await this.app.fileManager.trashFile(f);
  }

  /** Every remote change to a note is undoable from "Open local history". */
  async beforeReplace(path: string): Promise<void> {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (!RECOVERABLE.has(ext)) return;
    const recovery = this.app.internalPlugins?.getEnabledPluginById?.("file-recovery");
    const f = this.file(path);
    if (!recovery?.forceAdd || !f) return;
    try {
      await recovery.forceAdd(path, await this.app.vault.read(f));
    } catch (e) {
      console.warn("Sync: could not snapshot before replacing", path, e);
    }
  }

  watch(onChange: (path: string) => void): () => void {
    const vault = this.app.vault;
    const visible = (p: string) => !vault.isHiddenPath?.(p);
    const refs = [
      vault.on("create", (f: TAbstractFile) => f instanceof TFile && visible(f.path) && onChange(f.path)),
      vault.on("modify", (f: TAbstractFile) => f instanceof TFile && visible(f.path) && onChange(f.path)),
      vault.on("delete", (f: TAbstractFile) => f instanceof TFile && visible(f.path) && onChange(f.path)),
      vault.on("rename", (f: TAbstractFile, old: string) => {
        if (!(f instanceof TFile)) return;
        if (visible(old)) onChange(old);
        if (visible(f.path)) onChange(f.path);
      }),
    ];
    return () => refs.forEach((r) => vault.offref(r));
  }

  /** Flush editors with unsaved text, so what is staged is what is on screen. */
  async flushEditors(): Promise<void> {
    const views: any[] = [];
    this.app.workspace.iterateAllLeaves((leaf: any) => {
      const view = leaf.view;
      if (view && view.dirty && typeof view.save === "function") views.push(view);
    });
    for (const view of views) await view.save().catch((e: unknown) => console.warn("Sync: could not save an editor", e));
  }
}
