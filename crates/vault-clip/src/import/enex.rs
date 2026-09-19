//! Evernote `.enex` exports.
//!
//! Mirrors obsidian-importer's Evernote importer (itself adapted from Yarle):
//!
//! - One note per `<note>`, named by its sanitised title (`Untitled` when it
//!   has none), in a folder named for the notebook. `Stack@@@Notebook`
//!   notebook names (how Evernote exports stacks) become nested folders.
//! - Resources are decoded from base64 and written to `attachments/` beside
//!   the notes, named `<file-name stem>.<ext>` (extension from the file name,
//!   else the MIME type, else `dat`; `unknown_filename` when unnamed).
//!   `<en-media hash>` is matched to a resource by the MD5 of its data (or the
//!   hash in its recognition data) and becomes `![[file]]`, with `|W` or `|WxH`
//!   for sized images. `data:` URL images become `embedded.<ext>` files.
//! - `<en-todo>` and Evernote 10's `--en-checked` list items become `- [ ]` /
//!   `- [x]`; `<task>` groups (Evernote 10 tasks) become Tasks-plugin lines.
//! - Code blocks (`-en-codeblock:true`) keep their text and language, bold,
//!   italic and highlight spans become Markdown, encrypted blocks are kept as
//!   a labelled code block, and links between notes (`evernote:///view/…`,
//!   share links) become wikilinks resolved by title across the export.
//! - Frontmatter: `tags` (nested with `_` → `/`, spaces → `-`), `source`,
//!   `reminder`, `reminder-done`, and — an addition to the importer, which
//!   only sets file times — `created` and `updated` as `YYYY-MM-DDTHH:mm:ss`
//!   (UTC), unless `dateProperties` is off.
//!
//! The note body goes through [`crate::html_to_markdown`]; everything that must
//! reach the Markdown verbatim is carried through it as a placeholder token.

use super::markup::{style_value, Doc, Id, Kind, Token, Tokenizer};
use super::util::{
    base64_decode, basename, extension_for_mime, join, md5_hex, percent_decode, sanitize_file_name,
    split_ext, Tokens, UniquePaths,
};
use super::yaml::{frontmatter, Yaml};
use super::{dates, ImportResult, ImportedFile, LinkResolver};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EnexOptions {
    /// Folder the notebook's notes go in, usually the `.enex` file name (a
    /// trailing `.enex` is dropped). Empty puts notes at the import root.
    pub notebook: String,
    /// Skip notes clipped with the Evernote Web Clipper.
    pub skip_web_clips: bool,
    /// Write `created` and `updated` properties.
    pub date_properties: bool,
    /// Attachment folder, relative to the notebook folder.
    pub attachment_folder: String,
    /// The character Evernote tags use for nesting; replaced with `/`. Empty
    /// leaves tags unnested.
    pub nested_tag_separator: String,
}

impl Default for EnexOptions {
    fn default() -> Self {
        EnexOptions {
            notebook: String::new(),
            skip_web_clips: false,
            date_properties: true,
            attachment_folder: "attachments".into(),
            nested_tag_separator: "_".into(),
        }
    }
}

struct Resource {
    data: Vec<u8>,
    mime: String,
    file_name: Option<String>,
    recognition_hash: Option<String>,
    timestamp: Option<i64>,
}

struct Draft {
    path: String,
    title_key: String,
    markdown: String,
    tokens: Tokens,
    ctime: Option<i64>,
    mtime: Option<i64>,
}

#[derive(Default)]
struct Task {
    title: String,
    open: bool,
    flagged: bool,
    sort_weight: String,
    group: String,
    due: Option<i64>,
    reminder: Option<i64>,
}

/// Convert the text of one `.enex` file.
pub fn convert(xml: &str, opts: &EnexOptions) -> ImportResult {
    let mut result = ImportResult::default();
    let folder = notebook_folder(&opts.notebook);
    let attachment_dir = join(&folder, opts.attachment_folder.trim_matches('/'));
    let mut paths = UniquePaths::new();
    let mut drafts: Vec<Draft> = Vec::new();
    let mut attachments: Vec<ImportedFile> = Vec::new();
    // (file name, md5) → path, so one image used by several notes is written once.
    let mut written: HashMap<(String, String), String> = HashMap::new();
    let mut tasks: Vec<Task> = Vec::new();

    let mut tok = Tokenizer::new(xml, false);
    let mut saw_export = false;
    while let Some(t) = tok.next() {
        let Token::Start {
            name,
            attrs,
            self_closing,
        } = t
        else {
            continue;
        };
        if name == "en-export" {
            saw_export = true;
            continue;
        }
        if self_closing || !(name == "note" || name.eq_ignore_ascii_case("task")) {
            continue;
        }
        let mut doc = Doc::new();
        let el = doc.create_element(&name, attrs);
        let root = doc.root;
        doc.append(root, el);
        doc.build(&mut tok, el, Some(&name), false);
        if name == "note" {
            let mut ctx = NoteCtx {
                opts,
                folder: &folder,
                attachment_dir: &attachment_dir,
                paths: &mut paths,
                attachments: &mut attachments,
                written: &mut written,
                warnings: &mut result.warnings,
            };
            if let Some(d) = convert_note(&doc, el, &mut ctx) {
                drafts.push(d);
            }
            // Evernote 10 writes a note's tasks inside the note element.
            for t in doc.find_all(el, "task") {
                tasks.push(read_task(&doc, t));
            }
        } else {
            tasks.push(read_task(&doc, el));
        }
    }
    if !saw_export && drafts.is_empty() {
        result
            .warnings
            .push("No <en-export> element found; this does not look like an .enex file".into());
    }

    // Task groups, by group id, in sort-weight order.
    let mut groups: HashMap<String, Vec<&Task>> = HashMap::new();
    for t in &tasks {
        groups.entry(t.group.clone()).or_default().push(t);
    }
    for g in groups.values_mut() {
        g.sort_by(|a, b| a.sort_weight.cmp(&b.sort_weight));
    }

    // Links resolve by title once every note has a path.
    let mut by_title: HashMap<String, Option<String>> = HashMap::new();
    for d in &drafts {
        by_title
            .entry(d.title_key.clone())
            .and_modify(|v| *v = None)
            .or_insert_with(|| Some(d.path.clone()));
    }
    let resolver = LinkResolver::new(
        drafts
            .iter()
            .map(|d| d.path.as_str())
            .chain(attachments.iter().map(|a| a.path.as_str())),
    );
    let mut unresolved = 0;
    for d in drafts {
        let body = finish_markdown(&d.markdown, &d.tokens, &resolver, &by_title, &groups, &mut unresolved);
        result
            .files
            .push(ImportedFile::note(d.path, body).with_times(d.ctime, d.mtime));
    }
    if unresolved > 0 {
        result.warnings.push(format!(
            "{unresolved} link(s) to other Evernote notes could not be matched to an imported note"
        ));
    }
    result.files.extend(attachments);
    result
}

fn notebook_folder(notebook: &str) -> String {
    let name = notebook.trim();
    let name = name
        .strip_suffix(".enex")
        .or_else(|| name.strip_suffix(".ENEX"))
        .unwrap_or(name);
    if name.is_empty() {
        return String::new();
    }
    name.split("@@@")
        .filter(|s| !s.trim().is_empty())
        .map(sanitize_file_name)
        .collect::<Vec<_>>()
        .join("/")
}

struct NoteCtx<'a> {
    opts: &'a EnexOptions,
    folder: &'a str,
    attachment_dir: &'a str,
    paths: &'a mut UniquePaths,
    attachments: &'a mut Vec<ImportedFile>,
    written: &'a mut HashMap<(String, String), String>,
    warnings: &'a mut Vec<String>,
}

fn read_task(doc: &Doc, el: Id) -> Task {
    let mut t = Task {
        open: true,
        ..Task::default()
    };
    for c in doc.element_children(el) {
        let name = doc.name(c).unwrap_or("").to_ascii_lowercase();
        let text = doc.text_content(c).trim().to_string();
        match name.as_str() {
            "title" => t.title = text,
            "taskstatus" => t.open = text == "open",
            "taskflag" => t.flagged = text == "true",
            "sortweight" => t.sort_weight = text,
            "taskgroupnotelevelid" => t.group = text,
            "duedate" => t.due = dates::parse_enex_date(&text),
            "reminder" => {
                for r in doc.element_children(c) {
                    if doc.name(r).unwrap_or("").eq_ignore_ascii_case("reminderdate") {
                        t.reminder = dates::parse_enex_date(&doc.text_content(r));
                    }
                }
            }
            _ => {}
        }
    }
    t
}

fn task_line(t: &Task) -> String {
    let mut s = String::from(if t.open { "- [ ]" } else { "- [x]" });
    if !t.title.is_empty() {
        s.push(' ');
        s.push_str(&t.title);
    }
    if let Some(d) = t.due {
        s.push_str(&format!(" 📅 {}", &dates::iso_seconds(d)[..10]));
    }
    if let Some(r) = t.reminder {
        s.push_str(&format!(" ⏳ {}", &dates::iso_seconds(r)[..10]));
    }
    s.push_str(if t.flagged { " 🔼" } else { " 🔽" });
    s
}

fn convert_note(doc: &Doc, note: Id, ctx: &mut NoteCtx) -> Option<Draft> {
    let title = doc.child_text(note, "title").unwrap_or_default();
    let attrs: HashMap<String, String> = doc
        .child(note, "note-attributes")
        .map(|a| {
            doc.element_children(a)
                .into_iter()
                .map(|c| (doc.name(c).unwrap_or("").to_string(), doc.text_content(c).trim().to_string()))
                .collect()
        })
        .unwrap_or_default();
    let is_web_clip = attrs.get("source-application").map(|s| s.as_str()) == Some("webclipper.evernote")
        || attrs.get("source").map(|s| s.as_str()) == Some("web.clip7");
    if ctx.opts.skip_web_clips && is_web_clip {
        ctx.warnings
            .push(format!("Skipped web clip: {}", if title.is_empty() { "Untitled" } else { &title }));
        return None;
    }

    let ctime = doc.child_text(note, "created").and_then(|s| dates::parse_enex_date(&s));
    let mtime = doc
        .child_text(note, "updated")
        .and_then(|s| dates::parse_enex_date(&s))
        .or(ctime);

    let file_title = sanitize_file_name(if title.trim().is_empty() { "Untitled" } else { &title });
    let path = ctx.paths.claim(ctx.folder, &format!("{file_title}.md"));

    // Resources: decode, name, place.
    let mut by_hash: HashMap<String, (String, bool)> = HashMap::new();
    let mut tokens = Tokens::new();
    for r in doc.find_all(note, "resource") {
        let res = read_resource(doc, r);
        if res.data.is_empty() {
            continue;
        }
        let name = resource_file_name(&res);
        let md5 = md5_hex(&res.data);
        let is_image = res.mime.starts_with("image");
        let placed = place_attachment(ctx, &name, &md5, res.data, res.timestamp.or(ctime));
        by_hash.insert(md5, (placed.clone(), is_image));
        if let Some(h) = res.recognition_hash {
            by_hash.entry(h).or_insert((placed, is_image));
        }
    }

    let content = doc.child_text(note, "content").unwrap_or_default();
    let mut enml = Doc::parse_html(&content);
    let en_note = enml.find(enml.root, "en-note").unwrap_or(enml.root);
    prepare_enml(&mut enml, en_note, &by_hash, &mut tokens, ctx, ctime);
    let html = enml.inner_html(en_note);
    let markdown = crate::html_to_markdown(&html, None);

    // Frontmatter.
    let mut props: Vec<(String, Yaml)> = Vec::new();
    let tags: Vec<String> = doc
        .find_all(note, "tag")
        .into_iter()
        .map(|t| doc.text_content(t))
        .filter(|t| !t.trim().is_empty())
        .map(|t| clean_tag(&t, &ctx.opts.nested_tag_separator))
        .collect();
    if !tags.is_empty() {
        props.push(("tags".into(), Yaml::list(tags)));
    }
    if let Some(src) = attrs.get("source-url").filter(|s| !s.is_empty()) {
        props.push(("source".into(), Yaml::str(src.clone())));
    }
    // Reminder times arrive in either Evernote's compact form or ISO 8601.
    let any_date = |s: &String| dates::parse_enex_date(s).or_else(|| dates::parse_iso(s));
    if let Some(t) = attrs.get("reminder-time").and_then(any_date) {
        props.push(("reminder".into(), Yaml::str(dates::iso_seconds(t))));
    }
    if let Some(t) = attrs.get("reminder-done-time").and_then(any_date) {
        props.push(("reminder-done".into(), Yaml::str(dates::iso_seconds(t))));
    }
    if ctx.opts.date_properties {
        if let Some(c) = ctime {
            props.push(("created".into(), Yaml::str(dates::iso_seconds(c))));
        }
        if let Some(u) = mtime {
            props.push(("updated".into(), Yaml::str(dates::iso_seconds(u))));
        }
    }
    let markdown = format!("{}{}", frontmatter(&props), markdown);

    Some(Draft {
        path,
        title_key: sanitize_file_name(&title),
        markdown,
        tokens,
        ctime,
        mtime,
    })
}

fn clean_tag(tag: &str, separator: &str) -> String {
    let mut t = tag.trim().trim_start_matches('#').to_string();
    if !separator.is_empty() {
        t = t.replace(separator, "/");
    }
    t.replace(' ', "-")
}

fn read_resource(doc: &Doc, r: Id) -> Resource {
    let data = doc
        .child(r, "data")
        .map(|d| base64_decode(&doc.text_content(d)))
        .unwrap_or_default();
    let mime = doc.child_text(r, "mime").unwrap_or_default().trim().to_string();
    let ra = doc.child(r, "resource-attributes");
    let file_name = ra
        .and_then(|a| doc.child_text(a, "file-name"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let timestamp = ra
        .and_then(|a| doc.child_text(a, "timestamp"))
        .and_then(|s| dates::parse_enex_date(&s));
    let recognition_hash = doc.child_text(r, "recognition").and_then(|rec| {
        // The recognition index names its object id: `objID="<32 hex>"`.
        let b = rec.as_bytes();
        (0..b.len().saturating_sub(31)).find_map(|i| {
            let w = &rec[i..i + 32];
            (w.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                && (i == 0 || !b[i - 1].is_ascii_hexdigit())
                && b.get(i + 32).is_none_or(|c| !c.is_ascii_hexdigit()))
            .then(|| w.to_string())
        })
    });
    Resource {
        data,
        mime,
        file_name,
        recognition_hash,
        timestamp,
    }
}

/// `getResourceFileName`: the file name's stem with path-hostile characters
/// replaced by `-`, and an extension from the name, the MIME type, or `dat`.
fn resource_file_name(r: &Resource) -> String {
    let (stem, from_name) = match &r.file_name {
        Some(n) => {
            let base = basename(&n.replace('\\', "/")).to_string();
            let (s, e) = split_ext(&base);
            (s.to_string(), e.to_string())
        }
        None => ("unknown_filename".to_string(), String::new()),
    };
    let ext = if !from_name.is_empty() {
        from_name
    } else {
        extension_for_mime(&r.mime).unwrap_or("dat").to_string()
    };
    let stem: String = stem
        .chars()
        .map(|c| if "/\\?%*:|\"<>[]+".contains(c) { '-' } else { c })
        .collect();
    let stem = if stem.trim().is_empty() { "unknown_filename".to_string() } else { stem };
    sanitize_file_name(&format!("{stem}.{ext}"))
}

fn place_attachment(ctx: &mut NoteCtx, name: &str, md5: &str, data: Vec<u8>, time: Option<i64>) -> String {
    let key = (name.to_lowercase(), md5.to_string());
    if let Some(p) = ctx.written.get(&key) {
        return p.clone();
    }
    let path = ctx.paths.claim(ctx.attachment_dir, name);
    ctx.written.insert(key, path.clone());
    ctx.attachments
        .push(ImportedFile::new(path.clone(), data).with_times(time, time));
    path
}

// Token payloads: kind, then fields, separated by U+0000.
fn tok(kind: &str, fields: &[&str]) -> String {
    let mut s = kind.to_string();
    for f in fields {
        s.push('\0');
        s.push_str(f);
    }
    s
}

fn block_token(doc: &mut Doc, id: Id, token: String) {
    let p = doc.create_element("p", Vec::new());
    let t = doc.create_text(&token);
    doc.append(p, t);
    doc.replace_with(id, &[p]);
}

fn prepare_enml(
    doc: &mut Doc,
    root: Id,
    by_hash: &HashMap<String, (String, bool)>,
    tokens: &mut Tokens,
    ctx: &mut NoteCtx,
    ctime: Option<i64>,
) {
    // Nested lists: Evernote writes `<ul><li>a</li><ul><li>b</li></ul></ul>`.
    for list in doc.descendants(root) {
        if !(doc.is(list, "ul") || doc.is(list, "ol")) {
            continue;
        }
        let parent_is_list = doc
            .parent(list)
            .is_some_and(|p| doc.is(p, "ul") || doc.is(p, "ol"));
        if parent_is_list {
            if let Some(prev) = doc.previous_element_sibling(list) {
                if doc.is(prev, "li") {
                    doc.append(prev, list);
                }
            }
            continue;
        }
        // `<li><ul>…</ul></li>`: an item holding nothing but a list nests
        // that list under the item before it.
        let Some(li) = doc.parent(list).filter(|p| doc.is(*p, "li")) else {
            continue;
        };
        let only_list = doc.element_children(li) == vec![list]
            && doc.children(li).iter().all(|c| *c == list || doc.text(*c).is_some_and(|t| t.trim().is_empty()));
        if let (true, Some(prev)) = (only_list, doc.previous_element_sibling(li)) {
            if doc.is(prev, "li") {
                doc.append(prev, list);
                doc.detach(li);
            }
        }
    }
    // `<li><div>text</div></li>`: the div is block noise inside an item.
    for li in doc.find_all(root, "li") {
        let first = doc.element_children(li).first().copied();
        if let Some(div) = first {
            if doc.is(div, "div") && !is_code_block(doc, div) {
                doc.unwrap(div);
            }
        }
    }
    // A todo wrapped in formatting or a link belongs in front of it.
    for todo in doc.find_all(root, "en-todo") {
        while let Some(p) = doc.parent(todo) {
            if (doc.is(p, "span") || doc.is(p, "a") || doc.is(p, "b") || doc.is(p, "strong") || doc.is(p, "i") || doc.is(p, "em") || doc.is(p, "font"))
                && doc.children(p).first() == Some(&todo)
            {
                doc.insert_before(p, todo);
            } else {
                break;
            }
        }
    }

    for id in doc.descendants(root) {
        if doc.parent(id).is_none() && id != root {
            continue; // detached by an earlier replacement
        }
        let Some(name) = doc.name(id).map(str::to_string) else {
            continue;
        };
        match name.as_str() {
            "div" if is_code_block(doc, id) => {
                let code = read_code(doc, id).replace('\u{a0}', " ");
                let code = code.trim_matches('\n');
                let lang = code_language(doc.attr(id, "style").unwrap_or(""));
                let t = tokens.add(tok("raw", &[&format!("```{lang}\n{code}\n```")]));
                block_token(doc, id, t);
            }
            "div" if doc.attr(id, "style").is_some_and(|s| s.contains("--en-task-group:true")) => {
                let group = style_value(doc.attr(id, "style").unwrap_or(""), "--en-id").unwrap_or_default();
                let t = tokens.add(tok("tasks", &[&group]));
                block_token(doc, id, t);
            }
            "en-crypt" => {
                let hint = doc.attr(id, "hint").unwrap_or("").to_string();
                let cipher = doc.text_content(id).trim().to_string();
                let label = if hint.is_empty() {
                    "Encrypted content:".to_string()
                } else {
                    format!("Encrypted content (hint: {hint}):")
                };
                let t = tokens.add(tok("raw", &[&format!("{label}\n\n```\n{cipher}\n```")]));
                block_token(doc, id, t);
            }
            "en-media" => {
                let hash = doc.attr(id, "hash").unwrap_or("").to_ascii_lowercase();
                match by_hash.get(&hash) {
                    Some((path, is_image)) => {
                        let media_type = doc.attr(id, "type").unwrap_or("");
                        let image = media_type.starts_with("image") || (media_type.is_empty() && *is_image);
                        let size = if image { image_size(doc, id) } else { String::new() };
                        let t = tokens.add(tok("embed", &[path, &size]));
                        doc.replace_with_text(id, &t);
                    }
                    None => {
                        ctx.warnings.push(format!("A note refers to a missing resource ({hash})"));
                        doc.detach(id);
                    }
                }
            }
            "img" => {
                let src = doc.attr(id, "src").unwrap_or("").to_string();
                if let Some(rest) = src.strip_prefix("data:") {
                    if let Some((meta, data)) = rest.split_once(',') {
                        let base64 = meta.ends_with(";base64");
                        let mediatype = meta.split(';').next().unwrap_or("");
                        let subtype = mediatype.rsplit('/').next().unwrap_or("");
                        let ext = subtype.split('+').next().filter(|s| !s.is_empty()).unwrap_or("dat");
                        let bytes = if base64 { base64_decode(data) } else { percent_decode(data).into_bytes() };
                        let md5 = md5_hex(&bytes);
                        let path = place_attachment(ctx, &format!("embedded.{ext}"), &md5, bytes, ctime);
                        let size = image_size(doc, id);
                        let t = tokens.add(tok("embed", &[&path, &size]));
                        doc.replace_with_text(id, &t);
                    }
                }
            }
            "en-todo" => {
                let checked = doc.attr(id, "checked") == Some("true");
                let t = tokens.add(tok("todo", &[if checked { "x" } else { " " }]));
                doc.replace_with_text(id, &t);
            }
            "li" => {
                let style = doc.attr(id, "style").unwrap_or("").replace(' ', "");
                let state = if style.contains("--en-checked:true") {
                    Some("x")
                } else if style.contains("--en-checked:false") {
                    Some(" ")
                } else {
                    None
                };
                if let Some(s) = state {
                    let t = tokens.add(tok("todo", &[s]));
                    let text = doc.create_text(&t);
                    doc.prepend(id, text);
                }
            }
            "span" => {
                let style = doc.attr(id, "style").unwrap_or("").to_string();
                if style.is_empty() || doc.text_content(id).trim().is_empty() {
                    continue;
                }
                let weight = style_value(&style, "font-weight").unwrap_or_default();
                let bold = weight == "bold" || weight.parse::<u32>().is_ok_and(|w| w >= 600);
                let italic = style_value(&style, "font-style").is_some_and(|s| s == "italic");
                let highlight = style.contains("-evernote-highlight:true") || style.contains("--en-highlight");
                if bold {
                    doc.wrap_children(id, "strong");
                }
                if italic {
                    doc.wrap_children(id, "em");
                }
                if highlight && !bold && !italic {
                    // `==` as tokens rather than `<mark>`: the delimiters must
                    // not be escaped, and hug the text without spaces.
                    let open = tokens.add(tok("raw", &["=="]));
                    let close = tokens.add(tok("raw", &["=="]));
                    let o = doc.create_text(&open);
                    let c = doc.create_text(&close);
                    doc.prepend(id, o);
                    doc.append(id, c);
                }
            }
            "a" => {
                let href = doc.attr(id, "href").unwrap_or("").to_string();
                if href.is_empty() {
                    continue;
                }
                if !is_evernote_note_href(&href) {
                    // The importer strips brackets from link text, and writes
                    // a link whose text is its address (or empty) as <url>.
                    for n in doc.descendants(id) {
                        if let Kind::Text(t) = &mut doc.nodes[n].kind {
                            if t.contains(['[', ']']) {
                                *t = t.replace(['[', ']'], "");
                            }
                        }
                    }
                    let shown = doc.text_content(id);
                    let has_media = doc.descendants(id).iter().any(|n| doc.is(*n, "img") || doc.is(*n, "en-media"));
                    let autolink = !has_media
                        && !href.chars().any(char::is_whitespace)
                        && super::util::has_scheme(&href)
                        && !["javascript:", "data:", "vbscript:"].iter().any(|p| href.to_ascii_lowercase().starts_with(p))
                        && (shown.trim().is_empty() || shown.trim() == href);
                    if autolink {
                        let t = tokens.add(tok("raw", &[&format!("<{href}>")]));
                        doc.replace_with_text(id, &t);
                    }
                    continue;
                }
                let text: String = doc.text_content(id).replace(['[', ']'], "");
                let shown = text.trim();
                let t = if shown.is_empty() || is_evernote_note_href(shown) {
                    tokens.add(tok("raw", &[&format!("<{href}>")]))
                } else {
                    tokens.add(tok("link", &[shown, &href]))
                };
                doc.replace_with_text(id, &t);
            }
            _ => {}
        }
    }
}

fn is_code_block(doc: &Doc, id: Id) -> bool {
    doc.attr(id, "style")
        .is_some_and(|s| s.replace(' ', "").contains("-en-codeblock:true"))
}

fn code_language(style: &str) -> String {
    for flag in ["-en-syntaxLanguage:", "-en-codeblockLanguage:"] {
        if let Some(at) = style.find(flag) {
            let lang = style[at + flag.len()..]
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase();
            let valid = !lang.is_empty()
                && lang
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "+#._-".contains(c));
            if valid && !matches!(lang.as_str(), "plaintext" | "text" | "none") {
                return lang;
            }
        }
    }
    String::new()
}

/// Code text: block children (`div`, `p`, `li`, `tr`) are lines, `<br>` is a
/// newline, text is verbatim.
fn read_code(doc: &Doc, id: Id) -> String {
    fn walk(doc: &Doc, id: Id, code: &mut String) {
        for &c in doc.children(id) {
            match &doc.nodes[c].kind {
                Kind::Text(t) => code.push_str(t),
                Kind::Element { name, .. } => {
                    if name == "br" {
                        code.push('\n');
                        continue;
                    }
                    let own_line = matches!(name.as_str(), "div" | "p" | "li" | "tr");
                    if own_line && !code.is_empty() && !code.ends_with('\n') {
                        code.push('\n');
                    }
                    walk(doc, c, code);
                    if own_line && !code.is_empty() && !code.ends_with('\n') {
                        code.push('\n');
                    }
                }
                Kind::Root => {}
            }
        }
    }
    let mut code = String::new();
    walk(doc, id, &mut code);
    code
}

/// `|W` or `|WxH` from width/height attributes, unless a style sets the
/// dimension to `auto` (a clipped page's CSS overriding the attribute).
fn image_size(doc: &Doc, id: Id) -> String {
    let style = doc.attr(id, "style").unwrap_or("").to_ascii_lowercase();
    let px = |dim: &str| -> u32 {
        if style_value(&style, dim).is_some_and(|v| v == "auto") {
            return 0;
        }
        let v = doc.attr(id, dim).unwrap_or("");
        let num: String = v
            .trim()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        match num.parse::<f64>() {
            Ok(f) if f.is_finite() && f >= 1.0 => f.round() as u32,
            _ => 0,
        }
    };
    let w = px("width");
    if w == 0 {
        return String::new();
    }
    let h = px("height");
    if h > 0 {
        format!("|{w}x{h}")
    } else {
        format!("|{w}")
    }
}

fn is_evernote_note_href(href: &str) -> bool {
    let lower = href.to_ascii_lowercase();
    lower.starts_with("evernote://")
        || lower.starts_with("https://share.evernote.com/note/")
        || lower.starts_with("http://share.evernote.com/note/")
        || ["https://www.evernote.com/shard/", "https://evernote.com/shard/", "http://www.evernote.com/shard/"]
            .iter()
            .any(|p| lower.starts_with(p))
}

fn finish_markdown(
    markdown: &str,
    tokens: &Tokens,
    resolver: &LinkResolver,
    by_title: &HashMap<String, Option<String>>,
    groups: &HashMap<String, Vec<&Task>>,
    unresolved: &mut usize,
) -> String {
    let render = |value: &str, unresolved: &mut usize| -> String {
        let parts: Vec<&str> = value.split('\0').collect();
        match parts[0] {
            "raw" => parts[1].to_string(),
            "embed" => format!("![[{}{}]]", resolver.link(parts[1]), parts[2]),
            "link" => {
                let (title, href) = (parts[1], parts[2]);
                let key = sanitize_file_name(title);
                match by_title.get(&key).cloned().flatten() {
                    Some(path) => {
                        let link = resolver.link(&path);
                        if link == title {
                            format!("[[{title}]]")
                        } else {
                            format!("[[{link}|{title}]]")
                        }
                    }
                    None => {
                        *unresolved += 1;
                        if href.starts_with("http") {
                            format!("[{title}]({href})")
                        } else {
                            format!("[[{title}]]")
                        }
                    }
                }
            }
            "tasks" => groups
                .get(parts[1])
                .map(|g| g.iter().map(|t| task_line(t)).collect::<Vec<_>>().join("\n"))
                .unwrap_or_default(),
            "todo" => format!("[{}]", parts[1]),
            _ => String::new(),
        }
    };

    let mut lines = Vec::new();
    for line in markdown.split('\n') {
        lines.push(todo_line(line, tokens));
    }
    let joined = lines.join("\n");
    let replaced = tokens.replace_with(&joined, |_, v| render(v, unresolved));
    let restored = restore_intra_word_underscores(&replaced);
    let tidied = collapse_blank_lines(&restored);
    let trimmed = tidied.trim_end_matches('\n');
    format!("{trimmed}\n")
}

/// Evernote spaces paragraphs with `<div><br/></div>`, which converts to
/// lines holding only spaces. Outside code, such lines are emptied and runs of
/// blank lines collapse to one.
fn collapse_blank_lines(md: &str) -> String {
    super::mdcode::outside_fences(md, |seg| {
        // The segment's own final newline is not a blank line.
        let (body, newline) = match seg.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (seg, ""),
        };
        let mut out: Vec<&str> = Vec::new();
        for line in body.split('\n') {
            let blank = line.trim().is_empty();
            if blank && out.last().is_some_and(|l: &&str| l.is_empty()) {
                continue;
            }
            out.push(if blank { "" } else { line });
        }
        format!("{}{newline}", out.join("\n"))
    })
}

/// Put a todo token at the start of a line into list form: `- [x] …`,
/// `1. [ ] …`, or a bare `- [ ] …` when it is not in a list.
fn todo_line(line: &str, tokens: &Tokens) -> String {
    let indent_len = line.len() - line.trim_start().len();
    let (indent, rest) = line.split_at(indent_len);
    let (marker, after) = if let Some(r) = rest.strip_prefix("- ").or_else(|| rest.strip_prefix("* ")).or_else(|| rest.strip_prefix("+ ")) {
        ("- ".to_string(), r)
    } else {
        let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digits > 0 && rest[digits..].starts_with(". ") {
            (rest[..digits + 2].to_string(), &rest[digits + 2..])
        } else {
            (String::new(), rest)
        }
    };
    let after_trim = after.trim_start();
    let Some(token_end) = after_trim.find("QZ").map(|i| i + 2) else {
        return line.to_string();
    };
    let candidate = &after_trim[..token_end];
    let Some(value) = tokens.get(candidate) else {
        return line.to_string();
    };
    let Some(state) = value.strip_prefix("todo\0") else {
        return line.to_string();
    };
    let text = after_trim[token_end..].trim_start();
    let marker = if marker.is_empty() { "- ".to_string() } else { marker };
    if text.is_empty() {
        format!("{indent}{marker}[{state}]")
    } else {
        format!("{indent}{marker}[{state}] {text}")
    }
}

/// Undo `a\_b` escaping inside words, which converters add defensively.
fn restore_intra_word_underscores(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\'
            && i > 0
            && chars.get(i + 1) == Some(&'_')
            && chars[i - 1].is_alphanumeric()
            && chars.get(i + 2).is_some_and(|c| c.is_alphanumeric())
        {
            i += 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(data: &[u8]) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in data.chunks(3) {
            let n = chunk.len();
            let v = (chunk[0] as u32) << 16
                | (*chunk.get(1).unwrap_or(&0) as u32) << 8
                | *chunk.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                if i <= n {
                    out.push(A[((v >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    fn enex(notes: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE en-export SYSTEM \"http://xml.evernote.com/pub/evernote-export4.dtd\">\n<en-export export-date=\"20240101T000000Z\" application=\"Evernote\" version=\"10.0\">{notes}</en-export>"
        )
    }

    fn note(title: &str, enml: &str, extra: &str) -> String {
        format!(
            "<note><title>{title}</title><created>20240102T030405Z</created><updated>20240103T040506Z</updated>{extra}<content><![CDATA[<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE en-note SYSTEM \"http://xml.evernote.com/pub/enml2.dtd\"><en-note>{enml}</en-note>]]></content></note>"
        )
    }

    fn opts() -> EnexOptions {
        EnexOptions {
            notebook: "My Notebook.enex".into(),
            ..EnexOptions::default()
        }
    }

    #[test]
    fn note_with_tags_dates_and_source() {
        let xml = enex(&note(
            "Hello",
            "<div><b>bold</b> text</div>",
            "<tag>tag1</tag><tag>nested_tag with space</tag><note-attributes><source-url>https://example.com/a</source-url></note-attributes>",
        ));
        let r = convert(&xml, &opts());
        let md = r.text("My Notebook/Hello.md");
        assert!(md.starts_with("---\ntags:\n  - tag1\n  - nested/tag-with-space\nsource: https://example.com/a\ncreated: 2024-01-02T03:04:05\nupdated: 2024-01-03T04:05:06\n---\n"), "{md}");
        assert!(md.contains("**bold**"), "{md}");
        let f = r.file("My Notebook/Hello.md").unwrap();
        assert_eq!(f.ctime_ms, dates::parse_enex_date("20240102T030405Z"));
    }

    #[test]
    fn media_matched_by_md5_with_sizes() {
        let png = b"\x89PNG\r\n\x1a\nfake image bytes";
        let hash = md5_hex(png);
        let res = format!(
            "<resource><data encoding=\"base64\">{}</data><mime>image/png</mime><width>10</width><resource-attributes><file-name>dot.png</file-name></resource-attributes></resource>",
            b64(png)
        );
        let enml = format!(
            "<div>Original:</div><div><en-media hash=\"{hash}\" type=\"image/png\"/></div><div><en-media hash=\"{hash}\" type=\"image/png\" width=\"300\" height=\"60\"/></div><div><en-media hash=\"{hash}\" type=\"image/png\" width=\"41.2\" style=\"width: auto;\"/></div>"
        );
        let r = convert(&enex(&note("Img", &enml, &res)), &opts());
        let md = r.text("My Notebook/Img.md");
        assert!(md.contains("![[dot.png]]"), "{md}");
        assert!(md.contains("![[dot.png|300x60]]"), "{md}");
        assert_eq!(md.matches("![[dot.png]]").count(), 2, "{md}");
        assert_eq!(r.file("My Notebook/attachments/dot.png").unwrap().data, png);
    }

    #[test]
    fn non_image_resource_and_unknown_names() {
        let pdf = b"%PDF-1.4 hello";
        let res = format!(
            "<resource><data>{}</data><mime>application/pdf</mime></resource>",
            b64(pdf)
        );
        let enml = format!("<div><en-media hash=\"{}\" type=\"application/pdf\"/></div>", md5_hex(pdf));
        let r = convert(&enex(&note("Pdf", &enml, &res)), &opts());
        assert!(r.text("My Notebook/Pdf.md").contains("![[unknown_filename.pdf]]"));
        assert!(r.file("My Notebook/attachments/unknown_filename.pdf").is_some());
    }

    #[test]
    fn same_file_name_different_data_gets_numbered() {
        let a = b"first";
        let b = b"second";
        let res = format!(
            "<resource><data>{}</data><mime>image/png</mime><resource-attributes><file-name>dot.png</file-name></resource-attributes></resource><resource><data>{}</data><mime>image/png</mime><resource-attributes><file-name>dot.png</file-name></resource-attributes></resource>",
            b64(a), b64(b)
        );
        let enml = format!("<en-media hash=\"{}\" type=\"image/png\"/><en-media hash=\"{}\" type=\"image/png\"/>", md5_hex(a), md5_hex(b));
        let r = convert(&enex(&note("Two", &enml, &res)), &opts());
        assert!(r.file("My Notebook/attachments/dot 1.png").is_some());
        let md = r.text("My Notebook/Two.md");
        assert!(md.contains("![[dot.png]]") && md.contains("![[dot 1.png]]"), "{md}");
    }

    #[test]
    fn todos_in_all_three_shapes() {
        let enml = "<div><en-todo checked=\"true\"/>Done old style</div><div><en-todo checked=\"false\"/>Open old style</div>\
            <ul style=\"--en-todo:true;\"><li style=\"--en-checked:false;\">Open v10</li><li style=\"--en-checked:true;\">Done v10</li></ul>\
            <ol><li><en-todo checked=\"false\"/>Numbered open</li></ol>\
            <div><span style=\"font-weight: bold;\"><en-todo checked=\"true\"/>bold task</span></div>";
        let r = convert(&enex(&note("Tasks", enml, "")), &opts());
        let md = r.text("My Notebook/Tasks.md");
        assert!(md.contains("- [x] Done old style"), "{md}");
        assert!(md.contains("- [ ] Open old style"), "{md}");
        assert!(md.contains("- [ ] Open v10"), "{md}");
        assert!(md.contains("- [x] Done v10"), "{md}");
        assert!(md.contains("1. [ ] Numbered open"), "{md}");
        assert!(md.contains("- [x] **bold task**"), "{md}");
    }

    #[test]
    fn code_block_keeps_whitespace_and_language() {
        let enml = "<div style=\"--en-codeblock:true;-en-codeblockLanguage:Python;\"><div>def f():</div><div>&nbsp;&nbsp;&nbsp;&nbsp;return 1_000 * a_b</div><div><br/></div><div>x = [1]</div></div><div>after</div>";
        let r = convert(&enex(&note("Code", enml, "")), &opts());
        let md = r.text("My Notebook/Code.md");
        assert!(md.contains("```python\ndef f():\n    return 1_000 * a_b\n\nx = [1]\n```"), "{md}");
        assert!(md.contains("after"));
    }

    #[test]
    fn links_between_notes_resolve_by_title() {
        let a = note("Note A", "<div><a href=\"evernote:///view/1/s1/abc/abc/\">Note B</a></div><div><a href=\"evernote:///view/1/s1/zzz/zzz/\">Missing</a></div><div><a href=\"https://example.com\">web</a></div>", "");
        let b = note("Note B", "<div>target</div>", "");
        let r = convert(&enex(&format!("{a}{b}")), &opts());
        let md = r.text("My Notebook/Note A.md");
        assert!(md.contains("[[Note B]]"), "{md}");
        assert!(md.contains("[[Missing]]"), "{md}");
        assert!(md.contains("[web](https://example.com)"), "{md}");
        assert_eq!(r.warnings.len(), 1, "{:?}", r.warnings);
    }

    #[test]
    fn untitled_and_duplicate_titles_and_stacks() {
        let xml = enex(&format!("{}{}{}", note("", "<div>a</div>", ""), note("Same", "<div>1</div>", ""), note("same", "<div>2</div>", "")));
        let r = convert(&xml, &EnexOptions { notebook: "Stack@@@Book".into(), ..EnexOptions::default() });
        let paths = r.paths();
        assert!(paths.contains(&"Stack/Book/Untitled.md"), "{paths:?}");
        assert!(paths.contains(&"Stack/Book/Same.md") && paths.contains(&"Stack/Book/same 1.md"), "{paths:?}");
    }

    #[test]
    fn tasks_fill_their_group() {
        let n = note("With tasks", "<div>Before</div><div style=\"--en-task-group:true; --en-id:grp1;\"></div><div>After</div>", "");
        let tasks = "<task><title>Second</title><taskStatus>completed</taskStatus><taskFlag>true</taskFlag><sortWeight>B</sortWeight><taskGroupNoteLevelID>grp1</taskGroupNoteLevelID></task>\
            <task><title>First</title><taskStatus>open</taskStatus><taskFlag>false</taskFlag><sortWeight>A</sortWeight><taskGroupNoteLevelID>grp1</taskGroupNoteLevelID><dueDate>20240105T100000Z</dueDate></task>";
        let r = convert(&enex(&format!("{n}{tasks}")), &opts());
        let md = r.text("My Notebook/With tasks.md");
        assert!(md.contains("- [ ] First 📅 2024-01-05 🔽\n- [x] Second 🔼"), "{md}");
    }

    #[test]
    fn highlight_encrypted_and_data_url_images() {
        let enml = "<div><span style=\"--en-highlight:yellow;\">marked</span></div><en-crypt hint=\"pet\" cipher=\"AES\">RU5DMA==</en-crypt><div><img src=\"data:image/svg+xml;base64,PHN2Zy8+\" width=\"20\"/></div>";
        let r = convert(&enex(&note("Mixed", enml, "")), &opts());
        let md = r.text("My Notebook/Mixed.md");
        assert!(md.contains("==marked=="), "{md}");
        assert!(md.contains("Encrypted content (hint: pet):\n\n```\nRU5DMA==\n```"), "{md}");
        assert!(md.contains("![[embedded.svg|20]]"), "{md}");
        assert_eq!(r.file("My Notebook/attachments/embedded.svg").unwrap().data, b"<svg/>");
    }

    #[test]
    fn web_clips_can_be_skipped() {
        let n = note("Clip", "<div>x</div>", "<note-attributes><source-application>webclipper.evernote</source-application></note-attributes>");
        let r = convert(&enex(&n), &EnexOptions { skip_web_clips: true, ..opts() });
        assert!(r.files.is_empty());
        assert_eq!(r.warnings.len(), 1);
    }

    #[test]
    fn nested_lists_move_into_items() {
        let enml = "<ul><li><div>one</div></li><ul><li><div>child</div></li></ul><li><div>two</div></li></ul>";
        let r = convert(&enex(&note("Lists", enml, "")), &opts());
        let md = r.text("My Notebook/Lists.md");
        let one = md.find("one").unwrap();
        let child = md.find("child").unwrap();
        let two = md.find("two").unwrap();
        assert!(one < child && child < two, "{md}");
        let child_line = md.lines().find(|l| l.contains("child")).unwrap();
        assert!(child_line.starts_with(' ') || child_line.starts_with('\t'), "child should be indented: {md}");
    }

    // Regressions found by running the importer's own ENEX fixtures.

    #[test]
    fn tasks_written_inside_the_note_element() {
        // Evernote 10 puts <task> after </content>, inside <note>.
        let n = note(
            "Things to do",
            "<div style=\"--en-task-group:true; --en-id:g1;--en-content-hash:x\"><div>Content not supported</div></div>",
            "",
        )
        .replace(
            "</note>",
            "<task><title>Simple task</title><taskStatus>open</taskStatus><taskFlag>false</taskFlag><sortWeight>C</sortWeight><taskGroupNoteLevelID>g1</taskGroupNoteLevelID></task></note>",
        );
        let r = convert(&enex(&n), &opts());
        let md = r.text("My Notebook/Things to do.md");
        assert!(md.contains("- [ ] Simple task 🔽"), "{md}");
        assert!(!md.contains("Content not supported"), "{md}");
    }

    #[test]
    fn iso_reminder_times() {
        let n = note("R", "<div>x</div>", "<note-attributes><reminder-time>2025-01-01T00:00:00+00:00</reminder-time><reminder-done-time>2025-01-01T00:00:18+00:00</reminder-done-time></note-attributes>");
        let md = convert(&enex(&n), &opts()).text("My Notebook/R.md");
        assert!(md.contains("reminder: 2025-01-01T00:00:00\nreminder-done: 2025-01-01T00:00:18\n"), "{md}");
    }

    #[test]
    fn item_holding_only_a_list_nests_under_previous_item() {
        let enml = "<ul><li><div>Level1</div></li><li><ul><li><div>Level2</div></li><li><ul><li><div>Level3</div></li></ul></li></ul></li></ul>";
        let md = convert(&enex(&note("Sub", enml, "")), &opts()).text("My Notebook/Sub.md");
        assert!(!md.contains("- -"), "{md}");
        let l2 = md.lines().find(|l| l.contains("Level2")).unwrap();
        let l3 = md.lines().find(|l| l.contains("Level3")).unwrap();
        let indent = |l: &str| l.len() - l.trim_start().len();
        assert!(indent(l2) > 0 && indent(l3) > indent(l2), "{md}");
    }

    #[test]
    fn spacer_divs_do_not_leave_whitespace_lines() {
        let enml = "<div>one</div><div><br/></div><div><br/></div><div><br/></div><div>two</div>";
        let md = convert(&enex(&note("Spacing", enml, "")), &opts()).text("My Notebook/Spacing.md");
        let body = md.split("---\n").last().unwrap();
        assert_eq!(body, "one\n\ntwo\n", "{md:?}");
    }

    #[test]
    fn bare_and_bracketed_external_links() {
        let enml = "<div><a href=\"https://444.hu/\"></a></div><div><a href=\"https://444.hu/x?a=1&amp;b=2\">https://444.hu/x?a=1&amp;b=2</a></div><div>Marr <a href=\"http://x.org/#bib48\">[48]</a></div>";
        let md = convert(&enex(&note("Links", enml, "")), &opts()).text("My Notebook/Links.md");
        assert!(md.contains("<https://444.hu/>"), "{md}");
        assert!(md.contains("<https://444.hu/x?a=1&b=2>"), "{md}");
        assert!(md.contains("[48](http://x.org/#bib48)"), "{md}");
    }
}
