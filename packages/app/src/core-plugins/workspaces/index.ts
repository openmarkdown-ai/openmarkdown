/**
 * Core plugin Workspaces (`workspaces`): named layouts saved in
 * `.obsidian/workspaces.json`:
 *
 *   { "workspaces": { "<name>": <workspace.getLayout()> + "mtime" }, "active": "<name>" }
 *
 * Instance API (used by plugins: Workspaces Plus, Homepage):
 *   workspaces, activeWorkspace, saveWorkspace(name), loadWorkspace(name),
 *   deleteWorkspace(name), renameWorkspace(old, new), setActiveWorkspace(name),
 *   saveData()
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import { FuzzySuggestModal } from "../../obsidian/ui/suggest";
import { moment } from "../../obsidian/util";

class WorkspacesPlugin extends Plugin {
  instance!: any;
  workspaces: Record<string, Record<string, unknown>> = {};
  activeWorkspace = "";

  override async onload() {
    const data = await this.app.vault.readConfigJson("workspaces.json");
    if (data && typeof data === "object") {
      this.workspaces = data.workspaces && typeof data.workspaces === "object" ? data.workspaces : {};
      this.activeWorkspace = typeof data.active === "string" ? data.active : "";
    }
    this.publishInstance();

    this.addRibbonIcon("lucide-layout", "Manage workspace layouts", () => this.openManager());
    this.addCommand({ id: "workspaces:open-modal", name: "Workspaces: Manage workspace layouts", icon: "lucide-layout", callback: () => this.openManager() });
    this.addCommand({
      id: "workspaces:load",
      name: "Workspaces: Load workspace layout",
      icon: "lucide-layout",
      checkCallback: (checking) => {
        if (Object.keys(this.workspaces).length === 0) return false;
        if (!checking) new LoadWorkspaceModal(this).open();
        return true;
      },
    });
    this.addCommand({
      id: "workspaces:save",
      name: "Workspaces: Save layout",
      icon: "lucide-save",
      callback: () => {
        if (this.activeWorkspace) {
          this.saveWorkspace(this.activeWorkspace);
          new Notice(`Saved layout “${this.activeWorkspace}”.`);
        } else this.openManager();
      },
    });
    this.addCommand({
      id: "workspaces:save-and-load",
      name: "Workspaces: Save and load another layout",
      icon: "lucide-layout",
      checkCallback: (checking) => {
        if (Object.keys(this.workspaces).length === 0) return false;
        if (!checking) {
          if (this.activeWorkspace) this.saveWorkspace(this.activeWorkspace);
          new LoadWorkspaceModal(this).open();
        }
        return true;
      },
    });
  }

  private publishInstance() {
    const inst = this.instance;
    const methods: Record<string, unknown> = {
      saveWorkspace: (name: string) => this.saveWorkspace(name),
      loadWorkspace: (name: string) => this.loadWorkspace(name),
      deleteWorkspace: (name: string) => this.deleteWorkspace(name),
      renameWorkspace: (from: string, to: string) => this.renameWorkspace(from, to),
      setActiveWorkspace: (name: string) => {
        this.activeWorkspace = name;
        void this.saveData();
      },
      saveData: () => this.saveData(),
    };
    Object.assign(inst, methods);
    Object.defineProperty(inst, "workspaces", { configurable: true, enumerable: false, get: () => this.workspaces });
    Object.defineProperty(inst, "activeWorkspace", {
      configurable: true,
      enumerable: false,
      get: () => this.activeWorkspace,
      set: (v: string) => (this.activeWorkspace = v),
    });
    this.register(() => {
      for (const k of Object.keys(methods)) delete inst[k];
      delete inst.workspaces;
      delete inst.activeWorkspace;
    });
  }

  override async saveData(): Promise<void> {
    await this.app.vault.writeConfigJson("workspaces.json", { workspaces: this.workspaces, active: this.activeWorkspace });
  }

  saveWorkspace(name: string) {
    name = name.trim();
    if (!name) return;
    this.workspaces[name] = { ...this.app.workspace.getLayout(), mtime: moment().format() };
    this.activeWorkspace = name;
    void this.saveData();
    this.app.workspace.trigger("workspace-save", name);
  }

  async loadWorkspace(name: string) {
    const layout = this.workspaces[name];
    if (!layout) {
      new Notice(`There is no workspace layout named “${name}”.`);
      return;
    }
    this.activeWorkspace = name;
    await this.app.workspace.changeLayout(layout);
    void this.saveData();
    this.app.workspace.requestSaveLayout();
    this.app.workspace.trigger("workspace-load", name);
  }

  deleteWorkspace(name: string) {
    delete this.workspaces[name];
    if (this.activeWorkspace === name) this.activeWorkspace = "";
    void this.saveData();
  }

  renameWorkspace(from: string, to: string): boolean {
    to = to.trim();
    if (!to || from === to || !this.workspaces[from]) return false;
    if (this.workspaces[to]) {
      new Notice(`A workspace layout named “${to}” already exists.`);
      return false;
    }
    // Rebuild the object so the order of layouts is kept.
    const next: typeof this.workspaces = {};
    for (const [k, v] of Object.entries(this.workspaces)) next[k === from ? to : k] = v;
    this.workspaces = next;
    if (this.activeWorkspace === from) this.activeWorkspace = to;
    void this.saveData();
    return true;
  }

  openManager() {
    new ManageWorkspacesModal(this).open();
  }
}

/** "Manage workspace layouts": save the current layout under a name, load, rename or delete saved ones. */
class ManageWorkspacesModal extends Modal {
  private nameValue = "";

  constructor(private plugin: WorkspacesPlugin) {
    super(plugin.app);
    this.modalEl.addClass("mod-workspaces");
    this.setTitle("Manage workspace layouts");
  }

  override onOpen(): void {
    this.nameValue = this.plugin.activeWorkspace;
    this.render();
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    const save = () => {
      const name = this.nameValue.trim();
      if (!name) {
        new Notice("Enter a name for the workspace layout.");
        return;
      }
      this.plugin.saveWorkspace(name);
      this.render();
    };
    new Setting(el).setClass("workspace-save-row").addText((t) => {
      t.setPlaceholder("Save current workspace layout as...").setValue(this.nameValue).onChange((v) => (this.nameValue = v));
      t.inputEl.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" && !evt.isComposing) {
          evt.preventDefault();
          save();
        }
      });
      window.setTimeout(() => t.inputEl.select(), 0);
    }).addButton((b) => b.setButtonText("Save").setCta().onClick(save));

    const names = Object.keys(this.plugin.workspaces);
    const list = el.createDiv({ cls: "workspace-list" });
    if (names.length === 0) {
      list.createDiv({ cls: "workspace-list-empty", text: "No saved workspace layouts yet." });
      return;
    }
    for (const name of names) {
      const layout = this.plugin.workspaces[name]!;
      const mtime = typeof layout.mtime === "string" ? moment(layout.mtime) : null;
      const row = new Setting(list).setName(name).setClass("workspace-item");
      if (mtime?.isValid()) row.setDesc(`Modified ${mtime.fromNow()}`);
      row.settingEl.toggleClass("is-active", name === this.plugin.activeWorkspace);
      row.addExtraButton((b) =>
        b
          .setIcon("lucide-edit-3")
          .setTooltip("Rename")
          .onClick(() => this.startRename(row, name)),
      );
      row.addExtraButton((b) =>
        b
          .setIcon("lucide-x")
          .setTooltip("Delete layout")
          .onClick(() => {
            this.plugin.deleteWorkspace(name);
            this.render();
          }),
      );
      row.addButton((b) =>
        b.setButtonText("Load").onClick(async () => {
          this.close();
          await this.plugin.loadWorkspace(name);
        }),
      );
    }
  }

  private startRename(row: Setting, name: string) {
    const nameEl = row.nameEl;
    nameEl.empty();
    const input = nameEl.createEl("input", { type: "text", value: name });
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      if (commit) this.plugin.renameWorkspace(name, input.value);
      this.render();
    };
    input.addEventListener("keydown", (evt) => {
      if (evt.isComposing) return;
      if (evt.key === "Enter") {
        evt.preventDefault();
        finish(true);
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        evt.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }
}

class LoadWorkspaceModal extends FuzzySuggestModal<string> {
  constructor(private plugin: WorkspacesPlugin) {
    super(plugin.app);
    this.setPlaceholder("Type workspace layout name...");
    this.emptyStateText = "No workspace layout found.";
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to load" },
      { command: "esc", purpose: "to dismiss" },
    ]);
  }
  getItems(): string[] {
    return Object.keys(this.plugin.workspaces);
  }
  getItemText(name: string): string {
    return name;
  }
  onChooseItem(name: string): void {
    void this.plugin.loadWorkspace(name);
  }
}

export const workspaces: CorePluginDefinition = {
  id: "workspaces",
  name: "Workspaces",
  description: "Save and load workspace layouts.",
  icon: "lucide-layout",
  defaultOn: false,
  defaultOptions: {},
  create: (app) => new WorkspacesPlugin(app, { id: "workspaces", name: "Workspaces", version: "", minAppVersion: "", author: "", description: "" }),
};
