//! Block tokenizers: a port of remark-parse 8 (MIT) in `commonmark` + `gfm`
//! mode, `remark-math` 3's `$$` block and `remark-footnotes` 2's definitions
//! (both MIT), plus the Obsidian blocks the help vault documents: `%%`
//! comments, callouts and standalone `^block-id` lines.
//!
//! Each tokenizer mirrors its JavaScript original closely enough that the two
//! can be read side by side. That is deliberate: block boundaries decide
//! section and list-item positions, and a "cleaner" rewrite would move them.

use crate::entities;
use crate::mdast::{Align, CalloutInfo, Kind, Node, Point, Position};
use crate::tokenizer::{
    run_block, Frame, Parser, INTERRUPT_BLOCKQUOTE, INTERRUPT_FOOTNOTE, INTERRUPT_LIST,
    INTERRUPT_PARAGRAPH,
};
use crate::util::{byte, char_at, index_of, is_js_ws, js_lower, js_slice, js_trim, utf16_len, ws_at};

/// Characters a backslash can escape with `commonmark: true`.
pub(crate) const ESCAPES: &[u8] = b"\\`*{}[]()#+-.!_>~|\n\"$%&',/:;<=?@^";

pub(crate) fn unescape(s: &str) -> String {
    if !s.contains('\\') {
        return s.to_string();
    }
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut prev = 0;
    let mut i = match index_of(s, "\\", 0) {
        Some(i) => i,
        None => return s.to_string(),
    };
    loop {
        out.push_str(&s[prev..i]);
        prev = i + 1;
        let next = b.get(prev).copied();
        if !matches!(next, Some(c) if ESCAPES.contains(&c)) {
            out.push('\\');
        }
        match index_of(s, "\\", prev + 1) {
            Some(j) => i = j,
            None => break,
        }
    }
    out.push_str(&s[prev..]);
    out
}

/// `trim-trailing-lines`.
fn trim_trailing_newlines(s: &str) -> &str {
    s.trim_end_matches('\n')
}

pub(crate) fn blank_line(p: &mut Parser, f: &mut Frame, v: &str, silent: bool) -> bool {
    let b = v.as_bytes();
    let mut index = 0;
    while index < b.len() {
        let mut j = index;
        while j < b.len() && (b[j] == b' ' || b[j] == b'\t') {
            j += 1;
        }
        if j < b.len() && b[j] == b'\n' {
            index = j + 1;
        } else if j == b.len() {
            index = j;
            break;
        } else {
            break;
        }
    }
    if index == 0 {
        return false;
    }
    if silent {
        return true;
    }
    f.eat(p, index);
    true
}

pub(crate) fn indented_code(p: &mut Parser, f: &mut Frame, v: &str, silent: bool) -> bool {
    let b = v.as_bytes();
    let h = b.len();
    let mut subvalue_end = 0usize; // `p`: always a prefix of v
    let mut content = String::new(); // `d`
    let mut sub_queue_end = 0usize; // `m`, as the end of the queued prefix
    let mut content_queue = String::new(); // `g`
    let mut indent = false;
    let mut idx = 0usize;
    while idx < h {
        let l = b[idx];
        if indent {
            indent = false;
            subvalue_end = sub_queue_end;
            content.push_str(&content_queue);
            content_queue.clear();
            if l == b'\n' {
                sub_queue_end = idx + 1;
                content_queue.push('\n');
            } else {
                let line_end = index_of(v, "\n", idx).unwrap_or(h);
                content.push_str(&v[idx..line_end]);
                subvalue_end = line_end;
                sub_queue_end = line_end;
                if line_end < h {
                    sub_queue_end = line_end + 1;
                    content_queue.push('\n');
                }
                idx = line_end;
            }
        } else if l == b' ' && byte(v, idx + 1) == b' ' && byte(v, idx + 2) == b' ' && byte(v, idx + 3) == b' ' {
            idx += 3;
            sub_queue_end = idx + 1;
            indent = true;
        } else if l == b'\t' {
            sub_queue_end = idx + 1;
            indent = true;
        } else {
            let mut j = idx;
            while j < h && (b[j] == b'\t' || b[j] == b' ') {
                j += 1;
            }
            idx = j;
            if byte(v, j) != b'\n' {
                break;
            }
            sub_queue_end = j + 1;
            content_queue.push('\n');
        }
        idx += 1;
    }
    if content.is_empty() {
        return false;
    }
    if silent {
        return true;
    }
    let pos = f.eat(p, subvalue_end);
    let value = trim_trailing_newlines(&content).to_string();
    f.add(Node::new(Kind::Code { lang: None, meta: None, value }, pos));
    true
}

pub(crate) fn math(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let b = t.as_bytes();
    let d = b.len();
    let mut m = 0;
    while m < d && b[m] == b' ' {
        m += 1;
    }
    let a = m;
    while m < d && b[m] == b'$' {
        m += 1;
    }
    let l = m - a;
    if l < 2 {
        return false;
    }
    while m < d && b[m] == b' ' {
        m += 1;
    }
    let c = m;
    while m < d {
        if b[m] == b'$' {
            return false;
        }
        if b[m] == b'\n' {
            break;
        }
        m += 1;
    }
    if byte(t, m) != b'\n' {
        return false;
    }
    if silent {
        return true;
    }
    let mut lines: Vec<&str> = Vec::new();
    if c != m {
        lines.push(&t[c..m]);
    }
    m += 1;
    let next_nl = |from: usize| index_of(t, "\n", from).unwrap_or(d);
    let mut o = next_nl(m + 1);
    while m < d {
        let mut closed = false;
        let mut h = m;
        let mut pp = o;
        let mut s = o;
        let mut fence = 0;
        while s > h && b[s - 1] == b' ' {
            s -= 1;
        }
        while s > h && b[s - 1] == b'$' {
            fence += 1;
            s -= 1;
        }
        if l <= fence && index_of(t, "$", h) == Some(s) {
            closed = true;
            pp = s;
        }
        while h <= pp && h - m < a && byte(t, h) == b' ' {
            h += 1;
        }
        if closed {
            while pp > h && b[pp - 1] == b' ' {
                pp -= 1;
            }
        }
        if !(closed && h == pp) {
            lines.push(js_slice(t, h, pp));
        }
        if closed {
            break;
        }
        m = o + 1;
        o = next_nl(m + 1);
    }
    let value = lines.join("\n");
    let pos = f.eat(p, o.min(d));
    f.add(Node::new(Kind::Math(value), pos));
    true
}

/// A `%%` block comment: `%%` at the start of a line (after up to any
/// number of spaces) with nothing else but text on that line, running to the
/// next `%%` or the end of the note. Nothing inside it is markup, so the node
/// keeps no children — links and tags in comments must not reach metadata.
pub(crate) fn comment(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let b = t.as_bytes();
    let r = b.len();
    let mut i = 0;
    while i < r && b[i] == b' ' {
        i += 1;
    }
    if !(byte(t, i) == b'%' && byte(t, i + 1) == b'%') {
        return false;
    }
    i += 2;
    // A single-line `%%inline%%` is an inline comment inside a paragraph.
    while i < r {
        if b[i] == b'%' {
            return false;
        }
        if b[i] == b'\n' {
            break;
        }
        i += 1;
    }
    if silent {
        return true;
    }
    let end = index_of(t, "%%", i).map(|e| e + 2).unwrap_or(r);
    // The closing `%%` may be followed by more text on its line; that text is
    // still hidden, as the comment's line range is what gets folded away.
    let end = index_of(t, "\n", end).unwrap_or(r).max(end);
    let pos = f.eat(p, end);
    f.add(Node::new(Kind::Comment, pos));
    true
}

pub(crate) fn fenced_code(p: &mut Parser, f: &mut Frame, l: &str, silent: bool) -> bool {
    // A literal port: `o` is the eaten text, `y` the raw content, `v` the
    // content with the fence's indentation removed, `b`/`k` the pending
    // "maybe a closing fence" text for each.
    let e = l.len() + 1;
    let at = |i: usize| byte(l, i);
    let mut o = String::new();
    let mut c = 0usize;
    while c < e && (at(c) == b' ' || at(c) == b'\t') {
        o.push(at(c) as char);
        c += 1;
    }
    let w = c;
    let marker = at(c);
    if marker != b'~' && marker != b'`' {
        return false;
    }
    c += 1;
    let mut count = 1;
    o.push(marker as char);
    while c < e && at(c) == marker {
        o.push(marker as char);
        count += 1;
        c += 1;
    }
    if count < 3 {
        return false;
    }
    while c < e && (at(c) == b' ' || at(c) == b'\t') {
        o.push(at(c) as char);
        c += 1;
    }
    let mut flag = String::new();
    let mut g = String::new();
    while c < e {
        let h = at(c);
        if (c < l.len() && h == b'\n') || (marker == b'`' && h == marker) {
            break;
        }
        if c < l.len() && (h == b' ' || h == b'\t') {
            g.push(h as char);
            c += 1;
        } else {
            flag.push_str(&g);
            g.clear();
            if c < l.len() {
                let n = crate::util::char_len(l, c);
                flag.push_str(&l[c..c + n]);
                c += n;
            } else {
                c += 1;
            }
        }
    }
    if c < l.len() && at(c) != b'\n' {
        return false;
    }
    if silent {
        return true;
    }
    o.push_str(&flag);
    let flag = entities::decode(&unescape(&flag), true);
    o.push_str(&g);
    let mut y = String::new();
    let mut v = String::new();
    let mut b = String::new();
    let mut k = String::new();
    let mut first = true;
    while c < e {
        y.push_str(&b);
        v.push_str(&k);
        b.clear();
        k.clear();
        if c < l.len() && at(c) == b'\n' {
            if first {
                o.push('\n');
                first = false;
            } else {
                b.push('\n');
                k.push('\n');
            }
            c += 1;
            let mut spaces = 0;
            while c < l.len() && at(c) == b' ' {
                spaces += 1;
                c += 1;
            }
            b.push_str(&" ".repeat(spaces));
            k.push_str(&" ".repeat(spaces.saturating_sub(w)));
            if spaces >= 4 {
                continue;
            }
            let mut fence = 0;
            while c < l.len() && at(c) == marker {
                fence += 1;
                c += 1;
            }
            let fence_str = (marker as char).to_string().repeat(fence);
            b.push_str(&fence_str);
            k.push_str(&fence_str);
            if fence < count {
                continue;
            }
            while c < l.len() && (at(c) == b' ' || at(c) == b'\t') {
                b.push(at(c) as char);
                k.push(at(c) as char);
                c += 1;
            }
            // `h` is "" (end) or the character that stopped the loop.
            if c >= l.len() || at(c) == b'\n' {
                break;
            }
        } else if c < l.len() {
            let n = crate::util::char_len(l, c);
            y.push_str(&l[c..c + n]);
            k.push_str(&l[c..c + n]);
            c += n;
        } else {
            c += 1;
        }
    }
    o.push_str(&y);
    o.push_str(&b);
    let (lang, meta) = split_flag(&flag);
    debug_assert!(l.starts_with(&o), "fenced code ate {o:?}");
    let pos = f.eat(p, o.len());
    f.add(Node::new(Kind::Code { lang, meta, value: v }, pos));
    true
}

fn split_flag(flag: &str) -> (Option<String>, Option<String>) {
    let mut lang: Option<&str> = None;
    let mut meta: Option<&str> = None;
    for (i, ch) in flag.char_indices() {
        if ch == ' ' || ch == '\t' {
            if lang.map(|l| l.is_empty()).unwrap_or(true) {
                lang = Some(&flag[..i]);
            }
        } else if matches!(lang, Some(l) if !l.is_empty()) {
            meta = Some(&flag[i..]);
            break;
        }
    }
    let lang = match lang {
        Some(l) if !l.is_empty() => Some(l.to_string()),
        _ if !flag.is_empty() => Some(flag.to_string()),
        _ => None,
    };
    (lang, meta.map(str::to_string))
}

pub(crate) fn blockquote(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let b = t.as_bytes();
    let a = b.len();
    let mut n = 0;
    while n < a && (b[n] == b' ' || b[n] == b'\t') {
        n += 1;
    }
    if byte(t, n) != b'>' {
        return false;
    }
    if silent {
        return true;
    }
    let w = f.now(p);
    let mut raw_end = 0usize; // S.join("\n") is t[..raw_end]
    let mut indents: Vec<usize> = Vec::new();
    let mut contents: Vec<&str> = Vec::new();
    let mut callout: Option<CalloutInfo> = None;
    n = 0;
    while n < a {
        let d = n;
        let mut prefixed = false;
        let fe = index_of(t, "\n", n).unwrap_or(a);
        while n < a && (b[n] == b' ' || b[n] == b'\t') {
            n += 1;
        }
        if byte(t, n) == b'>' {
            n += 1;
            prefixed = true;
            if byte(t, n) == b' ' {
                n += 1;
            }
        } else {
            n = d;
        }
        let mut h = js_slice(t, n, fe);
        if !prefixed && js_trim(h).is_empty() {
            break;
        }
        if !prefixed {
            let rest = &t[n..];
            if p.interrupts(f, &INTERRUPT_BLOCKQUOTE, rest) {
                break;
            }
        }
        if d == 0 {
            if let Some((info, len)) = match_callout(h) {
                callout = Some(info);
                n += len;
                h = &h[len..];
            }
        }
        indents.push(n - d);
        contents.push(h);
        raw_end = fe;
        n = fe + 1;
    }
    let pos = f.eat(p, raw_end.min(a));
    let mut line = w.line;
    for i in &indents {
        p.add_offset(line, *i);
        line += 1;
    }
    let was = p.in_block;
    p.in_block = true;
    let mut children = Vec::new();
    let mut loc = w;
    let mut rest: &[&str] = &contents;
    // A callout's first line is its title and nothing else: tokenized on its
    // own, so the body can never be pulled into it by paragraph continuation.
    if callout.is_some() {
        if !contents[0].is_empty() {
            let mut title_loc = w;
            title_loc.column += indents[0] as u32;
            title_loc.offset += indents[0];
            let title = p.tokenize_block(contents[0], title_loc);
            children.extend(title);
        }
        loc.line += 1;
        loc.column = 1;
        loc.offset = p.to_offset(loc.line, 1);
        rest = &contents[1..];
    }
    let joined = rest.join("\n");
    let more = p.tokenize_block(&joined, loc);
    children.extend(more);
    p.in_block = was;
    f.add(Node::with_children(Kind::Blockquote { callout }, pos, children));
    true
}

/// `[!type]`, `[!type|metadata]`, then an optional fold sign `+`/`-`, then
/// whitespace or the end of the line (Callouts.md). Returns the info and the
/// length of the marker including the whitespace after it.
fn match_callout(h: &str) -> Option<(CalloutInfo, usize)> {
    let rest = h.strip_prefix("[!")?;
    let close = rest.find(']')?;
    if close == 0 {
        return None;
    }
    let inner = &rest[..close];
    let mut len = 2 + close + 1;
    let mut fold = "";
    if let b @ (b'+' | b'-') = byte(h, len) {
        fold = if b == b'+' { "+" } else { "-" };
        len += 1;
    }
    match char_at(h, len) {
        None => {}
        Some(c) if is_js_ws(c) => len += c.len_utf8(),
        _ => return None,
    }
    let (kind, metadata) = match inner.find('|') {
        Some(i) => (&inner[..i], &inner[i + 1..]),
        None => (inner, ""),
    };
    Some((
        CalloutInfo { kind: js_lower(js_trim(kind)), fold: fold.to_string(), metadata: metadata.to_string() },
        len,
    ))
}

pub(crate) fn atx_heading(p: &mut Parser, f: &mut Frame, s: &str, silent: bool) -> bool {
    let at = |i: usize| byte(s, i);
    let len = s.len();
    let mut idx = 0usize;
    while idx < len && (at(idx) == b' ' || at(idx) == b'\t') {
        idx += 1;
    }
    let mut depth = 0u8;
    while idx < len && at(idx) == b'#' {
        idx += 1;
        depth += 1;
    }
    if depth > 6 || depth == 0 {
        return false;
    }
    let hashes_end = idx;
    while idx < len && (at(idx) == b' ' || at(idx) == b'\t') {
        idx += 1;
    }
    if idx == hashes_end && idx < len && at(idx) != b'\n' {
        return false;
    }
    if silent {
        return true;
    }
    let prefix = idx; // `m`
    // `g` is the content, `c` the queue of spaces and hashes that is only
    // content if something follows it on the line.
    let mut g = String::new();
    let mut c = String::new();
    let mut i = idx;
    while i < len && at(i) != b'\n' {
        let l = at(i);
        if l == b' ' || l == b'\t' || l == b'#' {
            let mut j = i;
            while at(j) == b' ' || at(j) == b'\t' {
                c.push(at(j) as char);
                j += 1;
            }
            if g.is_empty() || !c.is_empty() || at(j) != b'#' {
                while at(j) == b'#' {
                    c.push('#');
                    j += 1;
                }
                while at(j) == b' ' || at(j) == b'\t' {
                    c.push(at(j) as char);
                    j += 1;
                }
                i = j;
            } else {
                g.push('#');
                i = j + 1;
            }
        } else {
            let n = crate::util::char_len(s, i);
            g.push_str(&c);
            c.clear();
            g.push_str(&s[i..i + n]);
            i += n;
        }
    }
    let mut loc = f.now(p);
    loc.column += prefix as u32;
    loc.offset += prefix;
    let pos = f.eat(p, prefix + g.len() + c.len());
    let children = p.tokenize_inline(&g, loc);
    f.add(Node::with_children(Kind::Heading { depth }, pos, children));
    true
}

pub(crate) fn thematic_break(p: &mut Parser, f: &mut Frame, l: &str, silent: bool) -> bool {
    let at = |i: usize| byte(l, i);
    let m = l.len() + 1;
    let mut d = 0usize;
    while d < m && (at(d) == b'\t' || at(d) == b' ') {
        d += 1;
    }
    let marker = at(d);
    if marker != b'*' && marker != b'-' && marker != b'_' {
        return false;
    }
    let mut count = 1;
    let mut end = d + 1;
    d += 1;
    while d < m {
        let u = at(d);
        if u == marker {
            count += 1;
            end = d + 1;
        } else if u != b' ' || d >= l.len() {
            if count >= 3 && (d >= l.len() || u == b'\n') {
                if silent {
                    return true;
                }
                // The trailing spaces (`p`) are eaten too.
                let pos = f.eat(p, d.min(l.len()));
                let _ = end;
                f.add(Node::new(Kind::ThematicBreak, pos));
                return true;
            }
            return false;
        }
        d += 1;
    }
    false
}

pub(crate) fn list(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let b = t.as_bytes();
    let len = b.len();
    let at = |i: usize| byte(t, i);
    let mut idx = 0;
    while idx < len && (b[idx] == b'\t' || b[idx] == b' ') {
        idx += 1;
    }
    let c = at(idx);
    let ordered;
    let marker;
    let mut start = None;
    if c == b'*' || c == b'+' || c == b'-' {
        marker = c;
        ordered = false;
    } else {
        ordered = true;
        let q0 = idx;
        while idx < len && b[idx].is_ascii_digit() {
            idx += 1;
        }
        let digits = &t[q0..idx];
        let ch = at(idx);
        if digits.is_empty() || !(ch == b'.' || ch == b')') {
            return false;
        }
        if silent && digits != "1" {
            return false;
        }
        start = Some(digits.parse::<u64>().unwrap_or(u64::MAX));
        marker = ch;
    }
    idx += 1;
    let ch = at(idx);
    if ch != b' ' && ch != b'\t' && ch != b'\n' && idx < len {
        return false;
    }
    if silent {
        return true;
    }

    struct Item {
        lines: Vec<(usize, usize)>, // ranges into t; (0,0) with `empty` marker for pushed ""
        indent: usize,
        trail: Vec<(usize, usize)>,
    }
    const EMPTY: (usize, usize) = (usize::MAX, usize::MAX);
    let mut items: Vec<Item> = Vec::new();
    let mut all_end = 0usize; // allLines.join("\n") == t[..all_end]
    let mut empty_lines: Vec<(usize, usize)> = Vec::new();
    let mut spread = false;
    let mut empty = false;
    idx = 0;
    while idx < len {
        let next = index_of(t, "\n", idx).unwrap_or(len);
        let line_start = idx;
        let prefixed;
        let mut indented = false;
        let mut size = 0usize;
        while idx < len {
            let ch = b[idx];
            if ch == b'\t' {
                size += 4 - (size % 4);
            } else if ch == b' ' {
                size += 1;
            } else {
                break;
            }
            idx += 1;
        }
        if let Some(item) = items.last() {
            if size >= item.indent {
                indented = true;
            }
        }
        let mut current: Option<u8> = None;
        if !indented {
            let ch = at(idx);
            if ch == b'*' || ch == b'+' || ch == b'-' {
                current = Some(ch);
                idx += 1;
                size += 1;
            } else {
                let q0 = idx;
                while idx < len && b[idx].is_ascii_digit() {
                    idx += 1;
                }
                let digits = idx - q0;
                let ch = at(idx);
                idx += 1;
                if digits > 0 && (ch == b'.' || ch == b')') {
                    current = Some(ch);
                    size += digits + 1;
                }
            }
            if current.is_some() {
                let ch = at(idx);
                if ch == b'\t' {
                    size += 4 - (size % 4);
                    idx += 1;
                } else if ch == b' ' && idx < len {
                    let end = idx + 4;
                    while idx < end {
                        if at(idx) != b' ' || idx >= len {
                            break;
                        }
                        idx += 1;
                        size += 1;
                    }
                    if idx == end && at(idx) == b' ' && idx < len {
                        idx -= 3;
                        size -= 3;
                    }
                } else if ch != b'\n' && idx < len {
                    current = None;
                }
            }
        }
        if let Some(cm) = current {
            if marker != cm {
                break;
            }
            prefixed = true;
        } else {
            if let Some(item) = items.last() {
                indented = size >= item.indent || size > 4;
            }
            prefixed = false;
            idx = line_start;
        }
        let line = (line_start, next);
        let content = if line_start == idx { &t[line_start..next] } else { js_slice(t, idx, next) };
        if matches!(current, Some(b'*') | Some(b'_') | Some(b'-'))
            && thematic_break(p, f, &t[line_start..next], true)
        {
            break;
        }
        let previous_empty = empty;
        empty = !prefixed && js_trim(content).is_empty();
        if indented && !items.is_empty() {
            let item = items.last_mut().unwrap();
            item.lines.extend(empty_lines.drain(..));
            item.lines.push(line);
            all_end = next;
        } else if prefixed {
            if !empty_lines.is_empty() {
                spread = true;
                if let Some(item) = items.last_mut() {
                    item.lines.push(EMPTY);
                    item.trail = empty_lines.clone();
                }
            }
            items.push(Item { lines: vec![line], indent: size, trail: Vec::new() });
            empty_lines.clear();
            all_end = next;
        } else if empty {
            if items.is_empty() {
                // Cannot happen: the first line is always prefixed.
                break;
            }
            empty_lines.push(line);
        } else {
            if previous_empty {
                break;
            }
            if p.interrupts(f, &INTERRUPT_LIST, &t[line_start..next]) {
                break;
            }
            let Some(item) = items.last_mut() else { break };
            item.lines.extend(empty_lines.drain(..));
            item.lines.push(line);
            all_end = next;
        }
        idx = next + 1;
    }

    let list_pos = f.eat_reset(p, all_end);
    let (was_list, was_block) = (p.in_list, p.in_block);
    p.in_list = true;
    p.in_block = true;
    let mut children = Vec::new();
    let count = items.len();
    for (k, item) in items.iter().enumerate() {
        let mut value = String::new();
        for (j, r) in item.lines.iter().enumerate() {
            if j > 0 {
                value.push('\n');
            }
            if *r != EMPTY {
                value.push_str(&t[r.0..r.1]);
            }
        }
        // The item's text as eaten: an EMPTY entry (pushed when a later item
        // follows blank lines) adds a trailing "\n" that the trail then
        // accounts for; the eaten length is what JavaScript validates.
        let now = f.now(p);
        let item_len = value.len();
        let pos = f.eat(p, item_len);
        let node = list_item(p, &value, now, pos);
        children.push(node);
        let mut trail = String::new();
        for (j, r) in item.trail.iter().enumerate() {
            if j > 0 {
                trail.push('\n');
            }
            trail.push_str(&t[r.0..r.1]);
        }
        if k != count - 1 {
            trail.push('\n');
        }
        f.eat(p, trail.len());
    }
    p.in_list = was_list;
    p.in_block = was_block;
    let _ = f.idx;
    f.add(Node::with_children(Kind::List { ordered, start, spread }, list_pos, children));
    true
}

fn list_item(p: &mut Parser, value: &str, position: Point, pos: Position) -> Node {
    let mut value = normal_list_item(p, value, position);
    let mut checklist = None;
    if let Some((ch, n)) = match_task(&value) {
        checklist = Some(ch.to_string());
        p.add_offset(position.line, n);
        value = value[n..].to_string();
    }
    let spread = loose(&value);
    let children = p.tokenize_block(&value, position);
    Node::with_children(Kind::ListItem { spread, checklist }, pos, children)
}

/// `/^\[(.)][ \t]/` — `.` is one UTF-16 unit, so an astral character is not a
/// task status.
fn match_task(v: &str) -> Option<(char, usize)> {
    let rest = v.strip_prefix('[')?;
    let c = rest.chars().next()?;
    if crate::util::is_js_line_terminator(c) || c.len_utf16() != 1 {
        return None;
    }
    let after = 1 + c.len_utf8();
    if byte(v, after) != b']' {
        return None;
    }
    match byte(v, after + 1) {
        b' ' | b'\t' => Some((c, after + 2)),
        _ => None,
    }
}

/// `/\n\n(?!\s*$)/`.
fn loose(v: &str) -> bool {
    let mut from = 0;
    while let Some(i) = index_of(v, "\n\n", from) {
        if !crate::util::js_trim_start(&v[i + 2..]).is_empty() {
            return true;
        }
        from = i + 1;
    }
    false
}

fn normal_list_item(p: &mut Parser, value: &str, position: Point) -> String {
    // bulletExpression: /^([ \t]*)([*+-]|\d+[.)])( {1,4}(?! )| |\t|$|(?=\n))([^\n]*)/
    let b = value.as_bytes();
    let mut i = 0;
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    let lead = &value[..i];
    let mstart = i;
    if matches!(byte(value, i), b'*' | b'+' | b'-') {
        i += 1;
    } else {
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        i += 1; // the `.` or `)`
    }
    let mut marker = value[mstart..i.min(value.len())].to_string();
    let sstart = i;
    let mut spaces = 0;
    while byte(value, i + spaces) == b' ' && spaces < 4 {
        spaces += 1;
    }
    if spaces >= 1 && byte(value, i + spaces) != b' ' {
        i += spaces;
    } else if spaces >= 1 {
        // ` {1,4}(?! )` failed at every length: fall back to one space.
        i += 1;
    } else if byte(value, i) == b'\t' {
        i += 1;
    }
    let space = &value[sstart..i];
    let line_end = index_of(value, "\n", i).unwrap_or(value.len());
    let rest = value[i..line_end].to_string();
    let bullet_len = lead.len() + marker.len() + space.len();
    // `Number("1.") < 10` is true, `Number("1)")` is NaN: only dot markers
    // of one digit get the extra column.
    let numeric = marker.strip_suffix('.').and_then(|d| d.parse::<f64>().ok());
    if matches!(numeric, Some(n) if n < 10.0) && bullet_len % 2 == 1 {
        marker = format!(" {marker}");
    }
    let max = format!("{}{}{}", lead, " ".repeat(marker.len()), space);
    let replaced = format!("{}{}{}", max, rest, &value[line_end..]);
    let lines: Vec<&str> = replaced.split('\n').collect();
    let stripped = remove_indentation(&replaced, indentation(&max).0);
    let mut trimmed: Vec<String> = stripped.split('\n').map(str::to_string).collect();
    trimmed[0] = rest;
    let mut line = position.line;
    p.add_offset(line, bullet_len);
    line += 1;
    for k in 1..lines.len() {
        p.add_offset(line, lines[k].len() - trimmed[k].len());
        line += 1;
    }
    trimmed.join("\n")
}

/// `get-indentation`: the indent width and, for each column, the index of the
/// character that reaches it.
fn indentation(v: &str) -> (usize, Vec<Option<usize>>) {
    let b = v.as_bytes();
    let mut indent = 0usize;
    let mut stops: Vec<Option<usize>> = vec![None];
    let mut last = 0usize;
    let mut i = 0;
    while i < b.len() && (b[i] == b'\t' || b[i] == b' ') {
        let size = if b[i] == b'\t' { 4 } else { 1 };
        indent += size;
        if size > 1 {
            indent = indent / size * size;
        }
        while last < indent {
            last += 1;
            if stops.len() <= last {
                stops.resize(last + 1, None);
            }
            stops[last] = Some(i);
        }
        i += 1;
    }
    (indent, stops)
}

/// `remove-indentation`: strip the smallest indentation (at most `maximum`)
/// from every line. A non-blank line with no indentation at all (a lazy
/// continuation) cancels the removal.
fn remove_indentation(value: &str, maximum: usize) -> String {
    let mut lines: Vec<String> = value.split('\n').map(str::to_string).collect();
    lines.insert(0, format!("{}!", " ".repeat(maximum)));
    let mut stops = Vec::with_capacity(lines.len());
    let mut min = usize::MAX;
    for l in lines.iter() {
        let (ind, st) = indentation(l);
        stops.push(st);
        if js_trim(l).is_empty() {
            continue;
        }
        if ind == 0 {
            min = usize::MAX;
            break;
        }
        if ind < min {
            min = ind;
        }
    }
    if min != usize::MAX {
        for (k, l) in lines.iter_mut().enumerate() {
            let st = &stops[k];
            let mut a = min;
            while a > 0 && st.get(a).copied().flatten().is_none() {
                a -= 1;
            }
            let from = if a == 0 { 0 } else { st[a].unwrap() + 1 };
            *l = l[from.min(l.len())..].to_string();
        }
    }
    lines.remove(0);
    lines.join("\n")
}

pub(crate) fn setext_heading(p: &mut Parser, f: &mut Frame, c: &str, silent: bool) -> bool {
    let at = |i: usize| byte(c, i);
    let y = c.len();
    let mut v = 0usize;
    while v < y && at(v) == b' ' && v < 3 {
        v += 1;
    }
    let lead = v;
    let mut content_end = v;
    while v < y && at(v) != b'\n' {
        if at(v) != b' ' && at(v) != b'\t' {
            content_end = v + crate::util::char_len(c, v);
            v = content_end;
            continue;
        }
        v += 1;
    }
    let line_end = v;
    if at(v) != b'\n' || v >= y {
        return false;
    }
    let marker = at(v + 1);
    if marker != b'=' && marker != b'-' {
        return false;
    }
    let mut u = v + 2;
    while u < y {
        if at(u) != marker {
            if at(u) != b'\n' {
                return false;
            }
            break;
        }
        u += 1;
    }
    if silent {
        return true;
    }
    let content = &c[lead..content_end];
    let mut loc = f.now(p);
    loc.column += lead as u32;
    loc.offset += lead;
    let _ = line_end;
    let pos = f.eat(p, u);
    let children = p.tokenize_inline(content, loc);
    let depth = if marker == b'=' { 1 } else { 2 };
    f.add(Node::with_children(Kind::Heading { depth }, pos, children));
    true
}

const BLOCK_ELEMENTS: [&str; 66] = [
    "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col",
    "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
    "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup",
    "hr", "html", "iframe", "legend", "li", "link", "main", "menu", "menuitem", "meta", "nav", "noframes",
    "ol", "optgroup", "option", "p", "param", "pre", "section", "source", "title", "summary", "table",
    "tbody", "td", "tfoot", "th", "thead", "title", "tr", "track", "ul",
];

#[derive(Clone, Copy, PartialEq)]
enum HtmlSeq {
    Raw,
    Comment,
    Instruction,
    Directive,
    Cdata,
    Element,
    Other,
}

fn html_open(line: &str) -> Option<HtmlSeq> {
    let lower = line.to_ascii_lowercase();
    for tag in ["script", "pre", "style"] {
        if let Some(r) = lower.strip_prefix('<').and_then(|s| s.strip_prefix(tag)) {
            if r.is_empty() || r.starts_with('>') || r.chars().next().map(is_js_ws).unwrap_or(false) {
                return Some(HtmlSeq::Raw);
            }
        }
    }
    if line.starts_with("<!--") {
        return Some(HtmlSeq::Comment);
    }
    if line.starts_with("<?") {
        return Some(HtmlSeq::Instruction);
    }
    if line.starts_with("<!") && byte(line, 2).is_ascii_alphabetic() {
        return Some(HtmlSeq::Directive);
    }
    if line.starts_with("<![CDATA[") {
        return Some(HtmlSeq::Cdata);
    }
    let name_start = if line.starts_with("</") { 2 } else { 1 };
    let rest = &lower[name_start.min(lower.len())..];
    for tag in BLOCK_ELEMENTS {
        if let Some(r) = rest.strip_prefix(tag) {
            if r.is_empty()
                || r.starts_with('>')
                || r.starts_with("/>")
                || r.chars().next().map(is_js_ws).unwrap_or(false)
            {
                return Some(HtmlSeq::Element);
            }
        }
    }
    if let Some(n) = crate::inline::match_open_close_tag(line) {
        if line[n..].chars().all(is_js_ws) {
            return Some(HtmlSeq::Other);
        }
    }
    None
}

fn html_close(seq: HtmlSeq, line: &str) -> bool {
    match seq {
        HtmlSeq::Raw => {
            let l = line.to_ascii_lowercase();
            l.contains("</script>") || l.contains("</pre>") || l.contains("</style>")
        }
        HtmlSeq::Comment => line.contains("-->"),
        HtmlSeq::Instruction => line.contains("?>"),
        HtmlSeq::Directive => line.contains('>'),
        HtmlSeq::Cdata => line.contains("]]>"),
        HtmlSeq::Element | HtmlSeq::Other => line.is_empty(),
    }
}

pub(crate) fn html(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let n = t.len();
    let mut i = 0;
    while i < n && (byte(t, i) == b'\t' || byte(t, i) == b' ') {
        i += 1;
    }
    if byte(t, i) != b'<' {
        return false;
    }
    let mut next = index_of(t, "\n", i + 1).unwrap_or(n);
    let line = &t[i..next];
    let Some(seq) = html_open(line) else { return false };
    if silent {
        return seq != HtmlSeq::Other;
    }
    let mut end = next;
    if !html_close(seq, line) {
        while end < n {
            next = index_of(t, "\n", end + 1).unwrap_or(n);
            let l = js_slice(t, end + 1, next);
            if html_close(seq, l) {
                if !l.is_empty() {
                    end = next;
                }
                break;
            }
            end = next;
        }
    }
    let value = t[..end].to_string();
    let pos = f.eat(p, end);
    f.add(Node::new(Kind::Html(value), pos));
    true
}

/// `collapse-white-space` then lower case: how identifiers are compared.
pub(crate) fn normalize_identifier(s: &str) -> String {
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
    js_lower(&out)
}

pub(crate) fn definition(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    // `remark-footnotes`' wrapper: `[^…]:` belongs to footnote definitions.
    {
        let mut r = 0;
        while byte(t, r) == b' ' || byte(t, r) == b'\t' {
            r += 1;
        }
        if !(byte(t, r) == b'[' && byte(t, r + 1) != b'^') {
            return false;
        }
    }
    let len = t.len();
    let at = |i: usize| byte(t, i);
    let mut n = 0;
    while n < len && (at(n) == b' ' || at(n) == b'\t') {
        n += 1;
    }
    if at(n) != b'[' {
        return false;
    }
    n += 1;
    let label_start = n;
    while n < len && at(n) != b']' {
        if at(n) == b'\\' {
            n += 1;
        }
        n += 1;
    }
    let label_end = n.min(len);
    if label_end == label_start || at(n) != b']' || at(n + 1) != b':' {
        return false;
    }
    let label = &t[label_start..label_end];
    n += 2;
    while n < len && matches!(at(n), b'\t' | b' ' | b'\n') {
        n += 1;
    }
    let mut url: &str = "";
    let mut sub_end;
    if at(n) == b'<' {
        let u0 = n + 1;
        let mut k = u0;
        while k < len && !matches!(at(k), b'>' | b'[' | b']') {
            k += crate::util::char_len(t, k);
        }
        if at(k) == b'>' {
            url = &t[u0..k];
            n = k + 1;
        } else {
            // commonmark: an unclosed `<` is not a definition.
            return false;
        }
    }
    if url.is_empty() {
        let u0 = n;
        while n < len && !matches!(at(n), b'[' | b']') && !ws_at(t, n) {
            n += crate::util::char_len(t, n);
        }
        url = &t[u0..n];
    }
    if url.is_empty() {
        return false;
    }
    sub_end = n;
    let ws0 = n;
    while n < len && matches!(at(n), b'\t' | b' ' | b'\n') {
        n += 1;
    }
    let had_ws = n > ws0;
    let closer = match at(n) {
        b'"' => Some(b'"'),
        b'\'' => Some(b'\''),
        b'(' => Some(b')'),
        _ => None,
    };
    let mut title: Option<String> = None;
    if let Some(x) = closer {
        if !had_ws {
            return false;
        }
        n += 1;
        let mut q = String::new();
        while n < len && at(n) != x {
            if at(n) == b'\n' {
                n += 1;
                if at(n) == b'\n' || at(n) == x {
                    return false;
                }
                q.push('\n');
            }
            let cl = crate::util::char_len(t, n);
            q.push_str(js_slice(t, n, n + cl));
            n += cl;
        }
        if at(n) != x {
            return false;
        }
        n += 1;
        title = Some(q);
        sub_end = n;
    } else {
        n = sub_end;
    }
    while n < len && (at(n) == b'\t' || at(n) == b' ') {
        n += 1;
    }
    if !(n >= len || at(n) == b'\n') {
        return false;
    }
    if silent {
        return true;
    }
    let _ = sub_end;
    let url = entities::decode(&unescape(url), false);
    let title = title.filter(|t| !t.is_empty()).map(|t| entities::decode(&unescape(&t), true));
    let pos = f.eat(p, n);
    f.add(Node::new(
        Kind::Definition { identifier: normalize_identifier(label), label: label.to_string(), url, title },
        pos,
    ));
    true
}

pub(crate) fn table(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let len = t.len();
    let mut i = 0usize;
    let mut lines: Vec<(usize, usize)> = Vec::new();
    while i < len + 1 {
        let d = index_of(t, "\n", i).unwrap_or(len);
        // Only a pipe on this line matters; searching past it would rescan
        // the rest of the note for every block that is not a table.
        let has_pipe = i + 1 <= d && t.as_bytes()[i + 1..d].contains(&b'|');
        if !has_pipe {
            if lines.len() < 2 {
                return false;
            }
            break;
        }
        lines.push((i, d));
        i = d + 1;
    }
    // A single row at the end of the text has no alignment row.
    if lines.len() < 2 {
        return false;
    }
    let sub_end = lines.last().unwrap().1;
    let align_line = &t[lines[1].0..lines[1].1];
    let mut align = Vec::new();
    let mut cur: Option<Option<Align>> = None; // None = `false`, Some(None) = `null`
    let mut has_dash = false;
    let mut first: Option<bool> = None;
    for ch in align_line.chars() {
        if ch == '|' {
            has_dash = false;
            match cur {
                None => {
                    if first == Some(false) {
                        return false;
                    }
                }
                Some(a) => {
                    align.push(a.unwrap_or(Align::None));
                    cur = None;
                }
            }
            first = Some(false);
        } else if ch == '-' {
            has_dash = true;
            if cur.is_none() {
                cur = Some(None);
            }
        } else if ch == ':' {
            cur = Some(Some(match cur {
                Some(Some(Align::Left)) => Align::Center,
                Some(None) if has_dash => Align::Right,
                _ => Align::Left,
            }));
        } else if !is_js_ws(ch) {
            return false;
        }
    }
    if let Some(a) = cur {
        align.push(a.unwrap_or(Align::None));
    }
    if align.is_empty() {
        return false;
    }
    if silent {
        return true;
    }
    let table_pos = f.eat_reset(p, sub_end);
    let mut rows = Vec::new();
    let row_lines: Vec<(usize, usize)> =
        lines.iter().enumerate().filter(|(k, _)| *k != 1).map(|(_, r)| *r).collect();
    for (n, &(ls, le)) in row_lines.iter().enumerate() {
        let line = &t[ls..le];
        if n > 0 {
            f.eat(p, 1);
        }
        let row_pos = f.eat_reset(p, line.len());
        let mut cells = Vec::new();
        let lb = line.as_bytes();
        let k = lb.len() + 1;
        let mut i = 0usize;
        let mut cell_start = 0usize;
        let mut cell_len = 0usize; // `C` is always line[cell_start..cell_start+cell_len]
        let mut preamble = true;
        while i < k {
            let a = if i < lb.len() { lb[i] } else { 0 };
            if a == 0 || a == b'|' {
                if preamble {
                    f.eat(p, if a == 0 { 0 } else { 1 });
                } else {
                    if cell_len > 0 || a != 0 {
                        let v = &line[cell_start..cell_start + cell_len];
                        let lead = v.bytes().take_while(|&c| c == b' ' || c == b'\t').count();
                        let trail = v[lead..].bytes().rev().take_while(|&c| c == b' ' || c == b'\t').count();
                        let inner = &v[lead..v.len() - trail];
                        let mut loc = f.now(p);
                        loc.column += lead as u32;
                        loc.offset += lead;
                        let pos = f.eat(p, v.len());
                        let children = p.tokenize_inline(inner, loc);
                        cells.push(Node::with_children(Kind::TableCell, pos, children));
                    }
                    f.eat(p, if a == 0 { 0 } else { 1 });
                    cell_len = 0;
                }
                cell_start = i + 1;
            } else {
                if cell_len == 0 {
                    cell_start = i;
                }
                let n = crate::util::char_len(line, i);
                cell_len = i + n - cell_start;
                if a == b'\\' && i != k - 2 {
                    let n2 = crate::util::char_len(line, i + 1);
                    cell_len = (i + 1 + n2).min(lb.len()) - cell_start;
                    i += n2;
                }
                i += n - 1;
            }
            preamble = false;
            i += 1;
        }
        if n == 0 {
            f.eat(p, 1 + align_line.len());
        }
        rows.push(Node::with_children(Kind::TableRow, row_pos, cells));
    }
    // Every row was eaten piecewise; the frame now sits at the table's end.
    f.add(Node::with_children(Kind::Table { align }, table_pos, rows));
    true
}

pub(crate) fn paragraph(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let b = t.as_bytes();
    let len = b.len();
    let mut v: Option<usize> = index_of(t, "\n", 0);
    let end;
    loop {
        let Some(vi) = v else {
            end = len;
            break;
        };
        if byte(t, vi + 1) == b'\n' {
            end = vi;
            break;
        }
        // commonmark: an indented following line continues the paragraph.
        let mut h = 0;
        let mut c = vi + 1;
        let mut last = 0u8;
        while c < len {
            last = b[c];
            if last == b'\t' {
                h = 4;
                break;
            }
            if last != b' ' {
                break;
            }
            h += 1;
            c += 1;
        }
        if h >= 4 && last != b'\n' {
            v = index_of(t, "\n", vi + 1);
            continue;
        }
        let rest = &t[vi + 1..];
        if p.interrupts(f, &INTERRUPT_PARAGRAPH, rest) {
            end = vi;
            break;
        }
        let c0 = vi;
        v = index_of(t, "\n", vi + 1);
        if let Some(nv) = v {
            if js_trim(&t[c0..nv]).is_empty() {
                end = c0;
                break;
            }
        }
    }
    if silent {
        return true;
    }
    let sub = trim_trailing_newlines(&t[..end]);
    let now = f.now(p);
    let pos = f.eat(p, sub.len());
    let children = p.tokenize_inline(sub, now);
    f.add(Node::with_children(Kind::Paragraph, pos, children));
    true
}

pub(crate) fn block_id(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    // /^\^([a-zA-Z0-9\-]+)(?=$|\n$|\n\n)/
    if byte(t, 0) != b'^' {
        return false;
    }
    let n = t[1..].bytes().take_while(|c| c.is_ascii_alphanumeric() || *c == b'-').count();
    if n == 0 {
        return false;
    }
    let after = &t[1 + n..];
    if !(after.is_empty() || after == "\n" || after.starts_with("\n\n")) {
        return false;
    }
    if silent {
        return true;
    }
    let id = t[1..1 + n].to_string();
    let pos = f.eat(p, 1 + n);
    f.add(Node::new(Kind::BlockId(id), pos));
    true
}

pub(crate) fn footnote_definition(p: &mut Parser, f: &mut Frame, t: &str, silent: bool) -> bool {
    let b = t.as_bytes();
    let a_len = b.len();
    let code = |i: usize| -> Option<u8> { b.get(i).copied() };
    let mut s = 0;
    while s < a_len && (b[s] == b'\t' || b[s] == b' ') {
        s += 1;
    }
    if code(s) != Some(b'[') || code(s + 1) != Some(b'^') {
        return false;
    }
    s += 2;
    let i0 = s;
    let mut close = None;
    while s < a_len + 1 {
        match code(s) {
            None | Some(b'\n') | Some(b'\t') | Some(b' ') => return false,
            Some(b']') => {
                close = Some(s);
                s += 1;
                break;
            }
            _ => s += 1,
        }
    }
    let Some(o) = close else { return false };
    if o == i0 || code(s) != Some(b':') {
        return false;
    }
    s += 1;
    if silent {
        return true;
    }
    let label = &t[i0..o];
    let l = f.now(p);
    struct Seg {
        start: usize,
        content_start: usize,
        content_end: usize,
        end: usize,
    }
    let mut segs: Vec<Seg> = Vec::new();
    let mut h = 0usize;
    let mut indent: Option<usize> = Some(0);
    let mut y: Option<usize> = Some(s);
    // `t.slice(S, 1024)` counts UTF-16 units from the start of the value.
    let limit = utf16_limit(t, 1024);
    while s < a_len + 1 {
        let a = code(s);
        if a.is_none() || a == Some(b'\n') {
            let cs = match y {
                Some(v) if v != 0 => v,
                _ => s,
            };
            let mut seg = Seg { start: h, content_start: cs, content_end: s, end: s };
            if a == Some(b'\n') {
                h = s + 1;
                indent = Some(0);
                y = None;
                seg.end = h;
            }
            segs.push(seg);
        } else if let Some(pi) = indent {
            let ch = a.unwrap();
            if ch == b' ' || ch == b'\t' {
                let np = pi + if ch == b' ' { 1 } else { 4 - pi % 4 };
                if np > 4 {
                    indent = None;
                    y = Some(s);
                } else {
                    indent = Some(np);
                }
            } else {
                if pi < 4 {
                    if let Some(prev) = segs.last() {
                        let blank = prev.content_start == prev.content_end;
                        let slice = if s < limit { &t[s..limit] } else { "" };
                        if blank || interrupts_footnote(p, f, slice) {
                            break;
                        }
                    }
                }
                indent = None;
                y = Some(s);
            }
        }
        s += if a.map(|c| c >= 0x80).unwrap_or(false) { crate::util::char_len(t, s) } else { 1 };
    }
    let mut count = segs.len();
    while count > 0 && segs[count - 1].content_start == segs[count - 1].content_end {
        count -= 1;
    }
    let last_end = if count > 0 { segs[count - 1].content_end } else { segs[0].content_end };
    let pos = f.eat(p, last_end);
    let mut value = String::new();
    for (k, seg) in segs.iter().take(count).enumerate() {
        p.add_offset(l.line + k as u32, seg.content_start - seg.start);
        value.push_str(&t[seg.content_start..seg.end.min(a_len)]);
    }
    let was = p.in_block;
    p.in_block = true;
    let children = p.tokenize_block(&value, l);
    p.in_block = was;
    f.add(Node::with_children(
        Kind::FootnoteDefinition { identifier: js_lower(label), label: label.to_string() },
        pos,
        children,
    ));
    true
}

fn interrupts_footnote(p: &mut Parser, f: &mut Frame, v: &str) -> bool {
    for &m in INTERRUPT_FOOTNOTE.iter() {
        if run_block(p, f, m, v, true) {
            return true;
        }
    }
    false
}

/// The byte index at which `utf16` code units have been counted (clamped to
/// a char boundary at or before it).
fn utf16_limit(t: &str, utf16: usize) -> usize {
    if t.len() <= utf16 && t.is_ascii() {
        return t.len();
    }
    let mut units = 0;
    for (i, c) in t.char_indices() {
        if units + c.len_utf16() > utf16 {
            return i;
        }
        units += c.len_utf16();
    }
    let _ = utf16_len;
    t.len()
}
