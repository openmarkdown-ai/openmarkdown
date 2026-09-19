/**
 * Periodic review (`ai-review`, off by default, AI feature "review"): "Review
 * this week" / "Review this month" gathers that period's daily notes and the
 * tasks completed or created in it, summarises them into highlights,
 * decisions and themes — every point linked to the daily notes it came from —
 * lists open and completed tasks with links to where they live, shows the
 * result editable with a preview, and inserts it into the weekly or monthly
 * note (created through the periodic notes settings if it doesn't exist).
 *
 * Task lists are read from the notes, not generated, so they are exact. The
 * summary's points must cite a daily note from the period; points that don't
 * are dropped.
 */
import type { Moment } from "moment";
import type { EngineInfo } from "../../ai/types";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { ButtonComponent, DropdownComponent } from "../../obsidian/ui/setting";
import { debounce, getFrontMatterInfo, moment } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";
import {
  aiAvailable,
  aiOf,
  communityPluginEnabled,
  editNote,
  errorMessage,
  generate,
  isAbort,
  LivePreview,
  parseJsonAnswer,
  renderEngineBadge,
  truncate,
} from "../ai-suggest/shared";
import { allNotes, createNote, getNote, pathForDate, type PeriodConfig } from "../periodic-notes/periods";

export type ReviewPeriod = "weekly" | "monthly";
export type ReviewWhen = "this-week" | "last-week" | "this-month" | "last-month";

const WHEN: Record<ReviewWhen, { period: ReviewPeriod; offset: number; label: string }> = {
  "this-week": { period: "weekly", offset: 0, label: "This week" },
  "last-week": { period: "weekly", offset: -1, label: "Last week" },
  "this-month": { period: "monthly", offset: 0, label: "This month" },
  "last-month": { period: "monthly", offset: -1, label: "Last month" },
};

const MAX_NOTE_CHARS = 3000;
const MAX_TOTAL_CHARS = 24_000;
const MAX_TASK_FILES = 800;

export interface ReviewTask {
  text: string;
  done: boolean;
  file: TFile;
}

export interface ReviewData {
  period: ReviewPeriod;
  start: Moment;
  end: Moment;
  days: { file: TFile; date: Moment }[];
  open: ReviewTask[];
  completed: ReviewTask[];
}

interface Point {
  text: string;
  sources: TFile[];
}

function dailyConfig(app: any): PeriodConfig {
  const o = app.internalPlugins?.getPluginById?.("daily-notes")?.instance?.options ?? {};
  return { enabled: true, format: o.format ?? "", folder: o.folder ?? "", template: o.template ?? "" };
}

export function periodConfig(app: any, p: ReviewPeriod): PeriodConfig {
  const community = communityPluginEnabled(app, "periodic-notes") ? app.plugins?.plugins?.["periodic-notes"]?.settings?.[p] : null;
  const own = app.internalPlugins?.getPluginById?.("periodic-notes")?.instance?.options?.[p];
  const c = community ?? own ?? {};
  return { enabled: c.enabled ?? true, format: c.format ?? "", folder: c.folder ?? "", template: c.template ?? "" };
}

export function periodRange(when: ReviewWhen, now: Moment = moment()): { period: ReviewPeriod; start: Moment; end: Moment } {
  const w = WHEN[when];
  const unit = w.period === "weekly" ? "week" : "month";
  const start = now.clone().add(w.offset, unit).startOf(unit);
  return { period: w.period, start, end: start.clone().endOf(unit) };
}

const DONE_DATE = /✅\s*(\d{4}-\d{2}-\d{2})/u;
const CREATED_DATE = /➕\s*(\d{4}-\d{2}-\d{2})/u;

/** The period's daily notes and the tasks that belong to it. */
export async function gatherReview(app: any, when: ReviewWhen, now?: Moment): Promise<ReviewData> {
  const { period, start, end } = periodRange(when, now);
  const days = allNotes(app, "daily", dailyConfig(app)).filter((d) => !d.date.isBefore(start, "day") && !d.date.isAfter(end, "day"));
  const dayFiles = new Set(days.map((d) => d.file));
  const open: ReviewTask[] = [];
  const completed: ReviewTask[] = [];
  const inRange = (s: string | undefined) => {
    if (!s) return false;
    const d = moment(s, "YYYY-MM-DD", true);
    return d.isValid() && !d.isBefore(start, "day") && !d.isAfter(end, "day");
  };
  let scanned = 0;
  const files = [...days.map((d) => d.file), ...(app.vault.getMarkdownFiles() as TFile[]).filter((f) => !dayFiles.has(f))];
  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const items = (cache?.listItems ?? []).filter((li: any) => typeof li.task === "string");
    if (!items.length) continue;
    if (!dayFiles.has(file) && ++scanned > MAX_TASK_FILES) break;
    const lines = (await app.vault.cachedRead(file)).split("\n");
    for (const li of items) {
      const line: string = lines[li.position.start.line] ?? "";
      const text = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+\[.\]\s*/, "").trim();
      if (!text) continue;
      const status = String(li.task);
      const done = status === "x" || status === "X";
      if (status === "-") continue;
      if (dayFiles.has(file)) {
        (done ? completed : open).push({ text, done, file });
      } else if (done ? inRange(DONE_DATE.exec(line)?.[1]) : inRange(CREATED_DATE.exec(line)?.[1])) {
        (done ? completed : open).push({ text, done, file });
      }
    }
  }
  return { period, start, end, days, open, completed };
}

export function periodTitle(period: ReviewPeriod, start: Moment): string {
  return period === "weekly" ? `Week of ${start.format("D MMMM YYYY")}` : start.format("MMMM YYYY");
}

export function reviewHeading(period: ReviewPeriod): string {
  return period === "weekly" ? "## Weekly review" : "## Monthly review";
}

function stripTaskMarkers(text: string): string {
  return text.replace(/\s*[📅⏳🛫✅➕🔁⏫🔼🔽🔺⏬]️?\s*(\d{4}-\d{2}-\d{2})?/gu, "").trim();
}

/** Resolves the model's source names ("2026-09-14", "[[2026-09-14]]") to the period's daily notes. */
function resolveSources(raw: unknown, days: { file: TFile }[]): TFile[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out: TFile[] = [];
  for (const s of list) {
    if (typeof s !== "string") continue;
    const name = s.replace(/^\[\[|\]\]$/g, "").split("|")[0]!.replace(/\.md$/, "").trim().toLowerCase();
    const hit = days.find((d) => d.file.basename.toLowerCase() === name || d.file.path.toLowerCase().replace(/\.md$/, "") === name);
    if (hit && !out.includes(hit.file)) out.push(hit.file);
  }
  return out;
}

function points(raw: unknown, days: { file: TFile }[]): Point[] {
  if (!Array.isArray(raw)) return [];
  const out: Point[] = [];
  for (const item of raw) {
    const text = typeof item === "string" ? item : typeof item?.text === "string" ? item.text : "";
    const clean = text.replace(/\s*\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim();
    const sources = resolveSources(item?.sources ?? item?.source, days);
    if (clean && sources.length) out.push({ text: clean, sources });
  }
  return out.slice(0, 12);
}

/** The review as Markdown, links written for `targetPath`. */
export function buildReview(app: any, data: ReviewData, summary: any, targetPath: string): string {
  const link = (f: TFile) => app.fileManager.generateMarkdownLink(f, targetPath);
  const cite = (files: TFile[]) => files.map(link).join(", ");
  const out: string[] = [reviewHeading(data.period), ""];
  out.push(`${periodTitle(data.period, data.start)} · ${data.days.length} daily ${data.days.length === 1 ? "note" : "notes"}, ${data.completed.length} ${data.completed.length === 1 ? "task" : "tasks"} completed, ${data.open.length} open.`, "");
  const section = (title: string, lines: string[]) => {
    if (!lines.length) return;
    out.push(`### ${title}`, ...lines, "");
  };
  const fromSummary = (key: string) => points(summary?.[key], data.days).map((p) => `- ${p.text} (${cite(p.sources)})`);
  section("Highlights", fromSummary("highlights"));
  section("Decisions", fromSummary("decisions"));
  section(
    "Open tasks",
    data.open.slice(0, 40).map((t) => `- ${stripTaskMarkers(t.text)} (${link(t.file)})`),
  );
  section(
    "Completed",
    data.completed.slice(0, 40).map((t) => `- ${stripTaskMarkers(t.text)} (${link(t.file)})`),
  );
  section("Themes", fromSummary("themes"));
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

/** `text` with the review section replaced (same heading) or appended. */
export function mergeReview(text: string, review: string, period: ReviewPeriod): string {
  const heading = reviewHeading(period);
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  const block = review.replace(/\n+$/, "").split("\n");
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++;
    const tail = lines.slice(end);
    return [...lines.slice(0, start), ...block, ...(tail.length ? ["", ...tail] : [""])].join("\n").replace(/\n{3,}(?=#)/g, "\n\n");
  }
  const body = text.replace(/\s+$/, "");
  const empty = !body || getFrontMatterInfo(text).contentStart >= body.length;
  return `${body}${empty ? (body ? "\n" : "") : "\n\n"}${block.join("\n")}\n`;
}

async function summarise(app: any, data: ReviewData, signal: AbortSignal): Promise<{ summary: any; engine: EngineInfo } | null> {
  let budget = MAX_TOTAL_CHARS;
  const notes: string[] = [];
  for (const d of data.days) {
    if (budget <= 0) break;
    const raw: string = await app.vault.cachedRead(d.file);
    const body = truncate(raw.slice(getFrontMatterInfo(raw).contentStart).trim(), Math.min(MAX_NOTE_CHARS, budget));
    budget -= body.length;
    notes.push(`=== ${d.file.basename} (${d.date.format("dddd")}) ===\n${body || "(empty)"}`);
  }
  const system = [
    "Task: periodic-review",
    `Summarise the user's daily notes for ${periodTitle(data.period, data.start)}.`,
    'Answer with a JSON object only: {"highlights": [{"text": string, "sources": [note name]}], "decisions": [...same shape], "themes": [...same shape]}.',
    "highlights: what happened or got done that matters (up to 6). decisions: choices the user made or settled (up to 5; [] if none). themes: recurring topics across several days (up to 4).",
    "Every item must list in sources the exact names (the text between === markers, e.g. 2026-09-14) of the notes it comes from. One short sentence per item, in the notes' language. Don't invent anything; don't list tasks (they are added separately).",
  ].join("\n");
  const tasks = [
    `Completed tasks: ${data.completed.length ? data.completed.slice(0, 30).map((t) => `${stripTaskMarkers(t.text)} [${t.file.basename}]`).join("; ") : "none"}`,
    `Open tasks: ${data.open.length ? data.open.slice(0, 30).map((t) => `${stripTaskMarkers(t.text)} [${t.file.basename}]`).join("; ") : "none"}`,
  ].join("\n");
  const res = await generate(app, { feature: "review", system, messages: [{ role: "user", content: `${notes.join("\n\n")}\n\n${tasks}` }], json: true, temperature: 0.2, maxTokens: 900, signal });
  if (!res) return null;
  return { summary: parseJsonAnswer(res.text) ?? {}, engine: res.engine };
}

class ReviewModal extends Modal {
  private when: ReviewWhen;
  private data: ReviewData | null = null;
  private engineEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private sourceEl!: HTMLTextAreaElement;
  private preview!: LivePreview;
  private runBtn!: ButtonComponent;
  private insertBtn!: ButtonComponent;
  private controller: AbortController | null = null;
  private schedulePreview = debounce(() => void this.renderPreview(), 350, true);

  constructor(
    app: any,
    when: ReviewWhen,
    private now?: Moment,
  ) {
    super(app);
    this.when = when;
    this.modalEl.addClass("ai-review-modal", "ai-assist-modal");
    this.setTitle("Review");
    const el = this.contentEl;
    const row = el.createDiv({ cls: "ai-assist-row" });
    const dd = new DropdownComponent(row);
    dd.selectEl.addClass("ai-review-when");
    dd.selectEl.setAttr("aria-label", "Period");
    for (const [k, v] of Object.entries(WHEN)) dd.addOption(k, v.label);
    dd.setValue(when).onChange((v) => {
      this.when = v as ReviewWhen;
      void this.run();
    });
    this.runBtn = new ButtonComponent(row).setButtonText("Summarise again").onClick(() => void this.run());
    this.engineEl = row.createDiv();
    renderEngineBadge(this.engineEl, aiOf(app)?.engineFor("review") ?? null);
    this.statusEl = el.createDiv({ cls: "ai-assist-status", attr: { "aria-live": "polite" } });
    el.createEl("label", { cls: "ai-assist-label", text: "Review (you can edit it)", attr: { for: "ai-review-source" } });
    this.sourceEl = el.createEl("textarea", { cls: "ai-review-source", attr: { id: "ai-review-source", rows: "10" } });
    this.sourceEl.addEventListener("input", () => this.schedulePreview());
    el.createDiv({ cls: "ai-assist-label", text: "Preview" });
    this.preview = new LivePreview(app, el.createDiv({ cls: "ai-assist-preview ai-review-preview" }));
    this.preview.message("The review appears here.");
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    this.insertBtn = new ButtonComponent(buttons).setButtonText("Insert").setCta().setDisabled(true).onClick(() => void this.insert());
    this.insertBtn.buttonEl.addClass("ai-review-insert");
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
  }

  override onOpen() {
    void this.run();
  }

  override onClose() {
    this.controller?.abort();
    this.schedulePreview.cancel();
    this.preview.dispose();
  }

  private targetPath(data: ReviewData): string {
    return pathForDate(data.period, periodConfig(this.app, data.period), data.start);
  }

  async run() {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const w = WHEN[this.when];
    this.setTitle(`Review ${w.label.toLowerCase()}`);
    this.insertBtn.setButtonText(`Insert into ${w.period} note`).setDisabled(true);
    this.runBtn.setDisabled(true);
    this.sourceEl.value = "";
    this.preview.message("The review appears here.");
    this.modalEl.addClass("is-loading");
    this.statusEl.setText("Reading daily notes…");
    try {
      const data = await gatherReview(this.app, this.when, this.now);
      if (controller.signal.aborted) return;
      this.data = data;
      if (!data.days.length) {
        this.statusEl.setText(`There are no daily notes for ${periodTitle(data.period, data.start)}.`);
        return;
      }
      this.statusEl.setText(`Summarising ${data.days.length} daily ${data.days.length === 1 ? "note" : "notes"}…`);
      const res = await summarise(this.app, data, controller.signal);
      if (controller.signal.aborted) return;
      if (!res) {
        this.statusEl.setText("Cancelled.");
        return;
      }
      renderEngineBadge(this.engineEl, res.engine);
      this.sourceEl.value = buildReview(this.app, data, res.summary, this.targetPath(data));
      this.statusEl.setText("Nothing is added until you choose Insert.");
      this.insertBtn.setDisabled(false);
      await this.renderPreview();
    } catch (e) {
      if (!isAbort(e) && !controller.signal.aborted) this.statusEl.setText(errorMessage(e));
    } finally {
      if (this.controller === controller) this.controller = null;
      this.runBtn.setDisabled(false);
      this.modalEl.removeClass("is-loading");
    }
  }

  async renderPreview() {
    const text = this.sourceEl.value;
    this.insertBtn.setDisabled(!text.trim() || !this.data);
    if (!text.trim() || !this.data) {
      this.preview.message("The review appears here.");
      return;
    }
    await this.preview.render(text, this.targetPath(this.data));
  }

  async insert() {
    const data = this.data;
    const review = this.sourceEl.value;
    if (!data || !review.trim()) return;
    const config = periodConfig(this.app, data.period);
    try {
      const file: TFile = getNote(this.app, data.period, config, data.start) ?? (await createNote(this.app, data.period, config, data.start));
      // Written before opening: an open editor takes the change as one undo step, otherwise the file is.
      await editNote(this.app, file, (text) => mergeReview(text, review, data.period));
      await this.app.workspace.getLeaf(false).openFile(file, { active: true });
      this.close();
    } catch (e) {
      new Notice(`Couldn't add the review: ${errorMessage(e)}`);
    }
  }
}

export class AiReviewPlugin extends Plugin {
  instance!: any;

  override async onload() {
    const add = (id: string, name: string, when: ReviewWhen) =>
      this.addCommand({
        id: `ai-review:${id}`,
        name,
        icon: "lucide-calendar-check",
        checkCallback: (checking) => {
          if (!aiAvailable(this.app, "review")) return false;
          if (!checking) this.open(when);
          return true;
        },
      });
    add("review-week", "Review this week", "this-week");
    add("review-last-week", "Review last week", "last-week");
    add("review-month", "Review this month", "this-month");
    add("review-last-month", "Review last month", "last-month");
  }

  open(when: ReviewWhen, now?: Moment) {
    const modal = new ReviewModal(this.app, when, now);
    modal.open();
    return modal;
  }
}
