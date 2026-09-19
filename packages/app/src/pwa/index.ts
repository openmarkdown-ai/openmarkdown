/**
 * The web app shell (workstream W2): service worker and updates, install,
 * installed-window behaviour, file launches, share in/out, and the
 * single-file and capture routes. boot.ts calls `installPwaShell()` first
 * thing and `installPwaInApp(app)` once an App exists.
 */
import type { App } from "../obsidian/app";
import { whenLayoutReady } from "../settings/helpers";
import { installInstallPrompt, installState, installWindowControlsOverlay, installWindowShortcuts, maybeShowSafariStorageBanner, promptInstall, installInstructions } from "./install";
import { deliverLaunch, listenForLaunchHandOff, openLaunchInApp, setLaunchHandler, takePendingOpen, installLaunchQueue } from "./launch";
import { shareFile } from "./share";
import { installServiceWorker } from "./sw-client";
import { Notice } from "../obsidian/ui/notice";

export { hasUnsavedWork, registerUnsavedCheck, serviceWorkerState, PAGE_BUILD } from "./sw-client";
export { installState, isInstalledWindow, promptInstall, maybeShowSafariStorageBanner } from "./install";
export { deliverLaunch } from "./launch";
export { renderAppShellSettings } from "./settings";

let shellInstalled = false;

export function installPwaShell(opts: { serviceWorkerUrl?: string }) {
  if (shellInstalled) return;
  shellInstalled = true;
  installLaunchQueue();
  listenForLaunchHandOff();
  installInstallPrompt();
  installWindowShortcuts();
  if (opts.serviceWorkerUrl) void installServiceWorker(opts.serviceWorkerUrl, () => (window as unknown as { app?: App }).app ?? null);
  // internal (used by tests and the diagnostics page)
  (window as unknown as Record<string, unknown>).__openmarkdownPwa = { deliverLaunch };
}

export function installPwaInApp(app: App) {
  setLaunchHandler((files) => void openLaunchInApp(app, files));

  app.commands.addCommand({
    id: "app:install",
    name: "Install app",
    icon: "lucide-monitor-down",
    checkCallback: (checking: boolean) => {
      const state = installState();
      if (state === "installed" || state === "unavailable") return false;
      if (!checking) {
        if (state === "available") void promptInstall();
        else new Notice(installInstructions(), 10000);
      }
      return true;
    },
  });
  app.commands.addCommand({
    id: "app:share-file",
    name: "Share current file",
    icon: "lucide-share",
    checkCallback: (checking: boolean) => {
      const file = app.workspace?.getActiveFile();
      if (!file) return false;
      if (!checking) void shareFile(app, file);
      return true;
    },
  });

  whenLayoutReady(app, () => {
    const ws = app.workspace;
    ws.on("file-menu", (menu: any, file: any) => {
      if (!file || file.children !== undefined || typeof navigator.share !== "function") return;
      menu.addItem((item: any) =>
        item
          .setSection("action")
          .setTitle("Share")
          .setIcon("lucide-share")
          .onClick(() => void shareFile(app, file)),
      );
    });
    installWindowControlsOverlay(ws);
    maybeShowSafariStorageBanner({ vaultKind: (app.vault.adapter as { kind: string }).kind, parent: app.dom.appContainerEl });
    // A launched file (or an obsidian:// link routed here) waiting for this vault.
    for (const path of takePendingOpen(app.appId)) {
      const file = app.vault.getFileByPath(path);
      if (file) void ws.getLeaf("tab").openFile(file, { active: true });
    }
  });
}
