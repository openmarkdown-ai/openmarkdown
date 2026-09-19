/**
 * A small natural-language date reader for `@today`, `@next monday`,
 * `@in 3 days`, `@sep 20` and the like. English only, local time, no network.
 */
import type { Moment } from "moment";
import { moment } from "../../obsidian/util";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT_DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const UNITS: Record<string, moment.unitOfTime.DurationConstructor> = {
  day: "days", days: "days", d: "days",
  week: "weeks", weeks: "weeks", w: "weeks",
  month: "months", months: "months",
  year: "years", years: "years", y: "years",
  hour: "hours", hours: "hours", h: "hours",
  minute: "minutes", minutes: "minutes", min: "minutes", mins: "minutes",
};

function weekday(word: string): number {
  const w = word.toLowerCase();
  const i = WEEKDAYS.indexOf(w);
  if (i !== -1) return i;
  return SHORT_DAYS[w] ?? -1;
}

function amount(word: string): number {
  if (/^\d+$/.test(word)) return Number(word);
  return NUMBER_WORDS[word.toLowerCase()] ?? NaN;
}

/**
 * The date `text` describes, relative to `ref`, or null. `weekStartsOn` is the
 * first day of the week (0 = Sunday) for "this week" / "next week" phrases.
 */
export function parseNaturalDate(text: string, ref: Moment = moment(), weekStartsOn = moment.localeData().firstDayOfWeek()): Moment | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,!]+$/, "");
  if (!t) return null;
  const today = ref.clone().startOf("day");
  switch (t) {
    case "today":
    case "tod":
      return today;
    case "now":
      return ref.clone();
    case "tomorrow":
    case "tmr":
    case "tmrw":
      return today.add(1, "day");
    case "yesterday":
      return today.subtract(1, "day");
    case "day after tomorrow":
    case "the day after tomorrow":
      return today.add(2, "days");
    case "day before yesterday":
    case "the day before yesterday":
      return today.subtract(2, "days");
  }
  let m: RegExpExecArray | null;
  // next/last/this <weekday | week | month | year>
  if ((m = /^(next|last|this|previous|coming) (\w+)$/.exec(t))) {
    const dir = m[1] === "next" || m[1] === "coming" ? 1 : m[1] === "this" ? 0 : -1;
    const day = weekday(m[2]!);
    if (day !== -1) {
      const startOfWeek = today.clone().subtract((today.day() - weekStartsOn + 7) % 7, "days");
      const inWeek = startOfWeek.clone().add((day - weekStartsOn + 7) % 7, "days");
      return inWeek.add(dir, "weeks");
    }
    const unit = UNITS[m[2]!];
    if (unit === "weeks" || unit === "months" || unit === "years" || unit === "days") return today.add(dir, unit);
    return null;
  }
  // bare weekday: the next one (today counts)
  const bare = weekday(t);
  if (bare !== -1) return today.add((bare - today.day() + 7) % 7, "days");
  // in N units / N units from now / N units ago
  if ((m = /^in (\w+) (\w+)$/.exec(t)) || (m = /^(\w+) (\w+) (?:from now|later)$/.exec(t))) {
    const n = amount(m[1]!);
    const unit = UNITS[m[2]!];
    if (Number.isFinite(n) && unit) return (unit === "hours" || unit === "minutes" ? ref.clone() : today).add(n, unit);
    return null;
  }
  if ((m = /^(\w+) (\w+) ago$/.exec(t))) {
    const n = amount(m[1]!);
    const unit = UNITS[m[2]!];
    if (Number.isFinite(n) && unit) return (unit === "hours" || unit === "minutes" ? ref.clone() : today).subtract(n, unit);
    return null;
  }
  // explicit dates
  const formats = ["YYYY-MM-DD", "YYYY/MM/DD", "MMM D", "MMMM D", "D MMM", "D MMMM", "MMM Do", "MMMM Do", "Do MMM", "Do MMMM", "MMM D YYYY", "MMMM D YYYY", "D MMM YYYY", "D MMMM YYYY", "MMM D, YYYY", "MMMM D, YYYY", "MMMM Do YYYY", "MMMM Do, YYYY"];
  const parsed = moment(text.trim(), formats, "en", true);
  if (parsed.isValid()) {
    const hasYear = /\d{4}/.test(t);
    if (!hasYear) parsed.year(today.year());
    return parsed.startOf("day");
  }
  return null;
}

/** The phrases offered before anything recognisable is typed. */
export const SUGGESTED_PHRASES = ["Today", "Tomorrow", "Yesterday", "Next week", "Next Monday", "Next Friday", "Last Friday", "In 3 days", "In 2 weeks", "Next month"];
