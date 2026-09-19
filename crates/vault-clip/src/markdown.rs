//! HTML → Markdown, as Obsidian Web Clipper produces it.
//!
//! The clipper converts with Defuddle's `createMarkdownContent`
//! (defuddle/src/markdown.ts, MIT): Turndown 7 configured with ATX headings,
//! `-` bullets, fenced code, `*` emphasis and preformatted code, plus ~20
//! custom rules (tables with layout/complex detection, tab-indented lists,
//! task items, figures, srcset images, YouTube/X embeds, `==mark==`, `~~del~~`,
//! footnotes, MathML/KaTeX → `$…$`, callouts). This module ports Turndown's
//! machinery — whitespace collapsing, per-text-node escaping, flanking
//! whitespace, blank-node handling and the newline-joining of replacements —
//! and those rules, in the same precedence order (Turndown consults the most
//! recently added rule first).
//!
//! Deliberate departures from the clipper:
//! * A task checkbox is checked when the `checked` attribute is present.
//!   Defuddle tests `getAttribute('checked')` for truthiness, so GitHub's
//!   `checked=""` came out unchecked.
//! * A `<li>` whose first element is a checkbox is a task item even without
//!   GitHub's `task-list-item` class (common in plain snippets).
//! * [`html_to_markdown`] (the plugin API) first applies the extractor's
//!   element standardisation (code-block languages, callouts, math, lazy
//!   images, absolute URLs) and does not strip a leading `# H1`; the clipper
//!   path [`clean_html_to_markdown`] converts already-standardised content and
//!   strips it, as `createMarkdownContent` does.

use crate::html::{Document, NodeData, NodeId};

/// Convert an HTML fragment (or document) to Markdown. Relative `href`/`src`
/// are resolved against `base_url` when given.
pub fn html_to_markdown(html: &str, base_url: Option<&str>) -> String {
    let html = strip_wbr(html);
    let mut doc = Document::parse(&html);
    // A whole document: only the body is content. A fragment that still
    // carries head-only elements must not leak their text into the note.
    for id in doc.find_all_tags(0, &["head", "title", "template"]) {
        doc.detach(id);
    }
    let root = doc.find_tag(0, "body").unwrap_or(0);
    crate::extract::standardize_fragment(&mut doc, root, base_url);
    if let Some(base) = base_url {
        absolutize(&mut doc, root, base);
    }
    let inner = doc.inner_html(root);
    convert(&inner, false)
}

/// `createMarkdownContent`: convert Defuddle-standardised HTML (the clipper's
/// `{{content}}`), stripping a leading `# ` title line.
pub fn clean_html_to_markdown(html: &str) -> String {
    convert(&strip_wbr(html), true)
}

fn strip_wbr(html: &str) -> String {
    // content.replace(/<wbr\s*\/?>/gi, '')
    let re = regex_lite::Regex::new(r"(?i)<wbr\s*/?>").unwrap();
    re.replace_all(html, "").into_owned()
}

fn absolutize(doc: &mut Document, root: NodeId, base: &str) {
    for id in doc.descendant_elements(root) {
        for attr in ["href", "src", "poster"] {
            if let Some(v) = doc.attr(id, attr).map(str::to_string) {
                let t = v.trim();
                if t.is_empty() || t.starts_with('#') {
                    continue;
                }
                if let Some(abs) = crate::url::resolve(base, t) {
                    if abs != v {
                        doc.set_attr(id, attr, &abs);
                    }
                }
            }
        }
        if let Some(srcset) = doc.attr(id, "srcset").map(str::to_string) {
            let resolved: Vec<String> = srcset
                .split(',')
                .map(|cand| {
                    let cand = cand.trim();
                    let mut parts = cand.splitn(2, char::is_whitespace);
                    let url = parts.next().unwrap_or("");
                    let desc = parts.next().unwrap_or("").trim();
                    let abs = crate::url::resolve(base, url).unwrap_or_else(|| url.to_string());
                    if desc.is_empty() {
                        abs
                    } else {
                        format!("{abs} {desc}")
                    }
                })
                .collect();
            doc.set_attr(id, "srcset", &resolved.join(", "));
        }
    }
}

fn convert(html: &str, strip_h1: bool) -> String {
    let mut md = turndown(html);
    if strip_h1 {
        // /^# .+\n+/
        if md.starts_with("# ") {
            if let Some(nl) = md.find('\n') {
                if nl > 2 {
                    let mut end = nl;
                    while md.as_bytes().get(end) == Some(&b'\n') {
                        end += 1;
                    }
                    md = md[end..].to_string();
                }
            }
        }
    }
    md = remove_empty_links(&md);
    md = space_bang_before_image(&md);
    md = collapse_newlines(&md);
    md = collapse_blank_quote_runs(&md);
    md.trim().to_string()
}

/// `markdown.replace(/\n*(?<!!)\[]\([^)]+\)\n*/g, '')`
fn remove_empty_links(md: &str) -> String {
    if !md.contains("[](") {
        return md.to_string();
    }
    let b = md.as_bytes();
    let mut out = String::with_capacity(md.len());
    let mut i = 0;
    let mut last = 0;
    while let Some(off) = md[i..].find("[](") {
        let at = i + off;
        let preceded_by_bang = at > 0 && b[at - 1] == b'!';
        // [^)]+ then ')'
        let close = md[at + 3..].find(')').map(|c| at + 3 + c);
        match close {
            Some(c) if c > at + 3 && !preceded_by_bang && !md[at + 3..c].is_empty() => {
                let mut start = at;
                while start > last && b[start - 1] == b'\n' {
                    start -= 1;
                }
                let mut end = c + 1;
                while end < b.len() && b[end] == b'\n' {
                    end += 1;
                }
                out.push_str(&md[last..start]);
                last = end;
                i = end;
            }
            _ => {
                i = at + 3;
            }
        }
    }
    out.push_str(&md[last..]);
    out
}

/// `markdown.replace(/!(?=!\[|\[!\[)/g, '! ')`
fn space_bang_before_image(md: &str) -> String {
    let b = md.as_bytes();
    let mut out = String::with_capacity(md.len());
    for (i, ch) in md.char_indices() {
        out.push(ch);
        if ch == '!' && (md[i + 1..].starts_with("![") || md[i + 1..].starts_with("[![")) {
            out.push(' ');
        }
        let _ = b;
    }
    out
}

fn collapse_newlines(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut run = 0;
    for ch in md.chars() {
        if ch == '\n' {
            run += 1;
            if run <= 2 {
                out.push('\n');
            }
        } else {
            run = 0;
            out.push(ch);
        }
    }
    out
}

/// `/^([ \t]*>[ \t>]*)(?:\n[ \t]*>[ \t>]*)+$/gm` → `$1`
fn collapse_blank_quote_runs(md: &str) -> String {
    let is_blank_quote = |l: &str| {
        let t = l.trim_start_matches([' ', '\t']);
        t.starts_with('>') && t.chars().all(|c| c == '>' || c == ' ' || c == '\t')
    };
    let lines: Vec<&str> = md.split('\n').collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        if is_blank_quote(lines[i]) {
            out.push(lines[i]);
            let mut j = i + 1;
            while j < lines.len() && is_blank_quote(lines[j]) {
                j += 1;
            }
            i = j;
            continue;
        }
        out.push(lines[i]);
        i += 1;
    }
    out.join("\n")
}

// ---- Turndown core ----------------------------------------------------------------

const BLOCK: &[&str] = &[
    "address", "article", "aside", "audio", "blockquote", "body", "canvas", "center", "dd", "dir",
    "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "frameset", "h1",
    "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "html", "isindex", "li", "main",
    "menu", "nav", "noframes", "noscript", "ol", "output", "p", "pre", "section", "table",
    "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
];
const VOID: &[&str] = &[
    "area", "base", "br", "col", "command", "embed", "hr", "img", "input", "keygen", "link",
    "meta", "param", "source", "track", "wbr",
];
const MEANINGFUL_WHEN_BLANK: &[&str] = &[
    "a", "table", "thead", "tbody", "tfoot", "th", "td", "iframe", "script", "audio", "video",
];

/// Parse `html` inside a fresh root and convert it (Turndown `turndown()`).
pub fn turndown(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }
    let mut doc = Document::parse(html);
    let root = 0;
    collapse_whitespace(&mut doc, root);
    let mut t = Td { doc };
    let out = t.process(root, false);
    // postProcess
    let out = out.trim_start_matches(['\t', '\r', '\n']);
    out.trim_end_matches(|c: char| c.is_whitespace()).to_string()
}

fn tag_of(doc: &Document, id: NodeId) -> &str {
    doc.tag(id).unwrap_or("")
}

fn is_block(doc: &Document, id: NodeId) -> bool {
    BLOCK.contains(&tag_of(doc, id))
}

fn is_pre_or_code(doc: &Document, id: NodeId) -> bool {
    matches!(tag_of(doc, id), "pre" | "code")
}

/// collapse-whitespace, with `isPre` = PRE or CODE (preformattedCode: true).
fn collapse_whitespace(doc: &mut Document, element: NodeId) {
    if doc.children(element).is_empty() || is_pre_or_code(doc, element) {
        return;
    }
    let mut prev_text: Option<NodeId> = None;
    let mut keep_leading_ws = false;
    let mut prev: Option<NodeId> = None;
    let mut node = next_node(doc, prev, element);
    let mut guard = 0usize;
    while node != element {
        guard += 1;
        if guard > 50_000_000 {
            break;
        }
        match &doc.node(node).data {
            NodeData::Text(t) => {
                let mut text = collapse_ascii_ws(t);
                let prev_ends_space = prev_text
                    .map(|p| doc.text(p).is_some_and(|s| s.ends_with(' ')))
                    .unwrap_or(true);
                if prev_ends_space && !keep_leading_ws && text.starts_with(' ') {
                    text.remove(0);
                }
                if text.is_empty() {
                    node = remove_and_next(doc, node);
                    continue;
                }
                doc.set_text(node, &text);
                prev_text = Some(node);
            }
            NodeData::Element { name, .. } => {
                let name = name.clone();
                if BLOCK.contains(&name.as_str()) || name == "br" {
                    if let Some(p) = prev_text {
                        let s = doc.text(p).unwrap_or("").to_string();
                        if let Some(stripped) = s.strip_suffix(' ') {
                            doc.set_text(p, stripped);
                        }
                    }
                    prev_text = None;
                    keep_leading_ws = false;
                } else if VOID.contains(&name.as_str()) || name == "pre" || name == "code" {
                    prev_text = None;
                    keep_leading_ws = true;
                } else if prev_text.is_some() {
                    keep_leading_ws = false;
                }
            }
            _ => {
                node = remove_and_next(doc, node);
                continue;
            }
        }
        let n = next_node(doc, Some(node), node);
        let nn = next_after(doc, prev, node);
        let _ = n;
        prev = Some(node);
        node = nn;
    }
    if let Some(p) = prev_text {
        let s = doc.text(p).unwrap_or("").to_string();
        let stripped = s.strip_suffix(' ').unwrap_or(&s).to_string();
        if stripped.is_empty() {
            doc.detach(p);
        } else {
            doc.set_text(p, &stripped);
        }
    }
}

fn collapse_ascii_ws(t: &str) -> String {
    let mut out = String::with_capacity(t.len());
    let mut in_ws = false;
    for ch in t.chars() {
        if matches!(ch, ' ' | '\r' | '\n' | '\t') {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            in_ws = false;
            out.push(ch);
        }
    }
    out
}

/// `next(prev, current)` for the starting call.
fn next_node(doc: &Document, _prev: Option<NodeId>, current: NodeId) -> NodeId {
    if let Some(&first) = doc.children(current).first() {
        return first;
    }
    doc.next_sibling(current).or(doc.parent(current)).unwrap_or(current)
}

/// Turndown's `next(prev, current, isPre)`.
fn next_after(doc: &Document, prev: Option<NodeId>, current: NodeId) -> NodeId {
    let came_up = prev.is_some_and(|p| doc.parent(p) == Some(current));
    if came_up || is_pre_or_code(doc, current) {
        return doc.next_sibling(current).or(doc.parent(current)).unwrap_or(0);
    }
    if let Some(&first) = doc.children(current).first() {
        return first;
    }
    doc.next_sibling(current).or(doc.parent(current)).unwrap_or(0)
}

fn remove_and_next(doc: &mut Document, node: NodeId) -> NodeId {
    let next = doc.next_sibling(node).or(doc.parent(node)).unwrap_or(0);
    doc.detach(node);
    next
}

fn is_js_ws(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

struct Edges {
    leading: String,
    leading_ascii: String,
    leading_non_ascii: String,
    trailing: String,
    trailing_ascii: String,
    trailing_non_ascii: String,
}

fn edge_whitespace(s: &str) -> Edges {
    let chars: Vec<char> = s.chars().collect();
    let ascii = |c: char| matches!(c, ' ' | '\t' | '\r' | '\n');
    let mut i = 0;
    while i < chars.len() && ascii(chars[i]) {
        i += 1;
    }
    let la_end = i;
    while i < chars.len() && is_js_ws(chars[i]) {
        i += 1;
    }
    let l_end = i;
    if l_end == chars.len() {
        let all: String = chars.iter().collect();
        return Edges {
            leading: all,
            leading_ascii: chars[..la_end].iter().collect(),
            leading_non_ascii: chars[la_end..].iter().collect(),
            trailing: String::new(),
            trailing_ascii: String::new(),
            trailing_non_ascii: String::new(),
        };
    }
    let mut j = chars.len();
    while j > l_end && ascii(chars[j - 1]) {
        j -= 1;
    }
    let ta_start = j;
    while j > l_end && is_js_ws(chars[j - 1]) {
        j -= 1;
    }
    let t_start = j;
    Edges {
        leading: chars[..l_end].iter().collect(),
        leading_ascii: chars[..la_end].iter().collect(),
        leading_non_ascii: chars[la_end..l_end].iter().collect(),
        trailing: chars[t_start..].iter().collect(),
        trailing_ascii: chars[ta_start..].iter().collect(),
        trailing_non_ascii: chars[t_start..ta_start].iter().collect(),
    }
}

fn trim_leading_newlines(s: &str) -> &str {
    s.trim_start_matches('\n')
}

fn trim_trailing_newlines(s: &str) -> &str {
    s.trim_end_matches('\n')
}

/// Turndown `join`.
fn join(output: &str, replacement: &str) -> String {
    let s1 = trim_trailing_newlines(output);
    let s2 = trim_leading_newlines(replacement);
    let nls = (output.len() - s1.len()).max(replacement.len() - s2.len()).min(2);
    let mut out = String::with_capacity(s1.len() + s2.len() + 2);
    out.push_str(s1);
    out.push_str(&"\n".repeat(nls));
    out.push_str(s2);
    out
}

/// Turndown `escapeMarkdown` plus Defuddle's tag-like `<` escape.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '*' => out.push_str("\\*"),
            '`' => out.push_str("\\`"),
            '[' => out.push_str("\\["),
            ']' => out.push_str("\\]"),
            '_' => out.push_str("\\_"),
            c => out.push(c),
        }
    }
    // Anchored (non-multiline) escapes apply to the start of the text node.
    if let Some(rest) = out.strip_prefix('-') {
        out = format!("\\-{rest}");
    }
    if let Some(rest) = out.strip_prefix("+ ") {
        out = format!("\\+ {rest}");
    }
    if out.starts_with('=') {
        out = format!("\\{out}");
    }
    {
        let hashes = out.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && out[hashes..].starts_with(' ') {
            out = format!("\\{out}");
        }
    }
    if out.starts_with("~~~") {
        out = format!("\\{out}");
    }
    if out.starts_with('>') {
        out = format!("\\{out}");
    }
    {
        let digits = out.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits > 0 && out[digits..].starts_with(". ") {
            out = format!("{}\\{}", &out[..digits], &out[digits..]);
        }
    }
    // Defuddle: /<(?=\/?[A-Za-z][A-Za-z0-9-]*(?:\s|\/?>))/g → '\<'
    if out.contains('<') {
        let chars: Vec<char> = out.chars().collect();
        let mut res = String::with_capacity(out.len() + 4);
        for (i, &c) in chars.iter().enumerate() {
            if c == '<' {
                let mut k = i + 1;
                if chars.get(k) == Some(&'/') {
                    k += 1;
                }
                if chars.get(k).is_some_and(|x| x.is_ascii_alphabetic()) {
                    k += 1;
                    while chars.get(k).is_some_and(|x| x.is_ascii_alphanumeric() || *x == '-') {
                        k += 1;
                    }
                    let after = chars.get(k).copied();
                    let tagish = match after {
                        Some(x) if x.is_whitespace() => true,
                        Some('>') => true,
                        Some('/') => chars.get(k + 1) == Some(&'>'),
                        _ => false,
                    };
                    if tagish {
                        res.push('\\');
                    }
                }
            }
            res.push(c);
        }
        out = res;
    }
    out
}

struct Td {
    doc: Document,
}

fn is_blank(doc: &Document, id: NodeId) -> bool {
    let tag = tag_of(doc, id);
    if VOID.contains(&tag) || MEANINGFUL_WHEN_BLANK.contains(&tag) {
        return false;
    }
    if !doc.text_content(id).chars().all(is_js_ws) {
        return false;
    }
    !doc.descendant_elements(id).iter().any(|d| {
        let t = tag_of(doc, *d);
        VOID.contains(&t) || MEANINGFUL_WHEN_BLANK.contains(&t)
    })
}

impl Td {
    fn process(&mut self, parent: NodeId, parent_is_code: bool) -> String {
        let mut output = String::new();
        let kids = self.doc.children(parent).to_vec();
        for child in kids {
            if !self.doc.is_attached(child) && self.doc.parent(child) != Some(parent) {
                continue;
            }
            let replacement = match &self.doc.node(child).data {
                NodeData::Text(t) => {
                    if parent_is_code {
                        t.clone()
                    } else {
                        escape(t)
                    }
                }
                // <template> content is not part of the rendered tree.
                NodeData::Element { name, .. } if name == "template" => String::new(),
                NodeData::Element { .. } => self.replacement_for_node(child, parent_is_code),
                _ => String::new(),
            };
            output = join(&output, &replacement);
        }
        output
    }

    fn flanking(&self, id: NodeId, is_code: bool) -> (String, String) {
        if is_block(&self.doc, id) || is_code {
            return (String::new(), String::new());
        }
        let e = edge_whitespace(&self.doc.text_content(id));
        let mut leading = e.leading.clone();
        let mut trailing = e.trailing.clone();
        if !e.leading_ascii.is_empty() && self.flanked(id, true) {
            leading = e.leading_non_ascii;
        }
        if !e.trailing_ascii.is_empty() && self.flanked(id, false) {
            trailing = e.trailing_non_ascii;
        }
        (leading, trailing)
    }

    fn flanked(&self, id: NodeId, left: bool) -> bool {
        let sib = if left {
            self.doc.prev_sibling(id)
        } else {
            self.doc.next_sibling(id)
        };
        let Some(s) = sib else { return false };
        match &self.doc.node(s).data {
            NodeData::Text(t) => {
                if left {
                    t.ends_with(' ')
                } else {
                    t.starts_with(' ')
                }
            }
            NodeData::Element { name, .. } => {
                if name == "code" {
                    return false;
                }
                if BLOCK.contains(&name.as_str()) {
                    return false;
                }
                let tc = self.doc.text_content(s);
                if left {
                    tc.ends_with(' ')
                } else {
                    tc.starts_with(' ')
                }
            }
            _ => false,
        }
    }

    fn replacement_for_node(&mut self, id: NodeId, parent_is_code: bool) -> String {
        let is_code = self.doc.tag(id) == Some("code") || parent_is_code;
        let (leading, trailing) = self.flanking(id, is_code);
        if is_blank(&self.doc, id) {
            let r = if is_block(&self.doc, id) { "\n\n" } else { "" };
            return format!("{leading}{r}{trailing}");
        }
        let mut content = self.process(id, is_code);
        if !leading.is_empty() || !trailing.is_empty() {
            content = content.trim_matches(is_js_ws).to_string();
        }
        let r = self.rule(id, content, is_code);
        format!("{leading}{r}{trailing}")
    }

    /// Sub-conversion of an HTML string (`turndownService.turndown(html)`).
    fn sub(&self, html: &str) -> String {
        turndown(html)
    }

    fn rule(&mut self, id: NodeId, content: String, _is_code: bool) -> String {
        let tag = tag_of(&self.doc, id).to_string();
        let attr = |d: &Document, n: &str| d.attr(id, n).map(str::to_string);
        let has_class = |d: &Document, c: &str| d.has_class(id, c);

        // --- Defuddle rules, most recently added first ---
        // callout
        if attr(&self.doc, "data-callout").is_some_and(|v| !v.is_empty()) && has_class(&self.doc, "callout") {
            return self.callout(id);
        }
        // katex
        if has_class(&self.doc, "math") || has_class(&self.doc, "katex") {
            return self.katex(id);
        }
        // math
        if tag == "math"
            || has_class(&self.doc, "mwe-math-element")
            || has_class(&self.doc, "mwe-math-fallback-image-inline")
            || has_class(&self.doc, "mwe-math-fallback-image-display")
        {
            return self.math(id);
        }
        // preformattedCode
        if tag == "pre" {
            if let Some(code) = self.doc.find_tag(id, "code") {
                let language = self
                    .doc
                    .attr(code, "data-lang")
                    .filter(|v| !v.is_empty())
                    .or_else(|| self.doc.attr(code, "data-language").filter(|v| !v.is_empty()))
                    .map(str::to_string)
                    .or_else(|| {
                        self.doc.attr(code, "class").and_then(|c| {
                            c.find("language-").map(|p| {
                                c[p + 9..].chars().take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_').collect::<String>()
                            })
                        }).filter(|l| !l.is_empty())
                    })
                    .or_else(|| self.doc.attr(id, "data-language").filter(|v| !v.is_empty()).map(str::to_string))
                    .unwrap_or_default();
                let code_text = self.doc.text_content(code);
                let clean = code_text.trim_matches(is_js_ws).replace('`', "\\`");
                return format!("\n```{language}\n{clean}\n```\n");
            }
        }
        // removals
        if attr(&self.doc, "href").is_some_and(|h| h.contains("#fnref")) || has_class(&self.doc, "footnote-backref") {
            return String::new();
        }
        // footnotesList
        if tag == "ol" {
            if let Some(p) = self.doc.parent(id) {
                if self.doc.attr(p, "id") == Some("footnotes") {
                    return self.footnotes_list(id);
                }
            }
        }
        // citations
        if tag == "sup" {
            if let Some(fid) = attr(&self.doc, "id").filter(|v| v.starts_with("fnref:")) {
                let primary = fid["fnref:".len()..].split('-').next().unwrap_or("").to_string();
                return format!("[^{primary}]");
            }
        }
        // arXivEnumerate
        if tag == "ol" && has_class(&self.doc, "ltx_enumerate") {
            let items: Vec<String> = self
                .doc
                .element_children(id)
                .iter()
                .enumerate()
                .map(|(i, item)| {
                    let inner = self.doc.inner_html(*item);
                    let re = regex_lite::Regex::new(r#"^<span class="ltx_tag ltx_tag_item">\d+\.</span>\s*"#).unwrap();
                    let inner = re.replace(&inner, "").into_owned();
                    format!("{}. {}", i + 1, self.sub(&inner))
                })
                .collect();
            return format!("\n\n{}\n\n", items.join("\n\n"));
        }
        // complexLinkStructure
        if tag == "a" && self.doc.children(id).len() > 1 && self.doc.children(id).iter().any(|c| matches!(self.doc.tag(*c), Some("h1" | "h2" | "h3" | "h4" | "h5" | "h6"))) {
            let href = attr(&self.doc, "href");
            let title = attr(&self.doc, "title");
            let heading = self.doc.find_all_tags(id, &["h1", "h2", "h3", "h4", "h5", "h6"]).into_iter().next();
            let heading_md = heading.map(|h| self.sub(&self.doc.outer_html(h))).unwrap_or_default();
            if let Some(h) = heading {
                self.doc.detach(h);
            }
            let remaining = self.sub(&self.doc.inner_html(id));
            let mut md = format!("{heading_md}\n\n{remaining}\n\n");
            if let Some(h) = href {
                md.push_str(&format!("[View original]({}{})", link_destination(&h), link_title(title.as_deref())));
            }
            return md;
        }
        // link
        if tag == "a" {
            let Some(href) = attr(&self.doc, "href").filter(|h| !h.is_empty()) else {
                return content;
            };
            let title = link_title(attr(&self.doc, "title").as_deref());
            return format!("[{content}]({}{title})", link_destination(&href));
        }
        // strikethrough
        if matches!(tag.as_str(), "del" | "s" | "strike") {
            return format!("~~{content}~~");
        }
        // highlight
        if tag == "mark" {
            return format!("=={content}==");
        }
        // embedToMarkdown
        // Departure: Defuddle's filter is a substring test, so `x.com` matched
        // any image on ex.com, box.com, netflix.com… and the image vanished
        // (its "content" is empty). Only real embed hosts are treated as embeds.
        if let Some(src) = attr(&self.doc, "src") {
            if is_embed_host(&src) {
                if let Some(r) = embed_to_markdown(&src) {
                    return r;
                }
                return content;
            }
        }
        // image
        if tag == "img" {
            let alt = attr(&self.doc, "alt").unwrap_or_default();
            let src = best_image_src(&self.doc, id);
            let title = attr(&self.doc, "title").unwrap_or_default();
            let title_part = if title.is_empty() { String::new() } else { format!(" \"{title}\"") };
            return if src.is_empty() { String::new() } else { format!("![{alt}]({src}{title_part})") };
        }
        // figure
        if tag == "figure" {
            if let Some(r) = self.figure(id) {
                return r;
            }
            return content_default(&self.doc, id, content);
        }
        // listItem (Defuddle)
        if tag == "li" {
            return self.list_item(id, content);
        }
        // list (Defuddle)
        if tag == "ul" || tag == "ol" {
            // Keep leading tabs: they are the indentation of a list nested
            // directly inside another list (see list_item).
            let c = content.trim_end_matches(is_js_ws).trim_start_matches(|ch: char| is_js_ws(ch) && ch != '\t');
            let top = !self.doc.parent(id).is_some_and(|p| matches!(self.doc.tag(p), Some("ul" | "ol")));
            return format!("{}{c}\n", if top { "\n" } else { "" });
        }
        // button
        if tag == "button" {
            return content;
        }
        // table
        if tag == "table" {
            return self.table(id, content);
        }

        // --- Turndown CommonMark rules ---
        match tag.as_str() {
            "p" => return format!("\n\n{content}\n\n"),
            "br" => return "  \n".into(),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let level: usize = tag[1..].parse().unwrap_or(1);
                return format!("\n\n{} {content}\n\n", "#".repeat(level));
            }
            "blockquote" => {
                let c = trim_leading_newlines(trim_trailing_newlines(&content));
                let quoted = c.split('\n').map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n");
                return format!("\n\n{quoted}\n\n");
            }
            "hr" => return "\n\n---\n\n".into(),
            "em" | "i" => {
                return if content.trim().is_empty() { String::new() } else { format!("*{content}*") };
            }
            "strong" | "b" => {
                return if content.trim().is_empty() { String::new() } else { format!("**{content}**") };
            }
            "code" => {
                let parent_pre = self.doc.parent(id).is_some_and(|p| self.doc.tag(p) == Some("pre"));
                let has_siblings = self.doc.prev_sibling(id).is_some() || self.doc.next_sibling(id).is_some();
                if !(parent_pre && !has_siblings) {
                    return inline_code(&content);
                }
            }
            _ => {}
        }
        // keep
        if matches!(tag.as_str(), "iframe" | "video" | "audio" | "sup" | "sub" | "svg" | "math") {
            let html = self.doc.outer_html(id);
            return if is_block(&self.doc, id) { format!("\n\n{html}\n\n") } else { html };
        }
        // remove
        if matches!(tag.as_str(), "style" | "script") {
            return String::new();
        }
        content_default(&self.doc, id, content)
    }

    fn callout(&mut self, id: NodeId) -> String {
        let ty = self.doc.attr(id, "data-callout").unwrap_or("note").to_string();
        let fold = match self.doc.attr(id, "data-callout-fold") {
            Some("-") => "-",
            Some("+") => "+",
            _ => "",
        };
        let title_inner = self.doc.select_first(id, ".callout-title-inner");
        let title = title_inner
            .map(|t| self.doc.text_content(t).trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| capitalize_first(&ty));
        if let Some(td) = self.doc.select_first(id, ".callout-title") {
            self.doc.detach(td);
        }
        let inner = match self.doc.select_first(id, ".callout-content") {
            Some(c) => self.doc.inner_html(c),
            None => self.doc.inner_html(id),
        };
        let md = self.sub(&inner);
        let quoted = md.trim().split('\n').map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n");
        format!("\n\n> [!{ty}]{fold} {title}\n{quoted}\n\n")
    }

    fn katex(&self, id: NodeId) -> String {
        let mut latex = self.doc.attr(id, "data-latex").unwrap_or("").to_string();
        if latex.is_empty() {
            latex = self
                .doc
                .select_first(id, r#".katex-mathml annotation[encoding="application/x-tex"]"#)
                .map(|a| self.doc.text_content(a))
                .unwrap_or_default();
        }
        if latex.is_empty() {
            latex = self.doc.text_content(id).trim().to_string();
        }
        let math_el = self.doc.select_first(id, ".katex-mathml math");
        let inline = self.doc.has_class(id, "math-inline")
            || math_el.is_some_and(|m| self.doc.attr(m, "display") != Some("block"));
        if inline {
            format!("${latex}$")
        } else {
            format!("\n$$\n{latex}\n$$\n")
        }
    }

    fn math(&self, id: NodeId) -> String {
        let latex = extract_latex(&self.doc, id).trim().to_string();
        let in_table = self.doc.closest_tag(id, &["table"]).is_some();
        let parent = self.doc.parent(id);
        let parent_mwe_after_p = parent.is_some_and(|p| {
            self.doc.has_class(p, "mwe-math-element")
                && self.doc.prev_sibling(p).is_some_and(|s| self.doc.tag(s) == Some("p"))
        });
        let block = !in_table
            && (self.doc.attr(id, "display") == Some("block")
                || self.doc.has_class(id, "mwe-math-fallback-image-display")
                || self.only_math_in_paragraph(id)
                || parent_mwe_after_p);
        if block {
            return format!("\n$$\n{}\n$$\n", format_block_latex(&latex));
        }
        let prev = self.doc.prev_sibling(id);
        let next = self.doc.next_sibling(id);
        let prev_char = prev
            .filter(|p| self.doc.is_element(*p))
            .and_then(|p| self.doc.text_content(p).chars().last());
        let next_char = next
            .filter(|n| self.doc.is_element(*n))
            .and_then(|n| self.doc.text_content(n).chars().next());
        let start_of_line = prev.is_none_or(|p| self.doc.text(p).is_some_and(|t| t.trim().is_empty()));
        let end_of_line = next.is_none_or(|n| self.doc.text(n).is_some_and(|t| t.trim().is_empty()));
        let left = if !start_of_line && prev_char.is_some_and(|c| !c.is_whitespace() && c != '$') { " " } else { "" };
        let right = if !end_of_line && next_char.is_some_and(|c| !c.is_whitespace() && c != '$') { " " } else { "" };
        format!("{left}${latex}${right}")
    }

    fn only_math_in_paragraph(&self, id: NodeId) -> bool {
        let Some(p) = self.doc.parent(id) else { return false };
        if self.doc.tag(p) != Some("p") {
            return false;
        }
        let els = self.doc.element_children(p);
        if els.len() != 1 || els[0] != id {
            return false;
        }
        self.doc
            .children(p)
            .iter()
            .all(|c| *c == id || self.doc.text(*c).is_some_and(|t| t.trim().is_empty()))
    }

    fn footnotes_list(&mut self, id: NodeId) -> String {
        let items = self.doc.element_children(id);
        let refs: Vec<String> = items
            .into_iter()
            .map(|li| {
                let mut fid: Option<String> = None;
                if let Some(li_id) = self.doc.attr(li, "id").map(str::to_string) {
                    if let Some(rest) = li_id.strip_prefix("fn:") {
                        fid = Some(rest.to_string());
                    } else {
                        let last = li_id.rsplit('/').next().unwrap_or("");
                        fid = Some(match last.find("cite_note-") {
                            Some(p) if last.len() > p + 10 => last[p + 10..].to_string(),
                            _ => li_id.clone(),
                        });
                    }
                }
                if let Some(sup) = self.doc.find_tag(li, "sup") {
                    if fid.as_deref().is_some_and(|f| self.doc.text_content(sup).trim() == f) {
                        self.doc.detach(sup);
                    }
                }
                let md = self.sub(&self.doc.inner_html(li));
                let cleaned = md.trim_end_matches(is_js_ws);
                let cleaned = cleaned.strip_suffix("↩︎").unwrap_or(cleaned).trim_matches(is_js_ws).to_string();
                format!(
                    "[^{}]: {cleaned}",
                    fid.map(|f| f.to_lowercase()).unwrap_or_else(|| "undefined".into())
                )
            })
            .collect();
        format!("\n\n{}\n\n", refs.join("\n\n"))
    }

    fn figure(&mut self, id: NodeId) -> Option<String> {
        let img = self.doc.find_tag(id, "img")?;
        let figcaption = self.doc.find_tag(id, "figcaption");
        let p_outside = self.doc.find_all_tags(id, &["p"]).into_iter().any(|p| {
            let mut anc = self.doc.parent(p);
            while let Some(a) = anc {
                if a == id {
                    break;
                }
                if self.doc.tag(a) == Some("figcaption") {
                    return false;
                }
                anc = self.doc.parent(a);
            }
            true
        });
        if p_outside {
            return None;
        }
        let alt = self.doc.attr(img, "alt").unwrap_or("").to_string();
        let src = best_image_src(&self.doc, img);
        let mut caption = String::new();
        if let Some(fc) = figcaption {
            let tag_text = self
                .doc
                .select_first(fc, ".ltx_tag_figure")
                .map(|t| self.doc.text_content(t).trim().to_string())
                .unwrap_or_default();
            let caption_html = self.doc.inner_html(fc);
            let caption_html = replace_math_in_caption(&caption_html);
            let caption_md = self.sub(&caption_html);
            caption = format!("{tag_text} {caption_md}").trim().to_string();
        }
        Some(format!("![{alt}]({src})\n\n{caption}\n\n"))
    }

    fn list_item(&mut self, id: NodeId, content: String) -> String {
        let mut content = content;
        let checkbox = self.doc.select_first(id, r#"input[type="checkbox"]"#);
        let first_el_is_checkbox = self.doc.element_children(id).first().is_some_and(|c| {
            self.doc.tag(*c) == Some("input") && self.doc.attr(*c, "type").is_some_and(|t| t.eq_ignore_ascii_case("checkbox"))
        });
        let mut marker = String::new();
        if let Some(cb) = checkbox {
            if self.doc.has_class(id, "task-list-item") || first_el_is_checkbox {
                // content.replace(/<input[^>]*>/, '')
                if let Some(start) = content.find("<input") {
                    if let Some(end) = content[start..].find('>') {
                        content.replace_range(start..start + end + 1, "");
                    }
                }
                marker = if self.doc.has_attr(cb, "checked") { "[x] ".into() } else { "[ ] ".into() };
            }
        }
        let c = content.trim_end_matches('\n');
        let joined = c.split('\n').filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n\t");
        // Departure: Defuddle prefixes each item with one tab per list level
        // *and* the enclosing <li> indents its continuation lines by a tab,
        // while the list rule's trim() strips the first item's tab. Net
        // effect in the clipper: the second and later siblings of a nested
        // list gain an extra tab and render as children of the first. Here
        // the enclosing item supplies the indentation; only lists nested
        // directly in lists (no <li> between) add tabs themselves.
        let mut level = 0usize;
        let mut via_li = 0usize;
        let mut cur = self.doc.parent(id);
        while let Some(p) = cur {
            match self.doc.tag(p) {
                Some("ul") | Some("ol") => level += 1,
                Some("li") => via_li += 1,
                _ => break,
            }
            cur = self.doc.parent(p);
        }
        let tabs = level.saturating_sub(1).saturating_sub(via_li);
        let mut prefix = format!("{}- ", "\t".repeat(tabs));
        if let Some(parent) = self.doc.parent(id) {
            if self.doc.tag(parent) == Some("ol") {
                let start = self.doc.attr(parent, "start").map(str::to_string);
                let index = self
                    .doc
                    .element_children(parent)
                    .iter()
                    .position(|c| *c == id)
                    .map(|i| i + 1)
                    .unwrap_or(1);
                let number = match start.as_deref().map(|s| crate::value::string_to_number(s)) {
                    Some(n) if !s_empty(start.as_deref()) => crate::value::js_number(n + index as f64 - 1.0),
                    _ => index.to_string(),
                };
                prefix = format!("{}{number}. ", "\t".repeat(tabs));
            }
        }
        let has_next = self.doc.next_sibling(id).is_some();
        format!(
            "{prefix}{marker}{}{}",
            joined.trim_matches(is_js_ws),
            if has_next && !joined.ends_with('\n') { "\n" } else { "" }
        )
    }

    fn table(&mut self, id: NodeId, content: String) -> String {
        if self.doc.has_class(id, "ltx_equation") || self.doc.has_class(id, "ltx_eqn_table") || self.doc.has_class(id, "numblk") {
            return self.nested_equations(id);
        }
        let direct = |doc: &Document, el: NodeId| -> bool {
            let mut p = doc.parent(el);
            while let Some(x) = p {
                if x == id {
                    return true;
                }
                if doc.tag(x) == Some("table") {
                    return false;
                }
                p = doc.parent(x);
            }
            false
        };
        let has_nested = self.doc.find_all_tags(id, &["table"]).into_iter().any(|t| t != id);
        let direct_cells: Vec<NodeId> = self
            .doc
            .find_all_tags(id, &["td", "th"])
            .into_iter()
            .filter(|c| direct(&self.doc, *c))
            .collect();
        if has_nested || direct_cells.len() <= 1 {
            let rows: Vec<NodeId> = self.doc.find_all_tags(id, &["tr"]).into_iter().filter(|r| direct(&self.doc, *r)).collect();
            let counts: Vec<usize> = rows
                .iter()
                .map(|r| direct_cells.iter().filter(|c| self.doc.parent(**c) == Some(*r)).count())
                .collect();
            let single_column = !rows.is_empty() && counts.iter().all(|c| *c == counts[0]) && counts[0] <= 1;
            if single_column || has_nested {
                let html: String = direct_cells.iter().map(|c| self.doc.inner_html(*c)).collect();
                return format!("\n\n{}\n\n", self.sub(&html));
            }
        }
        let complex = self
            .doc
            .find_all_tags(id, &["td", "th"])
            .into_iter()
            .any(|c| self.doc.has_attr(c, "colspan") || self.doc.has_attr(c, "rowspan"));
        if complex {
            return format!("\n\n{}\n\n", cleanup_table_html(&self.doc, id));
        }
        // table.rows: rows of thead/tbody/tfoot children plus direct tr children.
        let mut row_els: Vec<NodeId> = Vec::new();
        for c in self.doc.element_children(id) {
            match self.doc.tag(c) {
                Some("tr") => row_els.push(c),
                Some("thead" | "tbody" | "tfoot") => {
                    row_els.extend(self.doc.element_children(c).into_iter().filter(|r| self.doc.tag(*r) == Some("tr")))
                }
                _ => {}
            }
        }
        // Browsers order thead rows first and tfoot rows last.
        let section = |doc: &Document, r: NodeId| match doc.parent(r).and_then(|p| doc.tag(p)) {
            Some("thead") => 0,
            Some("tfoot") => 2,
            _ => 1,
        };
        row_els.sort_by_key(|r| section(&self.doc, *r));
        let rows: Vec<Vec<String>> = row_els
            .iter()
            .map(|r| {
                self.doc
                    .element_children(*r)
                    .into_iter()
                    .filter(|c| matches!(self.doc.tag(*c), Some("td" | "th")))
                    .map(|cell| {
                        let md = self.sub(&self.doc.inner_html(cell));
                        md.replace('\n', " ").trim_matches(is_js_ws).replace('|', "\\|")
                    })
                    .collect()
            })
            .collect();
        if rows.is_empty() {
            return content;
        }
        let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        if cols == 0 {
            return content;
        }
        let fmt = |cells: &[String]| {
            let mut c = cells.to_vec();
            c.resize(cols.max(c.len()), String::new());
            format!("| {} |", c.join(" | "))
        };
        let mut lines = vec![fmt(&rows[0]), format!("| {} |", vec!["---"; cols].join(" | "))];
        lines.extend(rows[1..].iter().map(|r| fmt(r)));
        format!("\n\n{}\n\n", lines.join("\n"))
    }

    fn nested_equations(&self, id: NodeId) -> String {
        let maths = self.doc.find_all_tags(id, &["math"]);
        if maths.is_empty() {
            return String::new();
        }
        maths
            .into_iter()
            .map(|m| {
                let latex = self
                    .doc
                    .select_first(m, r#"annotation[encoding="application/x-tex"]"#)
                    .map(|a| self.doc.text_content(a).trim().to_string())
                    .filter(|l| !l.is_empty())
                    .or_else(|| self.doc.attr(m, "alttext").map(|a| a.trim().to_string()))
                    .unwrap_or_default();
                if latex.is_empty() {
                    return String::new();
                }
                let inline = self.doc.closest(m, ".ltx_eqn_inline, .mwe-math-element-inline").is_some();
                if inline {
                    format!("${latex}$")
                } else {
                    format!("\n$$\n{latex}\n$$")
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

fn s_empty(s: Option<&str>) -> bool {
    s.is_none_or(|x| x.is_empty())
}

fn content_default(doc: &Document, id: NodeId, content: String) -> String {
    if is_block(doc, id) {
        format!("\n\n{content}\n\n")
    } else {
        content
    }
}

fn capitalize_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

fn link_destination(href: &str) -> String {
    if !href.chars().any(char::is_whitespace) {
        href.replace('(', "\\(").replace(')', "\\)")
    } else {
        format!("<{}>", href.replace('>', "\\>"))
    }
}

fn link_title(title: Option<&str>) -> String {
    match title {
        Some(t) if !t.is_empty() => {
            // title.replace(/(\n+\s*)+/g, '\n').replace(/"/g, '\\"')
            let re = regex_lite::Regex::new(r"(\n+\s*)+").unwrap();
            let t = re.replace_all(t, "\n").replace('"', "\\\"");
            format!(" \"{t}\"")
        }
        _ => String::new(),
    }
}

fn inline_code(content: &str) -> String {
    if content.is_empty() {
        return String::new();
    }
    let c: String = {
        let re = regex_lite::Regex::new(r"\r?\n|\r").unwrap();
        re.replace_all(content, " ").into_owned()
    };
    // /^`|^ .*?[^ ].* $|`$/
    let extra = c.starts_with('`')
        || c.ends_with('`')
        || (c.len() >= 3 && c.starts_with(' ') && c.ends_with(' ') && c.trim_matches(' ').chars().any(|ch| ch != ' '));
    let extra = if extra { " " } else { "" };
    let mut delim = "`".to_string();
    let runs: Vec<usize> = {
        let mut v = Vec::new();
        let mut cur = 0;
        for ch in c.chars() {
            if ch == '`' {
                cur += 1;
            } else if cur > 0 {
                v.push(cur);
                cur = 0;
            }
        }
        if cur > 0 {
            v.push(cur);
        }
        v
    };
    while runs.contains(&delim.len()) {
        delim.push('`');
    }
    format!("{delim}{extra}{c}{extra}{delim}")
}

/// `getBestImageSrc`: the widest `w` candidate in `srcset`, else `src`.
pub fn best_image_src(doc: &Document, id: NodeId) -> String {
    if let Some(srcset) = doc.attr(id, "srcset") {
        let mut best_url = String::new();
        let mut best_w: u64 = 0;
        let mut parts: Vec<&str> = Vec::new();
        for token in srcset.split_whitespace() {
            let t = token.strip_suffix(',').unwrap_or(token);
            let is_w = t.len() > 1 && t.ends_with('w') && t[..t.len() - 1].chars().all(|c| c.is_ascii_digit());
            let is_x = t.len() > 1 && t.ends_with('x') && {
                let n = &t[..t.len() - 1];
                !n.is_empty() && n.chars().all(|c| c.is_ascii_digit() || c == '.') && n.chars().next().is_some_and(|c| c.is_ascii_digit())
            };
            if is_w {
                let w: u64 = t[..t.len() - 1].parse().unwrap_or(0);
                if !parts.is_empty() && w > best_w {
                    let url = parts.join(" ");
                    let url = url.trim_start_matches(',').trim_start();
                    if !url.is_empty() {
                        best_w = w;
                        best_url = url.to_string();
                    }
                }
                parts.clear();
            } else if is_x {
                parts.clear();
            } else {
                parts.push(token);
            }
        }
        if !best_url.is_empty() {
            return best_url;
        }
    }
    doc.attr(id, "src").unwrap_or("").to_string()
}

fn is_embed_host(src: &str) -> bool {
    let rest = match src.find("//") {
        Some(i) => &src[i + 2..],
        None => src,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    ["youtube.com", "youtube-nocookie.com", "youtu.be", "twitter.com", "x.com"]
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

fn embed_to_markdown(src: &str) -> Option<String> {
    let yt = regex_lite::Regex::new(r"(?:https?://)?(?:www\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)/(?:embed/|watch\?v=)?([a-zA-Z0-9_-]+)").unwrap();
    if let Some(c) = yt.captures(src) {
        return Some(format!("\n![](https://www.youtube.com/watch?v={})\n", &c[1]));
    }
    let tw = regex_lite::Regex::new(r"(?:https?://)?(?:www\.)?(?:twitter\.com|x\.com)/([^/]+)/status/([0-9]+)").unwrap();
    if let Some(c) = tw.captures(src) {
        return Some(format!("\n![](https://x.com/{}/status/{})\n", &c[1], &c[2]));
    }
    let te = regex_lite::Regex::new(r"(?:https?://)?(?:platform\.)?twitter\.com/embed/Tweet\.html\?.*?id=([0-9]+)").unwrap();
    if let Some(c) = te.captures(src) {
        return Some(format!("\n![](https://x.com/i/status/{})\n", &c[1]));
    }
    None
}

fn replace_math_in_caption(html: &str) -> String {
    // captionContent.replace(/<math.*?>(.*?)<\/math>/g, …) — `.` excludes newlines.
    let re = regex_lite::Regex::new(r"<math.*?>(.*?)</math>").unwrap();
    let mut out = String::new();
    let mut last = 0;
    for m in re.find_iter(html) {
        out.push_str(&html[last..m.start()]);
        let frag = Document::parse(m.as_str());
        let latex = frag.find_tag(0, "math").map(|mm| extract_latex(&frag, mm)).unwrap_or_default();
        let prev = html[..m.start()].chars().last();
        let next = html[m.end()..].chars().next();
        let start_line = m.start() == 0 || prev.is_some_and(|c| c.is_whitespace());
        let end_line = m.end() == html.len() || next.is_some_and(|c| c.is_whitespace());
        let left = if !start_line && prev.is_some_and(|c| !c.is_whitespace() && c != '$') { " " } else { "" };
        let right = if !end_line && next.is_some_and(|c| !c.is_whitespace() && c != '$') { " " } else { "" };
        out.push_str(&format!("{left}${latex}${right}"));
        last = m.end();
    }
    out.push_str(&html[last..]);
    out
}

const MATHML_NAMES: &[&str] = &[
    "annotation", "maction", "math", "menclose", "merror", "mfenced", "mfrac", "mi",
    "mmultiscripts", "mn", "mo", "mover", "mpadded", "mphantom", "mprescripts", "mroot", "mrow",
    "ms", "mspace", "msqrt", "mstyle", "msub", "msubsup", "msup", "mtable", "mtd", "mtext", "mtr",
    "munder", "munderover", "none", "semantics",
];
const COMPLEX_MATHML: &[&str] = &[
    "menclose", "mfrac", "mmultiscripts", "mover", "mroot", "msqrt", "msub", "msubsup", "msup",
    "mtable", "mtd", "mtr", "munder", "munderover",
];

/// `extractLatex` (without the MathML → LaTeX library fallback).
pub fn extract_latex(doc: &Document, id: NodeId) -> String {
    if let Some(a) = doc.select_first(id, r#"annotation[encoding="application/x-tex"]"#) {
        let t = doc.text_content(a);
        if !t.trim().is_empty() {
            return t.trim().to_string();
        }
    }
    let latex = doc.attr(id, "data-latex").map(str::to_string);
    let alttext = doc.attr(id, "alttext").map(str::to_string);
    let has_mathml = doc
        .element_children(id)
        .iter()
        .any(|c| doc.tag(*c).is_some_and(|t| MATHML_NAMES.contains(&t.to_lowercase().as_str())));
    let has_complex = doc
        .descendant_elements(id)
        .iter()
        .chain(std::iter::once(&id))
        .any(|c| doc.tag(*c).is_some_and(|t| COMPLEX_MATHML.contains(&t.to_lowercase().as_str())));
    let likely_latex = |v: &str| {
        let re = regex_lite::Regex::new(r"\\[a-zA-Z]+|[_^{}]|[$&]|\\\\|\\begin\{").unwrap();
        re.is_match(v)
    };
    let trustworthy = |v: &str| {
        if likely_latex(v) {
            return true;
        }
        let t = v.trim();
        if t.is_empty() || has_complex {
            return false;
        }
        !regex_lite::Regex::new(r"[a-zA-Z]{3,}-[a-zA-Z]{2,}").unwrap().is_match(t)
    };
    if let Some(l) = latex.as_ref().filter(|l| !l.is_empty()) {
        if !has_mathml || trustworthy(l) {
            return l.trim().to_string();
        }
    }
    if let Some(a) = alttext.as_ref().filter(|a| !a.is_empty()) {
        if !has_mathml || trustworthy(a) {
            return a.trim().to_string();
        }
    }
    if let Some(l) = latex.filter(|l| !l.is_empty()) {
        return l.trim().to_string();
    }
    if let Some(a) = alttext.filter(|a| !a.is_empty()) {
        return a.trim().to_string();
    }
    String::new()
}

fn format_block_latex(value: &str) -> String {
    let latex = value.trim();
    if latex.is_empty() {
        return String::new();
    }
    let has_env = |v: &str| regex_lite::Regex::new(r"\\begin\{[^}]+\}").unwrap().is_match(v);
    if let Some(inner) = latex.strip_prefix("\\begin{matrix}").and_then(|r| r.strip_suffix("\\end{matrix}")) {
        if !has_env(inner) {
            return format!("\\begin{{aligned}}\n{}\n\\end{{aligned}}", inner.trim());
        }
    }
    if has_env(latex) {
        return latex.to_string();
    }
    if latex.contains("\\\\") || latex.contains('&') {
        return format!("\\begin{{aligned}}\n{latex}\n\\end{{aligned}}");
    }
    latex.to_string()
}

fn cleanup_table_html(doc: &Document, id: NodeId) -> String {
    const ALLOWED: &[&str] = &[
        "src", "href", "style", "align", "width", "height", "rowspan", "colspan", "bgcolor", "scope",
        "valign", "headers",
    ];
    let mut copy = Document::new();
    let new = copy.import(doc, id);
    copy.append(0, new);
    for el in std::iter::once(new).chain(copy.descendant_elements(new)) {
        let kept: Vec<(String, String)> = copy.attrs(el).iter().filter(|(k, _)| ALLOWED.contains(&k.as_str())).cloned().collect();
        copy.set_attrs(el, kept);
    }
    copy.outer_html(new).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
}

#[cfg(test)]
mod tests;
