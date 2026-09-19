//! Obsidian's core Format converter, as a pure text transform.
//!
//! The plugin converts a vault's Markdown written for another app. Each option
//! here is one of its conversions (help page "Format converter"):
//!
//! - Roam Research: tags `#tag` and `#[[tag]]` → `[[tag]]`; highlights
//!   `^^x^^` → `==x==`; TODO items `{{[[TODO]]}}` → `[ ]` (and `{{TODO}}`,
//!   `{{[[DONE]]}}` → `[x]`, as Roam writes both).
//! - Bear: highlights `::x::` → `==x==`; and multi-word tags
//!   `#multi word tag#` → `#multi-word-tag` (an addition).
//! - Zettelkasten: `[[UID]]` → `[[UID File Name]]`, or the pretty form
//!   `[[UID File Name|File Name]]`, given the vault's file names.
//! - Properties: deprecated `alias`, `tag` and `cssclass` → `aliases`, `tags`,
//!   `cssclasses` lists.
//! - Markdown links to notes and local files → wikilinks (an addition; the
//!   plugin's link format setting does this for new links only).
//!
//! Fenced code blocks and inline code are never changed.

use super::mdcode::outside_code;
use super::util::{has_scheme, is_illegal_tag_char, percent_decode};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FormatConverterOptions {
    pub markdown_links_to_wikilinks: bool,
    pub roam_tags: bool,
    pub roam_highlights: bool,
    pub roam_todos: bool,
    pub bear_highlights: bool,
    pub bear_multi_word_tags: bool,
    pub zettelkasten: ZettelkastenLinks,
    /// Vault note names (without `.md`), for the Zettelkasten conversion.
    pub file_names: Vec<String>,
    pub properties: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ZettelkastenLinks {
    #[default]
    Off,
    /// `[[UID]]` → `[[UID File Name]]`
    Full,
    /// `[[UID]]` → `[[UID File Name|File Name]]`
    Pretty,
}

pub fn convert(markdown: &str, opts: &FormatConverterOptions) -> String {
    let (front, body) = split_frontmatter(markdown);
    let front = match front {
        Some(f) if opts.properties => convert_properties(f),
        Some(f) => f.to_string(),
        None => String::new(),
    };
    let body = outside_indented_code(body, |text| outside_code(text, |prose| {
        let mut s = prose.to_string();
        if opts.roam_todos {
            s = s
                .replace("{{[[TODO]]}}", "[ ]")
                .replace("{{TODO}}", "[ ]")
                .replace("{{[[DONE]]}}", "[x]")
                .replace("{{DONE}}", "[x]");
        }
        if opts.roam_highlights {
            s = replace_delimited(&s, "^^", "==", false);
        }
        if opts.bear_highlights {
            s = replace_delimited(&s, "::", "==", true);
        }
        if opts.bear_multi_word_tags {
            s = bear_tags(&s);
        }
        if opts.roam_tags {
            s = roam_tags(&s);
        }
        if opts.markdown_links_to_wikilinks {
            s = markdown_links(&s);
        }
        if opts.zettelkasten != ZettelkastenLinks::Off {
            s = zettelkasten(&s, &opts.file_names, opts.zettelkasten);
        }
        s
    }));
    format!("{front}{body}")
}

/// Indented code blocks: lines indented four spaces or a tab that follow a
/// blank line (or another such line), unless the paragraph before the blank
/// was a list item, whose continuation they would be. Fenced code is handled
/// by the rewrite itself.
fn indented_code_lines(text: &str) -> Vec<bool> {
    let lines: Vec<&str> = text.split('\n').collect();
    let fenced = super::mdcode::fence_lines(text);
    let is_list = |l: &str| {
        let t = l.trim_start();
        t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ")
            || (t.bytes().take_while(|b| b.is_ascii_digit()).count() > 0
                && t.trim_start_matches(|c: char| c.is_ascii_digit()).starts_with(". "))
    };
    let mut out = vec![false; lines.len()];
    let mut last_block_is_list = false;
    for i in 0..lines.len() {
        let line = lines[i];
        if fenced[i] {
            last_block_is_list = false;
            continue;
        }
        let indented = line.starts_with("    ") || line.starts_with('\t');
        let after_break = i == 0 || lines[i - 1].trim().is_empty() || out[i - 1];
        if indented && !line.trim().is_empty() && after_break && !last_block_is_list {
            out[i] = true;
            continue;
        }
        if !line.trim().is_empty() {
            last_block_is_list = is_list(line) || (last_block_is_list && (line.starts_with(' ') || line.starts_with('\t')));
        }
    }
    out
}

fn outside_indented_code(text: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let flags = indented_code_lines(text);
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = String::with_capacity(text.len());
    let mut start = 0;
    while start < lines.len() {
        let code = flags[start];
        let mut end = start + 1;
        while end < lines.len() && flags[end] == code {
            end += 1;
        }
        let mut seg = lines[start..end].join("\n");
        if end < lines.len() {
            seg.push('\n');
        }
        if code {
            out.push_str(&seg);
        } else {
            out.push_str(&rewrite(&seg));
        }
        start = end;
    }
    out
}

fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    if !(text.starts_with("---\n") || text.starts_with("---\r\n")) {
        return (None, text);
    }
    let mut offset = text.find('\n').unwrap() + 1;
    for line in text[offset..].split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        offset += line.len();
        if trimmed == "---" || trimmed == "..." {
            return (Some(&text[..offset]), &text[offset..]);
        }
    }
    (None, text)
}

/// `^^x^^` style: pairs of a delimiter on one line, non-empty between. With
/// `strict`, the text must hug the delimiters and the pair must not touch a
/// word character outside, so `std::vector::size` is not a highlight.
fn replace_delimited(s: &str, delim: &str, with: &str, strict: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for (i, line) in s.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let mut rest = line;
        while let Some(a) = rest.find(delim) {
            let after = &rest[a + delim.len()..];
            let ok = |b: usize| {
                let inner = &after[..b];
                if b == 0 || inner.trim().is_empty() {
                    return false;
                }
                if !strict {
                    return true;
                }
                let before = rest[..a].chars().last();
                let next = after[b + delim.len()..].chars().next();
                !inner.starts_with(char::is_whitespace)
                    && !inner.ends_with(char::is_whitespace)
                    && before.is_none_or(|c| !c.is_alphanumeric())
                    && next.is_none_or(|c| !c.is_alphanumeric())
            };
            match after.find(delim) {
                Some(b) if ok(b) => {
                    out.push_str(&rest[..a]);
                    out.push_str(with);
                    out.push_str(&after[..b]);
                    out.push_str(with);
                    rest = &after[b + delim.len()..];
                }
                _ => {
                    out.push_str(&rest[..a + delim.len()]);
                    rest = after;
                }
            }
        }
        out.push_str(rest);
    }
    out
}

fn is_tag_char(c: char) -> bool {
    !(c.is_whitespace() || is_illegal_tag_char(c))
}

fn starts_tag_boundary(prev: Option<char>) -> bool {
    // Obsidian reads a tag only after whitespace or at the start of a line:
    // `(#x)` and `](#heading)` are not tags.
    prev.is_none_or(|p| p.is_whitespace())
}

/// `#tag` and `#[[tag]]` → `[[tag]]`.
fn roam_tags(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let prev = if i == 0 { None } else { Some(chars[i - 1]) };
        if chars[i] == '#' && starts_tag_boundary(prev) {
            // #[[tag]]
            if chars.get(i + 1) == Some(&'[') && chars.get(i + 2) == Some(&'[') {
                if let Some(end) = find_seq(&chars, i + 3, &[']', ']']) {
                    let inner: String = chars[i + 3..end].iter().collect();
                    if !inner.contains('\n') && !inner.is_empty() {
                        out.push_str(&format!("[[{inner}]]"));
                        i = end + 2;
                        continue;
                    }
                }
            }
            let mut j = i + 1;
            while j < chars.len() && (is_tag_char(chars[j]) || chars[j] == '/') {
                j += 1;
            }
            let tag: String = chars[i + 1..j].iter().collect();
            if !tag.is_empty() && !tag.chars().all(|c| c.is_ascii_digit()) {
                out.push_str(&format!("[[{tag}]]"));
                i = j;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn find_seq(chars: &[char], from: usize, seq: &[char]) -> Option<usize> {
    (from..chars.len().saturating_sub(seq.len() - 1)).find(|&k| chars[k..k + seq.len()] == *seq)
}

/// `#multi word tag#` → `#multi-word-tag`; `#tag#` → `#tag`.
pub fn bear_tags(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let prev = if i == 0 { None } else { Some(chars[i - 1]) };
        if chars[i] == '#' && starts_tag_boundary(prev) && chars.get(i + 1).is_some_and(|c| is_tag_char(*c)) {
            // Find a closing '#' on the same line, with only tag characters
            // and single spaces between, not followed by a tag character.
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '\n' && chars[j] != '#' && (is_tag_char(chars[j]) || chars[j] == ' ' || chars[j] == '/') {
                j += 1;
            }
            if chars.get(j) == Some(&'#')
                && chars[j - 1] != ' '
                && chars.get(j + 1).is_none_or(|c| !is_tag_char(*c))
            {
                let inner: String = chars[i + 1..j].iter().collect();
                if !inner.contains("  ") {
                    out.push('#');
                    out.push_str(&inner.replace(' ', "-"));
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `[text](note.md)` → `[[note|text]]`; `![alt](img.png)` → `![[img.png|alt]]`.
/// URLs with a scheme are left alone.
pub fn markdown_links(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut copied = 0;
    while i < b.len() {
        if b[i] != b'[' || (i > 0 && b[i - 1] == b'\\') {
            i += 1;
            continue;
        }
        // Don't touch an existing wikilink.
        if b.get(i + 1) == Some(&b'[') || (i > 0 && b[i - 1] == b'[') {
            i += 1;
            continue;
        }
        let embed = i > 0 && b[i - 1] == b'!';
        let Some(text_end) = matching(s, i, b'[', b']') else {
            i += 1;
            continue;
        };
        if b.get(text_end + 1) != Some(&b'(') {
            i += 1;
            continue;
        }
        let Some(dest_end) = matching(s, text_end + 1, b'(', b')') else {
            i += 1;
            continue;
        };
        let text = &s[i + 1..text_end];
        let mut dest = s[text_end + 2..dest_end].trim();
        if text.contains('\n') || dest.contains('\n') {
            i += 1;
            continue;
        }
        if let Some(inner) = dest.strip_prefix('<').and_then(|d| d.split_once('>')) {
            dest = inner.0;
        } else if let Some((d, _title)) = dest.split_once(" \"") {
            dest = d;
        }
        if dest.is_empty() || has_scheme(dest) {
            i = dest_end + 1;
            continue;
        }
        let decoded = percent_decode(dest);
        let (path, fragment) = match decoded.split_once('#') {
            Some((p, f)) => (p.to_string(), format!("#{f}")),
            None => (decoded.clone(), String::new()),
        };
        let path = path.strip_prefix("./").unwrap_or(&path);
        let target_path = path.strip_suffix(".md").unwrap_or(path);
        let target = format!("{target_path}{fragment}");
        let shown_name = target_path.rsplit('/').next().unwrap_or(target_path);
        let link = if embed {
            if text.is_empty() {
                format!("[[{target}]]")
            } else {
                format!("[[{target}|{text}]]")
            }
        } else if text == target || text == shown_name || text.is_empty() {
            format!("[[{target}]]")
        } else {
            format!("[[{target}|{text}]]")
        };
        out.push_str(&s[copied..i]);
        out.push_str(&link);
        i = dest_end + 1;
        copied = i;
    }
    out.push_str(&s[copied..]);
    out
}

fn matching(s: &str, open_at: usize, open: u8, close: u8) -> Option<usize> {
    let b = s.as_bytes();
    let mut depth = 0;
    for (k, &c) in b.iter().enumerate().skip(open_at) {
        if c == b'\\' {
            continue;
        }
        if c == b'\n' {
            return None;
        }
        if c == open && (k == 0 || b[k - 1] != b'\\') {
            depth += 1;
        } else if c == close && (k == 0 || b[k - 1] != b'\\') {
            depth -= 1;
            if depth == 0 {
                return Some(k);
            }
        }
    }
    None
}

fn zettelkasten(s: &str, files: &[String], mode: ZettelkastenLinks) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(a) = rest.find("[[") {
        out.push_str(&rest[..a]);
        let after = &rest[a + 2..];
        let Some(b) = after.find("]]") else {
            out.push_str("[[");
            rest = after;
            continue;
        };
        let inner = &after[..b];
        let is_uid = inner.len() >= 6 && inner.bytes().all(|c| c.is_ascii_digit());
        let file = if is_uid {
            files.iter().find(|f| {
                let name = f.rsplit('/').next().unwrap_or(f);
                let name = name.strip_suffix(".md").unwrap_or(name);
                name.len() > inner.len() + 1 && name.starts_with(inner) && name.as_bytes()[inner.len()] == b' '
            })
        } else {
            None
        };
        match file {
            Some(f) => {
                let name = f.rsplit('/').next().unwrap_or(f);
                let name = name.strip_suffix(".md").unwrap_or(name);
                let title = name[inner.len() + 1..].trim();
                match mode {
                    ZettelkastenLinks::Pretty => out.push_str(&format!("[[{name}|{title}]]")),
                    _ => out.push_str(&format!("[[{name}]]")),
                }
            }
            None => {
                out.push_str("[[");
                out.push_str(inner);
                out.push_str("]]");
            }
        }
        rest = &after[b + 2..];
    }
    out.push_str(rest);
    out
}

/// `alias`/`tag`/`cssclass` → `aliases`/`tags`/`cssclasses` lists.
fn convert_properties(front: &str) -> String {
    let lines: Vec<&str> = front.lines().collect();
    if lines.len() < 2 {
        return front.to_string();
    }
    let body = &lines[1..lines.len() - 1];
    // Group top-level keys with their indented continuation lines.
    let mut entries: Vec<(String, Vec<String>)> = Vec::new();
    for line in body {
        let top_level = !line.starts_with(' ') && !line.starts_with('\t') && !line.starts_with('-');
        if top_level {
            if let Some((k, v)) = line.split_once(':') {
                entries.push((k.trim().to_string(), vec![v.trim().to_string()]));
                continue;
            }
        }
        if let Some(last) = entries.last_mut() {
            last.1.push(line.to_string());
        } else {
            entries.push((String::new(), vec![line.to_string()]));
        }
    }
    let renames = [("alias", "aliases"), ("tag", "tags"), ("cssclass", "cssclasses")];
    let mut values: Vec<(String, Vec<String>)> = Vec::new();
    let mut other: Vec<(String, Vec<String>)> = Vec::new();
    for (k, v) in entries {
        if let Some((_, new)) = renames.iter().find(|(old, new)| k == *old || k == *new) {
            let items = list_items(&v, *new == "tags");
            if let Some(existing) = values.iter_mut().find(|(n, _)| n == new) {
                for it in items {
                    if !existing.1.contains(&it) {
                        existing.1.push(it);
                    }
                }
            } else {
                values.push((new.to_string(), items));
                other.push((format!("\u{0}{new}"), Vec::new()));
            }
        } else {
            other.push((k, v));
        }
    }
    let mut out = String::from("---\n");
    for (k, v) in other {
        if let Some(name) = k.strip_prefix('\u{0}') {
            let items = &values.iter().find(|(n, _)| n == name).unwrap().1;
            out.push_str(name);
            out.push_str(":\n");
            for it in items {
                out.push_str("  - ");
                out.push_str(&super::yaml::scalar(it));
                out.push('\n');
            }
            continue;
        }
        if k.is_empty() {
            for l in v {
                out.push_str(&l);
                out.push('\n');
            }
            continue;
        }
        out.push_str(&k);
        out.push(':');
        let first = &v[0];
        if !first.is_empty() {
            out.push(' ');
            out.push_str(first);
        }
        out.push('\n');
        for l in &v[1..] {
            out.push_str(l);
            out.push('\n');
        }
    }
    out.push_str(lines[lines.len() - 1]);
    out.push('\n');
    out
}

fn list_items(v: &[String], split_spaces: bool) -> Vec<String> {
    let unquote = |s: &str| -> String {
        let s = s.trim();
        if s.len() >= 2 && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\''))) {
            s[1..s.len() - 1].to_string()
        } else {
            s.to_string()
        }
    };
    let mut items = Vec::new();
    let first = v[0].trim();
    let inline = first.strip_prefix('[').and_then(|x| x.strip_suffix(']')).unwrap_or(first);
    for part in inline.split(',') {
        let p = unquote(part);
        if split_spaces {
            items.extend(p.split_whitespace().map(|t| t.trim_start_matches('#').to_string()));
        } else if !p.is_empty() {
            items.push(p);
        }
    }
    for l in &v[1..] {
        if let Some(item) = l.trim().strip_prefix("- ") {
            let it = unquote(item);
            if !it.is_empty() {
                items.push(if split_spaces { it.trim_start_matches('#').to_string() } else { it });
            }
        }
    }
    items.retain(|s| !s.is_empty());
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> FormatConverterOptions {
        FormatConverterOptions {
            markdown_links_to_wikilinks: true,
            roam_tags: true,
            roam_highlights: true,
            roam_todos: true,
            bear_highlights: true,
            bear_multi_word_tags: true,
            properties: true,
            ..Default::default()
        }
    }

    #[test]
    fn roam_syntax() {
        let o = FormatConverterOptions { roam_tags: true, roam_highlights: true, roam_todos: true, ..Default::default() };
        assert_eq!(
            convert("{{[[TODO]]}} call #mum about #[[the trip]] ^^soon^^\n{{[[DONE]]}} issue #42", &o),
            "[ ] call [[mum]] about [[the trip]] ==soon==\n[x] issue #42"
        );
        assert_eq!(convert("# Heading\nurl http://x.com/#frag", &o), "# Heading\nurl http://x.com/#frag");
    }

    #[test]
    fn bear_syntax() {
        let o = FormatConverterOptions { bear_highlights: true, bear_multi_word_tags: true, ..Default::default() };
        assert_eq!(
            convert("::marked:: text #multi word tag# and #simple#, #not closed", &o),
            "==marked== text #multi-word-tag and #simple, #not closed"
        );
        assert_eq!(convert("std::vector is not :: a highlight", &o), "std::vector is not :: a highlight");
    }

    #[test]
    fn code_is_immune() {
        let text = "`^^x^^ #tag [a](b.md)`\n```\n{{[[TODO]]}} ::y:: #a b#\n```\n~~~\n[l](n.md)\n~~~\n^^z^^";
        assert_eq!(
            convert(text, &all()),
            "`^^x^^ #tag [a](b.md)`\n```\n{{[[TODO]]}} ::y:: #a b#\n```\n~~~\n[l](n.md)\n~~~\n==z=="
        );
    }

    // Regression from obsidian-importer's tests/markdown/code.md.
    #[test]
    fn indented_code_is_immune_but_list_continuations_are_not() {
        let o = FormatConverterOptions { roam_tags: true, ..Default::default() };
        assert_eq!(
            convert("Para #a\n\n    #indented code\n\n- item\n\n    continued #b\n", &o),
            "Para [[a]]\n\n    #indented code\n\n- item\n\n    continued [[b]]\n"
        );
        assert_eq!(convert("left alone (#unclaimed) and [x](#heading)", &o), "left alone (#unclaimed) and [x](#heading)");
    }

    #[test]
    fn markdown_links_become_wikilinks() {
        let o = FormatConverterOptions { markdown_links_to_wikilinks: true, ..Default::default() };
        assert_eq!(
            convert("See [Other Note](Other%20Note.md), [alias](folder/Note.md#Head), [Note](./Note.md), ![cat](img/cat%201.png), ![](a.pdf), [web](https://x.com/a.md), [[Already]] and [plain] text.", &o),
            "See [[Other Note]], [[folder/Note#Head|alias]], [[Note]], ![[img/cat 1.png|cat]], ![[a.pdf]], [web](https://x.com/a.md), [[Already]] and [plain] text."
        );
        assert_eq!(convert("[t](<my note.md> \"title\")", &o), "[[my note|t]]");
    }

    #[test]
    fn zettelkasten_links() {
        let files = vec!["202001011200 First idea".to_string(), "sub/202001021300 Second.md".to_string()];
        let full = FormatConverterOptions { zettelkasten: ZettelkastenLinks::Full, file_names: files.clone(), ..Default::default() };
        let pretty = FormatConverterOptions { zettelkasten: ZettelkastenLinks::Pretty, file_names: files, ..Default::default() };
        assert_eq!(convert("[[202001011200]] and [[202001021300]] [[999999999999]]", &full), "[[202001011200 First idea]] and [[202001021300 Second]] [[999999999999]]");
        assert_eq!(convert("[[202001011200]]", &pretty), "[[202001011200 First idea|First idea]]");
    }

    #[test]
    fn deprecated_properties() {
        let o = FormatConverterOptions { properties: true, ..Default::default() };
        let input = "---\ntitle: X\nalias: My Note Title\ntag: project, important\ncssclass: custom-style\ntags:\n  - existing\n---\nbody alias: not frontmatter\n";
        assert_eq!(
            convert(input, &o),
            "---\ntitle: X\naliases:\n  - My Note Title\ntags:\n  - project\n  - important\n  - existing\ncssclasses:\n  - custom-style\n---\nbody alias: not frontmatter\n"
        );
        assert_eq!(convert("no frontmatter\n", &o), "no frontmatter\n");
        assert_eq!(convert("---\ntag: [a, \"b c\"]\n---\n", &o), "---\ntags:\n  - a\n  - b\n  - c\n---\n");
    }
}
