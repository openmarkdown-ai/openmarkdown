/**
 * Clicking links, URLs and tags.
 *
 * Live Preview: a plain click on rendered link text opens it (the cursor does
 * not move); Mod-click or middle-click opens in a new leaf. Source mode: only
 * Mod-click opens, so plain clicks still place the cursor.
 */
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { Platform } from "../platform";
import { OFM } from "../syntax/ofm";
import { ofmTree } from "../syntax/language";
import { editorLivePreviewField } from "../fields";
import { hostFacet, sourcePathOf } from "../facets";

export interface ClickableToken {
  type: "internal-link" | "external-link" | "tag";
  text: string;
  from: number;
  to: number;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The link/URL/tag at a document position (Obsidian's internal `editor.getClickableTokenAt`). */
export function clickableTokenAt(state: EditorState, pos: number): ClickableToken | null {
  const tree = ofmTree(state);
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      const tok = tokenFor(state, n);
      if (tok) return tok;
    }
  }
  return null;
}

function tokenFor(state: EditorState, n: SyntaxNode): ClickableToken | null {
  const doc = state.doc;
  switch (n.name) {
    case OFM.Wikilink:
    case OFM.Embed: {
      const open = n.firstChild, close = n.lastChild;
      if (!open || !close) return null;
      const pipe = n.getChild(OFM.WikilinkPipe);
      return { type: "internal-link", text: doc.sliceString(open.to, pipe ? pipe.from : close.from).replace(/\\$/, ""), from: n.from, to: n.to };
    }
    case "Link":
    case "Image": {
      const url = n.getChild("URL");
      if (!url) return null;
      let text = doc.sliceString(url.from, url.to);
      if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1);
      if (URL_SCHEME.test(text)) return { type: "external-link", text, from: n.from, to: n.to };
      let decoded = text;
      try {
        decoded = decodeURI(text);
      } catch {
        /* keep */
      }
      return { type: "internal-link", text: decoded, from: n.from, to: n.to };
    }
    case "URL":
    case "Autolink": {
      if (n.parent && (n.parent.name === "Link" || n.parent.name === "Image")) return null;
      let text = doc.sliceString(n.from, n.to).replace(/^<|>$/g, "");
      if (/^www\./i.test(text)) text = "https://" + text;
      else if (!URL_SCHEME.test(text) && text.includes("@")) text = "mailto:" + text;
      return { type: "external-link", text, from: n.from, to: n.to };
    }
    case OFM.Tag:
      return { type: "tag", text: doc.sliceString(n.from, n.to), from: n.from, to: n.to };
  }
  return null;
}

function openToken(view: EditorView, tok: ClickableToken, evt: MouseEvent) {
  const host = view.state.facet(hostFacet);
  if (!host) return;
  const newLeaf = Platform.isModEvent(evt) || evt.button === 1;
  if (tok.type === "internal-link") host.openLink(tok.text, sourcePathOf(host), newLeaf);
  else if (tok.type === "external-link") {
    if (host.openExternal) host.openExternal(tok.text);
    else window.open(tok.text, "_blank", "noopener");
  } else host.onTagClick?.(tok.text, evt);
}

const CLICKABLE = ".cm-underline, .cm-hmd-internal-link, .cm-link, .cm-url, .cm-hashtag, .external-link";

export const linkClickHandlers = EditorView.domEventHandlers({
  mousedown(evt, view) {
    if (evt.button !== 0 && evt.button !== 1) return false;
    const target = evt.target as HTMLElement | null;
    const el = target?.closest?.(CLICKABLE) as HTMLElement | null;
    if (!el || !view.contentDOM.contains(el)) return false;
    const lp = view.state.field(editorLivePreviewField, false);
    const mod = Platform.isModEvent(evt);
    // In Live Preview, rendered link text (markup hidden) opens on click; in source mode it needs Mod.
    const rendered = lp && (!!el.closest(".cm-underline") || el.classList.contains("external-link") || (!!el.closest(".cm-hashtag") && !evt.shiftKey));
    if (!rendered && !mod && evt.button !== 1) return false;
    const pos = view.posAtDOM(el);
    const tok = clickableTokenAt(view.state, pos + (el.classList.contains("external-link") ? -1 : 0));
    if (!tok) return false;
    evt.preventDefault();
    openToken(view, tok, evt);
    return true;
  },
  mouseover(evt, view) {
    const host = view.state.facet(hostFacet);
    if (!host?.onLinkHover) return false;
    const el = (evt.target as HTMLElement | null)?.closest?.(".cm-hmd-internal-link, .cm-underline") as HTMLElement | null;
    if (!el || !view.contentDOM.contains(el)) return false;
    const tok = clickableTokenAt(view.state, view.posAtDOM(el));
    if (tok?.type === "internal-link") host.onLinkHover(evt, el, tok.text, sourcePathOf(host));
    return false;
  },
});
