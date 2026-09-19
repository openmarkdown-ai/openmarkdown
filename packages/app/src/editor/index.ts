/**
 * The Markdown editor module. The `obsidian` module re-exports `Editor`,
 * `editorInfoField`, `editorEditorField`, `editorViewField`,
 * `editorLivePreviewField` and `livePreviewState` from here.
 */
export { Editor } from "./editor-base";
export type {
  EditorChange,
  EditorCommandName,
  EditorPosition,
  EditorRange,
  EditorRangeOrCaret,
  EditorScrollInfo,
  EditorSelection,
  EditorSelectionOrCaret,
  EditorTransaction,
} from "./editor-base";
export { CMEditor, editorOf } from "./editor";
export { createMarkdownEditor } from "./create";
export type { CreateEditorOptions, MarkdownEditorHandle } from "./create";
export type {
  EditorHost,
  EditorConfig,
  EditorSuggestManager,
  LinkSuggestion,
  HeadingSuggestion,
  BlockSuggestion,
  TagSuggestion,
} from "./host";
export { DEFAULT_EDITOR_CONFIG, readConfig } from "./host";
export {
  editorInfoField,
  editorEditorField,
  editorViewField,
  editorLivePreviewField,
  livePreviewState,
  setEditorInfo,
  setLivePreview,
} from "./fields";
export type { LivePreviewStateType } from "./fields";
export { hostFacet, configFacet } from "./facets";
export * as editorCommands from "./commands";
export { EDITOR_COMMANDS, editorKeymap, hotkeyToKey } from "./commands";
export type { EditorCommandSpec, Hotkey, FormatType } from "./commands";
export { ofmLanguage, ofmTree, findCodeLanguage } from "./syntax/language";
export { OFM, ofmExtensions, matchTag } from "./syntax/ofm";
export { computeTokens } from "./syntax/hypermd";
export { clickableTokenAt, frontmatterInfo, foldRangeAt } from "./live-preview";
export { Vim, getCM, exposeVimAdapter } from "./vim";
