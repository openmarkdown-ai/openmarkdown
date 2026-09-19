/**
 * Writing focus (`writing-focus`) — hidden, always-on core plugin.
 *
 * Commands:
 *   editor:toggle-focus-mode  "Toggle focus mode"            Mod+Shift+Enter
 *   editor:toggle-typewriter  "Toggle typewriter scrolling"  (flips app.json `typewriterScroll`)
 *   editor:toggle-zen         "Toggle full-screen writing"   (Fullscreen API + focus mode)
 *
 * Focus mode puts `vault-focus-mode` on <body> (styles/writing.css hides the
 * ribbon, sidebars, tab headers, view header and status bar; the saved layout
 * is untouched) and tells every editor to dim what is outside the current
 * paragraph/sentence/line (`focusDim`). Escape leaves it. Full-screen writing
 * adds `vault-zen-mode`; leaving full screen (Esc, F11) leaves it.
 *
 * Also hosts the per-note cursor/scroll memory (remember.ts).
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Notice } from "../../obsidian/ui/notice";
import { isFocusModeActive, setFocusModeActive } from "../../editor/focus";
import { CursorMemory } from "./remember";

class WritingFocusPlugin extends Plugin {
  instance!: any;
  private zen = false;
  private hintEl: HTMLElement | null = null;
  private hintTimer = 0;
  private lastEscape = 0;
  memory!: CursorMemory;

  override onload() {
    this.addCommand({
      id: "editor:toggle-focus-mode",
      name: "Toggle focus mode",
      icon: "lucide-focus",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Enter" }] as never,
      callback: () => this.setFocus(!isFocusModeActive()),
    });
    this.addCommand({
      id: "editor:toggle-typewriter",
      name: "Toggle typewriter scrolling",
      icon: "lucide-type",
      callback: () => {
        const on = !this.app.vault.getConfig("typewriterScroll");
        this.app.vault.setConfig("typewriterScroll", on);
        new Notice(on ? "Typewriter scrolling on" : "Typewriter scrolling off", 1500);
      },
    });
    this.addCommand({
      id: "editor:toggle-zen",
      name: "Toggle full-screen writing",
      icon: "lucide-maximize",
      callback: () => void this.setZen(!this.zen),
    });

    this.registerDomEvent(document, "keydown", (evt) => this.onEscape(evt));
    this.registerDomEvent(document, "fullscreenchange", () => {
      if (!document.fullscreenElement && this.zen) {
        this.zen = false;
        document.body.removeClass("vault-zen-mode");
        this.setFocus(false);
      }
    });
    this.register(() => {
      if (isFocusModeActive()) this.setFocus(false);
      if (this.zen && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    });

    this.memory = new CursorMemory(this);
    this.memory.load();
    // internal (tests, other features): the focus/zen state and cursor memory
    this.instance.isFocusMode = () => isFocusModeActive();
    this.instance.setFocusMode = (on: boolean) => this.setFocus(on);
    this.instance.memory = this.memory;
  }

  // internal
  setFocus(on: boolean) {
    setFocusModeActive(on);
    document.body.toggleClass("vault-focus-mode", on);
    if (on) this.showHint();
    else this.hideHint();
    this.app.workspace.trigger("layout-change");
    // The editor keeps focus (hidden chrome may have held it).
    const editor = this.app.workspace.activeEditor?.editor;
    if (on && editor && !editor.hasFocus?.()) editor.focus();
    if (!on && this.zen) void this.setZen(false);
  }

  private async setZen(on: boolean) {
    if (on) {
      const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      const request = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root);
      this.zen = true;
      document.body.addClass("vault-zen-mode");
      if (!isFocusModeActive()) this.setFocus(true);
      if (!request || document.fullscreenEnabled === false) {
        new Notice("Full screen is not available in this browser. Focus mode is on instead.");
        return;
      }
      try {
        await request();
      } catch {
        new Notice("The browser refused full screen. Focus mode is on instead.");
      }
      return;
    }
    this.zen = false;
    document.body.removeClass("vault-zen-mode");
    if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
    if (isFocusModeActive()) this.setFocus(false);
  }

  private onEscape(evt: KeyboardEvent) {
    if (evt.key !== "Escape" || !isFocusModeActive() || evt.isComposing) return;
    if (document.querySelector(".modal-container, .menu, .suggestion-container, .cm-tooltip-autocomplete, .popover.hover-popover")) return;
    const vim = !!this.app.vault.getConfig("vimMode");
    if (evt.defaultPrevented) {
      // Vim (or a panel) used the key; with Vim a second Escape in a row leaves focus mode.
      if (!vim) return;
      const now = Date.now();
      if (now - this.lastEscape > 800) {
        this.lastEscape = now;
        return;
      }
    }
    this.lastEscape = 0;
    this.setFocus(false);
  }

  private showHint() {
    this.hideHint();
    const el = document.body.createDiv({ cls: "vault-focus-hint", text: "Focus mode — Esc to exit" });
    this.hintEl = el;
    this.hintTimer = window.setTimeout(() => el.addClass("is-fading"), 1800);
  }

  private hideHint() {
    window.clearTimeout(this.hintTimer);
    this.hintEl?.remove();
    this.hintEl = null;
  }
}

export const writingFocus: CorePluginDefinition = {
  id: "writing-focus",
  name: "Writing focus",
  description: "Focus mode, typewriter scrolling, full-screen writing and per-note cursor memory.",
  defaultOn: true,
  hidden: true,
  defaultOptions: {},
  create: (app) => new WritingFocusPlugin(app, { id: "writing-focus", name: "Writing focus", version: "", minAppVersion: "", author: "", description: "" }),
};
