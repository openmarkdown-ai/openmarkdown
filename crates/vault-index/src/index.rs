//! `VaultIndex`: the file list, note contents and metadata, and everything
//! derived from links — `resolvedLinks`, `unresolvedLinks`, backlinks,
//! unlinked mentions, tags and link text.

use crate::resolve::{FileEntry, FileTable, LinkFormat};
use crate::tags;
use crate::util::{self, basename, extension, merge_ranges, strip_subpath, U16Mapper};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;
use vault_types::{CachedMetadata, LineIndex, LinkCache, Pos};

/// A note's text and metadata as stored in the index.
#[derive(Debug, Clone)]
pub struct Note {
    pub text: String,
    pub meta: CachedMetadata,
    pub lines: LineIndex,
}

impl Note {
    pub fn new(text: String, meta: CachedMetadata) -> Self {
        let lines = LineIndex::new(&text);
        Note { text, meta, lines }
    }

    /// Byte offset of a UTF-16 offset in this note's text.
    pub fn byte(&self, u16_offset: u32) -> usize {
        self.lines
            .byte_of_u16(&self.text, u16_offset)
            .min(self.text.len())
    }
}

pub type LinkCounts = BTreeMap<String, BTreeMap<String, u32>>;

#[derive(Debug, Default)]
struct LinkTables {
    resolved: LinkCounts,
    unresolved: LinkCounts,
}

/// Which list a reference came from.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Link,
    Embed,
    Frontmatter,
}

/// A reference in a note, in the order `iterateRefsForFile` visits them:
/// frontmatter links, then links, then embeds.
#[derive(Debug, Clone, Copy)]
pub struct RefView<'a> {
    pub kind: RefKind,
    pub link: &'a str,
    pub original: &'a str,
    pub display_text: Option<&'a str>,
    /// Body references only.
    pub position: Option<Pos>,
    /// Frontmatter references only (`key` or `key.0`).
    pub key: Option<&'a str>,
}

pub(crate) fn refs_of(meta: &CachedMetadata) -> Vec<RefView<'_>> {
    let mut out = Vec::new();
    if let Some(fl) = &meta.frontmatter_links {
        for f in fl {
            out.push(RefView {
                kind: RefKind::Frontmatter,
                link: &f.link,
                original: &f.original,
                display_text: f.display_text.as_deref(),
                position: None,
                key: Some(&f.key),
            });
        }
    }
    let lists: [(&Option<Vec<LinkCache>>, RefKind); 2] =
        [(&meta.links, RefKind::Link), (&meta.embeds, RefKind::Embed)];
    for (list, kind) in lists {
        if let Some(list) = list {
            for l in list {
                out.push(RefView {
                    kind,
                    link: &l.link,
                    original: &l.original,
                    display_text: l.display_text.as_deref(),
                    position: Some(l.position),
                    key: None,
                });
            }
        }
    }
    out
}

/// A text excerpt around a match, for result lists.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// The excerpt (normally the whole line; long lines are windowed).
    pub text: String,
    /// UTF-16 offset of `text` in the file.
    pub offset: u32,
    /// The match within `text`, UTF-16 `[start, end)`.
    pub start: u32,
    pub end: u32,
}

/// One match inside a note's content.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    /// UTF-16 offsets into the file.
    pub start: u32,
    pub end: u32,
    /// 0-based line and UTF-16 column of `start`.
    pub line: u32,
    pub col: u32,
    pub context: Snippet,
}

/// A backlink reference.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkRef {
    pub kind: RefKind,
    pub link: String,
    pub original: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub position: Option<Pos>,
    /// Frontmatter key path (`related` or `related.1`).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub key: Option<String>,
    /// The line around a body reference.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context: Option<Snippet>,
}

/// All references from one source note to the target.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub source: String,
    pub refs: Vec<BacklinkRef>,
}

/// Plain-text mentions of the target in one note.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub source: String,
    pub matches: Vec<ContentMatch>,
}

/// Context window (UTF-16 units each side) for long lines.
pub(crate) const CONTEXT_CHARS: u32 = 80;

/// The vault index. All methods are synchronous and pure over the data given.
#[derive(Debug, Default)]
pub struct VaultIndex {
    pub(crate) table: FileTable,
    pub(crate) notes: HashMap<String, Note>,
    links: RefCell<Option<Rc<LinkTables>>>,
}

impl Clone for VaultIndex {
    fn clone(&self) -> Self {
        VaultIndex {
            table: self.table.clone(),
            notes: self.notes.clone(),
            links: RefCell::new(None),
        }
    }
}

impl VaultIndex {
    pub fn new() -> Self {
        Self::default()
    }

    fn invalidate(&self) {
        *self.links.borrow_mut() = None;
    }

    /// Adds or updates any file (notes and attachments alike).
    pub fn upsert_file(&mut self, e: FileEntry) {
        if self.table.upsert(e) {
            self.invalidate();
        }
    }

    pub fn remove_file(&mut self, path: &str) {
        let had = self.table.remove(path).is_some();
        let had_note = self.notes.remove(path).is_some();
        if had || had_note {
            self.invalidate();
        }
    }

    /// Renames a file, or — when `old` is not a file — every file inside
    /// folder `old`.
    pub fn rename_file(&mut self, old: &str, new: &str) {
        for (from, to) in self.rename_plan(old, new) {
            self.table.rename(&from, &to);
            if let Some(n) = self.notes.remove(&from) {
                self.notes.insert(to, n);
            }
        }
        self.invalidate();
    }

    /// The `(from, to)` path pairs a rename of `old` to `new` implies.
    pub fn rename_plan(&self, old: &str, new: &str) -> Vec<(String, String)> {
        if self.table.contains(old) {
            return vec![(old.to_string(), new.to_string())];
        }
        let old_dir = old.trim_end_matches('/');
        let new_dir = new.trim_end_matches('/');
        self.table
            .files_in_folder(old_dir)
            .into_iter()
            .map(|p| {
                let rest = &p[old_dir.len()..];
                let to = if new_dir.is_empty() {
                    rest.trim_start_matches('/').to_string()
                } else {
                    format!("{new_dir}{rest}")
                };
                (p, to)
            })
            .collect()
    }

    /// Stores a note's content and metadata (adding the file if unknown).
    pub fn set_note(&mut self, path: &str, text: String, meta: CachedMetadata) {
        if !self.table.contains(path) {
            self.table.upsert(FileEntry {
                path: path.to_string(),
                size: text.len() as u64,
                ctime: 0.0,
                mtime: 0.0,
            });
            self.invalidate();
        }
        let note = Note::new(text, meta);
        // Only this note's outgoing links can have changed.
        let cached = self.links.borrow().clone();
        if let Some(tables) = cached {
            let mut tables = Rc::try_unwrap(tables).unwrap_or_else(|rc| LinkTables {
                resolved: rc.resolved.clone(),
                unresolved: rc.unresolved.clone(),
            });
            let (r, u) = self.resolve_note(path, &note.meta);
            tables.resolved.insert(path.to_string(), r);
            tables.unresolved.insert(path.to_string(), u);
            *self.links.borrow_mut() = Some(Rc::new(tables));
        }
        self.notes.insert(path.to_string(), note);
    }

    pub fn file(&self, path: &str) -> Option<&FileEntry> {
        self.table.get(path)
    }

    pub fn files(&self) -> impl Iterator<Item = &FileEntry> {
        self.table.iter()
    }

    pub fn file_count(&self) -> usize {
        self.table.len()
    }

    pub fn note(&self, path: &str) -> Option<&Note> {
        self.notes.get(path)
    }

    pub fn note_count(&self) -> usize {
        self.notes.len()
    }

    pub fn file_table(&self) -> &FileTable {
        &self.table
    }

    /// Note paths in path order (deterministic iteration).
    pub fn note_paths(&self) -> Vec<&str> {
        let mut v: Vec<&str> = self.notes.keys().map(|s| s.as_str()).collect();
        v.sort_unstable();
        v
    }

    /// `getFirstLinkpathDest`, with any `#subpath` stripped first.
    pub fn resolve_link(&self, linkpath: &str, source: &str) -> Option<String> {
        self.table
            .first_linkpath_dest(strip_subpath(linkpath), source)
            .map(str::to_string)
    }

    /// `getLinkpathDest`: every candidate, best first (no subpath stripping).
    pub fn linkpath_dest(&self, linkpath: &str, source: &str) -> Vec<String> {
        self.table
            .linkpath_dest(linkpath, source)
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    fn resolve_note(
        &self,
        path: &str,
        meta: &CachedMetadata,
    ) -> (BTreeMap<String, u32>, BTreeMap<String, u32>) {
        let mut r = BTreeMap::new();
        let mut u = BTreeMap::new();
        for rf in refs_of(meta) {
            let lp = strip_subpath(rf.link);
            match self.table.first_linkpath_dest(lp, path) {
                Some(dest) => *r.entry(dest.to_string()).or_insert(0) += 1,
                None => {
                    // KF: drop a `.md` extension from the unresolved key.
                    let key = if extension(basename(lp)) == "md" {
                        &lp[..lp.len() - 3]
                    } else {
                        lp
                    };
                    *u.entry(key.to_string()).or_insert(0) += 1
                }
            }
        }
        (r, u)
    }

    fn link_tables(&self) -> Rc<LinkTables> {
        if let Some(t) = self.links.borrow().as_ref() {
            return t.clone();
        }
        let mut t = LinkTables::default();
        for (path, note) in &self.notes {
            if !util::is_note(path) {
                continue;
            }
            let (r, u) = self.resolve_note(path, &note.meta);
            t.resolved.insert(path.clone(), r);
            t.unresolved.insert(path.clone(), u);
        }
        let rc = Rc::new(t);
        *self.links.borrow_mut() = Some(rc.clone());
        rc
    }

    /// `MetadataCache.resolvedLinks`: `{ source: { target: count } }` for
    /// every note, including links, embeds and frontmatter links.
    pub fn resolved_links(&self) -> LinkCounts {
        self.link_tables().resolved.clone()
    }

    /// `MetadataCache.unresolvedLinks`: keys are the link path as written,
    /// without subpath and without a trailing `.md`.
    pub fn unresolved_links(&self) -> LinkCounts {
        self.link_tables().unresolved.clone()
    }

    pub(crate) fn with_links<R>(&self, f: impl FnOnce(&LinkCounts, &LinkCounts) -> R) -> R {
        let t = self.link_tables();
        f(&t.resolved, &t.unresolved)
    }

    /// Backlinks pane data: every other note with references resolving to
    /// `path`, sorted by file name (the pane's default order).
    pub fn backlinks(&self, path: &str) -> Vec<Backlink> {
        let tables = self.link_tables();
        let mut out = Vec::new();
        for (source, targets) in &tables.resolved {
            if source == path || !targets.contains_key(path) {
                continue;
            }
            let Some(note) = self.notes.get(source) else {
                continue;
            };
            let mut refs = Vec::new();
            for rf in refs_of(&note.meta) {
                if self
                    .table
                    .first_linkpath_dest(strip_subpath(rf.link), source)
                    != Some(path)
                {
                    continue;
                }
                let context = rf
                    .position
                    .map(|p| snippet(note, note.byte(p.start.offset), note.byte(p.end.offset)));
                refs.push(BacklinkRef {
                    kind: rf.kind,
                    link: rf.link.to_string(),
                    original: rf.original.to_string(),
                    display_text: rf.display_text.map(str::to_string),
                    position: rf.position,
                    key: rf.key.map(str::to_string),
                    context,
                });
            }
            refs.sort_by_key(|r| r.position.map_or(0, |p| p.start.offset as i64 + 1));
            if !refs.is_empty() {
                out.push(Backlink {
                    source: source.clone(),
                    refs,
                });
            }
        }
        out.sort_by(|a, b| {
            util::natural_cmp(util::stem(&a.source), util::stem(&b.source))
                .then_with(|| a.source.cmp(&b.source))
        });
        out
    }

    /// Unlinked mentions pane: case-insensitive whole-word occurrences of the
    /// target's basename and its frontmatter aliases in every other note,
    /// excluding occurrences inside a link, an embed, or the frontmatter.
    pub fn unlinked_mentions(&self, path: &str) -> Vec<Mention> {
        let mut terms: Vec<String> = vec![util::stem(path).to_string()];
        if let Some(n) = self.notes.get(path) {
            terms.extend(tags::frontmatter_aliases(n.meta.frontmatter.as_ref()));
        }
        terms.retain(|t| !t.is_empty());
        let mut out = Vec::new();
        for source in self.note_paths() {
            if source == path {
                continue;
            }
            let note = &self.notes[source];
            let folded = std::cell::OnceCell::new();
            let mut hits: Vec<[usize; 2]> = Vec::new();
            for t in &terms {
                hits.extend(util::find_whole_word(
                    &note.text,
                    || Cow::Borrowed(folded.get_or_init(|| util::fold(&note.text)).as_str()),
                    t,
                    false,
                    false,
                ));
            }
            if hits.is_empty() {
                continue;
            }
            let excluded: Vec<[usize; 2]> = {
                let mut v = Vec::new();
                for list in [&note.meta.links, &note.meta.embeds].into_iter().flatten() {
                    for l in list {
                        v.push([
                            note.byte(l.position.start.offset),
                            note.byte(l.position.end.offset),
                        ]);
                    }
                }
                if let Some(p) = note.meta.frontmatter_position {
                    v.push([note.byte(p.start.offset), note.byte(p.end.offset)]);
                }
                v
            };
            let kept: Vec<[usize; 2]> = hits
                .into_iter()
                .filter(|h| !excluded.iter().any(|e| e[0] <= h[0] && e[1] >= h[1]))
                .collect();
            if kept.is_empty() {
                continue;
            }
            let kept = merge_ranges(kept);
            out.push(Mention {
                source: source.to_string(),
                matches: kept
                    .iter()
                    .map(|r| content_match(note, r[0], r[1]))
                    .collect(),
            });
        }
        out.sort_by(|a, b| {
            util::natural_cmp(util::stem(&a.source), util::stem(&b.source))
                .then_with(|| a.source.cmp(&b.source))
        });
        out
    }

    /// `MetadataCache.getTags()`.
    pub fn tags(&self) -> BTreeMap<String, u32> {
        let paths = self.note_paths();
        tags::count_tags(paths.iter().map(|p| &self.notes[*p].meta))
    }

    /// `fileToLinktext(target, source)` with `.md` omitted.
    pub fn linktext(&self, target: &str, source: &str, format: LinkFormat) -> String {
        self.table.file_to_linktext(target, source, format, true)
    }

    /// `FileManager.generateMarkdownLink(file, sourcePath, subpath, alias)`
    /// under the "New link format" and "Use [[Wikilinks]]" settings. Callers
    /// prefix `!` for an embed.
    pub fn generate_markdown_link(
        &self,
        target: &str,
        source: &str,
        subpath: Option<&str>,
        alias: Option<&str>,
        format: LinkFormat,
        use_markdown_links: bool,
    ) -> String {
        let subpath = subpath.unwrap_or("");
        let mut text = self
            .table
            .file_to_linktext(target, source, format, !use_markdown_links)
            + subpath;
        if target == source && !subpath.is_empty() {
            text = subpath.to_string();
        }
        if use_markdown_links {
            let encoded = crate::rename::encode_markdown_destination(&text);
            if util::is_note(target) {
                format!("[{}]({})", alias.unwrap_or(util::stem(target)), encoded)
            } else {
                format!("[{}]({})", alias.unwrap_or(""), encoded)
            }
        } else {
            match alias {
                Some(a) if a.to_lowercase() != text.to_lowercase() => format!("[[{text}|{a}]]"),
                Some(a) => format!("[[{a}]]"),
                None => format!("[[{text}]]"),
            }
        }
    }

    /// The display label a graph or switcher uses for a path.
    pub fn label(path: &str) -> &str {
        util::display_name(path)
    }
}

/// A `ContentMatch` for byte range `[start, end)` of `note`.
pub(crate) fn content_match(note: &Note, start: usize, end: usize) -> ContentMatch {
    let loc = note.lines.loc(&note.text, start);
    let end_u16 = note.lines.loc(&note.text, end).offset;
    ContentMatch {
        start: loc.offset,
        end: end_u16,
        line: loc.line,
        col: loc.col,
        context: snippet(note, start, end),
    }
}

/// The line containing `start` (through the line containing `end`), windowed
/// to `CONTEXT_CHARS` UTF-16 units either side of the match on long lines.
pub(crate) fn snippet(note: &Note, start: usize, end: usize) -> Snippet {
    let text = &note.text;
    let l0 = note.lines.line_of(start);
    let l1 = note.lines.line_of(end.max(start));
    let ls = note.lines.line_start(l0);
    let le = note.lines.line_end(text, l1).max(end.min(text.len()));
    let line = &text[ls..le];
    let m = U16Mapper::new(line);
    let [[ms, me]] = <[[u32; 2]; 1]>::try_from(m.map(&[[start - ls, end.min(le) - ls]])).unwrap();
    let total = util::utf16_len(line);
    let from = ms.saturating_sub(CONTEXT_CHARS);
    let to = (me + CONTEXT_CHARS).min(total);
    let line_offset = note.lines.loc(text, ls).offset;
    if from == 0 && to == total {
        return Snippet {
            text: line.to_string(),
            offset: line_offset,
            start: ms,
            end: me,
        };
    }
    let bs = util::byte_at_u16(line, from);
    let be = util::byte_at_u16(line, to);
    let from = util::u16_at(line, bs);
    Snippet {
        text: line[bs..be].to_string(),
        offset: line_offset + from,
        start: ms - from,
        end: me - from,
    }
}
