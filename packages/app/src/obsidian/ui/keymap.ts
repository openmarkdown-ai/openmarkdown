/**
 * Keymap and Scope — keyboard routing.
 *
 * One `keydown` listener per window (installed by `Keymap.install`) hands each
 * event to the *active* scope: the top of the stack pushed by modals, menus
 * and suggestion popovers, or the root scope (`app.scope`) when the stack is
 * empty. A scope that has no handler for the key defers to its `parent`, so a
 * suggest popover inside a modal can leave keys it does not care about to the
 * modal. A handler that returns `false` has handled the key: the event's
 * default is prevented and it stops propagating, so CodeMirror or the focused
 * input never sees it.
 *
 * The listener runs in the capture phase: a hotkey or an open popover must win
 * over the editor, as it does in Obsidian.
 */
import type { Hotkey, KeymapContext, KeymapEventHandler, KeymapEventListener, KeymapInfo, Modifier, PaneType, UserEvent } from "obsidian";

// Apple platforms use ⌘ for Mod. iPhone/iPad are also recognised by the user agent: `navigator.platform`
// is not reliable there (emulators and some WebViews report the host's or an empty platform).
const IS_MAC =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad|iPod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent) ||
    /iPhone|iPad|iPod/.test(navigator.userAgent));

/** Internal: whether `Mod` means Cmd (macOS/iOS) rather than Ctrl. */
export function isMacPlatform(): boolean {
  return IS_MAC;
}

/** Physical modifiers in the canonical order used by compiled modifier strings. */
const PHYSICAL_ORDER = ["Alt", "Ctrl", "Meta", "Shift"] as const;
type Physical = (typeof PHYSICAL_ORDER)[number];

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "OS", "Hyper", "Super", "CapsLock", "Fn"]);

/** Turn `["Mod","Shift"]` into the canonical `"Meta,Shift"` (mac) / `"Ctrl,Shift"`. */
export function compileModifiers(modifiers: readonly string[]): string {
  const set = new Set<Physical>();
  for (const m of modifiers) {
    switch (m) {
      case "Mod":
        set.add(IS_MAC ? "Meta" : "Ctrl");
        break;
      case "Ctrl":
      case "Meta":
      case "Shift":
      case "Alt":
        set.add(m);
        break;
    }
  }
  return PHYSICAL_ORDER.filter((m) => set.has(m)).join(",");
}

/** The canonical modifier string of an event (`"Ctrl,Shift"`). */
export function getEventModifiers(evt: MouseEvent | TouchEvent | KeyboardEvent): string {
  const out: string[] = [];
  if (evt.altKey) out.push("Alt");
  if (evt.ctrlKey) out.push("Ctrl");
  if (evt.metaKey) out.push("Meta");
  if (evt.shiftKey) out.push("Shift");
  return out.join(",");
}

/**
 * The "virtual key" of an event: the layout-independent key the user meant.
 * Alt+P on a Mac types "π" and Shift+2 types "@"; hotkeys still need "P" and
 * "2", so letters and digits come from `code`.
 */
export function getVirtualKey(evt: KeyboardEvent): string {
  const code = evt.code ?? "";
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!;
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1]!;
  if (code === "Space" || evt.key === " ") return " ";
  const key = evt.key ?? "";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function keyEquals(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  // "Space" and " " name the same key.
  if ((la === "space" && lb === " ") || (la === " " && lb === "space")) return true;
  return false;
}

export interface ScopeHandler extends KeymapEventHandler {
  func: KeymapEventListener;
}

export class Scope {
  // internal (used by plugins: hotkey inspectors read `app.scope.keys`)
  keys: ScopeHandler[] = [];
  // internal
  parent: Scope | undefined;
  // internal: when set, Tab/Shift+Tab cycle focus inside this element.
  tabFocusContainerEl: HTMLElement | null = null;

  constructor(parent?: Scope) {
    this.parent = parent;
  }

  register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventListener): KeymapEventHandler {
    const handler: ScopeHandler = {
      scope: this,
      modifiers: modifiers === null ? null : compileModifiers(modifiers),
      key,
      func,
    };
    this.keys.push(handler);
    return handler;
  }

  unregister(handler: KeymapEventHandler): void {
    const i = this.keys.indexOf(handler as ScopeHandler);
    if (i !== -1) this.keys.splice(i, 1);
  }

  // internal
  setTabFocusContainerEl(el: HTMLElement | null): void {
    this.tabFocusContainerEl = el;
  }

  /**
   * internal: run the first matching handler in this scope, else the parent's.
   * Returns `false` when a handler handled the key (and prevents default).
   */
  handleKey(evt: KeyboardEvent, ctx: KeymapContext): false | unknown {
    for (const handler of this.keys.slice()) {
      if (handler.modifiers !== null && handler.modifiers !== ctx.modifiers) continue;
      if (handler.key !== null && !keyEquals(handler.key, ctx.key ?? "") && !keyEquals(handler.key, ctx.vkey)) continue;
      let result: unknown;
      try {
        result = handler.func(evt, ctx);
      } catch (e) {
        console.error(e);
        result = false;
      }
      if (result === false) evt.preventDefault();
      // The first matching handler owns the key; the parent is consulted
      // only when nothing in this scope matched.
      return result;
    }
    if (this.tabFocusContainerEl && ctx.key === "Tab" && (ctx.modifiers === "" || ctx.modifiers === "Shift")) {
      if (cycleFocus(this.tabFocusContainerEl, ctx.modifiers === "Shift")) {
        evt.preventDefault();
        return false;
      }
    }
    if (this.parent && this.parent !== this) return this.parent.handleKey(evt, ctx);
    return undefined;
  }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Internal: move focus to the next/previous focusable element inside `container`, wrapping. */
export function cycleFocus(container: HTMLElement, backwards: boolean): boolean {
  const els = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  );
  if (els.length === 0) return false;
  const active = container.ownerDocument.activeElement as HTMLElement | null;
  const i = active ? els.indexOf(active) : -1;
  let next: number;
  if (i === -1) next = backwards ? els.length - 1 : 0;
  else next = (i + (backwards ? -1 : 1) + els.length) % els.length;
  els[next]!.focus();
  return true;
}

export class Keymap {
  // internal
  rootScope: Scope;
  // internal: the pushed scopes, last is active
  scopes: Scope[] = [];
  // internal: modifiers currently held, canonical string
  modifiers = "";
  private installedWindows = new Set<Window>();

  constructor(rootScope?: Scope) {
    this.rootScope = rootScope ?? new Scope();
    this.onKeyEvent = this.onKeyEvent.bind(this);
  }

  pushScope(scope: Scope): void {
    const i = this.scopes.indexOf(scope);
    if (i !== -1) this.scopes.splice(i, 1);
    this.scopes.push(scope);
  }

  popScope(scope: Scope): void {
    const i = this.scopes.indexOf(scope);
    if (i !== -1) this.scopes.splice(i, 1);
  }

  // internal
  getRootScope(): Scope {
    return this.rootScope;
  }

  // internal
  getActiveScope(): Scope {
    return this.scopes[this.scopes.length - 1] ?? this.rootScope;
  }

  // internal: attach the dispatcher to a window (main or pop-out).
  install(win: Window = window): () => void {
    if (this.installedWindows.has(win)) return () => this.uninstall(win);
    this.installedWindows.add(win);
    win.addEventListener("keydown", this.onKeyEvent, true);
    win.addEventListener("keyup", this.onKeyEvent, true);
    return () => this.uninstall(win);
  }

  // internal
  uninstall(win: Window): void {
    if (!this.installedWindows.delete(win)) return;
    win.removeEventListener("keydown", this.onKeyEvent, true);
    win.removeEventListener("keyup", this.onKeyEvent, true);
  }

  // internal
  updateModifiers(evt: KeyboardEvent | MouseEvent): void {
    this.modifiers = getEventModifiers(evt);
  }

  /** internal: the global dispatcher. */
  onKeyEvent(evt: KeyboardEvent): void {
    this.updateModifiers(evt);
    if (evt.type !== "keydown") return;
    if (evt.isComposing || evt.keyCode === 229) return; // IME composition
    const ctx = Keymap.getContext(evt);
    const result = this.getActiveScope().handleKey(evt, ctx);
    if (result === false) {
      evt.preventDefault();
      evt.stopPropagation();
    }
  }

  // internal
  static getContext(evt: KeyboardEvent): KeymapContext {
    return { modifiers: getEventModifiers(evt), key: evt.key, vkey: getVirtualKey(evt) };
  }

  static isModifier(evt: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier): boolean {
    switch (modifier) {
      case "Mod":
        return IS_MAC ? evt.metaKey : evt.ctrlKey;
      case "Ctrl":
        return evt.ctrlKey;
      case "Meta":
        return evt.metaKey;
      case "Shift":
        return evt.shiftKey;
      case "Alt":
        return evt.altKey;
    }
    return false;
  }

  /**
   * 'tab' for Mod or a middle click, 'split' for Mod+Alt, 'window' for
   * Mod+Alt+Shift, otherwise false.
   */
  static isModEvent(evt?: UserEvent | null): PaneType | boolean {
    if (!evt) return false;
    const isMouse = typeof MouseEvent !== "undefined" && evt instanceof MouseEvent;
    if (isMouse && (evt as MouseEvent).button === 1 && (evt.type === "auxclick" || evt.type === "mousedown" || evt.type === "mouseup" || evt.type === "click" || evt.type === "pointerdown" || evt.type === "pointerup")) {
      return "tab";
    }
    if (!("metaKey" in evt)) return false;
    const mod = Keymap.isModifier(evt, "Mod");
    if (!mod) return false;
    const alt = evt.altKey;
    const shift = evt.shiftKey;
    if (alt && shift) return "window";
    if (alt) return "split";
    return "tab";
  }
}

// ---- hotkey helpers (used by the commands system) ---------------------------

const MAC_SYMBOLS: Record<string, string> = { Mod: "⌘", Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };

const KEY_DISPLAY: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
  Space: "Space",
  Escape: "Esc",
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Del",
  PageUp: "Page Up",
  PageDown: "Page Down",
};

const MAC_KEY_DISPLAY: Record<string, string> = {
  Enter: "↵",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Tab: "⇥",
};

/** Parse `"Mod+Shift+P"`, `"Ctrl + Shift + P"` or `"⌘⇧P"` into a Hotkey. */
export function parseHotkey(text: string): Hotkey | null {
  const s = text.trim();
  if (!s) return null;
  const modifiers: Modifier[] = [];
  let rest = s;
  // Mac symbol prefix form.
  const symbolMap: Record<string, Modifier> = { "⌘": "Mod", "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
  while (rest.length > 1 && symbolMap[rest[0]!]) {
    const m = symbolMap[rest[0]!]!;
    if (!modifiers.includes(m)) modifiers.push(m);
    rest = rest.slice(1).trimStart();
  }
  const parts = rest.split(/\s*\+\s*/);
  // "Mod++" → key "+"
  if (rest.endsWith("+") && (parts.length < 2 || parts[parts.length - 1] === "")) {
    parts.splice(parts.length - 2, 2, "+");
  }
  let key = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const lower = p.toLowerCase();
    const isLast = i === parts.length - 1;
    const mod: Modifier | null =
      lower === "mod" || lower === "cmdorctrl" || lower === "commandorcontrol"
        ? "Mod"
        : lower === "ctrl" || lower === "control" || lower === "⌃"
          ? "Ctrl"
          : lower === "meta" || lower === "cmd" || lower === "command" || lower === "win" || lower === "super" || lower === "⌘"
            ? "Meta"
            : lower === "shift" || lower === "⇧"
              ? "Shift"
              : lower === "alt" || lower === "option" || lower === "opt" || lower === "⌥"
                ? "Alt"
                : null;
    if (mod && !isLast) {
      if (!modifiers.includes(mod)) modifiers.push(mod);
    } else if (isLast) {
      key = p;
    } else {
      return null;
    }
  }
  if (!key) return null;
  const reverse: Record<string, string> = { "↑": "ArrowUp", "↓": "ArrowDown", "←": "ArrowLeft", "→": "ArrowRight", "↵": "Enter", "⌫": "Backspace", "⌦": "Delete", "⎋": "Escape", "⇥": "Tab", Esc: "Escape", Del: "Delete", Space: " " };
  key = reverse[key] ?? key;
  if (key.length === 1) key = key.toUpperCase();
  return { modifiers, key };
}

function displayKey(key: string): string {
  if (IS_MAC && MAC_KEY_DISPLAY[key]) return MAC_KEY_DISPLAY[key]!;
  if (KEY_DISPLAY[key]) return KEY_DISPLAY[key]!;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Display a hotkey: `"Ctrl + Shift + P"`, or `"⌘ ⇧ P"` on macOS. */
export function hotkeyToString(hotkey: Hotkey): string {
  const mods = new Set(hotkey.modifiers);
  if (IS_MAC) {
    const out: string[] = [];
    if (mods.has("Ctrl")) out.push(MAC_SYMBOLS.Ctrl!);
    if (mods.has("Alt")) out.push(MAC_SYMBOLS.Alt!);
    if (mods.has("Shift")) out.push(MAC_SYMBOLS.Shift!);
    if (mods.has("Mod") || mods.has("Meta")) out.push(MAC_SYMBOLS.Mod!);
    out.push(displayKey(hotkey.key));
    return out.join(" ");
  }
  const out: string[] = [];
  if (mods.has("Mod") || mods.has("Ctrl")) out.push("Ctrl");
  if (mods.has("Meta")) out.push("Win");
  if (mods.has("Alt")) out.push("Alt");
  if (mods.has("Shift")) out.push("Shift");
  out.push(displayKey(hotkey.key));
  return out.join(" + ");
}

/**
 * The hotkey an event represents, with Cmd (mac) / Ctrl (elsewhere) written
 * as `Mod`. Returns null for a bare modifier press.
 */
export function eventToHotkey(evt: KeyboardEvent): Hotkey | null {
  if (MODIFIER_KEYS.has(evt.key)) return null;
  const modifiers: Modifier[] = [];
  if (IS_MAC) {
    if (evt.metaKey) modifiers.push("Mod");
    if (evt.ctrlKey) modifiers.push("Ctrl");
  } else {
    if (evt.ctrlKey) modifiers.push("Mod");
    if (evt.metaKey) modifiers.push("Meta");
  }
  if (evt.altKey) modifiers.push("Alt");
  if (evt.shiftKey) modifiers.push("Shift");
  return { modifiers, key: getVirtualKey(evt) };
}

/** Whether a keyboard event triggers `hotkey`. */
export function matchesHotkey(evt: KeyboardEvent, hotkey: Hotkey): boolean {
  if (compileModifiers(hotkey.modifiers) !== getEventModifiers(evt)) return false;
  return keyEquals(hotkey.key, evt.key) || keyEquals(hotkey.key, getVirtualKey(evt));
}

// ---- access to the app keymap for objects constructed without an App -------

let fallbackKeymap: Keymap | null = null;

/**
 * internal: the keymap that `Menu`, `Notice` and other app-less objects push
 * their scopes onto — `window.app.keymap` when the app exists, otherwise a
 * module-level keymap installed on the window (tests, the UI gallery).
 */
export function getGlobalKeymap(): Keymap {
  const app = (globalThis as { app?: { keymap?: Keymap } }).app;
  if (app?.keymap) return app.keymap;
  if (!fallbackKeymap) {
    fallbackKeymap = new Keymap();
    if (typeof window !== "undefined") fallbackKeymap.install(window);
  }
  return fallbackKeymap;
}

/** internal: `app.keymap` if set, else the global keymap. */
export function keymapFor(app: { keymap?: Keymap } | null | undefined): Keymap {
  return app?.keymap ?? getGlobalKeymap();
}

export type { KeymapInfo };
