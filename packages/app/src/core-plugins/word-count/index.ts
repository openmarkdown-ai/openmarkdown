/**
 * Core plugin Word count (`word-count`).
 *
 *   .status-bar-item.plugin-word-count
 *     span.status-bar-item-segment                        "1,234 words"  |  "12 of 1,234 words" (selection)
 *     span.status-bar-item-segment                        "7,890 characters"
 *     span.status-bar-item-segment.vault-reading-time     "6 min read"
 *     span.status-bar-item-segment.vault-word-goal        ring + "412 / 1,500"   (frontmatter `word-goal`)
 *     span.status-bar-item-segment.vault-daily-goal       "Today +310 / 500"     (option `dailyWordGoal`)
 *
 * Counts the active note without its frontmatter, or the selection when text
 * is selected. Counting is the Rust engine's (`getEngine().wordCount`), which
 * treats CJK characters as words the way Obsidian does; reading time reads
 * CJK characters at 500 a minute and other words at `readingWpm`.
 *
 * Daily progress adds up, per note, how far its word count rose above where
 * it was when first edited today; the totals live in `.obsidian/word-count.json`
 * (`history: { "YYYY-MM-DD": n }`, 90 days). With the Better Word Count
 * community plugin enabled only Obsidian's two segments are shown.
 */
import { getEngine } from "@vault/engine";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { debounce, getFrontMatterInfo, moment } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";

interface NoteView {
  leaf: any;
  file: TFile | null;
  editor?: { getValue(): string; getSelection(): string; somethingSelected?(): boolean };
  data?: string;
  getViewType(): string;
  getMode?(): "source" | "preview";
  getViewData?(): string;
}

export interface WordCountOptions {
  showCharacters: boolean;
  showReadingTime: boolean;
  readingWpm: number;
  dailyWordGoal: number;
  history: Record<string, number>;
}

const DEFAULTS: WordCountOptions = { showCharacters: true, showReadingTime: true, readingWpm: 238, dailyWordGoal: 0, history: {} };
const CJK_CPM = 500;
const CJK_RE = /[\u1100-\u11ff\u2e80-\u2fdf\u3040-\u30ff\u3100-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f]/g;
const HISTORY_DAYS = 90;
const COMMUNITY_ID = "better-word-count";

const fmt = (n: number) => n.toLocaleString();
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;

export function readingMinutes(text: string, words: number, wpm: number): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const other = Math.max(0, words - cjk);
  return other / Math.max(1, wpm) + cjk / CJK_CPM;
}

export function formatReadingTime(minutes: number): string {
  if (minutes <= 0) return "0 min read";
  if (minutes < 1) return "< 1 min read";
  if (minutes < 60) return `${Math.round(minutes)} min read`;
  const h = Math.floor(minutes / 60), m = Math.round(minutes - h * 60);
  return m ? `${h} h ${m} min read` : `${h} h read`;
}

/** `word-goal` from the note's frontmatter (a positive number), read from the text so it follows typing. */
export function wordGoalOf(full: string): number | null {
  const fm = getFrontMatterInfo(full);
  if (!fm.exists) return null;
  const m = /^word-goal:[ \t]*["']?(\d[\d,_]*)["']?[ \t]*$/m.exec(fm.frontmatter);
  if (!m) return null;
  const n = Number(m[1]!.replace(/[,_]/g, ""));
  return n > 0 ? n : null;
}

class WordCountPlugin extends Plugin {
  instance!: any;
  private el!: HTMLElement;
  private wordsEl!: HTMLElement;
  private charsEl!: HTMLElement;
  private readingEl!: HTMLElement;
  private goalEl!: HTMLElement;
  private dailyEl!: HTMLElement;
  private view: NoteView | null = null;
  private requestUpdate = debounce(() => this.update(), 100, false);
  private editedSinceUpdate = false;
  /** path → { day, start: words when first seen today, gained: max rise above start } */
  private baselines = new Map<string, { day: string; start: number; gained: number }>();
  /** Words added today in earlier sessions (loaded from history). */
  private sessionBase = 0;
  private sessionDay = "";
  private requestSave = debounce(() => void this.instance.saveOptions(), 2000, true);

  get options(): WordCountOptions {
    return this.instance.options as WordCountOptions;
  }

  override onload() {
    for (const [k, v] of Object.entries(DEFAULTS)) if (this.options[k as keyof WordCountOptions] === undefined) (this.options as any)[k] = typeof v === "object" ? { ...v } : v;
    this.el = this.addStatusBarItem();
    this.el.addClass("plugin-word-count");
    this.wordsEl = this.el.createSpan({ cls: "status-bar-item-segment" });
    this.charsEl = this.el.createSpan({ cls: "status-bar-item-segment" });
    this.readingEl = this.el.createSpan({ cls: "status-bar-item-segment vault-reading-time" });
    this.goalEl = this.el.createSpan({ cls: "status-bar-item-segment vault-word-goal" });
    this.dailyEl = this.el.createSpan({ cls: "status-bar-item-segment vault-daily-goal" });
    this.el.hide();

    const { workspace, vault } = this.app;
    this.registerEvent(workspace.on("active-leaf-change", () => this.update()));
    this.registerEvent(workspace.on("file-open", () => this.update()));
    this.registerEvent(workspace.on("layout-change", () => this.requestUpdate()));
    this.registerEvent(
      workspace.on("editor-change", () => {
        this.editedSinceUpdate = true;
        this.requestUpdate();
      }),
    );
    this.registerEvent(
      vault.on("modify", (file: TFile) => {
        if (file === this.view?.file) this.requestUpdate();
      }),
    );
    this.registerEvent(
      vault.on("rename", (file: TFile, oldPath: string) => {
        const b = this.baselines.get(oldPath);
        if (b) {
          this.baselines.delete(oldPath);
          this.baselines.set(file.path, b);
        }
      }),
    );
    // Selection changes fire no workspace event; the editor's DOM selection does.
    this.registerDomEvent(document, "selectionchange", () => {
      if (this.view?.editor) this.requestUpdate();
    });
    workspace.onLayoutReady(() => this.update());
    this.addSettingTab(new WordCountSettingTab(this.app, this));
    // internal (tests): words added today
    this.instance.getTodayCount = () => this.todayTotal();
  }

  override onunload() {
    this.requestUpdate.cancel();
    this.requestSave.run?.();
  }

  private currentView(): NoteView | null {
    const { workspace } = this.app;
    const active = workspace.activeLeaf?.view as NoteView | undefined;
    if (active?.getViewType() === "markdown") return active;
    // A sidebar taking focus keeps the last note's count; another main-area view clears it.
    if (active && workspace.activeLeaf.getRoot() === workspace.rootSplit) return null;
    const last = this.view;
    return last && last.leaf?.parent && last.leaf.view === last ? last : null;
  }

  private count(text: string): { words: number; characters: number } {
    try {
      return getEngine().wordCount(text);
    } catch (e) {
      console.error(e);
      return { words: 0, characters: 0 };
    }
  }

  private today(): string {
    return moment().format("YYYY-MM-DD");
  }

  private todayTotal(): number {
    const day = this.today();
    if (this.sessionDay !== day) {
      this.sessionDay = day;
      this.sessionBase = this.options.history?.[day] ?? 0;
      this.baselines.clear();
    }
    let sum = 0;
    for (const b of this.baselines.values()) if (b.day === day) sum += b.gained;
    return this.sessionBase + sum;
  }

  /** Track today's progress for `path` whose body now has `words` words. */
  private track(path: string, words: number, edited: boolean) {
    const day = this.today();
    this.todayTotal(); // rolls the day over when needed
    let b = this.baselines.get(path);
    if (!b || b.day !== day) {
      b = { day, start: words, gained: 0 };
      this.baselines.set(path, b);
    }
    if (!edited) return;
    const gained = Math.max(0, words - b.start);
    if (gained === b.gained) return;
    b.gained = gained;
    const history = { ...(this.options.history ?? {}) };
    history[day] = this.todayTotal();
    const cutoff = moment().subtract(HISTORY_DAYS, "days").format("YYYY-MM-DD");
    for (const d of Object.keys(history)) if (d < cutoff) delete history[d];
    this.options.history = history;
    this.requestSave();
  }

  // internal
  update() {
    const view = this.currentView();
    const edited = this.editedSinceUpdate;
    this.editedSinceUpdate = false;
    this.view = view;
    if (!view || !view.file) {
      this.el.hide();
      return;
    }
    const editing = view.getMode?.() !== "preview" && !!view.editor;
    const full = editing ? view.editor!.getValue() : (view.getViewData?.() ?? view.data ?? "");
    const fm = getFrontMatterInfo(full);
    const body = fm.exists ? full.slice(fm.contentStart) : full;
    const total = this.count(body);
    this.track(view.file.path, total.words, edited && editing);

    const selection = editing ? (view.editor!.getSelection?.() ?? "") : "";
    const extras = !this.app.plugins?.enabledPlugins?.has?.(COMMUNITY_ID);
    if (selection) {
      const sel = this.count(selection);
      this.wordsEl.setText(extras ? `${fmt(sel.words)} of ${plural(total.words, "word", "words")}` : plural(sel.words, "word", "words"));
      this.charsEl.setText(extras ? `${fmt(sel.characters)} of ${plural(total.characters, "character", "characters")}` : plural(sel.characters, "character", "characters"));
    } else {
      this.wordsEl.setText(plural(total.words, "word", "words"));
      this.charsEl.setText(plural(total.characters, "character", "characters"));
    }
    this.charsEl.toggle(!extras || this.options.showCharacters !== false);

    const shownText = selection || body;
    const shownWords = selection ? this.count(selection).words : total.words;
    this.readingEl.toggle(extras && this.options.showReadingTime !== false);
    this.readingEl.setText(formatReadingTime(readingMinutes(shownText, shownWords, Number(this.options.readingWpm) || DEFAULTS.readingWpm)));

    const goal = extras ? wordGoalOf(full) : null;
    this.goalEl.toggle(goal !== null);
    if (goal !== null) this.renderProgress(this.goalEl, total.words, goal, `${fmt(total.words)} / ${fmt(goal)}`, `Note goal: ${fmt(total.words)} of ${fmt(goal)} words`);

    const daily = Number(this.options.dailyWordGoal) || 0;
    this.dailyEl.toggle(extras && daily > 0);
    if (extras && daily > 0) {
      const today = this.todayTotal();
      this.renderProgress(this.dailyEl, today, daily, `Today +${fmt(today)} / ${fmt(daily)}`, `Daily goal: ${fmt(today)} of ${fmt(daily)} words written today`);
    }
    this.el.show();
  }

  private renderProgress(el: HTMLElement, value: number, goal: number, text: string, label: string) {
    const pct = Math.max(0, Math.min(100, Math.round((value / goal) * 100)));
    el.empty();
    const ring = el.createSpan({ cls: "vault-goal-ring" });
    ring.style.setProperty("--goal-progress", `${pct}%`);
    el.createSpan({ cls: "vault-goal-text", text });
    el.toggleClass("is-complete", value >= goal);
    el.setAttr("aria-label", `${label} (${pct}%)`);
    el.setAttr("data-tooltip-position", "top");
  }
}

class WordCountSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: WordCountPlugin,
  ) {
    super(app, owner as never);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = () => {
      void this.owner.instance.saveOptions();
      this.owner.update();
    };
    new Setting(containerEl).setName("Show character count").setDesc("Show the number of characters beside the word count.").addToggle((t) =>
      t.setValue(o.showCharacters !== false).onChange((v) => {
        o.showCharacters = v;
        save();
      }),
    );
    new Setting(containerEl).setName("Show reading time").setDesc("Estimate how long the note (or the selection) takes to read.").addToggle((t) =>
      t.setValue(o.showReadingTime !== false).onChange((v) => {
        o.showReadingTime = v;
        save();
      }),
    );
    new Setting(containerEl).setName("Reading speed").setDesc("Words per minute used for the reading time. CJK text is read at 500 characters a minute.").addText((t) =>
      t
        .setPlaceholder("238")
        .setValue(String(o.readingWpm ?? 238))
        .onChange((v) => {
          const n = Number(v);
          if (n > 0) {
            o.readingWpm = n;
            save();
          }
        }),
    );
    new Setting(containerEl)
      .setName("Daily word goal")
      .setDesc("Words to write each day, shown in the status bar. 0 turns it off. A single note's goal comes from its word-goal property.")
      .addText((t) =>
        t
          .setPlaceholder("0")
          .setValue(String(o.dailyWordGoal ?? 0))
          .onChange((v) => {
            const n = Math.max(0, Math.floor(Number(v) || 0));
            o.dailyWordGoal = n;
            save();
          }),
      );
  }
}

export const wordCount: CorePluginDefinition = {
  id: "word-count",
  name: "Word count",
  description: "Show word count, reading time and writing goals in the status bar.",
  icon: "lucide-type",
  defaultOn: true,
  defaultOptions: { ...DEFAULTS, history: {} },
  create: (app) => new WordCountPlugin(app, { id: "word-count", name: "Word count", version: "", minAppVersion: "", author: "", description: "" }),
};
