/**
 * Where sync keeps what it knows about this device, outside the vault.
 *
 * Its own IndexedDB database rather than a store in `vault-app`: nothing here
 * belongs to a vault's files, a vault export or zip never carries it, and a
 * version bump of the app's database cannot race this one.
 *
 * Keys are wrapped with an AES-GCM key generated here with
 * `extractable: false`. What that buys, stated honestly: the account and vault
 * keys are never in the vault folder, never in anything that syncs or exports
 * the folder, and script cannot export the wrapping key's raw bytes. What it
 * does not buy: code running in this origin can still ask the key to decrypt,
 * and while sync runs both keys are in memory, because the engine needs them.
 */
import type { SyncState } from "@opensync/client";

const DB = "openmarkdown-sync";
const STORE = "sync";

export interface Secrets {
  accountSecret: string;
  namespaceKey: string;
}

export interface DeviceRecord {
  v: 1;
  vaultId: string;
  /** The account's fingerprint, as printed on the recovery kit ("3nre-z5rp"). */
  accountId: string;
  namespace: string;
  relayWs: string;
  relayHttp: string;
  deviceLabel: string;
  /** What this device asked for; the plan decides whether it gets it. */
  carryAttachments: boolean;
  plan: "free" | "supporter";
  paused: boolean;
  enrolledAt: number;
  /** Pull as soon as the vault opens: set by "Open a synced vault" and by joining. */
  pullOnOpen?: boolean;
  /** Whether the user confirmed the recovery kit was saved. */
  kitSaved?: boolean;
  wrapped: { iv: Uint8Array; ct: Uint8Array };
}

export interface LogEntry {
  at: number;
  kind: "synced" | "pulled" | "published" | "merged" | "error" | "info";
  text: string;
  paths?: string[];
}

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

export const syncDb = {
  get<T>(key: string): Promise<T | undefined> {
    return run<T | undefined>("readonly", (s) => s.get(key));
  },
  set(key: string, value: unknown): Promise<void> {
    return run<void>("readwrite", (s) => {
      s.put(value, key);
    });
  },
  delete(key: string): Promise<void> {
    return run<void>("readwrite", (s) => {
      s.delete(key);
    });
  },
  async keys(prefix: string): Promise<string[]> {
    const all = await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + "￿")));
    return all.map(String);
  },
};

/** The origin's wrapping key, made once. Non-extractable: `exportKey` rejects. */
export async function wrappingKey(): Promise<CryptoKey> {
  const existing = await syncDb.get<CryptoKey>("wrapkey");
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await syncDb.set("wrapkey", key);
  return key;
}

export async function wrap(secrets: Secrets): Promise<DeviceRecord["wrapped"]> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(secrets));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrappingKey(), plain));
  plain.fill(0);
  return { iv, ct };
}

export async function unwrap(wrapped: DeviceRecord["wrapped"]): Promise<Secrets> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapped.iv as BufferSource }, await wrappingKey(), wrapped.ct as BufferSource);
  return JSON.parse(new TextDecoder().decode(plain)) as Secrets;
}

export const device = {
  get: (vaultId: string) => syncDb.get<DeviceRecord>(`device:${vaultId}`),
  set: (record: DeviceRecord) => syncDb.set(`device:${record.vaultId}`, record),
  async update(vaultId: string, patch: Partial<DeviceRecord>): Promise<DeviceRecord | undefined> {
    const current = await syncDb.get<DeviceRecord>(`device:${vaultId}`);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await syncDb.set(`device:${vaultId}`, next);
    return next;
  },
  /** Every vault in this browser linked to `accountId`, for the one-vault-per-account rule. */
  async vaultsForAccount(accountId: string): Promise<string[]> {
    const out: string[] = [];
    for (const key of await syncDb.keys("device:")) {
      const r = await syncDb.get<DeviceRecord>(key);
      if (r?.accountId === accountId) out.push(r.vaultId);
    }
    return out;
  },
};

/** The engine's `StateStore`, per vault. */
export function stateStore(vaultId: string) {
  return {
    load: async () => (await syncDb.get<SyncState>(`state:${vaultId}`)) ?? null,
    save: (s: SyncState) => syncDb.set(`state:${vaultId}`, s),
  };
}

export async function appendLog(vaultId: string, entry: LogEntry): Promise<void> {
  const key = `log:${vaultId}`;
  const log = (await syncDb.get<LogEntry[]>(key)) ?? [];
  log.push(entry);
  await syncDb.set(key, log.slice(-200));
}

export async function readLog(vaultId: string): Promise<LogEntry[]> {
  return (await syncDb.get<LogEntry[]>(`log:${vaultId}`)) ?? [];
}

/** Everything this device knows about a vault's sync, and nothing in the vault itself. */
export async function forgetVault(vaultId: string): Promise<void> {
  for (const prefix of ["device:", "state:", "log:", "dismissed:", "devices:"]) await syncDb.delete(`${prefix}${vaultId}`);
}
