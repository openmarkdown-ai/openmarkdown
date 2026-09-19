//! Bear backups (`.bear2bk`): a zip of `.textbundle` folders.
//!
//! Mirrors obsidian-importer's Bear importer:
//!
//! - Each bundle's `text.md` (or `text.markdown`) becomes a note named after
//!   the bundle. A first line `# Title` that repeats that name is removed.
//! - `info.json`'s `net.shinyfrog.bear` metadata gives file times; archived
//!   notes go to `archive/` with an `archived` property and trashed notes to
//!   `trash/` with `trashed` (`YYYY-MM-DDTHH:mm:ss`).
//! - Assets are copied to an attachment folder (collisions numbered) and the
//!   Markdown links to `assets/…` are pointed at them, keeping Bear's
//!   Markdown-link form; image sizes written as `<!-- {"width":300} -->`
//!   become `![alt|300](…)`.
//! - Tags: `#multi word#` becomes `#multi_word`, characters Obsidian rejects
//!   become `_`, and hex colours such as `#FF0000` are left as text. With
//!   `tagsAsProperty`, tags move out of the text into a `tags` list.
//! - Bear's `~underline~` becomes `<u>…</u>`, a table gets the blank line
//!   Obsidian needs before it, and `bear://x-callback-url/open-note?id=…`
//!   links point at the imported note.
//!
//! Code blocks and inline code are never rewritten. Not supported: Bear 2's
//! newer "Application Data" backups, which hold a SQLite database.

use super::util::{
    basename, encode_uri, extension_lower, parent, percent_decode, relative_path,
    resolve_path, sanitize_file_name, sanitize_tag, split_ext, UniquePaths,
};
use super::yaml::{frontmatter, Yaml};
use super::{dates, ImportResult, ImportedFile};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BearOptions {
    /// Move tags from the text into a `tags` property.
    pub tags_as_property: bool,
    /// With `tagsAsProperty`, split nested tags `a/b` into `a` and `b`.
    pub flatten_tags: bool,
    pub attachment_folder: String,
}

impl Default for BearOptions {
    fn default() -> Self {
        BearOptions {
            tags_as_property: false,
            flatten_tags: false,
            attachment_folder: "attachments".into(),
        }
    }
}

pub fn convert(bear2bk: &[u8]) -> ImportResult {
    convert_with(bear2bk, &BearOptions::default())
}

#[derive(Default, Clone)]
struct Meta {
    id: Option<String>,
    ctime: Option<i64>,
    mtime: Option<i64>,
    archived: Option<i64>,
    trashed: Option<i64>,
}

pub fn convert_with(bear2bk: &[u8], opts: &BearOptions) -> ImportResult {
    let mut result = ImportResult::default();
    let entries = match crate::zip::read_zip(bear2bk) {
        Ok(e) => e,
        Err(e) => {
            result.warnings.push(format!("Could not read the Bear backup: {e}"));
            return result;
        }
    };
    let entries: Vec<_> = entries
        .into_iter()
        .filter(|e| !e.is_dir)
        .filter(|e| {
            let n = basename(&e.name);
            !(n.starts_with("._") || e.name.starts_with("__MACOSX/") || n == ".DS_Store")
        })
        .collect();
    if entries.iter().any(|e| e.name.ends_with("Application Data/database.sqlite")) {
        result.warnings.push(
            "This backup stores notes in Bear's SQLite database (Application Data), which this importer cannot read; export notes as Markdown or TextBundle from Bear instead".into(),
        );
    }

    // Metadata per bundle folder.
    let mut meta: HashMap<String, Meta> = HashMap::new();
    for e in &entries {
        if basename(&e.name) != "info.json" {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&e.data) else {
            continue;
        };
        let b = &v["net.shinyfrog.bear"];
        let date = |k: &str| b.get(k).and_then(|d| d.as_str()).and_then(dates::parse_iso);
        let is1 = |k: &str| b.get(k).and_then(|x| x.as_i64()) == Some(1);
        meta.insert(
            parent(&e.name).to_string(),
            Meta {
                id: b.get("uniqueIdentifier").and_then(|x| x.as_str()).map(String::from),
                ctime: date("creationDate"),
                mtime: date("modificationDate"),
                archived: date("archivedDate").filter(|_| is1("archived")),
                trashed: date("trashedDate").filter(|_| is1("trashed")),
            },
        );
    }

    let mut paths = UniquePaths::new();
    let folder_for = |m: Option<&Meta>| -> &'static str {
        match m {
            Some(m) if m.archived.is_some() => "archive",
            Some(m) if m.trashed.is_some() => "trash",
            _ => "",
        }
    };

    // Plan notes first so links between notes and asset links are known.
    struct Planned<'a> {
        bundle: String,
        name: String,
        path: String,
        text: &'a [u8],
        meta: Option<Meta>,
    }
    let mut planned: Vec<Planned> = Vec::new();
    for e in &entries {
        let ext = extension_lower(&e.name);
        if !(ext == "md" || ext == "markdown") || e.name.contains("/assets/") {
            continue;
        }
        let bundle = parent(&e.name).to_string();
        let bundle_name = basename(&bundle);
        let name = bundle_name
            .strip_suffix(".textbundle")
            .unwrap_or_else(|| split_ext(bundle_name).0)
            .to_string();
        let name = if name.is_empty() { split_ext(basename(&e.name)).0.to_string() } else { name };
        let m = meta.get(&bundle).cloned();
        let path = paths.claim(folder_for(m.as_ref()), &format!("{}.md", sanitize_file_name(&name)));
        planned.push(Planned {
            bundle,
            name,
            path,
            text: &e.data,
            meta: m,
        });
    }

    // Assets: `<bundle>/assets/<file>` → attachment path.
    let attachment_dir = opts.attachment_folder.trim_matches('/').to_string();
    let mut assets: HashMap<String, String> = HashMap::new();
    for e in &entries {
        if let Some(at) = e.name.find("/assets/") {
            let _bundle = &e.name[..at];
            let name = sanitize_file_name(&basename(&e.name).replace(':', ""));
            let out = paths.claim(&attachment_dir, &name);
            assets.insert(e.name.clone(), out.clone());
            result.files.push(ImportedFile::new(out, e.data.clone()));
        } else if basename(&e.name) != "info.json"
            && !matches!(basename(&e.name), "tags.json" | "backup.json")
            && !matches!(extension_lower(&e.name).as_str(), "md" | "markdown")
            && !e.name.ends_with("database.sqlite")
        {
            result.warnings.push(format!("Skipped {}: not part of a note", e.name));
        }
    }

    let ids: HashMap<String, String> = planned
        .iter()
        .filter_map(|p| {
            let id = p.meta.as_ref()?.id.clone()?;
            Some((id, split_ext(basename(&p.path)).0.to_string()))
        })
        .collect();

    let mut notes = Vec::new();
    for p in &planned {
        let text = super::util::decode_text(p.text);
        let converted = convert_note(&text, &p.name, &p.bundle, &p.path, &assets, opts);
        let mut body = rewrite_note_links(&converted.content, &ids);
        let mut props: Vec<(String, Yaml)> = Vec::new();
        if let Some(m) = &p.meta {
            if let Some(a) = m.archived {
                props.push(("archived".into(), Yaml::str(dates::iso_seconds(a))));
            }
            if let Some(t) = m.trashed {
                props.push(("trashed".into(), Yaml::str(dates::iso_seconds(t))));
            }
        }
        if opts.tags_as_property && !converted.tags.is_empty() {
            props.push(("tags".into(), Yaml::list(converted.tags.clone())));
        }
        if !props.is_empty() {
            body = format!("{}{}", frontmatter(&props), body);
        }
        let (ctime, mtime) = p.meta.as_ref().map(|m| (m.ctime, m.mtime)).unwrap_or((None, None));
        notes.push(ImportedFile::note(p.path.clone(), body).with_times(ctime, mtime));
    }
    notes.append(&mut result.files);
    result.files = notes;
    result
}

fn rewrite_note_links(content: &str, ids: &HashMap<String, String>) -> String {
    const PREFIX: &str = "bear://x-callback-url/open-note?id=";
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(at) = rest.find(PREFIX) {
        out.push_str(&rest[..at]);
        let after = &rest[at + PREFIX.len()..];
        let len = after
            .bytes()
            .take_while(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'-')
            .count();
        match ids.get(&after[..len]) {
            Some(name) if len > 0 => {
                out.push_str(&encode_uri(name));
                rest = &after[len..];
            }
            _ => {
                out.push_str(PREFIX);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub struct ConvertedNote {
    pub content: String,
    pub tags: Vec<String>,
}

/// Convert one Bear note's Markdown. `bundle` is the note's folder inside the
/// backup (asset links resolve against it); `note_path` is where the note is
/// written (links to attachments are made relative to it).
pub fn convert_note(
    text: &str,
    name: &str,
    bundle: &str,
    note_path: &str,
    assets: &HashMap<String, String>,
    opts: &BearOptions,
) -> ConvertedNote {
    let mut code: Vec<String> = Vec::new();
    let content = mask_code(&remove_markdown_header(name, text), &mut code);
    let content = separate_tables(&content);
    let content = apply_image_sizes(&content);
    let content = write_underlines(&content);
    let content = relink_assets(&content, bundle, note_path, assets);
    let content = normalize_tags(&content);
    let tags = extract_tags(&content, opts.flatten_tags);
    let content = if opts.tags_as_property {
        remove_tags(&content)
    } else {
        content
    };
    ConvertedNote {
        content: unmask_code(&content, &code),
        tags,
    }
}

fn remove_markdown_header(name: &str, content: &str) -> String {
    let Some(rest) = content.strip_prefix("# ") else {
        return content.to_string();
    };
    let (heading, after) = match rest.find('\n') {
        Some(i) => (&rest[..i], Some(&rest[i + 1..])),
        None => (rest, None),
    };
    let heading = heading.trim();
    if heading != name.trim() && !heading.is_empty() {
        return content.to_string();
    }
    after.unwrap_or("").to_string()
}

// --- code masking ----------------------------------------------------------

const MASK: char = '\0';

fn hide(text: &str, code: &mut Vec<String>) -> String {
    code.push(text.to_string());
    format!("{MASK}{}{MASK}", code.len() - 1)
}

fn fence_open(line: &str) -> Option<(char, usize)> {
    let spaces = line.chars().take_while(|c| *c == ' ').count();
    if spaces > 3 {
        return None;
    }
    let t = &line[spaces..];
    let marker = t.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let len = t.chars().take_while(|c| *c == marker).count();
    (len >= 3).then_some((marker, len))
}

fn mask_code(content: &str, code: &mut Vec<String>) -> String {
    let mut fence: Option<(char, usize)> = None;
    let mut lines = Vec::new();
    for line in content.split('\n') {
        if let Some((m, l)) = fence {
            // A closing fence is the marker run alone on its line.
            let t = line.trim_end_matches('\r').trim_end_matches([' ', '\t']);
            if let Some((cm, cl)) = fence_open(t) {
                let only_fence = t.trim_start_matches(' ').chars().count() == cl;
                if only_fence && cm == m && cl >= l {
                    fence = None;
                }
            }
            lines.push(hide(line, code));
            continue;
        }
        if let Some(f) = fence_open(line) {
            fence = Some(f);
            lines.push(hide(line, code));
            continue;
        }
        lines.push(line.to_string());
    }
    let joined = lines.join("\n");
    mask_code_spans(&joined, code)
}

/// CommonMark code spans: equal-length backtick runs, no blank line inside.
fn mask_code_spans(text: &str, code: &mut Vec<String>) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i < b.len() {
        if b[i] != b'`' {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i] == b'`' {
            i += 1;
        }
        let run = i - start;
        let mut j = i;
        let mut found = None;
        while j < b.len() {
            if b[j] == b'\n' {
                // A blank line ends the search.
                let rest = &text[j + 1..];
                if rest.trim_start_matches([' ', '\t']).starts_with('\n') {
                    break;
                }
            }
            if b[j] == b'`' {
                let k = j;
                while j < b.len() && b[j] == b'`' {
                    j += 1;
                }
                if j - k == run {
                    found = Some(j);
                    break;
                }
                continue;
            }
            j += 1;
        }
        if let Some(end) = found {
            out.push_str(&text[copied..start]);
            out.push_str(&hide(&text[start..end], code));
            copied = end;
            i = end;
        }
    }
    out.push_str(&text[copied..]);
    out
}

fn unmask_code(content: &str, code: &[String]) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(a) = rest.find(MASK) {
        out.push_str(&rest[..a]);
        let after = &rest[a + 1..];
        let digits = after.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digits > 0 && after[digits..].starts_with(MASK) {
            let idx: usize = after[..digits].parse().unwrap_or(usize::MAX);
            if let Some(c) = code.get(idx) {
                out.push_str(c);
                rest = &after[digits + 1..];
                continue;
            }
        }
        out.push(MASK);
        rest = after;
    }
    out.push_str(rest);
    out
}

// --- transforms --------------------------------------------------------------

fn separate_tables(content: &str) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let is_delimiter = |l: &str| {
        l.chars().all(|c| c.is_whitespace() || c == '|' || c == ':' || c == '-') && l.contains('-') && l.contains('|')
    };
    let mut out = Vec::with_capacity(lines.len());
    for (i, line) in lines.iter().enumerate() {
        if i > 0
            && line.contains('|')
            && lines.get(i + 1).is_some_and(|n| is_delimiter(n))
            && !lines[i - 1].trim().is_empty()
        {
            out.push("");
        }
        out.push(line);
    }
    out.join("\n")
}

fn apply_image_sizes(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(at) = rest.find("![") {
        out.push_str(&rest[..at]);
        let s = &rest[at..];
        let parsed = (|| {
            let alt_end = s[2..].find(']')? + 2;
            let alt = &s[2..alt_end];
            if alt.contains('\n') || !s[alt_end..].starts_with("](") {
                return None;
            }
            let target_end = s[alt_end + 2..].find(')')? + alt_end + 2;
            let target = &s[alt_end + 2..target_end];
            if target.contains(['(', ' ', '\n', '\t']) {
                return None;
            }
            let after = &s[target_end + 1..];
            let comment = after.strip_prefix("<!--")?;
            let end = comment.find("-->")?;
            let json = comment[..end].trim();
            if !json.starts_with('{') || !json.ends_with('}') || json[1..].contains('{') {
                return None;
            }
            let v: serde_json::Value = serde_json::from_str(json).ok()?;
            let num = |k: &str| {
                v.get(k).and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok())))
            };
            let width = num("width").filter(|w| w.is_finite() && *w > 0.0)?;
            let fmt = |n: f64| if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") };
            let size = match num("height").filter(|h| h.is_finite() && *h > 0.0) {
                Some(h) => format!("{}x{}", fmt(width), fmt(h)),
                None => fmt(width),
            };
            let label = if alt.is_empty() { size } else { format!("{alt}|{size}") };
            Some((format!("![{label}]({target})"), target_end + 1 + 4 + end + 3))
        })();
        match parsed {
            Some((text, used)) => {
                out.push_str(&text);
                rest = &s[used..];
            }
            None => {
                out.push_str("![");
                rest = &s[2..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `~text~` (single tildes) → `<u>text</u>`.
fn write_underlines(content: &str) -> String {
    let chars: Vec<char> = content.chars().collect();
    let mut out = String::with_capacity(content.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let prev = if i > 0 { Some(chars[i - 1]) } else { None };
        if c == '~' && prev != Some('~') && prev != Some('\\') && chars.get(i + 1).is_some_and(|n| *n != '~') {
            // Find the closing single tilde on this line.
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '~' && chars[j] != '\n' {
                j += 1;
            }
            if j < chars.len() && chars[j] == '~' && chars.get(j + 1) != Some(&'~') && j > i + 1 {
                let inner: String = chars[i + 1..j].iter().collect();
                let first = inner.chars().next().unwrap();
                let last = inner.chars().last().unwrap();
                let bad = |ch: char| ch.is_whitespace() || ch == '\\';
                if !bad(first) && !bad(last) {
                    out.push_str("<u>");
                    out.push_str(&inner);
                    out.push_str("</u>");
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn relink_assets(content: &str, bundle: &str, note_path: &str, assets: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(at) = rest.find("](assets/") {
        let link_start = at + 2;
        let Some(close) = rest[link_start..].find(')') else {
            break;
        };
        let link = &rest[link_start..link_start + close];
        let source = resolve_path(bundle, &percent_decode(link));
        out.push_str(&rest[..link_start]);
        match assets.get(&source) {
            Some(target) => out.push_str(&encode_uri(&relative_path(note_path, target))),
            None => out.push_str(link),
        }
        rest = &rest[link_start + close..];
    }
    out.push_str(rest);
    out
}

// --- tags -------------------------------------------------------------------

fn is_body(c: char) -> bool {
    !(c.is_whitespace() || c == MASK || super::util::is_illegal_tag_char(c))
}

fn is_edge(c: char) -> bool {
    is_body(c) && c != '/' && c != '-'
}

fn is_colour(body: &str) -> bool {
    matches!(body.len(), 3 | 4 | 6 | 8)
        && body.chars().all(|c| c.is_ascii_hexdigit())
        && body.chars().any(|c| c.is_ascii_digit())
}

/// Split `run` (the characters after `#`) into a sanitised tag and the
/// trailing punctuation that is not part of it.
fn split_tag(run: &str) -> (String, &str) {
    let tail_len: usize = run
        .chars()
        .rev()
        .take_while(|c| !is_edge(*c))
        .map(|c| c.len_utf8())
        .sum();
    let body = &run[..run.len() - tail_len];
    let tail = &run[run.len() - tail_len..];
    if body.is_empty() || body.chars().all(|c| c.is_ascii_digit()) || is_colour(body) {
        return (String::new(), run);
    }
    let mut tag = sanitize_tag(body, "_");
    while tag.contains("__") {
        tag = tag.replace("__", "_");
    }
    (tag, tail)
}

fn normalize_tags(content: &str) -> String {
    // `#multi word tag#` → `#multi_word_tag`
    let chars: Vec<char> = content.chars().collect();
    let mut s = String::with_capacity(content.len());
    let mut i = 0;
    while i < chars.len() {
        let boundary = i == 0 || chars[i - 1].is_whitespace();
        if chars[i] == '#' && boundary && chars.get(i + 1).is_some_and(|c| is_edge(*c)) {
            // Tag characters and spaces run up to a closing `#` (which is not
            // a tag character, so it can only be where the run stops).
            let mut end = i + 1;
            while end < chars.len() && (is_body(chars[end]) || chars[end] == ' ') {
                end += 1;
            }
            let closes = chars.get(end) == Some(&'#')
                && is_edge(chars[end - 1])
                && chars.get(end + 1).is_none_or(|c| !is_body(*c));
            if closes {
                let mut collapsed = String::new();
                let mut last_ws = false;
                for &c in &chars[i + 1..end] {
                    if c == ' ' {
                        if !last_ws {
                            collapsed.push('_');
                        }
                        last_ws = true;
                    } else {
                        collapsed.push(c);
                        last_ws = false;
                    }
                }
                s.push('#');
                s.push_str(&collapsed);
                i = end + 1;
                continue;
            }
        }
        s.push(chars[i]);
        i += 1;
    }
    // `#run` → `#sanitised_tag` + tail
    rewrite_tag_runs(&s, |run| {
        let (tag, tail) = split_tag(run);
        if tag.is_empty() {
            None
        } else {
            Some(format!("#{tag}{tail}"))
        }
    })
}

/// Apply `f` to every `#run` that starts a word (a run is the characters up
/// to whitespace, `#` or a mask). `None` leaves the run as it was.
fn rewrite_tag_runs(s: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.char_indices().peekable();
    let mut prev: Option<char> = None;
    while let Some((i, c)) = chars.next() {
        if c == '#' && prev.is_none_or(|p| p.is_whitespace()) {
            let start = i + 1;
            let mut end = start;
            while let Some(&(j, n)) = chars.peek() {
                if n.is_whitespace() || n == '#' || n == MASK {
                    break;
                }
                end = j + n.len_utf8();
                chars.next();
            }
            let run = &s[start..end];
            if !run.is_empty() {
                if let Some(rep) = f(run) {
                    out.push_str(&rep);
                    prev = run.chars().last();
                    continue;
                }
            }
            out.push('#');
            out.push_str(run);
            prev = run.chars().last().or(Some('#'));
            continue;
        }
        out.push(c);
        prev = Some(c);
    }
    out
}

fn extract_tags(content: &str, flatten: bool) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let chars: Vec<char> = content.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let boundary = i == 0 || chars[i - 1].is_whitespace();
        if chars[i] == '#' && boundary {
            let mut j = i + 1;
            while j < chars.len() && is_body(chars[j]) {
                j += 1;
            }
            // The tag ends at the last edge character of the body run.
            let mut end = j;
            while end > i + 1 && !is_edge(chars[end - 1]) {
                end -= 1;
            }
            if end > i + 1 && (end == j || !is_body(chars[end])) {
                let tag: String = chars[i + 1..end].iter().collect();
                if !is_colour(&tag) {
                    let parts: Vec<String> = if flatten && tag.contains('/') {
                        tag.split('/').map(String::from).collect()
                    } else {
                        vec![tag]
                    };
                    for p in parts {
                        if !p.is_empty() && !tags.contains(&p) {
                            tags.push(p);
                        }
                    }
                }
            }
            i = j.max(i + 1);
            continue;
        }
        i += 1;
    }
    tags
}

fn remove_tags(content: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    for line in content.split('\n') {
        let stripped = rewrite_tag_runs(line, |run| {
            let (tag, tail) = split_tag(run);
            if tag.is_empty() {
                None
            } else {
                Some(tail.to_string())
            }
        });
        // Removing a tag leaves the space before it.
        let stripped = collapse_removed_spaces(line, &stripped);
        if stripped == line {
            kept.push(line.to_string());
        } else if !stripped.trim().is_empty() {
            kept.push(stripped.trim_end().to_string());
        }
    }
    kept.join("\n").trim_end().to_string()
}

fn collapse_removed_spaces(original: &str, stripped: &str) -> String {
    if original == stripped {
        return stripped.to_string();
    }
    let mut out = String::new();
    let mut last_space = false;
    for c in stripped.chars() {
        if c == ' ' {
            if !last_space {
                out.push(c);
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::{Method, ZipWriter};

    fn info(extra: &str) -> String {
        format!(
            r#"{{"type":"net.daringfireball.markdown","version":2,"net.shinyfrog.bear":{{"modificationDate":"2023-10-11T08:10:40Z","uniqueIdentifier":"EA7C5067-B623-45E3-ABED-2B7B64B5F151","creationDate":"2023-10-11T08:08:52Z","trashed":0,"archived":0{extra}}}}}"#
        )
    }

    fn backup(bundles: &[(&str, &str, &str, &[(&str, &[u8])])]) -> Vec<u8> {
        let mut z = ZipWriter::new();
        for (name, text, info_json, assets) in bundles {
            let root = format!("Bear Notes.bear2bk/{name}.textbundle");
            z.add_text(&format!("{root}/text.md"), text);
            z.add_text(&format!("{root}/info.json"), info_json);
            for (a, data) in *assets {
                z.add(&format!("{root}/assets/{a}"), data, Method::Store);
            }
        }
        z.add_text("Bear Notes.bear2bk/tags.json", "[]");
        z.finish()
    }

    #[test]
    fn header_removed_assets_relinked_and_times_kept() {
        let zip = backup(&[
            ("File with asset", "# File with asset\n\nThis is a test with a tag\n#Test-Tag\n\n![](assets/acorn.jpeg)", &info(""), &[("acorn.jpeg", b"JPEG1")]),
            ("Other", "# A different heading\n\n![](assets/acorn.jpeg)", &info(""), &[("acorn.jpeg", b"JPEG2")]),
        ]);
        let r = convert(&zip);
        assert_eq!(
            r.text("File with asset.md"),
            "\nThis is a test with a tag\n#Test-Tag\n\n![](attachments/acorn.jpeg)"
        );
        assert_eq!(r.text("Other.md"), "# A different heading\n\n![](attachments/acorn%201.jpeg)");
        assert_eq!(r.file("attachments/acorn 1.jpeg").unwrap().data, b"JPEG2");
        let f = r.file("File with asset.md").unwrap();
        assert_eq!(f.ctime_ms, dates::parse_iso("2023-10-11T08:08:52Z"));
        assert_eq!(f.mtime_ms, dates::parse_iso("2023-10-11T08:10:40Z"));
    }

    #[test]
    fn trashed_and_archived_notes() {
        let trashed = info(r#","trashedDate":"2023-10-11T08:11:36Z""#).replace("\"trashed\":0", "\"trashed\":1");
        let archived = info(r#","archivedDate":"2023-10-11T08:12:00Z""#).replace("\"archived\":0", "\"archived\":1");
        let zip = backup(&[
            ("Trashed file", "# Trashed file\nShould be deleted", &trashed, &[]),
            ("Archived File", "Should be archived", &archived, &[]),
        ]);
        let r = convert(&zip);
        assert_eq!(r.text("trash/Trashed file.md"), "---\ntrashed: 2023-10-11T08:11:36\n---\nShould be deleted");
        assert_eq!(r.text("archive/Archived File.md"), "---\narchived: 2023-10-11T08:12:00\n---\nShould be archived");
    }

    #[test]
    fn tag_forms_bear_writes() {
        let text = "# Tag forms\n\n#two words# #项目 计划#\n\n#中文，标签 #bad!tag #FF0000 #123 #tail. `#code tag#` issue#5\n\n```\n#fenced tag#\n```";
        let zip = backup(&[("Tag forms", text, &info(""), &[])]);
        let r = convert(&zip);
        assert_eq!(
            r.text("Tag forms.md"),
            "\n#two_words #项目_计划\n\n#中文，标签 #bad_tag #FF0000 #123 #tail. `#code tag#` issue#5\n\n```\n#fenced tag#\n```"
        );
    }

    #[test]
    fn tags_as_property_are_removed_from_text() {
        let note = convert_note(
            "Text #one and #nested/tag\n#alone\nkeep #FF0000",
            "N",
            "b",
            "N.md",
            &HashMap::new(),
            &BearOptions { tags_as_property: true, flatten_tags: true, ..BearOptions::default() },
        );
        assert_eq!(note.tags, vec!["one", "nested", "tag", "alone"]);
        assert_eq!(note.content, "Text and\nkeep #FF0000");
    }

    #[test]
    fn underline_image_size_tables_and_note_links() {
        let id = "EA7C5067-B623-45E3-ABED-2B7B64B5F151";
        let text = format!("A ~underlined~ word, not ~~struck~~.\n![cat](assets/cat.png)<!-- {{\"width\":300,\"height\":200}} -->\nIntro\n| a | b |\n| --- | --- |\n[me](bear://x-callback-url/open-note?id={id})");
        let zip = backup(&[("Linked note", &text, &info(""), &[("cat.png", b"PNG")])]);
        let r = convert(&zip);
        assert_eq!(
            r.text("Linked note.md"),
            "A <u>underlined</u> word, not ~~struck~~.\n![cat|300x200](attachments/cat.png)\nIntro\n\n| a | b |\n| --- | --- |\n[me](Linked%20note)"
        );
    }

    #[test]
    fn not_a_zip_is_a_warning() {
        let r = convert(b"nope");
        assert!(r.files.is_empty() && !r.warnings.is_empty());
    }
}
