/**
 * HoverPopover — the floating container page previews render into.
 *
 * Lifecycle: constructing a popover registers it as `parent.hoverPopover`
 * (closing whatever popover that parent had) and starts the `waitTime` timer.
 * If the pointer leaves the target first, it never shows. Once shown, it stays
 * while the pointer is over the target, over the popover, over a child popover
 * opened from inside it, or while focus is inside it; otherwise it hides after
 * a short grace period, which lets the pointer cross the gap between target
 * and popover. A popover is itself a `HoverParent`, so previews nest.
 *
 * DOM: `body > .popover.hover-popover`. Rendering the note is the Page
 * Preview plugin's job; this class only hosts `hoverEl`.
 */
import type { Point } from "obsidian";
import { Component } from "../events";

/**
 * Anything that can own a hover popover (a view, a leaf, a popover). Declared
 * here against this module's HoverPopover class rather than the d.ts one, so
 * the app's own classes type-check against the real implementation.
 */
export interface HoverParent {
  hoverPopover: HoverPopover | null;
}

export enum PopoverState {
  Showing,
  Shown,
  Hiding,
  Hidden,
}

const DEFAULT_WAIT = 300;
const HIDE_DELAY = 300;
const GAP = 8;
const MARGIN = 8;

export class HoverPopover extends Component implements HoverParent {
  hoverEl: HTMLElement;
  state: PopoverState;
  // internal
  parent: HoverParent;
  // internal
  targetEl: HTMLElement | null;
  // internal
  waitTime: number;
  // internal
  staticPos: Point | null;
  // HoverParent: a popover opened from inside this one.
  hoverPopover: HoverPopover | null = null;
  // internal
  onTarget: boolean;
  // internal
  onHover = false;
  // internal: keeps the popover open regardless of the pointer (e.g. while dragging).
  isPinned = false;
  private timer: number | null = null;
  private lastPointer: Point | null = null;
  private placeAbove: boolean | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private detachTargetListeners: (() => void) | null = null;

  constructor(parent: HoverParent, targetEl: HTMLElement | null, waitTime?: number, staticPos?: Point | null) {
    super();
    this.parent = parent;
    this.targetEl = targetEl;
    this.waitTime = waitTime ?? DEFAULT_WAIT;
    this.staticPos = staticPos ?? null;
    this.state = PopoverState.Showing;
    this.onTarget = true;

    const previous = parent.hoverPopover;
    if (previous && previous !== this) previous.hide();
    parent.hoverPopover = this;

    this.hoverEl = createDiv({ cls: ["popover", "hover-popover"] });
    this.hoverEl.addEventListener("mouseenter", () => {
      this.onHover = true;
      this.transition();
    });
    this.hoverEl.addEventListener("mouseleave", () => {
      this.onHover = false;
      // A popover without a target (static position) lives until the pointer
      // has been over it and left.
      if (!this.targetEl) this.onTarget = false;
      this.transition();
    });

    if (targetEl) {
      const enter = (evt: MouseEvent) => {
        this.lastPointer = { x: evt.clientX, y: evt.clientY };
        this.onTarget = true;
        this.transition();
      };
      const move = (evt: MouseEvent) => {
        this.lastPointer = { x: evt.clientX, y: evt.clientY };
      };
      const leave = () => {
        this.onTarget = false;
        this.transition();
      };
      targetEl.addEventListener("mouseenter", enter);
      targetEl.addEventListener("mousemove", move);
      targetEl.addEventListener("mouseleave", leave);
      this.detachTargetListeners = () => {
        targetEl.removeEventListener("mouseenter", enter);
        targetEl.removeEventListener("mousemove", move);
        targetEl.removeEventListener("mouseleave", leave);
      };
    }

    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.state === PopoverState.Showing) this.show();
    }, this.waitTime);
  }

  // internal
  shouldShowSelf(): boolean {
    if (this.isPinned || this.onTarget || this.onHover) return true;
    const active = this.hoverEl.ownerDocument.activeElement;
    return !!active && active !== this.hoverEl.ownerDocument.body && this.hoverEl.contains(active);
  }

  // internal
  shouldShowChild(): boolean {
    const child = this.hoverPopover;
    return !!child && child.state !== PopoverState.Hidden && (child.shouldShowSelf() || child.shouldShowChild());
  }

  // internal
  shouldShow(): boolean {
    return this.shouldShowSelf() || this.shouldShowChild();
  }

  // internal: react to the pointer entering or leaving the target/popover.
  transition(): void {
    if (this.shouldShow()) {
      if (this.state === PopoverState.Hiding) {
        this.clearTimer();
        this.state = PopoverState.Shown;
      }
      return;
    }
    if (this.state === PopoverState.Showing) {
      this.hide();
    } else if (this.state === PopoverState.Shown) {
      this.state = PopoverState.Hiding;
      this.clearTimer();
      this.timer = window.setTimeout(() => {
        this.timer = null;
        if (this.shouldShow()) this.state = PopoverState.Shown;
        else this.hide();
      }, HIDE_DELAY);
    }
  }

  // internal
  show(): void {
    if (this.state !== PopoverState.Showing) return;
    const doc = this.targetEl?.ownerDocument ?? ((globalThis as { activeDocument?: Document }).activeDocument ?? document);
    if (this.targetEl && !this.targetEl.isConnected) {
      this.hide();
      return;
    }
    // A target the pointer left before this popover was constructed (the
    // caller may have awaited something) never sent us a mouseleave.
    if (this.targetEl && !this.targetEl.matches(":hover") && !this.hoverEl.matches(":hover")) this.onTarget = false;
    this.state = PopoverState.Shown;
    this.hoverEl.style.visibility = "hidden";
    doc.body.appendChild(this.hoverEl);
    this.position();
    this.hoverEl.style.visibility = "";
    this.load();

    this.registerDomEvent(doc, "pointerdown", (evt: PointerEvent) => {
      const t = evt.target;
      if (t instanceof Node && (this.hoverEl.contains(t) || this.containsInChild(t))) return;
      if (t instanceof Node && this.targetEl?.contains(t)) return;
      this.hide();
    }, true);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.state === PopoverState.Shown || this.state === PopoverState.Hiding) this.position();
      });
      this.resizeObserver.observe(this.hoverEl);
      this.register(() => {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
      });
    }
    try {
      this.onShow();
    } catch (e) {
      console.error(e);
    }
    // The pointer may have left while the popover was being built.
    this.transition();
  }

  hide(): void {
    if (this.state === PopoverState.Hidden) return;
    this.state = PopoverState.Hidden;
    this.clearTimer();
    this.hoverPopover?.hide();
    this.hoverPopover = null;
    this.detachTargetListeners?.();
    this.detachTargetListeners = null;
    this.hoverEl.detach();
    if (this.parent.hoverPopover === this) this.parent.hoverPopover = null;
    this.unload();
    try {
      this.onHide();
    } catch (e) {
      console.error(e);
    }
    if (this.parent instanceof HoverPopover) this.parent.transition();
  }

  /** Called after the popover is attached and positioned. */
  onShow(): void {}

  /** Called after the popover is removed. */
  onHide(): void {}

  private containsInChild(node: Node): boolean {
    let child = this.hoverPopover;
    while (child) {
      if (child.hoverEl.contains(node)) return true;
      child = child.hoverPopover;
    }
    return false;
  }

  private clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private anchorRect(): DOMRect | null {
    const target = this.targetEl;
    if (!target) return null;
    const rects = Array.from(target.getClientRects());
    if (rects.length > 1 && this.lastPointer) {
      const p = this.lastPointer;
      const hit = rects.find((r) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom);
      if (hit) return hit;
    }
    return rects[0] ?? target.getBoundingClientRect();
  }

  /** For a target inside a side dock: the side with room for the popover, or null to place it below/above. */
  private sideOf(r: DOMRect, w: number, vw: number): "left" | "right" | null {
    const dock = this.targetEl?.closest(".workspace-split.mod-left-split, .workspace-split.mod-right-split, .workspace-drawer");
    if (!dock || this.targetEl?.closest(".popover")) return null;
    const roomRight = vw - r.right - GAP - MARGIN;
    const roomLeft = r.left - GAP - MARGIN;
    const preferRight = !dock.matches(".mod-right-split, .mod-right");
    if (preferRight ? roomRight >= w : roomLeft >= w) return preferRight ? "right" : "left";
    if (preferRight ? roomLeft >= w : roomRight >= w) return preferRight ? "left" : "right";
    return null;
  }

  // internal
  position(): void {
    const doc = this.hoverEl.ownerDocument;
    const win = doc.defaultView ?? window;
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const w = this.hoverEl.offsetWidth;
    const h = this.hoverEl.offsetHeight;
    let left: number;
    let top: number;
    if (this.staticPos || !this.targetEl) {
      const p = this.staticPos ?? this.lastPointer ?? { x: vw / 2, y: vh / 2 };
      left = p.x;
      top = p.y + GAP;
      if (top + h > vh - MARGIN) top = p.y - GAP - h;
    } else {
      const r = this.anchorRect()!;
      const side = this.sideOf(r, w, vw);
      if (side) {
        // A row in a sidebar (file explorer, bookmarks, search results): beside the row, so the list stays visible.
        left = side === "right" ? r.right + GAP : r.left - GAP - w;
        top = r.top;
      } else {
        const below = vh - r.bottom - GAP - MARGIN;
        const above = r.top - GAP - MARGIN;
        if (this.placeAbove === null) this.placeAbove = h > below && above > below;
        top = this.placeAbove ? r.top - GAP - h : r.bottom + GAP;
        left = r.left;
      }
    }
    left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - w - MARGIN));
    top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, vh - h - MARGIN));
    this.hoverEl.style.left = `${Math.round(left)}px`;
    this.hoverEl.style.top = `${Math.round(top)}px`;
  }
}
