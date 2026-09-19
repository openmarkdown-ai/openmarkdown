/**
 * The Properties (metadata) editor — the widget above a note's content in
 * Live Preview and Reading view, in hover previews, and in the File
 * properties view.
 *
 *   renderMetadataEditor(
 *     app: App,
 *     containerEl: HTMLElement,          // rendered into; if it already has
 *                                        // `.metadata-container` it is used as the root
 *     file: TFile | null,                // for link resolution and the sourcePath
 *     frontmatterYaml: string,           // YAML between the `---` fences (no fences)
 *     onChange: (newYaml: string) => void, // new YAML body ("" when no properties remain)
 *     opts?: MetadataEditorOptions,
 *   ): MetadataEditor
 *
 * The returned MetadataEditor is a loaded Component: call `update(yaml)` when
 * the file changes underneath (ignored while the user is typing in it, and
 * when it is the YAML this editor just emitted), and `unload()` when done
 * (it also cleans up by itself once its element leaves the document).
 * Other handles: `addProperty(key?)` (the "Add file property" command),
 * `focusProperty(key)`, `setCollapsed(bool)`.
 *
 * DOM (Obsidian's):
 *
 *   .metadata-container[.is-collapsed][data-property-count]
 *     .metadata-properties-heading
 *       .collapse-indicator.collapse-icon
 *       .metadata-properties-title   "Properties"
 *     .metadata-content
 *       .metadata-properties
 *         .metadata-property[data-property-key][data-property-type][tabindex=0][.is-selected]
 *           .metadata-property-key
 *             .metadata-property-icon (type icon; click → type menu)
 *             input.metadata-property-key-input
 *           .metadata-property-value
 *             (widget: .metadata-input-longtext | .metadata-link | .multi-select-container
 *              | input.metadata-input-number | input.metadata-input-checkbox | input[type=date] …)
 *       .metadata-add-button.text-icon-button > .text-button-icon + .text-button-label "Add property"
 *
 * Keyboard (a property row focused): ↓/Tab next, ↑/Shift+Tab previous,
 * Shift+↑/↓ extend selection, Mod+A select all, ← edit name, →/Enter edit
 * value, Escape clear selection, Mod+Backspace/Delete remove, Mod+C/X/V
 * copy/cut/paste as YAML, Alt+↓ back to the editor. Vim (when enabled):
 * j/k move, h name, l value, A value at end, i value at start, o new property.
 */
import jsYaml from "js-yaml";
import { Component } from "../../obsidian/events";
import { setMetadataEditorRenderer } from "../../obsidian/markdown/editor-host";
import { setIcon } from "../../obsidian/ui/icons";
import { Menu } from "../../obsidian/ui/menu";
import { ConfirmationModal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import type { TFile } from "../../obsidian/vault/files";
import { PropertyKeySuggest } from "./suggests";
import { convertValue, isCompatible, RESERVED_KEYS, TYPE_INFO, typeFor, USER_TYPES, type PropertyType } from "./types";
import { isNestedValue, registerPropertyWidgets, renderWidget, type WidgetHandle } from "./widgets";

export interface MetadataEditorOptions {
  /** Start folded (the heading's collapse state). */
  collapsed?: boolean;
  onCollapse?(collapsed: boolean): void;
  /** Inputs disabled (e.g. a preview that must not edit). */
  readOnly?: boolean;
  /** Show the "Properties" heading (default true). */
  showHeading?: boolean;
  /** Sidebar styling (`.mod-sidebar`), used by the File properties view. */
  sidebar?: boolean;
  /** Path links resolve from; defaults to `file.path`. */
  sourcePath?: string;
  /** Parent for link hover previews. */
  hoverParent?: { hoverPopover: any } | null;
  /** Alt+↓, or ↓ past the last property: return focus to the note editor. */
  onEscapeToEditor?(): void;
  /** Owner whose lifetime the editor follows. */
  component?: Component;
}

interface Entry {
  key: string;
  value: unknown;
}

const HISTORY: string[] = [];

/** YAML for frontmatter as Obsidian writes it: block lists, double quotes, empty values as `key:`. */
export function dumpFrontmatter(data: Record<string, unknown>): string {
  if (!Object.keys(data).length) return "";
  const out = jsYaml.dump(data, { lineWidth: -1, noRefs: true, schema: jsYaml.JSON_SCHEMA, quotingType: '"' });
  return out.replace(/^([^\s#-][^\n]*?):[ ]null$/gm, "$1:");
}

export function parseFrontmatter(yaml: string): { data: Record<string, unknown> | null; error: string | null } {
  if (!yaml.trim()) return { data: {}, error: null };
  try {
    const data = jsYaml.load(yaml, { schema: jsYaml.JSON_SCHEMA });
    if (data === null || data === undefined) return { data: {}, error: null };
    if (typeof data !== "object" || Array.isArray(data)) return { data: null, error: "Frontmatter must be a set of key: value pairs." };
    return { data: data as Record<string, unknown>, error: null };
  } catch (e) {
    return { data: null, error: String((e as Error)?.message ?? e) };
  }
}

class PropertyRow {
  el: HTMLElement;
  keyEl: HTMLElement;
  iconEl: HTMLElement;
  keyInputEl: HTMLInputElement;
  valueEl: HTMLElement;
  widget: WidgetHandle | null = null;
  type: PropertyType | "unknown" = "text";
  private keySuggest: PropertyKeySuggest | null = null;

  constructor(
    public editor: MetadataEditor,
    public entry: Entry,
    public isNew = false,
  ) {
    this.el = createDiv({ cls: "metadata-property", attr: { tabindex: "0" } });
    this.keyEl = this.el.createDiv({ cls: "metadata-property-key" });
    this.iconEl = this.keyEl.createSpan({ cls: "metadata-property-icon clickable-icon", attr: { "aria-disabled": "false" } });
    this.keyInputEl = this.keyEl.createEl("input", {
      cls: "metadata-property-key-input",
      type: "text",
      attr: { autocapitalize: "none", enterkeyhint: "next", spellcheck: "false", placeholder: "Property name" },
    });
    this.keyInputEl.value = entry.key;
    this.keyInputEl.disabled = !!editor.opts.readOnly;
    this.valueEl = this.el.createDiv({ cls: "metadata-property-value" });

    this.iconEl.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (!editor.opts.readOnly) editor.showRowMenu(this, evt);
    });
    this.el.addEventListener("contextmenu", (evt) => {
      if ((evt.target as HTMLElement).closest(".multi-select-pill, a")) return;
      evt.preventDefault();
      editor.showRowMenu(this, evt);
    });
    this.el.addEventListener("keydown", (evt) => editor.onRowKey(this, evt));
    this.el.addEventListener("mousedown", (evt) => {
      if (evt.target === this.el || evt.target === this.valueEl) {
        if (evt.shiftKey) {
          evt.preventDefault();
          editor.extendSelectionTo(this);
        }
      }
    });
    this.el.addEventListener("focus", () => editor.onRowFocus(this));

    this.keyInputEl.addEventListener("keydown", (evt) => {
      if (evt.isComposing) return;
      const suggest = this.keySuggest;
      if (suggest?.isOpen) {
        if (evt.key === "Tab" && !evt.shiftKey) {
          // Tab takes the highlighted name (as Enter does) and moves on to the value; the suggester
          // has no Tab key of its own, so the browser used to move focus out of the row.
          evt.preventDefault();
          evt.stopPropagation();
          if (suggest.chooser.hasValues()) suggest.chooser.useSelectedItem(evt);
          else {
            suggest.close();
            if (this.commitKey()) this.widget?.focus(true);
          }
          return;
        }
        return;
      }
      if (evt.key === "Enter" || (evt.key === "Tab" && !evt.shiftKey)) {
        // Tab moves from the name to the value, like Enter; without this the row's
        // own Tab handler moved focus to the next row and the new name was lost.
        evt.preventDefault();
        evt.stopPropagation();
        if (this.commitKey()) this.widget?.focus(true);
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        evt.stopPropagation();
        this.leaveKey();
      } else if (evt.key === "ArrowDown" && evt.altKey) {
        evt.preventDefault();
        editor.opts.onEscapeToEditor?.();
      }
    });
    this.keyInputEl.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (!this.el.isConnected) return;
        if (this.el.contains(this.el.ownerDocument.activeElement)) {
          this.commitKey();
          return;
        }
        this.commitKey(true);
      }, 0);
    });
    if (!editor.opts.readOnly) {
      this.keySuggest = new PropertyKeySuggest(
        editor.app,
        this.keyInputEl,
        () => new Set(editor.rows.filter((r) => r !== this).map((r) => r.entry.key.toLowerCase())),
        () => {
          if (this.commitKey()) this.widget?.focus(true);
        },
        // One Escape closes the list and leaves the name, so the row itself has focus (Mod+Backspace removes it).
        () => this.leaveKey(),
      );
    }
    this.render();
  }

  /** Escape from the name: undo the typed name and focus the row (a new, unnamed row goes away). */
  leaveKey() {
    this.keyInputEl.value = this.entry.key;
    if (this.isNew && !this.entry.key) this.editor.removeRow(this, false);
    else this.el.focus();
  }

  render() {
    const editor = this.editor;
    const { key, value } = this.entry;
    let type: PropertyType | "unknown";
    let mismatch: PropertyType | null = null;
    if (isNestedValue(value)) type = "unknown";
    else {
      const t = key ? typeFor(editor.app, key, value) : "text";
      if (isCompatible(t, value)) type = t;
      else {
        mismatch = t;
        type = typeFor({ metadataTypeManager: null }, key, value);
      }
    }
    this.type = type;
    this.el.setAttr("data-property-key", key);
    this.el.setAttr("data-property-type", type);
    setIcon(this.iconEl, type === "unknown" ? "lucide-braces" : TYPE_INFO[type].icon);
    this.iconEl.setAttr("aria-label", type === "unknown" ? "Nested properties" : TYPE_INFO[type].name);
    this.valueEl.empty();
    this.widget = renderWidget(type, this.valueEl, value, {
      app: editor.app,
      key,
      sourcePath: editor.sourcePath,
      readOnly: editor.opts.readOnly || !key,
      hoverParent: editor.opts.hoverParent,
      onChange: (v) => {
        this.entry.value = v;
        editor.save();
      },
      blur: () => this.el.focus(),
    });
    if (mismatch) {
      const warn = this.valueEl.createDiv({ cls: "metadata-property-warning-icon clickable-icon", attr: { "aria-label": `Type mismatch, expected ${TYPE_INFO[mismatch].name}. Click to update.` } });
      setIcon(warn, "lucide-alert-triangle");
      warn.addEventListener("click", () => {
        this.entry.value = convertValue(mismatch!, this.entry.value);
        editor.save();
        this.render();
      });
    }
  }

  /** Applies the key input. Returns false when the key is invalid. */
  commitKey(leaving = false): boolean {
    const editor = this.editor;
    const next = this.keyInputEl.value.trim();
    if (next === this.entry.key) {
      if (!next && leaving && this.isNew) editor.removeRow(this, false);
      return !!next;
    }
    if (!next) {
      if (leaving) {
        if (this.isNew) editor.removeRow(this, false);
        else this.keyInputEl.value = this.entry.key;
      }
      return false;
    }
    if (editor.rows.some((r) => r !== this && r.entry.key.toLowerCase() === next.toLowerCase())) {
      this.keyInputEl.addClass("is-invalid");
      new Notice(`A property named “${next}” already exists.`);
      if (leaving) {
        this.keyInputEl.value = this.entry.key;
        this.keyInputEl.removeClass("is-invalid");
        if (this.isNew && !this.entry.key) editor.removeRow(this, false);
      }
      return false;
    }
    this.keyInputEl.removeClass("is-invalid");
    const wasNew = this.isNew && !this.entry.key;
    this.entry.key = next;
    this.isNew = false;
    if (wasNew) {
      const type = typeFor(editor.app, next, null);
      this.entry.value = type === "checkbox" ? false : null;
    }
    this.render();
    editor.save();
    return true;
  }
}

export class MetadataEditor extends Component {
  app: any;
  file: TFile | null;
  opts: MetadataEditorOptions;
  onChange: (yaml: string) => void;
  containerEl: HTMLElement;
  headingEl: HTMLElement;
  collapseEl: HTMLElement;
  contentEl: HTMLElement;
  propertiesEl: HTMLElement;
  addButtonEl: HTMLElement;
  errorEl: HTMLElement;
  rows: PropertyRow[] = [];
  selected = new Set<PropertyRow>();
  collapsed: boolean;
  private lastYaml = "";
  private pendingYaml: string | null = null;
  private anchor: PropertyRow | null = null;

  constructor(app: any, parentEl: HTMLElement, file: TFile | null, yaml: string, onChange: (yaml: string) => void, opts: MetadataEditorOptions = {}) {
    super();
    this.app = app;
    this.file = file;
    this.opts = opts;
    this.onChange = onChange;
    registerPropertyWidgets(app);
    if (parentEl.hasClass("metadata-container")) {
      this.containerEl = parentEl;
      this.containerEl.empty();
    } else this.containerEl = parentEl.createDiv({ cls: "metadata-container" });
    this.containerEl.toggleClass("mod-sidebar", !!opts.sidebar);
    this.containerEl.setAttr("tabindex", "-1");
    this.collapsed = !!opts.collapsed;

    this.headingEl = this.containerEl.createDiv({ cls: "metadata-properties-heading", attr: { tabindex: "0" } });
    this.collapseEl = this.headingEl.createDiv({ cls: "collapse-indicator collapse-icon" });
    setIcon(this.collapseEl, "right-triangle");
    this.headingEl.createDiv({ cls: "metadata-properties-title", text: "Properties" });
    this.headingEl.toggle(opts.showHeading !== false);
    this.headingEl.addEventListener("click", () => this.setCollapsed(!this.collapsed, true));
    this.headingEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        this.setCollapsed(!this.collapsed, true);
      } else if (evt.key === "ArrowDown" && !this.collapsed) {
        evt.preventDefault();
        (this.rows[0]?.el ?? this.addButtonEl).focus();
      }
    });
    this.headingEl.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      if (opts.readOnly) return;
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Add file property").setIcon("lucide-plus").onClick(() => this.addProperty()));
      menu.addItem((i) => i.setTitle(this.collapsed ? "Expand" : "Collapse").setIcon("lucide-chevrons-up-down").onClick(() => this.setCollapsed(!this.collapsed, true)));
      menu.showAtMouseEvent(evt);
    });

    this.contentEl = this.containerEl.createDiv({ cls: "metadata-content" });
    this.errorEl = this.contentEl.createDiv({ cls: "metadata-error" });
    this.errorEl.hide();
    this.propertiesEl = this.contentEl.createDiv({ cls: "metadata-properties" });
    this.addButtonEl = this.contentEl.createDiv({ cls: "metadata-add-button text-icon-button", attr: { tabindex: "0" } });
    setIcon(this.addButtonEl.createSpan({ cls: "text-button-icon" }), "lucide-plus");
    this.addButtonEl.createSpan({ cls: "text-button-label", text: "Add property" });
    this.addButtonEl.toggle(!opts.readOnly);
    this.addButtonEl.addEventListener("click", () => this.addProperty());
    this.addButtonEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        this.addProperty();
      } else if (evt.key === "ArrowUp" || (evt.key === "Tab" && evt.shiftKey)) {
        const last = this.rows[this.rows.length - 1];
        if (last) {
          evt.preventDefault();
          last.el.focus();
        }
      } else if (evt.key === "ArrowDown" || (evt.key === "Escape" && !evt.shiftKey)) {
        evt.preventDefault();
        opts.onEscapeToEditor?.();
      }
    });
    this.containerEl.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (this.containerEl.contains(this.containerEl.ownerDocument.activeElement)) return;
        this.clearSelection();
        if (this.pendingYaml !== null) {
          const y = this.pendingYaml;
          this.pendingYaml = null;
          this.update(y);
        }
      }, 0);
    });

    this.applyCollapsed();
    this.setYaml(yaml);
  }

  get sourcePath(): string {
    return this.opts.sourcePath ?? this.file?.path ?? "";
  }

  override onload(): void {
    this.registerEvent(
      this.app.metadataTypeManager?.on?.("changed", () => {
        if (!this.containerEl.isConnected) {
          if (this.wasConnected) this.unload();
          return;
        }
        this.wasConnected = true;
        for (const row of this.rows) {
          if (row.el.contains(row.el.ownerDocument.activeElement)) continue;
          const t = row.entry.key ? typeFor(this.app, row.entry.key, row.entry.value) : "text";
          if (t !== row.type) row.render();
        }
      }) ?? { e: { offref() {} }, name: "", fn: () => {} },
    );
    requestAnimationFrame(() => {
      this.wasConnected = this.containerEl.isConnected;
    });
  }

  private wasConnected = false;

  // ---- data ---------------------------------------------------------------------

  private setYaml(yaml: string) {
    this.lastYaml = normalizeYaml(yaml);
    const { data, error } = parseFrontmatter(yaml);
    this.rows.forEach((r) => r.el.remove());
    this.rows = [];
    this.selected.clear();
    if (error || !data) {
      this.errorEl.empty();
      this.errorEl.show();
      this.errorEl.createDiv({ cls: "metadata-error-title", text: "Syntax error. Your frontmatter is invalid." });
      if (error) this.errorEl.createDiv({ cls: "metadata-error-message", text: error });
      this.containerEl.addClass("mod-error");
      this.propertiesEl.hide();
      this.addButtonEl.hide();
      this.containerEl.setAttr("data-property-count", "0");
      return;
    }
    this.errorEl.hide();
    this.containerEl.removeClass("mod-error");
    this.propertiesEl.show();
    this.addButtonEl.toggle(!this.opts.readOnly);
    for (const [key, value] of Object.entries(data)) this.appendRow({ key, value });
    this.updateCount();
  }

  /** Re-renders from `yaml` unless it is what this editor last emitted, or the user is editing. */
  update(yaml: string) {
    if (normalizeYaml(yaml) === this.lastYaml) return;
    if (this.containerEl.contains(this.containerEl.ownerDocument.activeElement)) {
      this.pendingYaml = yaml;
      return;
    }
    this.setYaml(yaml);
  }

  private appendRow(entry: Entry, index = this.rows.length, isNew = false): PropertyRow {
    const row = new PropertyRow(this, entry, isNew);
    const before = this.rows[index]?.el ?? null;
    this.propertiesEl.insertBefore(row.el, before);
    this.rows.splice(index, 0, row);
    return row;
  }

  private updateCount() {
    this.containerEl.setAttr("data-property-count", String(this.rows.filter((r) => r.entry.key).length));
  }

  toObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.rows) if (r.entry.key) out[r.entry.key] = r.entry.value;
    return out;
  }

  save() {
    if (this.opts.readOnly) return;
    const yaml = dumpFrontmatter(this.toObject());
    this.lastYaml = normalizeYaml(yaml);
    this.updateCount();
    this.onChange(yaml);
  }

  // ---- public handles -------------------------------------------------------------

  setCollapsed(collapsed: boolean, userAction = false) {
    this.collapsed = collapsed;
    this.applyCollapsed();
    if (userAction) this.opts.onCollapse?.(collapsed);
  }

  private applyCollapsed() {
    this.containerEl.toggleClass("is-collapsed", this.collapsed);
    this.collapseEl.toggleClass("is-collapsed", this.collapsed);
  }

  /** Adds an empty property row and focuses its name (or, given a key, its value). */
  addProperty(key?: string) {
    if (this.opts.readOnly || this.containerEl.hasClass("mod-error")) return;
    if (this.collapsed) this.setCollapsed(false, true);
    if (key) {
      const existing = this.rows.find((r) => r.entry.key.toLowerCase() === key.toLowerCase());
      if (existing) {
        existing.widget?.focus(true);
        return;
      }
      const row = this.appendRow({ key, value: null });
      this.save();
      row.widget?.focus(true);
      return;
    }
    const blank = this.rows.find((r) => r.isNew && !r.entry.key);
    if (blank) {
      blank.keyInputEl.focus();
      return;
    }
    const row = this.appendRow({ key: "", value: null }, this.rows.length, true);
    row.keyInputEl.focus();
  }

  focusProperty(key: string, part: "row" | "key" | "value" = "value") {
    const row = this.rows.find((r) => r.entry.key.toLowerCase() === key.toLowerCase());
    if (!row) return;
    if (part === "row") row.el.focus();
    else if (part === "key") row.keyInputEl.focus();
    else row.widget?.focus(true);
  }

  removeRow(row: PropertyRow, save = true) {
    const i = this.rows.indexOf(row);
    if (i === -1) return;
    const hadFocus = row.el.contains(row.el.ownerDocument.activeElement);
    this.rows.splice(i, 1);
    this.selected.delete(row);
    row.el.remove();
    if (save && row.entry.key) this.save();
    this.updateCount();
    if (hadFocus) (this.rows[Math.min(i, this.rows.length - 1)]?.el ?? this.addButtonEl).focus();
  }

  // ---- selection & keyboard -----------------------------------------------------------

  onRowFocus(row: PropertyRow) {
    if (!this.selected.has(row)) {
      this.clearSelection();
      this.selected.add(row);
      row.el.addClass("is-selected");
      this.anchor = row;
    }
  }

  clearSelection() {
    for (const r of this.selected) r.el.removeClass("is-selected");
    this.selected.clear();
  }

  extendSelectionTo(row: PropertyRow) {
    const anchor = this.anchor && this.rows.includes(this.anchor) ? this.anchor : row;
    const a = this.rows.indexOf(anchor);
    const b = this.rows.indexOf(row);
    this.clearSelection();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      const r = this.rows[i]!;
      this.selected.add(r);
      r.el.addClass("is-selected");
    }
    this.anchor = anchor;
    row.el.focus({ preventScroll: false });
    // focus() would reset the selection through onRowFocus; restore it.
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      this.selected.add(this.rows[i]!);
      this.rows[i]!.el.addClass("is-selected");
    }
  }

  onRowKey(row: PropertyRow, evt: KeyboardEvent) {
    if (evt.target !== row.el || evt.isComposing) return;
    const i = this.rows.indexOf(row);
    const mod = evt.ctrlKey || evt.metaKey;
    const vim = !!this.app.isVimEnabled?.();
    const key = evt.key;
    const go = (j: number) => {
      const target = this.rows[j];
      if (target) target.el.focus();
      else if (j >= this.rows.length) this.addButtonEl.focus();
      else this.headingEl.isShown() ? this.headingEl.focus() : undefined;
    };
    if (key === "ArrowDown" && evt.altKey) {
      evt.preventDefault();
      this.opts.onEscapeToEditor?.();
    } else if ((key === "ArrowDown" || (vim && key === "j")) && evt.shiftKey && !mod) {
      evt.preventDefault();
      const next = this.rows[i + 1];
      if (next) this.extendSelectionTo(next);
    } else if ((key === "ArrowUp" || (vim && key === "k")) && evt.shiftKey && !mod) {
      evt.preventDefault();
      const prev = this.rows[i - 1];
      if (prev) this.extendSelectionTo(prev);
    } else if (key === "ArrowDown" || (key === "Tab" && !evt.shiftKey) || (vim && key === "j")) {
      evt.preventDefault();
      go(i + 1);
    } else if (key === "ArrowUp" || (key === "Tab" && evt.shiftKey) || (vim && key === "k")) {
      evt.preventDefault();
      go(i - 1);
    } else if (key === "ArrowLeft" || (vim && key === "h")) {
      evt.preventDefault();
      row.keyInputEl.focus();
      row.keyInputEl.select();
    } else if (key === "ArrowRight" || key === "Enter" || (vim && (key === "l" || key === "A"))) {
      evt.preventDefault();
      row.widget?.focus(true);
    } else if (vim && key === "i") {
      evt.preventDefault();
      row.widget?.focus(false);
    } else if (vim && key === "o") {
      evt.preventDefault();
      this.addProperty();
    } else if (key === "Escape") {
      evt.preventDefault();
      this.clearSelection();
      this.selected.add(row);
      row.el.addClass("is-selected");
    } else if (mod && (key === "a" || key === "A")) {
      evt.preventDefault();
      this.clearSelection();
      for (const r of this.rows) {
        this.selected.add(r);
        r.el.addClass("is-selected");
      }
    } else if ((mod && key === "Backspace") || key === "Delete" || (key === "Backspace" && !mod)) {
      if (this.opts.readOnly) return;
      evt.preventDefault();
      this.removeRows(this.selectedRows(row));
    } else if (mod && (key === "c" || key === "C")) {
      evt.preventDefault();
      void this.copyRows(this.selectedRows(row), false);
    } else if (mod && (key === "x" || key === "X")) {
      evt.preventDefault();
      void this.copyRows(this.selectedRows(row), true);
    } else if (mod && (key === "v" || key === "V")) {
      evt.preventDefault();
      void this.paste(i + 1);
    }
  }

  private selectedRows(fallback: PropertyRow): PropertyRow[] {
    const rows = this.rows.filter((r) => this.selected.has(r));
    return rows.length ? rows : [fallback];
  }

  removeRows(rows: PropertyRow[]) {
    const first = this.rows.indexOf(rows[0]!);
    for (const r of rows) {
      const i = this.rows.indexOf(r);
      if (i !== -1) this.rows.splice(i, 1);
      this.selected.delete(r);
      r.el.remove();
    }
    this.save();
    (this.rows[Math.min(first, this.rows.length - 1)]?.el ?? this.addButtonEl).focus();
  }

  async copyRows(rows: PropertyRow[], cut: boolean) {
    const data: Record<string, unknown> = {};
    for (const r of rows) if (r.entry.key) data[r.entry.key] = r.entry.value;
    const yaml = dumpFrontmatter(data);
    HISTORY.unshift(yaml);
    HISTORY.length = Math.min(HISTORY.length, 5);
    try {
      await navigator.clipboard.writeText(yaml);
    } catch {
      /* clipboard can be blocked; the in-memory copy still works for paste */
    }
    if (cut && !this.opts.readOnly) this.removeRows(rows);
  }

  async paste(index: number) {
    if (this.opts.readOnly) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = HISTORY[0] ?? "";
    }
    const { data } = parseFrontmatter(text);
    if (!data || !Object.keys(data).length) {
      new Notice("The clipboard does not contain properties.");
      return;
    }
    let at = index;
    for (const [key, value] of Object.entries(data)) {
      const existing = this.rows.find((r) => r.entry.key.toLowerCase() === key.toLowerCase());
      if (existing) {
        existing.entry.value = value;
        existing.render();
      } else this.appendRow({ key, value }, at++);
    }
    this.save();
  }

  // ---- menus ---------------------------------------------------------------------------

  showRowMenu(row: PropertyRow, evt: MouseEvent) {
    const menu = new Menu();
    const key = row.entry.key;
    const readOnly = !!this.opts.readOnly;
    if (key && !readOnly) {
      menu.addItem((item) => {
        item.setSection("selection").setTitle("Property type").setIcon(row.type === "unknown" ? "lucide-file-question" : TYPE_INFO[row.type].icon);
        const sub = item.setSubmenu();
        const reserved = RESERVED_KEYS[key.toLowerCase()];
        const types: PropertyType[] = reserved === "tags" || reserved === "aliases" ? [reserved] : USER_TYPES;
        for (const t of types) {
          sub.addItem((s) =>
            s
              .setTitle(TYPE_INFO[t].name)
              .setIcon(TYPE_INFO[t].icon)
              .setChecked(row.type === t)
              .setDisabled(!!reserved)
              .onClick(() => this.changeType(row, t)),
          );
        }
      });
    }
    menu.addItem((i) => i.setSection("clipboard").setTitle("Cut").setIcon("lucide-scissors").setDisabled(readOnly || !key).onClick(() => void this.copyRows(this.selectedRows(row), true)));
    menu.addItem((i) => i.setSection("clipboard").setTitle("Copy").setIcon("lucide-copy").setDisabled(!key).onClick(() => void this.copyRows(this.selectedRows(row), false)));
    menu.addItem((i) => i.setSection("clipboard").setTitle("Paste").setIcon("lucide-clipboard-paste").setDisabled(readOnly).onClick(() => void this.paste(this.rows.indexOf(row) + 1)));
    if (!readOnly) menu.addItem((i) => i.setSection("danger").setTitle("Remove").setIcon("lucide-trash-2").setWarning(true).onClick(() => this.removeRows(this.selectedRows(row))));
    this.app.workspace.trigger("property-menu", menu, key, row.entry.value, this.file);
    menu.showAtMouseEvent(evt);
  }

  changeType(row: PropertyRow, type: PropertyType) {
    const apply = () => {
      this.app.metadataTypeManager?.setType?.(row.entry.key, type);
      if (!isCompatible(type, row.entry.value)) {
        row.entry.value = convertValue(type, row.entry.value);
        this.save();
      }
      row.render();
    };
    if (isCompatible(type, row.entry.value)) {
      apply();
      return;
    }
    const old = row.type === "unknown" ? "Unknown" : TYPE_INFO[row.type].name;
    const modal = new ConfirmationModal(this.app);
    modal.setTitle(`Display as ${TYPE_INFO[type].name.toLowerCase()}?`);
    modal.setContent(`Your ${old.toLowerCase()} data is not compatible. It will be adapted to fit the new format.`);
    modal.addButton((b) => b.setButtonText("Update").setCta().onClick(() => apply()));
    modal.addCancelButton();
    modal.open();
  }
}

function normalizeYaml(yaml: string): string {
  return yaml.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

const collapsedByPath = new Map<string, boolean>();

export function renderMetadataEditor(
  app: any,
  containerEl: HTMLElement,
  file: TFile | null,
  frontmatterYaml: string,
  onChange: (newYaml: string) => void,
  opts: MetadataEditorOptions = {},
): MetadataEditor {
  // A host that re-renders into the same element replaces the previous editor.
  const holder = containerEl as HTMLElement & { __metadataEditor?: MetadataEditor };
  holder.__metadataEditor?.unload();
  const key = file?.path ?? "";
  const options: MetadataEditorOptions = {
    ...opts,
    collapsed: opts.collapsed ?? collapsedByPath.get(key) ?? false,
    onCollapse: (c) => {
      if (key) collapsedByPath.set(key, c);
      opts.onCollapse?.(c);
    },
  };
  const editor = new MetadataEditor(app, containerEl, file, frontmatterYaml, onChange, options);
  holder.__metadataEditor = editor;
  if (opts.component) opts.component.addChild(editor);
  else editor.load();
  return editor;
}

// The Markdown view (Live Preview and Reading view) draws properties through this.
setMetadataEditorRenderer(renderMetadataEditor);

/**
 * Replaces the frontmatter of `text` with `yaml` (removing it when empty).
 * Used by views that edit a file they do not have open in an editor.
 */
export function replaceFrontmatter(text: string, yaml: string): string {
  const m = /^---\r?\n([\s\S]*?)(?:\r?\n)?(?:---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text);
  const body = yaml.replace(/\n+$/, "");
  if (m) {
    const rest = text.slice(m[0].length);
    return body ? `---\n${body}\n---\n${rest}` : rest;
  }
  return body ? `---\n${body}\n---\n${text}` : text;
}

/** The YAML body of a note's frontmatter ("" when none). */
export function frontmatterYamlOf(text: string): { yaml: string; exists: boolean } {
  const m = /^---\r?\n([\s\S]*?)(?:\r?\n)?(?:---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return { yaml: "", exists: false };
  return { yaml: m[1] ?? "", exists: true };
}
