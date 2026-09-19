/**
 * The graph settings overlay (`.graph-controls`): collapsible Filters,
 * Groups, Display and Forces sections, a close/open cog and "Restore default
 * settings". Every change goes back to the view with the kind of refresh it
 * needs.
 */
import { setIcon } from "../../obsidian/ui/icons";
import { ButtonComponent, ColorComponent, SearchComponent, Setting } from "../../obsidian/ui/setting";
import { debounce } from "../../obsidian/util";
import { hexToRgbInt, randomGroupColor, rgbIntToHex, type GraphOptions, type LocalGraphOptions } from "./options";

/** What a change requires: new graph data, a restyle, new forces, or only a save. */
export type ChangeKind = "data" | "style" | "forces" | "ui";

export interface GraphControlsHost {
  options: GraphOptions | LocalGraphOptions;
  isLocal: boolean;
  onOptionsChange(kind: ChangeKind): void;
  onAnimate(): void;
  onRestoreDefaults(): void;
}

type SectionKey = "collapse-filter" | "collapse-color-groups" | "collapse-display" | "collapse-forces";

export class GraphControls {
  containerEl: HTMLElement;
  private openButtonEl!: HTMLElement;

  constructor(
    parentEl: HTMLElement,
    private host: GraphControlsHost,
  ) {
    this.containerEl = parentEl.createDiv({ cls: "graph-controls" });
    this.render();
  }

  render() {
    const o = this.host.options;
    const el = this.containerEl;
    el.empty();
    el.toggleClass("is-close", !!o.close);

    this.openButtonEl = el.createDiv({ cls: "clickable-icon graph-controls-button mod-open", attr: { "aria-label": "Open graph settings" } });
    setIcon(this.openButtonEl, "lucide-settings");
    this.openButtonEl.addEventListener("click", () => this.setClosed(false));

    const close = el.createDiv({ cls: "clickable-icon graph-controls-button mod-close", attr: { "aria-label": "Close" } });
    setIcon(close, "lucide-x");
    close.addEventListener("click", () => this.setClosed(true));

    const reset = el.createDiv({ cls: "clickable-icon graph-controls-button mod-reset", attr: { "aria-label": "Restore default settings" } });
    setIcon(reset, "lucide-rotate-ccw");
    reset.addEventListener("click", () => this.host.onRestoreDefaults());

    this.renderFilters(this.section("mod-filter", "Filters", "collapse-filter"));
    this.renderGroups(this.section("mod-color-groups", "Groups", "collapse-color-groups"));
    this.renderDisplay(this.section("mod-display", "Display", "collapse-display"));
    this.renderForces(this.section("mod-forces", "Forces", "collapse-forces"));
  }

  private setClosed(closed: boolean) {
    this.host.options.close = closed;
    this.containerEl.toggleClass("is-close", closed);
    this.host.onOptionsChange("ui");
  }

  private section(cls: string, title: string, key: SectionKey): HTMLElement {
    const o = this.host.options;
    const section = this.containerEl.createDiv({ cls: `tree-item graph-control-section ${cls}` });
    const self = section.createDiv({ cls: "tree-item-self is-clickable mod-collapsible" });
    const icon = self.createDiv({ cls: "tree-item-icon collapse-icon" });
    setIcon(icon, "lucide-chevron-down");
    const inner = self.createDiv({ cls: "tree-item-inner" });
    inner.createEl("header", { cls: "graph-control-section-header", text: title });
    const children = section.createDiv({ cls: "tree-item-children" });
    const apply = () => {
      const collapsed = !!o[key];
      section.toggleClass("is-collapsed", collapsed);
      icon.toggleClass("is-collapsed", collapsed);
      children.toggle(!collapsed);
    };
    apply();
    self.addEventListener("click", () => {
      o[key] = !o[key];
      apply();
      this.host.onOptionsChange("ui");
    });
    return children;
  }

  private toggle(parent: HTMLElement, name: string, key: keyof GraphOptions | keyof LocalGraphOptions, kind: ChangeKind, desc?: string) {
    const o = this.host.options as unknown as Record<string, unknown>;
    const s = new Setting(parent).setName(name).setClass("mod-toggle");
    if (desc) s.setDesc(desc);
    s.addToggle((t) =>
      t.setValue(!!o[key]).onChange((v) => {
        o[key] = v;
        this.host.onOptionsChange(kind);
      }),
    );
  }

  private slider(parent: HTMLElement, name: string, key: string, min: number, max: number, step: number, kind: ChangeKind, desc?: string) {
    const o = this.host.options as unknown as Record<string, number>;
    const s = new Setting(parent).setName(name).setClass("mod-slider");
    if (desc) s.setDesc(desc);
    s.addSlider((sl) =>
      sl
        .setLimits(min, max, step)
        .setValue(o[key] ?? min)
        .setDisplayFormat(() => "")
        .setInstant(true)
        .onChange((v) => {
          o[key] = v;
          this.host.onOptionsChange(kind);
        }),
    );
  }

  private renderFilters(el: HTMLElement) {
    const o = this.host.options;
    const searchSetting = new Setting(el).setClass("mod-search-setting");
    searchSetting.infoEl.remove();
    const search = new SearchComponent(searchSetting.controlEl);
    search.setPlaceholder("Search files...");
    search.setValue(o.search);
    const commit = debounce(
      (v: string) => {
        o.search = v;
        this.host.onOptionsChange("data");
      },
      500,
      true,
    );
    search.onChange((v) => commit(v));
    search.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        o.search = search.getValue();
        this.host.onOptionsChange("data");
      }
    });

    if (this.host.isLocal) {
      this.slider(el, "Depth", "localJumps", 1, 5, 1, "data", "Show nodes this number of links away");
      this.toggle(el, "Incoming links", "localBacklinks", "data");
      this.toggle(el, "Outgoing links", "localForelinks", "data");
      this.toggle(el, "Neighbor links", "localInterlinks", "data", "Show links between neighbors");
    }
    this.toggle(el, "Tags", "showTags", "data");
    this.toggle(el, "Attachments", "showAttachments", "data");
    this.toggle(el, "Existing files only", "hideUnresolved", "data");
    this.toggle(el, "Orphans", "showOrphans", "data");
  }

  private renderGroups(el: HTMLElement) {
    const o = this.host.options;
    const list = el.createDiv({ cls: "graph-color-groups-container" });
    const commitQuery = debounce(() => this.host.onOptionsChange("data"), 500, true);
    o.colorGroups.forEach((group, index) => {
      const row = list.createDiv({ cls: "graph-color-group" });
      const search = new SearchComponent(row);
      search.setPlaceholder("Enter query...");
      search.setValue(group.query);
      search.onChange((v) => {
        group.query = v;
        commitQuery();
      });
      const color = new ColorComponent(row);
      color.setValue(rgbIntToHex(group.color.rgb));
      color.onChange((hex) => {
        group.color = { a: group.color.a ?? 1, rgb: hexToRgbInt(hex) };
        this.host.onOptionsChange("style");
      });
      const remove = row.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Delete group" } });
      setIcon(remove, "lucide-x");
      remove.addEventListener("click", () => {
        o.colorGroups.splice(index, 1);
        this.render();
        this.host.onOptionsChange("data");
      });
      // Drag to reorder: the first matching group wins.
      row.setAttr("draggable", "true");
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/x-graph-group", String(index));
        row.addClass("is-dragging");
      });
      row.addEventListener("dragend", () => row.removeClass("is-dragging"));
      row.addEventListener("dragover", (e) => {
        if (e.dataTransfer?.types.includes("text/x-graph-group")) e.preventDefault();
      });
      row.addEventListener("drop", (e) => {
        const from = Number(e.dataTransfer?.getData("text/x-graph-group"));
        if (!Number.isInteger(from) || from === index) return;
        e.preventDefault();
        const [moved] = o.colorGroups.splice(from, 1);
        if (moved) o.colorGroups.splice(index, 0, moved);
        this.render();
        this.host.onOptionsChange("data");
      });
    });
    const buttons = el.createDiv({ cls: "graph-color-button-container" });
    new ButtonComponent(buttons)
      .setButtonText("New group")
      .setCta()
      .onClick(() => {
        o.colorGroups.push({ query: "", color: randomGroupColor() });
        o["collapse-color-groups"] = false;
        this.render();
        this.host.onOptionsChange("ui");
        const inputs = this.containerEl.querySelectorAll<HTMLInputElement>(".graph-color-group input[type=search]");
        inputs[inputs.length - 1]?.focus();
      });
  }

  private renderDisplay(el: HTMLElement) {
    this.toggle(el, "Arrows", "showArrow", "style");
    this.slider(el, "Text fade threshold", "textFadeMultiplier", -3, 3, 0.1, "style");
    this.slider(el, "Node size", "nodeSizeMultiplier", 0.1, 5, 0.01, "style");
    this.slider(el, "Link thickness", "lineSizeMultiplier", 0.1, 5, 0.01, "style");
    const animate = el.createDiv({ cls: "setting-item graph-control-animate" });
    new ButtonComponent(animate)
      .setButtonText("Animate")
      .setCta()
      .onClick(() => this.host.onAnimate());
  }

  private renderForces(el: HTMLElement) {
    this.slider(el, "Center force", "centerStrength", 0, 1, 0.001, "forces");
    this.slider(el, "Repel force", "repelStrength", 0, 20, 0.001, "forces");
    this.slider(el, "Link force", "linkStrength", 0, 1, 0.001, "forces");
    this.slider(el, "Link distance", "linkDistance", 30, 500, 1, "forces");
  }
}
