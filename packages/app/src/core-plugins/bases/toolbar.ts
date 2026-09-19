/**
 * The Bases toolbar: view menu (switch / add / configure / duplicate / delete),
 * results (limit, copy, CSV), sort and group, filters (All views / This view,
 * and/or/not groups, advanced editor), properties (visibility, order,
 * display names, formulas), search, and New.
 */
import { BasesViewConfig, normalizePropertyId, type BasesAllOptions, type BasesOption, type BasesPropertyId } from "../../obsidian/bases/api";
import { setIcon } from "../../obsidian/ui/icons";
import { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { debounce } from "../../obsidian/util";
import type { BasesHost } from "./host";
import { FormulaModal, PromptModal } from "./modals";
import {
  buildFilterRow,
  childrenOf,
  conjunctionOf,
  directionLabels,
  filterToExpression,
  operatorsFor,
  parseFilterRow,
  propertyIcon,
  propertyKind,
  splitId,
  type Conjunction,
  type FilterNode,
} from "./properties";
import { TYPE_INFO, USER_TYPES } from "../properties/types";
import { iconButton, makeSortable, moveItem, plainSelect, propertySelect, textIconButton, ToolbarPopover } from "./ui";

type PopoverKind = "views" | "results" | "sort" | "filter" | "properties";

interface ToolbarState {
  kind: PopoverKind | null;
  viewsPage: number | null;
  advanced: Set<string>;
  searchOpen: boolean;
  searchEl: HTMLInputElement | null;
}

const states = new WeakMap<BasesHost, ToolbarState>();

function stateOf(host: BasesHost): ToolbarState {
  let s = states.get(host);
  if (!s) states.set(host, (s = { kind: null, viewsPage: null, advanced: new Set(), searchOpen: false, searchEl: null }));
  return s;
}

function openPopover(host: BasesHost, kind: PopoverKind, anchor: HTMLElement, render: (el: HTMLElement) => void) {
  const state = stateOf(host);
  if (host.popover?.isOpen && state.kind === kind) {
    host.popover.close();
    return;
  }
  host.popover?.close();
  state.kind = kind;
  host.popover = new ToolbarPopover(
    anchor,
    (el) => render(el),
    () => {
      if (stateOf(host).kind === kind) stateOf(host).kind = null;
    },
    `bases-toolbar-menu mod-${kind}`,
  );
}

export function renderToolbar(host: BasesHost, el: HTMLElement) {
  const state = stateOf(host);
  const ctrl = host.controller;
  const view = ctrl.currentView;
  const registry = host.plugin.registry;
  el.empty();

  // --- view menu
  const viewType = String(view?.type ?? "table");
  const reg = registry.get(viewType);
  const viewsItem = el.createDiv({ cls: "bases-toolbar-item bases-toolbar-views-menu" });
  const viewsBtn = viewsItem.createDiv({ cls: "text-icon-button", attr: { role: "button", tabindex: "0" } });
  setIcon(viewsBtn.createSpan({ cls: "text-button-icon" }), reg?.icon ?? "lucide-table");
  viewsBtn.createSpan({ cls: "text-button-label", text: view?.name ?? "Table" });
  setIcon(viewsBtn.createSpan({ cls: "text-button-icon mod-aux" }), "lucide-chevrons-up-down");
  const showViews = (page: number | null) => {
    state.viewsPage = page;
    openPopover(host, "views", viewsBtn, (p) => renderViewsMenu(host, p));
  };
  viewsBtn.addEventListener("click", () => showViews(null));
  viewsBtn.addEventListener("contextmenu", (evt) => {
    evt.preventDefault();
    host.popover?.close();
    showViews(ctrl.viewIndex);
  });

  // --- results
  const count = ctrl.results?.data.length ?? 0;
  const total = ctrl.results?.total ?? count;
  const resultsItem = el.createDiv({ cls: "bases-toolbar-item bases-toolbar-results-menu" });
  const resultsBtn = resultsItem.createDiv({ cls: "text-icon-button", attr: { role: "button", tabindex: "0" } });
  const limited = typeof view?.limit === "number" && total > count;
  resultsBtn.createSpan({ cls: "text-button-label", text: limited ? `${count} of ${total} results` : `${count} ${count === 1 ? "result" : "results"}` });
  resultsBtn.addEventListener("click", () => openPopover(host, "results", resultsBtn, (p) => renderResultsMenu(host, p)));

  el.createDiv({ cls: "bases-toolbar-spacer" });

  // --- sort
  const sortCount = (Array.isArray(view?.sort) ? view.sort.length : 0) + (view?.groupBy?.property ? 1 : 0);
  const sortItem = el.createDiv({ cls: "bases-toolbar-item bases-toolbar-sort-menu" });
  const sortBtn = textIconButton(sortItem, "lucide-arrow-up-down", "Sort", () => openPopover(host, "sort", sortBtn, (p) => renderSortMenu(host, p)));
  sortBtn.setAttr("aria-label", "Sort");
  if (sortCount) sortBtn.createSpan({ cls: "bases-toolbar-badge", text: String(sortCount) });
  sortItem.toggleClass("is-active", sortCount > 0);

  // --- filter
  const filterCount = countFilters(ctrl.base?.filters) + countFilters(view?.filters);
  const filterItem = el.createDiv({ cls: "bases-toolbar-item bases-toolbar-filter-menu" });
  const filterBtn = textIconButton(filterItem, "lucide-list-filter", "Filter", () => openPopover(host, "filter", filterBtn, (p) => renderFilterMenu(host, p)));
  filterBtn.setAttr("aria-label", "Filter");
  if (filterCount) filterBtn.createSpan({ cls: "bases-toolbar-badge", text: String(filterCount) });
  filterItem.toggleClass("is-active", filterCount > 0);

  // --- properties
  const propsItem = el.createDiv({ cls: "bases-toolbar-item bases-toolbar-properties-menu" });
  const propsBtn = textIconButton(propsItem, "lucide-list", "Properties", () => openPopover(host, "properties", propsBtn, (p) => renderPropertiesMenu(host, p)));
  propsBtn.setAttr("aria-label", "Properties");

  // --- search
  const searchItem = el.createDiv({ cls: "bases-toolbar-item bases-toolbar-search" });
  if (!state.searchEl) {
    const input = createEl("input", { type: "search", cls: "bases-toolbar-search-input", placeholder: "Search…", attr: { spellcheck: "false" } });
    const apply = debounce(() => {
      ctrl.searchQuery = input.value;
      host.rerun();
    }, 150, true);
    input.addEventListener("input", () => apply());
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape") {
        input.value = "";
        ctrl.searchQuery = "";
        state.searchOpen = false;
        host.rerun();
      }
    });
    input.addEventListener("blur", () => {
      if (!input.value && state.searchOpen) {
        state.searchOpen = false;
        renderToolbar(host, el);
      }
    });
    state.searchEl = input;
  }
  if (state.searchOpen || ctrl.searchQuery) {
    searchItem.addClass("is-open");
    setIcon(searchItem.createSpan({ cls: "bases-toolbar-search-icon" }), "lucide-search");
    searchItem.appendChild(state.searchEl);
  } else {
    iconButton(searchItem, "lucide-search", "Search", () => {
      state.searchOpen = true;
      renderToolbar(host, el);
      state.searchEl?.focus();
    });
  }

  // --- new
  const newItem = el.createDiv({ cls: "bases-toolbar-item bases-toolbar-new-item-menu" });
  const newBtn = textIconButton(newItem, "lucide-plus", "New", () => void ctrl.createFileForView());
  newBtn.setAttr("aria-label", "New");

  if (host.popover?.isOpen) {
    const anchors: Record<PopoverKind, HTMLElement> = { views: viewsBtn, results: resultsBtn, sort: sortBtn, filter: filterBtn, properties: propsBtn };
    if (state.kind) host.popover.setAnchor(anchors[state.kind]);
  }
}

function countFilters(node: FilterNode | undefined): number {
  if (node === undefined || node === null) return 0;
  if (typeof node === "string") return node.trim() ? 1 : 0;
  return childrenOf(node).reduce((n, c) => n + countFilters(c), 0);
}

function sectionHeading(el: HTMLElement, text: string): HTMLElement {
  const h = el.createDiv({ cls: "bases-toolbar-menu-heading" });
  h.createSpan({ text });
  return h;
}

// ---------------------------------------------------------------------------
// views

function uniqueViewName(host: BasesHost, base: string): string {
  const names = new Set(host.controller.views.map((v: any) => v?.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

export function addView(host: BasesHost, type = "table") {
  const ctrl = host.controller;
  const reg = host.plugin.registry.get(type);
  const name = uniqueViewName(host, reg?.name ?? "Table");
  const current = ctrl.currentView;
  const view: any = { type, name };
  if (Array.isArray(current?.order)) view.order = current.order.slice();
  ctrl.base.views.push(view);
  ctrl.viewIndex = ctrl.base.views.length - 1;
  host.options.onViewChanged?.(name);
  host.commit();
  return ctrl.viewIndex;
}

function renderViewsMenu(host: BasesHost, el: HTMLElement) {
  const state = stateOf(host);
  const ctrl = host.controller;
  const registry = host.plugin.registry;
  if (state.viewsPage !== null && ctrl.views[state.viewsPage]) {
    renderViewConfig(host, el, state.viewsPage);
    return;
  }
  state.viewsPage = null;
  const list = el.createDiv({ cls: "bases-toolbar-views-list" });
  ctrl.views.forEach((v: any, i: number) => {
    const row = list.createDiv({ cls: "bases-toolbar-menu-item", attr: { "data-index": String(i) } });
    row.toggleClass("mod-active", i === ctrl.viewIndex);
    const icon = row.createDiv({ cls: "bases-toolbar-menu-item-icon bases-drag-handle", attr: { "aria-label": "Drag to reorder" } });
    setIcon(icon, registry.get(String(v?.type))?.icon ?? "lucide-table");
    row.createDiv({ cls: "bases-toolbar-menu-item-name", text: String(v?.name ?? "") });
    iconButton(row, "lucide-chevron-right", "Configure view", () => {
      state.viewsPage = i;
      host.popover?.refresh();
    }, "bases-toolbar-menu-item-configure");
    row.addEventListener("click", () => {
      host.selectView(i);
      host.popover?.close();
    });
    row.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      state.viewsPage = i;
      host.popover?.refresh();
    });
  });
  makeSortable(list, ".bases-toolbar-menu-item", ".bases-drag-handle", (from, to) => {
    const active = ctrl.views[ctrl.viewIndex];
    ctrl.base.views = moveItem(ctrl.views, from, to);
    ctrl.viewIndex = Math.max(0, ctrl.base.views.indexOf(active));
    host.commit();
  });
  el.createDiv({ cls: "menu-separator" });
  const add = el.createDiv({ cls: "bases-toolbar-menu-item mod-add" });
  setIcon(add.createDiv({ cls: "bases-toolbar-menu-item-icon" }), "lucide-plus");
  add.createDiv({ cls: "bases-toolbar-menu-item-name", text: "Add view" });
  add.addEventListener("click", () => {
    const idx = addView(host);
    state.viewsPage = idx;
  });
}

function renderViewConfig(host: BasesHost, el: HTMLElement, index: number) {
  const state = stateOf(host);
  const ctrl = host.controller;
  const registry = host.plugin.registry;
  const view = ctrl.views[index];
  const header = el.createDiv({ cls: "bases-toolbar-menu-header" });
  iconButton(header, "lucide-chevron-left", "Back", () => {
    state.viewsPage = null;
    host.popover?.refresh();
  });
  header.createDiv({ cls: "bases-toolbar-menu-header-title", text: "Configure view" });
  const body = el.createDiv({ cls: "bases-view-config" });

  const layoutRow = settingRow(body, "Layout");
  const types: Record<string, string> = {};
  for (const { id, registration } of registry.list()) types[id] = registration.name;
  if (!(view.type in types)) types[view.type] = view.type;
  plainSelect(layoutRow, types, String(view.type), (t) => {
    view.type = t;
    host.commit();
  });

  const nameRow = settingRow(body, "View name");
  const nameInput = nameRow.createEl("input", { type: "text", attr: { "data-focus-key": "view-name", spellcheck: "false" } });
  nameInput.value = String(view.name ?? "");
  nameInput.addEventListener("change", () => {
    const name = nameInput.value.trim();
    if (!name || name === view.name) return;
    if (ctrl.views.some((v: any, i: number) => i !== index && v?.name === name)) {
      new Notice(`A view named “${name}” already exists`);
      nameInput.value = view.name;
      return;
    }
    view.name = name;
    if (index === ctrl.viewIndex) host.options.onViewChanged?.(name);
    host.commit();
  });

  // Layout options from the registration.
  const config = index === ctrl.viewIndex && ctrl.config ? ctrl.config : new BasesViewConfig(ctrl, view);
  const reg = registry.get(String(view.type));
  let options: BasesAllOptions[] = [];
  try {
    options = reg?.options?.(config) ?? [];
  } catch (e) {
    console.error(e);
  }
  if (options.length) renderOptions(host, body, config, options);

  const newGroup = body.createDiv({ cls: "bases-view-config-group" });
  newGroup.createDiv({ cls: "bases-view-config-group-title", text: "New items" });
  renderOptions(host, newGroup, config, [
    { type: "folder", key: "newItemFolder", displayName: "New item folder", placeholder: "Same folder as the base" },
    { type: "file", key: "newItemTemplate", displayName: "New item template file", placeholder: "Template file" },
  ]);

  el.createDiv({ cls: "menu-separator" });
  const actions = el.createDiv({ cls: "bases-view-config-actions" });
  if (index !== 0) {
    const def = actions.createDiv({ cls: "bases-toolbar-menu-item" });
    setIcon(def.createDiv({ cls: "bases-toolbar-menu-item-icon" }), "lucide-star");
    def.createDiv({ cls: "bases-toolbar-menu-item-name", text: "Default view" });
    def.addEventListener("click", () => {
      const active = ctrl.views[ctrl.viewIndex];
      ctrl.base.views = moveItem(ctrl.views, index, 0);
      ctrl.viewIndex = Math.max(0, ctrl.base.views.indexOf(active));
      state.viewsPage = 0;
      host.commit();
    });
  }
  const dup = actions.createDiv({ cls: "bases-toolbar-menu-item" });
  setIcon(dup.createDiv({ cls: "bases-toolbar-menu-item-icon" }), "lucide-copy");
  dup.createDiv({ cls: "bases-toolbar-menu-item-name", text: "Duplicate view" });
  dup.addEventListener("click", () => {
    const copy = JSON.parse(JSON.stringify(view));
    copy.name = uniqueViewName(host, String(view.name));
    ctrl.base.views.splice(index + 1, 0, copy);
    ctrl.viewIndex = index + 1;
    state.viewsPage = index + 1;
    host.options.onViewChanged?.(copy.name);
    host.commit();
  });
  const del = actions.createDiv({ cls: "bases-toolbar-menu-item is-warning" });
  setIcon(del.createDiv({ cls: "bases-toolbar-menu-item-icon" }), "lucide-trash-2");
  del.createDiv({ cls: "bases-toolbar-menu-item-name", text: "Delete view" });
  del.addEventListener("click", () => {
    if (ctrl.views.length <= 1) {
      new Notice("A base needs at least one view");
      return;
    }
    const active = ctrl.views[ctrl.viewIndex];
    ctrl.base.views.splice(index, 1);
    ctrl.viewIndex = index === ctrl.viewIndex ? 0 : Math.max(0, ctrl.base.views.indexOf(active));
    state.viewsPage = null;
    host.options.onViewChanged?.(ctrl.currentView?.name ?? "");
    host.commit();
  });
}

function settingRow(parent: HTMLElement, label: string): HTMLElement {
  const row = parent.createDiv({ cls: "bases-view-config-row" });
  row.createDiv({ cls: "bases-view-config-label", text: label });
  return row.createDiv({ cls: "bases-view-config-control" });
}

function renderOptions(host: BasesHost, parent: HTMLElement, config: BasesViewConfig, options: BasesAllOptions[]) {
  const ctrl = host.controller;
  for (const opt of options) {
    if (opt.shouldHide?.()) continue;
    if (opt.type === "group") {
      const g = parent.createDiv({ cls: "bases-view-config-group" });
      g.createDiv({ cls: "bases-view-config-group-title", text: opt.displayName });
      renderOptions(host, g, config, (opt as { items: BasesOption[] }).items);
      continue;
    }
    const o = opt as BasesOption;
    const control = settingRow(parent, o.displayName);
    const current = config.get(o.key);
    const set = (v: unknown) => config.set(o.key, v === "" || v === undefined ? null : v);
    const focusKey = `opt-${o.key}`;
    switch (o.type) {
      case "dropdown":
        plainSelect(control, o.options ?? {}, String(current ?? o.default ?? Object.keys(o.options ?? {})[0] ?? ""), (v) => set(v));
        break;
      case "toggle": {
        const toggle = control.createDiv({ cls: "checkbox-container", attr: { role: "switch", tabindex: "0", "data-focus-key": focusKey } });
        const on = current === undefined ? !!o.default : !!current;
        toggle.toggleClass("is-enabled", on);
        toggle.createEl("input", { type: "checkbox", attr: { tabindex: "-1" } }).checked = on;
        toggle.addEventListener("click", () => set(!on));
        break;
      }
      case "slider": {
        const wrap = control.createDiv({ cls: "bases-slider" });
        const input = wrap.createEl("input", { type: "range", cls: "slider", attr: { min: String(o.min ?? 0), max: String(o.max ?? 100), step: String(o.step ?? 1), "data-focus-key": focusKey } });
        const value = typeof current === "number" ? current : (o.default ?? 0);
        input.value = String(value);
        const label = wrap.createSpan({ cls: "bases-slider-value", text: String(value) });
        input.addEventListener("input", () => {
          label.setText(input.value);
          if (o.instant) set(Number(input.value));
        });
        input.addEventListener("change", () => set(Number(input.value)));
        break;
      }
      case "property": {
        const ids = ctrl.allProperties;
        propertySelect(control, ids, typeof current === "string" ? normalizePropertyId(current) : null, (id) => config.getDisplayName(id), (id) => set(id), {
          allowNone: o.placeholder ?? "None",
          filter: o.filter,
        });
        break;
      }
      case "multitext": {
        const input = control.createEl("input", { type: "text", attr: { "data-focus-key": focusKey, placeholder: "Comma separated" } });
        input.value = Array.isArray(current) ? current.join(", ") : Array.isArray(o.default) ? o.default.join(", ") : "";
        input.addEventListener("change", () => set(input.value.split(",").map((s) => s.trim()).filter(Boolean)));
        break;
      }
      case "formula": {
        const input = control.createEl("input", { type: "text", cls: "bases-formula-option", attr: { "data-focus-key": focusKey, placeholder: o.placeholder ?? "", spellcheck: "false" } });
        input.value = typeof current === "string" ? current : (o.default ?? "");
        input.addEventListener("change", () => set(input.value));
        break;
      }
      default: {
        // text, file, folder
        const input = control.createEl("input", { type: "text", attr: { "data-focus-key": focusKey, placeholder: o.placeholder ?? "", spellcheck: "false" } });
        input.value = current === undefined || current === null ? (o.default ?? "") : String(current);
        if (o.type === "file" || o.type === "folder") {
          const listId = `bases-${o.type}-list-${Math.random().toString(36).slice(2)}`;
          const dl = control.createEl("datalist", { attr: { id: listId } });
          const vault = host.app.vault;
          const items = o.type === "folder" ? (vault.getAllFolders?.() ?? []).map((f: any) => f.path).filter((p: string) => p && p !== "/") : vault.getFiles().filter((f: any) => !o.filter || o.filter(f)).map((f: any) => f.path);
          for (const p of items.slice(0, 500)) dl.createEl("option", { value: p });
          input.setAttr("list", listId);
        }
        input.addEventListener("change", () => set(input.value));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// results

export function tableRows(host: BasesHost): { header: string[]; rows: string[][] } {
  const ctrl = host.controller;
  const order = ctrl.config?.getOrder() ?? [];
  const header = order.map((id) => ctrl.config!.getDisplayName(id));
  const rows = (ctrl.results?.data ?? []).map((e) => order.map((id) => e.getValue(id)?.toString() ?? ""));
  return { header, rows };
}

export async function copyTable(host: BasesHost) {
  const { header, rows } = tableRows(host);
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const md = [`| ${header.map(esc).join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
  const html = document.createElement("table");
  const tr = html.createEl("thead").createEl("tr");
  header.forEach((h) => tr.createEl("th", { text: h }));
  const tbody = html.createEl("tbody");
  rows.forEach((r) => {
    const row = tbody.createEl("tr");
    r.forEach((c) => row.createEl("td", { text: c }));
  });
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([md], { type: "text/plain" }), "text/html": new Blob([html.outerHTML], { type: "text/html" }) })]);
    } else await navigator.clipboard.writeText(md);
    new Notice("Copied to clipboard");
  } catch {
    try {
      await navigator.clipboard.writeText(md);
      new Notice("Copied to clipboard");
    } catch (e) {
      new Notice(`Could not copy: ${(e as Error).message}`);
    }
  }
}

export function exportCsv(host: BasesHost) {
  const { header, rows } = tableRows(host);
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const csv = [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  const baseName = host.options.baseFile?.basename ?? "Base";
  a.download = `${baseName} - ${host.controller.currentView?.name ?? "View"}.csv`;
  a.href = URL.createObjectURL(blob);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderResultsMenu(host: BasesHost, el: HTMLElement) {
  const ctrl = host.controller;
  const config = ctrl.config!;
  const limitRow = el.createDiv({ cls: "bases-toolbar-menu-item mod-limit" });
  setIcon(limitRow.createDiv({ cls: "bases-toolbar-menu-item-icon" }), "lucide-list-ordered");
  limitRow.createDiv({ cls: "bases-toolbar-menu-item-name", text: "Limit number of results" });
  const input = limitRow.createEl("input", { type: "number", cls: "bases-limit-input", placeholder: "No limit", attr: { min: "0", "data-focus-key": "limit" } });
  const limit = config.get("limit");
  input.value = typeof limit === "number" ? String(limit) : "";
  input.addEventListener("change", () => {
    const n = input.value.trim() === "" ? null : Math.max(0, Math.floor(Number(input.value)));
    config.set("limit", n === null || Number.isNaN(n) ? null : n);
  });
  el.createDiv({ cls: "menu-separator" });
  const copy = el.createDiv({ cls: "bases-toolbar-menu-item" });
  setIcon(copy.createDiv({ cls: "bases-toolbar-menu-item-icon" }), "lucide-copy");
  copy.createDiv({ cls: "bases-toolbar-menu-item-name", text: "Copy to clipboard" });
  copy.addEventListener("click", () => {
    void copyTable(host);
    host.popover?.close();
  });
  const csv = el.createDiv({ cls: "bases-toolbar-menu-item" });
  setIcon(csv.createDiv({ cls: "bases-toolbar-menu-item-icon" }), "lucide-download");
  csv.createDiv({ cls: "bases-toolbar-menu-item-name", text: "Export CSV..." });
  csv.addEventListener("click", () => {
    exportCsv(host);
    host.popover?.close();
  });
}

// ---------------------------------------------------------------------------
// sort + group

function renderSortMenu(host: BasesHost, el: HTMLElement) {
  const ctrl = host.controller;
  const view = ctrl.currentView;
  if (!view) return;
  const config = ctrl.config!;
  const app = host.app;
  const ids = ctrl.allProperties;
  const display = (id: BasesPropertyId) => config.getDisplayName(id);

  sectionHeading(el, "Sort by");
  const sorts: { property: string; direction: string }[] = Array.isArray(view.sort) ? view.sort : [];
  const list = el.createDiv({ cls: "bases-sort-list" });
  sorts.forEach((s, i) => {
    const row = list.createDiv({ cls: "base-toolbar-sort-item bases-sort-row", attr: { "data-index": String(i) } });
    const handle = row.createDiv({ cls: "bases-drag-handle clickable-icon", attr: { "aria-label": "Drag to reorder" } });
    setIcon(handle, "lucide-grip-vertical");
    const id = normalizePropertyId(s.property);
    propertySelect(row, ids, id, display, (next) => {
      if (!next) return;
      s.property = next;
      host.commit();
    });
    const labels = directionLabels(propertyKind(app, id));
    plainSelect(row, { ASC: labels.ASC, DESC: labels.DESC }, String(s.direction).toUpperCase() === "DESC" ? "DESC" : "ASC", (d) => {
      s.direction = d;
      host.commit();
    });
    iconButton(row, "lucide-trash-2", "Remove sort", () => {
      sorts.splice(i, 1);
      if (!sorts.length) delete view.sort;
      host.commit();
    });
  });
  makeSortable(list, ".bases-sort-row", ".bases-drag-handle", (from, to) => {
    view.sort = moveItem(sorts, from, to);
    host.commit();
  });
  const add = textIconButton(el.createDiv({ cls: "bases-toolbar-menu-footer" }), "lucide-plus", "Add sort", () => {
    const used = new Set(sorts.map((s) => normalizePropertyId(s.property)));
    const next = config.getOrder().find((id) => !used.has(id)) ?? ids.find((id) => !used.has(id)) ?? "file.name";
    view.sort = [...sorts, { property: next, direction: "ASC" }];
    host.commit();
  });
  add.addClass("mod-add");

  el.createDiv({ cls: "menu-separator" });
  sectionHeading(el, "Group by");
  const groupRow = el.createDiv({ cls: "bases-sort-row mod-group" });
  const group = view.groupBy?.property ? normalizePropertyId(view.groupBy.property) : null;
  propertySelect(groupRow, ids, group, display, (next) => {
    if (!next) delete view.groupBy;
    else view.groupBy = { property: next, direction: view.groupBy?.direction ?? "ASC" };
    host.commit();
  }, { allowNone: "None" });
  if (group) {
    const labels = directionLabels(propertyKind(app, group));
    plainSelect(groupRow, { ASC: labels.ASC, DESC: labels.DESC }, String(view.groupBy.direction).toUpperCase() === "DESC" ? "DESC" : "ASC", (d) => {
      view.groupBy.direction = d;
      host.commit();
    });
    iconButton(groupRow, "lucide-trash-2", "Remove group", () => {
      delete view.groupBy;
      host.commit();
    });
  }
}

// ---------------------------------------------------------------------------
// filters

const CONJUNCTION_LABELS: Record<Conjunction, string> = {
  and: "All the following are true",
  or: "Any of the following are true",
  not: "None of the following are true",
};

function renderFilterMenu(host: BasesHost, el: HTMLElement) {
  const ctrl = host.controller;
  el.addClass("bases-query-container");
  renderFilterSection(host, el, "All views", "global", () => ctrl.base.filters, (n) => {
    if (n === undefined) delete ctrl.base.filters;
    else ctrl.base.filters = n;
  });
  el.createDiv({ cls: "menu-separator" });
  const view = ctrl.currentView;
  if (!view) return;
  renderFilterSection(host, el, "This view", `view-${ctrl.viewIndex}`, () => view.filters, (n) => {
    if (n === undefined) delete view.filters;
    else view.filters = n;
  });
}

function renderFilterSection(host: BasesHost, el: HTMLElement, title: string, key: string, get: () => FilterNode | undefined, set: (n: FilterNode | undefined) => void) {
  const state = stateOf(host);
  const section = el.createDiv({ cls: "bases-filter-section" });
  const heading = sectionHeading(section, title);
  const advanced = state.advanced.has(key);
  const toggle = iconButton(heading, "lucide-code-xml", advanced ? "Use the filter builder" : "Advanced filter", () => {
    if (advanced) state.advanced.delete(key);
    else state.advanced.add(key);
    host.popover?.refresh();
  }, "bases-filter-advanced-toggle");
  toggle.toggleClass("is-active", advanced);
  const commit = (n: FilterNode | undefined) => {
    set(n);
    host.commit();
  };
  const current = get();
  const errors = (host.controller.raw?.errors ?? []).filter((e: any) => typeof e?.source === "string" && e.source.startsWith(key === "global" ? "filters" : `views[${host.controller.viewIndex}].filters`));

  if (advanced) {
    const area = section.createEl("textarea", { cls: "bases-filter-advanced", attr: { rows: "4", spellcheck: "false", "data-focus-key": `adv-${key}`, placeholder: 'file.hasTag("book") && rating > 3' } });
    area.value = filterToExpression(current);
    area.addEventListener("change", () => commit(area.value.trim() ? area.value.trim() : undefined));
    for (const e of errors) section.createDiv({ cls: "bases-filter-error", text: e.message });
    return;
  }
  let group: FilterNode = current === undefined || current === null ? { and: [] } : typeof current === "string" ? { and: [current] } : current;
  if (!conjunctionOf(group)) group = { and: [] };
  renderFilterGroup(host, section, group, (g) => commit(g && childrenOf(g).length === 0 && conjunctionOf(g) === "and" ? undefined : g), 0, null);
  for (const e of errors) section.createDiv({ cls: "bases-filter-error", text: e.message });
}

function renderFilterGroup(host: BasesHost, parent: HTMLElement, group: FilterNode, commit: (g: FilterNode) => void, depth: number, onDelete: (() => void) | null) {
  const conj = conjunctionOf(group)!;
  const children = childrenOf(group);
  const wrap = parent.createDiv({ cls: "filter-group" });
  const header = wrap.createDiv({ cls: "filter-group-header" });
  plainSelect(header, CONJUNCTION_LABELS, conj, (c) => commit({ [c]: children } as FilterNode), "filter-group-conjunction");
  if (onDelete) iconButton(header, "lucide-trash-2", "Remove filter group", onDelete);
  const statements = wrap.createDiv({ cls: "filter-group-statements" });
  children.forEach((child, i) => {
    const setChild = (n: FilterNode | null) => {
      const arr = children.slice();
      if (n === null) arr.splice(i, 1);
      else arr[i] = n;
      commit({ [conj]: arr } as FilterNode);
    };
    const stmt = statements.createDiv({ cls: "filter-group-statement" });
    if (typeof child === "string") renderFilterRow(host, stmt, child, setChild, `${depth}-${i}`);
    else renderFilterGroup(host, stmt, child, (n) => setChild(n), depth + 1, () => setChild(null));
  });
  const footer = wrap.createDiv({ cls: "filter-group-footer" });
  textIconButton(footer, "lucide-plus", "Add filter", () => commit({ [conj]: [...children, 'file.name.contains("")'] } as FilterNode), "mod-add");
  if (depth < 3) textIconButton(footer, "lucide-plus", "Add filter group", () => commit({ [conj]: [...children, { and: ['file.name.contains("")'] }] } as FilterNode), "mod-add");
}

function renderFilterRow(host: BasesHost, parent: HTMLElement, expression: string, setChild: (n: FilterNode | null) => void, key: string) {
  const ctrl = host.controller;
  const app = host.app;
  const row = parent.createDiv({ cls: "filter-row filter-row-component" });
  const parsed = parseFilterRow(expression);
  if (!parsed) {
    row.addClass("mod-expression");
    const input = row.createEl("input", { type: "text", cls: "filter-row-expression", attr: { spellcheck: "false", "data-focus-key": `expr-${key}` } });
    input.value = expression;
    input.setAttr("aria-label", "This filter cannot be represented by the simple filter builder");
    input.addEventListener("change", () => setChild(input.value.trim() ? input.value : null));
    iconButton(row, "lucide-trash-2", "Remove filter", () => setChild(null));
    return;
  }
  const kind = propertyKind(app, parsed.property);
  const config = ctrl.config!;
  propertySelect(row, ctrl.allProperties, parsed.property, (id) => config.getDisplayName(id), (id) => {
    if (!id) return;
    const nextKind = propertyKind(app, id);
    const ops = operatorsFor(id, nextKind);
    const op = ops.find((o) => o.id === parsed.operator) ?? ops[0]!;
    setChild(buildFilterRow({ property: id, operator: op.id, value: parsed.value }, nextKind));
  }, { includeFileObject: true });
  const ops = operatorsFor(parsed.property, kind);
  const opOptions: Record<string, string> = {};
  for (const o of ops) opOptions[o.id] = o.label;
  if (!(parsed.operator in opOptions)) opOptions[parsed.operator] = parsed.operator;
  plainSelect(row, opOptions, parsed.operator, (op) => setChild(buildFilterRow({ ...parsed, operator: op }, kind)), "filter-row-operator");
  const op = ops.find((o) => o.id === parsed.operator);
  if (!op || op.value) {
    if (kind === "checkbox" && (parsed.operator === "eq" || parsed.operator === "neq")) {
      plainSelect(row, { true: "true", false: "false" }, parsed.value === "false" ? "false" : "true", (v) => setChild(buildFilterRow({ ...parsed, value: v }, kind)), "filter-row-value");
    } else {
      const input = row.createEl("input", { type: kind === "date" ? "text" : "text", cls: "filter-row-value", placeholder: kind === "date" ? "YYYY-MM-DD" : "Value", attr: { spellcheck: "false", "data-focus-key": `val-${key}` } });
      input.value = parsed.value;
      input.addEventListener("change", () => setChild(buildFilterRow({ ...parsed, value: input.value }, kind)));
    }
  }
  iconButton(row, "lucide-trash-2", "Remove filter", () => setChild(null));
}

// ---------------------------------------------------------------------------
// properties

function renderPropertiesMenu(host: BasesHost, el: HTMLElement) {
  const ctrl = host.controller;
  const view = ctrl.currentView;
  if (!view) return;
  const config = ctrl.config!;
  const app = host.app;
  const order = config.getOrder();
  // The order as written in the file (bare `author` stays bare); indices match `order`.
  const raw: string[] = Array.isArray(view.order) ? view.order.filter((x: unknown) => typeof x === "string") : ["file.name"];
  const visible = new Set(order);
  const hidden = ctrl.allProperties.filter((id) => !visible.has(id));

  const search = el.createEl("input", { type: "search", cls: "bases-properties-search", placeholder: "Search properties…", attr: { spellcheck: "false" } });
  const setOrder = (next: string[]) => {
    view.order = next;
    host.commit();
  };

  const list = el.createDiv({ cls: "bases-properties-list" });
  const renderRow = (parent: HTMLElement, id: BasesPropertyId, index: number | null) => {
    const row = parent.createDiv({ cls: "bases-toolbar-menu-item bases-property-row", attr: { "data-index": index === null ? "" : String(index), "data-property": id } });
    const on = index !== null;
    const handle = row.createDiv({ cls: "bases-drag-handle clickable-icon" });
    setIcon(handle, on ? "lucide-grip-vertical" : "");
    const box = row.createEl("input", { type: "checkbox", cls: "bases-property-toggle" });
    box.checked = on;
    const icon = row.createDiv({ cls: "bases-toolbar-menu-item-icon" });
    setIcon(icon, propertyIcon(app, id));
    const label = row.createDiv({ cls: "bases-toolbar-menu-item-name" });
    label.createSpan({ text: config.getDisplayName(id) });
    const { kind, name } = splitId(id);
    const defaultName = kind === "file" ? null : name;
    if (defaultName !== null && config.getDisplayName(id) !== defaultName) label.createSpan({ cls: "bases-property-id", text: id });
    row.addEventListener("click", (evt) => {
      if ((evt.target as HTMLElement).closest(".clickable-icon")) return;
      if (evt.target !== box) box.checked = !box.checked;
      if (box.checked) setOrder([...raw, id]);
      else setOrder(raw.filter((o) => normalizePropertyId(o) !== id));
    });
    iconButton(row, "lucide-more-horizontal", "Property options", (evt) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i.setTitle("Rename").setIcon("lucide-pencil").onClick(() => {
          new PromptModal(app, "Display name", config.getDisplayName(id), (value) => {
            const base = ctrl.base;
            base.properties ??= {};
            const existingKey = Object.keys(base.properties).find((k) => normalizePropertyId(k) === id) ?? id;
            const cfg = (base.properties[existingKey] ??= {});
            if (value.trim() === "" || (defaultName !== null && value === defaultName)) delete cfg.displayName;
            else cfg.displayName = value;
            if (!Object.keys(cfg).length) delete base.properties[existingKey];
            host.commit();
          }).open();
        }),
      );
      if (kind === "note") {
        menu.addItem((i) => {
          i.setTitle("Property type").setIcon(propertyIcon(app, id));
          const sub = i.setSubmenu();
          const mtm = app.metadataTypeManager;
          const current = mtm?.getAssignedType?.(name) ?? mtm?.getPropertyInfo?.(name)?.type;
          for (const t of USER_TYPES) {
            sub.addItem((s) =>
              s
                .setTitle(TYPE_INFO[t].name)
                .setIcon(TYPE_INFO[t].icon)
                .setChecked(current === t)
                .onClick(() => {
                  mtm?.setType?.(name, t);
                  host.rerun();
                }),
            );
          }
        });
      }
      if (kind === "formula") {
        menu.addItem((i) => i.setTitle("Edit formula").setIcon("lucide-square-function").onClick(() => new FormulaModal(host, name).open()));
        menu.addItem((i) =>
          i
            .setTitle("Delete formula")
            .setIcon("lucide-trash-2")
            .setWarning(true)
            .onClick(() => {
              delete ctrl.base.formulas[name];
              for (const v of ctrl.views) if (Array.isArray(v.order)) v.order = v.order.filter((o: string) => normalizePropertyId(o) !== id);
              host.commit();
            }),
        );
      }
      menu.showAtMouseEvent(evt);
    });
  };
  const visibleList = list.createDiv({ cls: "bases-properties-visible" });
  order.forEach((id, i) => renderRow(visibleList, id, i));
  makeSortable(visibleList, ".bases-property-row", ".bases-drag-handle", (from, to) => setOrder(moveItem(raw, from, to)));
  if (hidden.length) {
    const hiddenList = list.createDiv({ cls: "bases-properties-hidden" });
    hidden.forEach((id) => renderRow(hiddenList, id, null));
  }
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    list.querySelectorAll<HTMLElement>(".bases-property-row").forEach((row) => {
      const id = row.getAttr("data-property") ?? "";
      const text = `${row.textContent ?? ""} ${id}`.toLowerCase();
      row.toggle(!q || text.includes(q));
    });
  });

  el.createDiv({ cls: "menu-separator" });
  const footer = el.createDiv({ cls: "bases-toolbar-menu-footer" });
  textIconButton(footer, "lucide-plus", "Add formula", () => new FormulaModal(host, null).open(), "mod-add");
  const right = footer.createDiv({ cls: "bases-toolbar-menu-footer-right" });
  right.createEl("button", { cls: "mod-muted", text: "Hide all" }).addEventListener("click", () => setOrder([]));
  right.createEl("button", { cls: "mod-muted", text: "Show all" }).addEventListener("click", () => setOrder([...raw, ...hidden]));
}
