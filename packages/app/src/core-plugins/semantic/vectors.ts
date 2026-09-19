/**
 * The vector table and top-k cosine search. Runs inside the search worker
 * (worker.ts); the same class serves as the in-thread fallback when workers
 * are unavailable.
 *
 * Vectors are normalised on insert, so cosine similarity is a dot product.
 * Rows live in one growable Float32Array; a removed row is swapped with the
 * last one, so the table stays dense.
 */

export interface VectorHit {
  key: number;
  file: number;
  score: number;
}

export type WorkerRequest =
  | { id: number; op: "reset"; dims: number }
  | { id: number; op: "upsert"; keys: number[]; files: number[]; vectors: Float32Array[] }
  | { id: number; op: "remove"; keys: number[] }
  | { id: number; op: "search"; vector: Float32Array; k: number; excludeFiles?: number[]; onlyFiles?: number[] }
  | { id: number; op: "similarToFile"; file: number; k: number; excludeFiles?: number[] }
  | { id: number; op: "count" };

export type WorkerResponse = { id: number; hits?: VectorHit[]; count?: number; error?: string };

export class VectorTable {
  dims = 0;
  private data = new Float32Array(0);
  private keys: number[] = [];
  private files: number[] = [];
  private rowOf = new Map<number, number>();

  reset(dims: number) {
    this.dims = dims;
    this.data = new Float32Array(0);
    this.keys = [];
    this.files = [];
    this.rowOf.clear();
  }

  get size(): number {
    return this.keys.length;
  }

  private ensure(rows: number) {
    const need = rows * this.dims;
    if (this.data.length >= need) return;
    const next = new Float32Array(Math.max(need, this.data.length * 2, 256 * this.dims));
    next.set(this.data);
    this.data = next;
  }

  upsert(key: number, file: number, vector: Float32Array) {
    if (!this.dims) this.dims = vector.length;
    if (vector.length !== this.dims) return;
    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += vector[i]! * vector[i]!;
    norm = Math.sqrt(norm) || 1;
    let row = this.rowOf.get(key);
    if (row === undefined) {
      row = this.keys.length;
      this.ensure(row + 1);
      this.keys.push(key);
      this.files.push(file);
      this.rowOf.set(key, row);
    } else this.files[row] = file;
    const base = row * this.dims;
    for (let i = 0; i < this.dims; i++) this.data[base + i] = vector[i]! / norm;
  }

  remove(key: number) {
    const row = this.rowOf.get(key);
    if (row === undefined) return;
    const last = this.keys.length - 1;
    if (row !== last) {
      this.data.copyWithin(row * this.dims, last * this.dims, (last + 1) * this.dims);
      this.keys[row] = this.keys[last]!;
      this.files[row] = this.files[last]!;
      this.rowOf.set(this.keys[row]!, row);
    }
    this.keys.pop();
    this.files.pop();
    this.rowOf.delete(key);
  }

  search(query: Float32Array, k: number, excludeFiles?: Iterable<number>, onlyFiles?: Iterable<number>): VectorHit[] {
    if (!this.dims || query.length !== this.dims || k <= 0) return [];
    let norm = 0;
    for (let i = 0; i < query.length; i++) norm += query[i]! * query[i]!;
    norm = Math.sqrt(norm) || 1;
    const exclude = excludeFiles ? new Set(excludeFiles) : null;
    const only = onlyFiles ? new Set(onlyFiles) : null;
    // A small sorted buffer beats a heap for the k we use (≤ 200).
    const best: VectorHit[] = [];
    let floor = -Infinity;
    const d = this.dims;
    const data = this.data;
    for (let r = 0; r < this.keys.length; r++) {
      const file = this.files[r]!;
      if (exclude?.has(file) || (only && !only.has(file))) continue;
      let dot = 0;
      const base = r * d;
      for (let i = 0; i < d; i++) dot += data[base + i]! * query[i]!;
      const score = dot / norm;
      if (best.length === k && score <= floor) continue;
      let at = best.length;
      while (at > 0 && best[at - 1]!.score < score) at--;
      best.splice(at, 0, { key: this.keys[r]!, file, score });
      if (best.length > k) best.pop();
      floor = best[best.length - 1]!.score;
    }
    return best;
  }

  /** The mean of a file's passages, or null when the file has none. */
  fileCentroid(file: number): Float32Array | null {
    const out = new Float32Array(this.dims);
    let n = 0;
    for (let r = 0; r < this.keys.length; r++) {
      if (this.files[r] !== file) continue;
      const base = r * this.dims;
      for (let i = 0; i < this.dims; i++) out[i] += this.data[base + i]!;
      n++;
    }
    return n ? out : null;
  }

  handle(req: WorkerRequest): WorkerResponse {
    switch (req.op) {
      case "reset":
        this.reset(req.dims);
        return { id: req.id };
      case "upsert":
        req.keys.forEach((key, i) => this.upsert(key, req.files[i]!, req.vectors[i]!));
        return { id: req.id, count: this.size };
      case "remove":
        for (const key of req.keys) this.remove(key);
        return { id: req.id, count: this.size };
      case "search":
        return { id: req.id, hits: this.search(req.vector, req.k, req.excludeFiles, req.onlyFiles) };
      case "similarToFile": {
        const c = this.fileCentroid(req.file);
        return { id: req.id, hits: c ? this.search(c, req.k, [req.file, ...(req.excludeFiles ?? [])]) : [] };
      }
      case "count":
        return { id: req.id, count: this.size };
    }
  }
}
