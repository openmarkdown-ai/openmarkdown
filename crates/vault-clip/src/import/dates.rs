//! The date handling importers need, without a clock or a timezone database.
//!
//! Exports write dates in a handful of shapes: Evernote's `20240102T030405Z`,
//! ISO 8601 from Bear and Keep, Notion's `March 1, 2024 3:45 PM`, Roam's daily
//! page titles `January 2nd, 2024`. They are parsed here into civil dates and
//! epoch milliseconds (all UTC: an export carries no reliable zone, and a note
//! imported on another machine must not change its date), and daily-note names
//! are formatted with the subset of moment.js tokens Obsidian's daily-notes
//! setting uses.

pub const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
];
pub const WEEKDAYS: [&str; 7] = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/// Days since 1970-01-01 for a proleptic Gregorian date.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

pub fn valid_date(y: i64, m: u32, d: u32) -> bool {
    (1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m)
}

pub fn to_ms(y: i64, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
    (days_from_civil(y, mo, d) * 86_400 + h as i64 * 3600 + mi as i64 * 60 + s as i64) * 1000
}

/// `(year, month, day, hour, minute, second)` of epoch milliseconds, UTC.
pub fn from_ms(ms: i64) -> (i64, u32, u32, u32, u32, u32) {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    (y, m, d, (rem / 3600) as u32, (rem % 3600 / 60) as u32, (rem % 60) as u32)
}

/// `YYYY-MM-DDTHH:mm:ss` (the importer's `dateFormat` and Bear's
/// `toISOString().slice(0, 19)`).
pub fn iso_seconds(ms: i64) -> String {
    let (y, m, d, h, mi, s) = from_ms(ms);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}")
}

pub fn iso_date(y: i64, m: u32, d: u32) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

/// Evernote's `20240102T030405Z` (the `Z` optional).
pub fn parse_enex_date(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 15 || b[8] != b'T' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<u32>().ok();
    let (y, mo, d) = (num(0..4)? as i64, num(4..6)?, num(6..8)?);
    let (h, mi, sec) = (num(9..11)?, num(11..13)?, num(13..15)?);
    if !valid_date(y, mo, d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    Some(to_ms(y, mo, d, h, mi, sec))
}

/// ISO 8601: `YYYY-MM-DD`, optionally `THH:MM[:SS[.fff]]` (or a space), and
/// an optional `Z` or `±HH[:MM]` offset, which is applied.
pub fn parse_iso(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let t = s.get(r)?;
        if t.bytes().all(|c| c.is_ascii_digit()) {
            t.parse().ok()
        } else {
            None
        }
    };
    let (y, mo, d) = (num(0..4)? as i64, num(5..7)?, num(8..10)?);
    if !valid_date(y, mo, d) {
        return None;
    }
    if b.len() == 10 {
        return Some(to_ms(y, mo, d, 0, 0, 0));
    }
    if b[10] != b'T' && b[10] != b' ' {
        return None;
    }
    let h = num(11..13)?;
    if b.get(13) != Some(&b':') {
        return None;
    }
    let mi = num(14..16)?;
    let mut i = 16;
    let mut sec = 0;
    let mut millis = 0i64;
    if b.get(i) == Some(&b':') {
        sec = num(17..19)?;
        i = 19;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            let mut end = start;
            while end < b.len() && b[end].is_ascii_digit() {
                end += 1;
            }
            let frac = &s[start..end];
            let padded = format!("{:0<3}", &frac[..frac.len().min(3)]);
            millis = padded.parse().unwrap_or(0);
            i = end;
        }
    }
    let mut ms = to_ms(y, mo, d, h, mi, sec) + millis;
    match b.get(i) {
        None | Some(b'Z') | Some(b'z') => {}
        Some(b'+') | Some(b'-') => {
            let sign = if b[i] == b'+' { 1 } else { -1 };
            let oh = num(i + 1..i + 3)? as i64;
            let om = if b.get(i + 3) == Some(&b':') {
                num(i + 4..i + 6).unwrap_or(0)
            } else {
                num(i + 3..i + 5).unwrap_or(0)
            } as i64;
            ms -= sign * (oh * 3600 + om * 60) * 1000;
        }
        _ => {}
    }
    Some(ms)
}

fn month_from_name(name: &str) -> Option<u32> {
    let lower = name.trim_end_matches('.').to_ascii_lowercase();
    if lower.len() < 3 {
        return None;
    }
    MONTHS
        .iter()
        .position(|m| {
            let m = m.to_ascii_lowercase();
            m.starts_with(&lower) || (lower == "sept" && m == "september")
        })
        .map(|i| i as u32 + 1)
}

/// A date with an optional time of day, parsed from English text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CivilDateTime {
    pub year: i64,
    pub month: u32,
    pub day: u32,
    pub time: Option<(u32, u32)>,
}

impl CivilDateTime {
    pub fn iso_date(&self) -> String {
        iso_date(self.year, self.month, self.day)
    }

    pub fn ms(&self) -> i64 {
        let (h, m) = self.time.unwrap_or((0, 0));
        to_ms(self.year, self.month, self.day, h, m, 0)
    }
}

/// Parse the English date shapes exports write: `March 1, 2024`,
/// `Mar 1 2024`, `January 2nd, 2024`, `1 March 2024`, `2024/03/01`,
/// `2024-03-01`, each optionally followed by `3:45 PM` or `15:45`, and with
/// Notion's leading `@` ignored. `(ignored → …)` ranges keep their start.
pub fn parse_english(s: &str) -> Option<CivilDateTime> {
    let s = s.trim().trim_start_matches('@').trim();
    let s = s.split(" → ").next().unwrap_or(s);
    let cleaned: String = s
        .chars()
        .map(|c| if c == ',' { ' ' } else { c })
        .collect();
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    if words.is_empty() {
        return None;
    }
    let ordinal = |w: &str| -> Option<u32> {
        let digits = w
            .trim_end_matches("st")
            .trim_end_matches("nd")
            .trim_end_matches("rd")
            .trim_end_matches("th");
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || digits.len() > 2 {
            return None;
        }
        digits.parse().ok()
    };
    let year = |w: &str| -> Option<i64> {
        if w.len() == 4 && w.bytes().all(|b| b.is_ascii_digit()) {
            w.parse().ok()
        } else {
            None
        }
    };
    let (y, m, d, rest) = if let Some(month) = month_from_name(words[0]) {
        // Month Day Year
        let day = ordinal(words.get(1)?)?;
        let yr = year(words.get(2)?)?;
        (yr, month, day, &words[3..])
    } else if let (Some(day), Some(month)) = (
        ordinal(words[0]),
        words.get(1).and_then(|w| month_from_name(w)),
    ) {
        let yr = year(words.get(2)?)?;
        (yr, month, day, &words[3..])
    } else if words[0].len() == 10 && (words[0].contains('/') || words[0].contains('-')) {
        let parts: Vec<&str> = words[0].split(['/', '-']).collect();
        if parts.len() != 3 || parts[0].len() != 4 {
            return None;
        }
        (
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
            &words[1..],
        )
    } else {
        return None;
    };
    if !valid_date(y, m, d) {
        return None;
    }
    let mut time = None;
    if let Some(t) = rest.first() {
        if let Some((h, mi)) = t.split_once(':') {
            if let (Ok(mut h), Ok(mi)) = (h.parse::<u32>(), mi[..mi.len().min(2)].parse::<u32>()) {
                match rest.get(1).map(|w| w.to_ascii_uppercase()) {
                    Some(ref p) if p == "PM" && h < 12 => h += 12,
                    Some(ref p) if p == "AM" && h == 12 => h = 0,
                    _ => {}
                }
                if h < 24 && mi < 60 {
                    time = Some((h, mi));
                }
            }
        }
    }
    Some(CivilDateTime {
        year: y,
        month: m,
        day: d,
        time,
    })
}

/// Roam's exact daily-page title form, `MMMM Do, YYYY` ("January 2nd, 2024").
/// Unlike [`parse_english`] this is strict: moment's check that formatting the
/// parsed date gives back the input is what keeps "May 5, 2020" a page name.
pub fn parse_roam_daily_title(s: &str) -> Option<(i64, u32, u32)> {
    let (month_name, rest) = s.split_once(' ')?;
    let month = MONTHS.iter().position(|m| *m == month_name)? as u32 + 1;
    let (day_part, year_part) = rest.split_once(", ")?;
    let d = ordinal_day(day_part)?;
    if year_part.len() != 4 || !year_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let y: i64 = year_part.parse().ok()?;
    if !valid_date(y, month, d) || format_moment(y, month, d, "MMMM Do, YYYY") != s {
        return None;
    }
    Some((y, month, d))
}

fn ordinal_day(s: &str) -> Option<u32> {
    let n = s.len();
    if n < 3 {
        return None;
    }
    let (digits, suffix) = s.split_at(n - 2);
    if !digits.bytes().all(|b| b.is_ascii_digit()) || digits.is_empty() {
        return None;
    }
    let d: u32 = digits.parse().ok()?;
    (ordinal_suffix(d) == suffix).then_some(d)
}

pub fn ordinal_suffix(d: u32) -> &'static str {
    match (d % 10, d % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    }
}

/// Format a date with moment.js tokens: `YYYY YY MMMM MMM MM M DD D Do dddd
/// ddd dd d`, and `[literal]` escapes. Anything else is copied.
pub fn format_moment(y: i64, m: u32, d: u32, fmt: &str) -> String {
    let weekday = (days_from_civil(y, m, d) + 4).rem_euclid(7) as usize;
    let mut out = String::new();
    let chars: Vec<char> = fmt.chars().collect();
    let mut i = 0;
    let starts = |i: usize, tok: &str| {
        let t: Vec<char> = tok.chars().collect();
        chars.len() >= i + t.len() && chars[i..i + t.len()] == t[..]
    };
    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(end) = chars[i + 1..].iter().position(|c| *c == ']') {
                out.extend(&chars[i + 1..i + 1 + end]);
                i += end + 2;
                continue;
            }
        }
        let (tok, text): (&str, String) = if starts(i, "YYYY") {
            ("YYYY", format!("{y:04}"))
        } else if starts(i, "YY") {
            ("YY", format!("{:02}", y.rem_euclid(100)))
        } else if starts(i, "MMMM") {
            ("MMMM", MONTHS[m as usize - 1].to_string())
        } else if starts(i, "MMM") {
            ("MMM", MONTHS[m as usize - 1][..3].to_string())
        } else if starts(i, "MM") {
            ("MM", format!("{m:02}"))
        } else if starts(i, "M") {
            ("M", m.to_string())
        } else if starts(i, "DD") {
            ("DD", format!("{d:02}"))
        } else if starts(i, "Do") {
            ("Do", format!("{d}{}", ordinal_suffix(d)))
        } else if starts(i, "D") {
            ("D", d.to_string())
        } else if starts(i, "dddd") {
            ("dddd", WEEKDAYS[weekday].to_string())
        } else if starts(i, "ddd") {
            ("ddd", WEEKDAYS[weekday][..3].to_string())
        } else if starts(i, "dd") {
            ("dd", WEEKDAYS[weekday][..2].to_string())
        } else if starts(i, "d") {
            ("d", weekday.to_string())
        } else {
            out.push(chars[i]);
            i += 1;
            continue;
        };
        out.push_str(&text);
        i += tok.chars().count();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip_and_iso() {
        for days in [-1_000_000, -1, 0, 1, 19_000, 2_000_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(iso_seconds(0), "1970-01-01T00:00:00");
        assert_eq!(parse_enex_date("20240102T030405Z").map(iso_seconds).unwrap(), "2024-01-02T03:04:05");
        assert_eq!(parse_enex_date("2024-01-02"), None);
    }

    #[test]
    fn parses_iso_with_offsets() {
        assert_eq!(parse_iso("2023-10-11T08:10:40Z").map(iso_seconds).unwrap(), "2023-10-11T08:10:40");
        assert_eq!(parse_iso("2023-10-11T10:10:40+02:00").map(iso_seconds).unwrap(), "2023-10-11T08:10:40");
        assert_eq!(parse_iso("2023-10-11T08:10:40.5Z").unwrap() % 1000, 500);
        assert_eq!(parse_iso("2023-10-11").map(iso_seconds).unwrap(), "2023-10-11T00:00:00");
        assert_eq!(parse_iso("2023-02-30"), None);
        assert_eq!(parse_iso("not a date"), None);
    }

    #[test]
    fn parses_english_dates() {
        let p = |s: &str| parse_english(s).map(|c| (c.iso_date(), c.time));
        assert_eq!(p("March 1, 2024"), Some(("2024-03-01".into(), None)));
        assert_eq!(p("@December 4, 2024 8:45 AM"), Some(("2024-12-04".into(), Some((8, 45)))));
        assert_eq!(p("Dec 4, 2024 12:05 PM"), Some(("2024-12-04".into(), Some((12, 5)))));
        assert_eq!(p("January 2nd, 2024"), Some(("2024-01-02".into(), None)));
        assert_eq!(p("15 Sept 2023"), Some(("2023-09-15".into(), None)));
        assert_eq!(p("2024/03/01 15:45"), Some(("2024-03-01".into(), Some((15, 45)))));
        assert_eq!(p("March 1, 2024 → March 3, 2024"), Some(("2024-03-01".into(), None)));
        assert_eq!(p("Mayday 1, 2024"), None);
        assert_eq!(p("February 30, 2024"), None);
    }

    #[test]
    fn roam_titles_are_strict() {
        assert_eq!(parse_roam_daily_title("January 2nd, 2024"), Some((2024, 1, 2)));
        assert_eq!(parse_roam_daily_title("March 11th, 2021"), Some((2021, 3, 11)));
        assert_eq!(parse_roam_daily_title("March 11st, 2021"), None);
        assert_eq!(parse_roam_daily_title("May 5, 2020"), None);
        assert_eq!(parse_roam_daily_title("Jan 2nd, 2024"), None);
    }

    #[test]
    fn formats_moment_tokens() {
        assert_eq!(format_moment(2024, 1, 2, "YYYY-MM-DD"), "2024-01-02");
        assert_eq!(format_moment(2024, 1, 2, "dddd, MMMM Do YYYY"), "Tuesday, January 2nd 2024");
        assert_eq!(format_moment(2024, 11, 3, "[Week of] D MMM YY"), "Week of 3 Nov 24");
    }
}
