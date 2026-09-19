//! Google Keep, from a Google Takeout export.
//!
//! Mirrors obsidian-importer's Keep importer. Takeout writes one JSON file per
//! note plus its attachments (and an HTML copy of each note, which is
//! ignored). Zips are read, including the whole Takeout archive.
//!
//! - The note is named after its JSON file; a title that differs becomes
//!   `aliases` (one per line of a multi-line title).
//! - `tags`: `Keep/Color/<Colour>`, `Keep/Pinned`, `Keep/Task`,
//!   `Keep/Attachment`, `Keep/Archived`, `Keep/Deleted` and
//!   `Keep/Label/<label>`, sanitised for Obsidian (spaces become `-`).
//! - Text comes from `textContentHtml` when it has formatting (bold, italic,
//!   strike-through and underline arrive as inline CSS and are converted),
//!   otherwise `textContent`; `listContent` becomes `- [ ]`/`- [X]` items; a
//!   `#label` written in the text is rewritten to the sanitised tag.
//! - Attachments are copied to `attachments/` and embedded; annotations (saved
//!   links) become an `## Annotations` list.
//! - Archived and trashed notes are skipped unless asked for; file times come
//!   from `createdTimestampUsec` and `userEditedTimestampUsec`.

use super::markup::{style_value, Doc, Id};
use super::mdcode::outside_fences;
use super::util::{
    basename, extension_lower, is_illegal_tag_char, sanitize_file_name, split_ext, Tokens,
    UniquePaths,
};
use super::yaml::{frontmatter, Yaml};
use super::{ImportResult, ImportedFile, LinkResolver};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KeepOptions {
    pub import_archived: bool,
    pub import_trashed: bool,
    /// Obsidian's "strict line breaks": end every line with two spaces.
    pub strict_line_breaks: bool,
    pub attachment_folder: String,
}

impl Default for KeepOptions {
    fn default() -> Self {
        KeepOptions {
            import_archived: false,
            import_trashed: false,
            strict_line_breaks: false,
            attachment_folder: "attachments".into(),
        }
    }
}

const ATTACHMENT_EXTS: &[&str] = &[
    "png", "webp", "jpg", "jpeg", "gif", "bmp", "svg", "avif", "mp3", "wav", "m4a", "3gp", "flac",
    "ogg", "oga", "opus", "mp4", "webm", "ogv", "mov", "mkv", "mpg", "pdf", "amr",
];

/// Convert Takeout files (JSON notes, attachments, or zips of them) with the
/// default options.
pub fn convert(files: &[(String, Vec<u8>)]) -> ImportResult {
    convert_with(files, &KeepOptions::default())
}

pub fn convert_with(files: &[(String, Vec<u8>)], opts: &KeepOptions) -> ImportResult {
    let mut result = ImportResult::default();
    let mut flat: Vec<(String, Vec<u8>)> = Vec::new();
    for (path, data) in files {
        if extension_lower(path) == "zip" {
            match crate::zip::read_zip(data) {
                Ok(entries) => flat.extend(
                    entries
                        .into_iter()
                        .filter(|e| !e.is_dir)
                        .map(|e| (e.name, e.data)),
                ),
                Err(e) => result.warnings.push(format!("{path}: {e}")),
            }
        } else {
            flat.push((path.clone(), data.clone()));
        }
    }
    flat.retain(|(p, _)| {
        let name = basename(p);
        !(name.starts_with("._") || p.contains("__MACOSX/") || name == ".DS_Store")
    });

    let mut paths = UniquePaths::new();
    let attachment_dir = opts.attachment_folder.trim_matches('/').to_string();
    // name (lowercase) → output path; also stem → path for the `.jpeg`/`.jpg`
    // mismatch Takeout writes.
    let mut by_name: HashMap<String, String> = HashMap::new();
    let mut by_stem: HashMap<String, String> = HashMap::new();
    let mut attachments: Vec<ImportedFile> = Vec::new();
    let mut written: HashMap<(String, usize), String> = HashMap::new();
    for (path, data) in &flat {
        if !ATTACHMENT_EXTS.contains(&extension_lower(path).as_str()) {
            continue;
        }
        let name = sanitize_file_name(basename(path));
        let key = (name.to_lowercase(), data.len());
        let out = match written.get(&key) {
            Some(p) => p.clone(),
            None => {
                let p = paths.claim(&attachment_dir, &name);
                written.insert(key, p.clone());
                attachments.push(ImportedFile::new(p.clone(), data.clone()));
                p
            }
        };
        by_name.insert(basename(path).to_lowercase(), out.clone());
        by_stem
            .entry(split_ext(basename(path)).0.to_lowercase())
            .or_insert(out);
    }

    struct Draft {
        path: String,
        body: String,
        attachments: Vec<String>,
        tail: String,
        ctime: i64,
        mtime: i64,
    }
    let mut drafts: Vec<Draft> = Vec::new();
    for (path, data) in &flat {
        let ext = extension_lower(path);
        if ext != "json" {
            if !ATTACHMENT_EXTS.contains(&ext.as_str()) && !matches!(ext.as_str(), "html" | "txt") {
                result.warnings.push(format!("Skipped {path}: not a Keep note or attachment"));
            }
            continue;
        }
        let text = super::util::decode_text(data);
        let Ok(note) = serde_json::from_str::<Value>(&text) else {
            result.warnings.push(format!("Skipped {path}: not valid JSON"));
            continue;
        };
        let created = note.get("createdTimestampUsec").and_then(|v| v.as_f64());
        let edited = note.get("userEditedTimestampUsec").and_then(|v| v.as_f64());
        let (Some(created), Some(edited)) = (created, edited) else {
            result.warnings.push(format!("Skipped {path}: not a Google Keep note"));
            continue;
        };
        if created <= 0.0 || edited < 0.0 {
            result.warnings.push(format!("Skipped {path}: not a Google Keep note"));
            continue;
        }
        let flag = |k: &str| note.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
        if flag("isArchived") && !opts.import_archived {
            result.warnings.push(format!("Skipped {path}: archived"));
            continue;
        }
        if flag("isTrashed") && !opts.import_trashed {
            result.warnings.push(format!("Skipped {path}: in the trash"));
            continue;
        }
        let file_stem = split_ext(basename(path)).0.to_string();
        let (body, tail, embeds) = convert_note(&note, &file_stem, opts);
        let note_path = paths.claim("", &format!("{}.md", sanitize_file_name(&file_stem)));
        let attachment_paths = embeds
            .iter()
            .map(|fp| {
                let name = basename(fp).to_lowercase();
                by_name
                    .get(&name)
                    .or_else(|| by_stem.get(split_ext(&name).0))
                    .cloned()
                    .unwrap_or_else(|| {
                        result
                            .warnings
                            .push(format!("{path}: attachment {fp} is not in the export"));
                        fp.clone()
                    })
            })
            .collect();
        let ctime = (created / 1000.0) as i64;
        let mtime = if edited > 0.0 { (edited / 1000.0) as i64 } else { ctime };
        drafts.push(Draft {
            path: note_path,
            body,
            attachments: attachment_paths,
            tail,
            ctime,
            mtime,
        });
    }

    let resolver = LinkResolver::new(
        drafts
            .iter()
            .map(|d| d.path.as_str())
            .chain(attachments.iter().map(|a| a.path.as_str())),
    );
    for d in drafts {
        let mut content = d.body;
        if !d.attachments.is_empty() {
            content.push_str("\n\n");
            for a in &d.attachments {
                content.push_str(&format!("![[{}]]", resolver.link(a)));
            }
        }
        content.push_str(&d.tail);
        result
            .files
            .push(ImportedFile::note(d.path, content).with_times(Some(d.ctime), Some(d.mtime)));
    }
    result.files.extend(attachments);
    result
}

/// (body up to the attachments, annotations tail, attachment file paths)
fn convert_note(note: &Value, file_stem: &str, opts: &KeepOptions) -> (String, String, Vec<String>) {
    let s = |k: &str| note.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let flag = |k: &str| note.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
    let mut props: Vec<(String, Yaml)> = Vec::new();
    let title = s("title");
    if !title.is_empty() {
        let aliases: Vec<&str> = title.split('\n').filter(|a| *a != file_stem).collect();
        if !aliases.is_empty() {
            props.push(("aliases".into(), Yaml::list(aliases)));
        }
    }
    let labels: Vec<String> = note
        .get("labels")
        .and_then(|l| l.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|l| l.get("name").and_then(|n| n.as_str()))
                .filter(|n| !n.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let mut tags: Vec<String> = Vec::new();
    let color = s("color");
    if !color.is_empty() && color != "DEFAULT" {
        let lower = color.to_lowercase();
        let mut c = lower.chars();
        let sentence: String = c
            .next()
            .map(|f| f.to_uppercase().chain(c).collect())
            .unwrap_or_default();
        tags.push(format!("Keep/Color/{sentence}"));
    }
    if flag("isPinned") {
        tags.push("Keep/Pinned".into());
    }
    if note.get("tasks").and_then(|t| t.as_array()).is_some_and(|t| !t.is_empty()) {
        tags.push("Keep/Task".into());
    }
    if note.get("attachments").is_some_and(|a| !a.is_null()) {
        tags.push("Keep/Attachment".into());
    }
    if flag("isArchived") {
        tags.push("Keep/Archived".into());
    }
    if flag("isTrashed") {
        tags.push("Keep/Deleted".into());
    }
    for l in &labels {
        tags.push(format!("Keep/Label/{l}"));
    }
    if !tags.is_empty() {
        props.push((
            "tags".into(),
            Yaml::list(tags.iter().map(|t| keep_tag(t))),
        ));
    }

    let mut out = frontmatter(&props);
    let text_html = s("textContentHtml");
    let note_text = if !text_html.is_empty() {
        format_html(text_html, note.get("textContent").and_then(|v| v.as_str()), false)
    } else {
        s("textContent").to_string()
    };
    if !note_text.is_empty() {
        let mut text = sanitize_tags(&note_text, &labels);
        if opts.strict_line_breaks {
            text = outside_fences(&text, |seg| {
                let lines: Vec<&str> = seg.split('\n').collect();
                let n = lines.len();
                lines
                    .iter()
                    .enumerate()
                    .map(|(i, l)| {
                        let l = l.strip_suffix('\r').unwrap_or(l);
                        if i + 1 < n && !l.ends_with("  ") {
                            format!("{l}  ")
                        } else {
                            l.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
        }
        out.push('\n');
        out.push_str(&text);
    }
    if let Some(items) = note.get("listContent").and_then(|l| l.as_array()) {
        let lines: Vec<String> = items
            .iter()
            .filter_map(|item| {
                let text = item.get("text").and_then(|v| v.as_str());
                let html = item.get("textHtml").and_then(|v| v.as_str()).unwrap_or("");
                let rendered = if !html.is_empty() {
                    flatten_list_item(&format_html(html, text, true))
                } else {
                    flatten_list_item(text.unwrap_or(""))
                };
                if rendered.is_empty() {
                    return None;
                }
                let checked = item.get("isChecked").and_then(|v| v.as_bool()).unwrap_or(false);
                Some(sanitize_tags(
                    &format!("- [{}] {rendered}", if checked { "X" } else { " " }),
                    &labels,
                ))
            })
            .collect();
        out.push_str("\n\n");
        out.push_str(&lines.join("\n"));
    }
    let embeds: Vec<String> = note
        .get("attachments")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.get("filePath").and_then(|p| p.as_str()))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let annotations = format_annotations(note.get("annotations"));
    let tail = if annotations.is_empty() {
        String::new()
    } else {
        format!("\n\n{annotations}")
    };
    (out, tail, embeds)
}

/// Keep's `sanitizeTag`: illegal characters removed, spaces to `-`, and a
/// leading digit prefixed with `_` (Obsidian tags cannot start with one).
fn keep_tag(name: &str) -> String {
    let stripped: String = name
        .trim_start_matches('#')
        .chars()
        .filter(|c| !is_illegal_tag_char(*c))
        .collect();
    let t = stripped.replace(' ', "-");
    if t.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("_{t}")
    } else {
        t
    }
}

/// Rewrite `#label` mentions of the note's own labels to their tag form.
fn sanitize_tags(text: &str, labels: &[String]) -> String {
    let mut unique: Vec<&String> = Vec::new();
    for l in labels {
        if !unique.contains(&l) {
            unique.push(l);
        }
    }
    unique.sort_by_key(|l| std::cmp::Reverse(l.chars().count()));
    let mut s = text.to_string();
    for label in unique {
        let needle = format!("#{label}");
        let tag = format!("#{}", keep_tag(label));
        let mut out = String::with_capacity(s.len());
        let mut rest: &str = &s;
        loop {
            let Some(at) = rest.find(&needle) else {
                out.push_str(rest);
                break;
            };
            let head = &rest[..at];
            // An escaping backslash before the `#` is dropped with it.
            let head_kept = head.strip_suffix('\\').unwrap_or(head);
            let prev = head_kept.chars().last().or_else(|| out.chars().last());
            let prefix_ok = prev.is_none_or(|c| !(c.is_alphanumeric() || "_/#:?&=%-".contains(c)));
            let after = &rest[at + needle.len()..];
            let next_ok = after
                .chars()
                .next()
                .is_none_or(|c| !(c.is_alphanumeric() || "_/-".contains(c)));
            if prefix_ok && next_ok {
                out.push_str(head_kept);
                out.push_str(&tag);
                rest = after;
            } else {
                out.push_str(&rest[..at + 1]);
                rest = &rest[at + 1..];
            }
        }
        s = out;
    }
    s
}

/// A list item is one line: each run of line breaks (blank lines included)
/// becomes one `<br>`.
fn flatten_list_item(markdown: &str) -> String {
    let mut out = String::new();
    let mut in_break = false;
    let mut pending_ws = String::new();
    for c in markdown.chars() {
        match c {
            '\n' => {
                if !in_break {
                    out.push_str("<br>");
                }
                in_break = true;
                pending_ws.clear();
            }
            '\r' => {}
            ' ' | '\t' if in_break => pending_ws.push(c),
            c => {
                if in_break {
                    out.push_str(&pending_ws);
                    pending_ws.clear();
                }
                in_break = false;
                out.push(c);
            }
        }
    }
    out
}

fn wraps_bold(style: &str) -> bool {
    style_value(style, "font-weight").is_some_and(|w| w == "bold" || w.parse::<u32>().is_ok_and(|n| n >= 600))
}

fn format_html(html: &str, plain: Option<&str>, list_item: bool) -> String {
    let mut doc = Doc::parse_html(html);
    let root = doc.root;
    let has_formatting = {
        let semantic = [
            "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "strike", "del",
            "mark", "blockquote", "ul", "ol", "pre", "code", "table", "hr",
        ];
        doc.descendants(root).into_iter().any(|id| {
            let Some(name) = doc.name(id) else {
                return false;
            };
            if semantic.contains(&name) || (name == "img" && doc.attr(id, "src").is_some()) {
                return true;
            }
            if name == "a" {
                if let Some(href) = doc.attr(id, "href") {
                    if doc.text_content(id) != href {
                        return true;
                    }
                }
            }
            doc.attr(id, "style").is_some_and(|st| {
                wraps_bold(st)
                    || style_value(st, "font-style").is_some_and(|v| v == "italic" || v == "oblique")
                    || style_value(st, "text-decoration").is_some_and(|v| v.contains("line-through") || v.contains("underline"))
            })
        })
    };
    if let Some(p) = plain {
        if !p.trim().is_empty() && !has_formatting {
            return p.to_string();
        }
    }
    if list_item {
        for h in doc.descendants(root) {
            if matches!(doc.name(h), Some("h1" | "h2" | "h3" | "h4" | "h5" | "h6")) {
                doc.rename(h, "p");
            }
        }
    }
    let mut tokens = Tokens::new();
    let has_ancestor = |doc: &Doc, id: Id, names: &[&str]| -> bool {
        let mut cur = Some(id);
        while let Some(c) = cur {
            if doc.name(c).is_some_and(|n| names.contains(&n)) {
                return true;
            }
            cur = doc.parent(c);
        }
        false
    };
    for id in doc.descendants(root) {
        let Some(style) = doc.attr(id, "style").map(str::to_string) else {
            continue;
        };
        let decoration = style_value(&style, "text-decoration").unwrap_or_default();
        if !doc.children(id).is_empty() {
            if wraps_bold(&style) && !has_ancestor(&doc, id, &["b", "strong", "h1", "h2", "h3", "h4", "h5", "h6"]) {
                doc.wrap_children(id, "strong");
            }
            if style_value(&style, "font-style").is_some_and(|v| v == "italic" || v == "oblique")
                && !has_ancestor(&doc, id, &["i", "em"])
            {
                doc.wrap_children(id, "em");
            }
            if decoration.contains("line-through") && !has_ancestor(&doc, id, &["s", "strike", "del"]) {
                doc.wrap_children(id, "del");
            }
            if decoration.contains("underline") && !has_ancestor(&doc, id, &["u"]) {
                doc.wrap_children(id, "u");
            }
        }
        doc.remove_attr(id, "style");
    }
    for u in doc.find_all(root, "u") {
        if doc.parent(u).is_some_and(|p| has_ancestor(&doc, p, &["u"])) {
            doc.unwrap(u);
            continue;
        }
        let open = tokens.add("<u>");
        let close = tokens.add("</u>");
        let o = doc.create_text(&open);
        let c = doc.create_text(&close);
        doc.prepend(u, o);
        doc.append(u, c);
        doc.unwrap(u);
    }
    let md = crate::html_to_markdown(&doc.inner_html(root), None);
    let md = tokens.replace(md.trim());
    if md.is_empty() {
        plain.unwrap_or("").to_string()
    } else {
        md
    }
}

fn format_annotations(annotations: Option<&Value>) -> String {
    let norm = |v: Option<&Value>| -> String {
        v.and_then(|x| x.as_str())
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let escape = |t: &str| -> String {
        let mut o = String::new();
        for c in t.chars() {
            if "\\`*_[]<>".contains(c) {
                o.push('\\');
            }
            o.push(c);
        }
        o
    };
    let url_of = |u: &str| format!("<{}>", u.replace('<', "%3C").replace('>', "%3E"));
    let mut items = Vec::new();
    for a in annotations.and_then(|a| a.as_array()).into_iter().flatten() {
        let title = norm(a.get("title"));
        let url = norm(a.get("url"));
        let description = norm(a.get("description"));
        let primary = if !title.is_empty() && !url.is_empty() {
            format!("[{}]({})", escape(&title), url_of(&url))
        } else if !url.is_empty() {
            url_of(&url)
        } else if !title.is_empty() {
            escape(&title)
        } else {
            escape(&description)
        };
        if primary.is_empty() {
            continue;
        }
        items.push(format!("- {primary}"));
        if !description.is_empty() && description != title && escape(&description) != primary {
            items.push(format!("  {}", escape(&description)));
        }
    }
    if items.is_empty() {
        String::new()
    } else {
        format!("## Annotations\n\n{}", items.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[(&str, &str)]) -> Vec<(String, Vec<u8>)> {
        list.iter().map(|(p, d)| (p.to_string(), d.as_bytes().to_vec())).collect()
    }

    #[test]
    fn image_label_and_body_matches_importer() {
        let r = convert(&files(&[
            ("Takeout/Keep/Image, label, and body text note.json", r#"{"attachments":[{"filePath":"1690514572032.76900194.png","mimetype":"image/png"}],"color":"BLUE","isTrashed":false,"isPinned":false,"isArchived":false,"textContent":"This is the body text.","title":"Image, label, and body text note","userEditedTimestampUsec":1690866236591000,"createdTimestampUsec":1690514572858000,"labels":[{"name":"label"}]}"#),
            ("Takeout/Keep/1690514572032.76900194.png", "PNGDATA"),
            ("Takeout/Keep/Image, label, and body text note.html", "<html></html>"),
        ]));
        assert_eq!(
            r.text("Image, label, and body text note.md"),
            "---\ntags:\n  - Keep/Color/Blue\n  - Keep/Attachment\n  - Keep/Label/label\n---\n\nThis is the body text.\n\n![[1690514572032.76900194.png]]"
        );
        assert_eq!(r.file("attachments/1690514572032.76900194.png").unwrap().data, b"PNGDATA");
        let f = r.file("Image, label, and body text note.md").unwrap();
        assert_eq!(f.ctime_ms, Some(1_690_514_572_858));
        assert_eq!(f.mtime_ms, Some(1_690_866_236_591));
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    }

    #[test]
    fn checklist_labels_with_symbols_and_multiline_titles() {
        let r = convert(&files(&[
            ("Checklist note.json", r#"{"color":"DEFAULT","isTrashed":false,"isPinned":false,"isArchived":false,"listContent":[{"text":"First item","isChecked":false},{"text":"Second item and #labelWith!'@:$\"Symbols","isChecked":true}],"title":"Checklist note","userEditedTimestampUsec":1690866308447000,"createdTimestampUsec":1690372692755000,"labels":[{"name":"labelWith!'@:$\"Symbols"}]}"#),
            ("Multiline title note_Second line.json", r#"{"color":"DEFAULT","textContent":"Body","title":"Multiline title note\nSecond line","userEditedTimestampUsec":1,"createdTimestampUsec":1}"#),
        ]));
        assert_eq!(
            r.text("Checklist note.md"),
            "---\ntags:\n  - Keep/Label/labelWithSymbols\n---\n\n\n- [ ] First item\n- [X] Second item and #labelWithSymbols"
        );
        assert_eq!(
            r.text("Multiline title note_Second line.md"),
            "---\naliases:\n  - Multiline title note\n  - Second line\n---\n\nBody"
        );
    }

    #[test]
    fn hashtag_labels_in_body() {
        let text = "#hyphenated-label #92labelStartingWithNumber #LabelWith#Inside \n#label with spaces and issue#92labelStartingWithNumber";
        let labels: Vec<String> = ["92labelStartingWithNumber", "hyphenated-label", "label with spaces", "LabelWith#Inside"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            sanitize_tags(text, &labels),
            "#hyphenated-label #_92labelStartingWithNumber #LabelWithInside \n#label-with-spaces and issue#92labelStartingWithNumber"
        );
        assert_eq!(keep_tag("Keep/Label/label with !'@:$\" Symbols and spaces"), "Keep/Label/label-with--Symbols-and-spaces");
    }

    #[test]
    fn rich_text_html_is_formatted() {
        let r = convert(&files(&[(
            "Rich text note.json",
            r#"{"color":"DEFAULT","textContent":"Heading\nBold and italic plus underline","textContentHtml":"<h1 dir=\"ltr\"><span style=\"font-weight:700;\">Heading</span></h1><p dir=\"ltr\"><span style=\"font-weight:700;\">Bold</span><span style=\"font-weight:400;\"> and </span><span style=\"font-style:italic;\">italic</span><span> plus </span><span style=\"text-decoration:underline;\">underline</span></p>","title":"Rich text note","userEditedTimestampUsec":1,"createdTimestampUsec":1,"labels":[{"name":"Rich"}]}"#,
        )]));
        let t = r.text("Rich text note.md");
        assert!(t.contains("# Heading"), "{t}");
        assert!(t.contains("**Bold**"), "{t}");
        assert!(t.contains("<u>underline</u>"), "{t}");
        assert!(!t.contains("****"), "{t}");
    }

    #[test]
    fn plain_html_prefers_text_content() {
        let r = convert(&files(&[(
            "Plain.json",
            r#"{"textContent":"just text https://x.com","textContentHtml":"<p><a href=\"https://x.com\">https://x.com</a></p>","userEditedTimestampUsec":1,"createdTimestampUsec":1}"#,
        )]));
        assert_eq!(r.text("Plain.md"), "\njust text https://x.com");
    }

    #[test]
    fn archived_trashed_invalid_and_annotations() {
        let input = files(&[
            ("Archived.json", r#"{"textContent":"a","isArchived":true,"userEditedTimestampUsec":1,"createdTimestampUsec":1}"#),
            ("Deleted.json", r#"{"textContent":"d","isTrashed":true,"userEditedTimestampUsec":1,"createdTimestampUsec":1}"#),
            ("broken.json", "{not json"),
            ("Labels.json", r#"{"labels":[]}"#),
            ("Annotated note.json", r#"{"textContent":"Links.","isPinned":true,"tasks":[{"id":"t"}],"userEditedTimestampUsec":0,"createdTimestampUsec":5000,"annotations":[{"description":"","title":"A <b> title","url":"https://a.example/x"},{"description":"Desc here","title":"B","url":"https://b.example/"}]}"#),
        ]);
        let r = convert(&input);
        assert_eq!(r.paths(), vec!["Annotated note.md"]);
        assert_eq!(r.warnings.len(), 4, "{:?}", r.warnings);
        assert_eq!(
            r.text("Annotated note.md"),
            "---\ntags:\n  - Keep/Pinned\n  - Keep/Task\n---\n\nLinks.\n\n## Annotations\n\n- [A \\<b\\> title](<https://a.example/x>)\n- [B](<https://b.example/>)\n  Desc here"
        );
        assert_eq!(r.file("Annotated note.md").unwrap().mtime_ms, Some(5));
        let all = convert_with(&input, &KeepOptions { import_archived: true, import_trashed: true, ..KeepOptions::default() });
        assert!(all.text("Archived.md").contains("Keep/Archived"));
        assert!(all.text("Deleted.md").contains("Keep/Deleted"));
    }

    #[test]
    fn takeout_zip_and_jpeg_extension_mismatch() {
        let mut z = crate::zip::ZipWriter::new();
        z.add_text("Takeout/Keep/Photo.json", r#"{"attachments":[{"filePath":"123.jpeg","mimetype":"image/jpeg"}],"title":"Photo","userEditedTimestampUsec":1,"createdTimestampUsec":1}"#);
        z.add("Takeout/Keep/123.jpg", b"JPEG", crate::zip::Method::Store);
        let r = convert(&[("takeout.zip".to_string(), z.finish())]);
        assert!(r.text("Photo.md").ends_with("![[123.jpg]]"), "{}", r.text("Photo.md"));
        assert!(r.warnings.is_empty(), "{:?}", r.warnings);
    }
}
