//! Obsidian Flavored Markdown: the metadata Obsidian's `metadataCache` keeps
//! for a note, and the HTML its reading view renders, one section per block.
//!
//! # Why a hand-written parser, not pulldown-cmark
//!
//! Plugins read `CachedMetadata` positions and feed them straight back into
//! the editor, and they read `SectionCache` boundaries to decide what a
//! post-processor's element covers. Those numbers are defined by how the
//! parser splits blocks — where a list ends, whether a lazy line continues a
//! quote, whether `1)` starts a list — and a CommonMark-exact parser such as
//! pulldown-cmark splits some of them differently from the remark-based
//! parsing that the API's own section type names (`thematicBreak`,
//! `footnoteDefinition`, `yaml`, `element`, `text`, from obsidian.d.ts) come
//! from. It also has no hook for wikilinks inside table cells, `%%` comments
//! that swallow markup, or tags that must not start inside a word.
//!
//! So this crate ports remark-parse 8 (MIT) — its tokenizer engine, block and
//! inline tokenizers, in `commonmark` + `gfm` mode — together with
//! `remark-math` 3 and `remark-footnotes` 2 (MIT), and adds the Obsidian
//! syntax described in the help vault (Obsidian Flavored Markdown.md, Internal
//! links.md, Embed files.md, Callouts.md, Tags.md, Properties.md) as further
//! tokenizers. It is pure Rust with no dependencies beyond serde.
//!
//! # Pipeline
//!
//! `tokenizer` builds an mdast-shaped tree (`mdast`) from the text,
//! `transform` rewrites local markdown links into internal ones, attaches
//! block ids and builds callouts, and then `metadata` or `render` walk it.
//! Every position is converted to UTF-16 through `vault_types::LineIndex` at
//! the very end. `\r\n` and `\r` are treated as line breaks throughout, but
//! offsets always index the original text.

mod block;
mod entities;
mod frontmatter;
mod inline;
mod linktext;
mod mdast;
mod metadata;
mod render;
mod tokenizer;
mod transform;
mod util;
mod wordcount;
mod yaml;

pub use frontmatter::{parse_frontmatter, Frontmatter};
pub use linktext::{display_text, get_linkpath, parse_linktext, strip_heading, strip_heading_for_link};
pub use metadata::{resolve_subpath, SubpathResult};
pub use render::{render, RenderOptions, Rendered, RenderedSection};
pub use wordcount::{word_count, WordCount};
pub use yaml::YamlError;

use vault_types::CachedMetadata;

/// The `CachedMetadata` of a note.
pub fn parse(text: &str) -> CachedMetadata {
    let mut root = tokenizer::parse_tree(text, true);
    transform::apply(&mut root);
    metadata::collect(&root, text)
}

/// `parseYaml`: YAML 1.2 core schema, as JSON.
pub fn yaml_parse(src: &str) -> Result<serde_json::Value, String> {
    yaml::parse(src).map_err(|e| e.to_string())
}

/// `stringifyYaml`: block style, quoting only where needed.
pub fn yaml_stringify(v: &serde_json::Value) -> String {
    yaml::stringify(v)
}

#[cfg(test)]
mod tests;
