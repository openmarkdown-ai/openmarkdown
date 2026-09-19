//! Small string and path helpers shared by every module.
//!
//! Obsidian's own helpers are one-liners over JavaScript strings; the names in
//! the comments are what they do there so the mapping stays checkable. Paths
//! are vault-relative with `/` separators and no leading slash, exactly like
//! `TFile.path`.

use std::borrow::Cow;
use std::cmp::Ordering;

/// File name: everything after the last `/`.
pub fn basename(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

/// Parent folder path, `""` for the vault root.
pub fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

/// Lower-cased extension of the last path segment's name, `""` when there is
/// none. A leading dot (`.hidden`) and a trailing dot (`name.`) are not
/// extensions.
pub fn extension(path: &str) -> String {
    match path.rfind('.') {
        Some(i) if i != 0 && i != path.len() - 1 && !path[i..].contains('/') => {
            path[i + 1..].to_lowercase()
        }
        _ => String::new(),
    }
}

/// `TFile.basename`: the file name without its extension.
pub fn stem(path: &str) -> &str {
    let name = basename(path);
    match name.rfind('.') {
        Some(i) if i != 0 && i != name.len() - 1 => &name[..i],
        _ => name,
    }
}

/// The path without its extension (only the final segment is considered).
pub fn strip_extension(path: &str) -> &str {
    match path.rfind('.') {
        Some(i) if i != 0 && i != path.len() - 1 && !path[i..].contains('/') => &path[..i],
        _ => path,
    }
}

/// The path without `.md` when it is a note, otherwise unchanged.
pub fn strip_md(path: &str) -> &str {
    if extension(basename(path)) == "md" {
        strip_extension(path)
    } else {
        path
    }
}

/// How a file is named in link text: a note's basename, any other file's
/// full name.
pub fn display_name(path: &str) -> &str {
    let name = basename(path);
    if extension(name) == "md" {
        stem(name)
    } else {
        name
    }
}

/// `getLinkpath`: the link text up to the first `#`.
pub fn strip_subpath(link: &str) -> &str {
    match link.find('#') {
        Some(i) => &link[..i],
        None => link,
    }
}

/// `parseLinktext`: `(path, subpath)` where subpath keeps its `#`.
pub fn split_subpath(link: &str) -> (&str, &str) {
    match link.find('#') {
        Some(i) => (&link[..i], &link[i..]),
        None => (link, ""),
    }
}

pub fn is_note(path: &str) -> bool {
    extension(path) == "md"
}

/// Files Obsidian indexes as documents rather than attachments.
pub fn is_document_ext(ext: &str) -> bool {
    matches!(ext, "md" | "canvas" | "base")
}

/// `isSupportedFile` with "Detect all file extensions" off.
pub fn is_supported_ext(ext: &str) -> bool {
    matches!(
        ext,
        "md" | "canvas"
            | "base"
            | "bmp"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "svg"
            | "webp"
            | "avif"
            | "mp3"
            | "wav"
            | "m4a"
            | "3gp"
            | "flac"
            | "ogg"
            | "oga"
            | "opus"
            | "mp4"
            | "webm"
            | "ogv"
            | "mov"
            | "mkv"
            | "pdf"
    )
}

/// Length in UTF-16 code units.
pub fn utf16_len(s: &str) -> u32 {
    if s.is_ascii() {
        s.len() as u32
    } else {
        s.chars().map(|c| c.len_utf16() as u32).sum()
    }
}

/// UTF-16 offset of byte offset `byte` in `s`.
pub fn u16_at(s: &str, byte: usize) -> u32 {
    utf16_len(&s[..byte.min(s.len())])
}

/// Byte offset of UTF-16 offset `u` in `s` (clamped; a position inside a
/// surrogate pair rounds up to the next character).
pub fn byte_at_u16(s: &str, u: u32) -> usize {
    if s.is_ascii() {
        return (u as usize).min(s.len());
    }
    let mut acc = 0u32;
    for (i, c) in s.char_indices() {
        if acc >= u {
            return i;
        }
        acc += c.len_utf16() as u32;
    }
    s.len()
}

/// Converts many byte offsets into one string to UTF-16 in a single forward
/// pass. Offsets need not be sorted.
pub struct U16Mapper<'a> {
    s: &'a str,
    ascii: bool,
}

impl<'a> U16Mapper<'a> {
    pub fn new(s: &'a str) -> Self {
        U16Mapper {
            s,
            ascii: s.is_ascii(),
        }
    }

    pub fn map(&self, ranges: &[[usize; 2]]) -> Vec<[u32; 2]> {
        if self.ascii {
            return ranges.iter().map(|r| [r[0] as u32, r[1] as u32]).collect();
        }
        let mut points: Vec<(usize, usize)> = Vec::with_capacity(ranges.len() * 2);
        for (i, r) in ranges.iter().enumerate() {
            points.push((r[0], i * 2));
            points.push((r[1], i * 2 + 1));
        }
        points.sort_unstable();
        let mut out = vec![[0u32; 2]; ranges.len()];
        let mut byte = 0usize;
        let mut u = 0u32;
        let mut chars = self.s.char_indices().peekable();
        for (target, slot) in points {
            let target = target.min(self.s.len());
            while byte < target {
                match chars.next() {
                    Some((_, c)) => {
                        byte += c.len_utf8();
                        u += c.len_utf16() as u32;
                    }
                    None => break,
                }
            }
            out[slot / 2][slot % 2] = u;
        }
        out
    }

    pub fn one(&self, byte: usize) -> u32 {
        if self.ascii {
            byte as u32
        } else {
            u16_at(self.s, byte)
        }
    }
}

/// Lower-cases `s` character by character, keeping a character unchanged
/// whenever its lower-case form has a different UTF-8 length (or is more than
/// one character). The result has exactly the same byte offsets as `s`, so a
/// match found in the folded text is a match at the same offsets in the
/// original. JavaScript's `i` flag folds per code unit in much the same way;
/// the characters this skips (`İ`, the Kelvin sign) fold differently there
/// too.
pub fn fold(s: &str) -> String {
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        out.push(fold_char(c));
    }
    out
}

pub fn fold_char(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) if l.len_utf8() == c.len_utf8() => l,
        _ => c,
    }
}

/// Non-overlapping occurrences of `needle` in `hay`, left to right, as byte
/// ranges. `hay_fold` must be `fold(hay)` (only read when needed) and
/// `needle` already folded when `case_sensitive` is false.
pub fn find_all<'f>(
    hay: &str,
    hay_fold: impl FnOnce() -> Cow<'f, str>,
    needle: &str,
    case_sensitive: bool,
) -> Vec<[usize; 2]> {
    let mut out = Vec::new();
    if needle.is_empty() || needle.len() > hay.len() {
        return out;
    }
    if case_sensitive {
        for (i, m) in hay.match_indices(needle) {
            out.push([i, i + m.len()]);
        }
    } else if needle.is_ascii() {
        // ASCII needle: compare bytes case-insensitively on the raw text. A
        // non-ASCII byte can never equal an ASCII needle byte, and `fold`
        // never maps a multi-byte character to ASCII, so this is exact.
        let (h, n) = (hay.as_bytes(), needle.as_bytes());
        let mut i = 0usize;
        while let Some(p) = find_ascii_ci(h, n, i) {
            out.push([p, p + n.len()]);
            i = p + n.len();
        }
    } else {
        let folded = hay_fold();
        for (i, m) in folded.match_indices(needle) {
            out.push([i, i + m.len()]);
        }
    }
    out
}

/// The letter-or-digit class Obsidian uses for whole-word matching of quoted
/// search terms and unlinked mentions (`NA` in the app: Unicode letters and
/// decimal digits, *excluding* CJK ideographs, kana and Hangul, and excluding
/// `_`). Approximated with `char::is_alphanumeric` minus those scripts.
pub fn is_word_char(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphanumeric();
    }
    if is_cjk_word_exempt(c) {
        return false;
    }
    c.is_alphanumeric()
}

fn is_cjk_word_exempt(c: char) -> bool {
    matches!(c as u32,
        0x0F00 | 0x0F40..=0x0F6C | 0x0F88..=0x0F8C
        | 0x3041..=0x3096 | 0x309D..=0x309F | 0x30A1..=0x30FA | 0x30FC..=0x30FF
        | 0x4E00..=0x9FFF | 0xAC00..=0xD7A3 | 0xA960..=0xA97C | 0xD7B0..=0xD7C6
        | 0x20000..=0x3FFFF)
}

fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Occurrences of `needle` as a whole word, reproducing the JavaScript regex
/// Obsidian builds for it (`VA` in the app):
/// `(?:^|[^W])(needle)(?![W])`, where the prefix only applies when the
/// needle starts with a word character and the lookahead only when it ends
/// with one. The prefix *consumes* the preceding character, so — as in the
/// app — a second occurrence that starts right where the previous match
/// ended is only found when it is at a line start.
pub fn find_whole_word<'f>(
    hay: &str,
    hay_fold: impl FnOnce() -> Cow<'f, str>,
    needle: &str,
    case_sensitive: bool,
    multiline: bool,
) -> Vec<[usize; 2]> {
    let (Some(first), Some(last)) = (needle.chars().next(), needle.chars().next_back()) else {
        return Vec::new();
    };
    let folded_needle = if case_sensitive {
        needle.to_string()
    } else {
        fold(needle)
    };
    let ascii_ci = !case_sensitive && needle.is_ascii();
    let folded_hay: Option<Cow<str>> = if case_sensitive || ascii_ci {
        None
    } else {
        Some(hay_fold())
    };
    let base: &str = folded_hay.as_deref().unwrap_or(hay);
    // Next (possibly overlapping) occurrence at or after byte `from`.
    let next = |from: usize| -> Option<usize> {
        if from > base.len() {
            return None;
        }
        if ascii_ci {
            find_ascii_ci(base.as_bytes(), folded_needle.as_bytes(), from)
        } else {
            base[from..].find(folded_needle.as_str()).map(|i| i + from)
        }
    };
    let first_word = is_word_char(first);
    let last_word = is_word_char(last);
    let mut out = Vec::new();
    let mut last_index = 0usize;
    let mut from = 0usize;
    while let Some(p) = next(from) {
        // Advance one character for the next overlapping probe.
        from = p + base[p..].chars().next().map_or(1, |c| c.len_utf8());
        if p < last_index {
            continue;
        }
        let end = p + needle.len();
        if first_word && p > 0 {
            let prev = hay[..p].chars().next_back().unwrap();
            let prev_start = p - prev.len_utf8();
            let via_caret = multiline && is_js_line_terminator(prev);
            let via_char = prev_start >= last_index && !is_word_char(prev);
            if !via_caret && !via_char {
                continue;
            }
        }
        if last_word {
            if let Some(next) = hay[end..].chars().next() {
                if is_word_char(next) {
                    continue;
                }
            }
        }
        out.push([p, end]);
        last_index = end;
        from = end;
    }
    out
}

/// First ASCII-case-insensitive occurrence of `n` in `h` at or after `from`.
pub fn find_ascii_ci(h: &[u8], n: &[u8], from: usize) -> Option<usize> {
    if n.is_empty() || n.len() > h.len() {
        return None;
    }
    let first = n[0].to_ascii_lowercase();
    let first_up = n[0].to_ascii_uppercase();
    let last = h.len() - n.len();
    let mut i = from;
    while i <= last {
        let b = h[i];
        if (b == first || b == first_up) && h[i..i + n.len()].eq_ignore_ascii_case(n) {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// `Array` of ranges merged the way Obsidian's `Gy` does: sorted by start,
/// touching or overlapping ranges joined.
pub fn merge_ranges<T: Copy + Ord>(mut v: Vec<[T; 2]>) -> Vec<[T; 2]> {
    if v.len() < 2 {
        return v;
    }
    v.sort_by(|a, b| a[0].cmp(&b[0]));
    let mut out: Vec<[T; 2]> = Vec::with_capacity(v.len());
    for r in v {
        match out.last_mut() {
            Some(last) if !(last[1] < r[0]) => {
                if last[1] < r[1] {
                    last[1] = r[1];
                }
            }
            _ => out.push(r),
        }
    }
    out
}

/// `Intl.Collator(undefined, {sensitivity: "base", numeric: true}).compare`,
/// approximated: case- and accent-insensitive on the common Latin letters,
/// digit runs compared by value.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(|c| c.is_ascii_digit()) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(|c| c.is_ascii_digit()) {
                    nb.push(c);
                    bi.next();
                }
                let ta = na.trim_start_matches('0');
                let tb = nb.trim_start_matches('0');
                let o = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if o != Ordering::Equal {
                    return o;
                }
            }
            (Some(x), Some(y)) => {
                let (kx, ky) = (collate_key(x), collate_key(y));
                // Punctuation and spaces sort before digits and letters.
                let o = kx.cmp(&ky);
                if o != Ordering::Equal {
                    return o;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

fn collate_key(c: char) -> (u8, char) {
    let base = strip_accent(fold_char(c));
    let class = if base.is_alphabetic() {
        2
    } else if base.is_numeric() {
        1
    } else {
        0
    };
    (class, base)
}

fn strip_accent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' => 'i',
        'ñ' | 'ń' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' => 'u',
        'ý' | 'ÿ' => 'y',
        'š' | 'ś' => 's',
        'ž' | 'ź' | 'ż' => 'z',
        _ => c,
    }
}

/// `encodeURIComponent` for one character.
pub fn percent_encode_char(c: char, out: &mut String) {
    let mut buf = [0u8; 4];
    for b in c.encode_utf8(&mut buf).bytes() {
        out.push_str(&format!("%{:02X}", b));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_helpers_match_obsidian() {
        assert_eq!(basename("a/b/c.md"), "c.md");
        assert_eq!(parent("a/b/c.md"), "a/b");
        assert_eq!(parent("c.md"), "");
        assert_eq!(extension("a/B.PNG"), "png");
        assert_eq!(extension(".hidden"), "");
        assert_eq!(extension("name."), "");
        assert_eq!(stem("a/b.c.md"), "b.c");
        assert_eq!(strip_md("a/b.md"), "a/b");
        assert_eq!(strip_md("a/b.png"), "a/b.png");
        assert_eq!(display_name("x/Note.md"), "Note");
        assert_eq!(display_name("x/img.png"), "img.png");
        assert_eq!(split_subpath("Note#H#I"), ("Note", "#H#I"));
    }

    #[test]
    fn fold_keeps_byte_offsets() {
        let s = "ÀB😀İK";
        let f = fold(s);
        assert_eq!(f.len(), s.len());
        assert!(f.starts_with("àb😀"));
    }

    #[test]
    fn u16_mapper_counts_surrogates() {
        let s = "😀a😀b";
        let m = U16Mapper::new(s);
        let a = s.find('a').unwrap();
        let b = s.find('b').unwrap();
        assert_eq!(m.map(&[[a, b + 1], [0, a]]), vec![[2, 6], [0, 2]]);
        assert_eq!(byte_at_u16(s, 3), 5);
        assert_eq!(u16_at(s, b), 5);
    }

    #[test]
    fn find_all_ascii_case_insensitive_non_overlapping() {
        let s = "AAAA aaa";
        assert_eq!(
            find_all(s, || Cow::Owned(fold(s)), "aa", false),
            vec![[0, 2], [2, 4], [5, 7]]
        );
        assert_eq!(
            find_all(s, || Cow::Owned(fold(s)), "AA", true),
            vec![[0, 2], [2, 4]]
        );
    }

    #[test]
    fn whole_word_follows_regex_semantics() {
        let s = "cat catalog bobcat cat,cat";
        let hits = find_whole_word(s, || Cow::Owned(fold(s)), "cat", false, true);
        assert_eq!(hits, vec![[0, 3], [19, 22], [23, 26]]);
        // `_` is not a word character in Obsidian's class.
        let s2 = "my_cat";
        assert_eq!(
            find_whole_word(s2, || Cow::Owned(fold(s2)), "cat", false, true),
            vec![[3, 6]]
        );
        // CJK text is never word-bounded.
        let s3 = "日本語テキスト";
        assert_eq!(
            find_whole_word(s3, || Cow::Owned(fold(s3)), "語", false, true).len(),
            1
        );
    }

    #[test]
    fn natural_order_is_numeric_and_case_blind() {
        let mut v = vec!["note 10", "Note 2", "apple", "Banana"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["apple", "Banana", "Note 2", "note 10"]);
    }

    #[test]
    fn merge_ranges_joins_touching() {
        assert_eq!(
            merge_ranges(vec![[5, 6], [0, 2], [2, 3]]),
            vec![[0, 3], [5, 6]]
        );
    }
}
