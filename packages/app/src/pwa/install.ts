/**
 * Installing the app, and behaving like an app once installed.
 *
 * - `beforeinstallprompt` is caught at boot so Settings → General and the
 *   "Install app" command can show the browser's install dialog later.
 * - In an installed window (`display-mode: standalone` or
 *   `window-controls-overlay`) Chromium reserves no shortcuts, so Mod+W, Mod+T,
 *   Mod+N and Ctrl+Tab reach the app's hotkeys; the ones the app does not use
 *   are swallowed so they cannot close or duplicate the window by accident.
 * - With Window Controls Overlay the tab bar becomes the title bar: body gets
 *   Obsidian's `is-frameless is-hidden-frameless`, the tab groups in the top
 *   corners get `mod-top-left-space` / `mod-top-right-space`, and styles/pwa.css
 *   pads them clear of the window buttons with `env(titlebar-area-*)`.
 * - Safari (iOS and macOS) deletes script-written storage after seven days
 *   without a visit unless the site is on the Home Screen / Dock; a browser
 *   vault there shows a dismissible banner that explains how to install.
 */
import { setIcon } from "../obsidian/ui/icons";
import { PRODUCT_NAME } from "../product";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installedThisSession = false;
const listeners = new Set<() => void>();

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
export const isSafari = /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(ua);

export function isInstalledWindow(): boolean {
  if (typeof matchMedia !== "function") return false;
  return (
    matchMedia("(display-mode: standalone)").matches ||
    matchMedia("(display-mode: window-controls-overlay)").matches ||
    matchMedia("(display-mode: minimal-ui)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function installState(): "installed" | "available" | "ios" | "safari-mac" | "unavailable" {
  if (isInstalledWindow() || installedThisSession) return "installed";
  if (deferredPrompt) return "available";
  if (isIOS) return "ios";
  if (isSafari) return "safari-mac";
  return "unavailable";
}

export function onInstallStateChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify() {
  for (const cb of listeners) cb();
}

export function installInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    installedThisSession = true;
    notify();
  });
  const sync = () => document.body.toggleClass("vault-installed-app", isInstalledWindow());
  sync();
  for (const q of ["(display-mode: standalone)", "(display-mode: window-controls-overlay)"]) {
    matchMedia(q).addEventListener?.("change", sync);
  }
}

/** Shows the browser's install dialog. Resolves to the outcome, or null when none is available. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | null> {
  const prompt = deferredPrompt;
  if (!prompt) return null;
  deferredPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === "accepted") installedThisSession = true;
  notify();
  return outcome;
}

export function installInstructions(): string {
  switch (installState()) {
    case "installed":
      return `${PRODUCT_NAME} is running as an installed app.`;
    case "available":
      return `Install ${PRODUCT_NAME} as an app: it opens in its own window, starts offline, and gets Mod+W, Mod+T, Mod+N and Ctrl+Tab.`;
    case "ios":
      return "In Safari, tap the Share button, then Add to Home Screen.";
    case "safari-mac":
      return "In Safari, choose File → Add to Dock.";
    default:
      return "Use the install button in the browser's address bar or menu (Chrome, Edge). Firefox does not install web apps.";
  }
}

// ---- installed-window shortcuts ------------------------------------------------------

export function installWindowShortcuts(doc: Document = document) {
  // Bubble phase: the app's own capture-phase hotkey handler runs first and
  // prevents the default for every hotkey it uses.
  doc.addEventListener("keydown", (evt) => {
    if (evt.defaultPrevented || !isInstalledWindow()) return;
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? evt.metaKey : evt.ctrlKey;
    if (!mod || evt.altKey) return;
    const key = evt.key.toLowerCase();
    // Unbound in the app: do not let the browser close or duplicate the app window.
    if (key === "w" || key === "t" || key === "n") evt.preventDefault();
  });
}

// ---- Window Controls Overlay ---------------------------------------------------------

interface WindowControlsOverlay extends EventTarget {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

export function installWindowControlsOverlay(workspace: { on(name: string, cb: () => void): unknown; containerEl: HTMLElement } | null) {
  const wco = (navigator as { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;
  const apply = () => {
    const on = !!wco?.visible || document.body.hasClass("vault-wco-test");
    document.body.toggleClass("vault-wco", on);
    document.body.toggleClass("is-frameless", on);
    document.body.toggleClass("is-hidden-frameless", on);
    markTopCorners(on, workspace?.containerEl ?? null);
  };
  wco?.addEventListener("geometrychange", apply);
  if (workspace) {
    workspace.on("layout-change", apply);
    workspace.on("resize", apply);
  }
  apply();
  return apply;
}

/** Obsidian marks the tab groups that sit under the window buttons. */
export function markTopCorners(on: boolean, root: HTMLElement | null) {
  const groups = Array.from((root ?? document).querySelectorAll<HTMLElement>(".workspace-tabs.mod-top"));
  for (const g of groups) g.removeClasses(["mod-top-left-space", "mod-top-right-space"]);
  if (!on) return;
  const visible = groups.filter((g) => g.offsetParent !== null);
  if (!visible.length) return;
  const rects = visible.map((g) => ({ g, r: g.getBoundingClientRect() }));
  const top = Math.min(...rects.map((x) => x.r.top));
  const row = rects.filter((x) => Math.abs(x.r.top - top) < 2);
  row.sort((a, b) => a.r.left - b.r.left);
  row[0]?.g.addClass("mod-top-left-space");
  row[row.length - 1]?.g.addClass("mod-top-right-space");
}

// ---- Safari storage banner -----------------------------------------------------------

const BANNER_KEY = "openmarkdown-safari-install-banner-dismissed";

/** For vaults stored in the browser on Safari: explain eviction, point at installing. */
export function maybeShowSafariStorageBanner(opts: { vaultKind: string; parent?: HTMLElement; force?: boolean }): HTMLElement | null {
  if (!opts.force) {
    if (opts.vaultKind !== "browser") return null;
    if (!(isIOS || isSafari) || isInstalledWindow()) return null;
    try {
      const at = Number(localStorage.getItem(BANNER_KEY) ?? 0);
      if (at && Date.now() - at < 30 * 86_400_000) return null;
    } catch {
      /* show it */
    }
  }
  const parent = opts.parent ?? document.body;
  parent.querySelector(":scope > .vault-storage-banner")?.remove();
  const el = parent.createDiv({ cls: "vault-storage-banner", attr: { role: "note" } });
  const icon = el.createDiv({ cls: "vault-storage-banner-icon" });
  setIcon(icon, "lucide-shield-alert");
  const body = el.createDiv({ cls: "vault-storage-banner-text" });
  body.createDiv({ cls: "vault-storage-banner-title", text: isIOS || !isSafari ? "Add to Home Screen to keep your notes" : "Add to Dock to keep your notes" });
  body.createDiv({
    cls: "vault-storage-banner-detail",
    text: `This vault is stored in Safari, which deletes a site's data after 7 days without a visit. ${
      isIOS || !isSafari ? "Tap Share, then Add to Home Screen" : "Choose File → Add to Dock"
    }: installed apps keep their data. Exporting a backup now and then is still wise.`,
  });
  const close = el.createDiv({ cls: "clickable-icon vault-storage-banner-close", attr: { "aria-label": "Dismiss" } });
  setIcon(close, "lucide-x");
  close.addEventListener("click", () => {
    el.remove();
    try {
      localStorage.setItem(BANNER_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  });
  return el;
}
