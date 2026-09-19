//! Obsidian's search: the query language, evaluation over the vault, result
//! shapes, sorting and "Explain search term".
//!
//! Behaviour follows the Search core plugin of Obsidian 1.13 (read from the
//! app, cross-checked with help.obsidian.md/Plugins/Search):
//!
//! * Words are matched independently (implicit AND); `OR` (upper case)
//!   alternates; `-x` excludes; `( )` groups. Words are substring matches;
//!   `"quoted phrases"` are exact, and in note content whole-word
//!   (`"cat"` does not match `catalog`). Matching is case-insensitive unless
//!   the "Match case" option or `match-case:` says otherwise.
//! * Plain terms look at a note's file name (with extension) and content, a
//!   canvas or base file's name, and nothing of an attachment. `file:` and
//!   `path:` reach every supported file.
//! * `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:`
//!   require the operand to match within one line / block / heading section /
//!   task item. `section:` nests: `section:(a section:b)` looks for `b` in a
//!   subsection of a section containing `a`.
//! * `tag:x` matches `#x` and its children (`#x/y`) in the body or the
//!   `tags` property, never `#xy`.
//! * `[prop]`, `[prop:value]`: the key is itself a query over property names
//!   (a bare word is a substring of the name, a quoted one the exact name);
//!   the value is a query over each value's string form (each list item
//!   separately), so `[prop:null]` finds empty properties, and `<5` / `>5`
//!   compare with JavaScript semantics.
//! * `/regex/` uses JavaScript syntax, flags `gm` (plus `i` when case
//!   insensitive). The engine is regex-lite: no lookaround or
//!   backreferences (reported as a parse error), ASCII-only case folding and
//!   `\w \d \s \b` classes.

pub mod eval;
pub mod explain;
pub mod lexer;
pub mod parser;

pub use eval::PropertyHit;
pub use explain::{explain, Explanation};
pub use parser::{parse_query, Node, Query};

use crate::index::{content_match, ContentMatch, Note, VaultIndex};
use crate::util::{self, basename, extension, U16Mapper};
use eval::{eval, Ctx, Hits, Lazy, Outcome, K_CONTENT, K_FILENAME, K_TAG};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

/// The result list's sort menu.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SortOrder {
    /// File name (A to Z).
    #[default]
    Alphabetical,
    /// File name (Z to A).
    AlphabeticalReverse,
    /// Modified time (new to old).
    ByModifiedTime,
    /// Modified time (old to new).
    ByModifiedTimeReverse,
    /// Created time (new to old).
    ByCreatedTime,
    /// Created time (old to new).
    ByCreatedTimeReverse,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOptions {
    /// The "Match case" toggle.
    pub case_sensitive: bool,
    pub sort: SortOrder,
    /// Also search files Obsidian would not show ("Detect all file
    /// extensions").
    pub include_unsupported: bool,
    /// Include the explanation tree in the output.
    pub explain: bool,
    /// Return at most this many files (counts still cover every match).
    pub limit: Option<usize>,
}

/// One file in the results.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub path: String,
    /// UTF-16 ranges in the file name (`basename` plus extension).
    pub filename_matches: Vec<[u32; 2]>,
    /// UTF-16 ranges in the full path (from `path:`).
    pub filepath_matches: Vec<[u32; 2]>,
    pub content_matches: Vec<ContentMatch>,
    pub properties: Vec<PropertyHit>,
    /// Matches as the result count counts them.
    pub match_count: u32,
    pub mtime: f64,
    pub ctime: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutput {
    pub results: Vec<FileResult>,
    /// Files matched (before `limit`).
    pub file_count: u32,
    /// The number the search pane shows: every range plus every property hit.
    pub match_count: u32,
    /// The parse error, shown instead of results.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub explanation: Option<Explanation>,
}

impl Query {
    /// Evaluates against one file of `index`. `None` means no match.
    pub(crate) fn match_path(
        &self,
        index: &VaultIndex,
        path: &str,
        case_sensitive: bool,
    ) -> Option<Hits> {
        let root = self.root.as_ref()?;
        let name = basename(path);
        let ext = extension(name);
        let note = if ext == "md" { index.note(path) } else { None };
        let name_l = Lazy::new(name);
        let path_l = Lazy::new(path);
        let content_l = Lazy::new(note.map_or("", |n| n.text.as_str()));
        let mut keys = 0;
        if util::is_document_ext(&ext) {
            keys |= K_FILENAME;
        }
        if ext == "md" {
            keys |= K_CONTENT;
        }
        let mut ctx = Ctx::new(keys, case_sensitive);
        ctx.filename = Some(name_l.whole());
        ctx.filepath = Some(path_l.whole());
        ctx.content = Some(content_l.whole());
        ctx.note = note;
        top_level(eval(root, &ctx))
    }

    /// Whether `path` passes this query (the graph's file filter).
    pub fn matches_file(&self, index: &VaultIndex, path: &str, case_sensitive: bool) -> bool {
        self.match_path(index, path, case_sensitive).is_some()
    }

    /// `matchTag`: the query against a tag string (graph tag nodes).
    pub fn matches_tag(&self, tag: &str, case_sensitive: bool) -> bool {
        let Some(root) = &self.root else { return false };
        let l = Lazy::new(tag);
        let mut ctx = Ctx::new(K_TAG, case_sensitive);
        ctx.tag = Some(l.whole());
        top_level(eval(root, &ctx)).is_some()
    }

    /// `matchFilepath`: the query against a path's name and path only
    /// (graph attachment nodes).
    pub fn matches_filepath(&self, path: &str, case_sensitive: bool) -> bool {
        let Some(root) = &self.root else { return false };
        let (n, p) = (Lazy::new(basename(path)), Lazy::new(path));
        let mut ctx = Ctx::new(K_FILENAME, case_sensitive);
        ctx.filename = Some(n.whole());
        ctx.filepath = Some(p.whole());
        top_level(eval(root, &ctx)).is_some()
    }

    /// Evaluates against free-standing text (e.g. a canvas card), with the
    /// text as content only.
    pub fn matches_content(&self, text: &str, case_sensitive: bool) -> bool {
        let Some(root) = &self.root else { return false };
        let l = Lazy::new(text);
        let mut ctx = Ctx::new(K_CONTENT, case_sensitive);
        ctx.content = Some(l.whole());
        top_level(eval(root, &ctx)).is_some()
    }
}

fn top_level(o: Outcome) -> Option<Hits> {
    match o {
        Outcome::Null => None,
        Outcome::Undef => Some(Hits::default()),
        Outcome::Hit(mut h) => {
            h.normalize();
            Some(h)
        }
    }
}

fn build_result(index: &VaultIndex, path: &str, hits: Hits) -> FileResult {
    let entry = index.file(path);
    let name = basename(path);
    let note: Option<&Note> = index.note(path);
    let map = |s: &str, v: &Option<Vec<[usize; 2]>>| {
        v.as_ref()
            .map_or_else(Vec::new, |v| U16Mapper::new(s).map(v))
    };
    let content_matches = match (note, &hits.content) {
        (Some(n), Some(v)) => v
            .iter()
            .filter(|r| r[1] <= n.text.len())
            .map(|r| content_match(n, r[0], r[1]))
            .collect(),
        // A file without text still has (empty) content, and operators such
        // as `line:-x` report zero-width ranges in it.
        (None, Some(v)) => v
            .iter()
            .map(|r| ContentMatch {
                start: r[0] as u32,
                end: r[1] as u32,
                line: 0,
                col: r[0] as u32,
                context: Default::default(),
            })
            .collect(),
        _ => Vec::new(),
    };
    FileResult {
        path: path.to_string(),
        filename_matches: map(name, &hits.filename),
        filepath_matches: map(path, &hits.filepath),
        content_matches,
        properties: hits.properties.clone().unwrap_or_default(),
        match_count: hits.count() as u32,
        mtime: entry.map_or(0.0, |e| e.mtime),
        ctime: entry.map_or(0.0, |e| e.ctime),
    }
}

pub(crate) fn compare_results(order: SortOrder, a: &FileResult, b: &FileResult) -> Ordering {
    let by_name = || {
        util::natural_cmp(util::stem(&a.path), util::stem(&b.path))
            .then_with(|| a.path.cmp(&b.path))
    };
    let f = |x: f64, y: f64| x.partial_cmp(&y).unwrap_or(Ordering::Equal);
    match order {
        SortOrder::Alphabetical => by_name(),
        SortOrder::AlphabeticalReverse => by_name().reverse(),
        SortOrder::ByModifiedTime => f(b.mtime, a.mtime).then_with(by_name),
        SortOrder::ByModifiedTimeReverse => f(a.mtime, b.mtime).then_with(by_name),
        SortOrder::ByCreatedTime => f(b.ctime, a.ctime).then_with(by_name),
        SortOrder::ByCreatedTimeReverse => f(a.ctime, b.ctime).then_with(by_name),
    }
}

impl VaultIndex {
    /// Runs a search query over the vault.
    pub fn search(&self, query: &str, opts: &SearchOptions) -> SearchOutput {
        match parse_query(query) {
            Ok(q) => self.search_query(&q, opts),
            Err(e) => SearchOutput {
                error: Some(e),
                ..Default::default()
            },
        }
    }

    /// Runs an already parsed query.
    pub fn search_query(&self, q: &Query, opts: &SearchOptions) -> SearchOutput {
        let mut out = SearchOutput {
            explanation: if opts.explain { q.explain() } else { None },
            ..Default::default()
        };
        if q.root.is_none() {
            return out;
        }
        let mut results = Vec::new();
        for entry in self.files() {
            let ext = extension(basename(&entry.path));
            if !opts.include_unsupported && !util::is_supported_ext(&ext) {
                continue;
            }
            if let Some(h) = q.match_path(self, &entry.path, opts.case_sensitive) {
                results.push(build_result(self, &entry.path, h));
            }
        }
        results.sort_by(|a, b| compare_results(opts.sort, a, b));
        out.file_count = results.len() as u32;
        out.match_count = results.iter().map(|r| r.match_count).sum();
        if let Some(limit) = opts.limit {
            results.truncate(limit);
        }
        out.results = results;
        out
    }
}
