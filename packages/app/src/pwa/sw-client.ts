/**
 * The page side of the service worker (apps/web/src/sw.ts): registration,
 * telling the worker which build this tab runs, and the update flow.
 *
 * Update flow. A new deploy installs a new worker, which waits. This tab asks
 * it for its build id:
 * - same build as this tab (the tab was loaded from the network after the
 *   deploy): the worker is told to take over, and nothing reloads;
 * - a newer build: an unobtrusive "Update available — Reload" notice appears.
 *   Reload flushes saves first; if anything is still unsaved it asks, and it
 *   never reloads on its own.
 *
 * `vite:preloadError` (a lazy chunk that failed to load) reloads once a minute
 * at most, and only when nothing is unsaved; otherwise it shows the notice.
 */
import { setIcon } from "../obsidian/ui/icons";

export const PAGE_BUILD = document.querySelector<HTMLMetaElement>('meta[name="openmarkdown-build"]')?.content || "dev";

type AppLike = { workspace?: any; saveStatus?: any } | null;

interface SwState {
  registration: ServiceWorkerRegistration | null;
  waitingBuild: string | null;
  getApp: () => AppLike;
  reloadRequested: boolean;
  notice: HTMLElement | null;
}

const state: SwState = { registration: null, waitingBuild: null, getApp: () => null, reloadRequested: false, notice: null };
const unsavedChecks = new Set<() => boolean>();

/** Extra "is anything unsaved?" checks, e.g. an open capture surface with typed text. */
export function registerUnsavedCheck(check: () => boolean): () => void {
  unsavedChecks.add(check);
  return () => unsavedChecks.delete(check);
}

/**
 * Flushes pending saves (W1's `workspace.flushSaves()` when present) and
 * reports whether anything is still unsaved.
 */
export async function hasUnsavedWork(app: AppLike): Promise<boolean> {
  const ws = app?.workspace;
  if (typeof ws?.flushSaves === "function") {
    await Promise.race([Promise.resolve(ws.flushSaves()).catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
  } else if (ws?.iterateAllLeaves) {
    const saves: Promise<unknown>[] = [];
    ws.iterateAllLeaves((leaf: any) => {
      const view = leaf.view;
      if (view?.dirty && typeof view.save === "function") saves.push(Promise.resolve(view.save()).catch(() => {}));
    });
    await Promise.race([Promise.all(saves), new Promise((r) => setTimeout(r, 4000))]);
  }
  const status = app?.saveStatus;
  if (status) {
    try {
      if (typeof status.hasUnsaved === "function" && status.hasUnsaved()) return true;
      if (typeof status.hasPending === "function" && status.hasPending()) return true;
    } catch {
      /* optional API */
    }
  }
  let dirty = false;
  ws?.iterateAllLeaves?.((leaf: any) => {
    if (leaf.view?.dirty) dirty = true;
  });
  if (dirty) return true;
  for (const check of unsavedChecks) {
    try {
      if (check()) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function serviceWorkerState() {
  return {
    pageBuild: PAGE_BUILD,
    registration: state.registration,
    updateWaiting: !!state.waitingBuild,
    async offlineReady(): Promise<boolean> {
      if (PAGE_BUILD === "dev" || !("caches" in window)) return false;
      try {
        return await caches.has(`openmarkdown-app-${PAGE_BUILD}`);
      } catch {
        return false;
      }
    },
    async checkForUpdates(): Promise<"none" | "waiting" | "unavailable"> {
      const reg = state.registration;
      if (!reg) return "unavailable";
      await reg.update().catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      if (reg.installing) await waitForState(reg.installing, ["installed", "redundant"], 60000);
      if (reg.waiting) await considerWaiting(reg.waiting);
      return state.waitingBuild ? "waiting" : "none";
    },
    applyUpdate,
  };
}

export function installServiceWorker(url: string, getApp: () => AppLike): Promise<ServiceWorkerRegistration | null> {
  state.getApp = getApp;
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
    const msg = ev.data as { type?: string } | null;
    if (msg?.type === "openmarkdown-which-build") ev.ports[0]?.postMessage({ buildId: PAGE_BUILD });
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (state.reloadRequested) location.reload();
  });
  window.addEventListener("vite:preloadError", onPreloadError);
  return navigator.serviceWorker
    .register(url, { scope: "./" })
    .then((reg) => {
      state.registration = reg;
      watch(reg);
      return reg;
    })
    .catch((e) => {
      console.warn("Service worker registration failed; the app will not start offline and images use the blob fallback.", e);
      return null;
    });
}

function watch(reg: ServiceWorkerRegistration) {
  const hello = () => navigator.serviceWorker.controller?.postMessage({ type: "openmarkdown-hello", buildId: PAGE_BUILD });
  hello();
  navigator.serviceWorker.addEventListener("controllerchange", hello);
  if (reg.waiting) void considerWaiting(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const worker = reg.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) void considerWaiting(worker);
    });
  });
  let lastCheck = Date.now();
  // A conditional request for one small file. Half-hourly was too rare: a tab left
  // open and visible kept running an old build long after a new one was deployed.
  const check = () => {
    if (Date.now() - lastCheck < 2 * 60_000) return;
    lastCheck = Date.now();
    void reg.update().catch(() => {});
  };
  window.setInterval(() => {
    if (document.visibilityState === "visible") check();
  }, 5 * 60_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  window.addEventListener("focus", check);
  window.addEventListener("online", check);
}

function waitForState(worker: ServiceWorker, states: ServiceWorkerState[], timeout: number): Promise<void> {
  return new Promise((resolve) => {
    if (states.includes(worker.state)) return resolve();
    const t = setTimeout(resolve, timeout);
    worker.addEventListener("statechange", () => {
      if (states.includes(worker.state)) {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

function askWorker<T>(worker: ServiceWorker, message: unknown, timeout = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const t = setTimeout(() => resolve(null), timeout);
    channel.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(e.data as T);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

async function considerWaiting(worker: ServiceWorker) {
  if (!navigator.serviceWorker.controller) return;
  const info = await askWorker<{ buildId: string }>(worker, { type: "openmarkdown-get-build" });
  if (!info?.buildId) return;
  if (info.buildId === PAGE_BUILD) {
    // This tab already runs the new build; let the worker take over quietly.
    worker.postMessage({ type: "openmarkdown-skip-waiting" });
    return;
  }
  state.waitingBuild = info.buildId;
  showUpdateNotice();
}

function showUpdateNotice(message = "Update available", detail = "A new version of the app is ready.") {
  state.notice?.remove();
  const el = document.body.createDiv({ cls: "vault-update-notice", attr: { role: "status", "aria-live": "polite" } });
  state.notice = el;
  const icon = el.createDiv({ cls: "vault-update-notice-icon" });
  setIcon(icon, "lucide-download");
  const text = el.createDiv({ cls: "vault-update-notice-text" });
  text.createDiv({ cls: "vault-update-notice-title", text: message });
  const detailEl = text.createDiv({ cls: "vault-update-notice-detail", text: detail });
  const actions = el.createDiv({ cls: "vault-update-notice-actions" });
  const reload = actions.createEl("button", { cls: "mod-cta", text: "Reload" });
  const close = actions.createDiv({ cls: "clickable-icon vault-update-notice-close", attr: { "aria-label": "Later" } });
  setIcon(close, "lucide-x");
  close.addEventListener("click", () => {
    el.remove();
    if (state.notice === el) state.notice = null;
  });
  reload.addEventListener("click", async () => {
    reload.disabled = true;
    const ok = await applyUpdate({
      confirm: () =>
        new Promise<boolean>((resolve) => {
          detailEl.setText("Some changes are not saved yet. Reloading now could lose them.");
          el.addClass("mod-warning");
          reload.disabled = false;
          reload.setText("Reload anyway");
          reload.removeClass("mod-cta");
          reload.addClass("mod-warning");
          const onClick = () => {
            reload.removeEventListener("click", onClick, true);
            resolve(true);
          };
          reload.addEventListener("click", onClick, true);
          close.addEventListener("click", () => resolve(false), { once: true });
        }),
    });
    if (!ok) reload.disabled = false;
  });
}

let applying = false;
/** Reload into the waiting build. Returns false when the user kept the page. */
export async function applyUpdate(opts: { confirm?: () => Promise<boolean> } = {}): Promise<boolean> {
  if (applying) return true;
  applying = true;
  try {
    if (await hasUnsavedWork(state.getApp())) {
      const go = opts.confirm ? await opts.confirm() : window.confirm("Some changes are not saved yet. Reload anyway?");
      if (!go) return false;
    }
    const waiting = state.registration?.waiting;
    if (waiting && navigator.serviceWorker.controller) {
      state.reloadRequested = true;
      waiting.postMessage({ type: "openmarkdown-skip-waiting" });
      // controllerchange reloads; if the worker never activates, reload anyway.
      window.setTimeout(() => location.reload(), 4000);
    } else {
      location.reload();
    }
    return true;
  } finally {
    applying = false;
  }
}

/**
 * Only a chunk that could not be *fetched* means the app was updated underneath this tab.
 * Vite raises the same event when a lazily imported module throws while evaluating — that
 * is a bug to surface to the caller, and reloading for it would loop on the note that
 * triggers it.
 */
function isChunkLoadFailure(ev: Event): boolean {
  const payload = (ev as Event & { payload?: unknown }).payload;
  const message = payload instanceof Error ? payload.message : String(payload ?? "");
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (CSS )?chunk .* failed/i.test(message);
}

function onPreloadError(ev: Event) {
  if (!isChunkLoadFailure(ev)) return;
  const KEY = "openmarkdown-preload-reload";
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(KEY) ?? 0);
  } catch {
    /* storage unavailable */
  }
  if (Date.now() - last < 60_000) return;
  // preventDefault must happen synchronously, so only the cheap dirty check runs here.
  let dirty = false;
  state.getApp()?.workspace?.iterateAllLeaves?.((leaf: any) => {
    if (leaf.view?.dirty) dirty = true;
  });
  for (const check of unsavedChecks) if (check()) dirty = true;
  if (dirty || state.getApp()?.saveStatus?.hasUnsaved?.()) {
    showUpdateNotice("Part of the app failed to load", "The app was updated. Reload to finish; unsaved changes are saved first.");
    return;
  }
  ev.preventDefault();
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage unavailable */
  }
  location.reload();
}
