//! A mutable arena DOM with an HTML tokenizer and a pragmatic tree builder.
//!
//! Why not build the tree with `tl`: extraction and Markdown conversion walk
//! *structure*, and real pages lean on the HTML5 tree-construction rules that
//! `tl` does not implement — `<p>` closed by the next block, `<li>`/`<td>`/`<tr>`
//! closed by their siblings, `</span>` never closing a `<div>`, raw-text
//! `<script>` bodies containing `</div>`, unquoted attributes (the openread
//! lesson: `tl` truncates `href=http://x.com/y` at the first `/`). This module
//! implements those rules — not the full adoption agency algorithm, but the
//! parts that change what a reader sees.
//!
//! The DOM itself follows openread's read-core `dom.rs` (same author, MIT OR
//! Apache-2.0): a flat `Vec` arena with parent links, entity decoding done once
//! at parse time. Unlike that version this one keeps everything (scripts,
//! styles, comments are dropped but `<script>` text is kept) because the
//! extractor needs JSON-LD and MathJax scripts, and it supports mutation:
//! detach, insert, replace, unwrap.

use crate::entities;

pub type NodeId = usize;

#[derive(Debug, Clone)]
pub enum NodeData {
    Document,
    Element { name: String, attrs: Vec<(String, String)> },
    Text(String),
    Comment(String),
}

#[derive(Debug, Clone)]
pub struct Node {
    pub data: NodeData,
    pub parent: Option<NodeId>,
    pub children: Vec<NodeId>,
}

#[derive(Debug, Clone)]
pub struct Document {
    pub nodes: Vec<Node>,
}

pub const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr", "basefont", "bgsound", "frame", "keygen", "image",
];

const RAW_TEXT: &[&str] = &[
    "script", "style", "xmp", "iframe", "noembed", "noframes", "noscript",
];
const RCDATA: &[&str] = &["textarea", "title"];

/// Start tags that close an open `<p>`.
const CLOSES_P: &[&str] = &[
    "address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div",
    "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
    "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "listing", "section",
    "summary", "table", "ul", "li", "dd", "dt", "search", "plaintext", "xmp",
];

const SPECIAL: &[&str] = &[
    "address", "applet", "area", "article", "aside", "base", "basefont", "bgsound", "blockquote",
    "body", "br", "button", "caption", "center", "col", "colgroup", "dd", "details", "dir", "div",
    "dl", "dt", "embed", "fieldset", "figcaption", "figure", "footer", "form", "frame",
    "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html",
    "iframe", "img", "input", "keygen", "li", "link", "listing", "main", "marquee", "menu",
    "meta", "nav", "noembed", "noframes", "noscript", "object", "ol", "p", "param", "plaintext",
    "pre", "script", "search", "section", "select", "source", "style", "summary", "table",
    "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "title", "tr", "track", "ul",
    "wbr", "xmp",
];

const FORMATTING: &[&str] = &[
    "a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt",
    "u",
];

const SCOPE_BOUNDARY: &[&str] = &[
    "applet", "caption", "html", "table", "td", "th", "marquee", "object", "template",
];

const FOREIGN_BREAKOUT: &[&str] = &[
    "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em",
    "embed", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li", "listing", "menu",
    "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small", "span", "strong", "strike", "sub",
    "sup", "table", "tt", "u", "ul", "var",
];

const INTEGRATION_POINTS: &[&str] = &[
    "foreignobject", "desc", "title", "mi", "mo", "mn", "ms", "mtext", "annotation-xml",
];

pub fn is_void(tag: &str) -> bool {
    VOID.contains(&tag)
}

impl Default for Document {
    fn default() -> Self {
        Document::new()
    }
}

impl Document {
    pub fn new() -> Document {
        Document {
            nodes: vec![Node {
                data: NodeData::Document,
                parent: None,
                children: Vec::new(),
            }],
        }
    }

    pub fn root(&self) -> NodeId {
        0
    }

    /// Parse a whole document or a fragment; either way top-level nodes hang
    /// off the document node.
    pub fn parse(html: &str) -> Document {
        let mut b = Builder {
            doc: Document::new(),
            stack: vec![(0, false)],
            active: Vec::new(),
        };
        tokenize(html, &mut b);
        b.doc
    }

    // ---- accessors -------------------------------------------------------

    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id]
    }

    pub fn tag(&self, id: NodeId) -> Option<&str> {
        match &self.nodes[id].data {
            NodeData::Element { name, .. } => Some(name.as_str()),
            _ => None,
        }
    }

    pub fn is_element(&self, id: NodeId) -> bool {
        matches!(self.nodes[id].data, NodeData::Element { .. })
    }

    pub fn is_tag(&self, id: NodeId, tag: &str) -> bool {
        self.tag(id) == Some(tag)
    }

    pub fn text(&self, id: NodeId) -> Option<&str> {
        match &self.nodes[id].data {
            NodeData::Text(t) => Some(t.as_str()),
            _ => None,
        }
    }

    pub fn attrs(&self, id: NodeId) -> &[(String, String)] {
        match &self.nodes[id].data {
            NodeData::Element { attrs, .. } => attrs,
            _ => &[],
        }
    }

    pub fn attr(&self, id: NodeId, name: &str) -> Option<&str> {
        self.attrs(id)
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn has_attr(&self, id: NodeId, name: &str) -> bool {
        self.attr(id, name).is_some()
    }

    pub fn set_attr(&mut self, id: NodeId, name: &str, value: &str) {
        if let NodeData::Element { attrs, .. } = &mut self.nodes[id].data {
            if let Some(slot) = attrs.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case(name)) {
                slot.1 = value.to_string();
            } else {
                attrs.push((name.to_string(), value.to_string()));
            }
        }
    }

    pub fn remove_attr(&mut self, id: NodeId, name: &str) {
        if let NodeData::Element { attrs, .. } = &mut self.nodes[id].data {
            attrs.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
        }
    }

    pub fn set_attrs(&mut self, id: NodeId, new_attrs: Vec<(String, String)>) {
        if let NodeData::Element { attrs, .. } = &mut self.nodes[id].data {
            *attrs = new_attrs;
        }
    }

    pub fn rename(&mut self, id: NodeId, new_name: &str) {
        if let NodeData::Element { name, .. } = &mut self.nodes[id].data {
            *name = new_name.to_string();
        }
    }

    pub fn classes(&self, id: NodeId) -> impl Iterator<Item = &str> {
        self.attr(id, "class").unwrap_or("").split_ascii_whitespace()
    }

    pub fn has_class(&self, id: NodeId, class: &str) -> bool {
        self.classes(id).any(|c| c == class)
    }

    pub fn children(&self, id: NodeId) -> &[NodeId] {
        &self.nodes[id].children
    }

    pub fn element_children(&self, id: NodeId) -> Vec<NodeId> {
        self.nodes[id]
            .children
            .iter()
            .copied()
            .filter(|c| self.is_element(*c))
            .collect()
    }

    pub fn parent(&self, id: NodeId) -> Option<NodeId> {
        self.nodes[id].parent
    }

    pub fn parent_element(&self, id: NodeId) -> Option<NodeId> {
        self.parent(id).filter(|p| self.is_element(*p))
    }

    pub fn index_in_parent(&self, id: NodeId) -> Option<usize> {
        let p = self.parent(id)?;
        self.nodes[p].children.iter().position(|c| *c == id)
    }

    pub fn next_sibling(&self, id: NodeId) -> Option<NodeId> {
        let p = self.parent(id)?;
        let i = self.index_in_parent(id)?;
        self.nodes[p].children.get(i + 1).copied()
    }

    pub fn prev_sibling(&self, id: NodeId) -> Option<NodeId> {
        let p = self.parent(id)?;
        let i = self.index_in_parent(id)?;
        if i == 0 {
            None
        } else {
            self.nodes[p].children.get(i - 1).copied()
        }
    }

    pub fn next_element_sibling(&self, id: NodeId) -> Option<NodeId> {
        let mut cur = self.next_sibling(id);
        while let Some(c) = cur {
            if self.is_element(c) {
                return Some(c);
            }
            cur = self.next_sibling(c);
        }
        None
    }

    pub fn prev_element_sibling(&self, id: NodeId) -> Option<NodeId> {
        let mut cur = self.prev_sibling(id);
        while let Some(c) = cur {
            if self.is_element(c) {
                return Some(c);
            }
            cur = self.prev_sibling(c);
        }
        None
    }

    /// Is `id` still reachable from the document root?
    pub fn is_attached(&self, id: NodeId) -> bool {
        let mut cur = id;
        loop {
            if cur == 0 {
                return true;
            }
            match self.nodes[cur].parent {
                Some(p) => cur = p,
                None => return false,
            }
        }
    }

    pub fn contains(&self, ancestor: NodeId, id: NodeId) -> bool {
        let mut cur = Some(id);
        while let Some(c) = cur {
            if c == ancestor {
                return true;
            }
            cur = self.nodes[c].parent;
        }
        false
    }

    pub fn ancestors(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut cur = self.nodes[id].parent;
        while let Some(p) = cur {
            out.push(p);
            cur = self.nodes[p].parent;
        }
        out
    }

    pub fn closest_tag(&self, id: NodeId, tags: &[&str]) -> Option<NodeId> {
        let mut cur = Some(id);
        while let Some(c) = cur {
            if self.tag(c).is_some_and(|t| tags.contains(&t)) {
                return Some(c);
            }
            cur = self.nodes[c].parent;
        }
        None
    }

    /// All descendants in document order, excluding `id`.
    pub fn descendants(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack: Vec<NodeId> = self.nodes[id].children.iter().rev().copied().collect();
        while let Some(n) = stack.pop() {
            out.push(n);
            for c in self.nodes[n].children.iter().rev() {
                stack.push(*c);
            }
        }
        out
    }

    pub fn descendant_elements(&self, id: NodeId) -> Vec<NodeId> {
        self.descendants(id)
            .into_iter()
            .filter(|n| self.is_element(*n))
            .collect()
    }

    pub fn find_tag(&self, id: NodeId, tag: &str) -> Option<NodeId> {
        self.descendants(id)
            .into_iter()
            .find(|n| self.tag(*n) == Some(tag))
    }

    pub fn find_all_tags(&self, id: NodeId, tags: &[&str]) -> Vec<NodeId> {
        self.descendants(id)
            .into_iter()
            .filter(|n| self.tag(*n).is_some_and(|t| tags.contains(&t)))
            .collect()
    }

    /// DOM `textContent`: every descendant text node, concatenated.
    pub fn text_content(&self, id: NodeId) -> String {
        if let NodeData::Text(t) = &self.nodes[id].data {
            return t.clone();
        }
        let mut out = String::new();
        let mut stack: Vec<NodeId> = self.nodes[id].children.iter().rev().copied().collect();
        while let Some(n) = stack.pop() {
            match &self.nodes[n].data {
                NodeData::Text(t) => out.push_str(t),
                NodeData::Element { .. } => {
                    for c in self.nodes[n].children.iter().rev() {
                        stack.push(*c);
                    }
                }
                _ => {}
            }
        }
        out
    }

    // ---- mutation --------------------------------------------------------

    fn push_node(&mut self, data: NodeData) -> NodeId {
        self.nodes.push(Node {
            data,
            parent: None,
            children: Vec::new(),
        });
        self.nodes.len() - 1
    }

    pub fn create_element(&mut self, name: &str) -> NodeId {
        self.push_node(NodeData::Element {
            name: name.to_string(),
            attrs: Vec::new(),
        })
    }

    pub fn create_text(&mut self, text: &str) -> NodeId {
        self.push_node(NodeData::Text(text.to_string()))
    }

    pub fn set_text(&mut self, id: NodeId, text: &str) {
        if let NodeData::Text(t) = &mut self.nodes[id].data {
            *t = text.to_string();
        }
    }

    /// Replace all children with a single text node.
    pub fn set_text_content(&mut self, id: NodeId, text: &str) {
        for c in self.nodes[id].children.clone() {
            self.detach(c);
        }
        if !text.is_empty() {
            let t = self.create_text(text);
            self.append(id, t);
        }
    }

    pub fn detach(&mut self, id: NodeId) {
        if let Some(p) = self.nodes[id].parent.take() {
            self.nodes[p].children.retain(|c| *c != id);
        }
    }

    pub fn append(&mut self, parent: NodeId, child: NodeId) {
        self.detach(child);
        self.nodes[child].parent = Some(parent);
        self.nodes[parent].children.push(child);
    }

    pub fn insert_before(&mut self, reference: NodeId, new: NodeId) {
        let Some(p) = self.nodes[reference].parent else {
            return;
        };
        self.detach(new);
        let i = self.index_in_parent(reference).unwrap_or(0);
        self.nodes[new].parent = Some(p);
        self.nodes[p].children.insert(i, new);
    }

    pub fn insert_after(&mut self, reference: NodeId, new: NodeId) {
        let Some(p) = self.nodes[reference].parent else {
            return;
        };
        self.detach(new);
        let i = self.index_in_parent(reference).unwrap_or(0);
        self.nodes[new].parent = Some(p);
        self.nodes[p].children.insert(i + 1, new);
    }

    pub fn replace(&mut self, old: NodeId, new: NodeId) {
        if old == new {
            return;
        }
        self.insert_before(old, new);
        self.detach(old);
    }

    /// Replace an element with its children.
    pub fn unwrap(&mut self, id: NodeId) {
        let Some(p) = self.nodes[id].parent else {
            return;
        };
        let i = self.index_in_parent(id).unwrap_or(0);
        let kids = std::mem::take(&mut self.nodes[id].children);
        for k in &kids {
            self.nodes[*k].parent = Some(p);
        }
        self.nodes[id].parent = None;
        let siblings = &mut self.nodes[p].children;
        siblings.splice(i..=i, kids);
    }

    pub fn move_children(&mut self, from: NodeId, to: NodeId) {
        let kids = std::mem::take(&mut self.nodes[from].children);
        for k in kids {
            self.nodes[k].parent = Some(to);
            self.nodes[to].children.push(k);
        }
    }

    /// Deep-copy a subtree (unattached).
    pub fn clone_subtree(&mut self, id: NodeId) -> NodeId {
        let data = self.nodes[id].data.clone();
        let new = self.push_node(data);
        for c in self.nodes[id].children.clone() {
            let nc = self.clone_subtree(c);
            self.nodes[nc].parent = Some(new);
            self.nodes[new].children.push(nc);
        }
        new
    }

    /// Parse `html` and append the resulting nodes under `parent`.
    pub fn append_html(&mut self, parent: NodeId, html: &str) {
        let frag = Document::parse(html);
        let kids = frag.nodes[0].children.clone();
        for k in kids {
            let id = self.import(&frag, k);
            self.append(parent, id);
        }
    }

    /// Copy a subtree from another document.
    pub fn import(&mut self, other: &Document, id: NodeId) -> NodeId {
        let new = self.push_node(other.nodes[id].data.clone());
        for c in &other.nodes[id].children {
            let nc = self.import(other, *c);
            self.nodes[nc].parent = Some(new);
            self.nodes[new].children.push(nc);
        }
        new
    }

    /// Merge adjacent text nodes and drop empty ones under `id`.
    pub fn normalize(&mut self, id: NodeId) {
        let kids = self.nodes[id].children.clone();
        let mut merged: Vec<NodeId> = Vec::with_capacity(kids.len());
        for k in kids {
            if let NodeData::Text(t) = &self.nodes[k].data {
                if t.is_empty() {
                    self.nodes[k].parent = None;
                    continue;
                }
                if let Some(&prev) = merged.last() {
                    if let NodeData::Text(_) = self.nodes[prev].data {
                        let add = t.clone();
                        if let NodeData::Text(pt) = &mut self.nodes[prev].data {
                            pt.push_str(&add);
                        }
                        self.nodes[k].parent = None;
                        continue;
                    }
                }
            } else {
                self.normalize(k);
            }
            merged.push(k);
        }
        self.nodes[id].children = merged;
    }

    // ---- serialisation ---------------------------------------------------

    pub fn outer_html(&self, id: NodeId) -> String {
        let mut out = String::new();
        self.write_node(id, &mut out);
        out
    }

    pub fn inner_html(&self, id: NodeId) -> String {
        let mut out = String::new();
        let raw = self.tag(id).is_some_and(|t| RAW_TEXT.contains(&t));
        for c in &self.nodes[id].children {
            if raw {
                if let NodeData::Text(t) = &self.nodes[*c].data {
                    out.push_str(t);
                    continue;
                }
            }
            self.write_node(*c, &mut out);
        }
        out
    }

    fn write_node(&self, id: NodeId, out: &mut String) {
        match &self.nodes[id].data {
            NodeData::Document => {
                for c in &self.nodes[id].children {
                    self.write_node(*c, out);
                }
            }
            NodeData::Text(t) => {
                let raw = self
                    .parent(id)
                    .and_then(|p| self.tag(p))
                    .is_some_and(|t| RAW_TEXT.contains(&t));
                if raw {
                    out.push_str(t);
                } else {
                    escape_text(t, out);
                }
            }
            NodeData::Comment(c) => {
                out.push_str("<!--");
                out.push_str(c);
                out.push_str("-->");
            }
            NodeData::Element { name, attrs } => {
                out.push('<');
                out.push_str(name);
                for (k, v) in attrs {
                    out.push(' ');
                    out.push_str(k);
                    out.push_str("=\"");
                    escape_attr(v, out);
                    out.push('"');
                }
                out.push('>');
                if is_void(name) {
                    return;
                }
                out.push_str(&self.inner_html(id));
                out.push_str("</");
                out.push_str(name);
                out.push('>');
            }
        }
    }
}

pub fn escape_text(s: &str, out: &mut String) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            c => out.push(c),
        }
    }
}

pub fn escape_attr(s: &str, out: &mut String) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            c => out.push(c),
        }
    }
}

// ---- tree builder ----------------------------------------------------------

struct Builder {
    doc: Document,
    /// Open elements: (node, is_foreign).
    stack: Vec<(NodeId, bool)>,
    /// The list of active formatting elements; `None` is a marker.
    active: Vec<Option<NodeId>>,
}

/// Start tags that do not reconstruct the active formatting elements.
const NO_RECONSTRUCT: &[&str] = &[
    "html", "head", "body", "base", "basefont", "bgsound", "link", "meta", "script", "style",
    "title", "noscript", "template", "noframes", "address", "article", "aside", "blockquote",
    "center", "details", "dialog", "dir", "div", "dl", "fieldset", "figcaption", "figure",
    "footer", "header", "hgroup", "main", "menu", "nav", "ol", "p", "search", "section", "summary",
    "ul", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "listing", "form", "li", "dd", "dt",
    "plaintext", "table", "caption", "colgroup", "col", "tbody", "thead", "tfoot", "tr", "td",
    "th", "hr", "iframe", "noembed", "textarea", "frameset", "frame",
];

const MARKER_ELEMENTS: &[&str] = &["td", "th", "caption", "applet", "marquee", "object", "template"];

impl Builder {
    fn current(&self) -> NodeId {
        self.stack.last().map(|s| s.0).unwrap_or(0)
    }

    fn in_foreign(&self) -> bool {
        match self.stack.last() {
            Some(&(id, true)) => !self
                .doc
                .tag(id)
                .is_some_and(|t| INTEGRATION_POINTS.contains(&t)),
            _ => false,
        }
    }

    fn text(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        if !self.in_foreign() {
            self.reconstruct();
        }
        let cur = self.current();
        if let Some(&last) = self.doc.nodes[cur].children.last() {
            if let NodeData::Text(t) = &mut self.doc.nodes[last].data {
                t.push_str(s);
                return;
            }
        }
        let id = self.doc.create_text(s);
        self.doc.nodes[id].parent = Some(cur);
        self.doc.nodes[cur].children.push(id);
    }

    fn comment(&mut self, s: &str) {
        let cur = self.current();
        let id = self.doc.push_node(NodeData::Comment(s.to_string()));
        self.doc.nodes[id].parent = Some(cur);
        self.doc.nodes[cur].children.push(id);
    }

    fn stack_names(&self) -> impl DoubleEndedIterator<Item = (usize, &str)> + '_ {
        self.stack
            .iter()
            .enumerate()
            .map(|(i, (id, _))| (i, self.doc.tag(*id).unwrap_or("")))
    }

    /// Index in the stack of the nearest `names` element, stopping at any
    /// element in `boundary`.
    fn find_in_scope(&self, names: &[&str], boundary: &[&str]) -> Option<usize> {
        for (i, name) in self.stack_names().rev() {
            if i == 0 {
                return None;
            }
            if names.contains(&name) {
                return Some(i);
            }
            if boundary.contains(&name) || self.stack[i].1 {
                return None;
            }
        }
        None
    }

    fn pop_to(&mut self, index: usize) {
        let index = index.max(1);
        while self.stack.len() > index {
            let (id, _) = self.stack.pop().unwrap();
            if self.doc.tag(id).is_some_and(|t| MARKER_ELEMENTS.contains(&t)) {
                self.clear_to_marker();
            }
        }
    }

    fn clear_to_marker(&mut self) {
        while let Some(entry) = self.active.pop() {
            if entry.is_none() {
                break;
            }
        }
    }

    fn in_stack(&self, id: NodeId) -> Option<usize> {
        self.stack.iter().rposition(|(n, _)| *n == id)
    }

    fn active_pos(&self, id: NodeId) -> Option<usize> {
        self.active.iter().rposition(|e| *e == Some(id))
    }

    /// "Reconstruct the active formatting elements".
    fn reconstruct(&mut self) {
        let Some(last) = self.active.last() else { return };
        match last {
            None => return,
            Some(id) if self.in_stack(*id).is_some() => return,
            _ => {}
        }
        let mut i = self.active.len() - 1;
        while i > 0 {
            match self.active[i - 1] {
                None => break,
                Some(id) if self.in_stack(id).is_some() => break,
                _ => i -= 1,
            }
        }
        for k in i..self.active.len() {
            let Some(old) = self.active[k] else { continue };
            let (name, attrs) = match &self.doc.nodes[old].data {
                NodeData::Element { name, attrs } => (name.clone(), attrs.clone()),
                _ => continue,
            };
            let new = self.insert(&name, attrs);
            self.stack.push((new, false));
            self.active[k] = Some(new);
        }
    }

    fn push_active(&mut self, id: NodeId) {
        // Noah's Ark: at most three identical entries after the last marker.
        let key = match &self.doc.nodes[id].data {
            NodeData::Element { name, attrs } => (name.clone(), attrs.clone()),
            _ => return,
        };
        let start = self.active.iter().rposition(|e| e.is_none()).map(|p| p + 1).unwrap_or(0);
        let same: Vec<usize> = (start..self.active.len())
            .filter(|k| {
                self.active[*k].is_some_and(|n| match &self.doc.nodes[n].data {
                    NodeData::Element { name, attrs } => *name == key.0 && *attrs == key.1,
                    _ => false,
                })
            })
            .collect();
        if same.len() >= 3 {
            self.active.remove(same[0]);
        }
        self.active.push(Some(id));
    }

    fn create_like(&mut self, old: NodeId) -> NodeId {
        let data = self.doc.nodes[old].data.clone();
        self.doc.push_node(data)
    }

    /// The adoption agency algorithm for a formatting end tag (or an `<a>`
    /// start tag while an `<a>` is still active). Returns false when the
    /// token should be handled as "any other end tag".
    fn adoption_agency(&mut self, subject: &str) -> bool {
        let cur = self.current();
        if self.doc.tag(cur) == Some(subject) && self.active_pos(cur).is_none() {
            self.stack.pop();
            return true;
        }
        for _ in 0..8 {
            let start = self.active.iter().rposition(|e| e.is_none()).map(|p| p + 1).unwrap_or(0);
            let Some(fe_pos) = (start..self.active.len())
                .rev()
                .find(|k| self.active[*k].is_some_and(|n| self.doc.tag(n) == Some(subject)))
            else {
                return false;
            };
            let fe = self.active[fe_pos].unwrap();
            let Some(fe_stack) = self.in_stack(fe) else {
                self.active.remove(fe_pos);
                return true;
            };
            // Must be in scope.
            let in_scope = self.stack[fe_stack + 1..]
                .iter()
                .all(|(n, _)| !self.doc.tag(*n).is_some_and(|t| SCOPE_BOUNDARY.contains(&t)));
            if !in_scope {
                return true;
            }
            let furthest = (fe_stack + 1..self.stack.len())
                .find(|k| self.doc.tag(self.stack[*k].0).is_some_and(|t| SPECIAL.contains(&t)));
            let Some(fb_stack) = furthest else {
                self.stack.truncate(fe_stack);
                self.active.remove(fe_pos);
                return true;
            };
            let furthest_block = self.stack[fb_stack].0;
            let common_ancestor = self.stack[fe_stack - 1].0;
            let mut bookmark = fe_pos;
            let mut node_stack = fb_stack;
            let mut last_node = furthest_block;
            let mut inner = 0;
            loop {
                inner += 1;
                node_stack -= 1;
                let node = self.stack[node_stack].0;
                if node == fe {
                    break;
                }
                if inner > 3 {
                    if let Some(p) = self.active_pos(node) {
                        self.active.remove(p);
                        if p < bookmark {
                            bookmark -= 1;
                        }
                    }
                }
                let Some(node_active) = self.active_pos(node) else {
                    self.stack.remove(node_stack);
                    continue;
                };
                let new = self.create_like(node);
                self.active[node_active] = Some(new);
                self.stack[node_stack] = (new, false);
                if last_node == furthest_block {
                    bookmark = node_active + 1;
                }
                self.doc.append(new, last_node);
                last_node = new;
            }
            self.doc.append(common_ancestor, last_node);
            let new_fe = self.create_like(fe);
            self.doc.move_children(furthest_block, new_fe);
            self.doc.append(furthest_block, new_fe);
            if let Some(p) = self.active_pos(fe) {
                self.active.remove(p);
                if p < bookmark {
                    bookmark -= 1;
                }
            }
            self.active.insert(bookmark.min(self.active.len()), Some(new_fe));
            if let Some(p) = self.in_stack(fe) {
                self.stack.remove(p);
            }
            let fb_pos = self.in_stack(furthest_block).unwrap_or(self.stack.len() - 1);
            self.stack.insert(fb_pos + 1, (new_fe, false));
        }
        true
    }

    fn existing(&self, tag: &str) -> Option<NodeId> {
        self.stack
            .iter()
            .find(|(id, _)| self.doc.tag(*id) == Some(tag))
            .map(|s| s.0)
    }

    fn start_tag(&mut self, name: &str, attrs: Vec<(String, String)>, self_closing: bool) -> bool {
        // Foreign content (SVG / MathML).
        if self.in_foreign() {
            if FOREIGN_BREAKOUT.contains(&name) || (name == "font") {
                while self.stack.len() > 1 && self.in_foreign() {
                    self.stack.pop();
                }
            } else {
                let id = self.insert(name, attrs);
                if !self_closing {
                    self.stack.push((id, true));
                }
                return false;
            }
        }

        match name {
            "html" | "body" | "head" => {
                if let Some(existing) = self.existing(name) {
                    for (k, v) in attrs {
                        if self.doc.attr(existing, &k).is_none() {
                            self.doc.set_attr(existing, &k, &v);
                        }
                    }
                    return false;
                }
                if name == "body" {
                    // A body after head: close head first.
                    if let Some(i) = self.find_in_scope(&["head"], &[]) {
                        self.pop_to(i);
                    }
                }
            }
            _ => {}
        }

        if CLOSES_P.contains(&name) {
            let mut boundary: Vec<&str> = SCOPE_BOUNDARY.to_vec();
            boundary.push("button");
            if let Some(i) = self.find_in_scope(&["p"], &boundary) {
                self.pop_to(i);
            }
        }

        match name {
            "li" => self.close_list_item(&["li"], &["ul", "ol", "menu"]),
            "dt" | "dd" => self.close_list_item(&["dt", "dd"], &["dl"]),
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                if self
                    .doc
                    .tag(self.current())
                    .is_some_and(|t| matches!(t, "h1" | "h2" | "h3" | "h4" | "h5" | "h6"))
                {
                    self.stack.pop();
                }
            }
            "tr" => {
                if let Some(i) = self.find_in_scope(&["tr"], &["table", "html", "template"]) {
                    self.pop_to(i);
                }
            }
            "td" | "th" => {
                if let Some(i) =
                    self.find_in_scope(&["td", "th"], &["tr", "table", "html", "template"])
                {
                    self.pop_to(i);
                }
            }
            "thead" | "tbody" | "tfoot" => {
                if let Some(i) = self.find_in_scope(
                    &["thead", "tbody", "tfoot", "caption", "colgroup"],
                    &["table", "html", "template"],
                ) {
                    self.pop_to(i);
                }
            }
            "caption" | "colgroup" => {
                if let Some(i) = self.find_in_scope(
                    &["thead", "tbody", "tfoot", "tr", "td", "th"],
                    &["table", "html", "template"],
                ) {
                    self.pop_to(i);
                }
            }
            "option" => {
                if self.doc.tag(self.current()) == Some("option") {
                    self.stack.pop();
                }
            }
            "optgroup" => {
                if matches!(self.doc.tag(self.current()), Some("option")) {
                    self.stack.pop();
                }
                if matches!(self.doc.tag(self.current()), Some("optgroup")) {
                    self.stack.pop();
                }
            }
            "a" => {
                let start = self.active.iter().rposition(|e| e.is_none()).map(|p| p + 1).unwrap_or(0);
                let open_a = (start..self.active.len())
                    .rev()
                    .find_map(|k| self.active[k].filter(|n| self.doc.tag(*n) == Some("a")));
                if let Some(a) = open_a {
                    self.adoption_agency("a");
                    if let Some(p) = self.active_pos(a) {
                        self.active.remove(p);
                    }
                    if let Some(p) = self.in_stack(a) {
                        self.stack.remove(p);
                    }
                }
            }
            "button" => {
                if let Some(i) = self.find_in_scope(&["button"], SCOPE_BOUNDARY) {
                    self.pop_to(i);
                }
            }
            "nobr" => {
                if let Some(i) = self.find_in_scope(&["nobr"], SCOPE_BOUNDARY) {
                    self.pop_to(i);
                }
            }
            "rb" | "rtc" | "rp" | "rt" => {
                if let Some(i) = self.find_in_scope(&["rb", "rp", "rt", "rtc"], &["ruby"]) {
                    self.pop_to(i);
                }
            }
            _ => {}
        }

        // Implied table sections, as the HTML parser inserts them.
        if matches!(name, "tr" | "td" | "th") && self.doc.tag(self.current()) == Some("table") {
            let tbody = self.insert("tbody", Vec::new());
            self.stack.push((tbody, false));
        }
        if matches!(name, "td" | "th")
            && matches!(self.doc.tag(self.current()), Some("tbody" | "thead" | "tfoot"))
        {
            let tr = self.insert("tr", Vec::new());
            self.stack.push((tr, false));
        }

        let name = if name == "image" { "img" } else { name };
        if !NO_RECONSTRUCT.contains(&name) {
            self.reconstruct();
        }
        let id = self.insert(name, attrs);
        if FORMATTING.contains(&name) {
            self.push_active(id);
        }
        if MARKER_ELEMENTS.contains(&name) {
            self.active.push(None);
        }
        let foreign = matches!(name, "svg" | "math");
        if foreign {
            if !self_closing {
                self.stack.push((id, true));
            }
            return false;
        }
        if is_void(name) {
            return false;
        }
        self.stack.push((id, false));
        RAW_TEXT.contains(&name) || RCDATA.contains(&name)
    }

    fn close_list_item(&mut self, items: &[&str], lists: &[&str]) {
        let mut target = None;
        for (i, name) in self.stack_names().rev() {
            if i == 0 {
                break;
            }
            if items.contains(&name) {
                target = Some(i);
                break;
            }
            if lists.contains(&name)
                || (SPECIAL.contains(&name) && !matches!(name, "address" | "div" | "p"))
            {
                break;
            }
        }
        if let Some(i) = target {
            self.pop_to(i);
        }
    }

    fn insert(&mut self, name: &str, attrs: Vec<(String, String)>) -> NodeId {
        let cur = self.current();
        let id = self.doc.push_node(NodeData::Element {
            name: name.to_string(),
            attrs,
        });
        self.doc.nodes[id].parent = Some(cur);
        self.doc.nodes[cur].children.push(id);
        id
    }

    fn end_tag(&mut self, name: &str) {
        if name == "br" {
            self.insert("br", Vec::new());
            return;
        }
        if is_void(name) {
            return;
        }
        // Inside foreign content an end tag closes the matching foreign element.
        if self.stack.last().is_some_and(|s| s.1) {
            for (i, (id, foreign)) in self.stack.iter().enumerate().rev() {
                if i == 0 {
                    break;
                }
                if self.doc.tag(*id).is_some_and(|t| t.eq_ignore_ascii_case(name)) {
                    self.pop_to(i);
                    return;
                }
                if !foreign {
                    break;
                }
            }
        }
        match name {
            "html" | "body" | "head" => {
                if name == "head" {
                    if let Some(i) = self.find_in_scope(&["head"], &[]) {
                        self.pop_to(i);
                    }
                }
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                if let Some(i) =
                    self.find_in_scope(&["h1", "h2", "h3", "h4", "h5", "h6"], SCOPE_BOUNDARY)
                {
                    self.pop_to(i);
                }
            }
            "p" => {
                let mut boundary: Vec<&str> = SCOPE_BOUNDARY.to_vec();
                boundary.push("button");
                if let Some(i) = self.find_in_scope(&["p"], &boundary) {
                    self.pop_to(i);
                }
            }
            "li" => {
                let mut boundary: Vec<&str> = SCOPE_BOUNDARY.to_vec();
                boundary.extend(["ul", "ol"]);
                if let Some(i) = self.find_in_scope(&["li"], &boundary) {
                    self.pop_to(i);
                }
            }
            "table" => {
                if let Some(i) = self.find_in_scope(&["table"], &["html", "template"]) {
                    self.pop_to(i);
                }
            }
            "tr" | "td" | "th" | "thead" | "tbody" | "tfoot" | "caption" => {
                if let Some(i) = self.find_in_scope(&[name], &["table", "html", "template"]) {
                    self.pop_to(i);
                }
            }
            _ if FORMATTING.contains(&name) => {
                if !self.adoption_agency(name) {
                    self.any_other_end_tag(name);
                }
            }
            _ if SPECIAL.contains(&name) => {
                if let Some(i) = self.find_in_scope(&[name], SCOPE_BOUNDARY) {
                    self.pop_to(i);
                }
            }
            _ => self.any_other_end_tag(name),
        }
    }

    /// "Any other end tag": walk down the stack; stop at a special element.
    fn any_other_end_tag(&mut self, name: &str) {
        let mut target = None;
        for (i, (id, _)) in self.stack.iter().enumerate().rev() {
            if i == 0 {
                return;
            }
            let tag = self.doc.tag(*id).unwrap_or("");
            if tag == name {
                target = Some(i);
                break;
            }
            if SPECIAL.contains(&tag) {
                return;
            }
        }
        if let Some(i) = target {
            self.pop_to(i);
        }
    }
}

// ---- tokenizer -------------------------------------------------------------

fn tokenize(html: &str, b: &mut Builder) {
    let bytes = html.as_bytes();
    let len = bytes.len();
    let mut i = 0usize;
    let mut text_start = 0usize;

    let flush = |b: &mut Builder, from: usize, to: usize| {
        if to > from {
            let raw = &html[from..to];
            let decoded = entities::decode(raw, false);
            b.text(&decoded);
        }
    };

    while i < len {
        if bytes[i] != b'<' {
            // Jump to the next '<'.
            match memchr(b'<', &bytes[i..]) {
                Some(off) => i += off,
                None => {
                    i = len;
                    break;
                }
            }
            continue;
        }
        let next = bytes.get(i + 1).copied();
        match next {
            Some(b'!') => {
                flush(b, text_start, i);
                if html[i..].starts_with("<!--") {
                    let body_start = i + 4;
                    let end = html[body_start..].find("-->");
                    let (body, after) = match end {
                        Some(e) => (&html[body_start..body_start + e], body_start + e + 3),
                        None => (&html[body_start..], len),
                    };
                    b.comment(body);
                    i = after;
                } else if html[i..].starts_with("<![CDATA[") {
                    let body_start = i + 9;
                    let end = html[body_start..].find("]]>");
                    let (body, after) = match end {
                        Some(e) => (&html[body_start..body_start + e], body_start + e + 3),
                        None => (&html[body_start..], len),
                    };
                    if b.in_foreign() {
                        b.text(body);
                    }
                    i = after;
                } else {
                    let end = memchr(b'>', &bytes[i..]).map(|e| i + e + 1).unwrap_or(len);
                    i = end;
                }
                text_start = i;
            }
            Some(b'?') => {
                flush(b, text_start, i);
                let end = memchr(b'>', &bytes[i..]).map(|e| i + e + 1).unwrap_or(len);
                i = end;
                text_start = i;
            }
            Some(b'/') => {
                let name_start = i + 2;
                if !bytes.get(name_start).is_some_and(|c| c.is_ascii_alphabetic()) {
                    // `</>` or `</ ` — bogus; skip to '>' if it is `</` + non-letter.
                    if bytes.get(name_start) == Some(&b'>') {
                        flush(b, text_start, i);
                        i = name_start + 1;
                        text_start = i;
                    } else {
                        i += 1;
                    }
                    continue;
                }
                flush(b, text_start, i);
                let mut j = name_start;
                while j < len && !matches!(bytes[j], b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'/' | b'>') {
                    j += 1;
                }
                let name = html[name_start..j].to_ascii_lowercase();
                let end = find_tag_end(bytes, j).unwrap_or(len);
                b.end_tag(&name);
                i = (end + 1).min(len);
                text_start = i;
            }
            Some(c) if c.is_ascii_alphabetic() => {
                flush(b, text_start, i);
                let (name, attrs, self_closing, end) = parse_start_tag(html, i + 1, b.in_foreign());
                let raw = b.start_tag(&name, attrs, self_closing);
                i = end;
                text_start = i;
                if raw && !self_closing {
                    // Raw text / RCDATA: find the matching end tag.
                    let close = find_raw_end(html, i, &name);
                    let body = &html[i..close];
                    if RCDATA.contains(&name.as_str()) {
                        b.text(&entities::decode(body, false));
                    } else {
                        b.text(body);
                    }
                    b.end_tag(&name);
                    // Skip past `</name ...>`.
                    i = if close < len {
                        find_tag_end(bytes, close).map(|e| e + 1).unwrap_or(len)
                    } else {
                        len
                    };
                    text_start = i;
                } else if raw && self_closing {
                    b.end_tag(&name);
                }
            }
            _ => {
                i += 1;
            }
        }
    }
    flush(b, text_start, len.min(i.max(text_start)));
}

fn memchr(needle: u8, hay: &[u8]) -> Option<usize> {
    hay.iter().position(|b| *b == needle)
}

fn find_raw_end(html: &str, from: usize, name: &str) -> usize {
    let bytes = html.as_bytes();
    let n = name.len();
    let mut i = from;
    while let Some(off) = memchr(b'<', &bytes[i..]) {
        let at = i + off;
        if bytes.get(at + 1) == Some(&b'/')
            && at + 2 + n <= bytes.len()
            && bytes[at + 2..at + 2 + n].eq_ignore_ascii_case(name.as_bytes())
            && bytes
                .get(at + 2 + n)
                .is_none_or(|c| matches!(c, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'/' | b'>'))
        {
            return at;
        }
        i = at + 1;
    }
    bytes.len()
}

fn find_tag_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut i = from;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == b'>' => return Some(i),
            None => {}
        }
        i += 1;
    }
    None
}

/// Parse `name attr=value ...>` starting right after `<`. Returns the index
/// just past `>`.
fn parse_start_tag(html: &str, start: usize, foreign: bool) -> (String, Vec<(String, String)>, bool, usize) {
    let bytes = html.as_bytes();
    let len = bytes.len();
    let mut i = start;
    while i < len && !matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'/' | b'>') {
        i += 1;
    }
    let name = html[start..i].to_ascii_lowercase();
    let mut attrs: Vec<(String, String)> = Vec::new();
    let mut self_closing = false;
    loop {
        while i < len && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r' | b'\x0c') {
            i += 1;
        }
        if i >= len {
            return (name, attrs, self_closing, len);
        }
        match bytes[i] {
            b'>' => return (name, attrs, self_closing, i + 1),
            b'/' => {
                i += 1;
                if bytes.get(i) == Some(&b'>') {
                    self_closing = true;
                }
                continue;
            }
            _ => {}
        }
        // Attribute name.
        let ns = i;
        i += 1; // first char may be '=' per spec
        while i < len && !matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'/' | b'>' | b'=') {
            i += 1;
        }
        let raw_name = &html[ns..i];
        let attr_name = if foreign {
            raw_name.to_string()
        } else {
            raw_name.to_ascii_lowercase()
        };
        while i < len && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r' | b'\x0c') {
            i += 1;
        }
        let mut value = String::new();
        if i < len && bytes[i] == b'=' {
            i += 1;
            while i < len && matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r' | b'\x0c') {
                i += 1;
            }
            if i < len && (bytes[i] == b'"' || bytes[i] == b'\'') {
                let q = bytes[i];
                let vs = i + 1;
                let ve = memchr(q, &bytes[vs..]).map(|e| vs + e).unwrap_or(len);
                value = entities::decode(&html[vs..ve], true);
                i = (ve + 1).min(len);
            } else {
                let vs = i;
                while i < len && !matches!(bytes[i], b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' | b'>') {
                    i += 1;
                }
                value = entities::decode(&html[vs..i], true);
            }
        }
        if !attrs.iter().any(|(k, _)| *k == attr_name) {
            attrs.push((attr_name, value));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(doc: &Document) -> NodeId {
        doc.find_tag(0, "body").unwrap_or(0)
    }

    #[test]
    fn round_trips_simple_markup() {
        let d = Document::parse(r#"<div class="a"><p>Hi &amp; <b>bye</b></p><img src="x.png"></div>"#);
        assert_eq!(
            d.outer_html(d.children(0)[0]),
            r#"<div class="a"><p>Hi &amp; <b>bye</b></p><img src="x.png"></div>"#
        );
    }

    #[test]
    fn paragraphs_close_on_blocks_and_list_items_on_siblings() {
        let d = Document::parse("<p>one<p>two<div>three</div><ul><li>a<li>b</ul>");
        assert_eq!(
            d.outer_html(0),
            "<p>one</p><p>two</p><div>three</div><ul><li>a</li><li>b</li></ul>"
        );
    }

    #[test]
    fn stray_inline_end_tag_does_not_close_a_block() {
        let d = Document::parse("<div><p>a</span>b</p>c</div>");
        assert_eq!(d.outer_html(0), "<div><p>ab</p>c</div>");
    }

    #[test]
    fn unquoted_attributes_keep_slashes() {
        let d = Document::parse("<a href=http://ex.com/x/y.php>Label</a>");
        let a = d.find_tag(0, "a").unwrap();
        assert_eq!(d.attr(a, "href"), Some("http://ex.com/x/y.php"));
        assert_eq!(d.text_content(a), "Label");
    }

    #[test]
    fn script_bodies_are_raw_text() {
        let d = Document::parse("<div><script>if (a<b) { x = '</div>'; }</script><p>after</p></div>");
        let s = d.find_tag(0, "script").unwrap();
        assert_eq!(d.text_content(s), "if (a<b) { x = '</div>'; }");
        let div = d.find_tag(0, "div").unwrap();
        assert!(d.find_tag(div, "p").is_some());
    }

    #[test]
    fn raw_text_end_search_does_not_split_multibyte_chars() {
        // Guardian: a script containing `</•` panicked on a char boundary.
        let d = Document::parse("<script>var s = '</•x';</script><p>after</p>");
        assert_eq!(d.text_content(d.find_tag(0, "script").unwrap()), "var s = '</•x';");
        assert!(d.find_tag(0, "p").is_some());
    }

    #[test]
    fn every_prefix_of_tricky_markup_parses_without_panic() {
        let src = "<p a=é b='ü' c=\"•\">x<!--é--><script>é</sc</•</script><textarea>&amp;é</textarea><svg><![CDATA[é]]></svg><b><i>é</b></i><table><td>é<a href=é>é</a></table>&#x1F600;&bogusé;</p>";
        for (i, _) in src.char_indices() {
            let d = Document::parse(&src[..i]);
            let _ = d.outer_html(0);
        }
    }

    #[test]
    fn table_cells_and_rows_close_implicitly() {
        let d = Document::parse("<table><tr><td>1<td>2<tr><td>3</table>");
        assert_eq!(
            d.outer_html(0),
            "<table><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></tbody></table>"
        );
    }

    #[test]
    fn svg_self_closing_children_are_honoured() {
        let d = Document::parse(r#"<p><svg viewBox="0 0 1 1"><path d="M0"/><circle r="1"/></svg>text</p>"#);
        let svg = d.find_tag(0, "svg").unwrap();
        assert_eq!(d.element_children(svg).len(), 2);
        assert_eq!(d.attr(svg, "viewBox"), Some("0 0 1 1"));
        let p = d.find_tag(0, "p").unwrap();
        assert_eq!(d.text_content(p), "text");
    }

    #[test]
    fn document_structure_and_merged_duplicate_body() {
        let d = Document::parse("<!doctype html><html lang=en><head><title>T &amp; U</title></head><body class=x><p>a</p></body></html>");
        let b = body(&d);
        assert_eq!(d.attr(b, "class"), Some("x"));
        let t = d.find_tag(0, "title").unwrap();
        assert_eq!(d.text_content(t), "T & U");
    }

    #[test]
    fn mutation_unwrap_and_replace() {
        let mut d = Document::parse("<div><span><b>x</b>y</span></div>");
        let span = d.find_tag(0, "span").unwrap();
        d.unwrap(span);
        assert_eq!(d.outer_html(0), "<div><b>x</b>y</div>");
        let b = d.find_tag(0, "b").unwrap();
        let s = d.create_element("strong");
        d.replace(b, s);
        d.append(s, d.children(b)[0]);
        assert_eq!(d.outer_html(0), "<div><strong>x</strong>y</div>");
    }

    #[test]
    fn formatting_elements_are_reconstructed_across_blocks() {
        let d = Document::parse(r#"<p><a href="x">one<p>two</a> three</p>"#);
        assert_eq!(
            d.outer_html(0),
            r#"<p><a href="x">one</a></p><p><a href="x">two</a> three</p>"#
        );
        let d = Document::parse("<b>bold<i>both</b>italic</i>");
        assert_eq!(d.outer_html(0), "<b>bold<i>both</i></b><i>italic</i>");
    }

    #[test]
    fn adoption_agency_moves_blocks_out_of_a_misnested_anchor() {
        // Substack tweet embeds: a new <a> inside a <p> inside an open <a>.
        let d = Document::parse(r#"<a href="1"><div>d</div><p>quote <a href="2">link</a> </p></a>"#);
        assert_eq!(
            d.outer_html(0),
            r#"<a href="1"><div>d</div></a><p><a href="1">quote </a><a href="2">link</a> </p>"#
        );
    }

    #[test]
    fn nested_anchor_closes_previous_anchor() {
        let d = Document::parse("<a href=1>one<a href=2>two</a>");
        assert_eq!(d.outer_html(0), r#"<a href="1">one</a><a href="2">two</a>"#);
    }
}
