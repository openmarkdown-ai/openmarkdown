/**
 * `Events` and `Component` — the two base classes almost every object in the
 * API inherits from. Their semantics matter more than their size: a plugin
 * that registers a vault listener in `onload` relies on `Component.unload()`
 * removing it, or disabling the plugin leaks a handler that keeps firing.
 */

export interface EventRef {
  e: Events;
  name: string;
  fn: (...data: unknown[]) => unknown;
  ctx?: unknown;
}

export class Events {
  _events: Record<string, EventRef[]> = {};

  on(name: string, callback: (...data: any[]) => unknown, ctx?: unknown): EventRef {
    const ref: EventRef = { e: this, name, fn: callback, ctx };
    (this._events[name] ??= []).push(ref);
    return ref;
  }

  off(name: string, callback: (...data: any[]) => unknown): void {
    const list = this._events[name];
    if (!list) return;
    const kept = list.filter((r) => r.fn !== callback);
    if (kept.length) this._events[name] = kept;
    else delete this._events[name];
  }

  offref(ref: EventRef): void {
    const list = this._events[ref.name];
    if (!list) return;
    const kept = list.filter((r) => r !== ref);
    if (kept.length) this._events[ref.name] = kept;
    else delete this._events[ref.name];
  }

  trigger(name: string, ...data: unknown[]): void {
    const list = this._events[name];
    if (!list) return;
    // Copy first: a handler that calls `off` must not skip its neighbour.
    for (const ref of list.slice()) this.tryTrigger(ref, data);
  }

  tryTrigger(ref: EventRef, args: unknown[]): void {
    try {
      ref.fn.apply(ref.ctx, args);
    } catch (e) {
      // One plugin's broken handler must not stop the next plugin's from running.
      console.error(e);
    }
  }
}

export class Component {
  _loaded = false;
  _events: (() => void)[] = [];
  _children: Component[] = [];

  load(): void {
    if (this._loaded) return;
    this._loaded = true;
    const result = this.onload() as unknown;
    if (result instanceof Promise) result.catch((e) => console.error(e));
    for (const child of this._children.slice()) child.load();
  }

  onload(): void {}

  unload(): void {
    if (!this._loaded) return;
    this._loaded = false;
    for (const child of this._children.splice(0).reverse()) child.unload();
    for (const cb of this._events.splice(0).reverse()) {
      try {
        cb();
      } catch (e) {
        console.error(e);
      }
    }
    this.onunload();
  }

  onunload(): void {}

  addChild<T extends Component>(component: T): T {
    this._children.push(component);
    if (this._loaded) component.load();
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    const i = this._children.indexOf(component);
    if (i !== -1) {
      this._children.splice(i, 1);
      component.unload();
    }
    return component;
  }

  register(cb: () => any): void {
    this._events.push(cb);
  }

  registerEvent(ref: EventRef): void {
    this.register(() => ref.e.offref(ref));
  }

  registerDomEvent(
    el: Window | Document | HTMLElement,
    type: string,
    callback: (ev: any) => any,
    options?: boolean | AddEventListenerOptions,
  ): void {
    el.addEventListener(type, callback, options);
    this.register(() => el.removeEventListener(type, callback, options));
  }

  registerScopeEvent(ref: { scope: { unregister(h: unknown): void } } & object): void {
    this.register(() => ref.scope.unregister(ref));
  }

  registerInterval(id: number): number {
    this.register(() => window.clearInterval(id));
    return id;
  }
}
