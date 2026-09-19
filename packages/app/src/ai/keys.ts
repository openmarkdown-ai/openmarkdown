/**
 * API keys for AI providers: in this browser's IndexedDB, encrypted with an
 * AES-GCM key generated with `extractable: false` (the approach sync uses in
 * core-plugins/opensync/store.ts).
 *
 * What that buys: keys are never in the vault folder, never in `.obsidian/`,
 * never in localStorage, never in anything that syncs or exports, and script
 * cannot read the wrapping key's bytes. What it does not buy: code running in
 * this origin can still ask the key to decrypt, and a key is in memory while a
 * request uses it.
 */

const DB = "openmarkdown-ai";
const STORE = "keys";

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve((req ? req.result : undefined) as T);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function wrappingKey(): Promise<CryptoKey> {
  const existing = await run<CryptoKey | undefined>("readonly", (s) => s.get("wrapkey"));
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await run<void>("readwrite", (s) => {
    s.put(key, "wrapkey");
  });
  return key;
}

interface Wrapped {
  iv: Uint8Array;
  ct: Uint8Array;
  /** The last four characters, for "••••1234" in the settings. */
  hint: string;
}

/** Keys are per vault (`scope` is the app id) and per provider. */
export class AiKeychain {
  constructor(private scope: string) {}

  private id(provider: string) {
    return `key:${this.scope}:${provider}`;
  }

  async set(provider: string, secret: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(secret);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrappingKey(), plain));
    plain.fill(0);
    const record: Wrapped = { iv, ct, hint: secret.length > 8 ? secret.slice(-4) : "" };
    await run<void>("readwrite", (s) => {
      s.put(record, this.id(provider));
    });
  }

  async get(provider: string): Promise<string | null> {
    const record = await run<Wrapped | undefined>("readonly", (s) => s.get(this.id(provider)));
    if (!record) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv as BufferSource }, await wrappingKey(), record.ct as BufferSource);
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }

  async hint(provider: string): Promise<string | null> {
    const record = await run<Wrapped | undefined>("readonly", (s) => s.get(this.id(provider)));
    return record ? record.hint : null;
  }

  async remove(provider: string): Promise<void> {
    await run<void>("readwrite", (s) => {
      s.delete(this.id(provider));
    });
  }
}
