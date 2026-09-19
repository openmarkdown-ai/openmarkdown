/**
 * Obsidian Flavored Markdown for @lezer/markdown.
 *
 * CommonMark (the base parser) + GFM tables, strikethrough and autolinks,
 * plus Obsidian's own syntax. Every construct gets a named node with named
 * sub-nodes so the highlighter, Live Preview and the commands can work from
 * the tree rather than regexes:
 *
 *   Wikilink / Embed           [[target#subpath|alias]]  ![[…]]
 *     WikilinkMark  WikilinkTarget  WikilinkSubpath  WikilinkPipe  WikilinkAlias
 *   Tag                        #tag/nested    (TagMark = the `#`)
 *   Highlight                  ==text==       (HighlightMark)
 *   ObsidianComment            %%inline%%     (ObsidianCommentMark)
 *   ObsidianCommentBlock       %% on its own line … %%
 *   InlineMath                 $x$            (MathMark)
 *   DisplayMath                $$x$$ inside a paragraph
 *   MathBlock                  $$ … $$ as a block
 *   FootnoteRef                [^label]       (FootnoteMark, FootnoteLabel)
 *   InlineFootnote             ^[text]        (FootnoteMark)
 *   FootnoteDefinition         [^label]: text (FootnoteMark, FootnoteLabel)
 *   Callout                    > [!type|meta]± title   (composite, like Blockquote)
 *     CalloutHeader  CalloutMark  CalloutType  CalloutMeta  CalloutFold  CalloutTitle
 *   BlockId                    ^block-id at the end of a line
 *   Frontmatter                --- yaml --- at the start of the document
 *     FrontmatterMark  FrontmatterContent
 *   Task / TaskMarker          - [?] (any single character, as Obsidian allows)
 *
 * Obsidian's rules (from its help pages and observed behaviour) are noted at
 * each parser.
 */
import type { BlockContext, Element, LeafBlock, Line, MarkdownConfig } from "@lezer/markdown";
import { Autolink, InlineContext, Strikethrough, Table } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";

/** All node names this module defines, for use by consumers. */
export const OFM = {
  Wikilink: "Wikilink",
  Embed: "Embed",
  WikilinkMark: "WikilinkMark",
  WikilinkTarget: "WikilinkTarget",
  WikilinkSubpath: "WikilinkSubpath",
  WikilinkPipe: "WikilinkPipe",
  WikilinkAlias: "WikilinkAlias",
  Tag: "Tag",
  TagMark: "TagMark",
  Highlight: "Highlight",
  HighlightMark: "HighlightMark",
  ObsidianComment: "ObsidianComment",
  ObsidianCommentBlock: "ObsidianCommentBlock",
  ObsidianCommentMark: "ObsidianCommentMark",
  InlineMath: "InlineMath",
  DisplayMath: "DisplayMath",
  MathBlock: "MathBlock",
  MathMark: "MathMark",
  FootnoteRef: "FootnoteRef",
  InlineFootnote: "InlineFootnote",
  FootnoteDefinition: "FootnoteDefinition",
  FootnoteMark: "FootnoteMark",
  FootnoteLabel: "FootnoteLabel",
  Callout: "Callout",
  CalloutHeader: "CalloutHeader",
  CalloutMark: "CalloutMark",
  CalloutType: "CalloutType",
  CalloutMeta: "CalloutMeta",
  CalloutFold: "CalloutFold",
  CalloutTitle: "CalloutTitle",
  BlockId: "BlockId",
  Frontmatter: "Frontmatter",
  FrontmatterMark: "FrontmatterMark",
  FrontmatterContent: "FrontmatterContent",
  Task: "Task",
  TaskMarker: "TaskMarker",
} as const;

const SPACE = /\s|^$/;
// Same punctuation class @lezer/markdown uses for flanking rules.
const PUNCT = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~\xA1‐-‧]/;

function isSpace(ch: number) {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13;
}

// Internal lezer fields (stable within the pinned @lezer/markdown 1.x): a
// line's container depth, compared with cx.depth the way FencedCode does to
// stop a multi-line block at the end of its blockquote/list.
function lineInContext(cx: BlockContext, line: Line): boolean {
  return (line as unknown as { depth: number }).depth >= cx.depth;
}

// ---------------------------------------------------------------------------
// Wikilinks and embeds
// ---------------------------------------------------------------------------

function wikilinkChildren(cx: InlineContext, open: number, markStart: number, close: number): Element[] {
  const children: Element[] = [cx.elt(OFM.WikilinkMark, markStart, open)];
  const inner = cx.slice(open, close);
  let pipe = inner.indexOf("|");
  let pipeLen = 1;
  // Inside tables Obsidian writes `[[a\|b]]`; the backslash belongs to the pipe.
  if (pipe > 0 && inner.charCodeAt(pipe - 1) === 92) {
    pipe--;
    pipeLen = 2;
  }
  const targetEnd = pipe < 0 ? inner.length : pipe;
  const hash = inner.slice(0, targetEnd).indexOf("#");
  const pathEnd = hash < 0 ? targetEnd : hash;
  if (pathEnd > 0) children.push(cx.elt(OFM.WikilinkTarget, open, open + pathEnd));
  if (hash >= 0) children.push(cx.elt(OFM.WikilinkSubpath, open + hash, open + targetEnd));
  if (pipe >= 0) {
    children.push(cx.elt(OFM.WikilinkPipe, open + pipe, open + pipe + pipeLen));
    if (pipe + pipeLen < inner.length) children.push(cx.elt(OFM.WikilinkAlias, open + pipe + pipeLen, close));
  }
  children.push(cx.elt(OFM.WikilinkMark, close, close + 2));
  return children;
}

function parseWikilink(cx: InlineContext, next: number, pos: number): number {
  let embed = false;
  let open = pos;
  if (next === 33 /* ! */) {
    if (cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91) return -1;
    embed = true;
    open = pos + 3;
  } else {
    if (next !== 91 || cx.char(pos + 1) !== 91) return -1;
    open = pos + 2;
  }
  for (let i = open; i < cx.end - 1; i++) {
    const c = cx.char(i);
    if (c === 10) return -1;
    if (c === 93 && cx.char(i + 1) === 93) {
      if (i === open) return -1; // `[[]]`
      return cx.addElement(cx.elt(embed ? OFM.Embed : OFM.Wikilink, pos, i + 2, wikilinkChildren(cx, open, pos, i)));
    }
    if (c === 91 && cx.char(i + 1) === 91) return -1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

// Obsidian: a tag is `#` followed by letters (any script), digits, `_`, `-`,
// `/` and non-ASCII symbols (emoji); ASCII punctuation and whitespace end it.
// It must contain at least one non-digit and must start a word.
const TAG_BODY = /^[^\s!"#$%&'()*+,.:;<=>?@^`{|}~\[\]\\　-〿！-／]+/u;

export function matchTag(text: string): string | null {
  const m = TAG_BODY.exec(text);
  if (!m || /^\d+$/.test(m[0])) return null;
  return m[0];
}

function parseTag(cx: InlineContext, next: number, pos: number): number {
  if (next !== 35 /* # */) return -1;
  if (pos > cx.offset) {
    const before = cx.char(pos - 1);
    if (!isSpace(before)) return -1;
  }
  const body = matchTag(cx.slice(pos + 1, Math.min(cx.end, pos + 1 + 256)));
  if (!body) return -1;
  const end = pos + 1 + body.length;
  return cx.addElement(cx.elt(OFM.Tag, pos, end, [cx.elt(OFM.TagMark, pos, pos + 1)]));
}

// ---------------------------------------------------------------------------
// ==highlight==
// ---------------------------------------------------------------------------

const HighlightDelim = { resolve: OFM.Highlight, mark: OFM.HighlightMark };

function parseHighlight(cx: InlineContext, next: number, pos: number): number {
  if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
  const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
  const sBefore = SPACE.test(before), sAfter = SPACE.test(after);
  const pBefore = PUNCT.test(before), pAfter = PUNCT.test(after);
  return cx.addDelimiter(
    HighlightDelim,
    pos,
    pos + 2,
    !sAfter && (!pAfter || sBefore || pBefore),
    !sBefore && (!pBefore || sAfter || pAfter),
  );
}

// ---------------------------------------------------------------------------
// %%comments%%
// ---------------------------------------------------------------------------

// Obsidian: `%%` opens a comment that runs to the next `%%`, across lines.
// An unclosed `%%` comments out the rest of the paragraph (inline) or the
// rest of the document (block).
function parseInlineComment(cx: InlineContext, next: number, pos: number): number {
  if (next !== 37 || cx.char(pos + 1) !== 37 || (pos > cx.offset && cx.char(pos - 1) === 92)) return -1;
  const rel = cx.text.indexOf("%%", pos + 2 - cx.offset);
  const children = [cx.elt(OFM.ObsidianCommentMark, pos, pos + 2)];
  let end = cx.end;
  if (rel >= 0) {
    end = rel + cx.offset + 2;
    children.push(cx.elt(OFM.ObsidianCommentMark, end - 2, end));
  }
  return cx.addElement(cx.elt(OFM.ObsidianComment, pos, end, children));
}

function parseCommentBlock(cx: BlockContext, line: Line): boolean {
  if (line.next !== 37 || line.text.charCodeAt(line.pos + 1) !== 37) return false;
  const rest = line.text.slice(line.pos + 2);
  const closeOnFirst = rest.indexOf("%%");
  // `%%a%% more text` is an inline comment inside a paragraph.
  if (closeOnFirst >= 0 && rest.slice(closeOnFirst + 2).trim() !== "") return false;
  const from = cx.lineStart + line.pos;
  const marks: Element[] = [cx.elt(OFM.ObsidianCommentMark, from, from + 2)];
  if (closeOnFirst >= 0) {
    const cs = from + 2 + closeOnFirst;
    marks.push(cx.elt(OFM.ObsidianCommentMark, cs, cs + 2));
    cx.nextLine();
    cx.addElement(cx.elt(OFM.ObsidianCommentBlock, from, cs + 2, marks));
    return true;
  }
  let end = cx.lineStart + line.text.length;
  while (cx.nextLine() && lineInContext(cx, line)) {
    for (const m of line.markers) marks.push(m);
    const i = line.text.indexOf("%%", line.basePos);
    if (i >= 0) {
      const cs = cx.lineStart + i;
      marks.push(cx.elt(OFM.ObsidianCommentMark, cs, cs + 2));
      end = cs + 2;
      cx.nextLine();
      break;
    }
    end = cx.lineStart + line.text.length;
  }
  cx.addElement(cx.elt(OFM.ObsidianCommentBlock, from, end, marks));
  return true;
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

// Obsidian (like Pandoc): `$` opens inline math when not followed by a space;
// the closing `$` is not preceded by a space and not followed by a digit.
// `$$` inside a paragraph is display math up to the next `$$`.
function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== 36) return -1;
  if (cx.char(pos + 1) === 36) {
    for (let i = pos + 2; i < cx.end - 1; i++) {
      const c = cx.char(i);
      if (c === 92) {
        i++;
        continue;
      }
      if (c === 36 && cx.char(i + 1) === 36) {
        if (i === pos + 2) return -1;
        return cx.addElement(
          cx.elt(OFM.DisplayMath, pos, i + 2, [cx.elt(OFM.MathMark, pos, pos + 2), cx.elt(OFM.MathMark, i, i + 2)]),
        );
      }
    }
    return -1;
  }
  const first = cx.char(pos + 1);
  if (first < 0 || isSpace(first) || pos + 1 >= cx.end) return -1;
  for (let i = pos + 1; i < cx.end; i++) {
    const c = cx.char(i);
    if (c === 92) {
      i++;
      continue;
    }
    if (c === 10 && cx.char(i + 1) === 10) return -1;
    if (c === 36) {
      if (isSpace(cx.char(i - 1))) return -1;
      const after = cx.char(i + 1);
      if (after >= 48 && after <= 57) return -1;
      return cx.addElement(
        cx.elt(OFM.InlineMath, pos, i + 1, [cx.elt(OFM.MathMark, pos, pos + 1), cx.elt(OFM.MathMark, i, i + 1)]),
      );
    }
  }
  return -1;
}

function parseMathBlock(cx: BlockContext, line: Line): boolean {
  if (line.next !== 36 || line.text.charCodeAt(line.pos + 1) !== 36) return false;
  const from = cx.lineStart + line.pos;
  const marks: Element[] = [cx.elt(OFM.MathMark, from, from + 2)];
  const rest = line.text.slice(line.pos + 2);
  const sameLine = rest.indexOf("$$");
  if (sameLine >= 0) {
    // `$$x$$ trailing` is display math inside a paragraph, not a block.
    if (rest.slice(sameLine + 2).trim() !== "") return false;
    const cs = from + 2 + sameLine;
    marks.push(cx.elt(OFM.MathMark, cs, cs + 2));
    cx.nextLine();
    cx.addElement(cx.elt(OFM.MathBlock, from, cs + 2, marks));
    return true;
  }
  let end = cx.lineStart + line.text.length;
  while (cx.nextLine() && lineInContext(cx, line)) {
    for (const m of line.markers) marks.push(m);
    const i = line.text.indexOf("$$", line.basePos);
    if (i >= 0) {
      const cs = cx.lineStart + i;
      marks.push(cx.elt(OFM.MathMark, cs, cs + 2));
      end = cs + 2;
      cx.nextLine();
      break;
    }
    end = cx.lineStart + line.text.length;
  }
  cx.addElement(cx.elt(OFM.MathBlock, from, end, marks));
  return true;
}

// ---------------------------------------------------------------------------
// Footnotes
// ---------------------------------------------------------------------------

function parseFootnoteRef(cx: InlineContext, next: number, pos: number): number {
  if (next !== 91 || cx.char(pos + 1) !== 94) return -1;
  for (let i = pos + 2; i < cx.end; i++) {
    const c = cx.char(i);
    if (c === 93) {
      if (i === pos + 2 || cx.char(i + 1) === 58 /* `]:` is a definition */) return -1;
      return cx.addElement(
        cx.elt(OFM.FootnoteRef, pos, i + 1, [
          cx.elt(OFM.FootnoteMark, pos, pos + 2),
          cx.elt(OFM.FootnoteLabel, pos + 2, i),
          cx.elt(OFM.FootnoteMark, i, i + 1),
        ]),
      );
    }
    if (isSpace(c) || c === 91) return -1;
  }
  return -1;
}

const InlineFootnoteStart = { resolve: OFM.InlineFootnote, mark: OFM.FootnoteMark };

function parseInlineFootnoteStart(cx: InlineContext, next: number, pos: number): number {
  if (next !== 94 || cx.char(pos + 1) !== 91) return -1;
  return cx.addDelimiter(InlineFootnoteStart, pos, pos + 2, true, false);
}

function parseInlineFootnoteEnd(cx: InlineContext, next: number, pos: number): number {
  if (next !== 93) return -1;
  const idx = cx.findOpeningDelimiter(InlineFootnoteStart);
  if (idx === null) return -1;
  // A plain `[` opened after the footnote start owns this `]`.
  const parts = (cx as unknown as { parts: unknown[] }).parts;
  for (let i = idx + 1; i < parts.length; i++) {
    const d = cx.getDelimiterAt(i);
    if (d && (d.type === InlineContext.linkStart || d.type === InlineContext.imageStart)) return -1;
  }
  const start = cx.getDelimiterAt(idx)!;
  const content = cx.takeContent(idx);
  const el = cx.elt(OFM.InlineFootnote, start.from, pos + 1, [
    cx.elt(OFM.FootnoteMark, start.from, start.to),
    ...content,
    cx.elt(OFM.FootnoteMark, pos, pos + 1),
  ]);
  return cx.addElement(el);
}

const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]?/;

function parseFootnoteDefinition(cx: BlockContext, line: Line): boolean {
  if (line.next !== 91) return false;
  const m = FOOTNOTE_DEF.exec(line.text.slice(line.pos));
  if (!m) return false;
  const from = cx.lineStart + line.pos;
  const labelEnd = from + 2 + m[1]!.length;
  const children: Element[] = [
    cx.elt(OFM.FootnoteMark, from, from + 2),
    cx.elt(OFM.FootnoteLabel, from + 2, labelEnd),
    cx.elt(OFM.FootnoteMark, labelEnd, labelEnd + 2),
  ];
  const contentStart = from + m[0].length;
  const firstText = line.text.slice(line.pos + m[0].length);
  children.push(...cx.parser.parseInline(firstText, contentStart));
  let end = cx.lineStart + line.text.length;
  // Continuation: following non-blank lines indented by at least one space/tab.
  while (cx.nextLine() && lineInContext(cx, line)) {
    if (line.pos >= line.text.length || line.indent - line.baseIndent < 1) break;
    for (const mk of line.markers) children.push(mk);
    children.push(...cx.parser.parseInline(line.text.slice(line.pos), cx.lineStart + line.pos));
    end = cx.lineStart + line.text.length;
  }
  cx.addElement(cx.elt(OFM.FootnoteDefinition, from, end, children));
  return true;
}

// ---------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------

const CALLOUT_HEAD = /^\[!([^\]|]*)(?:\|([^\]]*))?\]([+-]?)/;
const pendingCalloutHeader = new WeakMap<BlockContext, number>();

export function isCalloutStart(text: string): boolean {
  return CALLOUT_HEAD.test(text);
}

function parseCallout(cx: BlockContext, line: Line): null | false {
  if (line.next !== 62) return false;
  const size = line.text.charCodeAt(line.pos + 1) === 32 || line.text.charCodeAt(line.pos + 1) === 9 ? 2 : 1;
  let p = line.pos + size;
  while (p < line.text.length && (line.text.charCodeAt(p) === 32 || line.text.charCodeAt(p) === 9)) p++;
  if (!CALLOUT_HEAD.test(line.text.slice(p))) return false;
  cx.startComposite(OFM.Callout, line.pos);
  cx.addElement(cx.elt("QuoteMark", cx.lineStart + line.pos, cx.lineStart + line.pos + 1));
  line.moveBase(line.pos + size);
  pendingCalloutHeader.set(cx, cx.lineStart);
  return null;
}

function parseCalloutHeader(cx: BlockContext, line: Line): boolean {
  if (pendingCalloutHeader.get(cx) !== cx.lineStart) return false;
  pendingCalloutHeader.delete(cx);
  if (cx.parentType().name !== OFM.Callout) return false;
  const text = line.text.slice(line.pos);
  const m = CALLOUT_HEAD.exec(text);
  if (!m) return false;
  const from = cx.lineStart + line.pos;
  const typeFrom = from + 2;
  const typeTo = typeFrom + m[1]!.length;
  const children: Element[] = [];
  const markEnd = from + m[0].length - m[3]!.length;
  const markChildren: Element[] = [];
  if (typeTo > typeFrom) markChildren.push(cx.elt(OFM.CalloutType, typeFrom, typeTo));
  if (m[2] !== undefined) markChildren.push(cx.elt(OFM.CalloutMeta, typeTo + 1, typeTo + 1 + m[2].length));
  children.push(cx.elt(OFM.CalloutMark, from, markEnd, markChildren));
  if (m[3]) children.push(cx.elt(OFM.CalloutFold, markEnd, markEnd + 1));
  const titleStart = line.skipSpace(line.pos + m[0].length);
  const lineEnd = cx.lineStart + line.text.length;
  if (titleStart < line.text.length) {
    const tFrom = cx.lineStart + titleStart;
    children.push(cx.elt(OFM.CalloutTitle, tFrom, lineEnd, cx.parser.parseInline(line.text.slice(titleStart), tFrom)));
  }
  cx.nextLine();
  cx.addElement(cx.elt(OFM.CalloutHeader, from, lineEnd, children));
  return true;
}

function calloutComposite(cx: BlockContext, line: Line): boolean {
  if (line.next !== 62) return false;
  line.addMarker(cx.elt("QuoteMark", cx.lineStart + line.pos, cx.lineStart + line.pos + 1));
  const nextCh = line.text.charCodeAt(line.pos + 1);
  line.moveBase(line.pos + (nextCh === 32 || nextCh === 9 ? 2 : 1));
  return true;
}

// ---------------------------------------------------------------------------
// Block ids
// ---------------------------------------------------------------------------

// Obsidian: `^id` (letters, digits, dashes) at the very end of a block's last
// line, preceded by whitespace or alone on its own line.
function parseBlockId(cx: InlineContext, next: number, pos: number): number {
  if (next !== 94) return -1;
  if (pos > cx.offset && !isSpace(cx.char(pos - 1))) return -1;
  let i = pos + 1;
  while (i < cx.end) {
    const c = cx.char(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) i++;
    else break;
  }
  if (i === pos + 1) return -1;
  let j = i;
  while (j < cx.end && (cx.char(j) === 32 || cx.char(j) === 9)) j++;
  if (j < cx.end && cx.char(j) !== 10) return -1;
  return cx.addElement(cx.elt(OFM.BlockId, pos, i));
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function parseFrontmatter(cx: BlockContext, line: Line): boolean {
  if (cx.lineStart !== 0 || cx.depth !== 1 || line.pos !== 0 || !/^---\s*$/.test(line.text)) return false;
  // Obsidian only treats it as frontmatter when a closing fence exists.
  const marks: Element[] = [cx.elt(OFM.FrontmatterMark, 0, 3)];
  const contentStart = line.text.length + 1;
  let closed = false;
  let contentEnd = contentStart;
  // Peek ahead without consuming: we cannot rewind a BlockContext, so scan
  // the raw input first.
  const input = (cx as unknown as { input: { length: number; read(from: number, to: number): string } }).input;
  const head = input.read(0, Math.min(input.length, 200_000));
  const close = /\n(---|\.\.\.)[ \t]*(\n|$)/.exec(head.slice(line.text.length));
  if (!close) return false;
  const closeLineStart = line.text.length + close.index + 1;
  while (cx.nextLine()) {
    if (cx.lineStart === closeLineStart) {
      closed = true;
      marks.push(cx.elt(OFM.FrontmatterMark, cx.lineStart, cx.lineStart + 3));
      contentEnd = cx.lineStart - 1;
      const end = cx.lineStart + line.text.length;
      cx.nextLine();
      if (contentEnd > contentStart) marks.splice(1, 0, cx.elt(OFM.FrontmatterContent, contentStart, contentEnd));
      cx.addElement(cx.elt(OFM.Frontmatter, 0, end, marks));
      return true;
    }
  }
  if (!closed) cx.addElement(cx.elt(OFM.Frontmatter, 0, cx.lineStart, marks));
  return true;
}

// ---------------------------------------------------------------------------
// Tasks (any status character)
// ---------------------------------------------------------------------------

class TaskParser {
  nextLine() {
    return false;
  }
  finish(cx: BlockContext, leaf: LeafBlock) {
    cx.addLeafElement(
      leaf,
      cx.elt(OFM.Task, leaf.start, leaf.start + leaf.content.length, [
        cx.elt(OFM.TaskMarker, leaf.start, leaf.start + 3),
        ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
      ]),
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// The extension bundle
// ---------------------------------------------------------------------------

export const ofmExtensions: MarkdownConfig[] = [
  Table,
  Strikethrough,
  Autolink,
  {
    defineNodes: [
      { name: OFM.Wikilink, style: t.link },
      { name: OFM.Embed, style: t.link },
      { name: OFM.WikilinkMark, style: t.processingInstruction },
      { name: OFM.WikilinkTarget, style: t.link },
      { name: OFM.WikilinkSubpath, style: t.link },
      { name: OFM.WikilinkPipe, style: t.processingInstruction },
      { name: OFM.WikilinkAlias, style: t.link },
      { name: OFM.Tag, style: t.labelName },
      { name: OFM.TagMark, style: t.processingInstruction },
      { name: OFM.Highlight, style: { "Highlight/...": t.special(t.content) } },
      { name: OFM.HighlightMark, style: t.processingInstruction },
      { name: OFM.ObsidianComment, style: t.comment },
      { name: OFM.ObsidianCommentBlock, block: true, style: t.comment },
      { name: OFM.ObsidianCommentMark, style: t.comment },
      { name: OFM.InlineMath, style: t.special(t.string) },
      { name: OFM.DisplayMath, style: t.special(t.string) },
      { name: OFM.MathBlock, block: true, style: t.special(t.string) },
      { name: OFM.MathMark, style: t.processingInstruction },
      { name: OFM.FootnoteRef, style: t.link },
      { name: OFM.InlineFootnote },
      { name: OFM.FootnoteDefinition, block: true },
      { name: OFM.FootnoteMark, style: t.processingInstruction },
      { name: OFM.FootnoteLabel, style: t.labelName },
      { name: OFM.Callout, block: true, composite: calloutComposite, style: t.quote },
      { name: OFM.CalloutHeader, block: true },
      { name: OFM.CalloutMark, style: t.processingInstruction },
      { name: OFM.CalloutType, style: t.keyword },
      { name: OFM.CalloutMeta, style: t.meta },
      { name: OFM.CalloutFold, style: t.processingInstruction },
      { name: OFM.CalloutTitle, style: t.heading },
      { name: OFM.BlockId, style: t.meta },
      { name: OFM.Frontmatter, block: true, style: t.meta },
      { name: OFM.FrontmatterMark, style: t.processingInstruction },
      { name: OFM.FrontmatterContent, style: t.meta },
      { name: OFM.Task, block: true, style: t.list },
      { name: OFM.TaskMarker, style: t.atom },
    ],
    parseBlock: [
      { name: "Frontmatter", parse: parseFrontmatter, before: "LinkReference" },
      { name: "ObsidianCommentBlock", parse: parseCommentBlock, before: "LinkReference" },
      { name: "MathBlock", parse: parseMathBlock, before: "LinkReference" },
      { name: "FootnoteDefinition", parse: parseFootnoteDefinition, before: "LinkReference" },
      { name: "CalloutHeader", parse: parseCalloutHeader, before: "LinkReference" },
      { name: "Callout", parse: parseCallout, before: "Blockquote" },
      {
        name: "TaskList",
        leaf(cx, leaf) {
          return /^\[[^\n\]]\](?:[ \t]|$)/.test(leaf.content) && cx.parentType().name === "ListItem"
            ? new TaskParser()
            : null;
        },
        after: "SetextHeading",
      },
    ],
    parseInline: [
      { name: "ObsidianComment", parse: parseInlineComment, before: "Escape" },
      { name: "InlineMath", parse: parseInlineMath, after: "Escape" },
      { name: "Wikilink", parse: parseWikilink, before: "Link" },
      { name: "FootnoteRef", parse: parseFootnoteRef, before: "Link" },
      { name: "InlineFootnoteStart", parse: parseInlineFootnoteStart, before: "Link" },
      { name: "InlineFootnoteEnd", parse: parseInlineFootnoteEnd, before: "LinkEnd" },
      { name: "BlockId", parse: parseBlockId, after: "InlineFootnoteStart" },
      { name: "Tag", parse: parseTag, after: "Emphasis" },
      { name: "Highlight", parse: parseHighlight, after: "Emphasis" },
    ],
  },
];
