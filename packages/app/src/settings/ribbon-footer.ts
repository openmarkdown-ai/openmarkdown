/**
 * The bottom of the left ribbon (`leftRibbon.ribbonSettingEl`,
 * `.side-dock-settings`): the vault switcher, Help and Settings.
 *
 * The vault button opens a menu with the vaults this browser knows (from
 * IndexedDB, via `listVaults()` in boot.ts) and "Manage vaults…".
 */
import type { App } from "../obsidian/app";
import { setIcon } from "../obsidian/ui/icons";
import { Menu } from "../obsidian/ui/menu";
import { HELP_URL } from "./helpers";

function ribbonButton(parent: HTMLElement, cls: string, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
  const el = parent.createDiv({
    cls: `clickable-icon side-dock-ribbon-action ${cls}`,
    attr: { "aria-label": label, "data-tooltip-position": "right", role: "button", tabindex: 0 },
  });
  setIcon(el, icon);
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      el.click();
    }
  });
  return el;
}

export async function showVaultMenu(app: App, evt: MouseEvent | null, anchor: HTMLElement): Promise<void> {
  const menu = new Menu();
  const current = app.appId;
  menu.addItem((i) => i.setTitle(app.vault.getName()).setIcon("lucide-vault").setIsLabel(true));
  menu.addSeparator();
  let vaults: { id: string; name: string; kind: string }[] = [];
  try {
    const { listVaults } = await import("../boot");
    vaults = await listVaults();
  } catch (e) {
    console.error(e);
  }
  for (const v of vaults.slice(0, 10)) {
    menu.addItem((i) =>
      i
        .setTitle(v.name)
        .setIcon(v.kind === "folder" ? "lucide-folder" : "lucide-hard-drive")
        .setChecked(v.id === current)
        .onClick(() => {
          if (v.id !== current) app.vaultSwitcher?.switchTo(v.id);
        }),
    );
  }
  if (current !== "demo") {
    menu.addItem((i) =>
      i
        .setTitle("Demo vault")
        .setIcon("lucide-box")
        .onClick(() => app.vaultSwitcher?.switchTo("demo")),
    );
  }
  menu.addSeparator();
  menu.addItem((i) =>
    i
      .setTitle("Manage vaults…")
      .setIcon("lucide-settings-2")
      .onClick(() => app.vaultSwitcher?.open()),
  );
  if (evt && evt.detail > 0) {
    menu.showAtMouseEvent(evt);
  } else {
    const r = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: r.right + 4, y: r.bottom });
  }
}

export function installRibbonFooter(app: App): HTMLElement {
  const el = app.workspace.leftRibbon.ribbonSettingEl;
  el.querySelector(":scope > .vault-ribbon-footer")?.remove();
  const footer = el.createDiv({ cls: "vault-ribbon-footer" });
  const vaultBtn = ribbonButton(footer, "vault-ribbon-vault-switcher", "lucide-vault", app.vault.getName(), (evt) => void showVaultMenu(app, evt, vaultBtn));
  vaultBtn.setAttr("aria-haspopup", "menu");
  ribbonButton(footer, "vault-ribbon-help", "lucide-help-circle", "Help", () => window.open(HELP_URL, "_blank", "noopener"));
  ribbonButton(footer, "vault-ribbon-settings", "lucide-settings", "Settings", () => app.setting.open());
  return footer;
}
