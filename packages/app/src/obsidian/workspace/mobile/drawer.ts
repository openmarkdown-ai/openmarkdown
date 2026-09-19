/**
 * A sidebar shown as a drawer (`.workspace-drawer`) on phones and tablets.
 *
 *   .workspace-drawer.mod-left.mod-primary[.is-open]
 *     .workspace-drawer-ribbon > .side-dock-actions …    (left drawer: the ribbon, moved in)
 *     .workspace-drawer-inner
 *       .workspace-drawer-header
 *         .workspace-drawer-header-left > .workspace-drawer-header-name > .workspace-drawer-header-name-text
 *         .workspace-drawer-header-icon.clickable-icon ×n
 *       .workspace-drawer-tab-container > .workspace-split.mod-sidedock   (the dock itself)
 *
 * Open and closed follow the dock's own `collapsed`, so `leftSplit.expand()`,
 * `collapse()` and `toggle()` from plugins open and close the drawer.
 */
import type { App } from "../../app";
import { setIcon } from "../../ui/icons";
import type { WorkspaceRibbon, WorkspaceSidedock } from "../items";
import type { MobileLayout } from "./index";

export class MobileDrawer {
  app: App;
  dock: WorkspaceSidedock;
  side: "left" | "right";
  containerEl: HTMLElement;
  innerEl: HTMLElement;
  headerEl: HTMLElement;
  tabContainerEl: HTMLElement;
  ribbonHostEl: HTMLElement | null = null;
  private layout: MobileLayout;

  constructor(app: App, layout: MobileLayout, dock: WorkspaceSidedock, side: "left" | "right") {
    this.app = app;
    this.layout = layout;
    this.dock = dock;
    this.side = side;
    this.containerEl = createDiv({ cls: ["workspace-drawer", `mod-${side}`, side === "left" ? "mod-primary" : "mod-secondary"] });
    this.innerEl = this.containerEl.createDiv({ cls: "workspace-drawer-inner" });
    this.headerEl = this.innerEl.createDiv({ cls: "workspace-drawer-header" });
    const left = this.headerEl.createDiv({ cls: "workspace-drawer-header-left" });
    const name = left.createDiv({ cls: "workspace-drawer-header-name" });
    if (side === "left") {
      name.createDiv({ cls: "workspace-drawer-header-name-text", text: app.vault.getName() });
      name.addClass("tappable");
      name.setAttr("aria-label", "Manage vaults");
      name.addEventListener("click", () => app.vaultSwitcher?.open());
      this.headerIcon("lucide-settings", "Open settings", () => {
        layout.closeDrawers();
        app.setting.open();
      });
    } else {
      name.createDiv({ cls: "workspace-drawer-header-name-text", text: "" });
      this.headerIcon("lucide-search", "Command palette", () => {
        layout.closeDrawers();
        app.commands.executeCommandById("command-palette:open");
      });
    }
    this.headerIcon("lucide-x", "Close", () => dock.collapse());
    this.tabContainerEl = this.innerEl.createDiv({ cls: "workspace-drawer-tab-container" });
    this.tabContainerEl.appendChild(dock.containerEl);
  }

  private headerIcon(icon: string, label: string, run: () => void) {
    const el = this.headerEl.createDiv({ cls: ["workspace-drawer-header-icon", "clickable-icon"], attr: { "aria-label": label } });
    setIcon(el, icon);
    el.addEventListener("click", run);
    return el;
  }

  attachRibbon(ribbon: WorkspaceRibbon) {
    ribbon.containerEl.addClass("workspace-drawer-ribbon");
    this.containerEl.insertBefore(ribbon.containerEl, this.innerEl);
    this.ribbonHostEl = ribbon.containerEl;
    // A ribbon action run from the drawer should not leave the drawer over its result.
    ribbon.ribbonActionsEl.addEventListener("click", this.onRibbonClick);
  }

  detachRibbon(ribbon: WorkspaceRibbon) {
    ribbon.containerEl.removeClass("workspace-drawer-ribbon");
    ribbon.ribbonActionsEl.removeEventListener("click", this.onRibbonClick);
    this.ribbonHostEl = null;
  }

  private onRibbonClick = (evt: MouseEvent) => {
    if (!(evt.target as HTMLElement).closest(".side-dock-ribbon-action")) return;
    if (this.layout.formFactor === "phone") window.setTimeout(() => this.layout.closeDrawers(), 0);
  };

  /** Mirror the dock's collapsed state and the active tab's title. */
  sync() {
    const open = !this.dock.collapsed;
    this.containerEl.toggleClass("is-open", open);
    this.containerEl.setAttr("aria-hidden", open ? "false" : "true");
    if (this.side === "right") {
      const tabs = this.dock.children[0] as { getActiveLeaf?: () => { getDisplayText(): string } | null } | undefined;
      const title = tabs?.getActiveLeaf?.()?.getDisplayText() ?? "";
      this.headerEl.querySelector(".workspace-drawer-header-name-text")?.setText(title);
    }
  }

  destroy() {
    this.containerEl.remove();
  }
}
