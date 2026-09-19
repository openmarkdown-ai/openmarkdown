/**
 * Formatting toolbar: the command list shared by the desktop toolbar (fixed
 * under the tab header, `core-plugins/formatting-toolbar`), the floating
 * selection toolbar below, and the mobile keyboard toolbar (W4).
 *
 * Every entry is a real command id. An entry with `children` is a dropdown
 * (the heading menu); the parent id is itself a command (`editor:set-heading`,
 * "Toggle heading", which shows the same menu at the cursor).
 *
 *   div.cm-tooltip.vault-selection-toolbar[role=toolbar]
 *     div.clickable-icon.vault-toolbar-button[aria-label][data-command][.is-active]
 */
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { ViewPlugin, showTooltip } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { Tooltip } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { configFacet, hostFacet } from "./facets";
import { editorOf } from "./editor";
import type { EditorHost } from "./host";
import { ofmTree } from "./syntax/language";
import { OFM } from "./syntax/ofm";

export interface ToolbarItem {
  /** Command id run by the button (`editor:toggle-bold` …). */
  id: string;
  name: string;
  icon: string;
  /** A dropdown of further commands (the button opens a menu). */
  children?: ToolbarItem[];
}

export const HEADING_ITEMS: ToolbarItem[] = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `editor:set-heading-${n}`, name: `Heading ${n}`, icon: `lucide-heading-${n}` })),
  { id: "editor:set-heading-0", name: "Body", icon: "lucide-pilcrow" },
];

/** Default desktop toolbar, in order (Editing Toolbar's default set, with Obsidian's ids). */
export const FORMATTING_TOOLBAR_COMMANDS: ToolbarItem[] = [
  { id: "editor:set-heading", name: "Heading", icon: "lucide-heading", children: HEADING_ITEMS },
  { id: "editor:toggle-bold", name: "Bold", icon: "lucide-bold" },
  { id: "editor:toggle-italics", name: "Italic", icon: "lucide-italic" },
  { id: "editor:toggle-strikethrough", name: "Strikethrough", icon: "lucide-strikethrough" },
  { id: "editor:toggle-highlight", name: "Highlight", icon: "lucide-highlighter" },
  { id: "editor:toggle-code", name: "Inline code", icon: "lucide-code" },
  { id: "editor:toggle-bullet-list", name: "Bullet list", icon: "lucide-list" },
  { id: "editor:toggle-numbered-list", name: "Numbered list", icon: "lucide-list-ordered" },
  { id: "editor:toggle-checklist-status", name: "Checklist", icon: "lucide-check-square" },
  { id: "editor:toggle-blockquote", name: "Quote", icon: "lucide-quote" },
  { id: "editor:insert-link", name: "Markdown link", icon: "lucide-link" },
  { id: "editor:insert-wikilink", name: "Internal link", icon: "lucide-link-2" },
  { id: "editor:insert-codeblock", name: "Code block", icon: "lucide-square-code" },
  { id: "editor:insert-callout", name: "Callout", icon: "lucide-message-square-quote" },
  { id: "editor:insert-table", name: "Table", icon: "lucide-table" },
  { id: "editor:undo", name: "Undo", icon: "lucide-undo-2" },
  { id: "editor:redo", name: "Redo", icon: "lucide-redo-2" },
];

/** The floating toolbar over a selection: inline formats only. */
export const SELECTION_TOOLBAR_COMMANDS: string[] = [
  "editor:toggle-bold",
  "editor:toggle-italics",
  "editor:toggle-strikethrough",
  "editor:toggle-highlight",
  "editor:toggle-code",
  "editor:insert-link",
  "editor:insert-wikilink",
  "editor:set-heading",
];

/**
 * Obsidian's default `mobileToolbarCommands` (app.json), in order (§11). W4's
 * keyboard toolbar reads/writes the same key; unknown ids are skipped.
 */
export const MOBILE_TOOLBAR_DEFAULTS: string[] = [
  "editor:undo",
  "editor:redo",
  "editor:insert-wikilink",
  "editor:insert-embed",
  "editor:insert-tag",
  "editor:attach-file",
  "editor:set-heading",
  "editor:toggle-bold",
  "editor:toggle-italics",
  "editor:toggle-strikethrough",
  "editor:toggle-highlight",
  "editor:toggle-code",
  "editor:toggle-blockquote",
  "editor:toggle-comments",
  "editor:insert-link",
  "editor:toggle-bullet-list",
  "editor:toggle-numbered-list",
  "editor:toggle-checklist-status",
  "editor:indent-list",
  "editor:unindent-list",
  "editor:configure-toolbar",
];

const ALL_ITEMS = new Map<string, ToolbarItem>();
for (const item of [...FORMATTING_TOOLBAR_COMMANDS, ...HEADING_ITEMS]) ALL_ITEMS.set(item.id, item);

/** Toolbar item for a command id (our icon/name when known, else the registered command's). */
export function toolbarItemFor(app: any, id: string): ToolbarItem | null {
  const known = ALL_ITEMS.get(id);
  if (known) return known;
  const cmd = app?.commands?.findCommand?.(id);
  if (!cmd) return null;
  return { id, name: cmd.name, icon: cmd.icon ?? "lucide-terminal-square" };
}

/** Community plugins whose toolbar replaces ours. */
export const TOOLBAR_PLUGINS = ["editing-toolbar", "cmenu-plugin"];

/**
 * Run a command against a specific editor (not necessarily the active one):
 * editor commands get that editor and its view, others run normally.
 */
export function runCommandOn(app: any, id: string, editor: unknown, info: unknown): boolean {
  const cmd = app?.commands?.findCommand?.(id);
  if (!cmd) return false;
  try {
    if (cmd.editorCheckCallback && editor) {
      if (!cmd.editorCheckCallback(true, editor, info)) return false;
      void cmd.editorCheckCallback(false, editor, info);
      return true;
    }
    if (cmd.editorCallback && editor) {
      void cmd.editorCallback(editor, info);
      return true;
    }
  } catch (e) {
    console.error(`Command "${id}" failed`, e);
    return false;
  }
  return app.commands.executeCommandById(id);
}

// ---------------------------------------------------------------------------
// Active formats (for `.is-active` on buttons)
// ---------------------------------------------------------------------------

const INLINE_NODES: Record<string, string> = {
  "editor:toggle-bold": "StrongEmphasis",
  "editor:toggle-italics": "Emphasis",
  "editor:toggle-strikethrough": "Strikethrough",
  "editor:toggle-highlight": OFM.Highlight,
  "editor:toggle-code": "InlineCode",
  "editor:toggle-inline-math": OFM.InlineMath,
  "editor:toggle-comments": OFM.ObsidianComment,
};

/** Command ids whose format applies at the main cursor. */
export function activeFormats(state: EditorState): Set<string> {
  const out = new Set<string>();
  const head = state.selection.main.head;
  const tree = ofmTree(state);
  const names = new Set<string>();
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(head, side); n; n = n.parent) names.add(n.name);
  }
  for (const [id, node] of Object.entries(INLINE_NODES)) if (names.has(node)) out.add(id);
  const line = state.doc.lineAt(head).text;
  const heading = /^(#{1,6})\s/.exec(line);
  if (heading) {
    out.add("editor:set-heading");
    out.add(`editor:set-heading-${heading[1]!.length}`);
  }
  const body = line.replace(/^[ \t]*(?:>[ \t]?)*[ \t]*/, "");
  if (/^[ \t]*>/.test(line)) out.add("editor:toggle-blockquote");
  if (/^[-*+][ \t]+\[.\]/.test(body) || /^\d+[.)][ \t]+\[.\]/.test(body)) out.add("editor:toggle-checklist-status");
  else if (/^[-*+][ \t]/.test(body)) out.add("editor:toggle-bullet-list");
  else if (/^\d+[.)][ \t]/.test(body)) out.add("editor:toggle-numbered-list");
  return out;
}

// ---------------------------------------------------------------------------
// Floating selection toolbar
// ---------------------------------------------------------------------------

function selectionToolbarEnabled(state: EditorState): boolean {
  if (state.facet(configFacet).formattingToolbar !== "selection") return false;
  const host = state.facet(hostFacet);
  if (host?.isPluginEnabled && TOOLBAR_PLUGINS.some((id) => host.isPluginEnabled!(id))) return false;
  return true;
}

function buildTooltip(state: EditorState): Tooltip | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || sel.main.empty) return null;
  if (!selectionToolbarEnabled(state)) return null;
  return {
    pos: sel.main.from,
    end: sel.main.to,
    above: true,
    arrow: false,
    create: (view) => createSelectionToolbar(view),
  };
}

function createSelectionToolbar(view: EditorView) {
  const doc = view.dom.ownerDocument;
  const dom = doc.createElement("div");
  dom.className = "vault-selection-toolbar";
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", "Formatting");
  const host = view.state.facet(hostFacet);
  const app = (host?.app ?? null) as any;
  const buttons: { id: string; el: HTMLElement }[] = [];
  for (const id of SELECTION_TOOLBAR_COMMANDS) {
    const item = toolbarItemFor(app, id);
    if (!item) continue;
    const b = doc.createElement("div");
    b.className = "clickable-icon vault-toolbar-button";
    b.setAttribute("aria-label", item.name);
    b.setAttribute("data-command", item.id);
    b.setAttribute("role", "button");
    drawIcon(host, b, item.icon, item.name);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (evt) => {
      evt.preventDefault();
      runFromView(view, item, b);
    });
    dom.appendChild(b);
    buttons.push({ id: item.id, el: b });
  }
  const sync = (state: EditorState) => {
    const active = activeFormats(state);
    for (const b of buttons) b.el.classList.toggle("is-active", active.has(b.id));
  };
  sync(view.state);
  return {
    dom,
    update: (u: { state: EditorState; selectionSet: boolean; docChanged: boolean }) => {
      if (u.selectionSet || u.docChanged) sync(u.state);
    },
  };
}

function drawIcon(host: EditorHost | null, el: HTMLElement, icon: string, fallback: string) {
  if (host?.setIcon) host.setIcon(el, icon);
  else el.textContent = fallback.slice(0, 1);
}

/** Run a toolbar item for the editor in `view`; dropdown items open a menu under `anchor`. */
export function runFromView(view: EditorView, item: ToolbarItem, anchor?: HTMLElement) {
  const host = view.state.facet(hostFacet);
  const app = host?.app as any;
  const editor = editorOf(view);
  const info = host?.getInfo?.() ?? null;
  if (!app) return;
  if (item.children?.length && anchor) {
    showItemMenu(app, item, anchor, (child) => runCommandOn(app, child.id, editor, info), activeFormats(view.state));
    return;
  }
  runCommandOn(app, item.id, editor, info);
}

/** Shows a dropdown; installed by the app (`core-plugins/formatting-toolbar`) so the editor module needs no UI import. */
export type ToolbarMenuFactory = (item: ToolbarItem, anchor: HTMLElement, run: (child: ToolbarItem) => void, active?: Set<string>) => void;
let menuFactory: ToolbarMenuFactory | null = null;

export function setToolbarMenuFactory(fn: ToolbarMenuFactory | null) {
  menuFactory = fn;
}

export function showItemMenu(_app: unknown, item: ToolbarItem, anchor: HTMLElement, run: (child: ToolbarItem) => void, active?: Set<string>) {
  menuFactory?.(item, anchor, run, active);
}

/** Pointer button held in the editor (a drag-selection in progress): the bar waits for release. */
const setPointerHeld = StateEffect.define<boolean>();

const selectionToolbarField = StateField.define<{ tooltip: Tooltip | null; held: boolean }>({
  create: (state) => ({ tooltip: buildTooltip(state), held: false }),
  update(value, tr) {
    let held = value.held;
    let released = false;
    for (const e of tr.effects) {
      if (e.is(setPointerHeld)) {
        released = held && !e.value;
        held = e.value;
      }
    }
    if (held) return value.held && !value.tooltip ? value : { tooltip: null, held };
    if (!tr.selection && !tr.docChanged && !released && tr.startState.facet(configFacet) === tr.state.facet(configFacet)) return value;
    const next = buildTooltip(tr.state);
    // Keep the same tooltip object while the range is unchanged so CM keeps its DOM.
    if (next && value.tooltip && next.pos === value.tooltip.pos && next.end === value.tooltip.end) return { tooltip: value.tooltip, held };
    return { tooltip: next, held };
  },
  provide: (f) => showTooltip.compute([f], (state) => state.field(f).tooltip),
});

const pointerTracker = ViewPlugin.fromClass(
  class {
    down = false;
    private readonly onUp = () => {
      if (!this.down) return;
      this.down = false;
      this.view.dispatch({ effects: setPointerHeld.of(false) });
    };
    constructor(readonly view: EditorView) {
      (view.dom.ownerDocument.defaultView ?? window).addEventListener("mouseup", this.onUp, true);
    }
    destroy() {
      (this.view.dom.ownerDocument.defaultView ?? window).removeEventListener("mouseup", this.onUp, true);
    }
  },
  {
    eventObservers: {
      mousedown(evt, view) {
        if (evt.button !== 0 || view.state.facet(configFacet).formattingToolbar !== "selection") return;
        this.down = true;
        view.dispatch({ effects: setPointerHeld.of(true) });
      },
    },
  },
);

export function selectionToolbar(): Extension {
  return [selectionToolbarField, pointerTracker];
}
