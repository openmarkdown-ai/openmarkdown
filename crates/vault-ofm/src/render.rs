//! HTML for the reading view, one section per top-level block.
//!
//! The shapes are the contract in docs/ARCHITECTURE.md: `packages/app` fills
//! in what needs the vault (embeds, link resolution, callout icons, math) and
//! plugins select on these class names, so they are produced exactly, down
//! to attribute order. Structural HTML (lists, tables, block quotes) follows
//! mdast-util-to-hast 10 (MIT), including where it puts line feeds.
//!
//! Sections are rendered independently, the way a post-processor sees them:
//! `data-line` on list items counts from the section's first line, so
//! `getSectionInfo(el).lineStart + Number(li.dataset.line)` is the item's
//! line in the file.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::metadata::Conv;
use crate::mdast::{Align, Kind, Node};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderOptions {
    /// Obsidian's "Strict line breaks": when off (the default) a single
    /// newline inside a paragraph is a `<br>`.
    pub strict_line_breaks: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct Rendered {
    pub sections: Vec<RenderedSection>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RenderedSection {
    /// The `SectionCache.type` of the block, or `footnotes` for the list of
    /// footnotes appended after the last block.
    pub kind: String,
    /// 0-based, inclusive, as `SectionCache.position` lines.
    pub line_start: u32,
    pub line_end: u32,
    pub html: String,
}

pub fn render(text: &str, opts: &RenderOptions) -> Rendered {
    let mut root = crate::tokenizer::parse_tree(text, !opts.strict_line_breaks);
    crate::transform::apply(&mut root);
    let conv = Conv::new(text);
    let mut r = Renderer::new(&root);
    let mut sections = Vec::with_capacity(root.children.len() + 1);
    for child in &root.children {
        let pos = conv.pos(child.pos);
        r.section_line = child.pos.start.line;
        let mut html = String::new();
        r.block(child, &mut html);
        sections.push(RenderedSection {
            kind: child.type_name().to_string(),
            line_start: pos.start.line,
            line_end: pos.end.line,
            html,
        });
    }
    if let Some(html) = r.footnotes() {
        let line = sections.last().map(|s| s.line_end).unwrap_or(0);
        sections.push(RenderedSection { kind: "footnotes".into(), line_start: line, line_end: line, html });
    }
    Rendered { sections }
}

enum Note<'a> {
    Def(&'a Node),
    Inline(&'a Node),
}

struct Renderer<'a> {
    /// Link reference definitions by normalised identifier; the first wins.
    definitions: HashMap<String, (&'a str, Option<&'a str>)>,
    footnote_defs: HashMap<String, &'a Node>,
    /// Footnotes in the order they are first referenced, with the number of
    /// references so far (each gets its own back link).
    notes: Vec<(Note<'a>, usize)>,
    note_index: HashMap<String, usize>,
    /// 1-based line of the section being rendered.
    section_line: u32,
}

pub(crate) fn escape_text(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

pub(crate) fn escape_attr(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

fn attr(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    escape_attr(s, &mut o);
    o
}

/// `100` or `100x80` (Embed files.md), for external images.
fn parse_size(s: &str) -> Option<(String, Option<String>)> {
    let t = s.trim();
    let digits = |x: &str| !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit());
    if digits(t) {
        return Some((t.to_string(), None));
    }
    let (w, h) = t.split_once('x')?;
    let (w, h) = (w.trim(), h.trim());
    (digits(w) && digits(h)).then(|| (w.to_string(), Some(h.to_string())))
}

fn collect_defs<'a>(node: &'a Node, r: &mut Renderer<'a>) {
    match &node.kind {
        Kind::Definition { identifier, url, title, .. } => {
            r.definitions.entry(identifier.clone()).or_insert((url.as_str(), title.as_deref()));
        }
        Kind::FootnoteDefinition { identifier, .. } => {
            r.footnote_defs.entry(identifier.clone()).or_insert(node);
        }
        _ => {}
    }
    for c in &node.children {
        collect_defs(c, r);
    }
}

impl<'a> Renderer<'a> {
    fn new(root: &'a Node) -> Renderer<'a> {
        let mut r = Renderer {
            definitions: HashMap::new(),
            footnote_defs: HashMap::new(),
            notes: Vec::new(),
            note_index: HashMap::new(),
            section_line: 1,
        };
        collect_defs(root, &mut r);
        r
    }

    fn blocks(&mut self, nodes: &'a [Node], out: &mut String) {
        let mut first = true;
        for n in nodes {
            let mut html = String::new();
            self.block(n, &mut html);
            if html.is_empty() {
                continue;
            }
            if !first {
                out.push('\n');
            }
            first = false;
            out.push_str(&html);
        }
    }

    /// Children wrapped the mdast-util-to-hast way: `\n` before, between and
    /// after (a lone `\n` when there are none).
    fn wrapped(&mut self, nodes: &'a [Node], out: &mut String) {
        let mut inner = String::new();
        self.blocks(nodes, &mut inner);
        out.push('\n');
        if !inner.is_empty() {
            out.push_str(&inner);
            out.push('\n');
        }
    }

    fn block(&mut self, node: &'a Node, out: &mut String) {
        match &node.kind {
            Kind::Paragraph => {
                let mut inner = String::new();
                self.inlines(&node.children, &mut inner);
                if inner.is_empty() && node.children.iter().all(|c| matches!(c.kind, Kind::Comment | Kind::BlockId(_))) {
                    return;
                }
                out.push_str("<p dir=\"auto\">");
                out.push_str(&inner);
                out.push_str("</p>");
            }
            Kind::Heading { depth } => {
                let mut inner = String::new();
                self.inlines(&node.children, &mut inner);
                let text = heading_attr_text(node);
                out.push_str(&format!("<h{depth} data-heading=\"{}\" dir=\"auto\">", attr(&text)));
                out.push_str(&inner);
                out.push_str(&format!("</h{depth}>"));
            }
            Kind::ThematicBreak => out.push_str("<hr>"),
            Kind::Blockquote { .. } => {
                out.push_str("<blockquote dir=\"auto\">");
                self.wrapped(&node.children, out);
                out.push_str("</blockquote>");
            }
            Kind::Callout(info) => self.callout(node, info, out),
            Kind::List { ordered, start, .. } => self.list(node, *ordered, *start, out),
            Kind::Table { align } => self.table(node, align, out),
            Kind::Html(v) => out.push_str(v),
            Kind::Code { lang, value, .. } => {
                let lang = lang.as_deref().and_then(|l| l.split([' ', '\t']).next()).filter(|l| !l.is_empty());
                match lang {
                    Some(l) => {
                        let a = attr(&format!("language-{l}"));
                        out.push_str(&format!("<pre class=\"{a}\"><code class=\"{a}\">"));
                    }
                    None => out.push_str("<pre><code>"),
                }
                if !value.is_empty() {
                    escape_text(value, out);
                    out.push('\n');
                }
                out.push_str("</code></pre>");
            }
            Kind::Math(v) => {
                out.push_str("<div class=\"math math-block\">");
                escape_text(v, out);
                out.push_str("</div>");
            }
            // Hidden, or shown elsewhere (definitions in the footnotes list,
            // frontmatter in the properties widget).
            Kind::Comment | Kind::Yaml(_) | Kind::Definition { .. } | Kind::FootnoteDefinition { .. } => {}
            Kind::BlockId(_) => {}
            _ => self.inline(node, out),
        }
    }

    fn callout(&mut self, node: &'a Node, info: &crate::mdast::CalloutInfo, out: &mut String) {
        let (class, fold_class, content_style) = match info.fold.as_str() {
            "-" => ("callout is-collapsible is-collapsed", Some("callout-fold is-collapsed"), " style=\"display: none;\""),
            "+" => ("callout is-collapsible", Some("callout-fold"), ""),
            _ => ("callout", None, ""),
        };
        out.push_str(&format!(
            "<div data-callout-metadata=\"{}\" data-callout-fold=\"{}\" data-callout=\"{}\" class=\"{}\">",
            attr(&info.metadata),
            attr(&info.fold),
            attr(&info.kind),
            class
        ));
        out.push_str("<div class=\"callout-title\" dir=\"auto\"><div class=\"callout-icon\"></div><div class=\"callout-title-inner\">");
        if let Some(title) = node.children.iter().find(|c| matches!(c.kind, Kind::CalloutTitle)) {
            // Inline title content, or a block when the first line was one
            // (`> [!note] # Heading`).
            self.inlines(&title.children, out);
        }
        out.push_str("</div>");
        if let Some(fc) = fold_class {
            out.push_str(&format!("<div class=\"{fc}\"></div>"));
        }
        out.push_str("</div>");
        if let Some(content) = node.children.iter().find(|c| matches!(c.kind, Kind::CalloutContent)) {
            out.push_str(&format!("<div class=\"callout-content\"{content_style}>"));
            self.wrapped(&content.children, out);
            out.push_str("</div>");
        }
        out.push_str("</div>");
    }

    fn list(&mut self, node: &'a Node, ordered: bool, start: Option<u64>, out: &mut String) {
        let loose = matches!(node.kind, Kind::List { spread: true, .. })
            || node.children.iter().any(|i| matches!(i.kind, Kind::ListItem { spread: true, .. }));
        let tag = if ordered { "ol" } else { "ul" };
        out.push('<');
        out.push_str(tag);
        if let Some(s) = start.filter(|s| ordered && *s != 1) {
            out.push_str(&format!(" start=\"{s}\""));
        }
        if node.children.iter().any(|i| matches!(i.kind, Kind::ListItem { checklist: Some(_), .. })) {
            out.push_str(" class=\"contains-task-list\"");
        }
        out.push_str(">\n");
        for (k, item) in node.children.iter().enumerate() {
            if k > 0 {
                out.push('\n');
            }
            self.list_item(item, loose, out);
        }
        if !node.children.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("</{tag}>"));
    }

    fn list_item(&mut self, item: &'a Node, loose: bool, out: &mut String) {
        let Kind::ListItem { checklist, .. } = &item.kind else { return };
        let line = item.pos.start.line.saturating_sub(self.section_line);
        out.push_str(&format!("<li data-line=\"{line}\""));
        if let Some(task) = checklist {
            let checked = task != " ";
            out.push_str(&format!(
                " data-task=\"{}\" class=\"task-list-item{}\"",
                attr(task),
                if checked { " is-checked" } else { "" }
            ));
        }
        out.push_str(" dir=\"auto\">");
        if let Some(task) = checklist {
            out.push_str(&format!(
                "<input data-line=\"{line}\" type=\"checkbox\" class=\"task-list-item-checkbox\"{}>",
                if task != " " { " checked" } else { "" }
            ));
        }
        let children: Vec<&Node> =
            item.children.iter().filter(|c| !matches!(c.kind, Kind::BlockId(_) | Kind::Comment)).collect();
        let mut last_was_p = false;
        for (index, child) in children.iter().enumerate() {
            let is_p = matches!(child.kind, Kind::Paragraph);
            if loose || index != 0 || !is_p {
                out.push('\n');
            }
            if is_p && !loose {
                self.inlines(&child.children, out);
            } else {
                self.block(child, out);
            }
            last_was_p = is_p;
        }
        if !children.is_empty() && (loose || !last_was_p) {
            out.push('\n');
        }
        out.push_str("</li>");
    }

    fn table(&mut self, node: &'a Node, align: &[Align], out: &mut String) {
        out.push_str("<table>\n");
        for (r, row) in node.children.iter().enumerate() {
            if r == 0 {
                out.push_str("<thead>\n");
            } else if r == 1 {
                out.push_str("\n<tbody>\n");
            } else {
                out.push('\n');
            }
            let cell_tag = if r == 0 { "th" } else { "td" };
            out.push_str("<tr>\n");
            let count = if align.is_empty() { row.children.len() } else { align.len() };
            for c in 0..count {
                if c > 0 {
                    out.push('\n');
                }
                out.push('<');
                out.push_str(cell_tag);
                match align.get(c) {
                    Some(Align::Left) => out.push_str(" align=\"left\""),
                    Some(Align::Center) => out.push_str(" align=\"center\""),
                    Some(Align::Right) => out.push_str(" align=\"right\""),
                    _ => {}
                }
                out.push('>');
                if let Some(cell) = row.children.get(c) {
                    self.inlines(&cell.children, out);
                }
                out.push_str(&format!("</{cell_tag}>"));
            }
            out.push_str("\n</tr>");
            if r == 0 {
                out.push_str("\n</thead>");
            }
        }
        if node.children.len() > 1 {
            out.push_str("\n</tbody>");
        }
        out.push_str("\n</table>");
    }

    fn inlines(&mut self, nodes: &'a [Node], out: &mut String) {
        for (i, n) in nodes.iter().enumerate() {
            // The space before a hidden ` ^block-id` goes with it.
            if let Kind::Text(t) = &n.kind {
                if matches!(nodes.get(i + 1).map(|x| &x.kind), Some(Kind::BlockId(_))) {
                    escape_text(t.trim_end_matches([' ', '\t']), out);
                    continue;
                }
            }
            self.inline(n, out);
        }
    }

    fn internal_link(&mut self, href: &str, children: Option<&'a [Node]>, text: &str, out: &mut String) {
        let h = attr(href);
        out.push_str(&format!(
            "<a data-href=\"{h}\" href=\"{h}\" class=\"internal-link\" target=\"_blank\" rel=\"noopener nofollow\">"
        ));
        match children {
            Some(c) => self.inlines(c, out),
            None => escape_text(text, out),
        }
        out.push_str("</a>");
    }

    fn external_link(&mut self, url: &str, children: &'a [Node], out: &mut String) {
        out.push_str(&format!(
            "<a href=\"{}\" class=\"external-link\" target=\"_blank\" rel=\"noopener nofollow\">",
            attr(url)
        ));
        self.inlines(children, out);
        out.push_str("</a>");
    }

    fn embed(&mut self, href: &str, alt: &str, out: &mut String) {
        out.push_str(&format!(
            "<span class=\"internal-embed\" src=\"{}\" alt=\"{}\" tabindex=\"-1\"></span>",
            attr(href),
            attr(alt)
        ));
    }

    fn image(&mut self, url: &str, alt: Option<&str>, out: &mut String) {
        let alt = alt.unwrap_or("");
        let (text, size) = match alt.rfind('|') {
            Some(i) => match parse_size(&alt[i + 1..]) {
                Some(s) => (&alt[..i], Some(s)),
                None => (alt, None),
            },
            None => match parse_size(alt) {
                Some(s) => ("", Some(s)),
                None => (alt, None),
            },
        };
        out.push_str(&format!("<img src=\"{}\" alt=\"{}\"", attr(url), attr(text)));
        if let Some((w, h)) = size {
            out.push_str(&format!(" width=\"{w}\""));
            if let Some(h) = h {
                out.push_str(&format!(" height=\"{h}\""));
            }
        }
        out.push_str(" referrerpolicy=\"no-referrer\">");
    }

    fn note_ref(&mut self, key: String, note: Note<'a>, out: &mut String) {
        let index = match self.note_index.get(&key) {
            Some(&i) => i,
            None => {
                self.notes.push((note, 0));
                self.note_index.insert(key, self.notes.len() - 1);
                self.notes.len() - 1
            }
        };
        let n = index + 1;
        let count = self.notes[index].1;
        self.notes[index].1 += 1;
        let label = if count > 0 { format!("{n}-{count}") } else { n.to_string() };
        out.push_str(&format!(
            "<sup data-footnote-id=\"fnref-{label}\" class=\"footnote-ref\" id=\"fnref-{label}\"><a href=\"#fn-{n}\" class=\"footnote-link\" target=\"_blank\" rel=\"noopener nofollow\">{n}</a></sup>"
        ));
    }

    fn inline(&mut self, node: &'a Node, out: &mut String) {
        match &node.kind {
            Kind::Text(t) => escape_text(t, out),
            Kind::Emphasis => self.wrap_inline("em", node, out),
            Kind::Strong => self.wrap_inline("strong", node, out),
            Kind::Delete => self.wrap_inline("del", node, out),
            Kind::Mark => self.wrap_inline("mark", node, out),
            Kind::InlineCode(v) => {
                out.push_str("<code>");
                escape_text(v, out);
                out.push_str("</code>");
            }
            Kind::Break => out.push_str("<br>\n"),
            Kind::Html(v) => out.push_str(v),
            Kind::Comment | Kind::BlockId(_) => {}
            Kind::Tag(t) => {
                let a = attr(t);
                out.push_str(&format!("<a href=\"{a}\" class=\"tag\" target=\"_blank\" rel=\"noopener nofollow\">"));
                escape_text(t, out);
                out.push_str("</a>");
            }
            Kind::InlineMath { value, block } => {
                out.push_str(if *block { "<span class=\"math math-block\">" } else { "<span class=\"math math-inline\">" });
                escape_text(value, out);
                out.push_str("</span>");
            }
            Kind::ILink { href, title, converted } => {
                if *converted {
                    self.internal_link(href, Some(&node.children), "", out)
                } else {
                    self.internal_link(href, None, title, out)
                }
            }
            Kind::IEmbed { href, title, alt, .. } => {
                let alt = alt.clone().unwrap_or_else(|| title.clone());
                self.embed(href, &alt, out)
            }
            Kind::Link { url, .. } => self.external_link(url, &node.children, out),
            Kind::Image { url, alt, .. } => self.image(url, alt.as_deref(), out),
            Kind::LinkReference { identifier, label, kind } => match self.definitions.get(identifier).copied() {
                Some((url, _)) if crate::linktext::is_local(url) && !url.is_empty() => {
                    let decoded = crate::util::decode_uri(url).unwrap_or_else(|_| url.to_string());
                    self.internal_link(&crate::linktext::normalize_href(&decoded), Some(&node.children), "", out)
                }
                Some((url, _)) => self.external_link(url, &node.children, out),
                None => {
                    out.push('[');
                    self.inlines(&node.children, out);
                    out.push(']');
                    match kind {
                        crate::mdast::RefKind::Full => {
                            out.push('[');
                            escape_text(label, out);
                            out.push(']');
                        }
                        crate::mdast::RefKind::Collapsed => out.push_str("[]"),
                        crate::mdast::RefKind::Shortcut => {}
                    }
                }
            },
            Kind::ImageReference { identifier, label, kind, alt } => {
                match self.definitions.get(identifier).copied() {
                    Some((url, _)) if crate::linktext::is_local(url) && !url.is_empty() => {
                        let decoded = crate::util::decode_uri(url).unwrap_or_else(|_| url.to_string());
                        let href = crate::linktext::normalize_href(&decoded);
                        self.embed(&href, alt.as_deref().unwrap_or(""), out)
                    }
                    Some((url, _)) => self.image(url, alt.as_deref(), out),
                    None => {
                        out.push_str("![");
                        escape_text(alt.as_deref().unwrap_or(""), out);
                        out.push(']');
                        if *kind == crate::mdast::RefKind::Full {
                            out.push('[');
                            escape_text(label, out);
                            out.push(']');
                        } else if *kind == crate::mdast::RefKind::Collapsed {
                            out.push_str("[]");
                        }
                    }
                }
            }
            Kind::FootnoteReference { identifier, label } => match self.footnote_defs.get(identifier).copied() {
                Some(def) => self.note_ref(format!(":{identifier}"), Note::Def(def), out),
                None => {
                    out.push_str("[^");
                    escape_text(label, out);
                    out.push(']');
                }
            },
            Kind::Footnote => {
                let key = format!("inline:{:p}", node as *const Node);
                self.note_ref(key, Note::Inline(node), out)
            }
            _ => {
                if is_block(node) {
                    self.block(node, out);
                } else {
                    self.inlines(&node.children, out);
                }
            }
        }
    }

    fn wrap_inline(&mut self, tag: &str, node: &'a Node, out: &mut String) {
        out.push_str(&format!("<{tag}>"));
        self.inlines(&node.children, out);
        out.push_str(&format!("</{tag}>"));
    }

    /// The final `footnotes` section. Rendering a definition can reference
    /// further footnotes, which are appended and rendered in turn.
    fn footnotes(&mut self) -> Option<String> {
        if self.notes.is_empty() {
            return None;
        }
        let mut items = Vec::new();
        let mut i = 0;
        let mut bodies: Vec<String> = Vec::new();
        while i < self.notes.len() {
            let mut body = String::new();
            match self.notes[i].0 {
                Note::Def(def) => {
                    let children = &def.children;
                    if children.len() == 1 && matches!(children[0].kind, Kind::Paragraph) {
                        self.inlines(&children[0].children, &mut body);
                    } else {
                        self.blocks(children, &mut body);
                    }
                }
                Note::Inline(node) => self.inlines(&node.children, &mut body),
            }
            bodies.push(body);
            i += 1;
        }
        // Back links are added last: references inside footnotes count too.
        for (k, body) in bodies.into_iter().enumerate() {
            let n = k + 1;
            let mut li = format!("<li data-footnote-id=\"fn-{n}\" id=\"fn-{n}\">");
            let mut backs = String::new();
            for c in 0..self.notes[k].1 {
                let label = if c > 0 { format!("{n}-{c}") } else { n.to_string() };
                backs.push_str(&format!(" <a href=\"#fnref-{label}\" class=\"footnote-backref footnote-link\">↩︎</a>"));
            }
            match body.strip_suffix("</p>") {
                Some(head) => {
                    li.push_str(head);
                    li.push_str(&backs);
                    li.push_str("</p>");
                }
                None => {
                    li.push_str(&body);
                    li.push_str(&backs);
                }
            }
            li.push_str("</li>");
            items.push(li);
        }
        Some(format!("<section class=\"footnotes\"><hr><ol>{}</ol></section>", items.join("")))
    }
}

fn is_block(node: &Node) -> bool {
    matches!(
        node.kind,
        Kind::Paragraph
            | Kind::Heading { .. }
            | Kind::ThematicBreak
            | Kind::Blockquote { .. }
            | Kind::Callout(_)
            | Kind::List { .. }
            | Kind::Table { .. }
            | Kind::Code { .. }
            | Kind::Math(_)
            | Kind::Definition { .. }
            | Kind::FootnoteDefinition { .. }
    )
}

/// `data-heading`: the heading's text as written, without a trailing
/// `^block-id` (hidden in the heading itself too).
fn heading_attr_text(node: &Node) -> String {
    let mut s = String::new();
    for c in &node.children {
        match &c.kind {
            Kind::BlockId(_) | Kind::Comment => {}
            _ => s.push_str(&crate::metadata::node_text(c)),
        }
    }
    s.trim().to_string()
}
