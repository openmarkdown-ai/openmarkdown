/**
 * Cards layout: a grid of cards per group; optional cover image from a
 * property (attachment link, URL, image() value, or a hex colour), image fit,
 * aspect ratio and card size. The first property is the card title.
 */
import { BasesView, FileValue, ImageValue, LinkValue, ListValue, NullValue, StringValue, UrlValue, type BasesAllOptions, type BasesEntry, type BasesViewConfig, type QueryController, type Value } from "../../../obsidian/bases/api";
import { parseLinktext } from "../../../obsidian/util";
import { openEntry, renderFileLink, renderGroupHeading, renderValue, showFileMenu } from "./common";
import { splitId } from "../properties";

export function cardsOptions(_config: BasesViewConfig): BasesAllOptions[] {
  return [
    { type: "slider", key: "cardSize", displayName: "Card size", default: 200, min: 50, max: 800, step: 10 },
    { type: "property", key: "image", displayName: "Image property", placeholder: "None" },
    { type: "dropdown", key: "imageFit", displayName: "Image fit", default: "cover", options: { cover: "Cover", contain: "Contain" }, shouldHide: () => !_config.get("image") },
    { type: "slider", key: "imageAspectRatio", displayName: "Image aspect ratio", default: 1, min: 0.25, max: 2.5, step: 0.05, shouldHide: () => !_config.get("image") },
  ];
}

export class CardsView extends BasesView {
  type = "cards";
  containerEl: HTMLElement;

  constructor(controller: QueryController, parentEl: HTMLElement) {
    super(controller);
    this.containerEl = parentEl.createDiv({ cls: "bases-cards-container" });
  }

  onDataUpdated(): void {
    this.render();
  }

  private render() {
    const el = this.containerEl;
    const scroll = el.scrollTop;
    el.empty();
    const size = Number(this.config.get("cardSize") ?? 200) || 200;
    el.style.setProperty("--bases-cards-size", `${Math.max(50, size)}px`);
    const grouped = !!(this.config.get("groupBy") as { property?: string } | undefined)?.property;
    for (const group of this.data.groupedData) {
      let collapsed = false;
      if (grouped) collapsed = renderGroupHeading(this, el, group, () => this.render());
      const groupEl = el.createDiv({ cls: "bases-cards-group" });
      if (collapsed) {
        groupEl.hide();
        continue;
      }
      for (const entry of group.entries) this.renderCard(groupEl, entry);
    }
    if (!this.data.data.length) el.createDiv({ cls: "bases-empty-state", text: "No results" });
    el.scrollTop = scroll;
  }

  private renderCard(parent: HTMLElement, entry: BasesEntry) {
    const card = parent.createDiv({ cls: "bases-cards-item", attr: { "data-path": entry.file.path, tabindex: "0" } });
    card.addEventListener("click", (evt) => {
      if ((evt.target as HTMLElement).closest("a, input")) return;
      openEntry(this, entry, evt);
    });
    card.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") openEntry(this, entry, evt);
    });
    card.addEventListener("contextmenu", (evt) => showFileMenu(this, entry, evt));

    const imageProp = this.config.getAsPropertyId("image");
    if (imageProp) {
      const cover = card.createDiv({ cls: "bases-cards-cover" });
      const ratio = Number(this.config.get("imageAspectRatio") ?? 1) || 1;
      cover.style.aspectRatio = `1 / ${ratio}`;
      const fit = this.config.get("imageFit") === "contain" ? "contain" : "cover";
      cover.addClass(`mod-${fit}`);
      this.fillCover(cover, entry.getValue(imageProp), entry.file.path, fit);
    }

    const props = card.createDiv({ cls: "bases-cards-properties" });
    const order = this.data.properties;
    order.forEach((id, i) => {
      const prop = props.createDiv({ cls: "bases-cards-property", attr: { "data-property": id } });
      const value = entry.getValue(id);
      if (i === 0) {
        prop.addClass("mod-title");
        const line = prop.createDiv({ cls: "bases-cards-line" });
        const { kind, name } = splitId(id);
        if (kind === "file" && (name === "name" || name === "basename" || name === "path"))
          renderFileLink(this, line, entry, name === "name" && entry.file.extension === "md" ? entry.file.basename : (value?.toString() ?? entry.file.basename));
        else if (!value || value instanceof NullValue || value.toString() === "") renderFileLink(this, line, entry, entry.file.basename);
        else renderValue(this, line, value);
        return;
      }
      prop.createDiv({ cls: "bases-cards-label", text: this.config.getDisplayName(id) });
      const line = prop.createDiv({ cls: "bases-cards-line" });
      if (!value || value instanceof NullValue || value.toString() === "") line.addClass("is-empty");
      renderValue(this, line, value);
    });
    if (!order.length) renderFileLink(this, props.createDiv({ cls: "bases-cards-property mod-title" }).createDiv({ cls: "bases-cards-line" }), entry, entry.file.basename);
  }

  private fillCover(cover: HTMLElement, value: Value | null, sourcePath: string, fit: string) {
    if (!value || value instanceof NullValue) return;
    if (value instanceof ListValue) value = value.get(0);
    let src: string | null = null;
    const text = value.toString().trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) {
      cover.style.backgroundColor = text;
      cover.addClass("mod-color");
      return;
    }
    if (value instanceof ImageValue) src = value.resourcePath();
    else if (value instanceof UrlValue || /^https?:\/\//i.test(text)) src = text;
    else if (value instanceof LinkValue || value instanceof FileValue || value instanceof StringValue) {
      const target = value instanceof FileValue ? value.path : text.replace(/^!?\[\[|\]\]$/g, "").split("|")[0]!;
      const file = this.app.metadataCache.getFirstLinkpathDest(parseLinktext(target).path, sourcePath) ?? this.app.vault.getFileByPath(target);
      if (file) src = this.app.vault.getResourcePath(file);
    }
    if (!src) return;
    const img = cover.createEl("img", { attr: { src, alt: "", draggable: "false", referrerpolicy: "no-referrer", loading: "lazy" } });
    img.style.objectFit = fit;
  }
}
