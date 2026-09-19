/**
 * The persistent side of the semantic index: one IndexedDB database per
 * vault. It remembers which embedding model built it; a different model makes
 * every stored vector useless, so the stores are cleared and rebuilt.
 *
 *   meta    "info"  → { model, dims, nextKey, nextFile }
 *   files   path    → FileRecord (what was indexed, and its passages' keys)
 *   chunks  key     → ChunkRecord (passage, place in the note, vector)
 */

export interface FileRecord {
  path: string;
  fileId: number;
  mtime: number;
  size: number;
  hash: string;
  keys: number[];
}

export interface ChunkRecord {
  key: number;
  path: string;
  headings: string[];
  startLine: number;
  endLine: number;
  text: string;
  /** Hash of the embedded text, so an unchanged passage keeps its vector when the note is edited elsewhere. */
  hash: string;
  vector: Float32Array;
}

export interface MetaRecord {
  model: string;
  dims: number;
  nextKey: number;
  nextFile: number;
}

const VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException("Aborted", "AbortError"));
  });
}

export class SemanticStore {
  private db: IDBDatabase | null = null;

  constructor(readonly name: string) {}

  async open(): Promise<void> {
    if (this.db) return;
    const open = indexedDB.open(this.name, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "path" });
      if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: "key" });
    };
    this.db = await req(open);
    this.db.onversionchange = () => this.close();
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  private get d(): IDBDatabase {
    if (!this.db) throw new Error("Semantic index is closed.");
    return this.db;
  }

  async getMeta(): Promise<MetaRecord | null> {
    return ((await req(this.d.transaction("meta").objectStore("meta").get("info"))) as MetaRecord | undefined) ?? null;
  }

  async putMeta(meta: MetaRecord): Promise<void> {
    const tx = this.d.transaction("meta", "readwrite");
    tx.objectStore("meta").put(meta, "info");
    await done(tx);
  }

  async clear(meta: MetaRecord): Promise<void> {
    const tx = this.d.transaction(["meta", "files", "chunks"], "readwrite");
    tx.objectStore("files").clear();
    tx.objectStore("chunks").clear();
    tx.objectStore("meta").put(meta, "info");
    await done(tx);
  }

  async allFiles(): Promise<FileRecord[]> {
    return (await req(this.d.transaction("files").objectStore("files").getAll())) as FileRecord[];
  }

  /** Streams every passage in pages, so a large vault never sits in memory twice. */
  async eachChunkPage(pageSize: number, cb: (page: ChunkRecord[]) => void | Promise<void>): Promise<void> {
    let lower: number | null = null;
    for (;;) {
      const range: IDBKeyRange | undefined = lower === null ? undefined : IDBKeyRange.lowerBound(lower, true);
      const page = (await req(this.d.transaction("chunks").objectStore("chunks").getAll(range, pageSize))) as ChunkRecord[];
      if (!page.length) return;
      await cb(page);
      lower = page[page.length - 1]!.key;
      if (page.length < pageSize) return;
    }
  }

  async getChunks(keys: number[]): Promise<(ChunkRecord | undefined)[]> {
    const store = this.d.transaction("chunks").objectStore("chunks");
    return Promise.all(keys.map((k) => req(store.get(k)) as Promise<ChunkRecord | undefined>));
  }

  /** Replaces a file's passages in one transaction (and its meta counters). */
  async writeFile(file: FileRecord, chunks: ChunkRecord[], removeKeys: number[], meta: MetaRecord): Promise<void> {
    const tx = this.d.transaction(["meta", "files", "chunks"], "readwrite");
    const cs = tx.objectStore("chunks");
    for (const k of removeKeys) cs.delete(k);
    for (const c of chunks) cs.put(c);
    tx.objectStore("files").put(file);
    tx.objectStore("meta").put(meta, "info");
    await done(tx);
  }

  async removeFile(path: string, keys: number[]): Promise<void> {
    const tx = this.d.transaction(["files", "chunks"], "readwrite");
    const cs = tx.objectStore("chunks");
    for (const k of keys) cs.delete(k);
    tx.objectStore("files").delete(path);
    await done(tx);
  }

  /** Moves a file record to a new path; passages keep their vectors. */
  async renameFile(oldPath: string, rec: FileRecord): Promise<void> {
    const tx = this.d.transaction(["files", "chunks"], "readwrite");
    const fs = tx.objectStore("files");
    fs.delete(oldPath);
    fs.put(rec);
    const cs = tx.objectStore("chunks");
    for (const k of rec.keys) {
      const r = cs.get(k);
      r.onsuccess = () => {
        const c = r.result as ChunkRecord | undefined;
        if (c) cs.put({ ...c, path: rec.path });
      };
    }
    await done(tx);
  }

  static async destroy(name: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = r.onerror = r.onblocked = () => resolve();
    });
  }
}
