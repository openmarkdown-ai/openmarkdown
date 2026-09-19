//! Logseq Markdown graphs.
//!
//! A port of obsidian-importer's Logseq importer (`logseq.ts` and
//! `logseq/*.ts`). Input is the graph folder's files, paths relative to the
//! graph root (a zip of the folder, or a leading folder name, also works).
//!
//! - `pages/` become notes, namespaces (`a___b.md`, or `a.b.md` / `a%2Fb.md`
//!   in the legacy file-name format) become folders; `journals/` become
//!   `Journals/<date>.md` named in the daily-note format.
//! - Page properties (`key:: value` lines at the top) become frontmatter:
//!   `alias`/`title` → `aliases`, `tags` → a list, values with links or
//!   commas-as-configured → lists, Logseq-internal properties dropped.
//! - `TODO`/`LATER`/`WAITING` → `- [ ]`, `DOING`/`NOW` → `- [/]`, `DONE` →
//!   `- [x]`, `CANCELLED` → `- [-]`, with priority, `SCHEDULED`/`DEADLINE`
//!   (and repeaters), created and completed dates kept as text after an em
//!   dash; `:LOGBOOK:` drawers dropped unless time tracking is kept.
//! - `id:: uuid` block properties become `^abcdef` anchors on their block and
//!   `((uuid))` becomes `[[page#^abcdef]]`; `{{embed ((uuid))}}` and
//!   `{{embed [[page]]}}` become embeds.
//! - Links follow renamed pages and aliases, `[Jun 15th, 2024]]`-style date
//!   links become ISO dates, `#[[multi word]]` → `#multi-word`, `^^x^^` →
//!   `==x==`, org blocks become callouts, quotes, comments or fences,
//!   `{{query}}` becomes a `query` code block, numbered-list properties become
//!   `1.` items, `{{video}}`/`{{youtube}}`/`{{tweet}}` become embeds, and
//!   `../assets/` links become `![[file]]` (with `{:width :height}` sizes)
//!   pointing at copies in the attachment folder.
//!
//! Link targets are written as paths from the import root (optionally
//! prefixed with `vaultFolder`), as the importer writes vault paths.
//! Differences: whiteboards are skipped with a warning (as the importer does),
//! and `flattenOutlines` uses the shared outline flattener rather than the
//! importer's Logseq-specific one, so its prose/list choices can differ.

use super::dates::{self, format_moment, valid_date, MONTHS, WEEKDAYS};
use super::mdcode::{fence_lines, outside_code, outside_code_spans, outside_fences};
use super::outline::{de_outline, OutlineNode};
use super::util::{
    basename, extension_lower, join, parent, percent_decode, resolve_path, sanitize_file_name,
    sanitize_file_path, sanitize_tag, split_ext, UniquePaths,
};
use super::{ImportResult, ImportedFile};
use regex_lite::{Captures, Regex};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

macro_rules! regex {
    ($pat:expr) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        CELL.get_or_init(|| Regex::new($pat).expect("valid regex"))
    }};
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LogseqOptions {
    /// moment.js format for journal note names.
    pub daily_note_format: String,
    /// Folder for journal notes.
    pub journals_folder: String,
    pub flatten_outlines: bool,
    /// Keep queries (as `query` code blocks); off removes them.
    pub queries: bool,
    /// Keep flashcard markup (`#card`, `{{cloze}}`); off strips it.
    pub flashcards: bool,
    /// Keep `:LOGBOOK:` clock drawers.
    pub time_tracking: bool,
    pub attachment_folder: String,
    /// Vault folder the graph is imported into, prefixed to link targets.
    pub vault_folder: String,
}

impl Default for LogseqOptions {
    fn default() -> Self {
        LogseqOptions {
            daily_note_format: "YYYY-MM-DD".into(),
            journals_folder: "Journals".into(),
            flatten_outlines: false,
            queries: true,
            flashcards: true,
            time_tracking: false,
            attachment_folder: "attachments".into(),
            vault_folder: String::new(),
        }
    }
}

// --- config.edn --------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct GraphConfig {
    pub pages_directory: String,
    pub journals_directory: String,
    pub whiteboards_directory: String,
    pub triple_lowbar: bool,
    pub journal_file_name_format: Option<String>,
    pub journal_page_title_format: Option<String>,
    pub comma_separated_properties: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum EdnKind {
    Atom,
    Str,
    Open,
    Close,
}

struct EdnToken {
    kind: EdnKind,
    value: String,
    depth: usize,
}

fn edn_tokens(input: &str) -> Vec<EdnToken> {
    let chars: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut depth = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() || c == ',' {
            i += 1;
        } else if c == ';' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '"' {
            let mut v = String::new();
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                    v.push(match chars[i] {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        other => other,
                    });
                } else {
                    v.push(chars[i]);
                }
                i += 1;
            }
            i += 1;
            tokens.push(EdnToken { kind: EdnKind::Str, value: v, depth });
        } else if "{[(".contains(c) {
            tokens.push(EdnToken { kind: EdnKind::Open, value: c.to_string(), depth });
            depth += 1;
            i += 1;
        } else if "}])".contains(c) {
            depth = depth.saturating_sub(1);
            tokens.push(EdnToken { kind: EdnKind::Close, value: c.to_string(), depth });
            i += 1;
        } else {
            let start = i;
            while i < chars.len() && !(chars[i].is_whitespace() || ",;{}[]()\"".contains(chars[i])) {
                i += 1;
            }
            tokens.push(EdnToken {
                kind: EdnKind::Atom,
                value: chars[start..i].iter().collect(),
                depth,
            });
        }
    }
    tokens
}

pub fn parse_config(content: &str) -> GraphConfig {
    let tokens = edn_tokens(content);
    let top = |key: &str| {
        tokens
            .iter()
            .position(|t| t.depth == 1 && t.kind == EdnKind::Atom && t.value == format!(":{key}"))
            .filter(|i| i + 1 < tokens.len())
            .map(|i| i + 1)
    };
    let scalar = |key: &str| -> Option<String> {
        let t = &tokens[top(key)?];
        match t.kind {
            EdnKind::Str => Some(t.value.clone()),
            EdnKind::Atom => Some(t.value.trim_start_matches(':').to_string()),
            _ => None,
        }
    };
    let collection = |key: &str| -> Vec<String> {
        let Some(mut i) = top(key) else {
            return Vec::new();
        };
        if tokens[i].kind == EdnKind::Atom && tokens[i].value == "#" && tokens.get(i + 1).is_some_and(|t| t.value == "{") {
            i += 1;
        }
        if tokens[i].kind != EdnKind::Open || !"[{".contains(tokens[i].value.as_str()) {
            return Vec::new();
        }
        let d = tokens[i].depth;
        let mut out = Vec::new();
        for t in &tokens[i + 1..] {
            if t.kind == EdnKind::Close && t.depth == d {
                break;
            }
            if t.depth != d + 1 {
                continue;
            }
            match t.kind {
                EdnKind::Str => out.push(t.value.clone()),
                EdnKind::Atom if t.value.starts_with(':') => out.push(t.value[1..].to_string()),
                _ => {}
            }
        }
        out
    };
    let directory = |v: Option<String>, fallback: &str| -> String {
        let Some(v) = v else {
            return fallback.to_string();
        };
        let parts: Vec<&str> = v.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".").collect();
        if parts.is_empty() || parts.contains(&"..") {
            fallback.to_string()
        } else {
            parts.join("/")
        }
    };
    GraphConfig {
        pages_directory: directory(scalar("pages-directory"), "pages"),
        journals_directory: directory(scalar("journals-directory"), "journals"),
        whiteboards_directory: directory(scalar("whiteboards-directory"), "whiteboards"),
        triple_lowbar: scalar("file/name-format").as_deref() == Some("triple-lowbar"),
        journal_file_name_format: scalar("journal/file-name-format"),
        journal_page_title_format: scalar("journal/page-title-format"),
        comma_separated_properties: collection("property/separated-by-commas")
            .into_iter()
            .map(|p| p.to_lowercase())
            .collect(),
    }
}

impl Default for GraphConfig {
    /// A graph without `config.edn` uses the triple-lowbar file names.
    fn default() -> Self {
        GraphConfig {
            triple_lowbar: true,
            ..parse_config("")
        }
    }
}

// --- dates -----------------------------------------------------------------------

/// A Logseq (date-fns) date format as moment tokens.
pub fn date_fns_to_moment(format: &str) -> String {
    const TOKENS: &[(&str, &str)] = &[
        ("yyyy", "YYYY"), ("EEEE", "dddd"), ("LLLL", "MMMM"), ("MMMM", "MMMM"),
        ("yyy", "YYYY"), ("EEE", "ddd"), ("LLL", "MMM"), ("MMM", "MMM"),
        ("yy", "YY"), ("EE", "ddd"), ("LL", "MM"), ("MM", "MM"), ("do", "Do"), ("dd", "DD"),
        ("y", "YYYY"), ("E", "ddd"), ("L", "M"), ("M", "M"), ("d", "D"),
    ];
    let chars: Vec<char> = format.chars().collect();
    let mut result = String::new();
    let mut literal = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\'' {
            if chars.get(i + 1) == Some(&'\'') {
                literal.push('\'');
                i += 2;
                continue;
            }
            match chars[i + 1..].iter().position(|c| *c == '\'') {
                Some(end) => {
                    literal.extend(&chars[i + 1..i + 1 + end]);
                    i += end + 2;
                }
                None => {
                    literal.extend(&chars[i + 1..]);
                    break;
                }
            }
            continue;
        }
        if !literal.is_empty() {
            result.push_str(&format!("[{}]", literal.replace(']', "\\]")));
            literal.clear();
        }
        let rest: String = chars[i..].iter().collect();
        if let Some((tok, m)) = TOKENS.iter().find(|(t, _)| rest.starts_with(t)) {
            result.push_str(m);
            i += tok.chars().count();
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    if !literal.is_empty() {
        result.push_str(&format!("[{}]", literal.replace(']', "\\]")));
    }
    result
}

/// Strictly parse `s` with moment tokens (`YYYY YY MMMM MMM MM M DD D Do dddd
/// ddd`), returning a civil date.
pub fn parse_moment(s: &str, format: &str) -> Option<(i64, u32, u32)> {
    let fchars: Vec<char> = format.chars().collect();
    let mut pos = 0usize;
    let (mut y, mut m, mut d) = (None, None, None);
    let mut i = 0;
    let take_digits = |pos: &mut usize, min: usize, max: usize| -> Option<u32> {
        let digits: String = s[*pos..].chars().take(max).take_while(|c| c.is_ascii_digit()).collect();
        if digits.len() < min {
            return None;
        }
        *pos += digits.len();
        digits.parse().ok()
    };
    while i < fchars.len() {
        let rest: String = fchars[i..].iter().collect();
        if fchars[i] == '[' {
            let end = fchars[i + 1..].iter().position(|c| *c == ']')?;
            let lit: String = fchars[i + 1..i + 1 + end].iter().collect();
            if !s[pos..].starts_with(&lit) {
                return None;
            }
            pos += lit.len();
            i += end + 2;
            continue;
        }
        let names = |list: &[&str], short: bool| -> Option<(usize, usize)> {
            list.iter().enumerate().find_map(|(k, n)| {
                let cand = if short { &n[..3] } else { *n };
                s[pos..].starts_with(cand).then_some((k, cand.len()))
            })
        };
        if rest.starts_with("YYYY") {
            y = Some(take_digits(&mut pos, 4, 4)? as i64);
            i += 4;
        } else if rest.starts_with("YY") {
            y = Some(2000 + take_digits(&mut pos, 2, 2)? as i64);
            i += 2;
        } else if rest.starts_with("MMMM") {
            let (k, len) = names(&MONTHS, false)?;
            m = Some(k as u32 + 1);
            pos += len;
            i += 4;
        } else if rest.starts_with("MMM") {
            let (k, len) = names(&MONTHS, true)?;
            m = Some(k as u32 + 1);
            pos += len;
            i += 3;
        } else if rest.starts_with("MM") {
            m = Some(take_digits(&mut pos, 2, 2)?);
            i += 2;
        } else if rest.starts_with('M') {
            m = Some(take_digits(&mut pos, 1, 2)?);
            i += 1;
        } else if rest.starts_with("DD") {
            d = Some(take_digits(&mut pos, 2, 2)?);
            i += 2;
        } else if rest.starts_with("Do") {
            let n = take_digits(&mut pos, 1, 2)?;
            let suffix = dates::ordinal_suffix(n);
            if !s[pos..].starts_with(suffix) {
                return None;
            }
            pos += 2;
            d = Some(n);
            i += 2;
        } else if rest.starts_with('D') {
            d = Some(take_digits(&mut pos, 1, 2)?);
            i += 1;
        } else if rest.starts_with("dddd") {
            let (_, len) = names(&WEEKDAYS, false)?;
            pos += len;
            i += 4;
        } else if rest.starts_with("ddd") {
            let (_, len) = names(&WEEKDAYS, true)?;
            pos += len;
            i += 3;
        } else {
            if !s[pos..].starts_with(fchars[i]) {
                return None;
            }
            pos += fchars[i].len_utf8();
            i += 1;
        }
    }
    if pos != s.len() {
        return None;
    }
    let (y, m, d) = (y?, m?, d?);
    valid_date(y, m, d).then_some((y, m, d))
}

fn journal_file_to_iso(stem: &str, format: Option<&str>) -> Option<String> {
    if let Some(f) = format {
        if let Some((y, m, d)) = parse_moment(stem, &date_fns_to_moment(f)) {
            return Some(dates::iso_date(y, m, d));
        }
    }
    let parts: Vec<&str> = stem.split(['_', '-']).collect();
    if parts.len() != 3 || parts[0].len() != 4 || !parts.iter().all(|p| !p.is_empty() && p.len() <= 4 && p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let (y, m, d) = (parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?);
    if parts[1].len() > 2 || parts[2].len() > 2 || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(dates::iso_date(y, m, d))
}

fn month_number(name: &str) -> Option<u32> {
    let l = name.to_ascii_lowercase();
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        .iter()
        .position(|m| l.starts_with(m))
        .map(|i| i as u32 + 1)
}

/// `Jun 15th, 2024` (any month spelling starting with its abbreviation).
fn logseq_date_to_iso(text: &str) -> Option<String> {
    let c = regex!(r"(?i)^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$")
        .captures(text.trim())?;
    let m = month_number(&c[1])?;
    let d: u32 = c[2].parse().ok()?;
    let y: i64 = c[3].parse().ok()?;
    ((1..=31).contains(&d)).then(|| dates::iso_date(y, m, d))
}

fn convert_journal_date_links(content: &str) -> String {
    outside_code(content, |seg| {
        regex!(r"\[\[((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\]\]")
            .replace_all(seg, |c: &Captures| {
                match (month_number(&c[1]), c[2].parse::<u32>()) {
                    (Some(m), Ok(d)) if (1..=31).contains(&d) => format!("[[{}-{:02}-{:02}]]", &c[3], m, d),
                    _ => c[0].to_string(),
                }
            })
            .into_owned()
    })
}

// --- page properties -------------------------------------------------------------

const ALWAYS_DROP_BLOCK_PROPS: &[&str] = &[
    "alias", "aliases", "collapsed", "background-color", "heading", "query-table",
    "query-properties", "query-sort-by", "query-sort-desc", "query-flag", "filters", "public",
    "exclude-from-graph-view", "template", "template-including-parent",
];
const ALWAYS_DROP_PAGE_PROPS: &[&str] = &[
    "collapsed", "filters", "background-color", "heading", "public", "exclude-from-graph-view",
    "icon", "template", "template-including-parent",
];

fn dropped_by_prefix(key: &str) -> bool {
    key.starts_with("hl-") || key.starts_with("ls-") || key.starts_with("logseq.") || key.starts_with("query-")
}

fn property_line(line: &str) -> Option<(&str, &str)> {
    let (key, rest) = line.split_once("::")?;
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-') {
        return None;
    }
    Some((key, rest.strip_prefix(' ').unwrap_or(rest)))
}

pub fn split_list(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut items = Vec::new();
    let mut current = String::new();
    let mut depth = 0;
    for i in 0..chars.len() {
        let c = chars[i];
        if c == '[' && chars.get(i + 1) == Some(&'[') {
            depth += 1;
            current.push(c);
        } else if c == ']' && i > 0 && chars[i - 1] == ']' && depth > 0 {
            depth -= 1;
            current.push(c);
        } else if c == ',' && depth == 0 {
            if !current.trim().is_empty() {
                items.push(current.trim().to_string());
            }
            current.clear();
        } else {
            current.push(c);
        }
    }
    if !current.trim().is_empty() {
        items.push(current.trim().to_string());
    }
    items
}

fn quote(v: &str) -> String {
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

fn needs_quoting(v: &str) -> bool {
    let Some(first) = v.chars().next() else {
        return false;
    };
    if "#[{>|*&!@`\"'".contains(first) {
        return true;
    }
    if v == "-" || v.starts_with("- ") || v.starts_with("-\t") {
        return true;
    }
    if v.ends_with(':') || v.contains(": ") || regex!(r"\s#").is_match(v) {
        return true;
    }
    if regex!(r"(?i)^(yes|no|true|false|on|off)$").is_match(v) {
        return true;
    }
    regex!(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^0[xXoObB]").is_match(v) || regex!(r"^0\d").is_match(v)
}

fn yaml_list_item(v: &str) -> String {
    format!("  - {}", if needs_quoting(v) { quote(v) } else { v.to_string() })
}

fn strip_wiki(v: &str) -> String {
    v.strip_prefix("[[")
        .and_then(|x| x.strip_suffix("]]"))
        .unwrap_or(v)
        .to_string()
}

fn tags_from_item(item: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let rest = regex!(r"\[\[([^\]]+)\]\]").replace_all(item, |c: &Captures| {
        tokens.push(c[1].trim().to_string());
        " ".to_string()
    });
    for part in rest.split_whitespace() {
        let t = part.trim_start_matches('#').trim();
        if !t.is_empty() {
            tokens.push(t.to_string());
        }
    }
    tokens
}

struct PageProperties {
    yaml: String,
    body: String,
    raw: HashMap<String, String>,
}

fn extract_page_properties(content: &str, drop_tags: &[&str], comma: &HashSet<String>) -> PageProperties {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut raw = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut emitted: HashMap<String, Vec<String>> = HashMap::new();
    let mut aliases: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].strip_suffix('\r').unwrap_or(lines[i]);
        let Some((key, value)) = property_line(line) else {
            break;
        };
        let value = value.trim();
        raw.insert(key.to_string(), value.to_string());
        i += 1;
        if key == "title" {
            continue;
        }
        let out = emit_property(key, value, &mut aliases, drop_tags, comma);
        if !out.is_empty() {
            if !emitted.contains_key(key) {
                order.push(key.to_string());
            }
            emitted.insert(key.to_string(), out);
        }
    }
    if let Some(t) = raw.get("title") {
        let t = strip_wiki(t).trim().to_string();
        if !t.is_empty() {
            aliases.push(t);
        }
    }
    while i < lines.len() && lines[i].trim().is_empty() {
        i += 1;
    }
    let body = lines[i..].join("\n");
    let mut yaml = String::new();
    if !order.is_empty() || !aliases.is_empty() {
        let mut out = vec!["---".to_string()];
        if !aliases.is_empty() {
            out.push("aliases:".into());
            out.extend(aliases.iter().map(|a| yaml_list_item(a)));
        }
        for k in &order {
            out.extend(emitted[k].iter().cloned());
        }
        out.push("---".into());
        yaml = out.join("\n");
    }
    PageProperties { yaml, body, raw }
}

fn emit_property(key: &str, value: &str, aliases: &mut Vec<String>, drop_tags: &[&str], comma: &HashSet<String>) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    if key == "alias" || key == "aliases" {
        aliases.extend(split_list(value).iter().map(|v| strip_wiki(v)));
        return Vec::new();
    }
    if key == "tags" {
        let items: Vec<String> = split_list(value)
            .iter()
            .flat_map(|i| tags_from_item(i))
            .filter(|t| !drop_tags.contains(&t.as_str()))
            .collect();
        if items.is_empty() {
            return Vec::new();
        }
        let mut out = vec!["tags:".to_string()];
        out.extend(items.iter().map(|t| yaml_list_item(t)));
        return out;
    }
    if dropped_by_prefix(key) || ALWAYS_DROP_PAGE_PROPS.contains(&key) {
        return Vec::new();
    }
    if (key == "created" || key == "updated") && value.contains("[[") {
        let clean = value.trim_start_matches("[[").trim_end_matches("]]").trim();
        if regex!(r"^\d{4}-\d{2}-\d{2}$").is_match(clean) {
            return vec![format!("{key}: {clean}")];
        }
    }
    let parts = split_list(value);
    let has_wiki = value.contains("[[");
    if (has_wiki || comma.contains(&key.to_lowercase())) && parts.len() > 1 {
        let mut out = vec![format!("{key}:")];
        out.extend(parts.iter().map(|p| yaml_list_item(p)));
        return out;
    }
    if has_wiki || needs_quoting(value) {
        return vec![format!("{key}: {}", quote(value))];
    }
    vec![format!("{key}: {value}")]
}

fn convert_heading_property(content: &str) -> String {
    outside_fences(content, |seg| {
        let mut out: Vec<String> = Vec::new();
        let mut last_bullet: Option<usize> = None;
        for line in seg.split('\n') {
            if let Some(c) = regex!(r"^\s*heading:: ?(.*)$").captures(line) {
                if let (Ok(level), Some(b)) = (c[1].trim().parse::<usize>(), last_bullet) {
                    if (1..=6).contains(&level) {
                        out[b] = regex!(r"^(\s*)- ")
                            .replace(&out[b], format!("${{1}}- {} ", "#".repeat(level)).as_str())
                            .into_owned();
                    }
                }
                continue;
            }
            if regex!(r"^\s*- ").is_match(line) {
                last_bullet = Some(out.len());
            }
            out.push(line.to_string());
        }
        out.join("\n")
    })
}

fn remove_leftover_block_properties(content: &str) -> String {
    outside_fences(content, |seg| {
        seg.split('\n')
            .filter(|line| {
                let t = line.trim_start();
                let t = t.strip_prefix("- ").unwrap_or(t);
                match property_line(t) {
                    Some((key, _)) => !(dropped_by_prefix(key) || ALWAYS_DROP_BLOCK_PROPS.contains(&key)),
                    None => true,
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

// --- tasks -----------------------------------------------------------------------

fn checkbox(state: &str) -> &'static str {
    match state {
        "DONE" => "x",
        "CANCELLED" | "CANCELED" => "-",
        "DOING" | "NOW" | "STARTED" | "IN-PROGRESS" => "/",
        _ => " ",
    }
}

struct DateSpec {
    date: String,
    time: Option<String>,
    repeater: Option<String>,
}

fn parse_date_spec(inner: &str) -> Option<DateSpec> {
    let date = regex!(r"\d{4}-\d{2}-\d{2}")
        .find(inner)
        .map(|m| m.as_str().to_string())
        .or_else(|| logseq_date_to_iso(&inner.replace("[[", "").replace("]]", "")))?;
    let time = regex!(r"(?:^|\s)((?:[01]\d|2[0-3]):[0-5]\d)(?:\s|$)")
        .captures(inner)
        .map(|c| c[1].to_string());
    let repeater = regex!(r"[.+]{1,2}\d+[ymwdh]").find(inner).map(|m| m.as_str().to_string());
    Some(DateSpec { date, time, repeater })
}

fn extract_date(value: &str) -> String {
    let mut raw = value.trim().to_string();
    if let Some(inner) = raw.strip_prefix("#{").and_then(|r| r.strip_suffix('}')) {
        raw = regex!(r#""([^"]*)""#)
            .captures(inner)
            .map(|c| c[1].to_string())
            .unwrap_or_default();
    }
    let clean = raw.replace("[[", "").replace("]]", "");
    let clean = clean.trim();
    if clean.contains("{{") {
        return String::new();
    }
    regex!(r"\d{4}-\d{2}-\d{2}")
        .find(clean)
        .map(|m| m.as_str().to_string())
        .or_else(|| logseq_date_to_iso(clean))
        .unwrap_or_default()
}

fn repeat_phrase(repeater: &str) -> String {
    let Some(c) = regex!(r"^[.+]{1,2}(\d+)([ymwdh])$").captures(repeater) else {
        return String::new();
    };
    let count: u32 = c[1].parse().unwrap_or(0);
    let unit = match &c[2] {
        "y" => "year",
        "m" => "month",
        "w" => "week",
        "d" => "day",
        _ => "hour",
    };
    if count == 1 {
        format!("every {unit}")
    } else {
        format!("every {count} {unit}s")
    }
}

fn date_link(date: &str, time: Option<&str>) -> String {
    match time {
        Some(t) => format!("[[{date}]] {t}"),
        None => format!("[[{date}]]"),
    }
}

fn date_detail(label: &str, spec: &DateSpec) -> String {
    let mut d = format!("{label} {}", date_link(&spec.date, spec.time.as_deref()));
    if let Some(r) = &spec.repeater {
        let phrase = repeat_phrase(r);
        if phrase.is_empty() {
            d.push_str(&format!(" ({r})"));
        } else {
            d.push_str(&format!(" {phrase} ({r})"));
        }
    }
    d
}

fn leading_width(l: &str) -> usize {
    l.len() - l.trim_start().len()
}

fn convert_tasks(content: &str, keep_time_tracking: bool) -> String {
    outside_fences(content, |seg| convert_task_segment(seg, keep_time_tracking))
}

fn convert_task_segment(content: &str, keep_time: bool) -> String {
    let processed: String = if keep_time {
        content.to_string()
    } else {
        let mut in_logbook = false;
        content
            .split('\n')
            .filter(|l| {
                if regex!(r"^\s*:LOGBOOK:").is_match(l) {
                    in_logbook = true;
                    return false;
                }
                if in_logbook && l.contains(":END:") {
                    in_logbook = false;
                    return false;
                }
                !in_logbook
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let task_re = regex!(r"^(\s*)- (TODO|DOING|DONE|LATER|NOW|WAITING|WAIT|STARTED|IN-PROGRESS|CANCELLED|CANCELED):?(?:\s+(.*))?$");
    let bullet = regex!(r"^\s*- ");
    let lines: Vec<&str> = processed.split('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let Some(m) = task_re.captures(line) else {
            out.push(line.to_string());
            i += 1;
            continue;
        };
        let indent = m[1].to_string();
        let state = m[2].to_string();
        let mut rest = m.get(3).map(|x| x.as_str().to_string()).unwrap_or_default();

        let mut continuation: Vec<&str> = Vec::new();
        let mut j = i + 1;
        while j < lines.len() {
            let l = lines[j];
            if l.trim().is_empty() {
                let peek = lines[j + 1..].iter().find(|x| !x.trim().is_empty());
                let Some(peek) = peek else {
                    break;
                };
                if bullet.is_match(peek) && leading_width(peek) <= indent.len() {
                    break;
                }
                if leading_width(peek) > indent.len() || !bullet.is_match(peek) {
                    continuation.push(l);
                    j += 1;
                    continue;
                }
                break;
            }
            if bullet.is_match(l) || leading_width(l) <= indent.len() {
                break;
            }
            continuation.push(l);
            j += 1;
        }

        let mut priority = String::new();
        if let Some(p) = regex!(r"^\[#([ABC])\]\s*").captures(&rest) {
            priority = p[1].to_string();
            let len = p[0].len();
            rest = rest[len..].to_string();
        }
        let mut scheduled: Option<DateSpec> = None;
        let mut deadline: Option<DateSpec> = None;
        rest = outside_code_spans(&rest, |seg| {
            regex!(r"\s*\b(SCHEDULED|DEADLINE):\s*<([^<>]+)>")
                .replace_all(seg, |c: &Captures| match parse_date_spec(&c[2]) {
                    Some(spec) => {
                        if &c[1] == "SCHEDULED" {
                            scheduled = Some(spec);
                        } else {
                            deadline = Some(spec);
                        }
                        String::new()
                    }
                    None => c[0].to_string(),
                })
                .into_owned()
        });
        let (mut created, mut done, mut cancelled) = (String::new(), String::new(), String::new());
        let mut kept: Vec<String> = Vec::new();
        let mut in_logbook = false;
        for cl in continuation {
            if in_logbook {
                if cl.contains(":END:") {
                    in_logbook = false;
                }
                kept.push(cl.to_string());
                continue;
            }
            if regex!(r"^\s*:LOGBOOK:").is_match(cl) {
                in_logbook = true;
                kept.push(cl.to_string());
                continue;
            }
            if let Some(c) = regex!(r"^\s*(SCHEDULED|DEADLINE):\s*<(.+?)>").captures(cl) {
                match parse_date_spec(&c[2]) {
                    Some(spec) if &c[1] == "SCHEDULED" => scheduled = Some(spec),
                    Some(spec) => deadline = Some(spec),
                    None => kept.push(cl.to_string()),
                }
                continue;
            }
            if let Some(c) = regex!(r"^\s*\.?(created|completed|done|cancelled|canceled):: ?(.*)$").captures(cl) {
                let date = extract_date(&c[2]);
                if date.is_empty() {
                    kept.push(cl.to_string());
                    continue;
                }
                match &c[1] {
                    "created" => created = date,
                    "completed" | "done" => done = date,
                    _ => cancelled = date,
                }
                continue;
            }
            if !cl.trim().is_empty() {
                kept.push(cl.to_string());
            }
        }
        let mut details: Vec<String> = Vec::new();
        if !priority.is_empty() {
            details.push(format!("priority {priority}"));
        }
        if let Some(s) = &scheduled {
            details.push(date_detail("scheduled", s));
        }
        if let Some(d) = &deadline {
            details.push(date_detail("due", d));
        }
        if !created.is_empty() {
            details.push(format!("created {}", date_link(&created, None)));
        }
        if !done.is_empty() {
            details.push(format!("completed {}", date_link(&done, None)));
        }
        if !cancelled.is_empty() {
            details.push(format!("cancelled {}", date_link(&cancelled, None)));
        }
        let mut anchor = String::new();
        if let Some(a) = regex!(r"(?:^|\s)(\^[A-Za-z0-9_-]+)\s*$").captures(&rest) {
            anchor = a[1].to_string();
            let start = a.get(0).unwrap().start();
            rest = rest[..start].trim_end().to_string();
        }
        let parts: Vec<String> = [rest.trim().to_string(), details.join(", ")]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect();
        let text = parts.join(" — ");
        let mut task = if text.is_empty() {
            format!("{indent}- [{}]", checkbox(&state))
        } else {
            format!("{indent}- [{}] {text}", checkbox(&state))
        };
        if !anchor.is_empty() {
            task.push(' ');
            task.push_str(&anchor);
        }
        out.push(task);
        out.extend(kept);
        i = j;
    }
    out.join("\n")
}

// --- blocks -------------------------------------------------------------------------

fn convert_highlights(content: &str) -> String {
    outside_code(content, |s| regex!(r"\^\^(.+?)\^\^").replace_all(s, "==$1==").into_owned())
}

fn convert_numbered_lists(content: &str) -> String {
    outside_fences(content, |seg| {
        let lines: Vec<&str> = seg.split('\n').collect();
        let prop = regex!(r"^(\s*)logseq\.order-list-type::\s*number\s*$");
        let bullet = regex!(r"^(\s*)-\s+(.*)$");
        let mut out = Vec::new();
        let mut counters: HashMap<usize, usize> = HashMap::new();
        for i in 0..lines.len() {
            let line = lines[i];
            if prop.is_match(line) {
                continue;
            }
            let Some(m) = bullet.captures(line) else {
                out.push(line.to_string());
                continue;
            };
            let indent = m[1].len();
            counters.retain(|level, _| *level <= indent);
            let numbered = lines
                .get(i + 1)
                .and_then(|n| prop.captures(n))
                .is_some_and(|p| p[1].len() > indent);
            if numbered {
                let c = counters.entry(indent).or_insert(0);
                *c += 1;
                out.push(format!("{}{}. {}", &m[1], c, &m[2]));
            } else {
                counters.insert(indent, 0);
                out.push(line.to_string());
            }
        }
        out.join("\n")
    })
}

fn fence_for(body: &[String]) -> String {
    let longest = body
        .iter()
        .flat_map(|l| regex!(r"`+").find_iter(l).map(|m| m.len()).collect::<Vec<_>>())
        .max()
        .unwrap_or(0);
    "`".repeat(3.max(longest + 1))
}

fn strip_indent(line: &str, n: usize) -> String {
    let mut i = 0;
    let b = line.as_bytes();
    while i < n && i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    line[i..].to_string()
}

fn convert_org_blocks(content: &str, drop_queries: bool) -> String {
    outside_fences(content, |seg| {
        let lines: Vec<String> = seg.split('\n').map(String::from).collect();
        process_org_lines(&lines, drop_queries, true).join("\n")
    })
}

fn append_org_block(out: &mut Vec<String>, rendered: Vec<String>, separated: bool, followed: bool) {
    if rendered.is_empty() {
        return;
    }
    if separated && out.last().is_some_and(|l| !l.trim().is_empty()) {
        out.push(String::new());
    }
    out.extend(rendered);
    if separated && followed {
        out.push(String::new());
    }
}

fn process_org_lines(lines: &[String], drop_queries: bool, separate: bool) -> Vec<String> {
    let begin = regex!(r"(?i)^(\s*)(?:- )?#\+BEGIN_(\w+)[ \t]*(.*)$");
    let end_re = regex!(r"(?i)^(\s*)(?:- )?#\+END_\w+");
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        let Some(b) = begin.captures(line) else {
            out.push(line.clone());
            i += 1;
            continue;
        };
        let indent = b[1].to_string();
        let kind = b[2].to_uppercase();
        let argument = b[3].to_string();
        let has_bullet = regex!(r"^\s*- ").is_match(line);
        if matches!(kind.as_str(), "QUERY" | "SRC" | "EXPORT") {
            let Some(qend) = (i + 1..lines.len()).find(|j| end_re.is_match(&lines[*j])) else {
                out.push(line.clone());
                i += 1;
                continue;
            };
            if kind == "QUERY" && drop_queries {
                i = qend + 1;
                continue;
            }
            let strip = if has_bullet { indent.len() + 2 } else { indent.len() };
            let body: Vec<String> = lines[i + 1..qend].iter().map(|l| strip_indent(l, strip)).collect();
            let lang = if kind == "QUERY" {
                "query".to_string()
            } else {
                let first = argument.split_whitespace().next().unwrap_or("");
                if !first.is_empty() && first.chars().all(|c| c.is_alphanumeric() || "_+#.-".contains(c)) {
                    first.to_lowercase()
                } else {
                    String::new()
                }
            };
            let fence = fence_for(&body);
            let rendered: Vec<String> = if has_bullet {
                let mut r = vec![format!("{indent}- {fence}{lang}")];
                r.extend(body.iter().map(|l| if l.is_empty() { String::new() } else { format!("{indent}  {l}") }));
                r.push(format!("{indent}  {fence}"));
                r
            } else {
                let mut r = vec![format!("{indent}{fence}{lang}")];
                r.extend(body.iter().cloned());
                r.push(format!("{indent}{fence}"));
                r
            };
            let followed = lines.get(qend + 1).is_some_and(|l| !l.trim().is_empty());
            append_org_block(&mut out, rendered, separate && !has_bullet && indent.is_empty(), followed);
            i = qend + 1;
            continue;
        }
        let mut depth = 1;
        let mut end = None;
        for j in i + 1..lines.len() {
            if begin.is_match(&lines[j]) {
                depth += 1;
            } else if end_re.is_match(&lines[j]) {
                depth -= 1;
                if depth == 0 {
                    end = Some(j);
                    break;
                }
            }
        }
        let Some(end) = end else {
            out.push(line.clone());
            i += 1;
            continue;
        };
        let inner = process_org_lines(&lines[i + 1..end], drop_queries, false);
        let followed = lines.get(end + 1).is_some_and(|l| !l.trim().is_empty());
        append_org_block(
            &mut out,
            render_org_block(&kind, &indent, &inner, has_bullet),
            separate && !has_bullet && indent.is_empty(),
            followed,
        );
        i = end + 1;
    }
    out
}

fn quote_line(indent: &str, line: &str) -> String {
    if line.is_empty() {
        format!("{indent}>")
    } else {
        format!("{indent}> {line}")
    }
}

fn render_org_block(kind: &str, indent: &str, inner: &[String], has_bullet: bool) -> Vec<String> {
    let strip = if has_bullet { indent.len() + 2 } else { indent.len() };
    let stripped: Vec<String> = inner.iter().map(|l| strip_indent(l, strip)).collect();
    if kind == "COMMENT" {
        let mut r = vec![format!("{indent}%%")];
        r.extend(stripped.iter().map(|l| format!("{indent}{l}")));
        r.push(format!("{indent}%%"));
        return r;
    }
    if kind == "QUOTE" {
        if has_bullet {
            if stripped.is_empty() {
                return vec![format!("{indent}- >")];
            }
            let mut r = vec![format!("{indent}- > {}", stripped[0])];
            r.extend(stripped[1..].iter().map(|l| {
                if l.is_empty() {
                    format!("{indent}  >")
                } else {
                    format!("{indent}  > {l}")
                }
            }));
            return r;
        }
        return stripped.iter().map(|l| quote_line(indent, l)).collect();
    }
    let callout = if matches!(kind, "NOTE" | "TIP" | "WARNING" | "IMPORTANT" | "CAUTION" | "EXAMPLE") {
        kind.to_lowercase()
    } else {
        "note".into()
    };
    let mut body: &[String] = &stripped;
    let mut title = String::new();
    if let Some(first) = body.first() {
        if let Some(c) = regex!(r"^\*\*(.+)\*\*\s*$").captures(first) {
            title = c[1].to_string();
            body = &body[1..];
        }
    }
    let header_tail = if title.is_empty() { String::new() } else { format!(" {title}") };
    if has_bullet {
        let mut r = vec![format!("{indent}- > [!{callout}]{header_tail}")];
        r.extend(body.iter().map(|l| if l.is_empty() { format!("{indent}  >") } else { format!("{indent}  > {l}") }));
        return r;
    }
    let mut r = vec![format!("{indent}> [!{callout}]{header_tail}")];
    r.extend(body.iter().map(|l| quote_line(indent, l)));
    r
}

fn convert_simple_queries(content: &str, drop: bool) -> String {
    if drop {
        return outside_code(content, |s| regex!(r"(?i)\{\{query[\s\S]*?\}\}").replace_all(s, "").into_owned());
    }
    let fenced = outside_fences(content, |seg| {
        regex!(r"(?m)^([ \t]*)(- )?(\{\{query[\s\S]*?\}\})[ \t]*$")
            .replace_all(seg, |c: &Captures| {
                let indent = &c[1];
                let bullet = c.get(2).map(|m| m.as_str()).unwrap_or("");
                let inner: Vec<String> = c[3].split('\n').map(String::from).collect();
                let body = if bullet.is_empty() { indent.to_string() } else { format!("{indent}  ") };
                let fence = fence_for(&inner);
                let mut lines = vec![format!("{indent}{bullet}{fence}query")];
                lines.extend(inner.iter().map(|l| format!("{body}{l}")));
                lines.push(format!("{body}{fence}"));
                lines.join("\n")
            })
            .into_owned()
    });
    outside_code(&fenced, |s| regex!(r"(?i)\{\{query[\s\S]*?\}\}").replace_all(s, "`$0`").into_owned())
}

fn fix_heading_child_lists(content: &str) -> String {
    outside_fences(content, |seg| {
        let lines: Vec<&str> = seg.split('\n').collect();
        lines
            .iter()
            .enumerate()
            .map(|(i, l)| {
                if regex!(r"^#{1,6}\s+\S").is_match(l)
                    && lines.get(i + 1).is_some_and(|n| regex!(r"^[\t ]+[-*+]\s").is_match(n))
                {
                    format!("- {l}")
                } else {
                    l.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn convert_media_embeds(content: &str) -> String {
    outside_code(content, |s| {
        regex!(r"\{\{(?:video|youtube|tweet)\s+([^}]+?)\s*\}\}").replace_all(s, "![]($1)").into_owned()
    })
}

fn fix_code_blocks_in_lists(content: &str) -> String {
    let open = regex!(r"^([ \t]*)(?:([-*+])([ \t]+))?([`~]{3,})");
    let close = regex!(r"^[ \t]*([`~]{3,})((?:[ \t]+\^[A-Za-z0-9_-]+)?)[ \t]*$");
    let mut fence: Option<(char, usize)> = None;
    let mut fence_indent = String::new();
    content
        .split('\n')
        .map(|line| {
            match fence {
                None => {
                    if let Some(m) = open.captures(line) {
                        let marker = &m[4];
                        fence = Some((marker.chars().next().unwrap(), marker.len()));
                        let prefix = &m[1];
                        fence_indent = match m.get(2) {
                            Some(_) => {
                                let sep = m.get(3).map(|s| s.as_str()).unwrap_or("");
                                if sep.contains('\t') {
                                    format!("{prefix}{sep}")
                                } else {
                                    format!("{prefix}{}", " ".repeat(1 + sep.len()))
                                }
                            }
                            None => prefix.to_string(),
                        };
                    }
                    line.to_string()
                }
                Some((marker, len)) => {
                    if let Some(c) = close.captures(line) {
                        let run = &c[1];
                        if run.starts_with(marker) && run.len() >= len {
                            fence = None;
                            return if fence_indent.is_empty() {
                                line.to_string()
                            } else {
                                format!("{fence_indent}{run}{}", &c[2])
                            };
                        }
                    }
                    line.to_string()
                }
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// --- assets, links, ids ----------------------------------------------------------

struct AssetRef {
    source: String,
    filename: String,
}

fn convert_asset_links(content: &str, target: &dyn Fn(&str) -> Option<String>, assets: &mut Vec<AssetRef>) -> String {
    let re = regex!(r"(!?)\[([^\[\]]*(?:\[[^\]]*\][^\[\]]*)*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)(\{:[^}]*\})?");
    outside_code(content, |seg| {
        re.replace_all(seg, |c: &Captures| {
            let path = &c[3];
            if regex!(r"(?i)^\s*(https?:|data:)").is_match(path) || !path.contains("assets/") {
                return c[0].to_string();
            }
            if !assets.iter().any(|a| a.source == path) {
                assets.push(AssetRef {
                    source: path.to_string(),
                    filename: basename(path).to_string(),
                });
            }
            let Some(t) = target(path) else {
                return c[0].to_string();
            };
            let dims = c.get(4).and_then(|s| {
                let w = regex!(r":width\s+(\d+)").captures(s.as_str()).map(|x| x[1].to_string());
                let h = regex!(r":height\s+(\d+)").captures(s.as_str()).map(|x| x[1].to_string());
                match (w, h) {
                    (Some(w), Some(h)) => Some(format!("{w}x{h}")),
                    (Some(w), None) => Some(w),
                    (None, Some(h)) => Some(h),
                    _ => None,
                }
            });
            let bang = if &c[1] == "!" { "!" } else { "" };
            match dims {
                Some(d) => format!("{bang}[[{t}|{d}]]"),
                None => format!("{bang}[[{t}]]"),
            }
        })
        .into_owned()
    })
}

fn convert_alias_links(content: &str) -> String {
    outside_code(content, |s| {
        regex!(r"\[([^\]]+)\]\(\[\[([^\]]+)\]\]\)")
            .replace_all(s, |c: &Captures| {
                format!("[[{}|{}]]", c[2].split('|').next().unwrap_or(""), &c[1])
            })
            .into_owned()
    })
}

struct DefinedId {
    uuid: String,
    short: String,
}

fn attach_block_ids(content: &str) -> (String, Vec<DefinedId>) {
    let lines: Vec<&str> = content.split('\n').collect();
    let fenced = fence_lines(content);
    let id_line = regex!(r"^(\s*)(?:- )?id:: ?([0-9a-fA-F-]{6,})\s*$");
    let mut out: Vec<String> = Vec::new();
    let mut ids = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    let mut last_content: Option<usize> = None;
    for (idx, line) in lines.iter().enumerate() {
        if fenced[idx] {
            if !line.trim().is_empty() {
                last_content = Some(out.len());
            }
            out.push(line.to_string());
            continue;
        }
        if let (Some(m), Some(target_idx)) = (id_line.captures(line), last_content) {
            let uuid = m[2].to_string();
            let indent = m[1].to_string();
            let base: String = uuid.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect();
            let base = if base.is_empty() { "ref".to_string() } else { base };
            let mut short = base.clone();
            let mut n = 1;
            while used.contains(&short) {
                short = format!("{base}-{n}");
                n += 1;
            }
            used.insert(short.clone());
            let target = out[target_idx].clone();
            if !target.trim_end().ends_with(&format!("^{short}")) {
                let t = target.trim_start();
                let t = t.strip_prefix("- ").map(|x| x.trim_start()).unwrap_or(t);
                if regex!(r"^[ \t]*(?:[-*+]\s+)?[`~]{3,}[ \t]*$").is_match(&target) {
                    out.push(format!("{indent}^{short}"));
                    last_content = Some(out.len() - 1);
                } else if regex!(r"^#{1,6} ").is_match(t) {
                    if regex!(r"^\s*-\s+#{1,6} ").is_match(&target) {
                        out.push(format!("{indent}^{short}"));
                    } else {
                        out.push(format!("^{short}"));
                    }
                    last_content = Some(out.len() - 1);
                } else {
                    out[target_idx] = format!("{} ^{short}", target.trim_end());
                }
            }
            ids.push(DefinedId { uuid, short });
            continue;
        }
        if !line.trim().is_empty() {
            last_content = Some(out.len());
        }
        out.push(line.to_string());
    }
    (out.join("\n"), ids)
}

fn normalize_whitespace(content: &str) -> String {
    outside_fences(content, |seg| {
        let lines: Vec<&str> = seg.split('\n').collect();
        let mut out = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if regex!(r"^\s*-\s*$").is_match(line) {
                let parent_indent = leading_width(line);
                let next = lines[i + 1..].iter().find(|l| !l.trim().is_empty());
                let child = next.and_then(|n| regex!(r"^(\s*)[-*+]\s").captures(n)).map(|c| c[1].len());
                if !child.is_some_and(|w| w > parent_indent) {
                    continue;
                }
            }
            out.push(line.replace('\u{a0}', " ").trim_end_matches([' ', '\t']).to_string());
        }
        out.join("\n")
    })
}

struct Target {
    page: String,
    short: String,
}

fn resolve_block_refs(content: &str, index: &HashMap<String, Target>) -> String {
    outside_code(content, |seg| {
        let s = regex!(r"\{\{embed\s+\(\(([^()]+?)\)\)\}\}")
            .replace_all(seg, |c: &Captures| match index.get(c[1].trim()) {
                Some(t) => format!("![[{}#^{}]]", t.page, t.short),
                None => c[0].to_string(),
            })
            .into_owned();
        let s = regex!(r"\{\{embed\s+\[\[([^\]]+?)\]\]\}\}").replace_all(&s, "![[$1]]").into_owned();
        regex!(r"\(\(([^()]+?)\)\)")
            .replace_all(&s, |c: &Captures| match index.get(c[1].trim()) {
                Some(t) => format!("[[{}#^{}]]", t.page, t.short),
                None => c[0].to_string(),
            })
            .into_owned()
    })
}

fn rewrite_alias_references(content: &str, aliases: &HashMap<String, String>) -> String {
    if aliases.is_empty() {
        return content.to_string();
    }
    outside_code(content, |seg| {
        regex!(r"(!?)\[\[([^\]]+)\]\]")
            .replace_all(seg, |c: &Captures| {
                let inner = &c[2];
                let (target, display) = match inner.find('|') {
                    Some(p) => (inner[..p].trim(), &inner[p + 1..]),
                    None => (inner.trim(), inner.trim()),
                };
                if target.contains('#') {
                    return c[0].to_string();
                }
                match aliases.get(&target.to_lowercase()) {
                    Some(canon) if canon.to_lowercase() != target.to_lowercase() => {
                        format!("{}[[{canon}|{display}]]", &c[1])
                    }
                    _ => c[0].to_string(),
                }
            })
            .into_owned()
    })
}

fn convert_tags(content: &str, drop: &[&str]) -> String {
    outside_code(content, |seg| {
        let s = regex!(r"(^|[\s(\[])#\[\[([^\]]+)\]\]")
            .replace_all(seg, |c: &Captures| {
                let name = &c[2];
                let spaced: String = regex!(r"\s+").replace_all(name, "-").into_owned();
                let tag = regex!(r"-+").replace_all(&sanitize_tag(&spaced, ""), "-").into_owned();
                if drop.contains(&name) || drop.contains(&tag.as_str()) {
                    return c[1].to_string();
                }
                if tag.is_empty() {
                    c[1].to_string()
                } else {
                    format!("{}#{tag}", &c[1])
                }
            })
            .into_owned();
        if drop.is_empty() {
            return s;
        }
        regex!(r"(^|[\s(\[])#([^\s#,.;:!?()\[\]{}]+)")
            .replace_all(&s, |c: &Captures| {
                if drop.contains(&&c[2]) {
                    c[1].to_string()
                } else {
                    c[0].to_string()
                }
            })
            .into_owned()
    })
}

fn namespace_to_path(stem: &str, triple_lowbar: bool) -> String {
    let separated = if triple_lowbar { stem.replace("___", "/") } else { stem.replace('.', "/") };
    let decoded = decode_percent_runs(&separated);
    if triple_lowbar {
        decoded.split('/').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("/")
    } else {
        decoded
    }
}

fn decode_percent_runs(s: &str) -> String {
    regex!(r"(?:%[0-9A-Fa-f]{2})+")
        .replace_all(s, |c: &Captures| {
            let d = percent_decode(&c[0]);
            if d == c[0] {
                c[0].to_string()
            } else {
                d
            }
        })
        .into_owned()
}

struct PlannedLink {
    target: String,
    display: Option<String>,
}

fn rewrite_planned_links(content: &str, plans: &HashMap<String, PlannedLink>, triple_lowbar: bool) -> String {
    outside_code(content, |seg| {
        regex!(r"(!?)\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]")
            .replace_all(seg, |c: &Captures| {
                let key = namespace_to_path(c[2].trim(), triple_lowbar).to_lowercase();
                let Some(plan) = plans.get(&key) else {
                    return c[0].to_string();
                };
                let suffix = c.get(3).map(|m| m.as_str()).unwrap_or("");
                let display = c.get(4).map(|m| m.as_str().to_string()).or_else(|| plan.display.clone());
                match display {
                    Some(d) => format!("{}[[{}{suffix}|{d}]]", &c[1], plan.target),
                    None => format!("{}[[{}{suffix}]]", &c[1], plan.target),
                }
            })
            .into_owned()
    })
}

// --- graph ------------------------------------------------------------------------

struct Note {
    source: String,
    logical: String,
    source_names: Vec<String>,
    path: String,
    target: String,
    yaml: String,
    body: String,
    raw: HashMap<String, String>,
    ids: Vec<DefinedId>,
    assets: Vec<AssetRef>,
}

pub fn convert(files: &[(String, Vec<u8>)]) -> ImportResult {
    convert_with(files, &LogseqOptions::default())
}

pub fn convert_with(files: &[(String, Vec<u8>)], opts: &LogseqOptions) -> ImportResult {
    let mut result = ImportResult::default();
    let mut flat: Vec<(String, Vec<u8>)> = Vec::new();
    for (p, d) in files {
        if extension_lower(p) == "zip" {
            match crate::zip::read_zip(d) {
                Ok(es) => flat.extend(es.into_iter().filter(|e| !e.is_dir).map(|e| (e.name, e.data))),
                Err(e) => result.warnings.push(format!("{p}: {e}")),
            }
        } else {
            flat.push((p.replace('\\', "/").trim_start_matches('/').to_string(), d.clone()));
        }
    }
    // Find the graph root: the folder holding logseq/config.edn, pages/ or journals/.
    let root = flat
        .iter()
        .find_map(|(p, _)| {
            let lower = p.to_lowercase();
            if lower == "logseq/config.edn" || lower.ends_with("/logseq/config.edn") {
                Some(p[..p.len() - "logseq/config.edn".len()].to_string())
            } else {
                None
            }
        })
        .or_else(|| {
            flat.iter().find_map(|(p, _)| {
                let segs: Vec<&str> = p.split('/').collect();
                segs.iter()
                    .position(|s| s.eq_ignore_ascii_case("pages") || s.eq_ignore_ascii_case("journals"))
                    .filter(|i| *i + 1 < segs.len())
                    .map(|i| segs[..i].iter().map(|s| format!("{s}/")).collect::<String>())
            })
        })
        .unwrap_or_default();
    let flat: Vec<(String, Vec<u8>)> = flat
        .into_iter()
        .filter_map(|(p, d)| p.strip_prefix(&root).map(|r| (r.to_string(), d)))
        .filter(|(p, _)| !basename(p).starts_with("._") && !p.contains(".recycle/") && !p.starts_with("logseq/bak/"))
        .collect();
    let by_path: HashMap<String, usize> = flat.iter().enumerate().map(|(i, (p, _))| (p.to_lowercase(), i)).collect();
    let config = flat
        .iter()
        .find(|(p, _)| p.eq_ignore_ascii_case("logseq/config.edn"))
        .map(|(_, d)| parse_config(&super::util::decode_text(d)))
        .unwrap_or_default();

    let under = |p: &str, dir: &str| -> Option<String> {
        let lp = p.to_lowercase();
        let prefix = format!("{}/", dir.to_lowercase());
        lp.starts_with(&prefix).then(|| p[prefix.len()..].to_string())
    };
    if flat.iter().any(|(p, _)| under(p, &config.whiteboards_directory).is_some()) {
        result.warnings.push("Whiteboards were skipped: Obsidian has no equivalent".into());
    }

    let drop_tags: Vec<&str> = if opts.flashcards { vec![] } else { vec!["card"] };
    let prefix_target = |t: &str| {
        if opts.vault_folder.trim_matches('/').is_empty() {
            t.to_string()
        } else {
            format!("{}/{t}", opts.vault_folder.trim_matches('/'))
        }
    };
    let mut paths = UniquePaths::new();
    let mut notes: Vec<Note> = Vec::new();
    for (p, d) in &flat {
        if extension_lower(p) != "md" {
            continue;
        }
        let journal = under(p, &config.journals_directory);
        let page = under(p, &config.pages_directory);
        let (logical, source_names, folder) = match (&journal, &page) {
            (Some(j), _) => {
                let stem = j.strip_suffix(".md").unwrap_or(j).to_string();
                let iso = journal_file_to_iso(&stem, config.journal_file_name_format.as_deref());
                let logical = match &iso {
                    Some(i) => {
                        let (y, m, dd) = (i[..4].parse().unwrap(), i[5..7].parse().unwrap(), i[8..10].parse().unwrap());
                        format_moment(y, m, dd, &opts.daily_note_format)
                    }
                    None => stem.clone(),
                };
                let mut names = vec![logical.clone()];
                if let Some(i) = &iso {
                    names.push(i.clone());
                    if let Some(f) = &config.journal_page_title_format {
                        let (y, m, dd) = (i[..4].parse().unwrap(), i[5..7].parse().unwrap(), i[8..10].parse().unwrap());
                        names.push(format_moment(y, m, dd, &date_fns_to_moment(f)));
                    }
                }
                let root = opts.journals_folder.trim_matches('/').to_string();
                let folder = join(&root, &sanitize_file_path(parent(&logical)));
                (logical, names, folder)
            }
            (None, Some(pg)) => {
                let stem = split_ext(basename(pg)).0;
                let logical = namespace_to_path(stem, config.triple_lowbar);
                (logical.clone(), vec![logical.clone()], sanitize_file_path(parent(&logical)))
            }
            _ => continue,
        };
        let title = basename(&logical).to_string();
        let path = paths.claim(&folder, &format!("{}.md", sanitize_file_name(&title)));
        let text = super::util::decode_text(d).replace("\r\n", "\n");
        let props = extract_page_properties(&text, &drop_tags, &config.comma_separated_properties);
        let mut body = convert_heading_property(&props.body);
        body = convert_tasks(&body, opts.time_tracking);
        body = convert_numbered_lists(&body);
        body = convert_org_blocks(&body, !opts.queries);
        body = convert_simple_queries(&body, !opts.queries);
        body = convert_highlights(&body);
        body = convert_media_embeds(&body);
        body = fix_heading_child_lists(&body);
        body = fix_code_blocks_in_lists(&body);
        let mut assets = Vec::new();
        body = convert_asset_links(&body, &|_| None, &mut assets);
        body = convert_alias_links(&body);
        body = convert_journal_date_links(&body);
        let (b, ids) = attach_block_ids(&body);
        body = remove_leftover_block_properties(&b);
        body = normalize_whitespace(&body);
        let target = prefix_target(path.strip_suffix(".md").unwrap_or(&path));
        let mut names = Vec::new();
        for n in source_names {
            if !names.contains(&n) {
                names.push(n);
            }
        }
        notes.push(Note {
            source: p.clone(),
            logical,
            source_names: names,
            path,
            target,
            yaml: props.yaml,
            body,
            raw: props.raw,
            ids,
            assets,
        });
    }
    if notes.is_empty() {
        result.warnings.push("No Logseq pages or journals found".into());
    }

    // Assets.
    let attachment_dir = opts.attachment_folder.trim_matches('/').to_string();
    let mut placed: HashMap<usize, String> = HashMap::new();
    let mut attachments: Vec<ImportedFile> = Vec::new();
    for note in notes.iter_mut() {
        let mut targets: HashMap<String, Option<String>> = HashMap::new();
        for a in &note.assets {
            let clean = percent_decode(a.source.trim().trim_start_matches('<').trim_end_matches('>'));
            let rel = resolve_path(parent(&note.source), &clean);
            let stripped = resolve_path("", clean.trim_start_matches("../"));
            let found = by_path.get(&rel.to_lowercase()).or_else(|| by_path.get(&stripped.to_lowercase())).copied();
            let target = match found {
                Some(i) => {
                    let out = placed.entry(i).or_insert_with(|| {
                        let name = sanitize_file_name(&percent_decode(&a.filename));
                        let p = paths.claim(&attachment_dir, &name);
                        attachments.push(ImportedFile::new(p.clone(), flat[i].1.clone()));
                        p
                    });
                    Some(basename(out).to_string())
                }
                None => {
                    result.warnings.push(format!("{}: asset {} is missing", note.source, a.source));
                    None
                }
            };
            targets.insert(a.source.clone(), target);
        }
        let mut unused = Vec::new();
        note.body = convert_asset_links(&note.body, &|src| targets.get(src).cloned().flatten(), &mut unused);
    }

    // Link plans, aliases, block ids.
    let mut plans: HashMap<String, PlannedLink> = HashMap::new();
    let mut basenames: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, n) in notes.iter().enumerate() {
        let target_base = basename(&n.target).to_lowercase();
        for s in &n.source_names {
            let display = basename(s);
            plans.insert(
                s.to_lowercase(),
                PlannedLink {
                    target: n.target.clone(),
                    display: (display.to_lowercase() != target_base).then(|| display.to_string()),
                },
            );
        }
        basenames.entry(basename(&n.logical).to_lowercase()).or_default().push(i);
    }
    for (base, matching) in &basenames {
        if let Some(sel) = matching.iter().find(|i| notes[**i].logical.to_lowercase() == *base) {
            let n = &notes[*sel];
            let display = basename(&n.logical);
            plans.insert(
                base.clone(),
                PlannedLink {
                    target: n.target.clone(),
                    display: (display.to_lowercase() != basename(&n.target).to_lowercase()).then(|| display.to_string()),
                },
            );
        }
    }
    let known: HashSet<String> = notes
        .iter()
        .flat_map(|n| n.source_names.iter().flat_map(|s| [s.to_lowercase(), basename(s).to_lowercase()]))
        .collect();
    let mut alias_map: HashMap<String, String> = HashMap::new();
    let mut ambiguous: HashSet<String> = HashSet::new();
    let mut block_index: HashMap<String, Target> = HashMap::new();
    for n in &notes {
        let mut values = Vec::new();
        for key in ["alias", "aliases", "title"] {
            if let Some(v) = n.raw.get(key) {
                if key == "title" && v.to_lowercase() == n.logical.to_lowercase() {
                    continue;
                }
                values.push(v.clone());
            }
        }
        for v in values {
            for item in split_list(&v) {
                let name = strip_wiki(item.trim()).trim().to_string();
                if name.is_empty() {
                    continue;
                }
                let key = name.to_lowercase();
                if known.contains(&key) {
                    continue;
                }
                match alias_map.get(&key) {
                    Some(existing) if *existing != n.target => {
                        ambiguous.insert(key);
                    }
                    _ => {
                        alias_map.insert(key, n.target.clone());
                    }
                }
            }
        }
        for id in &n.ids {
            block_index.insert(id.uuid.clone(), Target { page: n.target.clone(), short: id.short.clone() });
        }
    }
    for a in ambiguous {
        alias_map.remove(&a);
    }

    let mut out_notes = Vec::new();
    for n in notes {
        let mut body = n.body.clone();
        if !opts.flashcards {
            body = outside_code(&body, |s| {
                let s = regex!(r"(?i)\{\{cloze\s+([\s\S]*?)\}\}").replace_all(s, "$1").into_owned();
                regex!(r"(?i)(^|\s)#card\b").replace_all(&s, "$1").into_owned()
            });
        }
        body = resolve_block_refs(&body, &block_index);
        body = rewrite_alias_references(&body, &alias_map);
        body = convert_tags(&body, &drop_tags);
        if opts.daily_note_format != "YYYY-MM-DD" {
            body = outside_code(&body, |s| {
                regex!(r"\[\[(\d{4})-(\d{2})-(\d{2})(#\^[^\]]+)?\]\]")
                    .replace_all(s, |c: &Captures| {
                        let (y, m, d) = (c[1].parse().unwrap_or(0), c[2].parse().unwrap_or(0), c[3].parse().unwrap_or(0));
                        if !valid_date(y, m, d) {
                            return c[0].to_string();
                        }
                        let f = format_moment(y, m, d, &opts.daily_note_format);
                        format!("[[{f}{}]]", c.get(4).map(|x| x.as_str()).unwrap_or(""))
                    })
                    .into_owned()
            });
        }
        body = rewrite_planned_links(&body, &plans, config.triple_lowbar);
        if opts.flatten_outlines {
            body = flatten(&body);
        }
        // The importer keeps a source file's trailing newline and adds its
        // own; one is enough.
        let body = body.trim_end_matches('\n').to_string();
        if n.yaml.is_empty() && body.trim().is_empty() {
            result.warnings.push(format!("Skipped {}: the page is empty", n.source));
            continue;
        }
        let text = if n.yaml.is_empty() {
            format!("{body}\n")
        } else {
            format!("{}\n\n{body}\n", n.yaml)
        };
        out_notes.push(ImportedFile::note(n.path, text));
    }
    result.files = out_notes;
    result.files.extend(attachments);
    result
}

/// Parse `- ` bullets into outline nodes and flatten them.
fn flatten(body: &str) -> String {
    fn parse(lines: &[&str], fenced: &[bool]) -> Vec<OutlineNode> {
        let mut roots: Vec<(usize, OutlineNode)> = Vec::new();
        let mut stack: Vec<(usize, OutlineNode)> = Vec::new();
        fn attach(stack: &mut Vec<(usize, OutlineNode)>, roots: &mut Vec<(usize, OutlineNode)>, node: (usize, OutlineNode)) {
            match stack.last_mut() {
                Some(parent) => parent.1.children.push(node.1),
                None => roots.push(node),
            }
        }
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            let indent = leading_width(line);
            let is_bullet = line.trim_start().starts_with("- ") && !fenced[i];
            if !is_bullet {
                let mut raw = vec![line.to_string()];
                i += 1;
                while i < lines.len() && (fenced[i] || !lines[i].trim_start().starts_with("- ")) {
                    raw.push(lines[i].to_string());
                    i += 1;
                }
                while let Some(n) = stack.pop() {
                    attach(&mut stack, &mut roots, n);
                }
                if raw.iter().any(|r| !r.trim().is_empty()) {
                    roots.push((0, OutlineNode::text(raw.join("\n").trim_matches('\n'))));
                }
                continue;
            }
            let mut text = vec![line.trim_start()[2..].to_string()];
            i += 1;
            while i < lines.len() && (fenced[i] || (!lines[i].trim_start().starts_with("- ") && (lines[i].trim().is_empty() || leading_width(lines[i]) > indent))) {
                text.push(strip_indent(lines[i], indent + 2));
                i += 1;
            }
            while stack.last().is_some_and(|(d, _)| *d >= indent) {
                let n = stack.pop().unwrap();
                attach(&mut stack, &mut roots, n);
            }
            let joined = text.join("\n").trim_end().to_string();
            stack.push((indent, OutlineNode::text(joined)));
        }
        while let Some(n) = stack.pop() {
            attach(&mut stack, &mut roots, n);
        }
        roots.into_iter().map(|(_, n)| n).collect()
    }
    let lines: Vec<&str> = body.split('\n').collect();
    let fenced = fence_lines(body);
    de_outline(&parse(&lines, &fenced))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph(files: &[(&str, &str)]) -> Vec<(String, Vec<u8>)> {
        files.iter().map(|(p, d)| (p.to_string(), d.as_bytes().to_vec())).collect()
    }

    const MAIN: &str = "title:: Main Page\ntags:: #topic, [[area]]\nalias:: [[MP]], [[main-page]]\nauthors:: Alice, Bob\ncollapsed:: true\n\n- This is the main fixture page\n- TODO [#A] Write documentation\n  SCHEDULED: <2024-06-15 Sat>\n  created:: 2024-06-01\n- DOING [#B] Review sample changes\n  DEADLINE: <2024-06-20 Thu .+1w>\n- DONE Ship v1.0\n  completed:: [[2024-06-10]]\n  :LOGBOOK:\n  CLOCK: [2024-06-09 Sun 09:00:00]--[2024-06-09 Sun 17:00:00] =>  8:00\n  :END:\n- CANCELLED Old task\n  cancelled:: 2024-05-30\n- See the [[algorithms___dynamic programming]] page\n- Reference to alias: [[MP]]\n- Block reference: ((a1b2c3d4-e5f6-7890-abcd-ef1234567890))\n- id:: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n- ^^Important^^ note with `^^code^^` inside\n- {{youtube https://www.youtube.com/watch?v=dQw4w9WgXcQ}}\n- {{embed [[Reference Page]]}}\n- [My Alias]([[Reference Page]])\n- #topic #[[multi word tag]]\n- ![diagram](../assets/diagram.png){:height 400, :width 600}\n- First\n  logseq.order-list-type:: number\n- Second\n  logseq.order-list-type:: number\n- Section header\n  heading:: 2\n#+BEGIN_WARNING\n**Watch out!**\nThis could break things.\n#+END_WARNING\n";

    fn fixture() -> Vec<(String, Vec<u8>)> {
        let mut g = graph(&[
            ("my graph/logseq/config.edn", "{:meta/version 1\n :file/name-format :triple-lowbar\n :journal/page-title-format \"MMM do, yyyy\"\n :property/separated-by-commas #{:authors}}"),
            ("my graph/pages/Main Page.md", MAIN),
            ("my graph/pages/Reference Page.md", "title:: Reference Page\n\n- Recorded fixture context\n  id:: a1b2c3d4-e5f6-7890-abcd-ef1234567890\n- Follow-up from [[Jan 15th, 2024]]\n- See also [[MP]]\n"),
            ("my graph/pages/algorithms___dynamic programming.md", "tags:: #algorithms, #cs\n\n- Dynamic programming\n- Back to ((a1b2c3d4-e5f6-7890-abcd-ef1234567890))\n"),
            ("my graph/pages/Encoded%3AColon.md", "- Links to [[algorithms___dynamic programming]]\n"),
            ("my graph/pages/empty.md", "\n\n"),
            ("my graph/journals/2024_06_15.md", "- TODO Morning standup\n- Block ref: ((aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee))\n- Saw [[Jun 15th, 2024]] and [[2024-06-15]]\n- ![photo](../assets/diagram.png)\n"),
            ("my graph/whiteboards/board.edn", "{}"),
        ]);
        g.push(("my graph/assets/diagram.png".into(), b"PNG".to_vec()));
        g
    }

    #[test]
    fn page_properties_become_frontmatter() {
        let r = convert(&fixture());
        let main = r.text("Main Page.md");
        assert!(
            main.starts_with("---\naliases:\n  - MP\n  - main-page\n  - Main Page\ntags:\n  - topic\n  - area\nauthors:\n  - Alice\n  - Bob\n---\n\n- This is the main fixture page\n"),
            "{main}"
        );
    }

    #[test]
    fn tasks_with_metadata() {
        let main = convert(&fixture()).text("Main Page.md");
        assert!(main.contains("- [ ] Write documentation — priority A, scheduled [[Journals/2024-06-15]], created [[2024-06-01]]\n"), "{main}");
        assert!(main.contains("- [/] Review sample changes — priority B, due [[2024-06-20]] every week (.+1w)\n"), "{main}");
        assert!(main.contains("- [x] Ship v1.0 — completed [[2024-06-10]]\n- [-] Old task — cancelled [[2024-05-30]]\n"), "{main}");
        assert!(!main.contains("LOGBOOK"), "{main}");
    }

    #[test]
    fn block_refs_aliases_namespaces_and_tags() {
        let r = convert(&fixture());
        let main = r.text("Main Page.md");
        assert!(main.contains("- See the [[algorithms/dynamic programming]] page"), "{main}");
        assert!(main.contains("- Reference to alias: [[Main Page|MP]]"), "{main}");
        assert!(main.contains("- Block reference: [[Reference Page#^a1b2c3]] ^aaaaaa"), "{main}");
        assert!(main.contains("- ==Important== note with `^^code^^` inside"), "{main}");
        assert!(main.contains("- ![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)"), "{main}");
        assert!(main.contains("- ![[Reference Page]]\n- [[Reference Page|My Alias]]\n- #topic #multi-word-tag\n- ![[diagram.png|600x400]]\n1. First\n2. Second\n- ## Section header"), "{main}");
        assert!(main.contains("> [!warning] Watch out!\n> This could break things."), "{main}");
        let reference = r.text("Reference Page.md");
        assert!(reference.contains("- Recorded fixture context ^a1b2c3\n- Follow-up from [[2024-01-15]]\n- See also [[Main Page|MP]]"), "{reference}");
        assert_eq!(
            r.text("algorithms/dynamic programming.md"),
            "---\ntags:\n  - algorithms\n  - cs\n---\n\n- Dynamic programming\n- Back to [[Reference Page#^a1b2c3]]\n"
        );
        assert_eq!(r.text("EncodedColon.md"), "- Links to [[algorithms/dynamic programming]]\n");
    }

    #[test]
    fn journals_assets_empty_pages_and_whiteboards() {
        let r = convert(&fixture());
        assert_eq!(
            r.text("Journals/2024-06-15.md"),
            "- [ ] Morning standup\n- Block ref: [[Main Page#^aaaaaa]]\n- Saw [[Journals/2024-06-15]] and [[Journals/2024-06-15]]\n- ![[diagram.png]]\n"
        );
        assert_eq!(r.file("attachments/diagram.png").unwrap().data, b"PNG");
        assert_eq!(r.files.iter().filter(|f| f.path.ends_with(".png")).count(), 1);
        assert!(r.file("empty.md").is_none());
        assert!(r.warnings.iter().any(|w| w.contains("Whiteboards")), "{:?}", r.warnings);
        assert!(r.warnings.iter().any(|w| w.contains("empty")), "{:?}", r.warnings);
    }

    #[test]
    fn org_blocks_queries_and_code_in_lists() {
        let page = "- Source\n  - #+BEGIN_SRC python\n    def f():\n        return 1\n    #+END_SRC\n- {{query (property :status doing)}}\n- Tracking {{query (todo TODO)}} inline\n#+BEGIN_QUOTE\nA wise quote\n#+END_QUOTE\n#+BEGIN_COMMENT\ninternal\n#+END_COMMENT\n- code:\n  - ```js\n    x()\n    ```";
        let r = convert(&graph(&[("pages/Org.md", page)]));
        let t = r.text("Org.md");
        assert!(t.contains("  - ```python\n    def f():\n        return 1\n    ```"), "{t}");
        assert!(t.contains("- ```query\n  {{query (property :status doing)}}\n  ```"), "{t}");
        assert!(t.contains("- Tracking `{{query (todo TODO)}}` inline"), "{t}");
        assert!(t.contains("\n> A wise quote\n"), "{t}");
        assert!(t.contains("%%\ninternal\n%%"), "{t}");
        assert!(t.contains("  - ```js\n    x()\n    ```"), "{t}");
        let dropped = convert_with(&graph(&[("pages/Org.md", page)]), &LogseqOptions { queries: false, ..LogseqOptions::default() });
        assert!(!dropped.text("Org.md").contains("query"), "{}", dropped.text("Org.md"));
    }

    #[test]
    fn config_and_date_formats() {
        let c = parse_config("{:pages-directory \"notes\" ;; comment\n :file/name-format :triple-lowbar :journal/file-name-format \"yyyy-MM-dd\" :property/separated-by-commas #{:Authors :related}}");
        assert_eq!(c.pages_directory, "notes");
        assert!(c.triple_lowbar);
        assert!(c.comma_separated_properties.contains("authors"));
        assert!(!parse_config("{}").triple_lowbar);
        assert_eq!(date_fns_to_moment("MMM do, yyyy"), "MMM Do, YYYY");
        assert_eq!(date_fns_to_moment("EEE, dd.MM.yyyy 'week'"), "ddd, DD.MM.YYYY [week]");
        assert_eq!(parse_moment("2024-06-15", "YYYY-MM-DD"), Some((2024, 6, 15)));
        assert_eq!(parse_moment("Jun 15th, 2024", "MMM Do, YYYY"), Some((2024, 6, 15)));
        assert_eq!(parse_moment("2024-13-15", "YYYY-MM-DD"), None);
        let r = convert_with(
            &graph(&[("logseq/config.edn", "{:journal/file-name-format \"yyyy.MM.dd\"}"), ("journals/2024.01.02.md", "- hi [[2024-01-02]]"), ("pages/a.b.md", "- legacy namespace")]),
            &LogseqOptions { daily_note_format: "DD MMM YYYY".into(), journals_folder: "Daily".into(), ..LogseqOptions::default() },
        );
        assert_eq!(r.text("Daily/02 Jan 2024.md"), "- hi [[Daily/02 Jan 2024]]\n");
        assert!(r.file("a/b.md").is_some(), "{:?}", r.paths());
    }

    #[test]
    fn flashcards_off_and_flatten() {
        let page = "- What is {{cloze Rust}}? #card\n- Heading\n  - one\n  - two";
        let r = convert_with(&graph(&[("pages/Cards.md", page)]), &LogseqOptions { flashcards: false, flatten_outlines: true, ..LogseqOptions::default() });
        assert_eq!(r.text("Cards.md"), "What is Rust?\n\nHeading\n\n- one\n- two\n");
    }
}
