//! The JavaScript string semantics the port depends on.
//!
//! The tokenizers are ported from JavaScript, so "whitespace", "trim" and
//! "lower case" mean what `/\s/`, `String.prototype.trim` and `toLowerCase`
//! mean there.
//! Rust's own definitions differ at the edges (U+FEFF, U+0085), and those
//! edges decide whether a line is blank, so every tokenizer goes through here.

/// `/\s/` in a JavaScript RegExp without the `u` flag.
pub(crate) fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `.` in a JavaScript RegExp: anything but a line terminator.
pub(crate) fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

pub(crate) fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_ws)
}

pub(crate) fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_ws)
}

/// The byte at `i`, or 0 past the end — the port's stand-in for
/// `charAt(i) === ""`. No tokenizer compares against NUL, so the sentinel is
/// unambiguous for the ASCII comparisons it is used in.
#[inline]
pub(crate) fn byte(s: &str, i: usize) -> u8 {
    *s.as_bytes().get(i).unwrap_or(&0)
}

/// The char starting at byte `i` (None past the end or mid-character).
#[inline]
pub(crate) fn char_at(s: &str, i: usize) -> Option<char> {
    s.get(i..).and_then(|r| r.chars().next())
}

/// Byte length of the char at `i` (1 when `i` is not a char boundary, so a
/// loop stepping through the string always makes progress).
#[inline]
pub(crate) fn char_len(s: &str, i: usize) -> usize {
    char_at(s, i).map(|c| c.len_utf8()).unwrap_or(1)
}

/// Whether the char at byte `i` is JavaScript whitespace.
#[inline]
pub(crate) fn ws_at(s: &str, i: usize) -> bool {
    char_at(s, i).map(is_js_ws).unwrap_or(false)
}

/// `s.indexOf(pat, from)` in bytes. Safe for any `from`, including one in the
/// middle of a multi-byte character, because the patterns are ASCII.
pub(crate) fn index_of(s: &str, pat: &str, from: usize) -> Option<usize> {
    let hay = s.as_bytes();
    let p = pat.as_bytes();
    if from > hay.len() || p.len() > hay.len() {
        return None;
    }
    if p.len() == 1 {
        return hay[from..].iter().position(|&b| b == p[0]).map(|i| i + from);
    }
    let last = hay.len() - p.len();
    let mut i = from;
    while i <= last {
        if &hay[i..i + p.len()] == p {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// A slice that tolerates the out-of-order and out-of-range bounds that
/// `String.prototype.slice` quietly accepts.
pub(crate) fn js_slice(s: &str, start: usize, end: usize) -> &str {
    let end = end.min(s.len());
    if start >= end {
        return "";
    }
    let mut a = start;
    while a < end && !s.is_char_boundary(a) {
        a += 1;
    }
    let mut b = end;
    while b > a && !s.is_char_boundary(b) {
        b -= 1;
    }
    &s[a..b]
}

pub(crate) fn is_decimal(b: u8) -> bool {
    b.is_ascii_digit()
}

pub(crate) fn is_alphabetical(b: u8) -> bool {
    b.is_ascii_alphabetic()
}

/// `/\w/`.
pub(crate) fn is_word_char(c: Option<char>) -> bool {
    matches!(c, Some(c) if c.is_ascii_alphanumeric() || c == '_')
}

/// `String.prototype.toLowerCase`. Rust's `to_lowercase` implements the same
/// Unicode default case mapping, final-sigma rule included.
pub(crate) fn js_lower(s: &str) -> String {
    s.to_lowercase()
}

/// UTF-16 length, the unit every JavaScript `length` counts.
pub(crate) fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `decodeURI`: percent-decodes UTF-8 sequences, except those that decode to a
/// character in the reserved set (so an encoded `%23` stays a literal `#` in
/// a file name instead of becoming a heading subpath), and fails on anything
/// malformed.
pub(crate) fn decode_uri(s: &str) -> Result<String, ()> {
    if !s.contains('%') {
        return Ok(s.to_string());
    }
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let hex = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let read = |j: usize| -> Result<u8, ()> {
            match (b.get(j + 1).and_then(|&c| hex(c)), b.get(j + 2).and_then(|&c| hex(c))) {
                (Some(h), Some(l)) => Ok(h * 16 + l),
                _ => Err(()),
            }
        };
        let first = read(i)?;
        if first < 0x80 {
            let c = first as char;
            if ";/?:@&=+$,#".contains(c) {
                out.extend_from_slice(&b[i..i + 3]);
            } else {
                out.push(first);
            }
            i += 3;
            continue;
        }
        let n = if first & 0xE0 == 0xC0 {
            2
        } else if first & 0xF0 == 0xE0 {
            3
        } else if first & 0xF8 == 0xF0 {
            4
        } else {
            return Err(());
        };
        let mut bytes = vec![first];
        let mut j = i + 3;
        for _ in 1..n {
            if b.get(j) != Some(&b'%') {
                return Err(());
            }
            let c = read(j)?;
            if c & 0xC0 != 0x80 {
                return Err(());
            }
            bytes.push(c);
            j += 3;
        }
        match std::str::from_utf8(&bytes) {
            Ok(st) => out.extend_from_slice(st.as_bytes()),
            Err(_) => return Err(()),
        }
        i = j;
    }
    String::from_utf8(out).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_uri_matches_javascript() {
        assert_eq!(decode_uri("Note%20A.md"), Ok("Note A.md".into()));
        assert_eq!(decode_uri("a%23b"), Ok("a%23b".into()));
        assert_eq!(decode_uri("caf%C3%A9"), Ok("café".into()));
        assert_eq!(decode_uri("100%"), Err(()));
        assert_eq!(decode_uri("%E0%A4%A"), Err(()));
        assert_eq!(decode_uri("%FF"), Err(()));
    }

    #[test]
    fn js_whitespace_includes_bom_but_not_nel() {
        assert!(is_js_ws('\u{FEFF}'));
        assert!(!is_js_ws('\u{85}'));
        assert_eq!(js_trim("\u{A0} x \u{3000}"), "x");
    }
}
