//! A small, forgiving XML/HTML tree the importers can rewrite and serialise.
//!
//! The importers are DOM surgery: Evernote's `<en-todo>` has to move out of a
//! `<span>`, Notion puts each list item in a list of its own, a callout figure
//! becomes a blockquote. `crate::dom` is built for reading articles and drops
//! what a reader does not need; this one keeps every element and attribute,
//! allows moving and replacing nodes, and writes HTML back out for
//! `html_to_markdown`.
//!
//! Parsing is lenient in the ways real exports need: CDATA sections, `<?xml?>`
//! and `<!DOCTYPE>` (with an internal subset), comments, self-closing tags in
//! HTML, void elements, raw-text `<script>`/`<style>`, unquoted and valueless
//! attributes, stray end tags, and the implied end tags of `<p>`, `<li>`,
//! `<td>`/`<th>`, `<tr>`, `<dt>`/`<dd>` and `<option>`. Entities are decoded
//! once, at parse time.
//!
//! ENEX files are large, so [`Tokenizer`] is also usable on its own as a pull
//! parser: the Evernote importer builds one `<note>` subtree at a time rather
//! than the whole export.

use std::borrow::Cow;

pub type Id = usize;

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    Element {
        name: String,
        attrs: Vec<(String, String)>,
    },
    Text(String),
    /// The container returned by the parser; never serialised itself.
    Root,
}

#[derive(Debug, Clone)]
pub struct Node {
    pub kind: Kind,
    pub parent: Option<Id>,
    pub children: Vec<Id>,
}

#[derive(Debug, Clone)]
pub struct Doc {
    pub nodes: Vec<Node>,
    pub root: Id,
}

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];
const RAW_TEXT: &[&str] = &["script", "style"];

// ---------------------------------------------------------------------------
// Tokenizer

#[derive(Debug, Clone, PartialEq)]
pub enum Token<'a> {
    Start {
        name: String,
        attrs: Vec<(String, String)>,
        self_closing: bool,
    },
    End(String),
    Text(Cow<'a, str>),
    /// CDATA content, verbatim.
    CData(&'a str),
}

pub struct Tokenizer<'a> {
    src: &'a str,
    pos: usize,
    html: bool,
    /// Set after a raw-text start tag: the next token is everything up to its
    /// end tag.
    raw_until: Option<String>,
}

impl<'a> Tokenizer<'a> {
    pub fn new(src: &'a str, html: bool) -> Tokenizer<'a> {
        Tokenizer {
            src,
            pos: 0,
            html,
            raw_until: None,
        }
    }

    pub fn position(&self) -> usize {
        self.pos
    }

    fn rest(&self) -> &'a str {
        &self.src[self.pos..]
    }
}

impl<'a> Iterator for Tokenizer<'a> {
    type Item = Token<'a>;

    fn next(&mut self) -> Option<Token<'a>> {
        loop {
            if self.pos >= self.src.len() {
                return None;
            }
            if let Some(name) = self.raw_until.take() {
                let rest = self.rest();
                let lower = rest.to_ascii_lowercase();
                let close = format!("</{name}");
                let end = lower.find(&close).unwrap_or(rest.len());
                self.pos += end;
                if end > 0 {
                    return Some(Token::Text(Cow::Borrowed(&rest[..end])));
                }
                continue;
            }
            let rest = self.rest();
            if !rest.starts_with('<') {
                let end = rest.find('<').unwrap_or(rest.len());
                self.pos += end;
                return Some(Token::Text(decode_entities(&rest[..end])));
            }
            if let Some(body) = rest.strip_prefix("<![CDATA[") {
                let end = body.find("]]>").unwrap_or(body.len());
                self.pos += 9 + end + if end < body.len() { 3 } else { 0 };
                return Some(Token::CData(&body[..end]));
            }
            if rest.starts_with("<!--") {
                let end = rest[4..].find("-->").map(|i| i + 7).unwrap_or(rest.len());
                self.pos += end;
                continue;
            }
            if rest.starts_with("<?") {
                let end = rest.find("?>").map(|i| i + 2).unwrap_or(rest.len());
                self.pos += end;
                continue;
            }
            if rest.starts_with("<!") {
                // DOCTYPE, possibly with an internal subset in brackets.
                let mut depth = 0;
                let mut end = rest.len();
                for (i, c) in rest.char_indices().skip(2) {
                    match c {
                        '[' => depth += 1,
                        ']' => depth -= 1,
                        '>' if depth <= 0 => {
                            end = i + 1;
                            break;
                        }
                        _ => {}
                    }
                }
                self.pos += end;
                continue;
            }
            if let Some(after) = rest.strip_prefix("</") {
                let name_len = after
                    .find(|c: char| c.is_whitespace() || c == '>')
                    .unwrap_or(after.len());
                let name = normalise_name(&after[..name_len], self.html);
                let end = after.find('>').map(|i| i + 3).unwrap_or(rest.len());
                self.pos += end;
                if name.is_empty() {
                    continue;
                }
                return Some(Token::End(name));
            }
            // A start tag needs a name character right after `<`.
            let second = rest[1..].chars().next();
            if !second.is_some_and(|c| c.is_alphabetic() || c == '_' || c == ':') {
                self.pos += 1;
                return Some(Token::Text(Cow::Borrowed("<")));
            }
            let (token, len) = parse_start_tag(rest, self.html);
            self.pos += len;
            if let Token::Start {
                ref name,
                self_closing,
                ..
            } = token
            {
                if self.html && !self_closing && RAW_TEXT.contains(&name.as_str()) {
                    self.raw_until = Some(name.clone());
                }
            }
            return Some(token);
        }
    }
}

fn normalise_name(name: &str, html: bool) -> String {
    if html {
        name.to_ascii_lowercase()
    } else {
        name.to_string()
    }
}

fn parse_start_tag(s: &str, html: bool) -> (Token<'static>, usize) {
    let b = s.as_bytes();
    let mut i = 1;
    while i < b.len() && !(b[i].is_ascii_whitespace() || b[i] == b'>' || b[i] == b'/') {
        i += 1;
    }
    let name = normalise_name(&s[1..i], html);
    let mut attrs: Vec<(String, String)> = Vec::new();
    let mut self_closing = false;
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        if b[i] == b'>' {
            i += 1;
            break;
        }
        if b[i] == b'/' {
            i += 1;
            if i < b.len() && b[i] == b'>' {
                self_closing = true;
                i += 1;
                break;
            }
            continue;
        }
        let start = i;
        while i < b.len() && !(b[i].is_ascii_whitespace() || b[i] == b'=' || b[i] == b'>' || (b[i] == b'/' && b.get(i + 1) == Some(&b'>'))) {
            i += 1;
        }
        let key = normalise_name(&s[start..i], html);
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                let vstart = i + 1;
                let vend = s[vstart..]
                    .bytes()
                    .position(|c| c == q)
                    .map(|p| vstart + p)
                    .unwrap_or(b.len());
                value = decode_entities(&s[vstart..vend]).into_owned();
                i = (vend + 1).min(b.len());
            } else {
                let vstart = i;
                while i < b.len() && !(b[i].is_ascii_whitespace() || b[i] == b'>') {
                    i += 1;
                }
                value = decode_entities(&s[vstart..i]).into_owned();
            }
        }
        if key.is_empty() {
            i += 1;
            continue;
        }
        if !attrs.iter().any(|(k, _)| *k == key) {
            attrs.push((key, value));
        }
    }
    (
        Token::Start {
            name,
            attrs,
            self_closing,
        },
        i,
    )
}

/// Decode character references. The common named entities are known; an
/// unknown name is left as written.
pub fn decode_entities(s: &str) -> Cow<'_, str> {
    if !s.contains('&') {
        return Cow::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let end = after
            .char_indices()
            .take(32)
            .find(|(_, c)| *c == ';' || !(c.is_ascii_alphanumeric() || *c == '#'))
            .map(|(i, c)| (i, c == ';'));
        let decoded = end.and_then(|(i, semi)| {
            let name = &after[..i];
            let ch = if let Some(num) = name.strip_prefix('#') {
                let v = if let Some(hex) = num.strip_prefix(['x', 'X']) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    num.parse::<u32>().ok()
                };
                v.map(|v| char::from_u32(v).unwrap_or('\u{FFFD}').to_string())
            } else {
                named_entity(name).map(|c| c.to_string())
            };
            ch.map(|c| (c, i + usize::from(semi)))
        });
        match decoded {
            Some((c, used)) => {
                out.push_str(&c);
                rest = &after[used..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => "\u{a0}",
        "ensp" => "\u{2002}",
        "emsp" => "\u{2003}",
        "thinsp" => "\u{2009}",
        "zwnj" => "\u{200c}",
        "zwj" => "\u{200d}",
        "shy" => "\u{ad}",
        "ndash" => "–",
        "mdash" => "—",
        "lsquo" => "‘",
        "rsquo" => "’",
        "sbquo" => "‚",
        "ldquo" => "“",
        "rdquo" => "”",
        "bdquo" => "„",
        "hellip" => "…",
        "bull" => "•",
        "middot" => "·",
        "copy" => "©",
        "reg" => "®",
        "trade" => "™",
        "deg" => "°",
        "plusmn" => "±",
        "times" => "×",
        "divide" => "÷",
        "euro" => "€",
        "pound" => "£",
        "yen" => "¥",
        "cent" => "¢",
        "sect" => "§",
        "para" => "¶",
        "laquo" => "«",
        "raquo" => "»",
        "larr" => "←",
        "rarr" => "→",
        "uarr" => "↑",
        "darr" => "↓",
        "harr" => "↔",
        "hearts" => "♥",
        "check" => "✓",
        "iexcl" => "¡",
        "iquest" => "¿",
        "frac12" => "½",
        "frac14" => "¼",
        "frac34" => "¾",
        "sup2" => "²",
        "sup3" => "³",
        "micro" => "µ",
        "agrave" => "à",
        "aacute" => "á",
        "acirc" => "â",
        "atilde" => "ã",
        "auml" => "ä",
        "aring" => "å",
        "aelig" => "æ",
        "ccedil" => "ç",
        "egrave" => "è",
        "eacute" => "é",
        "ecirc" => "ê",
        "euml" => "ë",
        "igrave" => "ì",
        "iacute" => "í",
        "icirc" => "î",
        "iuml" => "ï",
        "ntilde" => "ñ",
        "ograve" => "ò",
        "oacute" => "ó",
        "ocirc" => "ô",
        "otilde" => "õ",
        "ouml" => "ö",
        "oslash" => "ø",
        "ugrave" => "ù",
        "uacute" => "ú",
        "ucirc" => "û",
        "uuml" => "ü",
        "yacute" => "ý",
        "yuml" => "ÿ",
        "szlig" => "ß",
        "Agrave" => "À",
        "Aacute" => "Á",
        "Acirc" => "Â",
        "Atilde" => "Ã",
        "Auml" => "Ä",
        "Aring" => "Å",
        "AElig" => "Æ",
        "Ccedil" => "Ç",
        "Egrave" => "È",
        "Eacute" => "É",
        "Ecirc" => "Ê",
        "Euml" => "Ë",
        "Igrave" => "Ì",
        "Iacute" => "Í",
        "Icirc" => "Î",
        "Iuml" => "Ï",
        "Ntilde" => "Ñ",
        "Ograve" => "Ò",
        "Oacute" => "Ó",
        "Ocirc" => "Ô",
        "Otilde" => "Õ",
        "Ouml" => "Ö",
        "Oslash" => "Ø",
        "Ugrave" => "Ù",
        "Uacute" => "Ú",
        "Ucirc" => "Û",
        "Uuml" => "Ü",
        "Yacute" => "Ý",
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Tree

/// Elements whose start closes an open `<p>` (HTML's "closes a p element").
const CLOSES_P: &[&str] = &[
    "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption",
    "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav",
    "ol", "p", "pre", "section", "table", "ul",
];

impl Doc {
    pub fn new() -> Doc {
        Doc {
            nodes: vec![Node {
                kind: Kind::Root,
                parent: None,
                children: Vec::new(),
            }],
            root: 0,
        }
    }

    pub fn parse_html(src: &str) -> Doc {
        let mut doc = Doc::new();
        let root = doc.root;
        doc.build(Tokenizer::new(src, true), root, None, true);
        doc
    }

    pub fn parse_xml(src: &str) -> Doc {
        let mut doc = Doc::new();
        let root = doc.root;
        doc.build(Tokenizer::new(src, false), root, None, false);
        doc
    }

    /// Build children under `parent` from `tokens`. With `stop_at`, return
    /// once that element (the one `parent` stands for) is closed.
    pub fn build<'a, I: Iterator<Item = Token<'a>>>(
        &mut self,
        tokens: I,
        parent: Id,
        stop_at: Option<&str>,
        html: bool,
    ) {
        let mut stack: Vec<Id> = vec![parent];
        for tok in tokens {
            let top = *stack.last().unwrap();
            match tok {
                Token::Text(t) => {
                    self.append_text(top, &t);
                }
                Token::CData(t) => {
                    self.append_text(top, t);
                }
                Token::Start {
                    name,
                    attrs,
                    self_closing,
                } => {
                    if html {
                        self.implied_end(&mut stack, &name);
                    }
                    let top = *stack.last().unwrap();
                    let id = self.create_element(&name, attrs);
                    self.append(top, id);
                    let void = html && VOID.contains(&name.as_str());
                    if !(self_closing || void) {
                        stack.push(id);
                    }
                }
                Token::End(name) => {
                    // Pop to the nearest open element of that name; ignore a
                    // stray end tag with nothing to close.
                    if let Some(pos) = stack
                        .iter()
                        .rposition(|id| self.name(*id) == Some(name.as_str()))
                    {
                        if pos == 0 {
                            // The container itself is closing.
                            return;
                        }
                        stack.truncate(pos);
                    } else if stack.len() == 1 && stop_at == Some(name.as_str()) {
                        return;
                    }
                }
            }
        }
    }

    fn implied_end(&mut self, stack: &mut Vec<Id>, name: &str) {
        let close_within = |doc: &Doc, stack: &mut Vec<Id>, targets: &[&str], barriers: &[&str]| {
            for i in (1..stack.len()).rev() {
                let n = doc.name(stack[i]).unwrap_or("");
                if targets.contains(&n) {
                    stack.truncate(i);
                    return;
                }
                if barriers.contains(&n) {
                    return;
                }
            }
        };
        if CLOSES_P.contains(&name) {
            close_within(self, stack, &["p"], &["button", "td", "th", "li", "div", "blockquote", "table"]);
        }
        match name {
            "li" => close_within(self, stack, &["li"], &["ul", "ol"]),
            "dt" | "dd" => close_within(self, stack, &["dt", "dd"], &["dl"]),
            "td" | "th" => close_within(self, stack, &["td", "th"], &["tr", "table"]),
            "tr" => close_within(self, stack, &["tr"], &["table", "tbody", "thead", "tfoot"]),
            "tbody" | "thead" | "tfoot" => {
                close_within(self, stack, &["tbody", "thead", "tfoot"], &["table"])
            }
            "option" => close_within(self, stack, &["option"], &["select"]),
            _ => {}
        }
    }

    fn append_text(&mut self, parent: Id, text: &str) {
        if text.is_empty() {
            return;
        }
        if let Some(&last) = self.nodes[parent].children.last() {
            if let Kind::Text(t) = &mut self.nodes[last].kind {
                t.push_str(text);
                return;
            }
        }
        let id = self.create_text(text);
        self.append(parent, id);
    }

    pub fn create_element(&mut self, name: &str, attrs: Vec<(String, String)>) -> Id {
        self.nodes.push(Node {
            kind: Kind::Element {
                name: name.to_string(),
                attrs,
            },
            parent: None,
            children: Vec::new(),
        });
        self.nodes.len() - 1
    }

    pub fn create_text(&mut self, text: &str) -> Id {
        self.nodes.push(Node {
            kind: Kind::Text(text.to_string()),
            parent: None,
            children: Vec::new(),
        });
        self.nodes.len() - 1
    }

    pub fn name(&self, id: Id) -> Option<&str> {
        match &self.nodes[id].kind {
            Kind::Element { name, .. } => Some(name),
            _ => None,
        }
    }

    pub fn is(&self, id: Id, name: &str) -> bool {
        self.name(id) == Some(name)
    }

    pub fn text(&self, id: Id) -> Option<&str> {
        match &self.nodes[id].kind {
            Kind::Text(t) => Some(t),
            _ => None,
        }
    }

    pub fn attr(&self, id: Id, key: &str) -> Option<&str> {
        match &self.nodes[id].kind {
            Kind::Element { attrs, .. } => attrs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str()),
            _ => None,
        }
    }

    pub fn set_attr(&mut self, id: Id, key: &str, value: &str) {
        if let Kind::Element { attrs, .. } = &mut self.nodes[id].kind {
            if let Some(slot) = attrs.iter_mut().find(|(k, _)| k == key) {
                slot.1 = value.to_string();
            } else {
                attrs.push((key.to_string(), value.to_string()));
            }
        }
    }

    pub fn remove_attr(&mut self, id: Id, key: &str) {
        if let Kind::Element { attrs, .. } = &mut self.nodes[id].kind {
            attrs.retain(|(k, _)| k != key);
        }
    }

    pub fn rename(&mut self, id: Id, new_name: &str) {
        if let Kind::Element { name, .. } = &mut self.nodes[id].kind {
            *name = new_name.to_string();
        }
    }

    pub fn has_class(&self, id: Id, class: &str) -> bool {
        self.attr(id, "class")
            .is_some_and(|c| c.split_whitespace().any(|x| x == class))
    }

    pub fn children(&self, id: Id) -> &[Id] {
        &self.nodes[id].children
    }

    pub fn element_children(&self, id: Id) -> Vec<Id> {
        self.nodes[id]
            .children
            .iter()
            .copied()
            .filter(|c| self.name(*c).is_some())
            .collect()
    }

    pub fn parent(&self, id: Id) -> Option<Id> {
        self.nodes[id].parent
    }

    /// Nearest ancestor element (excluding `id`) named `name`.
    pub fn closest(&self, id: Id, name: &str) -> Option<Id> {
        let mut cur = self.parent(id);
        while let Some(p) = cur {
            if self.is(p, name) {
                return Some(p);
            }
            cur = self.parent(p);
        }
        None
    }

    /// `id` and all nodes under it, in document order.
    pub fn descendants(&self, id: Id) -> Vec<Id> {
        let mut out = Vec::new();
        let mut stack = vec![id];
        while let Some(n) = stack.pop() {
            out.push(n);
            for c in self.nodes[n].children.iter().rev() {
                stack.push(*c);
            }
        }
        out
    }

    /// Elements under `id` (inclusive) with the given name, document order.
    pub fn find_all(&self, id: Id, name: &str) -> Vec<Id> {
        self.descendants(id)
            .into_iter()
            .filter(|n| self.is(*n, name))
            .collect()
    }

    pub fn find(&self, id: Id, name: &str) -> Option<Id> {
        self.descendants(id).into_iter().find(|n| self.is(*n, name))
    }

    /// First element child named `name`.
    pub fn child(&self, id: Id, name: &str) -> Option<Id> {
        self.nodes[id].children.iter().copied().find(|c| self.is(*c, name))
    }

    /// Text of the first child element named `name`.
    pub fn child_text(&self, id: Id, name: &str) -> Option<String> {
        self.child(id, name).map(|c| self.text_content(c))
    }

    pub fn text_content(&self, id: Id) -> String {
        let mut out = String::new();
        for n in self.descendants(id) {
            if let Kind::Text(t) = &self.nodes[n].kind {
                out.push_str(t);
            }
        }
        out
    }

    fn position_in_parent(&self, id: Id) -> Option<(Id, usize)> {
        let p = self.nodes[id].parent?;
        let i = self.nodes[p].children.iter().position(|c| *c == id)?;
        Some((p, i))
    }

    pub fn append(&mut self, parent: Id, child: Id) {
        self.detach(child);
        self.nodes[child].parent = Some(parent);
        self.nodes[parent].children.push(child);
    }

    pub fn prepend(&mut self, parent: Id, child: Id) {
        self.detach(child);
        self.nodes[child].parent = Some(parent);
        self.nodes[parent].children.insert(0, child);
    }

    pub fn insert_before(&mut self, reference: Id, node: Id) {
        self.detach(node);
        if let Some((p, i)) = self.position_in_parent(reference) {
            self.nodes[node].parent = Some(p);
            self.nodes[p].children.insert(i, node);
        }
    }

    pub fn insert_after(&mut self, reference: Id, node: Id) {
        self.detach(node);
        if let Some((p, i)) = self.position_in_parent(reference) {
            self.nodes[node].parent = Some(p);
            self.nodes[p].children.insert(i + 1, node);
        }
    }

    /// Remove from its parent (the node stays in the arena, reusable).
    pub fn detach(&mut self, id: Id) {
        if let Some((p, i)) = self.position_in_parent(id) {
            self.nodes[p].children.remove(i);
        }
        self.nodes[id].parent = None;
    }

    /// Replace `id` with `with`, in order.
    pub fn replace_with(&mut self, id: Id, with: &[Id]) {
        let Some((p, i)) = self.position_in_parent(id) else {
            return;
        };
        for w in with {
            self.detach(*w);
        }
        // Detaching may have shifted `id`'s index if a replacement was an
        // earlier sibling; look it up again.
        let i = self.nodes[p].children.iter().position(|c| *c == id).unwrap_or(i);
        self.nodes[p].children.remove(i);
        self.nodes[id].parent = None;
        for (k, w) in with.iter().enumerate() {
            self.nodes[*w].parent = Some(p);
            self.nodes[p].children.insert(i + k, *w);
        }
    }

    pub fn replace_with_text(&mut self, id: Id, text: &str) {
        let t = self.create_text(text);
        self.replace_with(id, &[t]);
    }

    /// Replace an element with its children.
    pub fn unwrap(&mut self, id: Id) {
        let kids = self.nodes[id].children.clone();
        self.replace_with(id, &kids);
    }

    /// Wrap all children of `id` in a new element.
    pub fn wrap_children(&mut self, id: Id, name: &str) -> Id {
        let wrapper = self.create_element(name, Vec::new());
        let kids = std::mem::take(&mut self.nodes[id].children);
        for k in &kids {
            self.nodes[*k].parent = Some(wrapper);
        }
        self.nodes[wrapper].children = kids;
        self.nodes[wrapper].parent = Some(id);
        self.nodes[id].children.push(wrapper);
        wrapper
    }

    pub fn previous_element_sibling(&self, id: Id) -> Option<Id> {
        let (p, i) = self.position_in_parent(id)?;
        self.nodes[p].children[..i]
            .iter()
            .rev()
            .copied()
            .find(|c| self.name(*c).is_some())
    }

    pub fn next_element_sibling(&self, id: Id) -> Option<Id> {
        let (p, i) = self.position_in_parent(id)?;
        self.nodes[p].children[i + 1..]
            .iter()
            .copied()
            .find(|c| self.name(*c).is_some())
    }

    pub fn next_sibling(&self, id: Id) -> Option<Id> {
        let (p, i) = self.position_in_parent(id)?;
        self.nodes[p].children.get(i + 1).copied()
    }

    pub fn previous_sibling(&self, id: Id) -> Option<Id> {
        let (p, i) = self.position_in_parent(id)?;
        if i == 0 {
            None
        } else {
            self.nodes[p].children.get(i - 1).copied()
        }
    }

    pub fn outer_html(&self, id: Id) -> String {
        let mut out = String::new();
        self.write(id, &mut out);
        out
    }

    pub fn inner_html(&self, id: Id) -> String {
        let mut out = String::new();
        for c in &self.nodes[id].children {
            self.write(*c, &mut out);
        }
        out
    }

    fn write(&self, id: Id, out: &mut String) {
        match &self.nodes[id].kind {
            Kind::Root => {
                for c in &self.nodes[id].children {
                    self.write(*c, out);
                }
            }
            Kind::Text(t) => {
                let raw = self
                    .parent(id)
                    .and_then(|p| self.name(p))
                    .is_some_and(|n| RAW_TEXT.contains(&n));
                if raw {
                    out.push_str(t);
                } else {
                    escape_text_into(t, out);
                }
            }
            Kind::Element { name, attrs } => {
                out.push('<');
                out.push_str(name);
                for (k, v) in attrs {
                    out.push(' ');
                    out.push_str(k);
                    out.push_str("=\"");
                    for c in v.chars() {
                        match c {
                            '&' => out.push_str("&amp;"),
                            '"' => out.push_str("&quot;"),
                            '<' => out.push_str("&lt;"),
                            c => out.push(c),
                        }
                    }
                    out.push('"');
                }
                out.push('>');
                if VOID.contains(&name.as_str()) {
                    return;
                }
                for c in &self.nodes[id].children {
                    self.write(*c, out);
                }
                out.push_str("</");
                out.push_str(name);
                out.push('>');
            }
        }
    }
}

impl Default for Doc {
    fn default() -> Self {
        Doc::new()
    }
}

pub fn escape_text_into(t: &str, out: &mut String) {
    for c in t.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
}

pub fn escape_text(t: &str) -> String {
    let mut s = String::with_capacity(t.len());
    escape_text_into(t, &mut s);
    s
}

/// A CSS declaration's value from a `style` attribute, property matched
/// case-insensitively.
pub fn style_value(style: &str, property: &str) -> Option<String> {
    for decl in style.split(';') {
        if let Some((k, v)) = decl.split_once(':') {
            if k.trim().eq_ignore_ascii_case(property) {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_serialises_round_trip() {
        let src = r#"<div class="a" data-x='1'>Hi &amp; <b>there</b><br/><img src="x.png"></div>"#;
        let doc = Doc::parse_html(src);
        assert_eq!(
            doc.inner_html(doc.root),
            r#"<div class="a" data-x="1">Hi &amp; <b>there</b><br><img src="x.png"></div>"#
        );
    }

    #[test]
    fn handles_cdata_doctype_comments_and_self_closing_xml() {
        let src = "<?xml version=\"1.0\"?><!DOCTYPE en-export SYSTEM \"x.dtd\" [<!ENTITY a \"b\">]><en-export><!-- c --><note><content><![CDATA[<en-note><en-todo checked=\"true\"/>x</en-note>]]></content></note></en-export>";
        let doc = Doc::parse_xml(src);
        let content = doc.find(doc.root, "content").unwrap();
        assert_eq!(
            doc.text_content(content),
            "<en-note><en-todo checked=\"true\"/>x</en-note>"
        );
        let enml = Doc::parse_html(&doc.text_content(content));
        let todo = enml.find(enml.root, "en-todo").unwrap();
        assert!(enml.children(todo).is_empty(), "self-closing custom tag has no children");
        assert_eq!(enml.attr(todo, "checked"), Some("true"));
    }

    #[test]
    fn implied_end_tags() {
        let doc = Doc::parse_html("<ul><li>one<li>two</ul><p>a<p>b<table><tr><td>1<td>2</table>");
        assert_eq!(
            doc.inner_html(doc.root),
            "<ul><li>one</li><li>two</li></ul><p>a</p><p>b</p><table><tr><td>1</td><td>2</td></tr></table>"
        );
    }

    #[test]
    fn raw_text_and_stray_tags() {
        let doc = Doc::parse_html("<script>if (a < b) {}</script></span>ok 1 < 2");
        assert_eq!(doc.inner_html(doc.root), "<script>if (a < b) {}</script>ok 1 &lt; 2");
    }

    #[test]
    fn entities_decode_once() {
        assert_eq!(decode_entities("&amp;amp; &#x2713; &#10003; &nbsp;&bogus; & x"), "&amp; ✓ ✓ \u{a0}&bogus; & x");
    }

    #[test]
    fn tree_surgery() {
        let mut doc = Doc::parse_html("<p><span><i>x</i></span><b>y</b></p>");
        let span = doc.find(doc.root, "span").unwrap();
        doc.unwrap(span);
        let b = doc.find(doc.root, "b").unwrap();
        let t = doc.create_text("z");
        doc.insert_before(b, t);
        let p = doc.find(doc.root, "p").unwrap();
        doc.wrap_children(p, "mark");
        assert_eq!(doc.inner_html(doc.root), "<p><mark><i>x</i>z<b>y</b></mark></p>");
        assert_eq!(style_value("font-weight: bold; --en-id:abc", "--EN-ID"), Some("abc".into()));
    }
}
