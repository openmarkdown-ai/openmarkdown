/**
 * The Rust core, as the app sees it.
 *
 * Every call is synchronous once `initEngine()` has resolved: the plugin API
 * has synchronous entry points (`metadataCache.getFileCache`,
 * `prepareFuzzySearch(q)(text)`), so the wasm module must be instantiated
 * before the first plugin loads rather than lazily on first use.
 *
 * Values cross the boundary as JSON strings. `JSON.parse` of a metadata blob is
 * faster than walking it field by field through wasm-bindgen getters, and it
 * keeps the Rust side free of JS-specific types.
 */
import type { CachedMetadata, SearchResult } from "obsidian";
import type { WasmExports } from "./wasm-types";

export type { CachedMetadata, SearchResult };

export interface RenderedSection {
  kind: string;
  lineStart: number;
  lineEnd: number;
  html: string;
}

export interface WordCount {
  words: number;
  characters: number;
}

export interface SubpathResultJson {
  type: "heading" | "block" | "footnote";
  start: { line: number; col: number; offset: number };
  end: { line: number; col: number; offset: number } | null;
  current?: unknown;
  next?: unknown;
  block?: unknown;
  list?: unknown;
  footnote?: unknown;
}

export interface FileEntry {
  path: string;
  size: number;
  ctime: number;
  mtime: number;
}

export interface Snippet {
  /** The excerpt (normally the whole line; long lines are windowed). */
  text: string;
  /** UTF-16 offset of `text` in the file. */
  offset: number;
  /** The match within `text`, UTF-16 [start, end). */
  start: number;
  end: number;
}

export interface ContentMatch {
  /** UTF-16 offsets into the file. */
  start: number;
  end: number;
  line: number;
  col: number;
  context: Snippet;
}

export interface BacklinkRef {
  kind: "link" | "embed" | "frontmatter";
  link: string;
  original: string;
  displayText?: string;
  position?: { start: { line: number; col: number; offset: number }; end: { line: number; col: number; offset: number } };
  /** Frontmatter key path (`related` or `related.1`). */
  key?: string;
  context?: Snippet;
}

export interface Backlink {
  source: string;
  refs: BacklinkRef[];
}

export interface Mention {
  source: string;
  matches: ContentMatch[];
}

export interface SearchFileResult {
  path: string;
  /** UTF-16 ranges in the file name (basename plus extension). */
  filenameMatches: [number, number][];
  /** UTF-16 ranges in the full path (from `path:`). */
  filepathMatches: [number, number][];
  contentMatches: ContentMatch[];
  properties: { key: string; value?: unknown; [k: string]: unknown }[];
  matchCount: number;
  mtime: number;
  ctime: number;
}

export interface SearchExplanation {
  label: string;
  children?: SearchExplanation[];
}

export interface SearchOutput {
  results: SearchFileResult[];
  /** Files matched (before `limit`). */
  fileCount: number;
  /** The number the search pane shows. */
  matchCount: number;
  error?: string;
  explanation?: SearchExplanation;
}

export interface SearchOptions {
  caseSensitive?: boolean;
  sort?: "alphabetical" | "alphabeticalReverse" | "byModifiedTime" | "byModifiedTimeReverse" | "byCreatedTime" | "byCreatedTimeReverse";
  includeUnsupported?: boolean;
  explain?: boolean;
  limit?: number;
}

export interface GraphNode {
  /** File path, tag (`#tag`), or unresolved link text. */
  id: string;
  label: string;
  kind: "note" | "attachment" | "tag" | "unresolved";
  group?: number;
  weight: number;
  depth?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: { source: number; target: number }[];
}

export interface GraphOptions {
  search?: string;
  showTags?: boolean;
  showAttachments?: boolean;
  hideUnresolved?: boolean;
  showOrphans?: boolean;
  colorGroups?: { query: string; color: unknown }[];
  localFile?: string | null;
  localJumps?: number;
  localBacklinks?: boolean;
  localForelinks?: boolean;
  localInterlinks?: boolean;
}

export interface FileEdit {
  /** The note's path after the rename (where to write). */
  path: string;
  /** The note's path before the rename (whose text the offsets refer to). */
  originalPath: string;
  edits: { start: number; end: number; text: string }[];
}

export interface VaultIndexHandle {
  upsertFile(entry: FileEntry): void;
  removeFile(path: string): void;
  renameFile(oldPath: string, newPath: string): void;
  /** Parses `text`, stores content + metadata, and returns the metadata. */
  setNote(path: string, text: string): CachedMetadata;
  resolveLink(linkpath: string, sourcePath: string): string | null;
  resolvedLinks(): Record<string, Record<string, number>>;
  unresolvedLinks(): Record<string, Record<string, number>>;
  backlinks(path: string): Backlink[];
  unlinkedMentions(path: string): Mention[];
  tags(): Record<string, number>;
  linktext(target: string, source: string, format: "shortest" | "relative" | "absolute"): string;
  renameEdits(oldPath: string, newPath: string, opts: { linkFormat?: "shortest" | "relative" | "absolute" }): FileEdit[];
  search(query: string, opts: SearchOptions): SearchOutput;
  graph(opts: GraphOptions): GraphData;
  /** Resolved and unresolved link counts from one note (for incremental updates). */
  outgoing(path: string): { resolved: Record<string, number>; unresolved: Record<string, number> };
  free(): void;
}

export interface ForceLayoutHandle {
  /** Runs up to `iterations` ticks; returns false once the simulation has cooled. */
  step(iterations: number): boolean;
  /** Interleaved [x0, y0, x1, y1, …] — a view into wasm memory; copy before the next call. */
  positions(): Float32Array;
  /** Obsidian graph.json units: centerStrength 0–1, repelStrength 0–20, linkStrength 0–1, linkDistance 30–500. */
  setParams(params: { centerStrength?: number; repelStrength?: number; linkStrength?: number; linkDistance?: number }): void;
  pin(node: number, x: number, y: number): void;
  unpin(node: number): void;
  reheat(alpha: number): void;
  alpha(): number;
  /** Warm restart: nodes keep their positions by id. */
  setGraph(ids: string[], links: Uint32Array): void;
  free(): void;
}

/**
 * One vault file for the publisher. Notes carry `text`; attachments carry
 * `bytes` (base64-encoded by the binding). `mtime`/`ctime` are ms since the
 * epoch (the sitemap and RSS feed use `mtime`).
 */
export interface PublishFile {
  path: string;
  text?: string;
  bytes?: Uint8Array;
  mtime?: number;
  ctime?: number;
}

export type PublishTheme = "light" | "dark" | "auto";

/** `exportNote` input (crates/vault-publish `NoteExportInput`). */
export interface NoteExportInput {
  /** The note to export; must be one of `files`. */
  path: string;
  /** The note, the notes it embeds, and attachments (images become data URIs). */
  files: PublishFile[];
  options?: {
    /** Defaults to the file name. */
    title?: string;
    theme?: PublishTheme;
    strictLineBreaks?: boolean;
    /** Default true. */
    inlineTitle?: boolean;
    /** Frontmatter as a properties table; default true. */
    showProperties?: boolean;
    /** Nested `![[note]]` embeds before they become links; default 3. */
    embedDepth?: number;
    /** Notes exported alongside: links to them become relative `.html` hrefs (site path scheme). */
    exported?: string[];
    /** Allow the MathJax / Mermaid CDN script tags (only on pages that need them); default true. */
    cdn?: boolean;
    /** Extra CSS appended to the inline styles. */
    css?: string;
  };
}

/**
 * `exportSite` input (crates/vault-publish `SiteExportInput`). Option names
 * also accept Obsidian Headless `site-options.json` keys (`indexFile`,
 * `showOutline`, `defaultTheme`, `navigationOrdering` …).
 */
export interface SiteExportInput {
  /** Candidate notes (with `text`), attachments (with `bytes`), `publish.css`, favicons. */
  files: PublishFile[];
  options?: {
    siteName?: string;
    /** Home note path or link text → `index.html`. */
    home?: string;
    /** Absolute URL of the site, for canonical/OpenGraph URLs, sitemap.xml and rss.xml. */
    baseUrl?: string;
    theme?: PublishTheme;
    showNavigation?: boolean;
    showGraph?: boolean;
    showBacklinks?: boolean;
    showToc?: boolean;
    search?: boolean;
    hoverPreview?: boolean;
    showThemeToggle?: boolean;
    hideTitle?: boolean;
    readableLineLength?: boolean;
    strictLineBreaks?: boolean;
    showProperties?: boolean;
    /** Folders to publish (empty = all); `publish: true|false` frontmatter overrides both lists. */
    include?: string[];
    exclude?: string[];
    /** Vault path of a logo image. */
    logo?: string;
    embedDepth?: number;
    navOrder?: string[];
    navHidden?: string[];
    /** Link `publish.css` when it is among the files; default true. */
    customCss?: boolean;
    rssLimit?: number;
    /** Feed build time (ms); 0 = newest note mtime. */
    nowMs?: number;
    noindex?: boolean;
    cdn?: boolean;
  };
}

export interface Engine {
  parse(text: string): CachedMetadata;
  render(text: string, opts: { strictLineBreaks: boolean }): RenderedSection[];
  wordCount(text: string): WordCount;
  yamlParse(src: string): unknown;
  yamlStringify(value: unknown): string;
  resolveSubpath(meta: CachedMetadata, subpath: string): SubpathResultJson | null;
  fuzzy(query: string, text: string): SearchResult | null;
  simpleSearch(query: string, text: string): SearchResult | null;
  rank(query: string, items: string[], limit: number): { index: number; result: SearchResult }[];
  htmlToMarkdown(html: string, baseUrl: string | undefined): string;
  extract(html: string, url: string): Record<string, unknown>;
  /** Web Clipper template language. `context`: {html?, url, nowMs, tzOffsetMinutes, variables?}; html gives page variables. */
  renderTemplate(template: string, context: Record<string, unknown>): { output: string; errors: { code: string; message: string; line: number; column: number }[] };
  /** Runs a Web Clipper template JSON against a page: {noteName, frontmatter, content, fullContent, properties, prompts} or {error}. */
  clipPage(templateJson: string, input: { html: string; url: string; nowMs: number; tzOffsetMinutes: number; variables?: Record<string, unknown> }): Record<string, any>;
  formatConvert(text: string, options: Record<string, boolean>): string;
  createIndex(): VaultIndexHandle;
  createForceLayout(ids: string[], links: Uint32Array, params: { centerStrength?: number; repelStrength?: number; linkStrength?: number; linkDistance?: number }): ForceLayoutHandle;
  bases: {
    parse(yaml: string): { base?: unknown; error?: string };
    serialize(base: unknown): string;
    runView(base: unknown, view: number, files: unknown[], thisFile: unknown | null, nowMs: number, tzOffsetMin: number): unknown;
    eval(expr: string, context: unknown): unknown;
  };
  publish: {
    /** One note → a standalone HTML document (inline CSS, resolved links, inlined embeds and images). */
    exportNote(input: NoteExportInput): string;
    /** A vault → static site files (pages, assets, search index, graph, tags, sitemap, RSS, attachments). */
    exportSite(input: SiteExportInput): { path: string; data: Uint8Array }[];
  };
  importer: {
    /** kind: enex | html | notion | roam | keep | bear | logseq | csv | textbundle. Files come back as bytes (notes are UTF-8 Markdown). */
    run(kind: string, files: { path: string; data: Uint8Array }[], options: Record<string, unknown>): { files: { path: string; data: Uint8Array }[]; warnings: string[] };
  };
}

let engine: Engine | null = null;
let loading: Promise<Engine> | null = null;

export function getEngine(): Engine {
  if (!engine) throw new Error("vault engine used before initEngine() resolved");
  return engine;
}

export function isEngineReady(): boolean {
  return engine !== null;
}

export function initEngine(wasmUrl?: string | URL): Promise<Engine> {
  if (engine) return Promise.resolve(engine);
  loading ??= (async () => {
    const mod = (await import("./wasm-gen/vault_wasm.js")) as unknown as WasmExports & { default: (input?: unknown) => Promise<unknown> };
    const instance = await mod.default(wasmUrl ? { module_or_path: wasmUrl } : undefined);
    const { bindEngine } = await import("./bind");
    // `instance` holds the raw exports, including `memory` for zero-copy views.
    engine = bindEngine({ ...mod, __wasm: instance });
    return engine;
  })();
  return loading;
}

/** Tests and tools can install a hand-built engine. */
export function setEngine(e: Engine) {
  engine = e;
}
