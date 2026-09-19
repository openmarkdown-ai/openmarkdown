/**
 * The phone's bottom navigation bar (`app.mobileNavbar`):
 *
 *   .mobile-navbar
 *     .mobile-navbar-actions
 *       .mobile-navbar-action ×5   Back · Forward · New tab · Tabs (count) · Menu
 *
 * Back and forward act on the tab showing in the main area. "New tab" opens an
 * empty tab and the quick switcher ("Find or create a note"). The tab count
 * opens the tab overview. Menu lists the ribbon's actions (as Obsidian's ribbon
 * menu does) followed by the sidebars, the command palette and settings.
 * Hidden while the keyboard toolbar is up.
 */
import type { App } from "../../app";
import { setIcon } from "../../ui/icons";
import { Menu } from "../../ui/menu";
import type { WorkspaceLeaf } from "../leaf";
import type { MobileLayout } from "./index";

export class MobileNavbar {
  app: App;
  containerEl: HTMLElement;
  actionsEl: HTMLElement;
  backEl: HTMLElement;
  forwardEl: HTMLElement;
  newTabEl: HTMLElement;
  tabsEl: HTMLElement;
  menuEl: HTMLElement;

  constructor(app: App, layout: MobileLayout) {
    this.app = app;
    this.containerEl = createDiv({ cls: "mobile-navbar" });
    this.actionsEl = this.containerEl.createDiv({ cls: "mobile-navbar-actions" });
    this.backEl = this.action("lucide-arrow-left", "Navigate back", () => void this.mainLeaf()?.history.back());
    this.forwardEl = this.action("lucide-arrow-right", "Navigate forward", () => void this.mainLeaf()?.history.forward());
    this.newTabEl = this.action("lucide-plus", "New tab", () => void this.newTab());
    this.newTabEl.addClass("mod-cta");
    this.tabsEl = this.action("", "Show tab overview", () => void layout.tabSwitcher.show());
    this.tabsEl.addClass("mobile-navbar-tabs-action");
    this.tabsEl.createDiv({ cls: "mobile-navbar-tabs-count", text: "1" });
    this.menuEl = this.action("lucide-menu", "Open menu", (evt) => this.showMenu(evt));
    this.update();
  }

  private action(icon: string, label: string, run: (evt: MouseEvent) => void): HTMLElement {
    const el = this.actionsEl.createDiv({ cls: ["mobile-navbar-action", "clickable-icon"], attr: { "aria-label": label, role: "button" } });
    if (icon) setIcon(el, icon);
    el.addEventListener("click", (evt) => {
      if (el.hasClass("is-disabled")) return;
      run(evt);
    });
    return el;
  }

  private mainLeaf(): WorkspaceLeaf | null {
    const ws = this.app.workspace;
    return ws.getMostRecentLeaf(ws.rootSplit);
  }

  private async newTab() {
    const ws = this.app.workspace;
    const leaf = ws.getLeaf("tab");
    await leaf.setViewState({ type: "empty", active: true });
    this.app.commands.executeCommandById("switcher:open");
  }

  update() {
    const leaf = this.mainLeaf();
    const h = leaf?.history;
    this.backEl.toggleClass("is-disabled", !h || h.backHistory.length === 0);
    this.forwardEl.toggleClass("is-disabled", !h || h.forwardHistory.length === 0);
    let count = 0;
    this.app.workspace.iterateRootLeaves(() => void count++);
    this.tabsEl.querySelector(".mobile-navbar-tabs-count")?.setText(String(Math.min(count, 99)));
    this.tabsEl.setAttr("aria-label", `Show tab overview (${count} ${count === 1 ? "tab" : "tabs"})`);
  }

  private showMenu(evt: MouseEvent) {
    const app = this.app;
    const ws = app.workspace;
    const menu = new Menu();
    for (const item of ws.leftRibbon.items) {
      if (item.hidden) continue;
      menu.addItem((i) =>
        i
          .setSection("ribbon")
          .setTitle(item.title)
          .setIcon(item.icon)
          .onClick((e) => void item.callback(e as MouseEvent)),
      );
    }
    menu.addItem((i) => i.setSection("system").setTitle("Files and left sidebar").setIcon("lucide-panel-left").onClick(() => ws.leftSplit.expand()));
    menu.addItem((i) => i.setSection("system").setTitle("Right sidebar").setIcon("lucide-panel-right").onClick(() => ws.rightSplit.expand()));
    menu.addItem((i) => i.setSection("system").setTitle("Command palette").setIcon("lucide-terminal-square").onClick(() => app.commands.executeCommandById("command-palette:open")));
    menu.addItem((i) => i.setSection("system").setTitle("Settings").setIcon("lucide-settings").onClick(() => app.setting.open()));
    const r = this.menuEl.getBoundingClientRect();
    if (r.width) menu.showAtPosition({ x: r.right, y: r.top, left: true });
    else menu.showAtMouseEvent(evt);
  }
}
