/**
 * Typing and clipboard behaviour:
 *
 *  - Auto-pair brackets (`( [ { "`) via @codemirror/autocomplete's closeBrackets.
 *  - Auto-pair Markdown: typing `*` `_` `~` `=` `` ` `` `$` `%` with a selection wraps
 *    it; a lone backtick or `$` inserts a pair.
 *  - Paste: files become attachments (`host.saveAttachment` → `![[link]]`); HTML is
 *    converted to Markdown when "Auto convert HTML" is on (Mod-Shift-V pastes plain
 *    text); a URL pasted over a selection makes a Markdown link.
 *  - Drop: files are saved as attachments at the drop position.
 */
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { keymap } from "@codemirror/view";
import { configFacet, hostFacet, sourcePathOf } from "./facets";
import { inRawBlock } from "./lists";
import { writeTable } from "./commands";
import type { EditorHost } from "./host";

const MARKDOWN_PAIRS = new Set(["*", "_", "~", "=", "`", "$", "%"]);

export function autoPairBrackets(): Extension {
  return [
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
    // Obsidian pairs brackets and double quotes, not single quotes (apostrophes in prose).
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{", '"'] } }]),
  ];
}

export function autoPairMarkdown(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (!view.state.facet(configFacet).autoPairMarkdown) return false;
    if (text.length !== 1 || !MARKDOWN_PAIRS.has(text)) return false;
    const state = view.state;
    if (view.composing || inRawBlock(state, from)) return false;
    const sel = state.selection;
    if (sel.ranges.some((r) => !r.empty)) {
      // Wrap every selection, keeping the text selected.
      const tr = state.changeByRange((r) => ({
        changes: [
          { from: r.from, insert: text },
          { from: r.to, insert: text },
        ],
        range: EditorSelection.range(r.anchor + 1, r.head + 1),
      }));
      view.dispatch(state.update(tr, { userEvent: "input.type" }));
      return true;
    }
    if (from !== to) return false;
    if (text === "`" || text === "$") {
      const line = state.doc.lineAt(from);
      const lineBefore = state.sliceDoc(line.from, from);
      const before = state.sliceDoc(from - 1, from);
      const after = state.sliceDoc(from, from + 1);
      // A code fence being typed: the third backtick of "```" is just a backtick
      // (pairing it again gave "````"). The fence closes on Enter (lists.ts).
      if (text === "`" && /(^|[^`])``$/.test(lineBefore) && after !== "`") return false;
      if (after === text) {
        // Type over the closing character.
        view.dispatch({ selection: EditorSelection.cursor(from + 1), userEvent: "input.type" });
        return true;
      }
      if (/\w/.test(before) || /\w/.test(after) || before === text) return false;
      view.dispatch({ changes: { from, insert: text + text }, selection: EditorSelection.cursor(from + 1), userEvent: "input.type" });
      return true;
    }
    return false;
  });
}

function isImage(file: File) {
  return file.type.startsWith("image/");
}

async function insertAttachments(view: EditorView, host: EditorHost, files: File[], pos: number | null) {
  const config = view.state.facet(configFacet);
  const links: string[] = [];
  for (const file of files) {
    try {
      const link = await host.saveAttachment(file, sourcePathOf(host));
      if (config.useMarkdownLinks) links.push(`${isImage(file) ? "!" : ""}[](${encodeURI(link)})`);
      else links.push(`![[${link}]]`);
    } catch (e) {
      console.error("Could not save attachment", e);
    }
  }
  if (!links.length) return;
  const insert = links.join("\n");
  if (pos === null) {
    view.dispatch(view.state.replaceSelection(insert), { userEvent: "input.paste", scrollIntoView: true });
  } else {
    view.dispatch({ changes: { from: pos, insert }, selection: EditorSelection.cursor(pos + insert.length), userEvent: "input.drop", scrollIntoView: true });
  }
}

const EMPTY_ITEM_BEFORE = /^([ \t]*(?:>[ \t]?)*[ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?$/;
const STARTS_WITH_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;

/** Cursor on an empty list item (`- `, `1. `, `- [ ] `) and the pasted text starts with its own marker. */
function listMarkerPaste(state: EditorState, text: string): { from: number; prefix: string } | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return null;
  const pos = sel.main.head;
  const line = state.doc.lineAt(pos);
  if (line.to !== pos) return null;
  const m = EMPTY_ITEM_BEFORE.exec(line.text);
  if (!m || !STARTS_WITH_ITEM.test(text)) return null;
  return { from: line.from + m[1]!.length, prefix: m[1]! };
}

/** Insert pasted Markdown at the selection; list items pasted onto an empty marker keep a single marker (Obsidian 1.14). */
function insertPasted(view: EditorView, md: string) {
  const state = view.state;
  const onMarker = listMarkerPaste(state, md);
  if (onMarker) {
    const lines = md.replace(/\r\n?/g, "\n").split("\n");
    const firstIndent = /^[ \t]*/.exec(lines[0]!)![0].length;
    const insert = lines.map((l, i) => (i === 0 ? l.slice(firstIndent) : l ? onMarker.prefix + l.slice(Math.min(firstIndent, /^[ \t]*/.exec(l)![0].length)) : l)).join("\n");
    const to = state.selection.main.head;
    view.dispatch({ changes: { from: onMarker.from, to, insert }, selection: EditorSelection.cursor(onMarker.from + insert.length), userEvent: "input.paste", scrollIntoView: true });
    return;
  }
  view.dispatch(state.replaceSelection(md), { userEvent: "input.paste", scrollIntoView: true });
}

function needsBlankLineBefore(state: EditorState): boolean {
  const pos = state.selection.main.from;
  const line = state.doc.lineAt(pos);
  return pos > line.from && line.text.slice(0, pos - line.from).trim() !== "";
}

/** Tab-separated rows (≥2 lines, the same number of cells ≥2) as a formatted Markdown table, else null. */
export function tsvToTable(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length < 2 || !lines.every((l) => l.includes("\t"))) return null;
  const rows = lines.map((l) => l.split("\t").map((c) => c.trim().replace(/\|/g, "\\|")));
  const width = rows[0]!.length;
  if (width < 2 || !rows.every((r) => r.length === width)) return null;
  return writeTable({ from: 0, to: 0, rows, align: new Array(width).fill(null), row: 0, col: 0, indent: "" }).text;
}

let plainPasteRequested = false;

export function clipboardHandlers(): Extension {
  return [
    Prec.high(
      EditorView.domEventHandlers({
        keydown(evt) {
          const mod = navigator.platform.includes("Mac") ? evt.metaKey : evt.ctrlKey;
          plainPasteRequested = mod && evt.shiftKey && (evt.key === "v" || evt.key === "V");
          return false;
        },
        paste(evt, view) {
          const host = view.state.facet(hostFacet);
          const plain = plainPasteRequested;
          plainPasteRequested = false;
          if (!host || !evt.clipboardData) return false;
          if (host.onPaste?.(evt) || evt.defaultPrevented) return true;
          const data = evt.clipboardData;
          const files = Array.from(data.files ?? []);
          if (files.length) {
            evt.preventDefault();
            void insertAttachments(view, host, files, null);
            return true;
          }
          const state = view.state;
          const text = data.getData("text/plain");
          if (plain) {
            if (!text) return false;
            evt.preventDefault();
            view.dispatch(state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
            return true;
          }
          // URL over a selection → [selection](url)
          const main = state.selection.main;
          if (text && /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text.trim()) && !main.empty && state.selection.ranges.length === 1) {
            const sel = state.sliceDoc(main.from, main.to);
            if (!/\n/.test(sel) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(sel)) {
              evt.preventDefault();
              const insert = `[${sel}](${text.trim()})`;
              view.dispatch({ changes: { from: main.from, to: main.to, insert }, selection: EditorSelection.cursor(main.from + insert.length), userEvent: "input.paste" });
              return true;
            }
          }
          const html = data.getData("text/html");
          const raw = inRawBlock(state, main.from);
          // Spreadsheet cells (tab-separated rows) become a Markdown table.
          const table = !raw && text && (!html || /<table/i.test(html)) ? tsvToTable(text) : null;
          if (table) {
            evt.preventDefault();
            insertPasted(view, table.replace(/^/, needsBlankLineBefore(state) ? "\n" : ""));
            return true;
          }
          let md: string | null = null;
          if (html && state.facet(configFacet).autoConvertHtml && !raw) {
            try {
              md = host.htmlToMarkdown(html) || null;
            } catch (e) {
              console.error(e);
              md = null;
            }
          }
          if (md === null && text && !raw && listMarkerPaste(state, text)) md = text;
          if (md === null) return false;
          evt.preventDefault();
          insertPasted(view, md);
          return true;
        },
        drop(evt, view) {
          const host = view.state.facet(hostFacet);
          if (!host || !evt.dataTransfer) return false;
          if (host.onDrop?.(evt) || evt.defaultPrevented) return true;
          const files = Array.from(evt.dataTransfer.files ?? []);
          if (!files.length) return false;
          evt.preventDefault();
          const pos = view.posAtCoords({ x: evt.clientX, y: evt.clientY }) ?? view.state.selection.main.head;
          void insertAttachments(view, host, files, pos);
          return true;
        },
        contextmenu(evt, view) {
          const host = view.state.facet(hostFacet);
          if (host?.onContextMenu?.(evt)) {
            evt.preventDefault();
            return true;
          }
          return false;
        },
      }),
    ),
  ];
}
