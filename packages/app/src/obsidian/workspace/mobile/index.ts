/**
 * The phone and tablet layout, built from Obsidian mobile's DOM so that
 * themes and plugins which check `Platform.isMobile`, `app.isMobile` or
 * `body.is-mobile` behave:
 *
 *   body.is-mobile.is-phone|is-tablet[.mod-toolbar-open]
 *     .app-container
 *       .horizontal-main-container > .workspace
 *         .workspace-drawer.mod-left            (left sidebar as a drawer)
 *           .workspace-drawer-ribbon            (the ribbon, moved in)
 *           .workspace-drawer-inner > .workspace-drawer-header, .workspace-drawer-tab-container > .workspace-split.mod-left-split
 *         .workspace-split.mod-root             (phone: one tab group visible, `.mod-visible`)
 *         .workspace-drawer.mod-right
 *         .workspace-drawer-backdrop
 *       .mobile-navbar > .mobile-navbar-actions > .mobile-navbar-action ×5   (phone)
 *       .mobile-toolbar > .mobile-toolbar-options-container > .mobile-toolbar-options-list > .mobile-toolbar-option
 *
 * Mobile mode is chosen by the device (touch-first pointer, or an iOS/Android
 * user agent) unless Settings → Appearance → "Mobile layout" forces it on or
 * off; `app.emulateMobile(true|false)` sets that preference. Unlike Obsidian,
 * which restarts, the switch happens live; plugins already loaded keep what
 * they read from `Platform` at load time.
 *
 * The sidebars stay the same `WorkspaceSidedock` objects (plugins hold
 * references to `workspace.leftSplit`); in mobile mode their elements are
 * moved into the drawers and moved back out on leaving it.
 */
import type { App } from "../../app";
import { setIcon } from "../../ui/icons";
import { Platform } from "../../util";
import type { WorkspaceSidedock, WorkspaceTabs } from "../items";
import type { WorkspaceLeaf } from "../leaf";
import { MobileDrawer } from "./drawer";
import { installGestures } from "./gestures";
import { KeyboardTracker } from "./keyboard";
import { MobileNavbar } from "./navbar";
import { installMobileSettings } from "./settings";
import { MobileTabSwitcher } from "./tab-switcher";
import { MobileToolbar, registerMobileCommands } from "./toolbar";

export type MobileLayoutPreference = "auto" | "on" | "off";
export type FormFactor = "phone" | "tablet";

const PREF_KEY = "vault-mobile-layout";

export function getMobileLayoutPreference(): MobileLayoutPreference {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const DEVICE = {
  ios: /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1),
  android: /Android/.test(ua),
};
const DESKTOP_PLATFORM = { isDesktop: Platform.isDesktop, isMobile: Platform.isMobile, isPhone: Platform.isPhone, isTablet: Platform.isTablet };

/** Whether this device wants the mobile layout when the preference is "auto". */
export function deviceWantsMobile(): boolean {
  if (DEVICE.ios || DEVICE.android) return true;
  try {
    // A touch-first device (primary pointer coarse, no hover) of tablet size or smaller.
    const touchFirst = matchMedia("(pointer: coarse)").matches && matchMedia("(hover: none)").matches;
    return touchFirst && Math.min(window.innerWidth, window.innerHeight) <= 1100;
  } catch {
    return false;
  }
}

function currentFormFactor(): FormFactor {
  return Math.min(window.innerWidth, window.innerHeight) < 600 ? "phone" : "tablet";
}

export class MobileLayout {
  app: App;
  active = false;
  formFactor: FormFactor | null = null;
  drawers: { left: MobileDrawer; right: MobileDrawer } | null = null;
  navbar: MobileNavbar | null = null;
  toolbar: MobileToolbar;
  tabSwitcher: MobileTabSwitcher;
  keyboard: KeyboardTracker;
  backdropEl: HTMLElement | null = null;
  private activeCleanups: (() => void)[] = [];
  private lastWidth = window.innerWidth;
  private sidebarToggleEls: { left: HTMLElement; right: HTMLElement } | null = null;

  constructor(app: App) {
    this.app = app;
    this.toolbar = new MobileToolbar(app, this);
    this.tabSwitcher = new MobileTabSwitcher(app);
    this.keyboard = new KeyboardTracker(app, this);
  }

  // internal: called once from App.initialize, after the workspace exists and before plugins load
  install() {
    registerMobileCommands(this.app, this);
    installMobileSettings(this.app, this);
    window.addEventListener("resize", () => {
      // The on-screen keyboard changes the height only; re-decide on width
      // (rotation, window resize) so typing never flips the layout.
      if (window.innerWidth === this.lastWidth) return;
      this.lastWidth = window.innerWidth;
      this.apply();
    });
    this.apply();
  }

  shouldBeMobile(): boolean {
    const pref = this.forced ?? getMobileLayoutPreference();
    return pref === "on" ? true : pref === "off" ? false : deviceWantsMobile();
  }

  setPreference(pref: MobileLayoutPreference) {
    this.forced = null;
    try {
      if (pref === "auto") localStorage.removeItem(PREF_KEY);
      else localStorage.setItem(PREF_KEY, pref);
    } catch {
      /* private window: the switch still applies for this session */
      this.forced = pref;
    }
    this.apply();
  }

  private forced: MobileLayoutPreference | null = null;

  /** Obsidian's `app.emulateMobile(emulate)`. */
  emulate(emulate: boolean) {
    this.setPreference(emulate ? "on" : "off");
  }

  apply() {
    const want = this.shouldBeMobile();
    if (want && !this.active) this.enter();
    else if (!want && this.active) this.exit();
    else if (want && this.formFactor !== currentFormFactor()) {
      this.exit();
      this.enter();
    }
  }

  // ---- entering and leaving ---------------------------------------------------------

  private setPlatform(mobile: boolean, factor: FormFactor | null) {
    const p = Platform as unknown as Record<string, boolean>;
    if (mobile) {
      p.isMobile = true;
      p.isDesktop = false;
      p.isPhone = factor === "phone";
      p.isTablet = factor === "tablet";
    } else {
      Object.assign(p, DESKTOP_PLATFORM);
      if (DESKTOP_PLATFORM.isMobile) {
        // A real phone forced to the desktop layout.
        p.isMobile = false;
        p.isDesktop = true;
        p.isPhone = false;
        p.isTablet = false;
      }
    }
    (this.app as unknown as { isMobile: boolean }).isMobile = mobile;
  }

  private enter() {
    const app = this.app;
    const ws = app.workspace;
    const factor = currentFormFactor();
    this.active = true;
    this.formFactor = factor;
    this.setPlatform(true, factor);
    const body = document.body;
    body.addClass("is-mobile", factor === "phone" ? "is-phone" : "is-tablet");
    body.toggleClass("is-ios", DEVICE.ios);
    body.toggleClass("is-android", DEVICE.android);

    // Drawers
    this.backdropEl = ws.containerEl.createDiv({ cls: "workspace-drawer-backdrop" });
    this.backdropEl.addEventListener("click", () => this.closeDrawers());
    const left = new MobileDrawer(app, this, ws.leftSplit, "left");
    const right = new MobileDrawer(app, this, ws.rightSplit, "right");
    ws.containerEl.insertBefore(left.containerEl, ws.rootSplit.containerEl);
    ws.containerEl.insertBefore(right.containerEl, this.backdropEl);
    left.attachRibbon(ws.leftRibbon);
    this.drawers = { left, right };
    // Drawers start closed: a sidebar open from the desktop layout would cover the note.
    if (!ws.leftSplit.collapsed) ws.leftSplit.collapse();
    if (!ws.rightSplit.collapsed) ws.rightSplit.collapse();
    left.sync();
    right.sync();

    // Bottom navigation (phones) and the keyboard toolbar
    if (factor === "phone") {
      this.navbar = new MobileNavbar(app, this);
      app.dom.appContainerEl.insertBefore(this.navbar.containerEl, app.dom.horizontalMainContainerEl.nextSibling);
    }
    this.toolbar.attach(app.dom.appContainerEl);
    this.keyboard.start();

    const refresh = () => this.onLayoutChange();
    const refs = [ws.on("layout-change", refresh), ws.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => this.onActiveLeafChange(leaf)), ws.on("file-open", refresh)];
    this.activeCleanups.push(() => refs.forEach((r) => ws.offref(r)));
    this.activeCleanups.push(installGestures(app, this));
    this.activeCleanups.push(this.installSettingsNavigation());

    const withMobile = app as unknown as { mobileNavbar: unknown; mobileToolbar: unknown; mobileTabSwitcher: unknown };
    withMobile.mobileNavbar = this.navbar;
    withMobile.mobileToolbar = this.toolbar;
    withMobile.mobileTabSwitcher = this.tabSwitcher;

    this.onLayoutChange();
    ws.trigger("resize");
    ws.trigger("layout-change");
  }

  private exit() {
    const app = this.app;
    const ws = app.workspace;
    this.active = false;
    for (const c of this.activeCleanups.splice(0)) {
      try {
        c();
      } catch (e) {
        console.error(e);
      }
    }
    this.tabSwitcher.hide();
    this.keyboard.stop();
    this.toolbar.detach();
    this.navbar?.containerEl.detach();
    this.navbar = null;
    if (this.drawers) {
      // Put the sidebars and ribbons back where the desktop layout has them.
      const root = ws.rootSplit.containerEl;
      this.drawers.left.detachRibbon(ws.leftRibbon);
      ws.containerEl.insertBefore(ws.leftRibbon.containerEl, root);
      ws.containerEl.insertBefore(ws.leftSplit.containerEl, root);
      root.after(ws.rightSplit.containerEl);
      ws.rightSplit.containerEl.after(ws.rightRibbon.containerEl);
      this.drawers.left.destroy();
      this.drawers.right.destroy();
      this.drawers = null;
      // Restore the inline widths the drawers overrode.
      for (const dock of [ws.leftSplit, ws.rightSplit]) {
        if (dock.collapsed) dock.containerEl.style.width = "0px";
        else dock.setSize(dock.size);
      }
    }
    this.backdropEl?.remove();
    this.backdropEl = null;
    this.sidebarToggleEls?.left.detach();
    this.sidebarToggleEls?.right.detach();
    for (const el of Array.from(ws.rootSplit.containerEl.querySelectorAll(".workspace-tabs.mod-visible"))) el.removeClass("mod-visible");
    const body = document.body;
    body.removeClass("is-mobile", "is-phone", "is-tablet", "is-ios", "is-android", "mod-toolbar-open", "is-hidden-nav");
    this.formFactor = null;
    this.setPlatform(false, null);
    const withMobile = app as unknown as { mobileNavbar: unknown; mobileToolbar: unknown; mobileTabSwitcher: unknown };
    withMobile.mobileNavbar = null;
    withMobile.mobileToolbar = null;
    withMobile.mobileTabSwitcher = null;
    ws.trigger("resize");
    ws.trigger("layout-change");
  }

  // ---- workspace hooks ------------------------------------------------------------------

  // internal: from Workspace.onSidedockToggled
  onDockToggled(dock: WorkspaceSidedock) {
    if (!this.active || !this.drawers) return;
    const drawer = dock.side === "left" ? this.drawers.left : this.drawers.right;
    const other = dock.side === "left" ? this.drawers.right : this.drawers.left;
    if (!dock.collapsed && !other.dock.collapsed) other.dock.collapse();
    drawer.sync();
    other.sync();
    const anyOpen = !this.drawers.left.dock.collapsed || !this.drawers.right.dock.collapsed;
    this.backdropEl?.toggleClass("is-visible", anyOpen);
    if (anyOpen) {
      // The keyboard would cover the drawer.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && this.app.workspace.rootSplit.containerEl.contains(focused)) focused.blur();
    }
  }

  // internal: from Workspace.changeLayout
  onLayoutRestored() {
    if (!this.active) return;
    const ws = this.app.workspace;
    if (!ws.leftSplit.collapsed) ws.leftSplit.collapse();
    if (!ws.rightSplit.collapsed) ws.rightSplit.collapse();
    this.onLayoutChange();
  }

  closeDrawers() {
    const ws = this.app.workspace;
    if (!ws.leftSplit.collapsed) ws.leftSplit.collapse();
    if (!ws.rightSplit.collapsed) ws.rightSplit.collapse();
  }

  isDrawerOpen(): boolean {
    const ws = this.app.workspace;
    return !ws.leftSplit.collapsed || !ws.rightSplit.collapsed;
  }

  private onActiveLeafChange(leaf: WorkspaceLeaf | null) {
    // Opening something in the main area (a file tapped in the explorer) closes the drawer on a phone.
    if (leaf && this.formFactor === "phone" && leaf.getRoot() === this.app.workspace.rootSplit) this.closeDrawers();
    this.onLayoutChange();
  }

  private onLayoutChange() {
    if (!this.active) return;
    const ws = this.app.workspace;
    const visible = ws.getMostRecentLeaf(ws.rootSplit);
    const visibleTabs = (visible?.parent ?? null) as WorkspaceTabs | null;
    const walk = (el: Element) => {
      for (const t of Array.from(el.querySelectorAll(".workspace-tabs"))) {
        t.toggleClass("mod-visible", this.formFactor === "tablet" || t === visibleTabs?.containerEl);
      }
    };
    walk(ws.rootSplit.containerEl);
    this.placeSidebarToggles(visible);
    this.navbar?.update();
    this.tabSwitcher.requestRender();
  }

  /**
   * Sidebar toggles where a thumb finds them: in the view header on a phone
   * (the tab bar is hidden there), at the ends of the tab bar on a tablet.
   */
  private placeSidebarToggles(visible: WorkspaceLeaf | null) {
    const ws = this.app.workspace;
    if (!this.sidebarToggleEls) {
      const make = (side: "left" | "right") => {
        const el = createDiv({ cls: ["clickable-icon", "sidebar-toggle-button", `mod-${side}`, "vault-mobile-sidebar-toggle"], attr: { "aria-label": side === "left" ? "Open left sidebar" : "Open right sidebar" } });
        setIcon(el, side === "left" ? "lucide-panel-left" : "lucide-panel-right");
        el.addEventListener("click", (evt) => {
          evt.stopPropagation();
          (side === "left" ? ws.leftSplit : ws.rightSplit).toggle();
        });
        return el;
      };
      this.sidebarToggleEls = { left: make("left"), right: make("right") };
    }
    const { left, right } = this.sidebarToggleEls;
    if (this.formFactor === "phone") {
      const header = (visible?.view as { headerEl?: HTMLElement } | undefined)?.headerEl;
      if (header) {
        const leftSlot = header.querySelector(":scope > .view-header-left") ?? header;
        if (left.parentElement !== leftSlot) leftSlot.prepend(left);
        const actions = header.querySelector(":scope > .view-actions");
        if (actions && right.parentElement !== actions) actions.appendChild(right);
      }
      return;
    }
    const groups = Array.from(ws.rootSplit.containerEl.querySelectorAll<HTMLElement>(".workspace-tabs"));
    const first = groups[0]?.querySelector<HTMLElement>(":scope > .workspace-tab-header-container");
    const last = groups[groups.length - 1]?.querySelector<HTMLElement>(":scope > .workspace-tab-header-container");
    if (first && left.parentElement !== first) first.prepend(left);
    if (last && right.parentElement !== last) last.appendChild(right);
  }

  /**
   * Settings on a phone: the tab list fills the screen, choosing a tab shows
   * its page with a back button (`.modal-setting-back-button`).
   */
  private installSettingsNavigation(): () => void {
    const setting = this.app.setting as {
      modalEl?: HTMLElement;
      tabContentContainer?: HTMLElement;
      openTab?: (tab: unknown) => void;
      onOpen?: () => void;
    };
    if (!setting?.modalEl || !setting.openTab || !setting.onOpen) return () => {};
    const modalEl = setting.modalEl;
    const origOpenTab = setting.openTab;
    const origOnOpen = setting.onOpen;
    let opening = false;
    const back = createDiv({ cls: ["modal-setting-back-button", "clickable-icon"], attr: { "aria-label": "Back" } });
    setIcon(back.createSpan({ cls: "modal-setting-back-button-icon" }), "lucide-chevron-left");
    back.createSpan({ text: "Settings" });
    back.addEventListener("click", () => modalEl.removeClass("vault-mobile-page-open"));
    setting.openTab = function (this: unknown, tab: unknown) {
      origOpenTab.call(setting, tab);
      if (!opening) modalEl.addClass("vault-mobile-page-open");
      if (setting.tabContentContainer && back.parentElement !== setting.tabContentContainer) setting.tabContentContainer.prepend(back);
    };
    setting.onOpen = function () {
      opening = true;
      try {
        origOnOpen.call(setting);
      } finally {
        opening = false;
      }
      modalEl.removeClass("vault-mobile-page-open");
    };
    return () => {
      setting.openTab = origOpenTab;
      setting.onOpen = origOnOpen;
      back.remove();
      modalEl.removeClass("vault-mobile-page-open");
    };
  }
}

/** Installs the mobile layout controller on the app. */
export function installMobileLayout(app: App): MobileLayout {
  const layout = new MobileLayout(app);
  layout.install();
  return layout;
}
