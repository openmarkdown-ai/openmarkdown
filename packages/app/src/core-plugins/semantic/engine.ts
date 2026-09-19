/**
 * The semantic index of a vault: passages, their embeddings, and search by
 * similarity.
 *
 * - Passages come from `chunkNote` (by heading and paragraph).
 * - Embeddings come from `app.ai.embed` for the "related" feature; nothing is
 *   embedded until AI is on and that feature has an engine.
 * - Vectors persist in IndexedDB (store.ts), one database per vault, rebuilt
 *   when the embedding model changes. On start the index loads what it has and
 *   queues only notes whose size or modified time changed, so an interrupted
 *   build resumes where it stopped.
 * - Vault events queue work, debounced per note; work runs in small batches
 *   that yield to the page, can be paused, and report progress.
 * - Similarity search runs in a Web Worker over a dense vector table.
 */
import { AiUnavailableError, type AiService, type EngineInfo } from "../../ai/types";
import { Events } from "../../obsidian/events";
import { TFile, type TAbstractFile } from "../../obsidian/vault/files";
import { chunkNote, embeddingText, hashString, type Chunk } from "./chunker";
import { SemanticStore, type ChunkRecord, type FileRecord, type MetaRecord } from "./store";
import { VectorTable, type VectorHit, type WorkerRequest, type WorkerResponse } from "./vectors";

export interface PassageHit {
  key: number;
  path: string;
  headings: string[];
  startLine: number;
  endLine: number;
  score: number;
}

export interface NoteHit {
  path: string;
  /** The best passage's score. */
  score: number;
  passages: PassageHit[];
}

export type IndexState = "off" | "unavailable" | "loading" | "indexing" | "paused" | "ready" | "error";

export interface IndexStatus {
  state: IndexState;
  /** Notes processed / queued in the current run. */
  done: number;
  total: number;
  notes: number;
  passages: number;
  model: string | null;
  engine: EngineInfo | null;
  message: string;
}

export interface SemanticOptions {
  excludeFolders: string[];
  respectExcludedFiles: boolean;
}

/** Passages embedded per request. */
const BATCH_PASSAGES = 24;
/** A note is re-indexed this long after its last change. */
const MODIFY_DEBOUNCE_MS = 2500;
/** Main-thread work slice before yielding to input. */
const SLICE_MS = 12;
const MAX_PASSAGES_PER_NOTE = 400;

export function getAi(app: any): AiService | null {
  const ai = app?.ai as AiService | undefined;
  return ai && typeof ai.isAvailable === "function" ? ai : null;
}

/** The id an index is keyed by: provider and model, since two providers may serve models with the same name differently. */
export function modelKey(engine: EngineInfo): string {
  return engine.model.startsWith(`${engine.provider}:`) ? engine.model : `${engine.provider}:${engine.model}`;
}

/** Whether an embedding result's model is the one the index was built with (results may or may not carry the provider prefix). */
export function sameModel(resultModel: string, indexModel: string): boolean {
  return resultModel === indexModel || indexModel.endsWith(`:${resultModel}`) || resultModel.endsWith(`:${indexModel}`);
}

const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id"> : never) : never;

/** Worker-backed vector search with an in-thread fallback. */
class SearchBackend {
  private worker: Worker | null = null;
  private local: VectorTable | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: WorkerResponse) => void>();

  constructor() {
    try {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "semantic-search" });
      this.worker.onmessage = (evt: MessageEvent<WorkerResponse>) => {
        const cb = this.pending.get(evt.data.id);
        this.pending.delete(evt.data.id);
        cb?.(evt.data);
      };
      this.worker.onerror = () => this.fallBack();
    } catch {
      this.fallBack();
    }
  }

  private fallBack() {
    this.worker?.terminate();
    this.worker = null;
    this.local ??= new VectorTable();
    for (const [, cb] of this.pending) cb({ id: 0, error: "Search worker failed." });
    this.pending.clear();
  }

  call(body: RequestBody, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const req = { ...body, id: this.nextId++ } as WorkerRequest;
    if (!this.worker) {
      this.local ??= new VectorTable();
      return Promise.resolve(this.local.handle(req));
    }
    return new Promise((resolve) => {
      this.pending.set(req.id, resolve);
      this.worker!.postMessage(req, transfer);
    });
  }

  destroy() {
    this.worker?.terminate();
    this.worker = null;
    this.local = null;
  }
}

interface PassageMeta {
  fileId: number;
  headings: string[];
  startLine: number;
  endLine: number;
}

export class SemanticIndex extends Events {
  readonly store: SemanticStore;
  private backend: SearchBackend | null = null;
  private meta: MetaRecord | null = null;
  private files = new Map<string, FileRecord>();
  private pathOfFile = new Map<number, string>();
  private passages = new Map<number, PassageMeta>();
  private queue = new Set<string>();
  private removals = new Set<string>();
  private timers = new Map<string, number>();
  private running = false;
  private paused = false;
  private started = false;
  private destroyed = false;
  private controller: AbortController | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private status: IndexStatus = { state: "off", done: 0, total: 0, notes: 0, passages: 0, model: null, engine: null, message: "" };

  constructor(
    private app: any,
    private options: () => SemanticOptions,
    /** False while a plugin that does the same job (Smart Connections) is enabled. */
    private allowed: () => boolean,
  ) {
    super();
    this.store = new SemanticStore(`openmarkdown-semantic:${app.appId ?? app.vault?.getName?.() ?? "vault"}`);
  }

  getStatus(): IndexStatus {
    return { ...this.status, notes: this.files.size, passages: this.passages.size };
  }

  private setStatus(patch: Partial<IndexStatus>) {
    Object.assign(this.status, patch);
    this.trigger("status", this.getStatus());
  }

  private ai(): AiService | null {
    return getAi(this.app);
  }

  isAvailable(): boolean {
    return !!this.ai()?.isAvailable("related", "embed") && this.allowed();
  }

  /** True once passages are loaded and queries can run (possibly while indexing continues). */
  isQueryable(): boolean {
    return this.started && !!this.meta?.dims && this.passages.size > 0;
  }

  isPaused(): boolean {
    return this.paused;
  }

  // ---- lifecycle ------------------------------------------------------------------

  /** Starts (or restarts after settings change) when AI is available. Asks for consent first. */
  async start(opts: { askConsent?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    const ai = this.ai();
    if (!ai || !this.isAvailable()) {
      this.cancelRun();
      this.setStatus({ state: "unavailable", message: this.allowed() ? "Turn on AI in Settings → AI and choose an engine for related notes." : "Smart Connections is enabled, so this index is paused." });
      return;
    }
    const engine = ai.engineFor("related", "embed");
    if (opts.askConsent !== false && !(await ai.ensureConsent("related", "embed"))) {
      this.setStatus({ state: "unavailable", engine, message: "Indexing needs your permission for the embedding engine." });
      return;
    }
    const model = engine ? modelKey(engine) : "unknown";
    if (this.started && this.meta?.model === model) {
      this.setStatus({ engine });
      this.reconcile();
      return;
    }
    this.setStatus({ state: "loading", engine, model, message: "Loading the index…" });
    await this.exclusive(async () => {
      await this.store.open();
      this.backend ??= new SearchBackend();
      let meta = await this.store.getMeta();
      if (!meta || meta.model !== model) {
        meta = { model, dims: 0, nextKey: 1, nextFile: 1 };
        await this.store.clear(meta);
      }
      this.meta = meta;
      await this.loadAll();
    });
    this.started = true;
    this.setStatus({ state: "ready", message: "" });
    this.reconcile();
  }

  private async loadAll() {
    this.files.clear();
    this.pathOfFile.clear();
    this.passages.clear();
    await this.backend!.call({ op: "reset", dims: this.meta!.dims });
    for (const rec of await this.store.allFiles()) {
      this.files.set(rec.path, rec);
      this.pathOfFile.set(rec.fileId, rec.path);
    }
    await this.store.eachChunkPage(500, async (page) => {
      const keys: number[] = [];
      const fileIds: number[] = [];
      const vectors: Float32Array[] = [];
      for (const c of page) {
        const rec = this.files.get(c.path);
        if (!rec) continue;
        this.passages.set(c.key, { fileId: rec.fileId, headings: c.headings, startLine: c.startLine, endLine: c.endLine });
        keys.push(c.key);
        fileIds.push(rec.fileId);
        vectors.push(c.vector);
      }
      await this.backend!.call({ op: "upsert", keys, files: fileIds, vectors }, vectors.map((v) => v.buffer));
      await yieldToPage();
    });
  }

  destroy() {
    this.destroyed = true;
    this.cancelRun();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.backend?.destroy();
    this.backend = null;
    this.store.close();
    this.started = false;
  }

  /** Forgets every vector and indexes the vault again. */
  async rebuild(): Promise<void> {
    this.cancelRun();
    await this.exclusive(async () => {
      if (!this.meta) return;
      await this.store.open();
      this.meta = { model: this.meta.model, dims: 0, nextKey: 1, nextFile: 1 };
      await this.store.clear(this.meta);
      await this.loadAll();
    });
    this.started = false;
    this.meta = null;
    await this.start({ askConsent: false });
  }

  pause() {
    this.paused = true;
    this.controller?.abort();
    if (this.queue.size || this.running) this.setStatus({ state: "paused", message: "Indexing is paused." });
  }

  resume() {
    this.paused = false;
    if (this.status.state === "paused" || this.status.state === "error") this.setStatus({ state: this.queue.size ? "indexing" : "ready", message: "" });
    this.kick();
  }

  private cancelRun() {
    this.controller?.abort();
    this.queue.clear();
    this.removals.clear();
  }

  /** Runs store work one at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.serial.then(fn, fn);
    this.serial = p.catch(() => undefined);
    return p;
  }

  // ---- what belongs in the index ----------------------------------------------------

  isIndexable(file: TAbstractFile | null): file is TFile {
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    const { excludeFolders, respectExcludedFiles } = this.options();
    for (const folder of excludeFolders) {
      const f = folder.replace(/^\/+|\/+$/g, "");
      if (f && (file.path === f || file.path.startsWith(f + "/"))) return false;
    }
    if (respectExcludedFiles && this.app.metadataCache.isUserIgnored?.(file.path)) return false;
    return true;
  }

  /** Queues every note whose size or time changed, and removes notes that are gone or now excluded. */
  reconcile() {
    if (!this.started) return;
    const seen = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles() as TFile[]) {
      if (!this.isIndexable(file)) continue;
      seen.add(file.path);
      const rec = this.files.get(file.path);
      if (!rec || rec.mtime !== file.stat.mtime || rec.size !== file.stat.size) this.queue.add(file.path);
    }
    for (const path of this.files.keys()) if (!seen.has(path)) this.removals.add(path);
    this.setStatus({ done: 0, total: this.queue.size + this.removals.size });
    this.kick();
  }

  onCreate(file: TAbstractFile) {
    if (!this.started || !this.isIndexable(file)) return;
    this.schedule(file.path, 500);
  }

  onModify(file: TAbstractFile) {
    if (!this.started || !this.isIndexable(file)) return;
    this.schedule(file.path, MODIFY_DEBOUNCE_MS);
  }

  onDelete(file: TAbstractFile) {
    if (!this.started || !(file instanceof TFile)) return;
    this.queue.delete(file.path);
    if (this.files.has(file.path)) {
      this.removals.add(file.path);
      this.status.total++;
      this.kick();
    }
  }

  onRename(file: TAbstractFile, oldPath: string) {
    if (!this.started || !(file instanceof TFile)) return;
    const rec = this.files.get(oldPath);
    if (this.queue.delete(oldPath) && this.isIndexable(file)) this.queue.add(file.path);
    if (!rec) {
      if (this.isIndexable(file)) this.schedule(file.path, 500);
      return;
    }
    if (!this.isIndexable(file)) {
      this.removals.add(oldPath);
      this.kick();
      return;
    }
    void this.exclusive(async () => {
      const current = this.files.get(oldPath);
      if (!current) return;
      const next = { ...current, path: file.path };
      await this.store.renameFile(oldPath, next);
      this.files.delete(oldPath);
      this.files.set(file.path, next);
      this.pathOfFile.set(next.fileId, file.path);
      this.trigger("updated", [oldPath, file.path]);
    });
  }

  private schedule(path: string, delay: number) {
    const t = this.timers.get(path);
    if (t) clearTimeout(t);
    this.timers.set(
      path,
      window.setTimeout(() => {
        this.timers.delete(path);
        if (!this.queue.has(path)) this.status.total++;
        this.queue.add(path);
        this.kick();
      }, delay),
    );
  }

  // ---- the indexing loop --------------------------------------------------------------

  private kick() {
    if (this.running || this.paused || !this.started || this.destroyed) return;
    if (!this.queue.size && !this.removals.size) return;
    void this.run();
  }

  private async run() {
    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.setStatus({ state: "indexing", message: "" });
    const touched = new Set<string>();
    try {
      while ((this.queue.size || this.removals.size) && !this.paused && !signal.aborted) {
        if (this.removals.size) {
          const paths = Array.from(this.removals);
          this.removals.clear();
          await this.exclusive(async () => {
            for (const p of paths) await this.removeNow(p);
          });
          this.status.done += paths.length;
          paths.forEach((p) => touched.add(p));
          this.setStatus({});
          continue;
        }
        const batch = await this.prepareBatch(signal);
        if (signal.aborted) break;
        if (batch.length) {
          try {
            await this.embedAndStore(batch, signal);
          } catch (e) {
            // Nothing of this batch was stored: keep it queued for the next run.
            for (const b of batch) if (!this.files.has(b.path) || this.files.get(b.path)!.hash !== b.hash) this.queue.add(b.path);
            throw e;
          }
          batch.forEach((b) => touched.add(b.path));
        }
        if (touched.size >= 20) {
          this.trigger("updated", Array.from(touched));
          touched.clear();
        }
        await yieldToPage();
      }
      if (!signal.aborted && !this.paused) this.setStatus({ state: "ready", message: "", done: 0, total: 0 });
    } catch (e) {
      if ((e as Error)?.name === "AbortError" || signal.aborted) {
        // Paused or restarted: the unfinished notes are still queued.
      } else {
        const message = e instanceof AiUnavailableError ? e.message : `Indexing stopped: ${String((e as Error)?.message ?? e)}`;
        this.setStatus({ state: "error", message });
      }
    } finally {
      this.running = false;
      this.controller = null;
      if (touched.size) this.trigger("updated", Array.from(touched));
      if (this.paused && (this.queue.size || this.removals.size)) this.setStatus({ state: "paused", message: "Indexing is paused." });
      else if (!this.paused && this.status.state !== "error" && (this.queue.size || this.removals.size)) this.kick();
    }
  }

  private async removeNow(path: string) {
    const rec = this.files.get(path);
    if (!rec) return;
    await this.store.removeFile(path, rec.keys);
    await this.backend!.call({ op: "remove", keys: rec.keys });
    for (const k of rec.keys) this.passages.delete(k);
    this.files.delete(path);
    this.pathOfFile.delete(rec.fileId);
  }

  /** Reads queued notes until a batch of passages is ready. Unchanged notes (same hash) are settled here. */
  private async prepareBatch(signal: AbortSignal): Promise<PreparedNote[]> {
    const out: PreparedNote[] = [];
    let passages = 0;
    let sliceStart = performance.now();
    for (const path of Array.from(this.queue)) {
      if (signal.aborted || passages >= BATCH_PASSAGES) break;
      this.queue.delete(path);
      const file = this.app.vault.getFileByPath(path) as TFile | null;
      if (!this.isIndexable(file)) {
        if (this.files.has(path)) this.removals.add(path);
        this.status.done++;
        continue;
      }
      const text: string = await this.app.vault.cachedRead(file);
      const hash = hashString(text);
      const rec = this.files.get(path);
      if (rec && rec.hash === hash) {
        const next = { ...rec, mtime: file.stat.mtime, size: file.stat.size };
        this.files.set(path, next);
        await this.exclusive(() => this.store.writeFile(next, [], [], this.meta!));
        this.status.done++;
        continue;
      }
      const chunks = chunkNote(text).slice(0, MAX_PASSAGES_PER_NOTE);
      const texts = chunks.map((c) => embeddingText(file.basename, c));
      out.push({ path, file, hash, chunks, texts, hashes: texts.map((t) => hashString(t)) });
      passages += chunks.length;
      if (performance.now() - sliceStart > SLICE_MS) {
        await yieldToPage();
        sliceStart = performance.now();
      }
    }
    return out;
  }

  private async embedAndStore(batch: PreparedNote[], signal: AbortSignal) {
    const ai = this.ai();
    if (!ai || !this.isAvailable()) throw new AiUnavailableError("disabled", "AI is off, so indexing stopped.");
    // Passages whose text did not change keep their vectors.
    const reuse = new Map<string, ChunkRecord>();
    for (const note of batch) {
      const rec = this.files.get(note.path);
      if (!rec?.keys.length) continue;
      for (const c of await this.store.getChunks(rec.keys)) if (c) reuse.set(c.hash, c);
    }
    const toEmbed: string[] = [];
    const seen = new Set<string>();
    for (const note of batch)
      note.texts.forEach((t, i) => {
        const h = note.hashes[i]!;
        if (!reuse.has(h) && !seen.has(h)) {
          seen.add(h);
          toEmbed.push(t);
        }
      });
    const fresh = new Map<string, Float32Array>();
    for (let i = 0; i < toEmbed.length; i += BATCH_PASSAGES) {
      const texts = toEmbed.slice(i, i + BATCH_PASSAGES);
      const result = await ai.embed({ texts, kind: "document", signal });
      if (signal.aborted) throw new DOMException("Paused", "AbortError");
      if (!sameModel(result.model, this.meta!.model)) {
        // The engine answered with another model: the stored vectors are no longer comparable.
        batch.forEach((b) => this.queue.add(b.path));
        this.started = false;
        this.meta = null;
        void this.start({ askConsent: false });
        throw new DOMException("Model changed", "AbortError");
      }
      if (!this.meta!.dims) {
        this.meta!.dims = result.dims;
        await this.backend!.call({ op: "reset", dims: result.dims });
      }
      texts.forEach((t, j) => fresh.set(hashString(t), result.vectors[j]!));
    }
    await this.exclusive(async () => {
      for (const note of batch) {
        const meta = this.meta!;
        const old = this.files.get(note.path);
        const fileId = old?.fileId ?? meta.nextFile++;
        const records: ChunkRecord[] = note.chunks.map((c, i) => {
          const h = note.hashes[i]!;
          const vector = fresh.get(h) ?? reuse.get(h)!.vector;
          return { key: meta.nextKey++, path: note.path, headings: c.headings, startLine: c.startLine, endLine: c.endLine, text: c.text, hash: h, vector };
        });
        const rec: FileRecord = { path: note.path, fileId, mtime: note.file.stat.mtime, size: note.file.stat.size, hash: note.hash, keys: records.map((r) => r.key) };
        await this.store.writeFile(rec, records, old?.keys ?? [], meta);
        if (old?.keys.length) {
          await this.backend!.call({ op: "remove", keys: old.keys });
          for (const k of old.keys) this.passages.delete(k);
        }
        await this.backend!.call({
          op: "upsert",
          keys: records.map((r) => r.key),
          files: records.map(() => fileId),
          // Copies: the same vector may serve two passages with identical text.
          vectors: records.map((r) => new Float32Array(r.vector)),
        });
        for (const r of records) this.passages.set(r.key, { fileId, headings: r.headings, startLine: r.startLine, endLine: r.endLine });
        this.files.set(note.path, rec);
        this.pathOfFile.set(fileId, note.path);
        this.status.done++;
      }
    });
    this.setStatus({});
  }

  // ---- queries ------------------------------------------------------------------------

  private toPassages(hits: VectorHit[]): PassageHit[] {
    const out: PassageHit[] = [];
    for (const h of hits) {
      const m = this.passages.get(h.key);
      const path = this.pathOfFile.get(h.file);
      if (!m || !path) continue;
      out.push({ key: h.key, path, headings: m.headings, startLine: m.startLine, endLine: m.endLine, score: h.score });
    }
    return out;
  }

  private fileIds(paths?: string[]): number[] | undefined {
    if (!paths) return undefined;
    const ids: number[] = [];
    for (const p of paths) {
      const id = this.files.get(p)?.fileId;
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }

  /** Embeds `text` and returns the most similar passages. */
  async searchText(text: string, opts: { k?: number; kind?: "query" | "document"; excludePaths?: string[]; onlyPaths?: string[]; signal?: AbortSignal } = {}): Promise<PassageHit[]> {
    const ai = this.ai();
    if (!ai || !this.isQueryable() || !text.trim()) return [];
    const result = await ai.embed({ texts: [text.slice(0, 4000)], kind: opts.kind ?? "query", signal: opts.signal });
    if (!this.meta || !sameModel(result.model, this.meta.model)) return [];
    const onlyFiles = this.fileIds(opts.onlyPaths);
    if (onlyFiles && !onlyFiles.length) return [];
    const res = await this.backend!.call({ op: "search", vector: result.vectors[0]!, k: opts.k ?? 40, excludeFiles: this.fileIds(opts.excludePaths), onlyFiles });
    return this.toPassages(res.hits ?? []);
  }

  /** Passages most like the whole note at `path` (the mean of its passages), from other notes. */
  async similarToNote(path: string, k = 60): Promise<PassageHit[] | null> {
    const rec = this.files.get(path);
    if (!rec || !this.backend) return null;
    const res = await this.backend.call({ op: "similarToFile", file: rec.fileId, k });
    return this.toPassages(res.hits ?? []);
  }

  isIndexed(path: string): boolean {
    return this.files.has(path);
  }

  isIndexedCurrent(file: TFile): boolean {
    const rec = this.files.get(file.path);
    return !!rec && rec.mtime === file.stat.mtime && rec.size === file.stat.size;
  }

  async passageText(keys: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (!keys.length) return out;
    await this.store.open();
    for (const c of await this.store.getChunks(keys)) if (c) out.set(c.key, c.text);
    return out;
  }
}

interface PreparedNote {
  path: string;
  file: TFile;
  hash: string;
  chunks: Chunk[];
  texts: string[];
  hashes: string[];
}

/** Groups passage hits by note, best note first. */
export function groupByNote(hits: PassageHit[], limit = 20, perNote = 3): NoteHit[] {
  const byPath = new Map<string, NoteHit>();
  for (const h of hits) {
    let n = byPath.get(h.path);
    if (!n) {
      if (byPath.size >= limit) continue;
      n = { path: h.path, score: h.score, passages: [] };
      byPath.set(h.path, n);
    }
    // Further passages only when they are nearly as close as the note's best one.
    if (n.passages.length < perNote && (!n.passages.length || h.score >= n.score * 0.6)) n.passages.push(h);
    n.score = Math.max(n.score, h.score);
  }
  return Array.from(byPath.values()).sort((a, b) => b.score - a.score);
}

/** The heading a link to a passage should name: none above the first heading, or when it only repeats the note's title (`# Note` in `Note.md`). */
export function linkHeading(path: string, headings: string[]): string | undefined {
  const heading = headings[headings.length - 1];
  if (!heading) return undefined;
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  if (headings.length === 1 && heading.trim().toLowerCase() === base.trim().toLowerCase()) return undefined;
  return heading.replace(/[#|^[\]]/g, " ").trim() || undefined;
}

/** `[[note#heading]]` link text for a passage (heading omitted above the first heading). */
export function passageLinktext(app: any, hit: { path: string; headings: string[] }, sourcePath = ""): string {
  const file = app.vault.getFileByPath(hit.path);
  const base = file ? app.metadataCache.fileToLinktext(file, sourcePath, true) : hit.path.replace(/\.md$/, "");
  const heading = linkHeading(hit.path, hit.headings);
  return heading ? `${base}#${heading}` : base;
}
