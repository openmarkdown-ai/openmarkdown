/**
 * Touch gestures in the mobile layout:
 *
 * - **Edge swipe**: from the left edge towards the middle opens the left
 *   sidebar, from the right edge the right one; swiping an open drawer back
 *   closes it (setting `mobileSwipeSidebars`, default on).
 * - **Pull down** at the top of a note runs the Quick Action
 *   (`mobilePullAction`, default `command-palette:open`; `""` turns it off),
 *   shown with Obsidian's `.pull-down-action` indicator.
 * - **Long press** opens the context menu of what is under the finger (files,
 *   tabs, links, headers). iOS never fires `contextmenu` for a long press;
 *   Android does, so a native one within the same press is not doubled.
 *   Text in the editor keeps the browser's own selection handles.
 */
import type { App } from "../../app";
import { setIcon } from "../../ui/icons";
import type { MobileLayout } from "./index";

const EDGE = 28;
const SWIPE = 56;
const PULL = 72;
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE = 10;

export function getPullAction(app: App): string {
  const v = app.vault.getConfig("mobilePullAction");
  return typeof v === "string" ? v : "command-palette:open";
}

export function swipeSidebarsEnabled(app: App): boolean {
  return app.vault.getConfig("mobileSwipeSidebars") !== false;
}

/** The nearest ancestor (up to `stop`) that scrolls vertically, or null. */
function scrollTopOfChain(el: Element | null, stop: Element): number {
  let top = 0;
  for (let e: Element | null = el; e && e !== stop.parentElement; e = e.parentElement) {
    if (e instanceof HTMLElement && e.scrollHeight > e.clientHeight + 1) {
      const oy = getComputedStyle(e).overflowY;
      if (oy === "auto" || oy === "scroll") top = Math.max(top, e.scrollTop);
    }
  }
  return top;
}

const NO_LONG_PRESS = ".cm-editor .cm-content, input, textarea, select, [contenteditable='true'], .mobile-toolbar, .menu, .modal-container .prompt-input";

export function installGestures(app: App, layout: MobileLayout): () => void {
  const root = app.dom.appContainerEl;
  const ws = app.workspace;

  type Mode = "none" | "open-left" | "open-right" | "close-left" | "close-right" | "pull";
  let mode: Mode = "none";
  let startX = 0;
  let startY = 0;
  let decided = false;
  let pullEl: HTMLElement | null = null;
  let pullArmed = false;

  let pressTimer = 0;
  let pressTarget: Element | null = null;
  let nativeMenuSeen = false;
  let suppressClickUntil = 0;
  let suppressNativeMenuUntil = 0;

  const modalOpen = () => !!document.querySelector(".modal-container, .mobile-tab-switcher.is-visible");

  const cancelPress = () => {
    if (pressTimer) window.clearTimeout(pressTimer);
    pressTimer = 0;
    pressTarget = null;
  };

  const hidePull = () => {
    pullEl?.remove();
    pullEl = null;
    pullArmed = false;
  };

  const onTouchStart = (evt: TouchEvent) => {
    cancelPress();
    mode = "none";
    decided = false;
    if (evt.touches.length !== 1) return;
    const t = evt.touches[0]!;
    startX = t.clientX;
    startY = t.clientY;
    const target = evt.target instanceof Element ? evt.target : null;

    // Long press
    if (target && !target.closest(NO_LONG_PRESS)) {
      pressTarget = target;
      nativeMenuSeen = false;
      pressTimer = window.setTimeout(() => {
        pressTimer = 0;
        const el = pressTarget;
        pressTarget = null;
        if (!el || nativeMenuSeen || !el.isConnected) return;
        suppressClickUntil = Date.now() + 800;
        suppressNativeMenuUntil = Date.now() + 800;
        mode = "none";
        hidePull();
        navigator.vibrate?.(10);
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 2, buttons: 2, view: window }));
      }, LONG_PRESS_MS);
    }

    if (modalOpen()) return;
    const width = window.innerWidth;
    if (layout.isDrawerOpen()) {
      mode = !ws.leftSplit.collapsed ? "close-left" : "close-right";
      return;
    }
    if (swipeSidebarsEnabled(app)) {
      if (startX <= EDGE) mode = "open-left";
      else if (startX >= width - EDGE) mode = "open-right";
    }
    if (mode !== "none") return;
    // Pull down: only from inside the note area, with it scrolled to the top.
    const leafContent = target?.closest(".mod-root .workspace-leaf-content");
    if (leafContent && getPullAction(app) && !target!.closest(".view-header, .mobile-toolbar") && scrollTopOfChain(target, leafContent) <= 0) mode = "pull";
  };

  const onTouchMove = (evt: TouchEvent) => {
    const t = evt.touches[0];
    if (!t) return;
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (pressTimer && Math.hypot(dx, dy) > MOVE_TOLERANCE) cancelPress();
    if (mode === "none") return;
    if (mode === "pull") {
      if (!decided) {
        if (Math.abs(dy) < MOVE_TOLERANCE && Math.abs(dx) < MOVE_TOLERANCE) return;
        decided = true;
        if (dy <= 0 || Math.abs(dx) > dy) {
          mode = "none";
          return;
        }
      }
      if (!pullEl) {
        const id = getPullAction(app);
        const cmd = app.commands.findCommand(id);
        if (!cmd) {
          mode = "none";
          return;
        }
        pullEl = root.createDiv({ cls: "pull-down-action" });
        const pill = pullEl.createDiv({ cls: "pull-action" });
        setIcon(pill.createSpan({ cls: "pull-action-icon" }), (cmd as { icon?: string }).icon || "lucide-arrow-down");
        pill.createSpan({ cls: "pull-action-label", text: cmd.name });
      }
      const progress = Math.min(1, Math.max(0, dy / PULL));
      pullEl.style.setProperty("--pull-progress", String(progress));
      pullArmed = dy >= PULL;
      pullEl.firstElementChild?.toggleClass("mod-activated", pullArmed);
      return;
    }
    // Horizontal swipes
    if (!decided) {
      if (Math.abs(dx) < MOVE_TOLERANCE && Math.abs(dy) < MOVE_TOLERANCE) return;
      decided = true;
      if (Math.abs(dy) > Math.abs(dx)) {
        mode = "none";
        return;
      }
    }
    if (evt.cancelable) evt.preventDefault();
    if (mode === "open-left" && dx >= SWIPE) {
      ws.leftSplit.expand();
      mode = "none";
    } else if (mode === "open-right" && dx <= -SWIPE) {
      ws.rightSplit.expand();
      mode = "none";
    } else if (mode === "close-left" && dx <= -SWIPE) {
      ws.leftSplit.collapse();
      mode = "none";
    } else if (mode === "close-right" && dx >= SWIPE) {
      ws.rightSplit.collapse();
      mode = "none";
    }
  };

  const onTouchEnd = () => {
    cancelPress();
    if (mode === "pull" && pullArmed) {
      const id = getPullAction(app);
      hidePull();
      suppressClickUntil = Date.now() + 400;
      window.setTimeout(() => app.commands.executeCommandById(id), 0);
    } else {
      hidePull();
    }
    mode = "none";
  };

  const onContextMenu = (evt: MouseEvent) => {
    if (!evt.isTrusted) return;
    if (pressTimer) {
      // The browser raised its own long-press menu first (Android): use it.
      nativeMenuSeen = true;
      cancelPress();
      suppressClickUntil = Date.now() + 800;
      return;
    }
    if (Date.now() < suppressNativeMenuUntil) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  };

  const onClick = (evt: MouseEvent) => {
    if (Date.now() < suppressClickUntil) {
      evt.preventDefault();
      evt.stopPropagation();
      suppressClickUntil = 0;
    }
  };

  const opts: AddEventListenerOptions = { capture: true, passive: true };
  const moveOpts: AddEventListenerOptions = { capture: true, passive: false };
  root.addEventListener("touchstart", onTouchStart, opts);
  root.addEventListener("touchmove", onTouchMove, moveOpts);
  root.addEventListener("touchend", onTouchEnd, opts);
  root.addEventListener("touchcancel", onTouchEnd, opts);
  window.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("click", onClick, true);
  return () => {
    cancelPress();
    hidePull();
    root.removeEventListener("touchstart", onTouchStart, opts);
    root.removeEventListener("touchmove", onTouchMove, moveOpts);
    root.removeEventListener("touchend", onTouchEnd, opts);
    root.removeEventListener("touchcancel", onTouchEnd, opts);
    window.removeEventListener("contextmenu", onContextMenu, true);
    window.removeEventListener("click", onClick, true);
  };
}
