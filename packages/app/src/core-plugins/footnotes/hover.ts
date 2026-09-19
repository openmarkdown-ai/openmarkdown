/**
 * Footnote hover preview (Obsidian: "Footnote refs preview footnote").
 *
 * Hovering a footnote reference shows its definition in a hover popover,
 * without a modifier key:
 *
 *  - Reading view (and any rendered Markdown): `sup.footnote-ref > a.footnote-link`
 *    → the rendered `li#fn-N` of the same document, cloned without its back-links.
 *  - Live Preview / Source: `.cm-footref` spans (`[^label]` and inline `^[text]`)
 *    → the `[^label]:` definition (with its indented continuation lines) or the
 *    inline text, rendered with MarkdownRenderer.
 *
 *   body > .popover.hover-popover.mod-footnote
 *     .markdown-preview-view.markdown-rendered.vault-footnote-preview
 */
import { EditorView } from "@codemirror/view";
import { hostFacet, sourcePathOf } from "../../editor/facets";
import { MarkdownRenderer } from "../../obsidian/markdown/renderer";
import type { Plugin } from "../../obsidian/plugin";
import { HoverPopover, PopoverState, type HoverParent } from "../../obsidian/ui/popover";

const WAIT = 300;

interface Active {
  key: string;
  popover: HoverPopover;
  /** Elements that count as "on the target" (the spans of one Live Preview ref). */
  isOnTarget(el: Element): boolean;
}

const fallbackParent: HoverParent = { hoverPopover: null };

const REF_RE = /\[\^([^\]\s]+)\](?!:)/g;
const INLINE_RE = /\^\[((?:[^[\]]|\[[^\]]*\])*)\]/g;

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The `[^label]:` definition in `text` (first line plus indented continuation lines), or null. */
export function footnoteDefinition(text: string, label: string): string | null {
  const lines = text.split("\n");
  const head = new RegExp(`^[ \\t]{0,3}\\[\\^${escapeRe(label)}\\]:[ \\t]?(.*)$`, "i");
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]!);
    if (!m) continue;
    const out = [m[1]!];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (/^( {4}|\t)/.test(l)) out.push(l.replace(/^( {4}|\t)/, ""));
      else if (!l.trim() && j + 1 < lines.length && /^( {4}|\t)/.test(lines[j + 1]!)) out.push("");
      else break;
    }
    return out.join("\n").trim();
  }
  return null;
}

function parentFor(plugin: Plugin, target: Element): HoverParent {
  const leaves = plugin.app.workspace.getLeavesOfType?.("markdown") ?? [];
  for (const leaf of leaves) {
    const view = leaf.view as { containerEl?: HTMLElement; hoverPopover?: HoverPopover | null } | undefined;
    if (view?.containerEl?.contains(target) && "hoverPopover" in view) return view as HoverParent;
  }
  return fallbackParent;
}

export function installFootnoteHover(plugin: Plugin): void {
  const app = plugin.app;
  let active: Active | null = null;

  const current = () => (active && active.popover.state !== PopoverState.Hidden ? active : null);

  const open = (key: string, targetEl: HTMLElement, isOnTarget: (el: Element) => boolean, fill: (el: HTMLElement, popover: HoverPopover) => void) => {
    const cur = current();
    if (cur && cur.key === key && !cur.popover.targetEl?.isConnected) cur.popover.hide();
    else if (cur && cur.key === key) {
      cur.popover.onTarget = true;
      cur.popover.transition();
      return;
    }
    const popover = new HoverPopover(parentFor(plugin, targetEl), targetEl, WAIT);
    popover.hoverEl.addClass("mod-footnote");
    const body = popover.hoverEl.createDiv({ cls: "markdown-preview-view markdown-rendered vault-footnote-preview" });
    try {
      fill(body, popover);
    } catch (e) {
      console.error("Footnote preview failed", e);
      popover.hide();
      return;
    }
    active = { key, popover, isOnTarget };
  };

  const readingRef = (target: Element) => {
    const sup = target.closest<HTMLElement>("sup.footnote-ref");
    const link = sup?.querySelector<HTMLAnchorElement>("a.footnote-link") ?? target.closest<HTMLAnchorElement>("a.footnote-link:not(.footnote-backref)");
    if (!link || link.hasClass("footnote-backref") || !link.closest(".markdown-rendered, .markdown-preview-view")) return false;
    const id = (link.getAttr("href") ?? "").replace(/^#/, "");
    if (!id) return false;
    const el = sup ?? link;
    // The definition list is a later section of the same rendered document.
    const roots = [el.closest(".markdown-preview-view"), el.closest(".markdown-embed-content"), el.closest(".markdown-rendered")].filter(Boolean) as HTMLElement[];
    let li: HTMLElement | null = null;
    for (const root of roots) {
      li = root.querySelector<HTMLElement>(`section.footnotes li[id="${CSS.escape(id)}"]`);
      if (li) break;
    }
    let fallbackText: string | null = null;
    if (!li) {
      const label = (sup?.getAttr("data-footnote-id") ?? "").replace(/^fnref-/, "");
      const parent = parentFor(plugin, el) as { data?: string };
      const data = typeof parent.data === "string" ? parent.data : "";
      fallbackText = footnoteDefinition(data, label) ?? footnoteDefinition(data, label.replace(/-\d+$/, ""));
      if (fallbackText === null) return false;
    }
    open(`reading:${id}`, el, (t) => el.contains(t), (body, popover) => {
      if (li) {
        const clone = li.cloneNode(true) as HTMLElement;
        clone.querySelectorAll(".footnote-backref").forEach((b) => b.remove());
        // A single-paragraph footnote keeps its <p>; a bare text node gets one.
        if (!clone.querySelector("p")) body.createEl("p").append(...Array.from(clone.childNodes));
        else body.append(...Array.from(clone.childNodes));
      } else {
        const parent = parentFor(plugin, el) as { file?: { path: string } };
        void MarkdownRenderer.render(app, fallbackText!, body, parent.file?.path ?? "", popover);
      }
    });
    return true;
  };

  const editorRef = (target: Element) => {
    const span = target.closest<HTMLElement>(".cm-footref");
    if (!span) return false;
    const editorEl = span.closest<HTMLElement>(".cm-editor");
    const view = editorEl ? EditorView.findFromDOM(editorEl) : null;
    if (!view) return false;
    let pos: number;
    try {
      pos = view.posAtDOM(span, 0);
    } catch {
      return false;
    }
    const line = view.state.doc.lineAt(pos);
    const col = pos - line.from;
    let found: { from: number; to: number; label?: string; inline?: string } | null = null;
    for (const m of line.text.matchAll(REF_RE)) {
      if (m.index! <= col && col < m.index! + m[0].length) found = { from: line.from + m.index!, to: line.from + m.index! + m[0].length, label: m[1]! };
    }
    if (!found) {
      for (const m of line.text.matchAll(INLINE_RE)) {
        if (m.index! <= col && col < m.index! + m[0].length) found = { from: line.from + m.index!, to: line.from + m.index! + m[0].length, inline: m[1]! };
      }
    }
    if (!found) return false;
    const markdown = found.inline ?? footnoteDefinition(view.state.doc.toString(), found.label!);
    const { from, to } = found;
    const onTarget = (el: Element) => {
      const s = el.closest?.(".cm-footref");
      if (!s || !view.dom.contains(s)) return false;
      try {
        const p = view.posAtDOM(s, 0);
        return p >= from && p < to;
      } catch {
        return false;
      }
    };
    const sourcePath = sourcePathOf(view.state.facet(hostFacet));
    open(`editor:${sourcePath}:${from}`, span, onTarget, (body, popover) => {
      if (markdown === null) {
        body.createDiv({ cls: "markdown-embed-empty", text: `Footnote [^${found!.label}] is not defined.` });
        return;
      }
      void MarkdownRenderer.render(app, markdown, body, sourcePath, popover);
    });
    return true;
  };

  plugin.registerDomEvent(document, "mouseover", (evt: MouseEvent) => {
    const target = evt.target;
    if (!(target instanceof Element)) return;
    const cur = current();
    if (cur && cur.popover.hoverEl.contains(target)) return;
    if (cur && cur.isOnTarget(target)) {
      cur.popover.onTarget = true;
      cur.popover.transition();
      return;
    }
    if (target.closest(".cm-footref")) editorRef(target);
    else if (target.closest("sup.footnote-ref, a.footnote-link")) readingRef(target);
  });

  plugin.registerDomEvent(document, "mouseout", (evt: MouseEvent) => {
    const cur = current();
    if (!cur || !(evt.target instanceof Element) || !cur.isOnTarget(evt.target)) return;
    const to = evt.relatedTarget;
    if (to instanceof Element && (cur.isOnTarget(to) || cur.popover.hoverEl.contains(to))) return;
    // Live Preview may redraw the ref under a still pointer (the old span is
    // detached, so a mouseout fires): look at what is under the pointer next frame.
    const { clientX, clientY } = evt;
    requestAnimationFrame(() => {
      if (current() !== cur) return;
      const under = document.elementFromPoint(clientX, clientY);
      if (under && (cur.isOnTarget(under) || cur.popover.hoverEl.contains(under))) return;
      cur.popover.onTarget = false;
      cur.popover.transition();
    });
  });

  plugin.register(() => {
    active?.popover.hide();
    active = null;
  });
}
