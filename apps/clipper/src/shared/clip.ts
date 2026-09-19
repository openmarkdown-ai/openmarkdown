/**
 * Page → note, on an extension page that has a DOM (popup, side panel,
 * offscreen document, Firefox background page). The Rust engine does
 * extraction, Markdown and templates; this file supplies what a page adds on
 * top — selection, highlights — and Web Clipper's content precedence:
 * selection, then highlights, then the page's main content.
 */
import { getEngine, initEngine, type Engine } from "@vault/engine";
import type { PageCapture } from "./capture";
export type { PageCapture } from "./capture";
import type { ClipBehavior, ClipInterpreterRequest } from "../../../../packages/app/src/companion/protocol";
import { DEFAULT_PROMPT_CONTEXT, type HighlightBehavior, type PropertyType, type Settings, type StoredHighlight, type Template } from "./settings";
import { generateFrontmatter, isDaily, joinPath, sanitizeFileName, toClipperJson } from "./templates";

let enginePromise: Promise<Engine> | null = null;

export function ensureEngine(): Promise<Engine> {
  enginePromise ??= initEngine(chrome.runtime.getURL("wasm/vault_wasm_bg.wasm"));
  return enginePromise;
}

/** Wraps each highlighted passage of `html` in `<mark>` (Web Clipper's `highlight-inline`). */
export function markHighlights(html: string, highlights: StoredHighlight[]): string {
  if (!highlights.length) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  for (const h of highlights) {
    const needle = h.text.replace(/\s+/g, " ").trim();
    if (!needle) continue;
    const nodes: Text[] = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    // Normalised text with a map back to (node, offset).
    let flat = "";
    const map: { node: Text; offset: number }[] = [];
    for (const node of nodes) {
      const t = node.data;
      for (let i = 0; i < t.length; i++) {
        const ch = /\s/.test(t[i]!) ? " " : t[i]!;
        if (ch === " " && flat.endsWith(" ")) continue;
        flat += ch;
        map.push({ node, offset: i });
      }
    }
    const at = flat.indexOf(needle);
    if (at < 0) continue;
    const start = map[at]!;
    const end = map[at + needle.length - 1]!;
    // Wrap per text node so the marks never cross element boundaries.
    let inside = false;
    for (const node of nodes) {
      if (node === start.node) inside = true;
      if (!inside) continue;
      const from = node === start.node ? start.offset : 0;
      const to = node === end.node ? end.offset + 1 : node.data.length;
      if (to > from && node.data.slice(from, to).trim()) {
        const range = doc.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        const mark = doc.createElement("mark");
        range.surroundContents(mark);
      }
      if (node === end.node) break;
    }
  }
  return doc.body.innerHTML;
}

export interface EditableProperty {
  name: string;
  value: string;
  type: PropertyType;
}

export interface ClipDraft {
  templateId: string;
  behavior: ClipBehavior;
  noteName: string;
  folder: string;
  properties: EditableProperty[];
  /** Body Markdown (no frontmatter). */
  body: string;
  extracted: Record<string, unknown>;
  errors: { message: string }[];
  /** Set when the template has prompt variables and the Interpreter is on: the app fills them on delivery. */
  interpreter?: { context: string; prompts: number; url: string; nowMs: number; tzOffsetMinutes: number };
}

/** Prompt variables as the engine leaves them in its output: `{{"…"|filters}}`, `{{prompt:"…"}}`. */
const PROMPT_TOKEN = /\{\{(?:prompt:)?"((?:[^"\\]|\\[\s\S])*)"(\|[\s\S]*?)?\}\}/g;
const MODEL_TOKEN = /\{\{(?:modelProvider|modelId|model)(?:\|[\s\S]*?)?\}\}/g;
/** Largest prompt context sent to the app; the app trims further for small on-device models. */
const MAX_CONTEXT_CHARS = 500_000;

export function countPrompts(texts: string[]): number {
  const seen = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(PROMPT_TOKEN)) seen.add(m[1]!);
  return seen.size;
}

/** Interpreter off: Web Clipper renders prompt and model variables as nothing. */
export function stripPromptVariables(text: string): string {
  return text.replace(PROMPT_TOKEN, "").replace(MODEL_TOKEN, "");
}

export interface BuildOptions {
  settings: Pick<Settings, "dateFormat" | "datetimeFormat" | "propertyTypes" | "highlightBehavior"> & Partial<Pick<Settings, "interpreterEnabled" | "defaultPromptContext">>;
  highlights: StoredHighlight[];
  /** Ignore the page selection (e.g. "Clip this page" from the context menu). */
  ignoreSelection?: boolean;
  nowMs?: number;
}

function highlightsVariable(highlights: StoredHighlight[]) {
  return highlights.map((h) => ({ text: h.text, html: h.html, timestamp: new Date(h.createdAt).toISOString() }));
}

export async function buildClip(page: PageCapture, template: Template, opts: BuildOptions): Promise<ClipDraft> {
  const engine = await ensureEngine();
  const nowMs = opts.nowMs ?? Date.now();
  const tzOffsetMinutes = -new Date(nowMs).getTimezoneOffset();
  const extracted = engine.extract(page.html, page.url);
  const variables: Record<string, unknown> = {
    highlights: highlightsVariable(opts.highlights),
    selection: "",
    selectionHtml: "",
  };
  const selectionHtml = opts.ignoreSelection ? "" : page.selectionHtml.trim();
  if (selectionHtml) {
    const md = engine.htmlToMarkdown(selectionHtml, page.url).trim();
    variables.selection = md;
    variables.selectionHtml = selectionHtml;
    variables.content = md;
    variables.contentHtml = selectionHtml;
  } else if (opts.highlights.length && opts.settings.highlightBehavior !== "no-highlights") {
    const contentHtml = String(extracted.contentHtml ?? "");
    if (opts.settings.highlightBehavior === "replace-content") {
      const html = opts.highlights.map((h) => h.html || h.text).join("\n");
      variables.content = opts.highlights.map((h) => engine.htmlToMarkdown(h.html || h.text, page.url).trim()).join("\n\n");
      variables.contentHtml = html;
    } else {
      const marked = markHighlights(contentHtml, opts.highlights);
      variables.content = engine.htmlToMarkdown(marked, page.url).trim();
      variables.contentHtml = marked;
    }
  }

  const result = engine.clipPage(JSON.stringify(toClipperJson(template)), { html: page.html, url: page.url, nowMs, tzOffsetMinutes, variables });
  if (result.error) throw new Error(String(result.error));

  const folder = isDaily(template.behavior)
    ? ""
    : engine.renderTemplate(template.path, { html: page.html, url: page.url, nowMs, tzOffsetMinutes, variables }).output.trim();

  const properties: EditableProperty[] = (result.properties as { name: string; value: string; type?: PropertyType }[]).map((p, i) => {
    const type = (template.properties[i]?.type ?? p.type ?? "text") as PropertyType;
    let value = p.value;
    const tplValue = template.properties[i]?.value ?? "";
    const fmt = type === "date" ? opts.settings.dateFormat : type === "datetime" ? opts.settings.datetimeFormat : "";
    const engineDefault = type === "date" ? "YYYY-MM-DD" : "YYYY-MM-DDTHH:mm:ssZ";
    if (fmt && fmt !== engineDefault && value.trim() && !tplValue.includes("|date:")) {
      const r = engine.renderTemplate(`{{v|date:${JSON.stringify(fmt)}}}`, { url: page.url, nowMs, tzOffsetMinutes, variables: { v: value } });
      if (!r.errors.length && r.output.trim()) value = r.output.trim();
    }
    return { name: p.name, value, type };
  });

  const draft: ClipDraft = {
    templateId: template.id,
    behavior: template.behavior,
    noteName: String(result.noteName ?? sanitizeFileName(page.title)),
    folder,
    properties,
    body: String(result.content ?? ""),
    extracted,
    errors: ((result.errors ?? []) as { message: string }[]).map((e) => ({ message: e.message })),
  };

  // Web Clipper's Interpreter: the engine keeps prompt variables verbatim; the app fills them.
  const ctx = { html: page.html, url: page.url, nowMs, tzOffsetMinutes, variables };
  const nameHasPrompt = countPrompts([template.noteNameFormat]) > 0 || /\{\{\s*"|\{\{\s*prompt:|\{\{\s*'/.test(template.noteNameFormat);
  const rawName = nameHasPrompt ? engine.renderTemplate(template.noteNameFormat, ctx).output.trim() : "";
  const prompts = countPrompts([draft.body, ...draft.properties.map((p) => p.value), rawName]);
  if (prompts) {
    if (opts.settings.interpreterEnabled === false) {
      draft.body = stripPromptVariables(draft.body);
      for (const p of draft.properties) p.value = stripPromptVariables(p.value);
      if (rawName) draft.noteName = sanitizeFileName(stripPromptVariables(rawName));
    } else {
      if (rawName) draft.noteName = rawName;
      const contextTemplate = template.context?.trim() || opts.settings.defaultPromptContext?.trim() || DEFAULT_PROMPT_CONTEXT;
      const rendered = engine.renderTemplate(contextTemplate, ctx).output;
      draft.interpreter = { context: rendered.slice(0, MAX_CONTEXT_CHARS), prompts, url: page.url, nowMs, tzOffsetMinutes };
    }
  }
  return draft;
}

export function propertyTypeMap(settings: Pick<Settings, "propertyTypes">): Record<string, PropertyType> {
  return Object.fromEntries(settings.propertyTypes.map((p) => [p.name, p.type]));
}

/** The file to write: frontmatter only for new notes, as Web Clipper does. */
export function assembleNote(draft: ClipDraft, settings: Pick<Settings, "propertyTypes">): { path: string; content: string; markdown: string; interpreter?: ClipInterpreterRequest } {
  const fm = generateFrontmatter(draft.properties, {
    ...propertyTypeMap(settings),
    ...Object.fromEntries(draft.properties.map((p) => [p.name, p.type])),
  });
  const markdown = fm + draft.body;
  const withFrontmatter = draft.behavior === "create" || draft.behavior === "overwrite";
  const name = sanitizeFileName(draft.noteName);
  const interpreter: ClipInterpreterRequest | undefined = draft.interpreter
    ? {
        context: draft.interpreter.context,
        body: draft.body,
        properties: draft.properties.map((p) => ({ name: p.name, value: p.value, type: p.type })),
        propertyTypes: propertyTypeMap(settings),
        frontmatter: withFrontmatter,
        noteName: draft.noteName,
        folder: draft.folder,
        url: draft.interpreter.url,
        nowMs: draft.interpreter.nowMs,
        tzOffsetMinutes: draft.interpreter.tzOffsetMinutes,
      }
    : undefined;
  return {
    path: isDaily(draft.behavior) ? "" : joinPath(draft.folder, name),
    content: withFrontmatter ? markdown : draft.body,
    markdown,
    interpreter,
  };
}

export { getEngine };
