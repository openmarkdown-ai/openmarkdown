/**
 * Natural language dates (`natural-dates`, off by default): type `@` in a
 * note and pick "Today", "Next Monday", "In 3 days"… to insert a link to that
 * day's note, `[[2026-09-14]]`, named with the Daily notes format. Shift+Enter
 * inserts the date as plain text.
 *
 * Compatible with the Natural Language Dates plugin (`nldates-obsidian`):
 * options in `.obsidian/natural-dates.json` use its keys (`format`,
 * `timeFormat`, `separator`, `isAutosuggestEnabled`,
 * `autocompleteTriggerPhrase`, `autosuggestToggleLink`), seeded from its
 * `data.json`; its command ids are kept (`nldates-obsidian:nlp-dates`,
 * `nlp-dates-link`, `nlp-date-clean`, `nlp-now`, `nlp-today`, `nlp-tomorrow`,
 * `nlp-yesterday`). With that plugin enabled, this one stays out of the way.
 */
import type { Moment } from "moment";
import type { Command, Editor, EditorPosition, EditorSuggestContext, EditorSuggestTriggerInfo } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { EditorSuggest } from "../../obsidian/ui/suggest";
import { moment } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";
import { addYieldingCommands, isCommunityPluginEnabled } from "../periodic-notes/yield";
import { SUGGESTED_PHRASES, parseNaturalDate } from "./parse";

export const NLDATES_PLUGIN = "nldates-obsidian";

interface NaturalDatesOptions {
  format: string;
  timeFormat: string;
  separator: string;
  weekStart: string;
  isAutosuggestEnabled: boolean;
  autocompleteTriggerPhrase: string;
  autosuggestToggleLink: boolean;
}

const DEFAULTS: NaturalDatesOptions = {
  format: "",
  timeFormat: "HH:mm",
  separator: " ",
  weekStart: "locale",
  isAutosuggestEnabled: true,
  autocompleteTriggerPhrase: "@",
  autosuggestToggleLink: true,
};

interface DateSuggestion {
  label: string;
  date: Moment;
}

export class NaturalDatesPlugin extends Plugin {
  instance!: any;

  get options(): NaturalDatesOptions {
    return Object.assign(this.instance.options, { ...DEFAULTS, ...this.instance.options }) as NaturalDatesOptions;
  }

  steppedAside(): boolean {
    return isCommunityPluginEnabled(this.app, NLDATES_PLUGIN);
  }

  /** The date format: this plugin's own, else Daily notes', else YYYY-MM-DD. */
  dateFormat(): string {
    const own = (this.options.format || "").trim();
    if (own) return own;
    const daily = this.app.internalPlugins.getPluginById("daily-notes")?.instance?.options;
    return (daily?.format || "").trim() || "YYYY-MM-DD";
  }

  weekStartsOn(): number {
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const i = days.indexOf(this.options.weekStart);
    return i === -1 ? moment.localeData().firstDayOfWeek() : i;
  }

  parse(text: string): Moment | null {
    return parseNaturalDate(text, moment(), this.weekStartsOn());
  }

  /** `[[2026-09-14]]`, or the formatted date alone. */
  textFor(date: Moment, link: boolean): string {
    const formatted = date.format(this.dateFormat());
    return link ? `[[${formatted}]]` : formatted;
  }

  override async onload() {
    await this.importCommunitySettings();
    this.registerEditorSuggest(new DateSuggest(this));
    const insert = (fn: () => string) => (editor: Editor) => editor.replaceSelection(fn());
    const parseSelection = (mode: "default" | "link" | "clean") => (editor: Editor) => {
      const selection = editor.getSelection();
      const date = this.parse(selection);
      if (!date) {
        new Notice(selection ? `Could not read “${selection}” as a date.` : "Select some text such as “next friday” first.");
        return;
      }
      editor.replaceSelection(this.textFor(date, mode === "link" || (mode === "default" && this.options.autosuggestToggleLink)));
    };
    const yielding = (cmd: Command): Command => ({
      ...cmd,
      editorCheckCallback: (checking: boolean, editor: Editor) => {
        if (this.steppedAside()) return false;
        if (!checking) (cmd.editorCallback as (e: Editor) => void)(editor);
        return true;
      },
      editorCallback: undefined,
    });
    const commands: Command[] = [
      { id: `${NLDATES_PLUGIN}:nlp-dates`, name: "Natural language dates: Parse natural language date", editorCallback: parseSelection("default") },
      { id: `${NLDATES_PLUGIN}:nlp-dates-link`, name: "Natural language dates: Parse natural language date (as link)", editorCallback: parseSelection("link") },
      { id: `${NLDATES_PLUGIN}:nlp-date-clean`, name: "Natural language dates: Parse natural language date (as plain text)", editorCallback: parseSelection("clean") },
      { id: `${NLDATES_PLUGIN}:nlp-now`, name: "Natural language dates: Insert the current date and time", editorCallback: insert(() => `${moment().format(this.dateFormat())}${this.options.separator}${moment().format(this.options.timeFormat || "HH:mm")}`) },
      { id: `${NLDATES_PLUGIN}:nlp-today`, name: "Natural language dates: Insert the current date", editorCallback: insert(() => moment().format(this.dateFormat())) },
      { id: `${NLDATES_PLUGIN}:nlp-tomorrow`, name: "Natural language dates: Insert tomorrow's date", editorCallback: insert(() => moment().add(1, "day").format(this.dateFormat())) },
      { id: `${NLDATES_PLUGIN}:nlp-yesterday`, name: "Natural language dates: Insert yesterday's date", editorCallback: insert(() => moment().subtract(1, "day").format(this.dateFormat())) },
    ].map(yielding);
    addYieldingCommands(this, NLDATES_PLUGIN, commands);
    this.instance.parseDate = (text: string) => this.parse(text);
    this.addSettingTab(new NaturalDatesSettingTab(this.app, this));
  }

  private async importCommunitySettings() {
    const vault = this.app.vault;
    try {
      if (await vault.adapter.exists(`${vault.configDir}/natural-dates.json`)) return;
      const theirs = `${vault.configDir}/plugins/${NLDATES_PLUGIN}/data.json`;
      if (!(await vault.adapter.exists(theirs))) return;
      const data = JSON.parse(await vault.adapter.read(theirs));
      if (!data || typeof data !== "object") return;
      for (const k of Object.keys(DEFAULTS)) if (k in data) this.instance.options[k] = data[k];
      await this.instance.saveOptions();
    } catch (e) {
      console.error("Natural language dates: could not read the plugin's settings", e);
    }
  }
}

class DateSuggest extends EditorSuggest<DateSuggestion> {
  constructor(private owner: NaturalDatesPlugin) {
    super(owner.app);
    this.setInstructions([
      { command: "↵", purpose: "to insert a link" },
      { command: "shift ↵", purpose: "to insert the date as text" },
      { command: "esc", purpose: "to dismiss" },
    ]);
    this.scope.register(["Shift"], "Enter", (evt) => {
      if (evt.isComposing) return;
      const s = this.chooser.values?.[this.chooser.selectedItem];
      if (s) this.insert(s, false);
      return false;
    });
  }

  onTrigger(cursor: EditorPosition, editor: any, _file: any): EditorSuggestTriggerInfo | null {
    const opts = this.owner.options;
    if (!opts.isAutosuggestEnabled || this.owner.steppedAside()) return null;
    const trigger = opts.autocompleteTriggerPhrase || "@";
    const line = editor.getLine(cursor.line).slice(0, cursor.ch);
    const at = line.lastIndexOf(trigger);
    if (at === -1) return null;
    const before = line[at - 1];
    if (before !== undefined && !/[\s([{"'“]/.test(before)) return null;
    const query = line.slice(at + trigger.length);
    if (query.startsWith(" ") || query.length > 30 || /[\]\[`]/.test(query) || query.split(" ").length > 4) return null;
    return { start: { line: cursor.line, ch: at }, end: cursor, query };
  }

  getSuggestions(context: EditorSuggestContext): DateSuggestion[] {
    const q = context.query.trim().toLowerCase();
    const out: DateSuggestion[] = [];
    const seen = new Set<string>();
    const add = (label: string) => {
      const date = this.owner.parse(label);
      if (!date || seen.has(label.toLowerCase())) return;
      seen.add(label.toLowerCase());
      out.push({ label, date });
    };
    for (const phrase of SUGGESTED_PHRASES) if (!q || phrase.toLowerCase().startsWith(q)) add(phrase);
    if (q && this.owner.parse(q)) add(context.query.trim().replace(/^\w/, (c) => c.toUpperCase()));
    // A weekday prefix: "fr" → Friday, Next Friday.
    if (q.length >= 2 && !out.length) {
      for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
        if (day.toLowerCase().startsWith(q)) {
          add(day);
          add(`Next ${day}`);
        }
      }
    }
    return out;
  }

  renderSuggestion(s: DateSuggestion, el: HTMLElement): void {
    el.addClass("mod-complex", "vault-date-suggestion");
    const content = el.createDiv({ cls: "suggestion-content" });
    content.createDiv({ cls: "suggestion-title", text: s.label });
    el.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: "suggestion-flair vault-date-suggestion-date", text: s.date.format(this.owner.dateFormat()) });
  }

  selectSuggestion(s: DateSuggestion, evt: MouseEvent | KeyboardEvent): void {
    this.insert(s, !evt.shiftKey && this.owner.options.autosuggestToggleLink);
  }

  private insert(s: DateSuggestion, link: boolean) {
    const ctx = this.context;
    if (!ctx) return;
    const text = this.owner.textFor(s.date, link);
    ctx.editor.replaceRange(text, ctx.start, ctx.end);
    ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + text.length });
    this.close();
  }
}

class NaturalDatesSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: NaturalDatesPlugin,
  ) {
    super(app, owner as any);
    this.id = "natural-dates";
    this.name = "Natural language dates";
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    const o = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();
    if (this.owner.steppedAside()) el.createEl("p", { cls: "setting-item-description", text: "The Natural Language Dates plugin is enabled, so its settings apply and these are not used." });
    new Setting(el)
      .setName("Date format")
      .setDesc("Leave empty to use the Daily notes format, so links open the daily note.")
      .addMomentFormat((m) =>
        m
          .setDefaultFormat(this.owner.dateFormat())
          .setValue(o.format)
          .onChange((v) => {
            o.format = v.trim();
            save();
          }),
      );
    new Setting(el).setName("Time format").addMomentFormat((m) =>
      m
        .setDefaultFormat("HH:mm")
        .setValue(o.timeFormat)
        .onChange((v) => {
          o.timeFormat = v.trim() || "HH:mm";
          save();
        }),
    );
    new Setting(el)
      .setName("Date suggestions")
      .setDesc("Suggest dates as you type after the trigger.")
      .addToggle((t) =>
        t.setValue(o.isAutosuggestEnabled).onChange((v) => {
          o.isAutosuggestEnabled = v;
          save();
        }),
      );
    new Setting(el).setName("Trigger").addText((t) =>
      t.setValue(o.autocompleteTriggerPhrase).onChange((v) => {
        o.autocompleteTriggerPhrase = v || "@";
        save();
      }),
    );
    new Setting(el)
      .setName("Insert dates as links")
      .setDesc("Insert [[links]] to the day's note. Shift+Enter always inserts plain text.")
      .addToggle((t) =>
        t.setValue(o.autosuggestToggleLink).onChange((v) => {
          o.autosuggestToggleLink = v;
          save();
        }),
      );
  }
}

export const naturalDates: CorePluginDefinition = {
  id: "natural-dates",
  name: "Natural language dates",
  description: "Type @today or @next monday to insert a link to that day.",
  icon: "lucide-calendar-plus",
  defaultOn: false,
  defaultOptions: { ...DEFAULTS },
  create: (app) => new NaturalDatesPlugin(app, { id: "natural-dates", name: "Natural language dates", version: "", minAppVersion: "", author: "", description: "" }),
};
