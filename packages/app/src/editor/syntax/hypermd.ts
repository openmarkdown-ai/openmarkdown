/**
 * HyperMD-compatible token and line classes computed from the OFM tree.
 *
 * Themes and plugins style Obsidian's editor through the class names its
 * HyperMD-derived tokenizer emits (`cm-formatting-header-1`,
 * `HyperMD-list-line-2`, `cm-hashtag-begin` …). This module maps the lezer
 * tree to exactly those names:
 *
 *  - span classes are *flat*: one span carries every class that applies at
 *    that position (`cm-formatting cm-formatting-strong cm-strong`), sorted
 *    alphabetically, rather than nested spans per node;
 *  - context classes (`cm-list-N`, `cm-quote cm-quote-N`) are added to every
 *    span inside a list item or quote;
 *  - line classes (`HyperMD-header HyperMD-header-2`) go on `.cm-line`.
 *
 * `computeTokens` returns plain data for a document window so it can be
 * unit-tested without a view; highlight.ts turns it into decorations.
 */
import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import type { SyntaxNode, Tree } from "@lezer/common";
import { OFM } from "./ofm";

/** The subset of `Text` the tokenizer reads (so it can run over a slice of the document). */
export interface DocLike {
  readonly length: number;
  lineAt(pos: number): { from: number; to: number; number: number; text: string };
  line(n: number): { from: number; to: number; number: number; text: string };
  sliceString(from: number, to?: number): string;
}

export interface TokenSpan {
  from: number;
  to: number;
  /** Class names without the `cm-` prefix, sorted, de-duplicated. */
  classes: string[];
}

export interface LineInfo {
  classes: Set<string>;
  attrs?: Record<string, string>;
}

export interface TokenResult {
  spans: TokenSpan[];
  /** 1-based line number → classes (no prefix; these are used verbatim). */
  lines: Map<number, LineInfo>;
}

/** CM5-style token names for nested code (Obsidian's code blocks use CM5 modes). */
export const codeHighlighter = tagHighlighter([
  { tag: t.keyword, class: "keyword" },
  { tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], class: "keyword" },
  { tag: [t.atom, t.bool, t.null], class: "atom" },
  { tag: [t.number, t.integer, t.float], class: "number" },
  { tag: [t.definition(t.variableName), t.function(t.definition(t.variableName))], class: "def" },
  { tag: t.variableName, class: "variable" },
  { tag: [t.local(t.variableName), t.special(t.variableName)], class: "variable-2" },
  { tag: [t.typeName, t.className, t.namespace], class: "type" },
  { tag: [t.propertyName, t.definition(t.propertyName)], class: "property" },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.compareOperator], class: "operator" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "comment" },
  { tag: [t.string, t.docString, t.character, t.attributeValue], class: "string" },
  { tag: [t.special(t.string), t.regexp, t.escape, t.url], class: "string-2" },
  { tag: [t.meta, t.documentMeta, t.annotation, t.processingInstruction], class: "meta" },
  { tag: [t.standard(t.variableName), t.standard(t.tagName)], class: "builtin" },
  { tag: [t.bracket, t.angleBracket, t.squareBracket, t.paren, t.brace], class: "bracket" },
  { tag: t.tagName, class: "tag" },
  { tag: t.attributeName, class: "attribute" },
  { tag: [t.labelName, t.macroName], class: "qualifier" },
  { tag: t.punctuation, class: "punctuation" },
  { tag: t.heading, class: "header" },
  { tag: t.strong, class: "strong" },
  { tag: t.emphasis, class: "em" },
  { tag: t.link, class: "link" },
  { tag: t.invalid, class: "error" },
  { tag: [t.inserted], class: "positive" },
  { tag: [t.deleted], class: "negative" },
]);

interface Ctx {
  doc: DocLike;
  winFrom: number;
  winTo: number;
  /** `override` spans replace (rather than add to) the classes of spans they overlap. */
  raw: { from: number; to: number; classes: string[]; override?: boolean }[];
  lines: Map<number, LineInfo>;
  livePreview: boolean;
  listDepth: number;
  quoteDepth: number;
}

function lineInfo(ctx: Ctx, n: number): LineInfo {
  let info = ctx.lines.get(n);
  if (!info) ctx.lines.set(n, (info = { classes: new Set() }));
  return info;
}

function addLineClasses(ctx: Ctx, from: number, to: number, classes: string[], firstOnly = false) {
  const first = ctx.doc.lineAt(Math.max(from, 0)).number;
  const last = firstOnly ? first : ctx.doc.lineAt(Math.min(to, ctx.doc.length)).number;
  const vFirst = ctx.doc.lineAt(ctx.winFrom).number;
  const vLast = ctx.doc.lineAt(ctx.winTo).number;
  for (let n = Math.max(first, vFirst); n <= Math.min(last, vLast); n++) {
    const info = lineInfo(ctx, n);
    for (const c of classes) info.classes.add(c);
  }
}

function removeLineClasses(ctx: Ctx, from: number, to: number, re: RegExp) {
  const first = ctx.doc.lineAt(from).number, last = ctx.doc.lineAt(to).number;
  for (let n = first; n <= last; n++) {
    const info = ctx.lines.get(n);
    if (info) for (const c of [...info.classes]) if (re.test(c)) info.classes.delete(c);
  }
}

function emit(ctx: Ctx, from: number, to: number, classes: readonly string[], override = false) {
  if (!classes.length) return;
  from = Math.max(from, ctx.winFrom);
  to = Math.min(to, ctx.winTo);
  if (from >= to) return;
  ctx.raw.push({ from, to, classes: classes as string[], override });
}

const withoutContext = (cls: string[], re: RegExp) => cls.filter((c) => !re.test(c));

function outside(ctx: Ctx, node: { from: number; to: number }) {
  return node.to < ctx.winFrom || node.from > ctx.winTo;
}

/** Walk children, emitting `cls` for the gaps and recursing into children. */
function walkChildren(ctx: Ctx, node: SyntaxNode, cls: string[], childCls?: (child: SyntaxNode, index: number) => string[] | null) {
  let pos = node.from;
  let i = 0;
  for (let child = node.firstChild; child; child = child.nextSibling, i++) {
    if (child.from > pos) emit(ctx, pos, child.from, cls);
    if (!outside(ctx, child)) {
      const special = childCls?.(child, i);
      if (special) walk(ctx, child, special, true);
      else walk(ctx, child, cls);
    }
    pos = Math.max(pos, child.to);
  }
  if (pos < node.to) emit(ctx, pos, node.to, cls);
}

function listClass(depth: number) {
  return `list-${((depth - 1) % 3) + 1}`;
}

function tagClassName(body: string) {
  return "tag-" + body.replace(/[^_a-zA-Z0-9-]/g, "");
}

const HEADING_LEVEL: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

function skipSpaces(doc: DocLike, pos: number, limit: number) {
  while (pos < limit) {
    const ch = doc.sliceString(pos, pos + 1);
    if (ch !== " " && ch !== "\t") break;
    pos++;
  }
  return pos;
}

/**
 * Walk a node. `cls` is the inherited class list; when `exact` is true the
 * list is used as-is (a parent computed it), otherwise the node's own classes
 * are added.
 */
function walk(ctx: Ctx, node: SyntaxNode, inherited: string[], exact = false): void {
  const name = node.name;
  const doc = ctx.doc;
  if (exact) {
    // Leaf-ish nodes given explicit classes by a parent: still descend so
    // nested inline markup (e.g. emphasis inside a callout title) gets its classes.
    if (node.firstChild) walkChildren(ctx, node, inherited);
    else emit(ctx, node.from, node.to, inherited);
    return;
  }
  const level = HEADING_LEVEL[name];
  if (level !== undefined) {
    const h = [...inherited, "header", `header-${level}`];
    const setext = name.startsWith("Setext");
    if (setext) {
      const underline = node.lastChild;
      if (underline && underline.name === "HeaderMark") {
        addLineClasses(ctx, node.from, underline.from - 1, ["HyperMD-header", `HyperMD-header-${level}`]);
      }
    } else {
      addLineClasses(ctx, node.from, node.from, ["HyperMD-header", `HyperMD-header-${level}`]);
    }
    let pos = node.from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "HeaderMark") {
        if (child.from > pos) emit(ctx, pos, child.from, h);
        // The formatting span includes the space after a leading `#`.
        const end = !setext && child.from === node.from ? skipSpaces(doc, child.to, node.to) : child.to;
        const f = setext
          ? [...inherited, "formatting", "formatting-header", `formatting-header-${level}`, "header", `header-${level}`]
          : [...h, "formatting", "formatting-header", `formatting-header-${level}`];
        // A trailing closing sequence also includes the space before it.
        const start = !setext && child.from !== node.from ? backSpaces(doc, child.from, pos) : child.from;
        if (start > pos) emit(ctx, pos, start, h);
        emit(ctx, Math.max(start, pos), end, f);
        pos = end;
      } else {
        if (child.from > pos) emit(ctx, pos, child.from, h);
        if (!outside(ctx, child)) walk(ctx, child, h);
        pos = Math.max(pos, child.to);
      }
    }
    if (pos < node.to) emit(ctx, pos, node.to, h);
    return;
  }

  switch (name) {
    case "Document": {
      // Only the top-level blocks overlapping the window (the tree is balanced, so this is logarithmic).
      let child = node.childAfter(Math.max(0, ctx.winFrom - 1));
      while (child && child.from > ctx.winFrom && child.prevSibling) {
        if (child.prevSibling.to < ctx.winFrom) break;
        child = child.prevSibling;
      }
      for (; child && child.from <= ctx.winTo; child = child.nextSibling) {
        if (!outside(ctx, child)) walk(ctx, child, inherited);
      }
      return;
    }
    case "Paragraph":
    case "BulletList":
    case "OrderedList":
    case "HTMLBlock":
    case "CalloutTitle":
      walkChildren(ctx, node, inherited);
      return;

    case "Emphasis":
    case "StrongEmphasis":
    case "Strikethrough":
    case OFM.Highlight:
    case "InlineCode": {
      const own =
        name === "Emphasis" ? "em" : name === "StrongEmphasis" ? "strong" : name === "Strikethrough" ? "strikethrough" : name === "InlineCode" ? "inline-code" : "highlight";
      const fmt =
        name === "Emphasis" ? "formatting-em" : name === "StrongEmphasis" ? "formatting-strong" : name === "Strikethrough" ? "formatting-strikethrough" : name === "InlineCode" ? "formatting-code" : "formatting-highlight";
      const cls = [...inherited, own];
      walkChildren(ctx, node, cls, (child) =>
        child.name === "EmphasisMark" || child.name === "StrikethroughMark" || child.name === OFM.HighlightMark || child.name === "CodeMark"
          ? [...cls, "formatting", fmt]
          : null,
      );
      return;
    }

    case "Link":
    case "Image": {
      const image = name === "Image";
      let marks = 0;
      let pos = node.from;
      const textCls = image ? [...inherited, "image", "image-alt-text", "link"] : [...inherited, "link"];
      const urlCls = [...inherited, "string", "url"];
      for (let child = node.firstChild; child; child = child.nextSibling) {
        const cur = marks >= 2 ? urlCls : textCls;
        if (child.from > pos) emit(ctx, pos, child.from, cur);
        if (child.name === "LinkMark") {
          marks++;
          if (marks === 1 && image) {
            emit(ctx, child.from, child.from + 1, [...inherited, "formatting", "formatting-image", "image", "image-marker"]);
            emit(ctx, child.from + 1, child.to, [...textCls, "formatting", "formatting-image"]);
          } else if (marks <= 2) {
            emit(ctx, child.from, child.to, image ? [...textCls, "formatting", "formatting-image"] : [...textCls, "formatting", "formatting-link"]);
          } else {
            emit(ctx, child.from, child.to, [...urlCls, "formatting", "formatting-link-string"]);
          }
        } else if (child.name === "URL" || child.name === "LinkTitle" || child.name === "LinkLabel") {
          emit(ctx, child.from, child.to, marks >= 2 ? urlCls : textCls);
        } else if (!outside(ctx, child)) {
          walk(ctx, child, cur);
        }
        pos = Math.max(pos, child.to);
      }
      if (pos < node.to) emit(ctx, pos, node.to, marks >= 2 ? urlCls : textCls);
      return;
    }

    case "URL":
      emit(ctx, node.from, node.to, [...inherited, "url"]);
      return;
    case "Autolink":
      walkChildren(ctx, node, [...inherited, "url"], (child) =>
        child.name === "LinkMark" ? [...inherited, "formatting", "formatting-link-string", "string", "url"] : null,
      );
      return;

    case OFM.Wikilink:
    case OFM.Embed: {
      const embed = name === OFM.Embed;
      const hasAlias = !!node.getChild(OFM.WikilinkPipe);
      const base = embed ? [...inherited, "hmd-embed"] : inherited;
      let first = true;
      walkChildren(ctx, node, [...base, "hmd-internal-link"], (child) => {
        switch (child.name) {
          case OFM.WikilinkMark: {
            const isStart = first;
            first = false;
            return isStart
              ? [...inherited, "formatting-link", "formatting-link-start", ...(embed ? ["formatting-embed"] : [])]
              : [...inherited, "formatting-link", "formatting-link-end", ...(embed ? ["formatting-embed"] : [])];
          }
          case OFM.WikilinkTarget:
          case OFM.WikilinkSubpath:
            return [...base, "hmd-internal-link", ...(hasAlias ? ["link-has-alias"] : [])];
          case OFM.WikilinkPipe:
            return [...base, "hmd-internal-link", "link-alias-pipe"];
          case OFM.WikilinkAlias:
            return [...base, "hmd-internal-link", "link-alias"];
        }
        return null;
      });
      return;
    }

    case OFM.Tag: {
      const body = doc.sliceString(node.from + 1, node.to);
      const common = [...inherited, "hashtag", "meta", tagClassName(body)];
      emit(ctx, node.from, node.from + 1, [...common, "formatting", "formatting-hashtag", "hashtag-begin"]);
      emit(ctx, node.from + 1, node.to, [...common, "hashtag-end"]);
      return;
    }

    case OFM.ObsidianComment:
    case OFM.ObsidianCommentBlock: {
      const cls = [...inherited, "comment"];
      const first = node.firstChild;
      walkChildren(ctx, node, cls, (child) =>
        child.name === OFM.ObsidianCommentMark
          ? [...cls, "formatting", child.from === first?.from ? "comment-start" : "comment-end"]
          : child.name === "QuoteMark"
            ? null
            : cls,
      );
      return;
    }

    case OFM.InlineMath:
    case OFM.DisplayMath:
    case OFM.MathBlock: {
      const cls = [...inherited, "math"];
      const first = node.firstChild;
      const block = name !== OFM.InlineMath;
      walkChildren(ctx, node, cls, (child) => {
        if (child.name !== OFM.MathMark) return null;
        const begin = child.from === first?.from;
        return [
          ...cls,
          "formatting",
          "formatting-math",
          begin ? "formatting-math-begin" : "formatting-math-end",
          "keyword",
        ];
      });
      return;
    }

    case OFM.FootnoteRef: {
      const cls = [...inherited, "footref", "hmd-barelink"];
      let first = true;
      walkChildren(ctx, node, cls, (child) => {
        if (child.name !== OFM.FootnoteMark) return null;
        const start = first;
        first = false;
        return [...cls, "formatting", "formatting-link", start ? "formatting-link-start" : "formatting-link-end"];
      });
      return;
    }

    case OFM.InlineFootnote: {
      const cls = [...inherited, "footref", "inline-footnote"];
      let first = true;
      walkChildren(ctx, node, cls, (child) => {
        if (child.name !== OFM.FootnoteMark) return null;
        const start = first;
        first = false;
        return [...cls, "formatting-inline-footnote", start ? "inline-footnote-start" : "inline-footnote-end"];
      });
      return;
    }

    case OFM.FootnoteDefinition: {
      addLineClasses(ctx, node.from, node.to, ["HyperMD-footnote"]);
      walkChildren(ctx, node, inherited, (child) => {
        if (child.name === OFM.FootnoteMark) return [...inherited, "formatting", "formatting-link", "hmd-barelink", "hmd-footnote", "link"];
        if (child.name === OFM.FootnoteLabel) return [...inherited, "hmd-barelink", "hmd-footnote", "link"];
        return null;
      });
      return;
    }

    case OFM.BlockId:
      emit(ctx, node.from, node.to, [...inherited, "blockid"]);
      return;

    case "Escape":
      emit(ctx, node.from, node.from + 1, [...inherited, "formatting-escape", "hmd-escape-backslash"]);
      emit(ctx, node.from + 1, node.to, [...inherited, "escape", "hmd-escape-char"]);
      return;

    case "HTMLTag":
    case "Comment": {
      emit(ctx, node.from, node.from + 1, [...inherited, "bracket", "hmd-html-begin", "tag"]);
      emit(ctx, node.from + 1, node.to - 1, [...inherited, "tag"]);
      emit(ctx, node.to - 1, node.to, [...inherited, "bracket", "hmd-html-end", "tag"]);
      return;
    }

    case "HorizontalRule":
      addLineClasses(ctx, node.from, node.from, ["HyperMD-hr", "HyperMD-hr-bg"]);
      emit(ctx, node.from, node.to, [...inherited, "hr"]);
      return;

    case "Blockquote":
    case OFM.Callout: {
      ctx.quoteDepth++;
      const depth = ctx.quoteDepth;
      const q = [...withoutContext(inherited, /^quote(-\d+)?$/), "quote", `quote-${depth}`];
      removeLineClasses(ctx, node.from, node.to, /^HyperMD-quote-\d+$/);
      addLineClasses(ctx, node.from, node.to, ["HyperMD-quote", `HyperMD-quote-${depth}`]);
      // Lazy continuation lines (no `>` of their own).
      markLazyQuoteLines(ctx, node);
      if (name === OFM.Callout) addLineClasses(ctx, node.from, node.from, ["HyperMD-callout"], true);
      let pos = node.from;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.from > pos) emit(ctx, pos, child.from, q);
        if (child.name === "QuoteMark") {
          const next = child.nextSibling;
          const fmt = [...q, "formatting", "formatting-quote", `formatting-quote-${depth}`];
          if (next && next.name === OFM.CalloutHeader && name === OFM.Callout && child.from === node.from) {
            // `> [!tip]- ` is one span.
            const title = next.getChild(OFM.CalloutTitle);
            const end = title ? title.from : next.to;
            emit(ctx, child.from, end, [...fmt, "hmd-callout"]);
            if (title && !outside(ctx, title)) walk(ctx, title, q);
            pos = next.to;
            child = next;
            continue;
          }
          let end = child.to;
          if (doc.sliceString(end, end + 1) === " ") end++;
          emit(ctx, child.from, end, fmt);
          const indentEnd = skipSpaces(doc, end, lineEndAt(doc, end));
          const nx = child.nextSibling;
          if (indentEnd > end && (!nx || nx.from >= indentEnd)) {
            emit(ctx, end, indentEnd, [...q, "hmd-indent-in-quote"]);
            end = indentEnd;
          }
          pos = end;
        } else {
          if (!outside(ctx, child)) walk(ctx, child, q);
          pos = Math.max(pos, child.to);
        }
      }
      if (pos < node.to) emit(ctx, pos, node.to, q);
      ctx.quoteDepth--;
      return;
    }

    case "ListItem": {
      ctx.listDepth++;
      const depth = ctx.listDepth;
      const lc = listClass(depth);
      inherited = withoutContext(inherited, /^list-\d$/);
      const cls = [...inherited, lc];
      const firstLine = doc.lineAt(node.from).number;
      removeLineClasses(ctx, node.from, node.from, /^HyperMD-list-line/);
      addLineClasses(ctx, node.from, node.from, ["HyperMD-list-line", `HyperMD-list-line-${depth}`]);
      const lastLine = doc.lineAt(node.to).number;
      for (let n = firstLine + 1; n <= lastLine; n++) {
        if (n < doc.lineAt(ctx.winFrom).number || n > doc.lineAt(ctx.winTo).number) continue;
        const line = doc.line(n);
        if (!line.text.trim()) continue;
        const info = lineInfo(ctx, n);
        // Deeper items overwrite this later (they are walked after).
        for (const c of [...info.classes]) if (c.startsWith("HyperMD-list-line")) info.classes.delete(c);
        info.classes.add("HyperMD-list-line");
        info.classes.add("HyperMD-list-line-nobullet");
        info.classes.add(`HyperMD-list-line-${depth}`);
      }
      // Leading indentation of the bullet line.
      const bulletLine = doc.lineAt(node.from);
      if (node.from > bulletLine.from && /^[ \t]+$/.test(doc.sliceString(bulletLine.from, node.from))) {
        emit(ctx, bulletLine.from, node.from, [...inherited, "hmd-list-indent", `hmd-list-indent-${depth - 1}`], true);
      }
      const mark = node.firstChild;
      const task = mark?.nextSibling?.name === OFM.Task ? mark.nextSibling : null;
      if (task) {
        const tm = task.firstChild;
        if (tm && tm.name === OFM.TaskMarker) {
          const ch = doc.sliceString(tm.from + 1, tm.from + 2);
          addLineClasses(ctx, node.from, node.from, ["HyperMD-task-line"]);
          if (ctx.livePreview) lineInfo(ctx, firstLine).attrs = { "data-task": ch };
        }
      }
      let pos = node.from;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.from > pos) emit(ctx, pos, child.from, cls);
        if (child.name === "ListMark") {
          const ordered = node.parent?.name === "OrderedList";
          const end = Math.min(skipOneSpace(doc, child.to), node.to);
          emit(ctx, child.from, end, [...cls, "formatting", "formatting-list", ordered ? "formatting-list-ol" : "formatting-list-ul"]);
          pos = end;
          continue;
        }
        if (child.name === OFM.Task) {
          let tpos = Math.max(pos, child.from);
          for (let tc = child.firstChild; tc; tc = tc.nextSibling) {
            if (tc.from > tpos) emit(ctx, tpos, tc.from, cls);
            if (tc.name === OFM.TaskMarker) {
              const ch = doc.sliceString(tc.from + 1, tc.from + 2);
              emit(ctx, tc.from, tc.to, [...inherited, "formatting", "formatting-task", ch === " " ? "meta" : "property"]);
            } else if (!outside(ctx, tc)) walk(ctx, tc, cls);
            tpos = Math.max(tpos, tc.to);
          }
          if (tpos < child.to) emit(ctx, tpos, child.to, cls);
          pos = Math.max(pos, child.to);
          continue;
        }
        if (child.name === "FencedCode" || child.name === "CodeBlock") {
          // Code inside a list keeps the list-line classes without a depth.
          const nFirst = doc.lineAt(child.from).number, nLast = doc.lineAt(child.to).number;
          for (let n = nFirst; n <= nLast; n++) {
            const info = ctx.lines.get(n);
            if (info) info.classes.delete(`HyperMD-list-line-${depth}`);
          }
        }
        // Indentation of continuation lines inside this item.
        emitContinuationIndent(ctx, child, depth, inherited);
        if (!outside(ctx, child)) walk(ctx, child, cls);
        pos = Math.max(pos, child.to);
      }
      if (pos < node.to) emit(ctx, pos, node.to, cls);
      ctx.listDepth--;
      return;
    }

    case "FencedCode": {
      const cls = [...inherited, "hmd-codeblock"];
      const firstLine = doc.lineAt(node.from);
      const lastLine = doc.lineAt(node.to);
      addLineClasses(ctx, node.from, node.to, ["HyperMD-codeblock", "HyperMD-codeblock-bg"]);
      addLineClasses(ctx, node.from, node.from, ["HyperMD-codeblock-begin", "HyperMD-codeblock-begin-bg"]);
      const marks = node.getChildren("CodeMark");
      const closed = marks.length > 1;
      if (closed) addLineClasses(ctx, lastLine.from, lastLine.from, ["HyperMD-codeblock-end", "HyperMD-codeblock-end-bg"]);
      if (ctx.listDepth > 0) addLineClasses(ctx, node.from, node.to, ["HyperMD-list-line", "HyperMD-list-line-nobullet"]);
      const fence = [...cls, "formatting", "formatting-code-block"];
      const openEnd = firstLine.to;
      emit(ctx, node.from, Math.min(openEnd, node.to), fence);
      let pos = Math.min(openEnd, node.to);
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.to <= pos) continue;
        if (child.name === "CodeMark" && closed && child.from >= lastLine.from) {
          if (child.from > pos) emit(ctx, pos, child.from, cls);
          emit(ctx, child.from, lastLine.to, fence);
          pos = lastLine.to;
        } else if (child.name === "QuoteMark") {
          if (child.from > pos) emit(ctx, pos, child.from, cls);
          walk(ctx, child, inherited);
          pos = child.to;
        }
      }
      if (pos < node.to) emit(ctx, pos, node.to, cls);
      // Nested language tokens, merged into the flat spans later.
      const from = Math.max(firstLine.to, ctx.winFrom), to = Math.min(closed ? lastLine.from : node.to, ctx.winTo);
      if (from < to && node.getChild("CodeText")) {
        highlightTree(
          node.tree ?? (node as unknown as { toTree(): Tree }).toTree(),
          codeHighlighter,
          (f, tt, c) => {
            const a = Math.max(f + node.from, from), b = Math.min(tt + node.from, to);
            if (a < b && c) ctx.raw.push({ from: a, to: b, classes: c.split(" ") });
          },
          from - node.from,
          to - node.from,
        );
      }
      return;
    }

    case "CodeBlock":
      emit(ctx, node.from, node.to, [...inherited, "hmd-indented-code", "inline-code"]);
      return;

    case OFM.Frontmatter: {
      walkChildren(ctx, node, inherited, (child) => {
        if (child.name === OFM.FrontmatterMark) return [...inherited, "def", "hmd-frontmatter"];
        return null;
      });
      return;
    }
    case OFM.FrontmatterContent:
      yamlTokens(ctx, node.from, node.to, inherited);
      return;

    case "Table": {
      const header = node.firstChild;
      const headerText = header ? doc.sliceString(header.from, header.to) : "";
      const tableKind = headerText.trimStart().startsWith("|") ? "HyperMD-table-2" : "HyperMD-table-1";
      let row = 0;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        const r = row++;
        addLineClasses(ctx, child.from, child.from, [tableKind, "HyperMD-table-row", `HyperMD-table-row-${r}`]);
        if (outside(ctx, child)) continue;
        if (child.name === "TableDelimiter") tableSeparators(ctx, child.from, child.to, inherited);
        else walkTableRow(ctx, child, inherited);
      }
      return;
    }

    case "LinkReference":
      walkChildren(ctx, node, inherited, (child) =>
        child.name === "LinkLabel" ? [...inherited, "link"] : child.name === "URL" || child.name === "LinkTitle" ? [...inherited, "string", "url"] : null,
      );
      return;

    case "QuoteMark": {
      // A marker belonging to an outer container, seen inside a nested block.
      let end = node.to;
      if (doc.sliceString(end, end + 1) === " ") end++;
      emit(ctx, node.from, end, [...inherited, "formatting", "formatting-quote", `formatting-quote-${Math.max(ctx.quoteDepth, 1)}`, "quote", `quote-${Math.max(ctx.quoteDepth, 1)}`]);
      return;
    }

    default:
      if (node.firstChild) walkChildren(ctx, node, inherited);
      else emit(ctx, node.from, node.to, inherited);
  }
}

function backSpaces(doc: DocLike, pos: number, limit: number) {
  while (pos > limit) {
    const ch = doc.sliceString(pos - 1, pos);
    if (ch !== " " && ch !== "\t") break;
    pos--;
  }
  return pos;
}

function skipOneSpace(doc: DocLike, pos: number) {
  const ch = doc.sliceString(pos, pos + 1);
  return ch === " " || ch === "\t" ? pos + 1 : pos;
}

function lineEndAt(doc: DocLike, pos: number) {
  return doc.lineAt(pos).to;
}

function markLazyQuoteLines(ctx: Ctx, node: SyntaxNode) {
  const doc = ctx.doc;
  const vFirst = doc.lineAt(ctx.winFrom).number, vLast = doc.lineAt(ctx.winTo).number;
  const first = Math.max(doc.lineAt(node.from).number + 1, vFirst);
  const last = Math.min(doc.lineAt(node.to).number, vLast);
  for (let n = first; n <= last; n++) {
    if (!/^[ \t]*>/.test(doc.line(n).text)) lineInfo(ctx, n).classes.add("HyperMD-quote-lazy");
  }
}

function emitContinuationIndent(ctx: Ctx, child: SyntaxNode, depth: number, inherited: string[]) {
  if (child.name === "BulletList" || child.name === "OrderedList") return;
  const doc = ctx.doc;
  const firstLine = doc.lineAt(child.from);
  if (child.from > firstLine.from) {
    const lead = doc.sliceString(firstLine.from, child.from);
    if (/^[ \t]+$/.test(lead)) {
      emit(ctx, firstLine.from, child.from, [...withoutContext(inherited, /^list-\d$/), "hmd-list-indent", `hmd-list-indent-${depth}`], true);
    }
  }
}

function tableSeparators(ctx: Ctx, from: number, to: number, inherited: string[]) {
  const text = ctx.doc.sliceString(from, to);
  const trimmedStart = text.length - text.trimStart().length;
  const trimmedEnd = text.trimEnd().length;
  let col = 0;
  let pos = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "|" || (i > 0 && text[i - 1] === "\\")) continue;
    if (i > pos) emit(ctx, from + pos, from + i, inherited);
    const outer = i === trimmedStart || i === trimmedEnd - 1;
    emit(ctx, from + i, from + i + 1, [...inherited, "hmd-table-sep", outer ? "hmd-table-sep-dummy" : `hmd-table-sep-${col}`]);
    if (!outer || i !== trimmedStart) col++;
    pos = i + 1;
  }
  if (pos < text.length) emit(ctx, from + pos, to, inherited);
}

function walkTableRow(ctx: Ctx, row: SyntaxNode, inherited: string[]) {
  const doc = ctx.doc;
  const text = doc.sliceString(row.from, row.to);
  const trimmedStart = text.length - text.trimStart().length;
  const trimmedEnd = text.trimEnd().length;
  let pos = row.from;
  let col = 0;
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.from > pos) emit(ctx, pos, child.from, inherited);
    if (child.name === "TableDelimiter") {
      const i = child.from - row.from;
      const outer = i === trimmedStart || i === trimmedEnd - 1;
      emit(ctx, child.from, child.to, [...inherited, "hmd-table-sep", outer ? "hmd-table-sep-dummy" : `hmd-table-sep-${col}`]);
      if (!outer) col++;
    } else if (!outside(ctx, child)) {
      walk(ctx, child, inherited);
    }
    pos = Math.max(pos, child.to);
  }
  if (pos < row.to) emit(ctx, pos, row.to, inherited);
}

function yamlTokens(ctx: Ctx, from: number, to: number, inherited: string[]) {
  const doc = ctx.doc;
  const fm = [...inherited, "hmd-frontmatter"];
  let lineStart = from;
  while (lineStart <= to) {
    const line = doc.lineAt(lineStart);
    const end = Math.min(line.to, to);
    if (line.to >= ctx.winFrom && line.from <= ctx.winTo) {
      const text = doc.sliceString(line.from, end);
      const m = /^(\s*)(-\s+)?([^:#\s][^:#]*?)(\s*:)(\s|$)/.exec(text);
      const comment = /^\s*#/.exec(text);
      if (comment) emit(ctx, line.from, end, [...fm, "comment"]);
      else if (m) {
        let p = line.from + m[1]!.length;
        if (m[2]) {
          emit(ctx, p, p + m[2].length, [...fm, "meta"]);
          p += m[2].length;
        }
        emit(ctx, p, p + m[3]!.length, [...fm, "atom"]);
        p += m[3]!.length;
        emit(ctx, p, p + m[4]!.length + m[5]!.length, [...fm, "meta"]);
        p += m[4]!.length + m[5]!.length;
        valueTokens(ctx, p, end, fm);
      } else {
        const dash = /^(\s*)(-\s+)/.exec(text);
        let p = line.from;
        if (dash) {
          emit(ctx, line.from + dash[1]!.length, line.from + dash[0].length, [...fm, "meta"]);
          p = line.from + dash[0].length;
        }
        valueTokens(ctx, p, end, fm);
      }
    }
    if (line.to >= to) break;
    lineStart = line.to + 1;
  }
}

function valueTokens(ctx: Ctx, from: number, to: number, fm: string[]) {
  if (from >= to) return;
  const text = ctx.doc.sliceString(from, to);
  let last = 0;
  const re = /[\[\],{}]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) emit(ctx, from + last, from + m.index, fm);
    emit(ctx, from + m.index, from + m.index + 1, [...fm, "meta"]);
    last = m.index + 1;
  }
  if (last < text.length) emit(ctx, from + last, to, fm);
}

/** Merge overlapping raw spans into flat, sorted, de-duplicated class spans. */
function flatten(raw: Ctx["raw"]): TokenSpan[] {
  if (!raw.length) return [];
  const points = new Set<number>();
  for (const r of raw) {
    points.add(r.from);
    points.add(r.to);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const byStart = raw.slice().sort((a, b) => a.from - b.from);
  const out: TokenSpan[] = [];
  let active: Ctx["raw"] = [];
  let k = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!, b = sorted[i + 1]!;
    while (k < byStart.length && byStart[k]!.from <= a) active.push(byStart[k++]!);
    active = active.filter((r) => r.to > a);
    if (!active.length) continue;
    const set = new Set<string>();
    const overriding = active.some((r) => r.override);
    for (const r of active) if (!overriding || r.override) for (const c of r.classes) set.add(c);
    const classes = [...set].sort();
    const prev = out[out.length - 1];
    if (prev && prev.to === a && prev.classes.join(" ") === classes.join(" ")) prev.to = b;
    else out.push({ from: a, to: b, classes });
  }
  return out;
}

export function computeTokens(tree: Tree, doc: DocLike, from: number, to: number, livePreview: boolean): TokenResult {
  const ctx: Ctx = {
    doc,
    winFrom: from,
    winTo: to,
    raw: [],
    lines: new Map(),
    livePreview,
    listDepth: 0,
    quoteDepth: 0,
  };
  walk(ctx, tree.topNode, []);
  return { spans: flatten(ctx.raw), lines: ctx.lines };
}

/** Tokens of one top-level block node (the window is the node itself). */
export function computeNodeTokens(node: SyntaxNode, doc: DocLike): TokenResult {
  const ctx: Ctx = {
    doc,
    winFrom: node.from,
    winTo: node.to,
    raw: [],
    lines: new Map(),
    livePreview: false,
    listDepth: 0,
    quoteDepth: 0,
  };
  walk(ctx, node, []);
  return { spans: flatten(ctx.raw), lines: ctx.lines };
}
