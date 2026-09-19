/**
 * FileManager — operations that combine the vault with user preferences:
 * where a new note goes, what a link to it looks like, and keeping links
 * intact when a file moves.
 */
import type { DataWriteOptions } from "obsidian";
import type { App } from "../app";
import { getFrontMatterInfo, normalizePath, parseYaml, stringifyYaml } from "../util";
import { TAbstractFile, TFile, TFolder, parentPath } from "./files";

export class FileManager {
  constructor(private app: App) {}

  private get vault() {
    return this.app.vault;
  }

  getNewFileParent(sourcePath: string, _newFilePath?: string): TFolder {
    const vault = this.vault;
    const location = vault.getConfig("newFileLocation");
    if (location === "current" && sourcePath) {
      const src = vault.getAbstractFileByPath(sourcePath);
      const folder = src instanceof TFolder ? src : src?.parent;
      if (folder) return folder;
    }
    if (location === "folder") {
      const f = vault.getFolderByPath(String(vault.getConfig("newFileFolderPath") || "/"));
      if (f) return f;
    }
    return vault.getRoot();
  }

  // internal (used by plugins: kanban, quickadd)
  async createNewMarkdownFile(folder: TFolder, name = "Untitled", data = ""): Promise<TFile> {
    const base = folder.isRoot() ? name : `${folder.path}/${name}`;
    return this.vault.create(this.vault.getAvailablePath(base, "md"), data);
  }

  // internal
  async createNewFile(folder: TFolder, name: string, extension: string, data = ""): Promise<TFile> {
    const base = folder.isRoot() ? name : `${folder.path}/${name}`;
    return this.vault.create(this.vault.getAvailablePath(base, extension), data);
  }

  // W5: an identical rename already in flight (Enter then blur on a title
  // commits twice) is joined, and the joining call does not throw again, so
  // the caller shows one error notice instead of two.
  private renamesInFlight = new Map<string, Promise<void>>();

  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    newPath = normalizePath(newPath);
    const key = `${file.path}\n${newPath}`;
    const pending = this.renamesInFlight.get(key);
    if (pending) return pending.catch(() => {});
    const run = this.renameFileNow(file, newPath);
    this.renamesInFlight.set(key, run);
    try {
      await run;
    } finally {
      this.renamesInFlight.delete(key);
    }
  }

  private async renameFileNow(file: TAbstractFile, newPath: string): Promise<void> {
    const oldPath = file.path;
    const update = this.vault.getConfig("alwaysUpdateLinks") !== false;
    let edits: { path: string; edits: { start: number; end: number; text: string }[] }[] = [];
    if (update) {
      // Computed against the tree before the move; each edit names the note's
      // path after the move, and its offsets refer to the unchanged text.
      edits = this.app.metadataCache.index.renameEdits(oldPath, newPath, {
        linkFormat: this.vault.getConfig("newLinkFormat") ?? "shortest",
      });
    }
    await this.vault.rename(file, newPath);
    for (const { path, edits: e } of edits) {
      const target = this.vault.getFileByPath(path);
      if (!target || e.length === 0) continue;
      await this.vault.process(target, (text) => applyEdits(text, e));
    }
  }

  async promptForDeletion(file: TAbstractFile): Promise<boolean> {
    const { confirmDeletion } = await import("../ui/confirm-delete");
    const ok = await confirmDeletion(this.app, file);
    if (ok) await this.trashFile(file);
    return ok;
  }

  async trashFile(file: TAbstractFile): Promise<void> {
    const option = this.vault.getConfig("trashOption");
    if (option === "none") await this.vault.delete(file, true);
    else await this.vault.trash(file, option === "system");
  }

  generateMarkdownLink(file: TFile, sourcePath: string, subpath?: string, alias?: string): string {
    const useMarkdown = !!this.vault.getConfig("useMarkdownLinks");
    const embed = file.extension !== "md" ? "!" : "";
    if (useMarkdown) {
      const format = this.vault.getConfig("newLinkFormat") ?? "shortest";
      let path = this.app.metadataCache.index.linktext(file.path, sourcePath, format);
      if (file.extension === "md" && !path.endsWith(".md")) path += ".md";
      const encoded = encodeURI(path) + (subpath ? encodeURI(subpath).replace(/#/g, "%23").replace(/^%23/, "#") : "");
      const text = alias ?? (file.extension === "md" ? file.basename : file.name);
      return `${embed}[${text}](${encoded})`;
    }
    const linktext = this.app.metadataCache.fileToLinktext(file, sourcePath, true);
    return `${embed}[[${linktext}${subpath ?? ""}${alias ? "|" + alias : ""}]]`;
  }

  async processFrontMatter(file: TFile, fn: (frontmatter: any) => void, options?: DataWriteOptions): Promise<void> {
    await this.vault.process(
      file,
      (text) => {
        const info = getFrontMatterInfo(text);
        const data = info.exists ? (parseYaml(info.frontmatter) ?? {}) : {};
        if (typeof data !== "object" || Array.isArray(data)) throw new Error("Frontmatter is not an object");
        fn(data);
        const yaml = Object.keys(data).length ? stringifyYaml(data) : "";
        if (info.exists) {
          if (!yaml) return text.slice(info.contentStart);
          return `---\n${yaml}---\n${text.slice(info.contentStart)}`;
        }
        if (!yaml) return text;
        return `---\n${yaml}---\n${text}`;
      },
      options,
    );
  }

  async getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string> {
    const setting = String(this.vault.getConfig("attachmentFolderPath") ?? "/");
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot + 1) : "";
    let folder: string;
    if (setting === "/" || setting === "") folder = "";
    else if (setting === "./" || setting === ".") folder = sourcePath ? parentPath(sourcePath) : "";
    else if (setting.startsWith("./")) {
      const src = sourcePath ? parentPath(sourcePath) : "";
      folder = normalizePath((src === "/" ? "" : src + "/") + setting.slice(2));
    } else folder = normalizePath(setting);
    if (folder === "/") folder = "";
    if (folder && !this.vault.getAbstractFileByPath(folder)) await this.vault.createFolder(folder).catch(() => {});
    return this.vault.getAvailablePath(folder ? `${folder}/${base}` : base, ext);
  }
}

export function applyEdits(text: string, edits: { start: number; end: number; text: string }[]): string {
  const sorted = edits.slice().sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
