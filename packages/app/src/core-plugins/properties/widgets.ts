/**
 * Property value widgets, one per type. Each renders into a
 * `.metadata-property-value` element and reports edits through `ctx.onChange`.
 * They are also published as `app.metadataTypeManager.registeredTypeWidgets`
 * (`{ type, icon, name(), validate(value), render(el, data, ctx) }`), which
 * plugins use to draw property inputs of their own.
 */
import { setIcon } from "../../obsidian/ui/icons";
import { moment, parseLinktext } from "../../obsidian/util";
import { caretOffset, LinkValueSuggest, ListValueSuggest, setCaret } from "./suggests";
import { convertValue, isValidTag, TYPE_INFO, type PropertyType } from "./types";

export interface WidgetContext {
  app: any;
  key: string;
  sourcePath: string;
  onChange(value: unknown): void;
  /** Leave the widget (Escape): the editor focuses the property row. */
  blur(): void;
  readOnly?: boolean;
  hoverParent?: { hoverPopover: any } | null;
}

export interface WidgetHandle {
  focus(atEnd?: boolean): void;
  /** The element keyboard focus lands on. */
  inputEl: HTMLElement;
}

const LINK_RE = /\[\[([^\]]+?)\]\]|\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"']+)/g;

function setEditable(el: HTMLElement, editable: boolean) {
  if (!editable) {
    el.setAttr("contenteditable", "false");
    return;
  }
  try {
    el.contentEditable = "plaintext-only";
    if (el.contentEditable !== "plaintext-only") el.contentEditable = "true";
  } catch {
    el.contentEditable = "true";
  }
}

function plainPaste(el: HTMLElement) {
  el.addEventListener("paste", (evt) => {
    const text = evt.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    evt.preventDefault();
    const clean = text.replace(/\r?\n/g, " ");
    const doc = el.ownerDocument;
    const sel = doc.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(doc.createTextNode(clean));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function openLink(app: any, linktext: string, sourcePath: string, evt: MouseEvent) {
  const newLeaf = evt.ctrlKey || evt.metaKey ? (evt.altKey ? "split" : "tab") : false;
  void app.workspace.openLinkText(linktext, sourcePath, newLeaf);
}

/** Renders `text` with `[[links]]`, `[md](links)` and URLs as clickable anchors. */
export function renderLinkedText(app: any, el: HTMLElement, text: string, sourcePath: string, hoverParent?: { hoverPopover: any } | null) {
  el.empty();
  let pos = 0;
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text))) {
    if (m.index > pos) el.appendText(text.slice(pos, m.index));
    if (m[1] !== undefined) {
      const inner = m[1];
      const bar = inner.indexOf("|");
      const target = bar === -1 ? inner : inner.slice(0, bar);
      const display = bar === -1 ? inner : inner.slice(bar + 1);
      const { path } = parseLinktext(target);
      const a = el.createEl("a", { cls: "internal-link", text: display, attr: { "data-href": target, href: target } });
      if (path && !app.metadataCache.getFirstLinkpathDest(path, sourcePath)) a.addClass("is-unresolved");
      wireInternalLink(app, a, target, sourcePath, hoverParent);
    } else if (m[3] !== undefined) {
      const href = m[3];
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        const a = el.createEl("a", { cls: "external-link", text: m[2] || href, attr: { href, target: "_blank", rel: "noopener nofollow" } });
        wireExternalLink(a, href);
      } else {
        const target = decodeURI(href);
        const a = el.createEl("a", { cls: "internal-link", text: m[2] || target, attr: { "data-href": target, href: target } });
        wireInternalLink(app, a, target, sourcePath, hoverParent);
      }
    } else if (m[4] !== undefined) {
      const a = el.createEl("a", { cls: "external-link", text: m[4], attr: { href: m[4], target: "_blank", rel: "noopener nofollow" } });
      wireExternalLink(a, m[4]);
    }
    pos = m.index + m[0].length;
  }
  if (pos < text.length) el.appendText(text.slice(pos));
}

function wireInternalLink(app: any, a: HTMLElement, target: string, sourcePath: string, hoverParent?: { hoverPopover: any } | null) {
  a.addEventListener("mousedown", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
  });
  a.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    openLink(app, target, sourcePath, evt);
  });
  a.addEventListener("mouseover", (evt) => {
    app.workspace.trigger("hover-link", { event: evt, source: "preview", hoverParent: hoverParent ?? { hoverPopover: null }, targetEl: a, linktext: target, sourcePath });
  });
}

function wireExternalLink(a: HTMLElement, href: string) {
  a.addEventListener("mousedown", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
  });
  a.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    window.open(href, "_blank", "noopener");
  });
}

// ---- text --------------------------------------------------------------------

export function renderTextWidget(el: HTMLElement, value: unknown, ctx: WidgetContext): WidgetHandle {
  const app = ctx.app;
  const raw = () => (value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
  const linkEl = el.createDiv({ cls: "metadata-link" });
  const linkInner = linkEl.createDiv({ cls: "metadata-link-inner" });
  const linkFlair = linkEl.createDiv({ cls: "metadata-link-flair clickable-icon", attr: { "aria-label": "Edit" } });
  setIcon(linkFlair, "lucide-pencil");
  const input = el.createDiv({ cls: "metadata-input-longtext mod-truncate", attr: { placeholder: "Empty", "data-placeholder": "Empty", tabindex: "0", spellcheck: "true" } });
  setEditable(input, !ctx.readOnly);
  plainPaste(input);
  let editing = false;
  let committed = raw();

  const display = () => {
    const text = raw();
    const single = /^\s*\[\[([^\]]+)\]\]\s*$/.exec(text) ?? /^\s*(https?:\/\/\S+)\s*$/.exec(text);
    if (single && !editing) {
      linkEl.show();
      input.hide();
      linkInner.empty();
      const isUrl = /^https?:/.test(single[1]!);
      linkInner.className = `metadata-link-inner ${isUrl ? "external-link" : "internal-link"}`;
      if (isUrl) {
        linkInner.setText(single[1]!);
        linkInner.onclick = (evt) => {
          evt.preventDefault();
          window.open(single[1]!, "_blank", "noopener");
        };
        linkInner.onmouseover = null;
      } else {
        const inner = single[1]!;
        const bar = inner.indexOf("|");
        const target = bar === -1 ? inner : inner.slice(0, bar);
        linkInner.setText(bar === -1 ? inner : inner.slice(bar + 1));
        const { path } = parseLinktext(target);
        linkInner.toggleClass("is-unresolved", !!path && !app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath));
        linkInner.onclick = (evt) => {
          evt.preventDefault();
          openLink(app, target, ctx.sourcePath, evt);
        };
        linkInner.onmouseover = (evt) =>
          app.workspace.trigger("hover-link", { event: evt, source: "preview", hoverParent: ctx.hoverParent ?? { hoverPopover: null }, targetEl: linkInner, linktext: target, sourcePath: ctx.sourcePath });
      }
      return;
    }
    linkEl.hide();
    input.show();
    if (editing) return;
    if (LINK_RE.test(text)) renderLinkedText(app, input, text, ctx.sourcePath, ctx.hoverParent);
    else input.setText(text);
    LINK_RE.lastIndex = 0;
  };

  const commit = () => {
    const text = (input.textContent ?? "").replace(/\r?\n/g, " ");
    if (text === committed) return;
    committed = text;
    value = text;
    ctx.onChange(text === "" ? null : text);
  };
  let timer: number | null = null;
  input.addEventListener("focus", () => {
    if (editing || ctx.readOnly) return;
    editing = true;
    const text = raw();
    if (input.textContent !== text) {
      input.setText(text);
      setCaret(input, text.length);
    }
  });
  input.addEventListener("input", () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      value = input.textContent ?? "";
      commit();
    }, 500);
  });
  input.addEventListener("blur", () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    value = input.textContent ?? "";
    commit();
    editing = false;
    display();
  });
  input.addEventListener("keydown", (evt) => {
    if (evt.isComposing) return;
    if (evt.key === "Enter" && !suggest.isOpen) {
      evt.preventDefault();
      ctx.blur();
    } else if (evt.key === "Escape" && !suggest.isOpen) {
      evt.preventDefault();
      evt.stopPropagation();
      ctx.blur();
    }
  });
  linkFlair.addEventListener("click", (evt) => {
    evt.preventDefault();
    editing = true;
    linkEl.hide();
    input.show();
    input.setText(raw());
    input.focus();
    setCaret(input, raw().length);
  });
  linkEl.addEventListener("dblclick", () => linkFlair.click());
  const suggest = new LinkValueSuggest(app, input, () => ctx.sourcePath);
  display();
  return {
    inputEl: input,
    focus(atEnd = true) {
      if (!input.isShown()) {
        linkFlair.click();
        return;
      }
      input.focus();
      if (atEnd) setCaret(input, (input.textContent ?? "").length);
      else setCaret(input, 0);
    },
  };
}

// ---- lists (multitext, tags, aliases) -------------------------------------------

export function renderListWidget(el: HTMLElement, value: unknown, ctx: WidgetContext, type: PropertyType): WidgetHandle {
  const app = ctx.app;
  let items: string[] = (convertValue(type, value) as string[] | null) ?? [];
  const container = el.createDiv({ cls: "multi-select-container", attr: { tabindex: "-1" } });
  const input = container.createDiv({ cls: "multi-select-input", attr: { tabindex: "0", placeholder: "Empty", "data-placeholder": "Empty" } });
  setEditable(input, !ctx.readOnly);
  plainPaste(input);
  const isTags = type === "tags";

  const save = () => {
    ctx.onChange(items.length ? items.slice() : null);
  };

  const pills = (): HTMLElement[] => container.findAll(".multi-select-pill") as HTMLElement[];

  const render = () => {
    for (const p of pills()) p.remove();
    items.forEach((item, i) => {
      const pill = createDiv({ cls: "multi-select-pill", attr: { tabindex: "0", "data-index": String(i) } });
      if (isTags) {
        pill.addClass("tag");
        if (!isValidTag(item)) pill.addClass("is-invalid");
      }
      const content = pill.createDiv({ cls: "multi-select-pill-content" });
      if (/\[\[|\]\(|https?:\/\//.test(item)) renderLinkedText(app, content, item, ctx.sourcePath, ctx.hoverParent);
      else content.createSpan({ text: item });
      if (!ctx.readOnly) {
        const remove = pill.createDiv({ cls: "multi-select-pill-remove-button", attr: { "aria-label": "Remove" } });
        setIcon(remove, "lucide-x");
        remove.addEventListener("mousedown", (evt) => evt.preventDefault());
        remove.addEventListener("click", (evt) => {
          evt.stopPropagation();
          removeAt(i, false);
        });
      }
      content.addEventListener("click", (evt) => {
        if ((evt.target as HTMLElement).closest("a")) return;
        if (isTags && !ctx.readOnly && evt.detail === 1) {
          const search = app.internalPlugins?.getEnabledPluginById?.("global-search");
          if (search?.openGlobalSearch && (evt.ctrlKey || evt.metaKey)) {
            search.openGlobalSearch(`tag:#${item}`);
            return;
          }
        }
      });
      pill.addEventListener("dblclick", () => editAt(i));
      pill.addEventListener("keydown", (evt) => onPillKey(evt, i));
      pill.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void import("../../obsidian/ui/menu").then(({ Menu }) => {
          const menu = new Menu();
          if (!ctx.readOnly) menu.addItem((it) => it.setTitle("Edit").setIcon("lucide-pencil").onClick(() => editAt(i)));
          menu.addItem((it) => it.setTitle("Copy").setIcon("lucide-copy").onClick(() => void navigator.clipboard.writeText(item)));
          if (isTags) {
            menu.addItem((it) =>
              it
                .setTitle("Search tag")
                .setIcon("lucide-search")
                .onClick(() => app.internalPlugins?.getEnabledPluginById?.("global-search")?.openGlobalSearch?.(`tag:#${item}`)),
            );
          }
          if (!ctx.readOnly) menu.addItem((it) => it.setTitle("Remove").setIcon("lucide-trash-2").setWarning(true).onClick(() => removeAt(i, false)));
          menu.showAtMouseEvent(evt);
        });
      });
      container.insertBefore(pill, input);
    });
  };

  const removeAt = (i: number, focusPrev: boolean) => {
    items.splice(i, 1);
    render();
    save();
    const ps = pills();
    if (focusPrev && ps.length) ps[Math.max(0, i - 1)]!.focus();
    else input.focus();
  };

  const editAt = (i: number) => {
    if (ctx.readOnly) return;
    const text = items[i]!;
    items.splice(i, 1);
    render();
    save();
    input.setText(text);
    input.focus();
    setCaret(input, text.length);
  };

  const addFromInput = (): boolean => {
    const text = (input.textContent ?? "").trim();
    if (!text) return false;
    const parts = isTags ? text.split(/[\s,]+/) : [text];
    for (let p of parts) {
      if (isTags) p = p.replace(/^#/, "");
      if (p) items.push(p);
    }
    input.setText("");
    render();
    save();
    return true;
  };

  const onPillKey = (evt: KeyboardEvent, i: number) => {
    const ps = pills();
    if (evt.key === "Backspace" || evt.key === "Delete") {
      if (ctx.readOnly) return;
      evt.preventDefault();
      removeAt(i, evt.key === "Backspace");
    } else if (evt.key === "ArrowLeft") {
      evt.preventDefault();
      ps[Math.max(0, i - 1)]?.focus();
    } else if (evt.key === "ArrowRight") {
      evt.preventDefault();
      if (i + 1 < ps.length) ps[i + 1]!.focus();
      else input.focus();
    } else if (evt.key === "Enter") {
      evt.preventDefault();
      editAt(i);
    } else if (evt.key === "Escape") {
      evt.preventDefault();
      evt.stopPropagation();
      ctx.blur();
    }
  };

  input.addEventListener("keydown", (evt) => {
    if (evt.isComposing) return;
    const suggesting = linkSuggest.isOpen || valueSuggest.isOpen;
    if (evt.key === "Enter" && !suggesting) {
      evt.preventDefault();
      if (!addFromInput()) ctx.blur();
    } else if (isTags && (evt.key === "," || evt.key === " ") && !suggesting) {
      evt.preventDefault();
      addFromInput();
    } else if ((evt.key === "Backspace" || evt.key === "ArrowLeft") && caretOffset(input) === 0 && !(window.getSelection()?.toString())) {
      const ps = pills();
      if (ps.length) {
        evt.preventDefault();
        ps[ps.length - 1]!.focus();
      }
    } else if (evt.key === "Escape" && !suggesting) {
      evt.preventDefault();
      evt.stopPropagation();
      input.setText("");
      ctx.blur();
    }
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (input.ownerDocument.activeElement !== input) addFromInput();
    }, 0);
  });
  input.addEventListener("paste", (evt) => {
    const text = evt.clipboardData?.getData("text/plain");
    if (!text || !/\n/.test(text)) return;
    evt.preventDefault();
    evt.stopImmediatePropagation();
    for (const line of text.split(/\r?\n/)) {
      const t = line.replace(/^\s*[-*]\s+/, "").trim();
      if (t) items.push(isTags ? t.replace(/^#/, "") : t);
    }
    render();
    save();
  }, true);
  container.addEventListener("mousedown", (evt) => {
    if (evt.target === container) {
      evt.preventDefault();
      input.focus();
      setCaret(input, (input.textContent ?? "").length);
    }
  });

  const linkSuggest = new LinkValueSuggest(app, input, () => ctx.sourcePath);
  const valueSuggest = new ListValueSuggest(
    app,
    input,
    () => {
      if (type === "aliases") return [];
      const existing = new Set(items.map((i) => i.toLowerCase()));
      const source: string[] = isTags
        ? Object.keys(app.metadataCache.getTags?.() ?? {}).map((t) => t.replace(/^#/, ""))
        : (app.metadataCache.getFrontmatterPropertyValuesForKey?.(ctx.key) ?? []);
      return Array.from(new Set(source)).filter((v) => !existing.has(v.toLowerCase()));
    },
    (v) => {
      input.setText(v);
      addFromInput();
      input.focus();
    },
  );
  render();
  return {
    inputEl: input,
    focus() {
      input.focus();
      setCaret(input, (input.textContent ?? "").length);
    },
  };
}

// ---- number, checkbox, date, datetime ------------------------------------------------

export function renderNumberWidget(el: HTMLElement, value: unknown, ctx: WidgetContext): WidgetHandle {
  const n = convertValue("number", value) as number | null;
  const input = el.createEl("input", { cls: "metadata-input metadata-input-number", type: "number", attr: { step: "any", placeholder: "Empty" } });
  input.value = n === null ? "" : String(n);
  input.disabled = !!ctx.readOnly;
  let last = input.value;
  const commit = () => {
    const v = input.value.trim();
    if (v === last) return;
    if (v === "") {
      last = v;
      input.removeClass("is-invalid");
      ctx.onChange(null);
      return;
    }
    const num = Number(v);
    if (!Number.isFinite(num)) {
      input.addClass("is-invalid");
      input.setAttr("aria-label", "Invalid number");
      return;
    }
    input.removeClass("is-invalid");
    last = v;
    ctx.onChange(num);
  };
  input.addEventListener("input", () => input.toggleClass("is-invalid", input.value.trim() !== "" && !Number.isFinite(Number(input.value)) || input.validity.badInput));
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === "Escape") {
      evt.preventDefault();
      evt.stopPropagation();
      commit();
      ctx.blur();
    }
  });
  return { inputEl: input, focus: () => input.focus() };
}

export function renderCheckboxWidget(el: HTMLElement, value: unknown, ctx: WidgetContext): WidgetHandle {
  const v = convertValue("checkbox", value) as boolean | null;
  const input = el.createEl("input", { cls: "metadata-input-checkbox", type: "checkbox" });
  input.checked = v === true;
  input.indeterminate = v === null;
  input.disabled = !!ctx.readOnly;
  input.addEventListener("change", () => {
    input.indeterminate = false;
    ctx.onChange(input.checked);
  });
  input.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      input.click();
    } else if (evt.key === "Escape") {
      evt.preventDefault();
      evt.stopPropagation();
      ctx.blur();
    }
  });
  return { inputEl: input, focus: () => input.focus() };
}

export function renderDateWidget(el: HTMLElement, value: unknown, ctx: WidgetContext, withTime: boolean): WidgetHandle {
  const v = convertValue(withTime ? "datetime" : "date", value) as string | null;
  const input = el.createEl("input", {
    cls: `metadata-input metadata-input-text ${withTime ? "mod-datetime" : "mod-date"}`,
    type: withTime ? "datetime-local" : "date",
    attr: { max: withTime ? "9999-12-31T23:59:59" : "9999-12-31", placeholder: "Empty", ...(withTime ? { step: "1" } : {}) },
  });
  input.value = v ? (withTime ? v.replace(/(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/, "").slice(0, 19) : v) : "";
  input.disabled = !!ctx.readOnly;
  let last = input.value;
  const commit = () => {
    let val = input.value;
    if (val === last) return;
    last = val;
    if (withTime && /T\d{2}:\d{2}$/.test(val)) val += ":00";
    ctx.onChange(val === "" ? null : val);
    updateLink();
  };
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === "Escape") {
      evt.preventDefault();
      evt.stopPropagation();
      commit();
      ctx.blur();
    }
  });
  // With Daily notes on, a date links to that day's note.
  const daily = ctx.app.internalPlugins?.getEnabledPluginById?.("daily-notes");
  let linkEl: HTMLElement | null = null;
  const updateLink = () => {
    if (!daily) return;
    const date = input.value ? moment(input.value.slice(0, 10), "YYYY-MM-DD", true) : null;
    if (!linkEl) {
      linkEl = el.createDiv({ cls: "clickable-icon metadata-input-date-link", attr: { "aria-label": "Open daily note" } });
      // Not a calendar: the browser already draws its date-picker icon beside the field.
      setIcon(linkEl, "lucide-file-symlink");
      linkEl.addEventListener("click", (evt) => {
        const d = input.value ? moment(input.value.slice(0, 10), "YYYY-MM-DD", true) : null;
        if (!d?.isValid()) return;
        const format = daily.options?.format || "YYYY-MM-DD";
        const folder = String(daily.options?.folder ?? "").replace(/^\/+|\/+$/g, "");
        const name = d.format(format);
        openLink(ctx.app, folder ? `${folder}/${name}` : name, ctx.sourcePath, evt);
      });
    }
    linkEl.toggle(!!date?.isValid());
  };
  updateLink();
  return { inputEl: input, focus: () => input.focus() };
}

/** Objects, and lists that hold objects or lists: shown by the nested editor. */
export function isNestedValue(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (!Array.isArray(value)) return true;
  return value.some((v) => v !== null && typeof v === "object");
}

/** A scalar typed into the nested editor, read the way YAML would read it. */
export function parseNestedScalar(text: string, previous: unknown): unknown {
  const t = text.trim();
  if (typeof previous === "string") return text;
  if (t === "") return null;
  if (t === "true" || t === "false") return t === "true";
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (t === "null" || t === "~") return null;
  return text;
}

function scalarText(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

const nestedCollapsed = new WeakMap<object, Set<string>>();

/**
 * Nested properties (YAML objects and lists of objects): a collapsible tree of
 * key/value rows. Scalars edit in place and keep their YAML type (a number
 * stays a number); keys can be renamed, added and removed. Every edit writes
 * the whole value back, so shapes the editor does not draw are kept as they are.
 */
export function renderUnknownWidget(el: HTMLElement, value: unknown, ctx: WidgetContext): WidgetHandle {
  let data: unknown = value === undefined ? null : structuredCloneSafe(value);
  const root = el.createDiv({ cls: "vault-nested-property", attr: { tabindex: "-1" } });
  const collapsed = nestedCollapsed.get(ctx as object) ?? new Set<string>();
  nestedCollapsed.set(ctx as object, collapsed);
  let firstInput: HTMLElement | null = null;

  const commit = () => ctx.onChange(structuredCloneSafe(data));

  const setAt = (path: (string | number)[], v: unknown) => {
    if (!path.length) {
      data = v;
      return;
    }
    let cur: any = data;
    for (const k of path.slice(0, -1)) cur = cur[k];
    cur[path[path.length - 1]!] = v;
  };
  const getAt = (path: (string | number)[]): any => path.reduce((cur: any, k) => (cur === null || cur === undefined ? cur : cur[k]), data);

  const render = () => {
    root.empty();
    firstInput = null;
    renderNode(root, data, []);
  };

  const renderNode = (parent: HTMLElement, node: unknown, path: (string | number)[]) => {
    const isArray = Array.isArray(node);
    const obj = node as Record<string, unknown>;
    const entries: [string | number, unknown][] = isArray ? (node as unknown[]).map((v, i) => [i, v]) : Object.entries(obj ?? {});
    const pathKey = JSON.stringify(path);
    const box = parent.createDiv({ cls: "vault-nested-children" + (isArray ? " mod-list" : " mod-object") });
    const summary = box.createDiv({ cls: "vault-nested-summary is-clickable" });
    const icon = summary.createDiv({ cls: "collapse-icon" });
    setIcon(icon, "right-triangle");
    summary.createSpan({ cls: "vault-nested-count", text: isArray ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : `${entries.length} key${entries.length === 1 ? "" : "s"}` });
    const isCollapsed = collapsed.has(pathKey);
    box.toggleClass("is-collapsed", isCollapsed);
    icon.toggleClass("is-collapsed", isCollapsed);
    summary.addEventListener("click", () => {
      if (collapsed.has(pathKey)) collapsed.delete(pathKey);
      else collapsed.add(pathKey);
      render();
    });
    if (isCollapsed) return;
    const rows = box.createDiv({ cls: "vault-nested-rows" });
    for (const [k, v] of entries) {
      const row = rows.createDiv({ cls: "vault-nested-row", attr: { "data-key": String(k) } });
      const childPath = [...path, k];
      if (isArray) row.createSpan({ cls: "vault-nested-index", text: "-" });
      else {
        const keyInput = row.createEl("input", { cls: "vault-nested-key", type: "text", attr: { spellcheck: "false", "aria-label": "Key" } });
        keyInput.value = String(k);
        keyInput.disabled = !!ctx.readOnly;
        firstInput ??= keyInput;
        const commitKey = () => {
          const next = keyInput.value.trim();
          if (next === k) return;
          const current = getAt(path) as Record<string, unknown>;
          if (!next || Object.prototype.hasOwnProperty.call(current, next)) {
            keyInput.value = String(k);
            keyInput.toggleClass("is-invalid", !!next);
            return;
          }
          const rebuilt: Record<string, unknown> = {};
          for (const [kk, vv] of Object.entries(current)) rebuilt[kk === k ? next : kk] = vv;
          setAt(path, rebuilt);
          commit();
          render();
        };
        keyInput.addEventListener("change", commitKey);
        keyInput.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter" && !evt.isComposing) {
            evt.preventDefault();
            commitKey();
          } else if (evt.key === "Escape") {
            evt.preventDefault();
            evt.stopPropagation();
            keyInput.value = String(k);
            ctx.blur();
          }
        });
      }
      const valueEl = row.createDiv({ cls: "vault-nested-value" });
      if (v !== null && typeof v === "object") {
        renderNode(valueEl, v, childPath);
      } else {
        const input = valueEl.createEl("input", { cls: "vault-nested-input", type: "text", attr: { spellcheck: "false", placeholder: "Empty", "aria-label": "Value" } });
        input.value = scalarText(v);
        input.disabled = !!ctx.readOnly;
        input.setAttr("data-value-type", v === null ? "null" : typeof v);
        firstInput ??= input;
        const commitValue = () => {
          const previous = getAt(childPath);
          const next = parseNestedScalar(input.value, previous);
          if (next === previous) return;
          setAt(childPath, next);
          input.setAttr("data-value-type", next === null ? "null" : typeof next);
          commit();
        };
        input.addEventListener("change", commitValue);
        input.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter" && !evt.isComposing) {
            evt.preventDefault();
            commitValue();
          } else if (evt.key === "Escape") {
            evt.preventDefault();
            evt.stopPropagation();
            commitValue();
            ctx.blur();
          }
        });
      }
      if (!ctx.readOnly) {
        const remove = row.createDiv({ cls: "clickable-icon vault-nested-remove", attr: { "aria-label": isArray ? "Remove item" : "Remove key" } });
        setIcon(remove, "lucide-x");
        remove.addEventListener("click", () => {
          const current = getAt(path);
          if (Array.isArray(current)) current.splice(k as number, 1);
          else delete (current as Record<string, unknown>)[k as string];
          commit();
          render();
        });
      }
    }
    if (!ctx.readOnly) {
      const add = box.createDiv({ cls: "vault-nested-add text-icon-button", attr: { tabindex: "0" } });
      setIcon(add.createSpan({ cls: "text-button-icon" }), "lucide-plus");
      add.createSpan({ cls: "text-button-label", text: isArray ? "Add item" : "Add key" });
      const doAdd = () => {
        const current = getAt(path);
        if (Array.isArray(current)) {
          const sample = current.find((x) => x !== null && typeof x === "object");
          current.push(sample && !Array.isArray(sample) ? Object.fromEntries(Object.keys(sample).map((kk) => [kk, null])) : null);
        } else {
          let name = "key";
          for (let i = 1; Object.prototype.hasOwnProperty.call(current, name); i++) name = `key${i}`;
          (current as Record<string, unknown>)[name] = null;
        }
        commit();
        render();
      };
      add.addEventListener("click", doAdd);
      add.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          doAdd();
        }
      });
    }
  };

  render();
  return { inputEl: root, focus: () => (firstInput ?? root).focus() };
}

function structuredCloneSafe<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

export function renderWidget(type: PropertyType | "unknown", el: HTMLElement, value: unknown, ctx: WidgetContext): WidgetHandle {
  switch (type) {
    case "text":
      return renderTextWidget(el, value, ctx);
    case "multitext":
    case "tags":
    case "aliases":
      return renderListWidget(el, value, ctx, type);
    case "number":
      return renderNumberWidget(el, value, ctx);
    case "checkbox":
      return renderCheckboxWidget(el, value, ctx);
    case "date":
      return renderDateWidget(el, value, ctx, false);
    case "datetime":
      return renderDateWidget(el, value, ctx, true);
    default:
      return renderUnknownWidget(el, value, ctx);
  }
}

/** Fills `app.metadataTypeManager.registeredTypeWidgets` with any type not already registered. */
export function registerPropertyWidgets(app: any) {
  const reg = app?.metadataTypeManager?.registeredTypeWidgets as Record<string, unknown> | undefined;
  if (!reg) return;
  for (const info of Object.values(TYPE_INFO)) {
    if (reg[info.type]) continue;
    reg[info.type] = {
      type: info.type,
      icon: info.icon,
      name: () => info.name,
      validate: (v: unknown) => convertValue(info.type, v) !== null || v === null,
      render: (containerEl: HTMLElement, data: unknown, ctx: Partial<WidgetContext> & { onChange?: (v: unknown) => void; blur?: () => void }) => {
        const value = data && typeof data === "object" && !Array.isArray(data) && "value" in (data as object) && "key" in (data as object) ? (data as { value: unknown }).value : data;
        const key = (ctx?.key ?? (data as { key?: string })?.key ?? "") as string;
        return renderWidget(info.type, containerEl, value, {
          app,
          key,
          sourcePath: ctx?.sourcePath ?? "",
          onChange: (v) => ctx?.onChange?.(v),
          blur: () => ctx?.blur?.(),
          readOnly: ctx?.readOnly,
        });
      },
    };
  }
}
