/**
 * The DOM and built-in prototype extensions every Obsidian plugin assumes.
 *
 * Obsidian adds these to the page's globals before any plugin runs, and
 * `obsidian.d.ts` declares them in `declare global`. Community plugins call
 * `containerEl.createDiv({ cls: "x" })` or `[].contains(x)` without importing
 * anything, so a missing helper is a plugin that throws on load. They are
 * installed once, idempotently, by `installDomExtensions()`.
 *
 * Every method is defined non-enumerable: an enumerable `Array.prototype.first`
 * shows up in every `for…in` over an array, which breaks third-party code that
 * still iterates arrays that way.
 */

type Attrs = Record<string, string | number | boolean | null>;

interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Attrs;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

function define(target: object, name: string, value: unknown) {
  if (Object.prototype.hasOwnProperty.call(target, name)) return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

function defineGetter(target: object, name: string, get: () => unknown) {
  if (Object.prototype.hasOwnProperty.call(target, name)) return;
  Object.defineProperty(target, name, { get, configurable: true, enumerable: false });
}

function splitClasses(cls: string | string[]): string[] {
  const list = Array.isArray(cls) ? cls : cls.split(" ");
  return list.filter((c) => c.length > 0);
}

function setAttr(el: Element, name: string, value: string | number | boolean | null) {
  if (value === null || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? "" : String(value));
}

function applyInfo(el: HTMLElement | SVGElement, o: DomElementInfo | string | undefined) {
  if (o === undefined) return;
  // A bare string is a class name, not text: plugins write `el.createDiv("nav-header")`.
  if (typeof o === "string") o = { cls: o };
  if (o.cls) el.classList.add(...splitClasses(o.cls));
  if (o.text !== undefined) (el as HTMLElement).setText(o.text);
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) setAttr(el, k, v);
  if (o.title !== undefined) el.setAttribute("title", o.title);
  if (o.value !== undefined && "value" in el) (el as HTMLInputElement).value = o.value;
  if (o.type !== undefined) el.setAttribute("type", o.type);
  if (o.placeholder !== undefined) el.setAttribute("placeholder", o.placeholder);
  if (o.href !== undefined) el.setAttribute("href", o.href);
  if (o.parent) {
    if (o.prepend) o.parent.insertBefore(el, o.parent.firstChild);
    else o.parent.appendChild(el);
  }
}

function createElIn<K extends keyof HTMLElementTagNameMap>(
  parent: Node | null,
  tag: K,
  o?: DomElementInfo | string,
  callback?: (el: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const doc = parent ? (parent.ownerDocument ?? (parent as Document)) : activeDocumentOrDefault();
  const el = doc.createElement(tag);
  if (parent) {
    const info = typeof o === "string" ? { cls: o } : o;
    if (info?.prepend) parent.insertBefore(el, parent.firstChild);
    else parent.appendChild(el);
  }
  applyInfo(el, o);
  callback?.(el);
  return el;
}

function createSvgIn<K extends keyof SVGElementTagNameMap>(
  parent: Node | null,
  tag: K,
  o?: { cls?: string | string[]; attr?: Attrs; parent?: Node; prepend?: boolean } | string,
  callback?: (el: SVGElementTagNameMap[K]) => void,
): SVGElementTagNameMap[K] {
  const doc = parent ? (parent.ownerDocument ?? (parent as Document)) : activeDocumentOrDefault();
  const el = doc.createElementNS("http://www.w3.org/2000/svg", tag);
  const info = typeof o === "string" ? { cls: o } : (o ?? {});
  if (parent) {
    if (info.prepend) parent.insertBefore(el, parent.firstChild);
    else parent.appendChild(el);
  }
  if (info.cls) el.classList.add(...splitClasses(info.cls));
  if (info.attr) for (const [k, v] of Object.entries(info.attr)) setAttr(el, k, v);
  if (info.parent) {
    if (info.prepend) info.parent.insertBefore(el, info.parent.firstChild);
    else info.parent.appendChild(el);
  }
  callback?.(el);
  return el;
}

function activeDocumentOrDefault(): Document {
  return (globalThis as { activeDocument?: Document }).activeDocument ?? document;
}

interface ListenerInfo {
  selector: string;
  listener: Function;
  options?: boolean | AddEventListenerOptions;
  callback: EventListener;
}

type WithEvents = EventTarget & { _EVENTS?: Record<string, ListenerInfo[]> };

function delegatedOn(
  this: WithEvents,
  type: string,
  selector: string,
  listener: (ev: Event, delegateTarget: HTMLElement) => unknown,
  options?: boolean | AddEventListenerOptions,
) {
  const events = (this._EVENTS ??= {});
  const list = (events[type] ??= []);
  if (list.some((l) => l.selector === selector && l.listener === listener && l.options === options)) return;
  const self = this;
  const callback: EventListener = (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const match = target.closest(selector);
    if (!match) return;
    // The delegate must be inside the element the handler was attached to.
    if (self instanceof Node && !self.contains(match)) return;
    listener.call(self, ev, match as HTMLElement);
  };
  list.push({ selector, listener, options, callback });
  this.addEventListener(type, callback, options);
}

function delegatedOff(
  this: WithEvents,
  type: string,
  selector: string,
  listener: Function,
  options?: boolean | AddEventListenerOptions,
) {
  const list = this._EVENTS?.[type];
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const l = list[i]!;
    if (l.selector === selector && l.listener === listener && l.options === options) {
      this.removeEventListener(type, l.callback, options);
      list.splice(i, 1);
    }
  }
}

let installed = false;

export function installDomExtensions(win: Window & typeof globalThis = window) {
  if (installed && win === window) return;
  installed = true;

  // ---- Object / Array / Math / String / Number -------------------------
  define(Object, "isEmpty", (o: Record<string, unknown>) => {
    for (const _ in o) return false;
    return true;
  });
  define(Object, "each", (o: Record<string, unknown>, cb: (v: unknown, k?: string) => boolean | void, ctx?: unknown) => {
    for (const k in o) {
      if (Object.prototype.hasOwnProperty.call(o, k) && cb.call(ctx, o[k], k) === false) return false;
    }
    return true;
  });
  define(Array, "combine", <T>(arrays: T[][]) => ([] as T[]).concat(...arrays));

  const AP = Array.prototype as unknown as Record<string, unknown>;
  define(AP, "first", function (this: unknown[]) {
    return this[0];
  });
  define(AP, "last", function (this: unknown[]) {
    return this[this.length - 1];
  });
  define(AP, "contains", function (this: unknown[], t: unknown) {
    return this.indexOf(t) !== -1;
  });
  define(AP, "remove", function (this: unknown[], t: unknown) {
    for (let i = this.indexOf(t); i !== -1; i = this.indexOf(t)) this.splice(i, 1);
  });
  define(AP, "shuffle", function (this: unknown[]) {
    for (let i = this.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this[i], this[j]] = [this[j], this[i]];
    }
    return this;
  });
  define(AP, "unique", function (this: unknown[]) {
    return Array.from(new Set(this));
  });
  if (!AP.findLastIndex) {
    define(AP, "findLastIndex", function (this: unknown[], p: (v: unknown) => boolean) {
      for (let i = this.length - 1; i >= 0; i--) if (p(this[i])) return i;
      return -1;
    });
  }

  define(Math, "clamp", (v: number, min: number, max: number) => Math.min(Math.max(v, min), max));
  define(Math, "square", (v: number) => v * v);
  define(String, "isString", (o: unknown) => typeof o === "string" || o instanceof String);
  define(String.prototype, "contains", function (this: string, t: string) {
    return this.indexOf(t) !== -1;
  });
  define(String.prototype, "format", function (this: string, ...args: string[]) {
    return this.replace(/{(\d+)}/g, (m, n) => (args[Number(n)] !== undefined ? args[Number(n)]! : m));
  });
  define(Number, "isNumber", (o: unknown) => typeof o === "number");

  // ---- Node ---------------------------------------------------------------
  const NP = Node.prototype as unknown as Record<string, unknown>;
  define(NP, "detach", function (this: Node) {
    this.parentNode?.removeChild(this);
  });
  define(NP, "empty", function (this: Node) {
    while (this.lastChild) this.removeChild(this.lastChild);
  });
  define(NP, "insertAfter", function <T extends Node>(this: Node, node: T, child: Node | null) {
    this.insertBefore(node, child ? child.nextSibling : this.firstChild);
    return node;
  });
  define(NP, "indexOf", function (this: Node, other: Node) {
    return Array.prototype.indexOf.call(this.childNodes, other);
  });
  define(NP, "setChildrenInPlace", function (this: Node, children: Node[]) {
    const wanted = new Set(children);
    let cursor = this.firstChild;
    for (const child of children) {
      if (cursor === child) {
        cursor = cursor.nextSibling;
        continue;
      }
      this.insertBefore(child, cursor);
    }
    while (cursor) {
      const next: ChildNode | null = cursor.nextSibling;
      if (!wanted.has(cursor)) this.removeChild(cursor);
      cursor = next;
    }
  });
  define(NP, "appendText", function (this: Node, val: string) {
    this.appendChild((this.ownerDocument ?? document).createTextNode(val));
  });
  define(NP, "instanceOf", function (this: Node, type: { new (): unknown }) {
    if (this instanceof type) return true;
    // A node adopted from a pop-out window is an instance of *that* window's
    // constructor, so fall back to comparing constructor names.
    const win = this.ownerDocument?.defaultView as unknown as Record<string, unknown> | null;
    const ctor = win?.[(type as { name: string }).name] as { new (): unknown } | undefined;
    return !!ctor && this instanceof ctor;
  });
  defineGetter(NP, "doc", function (this: Node) {
    return this.ownerDocument ?? (this as unknown as Document);
  });
  defineGetter(NP, "win", function (this: Node) {
    return (this.ownerDocument ?? (this as unknown as Document)).defaultView ?? window;
  });
  defineGetter(NP, "constructorWin", function (this: Node) {
    return (this.ownerDocument ?? (this as unknown as Document)).defaultView ?? window;
  });
  define(NP, "createEl", function (this: Node, tag: keyof HTMLElementTagNameMap, o?: DomElementInfo | string, cb?: (el: HTMLElement) => void) {
    return createElIn(this, tag, o, cb as never);
  });
  define(NP, "createDiv", function (this: Node, o?: DomElementInfo | string, cb?: (el: HTMLDivElement) => void) {
    return createElIn(this, "div", o, cb);
  });
  define(NP, "createSpan", function (this: Node, o?: DomElementInfo | string, cb?: (el: HTMLSpanElement) => void) {
    return createElIn(this, "span", o, cb);
  });
  define(NP, "createSvg", function (this: Node, tag: keyof SVGElementTagNameMap, o?: never, cb?: never) {
    return createSvgIn(this, tag, o, cb);
  });

  // ---- Element ------------------------------------------------------------
  const EP = Element.prototype as unknown as Record<string, unknown>;
  define(EP, "getText", function (this: Element) {
    return this.textContent ?? "";
  });
  define(EP, "setText", function (this: Element, val: string | DocumentFragment) {
    if (typeof val === "string") this.textContent = val;
    else {
      (this as unknown as Node & { empty(): void }).empty();
      this.appendChild(val);
    }
  });
  define(EP, "addClass", function (this: Element, ...c: string[]) {
    this.classList.add(...c.flatMap(splitClasses));
  });
  define(EP, "addClasses", function (this: Element, c: string[]) {
    this.classList.add(...c.flatMap(splitClasses));
  });
  define(EP, "removeClass", function (this: Element, ...c: string[]) {
    this.classList.remove(...c.flatMap(splitClasses));
  });
  define(EP, "removeClasses", function (this: Element, c: string[]) {
    this.classList.remove(...c.flatMap(splitClasses));
  });
  define(EP, "toggleClass", function (this: Element, c: string | string[], value: boolean) {
    for (const cls of splitClasses(c)) this.classList.toggle(cls, value);
  });
  define(EP, "hasClass", function (this: Element, c: string) {
    return this.classList.contains(c);
  });
  define(EP, "setAttr", function (this: Element, name: string, value: string | number | boolean | null) {
    setAttr(this, name, value);
  });
  define(EP, "setAttrs", function (this: Element, obj: Attrs) {
    for (const [k, v] of Object.entries(obj)) setAttr(this, k, v);
  });
  define(EP, "getAttr", function (this: Element, name: string) {
    return this.getAttribute(name);
  });
  define(EP, "matchParent", function (this: Element, selector: string, lastParent?: Element) {
    let el: Element | null = this;
    while (el) {
      if (el.matches(selector)) return el;
      if (el === lastParent) return null;
      el = el.parentElement;
    }
    return null;
  });
  define(EP, "getCssPropertyValue", function (this: Element, property: string, pseudo?: string) {
    return getComputedStyle(this, pseudo).getPropertyValue(property);
  });
  define(EP, "isActiveElement", function (this: Element) {
    return this.ownerDocument.activeElement === this;
  });
  define(EP, "find", function (this: Element, s: string) {
    return this.querySelector(s);
  });
  define(EP, "findAll", function (this: Element, s: string) {
    return Array.from(this.querySelectorAll(s));
  });
  define(EP, "findAllSelf", function (this: Element, s: string) {
    const all = Array.from(this.querySelectorAll(s));
    if (this.matches(s)) all.unshift(this);
    return all;
  });

  const FP = DocumentFragment.prototype as unknown as Record<string, unknown>;
  define(FP, "find", function (this: DocumentFragment, s: string) {
    return this.querySelector(s);
  });
  define(FP, "findAll", function (this: DocumentFragment, s: string) {
    return Array.from(this.querySelectorAll(s));
  });

  // ---- HTMLElement / SVGElement ------------------------------------------
  const HP = HTMLElement.prototype as unknown as Record<string, unknown>;
  define(HP, "show", function (this: HTMLElement) {
    this.style.display = "";
  });
  define(HP, "hide", function (this: HTMLElement) {
    this.style.display = "none";
  });
  define(HP, "toggle", function (this: HTMLElement, show: boolean) {
    this.style.display = show ? "" : "none";
  });
  define(HP, "toggleVisibility", function (this: HTMLElement, visible: boolean) {
    this.style.visibility = visible ? "" : "hidden";
  });
  define(HP, "isShown", function (this: HTMLElement) {
    return this.offsetParent !== null || getComputedStyle(this).position === "fixed";
  });
  const setCssStyles = function (this: HTMLElement | SVGElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  };
  const setCssProps = function (this: HTMLElement | SVGElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  };
  define(HP, "setCssStyles", setCssStyles);
  define(HP, "setCssProps", setCssProps);
  define(SVGElement.prototype, "setCssStyles", setCssStyles);
  define(SVGElement.prototype, "setCssProps", setCssProps);
  defineGetter(HP, "innerWidth", function (this: HTMLElement) {
    const cs = getComputedStyle(this);
    return this.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  });
  defineGetter(HP, "innerHeight", function (this: HTMLElement) {
    const cs = getComputedStyle(this);
    return this.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  });
  define(HP, "on", delegatedOn);
  define(HP, "off", delegatedOff);
  define(Document.prototype, "on", delegatedOn);
  define(Document.prototype, "off", delegatedOff);
  define(HP, "onClickEvent", function (this: HTMLElement, listener: (ev: MouseEvent) => unknown, options?: boolean | AddEventListenerOptions) {
    this.addEventListener("click", listener as EventListener, options);
    this.addEventListener("auxclick", listener as EventListener, options);
  });
  define(HP, "onNodeInserted", function (this: HTMLElement, listener: () => unknown, once?: boolean) {
    const handler = (ev: AnimationEvent) => {
      if (ev.animationName !== "node-inserted" || ev.target !== this) return;
      if (once) this.removeEventListener("animationstart", handler);
      listener();
    };
    this.addClass("node-insert-event");
    this.addEventListener("animationstart", handler);
    // The CSS animation trick above only fires when the stylesheet defines
    // `node-inserted`; also check on the next frames so it works without it.
    let done = false;
    const poll = () => {
      if (done) return;
      if (this.isConnected) {
        listener();
        if (once) {
          done = true;
          return;
        }
      }
      if (!this.isConnected) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
    return () => {
      done = true;
      this.removeEventListener("animationstart", handler);
    };
  });
  define(HP, "onWindowMigrated", function (this: HTMLElement, listener: (win: Window) => unknown) {
    let win = this.ownerDocument.defaultView;
    return (this as unknown as { onNodeInserted(l: () => void): () => void }).onNodeInserted(() => {
      const now = this.ownerDocument.defaultView;
      if (now && now !== win) {
        win = now;
        listener(now);
      }
    });
  });
  define(HP, "trigger", function (this: HTMLElement, type: string) {
    this.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  });

  // ---- UIEvent ------------------------------------------------------------
  const UP = UIEvent.prototype as unknown as Record<string, unknown>;
  defineGetter(UP, "targetNode", function (this: UIEvent) {
    return this.target instanceof Node ? this.target : null;
  });
  defineGetter(UP, "win", function (this: UIEvent) {
    return this.view ?? window;
  });
  defineGetter(UP, "doc", function (this: UIEvent) {
    return (this.view ?? window).document;
  });
  define(UP, "instanceOf", function (this: UIEvent, type: { new (...a: never[]): unknown }) {
    return this instanceof type;
  });

  // ---- globals ------------------------------------------------------------
  const G = win as unknown as Record<string, unknown>;
  define(G, "isBoolean", (o: unknown) => typeof o === "boolean");
  define(G, "fish", (s: string) => win.document.querySelector(s));
  define(G, "fishAll", (s: string) => Array.from(win.document.querySelectorAll(s)));
  define(G, "createEl", (tag: keyof HTMLElementTagNameMap, o?: DomElementInfo | string, cb?: never) => createElIn(null, tag, o, cb));
  define(G, "createDiv", (o?: DomElementInfo | string, cb?: never) => createElIn(null, "div", o, cb));
  define(G, "createSpan", (o?: DomElementInfo | string, cb?: never) => createElIn(null, "span", o, cb));
  define(G, "createSvg", (tag: keyof SVGElementTagNameMap, o?: never, cb?: never) => createSvgIn(null, tag, o, cb));
  define(G, "createFragment", (cb?: (el: DocumentFragment) => void) => {
    const frag = activeDocumentOrDefault().createDocumentFragment();
    cb?.(frag);
    return frag;
  });
  define(G, "sleep", (ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  define(G, "nextFrame", () => new Promise<void>((r) => requestAnimationFrame(() => r())));
  define(G, "ready", (fn: () => unknown) => {
    if (win.document.readyState !== "loading") fn();
    else win.document.addEventListener("DOMContentLoaded", () => fn(), { once: true });
  });
  define(G, "ajax", (o: AjaxOptions) => {
    const req = o.req ?? new XMLHttpRequest();
    req.open(o.method ?? "GET", o.url, true);
    if (o.withCredentials) req.withCredentials = true;
    for (const [k, v] of Object.entries(o.headers ?? {})) req.setRequestHeader(k, v);
    req.onload = () => {
      if (req.status >= 200 && req.status < 300) o.success?.(req.response, req);
      else o.error?.(req.statusText, req);
    };
    req.onerror = (e) => o.error?.(e, req);
    const data = o.data;
    if (data === undefined) req.send();
    else if (typeof data === "string" || data instanceof ArrayBuffer) req.send(data);
    else {
      req.setRequestHeader("Content-Type", "application/json");
      req.send(JSON.stringify(data));
    }
  });
  define(G, "ajaxPromise", (o: AjaxOptions) =>
    new Promise((resolve, reject) => {
      (G.ajax as (o: AjaxOptions) => void)({ ...o, success: resolve, error: reject });
    }),
  );
  if (!("activeWindow" in G)) {
    G.activeWindow = win;
    G.activeDocument = win.document;
  }
}

interface AjaxOptions {
  method?: "GET" | "POST";
  url: string;
  success?: (response: unknown, req: XMLHttpRequest) => unknown;
  error?: (error: unknown, req: XMLHttpRequest) => unknown;
  data?: object | string | ArrayBuffer;
  headers?: Record<string, string>;
  withCredentials?: boolean;
  req?: XMLHttpRequest;
}
