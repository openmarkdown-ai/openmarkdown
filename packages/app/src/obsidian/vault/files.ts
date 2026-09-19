import type { Vault } from "./vault";

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export abstract class TAbstractFile {
  vault: Vault;
  path: string;
  name: string;
  parent: TFolder | null = null;
  // internal: Obsidian sets this when a file is removed, and some plugins check it
  deleted = false;

  constructor(vault: Vault, path: string) {
    this.vault = vault;
    this.path = path;
    this.name = "";
    this.setPath(path);
  }

  // internal
  setPath(path: string) {
    this.path = path;
    const slash = path.lastIndexOf("/");
    this.name = path === "/" ? "" : path.slice(slash + 1);
  }

  // internal (used by plugins: file-explorer extensions)
  getNewPathAfterRename(name: string): string {
    const parent = this.parent;
    return !parent || parent.isRoot() ? name : `${parent.path}/${name}`;
  }
}

export class TFile extends TAbstractFile {
  stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
  basename = "";
  extension = "";

  constructor(vault: Vault, path: string) {
    super(vault, path);
    this.setPath(path);
  }

  override setPath(path: string) {
    super.setPath(path);
    const dot = this.name.lastIndexOf(".");
    if (dot > 0) {
      this.basename = this.name.slice(0, dot);
      this.extension = this.name.slice(dot + 1);
    } else {
      this.basename = this.name;
      this.extension = "";
    }
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === "/";
  }

  // internal
  getFileCount(): number {
    let n = 0;
    for (const c of this.children) n += c instanceof TFolder ? c.getFileCount() : 1;
    return n;
  }

  // internal
  getParentPrefix(): string {
    return this.isRoot() ? "" : this.path + "/";
  }
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "/" : path.slice(0, i);
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
