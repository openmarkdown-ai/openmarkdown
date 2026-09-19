/**
 * Pieces shared by the built-in layouts: group headings (collapsible), value
 * rendering, opening a row's file, the row context menu, summaries.
 */
import { NullValue, normalizePropertyId, type BasesEntry, type BasesEntryGroup, type BasesPropertyId, type BasesView, type Value } from "../../../obsidian/bases/api";
import { setIcon } from "../../../obsidian/ui/icons";
import { Keymap } from "../../../obsidian/ui/keymap";
import { Menu } from "../../../obsidian/ui/menu";
import type { BasesHost } from "../host";
import { SummaryModal } from "../modals";
import { propertyKind } from "../properties";

export function hostOf(view: BasesView): BasesHost | null {
  return (view as { host?: BasesHost }).host ?? null;
}

export function groupKey(group: BasesEntryGroup): string {
  return group.hasKey() ? `k:${group.key?.toString() ?? ""}` : "none";
}

/** `.bases-group-heading`; returns whether the group is collapsed. */
export function renderGroupHeading(view: BasesView, parent: HTMLElement, group: BasesEntryGroup, onToggle: () => void): boolean {
  const host = hostOf(view);
  const key = groupKey(group);
  const collapsed = !!host?.collapsedGroups.has(key);
  const heading = parent.createDiv({ cls: "bases-group-heading", attr: { role: "button", tabindex: "0" } });
  heading.toggleClass("is-collapsed", collapsed);
  const chevron = heading.createDiv({ cls: "bases-group-collapse-icon" });
  setIcon(chevron, "lucide-chevron-down");
  const groupBy = view.config.get("groupBy") as { property?: string } | undefined;
  if (groupBy?.property) heading.createDiv({ cls: "bases-group-property", text: view.config.getDisplayName(normalizePropertyId(groupBy.property)) });
  const valueEl = heading.createDiv({ cls: "bases-group-value" });
  if (group.hasKey() && group.key) renderValue(view, valueEl, group.key);
  else valueEl.createSpan({ cls: "bases-group-none", text: "None" });
  heading.createDiv({ cls: "bases-group-count", text: String(group.entries.length) });
  const toggle = (evt: Event) => {
    if ((evt.target as HTMLElement).closest("a")) return;
    if (!host) return;
    if (host.collapsedGroups.has(key)) host.collapsedGroups.delete(key);
    else host.collapsedGroups.add(key);
    onToggle();
  };
  heading.addEventListener("click", toggle);
  heading.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      toggle(evt);
    }
  });
  return collapsed;
}

export function renderValue(view: BasesView, el: HTMLElement, value: Value | null) {
  const span = el.createSpan({ cls: "bases-rendered-value" });
  if (!value || value instanceof NullValue) {
    span.addClass("is-empty");
    return span;
  }
  value.renderTo(span, view.app.renderContext);
  return span;
}

/** A link to the entry's own file (for file.name and card/list titles). */
export function renderFileLink(view: BasesView, el: HTMLElement, entry: BasesEntry, text: string) {
  const a = el.createEl("a", { cls: "internal-link bases-file-link", href: entry.file.path, text, attr: { "data-href": entry.file.path, draggable: "true" } });
  a.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    openEntry(view, entry, evt);
  });
  a.addEventListener("mouseover", (event) => {
    view.app.workspace.trigger("hover-link", { event, source: "bases", hoverParent: view.app.renderContext, targetEl: a, linktext: entry.file.path, sourcePath: "" });
  });
  a.addEventListener("dragstart", (evt) => view.app.dragManager?.onDragStart?.(evt, view.app.dragManager.dragFile(evt, entry.file, "")));
  return a;
}

export function openEntry(view: BasesView, entry: BasesEntry, evt: MouseEvent | KeyboardEvent) {
  void view.app.workspace.openLinkText(entry.file.path, "", Keymap.isModEvent(evt));
}

export function showFileMenu(view: BasesView, entry: BasesEntry, evt: MouseEvent) {
  evt.preventDefault();
  const menu = new Menu();
  menu.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => void view.app.workspace.openLinkText(entry.file.path, "", "tab")));
  menu.addItem((i) => i.setSection("open").setTitle("Open to the right").setIcon("lucide-separator-vertical").onClick(() => void view.app.workspace.openLinkText(entry.file.path, "", "split")));
  view.app.workspace.trigger("file-menu", menu, entry.file, "bases");
  menu.showAtMouseEvent(evt);
}

export const SUMMARY_NAMES: Record<string, string[]> = {
  number: ["Average", "Min", "Max", "Sum", "Range", "Median", "Stddev"],
  date: ["Earliest", "Latest", "Range"],
  checkbox: ["Checked", "Unchecked"],
  any: ["Empty", "Filled", "Unique"],
};

/** The summary configured for `id` in the current view, and the key it is stored under. */
export function summaryFor(view: BasesView, id: BasesPropertyId): { key: string | null; name: string | null } {
  const summaries = (view.config.get("summaries") ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(summaries)) if (normalizePropertyId(k) === id) return { key: k, name: v };
  return { key: null, name: null };
}

export function setSummary(view: BasesView, id: BasesPropertyId, name: string | null) {
  const current = { ...((view.config.get("summaries") ?? {}) as Record<string, string>) };
  const { key } = summaryFor(view, id);
  const raw = (view.config.get("order") as string[] | undefined)?.find((o) => normalizePropertyId(o) === id) ?? id;
  if (key) delete current[key];
  if (name) current[key ?? raw] = name;
  view.config.set("summaries", Object.keys(current).length ? current : null);
}

export function showSummaryMenu(view: BasesView, id: BasesPropertyId, evt: MouseEvent) {
  const host = hostOf(view);
  const kind = propertyKind(view.app, id);
  const { name: current } = summaryFor(view, id);
  const menu = new Menu();
  const names = [...(kind === "any" ? [...SUMMARY_NAMES.number!, "Earliest", "Latest", ...SUMMARY_NAMES.checkbox!] : (SUMMARY_NAMES[kind] ?? [])), ...SUMMARY_NAMES.any!];
  const seen = new Set<string>();
  menu.addItem((i) => i.setSection("summary").setTitle("None").setChecked(!current).onClick(() => setSummary(view, id, null)));
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    menu.addItem((i) => i.setSection("summary").setTitle(n).setChecked(current?.toLowerCase() === n.toLowerCase()).onClick(() => setSummary(view, id, n)));
  }
  const custom = Object.keys((host?.controller.base?.summaries ?? {}) as Record<string, string>);
  for (const n of custom) menu.addItem((i) => i.setSection("custom").setTitle(n).setIcon("lucide-square-function").setChecked(current === n).onClick(() => setSummary(view, id, n)));
  if (host) menu.addItem((i) => i.setSection("add").setTitle("Add summary").setIcon("lucide-square-function").onClick(() => new SummaryModal(host, (n) => setSummary(view, id, n)).open()));
  menu.showAtMouseEvent(evt);
}
