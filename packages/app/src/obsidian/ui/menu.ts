/**
 * Menu, MenuItem, MenuSeparator — context menus.
 *
 * DOM:
 *
 *   body > .menu[.mod-no-icon]
 *     .menu-scroll
 *       .menu-item[.tappable][data-section][.is-disabled][.is-warning][.is-label][.selected][.has-submenu][.mod-checked]
 *         .menu-item-icon > svg
 *         .menu-item-title
 *         .menu-item-icon.mod-checked | .menu-item-icon.mod-submenu
 *       .menu-separator
 *
 * Items are laid out when the menu is shown: grouped by `setSection`, the
 * groups ordered by the well-known section list (unknown sections keep the
 * order in which they first appeared), with a separator between groups.
 * Explicit `addSeparator()` calls stay where they were added.
 *
 * While shown, the menu's scope is the active key scope, so arrow keys,
 * Enter and Escape drive the menu without moving focus out of the editor.
 */
import type { HistoryHandler, MenuPositionDef } from "obsidian";
import { Component } from "../events";
import { setIcon } from "./icons";
import { Scope, getGlobalKeymap } from "./keymap";

/** The order sections appear in when items name them. `""` is the unsectioned group. */
export const MENU_SECTION_ORDER = [
  "title",
  "correction",
  "spellcheck",
  "open",
  "selection",
  "clipboard",
  "action-primary",
  "action",
  "info",
  "view",
  "",
  "system",
  "danger",
];

const SUBMENU_DELAY = 150;
const VIEWPORT_MARGIN = 8;

export class MenuSeparator {
  // internal
  menu: Menu;
  // internal
  dom: HTMLElement;
  // internal
  section = "";

  /** Private in the API: use `Menu.addSeparator`. */
  constructor(menu: Menu) {
    this.menu = menu;
    this.dom = createDiv({ cls: "menu-separator" });
  }
}

export class MenuItem {
  // internal (used by plugins: `item.dom`, `item.titleEl`, `item.iconEl`, `item.callback`, `item.section`)
  menu: Menu;
  dom: HTMLElement;
  iconEl: HTMLElement;
  titleEl: HTMLElement;
  // internal
  checkIconEl: HTMLElement | null = null;
  // internal
  submenuIconEl: HTMLElement | null = null;
  callback: ((evt: MouseEvent | KeyboardEvent) => any) | null = null;
  section = "";
  // internal
  disabled = false;
  // internal
  checked: boolean | null = null;
  // internal
  isLabel = false;
  // internal
  submenu: Menu | null = null;

  /** Private in the API: use `Menu.addItem`. */
  constructor(menu: Menu) {
    this.menu = menu;
    this.dom = createDiv({ cls: ["menu-item", "tappable"] });
    this.iconEl = this.dom.createDiv({ cls: "menu-item-icon" });
    this.titleEl = this.dom.createDiv({ cls: "menu-item-title" });
    this.dom.addEventListener("mouseenter", () => this.menu.onItemHover(this));
    this.dom.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.menu.onItemActivate(this, evt);
    });
  }

  setTitle(title: string | DocumentFragment): this {
    this.titleEl.setText(title);
    return this;
  }

  setIcon(icon: string | null): this {
    if (icon) setIcon(this.iconEl, icon);
    else this.iconEl.empty();
    return this;
  }

  setChecked(checked: boolean | null): this {
    this.checked = checked;
    this.dom.toggleClass("mod-checked", checked === true);
    if (checked === true) {
      if (!this.checkIconEl) {
        this.checkIconEl = createDiv({ cls: ["menu-item-icon", "mod-checked"] });
        this.dom.insertBefore(this.checkIconEl, this.submenuIconEl);
      }
      setIcon(this.checkIconEl, "lucide-check");
    } else {
      this.checkIconEl?.remove();
      this.checkIconEl = null;
    }
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.dom.toggleClass("is-disabled", disabled);
    this.dom.setAttr("aria-disabled", disabled ? "true" : null);
    return this;
  }

  setWarning(isWarning: boolean): this {
    this.dom.toggleClass("is-warning", isWarning);
    return this;
  }

  setIsLabel(isLabel: boolean): this {
    this.isLabel = isLabel;
    this.dom.toggleClass("is-label", isLabel);
    return this;
  }

  onClick(callback: (evt: MouseEvent | KeyboardEvent) => any): this {
    this.callback = callback;
    return this;
  }

  setSection(section: string): this {
    this.section = section;
    this.dom.setAttr("data-section", section || null);
    return this;
  }

  // internal (used by plugins since Obsidian 1.6)
  setSubmenu(): Menu {
    if (!this.submenu) {
      this.submenu = new Menu();
      this.submenu.parentMenu = this.menu;
      this.dom.addClass("has-submenu");
      this.submenuIconEl = this.dom.createDiv({ cls: ["menu-item-icon", "mod-submenu"] });
      setIcon(this.submenuIconEl, "lucide-chevron-right");
    }
    return this.submenu;
  }

  // internal
  isSelectable(): boolean {
    return !this.disabled && !this.isLabel;
  }
}

const pendingEventMenus = new WeakMap<Event, Menu>();

export class Menu extends Component implements HistoryHandler {
  // internal (used by plugins: `menu.dom`, `menu.items`, `menu.scope`)
  dom: HTMLElement;
  scrollEl: HTMLElement;
  items: (MenuItem | MenuSeparator)[] = [];
  scope: Scope;
  // internal
  parentMenu: Menu | null = null;
  // internal
  currentSubmenu: Menu | null = null;
  // internal
  parentEl: HTMLElement | null = null;
  // internal
  selected = -1;
  // internal
  noIcon = false;
  // internal
  useNativeMenu = false;
  // internal
  sectionOrder: string[] = [];
  // internal
  hideCallbacks: (() => any)[] = [];
  // internal
  isShown = false;
  private visibleItems: MenuItem[] = [];
  private submenuTimer: number | null = null;
  private currentSection = "";

  constructor() {
    super();
    this.dom = createDiv({ cls: "menu", attr: { role: "menu" } });
    this.scrollEl = this.dom.createDiv({ cls: "menu-scroll" });
    this.dom.addEventListener("contextmenu", (evt) => evt.preventDefault());
    this.dom.addEventListener("mouseleave", () => {
      if (!this.currentSubmenu) this.select(-1);
    });
    this.scope = new Scope();
    this.scope.register([], "ArrowDown", () => (this.moveSelection(1), false));
    this.scope.register([], "ArrowUp", () => (this.moveSelection(-1), false));
    this.scope.register([], "Home", () => (this.selectEdge(true), false));
    this.scope.register([], "End", () => (this.selectEdge(false), false));
    this.scope.register([], "ArrowRight", () => {
      const item = this.visibleItems[this.selected];
      if (item?.submenu && item.isSelectable()) this.openSubmenu(item, true);
      return false;
    });
    this.scope.register([], "ArrowLeft", () => {
      if (this.parentMenu) this.hide();
      return false;
    });
    this.scope.register([], "Escape", () => {
      this.hide();
      return false;
    });
    const activate = (evt: KeyboardEvent) => {
      const item = this.visibleItems[this.selected];
      if (!item) return false;
      this.onItemActivate(item, evt);
      return false;
    };
    this.scope.register([], "Enter", activate);
    this.scope.register([], " ", activate);
    // Tab must not move focus around the page underneath an open menu.
    this.scope.register(null, "Tab", () => false);
  }

  setNoIcon(): this {
    this.noIcon = true;
    this.dom.addClass("mod-no-icon");
    return this;
  }

  setUseNativeMenu(useNativeMenu: boolean): this {
    this.useNativeMenu = useNativeMenu;
    return this;
  }

  addItem(cb: (item: MenuItem) => any): this {
    const item = new MenuItem(this);
    if (this.currentSection) item.setSection(this.currentSection);
    this.items.push(item);
    cb(item);
    return this;
  }

  addSeparator(): this {
    const sep = new MenuSeparator(this);
    const last = this.items[this.items.length - 1];
    sep.section = last?.section ?? "";
    this.items.push(sep);
    return this;
  }

  // internal: declare the order of custom sections for this menu.
  addSections(sections: string[]): this {
    for (const s of sections) if (!this.sectionOrder.includes(s)) this.sectionOrder.push(s);
    return this;
  }

  setParentElement(el: HTMLElement): this {
    this.parentEl = el;
    return this;
  }

  showAtMouseEvent(evt: MouseEvent): this {
    const doc = (evt.target instanceof Node ? evt.target.ownerDocument : null) ?? (evt.view?.document ?? undefined);
    return this.showAtPosition({ x: evt.clientX, y: evt.clientY }, doc ?? undefined);
  }

  showAtPosition(position: MenuPositionDef, doc?: Document): this {
    const d = doc ?? ((globalThis as { activeDocument?: Document }).activeDocument ?? document);
    if (this.isShown) this.hide();
    this.render();
    if (this.visibleItems.length === 0 && !this.items.some((i) => i instanceof MenuItem)) return this;

    this.isShown = true;
    this.dom.style.left = "0px";
    this.dom.style.top = "0px";
    this.dom.style.visibility = "hidden";
    // Phone: menus are bottom sheets (styles/mobile.css) over a dimmed backdrop.
    const sheet = d.body.hasClass("is-phone");
    this.dom.toggleClass("mod-sheet", sheet);
    if (sheet && !this.parentMenu) {
      this.bgEl ??= createDiv({ cls: "suggestion-bg vault-menu-backdrop" });
      d.body.appendChild(this.bgEl);
    }
    d.body.appendChild(this.dom);
    this.position(position, d);
    this.dom.style.visibility = "";

    this.load();
    getGlobalKeymap().pushScope(this.scope);
    this.parentEl?.addClass("has-active-menu");

    if (d.body.hasClass("is-mobile")) {
      // Tapping an item must not take focus from the editor (and close the keyboard).
      this.registerDomEvent(this.dom, "pointerdown", (evt: PointerEvent) => evt.preventDefault());
      this.registerDomEvent(this.dom, "mousedown", (evt: MouseEvent) => evt.preventDefault());
    }

    if (!this.parentMenu) {
      const win = d.defaultView ?? window;
      this.registerDomEvent(d, "pointerdown", (evt: PointerEvent) => {
        if (evt.target instanceof Node && this.containsNode(evt.target)) return;
        if (evt.target === this.bgEl) {
          // Dismissing the sheet: the tap must not also land on what is underneath.
          const swallow = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
          };
          win.addEventListener("click", swallow, { capture: true, once: true });
          win.setTimeout(() => win.removeEventListener("click", swallow, true), 600);
        }
        this.hide();
      }, true);
      this.registerDomEvent(win, "blur", () => this.hide());
      // The on-screen keyboard and a phone's collapsing URL bar change the
      // height; only a change of width moves what the menu is anchored to.
      let width = win.innerWidth;
      this.registerDomEvent(win, "resize", () => {
        if (sheet && win.innerWidth === width) return;
        width = win.innerWidth;
        this.hide();
      });
    }
    return this;
  }

  // internal: the phone sheet's backdrop
  private bgEl: HTMLElement | null = null;

  hide(): this {
    if (!this.isShown) return this;
    this.isShown = false;
    this.clearSubmenuTimer();
    this.currentSubmenu?.hide();
    this.currentSubmenu = null;
    this.dom.detach();
    this.bgEl?.detach();
    getGlobalKeymap().popScope(this.scope);
    this.parentEl?.removeClass("has-active-menu");
    if (this.parentMenu && this.parentMenu.currentSubmenu === this) {
      this.parentMenu.currentSubmenu = null;
    }
    this.unload();
    for (const cb of this.hideCallbacks.slice()) {
      try {
        cb();
      } catch (e) {
        console.error(e);
      }
    }
    return this;
  }

  close(): void {
    this.hide();
  }

  onHide(callback: () => any): void {
    this.hideCallbacks.push(callback);
  }

  onHistoryBack(): void {
    this.hide();
  }

  /**
   * One menu per user event: every handler that calls `Menu.forEvent(evt)`
   * during the same event adds to the same menu, which is shown at the
   * pointer once the event has finished dispatching.
   */
  static forEvent(evt: PointerEvent | MouseEvent): Menu {
    const existing = pendingEventMenus.get(evt);
    if (existing) return existing;
    const menu = new Menu();
    pendingEventMenus.set(evt, menu);
    if (evt.type === "contextmenu") evt.preventDefault();
    window.setTimeout(() => {
      if (!menu.isShown && menu.items.length > 0) menu.showAtMouseEvent(evt);
    }, 0);
    return menu;
  }

  // ---- internals -----------------------------------------------------------

  // internal
  containsNode(node: Node): boolean {
    if (this.dom.contains(node)) return true;
    return this.currentSubmenu ? this.currentSubmenu.containsNode(node) : false;
  }

  // internal
  rootMenu(): Menu {
    let m: Menu = this;
    while (m.parentMenu) m = m.parentMenu;
    return m;
  }

  private sectionRank(section: string, firstSeen: Map<string, number>): [number, number] {
    const known = MENU_SECTION_ORDER.indexOf(section);
    const custom = this.sectionOrder.indexOf(section);
    const blank = MENU_SECTION_ORDER.indexOf("");
    if (known !== -1) return [known, 0];
    if (custom !== -1) return [blank - 0.5, custom];
    return [blank - 0.25, firstSeen.get(section) ?? 0];
  }

  // internal
  render(): void {
    const firstSeen = new Map<string, number>();
    this.items.forEach((item, i) => {
      if (!firstSeen.has(item.section)) firstSeen.set(item.section, i);
    });
    const sections = Array.from(firstSeen.keys()).sort((a, b) => {
      const [ra, ta] = this.sectionRank(a, firstSeen);
      const [rb, tb] = this.sectionRank(b, firstSeen);
      return ra - rb || ta - tb;
    });

    const nodes: HTMLElement[] = [];
    const visible: MenuItem[] = [];
    let lastWasSeparator = true;
    for (const section of sections) {
      const group = this.items.filter((i) => i.section === section);
      if (!group.some((i) => i instanceof MenuItem)) continue;
      if (!lastWasSeparator) {
        nodes.push(createDiv({ cls: "menu-separator" }));
        lastWasSeparator = true;
      }
      for (const item of group) {
        if (item instanceof MenuSeparator) {
          if (lastWasSeparator) continue;
          nodes.push(item.dom);
          lastWasSeparator = true;
        } else {
          if (this.noIcon && item.iconEl.childElementCount === 0) item.iconEl.hide();
          else item.iconEl.show();
          item.dom.removeClass("selected");
          nodes.push(item.dom);
          visible.push(item);
          lastWasSeparator = false;
        }
      }
    }
    while (nodes.length && nodes[nodes.length - 1]!.classList.contains("menu-separator")) nodes.pop();
    this.scrollEl.empty();
    for (const n of nodes) this.scrollEl.appendChild(n);
    this.visibleItems = visible;
    this.selected = -1;
  }

  private position(pos: MenuPositionDef, doc: Document) {
    const win = doc.defaultView ?? window;
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const rect = this.dom.getBoundingClientRect();
    const w = rect.width;
    const h = Math.min(rect.height, vh - VIEWPORT_MARGIN * 2);
    const anchorWidth = pos.width ?? 0;

    let x: number;
    const fitsRight = pos.x + w <= vw - VIEWPORT_MARGIN;
    const leftX = pos.overlap ? pos.x - w : pos.x - anchorWidth - w;
    const fitsLeft = leftX >= VIEWPORT_MARGIN;
    if (pos.left) x = fitsLeft || !fitsRight ? leftX : pos.x;
    else x = fitsRight || !fitsLeft ? pos.x : leftX;
    x = Math.min(Math.max(x, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vw - w - VIEWPORT_MARGIN));

    let y = pos.y;
    if (y + h > vh - VIEWPORT_MARGIN) {
      // Open upwards from the point when there is room, otherwise pin to the bottom.
      y = pos.y - h >= VIEWPORT_MARGIN && !this.parentMenu ? pos.y - h : vh - VIEWPORT_MARGIN - h;
    }
    y = Math.max(y, VIEWPORT_MARGIN);
    this.dom.style.left = `${Math.round(x)}px`;
    this.dom.style.top = `${Math.round(y)}px`;
    this.dom.style.maxHeight = `${vh - VIEWPORT_MARGIN * 2}px`;
  }

  // internal
  select(index: number): void {
    const prev = this.visibleItems[this.selected];
    prev?.dom.removeClass("selected");
    this.selected = index;
    const item = this.visibleItems[index];
    if (item) {
      item.dom.addClass("selected");
      item.dom.scrollIntoView({ block: "nearest" });
    }
  }

  private moveSelection(delta: number) {
    const n = this.visibleItems.length;
    if (n === 0) return;
    let i = this.selected;
    for (let step = 0; step < n; step++) {
      i = i === -1 ? (delta > 0 ? 0 : n - 1) : (i + delta + n) % n;
      if (this.visibleItems[i]!.isSelectable()) {
        this.select(i);
        return;
      }
    }
  }

  private selectEdge(first: boolean) {
    this.selected = -1;
    this.moveSelection(first ? 1 : -1);
  }

  // internal
  onItemHover(item: MenuItem): void {
    const index = this.visibleItems.indexOf(item);
    if (index === -1) return;
    this.select(item.isSelectable() ? index : -1);
    this.clearSubmenuTimer();
    if (this.currentSubmenu && this.currentSubmenu !== item.submenu) {
      this.submenuTimer = window.setTimeout(() => {
        this.currentSubmenu?.hide();
        if (item.submenu && item.isSelectable()) this.openSubmenu(item, false);
      }, SUBMENU_DELAY);
    } else if (item.submenu && item.isSelectable() && !item.submenu.isShown) {
      this.submenuTimer = window.setTimeout(() => this.openSubmenu(item, false), SUBMENU_DELAY);
    }
  }

  // internal
  onItemActivate(item: MenuItem, evt: MouseEvent | KeyboardEvent): void {
    if (!item.isSelectable()) return;
    if (item.submenu) {
      this.openSubmenu(item, evt instanceof KeyboardEvent);
      return;
    }
    this.rootMenu().hide();
    if (item.callback) {
      try {
        const r = item.callback(evt);
        if (r instanceof Promise) r.catch((e) => console.error(e));
      } catch (e) {
        console.error(e);
      }
    }
  }

  private clearSubmenuTimer() {
    if (this.submenuTimer !== null) {
      clearTimeout(this.submenuTimer);
      this.submenuTimer = null;
    }
  }

  private openSubmenu(item: MenuItem, selectFirst: boolean) {
    const submenu = item.submenu;
    if (!submenu) return;
    this.clearSubmenuTimer();
    if (this.currentSubmenu && this.currentSubmenu !== submenu) this.currentSubmenu.hide();
    if (!submenu.isShown) {
      const r = item.dom.getBoundingClientRect();
      const menuRect = this.dom.getBoundingClientRect();
      submenu.showAtPosition({ x: menuRect.right, y: r.top - 4, width: menuRect.width, overlap: false }, this.dom.ownerDocument);
      this.currentSubmenu = submenu;
      this.select(this.visibleItems.indexOf(item));
    }
    if (selectFirst) submenu.selectEdge(true);
  }
}
