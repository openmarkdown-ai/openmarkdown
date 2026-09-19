//! Notion exports: the HTML export obsidian-importer reads, and Notion's
//! default "Markdown & CSV" export, which the importer refuses.
//!
//! Input is the export's files as `(path, bytes)`; zips are opened, including
//! the `Export-….zip` parts Notion nests inside the download, and the
//! synthetic `Export-<uuid>/` root folder is dropped.
//!
//! Shared by both exports, as the importer does it:
//!
//! - The 32-hex id suffix is removed from every file and folder name
//!   (`Page 0123…cdef.html` → `Page.md`); titles come from the page itself
//!   (Notion truncates file names), with `:` and `/` turned into `-` and `#`
//!   removed, cut near 200 characters.
//! - A page that has sub-pages or attachments moves into a folder of its own
//!   name beside them (`parentsInSubfolders`, on by default), so
//!   `Parent/Parent.md` sits with `Parent/Child.md` for folder-note plugins.
//! - Collisions are numbered case-insensitively; links become wikilinks with
//!   the shortest unique text; attachments keep their folder and are embedded.
//!
//! HTML export: `table.properties` becomes frontmatter (checkbox → boolean,
//! number → number, dates → `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`, multi-select,
//! relation and file → lists, `Tags` → `tags` with spaces as `-`); callouts
//! become `> [!important]` callouts, bookmarks `> [!info]` callouts, equations
//! `$…$`/`$$…$$`, toggle headings headings, to-do items tasks, the table of
//! contents a list of `[[#heading]]` links; one-item-per-list Notion lists are
//! merged; `#word` text that Obsidian would read as a tag is escaped `\#word`.
//!
//! Markdown & CSV export: `# Title` lines are removed where they repeat the
//! title, a row page's `Property: value` lines (named by its database's CSV
//! header) become frontmatter, relative links to pages, databases and files
//! become wikilinks and embeds, and each database becomes a note holding its
//! table with row titles linked to the row notes.

use super::markup::{Doc, Id};
use super::mdcode::outside_code;
use super::util::{
    basename, extension_lower, parent, percent_decode, resolve_path, sanitize_file_name,
    split_ext, Tokens, UniquePaths,
};
use super::yaml::{frontmatter, typed, Yaml};
use super::{dates, ImportResult, ImportedFile, LinkResolver};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotionOptions {
    /// Move a page with children into a folder of its own name.
    pub parents_in_subfolders: bool,
    /// Collapse blank lines between paragraphs into single line breaks.
    pub single_line_breaks: bool,
}

impl Default for NotionOptions {
    fn default() -> Self {
        NotionOptions {
            parents_in_subfolders: true,
            single_line_breaks: false,
        }
    }
}

pub fn convert(files: &[(String, Vec<u8>)]) -> ImportResult {
    convert_with(files, &NotionOptions::default())
}

/// The 32-character id at the end of a Notion file or folder name (dashes
/// ignored, lowercase hex as Notion writes it).
pub fn notion_id(name: &str) -> Option<String> {
    let s: String = name.chars().filter(|c| *c != '-').collect();
    let b = s.as_bytes();
    let mut i = 0;
    let mut found = None;
    while i + 32 <= b.len() {
        let w = &b[i..i + 32];
        if w.iter().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
            && (i + 32 == b.len() || b[i + 32] == b'.' || b[i + 32] == b'?' || b[i + 32] == b'#' || b[i + 32] == b'_')
        {
            found = Some(String::from_utf8_lossy(w).into_owned());
            // Keep the last match: the id ends the name.
        }
        i += 1;
    }
    found.filter(|id| id.bytes().any(|c| c.is_ascii_digit()))
}

/// `Name 0123…cdef` → `Name` (also with a dash before the id, as older
/// exports wrote it).
pub fn strip_notion_id(name: &str) -> String {
    let (stem, ext) = split_ext(name);
    let stem_trimmed = {
        let t = stem.trim_end();
        let hex_len = t
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_hexdigit() || *c == '-')
            .count();
        let tail: String = t.chars().rev().take(hex_len).collect::<Vec<_>>().into_iter().rev().collect();
        if tail.chars().filter(|c| *c != '-').count() >= 32 && notion_id(&tail).is_some() {
            let cut = t.len() - tail.len();
            t[..cut].trim_end_matches([' ', '-']).trim_end().to_string()
        } else {
            stem.to_string()
        }
    };
    let stem_trimmed = if stem_trimmed.is_empty() { stem.to_string() } else { stem_trimmed };
    if ext.is_empty() || notion_id(ext).is_some() {
        stem_trimmed
    } else {
        format!("{stem_trimmed}.{ext}")
    }
}

fn is_hidden(path: &str) -> bool {
    let name = basename(path);
    path.starts_with("__MACOSX/") || path.contains("/__MACOSX/") || name.starts_with("._") || name == ".DS_Store" || name == "Thumbs.db"
}

/// Open zips (and the part zips at their roots), drop hidden files and the
/// synthetic export root folder.
fn expand(files: &[(String, Vec<u8>)], warnings: &mut Vec<String>) -> Vec<(String, Vec<u8>)> {
    fn strip_root(entries: &mut [(String, Vec<u8>)]) {
        let Some(first) = entries.first() else {
            return;
        };
        let root = first.0.split('/').next().unwrap_or("").to_string();
        let is_export = root.len() == "Export-".len() + 36
            && root.starts_with("Export-")
            && root[7..].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
        if !is_export || !entries.iter().all(|(p, _)| p.starts_with(&format!("{root}/"))) {
            return;
        }
        for e in entries.iter_mut() {
            e.0 = e.0[root.len() + 1..].to_string();
        }
    }
    fn open(name: &str, data: &[u8], depth: usize, out: &mut Vec<(String, Vec<u8>)>, warnings: &mut Vec<String>) {
        match crate::zip::read_zip(data) {
            Ok(entries) => {
                let mut entries: Vec<(String, Vec<u8>)> = entries
                    .into_iter()
                    .filter(|e| !e.is_dir && !is_hidden(&e.name))
                    .map(|e| (e.name, e.data))
                    .collect();
                strip_root(&mut entries);
                for (p, d) in entries {
                    // Only zips at the root are export parts; deeper ones are
                    // attachments someone uploaded to Notion.
                    if depth < 2 && !p.contains('/') && extension_lower(&p) == "zip" {
                        open(&p, &d, depth + 1, out, warnings);
                    } else {
                        out.push((p, d));
                    }
                }
            }
            Err(e) => warnings.push(format!("{name}: {e}")),
        }
    }
    let mut out = Vec::new();
    let mut loose = Vec::new();
    for (p, d) in files {
        let p = p.replace('\\', "/");
        if is_hidden(&p) {
            continue;
        }
        if !p.contains('/') && extension_lower(&p) == "zip" {
            open(&p, d, 1, &mut out, warnings);
        } else {
            loose.push((p, d.clone()));
        }
    }
    strip_root(&mut loose);
    out.extend(loose);
    out
}

#[derive(Debug, Clone)]
struct PageInfo {
    source: String,
    title: String,
    parent_ids: Vec<String>,
    ctime: Option<i64>,
    mtime: Option<i64>,
    /// Final note path, once planned.
    path: String,
}

#[derive(Debug, Clone)]
struct AttachmentInfo {
    name: String,
    parent_ids: Vec<String>,
    path: String,
}

fn parent_ids(path: &str) -> Vec<String> {
    parent(path)
        .split('/')
        .filter_map(notion_id)
        .collect()
}

fn clean_title(title: &str) -> String {
    let t: String = title
        .replace('\n', " ")
        .chars()
        .filter(|c| *c != '#')
        .map(|c| if c == ':' || c == '/' { '-' } else { c })
        .collect();
    strip_to_200(&sanitize_file_name(t.trim()))
}

fn strip_to_200(title: &str) -> String {
    if title.chars().count() < 200 {
        return title.to_string();
    }
    let mut out: Vec<&str> = Vec::new();
    let mut len = 0;
    let words: Vec<&str> = title.split(' ').collect();
    let mut complete = false;
    let mut i = 0;
    while len < 200 {
        let Some(w) = words.get(i) else {
            complete = true;
            break;
        };
        out.push(w);
        len += w.chars().count() + 1;
        i += 1;
    }
    let mut s = out.join(" ");
    if !complete {
        s.push_str("...");
    }
    s
}

struct Plan {
    pages: HashMap<String, PageInfo>,
    page_order: Vec<String>,
    attachments: BTreeMap<String, AttachmentInfo>,
}

impl Plan {
    fn folder_for(&self, source: &str, ids: &[String]) -> String {
        if !ids.is_empty() {
            let segments: Vec<&str> = source.split('/').collect();
            let parts: Vec<String> = ids
                .iter()
                .filter_map(|pid| {
                    self.pages.get(pid).map(|p| p.title.clone()).or_else(|| {
                        segments
                            .iter()
                            .find(|s| s.contains(pid.as_str()))
                            .map(|s| s.replace(&format!(" {pid}"), ""))
                    })
                })
                .filter(|p| !p.is_empty())
                .map(|f| f.trim_end_matches(['.', ' ']).to_string())
                .collect();
            if !parts.is_empty() {
                return parts.join("/");
            }
        }
        parent(source)
            .split('/')
            .filter(|s| !s.is_empty())
            .map(|s| strip_notion_id(s).trim_end_matches(['.', ' ']).to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    }

    /// `moveParentsToSubfolders`, then collision-free paths for every note and
    /// attachment.
    fn assign_paths(&mut self, parents_in_subfolders: bool, paths: &mut UniquePaths) {
        if parents_in_subfolders {
            let last_parents: HashSet<String> = self
                .pages
                .values()
                .map(|p| p.parent_ids.last().cloned().unwrap_or_default())
                .chain(self.attachments.values().map(|a| a.parent_ids.last().cloned().unwrap_or_default()))
                .collect();
            for (id, p) in self.pages.iter_mut() {
                if last_parents.contains(id) {
                    p.parent_ids.push(id.clone());
                }
            }
        }
        for id in self.page_order.clone() {
            let (source, ids, title) = {
                let p = &self.pages[&id];
                (p.source.clone(), p.parent_ids.clone(), p.title.clone())
            };
            let folder = self.folder_for(&source, &ids);
            let path = paths.claim(&folder, &format!("{title}.md"));
            let p = self.pages.get_mut(&id).unwrap();
            p.title = split_ext(basename(&path)).0.to_string();
            p.path = path;
        }
        let keys: Vec<String> = self.attachments.keys().cloned().collect();
        for k in keys {
            let (ids, name) = {
                let a = &self.attachments[&k];
                (a.parent_ids.clone(), a.name.clone())
            };
            let folder = self.folder_for(&k, &ids);
            let path = paths.claim(&folder, &name);
            self.attachments.get_mut(&k).unwrap().path = path;
        }
    }
}

pub fn convert_with(files: &[(String, Vec<u8>)], opts: &NotionOptions) -> ImportResult {
    let mut result = ImportResult::default();
    let files = expand(files, &mut result.warnings);
    let html_pages = files
        .iter()
        .filter(|(p, _)| extension_lower(p) == "html" && notion_id(basename(p)).is_some())
        .count();
    let md_pages = files
        .iter()
        .filter(|(p, _)| extension_lower(p) == "md" && notion_id(basename(p)).is_some())
        .count();
    if html_pages == 0 && md_pages == 0 {
        result
            .warnings
            .push("No Notion pages found: expected an HTML or Markdown & CSV export".into());
        return result;
    }
    if html_pages >= md_pages {
        convert_html_export(&files, opts, &mut result);
    } else {
        convert_markdown_export(&files, opts, &mut result);
    }
    result
}

// === HTML export ==================================================================

fn convert_html_export(files: &[(String, Vec<u8>)], opts: &NotionOptions, result: &mut ImportResult) {
    let mut plan = Plan {
        pages: HashMap::new(),
        page_order: Vec::new(),
        attachments: BTreeMap::new(),
    };
    let mut docs: HashMap<String, Doc> = HashMap::new();
    for (path, data) in files {
        let ext = extension_lower(path);
        let name = basename(path);
        if name == "index.html" && !path.contains('/') {
            continue;
        }
        if ext == "html" {
            let doc = Doc::parse_html(&super::util::decode_text(data));
            let id = doc
                .find(doc.root, "body")
                .and_then(|b| doc.element_children(b).into_iter().find_map(|c| doc.attr(c, "id").and_then(notion_id)));
            let Some(id) = id else {
                result.warnings.push(format!("Skipped {path}: no Notion page id found"));
                continue;
            };
            let title = doc
                .find(doc.root, "title")
                .map(|t| doc.text_content(t))
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| "Untitled".into());
            let time_of = |class: &str| {
                doc.descendants(doc.root)
                    .into_iter()
                    .find(|n| doc.is(*n, "tr") && doc.has_class(*n, class))
                    .and_then(|tr| doc.find(tr, "time"))
                    .and_then(|t| dates::parse_english(&doc.text_content(t)))
                    .map(|c| c.ms())
            };
            let info = PageInfo {
                source: path.clone(),
                title: clean_title(&title),
                parent_ids: parent_ids(path),
                ctime: time_of("property-row-created_time"),
                mtime: time_of("property-row-last_edited_time"),
                path: String::new(),
            };
            if !plan.pages.contains_key(&id) {
                plan.page_order.push(id.clone());
            }
            plan.pages.insert(id.clone(), info);
            docs.insert(id, doc);
        } else if ext == "csv" && notion_id(name).is_some() {
            continue;
        } else {
            plan.attachments.insert(
                path.clone(),
                AttachmentInfo {
                    name: sanitize_file_name(&percent_decode(name)),
                    parent_ids: parent_ids(path),
                    path: String::new(),
                },
            );
        }
    }
    let mut paths = UniquePaths::new();
    plan.assign_paths(opts.parents_in_subfolders, &mut paths);
    let resolver = LinkResolver::new(
        plan.pages
            .values()
            .map(|p| p.path.as_str())
            .chain(plan.attachments.values().map(|a| a.path.as_str())),
    );

    for id in plan.page_order.clone() {
        let Some(mut doc) = docs.remove(&id) else {
            continue;
        };
        let info = plan.pages[&id].clone();
        match convert_html_page(&mut doc, &info, &plan, &resolver, opts) {
            Some(md) => result
                .files
                .push(ImportedFile::note(info.path.clone(), md).with_times(info.ctime, info.mtime.or(info.ctime))),
            None => result
                .warnings
                .push(format!("Skipped {}: the page body was not found", info.source)),
        }
    }
    for (source, a) in &plan.attachments {
        if let Some((_, data)) = files.iter().find(|(p, _)| p == source) {
            result.files.push(ImportedFile::new(a.path.clone(), data.clone()));
        }
    }
}

enum NotionLink {
    Relation(String),
    Attachment(String),
    Toc,
}

fn classify_link(href: &str, doc: &Doc, a: Id, plan: &Plan) -> Option<NotionLink> {
    let decoded = percent_decode(href);
    let mut decoded = decoded.as_str();
    while let Some(rest) = decoded.strip_prefix("../") {
        decoded = rest;
    }
    let decoded = decoded.to_string();
    let id = notion_id(&decoded);
    if let Some(id) = id.as_ref().filter(|_| decoded.ends_with(".html")) {
        return Some(NotionLink::Relation(id.clone()));
    }
    if !decoded.is_empty() && !decoded.starts_with('#') && !super::util::has_scheme(&decoded) {
        if let Some(k) = plan.attachments.keys().find(|k| k.contains(&decoded) || percent_decode(k).ends_with(&decoded)) {
            return Some(NotionLink::Attachment(k.clone()));
        }
    }
    if decoded.starts_with('#')
        && doc
            .parent(a)
            .is_some_and(|p| doc.has_class(p, "table_of_contents-item"))
    {
        return Some(NotionLink::Toc);
    }
    None
}

fn convert_links(doc: &mut Doc, scope: Id, plan: &Plan, resolver: &LinkResolver, tokens: &mut Tokens, embed: bool) {
    for a in doc.find_all(scope, "a") {
        let Some(href) = doc.attr(a, "href").map(str::to_string) else {
            continue;
        };
        let Some(kind) = classify_link(&href, doc, a, plan) else {
            continue;
        };
        let in_table = doc.closest(a, "table").is_some();
        let text = match kind {
            NotionLink::Relation(id) => match plan.pages.get(&id) {
                Some(p) => {
                    let link = resolver.link(&p.path);
                    if link == p.title {
                        format!("[[{link}]]")
                    } else if in_table {
                        format!("[[{link}\\|{}]]", p.title)
                    } else {
                        format!("[[{link}|{}]]", p.title)
                    }
                }
                None => {
                    let name = strip_notion_id(basename(&percent_decode(&href)));
                    format!("[[{}]]", split_ext(&name).0)
                }
            },
            NotionLink::Attachment(k) => {
                let a_info = &plan.attachments[&k];
                format!("{}[[{}]]", if embed { "!" } else { "" }, resolver.link(&a_info.path))
            }
            NotionLink::Toc => {
                let t = doc.text_content(a);
                let pad = if t.ends_with(']') { " " } else { "" };
                format!("[[#{t}{pad}]]")
            }
        };
        let tok = tokens.add(text);
        doc.replace_with_text(a, &tok);
    }
}

fn has_class_prefix(doc: &Doc, id: Id, fragment: &str) -> bool {
    doc.attr(id, "class").is_some_and(|c| c.contains(fragment))
}

fn convert_html_page(doc: &mut Doc, info: &PageInfo, plan: &Plan, resolver: &LinkResolver, opts: &NotionOptions) -> Option<String> {
    let root = doc.root;
    let body = doc
        .descendants(root)
        .into_iter()
        .find(|n| doc.is(*n, "div") && doc.attr(*n, "class") == Some("page-body"))?;
    let mut tokens = Tokens::new();
    convert_links(doc, body, plan, resolver, &mut tokens, true);

    // Properties.
    let mut props: Vec<(String, Yaml)> = Vec::new();
    if let Some(table) = doc
        .descendants(root)
        .into_iter()
        .find(|n| doc.is(*n, "table") && doc.attr(*n, "class") == Some("properties"))
    {
        convert_links(doc, table, plan, resolver, &mut tokens, false);
        for a in doc.find_all(table, "a") {
            let href = doc.attr(a, "href").unwrap_or("").to_string();
            doc.replace_with_text(a, &href);
        }
        for row in doc.find_all(table, "tr") {
            if let Some((k, v)) = parse_property(doc, row, &tokens) {
                if let Some(slot) = props.iter_mut().find(|(key, _)| *key == k) {
                    slot.1 = v;
                } else {
                    props.push((k, v));
                }
            }
        }
    }

    // Body fixes, in the importer's order.
    for tag in ["strong", "em", "mark", "del"] {
        replace_nested(doc, body, tag);
    }
    for tag in ["strong", "em", "mark", "del"] {
        merge_adjacent(doc, body, tag);
    }
    for tag in ["strong", "em", "mark", "del"] {
        for el in doc.find_all(body, tag) {
            strip_leading_br(doc, el);
        }
    }
    for tag in ["strong", "em", "mark", "del"] {
        split_brs(doc, body, tag);
    }
    fix_bookmarks(doc, body, &mut tokens);
    fix_equations(doc, body, &mut tokens);
    fix_callouts(doc, body, &mut tokens);
    encode_newlines(doc, body);
    for t in doc.find_all(body, "time") {
        let text = doc.text_content(t).replace('@', "");
        let kids = doc.children(t).to_vec();
        for k in kids {
            doc.detach(k);
        }
        let n = doc.create_text(&text);
        doc.append(t, n);
    }
    for d in doc.descendants(body) {
        if (doc.is(d, "div") && doc.has_class(d, "indented")) || doc.is(d, "details") {
            doc.unwrap(d);
        }
    }
    for s in doc.find_all(body, "summary") {
        let style = doc.attr(s, "style").unwrap_or("").to_string();
        let level = [("1.875em", "h1"), ("1.5em", "h2"), ("1.25em", "h3")]
            .iter()
            .find(|(size, _)| style.contains(size))
            .map(|(_, h)| *h);
        match level {
            Some(h) => {
                let text = doc.text_content(s);
                let el = doc.create_element(h, Vec::new());
                let t = doc.create_text(&text);
                doc.append(el, t);
                doc.replace_with(s, &[el]);
            }
            None => doc.rename(s, "p"),
        }
    }
    for div in doc.find_all(body, "div") {
        let style = doc.attr(div, "style").unwrap_or("").replace(' ', "");
        if style.contains("display:contents") {
            let kids = doc.element_children(div);
            if kids.len() == 1 && (doc.is(kids[0], "ul") || doc.is(kids[0], "ol")) {
                doc.unwrap(div);
            }
        }
    }
    merge_lists(doc, body, "ul");
    merge_lists(doc, body, "ol");
    for el in doc.descendants(body) {
        if let Some(c) = doc.attr(el, "class").map(str::to_string) {
            if c.split_whitespace().any(|x| x == "language-Mermaid") {
                doc.set_attr(el, "class", &c.replace("language-Mermaid", "language-mermaid"));
            }
        }
    }
    for el in doc.descendants(body) {
        if doc.parent(el).is_none() || doc.name(el).is_none() {
            continue;
        }
        if doc.has_class(el, "checkbox") && (doc.has_class(el, "checkbox-on") || doc.has_class(el, "checkbox-off")) && doc.closest(el, "td").is_none() {
            let tok = tokens.add(if doc.has_class(el, "checkbox-on") { "[x] " } else { "[ ] " });
            doc.replace_with_text(el, &tok);
        }
    }
    format_toc(doc, body);
    format_databases(doc, body);

    let html = doc.inner_html(body);
    let mut md = crate::html_to_markdown(&html, None);
    if opts.single_line_breaks {
        md = regex_lite::Regex::new(r"\n\n([^>])").unwrap().replace_all(&md, "\n$1").into_owned();
    }
    let md = tokens.replace(&md);
    let md = escape_hashtags(&md);
    let md = fix_double_backslash(&md);
    let md = preserve_bare_url_links(&md);
    // A Notion quote whose text starts `[!tip]` is a callout; the converter
    // escaped its brackets.
    let md = regex_lite::Regex::new(r"(?m)^((?:> ?)+)\\\[!([A-Za-z-]+)\\\]")
        .unwrap()
        .replace_all(&md, "$1[!$2]")
        .into_owned();
    let md = tidy_task_markers(&md);
    let description = doc
        .descendants(root)
        .into_iter()
        .find(|n| doc.is(*n, "p") && has_class_prefix(doc, *n, "page-description"))
        .map(|p| doc.text_content(p))
        .filter(|d| !d.trim().is_empty());
    let md = match description {
        Some(d) => format!("{d}\n\n{md}"),
        None => md,
    };
    let _ = info;
    Some(format!("{}{}", frontmatter(&props), md))
}

/// Notion writes two spaces after a to-do's box, and a box with nothing after
/// it still has them; an empty callout title keeps its trailing space. Tidy
/// both, outside code.
fn tidy_task_markers(md: &str) -> String {
    let spaced = regex_lite::Regex::new(r"(?m)^([ \t]*(?:[-*+] |\d+\. )?(?:> )*\[[ xX]\]) {2,}").unwrap();
    let trailing = regex_lite::Regex::new(r"(?m)^([ \t>]*(?:[-*+] |\d+\. )?(?:> )*\[(?:[ xX]|!important)\])[ \t]+$").unwrap();
    super::mdcode::outside_fences(md, |seg| {
        let s = spaced.replace_all(seg, "$1 ");
        trailing.replace_all(&s, "$1").into_owned()
    })
}

fn parse_property(doc: &mut Doc, row: Id, tokens: &Tokens) -> Option<(String, Yaml)> {
    let class = doc.attr(row, "class")?.to_string();
    let kind = class
        .split_whitespace()
        .find_map(|c| c.strip_prefix("property-row-"))?
        .to_string();
    let cells = doc.element_children(row);
    let (th, td) = (*cells.first()?, *cells.get(1)?);
    let mut title = tokens.replace(doc.text_content(th).trim());
    let text = |doc: &Doc, id: Id| tokens.replace(&doc.text_content(id));
    let value = match kind.as_str() {
        "checkbox" => Yaml::Bool(doc.inner_html(td).contains("checkbox-on")),
        "number" | "auto_increment_id" => {
            let t = text(doc, td);
            let t = t.trim();
            if t.is_empty() {
                Yaml::Null
            } else if t.parse::<f64>().is_ok_and(|f| f.is_finite()) {
                Yaml::Number(t.to_string())
            } else {
                Yaml::Str(t.to_string())
            }
        }
        "created_time" | "last_edited_time" | "date" => {
            let times = doc.find_all(td, "time");
            let parsed: Vec<String> = times
                .iter()
                .map(|t| doc.text_content(*t).replace('@', ""))
                .flat_map(|t| t.split(" → ").map(str::to_string).collect::<Vec<_>>())
                .filter_map(|t| dates::parse_english(&t))
                .map(|c| match c.time {
                    Some((0, 0)) | None => c.iso_date(),
                    Some((h, m)) => format!("{}T{h:02}:{m:02}", c.iso_date()),
                })
                .collect();
            if parsed.is_empty() {
                return None;
            }
            Yaml::Str(parsed.join(" - "))
        }
        "file" | "multi_select" | "relation" => {
            let items: Vec<String> = doc
                .element_children(td)
                .into_iter()
                .map(|c| text(doc, c))
                .filter(|t| !t.is_empty())
                .collect();
            if items.is_empty() {
                return None;
            }
            Yaml::list(items)
        }
        _ => {
            let t = text(doc, td);
            if t.is_empty() {
                return None;
            }
            Yaml::Str(t)
        }
    };
    let value = if title == "Tags" {
        title = "tags".into();
        match value {
            Yaml::Str(s) => Yaml::Str(s.replace(' ', "-")),
            Yaml::List(items) => Yaml::List(
                items
                    .into_iter()
                    .map(|i| match i {
                        Yaml::Str(s) => Yaml::Str(s.replace(' ', "-")),
                        o => o,
                    })
                    .collect(),
            ),
            o => o,
        }
    } else {
        value
    };
    Some((title, value))
}

fn replace_nested(doc: &mut Doc, body: Id, tag: &str) {
    for el in doc.find_all(body, tag) {
        if doc.parent(el).is_none_or(|p| doc.is(p, tag)) {
            continue;
        }
        for inner in doc.find_all(el, tag).into_iter().skip(1) {
            doc.unwrap(inner);
        }
    }
}

fn merge_adjacent(doc: &mut Doc, body: Id, tag: &str) {
    for el in doc.find_all(body, tag) {
        if doc.parent(el).is_none() {
            continue;
        }
        loop {
            let mut next = doc.next_sibling(el);
            let mut ws = None;
            if let Some(n) = next {
                if doc.text(n).is_some_and(|t| t.chars().all(|c| c == ' ')) {
                    ws = Some(n);
                    next = doc.next_sibling(n);
                }
            }
            let Some(n) = next.filter(|n| doc.is(*n, tag)) else {
                break;
            };
            if let Some(w) = ws {
                doc.append(el, w);
            }
            for k in doc.children(n).to_vec() {
                doc.append(el, k);
            }
            doc.detach(n);
        }
    }
}

fn strip_leading_br(doc: &mut Doc, el: Id) {
    if let Some(prev) = doc.previous_sibling(el) {
        if doc.is(prev, "br") {
            doc.detach(prev);
        }
    }
}

fn split_brs(doc: &mut Doc, body: Id, tag: &str) {
    for el in doc.find_all(body, tag) {
        if doc.parent(el).is_none() || !doc.children(el).iter().any(|c| doc.is(*c, "br")) {
            continue;
        }
        let mut replacement = Vec::new();
        let mut current = doc.create_element(tag, Vec::new());
        for c in doc.children(el).to_vec() {
            if doc.is(c, "br") {
                if !doc.children(current).is_empty() {
                    replacement.push(current);
                }
                replacement.push(c);
                current = doc.create_element(tag, Vec::new());
            } else {
                doc.append(current, c);
            }
        }
        if !doc.children(current).is_empty() {
            replacement.push(current);
        }
        doc.replace_with(el, &replacement);
    }
}

fn block_token(doc: &mut Doc, id: Id, token: &str) {
    let p = doc.create_element("p", Vec::new());
    let t = doc.create_text(token);
    doc.append(p, t);
    doc.replace_with(id, &[p]);
}

fn fix_bookmarks(doc: &mut Doc, body: Id, tokens: &mut Tokens) {
    for a in doc.find_all(body, "a") {
        if !(doc.has_class(a, "bookmark") && doc.has_class(a, "source")) || doc.parent(a).is_none() {
            continue;
        }
        let link = doc.attr(a, "href").unwrap_or("").to_string();
        let find_class = |doc: &Doc, class: &str| {
            doc.descendants(a)
                .into_iter()
                .find(|n| doc.has_class(*n, class))
                .map(|n| doc.text_content(n))
                .unwrap_or_default()
        };
        let title = find_class(doc, "bookmark-title");
        let description = find_class(doc, "bookmark-description");
        let first_sentence: String = {
            let end = description.find(['.', '?', '!', '\n']).map(|i| {
                if description[i..].starts_with('\n') {
                    i
                } else {
                    i + 1
                }
            });
            description[..end.unwrap_or(description.len())].to_string()
        };
        let tok = tokens.add(format!("> [!info] {title}\n> {first_sentence}\n> [{link}]({link})"));
        // Bookmarks sit inside a <figure>; replace that when it holds nothing else.
        let target = doc
            .parent(a)
            .filter(|p| doc.is(*p, "figure") && doc.element_children(*p).len() == 1)
            .unwrap_or(a);
        block_token(doc, target, &tok);
    }
}

fn format_math(math: &str, inline: bool) -> String {
    let re = regex_lite::Regex::new(r"(?s)^(?:\s|\\\\|\\\s)*(.*?)[\s\\]*$").unwrap();
    let inner = re.replace(math, "$1").into_owned();
    let lines = regex_lite::Regex::new(r"[\r\n]+").unwrap();
    lines.replace_all(&inner, if inline { " " } else { "\n" }).into_owned()
}

fn fix_equations(doc: &mut Doc, body: Id, tokens: &mut Tokens) {
    for s in doc.find_all(body, "style") {
        doc.detach(s);
    }
    for fig in doc.find_all(body, "figure") {
        if !doc.has_class(fig, "equation") || doc.parent(fig).is_none() {
            continue;
        }
        if let Some(ann) = doc.find(fig, "annotation") {
            let math = format_math(&doc.text_content(ann), false);
            let tok = tokens.add(format!("$${math}$$"));
            block_token(doc, fig, &tok);
        }
    }
    for span in doc.find_all(body, "span") {
        if !doc.has_class(span, "notion-text-equation-token") || doc.parent(span).is_none() {
            continue;
        }
        strip_leading_br(doc, span);
        if let Some(ann) = doc.find(span, "annotation") {
            let math = format_math(&doc.text_content(ann), true);
            let tok = tokens.add(format!("${math}$"));
            doc.replace_with_text(span, &tok);
        }
    }
}

fn fix_callouts(doc: &mut Doc, body: Id, tokens: &mut Tokens) {
    for fig in doc.find_all(body, "figure") {
        if !doc.has_class(fig, "callout") || doc.parent(fig).is_none() {
            continue;
        }
        let Some(content) = doc.element_children(fig).last().copied() else {
            continue;
        };
        let quote = doc.create_element("blockquote", Vec::new());
        for k in doc.children(content).to_vec() {
            doc.append(quote, k);
        }
        let marker = tokens.add("[!important] ");
        let first = doc.children(quote).first().copied();
        match first {
            Some(f) if doc.text(f).is_some() || matches!(doc.name(f), Some("p" | "em" | "strong" | "del" | "mark")) => {
                let title = doc.create_element("p", Vec::new());
                let m = doc.create_text(&marker);
                doc.append(title, m);
                if doc.is(f, "p") {
                    for k in doc.children(f).to_vec() {
                        if doc.is(k, "br") {
                            let t = tokens.add("<br>");
                            let tn = doc.create_text(&t);
                            doc.append(title, tn);
                        } else {
                            doc.append(title, k);
                        }
                    }
                    doc.replace_with(f, &[title]);
                } else {
                    doc.insert_before(f, title);
                    doc.append(title, f);
                }
            }
            _ => {
                let title = doc.create_element("p", Vec::new());
                let m = doc.create_text(&marker);
                doc.append(title, m);
                doc.prepend(quote, title);
            }
        }
        doc.replace_with(fig, &[quote]);
    }
}

fn encode_newlines(doc: &mut Doc, body: Id) {
    for n in doc.descendants(body) {
        let Some(text) = doc.text(n).map(str::to_string) else {
            continue;
        };
        if !text.contains('\n') || doc.parent(n).is_none() {
            continue;
        }
        let in_code = {
            let mut cur = doc.parent(n);
            let mut found = false;
            while let Some(c) = cur {
                if doc.is(c, "code") || doc.is(c, "pre") {
                    found = true;
                    break;
                }
                cur = doc.parent(c);
            }
            found
        };
        if in_code {
            continue;
        }
        let parts: Vec<&str> = text.split('\n').collect();
        let mut repl = Vec::new();
        for (i, p) in parts.iter().enumerate() {
            if !p.is_empty() {
                repl.push(doc.create_text(p));
            }
            if i + 1 < parts.len() {
                repl.push(doc.create_element("br", Vec::new()));
            }
        }
        doc.replace_with(n, &repl);
    }
    for code in doc.find_all(body, "code") {
        for br in doc.find_all(code, "br") {
            doc.replace_with_text(br, "\n");
        }
    }
}

fn merge_lists(doc: &mut Doc, body: Id, tag: &str) {
    for list in doc.find_all(body, tag) {
        if doc.parent(list).is_none() {
            continue;
        }
        let class = doc.attr(list, "class").map(str::to_string);
        loop {
            let Some(next) = doc.next_element_sibling(list) else {
                break;
            };
            if !doc.is(next, tag) || doc.attr(next, "class").map(str::to_string) != class {
                break;
            }
            // Only whitespace may sit between the two lists.
            let between_ok = {
                let mut s = doc.next_sibling(list);
                let mut ok = true;
                while let Some(x) = s {
                    if x == next {
                        break;
                    }
                    if !doc.text(x).is_some_and(|t| t.trim().is_empty()) {
                        ok = false;
                        break;
                    }
                    s = doc.next_sibling(x);
                }
                ok
            };
            if !between_ok {
                break;
            }
            for li in doc.children(next).to_vec() {
                doc.append(list, li);
            }
            doc.detach(next);
        }
    }
}

fn format_toc(doc: &mut Doc, body: Id) {
    let Some(nav) = doc
        .descendants(body)
        .into_iter()
        .find(|n| doc.has_class(*n, "table_of_contents"))
    else {
        return;
    };
    let items = doc.element_children(nav);
    if items.is_empty() {
        return;
    }
    let indent_of = |doc: &Doc, id: Id| -> usize {
        doc.attr(id, "class")
            .and_then(|c| c.split_whitespace().find_map(|x| x.strip_prefix("table_of_contents-indent-")))
            .and_then(|n| n.parse().ok())
            .unwrap_or(0)
    };
    let top = doc.create_element("ul", Vec::new());
    // Stack of (indent, ul) for nesting.
    let mut stack: Vec<(usize, Id)> = vec![(0, top)];
    let mut last_li: Option<(usize, Id)> = None;
    for item in items {
        let indent = indent_of(doc, item);
        let li = doc.create_element("li", Vec::new());
        for k in doc.children(item).to_vec() {
            doc.append(li, k);
        }
        if let Some((last_indent, last)) = last_li {
            if indent > last_indent {
                let ul = doc.create_element("ul", Vec::new());
                doc.append(last, ul);
                stack.push((indent, ul));
            } else {
                while stack.len() > 1 && stack.last().unwrap().0 > indent {
                    stack.pop();
                }
            }
        }
        let parent_ul = stack.last().unwrap().1;
        doc.append(parent_ul, li);
        last_li = Some((indent, li));
    }
    doc.replace_with(nav, &[top]);
}

fn format_databases(doc: &mut Doc, body: Id) {
    for span in doc.find_all(body, "span") {
        if doc.attr(span, "class") == Some("user") {
            let t = doc.text_content(span);
            for k in doc.children(span).to_vec() {
                doc.detach(k);
            }
            let n = doc.create_text(&t);
            doc.append(span, n);
        }
    }
    for div in doc.find_all(body, "div") {
        if doc.closest(div, "td").is_some() && has_class_prefix(doc, div, "checkbox") {
            let on = doc.has_class(div, "checkbox-on");
            doc.replace_with_text(div, if on { "X" } else { "" });
        }
    }
    for span in doc.find_all(body, "span") {
        if doc.closest(span, "table").is_none() || !has_class_prefix(doc, span, "selected-value") {
            continue;
        }
        let is_last = doc.parent(span).is_some_and(|p| doc.element_children(p).last() == Some(&span));
        if !is_last {
            let t = doc.create_text(", ");
            doc.append(span, t);
        }
    }
    for a in doc.find_all(body, "a") {
        let href = doc.attr(a, "href").unwrap_or("");
        if !(href.starts_with("http://") || href.starts_with("https://") || href.starts_with("www.")) {
            let t = doc.text_content(a);
            doc.replace_with_text(a, &t);
        }
    }
}

/// Escape `#word` that Obsidian would read as a tag. Code, math, links and
/// already-escaped hashes are left alone.
pub fn escape_hashtags(md: &str) -> String {
    outside_code(md, |seg| {
        let chars: Vec<char> = seg.chars().collect();
        let mut out = String::with_capacity(seg.len());
        let mut i = 0;
        let mut in_wiki = false;
        let mut in_math = false;
        let mut in_dest = 0usize;
        while i < chars.len() {
            let c = chars[i];
            if !in_math && c == '[' && chars.get(i + 1) == Some(&'[') {
                in_wiki = true;
            } else if in_wiki && c == ']' && chars.get(i + 1) == Some(&']') {
                in_wiki = false;
            } else if !in_wiki && c == '$' && (i == 0 || chars[i - 1] != '\\') {
                in_math = !in_math;
            } else if !in_wiki && !in_math && c == '(' && i > 0 && chars[i - 1] == ']' {
                in_dest = 1;
            } else if in_dest > 0 && c == '(' {
                in_dest += 1;
            } else if in_dest > 0 && c == ')' {
                in_dest -= 1;
            } else if c == '\n' {
                in_math = in_math && chars.get(i + 1) == Some(&'$');
            }
            if c == '#' && !in_wiki && !in_math && in_dest == 0 && (i == 0 || chars[i - 1] != '\\') {
                let mut j = i + 1;
                while j < chars.len() && chars[j].is_ascii_digit() {
                    j += 1;
                }
                let next = chars.get(j).copied();
                // `#\_x`: the converter's escaped underscore still starts a tag.
                let escaped_underscore = next == Some('\\') && chars.get(j + 1) == Some(&'_');
                let is_tag = escaped_underscore
                    || next.is_some_and(|n| n.is_ascii_alphabetic() || "-_/".contains(n) || !n.is_ascii());
                let heading = i == 0 || chars[i - 1] == '\n' || chars[..i].iter().rev().take_while(|c| **c != '\n').all(|c| *c == '#' || *c == ' ' || *c == '>');
                let heading = heading && {
                    let run = chars[i..].iter().take_while(|c| **c == '#').count();
                    chars.get(i + run).is_some_and(|c| *c == ' ')
                };
                if is_tag && !heading {
                    out.push('\\');
                }
            }
            out.push(c);
            i += 1;
        }
        out
    })
}

fn fix_double_backslash(md: &str) -> String {
    regex_lite::Regex::new(r"\[\[[^\]]*\\\\\|[^\]]*\]\]")
        .unwrap()
        .replace_all(md, |c: &regex_lite::Captures| c[0].replace("\\\\|", "\\|"))
        .into_owned()
}

/// `[https://x](https://x)` → `https://x`.
fn preserve_bare_url_links(md: &str) -> String {
    outside_code(md, |seg| {
        regex_lite::Regex::new(r"(^|[^!])\[([^\]\n]+)\]\((https?://[^\s)]+)\)")
            .unwrap()
            .replace_all(seg, |c: &regex_lite::Captures| {
                let unescape = |s: &str| {
                    regex_lite::Regex::new(r"\\([\\`*_\[\]{}()#+.!-])")
                        .unwrap()
                        .replace_all(s.trim(), "$1")
                        .into_owned()
                };
                if unescape(&c[2]) == unescape(&c[3]) {
                    format!("{}{}", &c[1], &c[3])
                } else {
                    c[0].to_string()
                }
            })
            .into_owned()
    })
}

// === Markdown & CSV export ============================================================

struct Database {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

fn convert_markdown_export(files: &[(String, Vec<u8>)], opts: &NotionOptions, result: &mut ImportResult) {
    let mut plan = Plan {
        pages: HashMap::new(),
        page_order: Vec::new(),
        attachments: BTreeMap::new(),
    };
    let mut texts: HashMap<String, String> = HashMap::new();
    let mut databases: HashMap<String, Database> = HashMap::new();
    let mut is_database: HashSet<String> = HashSet::new();
    // Prefer `_all.csv` (every property) over the view's `.csv`.
    let mut csvs: Vec<&(String, Vec<u8>)> = files.iter().filter(|(p, _)| extension_lower(p) == "csv").collect();
    csvs.sort_by_key(|(p, _)| !p.ends_with("_all.csv"));
    for (path, data) in csvs {
        let stem = split_ext(basename(path)).0;
        let base = stem.strip_suffix("_all").unwrap_or(stem);
        let Some(id) = notion_id(base) else {
            continue;
        };
        if databases.contains_key(&id) {
            continue;
        }
        let rows = super::csv::parse(&super::util::decode_text(data), ',');
        let mut it = rows.into_iter();
        let headers = it.next().unwrap_or_default();
        databases.insert(id.clone(), Database { headers, rows: it.collect() });
        is_database.insert(id.clone());
        let title = clean_title(&strip_notion_id(base));
        plan.page_order.push(id.clone());
        plan.pages.insert(
            id,
            PageInfo {
                source: format!("{}/{base}.csv", parent(path)).trim_start_matches('/').to_string(),
                title,
                parent_ids: parent_ids(path),
                ctime: None,
                mtime: None,
                path: String::new(),
            },
        );
    }
    for (path, data) in files {
        let ext = extension_lower(path);
        let name = basename(path);
        if ext == "md" {
            let Some(id) = notion_id(name) else {
                result.warnings.push(format!("Skipped {path}: not a Notion page"));
                continue;
            };
            let text = super::util::decode_text(data);
            let fallback = strip_notion_id(split_ext(name).0);
            let title = text
                .lines()
                .next()
                .and_then(|l| l.strip_prefix("# "))
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .unwrap_or(fallback);
            plan.page_order.push(id.clone());
            plan.pages.insert(
                id.clone(),
                PageInfo {
                    source: path.clone(),
                    title: clean_title(&title),
                    parent_ids: parent_ids(path),
                    ctime: None,
                    mtime: None,
                    path: String::new(),
                },
            );
            texts.insert(id, text);
        } else if (ext == "csv" && notion_id(split_ext(name).0.trim_end_matches("_all")).is_some())
            || path == "index.html"
        {
            // Databases were read above; index.html is the export's summary.
            continue;
        } else {
            plan.attachments.insert(
                path.clone(),
                AttachmentInfo {
                    name: sanitize_file_name(&percent_decode(name)),
                    parent_ids: parent_ids(path),
                    path: String::new(),
                },
            );
        }
    }
    let mut paths = UniquePaths::new();
    plan.assign_paths(opts.parents_in_subfolders, &mut paths);
    let resolver = LinkResolver::new(
        plan.pages
            .values()
            .map(|p| p.path.as_str())
            .chain(plan.attachments.values().map(|a| a.path.as_str())),
    );
    // Source path (without id-bearing extension variants) → page id.
    let by_source: HashMap<String, String> = plan
        .pages
        .iter()
        .map(|(id, p)| (p.source.to_lowercase(), id.clone()))
        .collect();

    for id in plan.page_order.clone() {
        let info = plan.pages[&id].clone();
        if let Some(db) = databases.get(&id) {
            let md = database_note(db, &id, &plan, &resolver);
            result.files.push(ImportedFile::note(info.path.clone(), md));
            continue;
        }
        let text = texts.remove(&id).unwrap_or_default();
        // A row page's properties are named by its database's headers.
        let db = info.parent_ids.last().and_then(|p| databases.get(p));
        let md = markdown_page(&text, &info, db, &plan, &resolver, &by_source);
        result.files.push(ImportedFile::note(info.path.clone(), md));
    }
    for (source, a) in &plan.attachments {
        if let Some((_, data)) = files.iter().find(|(p, _)| p == source) {
            result.files.push(ImportedFile::new(a.path.clone(), data.clone()));
        }
    }
}

fn wikilink(resolver: &LinkResolver, path: &str, title: &str, text: &str) -> String {
    let link = resolver.link(path);
    let shown = if text.trim().is_empty() { title } else { text };
    if shown == link {
        format!("[[{link}]]")
    } else {
        format!("[[{link}|{shown}]]")
    }
}

fn markdown_page(
    text: &str,
    info: &PageInfo,
    db: Option<&Database>,
    plan: &Plan,
    resolver: &LinkResolver,
    by_source: &HashMap<String, String>,
) -> String {
    let mut lines: Vec<&str> = text.split('\n').collect();
    // The title came from this line (see `convert_markdown_export`).
    if lines.first().is_some_and(|l| l.starts_with("# ")) {
        lines.remove(0);
    }
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    let mut props: Vec<(String, Yaml)> = Vec::new();
    if let Some(db) = db {
        let mut consumed = 0;
        for line in &lines {
            let Some((k, v)) = line.split_once(": ") else {
                break;
            };
            if !db.headers.iter().any(|h| h.trim() == k.trim()) {
                break;
            }
            let column = db.headers.iter().position(|h| h.trim() == k.trim()).unwrap_or(0);
            props.push((k.trim().to_string(), property_value(k.trim(), v, db, column, info, plan, resolver, by_source)));
            consumed += 1;
        }
        lines.drain(..consumed);
        while lines.first().is_some_and(|l| l.trim().is_empty()) {
            lines.remove(0);
        }
    }
    let body = lines.join("\n");
    let body = relink_markdown(&body, info, plan, resolver, by_source);
    let body = tidy_task_markers(body.trim_end());
    let fm = frontmatter(&props);
    if body.is_empty() {
        fm
    } else {
        format!("{fm}{body}\n")
    }
}

#[allow(clippy::too_many_arguments)]
fn property_value(
    key: &str,
    value: &str,
    db: &Database,
    column: usize,
    info: &PageInfo,
    plan: &Plan,
    resolver: &LinkResolver,
    by_source: &HashMap<String, String>,
) -> Yaml {
    let v = value.trim();
    if v.is_empty() {
        return Yaml::Null;
    }
    // Relations: `Name (Name%20id.md), Other (…)`.
    if v.contains(".md)") {
        let links: Vec<String> = regex_lite::Regex::new(r"([^,(]*?)\s*\(([^()]*\.md)\)")
            .unwrap()
            .captures_iter(v)
            .map(|c| {
                let target = resolve_path(parent(&info.source), &percent_decode(&c[2]));
                match by_source.get(&target.to_lowercase()).and_then(|id| plan.pages.get(id)) {
                    Some(p) => wikilink(resolver, &p.path, &p.title, ""),
                    None => format!("[[{}]]", c[1].trim()),
                }
            })
            .collect();
        if !links.is_empty() {
            return Yaml::list(links);
        }
    }
    let column_values: Vec<&str> = db.rows.iter().filter_map(|r| r.get(column)).map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if !column_values.is_empty() && column_values.iter().all(|c| *c == "Yes" || *c == "No") {
        return Yaml::Bool(v == "Yes");
    }
    if key.eq_ignore_ascii_case("tags") {
        return Yaml::list(v.split(", ").map(|t| t.trim().replace(' ', "-")));
    }
    if let Some(d) = dates::parse_english(v) {
        let whole = regex_lite::Regex::new(r"^@?[A-Za-z]+\.? \d{1,2},? \d{4}( \d{1,2}:\d{2}( [AP]M)?)?( → .*)?$").unwrap();
        if whole.is_match(v) {
            return Yaml::Str(match d.time {
                Some((0, 0)) | None => d.iso_date(),
                Some((h, m)) => format!("{}T{h:02}:{m:02}", d.iso_date()),
            });
        }
    }
    typed(v)
}

fn relink_markdown(body: &str, info: &PageInfo, plan: &Plan, resolver: &LinkResolver, by_source: &HashMap<String, String>) -> String {
    let re = regex_lite::Regex::new(r"(!?)\[([^\]\n]*)\]\(([^)\n]+)\)").unwrap();
    outside_code(body, |seg| {
        re.replace_all(seg, |c: &regex_lite::Captures| {
            let href = c[3].trim();
            if super::util::has_scheme(href) || href.starts_with('#') {
                return c[0].to_string();
            }
            let target = resolve_path(parent(&info.source), &percent_decode(href));
            let target_lower = target.to_lowercase();
            if let Some(a) = plan.attachments.get(&target).or_else(|| {
                plan.attachments
                    .iter()
                    .find(|(k, _)| k.to_lowercase() == target_lower || percent_decode(k).to_lowercase() == target_lower)
                    .map(|(_, a)| a)
            }) {
                return format!("![[{}]]", resolver.link(&a.path));
            }
            let lookup = if target_lower.ends_with("_all.csv") {
                target_lower.replace("_all.csv", ".csv")
            } else {
                target_lower
            };
            // By path, else by the id in the file name: a link to a database
            // view's CSV reaches the database page when that is what exported.
            let id_of_target = notion_id(split_ext(basename(&lookup)).0.trim_end_matches("_all"));
            let page = by_source
                .get(&lookup)
                .or(id_of_target.as_ref())
                .and_then(|id| plan.pages.get(id));
            if let Some(p) = page {
                let text = &c[2];
                return format!("{}{}", &c[1], wikilink(resolver, &p.path, &p.title, text));
            }
            // A link to a page or database that is not in the export (a
            // linked view, a page without access) keeps its text only.
            if id_of_target.is_some() && c[1].is_empty() {
                return c[2].to_string();
            }
            c[0].to_string()
        })
        .into_owned()
    })
}

fn database_note(db: &Database, id: &str, plan: &Plan, resolver: &LinkResolver) -> String {
    if db.headers.is_empty() {
        return String::new();
    }
    let rows_by_title: HashMap<String, &PageInfo> = plan
        .pages
        .values()
        .filter(|p| p.parent_ids.iter().any(|x| x == id))
        .map(|p| (p.title.to_lowercase(), p))
        .collect();
    let cell = |s: &str| s.trim().replace('|', "\\|").replace("\r\n", "<br>").replace('\n', "<br>");
    let mut out = format!("| {} |\n|{}\n", db.headers.iter().map(|h| cell(h)).collect::<Vec<_>>().join(" | "), " --- |".repeat(db.headers.len()));
    for row in &db.rows {
        let mut cells: Vec<String> = (0..db.headers.len()).map(|i| cell(row.get(i).map(|s| s.as_str()).unwrap_or(""))).collect();
        if let Some(first) = row.first() {
            if let Some(p) = rows_by_title.get(&clean_title(first.trim()).to_lowercase()) {
                let link = resolver.link(&p.path);
                cells[0] = if link == p.title {
                    format!("[[{link}]]")
                } else {
                    format!("[[{link}\\|{}]]", p.title)
                };
            }
        }
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::ZipWriter;

    const ID_PARENT: &str = "1590080aa5a3802488c2e857dea7aa7d";
    const ID_CHILD: &str = "1580080aa5a380d1b0c7c2f979343d88";
    const ID_ROW: &str = "15f0080aa5a380c6b16cfed449a03a8b";

    fn page(id: &str, title: &str, body: &str, header_extra: &str) -> String {
        let dashed = format!("{}-{}-{}-{}-{}", &id[..8], &id[8..12], &id[12..16], &id[16..20], &id[20..]);
        format!("<html><head><meta charset=\"utf-8\"><title>{title}</title><style>p{{}}</style></head><body><article id=\"{dashed}\" class=\"page sans\"><header><h1 class=\"page-title\">{title}</h1><p class=\"page-description\"></p>{header_extra}</header><div class=\"page-body\">{body}</div></article></body></html>")
    }

    #[test]
    fn ids_are_found_and_stripped() {
        assert_eq!(notion_id("Page 0123456789abcdef0123456789abcdef.md").as_deref(), Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(notion_id("15f0080a-a5a3-80c6-b16c-fed449a03a8b").as_deref(), Some("15f0080aa5a380c6b16cfed449a03a8b"));
        assert_eq!(notion_id("Plain name.md"), None);
        assert_eq!(strip_notion_id("Page 0123456789abcdef0123456789abcdef.md"), "Page.md");
        assert_eq!(strip_notion_id("Folder 0123456789abcdef0123456789abcdef"), "Folder");
        assert_eq!(strip_notion_id("image.png"), "image.png");
    }

    #[test]
    fn nested_export_zip_parents_in_subfolders_and_links() {
        let parent_html = page(ID_PARENT, "Notion-Testspace", &format!("<p>See <a href=\"Notion-Testspace%20{ID_PARENT}/Formatting%20Tests%20{ID_CHILD}.html\">Formatting Tests</a></p><p>Tag #abc and #123 and <code>#code</code></p>"), "");
        let child_html = page(ID_CHILD, "Formatting Tests: part/1", &format!("<figure><div class=\"source\"><a href=\"Formatting%20Tests%20{ID_CHILD}/cat%20photo.jpg\">cat photo.jpg</a></div></figure><ul class=\"to-do-list\"><li><div class=\"checkbox checkbox-off\"></div> <span>todo item</span></li></ul><ul class=\"bulleted-list\"><li>one</li></ul><ul class=\"bulleted-list\"><li>two</li></ul>"), "");
        let root = "Export-950ad927-7171-4abf-9001-821e5310d286";
        let mut inner = ZipWriter::new();
        inner.add_text(&format!("{root}/index.html"), "<html></html>");
        inner.add_text(&format!("{root}/Notion-Testspace {ID_PARENT}.html"), &parent_html);
        inner.add_text(&format!("{root}/Notion-Testspace {ID_PARENT}/Formatting Tests {ID_CHILD}.html"), &child_html);
        inner.add(&format!("{root}/Notion-Testspace {ID_PARENT}/Formatting Tests {ID_CHILD}/cat photo.jpg"), b"JPG", crate::zip::Method::Store);
        let mut outer = ZipWriter::new();
        outer.add(&format!("{root}-Part-1.zip"), &inner.finish(), crate::zip::Method::Store);
        let r = convert(&[("notion.zip".to_string(), outer.finish())]);
        let mut paths = r.paths();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "Notion-Testspace/Formatting Tests- part-1/Formatting Tests- part-1.md",
                "Notion-Testspace/Formatting Tests- part-1/cat photo.jpg",
                "Notion-Testspace/Notion-Testspace.md",
            ]
        );
        let p = r.text("Notion-Testspace/Notion-Testspace.md");
        assert!(p.contains("See [[Formatting Tests- part-1]]"), "{p}");
        assert!(p.contains("\\#abc") && p.contains("#123") && !p.contains("\\#123") && p.contains("`#code`"), "{p}");
        let c = r.text("Notion-Testspace/Formatting Tests- part-1/Formatting Tests- part-1.md");
        assert!(c.contains("![[cat photo.jpg]]"), "{c}");
        assert!(c.contains("[ ] todo item"), "{c}");
        let one = c.find("one").unwrap();
        let two = c.find("two").unwrap();
        assert!(!c[one..two].contains("\n\n"), "lists should merge: {c}");
    }

    #[test]
    fn properties_become_frontmatter() {
        let table = "<table class=\"properties\"><tbody><tr class=\"property-row property-row-text\"><th>Notes</th><td>Double boiler, plumbed in.</td></tr><tr class=\"property-row property-row-number\"><th>Price</th><td>67.3</td></tr><tr class=\"property-row property-row-number\"><th>Price (USD)</th><td>$1,234.56</td></tr><tr class=\"property-row property-row-multi_select\"><th>Tags</th><td><span class=\"selected-value\">home office</span><span class=\"selected-value\">coffee</span></td></tr><tr class=\"property-row property-row-checkbox\"><th>Serviced</th><td><div class=\"checkbox checkbox-on\"></div></td></tr><tr class=\"property-row property-row-checkbox\"><th>Sold</th><td><div class=\"checkbox checkbox-off\"></div></td></tr><tr class=\"property-row property-row-date\"><th>Bought</th><td><time>@March 1, 2024 3:45 PM</time></td></tr><tr class=\"property-row property-row-url\"><th>Manual</th><td><a href=\"https://example.com/manual\">https://example.com/manual</a></td></tr><tr class=\"property-row property-row-text\"><th>Empty</th><td></td></tr><tr class=\"property-row property-row-created_time\"><th>Created</th><td><time>@January 5, 2024 9:00 AM</time></td></tr></tbody></table>";
        let html = page(ID_ROW, "Espresso machine", "<p>A row kept for its properties.</p>", table);
        let r = convert(&[(format!("Espresso machine {ID_ROW}.html"), html.into_bytes())]);
        let t = r.text("Espresso machine.md");
        assert!(t.starts_with("---\nNotes: Double boiler, plumbed in.\nPrice: 67.3\nPrice (USD): $1,234.56\ntags:\n  - home-office\n  - coffee\nServiced: true\nSold: false\nBought: 2024-03-01T15:45\nManual: https://example.com/manual\nCreated: 2024-01-05T09:00\n---\n"), "{t}");
        assert!(t.contains("A row kept for its properties."));
        assert_eq!(r.file("Espresso machine.md").unwrap().ctime_ms, Some(dates::to_ms(2024, 1, 5, 9, 0, 0)));
    }

    #[test]
    fn callouts_equations_toggles_and_toc() {
        let body = "<nav class=\"block-color-gray table_of_contents\"><div class=\"table_of_contents-item table_of_contents-indent-0\"><a class=\"table_of_contents-link\" href=\"#abc\">Heading One</a></div><div class=\"table_of_contents-item table_of_contents-indent-1\"><a class=\"table_of_contents-link\" href=\"#def\">Sub [x]</a></div></nav>\
            <figure class=\"block-color-gray_background callout\"><div style=\"font-size:1.5em\"><span class=\"icon\">💡</span></div><div style=\"width:100%\"><p>Callout title</p><p>Callout body</p></div></figure>\
            <figure class=\"equation\"><div class=\"equation-container\"><span class=\"katex-display\"><span class=\"katex\"><span class=\"katex-mathml\"><math><semantics><annotation encoding=\"application/x-tex\">  f(\\theta)=e^{i\\theta}  </annotation></semantics></math></span></span></span></div></figure>\
            <p>Inline <span class=\"notion-text-equation-token\"><span class=\"katex\"><annotation encoding=\"application/x-tex\"> x^2 </annotation></span></span> math</p>\
            <ul class=\"toggle\"><li><details open=\"\"><summary style=\"font-weight:600;font-size:1.25em;line-height:1.3;margin:0\">A Toggle Heading 3</summary><p>hidden</p></details></li></ul>";
        let r = convert(&[(format!("Blocks {ID_ROW}.html"), page(ID_ROW, "Blocks", body, "").into_bytes())]);
        let t = r.text("Blocks.md");
        assert!(t.contains("[[#Heading One]]") && t.contains("[[#Sub [x] ]]"), "{t}");
        assert!(t.contains("> [!important] Callout title"), "{t}");
        assert!(t.contains("$$f(\\theta)=e^{i\\theta}$$"), "{t}");
        assert!(t.contains("Inline $x^2$ math"), "{t}");
        assert!(t.contains("### A Toggle Heading 3"), "{t}");
    }

    #[test]
    fn markdown_and_csv_export() {
        let db = "152bb52ee2b5804da922efa8c3194444";
        let row = "152bb52ee2b5811d92b1e629b25d0c0a";
        let home = "2a889dba369b48709ec62508d5020d93";
        let files = vec![
            (format!("Home {home}.md"), format!("# Home\n\nSee [Habit Tracker](Habit%20Tracker%20{db}.csv) and [the day](Habit%20Tracker%20{db}/@December%201,%202024%20{row}.md).\n\n![cat](Home%20{home}/cat.png)\n\n```\n[not](a%20link.md)\n```\n")),
            (format!("Habit Tracker {db}.csv"), "\u{feff}Date,Ran today\n\"@December 1, 2024 \",No\n".to_string()),
            (format!("Habit Tracker {db}_all.csv"), "\u{feff}Date,Ran today,Full date,Tags\n\"@December 1, 2024 \",No,\"December 4, 2024 8:45 AM\",\"a b, c\"\n\"@November 2, 2024\",Yes,,\n".to_string()),
            (format!("Habit Tracker {db}/@December 1, 2024 {row}.md"), "# @December 1, 2024\n\nFull date: December 4, 2024 8:45 AM\nRan today: No\nTags: a b, c\n\nBody text.".to_string()),
            (format!("Home {home}/cat.png"), "PNG".to_string()),
        ];
        let files: Vec<(String, Vec<u8>)> = files.into_iter().map(|(p, d)| (p, d.into_bytes())).collect();
        let r = convert(&files);
        let mut paths = r.paths();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "Habit Tracker/@December 1, 2024.md",
                "Habit Tracker/Habit Tracker.md",
                "Home/Home.md",
                "Home/cat.png",
            ]
        );
        let home_md = r.text("Home/Home.md");
        assert!(home_md.starts_with("See [[Habit Tracker]] and [[@December 1, 2024|the day]]."), "{home_md}");
        assert!(home_md.contains("![[cat.png]]"), "{home_md}");
        assert!(home_md.contains("[not](a%20link.md)"), "{home_md}");
        let row_md = r.text("Habit Tracker/@December 1, 2024.md");
        assert_eq!(row_md, "---\nFull date: 2024-12-04T08:45\nRan today: false\nTags:\n  - a-b\n  - c\n---\nBody text.\n");
        let db_md = r.text("Habit Tracker/Habit Tracker.md");
        assert!(db_md.starts_with("| Date | Ran today | Full date | Tags |\n| --- | --- | --- | --- |\n| [[@December 1, 2024]] | No |"), "{db_md}");
    }

    // Regressions found by the importer's real Markdown & CSV export.
    #[test]
    fn markdown_export_view_links_index_and_task_spacing() {
        let home = "2a889dba369b48709ec62508d5020d93";
        let tasks = "c86dcb5c74ae4e5399086dd0b8272e87";
        let files: Vec<(String, Vec<u8>)> = vec![
            (format!("Home {home}.md"), format!("# Home\n\n[My tasks](Home%20{home}/My%20tasks%20{tasks}.csv)\n\n[Untitled](Home%20{home}/Untitled%20ba969b930dec4f26b1d82ab1f6306d94.csv)\n\n- [x]  Call Mom\n- [ ]  \n")),
            (format!("Home {home}/My tasks {tasks}.md"), "# My tasks".to_string()),
            ("index.html".to_string(), "<html><body><ul id=\"id::00000000-0000-4000-8000-000000000000\"></ul></body></html>".to_string()),
        ]
        .into_iter()
        .map(|(p, d)| (p, d.into_bytes()))
        .collect();
        let r = convert(&files);
        assert!(r.file("index.html").is_none(), "{:?}", r.paths());
        assert_eq!(r.text("Home/Home.md"), "[[My tasks]]\n\nUntitled\n\n- [x] Call Mom\n- [ ]\n");
        assert_eq!(r.text("Home/My tasks.md"), "");
    }

    #[test]
    fn escape_hashtags_rules() {
        assert_eq!(
            escape_hashtags("#abc #123 #1a \\#done [[#Heading]] [x](#frag) $a#b$ `#c`\n# Heading\n## Sub #tag"),
            "\\#abc #123 \\#1a \\#done [[#Heading]] [x](#frag) $a#b$ `#c`\n# Heading\n## Sub \\#tag"
        );
        // Regression from the real export: the converter writes `#\_`.
        assert_eq!(escape_hashtags("- #\\_\n- #\\_123"), "- \\#\\_\n- \\#\\_123");
    }

    #[test]
    fn quoted_callout_marker_and_math_inside_quotes() {
        let body = "<blockquote><p>[!tip] Quote title</p><figure class=\"equation\"><annotation>a \\\\\nb</annotation></figure></blockquote>";
        let r = convert(&[(format!("Q {ID_ROW}.html"), page(ID_ROW, "Q", body, "").into_bytes())]);
        let t = r.text("Q.md");
        assert!(t.contains("> [!tip] Quote title"), "{t}");
        assert!(t.contains("> $$a \\\\\n> b$$"), "{t}");
    }
}
