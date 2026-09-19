/**
 * `![[board.canvas]]` in a note: a read-only miniature of the canvas (card
 * shapes, groups and connections), clicking opens the canvas.
 */
import { Component } from "../../obsidian/events";
import type { TFile } from "../../obsidian/vault/files";
import { cssColor, edgeGeometry, parseCanvas, unionRect, type CanvasData } from "./data";

const SVG_NS = "http://www.w3.org/2000/svg";

export class CanvasEmbed extends Component {
  constructor(
    private ctx: { app: any; containerEl: HTMLElement; linktext: string; sourcePath: string },
    private file: TFile,
  ) {
    super();
  }

  override onload() {
    const el = this.ctx.containerEl;
    el.addClasses(["canvas-embed", "inline-embed", "is-loaded"]);
    this.registerDomEvent(el, "click", (evt: MouseEvent) => {
      evt.preventDefault();
      const mod = evt.ctrlKey || evt.metaKey;
      void this.ctx.app.workspace.openLinkText(this.file.path, this.ctx.sourcePath, mod ? "tab" : false);
    });
    this.registerEvent(
      this.ctx.app.vault.on("modify", (f: TFile) => {
        if (f === this.file) void this.loadFile();
      }),
    );
  }

  async loadFile() {
    if (!this._loaded) this.load();
    const el = this.ctx.containerEl;
    let data: CanvasData;
    try {
      data = parseCanvas(await this.ctx.app.vault.cachedRead(this.file));
    } catch (e) {
      el.empty();
      el.createDiv({ cls: "vault-render-error", text: `Could not read ${this.file.name}: ${(e as Error).message}` });
      return;
    }
    render(el, data, this.file);
  }
}

export function render(el: HTMLElement, data: CanvasData, file: TFile) {
  el.empty();
  el.setAttr("aria-label", file.basename);
  const title = el.createDiv({ cls: "canvas-embed-title vault-canvas-embed-title", text: file.basename });
  void title;
  const bounds = unionRect(data.nodes);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "canvas-minimap");
  el.appendChild(svg);
  if (!bounds) {
    el.createDiv({ cls: "vault-canvas-embed-empty", text: "Empty canvas" });
    return;
  }
  const pad = 40;
  svg.setAttribute("viewBox", `${bounds.x - pad} ${bounds.y - pad} ${bounds.width + pad * 2} ${bounds.height + pad * 2}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const ordered = [...data.nodes].sort((a, b) => (a.type === "group" ? 0 : 1) - (b.type === "group" ? 0 : 1));
  for (const n of ordered) {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("class", `canvas-minimap-node${n.type === "group" ? " mod-group" : ""}`);
    r.setAttribute("x", String(n.x));
    r.setAttribute("y", String(n.y));
    r.setAttribute("width", String(n.width));
    r.setAttribute("height", String(n.height));
    r.setAttribute("rx", "12");
    const color = cssColor(n.color);
    if (color) r.style.setProperty("--canvas-color", color);
    svg.appendChild(r);
  }
  for (const e of data.edges) {
    const a = byId.get(e.fromNode);
    const b = byId.get(e.toNode);
    if (!a || !b) continue;
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("class", "canvas-minimap-edge");
    p.setAttribute("d", edgeGeometry(a, b, e.fromSide, e.toSide, false, false).path);
    const color = cssColor(e.color);
    if (color) p.style.setProperty("--canvas-color", color);
    svg.appendChild(p);
  }
}
