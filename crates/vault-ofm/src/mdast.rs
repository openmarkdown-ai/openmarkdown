//! The syntax tree: mdast as remark-parse 8 builds it, plus node types for
//! the Obsidian syntax (wikilinks, embeds, tags, callouts, comments …).
//!
//! Positions keep remark's conventions (1-based line and column) so the port
//! of each tokenizer can do the same arithmetic the original does. Columns
//! count bytes of the line-ending-normalised text; `offset` is a byte offset
//! into the *original* text, because that is what `toOffset` computes in
//! JavaScript (it indexes the un-normalised file). Conversion to the UTF-16
//! `Loc` the API uses happens once, in `metadata`.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Point {
    pub line: u32,
    pub column: u32,
    pub offset: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Position {
    pub start: Point,
    pub end: Point,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Align {
    None,
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RefKind {
    Shortcut,
    Collapsed,
    Full,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CalloutInfo {
    /// Lower-cased, inner whitespace runs turned into `-`.
    pub kind: String,
    /// `+`, `-` or empty.
    pub fold: String,
    /// The text after `|` in `[!type|metadata]`.
    pub metadata: String,
}

/// Some fields (a code block's meta string, link and image titles, embed
/// sizes) are parsed for completeness of the tree but not yet rendered.
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub(crate) enum Kind {
    Root,
    Paragraph,
    Heading { depth: u8 },
    ThematicBreak,
    Blockquote { callout: Option<CalloutInfo> },
    Callout(CalloutInfo),
    CalloutTitle,
    CalloutContent,
    List { ordered: bool, start: Option<u64>, spread: bool },
    ListItem {
        spread: bool,
        /// The character between `[` and `]` for a task.
        checklist: Option<String>,
    },
    Table { align: Vec<Align> },
    TableRow,
    TableCell,
    Html(String),
    Code { lang: Option<String>, meta: Option<String>, value: String },
    Math(String),
    Comment,
    Yaml(String),
    Definition { identifier: String, label: String, url: String, title: Option<String> },
    FootnoteDefinition { identifier: String, label: String },
    BlockId(String),
    Text(String),
    Emphasis,
    Strong,
    Delete,
    Mark,
    InlineCode(String),
    Break,
    Link { url: String, title: Option<String> },
    Image { url: String, title: Option<String>, alt: Option<String>, width: Option<String>, height: Option<String> },
    LinkReference { identifier: String, label: String, kind: RefKind },
    ImageReference { identifier: String, label: String, kind: RefKind, alt: Option<String> },
    /// `[[wikilink]]` (`title` is its display text), or a local markdown link
    /// after conversion (`converted`, display text is the link's children).
    ILink { href: String, title: String, converted: bool },
    /// `![[embed]]` or a local markdown image. `title` is the display text,
    /// `alt` the alias or alt text with any `|WxH` size removed.
    IEmbed { href: String, title: String, alt: Option<String>, width: Option<String>, height: Option<String> },
    Tag(String),
    InlineMath { value: String, block: bool },
    /// `^[inline footnote]`; the children are its content.
    Footnote,
    FootnoteReference { identifier: String, label: String },
}

#[derive(Clone, Debug)]
pub(crate) struct Node {
    pub kind: Kind,
    pub pos: Position,
    pub children: Vec<Node>,
    /// A `^block-id` that belongs to this node.
    pub id: Option<String>,
}

impl Node {
    pub fn new(kind: Kind, pos: Position) -> Node {
        Node { kind, pos, children: Vec::new(), id: None }
    }

    pub fn with_children(kind: Kind, pos: Position, children: Vec<Node>) -> Node {
        Node { kind, pos, children, id: None }
    }

    /// The mdast `type` string, which is also the section type Obsidian reports.
    pub fn type_name(&self) -> &'static str {
        match &self.kind {
            Kind::Root => "root",
            Kind::Paragraph => "paragraph",
            Kind::Heading { .. } => "heading",
            Kind::ThematicBreak => "thematicBreak",
            Kind::Blockquote { .. } => "blockquote",
            Kind::Callout(_) => "callout",
            Kind::CalloutTitle => "callout-title",
            Kind::CalloutContent => "callout-content",
            Kind::List { .. } => "list",
            Kind::ListItem { .. } => "listItem",
            Kind::Table { .. } => "table",
            Kind::TableRow => "tableRow",
            Kind::TableCell => "tableCell",
            Kind::Html(_) => "html",
            Kind::Code { .. } => "code",
            Kind::Math(_) => "math",
            Kind::Comment => "comment",
            Kind::Yaml(_) => "yaml",
            Kind::Definition { .. } => "definition",
            Kind::FootnoteDefinition { .. } => "footnoteDefinition",
            Kind::BlockId(_) => "blockid",
            Kind::Text(_) => "text",
            Kind::Emphasis => "emphasis",
            Kind::Strong => "strong",
            Kind::Delete => "delete",
            Kind::Mark => "mark",
            Kind::InlineCode(_) => "inlineCode",
            Kind::Break => "break",
            Kind::Link { .. } => "link",
            Kind::Image { .. } => "image",
            Kind::LinkReference { .. } => "linkReference",
            Kind::ImageReference { .. } => "imageReference",
            Kind::ILink { .. } => "ilink",
            Kind::IEmbed { .. } => "iembed",
            Kind::Tag(_) => "tag",
            Kind::InlineMath { .. } => "inlineMath",
            Kind::Footnote => "footnote",
            Kind::FootnoteReference { .. } => "footnoteReference",
        }
    }
}
