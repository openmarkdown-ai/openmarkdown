/**
 * The tree plugins see through `syntaxTree(state)`.
 *
 * Obsidian's editor language is a HyperMD-derived stream tokenizer, so the
 * syntax tree community plugins walk is a flat list of tokens under a
 * `Document` node, each named after its CSS classes joined by `_`:
 * `formatting_formatting-header_formatting-header-1_header_header-1`,
 * `HyperMD-codeblock_HyperMD-codeblock-begin_…_formatting-code-block_hmd-codeblock`,
 * `formatting_formatting-math_formatting-math-begin_keyword_math` … Plugins test
 * those names with `includes("inline-code")`, `contains("math-end")`,
 * `contains("HyperMD-codeblock-begin")` and so on (Dataview's inline queries,
 * LaTeX Suite, code block stylers).
 *
 * This language wraps the structural OFM parser: every parse produces the
 * lezer Markdown tree as usual, then a flat HyperMD token tree built from it.
 * The structural tree rides along on the token tree as the per-node prop
 * `structuralTreeProp`; the editor's own extensions read it via `ofmTree()`.
 *
 * Token trees are cached per top-level block. Lezer reuses the subtree object
 * of every block an edit did not touch, so an edit re-tokenizes only the
 * blocks it changed.
 *
 * Token names are the token's line classes (`HyperMD-…`) followed by its span
 * classes, each group sorted. Lines that carry line classes but no tokens
 * (an empty line inside a code block) get a zero-length token at line start.
 */
import { Language, defineLanguageFacet, languageDataProp } from "@codemirror/language";
import type { Facet } from "@codemirror/state";
import { Text } from "@codemirror/state";
import { NodeProp, NodeSet, NodeType, Parser, Tree, TreeFragment } from "@lezer/common";
import type { Input, PartialParse, SyntaxNode } from "@lezer/common";
import { computeNodeTokens } from "./hypermd";
import { tokenClassNodeProp } from "./token-prop";
import type { DocLike } from "./hypermd";

/** The structural (lezer Markdown + OFM) tree, stored on the HyperMD token tree's top node. */
export const structuralTreeProp = new NodeProp<Tree>({ perNode: true });

const types: NodeType[] = [NodeType.none];
const typeIds = new Map<string, number>();
const nodeSet = new NodeSet(types);
let documentType: NodeType | null = null;

function documentTypeFor(data: Facet<{ [name: string]: any }> | undefined): NodeType {
  if (!documentType) {
    documentType = NodeType.define({
      id: types.length,
      name: "Document",
      top: true,
      props: data ? [[languageDataProp, data]] : [],
    });
    types.push(documentType);
    typeIds.set("Document", documentType.id);
  }
  return documentType;
}

function typeId(name: string): number {
  let id = typeIds.get(name);
  if (id === undefined) {
    id = types.length;
    types.push(NodeType.define({ id, name, props: [[tokenClassNodeProp, name.replace(/_/g, " ")]] }));
    typeIds.set(name, id);
  }
  return id;
}

class OffsetDoc implements DocLike {
  constructor(
    readonly text: Text,
    readonly base: number,
  ) {}
  get length() {
    return this.base + this.text.length;
  }
  private shift(l: { from: number; to: number; number: number; text: string }) {
    return { from: l.from + this.base, to: l.to + this.base, number: l.number, text: l.text };
  }
  lineAt(pos: number) {
    return this.shift(this.text.lineAt(Math.max(0, Math.min(this.text.length, pos - this.base))));
  }
  line(n: number) {
    return this.shift(this.text.line(Math.max(1, Math.min(this.text.lines, n))));
  }
  sliceString(from: number, to?: number) {
    const a = Math.max(0, from - this.base);
    const b = to === undefined ? undefined : Math.max(0, to - this.base);
    return this.text.sliceString(a, b);
  }
}

const EMPTY = new Tree(NodeType.none, [], [], 0);

/** Build the token tree (positions relative to the block) for one top-level block. */
function blockTokens(node: SyntaxNode, input: Input): Tree {
  const length = node.to - node.from;
  if (length <= 0) return EMPTY;
  const text = Text.of(input.read(node.from, node.to).split("\n"));
  const doc = new OffsetDoc(text, node.from);
  const { spans, lines } = computeNodeTokens(node, doc);
  const lineName = (n: number) => {
    const info = lines.get(n);
    return info && info.classes.size ? [...info.classes].sort().join("_") : "";
  };
  const entries: { from: number; to: number; name: string }[] = [];
  const linesWithTokens = new Set<number>();
  for (const span of spans) {
    // Tokens never cross a line break.
    let from = span.from;
    while (from < span.to) {
      const line = doc.lineAt(from);
      const to = Math.min(span.to, line.to);
      if (to > from) {
        linesWithTokens.add(line.number);
        const ln = lineName(line.number);
        const cls = span.classes.join("_");
        entries.push({ from, to, name: ln ? `${ln}_${cls}` : cls });
      }
      from = line.to + 1;
    }
  }
  let needSort = false;
  for (const [n, info] of lines) {
    if (!info.classes.size || linesWithTokens.has(n)) continue;
    const l = doc.line(n);
    entries.push({ from: l.from, to: l.from, name: lineName(n) });
    needSort = true;
  }
  if (!entries.length) return EMPTY;
  if (needSort) entries.sort((a, b) => a.from - b.from || a.to - b.to);
  const buffer: number[] = [];
  for (const e of entries) buffer.push(typeId(e.name), e.from - node.from, e.to - node.from, 4);
  return Tree.build({ buffer, nodeSet, topID: 0, length, maxBufferLength: 1024 });
}

class HyperMDParse implements PartialParse {
  constructor(
    readonly inner: PartialParse,
    readonly input: Input,
    readonly owner: HyperMDParser,
  ) {}
  get parsedPos() {
    return this.inner.parsedPos;
  }
  get stoppedAt() {
    return this.inner.stoppedAt;
  }
  stopAt(pos: number) {
    this.inner.stopAt(pos);
  }
  advance(): Tree | null {
    const structural = this.inner.advance();
    return structural ? this.owner.flatten(structural, this.input) : null;
  }
}

export class HyperMDParser extends Parser {
  private cache = new WeakMap<object, Tree>();
  private readonly docType: NodeType;

  constructor(readonly inner: Parser) {
    super();
    const innerTop = (inner as unknown as { nodeSet: NodeSet }).nodeSet.types.find((t) => t.isTop);
    this.docType = documentTypeFor(innerTop?.prop(languageDataProp));
  }

  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    const innerFragments: TreeFragment[] = [];
    for (const f of fragments) {
      const s = f.tree.prop(structuralTreeProp);
      if (s) innerFragments.push(new TreeFragment(f.from, f.to, s, f.offset, f.openStart, f.openEnd));
    }
    return new HyperMDParse(this.inner.startParse(input, innerFragments, ranges), input, this);
  }

  flatten(structural: Tree, input: Input): Tree {
    const children: Tree[] = [];
    const positions: number[] = [];
    const visit = (t: Tree, offset: number) => {
      for (let i = 0; i < t.children.length; i++) {
        const child = t.children[i]!;
        const pos = offset + t.positions[i]!;
        if (child instanceof Tree && child.type.isAnonymous) {
          visit(child, pos);
          continue;
        }
        let tokens = child instanceof Tree ? this.cache.get(child) : undefined;
        if (!tokens) {
          const node = structural.topNode.childAfter(pos);
          tokens = node && node.from === pos ? blockTokens(node, input) : EMPTY;
          if (child instanceof Tree) this.cache.set(child, tokens);
        }
        if (tokens.length) {
          children.push(tokens);
          positions.push(pos);
        }
      }
    };
    visit(structural, 0);
    return new Tree(this.docType, children, positions, structural.length, [[structuralTreeProp, structural]]).balance();
  }
}

/** Wrap a structural Markdown language so `syntaxTree` yields HyperMD tokens. */
export function hypermdLanguage(structural: Language): Language {
  const innerTop = (structural.parser as unknown as { nodeSet: NodeSet }).nodeSet.types.find((t) => t.isTop);
  const data = (innerTop?.prop(languageDataProp) as Facet<{ [name: string]: any }> | undefined) ?? defineLanguageFacet();
  return new Language(data, new HyperMDParser(structural.parser), [], "hypermd");
}
