//! Frontmatter: the YAML block at the very top of a note (Properties.md),
//! and the links inside its values.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use vault_types::{FrontmatterLinkCache, Pos};

use crate::linktext::{is_local, parse_wikilink};
use crate::util::decode_uri;

/// `parse_frontmatter`'s result.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Frontmatter {
    /// The properties, when the YAML parsed to a mapping.
    pub data: Option<Map<String, Value>>,
    /// From the opening `---` to the end of the closing `---`.
    pub position: Option<Pos>,
    /// Byte offset of the first character after the closing line's newline
    /// (0 when there is no frontmatter).
    pub body_start_byte: usize,
    /// The YAML error, when the block exists but does not parse. Obsidian
    /// shows no properties at all in that case, never half of them.
    pub error: Option<String>,
}

/// Find a frontmatter block in text whose line endings are already `\n`.
/// Returns the YAML between the fences and the byte length up to the end of
/// the closing `---` (excluding its newline).
///
/// The block must start on the first line with `---` alone, and end at the
/// next line that is `---` alone; trailing spaces are tolerated on both.
/// Without a closing fence there is no frontmatter and the `---` is ordinary
/// markdown (a thematic break).
pub(crate) fn split(text: &str) -> Option<(&str, usize)> {
    let first_end = text.find('\n')?;
    if text[..first_end].trim_end_matches([' ', '\t']) != "---" {
        return None;
    }
    let body = first_end + 1;
    let mut line_start = body;
    loop {
        let line_end = text[line_start..].find('\n').map(|i| line_start + i).unwrap_or(text.len());
        if text[line_start..line_end].trim_end_matches([' ', '\t']) == "---" {
            let yaml = if line_start > body { &text[body..line_start - 1] } else { "" };
            return Some((yaml, line_end));
        }
        if line_end >= text.len() {
            return None;
        }
        line_start = line_end + 1;
    }
}

/// Parse the frontmatter of a note.
pub fn parse_frontmatter(text: &str) -> Frontmatter {
    let normalized;
    let (norm, crlf): (&str, bool) = if text.contains('\r') {
        normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        (&normalized, true)
    } else {
        (text, false)
    };
    let bom = if norm.starts_with('\u{FEFF}') { 3 } else { 0 };
    let Some((yaml, end)) = split(&norm[bom..]) else { return Frontmatter::default() };
    let end_norm = bom + end;
    // Map the normalised end back to the original text: each line break
    // before it may have been two bytes.
    let end_orig = if crlf { map_normalized_offset(text, end_norm) } else { end_norm };
    let index = vault_types::LineIndex::new(text);
    let position = Pos { start: index.loc(text, 0), end: index.loc(text, end_orig) };
    let b = text.as_bytes();
    let body_start_byte = match b.get(end_orig) {
        Some(b'\r') if b.get(end_orig + 1) == Some(&b'\n') => end_orig + 2,
        Some(b'\r') | Some(b'\n') => end_orig + 1,
        _ => end_orig,
    };
    let (data, error) = match crate::yaml::parse(yaml) {
        Ok(Value::Object(map)) => (Some(map), None),
        Ok(_) => (None, None),
        Err(e) => (None, Some(e.to_string())),
    };
    Frontmatter { data, position: Some(position), body_start_byte, error }
}

/// Byte offset in `original` corresponding to `n` bytes of its
/// line-ending-normalised form.
pub(crate) fn map_normalized_offset(original: &str, n: usize) -> usize {
    let b = original.as_bytes();
    let (mut i, mut k) = (0, 0);
    while k < n && i < b.len() {
        if b[i] == b'\r' && b.get(i + 1) == Some(&b'\n') {
            i += 2;
        } else {
            i += 1;
        }
        k += 1;
    }
    i
}

/// The YAML of a frontmatter block as an object, if it is one.
pub(crate) fn yaml_object(yaml: &str) -> Option<Map<String, Value>> {
    match crate::yaml::parse(yaml) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// Links in property values. A string value that is entirely one wikilink
/// (`"[[Note|alias]]"`) or one markdown link to a local path counts; the key
/// is the property path, dotted through nested maps and list indices
/// (`related.0`, `project.owner`), which is what plugins that read
/// `frontmatterLinks` (e.g. Frontmatter Markdown Links) match against.
pub(crate) fn frontmatter_links(map: &Map<String, Value>) -> Vec<FrontmatterLinkCache> {
    let mut out = Vec::new();
    for (k, v) in map {
        walk(k.clone(), v, &mut out);
    }
    out
}

fn walk(key: String, v: &Value, out: &mut Vec<FrontmatterLinkCache>) {
    match v {
        Value::String(s) => {
            if s.starts_with("[[") && s.ends_with("]]") && s.len() >= 4 {
                let w = parse_wikilink(&s[2..s.len() - 2]);
                out.push(FrontmatterLinkCache { key, link: w.href, original: s.clone(), display_text: Some(w.title) });
            } else if let Some((text, dest)) = whole_markdown_link(s) {
                if is_local(&dest) {
                    let link = decode_uri(&dest).unwrap_or(dest);
                    out.push(FrontmatterLinkCache { key, link, original: s.clone(), display_text: Some(text) });
                }
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                walk(format!("{key}.{i}"), item, out);
            }
        }
        Value::Object(m) => {
            for (k, item) in m {
                walk(format!("{key}.{k}"), item, out);
            }
        }
        _ => {}
    }
}

/// `[text](dest)` or `[text](<dest with spaces>)`, optionally with a title,
/// spanning the whole string.
fn whole_markdown_link(s: &str) -> Option<(String, String)> {
    let rest = s.strip_prefix('[')?;
    let close = rest.find("](")?;
    let text = &rest[..close];
    let inner = rest[close + 2..].strip_suffix(')')?.trim();
    let dest = if let Some(r) = inner.strip_prefix('<') {
        r[..r.find('>')?].trim().to_string()
    } else {
        let d = inner.split_whitespace().next()?;
        d.to_string()
    };
    if dest.is_empty() {
        return None;
    }
    Some((text.to_string(), dest))
}
