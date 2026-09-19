/**
 * OpenMarkdown's writing features, installed in every Markdown editor. Each
 * extension reads its switch from `configFacet` at run time, so turning a
 * setting on or off needs no editor rebuild (`reconfigure()` swaps the facet).
 *
 * Built-ins that overlap a community plugin (Advanced Tables, Various
 * Complements, Editing Toolbar …) check `host.isPluginEnabled(id)` and step
 * aside while that plugin is on.
 */
import type { Extension } from "@codemirror/state";
import { searchPanel } from "./search-panel";
import { smartTypography } from "./typography";
import { wordCompletion } from "./word-complete";
import { grammarLint } from "./grammar-lint";
import { focusDimming, typewriterScrolling } from "./focus";
import { tableToolbar } from "./table-toolbar";
import { selectionToolbar } from "./toolbar-commands";

export function writingFeatures(): Extension[] {
  return [searchPanel(), smartTypography(), wordCompletion(), grammarLint(), focusDimming(), typewriterScrolling(), tableToolbar(), selectionToolbar()];
}
