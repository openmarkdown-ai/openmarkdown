//! Link text: splitting `[[path#sub|alias]]`, the display text derived from
//! it, and the heading normalisation used to match subpaths.

use crate::util::{is_js_ws, js_trim};

pub(crate) struct Wikilink {
    /// The link path including any `#subpath`, without the alias.
    pub href: String,
    /// The alias, or the display text derived from the path.
    pub title: String,
    pub alias: Option<String>,
}

/// The inside of `[[…]]`. The alias starts at the first `|` (a leading `|`
/// is part of the path); a trailing backslash on the path — `[[a\|b]]`, the
/// escaped pipe that Advanced formatting syntax.md prescribes inside tables —
/// is dropped.
pub(crate) fn parse_wikilink(inner: &str) -> Wikilink {
    let (mut path, alias) = match inner.find('|') {
        Some(i) if i > 0 => (js_trim(&inner[..i]).to_string(), Some(js_trim(&inner[i + 1..]).to_string())),
        _ => (js_trim(inner).to_string(), None),
    };
    if path.ends_with('\\') {
        path.pop();
        path = js_trim(&path).to_string();
    }
    let href = normalize_href(&path);
    let title = alias.clone().unwrap_or_else(|| display_text(&href));
    Wikilink { href, title, alias }
}

/// `a#b#c` → `a > b > c`; empty segments vanish, so `#h` → `h` (Internal
/// links.md: `[[Example#Details]]` displays as "Example > Details").
pub fn display_text(path: &str) -> String {
    let parts: Vec<&str> = path.split('#').map(js_trim).filter(|s| !s.is_empty()).collect();
    parts.join(" > ")
}

/// No-break spaces (common in pasted text) become spaces, then trim.
pub(crate) fn normalize_href(s: &str) -> String {
    js_trim(&s.replace('\u{A0}', " ")).to_string()
}

/// Whether a markdown link destination points into the vault: anything
/// without a URL scheme (`https:`, `mailto:`, `obsidian:` …).
pub(crate) fn is_local(url: &str) -> bool {
    let b = url.as_bytes();
    if b.first().map(|c| c.is_ascii_alphabetic()).unwrap_or(false) {
        let n = b.iter().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.')).count();
        // `C:` alone is a Windows drive letter, not a scheme; it cannot link
        // into a vault either way, so treat any scheme-shaped prefix as one.
        if n < b.len() && b[n] == b':' {
            return false;
        }
    }
    !url.starts_with("//")
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_js_ws(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    js_trim(&out).to_string()
}

/// `stripHeading`: "normalizes headings for link matching by stripping out
/// special characters and shrinking consecutive spaces" (obsidian.d.ts).
/// Punctuation that cannot survive in a link becomes a space, then runs of
/// whitespace collapse, so `## A: b` matches `[[#A b]]`.
pub fn strip_heading(heading: &str) -> String {
    let replaced: String = heading
        .chars()
        .map(|c| if "!\"#$%&()*+,.:;<=>?@^`{|}~/[]\\\r\n".contains(c) { ' ' } else { c })
        .collect();
    collapse_ws(&replaced)
}

/// `stripHeadingForLink`: "stripping out some bad combinations of special
/// characters that could break links" — the characters Internal links.md
/// lists as invalid in links (`# | ^ : %% [[ ]]`), plus `\` and line breaks.
pub fn strip_heading_for_link(heading: &str) -> String {
    let mut out = String::with_capacity(heading.len());
    let mut rest = heading;
    while let Some(c) = rest.chars().next() {
        if rest.starts_with("%%") || rest.starts_with("[[") || rest.starts_with("]]") {
            out.push(' ');
            rest = &rest[2..];
            continue;
        }
        out.push(if matches!(c, ':' | '#' | '|' | '^' | '\\' | '\r' | '\n') { ' ' } else { c });
        rest = &rest[c.len_utf8()..];
    }
    collapse_ws(&out)
}

/// `parseLinktext`: split at the first `#` into path and subpath (the subpath
/// keeps its `#`).
pub fn parse_linktext(linktext: &str) -> (String, String) {
    match linktext.find('#') {
        Some(i) => (linktext[..i].to_string(), linktext[i..].to_string()),
        None => (linktext.to_string(), String::new()),
    }
}

/// `getLinkpath`: the path part of a link text.
pub fn get_linkpath(linktext: &str) -> String {
    parse_linktext(linktext).0
}
