/**
 * Icons: `setIcon`, `getIcon`, `getIconIds`, `addIcon`, `removeIcon`.
 *
 * Obsidian ships the whole Lucide set and plugins name icons three ways:
 * `"lucide-file-text"`, `"file-text"`, and the pre-1.0 Obsidian ids
 * (`"document"`, `"cross"`, `"gear"`, `"right-triangle"` …). All three must
 * resolve, synchronously, because `setIcon` returns nothing and plugins read
 * `el.firstChild` straight after calling it.
 *
 * The Lucide map is imported eagerly (a namespace import of `lucide-static`,
 * which Vite bundles into one chunk). Each export is an SVG string; its
 * `class="lucide lucide-<canonical>"` attribute names the canonical icon, and
 * the export names cover Lucide's renamed aliases (`AlertTriangle` →
 * `triangle-alert`). Lookup is by a hyphen-free, lower-cased key so
 * `"arrow-down-0-1"` and `"ArrowDown01"` meet at the same entry.
 *
 * Each id is parsed once into a template `<svg>` and cloned on every call.
 */
import * as lucide from "lucide-static";

const SVG_NS = "http://www.w3.org/2000/svg";

interface LucideEntry {
  canonical: string;
  inner: string;
}

let lucideByKey: Map<string, LucideEntry> | null = null;
let canonicalNames: string[] = [];

function normKey(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, "");
}

function lucideMap(): Map<string, LucideEntry> {
  if (lucideByKey) return lucideByKey;
  const map = new Map<string, LucideEntry>();
  const byCanonical = new Map<string, LucideEntry>();
  for (const [exportName, value] of Object.entries(lucide as unknown as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const cls = /class="lucide lucide-([a-z0-9-]+)"/.exec(value);
    const open = value.indexOf(">", value.indexOf("<svg"));
    const close = value.lastIndexOf("</svg>");
    if (!cls || open < 0 || close < 0) continue;
    const canonical = cls[1]!;
    let entry = byCanonical.get(canonical);
    if (!entry) {
      // Drop the pretty-printing whitespace: text nodes inside an icon show up
      // in `el.textContent`, which plugins read.
      entry = { canonical, inner: value.slice(open + 1, close).replace(/>\s+</g, "><").trim() };
      byCanonical.set(canonical, entry);
      map.set(normKey(canonical), entry);
    }
    const aliasKey = normKey(exportName);
    if (!map.has(aliasKey)) map.set(aliasKey, entry);
  }
  canonicalNames = Array.from(byCanonical.keys()).sort();
  lucideByKey = map;
  return map;
}

/**
 * Obsidian's pre-Lucide icon ids, still accepted by `setIcon`. The generated
 * `<svg>` keeps the legacy id as its class (`svg-icon right-triangle`), which
 * themes target, while the drawing comes from the Lucide equivalent.
 */
export const LEGACY_ICON_IDS: Record<string, string> = {
  "any-key": "keyboard",
  "audio-file": "file-audio",
  "bold-glyph": "bold",
  "bracket-glyph": "brackets",
  "broken-link": "unlink",
  "bullet-list": "list",
  "bullet-list-glyph": "list",
  "calendar-with-checkmark": "calendar-check",
  "check-in-circle": "check-circle",
  "check-small": "check",
  "checkbox-glyph": "check-square",
  checkmark: "check",
  "code-glyph": "code",
  "command-glyph": "command",
  "copy-glyph": "copy",
  "create-new": "square-pen",
  cross: "x",
  "cross-in-box": "x-square",
  "crossed-star": "star-off",
  csv: "file-spreadsheet",
  deleteColumn: "between-vertical-start",
  deleteRow: "between-horizontal-start",
  dice: "dices",
  document: "file",
  documents: "files",
  "dot-network": "git-fork",
  "double-down-arrow-glyph": "chevrons-down",
  "double-up-arrow-glyph": "chevrons-up",
  "down-arrow-with-tail": "arrow-down",
  "down-chevron-glyph": "chevron-down",
  "duplicate-glyph": "copy",
  enter: "corner-down-left",
  "exit-fullscreen": "minimize",
  "expand-vertically": "chevrons-up-down",
  "file-explorer-glyph": "folder-closed",
  "filled-pin": "pin",
  formula: "sigma",
  "forward-arrow": "arrow-right",
  fullscreen: "maximize",
  gear: "settings",
  "go-to-file": "file-symlink",
  "graph-glyph": "git-fork",
  hashtag: "hash",
  "heading-glyph": "heading",
  help: "circle-help",
  "highlight-glyph": "highlighter",
  "horizontal-split": "separator-horizontal",
  "image-file": "file-image",
  "image-glyph": "image",
  "indent-glyph": "indent",
  insertColumn: "table-columns-split",
  insertRow: "table-rows-split",
  install: "download",
  "italic-glyph": "italic",
  "keyboard-glyph": "keyboard",
  "left-arrow": "arrow-left",
  "left-arrow-with-tail": "arrow-left",
  "left-chevron-glyph": "chevron-left",
  "lines-of-text": "align-left",
  "link-glyph": "link",
  "logo-crystal": "gem",
  "magnifying-glass": "search",
  microphone: "mic",
  "microphone-filled": "mic",
  "minus-with-circle": "minus-circle",
  moveColumnLeft: "arrow-left",
  moveColumnRight: "arrow-right",
  moveRowDown: "arrow-down",
  moveRowUp: "arrow-up",
  "note-glyph": "file-text",
  "number-list-glyph": "list-ordered",
  "open-elsewhere-glyph": "external-link",
  "open-vault": "folder-open",
  "pane-layout": "layout",
  "paper-plane": "send",
  paused: "pause",
  "pdf-file": "file-text",
  "percent-sign-glyph": "percent",
  "plus-with-circle": "plus-circle",
  "popup-open": "external-link",
  "price-tag-glyph": "tag",
  "quote-glyph": "quote",
  "reading-glasses": "glasses",
  "redo-glyph": "redo",
  reset: "rotate-ccw",
  "restore-file-glyph": "history",
  "right-arrow": "arrow-right",
  "right-arrow-with-tail": "arrow-right",
  "right-chevron-glyph": "chevron-right",
  "run-command": "terminal-square",
  "search-glyph": "search",
  "select-all-text": "text-select",
  "sheets-in-box": "archive",
  sortAsc: "sort-asc",
  sortDesc: "sort-desc",
  spreadsheet: "sheet",
  "stacked-levels": "layers",
  "star-list": "star",
  "strikethrough-glyph": "strikethrough",
  switch: "arrow-left-right",
  sync: "refresh-cw",
  "sync-small": "refresh-cw",
  "tag-glyph": "tag",
  "three-horizontal-bars": "menu",
  "undo-glyph": "undo",
  "unindent-glyph": "outdent",
  "up-and-down-arrows": "arrow-up-down",
  "up-arrow-with-tail": "arrow-up",
  "up-chevron-glyph": "chevron-up",
  "uppercase-lowercase-a": "case-sensitive",
  "vertical-split": "separator-vertical",
  "vertical-three-dots": "more-vertical",
  "wrench-screwdriver-glyph": "wrench",
};

/** Legacy ids whose drawing is Obsidian's own rather than a Lucide icon. */
const LEGACY_OWN_DRAWINGS: Record<string, string> = {
  // The tree/fold collapse indicator. Obsidian rotates it with CSS, so it must
  // be a downward chevron in a 24-unit box with this exact class.
  "right-triangle": '<path d="M3 8L12 17L21 8"></path>',
};

/** Icons added with `addIcon`: id → raw inner SVG content (100×100 box). */
const customIcons = new Map<string, string>();
const templates = new Map<string, SVGSVGElement>();

function buildLucideSvg(doc: Document, cls: string, inner: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", `svg-icon ${cls}`);
  svg.innerHTML = inner;
  return svg;
}

function buildCustomSvg(doc: Document, id: string, content: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", `svg-icon ${id}`);
  svg.innerHTML = content;
  return svg;
}

function stripLucidePrefix(id: string): string {
  return id.startsWith("lucide-") ? id.slice("lucide-".length) : id;
}

function resolveTemplate(iconId: string): SVGSVGElement | null {
  const cached = templates.get(iconId);
  if (cached) return cached;
  const doc = document;
  let svg: SVGSVGElement | null = null;

  const custom = customIcons.get(iconId);
  if (custom !== undefined) {
    svg = buildCustomSvg(doc, iconId, custom);
  } else {
    const map = lucideMap();
    const bare = stripLucidePrefix(iconId);
    const own = LEGACY_OWN_DRAWINGS[iconId];
    if (own !== undefined) {
      svg = buildLucideSvg(doc, iconId, own);
    } else if (Object.prototype.hasOwnProperty.call(LEGACY_ICON_IDS, iconId)) {
      // Legacy ids win over a same-named Lucide icon: `"cross"` is Obsidian's
      // close glyph (an X), not Lucide's religious cross.
      const target = map.get(normKey(LEGACY_ICON_IDS[iconId]!));
      if (target) svg = buildLucideSvg(doc, iconId, target.inner);
    } else {
      const entry = map.get(normKey(bare));
      if (entry) svg = buildLucideSvg(doc, `lucide-${bare}`, entry.inner);
    }
  }
  if (svg) templates.set(iconId, svg);
  return svg;
}

/**
 * Create an SVG from an iconId. Returns null if no icon is associated with the
 * id. Every call returns a fresh element.
 */
export function getIcon(iconId: string): SVGSVGElement | null {
  if (typeof iconId !== "string" || iconId === "") return null;
  const template = resolveTemplate(iconId);
  if (!template) return null;
  const doc = (globalThis as { activeDocument?: Document }).activeDocument ?? document;
  return (doc === template.ownerDocument ? template.cloneNode(true) : doc.importNode(template, true)) as SVGSVGElement;
}

/** Whether `getIcon(iconId)` would return an icon. Internal helper. */
export function hasIcon(iconId: string): boolean {
  return typeof iconId === "string" && iconId !== "" && resolveTemplate(iconId) !== null;
}

/** Get the list of registered icon ids (`lucide-*`, legacy ids and added icons). */
export function getIconIds(): string[] {
  lucideMap();
  const ids = new Set<string>();
  for (const name of canonicalNames) ids.add(`lucide-${name}`);
  for (const id of Object.keys(LEGACY_ICON_IDS)) ids.add(id);
  for (const id of Object.keys(LEGACY_OWN_DRAWINGS)) ids.add(id);
  for (const id of customIcons.keys()) ids.add(id);
  return Array.from(ids);
}

/**
 * Adds an icon to the library. `svgContent` is the *inside* of an SVG whose
 * viewBox is `0 0 100 100`, as in Obsidian.
 */
export function addIcon(iconId: string, svgContent: string): void {
  customIcons.set(iconId, svgContent);
  templates.delete(iconId);
}

/** Remove a custom icon from the library. */
export function removeIcon(iconId: string): void {
  customIcons.delete(iconId);
  templates.delete(iconId);
}

/**
 * Insert an SVG icon into the element, replacing its current children. An
 * unknown id empties the element (as Obsidian does), so a stale icon never
 * lingers after `setIcon(el, "")`.
 */
export function setIcon(parent: HTMLElement, iconId: string): void {
  const existing = parent.firstElementChild;
  if (
    existing &&
    parent.childNodes.length === 1 &&
    existing instanceof SVGSVGElement &&
    (existing as SVGSVGElement & { __iconId?: string }).__iconId === iconId
  ) {
    return;
  }
  const svg = getIcon(iconId);
  while (parent.lastChild) parent.removeChild(parent.lastChild);
  if (svg) {
    (svg as SVGSVGElement & { __iconId?: string }).__iconId = iconId;
    parent.appendChild(svg);
  }
}
