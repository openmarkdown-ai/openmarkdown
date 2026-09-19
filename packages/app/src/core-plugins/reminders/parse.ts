/**
 * Reminder syntax, read and written exactly as the Reminder community plugin
 * (uphy/obsidian-reminder) does:
 *
 *   - [ ] Task (@2026-09-15)            date only → the default reminder time
 *   - [ ] Task (@2026-09-15 09:00)      date and time
 *   - [ ] Task (@2026-09-15 🔁every week)  recurrence rule kept as written
 *   - [ ] Task (@[[2026-09-15]] 09:00)  "Link dates to daily notes"
 *   - [x] / [-] never fire
 *
 * Optionally the Tasks plugin's `⏰ 2026-09-15 10:00` (reminder) and
 * `📅 2026-09-15` (due) and Kanban's `@{2026-09-15} @@{09:00}`.
 */

export type ReminderFormat = "reminder" | "tasks-reminder" | "tasks-due" | "kanban";

export interface ReminderParseOptions {
  /** Default time for date-only reminders, `HH:mm`. */
  defaultTime: string;
  tasks: boolean;
  kanban: boolean;
}

export interface ParsedReminder {
  /** 0-based line number. */
  line: number;
  /** The whole source line. */
  raw: string;
  title: string;
  /** Local time in ms. */
  time: number;
  status: string;
  done: boolean;
  format: ReminderFormat;
  hasTime: boolean;
}

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)(.)(\]\s+)(.*)$/;
const DATE = "(\\d{4}-\\d{2}-\\d{2})";
const TIME = "(\\d{1,2}:\\d{2})";
export const REMINDER_TOKEN_RE = new RegExp(`\\(@(?:\\[\\[)?${DATE}(?:\\]\\])?(?:\\s+${TIME})?(\\s*🔁[^)]*)?\\)`);
const TASKS_REMINDER_RE = new RegExp(`⏰\\s*${DATE}(?:\\s+${TIME})?`);
const TASKS_DUE_RE = new RegExp(`📅\\s*${DATE}(?:\\s+${TIME})?`);
const KANBAN_RE = new RegExp(`@(?:\\{${DATE}\\}|\\[\\[${DATE}\\]\\])(?:\\s*@@\\{${TIME}\\})?`);

export function localTime(date: string, time: string | undefined, defaultTime: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = (time ?? defaultTime ?? "09:00").split(":").map(Number) as [number, number];
  return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime();
}

function clean(title: string): string {
  return title
    .replace(/[⏰📅⏳🛫✅➕]\s*\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?/gu, "")
    .replace(/🔁[^📅⏰⏳🛫✅]*/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function parseReminderLine(text: string, line: number, opts: ReminderParseOptions): ParsedReminder | null {
  const task = TASK_RE.exec(text);
  if (!task) return null;
  const status = task[2]!;
  const body = task[4]!;
  const base = { line, raw: text, status, done: status !== " " };
  let m = REMINDER_TOKEN_RE.exec(body);
  if (m) return { ...base, format: "reminder", title: clean(body.replace(m[0], "")), time: localTime(m[1]!, m[2], opts.defaultTime), hasTime: !!m[2] };
  if (opts.tasks) {
    m = TASKS_REMINDER_RE.exec(body);
    if (m) return { ...base, format: "tasks-reminder", title: clean(body), time: localTime(m[1]!, m[2], opts.defaultTime), hasTime: !!m[2] };
    m = TASKS_DUE_RE.exec(body);
    if (m) return { ...base, format: "tasks-due", title: clean(body), time: localTime(m[1]!, m[2], opts.defaultTime), hasTime: !!m[2] };
  }
  if (opts.kanban) {
    m = KANBAN_RE.exec(body);
    if (m) return { ...base, format: "kanban", title: clean(body.replace(m[0], "")), time: localTime((m[1] ?? m[2])!, m[3], opts.defaultTime), hasTime: !!m[3] };
  }
  return null;
}

/** All reminders in a note, skipping fenced code blocks. */
export function parseReminders(content: string, opts: ReminderParseOptions): ParsedReminder[] {
  const out: ParsedReminder[] = [];
  const lines = content.split(/\r?\n/);
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    const f = /^\s{0,3}(```+|~~~+)/.exec(text);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (!/\[.\]/.test(text)) continue;
    const r = parseReminderLine(text, i, opts);
    if (r) out.push(r);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
export function ymd(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function hm(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `[ ]` → `[x]`; Tasks lines also get `✅ <today>`, as Reminder's "Mark as Done". */
export function markDoneLine(r: ParsedReminder, line: string, now: number): string {
  const task = TASK_RE.exec(line);
  if (!task) return line;
  let body = task[4]!;
  if ((r.format === "tasks-due" || r.format === "tasks-reminder") && !/✅/.test(body)) body = `${body.replace(/\s+$/, "")} ✅ ${ymd(now)}`;
  return `${task[1]}x${task[3]}${body}`;
}

/** Moves the reminder to `time`, in the line's own syntax ("Remind me later"). */
export function snoozeLine(r: ParsedReminder, line: string, time: number): string {
  const stamp = `${ymd(time)} ${hm(time)}`;
  switch (r.format) {
    case "reminder":
      return line.replace(REMINDER_TOKEN_RE, (_m, _d, _t, recur: string | undefined) => `(@${stamp}${recur ?? ""})`);
    case "tasks-reminder":
      return line.replace(TASKS_REMINDER_RE, `⏰ ${stamp}`);
    case "tasks-due": {
      // Snoozing writes ⏰ and keeps the due date, as the Reminder plugin does.
      const due = TASKS_DUE_RE.exec(line);
      return due ? `${line.slice(0, due.index)}⏰ ${stamp} ${line.slice(due.index)}` : `${line} ⏰ ${stamp}`;
    }
    case "kanban":
      return line.replace(KANBAN_RE, `@{${ymd(time)}} @@{${hm(time)}}`);
  }
}

// ---- iCalendar ---------------------------------------------------------------------------

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds content lines at 75 octets (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (curBytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}
function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface IcsItem {
  title: string;
  time: number;
  path: string;
  url?: string;
}

/**
 * A calendar with one 15-minute event and an alarm per reminder. Times are
 * floating local times, so calendars show them at the hour written in the note.
 */
export function buildIcs(items: IcsItem[], now: number, calendarName = "Reminders"): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OpenMarkdown//Reminders//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${icsEscape(calendarName)}`];
  for (const it of items) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${hash(`${it.path}\u0000${it.title}\u0000${it.time}`)}@openmarkdown`,
      `DTSTAMP:${utcStamp(now)}`,
      `DTSTART:${localStamp(it.time)}`,
      `DTEND:${localStamp(it.time + 15 * 60_000)}`,
      `SUMMARY:${icsEscape(it.title || "Reminder")}`,
      `DESCRIPTION:${icsEscape(`From ${it.path}`)}`,
      ...(it.url ? [`URL:${it.url}`] : []),
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsEscape(it.title || "Reminder")}`,
      "TRIGGER:PT0S",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
