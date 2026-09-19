/**
 * Graph colours. The graph is drawn on a canvas, so themes cannot style it
 * directly; they set `--graph-*` variables or style the hidden
 * `.graph-view.color-*` probe elements (`color` and `opacity`), and the view
 * reads the computed values back. Refreshed on `css-change`.
 */

export type RGBA = [number, number, number, number];

export interface GraphColors {
  fill: RGBA;
  fillFocused: RGBA;
  fillTag: RGBA;
  fillAttachment: RGBA;
  fillUnresolved: RGBA;
  fillHighlight: RGBA;
  line: RGBA;
  lineHighlight: RGBA;
  arrow: RGBA;
  text: RGBA;
  circle: RGBA;
  background: RGBA;
  font: string;
}

const PROBES: [keyof GraphColors, string][] = [
  ["fill", "color-fill"],
  ["fillFocused", "color-fill-focused"],
  ["fillTag", "color-fill-tag"],
  ["fillAttachment", "color-fill-attachment"],
  ["fillUnresolved", "color-fill-unresolved"],
  ["fillHighlight", "color-fill-highlight"],
  ["line", "color-line"],
  ["lineHighlight", "color-line-highlight"],
  ["arrow", "color-arrow"],
  ["text", "color-text"],
  ["circle", "color-circle"],
];

let scratch: CanvasRenderingContext2D | null = null;

/** Any CSS colour string (rgb(), color(srgb …), oklch() …) → 0–1 RGBA. */
export function parseCssColor(value: string, fallback: RGBA = [0.5, 0.5, 0.5, 1]): RGBA {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(value.trim());
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, a];
  }
  if (!scratch) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    scratch = c.getContext("2d", { willReadFrequently: true });
  }
  if (!scratch) return fallback;
  scratch.clearRect(0, 0, 1, 1);
  scratch.fillStyle = "#000";
  scratch.fillStyle = value;
  scratch.fillRect(0, 0, 1, 1);
  const d = scratch.getImageData(0, 0, 1, 1).data;
  if (d[3] === 0) return [0, 0, 0, 0];
  return [d[0]! / 255, d[1]! / 255, d[2]! / 255, d[3]! / 255];
}

export function readGraphColors(hostEl: HTMLElement): GraphColors {
  const holder = hostEl.createDiv({ cls: "vault-graph-probes" });
  const out: Partial<GraphColors> = {};
  for (const [key, cls] of PROBES) {
    const el = holder.createDiv({ cls: `graph-view ${cls}` });
    const style = getComputedStyle(el);
    const rgba = parseCssColor(style.color);
    const opacity = parseFloat(style.opacity);
    rgba[3] *= Number.isFinite(opacity) ? opacity : 1;
    (out as Record<string, RGBA>)[key] = rgba;
  }
  const hostStyle = getComputedStyle(hostEl);
  out.background = parseCssColor(hostStyle.backgroundColor, [1, 1, 1, 1]);
  out.font = hostStyle.fontFamily || "sans-serif";
  holder.remove();
  return out as GraphColors;
}

export function rgbaToCss(c: RGBA, alphaMul = 1): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${(c[3] * alphaMul).toFixed(3)})`;
}
