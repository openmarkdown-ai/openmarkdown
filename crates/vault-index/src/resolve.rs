//! Link resolution and link-text generation over the vault's file list.
//!
//! This is `MetadataCache.getLinkpathDest` / `getFirstLinkpathDest` and
//! `fileToLinktext` from Obsidian 1.13, reproduced step for step (the app's
//! code was read, not guessed at). The rules, in the order the app applies
//! them:
//!
//! 1. An empty linkpath (`[[#Heading]]`) resolves to the source file.
//! 2. Candidates are every file whose *name* equals the linkpath's last
//!    segment, case-insensitively — first as written when that segment has a
//!    dot, otherwise (or when nothing matched) with `.md` appended. So
//!    `[[Note]]` finds `Note.md`, `[[img.png]]` finds `img.png`, and
//!    `[[v1.2]]` falls back to `v1.2.md`. Attachments need their extension.
//! 3. A bare name with exactly one candidate resolves to it, wherever it is.
//! 4. `./x` and `../x` are joined onto the source's folder and must match a
//!    candidate's full path exactly.
//! 5. A full vault path (optionally with a leading `/`) matching a
//!    candidate exactly wins.
//! 6. A linkpath starting with `/` resolves to nothing else.
//! 7. Otherwise candidates whose lower-cased path *ends with* the lower-cased
//!    linkpath qualify. Those whose path starts with the source's folder come
//!    first, then the rest; within each group the shorter path wins, and equal
//!    lengths keep the order the files were added to the vault. Note the
//!    tests are plain string prefix/suffix tests, as in the app: a source in
//!    `a` also "shares a folder" with `ab/x.md`, and `b/note` also matches
//!    `ab/note.md`.
//!
//! "Shortest path when possible" (`fileToLinktext` with the `shortest`
//! format) writes the bare name when resolving that bare name from the source
//! gives exactly one candidate and it is the target, else the full path.

use crate::util::{basename, extension, parent, stem, strip_extension, strip_subpath};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// One file known to the vault (a note or any attachment).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub ctime: f64,
    #[serde(default)]
    pub mtime: f64,
}

/// The "New link format" setting.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default, Hash)]
#[serde(rename_all = "lowercase")]
pub enum LinkFormat {
    /// "Shortest path when possible" (the default).
    #[default]
    Shortest,
    /// "Relative path to file".
    Relative,
    /// "Absolute path in vault".
    Absolute,
}

/// The file list plus Obsidian's `uniqueFileLookup` (lower-cased file name →
/// files with that name, in insertion order).
#[derive(Clone, Debug, Default)]
pub struct FileTable {
    pub(crate) files: BTreeMap<String, FileEntry>,
    lookup: HashMap<String, Vec<String>>,
}

impl FileTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn get(&self, path: &str) -> Option<&FileEntry> {
        self.files.get(path)
    }

    pub fn contains(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }

    pub fn iter(&self) -> impl Iterator<Item = &FileEntry> {
        self.files.values()
    }

    /// Adds or updates a file. Returns true when the path is new.
    pub fn upsert(&mut self, e: FileEntry) -> bool {
        let path = e.path.clone();
        let is_new = self.files.insert(path.clone(), e).is_none();
        if is_new {
            let key = basename(&path).to_lowercase();
            let v = self.lookup.entry(key).or_default();
            if !v.contains(&path) {
                v.push(path);
            }
        }
        is_new
    }

    pub fn remove(&mut self, path: &str) -> Option<FileEntry> {
        let e = self.files.remove(path)?;
        let key = basename(path).to_lowercase();
        if let Some(v) = self.lookup.get_mut(&key) {
            v.retain(|p| p != path);
            if v.is_empty() {
                self.lookup.remove(&key);
            }
        }
        Some(e)
    }

    /// Moves one file. As in `MetadataCache.onRename`, the file leaves its
    /// old name's lookup list and is appended to the new one.
    pub fn rename(&mut self, old: &str, new: &str) -> bool {
        match self.remove(old) {
            Some(mut e) => {
                e.path = new.to_string();
                self.remove(new);
                self.upsert(e);
                true
            }
            None => false,
        }
    }

    /// Every file under folder `folder` (not including a file named like it).
    pub fn files_in_folder(&self, folder: &str) -> Vec<String> {
        let prefix = format!("{}/", folder.trim_end_matches('/'));
        self.files
            .range(prefix.clone()..)
            .take_while(|(k, _)| k.starts_with(&prefix))
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// `getLinkpathDest(linkpath, sourcePath)`: every candidate, best first.
    /// `linkpath` must already have its `#subpath` removed.
    pub fn linkpath_dest(&self, linkpath: &str, source: &str) -> Vec<&str> {
        if linkpath.is_empty() && !source.is_empty() {
            if let Some((k, _)) = self.files.get_key_value(source) {
                return vec![k.as_str()];
            }
        }
        let mut n = linkpath.to_lowercase();
        let mut name = basename(&n).to_string();
        let mut candidates = None;
        if name.contains('.') {
            candidates = self.lookup.get(&name);
        }
        if candidates.is_none() {
            n = format!("{linkpath}.md").to_lowercase();
            name = basename(&n).to_string();
            candidates = self.lookup.get(&name);
        }
        let Some(candidates) = candidates else {
            return Vec::new();
        };
        if name == n && candidates.len() == 1 {
            return vec![candidates[0].as_str()];
        }
        let mut folder = parent(source).to_lowercase();
        if n.starts_with("./") || n.starts_with("../") {
            if n.starts_with("./../") {
                n = n[2..].to_string();
            }
            if let Some(rest) = n.strip_prefix("./") {
                if !folder.is_empty() {
                    folder.push('/');
                }
                n = format!("{folder}{rest}");
            } else {
                while let Some(rest) = n.strip_prefix("../") {
                    n = rest.to_string();
                    folder = parent(&folder).to_string();
                }
                if !folder.is_empty() {
                    folder.push('/');
                }
                n = format!("{folder}{n}");
            }
            for c in candidates {
                if c.to_lowercase() == n {
                    return vec![c.as_str()];
                }
            }
        }
        if let Some(rest) = n.strip_prefix('/') {
            n = rest.to_string();
        }
        for c in candidates {
            if c.to_lowercase() == n {
                return vec![c.as_str()];
            }
        }
        if linkpath.starts_with('/') {
            return Vec::new();
        }
        let mut near: Vec<&str> = Vec::new();
        let mut far: Vec<&str> = Vec::new();
        for c in candidates {
            let lower = c.to_lowercase();
            if lower.ends_with(&n) {
                if lower.starts_with(&folder) {
                    near.push(c);
                } else {
                    far.push(c);
                }
            }
        }
        // `Array.prototype.sort` is stable: equal lengths keep lookup order.
        near.sort_by_key(|p| p.encode_utf16().count());
        far.sort_by_key(|p| p.encode_utf16().count());
        near.extend(far);
        near
    }

    /// `getFirstLinkpathDest`.
    pub fn first_linkpath_dest(&self, linkpath: &str, source: &str) -> Option<&str> {
        self.linkpath_dest(linkpath, source).into_iter().next()
    }

    /// `fileToLinktext(file, sourcePath, omitMdExtension)` under `format`.
    pub fn file_to_linktext(
        &self,
        target: &str,
        source: &str,
        format: LinkFormat,
        omit_md: bool,
    ) -> String {
        let is_md = extension(basename(target)) == "md";
        let path = if is_md && omit_md {
            strip_extension(target)
        } else {
            target
        };
        match format {
            LinkFormat::Absolute => path.to_string(),
            LinkFormat::Relative => {
                let mut up = String::new();
                let mut folder = parent(source).to_string();
                while !folder.is_empty()
                    && folder != "/"
                    && !path.starts_with(&format!("{folder}/"))
                {
                    up.insert_str(0, "../");
                    folder = parent(&folder).to_string();
                }
                let prefix = format!("{folder}/");
                if path.starts_with(&prefix) {
                    format!("{up}{}", &path[prefix.len()..])
                } else {
                    format!("{up}{path}")
                }
            }
            LinkFormat::Shortest => {
                let name = if is_md && omit_md {
                    stem(target)
                } else {
                    basename(target)
                };
                let dests = self.linkpath_dest(strip_subpath(name), source);
                if dests.len() == 1 && dests[0] == target {
                    name.to_string()
                } else {
                    path.to_string()
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(paths: &[&str]) -> FileTable {
        let mut t = FileTable::new();
        for p in paths {
            t.upsert(FileEntry {
                path: p.to_string(),
                ..Default::default()
            });
        }
        t
    }

    #[test]
    fn bare_name_unique_anywhere() {
        let t = table(&["deep/folder/Note.md", "other.md"]);
        assert_eq!(
            t.first_linkpath_dest("Note", "other.md"),
            Some("deep/folder/Note.md")
        );
        assert_eq!(
            t.first_linkpath_dest("note", "other.md"),
            Some("deep/folder/Note.md")
        );
        assert_eq!(
            t.first_linkpath_dest("NOTE.MD", "other.md"),
            Some("deep/folder/Note.md")
        );
    }

    #[test]
    fn attachments_need_extension() {
        let t = table(&["img/cat.png", "a.md"]);
        assert_eq!(
            t.first_linkpath_dest("cat.png", "a.md"),
            Some("img/cat.png")
        );
        assert_eq!(t.first_linkpath_dest("cat", "a.md"), None);
    }

    #[test]
    fn dotted_note_names_fall_back_to_md() {
        let t = table(&["v1.2.md", "a.md"]);
        assert_eq!(t.first_linkpath_dest("v1.2", "a.md"), Some("v1.2.md"));
    }

    #[test]
    fn empty_linkpath_is_self() {
        let t = table(&["a.md"]);
        assert_eq!(t.first_linkpath_dest("", "a.md"), Some("a.md"));
        assert_eq!(t.first_linkpath_dest("", "missing.md"), None);
    }

    #[test]
    fn duplicate_basenames_prefer_same_folder_then_shortest() {
        let t = table(&["zzz/long/Dup.md", "b/Dup.md", "a/Dup.md"]);
        // Root source: every path "starts with" the empty folder; shortest
        // first, equal lengths in insertion order.
        assert_eq!(
            t.linkpath_dest("Dup", "x.md"),
            vec!["b/Dup.md", "a/Dup.md", "zzz/long/Dup.md"]
        );
        // From inside `a`: the same-folder file first, then the rest.
        assert_eq!(
            t.linkpath_dest("Dup", "a/src.md"),
            vec!["a/Dup.md", "b/Dup.md", "zzz/long/Dup.md"]
        );
        assert_eq!(
            t.first_linkpath_dest("Dup", "zzz/long/x.md"),
            Some("zzz/long/Dup.md")
        );
    }

    #[test]
    fn root_file_wins_a_bare_name_because_it_is_an_exact_path() {
        let t = table(&["a/Dup.md", "Dup.md"]);
        assert_eq!(t.linkpath_dest("Dup", "a/src.md"), vec!["Dup.md"]);
    }

    #[test]
    fn folder_prefix_test_is_a_plain_string_prefix() {
        let t = table(&["ab/Dup.md", "c/Dup.md", "ccc/Dup.md"]);
        // Source folder "a" is a string prefix of "ab/".
        assert_eq!(t.first_linkpath_dest("Dup", "a/src.md"), Some("ab/Dup.md"));
    }

    #[test]
    fn partial_path_suffix_match() {
        let t = table(&["x/proj/Dup.md", "y/Dup.md", "yproj/Dup.md"]);
        assert_eq!(
            t.linkpath_dest("proj/Dup", "q.md"),
            vec!["yproj/Dup.md", "x/proj/Dup.md"]
        );
    }

    #[test]
    fn absolute_and_slash_paths() {
        let t = table(&["a/Dup.md", "b/Dup.md"]);
        assert_eq!(t.first_linkpath_dest("b/Dup", "a/x.md"), Some("b/Dup.md"));
        assert_eq!(t.first_linkpath_dest("/b/Dup", "a/x.md"), Some("b/Dup.md"));
        assert_eq!(t.first_linkpath_dest("/Dup", "a/x.md"), None);
        assert_eq!(
            t.first_linkpath_dest("B/DUP.md", "a/x.md"),
            Some("b/Dup.md")
        );
    }

    #[test]
    fn relative_paths() {
        let t = table(&["a/b/Dup.md", "a/Dup.md", "Dup.md", "c/Dup.md"]);
        assert_eq!(
            t.first_linkpath_dest("./Dup", "a/b/x.md"),
            Some("a/b/Dup.md")
        );
        assert_eq!(
            t.first_linkpath_dest("../Dup", "a/b/x.md"),
            Some("a/Dup.md")
        );
        assert_eq!(
            t.first_linkpath_dest("../../Dup", "a/b/x.md"),
            Some("Dup.md")
        );
        assert_eq!(
            t.first_linkpath_dest("./../c/Dup", "a/x.md"),
            Some("c/Dup.md")
        );
        assert_eq!(t.first_linkpath_dest("./Dup", "Root.md"), Some("Dup.md"));
    }

    #[test]
    fn missing_is_none() {
        let t = table(&["a.md"]);
        assert!(t.linkpath_dest("nope", "a.md").is_empty());
    }

    #[test]
    fn rename_appends_to_lookup_order() {
        let mut t = table(&["a/Dup.md", "b/Dup.md"]);
        assert_eq!(
            t.linkpath_dest("Dup", "x/y.md"),
            vec!["a/Dup.md", "b/Dup.md"]
        );
        t.rename("a/Dup.md", "c/Dup.md");
        assert_eq!(
            t.linkpath_dest("Dup", "x/y.md"),
            vec!["b/Dup.md", "c/Dup.md"]
        );
    }

    #[test]
    fn linktext_shortest() {
        let t = table(&["a/Note.md", "a/Dup.md", "b/Dup.md", "img/x.png"]);
        assert_eq!(
            t.file_to_linktext("a/Note.md", "b/s.md", LinkFormat::Shortest, true),
            "Note"
        );
        assert_eq!(
            t.file_to_linktext("a/Note.md", "b/s.md", LinkFormat::Shortest, false),
            "Note.md"
        );
        assert_eq!(
            t.file_to_linktext("b/Dup.md", "a/s.md", LinkFormat::Shortest, true),
            "b/Dup"
        );
        assert_eq!(
            t.file_to_linktext("img/x.png", "a/s.md", LinkFormat::Shortest, true),
            "x.png"
        );
    }

    #[test]
    fn linktext_relative_and_absolute() {
        let t = table(&["a/b/T.md", "a/c/S.md", "x/S.md", "S.md", "T2.md"]);
        assert_eq!(
            t.file_to_linktext("a/b/T.md", "a/c/S.md", LinkFormat::Relative, true),
            "../b/T"
        );
        assert_eq!(
            t.file_to_linktext("a/b/T.md", "x/S.md", LinkFormat::Relative, true),
            "../a/b/T"
        );
        assert_eq!(
            t.file_to_linktext("a/b/T.md", "S.md", LinkFormat::Relative, true),
            "a/b/T"
        );
        assert_eq!(
            t.file_to_linktext("T2.md", "a/c/S.md", LinkFormat::Relative, true),
            "../../T2"
        );
        assert_eq!(
            t.file_to_linktext("a/b/T.md", "a/b/S.md", LinkFormat::Relative, true),
            "T"
        );
        assert_eq!(
            t.file_to_linktext("a/b/T.md", "S.md", LinkFormat::Absolute, true),
            "a/b/T"
        );
        assert_eq!(
            t.file_to_linktext("a/b/T.md", "S.md", LinkFormat::Absolute, false),
            "a/b/T.md"
        );
    }

    #[test]
    fn files_in_folder_is_prefix_exact() {
        let t = table(&["a/x.md", "a/b/y.md", "ab/z.md", "a.md"]);
        assert_eq!(t.files_in_folder("a"), vec!["a/b/y.md", "a/x.md"]);
    }
}
