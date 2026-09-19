/**
 * Drives the engine's Barnes–Hut force layout from requestAnimationFrame.
 *
 * The wasm layout is stepped within a per-frame time budget until it cools
 * (`step` returns false), and is warm-restarted with `setGraph` when the graph
 * changes, so every surviving node keeps its position by id.
 */
import { getEngine, type ForceLayoutHandle } from "@vault/engine";

export interface ForceSettings {
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
}

export class GraphSimulation {
  handle: ForceLayoutHandle | null = null;
  ids: string[] = [];
  running = false;
  stepsPerFrame = 1;
  lastStepMs = 0;
  private empty: Float32Array = new Float32Array(0);
  private pinned = new Set<number>();
  private forces: ForceSettings;

  constructor(forces: ForceSettings) {
    this.forces = pickForces(forces);
  }

  get nodeCount() {
    return this.ids.length;
  }

  /** `[x0, y0, …]`, a view into wasm memory: read it before calling into the layout again. */
  positions(): Float32Array {
    return this.handle ? this.handle.positions() : this.empty;
  }

  /** Replace the graph. `cold` discards previous positions (timelapse start). */
  setGraph(ids: string[], links: Uint32Array, cold = false) {
    this.ids = ids;
    this.pinned.clear();
    if (cold || !this.handle) {
      this.handle?.free();
      this.handle = getEngine().createForceLayout(ids, links, { ...this.forces });
    } else {
      this.handle.setGraph(ids, links);
    }
    this.start();
  }

  setForces(forces: ForceSettings) {
    this.forces = pickForces(forces);
    if (!this.handle) return;
    this.handle.setParams({ ...this.forces });
    this.handle.reheat(0.3);
    this.start();
  }

  start() {
    this.running = !!this.handle && this.ids.length > 0;
  }

  pin(i: number, x: number, y: number) {
    if (!this.handle) return;
    this.handle.pin(i, x, y);
    this.pinned.add(i);
    this.handle.reheat(0.3);
    this.start();
  }

  unpin(i: number) {
    if (!this.handle) return;
    this.handle.unpin(i);
    this.pinned.delete(i);
    this.start();
  }

  /** Step within about `budgetMs`; returns whether the layout is still moving. */
  tick(budgetMs = 8): boolean {
    const h = this.handle;
    if (!h || !this.running) return false;
    if (this.pinned.size) h.reheat(0.3);
    const t0 = performance.now();
    const still = h.step(this.stepsPerFrame);
    const dt = performance.now() - t0;
    this.lastStepMs = dt;
    const perStep = dt / this.stepsPerFrame;
    if (perStep > 0) this.stepsPerFrame = Math.max(1, Math.min(10, Math.floor(budgetMs / perStep)));
    this.running = still || this.pinned.size > 0;
    return this.running;
  }

  free() {
    this.handle?.free();
    this.handle = null;
    this.ids = [];
    this.running = false;
  }
}

function pickForces(f: ForceSettings): ForceSettings {
  return { centerStrength: f.centerStrength, repelStrength: f.repelStrength, linkStrength: f.linkStrength, linkDistance: f.linkDistance };
}
