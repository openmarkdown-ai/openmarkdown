/**
 * Canvas view (`canvas`): an infinite board of cards and connections stored as
 * JSON Canvas 1.0.
 *
 * Cards are DOM (`.canvas-node`) positioned with CSS transforms inside a
 * `.canvas` element that carries the pan/zoom transform; connections are SVG
 * paths in `.canvas-edges`. Every edit goes through `commit()`, which records
 * an undo snapshot and asks the TextFileView to save.
 */
import { Keymap } from "../../obsidian/ui/keymap";
import { setIcon } from "../../obsidian/ui/icons";
import { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { setTooltip } from "../../obsidian/ui/tooltip";
import { normalizePath } from "../../obsidian/util";
import { TFile, TFolder, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { TextFileView } from "../../obsidian/workspace/view";
import {
  arrowPoints,
  bezierBetween,
  cssColor,
  edgeGeometry,
  emptyCanvas,
  isPresetColor,
  nearestSide,
  parseCanvas,
  PRESET_COLOR_NAMES,
  PRESET_COLORS,
  randomId,
  rectsIntersect,
  rectContains,
  serializeCanvas,
  sideFacing,
  sidePoint,
  unionRect,
  type CanvasData,
  type CanvasEdgeData,
  type CanvasNodeData,
  type Rect,
  type Side,
} from "./data";
import { CanvasHelpModal, FileSuggestModal, ItemSuggestModal, MEDIA_EXTENSIONS, PromptModal } from "./modals";
import { CanvasNodeView, DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS, type NodeHost } from "./node-view";
import { CanvasInternalApi } from "./internal-api";

export const VIEW_TYPE_CANVAS = "canvas";

export interface CanvasSettings {
  newFileLocation: "root" | "current" | "folder";
  newFileFolderPath: string;
  defaultWheelBehavior: "pan" | "zoom";
  defaultModDragBehavior: "menu" | "card" | "note" | "media" | "webpage" | "group";
  cardNameVisibility: "always" | "hover" | "never";
  snapToGrid: boolean;
  snapToObjects: boolean;
  zoomThreshold: number;
}

export const DEFAULT_CANVAS_SETTINGS: CanvasSettings = {
  newFileLocation: "root",
  newFileFolderPath: "",
  defaultWheelBehavior: "pan",
  defaultModDragBehavior: "menu",
  cardNameVisibility: "always",
  snapToGrid: true,
  snapToObjects: true,
  zoomThreshold: 0,
};

export interface CanvasPluginHost {
  canvasSettings(): CanvasSettings;
  exportImage(view: CanvasView): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const GRID = 20;
const MIN_ZOOM = 1 / 16;
const MAX_ZOOM = 4;
const HISTORY_LIMIT = 200;
const MIN_W = 50;
const MIN_H = 30;

type Point = { x: number; y: number };

class CanvasEdgeView {
  g: SVGGElement;
  display: SVGPathElement;
  interaction: SVGPathElement;
  fromArrow: SVGPolygonElement;
  toArrow: SVGPolygonElement;
  labelWrapperEl: HTMLElement;
  labelEl: HTMLElement;
  geometry: ReturnType<typeof edgeGeometry> | null = null;

  constructor(
    public data: CanvasEdgeData,
    svg: SVGSVGElement,
    labelParent: HTMLElement,
  ) {
    this.g = document.createElementNS(SVG_NS, "g");
    this.g.setAttribute("class", "canvas-path");
    this.g.dataset.id = data.id;
    this.display = document.createElementNS(SVG_NS, "path");
    this.display.setAttribute("class", "canvas-display-path");
    this.interaction = document.createElementNS(SVG_NS, "path");
    this.interaction.setAttribute("class", "canvas-interaction-path");
    this.fromArrow = document.createElementNS(SVG_NS, "polygon");
    this.fromArrow.setAttribute("class", "canvas-path-end mod-from");
    this.toArrow = document.createElementNS(SVG_NS, "polygon");
    this.toArrow.setAttribute("class", "canvas-path-end mod-to");
    this.g.append(this.display, this.interaction, this.fromArrow, this.toArrow);
    svg.appendChild(this.g);
    this.labelWrapperEl = labelParent.createDiv({ cls: "canvas-path-label-wrapper" });
    this.labelWrapperEl.dataset.id = data.id;
    this.labelEl = this.labelWrapperEl.createDiv({ cls: "canvas-path-label" });
  }

  update(data: CanvasEdgeData, from: Rect | undefined, to: Rect | undefined) {
    this.data = data;
    if (!from || !to) {
      this.g.style.display = "none";
      this.labelWrapperEl.hide();
      this.geometry = null;
      return;
    }
    this.g.style.display = "";
    const fromEnd = (data.fromEnd ?? "none") === "arrow";
    const toEnd = (data.toEnd ?? "arrow") === "arrow";
    const geo = edgeGeometry(from, to, data.fromSide, data.toSide, toEnd, fromEnd);
    this.geometry = geo;
    this.display.setAttribute("d", geo.path);
    this.interaction.setAttribute("d", geo.path);
    this.toArrow.style.display = toEnd ? "" : "none";
    this.fromArrow.style.display = fromEnd ? "" : "none";
    if (toEnd) this.toArrow.setAttribute("points", arrowPoints(geo.to, geo.toSide));
    if (fromEnd) this.fromArrow.setAttribute("points", arrowPoints(geo.from, geo.fromSide));
    const color = cssColor(data.color);
    for (let i = 1; i <= 6; i++) this.g.classList.remove(`mod-canvas-color-${i}`);
    this.g.classList.toggle("is-themed", !!color);
    if (isPresetColor(data.color)) this.g.classList.add(`mod-canvas-color-${data.color}`);
    if (color) this.g.style.setProperty("--canvas-color", color);
    else this.g.style.removeProperty("--canvas-color");
    if (color) this.labelWrapperEl.style.setProperty("--canvas-color", color);
    else this.labelWrapperEl.style.removeProperty("--canvas-color");
    const hasLabel = !!data.label;
    if (!this.labelEl.isContentEditable) this.labelEl.setText(data.label ?? "");
    this.labelWrapperEl.toggle(hasLabel || this.labelEl.isContentEditable);
    this.labelWrapperEl.style.transform = `translate(${geo.mid.x}px, ${geo.mid.y}px) translate(-50%, -50%)`;
  }

  setSelected(on: boolean) {
    this.g.classList.toggle("is-focused", on);
    this.labelWrapperEl.toggleClass("is-focused", on);
  }

  destroy() {
    this.g.remove();
    this.labelWrapperEl.remove();
  }
}

type Gesture =
  | { kind: "pan"; pointerId: number; sx: number; sy: number; tx: number; ty: number }
  | { kind: "marquee"; pointerId: number; start: Point; base: Set<string>; el: HTMLElement }
  | {
      kind: "move";
      pointerId: number;
      start: Point;
      screen: Point;
      ids: string[];
      origin: Map<string, Point>;
      moved: boolean;
      toggleOnUp: string | null;
      clickSelect: string | null;
      duplicate: boolean;
    }
  | { kind: "resize"; pointerId: number; id: string; handle: string; start: Point; rect: Rect; moved: boolean }
  | { kind: "connect"; pointerId: number; fromId: string; fromSide: Side; path: SVGPathElement; edgeId?: string; end?: "from" | "to" }
  | { kind: "card"; pointerId: number; type: "text" | "note" | "media" | "group"; screen: Point; moved: boolean; ghost: HTMLElement | null };

export class CanvasView extends TextFileView implements NodeHost {
  canvasData: CanvasData = emptyCanvas();
  nodes = new Map<string, CanvasNodeView>();
  edges = new Map<string, CanvasEdgeView>();
  selectedNodes = new Set<string>();
  selectedEdges = new Set<string>();
  readOnly = false;
  tx = 0;
  ty = 0;
  zoom = 1;

  wrapperEl!: HTMLElement;
  backgroundEl!: SVGSVGElement;
  private patternEl!: SVGPatternElement;
  private dotEl!: SVGCircleElement;
  canvasEl!: HTMLElement;
  edgesSvg!: SVGSVGElement;
  private guidesG!: SVGGElement;
  private edgeHandles: SVGCircleElement[] = [];
  private menuContainerEl!: HTMLElement;
  private menuEl!: HTMLElement;
  private submenuEl: HTMLElement | null = null;
  private controlsEl!: HTMLElement;
  private cardMenuEl!: HTMLElement;
  private errorEl: HTMLElement | null = null;
  private undoButton!: HTMLElement;
  private redoButton!: HTMLElement;
  private readOnlyButton!: HTMLElement;

  private plugin: CanvasPluginHost;
  private loadedText = "";
  private changed = false;
  private parseError: string | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private snapshot = "";
  private gesture: Gesture | null = null;
  private spaceDown = false;
  private lastPointer: Point | null = null;
  private pendingFit = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: CanvasPluginHost) {
    super(leaf);
    this.plugin = plugin;
    this.icon = "lucide-layout-dashboard";
    this.buildDom();
  }

  get owner() {
    return this;
  }

  private internalApi: CanvasInternalApi | null = null;
  // internal (used by plugins: Excalidraw creates detached file cards through
  // `views.canvas(leaf).canvas.createFileNode(…)`)
  get canvas(): CanvasInternalApi {
    return (this.internalApi ??= new CanvasInternalApi(this.app));
  }

  getViewType(): string {
    return VIEW_TYPE_CANVAS;
  }

  override getIcon(): string {
    return "lucide-layout-dashboard";
  }

  override canAcceptExtension(extension: string): boolean {
    return extension === "canvas";
  }

  settings(): CanvasSettings {
    return this.plugin.canvasSettings();
  }

  // ---- DOM ----------------------------------------------------------------------------------

  private buildDom() {
    this.contentEl.addClass("vault-canvas-content");
    const wrapper = (this.wrapperEl = this.contentEl.createDiv({ cls: "canvas-wrapper", attr: { tabindex: "-1" } }));

    this.backgroundEl = document.createElementNS(SVG_NS, "svg");
    this.backgroundEl.setAttribute("class", "canvas-background");
    const defs = document.createElementNS(SVG_NS, "defs");
    this.patternEl = document.createElementNS(SVG_NS, "pattern");
    const patternId = `canvas-dots-${randomId()}`;
    this.patternEl.setAttribute("id", patternId);
    this.patternEl.setAttribute("patternUnits", "userSpaceOnUse");
    this.dotEl = document.createElementNS(SVG_NS, "circle");
    this.dotEl.setAttribute("class", "canvas-background-dot");
    this.patternEl.appendChild(this.dotEl);
    defs.appendChild(this.patternEl);
    const bgRect = document.createElementNS(SVG_NS, "rect");
    bgRect.setAttribute("width", "100%");
    bgRect.setAttribute("height", "100%");
    bgRect.setAttribute("fill", `url(#${patternId})`);
    this.backgroundEl.append(defs, bgRect);
    wrapper.appendChild(this.backgroundEl);

    this.canvasEl = wrapper.createDiv({ cls: "canvas" });
    this.edgesSvg = document.createElementNS(SVG_NS, "svg");
    this.edgesSvg.setAttribute("class", "canvas-edges");
    this.guidesG = document.createElementNS(SVG_NS, "g");
    this.guidesG.setAttribute("class", "vault-canvas-snap-guides");
    this.edgesSvg.appendChild(this.guidesG);
    this.canvasEl.appendChild(this.edgesSvg);

    this.menuContainerEl = wrapper.createDiv({ cls: "canvas-menu-container" });
    this.menuEl = this.menuContainerEl.createDiv({ cls: "canvas-menu" });
    this.menuContainerEl.hide();

    this.buildControls();
    this.buildCardMenu();
  }

  private iconButton(parent: HTMLElement, cls: string, icon: string, label: string, onClick: (e: MouseEvent) => void): HTMLElement {
    const el = parent.createDiv({ cls: `${cls} clickable-icon`, attr: { "aria-label": label } });
    setIcon(el, icon);
    setTooltip(el, label, { placement: "left" });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(e);
    });
    return el;
  }

  private buildControls() {
    const controls = (this.controlsEl = this.wrapperEl.createDiv({ cls: "canvas-controls" }));
    const zoomGroup = controls.createDiv({ cls: "canvas-control-group" });
    this.iconButton(zoomGroup, "canvas-control-item", "lucide-plus", "Zoom in", () => this.zoomBy(1.25));
    this.iconButton(zoomGroup, "canvas-control-item", "lucide-rotate-cw", "Reset zoom", () => this.zoomTo(1));
    this.iconButton(zoomGroup, "canvas-control-item", "lucide-maximize", "Zoom to fit (Shift+1)", () => this.zoomToFit());
    this.iconButton(zoomGroup, "canvas-control-item", "lucide-minus", "Zoom out", () => this.zoomBy(0.8));
    const historyGroup = controls.createDiv({ cls: "canvas-control-group" });
    this.undoButton = this.iconButton(historyGroup, "canvas-control-item", "lucide-undo-2", "Undo", () => this.undo());
    this.redoButton = this.iconButton(historyGroup, "canvas-control-item", "lucide-redo-2", "Redo", () => this.redo());
    const miscGroup = controls.createDiv({ cls: "canvas-control-group" });
    this.readOnlyButton = this.iconButton(miscGroup, "canvas-control-item", "lucide-lock", "Enable read-only", () => this.setReadOnly(!this.readOnly));
    this.iconButton(miscGroup, "canvas-control-item", "lucide-settings", "Canvas settings", () => {
      const setting = this.app.setting;
      if (setting?.open) {
        setting.open();
        setting.openTabById?.("canvas");
      }
    });
    this.iconButton(miscGroup, "canvas-control-item", "lucide-help-circle", "Canvas help", () => new CanvasHelpModal(this.app).open());
    this.updateHistoryButtons();
  }

  private buildCardMenu() {
    const menu = (this.cardMenuEl = this.wrapperEl.createDiv({ cls: "canvas-card-menu" }));
    const add = (type: "text" | "note" | "media" | "group", icon: string, label: string) => {
      const el = menu.createDiv({ cls: "canvas-card-menu-button mod-draggable", attr: { "aria-label": label, "data-type": type } });
      setIcon(el, icon);
      setTooltip(el, label, { placement: "top" });
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || this.readOnly) return;
        e.preventDefault();
        e.stopPropagation();
        this.gesture = { kind: "card", pointerId: e.pointerId, type, screen: { x: e.clientX, y: e.clientY }, moved: false, ghost: null };
      });
    };
    add("text", "lucide-sticky-note", "Drag to add card");
    add("note", "lucide-file-text", "Drag to add note from vault");
    add("media", "lucide-image", "Drag to add media from vault");
    add("group", "lucide-box-select", "Drag to add group");
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  override async onOpen(): Promise<void> {
    const w = this.wrapperEl;
    this.registerDomEvent(w, "pointerdown", (e: PointerEvent) => this.onPointerDown(e));
    this.registerDomEvent(window, "pointermove", (e: PointerEvent) => this.onPointerMove(e));
    this.registerDomEvent(window, "pointerup", (e: PointerEvent) => this.onPointerUp(e));
    this.registerDomEvent(window, "pointercancel", (e: PointerEvent) => this.onPointerUp(e));
    this.registerDomEvent(w, "dblclick", (e: MouseEvent) => this.onDoubleClick(e));
    this.registerDomEvent(w, "wheel", (e: WheelEvent) => this.onWheel(e), { passive: false });
    this.registerDomEvent(w, "contextmenu", (e: MouseEvent) => this.onContextMenu(e));
    this.registerDomEvent(w, "keydown", (e: KeyboardEvent) => this.onKeyDown(e));
    this.registerDomEvent(w, "keyup", (e: KeyboardEvent) => {
      if (e.key === " ") this.setSpace(false);
    });
    this.registerDomEvent(window, "blur", () => this.setSpace(false));
    this.registerDomEvent(document, "copy", (e: ClipboardEvent) => this.onCopy(e, false));
    this.registerDomEvent(document, "cut", (e: ClipboardEvent) => this.onCopy(e, true));
    this.registerDomEvent(document, "paste", (e: ClipboardEvent) => this.onPaste(e));
    this.app.dragManager.handleDrop(w, (evt: DragEvent, data: any, isOver: boolean) => this.onDrop(evt, data, isOver));

    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        for (const n of this.nodes.values()) if (n.data.type === "file" && n.data.file === file.path && !n.editing) n.invalidate();
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension === "md" || file === this.file) return;
        for (const n of this.nodes.values()) if (n.data.file === file.path || n.data.background === file.path) n.invalidate();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        for (const n of this.nodes.values()) if (n.data.file === file.path) n.invalidate();
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        for (const n of this.nodes.values()) if (n.data.file === file.path) n.invalidate();
      }),
    );

    this.resizeObserver = new ResizeObserver(() => {
      if (this.pendingFit && this.wrapperEl.clientWidth > 0) {
        this.pendingFit = false;
        this.zoomToFit();
      }
      this.applyTransform();
    });
    this.resizeObserver.observe(this.wrapperEl);
  }

  override async onClose(): Promise<void> {
    for (const n of this.nodes.values()) if (n.editing) n.stopEditing(false);
    this.resizeObserver?.disconnect();
    await super.onClose();
  }

  // ---- TextFileView ---------------------------------------------------------------------------

  getViewData(): string {
    if (this.parseError !== null || !this.changed) return this.loadedText;
    return serializeCanvas(this.canvasData);
  }

  setViewData(data: string, clear: boolean): void {
    for (const n of this.nodes.values()) if (n.editing) n.stopEditing(false);
    this.loadedText = data;
    this.changed = false;
    this.errorEl?.remove();
    this.errorEl = null;
    try {
      this.canvasData = parseCanvas(data);
      this.parseError = null;
    } catch (e) {
      this.parseError = String((e as Error)?.message ?? e);
      this.canvasData = emptyCanvas();
      this.errorEl = this.wrapperEl.createDiv({ cls: "vault-canvas-error" });
      this.errorEl.createDiv({ cls: "vault-canvas-error-title", text: "This canvas file could not be read." });
      this.errorEl.createDiv({ cls: "vault-canvas-error-detail", text: this.parseError });
    }
    if (clear) {
      this.selectedNodes.clear();
      this.selectedEdges.clear();
      this.undoStack = [];
      this.redoStack = [];
    }
    this.syncAll();
    this.snapshot = serializeCanvas(this.canvasData);
    this.updateHistoryButtons();
    if (clear) {
      if (this.wrapperEl.clientWidth > 0) this.zoomToFit();
      else this.pendingFit = true;
    }
  }

  clear(): void {
    for (const n of this.nodes.values()) n.destroy();
    for (const e of this.edges.values()) e.destroy();
    this.nodes.clear();
    this.edges.clear();
    this.selectedNodes.clear();
    this.selectedEdges.clear();
    this.canvasData = emptyCanvas();
    this.updateSelection();
  }

  override getEphemeralState(): Record<string, unknown> {
    return { x: this.tx, y: this.ty, zoom: this.zoom };
  }

  override setEphemeralState(state: any): void {
    if (state && typeof state.zoom === "number") {
      this.zoom = state.zoom;
      this.tx = Number(state.x) || 0;
      this.ty = Number(state.y) || 0;
      this.pendingFit = false;
      this.applyTransform();
    }
  }

  // ---- data → DOM -----------------------------------------------------------------------------

  // internal
  syncAll() {
    const seen = new Set<string>();
    this.canvasData.nodes.forEach((data, i) => {
      seen.add(data.id);
      const z = (data.type === "group" ? 0 : 100000) + i;
      const existing = this.nodes.get(data.id);
      if (existing) existing.update(data, z);
      else {
        const view = new CanvasNodeView(data, this, this.canvasEl);
        view.layout(z);
        this.nodes.set(data.id, view);
      }
    });
    for (const [id, view] of this.nodes) {
      if (!seen.has(id)) {
        view.destroy();
        this.nodes.delete(id);
        this.selectedNodes.delete(id);
      }
    }
    const seenEdges = new Set<string>();
    for (const data of this.canvasData.edges) {
      seenEdges.add(data.id);
      let view = this.edges.get(data.id);
      if (!view) {
        view = new CanvasEdgeView(data, this.edgesSvg, this.canvasEl);
        this.edges.set(data.id, view);
      }
      view.data = data;
    }
    for (const [id, view] of this.edges) {
      if (!seenEdges.has(id)) {
        view.destroy();
        this.edges.delete(id);
        this.selectedEdges.delete(id);
      }
    }
    this.updateEdges();
    this.updateSelection();
  }

  private nodeData(id: string): CanvasNodeData | undefined {
    return this.nodes.get(id)?.data;
  }

  private updateEdges(onlyFor?: Set<string>) {
    for (const edge of this.edges.values()) {
      const d = edge.data;
      if (onlyFor && !onlyFor.has(d.fromNode) && !onlyFor.has(d.toNode)) continue;
      edge.update(d, this.nodeData(d.fromNode), this.nodeData(d.toNode));
    }
    this.updateEdgeHandles();
  }

  // ---- history ---------------------------------------------------------------------------------

  /** Record the current data as one undoable step and save. */
  commit() {
    const now = serializeCanvas(this.canvasData);
    if (now === this.snapshot) return;
    this.undoStack.push(this.snapshot);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.snapshot = now;
    this.changed = true;
    this.requestSave();
    this.updateHistoryButtons();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.snapshot);
    this.restore(prev);
  }

  redo() {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.snapshot);
    this.restore(next);
  }

  private restore(text: string) {
    for (const n of this.nodes.values()) if (n.editing) n.stopEditing(false);
    this.snapshot = text;
    this.canvasData = parseCanvas(text);
    this.changed = true;
    this.syncAll();
    this.requestSave();
    this.updateHistoryButtons();
  }

  private updateHistoryButtons() {
    this.undoButton?.toggleClass("is-disabled", this.undoStack.length === 0);
    this.redoButton?.toggleClass("is-disabled", this.redoStack.length === 0);
  }

  // ---- NodeHost ----------------------------------------------------------------------------------

  onNodeTextEdited(node: CanvasNodeView, text: string) {
    if (node.data.type !== "text" || node.data.text === text) return;
    node.data.text = text;
    this.changed = true;
    this.requestSave();
  }

  onEditingEnd(_node: CanvasNodeView) {
    this.commit();
    this.wrapperEl.focus({ preventScroll: true });
  }

  // ---- camera ----------------------------------------------------------------------------------------

  private viewportSize() {
    return { w: this.wrapperEl.clientWidth, h: this.wrapperEl.clientHeight };
  }

  toWorld(clientX: number, clientY: number): Point {
    const r = this.wrapperEl.getBoundingClientRect();
    return { x: (clientX - r.left - this.tx) / this.zoom, y: (clientY - r.top - this.ty) / this.zoom };
  }

  private viewportCenter(): Point {
    const { w, h } = this.viewportSize();
    return { x: (w / 2 - this.tx) / this.zoom, y: (h / 2 - this.ty) / this.zoom };
  }

  // internal
  applyTransform() {
    this.canvasEl.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.zoom})`;
    this.wrapperEl.style.setProperty("--zoom-multiplier", String(1 / this.zoom));
    let spacing = GRID;
    while (spacing * this.zoom < 14) spacing *= 2;
    const size = spacing * this.zoom;
    this.patternEl.setAttribute("width", String(size));
    this.patternEl.setAttribute("height", String(size));
    this.patternEl.setAttribute("x", String(this.tx % size));
    this.patternEl.setAttribute("y", String(this.ty % size));
    this.dotEl.setAttribute("cx", String(size / 2));
    this.dotEl.setAttribute("cy", String(size / 2));
    this.dotEl.setAttribute("r", String(Math.max(0.5, Math.min(1.2, 0.9 * this.zoom))));
    const threshold = this.settings().zoomThreshold;
    this.wrapperEl.toggleClass("vault-canvas-zoomed-out", Math.log2(this.zoom) < threshold - 1.5);
    this.updateMenuPosition();
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const wx = (sx - this.tx) / this.zoom;
    const wy = (sy - this.ty) / this.zoom;
    this.zoom = next;
    this.tx = sx - wx * next;
    this.ty = sy - wy * next;
    this.applyTransform();
  }

  zoomBy(factor: number) {
    const { w, h } = this.viewportSize();
    this.zoomAt(w / 2, h / 2, factor);
  }

  zoomTo(zoom: number) {
    this.zoomBy(zoom / this.zoom);
  }

  zoomToRect(rect: Rect | null, maxZoom = 1) {
    const { w, h } = this.viewportSize();
    if (!rect || w === 0) {
      this.zoom = 1;
      this.tx = w / 2;
      this.ty = h / 2;
      this.applyTransform();
      return;
    }
    const pad = 80;
    const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min((w - pad) / Math.max(1, rect.width), (h - pad) / Math.max(1, rect.height))));
    this.zoom = zoom;
    this.tx = w / 2 - (rect.x + rect.width / 2) * zoom;
    this.ty = h / 2 - (rect.y + rect.height / 2) * zoom;
    this.applyTransform();
  }

  zoomToFit() {
    this.zoomToRect(unionRect(this.canvasData.nodes), 1);
  }

  zoomToSelection() {
    const rects: Rect[] = [];
    for (const id of this.selectedNodes) {
      const d = this.nodeData(id);
      if (d) rects.push(d);
    }
    for (const id of this.selectedEdges) {
      const e = this.edges.get(id)?.data;
      const a = e && this.nodeData(e.fromNode);
      const b = e && this.nodeData(e.toNode);
      if (a) rects.push(a);
      if (b) rects.push(b);
    }
    if (rects.length === 0) this.zoomToFit();
    else this.zoomToRect(unionRect(rects), 1);
  }

  setReadOnly(on: boolean) {
    this.readOnly = on;
    for (const n of this.nodes.values()) if (on && n.editing) n.stopEditing();
    this.wrapperEl.toggleClass("is-read-only", on);
    this.readOnlyButton.toggleClass("is-active", on);
    this.readOnlyButton.setAttr("aria-label", on ? "Disable read-only" : "Enable read-only");
    this.updateSelection();
  }

  // ---- selection ---------------------------------------------------------------------------------------

  selectOnly(nodeIds: string[], edgeIds: string[] = []) {
    this.selectedNodes = new Set(nodeIds);
    this.selectedEdges = new Set(edgeIds);
    this.updateSelection();
  }

  deselectAll() {
    this.selectOnly([]);
  }

  // internal
  updateSelection() {
    for (const [id, n] of this.nodes) {
      const on = this.selectedNodes.has(id);
      n.el.toggleClass("is-selected", on);
      n.el.toggleClass("is-focused", on && this.selectedNodes.size === 1);
    }
    for (const [id, e] of this.edges) e.setSelected(this.selectedEdges.has(id));
    this.wrapperEl.toggleClass("has-selection", this.selectedNodes.size + this.selectedEdges.size > 0);
    this.updateEdgeHandles();
    this.renderMenu();
  }

  private selectionRect(): Rect | null {
    const rects: Rect[] = [];
    for (const id of this.selectedNodes) {
      const d = this.nodeData(id);
      if (d) rects.push(d);
    }
    for (const id of this.selectedEdges) {
      const g = this.edges.get(id)?.geometry;
      if (g) rects.push({ x: Math.min(g.from.x, g.to.x), y: Math.min(g.from.y, g.to.y), width: Math.abs(g.to.x - g.from.x), height: Math.abs(g.to.y - g.from.y) });
    }
    return unionRect(rects);
  }

  private updateEdgeHandles() {
    for (const h of this.edgeHandles) h.remove();
    this.edgeHandles = [];
    if (this.readOnly || this.selectedEdges.size !== 1 || this.selectedNodes.size > 0) return;
    const edge = this.edges.get([...this.selectedEdges][0]!);
    const g = edge?.geometry;
    if (!edge || !g) return;
    for (const end of ["from", "to"] as const) {
      const p = end === "from" ? g.from : g.to;
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("class", `vault-canvas-edge-handle mod-${end}`);
      c.setAttribute("cx", String(p.x));
      c.setAttribute("cy", String(p.y));
      c.dataset.edge = edge.data.id;
      c.dataset.end = end;
      this.edgesSvg.appendChild(c);
      this.edgeHandles.push(c);
    }
  }

  // ---- selection toolbar ---------------------------------------------------------------------------------

  private renderMenu() {
    const menu = this.menuEl;
    menu.empty();
    this.closeSubmenu();
    const nodeCount = this.selectedNodes.size;
    const edgeCount = this.selectedEdges.size;
    if (nodeCount + edgeCount === 0 || this.gesture?.kind === "move" || this.gesture?.kind === "resize") {
      this.menuContainerEl.hide();
      return;
    }
    this.menuContainerEl.show();
    const button = (icon: string, label: string, onClick: (el: HTMLElement) => void, cls = "") => {
      const el = menu.createEl("button", { cls: `clickable-icon ${cls}`.trim(), attr: { "aria-label": label } });
      setIcon(el, icon);
      setTooltip(el, label, { placement: "top" });
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(el);
      });
      return el;
    };
    if (!this.readOnly) {
      button("lucide-trash-2", "Remove", () => this.removeSelection(), "mod-destructive");
      button("lucide-palette", "Set color", (el) => this.toggleColorMenu(el));
    }
    button("lucide-scan", "Zoom to selection", () => this.zoomToSelection());
    if (!this.readOnly) {
      if (nodeCount === 1 && edgeCount === 0) {
        const node = this.nodes.get([...this.selectedNodes][0]!);
        if (node?.canEdit()) button("lucide-pencil", "Edit", () => void node.startEditing());
        if (node?.isGroup) button("lucide-pencil", "Edit label", () => this.editGroupLabel(node));
      }
      if (edgeCount === 1 && nodeCount === 0) {
        const edge = this.edges.get([...this.selectedEdges][0]!);
        if (edge) {
          button("lucide-pencil", "Edit label", () => this.editEdgeLabel(edge));
          button("lucide-arrow-right-left", "Line direction", (el) => this.showDirectionMenu(edge, el));
        }
      }
      if (nodeCount >= 2) button("lucide-align-start-vertical", "Align", (el) => this.showAlignMenu(el));
      if (nodeCount >= 1) button("lucide-box-select", "Create group", () => this.groupSelection());
    }
    this.updateMenuPosition();
  }

  private updateMenuPosition() {
    if (!this.menuContainerEl || !this.menuContainerEl.isShown()) return;
    const rect = this.selectionRect();
    if (!rect) return;
    const x = (rect.x + rect.width / 2) * this.zoom + this.tx;
    const y = rect.y * this.zoom + this.ty;
    const { w } = this.viewportSize();
    const clampedX = Math.max(80, Math.min(w - 80, x));
    this.menuContainerEl.style.transform = `translate(${clampedX}px, ${Math.max(8, y - 56)}px) translateX(-50%)`;
  }

  private closeSubmenu() {
    this.submenuEl?.remove();
    this.submenuEl = null;
  }

  private selectedColor(): string | undefined {
    const first = [...this.selectedNodes].map((id) => this.nodeData(id)?.color).concat([...this.selectedEdges].map((id) => this.edges.get(id)?.data.color))[0];
    return first;
  }

  private toggleColorMenu(anchor: HTMLElement) {
    if (this.submenuEl) {
      this.closeSubmenu();
      return;
    }
    const sub = (this.submenuEl = this.menuContainerEl.createDiv({ cls: "canvas-submenu mod-color" }));
    sub.addEventListener("pointerdown", (e) => e.stopPropagation());
    const current = this.selectedColor();
    const item = (color: string | undefined, label: string) => {
      const el = sub.createDiv({ cls: "canvas-color-picker-item", attr: { "aria-label": label } });
      if (color) {
        el.addClass(`mod-canvas-color-${color}`);
        el.style.setProperty("--canvas-color", cssColor(color)!);
      } else el.addClass("mod-no-color");
      el.toggleClass("is-active", color === current);
      setTooltip(el, label, { placement: "top" });
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setColor(color === current ? undefined : color);
        this.closeSubmenu();
      });
    };
    for (const c of PRESET_COLORS) item(c, PRESET_COLOR_NAMES[c]!);
    const custom = sub.createDiv({ cls: "canvas-color-picker-item mod-custom", attr: { "aria-label": "Custom color" } });
    setTooltip(custom, "Custom color", { placement: "top" });
    if (current && !isPresetColor(current)) {
      custom.addClass("is-active");
      custom.style.setProperty("--canvas-color", current);
    }
    const input = custom.createEl("input", { type: "color" });
    input.value = current && /^#[0-9a-f]{6}$/i.test(current) ? current : "#888888";
    input.addEventListener("input", () => this.setColor(input.value, false));
    input.addEventListener("change", () => {
      this.setColor(input.value);
      this.closeSubmenu();
    });
    void anchor;
  }

  setColor(color: string | undefined, record = true) {
    for (const id of this.selectedNodes) {
      const d = this.nodeData(id);
      if (!d) continue;
      if (color) d.color = color;
      else delete d.color;
      this.nodes.get(id)!.update(d, Number(this.nodes.get(id)!.el.style.zIndex));
    }
    for (const id of this.selectedEdges) {
      const e = this.edges.get(id);
      if (!e) continue;
      if (color) e.data.color = color;
      else delete e.data.color;
    }
    this.updateEdges();
    if (record) this.commit();
  }

  private showDirectionMenu(edge: CanvasEdgeView, anchor: HTMLElement) {
    const menu = new Menu();
    const current = `${edge.data.fromEnd ?? "none"}-${edge.data.toEnd ?? "arrow"}`;
    const opt = (title: string, from: "none" | "arrow", to: "none" | "arrow") =>
      menu.addItem((i) =>
        i
          .setTitle(title)
          .setChecked(current === `${from}-${to}`)
          .onClick(() => {
            if (from === "none") delete edge.data.fromEnd;
            else edge.data.fromEnd = from;
            if (to === "arrow") delete edge.data.toEnd;
            else edge.data.toEnd = to;
            this.updateEdges();
            this.commit();
          }),
      );
    opt("Nondirectional", "none", "none");
    opt("Unidirectional", "none", "arrow");
    opt("Bidirectional", "arrow", "arrow");
    const r = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
  }

  private showAlignMenu(anchor: HTMLElement) {
    const menu = new Menu();
    const add = (section: string, title: string, icon: string, fn: () => void) =>
      menu.addItem((i) =>
        i
          .setSection(section)
          .setTitle(title)
          .setIcon(icon)
          .onClick(() => {
            fn();
            this.afterNodesMoved(new Set(this.selectedNodes));
            this.commit();
          }),
      );
    const sel = () => [...this.selectedNodes].map((id) => this.nodeData(id)!).filter(Boolean);
    const bbox = () => unionRect(sel())!;
    add("align", "Align left", "lucide-align-start-vertical", () => sel().forEach((d) => (d.x = bbox().x)));
    add("align", "Align center", "lucide-align-center-vertical", () => {
      const b = bbox();
      sel().forEach((d) => (d.x = Math.round(b.x + b.width / 2 - d.width / 2)));
    });
    add("align", "Align right", "lucide-align-end-vertical", () => {
      const b = bbox();
      sel().forEach((d) => (d.x = b.x + b.width - d.width));
    });
    add("align", "Align top", "lucide-align-start-horizontal", () => sel().forEach((d) => (d.y = bbox().y)));
    add("align", "Align middle", "lucide-align-center-horizontal", () => {
      const b = bbox();
      sel().forEach((d) => (d.y = Math.round(b.y + b.height / 2 - d.height / 2)));
    });
    add("align", "Align bottom", "lucide-align-end-horizontal", () => {
      const b = bbox();
      sel().forEach((d) => (d.y = b.y + b.height - d.height));
    });
    const distribute = (axis: "x" | "y") => {
      const list = sel().sort((a, b) => a[axis] - b[axis]);
      if (list.length < 3) return;
      const size = axis === "x" ? "width" : "height";
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const total = list.reduce((s, d) => s + d[size], 0);
      const gap = (last[axis] + last[size] - first[axis] - total) / (list.length - 1);
      let pos = first[axis];
      for (const d of list) {
        d[axis] = Math.round(pos);
        pos += d[size] + gap;
      }
    };
    add("distribute", "Distribute horizontal spacing", "lucide-align-horizontal-space-around", () => distribute("x"));
    add("distribute", "Distribute vertical spacing", "lucide-align-vertical-space-around", () => distribute("y"));
    const arrange = (mode: "row" | "column" | "grid") => {
      const list = sel().sort((a, b) => a.y - b.y || a.x - b.x);
      const b = bbox();
      const gap = GRID * 2;
      const cols = mode === "row" ? list.length : mode === "column" ? 1 : Math.ceil(Math.sqrt(list.length));
      let x = b.x;
      let y = b.y;
      let rowH = 0;
      list.forEach((d, i) => {
        if (i > 0 && i % cols === 0) {
          x = b.x;
          y += rowH + gap;
          rowH = 0;
        }
        d.x = x;
        d.y = y;
        x += d.width + gap;
        rowH = Math.max(rowH, d.height);
      });
    };
    add("arrange", "Arrange in a row", "lucide-columns-3", () => arrange("row"));
    add("arrange", "Arrange in a column", "lucide-rows-3", () => arrange("column"));
    add("arrange", "Arrange in a grid", "lucide-layout-grid", () => arrange("grid"));
    const r = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 });
  }

  private afterNodesMoved(ids: Set<string>) {
    for (const id of ids) this.nodes.get(id)?.layout();
    this.updateEdges(ids);
    this.updateMenuPosition();
  }

  // ---- editing operations ----------------------------------------------------------------------------------

  addNode(partial: Partial<CanvasNodeData> & { type: string }, center: Point, opts: { select?: boolean; edit?: boolean; record?: boolean } = {}): CanvasNodeData {
    const width = Math.round(partial.width ?? (partial.type === "text" ? 250 : 400));
    const height = Math.round(partial.height ?? (partial.type === "text" ? 60 : 400));
    const snap = this.settings().snapToGrid ? (v: number) => Math.round(v / GRID) * GRID : Math.round;
    const node = { id: randomId(), ...partial } as CanvasNodeData;
    node.x = snap(center.x - width / 2);
    node.y = snap(center.y - height / 2);
    node.width = width;
    node.height = height;
    const ordered: CanvasNodeData = { id: node.id, type: node.type } as CanvasNodeData;
    for (const k of ["text", "file", "subpath", "url", "label", "background", "backgroundStyle"]) if (node[k] !== undefined) ordered[k] = node[k];
    Object.assign(ordered, { x: node.x, y: node.y, width, height });
    if (node.color) ordered.color = node.color;
    if (ordered.type === "group") this.canvasData.nodes.unshift(ordered);
    else this.canvasData.nodes.push(ordered);
    this.syncAll();
    if (opts.select !== false) this.selectOnly([ordered.id]);
    if (opts.record !== false) this.commit();
    if (opts.edit) void this.nodes.get(ordered.id)?.startEditing();
    return ordered;
  }

  addFileNode(file: TFile, center: Point, record = true): CanvasNodeData {
    const ext = file.extension.toLowerCase();
    const node = this.addNode({ type: "file", file: file.path }, center, { record: false });
    if (IMAGE_EXTENSIONS.includes(ext)) {
      const img = new Image();
      img.onload = () => {
        if (!img.naturalWidth || !img.naturalHeight) return;
        const d = this.nodeData(node.id);
        if (!d) return;
        d.height = Math.max(MIN_H, Math.round((d.width * img.naturalHeight) / img.naturalWidth));
        this.afterNodesMoved(new Set([d.id]));
        this.changed = true;
        this.snapshot = serializeCanvas(this.canvasData);
        this.requestSave();
      };
      img.src = this.app.vault.getResourcePath(file);
    } else if (ext !== "md" && ext !== "canvas" && ext !== "base" && ext !== "pdf" && !MEDIA_EXTENSIONS.includes(ext)) {
      const d = this.nodeData(node.id)!;
      d.height = 100;
      this.afterNodesMoved(new Set([d.id]));
    }
    if (record) this.commit();
    return node;
  }

  removeSelection() {
    if (this.readOnly) return;
    const nodeIds = new Set(this.selectedNodes);
    const edgeIds = new Set(this.selectedEdges);
    if (nodeIds.size + edgeIds.size === 0) return;
    this.canvasData.nodes = this.canvasData.nodes.filter((n) => !nodeIds.has(n.id));
    this.canvasData.edges = this.canvasData.edges.filter((e) => !edgeIds.has(e.id) && !nodeIds.has(e.fromNode) && !nodeIds.has(e.toNode));
    this.selectedNodes.clear();
    this.selectedEdges.clear();
    this.syncAll();
    this.commit();
  }

  groupSelection(label = "") {
    const rect = this.selectionRect();
    if (!rect || this.readOnly) return;
    const pad = GRID * 2;
    const group = this.addNode(
      { type: "group", label: label || undefined, width: rect.width + pad * 2, height: rect.height + pad * 2 },
      { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      { record: false },
    );
    const d = this.nodeData(group.id)!;
    d.x = Math.round(rect.x - pad);
    d.y = Math.round(rect.y - pad);
    this.afterNodesMoved(new Set([d.id]));
    this.commit();
  }

  duplicateSelection(offset: Point = { x: GRID * 2, y: GRID * 2 }) {
    const { nodes, edges } = this.copySelection();
    this.pasteData({ nodes, edges }, null, offset);
  }

  private copySelection(): { nodes: CanvasNodeData[]; edges: CanvasEdgeData[] } {
    const ids = new Set(this.selectedNodes);
    const nodes = this.canvasData.nodes.filter((n) => ids.has(n.id)).map((n) => structuredClone(n));
    const edges = this.canvasData.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode)).map((e) => structuredClone(e));
    return { nodes, edges };
  }

  /** Insert nodes with fresh ids; `at` centres them there, otherwise `offset` shifts them. */
  pasteData(data: { nodes: CanvasNodeData[]; edges?: CanvasEdgeData[] }, at: Point | null, offset: Point = { x: 0, y: 0 }): string[] {
    if (this.readOnly || !data.nodes.length) return [];
    const rect = unionRect(data.nodes)!;
    const dx = at ? Math.round(at.x - (rect.x + rect.width / 2)) : offset.x;
    const dy = at ? Math.round(at.y - (rect.y + rect.height / 2)) : offset.y;
    const idMap = new Map<string, string>();
    const added: string[] = [];
    const groups: CanvasNodeData[] = [];
    const others: CanvasNodeData[] = [];
    for (const n of data.nodes) {
      const id = randomId();
      idMap.set(n.id, id);
      const copy = { ...structuredClone(n), id, x: Math.round(n.x + dx), y: Math.round(n.y + dy) };
      (copy.type === "group" ? groups : others).push(copy);
      added.push(id);
    }
    this.canvasData.nodes = [...groups, ...this.canvasData.nodes, ...others];
    for (const e of data.edges ?? []) {
      const from = idMap.get(e.fromNode);
      const to = idMap.get(e.toNode);
      if (from && to) this.canvasData.edges.push({ ...structuredClone(e), id: randomId(), fromNode: from, toNode: to });
    }
    this.syncAll();
    this.selectOnly(added);
    this.commit();
    return added;
  }

  convertToFile(nodeId: string) {
    const d = this.nodeData(nodeId);
    if (!d || d.type !== "text" || this.readOnly) return;
    const firstLine = (d.text ?? "").split("\n").find((l) => l.trim()) ?? "";
    const suggested = firstLine.replace(/^#+\s*/, "").replace(/[\\/:*?"<>|#^[\]]/g, "").trim().slice(0, 60) || "Untitled";
    new PromptModal(this.app, "Convert to file", "File name", suggested, "Convert", (name) => void this.doConvertToFile(nodeId, name)).open();
  }

  private async doConvertToFile(nodeId: string, name: string) {
    const d = this.nodeData(nodeId);
    if (!d) return;
    const folder = this.app.fileManager.getNewFileParent(this.file?.path ?? "") as TFolder;
    const base = folder.isRoot() ? name : `${folder.path}/${name}`;
    const path = this.app.vault.getAvailablePath(normalizePath(base.replace(/\.md$/i, "")), "md");
    try {
      const file = (await this.app.vault.create(path, d.text ?? "")) as TFile;
      const current = this.nodeData(nodeId);
      if (!current) return;
      const { id, text: _text, type: _type, ...rest } = current;
      const replaced = { id, type: "file", file: file.path, ...rest } as CanvasNodeData;
      const index = this.canvasData.nodes.indexOf(current);
      this.canvasData.nodes[index] = replaced;
      this.syncAll();
      this.updateSelection();
      this.commit();
    } catch (e) {
      new Notice(`Could not create the file: ${(e as Error).message}`);
    }
  }

  private editGroupLabel(node: CanvasNodeView) {
    const label = node.labelEl;
    if (!label || this.readOnly) return;
    label.setAttr("contenteditable", "true");
    label.removeClass("is-empty");
    label.focus();
    const range = document.createRange();
    range.selectNodeContents(label);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const finish = (save: boolean) => {
      label.removeAttribute("contenteditable");
      label.removeEventListener("keydown", onKey);
      label.removeEventListener("blur", onBlur);
      const text = label.getText().trim();
      if (save && text !== (node.data.label ?? "")) {
        if (text) node.data.label = text;
        else delete node.data.label;
        this.commit();
      }
      label.setText(node.data.label ?? "");
      label.toggleClass("is-empty", !node.data.label);
      this.wrapperEl.focus({ preventScroll: true });
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    const onBlur = () => finish(true);
    label.addEventListener("keydown", onKey);
    label.addEventListener("blur", onBlur);
  }

  private editEdgeLabel(edge: CanvasEdgeView) {
    if (this.readOnly) return;
    const label = edge.labelEl;
    label.setAttr("contenteditable", "true");
    edge.labelWrapperEl.show();
    edge.labelWrapperEl.addClass("is-editing");
    label.focus();
    const range = document.createRange();
    range.selectNodeContents(label);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const finish = (save: boolean) => {
      label.removeAttribute("contenteditable");
      edge.labelWrapperEl.removeClass("is-editing");
      label.removeEventListener("keydown", onKey);
      label.removeEventListener("blur", onBlur);
      const text = label.getText().trim();
      if (save && text !== (edge.data.label ?? "")) {
        if (text) edge.data.label = text;
        else delete edge.data.label;
        this.commit();
      }
      this.updateEdges();
      this.wrapperEl.focus({ preventScroll: true });
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    const onBlur = () => finish(true);
    label.addEventListener("keydown", onKey);
    label.addEventListener("blur", onBlur);
  }

  private stopAllEditing() {
    for (const n of this.nodes.values()) if (n.editing) n.stopEditing();
  }

  // ---- pointer input ------------------------------------------------------------------------------------------

  private local(e: MouseEvent): Point {
    const r = this.wrapperEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private setSpace(on: boolean) {
    this.spaceDown = on;
    this.wrapperEl.toggleClass("is-space-down", on);
  }

  private onPointerDown(e: PointerEvent) {
    const target = e.target as HTMLElement | SVGElement;
    const el = target as HTMLElement;
    if (el.closest?.(".canvas-controls, .canvas-card-menu, .canvas-menu-container, .vault-canvas-error")) return;
    this.closeSubmenu();
    const nodeEl = el.closest?.(".canvas-node") as HTMLElement | null;
    const editing = [...this.nodes.values()].find((n) => n.editing);
    if (editing) {
      if (nodeEl === editing.el && !el.closest("[data-resize], .canvas-node-connection-point")) return;
      editing.stopEditing();
    }
    if (el.isContentEditable) return;
    this.wrapperEl.focus({ preventScroll: true });
    const world = this.toWorld(e.clientX, e.clientY);
    this.lastPointer = world;

    if (e.button === 1 || (e.button === 0 && this.spaceDown) || (e.pointerType === "touch" && !nodeEl)) {
      e.preventDefault();
      this.gesture = { kind: "pan", pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, tx: this.tx, ty: this.ty };
      this.wrapperEl.addClass("is-panning");
      return;
    }
    if (e.button !== 0) return;

    const handle = el.closest?.(".vault-canvas-edge-handle") as SVGCircleElement | null;
    if (handle && !this.readOnly) {
      const edge = this.edges.get(handle.dataset.edge ?? "");
      const end = handle.dataset.end as "from" | "to";
      if (edge) {
        e.preventDefault();
        const fixedId = end === "from" ? edge.data.toNode : edge.data.fromNode;
        const fixedSide = (end === "from" ? edge.geometry?.toSide : edge.geometry?.fromSide) ?? "right";
        this.gesture = { kind: "connect", pointerId: e.pointerId, fromId: fixedId, fromSide: fixedSide, path: this.createTempPath(), edgeId: edge.data.id, end };
        edge.g.style.opacity = "0.3";
        return;
      }
    }

    const cp = el.closest?.(".canvas-node-connection-point") as HTMLElement | null;
    if (cp && nodeEl && !this.readOnly) {
      e.preventDefault();
      e.stopPropagation();
      this.gesture = { kind: "connect", pointerId: e.pointerId, fromId: nodeEl.dataset.id!, fromSide: cp.dataset.side as Side, path: this.createTempPath() };
      return;
    }

    const resize = el.closest?.("[data-resize]") as HTMLElement | null;
    if (resize && nodeEl && !this.readOnly) {
      e.preventDefault();
      const d = this.nodeData(nodeEl.dataset.id!);
      if (d) {
        this.gesture = { kind: "resize", pointerId: e.pointerId, id: d.id, handle: resize.dataset.resize!, start: world, rect: { x: d.x, y: d.y, width: d.width, height: d.height }, moved: false };
        return;
      }
    }

    const edgeTarget = el.closest?.(".canvas-path, .canvas-path-label-wrapper") as HTMLElement | null;
    if (edgeTarget && !nodeEl) {
      const id = edgeTarget.dataset.id ?? (edgeTarget.closest(".canvas-path") as HTMLElement | null)?.dataset.id;
      if (id) {
        if (e.shiftKey) {
          if (this.selectedEdges.has(id)) this.selectedEdges.delete(id);
          else this.selectedEdges.add(id);
          this.updateSelection();
        } else this.selectOnly([], [id]);
        return;
      }
    }

    if (nodeEl) {
      const id = nodeEl.dataset.id!;
      // A card's own scrollable content and media controls stay usable once selected.
      if (this.selectedNodes.has(id) && el.closest("video, audio, iframe, input, select")) return;
      let toggleOnUp: string | null = null;
      let clickSelect: string | null = null;
      if (e.shiftKey) {
        if (this.selectedNodes.has(id)) toggleOnUp = id;
        else {
          this.selectedNodes.add(id);
          this.updateSelection();
        }
      } else if (!this.selectedNodes.has(id)) {
        this.selectOnly([id]);
      } else if (this.selectedNodes.size > 1 || this.selectedEdges.size > 0) {
        clickSelect = id;
      }
      if (this.readOnly) return;
      e.preventDefault();
      const ids = this.movingIds();
      const origin = new Map<string, Point>();
      for (const mid of ids) {
        const d = this.nodeData(mid);
        if (d) origin.set(mid, { x: d.x, y: d.y });
      }
      this.gesture = { kind: "move", pointerId: e.pointerId, start: world, screen: { x: e.clientX, y: e.clientY }, ids, origin, moved: false, toggleOnUp, clickSelect, duplicate: e.altKey };
      return;
    }

    // Empty canvas: marquee selection.
    e.preventDefault();
    const base = e.shiftKey ? new Set(this.selectedNodes) : new Set<string>();
    if (!e.shiftKey) this.deselectAll();
    const marquee = this.wrapperEl.createDiv({ cls: "canvas-selection" });
    marquee.hide();
    this.gesture = { kind: "marquee", pointerId: e.pointerId, start: world, base, el: marquee };
  }

  /** Selected nodes plus every card inside a selected group. */
  private movingIds(): string[] {
    const ids = new Set(this.selectedNodes);
    for (const id of this.selectedNodes) {
      const g = this.nodeData(id);
      if (g?.type !== "group") continue;
      for (const n of this.canvasData.nodes) if (n.id !== id && rectContains(g, n)) ids.add(n.id);
    }
    return [...ids];
  }

  private createTempPath(): SVGPathElement {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("class", "canvas-display-path vault-canvas-temp-path");
    this.edgesSvg.appendChild(p);
    return p;
  }

  private onPointerMove(e: PointerEvent) {
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    const world = this.toWorld(e.clientX, e.clientY);
    this.lastPointer = world;
    switch (g.kind) {
      case "pan":
        this.tx = g.tx + (e.clientX - g.sx);
        this.ty = g.ty + (e.clientY - g.sy);
        this.applyTransform();
        break;
      case "marquee": {
        const x = Math.min(g.start.x, world.x);
        const y = Math.min(g.start.y, world.y);
        const rect = { x, y, width: Math.abs(world.x - g.start.x), height: Math.abs(world.y - g.start.y) };
        g.el.show();
        g.el.style.transform = `translate(${x * this.zoom + this.tx}px, ${y * this.zoom + this.ty}px)`;
        g.el.style.width = `${rect.width * this.zoom}px`;
        g.el.style.height = `${rect.height * this.zoom}px`;
        const sel = new Set(g.base);
        for (const n of this.canvasData.nodes) {
          const hit = n.type === "group" ? rectContains(rect, n) : rectsIntersect(rect, n);
          if (hit) sel.add(n.id);
        }
        this.selectedNodes = sel;
        this.selectedEdges.clear();
        this.updateSelection();
        break;
      }
      case "move": {
        if (!g.moved) {
          if (Math.hypot(e.clientX - g.screen.x, e.clientY - g.screen.y) < 3) return;
          g.moved = true;
          this.wrapperEl.addClass("is-dragging");
          if (g.duplicate) {
            const added = this.pasteDataSilently();
            g.ids = this.movingIds();
            g.origin = new Map(g.ids.map((id) => [id, { x: this.nodeData(id)!.x, y: this.nodeData(id)!.y }]));
            void added;
          }
          this.menuContainerEl.hide();
        }
        let dx = world.x - g.start.x;
        let dy = world.y - g.start.y;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        [dx, dy] = this.snapMove(g.ids, g.origin, dx, dy, !this.spaceDown);
        for (const id of g.ids) {
          const o = g.origin.get(id);
          const d = this.nodeData(id);
          if (!o || !d) continue;
          d.x = Math.round(o.x + dx);
          d.y = Math.round(o.y + dy);
        }
        this.afterNodesMoved(new Set(g.ids));
        break;
      }
      case "resize": {
        const d = this.nodeData(g.id);
        if (!d) break;
        g.moved = true;
        this.menuContainerEl.hide();
        const r = this.resizeRect(g.rect, g.handle, world.x - g.start.x, world.y - g.start.y, e.shiftKey, !this.spaceDown && this.settings().snapToGrid);
        Object.assign(d, r);
        this.afterNodesMoved(new Set([g.id]));
        break;
      }
      case "connect": {
        const from = this.nodeData(g.fromId);
        if (!from) break;
        const over = this.nodeAt(e.clientX, e.clientY, g.fromId);
        this.canvasEl.querySelectorAll(".canvas-node.is-connection-target").forEach((n) => n.removeClass("is-connection-target"));
        let geo;
        if (over) {
          over.el.addClass("is-connection-target");
          const side = nearestSide(over.data, world.x, world.y);
          geo = bezierBetween(sidePoint(from, g.fromSide), g.fromSide, sidePoint(over.data, side), side, false);
        } else {
          geo = bezierBetween(sidePoint(from, g.fromSide), g.fromSide, world, null, false);
        }
        g.path.setAttribute("d", geo.path);
        break;
      }
      case "card": {
        if (!g.moved && Math.hypot(e.clientX - g.screen.x, e.clientY - g.screen.y) > 4) {
          g.moved = true;
          g.ghost = document.body.createDiv({ cls: "vault-canvas-card-ghost" });
          g.ghost.dataset.type = g.type;
        }
        if (g.ghost) {
          g.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px) scale(${this.zoom})`;
        }
        break;
      }
    }
  }

  private pasteDataSilently(): string[] {
    const { nodes, edges } = this.copySelection();
    if (!nodes.length) return [];
    const idMap = new Map<string, string>();
    const groups: CanvasNodeData[] = [];
    const others: CanvasNodeData[] = [];
    for (const n of nodes) {
      const id = randomId();
      idMap.set(n.id, id);
      (n.type === "group" ? groups : others).push({ ...n, id });
    }
    this.canvasData.nodes = [...groups, ...this.canvasData.nodes, ...others];
    for (const e of edges) this.canvasData.edges.push({ ...e, id: randomId(), fromNode: idMap.get(e.fromNode)!, toNode: idMap.get(e.toNode)! });
    this.syncAll();
    this.selectOnly([...idMap.values()]);
    return [...idMap.values()];
  }

  private nodeAt(clientX: number, clientY: number, exclude?: string): CanvasNodeView | null {
    const stack = document.elementsFromPoint(clientX, clientY);
    for (const el of stack) {
      const nodeEl = (el as HTMLElement).closest?.(".canvas-node") as HTMLElement | null;
      if (!nodeEl || !this.canvasEl.contains(nodeEl)) continue;
      const id = nodeEl.dataset.id!;
      if (id === exclude) continue;
      const view = this.nodes.get(id);
      if (view) return view;
    }
    return null;
  }

  private resizeRect(r0: Rect, handle: string, dx: number, dy: number, keepAspect: boolean, snap: boolean): Rect {
    let { x, y, width, height } = r0;
    const s = (v: number) => (snap ? Math.round(v / GRID) * GRID : Math.round(v));
    if (handle.includes("e")) width = s(r0.x + r0.width + dx) - x;
    if (handle.includes("s")) height = s(r0.y + r0.height + dy) - y;
    if (handle.includes("w")) {
      x = s(r0.x + dx);
      width = r0.x + r0.width - x;
    }
    if (handle.includes("n")) {
      y = s(r0.y + dy);
      height = r0.y + r0.height - y;
    }
    if (width < MIN_W) {
      if (handle.includes("w")) x = r0.x + r0.width - MIN_W;
      width = MIN_W;
    }
    if (height < MIN_H) {
      if (handle.includes("n")) y = r0.y + r0.height - MIN_H;
      height = MIN_H;
    }
    if (keepAspect && r0.height > 0) {
      const ratio = r0.width / r0.height;
      if (handle === "n" || handle === "s") width = Math.round(height * ratio);
      else height = Math.round(width / ratio);
      if (handle.includes("n")) y = r0.y + r0.height - height;
      if (handle.includes("w")) x = r0.x + r0.width - width;
    }
    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  }

  /** Grid and object snapping for a move; draws alignment guides. */
  private snapMove(ids: string[], origin: Map<string, Point>, dx: number, dy: number, enabled: boolean): [number, number] {
    this.guidesG.replaceChildren();
    const settings = this.settings();
    if (!enabled) return [dx, dy];
    const moving = new Set(ids);
    const rects = ids.map((id) => {
      const d = this.nodeData(id)!;
      const o = origin.get(id)!;
      return { x: o.x, y: o.y, width: d.width, height: d.height };
    });
    const box = unionRect(rects);
    if (!box) return [dx, dy];
    let bx = box.x + dx;
    let by = box.y + dy;
    if (settings.snapToGrid) {
      dx += Math.round(bx / GRID) * GRID - bx;
      dy += Math.round(by / GRID) * GRID - by;
      bx = box.x + dx;
      by = box.y + dy;
    }
    if (!settings.snapToObjects) return [dx, dy];
    const threshold = 8 / this.zoom;
    let bestX: { diff: number; line: number; other: Rect } | null = null;
    let bestY: { diff: number; line: number; other: Rect } | null = null;
    const xs = [bx, bx + box.width / 2, bx + box.width];
    const ys = [by, by + box.height / 2, by + box.height];
    for (const n of this.canvasData.nodes) {
      if (moving.has(n.id)) continue;
      for (const ox of [n.x, n.x + n.width / 2, n.x + n.width]) {
        for (const mx of xs) {
          const diff = ox - mx;
          if (Math.abs(diff) <= threshold && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) bestX = { diff, line: ox, other: n };
        }
      }
      for (const oy of [n.y, n.y + n.height / 2, n.y + n.height]) {
        for (const my of ys) {
          const diff = oy - my;
          if (Math.abs(diff) <= threshold && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) bestY = { diff, line: oy, other: n };
        }
      }
    }
    const guide = (x1: number, y1: number, x2: number, y2: number) => {
      const l = document.createElementNS(SVG_NS, "line");
      l.setAttribute("x1", String(x1));
      l.setAttribute("y1", String(y1));
      l.setAttribute("x2", String(x2));
      l.setAttribute("y2", String(y2));
      this.guidesG.appendChild(l);
    };
    if (bestX) {
      dx += bestX.diff;
      const top = Math.min(by, bestX.other.y);
      const bottom = Math.max(by + box.height, bestX.other.y + bestX.other.height);
      guide(bestX.line, top, bestX.line, bottom);
    }
    if (bestY) {
      dy += bestY.diff;
      const left = Math.min(box.x + dx, bestY.other.x);
      const right = Math.max(box.x + dx + box.width, bestY.other.x + bestY.other.width);
      guide(left, bestY.line, right, bestY.line);
    }
    return [dx, dy];
  }

  private onPointerUp(e: PointerEvent) {
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    this.gesture = null;
    this.wrapperEl.removeClass("is-panning", "is-dragging");
    this.guidesG.replaceChildren();
    const world = this.toWorld(e.clientX, e.clientY);
    switch (g.kind) {
      case "marquee":
        g.el.remove();
        this.updateSelection();
        break;
      case "move":
        if (g.moved) this.commit();
        else if (g.toggleOnUp) {
          this.selectedNodes.delete(g.toggleOnUp);
        } else if (g.clickSelect) {
          this.selectOnly([g.clickSelect]);
        }
        this.updateSelection();
        break;
      case "resize":
        if (g.moved) {
          this.commit();
          this.nodes.get(g.id)?.invalidate();
        }
        this.updateSelection();
        break;
      case "connect": {
        g.path.remove();
        this.canvasEl.querySelectorAll(".canvas-node.is-connection-target").forEach((n) => n.removeClass("is-connection-target"));
        const over = this.nodeAt(e.clientX, e.clientY, g.fromId);
        const existing = g.edgeId ? this.edges.get(g.edgeId) : null;
        if (existing) existing.g.style.opacity = "";
        if (existing && g.end) {
          if (!over) {
            // Dragging an end off every card removes the connection.
            this.canvasData.edges = this.canvasData.edges.filter((x) => x.id !== existing.data.id);
          } else {
            const side = nearestSide(over.data, world.x, world.y);
            if (g.end === "from") {
              existing.data.fromNode = over.data.id;
              existing.data.fromSide = side;
            } else {
              existing.data.toNode = over.data.id;
              existing.data.toSide = side;
            }
          }
          this.syncAll();
          this.commit();
          break;
        }
        const from = this.nodeData(g.fromId);
        if (!from) break;
        let toId: string;
        let toSide: Side;
        if (over) {
          toId = over.data.id;
          toSide = nearestSide(over.data, world.x, world.y);
        } else {
          if (Math.hypot(world.x - sidePoint(from, g.fromSide).x, world.y - sidePoint(from, g.fromSide).y) < 20) break;
          const created = this.addNode({ type: "text", text: "" }, { x: world.x + (g.fromSide === "left" ? -125 : g.fromSide === "right" ? 125 : 0), y: world.y + (g.fromSide === "top" ? -30 : g.fromSide === "bottom" ? 30 : 0) }, { record: false, select: false });
          toId = created.id;
          toSide = sideFacing(created, sidePoint(from, g.fromSide).x, sidePoint(from, g.fromSide).y);
        }
        const edge: CanvasEdgeData = { id: randomId(), fromNode: g.fromId, fromSide: g.fromSide, toNode: toId, toSide };
        this.canvasData.edges.push(edge);
        this.syncAll();
        if (!over) {
          this.selectOnly([toId]);
          this.commit();
          void this.nodes.get(toId)?.startEditing();
        } else {
          this.selectOnly([], [edge.id]);
          this.commit();
        }
        break;
      }
      case "card": {
        g.ghost?.remove();
        const r = this.wrapperEl.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && !(e.target as HTMLElement).closest?.(".canvas-card-menu");
        const at = g.moved && inside ? world : this.viewportCenter();
        if (!g.moved || inside) this.addFromCardMenu(g.type, at);
        break;
      }
      case "pan":
        break;
    }
  }

  addFromCardMenu(type: "text" | "note" | "media" | "group" | "webpage", at: Point) {
    switch (type) {
      case "text":
        this.addNode({ type: "text", text: "" }, at, { edit: true });
        break;
      case "group":
        this.addNode({ type: "group" }, at, {});
        break;
      case "note":
        new FileSuggestModal(this.app, (f) => DOCUMENT_EXTENSIONS.includes(f.extension) && f !== this.file, (f) => this.addFileNode(f, at), "Type to search for a note…").open();
        break;
      case "media":
        new FileSuggestModal(this.app, (f) => MEDIA_EXTENSIONS.includes(f.extension.toLowerCase()), (f) => this.addFileNode(f, at), "Type to search for media…").open();
        break;
      case "webpage":
        new PromptModal(this.app, "Add web page", "https://", "", "Add", (url) => {
          const full = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
          this.addNode({ type: "link", url: full }, at, {});
        }).open();
        break;
    }
  }

  private onDoubleClick(e: MouseEvent) {
    const el = e.target as HTMLElement;
    if (el.closest?.(".canvas-controls, .canvas-card-menu, .canvas-menu-container")) return;
    if (this.readOnly || this.spaceDown) return;
    const groupLabel = el.closest?.(".canvas-group-label");
    const nodeEl = el.closest?.(".canvas-node") as HTMLElement | null;
    if (groupLabel && nodeEl) {
      const node = this.nodes.get(nodeEl.dataset.id!);
      if (node) this.editGroupLabel(node);
      return;
    }
    const edgeEl = el.closest?.(".canvas-path, .canvas-path-label-wrapper") as HTMLElement | null;
    if (edgeEl && !nodeEl) {
      const id = edgeEl.dataset.id ?? (edgeEl.closest(".canvas-path") as HTMLElement | null)?.dataset.id;
      const edge = id ? this.edges.get(id) : null;
      if (edge) {
        this.selectOnly([], [edge.data.id]);
        this.editEdgeLabel(edge);
      }
      return;
    }
    if (nodeEl) {
      const node = this.nodes.get(nodeEl.dataset.id!);
      if (!node || node.editing) return;
      if (node.data.type === "group") return;
      if (node.canEdit()) void node.startEditing();
      else if (node.data.type === "file") {
        const file = node.file();
        if (file) void this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(file, { active: true });
      } else if (node.data.type === "link" && node.data.url) window.open(node.data.url, "_blank", "noopener");
      return;
    }
    if (el.closest?.(".canvas-wrapper") !== this.wrapperEl) return;
    this.addNode({ type: "text", text: "" }, this.toWorld(e.clientX, e.clientY), { edit: true });
  }

  private onWheel(e: WheelEvent) {
    const el = e.target as HTMLElement;
    if (el.closest?.(".canvas-controls, .canvas-card-menu, .canvas-menu-container")) return;
    const nodeEl = el.closest?.(".canvas-node") as HTMLElement | null;
    if (nodeEl && !e.ctrlKey && !e.metaKey) {
      const node = this.nodes.get(nodeEl.dataset.id!);
      // A selected card's content scrolls natively when it can.
      if (node && (node.editing || this.selectedNodes.has(node.data.id))) {
        const scroller = this.scrollableAncestor(el, nodeEl, e.deltaY);
        if (scroller) return;
      }
    }
    e.preventDefault();
    const p = this.local(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.wrapperEl.clientHeight : 1;
    const zoomMode = e.ctrlKey || e.metaKey || this.spaceDown || (this.settings().defaultWheelBehavior === "zoom" && !e.shiftKey);
    if (zoomMode) {
      const factor = Math.pow(2, -e.deltaY * unit * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002));
      this.zoomAt(p.x, p.y, factor);
    } else {
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      this.tx -= dx * unit;
      this.ty -= dy * unit;
      this.applyTransform();
    }
  }

  private scrollableAncestor(el: HTMLElement, stop: HTMLElement, deltaY: number): HTMLElement | null {
    let cur: HTMLElement | null = el;
    while (cur && cur !== stop) {
      if (cur.scrollHeight > cur.clientHeight + 1) {
        const style = getComputedStyle(cur);
        if (/(auto|scroll)/.test(style.overflowY)) {
          if ((deltaY < 0 && cur.scrollTop > 0) || (deltaY > 0 && cur.scrollTop + cur.clientHeight < cur.scrollHeight - 1)) return cur;
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // ---- context menus ----------------------------------------------------------------------------------------

  private onContextMenu(e: MouseEvent) {
    const el = e.target as HTMLElement;
    if (el.closest?.(".canvas-controls, .canvas-card-menu, .canvas-menu-container")) return;
    const nodeEl = el.closest?.(".canvas-node") as HTMLElement | null;
    const editing = nodeEl ? this.nodes.get(nodeEl.dataset.id!)?.editing : false;
    if (editing) return;
    e.preventDefault();
    const world = this.toWorld(e.clientX, e.clientY);
    const menu = new Menu();
    const edgeEl = el.closest?.(".canvas-path, .canvas-path-label-wrapper") as HTMLElement | null;
    if (nodeEl) {
      const node = this.nodes.get(nodeEl.dataset.id!);
      if (!node) return;
      if (!this.selectedNodes.has(node.data.id)) this.selectOnly([node.data.id]);
      this.fillNodeMenu(menu, node);
    } else if (edgeEl) {
      const id = edgeEl.dataset.id ?? (edgeEl.closest(".canvas-path") as HTMLElement | null)?.dataset.id;
      const edge = id ? this.edges.get(id) : null;
      if (!edge) return;
      this.selectOnly([], [edge.data.id]);
      this.fillEdgeMenu(menu, edge);
    } else {
      this.fillCanvasMenu(menu, world);
    }
    menu.showAtMouseEvent(e);
  }

  private fillCanvasMenu(menu: Menu, at: Point) {
    menu.addSections(["add", "clipboard", "select", "view"]);
    const ro = this.readOnly;
    const item = (section: string, title: string, icon: string, fn: () => void, disabled = ro) => menu.addItem((i) => i.setSection(section).setTitle(title).setIcon(icon).setDisabled(disabled).onClick(fn));
    item("add", "Add card", "lucide-sticky-note", () => this.addFromCardMenu("text", at));
    item("add", "Add note from vault", "lucide-file-text", () => this.addFromCardMenu("note", at));
    item("add", "Add media from vault", "lucide-image", () => this.addFromCardMenu("media", at));
    item("add", "Add web page", "lucide-globe", () => this.addFromCardMenu("webpage", at));
    item("add", "Create group", "lucide-box-select", () => this.addFromCardMenu("group", at));
    item("clipboard", "Paste", "lucide-clipboard-paste", () => void this.pasteFromClipboard(at));
    item("select", "Select all", "lucide-box-select", () => this.selectOnly(this.canvasData.nodes.map((n) => n.id)), false);
    item("view", "Zoom to fit", "lucide-maximize", () => this.zoomToFit(), false);
  }

  private fillNodeMenu(menu: Menu, node: CanvasNodeView) {
    menu.addSections(["edit", "open", "background", "arrange", "view", "danger"]);
    const ro = this.readOnly;
    const d = node.data;
    const multi = this.selectedNodes.size > 1;
    const item = (section: string, title: string, icon: string, fn: () => void, disabled = ro) => menu.addItem((i) => i.setSection(section).setTitle(title).setIcon(icon).setDisabled(disabled).onClick(fn));
    if (!multi) {
      if (node.canEdit()) item("edit", "Edit", "lucide-pencil", () => void node.startEditing());
      if (d.type === "text") item("edit", "Convert to file...", "lucide-file-input", () => this.convertToFile(d.id));
      if (d.type === "file") {
        const file = node.file();
        if (file) {
          item("open", "Open file", "lucide-file", () => void this.app.workspace.getLeaf(false).openFile(file, { active: true }), false);
          item("open", "Open in new tab", "lucide-file-plus", () => void this.app.workspace.getLeaf("tab").openFile(file, { active: true }), false);
        }
        item("edit", "Swap file...", "lucide-replace", () =>
          new FileSuggestModal(this.app, () => true, (f) => {
            d.file = f.path;
            delete d.subpath;
            node.invalidate();
            this.commit();
          }, "Choose a file…").open(),
        );
        if (file?.extension === "md") {
          const cache = this.app.metadataCache.getFileCache(file);
          const headings: { heading: string }[] = cache?.headings ?? [];
          if (headings.length)
            item("edit", "Narrow to heading...", "lucide-heading", () =>
              new ItemSuggestModal(this.app, headings, (h) => h.heading, (h) => {
                d.subpath = `#${h.heading}`;
                node.invalidate();
                this.commit();
              }, "Choose a heading…").open(),
            );
          if (d.subpath)
            item("edit", "Show entire file", "lucide-file-text", () => {
              delete d.subpath;
              node.invalidate();
              this.commit();
            });
        }
        if (file) this.app.workspace.trigger("file-menu", menu, file, "canvas-menu", this.leaf);
      }
      if (d.type === "link") {
        item("open", "Open in browser", "lucide-external-link", () => window.open(d.url, "_blank", "noopener"), false);
        item("edit", "Change URL...", "lucide-link", () =>
          new PromptModal(this.app, "Change URL", "https://", d.url ?? "", "Save", (url) => {
            d.url = url;
            node.invalidate();
            this.commit();
          }).open(),
        );
        item("edit", "Reload page", "lucide-refresh-cw", () => node.invalidate(), false);
      }
      if (d.type === "group") {
        item("edit", "Edit label", "lucide-pencil", () => this.editGroupLabel(node));
        item("edit", d.background ? "Replace background" : "Set background", "lucide-image", () =>
          new FileSuggestModal(this.app, (f) => IMAGE_EXTENSIONS.includes(f.extension.toLowerCase()), (f) => {
            d.background = f.path;
            node.invalidate();
            this.commit();
          }, "Choose an image…").open(),
        );
        if (d.background) {
          for (const [style, title] of [["cover", "Cover"], ["ratio", "Keep aspect ratio"], ["repeat", "Repeat"]] as const)
            menu.addItem((i) =>
              i
                .setSection("background")
                .setTitle(title)
                .setChecked((d.backgroundStyle ?? "cover") === style)
                .setDisabled(ro)
                .onClick(() => {
                  if (style === "cover") delete d.backgroundStyle;
                  else d.backgroundStyle = style;
                  node.invalidate();
                  this.commit();
                }),
            );
          item("background", "Remove background", "lucide-image-off", () => {
            delete d.background;
            delete d.backgroundStyle;
            node.invalidate();
            this.commit();
          });
        }
      }
    }
    item("arrange", "Create group", "lucide-box-select", () => this.groupSelection());
    item("arrange", "Duplicate", "lucide-copy", () => this.duplicateSelection());
    item("view", "Zoom to selection", "lucide-scan", () => this.zoomToSelection(), false);
    item("danger", "Remove", "lucide-trash-2", () => this.removeSelection());
  }

  private fillEdgeMenu(menu: Menu, edge: CanvasEdgeView) {
    menu.addSections(["edit", "direction", "navigate", "danger"]);
    const ro = this.readOnly;
    const d = edge.data;
    const item = (section: string, title: string, icon: string, fn: () => void, disabled = ro) => menu.addItem((i) => i.setSection(section).setTitle(title).setIcon(icon).setDisabled(disabled).onClick(fn));
    item("edit", "Edit label", "lucide-pencil", () => this.editEdgeLabel(edge));
    if (d.label)
      item("edit", "Remove label", "lucide-eraser", () => {
        delete d.label;
        this.updateEdges();
        this.commit();
      });
    for (const [title, from, to] of [["Nondirectional", "none", "none"], ["Unidirectional", "none", "arrow"], ["Bidirectional", "arrow", "arrow"]] as const)
      menu.addItem((i) =>
        i
          .setSection("direction")
          .setTitle(title)
          .setChecked((d.fromEnd ?? "none") === from && (d.toEnd ?? "arrow") === to)
          .setDisabled(ro)
          .onClick(() => {
            if (from === "none") delete d.fromEnd;
            else d.fromEnd = from;
            if (to === "arrow") delete d.toEnd;
            else d.toEnd = to;
            this.updateEdges();
            this.commit();
          }),
      );
    item("navigate", "Go to source", "lucide-arrow-left", () => this.focusNode(d.fromNode), false);
    item("navigate", "Go to target", "lucide-arrow-right", () => this.focusNode(d.toNode), false);
    item("danger", "Remove", "lucide-trash-2", () => this.removeSelection());
  }

  focusNode(id: string) {
    const d = this.nodeData(id);
    if (!d) return;
    this.selectOnly([id]);
    this.zoomToRect(d, Math.max(this.zoom, 0.5));
  }

  // ---- keyboard & clipboard ------------------------------------------------------------------------------------

  private isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.closest) return false;
    return !!el.closest("input, textarea, select, [contenteditable='true'], .cm-editor");
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.isTyping(e.target)) return;
    const mod = Keymap.isModifier(e, "Mod");
    if (e.key === " ") {
      this.setSpace(true);
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.selectOnly(this.canvasData.nodes.map((n) => n.id));
      return;
    }
    if (e.shiftKey && !mod && (e.code === "Digit1" || e.key === "!")) {
      e.preventDefault();
      this.zoomToFit();
      return;
    }
    if (e.shiftKey && !mod && (e.code === "Digit2" || e.key === "@")) {
      e.preventDefault();
      this.zoomToSelection();
      return;
    }
    switch (e.key) {
      case "Delete":
      case "Backspace":
        e.preventDefault();
        this.removeSelection();
        return;
      case "Escape":
        this.closeSubmenu();
        this.deselectAll();
        return;
      case "Enter": {
        if (this.selectedNodes.size !== 1) return;
        const node = this.nodes.get([...this.selectedNodes][0]!);
        if (node?.canEdit()) {
          e.preventDefault();
          void node.startEditing();
        }
        return;
      }
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        const step = e.shiftKey ? GRID * 5 : this.settings().snapToGrid ? GRID : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (this.selectedNodes.size === 0 || this.readOnly) {
          this.tx -= dx * this.zoom * 2;
          this.ty -= dy * this.zoom * 2;
          this.applyTransform();
          return;
        }
        const ids = this.movingIds();
        for (const id of ids) {
          const d = this.nodeData(id);
          if (!d) continue;
          d.x += dx;
          d.y += dy;
        }
        this.afterNodesMoved(new Set(ids));
        this.commit();
        return;
      }
    }
  }

  private isActiveCanvas(): boolean {
    const active = document.activeElement;
    return !!active && this.wrapperEl.contains(active) && !this.isTyping(active);
  }

  private onCopy(e: ClipboardEvent, cut: boolean) {
    if (!this.isActiveCanvas() || this.selectedNodes.size === 0) return;
    const data = this.copySelection();
    e.clipboardData?.setData("text/plain", JSON.stringify({ nodes: data.nodes, edges: data.edges }, null, "\t"));
    e.preventDefault();
    if (cut) this.removeSelection();
  }

  private onPaste(e: ClipboardEvent) {
    if (!this.isActiveCanvas() || this.readOnly) return;
    const at = this.lastPointer ?? this.viewportCenter();
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      void this.importOsFiles(files, at);
      return;
    }
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    e.preventDefault();
    this.pasteText(text, at);
  }

  private async pasteFromClipboard(at: Point) {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.pasteText(text, at);
    } catch {
      new Notice("Paste with the keyboard (Mod+V): the browser blocked clipboard access.");
    }
  }

  private pasteText(text: string, at: Point) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = parseCanvas(trimmed);
        if (parsed.nodes.length) {
          this.pasteData(parsed, at);
          return;
        }
      } catch {
        /* not canvas JSON */
      }
    }
    if (/^https?:\/\/\S+$/i.test(trimmed)) {
      this.addNode({ type: "link", url: trimmed }, at, {});
      return;
    }
    const wikilink = /^!?\[\[([^\]|#]+)(#[^\]|]+)?(?:\|[^\]]*)?\]\]$/.exec(trimmed);
    if (wikilink) {
      const file = this.app.metadataCache.getFirstLinkpathDest(wikilink[1]!, this.file?.path ?? "") as TFile | null;
      if (file) {
        const node = this.addFileNode(file, at, false);
        if (wikilink[2]) node.subpath = wikilink[2];
        this.nodes.get(node.id)?.invalidate();
        this.commit();
        return;
      }
    }
    const lines = trimmed.split("\n").length;
    this.addNode({ type: "text", text, height: Math.min(400, 40 + lines * 24) }, at, {});
  }

  // ---- drag and drop ---------------------------------------------------------------------------------------------

  private onDrop(evt: DragEvent, data: any, isOver: boolean): boolean {
    if (this.readOnly) return false;
    const types = Array.from(evt.dataTransfer?.types ?? []);
    const internal = data && ["file", "files", "folder", "link"].includes(data.type);
    const external = types.includes("Files") || types.includes("text/uri-list") || types.includes("text/plain") || types.includes("text/html");
    if (!internal && !external) return false;
    if (isOver) {
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = internal ? "link" : "copy";
      return true;
    }
    evt.preventDefault();
    const at = this.toWorld(evt.clientX, evt.clientY);
    if (internal) {
      const files: TFile[] = [];
      const collect = (f: TAbstractFile | undefined | null) => {
        if (!f) return;
        if (f instanceof TFile) files.push(f);
        else if (f instanceof TFolder) f.children.forEach(collect);
      };
      if (data.type === "link") collect(this.app.metadataCache.getFirstLinkpathDest(String(data.linktext).split("#")[0], data.sourcePath ?? ""));
      else if (data.type === "files") (data.files as TAbstractFile[]).forEach(collect);
      else collect(data.file);
      this.addFiles(files.filter((f) => f !== this.file), at);
      return true;
    }
    const osFiles = Array.from(evt.dataTransfer?.files ?? []);
    if (osFiles.length) {
      void this.importOsFiles(osFiles, at);
      return true;
    }
    const uri = evt.dataTransfer?.getData("text/uri-list")?.split("\n").find((l) => l && !l.startsWith("#"));
    if (uri) {
      const open = /^obsidian:\/\/open\?.*file=([^&]+)/.exec(uri);
      const file = open ? (this.app.vault.getFileByPath(decodeURIComponent(open[1]!)) as TFile | null) : null;
      if (file) this.addFileNode(file, at);
      else this.addNode({ type: "link", url: uri.trim() }, at, {});
      return true;
    }
    const text = evt.dataTransfer?.getData("text/plain");
    if (text) this.pasteText(text, at);
    return true;
  }

  private addFiles(files: TFile[], at: Point) {
    if (!files.length) return;
    const ids: string[] = [];
    const cols = Math.ceil(Math.sqrt(files.length));
    files.forEach((f, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const node = this.addFileNode(f, { x: at.x + col * 440, y: at.y + row * 440 }, false);
      ids.push(node.id);
    });
    this.selectOnly(ids);
    this.commit();
  }

  private async importOsFiles(files: File[], at: Point) {
    const created: TFile[] = [];
    for (const f of files) {
      try {
        const path = await this.app.fileManager.getAvailablePathForAttachment(f.name || "Pasted file", this.file?.path ?? "");
        created.push(await this.app.vault.createBinary(path, await f.arrayBuffer()));
      } catch (e) {
        new Notice(`Could not import ${f.name}: ${(e as Error).message}`);
      }
    }
    this.addFiles(created, at);
  }

  // ---- rename support (used by the plugin) -------------------------------------------------------------------------

  /** Update file references after a rename; returns whether anything changed. */
  // internal
  applyRename(oldPath: string, newPath: string): boolean {
    let changed = false;
    for (const n of this.canvasData.nodes) {
      if (n.file === oldPath) {
        n.file = newPath;
        changed = true;
        this.nodes.get(n.id)?.invalidate();
      }
      if (n.background === oldPath) {
        n.background = newPath;
        changed = true;
        this.nodes.get(n.id)?.invalidate();
      }
    }
    if (changed) this.commit();
    return changed;
  }

  // ---- export ---------------------------------------------------------------------------------------------------------

  override onPaneMenu(menu: Menu, source: string): void {
    menu.addItem((i) => i.setSection("action").setTitle("Export as image").setIcon("lucide-image-down").onClick(() => this.plugin.exportImage(this)));
    menu.addItem((i) => i.setSection("action").setTitle("Jump to group").setIcon("lucide-box-select").onClick(() => this.jumpToGroup()));
    super.onPaneMenu(menu, source);
  }

  jumpToGroup() {
    const groups = this.canvasData.nodes.filter((n) => n.type === "group");
    if (!groups.length) {
      new Notice("This canvas has no groups.");
      return;
    }
    new ItemSuggestModal(this.app, groups, (g) => g.label || "Untitled group", (g) => this.focusNode(g.id), "Type the name of a group to navigate to…").open();
  }
}
