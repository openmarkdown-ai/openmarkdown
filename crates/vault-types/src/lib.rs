//! The data shapes every other crate agrees on.
//!
//! These mirror `obsidian.d.ts` field for field, because the JSON they
//! serialise to is handed straight to community plugins through
//! `app.metadataCache.getFileCache()`. A renamed field here is a broken plugin
//! somewhere else, with no error at either end.
//!
//! **Every `offset` and `col` is in UTF-16 code units**, not bytes and not
//! chars. Plugins feed these numbers to `editor.offsetToPos()` and
//! `String.prototype.slice`, which count UTF-16. A note with one emoji before a
//! link is enough to make byte offsets point at the wrong text. Convert at the
//! edge with [`LineIndex`]; never store a byte offset in these structs.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default, Hash)]
pub struct Loc {
    pub line: u32,
    pub col: u32,
    pub offset: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default, Hash)]
pub struct Pos {
    pub start: Loc,
    pub end: Loc,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkCache {
    pub link: String,
    pub original: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_text: Option<String>,
    pub position: Pos,
}

pub type EmbedCache = LinkCache;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct TagCache {
    /// Includes the leading `#`, as Obsidian reports it.
    pub tag: String,
    pub position: Pos,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct HeadingCache {
    pub heading: String,
    pub level: u8,
    pub position: Pos,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct SectionCache {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<String>,
    /// blockquote | callout | code | element | footnoteDefinition | heading |
    /// html | list | paragraph | table | text | thematicBreak | yaml | math | comment
    #[serde(rename = "type")]
    pub kind: String,
    pub position: Pos,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct ListItemCache {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<String>,
    /// The character inside `[ ]` for a task (`" "`, `"x"`, `"-"`, …); absent
    /// for a plain list item.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub task: Option<String>,
    /// Line of the parent list item, or the negated first line of the list
    /// for a top-level item — the convention `obsidian.d.ts` documents.
    pub parent: i64,
    pub position: Pos,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct BlockCache {
    pub id: String,
    pub position: Pos,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct FootnoteCache {
    pub id: String,
    pub position: Pos,
}

pub type FootnoteRefCache = FootnoteCache;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct ReferenceLinkCache {
    pub id: String,
    pub link: String,
    pub position: Pos,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterLinkCache {
    pub key: String,
    pub link: String,
    pub original: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_text: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CachedMetadata {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub links: Option<Vec<LinkCache>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub embeds: Option<Vec<EmbedCache>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tags: Option<Vec<TagCache>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub headings: Option<Vec<HeadingCache>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub footnotes: Option<Vec<FootnoteCache>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub footnote_refs: Option<Vec<FootnoteRefCache>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reference_links: Option<Vec<ReferenceLinkCache>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sections: Option<Vec<SectionCache>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub list_items: Option<Vec<ListItemCache>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frontmatter: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frontmatter_position: Option<Pos>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frontmatter_links: Option<Vec<FrontmatterLinkCache>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub blocks: Option<BTreeMap<String, BlockCache>>,
}

/// `[start, end)` in UTF-16 code units, as `SearchMatchPart` in the API.
pub type SearchMatchPart = [u32; 2];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct SearchResult {
    pub score: f64,
    pub matches: Vec<SearchMatchPart>,
}

/// Byte offset ⇄ (line, UTF-16 col, UTF-16 offset) for one source text.
///
/// Built once per parse; every position a parser emits goes through
/// [`LineIndex::loc`] so no crate has to remember the UTF-16 rule.
#[derive(Debug, Clone)]
pub struct LineIndex {
    /// Byte offset at which each line starts.
    line_starts: Vec<usize>,
    /// UTF-16 offset at which each line starts.
    line_starts_u16: Vec<u32>,
    ascii: bool,
    text_len: usize,
}

impl LineIndex {
    pub fn new(text: &str) -> Self {
        let mut line_starts = vec![0];
        let mut line_starts_u16 = vec![0];
        let mut u16 = 0u32;
        for (i, ch) in text.char_indices() {
            u16 += ch.len_utf16() as u32;
            if ch == '\n' {
                line_starts.push(i + 1);
                line_starts_u16.push(u16);
            }
        }
        LineIndex {
            line_starts,
            line_starts_u16,
            ascii: text.is_ascii(),
            text_len: text.len(),
        }
    }

    /// Number of lines (a trailing newline starts one more, empty, line).
    pub fn line_count(&self) -> usize {
        self.line_starts.len()
    }

    /// Line containing byte offset `byte` (clamped to the text).
    pub fn line_of(&self, byte: usize) -> usize {
        let byte = byte.min(self.text_len);
        match self.line_starts.binary_search(&byte) {
            Ok(l) => l,
            Err(l) => l - 1,
        }
    }

    /// Byte offset where line `line` starts.
    pub fn line_start(&self, line: usize) -> usize {
        self.line_starts[line.min(self.line_starts.len() - 1)]
    }

    /// Byte offset of the end of line `line`, excluding the newline.
    pub fn line_end(&self, text: &str, line: usize) -> usize {
        if line + 1 < self.line_starts.len() {
            let e = self.line_starts[line + 1] - 1;
            if e > 0 && text.as_bytes().get(e - 1) == Some(&b'\r') {
                e - 1
            } else {
                e
            }
        } else {
            self.text_len
        }
    }

    /// Convert a byte offset into an API location. `text` must be the text
    /// this index was built from.
    pub fn loc(&self, text: &str, byte: usize) -> Loc {
        let byte = byte.min(self.text_len);
        let line = self.line_of(byte);
        let start = self.line_starts[line];
        let col = if self.ascii {
            (byte - start) as u32
        } else {
            text[start..byte].chars().map(|c| c.len_utf16() as u32).sum()
        };
        Loc {
            line: line as u32,
            col,
            offset: self.line_starts_u16[line] + col,
        }
    }

    pub fn pos(&self, text: &str, start: usize, end: usize) -> Pos {
        Pos {
            start: self.loc(text, start),
            end: self.loc(text, end),
        }
    }

    /// Convert a UTF-16 offset back to a byte offset.
    pub fn byte_of_u16(&self, text: &str, u16_offset: u32) -> usize {
        let line = match self.line_starts_u16.binary_search(&u16_offset) {
            Ok(l) => l,
            Err(l) => l - 1,
        };
        let mut remaining = u16_offset - self.line_starts_u16[line];
        let start = self.line_starts[line];
        if self.ascii {
            return (start + remaining as usize).min(self.text_len);
        }
        for (i, ch) in text[start..].char_indices() {
            if remaining == 0 {
                return start + i;
            }
            remaining = remaining.saturating_sub(ch.len_utf16() as u32);
        }
        self.text_len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets_count_surrogate_pairs() {
        let text = "a😀b\n[[x]]";
        let idx = LineIndex::new(text);
        let b = text.find('b').unwrap();
        assert_eq!(idx.loc(text, b), Loc { line: 0, col: 3, offset: 3 });
        let x = text.find("[[").unwrap();
        assert_eq!(idx.loc(text, x), Loc { line: 1, col: 0, offset: 5 });
        assert_eq!(idx.byte_of_u16(text, 5), x);
        assert_eq!(idx.byte_of_u16(text, 3), b);
    }

    #[test]
    fn metadata_serialises_with_api_field_names() {
        let meta = CachedMetadata {
            list_items: Some(vec![ListItemCache {
                id: None,
                task: Some(" ".into()),
                parent: -3,
                position: Pos::default(),
            }]),
            ..Default::default()
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"listItems\""), "{json}");
        assert!(!json.contains("links"), "{json}");
    }
}
