/**
 * "Export as image": draws the canvas (groups, cards, text, images and
 * connections) onto a 2D canvas and saves it as PNG. Card content is drawn as
 * plain text from the Markdown source; privacy mode replaces it with bars.
 */
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import type { TFile } from "../../obsidian/vault/files";
import { parseCssColor, rgbaToCss } from "../graph/colors";
import { arrowPoints, cssColor, edgeGeometry, unionRect, type Rect } from "./data";
import { IMAGE_EXTENSIONS } from "./node-view";
import type { CanvasView } from "./view";

interface ExportOptions {
  privacy: boolean;
  zoom: number;
  viewportOnly: boolean;
}

export class ExportImageModal extends Modal {
  private options: ExportOptions = { privacy: false, zoom: 1, viewportOnly: false };
  private dimsEl!: HTMLElement;

  constructor(
    app: any,
    private view: CanvasView,
  ) {
    super(app);
    this.setTitle("Export as image");
  }

  override onOpen() {
    const el = this.contentEl;
    new Setting(el)
      .setName("Privacy mode")
      .setDesc("Obscure the text on cards.")
      .addToggle((t) => t.setValue(this.options.privacy).onChange((v) => (this.options.privacy = v)));
    new Setting(el).setName("Zoom").addDropdown((d) =>
      d
        .addOptions({ "0.5": "50%", "1": "100%", "2": "200%", "3": "300%" })
        .setValue(String(this.options.zoom))
        .onChange((v) => {
          this.options.zoom = Number(v);
          this.updateDims();
        }),
    );
    new Setting(el).setName("Viewport").addDropdown((d) =>
      d
        .addOptions({ full: "Full canvas", viewport: "Viewport only" })
        .setValue(this.options.viewportOnly ? "viewport" : "full")
        .onChange((v) => {
          this.options.viewportOnly = v === "viewport";
          this.updateDims();
        }),
    );
    this.dimsEl = el.createDiv({ cls: "setting-item-description vault-canvas-export-dims" });
    this.updateDims();
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { cls: "mod-cta", text: "Export" }).addEventListener("click", () => {
      this.close();
      void exportCanvasImage(this.view, this.options);
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  private updateDims() {
    const area = exportArea(this.view, this.options);
    if (!area) {
      this.dimsEl.setText("The canvas is empty.");
      return;
    }
    const scale = this.options.zoom * (window.devicePixelRatio || 1);
    this.dimsEl.setText(`Estimated size: ${Math.round(area.width * scale)} × ${Math.round(area.height * scale)} px`);
  }

  override onClose() {
    this.contentEl.empty();
  }
}

function exportArea(view: CanvasView, o: ExportOptions): Rect | null {
  if (o.viewportOnly) {
    const w = view.wrapperEl.clientWidth;
    const h = view.wrapperEl.clientHeight;
    return { x: -view.tx / view.zoom, y: -view.ty / view.zoom, width: w / view.zoom, height: h / view.zoom };
  }
  const r = unionRect(view.canvasData.nodes);
  return r ? { x: r.x - 40, y: r.y - 60, width: r.width + 80, height: r.height + 100 } : null;
}

function resolveColor(host: HTMLElement, value: string | null, fallback: string): string {
  const probe = host.createDiv();
  probe.style.color = value ?? fallback;
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c || fallback;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const test = line + w;
      if (ctx.measureText(test).width > width && line.trim()) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

export async function exportCanvasImage(view: CanvasView, o: ExportOptions) {
  const area = exportArea(view, o);
  if (!area) {
    new Notice("The canvas is empty.");
    return;
  }
  const app = view.app;
  const host = view.wrapperEl;
  const scale = o.zoom * (window.devicePixelRatio || 1);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(area.width * scale));
  out.height = Math.max(1, Math.round(area.height * scale));
  if (out.width * out.height > 16384 * 16384 / 4) {
    new Notice("The image would be too large. Choose a lower zoom.");
    return;
  }
  const ctx = out.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.translate(-area.x, -area.y);

  const style = getComputedStyle(host);
  const bg = style.backgroundColor && parseCssColor(style.backgroundColor)[3] > 0 ? style.backgroundColor : resolveColor(host, "var(--background-primary)", "#fff");
  const text = resolveColor(host, "var(--text-normal)", "#222");
  const muted = resolveColor(host, "var(--text-muted)", "#666");
  const border = resolveColor(host, "var(--canvas-card-border, var(--background-modifier-border))", "#ccc");
  const cardBg = resolveColor(host, "var(--background-primary)", "#fff");
  const font = getComputedStyle(document.body).fontFamily || "sans-serif";
  ctx.fillStyle = bg;
  ctx.fillRect(area.x, area.y, area.width, area.height);

  const nodes = [...view.canvasData.nodes].sort((a, b) => (a.type === "group" ? 0 : 1) - (b.type === "group" ? 0 : 1));
  const radius = 8;
  const rounded = (r: Rect) => {
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.width, r.height, radius);
  };

  for (const n of nodes) {
    const accent = n.color ? resolveColor(host, cssColor(n.color), muted) : null;
    const accentRgba = accent ? parseCssColor(accent) : null;
    if (n.type === "group") {
      rounded(n);
      ctx.fillStyle = accentRgba ? rgbaToCss(accentRgba, 0.08) : rgbaToCss(parseCssColor(muted), 0.05);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = accent ?? border;
      ctx.stroke();
      if (n.label) {
        ctx.font = `600 16px ${font}`;
        ctx.fillStyle = accent ?? muted;
        ctx.textBaseline = "bottom";
        ctx.fillText(o.privacy ? "▇".repeat(Math.min(12, n.label.length)) : n.label, n.x + 4, n.y - 6);
      }
      continue;
    }
    rounded(n);
    ctx.fillStyle = cardBg;
    ctx.fill();
    if (accentRgba) {
      ctx.fillStyle = rgbaToCss(accentRgba, 0.1);
      ctx.fill();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent ?? border;
    ctx.stroke();

    ctx.save();
    rounded(n);
    ctx.clip();
    const pad = 16;
    let body = "";
    let drewImage = false;
    if (n.type === "text") body = n.text ?? "";
    else if (n.type === "link") body = n.url ?? "";
    else if (n.type === "file" && n.file) {
      const file = app.vault.getFileByPath(n.file) as TFile | null;
      const ext = file?.extension.toLowerCase() ?? "";
      if (file && IMAGE_EXTENSIONS.includes(ext)) {
        const img = await loadImage(app.vault.getResourcePath(file));
        if (img) {
          const ratio = Math.min(n.width / img.naturalWidth, n.height / img.naturalHeight);
          const w = img.naturalWidth * ratio;
          const h = img.naturalHeight * ratio;
          ctx.drawImage(img, n.x + (n.width - w) / 2, n.y + (n.height - h) / 2, w, h);
          drewImage = true;
        }
      } else if (file && ext === "md") {
        body = (await app.vault.cachedRead(file)).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
      } else body = n.file;
    }
    if (!drewImage && body) {
      ctx.textBaseline = "top";
      let y = n.y + pad;
      for (const raw of body.split("\n")) {
        const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
        const size = heading ? Math.max(16, 26 - heading[1]!.length * 2) : 15;
        ctx.font = `${heading ? "700 " : ""}${size}px ${font}`;
        const content = (heading ? heading[2]! : raw).replace(/\*\*|__|==|~~|`/g, "").replace(/!?\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, a, b) => b || a);
        for (const line of wrapLines(ctx, content, n.width - pad * 2)) {
          if (y > n.y + n.height) break;
          if (o.privacy) {
            ctx.fillStyle = rgbaToCss(parseCssColor(muted), 0.35);
            const w = Math.min(ctx.measureText(line).width, n.width - pad * 2);
            if (w > 0) ctx.fillRect(n.x + pad, y + size * 0.2, w, size * 0.7);
          } else {
            ctx.fillStyle = text;
            ctx.fillText(line, n.x + pad, y);
          }
          y += size * 1.45;
        }
      }
    }
    ctx.restore();
    if (n.type === "file" && n.file) {
      ctx.font = `13px ${font}`;
      ctx.fillStyle = muted;
      ctx.textBaseline = "bottom";
      const name = n.file.split("/").pop()!.replace(/\.md$/, "");
      ctx.fillText(o.privacy ? "▇".repeat(Math.min(10, name.length)) : name, n.x + 2, n.y - 4);
    }
  }

  const byId = new Map(view.canvasData.nodes.map((n) => [n.id, n]));
  for (const e of view.canvasData.edges) {
    const a = byId.get(e.fromNode);
    const b = byId.get(e.toNode);
    if (!a || !b) continue;
    const toArrow = (e.toEnd ?? "arrow") === "arrow";
    const fromArrow = (e.fromEnd ?? "none") === "arrow";
    const geo = edgeGeometry(a, b, e.fromSide, e.toSide, toArrow, fromArrow);
    const color = e.color ? resolveColor(host, cssColor(e.color), muted) : muted;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke(new Path2D(geo.path));
    const arrow = (pts: string) => {
      const p = pts.split(" ").map((s) => s.split(",").map(Number));
      ctx.beginPath();
      ctx.moveTo(p[0]![0]!, p[0]![1]!);
      ctx.lineTo(p[1]![0]!, p[1]![1]!);
      ctx.lineTo(p[2]![0]!, p[2]![1]!);
      ctx.closePath();
      ctx.fill();
    };
    if (toArrow) arrow(arrowPoints(geo.to, geo.toSide));
    if (fromArrow) arrow(arrowPoints(geo.from, geo.fromSide));
    if (e.label) {
      ctx.font = `14px ${font}`;
      const label = o.privacy ? "▇".repeat(Math.min(10, e.label.length)) : e.label;
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = bg;
      ctx.fillRect(geo.mid.x - w / 2, geo.mid.y - 11, w, 22);
      ctx.fillStyle = text;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(label, geo.mid.x, geo.mid.y);
      ctx.textAlign = "start";
    }
  }

  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
  if (!blob) {
    new Notice("Could not create the image.");
    return;
  }
  const name = `${view.file?.basename ?? "Canvas"}.png`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  new Notice(`Exported ${name}.`);
}
