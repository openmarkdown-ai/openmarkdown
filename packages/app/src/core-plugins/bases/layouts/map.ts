/**
 * Map layout (built-in fallback for the Maps plugin's `map` view type): an
 * equirectangular SVG world with a graticule, one marker per file with
 * coordinates, pan (drag) and zoom (wheel, buttons). No tile servers. Keys
 * match the Maps plugin: coordinates, markerIcon, markerColor, center,
 * defaultZoom, minZoom, maxZoom, mapHeight.
 */
import { BasesView, ListValue, NullValue, NumberValue, ObjectValue, type BasesAllOptions, type BasesEntry, type BasesViewConfig, type QueryController, type Value } from "../../../obsidian/bases/api";
import { setIcon } from "../../../obsidian/ui/icons";
import { Keymap } from "../../../obsidian/ui/keymap";
import { Menu } from "../../../obsidian/ui/menu";
import { Notice } from "../../../obsidian/ui/notice";
import { hostOf, renderValue, showFileMenu } from "./common";

const SVG = "http://www.w3.org/2000/svg";
const W = 1000;
const H = 500;

export function mapOptions(config: BasesViewConfig): BasesAllOptions[] {
  void config;
  return [
    { type: "slider", key: "mapHeight", displayName: "Embedded height", default: 400, min: 100, max: 1200, step: 10 },
    { type: "formula", key: "center", displayName: "Center coordinates", placeholder: "[lat, lng]" },
    {
      type: "group",
      displayName: "Zoom",
      items: [
        { type: "slider", key: "defaultZoom", displayName: "Default zoom", default: 1, min: 0, max: 18, step: 0.5 },
        { type: "slider", key: "minZoom", displayName: "Minimum zoom", default: 0, min: 0, max: 18, step: 0.5 },
        { type: "slider", key: "maxZoom", displayName: "Maximum zoom", default: 18, min: 0, max: 24, step: 0.5 },
      ],
    },
    {
      type: "group",
      displayName: "Markers",
      items: [
        { type: "property", key: "coordinates", displayName: "Marker coordinates", placeholder: "Select property" },
        { type: "property", key: "markerIcon", displayName: "Marker icon", placeholder: "None" },
        { type: "property", key: "markerColor", displayName: "Marker color", placeholder: "None" },
      ],
    },
  ];
}

/** `"lat, lng"`, `[lat, lng]`, `{lat, lng}` → [lat, lng]. */
export function coordinatesOf(value: Value | null): [number, number] | null {
  if (!value || value instanceof NullValue) return null;
  let parts: unknown[] = [];
  if (value instanceof ListValue) parts = value.value.map((v) => (v instanceof NumberValue ? v.value : v.toString()));
  else if (value instanceof ObjectValue) {
    const o = value.value;
    parts = [o.lat ?? o.latitude, o.lng ?? o.lon ?? o.longitude].map((v) => v?.toString());
  } else parts = value.toString().replace(/[[\]()]/g, "").split(/[,;\s]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lat, lng];
}

const project = (lat: number, lng: number): [number, number] => [((lng + 180) / 360) * W, ((90 - lat) / 180) * H];
const unproject = (x: number, y: number): [number, number] => [90 - (y / H) * 180, (x / W) * 360 - 180];

export class MapView extends BasesView {
  type = "map";
  containerEl: HTMLElement;
  private svg: SVGSVGElement;
  private world: SVGGElement;
  private markersG: SVGGElement;
  private popupEl: HTMLElement;
  private k = 1;
  private tx = 0;
  private ty = 0;
  private placed = false;

  constructor(controller: QueryController, parentEl: HTMLElement) {
    super(controller);
    this.containerEl = parentEl.createDiv({ cls: "bases-map-container", attr: { tabindex: "0" } });
    this.svg = document.createElementNS(SVG, "svg");
    this.svg.setAttribute("class", "bases-map");
    this.containerEl.appendChild(this.svg);
    this.world = document.createElementNS(SVG, "g");
    this.svg.appendChild(this.world);
    this.drawWorld();
    this.markersG = document.createElementNS(SVG, "g");
    this.markersG.setAttribute("class", "bases-map-markers");
    this.svg.appendChild(this.markersG);
    this.popupEl = this.containerEl.createDiv({ cls: "bases-map-popup" });
    this.popupEl.hide();
    const controls = this.containerEl.createDiv({ cls: "bases-map-controls" });
    const btn = (icon: string, label: string, fn: () => void) => {
      const b = controls.createDiv({ cls: "clickable-icon", attr: { "aria-label": label, role: "button" } });
      setIcon(b, icon);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
    };
    btn("lucide-plus", "Zoom in", () => this.zoomAt(this.size().w / 2, this.size().h / 2, 2));
    btn("lucide-minus", "Zoom out", () => this.zoomAt(this.size().w / 2, this.size().h / 2, 0.5));
    btn("lucide-maximize", "Fit markers", () => this.fit());
  }

  override onload() {
    this.bindPanZoom();
    this.registerDomEvent(this.svg as unknown as HTMLElement, "contextmenu", (evt: MouseEvent) => this.showMapMenu(evt));
  }

  onDataUpdated(): void {
    const host = hostOf(this);
    const embedded = !!host?.options.embedded;
    this.containerEl.style.height = embedded ? `${Number(this.config.get("mapHeight") ?? 400) || 400}px` : "";
    requestAnimationFrame(() => {
      this.renderMarkers();
      if (!this.placed) {
        this.placed = true;
        this.initialView();
      } else this.applyTransform();
    });
  }

  onResize(): void {
    this.applyTransform();
  }

  private size() {
    const r = this.containerEl.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }

  private zoomLimits() {
    const min = Number(this.config.get("minZoom") ?? 0);
    const max = Number(this.config.get("maxZoom") ?? 18);
    return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 18 };
  }

  /** Scale for a Maps-style zoom level: zoom 0 fits the world's width. */
  private scaleFor(zoom: number) {
    return (this.size().w / W) * 2 ** zoom;
  }

  private clampScale(k: number) {
    const { min, max } = this.zoomLimits();
    return Math.max(this.scaleFor(min) * 0.999, Math.min(this.scaleFor(max), k));
  }

  private drawWorld() {
    const ns = (tag: string, attrs: Record<string, string | number>, parent: SVGElement = this.world) => {
      const el = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      parent.appendChild(el);
      return el;
    };
    ns("rect", { x: 0, y: 0, width: W, height: H, class: "bases-map-ocean" });
    const grid = ns("g", { class: "bases-map-graticule" });
    for (let lng = -180; lng <= 180; lng += 15) {
      const [x] = project(0, lng);
      ns("line", { x1: x, y1: 0, x2: x, y2: H, class: lng % 90 === 0 ? "mod-major" : "" }, grid);
    }
    for (let lat = -90; lat <= 90; lat += 15) {
      const [, y] = project(lat, 0);
      ns("line", { x1: 0, y1: y, x2: W, y2: y, class: lat === 0 ? "mod-major" : "" }, grid);
    }
  }

  private markerData(entry: BasesEntry) {
    const coordProp = this.config.getAsPropertyId("coordinates") ?? "note.coordinates";
    const coords = coordinatesOf(entry.getValue(coordProp));
    if (!coords) return null;
    const colorProp = this.config.getAsPropertyId("markerColor");
    const iconProp = this.config.getAsPropertyId("markerIcon");
    const color = colorProp ? entry.getValue(colorProp)?.toString().trim() : "";
    const icon = iconProp ? entry.getValue(iconProp)?.toString().trim() : "";
    return { coords, color: color || null, icon: icon || null };
  }

  private renderMarkers() {
    const g = this.markersG;
    while (g.firstChild) g.removeChild(g.firstChild);
    this.popupEl.hide();
    let shown = 0;
    for (const entry of this.data.data) {
      const m = this.markerData(entry);
      if (!m) continue;
      shown++;
      const marker = document.createElementNS(SVG, "g");
      marker.setAttribute("class", "bases-map-marker");
      marker.setAttribute("data-path", entry.file.path);
      (marker as unknown as { __latlng: [number, number] }).__latlng = m.coords;
      const pin = document.createElementNS(SVG, "path");
      pin.setAttribute("d", "M0 0 C -2 -6 -9 -9 -9 -16 A 9 9 0 1 1 9 -16 C 9 -9 2 -6 0 0 Z");
      pin.setAttribute("class", "bases-map-marker-pin");
      if (m.color) pin.style.fill = m.color;
      marker.appendChild(pin);
      const dot = document.createElementNS(SVG, "circle");
      dot.setAttribute("cx", "0");
      dot.setAttribute("cy", "-16");
      dot.setAttribute("r", "3.5");
      dot.setAttribute("class", "bases-map-marker-dot");
      marker.appendChild(dot);
      const title = document.createElementNS(SVG, "title");
      title.textContent = entry.file.basename;
      marker.appendChild(title);
      marker.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (Keymap.isModEvent(evt)) void this.app.workspace.openLinkText(entry.file.path, "", Keymap.isModEvent(evt));
        else this.showPopup(entry, marker);
      });
      marker.addEventListener("dblclick", (evt) => {
        evt.stopPropagation();
        void this.app.workspace.openLinkText(entry.file.path, "", false);
      });
      marker.addEventListener("contextmenu", (evt) => {
        evt.stopPropagation();
        showFileMenu(this, entry, evt);
      });
      g.appendChild(marker);
    }
    this.containerEl.toggleClass("is-empty", shown === 0);
    this.containerEl.querySelector(".bases-map-empty")?.remove();
    if (!shown) {
      const msg = this.containerEl.createDiv({ cls: "bases-map-empty" });
      msg.setText(this.config.getAsPropertyId("coordinates") ? "No results have coordinates" : "Choose a marker coordinates property in the view settings");
    }
  }

  private showPopup(entry: BasesEntry, marker: SVGGElement) {
    const p = this.popupEl;
    p.empty();
    const title = p.createDiv({ cls: "bases-map-popup-title" });
    const m = this.markerData(entry);
    if (m?.icon) setIcon(title.createSpan({ cls: "bases-map-popup-icon" }), m.icon);
    const a = title.createEl("a", { cls: "internal-link", text: entry.file.basename, href: entry.file.path });
    a.addEventListener("click", (evt) => {
      evt.preventDefault();
      void this.app.workspace.openLinkText(entry.file.path, "", Keymap.isModEvent(evt));
    });
    for (const id of this.data.properties) {
      if (id === "file.name" || id === "file.basename") continue;
      const v = entry.getValue(id);
      if (!v || v instanceof NullValue || v.toString() === "") continue;
      const row = p.createDiv({ cls: "bases-map-popup-property" });
      row.createSpan({ cls: "bases-map-popup-label", text: this.config.getDisplayName(id) });
      renderValue(this, row.createSpan({ cls: "bases-map-popup-value" }), v);
    }
    p.show();
    (p as unknown as { __marker: SVGGElement }).__marker = marker;
    this.positionPopup();
  }

  private positionPopup() {
    const p = this.popupEl;
    const marker = (p as unknown as { __marker?: SVGGElement }).__marker;
    if (!marker || !p.isShown()) return;
    const [lat, lng] = (marker as unknown as { __latlng: [number, number] }).__latlng;
    const [x, y] = project(lat, lng);
    p.style.left = `${x * this.k + this.tx}px`;
    p.style.top = `${y * this.k + this.ty - 30}px`;
  }

  private initialView() {
    const center = this.centerFromConfig();
    const zoom = Number(this.config.get("defaultZoom"));
    const { w, h } = this.size();
    if (center) {
      this.k = this.clampScale(this.scaleFor(Number.isFinite(zoom) ? zoom : 4));
      const [x, y] = project(center[0], center[1]);
      this.tx = w / 2 - x * this.k;
      this.ty = h / 2 - y * this.k;
      this.applyTransform();
      return;
    }
    this.fit(Number.isFinite(zoom) && this.config.get("defaultZoom") !== undefined ? zoom : null);
  }

  private centerFromConfig(): [number, number] | null {
    const raw = this.config.get("center");
    if (raw === undefined || raw === null || raw === "") return null;
    if (Array.isArray(raw)) return coordinatesOf(new ListValue(raw.slice()));
    const evaluated = this.config.getEvaluatedFormula(this, "center");
    return coordinatesOf(evaluated instanceof NullValue ? null : evaluated) ?? coordinatesOf(new ListValue(String(raw).replace(/[[\]]/g, "").split(",")));
  }

  private fit(zoom: number | null = null) {
    const { w, h } = this.size();
    const pts: [number, number][] = [];
    this.markersG.querySelectorAll("g.bases-map-marker").forEach((m) => pts.push(project(...(m as unknown as { __latlng: [number, number] }).__latlng)));
    if (!pts.length) {
      this.k = this.clampScale(Math.min(w / W, h / H));
      this.tx = (w - W * this.k) / 2;
      this.ty = (h - H * this.k) / 2;
      this.applyTransform();
      return;
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const pad = 60;
    let k = zoom !== null ? this.scaleFor(zoom) : Math.min((w - pad * 2) / Math.max(maxX - minX, 1), (h - pad * 2) / Math.max(maxY - minY, 1));
    if (zoom === null) k = Math.min(k, this.scaleFor(10));
    this.k = this.clampScale(k);
    this.tx = w / 2 - ((minX + maxX) / 2) * this.k;
    this.ty = h / 2 - ((minY + maxY) / 2) * this.k;
    this.applyTransform();
  }

  private applyTransform() {
    this.world.setAttribute("transform", `translate(${this.tx} ${this.ty}) scale(${this.k})`);
    this.markersG.querySelectorAll("g.bases-map-marker").forEach((m) => {
      const [x, y] = project(...(m as unknown as { __latlng: [number, number] }).__latlng);
      m.setAttribute("transform", `translate(${x * this.k + this.tx} ${y * this.k + this.ty})`);
    });
    this.containerEl.style.setProperty("--bases-map-zoom", String(Math.log2(this.k / (this.size().w / W))));
    this.positionPopup();
  }

  private zoomAt(px: number, py: number, factor: number) {
    const k = this.clampScale(this.k * factor);
    const f = k / this.k;
    this.tx = px - (px - this.tx) * f;
    this.ty = py - (py - this.ty) * f;
    this.k = k;
    this.applyTransform();
  }

  private bindPanZoom() {
    this.registerDomEvent(
      this.svg as unknown as HTMLElement,
      "wheel",
      (evt: WheelEvent) => {
        evt.preventDefault();
        const r = this.svg.getBoundingClientRect();
        this.zoomAt(evt.clientX - r.left, evt.clientY - r.top, Math.exp(-evt.deltaY * (evt.ctrlKey ? 0.01 : 0.002)));
      },
      { passive: false },
    );
    this.registerDomEvent(this.svg as unknown as HTMLElement, "pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0 || (evt.target as Element).closest(".bases-map-marker")) return;
      const sx = evt.clientX;
      const sy = evt.clientY;
      const tx = this.tx;
      const ty = this.ty;
      let moved = false;
      this.svg.setPointerCapture(evt.pointerId);
      const move = (e: PointerEvent) => {
        if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 3) moved = true;
        this.tx = tx + e.clientX - sx;
        this.ty = ty + e.clientY - sy;
        this.containerEl.addClass("is-panning");
        this.applyTransform();
      };
      const up = () => {
        this.svg.removeEventListener("pointermove", move);
        this.svg.removeEventListener("pointerup", up);
        this.containerEl.removeClass("is-panning");
        if (!moved) this.popupEl.hide();
      };
      this.svg.addEventListener("pointermove", move);
      this.svg.addEventListener("pointerup", up);
    });
  }

  private showMapMenu(evt: MouseEvent) {
    evt.preventDefault();
    const r = this.svg.getBoundingClientRect();
    const [lat, lng] = unproject((evt.clientX - r.left - this.tx) / this.k, (evt.clientY - r.top - this.ty) / this.k);
    const round = (n: number) => Math.round(n * 1e5) / 1e5;
    const text = `${round(lat)}, ${round(lng)}`;
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle("New note").setIcon("lucide-square-pen").onClick(() => {
        const prop = this.config.getAsPropertyId("coordinates");
        void this.createFileForView("", (fm: Record<string, unknown>) => {
          if (prop?.startsWith("note.")) fm[prop.slice(5)] = [String(round(lat)), String(round(lng))];
        });
      }),
    );
    menu.addItem((i) =>
      i.setTitle("Copy coordinates").setIcon("lucide-copy").onClick(() => {
        void navigator.clipboard?.writeText(text);
        new Notice(`Copied ${text}`);
      }),
    );
    menu.addItem((i) =>
      i.setTitle("Set default center point").setIcon("lucide-map-pin").onClick(() => {
        this.config.set("center", `[${round(lat)}, ${round(lng)}]`);
        this.config.set("defaultZoom", Math.round(Math.log2(this.k / (this.size().w / W)) * 2) / 2);
      }),
    );
    menu.showAtMouseEvent(evt);
  }
}
