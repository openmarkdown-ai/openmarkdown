//! Small JS-compatibility helpers the port leans on everywhere: word counting,
//! JS `trim`/`\s` semantics, UTF-16 `indexOf`, cached regexes and selectors,
//! and a DOM extension trait that reads like the DOM calls Defuddle makes.

use crate::html::{Document, NodeData, NodeId};
use crate::selector::{self, SelectorList};

/// JS whitespace (`\s` / `String.prototype.trim`): ASCII whitespace plus the
/// Unicode spaces, line terminators and the BOM.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2028}'
            | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_space)
}

/// Defuddle's `countWords`: CJK characters count one each, everything else
/// splits on code units `<= 32`.
pub fn count_words(text: &str) -> usize {
    let mut cjk = 0;
    let mut words = 0;
    let mut in_word = false;
    for c in text.chars() {
        let code = c as u32;
        if (0x3040..=0x309f).contains(&code)
            || (0x30a0..=0x30ff).contains(&code)
            || (0x3400..=0x4dbf).contains(&code)
            || (0x4e00..=0x9fff).contains(&code)
            || (0xf900..=0xfaff).contains(&code)
            || (0xac00..=0xd7af).contains(&code)
        {
            cjk += 1;
            in_word = false;
        } else if code <= 32 {
            in_word = false;
        } else if !in_word {
            words += 1;
            in_word = true;
        }
    }
    cjk + words
}

/// Defuddle's `normalizeText` for title/heading comparison.
pub fn normalize_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        let mapped: &str = match c {
            '\u{a0}' => " ",
            '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}' => "'",
            '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' => "-",
            '\u{201c}' | '\u{201d}' | '\u{201e}' | '\u{201f}' => "\"",
            '\u{2026}' => "...",
            _ => "",
        };
        if !mapped.is_empty() {
            for m in mapped.chars() {
                push_collapsed(&mut out, &mut pending_space, m);
            }
        } else {
            push_collapsed(&mut out, &mut pending_space, c);
        }
    }
    js_trim(&out).to_lowercase()
}

fn push_collapsed(out: &mut String, pending: &mut bool, c: char) {
    if is_js_space(c) {
        if !*pending {
            out.push(' ');
            *pending = true;
        }
    } else {
        out.push(c);
        *pending = false;
    }
}

/// Collapse runs of JS whitespace into one space (`.replace(/\s+/g, ' ')`).
pub fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending = false;
    for c in s.chars() {
        push_collapsed(&mut out, &mut pending, c);
    }
    out
}

pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// JS `hay.indexOf(needle)` in UTF-16 units, `-1` when absent.
pub fn js_index_of(hay: &str, needle: &str) -> i64 {
    match hay.find(needle) {
        Some(b) => utf16_len(&hay[..b]) as i64,
        None => -1,
    }
}

/// JS `s.substring(0, n)` on UTF-16 units (never splits a char).
pub fn js_prefix(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// JS `parseInt(s)` (base 10).
pub fn parse_int(s: &str) -> Option<i64> {
    crate::value::parse_int(js_trim_start(s))
}

/// JS `parseFloat(s)`; NaN becomes `None`.
pub fn parse_float(s: &str) -> Option<f64> {
    let v = crate::value::parse_float(js_trim_start(s));
    if v.is_nan() {
        None
    } else {
        Some(v)
    }
}

/// Uppercase the first char (`s.charAt(0).toUpperCase() + s.slice(1)`).
pub fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

const JS_SPACE_CLASS: &str =
    r"\s\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// Compile a JS regex source with `regex_lite`, widening `\s`/`\S` to JS's
/// Unicode whitespace set (regex_lite's are ASCII-only).
pub fn re(pattern: &str) -> regex_lite::Regex {
    let mut out = String::with_capacity(pattern.len() + 16);
    let mut in_class = false;
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let Some(n) = chars.next() else {
                    out.push('\\');
                    break;
                };
                match (n, in_class) {
                    ('s', false) => {
                        out.push('[');
                        out.push_str(JS_SPACE_CLASS);
                        out.push(']');
                    }
                    ('s', true) => out.push_str(JS_SPACE_CLASS),
                    ('S', false) => {
                        out.push_str("[^");
                        out.push_str(JS_SPACE_CLASS);
                        out.push(']');
                    }
                    _ => {
                        out.push('\\');
                        out.push(n);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push('[');
                if chars.peek() == Some(&'^') {
                    out.push('^');
                    chars.next();
                }
                if chars.peek() == Some(&']') {
                    out.push_str("\\]");
                    chars.next();
                }
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            _ => out.push(c),
        }
    }
    regex_lite::Regex::new(&out).unwrap_or_else(|e| panic!("bad regex {pattern}: {e}"))
}

/// A lazily compiled, process-wide regex.
macro_rules! regex {
    ($p:expr) => {{
        static R: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
        R.get_or_init(|| $crate::extract::util::re($p))
    }};
}
pub(crate) use regex;

/// A lazily parsed, process-wide selector list.
macro_rules! sel {
    ($s:expr) => {{
        static S: std::sync::OnceLock<$crate::selector::SelectorList> = std::sync::OnceLock::new();
        S.get_or_init(|| {
            $crate::selector::parse($s).unwrap_or_else(|e| panic!("bad selector {}: {}", $s, e))
        })
    }};
}
pub(crate) use sel;

/// DOM calls in the shape Defuddle writes them.
pub trait DomExt {
    fn qsa(&self, root: NodeId, list: &SelectorList) -> Vec<NodeId>;
    fn qs(&self, root: NodeId, list: &SelectorList) -> Option<NodeId>;
    fn is(&self, id: NodeId, list: &SelectorList) -> bool;
    fn closest_sel(&self, id: NodeId, list: &SelectorList) -> Option<NodeId>;
    fn closest_tags(&self, id: NodeId, tags: &[&str]) -> Option<NodeId>;
    fn by_tag(&self, root: NodeId, tag: &str) -> Vec<NodeId>;
    fn by_tags(&self, root: NodeId, tags: &[&str]) -> Vec<NodeId>;
    fn has_tag_desc(&self, root: NodeId, tags: &[&str]) -> bool;
    fn count_tag(&self, root: NodeId, tag: &str) -> usize;
    fn get(&self, id: NodeId, name: &str) -> &str;
    fn class_name(&self, id: NodeId) -> &str;
    fn id_of(&self, id: NodeId) -> &str;
    fn tag_name(&self, id: NodeId) -> &str;
    fn tc(&self, id: NodeId) -> String;
    fn trimmed_text(&self, id: NodeId) -> String;
    fn elem_children(&self, id: NodeId) -> Vec<NodeId>;
    fn first_elem_child(&self, id: NodeId) -> Option<NodeId>;
    fn last_elem_child(&self, id: NodeId) -> Option<NodeId>;
    fn first_child(&self, id: NodeId) -> Option<NodeId>;
    fn last_child(&self, id: NodeId) -> Option<NodeId>;
    fn is_text(&self, id: NodeId) -> bool;
    fn has_parent(&self, id: NodeId) -> bool;
    fn remove(&mut self, id: NodeId);
    fn replace_with_nodes(&mut self, old: NodeId, new: &[NodeId]);
    fn transfer_children(&mut self, from: NodeId, to: NodeId);
    fn clear_children(&mut self, id: NodeId);
    fn is_svg(&self, id: NodeId) -> bool;
    fn is_before(&self, a: NodeId, b: NodeId) -> Option<bool>;
    fn elements_under(&self, root: NodeId) -> Vec<NodeId>;
}

impl DomExt for Document {
    fn qsa(&self, root: NodeId, list: &SelectorList) -> Vec<NodeId> {
        selector::select_all_parsed(self, root, list)
    }
    fn qs(&self, root: NodeId, list: &SelectorList) -> Option<NodeId> {
        let mut stack: Vec<NodeId> = self.children(root).iter().rev().copied().collect();
        while let Some(n) = stack.pop() {
            if selector::matches(self, n, list) {
                return Some(n);
            }
            for c in self.children(n).iter().rev() {
                stack.push(*c);
            }
        }
        None
    }
    fn is(&self, id: NodeId, list: &SelectorList) -> bool {
        selector::matches(self, id, list)
    }
    fn closest_sel(&self, id: NodeId, list: &SelectorList) -> Option<NodeId> {
        let mut cur = Some(id);
        while let Some(c) = cur {
            if self.is_element(c) && selector::matches(self, c, list) {
                return Some(c);
            }
            cur = self.parent(c);
        }
        None
    }
    fn closest_tags(&self, id: NodeId, tags: &[&str]) -> Option<NodeId> {
        self.closest_tag(id, tags)
    }
    fn by_tag(&self, root: NodeId, tag: &str) -> Vec<NodeId> {
        self.find_all_tags(root, &[tag])
    }
    fn by_tags(&self, root: NodeId, tags: &[&str]) -> Vec<NodeId> {
        self.find_all_tags(root, tags)
    }
    fn has_tag_desc(&self, root: NodeId, tags: &[&str]) -> bool {
        let mut stack: Vec<NodeId> = self.children(root).to_vec();
        while let Some(n) = stack.pop() {
            if self.tag(n).is_some_and(|t| tags.contains(&t)) {
                return true;
            }
            stack.extend_from_slice(self.children(n));
        }
        false
    }
    fn count_tag(&self, root: NodeId, tag: &str) -> usize {
        let mut count = 0;
        let mut stack: Vec<NodeId> = self.children(root).to_vec();
        while let Some(n) = stack.pop() {
            if self.tag(n) == Some(tag) {
                count += 1;
            }
            stack.extend_from_slice(self.children(n));
        }
        count
    }
    fn get(&self, id: NodeId, name: &str) -> &str {
        self.attr(id, name).unwrap_or("")
    }
    fn class_name(&self, id: NodeId) -> &str {
        self.attr(id, "class").unwrap_or("")
    }
    fn id_of(&self, id: NodeId) -> &str {
        self.attr(id, "id").unwrap_or("")
    }
    fn tag_name(&self, id: NodeId) -> &str {
        self.tag(id).unwrap_or("")
    }
    fn tc(&self, id: NodeId) -> String {
        self.text_content(id)
    }
    fn trimmed_text(&self, id: NodeId) -> String {
        js_trim(&self.text_content(id)).to_string()
    }
    fn elem_children(&self, id: NodeId) -> Vec<NodeId> {
        self.element_children(id)
    }
    fn first_elem_child(&self, id: NodeId) -> Option<NodeId> {
        self.children(id).iter().copied().find(|c| self.is_element(*c))
    }
    fn last_elem_child(&self, id: NodeId) -> Option<NodeId> {
        self.children(id).iter().rev().copied().find(|c| self.is_element(*c))
    }
    fn first_child(&self, id: NodeId) -> Option<NodeId> {
        self.children(id).first().copied()
    }
    fn last_child(&self, id: NodeId) -> Option<NodeId> {
        self.children(id).last().copied()
    }
    fn is_text(&self, id: NodeId) -> bool {
        matches!(self.node(id).data, NodeData::Text(_))
    }
    fn has_parent(&self, id: NodeId) -> bool {
        self.parent(id).is_some()
    }
    fn remove(&mut self, id: NodeId) {
        self.detach(id);
    }
    fn replace_with_nodes(&mut self, old: NodeId, new: &[NodeId]) {
        if self.parent(old).is_none() {
            // DOM: replaceWith on a parentless node is a no-op, but the nodes
            // are still pulled out of wherever they were.
            for n in new {
                if *n != old {
                    self.detach(*n);
                }
            }
            return;
        }
        for n in new {
            if *n == old {
                continue;
            }
            self.insert_before(old, *n);
        }
        if !new.contains(&old) {
            self.detach(old);
        }
    }
    fn transfer_children(&mut self, from: NodeId, to: NodeId) {
        self.move_children(from, to);
    }
    fn clear_children(&mut self, id: NodeId) {
        for c in self.children(id).to_vec() {
            self.detach(c);
        }
    }
    fn is_svg(&self, id: NodeId) -> bool {
        self.closest_tag(id, &["svg"]).is_some()
    }
    /// `a.compareDocumentPosition(b) & FOLLOWING` — `None` when disconnected.
    fn is_before(&self, a: NodeId, b: NodeId) -> Option<bool> {
        if a == b {
            return Some(false);
        }
        let mut pa = vec![a];
        pa.extend(self.ancestors(a));
        let mut pb = vec![b];
        pb.extend(self.ancestors(b));
        if pa.last() != pb.last() {
            return None;
        }
        // Walk from the common root down.
        let mut ia = pa.len();
        let mut ib = pb.len();
        while ia > 0 && ib > 0 && pa[ia - 1] == pb[ib - 1] {
            ia -= 1;
            ib -= 1;
        }
        if ia == 0 {
            // a is an ancestor of b: b follows a.
            return Some(true);
        }
        if ib == 0 {
            return Some(false);
        }
        let parent = pa[ia];
        let ca = pa[ia - 1];
        let cb = pb[ib - 1];
        let kids = self.children(parent);
        let posa = kids.iter().position(|k| *k == ca);
        let posb = kids.iter().position(|k| *k == cb);
        Some(posa < posb)
    }
    fn elements_under(&self, root: NodeId) -> Vec<NodeId> {
        self.descendant_elements(root)
    }
}

pub fn remove_class(doc: &mut Document, id: NodeId, names: &[&str]) {
    if let Some(cls) = doc.attr(id, "class") {
        let kept: Vec<&str> = cls.split_ascii_whitespace().filter(|c| !names.contains(c)).collect();
        let v = kept.join(" ");
        doc.set_attr(id, "class", &v);
    }
}

/// Text of an element with `script`, `style` and `noscript` subtrees skipped.
pub fn visible_text(doc: &Document, id: NodeId) -> String {
    let mut out = String::new();
    let mut stack: Vec<NodeId> = doc.children(id).iter().rev().copied().collect();
    while let Some(n) = stack.pop() {
        match &doc.node(n).data {
            NodeData::Text(t) => out.push_str(t),
            NodeData::Element { name, .. } => {
                if matches!(name.as_str(), "script" | "style" | "noscript") {
                    continue;
                }
                for c in doc.children(n).iter().rev() {
                    stack.push(*c);
                }
            }
            _ => {}
        }
    }
    out
}

/// JS `decodeURIComponent`, `None` on malformed escapes.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            let v = u8::from_str_radix(hex, 16).ok()?;
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_helpers_match_js_semantics() {
        assert_eq!(count_words("hello  world\u{a0}x"), 2);
        assert_eq!(count_words("日本語 text"), 4);
        assert_eq!(normalize_text("  It\u{2019}s \u{2014} OK\u{2026} "), "it's - ok...");
        assert_eq!(js_index_of("héllo wörld", "wörld"), 6);
        assert_eq!(js_prefix("abc😀d", 4), "abc");
        assert_eq!(parse_int(" 42px"), Some(42));
        assert!(re(r"^by\s+x$").is_match("by\u{a0}x"));
        assert!(re(r"[,\s]").is_match("\u{a0}"));
        assert_eq!(decode_uri_component("a%5Cb%20"), Some("a\\b ".to_string()));
        assert_eq!(decode_uri_component("%zz"), None);
    }
}
