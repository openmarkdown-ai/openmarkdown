/**
 * Graph view (`graph`) and local graph (`localgraph`).
 *
 * Data comes from the Rust index (`metadataCache.index.graph`), layout from
 * the engine's force layout stepped each animation frame, and drawing from a
 * WebGL2 renderer (Canvas2D fallback) with labels on a 2D overlay.
 */
import type { GraphData, GraphNode } from "@vault/engine";
import type { ViewStateResult } from "obsidian";
import { customTitle, displayTitleSource } from "../file-explorer/note-titles";
import { Keymap } from "../../obsidian/ui/keymap";
import { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { debounce } from "../../obsidian/util";
import { TFile, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ItemView } from "../../obsidian/workspace/view";
import { readGraphColors, rgbaToCss, type GraphColors, type RGBA } from "./colors";
import { GraphControls, type ChangeKind } from "./controls";
import { DEFAULT_GRAPH_OPTIONS, DEFAULT_LOCAL_GRAPH_OPTIONS, normalizeOptions, type GraphOptions, type LocalGraphOptions } from "./options";
import { createRenderer, NodeState, type GraphRenderer } from "./renderer";
import { GraphSimulation } from "./simulation";

export const VIEW_TYPE_GRAPH = "graph";
export const VIEW_TYPE_LOCAL_GRAPH = "localgraph";

export interface GraphPluginHost {
  instance: { options: Record<string, any>; saveOptions(): Promise<void> };
  /** Global graph options changed in one view: others follow. */
  onGlobalOptionsChanged(source: GraphView): void;
}

const MIN_SCALE = 1 / 64;
const MAX_SCALE = 16;
const DIM_ALPHA = 0.18;
const FADE_MS = 160;

export interface GraphStats {
  renderer: string;
  nodes: number;
  links: number;
  fps: number;
  frameMs: number;
  stepMs: number;
  drawMs: number;
  labelMs: number;
  simulating: boolean;
}

export class GraphView extends ItemView {
  options: GraphOptions | LocalGraphOptions;
  file: TFile | null = null;
  readonly isLocal: boolean;
  stats: GraphStats = { renderer: "", nodes: 0, links: 0, fps: 0, frameMs: 0, stepMs: 0, drawMs: 0, labelMs: 0, simulating: false };

  private plugin: GraphPluginHost;
  private canvasEl!: HTMLCanvasElement;
  private labelEl!: HTMLCanvasElement;
  private labelCtx!: CanvasRenderingContext2D;
  private renderer: GraphRenderer | null = null;
  private controls: GraphControls | null = null;
  private sim: GraphSimulation;
  private colors: GraphColors | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // graph
  private nodes: GraphNode[] = [];
  private links: Uint32Array = new Uint32Array(0);
  private radius: Float32Array = new Float32Array(0);
  private state: Uint8Array = new Uint8Array(0);
  private nodeColors: Float32Array = new Float32Array(0);
  private adjStart: Uint32Array = new Uint32Array(1);
  private adjList: Uint32Array = new Uint32Array(0);
  private fullData: GraphData | null = null;
  private maxRadius = 0;

  // camera
  private cx = 0;
  private cy = 0;
  private scale = 1;
  private width = 0;
  private height = 0;
  private dpr = 1;

  // interaction
  private hoverIndex = -1;
  private hovering = false;
  private fade = 0;
  private fadeTarget = 0;
  private drag: { index: number; pointerId: number; x: number; y: number; moved: boolean; pan: boolean; cx: number; cy: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; scale: number } | null = null;

  // frame loop
  private raf = 0;
  private lastFrame = 0;
  private fpsFrames = 0;
  private fpsStart = 0;
  private dirty = true;
  private animation: { order: number[]; shown: number; last: number } | null = null;
  private opened = false;

  private requestRefresh = debounce(() => this.refreshData(), 250, false);
  private saveScale = debounce(() => this.onOptionsChange("ui"), 800, true);

  constructor(leaf: WorkspaceLeaf, plugin: GraphPluginHost, isLocal: boolean) {
    super(leaf);
    this.plugin = plugin;
    this.isLocal = isLocal;
    this.icon = "lucide-git-fork";
    this.options = isLocal ? normalizeOptions(null, DEFAULT_LOCAL_GRAPH_OPTIONS) : normalizeOptions(plugin.instance.options, DEFAULT_GRAPH_OPTIONS);
    this.scale = this.options.scale || 1;
    this.sim = new GraphSimulation(this.options);
  }

  getViewType(): string {
    return this.isLocal ? VIEW_TYPE_LOCAL_GRAPH : VIEW_TYPE_GRAPH;
  }

  getDisplayText(): string {
    if (this.isLocal) return this.file ? `Graph of ${this.file.basename}` : "Graph view";
    return "Graph view";
  }

  override getIcon(): string {
    return "lucide-git-fork";
  }

  // ---- lifecycle ----------------------------------------------------------------------

  override async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.addClass("vault-graph-content");
    el.setAttr("tabindex", "-1");
    this.canvasEl = el.createEl("canvas", { cls: "vault-graph-canvas" });
    this.labelEl = el.createEl("canvas", { cls: "vault-graph-labels" });
    this.labelCtx = this.labelEl.getContext("2d")!;
    const params = new URLSearchParams(location.search);
    this.renderer = createRenderer(this.canvasEl, params.get("graphRenderer") !== "canvas2d");
    this.stats.renderer = this.renderer.kind;
    this.controls = new GraphControls(el, this);
    this.readColors();
    this.opened = true;

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(el);
    this.onResize();

    this.registerDomEvent(el, "pointerdown", (e) => this.onPointerDown(e));
    this.registerDomEvent(el, "pointermove", (e) => this.onPointerMove(e));
    this.registerDomEvent(el, "pointerup", (e) => this.onPointerUp(e));
    this.registerDomEvent(el, "pointercancel", (e) => this.onPointerUp(e));
    this.registerDomEvent(el, "pointerleave", (e) => {
      if (!this.drag && e.pointerType === "mouse") this.setHover(-1);
    });
    this.registerDomEvent(el, "wheel", (e) => this.onWheel(e), { passive: false });
    this.registerDomEvent(el, "contextmenu", (e) => this.onContextMenu(e));
    this.registerDomEvent(el, "keydown", (e) => this.onKeyDown(e));

    this.registerEvent(this.app.workspace.on("css-change", () => this.readColors()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.requestRefresh()));
    const onFiles = (f: TAbstractFile) => {
      if (f instanceof TFile) this.requestRefresh();
    };
    this.registerEvent(this.app.vault.on("create", onFiles));
    this.registerEvent(this.app.vault.on("delete", onFiles));
    this.registerEvent(this.app.vault.on("rename", onFiles));
    if (this.isLocal) {
      this.registerEvent(
        this.app.workspace.on("file-open", (file: TFile | null) => {
          if (!file || this.leaf.group || file === this.file) return;
          if (this.app.workspace.activeLeaf === this.leaf) return;
          void this.setFile(file);
        }),
      );
      if (!this.file) {
        const active = this.app.workspace.getActiveFile();
        if (active) this.file = active;
      }
    }
    this.refreshData();
  }

  override async onClose(): Promise<void> {
    this.opened = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.requestRefresh.cancel();
    this.saveScale.run();
    this.sim.free();
    this.renderer?.destroy();
    this.renderer = null;
  }

  override onResize(): void {
    if (!this.renderer) return;
    const rect = this.contentEl.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = window.devicePixelRatio || 1;
    this.renderer.resize(this.width, this.height, this.dpr);
    const lw = Math.max(1, Math.round(this.width * this.dpr));
    const lh = Math.max(1, Math.round(this.height * this.dpr));
    if (this.labelEl.width !== lw) this.labelEl.width = lw;
    if (this.labelEl.height !== lh) this.labelEl.height = lh;
    this.requestFrame();
  }

  // ---- state ---------------------------------------------------------------------------

  override getState(): Record<string, unknown> {
    if (!this.isLocal) return {};
    return { file: this.file?.path ?? null, options: { ...this.options } };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    if (this.isLocal && state && typeof state === "object") {
      if (state.options) {
        this.options = normalizeOptions(state.options, DEFAULT_LOCAL_GRAPH_OPTIONS);
        this.scale = this.options.scale || 1;
        this.sim.setForces(this.options);
        this.controls?.render();
      }
      const path = typeof state.file === "string" ? state.file : null;
      const file = path ? this.app.vault.getFileByPath(path) : null;
      if (file && file !== this.file) await this.setFile(file);
    }
    await super.setState(state, result);
  }

  // internal
  async setFile(file: TFile | null) {
    this.file = file;
    this.updateHeader();
    this.leaf.updateHeader();
    this.refreshData();
    this.app.workspace.requestSaveLayout();
  }

  // ---- controls host ---------------------------------------------------------------------

  onOptionsChange(kind: ChangeKind) {
    if (kind === "data") this.refreshData();
    else if (kind === "style") this.restyle();
    else if (kind === "forces") this.sim.setForces(this.options);
    this.requestFrame();
    if (this.isLocal) {
      this.app.workspace.requestSaveLayout();
    } else {
      Object.assign(this.plugin.instance.options, this.options);
      void this.plugin.instance.saveOptions();
      if (kind !== "ui") this.plugin.onGlobalOptionsChanged(this);
    }
  }

  /** A sibling global graph changed the shared options. */
  // internal
  syncFromGlobal() {
    if (this.isLocal) return;
    const scale = this.scale;
    this.options = normalizeOptions(this.plugin.instance.options, DEFAULT_GRAPH_OPTIONS);
    this.options.scale = scale;
    this.controls?.render();
    this.sim.setForces(this.options);
    this.refreshData();
  }

  onRestoreDefaults() {
    const keep = { close: this.options.close, scale: this.options.scale };
    this.options = normalizeOptions(keep, this.isLocal ? DEFAULT_LOCAL_GRAPH_OPTIONS : DEFAULT_GRAPH_OPTIONS);
    this.options.close = false;
    this.controls?.render();
    this.sim.setForces(this.options);
    this.onOptionsChange("data");
  }

  onAnimate() {
    const data = this.fullData;
    if (!data || data.nodes.length === 0) return;
    const ctime = (id: string) => this.app.vault.getFileByPath(id)?.stat.ctime ?? Number.POSITIVE_INFINITY;
    const times = data.nodes.map((n) => ctime(n.id));
    // Tags and unresolved nodes appear with their first linked file.
    for (const l of data.links) {
      const s = l.source;
      const t = l.target;
      if (!Number.isFinite(times[t]!)) times[t] = Math.min(times[t]!, times[s]! + 1);
      if (!Number.isFinite(times[s]!)) times[s] = Math.min(times[s]!, times[t]! + 1);
    }
    const order = data.nodes.map((_, i) => i).sort((a, b) => times[a]! - times[b]! || a - b);
    this.animation = { order, shown: 0, last: 0 };
    this.applyGraph([], [], true);
    this.requestFrame();
  }

  // ---- data ----------------------------------------------------------------------------

  // internal
  refreshData() {
    if (!this.opened) return;
    const index = this.app.metadataCache?.index;
    if (!index) return;
    if (this.isLocal && !this.file) {
      this.fullData = { nodes: [], links: [] };
      this.applyGraph([], []);
      return;
    }
    const o = this.options;
    const query: Record<string, unknown> = {
      search: o.search,
      showTags: o.showTags,
      showAttachments: o.showAttachments,
      hideUnresolved: o.hideUnresolved,
      showOrphans: o.showOrphans,
      colorGroups: o.colorGroups,
    };
    if (this.isLocal) {
      const lo = o as LocalGraphOptions;
      Object.assign(query, {
        localFile: this.file!.path,
        localJumps: lo.localJumps,
        localBacklinks: lo.localBacklinks,
        localForelinks: lo.localForelinks,
        localInterlinks: lo.localInterlinks,
      });
    }
    let data: GraphData;
    try {
      data = index.graph(query);
    } catch (e) {
      console.error("Graph data failed", e);
      return;
    }
    this.fullData = data;
    if (this.animation) return;
    this.applyGraph(data.nodes, data.links);
  }

  private applyGraph(nodes: GraphNode[], linkList: { source: number; target: number }[], reset = false) {
    const n = nodes.length;
    const flat: number[] = [];
    for (const l of linkList) {
      if (l.source === l.target || l.source >= n || l.target >= n) continue;
      flat.push(l.source, l.target);
    }
    const links = new Uint32Array(flat);
    const sameTopology =
      !reset &&
      n === this.nodes.length &&
      links.length === this.links.length &&
      nodes.every((node, i) => node.id === this.nodes[i]!.id) &&
      links.every((v, i) => v === this.links[i]);
    const hoveredId = this.hoverIndex >= 0 ? this.nodes[this.hoverIndex]?.id : undefined;
    const firstLoad = this.nodes.length === 0 && this.sim.nodeCount === 0;
    // "Show note title from" (Files and links): label by `title` property or first heading.
    if (displayTitleSource(this.app) !== "filename") {
      nodes = nodes.map((node) => {
        const title = customTitle(this.app, this.app.vault.getAbstractFileByPath(node.id));
        return title ? { ...node, label: title } : node;
      });
    }
    this.nodes = nodes;
    if (!sameTopology) {
      this.links = links;
      this.sim.setGraph(
        nodes.map((node) => node.id),
        links,
        reset,
      );
      this.renderer?.setLinks(n, links);
      this.buildAdjacency();
      this.radius = new Float32Array(n);
      this.state = new Uint8Array(n);
      this.nodeColors = new Float32Array(n * 4);
      this.hoverIndex = -1;
      this.hovering = false;
      this.fade = 0;
      this.fadeTarget = 0;
      if (hoveredId !== undefined) {
        const i = nodes.findIndex((node) => node.id === hoveredId);
        if (i >= 0) this.setHover(i);
      }
      if (firstLoad) {
        this.cx = 0;
        this.cy = 0;
      }
    }
    this.stats.nodes = n;
    this.stats.links = links.length >> 1;
    this.restyle();
  }

  private buildAdjacency() {
    const n = this.nodes.length;
    const deg = new Uint32Array(n + 1);
    const l = this.links;
    for (let k = 0; k < l.length; k += 2) {
      deg[l[k]!]!++;
      deg[l[k + 1]!]!++;
    }
    const start = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) start[i + 1] = start[i]! + deg[i]!;
    const fill = start.slice(0, n);
    const list = new Uint32Array(l.length);
    for (let k = 0; k < l.length; k += 2) {
      const a = l[k]!;
      const b = l[k + 1]!;
      list[fill[a]!++] = b;
      list[fill[b]!++] = a;
    }
    this.adjStart = start;
    this.adjList = list;
  }

  private readColors() {
    if (!this.opened && !this.contentEl.isConnected) return;
    this.colors = readGraphColors(this.contentEl);
    this.restyle();
  }

  private restyle() {
    const colors = this.colors;
    if (!colors) return;
    const o = this.options;
    const n = this.nodes.length;
    if (this.radius.length !== n) this.radius = new Float32Array(n);
    if (this.nodeColors.length !== n * 4) this.nodeColors = new Float32Array(n * 4);
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const node = this.nodes[i]!;
      const r = o.nodeSizeMultiplier * Math.max(8, Math.min(3 * Math.sqrt((node.weight ?? 0) + 1), 30));
      this.radius[i] = r;
      if (r > maxR) maxR = r;
      let c: RGBA;
      const group = node.group;
      if (node.kind === "tag") c = colors.fillTag;
      else if (node.kind === "attachment") c = colors.fillAttachment;
      else if (node.kind === "unresolved") c = colors.fillUnresolved;
      else if (this.isLocal && this.file && node.id === this.file.path) c = colors.fillFocused;
      else if (group !== undefined && group !== null && o.colorGroups[group]) {
        const g = o.colorGroups[group]!.color;
        c = [((g.rgb >> 16) & 255) / 255, ((g.rgb >> 8) & 255) / 255, (g.rgb & 255) / 255, g.a ?? 1];
      } else c = colors.fill;
      this.nodeColors.set(c, i * 4);
    }
    this.maxRadius = maxR;
    this.renderer?.setNodeColors(this.nodeColors);
    this.requestFrame();
  }

  // ---- camera ------------------------------------------------------------------------------

  private toWorld(sx: number, sy: number): [number, number] {
    return [this.cx + (sx - this.width / 2) / this.scale, this.cy + (sy - this.height / 2) / this.scale];
  }

  private zoomAt(sx: number, sy: number, factor: number) {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = next;
    this.cx = wx - (sx - this.width / 2) / next;
    this.cy = wy - (sy - this.height / 2) / next;
    this.options.scale = next;
    this.saveScale();
    this.requestFrame();
  }

  private localPoint(e: MouseEvent): [number, number] {
    const rect = this.contentEl.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  // ---- input ---------------------------------------------------------------------------------

  private isControlsEvent(e: Event) {
    return !!(e.target as HTMLElement | null)?.closest?.(".graph-controls");
  }

  private hitTest(sx: number, sy: number): number {
    const [wx, wy] = this.toWorld(sx, sy);
    const pos = this.sim.positions();
    const n = Math.min(this.nodes.length, pos.length >> 1);
    const slop = 3 / this.scale;
    const reach = this.maxRadius + slop + 2 / this.scale;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 2]! - wx;
      if (dx > reach || dx < -reach) continue;
      const dy = pos[i * 2 + 1]! - wy;
      if (dy > reach || dy < -reach) continue;
      const r = Math.max(this.radius[i]!, 1.25 / this.scale) + slop;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 <= bestD) {
        best = i;
        bestD = d2;
      }
    }
    return best;
  }

  private setHover(i: number) {
    if (i === this.hoverIndex) return;
    this.hoverIndex = i;
    this.canvasEl.toggleClass("is-hovering-node", i >= 0);
    this.contentEl.style.cursor = i >= 0 ? "pointer" : "";
    if (i >= 0) {
      this.state.fill(NodeState.Dimmed);
      for (let k = this.adjStart[i]!; k < this.adjStart[i + 1]!; k++) this.state[this.adjList[k]!] = NodeState.Neighbor;
      this.state[i] = NodeState.Hovered;
      this.hovering = true;
      this.fadeTarget = 1;
    } else {
      this.fadeTarget = 0;
    }
    this.requestFrame();
  }

  private onPointerDown(e: PointerEvent) {
    if (this.isControlsEvent(e)) return;
    this.contentEl.focus({ preventScroll: true });
    const [x, y] = this.localPoint(e);
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, { x, y });
      if (this.touches.size === 2) {
        const [a, b] = Array.from(this.touches.values());
        this.pinch = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), scale: this.scale };
        if (this.drag && !this.drag.pan) this.sim.unpin(this.drag.index);
        this.drag = null;
        return;
      }
    }
    if (e.button !== 0 && e.button !== 1) return;
    const hit = e.button === 0 ? this.hitTest(x, y) : -1;
    this.drag = { index: hit, pointerId: e.pointerId, x, y, moved: false, pan: hit < 0, cx: this.cx, cy: this.cy };
    if (hit >= 0) this.setHover(hit);
    this.contentEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  private onPointerMove(e: PointerEvent) {
    const [x, y] = this.localPoint(e);
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x, y });
      if (this.pinch && this.touches.size >= 2) {
        const [a, b] = Array.from(this.touches.values());
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const target = this.pinch.scale * (dist / Math.max(1, this.pinch.dist));
        this.zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, target / this.scale);
        return;
      }
    }
    const d = this.drag;
    if (d && d.pointerId === e.pointerId) {
      if (!d.moved && Math.hypot(x - d.x, y - d.y) > 3) d.moved = true;
      if (!d.moved) return;
      if (d.pan) {
        this.cx = d.cx - (x - d.x) / this.scale;
        this.cy = d.cy - (y - d.y) / this.scale;
        this.contentEl.addClass("is-panning");
      } else {
        const [wx, wy] = this.toWorld(x, y);
        this.sim.pin(d.index, wx, wy);
      }
      this.requestFrame();
      return;
    }
    if (this.isControlsEvent(e)) {
      this.setHover(-1);
      return;
    }
    if (e.pointerType === "mouse") this.setHover(this.hitTest(x, y));
  }

  private onPointerUp(e: PointerEvent) {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    this.drag = null;
    this.contentEl.removeClass("is-panning");
    this.contentEl.releasePointerCapture?.(e.pointerId);
    if (d.pan) return;
    if (d.moved) {
      this.sim.unpin(d.index);
      this.requestFrame();
      return;
    }
    if (e.type === "pointerup") this.openNode(d.index, e);
  }

  private openNode(index: number, e: MouseEvent) {
    const node = this.nodes[index];
    if (!node) return;
    const newLeaf = Keymap.isModEvent(e);
    if (node.kind === "tag") {
      const search = this.app.internalPlugins.getEnabledPluginById("global-search") as { openGlobalSearch?: (q: string) => void } | null;
      search?.openGlobalSearch?.(`tag:${node.id.startsWith("#") ? node.id : `#${node.id}`}`);
      return;
    }
    void this.app.workspace.openLinkText(node.id, this.file?.path ?? "", newLeaf);
  }

  private onWheel(e: WheelEvent) {
    if (this.isControlsEvent(e)) return;
    e.preventDefault();
    const [x, y] = this.localPoint(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    const delta = e.deltaY * unit;
    const factor = Math.pow(2, -delta * (e.ctrlKey ? 0.01 : 0.0025));
    this.zoomAt(x, y, factor);
  }

  private onContextMenu(e: MouseEvent) {
    if (this.isControlsEvent(e)) return;
    e.preventDefault();
    const [x, y] = this.localPoint(e);
    const hit = this.hitTest(x, y);
    const node = this.nodes[hit];
    if (!node) return;
    const menu = new Menu();
    const file = node.kind === "note" || node.kind === "attachment" ? this.app.vault.getFileByPath(node.id) : null;
    if (file) {
      menu.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => void this.app.workspace.getLeaf("tab").openFile(file, { active: true })));
      menu.addItem((i) => i.setSection("open").setTitle("Open to the right").setIcon("lucide-separator-vertical").onClick(() => void this.app.workspace.getLeaf("split").openFile(file, { active: true })));
      this.app.workspace.trigger("file-menu", menu, file, "graph-context-menu", this.leaf);
    } else if (node.kind === "unresolved") {
      menu.addItem((i) => i.setSection("open").setTitle("Create note").setIcon("lucide-file-plus").onClick(() => void this.app.workspace.openLinkText(node.id, "", false)));
    } else if (node.kind === "tag") {
      menu.addItem((i) => i.setSection("open").setTitle("Search for tag").setIcon("lucide-search").onClick(() => this.openNode(hit, e)));
    }
    menu.showAtMouseEvent(e);
  }

  private onKeyDown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest(".graph-controls")) return;
    const step = (e.shiftKey ? 60 : 20) / this.scale;
    switch (e.key) {
      case "ArrowLeft":
        this.cx -= step;
        break;
      case "ArrowRight":
        this.cx += step;
        break;
      case "ArrowUp":
        this.cy -= step;
        break;
      case "ArrowDown":
        this.cy += step;
        break;
      case "+":
      case "=":
        this.zoomAt(this.width / 2, this.height / 2, e.shiftKey ? 1.5 : 1.2);
        break;
      case "-":
      case "_":
        this.zoomAt(this.width / 2, this.height / 2, e.shiftKey ? 1 / 1.5 : 1 / 1.2);
        break;
      default:
        return;
    }
    e.preventDefault();
    this.requestFrame();
  }

  override onPaneMenu(menu: Menu, source: string): void {
    menu.addItem((i) => i.setSection("action").setTitle("Copy screenshot").setIcon("lucide-image").onClick(() => void this.copyScreenshot()));
    super.onPaneMenu(menu, source);
  }

  private async copyScreenshot() {
    this.drawFrame(performance.now(), false);
    const out = document.createElement("canvas");
    out.width = this.canvasEl.width;
    out.height = this.canvasEl.height;
    const ctx = out.getContext("2d")!;
    if (this.colors) {
      ctx.fillStyle = rgbaToCss(this.colors.background);
      ctx.fillRect(0, 0, out.width, out.height);
    }
    ctx.drawImage(this.canvasEl, 0, 0);
    ctx.drawImage(this.labelEl, 0, 0);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      new Notice("Screenshot copied to clipboard.");
    } catch {
      new Notice("Could not copy the screenshot.");
    }
  }

  // ---- frame loop ------------------------------------------------------------------------------

  // internal
  requestFrame() {
    this.dirty = true;
    if (!this.raf && this.opened) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(now: number) {
    this.raf = 0;
    if (!this.opened || !this.renderer) return;
    if (!this.contentEl.isConnected || this.width === 0) {
      // Hidden tab: resume when shown (the resize observer fires then).
      return;
    }
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;

    if (this.animation) this.stepAnimation(now);

    const t0 = performance.now();
    const simulating = this.sim.tick(8);
    this.stats.stepMs = performance.now() - t0;
    this.stats.simulating = simulating;

    if (this.fade !== this.fadeTarget) {
      const d = dt / FADE_MS;
      this.fade = this.fadeTarget > this.fade ? Math.min(this.fadeTarget, this.fade + d) : Math.max(this.fadeTarget, this.fade - d);
      if (this.fade === 0 && this.fadeTarget === 0) {
        this.hovering = false;
        this.state.fill(NodeState.Normal);
      }
    }
    const animatingFade = this.fade !== this.fadeTarget;

    this.drawFrame(now, true);

    this.fpsFrames++;
    if (!this.fpsStart) this.fpsStart = now;
    if (now - this.fpsStart >= 1000) {
      this.stats.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsStart));
      this.fpsFrames = 0;
      this.fpsStart = now;
    }
    this.stats.frameMs = performance.now() - t0;

    if (simulating || animatingFade || this.animation || this.drag || this.dirty) {
      this.raf = requestAnimationFrame((t) => this.frame(t));
    } else {
      this.lastFrame = 0;
      this.fpsStart = 0;
      this.fpsFrames = 0;
    }
  }

  private drawFrame(_now: number, clearDirty: boolean) {
    if (!this.renderer || !this.colors) return;
    if (clearDirty) this.dirty = false;
    const o = this.options;
    const positions = this.sim.positions();
    const scale = this.scale;
    const lineWidth = o.lineSizeMultiplier * Math.min(2, Math.max(0.35, scale));
    const arrows = o.showArrow ? Math.min(1, Math.max(0, (scale - 0.5) / 0.5)) : 0;
    const t1 = performance.now();
    this.renderer.draw({
      positions,
      radius: this.radius,
      state: this.state,
      hovering: this.hovering,
      fade: this.fade,
      cx: this.cx,
      cy: this.cy,
      scale,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      lineWidth,
      arrows,
      colors: this.colors,
      dimAlpha: DIM_ALPHA,
    });
    const t2 = performance.now();
    this.stats.drawMs = t2 - t1;
    this.drawLabels(positions);
    this.stats.labelMs = performance.now() - t2;
  }

  private labelOpacity(): number {
    const v = (Math.log2(this.scale) + this.options.textFadeMultiplier * 0.5 + 0.7) / 0.7;
    return Math.min(1, Math.max(0, v));
  }

  private drawLabels(pos: Float32Array) {
    const ctx = this.labelCtx;
    const colors = this.colors!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const base = this.labelOpacity();
    if (base <= 0.01 && !this.hovering) return;
    const scale = this.scale;
    const size = Math.max(9, Math.min(26, 13 * Math.sqrt(scale)));
    ctx.font = `${size.toFixed(1)}px ${colors.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const n = Math.min(this.nodes.length, pos.length >> 1);
    const hw = this.width / 2;
    const hh = this.height / 2;
    const dim = 1 + (DIM_ALPHA - 1) * this.fade;
    const [r, g, b, a0] = colors.text;
    const rgb = `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}`;
    let lastAlpha = -1;
    let drawn = 0;
    const margin = 120;
    for (let i = 0; i < n; i++) {
      let a = base;
      if (this.hovering) {
        const st = this.state[i];
        if (st === NodeState.Hovered || st === NodeState.Neighbor) a = Math.max(a, this.fade);
        else a *= dim;
      }
      if (a < 0.02) continue;
      const sx = (pos[i * 2]! - this.cx) * scale + hw;
      const sy = (pos[i * 2 + 1]! - this.cy) * scale + hh;
      if (sx < -margin || sx > this.width + margin || sy < -margin || sy > this.height + margin) continue;
      const alpha = Math.round(a * a0 * 50) / 50;
      if (alpha !== lastAlpha) {
        ctx.fillStyle = `rgba(${rgb},${alpha})`;
        lastAlpha = alpha;
      }
      ctx.fillText(this.nodes[i]!.label, sx, sy + Math.max(this.radius[i]! * scale, 1.25) + 3);
      if (++drawn > 3000) break;
    }
  }

  private stepAnimation(now: number) {
    const anim = this.animation!;
    const data = this.fullData;
    if (!data) {
      this.animation = null;
      return;
    }
    if (now - anim.last < 50) return;
    anim.last = now;
    const total = anim.order.length;
    anim.shown = Math.min(total, anim.shown + Math.max(1, Math.ceil(total / 120)));
    const keep = anim.order.slice(0, anim.shown).sort((a, b) => a - b);
    const remap = new Int32Array(total).fill(-1);
    keep.forEach((old, i) => (remap[old] = i));
    const nodes = keep.map((i) => data.nodes[i]!);
    const links: { source: number; target: number }[] = [];
    for (const l of data.links) {
      const s = remap[l.source]!;
      const t = remap[l.target]!;
      if (s >= 0 && t >= 0) links.push({ source: s, target: t });
    }
    this.applyGraph(nodes, links);
    if (anim.shown >= total) this.animation = null;
  }
}
