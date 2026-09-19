/**
 * Highlighter mode, injected on demand (toolbar, shortcut, context menu).
 * Injecting it again toggles it off.
 *
 * Select text to highlight it; click a highlight to remove it; Esc exits.
 * Highlights are stored per URL (without the fragment) in extension storage
 * and become `{{highlights}}` — and, by default, `==marks==` in `{{content}}`.
 */
import { getHighlights, newId, setHighlights, type StoredHighlight } from "../shared/settings";

const w = window as unknown as { __vaultClipperHighlighter?: { stop(): void } };
const MARK_CLASS = "vault-clipper-highlight";
const CONTEXT = 32;

if (w.__vaultClipperHighlighter) {
  w.__vaultClipperHighlighter.stop();
} else {
  start();
}

function textNodesIn(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const el = n.parentElement;
      if (!el || el.closest("script, style, noscript, textarea, [data-vault-clipper]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) out.push(walker.currentNode as Text);
  return out;
}

function wrapRange(range: Range, id: string) {
  const nodes = textNodesIn(range.commonAncestorContainer.nodeType === Node.TEXT_NODE ? range.commonAncestorContainer.parentNode! : range.commonAncestorContainer);
  for (const node of nodes) {
    if (!range.intersectsNode(node)) continue;
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    if (to <= from || !node.data.slice(from, to).trim()) continue;
    const r = document.createRange();
    r.setStart(node, from);
    r.setEnd(node, to);
    const mark = document.createElement("mark");
    mark.className = MARK_CLASS;
    mark.dataset.highlightId = id;
    r.surroundContents(mark);
  }
}

function unwrap(id?: string) {
  const selector = id ? `mark.${MARK_CLASS}[data-highlight-id="${CSS.escape(id)}"]` : `mark.${MARK_CLASS}`;
  document.querySelectorAll(selector).forEach((m) => {
    const parent = m.parentNode;
    m.replaceWith(...Array.from(m.childNodes));
    parent?.normalize();
  });
}

/** Finds a stored passage again, using its surrounding text to pick the right occurrence. */
function restore(h: StoredHighlight) {
  const nodes = textNodesIn(document.body);
  let flat = "";
  const starts: number[] = [];
  for (const n of nodes) {
    starts.push(flat.length);
    flat += n.data;
  }
  let at = flat.indexOf(h.prefix + h.text + h.suffix);
  if (at >= 0) at += h.prefix.length;
  else at = flat.indexOf(h.text);
  if (at < 0) return;
  const locate = (offset: number, end: boolean) => {
    for (let i = 0; i < nodes.length; i++) {
      const from = starts[i]!;
      const to = from + nodes[i]!.data.length;
      if (end ? offset > from && offset <= to : offset >= from && offset < to) return { node: nodes[i]!, offset: offset - from };
    }
    return { node: nodes[nodes.length - 1]!, offset: nodes[nodes.length - 1]!.data.length };
  };
  const s = locate(at, false);
  const e = locate(at + h.text.length, true);
  const range = document.createRange();
  range.setStart(s.node, Math.min(s.offset, s.node.data.length));
  range.setEnd(e.node, Math.min(e.offset, e.node.data.length));
  wrapRange(range, h.id);
}

function start() {
  const url = location.href;
  let highlights: StoredHighlight[] = [];

  const style = document.createElement("style");
  style.dataset.vaultClipper = "";
  style.textContent = `mark.${MARK_CLASS}{background:rgba(21,185,235,.28);color:inherit;border-radius:2px;cursor:pointer;box-shadow:0 0 0 1px rgba(21,185,235,.35)}
mark.${MARK_CLASS}:hover{background:rgba(255,77,77,.25)}
html.vault-clipper-highlighting ::selection{background:rgba(21,185,235,.45)}`;
  document.documentElement.appendChild(style);
  document.documentElement.classList.add("vault-clipper-highlighting");

  // A small status bar in a closed shadow root, so page CSS cannot touch it.
  const host = document.createElement("div");
  host.dataset.vaultClipper = "";
  host.style.cssText = "position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%)";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>
  .bar{display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:999px;background:#020202;color:#fff;
       font:500 13px/1.3 "Geist","Helvetica Neue",Arial,sans-serif;box-shadow:0 4px 8px rgba(0,0,0,.05),0 12px 32px rgba(0,0,0,.18)}
  .dot{width:7px;height:7px;border-radius:50%;background:#15b9eb}
  .count{color:rgba(255,255,255,.6)}
  button{font:inherit;color:#fff;background:rgba(255,255,255,.1);border:0;border-radius:999px;height:28px;padding:0 12px;cursor:pointer}
  button:hover{background:rgba(255,255,255,.2)}
  </style><div class="bar" role="status"><span class="dot"></span><span>Highlighter on</span><span class="count"></span><button type="button">Done</button></div>`;
  const count = shadow.querySelector(".count") as HTMLElement;
  shadow.querySelector("button")!.addEventListener("click", () => stop());
  document.documentElement.appendChild(host);

  const render = () => (count.textContent = highlights.length === 1 ? "1 highlight" : `${highlights.length} highlights`);
  const persist = () => setHighlights(url, highlights).then(render);

  void getHighlights(url).then((stored) => {
    highlights = stored;
    for (const h of highlights) {
      try {
        restore(h);
      } catch {
        /* the page changed; the stored text is still clipped */
      }
    }
    render();
  });

  const onMouseUp = (e: MouseEvent) => {
    if ((e.target as Element | null)?.closest?.("[data-vault-clipper]")) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const text = sel.toString();
    if (!text.trim()) return;
    const box = document.createElement("div");
    box.appendChild(range.cloneContents());
    const id = newId();
    // Context for re-finding the passage after a reload.
    const before = document.createRange();
    before.setStart(document.body, 0);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.setStart(range.endContainer, range.endOffset);
    after.setEndAfter(document.body.lastChild ?? document.body);
    const h: StoredHighlight = {
      id,
      text,
      html: box.innerHTML,
      prefix: before.toString().slice(-CONTEXT),
      suffix: after.toString().slice(0, CONTEXT),
      createdAt: Date.now(),
    };
    wrapRange(range, id);
    sel.removeAllRanges();
    highlights.push(h);
    void persist();
  };

  const onClick = (e: MouseEvent) => {
    const mark = (e.target as Element | null)?.closest?.(`mark.${MARK_CLASS}`) as HTMLElement | null;
    if (!mark || window.getSelection()?.toString()) return;
    e.preventDefault();
    e.stopPropagation();
    const id = mark.dataset.highlightId!;
    unwrap(id);
    highlights = highlights.filter((h) => h.id !== id);
    void persist();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") stop();
  };

  function stop() {
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    unwrap();
    host.remove();
    style.remove();
    document.documentElement.classList.remove("vault-clipper-highlighting");
    delete w.__vaultClipperHighlighter;
  }

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  w.__vaultClipperHighlighter = { stop };
}
