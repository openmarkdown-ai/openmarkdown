/**
 * Grammar and style underlines (`grammarCheck` in app.json, off by default).
 *
 * The checker itself lives in the app (core plugin `grammar`, Harper in wasm);
 * this extension asks for issues through `host.lintGrammar(text)` about 600 ms
 * after typing stops, then underlines them:
 *
 *   span.cm-lint-grammar[data-grammar-kind][.mod-spelling]
 *
 * Hovering or clicking an underline opens a popover:
 *
 *   div.cm-tooltip.vault-grammar-tooltip > div.vault-grammar-popover
 *     div.vault-grammar-kind            "Spelling"
 *     div.vault-grammar-message
 *     div.vault-grammar-suggestions > button.vault-grammar-suggestion   (click applies)
 *     div.vault-grammar-actions > button "Ignore" | button "Add to dictionary"
 *
 * Code (fenced, indented, inline), math, frontmatter, URLs, HTML, comments,
 * tags, wikilinks/embeds, footnote refs and callout types are blanked out
 * (replaced by spaces, so offsets stay aligned) before checking, and issues
 * touching a blanked range are dropped. Documents under 50k characters are
 * checked whole; longer ones around the visible range.
 */
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, hoverTooltip, showTooltip } from "@codemirror/view";
import type { DecorationSet, Tooltip, ViewUpdate } from "@codemirror/view";
import { configFacet, hostFacet } from "./facets";
import { ensureOfmTree, ofmTree } from "./syntax/language";
import { OFM } from "./syntax/ofm";

export interface GrammarSuggestion {
  /** Replacement text ("" for a removal). */
  text: string;
  kind: "replace" | "remove" | "insert";
}

export interface GrammarIssue {
  /** UTF-16 offsets into the text that was checked. */
  from: number;
  to: number;
  message: string;
  /** "Spelling", "Grammar", "Style", "Capitalization" … */
  kind: string;
  /** The flagged text. */
  problem: string;
  suggestions: GrammarSuggestion[];
}

interface LiveIssue extends GrammarIssue {
  id: number;
}

const DEBOUNCE = 600;
const WHOLE_DOC_LIMIT = 50_000;
const WINDOW_MARGIN = 4_000;

let nextId = 1;
/** Issues dismissed with "Ignore" this session: `${message}\0${problem}`. */
const ignored = new Set<string>();
const ignoreKey = (i: GrammarIssue) => `${i.message}\u0000${i.problem}`;

const setIssues = StateEffect.define<{ from: number; to: number; issues: LiveIssue[] }>();
const removeIssues = StateEffect.define<(i: LiveIssue) => boolean>();
const pinIssue = StateEffect.define<number | null>();

interface GrammarState {
  issues: LiveIssue[];
  decorations: DecorationSet;
  pinned: number | null;
}

function decorate(issues: LiveIssue[]): DecorationSet {
  const ranges = issues
    .filter((i) => i.to > i.from)
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((i) => {
      const spelling = /spell/i.test(i.kind);
      return Decoration.mark({
        class: spelling ? "cm-lint-grammar mod-spelling" : "cm-lint-grammar",
        attributes: { "data-grammar-kind": i.kind, "data-grammar-id": String(i.id) },
      }).range(i.from, i.to);
    });
  return Decoration.set(ranges, true);
}

function mapIssues(issues: LiveIssue[], tr: Transaction): LiveIssue[] {
  const out: LiveIssue[] = [];
  for (const i of issues) {
    // An edit inside the flagged text invalidates the issue until the next check.
    if (tr.changes.touchesRange(i.from, i.to)) continue;
    const from = tr.changes.mapPos(i.from, 1);
    const to = tr.changes.mapPos(i.to, -1);
    if (to > from) out.push({ ...i, from, to });
  }
  return out;
}

const grammarField = StateField.define<GrammarState>({
  create: () => ({ issues: [], decorations: Decoration.none, pinned: null }),
  update(value, tr) {
    let { issues, pinned } = value;
    let changed = false;
    if (tr.docChanged) {
      issues = mapIssues(issues, tr);
      changed = true;
      pinned = null;
    }
    for (const e of tr.effects) {
      if (e.is(setIssues)) {
        const { from, to } = e.value;
        issues = [...issues.filter((i) => i.to < from || i.from > to), ...e.value.issues];
        changed = true;
      } else if (e.is(removeIssues)) {
        issues = issues.filter((i) => !e.value(i));
        changed = true;
      } else if (e.is(pinIssue)) {
        pinned = e.value;
      }
    }
    if (pinned !== null && !issues.some((i) => i.id === pinned)) pinned = null;
    if (!changed && pinned === value.pinned) return value;
    return { issues, decorations: changed ? decorate(issues) : value.decorations, pinned };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    showTooltip.computeN([f], (state) => {
      const v = state.field(f);
      const issue = v.pinned === null ? null : v.issues.find((i) => i.id === v.pinned);
      return issue ? [issueTooltip(issue)] : [];
    }),
  ],
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

const MASK_NODES = new Set<string>([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "CommentBlock",
  "Comment",
  "ProcessingInstructionBlock",
  "URL",
  "Autolink",
  OFM.InlineMath,
  OFM.MathBlock,
  OFM.Frontmatter,
  OFM.ObsidianComment,
  OFM.ObsidianCommentBlock,
  OFM.Tag,
  OFM.BlockId,
  OFM.FootnoteRef,
  OFM.CalloutMark,
  OFM.CalloutType,
  OFM.CalloutMeta,
  OFM.CalloutFold,
]);

/** `text` of [from, to) with non-prose ranges blanked, and the blanked ranges (absolute). */
export function maskProse(state: EditorState, from: number, to: number): { text: string; masked: { from: number; to: number }[] } {
  const tree = ensureOfmTree(state, to, 200) ?? ofmTree(state);
  const chars = state.sliceDoc(from, to).split("");
  const masked: { from: number; to: number }[] = [];
  const blank = (a: number, b: number) => {
    const s = Math.max(a, from), e = Math.min(b, to);
    if (e <= s) return;
    masked.push({ from: s, to: e });
    for (let p = s; p < e; p++) if (chars[p - from] !== "\n") chars[p - from] = " ";
  };
  tree.iterate({
    from,
    to,
    enter(n) {
      if (MASK_NODES.has(n.name)) {
        blank(n.from, n.to);
        return false;
      }
      if (n.name === OFM.Wikilink || n.name === OFM.Embed) {
        // Keep an alias (`[[target|alias]]`) as prose; blank the rest.
        const alias = n.node.getChild(OFM.WikilinkAlias);
        if (alias) {
          blank(n.from, alias.from);
          blank(alias.to, n.to);
        } else blank(n.from, n.to);
        return false;
      }
      return undefined;
    },
  });
  // Bare URLs the parser left as text.
  const text = chars.join("");
  for (const m of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/\S+/gi)) blank(from + m.index!, from + m.index! + m[0].length);
  return { text: chars.join(""), masked };
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

function currentIssue(view: EditorView, id: number): LiveIssue | null {
  return view.state.field(grammarField, false)?.issues.find((i) => i.id === id) ?? null;
}

function renderPopover(view: EditorView, issue: LiveIssue): HTMLElement {
  const doc = view.dom.ownerDocument;
  const el = (tag: string, cls: string, parent: HTMLElement, text?: string) => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    parent.appendChild(e);
    return e;
  };
  const dom = doc.createElement("div");
  dom.className = "vault-grammar-popover";
  el("div", "vault-grammar-kind", dom, issue.kind);
  el("div", "vault-grammar-message", dom, issue.message);
  const act = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (issue.suggestions.length) {
    const list = el("div", "vault-grammar-suggestions", dom);
    for (const s of issue.suggestions.slice(0, 6)) {
      const label = s.kind === "remove" ? `Remove “${issue.problem}”` : s.kind === "insert" ? `Insert “${s.text}”` : s.text;
      const b = el("button", "vault-grammar-suggestion", list, label);
      b.addEventListener("mousedown", act);
      b.addEventListener("click", (e) => {
        act(e);
        const cur = currentIssue(view, issue.id);
        if (!cur) return;
        const change = s.kind === "insert" ? { from: cur.to, insert: s.text } : { from: cur.from, to: cur.to, insert: s.kind === "remove" ? "" : s.text };
        view.dispatch({ changes: change, effects: removeIssues.of((i) => i.id === cur.id), userEvent: "input.complete" });
        view.focus();
      });
    }
  }
  const actions = el("div", "vault-grammar-actions", dom);
  const ignore = el("button", "vault-grammar-action mod-ignore", actions, "Ignore");
  ignore.addEventListener("mousedown", act);
  ignore.addEventListener("click", (e) => {
    act(e);
    const key = ignoreKey(issue);
    ignored.add(key);
    view.dispatch({ effects: removeIssues.of((i) => ignoreKey(i) === key) });
    view.focus();
  });
  const host = view.state.facet(hostFacet);
  if (/spell/i.test(issue.kind) && host?.addToDictionary && issue.problem.trim()) {
    const add = el("button", "vault-grammar-action mod-dictionary", actions, "Add to dictionary");
    add.addEventListener("mousedown", act);
    add.addEventListener("click", (e) => {
      act(e);
      const word = issue.problem.trim();
      void host.addToDictionary!(word);
      view.dispatch({ effects: removeIssues.of((i) => i.problem.trim() === word && /spell/i.test(i.kind)) });
      view.focus();
    });
  }
  return dom;
}

function issueTooltip(issue: LiveIssue): Tooltip {
  return {
    pos: issue.from,
    end: issue.to,
    above: false,
    create: (view) => {
      const dom = view.dom.ownerDocument.createElement("div");
      dom.className = "vault-grammar-tooltip";
      dom.appendChild(renderPopover(view, issue));
      return { dom };
    },
  };
}

const hover = hoverTooltip(
  (view, pos, side) => {
    const v = view.state.field(grammarField, false);
    if (!v || !v.issues.length) return null;
    const issue = v.issues.find((i) => (side < 0 ? i.from < pos && pos <= i.to : i.from <= pos && pos < i.to));
    if (!issue || v.pinned === issue.id) return null;
    return issueTooltip(issue);
  },
  { hideOnChange: true, hoverTime: 250 },
);

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

const checker = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null;
    running = false;
    rerun = false;
    enabled: boolean;
    destroyed = false;

    constructor(readonly view: EditorView) {
      this.enabled = this.isOn(view.state);
      if (this.enabled) this.schedule();
    }

    isOn(state: EditorState): boolean {
      return !!state.facet(configFacet).grammarCheck && !!state.facet(hostFacet)?.lintGrammar;
    }

    update(u: ViewUpdate) {
      const on = this.isOn(u.state);
      if (on !== this.enabled) {
        this.enabled = on;
        if (!on) {
          this.cancel();
          if (u.state.field(grammarField, false)?.issues.length) queueMicrotask(() => this.clear());
        } else this.schedule();
        return;
      }
      if (!on) return;
      if (u.docChanged || (u.viewportChanged && u.state.doc.length > WHOLE_DOC_LIMIT)) this.schedule();
    }

    clear() {
      if (this.destroyed) return;
      this.view.dispatch({ effects: removeIssues.of(() => true) });
    }

    cancel() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }

    schedule() {
      this.cancel();
      this.timer = setTimeout(() => void this.run(), DEBOUNCE);
    }

    async run() {
      this.timer = null;
      if (this.destroyed || !this.enabled) return;
      if (this.running) {
        this.rerun = true;
        return;
      }
      const view = this.view;
      const state = view.state;
      const host = state.facet(hostFacet);
      if (!host?.lintGrammar) return;
      let from = 0, to = state.doc.length;
      if (to > WHOLE_DOC_LIMIT) {
        from = state.doc.lineAt(Math.max(0, view.viewport.from - WINDOW_MARGIN)).from;
        to = state.doc.lineAt(Math.min(state.doc.length, view.viewport.to + WINDOW_MARGIN)).to;
      }
      const { text, masked } = maskProse(state, from, to);
      this.running = true;
      let found: GrammarIssue[] = [];
      try {
        found = await host.lintGrammar(text);
      } catch (e) {
        console.error("Grammar check failed", e);
      } finally {
        this.running = false;
      }
      if (this.destroyed) return;
      if (this.rerun || view.state.doc !== state.doc) {
        // The text moved on while checking; check again once typing pauses.
        this.rerun = false;
        if (!this.timer) this.schedule();
        return;
      }
      if (!this.isOn(view.state)) return;
      // Keep the ids (and so the underline DOM, which an open hover tooltip is anchored to) of unchanged issues.
      const previous = new Map<string, number>();
      for (const i of view.state.field(grammarField, false)?.issues ?? []) previous.set(`${i.from}:${i.to}:${i.message}`, i.id);
      const issues: LiveIssue[] = [];
      for (const f of found) {
        const a = from + f.from, b = from + f.to;
        if (b <= a || b > to) continue;
        // Drop issues overlapping or touching a blanked range (e.g. "extra spaces" left by a blanked link).
        if (masked.some((m) => a <= m.to && b >= m.from)) continue;
        if (ignored.has(ignoreKey(f))) continue;
        issues.push({ ...f, from: a, to: b, id: previous.get(`${a}:${b}:${f.message}`) ?? nextId++ });
      }
      const current = view.state.field(grammarField, false)?.issues ?? [];
      const inWindow = current.filter((i) => !(i.to < from || i.from > to));
      const same = inWindow.length === issues.length && issues.every((i) => inWindow.some((c) => c.id === i.id));
      if (!same) view.dispatch({ effects: setIssues.of({ from, to, issues }) });
    }

    destroy() {
      this.destroyed = true;
      this.cancel();
    }
  },
  {
    eventHandlers: {
      mousedown(evt, view) {
        const target = (evt.target as HTMLElement).closest?.(".cm-lint-grammar");
        const id = target ? Number(target.getAttribute("data-grammar-id")) : null;
        const v = view.state.field(grammarField, false);
        if (!v) return false;
        if (id && evt.button === 0) {
          // Let the click place the cursor, then pin the popover open.
          setTimeout(() => view.dispatch({ effects: pinIssue.of(id) }), 0);
        } else if (v.pinned !== null) {
          view.dispatch({ effects: pinIssue.of(null) });
        }
        return false;
      },
      keydown(evt, view) {
        if (evt.key === "Escape" && view.state.field(grammarField, false)?.pinned != null) {
          view.dispatch({ effects: pinIssue.of(null) });
          return true;
        }
        return false;
      },
    },
  },
);

export function grammarLint(): Extension {
  return [grammarField, checker, hover];
}
