//! The MCP tools: definitions (JSON Schema) and implementations.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use vault_index::{RenameOptions, SearchOptions};
use vault_ofm::SubpathResult;
use vault_types::LineIndex;

use super::fsx::{self, TextFile};
use super::{note_uri, Server, ToolError, ToolOutput};
use crate::vault::{self, Vault};

type R = Result<ToolOutput, ToolError>;

/// Tools that never modify the vault, in `tools/list` order.
const READ_TOOLS: &[&str] = &["search", "read_note", "list_notes", "backlinks", "outgoing_links", "tags", "properties"];
/// Tools that modify the vault (hidden by `--read-only`).
const WRITE_TOOLS: &[&str] = &["create_note", "edit_note", "append_note", "set_property", "rename_note"];
/// `daily_note` reads, and — unless read-only — creates and appends.
const DAILY: &str = "daily_note";

pub fn exists(name: &str) -> bool {
    READ_TOOLS.contains(&name) || WRITE_TOOLS.contains(&name) || name == DAILY
}

pub fn is_write(name: &str) -> bool {
    WRITE_TOOLS.contains(&name)
}

const PATH_DESC: &str = "Vault-relative path with forward slashes, e.g. `Projects/Alpha.md`. `.md` may be omitted; a bare note name is resolved like a [[wikilink]].";

fn annotations(title: &str, read_only: bool, destructive: bool, idempotent: bool) -> Value {
    json!({ "title": title, "readOnlyHint": read_only, "destructiveHint": destructive, "idempotentHint": idempotent, "openWorldHint": false })
}

fn tool(name: &str, title: &str, description: &str, properties: Value, required: &[&str], ann: Value) -> Value {
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required, "additionalProperties": false },
        "annotations": ann,
    })
}

/// Tool definitions in a fixed order.
pub fn definitions(read_only: bool) -> Vec<Value> {
    let mut out = vec![
        tool(
            "search",
            "Search notes",
            "Search the vault with Obsidian's search syntax and get matching files with line snippets. Syntax: words (all must match), \"exact phrase\", OR, -exclude, (grouping), /regex/, and operators file:, path:, content:, tag:#tag, line:(a b), block:(…), section:(…), task:, task-todo:, task-done:, [property], [property:value]. Results are sorted by path; counts cover all matches even when `limit` cuts the list.",
            json!({
                "query": { "type": "string", "description": "Obsidian search query, e.g. `tag:#project status` or `path:Journal \"weekly review\"`." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 20, "description": "Maximum number of files to return." },
                "case_sensitive": { "type": "boolean", "default": false },
                "snippets_per_file": { "type": "integer", "minimum": 0, "maximum": 20, "default": 3, "description": "Matching lines to include per file." }
            }),
            &["query"],
            annotations("Search notes", true, false, true),
        ),
        tool(
            "read_note",
            "Read a note",
            "Read a Markdown note: the whole note, or just one heading's section (the heading line through to the next heading of the same or higher level), or one block by its ^block-id. Line endings are returned as \\n.",
            json!({
                "path": { "type": "string", "description": PATH_DESC },
                "heading": { "type": "string", "description": "Optional heading text (without #). Nested headings as `Parent#Child`." },
                "block": { "type": "string", "description": "Optional block id, with or without the leading ^." }
            }),
            &["path"],
            annotations("Read a note", true, false, true),
        ),
        tool(
            "list_notes",
            "List notes",
            "List notes (and optionally other files) in the vault, optionally inside a folder (recursive) and/or matching a glob. Glob: `*` any characters except /, `**` any folders, `?` one character; a glob without / matches the file name only (e.g. `*meeting*`), with / it matches the whole path (e.g. `Journal/**/2026-*.md`). Case-insensitive.",
            json!({
                "folder": { "type": "string", "description": "Vault-relative folder, e.g. `Projects`. Omit for the whole vault." },
                "glob": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 5000, "default": 200 },
                "sort": { "type": "string", "enum": ["path", "modified"], "default": "path", "description": "`modified` lists the most recently changed first." },
                "include_attachments": { "type": "boolean", "default": false, "description": "Also list non-Markdown files (images, PDFs, canvases …)." }
            }),
            &[],
            annotations("List notes", true, false, true),
        ),
        tool(
            "backlinks",
            "Backlinks",
            "Notes that link to (or embed) a note or file, with the line and text around each link.",
            json!({ "path": { "type": "string", "description": PATH_DESC } }),
            &["path"],
            annotations("Backlinks", true, false, true),
        ),
        tool(
            "outgoing_links",
            "Outgoing links",
            "Links and embeds in a note: resolved targets (vault paths) with counts, and unresolved link targets (notes that do not exist yet).",
            json!({ "path": { "type": "string", "description": PATH_DESC } }),
            &["path"],
            annotations("Outgoing links", true, false, true),
        ),
        tool(
            "tags",
            "Tags",
            "Without `path`: every tag in the vault with its number of uses, most used first. With `path`: the tags of that note (frontmatter `tags` and inline #tags).",
            json!({ "path": { "type": "string", "description": PATH_DESC } }),
            &[],
            annotations("Tags", true, false, true),
        ),
        tool(
            "properties",
            "Properties",
            "With `path`: the note's properties (YAML frontmatter) as JSON. Without `path`: every property name in the vault with the number of notes using it.",
            json!({ "path": { "type": "string", "description": PATH_DESC } }),
            &[],
            annotations("Properties", true, false, true),
        ),
    ];
    if !read_only {
        out.extend([
            tool(
                "create_note",
                "Create a note",
                "Create a new Markdown note (folders are created as needed). Fails if the note already exists — use edit_note or append_note to change existing notes. Link to other notes with [[Note name]].",
                json!({
                    "path": { "type": "string", "description": "Vault-relative path for the new note, e.g. `Projects/Gamma.md` (`.md` is added if missing)." },
                    "content": { "type": "string", "default": "", "description": "Markdown content, optionally starting with a --- YAML frontmatter block." }
                }),
                &["path"],
                annotations("Create a note", false, false, false),
            ),
            tool(
                "edit_note",
                "Edit a note",
                "Edit an existing note in one of two ways. (1) Exact replacement: `old_string` → `new_string`; old_string must occur exactly once (copy it from read_note, including whitespace; add surrounding lines to make it unique). (2) Section replacement: `heading` (or `block`) with `content` replaces that heading's body (the heading line itself is kept unless content starts with it) or that block (its ^id is kept). The file's line endings and BOM are preserved.",
                json!({
                    "path": { "type": "string", "description": PATH_DESC },
                    "old_string": { "type": "string", "description": "Exact text to replace (must match once)." },
                    "new_string": { "type": "string", "description": "Replacement text (may be empty to delete)." },
                    "heading": { "type": "string", "description": "Heading whose section body to replace, e.g. `Tasks` or `Parent#Child`." },
                    "block": { "type": "string", "description": "Block id (^id) whose block to replace." },
                    "content": { "type": "string", "description": "New Markdown for the heading section or block." }
                }),
                &["path"],
                annotations("Edit a note", false, true, false),
            ),
            tool(
                "append_note",
                "Append to a note",
                "Append Markdown to the end of a note, or to the end of one heading's section. Adds a line break first if needed.",
                json!({
                    "path": { "type": "string", "description": PATH_DESC },
                    "content": { "type": "string" },
                    "heading": { "type": "string", "description": "Append at the end of this heading's section instead of the end of the note." },
                    "create_if_missing": { "type": "boolean", "default": false, "description": "Create the note (at exactly `path`) if it does not exist." }
                }),
                &["path", "content"],
                annotations("Append to a note", false, false, false),
            ),
            tool(
                "set_property",
                "Set a property",
                "Set one property in a note's YAML frontmatter (creating the frontmatter if needed), leaving other properties as they are. `value` may be a string, number, boolean, list or null; null removes the property. Links in properties are strings like \"[[Note]]\"; tags are a list of names without #.",
                json!({
                    "path": { "type": "string", "description": PATH_DESC },
                    "name": { "type": "string", "description": "Property name, e.g. `status` or `tags`." },
                    "value": { "description": "New value; null removes the property." }
                }),
                &["path", "name", "value"],
                annotations("Set a property", false, true, true),
            ),
            tool(
                "rename_note",
                "Rename or move a note",
                "Rename or move a note or attachment and update every link to it across the vault, as Obsidian does. If `new_path` has no folder, the file stays in its current folder. Fails if the destination exists.",
                json!({
                    "path": { "type": "string", "description": PATH_DESC },
                    "new_path": { "type": "string", "description": "New vault-relative path or new name, e.g. `Archive/Alpha.md` or `Alpha (old)`." }
                }),
                &["path", "new_path"],
                annotations("Rename or move a note", false, false, false),
            ),
        ]);
    }
    let actions: Value = if read_only { json!(["read"]) } else { json!(["read", "create", "append"]) };
    out.push(tool(
        DAILY,
        "Daily note",
        if read_only {
            "Read the daily note for today or a given date, using the vault's Daily notes settings (folder and date format)."
        } else {
            "Read, create or append to the daily note for today or a given date, using the vault's Daily notes settings (folder, date format and template). `create` and `append` create the note from the template if it does not exist."
        },
        json!({
            "action": { "type": "string", "enum": actions, "default": "read" },
            "date": { "type": "string", "description": "`today` (default), `yesterday`, `tomorrow`, or YYYY-MM-DD." },
            "content": { "type": "string", "description": "Markdown to append (action `append`)." }
        }),
        &[],
        annotations("Daily note", read_only, false, read_only),
    ));
    out
}

// ---- argument helpers ---------------------------------------------------------------

fn opt_str<'a>(args: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(format!("`{key}` must be a string").into()),
    }
}

fn req_str<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, ToolError> {
    opt_str(args, key)?.ok_or_else(|| format!("missing required argument `{key}`").into())
}

fn opt_bool(args: &Map<String, Value>, key: &str, default: bool) -> Result<bool, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("`{key}` must be true or false").into()),
    }
}

fn opt_usize(args: &Map<String, Value>, key: &str, default: usize, min: usize, max: usize) -> Result<usize, ToolError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => match v.as_u64() {
            Some(n) if (min as u64..=max as u64).contains(&n) => Ok(n as usize),
            _ => Err(format!("`{key}` must be an integer from {min} to {max}").into()),
        },
    }
}

fn json_out(v: Value) -> ToolOutput {
    ToolOutput { text: v.to_string(), structured: Some(v) }
}

fn done(text: String, v: Value) -> ToolOutput {
    ToolOutput { text, structured: Some(v) }
}

pub fn call(s: &mut Server, name: &str, args: &Map<String, Value>) -> R {
    match name {
        "search" => s.t_search(args),
        "read_note" => s.t_read_note(args),
        "list_notes" => s.t_list_notes(args),
        "backlinks" => s.t_backlinks(args),
        "outgoing_links" => s.t_outgoing_links(args),
        "tags" => s.t_tags(args),
        "properties" => s.t_properties(args),
        "create_note" => s.t_create_note(args),
        "edit_note" => s.t_edit_note(args),
        "append_note" => s.t_append_note(args),
        "set_property" => s.t_set_property(args),
        "rename_note" => s.t_rename_note(args),
        DAILY => s.t_daily_note(args),
        other => Err(ToolError::Unknown(format!("Unknown tool: {other}"))),
    }
}

// ---- text helpers ---------------------------------------------------------------------

/// A heading's section in `\n` text, as byte offsets.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Section {
    pub heading_start: usize,
    pub body_start: usize,
    pub end: usize,
}

fn heading_list(meta: &vault_types::CachedMetadata) -> String {
    let list: Vec<String> = meta.headings.iter().flatten().map(|h| format!("{} {}", "#".repeat(h.level as usize), h.heading)).collect();
    if list.is_empty() {
        "this note has no headings".into()
    } else {
        format!("headings in this note: {}", list.join(" | "))
    }
}

pub fn find_heading(text: &str, heading: &str) -> Result<Section, String> {
    let h = heading.trim().trim_start_matches('#').trim();
    if h.is_empty() {
        return Err("empty heading".into());
    }
    let meta = vault_ofm::parse(text);
    let lines = LineIndex::new(text);
    match vault_ofm::resolve_subpath(&meta, &format!("#{h}")) {
        Some(SubpathResult::Heading { current, end, .. }) => {
            let heading_start = lines.byte_of_u16(text, current.position.start.offset);
            let he = lines.byte_of_u16(text, current.position.end.offset);
            let body_start = text[he..].find('\n').map(|i| he + i + 1).unwrap_or(text.len());
            let end = end.map(|l| lines.byte_of_u16(text, l.offset)).unwrap_or(text.len()).max(body_start);
            Ok(Section { heading_start, body_start, end })
        }
        _ => Err(format!("heading not found: {h} ({})", heading_list(&meta))),
    }
}

/// Byte range of a `^id` block and the id as written.
pub fn find_block(text: &str, id: &str) -> Result<(usize, usize, String), String> {
    let id = id.trim().trim_start_matches('^');
    if id.is_empty() {
        return Err("empty block id".into());
    }
    let meta = vault_ofm::parse(text);
    let lines = LineIndex::new(text);
    match vault_ofm::resolve_subpath(&meta, &format!("#^{id}")) {
        Some(SubpathResult::Block { block, list, .. }) => {
            let pos = list.map(|l| l.position).unwrap_or(block.position);
            let start = lines.byte_of_u16(text, pos.start.offset);
            let end = lines.byte_of_u16(text, pos.end.offset);
            Ok((start, end, block.id))
        }
        _ => {
            let ids: Vec<String> = meta.blocks.iter().flat_map(|b| b.keys()).map(|k| format!("^{k}")).collect();
            Err(format!("block not found: ^{id} ({})", if ids.is_empty() { "this note has no block ids".into() } else { format!("block ids in this note: {}", ids.join(" ")) }))
        }
    }
}

/// Replaces a heading's body. Content starting with the heading line itself
/// replaces the heading too.
pub fn replace_section(text: &str, sec: Section, content: &str) -> String {
    let heading_line = text[sec.heading_start..sec.body_start].trim_end();
    let first_line = content.lines().next().unwrap_or("").trim_end();
    let from = if !heading_line.is_empty() && first_line == heading_line { sec.heading_start } else { sec.body_start };
    let mut body = content.to_string();
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    let original = &text[sec.body_start..sec.end];
    if sec.end < text.len() && original.ends_with("\n\n") && !body.ends_with("\n\n") {
        body.push('\n');
    }
    let mut prefix = text[..from].to_string();
    if !prefix.is_empty() && !prefix.ends_with('\n') {
        prefix.push('\n');
    }
    format!("{prefix}{body}{}", &text[sec.end..])
}

/// Inserts `content` at the end of `text[..at]`, before any blank lines that
/// separate it from what follows.
fn insert_at_end(text: &str, section_start: usize, at: usize, content: &str) -> String {
    let mut at = at;
    while at > section_start + 1 && text[..at].ends_with("\n\n") {
        at -= 1;
    }
    let mut piece = String::new();
    if at > 0 && !text[..at].ends_with('\n') {
        piece.push('\n');
    }
    piece.push_str(content);
    if !piece.ends_with('\n') {
        piece.push('\n');
    }
    format!("{}{piece}{}", &text[..at], &text[at..])
}

pub fn append_text(text: &str, heading: Option<&str>, content: &str) -> Result<String, String> {
    match heading {
        None => Ok(insert_at_end(text, 0, text.len(), content)),
        Some(h) => {
            let sec = find_heading(text, h)?;
            Ok(insert_at_end(text, sec.body_start.saturating_sub(1), sec.end, content))
        }
    }
}

/// The frontmatter's YAML region in `\n` text: (yaml start, yaml end = start
/// of the closing fence line).
fn frontmatter_region(text: &str) -> Option<(usize, usize)> {
    let first_end = text.find('\n')?;
    if text[..first_end].trim_end_matches([' ', '\t']) != "---" {
        return None;
    }
    let body = first_end + 1;
    let mut line_start = body;
    loop {
        let line_end = text[line_start..].find('\n').map(|i| line_start + i).unwrap_or(text.len());
        if text[line_start..line_end].trim_end_matches([' ', '\t']) == "---" {
            return Some((body, line_start));
        }
        if line_end >= text.len() {
            return None;
        }
        line_start = line_end + 1;
    }
}

/// JSON equality where numbers compare by value (YAML turns 1.0 into 1).
fn loose_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| loose_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| loose_eq(v, w))),
        _ => a == b,
    }
}

fn yaml_key_line(line: &str, name: &str) -> bool {
    [name.to_string(), format!("\"{name}\""), format!("'{name}'")].iter().any(|k| {
        line.strip_prefix(k.as_str()).is_some_and(|rest| {
            let rest = rest.trim_start_matches([' ', '\t']);
            rest == ":" || rest.starts_with(": ") || rest.starts_with(":\t")
        })
    })
}

/// Sets (or with `null`, removes) one frontmatter property, touching only
/// that property's lines when possible.
pub fn set_property_text(text: &str, name: &str, value: &Value) -> Result<String, String> {
    let fm = vault_ofm::parse_frontmatter(text);
    if let Some(e) = &fm.error {
        return Err(format!("the note's frontmatter is not valid YAML ({e}); fix it with edit_note first"));
    }
    let mut single = Map::new();
    single.insert(name.to_string(), value.clone());
    let entry = if value.is_null() { String::new() } else { vault_ofm::yaml_stringify(&Value::Object(single)) };
    let Some((ys, ye)) = frontmatter_region(text) else {
        if value.is_null() {
            return Ok(text.to_string());
        }
        return Ok(format!("---\n{entry}---\n{text}"));
    };
    let mut expected = fm.data.clone().unwrap_or_default();
    if value.is_null() {
        expected.shift_remove(name);
    } else {
        expected.insert(name.to_string(), value.clone());
    }
    let expected = Value::Object(expected);
    let check = |candidate: &str| {
        let f = vault_ofm::parse_frontmatter(candidate);
        f.error.is_none() && loose_eq(&Value::Object(f.data.unwrap_or_default()), &expected)
    };

    // 1. Line-level edit.
    let yaml = &text[ys..ye];
    let lines: Vec<&str> = yaml.split_inclusive('\n').collect();
    let mut new_yaml = String::new();
    match lines.iter().position(|l| yaml_key_line(l.trim_end_matches('\n'), name)) {
        Some(i) => {
            let mut j = i + 1;
            while j < lines.len() {
                let l = lines[j].trim_end_matches('\n');
                if l.trim().is_empty() || l.starts_with([' ', '\t']) || l == "-" || l.starts_with("- ") {
                    j += 1;
                } else {
                    break;
                }
            }
            while j > i + 1 && lines[j - 1].trim().is_empty() {
                j -= 1;
            }
            new_yaml.extend(lines[..i].iter().copied());
            new_yaml.push_str(&entry);
            new_yaml.extend(lines[j..].iter().copied());
        }
        None => {
            new_yaml.push_str(yaml);
            if !new_yaml.is_empty() && !new_yaml.ends_with('\n') {
                new_yaml.push('\n');
            }
            new_yaml.push_str(&entry);
        }
    }
    let candidate = format!("{}{new_yaml}{}", &text[..ys], &text[ye..]);
    if check(&candidate) {
        return Ok(candidate);
    }
    // 2. Rewrite the whole block, as Obsidian's processFrontMatter does.
    let whole = if expected.as_object().is_some_and(|m| m.is_empty()) { String::new() } else { vault_ofm::yaml_stringify(&expected) };
    let candidate = format!("{}{whole}{}", &text[..ys], &text[ye..]);
    if check(&candidate) {
        return Ok(candidate);
    }
    Err(format!("could not write property `{name}` so that it reads back identically; edit the frontmatter with edit_note instead"))
}

// ---- glob / dates ---------------------------------------------------------------------

pub fn glob_match(pattern: &str, path: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let target = if pattern.contains('/') { path } else { path.rsplit('/').next().unwrap_or(path) };
    let s: Vec<char> = target.to_lowercase().chars().collect();
    glob(&p, &s)
}

fn glob(p: &[char], s: &[char]) -> bool {
    match p.first() {
        None => s.is_empty(),
        Some('*') if p.get(1) == Some(&'*') => {
            let rest = &p[2..];
            if rest.first() == Some(&'/') {
                let rest = &rest[1..];
                glob(rest, s) || (0..s.len()).any(|i| s[i] == '/' && glob(rest, &s[i + 1..]))
            } else {
                (0..=s.len()).any(|i| glob(rest, &s[i..]))
            }
        }
        Some('*') => {
            let mut i = 0;
            loop {
                if glob(&p[1..], &s[i..]) {
                    return true;
                }
                if i >= s.len() || s[i] == '/' {
                    return false;
                }
                i += 1;
            }
        }
        Some('?') => !s.is_empty() && s[0] != '/' && glob(&p[1..], &s[1..]),
        Some(c) => !s.is_empty() && s[0] == *c && glob(&p[1..], &s[1..]),
    }
}

/// `2026-09-17T08:30:00Z` for epoch milliseconds.
pub fn iso_utc(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // civil_from_days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", tod / 3600, tod % 3600 / 60, tod % 60)
}

/// Epoch ms for `today`/`yesterday`/`tomorrow`/`YYYY-MM-DD` (that local day
/// at the current local time of day).
pub fn daily_ms(date: Option<&str>, now: f64, tz: i32) -> Result<f64, String> {
    const DAY: f64 = 86_400_000.0;
    match date.map(str::trim).unwrap_or("today") {
        "" | "today" => Ok(now),
        "yesterday" => Ok(now - DAY),
        "tomorrow" => Ok(now + DAY),
        d => {
            let parts: Vec<i64> = d.split('-').filter_map(|p| p.parse().ok()).collect();
            if parts.len() != 3 || !(1..=12).contains(&parts[1]) || !(1..=31).contains(&parts[2]) {
                return Err(format!("date must be today, yesterday, tomorrow or YYYY-MM-DD (got {d})"));
            }
            let time_of_day = (now + tz as f64 * 60_000.0).rem_euclid(DAY);
            Ok(crate::commands::days_from_civil(parts[0], parts[1], parts[2]) as f64 * DAY - tz as f64 * 60_000.0 + time_of_day)
        }
    }
}

// ---- the tools ------------------------------------------------------------------------------

impl Server {
    /// An existing file named by a client: exact path, path without `.md`,
    /// or link text.
    pub fn resolve_existing(&self, arg: &str) -> Result<String, String> {
        let rel = fsx::clean_rel(arg)?;
        let idx = &self.vault.index;
        let found = if idx.file(&rel).is_some() {
            Some(rel.clone())
        } else if idx.file(&format!("{rel}.md")).is_some() {
            Some(format!("{rel}.md"))
        } else {
            idx.resolve_link(&rel, "")
        };
        match found {
            Some(p) => {
                fsx::confined(&self.root, &p)?;
                Ok(p)
            }
            None => {
                let needle = rel.rsplit('/').next().unwrap_or(&rel).trim_end_matches(".md").to_lowercase();
                let similar: Vec<&str> = idx.note_paths().into_iter().filter(|p| p.to_lowercase().contains(&needle)).take(5).collect();
                let hint = if similar.is_empty() { "use search or list_notes to find it".to_string() } else { format!("did you mean: {}?", similar.join(", ")) };
                Err(format!("not found: {rel} ({hint})"))
            }
        }
    }

    fn resolve_note(&self, arg: &str) -> Result<String, String> {
        let p = self.resolve_existing(arg)?;
        if !Vault::is_note(&p) {
            return Err(format!("{p} is not a Markdown note"));
        }
        Ok(p)
    }

    fn read_file(&self, rel: &str) -> Result<TextFile, String> {
        fsx::read_text(&fsx::confined(&self.root, rel)?, rel)
    }

    fn write_file(&mut self, rel: &str, file: &TextFile) -> Result<(), String> {
        let full = fsx::confined(&self.root, rel)?;
        fsx::write_atomic(&full, rel, &file.encode())?;
        self.reindex(&[rel.to_string()]);
        Ok(())
    }

    /// A path for a note that is about to be created.
    fn new_note_path(&self, arg: &str) -> Result<String, String> {
        let mut rel = fsx::clean_rel(arg)?;
        if !rel.to_lowercase().ends_with(".md") {
            rel.push_str(".md");
        }
        let full = fsx::confined(&self.root, &rel)?;
        if full.symlink_metadata().is_ok() || self.vault.index.files().any(|f| f.path.eq_ignore_ascii_case(&rel)) {
            return Err(format!("already exists: {rel} (use edit_note or append_note to change it)"));
        }
        Ok(rel)
    }

    fn t_search(&self, args: &Map<String, Value>) -> R {
        let query = req_str(args, "query")?;
        if query.trim().is_empty() {
            return Err("`query` is empty".into());
        }
        let limit = opt_usize(args, "limit", 20, 1, 200)?;
        let per_file = opt_usize(args, "snippets_per_file", 3, 0, 20)?;
        let opts = SearchOptions { case_sensitive: opt_bool(args, "case_sensitive", false)?, limit: Some(limit), ..Default::default() };
        let res = self.vault.index.search(query, &opts);
        if let Some(e) = res.error {
            return Err(format!("invalid search query: {e}").into());
        }
        let results: Vec<Value> = res
            .results
            .iter()
            .map(|r| {
                let mut seen = Vec::new();
                let mut snippets = Vec::new();
                for m in &r.content_matches {
                    if snippets.len() >= per_file {
                        break;
                    }
                    if seen.contains(&m.line) {
                        continue;
                    }
                    seen.push(m.line);
                    let text: String = m.context.text.trim().chars().take(300).collect();
                    snippets.push(json!({ "line": m.line + 1, "text": text }));
                }
                let mut v = json!({ "path": r.path, "matches": r.match_count, "snippets": snippets });
                if !r.properties.is_empty() {
                    v["properties"] = serde_json::to_value(&r.properties).unwrap_or(Value::Null);
                }
                v
            })
            .collect();
        Ok(json_out(json!({
            "query": query, "fileCount": res.file_count, "matchCount": res.match_count,
            "returned": results.len(), "truncated": (res.file_count as usize) > results.len(), "results": results
        })))
    }

    fn t_read_note(&self, args: &Map<String, Value>) -> R {
        let path = self.resolve_note(req_str(args, "path")?)?;
        let heading = opt_str(args, "heading")?;
        let block = opt_str(args, "block")?;
        let file = self.read_file(&path)?;
        let text = match (heading, block) {
            (Some(_), Some(_)) => return Err("give either `heading` or `block`, not both".into()),
            (Some(h), None) => {
                let sec = find_heading(&file.text, h)?;
                file.text[sec.heading_start..sec.end].to_string()
            }
            (None, Some(b)) => {
                let (s, e, _) = find_block(&file.text, b)?;
                file.text[s..e].to_string()
            }
            (None, None) => file.text,
        };
        Ok(ToolOutput { text, structured: None })
    }

    fn t_list_notes(&self, args: &Map<String, Value>) -> R {
        let folder = match opt_str(args, "folder")? {
            Some(f) if !f.trim().trim_matches('/').is_empty() => Some(fsx::clean_rel(f)?),
            _ => None,
        };
        let glob = opt_str(args, "glob")?.filter(|g| !g.trim().is_empty());
        let limit = opt_usize(args, "limit", 200, 1, 5000)?;
        let sort = opt_str(args, "sort")?.unwrap_or("path");
        if sort != "path" && sort != "modified" {
            return Err("`sort` must be `path` or `modified`".into());
        }
        let attachments = opt_bool(args, "include_attachments", false)?;
        if let Some(f) = &folder {
            if !self.root.join(f).is_dir() {
                return Err(format!("folder not found: {f}").into());
            }
        }
        let mut files: Vec<&vault::DiskFile> = self
            .vault
            .files
            .iter()
            .filter(|f| attachments || Vault::is_note(&f.path))
            .filter(|f| folder.as_ref().is_none_or(|d| f.path.starts_with(&format!("{d}/"))))
            .filter(|f| glob.is_none_or(|g| glob_match(g.trim(), &f.path)))
            .collect();
        if sort == "modified" {
            files.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal).then(a.path.cmp(&b.path)));
        }
        let total = files.len();
        let list: Vec<Value> = files.iter().take(limit).map(|f| json!({ "path": f.path, "size": f.size, "modified": iso_utc(f.mtime) })).collect();
        Ok(json_out(json!({ "total": total, "returned": list.len(), "truncated": total > list.len(), "files": list })))
    }

    fn t_backlinks(&self, args: &Map<String, Value>) -> R {
        let path = self.resolve_existing(req_str(args, "path")?)?;
        let backlinks: Vec<Value> = self
            .vault
            .index
            .backlinks(&path)
            .iter()
            .map(|b| {
                let refs: Vec<Value> = b
                    .refs
                    .iter()
                    .map(|r| {
                        let mut v = json!({ "link": r.original });
                        match (r.position, &r.key) {
                            (Some(p), _) => v["line"] = json!(p.start.line + 1),
                            (None, Some(k)) => v["property"] = json!(k),
                            _ => {}
                        }
                        if let Some(c) = &r.context {
                            v["context"] = json!(c.text.trim().chars().take(300).collect::<String>());
                        }
                        v
                    })
                    .collect();
                json!({ "source": b.source, "references": refs })
            })
            .collect();
        Ok(json_out(json!({ "path": path, "count": backlinks.len(), "backlinks": backlinks })))
    }

    fn t_outgoing_links(&self, args: &Map<String, Value>) -> R {
        let path = self.resolve_note(req_str(args, "path")?)?;
        let counts = |m: BTreeMap<String, u32>| -> Vec<Value> { m.into_iter().map(|(t, n)| json!({ "target": t, "count": n })).collect() };
        let resolved = counts(self.vault.index.resolved_links().remove(&path).unwrap_or_default());
        let unresolved = counts(self.vault.index.unresolved_links().remove(&path).unwrap_or_default());
        Ok(json_out(json!({ "path": path, "resolved": resolved, "unresolved": unresolved })))
    }

    fn t_tags(&self, args: &Map<String, Value>) -> R {
        if let Some(p) = opt_str(args, "path")? {
            let path = self.resolve_note(p)?;
            let mut tags: Vec<String> = Vec::new();
            if let Some(note) = self.vault.index.note(&path) {
                for t in vault_index::tags::all_tags(&note.meta) {
                    let t = if t.starts_with('#') { t } else { format!("#{t}") };
                    if !tags.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
                        tags.push(t);
                    }
                }
            }
            return Ok(json_out(json!({ "path": path, "tags": tags })));
        }
        let mut list: Vec<(String, u32)> = self.vault.index.tags().into_iter().collect();
        list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));
        let tags: Vec<Value> = list.into_iter().map(|(t, n)| json!({ "tag": t, "count": n })).collect();
        Ok(json_out(json!({ "count": tags.len(), "tags": tags })))
    }

    fn t_properties(&self, args: &Map<String, Value>) -> R {
        if let Some(p) = opt_str(args, "path")? {
            let path = self.resolve_note(p)?;
            let file = self.read_file(&path)?;
            let fm = vault_ofm::parse_frontmatter(&file.text);
            if let Some(e) = fm.error {
                return Err(format!("{path}: frontmatter is not valid YAML: {e}").into());
            }
            return Ok(json_out(json!({ "path": path, "properties": fm.data.unwrap_or_default() })));
        }
        let mut counts: BTreeMap<String, u32> = BTreeMap::new();
        for p in self.vault.index.note_paths() {
            if let Some(fm) = self.vault.index.note(p).and_then(|n| n.meta.frontmatter.as_ref()) {
                for k in fm.keys() {
                    *counts.entry(k.clone()).or_default() += 1;
                }
            }
        }
        let mut list: Vec<(String, u32)> = counts.into_iter().collect();
        list.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let props: Vec<Value> = list.into_iter().map(|(k, n)| json!({ "name": k, "notes": n })).collect();
        Ok(json_out(json!({ "count": props.len(), "properties": props })))
    }

    fn t_create_note(&mut self, args: &Map<String, Value>) -> R {
        let rel = self.new_note_path(req_str(args, "path")?)?;
        let content = fsx::lf(opt_str(args, "content")?.unwrap_or(""));
        self.write_file(&rel, &TextFile::new(content))?;
        Ok(done(format!("Created {rel}"), json!({ "path": rel, "uri": note_uri(&rel), "created": true })))
    }

    fn t_edit_note(&mut self, args: &Map<String, Value>) -> R {
        let path = self.resolve_note(req_str(args, "path")?)?;
        let old = opt_str(args, "old_string")?;
        let new = opt_str(args, "new_string")?;
        let heading = opt_str(args, "heading")?;
        let block = opt_str(args, "block")?;
        let content = opt_str(args, "content")?;
        let mut file = self.read_file(&path)?;
        let string_mode = old.is_some() || new.is_some();
        let section_mode = heading.is_some() || block.is_some() || content.is_some();
        if string_mode && section_mode {
            return Err("choose one mode: `old_string` + `new_string`, or `heading` (or `block`) + `content` — not both".into());
        }
        let (updated, what) = if string_mode {
            let (Some(old), Some(new)) = (old, new) else {
                return Err("give both `old_string` and `new_string`".into());
            };
            let old = fsx::lf(old);
            if old.is_empty() {
                return Err("`old_string` is empty; to add text use append_note, or give heading + content".into());
            }
            match file.text.matches(old.as_str()).count() {
                1 => (file.text.replacen(old.as_str(), &fsx::lf(new), 1), "replaced 1 occurrence".to_string()),
                0 => {
                    let hint = if !old.trim().is_empty() && file.text.contains(old.trim()) {
                        " — the text exists with different surrounding whitespace; copy it exactly from read_note"
                    } else {
                        " — read the note again and copy the text exactly"
                    };
                    return Err(format!("old_string not found in {path}{hint}").into());
                }
                n => return Err(format!("old_string occurs {n} times in {path}; include more surrounding text so it matches exactly once").into()),
            }
        } else if section_mode {
            let Some(c) = content else {
                return Err("`content` is required with `heading` or `block`".into());
            };
            match (heading, block) {
                (Some(_), Some(_)) => return Err("give either `heading` or `block`, not both".into()),
                (Some(h), None) => {
                    let sec = find_heading(&file.text, h)?;
                    (replace_section(&file.text, sec, &fsx::lf(c)), format!("replaced section `{}`", h.trim().trim_start_matches('#').trim()))
                }
                (None, Some(b)) => {
                    let (s, e, id) = find_block(&file.text, b)?;
                    let mut c = fsx::lf(c).trim_end_matches('\n').to_string();
                    if !c.ends_with(&format!("^{id}")) {
                        c.push_str(&format!(" ^{id}"));
                    }
                    (format!("{}{c}{}", &file.text[..s], &file.text[e..]), format!("replaced block ^{id}"))
                }
                (None, None) => return Err("`content` needs a `heading` or `block` to replace; to add text use append_note".into()),
            }
        } else {
            return Err("choose one mode: `old_string` + `new_string`, or `heading` (or `block`) + `content`".into());
        };
        if updated == file.text {
            return Ok(done(format!("{path}: no changes"), json!({ "path": path, "changed": false })));
        }
        file.text = updated;
        self.write_file(&path, &file)?;
        Ok(done(format!("Edited {path}: {what}"), json!({ "path": path, "changed": true })))
    }

    fn t_append_note(&mut self, args: &Map<String, Value>) -> R {
        let arg = req_str(args, "path")?;
        let content = fsx::lf(req_str(args, "content")?);
        let heading = opt_str(args, "heading")?;
        match self.resolve_note(arg) {
            Ok(path) => {
                let mut file = self.read_file(&path)?;
                file.text = append_text(&file.text, heading, &content)?;
                self.write_file(&path, &file)?;
                Ok(done(format!("Appended to {path}"), json!({ "path": path, "created": false })))
            }
            Err(e) if opt_bool(args, "create_if_missing", false)? && self.vault.index.file(&fsx::clean_rel(arg)?).is_none() => {
                if heading.is_some() {
                    return Err(format!("{e}; cannot append under a heading of a note that does not exist").into());
                }
                let rel = self.new_note_path(arg)?;
                let text = append_text("", None, &content)?;
                self.write_file(&rel, &TextFile::new(text))?;
                Ok(done(format!("Created {rel}"), json!({ "path": rel, "created": true })))
            }
            Err(e) => Err(e.into()),
        }
    }

    fn t_set_property(&mut self, args: &Map<String, Value>) -> R {
        let path = self.resolve_note(req_str(args, "path")?)?;
        let name = req_str(args, "name")?.trim();
        if name.is_empty() || name.contains(['\n', '\r']) || name.starts_with(['#', '-', ' ']) {
            return Err("`name` must be a non-empty property name on one line".into());
        }
        let Some(value) = args.get("value") else {
            return Err("missing required argument `value` (use null to remove the property)".into());
        };
        let mut file = self.read_file(&path)?;
        let updated = set_property_text(&file.text, name, value)?;
        if updated == file.text {
            return Ok(done(format!("{path}: no changes"), json!({ "path": path, "changed": false })));
        }
        file.text = updated;
        self.write_file(&path, &file)?;
        let verb = if value.is_null() { "Removed" } else { "Set" };
        Ok(done(format!("{verb} property `{name}` in {path}"), json!({ "path": path, "changed": true })))
    }

    fn t_rename_note(&mut self, args: &Map<String, Value>) -> R {
        let old = self.resolve_existing(req_str(args, "path")?)?;
        let mut new = fsx::clean_rel(req_str(args, "new_path")?)?;
        if !new.contains('/') {
            if let Some((dir, _)) = old.rsplit_once('/') {
                new = format!("{dir}/{new}");
            }
        }
        if let Some((_, ext)) = old.rsplit_once('.').filter(|(stem, _)| !stem.ends_with('/') && !stem.is_empty()) {
            if !new.to_lowercase().ends_with(&format!(".{}", ext.to_lowercase())) {
                new = format!("{new}.{ext}");
            }
        }
        if new == old {
            return Err("the new path is the same as the old one".into());
        }
        let new_full = fsx::confined(&self.root, &new)?;
        let case_only = new.eq_ignore_ascii_case(&old);
        if !case_only && (new_full.symlink_metadata().is_ok() || self.vault.index.file(&new).is_some()) {
            return Err(format!("already exists: {new}").into());
        }
        let old_full = fsx::confined(&self.root, &old)?;
        if old_full.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("{old} is a symlink; refusing to move it").into());
        }
        let edits = self.vault.index.rename_edits(&old, &new, &RenameOptions { link_format: self.vault.link_format() });
        // Check every note to be rewritten before touching anything.
        let mut writes: Vec<(String, String)> = Vec::new();
        for e in &edits {
            let indexed = self.vault.text(&e.original_path);
            let full = fsx::confined(&self.root, &e.original_path)?;
            let bytes = std::fs::read(&full).map_err(|err| format!("{}: {err}", e.original_path))?;
            match std::str::from_utf8(&bytes) {
                Ok(s) if s == indexed => {}
                Ok(_) => return Err(format!("{} changed on disk while renaming; nothing was changed, try again", e.original_path).into()),
                Err(_) => return Err(format!("{} links to {old} but is not valid UTF-8; refusing to rewrite it (nothing was changed)", e.original_path).into()),
            }
            writes.push((e.path.clone(), vault_index::apply_edits(indexed, &e.edits)));
        }
        if let Some(parent) = new_full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{new}: cannot create folder: {e}"))?;
        }
        std::fs::rename(&old_full, &new_full).map_err(|e| format!("rename {old} → {new} failed: {e}"))?;
        let mut failed = Vec::new();
        for (path, text) in &writes {
            let full = fsx::confined(&self.root, path)?;
            if let Err(e) = fsx::write_atomic(&full, path, text.as_bytes()) {
                failed.push(e);
            }
        }
        let touched: Vec<String> = writes.iter().map(|(p, _)| p.clone()).chain([new.clone()]).collect();
        self.reindex(&touched);
        let links: usize = edits.iter().map(|e| e.edits.len()).sum();
        let updated: Vec<&String> = writes.iter().map(|(p, _)| p).collect();
        if !failed.is_empty() {
            return Err(format!("renamed {old} → {new}, but some link updates failed: {}", failed.join("; ")).into());
        }
        Ok(done(
            format!("Renamed {old} → {new}; updated {links} links in {} notes", updated.len()),
            json!({ "old_path": old, "new_path": new, "links_updated": links, "notes_updated": updated }),
        ))
    }

    fn t_daily_note(&mut self, args: &Map<String, Value>) -> R {
        let action = opt_str(args, "action")?.unwrap_or("read");
        if !["read", "create", "append"].contains(&action) {
            return Err("`action` must be read, create or append".into());
        }
        if action != "read" && self.read_only {
            return Err("the server is read-only; only action `read` is available".into());
        }
        let config_path = self.root.join(".obsidian/daily-notes.json");
        let cfg = if fsx::confined(&self.root, ".obsidian/daily-notes.json").is_ok() { vault::read_json(&config_path) } else { Map::new() };
        let get = |k: &str| cfg.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        let format = Some(get("format")).filter(|s| !s.is_empty()).unwrap_or_else(|| "YYYY-MM-DD".into());
        let folder = get("folder").trim_matches('/').to_string();
        let template = get("template");
        let tz = vault::local_offset_minutes();
        let ms = daily_ms(opt_str(args, "date")?, vault::now_ms(), tz)?;
        let dt = vault_clip::date::DateTime::from_epoch_ms(ms, tz);
        let name = vault_clip::date::format(&dt, &format);
        let rel = fsx::clean_rel(&if folder.is_empty() { format!("{name}.md") } else { format!("{folder}/{name}.md") })
            .map_err(|e| format!("the Daily notes settings give an invalid path: {e}"))?;
        let full = fsx::confined(&self.root, &rel)?;
        let exists = full.is_file();
        if action == "read" {
            if !exists {
                return Err(format!("the daily note {rel} does not exist yet{}", if self.read_only { "" } else { " (use action `create` or `append`)" }).into());
            }
            let file = self.read_file(&rel)?;
            return Ok(ToolOutput { text: format!("{rel}\n\n{}", file.text), structured: Some(json!({ "path": rel, "text": file.text })) });
        }
        let append = if action == "append" { Some(fsx::lf(req_str(args, "content")?)) } else { None };
        let mut created = false;
        if !exists {
            let body = if template.is_empty() {
                String::new()
            } else {
                let t = self.resolve_existing(&template).map_err(|e| format!("daily note template: {e}"))?;
                let tpl = self.read_file(&t)?;
                let (df, tf) = crate::commands::template_settings(&self.vault);
                let title = name.rsplit('/').next().unwrap_or(&name).to_string();
                crate::commands::apply_template(&tpl.text, &title, ms, tz, &df, &tf)
            };
            self.write_file(&rel, &TextFile::new(body))?;
            created = true;
        }
        if let Some(content) = append {
            let mut file = self.read_file(&rel)?;
            file.text = append_text(&file.text, None, &content)?;
            self.write_file(&rel, &file)?;
        }
        let file = self.read_file(&rel)?;
        let verb = match (created, action) {
            (true, "append") => "Created and appended to",
            (true, _) => "Created",
            (false, "append") => "Appended to",
            _ => "Already exists:",
        };
        Ok(ToolOutput { text: format!("{verb} {rel}\n\n{}", file.text), structured: Some(json!({ "path": rel, "created": created, "text": file.text })) })
    }
}
