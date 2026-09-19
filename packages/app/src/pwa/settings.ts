/**
 * Settings → General → "App": install, offline, updates, `web+obsidian://`
 * links. Rendered by settings/tabs/general.ts through `renderAppShellSettings`.
 */
import { Notice } from "../obsidian/ui/notice";
import type { AppSettingTab } from "../settings/tab-base";
import { installInstructions, installState, isInstalledWindow, onInstallStateChange, promptInstall } from "./install";
import { serviceWorkerState } from "./sw-client";
import { registerLinkHandler } from "./uri-handler";

export function renderAppShellSettings(tab: AppSettingTab, el: HTMLElement) {
  const group = tab.group(el, "App");

  const install = tab.row(group, "Install app", installInstructions());
  install.settingEl.addClass("vault-install-row");
  const state = installState();
  if (state === "available") {
    install.addButton((b) =>
      b
        .setButtonText("Install")
        .setCta()
        .onClick(async () => {
          const outcome = await promptInstall();
          if (outcome === "accepted") new Notice("Installed. Open it from your apps, dock or start menu.");
          tab.rerender();
        }),
    );
  } else if (state === "installed") {
    install.addExtraButton((b) => b.setIcon("lucide-check").setTooltip("Installed").setDisabled(true));
  }
  const off = onInstallStateChange(() => {
    if (install.settingEl.isConnected) tab.rerender();
    else off();
  });

  const sw = serviceWorkerState();
  const offline = tab.row(group, "Offline", "Checking…");
  void sw.offlineReady().then((ready) => {
    offline.setDesc(
      ready
        ? `Ready: this version (${sw.pageBuild}) starts without a connection.`
        : sw.pageBuild === "dev"
          ? "Not cached on the development server."
          : "Not ready yet. The app is being saved for offline use in the background.",
    );
  });
  offline.addButton((b) =>
    b.setButtonText("Check for updates").onClick(async () => {
      b.setDisabled(true);
      const result = await sw.checkForUpdates();
      b.setDisabled(false);
      if (result === "waiting") new Notice("An update is ready. Use Reload in the notice to switch to it.");
      else if (result === "none") new Notice("You have the latest version.");
      else new Notice("Updates arrive when you reload the page; this browser is not running the offline worker.");
    }),
  );

  const nav = navigator as Navigator & { registerProtocolHandler?: unknown };
  tab
    .row(
      group,
      "Open web+obsidian:// links",
      isInstalledWindow()
        ? "The installed app handles web+obsidian:// links. Use this if links still open elsewhere."
        : "Let this browser send web+obsidian://open?vault=…&file=… links to this app. Links with obsidian:// can be pasted after #, as in …/#obsidian://open?…",
    )
    .addButton((b) =>
      b
        .setButtonText("Set up")
        .setDisabled(typeof nav.registerProtocolHandler !== "function")
        .onClick(() => {
          const ok = registerLinkHandler();
          new Notice(ok ? "If the browser asks, allow the app to open web+obsidian links." : "This browser does not let pages handle links.");
        }),
    );
}
