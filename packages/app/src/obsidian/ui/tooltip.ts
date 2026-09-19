/**
 * Tooltips: `setTooltip` and `displayTooltip`.
 *
 * As in Obsidian, a hover tooltip is driven by the element's `aria-label`:
 * `setTooltip` writes the label (plus `data-tooltip-*` attributes for its
 * options) and one delegated `mouseover` listener per document shows the
 * tooltip for whichever labelled element is under the pointer. Plugins that set
 * `aria-label` directly get tooltips too, which they rely on.
 *
 * DOM: `<div class="tooltip [mod-left|mod-right|mod-top]"><div class="tooltip-arrow"></div>text</div>`
 * appended to the document body. Bottom placement has no modifier class.
 */
import type { TooltipOptions, TooltipPlacement } from "obsidian";

const DEFAULT_DELAY = 300;
const DEFAULT_GAP = 8;
/** After a tooltip hides, another shows without delay for this long. */
const WARM_MS = 400;

interface TooltipState {
  el: HTMLElement;
  target: HTMLElement | null;
  showTimer: number | null;
  lastHidden: number;
  cleanup: (() => void) | null;
}

const states = new WeakMap<Document, TooltipState>();
const installedDocs = new WeakSet<Document>();

function stateFor(doc: Document): TooltipState {
  let s = states.get(doc);
  if (!s) {
    const el = doc.createElement("div");
    el.className = "tooltip";
    s = { el, target: null, showTimer: null, lastHidden: 0, cleanup: null };
    states.set(doc, s);
  }
  return s;
}

function readOptions(el: HTMLElement): TooltipOptions {
  const placement = el.getAttribute("data-tooltip-position") as TooltipPlacement | null;
  const delay = el.getAttribute("data-tooltip-delay");
  const gap = el.getAttribute("data-tooltip-gap");
  const classes = el.getAttribute("data-tooltip-classes");
  return {
    placement: placement ?? undefined,
    delay: delay !== null ? Number(delay) : undefined,
    gap: gap !== null ? Number(gap) : undefined,
    classes: classes ? classes.split(" ").filter(Boolean) : undefined,
  };
}

/** Show a tooltip on hover over `el`. An empty string removes it. */
export function setTooltip(el: HTMLElement, tooltip: string, options?: TooltipOptions): void {
  installTooltips(el.ownerDocument);
  if (!tooltip) {
    el.removeAttribute("aria-label");
  } else {
    el.setAttribute("aria-label", tooltip);
  }
  if (options?.placement) el.setAttribute("data-tooltip-position", options.placement);
  else el.removeAttribute("data-tooltip-position");
  if (options?.delay !== undefined) el.setAttribute("data-tooltip-delay", String(options.delay));
  else el.removeAttribute("data-tooltip-delay");
  if (options?.gap !== undefined) el.setAttribute("data-tooltip-gap", String(options.gap));
  else el.removeAttribute("data-tooltip-gap");
  if (options?.classes?.length) el.setAttribute("data-tooltip-classes", options.classes.join(" "));
  else el.removeAttribute("data-tooltip-classes");
  const s = states.get(el.ownerDocument);
  if (s && s.target === el) {
    if (tooltip) displayTooltip(el, tooltip, options);
    else hideTooltip(el.ownerDocument);
  }
}

/** Manually show a tooltip over `newTargetEl` now. */
export function displayTooltip(newTargetEl: HTMLElement, content: string | DocumentFragment, options?: TooltipOptions): void {
  const doc = newTargetEl.ownerDocument;
  const s = stateFor(doc);
  if (s.showTimer !== null) {
    clearTimeout(s.showTimer);
    s.showTimer = null;
  }
  s.cleanup?.();
  s.cleanup = null;

  const el = s.el;
  el.className = "tooltip";
  el.textContent = "";
  const arrow = doc.createElement("div");
  arrow.className = "tooltip-arrow";
  el.appendChild(arrow);
  if (typeof content === "string") el.appendChild(doc.createTextNode(content));
  else el.appendChild(content);
  const placement: TooltipPlacement = options?.placement ?? "bottom";
  if (placement !== "bottom") el.classList.add(`mod-${placement}`);
  for (const c of options?.classes ?? []) if (c) el.classList.add(c);
  el.style.left = "0px";
  el.style.top = "0px";
  el.style.removeProperty("width");
  if (!el.isConnected) doc.body.appendChild(el);
  s.target = newTargetEl;

  position(el, arrow, newTargetEl, placement, options?.gap ?? DEFAULT_GAP);

  const win = doc.defaultView ?? window;
  const hide = () => hideTooltip(doc);
  const onLeave = () => hide();
  const onScroll = (e: Event) => {
    if (e.target instanceof Node && el.contains(e.target)) return;
    hide();
  };
  newTargetEl.addEventListener("mouseleave", onLeave);
  newTargetEl.addEventListener("pointerdown", onLeave);
  win.addEventListener("scroll", onScroll, true);
  win.addEventListener("keydown", onLeave, true);
  win.addEventListener("blur", onLeave);
  // Hide when the target is removed from the page.
  const observer = new MutationObserver(() => {
    if (!newTargetEl.isConnected) hide();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  s.cleanup = () => {
    newTargetEl.removeEventListener("mouseleave", onLeave);
    newTargetEl.removeEventListener("pointerdown", onLeave);
    win.removeEventListener("scroll", onScroll, true);
    win.removeEventListener("keydown", onLeave, true);
    win.removeEventListener("blur", onLeave);
    observer.disconnect();
  };
}

function position(el: HTMLElement, arrow: HTMLElement, target: HTMLElement, placement: TooltipPlacement, gap: number) {
  const win = target.ownerDocument.defaultView ?? window;
  const r = target.getBoundingClientRect();
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const margin = 4;
  let w = el.offsetWidth;
  const maxW = Math.max(120, vw - margin * 2);
  if (w > maxW) {
    el.style.width = `${maxW}px`;
    w = maxW;
  }
  const h = el.offsetHeight;

  // Flip when the preferred side has no room.
  let side = placement;
  if (side === "bottom" && r.bottom + gap + h > vh && r.top - gap - h >= 0) side = "top";
  else if (side === "top" && r.top - gap - h < 0 && r.bottom + gap + h <= vh) side = "bottom";
  else if (side === "right" && r.right + gap + w > vw && r.left - gap - w >= 0) side = "left";
  else if (side === "left" && r.left - gap - w < 0 && r.right + gap + w <= vw) side = "right";
  if (side !== placement) {
    el.classList.remove(`mod-${placement}`);
    if (side !== "bottom") el.classList.add(`mod-${side}`);
  }

  let left: number;
  let top: number;
  if (side === "bottom" || side === "top") {
    left = r.left + r.width / 2 - w / 2;
    top = side === "bottom" ? r.bottom + gap : r.top - gap - h;
  } else {
    top = r.top + r.height / 2 - h / 2;
    left = side === "right" ? r.right + gap : r.left - gap - w;
  }
  const clampedLeft = Math.min(Math.max(left, margin), vw - w - margin);
  const clampedTop = Math.min(Math.max(top, margin), vh - h - margin);
  el.style.left = `${Math.round(clampedLeft)}px`;
  el.style.top = `${Math.round(clampedTop)}px`;
  // Keep the arrow pointing at the target's centre after clamping.
  if (side === "bottom" || side === "top") {
    arrow.style.left = `${Math.round(r.left + r.width / 2 - clampedLeft)}px`;
    arrow.style.removeProperty("top");
  } else {
    arrow.style.top = `${Math.round(r.top + r.height / 2 - clampedTop)}px`;
    arrow.style.removeProperty("left");
  }
}

/** internal: hide the tooltip currently shown in `doc`. */
export function hideTooltip(doc: Document = activeDocumentOr()): void {
  const s = states.get(doc);
  if (!s) return;
  if (s.showTimer !== null) {
    clearTimeout(s.showTimer);
    s.showTimer = null;
  }
  s.cleanup?.();
  s.cleanup = null;
  if (s.el.isConnected) {
    s.el.remove();
    s.lastHidden = Date.now();
  }
  s.target = null;
}

function activeDocumentOr(): Document {
  return (globalThis as { activeDocument?: Document }).activeDocument ?? document;
}

/**
 * internal: install the delegated hover listener on a document. Called lazily
 * by `setTooltip` and once for the main document at import time; pop-out
 * windows call it when they open.
 */
export function installTooltips(doc: Document): void {
  if (installedDocs.has(doc)) return;
  installedDocs.add(doc);
  // A tap raises compatibility mouseover events; touch has no hover, so no tooltip.
  let lastTouch = 0;
  doc.addEventListener("touchstart", () => void (lastTouch = Date.now()), { capture: true, passive: true });
  doc.addEventListener(
    "mouseover",
    (evt: MouseEvent) => {
      if ((evt as PointerEvent).pointerType === "touch") return;
      if (Date.now() - lastTouch < 1500 || doc.body?.classList.contains("is-mobile")) return;
      const t = evt.target;
      if (!(t instanceof Element)) return;
      const target = t.closest<HTMLElement>("[aria-label]");
      const s = stateFor(doc);
      if (!target || target.closest(".tooltip")) return;
      if (target === s.target) return;
      const label = target.getAttribute("aria-label");
      if (!label || target.hasAttribute("data-tooltip-disabled")) return;
      const opts = readOptions(target);
      if (s.showTimer !== null) clearTimeout(s.showTimer);
      const warm = s.el.isConnected || Date.now() - s.lastHidden < WARM_MS;
      const delay = warm ? 0 : (opts.delay ?? DEFAULT_DELAY);
      const show = () => {
        s.showTimer = null;
        if (!target.isConnected || !target.matches(":hover")) return;
        const current = target.getAttribute("aria-label");
        if (current) displayTooltip(target, current, opts);
      };
      if (delay <= 0) show();
      else s.showTimer = window.setTimeout(show, delay);
    },
    true,
  );
}

if (typeof document !== "undefined") installTooltips(document);
