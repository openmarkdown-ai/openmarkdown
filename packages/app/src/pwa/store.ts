/**
 * A small IndexedDB database shared with the service worker (apps/web/src/sw.ts):
 *
 * - `shares`: payloads posted to the manifest's share target, keyed by id,
 *   read once by the capture surface and then deleted;
 * - `launch`: file handles from `launchQueue` handed to a new window.
 *
 * Kept apart from the vault database (obsidian/vault/idb.ts) so its schema
 * can change without bumping that database's version.
 */
const DB_NAME = "openmarkdown-pwa";
const DB_VERSION = 1;

export interface StoredShare {
  id: string;
  title: string;
  text: string;
  url: string;
  files: { name: string; type: string; blob: Blob }[];
  receivedAt: number;
}

export interface StoredLaunch {
  id: string;
  handles: FileSystemFileHandle[];
  createdAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("shares")) db.createObjectStore("shares", { keyPath: "id" });
      if (!db.objectStoreNames.contains("launch")) db.createObjectStore("launch", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(store: "shares" | "launch", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(store, mode, { durability: "strict" } as IDBTransactionOptions);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const pwaStore = {
  getShare: (id: string) => run<StoredShare>("shares", "readonly", (s) => s.get(id) as IDBRequest<StoredShare>),
  putShare: (share: StoredShare) => run("shares", "readwrite", (s) => void s.put(share)),
  deleteShare: (id: string) => run("shares", "readwrite", (s) => void s.delete(id)),
  getLaunch: (id: string) => run<StoredLaunch>("launch", "readonly", (s) => s.get(id) as IDBRequest<StoredLaunch>),
  putLaunch: (launch: StoredLaunch) => run("launch", "readwrite", (s) => void s.put(launch)),
  deleteLaunch: (id: string) => run("launch", "readwrite", (s) => void s.delete(id)),
};

export function newPwaId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
