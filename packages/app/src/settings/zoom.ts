/**
 * Interface zoom and quick font size adjustment.
 *
 * A web page cannot set the browser's zoom, so `window:zoom-in/out/reset-zoom`
 * and Appearance → Zoom level scale the app with CSS `zoom` on <body>. The
 * level is per device (local storage), as Obsidian's Electron zoom is.
 */
import type { App } from "../obsidian/app";

export const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
const DEFAULT_INDEX = ZOOM_STEPS.indexOf(100);
const KEY = "zoom-level";

export function getZoomIndex(app: App): number {
  const raw = app.loadLocalStorage(KEY);
  if (raw === null || raw === undefined || raw === "") return DEFAULT_INDEX;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 && v < ZOOM_STEPS.length ? v : DEFAULT_INDEX;
}

export function setZoomIndex(app: App, index: number): void {
  const i = Math.max(0, Math.min(ZOOM_STEPS.length - 1, Math.round(index)));
  app.saveLocalStorage(KEY, i === DEFAULT_INDEX ? null : i);
  applyZoom(app);
}

export function applyZoom(app: App): void {
  const pct = ZOOM_STEPS[getZoomIndex(app)] ?? 100;
  document.body.style.zoom = pct === 100 ? "" : String(pct / 100);
  app.workspace?.trigger("resize");
}

export function zoomBy(app: App, delta: number): void {
  setZoomIndex(app, getZoomIndex(app) + delta);
}

/** Mod + wheel (and trackpad pinch, which browsers report as Ctrl + wheel) changes the font size. */
export function installQuickFontSize(app: App): () => void {
  let pending = 0;
  const onWheel = (evt: WheelEvent) => {
    if (!app.vault.getConfig("baseFontSizeAction")) return;
    if (!(evt.ctrlKey || evt.metaKey)) return;
    evt.preventDefault();
    pending += evt.deltaY;
    if (Math.abs(pending) < 40) return;
    const step = pending < 0 ? 1 : -1;
    pending = 0;
    const size = Number(app.vault.getConfig("baseFontSize") ?? 16);
    const next = Math.max(10, Math.min(30, size + step));
    if (next !== size) app.vault.setConfig("baseFontSize", next);
  };
  window.addEventListener("wheel", onWheel, { passive: false });
  return () => window.removeEventListener("wheel", onWheel);
}
