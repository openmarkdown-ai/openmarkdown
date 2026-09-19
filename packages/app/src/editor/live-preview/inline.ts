/**
 * Live Preview inline decorations: hides formatting marks the selection does
 * not touch, renders bullets, checkboxes, inline math, inline embeds and link
 * text, and replaces code fences with the language flair.
 *
 * Hidden markup is *removed* (empty replace decorations), as in Obsidian.
 * Heading `#`, quote `>` and escapes reveal when the selection is anywhere on
 * the line; everything else reveals when the selection touches the element.
 */
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { OFM } from "../syntax/ofm";
import { findCodeLanguage, ofmTree } from "../syntax/language";
import { editorLivePreviewField } from "../fields";
import { configFacet, hostFacet, sourcePathOf } from "../facets";
import { revealSelectionField, selectionOnLines, selectionTouches } from "./reveal";
import {
  CheckboxWidget,
  CodeFlairWidget,
  EmbedWidget,
  ExternalImageWidget,
  ExternalLinkIconWidget,
  HiddenQuoteMarkWidget,
  MathWidget,
  TextWidget,
} from "./widgets";
import { isBlockLevelEmbedLine, codeProcessorLang } from "./blocks";

const hide = Decoration.replace({});
const underline = Decoration.mark({ class: "cm-underline", attributes: { tabindex: "-1", draggable: "true" } });
const unresolved = Decoration.mark({ class: "is-unresolved" });
const bullet = Decoration.mark({ class: "list-bullet" });
const listNumber = Decoration.mark({ class: "list-number" });
const transparent = Decoration.mark({ class: "cm-transparent" });
const quoteWidget = Decoration.replace({ widget: new HiddenQuoteMarkWidget() });
const externalIcon = Decoration.widget({ widget: new ExternalLinkIconWidget(), side: 1 });
const subpathSeparator = Decoration.replace({ widget: new TextWidget(" > ") });

export const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function skipSpaces(state: EditorState, pos: number, limit: number) {
  while (pos < limit) {
    const ch = state.doc.sliceString(pos, pos + 1);
    if (ch !== " " && ch !== "\t") break;
    pos++;
  }
  return pos;
}

/** Linktext (target + subpath, without alias) of a Wikilink/Embed node. */
export function wikilinkText(state: EditorState, node: SyntaxNode): string {
  const open = node.firstChild;
  const pipe = node.getChild(OFM.WikilinkPipe);
  const closeMark = node.lastChild;
  if (!open || !closeMark) return "";
  return state.doc.sliceString(open.to, pipe ? pipe.from : closeMark.from);
}

function build(view: EditorView): DecorationSet {
  const state = view.state;
  const host = state.facet(hostFacet);
  const sourcePath = sourcePathOf(host);
  const tree = ofmTree(state);
  const decos: Range<Decoration>[] = [];
  const doc = state.doc;
  const resolvedCache = new Map<string, boolean>();
  const isResolved = (linkpath: string) => {
    if (!host) return true;
    let r = resolvedCache.get(linkpath);
    if (r === undefined) {
      r = linkpath === "" || !!host.resolveLink(linkpath, sourcePath);
      resolvedCache.set(linkpath, r);
    }
    return r;
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (ref) => {
        const node = ref.node;
        switch (node.name) {
          case "ATXHeading1":
          case "ATXHeading2":
          case "ATXHeading3":
          case "ATXHeading4":
          case "ATXHeading5":
          case "ATXHeading6": {
            if (selectionOnLines(state, node.from, node.from)) return;
            for (let m = node.firstChild; m; m = m.nextSibling) {
              if (m.name !== "HeaderMark") continue;
              if (m.from === node.from) {
                const end = skipSpaces(state, m.to, node.to);
                if (end > m.from) decos.push(hide.range(m.from, end));
              } else {
                let start = m.from;
                while (start > node.from && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
                decos.push(hide.range(start, m.to));
              }
            }
            return;
          }

          case "Emphasis":
          case "StrongEmphasis":
          case "Strikethrough":
          case OFM.Highlight: {
            if (selectionTouches(state, node.from, node.to)) return;
            for (let m = node.firstChild; m; m = m.nextSibling) {
              if (m.name === "EmphasisMark" || m.name === "StrikethroughMark" || m.name === OFM.HighlightMark) {
                decos.push(hide.range(m.from, m.to));
              }
            }
            return;
          }

          case "InlineCode": {
            if (selectionTouches(state, node.from, node.to)) return false;
            const first = node.firstChild, last = node.lastChild;
            if (first?.name === "CodeMark") decos.push(hide.range(first.from, first.to));
            if (last && last !== first && last.name === "CodeMark") decos.push(hide.range(last.from, last.to));
            return false;
          }

          case "Link": {
            const marks = node.getChildren("LinkMark");
            if (marks.length < 2) return;
            const url = node.getChild("URL");
            if (selectionTouches(state, node.from, node.to)) return;
            const [open, close] = marks;
            if (!url && marks.length < 3) return; // `[x]` / reference links stay as typed
            decos.push(hide.range(open!.from, open!.to));
            if (close!.from > open!.to) decos.push(underline.range(open!.to, close!.from));
            decos.push(hide.range(close!.from, node.to));
            if (url && URL_SCHEME.test(doc.sliceString(url.from, url.to))) decos.push(externalIcon.range(node.to));
            return;
          }

          case "Image": {
            if (selectionTouches(state, node.from, node.to) || isBlockLevelEmbedLine(state, node)) return false;
            const url = node.getChild("URL");
            const marks = node.getChildren("LinkMark");
            if (!url || marks.length < 2) return false;
            const alt = doc.sliceString(marks[0]!.to, marks[1]!.from);
            let target = doc.sliceString(url.from, url.to);
            if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
            const widget = URL_SCHEME.test(target)
              ? new ExternalImageWidget(target, alt)
              : new EmbedWidget(host, safeDecode(target), alt, sourcePath, false, node.from);
            decos.push(Decoration.replace({ widget }).range(node.from, node.to));
            return false;
          }

          case OFM.Wikilink:
          case OFM.Embed: {
            if (selectionTouches(state, node.from, node.to)) return false;
            const open = node.firstChild!, close = node.lastChild!;
            const linktext = wikilinkText(state, node);
            if (node.name === OFM.Embed) {
              if (isBlockLevelEmbedLine(state, node)) return false;
              const alias = node.getChild(OFM.WikilinkAlias);
              const alt = alias ? doc.sliceString(alias.from, alias.to) : "";
              decos.push(
                Decoration.replace({ widget: new EmbedWidget(host, linktext.replace(/\\$/, ""), alt, sourcePath, false, node.from) }).range(
                  node.from,
                  node.to,
                ),
              );
              return false;
            }
            const pipe = node.getChild(OFM.WikilinkPipe);
            const alias = node.getChild(OFM.WikilinkAlias);
            const target = node.getChild(OFM.WikilinkTarget);
            const subpath = node.getChild(OFM.WikilinkSubpath);
            decos.push(hide.range(open.from, open.to));
            let textFrom: number, textTo: number;
            if (pipe && alias) {
              decos.push(hide.range(open.to, pipe.to));
              textFrom = alias.from;
              textTo = alias.to;
            } else {
              textFrom = open.to;
              textTo = pipe ? pipe.from : close.from;
              if (pipe) decos.push(hide.range(pipe.from, close.from));
              if (!target && subpath) {
                // `[[#Heading]]` shows as "Heading".
                const skip = doc.sliceString(subpath.from, subpath.from + 2) === "#^" ? 2 : 1;
                decos.push(hide.range(subpath.from, subpath.from + skip));
                textFrom = subpath.from + skip;
              } else if (target && subpath) {
                // `[[Note#Heading]]` shows as "Note > Heading".
                decos.push(subpathSeparator.range(subpath.from, subpath.from + 1));
              }
            }
            const linkpath = target ? doc.sliceString(target.from, target.to).replace(/\\$/, "") : "";
            if (textTo > textFrom) {
              if (!isResolved(linkpath)) decos.push(unresolved.range(textFrom, textTo));
              decos.push(underline.range(textFrom, textTo));
            }
            decos.push(hide.range(close.from, close.to));
            return false;
          }

          case "URL": {
            if (node.parent && (node.parent.name === "Link" || node.parent.name === "Image" || node.parent.name === "LinkReference")) return;
            decos.push(underline.range(node.from, node.to));
            return;
          }

          case OFM.InlineMath:
          case OFM.DisplayMath: {
            if (selectionTouches(state, node.from, node.to)) return false;
            const marks = node.getChildren(OFM.MathMark);
            if (marks.length < 2) return false;
            const source = doc.sliceString(marks[0]!.to, marks[1]!.from);
            decos.push(
              Decoration.replace({ widget: new MathWidget(host, source, node.name === OFM.DisplayMath, false, node.from) }).range(
                node.from,
                node.to,
              ),
            );
            return false;
          }

          case "Escape": {
            if (!selectionOnLines(state, node.from, node.from)) decos.push(hide.range(node.from, node.from + 1));
            return;
          }

          case "ListItem": {
            const mark = node.firstChild;
            if (!mark || mark.name !== "ListMark") return;
            const task = mark.nextSibling?.name === OFM.Task ? mark.nextSibling : null;
            const taskMarker = task?.firstChild?.name === OFM.TaskMarker ? task.firstChild : null;
            const ordered = node.parent?.name === "OrderedList";
            if (taskMarker) {
              if (selectionTouches(state, mark.from, taskMarker.to)) {
                decos.push((ordered ? listNumber : bullet).range(mark.from, ordered ? Math.min(mark.to + 1, taskMarker.from) : mark.to));
                return;
              }
              const ch = doc.sliceString(taskMarker.from + 1, taskMarker.from + 2);
              if (ordered) decos.push(listNumber.range(mark.from, taskMarker.from));
              else decos.push(hide.range(mark.from, taskMarker.from));
              decos.push(Decoration.replace({ widget: new CheckboxWidget(ch) }).range(taskMarker.from, taskMarker.to));
              return;
            }
            if (ordered) {
              const end = doc.sliceString(mark.to, mark.to + 1) === " " ? mark.to + 1 : mark.to;
              decos.push(listNumber.range(mark.from, end));
            } else {
              decos.push(bullet.range(mark.from, mark.to));
            }
            return;
          }

          case "Blockquote":
          case OFM.Callout: {
            // Markers are handled per line below.
            return;
          }

          case "QuoteMark": {
            const line = doc.lineAt(node.from);
            if (selectionOnLines(state, node.from, node.from)) return;
            const before = doc.sliceString(line.from, node.from);
            if (!before.includes(">")) decos.push(transparent.range(node.from, node.to));
            else decos.push(quoteWidget.range(node.from, node.to));
            return;
          }

          case "FencedCode": {
            if (codeProcessorLang(state, node)) return false; // rendered as a block widget
            if (selectionTouches(state, node.from, node.to)) return false;
            const firstLine = doc.lineAt(node.from);
            const lastLine = doc.lineAt(node.to);
            const info = node.getChild("CodeInfo");
            const lang = info ? doc.sliceString(info.from, info.to) : "";
            const desc = lang ? findCodeLanguage(lang) : null;
            const codeMarks = node.getChildren("CodeMark");
            const closed = codeMarks.length > 1 && lastLine.number > firstLine.number;
            const code = doc.sliceString(firstLine.to + 1, closed ? Math.max(firstLine.to + 1, lastLine.from - 1) : node.to);
            const openFrom = codeMarks[0]!.from;
            decos.push(hide.range(openFrom, firstLine.to));
            decos.push(Decoration.widget({ widget: new CodeFlairWidget(host, desc?.name ?? lang, code), side: 1 }).range(firstLine.to));
            if (closed) {
              const endMark = codeMarks[codeMarks.length - 1]!;
              decos.push(hide.range(endMark.from, lastLine.to));
            }
            return;
          }
        }
        return;
      },
    });
  }
  return Decoration.set(decos, true);
}

function safeDecode(s: string) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

export const livePreviewInline = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = view.state.field(editorLivePreviewField, false) ? build(view) : Decoration.none;
    }
    update(u: ViewUpdate) {
      const lp = u.state.field(editorLivePreviewField, false);
      if (!lp) {
        this.decorations = Decoration.none;
        return;
      }
      if (
        u.docChanged ||
        u.viewportChanged ||
        lp !== u.startState.field(editorLivePreviewField, false) ||
        u.state.field(revealSelectionField) !== u.startState.field(revealSelectionField) ||
        ofmTree(u.state) !== ofmTree(u.startState) ||
        u.state.facet(configFacet) !== u.startState.facet(configFacet)
      ) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

