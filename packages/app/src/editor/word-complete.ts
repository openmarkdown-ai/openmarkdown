/**
 * Word completion from the vault's vocabulary (Various Complements-like).
 *
 * Off by default (`wordCompletion` in app.json). After three letters of a word
 * it suggests words used elsewhere in the vault (and near the cursor), most
 * frequent first. Tab accepts the highlighted suggestion (the first when none
 * is highlighted); ↑/↓ move; Enter accepts only once you have moved into the
 * list, so a plain Enter still starts a new line; Escape closes.
 *
 * Nothing is suggested inside code, math, frontmatter, links, tags or
 * comments, for CJK text, while the `[[`/`#` popover or a plugin's
 * EditorSuggest is showing, or while the Various Complements plugin is enabled.
 *
 * The popover is @codemirror/autocomplete's, dressed in Obsidian's suggestion
 * classes: `.cm-tooltip-autocomplete.suggestion-container.vault-word-completion
 * > ul > li.suggestion-item[aria-selected]`.
 */
import { Compartment, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
  selectedCompletionIndex,
} from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { SyntaxNode } from "@lezer/common";
import { configFacet, hostFacet } from "./facets";
import { ofmTree } from "./syntax/language";
import { OFM } from "./syntax/ofm";
import { countWords } from "./vocabulary";

const MIN_PREFIX = 3;
const MAX_OPTIONS = 10;
const NEARBY_LINES = 60;
const PLUGIN_ID = "various-complements";

const PREFIX_RE = /\p{L}[\p{L}\p{M}]*$/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

const SKIP_NODES = new Set<string>([
  "FencedCode",
  "CodeBlock",
  "InlineCode",
  "HTMLBlock",
  "HTMLTag",
  "URL",
  "Autolink",
  "LinkLabel",
  OFM.InlineMath,
  OFM.MathBlock,
  OFM.Frontmatter,
  OFM.ObsidianComment,
  OFM.ObsidianCommentBlock,
  OFM.Wikilink,
  OFM.Embed,
  OFM.Tag,
]);

function skipAt(context: CompletionContext, pos: number): boolean {
  for (let n: SyntaxNode | null = ofmTree(context.state).resolveInner(pos, -1); n; n = n.parent) {
    if (SKIP_NODES.has(n.name)) return true;
  }
  return false;
}

/** What gets inserted: the typed prefix plus the rest of `word`, unless `word` has inner capitals. */
function cased(prefix: string, word: string): string {
  // Words with inner capitals (JavaScript, NASA) keep their own spelling.
  const rest = word.slice(1);
  if (rest !== rest.toLowerCase()) return word;
  if (prefix.length > 1 && prefix === prefix.toUpperCase() && prefix !== prefix.toLowerCase()) return word.toUpperCase();
  return prefix + word.slice(prefix.length).toLowerCase();
}

async function wordSource(context: CompletionContext): Promise<CompletionResult | null> {
  const state = context.state;
  if (!state.facet(configFacet).wordCompletion) return null;
  const host = state.facet(hostFacet);
  if (!host || host.isPluginEnabled?.(PLUGIN_ID)) return null;
  if (host.getEditorSuggests()?.isShowingSuggestion()) return null;
  if (state.selection.ranges.length !== 1) return null;
  const match = context.matchBefore(PREFIX_RE);
  if (!match || match.text.length < MIN_PREFIX || CJK_RE.test(match.text)) return null;
  const line = state.doc.lineAt(context.pos);
  const before = line.text.slice(0, match.from - line.from);
  // The `[[` / `#tag` popover owns these; a word glued to digits or `_` is an identifier.
  if (/[#\w@]$/u.test(before) || /\[\[[^\]]*$/.test(before)) return null;
  if (skipAt(context, match.from) || skipAt(context, context.pos)) return null;

  const prefix = match.text;
  const lower = prefix.toLowerCase();
  const counts = new Map<string, number>();
  try {
    const vocab = await host.getVocabulary?.();
    if (context.aborted) return null;
    if (vocab) for (const [w, n] of vocab) if (w.length > prefix.length && w.toLowerCase().startsWith(lower)) counts.set(w, n);
  } catch (e) {
    console.error("Word completion vocabulary failed", e);
  }
  // Words near the cursor that are not saved yet.
  const doc = state.doc;
  const a = doc.line(Math.max(1, line.number - NEARBY_LINES)).from;
  const b = doc.line(Math.min(doc.lines, line.number + NEARBY_LINES)).to;
  const nearby = countWords(doc.sliceString(a, match.from) + " " + doc.sliceString(context.pos, b));
  for (const [w, n] of nearby) {
    if (w.length > prefix.length && w.toLowerCase().startsWith(lower)) counts.set(w, Math.max(counts.get(w) ?? 0, n));
  }
  if (!counts.size) return null;
  // One entry per spelling-insensitive word: keep the most used spelling.
  const best = new Map<string, [string, number]>();
  for (const [w, n] of counts) {
    const k = w.toLowerCase();
    const cur = best.get(k);
    if (!cur) best.set(k, [w, n]);
    else best.set(k, [cur[1] >= n ? cur[0] : w, cur[1] + n]);
  }
  const options: Completion[] = [...best.values()]
    .sort((x, y) => y[1] - x[1] || x[0].length - y[0].length || x[0].localeCompare(y[0]))
    .slice(0, MAX_OPTIONS)
    .map(([w]) => ({ label: cased(prefix, w), type: "text" }));
  return { from: match.from, to: context.pos, options, filter: false };
}

/** Tab: accept the highlighted option, or the first when none is highlighted. */
function tabAccept(view: EditorView): boolean {
  if (completionStatus(view.state) !== "active") return false;
  if (selectedCompletionIndex(view.state) === null || selectedCompletionIndex(view.state)! < 0) {
    if (!moveCompletionSelection(true)(view)) return false;
  }
  return acceptCompletion(view) || true;
}

const whenOpen = (cmd: (v: EditorView) => boolean) => (view: EditorView) => (completionStatus(view.state) === "active" ? cmd(view) : false);

function completionExtension(): Extension {
  return [
    autocompletion({
      override: [wordSource],
      activateOnTyping: true,
      activateOnTypingDelay: 60,
      selectOnOpen: false,
      defaultKeymap: false,
      icons: false,
      closeOnBlur: true,
      maxRenderedOptions: MAX_OPTIONS,
      interactionDelay: 0,
      tooltipClass: () => "suggestion-container vault-word-completion",
      optionClass: () => "suggestion-item",
    }),
    Prec.highest(
      keymap.of([
        { key: "Tab", run: tabAccept },
        { key: "Enter", run: whenOpen(acceptCompletion) },
        { key: "ArrowDown", run: whenOpen(moveCompletionSelection(true)) },
        { key: "ArrowUp", run: whenOpen(moveCompletionSelection(false)) },
        { key: "PageDown", run: whenOpen(moveCompletionSelection(true, "page")) },
        { key: "PageUp", run: whenOpen(moveCompletionSelection(false, "page")) },
        { key: "Escape", run: whenOpen(closeCompletion) },
      ]),
    ),
  ];
}

/**
 * `autocompletion()` is only installed while the setting is on, so other
 * autocomplete sources (e.g. lang-markdown's HTML tags) never pop up on their
 * own when word completion is off.
 */
export function wordCompletion(): Extension {
  const compartment = new Compartment();
  const sync = ViewPlugin.fromClass(
    class {
      on = false;
      constructor(readonly view: EditorView) {
        this.check(view.state.facet(configFacet).wordCompletion);
      }
      update(u: ViewUpdate) {
        const on = u.state.facet(configFacet).wordCompletion;
        if (on !== this.on) this.check(on);
      }
      check(on: boolean) {
        if (on === this.on) return;
        this.on = on;
        queueMicrotask(() => {
          if (this.on !== on) return;
          try {
            this.view.dispatch({ effects: compartment.reconfigure(on ? completionExtension() : []) });
          } catch {
            /* view destroyed */
          }
        });
      }
    },
  );
  return [compartment.of([]), sync];
}
