/**
 * Keeps the app inside the part of the screen the on-screen keyboard leaves.
 *
 * iOS Safari does not shrink the layout viewport for the keyboard (a
 * `position: fixed; bottom: 0` bar ends up underneath it); Chromium on Android
 * may or may not, depending on `interactive-widget`. Both report the visible
 * area through `window.visualViewport`, so the app container is sized to it
 * (`--vault-viewport-height`, `--vault-viewport-top`) and the toolbar, which
 * sits at the bottom of that container, lands just above the keyboard.
 *
 * `--keyboard-height` is set on `<html>` as Obsidian mobile does (themes read
 * it): the drop from the tallest height seen at this width.
 */
import type { App } from "../../app";
import type { MobileLayout } from "./index";

const KEYBOARD_MIN = 120; // smaller changes are browser chrome (the URL bar), not a keyboard

export class KeyboardTracker {
  app: App;
  keyboardHeight = 0;
  private layout: MobileLayout;
  private tallest = new Map<number, number>();
  private running = false;
  private frame = 0;

  constructor(app: App, layout: MobileLayout) {
    this.app = app;
    this.layout = layout;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const vv = window.visualViewport;
    vv?.addEventListener("resize", this.schedule);
    vv?.addEventListener("scroll", this.schedule);
    window.addEventListener("resize", this.schedule);
    this.update();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    const vv = window.visualViewport;
    vv?.removeEventListener("resize", this.schedule);
    vv?.removeEventListener("scroll", this.schedule);
    window.removeEventListener("resize", this.schedule);
    cancelAnimationFrame(this.frame);
    const root = document.documentElement.style;
    root.removeProperty("--keyboard-height");
    document.body.style.removeProperty("--vault-viewport-height");
    document.body.style.removeProperty("--vault-viewport-top");
    document.body.style.removeProperty("--vault-keyboard-overlap");
    document.body.removeClass("is-keyboard-open");
    this.keyboardHeight = 0;
  }

  private schedule = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.update());
  };

  private update() {
    if (!this.running) return;
    const vv = window.visualViewport;
    const width = Math.round(vv?.width ?? window.innerWidth);
    const height = vv?.height ?? window.innerHeight;
    const top = vv?.offsetTop ?? 0;
    const tallest = Math.max(this.tallest.get(width) ?? 0, height, window.innerHeight === height ? 0 : window.innerHeight);
    this.tallest.set(width, tallest);
    const drop = tallest - height;
    const keyboard = drop >= KEYBOARD_MIN ? Math.round(drop) : 0;
    const changed = keyboard !== this.keyboardHeight;
    this.keyboardHeight = keyboard;
    document.documentElement.style.setProperty("--keyboard-height", `${keyboard}px`);
    document.body.style.setProperty("--vault-viewport-height", `${Math.round(height)}px`);
    document.body.style.setProperty("--vault-viewport-top", `${Math.round(top)}px`);
    // How much of the layout viewport the keyboard covers: fixed elements (menus, modals) stop above it.
    document.body.style.setProperty("--vault-keyboard-overlap", `${Math.max(0, Math.round(window.innerHeight - height - top))}px`);
    document.body.toggleClass("is-keyboard-open", keyboard > 0);
    if (changed) {
      this.app.workspace.trigger("resize");
      this.revealCaret();
    }
  }

  /** Scroll the focused editor so the caret stays visible above the toolbar and keyboard. */
  revealCaret() {
    if (!this.layout.active) return;
    const info = this.app.workspace.activeEditor as { editor?: { hasFocus(): boolean; getCursor(w?: string): { line: number; ch: number }; scrollIntoView(r: unknown, center?: boolean): void } } | null;
    const editor = info?.editor;
    if (!editor || !editor.hasFocus()) return;
    requestAnimationFrame(() => {
      try {
        const head = editor.getCursor("head");
        editor.scrollIntoView({ from: head, to: head }, false);
      } catch {
        /* the editor went away */
      }
    });
  }
}
