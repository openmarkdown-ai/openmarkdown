/**
 * Periodic notes (`periodic-notes`, off by default): weekly, monthly,
 * quarterly and yearly notes, each with its own format, folder and template.
 * Daily notes stay with the Daily notes core plugin.
 *
 * Compatible with the Periodic Notes community plugin:
 * - `.obsidian/periodic-notes.json` has its `data.json` shape
 *   (`{ weekly: { enabled, format, folder, template }, monthly: …, … }`), and
 *   is seeded from `.obsidian/plugins/periodic-notes/data.json` the first time.
 * - Command ids are its ids (`periodic-notes:open-weekly-note`,
 *   `periodic-notes:next-weekly-note`, `periodic-notes:prev-weekly-note`,
 *   `periodic-notes:open-next-weekly-note`, `periodic-notes:open-prev-weekly-note`,
 *   and the same for monthly, quarterly, yearly), so hotkeys carry over.
 * - With the plugin enabled, this one registers nothing that would clash.
 *
 * Instance API (Calendar and plugins): `getPeriodicNote(p, date)`,
 * `getAllPeriodicNotes(p)`, `openPeriodicNote(p, date, newLeaf)`,
 * `isPeriodEnabled(p)`, `getConfig(p)`.
 */
import type { Command } from "obsidian";
import type { Moment } from "moment";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { moment } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";
import { FileSuggest, FolderSuggest } from "../templates/input-suggest";
import { PERIOD_INFO, PERIODS, allNotes, dateFromFile, formatOf, getNote, openNote, type PeriodConfig, type Periodicity } from "./periods";
import { addYieldingCommands, isCommunityPluginEnabled } from "./yield";

export const PERIODIC_NOTES_PLUGIN = "periodic-notes";

const DEFAULT_OPTIONS = {
  showGettingStartedBanner: false,
  hasMigratedDailyNoteSettings: true,
  hasMigratedWeeklyNoteSettings: true,
  daily: { enabled: false, format: "", folder: "", template: "" },
  weekly: { enabled: true, format: "", folder: "", template: "" },
  monthly: { enabled: true, format: "", folder: "", template: "" },
  quarterly: { enabled: false, format: "", folder: "", template: "" },
  yearly: { enabled: false, format: "", folder: "", template: "" },
};

export class PeriodicNotesPlugin extends Plugin {
  instance!: any;

  getConfig(p: Periodicity): PeriodConfig {
    if (p === "daily") {
      const daily = this.app.internalPlugins.getPluginById("daily-notes")?.instance?.options ?? {};
      return { enabled: !!this.app.internalPlugins.getEnabledPluginById("daily-notes"), format: daily.format ?? "", folder: daily.folder ?? "", template: daily.template ?? "" };
    }
    const o = this.instance.options;
    o[p] = { ...DEFAULT_OPTIONS[p], ...(o[p] && typeof o[p] === "object" ? o[p] : {}) };
    return o[p] as PeriodConfig;
  }

  isPeriodEnabled(p: Periodicity): boolean {
    return !isCommunityPluginEnabled(this.app, PERIODIC_NOTES_PLUGIN) && this.getConfig(p).enabled;
  }

  override async onload() {
    await this.importCommunitySettings();
    const inst = this.instance;
    inst.getConfig = (p: Periodicity) => this.getConfig(p);
    inst.isPeriodEnabled = (p: Periodicity) => this.isPeriodEnabled(p);
    inst.getPeriodicNote = (p: Periodicity, date: Moment) => getNote(this.app, p, this.getConfig(p), date);
    inst.getAllPeriodicNotes = (p: Periodicity) => allNotes(this.app, p, this.getConfig(p));
    inst.getDateFromFile = (p: Periodicity, file: TFile) => dateFromFile(p, this.getConfig(p), file);
    inst.openPeriodicNote = (p: Periodicity, date: Moment, newLeaf?: boolean | "tab" | "split") => openNote(this.app, p, this.getConfig(p), date, newLeaf);

    const commands: Command[] = [];
    for (const p of PERIODS) {
      const info = PERIOD_INFO[p];
      const when = (fn: () => void) => (checking: boolean) => {
        if (!this.isPeriodEnabled(p)) return false;
        if (!checking) fn();
        return true;
      };
      commands.push(
        { id: `${PERIODIC_NOTES_PLUGIN}:open-${p}-note`, name: `Periodic notes: Open ${info.thisLabel} note`, icon: "lucide-calendar-days", checkCallback: when(() => void this.openCurrent(p)) },
        { id: `${PERIODIC_NOTES_PLUGIN}:next-${p}-note`, name: `Periodic notes: Jump forwards to closest ${info.adjective} note`, icon: "lucide-arrow-right", checkCallback: when(() => void this.jump(p, 1, false)) },
        { id: `${PERIODIC_NOTES_PLUGIN}:prev-${p}-note`, name: `Periodic notes: Jump backwards to closest ${info.adjective} note`, icon: "lucide-arrow-left", checkCallback: when(() => void this.jump(p, -1, false)) },
        { id: `${PERIODIC_NOTES_PLUGIN}:open-next-${p}-note`, name: `Periodic notes: Open next ${info.adjective} note`, icon: "lucide-arrow-right", checkCallback: when(() => void this.jump(p, 1, true)) },
        { id: `${PERIODIC_NOTES_PLUGIN}:open-prev-${p}-note`, name: `Periodic notes: Open previous ${info.adjective} note`, icon: "lucide-arrow-left", checkCallback: when(() => void this.jump(p, -1, true)) },
      );
    }
    addYieldingCommands(this, PERIODIC_NOTES_PLUGIN, commands);
    this.addSettingTab(new PeriodicNotesSettingTab(this.app, this));
  }

  /** First run: take over the community plugin's settings when they exist. */
  private async importCommunitySettings() {
    const vault = this.app.vault;
    const own = `${vault.configDir}/${PERIODIC_NOTES_PLUGIN}.json`;
    const theirs = `${vault.configDir}/plugins/${PERIODIC_NOTES_PLUGIN}/data.json`;
    try {
      if (await vault.adapter.exists(own)) return;
      if (!(await vault.adapter.exists(theirs))) return;
      const data = JSON.parse(await vault.adapter.read(theirs));
      if (!data || typeof data !== "object") return;
      for (const p of [...PERIODS, "daily"] as const) if (data[p] && typeof data[p] === "object") this.instance.options[p] = { ...DEFAULT_OPTIONS[p], ...data[p] };
      await this.instance.saveOptions();
    } catch (e) {
      console.error("Periodic notes: could not read the Periodic Notes plugin's settings", e);
    }
  }

  private current(p: Periodicity): Moment {
    return moment().startOf(PERIOD_INFO[p].unit);
  }

  async openCurrent(p: Periodicity, newLeaf?: boolean | "tab") {
    await openNote(this.app, p, this.getConfig(p), this.current(p), newLeaf);
  }

  /** `create`: open the adjacent period (creating it); otherwise the closest existing note. */
  async jump(p: Periodicity, dir: 1 | -1, create: boolean) {
    const config = this.getConfig(p);
    const active = this.app.workspace.getActiveFile() as TFile | null;
    const base = (active && dateFromFile(p, config, active)) || this.current(p);
    const unit = PERIOD_INFO[p].unit;
    if (create) {
      await openNote(this.app, p, config, base.clone().add(dir, unit as moment.unitOfTime.DurationConstructor), false);
      return;
    }
    const all = allNotes(this.app, p, config);
    const pick = dir < 0 ? [...all].reverse().find((n) => n.date.isBefore(base, unit)) : all.find((n) => n.date.isAfter(base, unit));
    if (!pick) {
      new Notice(`There's no ${PERIOD_INFO[p].adjective} note ${dir < 0 ? "before" : "after"} this one.`);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(pick.file, { active: true });
  }
}

class PeriodicNotesSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: PeriodicNotesPlugin,
  ) {
    super(app, owner as any);
    this.id = PERIODIC_NOTES_PLUGIN;
    this.name = "Periodic notes";
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    if (isCommunityPluginEnabled(this.app, PERIODIC_NOTES_PLUGIN)) {
      el.createEl("p", { cls: "setting-item-description", text: "The Periodic Notes community plugin is enabled, so its settings apply and these are not used." });
    }
    el.createEl("p", { cls: "setting-item-description", text: "Daily notes are set up in Settings → Daily notes. The Calendar core plugin opens the notes set up here." });
    const save = () => void this.owner.instance.saveOptions();
    for (const p of PERIODS) {
      const info = PERIOD_INFO[p];
      const config = this.owner.getConfig(p);
      const title = info.adjective[0]!.toUpperCase() + info.adjective.slice(1);
      new Setting(el).setName(`${title} notes`).setHeading();
      const rows: Setting[] = [];
      new Setting(el)
        .setName(`Enable ${info.adjective} notes`)
        .addToggle((t) =>
          t.setValue(config.enabled).onChange((v) => {
            config.enabled = v;
            save();
            for (const r of rows) r.settingEl.toggle(v);
          }),
        );
      const sample = createEl("b", { cls: "u-pop" });
      rows.push(
        new Setting(el)
          .setName("Format")
          .setDesc(
            createFragment((f) => {
              f.appendText("Your current syntax looks like this: ");
              f.appendChild(sample);
            }),
          )
          .addMomentFormat((m) =>
            m
              .setDefaultFormat(formatOf(p, undefined))
              .setSampleEl(sample)
              .setValue(config.format)
              .onChange((v) => {
                config.format = v.trim();
                save();
              }),
          ),
      );
      rows.push(
        new Setting(el)
          .setName("Note folder")
          .setDesc(`New ${info.adjective} notes are placed here.`)
          .addSearch((s) => {
            s.setPlaceholder("Example: folder 1/folder 2").setValue(config.folder);
            new FolderSuggest(this.app, s.inputEl);
            s.onChange((v) => {
              config.folder = v.trim().replace(/^\/+|\/+$/g, "");
              save();
            });
          }),
      );
      rows.push(
        new Setting(el)
          .setName("Template")
          .setDesc(p === "weekly" ? "Choose the file to use as a template. {{monday:YYYY-MM-DD}} and the other weekdays insert that day of the week." : "Choose the file to use as a template.")
          .addSearch((s) => {
            s.setPlaceholder("Example: folder/note").setValue(config.template);
            new FileSuggest(this.app, s.inputEl);
            s.onChange((v) => {
              config.template = v.trim().replace(/^\/+/, "");
              save();
            });
          }),
      );
      for (const r of rows) r.settingEl.toggle(config.enabled);
    }
  }
}

export const periodicNotes: CorePluginDefinition = {
  id: PERIODIC_NOTES_PLUGIN,
  name: "Periodic notes",
  description: "Weekly, monthly, quarterly and yearly notes.",
  icon: "lucide-calendar-days",
  defaultOn: false,
  defaultOptions: JSON.parse(JSON.stringify(DEFAULT_OPTIONS)),
  create: (app) => new PeriodicNotesPlugin(app, { id: PERIODIC_NOTES_PLUGIN, name: "Periodic notes", version: "", minAppVersion: "", author: "", description: "" }),
};
