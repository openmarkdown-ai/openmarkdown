/**
 * The account control and the brand mark, placed inside Obsidian's own chrome.
 *
 * The web build (apps/web) asks for these through `BootOptions.chrome`; a
 * build that does not ask gets neither. Nothing here contacts any server:
 * whether someone is signed in is read from the session the account page
 * keeps in this origin's localStorage, and the control is a plain link to
 * that page. The workspace never loads the account code at all.
 *
 * Why here and not in a bar of our own: a web app at /app/ normally carries a
 * 52px top bar (brand left, account right). This workspace already has one —
 * Obsidian's tab-header row, which is the top edge of the window — and a
 * second bar stacked above it would push every theme's and plugin's layout
 * down and put two bars on one screen. So the two pieces go where that chrome
 * already has room for them:
 *
 * - **Account, top right.** Appended to the tab-header container of the tab
 *   group in the window's top-right corner — the slot Obsidian gives the
 *   right-sidebar toggle — and moved when the layout changes (a split, the
 *   right sidebar opening). On a phone, where the tab bar is hidden, it goes
 *   at the end of the visible note's header actions, beside the right-sidebar
 *   toggle the mobile layout puts there. On the vault chooser it sits in the
 *   top-right corner of the page.
 * - **Brand, top left.** The product tile at the top of the left ribbon, a
 *   link to the landing page — only when the app is served beside one
 *   (`homeUrl`); a self-hosted copy has nowhere else to go.
 *
 * Both use Obsidian's `clickable-icon` class, so themes colour them like the
 * icons around them, and neither has a `workspace-` or `view-` class a plugin
 * could mistake for its own.
 *
 * The workspace opens the account page in a new tab: the vault stays open
 * (and a folder vault keeps its permission, which a reload would have to ask
 * for again), and the sign-in round trip happens where nothing can be lost.
 */
import type { App } from "../obsidian/app";
import { setIcon } from "../obsidian/ui/icons";
import { PRODUCT_NAME } from "../product";

export interface ChromeOptions {
  /** The account page. */
  accountUrl: string;
  /** The landing page the brand mark links to; null when there is none. */
  homeUrl?: string | null;
  /** The product tile (favicon). */
  brandIconUrl?: string;
}

/** Where the account page's client keeps its session (the SDK's default key). */
export const SESSION_KEY = "openapps.session";

export function hasLocalSession(): boolean {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw) as { accessToken?: unknown; refreshToken?: unknown };
    return !!(s.accessToken && s.refreshToken);
  } catch {
    return false;
  }
}

export function createAccountControl(opts: ChromeOptions, newTab: boolean): HTMLAnchorElement {
  const a = createEl("a", {
    cls: "clickable-icon vault-account-control",
    attr: { href: opts.accountUrl, "aria-label": "Account", "data-tooltip-position": "bottom" },
  });
  if (newTab) {
    a.target = "_blank";
    a.rel = "noopener";
  }
  setIcon(a, "lucide-circle-user-round");
  const sync = () => {
    const signedIn = hasLocalSession();
    a.toggleClass("is-signed-in", signedIn);
    a.dataset.signedIn = String(signedIn);
  };
  sync();
  // Signing in or out happens on the account page, usually in another tab.
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === SESSION_KEY) sync();
  });
  window.addEventListener("focus", sync);
  return a;
}

function createBrandLink(opts: ChromeOptions): HTMLAnchorElement | null {
  if (!opts.homeUrl) return null;
  const a = createEl("a", {
    cls: "clickable-icon vault-brand-link",
    attr: { href: opts.homeUrl, "aria-label": `${PRODUCT_NAME} home`, "data-tooltip-position": "right" },
  });
  const img = a.createEl("img", { attr: { src: opts.brandIconUrl ?? "./favicon.svg", alt: "", width: "22", height: "22" } });
  img.draggable = false;
  return a;
}

/** Put the account control and brand mark into an open vault's workspace. */
export function installWorkspaceChrome(app: App, opts: ChromeOptions): void {
  const control = createAccountControl(opts, true);
  const brand = createBrandLink(opts);
  const ws = app.workspace;

  const placeBrand = () => {
    if (!brand) return;
    const ribbon = ws.leftRibbon?.containerEl;
    if (ribbon && (brand.parentElement !== ribbon || ribbon.firstElementChild !== brand)) ribbon.prepend(brand);
  };

  const placeControl = () => {
    const target = document.body.hasClass("is-phone") ? phoneSlot(app) : topRightTabHeader(ws.containerEl);
    if (target && (control.parentElement !== target || target.lastElementChild !== control)) target.appendChild(control);
  };

  let queued = false;
  const place = () => {
    if (queued) return;
    queued = true;
    // After the layout (and the mobile layout's own toggles) have settled.
    requestAnimationFrame(() => {
      queued = false;
      placeBrand();
      placeControl();
    });
  };
  ws.onLayoutReady(() => {
    place();
    ws.on("layout-change", place);
    ws.on("resize", place);
    ws.on("active-leaf-change", place);
    ws.on("css-change", place);
  });
}

/** The tab-header container of the tab group in the window's top-right corner. */
function topRightTabHeader(root: HTMLElement): HTMLElement | null {
  const groups = Array.from(root.querySelectorAll<HTMLElement>(".workspace-tabs.mod-top")).filter((g) => g.offsetParent !== null);
  if (!groups.length) return null;
  const rects = groups.map((g) => ({ g, r: g.getBoundingClientRect() }));
  const top = Math.min(...rects.map((x) => x.r.top));
  const row = rects.filter((x) => Math.abs(x.r.top - top) < 2).sort((a, b) => b.r.right - a.r.right);
  return row[0]?.g.querySelector<HTMLElement>(":scope > .workspace-tab-header-container") ?? null;
}

/** On a phone the tab bar is hidden: the visible note's header actions. */
function phoneSlot(app: App): HTMLElement | null {
  const leaves = Array.from(app.workspace.containerEl.querySelectorAll<HTMLElement>(".workspace-split.mod-root .workspace-leaf")).filter((l) => l.offsetParent !== null);
  for (const leaf of leaves) {
    const actions = leaf.querySelector<HTMLElement>(".view-header > .view-actions");
    if (actions && actions.offsetParent !== null) return actions;
  }
  return null;
}

/**
 * The vault chooser: no workspace, so the control sits in the page's top-right
 * corner and the brand mark above the product name.
 */
export function installStarterChrome(root: HTMLElement, opts: ChromeOptions): void {
  const brand = createBrandLink(opts);
  if (brand) root.querySelector(".vault-starter-brand")?.prepend(brand);
  // Nothing is open here, so the account page can take this tab.
  root.createDiv({ cls: "vault-starter-chrome" }).appendChild(createAccountControl(opts, false));
}
