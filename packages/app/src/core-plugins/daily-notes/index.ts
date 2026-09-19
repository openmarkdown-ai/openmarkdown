/**
 * Daily notes — one note per day, named by a Moment format.
 *
 * `.obsidian/daily-notes.json`: `{ format, folder, template, autorun }`. The
 * Calendar, Periodic Notes and Homepage plugins read these through
 * `internalPlugins.getPluginById("daily-notes").instance.options`, so the keys
 * are Obsidian's; an empty `format` (older vaults) still means `YYYY-MM-DD`.
 */
import type { Moment } from "moment";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Keymap } from "../../obsidian/ui/keymap";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { moment, normalizePath } from "../../obsidian/util";
import { TFile, TFolder } from "../../obsidian/vault/files";
import { FileSuggest, FolderSuggest, resolveTemplateFile } from "../templates/input-suggest";
import { normalizeFolderInput } from "../templates/index";
import { mergeIntoText, processTemplateVariables, splitFrontmatter } from "../templates/template-vars";

export interface DailyNotesOptions {
  format: string;
  folder: string;
  template: string;
  autorun: boolean;
}

export const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";
const PRESET_FORMATS = ["YYYY-MM-DD", "YYYY.MM.DD", "YYYY/MM/DD", "YYYY/MM/YYYY-MM-DD"];

type PaneType = "tab" | "split" | "window";

export class DailyNotesPlugin extends Plugin {
  instance!: any;

  get options(): DailyNotesOptions {
    return this.instance.options as DailyNotesOptions;
  }

  getFormat(): string {
    return (this.options.format || "").trim() || DEFAULT_DAILY_FORMAT;
  }

  getFolder(): string {
    return normalizeFolderInput(this.options.folder || "");
  }

  override async onload() {
    const startingUp = !this.app.workspace.layoutReady;

    // internal (used by plugins: daily-notes interface style helpers)
    this.instance.getFormat = () => this.getFormat();
    this.instance.getDailyNote = (date?: Moment) => this.getDailyNote(date ?? moment());
    this.instance.getAllDailyNotes = () => this.getAllDailyNotes();
    this.instance.getDailyNotePath = (date?: Moment) => this.pathForDate(date ?? moment());
    this.instance.getDateFromFile = (file: TFile) => this.dateFromFile(file);
    this.instance.createDailyNote = (date?: Moment) => this.createDailyNote(date ?? moment());
    this.instance.openDailyNote = (date?: Moment, newLeaf?: PaneType | boolean) => this.openDailyNote(date ?? moment(), newLeaf);
    this.instance.gotoNextExisting = (dir: -1 | 1) => this.gotoAdjacent(dir);

    this.addCommand({
      id: "daily-notes",
      name: "Open today's daily note",
      icon: "lucide-calendar",
      callback: () => void this.openDailyNote(moment()),
    });
    this.addCommand({
      id: "daily-notes:goto-prev",
      name: "Open previous daily note",
      icon: "lucide-arrow-left",
      callback: () => void this.gotoAdjacent(-1),
    });
    this.addCommand({
      id: "daily-notes:goto-next",
      name: "Open next daily note",
      icon: "lucide-arrow-right",
      callback: () => void this.gotoAdjacent(1),
    });
    this.addRibbonIcon("lucide-calendar", "Open today's daily note", (evt) => {
      void this.openDailyNote(moment(), Keymap.isModEvent(evt));
    });

    this.registerObsidianProtocolHandler("daily", (params: Record<string, string>) => this.onDailyUri(params));

    if (startingUp) {
      this.app.workspace.onLayoutReady(() => {
        if (this.options.autorun || this.app.vault.getConfig("openBehavior") === "daily") void this.openDailyNote(moment());
      });
    }

    this.addSettingTab(new DailyNotesSettingTab(this.app, this));
  }

  pathForDate(date: Moment): string {
    const name = date.format(this.getFormat());
    const folder = this.getFolder();
    return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
  }

  getDailyNote(date: Moment): TFile | null {
    return this.app.vault.getFileByPath(this.pathForDate(date));
  }

  /** Every note whose path inside the folder parses strictly with the format. */
  getAllDailyNotes(): { file: TFile; date: Moment }[] {
    const folder = this.getFolder();
    const root: TFolder | null = folder ? this.app.vault.getFolderByPath(folder) : this.app.vault.getRoot();
    if (!root) return [];
    const out: { file: TFile; date: Moment }[] = [];
    const walk = (f: TFolder) => {
      for (const c of f.children) {
        if (c instanceof TFolder) walk(c);
        else if (c instanceof TFile && c.extension === "md") {
          const date = this.dateFromFile(c);
          if (date) out.push({ file: c, date });
        }
      }
    };
    walk(root);
    return out.sort((a, b) => a.date.valueOf() - b.date.valueOf());
  }

  dateFromFile(file: TFile): Moment | null {
    const folder = this.getFolder();
    const prefix = folder ? folder + "/" : "";
    if (prefix && !file.path.startsWith(prefix)) return null;
    const rel = file.path.slice(prefix.length).replace(/\.md$/, "");
    const format = this.getFormat();
    // Formats without slashes name files anywhere under the folder by basename.
    const candidate = format.includes("/") ? rel : file.basename;
    const date = moment(candidate, format, true);
    return date.isValid() ? date : null;
  }

  async createDailyNote(date: Moment): Promise<TFile> {
    const path = this.pathForDate(date);
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      await this.app.vault.createFolder(dir).catch(() => {});
    }
    let content = "";
    const templatePath = (this.options.template || "").trim();
    if (templatePath) {
      const templateFile = resolveTemplateFile(this.app, templatePath);
      if (!templateFile) {
        new Notice(`Failed to find the template file “${templatePath}”.`);
      } else {
        const raw = await this.app.vault.read(templateFile);
        const templates = this.app.internalPlugins.getEnabledPluginById("templates")?.options ?? {};
        const processed = processTemplateVariables(raw, {
          title: date.format(this.getFormat()).split("/").pop() ?? "",
          date,
          dateFormat: this.getFormat(),
          timeFormat: templates.timeFormat || "HH:mm",
        });
        const { properties, body } = splitFrontmatter(processed);
        content = mergeIntoText(body, properties);
      }
    }
    return this.app.vault.create(path, content);
  }

  async openDailyNote(date: Moment, newLeaf?: PaneType | boolean): Promise<TFile | null> {
    const format = this.getFormat();
    if (!moment(date.format(format), format, true).isValid()) {
      new Notice("The daily note date format is invalid. Check Settings → Daily notes.");
      return null;
    }
    let file = this.getDailyNote(date);
    try {
      file ??= await this.createDailyNote(date);
    } catch (e) {
      new Notice(`Unable to create a new daily note: ${String((e as Error)?.message ?? e)}`);
      return null;
    }
    const leaf = this.app.workspace.getLeaf(newLeaf ?? false);
    await leaf.openFile(file, { active: true });
    return file;
  }

  async gotoAdjacent(dir: -1 | 1) {
    const all = this.getAllDailyNotes();
    const active: TFile | null = this.app.workspace.getActiveFile();
    const current = (active && this.dateFromFile(active)) || moment();
    const pick = dir < 0 ? [...all].reverse().find((n) => n.date.isBefore(current, "day")) : all.find((n) => n.date.isAfter(current, "day"));
    if (!pick) {
      new Notice(dir < 0 ? "There's no daily note before this one." : "There's no daily note after this one.");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(pick.file, { active: true });
  }

  /** `obsidian://daily?content=…&append=true&silent=true` (1.7.2). */
  private async onDailyUri(params: Record<string, string>) {
    const truthy = (v: string | undefined) => v !== undefined && v !== "false";
    let content = params.content;
    if (truthy(params.clipboard)) {
      try {
        content = await navigator.clipboard.readText();
      } catch {
        /* clipboard unavailable without a gesture */
      }
    }
    const date = moment();
    let file = this.getDailyNote(date);
    try {
      file ??= await this.createDailyNote(date);
    } catch (e) {
      new Notice(`Unable to create a new daily note: ${String((e as Error)?.message ?? e)}`);
      return;
    }
    if (content !== undefined && content !== "") {
      if (truthy(params.append)) {
        await this.app.vault.process(file, (text: string) => joinText(text, content!));
      } else if (truthy(params.prepend)) {
        await this.app.vault.process(file, (text: string) => prependAfterFrontmatter(text, content!));
      } else if (truthy(params.overwrite)) {
        await this.app.vault.modify(file, content);
      }
    }
    if (!truthy(params.silent)) {
      const pane = params.paneType === "tab" || params.paneType === "split" || params.paneType === "window" ? (params.paneType as PaneType) : false;
      await this.app.workspace.getLeaf(pane).openFile(file, { active: true });
    }
  }
}

function joinText(text: string, add: string): string {
  if (!text) return add;
  return text.endsWith("\n") ? text + add : `${text}\n${add}`;
}

function prependAfterFrontmatter(text: string, add: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  const head = m ? m[0] : "";
  const body = text.slice(head.length);
  return head + (body ? `${add}\n${body}` : add);
}

class DailyNotesSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: DailyNotesPlugin,
  ) {
    super(app, owner as any);
    this.id = "daily-notes";
    this.name = "Daily notes";
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const options = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();

    const current = (options.format || "").trim() || DEFAULT_DAILY_FORMAT;
    const isPreset = PRESET_FORMATS.includes(current);

    const customSample = createEl("b", { cls: "u-pop" });
    const customDesc = createFragment((f) => {
      f.appendText("For more syntax, refer to ");
      f.createEl("a", { text: "format reference", href: "https://momentjs.com/docs/#/displaying/format/" });
      f.createEl("br");
      f.appendText("Your current syntax looks like this: ");
      f.appendChild(customSample);
    });

    let customSetting: Setting | null = null;
    let presetSample: HTMLElement | null = null;
    new Setting(containerEl)
      .setName("Date format")
      .setDesc(createFragment((f) => {
        f.appendText("Your current syntax looks like this: ");
        presetSample = f.createEl("b", { cls: "u-pop", text: moment().format(current) });
      }))
      .addDropdown((dd) => {
        for (const f of PRESET_FORMATS) dd.addOption(f, `${f}${f === DEFAULT_DAILY_FORMAT ? " (default)" : ""}`);
        dd.addOption("custom", "Custom");
        dd.setValue(isPreset ? current : "custom");
        dd.onChange((value) => {
          if (value === "custom") {
            customSetting?.settingEl.show();
            return;
          }
          customSetting?.settingEl.hide();
          presetSample?.setText(moment().format(value));
          options.format = value;
          save();
        });
      });

    customSetting = new Setting(containerEl)
      .setName("Custom format")
      .setDesc(customDesc)
      .addMomentFormat((m) =>
        m
          .setDefaultFormat(DEFAULT_DAILY_FORMAT)
          .setSampleEl(customSample)
          .setValue(options.format || "")
          .onChange((value) => {
            options.format = value.trim();
            save();
          }),
      );
    if (isPreset) customSetting.settingEl.hide();

    new Setting(containerEl)
      .setName("New file location")
      .setDesc("New daily notes will be placed here.")
      .addSearch((search) => {
        search.setPlaceholder("Example: folder 1/folder 2").setValue(options.folder ?? "");
        new FolderSuggest(this.app, search.inputEl);
        search.onChange((value) => {
          options.folder = normalizeFolderInput(value);
          save();
        });
      });

    new Setting(containerEl)
      .setName("Template file location")
      .setDesc("Choose the file to use as a template.")
      .addSearch((search) => {
        search.setPlaceholder("Example: folder/note").setValue(options.template ?? "");
        new FileSuggest(this.app, search.inputEl);
        search.onChange((value) => {
          options.template = value.trim().replace(/^\/+/, "");
          save();
        });
      });

    new Setting(containerEl)
      .setName("Open daily note on startup")
      .setDesc("Open your daily note automatically whenever you open this vault. You can also set Files and links → Default file to open → Daily note.")
      .addToggle((t) =>
        t.setValue(!!options.autorun).onChange((value) => {
          options.autorun = value;
          save();
        }),
      );
  }
}

export const dailyNotes: CorePluginDefinition = {
  id: "daily-notes",
  name: "Daily notes",
  description: "Create or open today's daily note.",
  icon: "lucide-calendar",
  defaultOn: true,
  defaultOptions: { format: DEFAULT_DAILY_FORMAT, folder: "", template: "", autorun: false },
  create: (app) =>
    new DailyNotesPlugin(app, { id: "daily-notes", name: "Daily notes", version: "", minAppVersion: "", author: "", description: "Create or open today's daily note." }),
};
