/**
 * app.viewRegistry — view type → creator, file extension → view type.
 */
import { Events } from "../events";
import { EmptyView, type View } from "../workspace/view";
import type { WorkspaceLeaf } from "../workspace/leaf";

export type ViewCreator = (leaf: WorkspaceLeaf) => View;

export class ViewRegistry extends Events {
  viewByType: Record<string, ViewCreator> = {};
  typeByExtension: Record<string, string> = {};

  registerView(type: string, creator: ViewCreator) {
    if (this.viewByType[type]) throw new Error(`Attempting to register an existing view type "${type}"`);
    this.viewByType[type] = creator;
    this.trigger("view-registered", type);
  }

  unregisterView(type: string) {
    delete this.viewByType[type];
    this.trigger("view-unregistered", type);
  }

  registerExtensions(extensions: string[], type: string) {
    for (const ext of extensions) {
      if (this.typeByExtension[ext]) throw new Error(`Attempting to register an existing file extension "${ext}"`);
    }
    for (const ext of extensions) this.typeByExtension[ext] = type;
    this.trigger("extensions-updated");
  }

  unregisterExtensions(extensions: string[]) {
    for (const ext of extensions) delete this.typeByExtension[ext];
    this.trigger("extensions-updated");
  }

  registerViewWithExtensions(extensions: string[], type: string, creator: ViewCreator) {
    this.registerView(type, creator);
    this.registerExtensions(extensions, type);
  }

  isExtensionRegistered(ext: string): boolean {
    return ext in this.typeByExtension;
  }

  getTypeByExtension(ext: string): string | undefined {
    return this.typeByExtension[ext.toLowerCase()] ?? this.typeByExtension[ext];
  }

  getViewCreatorByType(type: string): ViewCreator | undefined {
    return this.viewByType[type];
  }

  createEmptyView(leaf: WorkspaceLeaf): View {
    return new EmptyView(leaf);
  }
}

/** app.embedRegistry — file extension → embed component creator. */
export type EmbedCreator = (ctx: { app: any; containerEl: HTMLElement; linktext: string; sourcePath: string; showInline?: boolean; depth?: number }, file: any, subpath: string) => { loadFile(): unknown } & Record<string, any>;

export class EmbedRegistry extends Events {
  embedByExtension: Record<string, EmbedCreator> = {};

  registerExtension(ext: string, creator: EmbedCreator) {
    this.embedByExtension[ext] = creator;
  }
  registerExtensions(exts: string[], creator: EmbedCreator) {
    for (const e of exts) this.registerExtension(e, creator);
  }
  unregisterExtension(ext: string) {
    delete this.embedByExtension[ext];
  }
  unregisterExtensions(exts: string[]) {
    for (const e of exts) this.unregisterExtension(e);
  }
  isExtensionRegistered(ext: string) {
    return ext in this.embedByExtension;
  }
  getEmbedCreator(file: { extension: string }): EmbedCreator | null {
    return this.embedByExtension[file.extension.toLowerCase()] ?? null;
  }
}
