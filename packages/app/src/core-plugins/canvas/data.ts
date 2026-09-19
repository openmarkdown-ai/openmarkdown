/**
 * JSON Canvas 1.0: types, parsing, and serialisation in the layout Obsidian
 * writes (tab-indented, one node or edge object per line, nodes before
 * edges). Unknown keys on nodes, edges and the top level survive a round trip.
 */

export type Side = "top" | "right" | "bottom" | "left";
export type EdgeEnd = "none" | "arrow";
export type NodeType = "text" | "file" | "link" | "group";

export interface CanvasNodeData {
  id: string;
  type: NodeType | string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  background?: string;
  backgroundStyle?: "cover" | "ratio" | "repeat";
  [key: string]: unknown;
}

export interface CanvasEdgeData {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  fromEnd?: EdgeEnd;
  toEnd?: EdgeEnd;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface CanvasData {
  nodes: CanvasNodeData[];
  edges: CanvasEdgeData[];
  [key: string]: unknown;
}

export const SIDES: Side[] = ["top", "right", "bottom", "left"];

export function emptyCanvas(): CanvasData {
  return { nodes: [], edges: [] };
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function parseCanvas(text: string): CanvasData {
  if (!text.trim()) return emptyCanvas();
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A canvas file must contain a JSON object.");
  const out: CanvasData = { ...raw, nodes: [], edges: [] };
  const seen = new Set<string>();
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (!n || typeof n !== "object") continue;
    const node = { ...(n as Record<string, unknown>) } as CanvasNodeData;
    node.id = typeof node.id === "string" && node.id && !seen.has(node.id) ? node.id : randomId();
    seen.add(node.id);
    node.type = typeof node.type === "string" ? node.type : "text";
    node.x = Math.round(num(node.x, 0));
    node.y = Math.round(num(node.y, 0));
    node.width = Math.max(1, Math.round(num(node.width, 250)));
    node.height = Math.max(1, Math.round(num(node.height, 60)));
    if (node.type === "text" && typeof node.text !== "string") node.text = "";
    out.nodes.push(node);
  }
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!e || typeof e !== "object") continue;
    const edge = { ...(e as Record<string, unknown>) } as CanvasEdgeData;
    if (typeof edge.fromNode !== "string" || typeof edge.toNode !== "string") continue;
    edge.id = typeof edge.id === "string" && edge.id ? edge.id : randomId();
    out.edges.push(edge);
  }
  return out;
}

/** Drop undefined values; key order is the object's own (so files written elsewhere keep theirs). */
function clean(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Obsidian's layout: tabs, and each node/edge on its own line. */
export function serializeCanvas(data: CanvasData): string {
  const lines: string[] = ["{"];
  const extras = Object.entries(data).filter(([k, v]) => k !== "nodes" && k !== "edges" && v !== undefined);
  const nodes = data.nodes.map((n) => "\t\t" + JSON.stringify(clean(n)));
  const edges = data.edges.map((e) => "\t\t" + JSON.stringify(clean(e)));
  const parts: string[] = [];
  parts.push(nodes.length ? `\t"nodes":[\n${nodes.join(",\n")}\n\t]` : `\t"nodes":[]`);
  parts.push(edges.length ? `\t"edges":[\n${edges.join(",\n")}\n\t]` : `\t"edges":[]`);
  for (const [k, v] of extras) parts.push(`\t${JSON.stringify(k)}:${JSON.stringify(v)}`);
  lines.push(parts.join(",\n"));
  lines.push("}");
  return lines.join("\n");
}

/** 16 hex characters, as Obsidian writes. */
export function randomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Anchor point in the middle of a node's side. */
export function sidePoint(r: Rect, side: Side): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: r.x + r.width / 2, y: r.y };
    case "bottom":
      return { x: r.x + r.width / 2, y: r.y + r.height };
    case "left":
      return { x: r.x, y: r.y + r.height / 2 };
    default:
      return { x: r.x + r.width, y: r.y + r.height / 2 };
  }
}

export function sideNormal(side: Side): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    default:
      return { x: 1, y: 0 };
  }
}

/** The side of `r` facing the point (used when an edge names no side). */
export function sideFacing(r: Rect, px: number, py: number): Side {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const dx = (px - cx) / Math.max(1, r.width);
  const dy = (py - cy) / Math.max(1, r.height);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "bottom" : "top";
}

export function nearestSide(r: Rect, px: number, py: number): Side {
  let best: Side = "top";
  let bestD = Infinity;
  for (const s of SIDES) {
    const p = sidePoint(r, s);
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

export interface EdgeGeometry {
  from: { x: number; y: number };
  to: { x: number; y: number };
  fromSide: Side;
  toSide: Side;
  c1: { x: number; y: number };
  c2: { x: number; y: number };
  path: string;
  mid: { x: number; y: number };
}

export function edgeGeometry(fromRect: Rect, toRect: Rect, fromSide?: Side, toSide?: Side, arrowAtEnd = true, arrowAtStart = false): EdgeGeometry {
  const fc = { x: fromRect.x + fromRect.width / 2, y: fromRect.y + fromRect.height / 2 };
  const tc = { x: toRect.x + toRect.width / 2, y: toRect.y + toRect.height / 2 };
  const fs = fromSide ?? sideFacing(fromRect, tc.x, tc.y);
  const ts = toSide ?? sideFacing(toRect, fc.x, fc.y);
  return bezierBetween(sidePoint(fromRect, fs), fs, sidePoint(toRect, ts), ts, arrowAtEnd, arrowAtStart);
}

export const ARROW_LENGTH = 12;

export function bezierBetween(from: { x: number; y: number }, fs: Side, to: { x: number; y: number }, ts: Side | null, arrowAtEnd = true, arrowAtStart = false): EdgeGeometry {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const k = Math.min(Math.max(dist * 0.5, 40), 250);
  const fn = sideNormal(fs);
  // Leave room for the arrowheads so the line ends at their base.
  const start = arrowAtStart ? { x: from.x + fn.x * ARROW_LENGTH, y: from.y + fn.y * ARROW_LENGTH } : from;
  const c1 = { x: from.x + fn.x * k, y: from.y + fn.y * k };
  let end = to;
  let c2: { x: number; y: number };
  if (ts) {
    const tn = sideNormal(ts);
    if (arrowAtEnd) end = { x: to.x + tn.x * ARROW_LENGTH, y: to.y + tn.y * ARROW_LENGTH };
    c2 = { x: to.x + tn.x * k, y: to.y + tn.y * k };
  } else {
    c2 = { x: to.x - (to.x - from.x) * 0.25, y: to.y - (to.y - from.y) * 0.25 };
  }
  const path = `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`;
  const t = 0.5;
  const mt = 1 - t;
  const mid = {
    x: mt * mt * mt * start.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * end.x,
    y: mt * mt * mt * start.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * end.y,
  };
  return { from, to, fromSide: fs, toSide: ts ?? fs, c1, c2, path, mid };
}

/** Arrowhead polygon points with its tip at `tip`, pointing against `side`'s normal. */
export function arrowPoints(tip: { x: number; y: number }, side: Side, size = ARROW_LENGTH): string {
  const n = sideNormal(side);
  const bx = tip.x + n.x * size;
  const by = tip.y + n.y * size;
  const px = -n.y * size * 0.55;
  const py = n.x * size * 0.55;
  return `${tip.x},${tip.y} ${bx + px},${by + py} ${bx - px},${by - py}`;
}

export const PRESET_COLORS = ["1", "2", "3", "4", "5", "6"] as const;
export const PRESET_COLOR_NAMES: Record<string, string> = { "1": "Red", "2": "Orange", "3": "Yellow", "4": "Green", "5": "Cyan", "6": "Purple" };

export function isPresetColor(c: string | undefined): boolean {
  return !!c && /^[1-6]$/.test(c);
}

/** CSS colour for a canvasColor (preset → `--canvas-color-N`). */
export function cssColor(c: string | undefined): string | null {
  if (!c) return null;
  if (isPresetColor(c)) return `var(--canvas-color-${c})`;
  if (/^#[0-9a-f]{3,8}$/i.test(c)) return c;
  return null;
}
