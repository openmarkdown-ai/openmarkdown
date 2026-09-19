/**
 * `canvasView.canvas` — the internal Canvas object, for plugins that use
 * canvas cards outside a canvas file.
 *
 * Excalidraw renders a `![[Note#Heading]]` embeddable this way: it creates a
 * detached leaf, takes `internalPlugins.plugins.canvas.views.canvas(leaf).canvas`,
 * calls `createFileNode({ pos, file, subpath, save: false })`, then
 * `node.setFilePath(path, subpath)`, `node.render()`, moves `node.containerEl`
 * into its own DOM, and later `node.startEditing()`, `node.child.showPreview()`,
 * `canvas.removeNode(node)` and `node.detach()`. The cards here are the
 * canvas's own `CanvasNodeView`s, rendered and edited exactly as on a canvas.
 */
import { Component } from "../../obsidian/events";
import type { TFile } from "../../obsidian/vault/files";
import type { CanvasNodeData } from "./data";
import { CanvasNodeView, type NodeHost } from "./node-view";

let nodeCounter = 0;

export class CanvasFileNode {
  // internal
  view: CanvasNodeView;
  /** `.canvas-node` */
  nodeEl: HTMLElement;
  /** `.canvas-node-container` — what plugins move into their own DOM. */
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  isEditing = false;
  /** The embed-like object Obsidian exposes as `node.child`. */
  child: { readonly editor: unknown; readonly editMode: unknown; showPreview(): void; showEditor(): void };
  private component: Component;

  constructor(app: any, data: CanvasNodeData) {
    this.component = new Component();
    this.component.load();
    const host: NodeHost = {
      app,
      file: null,
      owner: this.component,
      readOnly: false,
      onNodeTextEdited: () => {},
      onEditingEnd: () => {
        this.isEditing = false;
      },
    };
    this.view = new CanvasNodeView(data, host, createDiv());
    this.nodeEl = this.view.el;
    this.containerEl = this.view.containerEl;
    this.contentEl = this.view.contentEl;
    const node = this;
    this.child = {
      get editor() {
        return node.view.activeEditor;
      },
      get editMode() {
        return node.view.editing ? node.view.activeEditor : null;
      },
      showPreview: () => node.view.stopEditing(true),
      showEditor: () => void node.startEditing(),
    };
  }

  get file(): TFile | null {
    return this.view.file();
  }

  get subpath(): string {
    return this.view.data.subpath ?? "";
  }

  setFilePath(path: string, subpath?: string) {
    this.view.data = { ...this.view.data, file: path, subpath: subpath || undefined };
  }

  render() {
    this.view.invalidate();
  }

  isEditable(): boolean {
    return this.view.canEdit();
  }

  async startEditing() {
    await this.view.startEditing();
    this.isEditing = this.view.editing;
  }

  detach() {
    this.view.destroy();
    this.component.unload();
  }
}

export class CanvasInternalApi {
  nodes = new Map<string, CanvasFileNode>();

  constructor(private app: any) {}

  createFileNode(opts: { pos?: { x: number; y: number }; size?: { width: number; height: number }; file: TFile; subpath?: string; save?: boolean }): CanvasFileNode {
    const id = `detached-${++nodeCounter}`;
    const data: CanvasNodeData = {
      id,
      type: "file",
      file: opts.file.path,
      subpath: opts.subpath || undefined,
      x: opts.pos?.x ?? 0,
      y: opts.pos?.y ?? 0,
      width: opts.size?.width ?? 400,
      height: opts.size?.height ?? 400,
    } as CanvasNodeData;
    const node = new CanvasFileNode(this.app, data);
    this.nodes.set(id, node);
    return node;
  }

  removeNode(node: CanvasFileNode) {
    for (const [id, n] of this.nodes) if (n === node) this.nodes.delete(id);
    if (node.view.editing) node.view.stopEditing(false);
  }
}
