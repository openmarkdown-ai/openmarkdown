/**
 * Small DOM helpers shared by the Bases toolbar and layouts: the toolbar
 * popover, property pickers, icon buttons.
 */
import { setIcon } from "../../obsidian/ui/icons";
import type { BasesPropertyId } from "../../obsidian/bases/api";
import { splitId } from "./properties";

/** A toolbar dropdown panel anchored under a button. Closes on outside click or Escape. */
export class ToolbarPopover {
  el: HTMLElement;
  private onDocDown = (evt: MouseEvent) => {
    const t = evt.target as Node | null;
    if (!t || !(t as Element).isConnected) return;
    if (this.el.contains(t) || this.anchor.contains(t)) return;
    const el = t instanceof Element ? t : t.parentElement;
    // Menus, modals and suggestion lists spawned from inside the panel do not close it.
    if (el?.closest(".menu:not(.bases-toolbar-menu-container), .modal-container, .suggestion-container, .prompt")) return;
    this.close();
  };
  private onKey = (evt: KeyboardEvent) => {
    if (evt.key === "Escape" && !document.querySelector(".modal-container")) {
      evt.stopPropagation();
      this.close();
    }
  };
  private closed = false;

  constructor(
    public anchor: HTMLElement,
    private render: (el: HTMLElement, popover: ToolbarPopover) => void,
    private onClose?: () => void,
    cls = "",
  ) {
    this.el = document.body.createDiv({ cls: `menu bases-toolbar-menu-container ${cls}`.trim() });
    this.refresh();
    this.position();
    anchor.addClass("has-active-menu");
    setTimeout(() => {
      if (this.closed) return;
      document.addEventListener("mousedown", this.onDocDown, true);
      document.addEventListener("keydown", this.onKey, true);
    });
  }

  get isOpen() {
    return !this.closed;
  }

  setAnchor(anchor: HTMLElement) {
    if (anchor === this.anchor) return;
    this.anchor.removeClass("has-active-menu");
    this.anchor = anchor;
    anchor.addClass("has-active-menu");
  }

  refresh() {
    if (this.closed) return;
    const scroll = this.el.scrollTop;
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && this.el.contains(active) ? active.getAttr("data-focus-key") : null;
    this.el.empty();
    this.render(this.el, this);
    this.el.scrollTop = scroll;
    if (focusKey) this.el.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  position() {
    const r = this.anchor.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${r.bottom + 4}px`;
    this.el.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 16)}px`;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    document.removeEventListener("mousedown", this.onDocDown, true);
    document.removeEventListener("keydown", this.onKey, true);
    this.anchor.removeClass("has-active-menu");
    this.el.detach();
    this.onClose?.();
  }
}

export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: (evt: MouseEvent) => void, cls = ""): HTMLElement {
  const btn = parent.createDiv({ cls: `clickable-icon ${cls}`.trim(), attr: { "aria-label": label, role: "button", tabindex: "0" } });
  setIcon(btn, icon);
  btn.addEventListener("click", (evt) => {
    evt.stopPropagation();
    onClick(evt);
  });
  btn.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      btn.click();
    }
  });
  return btn;
}

export function textIconButton(parent: HTMLElement, icon: string, label: string, onClick: (evt: MouseEvent) => void, cls = ""): HTMLElement {
  const btn = parent.createDiv({ cls: `text-icon-button ${cls}`.trim(), attr: { role: "button", tabindex: "0" } });
  setIcon(btn.createSpan({ cls: "text-button-icon" }), icon);
  btn.createSpan({ cls: "text-button-label", text: label });
  btn.addEventListener("click", (evt) => onClick(evt));
  btn.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      btn.click();
    }
  });
  return btn;
}

/** A `<select>` of properties grouped as Note / File / Formula. */
export function propertySelect(
  parent: HTMLElement,
  ids: BasesPropertyId[],
  current: string | null,
  displayName: (id: BasesPropertyId) => string,
  onChange: (id: BasesPropertyId | null) => void,
  opts: { allowNone?: string; filter?: (id: BasesPropertyId) => boolean; includeFileObject?: boolean } = {},
): HTMLSelectElement {
  const select = parent.createEl("select", { cls: "dropdown bases-property-select" });
  if (opts.allowNone !== undefined) select.createEl("option", { text: opts.allowNone, value: "" });
  const groups: Record<string, HTMLOptGroupElement> = {};
  const labels: Record<string, string> = { note: "Note properties", file: "File properties", formula: "Formulas" };
  const list = ids.slice();
  if (opts.includeFileObject && !list.includes("file.file")) list.push("file.file");
  if (current && !list.includes(current as BasesPropertyId)) list.push(current as BasesPropertyId);
  for (const id of list) {
    if (opts.filter && !opts.filter(id)) continue;
    const kind = splitId(id).kind;
    const group = (groups[kind] ??= select.createEl("optgroup", { attr: { label: labels[kind] ?? kind } }));
    group.createEl("option", { text: id === "file.file" ? "file" : displayName(id), value: id });
  }
  for (const k of ["note", "file", "formula"]) if (groups[k]) select.appendChild(groups[k]!);
  select.value = current ?? "";
  select.addEventListener("change", () => onChange((select.value || null) as BasesPropertyId | null));
  return select;
}

export function plainSelect(parent: HTMLElement, options: Record<string, string>, current: string, onChange: (v: string) => void, cls = ""): HTMLSelectElement {
  const select = parent.createEl("select", { cls: `dropdown ${cls}`.trim() });
  for (const [value, text] of Object.entries(options)) select.createEl("option", { text, value });
  select.value = current;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/** Drag-to-reorder for the children of `list` carrying `data-index`. */
export function makeSortable(list: HTMLElement, itemSelector: string, handleSelector: string | null, onMove: (from: number, to: number) => void) {
  let dragFrom = -1;
  list.querySelectorAll<HTMLElement>(itemSelector).forEach((item) => {
    const handle = handleSelector ? item.querySelector<HTMLElement>(handleSelector) : item;
    if (!handle) return;
    handle.setAttr("draggable", "true");
    handle.addEventListener("dragstart", (evt) => {
      dragFrom = Number(item.getAttr("data-index"));
      evt.dataTransfer?.setData("text/plain", String(dragFrom));
      if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
      if (handle !== item) evt.dataTransfer?.setDragImage(item, 10, 10);
      item.addClass("is-being-dragged");
    });
    handle.addEventListener("dragend", () => {
      item.removeClass("is-being-dragged");
      list.querySelectorAll(".is-drop-before, .is-drop-after").forEach((el) => el.removeClasses(["is-drop-before", "is-drop-after"]));
    });
    item.addEventListener("dragover", (evt) => {
      if (dragFrom < 0) return;
      evt.preventDefault();
      const r = item.getBoundingClientRect();
      const after = evt.clientY > r.top + r.height / 2;
      list.querySelectorAll(".is-drop-before, .is-drop-after").forEach((el) => el.removeClasses(["is-drop-before", "is-drop-after"]));
      item.addClass(after ? "is-drop-after" : "is-drop-before");
    });
    item.addEventListener("drop", (evt) => {
      if (dragFrom < 0) return;
      evt.preventDefault();
      const r = item.getBoundingClientRect();
      const after = evt.clientY > r.top + r.height / 2;
      let to = Number(item.getAttr("data-index")) + (after ? 1 : 0);
      if (to > dragFrom) to--;
      const from = dragFrom;
      dragFrom = -1;
      if (from !== to) onMove(from, to);
    });
  });
}

export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const copy = arr.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(Math.max(0, Math.min(copy.length, to)), 0, item!);
  return copy;
}
