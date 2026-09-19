/**
 * Live Preview block widgets: callouts, tables, math blocks, standalone
 * embeds, horizontal rules, rendered code blocks (mermaid and plugin code
 * block processors), HTML blocks, and frontmatter.
 *
 * Block decorations change vertical layout, so CM6 requires them to come
 * from a StateField. The field keeps the list of candidate blocks (rebuilt
 * when the tree or config changes) and filters it against the reveal
 * selection on every selection change, which is cheap.
 */
import { RangeSetBuilder, StateField } from "@codemirror/state";
import type { EditorState, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { Tree } from "@lezer/common";
import type { SyntaxNode } from "@lezer/common";
import { OFM } from "../syntax/ofm";
import { ofmTree } from "../syntax/language";
import { editorLivePreviewField } from "../fields";
import { configFacet, hostFacet, sourcePathOf } from "../facets";
import { revealSelectionField, selectionOnLines, selectionTouches } from "./reveal";
import { EmbedWidget, ExternalImageWidget, HrWidget, MathWidget, RenderedBlockWidget, TableWidget } from "./widgets";

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The language of a fenced code block rendered as a widget (mermaid, or a registered processor), else null. */
export function codeProcessorLang(state: EditorState, node: SyntaxNode): string | null {
  if (node.name !== "FencedCode") return null;
  const info = node.getChild("CodeInfo");
  if (!info) return null;
  const lang = state.doc.sliceString(info.from, info.to).split(/\s/)[0]!.toLowerCase();
  if (!lang) return null;
  if (node.getChildren("CodeMark").length < 2) return null; // unclosed: keep editing it as text
  const host = state.facet(hostFacet);
  if (lang === "mermaid" || host?.hasCodeBlockProcessor?.(lang)) return lang;
  return null;
}

/** True when an Embed/Image node is the only thing on its line (rendered as a block). */
export function isBlockLevelEmbedLine(state: EditorState, node: SyntaxNode): boolean {
  const line = state.doc.lineAt(node.from);
  if (line.number !== state.doc.lineAt(node.to).number) return false;
  const parent = node.parent;
  if (!parent || parent.name !== "Paragraph") return false;
  if (parent.parent && parent.parent.name !== "Document") return false;
  return line.text.trim() === state.doc.sliceString(node.from, node.to);
}

type BlockKind = "frontmatter" | "callout" | "table" | "math" | "embed" | "hr" | "code" | "html";

interface BlockSpec {
  kind: BlockKind;
  from: number; // start of first line
  to: number; // end of last line
  /** Range the selection must touch to reveal the source. */
  revealFrom: number;
  revealTo: number;
  /** Reveal when the selection is on any line of the block rather than touching it. */
  byLine?: boolean;
  /** When revealed, keep the widget and show it below the source (images). */
  keepBelow?: boolean;
  /** Never reveal (frontmatter). */
  sticky?: boolean;
  widget: WidgetType | null;
  /** Position-independent decorations, created once per cached spec. */
  replace?: Decoration;
  below?: Decoration;
}

interface BlockState {
  tree: Tree;
  specs: BlockSpec[];
  decorations: DecorationSet;
  cache: SpecCache;
}

type SpecCache = WeakMap<object, BlockSpec[]>;

/**
 * Candidate blocks for the whole document. Lezer reuses the subtree object of
 * every top-level block an edit did not touch, so specs are cached per subtree
 * (with positions relative to it) and only changed blocks are re-examined.
 */
function collect(state: EditorState, cache: SpecCache): BlockSpec[] {
  const lp = state.field(editorLivePreviewField, false);
  if (!lp) return [];
  const tree = ofmTree(state);
  const specs: BlockSpec[] = [];
  const visit = (t: Tree, offset: number) => {
    for (let i = 0; i < t.children.length; i++) {
      const child = t.children[i]!;
      const pos = offset + t.positions[i]!;
      if (child instanceof Tree && child.type.isAnonymous) {
        visit(child, pos);
        continue;
      }
      let rel = child instanceof Tree ? cache.get(child) : undefined;
      if (!rel) {
        const node = tree.topNode.childAfter(pos);
        const abs = node && node.from === pos ? specsForTopNode(state, node) : [];
        rel = abs.map((s) => ({
          ...s,
          from: s.from - pos,
          to: s.to - pos,
          revealFrom: s.revealFrom - pos,
          revealTo: s.revealTo - pos,
          replace: s.widget ? Decoration.replace({ widget: s.widget, block: true }) : undefined,
          below: s.widget && s.keepBelow ? Decoration.widget({ widget: s.widget, block: true, side: 1 }) : undefined,
        }));
        if (child instanceof Tree) cache.set(child, rel);
      }
      for (const s of rel) specs.push({ ...s, from: s.from + pos, to: s.to + pos, revealFrom: s.revealFrom + pos, revealTo: s.revealTo + pos });
    }
  };
  visit(tree, 0);
  return specs;
}

function specsForTopNode(state: EditorState, node: SyntaxNode): BlockSpec[] {
  const host = state.facet(hostFacet);
  const config = state.facet(configFacet);
  const sourcePath = sourcePathOf(host);
  const doc = state.doc;
  const specs: BlockSpec[] = [];
  const lineRange = (n: { from: number; to: number }) => ({ from: doc.lineAt(n.from).from, to: doc.lineAt(n.to).to });

  {
    switch (node.name) {
      case OFM.Frontmatter: {
        if (config.propertiesInDocument === "source") break;
        const r = lineRange(node);
        // An unclosed fence is not frontmatter as far as Obsidian's properties are concerned.
        if (node.getChildren(OFM.FrontmatterMark).length < 2) break;
        specs.push({ kind: "frontmatter", ...r, revealFrom: r.from, revealTo: r.to, sticky: true, widget: null });
        break;
      }
      case OFM.Callout: {
        const r = lineRange(node);
        const header = node.getChild(OFM.CalloutHeader);
        specs.push({
          kind: "callout",
          ...r,
          revealFrom: node.from,
          revealTo: r.to,
          widget: new RenderedBlockWidget(host, "callout", doc.sliceString(r.from, r.to), sourcePath, "", header ? header.from - r.from : 2),
        });
        break;
      }
      case "Table": {
        const r = lineRange(node);
        specs.push({ kind: "table", ...r, revealFrom: r.from, revealTo: r.to, widget: new TableWidget(host, doc.sliceString(r.from, r.to), sourcePath) });
        break;
      }
      case OFM.MathBlock: {
        const marks = node.getChildren(OFM.MathMark);
        if (marks.length < 2) break;
        const r = lineRange(node);
        // Obsidian renders a block only when the `$$` fences are on their own lines; `$$x$$` on one line is also a block.
        const source = doc.sliceString(marks[0]!.to, marks[marks.length - 1]!.from).replace(/^[ \t]*>[ \t]?/gm, "");
        specs.push({ kind: "math", ...r, revealFrom: r.from, revealTo: r.to, widget: new MathWidget(host, source, true, true, r.from) });
        break;
      }
      case "HorizontalRule": {
        const r = lineRange(node);
        specs.push({ kind: "hr", ...r, revealFrom: r.from, revealTo: r.to, byLine: true, widget: new HrWidget() });
        break;
      }
      case "FencedCode": {
        const lang = codeProcessorLang(state, node);
        if (!lang) break;
        const r = lineRange(node);
        specs.push({
          kind: "code",
          ...r,
          revealFrom: r.from,
          revealTo: r.to,
          widget: new RenderedBlockWidget(host, "code", doc.sliceString(r.from, r.to), sourcePath, lang, doc.lineAt(node.from).length + 1),
        });
        break;
      }
      case "HTMLBlock": {
        const r = lineRange(node);
        specs.push({ kind: "html", ...r, revealFrom: r.from, revealTo: r.to, widget: new RenderedBlockWidget(host, "html", doc.sliceString(r.from, r.to), sourcePath, "", 0) });
        break;
      }
      case "Paragraph": {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name !== OFM.Embed && child.name !== "Image") continue;
          if (!isBlockLevelEmbedLine(state, child)) continue;
          const r = lineRange(child);
          let widget: WidgetType | null = null;
          if (child.name === OFM.Embed) {
            const open = child.firstChild!, close = child.lastChild!;
            const pipe = child.getChild(OFM.WikilinkPipe);
            const alias = child.getChild(OFM.WikilinkAlias);
            const linktext = doc.sliceString(open.to, pipe ? pipe.from : close.from).replace(/\\$/, "");
            widget = new EmbedWidget(host, linktext, alias ? doc.sliceString(alias.from, alias.to) : "", sourcePath, true, r.from);
          } else {
            const url = child.getChild("URL");
            const marks = child.getChildren("LinkMark");
            if (!url || marks.length < 2) continue;
            const alt = doc.sliceString(marks[0]!.to, marks[1]!.from);
            let target = doc.sliceString(url.from, url.to);
            if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
            if (URL_SCHEME.test(target)) widget = new ExternalImageWidget(target, alt);
            else {
              let decoded = target;
              try {
                decoded = decodeURI(target);
              } catch {
                /* keep raw */
              }
              widget = new EmbedWidget(host, decoded, alt, sourcePath, true, r.from);
            }
          }
          specs.push({ kind: "embed", ...r, revealFrom: child.from, revealTo: child.to, byLine: true, keepBelow: true, widget });
        }
        break;
      }
    }
  }
  return specs;
}

const hiddenBlock = Decoration.replace({ block: true });

function decorate(state: EditorState, specs: BlockSpec[]): DecorationSet {
  if (!specs.length) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const spec of specs) {
    if (spec.kind === "frontmatter") {
      // "visible": the Properties widget renders above the content (create.ts); "hidden": nothing.
      builder.add(spec.from, spec.to, hiddenBlock);
      continue;
    }
    if (!spec.widget) continue;
    const revealed = spec.byLine ? selectionOnLines(state, spec.revealFrom, spec.revealTo) : selectionTouches(state, spec.revealFrom, spec.revealTo);
    if (!revealed) {
      spec.replace ??= Decoration.replace({ widget: spec.widget, block: true });
      builder.add(spec.from, spec.to, spec.replace);
    } else if (spec.keepBelow) {
      spec.below ??= Decoration.widget({ widget: spec.widget, block: true, side: 1 });
      builder.add(spec.to, spec.to, spec.below);
    }
  }
  return builder.finish();
}

function settingsChanged(tr: Transaction): boolean {
  return (
    tr.state.field(editorLivePreviewField, false) !== tr.startState.field(editorLivePreviewField, false) ||
    tr.state.facet(configFacet) !== tr.startState.facet(configFacet) ||
    tr.state.facet(hostFacet) !== tr.startState.facet(hostFacet)
  );
}

export const livePreviewBlocks = StateField.define<BlockState>({
  create(state) {
    const cache: SpecCache = new WeakMap();
    const specs = collect(state, cache);
    return { tree: ofmTree(state), specs, decorations: decorate(state, specs), cache };
  },
  update(value, tr) {
    const reset = settingsChanged(tr);
    if (reset || tr.docChanged || ofmTree(tr.state) !== value.tree) {
      const cache = reset ? new WeakMap() : value.cache;
      const specs = collect(tr.state, cache);
      return { tree: ofmTree(tr.state), specs, decorations: decorate(tr.state, specs), cache };
    }
    if (tr.state.field(revealSelectionField) !== tr.startState.field(revealSelectionField)) {
      return { ...value, decorations: decorate(tr.state, value.specs) };
    }
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    // Hidden frontmatter and rendered blocks are single units for the cursor.
    EditorView.atomicRanges.of((view) => {
      const v = view.state.field(f, false);
      if (!v) return Decoration.none;
      return Decoration.set(
        v.specs.filter((s) => s.sticky).map((s) => Decoration.replace({}).range(s.from, Math.min(s.to + 1, view.state.doc.length))),
        true,
      );
    }),
  ],
});

/** Frontmatter body (YAML between the fences) and its range, or null. */
export function frontmatterInfo(state: EditorState): { from: number; to: number; contentFrom: number; contentTo: number; yaml: string } | null {
  const node = ofmTree(state).topNode.firstChild;
  if (!node || node.name !== OFM.Frontmatter) return null;
  const marks = node.getChildren(OFM.FrontmatterMark);
  if (marks.length < 2) return null;
  const contentFrom = state.doc.lineAt(marks[0]!.from).to + 1;
  const contentTo = Math.max(contentFrom, marks[1]!.from);
  return { from: node.from, to: node.to, contentFrom, contentTo, yaml: state.doc.sliceString(contentFrom, contentTo).replace(/\n$/, "") };
}
