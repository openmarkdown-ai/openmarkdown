/**
 * A few-line IndexedDB key/value store.
 *
 * Used for what localStorage cannot hold: directory handles (structured-clone
 * only), file creation times the File System Access API does not report, file
 * recovery snapshots, the unsaved-edit journal, and cached plugin downloads.
 *
 * Robustness: another tab opening a newer schema closes this connection
 * (`onversionchange`) and says so; an upgrade blocked by an old tab says so; a
 * failed or closed connection is reopened on the next call instead of being
 * cached forever; a store another build added under the same version number is
 * created by bumping the version once. Stores that hold user data are written
 * with `durability: "strict"` (Chromium defaults to relaxed since 121).
 */

const DB_NAME = "vault-app";
const DB_VERSION = 4;
const STORES = ["kv", "handles", "ctimes", "snapshots", "cache", "journal"] as const;
export type StoreName = (typeof STORES)[number];

const STRICT = new Set<StoreName>(["handles", "snapshots", "journal"]);

let dbPromise: Promise<IDBDatabase> | null = null;
/** The open connection once `dbPromise` has resolved, so a page-hide handler can start a request synchronously. */
let openDb: IDBDatabase | null = null;

function notify(message: string) {
  if (typeof document === "undefined") return;
  void import("../ui/notice").then(({ Notice }) => new Notice(message, 0)).catch(() => {});
}

function openVersion(version: number | undefined): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onblocked = () => notify("Close other tabs of this app to finish updating its storage.");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function connect(): Promise<IDBDatabase> {
  let db: IDBDatabase;
  try {
    db = await openVersion(DB_VERSION);
  } catch (e) {
    // A newer build already upgraded past DB_VERSION: open whatever is there.
    if ((e as DOMException | null)?.name !== "VersionError") throw e;
    db = await openVersion(undefined);
  }
  if (!STORES.every((s) => db.objectStoreNames.contains(s))) {
    const next = db.version + 1;
    db.close();
    db = await openVersion(next);
  }
  db.onversionchange = () => {
    db.close();
    dbPromise = null;
    openDb = null;
    notify("This app was updated in another tab. Reload this tab to keep saving recovery data.");
  };
  db.onclose = () => {
    dbPromise = null;
    openDb = null;
  };
  openDb = db;
  return db;
}

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = connect();
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function transaction(db: IDBDatabase, store: StoreName, mode: IDBTransactionMode): IDBTransaction {
  if (mode === "readwrite" && STRICT.has(store)) {
    try {
      return db.transaction(store, mode, { durability: "strict" });
    } catch {
      /* older engines: no options argument */
    }
  }
  return db.transaction(store, mode);
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = transaction(db, store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        t.oncomplete = () => resolve(req ? req.result : (undefined as T));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const idb = {
  /** Open the connection ahead of the first request. */
  warm(): Promise<void> {
    return open().then(
      () => {},
      () => {},
    );
  },
  /**
   * `set`, with the transaction created before this returns when a connection is
   * already open, and committed explicitly (page hide: a request started later,
   * or an automatic commit that waits for the put's result, may never happen).
   */
  setNow(store: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
    const db = openDb;
    if (!db) return idb.set(store, key, value);
    try {
      const t = transaction(db, store, "readwrite");
      t.objectStore(store).put(value, key);
      // Commit now rather than after the put's result comes back to this page, which an unloading page may never see.
      (t as IDBTransaction & { commit?: () => void }).commit?.();
      return new Promise<void>((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    } catch {
      return idb.set(store, key, value);
    }
  },
  get<T = unknown>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return tx<T>(store, "readonly", (s) => s.get(key) as IDBRequest<T>);
  },
  set(store: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
    return tx<void>(store, "readwrite", (s) => {
      s.put(value, key);
    });
  },
  delete(store: StoreName, key: IDBValidKey): Promise<void> {
    return tx<void>(store, "readwrite", (s) => {
      s.delete(key);
    });
  },
  /** Delete `key` only if `keep(currentValue)` is false, in one transaction. */
  deleteIf<T = unknown>(store: StoreName, key: IDBValidKey, shouldDelete: (value: T | undefined) => boolean): Promise<void> {
    return tx<void>(store, "readwrite", (s) => {
      const req = s.get(key);
      req.onsuccess = () => {
        if (shouldDelete(req.result as T | undefined)) s.delete(key);
      };
    });
  },
  /** All entries whose key starts with `prefix` (string keys only). */
  async entries<T = unknown>(store: StoreName, prefix = ""): Promise<[string, T][]> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const out: [string, T][] = [];
      const t = db.transaction(store, "readonly");
      const range = prefix ? IDBKeyRange.bound(prefix, prefix + "￿") : undefined;
      const req = t.objectStore(store).openCursor(range);
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        out.push([String(c.key), c.value as T]);
        c.continue();
      };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  },
  async deletePrefix(store: StoreName, prefix: string): Promise<void> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = transaction(db, store, "readwrite");
      t.objectStore(store).delete(IDBKeyRange.bound(prefix, prefix + "￿"));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },
};
