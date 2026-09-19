//! HTML character references, decoded the way `parse-entities` (v2, MIT)
//! does it for remark-parse 8.
//!
//! Markdown text, link destinations and titles all go through this. The rules
//! that matter are the legacy ones: `&copy` decodes without a semicolon in
//! text but not in a URL, `&notit;` decodes to `¬it;`, and an unknown
//! reference is left exactly as written.

#[path = "entities_data.rs"]
mod data;

pub(crate) enum Chunk<'a> {
    /// Literal text, exactly as written.
    Text(&'a str),
    /// A decoded reference and the source it replaced.
    Ref { value: String, source: &'a str },
}

fn named(name: &str) -> Option<&'static str> {
    let n = data::NAME_ENDS.len();
    let (mut lo, mut hi) = (0usize, n);
    let name_at = |i: usize| {
        let s = if i == 0 { 0 } else { data::NAME_ENDS[i - 1] as usize };
        &data::NAMES[s..data::NAME_ENDS[i] as usize]
    };
    while lo < hi {
        let mid = (lo + hi) / 2;
        match name_at(mid).cmp(name) {
            std::cmp::Ordering::Less => lo = mid + 1,
            std::cmp::Ordering::Greater => hi = mid,
            std::cmp::Ordering::Equal => {
                let s = if mid == 0 { 0 } else { data::VALUE_ENDS[mid - 1] as usize };
                return Some(&data::VALUES[s..data::VALUE_ENDS[mid] as usize]);
            }
        }
    }
    None
}

fn legacy(name: &str) -> Option<&'static str> {
    data::LEGACY.binary_search_by(|(k, _)| k.cmp(&name)).ok().map(|i| data::LEGACY[i].1)
}

/// Split `s` into literal text and decoded references.
///
/// `non_terminated` is `parse-entities`' option of the same name: text allows
/// references without a semicolon, destinations and titles do not.
pub(crate) fn chunks(s: &str, non_terminated: bool) -> Vec<Chunk<'_>> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut text_start = 0usize;
    let mut m = 0usize;
    while m < b.len() {
        if b[m] != b'&' {
            m += 1;
            continue;
        }
        let next = b.get(m + 1).copied();
        if matches!(next, None | Some(9) | Some(10) | Some(12) | Some(32) | Some(38) | Some(60)) {
            m += 1;
            continue;
        }
        let f = m + 1;
        let mut d = f;
        #[derive(PartialEq)]
        enum Kind {
            Named,
            Dec,
            Hex,
        }
        let kind = if next == Some(b'#') {
            d += 1;
            if matches!(b.get(d), Some(b'x') | Some(b'X')) {
                d += 1;
                Kind::Hex
            } else {
                Kind::Dec
            }
        } else {
            Kind::Named
        };
        let mut g = d;
        let mut legacy_name = "";
        let mut value: Option<&'static str> = None;
        while g < b.len() {
            let c = b[g];
            let ok = match kind {
                Kind::Named => c.is_ascii_alphanumeric(),
                Kind::Dec => c.is_ascii_digit(),
                Kind::Hex => c.is_ascii_hexdigit(),
            };
            if !ok {
                break;
            }
            g += 1;
            if kind == Kind::Named {
                if let Some(v) = legacy(&s[d..g]) {
                    legacy_name = &s[d..g];
                    value = Some(v);
                }
            }
        }
        let run = &s[d..g];
        let mut terminated = b.get(g) == Some(&b';');
        if terminated {
            g += 1;
            if kind == Kind::Named {
                if let Some(v) = named(run) {
                    legacy_name = run;
                    value = Some(v);
                }
            }
        }
        let mut decoded = String::new();
        if (terminated || non_terminated) && !run.is_empty() {
            if kind == Kind::Named {
                if !(terminated && value.is_none()) && legacy_name != run {
                    g = d + legacy_name.len();
                    terminated = false;
                }
                let _ = terminated;
                decoded = value.unwrap_or("").to_string();
            } else {
                let radix = if kind == Kind::Hex { 16 } else { 10 };
                // parseInt on a long digit run overflows to a huge float; any
                // value that large is out of range, which is all that matters.
                let code = u64::from_str_radix(run, radix).unwrap_or(u64::MAX);
                decoded = if (0xD800..=0xDFFF).contains(&code) || code > 0x10FFFF {
                    '\u{FFFD}'.to_string()
                } else if let Some((_, c)) = data::INVALID.iter().find(|(k, _)| *k as u64 == code) {
                    (*c).to_string()
                } else {
                    char::from_u32(code as u32).map(|c| c.to_string()).unwrap_or_default()
                };
            }
        }
        if decoded.is_empty() {
            // Not a reference after all: the characters stay in the text run.
            m = g.max(m + 1);
            continue;
        }
        if text_start < m {
            out.push(Chunk::Text(&s[text_start..m]));
        }
        out.push(Chunk::Ref { value: decoded, source: &s[m..g] });
        text_start = g;
        m = g;
    }
    if text_start < b.len() {
        out.push(Chunk::Text(&s[text_start..]));
    }
    out
}

pub(crate) fn decode(s: &str, non_terminated: bool) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    for c in chunks(s, non_terminated) {
        match c {
            Chunk::Text(t) => out.push_str(t),
            Chunk::Ref { value, .. } => out.push_str(&value),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn named_numeric_and_legacy_references() {
        assert_eq!(decode("a &amp; b", true), "a & b");
        assert_eq!(decode("&copy 2024", true), "© 2024");
        assert_eq!(decode("&copy 2024", false), "&copy 2024");
        assert_eq!(decode("&notit;", true), "¬it;");
        assert_eq!(decode("&bogus;", true), "&bogus;");
        assert_eq!(decode("&#x1F600;&#65;&#0;&#128;", true), "😀A\u{FFFD}€");
        assert_eq!(decode("AT&T", true), "AT&T");
        assert_eq!(decode("&zwj;", true), "\u{200D}");
    }
}
