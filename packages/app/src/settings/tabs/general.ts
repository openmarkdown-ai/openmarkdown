/**
 * Settings → General (§6.1). Desktop-only rows (automatic updates, installer
 * version, command line interface, licences, account) have no browser
 * equivalent and are left out; the app updates when the page does.
 */
import type { App } from "../../obsidian/app";
import { APP_VERSION, PRODUCT_NAME } from "../../product";
import { apiVersion } from "../../obsidian/util";
import { HELP_URL } from "../helpers";
import { AppSettingTab, descFragment } from "../tab-base";
import { renderAppShellSettings } from "../../pwa/settings";

export const LANGUAGES: Record<string, string> = { en: "English" };

export function getLanguage(): string {
  try {
    return localStorage.getItem("language") || "en";
  } catch {
    return "en";
  }
}

export class GeneralSettingTab extends AppSettingTab {
  constructor(app: App) {
    super(app, "general", "General", "lucide-settings");
  }

  render(el: HTMLElement): void {
    const app = this.app;
    const about = this.group(el);
    this.row(
      about,
      `${PRODUCT_NAME} ${APP_VERSION}`,
      descFragment([`Implements the plugin API of Obsidian ${apiVersion}. `, "Updates arrive when you reload the page."]),
    ).addButton((b) => b.setButtonText("Reload").onClick(() => location.reload()));

    this.row(about, "Language", "Change the display language.").addDropdown((d) =>
      d
        .addOptions(LANGUAGES)
        .setValue(getLanguage())
        .onChange((v) => {
          try {
            localStorage.setItem("language", v);
          } catch {
            /* storage unavailable */
          }
        }),
    );

    this.row(about, "Help", "Learn how to use the app and find answers to common questions.").addButton((b) =>
      b.setButtonText("Open").onClick(() => window.open(HELP_URL, "_blank", "noopener")),
    );

    renderAppShellSettings(this, el);

    const vaults = this.group(el, "Vaults");
    this.row(vaults, "Current vault", app.vault.getName()).addButton((b) =>
      b
        .setButtonText("Open another vault")
        .setCta()
        .onClick(() => {
          app.setting?.close();
          app.vaultSwitcher?.open();
        }),
    );

    const advanced = this.group(el, "Advanced");
    const key = "notify-startup";
    this.row(advanced, "Notify if startup takes longer than expected", "Show a notice with a breakdown when opening the vault takes more than a few seconds.").addToggle(
      (t) => t.setValue(app.loadLocalStorage(key) === true).onChange((v) => app.saveLocalStorage(key, v ? true : null)),
    );
  }
}
