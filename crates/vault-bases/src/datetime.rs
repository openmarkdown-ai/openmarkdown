//! Dates, durations and Moment.js-compatible formatting.
//!
//! A date is milliseconds since the Unix epoch (UTC). Every calendar field is
//! read in the user's local time, which here is a fixed offset in minutes
//! *east* of UTC (`+480` for Singapore, `-300` for New York in winter). Note
//! this is the opposite sign of JavaScript's `Date#getTimezoneOffset()`.
//!
//! Durations mirror moment's internal representation — `months`, `days`,
//! `milliseconds` — because Obsidian builds its DurationValue on moment and the
//! calendar semantics (Jan 31 + 1M = Feb 28) follow from that split.

pub const MS_PER_DAY: f64 = 86_400_000.0;

// ---------------------------------------------------------------------------
// Civil calendar
// ---------------------------------------------------------------------------

/// Days since 1970-01-01 for a proleptic Gregorian date (month 1–12).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// (year, month 1–12, day 1–31) for days since 1970-01-01.
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
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

pub fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
    }
}

/// Broken-down local time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Parts {
    pub year: i64,
    pub month: i64, // 1–12
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub millisecond: i64,
    /// 0 = Sunday
    pub weekday: i64,
}

pub fn to_parts(ms: f64, tz_min: i32) -> Parts {
    let local = ms + tz_min as f64 * 60_000.0;
    let local = if local.is_finite() { local } else { 0.0 };
    let days = (local / MS_PER_DAY).floor() as i64;
    let rem = (local - days as f64 * MS_PER_DAY).round() as i64;
    let (year, month, day) = civil_from_days(days);
    Parts {
        year,
        month,
        day,
        hour: rem / 3_600_000,
        minute: (rem / 60_000) % 60,
        second: (rem / 1000) % 60,
        millisecond: rem % 1000,
        weekday: (days + 4).rem_euclid(7),
    }
}

/// UTC ms for a local wall-clock time. Out-of-range fields roll over.
#[allow(clippy::too_many_arguments)]
pub fn from_parts(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, ms: f64, tz_min: i32) -> f64 {
    // normalise month first so days_from_civil sees 1..=12
    let mo0 = mo - 1;
    let y = y + mo0.div_euclid(12);
    let mo = mo0.rem_euclid(12) + 1;
    let days = days_from_civil(y, mo, 1) + (d - 1);
    days as f64 * MS_PER_DAY + (h * 3_600_000 + mi * 60_000 + s * 1000) as f64 + ms
        - tz_min as f64 * 60_000.0
}

/// Local midnight of the day containing `ms`.
pub fn start_of_day(ms: f64, tz_min: i32) -> f64 {
    let p = to_parts(ms, tz_min);
    from_parts(p.year, p.month, p.day, 0, 0, 0, 0.0, tz_min)
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// A parsed date: UTC milliseconds, and whether the input carried a time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParsedDate {
    pub ms: f64,
    pub has_time: bool,
}

struct Cur<'a> {
    b: &'a [u8],
    i: usize,
}

impl Cur<'_> {
    fn digits(&mut self, min: usize, max: usize) -> Option<i64> {
        let start = self.i;
        while self.i < self.b.len() && self.i - start < max && self.b[self.i].is_ascii_digit() {
            self.i += 1;
        }
        if self.i - start < min {
            self.i = start;
            return None;
        }
        std::str::from_utf8(&self.b[start..self.i])
            .ok()?
            .parse()
            .ok()
    }
    fn eat(&mut self, c: u8) -> bool {
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }
    fn done(&self) -> bool {
        self.i >= self.b.len()
    }
}

/// Parse an ISO-8601-ish date as Obsidian's `DateValue.parseFromString` does:
/// `2025-12-31`, `2025-12-31T23:59`, `2025-12-31 23:59:59`, `…Z`, `…+07:00`,
/// `…-07`. Month and day may be one digit; `/` and `.` are accepted as date
/// separators. Without an offset the time is local.
pub fn parse_date(input: &str, tz_min: i32) -> Option<ParsedDate> {
    let s = input.trim();
    let mut c = Cur {
        b: s.as_bytes(),
        i: 0,
    };
    let neg = c.eat(b'-');
    let year = c.digits(4, 6)?;
    let year = if neg { -year } else { year };
    let sep = c.peek()?;
    if !matches!(sep, b'-' | b'/' | b'.') {
        return None;
    }
    c.i += 1;
    let month = c.digits(1, 2)?;
    let day = if c.eat(sep) {
        c.digits(1, 2)?
    } else {
        return None;
    };
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let (mut h, mut mi, mut sec, mut frac) = (0, 0, 0, 0.0);
    let mut has_time = false;
    let mut offset: Option<i32> = None;
    if !c.done() {
        if !(c.eat(b'T') || c.eat(b't') || c.eat(b' ')) {
            return None;
        }
        while c.eat(b' ') {}
        h = c.digits(1, 2)?;
        if !c.eat(b':') {
            return None;
        }
        mi = c.digits(2, 2)?;
        has_time = true;
        if c.eat(b':') {
            sec = c.digits(2, 2)?;
            if c.eat(b'.') || c.eat(b',') {
                let start = c.i;
                while c.peek().is_some_and(|b| b.is_ascii_digit()) {
                    c.i += 1;
                }
                let f = &s[start..c.i];
                if f.is_empty() {
                    return None;
                }
                frac = format!("0.{f}").parse::<f64>().ok()? * 1000.0;
            }
        }
        while c.eat(b' ') {}
        if c.eat(b'Z') || c.eat(b'z') {
            offset = Some(0);
        } else if let Some(sign @ (b'+' | b'-')) = c.peek() {
            c.i += 1;
            let oh = c.digits(2, 2)?;
            c.eat(b':');
            let om = c.digits(2, 2).unwrap_or(0);
            let total = (oh * 60 + om) as i32;
            offset = Some(if sign == b'-' { -total } else { total });
        }
        if !c.done() || h > 24 || mi > 59 || sec > 59 {
            return None;
        }
    }
    let tz = offset.unwrap_or(tz_min);
    Some(ParsedDate {
        ms: from_parts(year, month, day, h, mi, sec, frac.round(), tz),
        has_time,
    })
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Duration {
    pub months: f64,
    pub days: f64,
    pub ms: f64,
}

fn days_to_months(days: f64) -> f64 {
    days * 4800.0 / 146_097.0
}
fn months_to_days(months: f64) -> f64 {
    months * 146_097.0 / 4800.0
}

impl Duration {
    pub fn from_ms(ms: f64) -> Self {
        Duration {
            months: 0.0,
            days: 0.0,
            ms,
        }
    }

    /// moment's `asMilliseconds()`.
    pub fn total_ms(&self) -> f64 {
        self.ms + self.days * MS_PER_DAY + months_to_days(self.months) * MS_PER_DAY
    }

    /// moment's `as(unit)`.
    pub fn as_unit(&self, unit: &str) -> Option<f64> {
        Some(match unit {
            "years" | "year" => {
                (self.months + days_to_months(self.days + self.ms / MS_PER_DAY)) / 12.0
            }
            "months" | "month" => self.months + days_to_months(self.days + self.ms / MS_PER_DAY),
            "weeks" | "week" => {
                (self.days + months_to_days(self.months).round() + self.ms / MS_PER_DAY) / 7.0
            }
            "days" | "day" => {
                self.days + months_to_days(self.months).round() + self.ms / MS_PER_DAY
            }
            "hours" | "hour" => self.total_ms() / 3_600_000.0,
            "minutes" | "minute" => self.total_ms() / 60_000.0,
            "seconds" | "second" => self.total_ms() / 1000.0,
            "milliseconds" | "millisecond" => self.total_ms(),
            _ => return None,
        })
    }

    pub fn scale(&self, k: f64) -> Self {
        Duration {
            months: self.months * k,
            days: self.days * k,
            ms: self.ms * k,
        }
    }

    pub fn add(&self, o: &Duration) -> Self {
        Duration {
            months: self.months + o.months,
            days: self.days + o.days,
            ms: self.ms + o.ms,
        }
    }

    pub fn neg(&self) -> Self {
        self.scale(-1.0)
    }

    pub fn is_zero(&self) -> bool {
        self.months == 0.0 && self.days == 0.0 && self.ms == 0.0
    }

    /// Human-readable: `1 year, 2 months, 3 days, 4 hours`.
    pub fn humanize(&self) -> String {
        let total = self.total_ms();
        if total == 0.0 {
            return "0 seconds".into();
        }
        let neg = total < 0.0;
        let d = if neg { self.neg() } else { *self };
        // Normalise: whole months carry into years, day remainder of ms into days.
        let mut months = d.months.trunc();
        let mut days = d.days + months_to_days(d.months.fract());
        let mut ms = d.ms + days.fract() * MS_PER_DAY;
        days = days.trunc();
        let extra_days = (ms / MS_PER_DAY).floor();
        days += extra_days;
        ms -= extra_days * MS_PER_DAY;
        if months == 0.0 && days >= 30.0 {
            // A pure millisecond span (date − date): express long spans in years/months.
            let m = days_to_months(days).floor();
            months += m;
            days -= months_to_days(m).round();
            if days < 0.0 {
                days = 0.0;
            }
        }
        let years = (months / 12.0).floor();
        months -= years * 12.0;
        let hours = (ms / 3_600_000.0).floor();
        ms -= hours * 3_600_000.0;
        let minutes = (ms / 60_000.0).floor();
        ms -= minutes * 60_000.0;
        let seconds = (ms / 1000.0).floor();
        ms -= seconds * 1000.0;
        let mut parts = Vec::new();
        for (n, unit) in [
            (years, "year"),
            (months, "month"),
            (days, "day"),
            (hours, "hour"),
            (minutes, "minute"),
            (seconds, "second"),
            (ms.round(), "millisecond"),
        ] {
            if n != 0.0 {
                parts.push(format!("{} {}{}", n, unit, if n == 1.0 { "" } else { "s" }));
            }
        }
        let s = parts.join(", ");
        if neg {
            format!("-{s}")
        } else {
            s
        }
    }
}

fn unit_of(word: &str) -> Option<&'static str> {
    // Single letters are case-sensitive (M = month, m = minute).
    Some(match word {
        "y" | "Y" => "y",
        "M" => "M",
        "w" | "W" => "w",
        "d" | "D" => "d",
        "h" | "H" => "h",
        "m" => "m",
        "s" | "S" => "s",
        "ms" => "ms",
        _ => match word.to_ascii_lowercase().as_str() {
            "yr" | "yrs" | "year" | "years" => "y",
            "mo" | "mos" | "month" | "months" => "M",
            "wk" | "wks" | "week" | "weeks" => "w",
            "day" | "days" => "d",
            "hr" | "hrs" | "hour" | "hours" => "h",
            "min" | "mins" | "minute" | "minutes" => "m",
            "sec" | "secs" | "second" | "seconds" => "s",
            "millisecond" | "milliseconds" => "ms",
            _ => return None,
        },
    })
}

/// Parse `"1d"`, `"2 weeks"`, `"1M 4h"`, `"-3 hours"`, `"1 year, 2 months"`
/// or an ISO-8601 duration (`P1Y2M3DT4H5M6S`, `PT1H`, `P2W`).
pub fn parse_duration(input: &str) -> Option<Duration> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(d) = parse_iso_duration(s) {
        return Some(d);
    }
    let b = s.as_bytes();
    let mut i = 0;
    let mut out = Duration::default();
    let mut any = false;
    let mut global_sign = 1.0;
    if b[0] == b'-' || b[0] == b'+' {
        // A leading sign applies to the whole expression when a space follows
        // ("- 3 hours"), otherwise to the first number only, which for a
        // single-term duration is the same thing.
        if b.len() > 1 && b[1] == b' ' {
            global_sign = if b[0] == b'-' { -1.0 } else { 1.0 };
            i = 1;
        }
    }
    loop {
        while i < b.len() && (b[i] == b' ' || b[i] == b',' || b[i] == b'\t') {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        if s[i..].starts_with("and ") {
            i += 4;
            continue;
        }
        let start = i;
        if b[i] == b'-' || b[i] == b'+' {
            i += 1;
        }
        while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
            i += 1;
        }
        let num_str = &s[start..i];
        let n: f64 = if num_str.is_empty() || num_str == "-" || num_str == "+" {
            return None;
        } else {
            num_str.parse().ok()?
        };
        while i < b.len() && b[i] == b' ' {
            i += 1;
        }
        let ustart = i;
        while i < b.len() && b[i].is_ascii_alphabetic() {
            i += 1;
        }
        let unit = unit_of(&s[ustart..i])?;
        let n = n * global_sign;
        match unit {
            "y" => out.months += n * 12.0,
            "M" => out.months += n,
            "w" => out.days += n * 7.0,
            "d" => out.days += n,
            "h" => out.ms += n * 3_600_000.0,
            "m" => out.ms += n * 60_000.0,
            "s" => out.ms += n * 1000.0,
            _ => out.ms += n,
        }
        any = true;
    }
    any.then_some(out)
}

fn parse_iso_duration(s: &str) -> Option<Duration> {
    let (neg, rest) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let rest = rest.strip_prefix('P').or_else(|| rest.strip_prefix('p'))?;
    if rest.is_empty() {
        return None;
    }
    let mut out = Duration::default();
    let mut in_time = false;
    let mut num = String::new();
    let mut any = false;
    for ch in rest.chars() {
        match ch {
            'T' | 't' => {
                if !num.is_empty() {
                    return None;
                }
                in_time = true;
            }
            '0'..='9' | '.' | ',' => num.push(if ch == ',' { '.' } else { ch }),
            _ => {
                let n: f64 = num.parse().ok()?;
                num.clear();
                any = true;
                match (ch.to_ascii_uppercase(), in_time) {
                    ('Y', false) => out.months += n * 12.0,
                    ('M', false) => out.months += n,
                    ('W', false) => out.days += n * 7.0,
                    ('D', false) => out.days += n,
                    ('H', true) => out.ms += n * 3_600_000.0,
                    ('M', true) => out.ms += n * 60_000.0,
                    ('S', true) => out.ms += n * 1000.0,
                    _ => return None,
                }
            }
        }
    }
    if !num.is_empty() || !any {
        return None;
    }
    Some(if neg { out.neg() } else { out })
}

fn abs_round(x: f64) -> f64 {
    if x < 0.0 {
        -((-x).round())
    } else {
        x.round()
    }
}

/// moment's `add`: milliseconds, then whole days, then whole months (clamping
/// the day of month), all in local time.
pub fn add_duration(ms: f64, d: &Duration, sign: f64, tz_min: i32) -> f64 {
    let mut t = ms + d.ms * sign;
    let days = abs_round(d.days);
    if days != 0.0 {
        t += days * sign * MS_PER_DAY;
    }
    let months = abs_round(d.months);
    if months != 0.0 {
        let p = to_parts(t, tz_min);
        let total = p.year * 12 + (p.month - 1) + (months * sign) as i64;
        let y = total.div_euclid(12);
        let m = total.rem_euclid(12) + 1;
        let day = p.day.min(days_in_month(y, m));
        t = from_parts(
            y,
            m,
            day,
            p.hour,
            p.minute,
            p.second,
            p.millisecond as f64,
            tz_min,
        );
    }
    t
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

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

pub fn ordinal(n: i64) -> String {
    let b = n % 10;
    let suffix = if (n % 100) / 10 == 1 {
        "th"
    } else if b == 1 {
        "st"
    } else if b == 2 {
        "nd"
    } else if b == 3 {
        "rd"
    } else {
        "th"
    };
    format!("{n}{suffix}")
}

fn pad(n: i64, width: usize) -> String {
    if n < 0 {
        format!("-{:0width$}", -n, width = width)
    } else {
        format!("{:0width$}", n, width = width)
    }
}

fn day_of_year(p: &Parts) -> i64 {
    days_from_civil(p.year, p.month, p.day) - days_from_civil(p.year, 1, 1) + 1
}

/// Week of year and week-year for a week starting on `dow` whose first week
/// contains January `7 + dow - doy`. ISO: dow=1, doy=4. en locale: dow=0, doy=6.
fn week_of_year(p: &Parts, dow: i64, doy: i64) -> (i64, i64) {
    fn first_week_offset(year: i64, dow: i64, doy: i64) -> i64 {
        let fwd = 7 + dow - doy;
        let jan = days_from_civil(year, 1, fwd);
        let fwdlw = (7 + (jan + 4).rem_euclid(7) - dow) % 7;
        -fwdlw + fwd - 1
    }
    fn weeks_in_year(year: i64, dow: i64, doy: i64) -> i64 {
        let off = first_week_offset(year, dow, doy);
        let off_next = first_week_offset(year + 1, dow, doy);
        let days = if is_leap(year) { 366 } else { 365 };
        (days - off + off_next) / 7
    }
    let off = first_week_offset(p.year, dow, doy);
    let week = (day_of_year(p) - off - 1).div_euclid(7) + 1;
    if week < 1 {
        let y = p.year - 1;
        (week + weeks_in_year(y, dow, doy), y)
    } else if week > weeks_in_year(p.year, dow, doy) {
        (week - weeks_in_year(p.year, dow, doy), p.year + 1)
    } else {
        (week, p.year)
    }
}

fn offset_str(tz_min: i32, sep: &str) -> String {
    let sign = if tz_min < 0 { '-' } else { '+' };
    let a = tz_min.abs();
    format!("{sign}{:02}{sep}{:02}", a / 60, a % 60)
}

fn expand_locale_tokens(fmt: &str) -> String {
    // en locale long-date formats
    let mut out = String::new();
    let chars: Vec<char> = fmt.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(end) = chars[i + 1..].iter().position(|&c| c == ']') {
                out.extend(&chars[i..=i + 1 + end]);
                i += end + 2;
                continue;
            }
        }
        let rest: String = chars[i..].iter().take(4).collect();
        let (tok, rep) = if rest.starts_with("LTS") {
            ("LTS", "h:mm:ss A")
        } else if rest.starts_with("LT") {
            ("LT", "h:mm A")
        } else if rest.starts_with("LLLL") {
            ("LLLL", "dddd, MMMM D, YYYY h:mm A")
        } else if rest.starts_with("LLL") {
            ("LLL", "MMMM D, YYYY h:mm A")
        } else if rest.starts_with("LL") {
            ("LL", "MMMM D, YYYY")
        } else if rest.starts_with('L') {
            ("L", "MM/DD/YYYY")
        } else if rest.starts_with("llll") {
            ("llll", "ddd, MMM D, YYYY h:mm A")
        } else if rest.starts_with("lll") {
            ("lll", "MMM D, YYYY h:mm A")
        } else if rest.starts_with("ll") {
            ("ll", "MMM D, YYYY")
        } else if rest.starts_with('l') {
            ("l", "M/D/YYYY")
        } else {
            out.push(chars[i]);
            i += 1;
            continue;
        };
        out.push_str(rep);
        i += tok.chars().count();
    }
    out
}

/// Format like `moment(ms).utcOffset(tz_min).format(fmt)` with the `en` locale.
pub fn format_date(ms: f64, fmt: &str, tz_min: i32) -> String {
    let p = to_parts(ms, tz_min);
    let fmt = expand_locale_tokens(fmt);
    let chars: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let starts = |i: usize, t: &str| -> bool {
        let tc: Vec<char> = t.chars().collect();
        chars.len() >= i + tc.len() && chars[i..i + tc.len()] == tc[..]
    };
    let run = |i: usize, c: char| -> usize { chars[i..].iter().take_while(|&&x| x == c).count() };
    let h12 = if p.hour % 12 == 0 { 12 } else { p.hour % 12 };
    while i < chars.len() {
        let c = chars[i];
        if c == '[' {
            if let Some(end) = chars[i + 1..].iter().position(|&x| x == ']') {
                out.extend(&chars[i + 1..i + 1 + end]);
                i += end + 2;
                continue;
            }
        }
        if c == '\\' && i + 1 < chars.len() {
            out.push(chars[i + 1]);
            i += 2;
            continue;
        }
        // Compound tokens first.
        if starts(i, "Hmmss") {
            out.push_str(&format!("{}{:02}{:02}", p.hour, p.minute, p.second));
            i += 5;
            continue;
        }
        if starts(i, "hmmss") {
            out.push_str(&format!("{}{:02}{:02}", h12, p.minute, p.second));
            i += 5;
            continue;
        }
        if starts(i, "Hmm") {
            out.push_str(&format!("{}{:02}", p.hour, p.minute));
            i += 3;
            continue;
        }
        if starts(i, "hmm") {
            out.push_str(&format!("{}{:02}", h12, p.minute));
            i += 3;
            continue;
        }
        let (text, len): (String, usize) = match c {
            'M' => {
                if starts(i, "Mo") {
                    (ordinal(p.month), 2)
                } else {
                    match run(i, 'M').min(4) {
                        4 => (MONTHS[(p.month - 1) as usize].into(), 4),
                        3 => (MONTHS[(p.month - 1) as usize][..3].into(), 3),
                        2 => (pad(p.month, 2), 2),
                        _ => (p.month.to_string(), 1),
                    }
                }
            }
            'Q' => {
                let q = (p.month - 1) / 3 + 1;
                if starts(i, "Qo") {
                    (ordinal(q), 2)
                } else {
                    (q.to_string(), 1)
                }
            }
            'D' => {
                if starts(i, "DDDo") {
                    (ordinal(day_of_year(&p)), 4)
                } else if starts(i, "Do") {
                    (ordinal(p.day), 2)
                } else {
                    match run(i, 'D').min(4) {
                        4 => (pad(day_of_year(&p), 3), 4),
                        3 => (day_of_year(&p).to_string(), 3),
                        2 => (pad(p.day, 2), 2),
                        _ => (p.day.to_string(), 1),
                    }
                }
            }
            'd' => {
                if starts(i, "do") {
                    (ordinal(p.weekday), 2)
                } else {
                    match run(i, 'd').min(4) {
                        4 => (WEEKDAYS[p.weekday as usize].into(), 4),
                        3 => (WEEKDAYS[p.weekday as usize][..3].into(), 3),
                        2 => (WEEKDAYS[p.weekday as usize][..2].into(), 2),
                        _ => (p.weekday.to_string(), 1),
                    }
                }
            }
            'e' => (p.weekday.to_string(), 1),
            'E' => ((if p.weekday == 0 { 7 } else { p.weekday }).to_string(), 1),
            'w' => {
                let (w, _) = week_of_year(&p, 0, 6);
                if starts(i, "wo") {
                    (ordinal(w), 2)
                } else if starts(i, "ww") {
                    (pad(w, 2), 2)
                } else {
                    (w.to_string(), 1)
                }
            }
            'W' => {
                let (w, _) = week_of_year(&p, 1, 4);
                if starts(i, "Wo") {
                    (ordinal(w), 2)
                } else if starts(i, "WW") {
                    (pad(w, 2), 2)
                } else {
                    (w.to_string(), 1)
                }
            }
            'Y' => match run(i, 'Y') {
                n if n >= 4 => {
                    let n = n.min(6);
                    (
                        if n == 4 {
                            pad(p.year, 4)
                        } else {
                            format!("{:+0width$}", p.year, width = n + 1)
                        },
                        n,
                    )
                }
                2 | 3 => (pad(p.year.rem_euclid(100), 2), 2),
                _ => (p.year.to_string(), 1),
            },
            'g' | 'G' => {
                let n = run(i, c);
                let (_, wy) = if c == 'g' {
                    week_of_year(&p, 0, 6)
                } else {
                    week_of_year(&p, 1, 4)
                };
                if n >= 4 {
                    (pad(wy, 4), n.min(5))
                } else if n >= 2 {
                    (pad(wy.rem_euclid(100), 2), 2)
                } else {
                    (c.to_string(), 1)
                }
            }
            'H' => {
                if starts(i, "HH") {
                    (pad(p.hour, 2), 2)
                } else {
                    (p.hour.to_string(), 1)
                }
            }
            'h' => {
                if starts(i, "hh") {
                    (pad(h12, 2), 2)
                } else {
                    (h12.to_string(), 1)
                }
            }
            'k' => {
                let k = if p.hour == 0 { 24 } else { p.hour };
                if starts(i, "kk") {
                    (pad(k, 2), 2)
                } else {
                    (k.to_string(), 1)
                }
            }
            'm' => {
                if starts(i, "mm") {
                    (pad(p.minute, 2), 2)
                } else {
                    (p.minute.to_string(), 1)
                }
            }
            's' => {
                if starts(i, "ss") {
                    (pad(p.second, 2), 2)
                } else {
                    (p.second.to_string(), 1)
                }
            }
            'S' => {
                let n = run(i, 'S').min(9);
                let digits = format!("{:03}000000", p.millisecond);
                (digits[..n].to_string(), n)
            }
            'A' => ((if p.hour < 12 { "AM" } else { "PM" }).into(), 1),
            'a' => ((if p.hour < 12 { "am" } else { "pm" }).into(), 1),
            'Z' => {
                if starts(i, "ZZ") {
                    (offset_str(tz_min, ""), 2)
                } else {
                    (offset_str(tz_min, ":"), 1)
                }
            }
            'z' => (String::new(), run(i, 'z').min(2)),
            'X' => (((ms / 1000.0).floor() as i64).to_string(), 1),
            'x' => ((ms.floor() as i64).to_string(), 1),
            _ => (c.to_string(), 1),
        };
        out.push_str(&text);
        i += len;
    }
    out
}

/// moment's `fromNow()` in English.
pub fn relative(ms: f64, now_ms: f64) -> String {
    let diff = ms - now_ms;
    let future = diff > 0.0;
    let a = diff.abs();
    let js_round = |x: f64| (x + 0.5).floor();
    let seconds = js_round(a / 1000.0);
    let minutes = js_round(a / 60_000.0);
    let hours = js_round(a / 3_600_000.0);
    let days = js_round(a / MS_PER_DAY);
    let months = js_round(days_to_months(a / MS_PER_DAY));
    let years = js_round(days_to_months(a / MS_PER_DAY) / 12.0);
    let text = if seconds < 45.0 {
        "a few seconds".to_string()
    } else if minutes <= 1.0 {
        "a minute".into()
    } else if minutes < 45.0 {
        format!("{minutes} minutes")
    } else if hours <= 1.0 {
        "an hour".into()
    } else if hours < 22.0 {
        format!("{hours} hours")
    } else if days <= 1.0 {
        "a day".into()
    } else if days < 26.0 {
        format!("{days} days")
    } else if months <= 1.0 {
        "a month".into()
    } else if months < 11.0 {
        format!("{months} months")
    } else if years <= 1.0 {
        "a year".into()
    } else {
        format!("{years} years")
    };
    if future {
        format!("in {text}")
    } else {
        format!("{text} ago")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SGT: i32 = 480;

    #[test]
    fn civil_roundtrip() {
        for z in [-800_000i64, -1, 0, 1, 10_957, 20_000, 2_932_896] {
            let (y, m, d) = civil_from_days(z);
            assert_eq!(days_from_civil(y, m, d), z);
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }

    #[test]
    fn parses_date_forms() {
        let d = parse_date("2025-01-31", 0).unwrap();
        assert_eq!(d.ms, 1_738_281_600_000.0);
        assert!(!d.has_time);
        let t = parse_date("2025-01-31T10:00", 0).unwrap();
        assert_eq!(t.ms, 1_738_281_600_000.0 + 36e5 * 10.0);
        assert!(t.has_time);
        assert_eq!(parse_date("2025-01-31 10:00:00", 0).unwrap().ms, t.ms);
        assert_eq!(parse_date("2025-01-31T10:00:00Z", SGT).unwrap().ms, t.ms);
        assert_eq!(
            parse_date("2025-01-31T17:00:00+07:00", SGT).unwrap().ms,
            t.ms
        );
        assert_eq!(parse_date("2025-01-31T03:00:00-07", SGT).unwrap().ms, t.ms);
        assert_eq!(
            parse_date("2025-01-31T10:00:00.250Z", 0).unwrap().ms,
            t.ms + 250.0
        );
        // local midnight in Singapore is 16:00 the previous day UTC
        assert_eq!(
            parse_date("2025-01-31", SGT).unwrap().ms,
            1_738_281_600_000.0 - 8.0 * 36e5
        );
        assert_eq!(
            parse_date("2025/1/5", 0).unwrap().ms,
            parse_date("2025-01-05", 0).unwrap().ms
        );
    }

    #[test]
    fn rejects_bad_dates() {
        for s in [
            "",
            "hello",
            "2025-13-01",
            "2025-02-30",
            "2025-01-01X",
            "25-01-01",
            "2025-01-01T",
            "2025-01-01T10",
        ] {
            assert!(parse_date(s, 0).is_none(), "{s}");
        }
    }

    #[test]
    fn parses_durations() {
        assert_eq!(
            parse_duration("1d").unwrap(),
            Duration {
                months: 0.0,
                days: 1.0,
                ms: 0.0
            }
        );
        assert_eq!(parse_duration("2 weeks").unwrap().days, 14.0);
        assert_eq!(parse_duration("3h").unwrap().ms, 3.0 * 36e5);
        assert_eq!(parse_duration("1M").unwrap().months, 1.0);
        assert_eq!(parse_duration("1m").unwrap().ms, 60_000.0);
        assert_eq!(parse_duration("1 year").unwrap().months, 12.0);
        assert_eq!(parse_duration("1y 2M").unwrap().months, 14.0);
        assert_eq!(
            parse_duration("1 day, 2 hours").unwrap(),
            Duration {
                months: 0.0,
                days: 1.0,
                ms: 72e5
            }
        );
        assert_eq!(parse_duration("-3 hours").unwrap().ms, -3.0 * 36e5);
        assert_eq!(
            parse_duration("P1Y2M3DT4H5M6S").unwrap(),
            Duration {
                months: 14.0,
                days: 3.0,
                ms: 4.0 * 36e5 + 5.0 * 6e4 + 6e3
            }
        );
        assert_eq!(parse_duration("PT1H").unwrap().ms, 36e5);
        assert!(parse_duration("").is_none());
        assert!(parse_duration("5").is_none());
        assert!(parse_duration("3 fortnights").is_none());
        assert!(parse_duration("hello").is_none());
    }

    #[test]
    fn adds_months_with_clamping() {
        let jan31 = parse_date("2025-01-31", 0).unwrap().ms;
        let r = add_duration(jan31, &parse_duration("1M").unwrap(), 1.0, 0);
        assert_eq!(format_date(r, "YYYY-MM-DD", 0), "2025-02-28");
        let docs = parse_date("2024-12-01", 0).unwrap().ms;
        let mut t = add_duration(docs, &parse_duration("1M").unwrap(), 1.0, 0);
        t = add_duration(t, &parse_duration("4h").unwrap(), 1.0, 0);
        t = add_duration(t, &parse_duration("3m").unwrap(), 1.0, 0);
        assert_eq!(
            format_date(t, "YYYY-MM-DD HH:mm:ss", 0),
            "2025-01-01 04:03:00"
        );
    }

    #[test]
    fn duration_as_units() {
        let d = Duration::from_ms(86_400_000.0 * 1.5);
        assert_eq!(d.as_unit("days"), Some(1.5));
        assert_eq!(d.as_unit("hours"), Some(36.0));
        let m = parse_duration("1M").unwrap();
        assert_eq!(m.as_unit("days"), Some(30.0));
        assert_eq!(parse_duration("1y").unwrap().as_unit("years"), Some(1.0));
    }

    #[test]
    fn humanizes() {
        assert_eq!(parse_duration("1d").unwrap().humanize(), "1 day");
        assert_eq!(
            parse_duration("2h 30m").unwrap().humanize(),
            "2 hours, 30 minutes"
        );
        assert_eq!(Duration::from_ms(-60_000.0).humanize(), "-1 minute");
        assert_eq!(Duration::default().humanize(), "0 seconds");
    }

    #[test]
    fn formats_moment_tokens() {
        // 2025-03-04 05:06:07.089 UTC, a Tuesday
        let ms = parse_date("2025-03-04T05:06:07.089Z", 0).unwrap().ms;
        let f = |s: &str| format_date(ms, s, 0);
        assert_eq!(f("YYYY-MM-DD HH:mm:ss.SSS"), "2025-03-04 05:06:07.089");
        assert_eq!(f("YY M D H h m s"), "25 3 4 5 5 6 7");
        assert_eq!(f("MMM MMMM Mo"), "Mar March 3rd");
        assert_eq!(f("Do DDD DDDD"), "4th 63 063");
        assert_eq!(f("d dd ddd dddd do E"), "2 Tu Tue Tuesday 2nd 2");
        assert_eq!(f("hh A a"), "05 AM am");
        assert_eq!(f("Z ZZ"), "+00:00 +0000");
        assert_eq!(f("X x"), "1741064767 1741064767089");
        assert_eq!(f("[Today is] dddd"), "Today is Tuesday");
        assert_eq!(f("Q Qo"), "1 1st");
        assert_eq!(f("W WW w ww GGGG gggg"), "10 10 10 10 2025 2025");
        assert_eq!(f("k kk"), "5 05");
        assert_eq!(f("L LL LT"), "03/04/2025 March 4, 2025 5:06 AM");
        assert_eq!(f("\\Y YYYY"), "Y 2025");
        assert_eq!(format_date(ms, "HH:mm Z", 480), "13:06 +08:00");
        assert_eq!(format_date(ms, "ZZ", -330), "-0530");
        let pm = parse_date("2025-03-04T12:30:00Z", 0).unwrap().ms;
        assert_eq!(format_date(pm, "h:mm a", 0), "12:30 pm");
        let midnight = parse_date("2025-03-04T00:30:00Z", 0).unwrap().ms;
        assert_eq!(format_date(midnight, "h A k", 0), "12 AM 24");
    }

    #[test]
    fn iso_week_edges() {
        // 2021-01-03 is ISO week 53 of 2020; 2024-12-30 is ISO week 1 of 2025.
        let a = parse_date("2021-01-03", 0).unwrap().ms;
        assert_eq!(format_date(a, "GGGG-[W]WW", 0), "2020-W53");
        let b = parse_date("2024-12-30", 0).unwrap().ms;
        assert_eq!(format_date(b, "GGGG-[W]WW", 0), "2025-W01");
        assert_eq!(ordinal(11), "11th");
        assert_eq!(ordinal(22), "22nd");
        assert_eq!(ordinal(113), "113th");
    }

    #[test]
    fn relative_times() {
        let now = 1_700_000_000_000.0;
        assert_eq!(relative(now - 10_000.0, now), "a few seconds ago");
        assert_eq!(relative(now - 3.0 * MS_PER_DAY, now), "3 days ago");
        assert_eq!(relative(now + 2.0 * 36e5, now), "in 2 hours");
        assert_eq!(relative(now - 40.0 * MS_PER_DAY, now), "a month ago");
        assert_eq!(relative(now - 100.0 * MS_PER_DAY, now), "3 months ago");
        assert_eq!(relative(now - 800.0 * MS_PER_DAY, now), "2 years ago");
        assert_eq!(relative(now - 90_000.0, now), "2 minutes ago");
        assert_eq!(relative(now - 60_000.0, now), "a minute ago");
    }
}
