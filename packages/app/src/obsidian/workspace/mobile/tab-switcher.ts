/**
 * The tab overview (`app.mobileTabSwitcher`, command `app:show-tab-switcher`).
 *
 *   .mobile-tab-switcher[.is-visible]
 *     .mobile-tab-switcher-menubar
 *       .mobile-tab-switcher-menu-button (close all …) · .mobile-tab-switcher-menu-spacer · New tab · Done
 *     .mobile-tab-switcher-scroll > .mobile-tab-switcher-inner
 *       .mobile-tab[.is-active][.is-pinned]
 *         .mobile-tab-header > icon · title · .mobile-tab-pin · .mobile-tab-close
 *         .mobile-tab-preview                  (the note's first lines)
 *
 * Tabs are every leaf in the main area, most recently used first as on a
 * phone the order of tab groups is not visible.
 */
import type { App } from "../../app";
import { setIcon } from "../../ui/icons";
import { Menu } from "../../ui/menu";
import { debounce } from "../../util";
import type { WorkspaceLeaf } from "../leaf";

export class MobileTabSwitcher {
  app: App;
  containerEl: HTMLElement;
  scrollEl: HTMLElement;
  innerScrollEl: HTMLElement;
  isVisible = false;
  requestRender: () => void;
  private previews = new WeakMap<WorkspaceLeaf, { key: string; text: string }>();

  constructor(app: App) {
    this.app = app;
    this.containerEl = createDiv({ cls: "mobile-tab-switcher", attr: { role: "dialog", "aria-label": "Tabs" } });
    const bar = this.containerEl.createDiv({ cls: "mobile-tab-switcher-menubar" });
    const manage = bar.createDiv({ cls: ["mobile-tab-switcher-menu-button", "clickable-icon"], attr: { "aria-label": "Tab options" } });
    setIcon(manage, "lucide-more-horizontal");
    manage.addEventListener("click", (evt) => this.showTabManagementMenu(evt));
    bar.createDiv({ cls: "mobile-tab-switcher-menu-spacer", text: "Tabs" });
    const add = bar.createDiv({ cls: ["mobile-tab-switcher-menu-button", "clickable-icon", "mod-new-tab"], attr: { "aria-label": "New tab" } });
    setIcon(add, "lucide-plus");
    add.addEventListener("click", () => void this.newTab());
    const done = bar.createDiv({ cls: ["mobile-tab-switcher-menu-button", "mod-done"], text: "Done", attr: { role: "button" } });
    done.addEventListener("click", () => this.hide());
    this.scrollEl = this.containerEl.createDiv({ cls: "mobile-tab-switcher-scroll" });
    this.innerScrollEl = this.scrollEl.createDiv({ cls: "mobile-tab-switcher-inner" });
    this.requestRender = debounce(() => {
      if (this.isVisible) this.render();
    }, 50, true);
    this.containerEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape") this.hide();
    });
  }

  async show(): Promise<void> {
    if (!this.containerEl.isConnected) this.app.dom.appContainerEl.appendChild(this.containerEl);
    this.isVisible = true;
    this.containerEl.addClass("is-visible");
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.render();
    this.containerEl.querySelector<HTMLElement>(".mobile-tab.is-active")?.scrollIntoView({ block: "nearest" });
  }

  hide() {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.containerEl.removeClass("is-visible");
    this.containerEl.detach();
  }

  onLayoutChange() {
    this.requestRender();
  }

  private leaves(): WorkspaceLeaf[] {
    const out: WorkspaceLeaf[] = [];
    this.app.workspace.iterateRootLeaves((l) => void out.push(l));
    return out;
  }

  render() {
    const ws = this.app.workspace;
    const current = ws.getMostRecentLeaf(ws.rootSplit);
    this.innerScrollEl.empty();
    for (const leaf of this.leaves()) {
      const tab = this.innerScrollEl.createDiv({ cls: ["mobile-tab", "tappable"], attr: { role: "button", "data-leaf-id": leaf.id } });
      tab.toggleClass("is-active", leaf === current);
      tab.toggleClass("is-pinned", leaf.pinned);
      const header = tab.createDiv({ cls: "mobile-tab-header" });
      setIcon(header.createDiv({ cls: "mobile-tab-icon" }), leaf.getIcon());
      header.createDiv({ cls: "mobile-tab-title", text: leaf.getDisplayText() || "New tab" });
      if (leaf.pinned) setIcon(header.createDiv({ cls: "mobile-tab-pin" }), "lucide-pin");
      const close = header.createDiv({ cls: ["mobile-tab-close", "clickable-icon"], attr: { "aria-label": "Close tab" } });
      setIcon(close, "lucide-x");
      close.addEventListener("click", (evt) => {
        evt.stopPropagation();
        leaf.detach();
        this.render();
      });
      const preview = tab.createDiv({ cls: "mobile-tab-preview" });
      void this.fillPreview(leaf, preview);
      tab.addEventListener("click", () => {
        this.hide();
        (leaf.parent as { selectTab?: (l: WorkspaceLeaf) => void } | null)?.selectTab?.(leaf);
        ws.setActiveLeaf(leaf, { focus: false });
      });
    }
  }

  private async fillPreview(leaf: WorkspaceLeaf, el: HTMLElement) {
    const state = leaf.getViewState();
    const path = (state.state as { file?: unknown } | undefined)?.file;
    if (typeof path !== "string") {
      el.addClass("mod-empty");
      el.setText(state.type === "empty" ? "" : leaf.getDisplayText());
      return;
    }
    const file = this.app.vault.getFileByPath(path);
    if (!file) return;
    const key = `${file.path}:${file.stat.mtime}`;
    const cached = this.previews.get(leaf);
    if (cached?.key === key) {
      el.setText(cached.text);
      return;
    }
    if (file.extension !== "md") {
      el.setText(file.path);
      return;
    }
    try {
      const raw = await this.app.vault.cachedRead(file);
      const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").slice(0, 400);
      this.previews.set(leaf, { key, text: body });
      el.setText(body);
    } catch {
      /* unreadable: leave the preview blank */
    }
  }

  private async newTab() {
    this.hide();
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: "empty", active: true });
  }

  showTabManagementMenu(evt: MouseEvent) {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("Close all tabs").setIcon("lucide-copy-x").setWarning(true).onClick(() => {
        for (const leaf of this.leaves()) if (!leaf.pinned) leaf.detach();
        this.render();
      }),
    );
    menu.addItem((i) => i.setTitle("Undo close tab").setIcon("lucide-undo-2").onClick(() => void this.app.workspace.undoCloseTab().then(() => this.render())));
    menu.showAtMouseEvent(evt);
  }
}
