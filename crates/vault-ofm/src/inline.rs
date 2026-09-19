//! Inline tokenizers: a port of remark-parse 8's (MIT), `remark-math` 3's
//! inline math and `remark-footnotes` 2's calls and inline notes (MIT), plus
//! the Obsidian syntax from the help vault: wikilinks and embeds, tags,
//! `==highlights==`, `%%comments%%` and block ids.
//!
//! Inline constructs have two halves. The tokenizer decides whether a
//! construct starts at the very beginning of the remaining text; the locator
//! says where the next one *could* start, which is where plain text stops.

use crate::block::{normalize_identifier, unescape, ESCAPES};
use crate::entities;
use crate::linktext;
use crate::mdast::{Kind, Node, RefKind};
use crate::tokenizer::{Frame, Inline, Parser};
use crate::util::{
    byte, char_at, char_len, index_of, is_alphabetical, is_decimal, is_js_line_terminator, is_js_ws,
    is_word_char, js_lower, js_trim, ws_at,
};

fn prev_char(s: &str, i: usize) -> Option<char> {
    s.get(..i).and_then(|p| p.chars().next_back())
}

fn skip_ws(s: &str, mut i: usize) -> usize {
    while let Some(c) = char_at(s, i) {
        if !is_js_ws(c) {
            break;
        }
        i += c.len_utf8();
    }
    i
}

/// Patterns the locators search for.
pub(crate) const PATTERNS: [&str; 22] = [
    "\\", "<", "www.", "http://", "https://", "@", "[[", "[", "![", "^[", "**", "__", "*", "_", "~~", "`", "\n", "==",
    "#", "$", "^", "%%",
];

/// `indexOf` with memory: remembers, per pattern, where the last search
/// started and what it found, so repeated searches from advancing positions
/// in the same text stay linear overall. Without it every text node rescans
/// the rest of the paragraph for every pattern that does not occur again.
pub(crate) struct Finder<'s> {
    pub src: &'s str,
    cache: [(usize, usize); PATTERNS.len()],
}

impl<'s> Finder<'s> {
    pub fn new(src: &'s str) -> Finder<'s> {
        Finder { src, cache: [(usize::MAX, 0); PATTERNS.len()] }
    }

    fn find(&mut self, pat: usize, from: usize) -> Option<usize> {
        let (searched, found) = self.cache[pat];
        let at = if searched <= from && found >= from {
            found
        } else {
            let found = index_of(self.src, PATTERNS[pat], from).unwrap_or(usize::MAX);
            self.cache[pat] = (from, found);
            found
        };
        (at != usize::MAX).then_some(at)
    }
}

fn pat(p: &str) -> usize {
    PATTERNS.iter().position(|x| *x == p).expect("locator pattern")
}

/// Where the construct `m` could next start in the finder's text, searching
/// from `from`.
pub(crate) fn locate(m: Inline, f: &mut Finder, from: usize) -> Option<usize> {
    let v = f.src;
    let mut find = |p: &str, from: usize| f.find(pat(p), from);
    match m {
        Inline::Escape => find("\\", from),
        Inline::AutoLink | Inline::Html => find("<", from),
        Inline::Url => [find("www.", from), find("http://", from), find("https://", from)].into_iter().flatten().min(),
        Inline::Email => {
            let mut from = from;
            loop {
                let at = find("@", from)?;
                if at == from || !is_gfm_atext(byte(v, at - 1)) {
                    from = at + 1;
                    continue;
                }
                let mut pos = at;
                while pos > from && is_gfm_atext(byte(v, pos - 1)) {
                    pos -= 1;
                }
                return Some(pos);
            }
        }
        Inline::Wikilink => {
            let i = find("[[", from)?;
            if i > from && byte(v, i - 1) == b'!' {
                Some(i - 1)
            } else {
                Some(i)
            }
        }
        Inline::Link | Inline::Reference => [find("[", from), find("![", from)].into_iter().flatten().min(),
        Inline::InlineNote => find("^[", from),
        Inline::FootnoteCall => find("[", from),
        Inline::Strong => [find("**", from), find("__", from)].into_iter().flatten().min(),
        Inline::Emphasis => [find("*", from), find("_", from)].into_iter().flatten().min(),
        Inline::Deletion => find("~~", from),
        Inline::Code => find("`", from),
        Inline::Break => {
            let mut n = find("\n", from)?;
            while n > from && byte(v, n - 1) == b' ' {
                n -= 1;
            }
            Some(n)
        }
        Inline::Mark => find("==", from),
        Inline::Tag | Inline::BlockId => {
            let p = if m == Inline::Tag { "#" } else { "^" };
            let mut r = from;
            loop {
                r = find(p, r)?;
                if prev_char(v, r).map(is_js_ws).unwrap_or(false) {
                    return Some(r);
                }
                r += 1;
            }
        }
        Inline::Math => find("$", from),
        Inline::Comment => find("%%", from),
        Inline::Text => None,
    }
}

fn is_gfm_atext(b: u8) -> bool {
    is_decimal(b) || is_alphabetical(b) || matches!(b, b'+' | b'-' | b'.' | b'_')
}

/// Tokenize `content` as the children of a link: only text, and `in_link`.
fn text_only_children(p: &mut Parser, content: &str, loc: crate::mdast::Point) -> Vec<Node> {
    let (was_text, was_link) = (p.text_only, p.in_link);
    p.in_link = true;
    p.text_only = true;
    let children = p.tokenize_inline(content, loc);
    p.text_only = was_text;
    p.in_link = was_link;
    children
}

pub(crate) fn escape(p: &mut Parser, f: &mut Frame, v: &str, silent: bool) -> bool {
    if byte(v, 0) != b'\\' {
        return false;
    }
    let c = byte(v, 1);
    if c == 0 || !ESCAPES.contains(&c) {
        return false;
    }
    if silent {
        return true;
    }
    let pos = f.eat(p, 2);
    let kind = if c == b'\n' { Kind::Break } else { Kind::Text((c as char).to_string()) };
    f.add(Node::new(kind, pos));
    true
}

pub(crate) fn auto_link(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    if byte(t, 0) != b'<' {
        return false;
    }
    let v = t.len();
    let mut b = 1;
    while b < v {
        let c = char_at(t, b).unwrap();
        if is_js_ws(c) || c == '>' || c == '@' || (c == ':' && byte(t, b + 1) == b'/') {
            break;
        }
        b += c.len_utf8();
    }
    if b == 1 {
        return false;
    }
    let mut link = t[1..b].to_string();
    let o = byte(t, b);
    let is_mail;
    if o == b'@' {
        is_mail = true;
        link.push('@');
        b += 1;
    } else {
        is_mail = false;
        if o != b':' || byte(t, b + 2) != b'/' {
            return false;
        }
        link.push_str(":/");
        b += 2;
    }
    let q = b;
    while b < v {
        let c = char_at(t, b).unwrap();
        if is_js_ws(c) || c == '>' {
            break;
        }
        b += c.len_utf8();
    }
    if b == q || byte(t, b) != b'>' {
        return false;
    }
    if silent {
        return true;
    }
    link.push_str(&t[q..b]);
    let mut content = link.clone();
    let mut now = f.now(p);
    now.column += 1;
    now.offset += 1;
    if is_mail {
        if link.len() >= 7 && link.as_bytes()[..7].eq_ignore_ascii_case(b"mailto:") {
            content = content[7..].to_string();
            now.column += 7;
            now.offset += 7;
        } else {
            link = format!("mailto:{link}");
        }
    }
    let children = text_only_children(p, &content, now);
    let url = entities::decode(&link, false);
    let pos = f.eat(p, b + 1);
    f.add(Node::with_children(Kind::Link { url, title: None }, pos, children));
    true
}

pub(crate) fn url(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let u = t.len();
    let mut protocolless = false;
    let mut c;
    if t.starts_with("www.") {
        protocolless = true;
        c = 4;
    } else if t.len() >= 7 && t.as_bytes()[..7].eq_ignore_ascii_case(b"http://") {
        c = 7;
    } else if t.len() >= 8 && t.as_bytes()[..8].eq_ignore_ascii_case(b"https://") {
        c = 8;
    } else {
        return false;
    }
    let mut prev_dot = c as isize - 1;
    let start = c;
    let mut dots: Vec<usize> = Vec::new();
    let mut last: Option<u8> = None;
    while c < u {
        let code = byte(t, c);
        last = Some(code);
        if code == b'.' {
            if prev_dot == c as isize - 1 {
                break;
            }
            dots.push(c);
            prev_dot = c as isize;
            c += 1;
            continue;
        }
        if is_decimal(code) || is_alphabetical(code) || code == b'-' || code == b'_' {
            c += 1;
            continue;
        }
        break;
    }
    if last == Some(b'.') {
        dots.pop();
        c -= 1;
    }
    if dots.is_empty() {
        return false;
    }
    let last_two = if dots.len() < 2 { start } else { dots[dots.len() - 2] + 1 };
    if t[last_two..c].contains('_') {
        return false;
    }
    if silent {
        return true;
    }
    let mut end = c;
    let path_start = c;
    while c < u {
        let ch = char_at(t, c).unwrap();
        if is_js_ws(ch) || ch == '<' {
            break;
        }
        c += ch.len_utf8();
        if !matches!(ch, '!' | '*' | ',' | '.' | ':' | '?' | '_' | '~') {
            end = c;
        }
    }
    c = end;
    if c > 0 && byte(t, c - 1) == b')' {
        let mut path = &t[path_start..c];
        let left = path.matches('(').count();
        let mut right = path.matches(')').count();
        while right > left {
            c = path_start + path.rfind(')').unwrap();
            path = &t[path_start..c];
            right -= 1;
        }
    }
    if c > 0 && byte(t, c - 1) == b';' {
        c -= 1;
        if c > 0 && is_alphabetical(byte(t, c - 1)) {
            let mut l = c as isize - 2;
            while l >= 0 && is_alphabetical(byte(t, l as usize)) {
                l -= 1;
            }
            if l >= 0 && byte(t, l as usize) == b'&' {
                c = l as usize;
            }
        }
    }
    let content = &t[..c];
    let mut href = entities::decode(content, false);
    if protocolless {
        href = format!("http://{href}");
    }
    let now = f.now(p);
    let children = text_only_children(p, content, now);
    let pos = f.eat(p, c);
    f.add(Node::with_children(Kind::Link { url: href, title: None }, pos, children));
    true
}

pub(crate) fn email(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let b = t.len();
    let mut v = 0;
    while v < b && is_gfm_atext(byte(t, v)) {
        v += 1;
    }
    if v == 0 || byte(t, v) != b'@' {
        return false;
    }
    v += 1;
    let mut first_dot: Option<usize> = None;
    let mut s = b'@';
    while v < b {
        s = byte(t, v);
        if is_decimal(s) || is_alphabetical(s) || s == b'-' || s == b'.' || s == b'_' {
            v += 1;
            if first_dot.is_none() && s == b'.' {
                first_dot = Some(v);
            }
            continue;
        }
        break;
    }
    match first_dot {
        None => return false,
        Some(k) if k == v => return false,
        _ => {}
    }
    if s == b'-' || s == b'_' {
        return false;
    }
    if s == b'.' {
        v -= 1;
    }
    if silent {
        return true;
    }
    let content = &t[..v];
    let now = f.now(p);
    let children = text_only_children(p, content, now);
    let url = format!("mailto:{}", entities::decode(content, false));
    let pos = f.eat(p, v);
    f.add(Node::with_children(Kind::Link { url, title: None }, pos, children));
    true
}

/// `openCloseTag`: `^(?:openTag|closeTag)`, returning the match length.
pub(crate) fn match_open_close_tag(s: &str) -> Option<usize> {
    match_open_tag(s).or_else(|| match_close_tag(s))
}

fn match_open_tag(s: &str) -> Option<usize> {
    if byte(s, 0) != b'<' || !is_alphabetical(byte(s, 1)) {
        return None;
    }
    let mut i = 2;
    while byte(s, i).is_ascii_alphanumeric() || byte(s, i) == b'-' {
        i += 1;
    }
    loop {
        let ws = skip_ws(s, i);
        if ws == i {
            break;
        }
        let c = byte(s, ws);
        if !(c.is_ascii_alphabetic() || c == b'_' || c == b':') {
            break;
        }
        let mut j = ws + 1;
        while matches!(byte(s, j), b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b':' | b'.' | b'_' | b'-') {
            j += 1;
        }
        let k = skip_ws(s, j);
        if byte(s, k) == b'=' {
            let k2 = skip_ws(s, k + 1);
            match byte(s, k2) {
                q @ (b'"' | b'\'') => {
                    if let Some(close) = index_of(s, if q == b'"' { "\"" } else { "'" }, k2 + 1) {
                        j = close + 1;
                    }
                }
                _ => {
                    let mut e = k2;
                    while e < s.len() {
                        let b = byte(s, e);
                        if b <= 0x20 || matches!(b, b'"' | b'\'' | b'=' | b'<' | b'>' | b'`') {
                            break;
                        }
                        e += char_len(s, e);
                    }
                    if e > k2 {
                        j = e;
                    }
                }
            }
        }
        i = j;
    }
    i = skip_ws(s, i);
    if byte(s, i) == b'/' {
        i += 1;
    }
    if byte(s, i) == b'>' {
        Some(i + 1)
    } else {
        None
    }
}

fn match_close_tag(s: &str) -> Option<usize> {
    if !s.starts_with("</") || !is_alphabetical(byte(s, 2)) {
        return None;
    }
    let mut i = 3;
    while byte(s, i).is_ascii_alphanumeric() || byte(s, i) == b'-' {
        i += 1;
    }
    i = skip_ws(s, i);
    if byte(s, i) == b'>' {
        Some(i + 1)
    } else {
        None
    }
}

/// The inline HTML `tag` expression: open/close tags, comments, processing
/// instructions, declarations and CDATA.
fn match_html_tag(s: &str) -> Option<usize> {
    if let Some(n) = match_open_close_tag(s) {
        return Some(n);
    }
    if s.starts_with("<!---->") {
        return Some(7);
    }
    if let Some(rest) = s.strip_prefix("<!--") {
        let mut i;
        // (?:-?[^>-])
        if byte(rest, 0) == b'-' {
            match byte(rest, 1) {
                0 | b'>' | b'-' => return None,
                _ => i = 1 + char_len(rest, 1),
            }
        } else {
            match byte(rest, 0) {
                0 | b'>' => return None,
                _ => i = char_len(rest, 0),
            }
        }
        // (?:-?[^-])*
        loop {
            if byte(rest, i) == b'-' {
                if i + 1 < rest.len() && byte(rest, i + 1) != b'-' {
                    i += 1 + char_len(rest, i + 1);
                    continue;
                }
                break;
            } else if i < rest.len() {
                i += char_len(rest, i);
            } else {
                break;
            }
        }
        if rest[i.min(rest.len())..].starts_with("-->") {
            return Some(4 + i + 3);
        }
    }
    if s.starts_with("<?") {
        let mut i = 2;
        while i < s.len() {
            if s[i..].starts_with("?>") {
                return Some(i + 2);
            }
            let c = char_at(s, i).unwrap();
            if is_js_line_terminator(c) {
                break;
            }
            i += c.len_utf8();
        }
    }
    if s.starts_with("<!") && is_alphabetical(byte(s, 2)) {
        let mut i = 2;
        while is_alphabetical(byte(s, i)) {
            i += 1;
        }
        let w = skip_ws(s, i);
        if w > i {
            if let Some(gt) = index_of(s, ">", w) {
                return Some(gt + 1);
            }
        }
    }
    if s.starts_with("<![CDATA[") {
        if let Some(e) = index_of(s, "]]>", 9) {
            return Some(e + 3);
        }
    }
    None
}

pub(crate) fn html(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    if byte(t, 0) != b'<' || t.len() < 3 {
        return false;
    }
    let c = byte(t, 1);
    if !(is_alphabetical(c) || c == b'?' || c == b'!' || c == b'/') {
        return false;
    }
    let Some(n) = match_html_tag(t) else { return false };
    if silent {
        return true;
    }
    let value = &t[..n];
    let lower = value.as_bytes();
    if !p.in_link && lower.len() >= 3 && lower[..3].eq_ignore_ascii_case(b"<a ") {
        p.in_link = true;
    } else if p.in_link && lower.len() >= 4 && lower[..4].eq_ignore_ascii_case(b"</a>") {
        p.in_link = false;
    }
    let pos = f.eat(p, n);
    f.add(Node::new(Kind::Html(value.to_string()), pos));
    true
}

pub(crate) fn wikilink(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    // /^(!?)\[\[(.+?)]]/
    let embed = byte(t, 0) == b'!';
    let open = if embed { 1 } else { 0 };
    if !t[open..].starts_with("[[") {
        return false;
    }
    let inner_start = open + 2;
    let mut j = inner_start;
    let mut found = None;
    while j < t.len() {
        let c = char_at(t, j).unwrap();
        if is_js_line_terminator(c) {
            break;
        }
        j += c.len_utf8();
        if t[j..].starts_with("]]") {
            found = Some(j);
            break;
        }
    }
    let Some(close) = found else { return false };
    let raw = js_trim(&t[inner_start..close]);
    if raw.contains("[[") {
        return false;
    }
    if silent {
        return true;
    }
    let parsed = linktext::parse_wikilink(raw);
    let alias = parsed.alias.clone();
    let pos = f.eat(p, close + 2);
    let kind = if embed {
        Kind::IEmbed { href: parsed.href, title: parsed.title, alt: alias, width: None, height: None }
    } else {
        Kind::ILink { href: parsed.href, title: parsed.title, converted: false }
    };
    f.add(Node::new(kind, pos));
    true
}

pub(crate) fn link(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let len = t.len();
    let at = |i: usize| byte(t, i);
    let mut r = 0usize;
    let is_image = at(0) == b'!';
    if is_image {
        r = 1;
    }
    if at(r) != b'[' || (!is_image && p.in_link) {
        return false;
    }
    r += 1;
    let content_start = r;
    let mut now = f.now(p);
    now.column += r as u32;
    now.offset += r;
    let mut depth: i64 = 0;
    let mut opening = 0usize;
    let mut closed = false;
    let mut content_end = r;
    while r < len {
        let c = at(r);
        if c == b'`' {
            let mut count = 1;
            while at(r + 1) == b'`' {
                r += 1;
                count += 1;
            }
            if opening == 0 {
                opening = count;
            } else if count >= opening {
                opening = 0;
            }
        } else if c == b'\\' {
            r += 1;
            r += char_len(t, r).saturating_sub(1);
        } else if c == b'[' {
            depth += 1;
        } else if c == b']' {
            if depth == 0 {
                if at(r + 1) != b'(' {
                    return false;
                }
                content_end = r;
                r += 1;
                closed = true;
                break;
            }
            depth -= 1;
        }
        r += if c >= 0x80 { char_len(t, r) } else { 1 };
    }
    if !closed {
        return false;
    }
    let content = &t[content_start..content_end];
    r += 1;
    r = skip_ws(t, r);
    let url: &str;
    if at(r) == b'<' {
        r += 1;
        let u0 = r;
        while r < len && at(r) != b'>' {
            if at(r) == b'\n' {
                return false;
            }
            r += 1;
        }
        if at(r) != b'>' {
            return false;
        }
        url = &t[u0..r];
        r += 1;
    } else {
        let u0 = r;
        let mut u_end = r;
        while r < len {
            let c = char_at(t, r).unwrap();
            if is_js_ws(c) {
                break;
            }
            if c == '(' {
                depth += 1;
            } else if c == ')' {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            if c == '\\' {
                r += 1;
                if r < len {
                    r += char_len(t, r);
                }
                u_end = r.min(len);
                continue;
            }
            r += c.len_utf8();
            u_end = r;
        }
        url = &t[u0..u_end];
        r = u_end;
    }
    let ws0 = r;
    r = skip_ws(t, r);
    let had_ws = r > ws0;
    let mut title: Option<&str> = None;
    let c = at(r);
    if had_ws && (c == b'"' || c == b'\'' || c == b'(') {
        let closer = if c == b'(' { b')' } else { c };
        r += 1;
        let t0 = r;
        while r < len && at(r) != closer {
            if at(r) == b'\\' {
                r += 1;
            }
            r += char_len(t, r);
        }
        if at(r) != closer || r >= len {
            return false;
        }
        title = Some(&t[t0..r.min(len)]);
        r += 1;
        r = skip_ws(t, r);
    }
    if at(r) != b')' || r >= len {
        return false;
    }
    if silent {
        return true;
    }
    r += 1;
    let url = entities::decode(&unescape(url), false);
    let title = title.filter(|s| !s.is_empty()).map(|s| entities::decode(&unescape(s), true));
    let kind;
    let mut children = Vec::new();
    if is_image {
        let alt = entities::decode(&unescape(content), true);
        kind = Kind::Image { url, title, alt: if alt.is_empty() { None } else { Some(alt) }, width: None, height: None };
    } else {
        let was = p.in_link;
        p.in_link = true;
        children = p.tokenize_inline(content, now);
        p.in_link = was;
        kind = Kind::Link { url, title };
    }
    let pos = f.eat(p, r);
    f.add(Node::with_children(kind, pos, children));
    true
}

pub(crate) fn reference(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    // `remark-footnotes`' wrapper: `[^` and `![^` are footnotes.
    {
        let r = if byte(t, 0) == b'!' { 1 } else { 0 };
        if !(byte(t, r) == b'[' && byte(t, r + 1) != b'^') {
            return false;
        }
    }
    let len = t.len();
    let at = |i: usize| byte(t, i);
    let mut e = 0usize;
    let is_image = at(0) == b'!';
    if is_image {
        e = 1;
    }
    if at(e) != b'[' {
        return false;
    }
    e += 1;
    let intro = e;
    let c0 = e;
    let mut depth = 0;
    let mut bracketed = false;
    while e < len {
        let c = at(e);
        if c == b'[' {
            bracketed = true;
            depth += 1;
        } else if c == b']' {
            if depth == 0 {
                break;
            }
            depth -= 1;
        }
        if c == b'\\' {
            e += 1;
        }
        e += char_len(t, e);
    }
    let e = e.min(len);
    let content = &t[c0..e];
    if at(e) != b']' {
        return false;
    }
    let mut end = e + 1;
    let mut kind = RefKind::Shortcut;
    let identifier: &str;
    if at(end) == b'[' {
        let i0 = end + 1;
        let mut i = i0;
        while i < len && at(i) != b'[' && at(i) != b']' {
            if at(i) == b'\\' {
                i += 1;
            }
            i += char_len(t, i);
        }
        let i = i.min(len);
        if at(i) == b']' {
            let id = &t[i0..i];
            kind = if id.is_empty() { RefKind::Collapsed } else { RefKind::Full };
            identifier = if id.is_empty() { content } else { id };
            end = i + 1;
        } else {
            // `[text][` without a closing bracket: the `[` is still eaten.
            identifier = content;
            end += 1;
        }
    } else {
        if content.is_empty() {
            return false;
        }
        identifier = content;
    }
    if !(kind == RefKind::Full || !bracketed) {
        return false;
    }
    if !is_image && p.in_link {
        return false;
    }
    if silent {
        return true;
    }
    let mut now = f.now(p);
    now.column += intro as u32;
    now.offset += intro;
    let node = if is_image {
        let alt = entities::decode(&unescape(content), true);
        Node::new(
            Kind::ImageReference {
                identifier: normalize_identifier(identifier),
                label: identifier.to_string(),
                kind,
                alt: if alt.is_empty() { None } else { Some(alt) },
            },
            Default::default(),
        )
    } else {
        let was = p.in_link;
        p.in_link = true;
        let children = p.tokenize_inline(content, now);
        p.in_link = was;
        Node::with_children(
            Kind::LinkReference {
                identifier: normalize_identifier(identifier),
                label: identifier.to_string(),
                kind,
            },
            Default::default(),
            children,
        )
    };
    let pos = f.eat(p, end);
    f.add(Node { pos, ..node });
    true
}

pub(crate) fn strong(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let marker = byte(t, 0);
    if (marker != b'*' && marker != b'_') || byte(t, 1) != marker {
        return false;
    }
    let h = t.len();
    let mut d = 2;
    while d < h {
        let m = byte(t, d);
        if m == marker && byte(t, d + 1) == marker && byte(t, d + 2) != marker {
            let inner = &t[2..d];
            if js_trim(inner).is_empty() {
                return false;
            }
            if silent {
                return true;
            }
            let mut now = f.now(p);
            now.column += 2;
            now.offset += 2;
            let pos = f.eat(p, d + 2);
            let children = p.tokenize_inline(inner, now);
            f.add(Node::with_children(Kind::Strong, pos, children));
            return true;
        }
        if m == b'\\' {
            d += 1;
        }
        d += if d < h { char_len(t, d) } else { 1 };
    }
    false
}

pub(crate) fn emphasis(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let marker = byte(t, 0);
    if marker != b'*' && marker != b'_' {
        return false;
    }
    let len = t.len();
    let mut m = 1usize;
    let mut g: u8 = 0; // previous examined byte (`g` before reassignment)
    while m < len {
        let d = g;
        g = byte(t, m);
        if g == marker {
            m += 1;
            g = byte(t, m);
            if g != marker {
                let inner = &t[1..m - 1];
                if js_trim(inner).is_empty() || d == marker {
                    return false;
                }
                if marker == b'_' && is_word_char(char_at(t, m)) {
                    continue;
                }
                if silent {
                    return true;
                }
                let mut now = f.now(p);
                now.column += 1;
                now.offset += 1;
                let pos = f.eat(p, m);
                let children = p.tokenize_inline(inner, now);
                f.add(Node::with_children(Kind::Emphasis, pos, children));
                return true;
            }
        }
        if g == b'\\' {
            m += 1;
            g = byte(t, m);
        }
        m += if m < len { char_len(t, m) } else { 1 };
    }
    false
}

/// `~~del~~` and `==mark==` share a shape: no whitespace after the opener or
/// before the closer. Returns the end of the content.
fn paired(t: &str, ch: u8) -> Option<usize> {
    let len = t.len();
    let mut prev: Option<(usize, char)> = None; // `u`
    let mut before: Option<char> = None; // `f`
    let mut i = 2;
    while i < len {
        let c = char_at(t, i).unwrap();
        if c as u32 == ch as u32 {
            if let Some((pi, pc)) = prev {
                if pc as u32 == ch as u32 && !before.map(is_js_ws).unwrap_or(false) {
                    return Some(pi);
                }
            }
        }
        before = prev.map(|x| x.1);
        prev = Some((i, c));
        i += c.len_utf8();
    }
    None
}

pub(crate) fn deletion(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    if !(t.starts_with("~~") && !ws_at(t, 2) && t.len() > 2) {
        return false;
    }
    let Some(end) = paired(t, b'~') else { return false };
    if silent {
        return true;
    }
    let mut now = f.now(p);
    now.column += 2;
    now.offset += 2;
    let inner = &t[2..end];
    let pos = f.eat(p, end + 2);
    let children = p.tokenize_inline(inner, now);
    f.add(Node::with_children(Kind::Delete, pos, children));
    true
}

pub(crate) fn mark(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    if !(t.starts_with("==") && !t.starts_with("====") && !ws_at(t, 2) && t.len() > 2) {
        return false;
    }
    let Some(end) = paired(t, b'=') else { return false };
    if silent {
        return true;
    }
    let mut now = f.now(p);
    now.column += 2;
    now.offset += 2;
    let inner = &t[2..end];
    let pos = f.eat(p, end + 2);
    let children = p.tokenize_inline(inner, now);
    f.add(Node::with_children(Kind::Mark, pos, children));
    true
}

pub(crate) fn code(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let b = t.as_bytes();
    let h = b.len();
    let mut i = 0;
    while i < h && b[i] == b'`' {
        i += 1;
    }
    if i == 0 || i == h {
        return false;
    }
    let open = i;
    let mut close_start: Option<usize> = None;
    let mut close_end = 0;
    let mut found = false;
    while i < h {
        let c = b[i];
        let next = b.get(i + 1).copied();
        if c == b'`' {
            if close_start.is_none() {
                close_start = Some(i);
            }
            close_end = i + 1;
            if next != Some(b'`') && close_end - close_start.unwrap() == open {
                found = true;
                break;
            }
        } else if close_start.is_some() {
            close_start = None;
        }
        i += 1;
    }
    if !found {
        return false;
    }
    if silent {
        return true;
    }
    let mut a = open;
    let mut z = close_start.unwrap();
    let first = b[a];
    let last = b[z - 1];
    if z - a > 2 && (first == b' ' || first == b'\n') && (last == b' ' || last == b'\n') {
        if b[a + 1..z - 1].iter().any(|&c| c != b' ' && c != b'\n') {
            a += 1;
            z -= 1;
        }
    }
    let value = t[a..z].to_string();
    let pos = f.eat(p, close_end);
    f.add(Node::new(Kind::InlineCode(value), pos));
    true
}

pub(crate) fn hard_break(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let b = t.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        if c == b'\n' {
            // Without `breaks`, a break needs two trailing spaces.
            if !p.breaks && i < 2 {
                return false;
            }
            if silent {
                return true;
            }
            let pos = f.eat(p, i + 1);
            f.add(Node::new(Kind::Break, pos));
            return true;
        }
        if c != b' ' {
            return false;
        }
    }
    false
}

/// Tags.md allows letters, digits, `_`, `-`, `/` and "commonly accepted
/// Unicode characters, including emojis". The tag therefore runs until
/// whitespace, ASCII punctuation other than those three, or a character from
/// the General or Supplemental Punctuation blocks (so `#tag…` and `#tag—x`
/// stop at the punctuation). Returns the byte length including `#`, or 0.
pub(crate) fn tag_length(t: &str) -> usize {
    if byte(t, 0) != b'#' {
        return 0;
    }
    let mut n = 1;
    for c in t[1..].chars() {
        let excluded = matches!(c as u32, 0x2000..=0x206F | 0x2E00..=0x2E7F)
            || "'!\"#$%&()*+,.:;<=>?@^`{|}~[]\\".contains(c)
            || is_js_ws(c);
        if excluded {
            break;
        }
        n += c.len_utf8();
    }
    if n == 1 {
        0
    } else {
        n
    }
}

/// A `#tag` must start the inline content or follow whitespace, so `a#b`,
/// `http://x/#frag` and `[[Note#Heading]]` never produce one; it must have a
/// non-digit (`#1984` is not a tag, `#y1984` is — Tags.md).
pub(crate) fn tag(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    // Inside a markdown link's text a `#word` is just text.
    if p.in_link || (f.idx > 0 && !prev_char(f.src, f.idx).map(is_js_ws).unwrap_or(false)) {
        return false;
    }
    let n = tag_length(t);
    if n == 0 {
        return false;
    }
    if t[1..n].bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if silent {
        return true;
    }
    let pos = f.eat(p, n);
    f.add(Node::new(Kind::Tag(t[..n].to_string()), pos));
    true
}

pub(crate) fn math(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let u = t.len();
    let code = |i: usize| t.as_bytes().get(i).copied();
    let mut pp = 0usize;
    let escaped = code(0) == Some(b'\\');
    if escaped {
        pp += 1;
    }
    if code(pp) != Some(b'$') {
        return false;
    }
    pp += 1;
    if escaped {
        if silent {
            return true;
        }
        let pos = f.eat(p, pp);
        f.add(Node::new(Kind::Text("$".into()), pos));
        return true;
    }
    let mut double = false;
    if code(pp) == Some(b'$') {
        double = true;
        pp += 1;
    }
    let mut o = code(pp);
    if !(double || (o != Some(b' ') && o != Some(b'\t'))) {
        return false;
    }
    let s = pp;
    let mut a = 0usize;
    let mut l: Option<usize> = None;
    while pp < u {
        let i = o;
        o = code(pp + 1);
        if i == Some(b'$') {
            let r = if pp == 0 { None } else { code(pp - 1) };
            let single_ok = !double
                && r != Some(b' ')
                && r != Some(b'\t')
                && !matches!(o, Some(c) if c.is_ascii_digit());
            if single_ok || (double && o == Some(b'$')) {
                a = pp.wrapping_sub(1);
                pp += 1;
                if double {
                    pp += 1;
                    let mut d = pp;
                    while d < u {
                        let m = char_at(t, d).unwrap();
                        if m == '\n' {
                            pp = d + 1;
                            break;
                        }
                        if !is_js_ws(m) {
                            break;
                        }
                        d += m.len_utf8();
                    }
                }
                l = Some(pp);
                break;
            }
        } else if i == Some(b'\\') {
            pp += 1;
            o = code(pp + 1);
        }
        pp += 1;
    }
    let Some(l) = l else { return false };
    if silent {
        return true;
    }
    let value = crate::util::js_slice(t, s, a.wrapping_add(1)).to_string();
    let pos = f.eat(p, l.min(u));
    f.add(Node::new(Kind::InlineMath { value, block: double }, pos));
    true
}

/// ` ^id` ending a paragraph, heading or list item: after whitespace, Latin
/// letters, digits and dashes only (Internal links.md), and nothing after it.
pub(crate) fn block_id(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    if f.idx == 0 || !prev_char(f.src, f.idx).map(is_js_ws).unwrap_or(false) {
        return false;
    }
    if byte(t, 0) != b'^' || t.len() < 2 {
        return false;
    }
    if !t[1..].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return false;
    }
    if silent {
        return true;
    }
    let pos = f.eat(p, t.len());
    f.add(Node::new(Kind::BlockId(t[1..].to_string()), pos));
    true
}

/// `%%hidden%%` inside a paragraph, which may run over several lines. The
/// content is dropped, not tokenized: nothing in a comment is a link or tag.
pub(crate) fn comment(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    if !t.starts_with("%%") {
        return false;
    }
    let Some(e) = index_of(t, "%%", 2) else { return false };
    if silent {
        return true;
    }
    let pos = f.eat(p, e + 2);
    f.add(Node::new(Kind::Comment, pos));
    true
}

pub(crate) fn inline_note(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    if !t.starts_with("^[") {
        return false;
    }
    let b = t.as_bytes();
    let mut i = 2usize;
    let o = i;
    let mut depth = 0;
    let mut code_ticks: Option<usize> = None;
    let close;
    loop {
        let Some(&c) = b.get(i) else { return false };
        match code_ticks {
            None => {
                if c == b'\\' {
                    i += 2;
                } else if c == b'[' {
                    depth += 1;
                    i += 1;
                } else if c == b']' {
                    if depth == 0 {
                        close = Some(i);
                        i += 1;
                        break;
                    }
                    depth -= 1;
                    i += 1;
                } else if c == b'`' {
                    let mut n = 1;
                    while b.get(i + n) == Some(&b'`') {
                        n += 1;
                    }
                    code_ticks = Some(n);
                    i += n;
                } else {
                    i += 1;
                }
            }
            Some(open) => {
                if c == b'`' {
                    let mut n = 1;
                    while b.get(i + n) == Some(&b'`') {
                        n += 1;
                    }
                    i += n;
                    if open == n {
                        code_ticks = None;
                    }
                } else {
                    i += 1;
                }
            }
        }
    }
    let Some(s) = close else { return false };
    if silent {
        return true;
    }
    let mut now = f.now(p);
    now.column += 2;
    now.offset += 2;
    let pos = f.eat(p, i);
    let children = p.tokenize_inline(&t[o..s], now);
    f.add(Node::with_children(Kind::Footnote, pos, children));
    true
}

pub(crate) fn footnote_call(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    if !t.starts_with("[^") {
        return false;
    }
    let b = t.as_bytes();
    let mut i = 2;
    let mut close = None;
    while let Some(&c) = b.get(i) {
        if c == b'\n' || c == b'\t' || c == b' ' {
            return false;
        }
        if c == b']' {
            close = Some(i);
            break;
        }
        i += 1;
    }
    let Some(o) = close else { return false };
    if o == 2 {
        return false;
    }
    if silent {
        return true;
    }
    let label = &t[2..o];
    let pos = f.eat(p, o + 1);
    f.add(Node::new(Kind::FootnoteReference { identifier: js_lower(label), label: label.to_string() }, pos));
    true
}
