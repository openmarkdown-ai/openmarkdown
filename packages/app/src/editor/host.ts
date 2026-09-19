/**
 * EditorHost — everything the Markdown editor needs from the application.
 *
 * The editor module (`packages/app/src/editor/**`) never imports the vault,
 * workspace or renderer directly. The app (MarkdownView) implements this
 * interface over the real `App`; the dev harness implements it over an
 * in-memory set of notes. Every method is synchronous unless it has to touch
 * the file system, so decorations can be computed inside a CM6 update.
 *
 * Optional members may be omitted; the editor falls back to a sensible
 * behaviour (usually "do nothing").
 */
import type { Extension } from "@codemirror/state";

export interface LinkSuggestion {
  /** Vault path of the file (or the unresolved link text). */
  path: string;
  /** Text shown in the list (usually the basename, or `path` when ambiguous). */
  display: string;
  /** Linktext to insert. Defaults to `display` without extension for .md files. */
  linktext?: string;
  subpath?: string;
  alias?: string;
  /** Shown faded next to the title (e.g. the folder). */
  note?: string;
  /** True when this entry does not exist yet ("create new note"). */
  unresolved?: boolean;
}

export interface HeadingSuggestion {
  heading: string;
  level: number;
}

export interface BlockSuggestion {
  /** Existing `^id`, when the block already has one. */
  id?: string;
  /** Plain text of the block (shown in the list). */
  text: string;
  /** 0-based line of the block's last line in the target file (where a new id is appended). */
  line: number;
}

export interface TagSuggestion {
  /** Tag including the leading `#`. */
  tag: string;
  count: number;
}

/** The subset of `EditorSuggest` management the editor drives (Obsidian's `workspace.editorSuggest`). */
export interface EditorSuggestManager {
  isShowingSuggestion(): boolean;
  /** Returns true when the key was consumed by the open suggestion popover. */
  handleKey(evt: KeyboardEvent): boolean;
  /** Called after every user edit / cursor move so each registered EditorSuggest can run `onTrigger`. */
  trigger(editor: unknown, file: unknown, force?: boolean): void;
  close(): void;
}

/**
 * Settings the editor reads through `getConfig`. Keys and value shapes match
 * Obsidian's `.obsidian/app.json` so the host can forward `vault.getConfig`.
 */
export interface EditorConfig {
  livePreview: boolean;
  readableLineLength: boolean;
  strictLineBreaks: boolean;
  showLineNumber: boolean;
  showIndentGuide: boolean;
  foldHeading: boolean;
  foldIndent: boolean;
  rightToLeft: boolean;
  spellcheck: boolean;
  autoPairBrackets: boolean;
  autoPairMarkdown: boolean;
  smartIndentList: boolean;
  useTab: boolean;
  tabSize: number;
  vimMode: boolean;
  autoConvertHtml: boolean;
  /** "visible" renders the properties widget, "hidden" hides frontmatter, "source" shows YAML. */
  propertiesInDocument: "visible" | "hidden" | "source";
  /** Legacy boolean Obsidian used before `propertiesInDocument`; only consulted when that key is unset. */
  showFrontmatter: boolean;
  /** Obsidian's `useMarkdownLinks`: pasted/dropped attachments are inserted as `![](path)` instead of `![[path]]`. */
  useMarkdownLinks: boolean;
  /** Obsidian's `newLinkFormat` (used by the host when it computes linktext for suggestions and attachments). */
  newLinkFormat: "shortest" | "relative" | "absolute";

  // ---- OpenMarkdown writing features. Stored in `.obsidian/app.json` beside
  // Obsidian's keys (desktop Obsidian ignores keys it does not know).
  /** With spellcheck on, right-clicking a plain word opens the browser's menu (spelling suggestions). Shift+right-click always does. */
  nativeSpellMenu: boolean;
  /** Curly quotes, en/em dashes and ellipses while typing (Smart Typography plugin behaviour). Never inside code, math, links or frontmatter. */
  smartTypography: boolean;
  /** Word completion from the vault's vocabulary (Various Complements-like). */
  wordCompletion: boolean;
  /** Advanced Tables-style keys: Tab/Shift-Tab/Enter move between cells and re-align the table. */
  tableAutoFormat: boolean;
  /** A small toolbar above a table while the cursor is in it. */
  tableToolbar: boolean;
  /** Grammar and style checking (Harper, on-device). */
  grammarCheck: boolean;
  /** Dim everything except the current paragraph / sentence / line while focus mode is on. */
  focusDim: "off" | "paragraph" | "sentence" | "line";
  /** Keep the caret line at `typewriterOffset` percent of the editor height. */
  typewriterScroll: boolean;
  typewriterOffset: number;
  /** Desktop formatting toolbar: off, fixed under the tab header, or floating over a selection. */
  formattingToolbar: "off" | "fixed" | "selection";
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  livePreview: true,
  readableLineLength: true,
  strictLineBreaks: false,
  showLineNumber: false,
  showIndentGuide: true,
  foldHeading: true,
  foldIndent: true,
  rightToLeft: false,
  spellcheck: false,
  autoPairBrackets: true,
  autoPairMarkdown: true,
  smartIndentList: true,
  useTab: true,
  tabSize: 4,
  vimMode: false,
  autoConvertHtml: true,
  propertiesInDocument: "visible",
  showFrontmatter: true,
  useMarkdownLinks: false,
  newLinkFormat: "shortest",
  nativeSpellMenu: true,
  smartTypography: false,
  wordCompletion: false,
  tableAutoFormat: true,
  tableToolbar: true,
  grammarCheck: false,
  focusDim: "paragraph",
  typewriterScroll: false,
  typewriterOffset: 50,
  formattingToolbar: "off",
};

export interface EditorHost {
  /** The `App`; handed to `editorInfoField` consumers and EditorSuggests untouched. */
  app: unknown;

  /**
   * The object stored in `editorInfoField` (Obsidian's MarkdownView, which
   * implements MarkdownFileInfo). When omitted the editor stores a minimal
   * `{ app, file, editor }` object.
   */
  getInfo?(): unknown;

  /** The file being edited (a TFile in the app). Only `path`/`basename` are read by the editor. */
  getFile(): { path: string; basename: string } | null;

  /** `metadataCache.getFirstLinkpathDest`. Returns null for unresolved links. */
  resolveLink(linkpath: string, sourcePath: string): { path: string; extension: string } | null;

  getLinkSuggestions(query: string, sourcePath: string): LinkSuggestion[];
  getHeadingSuggestions(linkpath: string, sourcePath: string): HeadingSuggestion[];
  getBlockSuggestions(linkpath: string, sourcePath: string): BlockSuggestion[];
  getTagSuggestions(query: string): TagSuggestion[];
  /** Append ` ^id` to `line` of the note `linkpath` resolves to (choosing a block without an id in `[[note#^`). */
  addBlockId?(linkpath: string, sourcePath: string, line: number, id: string): void;

  /** `workspace.openLinkText`. `newLeaf` is true for Mod-click / middle click. */
  openLink(linktext: string, sourcePath: string, newLeaf: boolean): void;
  /** Open an external URL (defaults to `window.open`). */
  openExternal?(url: string): void;
  /** Clicking a `#tag` (Obsidian opens a search). */
  onTagClick?(tag: string, evt: MouseEvent): void;
  /** Hovering an internal link with Mod held (page preview). */
  onLinkHover?(evt: MouseEvent, targetEl: HTMLElement, linktext: string, sourcePath: string): void;

  /** Render `![[linktext]]` (image, note, pdf, audio, video …) into `container`. `alt` is the text after `|`. */
  renderEmbed(container: HTMLElement, linktext: string, sourcePath: string, alt: string): void;
  /** Render TeX. Must return a detached element (MathJax output). */
  renderMath(source: string, display: boolean): HTMLElement;
  /** `MarkdownRenderer.render` — used for callouts, tables, mermaid and code block processors. */
  renderMarkdown(markdown: string, container: HTMLElement, sourcePath: string): void | Promise<void>;
  /** Render the Properties widget for the frontmatter body (YAML without the `---` fences). */
  renderProperties(container: HTMLElement, frontmatterText: string, onChange: (newYaml: string) => void): void;
  /** True when a plugin registered `registerMarkdownCodeBlockProcessor(lang)` (rendered as a widget in Live Preview). */
  hasCodeBlockProcessor?(lang: string): boolean;

  /** HTML clipboard → Markdown (vault-clip's html_to_markdown). */
  htmlToMarkdown(html: string): string;
  /** Store a pasted/dropped file as an attachment; returns the linktext to embed (e.g. `Pasted image 2024….png`). */
  saveAttachment(file: File, sourcePath: string): Promise<string>;

  /** Editor settings (see `EditorConfig`). Return undefined for "use default". */
  getConfig(key: keyof EditorConfig | string): unknown;

  /** Called (debounced by the host if it wants) after every document change. */
  onDocChanged?(text: string): void;
  /** Called for every editor selection/focus change (Obsidian's `editor-change` does not fire for these). */
  onSelectionChanged?(): void;

  /** Obsidian's `workspace.editorSuggest`. Plugin EditorSuggests take priority over the built-in link/tag popover. */
  getEditorSuggests(): EditorSuggestManager | null;

  /** Plugins' `registerEditorExtension` extensions (re-read on `reconfigure()`). */
  extraExtensions(): Extension[];

  /**
   * Draw a Lucide icon into `el` (the app's `setIcon`). When omitted the
   * editor draws its own small inline SVGs for fold chevrons and buttons.
   */
  setIcon?(el: HTMLElement, icon: string): void;

  /** Paste/drop hooks (`workspace.trigger("editor-paste"/"editor-drop")`); return true when a handler called preventDefault. */
  onPaste?(evt: ClipboardEvent): boolean;
  onDrop?(evt: DragEvent): boolean;

  /** Right-click in the editor (`editor-menu`). Return true to suppress the native menu. */
  onContextMenu?(evt: MouseEvent): boolean;

  /** True when a community plugin is enabled (built-in features step aside for Advanced Tables, Various Complements …). */
  isPluginEnabled?(id: string): boolean;
  /** Words used across the vault with their frequency (word completion). Built lazily; may resolve empty. */
  getVocabulary?(): Promise<Map<string, number>>;
  /** Grammar/style issues in `text` (UTF-16 offsets; see editor/grammar-lint.ts `GrammarIssue`). Resolves `[]` while the checker is off. */
  lintGrammar?(text: string): Promise<import("./grammar-lint").GrammarIssue[]>;
  /** Add a word to the vault dictionary (`.obsidian/dictionary.txt`). */
  addToDictionary?(word: string): Promise<void>;
}

/** Typed read of a config key with a default. */
export function readConfig<K extends keyof EditorConfig>(host: EditorHost, key: K): EditorConfig[K] {
  let v = host.getConfig(key);
  if (key === "propertiesInDocument" && v === undefined) {
    const legacy = host.getConfig("showFrontmatter");
    if (legacy === false) v = "hidden";
  }
  return (v === undefined || v === null ? DEFAULT_EDITOR_CONFIG[key] : v) as EditorConfig[K];
}
