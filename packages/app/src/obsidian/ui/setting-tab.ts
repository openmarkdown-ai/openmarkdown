/**
 * SettingTab, PluginSettingTab, and the renderer for the declarative settings
 * API (1.13): `getSettingDefinitions()` returns a tree of groups, lists,
 * pages and rows, and the tab renders it, binding each `control` to
 * `getControlValue`/`setControlValue`.
 *
 * The settings modal shows a tab through `showTab()` (internal): it refreshes
 * `settingItems` and renders them when non-empty, otherwise calls the
 * plugin's imperative `display()` — which, per the API, is not called for a
 * tab that provides definitions.
 *
 * Rendered DOM (Obsidian class names where they exist; our additions use the
 * `vault-` prefix):
 *
 *   .vertical-tab-content
 *     .setting-group[.vault-setting-list] > .setting-item.setting-item-heading + .setting-items > .setting-item …
 *     .vault-setting-page > .vault-setting-page-titlebar + .vault-setting-page-content   (an open sub-page)
 */
import type { App } from "../app";
import type {
  SettingControl,
  SettingDefinition,
  SettingDefinitionGroup,
  SettingDefinitionItem,
  SettingDefinitionList,
  SettingDefinitionPage,
  SettingGroupItem,
  TFile,
  TFolder,
} from "obsidian";
import { setIcon } from "./icons";
import { ExtraButtonComponent, SecretComponent, Setting, SettingGroup, SettingPage } from "./setting";
import { AbstractInputSuggest } from "./suggest";

type Predicate<T = boolean> = T | (() => T) | undefined;

function evaluate<T>(v: Predicate<T>, fallback: T): T {
  if (v === undefined) return fallback;
  if (typeof v === "function") {
    try {
      return (v as () => T)();
    } catch (e) {
      console.error(e);
      return fallback;
    }
  }
  return v;
}

function isGroup(item: SettingDefinitionItem): item is SettingDefinitionGroup | SettingDefinitionList {
  return typeof item === "object" && item !== null && "type" in item && (item.type === "group" || item.type === "list");
}

function isPage(item: SettingDefinitionItem): item is SettingDefinitionPage {
  return typeof item === "object" && item !== null && "type" in item && item.type === "page";
}

// ---- vault path suggest for `file` / `folder` controls -----------------------------

interface VaultLike {
  getFiles?(): TFile[];
  getAllFolders?(includeRoot?: boolean): TFolder[];
  getAllLoadedFiles?(): { path: string; children?: unknown }[];
  getConfig?(key: string): unknown;
  setConfig?(key: string, value: unknown): void;
}

class VaultPathSuggest extends AbstractInputSuggest<string> {
  private kind: "file" | "folder";
  private filterFn: ((f: any) => boolean) | undefined;
  private includeRoot: boolean;

  constructor(app: App, inputEl: HTMLInputElement, kind: "file" | "folder", filter: ((f: any) => boolean) | undefined, includeRoot = false) {
    super(app, inputEl);
    this.kind = kind;
    this.filterFn = filter;
    this.includeRoot = includeRoot;
  }

  protected getSuggestions(query: string): string[] {
    const vault = (this.app as unknown as { vault?: VaultLike }).vault;
    const q = query.toLowerCase();
    let entries: { path: string }[] = [];
    if (this.kind === "file") {
      entries = vault?.getFiles?.() ?? (vault?.getAllLoadedFiles?.() ?? []).filter((f) => !("children" in f && f.children));
    } else {
      entries =
        vault?.getAllFolders?.(this.includeRoot) ??
        (vault?.getAllLoadedFiles?.() ?? []).filter((f) => "children" in f && f.children && (this.includeRoot || f.path !== "/"));
    }
    const out: string[] = [];
    for (const entry of entries) {
      if (this.filterFn) {
        try {
          if (!this.filterFn(entry)) continue;
        } catch (e) {
          console.error(e);
          continue;
        }
      }
      if (!q || entry.path.toLowerCase().includes(q)) out.push(entry.path);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }
}

// ---- the renderer ---------------------------------------------------------------------

interface RowState {
  el: HTMLElement;
  def: SettingGroupItem | SettingDefinitionItem;
  searchHidden: boolean;
  refresh: () => void;
}

interface PageFrame {
  def: SettingDefinitionPage;
  instance: SettingPage | null;
}

/** internal: renders a SettingTab's definition tree and owns its lifecycle. */
export class SettingDefinitionRenderer {
  tab: SettingTab;
  containerEl: HTMLElement;
  stack: PageFrame[] = [];
  private cleanups: (() => void)[] = [];
  private rows: RowState[] = [];
  private groupRefreshers: (() => void)[] = [];
  private searchQueries = new Map<string, string>();

  constructor(tab: SettingTab, containerEl: HTMLElement) {
    this.tab = tab;
    this.containerEl = containerEl;
  }

  render(): void {
    this.teardown();
    this.containerEl.empty();
    // Re-resolve open pages by name against fresh definitions.
    if (this.stack.length) {
      let items: SettingDefinitionItem[] = this.tab.settingItems;
      const resolved: PageFrame[] = [];
      for (const frame of this.stack) {
        const found = findPage(items, frame.def.name);
        if (!found) break;
        resolved.push({ def: found, instance: frame.instance });
        items = found.items ?? [];
      }
      for (const dropped of this.stack.slice(resolved.length)) this.hidePageInstance(dropped);
      this.stack = resolved;
    }
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      this.renderItems(this.tab.settingItems, this.containerEl, "root");
      return;
    }
    this.renderPageFrame(top);
  }

  destroy(): void {
    this.teardown();
    for (const frame of this.stack) this.hidePageInstance(frame);
    this.stack = [];
    this.containerEl.empty();
  }

  refreshDomState(): void {
    for (const r of this.rows) r.refresh();
    for (const g of this.groupRefreshers) g();
  }

  navigate(def: SettingDefinitionPage): void {
    this.stack.push({ def, instance: null });
    this.render();
  }

  back(): void {
    const frame = this.stack.pop();
    if (frame) this.hidePageInstance(frame);
    this.render();
  }

  private hidePageInstance(frame: PageFrame) {
    if (!frame.instance) return;
    try {
      frame.instance.hide();
    } catch (e) {
      console.error(e);
    }
    frame.instance.rootEl.detach();
    frame.instance = null;
  }

  private teardown() {
    for (const c of this.cleanups.splice(0).reverse()) {
      try {
        c();
      } catch (e) {
        console.error(e);
      }
    }
    this.rows = [];
    this.groupRefreshers = [];
  }

  private renderPageFrame(frame: PageFrame) {
    const def = frame.def;
    let rootEl: HTMLElement;
    let titlebarEl: HTMLElement;
    let contentEl: HTMLElement;
    if (def.page) {
      if (!frame.instance) {
        try {
          frame.instance = def.page() as unknown as SettingPage;
        } catch (e) {
          console.error(e);
        }
      }
    }
    const instance = frame.instance;
    if (instance) {
      instance.title = def.name;
      rootEl = instance.rootEl;
      titlebarEl = instance.titlebarEl;
      contentEl = instance.containerEl;
    } else {
      rootEl = createDiv({ cls: "vault-setting-page" });
      titlebarEl = rootEl.createDiv({ cls: "vault-setting-page-titlebar" });
      contentEl = rootEl.createDiv({ cls: "vault-setting-page-content" });
    }
    titlebarEl.empty();
    new ExtraButtonComponent(titlebarEl)
      .setIcon("lucide-chevron-left")
      .setTooltip("Back")
      .onClick(() => this.back())
      .extraSettingsEl.addClass("vault-setting-page-back");
    titlebarEl.createDiv({ cls: "vault-setting-page-title", text: def.name });
    this.containerEl.appendChild(rootEl);
    if (instance) {
      instance.navigateBack = () => this.back();
      try {
        instance.display();
      } catch (e) {
        console.error(e);
      }
    } else {
      contentEl.empty();
      this.renderItems(def.items ?? [], contentEl, `page:${this.stack.map((f) => f.def.name).join("/")}`);
    }
  }

  /** Top-level items: groups render as groups; runs of loose rows share an implicit group. */
  private renderItems(items: SettingDefinitionItem[], parentEl: HTMLElement, path: string) {
    let loose: SettingGroup | null = null;
    let looseIndex = 0;
    items.forEach((item, i) => {
      if (!item) return;
      if (isGroup(item)) {
        loose = null;
        this.renderGroup(item, parentEl, `${path}/${i}`);
        return;
      }
      if (!loose) {
        loose = new SettingGroup(parentEl);
        looseIndex = 0;
      }
      this.renderGroupItem(item as SettingGroupItem, loose, looseIndex++, null);
    });
  }

  private renderGroup(def: SettingDefinitionGroup | SettingDefinitionList, parentEl: HTMLElement, path: string) {
    const group = new SettingGroup(parentEl);
    const isList = def.type === "list";
    const list = isList ? (def as SettingDefinitionList) : null;
    if (def.cls) group.addClass(...def.cls.split(" ").filter(Boolean));
    if (isList) group.addClass("vault-setting-list");
    if (def.heading) group.setHeading(def.heading);

    const rowsStart = this.rows.length;
    const items = def.items ?? [];
    items.forEach((item, index) => this.renderGroupItem(item, group, index, list));
    const groupRows = this.rows.slice(rowsStart);

    if (def.search) {
      const search = def.search;
      const key = `${path}:${def.heading ?? ""}`;
      group.addSearch((c) => {
        if (search.placeholder) c.setPlaceholder(search.placeholder);
        const apply = (query: string) => {
          this.searchQueries.set(key, query);
          for (const row of groupRows) {
            const d = row.def as SettingDefinition;
            const searchable = evaluate((d as { searchable?: Predicate }).searchable, true);
            let show = true;
            if (query && searchable) {
              try {
                show = search.match(d, query);
              } catch (e) {
                console.error(e);
              }
            }
            row.searchHidden = !show;
            row.refresh();
          }
        };
        c.setValue(this.searchQueries.get(key) ?? "");
        c.onChange(apply);
        apply(c.getValue());
      });
    }
    for (const cb of def.extraButtons ?? []) group.addExtraButton(cb);
    if (list?.addItem) {
      const addItem = list.addItem;
      group.addExtraButton((b) =>
        b
          .setIcon("lucide-plus")
          .setTooltip(addItem.name)
          .onClick(() => addItem.action(b.extraSettingsEl)),
      );
    }
    if (list && items.length === 0 && list.emptyState) {
      group.listEl.createDiv({ cls: "vault-setting-list-empty", text: list.emptyState });
    }

    const refreshGroup = () => group.groupEl.toggle(evaluate(def.visible, true));
    refreshGroup();
    this.groupRefreshers.push(refreshGroup);
  }

  private renderGroupItem(item: SettingGroupItem, group: SettingGroup, index: number, list: SettingDefinitionList | null) {
    if (isPage(item)) {
      this.renderPageEntry(item, group);
      return;
    }
    const def = item as SettingDefinition;
    const setting = new Setting(group.listEl);
    setting.setName(def.name ?? "");
    if (def.desc !== undefined) setting.setDesc(def.desc);
    const row: RowState = { el: setting.settingEl, def, searchHidden: false, refresh: () => {} };
    let refreshDisabled: () => void = () => {};

    if ("control" in def && def.control) {
      refreshDisabled = this.renderControl(setting, def.control);
    } else if ("render" in def && typeof def.render === "function") {
      try {
        const cleanup = def.render(setting, group);
        if (typeof cleanup === "function") this.cleanups.push(cleanup);
      } catch (e) {
        console.error(e);
      }
    } else if ("action" in def && typeof def.action === "function") {
      const action = def.action;
      const el = setting.settingEl;
      el.addClass("vault-setting-action");
      el.setAttr("tabindex", 0);
      el.setAttr("role", "button");
      const run = (evt: Event) => {
        if (el.hasClass("is-disabled")) return;
        if (evt.target instanceof Element && evt.target !== el && evt.target.closest("button, input, select, textarea, .clickable-icon")) return;
        const i = Array.from(group.listEl.querySelectorAll(":scope > .setting-item")).indexOf(el);
        try {
          action(el, i === -1 ? index : i);
        } catch (e) {
          console.error(e);
        }
      };
      el.addEventListener("click", run);
      el.addEventListener("keydown", (evt) => {
        if (evt.target === el && (evt.key === "Enter" || evt.key === " ")) {
          evt.preventDefault();
          run(evt);
        }
      });
      refreshDisabled = () => setting.setDisabled(evaluate(def.disabled, false));
    }

    if (list?.onDelete) this.addDeleteAffordance(setting, group, list.onDelete, index);
    if (list?.onReorder) this.addReorderAffordance(setting, group, list.onReorder);

    row.refresh = () => {
      const visible = evaluate(def.visible, true);
      setting.settingEl.toggle(visible && !row.searchHidden);
      refreshDisabled();
    };
    row.refresh();
    this.rows.push(row);
  }

  private renderPageEntry(def: SettingDefinitionPage, group: SettingGroup) {
    const setting = new Setting(group.listEl);
    setting.setName(def.name);
    if (def.desc !== undefined) setting.setDesc(def.desc);
    const el = setting.settingEl;
    el.addClass("vault-setting-page-entry");
    el.setAttr("tabindex", 0);
    el.setAttr("role", "button");
    let display: { setValue(v: string | null): unknown; setStatus(s: "warning" | null): unknown } | null = null;
    setting.addDisplayValue((d) => (display = d));
    const chevron = setting.controlEl.createDiv({ cls: "vault-setting-page-chevron" });
    setIcon(chevron, "lucide-chevron-right");
    el.addEventListener("click", () => this.navigate(def));
    el.addEventListener("keydown", (evt) => {
      if (evt.target === el && (evt.key === "Enter" || evt.key === " ")) {
        evt.preventDefault();
        this.navigate(def);
      }
    });
    const row: RowState = {
      el,
      def,
      searchHidden: false,
      refresh: () => {
        el.toggle(evaluate(def.visible, true) && !row.searchHidden);
        display?.setValue(evaluate<string>(def.displayValue, "") || null);
        display?.setStatus(evaluate<"warning" | null>(def.status, null));
      },
    };
    row.refresh();
    this.rows.push(row);
  }

  private addDeleteAffordance(setting: Setting, group: SettingGroup, onDelete: (index: number) => void, index: number) {
    const el = setting.settingEl;
    const currentIndex = () => {
      const i = Array.from(group.listEl.querySelectorAll(":scope > .setting-item")).indexOf(el);
      return i === -1 ? index : i;
    };
    setting.addExtraButton((b) =>
      b
        .setIcon("lucide-x")
        .setTooltip("Delete")
        .onClick(() => onDelete(currentIndex()))
        .extraSettingsEl.addClass("vault-setting-list-delete"),
    );
    if (!el.hasAttribute("tabindex")) el.setAttr("tabindex", 0);
    el.addEventListener("keydown", (evt) => {
      if (evt.target !== el) return;
      if (evt.key === "Delete" || evt.key === "Backspace") {
        evt.preventDefault();
        onDelete(currentIndex());
      }
    });
  }

  private addReorderAffordance(setting: Setting, group: SettingGroup, onReorder: (oldIndex: number, newIndex: number) => void) {
    const el = setting.settingEl;
    const handle = createDiv({ cls: ["vault-setting-drag-handle", "clickable-icon"], attr: { "aria-label": "Drag to reorder" } });
    setIcon(handle, "lucide-grip-vertical");
    el.insertBefore(handle, el.firstChild);
    el.addClass("vault-setting-reorderable");
    const rowsOf = () => Array.from(group.listEl.querySelectorAll<HTMLElement>(":scope > .setting-item"));
    handle.addEventListener("pointerdown", () => el.setAttr("draggable", "true"));
    handle.addEventListener("pointerup", () => el.removeAttribute("draggable"));
    let from = -1;
    el.addEventListener("dragstart", (evt) => {
      from = rowsOf().indexOf(el);
      el.addClass("is-dragging");
      evt.dataTransfer?.setData("text/plain", String(from));
      if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragend", () => {
      el.removeClass("is-dragging");
      el.removeAttribute("draggable");
      for (const r of rowsOf()) r.removeClass("is-drop-before", "is-drop-after");
    });
    group.listEl.addEventListener("dragover", (evt) => {
      const dragging = group.listEl.querySelector<HTMLElement>(":scope > .setting-item.is-dragging");
      if (!dragging) return;
      evt.preventDefault();
    });
    el.addEventListener("dragover", (evt) => {
      const dragging = group.listEl.querySelector<HTMLElement>(":scope > .setting-item.is-dragging");
      if (!dragging || dragging === el) return;
      evt.preventDefault();
      const r = el.getBoundingClientRect();
      const after = evt.clientY > r.top + r.height / 2;
      el.toggleClass("is-drop-after", after);
      el.toggleClass("is-drop-before", !after);
    });
    el.addEventListener("dragleave", () => el.removeClass("is-drop-before", "is-drop-after"));
    el.addEventListener("drop", (evt) => {
      const dragging = group.listEl.querySelector<HTMLElement>(":scope > .setting-item.is-dragging");
      if (!dragging || dragging === el) return;
      evt.preventDefault();
      const rows = rowsOf();
      const oldIndex = rows.indexOf(dragging);
      const r = el.getBoundingClientRect();
      const after = evt.clientY > r.top + r.height / 2;
      let newIndex = rows.indexOf(el) + (after ? 1 : 0);
      if (oldIndex < newIndex) newIndex--;
      el.removeClass("is-drop-before", "is-drop-after");
      if (oldIndex === -1 || oldIndex === newIndex) return;
      // Move the row now; a tab that calls update() re-renders from data anyway.
      group.listEl.insertBefore(dragging, after ? el.nextSibling : el);
      try {
        onReorder(oldIndex, newIndex);
      } catch (e) {
        console.error(e);
      }
    });
  }

  /** Renders a control and returns its disabled-state refresher. */
  private renderControl(setting: Setting, control: SettingControl): () => void {
    const tab = this.tab;
    const app = tab.app;
    const read = (): unknown => {
      let v: unknown;
      try {
        v = tab.getControlValue(control.key);
      } catch (e) {
        console.error(e);
      }
      return v === undefined || v === null ? control.defaultValue : v;
    };
    let validationSeq = 0;
    const validate = async (value: unknown): Promise<boolean> => {
      if (!control.validate) {
        setting.setErrorMessage(null);
        return true;
      }
      const seq = ++validationSeq;
      let msg: string | void;
      try {
        msg = await (control.validate as (v: unknown) => string | void | Promise<string | void>)(value);
      } catch (e) {
        console.error(e);
        msg = e instanceof Error ? e.message : String(e);
      }
      if (seq !== validationSeq) return false;
      setting.setErrorMessage(msg || null);
      return !msg;
    };
    const persist = async (value: unknown) => {
      if (!(await validate(value))) return;
      try {
        await tab.setControlValue(control.key, value);
      } catch (e) {
        console.error(e);
      }
      tab.refreshDomState();
    };
    const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));

    const type = (control as { type: string }).type;
    switch (type) {
      case "toggle":
        setting.addToggle((t) => t.setValue(!!read()).onChange((v) => void persist(v)));
        break;
      case "dropdown": {
        const c = control as Extract<SettingControl, { type: "dropdown" }>;
        setting.addDropdown((d) => d.addOptions(c.options ?? {}).setValue(str(read())).onChange((v) => void persist(v)));
        break;
      }
      case "text": {
        const c = control as Extract<SettingControl, { type: "text" }>;
        setting.addText((t) => t.setPlaceholder(c.placeholder ?? "").setValue(str(read())).onChange((v) => void persist(v)));
        break;
      }
      case "textarea": {
        const c = control as Extract<SettingControl, { type: "textarea" }>;
        setting.addTextArea((t) => {
          t.setPlaceholder(c.placeholder ?? "").setValue(str(read()));
          if (c.rows) t.inputEl.rows = c.rows;
          t.onChange((v) => void persist(v));
        });
        break;
      }
      case "number": {
        const c = control as Extract<SettingControl, { type: "number" }>;
        setting.addText((t) => {
          t.inputEl.type = "number";
          if (c.min !== undefined) t.inputEl.min = String(c.min);
          if (c.max !== undefined) t.inputEl.max = String(c.max);
          if (c.step !== undefined) t.inputEl.step = String(c.step);
          t.setPlaceholder(c.placeholder ?? "").setValue(str(read()));
          t.onChange((raw) => {
            const n = parseFloat(raw);
            void persist(Number.isFinite(n) ? n : (c.defaultValue ?? 0));
          });
        });
        break;
      }
      case "slider": {
        const c = control as Extract<SettingControl, { type: "slider" }>;
        setting.addSlider((s) => {
          s.setLimits(c.min, c.max, c.step);
          if (c.displayFormat) s.setDisplayFormat(c.displayFormat);
          const v = Number(read());
          s.setValue(Number.isFinite(v) ? v : c.min);
          s.onChange((val) => void persist(val));
        });
        break;
      }
      case "color":
        setting.addColorPicker((cp) => {
          const v = str(read());
          if (v) cp.setValue(v);
          cp.onChange((val) => void persist(val));
        });
        break;
      case "file":
      case "folder": {
        const c = control as Extract<SettingControl, { type: "file" | "folder" }>;
        setting.addText((t) => {
          t.setPlaceholder(c.placeholder ?? "").setValue(str(read()));
          t.onChange((v) => void persist(v));
          const suggest = new VaultPathSuggest(
            app,
            t.inputEl,
            type as "file" | "folder",
            c.filter as ((f: any) => boolean) | undefined,
            type === "folder" ? !!(c as Extract<SettingControl, { type: "folder" }>).includeRoot : false,
          );
          suggest.onSelect((path) => {
            t.setValue(path);
            void persist(path);
          });
          this.cleanups.push(() => suggest.close());
        });
        break;
      }
      case "secret":
        setting.addComponent((el) => new SecretComponent(app, el).setValue(str(read())).onChange((v) => void persist(v)));
        break;
      default:
        console.warn(`Unknown setting control type: ${type}`);
    }

    if (control.validate) {
      const initial = read();
      void validate(initial);
    }
    return () => setting.setDisabled(evaluate(control.disabled, false));
  }
}

function findPage(items: SettingDefinitionItem[], name: string): SettingDefinitionPage | null {
  for (const item of items) {
    if (!item) continue;
    if (isPage(item) && item.name === name) return item;
    if (isGroup(item)) {
      for (const child of item.items ?? []) if (isPage(child) && child.name === name) return child;
    }
  }
  return null;
}

// ---- SettingTab / PluginSettingTab ----------------------------------------------------------

export abstract class SettingTab {
  icon = "lucide-settings";
  app: App;
  containerEl: HTMLElement;
  settingItems: SettingDefinitionItem[] = [];
  // internal (used by plugins and the settings modal: `tab.id`, `tab.name`, `tab.navEl`)
  id = "";
  name = "";
  navEl: HTMLElement | null = null;
  // internal
  renderer: SettingDefinitionRenderer | null = null;

  constructor(app: App) {
    this.app = app;
    this.containerEl = createDiv({ cls: "vertical-tab-content" });
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  update(): void {
    let items: SettingDefinitionItem[] = [];
    try {
      items = this.getSettingDefinitions() ?? [];
    } catch (e) {
      console.error(e);
    }
    this.settingItems = Array.isArray(items) ? items : [];
    if (this.renderer) {
      if (this.settingItems.length > 0) this.renderer.render();
      else {
        this.renderer.destroy();
        this.renderer = null;
      }
    }
  }

  getControlValue(key: string): unknown {
    return (this.app as unknown as { vault?: VaultLike }).vault?.getConfig?.(key);
  }

  setControlValue(key: string, value: unknown): void | Promise<void> {
    return (this.app as unknown as { vault?: VaultLike }).vault?.setConfig?.(key, value);
  }

  refreshDomState(): void {
    this.renderer?.refreshDomState();
  }

  /** @deprecated Since 1.13.0. Use getSettingDefinitions instead. */
  display(): void {
    this.renderDefinitions();
  }

  hide(): void {
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
  }

  // internal: render `settingItems` declaratively into containerEl.
  renderDefinitions(): void {
    if (!this.renderer) this.renderer = new SettingDefinitionRenderer(this, this.containerEl);
    this.renderer.render();
  }

  /**
   * internal: what the settings modal calls to show this tab. Refreshes the
   * definitions and renders them, or falls back to the imperative display().
   */
  showTab(): void {
    this.update();
    if (this.settingItems.length > 0) {
      this.renderDefinitions();
    } else {
      try {
        this.display();
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** internal: what the settings modal calls when leaving this tab. */
  hideTab(): void {
    try {
      this.hide();
    } catch (e) {
      console.error(e);
    }
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }
  }
}

interface PluginLike {
  settings?: unknown;
  manifest?: { id: string; name: string };
  saveData(data: unknown): Promise<void>;
}

export abstract class PluginSettingTab extends SettingTab {
  // internal (used by plugins: `this.plugin` is how every tab reaches its plugin)
  plugin: PluginLike;

  constructor(app: App, plugin: PluginLike) {
    super(app);
    this.plugin = plugin;
    this.icon = "lucide-puzzle";
    if (plugin?.manifest) {
      this.id = plugin.manifest.id;
      this.name = plugin.manifest.name;
    }
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
  }

  override getControlValue(key: string): unknown {
    const settings = this.plugin.settings as Record<string, unknown> | null | undefined;
    return settings && typeof settings === "object" ? settings[key] : undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (!this.plugin.settings || typeof this.plugin.settings !== "object") this.plugin.settings = {};
    (this.plugin.settings as Record<string, unknown>)[key] = value;
    await this.plugin.saveData(this.plugin.settings);
  }
}
