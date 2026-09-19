/**
 * Live Preview: everything that differs from Source mode. Source mode is the
 * same editor with `editorLivePreviewField` false — these extensions stay
 * installed and produce nothing, so toggling is a single effect.
 */
import type { Extension } from "@codemirror/state";
import { revealSelectionField } from "./reveal";
import { livePreviewBlocks } from "./blocks";
import { livePreviewInline } from "./inline";
import { linkClickHandlers } from "./links";

export function livePreview(): Extension {
  return [revealSelectionField, livePreviewBlocks, livePreviewInline, linkClickHandlers];
}

export { revealSelectionField, selectionTouches, selectionOnLines } from "./reveal";
export { livePreviewBlocks, frontmatterInfo } from "./blocks";
export { livePreviewInline } from "./inline";
export { clickableTokenAt, linkClickHandlers } from "./links";
export type { ClickableToken } from "./links";
export { folding, foldRangeAt, toggleFoldCommand, foldAllCommand, unfoldAllCommand, foldMoreCommand, foldLessCommand } from "./fold";
export { listIndentation } from "./indent";
