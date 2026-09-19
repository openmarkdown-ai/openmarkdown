/**
 * Calendar (`calendar`, off by default): a month grid in the right sidebar.
 * Days with a daily note carry dots (one per `wordsPerDot` words, up to five);
 * clicking a day opens its daily note, creating it (after a confirmation, by
 * default) when there is none. Mod-click opens in a new tab. With week numbers
 * shown, clicking a week number opens that week's note (Periodic notes' weekly
 * settings when that core plugin is on, otherwise the Calendar's own).
 *
 * Compatible with the Calendar community plugin: options in
 * `.obsidian/calendar.json` use its `data.json` keys (`shouldConfirmBeforeCreate`,
 * `weekStart`, `wordsPerDot`, `showWeeklyNote`, `weeklyNoteFormat`,
 * `weeklyNoteFolder`, `weeklyNoteTemplate`) and are seeded from
 * `.obsidian/plugins/calendar/data.json`; the DOM uses its class names
 * (`#calendar-container`, `table.calendar`, `.day`, `.today`, `.active`,
 * `.has-note`, `.adjacent-month`, `.week-num`, `.dot`) so themes that style it
 * apply. Its command ids are kept (`calendar:show-calendar-view`,
 * `calendar:open-weekly-note`, `calendar:reveal-active-note`). The view type is
 * `calendar-view` so the plugin's own `calendar` view can register beside it;
 * with the plugin enabled this one opens nothing.
 */
import type { Moment } from "moment";
import type { Command, ViewStateResult } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Keymap } from "../../obsidian/ui/keymap";
import { Menu } from "../../obsidian/ui/menu";
import { ConfirmationModal } from "../../obsidian/ui/modal";
import { Setting } from "../../obsidian/ui/setting";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { debounce, moment } from "../../obsidian/util";
import { TFile, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ItemView } from "../../obsidian/workspace/view";
import { dateFromFile, getNote, openNote, type PeriodConfig, type Periodicity } from "../periodic-notes/periods";
import { addYieldingCommands, isCommunityPluginEnabled } from "../periodic-notes/yield";

export const VIEW_TYPE_CALENDAR = "calendar-view";
export const CALENDAR_PLUGIN = "calendar";

type WeekStart = "locale" | "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface CalendarOptions {
  shouldConfirmBeforeCreate: boolean;
  weekStart: WeekStart;
  wordsPerDot: number;
  showWeeklyNote: boolean;
  weeklyNoteFormat: string;
  weeklyNoteTemplate: string;
  weeklyNoteFolder: string;
  localeOverride: string;
}

const DEFAULTS: CalendarOptions = {
  shouldConfirmBeforeCreate: true,
  weekStart: "locale",
  wordsPerDot: 250,
  showWeeklyNote: false,
  weeklyNoteFormat: "",
  weeklyNoteTemplate: "",
  weeklyNoteFolder: "",
  localeOverride: "system-default",
};

export function countWords(text: string): number {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
  const cjk = body.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g)?.length ?? 0;
  const words = body.replace(/[぀-ヿ㐀-䶿一-鿿가-힯]/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)?.length ?? 0;
  return words + cjk;
}

export class CalendarPlugin extends Plugin {
  instance!: any;

  get options(): CalendarOptions {
    return Object.assign(this.instance.options, { ...DEFAULTS, ...this.instance.options }) as CalendarOptions;
  }

  steppedAside(): boolean {
    return isCommunityPluginEnabled(this.app, CALENDAR_PLUGIN);
  }

  dailyConfig(): PeriodConfig | null {
    const daily = this.app.internalPlugins.getEnabledPluginById("daily-notes");
    if (!daily) return null;
    const o = daily.options ?? {};
    return { enabled: true, format: o.format ?? "", folder: o.folder ?? "", template: o.template ?? "" };
  }

  weeklyConfig(): PeriodConfig {
    const periodic = this.app.internalPlugins.getEnabledPluginById("periodic-notes");
    if (periodic?.isPeriodEnabled?.("weekly")) return periodic.getConfig("weekly");
    const o = this.options;
    return { enabled: true, format: o.weeklyNoteFormat, folder: o.weeklyNoteFolder, template: o.weeklyNoteTemplate };
  }

  override async onload() {
    await this.importCommunitySettings();
    this.registerView(VIEW_TYPE_CALENDAR, (leaf: WorkspaceLeaf) => new CalendarView(leaf, this));
    const commands: Command[] = [
      {
        id: "calendar:show-calendar-view",
        name: "Calendar: Open view",
        icon: "lucide-calendar-range",
        checkCallback: (checking) => {
          if (this.steppedAside()) return false;
          if (!checking) void this.revealView(true);
          return true;
        },
      },
      {
        id: "calendar:open-weekly-note",
        name: "Calendar: Open Weekly Note",
        icon: "lucide-calendar-days",
        checkCallback: (checking) => {
          if (this.steppedAside()) return false;
          if (!checking) void openNote(this.app, "weekly", this.weeklyConfig(), moment().startOf("week"));
          return true;
        },
      },
      {
        id: "calendar:reveal-active-note",
        name: "Calendar: Reveal active note",
        icon: "lucide-calendar-search",
        checkCallback: (checking) => {
          if (this.steppedAside()) return false;
          if (!checking) void this.revealView(true).then((view) => view?.revealActive());
          return true;
        },
      },
    ];
    addYieldingCommands(this, CALENDAR_PLUGIN, commands);
    this.addSettingTab(new CalendarSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.steppedAside()) return;
      if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR).length === 0) void this.app.workspace.ensureSideLeaf(VIEW_TYPE_CALENDAR, "right", { reveal: false });
    });
  }

  override onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CALENDAR);
  }

  private async importCommunitySettings() {
    const vault = this.app.vault;
    const own = `${vault.configDir}/${CALENDAR_PLUGIN}.json`;
    const theirs = `${vault.configDir}/plugins/${CALENDAR_PLUGIN}/data.json`;
    try {
      if (await vault.adapter.exists(own)) return;
      if (!(await vault.adapter.exists(theirs))) return;
      const data = JSON.parse(await vault.adapter.read(theirs));
      if (!data || typeof data !== "object") return;
      for (const k of Object.keys(DEFAULTS)) if (k in data) this.instance.options[k] = data[k];
      await this.instance.saveOptions();
    } catch (e) {
      console.error("Calendar: could not read the Calendar plugin's settings", e);
    }
  }

  async revealView(focus: boolean): Promise<CalendarView | null> {
    const leaf: WorkspaceLeaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_CALENDAR, "right", { active: focus, reveal: true });
    return leaf.view instanceof CalendarView ? leaf.view : null;
  }

  /** Opens (or, after confirming, creates) the note of `p` for `date`. */
  async openPeriod(p: Periodicity, date: Moment, evt: MouseEvent | KeyboardEvent | null) {
    const config = p === "daily" ? this.dailyConfig() : this.weeklyConfig();
    if (!config) return;
    const newLeaf = evt ? Keymap.isModEvent(evt) : false;
    if (p === "daily") {
      const daily = this.app.internalPlugins.getEnabledPluginById("daily-notes");
      const existing = getNote(this.app, p, config, date);
      if (!existing && this.options.shouldConfirmBeforeCreate && !(await this.confirmCreate(date.format(config.format || "YYYY-MM-DD")))) return;
      if (daily?.openDailyNote) {
        await daily.openDailyNote(date, newLeaf);
        return;
      }
    } else if (!getNote(this.app, p, config, date) && this.options.shouldConfirmBeforeCreate && !(await this.confirmCreate(date.format(config.format || "gggg-[W]ww")))) return;
    await openNote(this.app, p, config, date, newLeaf);
  }

  private confirmCreate(name: string): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const modal = new ConfirmationModal(this.app);
      modal.setTitle("New note");
      modal.setContent(`File ${name} does not exist. Would you like to create it?`);
      modal.addButton((b) =>
        b
          .setButtonText("Create")
          .setCta()
          .onClick(() => {
            done = true;
            resolve(true);
          }),
      );
      modal.addCancelButton();
      const close = modal.onClose.bind(modal);
      modal.onClose = () => {
        close();
        if (!done) resolve(false);
      };
      modal.open();
    });
  }
}

export class CalendarView extends ItemView {
  displayedMonth: Moment = moment().startOf("month");
  gridEl!: HTMLElement;
  private words = new Map<string, { mtime: number; words: number }>();
  private requestRender = debounce(() => void this.render(), 150, true);

  constructor(
    leaf: WorkspaceLeaf,
    private owner: CalendarPlugin,
  ) {
    super(leaf);
    this.icon = "lucide-calendar-range";
    this.navigation = false;
  }

  getViewType() {
    return VIEW_TYPE_CALENDAR;
  }

  getDisplayText() {
    return "Calendar";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("vault-calendar-view");
    this.gridEl = this.contentEl.createDiv({ attr: { id: "calendar-container" }, cls: "container" });
    const refresh = (f?: TAbstractFile) => {
      if (!f || (f instanceof TFile && f.extension === "md")) this.requestRender();
    };
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.workspace.on("file-open", () => this.requestRender()));
    // A new day while the app is open moves "today".
    let today = moment().format("YYYY-MM-DD");
    this.registerInterval(
      window.setInterval(() => {
        const now = moment().format("YYYY-MM-DD");
        if (now !== today) {
          today = now;
          this.requestRender();
        }
      }, 60_000),
    );
    await this.render();
  }

  override getState(): Record<string, unknown> {
    return {};
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
  }

  // internal
  setMonth(month: Moment) {
    this.displayedMonth = month.clone().startOf("month");
    void this.render();
  }

  revealActive() {
    const file = this.app.workspace.getActiveFile() as TFile | null;
    const daily = this.owner.dailyConfig();
    const date = file && daily ? dateFromFile("daily", daily, file) : null;
    const week = file ? dateFromFile("weekly", this.owner.weeklyConfig(), file) : null;
    const target = date ?? week;
    if (target) this.setMonth(target);
  }

  private weekStartIndex(): number {
    const ws = this.owner.options.weekStart;
    if (ws && ws !== "locale") {
      const i = WEEKDAYS.indexOf(ws);
      if (i !== -1) return i;
    }
    return moment.localeData().firstDayOfWeek();
  }

  private async wordsIn(file: TFile): Promise<number> {
    const cached = this.words.get(file.path);
    if (cached && cached.mtime === file.stat.mtime) return cached.words;
    let words = 0;
    try {
      words = countWords(await this.app.vault.cachedRead(file));
    } catch {
      words = 0;
    }
    this.words.set(file.path, { mtime: file.stat.mtime, words });
    return words;
  }

  async render() {
    const el = this.gridEl;
    if (!el) return;
    const opts = this.owner.options;
    const daily = this.owner.dailyConfig();
    const weekly = this.owner.weeklyConfig();
    const month = this.displayedMonth;
    const today = moment();
    const activeFile = this.app.workspace.getActiveFile() as TFile | null;
    const start = this.weekStartIndex();

    const nav = createDiv({ cls: "nav" });
    const title = nav.createEl("h3", { cls: "title" });
    title.createSpan({ cls: "month", text: month.format("MMMM") });
    title.appendText(" ");
    title.createSpan({ cls: "year", text: month.format("YYYY") });
    const right = nav.createDiv({ cls: "right-nav" });
    const prev = right.createDiv({ cls: "arrow", attr: { "aria-label": "Previous month", role: "button" } });
    setIcon(prev, "lucide-chevron-left");
    prev.addEventListener("click", () => this.setMonth(month.clone().subtract(1, "month")));
    const reset = right.createDiv({ cls: "reset-button", text: "Today", attr: { role: "button" } });
    reset.addEventListener("click", () => this.setMonth(moment()));
    const next = right.createDiv({ cls: "arrow right", attr: { "aria-label": "Next month", role: "button" } });
    setIcon(next, "lucide-chevron-right");
    next.addEventListener("click", () => this.setMonth(month.clone().add(1, "month")));

    const table = createEl("table", { cls: "calendar" + (opts.showWeeklyNote ? " vault-show-week-nums" : "") });
    const colgroup = table.createEl("colgroup");
    if (opts.showWeeklyNote) colgroup.createEl("col", { cls: "week-num" });
    for (let i = 0; i < 7; i++) colgroup.createEl("col", { cls: (start + i) % 7 === 0 || (start + i) % 7 === 6 ? "weekend" : "" });
    const headRow = table.createEl("thead").createEl("tr");
    if (opts.showWeeklyNote) headRow.createEl("th", { text: "W" });
    const shortDays = moment.weekdaysShort();
    for (let i = 0; i < 7; i++) headRow.createEl("th", { text: shortDays[(start + i) % 7]! });

    const body = table.createEl("tbody");
    const first = month.clone();
    const offset = (first.day() - start + 7) % 7;
    const cursor = first.clone().subtract(offset, "days");
    const dotJobs: Promise<void>[] = [];
    for (let w = 0; w < 6; w++) {
      const row = body.createEl("tr");
      const weekStartDay = cursor.clone();
      if (opts.showWeeklyNote) {
        const weekDate = weekStartDay.clone();
        const weekNote = getNote(this.app, "weekly", weekly, weekDate);
        const td = row.createEl("td", { cls: "week-num" });
        const cell = td.createDiv({ cls: "week-num-cell" + (weekNote ? " has-note" : ""), text: String(weekStartDay.clone().add(3, "days").week()) });
        if (activeFile && weekNote === activeFile) cell.addClass("active");
        cell.setAttr("aria-label", weekNote ? weekNote.basename : `Create ${weekDate.format(weekly.format || "gggg-[W]ww")}`);
        cell.addEventListener("click", (evt) => void this.owner.openPeriod("weekly", weekDate, evt));
        if (weekNote) this.addDots(cell, weekNote, dotJobs);
      }
      for (let d = 0; d < 7; d++) {
        const date = cursor.clone();
        const td = row.createEl("td");
        const day = td.createDiv({ cls: "day", text: date.format("D"), attr: { "data-date": date.format("YYYY-MM-DD") } });
        if (!date.isSame(month, "month")) day.addClass("adjacent-month");
        if (date.isSame(today, "day")) day.addClass("today");
        const note = daily ? getNote(this.app, "daily", daily, date) : null;
        if (note) {
          day.addClass("has-note");
          if (note === activeFile) day.addClass("active");
          this.addDots(day, note, dotJobs);
        }
        day.addEventListener("click", (evt) => void this.owner.openPeriod("daily", date, evt));
        day.addEventListener("mouseover", (evt) => {
          if (!note) return;
          this.app.workspace.trigger("hover-link", { event: evt, source: VIEW_TYPE_CALENDAR, hoverParent: this, targetEl: day, linktext: note.path, sourcePath: "" });
        });
        day.addEventListener("contextmenu", (evt) => {
          if (!note) return;
          evt.preventDefault();
          const menu = new Menu();
          this.app.workspace.trigger("file-menu", menu, note, "calendar-context-menu", null);
          menu.showAtMouseEvent(evt);
        });
        cursor.add(1, "day");
      }
      if (w >= 4 && !cursor.isSame(month, "month")) break;
    }
    if (!daily) {
      const hint = createDiv({ cls: "vault-calendar-hint", text: "Turn on Daily notes in Settings → Core plugins to open notes from the calendar." });
      el.replaceChildren(nav, table, hint);
    } else el.replaceChildren(nav, table);
    await Promise.all(dotJobs);
  }

  private addDots(cell: HTMLElement, file: TFile, jobs: Promise<void>[]) {
    const container = cell.createDiv({ cls: "dot-container" });
    jobs.push(
      this.wordsIn(file).then((words) => {
        const per = Math.max(1, Number(this.owner.options.wordsPerDot) || 250);
        const n = Math.max(1, Math.min(5, Math.floor(words / per)));
        container.setAttr("data-words", String(words));
        for (let i = 0; i < n; i++) {
          const svg = container.createSvg("svg", { cls: "dot filled", attr: { viewBox: "0 0 6 6" } });
          svg.createSvg("circle", { attr: { cx: "3", cy: "3", r: "2" } });
        }
      }),
    );
  }
}

class CalendarSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: CalendarPlugin,
  ) {
    super(app, owner as any);
    this.id = CALENDAR_PLUGIN;
    this.name = "Calendar";
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    const o = this.owner.options;
    const save = () => {
      void this.owner.instance.saveOptions();
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CALENDAR)) void (leaf.view as CalendarView).render?.();
    };
    if (this.owner.steppedAside()) el.createEl("p", { cls: "setting-item-description", text: "The Calendar community plugin is enabled, so its view and settings are used instead." });
    new Setting(el)
      .setName("Words per dot")
      .setDesc("How many words each dot under a day stands for, up to five dots.")
      .addText((t) =>
        t.setValue(String(o.wordsPerDot)).onChange((v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) {
            o.wordsPerDot = n;
            save();
          }
        }),
      );
    new Setting(el).setName("Start week on").addDropdown((d) => {
      d.addOption("locale", `Locale default (${moment.weekdays()[moment.localeData().firstDayOfWeek()]})`);
      for (const day of WEEKDAYS) d.addOption(day, day[0]!.toUpperCase() + day.slice(1));
      d.setValue(o.weekStart).onChange((v) => {
        o.weekStart = v as WeekStart;
        save();
      });
    });
    new Setting(el)
      .setName("Confirm before creating new note")
      .setDesc("Show a confirmation before creating a note from the calendar.")
      .addToggle((t) =>
        t.setValue(o.shouldConfirmBeforeCreate).onChange((v) => {
          o.shouldConfirmBeforeCreate = v;
          save();
        }),
      );
    new Setting(el)
      .setName("Show week number")
      .setDesc("Show a column of week numbers. Click one to open that week's note.")
      .addToggle((t) =>
        t.setValue(o.showWeeklyNote).onChange((v) => {
          o.showWeeklyNote = v;
          save();
          this.display();
        }),
      );
    const periodic = this.app.internalPlugins.getEnabledPluginById("periodic-notes") as any;
    if (o.showWeeklyNote && !periodic?.isPeriodEnabled?.("weekly")) {
      new Setting(el).setName("Weekly notes").setHeading();
      el.createEl("p", { cls: "setting-item-description", text: "Turn on Periodic notes to share these settings with its commands." });
      new Setting(el).setName("Weekly note format").addMomentFormat((m) =>
        m
          .setDefaultFormat("gggg-[W]ww")
          .setValue(o.weeklyNoteFormat)
          .onChange((v) => {
            o.weeklyNoteFormat = v.trim();
            save();
          }),
      );
      new Setting(el).setName("Weekly note folder").addText((t) =>
        t.setValue(o.weeklyNoteFolder).onChange((v) => {
          o.weeklyNoteFolder = v.trim();
          save();
        }),
      );
      new Setting(el).setName("Weekly note template").addText((t) =>
        t.setValue(o.weeklyNoteTemplate).onChange((v) => {
          o.weeklyNoteTemplate = v.trim();
          save();
        }),
      );
    }
  }
}

export const calendar: CorePluginDefinition = {
  id: CALENDAR_PLUGIN,
  name: "Calendar",
  description: "A month calendar of your daily notes in the sidebar.",
  icon: "lucide-calendar-range",
  defaultOn: false,
  defaultOptions: { ...DEFAULTS },
  create: (app) => new CalendarPlugin(app, { id: CALENDAR_PLUGIN, name: "Calendar", version: "", minAppVersion: "", author: "", description: "" }),
};
