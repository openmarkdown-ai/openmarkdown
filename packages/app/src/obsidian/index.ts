/**
 * The `obsidian` module, as plugins `require` it.
 *
 * Every runtime (non-type) export of obsidian.d.ts 1.13.1 appears here.
 * `e2e/unit/api-surface.spec.ts` compares this module's keys against the
 * declaration file so a missing export fails a test instead of a plugin.
 */
export { App } from "./app";
export { Component, Events } from "./events";
export type { EventRef } from "./events";
export { Plugin } from "./plugin";
export {
  apiVersion,
  arrayBufferToBase64,
  arrayBufferToHex,
  base64ToArrayBuffer,
  debounce,
  getAllTags,
  getBlobArrayBuffer,
  getFrontMatterInfo,
  getLanguage,
  getLinkpath,
  hexToArrayBuffer,
  htmlToMarkdown,
  iterateCacheRefs,
  iterateRefs,
  moment,
  normalizePath,
  parseFrontMatterAliases,
  parseFrontMatterEntry,
  parseFrontMatterStringArray,
  parseFrontMatterTags,
  parseLinktext,
  parsePropertyId,
  parseYaml,
  Platform,
  prepareFuzzySearch,
  prepareSimpleSearch,
  renderMatches,
  renderResults,
  request,
  requestUrl,
  requireApiVersion,
  resolveSubpath,
  sanitizeHTMLToDom,
  sortSearchResults,
  stringifyYaml,
  stripHeading,
  stripHeadingForLink,
} from "./util";

// vault
export { TAbstractFile, TFile, TFolder } from "./vault/files";
export { Vault } from "./vault/vault";
export { FileManager } from "./vault/file-manager";
export { MetadataCache } from "./vault/metadata-cache";
export { FileSystemAdapter, CapacitorAdapter } from "./vault/adapter-classes";

// workspace
export { Workspace } from "./workspace/workspace";
export { WorkspaceLeaf } from "./workspace/leaf";
export { WorkspaceItem } from "./workspace/base";
export {
  WorkspaceContainer,
  WorkspaceFloating,
  WorkspaceMobileDrawer,
  WorkspaceParent,
  WorkspaceRibbon,
  WorkspaceRoot,
  WorkspaceSidedock,
  WorkspaceSplit,
  WorkspaceTabs,
  WorkspaceWindow,
} from "./workspace/items";
export { EditableFileView, FileView, ItemView, TextFileView, View } from "./workspace/view";

// markdown
export { MarkdownPreviewRenderer, MarkdownRenderChild, MarkdownRenderer } from "./markdown/renderer";
export { MarkdownEditView, MarkdownPreviewView, MarkdownView } from "./markdown/markdown-view";
export { finishRenderMath, loadMathJax, loadMermaid, loadPdfJs, loadPrism, renderMathSync as renderMath } from "./markdown/loaders";

// editor
export { Editor } from "../editor/editor-base";
export { editorEditorField, editorInfoField, editorLivePreviewField, editorViewField, livePreviewState } from "../editor/fields";

// ui
export { addIcon, getIcon, getIconIds, removeIcon, setIcon } from "./ui/icons";
export { displayTooltip, setTooltip } from "./ui/tooltip";
export { Notice } from "./ui/notice";
export { Keymap, Scope } from "./ui/keymap";
export { ConfirmationButton, ConfirmationModal, Modal } from "./ui/modal";
export { Menu, MenuItem, MenuSeparator } from "./ui/menu";
export * from "./ui/setting";
export { AbstractInputSuggest, EditorSuggest, FuzzySuggestModal, PopoverSuggest, SuggestModal } from "./ui/suggest";
export { HoverPopover, PopoverState } from "./ui/popover";
export { PluginSettingTab, SettingTab } from "./ui/setting-tab";

// app internals exposed as public classes
export { SecretStorage, Tasks, RenderContext } from "./app-internals/public-classes";

// bases
export * from "./bases/api";
