/**
 * Periodic notes without the plugin: one note per week, month, quarter or
 * year, named by a Moment format, in a folder, from a template. Shared by the
 * Periodic notes and Calendar core plugins.
 */
import type { Moment } from "moment";
import { Notice } from "../../obsidian/ui/notice";
import { moment, normalizePath } from "../../obsidian/util";
import { TFile, TFolder } from "../../obsidian/vault/files";
import { resolveTemplateFile } from "../templates/input-suggest";
import { mergeIntoText, processTemplateVariables, splitFrontmatter } from "../templates/template-vars";

export type Periodicity = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export interface PeriodConfig {
  enabled: boolean;
  format: string;
  folder: string;
  template: string;
}

export const PERIODS: Exclude<Periodicity, "daily">[] = ["weekly", "monthly", "quarterly", "yearly"];

export const PERIOD_INFO: Record<Periodicity, { unit: moment.unitOfTime.StartOf; noun: string; adjective: string; thisLabel: string; defaultFormat: string }> = {
  daily: { unit: "day", noun: "day", adjective: "daily", thisLabel: "today's", defaultFormat: "YYYY-MM-DD" },
  weekly: { unit: "week", noun: "week", adjective: "weekly", thisLabel: "this week's", defaultFormat: "gggg-[W]ww" },
  monthly: { unit: "month", noun: "month", adjective: "monthly", thisLabel: "this month's", defaultFormat: "YYYY-MM" },
  quarterly: { unit: "quarter", noun: "quarter", adjective: "quarterly", thisLabel: "this quarter's", defaultFormat: "YYYY-[Q]Q" },
  yearly: { unit: "year", noun: "year", adjective: "yearly", thisLabel: "this year's", defaultFormat: "YYYY" },
};

export function formatOf(p: Periodicity, config: Partial<PeriodConfig> | undefined): string {
  return (config?.format ?? "").trim() || PERIOD_INFO[p].defaultFormat;
}

export function folderOf(config: Partial<PeriodConfig> | undefined): string {
  return normalizePath((config?.folder ?? "").trim() || "/").replace(/^\/+|\/+$/g, "");
}

export function pathForDate(p: Periodicity, config: Partial<PeriodConfig> | undefined, date: Moment): string {
  const name = date.format(formatOf(p, config));
  const folder = folderOf(config);
  return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
}

export function getNote(app: any, p: Periodicity, config: Partial<PeriodConfig> | undefined, date: Moment): TFile | null {
  return app.vault.getFileByPath(pathForDate(p, config, date));
}

/** The period a file names (strict parse of its path within the folder), or null. */
export function dateFromFile(p: Periodicity, config: Partial<PeriodConfig> | undefined, file: TFile): Moment | null {
  if (file.extension !== "md") return null;
  const folder = folderOf(config);
  const prefix = folder ? folder + "/" : "";
  if (prefix && !file.path.startsWith(prefix)) return null;
  const format = formatOf(p, config);
  const rel = file.path.slice(prefix.length).replace(/\.md$/, "");
  const date = moment(format.includes("/") ? rel : file.basename, format, true);
  return date.isValid() ? date.startOf(PERIOD_INFO[p].unit) : null;
}

export function allNotes(app: any, p: Periodicity, config: Partial<PeriodConfig> | undefined): { file: TFile; date: Moment }[] {
  const folder = folderOf(config);
  const root: TFolder | null = folder ? app.vault.getFolderByPath(folder) : app.vault.getRoot();
  if (!root) return [];
  const out: { file: TFile; date: Moment }[] = [];
  const walk = (f: TFolder) => {
    for (const c of f.children) {
      if (c instanceof TFolder) walk(c);
      else if (c instanceof TFile) {
        const date = dateFromFile(p, config, c);
        if (date) out.push({ file: c, date });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.date.valueOf() - b.date.valueOf());
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Periodic Notes' extra template tokens: `{{monday:YYYY-MM-DD}}` … for the period's week. */
function weekdayTokens(text: string, date: Moment): string {
  return text.replace(/{{\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*:([^}]*?)\s*}}/gi, (_m, day: string, format: string) =>
    date.clone().day(WEEKDAYS.indexOf(day.toLowerCase())).format(format.trim() || "YYYY-MM-DD"),
  );
}

export async function createNote(app: any, p: Periodicity, config: Partial<PeriodConfig> | undefined, date: Moment): Promise<TFile> {
  const path = pathForDate(p, config, date);
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
  let content = "";
  const templatePath = (config?.template ?? "").trim();
  if (templatePath) {
    const templateFile = resolveTemplateFile(app, templatePath);
    if (!templateFile) new Notice(`Failed to find the template file “${templatePath}”.`);
    else {
      const raw: string = await app.vault.read(templateFile);
      const templates = app.internalPlugins?.getEnabledPluginById?.("templates")?.options ?? {};
      const format = formatOf(p, config);
      const processed = processTemplateVariables(weekdayTokens(raw, date), {
        title: date.format(format).split("/").pop() ?? "",
        date,
        dateFormat: format,
        timeFormat: templates.timeFormat || "HH:mm",
      });
      const { properties, body } = splitFrontmatter(processed);
      content = mergeIntoText(body, properties);
    }
  }
  return app.vault.create(path, content);
}

export async function openNote(app: any, p: Periodicity, config: Partial<PeriodConfig> | undefined, date: Moment, newLeaf?: boolean | "tab" | "split" | "window"): Promise<TFile | null> {
  let file = getNote(app, p, config, date);
  try {
    file ??= await createNote(app, p, config, date);
  } catch (e) {
    new Notice(`Unable to create the ${PERIOD_INFO[p].adjective} note: ${String((e as Error)?.message ?? e)}`);
    return null;
  }
  await app.workspace.getLeaf(newLeaf ?? false).openFile(file, { active: true });
  return file;
}
