/**
 * The handful of icons the editor draws itself. The app's `setIcon` (via
 * `EditorHost.setIcon`) is preferred so icon packs and themes apply; these
 * inline SVGs are the standalone fallback.
 */
import type { EditorHost } from "../host";

const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const PATHS: Record<string, string> = {
  "right-triangle": '<path d="M3 8L12 17L21 8"></path>',
  "code-2": '<path d="m18 16 4-4-4-4"></path><path d="m6 8-4 4 4 4"></path><path d="m14.5 4-5 16"></path>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>',
  check: '<path d="M20 6 9 17l-5-5"></path>',
  "external-link": '<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>',
};

export function drawIcon(host: EditorHost | null, el: HTMLElement, name: string): void {
  if (host?.setIcon) {
    host.setIcon(el, name === "right-triangle" ? "right-triangle" : `lucide-${name}`);
    return;
  }
  const cls = name === "right-triangle" ? "svg-icon right-triangle" : `svg-icon lucide-${name}`;
  el.innerHTML = `<svg ${SVG_ATTRS} class="${cls}">${PATHS[name] ?? ""}</svg>`;
}
