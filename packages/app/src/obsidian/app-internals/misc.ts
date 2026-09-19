/**
 * Smaller app internals plugins reach for: property types, the status bar,
 * drag data, fold state, and the CLI handler registry.
 */
import { Events } from "../events";
import type { TAbstractFile, TFile } from "../vault/files";

export type PropertyType = "text" | "multitext" | "number" | "checkbox" | "date" | "datetime" | "aliases" | "tags";

const RESERVED_TYPES: Record<string, PropertyType> = {
  tags: "tags",
  tag: "tags",
  aliases: "aliases",
  alias: "aliases",
  cssclasses: "multitext",
  cssclass: "multitext",
};

/** app.metadataTypeManager — `.obsidian/types.json` */
export class MetadataTypeManager extends Events {
  properties: Record<string, { name: string; type: PropertyType; count: number }> = {};
  types: Record<string, PropertyType> = {};
  registeredTypeWidgets: Record<string, unknown> = {};

  constructor(private app: any) {
    super();
  }

  async load() {
    const data = await this.app.vault.readConfigJson("types.json");
    this.types = data?.types && typeof data.types === "object" ? data.types : {};
  }

  async save() {
    await this.app.vault.writeConfigJson("types.json", { types: this.types });
  }

  /** Recount properties across the vault; types default from observed values. */
  updatePropertyInfoCache() {
    const props: Record<string, { name: string; type: PropertyType; count: number }> = {};
    const untyped = new Set<string>();
    for (const meta of Object.values(this.app.metadataCache.metadataCache as Record<string, { frontmatter?: Record<string, unknown> }>)) {
      for (const [key, value] of Object.entries(meta.frontmatter ?? {})) {
        const lower = key.toLowerCase();
        const entry = (props[lower] ??= { name: key, type: this.getAssignedType(key) ?? inferType(key, value), count: 0 });
        // An empty value says nothing about the type: the first value that has one decides.
        if (value === null || value === undefined || value === "") {
          if (entry.count === 0 && !this.getAssignedType(key)) untyped.add(lower);
        } else if (untyped.has(lower)) {
          untyped.delete(lower);
          entry.type = inferType(key, value);
        }
        entry.count++;
      }
    }
    this.properties = props;
    this.trigger("changed");
  }

  getAssignedType(name: string): PropertyType | null {
    const lower = name.toLowerCase();
    return RESERVED_TYPES[lower] ?? this.types[lower] ?? this.types[name] ?? null;
  }

  getPropertyInfo(name: string) {
    return this.properties[name.toLowerCase()] ?? { name, type: this.getAssignedType(name) ?? "text", count: 0 };
  }

  getAllProperties() {
    return this.properties;
  }

  getTypeInfo(name: string, value?: unknown) {
    const type = this.getAssignedType(name) ?? inferType(name, value);
    return { expected: { type }, inferred: { type: inferType(name, value) } };
  }

  setType(name: string, type: PropertyType) {
    this.types[name.toLowerCase()] = type;
    void this.save();
    this.updatePropertyInfoCache();
  }

  unsetType(name: string) {
    delete this.types[name.toLowerCase()];
    void this.save();
    this.updatePropertyInfoCache();
  }
}

export function inferType(name: string, value: unknown): PropertyType {
  const reserved = RESERVED_TYPES[name.toLowerCase()];
  if (reserved) return reserved;
  if (Array.isArray(value)) return "multitext";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(value)) return "datetime";
  }
  return "text";
}

/** app.statusBar */
export class StatusBar {
  containerEl: HTMLElement;
  constructor() {
    this.containerEl = createDiv({ cls: "status-bar" });
  }
  createStatusBarItem(pluginId?: string): HTMLElement {
    const el = this.containerEl.createDiv({ cls: "status-bar-item" });
    if (pluginId) el.addClass(`plugin-${pluginId.replace(/[^a-z0-9-]/gi, "-")}`);
    return el;
  }
}

export interface DragData {
  type: "file" | "files" | "folder" | "link" | "bookmarks";
  icon?: string;
  title?: string;
  file?: TAbstractFile;
  files?: TAbstractFile[];
  linktext?: string;
  sourcePath?: string;
}

/** app.dragManager — in-app drag payloads (files, links) that DataTransfer cannot carry as objects. */
export class DragManager extends Events {
  draggable: DragData | null = null;
  private ghostEl: HTMLElement | null = null;

  constructor(private app: any) {
    super();
    window.addEventListener("dragend", () => this.onDragEnd(), true);
    window.addEventListener("drop", () => setTimeout(() => this.onDragEnd(), 0), true);
  }

  dragFile(evt: DragEvent, file: TFile, source?: string): DragData {
    const link = this.app.fileManager.generateMarkdownLink(file, source ?? "");
    evt.dataTransfer?.setData("text/plain", link);
    evt.dataTransfer?.setData("text/uri-list", `obsidian://open?file=${encodeURIComponent(file.path)}`);
    return { type: "file", icon: "lucide-file", title: file.name, file };
  }

  dragFiles(evt: DragEvent, files: TAbstractFile[], source?: string): DragData {
    const links = files.map((f) => ("extension" in f ? this.app.fileManager.generateMarkdownLink(f, source ?? "") : f.path));
    evt.dataTransfer?.setData("text/plain", links.join("\n"));
    return { type: "files", icon: "lucide-files", title: `${files.length} files`, files };
  }

  dragFolder(evt: DragEvent, folder: TAbstractFile, _source?: string): DragData {
    evt.dataTransfer?.setData("text/plain", folder.path);
    return { type: "folder", icon: "lucide-folder", title: folder.name, file: folder };
  }

  dragLink(evt: DragEvent, linktext: string, sourcePath: string, title?: string): DragData {
    evt.dataTransfer?.setData("text/plain", `[[${linktext}]]`);
    return { type: "link", icon: "lucide-link", title: title ?? linktext, linktext, sourcePath };
  }

  onDragStart(evt: DragEvent, data: DragData) {
    this.draggable = data;
    if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "all";
    document.body.addClass("is-dragging");
    this.trigger("drag-start", data);
  }

  handleDrag(el: HTMLElement, getData: (evt: DragEvent) => DragData | null) {
    el.setAttr("draggable", "true");
    el.addEventListener("dragstart", (evt) => {
      const data = getData(evt);
      if (data) this.onDragStart(evt, data);
    });
  }

  handleDrop(el: HTMLElement, onDrop: (evt: DragEvent, data: DragData | null, isOver: boolean) => unknown) {
    el.addEventListener("dragover", (evt) => {
      if (onDrop(evt, this.draggable, true)) {
        evt.preventDefault();
        el.addClass("is-being-dragged-over");
      }
    });
    el.addEventListener("dragleave", () => el.removeClass("is-being-dragged-over"));
    el.addEventListener("drop", (evt) => {
      el.removeClass("is-being-dragged-over");
      if (onDrop(evt, this.draggable, false)) evt.preventDefault();
    });
  }

  private actionEl: HTMLElement | null = null;
  private trackAction = (evt: DragEvent) => {
    if (this.actionEl) this.actionEl.setCssStyles({ left: `${evt.clientX + 12}px`, top: `${evt.clientY + 12}px` });
  };

  /** The label that follows the pointer during a drag ("Move into Folder"). */
  setAction(action: string) {
    if (!action) {
      this.actionEl?.remove();
      this.actionEl = null;
      window.removeEventListener("dragover", this.trackAction, true);
      return;
    }
    if (!this.actionEl) {
      this.actionEl = document.body.createDiv({ cls: "drag-ghost-action" });
      window.addEventListener("dragover", this.trackAction, true);
    }
    this.actionEl.setText(action);
  }

  showOverlay(_doc: Document, rect: DOMRect) {
    this.hideOverlay();
    this.ghostEl = document.body.createDiv({ cls: "workspace-drop-overlay" });
    this.ghostEl.setCssStyles({ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  hideOverlay() {
    this.ghostEl?.remove();
    this.ghostEl = null;
  }

  private onDragEnd() {
    if (!this.draggable) return;
    this.draggable = null;
    this.hideOverlay();
    this.setAction("");
    document.body.removeClass("is-dragging");
    this.trigger("drag-end");
  }
}

/** app.foldManager — fold state per file, persisted in local storage. */
export class FoldManager {
  constructor(private app: any) {}
  load(file: TFile): { folds: { from: number; to: number }[]; lines: number } | null {
    return this.app.loadLocalStorage(`fold-${file.path}`);
  }
  // `info` is whatever `load` returned — often null (daily-notes helpers used by
  // Calendar and Periodic Notes copy a template's folds, or none, onto new notes).
  save(file: TFile, info: { folds: { from: number; to: number }[]; lines: number } | null) {
    if (!file) return;
    this.app.saveLocalStorage(`fold-${file.path}`, info?.folds?.length ? info : null);
  }
  loadPath(path: string) {
    return this.app.loadLocalStorage(`fold-${path}`);
  }
  savePath(path: string, info: unknown) {
    this.app.saveLocalStorage(`fold-${path}`, info);
  }
}

/** app.cli — `registerCliHandler` targets. The web app has no shell; the `vault` CLI binary reads the same vault. */
export class CliRegistry {
  handlers = new Map<string, { description: string; flags: unknown; handler: unknown; pluginId: string }>();
  register(command: string, description: string, flags: unknown, handler: unknown, pluginId: string) {
    this.handlers.set(command, { description, flags, handler, pluginId });
  }
  unregister(command: string) {
    this.handlers.delete(command);
  }
}

