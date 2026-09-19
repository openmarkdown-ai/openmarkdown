/**
 * BasesHost — one rendered base: the toolbar, the selected view's layout, and
 * the plumbing between them. Used by the `.base` file view, `![[x.base]]`
 * embeds and ```base code blocks. Every UI edit mutates the parsed base and
 * goes back to text through `bases.serialize`.
 */
import { getEngine } from "@vault/engine";
import type { BasesView } from "../../obsidian/bases/api";
import { Component } from "../../obsidian/events";
import { debounce } from "../../obsidian/util";
import type { TFile, TFolder } from "../../obsidian/vault/files";
import { BasesController } from "./controller";
import type { BasesPluginHost } from "./types";
import { renderToolbar } from "./toolbar";
import type { ToolbarPopover } from "./ui";

export interface HostOptions {
  embedded: boolean;
  /** The file `this` refers to. */
  getThisFile(): TFile | null;
  /** The `.base` file, when there is one (new notes default to its folder). */
  baseFile: TFile | null;
  /** Persist new YAML; null for a base that cannot be written. */
  save: ((yaml: string) => void | Promise<void>) | null;
  initialViewName?: string | null;
  onViewChanged?(name: string): void;
}

export class BasesHost extends Component {
  controller: BasesController;
  headerEl: HTMLElement;
  toolbarEl: HTMLElement;
  errorEl: HTMLElement;
  viewEl: HTMLElement;
  view: BasesView | null = null;
  popover: ToolbarPopover | null = null;
  /** Group keys collapsed by the user (per host, not saved). */
  collapsedGroups = new Set<string>();
  private mountedKey = "";
  private pendingUpdate = false;
  private commitQueued = false;
  private yaml = "";
  private parseError: string | null = null;
  private sourceSet = false;
  private rerunSoon = debounce(() => this.rerun(), 30, true);

  constructor(
    public app: any,
    public plugin: BasesPluginHost,
    public containerEl: HTMLElement,
    public options: HostOptions,
  ) {
    super();
    this.controller = new BasesController(app, plugin.store, {
      onBaseChanged: () => this.commit(),
      onNeedsRerun: () => this.rerunSoon(),
      defaultNewFileFolder: () => this.defaultFolder(),
    });
    containerEl.addClass("bases-host");
    this.headerEl = containerEl.createDiv({ cls: "bases-header" });
    this.toolbarEl = this.headerEl.createDiv({ cls: "bases-toolbar" });
    this.errorEl = containerEl.createDiv({ cls: "bases-error" });
    this.errorEl.hide();
    this.viewEl = containerEl.createDiv({ cls: "bases-view" });
  }

  override onload() {
    this.addChild(this.controller);
    this.registerEvent(this.plugin.store.on("changed", () => this.rerun()));
    this.registerEvent(this.plugin.registry.on("changed", () => this.rerun(true)));
    this.registerDomEvent(this.viewEl, "focusout", () => {
      if (this.pendingUpdate) setTimeout(() => this.flushPending(), 80);
    });
    if (this.parseError) this.showParseError();
    else if (this.sourceSet) this.rerun();
  }

  override onunload() {
    this.popover?.close();
    this.rerunSoon.cancel();
  }

  private defaultFolder(): TFolder {
    const file = this.options.baseFile ?? this.options.getThisFile();
    return file?.parent ?? this.app.vault.getRoot();
  }

  get readOnly(): boolean {
    return !this.options.save;
  }

  /** Load (or reload) the base's YAML. */
  setSource(yaml: string) {
    if (yaml === this.yaml && !this.parseError && this.controller.results) return;
    this.yaml = yaml;
    this.sourceSet = true;
    let parsed: any;
    try {
      parsed = getEngine().bases.parse(yaml.trim() === "" ? "{}" : yaml);
    } catch (e) {
      parsed = { error: String((e as Error).message ?? e) };
    }
    if (parsed?.error || !parsed?.base) {
      this.parseError = String(parsed?.error ?? "Query is an invalid format. It should be a YAML object.");
      this.controller.parseErrors = [];
      this.showParseError();
      return;
    }
    this.parseError = null;
    const keepName = this.controller.currentView?.name ?? this.options.initialViewName ?? null;
    this.controller.setBase(parsed.base);
    this.controller.parseErrors = (parsed.errors ?? []).map(String);
    if (keepName) {
      const idx = this.controller.views.findIndex((v: any) => v?.name === keepName);
      if (idx >= 0) this.controller.viewIndex = idx;
    }
    this.options.initialViewName = null;
    this.rerun();
  }

  private showParseError() {
    this.toolbarEl.empty();
    this.teardownView();
    this.viewEl.empty();
    this.errorEl.show();
    this.errorEl.empty();
    this.errorEl.createDiv({ cls: "bases-error-title", text: "This base cannot be displayed" });
    this.errorEl.createDiv({ cls: "bases-error-message", text: this.parseError ?? "" });
  }

  get yamlText(): string {
    return this.yaml;
  }

  /** The base was edited through the UI: serialise, save, re-run. */
  commit() {
    if (this.commitQueued) return;
    this.commitQueued = true;
    queueMicrotask(() => {
      this.commitQueued = false;
      const yaml = getEngine().bases.serialize(this.controller.base);
      if (yaml && yaml !== this.yaml) {
        this.yaml = yaml;
        void this.options.save?.(yaml);
      }
      this.rerun();
    });
  }

  selectView(index: number) {
    if (index < 0 || index >= this.controller.views.length) return;
    this.controller.viewIndex = index;
    this.options.onViewChanged?.(this.controller.currentView?.name ?? "");
    this.rerun();
  }

  setThisFile(file: TFile | null) {
    if (this.controller.thisFile === file) return;
    this.controller.thisFile = file;
    this.rerun();
  }

  rerun(remount = false) {
    if (!this._loaded || this.parseError) return;
    this.controller.thisFile = this.options.getThisFile();
    this.controller.run();
    this.errorEl.hide();
    renderToolbar(this, this.toolbarEl);
    if (remount) this.mountedKey = "";
    this.updateView();
    if (this.popover?.isOpen) this.popover.refresh();
  }

  private teardownView() {
    if (this.view) {
      this.removeChild(this.view);
      this.view = null;
    }
    this.mountedKey = "";
  }

  private updateView() {
    const ctrl = this.controller;
    const type = String(ctrl.currentView?.type ?? "table");
    const key = `${ctrl.viewIndex}:${type}`;
    if (key !== this.mountedKey || !this.view) {
      this.teardownView();
      this.viewEl.empty();
      this.viewEl.setAttr("data-view-type", type);
      this.mountedKey = key;
      const registration = this.plugin.registry.get(type);
      if (!registration) {
        const msg = this.viewEl.createDiv({ cls: "bases-empty-state" });
        msg.createDiv({ cls: "bases-empty-state-title", text: "Unknown view type" });
        msg.createDiv({ text: `The layout “${type}” is not available. Enable the plugin that provides it, or change the layout in the view settings.` });
        return;
      }
      try {
        const view = registration.factory(ctrl, this.viewEl);
        this.view = view;
        (view as { host?: BasesHost }).host ??= this;
        this.addChild(view);
      } catch (e) {
        console.error(e);
        this.viewEl.createDiv({ cls: "bases-empty-state", text: `Failed to load the view: ${(e as Error).message}` });
        return;
      }
    }
    if (this.isEditing()) {
      this.pendingUpdate = true;
      return;
    }
    this.pushData();
  }

  /** A layout's inline editor has focus: hold re-renders until it closes. */
  private isEditing(): boolean {
    const active = document.activeElement;
    if (!active || !this.viewEl.contains(active)) return !!document.querySelector(".suggestion-container") && !!this.viewEl.querySelector(".is-editing");
    return !!active.closest(".is-editing");
  }

  flushPending() {
    if (!this.pendingUpdate) return;
    if (this.isEditing()) return;
    this.pendingUpdate = false;
    this.pushData();
  }

  private pushData() {
    const view = this.view;
    if (!view) return;
    this.pendingUpdate = false;
    const ctrl = this.controller;
    view.config = ctrl.config!;
    view.data = ctrl.results!;
    view.allProperties = ctrl.allProperties.slice();
    try {
      view.onDataUpdated();
    } catch (e) {
      console.error("Bases view failed to render", e);
    }
  }
}
