/**
 * Graph settings, with the keys and defaults Obsidian writes to
 * `.obsidian/graph.json` (and to a local graph's view state).
 */

export interface GraphColor {
  a: number;
  /** 0xRRGGBB as an integer. */
  rgb: number;
}

export interface ColorGroup {
  query: string;
  color: GraphColor;
}

export interface GraphOptions {
  "collapse-filter": boolean;
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  hideUnresolved: boolean;
  showOrphans: boolean;
  "collapse-color-groups": boolean;
  colorGroups: ColorGroup[];
  "collapse-display": boolean;
  showArrow: boolean;
  textFadeMultiplier: number;
  nodeSizeMultiplier: number;
  lineSizeMultiplier: number;
  "collapse-forces": boolean;
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
  scale: number;
  close: boolean;
}

export interface LocalGraphOptions extends GraphOptions {
  localJumps: number;
  localBacklinks: boolean;
  localForelinks: boolean;
  localInterlinks: boolean;
}

export const DEFAULT_GRAPH_OPTIONS: GraphOptions = {
  "collapse-filter": true,
  search: "",
  showTags: false,
  showAttachments: false,
  hideUnresolved: false,
  showOrphans: true,
  "collapse-color-groups": true,
  colorGroups: [],
  "collapse-display": true,
  showArrow: false,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 1,
  "collapse-forces": true,
  centerStrength: 0.518713248970312,
  repelStrength: 10,
  linkStrength: 1,
  linkDistance: 250,
  scale: 1,
  close: true,
};

export const DEFAULT_LOCAL_GRAPH_OPTIONS: LocalGraphOptions = {
  ...DEFAULT_GRAPH_OPTIONS,
  localJumps: 1,
  localBacklinks: true,
  localForelinks: true,
  localInterlinks: false,
};

/** Fill missing or mistyped keys from the defaults, keeping unknown keys. */
export function normalizeOptions<T extends GraphOptions>(raw: unknown, defaults: T): T {
  const out = { ...defaults } as Record<string, unknown>;
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const d = (defaults as Record<string, unknown>)[k];
      if (d === undefined || typeof d === typeof v || (Array.isArray(d) && Array.isArray(v))) out[k] = v;
    }
  }
  out.colorGroups = (Array.isArray(out.colorGroups) ? out.colorGroups : [])
    .filter((g): g is ColorGroup => !!g && typeof g === "object")
    .map((g) => ({ query: String(g.query ?? ""), color: { a: Number(g.color?.a ?? 1), rgb: Number(g.color?.rgb ?? 0) } }));
  return out as T;
}

export function rgbIntToHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;
}

export function hexToRgbInt(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? parseInt(m[1]!, 16) : 0;
}

/** Random pleasant colour for a new group, as the "New group" button picks one. */
export function randomGroupColor(): GraphColor {
  const h = Math.random();
  const s = 0.6;
  const l = 0.55;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return { a: 1, rgb: (f(0) << 16) | (f(8) << 8) | f(4) };
}
