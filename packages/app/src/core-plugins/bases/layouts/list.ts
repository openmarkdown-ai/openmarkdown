/**
 * List layout: bulleted, numbered or unmarked items per group. The first
 * property is the item; the rest follow inline with a separator, or as
 * indented sub-items when "Indent properties" is on.
 */
import { BasesView, NullValue, type BasesAllOptions, type BasesEntry, type BasesViewConfig, type QueryController } from "../../../obsidian/bases/api";
import { splitId } from "../properties";
import { renderFileLink, renderGroupHeading, renderValue, showFileMenu } from "./common";

export function listOptions(config: BasesViewConfig): BasesAllOptions[] {
  return [
    { type: "dropdown", key: "markers", displayName: "Markers", default: "bullet", options: { bullet: "Bullet", number: "Number", none: "None" } },
    { type: "toggle", key: "indentProperties", displayName: "Indent properties", default: false },
    { type: "text", key: "separator", displayName: "Property separator", default: ", ", placeholder: ", ", shouldHide: () => !!(config.get("indentProperties") ?? config.get("nestedProperties")) },
  ];
}

export class ListView extends BasesView {
  type = "list";
  containerEl: HTMLElement;

  constructor(controller: QueryController, parentEl: HTMLElement) {
    super(controller);
    this.containerEl = parentEl.createDiv({ cls: "bases-list-container" });
  }

  onDataUpdated(): void {
    this.render();
  }

  private render() {
    const el = this.containerEl;
    el.empty();
    const markers = String(this.config.get("markers") ?? "bullet");
    const indent = !!(this.config.get("indentProperties") ?? this.config.get("nestedProperties"));
    const sepRaw = this.config.get("separator");
    const separator = typeof sepRaw === "string" ? sepRaw : ", ";
    el.setAttr("data-markers", markers);
    const grouped = !!(this.config.get("groupBy") as { property?: string } | undefined)?.property;
    for (const group of this.data.groupedData) {
      const groupEl = el.createDiv({ cls: "bases-list-group" });
      let collapsed = false;
      if (grouped) collapsed = renderGroupHeading(this, groupEl, group, () => this.render());
      if (collapsed) continue;
      const list = groupEl.createEl(markers === "number" ? "ol" : "ul", { cls: `bases-list mod-${markers}` });
      for (const entry of group.entries) this.renderItem(list, entry, indent, separator);
    }
    if (!this.data.data.length) el.createDiv({ cls: "bases-empty-state", text: "No results" });
  }

  private renderItem(list: HTMLElement, entry: BasesEntry, indent: boolean, separator: string) {
    const li = list.createEl("li", { cls: "bases-list-item", attr: { "data-path": entry.file.path } });
    li.addEventListener("contextmenu", (evt) => showFileMenu(this, entry, evt));
    const order = this.data.properties.length ? this.data.properties : (["file.name"] as const);
    const line = li.createDiv({ cls: "bases-list-line" });
    const rest: typeof order[number][] = [];
    order.forEach((id, i) => {
      if (i === 0) {
        const prop = line.createSpan({ cls: "bases-list-property mod-primary", attr: { "data-property": id } });
        const value = entry.getValue(id);
        const { kind, name } = splitId(id);
        if ((kind === "file" && (name === "name" || name === "basename" || name === "path")) || !value || value instanceof NullValue || value.toString() === "")
          renderFileLink(this, prop, entry, kind === "file" && value ? value.toString().replace(/\.md$/, "") : entry.file.basename);
        else renderValue(this, prop, value);
        return;
      }
      rest.push(id);
    });
    const filled = rest.filter((id) => {
      const v = entry.getValue(id);
      return v && !(v instanceof NullValue) && v.toString() !== "";
    });
    if (indent) {
      if (!filled.length) return;
      const sub = li.createEl("ul", { cls: "bases-list-properties" });
      for (const id of filled) {
        const item = sub.createEl("li", { cls: "bases-list-property", attr: { "data-property": id } });
        item.createSpan({ cls: "bases-list-property-label", text: `${this.config.getDisplayName(id)}: ` });
        renderValue(this, item, entry.getValue(id));
      }
      return;
    }
    for (const id of filled) {
      line.createSpan({ cls: "bases-list-separator", text: separator });
      const prop = line.createSpan({ cls: "bases-list-property", attr: { "data-property": id, "aria-label": this.config.getDisplayName(id) } });
      renderValue(this, prop, entry.getValue(id));
    }
  }
}
