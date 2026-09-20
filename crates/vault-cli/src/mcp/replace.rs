//! Vault-wide text rewriting: search-and-replace and tag rename.
//!
//! Both reproduce the app's own rules, so an agent changes a vault the same
//! way a person would:
//!
//! * `replace_in_vault` is the Search view's "Replace all"
//!   (`packages/app/src/core-plugins/global-search/replace.ts`). Every content
//!   match of the query is a candidate, and matches that sit in a link or
//!   embed target, a tag, a property name or a web address are **skipped**,
//!   because rewriting those breaks the vault rather than editing prose.
//! * `rename_tag` is the Tags pane's "Rename tag"
//!   (`packages/app/src/core-plugins/tag-pane/rename.ts`): case-insensitive
//!   match, child tags follow, frontmatter `tags:`/`tag:` rewritten and
//!   de-duplicated, and code, math and `%%comments%%` left alone.

use serde_json::{json, Map, Value};
use vault_types::CachedMetadata;

use super::fsx;
use super::tools::{annotations, done, opt_bool, opt_usize, req_str, tool};
use super::{Server, ToolError, ToolOutput};

type R = Result<ToolOutput, ToolError>;

pub const WRITE: &[&str] = &["replace_in_vault", "rename_tag"];

pub const REASON_LINK: &str = "inside a link target — move or rename the note instead";
pub const REASON_EMBED: &str = "inside an embed — move or rename the note instead";
pub const REASON_TAG: &str = "a tag — use rename_tag";
pub const REASON_PROPERTY: &str = "a property name — rename it with set_property";
pub const REASON_URL: &str = "inside a web address";

pub fn write_definitions() -> Vec<Value> {
    vec![
        tool(
            "replace_in_vault",
            "Search and replace across the vault",
            "Replace text across every note that matches a search query — the app's \"Replace all\" in the Search view. **It previews by default**: without `apply: true` nothing is written and you get the exact before/after lines, so read the preview before applying. Matches that would break the vault are skipped and reported with a reason: link and embed targets, tags, property names and web addresses. Plain words with no search syntax are treated as the phrase you typed (`Acme Corp` replaces `Acme Corp`, not each word). When the query contains a `/regex/` term the replacement may use `$1`, `${name}` and `${0}` for the whole match; otherwise it is literal. There is no undo, so apply only what the preview shows.",
            json!({
                "query": { "type": "string", "description": "Obsidian search query selecting what to replace, e.g. `\"Acme Corp\"` or `path:Journal /v(\\d+)/`." },
                "replacement": { "type": "string", "description": "Text each match becomes (may be empty to delete)." },
                "apply": { "type": "boolean", "default": false, "description": "false (default) previews only. true writes the files shown in the preview." },
                "case_sensitive": { "type": "boolean", "default": false },
                "include_links_and_tags": { "type": "boolean", "default": false, "description": "Also replace inside link targets, embeds, tags, property names and URLs. Off by default because it breaks links." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50, "description": "Maximum number of files to change or preview." }
            }),
            &["query", "replacement"],
            annotations("Search and replace across the vault", false, true, false),
        ),
        tool(
            "rename_tag",
            "Rename a tag",
            "Rename a tag everywhere in the vault, as the Tags pane does: inline `#tags` in note bodies and `tags:`/`tag:` values in YAML frontmatter, in every note. Matching ignores case, and child tags follow (`#project` → `#work` also moves `#project/alpha` to `#work/alpha`). Tags inside code blocks, math and `%%comments%%` are left alone. Renaming to a tag that already exists merges them and removes the duplicates. Preview with `dry_run: true` first; there is no undo.",
            json!({
                "from": { "type": "string", "description": "Existing tag, with or without the leading #, e.g. `project` or `#project`." },
                "to": { "type": "string", "description": "New tag name. No spaces; `-`, `_` and `/` are allowed; it cannot be only digits." },
                "dry_run": { "type": "boolean", "default": false, "description": "Report the notes and counts that would change, without writing." }
            }),
            &["from", "to"],
            annotations("Rename a tag", false, true, false),
        ),
    ]
}

pub fn call(s: &mut Server, name: &str, a: &Map<String, Value>) -> R {
    match name {
        "replace_in_vault" => t_replace_in_vault(s, a),
        "rename_tag" => t_rename_tag(s, a),
        other => Err(ToolError::Unknown(format!("Unknown tool: {other}"))),
    }
}

// ---- protected ranges ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Protected {
    pub start: usize,
    pub end: usize,
    pub reason: &'static str,
}

/// The target spans of a link as written: everything that is not display
/// text. `s`/`e` are the byte range of `original` in the file.
fn link_target_spans(original: &str, s: usize, e: usize) -> Vec<(usize, usize)> {
    if original.starts_with("[[") {
        return match original.find('|') {
            None => vec![(s, e)],
            Some(bar) => vec![(s, s + bar + 1), (e.saturating_sub(2), e)],
        };
    }
    if let Some(mid) = original.rfind("](") {
        if original.starts_with('[') && mid > 0 {
            return vec![(s, s + 1), (s + mid, e)];
        }
    }
    vec![(s, e)]
}

fn is_url_scheme(word: &str) -> bool {
    matches!(word, "http" | "https" | "ftp" | "file" | "mailto" | "obsidian")
}

/// Web addresses, which no metadata cache records.
fn url_ranges(text: &str, out: &mut Vec<Protected>) {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b':' {
            i += 1;
            continue;
        }
        // Walk back over the scheme.
        let mut s = i;
        while s > 0 && b[s - 1].is_ascii_alphabetic() {
            s -= 1;
        }
        let scheme = text[s..i].to_lowercase();
        let boundary = s == 0 || !(b[s - 1].is_ascii_alphanumeric() || b[s - 1] == b'_');
        if !boundary || !is_url_scheme(&scheme) {
            i += 1;
            continue;
        }
        let mut e = i + 1;
        if text[e..].starts_with("//") {
            e += 2;
        }
        while e < b.len() && !b" \t\r\n<>()[]\"'`".contains(&b[e]) {
            e += 1;
        }
        if e > i + 1 {
            out.push(Protected { start: s, end: e, reason: REASON_URL });
        }
        i = e.max(i + 1);
    }
}

/// The key of a top-level YAML line (`name: value`), as the app's rule reads
/// it: the line must not start with whitespace, `#`, `:` or `-`, and the
/// colon must be followed by whitespace or end of line.
pub fn yaml_top_key(line: &str) -> Option<(&str, usize)> {
    let first = line.chars().next()?;
    if first.is_whitespace() || first == '#' || first == ':' || first == '-' {
        return None;
    }
    let colon = line.char_indices().find(|(i, c)| {
        *c == ':' && line[i + 1..].chars().next().is_none_or(|n| n.is_whitespace())
    })?;
    let key = line[..colon.0].trim_end();
    if key.is_empty() {
        return None;
    }
    Some((key, colon.0 + 1))
}

/// Byte ranges of `text` a vault replace must not rewrite by default.
pub fn protected_ranges(meta: &CachedMetadata, text: &str, byte: &dyn Fn(u32) -> usize) -> Vec<Protected> {
    let mut out: Vec<Protected> = Vec::new();
    let mut add = |start: usize, end: usize, reason: &'static str| {
        if end > start && end <= text.len() {
            out.push(Protected { start, end, reason });
        }
    };
    for l in meta.links.iter().flatten() {
        let (s, e) = (byte(l.position.start.offset), byte(l.position.end.offset));
        let original = text.get(s..e).unwrap_or(&l.original);
        for (a, b) in link_target_spans(original, s, e) {
            add(a, b, REASON_LINK);
        }
    }
    for l in meta.embeds.iter().flatten() {
        add(byte(l.position.start.offset), byte(l.position.end.offset), REASON_EMBED);
    }
    for t in meta.tags.iter().flatten() {
        add(byte(t.position.start.offset), byte(t.position.end.offset), REASON_TAG);
    }
    if let Some(p) = meta.frontmatter_position {
        let (fs, fe) = (byte(p.start.offset), byte(p.end.offset));
        if fs < fe && fe <= text.len() {
            let mut offset = fs;
            let mut key = String::new();
            for line in text[fs..fe].split('\n') {
                let mut value_from = 0;
                if line != "---" {
                    if let Some((k, after)) = yaml_top_key(line) {
                        key = k.trim_matches(['"', '\'']).to_lowercase();
                        add(offset, offset + k.len(), REASON_PROPERTY);
                        value_from = after;
                    }
                }
                if (key == "tags" || key == "tag") && line != "---" {
                    for (s, e) in yaml_tag_tokens(&line[value_from.min(line.len())..]) {
                        add(offset + value_from + s, offset + value_from + e, REASON_TAG);
                    }
                }
                for (s, e) in wikilinks(line) {
                    for (a, b) in link_target_spans(&line[s..e], offset + s, offset + e) {
                        add(a, b, REASON_LINK);
                    }
                }
                offset += line.len() + 1;
            }
        }
    }
    url_ranges(text, &mut out);
    out.sort_by_key(|p| p.start);
    out
}

/// `[[…]]` spans on one line.
fn wikilinks(line: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let b = line.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'[' && b[i + 1] == b'[' {
            if let Some(j) = line[i + 2..].find("]]").map(|j| i + 2 + j + 2) {
                if !line[i + 2..j - 2].contains('\n') {
                    out.push((i, j));
                    i = j;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// Tag-ish tokens in a YAML `tags:` value (`[^\s,\[\]"'\-][^,\[\]"'\s]*`).
fn yaml_tag_tokens(value: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let b = value.as_bytes();
    let mut i = 0;
    let stop = |c: u8| b" \t\r\n,[]\"'".contains(&c);
    while i < b.len() {
        if stop(b[i]) || b[i] == b'-' {
            i += 1;
            continue;
        }
        let s = i;
        while i < b.len() && !stop(b[i]) {
            i += 1;
        }
        out.push((s, i));
    }
    out
}

/// The first reason covering `[start, end)`, if any.
fn protection_for(ranges: &[Protected], start: usize, end: usize) -> Option<&'static str> {
    for r in ranges {
        if r.start >= end {
            break;
        }
        if r.end > start {
            return Some(r.reason);
        }
    }
    None
}

// ---- replace ---------------------------------------------------------------------------

/// `/pattern/` terms of a search query, as their source strings.
pub fn regex_terms(query: &str) -> Vec<String> {
    let b = query.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'/' {
            i += 1;
            continue;
        }
        let before_ok = i == 0 || b" \t\n(:-".contains(&b[i - 1]);
        if !before_ok {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut src = String::new();
        let mut closed = false;
        while j < b.len() {
            match b[j] {
                b'\\' if j + 1 < b.len() => {
                    src.push_str(&query[j..j + 2]);
                    j += 2;
                }
                b'/' => {
                    closed = true;
                    break;
                }
                b'\n' => break,
                _ => {
                    let ch = query[j..].chars().next().unwrap();
                    src.push(ch);
                    j += ch.len_utf8();
                }
            }
        }
        if closed && !src.is_empty() {
            out.push(src);
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// The query a replace searches with: plain words become the phrase the user
/// typed, so `Acme Corp` is replaced as one string.
pub fn replace_query(query: &str) -> String {
    let q = query.trim();
    if !q.contains(char::is_whitespace) {
        return q.to_string();
    }
    let has_operator = q.contains(['"', '/', '(', ')', ':', '[', ']'])
        || q.split_whitespace().any(|w| w == "OR")
        || q.starts_with('-') && q.len() > 1 && !q[1..].starts_with(char::is_whitespace)
        || q.split_whitespace().any(|w| w.len() > 1 && w.starts_with('-'));
    if has_operator {
        return q.to_string();
    }
    format!("\"{}\"", q.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// JavaScript replacement syntax → the `regex_lite` equivalent.
fn js_replacement(rep: &str) -> String {
    let mut out = String::with_capacity(rep.len());
    let mut rest = rep;
    while let Some(i) = rest.find('$') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        if let Some(r) = rest.strip_prefix("$&") {
            out.push_str("${0}");
            rest = r;
        } else if let Some(r) = rest.strip_prefix("$<") {
            match r.find('>') {
                Some(j) => {
                    out.push_str(&format!("${{{}}}", &r[..j]));
                    rest = &r[j + 1..];
                }
                None => {
                    out.push_str("$<");
                    rest = r;
                }
            }
        } else {
            out.push('$');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

/// A function from matched text to its replacement, as the app builds it.
struct Replacer {
    /// Anchored `^(?:term)$` forms of the query's `/regex/` terms.
    terms: Vec<vault_index::search::parser::RegexTerm>,
    case_sensitive: bool,
    replacement: String,
    expanded: String,
}

impl Replacer {
    fn new(query: &str, replacement: &str, case_sensitive: bool) -> Replacer {
        let terms = regex_terms(query)
            .iter()
            .filter_map(|src| vault_index::search::parser::compile_regex(&format!("^(?:{src})$")).ok())
            .collect();
        Replacer { terms, case_sensitive, replacement: replacement.to_string(), expanded: js_replacement(replacement) }
    }

    fn apply(&self, matched: &str) -> String {
        for t in &self.terms {
            let re = if self.case_sensitive { t.sensitive.as_ref() } else { t.insensitive.as_ref() };
            if let Some(re) = re {
                if re.is_match(matched) {
                    return re.replace(matched, self.expanded.as_str()).into_owned();
                }
            }
        }
        self.replacement.clone()
    }
}

struct Change {
    start: usize,
    end: usize,
    text: String,
    replacement: String,
}

fn apply_changes(text: &str, changes: &[Change]) -> String {
    let mut out = text.to_string();
    for c in changes.iter().rev() {
        out.replace_range(c.start..c.end, &c.replacement);
    }
    out
}

fn t_replace_in_vault(s: &mut Server, a: &Map<String, Value>) -> R {
    let raw_query = req_str(a, "query")?;
    if raw_query.trim().is_empty() {
        return Err("`query` is empty".into());
    }
    let replacement = fsx::lf(req_str(a, "replacement")?);
    let apply = opt_bool(a, "apply", false)?;
    let case_sensitive = opt_bool(a, "case_sensitive", false)?;
    let include_protected = opt_bool(a, "include_links_and_tags", false)?;
    let limit = opt_usize(a, "limit", 50, 1, 500)?;
    let query = replace_query(raw_query);
    let opts = vault_index::SearchOptions { case_sensitive, ..Default::default() };
    let res = s.vault.index.search(&query, &opts);
    if let Some(e) = res.error {
        return Err(format!("invalid search query: {e}").into());
    }
    let replacer = Replacer::new(&query, &replacement, case_sensitive);

    let mut files: Vec<Value> = Vec::new();
    let mut plans: Vec<(String, String, String)> = Vec::new(); // path, before, after
    let (mut total, mut skipped_total) = (0usize, 0usize);
    let mut skipped_examples: Vec<Value> = Vec::new();
    for r in &res.results {
        let Some(note) = s.vault.index.note(&r.path) else { continue };
        let text = note.text.clone();
        let byte = |o: u32| note.byte(o);
        let ranges = if include_protected { Vec::new() } else { protected_ranges(&note.meta, &text, &byte) };
        let mut changes: Vec<Change> = Vec::new();
        let mut last_end = 0usize;
        let mut ordered: Vec<(usize, usize)> = r.content_matches.iter().map(|m| (byte(m.start), byte(m.end))).collect();
        ordered.sort_by_key(|(s, _)| *s);
        for (start, end) in ordered {
            if start < last_end || end <= start || end > text.len() || !text.is_char_boundary(start) || !text.is_char_boundary(end) {
                continue;
            }
            last_end = end;
            let matched = text[start..end].to_string();
            if let Some(reason) = protection_for(&ranges, start, end) {
                skipped_total += 1;
                if skipped_examples.len() < 10 {
                    let line = text[..start].matches('\n').count() + 1;
                    skipped_examples.push(json!({ "path": r.path, "line": line, "text": matched, "reason": reason }));
                }
                continue;
            }
            let rep = replacer.apply(&matched);
            if rep == matched {
                continue;
            }
            changes.push(Change { start, end, text: matched, replacement: rep });
        }
        if changes.is_empty() {
            continue;
        }
        if files.len() >= limit {
            break;
        }
        total += changes.len();
        let after = apply_changes(&text, &changes);
        files.push(json!({
            "path": r.path,
            "replacements": changes.len(),
            "diff": diff_lines(&text, &changes),
        }));
        plans.push((r.path.clone(), text, after));
    }

    let truncated = res.results.iter().filter(|r| !r.content_matches.is_empty()).count() > files.len();
    let mut out = json!({
        "query": query, "replacement": replacement, "applied": apply,
        "files": files.len(), "replacements": total,
        "skipped": skipped_total, "skipped_examples": skipped_examples,
        "truncated": truncated, "changes": files
    });
    if !apply {
        out["next_step"] = json!("call again with apply: true to write these files");
        let text = format!(
            "Preview only — nothing was written. {total} replacement(s) in {} note(s){}. Call again with apply: true to write them.",
            plans.len(),
            if skipped_total > 0 { format!("; {skipped_total} match(es) skipped because they are links, tags, property names or URLs") } else { String::new() }
        );
        return Ok(done(text, out));
    }
    // Every file must still be exactly what the preview was computed from.
    let mut written: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    for (path, before, after) in &plans {
        let full = fsx::confined(&s.root, path)?;
        let file = match fsx::read_text(&full, path) {
            Ok(f) => f,
            Err(e) => {
                failed.push(e);
                continue;
            }
        };
        if &file.text != before {
            failed.push(format!("{path} changed on disk since the preview and was left alone"));
            continue;
        }
        let new = super::fsx::TextFile { text: after.clone(), bom: file.bom, crlf: file.crlf };
        match fsx::write_atomic(&full, path, &new.encode()) {
            Ok(()) => written.push(path.clone()),
            Err(e) => failed.push(e),
        }
    }
    s.reindex(&written);
    out["files_written"] = json!(written);
    out["problems"] = json!(failed);
    let text = format!(
        "Replaced {total} occurrence(s) in {} note(s){}{}",
        written.len(),
        if skipped_total > 0 { format!("; skipped {skipped_total} link/tag/property/URL match(es)") } else { String::new() },
        if failed.is_empty() { String::new() } else { format!("; {} problem(s): {}", failed.len(), failed.join("; ")) }
    );
    Ok(done(text, out))
}

/// A `- old` / `+ new` preview of the lines a set of changes touches.
fn diff_lines(text: &str, changes: &[Change]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen: Vec<usize> = Vec::new();
    for c in changes.iter().take(20) {
        let line_no = text[..c.start].matches('\n').count();
        if seen.contains(&line_no) {
            continue;
        }
        seen.push(line_no);
        let start = text[..c.start].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let end = text[c.end..].find('\n').map(|i| c.end + i).unwrap_or(text.len());
        let before: String = text[start..end].chars().take(400).collect();
        let on_line: Vec<&Change> = changes.iter().filter(|x| x.start >= start && x.end <= end).collect();
        let mut after = text[start..end].to_string();
        for x in on_line.iter().rev() {
            after.replace_range(x.start - start..x.end - start, &x.replacement);
        }
        out.push(json!({
            "line": line_no + 1,
            "before": before,
            "after": after.chars().take(400).collect::<String>(),
            "matched": c.text,
        }));
    }
    out
}

// ---- rename_tag ------------------------------------------------------------------------

pub fn tag_char(c: char) -> bool {
    !c.is_whitespace() && !"#!\"$%&'()*+,.:;<=>?@[]^`{|}~\\".contains(c)
}

pub fn normalize_tag(t: &str) -> String {
    t.trim().trim_start_matches('#').to_string()
}

pub fn is_valid_tag_name(t: &str) -> bool {
    !t.is_empty() && t.chars().all(tag_char) && !t.chars().all(|c| c.is_ascii_digit()) && !t.split('/').any(str::is_empty)
}

/// `#old` → `#new`, with child tags following and their own casing kept.
pub fn map_tag(tag: &str, from: &str, to: &str) -> Option<String> {
    let (lt, lf) = (tag.to_lowercase(), from.to_lowercase());
    if lt == lf {
        return Some(to.to_string());
    }
    if lt.starts_with(&format!("{lf}/")) {
        return Some(format!("{to}{}", &tag[from.len()..]));
    }
    None
}

/// Byte ranges of the body that a tag scan must ignore: fenced code blocks,
/// `$$` math blocks, inline code spans and `%%comments%%`.
fn masked_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut math = false;
    let mut comment: Option<usize> = None;
    let mut offset = 0usize;
    for line in text.split('\n') {
        let end = offset + line.len();
        let trimmed = line.trim();
        let fence_char = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        let run = fence_char.map(|c| trimmed.chars().take_while(|x| *x == c).count()).unwrap_or(0);
        match fence {
            Some((c, len)) => {
                out.push((offset, end + 1));
                if fence_char == Some(c) && run >= len && trimmed.chars().all(|x| x == c) {
                    fence = None;
                }
                offset = end + 1;
                continue;
            }
            None => {
                if run >= 3 {
                    fence = Some((fence_char.unwrap(), run));
                    out.push((offset, end + 1));
                    offset = end + 1;
                    continue;
                }
            }
        }
        if trimmed == "$$" {
            math = !math;
            out.push((offset, end + 1));
            offset = end + 1;
            continue;
        }
        if math {
            out.push((offset, end + 1));
            offset = end + 1;
            continue;
        }
        // Inline code spans and %% comments %% on this line.
        let b = line.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if let Some(start) = comment {
                let Some(j) = line[i..].find("%%") else { break };
                out.push((start.max(offset), offset + i + j + 2));
                comment = None;
                i += j + 2;
                continue;
            }
            if b[i] == b'%' && b.get(i + 1) == Some(&b'%') {
                comment = Some(offset + i);
                i += 2;
                continue;
            }
            if b[i] == b'`' {
                let ticks = b[i..].iter().take_while(|c| **c == b'`').count();
                let close = line[i + ticks..].find(&"`".repeat(ticks));
                match close {
                    Some(j) => {
                        let stop = i + ticks + j + ticks;
                        out.push((offset + i, offset + stop));
                        i = stop;
                    }
                    None => i += ticks,
                }
                continue;
            }
            i += 1;
        }
        if let Some(start) = comment {
            out.push((start.max(offset), end + 1));
        }
        offset = end + 1;
    }
    out
}

fn masked(ranges: &[(usize, usize)], at: usize) -> bool {
    ranges.iter().any(|(s, e)| *s <= at && at < *e)
}

/// The frontmatter block of `text`: `(yaml start, end of the closing fence
/// line)`.
fn frontmatter_span(text: &str) -> Option<(usize, usize)> {
    let first = text.find('\n')?;
    if text[..first].trim_end() != "---" {
        return None;
    }
    let mut line_start = first + 1;
    loop {
        let line_end = text[line_start..].find('\n').map(|i| line_start + i).unwrap_or(text.len());
        let t = text[line_start..line_end].trim_end();
        if t == "---" || t == "..." {
            return Some((first + 1, line_end.min(text.len())));
        }
        if line_end >= text.len() {
            return None;
        }
        line_start = line_end + 1;
    }
}

/// Renames a tag in one note's text; returns the new text and how many tags
/// changed.
pub fn rename_tag_in_text(text: &str, from: &str, to: &str) -> (String, usize) {
    let mut count = 0usize;
    let (fm_start, fm_end) = frontmatter_span(text).unwrap_or((0, 0));
    let mut out = String::with_capacity(text.len());
    if fm_end > fm_start {
        out.push_str(&text[..fm_start]);
        let (yaml, n) = rename_tag_in_frontmatter(&text[fm_start..fm_end], from, to);
        count += n;
        out.push_str(&yaml);
    }
    let body_start = if fm_end > fm_start { fm_end } else { 0 };
    let body = &text[body_start..];
    let masks = masked_ranges(body);
    let b = body.as_bytes();
    let mut i = 0usize;
    let mut last = 0usize;
    while i < b.len() {
        if b[i] != b'#' || masked(&masks, i) {
            i += 1;
            continue;
        }
        let before_ok = i == 0 || {
            let c = body[..i].chars().next_back().unwrap();
            c.is_whitespace() || "([{>,;!?\"'".contains(c)
        };
        if !before_ok {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < b.len() {
            let Some(c) = body[j..].chars().next() else { break };
            if !tag_char(c) {
                break;
            }
            j += c.len_utf8();
        }
        let tag = &body[i + 1..j];
        if tag.is_empty() || tag.chars().all(|c| c.is_ascii_digit()) {
            i = j.max(i + 1);
            continue;
        }
        match map_tag(tag, from, to) {
            Some(new) => {
                out.push_str(&body[last..i]);
                out.push('#');
                out.push_str(&new);
                count += 1;
                last = j;
                i = j;
            }
            None => i = j.max(i + 1),
        }
    }
    out.push_str(&body[last..]);
    (out, count)
}

/// Rewrites `tags:` / `tag:` values in a frontmatter block.
fn rename_tag_in_frontmatter(yaml: &str, from: &str, to: &str) -> (String, usize) {
    let mut count = 0usize;
    let mut lines: Vec<String> = yaml.split('\n').map(str::to_string).collect();
    let mut i = 0usize;
    while i < lines.len() {
        let key_is_tags = yaml_top_key(&lines[i])
            .map(|(k, _)| {
                let k = k.trim_matches(['"', '\'']).to_lowercase();
                k == "tags" || k == "tag"
            })
            .unwrap_or(false);
        if !key_is_tags {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i + 1;
        while end < lines.len() {
            let l = &lines[end];
            let continuation = (l.starts_with([' ', '\t']) && !l.trim().is_empty()) || l.trim_start().starts_with("- ") || l.trim() == "-";
            if !continuation {
                break;
            }
            end += 1;
        }
        for line in lines.iter_mut().take(end).skip(start) {
            let (new, n) = rename_tag_in_yaml_line(line, from, to, line_is_key(line));
            *line = new;
            count += n;
        }
        dedupe_tag_block(&mut lines, start, end);
        i = end;
    }
    (lines.join("\n"), count)
}

fn line_is_key(line: &str) -> Option<usize> {
    yaml_top_key(line).map(|(_, after)| after)
}

/// Rewrites tag tokens in one YAML line, keeping an optional leading `#`.
fn rename_tag_in_yaml_line(line: &str, from: &str, to: &str, value_from: Option<usize>) -> (String, usize) {
    let from_start = value_from.unwrap_or(0);
    let (head, value) = line.split_at(from_start.min(line.len()));
    let mut out = String::from(head);
    let mut count = 0usize;
    let mut last = 0usize;
    for (s, e) in yaml_tag_tokens(value) {
        let token = &value[s..e];
        let (hash, bare) = match token.strip_prefix('#') {
            Some(rest) => ("#", rest),
            None => ("", token),
        };
        if let Some(new) = map_tag(bare, from, to) {
            out.push_str(&value[last..s]);
            out.push_str(hash);
            out.push_str(&new);
            count += 1;
            last = e;
        }
    }
    out.push_str(&value[last..]);
    (out, count)
}

/// After a merge, drop duplicate entries from a tags list.
fn dedupe_tag_block(lines: &mut Vec<String>, start: usize, end: usize) {
    let norm = |s: &str| s.trim().trim_matches(['"', '\'']).trim_start_matches('#').to_lowercase();
    // Flow list on the key line: `tags: [a, b]`.
    if let Some(after) = line_is_key(&lines[start]) {
        let value = lines[start][after..].to_string();
        let t = value.trim();
        if let Some(inner) = t.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
            let mut seen: Vec<String> = Vec::new();
            let mut kept: Vec<&str> = Vec::new();
            for item in inner.split(',') {
                let key = norm(item);
                if key.is_empty() || seen.contains(&key) {
                    continue;
                }
                seen.push(key);
                kept.push(item.trim());
            }
            let leading = &value[..value.len() - value.trim_start().len()];
            lines[start] = format!("{}{leading}[{}]", &lines[start][..after], kept.join(", "));
            return;
        }
    }
    // Block list: `- tag` items below the key.
    let mut seen: Vec<String> = Vec::new();
    let mut drop: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate().take(end).skip(start + 1) {
        let t = line.trim();
        let Some(item) = t.strip_prefix("- ") else { continue };
        let key = norm(item);
        if key.is_empty() {
            continue;
        }
        if seen.contains(&key) {
            drop.push(i);
        } else {
            seen.push(key);
        }
    }
    for i in drop.into_iter().rev() {
        lines.remove(i);
    }
}

fn t_rename_tag(s: &mut Server, a: &Map<String, Value>) -> R {
    let from = normalize_tag(req_str(a, "from")?);
    let to = normalize_tag(req_str(a, "to")?);
    if !is_valid_tag_name(&from) {
        return Err(format!("`from` is not a tag name: {from:?} — tags cannot contain spaces or punctuation other than - _ /, and cannot be only digits").into());
    }
    if !is_valid_tag_name(&to) {
        return Err(format!("`to` is not a tag name: {to:?} — tags cannot contain spaces or punctuation other than - _ /, and cannot be only digits").into());
    }
    if from == to {
        return Err("`from` and `to` are the same tag".into());
    }
    let dry = opt_bool(a, "dry_run", false)?;
    let existing = s.vault.index.tags();
    if !existing.keys().any(|t| map_tag(t.trim_start_matches('#'), &from, &from).is_some()) {
        let similar: Vec<&String> = existing.keys().filter(|t| t.to_lowercase().contains(&from.to_lowercase())).take(5).collect();
        return Err(format!(
            "no note uses #{from}{}",
            if similar.is_empty() { " (use the `tags` tool to list the vault's tags)".to_string() } else { format!(" — did you mean {}?", similar.iter().map(|t| t.as_str()).collect::<Vec<_>>().join(", ")) }
        )
        .into());
    }
    let merges = existing.keys().any(|t| {
        let t = t.trim_start_matches('#');
        t.eq_ignore_ascii_case(&to) || t.to_lowercase().starts_with(&format!("{}/", to.to_lowercase()))
    });
    let mut plans: Vec<(String, String, String, usize)> = Vec::new();
    for path in s.vault.index.note_paths() {
        let text = s.vault.text(path);
        let (new, n) = rename_tag_in_text(text, &from, &to);
        if n > 0 && new != text {
            plans.push((path.to_string(), text.to_string(), new, n));
        }
    }
    let total: usize = plans.iter().map(|p| p.3).sum();
    let listed: Vec<Value> = plans.iter().take(100).map(|(p, _, _, n)| json!({ "path": p, "tags": n })).collect();
    let mut out = json!({
        "from": format!("#{from}"), "to": format!("#{to}"),
        "notes": plans.len(), "tags": total, "merges_into_existing_tag": merges,
        "changes": listed, "applied": !dry
    });
    if dry {
        return Ok(done(
            format!("Preview only — nothing was written. #{from} → #{to} would change {total} tag(s) in {} note(s).{}", plans.len(), if merges { " It would merge into the existing tag #".to_string() + &to + "." } else { String::new() }),
            out,
        ));
    }
    let mut written = Vec::new();
    let mut failed = Vec::new();
    for (path, before, after, _) in &plans {
        let full = fsx::confined(&s.root, path)?;
        match fsx::read_text(&full, path) {
            Ok(f) if &f.text == before => {
                let new = fsx::TextFile { text: after.clone(), bom: f.bom, crlf: f.crlf };
                match fsx::write_atomic(&full, path, &new.encode()) {
                    Ok(()) => written.push(path.clone()),
                    Err(e) => failed.push(e),
                }
            }
            Ok(_) => failed.push(format!("{path} changed on disk and was left alone")),
            Err(e) => failed.push(e),
        }
    }
    s.reindex(&written);
    out["notes_written"] = json!(written.len());
    out["problems"] = json!(failed);
    Ok(done(
        format!(
            "Renamed #{from} → #{to}: {total} tag(s) in {} note(s){}",
            written.len(),
            if failed.is_empty() { String::new() } else { format!("; {} problem(s): {}", failed.len(), failed.join("; ")) }
        ),
        out,
    ))
}
