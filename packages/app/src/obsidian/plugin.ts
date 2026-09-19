/**
 * Plugin — the base class of every community plugin and every core feature.
 *
 * Everything a plugin registers is tied to the plugin's own lifetime through
 * `register()`, so disabling a plugin removes its commands, views, ribbon
 * icons, editor extensions and post-processors without the plugin having to
 * clean up after itself.
 */
import type { Command, PluginManifest } from "obsidian";
import { Component } from "./events";
import { MarkdownPreviewRenderer } from "./markdown/renderer";
import { normalizePath } from "./util";

export abstract class Plugin extends Component {
  app: any;
  manifest: PluginManifest;
  settings?: unknown;
  // internal
  _lastDataModifiedTime = 0;
  // internal
  _userDisabled = false;

  constructor(app: any, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  override onload(): Promise<void> | void {}

  /** Unlike Component.load, waits for an async `onload()` before loading children. */
  override async load(): Promise<void> {
    if (this._loaded) return;
    this._loaded = true;
    await this.onload();
    for (const child of this._children.slice()) child.load();
  }

  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
    const id = `${this.manifest.id}:${title}`;
    const el = this.app.workspace.leftRibbon.addRibbonItemButton(id, icon, title, callback);
    this.register(() => this.app.workspace.leftRibbon.removeRibbonAction(id));
    return el;
  }

  addStatusBarItem(): HTMLElement {
    const el = this.app.statusBar.createStatusBarItem(this.manifest.id);
    this.register(() => el.detach());
    return el;
  }

  addCommand(command: Command): Command {
    const originalId = command.id;
    const prefix = `${this.manifest.id}:`;
    const cmd = { ...command } as Command;
    // Core plugins register with their full ids (`editor:toggle-bold`) and a
    // display name without a prefix; community plugins get both prefixed.
    if (!(this as { isCorePlugin?: boolean }).isCorePlugin) {
      cmd.id = originalId.startsWith(prefix) ? originalId : prefix + originalId;
      cmd.name = `${this.manifest.name}: ${command.name}`;
    }
    // Obsidian mutates the passed object so the plugin can read the final id.
    command.id = cmd.id;
    command.name = cmd.name;
    this.app.commands.addCommand(command);
    this.register(() => this.app.commands.removeCommand(command.id));
    return command;
  }

  removeCommand(commandId: string): void {
    const full = commandId.startsWith(`${this.manifest.id}:`) ? commandId : `${this.manifest.id}:${commandId}`;
    this.app.commands.removeCommand(full);
  }

  addSettingTab(settingTab: any): void {
    this.app.setting.addSettingTab(settingTab);
    this.register(() => this.app.setting.removeSettingTab(settingTab));
  }

  registerView(type: string, viewCreator: (leaf: any) => any): void {
    this.app.viewRegistry.registerView(type, viewCreator);
    this.register(() => this.app.viewRegistry.unregisterView(type));
  }

  registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }): void {
    this.app.workspace.hoverLinkSources[id] = info;
    this.register(() => delete this.app.workspace.hoverLinkSources[id]);
  }

  registerExtensions(extensions: string[], viewType: string): void {
    this.app.viewRegistry.registerExtensions(extensions, viewType);
    this.register(() => this.app.viewRegistry.unregisterExtensions(extensions));
  }

  registerMarkdownPostProcessor(postProcessor: any, sortOrder?: number): any {
    MarkdownPreviewRenderer.registerPostProcessor(postProcessor, sortOrder);
    this.register(() => MarkdownPreviewRenderer.unregisterPostProcessor(postProcessor));
    return postProcessor;
  }

  registerMarkdownCodeBlockProcessor(language: string, handler: (source: string, el: HTMLElement, ctx: any) => Promise<any> | void, sortOrder?: number): any {
    // Registered once, as a language handler: the renderer runs it for matching
    // code blocks before the generic post-processors (and the editor renders it
    // as a widget in Live Preview).
    const pp = MarkdownPreviewRenderer.createCodeBlockPostProcessor(language, handler);
    if (sortOrder !== undefined) (pp as { sortOrder?: number }).sortOrder = sortOrder;
    MarkdownPreviewRenderer.registerCodeBlockPostProcessor(language, handler);
    this.register(() => MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor(language));
    return pp;
  }

  registerBasesView(viewId: string, registration: any): boolean {
    const registry = this.app.basesRegistry;
    if (!registry || registry.has(viewId)) return false;
    registry.register(viewId, registration);
    this.register(() => registry.unregister(viewId));
    return true;
  }

  registerEditorExtension(extension: any): void {
    this.app.workspace.registerEditorExtension(extension);
    this.register(() => this.app.workspace.unregisterEditorExtension(extension));
  }

  registerObsidianProtocolHandler(action: string, handler: (params: any) => any): void {
    this.app.workspace.protocolHandlers.set(action, handler);
    this.register(() => this.app.workspace.protocolHandlers.delete(action));
  }

  registerEditorSuggest(editorSuggest: any): void {
    this.app.workspace.editorSuggest.suggests.push(editorSuggest);
    this.register(() => this.app.workspace.editorSuggest.suggests.remove(editorSuggest));
  }

  registerCliHandler(command: string, description: string, flags: unknown, handler: unknown): void {
    this.app.cli.register(command, description, flags, handler, this.manifest.id);
    this.register(() => this.app.cli.unregister(command));
  }

  private dataPath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(`${dir}/data.json`);
  }

  async loadData(): Promise<any> {
    const adapter = this.app.vault.adapter;
    const path = this.dataPath();
    try {
      if (!(await adapter.exists(path))) return null;
      return JSON.parse(await adapter.read(path));
    } catch (e) {
      console.error(`Failed to load data for ${this.manifest.id}`, e);
      return null;
    }
  }

  async saveData(data: any): Promise<void> {
    const path = this.dataPath();
    const adapter = this.app.vault.adapter;
    const dir = path.slice(0, path.lastIndexOf("/"));
    await adapter.mkdir(dir);
    this._lastDataModifiedTime = Date.now();
    await adapter.write(path, JSON.stringify(data, null, 2), { mtime: this._lastDataModifiedTime });
  }

  onUserEnable(): void {}

  onExternalSettingsChange?(): any;

  // internal
  async loadCSS(): Promise<void> {
    if (!this.manifest.dir) return;
    const path = normalizePath(`${this.manifest.dir}/styles.css`);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) return;
    const css = await adapter.read(path);
    const el = document.createElement("style");
    el.setAttribute("type", "text/css");
    el.setAttribute("data-plugin", this.manifest.id);
    el.textContent = css;
    this.app.customCss.insertPluginStyle(el);
    this.register(() => el.remove());
  }
}
