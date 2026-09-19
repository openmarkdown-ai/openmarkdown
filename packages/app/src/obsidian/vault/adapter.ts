/**
 * Storage adapters behind `vault.adapter`.
 *
 * Two real implementations and one for tests:
 *
 * - `HandleAdapter` over a `FileSystemDirectoryHandle`. Given a handle from
 *   `showDirectoryPicker()` it reads and writes a real folder on disk — the
 *   same folder Obsidian opens. Given `navigator.storage.getDirectory()` it is
 *   the origin-private file system, which every current browser has.
 * - `MemoryAdapter`, for the demo vault and unit tests.
 *
 * Paths are vault-relative, "/"-separated, with no leading slash; "" or "/" is
 * the root. `list()` returns full vault-relative paths, as Obsidian's does.
 */
import type { DataWriteOptions, ListedFiles, Stat } from "obsidian";
import { idb } from "./idb";
import { resourceUrl } from "./resource";
import { TextCodec } from "./text-format";

export interface ScanEntry {
  path: string;
  type: "file" | "folder";
  size: number;
  mtime: number;
  ctime: number;
  /** Set when the entry exists but could not be read (a read failure is not a deletion). */
  error?: string;
}

export interface VaultAdapter {
  getName(): string;
  exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>;
  stat(normalizedPath: string): Promise<Stat | null>;
  list(normalizedPath: string): Promise<ListedFiles>;
  read(normalizedPath: string): Promise<string>;
  readBinary(normalizedPath: string): Promise<ArrayBuffer>;
  write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
  writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
  append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>;
  appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void>;
  process(normalizedPath: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string>;
  getResourcePath(normalizedPath: string): string;
  mkdir(normalizedPath: string): Promise<void>;
  trashSystem(normalizedPath: string): Promise<boolean>;
  trashLocal(normalizedPath: string): Promise<void>;
  rmdir(normalizedPath: string, recursive: boolean): Promise<void>;
  remove(normalizedPath: string): Promise<void>;
  rename(normalizedPath: string, normalizedNewPath: string): Promise<void>;
  copy(normalizedPath: string, normalizedNewPath: string): Promise<void>;
  // internal
  scan(): Promise<ScanEntry[]>;
  readonly vaultId: string;
  readonly kind: "folder" | "browser" | "memory";
  /** Current mtime for resource URL cache-busting. */
  mtimeOf(path: string): number;
  // internal: per-file BOM / line ending / encoding, re-applied on string writes
  readonly codec?: TextCodec;
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0 && s !== ".");
}

function joinPath(dir: string, name: string): string {
  return dir === "" || dir === "/" ? name : `${dir}/${name}`;
}

function splitParent(path: string): [string, string] {
  const segs = segments(path);
  const name = segs.pop() ?? "";
  return [segs.join("/"), name];
}

const encoder = new TextEncoder();

function errName(e: unknown): string {
  return (e as { name?: string } | null)?.name ?? "";
}

/** The entry is not there (or is the other kind): as opposed to unreadable or access lost. */
function isMissing(e: unknown): boolean {
  const n = errName(e);
  return n === "NotFoundError" || n === "TypeMismatchError" || n === "TypeError";
}

/** Chromium writes `<name>.crswap` next to a file while a writable is open. */
function isSwapFile(name: string): boolean {
  return name.endsWith(".crswap");
}

const hasNonAscii = (s: string) => /[^\x00-\x7f]/.test(s);

/** File creation times, which neither the FS Access API nor OPFS reports. */
class CtimeStore {
  private map = new Map<string, number>();
  private loaded: Promise<void> | null = null;
  constructor(private vaultId: string) {}

  load(): Promise<void> {
    this.loaded ??= idb
      .entries<number>("ctimes", this.vaultId + ":")
      .then((entries) => {
        for (const [k, v] of entries) this.map.set(k.slice(this.vaultId.length + 1), v);
      })
      .catch(() => {});
    return this.loaded;
  }
  get(path: string, fallback: number): number {
    const v = this.map.get(path);
    if (v !== undefined) return Math.min(v, fallback || v);
    this.set(path, fallback);
    return fallback;
  }
  set(path: string, t: number) {
    this.map.set(path, t);
    idb.set("ctimes", `${this.vaultId}:${path}`, t).catch(() => {});
  }
  move(from: string, to: string) {
    for (const [k, v] of Array.from(this.map)) {
      if (k === from || k.startsWith(from + "/")) {
        const nk = to + k.slice(from.length);
        this.map.delete(k);
        idb.delete("ctimes", `${this.vaultId}:${k}`).catch(() => {});
        this.set(nk, v);
      }
    }
  }
  remove(path: string) {
    for (const k of Array.from(this.map.keys())) {
      if (k === path || k.startsWith(path + "/")) {
        this.map.delete(k);
        idb.delete("ctimes", `${this.vaultId}:${k}`).catch(() => {});
      }
    }
  }
}

export class HandleAdapter implements VaultAdapter {
  readonly kind: "folder" | "browser";
  private ctimes: CtimeStore;
  private mtimes = new Map<string, number>();
  readonly codec = new TextCodec();

  constructor(
    readonly root: FileSystemDirectoryHandle,
    readonly vaultId: string,
    private name: string,
    kind: "folder" | "browser",
  ) {
    this.kind = kind;
    this.ctimes = new CtimeStore(vaultId);
  }

  getName(): string {
    return this.name;
  }

  async init() {
    await this.ctimes.load();
  }

  mtimeOf(path: string): number {
    return this.mtimes.get(path) ?? 0;
  }

  /**
   * A child handle by vault name. Vault paths are NFC; a name stored decomposed
   * (NFD, as macOS tools and some sync clients write it) is found through the
   * directory listing, so the file is never duplicated under a second spelling.
   */
  private async child<K extends "file" | "directory">(
    dir: FileSystemDirectoryHandle,
    name: string,
    kind: K,
    create: boolean,
  ): Promise<K extends "file" ? FileSystemFileHandle : FileSystemDirectoryHandle> {
    type R = K extends "file" ? FileSystemFileHandle : FileSystemDirectoryHandle;
    const get = (n: string, c: boolean) => (kind === "file" ? dir.getFileHandle(n, { create: c }) : dir.getDirectoryHandle(n, { create: c })) as Promise<R>;
    try {
      return await get(name, false);
    } catch (e) {
      if (!isMissing(e)) throw e;
      if (hasNonAscii(name)) {
        const want = name.normalize("NFC");
        for await (const [n, h] of dir.entries()) {
          if (n !== name && h.kind === kind && n.normalize("NFC") === want) return get(n, false);
        }
      }
      if (!create) throw e;
      return get(name, true);
    }
  }

  private async dir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    let h = this.root;
    for (const seg of segments(path)) h = await this.child(h, seg, "directory", create);
    return h;
  }

  private async fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    const [parent, name] = splitParent(path);
    const dir = await this.dir(parent, create);
    return this.child(dir, name, "file", create);
  }

  async exists(path: string, sensitive?: boolean): Promise<boolean> {
    return (await this.stat(path, sensitive)) !== null;
  }

  async stat(path: string, sensitive = false): Promise<Stat | null> {
    if (segments(path).length === 0) return { type: "folder", ctime: 0, mtime: 0, size: 0 };
    const [parent, name] = splitParent(path);
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await this.dir(parent);
    } catch (e) {
      // Missing parent: the file is not there. Anything else (access lost, an
      // unreadable cloud placeholder) is an error, not "does not exist".
      if (isMissing(e)) return null;
      throw e;
    }
    // Most local file systems a vault lives on are case-insensitive; the API
    // is case-sensitive. Look up the exact name first, then fall back.
    const tryName = async (n: string): Promise<Stat | null> => {
      const key = joinPath(parent, n.normalize("NFC"));
      try {
        const f = await (await this.child(dir, n, "file", false)).getFile();
        this.mtimes.set(key, f.lastModified);
        return { type: "file", size: f.size, mtime: f.lastModified, ctime: this.ctimes.get(key, f.lastModified) };
      } catch (e) {
        if (!isMissing(e)) throw e;
        try {
          await this.child(dir, n, "directory", false);
          return { type: "folder", ctime: 0, mtime: 0, size: 0 };
        } catch (e2) {
          if (!isMissing(e2)) throw e2;
          return null;
        }
      }
    };
    const exact = await tryName(name);
    if (exact || sensitive) return exact;
    const lower = name.normalize("NFC").toLowerCase();
    for await (const [entryName] of dir.entries()) {
      if (entryName !== name && entryName.normalize("NFC").toLowerCase() === lower) return tryName(entryName);
    }
    return null;
  }

  async list(path: string): Promise<ListedFiles> {
    const dir = await this.dir(path);
    const files: string[] = [];
    const folders: string[] = [];
    const prefix = segments(path).map((s) => s.normalize("NFC")).join("/");
    for await (const [name, handle] of dir.entries()) {
      const full = joinPath(prefix, name.normalize("NFC"));
      if (handle.kind === "directory") folders.push(full);
      else if (!isSwapFile(name)) files.push(full);
    }
    return { files, folders };
  }

  async scan(): Promise<ScanEntry[]> {
    const out: ScanEntry[] = [];
    // Paths are NFC. An entry that cannot be read, or a folder that cannot be
    // listed, is reported with `error` so the vault keeps it rather than
    // treating it as deleted.
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
      const pending: Promise<void>[] = [];
      try {
        for await (const [rawName, handle] of dir.entries()) {
          if (isSwapFile(rawName)) continue;
          const name = rawName.normalize("NFC");
          const full = prefix ? `${prefix}/${name}` : name;
          if (handle.kind === "directory") {
            out.push({ path: full, type: "folder", size: 0, mtime: 0, ctime: 0 });
            pending.push(walk(handle as FileSystemDirectoryHandle, full));
          } else {
            pending.push(
              (handle as FileSystemFileHandle).getFile().then(
                (f) => {
                  this.mtimes.set(full, f.lastModified);
                  out.push({ path: full, type: "file", size: f.size, mtime: f.lastModified, ctime: this.ctimes.get(full, f.lastModified) });
                },
                (e) => {
                  out.push({ path: full, type: "file", size: 0, mtime: 0, ctime: 0, error: errName(e) || "Error" });
                },
              ),
            );
          }
        }
      } catch (e) {
        if (!prefix) throw e;
        out.push({ path: prefix, type: "folder", size: 0, mtime: 0, ctime: 0, error: errName(e) || "Error" });
      }
      await Promise.all(pending);
    };
    await walk(this.root, "");
    return out;
  }

  async read(path: string): Promise<string> {
    return this.codec.decode(segments(path).join("/"), await this.readBinary(path));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const f = await (await this.fileHandle(path)).getFile();
    this.mtimes.set(segments(path).join("/"), f.lastModified);
    return f.arrayBuffer();
  }

  async write(path: string, data: string, options?: DataWriteOptions): Promise<void> {
    await this.writeBinary(path, this.codec.encode(segments(path).join("/"), data), options);
  }

  async writeBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    const norm = segments(path).join("/");
    let existed = true;
    try {
      await this.fileHandle(norm);
    } catch {
      existed = false;
    }
    const handle = await this.fileHandle(norm, true);
    const w = await handle.createWritable();
    await w.write(data);
    await w.close();
    const now = Date.now();
    this.mtimes.set(norm, options?.mtime ?? now);
    if (!existed || options?.ctime) this.ctimes.set(norm, options?.ctime ?? now);
  }

  async append(path: string, data: string, options?: DataWriteOptions): Promise<void> {
    await this.appendBinary(path, this.codec.encodeAppend(segments(path).join("/"), data), options);
  }

  async appendBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    const handle = await this.fileHandle(path, true);
    const file = await handle.getFile();
    const w = await handle.createWritable({ keepExistingData: true });
    await w.seek(file.size);
    await w.write(data);
    await w.close();
    this.mtimes.set(segments(path).join("/"), options?.mtime ?? Date.now());
  }

  async process(path: string, fn: (data: string) => string, options?: DataWriteOptions): Promise<string> {
    const next = fn(await this.read(path));
    await this.write(path, next, options);
    return next;
  }

  getResourcePath(path: string): string {
    return resourceUrl(this.vaultId, segments(path).join("/"), this.mtimeOf(path));
  }

  async mkdir(path: string): Promise<void> {
    await this.dir(path, true);
  }

  async trashSystem(_path: string): Promise<boolean> {
    return false;
  }

  async trashLocal(path: string): Promise<void> {
    const [, name] = splitParent(path);
    await this.mkdir(".trash");
    let target = `.trash/${name}`;
    for (let i = 1; await this.exists(target, true); i++) {
      const dot = name.lastIndexOf(".");
      target = dot > 0 ? `.trash/${name.slice(0, dot)} ${i}${name.slice(dot)}` : `.trash/${name} ${i}`;
    }
    await this.rename(path, target);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    const [parent, name] = splitParent(path);
    await (await this.dir(parent)).removeEntry(await this.diskName(parent, name, "directory"), { recursive });
    this.ctimes.move(segments(path).join("/"), "\u0000removed");
    this.codec.forget(segments(path).join("/"));
  }

  async remove(path: string): Promise<void> {
    const [parent, name] = splitParent(path);
    await (await this.dir(parent)).removeEntry(await this.diskName(parent, name, "file"));
    this.ctimes.remove(segments(path).join("/"));
    this.codec.forget(segments(path).join("/"));
  }

  /** The on-disk spelling of `name` in `parent` (it may be NFD). */
  private async diskName(parent: string, name: string, kind: "file" | "directory"): Promise<string> {
    if (!hasNonAscii(name)) return name;
    const dir = await this.dir(parent);
    try {
      await (kind === "file" ? dir.getFileHandle(name) : dir.getDirectoryHandle(name));
      return name;
    } catch {
      const want = name.normalize("NFC");
      for await (const [n, h] of dir.entries()) if (h.kind === kind && n.normalize("NFC") === want) return n;
      return name;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const src = segments(from).join("/");
    const dst = segments(to).join("/");
    if (src === dst) return;
    const st = await this.stat(src, true);
    if (!st) throw new Error(`ENOENT: ${from}`);
    const [dstParent, dstName] = splitParent(dst);
    const caseOnly = src.toLowerCase() === dst.toLowerCase();

    if (st.type === "file") {
      const handle = (await this.fileHandle(src)) as FileSystemFileHandle & { move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void> };
      if (typeof handle.move === "function" && !caseOnly) {
        try {
          await handle.move(await this.dir(dstParent, true), dstName);
          this.ctimes.move(src, dst);
          this.codec.move(src, dst);
          return;
        } catch {
          /* fall through to copy + delete (not supported on this file system) */
        }
      }
      const data = await this.readBinary(src);
      if (caseOnly) {
        const tmp = `${src}.renaming-${Date.now()}`;
        await this.writeBinary(tmp, data);
        await this.remove(src);
        await this.writeBinary(dst, data);
        await this.remove(tmp);
      } else {
        await this.writeBinary(dst, data);
        await this.remove(src);
      }
      this.ctimes.move(src, dst);
      this.codec.move(src, dst);
      return;
    }

    // Folders: there is no portable move, so copy the tree then remove it.
    await this.copyTree(src, dst);
    await this.rmdir(src, true);
    this.ctimes.move(src, dst);
  }

  private async copyTree(src: string, dst: string) {
    await this.mkdir(dst);
    const { files, folders } = await this.list(src);
    for (const f of files) await this.writeBinary(dst + f.slice(src.length), await this.readBinary(f));
    for (const d of folders) await this.copyTree(d, dst + d.slice(src.length));
  }

  async copy(from: string, to: string): Promise<void> {
    const st = await this.stat(from, true);
    if (!st) throw new Error(`ENOENT: ${from}`);
    if (await this.exists(to, true)) throw new Error(`EEXIST: ${to}`);
    if (st.type === "folder") await this.copyTree(segments(from).join("/"), segments(to).join("/"));
    else await this.writeBinary(to, await this.readBinary(from));
  }
}

interface MemEntry {
  type: "file" | "folder";
  data: ArrayBuffer;
  ctime: number;
  mtime: number;
}

export class MemoryAdapter implements VaultAdapter {
  readonly kind = "memory" as const;
  private entries = new Map<string, MemEntry>();
  readonly codec = new TextCodec();

  constructor(
    readonly vaultId: string,
    private name: string,
    initial: Record<string, string | ArrayBuffer> = {},
  ) {
    const now = Date.now();
    for (const [path, content] of Object.entries(initial)) {
      const data = typeof content === "string" ? (encoder.encode(content).buffer as ArrayBuffer) : content;
      this.ensureParents(path, now);
      this.entries.set(segments(path).join("/").normalize("NFC"), { type: "file", data, ctime: now, mtime: now });
    }
  }

  private ensureParents(path: string, t: number) {
    const segs = segments(path);
    for (let i = 1; i < segs.length; i++) {
      const p = segs.slice(0, i).join("/");
      if (!this.entries.has(p)) this.entries.set(p, { type: "folder", data: new ArrayBuffer(0), ctime: t, mtime: t });
    }
  }

  getName() {
    return this.name;
  }
  mtimeOf(path: string) {
    return this.entries.get(segments(path).join("/"))?.mtime ?? 0;
  }
  private get(path: string, sensitive = true): MemEntry | undefined {
    const p = segments(path).join("/");
    const e = this.entries.get(p);
    if (e) return e;
    if (hasNonAscii(p)) {
      const nfc = p.normalize("NFC");
      for (const [k, v] of this.entries) if (k.normalize("NFC") === nfc) return v;
    }
    if (sensitive) return undefined;
    const lower = p.normalize("NFC").toLowerCase();
    for (const [k, v] of this.entries) if (k.normalize("NFC").toLowerCase() === lower) return v;
    return undefined;
  }
  async exists(path: string, sensitive?: boolean) {
    return segments(path).length === 0 || !!this.get(path, sensitive ?? false);
  }
  async stat(path: string): Promise<Stat | null> {
    if (segments(path).length === 0) return { type: "folder", ctime: 0, mtime: 0, size: 0 };
    const e = this.get(path);
    return e ? { type: e.type, ctime: e.ctime, mtime: e.mtime, size: e.data.byteLength } : null;
  }
  async list(path: string): Promise<ListedFiles> {
    const prefix = segments(path).join("/");
    const files: string[] = [];
    const folders: string[] = [];
    for (const [k, v] of this.entries) {
      const parent = k.includes("/") ? k.slice(0, k.lastIndexOf("/")) : "";
      if (parent !== prefix) continue;
      (v.type === "file" ? files : folders).push(k);
    }
    return { files, folders };
  }
  async scan(): Promise<ScanEntry[]> {
    return Array.from(this.entries, ([path, e]) => ({ path: path.normalize("NFC"), type: e.type, size: e.data.byteLength, mtime: e.mtime, ctime: e.ctime }));
  }
  async read(path: string) {
    return this.codec.decode(segments(path).join("/"), await this.readBinary(path));
  }
  async readBinary(path: string) {
    const e = this.get(path);
    if (!e || e.type !== "file") throw new Error(`ENOENT: ${path}`);
    return e.data.slice(0);
  }
  async write(path: string, data: string, o?: DataWriteOptions) {
    await this.writeBinary(path, this.codec.encode(segments(path).join("/"), data), o);
  }
  async writeBinary(path: string, data: ArrayBuffer, o?: DataWriteOptions) {
    const p = segments(path).join("/");
    const now = Date.now();
    this.ensureParents(p, now);
    const prev = this.entries.get(p);
    this.entries.set(p, { type: "file", data: data.slice(0), ctime: o?.ctime ?? prev?.ctime ?? now, mtime: o?.mtime ?? now });
  }
  async append(path: string, data: string, o?: DataWriteOptions) {
    await this.appendBinary(path, this.codec.encodeAppend(segments(path).join("/"), data), o);
  }
  async appendBinary(path: string, data: ArrayBuffer, o?: DataWriteOptions) {
    const prev = (await this.exists(path, true)) ? new Uint8Array(await this.readBinary(path)) : new Uint8Array();
    const next = new Uint8Array(prev.length + data.byteLength);
    next.set(prev);
    next.set(new Uint8Array(data), prev.length);
    await this.writeBinary(path, next.buffer, o);
  }
  async process(path: string, fn: (d: string) => string, o?: DataWriteOptions) {
    const next = fn(await this.read(path));
    await this.write(path, next, o);
    return next;
  }
  getResourcePath(path: string) {
    return resourceUrl(this.vaultId, segments(path).join("/"), this.mtimeOf(path));
  }
  async mkdir(path: string) {
    const p = segments(path).join("/");
    const now = Date.now();
    this.ensureParents(p + "/x", now);
  }
  async trashSystem() {
    return false;
  }
  async trashLocal(path: string) {
    const name = segments(path).pop() ?? "";
    let target = `.trash/${name}`;
    for (let i = 1; this.entries.has(target); i++) target = `.trash/${name} ${i}`;
    await this.rename(path, target);
  }
  async rmdir(path: string, recursive: boolean) {
    const p = segments(path).join("/");
    const children = Array.from(this.entries.keys()).filter((k) => k.startsWith(p + "/"));
    if (children.length && !recursive) throw new Error(`ENOTEMPTY: ${path}`);
    for (const k of children) this.entries.delete(k);
    this.entries.delete(p);
  }
  async remove(path: string) {
    this.entries.delete(segments(path).join("/"));
  }
  async rename(from: string, to: string) {
    const src = segments(from).join("/");
    const dst = segments(to).join("/");
    const now = Date.now();
    this.ensureParents(dst, now);
    for (const [k, v] of Array.from(this.entries)) {
      if (k === src || k.startsWith(src + "/")) {
        this.entries.delete(k);
        this.entries.set(dst + k.slice(src.length), v);
      }
    }
  }
  async copy(from: string, to: string) {
    const src = segments(from).join("/");
    const dst = segments(to).join("/");
    for (const [k, v] of Array.from(this.entries)) {
      if (k === src || k.startsWith(src + "/")) this.entries.set(dst + k.slice(src.length), { ...v, data: v.data.slice(0) });
    }
  }
}
