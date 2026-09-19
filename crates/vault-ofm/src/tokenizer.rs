//! The tokenizer engine of remark-parse 8 (MIT), ported to Rust.
//!
//! Every construct is a function that looks at the not-yet-eaten text and
//! either returns without eating, or "eats" a prefix and adds a node. The
//! engine tries the constructs in a fixed precedence order and restarts from
//! the top after each eat. Container blocks (quotes, list items, footnote
//! definitions) strip their prefixes, record how many columns each line lost
//! in `Parser::offset`, and tokenize the stripped text recursively; the offset
//! table is how nested positions find their way back to real columns.
//!
//! The Obsidian constructs are registered the way remark plugins register
//! theirs: block math after fenced code (as `remark-math` does), footnotes
//! before definitions and references (as `remark-footnotes` does), wikilinks
//! before links so `[[a]]` never becomes a shortcut reference.

use crate::block;
use crate::entities;
use crate::inline;
use crate::mdast::{Kind, Node, Point, Position};

pub(crate) struct Parser {
    /// A single newline in a paragraph is a hard break (Obsidian's default,
    /// "Strict line breaks" off), as `remark-breaks` does it.
    pub breaks: bool,
    /// Columns removed from each line by enclosing containers (index = line).
    offset: Vec<u32>,
    pub in_list: bool,
    pub in_block: bool,
    pub in_link: bool,
    /// Autolinks and bare URLs tokenize their content with nothing but text.
    pub text_only: bool,
    /// Byte offset of each line start in the original text (index = line - 1).
    line_starts: Vec<usize>,
    orig_len: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Block {
    BlankLine,
    IndentedCode,
    FencedCode,
    Math,
    Comment,
    Blockquote,
    AtxHeading,
    ThematicBreak,
    List,
    SetextHeading,
    Html,
    FootnoteDefinition,
    Definition,
    Table,
    BlockId,
    Paragraph,
}

pub(crate) const BLOCK_METHODS: [Block; 16] = [
    Block::BlankLine,
    Block::IndentedCode,
    Block::FencedCode,
    Block::Math,
    Block::Comment,
    Block::Blockquote,
    Block::AtxHeading,
    Block::ThematicBreak,
    Block::List,
    Block::SetextHeading,
    Block::Html,
    Block::FootnoteDefinition,
    Block::Definition,
    Block::Table,
    Block::BlockId,
    Block::Paragraph,
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Inline {
    Comment,
    Escape,
    AutoLink,
    Url,
    Email,
    Html,
    Wikilink,
    Link,
    InlineNote,
    FootnoteCall,
    Reference,
    Strong,
    Emphasis,
    Deletion,
    Code,
    Break,
    Mark,
    Tag,
    Math,
    BlockId,
    Text,
}

/// `%%` comes first: nothing inside a comment is markup.
pub(crate) const INLINE_METHODS: [Inline; 21] = [
    Inline::Comment,
    Inline::Escape,
    Inline::AutoLink,
    Inline::Url,
    Inline::Email,
    Inline::Html,
    Inline::Wikilink,
    Inline::Link,
    Inline::InlineNote,
    Inline::FootnoteCall,
    Inline::Reference,
    Inline::Strong,
    Inline::Emphasis,
    Inline::Deletion,
    Inline::Code,
    Inline::Break,
    Inline::Mark,
    Inline::Tag,
    Inline::Math,
    Inline::BlockId,
    Inline::Text,
];

// remark's interrupt lists, already filtered for `commonmark: true,
// pedantic: false`, with math (after fenced code, as `remark-math` inserts
// it) and comments added.
pub(crate) const INTERRUPT_PARAGRAPH: [Block; 8] = [
    Block::ThematicBreak,
    Block::List,
    Block::AtxHeading,
    Block::FencedCode,
    Block::Math,
    Block::Comment,
    Block::Blockquote,
    Block::Html,
];
pub(crate) const INTERRUPT_LIST: [Block; 5] =
    [Block::AtxHeading, Block::FencedCode, Block::Math, Block::Comment, Block::ThematicBreak];
pub(crate) const INTERRUPT_BLOCKQUOTE: [Block; 9] = [
    Block::IndentedCode,
    Block::FencedCode,
    Block::Math,
    Block::Comment,
    Block::AtxHeading,
    Block::SetextHeading,
    Block::ThematicBreak,
    Block::Html,
    Block::List,
];
/// `remark-footnotes` builds this from the block list: everything except
/// indented code, paragraphs and itself, then itself last.
pub(crate) const INTERRUPT_FOOTNOTE: [Block; 12] = [
    Block::BlankLine,
    Block::FencedCode,
    Block::Math,
    Block::Blockquote,
    Block::AtxHeading,
    Block::ThematicBreak,
    Block::List,
    Block::SetextHeading,
    Block::Html,
    Block::Definition,
    Block::Table,
    Block::FootnoteDefinition,
];

pub(crate) struct Frame<'s> {
    pub src: &'s str,
    pub idx: usize,
    pub line: u32,
    pub column: u32,
    pub tokens: Vec<Node>,
    /// Locator searches over `src`, remembered across text nodes.
    pub finder: inline::Finder<'s>,
}

impl<'s> Frame<'s> {
    pub fn new(src: &'s str, line: u32, column: u32) -> Frame<'s> {
        Frame { src, idx: 0, line, column, tokens: Vec::new(), finder: inline::Finder::new(src) }
    }
}

impl<'s> Frame<'s> {
    pub fn rest(&self) -> &'s str {
        &self.src[self.idx..]
    }

    pub fn now(&self, p: &Parser) -> Point {
        Point { line: self.line, column: self.column, offset: p.to_offset(self.line, self.column) }
    }

    fn update_position(&mut self, p: &Parser, sub: &str) {
        let bytes = sub.as_bytes();
        let mut last = None;
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' {
                self.line += 1;
                last = Some(i);
            }
        }
        match last {
            None => self.column += bytes.len() as u32,
            Some(l) => self.column = (bytes.len() - l) as u32,
        }
        let off = p.offset_of(self.line);
        if off > 0 {
            if last.is_some() {
                self.column += off;
            } else if self.column <= off {
                self.column = off + 1;
            }
        }
    }

    /// Eat `len` bytes and return the position they span.
    pub fn eat(&mut self, p: &mut Parser, len: usize) -> Position {
        let start = self.now(p);
        let sub = &self.src[self.idx..self.idx + len];
        self.idx += len;
        self.update_position(p, sub);
        Position { start, end: self.now(p) }
    }

    /// `eat(x).reset(node)`: the node gets the span, but the text is put back
    /// so its pieces can be eaten one by one.
    pub fn eat_reset(&mut self, p: &mut Parser, len: usize) -> Position {
        let (idx, line, column) = (self.idx, self.line, self.column);
        let pos = self.eat(p, len);
        self.idx = idx;
        self.line = line;
        self.column = column;
        pos
    }

    /// Add a node, merging it into a preceding text node when both occupy
    /// exactly their own value (so an entity never merges).
    pub fn add(&mut self, node: Node) {
        if let Kind::Text(v) = &node.kind {
            if mergeable(&node, v) {
                if let Some(prev) = self.tokens.last_mut() {
                    if let Kind::Text(pv) = &prev.kind {
                        if mergeable(prev, pv) {
                            let end = node.pos.end;
                            if let Kind::Text(pv) = &mut prev.kind {
                                pv.push_str(v);
                            }
                            prev.pos.end = end;
                            return;
                        }
                    }
                }
            }
        }
        self.tokens.push(node);
    }
}

fn mergeable(node: &Node, value: &str) -> bool {
    let (s, e) = (node.pos.start, node.pos.end);
    s.line != e.line || (e.column - s.column) as usize == value.len()
}

impl Parser {
    pub fn new(original: &str, breaks: bool) -> Parser {
        let b = original.as_bytes();
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
        Parser {
            breaks,
            offset: vec![0; line_starts.len() + 2],
            in_list: false,
            in_block: false,
            in_link: false,
            text_only: false,
            line_starts,
            orig_len: original.len(),
        }
    }

    pub fn to_offset(&self, line: u32, column: u32) -> usize {
        let l = (line.max(1) - 1) as usize;
        let start = match self.line_starts.get(l) {
            Some(&s) => s,
            None => return self.orig_len,
        };
        (start + column.max(1) as usize - 1).min(self.orig_len)
    }

    pub fn offset_of(&self, line: u32) -> u32 {
        self.offset.get(line as usize).copied().unwrap_or(0)
    }

    pub fn add_offset(&mut self, line: u32, n: usize) {
        let l = line as usize;
        if l >= self.offset.len() {
            self.offset.resize(l + 1, 0);
        }
        self.offset[l] += n as u32;
    }

    pub fn tokenize_block(&mut self, value: &str, loc: Point) -> Vec<Node> {
        self.tokenize(value, loc, true)
    }

    pub fn tokenize_inline(&mut self, value: &str, loc: Point) -> Vec<Node> {
        self.tokenize(value, loc, false)
    }

    fn tokenize(&mut self, value: &str, loc: Point, is_block: bool) -> Vec<Node> {
        if value.is_empty() {
            return Vec::new();
        }
        let mut f = Frame::new(value, loc.line, loc.column);
        f.update_position(self, "");
        while f.idx < value.len() {
            let before = f.idx;
            if is_block {
                for m in BLOCK_METHODS {
                    let v = f.rest();
                    run_block(self, &mut f, m, v, false);
                    if f.idx != before {
                        break;
                    }
                }
            } else {
                for m in INLINE_METHODS {
                    if self.text_only && m != Inline::Text {
                        continue;
                    }
                    if self.in_link && matches!(m, Inline::AutoLink | Inline::Url | Inline::Email) {
                        continue;
                    }
                    let v = f.rest();
                    run_inline(self, &mut f, m, v, false);
                    if f.idx != before {
                        break;
                    }
                }
            }
            if f.idx == before {
                // remark throws "Infinite loop" here. Paragraph and text always
                // eat, so this is unreachable; eat a character rather than hang.
                debug_assert!(false, "no tokenizer ate at {:?}", &value[before..]);
                let n = crate::util::char_len(value, before);
                let pos = f.eat(self, n);
                f.add(Node::new(Kind::Text(value[before..before + n].to_string()), pos));
            }
        }
        f.tokens
    }

    /// `interrupt(list, tokenizers, ctx, [eat, value, true])`.
    pub fn interrupts(&mut self, f: &mut Frame, list: &[Block], value: &str) -> bool {
        for &m in list {
            if run_block(self, f, m, value, true) {
                return true;
            }
        }
        false
    }

    /// The text tokenizer: everything up to the next place another inline
    /// construct could start, with character references decoded.
    pub fn text(&mut self, f: &mut Frame, v: &str) {
        let mut min = v.len();
        // `v` is always the frame's remaining text; locate from its second
        // character, in frame coordinates.
        let from = f.idx + 1;
        if !self.text_only {
            for m in INLINE_METHODS {
                if m == Inline::Text {
                    continue;
                }
                if let Some(at) = inline::locate(m, &mut f.finder, from) {
                    min = min.min(at - f.idx);
                }
            }
        }
        let sub = &v[..min];
        for chunk in entities::chunks(sub, true) {
            match chunk {
                entities::Chunk::Text(t) => {
                    let pos = f.eat(self, t.len());
                    f.add(Node::new(Kind::Text(t.to_string()), pos));
                }
                entities::Chunk::Ref { value, source } => {
                    let pos = f.eat(self, source.len());
                    f.add(Node::new(Kind::Text(value), pos));
                }
            }
        }
    }
}

pub(crate) fn run_block(p: &mut Parser, f: &mut Frame, m: Block, v: &str, silent: bool) -> bool {
    match m {
        Block::BlankLine => block::blank_line(p, f, v, silent),
        Block::IndentedCode => block::indented_code(p, f, v, silent),
        Block::Math => block::math(p, f, v, silent),
        Block::Comment => block::comment(p, f, v, silent),
        Block::FencedCode => block::fenced_code(p, f, v, silent),
        Block::Blockquote => block::blockquote(p, f, v, silent),
        Block::AtxHeading => block::atx_heading(p, f, v, silent),
        Block::ThematicBreak => block::thematic_break(p, f, v, silent),
        Block::List => block::list(p, f, v, silent),
        Block::SetextHeading => block::setext_heading(p, f, v, silent),
        Block::Html => block::html(p, f, v, silent),
        Block::FootnoteDefinition => block::footnote_definition(p, f, v, silent),
        Block::Definition => block::definition(p, f, v, silent),
        Block::Table => block::table(p, f, v, silent),
        Block::BlockId => block::block_id(p, f, v, silent),
        Block::Paragraph => block::paragraph(p, f, v, silent),
    }
}

pub(crate) fn run_inline(p: &mut Parser, f: &mut Frame, m: Inline, v: &str, silent: bool) -> bool {
    match m {
        Inline::Escape => inline::escape(p, f, v, silent),
        Inline::AutoLink => inline::auto_link(p, f, v, silent),
        Inline::Url => inline::url(p, f, v, silent),
        Inline::Email => inline::email(p, f, v, silent),
        Inline::Html => inline::html(p, f, v, silent),
        Inline::Wikilink => inline::wikilink(p, f, v, silent),
        Inline::Link => inline::link(p, f, v, silent),
        Inline::InlineNote => inline::inline_note(p, f, v, silent),
        Inline::FootnoteCall => inline::footnote_call(p, f, v, silent),
        Inline::Reference => inline::reference(p, f, v, silent),
        Inline::Strong => inline::strong(p, f, v, silent),
        Inline::Emphasis => inline::emphasis(p, f, v, silent),
        Inline::Deletion => inline::deletion(p, f, v, silent),
        Inline::Code => inline::code(p, f, v, silent),
        Inline::Break => inline::hard_break(p, f, v, silent),
        Inline::Mark => inline::mark(p, f, v, silent),
        Inline::Tag => inline::tag(p, f, v, silent),
        Inline::Math => inline::math(p, f, v, silent),
        Inline::BlockId => inline::block_id(p, f, v, silent),
        Inline::Comment => inline::comment(p, f, v, silent),
        Inline::Text => {
            if !silent {
                p.text(f, v);
            }
            true
        }
    }
}

/// Parse a whole document into a tree (before the transformers run).
///
/// Frontmatter is recognised here rather than by a tokenizer: it only exists
/// at the very start of the file (after an optional byte-order mark), as a
/// `---` line, the YAML, and a closing `---` line.
pub(crate) fn parse_tree(original: &str, breaks: bool) -> Node {
    let normalized;
    let mut value: &str = if original.contains('\r') {
        normalized = original.replace("\r\n", "\n").replace('\r', "\n");
        &normalized
    } else {
        original
    };
    let mut p = Parser::new(original, breaks);
    let mut f = Frame::new(value, 1, 1);
    if value.starts_with('\u{FEFF}') {
        value = &value[3..];
        f = Frame::new(value, 1, 4);
    }
    let mut children = Vec::new();
    if let Some((yaml, end)) = crate::frontmatter::split(value) {
        let pos = f.eat(&mut p, end);
        children.push(Node::new(Kind::Yaml(yaml.to_string()), pos));
    }
    let rest = &value[f.idx..];
    let start = f.now(&p);
    children.extend(p.tokenize_block(rest, start));
    let end = children.last().map(|c| c.pos.end).unwrap_or(Point { line: 1, column: 1, offset: 0 });
    Node::with_children(Kind::Root, Position { start: Point { line: 1, column: 1, offset: 0 }, end }, children)
}
