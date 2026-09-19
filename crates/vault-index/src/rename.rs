//! "Automatically update internal links": the text edits a rename implies.
//!
//! Reproduces `FileManager.runAsyncLinkUpdate` + `updateAllLinks` + the
//! per-reference rewrite (`JF` in the 1.13 bundle):
//!
//! 1. Before the rename, every reference (frontmatter links, links, embeds)
//!    with a non-empty link path is resolved with `getLinkpathDest`,
//!    remembering the first destination and the full candidate list.
//! 2. The rename is applied (a folder rename moves every file under it).
//! 3. Each reference is resolved again from its source's *new* path. When the
//!    candidate list is empty or differs from the one captured before, a new
//!    link path is generated for the original destination with
//!    `fileToLinktext` under the configured format (keeping `.md` only for
//!    Markdown-style links) and the subpath is re-appended. If that differs
//!    from the stored link, the reference's original text is rewritten:
//!    * wikilinks keep `!`, alias and the `\|` table escape; an alias equal to
//!      the old basename of a path-style link follows the new basename;
//!    * Markdown links keep `!`, text, title and angle brackets; the
//!      destination is percent-encoded as Obsidian does (spaces, backslash and
//!      control characters only); link text equal to the old display name
//!      (or old path) follows the rename.
//!
//! So links whose resolution does not change are left alone, and links to
//! *other* files that a rename makes ambiguous are rewritten to a longer path
//! so they keep pointing where they did.

use crate::index::{refs_of, RefKind, VaultIndex};
use crate::resolve::LinkFormat;
use crate::util::{
    self, display_name, percent_encode_char, split_subpath, strip_md, strip_subpath,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;
use vault_types::LineIndex;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RenameOptions {
    /// The "New link format" setting used for rewritten link paths.
    pub link_format: LinkFormat,
}

/// Replace UTF-16 `[start, end)` of a note's text with `text`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub start: u32,
    pub end: u32,
    pub text: String,
}

/// The edits for one note.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEdit {
    /// The note's path after the rename (where to write).
    pub path: String,
    /// The note's path before the rename (whose text the offsets refer to).
    pub original_path: String,
    /// Sorted by `start`, non-overlapping.
    pub edits: Vec<TextEdit>,
}

/// Applies edits (UTF-16 offsets into `text`) and returns the new text.
/// Overlapping edits after the first are skipped.
pub fn apply_edits(text: &str, edits: &[TextEdit]) -> String {
    let idx = LineIndex::new(text);
    let mut sorted: Vec<&TextEdit> = edits.iter().collect();
    sorted.sort_by_key(|e| (e.start, e.end));
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for e in sorted {
        let s = idx.byte_of_u16(text, e.start).min(text.len());
        let en = idx.byte_of_u16(text, e.end).min(text.len()).max(s);
        if s < cursor {
            continue;
        }
        out.push_str(&text[cursor..s]);
        out.push_str(&e.text);
        cursor = en;
    }
    out.push_str(&text[cursor..]);
    out
}

/// `YE`: percent-encode a Markdown link destination the way Obsidian writes
/// one — only backslash, space and C0 control characters.
pub fn encode_markdown_destination(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\\' || c == ' ' || matches!(c as u32, 0x00 | 0x08 | 0x0B | 0x0C | 0x0E..=0x1F) {
            percent_encode_char(c, &mut out);
        } else {
            out.push(c);
        }
    }
    out
}

fn wikilink_re() -> &'static regex_lite::Regex {
    static RE: OnceLock<regex_lite::Regex> = OnceLock::new();
    RE.get_or_init(|| regex_lite::Regex::new(r"^(!?\[\[)(.*?)(\|(.*))?(\]\])$").unwrap())
}

fn mdlink_re() -> &'static regex_lite::Regex {
    static RE: OnceLock<regex_lite::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex_lite::Regex::new(
            r#"^(!?\[)(.*?)(\]\(\s*)((<[^>]*?>|[^ "]+?)(\s+([^ ]+|"[^"]+"|'[^']+'|\([^']+\)))?)?(\s*\))$"#,
        )
        .unwrap()
    })
}

/// Whether a reference's original text is a wikilink (`[[…]]` / `![[…]]`).
pub fn is_wikilink(original: &str) -> bool {
    wikilink_re().is_match(original)
}

/// Non-breaking spaces become spaces (`Dl`).
fn normalize_spaces(s: &str) -> String {
    s.replace(['\u{00A0}', '\u{202F}'], " ")
}

/// Rewrites a reference's `original` text so it links to `new_link`
/// (`JF(reference, newLinktext)`). `old_link` is the reference's stored link.
pub fn rewrite_link(original: &str, old_link: &str, new_link: &str) -> String {
    if let Some(c) = wikilink_re().captures(original) {
        let prefix = c.get(1).map_or("", |m| m.as_str());
        let link_part = c.get(2).map_or("", |m| m.as_str());
        let mut alias = c.get(4).map_or("", |m| m.as_str()).to_string();
        let close = c.get(5).map_or("", |m| m.as_str());
        if alias.is_empty() {
            return format!("{prefix}{new_link}{close}");
        }
        let sep = if original.contains("\\|") { "\\|" } else { "|" };
        if link_part.contains('/') && util::stem(link_part) == alias.trim() {
            alias = util::stem(strip_subpath(new_link)).to_string();
        }
        return format!("{prefix}{new_link}{sep}{alias}{close}");
    }
    let caps = mdlink_re().captures(original);
    let angle = caps
        .as_ref()
        .and_then(|c| c.get(5))
        .is_some_and(|m| m.as_str().starts_with('<'));
    let dest = if angle {
        format!("<{new_link}>")
    } else {
        encode_markdown_destination(new_link)
    };
    match caps {
        Some(c) => {
            let mut text = c.get(2).map_or("", |m| m.as_str()).to_string();
            let g = normalize_spaces(&text).trim().to_string();
            let old_path = strip_subpath(old_link);
            if g == display_name(old_path) {
                text = display_name(strip_subpath(new_link)).to_string();
            } else if g.contains('/') && g == strip_md(old_path) {
                text = strip_md(strip_subpath(new_link)).to_string();
            }
            format!(
                "{}{}{}{}{}{}",
                c.get(1).map_or("", |m| m.as_str()),
                text,
                c.get(3).map_or("", |m| m.as_str()),
                dest,
                c.get(6).map_or("", |m| m.as_str()),
                c.get(8).map_or("", |m| m.as_str())
            )
        }
        None => {
            let s = format!("[]({dest})");
            if original.starts_with('!') {
                format!("!{s}")
            } else {
                s
            }
        }
    }
}

struct Captured<'a> {
    source: &'a str,
    kind: RefKind,
    link: &'a str,
    original: &'a str,
    position: Option<vault_types::Pos>,
    /// Occurrence of this frontmatter original among the note's frontmatter
    /// links with the same original (to locate it in the YAML text).
    fm_occurrence: usize,
    resolved: String,
    resolved_paths: Vec<String>,
}

impl VaultIndex {
    /// The edits that keep every link pointing at the same file after
    /// renaming `old` to `new` (a file, or a folder and everything in it).
    /// Offsets refer to each note's text *before* any edit.
    pub fn rename_edits(&self, old: &str, new: &str, opts: &RenameOptions) -> Vec<FileEdit> {
        let plan = self.rename_plan(old, new);
        if plan.is_empty() {
            return Vec::new();
        }
        let moved: BTreeMap<&str, &str> =
            plan.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let map_path = |p: &str| -> String {
            moved
                .get(p)
                .map_or_else(|| p.to_string(), |s| s.to_string())
        };

        // 1. Capture every resolving reference.
        let mut captured: Vec<Captured> = Vec::new();
        for source in self.note_paths() {
            let note = &self.notes[source];
            let mut fm_seen: BTreeMap<&str, usize> = BTreeMap::new();
            for rf in refs_of(&note.meta) {
                let occ = if rf.kind == RefKind::Frontmatter {
                    let n = fm_seen.entry(rf.original).or_insert(0);
                    *n += 1;
                    *n - 1
                } else {
                    0
                };
                let lp = strip_subpath(rf.link);
                if lp.is_empty() {
                    continue;
                }
                let dests = self.table.linkpath_dest(lp, source);
                if dests.is_empty() {
                    continue;
                }
                captured.push(Captured {
                    source,
                    kind: rf.kind,
                    link: rf.link,
                    original: rf.original,
                    position: rf.position,
                    fm_occurrence: occ,
                    resolved: dests[0].to_string(),
                    resolved_paths: dests.iter().map(|s| s.to_string()).collect(),
                });
            }
        }

        // 2. Apply the rename to a copy of the file table.
        let mut after = self.table.clone();
        for (from, to) in &plan {
            after.rename(from, to);
        }

        // 3. Re-resolve and rewrite.
        let mut per_file: BTreeMap<&str, Vec<TextEdit>> = BTreeMap::new();
        for c in &captured {
            let new_source = map_path(c.source);
            let (lp, subpath) = split_subpath(c.link);
            let now: Vec<&str> = after.linkpath_dest(lp, &new_source);
            let unchanged = !now.is_empty()
                && now.len() == c.resolved_paths.len()
                && now.iter().zip(&c.resolved_paths).all(|(a, b)| *a == b);
            if unchanged {
                continue;
            }
            let target = map_path(&c.resolved);
            let omit_md = is_wikilink(c.original);
            let new_link =
                after.file_to_linktext(&target, &new_source, opts.link_format, omit_md) + subpath;
            if new_link == c.link {
                continue;
            }
            let replacement = rewrite_link(c.original, c.link, &new_link);
            let note = &self.notes[c.source];
            let range = match (c.kind, c.position) {
                (RefKind::Frontmatter, _) => {
                    locate_in_frontmatter(note, c.original, c.fm_occurrence)
                }
                (_, Some(p)) => Some((p.start.offset, p.end.offset)),
                _ => None,
            };
            if let Some((start, end)) = range {
                per_file.entry(c.source).or_default().push(TextEdit {
                    start,
                    end,
                    text: replacement,
                });
            }
        }

        per_file
            .into_iter()
            .map(|(source, mut edits)| {
                edits.sort_by_key(|e| (e.start, e.end));
                edits.dedup_by(|b, a| b.start < a.end);
                FileEdit {
                    path: map_path(source),
                    original_path: source.to_string(),
                    edits,
                }
            })
            .collect()
    }
}

/// UTF-16 range of the `occurrence`-th appearance of `original` inside the
/// note's frontmatter block.
fn locate_in_frontmatter(
    note: &crate::index::Note,
    original: &str,
    occurrence: usize,
) -> Option<(u32, u32)> {
    let fp = note.meta.frontmatter_position?;
    let s = note.byte(fp.start.offset);
    let e = note.byte(fp.end.offset);
    let region = &note.text[s..e];
    let (i, _) = region.match_indices(original).nth(occurrence)?;
    let start = note.lines.loc(&note.text, s + i).offset;
    let end = note.lines.loc(&note.text, s + i + original.len()).offset;
    Some((start, end))
}
