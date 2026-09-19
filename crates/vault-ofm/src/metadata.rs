//! `CachedMetadata` from the rewritten tree, and `resolveSubpath`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use vault_types::{
    BlockCache, CachedMetadata, FootnoteCache, HeadingCache, LineIndex, LinkCache, ListItemCache, Loc, Pos,
    ReferenceLinkCache, SectionCache, TagCache,
};

use crate::linktext::strip_heading;
use crate::mdast::{Kind, Node, Point, Position};

/// Converts tree positions (1-based line/column in bytes, byte offsets) into
/// API locations (0-based, UTF-16).
pub(crate) struct Conv<'t> {
    text: &'t str,
    index: LineIndex,
    /// Line starts in the original text, treating `\r\n`, `\r` and `\n` as one
    /// break each — the same line numbering the tokenizer uses.
    line_starts: Vec<usize>,
    /// UTF-16 offset at every `CHECKPOINT` bytes, for non-ASCII text.
    /// `LineIndex::loc` counts from the start of the line, which is
    /// quadratic on a long line full of links (a pasted web page, a table
    /// exported as one line); a checkpoint bounds each count.
    checkpoints: Vec<u32>,
}

const CHECKPOINT: usize = 256;

impl<'t> Conv<'t> {
    pub fn new(text: &'t str) -> Conv<'t> {
        let b = text.as_bytes();
        let mut line_starts = vec![0usize];
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'\r' {
                if b.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                line_starts.push(i + 1);
            } else if b[i] == b'\n' {
                line_starts.push(i + 1);
            }
            i += 1;
        }
        let mut checkpoints = Vec::new();
        if !text.is_ascii() {
            checkpoints.reserve(b.len() / CHECKPOINT + 1);
            let mut units = 0u32;
            for (k, &c) in b.iter().enumerate() {
                if k % CHECKPOINT == 0 {
                    checkpoints.push(units);
                }
                // A UTF-8 lead byte starts a char: 4-byte sequences are two
                // UTF-16 units, every other char one; continuation bytes none.
                units += match c {
                    0x00..=0x7F | 0xC0..=0xEF => 1,
                    0xF0..=0xFF => 2,
                    _ => 0,
                };
            }
        }
        Conv { text, index: LineIndex::new(text), line_starts, checkpoints }
    }

    fn u16_offset(&self, byte: usize) -> u32 {
        let mut b = byte.min(self.text.len());
        while !self.text.is_char_boundary(b) {
            b -= 1;
        }
        if self.checkpoints.is_empty() {
            return self.index.loc(self.text, b).offset;
        }
        let k = b / CHECKPOINT;
        let base = k * CHECKPOINT;
        let mut units = self.checkpoints[k];
        for &c in &self.text.as_bytes()[base..b] {
            units += match c {
                0x00..=0x7F | 0xC0..=0xEF => 1,
                0xF0..=0xFF => 2,
                _ => 0,
            };
        }
        units
    }

    pub fn loc(&self, p: Point) -> Loc {
        let line = p.line.max(1) - 1;
        let start = self.line_starts.get(line as usize).copied().unwrap_or(self.text.len());
        let col_byte = start + (p.column.max(1) as usize - 1);
        let col = self.u16_offset(col_byte) - self.u16_offset(start);
        Loc { line, col, offset: self.u16_offset(p.offset) }
    }

    pub fn pos(&self, p: Position) -> Pos {
        Pos { start: self.loc(p.start), end: self.loc(p.end) }
    }

    /// The original text between two tree points.
    pub fn slice(&self, a: Point, b: Point) -> &'t str {
        crate::util::js_slice(self.text, a.offset, b.offset)
    }
}

/// A heading's text as written: the source from its first to its last inline
/// child, so `## [[Link]] *x*` reports `[[Link]] *x*` (what plugins that list
/// headings, like the outline, show and link to).
pub(crate) fn heading_text(conv: &Conv, node: &Node) -> String {
    // A trailing ` ^block-id` names the heading; it is not part of its text.
    let content: Vec<&Node> = node.children.iter().filter(|c| !matches!(c.kind, Kind::BlockId(_))).collect();
    let (a, b) = match (content.first(), content.last()) {
        (Some(f), Some(l)) => (f.pos.start, l.pos.end),
        _ => return String::new(),
    };
    crate::util::js_trim(conv.slice(a, b)).to_string()
}

/// The plain text of inline content: what a markdown link displays.
pub(crate) fn node_text(node: &Node) -> String {
    match &node.kind {
        Kind::Text(v) | Kind::InlineCode(v) => v.clone(),
        Kind::InlineMath { value, .. } => value.clone(),
        Kind::Tag(t) => t.clone(),
        Kind::IEmbed { href, .. } => href.clone(),
        Kind::ILink { title, converted: false, .. } => title.clone(),
        Kind::Image { alt, .. } => alt.clone().unwrap_or_default(),
        Kind::Break => "\n".into(),
        Kind::Html(_) | Kind::Comment | Kind::BlockId(_) => String::new(),
        _ => node.children.iter().map(node_text).collect(),
    }
}

#[derive(Default)]
struct Collect {
    links: Vec<LinkCache>,
    embeds: Vec<LinkCache>,
    tags: Vec<TagCache>,
    headings: Vec<HeadingCache>,
    footnotes: Vec<FootnoteCache>,
    footnote_refs: Vec<FootnoteCache>,
    reference_links: Vec<ReferenceLinkCache>,
    list_items: Vec<ListItemCache>,
    blocks: BTreeMap<String, BlockCache>,
    inline_notes: usize,
}

/// Build `CachedMetadata` from a transformed tree.
pub(crate) fn collect(root: &Node, text: &str) -> CachedMetadata {
    let conv = Conv::new(text);
    let mut meta = CachedMetadata::default();
    let mut c = Collect::default();
    if let Some(first) = root.children.first() {
        if let Kind::Yaml(value) = &first.kind {
            meta.frontmatter_position = Some(conv.pos(first.pos));
            if let Some(map) = crate::frontmatter::yaml_object(value) {
                let links = crate::frontmatter::frontmatter_links(&map);
                meta.frontmatter_links = (!links.is_empty()).then_some(links);
                meta.frontmatter = Some(map);
            }
        }
    }
    let mut sections = Vec::new();
    for child in &root.children {
        let position = conv.pos(child.pos);
        if let Some(id) = &child.id {
            // Keys are lower-cased: block links match case-insensitively.
            c.blocks.insert(id.to_lowercase(), BlockCache { id: id.clone(), position });
        }
        sections.push(SectionCache { id: child.id.clone(), kind: child.type_name().to_string(), position });
        c.visit(&conv, child, root, None);
    }
    meta.links = (!c.links.is_empty()).then_some(c.links);
    meta.embeds = (!c.embeds.is_empty()).then_some(c.embeds);
    meta.tags = (!c.tags.is_empty()).then_some(c.tags);
    meta.headings = (!c.headings.is_empty()).then_some(c.headings);
    meta.footnotes = (!c.footnotes.is_empty()).then_some(c.footnotes);
    meta.footnote_refs = (!c.footnote_refs.is_empty()).then_some(c.footnote_refs);
    meta.reference_links = (!c.reference_links.is_empty()).then_some(c.reference_links);
    meta.sections = (!sections.is_empty()).then_some(sections);
    meta.list_items = (!c.list_items.is_empty()).then_some(c.list_items);
    meta.blocks = (!c.blocks.is_empty()).then_some(c.blocks);
    meta
}

impl Collect {
    /// `item_parent`: for a list nested in an item, that item's position.
    fn visit(&mut self, conv: &Conv, node: &Node, parent: &Node, item_parent: Option<Position>) {
        match &node.kind {
            Kind::FootnoteReference { label, .. } => {
                self.footnote_refs.push(FootnoteCache { id: label.clone(), position: conv.pos(node.pos) })
            }
            Kind::Footnote => {
                // An inline note is its own definition and reference at once;
                // it has no label, so it is named by its order in the note.
                self.inline_notes += 1;
                let id = format!("inline-{}", self.inline_notes);
                self.footnote_refs.push(FootnoteCache { id: id.clone(), position: conv.pos(node.pos) });
                let content = match (node.children.first(), node.children.last()) {
                    (Some(a), Some(b)) => Position { start: a.pos.start, end: b.pos.end },
                    _ => node.pos,
                };
                self.footnotes.push(FootnoteCache { id, position: conv.pos(content) });
            }
            Kind::FootnoteDefinition { label, .. } => {
                self.footnotes.push(FootnoteCache { id: label.clone(), position: conv.pos(node.pos) })
            }
            Kind::Definition { label, url, .. } => self.reference_links.push(ReferenceLinkCache {
                id: label.clone(),
                link: url.clone(),
                position: conv.pos(node.pos),
            }),
            Kind::Heading { depth } if matches!(parent.kind, Kind::Root) => self.headings.push(HeadingCache {
                heading: heading_text(conv, node),
                level: *depth,
                position: conv.pos(node.pos),
            }),
            Kind::ILink { href, title, converted } => {
                let display = if *converted { node_text(node) } else { title.clone() };
                self.links.push(LinkCache {
                    link: href.clone(),
                    original: conv.slice(node.pos.start, node.pos.end).to_string(),
                    display_text: Some(display),
                    position: conv.pos(node.pos),
                });
            }
            Kind::IEmbed { href, title, .. } => self.embeds.push(LinkCache {
                link: href.clone(),
                original: conv.slice(node.pos.start, node.pos.end).to_string(),
                display_text: Some(title.clone()),
                position: conv.pos(node.pos),
            }),
            Kind::Tag(tag) => self.tags.push(TagCache { tag: tag.clone(), position: conv.pos(node.pos) }),
            Kind::ListItem { checklist, .. } => {
                // The item's own lines: nested lists are items of their own.
                let mut position = conv.pos(node.pos);
                if let Some(last) = node.children.iter().rev().find(|c| !matches!(c.kind, Kind::List { .. })) {
                    position.end = conv.loc(last.pos.end);
                }
                // obsidian.d.ts: the parent item's line, or the negated line
                // of the list's first item for a top-level item. Line 0
                // cannot be negated, so a list starting there reports -1.
                let parent_line = match item_parent {
                    Some(p) => p.start.line as i64 - 1,
                    None => match -(parent.pos.start.line as i64 - 1) {
                        0 => -1,
                        n => n,
                    },
                };
                if let Some(id) = &node.id {
                    self.blocks.insert(id.to_lowercase(), BlockCache { id: id.clone(), position });
                }
                self.list_items.push(ListItemCache {
                    id: node.id.clone(),
                    task: checklist.clone(),
                    parent: parent_line,
                    position,
                });
            }
            _ => {}
        }
        for child in &node.children {
            let pass = match node.kind {
                Kind::ListItem { .. } => Some(node.pos),
                Kind::List { .. } => item_parent,
                _ => None,
            };
            self.visit(conv, child, node, pass);
        }
    }
}

/// Where a link subpath points in a note: `resolveSubpath`'s result.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SubpathResult {
    #[serde(rename = "heading")]
    Heading { current: HeadingCache, next: Option<HeadingCache>, start: Loc, end: Option<Loc> },
    #[serde(rename = "block")]
    Block { block: BlockCache, list: Option<ListItemCache>, start: Loc, end: Option<Loc> },
    #[serde(rename = "footnote")]
    Footnote { footnote: FootnoteCache, start: Loc, end: Option<Loc> },
}

/// `resolveSubpath(cache, subpath)`.
///
/// `#A#B` walks nested headings: each part must match (after `stripHeading`,
/// case-insensitively) a heading deeper than the previous match. The section
/// ends at the next heading of the same or a higher level.
pub fn resolve_subpath(meta: &CachedMetadata, subpath: &str) -> Option<SubpathResult> {
    if subpath.is_empty() {
        return None;
    }
    let parts: Vec<&str> = subpath.split('#').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    if parts.len() == 1 {
        let part = parts[0];
        if let Some(id) = part.strip_prefix('^') {
            let key = id.to_lowercase();
            if let Some(blocks) = &meta.blocks {
                if let Some(block) = blocks.get(&key) {
                    let list = meta
                        .list_items
                        .as_ref()
                        .and_then(|items| {
                            items.iter().find(|i| i.id.as_ref().map(|x| x.to_lowercase() == key).unwrap_or(false))
                        })
                        .cloned();
                    return Some(SubpathResult::Block {
                        block: block.clone(),
                        list,
                        start: block.position.start,
                        end: Some(block.position.end),
                    });
                }
            }
        } else if part.starts_with("[^") {
            let id = crate::util::js_slice(part, 2, part.len().saturating_sub(1));
            for f in meta.footnotes.iter().flatten() {
                if f.id == id {
                    return Some(SubpathResult::Footnote {
                        footnote: f.clone(),
                        start: f.position.start,
                        end: Some(f.position.end),
                    });
                }
            }
        }
    }
    let headings = meta.headings.as_ref().filter(|h| !h.is_empty())?;
    let mut depth = 0usize;
    let mut level = 0u8;
    let mut current: Option<&HeadingCache> = None;
    let mut next: Option<&HeadingCache> = None;
    for h in headings {
        if current.is_some() && h.level <= level {
            next = Some(h);
            break;
        }
        if current.is_none()
            && h.level > level
            && strip_heading(&h.heading).to_lowercase() == strip_heading(parts[depth]).to_lowercase()
        {
            depth += 1;
            level = h.level;
            if depth == parts.len() {
                current = Some(h);
            }
        }
    }
    let current = current?;
    Some(SubpathResult::Heading {
        current: current.clone(),
        next: next.cloned(),
        start: current.position.start,
        end: next.map(|n| n.position.start),
    })
}
