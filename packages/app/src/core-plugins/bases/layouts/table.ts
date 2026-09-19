/**
 * Table layout: sticky header with sort-on-click, drag to reorder and resize
 * columns (widths saved to `columnSize`), a header context menu, collapsible
 * groups with per-group summaries, a summary footer, inline editing of note
 * properties through the property widgets, keyboard navigation between cells.
 */
import { BasesView, NullValue, NumberValue, normalizePropertyId, type BasesAllOptions, type BasesEntry, type BasesPropertyId, type BasesViewConfig, type QueryController, type Value } from "../../../obsidian/bases/api";
import { setIcon } from "../../../obsidian/ui/icons";
import { Menu } from "../../../obsidian/ui/menu";
import { renderWidget } from "../../properties/widgets";
import { typeFor } from "../../properties/types";
import { FormulaModal, PromptModal } from "../modals";
import { directionLabels, propertyIcon, propertyKind, splitId } from "../properties";
import { hostOf, renderFileLink, renderGroupHeading, renderValue, showFileMenu, showSummaryMenu, summaryFor } from "./common";

const DEFAULT_WIDTH = 180;
const MIN_WIDTH = 60;

export const TABLE_ROW_HEIGHTS: Record<string, string> = { short: "Short", medium: "Medium", tall: "Tall", "extra-tall": "Extra tall" };

export function tableOptions(_config: BasesViewConfig): BasesAllOptions[] {
  return [{ type: "dropdown", key: "rowHeight", displayName: "Row height", default: "short", options: TABLE_ROW_HEIGHTS }];
}

export class TableView extends BasesView {
  type = "table";
  containerEl: HTMLElement;
  private tableEl: HTMLElement | null = null;
  private columns: BasesPropertyId[] = [];

  constructor(controller: QueryController, parentEl: HTMLElement) {
    super(controller);
    this.containerEl = parentEl.createDiv({ cls: "bases-table-container" });
  }

  override onload() {
    this.registerDomEvent(this.containerEl, "keydown", (evt: KeyboardEvent) => this.onKeyDown(evt));
  }

  onDataUpdated(): void {
    this.render();
  }

  private width(id: BasesPropertyId): number {
    const sizes = (this.config.get("columnSize") ?? {}) as Record<string, number>;
    for (const [k, v] of Object.entries(sizes)) if (normalizePropertyId(k) === id && typeof v === "number") return Math.max(MIN_WIDTH, Math.abs(v));
    return id === "file.name" ? 240 : DEFAULT_WIDTH;
  }

  private rawOrderKey(id: BasesPropertyId): string {
    return (this.config.get("order") as string[] | undefined)?.find((o) => normalizePropertyId(o) === id) ?? id;
  }

  private render() {
    const scrollLeft = this.containerEl.scrollLeft;
    const scrollTop = this.containerEl.scrollTop;
    const focused = document.activeElement?.closest?.(".bases-td") as HTMLElement | null;
    const focusPos = focused && this.containerEl.contains(focused) ? { path: focused.parentElement?.getAttr("data-path"), prop: focused.getAttr("data-property") } : null;
    this.containerEl.empty();
    const data = this.data;
    const columns = (this.columns = data.properties);
    const table = (this.tableEl = this.containerEl.createDiv({ cls: "bases-table" }));
    const rowHeight = String(this.config.get("rowHeight") ?? "short");
    table.setAttr("data-row-height", rowHeight);
    columns.forEach((id, i) => table.style.setProperty(`--bases-col-${i}`, `${this.width(id)}px`));
    const totalWidth = columns.reduce((n, id) => n + this.width(id), 0);
    table.style.minWidth = `${totalWidth + 40}px`;

    this.renderHeader(table);
    const summaries = columns.some((id) => summaryFor(this, id).name);
    const groups = data.groupedData;
    const grouped = !!(this.config.get("groupBy") as { property?: string } | undefined)?.property;
    for (const group of groups) {
      let collapsed = false;
      if (grouped) {
        collapsed = renderGroupHeading(this, table, group, () => this.render());
        if (summaries) this.renderSummaryRow(table, group.entries, "mod-group");
      }
      const tbody = table.createDiv({ cls: "bases-tbody" });
      if (collapsed) {
        tbody.hide();
        continue;
      }
      for (const entry of group.entries) this.renderRow(tbody, entry);
    }
    if (!data.data.length) {
      const empty = table.createDiv({ cls: "bases-table-empty bases-empty-state" });
      empty.setText(data.errors.length ? "No results. The filters have errors." : "No results");
    }
    if (summaries) this.renderSummaryRow(table, data.data, "mod-footer");

    this.containerEl.scrollLeft = scrollLeft;
    this.containerEl.scrollTop = scrollTop;
    if (focusPos?.path && focusPos.prop) {
      const row = table.querySelector<HTMLElement>(`.bases-tr[data-path="${CSS.escape(focusPos.path)}"]`);
      row?.querySelector<HTMLElement>(`.bases-td[data-property="${CSS.escape(focusPos.prop)}"]`)?.focus({ preventScroll: true });
    }
  }

  private renderHeader(table: HTMLElement) {
    const thead = table.createDiv({ cls: "bases-thead" });
    const tr = thead.createDiv({ cls: "bases-tr" });
    const sort = this.config.getSort();
    this.columns.forEach((id, index) => {
      const th = tr.createDiv({ cls: "bases-table-header bases-th", attr: { "data-property": id, "data-index": String(index) } });
      th.style.width = `var(--bases-col-${index})`;
      const inner = th.createDiv({ cls: "bases-table-header-inner" });
      setIcon(inner.createDiv({ cls: "bases-table-header-icon" }), propertyIcon(this.app, id));
      inner.createDiv({ cls: "bases-table-header-name", text: this.config.getDisplayName(id) });
      const s = sort.findIndex((x) => x.property === id);
      if (s >= 0) {
        const ind = inner.createDiv({ cls: "bases-table-header-sort", attr: { "aria-label": sort.length > 1 ? `Sort priority ${s + 1}` : "Sorted" } });
        setIcon(ind, sort[s]!.direction === "DESC" ? "lucide-arrow-down" : "lucide-arrow-up");
        th.addClass("is-sorted");
      }
      const resizer = th.createDiv({ cls: "bases-table-header-resizer" });
      this.bindResize(resizer, th, id, index);
      this.bindHeaderDrag(th, index);
      th.addEventListener("click", (evt) => {
        if ((evt.target as HTMLElement).closest(".bases-table-header-resizer") || th.hasClass("is-dragging")) return;
        this.cycleSort(id);
      });
      th.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        this.showHeaderMenu(id, evt);
      });
    });
    const add = tr.createDiv({ cls: "bases-table-header bases-table-add-column clickable-icon", attr: { "aria-label": "Add property", role: "button" } });
    setIcon(add, "lucide-plus");
    add.addEventListener("click", (evt) => this.showAddColumnMenu(evt));
  }

  private cycleSort(id: BasesPropertyId) {
    const sort = (this.config.get("sort") as { property: string; direction: string }[] | undefined) ?? [];
    const idx = sort.findIndex((s) => normalizePropertyId(s.property) === id);
    const next = sort.slice();
    if (idx < 0) next.unshift({ property: this.rawOrderKey(id), direction: "ASC" });
    else if (String(next[idx]!.direction).toUpperCase() === "ASC") {
      next.splice(idx, 1);
      next.unshift({ property: this.rawOrderKey(id), direction: "DESC" });
    } else next.splice(idx, 1);
    this.config.set("sort", next.length ? next : null);
  }

  private setSort(id: BasesPropertyId, direction: "ASC" | "DESC") {
    const sort = ((this.config.get("sort") as { property: string; direction: string }[] | undefined) ?? []).filter((s) => normalizePropertyId(s.property) !== id);
    this.config.set("sort", [{ property: this.rawOrderKey(id), direction }, ...sort]);
  }

  private showHeaderMenu(id: BasesPropertyId, evt: MouseEvent) {
    const host = hostOf(this);
    const labels = directionLabels(propertyKind(this.app, id));
    const { kind, name } = splitId(id);
    const menu = new Menu();
    menu.addItem((i) => i.setSection("sort").setTitle(`Sort ${labels.ASC}`).setIcon("lucide-arrow-up").onClick(() => this.setSort(id, "ASC")));
    menu.addItem((i) => i.setSection("sort").setTitle(`Sort ${labels.DESC}`).setIcon("lucide-arrow-down").onClick(() => this.setSort(id, "DESC")));
    if (this.config.getSort().some((s) => s.property === id))
      menu.addItem((i) =>
        i.setSection("sort").setTitle("Clear sort").setIcon("lucide-x").onClick(() => {
          const sort = ((this.config.get("sort") as { property: string }[] | undefined) ?? []).filter((s) => normalizePropertyId(s.property) !== id);
          this.config.set("sort", sort.length ? sort : null);
        }),
      );
    menu.addItem((i) => i.setSection("group").setTitle("Group by this property").setIcon("lucide-layers").onClick(() => this.config.set("groupBy", { property: this.rawOrderKey(id), direction: "ASC" })));
    menu.addItem((i) => i.setSection("group").setTitle("Summarize...").setIcon("lucide-calculator").onClick(() => showSummaryMenu(this, id, evt)));
    if (kind === "formula" && host) menu.addItem((i) => i.setSection("edit").setTitle("Edit formula...").setIcon("lucide-square-function").onClick(() => new FormulaModal(host, name).open()));
    else if (host)
      menu.addItem((i) =>
        i.setSection("edit").setTitle("Edit property...").setIcon("lucide-pencil").onClick(() => {
          new PromptModal(this.app, "Display name", this.config.getDisplayName(id), (value) => {
            const base = host.controller.base;
            base.properties ??= {};
            const key = Object.keys(base.properties).find((k) => normalizePropertyId(k) === id) ?? id;
            const cfg = (base.properties[key] ??= {});
            if (!value.trim() || value === name) delete cfg.displayName;
            else cfg.displayName = value;
            if (!Object.keys(cfg).length) delete base.properties[key];
            host.commit();
          }).open();
        }),
      );
    menu.addItem((i) =>
      i.setSection("column").setTitle("Hide column").setIcon("lucide-eye-off").onClick(() => {
        const order = ((this.config.get("order") as string[] | undefined) ?? ["file.name"]).filter((o) => normalizePropertyId(o) !== id);
        this.config.set("order", order);
      }),
    );
    menu.addItem((i) =>
      i.setSection("column").setTitle("Resize column...").setIcon("lucide-move-horizontal").onClick(() => {
        new PromptModal(this.app, "Column width (px)", String(this.width(id)), (value) => {
          const n = Math.round(Number(value));
          if (Number.isFinite(n) && n > 0) this.saveWidth(id, Math.max(MIN_WIDTH, n));
        }).open();
      }),
    );
    const sizes = (this.config.get("columnSize") ?? {}) as Record<string, number>;
    if (Object.keys(sizes).some((k) => normalizePropertyId(k) === id))
      menu.addItem((i) =>
        i.setSection("column").setTitle("Reset column size").setIcon("lucide-rotate-ccw").onClick(() => {
          const next = Object.fromEntries(Object.entries(sizes).filter(([k]) => normalizePropertyId(k) !== id));
          this.config.set("columnSize", Object.keys(next).length ? next : null);
        }),
      );
    menu.showAtMouseEvent(evt);
  }

  private showAddColumnMenu(evt: MouseEvent) {
    const host = hostOf(this);
    const visible = new Set(this.columns);
    const menu = new Menu();
    for (const id of this.allProperties.filter((p) => !visible.has(p))) {
      menu.addItem((i) =>
        i
          .setTitle(this.config.getDisplayName(id))
          .setIcon(propertyIcon(this.app, id))
          .onClick(() => this.config.set("order", [...((this.config.get("order") as string[] | undefined) ?? ["file.name"]), id])),
      );
    }
    if (host) menu.addItem((i) => i.setSection("formula").setTitle("Add formula").setIcon("lucide-square-function").onClick(() => new FormulaModal(host, null).open()));
    menu.showAtMouseEvent(evt);
  }

  private saveWidth(id: BasesPropertyId, width: number) {
    const sizes = { ...((this.config.get("columnSize") ?? {}) as Record<string, number>) };
    const key = Object.keys(sizes).find((k) => normalizePropertyId(k) === id) ?? this.rawOrderKey(id);
    sizes[key] = Math.round(width);
    this.config.set("columnSize", sizes);
  }

  private bindResize(handle: HTMLElement, th: HTMLElement, id: BasesPropertyId, index: number) {
    handle.addEventListener("click", (evt) => evt.stopPropagation());
    handle.addEventListener("dblclick", (evt) => {
      evt.stopPropagation();
      const sizes = (this.config.get("columnSize") ?? {}) as Record<string, number>;
      const next = Object.fromEntries(Object.entries(sizes).filter(([k]) => normalizePropertyId(k) !== id));
      this.config.set("columnSize", Object.keys(next).length ? next : null);
    });
    handle.addEventListener("pointerdown", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const startX = evt.clientX;
      const startW = th.getBoundingClientRect().width;
      let width = startW;
      handle.setPointerCapture(evt.pointerId);
      th.addClass("is-resizing");
      const move = (e: PointerEvent) => {
        width = Math.max(MIN_WIDTH, startW + (e.clientX - startX));
        this.tableEl?.style.setProperty(`--bases-col-${index}`, `${width}px`);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        th.removeClass("is-resizing");
        if (Math.round(width) !== Math.round(startW)) this.saveWidth(id, width);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  private bindHeaderDrag(th: HTMLElement, index: number) {
    th.addEventListener("pointerdown", (evt) => {
      if (evt.button !== 0 || (evt.target as HTMLElement).closest(".bases-table-header-resizer")) return;
      const startX = evt.clientX;
      let dragging = false;
      let dropIndex = index;
      const headers = () => Array.from(this.tableEl?.querySelectorAll<HTMLElement>(".bases-thead .bases-th") ?? []);
      const move = (e: PointerEvent) => {
        if (!dragging && Math.abs(e.clientX - startX) < 5) return;
        if (!dragging) {
          dragging = true;
          th.addClass("is-dragging");
          th.setPointerCapture(e.pointerId);
        }
        th.style.transform = `translateX(${e.clientX - startX}px)`;
        const list = headers();
        dropIndex = list.length;
        for (let i = 0; i < list.length; i++) {
          const r = list[i]!.getBoundingClientRect();
          if (e.clientX < r.left + r.width / 2) {
            dropIndex = i;
            break;
          }
        }
        list.forEach((h, i) => {
          h.toggleClass("is-drop-before", i === dropIndex && i !== index && i !== index + 1);
          h.toggleClass("is-drop-after", dropIndex === list.length && i === list.length - 1 && index !== list.length - 1);
        });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        if (!dragging) return;
        th.style.transform = "";
        headers().forEach((h) => h.removeClasses(["is-drop-before", "is-drop-after"]));
        setTimeout(() => th.removeClass("is-dragging"), 0);
        let to = dropIndex;
        if (to > index) to--;
        if (to === index) return;
        const order = ((this.config.get("order") as string[] | undefined) ?? ["file.name"]).slice();
        const [item] = order.splice(index, 1);
        order.splice(to, 0, item!);
        this.config.set("order", order);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  private renderRow(tbody: HTMLElement, entry: BasesEntry) {
    const tr = tbody.createDiv({ cls: "bases-tr", attr: { "data-path": entry.file.path } });
    tr.addEventListener("contextmenu", (evt) => {
      if ((evt.target as HTMLElement).closest(".is-editing")) return;
      showFileMenu(this, entry, evt);
    });
    this.columns.forEach((id, index) => {
      const td = tr.createDiv({ cls: "bases-td", attr: { "data-property": id, tabindex: "-1" } });
      td.style.width = `var(--bases-col-${index})`;
      this.cells.set(td, { entry, id });
      this.renderCell(td, entry, id);
    });
  }

  private editable(entry: BasesEntry, id: BasesPropertyId): boolean {
    const host = hostOf(this);
    return splitId(id).kind === "note" && entry.file.extension === "md" && !!host;
  }

  private frontmatterValue(entry: BasesEntry, name: string): { key: string; value: unknown } {
    const fm = (this.app.metadataCache.getFileCache(entry.file)?.frontmatter ?? {}) as Record<string, unknown>;
    const key = Object.keys(fm).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
    return { key, value: fm[key] };
  }

  private renderCell(td: HTMLElement, entry: BasesEntry, id: BasesPropertyId) {
    td.empty();
    td.removeClass("is-editing");
    const cell = td.createDiv({ cls: "bases-table-cell" });
    const { kind, name } = splitId(id);
    const value = entry.getValue(id);
    if (kind === "file" && (name === "name" || name === "basename" || name === "path")) {
      const text = name === "name" && entry.file.extension === "md" ? entry.file.basename : (value?.toString() ?? entry.file.name);
      renderFileLink(this, cell, entry, text);
      return;
    }
    if (!this.editable(entry, id)) {
      td.addClass("mod-readonly");
      renderValue(this, cell, value);
      return;
    }
    const { value: raw } = this.frontmatterValue(entry, name);
    const type = typeFor(this.app, name, raw);
    if (type === "checkbox") {
      cell.addClass("metadata-property-value");
      renderWidget("checkbox", cell, raw, this.widgetContext(td, entry, id));
      return;
    }
    renderValue(this, cell, value as Value | null);
    td.onclick = (evt) => {
      if ((evt.target as HTMLElement).closest("a, input, .is-editing") || td.hasClass("is-editing")) return;
      this.startEdit(td, entry, id);
    };
  }

  private widgetContext(td: HTMLElement, entry: BasesEntry, id: BasesPropertyId) {
    const { name } = splitId(id);
    return {
      app: this.app,
      key: name,
      sourcePath: entry.file.path,
      hoverParent: this.app.renderContext,
      onChange: (v: unknown) => void this.writeProperty(entry.file, name, v, true),
      blur: () => td.focus(),
    };
  }

  /** Writes one frontmatter value (undefined deletes it) and records it for undo. */
  private async writeProperty(file: any, name: string, value: unknown, record: boolean) {
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const key = Object.keys(fm).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
      const had = key in fm;
      if ((value === null || value === undefined) && !had) return;
      const old = had ? JSON.parse(JSON.stringify(fm[key] ?? null)) : undefined;
      if (value === undefined) delete fm[key];
      else fm[key] = value;
      if (record) {
        this.undoStack.push({ file, name, old, next: value });
        if (this.undoStack.length > 100) this.undoStack.shift();
        this.redoStack = [];
      }
    });
  }

  private undoStack: { file: any; name: string; old: unknown; next: unknown }[] = [];
  private redoStack: { file: any; name: string; old: unknown; next: unknown }[] = [];
  private cells = new WeakMap<HTMLElement, { entry: BasesEntry; id: BasesPropertyId }>();

  private undo(redo: boolean) {
    const edit = (redo ? this.redoStack : this.undoStack).pop();
    if (!edit) return;
    (redo ? this.undoStack : this.redoStack).push(edit);
    void this.writeProperty(edit.file, edit.name, redo ? edit.next : edit.old, false);
  }

  private pasteInto(td: HTMLElement, text: string) {
    const cell = this.cells.get(td);
    if (!cell || !this.editable(cell.entry, cell.id)) return;
    const { name } = splitId(cell.id);
    const type = typeFor(this.app, name, this.frontmatterValue(cell.entry, name).value);
    const t = text.trim();
    let value: unknown = t;
    if (t === "") value = null;
    else if (type === "number") value = Number.isFinite(Number(t)) ? Number(t) : t;
    else if (type === "checkbox") value = /^(true|yes|1|x)$/i.test(t);
    else if (type === "multitext" || type === "tags" || type === "aliases") value = t.split(/,|\n/).map((s) => s.trim()).filter(Boolean);
    void this.writeProperty(cell.entry.file, name, value, true);
  }

  private startEdit(td: HTMLElement, entry: BasesEntry, id: BasesPropertyId) {
    if (td.hasClass("is-editing")) return;
    const { name } = splitId(id);
    const { value: raw } = this.frontmatterValue(entry, name);
    const type = typeFor(this.app, name, raw);
    td.empty();
    td.addClass("is-editing");
    const cell = td.createDiv({ cls: "bases-table-cell metadata-property-value" });
    cell.setAttr("data-property-type", type);
    const handle = renderWidget(type, cell, raw, this.widgetContext(td, entry, id));
    const finish = (evt: FocusEvent) => {
      const next = evt.relatedTarget as Node | null;
      if (next && next !== td && (td.contains(next) || (next as Element).closest?.(".suggestion-container"))) return;
      td.removeEventListener("focusout", finish);
      setTimeout(() => {
        const active = document.activeElement;
        if ((active !== td && td.contains(active)) || active?.closest(".suggestion-container")) {
          td.addEventListener("focusout", finish);
          return;
        }
        if (!td.isConnected) return;
        this.renderCell(td, entry, id);
        if (active === td) td.focus({ preventScroll: true });
        hostOf(this)?.flushPending();
      }, 50);
    };
    td.addEventListener("focusout", finish);
    handle.focus(true);
  }

  private renderSummaryRow(table: HTMLElement, entries: BasesEntry[], cls: string) {
    const tr = table.createDiv({ cls: `bases-tr bases-summary-row ${cls}` });
    this.columns.forEach((id, index) => {
      const td = tr.createDiv({ cls: "bases-td bases-summary-cell", attr: { "data-property": id } });
      td.style.width = `var(--bases-col-${index})`;
      const { name } = summaryFor(this, id);
      if (name) {
        td.createSpan({ cls: "summary-function-name", text: name });
        const value = this.data.getSummaryValue(this.controller, entries, id, name);
        const shown = value instanceof NumberValue && !Number.isInteger(value.value) ? new NumberValue(Math.round(value.value * 1000) / 1000) : value;
        if (!(value instanceof NullValue)) renderValue(this, td.createSpan({ cls: "summary-value", attr: { "aria-label": value.toString() } }), shown);
      } else td.addClass("is-empty");
      td.addEventListener("click", (evt) => showSummaryMenu(this, id, evt));
    });
  }

  private onKeyDown(evt: KeyboardEvent) {
    const td = (evt.target as HTMLElement).closest?.(".bases-td") as HTMLElement | null;
    if (!td || td.hasClass("is-editing") || td.hasClass("bases-summary-cell")) {
      if (td?.hasClass("is-editing") && evt.key === "Escape") {
        evt.preventDefault();
        td.focus();
      }
      return;
    }
    const tr = td.parentElement!;
    const rows = Array.from(this.containerEl.querySelectorAll<HTMLElement>(".bases-tbody .bases-tr"));
    const r = rows.indexOf(tr);
    const cells = Array.from(tr.querySelectorAll<HTMLElement>(":scope > .bases-td"));
    const c = cells.indexOf(td);
    const focusAt = (row: number, col: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, row))];
      const list = target ? Array.from(target.querySelectorAll<HTMLElement>(":scope > .bases-td")) : [];
      list[Math.max(0, Math.min(list.length - 1, col))]?.focus();
    };
    switch (evt.key) {
      case "ArrowDown":
        focusAt(r + 1, c);
        break;
      case "ArrowUp":
        focusAt(r - 1, c);
        break;
      case "ArrowRight":
        focusAt(r, c + 1);
        break;
      case "ArrowLeft":
        focusAt(r, c - 1);
        break;
      case "Tab":
        focusAt(r, c + (evt.shiftKey ? -1 : 1));
        break;
      case "Home":
        focusAt(r, 0);
        break;
      case "End":
        focusAt(r, cells.length - 1);
        break;
      case "PageDown":
        focusAt(r + 10, c);
        break;
      case "PageUp":
        focusAt(r - 10, c);
        break;
      case "Escape":
        td.blur();
        break;
      case "Enter": {
        const link = td.querySelector<HTMLElement>("a.bases-file-link");
        const box = td.querySelector<HTMLInputElement>("input[type=checkbox]");
        if (box && !box.disabled) box.click();
        else if (link) link.click();
        else td.click();
        break;
      }
      case "c":
      case "C":
        if (!(evt.metaKey || evt.ctrlKey)) return;
        void navigator.clipboard?.writeText(td.innerText.trim());
        break;
      case "v":
      case "V":
        if (!(evt.metaKey || evt.ctrlKey)) return;
        void navigator.clipboard?.readText().then((text) => this.pasteInto(td, text));
        break;
      case "z":
      case "Z":
        if (!(evt.metaKey || evt.ctrlKey)) return;
        this.undo(evt.shiftKey);
        break;
      case "y":
        if (!(evt.metaKey || evt.ctrlKey)) return;
        this.undo(true);
        break;
      case "Backspace":
      case "Delete": {
        const cell = this.cells.get(td);
        if (!cell || !this.editable(cell.entry, cell.id)) return;
        void this.writeProperty(cell.entry.file, splitId(cell.id).name, null, true);
        break;
      }
      default:
        return;
    }
    evt.preventDefault();
  }
}
