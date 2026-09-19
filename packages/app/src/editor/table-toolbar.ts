/**
 * Tables like Advanced Tables: keys and a small context toolbar.
 *
 * Keys (setting `tableAutoFormat`, default on), with the cursor in a table:
 *   Tab / Shift+Tab   format the table, select the next / previous cell
 *                     (Tab after the last cell adds a row)
 *   Enter             format, select the same column in the next row (adds a
 *                     row after the last); Enter on an empty last row leaves
 *                     the table
 *   Shift+Enter       `<br>` inside the cell
 *
 * Toolbar (setting `tableToolbar`, default on): while the cursor is in a
 * table and the editor has focus, a row of buttons floats above the table:
 *
 *   div.cm-tooltip.vault-table-toolbar[role=toolbar]
 *     div.clickable-icon.vault-table-toolbar-button[aria-label][data-action]
 *     div.vault-table-toolbar-separator
 *
 * The Advanced Tables plugin (`table-editor-obsidian`) binds Tab/Enter at the
 * highest precedence and handles tables in Source mode itself, so its keys
 * always get the first chance; ours only act on keys it declines. Its own
 * toolbar replaces ours in Source mode (it leaves Live Preview to the app).
 */
import { EditorSelection, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, showTooltip } from "@codemirror/view";
import type { Tooltip } from "@codemirror/view";
import { insertTab } from "@codemirror/commands";
import type { SyntaxNode } from "@lezer/common";
import { exitTableOnEmptyRow, readTable, tableCommands } from "./commands";
import { configFacet, hostFacet } from "./facets";
import { editorLivePreviewField } from "./fields";
import type { TableKey } from "./lists";
import { ofmTree } from "./syntax/language";

export const ADVANCED_TABLES_ID = "table-editor-obsidian";

/** True while the Advanced Tables plugin owns table keys in this editor (Source mode). */
function pluginOwnsTables(state: EditorState): boolean {
  const host = state.facet(hostFacet);
  if (!host?.isPluginEnabled?.(ADVANCED_TABLES_ID)) return false;
  return !(state.field(editorLivePreviewField, false) ?? false);
}

function tableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = ofmTree(state);
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) if (n.name === "Table") return n;
  }
  return null;
}

export const tableKeys: { tab: TableKey; shiftTab: TableKey; enter: TableKey; shiftEnter: TableKey } = {
  tab(view) {
    if (!view.state.facet(configFacet).tableAutoFormat) return insertTab(view);
    return tableCommands.nextCell(view);
  },
  shiftTab(view) {
    if (!view.state.facet(configFacet).tableAutoFormat) return false;
    return tableCommands.previousCell(view);
  },
  enter(view) {
    if (!view.state.facet(configFacet).tableAutoFormat) return false;
    const r = view.state.selection.main;
    const line = view.state.doc.lineAt(r.head);
    // Only inside a row (not on the line after the table the parser may include).
    if (!line.text.includes("|")) return false;
    return exitTableOnEmptyRow(view) || tableCommands.nextRow(view);
  },
  shiftEnter(view) {
    if (!view.state.facet(configFacet).tableAutoFormat) return false;
    view.dispatch(view.state.replaceSelection("<br>"), { userEvent: "input", scrollIntoView: true });
    return true;
  },
};

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

interface ToolbarAction {
  id: string;
  label: string;
  icon: string;
  run: (view: EditorView) => boolean;
}

type ToolbarEntry = ToolbarAction | "|";

const ACTIONS: ToolbarEntry[] = [
  { id: "row-before", label: "Add row above", icon: "lucide-between-horizontal-start", run: tableCommands.addRowBefore },
  { id: "row-after", label: "Add row below", icon: "lucide-between-horizontal-end", run: tableCommands.addRowAfter },
  { id: "row-up", label: "Move row up", icon: "lucide-arrow-up", run: tableCommands.moveRowUp },
  { id: "row-down", label: "Move row down", icon: "lucide-arrow-down", run: tableCommands.moveRowDown },
  { id: "row-delete", label: "Delete row", icon: "lucide-trash-2", run: tableCommands.deleteRow },
  "|",
  { id: "col-before", label: "Add column left", icon: "lucide-between-vertical-start", run: tableCommands.addColumnBefore },
  { id: "col-after", label: "Add column right", icon: "lucide-between-vertical-end", run: tableCommands.addColumnAfter },
  { id: "col-left", label: "Move column left", icon: "lucide-arrow-left", run: tableCommands.moveColumnLeft },
  { id: "col-right", label: "Move column right", icon: "lucide-arrow-right", run: tableCommands.moveColumnRight },
  { id: "col-delete", label: "Delete column", icon: "lucide-x", run: tableCommands.deleteColumn },
  "|",
  { id: "align-left", label: "Align column left", icon: "lucide-align-left", run: tableCommands.alignLeft },
  { id: "align-center", label: "Align column center", icon: "lucide-align-center", run: tableCommands.alignCenter },
  { id: "align-right", label: "Align column right", icon: "lucide-align-right", run: tableCommands.alignRight },
  "|",
  { id: "sort-asc", label: "Sort by column A→Z", icon: "lucide-arrow-down-a-z", run: tableCommands.sortAscending },
  { id: "sort-desc", label: "Sort by column Z→A", icon: "lucide-arrow-up-z-a", run: tableCommands.sortDescending },
  { id: "format", label: "Format table", icon: "lucide-wand-sparkles", run: tableCommands.format },
];

const FALLBACK_GLYPHS: Record<string, string> = {
  "row-before": "↥", "row-after": "↧", "row-up": "↑", "row-down": "↓", "row-delete": "⌫",
  "col-before": "⇤", "col-after": "⇥", "col-left": "←", "col-right": "→", "col-delete": "×",
  "align-left": "⟸", "align-center": "≡", "align-right": "⟹", "sort-asc": "A↓", "sort-desc": "Z↓", format: "✦",
};

function toolbarTooltip(state: EditorState): Tooltip | null {
  const config = state.facet(configFacet);
  if (!config.tableToolbar || state.selection.ranges.length !== 1) return null;
  if (pluginOwnsTables(state)) return null;
  const head = state.selection.main.head;
  const node = tableNodeAt(state, head);
  if (!node) return null;
  const first = state.doc.lineAt(node.from);
  if (!readTable(state, head)) return null;
  return {
    pos: first.from,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view) => ({ dom: renderToolbar(view), offset: { x: 0, y: 4 } }),
  };
}

function renderToolbar(view: EditorView): HTMLElement {
  const doc = view.dom.ownerDocument;
  const host = view.state.facet(hostFacet);
  const dom = doc.createElement("div");
  dom.className = "vault-table-toolbar";
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", "Table");
  for (const entry of ACTIONS) {
    if (entry === "|") {
      dom.appendChild(doc.createElement("div")).className = "vault-table-toolbar-separator";
      continue;
    }
    const b = doc.createElement("div");
    b.className = "clickable-icon vault-table-toolbar-button";
    b.setAttribute("aria-label", entry.label);
    b.setAttribute("data-tooltip-position", "top");
    b.setAttribute("data-action", entry.id);
    b.setAttribute("role", "button");
    if (host?.setIcon) host.setIcon(b, entry.icon);
    if (!b.firstChild) b.textContent = FALLBACK_GLYPHS[entry.id] ?? entry.label;
    // Keep the editor's focus and selection: act on mousedown.
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return;
      entry.run(view);
      view.focus();
    });
    dom.appendChild(b);
  }
  return dom;
}

const toolbarField = StateField.define<Tooltip | null>({
  create: (state) => toolbarTooltip(state),
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && !tr.reconfigured && tr.state.field(editorLivePreviewField, false) === tr.startState.field(editorLivePreviewField, false)) return value;
    const next = toolbarTooltip(tr.state);
    // Keep the same tooltip object while it stays on the same table (no flicker).
    if (value && next && value.pos === tr.changes.mapPos(value.pos)) return next.pos === value.pos ? value : next;
    return next;
  },
  provide: (f) => showTooltip.from(f),
});

/** Hide the toolbar while the editor does not have focus. */
const focusTheme = EditorView.theme({
  "&:not(.cm-focused) .vault-table-toolbar": { display: "none" },
});

export function tableToolbar(): Extension {
  return [toolbarField, focusTheme];
}

export { EditorSelection };
