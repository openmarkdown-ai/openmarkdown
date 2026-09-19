/**
 * Link and tag autocomplete, plus the bridge to plugins' EditorSuggests.
 *
 * Typing `[[` (or `![[`) opens file suggestions; `#` after the target lists
 * headings, `#^` lists blocks, and `|` stops suggesting (alias). A `#` that
 * starts a word opens tag suggestions. The popover uses Obsidian's DOM
 * (`.suggestion-container > .suggestion > .suggestion-item.is-selected >
 * .suggestion-content > .suggestion-title + .suggestion-note`) so themes style it.
 *
 * Plugin EditorSuggests (`host.getEditorSuggests()`) run first on every edit;
 * while one is showing, the built-in popover stays closed and keys go to it.
 */
import { EditorSelection, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { hostFacet, sourcePathOf } from "./facets";
import { ofmTree } from "./syntax/language";
import { OFM } from "./syntax/ofm";
import { editorOf } from "./editor";
import type { EditorHost } from "./host";

type Item =
  | { kind: "file"; title: string; note?: string; linktext: string; unresolved?: boolean }
  | { kind: "heading"; title: string; level: number; linkpath: string }
  | { kind: "block"; title: string; id?: string; line: number; linkpath: string }
  | { kind: "tag"; title: string; count: number };

interface Trigger {
  type: "link" | "tag";
  /** Replace range for the query. */
  from: number;
  to: number;
  query: string;
}

const LIMIT = 50;

function inCode(view: EditorView, pos: number): boolean {
  for (let n: SyntaxNode | null = ofmTree(view.state).resolveInner(pos, -1); n; n = n.parent) {
    if (["FencedCode", "CodeBlock", "InlineCode", OFM.InlineMath, OFM.MathBlock, OFM.Frontmatter, OFM.ObsidianComment, OFM.ObsidianCommentBlock].includes(n.name)) return true;
  }
  return false;
}

function findTrigger(view: EditorView): Trigger | null {
  const state = view.state;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return null;
  const pos = sel.main.head;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const open = before.lastIndexOf("[[");
  if (open >= 0) {
    const query = before.slice(open + 2);
    if (!query.includes("]]") && !query.includes("[[")) {
      if (inCode(view, pos)) return null;
      return { type: "link", from: line.from + open + 2, to: pos, query };
    }
  }
  const tag = /(^|\s)#([^\s#!"$%&'()*+,.:;<=>?@^`{|}~\[\]\\]*)$/u.exec(before);
  if (tag) {
    // `# Heading` is not a tag, and neither is `#` alone at line start followed by a space.
    const start = before.length - tag[2]!.length - 1;
    if (/^\s*#*$/.test(before.slice(0, start + 1)) && tag[2] === "") return null;
    if (inCode(view, pos)) return null;
    return { type: "tag", from: line.from + start, to: pos, query: tag[2]! };
  }
  return null;
}

function itemsFor(host: EditorHost, trigger: Trigger, sourcePath: string): Item[] {
  if (trigger.type === "tag") {
    return host
      .getTagSuggestions(trigger.query)
      .slice(0, LIMIT)
      .map((t) => ({ kind: "tag" as const, title: t.tag.startsWith("#") ? t.tag.slice(1) : t.tag, count: t.count }));
  }
  const q = trigger.query;
  if (q.includes("|")) return [];
  const hash = q.indexOf("#");
  if (hash >= 0) {
    const linkpath = q.slice(0, hash);
    const sub = q.slice(hash + 1);
    if (sub.startsWith("^")) {
      const needle = sub.slice(1).toLowerCase();
      return host
        .getBlockSuggestions(linkpath, sourcePath)
        .filter((b) => !needle || b.text.toLowerCase().includes(needle) || b.id?.toLowerCase().includes(needle))
        .slice(0, LIMIT)
        .map((b) => ({ kind: "block" as const, title: b.text, id: b.id, line: b.line, linkpath }));
    }
    const needle = sub.toLowerCase();
    return host
      .getHeadingSuggestions(linkpath, sourcePath)
      .filter((h) => !needle || h.heading.toLowerCase().includes(needle))
      .slice(0, LIMIT)
      .map((h) => ({ kind: "heading" as const, title: h.heading, level: h.level, linkpath }));
  }
  return host
    .getLinkSuggestions(q, sourcePath)
    .slice(0, LIMIT)
    .map((s) => ({
      kind: "file" as const,
      title: s.display,
      note: s.note ?? (s.path !== s.display && !s.unresolved ? s.path : undefined),
      linktext: (s.linktext ?? s.display.replace(/\.md$/, "")) + (s.subpath ?? "") + (s.alias ? `|${s.alias}` : ""),
      unresolved: s.unresolved,
    }));
}

class SuggestPopover {
  el: HTMLElement | null = null;
  items: Item[] = [];
  selected = 0;
  trigger: Trigger | null = null;
  suppressedAt = -1;

  constructor(readonly view: EditorView) {}

  get isOpen() {
    return !!this.el;
  }

  update(u: ViewUpdate) {
    const view = this.view;
    const host = view.state.facet(hostFacet);
    if (!host) return this.close();
    const userEdit = u.transactions.some((tr) => tr.isUserEvent("input") || tr.isUserEvent("delete"));
    const moved = u.selectionSet && !u.docChanged;
    if (!userEdit && !moved && !u.focusChanged) return;
    // Plugins' EditorSuggests first.
    const manager = host.getEditorSuggests();
    if (manager && (userEdit || moved)) {
      try {
        manager.trigger(editorOf(view), host.getFile());
      } catch (e) {
        console.error(e);
      }
      if (manager.isShowingSuggestion()) return this.close();
    }
    if (u.focusChanged && !view.hasFocus) return this.close();
    const trigger = findTrigger(view);
    if (!trigger || (!userEdit && !this.isOpen) || trigger.from === this.suppressedAt) return this.close();
    this.trigger = trigger;
    this.items = itemsFor(host, trigger, sourcePathOf(host));
    if (!this.items.length) return this.close();
    this.selected = Math.min(this.selected, this.items.length - 1);
    if (userEdit) this.selected = 0;
    this.render();
  }

  render() {
    const view = this.view;
    const doc = view.dom.ownerDocument;
    if (!this.el) {
      this.el = doc.createElement("div");
      this.el.className = "suggestion-container vault-editor-suggest";
      this.el.addEventListener("mousedown", (e) => e.preventDefault());
      doc.body.appendChild(this.el);
    }
    const list = doc.createElement("div");
    list.className = "suggestion";
    this.items.forEach((item, i) => {
      const row = doc.createElement("div");
      row.className = "suggestion-item mod-complex" + (i === this.selected ? " is-selected" : "");
      const content = doc.createElement("div");
      content.className = "suggestion-content";
      const title = doc.createElement("div");
      title.className = "suggestion-title";
      title.textContent = item.title;
      content.appendChild(title);
      let note: string | undefined;
      if (item.kind === "file") note = item.unresolved ? "Not created yet" : item.note;
      if (note) {
        const n = doc.createElement("div");
        n.className = "suggestion-note";
        n.textContent = note;
        content.appendChild(n);
      }
      row.appendChild(content);
      const aux = doc.createElement("div");
      aux.className = "suggestion-aux";
      if (item.kind === "heading") {
        const flair = doc.createElement("span");
        flair.className = "suggestion-flair";
        flair.textContent = `H${item.level}`;
        aux.appendChild(flair);
      } else if (item.kind === "tag") {
        const flair = doc.createElement("span");
        flair.className = "suggestion-flair";
        flair.textContent = String(item.count);
        aux.appendChild(flair);
      }
      if (aux.childNodes.length) row.appendChild(aux);
      row.addEventListener("mousemove", () => {
        if (this.selected !== i) {
          this.selected = i;
          this.highlight();
        }
      });
      row.addEventListener("click", () => this.choose(i));
      list.appendChild(row);
    });
    this.el.replaceChildren(list);
    this.position();
  }

  highlight() {
    if (!this.el) return;
    const rows = this.el.querySelectorAll(".suggestion-item");
    rows.forEach((r, i) => r.classList.toggle("is-selected", i === this.selected));
    (rows[this.selected] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  position() {
    const t = this.trigger;
    if (!this.el || !t) return;
    // Layout can't be read during a view update; measure in CM's read phase.
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const coords = view.coordsAtPos(t.from - (t.type === "link" ? 2 : 0));
        return { coords, h: this.el?.offsetHeight ?? 0 };
      },
      write: ({ coords, h }) => {
        const el = this.el;
        if (!el || !coords) return;
        const win = this.view.dom.ownerDocument.defaultView ?? window;
        el.style.position = "fixed";
        el.style.left = `${Math.max(4, Math.min(coords.left, win.innerWidth - 320))}px`;
        const below = coords.bottom + 4;
        const height = h || 240;
        el.style.top = below + height > win.innerHeight && coords.top - height - 4 > 0 ? `${coords.top - height - 4}px` : `${below}px`;
      },
    });
  }

  move(delta: number) {
    if (!this.items.length) return;
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.highlight();
  }

  choose(index = this.selected) {
    const item = this.items[index];
    const t = this.trigger;
    const view = this.view;
    const host = view.state.facet(hostFacet);
    if (!item || !t || !host) return this.close();
    const state = view.state;
    let insert: string;
    let cursorAfter: number;
    if (item.kind === "tag") {
      insert = `#${item.title} `;
      const from = t.from;
      view.dispatch({ changes: { from, to: t.to, insert }, selection: EditorSelection.cursor(from + insert.length), userEvent: "input.complete" });
      return this.close();
    }
    const closing = state.sliceDoc(t.to, t.to + 2) === "]]";
    const q = t.query;
    if (item.kind === "file") insert = item.linktext;
    else if (item.kind === "heading") insert = `${item.linkpath}#${item.title}`;
    else {
      let id = item.id;
      if (!id) {
        id = Math.random().toString(36).slice(2, 8);
        host.addBlockId?.(item.linkpath, sourcePathOf(host), item.line, id);
      }
      insert = `${item.linkpath}#^${id}`;
    }
    void q;
    const to = closing ? t.to + 2 : t.to;
    const text = insert + "]]";
    cursorAfter = t.from + text.length;
    view.dispatch({ changes: { from: t.from, to, insert: text }, selection: EditorSelection.cursor(cursorAfter), userEvent: "input.complete" });
    this.close();
  }

  close() {
    this.el?.remove();
    this.el = null;
    this.items = [];
    this.trigger = null;
    this.selected = 0;
  }
}

const suggestPlugin = ViewPlugin.fromClass(
  class {
    popover: SuggestPopover;
    constructor(view: EditorView) {
      this.popover = new SuggestPopover(view);
    }
    update(u: ViewUpdate) {
      this.popover.update(u);
    }
    destroy() {
      this.popover.close();
    }
  },
);

export function linkSuggest(): Extension {
  return [
    suggestPlugin,
    Prec.highest(
      EditorView.domEventHandlers({
        keydown(evt, view) {
          const host = view.state.facet(hostFacet);
          const manager = host?.getEditorSuggests();
          if (manager?.isShowingSuggestion()) {
            if (manager.handleKey(evt)) {
              evt.preventDefault();
              return true;
            }
            return false;
          }
          const p = view.plugin(suggestPlugin)?.popover;
          if (!p?.isOpen) return false;
          switch (evt.key) {
            case "ArrowDown":
              p.move(1);
              break;
            case "ArrowUp":
              p.move(-1);
              break;
            case "Enter":
            case "Tab":
              if (evt.isComposing) return false;
              p.choose();
              break;
            case "Escape":
              p.suppressedAt = p.trigger?.from ?? -1;
              p.close();
              break;
            default:
              return false;
          }
          evt.preventDefault();
          return true;
        },
        blur(_evt, view) {
          view.plugin(suggestPlugin)?.popover.close();
          return false;
        },
      }),
    ),
  ];
}
