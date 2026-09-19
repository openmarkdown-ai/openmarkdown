/**
 * Advanced Slides syntax (the community plugin's own, so its decks open
 * unchanged): parsing only, no DOM.
 *
 *   ---                 horizontal separator   (frontmatter `separator`)
 *   --                  vertical separator     (frontmatter `verticalSeparator`)
 *   note:               the rest of the slide is speaker notes (`notesSeparator`)
 *   <!-- slide bg="…" data-… class="…" -->       attributes of the slide
 *   <!-- element class="fragment" style="…" -->  attributes of the element before it
 *   + item              a list item shown as a fragment
 *
 * Frontmatter keys map onto reveal.js options (theme, transition, width …).
 */

export interface SlideSpec {
  /** Markdown of the slide, annotations replaced by render markers. */
  markdown: string;
  notes: string;
  attrs: Record<string, string>;
  /** Line offsets (0-based, into the markdown) of `+` list items. */
  fragmentLines: number[];
  /** For every list item in source order: whether it used the `+` marker (a fragment). */
  listFragments: boolean[];
}

export interface DeckSpec {
  /** Horizontal stacks; a stack with more than one slide is vertical. */
  stacks: SlideSpec[][];
  options: Record<string, unknown>;
}

/** Frontmatter keys that mark a note as an Advanced Slides deck. */
export const DECK_KEYS = [
  "theme", "highlightTheme", "css", "separator", "verticalSeparator", "notesSeparator",
  "transition", "transitionSpeed", "backgroundTransition", "controls", "controlsLayout",
  "progress", "slideNumber", "overview", "center", "loop", "rtl", "shuffle", "fragments",
  "showNotes", "width", "height", "margin", "minScale", "maxScale", "autoSlide",
  "enableLinks", "enableChalkboard", "enableOverview", "enableMenu", "enableTimeBar", "defaultTemplate",
];

/** Reveal.js options taken from frontmatter as-is. */
const REVEAL_KEYS = [
  "transition", "transitionSpeed", "backgroundTransition", "controls", "controlsLayout", "progress",
  "slideNumber", "overview", "center", "loop", "rtl", "shuffle", "fragments", "showNotes",
  "width", "height", "margin", "minScale", "maxScale", "autoSlide", "hash", "navigationMode",
];

export function isAdvancedDeck(frontmatter: Record<string, unknown> | null | undefined, body: string): boolean {
  if (frontmatter && DECK_KEYS.some((k) => k in frontmatter)) return true;
  const outside = stripFences(body);
  return /<!--\s*(slide|element)\b/.test(outside) || /^\s*note:/im.test(outside) || /^\s*--\s*$/m.test(outside);
}

function stripFences(text: string): string {
  return text.replace(/^(\s*)(`{3,}|~{3,})[\s\S]*?^\1\2\s*$/gm, "");
}

function toRegex(value: unknown, fallback: RegExp): RegExp {
  if (typeof value !== "string" || !value) return fallback;
  try {
    // Advanced Slides stores separators as regex sources, sometimes with \r?\n around them.
    const src = value.replace(/^\\r\?\\n|\\r\?\\n$/g, "").replace(/^\^?/, "^").replace(/\$?$/, "$");
    return new RegExp(src, "m");
  } catch {
    return fallback;
  }
}

/** Attributes in an HTML-comment annotation: key="value", key='value', key=value, bare. */
export function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1]!] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
export const fromB64 = (s: string) => decodeURIComponent(escape(atob(s)));

export function parseDeck(body: string, frontmatter: Record<string, unknown> | null = null): DeckSpec {
  const fm = frontmatter ?? {};
  const hSep = toRegex(fm.separator, /^\s*---\s*$/);
  const vSep = toRegex(fm.verticalSeparator, /^\s*--\s*$/);
  const notesSep = typeof fm.notesSeparator === "string" && fm.notesSeparator ? fm.notesSeparator : "note:";
  const lines = body.replace(/\r\n?/g, "\n").split("\n");

  const stacks: string[][][] = [[[]]];
  let fence: string | null = null;
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      const marker = f[1]!;
      if (fence === null) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
    }
    if (fence === null && hSep.test(line)) {
      stacks.push([[]]);
      continue;
    }
    if (fence === null && vSep.test(line)) {
      stacks[stacks.length - 1]!.push([]);
      continue;
    }
    const stack = stacks[stacks.length - 1]!;
    stack[stack.length - 1]!.push(line);
  }

  const specs = stacks
    .map((stack) => stack.map((slideLines) => slide(slideLines, notesSep)).filter((s) => s.markdown.trim() || s.notes.trim() || Object.keys(s.attrs).length))
    .filter((stack) => stack.length > 0);

  const options: Record<string, unknown> = {};
  for (const k of REVEAL_KEYS) if (k in fm) options[k] = fm[k];
  return { stacks: specs.length ? specs : [[{ markdown: "", notes: "", attrs: {}, fragmentLines: [], listFragments: [] }]], options };
}

function slide(lines: string[], notesSep: string): SlideSpec {
  let notes = "";
  const noteRe = new RegExp(`^\\s*${notesSep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  const content: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      const marker = f[1]!;
      if (fence === null) fence = marker[0]!.repeat(marker.length);
      else if (marker.startsWith(fence)) fence = null;
    }
    if (fence === null && noteRe.test(line)) {
      notes = [line.replace(noteRe, "").trim(), ...lines.slice(i + 1)].join("\n").trim();
      break;
    }
    content.push(line);
  }
  let attrs: Record<string, string> = {};
  let md = content.join("\n");
  md = md.replace(/<!--\s*slide\b([\s\S]*?)-->/g, (whole, a: string) => {
    attrs = { ...attrs, ...parseAttrs(a) };
    return "\n".repeat((whole.match(/\n/g) ?? []).length);
  });
  md = md.replace(/<!--\s*element\b([\s\S]*?)-->/g, (_whole, a: string) => `<span class="vault-slide-element" data-attrs="${b64(JSON.stringify(parseAttrs(a)))}"></span>`);
  // Trim leading blank lines but keep a record of line offsets for `+` items.
  const mdLines = md.split("\n");
  while (mdLines.length && !mdLines[0]!.trim()) mdLines.shift();
  while (mdLines.length && !mdLines[mdLines.length - 1]!.trim()) mdLines.pop();
  const fragmentLines: number[] = [];
  const listFragments: boolean[] = [];
  let inFence: string | null = null;
  mdLines.forEach((l, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (f) inFence = inFence === null ? f[1]! : null;
    if (inFence !== null) return;
    const item = /^\s*(?:>\s*)*([-*+]|\d+[.)])\s+/.exec(l);
    if (!item) return;
    listFragments.push(item[1] === "+");
    if (item[1] === "+") fragmentLines.push(i);
  });
  return { markdown: mdLines.join("\n"), notes, attrs, fragmentLines, listFragments };
}

export function totalSlides(deck: DeckSpec): number {
  return deck.stacks.reduce((n, s) => n + s.length, 0);
}
