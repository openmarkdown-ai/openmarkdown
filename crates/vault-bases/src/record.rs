//! Rows: one [`FileRecord`] per vault file, and the index used to resolve
//! link text and paths to them.

use crate::datetime;
use crate::value::{OrderedMap, Value};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// Everything a base needs to know about one file. The app builds these from
/// `TFile` + `CachedMetadata`; `name`, `basename`, `folder` and `ext` are
/// derived from `path` when left empty.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FileRecord {
    pub path: String,
    pub name: String,
    pub basename: String,
    /// Parent folder path; `"/"` for the vault root, as `TFolder.path` reports it.
    pub folder: String,
    /// Extension without the dot.
    pub ext: String,
    pub size: f64,
    pub ctime: f64,
    pub mtime: f64,
    /// Frontmatter.
    pub properties: serde_json::Map<String, serde_json::Value>,
    /// Tags from the body and frontmatter, with or without `#`.
    pub tags: Vec<String>,
    /// Link text (or resolved paths) of every internal link, frontmatter included.
    pub links: Vec<String>,
    pub embeds: Vec<String>,
    /// Paths of files linking to this one.
    pub backlinks: Vec<String>,
}

impl FileRecord {
    pub fn new(path: impl Into<String>) -> Self {
        let mut r = FileRecord {
            path: path.into(),
            ..Default::default()
        };
        r.fill_derived();
        r
    }

    /// Fill `name`, `basename`, `folder` and `ext` from `path` where empty.
    pub fn fill_derived(&mut self) {
        let path = self.path.trim_start_matches('/').to_string();
        let (folder, name) = match path.rfind('/') {
            Some(i) => (path[..i].to_string(), path[i + 1..].to_string()),
            None => ("/".to_string(), path.clone()),
        };
        let (basename, ext) = match name.rfind('.') {
            Some(i) if i > 0 => (name[..i].to_string(), name[i + 1..].to_string()),
            _ => (name.clone(), String::new()),
        };
        if self.name.is_empty() {
            self.name = name;
        }
        if self.basename.is_empty() {
            self.basename = basename;
        }
        if self.folder.is_empty() {
            self.folder = folder;
        }
        if self.ext.is_empty() {
            self.ext = ext;
        }
    }
}

/// Strip `[[…]]`, `|alias`, `#subpath` and markdown `[text](target)` from link
/// text, returning `(target, display)`.
pub fn split_link(text: &str) -> (String, Option<String>) {
    let t = text.trim();
    if let Some(inner) = t.strip_prefix("[[").and_then(|x| x.strip_suffix("]]")) {
        let inner = inner.strip_prefix('!').unwrap_or(inner);
        return match inner.split_once('|') {
            Some((a, b)) => (a.trim().to_string(), Some(b.to_string())),
            None => (inner.trim().to_string(), None),
        };
    }
    if t.starts_with('[') && t.ends_with(')') {
        if let Some(mid) = t.find("](") {
            let display = t[1..mid].to_string();
            let target = t[mid + 2..t.len() - 1].trim();
            let target = target
                .strip_prefix('<')
                .and_then(|x| x.strip_suffix('>'))
                .unwrap_or(target);
            return (percent_decode(target), Some(display));
        }
    }
    (t.to_string(), None)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(n) = std::str::from_utf8(&b[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(n);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

pub fn is_external(target: &str) -> bool {
    let Some(i) = target.find(':') else {
        return false;
    };
    i > 1
        && target[..i]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
}

fn without_subpath(target: &str) -> &str {
    match target.find('#') {
        Some(i) => &target[..i],
        None => target,
    }
}

/// Normalised link text for comparing unresolved links: no subpath, no `.md`,
/// lower-case.
pub fn link_key(text: &str) -> String {
    let (target, _) = split_link(text);
    let t = without_subpath(&target).trim();
    let t = t.strip_suffix(".md").unwrap_or(t);
    t.trim_start_matches('/').to_lowercase()
}

pub(crate) struct FileIndex<'a> {
    pub files: &'a [FileRecord],
    pub this: Option<&'a FileRecord>,
    by_path: HashMap<String, usize>,
    by_lower_path: HashMap<String, Vec<usize>>,
    by_name: HashMap<String, Vec<usize>>,
}

const THIS: usize = usize::MAX;

impl<'a> FileIndex<'a> {
    pub fn new(files: &'a [FileRecord], this: Option<&'a FileRecord>) -> Self {
        let mut ix = FileIndex {
            files,
            this,
            by_path: HashMap::new(),
            by_lower_path: HashMap::new(),
            by_name: HashMap::new(),
        };
        let entries = files.iter().enumerate().chain(this.map(|t| (THIS, t)));
        for (i, f) in entries {
            if i == THIS && ix.by_path.contains_key(&f.path) {
                continue;
            }
            ix.by_path.entry(f.path.clone()).or_insert(i);
            ix.by_lower_path
                .entry(f.path.to_lowercase())
                .or_default()
                .push(i);
            let lower_name = f.name.to_lowercase();
            ix.by_name.entry(lower_name).or_default().push(i);
            if f.ext.eq_ignore_ascii_case("md") {
                ix.by_name
                    .entry(f.basename.to_lowercase())
                    .or_default()
                    .push(i);
            }
        }
        ix
    }

    fn at(&self, i: usize) -> &'a FileRecord {
        if i == THIS {
            self.this.unwrap()
        } else {
            &self.files[i]
        }
    }

    pub fn get(&self, path: &str) -> Option<&'a FileRecord> {
        self.by_path.get(path).map(|&i| self.at(i))
    }

    /// Resolve link text (or a path) the way `getFirstLinkpathDest` does: an
    /// exact path, the path plus `.md`, then a unique-name match preferring
    /// the source's folder and then the shortest path.
    pub fn resolve(&self, text: &str, source: Option<&str>) -> Option<&'a FileRecord> {
        let (target, _) = split_link(text);
        let target = without_subpath(&target).trim();
        if target.is_empty() {
            return source.and_then(|s| self.get(s));
        }
        if is_external(target) {
            return None;
        }
        let target = target.trim_start_matches('/');
        if let Some(f) = self.get(target) {
            return Some(f);
        }
        let lower = target.to_lowercase();
        for key in [lower.clone(), format!("{lower}.md")] {
            if let Some(v) = self.by_lower_path.get(&key) {
                return Some(self.at(v[0]));
            }
        }
        // relative to the source folder
        if let Some(src) = source {
            if let Some(i) = src.rfind('/') {
                let rel = format!("{}/{}", &src[..i], target).to_lowercase();
                for key in [rel.clone(), format!("{rel}.md")] {
                    if let Some(v) = self.by_lower_path.get(&key) {
                        return Some(self.at(v[0]));
                    }
                }
            }
        }
        let (dir, name) = match lower.rfind('/') {
            Some(i) => (Some(&lower[..i]), &lower[i + 1..]),
            None => (None, lower.as_str()),
        };
        let cands = self.by_name.get(name)?;
        let src_folder = source
            .and_then(|s| s.rfind('/').map(|i| s[..i].to_lowercase()))
            .unwrap_or_default();
        cands
            .iter()
            .map(|&i| self.at(i))
            .filter(|f| match dir {
                Some(d) => f.path.to_lowercase().contains(&format!("{d}/")),
                None => true,
            })
            .min_by(|a, b| {
                let fa = a
                    .path
                    .rfind('/')
                    .map(|i| a.path[..i].to_lowercase())
                    .unwrap_or_default();
                let fb = b
                    .path
                    .rfind('/')
                    .map(|i| b.path[..i].to_lowercase())
                    .unwrap_or_default();
                (fb == src_folder)
                    .cmp(&(fa == src_folder))
                    .then(a.path.len().cmp(&b.path.len()))
                    .then(a.path.cmp(&b.path))
            })
    }
}

fn looks_like_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 10 && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-' && b[7] == b'-'
}

/// Convert a frontmatter JSON value into a [`Value`].
///
/// `prop_type` is the property's type from `.obsidian/types.json` (`text`,
/// `number`, `checkbox`, `date`, `datetime`, `multitext`, `tags`, `aliases`).
/// Without one, `YYYY-MM-DD[THH:mm[:ss]]` strings become dates, `[[wikilinks]]`
/// become links and `scheme://` strings become URLs, as Obsidian infers them.
pub fn json_to_value(v: &serde_json::Value, prop_type: Option<&str>, tz_min: i32) -> Value {
    use serde_json::Value as J;
    match v {
        J::Null => Value::Null,
        J::Bool(b) => Value::bool(*b),
        J::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            match prop_type {
                Some("date") | Some("datetime") => Value::date(f, prop_type == Some("datetime")),
                Some("text") => Value::str(crate::value::js_number_to_string(f)),
                _ => Value::num(f),
            }
        }
        J::String(s) => string_to_value(s, prop_type, tz_min),
        J::Array(a) => {
            let elem_type = match prop_type {
                Some("multitext") | Some("aliases") => Some("text"),
                Some("tags") => Some("tags"),
                other => other,
            };
            Value::list(
                a.iter()
                    .map(|x| json_to_value(x, elem_type, tz_min))
                    .collect(),
            )
        }
        J::Object(o) => {
            let mut m = OrderedMap::new();
            for (k, x) in o {
                m.insert(k.clone(), json_to_value(x, None, tz_min));
            }
            Value::Object { value: m }
        }
    }
}

fn string_to_value(s: &str, prop_type: Option<&str>, tz_min: i32) -> Value {
    let trimmed = s.trim();
    let is_wikilink = trimmed.starts_with("[[")
        && trimmed.ends_with("]]")
        && !trimmed[2..trimmed.len() - 2].contains("]]");
    match prop_type {
        Some("date") | Some("datetime") => {
            return match datetime::parse_date(trimmed, tz_min) {
                Some(d) => Value::date(d.ms, d.has_time),
                None if trimmed.is_empty() => Value::Null,
                None => Value::str(s),
            }
        }
        Some("number") => {
            return match trimmed.parse::<f64>() {
                Ok(n) => Value::num(n),
                Err(_) => Value::str(s),
            }
        }
        Some("checkbox") => {
            return match trimmed {
                "true" => Value::bool(true),
                "false" => Value::bool(false),
                _ => Value::str(s),
            }
        }
        Some("tags") => {
            return Value::Tag {
                value: s.to_string(),
            }
        }
        Some("text") => {
            return if is_wikilink {
                link_value_from_text(trimmed)
            } else {
                Value::str(s)
            };
        }
        _ => {}
    }
    if is_wikilink {
        return link_value_from_text(trimmed);
    }
    if looks_like_date(trimmed) {
        if let Some(d) = datetime::parse_date(trimmed, tz_min) {
            return Value::date(d.ms, d.has_time);
        }
    }
    if is_external(trimmed) && !trimmed.contains(char::is_whitespace) && trimmed.contains("://") {
        return Value::Url {
            value: s.to_string(),
        };
    }
    Value::str(s)
}

/// `[[Note|Alias]]` → Link { value: "Note", display: "Alias" }.
pub fn link_value_from_text(text: &str) -> Value {
    let (target, display) = split_link(text);
    Value::Link {
        value: target,
        display: display.map(|d| Box::new(Value::str(d))),
    }
}

pub(crate) fn property_type<'t>(
    types: Option<&'t BTreeMap<String, String>>,
    name: &str,
) -> Option<&'t str> {
    let types = types?;
    types
        .get(name)
        .or_else(|| {
            types
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v)
        })
        .map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_names() {
        let r = FileRecord::new("Books/Dune.md");
        assert_eq!(
            (
                r.name.as_str(),
                r.basename.as_str(),
                r.folder.as_str(),
                r.ext.as_str()
            ),
            ("Dune.md", "Dune", "Books", "md")
        );
        let r = FileRecord::new("Home.base");
        assert_eq!(
            (r.folder.as_str(), r.ext.as_str(), r.basename.as_str()),
            ("/", "base", "Home")
        );
        let r = FileRecord::new("a/b/.hidden");
        assert_eq!((r.basename.as_str(), r.ext.as_str()), (".hidden", ""));
    }

    #[test]
    fn splits_links() {
        assert_eq!(
            split_link("[[Note|Alias]]"),
            ("Note".into(), Some("Alias".into()))
        );
        assert_eq!(
            split_link("[[Note#Heading]]"),
            ("Note#Heading".into(), None)
        );
        assert_eq!(
            split_link("[Text](My%20Note.md)"),
            ("My Note.md".into(), Some("Text".into()))
        );
        assert_eq!(split_link("Plain"), ("Plain".into(), None));
        assert_eq!(link_key("[[Folder/Note.md#h|x]]"), "folder/note");
    }

    #[test]
    fn resolves_links() {
        let files = vec![
            FileRecord::new("People/Ann.md"),
            FileRecord::new("Archive/Ann.md"),
            FileRecord::new("Books/Dune.md"),
            FileRecord::new("img/cover.png"),
        ];
        let ix = FileIndex::new(&files, None);
        assert_eq!(ix.resolve("[[Dune]]", None).unwrap().path, "Books/Dune.md");
        assert_eq!(
            ix.resolve("books/dune", None).unwrap().path,
            "Books/Dune.md"
        );
        assert_eq!(
            ix.resolve("Books/Dune.md", None).unwrap().path,
            "Books/Dune.md"
        );
        assert_eq!(ix.resolve("cover.png", None).unwrap().path, "img/cover.png");
        assert!(ix.resolve("cover", None).is_none());
        assert_eq!(
            ix.resolve("Ann", Some("Archive/x.md")).unwrap().path,
            "Archive/Ann.md"
        );
        assert_eq!(
            ix.resolve("Ann", Some("People/y.md")).unwrap().path,
            "People/Ann.md"
        );
        assert_eq!(
            ix.resolve("Archive/Ann", None).unwrap().path,
            "Archive/Ann.md"
        );
        assert_eq!(
            ix.resolve("[[#Heading]]", Some("Books/Dune.md"))
                .unwrap()
                .path,
            "Books/Dune.md"
        );
        assert!(ix.resolve("https://obsidian.md", None).is_none());
        assert!(ix.resolve("Nope", None).is_none());
    }

    #[test]
    fn converts_frontmatter() {
        let j: serde_json::Value = serde_json::json!({
            "d": "2025-01-31", "dt": "2025-01-31T10:30", "l": "[[Gustave Eiffel]]", "u": "https://x.y",
            "n": 3, "s": "hello", "arr": ["[[A]]", "b"], "o": {"k": 1}, "fake": "2025-99-99"
        });
        let get = |k: &str, t: Option<&str>| json_to_value(&j[k], t, 0);
        assert_eq!(get("d", None), Value::date(1_738_281_600_000.0, false));
        assert!(matches!(get("dt", None), Value::Date { time: true, .. }));
        assert_eq!(get("l", None), Value::link("Gustave Eiffel"));
        assert!(matches!(get("u", None), Value::Url { .. }));
        assert_eq!(get("n", None), Value::num(3.0));
        assert_eq!(get("n", Some("text")), Value::str("3"));
        assert_eq!(get("d", Some("text")), Value::str("2025-01-31"));
        assert_eq!(get("s", Some("number")), Value::str("hello"));
        assert_eq!(
            get("arr", None),
            Value::list(vec![Value::link("A"), Value::str("b")])
        );
        assert_eq!(get("fake", None), Value::str("2025-99-99"));
        assert!(matches!(get("o", None), Value::Object { .. }));
    }
}
