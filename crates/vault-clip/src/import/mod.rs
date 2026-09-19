//! Importers from other note apps into an Obsidian-compatible vault.
//!
//! Each importer is a pure function: the export's bytes (or its files as
//! `(path, bytes)` pairs, already read by the browser or the CLI) go in, and an
//! [`ImportResult`] comes out — the files to write, relative to whatever folder
//! the caller imports into, plus human-readable warnings for what was skipped.
//! Nothing here touches a filesystem or a clock.
//!
//! The behaviour mirrors obsidianmd/obsidian-importer (MIT), format by format:
//! how it names files, how it sanitises names, where attachments go, which
//! frontmatter keys it writes and how links are repaired. Where this crate
//! differs, the importer module says so and why. The shared rules:
//!
//! - **Paths** use forward slashes and are relative to the import root. Names
//!   pass through [`sanitize_file_name`], and collisions are resolved
//!   case-insensitively the way Obsidian does (`Note.md`, `Note 1.md`, …).
//! - **Wikilinks** use the shortest text that is unique among the imported
//!   files: the bare name when only one file has it, otherwise the path from
//!   the import root, which Obsidian resolves as a path suffix. A link can never
//!   include the (unknown) folder the caller imports into.
//! - **Frontmatter** is written by [`yaml`], which quotes the way Obsidian's own
//!   `stringifyYaml` does, so a property the importer writes is one Obsidian
//!   reads back unchanged.
//! - **Times.** A note carries `ctime_ms`/`mtime_ms` when the source had them,
//!   for the caller to apply as file times.
//!
//! ## API
//!
//! `Files` is `&[(String, Vec<u8>)]`: paths relative to what the user picked,
//! forward or back slashes; any `.zip` among them is opened. Every options
//! struct implements `Default` (the importer's defaults) and (de)serialises
//! camelCase with missing fields defaulted.
//!
//! ```text
//! enex::convert(xml: &str, &EnexOptions)                    -> ImportResult
//! notion::convert(files) / convert_with(files, &NotionOptions) -> ImportResult
//! roam::convert(json: &str, &RoamOptions)                   -> ImportResult
//! keep::convert(files) / convert_with(files, &KeepOptions)  -> ImportResult
//! bear::convert(bear2bk: &[u8]) / convert_with(bytes, &BearOptions) -> ImportResult
//! logseq::convert(files) / convert_with(files, &LogseqOptions) -> ImportResult
//! html_files::convert(files, &HtmlFilesOptions)            -> ImportResult
//! csv::convert(csv: &str, &CsvOptions)                      -> ImportResult
//! textbundle::convert(files)                                -> ImportResult
//! format_converter::convert(markdown: &str, &FormatConverterOptions) -> String
//! crate::zip::read_zip(bytes: &[u8])                        -> Result<Vec<ZipEntry>, ZipError>
//! ```

pub mod bear;
pub mod csv;
pub mod dates;
pub mod enex;
pub mod format_converter;
pub mod html_files;
pub mod keep;
pub mod logseq;
pub mod markup;
pub mod mdcode;
pub mod notion;
pub mod outline;
pub mod roam;
pub mod textbundle;
pub mod util;
pub mod yaml;

pub use util::{sanitize_file_name, sanitize_file_path, sanitize_tag};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One file to write into the vault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    /// Relative to the import root, forward slashes.
    pub path: String,
    /// Notes are UTF-8 Markdown; attachments are their original bytes.
    pub data: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctime_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<i64>,
}

impl ImportedFile {
    pub fn new(path: impl Into<String>, data: Vec<u8>) -> ImportedFile {
        ImportedFile {
            path: path.into(),
            data,
            ctime_ms: None,
            mtime_ms: None,
        }
    }

    pub fn note(path: impl Into<String>, markdown: String) -> ImportedFile {
        ImportedFile::new(path, markdown.into_bytes())
    }

    pub fn with_times(mut self, ctime: Option<i64>, mtime: Option<i64>) -> ImportedFile {
        self.ctime_ms = ctime;
        self.mtime_ms = mtime.or(ctime);
        self
    }

    /// The note text, for tests and inspection.
    pub fn text(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.data)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub files: Vec<ImportedFile>,
    pub warnings: Vec<String>,
}

impl ImportResult {
    pub fn file(&self, path: &str) -> Option<&ImportedFile> {
        self.files.iter().find(|f| f.path == path)
    }

    /// The text of the file at `path`, or an empty string.
    pub fn text(&self, path: &str) -> String {
        self.file(path).map(|f| f.text().into_owned()).unwrap_or_default()
    }

    pub fn paths(&self) -> Vec<&str> {
        self.files.iter().map(|f| f.path.as_str()).collect()
    }
}

/// Chooses wikilink text for files whose final paths are all known.
///
/// Obsidian writes the bare name when it is unique in the vault and a path
/// otherwise; the vault is unknown here, so uniqueness is judged among the
/// imported files. Matching is case-insensitive, as Obsidian's is on the
/// case-insensitive filesystems most vaults live on.
#[derive(Debug, Default, Clone)]
pub struct LinkResolver {
    names: HashMap<String, usize>,
}

impl LinkResolver {
    pub fn new<'a>(paths: impl IntoIterator<Item = &'a str>) -> LinkResolver {
        let mut r = LinkResolver::default();
        for p in paths {
            r.add(p);
        }
        r
    }

    pub fn add(&mut self, path: &str) {
        *self
            .names
            .entry(util::link_name(path).to_lowercase())
            .or_insert(0) += 1;
    }

    /// Link text for `path`: the name without `.md` (attachments keep their
    /// extension) when unique, else the path without `.md`.
    pub fn link(&self, path: &str) -> String {
        let name = util::link_name(path);
        if self.names.get(&name.to_lowercase()).copied().unwrap_or(0) <= 1 {
            name.to_string()
        } else {
            path.strip_suffix(".md").unwrap_or(path).to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_resolver_uses_bare_name_when_unique_and_path_otherwise() {
        let r = LinkResolver::new(["a/Note.md", "b/note.md", "Other.md", "img/cat.png"]);
        assert_eq!(r.link("a/Note.md"), "a/Note");
        assert_eq!(r.link("b/note.md"), "b/note");
        assert_eq!(r.link("Other.md"), "Other");
        assert_eq!(r.link("img/cat.png"), "cat.png");
    }

    #[test]
    fn imported_file_times_default_mtime_to_ctime() {
        let f = ImportedFile::note("a.md", "x".into()).with_times(Some(5), None);
        assert_eq!(f.mtime_ms, Some(5));
    }

    #[test]
    fn import_result_serialises_camel_case() {
        let r = ImportResult {
            files: vec![ImportedFile::note("a.md", "x".into()).with_times(Some(1), Some(2))],
            warnings: vec![],
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"ctimeMs\":1"), "{json}");
    }
}
