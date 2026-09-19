/**
 * Transcripts cached in IndexedDB, keyed by the recording's content hash, the
 * engine's model, the language hint and the chunk. Re-running a transcription
 * is instant, and a cancelled run resumes from the chunks already done.
 * Content-keyed, so renaming or moving the recording keeps its cache.
 */
import type { EngineInfo, TranscriptSegment } from "../../ai/types";

const DB_NAME = "openmarkdown-transcripts";
const STORE = "chunks";

export interface CachedChunk {
  segments: TranscriptSegment[];
  language?: string;
  engine: EngineInfo;
  at: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result as T);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

export function chunkKey(hash: string, engine: EngineInfo, language: string, chunk: { start: number; end: number } | "whole"): string {
  const span = chunk === "whole" ? "whole" : `${chunk.start.toFixed(2)}-${chunk.end.toFixed(2)}`;
  return [hash, engine.provider, engine.model, language || "auto", span].join("|");
}

export const getChunk = (key: string) => run<CachedChunk>("readonly", (s) => s.get(key));
export const putChunk = (key: string, value: CachedChunk) => run<IDBValidKey>("readwrite", (s) => s.put(value, key));
export const clearCache = () => run<undefined>("readwrite", (s) => s.clear());
export const cacheCount = () => run<number>("readonly", (s) => s.count());
