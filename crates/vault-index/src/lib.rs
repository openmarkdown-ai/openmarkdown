//! The vault index: link resolution, backlinks, tags, the search query
//! language, fuzzy matching, and the link graph with its force layout.
//!
//! Everything here reproduces the behaviour of Obsidian 1.13 closely enough
//! that plugins and users see the same answers: `getFirstLinkpathDest`,
//! `resolvedLinks`, `getTags`, `fileToLinktext`, automatic link updates on
//! rename, the Search plugin's query language and result counts,
//! `prepareFuzzySearch`/`prepareSimpleSearch`, and the graph view's node
//! selection and forces. Each module's documentation lists the rules, taken
//! from the app's own code, including the surprising ones.
//!
//! No I/O: the caller hands in file entries, note text and the
//! `CachedMetadata` `vault-ofm` produced, and gets values back. Every offset
//! that leaves this crate is in UTF-16 code units.
//!
//! ```
//! use vault_index::{VaultIndex, FileEntry, LinkFormat};
//! let mut index = VaultIndex::new();
//! index.upsert_file(FileEntry { path: "people/Ada.md".into(), ..Default::default() });
//! index.upsert_file(FileEntry { path: "Journal.md".into(), ..Default::default() });
//! assert_eq!(index.resolve_link("ada#Early life", "Journal.md").as_deref(), Some("people/Ada.md"));
//! assert_eq!(index.linktext("people/Ada.md", "Journal.md", LinkFormat::Shortest), "Ada");
//! ```

pub mod fuzzy;
pub mod graph;
pub mod index;
pub mod layout;
pub mod rename;
pub mod resolve;
pub mod search;
pub mod tags;
pub mod util;

#[cfg(test)]
mod testkit;
#[cfg(test)]
mod tests;

pub use graph::{ColorGroup, GraphData, GraphLink, GraphNode, GraphOptions, NodeKind};
pub use index::{
    Backlink, BacklinkRef, ContentMatch, LinkCounts, Mention, Note, RefKind, Snippet, VaultIndex,
};
pub use layout::{ForceLayout, ForceParams};
pub use rename::{apply_edits, FileEdit, RenameOptions, TextEdit};
pub use resolve::{FileEntry, FileTable, LinkFormat};
pub use search::{
    explain, parse_query, Explanation, FileResult, PropertyHit, Query, SearchOptions, SearchOutput,
    SortOrder,
};
pub use vault_types::SearchResult;
