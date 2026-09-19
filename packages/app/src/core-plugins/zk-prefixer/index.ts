/**
 * Core plugin Unique note creator (`zk-prefixer`).
 *
 * "Create new unique note" names a note by the current time in the chosen
 * Moment format (default `YYYYMMDDHHmm`); when that name is taken it moves to
 * the next free timestamp. "Add unique internal link" does the same without
 * opening the note and links the selection to it. A template file, if set, is
 * copied in with `{{title}}`, `{{date}}`, `{{time}}` processed as the
 * Templates plugin does (using its date and time formats when it is enabled).
 *
 * Options (`.obsidian/zk-prefixer.json`): `format`, `folder`, `template`.
 */
import type { Editor } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Notice } from "../../obsidian/ui/notice";
import { SettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { moment, normalizePath } from "../../obsidian/util";
import { TFolder, type TFile } from "../../obsidian/vault/files";
import { leafForNewNote, openForRename } from "../file-explorer/actions";
import { FileSuggest, FolderSuggest, resolveTemplateFile } from "../templates/input-suggest";
import { processTemplateVariables } from "../templates/template-vars";

interface ZkOptions {
  format: string;
  folder: string;
  template: string;
}

const DEFAULTS: ZkOptions = { format: "YYYYMMDDHHmm", folder: "", template: "" };
/** Give up looking for a free timestamp after this many steps (a format without minutes never changes). */
const MAX_STEPS = 60 * 24 * 2;

class ZkPrefixerPlugin extends Plugin {
  instance!: any;

  get options(): ZkOptions {
    const o = this.instance.options;
    for (const [k, v] of Object.entries(DEFAULTS)) if (typeof o[k] !== "string") o[k] = v;
    return o;
  }

  override onload() {
    this.instance.createUniqueNote = () => this.createUniqueNote(true);
    this.register(() => delete this.instance.createUniqueNote);
    this.addCommand({
      id: "zk-prefixer",
      name: "Unique note creator: Create new unique note",
      icon: "lucide-file-clock",
      callback: () => void this.createUniqueNote(true),
    });
    this.addCommand({
      id: "insert-unique-link",
      name: "Unique note creator: Add unique internal link",
      icon: "lucide-link",
      editorCallback: (editor: Editor, ctx: any) => void this.insertUniqueLink(editor, ctx?.file ?? null),
    });
    this.addRibbonIcon("lucide-file-clock", "Create new unique note", () => void this.createUniqueNote(true));
    if (this.app.setting?.addSettingTab) this.addSettingTab(new ZkSettingTab(this.app, this));
  }

  private async targetFolder(): Promise<TFolder> {
    const { vault, fileManager, workspace } = this.app;
    const configured = normalizePath(this.options.folder.trim() || "/");
    if (configured !== "/") {
      const existing = vault.getAbstractFileByPath(configured);
      if (existing instanceof TFolder) return existing;
      try {
        return await vault.createFolder(configured);
      } catch {
        new Notice(`Could not create the folder “${configured}”. Using the default location.`);
      }
    }
    return fileManager.getNewFileParent(workspace.getActiveFile()?.path ?? "");
  }

  /** The first timestamp name (from now, a minute at a time) with no note in `folder`. */
  private availableName(folder: TFolder): string {
    const { vault } = this.app;
    const format = this.options.format.trim() || DEFAULTS.format;
    const t = moment();
    for (let i = 0; i < MAX_STEPS; i++) {
      const name = t.format(format);
      const path = normalizePath(folder.isRoot() ? `${name}.md` : `${folder.path}/${name}.md`);
      if (!vault.getAbstractFileByPathInsensitive(path)) return name;
      t.add(1, "minute");
    }
    const base = moment().format(format);
    const path = vault.getAvailablePath(folder.isRoot() ? base : `${folder.path}/${base}`, "md");
    return path.slice(path.lastIndexOf("/") + 1, -3);
  }

  private async templateContent(title: string): Promise<string> {
    const templatePath = this.options.template.trim();
    if (!templatePath) return "";
    const file = resolveTemplateFile(this.app, templatePath);
    if (!file) {
      new Notice(`Template file “${templatePath}” not found.`);
      return "";
    }
    const text = await this.app.vault.cachedRead(file);
    const templates = this.app.internalPlugins.getEnabledPluginById("templates")?.options ?? {};
    return processTemplateVariables(text, {
      title,
      dateFormat: templates.dateFormat || "YYYY-MM-DD",
      timeFormat: templates.timeFormat || "HH:mm",
    });
  }

  private async createNote(): Promise<TFile | null> {
    const folder = await this.targetFolder();
    const name = this.availableName(folder);
    const path = normalizePath(folder.isRoot() ? `${name}.md` : `${folder.path}/${name}.md`);
    try {
      return await this.app.vault.create(path, await this.templateContent(name));
    } catch (e) {
      new Notice(String((e as Error).message ?? e));
      return null;
    }
  }

  async createUniqueNote(open: boolean): Promise<TFile | null> {
    const file = await this.createNote();
    if (file && open) {
      // The cursor lands at the end of the inline title, ready to type a name after the prefix.
      await openForRename(leafForNewNote(this.app, undefined), file, "end", { mode: "source" });
    }
    return file;
  }

  private async insertUniqueLink(editor: Editor, source: TFile | null) {
    const selection = editor.getSelection();
    const file = await this.createNote();
    if (!file) return;
    const link = this.app.fileManager.generateMarkdownLink(file, source?.path ?? "", undefined, selection || undefined);
    editor.replaceSelection(link);
  }
}

class ZkSettingTab extends SettingTab {
  constructor(
    app: any,
    private plugin: ZkPrefixerPlugin,
  ) {
    super(app);
    this.id = "zk-prefixer";
    this.icon = "lucide-puzzle";
    this.name = "Unique note creator";
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    const opts = this.plugin.options;
    const save = () => void this.plugin.instance.saveOptions();

    const desc = createFragment((f) => {
      f.appendText("The format of the unique prefix. For more syntax, refer to ");
      f.createEl("a", { text: "format reference", href: "https://momentjs.com/docs/#/displaying/format/" });
      f.createEl("br");
      f.appendText("Your current syntax looks like this: ");
    });
    const sample = desc.createEl("b", { cls: "u-pop" });
    new Setting(el)
      .setName("Unique prefix format")
      .setDesc(desc)
      .addMomentFormat((m) =>
        m
          .setDefaultFormat(DEFAULTS.format)
          .setSampleEl(sample)
          .setValue(opts.format === DEFAULTS.format ? "" : opts.format)
          .onChange((v) => {
            opts.format = v.trim() || DEFAULTS.format;
            save();
          }),
      );
    new Setting(el)
      .setName("New file location")
      .setDesc("Newly created notes will appear under this folder.")
      .addSearch((s) => {
        s.setPlaceholder("Example: folder1/folder2").setValue(opts.folder);
        new FolderSuggest(this.app, s.inputEl);
        s.onChange((v) => {
          opts.folder = v.trim().replace(/^\/+|\/+$/g, "");
          save();
        });
      });
    new Setting(el)
      .setName("Template file location")
      .setDesc("Choose the file to use as a template.")
      .addSearch((s) => {
        s.setPlaceholder("Example: folder/note").setValue(opts.template);
        new FileSuggest(this.app, s.inputEl);
        s.onChange((v) => {
          opts.template = v.trim();
          save();
        });
      });
  }
}

export const zkPrefixer: CorePluginDefinition = {
  id: "zk-prefixer",
  name: "Unique note creator",
  description: "Create notes with unique timestamp prefixes (zettelkasten).",
  icon: "lucide-file-clock",
  defaultOn: false,
  defaultOptions: { ...DEFAULTS },
  create: (app) =>
    new ZkPrefixerPlugin(app, { id: "zk-prefixer", name: "Unique note creator", version: "", minAppVersion: "", author: "", description: "" }),
};
