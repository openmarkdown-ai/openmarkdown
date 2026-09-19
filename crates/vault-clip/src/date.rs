//! dayjs 1.11 date semantics for the clipper template language's `date` and
//! `date_modify` filters.
//!
//! Knap (the Obsidian Web Clipper template engine) calls dayjs with the
//! `customParseFormat`, `isoWeek`, `weekOfYear` and `advancedFormat` plugins.
//! This module reproduces what that combination does, quirks included, so
//! templates render the same bytes here as in the extension. Everything was
//! checked against dayjs 1.11.23 running on Node 26 (V8).
//!
//! "Local time" is a fixed UTC offset in minutes supplied by the caller, so
//! there is no DST and no historical zone data; dayjs in a real zone agrees
//! whenever that zone's offset is constant over the dates involved. Nothing
//! here reads the clock: the one place dayjs consults "now" (custom formats
//! that omit the year, month or day) takes `now_ms` explicitly.
//!
//! What is reproduced:
//!
//! * [`parse`] = `dayjs(string)`. Strings not ending in `z`/`Z` are first
//!   tried against dayjs's `REGEX_PARSE` (with JS backtracking semantics) and
//!   built with the local `new Date(y, m, d, ...)` constructor: months and
//!   days overflow (`2024-13-01` is 2025-01-01, `2024-00-00` is 2023-11-30),
//!   four-digit years 0000-0099 map to 1900-1999, and the fraction keeps its
//!   first three *digits* (`.5` is 5 ms, not 500). A purely numeric string
//!   such as `"1700000000000"` also goes through that regex and becomes a
//!   date in 1699, exactly as dayjs does. Everything else goes to a port of
//!   V8's `Date` string parser (ES5 ISO forms plus the legacy parser: RFC
//!   2822, `September 3, 2024`, `Sep 3 2024 10:00 pm`, `2024/09/03`,
//!   `GMT+0530`, `(comments)`, US time-zone names, two-digit years, the
//!   year-2001 default for `Sep 3`, and its rejections such as `10pm`).
//! * [`parse_with_format`] / [`parse_with_format_at`] = `dayjs(input, format,
//!   strict)` from customParseFormat, including its unanchored token regexes,
//!   its "remove the first occurrence of the matched text" consumption, the
//!   `now` fallbacks for missing year/month/day, `week` tokens, `Z` offsets,
//!   `X`/`x`, the round-trip check in strict mode, and invalidity for
//!   localized `L…` tokens (en has no `formats`, so the plugin throws).
//! * [`format`] / [`try_format`] = `.format()` with advancedFormat. The two
//!   replacement passes are kept separate as in dayjs, so e.g. an unbracketed
//!   `W` or `k` inside literal text is replaced by advancedFormat first.
//!   `YYYY` pads with dayjs's naive `padStart` (year -5 prints `00-5`), `Z` is
//!   rounded to 15 minutes like `utcOffset()`, `w`/`W`/`GGGG` follow the
//!   plugins' own arithmetic (including their year 0-99 → 1900s mapping).
//! * [`add`] = `.add(n, unit)` with dayjs's unit normalisation: month/year
//!   add clamps the day of month, day/week add goes through `setDate`, and
//!   any unit dayjs does not recognise (including `quarter`) adds
//!   milliseconds, as dayjs does.
//!
//! Known gaps:
//!
//! * `z`, `zzz` and `gggg` need dayjs plugins Knap does not load
//!   (`timezone`, `weekYear`), so dayjs *throws*. [`try_format`] returns
//!   `Err` for them; [`format`] returns an empty string (Knap's renderer
//!   turns a throwing filter into empty output plus an error).
//! * Offsets are fixed; zones with DST or historical offset changes (and the
//!   15-minute rounding of pre-1900 LMT offsets) are not modelled.
//! * JS strings are UTF-16. The V8 parser port works on `char`s, which only
//!   differs for astral-plane characters inside words, where no keyword can
//!   match either way.

const MS_PER_SECOND: f64 = 1_000.0;
const MS_PER_MINUTE: f64 = 60_000.0;
const MS_PER_HOUR: f64 = 3_600_000.0;
const MS_PER_DAY: f64 = 86_400_000.0;
const MS_PER_WEEK: f64 = 604_800_000.0;
/// ECMAScript time value limit (±100,000,000 days).
const MAX_TIME_MS: f64 = 8.64e15;
/// V8 accepts local times up to ten days beyond the limit before converting.
const MAX_TIME_BEFORE_UTC_MS: f64 = 8.64e15 + 864_000_000.0;

const DEFAULT_FORMAT: &str = "YYYY-MM-DDTHH:mm:ssZ";
const INVALID_DATE: &str = "Invalid Date";

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// An instant (milliseconds since the Unix epoch, like a JS `Date`) plus the
/// fixed UTC offset used to display it. An invalid date (dayjs's
/// `Invalid Date`) holds a NaN instant; the parse functions never return one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DateTime {
    ms: f64,
    offset_minutes: i32,
}

impl DateTime {
    /// Like `new Date(ms)`: the value is truncated to whole milliseconds and
    /// becomes invalid outside the ECMAScript range.
    pub fn from_epoch_ms(ms: f64, offset_minutes: i32) -> DateTime {
        DateTime {
            ms: time_clip(ms),
            offset_minutes,
        }
    }

    pub fn epoch_ms(&self) -> f64 {
        self.ms
    }

    pub fn offset_minutes(&self) -> i32 {
        self.offset_minutes
    }

    pub fn is_valid(&self) -> bool {
        !self.ms.is_nan()
    }

    fn fields(&self) -> Fields {
        fields_at(self.ms, self.offset_minutes)
    }
}

/// Why [`try_format`] could not produce output: dayjs throws a `TypeError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormatError {
    /// The token calls a method from a dayjs plugin Knap does not load
    /// (`z`/`zzz` need `timezone`, `gggg` needs `weekYear`).
    MissingPlugin(&'static str),
}

// ---------------------------------------------------------------------------
// ECMAScript date arithmetic (as V8 implements it) on a fixed offset.
// ---------------------------------------------------------------------------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// V8's `MakeDay`: year within ±1e6 and month within ±1e7 before combining.
fn make_day(year: f64, month: f64, date: f64) -> f64 {
    if !((-1e6..=1e6).contains(&year) && (-1e7..=1e7).contains(&month) && date.is_finite()) {
        return f64::NAN;
    }
    let mut y = year.trunc() as i64;
    let mut m = month.trunc() as i64;
    y += m / 12;
    m %= 12;
    if m < 0 {
        m += 12;
        y -= 1;
    }
    days_from_civil(y, m + 1, 1) as f64 + date.trunc() - 1.0
}

fn make_time(h: f64, m: f64, s: f64, ms: f64) -> f64 {
    if !(h.is_finite() && m.is_finite() && s.is_finite() && ms.is_finite()) {
        return f64::NAN;
    }
    h.trunc() * MS_PER_HOUR + m.trunc() * MS_PER_MINUTE + s.trunc() * MS_PER_SECOND + ms.trunc()
}

fn make_date(day: f64, time: f64) -> f64 {
    if !(day.is_finite() && time.is_finite()) {
        return f64::NAN;
    }
    day * MS_PER_DAY + time
}

fn time_clip(t: f64) -> f64 {
    if !t.is_finite() || t.abs() > MAX_TIME_MS {
        return f64::NAN;
    }
    t.trunc() + 0.0
}

fn offset_ms(off: i32) -> f64 {
    off as f64 * MS_PER_MINUTE
}

fn local_to_utc(local: f64, off: i32) -> f64 {
    if !(-MAX_TIME_BEFORE_UTC_MS..=MAX_TIME_BEFORE_UTC_MS).contains(&local) {
        return f64::NAN;
    }
    time_clip(local.trunc() - offset_ms(off))
}

/// `MakeFullYear`: the `Date` constructor and `Date.UTC` read 0-99 as 1900s.
fn make_full_year(y: f64) -> f64 {
    if y.is_nan() {
        return y;
    }
    let t = y.trunc();
    if (0.0..=99.0).contains(&t) {
        1900.0 + t
    } else {
        y
    }
}

/// `new Date(y, mo, d, h, mi, s, ms)` in local time.
#[allow(clippy::too_many_arguments)]
fn new_date_local(y: f64, mo: f64, d: f64, h: f64, mi: f64, s: f64, ms: f64, off: i32) -> f64 {
    let local = make_date(make_day(make_full_year(y), mo, d), make_time(h, mi, s, ms));
    local_to_utc(local, off)
}

fn new_date_ymd(y: f64, mo: f64, d: f64, off: i32) -> f64 {
    new_date_local(y, mo, d, 0.0, 0.0, 0.0, 0.0, off)
}

/// `Date.UTC(y, mo, d, h, mi, s, ms)`.
fn date_utc(y: f64, mo: f64, d: f64, h: f64, mi: f64, s: f64, ms: f64) -> f64 {
    time_clip(make_date(
        make_day(make_full_year(y), mo, d),
        make_time(h, mi, s, ms),
    ))
}

#[derive(Debug, Clone, Copy)]
struct Fields {
    year: f64,
    month: f64,
    date: f64,
    weekday: f64,
    hour: f64,
    minute: f64,
    second: f64,
    ms: f64,
}

fn fields_at(t: f64, off: i32) -> Fields {
    let local = t + offset_ms(off);
    if !local.is_finite() {
        let n = f64::NAN;
        return Fields {
            year: n,
            month: n,
            date: n,
            weekday: n,
            hour: n,
            minute: n,
            second: n,
            ms: n,
        };
    }
    let day = (local / MS_PER_DAY).floor();
    let tod = local - day * MS_PER_DAY;
    let (y, m, d) = civil_from_days(day as i64);
    let tod = tod as i64;
    Fields {
        year: y as f64,
        month: (m - 1) as f64,
        date: d as f64,
        weekday: (day as i64 + 4).rem_euclid(7) as f64,
        hour: (tod / 3_600_000) as f64,
        minute: (tod / 60_000 % 60) as f64,
        second: (tod / 1_000 % 60) as f64,
        ms: (tod % 1_000) as f64,
    }
}

fn local_day_and_time(t: f64, off: i32) -> (f64, f64) {
    let local = t + offset_ms(off);
    let day = (local / MS_PER_DAY).floor();
    (day, local - day * MS_PER_DAY)
}

/// `Date.prototype.setDate`.
fn set_date(t: f64, off: i32, date: f64) -> f64 {
    if t.is_nan() {
        return t;
    }
    let f = fields_at(t, off);
    let (_, tod) = local_day_and_time(t, off);
    local_to_utc(make_date(make_day(f.year, f.month, date), tod), off)
}

/// `Date.prototype.setMonth(month)`.
fn set_month(t: f64, off: i32, month: f64) -> f64 {
    if t.is_nan() {
        return t;
    }
    let f = fields_at(t, off);
    let (_, tod) = local_day_and_time(t, off);
    local_to_utc(make_date(make_day(f.year, month, f.date), tod), off)
}

/// `Date.prototype.setFullYear(year)`.
fn set_full_year(t: f64, off: i32, year: f64) -> f64 {
    let t = if t.is_nan() { -offset_ms(off) } else { t };
    let f = fields_at(t, off);
    let (_, tod) = local_day_and_time(t, off);
    local_to_utc(make_date(make_day(year, f.month, f.date), tod), off)
}

/// `Date.prototype.setHours(h, m, s, ms)`.
fn set_hours(t: f64, off: i32, h: f64, m: f64, s: f64, ms: f64) -> f64 {
    if t.is_nan() {
        return t;
    }
    let (day, _) = local_day_and_time(t, off);
    local_to_utc(make_date(day, make_time(h, m, s, ms)), off)
}

// ---------------------------------------------------------------------------
// dayjs building blocks.
// ---------------------------------------------------------------------------

/// `dayjs#daysInMonth`: `new Date($y, $M + 1, 0).$D` (with the 1900 mapping).
fn days_in_month(t: f64, off: i32) -> f64 {
    let f = fields_at(t, off);
    fields_at(new_date_ymd(f.year, f.month + 1.0, 0.0, off), off).date
}

/// dayjs `$set` for month (`is_month`) or year: day 1, set, clamp the day.
fn dayjs_set_month_or_year(t: f64, off: i32, is_month: bool, arg: f64) -> f64 {
    let this_date = fields_at(t, off).date;
    let first = set_date(t, off, 1.0);
    let moved = if is_month {
        set_month(first, off, arg)
    } else {
        set_full_year(first, off, arg)
    };
    let dim = days_in_month(moved, off);
    let clamped = if this_date.is_nan() || dim.is_nan() {
        f64::NAN
    } else {
        this_date.min(dim)
    };
    set_date(moved, off, clamped)
}

fn add_days(t: f64, off: i32, n: f64) -> f64 {
    set_date(t, off, fields_at(t, off).date + js_round(n))
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `absFloor`: truncation toward zero.
fn abs_floor(x: f64) -> f64 {
    x.trunc() + 0.0
}

fn iso_weekday(f: &Fields) -> f64 {
    if f.weekday == 0.0 {
        7.0
    } else {
        f.weekday
    }
}

/// isoWeek plugin `isoWeekYear`.
fn iso_week_year(t: f64, off: i32) -> f64 {
    let f = fields_at(t, off);
    fields_at(add_days(t, off, 4.0 - iso_weekday(&f)), off).year
}

/// isoWeek plugin `isoWeek`.
fn iso_week(t: f64, off: i32) -> f64 {
    let f = fields_at(t, off);
    let thursday = add_days(t, off, 4.0 - iso_weekday(&f));
    let year = fields_at(thursday, off).year;
    // getYearFirstThursday: dayjs().year(year).startOf('year') is
    // new Date(year, 0, 1), which maps years 0-99 to the 1900s.
    let jan1 = new_date_ymd(year, 0.0, 1.0, off);
    let jf = fields_at(jan1, off);
    let wd = iso_weekday(&jf);
    let mut diff_days = 4.0 - wd;
    if wd > 4.0 {
        diff_days += 7.0;
    }
    let first_thursday = add_days(jan1, off, diff_days);
    abs_floor((thursday - first_thursday) / MS_PER_WEEK) + 1.0
}

/// weekOfYear plugin `week` for the en locale (week starts Sunday, yearStart 1).
fn week_of_year(t: f64, off: i32, depth: u32) -> f64 {
    let f = fields_at(t, off);
    if f.month == 11.0 && f.date > 25.0 {
        let start_of_year = new_date_ymd(f.year, 0.0, 1.0, off);
        let next_year = dayjs_set_month_or_year(
            start_of_year,
            off,
            false,
            fields_at(start_of_year, off).year + 1.0,
        );
        let next_year_start = set_date(next_year, off, 1.0);
        let end_of_week = set_hours(
            new_date_ymd(f.year, f.month, f.date + (6.0 - f.weekday), off),
            off,
            23.0,
            59.0,
            59.0,
            999.0,
        );
        if next_year_start < end_of_week {
            return 1.0;
        }
    }
    let year_start_day = new_date_ymd(f.year, 0.0, 1.0, off);
    let yf = fields_at(year_start_day, off);
    let year_start_week = new_date_ymd(yf.year, yf.month, yf.date - yf.weekday, off) - 1.0;
    let diff_in_week = (t - year_start_week) / MS_PER_WEEK;
    if diff_in_week < 0.0 && depth < 4 {
        let start_of_week = new_date_ymd(f.year, f.month, f.date - f.weekday, off);
        return week_of_year(start_of_week, off, depth + 1);
    }
    diff_in_week.ceil() + 0.0
}

/// `String(n)` for the integral values dayjs formats.
fn num_str(n: f64) -> String {
    if n.is_nan() {
        "NaN".to_string()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
    } else {
        format!("{}", n as i64)
    }
}

/// dayjs `Utils.s` (padStart): pads with the fill *before* any minus sign.
fn pad_start(s: &str, len: usize, fill: char) -> String {
    let n = s.chars().count();
    if s.is_empty() || n >= len {
        return s.to_string();
    }
    let mut out: String = std::iter::repeat_n(fill, len - n).collect();
    out.push_str(s);
    out
}

fn ordinal(n: f64) -> String {
    let suffixes = ["th", "st", "nd", "rd"];
    let v = (n as i64) % 100;
    let idx = (v - 20) % 10;
    let s = if (0..4).contains(&idx) {
        suffixes[idx as usize]
    } else if (0..4).contains(&v) {
        suffixes[v as usize]
    } else {
        suffixes[0]
    };
    format!("[{}{}]", num_str(n), s)
}

/// `-Math.round(getTimezoneOffset() / 15) * 15`.
fn dayjs_utc_offset(off: i32) -> i64 {
    let tz_offset = -(off as f64);
    -(js_round(tz_offset / 15.0) as i64) * 15
}

fn zone_str(off: i32) -> String {
    let neg_minutes = -dayjs_utc_offset(off);
    let minutes = neg_minutes.abs();
    format!(
        "{}{}:{}",
        if neg_minutes <= 0 { '+' } else { '-' },
        pad_start(&(minutes / 60).to_string(), 2, '0'),
        pad_start(&(minutes % 60).to_string(), 2, '0')
    )
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

/// Length of a `\[([^\]]+)]` match at `i`, if any.
fn bracket_len(s: &[char], i: usize) -> Option<usize> {
    if s.get(i) != Some(&'[') || s.get(i + 1).is_none_or(|c| *c == ']') {
        return None;
    }
    s[i + 1..].iter().position(|c| *c == ']').map(|p| p + 2)
}

fn run_len(s: &[char], i: usize, c: char, max: usize) -> usize {
    s[i..].iter().take(max).take_while(|x| **x == c).count()
}

fn starts_with(s: &[char], i: usize, lit: &str) -> bool {
    (i..).zip(lit.chars()).all(|(j, c)| s.get(j) == Some(&c))
}

/// advancedFormat: `/\[([^\]]+)]|Q|wo|ww|w|WW|W|zzz|z|gggg|GGGG|Do|X|x|k{1,2}|S/`.
fn advanced_token_len(s: &[char], i: usize) -> Option<usize> {
    if let Some(n) = bracket_len(s, i) {
        return Some(n);
    }
    for lit in [
        "Q", "wo", "ww", "w", "WW", "W", "zzz", "z", "gggg", "GGGG", "Do", "X", "x",
    ] {
        if starts_with(s, i, lit) {
            return Some(lit.chars().count());
        }
    }
    match s[i] {
        'k' => Some(run_len(s, i, 'k', 2)),
        'S' => Some(1),
        _ => None,
    }
}

/// dayjs core: `/\[([^\]]+)]|YYYY|YY|M{1,4}|D{1,2}|d{1,4}|H{1,2}|h{1,2}|a|A|m{1,2}|s{1,2}|Z{1,2}|SSS/`.
fn core_token_len(s: &[char], i: usize) -> Option<usize> {
    if let Some(n) = bracket_len(s, i) {
        return Some(n);
    }
    match s[i] {
        'Y' => {
            let n = run_len(s, i, 'Y', 4);
            if n == 4 {
                Some(4)
            } else if n >= 2 {
                Some(2)
            } else {
                None
            }
        }
        'M' => Some(run_len(s, i, 'M', 4)),
        'D' | 'H' | 'h' | 'm' | 's' | 'Z' => Some(run_len(s, i, s[i], 2)),
        'd' => Some(run_len(s, i, 'd', 4)),
        'a' | 'A' => Some(1),
        'S' if run_len(s, i, 'S', 3) == 3 => Some(3),
        _ => None,
    }
}

fn replace_tokens<F>(
    input: &str,
    token_len: fn(&[char], usize) -> Option<usize>,
    mut f: F,
) -> Result<String, FormatError>
where
    F: FnMut(&str) -> Result<String, FormatError>,
{
    let s: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < s.len() {
        match token_len(&s, i) {
            Some(n) if n > 0 => {
                let tok: String = s[i..i + n].iter().collect();
                out.push_str(&f(&tok)?);
                i += n;
            }
            _ => {
                out.push(s[i]);
                i += 1;
            }
        }
    }
    Ok(out)
}

/// `dayjs#format(fmt)` with advancedFormat, isoWeek and weekOfYear loaded.
/// Returns `Err` where dayjs throws (the `z`, `zzz` and `gggg` tokens).
pub fn try_format(dt: &DateTime, fmt: &str) -> Result<String, FormatError> {
    if !dt.is_valid() {
        return Ok(INVALID_DATE.to_string());
    }
    let off = dt.offset_minutes;
    let t = dt.ms;
    let f = dt.fields();
    let fmt = if fmt.is_empty() { DEFAULT_FORMAT } else { fmt };

    let pass1 = replace_tokens(fmt, advanced_token_len, |tok| {
        Ok(match tok {
            "Q" => num_str(((f.month + 1.0) / 3.0).ceil()),
            "Do" => ordinal(f.date),
            "gggg" => return Err(FormatError::MissingPlugin("weekYear")),
            "GGGG" => num_str(iso_week_year(t, off)),
            "wo" => ordinal(week_of_year(t, off, 0)),
            "w" | "ww" => pad_start(
                &num_str(week_of_year(t, off, 0)),
                if tok == "w" { 1 } else { 2 },
                '0',
            ),
            "W" | "WW" => pad_start(
                &num_str(iso_week(t, off)),
                if tok == "W" { 1 } else { 2 },
                '0',
            ),
            "k" | "kk" => pad_start(
                &num_str(if f.hour == 0.0 { 24.0 } else { f.hour }),
                tok.len(),
                '0',
            ),
            "X" => num_str((t / 1000.0).floor()),
            "x" => num_str(t),
            "z" | "zzz" => return Err(FormatError::MissingPlugin("timezone")),
            _ => tok.to_string(),
        })
    })?;

    let zone = zone_str(off);
    let hour12 = {
        let h = f.hour % 12.0;
        if h == 0.0 {
            12.0
        } else {
            h
        }
    };
    replace_tokens(&pass1, core_token_len, |tok| {
        if tok.starts_with('[') {
            return Ok(tok[1..tok.len() - 1].to_string());
        }
        Ok(match tok {
            "YY" => {
                let y: Vec<char> = num_str(f.year).chars().collect();
                y[y.len().saturating_sub(2)..].iter().collect()
            }
            "YYYY" => pad_start(&num_str(f.year), 4, '0'),
            "M" => num_str(f.month + 1.0),
            "MM" => pad_start(&num_str(f.month + 1.0), 2, '0'),
            "MMM" => MONTHS[f.month as usize][..3].to_string(),
            "MMMM" => MONTHS[f.month as usize].to_string(),
            "D" => num_str(f.date),
            "DD" => pad_start(&num_str(f.date), 2, '0'),
            "d" => num_str(f.weekday),
            "dd" => WEEKDAYS[f.weekday as usize][..2].to_string(),
            "ddd" => WEEKDAYS[f.weekday as usize][..3].to_string(),
            "dddd" => WEEKDAYS[f.weekday as usize].to_string(),
            "H" => num_str(f.hour),
            "HH" => pad_start(&num_str(f.hour), 2, '0'),
            "h" => num_str(hour12),
            "hh" => pad_start(&num_str(hour12), 2, '0'),
            "a" => if f.hour < 12.0 { "am" } else { "pm" }.to_string(),
            "A" => if f.hour < 12.0 { "AM" } else { "PM" }.to_string(),
            "m" => num_str(f.minute),
            "mm" => pad_start(&num_str(f.minute), 2, '0'),
            "s" => num_str(f.second),
            "ss" => pad_start(&num_str(f.second), 2, '0'),
            "SSS" => pad_start(&num_str(f.ms), 3, '0'),
            "Z" => zone.clone(),
            _ => zone.replacen(':', "", 1), // ZZ
        })
    })
}

/// `dayjs#format(fmt)`; an empty format means `YYYY-MM-DDTHH:mm:ssZ`.
/// Where dayjs throws (see [`try_format`]) this returns an empty string.
pub fn format(dt: &DateTime, fmt: &str) -> String {
    try_format(dt, fmt).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Adding.
// ---------------------------------------------------------------------------

/// dayjs `Utils.p`.
fn pretty_unit(u: &str) -> String {
    match u {
        "M" => "month".into(),
        "y" => "year".into(),
        "w" => "week".into(),
        "d" => "day".into(),
        "D" => "date".into(),
        "h" => "hour".into(),
        "m" => "minute".into(),
        "s" => "second".into(),
        "ms" => "millisecond".into(),
        "Q" => "quarter".into(),
        _ => {
            let mut l = u.to_lowercase();
            if l.ends_with('s') {
                l.pop();
            }
            l
        }
    }
}

/// `dayjs#add(amount, unit)` (use a negative amount for `subtract`).
/// Returns `None` if the input is invalid or the result leaves the
/// ECMAScript date range. Units dayjs does not know add milliseconds.
pub fn add(dt: &DateTime, amount: i64, unit: &str) -> Option<DateTime> {
    if !dt.is_valid() {
        return None;
    }
    let n = amount as f64;
    let off = dt.offset_minutes;
    let t = dt.ms;
    let f = dt.fields();
    let ms = match pretty_unit(unit).as_str() {
        "month" => dayjs_set_month_or_year(t, off, true, f.month + n),
        "year" => dayjs_set_month_or_year(t, off, false, f.year + n),
        "day" => add_days(t, off, n),
        "week" => add_days(t, off, 7.0 * n),
        "minute" => time_clip(t + n * MS_PER_MINUTE),
        "hour" => time_clip(t + n * MS_PER_HOUR),
        "second" => time_clip(t + n * MS_PER_SECOND),
        _ => time_clip(t + n),
    };
    let out = DateTime::from_epoch_ms(ms, off);
    out.is_valid().then_some(out)
}

// ---------------------------------------------------------------------------
// dayjs(string).
// ---------------------------------------------------------------------------

fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

#[derive(Clone, Copy)]
enum ReClass {
    Digit,
    DashSlash,
    TSpace,
    Colon,
    DotColon,
}

impl ReClass {
    fn matches(self, c: char) -> bool {
        match self {
            ReClass::Digit => c.is_ascii_digit(),
            ReClass::DashSlash => c == '-' || c == '/',
            ReClass::TSpace => c == 'T' || c == 't' || is_js_space(c),
            ReClass::Colon => c == ':',
            ReClass::DotColon => c == '.' || c == ':',
        }
    }
}

struct ReNode {
    class: ReClass,
    min: usize,
    max: usize,
    capture: Option<usize>,
    optional_group: bool,
}

const fn re(
    class: ReClass,
    min: usize,
    max: usize,
    capture: Option<usize>,
    optional_group: bool,
) -> ReNode {
    ReNode {
        class,
        min,
        max,
        capture,
        optional_group,
    }
}

/// `/^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$/`
const REGEX_PARSE: [ReNode; 13] = [
    re(ReClass::Digit, 4, 4, Some(1), false),
    re(ReClass::DashSlash, 0, 1, None, false),
    re(ReClass::Digit, 1, 2, Some(2), true),
    re(ReClass::DashSlash, 0, 1, None, false),
    re(ReClass::Digit, 0, 2, Some(3), false),
    re(ReClass::TSpace, 0, usize::MAX, None, false),
    re(ReClass::Digit, 1, 2, Some(4), true),
    re(ReClass::Colon, 0, 1, None, false),
    re(ReClass::Digit, 1, 2, Some(5), true),
    re(ReClass::Colon, 0, 1, None, false),
    re(ReClass::Digit, 1, 2, Some(6), true),
    re(ReClass::DotColon, 0, 1, None, false),
    re(ReClass::Digit, 1, usize::MAX, Some(7), true),
];

type Captures = [Option<(usize, usize)>; 8];

fn regex_parse_at(s: &[char], pos: usize, idx: usize, caps: &mut Captures) -> bool {
    let Some(node) = REGEX_PARSE.get(idx) else {
        return pos == s.len();
    };
    let avail = s[pos..]
        .iter()
        .take(node.max)
        .take_while(|c| node.class.matches(**c))
        .count();
    if avail >= node.min {
        for k in (node.min..=avail).rev() {
            let saved = *caps;
            if let Some(c) = node.capture {
                caps[c] = Some((pos, pos + k));
            }
            if regex_parse_at(s, pos + k, idx + 1, caps) {
                return true;
            }
            *caps = saved;
        }
    }
    if node.optional_group {
        let saved = *caps;
        if let Some(c) = node.capture {
            caps[c] = None;
        }
        if regex_parse_at(s, pos, idx + 1, caps) {
            return true;
        }
        *caps = saved;
    }
    false
}

fn regex_parse(s: &[char]) -> Option<Captures> {
    if s.len() < 4
        || !s.iter().all(|c| {
            c.is_ascii_digit() || matches!(c, '-' | '/' | ':' | '.' | 'T' | 't') || is_js_space(*c)
        })
    {
        return None;
    }
    let mut caps: Captures = [None; 8];
    regex_parse_at(s, 0, 0, &mut caps).then_some(caps)
}

/// `dayjs(input)` for a string: dayjs's `REGEX_PARSE` in local time unless
/// the string ends in `Z`, otherwise `new Date(input)`. `None` when dayjs
/// would be invalid.
pub fn parse(input: &str, offset_minutes: i32) -> Option<DateTime> {
    let off = offset_minutes;
    let chars: Vec<char> = input.chars().collect();
    let ends_with_z = matches!(chars.last(), Some('z' | 'Z'));
    let caps = if ends_with_z {
        None
    } else {
        regex_parse(&chars)
    };
    let ms = if let Some(caps) = caps {
        let group =
            |i: usize| -> Option<String> { caps[i].map(|(a, b)| chars[a..b].iter().collect()) };
        let num = |s: &str| -> f64 { s.parse::<f64>().unwrap_or(0.0) };
        let year = num(&group(1).unwrap_or_default());
        // d[2] - 1 || 0
        let month = match group(2) {
            Some(m) => num(&m) - 1.0,
            None => 0.0,
        };
        // d[3] || 1  ("" is falsy, "0" is not)
        let day = match group(3) {
            Some(d) if !d.is_empty() => num(&d),
            _ => 1.0,
        };
        let h = group(4).map_or(0.0, |v| num(&v));
        let mi = group(5).map_or(0.0, |v| num(&v));
        let s = group(6).map_or(0.0, |v| num(&v));
        let ms = group(7).map_or(0.0, |v| num(&v.chars().take(3).collect::<String>()));
        new_date_local(year, month, day, h, mi, s, ms, off)
    } else {
        v8::parse(&chars, off)
    };
    let dt = DateTime::from_epoch_ms(ms, off);
    dt.is_valid().then_some(dt)
}

// ---------------------------------------------------------------------------
// V8's Date string parser (src/date/dateparser*.{h,cc}).
// ---------------------------------------------------------------------------

mod v8 {
    use super::{local_to_utc, make_date, make_day, make_time, time_clip, MAX_TIME_MS};

    const NONE: i32 = i32::MAX;
    const MAX_SIGNIFICANT_DIGITS: usize = 9;

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Kw {
        Invalid,
        MonthName,
        TimeZoneName,
        TimeSeparator,
        AmPm,
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Tok {
        Invalid,
        Unknown,
        WhiteSpace,
        End,
        Number { n: i32, len: usize },
        Symbol(char),
        Keyword { kw: Kw, value: i32, len: usize },
    }

    impl Tok {
        fn is_number(self) -> bool {
            matches!(self, Tok::Number { .. })
        }
        fn is_fixed_number(self, l: usize) -> bool {
            matches!(self, Tok::Number { len, .. } if len == l)
        }
        fn number(self) -> i32 {
            match self {
                Tok::Number { n, .. } => n,
                _ => 0,
            }
        }
        fn is_symbol(self, c: char) -> bool {
            self == Tok::Symbol(c)
        }
        fn is_sign(self) -> bool {
            self.is_symbol('+') || self.is_symbol('-')
        }
        fn is_keyword_type(self, k: Kw) -> bool {
            matches!(self, Tok::Keyword { kw, .. } if kw == k)
        }
        fn is_keyword_z(self) -> bool {
            matches!(
                self,
                Tok::Keyword {
                    kw: Kw::TimeZoneName,
                    value: 0,
                    len: 1
                }
            )
        }
    }

    const KEYWORDS: [(&[u8; 3], Kw, i32); 27] = [
        (b"jan", Kw::MonthName, 1),
        (b"feb", Kw::MonthName, 2),
        (b"mar", Kw::MonthName, 3),
        (b"apr", Kw::MonthName, 4),
        (b"may", Kw::MonthName, 5),
        (b"jun", Kw::MonthName, 6),
        (b"jul", Kw::MonthName, 7),
        (b"aug", Kw::MonthName, 8),
        (b"sep", Kw::MonthName, 9),
        (b"oct", Kw::MonthName, 10),
        (b"nov", Kw::MonthName, 11),
        (b"dec", Kw::MonthName, 12),
        (b"am\0", Kw::AmPm, 0),
        (b"pm\0", Kw::AmPm, 12),
        (b"ut\0", Kw::TimeZoneName, 0),
        (b"utc", Kw::TimeZoneName, 0),
        (b"z\0\0", Kw::TimeZoneName, 0),
        (b"gmt", Kw::TimeZoneName, 0),
        (b"cdt", Kw::TimeZoneName, -5),
        (b"cst", Kw::TimeZoneName, -6),
        (b"edt", Kw::TimeZoneName, -4),
        (b"est", Kw::TimeZoneName, -5),
        (b"mdt", Kw::TimeZoneName, -6),
        (b"mst", Kw::TimeZoneName, -7),
        (b"pdt", Kw::TimeZoneName, -7),
        (b"pst", Kw::TimeZoneName, -8),
        (b"t\0\0", Kw::TimeSeparator, 0),
    ];

    fn is_white_space(c: char) -> bool {
        matches!(
            c,
            '\t' | '\u{0B}' | '\u{0C}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
        )
    }

    fn is_white_space_or_lt(c: char) -> bool {
        is_white_space(c) || matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
    }

    struct Scanner<'a> {
        s: &'a [char],
        index: usize,
        ch: char,
        next: Tok,
    }

    impl<'a> Scanner<'a> {
        fn new(s: &'a [char]) -> Self {
            let mut sc = Scanner {
                s,
                index: 0,
                ch: '\0',
                next: Tok::End,
            };
            sc.advance();
            sc.next = sc.scan();
            sc
        }

        fn advance(&mut self) {
            self.ch = self.s.get(self.index).copied().unwrap_or('\0');
            self.index += 1;
        }

        fn skip(&mut self, c: char) -> bool {
            if self.ch == c {
                self.advance();
                true
            } else {
                false
            }
        }

        fn scan(&mut self) -> Tok {
            let pre = self.index;
            if self.ch == '\0' {
                return Tok::End;
            }
            if self.ch.is_ascii_digit() {
                let mut n: i32 = 0;
                let mut i = 0;
                while self.ch == '0' {
                    self.advance();
                }
                while self.ch.is_ascii_digit() {
                    if i < MAX_SIGNIFICANT_DIGITS {
                        n = n * 10 + (self.ch as i32 - '0' as i32);
                    }
                    i += 1;
                    self.advance();
                }
                return Tok::Number {
                    n,
                    len: self.index - pre,
                };
            }
            for c in [':', '-', '+', '.', ')'] {
                if self.skip(c) {
                    return Tok::Symbol(c);
                }
            }
            if self.ch >= 'A' && !is_white_space(self.ch) {
                let mut prefix = [0u32; 3];
                let mut len = 0;
                while self.ch >= 'A' && !is_white_space(self.ch) {
                    if len < 3 {
                        prefix[len] = self.ch as u32 | 0x20;
                    }
                    len += 1;
                    self.advance();
                }
                let (kw, value) = KEYWORDS
                    .iter()
                    .find(|(p, kw, _)| {
                        p.iter().zip(prefix).all(|(a, b)| *a as u32 == b)
                            && (len <= 3 || *kw == Kw::MonthName)
                    })
                    .map_or((Kw::Invalid, 0), |(_, kw, v)| (*kw, *v));
                return Tok::Keyword { kw, value, len };
            }
            if is_white_space_or_lt(self.ch) {
                self.advance();
                return Tok::WhiteSpace;
            }
            if self.ch == '(' {
                let mut balance = 0;
                loop {
                    if self.ch == ')' {
                        balance -= 1;
                    } else if self.ch == '(' {
                        balance += 1;
                    }
                    self.advance();
                    if !(balance > 0 && self.ch != '\0') {
                        break;
                    }
                }
                return Tok::Unknown;
            }
            self.advance();
            Tok::Unknown
        }

        fn next(&mut self) -> Tok {
            let t = self.next;
            self.next = self.scan();
            t
        }

        fn peek(&self) -> Tok {
            self.next
        }

        fn skip_symbol(&mut self, c: char) -> bool {
            if self.next.is_symbol(c) {
                self.next();
                true
            } else {
                false
            }
        }
    }

    fn between(x: i32, lo: i32, hi: i32) -> bool {
        x >= lo && x <= hi
    }
    fn is_month(x: i32) -> bool {
        between(x, 1, 12)
    }
    fn is_day(x: i32) -> bool {
        between(x, 1, 31)
    }
    fn is_hour(x: i32) -> bool {
        between(x, 0, 23)
    }
    fn is_minute(x: i32) -> bool {
        between(x, 0, 59)
    }

    struct Day {
        comp: [i32; 3],
        index: usize,
        named_month: i32,
        is_iso: bool,
    }

    impl Day {
        fn add(&mut self, n: i32) -> bool {
            if self.index < 3 {
                self.comp[self.index] = n;
                self.index += 1;
                true
            } else {
                false
            }
        }

        fn write(&mut self) -> Option<(i32, i32, i32)> {
            if self.index < 1 {
                return None;
            }
            while self.index < 3 {
                self.comp[self.index] = 1;
                self.index += 1;
            }
            let mut year;
            let month;
            let day;
            if self.named_month == NONE {
                if self.is_iso || !is_day(self.comp[0]) {
                    year = self.comp[0];
                    month = self.comp[1];
                    day = self.comp[2];
                } else {
                    month = self.comp[0];
                    day = self.comp[1];
                    year = self.comp[2];
                }
            } else {
                month = self.named_month;
                if !is_day(self.comp[0]) {
                    year = self.comp[0];
                    day = self.comp[1];
                } else {
                    day = self.comp[0];
                    year = self.comp[1];
                }
            }
            if !self.is_iso {
                if between(year, 0, 49) {
                    year += 2000;
                } else if between(year, 50, 99) {
                    year += 1900;
                }
            }
            if !is_month(month) || !is_day(day) {
                return None;
            }
            Some((year, month - 1, day))
        }
    }

    struct Time {
        comp: [i32; 4],
        index: usize,
        hour_offset: i32,
    }

    impl Time {
        fn is_empty(&self) -> bool {
            self.index == 0
        }
        fn is_expecting(&self, n: i32) -> bool {
            (self.index == 1 && is_minute(n))
                || (self.index == 2 && is_minute(n))
                || (self.index == 3 && between(n, 0, 999))
        }
        fn add(&mut self, n: i32) -> bool {
            if self.index < 4 {
                self.comp[self.index] = n;
                self.index += 1;
                true
            } else {
                false
            }
        }
        fn add_final(&mut self, n: i32) -> bool {
            if !self.add(n) {
                return false;
            }
            while self.index < 4 {
                self.comp[self.index] = 0;
                self.index += 1;
            }
            true
        }
        fn write(&mut self) -> Option<[i32; 4]> {
            while self.index < 4 {
                self.comp[self.index] = 0;
                self.index += 1;
            }
            let [mut hour, minute, second, ms] = self.comp;
            if self.hour_offset != NONE {
                if !between(hour, 0, 12) {
                    return None;
                }
                hour %= 12;
                hour += self.hour_offset;
            }
            if !(is_hour(hour) && is_minute(minute) && is_minute(second) && between(ms, 0, 999))
                && (hour != 24 || minute != 0 || second != 0 || ms != 0)
            {
                return None;
            }
            Some([hour, minute, second, ms])
        }
    }

    struct Tz {
        sign: i32,
        hour: i32,
        minute: i32,
    }

    impl Tz {
        fn set(&mut self, offset_hours: i32) {
            self.sign = if offset_hours < 0 { -1 } else { 1 };
            self.hour = offset_hours * self.sign;
            self.minute = 0;
        }
        fn set_sign(&mut self, sign: i32) {
            self.sign = if sign < 0 { -1 } else { 1 };
        }
        fn is_expecting(&self, n: i32) -> bool {
            self.hour != NONE && self.minute == NONE && is_minute(n)
        }
        fn is_utc(&self) -> bool {
            self.hour == 0 && self.minute == 0
        }
        fn is_empty(&self) -> bool {
            self.hour == NONE
        }
        /// `Some(Some(seconds))` for an explicit offset, `Some(None)` for
        /// local time, `None` when V8 rejects the offset. V8 computes the
        /// magnitude in wrapping 32-bit arithmetic and rejects it when the
        /// wrapped value is negative (checked against Node 26).
        fn write(&mut self) -> Option<Option<f64>> {
            if self.sign == NONE {
                return Some(None);
            }
            if self.hour == NONE {
                self.hour = 0;
            }
            if self.minute == NONE {
                self.minute = 0;
            }
            let magnitude = self
                .hour
                .wrapping_mul(3600)
                .wrapping_add(self.minute.wrapping_mul(60));
            if magnitude < 0 {
                return None;
            }
            Some(Some(self.sign as f64 * magnitude as f64))
        }
    }

    fn read_milliseconds(tok: Tok) -> i32 {
        let (mut number, mut length) = match tok {
            Tok::Number { n, len } => (n, len),
            _ => return 0,
        };
        if length == 1 {
            number *= 100;
        } else if length == 2 {
            number *= 10;
        } else if length > 3 {
            if length > MAX_SIGNIFICANT_DIGITS {
                length = MAX_SIGNIFICANT_DIGITS;
            }
            let mut factor = 1;
            loop {
                factor *= 10;
                length -= 1;
                if length <= 3 {
                    break;
                }
            }
            number /= factor;
        }
        number
    }

    fn parse_es5(sc: &mut Scanner, day: &mut Day, time: &mut Time, tz: &mut Tz) -> Tok {
        if sc.peek().is_sign() {
            let sign_token = sc.next();
            if !sc.peek().is_fixed_number(6) {
                return sign_token;
            }
            let sign = if sign_token.is_symbol('+') { 1 } else { -1 };
            let year = sc.next().number();
            if sign < 0 && year == 0 {
                return sign_token;
            }
            day.add(sign * year);
        } else if sc.peek().is_fixed_number(4) {
            let n = sc.next().number();
            day.add(n);
        } else {
            return sc.next();
        }
        if sc.skip_symbol('-') {
            if !sc.peek().is_fixed_number(2) || !is_month(sc.peek().number()) {
                return sc.next();
            }
            let n = sc.next().number();
            day.add(n);
            if sc.skip_symbol('-') {
                if !sc.peek().is_fixed_number(2) || !is_day(sc.peek().number()) {
                    return sc.next();
                }
                let n = sc.next().number();
                day.add(n);
            }
        }
        if !sc.peek().is_keyword_type(Kw::TimeSeparator) {
            if sc.peek() != Tok::End {
                return sc.next();
            }
        } else {
            sc.next();
            if !sc.peek().is_fixed_number(2) || !between(sc.peek().number(), 0, 24) {
                return Tok::Invalid;
            }
            let hour_is_24 = sc.peek().number() == 24;
            let n = sc.next().number();
            time.add(n);
            if !sc.skip_symbol(':') {
                return Tok::Invalid;
            }
            if !sc.peek().is_fixed_number(2)
                || !is_minute(sc.peek().number())
                || (hour_is_24 && sc.peek().number() > 0)
            {
                return Tok::Invalid;
            }
            let n = sc.next().number();
            time.add(n);
            if sc.skip_symbol(':') {
                if !sc.peek().is_fixed_number(2)
                    || !is_minute(sc.peek().number())
                    || (hour_is_24 && sc.peek().number() > 0)
                {
                    return Tok::Invalid;
                }
                let n = sc.next().number();
                time.add(n);
                if sc.skip_symbol('.') {
                    if !sc.peek().is_number() || (hour_is_24 && sc.peek().number() > 0) {
                        return Tok::Invalid;
                    }
                    let ms = read_milliseconds(sc.next());
                    time.add(ms);
                }
            }
            if sc.peek().is_keyword_z() {
                sc.next();
                tz.set(0);
            } else if sc.peek().is_sign() {
                let sign = if sc.next().is_symbol('+') { 1 } else { -1 };
                tz.set_sign(sign);
                if sc.peek().is_fixed_number(4) {
                    let hourmin = sc.next().number();
                    let (hour, min) = (hourmin / 100, hourmin % 100);
                    if !is_hour(hour) || !is_minute(min) {
                        return Tok::Invalid;
                    }
                    tz.hour = hour;
                    tz.minute = min;
                } else {
                    if !sc.peek().is_fixed_number(2) || !is_hour(sc.peek().number()) {
                        return Tok::Invalid;
                    }
                    tz.hour = sc.next().number();
                    if !sc.skip_symbol(':') {
                        return Tok::Invalid;
                    }
                    if !sc.peek().is_fixed_number(2) || !is_minute(sc.peek().number()) {
                        return Tok::Invalid;
                    }
                    tz.minute = sc.next().number();
                }
            }
            if sc.peek() != Tok::End {
                return Tok::Invalid;
            }
        }
        if tz.is_empty() && time.is_empty() {
            tz.set(0);
        }
        day.is_iso = true;
        Tok::End
    }

    /// `new Date(string)` as a time value (NaN when invalid).
    pub(super) fn parse(s: &[char], off: i32) -> f64 {
        let mut sc = Scanner::new(s);
        let mut day = Day {
            comp: [0; 3],
            index: 0,
            named_month: NONE,
            is_iso: false,
        };
        let mut time = Time {
            comp: [0; 4],
            index: 0,
            hour_offset: NONE,
        };
        let mut tz = Tz {
            sign: NONE,
            hour: NONE,
            minute: NONE,
        };

        let first = parse_es5(&mut sc, &mut day, &mut time, &mut tz);
        if first == Tok::Invalid {
            return f64::NAN;
        }
        let mut has_read_number = day.index != 0;
        let mut token = first;
        while token != Tok::End {
            match token {
                Tok::Number { n, .. } => {
                    has_read_number = true;
                    if sc.skip_symbol(':') {
                        if sc.skip_symbol(':') {
                            if !time.is_empty() {
                                return f64::NAN;
                            }
                            time.add(n);
                            time.add(0);
                        } else {
                            if !time.add(n) {
                                return f64::NAN;
                            }
                            if sc.peek().is_symbol('.') {
                                sc.next();
                            }
                        }
                    } else if sc.skip_symbol('.') && time.is_expecting(n) {
                        time.add(n);
                        if !sc.peek().is_number() {
                            return f64::NAN;
                        }
                        let ms = read_milliseconds(sc.next());
                        if ms < 0 {
                            return f64::NAN;
                        }
                        time.add_final(ms);
                    } else if tz.is_expecting(n) {
                        tz.minute = n;
                    } else if time.is_expecting(n) {
                        time.add_final(n);
                        let peek = sc.peek();
                        if !(peek == Tok::End
                            || peek == Tok::WhiteSpace
                            || peek.is_keyword_z()
                            || peek.is_sign())
                        {
                            return f64::NAN;
                        }
                    } else {
                        if !day.add(n) {
                            return f64::NAN;
                        }
                        sc.skip_symbol('-');
                    }
                }
                Tok::Keyword { kw, value, .. } => {
                    if kw == Kw::AmPm && !time.is_empty() {
                        time.hour_offset = value;
                    } else if kw == Kw::MonthName {
                        day.named_month = value;
                        sc.skip_symbol('-');
                    } else if kw == Kw::TimeZoneName && has_read_number {
                        tz.set(value);
                    } else {
                        if has_read_number {
                            return f64::NAN;
                        }
                        if sc.peek().is_number() {
                            return f64::NAN;
                        }
                    }
                }
                t if t.is_sign() && (tz.is_utc() || !time.is_empty()) => {
                    tz.set_sign(if t.is_symbol('+') { 1 } else { -1 });
                    let mut n = 0;
                    let mut length = 0;
                    if let Tok::Number { n: v, len } = sc.peek() {
                        sc.next();
                        n = v;
                        length = len;
                    }
                    has_read_number = true;
                    if sc.peek().is_symbol(':') {
                        tz.hour = n;
                        tz.minute = NONE;
                    } else if length == 1 || length == 2 {
                        tz.hour = n;
                        tz.minute = 0;
                    } else if length == 3 || length == 4 {
                        tz.hour = n / 100;
                        tz.minute = n % 100;
                    } else {
                        return f64::NAN;
                    }
                }
                t if (t.is_sign() || t.is_symbol(')')) && has_read_number => return f64::NAN,
                _ => {}
            }
            token = sc.next();
        }

        let Some((year, month, date)) = day.write() else {
            return f64::NAN;
        };
        let Some([h, mi, sec, ms]) = time.write() else {
            return f64::NAN;
        };
        let Some(offset) = tz.write() else {
            return f64::NAN;
        };
        let t = make_date(
            make_day(year as f64, month as f64, date as f64),
            make_time(h as f64, mi as f64, sec as f64, ms as f64),
        );
        match offset {
            None => local_to_utc(t, off),
            Some(secs) => {
                let t = t - secs * 1000.0;
                if !(-MAX_TIME_MS..=MAX_TIME_MS).contains(&t) {
                    return f64::NAN;
                }
                time_clip(t)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// customParseFormat: dayjs(input, format, strict).
// ---------------------------------------------------------------------------

fn utf16_is_digit(c: u16) -> bool {
    (b'0' as u16..=b'9' as u16).contains(&c)
}

fn utf16_is_space(c: u16) -> bool {
    char::from_u32(c as u32).is_some_and(is_js_space)
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Matcher {
    One,
    Two,
    Three,
    Four,
    OneToTwo,
    Signed,
    Offset,
    Word,
}

impl Matcher {
    /// Leftmost match of the plugin's (unanchored) regex: (start, length).
    fn find(self, s: &[u16]) -> Option<(usize, usize)> {
        let digit_at = |i: usize| s.get(i).copied().is_some_and(utf16_is_digit);
        let fixed = |n: usize| {
            (0..s.len())
                .find(|&i| (i..i + n).all(digit_at))
                .map(|i| (i, n))
        };
        match self {
            Matcher::One => fixed(1),
            Matcher::Two => fixed(2),
            Matcher::Three => fixed(3),
            Matcher::Four => fixed(4),
            Matcher::OneToTwo => fixed(1).map(|(i, _)| (i, if digit_at(i + 1) { 2 } else { 1 })),
            Matcher::Signed => (0..s.len()).find_map(|i| {
                let start_digits =
                    if (s[i] == b'+' as u16 || s[i] == b'-' as u16) && digit_at(i + 1) {
                        i + 1
                    } else if digit_at(i) {
                        i
                    } else {
                        return None;
                    };
                let end = (start_digits..s.len())
                    .find(|&j| !digit_at(j))
                    .unwrap_or(s.len());
                Some((i, end - i))
            }),
            Matcher::Offset => (0..s.len()).find_map(|i| {
                if (s[i] == b'+' as u16 || s[i] == b'-' as u16)
                    && digit_at(i + 1)
                    && digit_at(i + 2)
                {
                    let mut k = i + 3;
                    if s.get(k) == Some(&(b':' as u16)) {
                        k += 1;
                    }
                    if digit_at(k) && digit_at(k + 1) {
                        k += 2;
                    }
                    Some((i, k - i))
                } else if s[i] == b'Z' as u16 {
                    Some((i, 1))
                } else {
                    None
                }
            }),
            Matcher::Word => {
                let word_char = |c: u16| {
                    !utf16_is_digit(c)
                        && !utf16_is_space(c)
                        && !b"-_:/,()".iter().any(|b| *b as u16 == c)
                };
                (0..s.len()).find_map(|i| {
                    let j = (i..s.len()).find(|&j| !digit_at(j)).unwrap_or(s.len());
                    if j < s.len() && word_char(s[j]) {
                        let k = (j..s.len()).find(|&k| !word_char(s[k])).unwrap_or(s.len());
                        Some((i, k - i))
                    } else {
                        None
                    }
                })
            }
        }
    }
}

#[derive(Clone, PartialEq, Debug)]
enum ParseToken {
    Literal(usize),
    Expr(&'static str, Matcher),
}

fn expression(token: &str) -> Option<(&'static str, Matcher)> {
    use Matcher::*;
    const TABLE: [(&str, Matcher); 28] = [
        ("A", Word),
        ("a", Word),
        ("Q", One),
        ("S", One),
        ("SS", Two),
        ("SSS", Three),
        ("s", OneToTwo),
        ("ss", OneToTwo),
        ("m", OneToTwo),
        ("mm", OneToTwo),
        ("H", OneToTwo),
        ("h", OneToTwo),
        ("HH", OneToTwo),
        ("hh", OneToTwo),
        ("D", OneToTwo),
        ("DD", Two),
        ("Do", Word),
        ("w", OneToTwo),
        ("ww", Two),
        ("M", OneToTwo),
        ("MM", Two),
        ("MMM", Word),
        ("MMMM", Word),
        ("Y", Signed),
        ("YY", Two),
        ("YYYY", Four),
        ("Z", Offset),
        ("ZZ", Offset),
    ];
    TABLE.iter().find(|(name, _)| *name == token).copied()
}

/// `format.match(formattingTokens)`, then each token mapped as `makeParser`
/// does. `None` where the plugin would throw (no tokens at all).
fn make_parser(format: &[u16]) -> Option<Vec<ParseToken>> {
    let is = |i: usize, c: u8| format.get(i) == Some(&(c as u16));
    let run = |i: usize, c: u8, max: usize| {
        (i..format.len())
            .take(max)
            .take_while(|&j| is(j, c))
            .count()
    };
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < format.len() {
        // (\[[^[]*\])
        if is(i, b'[') {
            let run_end = (i + 1..format.len())
                .find(|&j| is(j, b'['))
                .unwrap_or(format.len());
            if let Some(k) = (i + 1..run_end).rev().find(|&k| is(k, b']')) {
                let inner = k - i - 1;
                tokens.push(ParseToken::Literal(inner));
                i = k + 1;
                continue;
            }
        }
        // ([-_:/.,()\s]+)
        let sep = |c: u16| b"-_:/.,()".iter().any(|b| *b as u16 == c) || utf16_is_space(c);
        let n = format[i..].iter().take_while(|c| sep(**c)).count();
        if n > 0 {
            tokens.push(ParseToken::Literal(n));
            i += n;
            continue;
        }
        let len = match format[i] {
            c if c == b'A' as u16 || c == b'a' as u16 || c == b'Q' as u16 || c == b'z' as u16 => 1,
            c if c == b'Y' as u16 => {
                let r = run(i, b'Y', 4);
                if r == 4 {
                    4
                } else {
                    r.min(2)
                }
            }
            c if c == b'w' as u16 => run(i, b'w', 2),
            c if c == b'M' as u16 => run(i, b'M', 4),
            c if c == b'D' as u16 => {
                if is(i + 1, b'o') {
                    2
                } else {
                    run(i, b'D', 2)
                }
            }
            c if c == b'h' as u16 => run(i, b'h', 2),
            c if c == b'H' as u16 => run(i, b'H', 2),
            c if c == b'm' as u16 => run(i, b'm', 2),
            c if c == b's' as u16 => run(i, b's', 2),
            c if c == b'S' as u16 => run(i, b'S', 3),
            c if c == b'Z' as u16 => run(i, b'Z', 2),
            _ => 0,
        };
        if len == 0 {
            i += 1;
            continue;
        }
        let tok = String::from_utf16_lossy(&format[i..i + len]);
        tokens.push(match expression(&tok) {
            Some((name, m)) => ParseToken::Expr(name, m),
            None => ParseToken::Literal(len),
        });
        i += len;
    }
    (!tokens.is_empty()).then_some(tokens)
}

/// localizedFormat's `u()` throws on an unbracketed `L…`/`l…` token because
/// the en locale has no `formats` object.
fn has_localized_token(format: &str) -> bool {
    let s: Vec<char> = format.chars().collect();
    let mut i = 0;
    while i < s.len() {
        if let Some(n) = bracket_len(&s, i) {
            i += n;
            continue;
        }
        if s[i] == 'L' || s[i] == 'l' {
            return true;
        }
        i += 1;
    }
    false
}

/// ECMAScript `StringToNumber`.
fn js_string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(is_js_space);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(rest) = t.strip_prefix(prefix) {
            if rest.is_empty() {
                return f64::NAN;
            }
            let mut v = 0.0;
            for c in rest.chars() {
                match c.to_digit(radix) {
                    Some(d) => v = v * radix as f64 + d as f64,
                    None => return f64::NAN,
                }
            }
            return v;
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let b = t.as_bytes();
    let mut i = usize::from(matches!(b[0], b'+' | b'-'));
    let int_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
    i += int_digits;
    let mut frac_digits = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        frac_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        i += frac_digits;
    }
    if int_digits + frac_digits == 0 {
        return f64::NAN;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let exp_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if exp_digits == 0 {
            return f64::NAN;
        }
        i += exp_digits;
    }
    if i != b.len() {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

#[derive(Default)]
struct Parsed {
    year: Option<f64>,
    month: Option<f64>,
    /// (numeric value, JS truthiness) — `Do` can store a digit string.
    day: Option<(f64, bool)>,
    hours: Option<f64>,
    minutes: Option<f64>,
    seconds: Option<f64>,
    milliseconds: Option<f64>,
    zone_offset: Option<f64>,
    week: Option<f64>,
    afternoon: Option<bool>,
}

fn truthy(v: Option<f64>) -> bool {
    v.is_some_and(|x| x != 0.0 && !x.is_nan())
}

fn to_num(s: &[u16]) -> f64 {
    js_string_to_number(&String::from_utf16_lossy(s))
}

/// Runs the parser; `None` where the plugin throws.
fn run_parser(tokens: &[ParseToken], input: &str) -> Option<Parsed> {
    let mut input: Vec<u16> = input.encode_utf16().collect();
    let mut p = Parsed::default();
    let mut start = 0usize;
    for tok in tokens {
        match tok {
            ParseToken::Literal(n) => start += n,
            ParseToken::Expr(name, matcher) => {
                let part = if start < input.len() {
                    &input[start..]
                } else {
                    &[][..]
                };
                let (i, len) = matcher.find(part)?;
                let value: Vec<u16> = part[i..i + len].to_vec();
                let text = String::from_utf16_lossy(&value);
                match *name {
                    "A" => p.afternoon = Some(text == "PM"),
                    "a" => p.afternoon = Some(text == "pm"),
                    "Q" => p.month = Some((to_num(&value) - 1.0) * 3.0 + 1.0),
                    "S" => p.milliseconds = Some(to_num(&value) * 100.0),
                    "SS" => p.milliseconds = Some(to_num(&value) * 10.0),
                    "SSS" => p.milliseconds = Some(to_num(&value)),
                    "s" | "ss" => p.seconds = Some(to_num(&value)),
                    "m" | "mm" => p.minutes = Some(to_num(&value)),
                    "H" | "h" | "HH" | "hh" => p.hours = Some(to_num(&value)),
                    "D" | "DD" => {
                        let v = to_num(&value);
                        p.day = Some((v, v != 0.0));
                    }
                    "Do" => {
                        let digits: String = text
                            .chars()
                            .skip_while(|c| !c.is_ascii_digit())
                            .take_while(|c| c.is_ascii_digit())
                            .collect();
                        if digits.is_empty() {
                            return None;
                        }
                        p.day = Some((js_string_to_number(&digits), true));
                        for d in 1..=31 {
                            if ordinal(d as f64).replace(['[', ']'], "") == text {
                                p.day = Some((d as f64, true));
                            }
                        }
                    }
                    "w" | "ww" => p.week = Some(to_num(&value)),
                    "M" | "MM" => p.month = Some(to_num(&value)),
                    "MMM" | "MMMM" => {
                        let idx = if *name == "MMM" {
                            MONTHS.iter().position(|m| m[..3] == text)
                        } else {
                            MONTHS.iter().position(|m| *m == text)
                        }?;
                        p.month = Some((idx + 1) as f64);
                    }
                    "Y" => p.year = Some(to_num(&value)),
                    "YY" => {
                        let v = to_num(&value);
                        p.year = Some(v + if v > 68.0 { 1900.0 } else { 2000.0 });
                    }
                    "YYYY" => p.year = Some(to_num(&value)),
                    _ => {
                        // Z / ZZ: offsetFromString
                        p.zone_offset = Some(if text == "Z" {
                            0.0
                        } else {
                            let digits: Vec<f64> = text
                                .as_bytes()
                                .chunks(1)
                                .filter(|c| c[0].is_ascii_digit())
                                .map(|c| (c[0] - b'0') as f64)
                                .collect();
                            let hours = digits[0] * 10.0 + digits[1];
                            let mins = if digits.len() >= 4 {
                                digits[2] * 10.0 + digits[3]
                            } else {
                                0.0
                            };
                            let minutes = hours * 60.0 + mins;
                            if minutes == 0.0 {
                                0.0
                            } else if text.starts_with('+') {
                                -minutes
                            } else {
                                minutes
                            }
                        });
                    }
                }
                // input = input.replace(value, '')
                if let Some(pos) = input
                    .windows(value.len())
                    .position(|w| w == value.as_slice())
                {
                    input.drain(pos..pos + value.len());
                }
            }
        }
    }
    // correctHours
    if let Some(afternoon) = p.afternoon {
        if afternoon {
            if let Some(h) = p.hours.as_mut() {
                if *h < 12.0 {
                    *h += 12.0;
                }
            }
        } else if p.hours == Some(12.0) {
            p.hours = Some(0.0);
        }
    }
    Some(p)
}

fn parse_formatted_input(input: &str, format: &str, off: i32, now_ms: f64) -> f64 {
    if format == "x" || format == "X" {
        let factor = if format == "X" { 1000.0 } else { 1.0 };
        return time_clip(factor * js_string_to_number(input));
    }
    if has_localized_token(format) {
        return f64::NAN;
    }
    let fmt16: Vec<u16> = format.encode_utf16().collect();
    let Some(tokens) = make_parser(&fmt16) else {
        return f64::NAN;
    };
    let Some(p) = run_parser(&tokens, input) else {
        return f64::NAN;
    };
    let now = fields_at(now_ms, off);
    let year_t = truthy(p.year);
    let month_t = truthy(p.month);
    let d = match p.day {
        Some((v, true)) => v,
        _ if !year_t && !month_t => now.date,
        _ => 1.0,
    };
    let y = if year_t {
        p.year.unwrap_or(0.0)
    } else {
        now.year
    };
    let m_index = if year_t && !month_t {
        0.0
    } else {
        match p.month {
            Some(m) if m > 0.0 => m - 1.0,
            _ => now.month,
        }
    };
    let or0 = |v: Option<f64>| if truthy(v) { v.unwrap_or(0.0) } else { 0.0 };
    let (h, mi, s, ms) = (
        or0(p.hours),
        or0(p.minutes),
        or0(p.seconds),
        or0(p.milliseconds),
    );
    if let Some(zone) = p.zone_offset {
        return date_utc(y, m_index, d, h, mi, s, ms + zone * 60.0 * 1000.0);
    }
    let mut t = new_date_local(y, m_index, d, h, mi, s, ms, off);
    if truthy(p.week) {
        let w = p.week.unwrap_or(0.0);
        t = add_days(t, off, (w - week_of_year(t, off, 0)) * 7.0);
    }
    t
}

/// `dayjs(input, format, strict)` with customParseFormat, taking "now" (used
/// when the format has no year, month or day) as epoch milliseconds.
pub fn parse_with_format_at(
    input: &str,
    format: &str,
    strict: bool,
    offset_minutes: i32,
    now_ms: f64,
) -> Option<DateTime> {
    let ms = parse_formatted_input(input, format, offset_minutes, now_ms);
    let dt = DateTime::from_epoch_ms(ms, offset_minutes);
    if strict {
        // `date != this.format(format)`; a throwing format throws out of dayjs.
        match try_format(&dt, format) {
            Ok(s) if s == input => {}
            _ => return None,
        }
    }
    dt.is_valid().then_some(dt)
}

/// `dayjs(input, format, strict)` with customParseFormat. "Now" is the Unix
/// epoch; use [`parse_with_format_at`] when the format may omit the date.
pub fn parse_with_format(
    input: &str,
    format: &str,
    strict: bool,
    offset_minutes: i32,
) -> Option<DateTime> {
    parse_with_format_at(input, format, strict, offset_minutes, 0.0)
}

#[cfg(test)]
mod tests {
    //! Expected values come from dayjs 1.11.23 on Node 26 with the four Knap
    //! plugins, "local time" pinned by a fixed zone, and `new Date()` patched
    //! to 2026-09-13T12:00:00Z for the `now` fallbacks:
    //!
    //! ```text
    //! TZ=UTC          node tests.js 0
    //! TZ=Etc/GMT-8    node tests.js 480
    //! TZ=Etc/GMT+5    node tests.js -300
    //! TZ=Asia/Kolkata node tests.js 330
    //! ```
    //!
    //! where tests.js prints `dayjs(s).valueOf()`, `dayjs(s, f, strict)`,
    //! `dayjs(ms).format(f)` and `dayjs(ms).add(n, u)` for each case below.
    //! During development the module was also compared against ~300,000
    //! generated cases (random strings, formats, units and offsets) with no
    //! mismatches outside the documented gaps.

    use super::*;

    const NOW: f64 = 1_789_300_800_000.0; // 2026-09-13T12:00:00Z
    /// 2024-09-03T08:05:06.789Z (a Tuesday).
    const T: f64 = 1_725_350_706_789.0;
    /// 2024-01-31T15:30:00Z.
    const J31: f64 = 1_706_715_000_000.0;

    fn ms(s: &str, off: i32) -> Option<f64> {
        parse(s, off).map(|d| d.epoch_ms())
    }

    fn fmt_at(t: f64, off: i32, f: &str) -> String {
        format(&DateTime::from_epoch_ms(t, off), f)
    }

    fn pf(s: &str, f: &str, strict: bool, off: i32) -> Option<f64> {
        parse_with_format_at(s, f, strict, off, NOW).map(|d| d.epoch_ms())
    }

    fn added(t: f64, off: i32, n: i64, unit: &str) -> Option<f64> {
        add(&DateTime::from_epoch_ms(t, off), n, unit).map(|d| d.epoch_ms())
    }

    // ---- dayjs(string) --------------------------------------------------

    #[test]
    fn iso_with_z_is_utc_regardless_of_offset() {
        assert_eq!(ms("2024-09-03T10:05:06Z", 0), Some(1725357906000.0));
        assert_eq!(ms("2024-09-03T10:05:06Z", 480), Some(1725357906000.0));
        let d = parse("2024-09-03T10:05:06Z", 480).unwrap();
        assert_eq!(format(&d, ""), "2024-09-03T18:05:06+08:00");
    }

    #[test]
    fn iso_with_plus_0800_rendered_at_0_and_480() {
        let utc = parse("2024-09-03T10:05:06+08:00", 0).unwrap();
        assert_eq!(utc.epoch_ms(), 1725329106000.0);
        assert_eq!(
            format(&utc, "YYYY-MM-DDTHH:mm:ss.SSSZ"),
            "2024-09-03T02:05:06.000+00:00"
        );
        let sg = parse("2024-09-03T10:05:06+08:00", 480).unwrap();
        assert_eq!(sg.epoch_ms(), 1725329106000.0);
        assert_eq!(
            format(&sg, "YYYY-MM-DDTHH:mm:ss.SSSZ"),
            "2024-09-03T10:05:06.000+08:00"
        );
    }

    #[test]
    fn date_only_strings_are_local_midnight() {
        // dayjs's own regex wins over the ES5 "date-only is UTC" rule.
        assert_eq!(ms("2024-09-03", 0), Some(1725321600000.0));
        assert_eq!(ms("2024-09-03", 480), Some(1725292800000.0));
        assert_eq!(ms("20240903", 480), Some(1725292800000.0));
        assert_eq!(ms("2024-09-03 10:00", 480), Some(1725328800000.0));
    }

    #[test]
    fn rfc_2822_and_js_to_string_forms() {
        assert_eq!(
            ms("Tue, 03 Sep 2024 10:00:00 GMT", 480),
            Some(1725357600000.0)
        );
        assert_eq!(
            ms(
                "Mon Sep 02 2024 17:00:00 GMT-0700 (Pacific Daylight Time)",
                480
            ),
            Some(1725321600000.0)
        );
        assert_eq!(ms("Sep 3 2024 10:00:00 GMT+0530", 0), Some(1725337800000.0));
    }

    #[test]
    fn legacy_month_name_forms_are_local() {
        assert_eq!(ms("September 3, 2024", 0), Some(1725321600000.0));
        assert_eq!(ms("September 3, 2024", 480), Some(1725292800000.0));
        assert_eq!(ms("Sep 3 2024 10:00 pm", 0), Some(1725400800000.0));
        assert_eq!(ms("Sep 3 2024 10:00 pm", 480), Some(1725372000000.0));
        assert_eq!(ms("Sep 3, 2024 (PDT)", 480), Some(1725292800000.0));
        // A zone abbreviation after the date is honoured.
        assert_eq!(ms("3 Sept 2024 PST", 480), Some(1725350400000.0));
    }

    #[test]
    fn legacy_missing_year_defaults_to_2001() {
        assert_eq!(ms("Sep 3", 0), Some(999475200000.0));
        assert_eq!(ms("Sep 3", 480), Some(999446400000.0));
    }

    #[test]
    fn slashes_dots_and_two_digit_years() {
        assert_eq!(ms("2024/09/03", 480), Some(1725292800000.0));
        assert_eq!(ms("12/31/99", 0), Some(946598400000.0));
        // Legacy parser reads dotted dates month-first.
        assert_eq!(ms("03.09.2024", 0), Some(1709942400000.0));
    }

    #[test]
    fn numeric_only_string_goes_through_dayjs_regex() {
        // "1700" + month "00" + day "00" + hour/min "00" + sec "0" → 1699-11-30.
        let d = parse("1700000000000", 0).unwrap();
        assert_eq!(d.epoch_ms(), -8523100800000.0);
        assert_eq!(format(&d, "YYYY-MM-DD"), "1699-11-30");
        assert_eq!(ms("1700000000000", 480), Some(-8523129600000.0));
    }

    #[test]
    fn regex_path_overflows_like_the_date_constructor() {
        assert_eq!(ms("2024-13-01", 0), Some(1735689600000.0));
        assert_eq!(ms("2024-00-00", 0), Some(1701302400000.0));
        assert_eq!(ms("2024-00-00", 480), Some(1701273600000.0));
        // Years 0000-0099 become 1900-1999.
        assert_eq!(ms("0050-01-01", 0), Some(-631152000000.0));
        // The fraction keeps its first three digits: ".5" is 5 ms.
        assert_eq!(ms("2024-09-03 10:00:00.5", 0), Some(1725357600005.0));
        assert_eq!(ms("2024-09-03T10:00:00.123456Z", 0), Some(1725357600123.0));
    }

    #[test]
    fn es5_extremes() {
        assert_eq!(ms("2024-09-03T24:00:00Z", 480), Some(1725408000000.0));
        assert_eq!(ms("+002024-09-03T00:00:00Z", 0), Some(1725321600000.0));
        assert_eq!(ms("-000000-01-01T00:00:00Z", 0), None);
        assert_eq!(ms("2024-09-03t10:00:00z", 480), Some(1725357600000.0));
    }

    #[test]
    fn invalid_strings() {
        for s in [
            "junk",
            "",
            "Sep 3 2024 10pm",
            "Tuesday, September 3, 2024 at 10:00 AM",
        ] {
            assert_eq!(ms(s, 0), None, "{s:?}");
            assert_eq!(ms(s, 480), None, "{s:?}");
        }
    }

    #[test]
    fn leap_days() {
        assert_eq!(ms("2023-02-29", 0), Some(1677628800000.0)); // → Mar 1
        assert_eq!(ms("2023-02-29", 480), Some(1677600000000.0));
        assert_eq!(ms("1900-02-29", 0), Some(-2203891200000.0)); // 1900 is not leap
        assert_eq!(ms("2000-02-29", 0), Some(951782400000.0));
        assert_eq!(fmt_at(951782400000.0, 0, "YYYY-MM-DD"), "2000-02-29");
    }

    #[test]
    fn now_style_epoch_conversion() {
        assert_eq!(fmt_at(T, 0, ""), "2024-09-03T08:05:06+00:00");
        assert_eq!(fmt_at(T, 480, ""), "2024-09-03T16:05:06+08:00");
        assert_eq!(fmt_at(T, -300, ""), "2024-09-03T03:05:06-05:00");
        let d = DateTime::from_epoch_ms(T, 330);
        assert_eq!(d.epoch_ms(), T);
        assert_eq!(d.offset_minutes(), 330);
    }

    #[test]
    fn invalid_datetime_formats_as_invalid_date() {
        let d = DateTime::from_epoch_ms(f64::NAN, 0);
        assert!(!d.is_valid());
        assert_eq!(format(&d, "YYYY"), "Invalid Date");
        assert!(!DateTime::from_epoch_ms(9e15, 0).is_valid());
        assert_eq!(add(&d, 1, "day"), None);
    }

    // ---- format ---------------------------------------------------------

    #[test]
    fn format_year_and_month_tokens() {
        assert_eq!(
            fmt_at(T, 0, "YY YYYY M MM MMM MMMM"),
            "24 2024 9 09 Sep September"
        );
    }

    #[test]
    fn format_day_tokens() {
        assert_eq!(
            fmt_at(T, 0, "D DD d dd ddd dddd Do"),
            "3 03 2 Tu Tue Tuesday 3rd"
        );
    }

    #[test]
    fn format_hour_tokens() {
        assert_eq!(fmt_at(T, 0, "H HH h hh k kk A a"), "8 08 8 08 8 08 AM am");
        assert_eq!(
            fmt_at(T, 480, "H HH h hh k kk A a"),
            "16 16 4 04 16 16 PM pm"
        );
        assert_eq!(
            fmt_at(1725322020000.0, 0, "H HH h hh k kk A a"),
            "0 00 12 12 24 24 AM am"
        );
        assert_eq!(
            fmt_at(1725368820000.0, 0, "H HH h hh k kk A a"),
            "13 13 1 01 13 13 PM pm"
        );
    }

    #[test]
    fn format_minute_second_millisecond_tokens() {
        assert_eq!(fmt_at(T, 0, "m mm s ss SSS"), "5 05 6 06 789");
    }

    #[test]
    fn format_zone_tokens() {
        assert_eq!(fmt_at(T, 0, "Z ZZ"), "+00:00 +0000");
        assert_eq!(fmt_at(T, 480, "Z ZZ"), "+08:00 +0800");
        assert_eq!(fmt_at(T, -300, "Z ZZ"), "-05:00 -0500");
        assert_eq!(fmt_at(T, 330, "Z ZZ"), "+05:30 +0530");
        // utcOffset() rounds to 15 minutes.
        assert_eq!(fmt_at(T, 7, "Z"), "+00:00");
        assert_eq!(fmt_at(T, 8, "Z"), "+00:15");
    }

    #[test]
    fn format_unix_tokens() {
        assert_eq!(fmt_at(T, 0, "X x"), "1725350706 1725350706789");
        assert_eq!(fmt_at(T, 480, "X x"), "1725350706 1725350706789");
    }

    #[test]
    fn format_quarter_and_ordinals() {
        assert_eq!(fmt_at(T, 0, "Q"), "3");
        assert_eq!(fmt_at(1704110400000.0, 0, "Q Do"), "1 1st");
        assert_eq!(fmt_at(1734868800000.0, 480, "Q Do"), "4 22nd");
        assert_eq!(fmt_at(1731326400000.0, 0, "Do"), "11th");
        assert_eq!(fmt_at(1731412800000.0, 0, "Do"), "12th");
        assert_eq!(fmt_at(1731499200000.0, 0, "Do"), "13th");
    }

    #[test]
    fn format_week_of_year_tokens() {
        assert_eq!(fmt_at(T, 0, "w ww wo"), "36 36 36th");
        // 2024-12-29 (Sunday): the week containing Jan 1 is week 1.
        assert_eq!(fmt_at(1735473600000.0, 0, "w wo W GGGG"), "1 1st 52 2024");
        assert_eq!(fmt_at(1735646400000.0, 480, "w W GGGG"), "1 1 2025");
    }

    #[test]
    fn format_iso_week_year_edges() {
        assert_eq!(fmt_at(T, 0, "W WW GGGG"), "36 36 2024");
        // 2021-01-01 is ISO week 53 of 2020.
        assert_eq!(
            fmt_at(1609502400000.0, 0, "W WW GGGG w ww"),
            "53 53 2020 1 01"
        );
        assert_eq!(
            fmt_at(1609502400000.0, 480, "W WW GGGG w ww"),
            "53 53 2020 1 01"
        );
        // 2027-01-01 is ISO week 53 of 2026.
        assert_eq!(fmt_at(1798804800000.0, 0, "w W GGGG"), "1 53 2026");
    }

    #[test]
    fn format_escaped_brackets() {
        assert_eq!(fmt_at(T, 0, "[Today is] dddd"), "Today is Tuesday");
        assert_eq!(fmt_at(T, 0, "[W k] W k"), "W k 36 8");
        assert_eq!(fmt_at(T, 0, "YYYY-MM-DD[T]HH:mm:ss"), "2024-09-03T08:05:06");
        // An unclosed bracket escapes nothing.
        assert_eq!(fmt_at(T, 0, "[W"), "[36");
    }

    #[test]
    fn format_advanced_tokens_inside_literal_words() {
        // advancedFormat replaces "W" and "k" in "Week" before the core pass.
        assert_eq!(fmt_at(T, 0, "Week W"), "36ee8 36");
        assert_eq!(fmt_at(T, 480, "Week W"), "36ee16 36");
    }

    #[test]
    fn format_empty_uses_default() {
        assert_eq!(fmt_at(T, 480, ""), "2024-09-03T16:05:06+08:00");
    }

    #[test]
    fn format_tokens_that_throw_in_knap() {
        let d = DateTime::from_epoch_ms(T, 0);
        assert_eq!(
            try_format(&d, "z"),
            Err(FormatError::MissingPlugin("timezone"))
        );
        assert_eq!(
            try_format(&d, "zzz"),
            Err(FormatError::MissingPlugin("timezone"))
        );
        assert_eq!(
            try_format(&d, "gggg"),
            Err(FormatError::MissingPlugin("weekYear"))
        );
        assert_eq!(format(&d, "YYYY z"), "");
        assert_eq!(try_format(&d, "[z]"), Ok("z".to_string()));
    }

    #[test]
    fn format_year_padding_quirks() {
        assert_eq!(fmt_at(-62310686400000.0, 0, "YYYY YY"), "00-5 -5");
        assert_eq!(fmt_at(327403468800000.0, 480, "YYYY YY"), "12345 45");
    }

    // ---- customParseFormat -----------------------------------------------

    #[test]
    fn strict_day_month_year() {
        assert_eq!(
            pf("03/09/2024", "DD/MM/YYYY", true, 0),
            Some(1725321600000.0)
        );
        assert_eq!(
            pf("03/09/2024", "DD/MM/YYYY", true, 480),
            Some(1725292800000.0)
        );
        assert_eq!(
            pf("03/09/2024", "DD/MM/YYYY", true, 330),
            Some(1725301800000.0)
        );
        assert_eq!(
            parse_with_format("03/09/2024", "DD/MM/YYYY", true, 0).map(|d| d.epoch_ms()),
            Some(1725321600000.0)
        );
    }

    #[test]
    fn strict_rejects_overflow() {
        assert_eq!(pf("2024-13-01", "YYYY-MM-DD", true, 0), None);
        assert_eq!(pf("31/02/2024", "DD/MM/YYYY", true, 480), None);
        assert_eq!(pf("2023-02-29", "YYYY-MM-DD", true, 0), None);
        assert_eq!(
            pf("2024-02-29", "YYYY-MM-DD", true, 0),
            Some(1709164800000.0)
        );
    }

    #[test]
    fn non_strict_allows_overflow() {
        assert_eq!(
            pf("31/02/2024", "DD/MM/YYYY", false, 0),
            Some(1709337600000.0)
        );
        assert_eq!(
            pf("31/02/2024", "DD/MM/YYYY", false, 480),
            Some(1709308800000.0)
        );
    }

    #[test]
    fn month_names_are_case_sensitive() {
        assert_eq!(
            pf("September 3, 2024", "MMMM D, YYYY", true, 480),
            Some(1725292800000.0)
        );
        assert_eq!(
            pf("Sep 3 2024", "MMM D YYYY", true, 0),
            Some(1725321600000.0)
        );
        assert_eq!(pf("sep 3 2024", "MMM D YYYY", true, 0), None);
        assert_eq!(
            pf("3rd September 2024", "Do MMMM YYYY", true, 0),
            Some(1725321600000.0)
        );
    }

    #[test]
    fn zone_token_strict_only_round_trips_at_the_same_offset() {
        let s = "2024-09-03T10:00:00+08:00";
        let f = "YYYY-MM-DDTHH:mm:ssZ";
        assert_eq!(pf(s, f, true, 480), Some(1725328800000.0));
        assert_eq!(pf(s, f, true, 0), None);
        assert_eq!(pf(s, f, false, 0), Some(1725328800000.0));
        assert_eq!(pf(s, f, false, 330), Some(1725328800000.0));
    }

    #[test]
    fn unix_formats() {
        assert_eq!(pf("1700000000", "X", true, 480), Some(1700000000000.0));
        assert_eq!(pf("1700000000123", "x", true, 0), Some(1700000000123.0));
    }

    #[test]
    fn missing_date_parts_use_now() {
        assert_eq!(pf("10:30", "HH:mm", true, 0), Some(1789295400000.0));
        assert_eq!(pf("10:30", "HH:mm", true, 480), Some(1789266600000.0));
        assert_eq!(pf("09", "MM", true, 330), Some(1788201000000.0));
        assert_eq!(pf("2024", "YYYY", true, 480), Some(1704038400000.0));
    }

    #[test]
    fn meridiem_and_two_digit_years() {
        assert_eq!(pf("12:00 AM", "hh:mm A", true, 0), Some(1789257600000.0));
        assert_eq!(pf("12:00 PM", "hh:mm A", false, 480), Some(1789272000000.0));
        assert_eq!(pf("68-01-01", "YY-MM-DD", true, 0), Some(3092601600000.0));
        assert_eq!(pf("69-01-01", "YY-MM-DD", true, 0), Some(-31536000000.0));
    }

    #[test]
    fn week_token() {
        assert_eq!(pf("2024 36", "YYYY w", false, 0), Some(1725235200000.0));
        assert_eq!(pf("2024 36", "YYYY w", false, 330), Some(1725215400000.0));
    }

    #[test]
    fn plugin_throws_become_invalid() {
        // en has no localized formats, so L tokens throw inside the plugin.
        assert_eq!(pf("LL", "LL", true, 0), None);
        assert_eq!(pf("September 3, 2024", "LL", false, 0), None);
        // A token regex that finds nothing throws.
        assert_eq!(pf("2024-09-03", "YYYY-MM-DD HH:mm", false, 0), None);
        // No tokens at all.
        assert_eq!(pf("abc", "@@", true, 0), None);
        // The strict round-trip calls format, which throws on `z`.
        assert_eq!(pf("2024-09-03 z", "YYYY-MM-DD z", true, 0), None);
    }

    // ---- add --------------------------------------------------------------

    #[test]
    fn add_month_clamps_day_of_month() {
        assert_eq!(added(J31, 0, 1, "month"), Some(1709220600000.0)); // 2024-02-29
        assert_eq!(
            added(1675123200000.0, 0, 1, "months"),
            Some(1677542400000.0)
        ); // 2023-02-28
        assert_eq!(added(1730332800000.0, 0, 1, "month"), Some(1732924800000.0)); // Oct 31 → Nov 30
        assert_eq!(added(1735603200000.0, 0, 2, "month"), Some(1740700800000.0)); // Dec 31 → Feb 28
        assert_eq!(added(J31, 0, 3, "MONTHS"), Some(1714491000000.0));
    }

    #[test]
    fn add_month_clamps_in_local_time() {
        // 2024-10-31T00:00Z is Oct 30 19:00 at -05:00, so it lands on Nov 30.
        assert_eq!(
            added(1730332800000.0, -300, 1, "month"),
            Some(1733011200000.0)
        );
        assert_eq!(
            added(1675123200000.0, -300, 1, "months"),
            Some(1677628800000.0)
        );
        assert_eq!(added(J31, 480, 1, "month"), Some(1709220600000.0));
    }

    #[test]
    fn add_and_subtract_years_across_leap_day() {
        assert_eq!(added(1709164800000.0, 0, 1, "year"), Some(1740700800000.0)); // → 2025-02-28
        assert_eq!(
            added(1709164800000.0, -300, 1, "year"),
            Some(1740787200000.0)
        );
        assert_eq!(added(1711843200000.0, 0, -1, "M"), Some(1709164800000.0)); // Mar 31 → Feb 29
        assert_eq!(added(1711843200000.0, -300, -1, "M"), Some(1709251200000.0));
        assert_eq!(added(J31, 0, 2, "y"), Some(1769873400000.0));
    }

    #[test]
    fn add_days_weeks_and_clock_units() {
        assert_eq!(added(J31, 480, 1, "day"), Some(1706801400000.0));
        assert_eq!(added(J31, 0, 3, "Days"), Some(1706974200000.0));
        assert_eq!(added(J31, 0, 2, "d"), Some(1706887800000.0));
        assert_eq!(added(J31, 0, 2, "w"), Some(1707924600000.0));
        assert_eq!(added(J31, 0, 10, "hours"), Some(1706751000000.0));
        assert_eq!(added(J31, 0, 2, "h"), Some(1706722200000.0));
        assert_eq!(added(J31, 0, 90, "m"), Some(1706720400000.0));
        assert_eq!(added(J31, 0, 30, "s"), Some(1706715030000.0));
        assert_eq!(added(J31, 0, 1500, "ms"), Some(1706715001500.0));
    }

    #[test]
    fn add_unknown_units_add_milliseconds() {
        assert_eq!(added(J31, 0, 3, "Y"), Some(J31 + 3.0));
        assert_eq!(added(J31, 0, 3, "quarter"), Some(J31 + 3.0));
        assert_eq!(added(J31, 480, 3, "D"), Some(J31 + 3.0));
    }

    #[test]
    fn add_out_of_range_is_none() {
        assert_eq!(added(8639999999999000.0, 0, 1, "day"), None);
        assert_eq!(added(J31, 0, 12_000_000, "month"), None);
    }

    // ---- civil arithmetic -------------------------------------------------

    #[test]
    fn civil_days_round_trip_including_negative_years() {
        for z in (-200_000_000i64..200_000_000).step_by(7_919) {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(0, 3, 1), -719_468);
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(days_from_civil(-5, 2, 29)), (-5, 3, 1)); // -5 is not leap
        assert_eq!(civil_from_days(days_from_civil(-4, 2, 29)), (-4, 2, 29)); // -4 is leap
    }
}
