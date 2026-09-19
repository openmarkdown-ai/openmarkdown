/**
 * Settings → Interface (§6.2), and the ribbon menu configuration modal.
 * "Open settings in new window" and the mobile rows have no browser
 * equivalent: settings always open as a modal here.
 */
import type { App } from "../../obsidian/app";
import { setIcon } from "../../obsidian/ui/icons";
import { Modal } from "../../obsidian/ui/modal";
import { Setting } from "../../obsidian/ui/setting";
import type { RibbonItem, WorkspaceRibbon } from "../../obsidian/workspace/items";
import { AppSettingTab } from "../tab-base";

export class InterfaceSettingTab extends AppSettingTab {
  constructor(app: App) {
    super(app, "interface", "Interface", "lucide-app-window");
  }

  render(el: HTMLElement): void {
    const g = this.group(el);
    this.toggle(g, "Show tab title bar", "Display the header at the top of every tab: navigation buttons, the title, and view actions.", "showViewHeader");
    this.toggle(g, "Show ribbon", "Display the vertical toolbar on the side of the window.", "showRibbon");
    this.row(g, "Ribbon menu configuration", "Choose which commands appear in the ribbon, and in what order.").addButton((b) =>
      b.setButtonText("Manage").onClick(() => new RibbonConfigModal(this.app).open()),
    );
    this.toggle(g, "Inline title", "Display the file name as an editable title inline with the file contents.", "showInlineTitle");
  }
}

/** Toggle and drag-reorder ribbon items ("Other ribbon items"). */
export class RibbonConfigModal extends Modal {
  private ribbon: WorkspaceRibbon;
  private listEl!: HTMLElement;

  constructor(app: App) {
    super(app);
    this.ribbon = app.workspace.leftRibbon;
    this.modalEl.addClass("vault-ribbon-config-modal");
    this.setTitle("Ribbon menu configuration");
  }

  override onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { cls: "setting-item-description", text: "Toggle an item to show or hide it in the ribbon. Drag items, or use Alt+↑ / Alt+↓, to reorder." });
    this.listEl = this.contentEl.createDiv({ cls: "vault-ribbon-config-list" });
    this.renderList();
  }

  private renderList() {
    this.listEl.empty();
    const items = this.ribbon.items;
    if (!items.length) {
      this.listEl.createDiv({ cls: "vault-empty-state", text: "No ribbon items. Core and community plugins add them." });
      return;
    }
    items.forEach((item, index) => {
      const s = new Setting(this.listEl).setName(item.title);
      s.settingEl.addClass("vault-ribbon-config-item");
      s.settingEl.setAttr("tabindex", 0);
      const handle = createDiv({ cls: ["vault-setting-drag-handle", "clickable-icon"], attr: { "aria-label": "Drag to reorder" } });
      setIcon(handle, "lucide-grip-vertical");
      const iconEl = createDiv({ cls: "vault-ribbon-config-icon" });
      setIcon(iconEl, item.icon);
      s.settingEl.prepend(handle, iconEl);
      s.addToggle((t) => t.setValue(!item.hidden).onChange((v) => this.setHidden(item, !v)));
      this.makeDraggable(s.settingEl, handle, index);
      s.settingEl.addEventListener("keydown", (evt) => {
        if (evt.target !== s.settingEl || !evt.altKey) return;
        if (evt.key === "ArrowUp" || evt.key === "ArrowDown") {
          evt.preventDefault();
          const to = index + (evt.key === "ArrowUp" ? -1 : 1);
          if (to < 0 || to >= items.length) return;
          this.move(index, to);
          (this.listEl.children[to] as HTMLElement | undefined)?.focus();
        }
      });
    });
  }

  private setHidden(item: RibbonItem, hidden: boolean) {
    item.hidden = hidden;
    item.buttonEl.toggle(!hidden);
    this.app.workspace.saveRibbonConfig(this.ribbon);
  }

  private move(from: number, to: number) {
    const items = this.ribbon.items;
    const [item] = items.splice(from, 1);
    if (!item) return;
    items.splice(to, 0, item);
    for (const it of items) this.ribbon.ribbonActionsEl.appendChild(it.buttonEl);
    this.app.workspace.saveRibbonConfig(this.ribbon);
    this.renderList();
  }

  private makeDraggable(rowEl: HTMLElement, handle: HTMLElement, index: number) {
    handle.addEventListener("pointerdown", () => rowEl.setAttr("draggable", "true"));
    handle.addEventListener("pointerup", () => rowEl.removeAttribute("draggable"));
    rowEl.addEventListener("dragstart", (evt) => {
      rowEl.addClass("is-dragging");
      evt.dataTransfer?.setData("text/plain", String(index));
      if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
    });
    rowEl.addEventListener("dragend", () => {
      rowEl.removeClass("is-dragging");
      rowEl.removeAttribute("draggable");
    });
    rowEl.addEventListener("dragover", (evt) => {
      evt.preventDefault();
      const r = rowEl.getBoundingClientRect();
      const after = evt.clientY > r.top + r.height / 2;
      rowEl.toggleClass("is-drop-after", after);
      rowEl.toggleClass("is-drop-before", !after);
    });
    rowEl.addEventListener("dragleave", () => rowEl.removeClass("is-drop-before", "is-drop-after"));
    rowEl.addEventListener("drop", (evt) => {
      evt.preventDefault();
      rowEl.removeClass("is-drop-before", "is-drop-after");
      const from = parseInt(evt.dataTransfer?.getData("text/plain") ?? "", 10);
      if (!Number.isFinite(from)) return;
      const r = rowEl.getBoundingClientRect();
      let to = index + (evt.clientY > r.top + r.height / 2 ? 1 : 0);
      if (from < to) to--;
      if (from !== to) this.move(from, to);
    });
  }
}
