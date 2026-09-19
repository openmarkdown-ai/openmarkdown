/**
 * Templates — insert a note from the template folder at the cursor.
 *
 * `.obsidian/templates.json`: `{ folder, dateFormat, timeFormat }`. Templater,
 * QuickAdd and others read `getPluginById("templates").instance.options`, so
 * the keys are Obsidian's.
 */
import type { Editor } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { FuzzySuggestModal } from "../../obsidian/ui/suggest";
import { moment, normalizePath } from "../../obsidian/util";
import { TFile, TFolder } from "../../obsidian/vault/files";
import { FolderSuggest } from "./input-suggest";
import { frontmatterBlock, mergeProperties, processTemplateVariables, splitFrontmatter } from "./template-vars";
import { getFrontMatterInfo, parseYaml } from "../../obsidian/util";

export interface TemplatesOptions {
  folder: string;
  dateFormat: string;
  timeFormat: string;
}

const DEFAULTS: TemplatesOptions = { folder: "", dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" };

export class TemplatesPlugin extends Plugin {
  instance!: any;

  get options(): TemplatesOptions {
    return this.instance.options as TemplatesOptions;
  }

  override async onload() {
    this.instance.insertTemplate = (file: TFile, editor?: Editor) => this.insertTemplate(file, editor);
    this.instance.getTemplateFiles = () => this.getTemplateFiles();
    this.instance.getTemplateFolder = () => this.getTemplateFolder();
    // internal (used by plugins: daily notes interface, note composer)
    this.instance.processTemplate = (text: string, title: string) => processTemplateVariables(text, this.context(title));

    this.addCommand({
      id: "templates:insert-template",
      name: "Insert template",
      icon: "lucide-files",
      editorCallback: (editor: Editor) => this.chooseTemplate(editor),
    });
    this.addCommand({
      id: "templates:insert-current-date",
      name: "Insert current date",
      icon: "lucide-calendar",
      editorCallback: (editor: Editor) => editor.replaceSelection(moment().format(this.options.dateFormat || DEFAULTS.dateFormat)),
    });
    this.addCommand({
      id: "templates:insert-current-time",
      name: "Insert current time",
      icon: "lucide-clock",
      editorCallback: (editor: Editor) => editor.replaceSelection(moment().format(this.options.timeFormat || DEFAULTS.timeFormat)),
    });
    this.addRibbonIcon("lucide-files", "Insert template", () => {
      const editor = this.app.workspace.activeEditor?.editor as Editor | undefined;
      if (!editor) {
        new Notice("Open a note to insert a template into.");
        return;
      }
      this.chooseTemplate(editor);
    });

    this.addSettingTab(new TemplatesSettingTab(this.app, this));
  }

  context(title: string) {
    return { title, dateFormat: this.options.dateFormat || DEFAULTS.dateFormat, timeFormat: this.options.timeFormat || DEFAULTS.timeFormat };
  }

  getTemplateFolder(): TFolder | null {
    const path = normalizePath(this.options.folder || "");
    if (!this.options.folder || path === "/") return null;
    return this.app.vault.getFolderByPath(path);
  }

  getTemplateFiles(): TFile[] {
    const folder = this.getTemplateFolder();
    if (!folder) return [];
    const out: TFile[] = [];
    const walk = (f: TFolder) => {
      for (const c of f.children) {
        if (c instanceof TFolder) walk(c);
        else if (c instanceof TFile && c.extension === "md") out.push(c);
      }
    };
    walk(folder);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  chooseTemplate(editor: Editor) {
    if (!this.options.folder?.trim()) {
      new Notice("Template folder is not set. Choose one in Settings → Templates.");
      return;
    }
    const folder = this.getTemplateFolder();
    if (!folder) {
      new Notice(`Failed to find the template folder “${this.options.folder}”.`);
      return;
    }
    const files = this.getTemplateFiles();
    if (files.length === 0) {
      new Notice("No templates found.");
      return;
    }
    new TemplateSuggestModal(this, files, folder, (file) => void this.insertTemplate(file, editor)).open();
  }

  /** Insert `file`'s processed content at the cursor, merging its properties into the note. */
  async insertTemplate(file: TFile, editor?: Editor): Promise<void> {
    const ed = editor ?? (this.app.workspace.activeEditor?.editor as Editor | undefined);
    const target: TFile | null = this.app.workspace.activeEditor?.file ?? this.app.workspace.getActiveFile();
    if (!ed) {
      new Notice("Open a note to insert a template into.");
      return;
    }
    const raw = await this.app.vault.read(file);
    const processed = processTemplateVariables(raw, this.context(target?.basename ?? ""));
    const { properties, body, error } = splitFrontmatter(processed);
    if (error) new Notice("Failed to read the template's properties. Check its YAML.");

    ed.replaceSelection(body);

    if (properties && Object.keys(properties).length) {
      const text = ed.getValue();
      const info = getFrontMatterInfo(text);
      let existing: Record<string, unknown> = {};
      if (info.exists) {
        try {
          const data = parseYaml(info.frontmatter);
          if (data && typeof data === "object" && !Array.isArray(data)) existing = data as Record<string, unknown>;
          else if (data !== null) throw new Error("not an object");
        } catch {
          new Notice("The note's properties could not be read, so the template's properties were not merged.");
          return;
        }
      }
      const block = frontmatterBlock(mergeProperties(existing, properties));
      const from = ed.offsetToPos(0);
      const to = ed.offsetToPos(info.exists ? info.contentStart : 0);
      ed.replaceRange(block, from, to);
    }
    ed.focus();
  }
}

class TemplateSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    private plugin: TemplatesPlugin,
    private files: TFile[],
    private folder: TFolder,
    private onPick: (file: TFile) => void,
  ) {
    super(plugin.app);
    this.setPlaceholder("Type name of a template...");
    this.emptyStateText = "No templates found.";
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to insert" },
      { command: "esc", purpose: "to dismiss" },
    ]);
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    const prefix = this.folder.isRoot() ? "" : this.folder.path + "/";
    const rel = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
    return rel.replace(/\.md$/, "");
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}

class TemplatesSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: TemplatesPlugin,
  ) {
    super(app, owner as any);
    this.id = "templates";
    this.name = "Templates";
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const options = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();

    new Setting(containerEl)
      .setName("Template folder location")
      .setDesc("Files in this folder will be available as templates.")
      .addSearch((search) => {
        search.setPlaceholder("Example: folder1/folder2").setValue(options.folder ?? "");
        new FolderSuggest(this.app, search.inputEl);
        search.onChange((value) => {
          options.folder = normalizeFolderInput(value);
          save();
        });
      });

    const dateDesc = createFragment((f) => {
      f.appendText("{{date}} in the template file will be replaced with this value.");
      f.createEl("br");
      f.appendText("You can also use {{date:YYYY-MM-DD}} to override the format once.");
      f.createEl("br");
      f.appendText("For more syntax, refer to ");
      f.createEl("a", { text: "format reference", href: "https://momentjs.com/docs/#/displaying/format/" });
      f.createEl("br");
      f.appendText("Your current syntax looks like this: ");
    });
    const dateSample = dateDesc.createEl("b", { cls: "u-pop" });
    new Setting(containerEl)
      .setName("Date format")
      .setDesc(dateDesc)
      .addMomentFormat((m) =>
        m
          .setDefaultFormat(DEFAULTS.dateFormat)
          .setSampleEl(dateSample)
          .setValue(options.dateFormat ?? "")
          .onChange((value) => {
            options.dateFormat = value || DEFAULTS.dateFormat;
            save();
          }),
      );

    const timeDesc = createFragment((f) => {
      f.appendText("{{time}} in the template file will be replaced with this value.");
      f.createEl("br");
      f.appendText("You can also use {{time:HH:mm}} to override the format once.");
      f.createEl("br");
      f.appendText("Your current syntax looks like this: ");
    });
    const timeSample = timeDesc.createEl("b", { cls: "u-pop" });
    new Setting(containerEl)
      .setName("Time format")
      .setDesc(timeDesc)
      .addMomentFormat((m) =>
        m
          .setDefaultFormat(DEFAULTS.timeFormat)
          .setSampleEl(timeSample)
          .setValue(options.timeFormat ?? "")
          .onChange((value) => {
            options.timeFormat = value || DEFAULTS.timeFormat;
            save();
          }),
      );
  }
}

export function normalizeFolderInput(value: string): string {
  const v = value.trim();
  if (!v) return "";
  const p = normalizePath(v);
  return p === "/" ? "" : p;
}

export const templates: CorePluginDefinition = {
  id: "templates",
  name: "Templates",
  description: "Insert template content from a folder of template files.",
  icon: "lucide-files",
  defaultOn: true,
  defaultOptions: { ...DEFAULTS },
  create: (app) =>
    new TemplatesPlugin(app, { id: "templates", name: "Templates", version: "", minAppVersion: "", author: "", description: "Insert template content from a folder of template files." }),
};
