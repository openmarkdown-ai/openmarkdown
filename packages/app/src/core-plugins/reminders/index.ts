/**
 * Core plugin Reminders (`reminders`): notifications for tasks written in the
 * Reminder plugin's syntax, `- [ ] Call Sam (@2026-09-15 09:00)`.
 *
 * - Scans the vault's notes and keeps the list current as notes change.
 * - While the app is open, a due reminder shows an in-app card with "Mark as
 *   done" and "Remind me later" (which rewrite the task line exactly as the
 *   Reminder plugin would), plus a system notification when allowed, and the
 *   Badging API count of overdue reminders.
 * - A web page cannot wake itself up when closed, so "Export reminders as
 *   .ics" and a per-task "Add to calendar (.ics)" hand reminders to the OS
 *   calendar, whose alarms fire regardless.
 *
 * Steps aside while the Reminder community plugin is enabled.
 */
import { MarkdownView } from "../../obsidian/markdown/markdown-view";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import type { TFile } from "../../obsidian/vault/files";
import { ItemView } from "../../obsidian/workspace/view";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { downloadBlob } from "../publish/zip";
import { buildIcs, hm, markDoneLine, type ParsedReminder, parseReminderLine, parseReminders, snoozeLine, ymd } from "./parse";

export interface RemindersOptions {
  defaultTime: string;
  readTasksDates: boolean;
  readKanbanDates: boolean;
  systemNotifications: boolean;
  showBadge: boolean;
}

export const REMINDER_PLUGIN_ID = "obsidian-reminder-plugin";
export const VIEW_TYPE_REMINDERS = "reminders-list";
const FIRED_KEY = "reminders-fired";
const TICK_MS = 10_000;

export interface Reminder extends ParsedReminder {
  path: string;
}

function reminderKey(r: Reminder): string {
  return `${r.path}\u0000${r.title}\u0000${r.time}`;
}

export class RemindersPlugin extends Plugin {
  instance!: any;
  private byPath = new Map<string, Reminder[]>();
  private fired = new Set<string>();
  private toastsEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private scanned = false;

  get options(): RemindersOptions {
    return this.instance.options as RemindersOptions;
  }

  private parseOpts() {
    return { defaultTime: this.options.defaultTime || "09:00", tasks: this.options.readTasksDates, kanban: this.options.readKanbanDates };
  }

  handledByReminderPlugin(): boolean {
    const plugins = this.app.plugins;
    return !!plugins.enabledPlugins?.has(REMINDER_PLUGIN_ID) && !!plugins.plugins?.[REMINDER_PLUGIN_ID];
  }

  override async onload() {
    this.loadFired();
    this.registerView(VIEW_TYPE_REMINDERS, (leaf) => new RemindersView(leaf, this));
    this.addCommand({ id: "reminders:show-list", name: "Show reminders", icon: "lucide-alarm-clock", callback: () => void this.openList() });
    this.addCommand({ id: "reminders:export-ics", name: "Export reminders as .ics", icon: "lucide-calendar-plus", callback: () => this.exportIcs() });
    this.addCommand({
      id: "reminders:add-to-calendar",
      name: "Add task to calendar (.ics)",
      icon: "lucide-calendar-plus",
      editorCheckCallback: (checking: boolean, editor: any, view: any) => {
        const r = view?.file ? this.reminderAtLine(editor, view.file.path) : null;
        if (!r) return false;
        if (!checking) this.downloadIcs([r], `${r.title.slice(0, 60) || "Reminder"}.ics`);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: any, view: any) => {
        const r = view?.file ? this.reminderAtLine(editor, view.file.path) : null;
        if (!r) return;
        menu.addItem((i) => i.setSection("action").setTitle("Add to calendar (.ics)").setIcon("lucide-calendar-plus").onClick(() => this.downloadIcs([r], `${r.title.slice(0, 60) || "Reminder"}.ics`)));
      }),
    );

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("vault-reminders-status", "mod-clickable");
    this.statusEl.addEventListener("click", () => void this.openList());
    this.statusEl.hide();

    const { vault, metadataCache, workspace } = this.app;
    this.registerEvent(metadataCache.on("changed", (file: TFile, text: string) => this.updateFile(file, text)));
    this.registerEvent(vault.on("delete", (file: TFile) => this.removePath(file.path)));
    this.registerEvent(
      vault.on("rename", (file: TFile, oldPath: string) => {
        const list = this.byPath.get(oldPath);
        if (!list) return;
        this.byPath.delete(oldPath);
        this.byPath.set(file.path, list.map((r) => ({ ...r, path: file.path })));
        this.changed();
      }),
    );
    for (const ev of ["plugin-loaded", "plugin-unloaded"]) this.registerEvent(this.app.plugins.on(ev, () => this.changed()));
    workspace.onLayoutReady(() => void this.scanAll());
    this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
    this.addSettingTab(new RemindersSettingTab(this.app, this));
  }

  override onunload() {
    this.toastsEl?.remove();
    this.toastsEl = null;
    void (navigator as { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => {});
  }

  // ---- index -----------------------------------------------------------------------

  async scanAll() {
    this.byPath.clear();
    for (const file of this.app.vault.getMarkdownFiles() as TFile[]) {
      try {
        this.setFile(file.path, await this.app.vault.cachedRead(file));
      } catch {
        /* unreadable */
      }
    }
    this.scanned = true;
    this.changed();
  }

  private setFile(path: string, text: string) {
    const found = /\[.\]/.test(text) ? parseReminders(text, this.parseOpts()).map((r) => ({ ...r, path })) : [];
    if (found.length) this.byPath.set(path, found);
    else this.byPath.delete(path);
  }

  private updateFile(file: TFile, text: string) {
    if (file.extension !== "md") return;
    this.setFile(file.path, text);
    this.changed();
  }

  private removePath(path: string) {
    if (this.byPath.delete(path)) this.changed();
  }

  all(): Reminder[] {
    return [...this.byPath.values()].flat().sort((a, b) => a.time - b.time);
  }

  pending(): Reminder[] {
    return this.all().filter((r) => !r.done);
  }

  private changed() {
    this.tick();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REMINDERS)) (leaf.view as RemindersView).render?.();
  }

  private reminderAtLine(editor: any, path: string): Reminder | null {
    const line = editor.getCursor().line;
    const parsed = parseReminderLine(editor.getLine(line), line, this.parseOpts());
    return parsed && !parsed.done ? { ...parsed, path } : null;
  }

  // ---- firing --------------------------------------------------------------------------

  private loadFired() {
    const saved = this.app.loadLocalStorage(FIRED_KEY);
    this.fired = new Set(Array.isArray(saved) ? saved : []);
  }

  private saveFired() {
    // Keep a week of history; older keys cannot fire again anyway once done or snoozed.
    const cutoff = Date.now() - 7 * 86_400_000;
    const keep = [...this.fired].filter((k) => Number(k.split("\u0000")[2]) >= cutoff);
    this.fired = new Set(keep);
    this.app.saveLocalStorage(FIRED_KEY, keep.length ? keep : null);
  }

  // internal (used by tests)
  tick() {
    if (!this.scanned) return;
    const now = Date.now();
    const pending = this.pending();
    const overdue = pending.filter((r) => r.time <= now);
    this.updateBadge(overdue.length);
    if (this.handledByReminderPlugin()) return;
    const due = overdue.filter((r) => !this.fired.has(reminderKey(r)));
    if (!due.length) return;
    for (const r of due.slice(-5)) {
      this.fired.add(reminderKey(r));
      this.notify(r);
    }
    for (const r of due.slice(0, -5)) this.fired.add(reminderKey(r));
    if (due.length > 5) new Notice(`${due.length - 5} more reminders are overdue. Open the reminders list to see them.`);
    this.saveFired();
  }

  private updateBadge(count: number) {
    if (this.statusEl) {
      this.statusEl.empty();
      if (count && !this.handledByReminderPlugin()) {
        const icon = this.statusEl.createSpan({ cls: "status-bar-item-icon" });
        setIcon(icon, "lucide-alarm-clock");
        this.statusEl.createSpan({ text: String(count) });
        this.statusEl.setAttr("aria-label", `${count} overdue reminder${count === 1 ? "" : "s"}`);
        this.statusEl.show();
      } else this.statusEl.hide();
    }
    const nav = navigator as { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!this.options.showBadge || !nav.setAppBadge) return;
    void (count ? nav.setAppBadge(count) : nav.clearAppBadge?.())?.catch(() => {});
  }

  private notify(r: Reminder) {
    this.showToast(r);
    if (!this.options.systemNotifications || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const n = new Notification(r.title || "Reminder", {
        body: `${hm(r.time)} · ${r.path.replace(/\.md$/, "")}`,
        tag: `reminder:${reminderKey(r)}`,
        requireInteraction: true,
      });
      n.onclick = () => {
        window.focus();
        void this.openAt(r);
        n.close();
      };
    } catch {
      /* Chrome on Android requires a service worker for notifications; the card is shown anyway. */
    }
  }

  private showToast(r: Reminder) {
    if (!this.toastsEl?.isConnected) this.toastsEl = document.body.createDiv({ cls: "vault-reminder-toasts" });
    const card = this.toastsEl.createDiv({ cls: "vault-reminder-toast", attr: { role: "alertdialog", "aria-label": `Reminder: ${r.title}` } });
    const head = card.createDiv({ cls: "vault-reminder-toast-head" });
    setIcon(head.createSpan({ cls: "vault-reminder-toast-icon" }), "lucide-alarm-clock");
    head.createSpan({ cls: "vault-reminder-toast-time", text: `${ymd(r.time) === ymd(Date.now()) ? "" : `${ymd(r.time)} `}${hm(r.time)}` });
    const close = head.createSpan({ cls: "clickable-icon vault-reminder-toast-close", attr: { "aria-label": "Dismiss", role: "button" } });
    setIcon(close, "lucide-x");
    close.addEventListener("click", () => card.remove());
    card.createDiv({ cls: "vault-reminder-toast-title", text: r.title || "(untitled task)" });
    const link = card.createEl("a", { cls: "vault-reminder-toast-file", text: r.path.replace(/\.md$/, ""), href: "#" });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      void this.openAt(r);
      card.remove();
    });
    const buttons = card.createDiv({ cls: "vault-reminder-toast-buttons" });
    const done = buttons.createEl("button", { cls: "mod-cta", text: "Mark as done" });
    done.addEventListener("click", async () => {
      card.remove();
      await this.markDone(r);
    });
    const later = buttons.createEl("button", { text: "Remind me later" });
    later.addEventListener("click", (evt) => {
      const menu = new Menu();
      for (const [label, time] of this.snoozeChoices()) menu.addItem((i) => i.setTitle(label).onClick(async () => {
        card.remove();
        await this.snooze(r, time);
      }));
      menu.showAtMouseEvent(evt);
    });
  }

  snoozeChoices(now = Date.now()): [string, number][] {
    const [dh, dm] = (this.options.defaultTime || "09:00").split(":").map(Number) as [number, number];
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(dh, dm, 0, 0);
    const nextWeek = new Date(tomorrow);
    nextWeek.setDate(nextWeek.getDate() + 6);
    const round = (ms: number) => Math.ceil(ms / 60_000) * 60_000;
    return [
      ["In 5 minutes", round(now + 5 * 60_000)],
      ["In 1 hour", round(now + 60 * 60_000)],
      ["Tomorrow", tomorrow.getTime()],
      ["Next week", nextWeek.getTime()],
    ];
  }

  // ---- editing the task line -------------------------------------------------------------

  private async editLine(r: Reminder, change: (line: string) => string): Promise<boolean> {
    const file = this.app.vault.getFileByPath(r.path);
    if (!file) return false;
    let ok = false;
    await this.app.vault.process(file, (data: string) => {
      const eol = data.includes("\r\n") ? "\r\n" : "\n";
      const lines = data.split(/\r?\n/);
      const idx = lines[r.line] === r.raw ? r.line : lines.indexOf(r.raw);
      if (idx < 0) return data;
      const next = change(lines[idx]!);
      if (next === lines[idx]) return data;
      lines[idx] = next;
      ok = true;
      return lines.join(eol);
    });
    if (!ok) new Notice(`Could not update the task in ${r.path}: the line has changed.`);
    return ok;
  }

  async markDone(r: Reminder) {
    if (await this.editLine(r, (line) => markDoneLine(r, line, Date.now()))) new Notice(`Done: ${r.title}`);
  }

  async snooze(r: Reminder, time: number) {
    if (await this.editLine(r, (line) => snoozeLine(r, line, time))) new Notice(`Reminder moved to ${ymd(time)} ${hm(time)}.`);
  }

  async openAt(r: Reminder) {
    const file = this.app.vault.getFileByPath(r.path);
    if (!file) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { eState: { line: r.line } });
    const view = leaf.view;
    if (view instanceof MarkdownView) {
      view.editor.setCursor({ line: r.line, ch: 0 });
      view.editor.scrollIntoView({ from: { line: r.line, ch: 0 }, to: { line: r.line, ch: 0 } }, true);
    }
  }

  // ---- calendar export ------------------------------------------------------------------

  icsFor(reminders: Reminder[]): string {
    return buildIcs(
      reminders.map((r) => ({ title: r.title, time: r.time, path: r.path })),
      Date.now(),
      `${this.app.vault.getName()} reminders`,
    );
  }

  downloadIcs(reminders: Reminder[], filename: string) {
    downloadBlob(new Blob([this.icsFor(reminders)], { type: "text/calendar" }), filename.replace(/[\\/:*?"<>|]/g, "-"));
  }

  exportIcs() {
    const upcoming = this.pending().filter((r) => r.time >= Date.now() - 86_400_000);
    if (!upcoming.length) {
      new Notice("No upcoming reminders to export.");
      return;
    }
    this.downloadIcs(upcoming, "Reminders.ics");
    new Notice(`Exported ${upcoming.length} reminder${upcoming.length === 1 ? "" : "s"}. Open the file with your calendar app so its alarms fire even when this app is closed.`, 8000);
  }

  async openList() {
    await this.app.workspace.ensureSideLeaf(VIEW_TYPE_REMINDERS, "right", { active: true, reveal: true });
  }
}

class RemindersView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: RemindersPlugin,
  ) {
    super(leaf);
    this.icon = "lucide-alarm-clock";
  }
  getViewType() {
    return VIEW_TYPE_REMINDERS;
  }
  getDisplayText() {
    return "Reminders";
  }
  override getIcon() {
    return "lucide-alarm-clock";
  }

  override async onOpen() {
    this.contentEl.addClass("vault-reminders-view");
    this.addAction("lucide-calendar-plus", "Export reminders as .ics", () => this.plugin.exportIcs());
    this.render();
    // Section boundaries (Today/Tomorrow) move with the clock.
    this.registerInterval(window.setInterval(() => this.render(), 60_000));
  }

  render() {
    const el = this.contentEl;
    el.empty();
    if (this.plugin.handledByReminderPlugin()) {
      el.createDiv({ cls: "pane-empty", text: "Handled by the Reminder plugin, which is enabled. Its own reminder list shows these tasks." });
      return;
    }
    const now = Date.now();
    const pending = this.plugin.pending();
    if (!pending.length) {
      el.createDiv({ cls: "pane-empty", text: "No reminders. Add one to a task: - [ ] Call Sam (@2026-09-15 09:00)" });
      return;
    }
    const today = ymd(now);
    const tomorrow = ymd(now + 86_400_000);
    const groups: [string, Reminder[]][] = [
      ["Overdue", pending.filter((r) => r.time <= now)],
      ["Today", pending.filter((r) => r.time > now && ymd(r.time) === today)],
      ["Tomorrow", pending.filter((r) => ymd(r.time) === tomorrow && r.time > now)],
      ["Later", pending.filter((r) => r.time > now && ymd(r.time) !== today && ymd(r.time) !== tomorrow)],
    ];
    const footer = el.createDiv({ cls: "vault-reminders-footer" });
    const exportBtn = footer.createEl("button", { cls: "mod-muted", text: "Export as .ics" });
    exportBtn.addEventListener("click", () => this.plugin.exportIcs());
    for (const [name, items] of groups) {
      if (!items.length) continue;
      const section = el.createDiv({ cls: `vault-reminders-group mod-${name.toLowerCase()}` });
      section.createDiv({ cls: "vault-reminders-group-title", text: `${name} · ${items.length}` });
      for (const r of items) {
        const row = section.createDiv({ cls: "vault-reminders-item tappable", attr: { tabindex: "0" } });
        const check = row.createEl("input", { cls: "task-list-item-checkbox", type: "checkbox", attr: { "aria-label": `Mark “${r.title}” as done` } });
        check.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.plugin.markDone(r);
        });
        const body = row.createDiv({ cls: "vault-reminders-item-body" });
        body.createDiv({ cls: "vault-reminders-item-title", text: r.title || "(untitled task)" });
        const when = name === "Today" || name === "Tomorrow" ? hm(r.time) : `${ymd(r.time)} ${hm(r.time)}`;
        body.createDiv({ cls: "vault-reminders-item-meta", text: `${when} · ${r.path.replace(/\.md$/, "")}` });
        row.addEventListener("click", () => void this.plugin.openAt(r));
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void this.plugin.openAt(r);
        });
        row.addEventListener("contextmenu", (evt) => {
          evt.preventDefault();
          const menu = new Menu();
          menu.addItem((i) => i.setTitle("Mark as done").setIcon("lucide-check").onClick(() => void this.plugin.markDone(r)));
          for (const [label, time] of this.plugin.snoozeChoices()) menu.addItem((i) => i.setTitle(`Remind me later: ${label.toLowerCase()}`).setIcon("lucide-alarm-clock").onClick(() => void this.plugin.snooze(r, time)));
          menu.addItem((i) => i.setTitle("Add to calendar (.ics)").setIcon("lucide-calendar-plus").onClick(() => this.plugin.downloadIcs([r], `${r.title.slice(0, 60) || "Reminder"}.ics`)));
          menu.showAtMouseEvent(evt);
        });
      }
    }
  }
}

class RemindersSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: RemindersPlugin,
  ) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = (rescan = false) => {
      void this.owner.instance.saveOptions();
      if (rescan) void this.owner.scanAll();
    };
    if (this.owner.handledByReminderPlugin()) {
      containerEl.createDiv({ cls: "vault-device-handled-by setting-item-description", text: "Handled by Reminder: that community plugin is enabled, so these notifications are off. Export to .ics still works." });
    }
    containerEl.createDiv({
      cls: "setting-item-description vault-device-intro",
      text: "Reminders fire only while this app is open in a tab or installed window: there is no server to wake it. Export them as .ics so your calendar alerts you when the app is closed.",
    });
    new Setting(containerEl)
      .setName("Default reminder time")
      .setDesc("For reminders with a date and no time, such as (@2026-09-15).")
      .addText((t) => {
        t.inputEl.type = "time";
        t.setValue(o.defaultTime).onChange((v) => {
          if (!/^\d{1,2}:\d{2}$/.test(v)) return;
          o.defaultTime = v;
          save(true);
        });
      });
    new Setting(containerEl)
      .setName("Read Tasks plugin dates")
      .setDesc("Also remind for ⏰ reminder dates and 📅 due dates written by the Tasks plugin.")
      .addToggle((t) => t.setValue(o.readTasksDates).onChange((v) => ((o.readTasksDates = v), save(true))));
    new Setting(containerEl)
      .setName("Read Kanban plugin dates")
      .setDesc("Also remind for Kanban cards with @{2026-09-15} @@{09:00}.")
      .addToggle((t) => t.setValue(o.readKanbanDates).onChange((v) => ((o.readKanbanDates = v), save(true))));

    const notif = new Setting(containerEl).setName("System notifications");
    if (typeof Notification === "undefined") {
      notif.setDesc("This browser has no Notification API; reminders show inside the app only.");
    } else {
      const state = Notification.permission;
      notif.setDesc(
        state === "granted"
          ? "Allowed. Reminders also appear as system notifications."
          : state === "denied"
            ? "Blocked for this site. Allow notifications in the browser's site settings to use them."
            : "Show reminders as system notifications too, not only inside the app.",
      );
      if (state === "default") {
        notif.addButton((b) =>
          b.setButtonText("Allow notifications").onClick(async () => {
            await Notification.requestPermission();
            this.display();
          }),
        );
      }
      notif.addToggle((t) => t.setValue(o.systemNotifications).setDisabled(state === "denied").onChange((v) => ((o.systemNotifications = v), save())));
    }
    new Setting(containerEl)
      .setName("Show overdue count on the app icon")
      .setDesc("Badging API; works in an installed app on desktop Chrome, Edge and Safari.")
      .addToggle((t) => t.setValue(o.showBadge).onChange((v) => ((o.showBadge = v), save(), this.owner.tick())));
    new Setting(containerEl)
      .setName("Calendar")
      .setDesc("Download all upcoming reminders as one .ics file, with an alarm for each.")
      .addButton((b) => b.setButtonText("Export reminders as .ics").onClick(() => this.owner.exportIcs()));
  }
}
