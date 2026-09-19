//! Roam Research JSON exports.
//!
//! A port of obsidian-importer's Roam converter (`roam/convert.ts`,
//! `roam/graph.ts`, `roam/queries.ts`), with its defaults:
//!
//! - One note per page, named by the title with Roam's daily pages
//!   (`January 2nd, 2024`) renamed to the daily-note format (`YYYY-MM-DD` by
//!   default) and a `/` in a title making folders. Titles that sanitise to the
//!   same name get ` 1`, ` 2`; links use the name each page was actually given.
//! - Blocks are flattened into prose where they are not list-shaped
//!   (`deOutline`, see [`super::outline`]), or kept as `- ` bullets indented
//!   four spaces per level.
//! - `((uid))` block references become `![[Page#^uid]]` embeds (or links with
//!   `embedBlockReferences` off), and the referenced block gets a `^uid`
//!   anchor; aliases `[text](((uid)))` become `[[Page#^uid|text]]`; embeds
//!   `{{embed: ((uid))}}` and `{{embed: [[Page]]}}` become `![[…]]`.
//! - `{{[[TODO]]}}`/`{{TODO}}` → `[ ]`, `{{[[DONE]]}}` → `[x]`, `^^x^^` →
//!   `==x==`, `__x__` → `*x*`, `#[[tag]]` → `[[tag]]`, Roam-only components
//!   (POMO, word-count, slider, …) removed, tables become pipe tables, simple
//!   `{{query}}` blocks become Obsidian search code blocks.
//! - Top-level `Name:: value` attribute blocks become properties.
//!
//! Not done: downloading `firebasestorage` attachments (no network here — the
//! URLs are left in place and counted in a warning), and the `.base` file the
//! importer writes listing attribute columns.

use super::dates::{format_moment, parse_roam_daily_title};
use super::mdcode::{outside_code, outside_code_spans, outside_fences};
use super::outline::{anchor_lines, de_outline, with_continuation, OutlineNode};
use super::util::{sanitize_file_path, UniquePaths};
use super::yaml::{frontmatter, Yaml};
use super::{ImportResult, ImportedFile};
use regex_lite::{Captures, Regex};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RoamOptions {
    /// moment.js format for daily-note names.
    pub daily_note_format: String,
    /// Flatten outlines into prose (the importer's default).
    pub de_outline: bool,
    /// `((uid))` becomes `![[Page#^uid]]` rather than `[[Page#^uid]]`.
    pub embed_block_references: bool,
    /// Remove references to blocks that are not in the export.
    pub drop_unresolved_references: bool,
    /// Keep `Name:: value` blocks in the body instead of making properties.
    pub keep_attributes_in_outline: bool,
    /// Remove `{{query}}` blocks instead of converting them.
    pub drop_queries: bool,
    /// Turn bare `#tags` into `[[links]]`, as Roam treats them.
    pub tags_as_links: bool,
    /// Vault folder the graph is imported into. When set, links to pages whose
    /// names contain `/` use the full path, as the importer writes them.
    pub graph_folder: String,
}

impl Default for RoamOptions {
    fn default() -> Self {
        RoamOptions {
            daily_note_format: "YYYY-MM-DD".into(),
            de_outline: true,
            embed_block_references: true,
            drop_unresolved_references: false,
            keep_attributes_in_outline: false,
            drop_queries: false,
            tags_as_links: false,
            graph_folder: String::new(),
        }
    }
}

struct Block<'a> {
    string: &'a str,
    uid: Option<&'a str>,
    heading: u64,
    children: Vec<Block<'a>>,
}

fn blocks_of(v: &Value) -> Vec<Block<'_>> {
    v.get("children")
        .and_then(|c| c.as_array())
        .map(|a| {
            a.iter()
                .map(|b| Block {
                    string: b.get("string").and_then(|s| s.as_str()).unwrap_or(""),
                    uid: b.get("uid").and_then(|s| s.as_str()),
                    heading: b.get("heading").and_then(|h| h.as_u64()).unwrap_or(0),
                    children: blocks_of(b),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid regex"))
}

macro_rules! regex {
    ($pat:expr) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        re(&CELL, $pat)
    }};
}

pub fn convert(json: &str, opts: &RoamOptions) -> ImportResult {
    let mut result = ImportResult::default();
    let parsed: Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(e) => {
            result.warnings.push(format!("Not valid Roam JSON: {e}"));
            return result;
        }
    };
    let Some(pages) = parsed.as_array() else {
        result
            .warnings
            .push("Not a Roam JSON export: expected an array of pages".into());
        return result;
    };

    let graph = Graph::new(pages, opts);
    let mut firebase = 0;
    for page in pages {
        let title = page.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let Some(name) = graph.names.get(title) else {
            result.warnings.push(format!(
                "Skipped a page with an empty title (uid {})",
                page.get("uid").and_then(|u| u.as_str()).unwrap_or("?")
            ));
            continue;
        };
        let blocks = blocks_of(page);
        let markdown = graph.page_markdown(&blocks);
        firebase += markdown.matches("firebasestorage.googleapis.com").count();
        let ctime = page.get("create-time").and_then(|t| t.as_i64());
        let mtime = page.get("edit-time").and_then(|t| t.as_i64());
        result
            .files
            .push(ImportedFile::note(format!("{name}.md"), markdown).with_times(ctime, mtime));
    }
    if firebase > 0 {
        result.warnings.push(format!(
            "{firebase} Roam-hosted attachment link(s) were left as URLs; download them while the Roam graph is still available"
        ));
    }
    result
}

struct Graph<'o> {
    opts: &'o RoamOptions,
    names: HashMap<String, String>,
    /// uid → page name
    blocks: HashMap<String, String>,
    mentioned: HashSet<String>,
}

impl<'o> Graph<'o> {
    fn new(pages: &[Value], opts: &'o RoamOptions) -> Graph<'o> {
        let mut g = Graph {
            opts,
            names: HashMap::new(),
            blocks: HashMap::new(),
            mentioned: HashSet::new(),
        };
        let mut taken = UniquePaths::new();
        for page in pages {
            let title = page.get("title").and_then(|t| t.as_str()).unwrap_or("");
            if g.names.contains_key(title) {
                continue;
            }
            let wanted = sanitize_file_path(
                convert_date_string(&sanitize_keep_path(title), &opts.daily_note_format).trim(),
            );
            if wanted.is_empty() || title.trim().is_empty() {
                continue;
            }
            let free = available_name(&wanted, &mut taken);
            g.names.insert(title.to_string(), free);
        }
        for page in pages {
            let title = page.get("title").and_then(|t| t.as_str()).unwrap_or("");
            let Some(name) = g.names.get(title).cloned() else {
                continue;
            };
            for b in blocks_of(page) {
                g.index(&name, &b, false);
            }
        }
        g
    }

    fn index(&mut self, page: &str, b: &Block, inside_table: bool) {
        let marker = is_table_marker(b.string);
        if let Some(uid) = b.uid {
            if !inside_table && !marker {
                self.blocks.insert(uid.to_string(), page.to_string());
            }
        }
        for caps in regex!(r"\(\(\b(.*?)\b\)\)").captures_iter(b.string) {
            self.mentioned.insert(caps[1].to_string());
        }
        for c in &b.children {
            self.index(page, c, inside_table || marker);
        }
    }

    fn is_referenced(&self, uid: &str) -> bool {
        self.mentioned.contains(uid) && self.blocks.contains_key(uid)
    }

    fn link_to(&self, page: &str) -> String {
        if page.contains('/') && !self.opts.graph_folder.is_empty() {
            format!("{}/{page}", self.opts.graph_folder.trim_end_matches('/'))
        } else {
            page.to_string()
        }
    }

    fn resolve_block(&self, uid: &str) -> Option<String> {
        self.blocks
            .get(uid)
            .map(|page| format!("{}#^{uid}", self.link_to(page)))
    }

    fn page_markdown(&self, children: &[Block]) -> String {
        let mut attributes: Vec<(String, String)> = Vec::new();
        let mut skip: HashSet<*const Block> = HashSet::new();
        if !self.opts.keep_attributes_in_outline {
            for b in children {
                if !b.children.is_empty() {
                    continue;
                }
                let Some((name, value)) = attribute(b.string) else {
                    continue;
                };
                if b.uid.is_some_and(|u| self.is_referenced(u)) {
                    continue;
                }
                attributes.push((name, self.scrub(&value)));
                skip.insert(b as *const Block);
            }
        }
        let mut nodes = Vec::new();
        for b in children {
            if skip.contains(&(b as *const Block)) {
                continue;
            }
            nodes.extend(self.render(b));
        }
        let body = if self.opts.de_outline {
            de_outline(&nodes)
        } else {
            as_outline(&nodes, "").join("\n")
        };
        let props: Vec<(String, Yaml)> = attributes
            .into_iter()
            .map(|(k, v)| (k, Yaml::Str(v)))
            .collect();
        format!("{}{}", frontmatter(&props), body)
    }

    fn render(&self, b: &Block) -> Vec<OutlineNode> {
        if is_table_marker(b.string) {
            let table = self.table(b);
            return if table.is_empty() {
                Vec::new()
            } else {
                vec![OutlineNode {
                    text: Some(String::new()),
                    anchor: None,
                    verbatim: Some(table),
                    children: Vec::new(),
                }]
            };
        }
        let scrubbed = if b.string.is_empty() {
            None
        } else {
            Some(self.scrub(b.string))
        };
        let children: Vec<OutlineNode> = b.children.iter().flat_map(|c| self.render(c)).collect();
        let text = scrubbed.map(|s| {
            if b.heading > 0 {
                format!("{} {}", "#".repeat(b.heading.min(6) as usize), without_whole_bold(&s))
            } else {
                s
            }
        });
        if text.as_deref().is_some_and(|t| t.trim().is_empty()) {
            return children;
        }
        vec![OutlineNode {
            text,
            anchor: b
                .uid
                .filter(|u| self.is_referenced(u))
                .map(String::from),
            verbatim: None,
            children,
        }]
    }

    fn table(&self, marker: &Block) -> String {
        let mut rows: Vec<Vec<String>> = Vec::new();
        fn walk(g: &Graph, b: &Block, before: &[String], rows: &mut Vec<Vec<String>>) {
            let cell = g.scrub(b.string).replace('|', "\\|").replace('\n', "<br>");
            let mut cells = before.to_vec();
            cells.push(cell);
            if b.children.is_empty() {
                rows.push(cells);
                return;
            }
            let mut carried = cells.clone();
            for c in &b.children {
                walk(g, c, &carried, rows);
                carried = cells.iter().map(|_| String::new()).collect();
            }
        }
        for row in &marker.children {
            walk(self, row, &[], &mut rows);
        }
        if rows.is_empty() {
            return String::new();
        }
        let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        for r in rows.iter_mut() {
            r.resize(width, String::new());
        }
        let sep = vec!["---".to_string(); width];
        rows.insert(1, sep);
        let body: Vec<String> = rows.iter().map(|r| format!("| {} |", r.join(" | "))).collect();
        format!("\n{}\n", body.join("\n"))
    }

    fn scrub(&self, text: &str) -> String {
        let text = fences_on_their_own_lines(text);
        let text = outside_code(&text, |seg| self.scrub_outside_code(seg));
        if !text.contains("{{") {
            return text;
        }
        outside_code(&text, |seg| {
            regex!(r"(?i)\{\{\[{0,2}(video|audio|pdf|iframe)\]{0,2}:\s*(https?://[^\s{}]+)\s*\}\}")
                .replace_all(seg, |c: &Captures| {
                    let url = &c[2];
                    if c[1].eq_ignore_ascii_case("audio") {
                        format!("<audio controls src=\"{url}\"></audio>")
                    } else if regex!(r"(?i)\.(mp4|webm|ogv|mov|m4v)(\?|$)").is_match(url) {
                        format!("<video controls src=\"{url}\"></video>")
                    } else {
                        format!("<iframe src=\"{url}\"></iframe>")
                    }
                })
                .into_owned()
        })
    }

    fn scrub_outside_code(&self, block: &str) -> String {
        let mut s = regex!(r"(?i)\{\{\[\[(TODO|DONE|table|query|embed|embed-path|video|audio|pdf|iframe)\]\]")
            .replace_all(block, "{{$1")
            .into_owned();
        s = regex!(r"\{\{(\[\[)?(POMO|word-count|date|slider|encrypt|TaoOfRoam|orphans|count|character-count|comment-button|streak|attr-table|mentions|search|roam/render|roam/css|calc)(\]\])?.*?\}\}(\})?")
            .replace_all(&s, "")
            .into_owned();
        if s.starts_with(":hiccup ") && s.contains(":hr") {
            return "---".into();
        }
        s = s.replace("[[>]]", ">");
        s = regex!(r"#(\[\[.*?\]\])").replace_all(&s, "$1").into_owned();
        s = regex!(r"\s*(?:\[\[\.[^\]]*\]\]|#\.[^\s\[\]#]+)").replace_all(&s, "").into_owned();
        if self.opts.tags_as_links {
            s = bare_tags_to_links(&s);
        }
        s = regex!(r"(\{\{)?\[\[(.*?)\]\]")
            .replace_all(&s, |c: &Captures| {
                if c.get(1).is_some() {
                    return c[0].to_string();
                }
                let name = &c[2];
                let resolved = self.names.get(name).cloned().unwrap_or_else(|| {
                    convert_date_string(&sanitize_keep_path(name), &self.opts.daily_note_format)
                });
                format!("[[{resolved}]]")
            })
            .into_owned();
        if !self.opts.graph_folder.is_empty() {
            let folder = self.opts.graph_folder.trim_end_matches('/').to_string();
            s = regex!(r"(\{\{)?\[\[([^\[\]]*/[^\[\]]*)\]\]")
                .replace_all(&s, |c: &Captures| {
                    if c.get(1).is_some() {
                        c[0].to_string()
                    } else {
                        format!("[[{folder}/{}|{}]]", &c[2], &c[2])
                    }
                })
                .into_owned();
        }
        s = regex!(r"\[([^\[\]]+?)\]\(\[\[(.+?)\]\]\)").replace_all(&s, "[[$2|$1]]").into_owned();
        s = convert_queries(&s, self.opts.drop_queries);
        s = regex!(r"\{\{TODO\}\}|\{\{\[\[TODO\]\]\}\}").replace_all(&s, "[ ]").into_owned();
        s = regex!(r"\{\{DONE\}\}|\{\{\[\[DONE\]\]\}\}").replace_all(&s, "[x]").into_owned();
        s = regex!(r"\{\{.*?\bvideo\b.*?(\bhttp.*?\byoutu.*?)\}\}").replace_all(&s, "![]($1)").into_owned();
        s = regex!(r"(https?://twitter\.com/(?:#!/)?\w+/status/\d+(?:\?[\w=&-]+)?)")
            .replace_all(&s, "![]($1)")
            .into_owned();
        s = regex!(r"__(.+?)__").replace_all(&s, "*$1*").into_owned();
        s = regex!(r"\^\^(.+?)\^\^").replace_all(&s, "==$1==").into_owned();
        self.resolve_embeds_and_references(&s)
    }

    fn unresolved(&self, whole: &str) -> String {
        if self.opts.drop_unresolved_references {
            String::new()
        } else {
            whole.to_string()
        }
    }

    fn resolve_embeds_and_references(&self, text: &str) -> String {
        let mut s = regex!(r"\{\{\[{0,2}embed[^{}]*?(\[\[.*?\]\])[^{}]*?\}\}")
            .replace_all(text, "!$1")
            .into_owned();
        s = regex!(r"\{\{\[{0,2}embed[^{}]*?\(\((.*?)\)\)[^{}]*?\}\}")
            .replace_all(&s, |c: &Captures| match self.resolve_block(&c[1]) {
                Some(t) => format!("![[{t}]]"),
                None => self.unresolved(&c[0]),
            })
            .into_owned();
        s = regex!(r"\[([^\[\]]+?)\]\(\(\((.+?)\)\)\)")
            .replace_all(&s, |c: &Captures| match self.resolve_block(&c[2]) {
                Some(t) => format!("[[{t}|{}]]", &c[1]),
                None if !looks_like_block_id(&c[2]) => c[0].to_string(),
                None if self.opts.drop_unresolved_references => c[1].to_string(),
                None => c[0].to_string(),
            })
            .into_owned();
        regex!(r"\(\(\b(.*?)\b\)\)")
            .replace_all(&s, |c: &Captures| match self.resolve_block(&c[1]) {
                Some(t) if self.opts.embed_block_references => format!("![[{t}]]"),
                Some(t) => format!("[[{t}]]"),
                None if looks_like_block_id(&c[1]) => self.unresolved(&c[0]),
                None => c[0].to_string(),
            })
            .into_owned()
    }
}

const INDENT: &str = "    ";

fn as_outline(blocks: &[OutlineNode], indent: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for b in blocks {
        if let Some(v) = &b.verbatim {
            lines.push(v.clone());
            continue;
        }
        let Some(text) = &b.text else {
            if b.children.is_empty() {
                lines.push(String::new());
            } else {
                lines.extend(as_outline(&b.children, &format!("{indent}{INDENT}")));
            }
            continue;
        };
        let continuation = format!("{indent}  ");
        let split: Vec<&str> = text.split('\n').collect();
        let mut cont = with_continuation(&split, &continuation);
        cont[0] = format!("{indent}- {}", cont[0]);
        let written = anchor_lines(cont, b.anchor.as_deref(), &continuation);
        lines.push(written.join("\n"));
        lines.extend(as_outline(&b.children, &format!("{indent}{INDENT}")));
    }
    lines
}

/// Roam's balanced table markers, `{{table}}` and `{{[[table]]}}`.
fn is_table_marker(s: &str) -> bool {
    let t = s.trim().to_ascii_lowercase();
    t == "{{table}}" || t == "{{[[table]]}}"
}

/// Distinguishes a Roam uid from ordinary double-parenthesised text.
fn looks_like_block_id(s: &str) -> bool {
    s.len() == 9 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `Name:: value` on one line, name up to 80 characters without brackets.
fn attribute(s: &str) -> Option<(String, String)> {
    if s.contains('\n') {
        return None;
    }
    let (name, value) = s.split_once("::")?;
    if name.is_empty()
        || name.chars().count() > 80
        || name.contains(['[', ']', '{', '}', ':'])
        || name.trim().is_empty()
        || value.trim().is_empty()
    {
        return None;
    }
    Some((name.trim().to_string(), value.trim().to_string()))
}

fn without_whole_bold(text: &str) -> String {
    let t = text.trim();
    if t.len() > 4 && t.starts_with("**") && t.ends_with("**") && !t[2..t.len() - 2].contains("**") {
        t[2..t.len() - 2].to_string()
    } else {
        text.to_string()
    }
}

/// `sanitizeFileNameKeepPath`: like `sanitizeFileName` but `/` survives, and
/// only a single leading dot is removed.
pub fn sanitize_keep_path(name: &str) -> String {
    let mut s: String = name
        .chars()
        .filter(|c| !"?<>\\:*|\"".contains(*c))
        .filter(|c| {
            let v = *c as u32;
            !(v <= 0x1f || (0x80..=0x9f).contains(&v))
        })
        .collect();
    if !s.is_empty() && s.chars().all(|c| c == '.') {
        s.clear();
    }
    let keep = s.trim_end_matches(['.', ' ']).len();
    s.truncate(keep);
    s.retain(|c| c != '[' && c != ']');
    if let Some(stripped) = s.strip_prefix('.') {
        s = stripped.to_string();
    }
    s
}

/// Rename a Roam daily page title to the daily-note format.
pub fn convert_date_string(s: &str, format: &str) -> String {
    match parse_roam_daily_title(s) {
        Some((y, m, d)) => format_moment(y, m, d, format),
        None => s.to_string(),
    }
}

/// `availableFileName` over names that may contain folders.
fn available_name(wanted: &str, taken: &mut UniquePaths) -> String {
    let (dir, file) = match wanted.rfind('/') {
        Some(i) => (&wanted[..i], &wanted[i + 1..]),
        None => ("", wanted),
    };
    // Claim with a sentinel extension so a dot in the title is not split.
    let claimed = taken.claim(dir, &format!("{file}.md"));
    claimed.strip_suffix(".md").unwrap_or(&claimed).to_string()
}

fn bare_tags_to_links(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let boundary = i == 0 || chars[i - 1].is_whitespace();
        if chars[i] == '#' && boundary {
            let mut j = i + 1;
            while j < chars.len()
                && !chars[j].is_whitespace()
                && !super::util::is_illegal_tag_char(chars[j])
            {
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

fn fences_on_their_own_lines(text: &str) -> String {
    if !text.contains("```") {
        return text.to_string();
    }
    let opens = regex!(r"^\s*```");
    let one_line = regex!(r"^\s*```.*\S```\s*$");
    let glued = regex!(r"^(.*\S)\s*```\s*$");
    let closes = regex!(r"^\s*```\s*$");
    let mut written: Vec<String> = Vec::new();
    let mut open = false;
    for line in text.split('\n') {
        if !open {
            written.push(line.to_string());
            if opens.is_match(line) && !one_line.is_match(line) {
                open = true;
            }
            continue;
        }
        if let Some(c) = glued.captures(line) {
            written.push(c[1].to_string());
            written.push("```".into());
            open = false;
            continue;
        }
        written.push(line.to_string());
        if closes.is_match(line) {
            open = false;
        }
    }
    written.join("\n")
}

// --- queries --------------------------------------------------------------

fn convert_queries(block: &str, drop: bool) -> String {
    outside_code_spans(block, |seg| rewrite_queries(seg, drop))
}

fn rewrite_queries(text: &str, drop: bool) -> String {
    let start_re = regex!(r"(?i)\{\{(?:\[\[query\]\]|query)\s*:");
    let mut result = String::new();
    let mut rest = text.to_string();
    loop {
        let Some(m) = start_re.find(&rest) else {
            result.push_str(&rest);
            return result;
        };
        let opens = m.start();
        let Some(closes) = matching_brace(&rest, opens) else {
            result.push_str(&rest);
            return result;
        };
        let whole = &rest[opens..=closes];
        let named = &whole[2..whole.len() - 2];
        let clause = &named[named.find(':').map(|i| i + 1).unwrap_or(0)..];
        let search = if drop { None } else { translate_group(clause.trim()) };
        let written = match search {
            Some(s) => format!("```query\nblock:({s})\n```"),
            None if drop => String::new(),
            None => whole.to_string(),
        };
        result.push_str(&rest[..opens]);
        result.push_str(&written);
        rest = rest[closes + 1..].to_string();
    }
}

fn translate_group(group: &str) -> Option<String> {
    let g = group.trim();
    let inner = g.strip_prefix('{')?.strip_suffix('}')?.trim_start();
    let colon = inner.find(':')?;
    let op = inner[..colon].trim().to_ascii_lowercase();
    if !matches!(op.as_str(), "and" | "or" | "not") {
        return None;
    }
    let terms = split_terms(&inner[colon + 1..])?;
    if terms.is_empty() {
        return None;
    }
    let mut translated = Vec::new();
    for t in terms {
        if t.starts_with('{') {
            translated.push(format!("({})", translate_group(&t)?));
        } else {
            translated.push(t);
        }
    }
    Some(match op.as_str() {
        "and" => translated.join(" "),
        "or" => translated.join(" OR "),
        _ => translated
            .iter()
            .map(|t| format!("-{t}"))
            .collect::<Vec<_>>()
            .join(" "),
    })
}

fn split_terms(body: &str) -> Option<Vec<String>> {
    let mut terms = Vec::new();
    let b = body.as_bytes();
    let mut at = 0;
    while at < b.len() {
        let c = b[at];
        if c.is_ascii_whitespace() {
            at += 1;
            continue;
        }
        if c == b'{' {
            let closes = matching_brace(body, at)?;
            terms.push(body[at..=closes].to_string());
            at = closes + 1;
            continue;
        }
        let pair = if body[at..].starts_with("[[") {
            Some("]]")
        } else if body[at..].starts_with("((") {
            Some("))")
        } else {
            None
        };
        if let Some(p) = pair {
            let closes = body[at..].find(p)? + at;
            terms.push(body[at..closes + 2].to_string());
            at = closes + 2;
            continue;
        }
        if c == b'#' {
            let len = body[at..]
                .find(|ch: char| ch.is_whitespace() || "{}[]()".contains(ch))
                .unwrap_or(body.len() - at);
            if len > 1 {
                terms.push(body[at..at + len].to_string());
                at += len;
                continue;
            }
        }
        return None;
    }
    Some(terms)
}

fn matching_brace(text: &str, from: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (i, c) in text[from..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(from + i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Unused outside tests, but kept beside the converter it mirrors.
#[allow(dead_code)]
fn fenced_lines_untouched(text: &str) -> String {
    outside_fences(text, |s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHAPES: &str = r##"[
      {"title": "Sapiens", "uid": "page-sapiens", "create-time": 1600000000000, "edit-time": 1600000100000, "children": [
        {"string": "Author:: [[Yuval Noah Harari]]", "uid": "attr-author"},
        {"string": "Status:: read", "uid": "attr-status"},
        {"string": "Rating:: 8/10", "uid": "attr-rating"},
        {"string": "Reading notes", "uid": "notes-head", "children": [
          {"string": "Priority:: high", "uid": "attr-nested"},
          {"string": "The cognitive revolution is the turning point", "uid": "blk-cognitive"},
          {"string": "A shared fiction is what lets strangers cooperate", "uid": "blk-fiction"}]},
        {"string": "Themes::", "uid": "attr-with-children", "children": [{"string": "#history", "uid": "blk-history"}]}]},
      {"title": "References", "uid": "page-references", "children": [
        {"string": "A reference to a block on another page: ((blk-cognitive))", "uid": "ref-plain"},
        {"string": "An aliased reference: [the turning point](((blk-cognitive)))", "uid": "ref-alias"},
        {"string": "{{[[TODO]]}} a task with a reference [->](((blk-fiction)))", "uid": "ref-todo"},
        {"string": "A long ((and considered)) aside, which is nobody's block id", "uid": "ref-paren"},
        {"string": "A reference to a block that is not in this graph: ((nosuchblk))", "uid": "ref-missing"}]},
      {"title": "January 1st, 2021", "uid": "01-01-2021", "children": [
        {"string": "It links to [[January 2nd, 2021]] and to [[Sapiens]] and [[roam/css]]", "uid": "dnp"}]},
      {"title": "roam/css", "uid": "page-css", "children": [{"string": "A page in a folder", "uid": "css1"}]},
      {"title": "Colliding [name]", "uid": "c1", "children": [{"string": "first"}]},
      {"title": "Colliding name", "uid": "c2", "children": [{"string": "second"}]}
    ]"##;

    #[test]
    fn attributes_become_properties_and_referenced_blocks_get_anchors() {
        let r = convert(SHAPES, &RoamOptions::default());
        assert_eq!(
            r.text("Sapiens.md"),
            "---\nAuthor: \"[[Yuval Noah Harari]]\"\nStatus: read\nRating: 8/10\n---\nReading notes\n\n- Priority:: high\n- The cognitive revolution is the turning point ^blk-cognitive\n- A shared fiction is what lets strangers cooperate ^blk-fiction\n\nThemes::\n\n#history"
        );
        let f = r.file("Sapiens.md").unwrap();
        assert_eq!((f.ctime_ms, f.mtime_ms), (Some(1_600_000_000_000), Some(1_600_000_100_000)));
    }

    #[test]
    fn block_references_aliases_todos_and_unresolved() {
        let r = convert(SHAPES, &RoamOptions::default());
        assert_eq!(
            r.text("References.md"),
            "A reference to a block on another page: ![[Sapiens#^blk-cognitive]]\n\nAn aliased reference: [[Sapiens#^blk-cognitive|the turning point]]\n\n- [ ] a task with a reference [[Sapiens#^blk-fiction|->]]\n\nA long ((and considered)) aside, which is nobody's block id\n\nA reference to a block that is not in this graph: ((nosuchblk))"
        );
        let linked = convert(SHAPES, &RoamOptions { embed_block_references: false, drop_unresolved_references: true, ..RoamOptions::default() });
        let t = linked.text("References.md");
        assert!(t.contains("page: [[Sapiens#^blk-cognitive]]"), "{t}");
        assert!(t.ends_with("not in this graph:"), "{t}");
    }

    #[test]
    fn daily_notes_folders_and_collisions() {
        let r = convert(SHAPES, &RoamOptions::default());
        assert!(r.paths().contains(&"2021-01-01.md"));
        assert!(r.paths().contains(&"roam/css.md"));
        assert_eq!(r.text("2021-01-01.md"), "It links to [[2021-01-02]] and to [[Sapiens]] and [[roam/css]]");
        assert!(r.paths().contains(&"Colliding name.md") && r.paths().contains(&"Colliding name 1.md"), "{:?}", r.paths());
        let custom = convert(SHAPES, &RoamOptions { daily_note_format: "dddd, MMMM Do YYYY".into(), graph_folder: "Roam/graph".into(), ..RoamOptions::default() });
        let t = custom.text("Friday, January 1st 2021.md");
        assert!(t.contains("[[Saturday, January 2nd 2021]]") && t.contains("[[Roam/graph/roam/css|roam/css]]"), "{t}");
    }

    #[test]
    fn outline_mode_keeps_bullets() {
        let json = r#"[{"title": "P", "children": [
            {"string": "top", "uid": "aaaaaaaaa", "children": [{"string": "child ^^hi^^ __it__", "children": [{"string": "grandchild"}]}]},
            {"string": "{{[[DONE]]}} finished"},
            {"string": "ref ((aaaaaaaaa))"}]}]"#;
        let r = convert(json, &RoamOptions { de_outline: false, ..RoamOptions::default() });
        assert_eq!(
            r.text("P.md"),
            "- top ^aaaaaaaaa\n    - child ==hi== *it*\n        - grandchild\n- [x] finished\n- ref ![[P#^aaaaaaaaa]]"
        );
    }

    #[test]
    fn tables_queries_headings_and_code_immunity() {
        let json = r#"[{"title": "T", "children": [
            {"string": "{{[[table]]}}", "children": [
                {"string": "Name", "children": [{"string": "Colour"}]},
                {"string": "Apple", "children": [{"string": "Red | ^^ripe^^"}]}]},
            {"string": "{{[[query]]: {and: [[A]] {or: [[B]] #c}}}}"},
            {"string": "**Big heading**", "heading": 2},
            {"string": "`^^code^^` and __it__\n```\n__not italic__\n```"},
            {"string": "{{[[POMO]]}}"},
            {"string": "{{[[video]]: https://example.com/clip.mp4}}"}]}]"#;
        let r = convert(json, &RoamOptions::default());
        let t = r.text("T.md");
        assert!(t.contains("| Name | Colour |\n| --- | --- |\n| Apple | Red \\| ==ripe== |"), "{t}");
        assert!(t.contains("```query\nblock:([[A]] ([[B]] OR #c))\n```"), "{t}");
        assert!(t.contains("## Big heading"), "{t}");
        assert!(t.contains("`^^code^^` and *it*\n```\n__not italic__\n```"), "{t}");
        assert!(!t.contains("POMO"), "{t}");
        assert!(t.contains("<video controls src=\"https://example.com/clip.mp4\"></video>"), "{t}");
    }

    #[test]
    fn invalid_json_is_a_warning() {
        let r = convert("{not json", &RoamOptions::default());
        assert!(r.files.is_empty() && r.warnings.len() == 1);
    }
}
