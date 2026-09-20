//! Vault operations beyond one note's text: moving, the `.trash`, folders,
//! unlinked mentions, vault statistics, periodic notes, and the URL that
//! opens a note in the app.

use std::collections::{BTreeMap, HashSet};
use std::fs;

use serde_json::{json, Map, Value};
use vault_index::RenameOptions;

use super::fsx::{self, TextFile};
use super::tools::{
    annotations, append_text, done, iso_utc, json_out, opt_bool, opt_str, opt_usize, req_str, tool,
    PATH_DESC,
};
use super::{Server, ToolError, ToolOutput};
use crate::vault::{self, Vault};

type R = Result<ToolOutput, ToolError>;

/// The app's local trash folder (`.trash` at the vault root).
pub const TRASH: &str = ".trash";

pub const READ: &[&str] = &["unlinked_mentions", "list_folders", "vault_stats", "list_trash", "open_in_app"];
pub const WRITE: &[&str] = &["move_note", "delete_note", "restore_note", "create_folder"];
/// Reads in `--read-only`, writes otherwise (like `daily_note`).
pub const PERIODIC: &str = "periodic_note";

pub fn read_definitions() -> Vec<Value> {
    vec![
        tool(
            "unlinked_mentions",
            "Unlinked mentions",
            "Places where a note's name (or one of its `aliases`) appears as plain text in other notes without being linked — the app's \"Unlinked mentions\" pane. Whole-word and case-insensitive; text inside links, embeds and frontmatter is excluded. Use it to find notes that should link to this one, then add the link with edit_note.",
            json!({
                "path": { "type": "string", "description": PATH_DESC },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50, "description": "Maximum number of mentioning notes to return." }
            }),
            &["path"],
            annotations("Unlinked mentions", true, false, true),
        ),
        tool(
            "list_folders",
            "List folders",
            "List the folders of the vault with the number of notes and attachments directly inside each. Hidden folders (`.obsidian`, `.trash`, `.git`) are never listed.",
            json!({
                "folder": { "type": "string", "description": "Vault-relative folder to list inside. Omit for the vault root." },
                "depth": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20, "description": "How many levels below `folder` to include (1 = immediate children only)." }
            }),
            &[],
            annotations("List folders", true, false, true),
        ),
        tool(
            "vault_stats",
            "Vault statistics",
            "A summary of the whole vault: note and attachment counts, total bytes, words and characters, resolved and broken links (with the most-wanted missing notes), orphan notes (linked from nowhere and linking nowhere), distinct tags with the most used ones, the largest and most recently changed notes, and the vault's link settings. This is what `vault info` prints, as JSON.",
            json!({ "top": { "type": "integer", "minimum": 0, "maximum": 100, "default": 10, "description": "How many entries to include in each \"top\" list." } }),
            &[],
            annotations("Vault statistics", true, false, true),
        ),
        tool(
            "list_trash",
            "List the trash",
            "List files and folders in the vault's `.trash` folder — what delete_note moved there. Each entry gives the name to pass to restore_note and, when the app recorded it in `.obsidian/trash.json`, the path it came from. Nothing here is indexed, searched or linked.",
            json!({ "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 } }),
            &[],
            annotations("List the trash", true, false, true),
        ),
        tool(
            "open_in_app",
            "Link that opens this in the app",
            "Build the URLs that open something in OpenMarkdown (the web app) and in Obsidian. It only returns links — nothing is opened, launched or fetched. Give `path` (optionally with `heading` or `block`) to open a note, canvas or base; give `query` to open the search pane with that query instead; or `action: \"daily\"` for today's daily note. Paste the `web_url` to a person, or the `obsidian_url` for a desktop Obsidian user.",
            json!({
                "path": { "type": "string", "description": PATH_DESC },
                "heading": { "type": "string", "description": "Optional heading in that note to scroll to (without #)." },
                "block": { "type": "string", "description": "Optional block id (with or without ^). Give `heading` or `block`, not both." },
                "query": { "type": "string", "description": "Open the search pane with this query instead of a note." },
                "action": { "type": "string", "enum": ["open", "search", "daily", "new"], "default": "open", "description": "`open` a note, `search`, today's `daily` note, or `new` note at `path`." },
                "base_url": { "type": "string", "default": "https://openmarkdown.ai/", "description": "Where the web app is hosted, if not the public one." }
            }),
            &[],
            annotations("Link that opens this in the app", true, false, true),
        ),
    ]
}

pub fn write_definitions() -> Vec<Value> {
    vec![
        tool(
            "move_note",
            "Move a note or folder",
            "Move a note, an attachment or a whole folder to another place in the vault and update every [[link]] to it (and to everything inside a moved folder) across the vault — the same machinery as rename_note and the app's own move. `to` may be a folder (the name is kept) or a full new path. Nothing is overwritten: the move fails if the destination exists. Set `dry_run: true` to see the moves and link rewrites first.",
            json!({
                "path": { "type": "string", "description": "What to move: a note, an attachment, or a folder (vault-relative)." },
                "to": { "type": "string", "description": "Destination folder (`Archive`, or `/` for the vault root) or a full new path with its extension (`Archive/Alpha.md`). A name without an extension is read as a folder; to rename a note in place use rename_note." },
                "dry_run": { "type": "boolean", "default": false, "description": "Report what would move and which links would change, without touching anything." }
            }),
            &["path", "to"],
            annotations("Move a note or folder", false, false, false),
        ),
        tool(
            "delete_note",
            "Delete to the trash",
            "Move a note, attachment or folder to the vault's `.trash` folder, exactly as the app's Delete does. This is reversible: restore_note puts it back, and list_trash shows what is there. Nothing is erased from disk and no links are rewritten, so links to the deleted note become unresolved — call backlinks first if you want to know what will break. There is no permanent delete here; empty the trash from the app when you are sure.",
            json!({
                "path": { "type": "string", "description": "Note, attachment or folder to delete (vault-relative)." }
            }),
            &["path"],
            annotations("Delete to the trash", false, true, false),
        ),
        tool(
            "restore_note",
            "Restore from the trash",
            "Move something out of `.trash` and back into the vault. `path` is the name inside the trash as list_trash reports it. Without `to`, it goes back to the path the app recorded in `.obsidian/trash.json`, or to the vault root when that is unknown. Never overwrites: an existing file at the destination makes it fail.",
            json!({
                "path": { "type": "string", "description": "Name inside `.trash`, e.g. `Alpha.md` (as list_trash reports it)." },
                "to": { "type": "string", "description": "Where to put it back, e.g. `Projects/Alpha.md`. Defaults to the recorded original path." }
            }),
            &["path"],
            annotations("Restore from the trash", false, false, false),
        ),
        tool(
            "create_folder",
            "Create a folder",
            "Create an empty folder (and any missing parents). Folders are also created automatically by create_note and move_note, so this is only needed for an empty one. Succeeds quietly if the folder already exists.",
            json!({ "path": { "type": "string", "description": "Vault-relative folder, e.g. `Projects/2026`." } }),
            &["path"],
            annotations("Create a folder", false, false, true),
        ),
    ]
}

pub fn periodic_definition(read_only: bool) -> Value {
    let actions: Value = if read_only { json!(["read"]) } else { json!(["read", "create", "append"]) };
    tool(
        PERIODIC,
        "Weekly, monthly, quarterly or yearly note",
        if read_only {
            "Read the weekly, monthly, quarterly or yearly note for a date, using the vault's Periodic Notes settings (`.obsidian/periodic-notes.json`) for the folder and date format, with the app's defaults when it has none: weekly `gggg-[W]ww`, monthly `YYYY-MM`, quarterly `YYYY-[Q]Q`, yearly `YYYY`. For daily notes use daily_note."
        } else {
            "Read, create or append to the weekly, monthly, quarterly or yearly note for a date, using the vault's Periodic Notes settings (`.obsidian/periodic-notes.json`) for the folder, date format and template, with the app's defaults when it has none: weekly `gggg-[W]ww`, monthly `YYYY-MM`, quarterly `YYYY-[Q]Q`, yearly `YYYY`. `create` and `append` create the note from the template if it is missing. For daily notes use daily_note."
        },
        json!({
            "period": { "type": "string", "enum": ["weekly", "monthly", "quarterly", "yearly"], "description": "Which periodic note." },
            "action": { "type": "string", "enum": actions, "default": "read" },
            "date": { "type": "string", "description": "`this` (default), `last`, `next` — one period back or forward — or a `YYYY-MM-DD` date inside the period." },
            "content": { "type": "string", "description": "Markdown to append (action `append`)." }
        }),
        &["period"],
        annotations("Periodic note", read_only, false, read_only),
    )
}

pub fn call(s: &mut Server, name: &str, a: &Map<String, Value>) -> R {
    match name {
        "unlinked_mentions" => t_unlinked_mentions(s, a),
        "list_folders" => t_list_folders(s, a),
        "vault_stats" => t_vault_stats(s, a),
        "list_trash" => t_list_trash(s, a),
        "open_in_app" => t_open_in_app(s, a),
        "move_note" => t_move_note(s, a),
        "delete_note" => t_delete_note(s, a),
        "restore_note" => t_restore_note(s, a),
        "create_folder" => t_create_folder(s, a),
        PERIODIC => t_periodic_note(s, a),
        other => Err(ToolError::Unknown(format!("Unknown tool: {other}"))),
    }
}

// ---- read tools ------------------------------------------------------------------------

fn t_unlinked_mentions(s: &Server, a: &Map<String, Value>) -> R {
    let path = s.resolve_existing(req_str(a, "path")?)?;
    let limit = opt_usize(a, "limit", 50, 1, 500)?;
    let all = s.vault.index.unlinked_mentions(&path);
    let total: usize = all.iter().map(|m| m.matches.len()).sum();
    let list: Vec<Value> = all
        .iter()
        .take(limit)
        .map(|m| {
            let matches: Vec<Value> = m
                .matches
                .iter()
                .take(20)
                .map(|c| json!({ "line": c.line + 1, "text": c.context.text.trim().chars().take(300).collect::<String>() }))
                .collect();
            json!({ "source": m.source, "count": m.matches.len(), "mentions": matches })
        })
        .collect();
    Ok(json_out(json!({
        "path": path, "noteCount": all.len(), "mentionCount": total,
        "returned": list.len(), "truncated": all.len() > list.len(), "notes": list
    })))
}

fn t_list_folders(s: &Server, a: &Map<String, Value>) -> R {
    let base = match opt_str(a, "folder")? {
        Some(f) if !f.trim().trim_matches('/').is_empty() => {
            let rel = fsx::clean_rel(f)?;
            if !s.root.join(&rel).is_dir() {
                return Err(format!("folder not found: {rel}").into());
            }
            Some(rel)
        }
        _ => None,
    };
    let depth = opt_usize(a, "depth", 20, 1, 20)?;
    let prefix = base.as_ref().map(|b| format!("{b}/")).unwrap_or_default();
    let base_depth = base.as_ref().map(|b| b.split('/').count()).unwrap_or(0);
    let mut folders: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for f in &s.vault.files {
        let Some((dir, _)) = f.path.rsplit_once('/') else { continue };
        // Every ancestor folder counts as a folder; only the direct parent
        // gets the file.
        let mut parts: Vec<&str> = dir.split('/').collect();
        while !parts.is_empty() {
            let d = parts.join("/");
            let inside = base.is_none() || d == *base.as_ref().unwrap() || d.starts_with(&prefix);
            if inside && d.split('/').count() - base_depth <= depth && !d.is_empty() && d != *base.as_ref().unwrap_or(&String::new()) {
                let e = folders.entry(d.clone()).or_default();
                if d == dir {
                    if Vault::is_note(&f.path) {
                        e.0 += 1;
                    } else {
                        e.1 += 1;
                    }
                }
            }
            parts.pop();
        }
    }
    // Empty folders have no files, so walk the directory tree for them too.
    walk_dirs(&s.root, base.as_deref(), depth, &mut folders);
    let list: Vec<Value> = folders
        .iter()
        .map(|(path, (notes, attachments))| json!({ "path": path, "notes": notes, "attachments": attachments }))
        .collect();
    Ok(json_out(json!({ "folder": base, "count": list.len(), "folders": list })))
}

fn walk_dirs(root: &std::path::Path, base: Option<&str>, depth: usize, out: &mut BTreeMap<String, (usize, usize)>) {
    fn rec(dir: &std::path::Path, rel: String, left: usize, out: &mut BTreeMap<String, (usize, usize)>) {
        if left == 0 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || !e.metadata().is_ok_and(|m| m.is_dir()) {
                continue;
            }
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            out.entry(child.clone()).or_default();
            rec(&e.path(), child, left - 1, out);
        }
    }
    let start = base.map(|b| root.join(b)).unwrap_or_else(|| root.to_path_buf());
    rec(&start, base.unwrap_or("").to_string(), depth, out);
}

fn t_vault_stats(s: &Server, a: &Map<String, Value>) -> R {
    let top = opt_usize(a, "top", 10, 0, 100)?;
    let v = &s.vault;
    let notes = v.index.note_count();
    let attachments = v.files.len() - notes;
    let bytes: u64 = v.files.iter().map(|f| f.size).sum();
    let resolved = v.index.resolved_links();
    let unresolved = v.index.unresolved_links();
    let link_count: u32 = resolved.values().flat_map(|m| m.values()).sum();
    let broken: u32 = unresolved.values().flat_map(|m| m.values()).sum();
    let mut broken_by_target: BTreeMap<&String, u32> = BTreeMap::new();
    for m in unresolved.values() {
        for (t, n) in m {
            *broken_by_target.entry(t).or_default() += n;
        }
    }
    let linked: HashSet<&String> = resolved
        .iter()
        .filter(|(_, m)| !m.is_empty())
        .map(|(s, _)| s)
        .chain(resolved.values().flat_map(|m| m.keys()))
        .collect();
    let orphan_paths: Vec<&str> = v.index.note_paths().into_iter().filter(|p| !linked.contains(&p.to_string())).collect();
    let (mut words, mut chars) = (0u64, 0u64);
    for p in v.index.note_paths() {
        let w = vault_ofm::word_count(v.text(p));
        words += w.words as u64;
        chars += w.characters as u64;
    }
    let tags = v.index.tags();
    let mut top_tags: Vec<(&String, &u32)> = tags.iter().collect();
    top_tags.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    let mut missing: Vec<(&&String, &u32)> = broken_by_target.iter().collect();
    missing.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    let mut by_size: Vec<&vault::DiskFile> = v.files.iter().filter(|f| Vault::is_note(&f.path)).collect();
    by_size.sort_by(|a, b| b.size.cmp(&a.size).then(a.path.cmp(&b.path)));
    let mut by_time = by_size.clone();
    by_time.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap_or(std::cmp::Ordering::Equal).then(a.path.cmp(&b.path)));
    Ok(json_out(json!({
        "name": v.name(),
        "notes": notes,
        "attachments": attachments,
        "bytes": bytes,
        "words": words,
        "characters": chars,
        "links": link_count,
        "brokenLinks": broken,
        "brokenTargets": broken_by_target.len(),
        "topMissingNotes": missing.iter().take(top).map(|(t, n)| json!({ "target": t, "links": n })).collect::<Vec<_>>(),
        "orphans": orphan_paths.len(),
        "orphanNotes": orphan_paths.iter().take(top).collect::<Vec<_>>(),
        "tags": tags.len(),
        "topTags": top_tags.iter().take(top).map(|(t, n)| json!({ "tag": t, "count": n })).collect::<Vec<_>>(),
        "largestNotes": by_size.iter().take(top).map(|f| json!({ "path": f.path, "bytes": f.size })).collect::<Vec<_>>(),
        "recentlyModified": by_time.iter().take(top).map(|f| json!({ "path": f.path, "modified": iso_utc(f.mtime) })).collect::<Vec<_>>(),
        "settings": {
            "newLinkFormat": v.config_str("newLinkFormat").unwrap_or_else(|| "shortest".into()),
            "useMarkdownLinks": v.config_bool("useMarkdownLinks"),
            "attachmentFolderPath": v.config_str("attachmentFolderPath").unwrap_or_else(|| "/".into()),
        }
    })))
}

/// `{trash path: original path}` as the app's Trash view records it.
fn trash_origins(s: &Server) -> Map<String, Value> {
    vault::read_json(&s.root.join(".obsidian/trash.json"))
        .get("origins")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn t_list_trash(s: &Server, a: &Map<String, Value>) -> R {
    let limit = opt_usize(a, "limit", 100, 1, 1000)?;
    let origins = trash_origins(s);
    let dir = s.root.join(TRASH);
    let mut entries: Vec<Value> = Vec::new();
    if let Ok(read) = fs::read_dir(&dir) {
        let mut rows: Vec<(String, bool, u64, f64)> = read
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let m = e.metadata().ok()?;
                let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0);
                Some((name, m.is_dir(), m.len(), mtime))
            })
            .collect();
        rows.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
        for (name, is_dir, size, mtime) in rows.iter().take(limit) {
            let mut v = json!({ "name": name, "type": if *is_dir { "folder" } else { "file" }, "bytes": size, "deleted": iso_utc(*mtime) });
            if let Some(o) = origins.get(&format!("{TRASH}/{name}")).and_then(Value::as_str) {
                v["original_path"] = json!(o);
            }
            entries.push(v);
        }
    }
    Ok(json_out(json!({ "count": entries.len(), "trash": entries })))
}

/// Percent-encodes for a query-string value (RFC 3986 unreserved set).
fn q(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn t_open_in_app(s: &Server, a: &Map<String, Value>) -> R {
    let action = opt_str(a, "action")?.unwrap_or("open");
    if !["open", "search", "daily", "new"].contains(&action) {
        return Err("`action` must be open, search, daily or new".into());
    }
    let base = opt_str(a, "base_url")?.unwrap_or("https://openmarkdown.ai/").trim().to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("`base_url` must start with http:// or https://".into());
    }
    let base = if base.ends_with('/') { base } else { format!("{base}/") };
    let name = s.vault.name();
    let query = opt_str(a, "query")?;
    let uri = match action {
        "search" => {
            let Some(qs) = query.filter(|q| !q.trim().is_empty()) else {
                return Err("`query` is required for action `search`".into());
            };
            format!("obsidian://search?vault={}&query={}", q(&name), q(qs))
        }
        "daily" => format!("obsidian://daily?vault={}", q(&name)),
        "new" => {
            let p = req_str(a, "path").map_err(|_| ToolError::Failed("`path` is required for action `new`".into()))?;
            format!("obsidian://new?vault={}&file={}", q(&name), q(fsx::clean_rel(p)?.trim_end_matches(".md")))
        }
        _ => {
            let path = s.resolve_existing(req_str(a, "path")?)?;
            let heading = opt_str(a, "heading")?;
            let block = opt_str(a, "block")?;
            if heading.is_some() && block.is_some() {
                return Err("give either `heading` or `block`, not both".into());
            }
            // The app takes the subpath inside `file`, as Obsidian does.
            let mut file = if Vault::is_note(&path) { path.trim_end_matches(".md").to_string() } else { path.clone() };
            if let Some(h) = heading {
                let h = h.trim().trim_start_matches('#').trim();
                super::tools::find_heading(&s.read_file(&path)?.text, h)?;
                file.push_str(&format!("#{h}"));
            } else if let Some(b) = block {
                let text = s.read_file(&path)?.text;
                let (_, _, id) = super::tools::find_block(&text, b)?;
                file.push_str(&format!("#^{id}"));
            }
            format!("obsidian://open?vault={}&file={}", q(&name), q(&file))
        }
    };
    let web = format!("{base}?uri={}", q(&uri));
    Ok(done(
        format!("{web}\n{uri}"),
        json!({ "web_url": web, "obsidian_url": uri, "vault": name, "action": action }),
    ))
}

// ---- move / delete ---------------------------------------------------------------------

/// The shared rename/move: rewrites every link to `old` (and, for a folder,
/// to everything inside it) and then moves the file or folder.
pub fn move_path(s: &mut Server, old: &str, new: &str, dry_run: bool) -> Result<Value, String> {
    if new == old {
        return Err("the new path is the same as the old one".into());
    }
    let old_full = fsx::confined(&s.root, old)?;
    let new_full = fsx::confined(&s.root, new)?;
    if old_full.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("{old} is a symlink; refusing to move it"));
    }
    let case_only = new.eq_ignore_ascii_case(old);
    if !case_only && (new_full.symlink_metadata().is_ok() || s.vault.index.file(new).is_some()) {
        return Err(format!("already exists: {new} (nothing was moved; pick another name)"));
    }
    let edits = s.vault.index.rename_edits(old, new, &RenameOptions { link_format: s.vault.link_format() });
    let plan = s.vault.index.rename_plan(old, new);
    // Check every note to be rewritten before touching anything.
    let mut writes: Vec<(String, String)> = Vec::new();
    for e in &edits {
        let indexed = s.vault.text(&e.original_path);
        let full = fsx::confined(&s.root, &e.original_path)?;
        let bytes = fs::read(&full).map_err(|err| format!("{}: {err}", e.original_path))?;
        match std::str::from_utf8(&bytes) {
            Ok(t) if t == indexed => {}
            Ok(_) => return Err(format!("{} changed on disk while moving; nothing was changed, try again", e.original_path)),
            Err(_) => return Err(format!("{} links to {old} but is not valid UTF-8; refusing to rewrite it (nothing was changed)", e.original_path)),
        }
        writes.push((e.path.clone(), vault_index::apply_edits(indexed, &e.edits)));
    }
    let links: usize = edits.iter().map(|e| e.edits.len()).sum();
    let moved: Vec<Value> = plan.iter().map(|(f, t)| json!({ "from": f, "to": t })).collect();
    let touched: Vec<&String> = writes.iter().map(|(p, _)| p).collect();
    if dry_run {
        let samples: Vec<Value> = edits
            .iter()
            .take(20)
            .map(|e| json!({ "path": e.path, "links": e.edits.len(), "new_links": e.edits.iter().map(|t| t.text.clone()).take(5).collect::<Vec<_>>() }))
            .collect();
        return Ok(json!({
            "dry_run": true, "old_path": old, "new_path": new,
            "files_moved": plan.len().max(1), "moves": moved,
            "links_to_update": links, "notes_to_update": touched, "examples": samples
        }));
    }
    if let Some(parent) = new_full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{new}: cannot create folder: {e}"))?;
    }
    fs::rename(&old_full, &new_full).map_err(|e| format!("move {old} → {new} failed: {e}"))?;
    let mut failed = Vec::new();
    for (path, text) in &writes {
        let full = fsx::confined(&s.root, path)?;
        if let Err(e) = fsx::write_atomic(&full, path, text.as_bytes()) {
            failed.push(e);
        }
    }
    let reindex: Vec<String> = writes.iter().map(|(p, _)| p.clone()).chain(plan.iter().map(|(_, t)| t.clone())).chain([new.to_string()]).collect();
    s.reindex(&reindex);
    if !failed.is_empty() {
        return Err(format!("moved {old} → {new}, but some link updates failed: {}", failed.join("; ")));
    }
    Ok(json!({
        "old_path": old, "new_path": new, "files_moved": plan.len().max(1), "moves": moved,
        "links_updated": links, "notes_updated": touched
    }))
}

/// Resolves a client argument to an existing file or folder.
fn resolve_any(s: &Server, arg: &str) -> Result<(String, bool), String> {
    match s.resolve_existing(arg) {
        Ok(p) => Ok((p, false)),
        Err(e) => {
            let rel = fsx::clean_rel(arg)?;
            if fsx::confined(&s.root, &rel)?.is_dir() {
                Ok((rel, true))
            } else {
                Err(e)
            }
        }
    }
}

fn t_move_note(s: &mut Server, a: &Map<String, Value>) -> R {
    let (old, is_folder) = resolve_any(s, req_str(a, "path")?)?;
    let to = req_str(a, "to")?.trim();
    let name = old.rsplit('/').next().unwrap_or(&old).to_string();
    // `/`, `.` or an existing folder means "keep the name, change the folder".
    let new = if to.is_empty() || to == "/" || to == "." {
        name.clone()
    } else {
        let cleaned = fsx::clean_rel(to)?;
        // A destination is a folder when it says so (`Archive/`), when it
        // already is one, or when it has no file extension while the source
        // has — `move_note Alpha.md → Archive` means "into Archive".
        let last = cleaned.rsplit('/').next().unwrap_or(&cleaned);
        let looks_like_folder =
            to.ends_with('/') || fsx::confined(&s.root, &cleaned)?.is_dir() || (!is_folder && !last.contains('.'));
        if looks_like_folder {
            format!("{cleaned}/{name}")
        } else if is_folder {
            cleaned
        } else {
            // A bare new name keeps the extension.
            let mut n = cleaned;
            if let Some((_, ext)) = old.rsplit_once('.').filter(|(stem, _)| !stem.ends_with('/') && !stem.is_empty()) {
                if !n.to_lowercase().ends_with(&format!(".{}", ext.to_lowercase())) {
                    n = format!("{n}.{ext}");
                }
            }
            n
        }
    };
    let dry = opt_bool(a, "dry_run", false)?;
    let r = move_path(s, &old, &new, dry)?;
    let links = r.get("links_updated").or_else(|| r.get("links_to_update")).and_then(Value::as_u64).unwrap_or(0);
    let count = r.get("notes_updated").or_else(|| r.get("notes_to_update")).and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
    let text = if dry {
        format!("Would move {old} → {new} and update {links} links in {count} notes (nothing was changed)")
    } else {
        format!("Moved {old} → {new}; updated {links} links in {count} notes")
    };
    Ok(done(text, r))
}

/// A free name inside `.trash`, as the app's adapter picks one.
fn trash_target(s: &Server, name: &str) -> Result<String, String> {
    let dir = s.root.join(TRASH);
    let free = |candidate: &str| !dir.join(candidate).exists();
    if free(name) {
        return Ok(name.to_string());
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..10_000)
        .map(|i| format!("{stem} {i}{ext}"))
        .find(|c| free(c))
        .ok_or_else(|| format!("the trash already holds too many files named {name}"))
}

fn t_delete_note(s: &mut Server, a: &Map<String, Value>) -> R {
    let (path, is_folder) = resolve_any(s, req_str(a, "path")?)?;
    let full = fsx::confined(&s.root, &path)?;
    if full.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("{path} is a symlink; refusing to delete it").into());
    }
    let backlinks = if is_folder { 0 } else { s.vault.index.backlinks(&path).len() };
    let name = path.rsplit('/').next().unwrap_or(&path).to_string();
    let dir = s.root.join(TRASH);
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {TRASH}: {e}"))?;
    let target = trash_target(s, &name)?;
    let trash_path = format!("{TRASH}/{target}");
    fs::rename(&full, dir.join(&target)).map_err(|e| format!("could not move {path} to the trash: {e}"))?;
    s.refresh();
    let what = if is_folder { "folder" } else { "file" };
    let mut text = format!("Deleted {what} {path} → {trash_path}. Restore it with restore_note {{\"path\": \"{target}\", \"to\": \"{path}\"}}.");
    if backlinks > 0 {
        text.push_str(&format!(" {backlinks} note(s) still link to it; those links are now unresolved."));
    }
    Ok(done(
        text,
        json!({ "path": path, "trash_path": trash_path, "restore_name": target, "original_path": path, "type": what, "broken_backlinks": backlinks }),
    ))
}

fn t_restore_note(s: &mut Server, a: &Map<String, Value>) -> R {
    let name = fsx::clean_rel(req_str(a, "path")?)?;
    let from = s.root.join(TRASH).join(&name);
    if !from.exists() {
        return Err(format!("not in the trash: {name} (use list_trash to see what is there)").into());
    }
    let default = trash_origins(s)
        .get(&format!("{TRASH}/{name}"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| name.rsplit('/').next().unwrap_or(&name).to_string());
    let to = fsx::clean_rel(opt_str(a, "to")?.unwrap_or(&default))?;
    let dest = fsx::confined(&s.root, &to)?;
    if dest.symlink_metadata().is_ok() {
        return Err(format!("already exists: {to} (give another `to`; nothing was restored)").into());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{to}: cannot create folder: {e}"))?;
    }
    fs::rename(&from, &dest).map_err(|e| format!("could not restore {name}: {e}"))?;
    s.refresh();
    Ok(done(format!("Restored {TRASH}/{name} → {to}"), json!({ "path": to, "from": format!("{TRASH}/{name}") })))
}

fn t_create_folder(s: &mut Server, a: &Map<String, Value>) -> R {
    let rel = fsx::clean_rel(req_str(a, "path")?)?;
    let full = fsx::confined(&s.root, &rel)?;
    if full.is_file() {
        return Err(format!("{rel} is a file, not a folder").into());
    }
    let existed = full.is_dir();
    fs::create_dir_all(&full).map_err(|e| format!("{rel}: {e}"))?;
    Ok(done(
        if existed { format!("{rel} already exists") } else { format!("Created folder {rel}") },
        json!({ "path": rel, "created": !existed }),
    ))
}

// ---- periodic notes --------------------------------------------------------------------

const PERIODS: &[(&str, &str, &str)] = &[
    ("weekly", "week", "gggg-[W]ww"),
    ("monthly", "month", "YYYY-MM"),
    ("quarterly", "quarter", "YYYY-[Q]Q"),
    ("yearly", "year", "YYYY"),
];

/// `gggg`/`gg` (the locale week-year) are moment tokens `vault-clip`'s dayjs
/// port deliberately refuses, so they are resolved here and passed on as
/// literals.
pub fn expand_week_year(fmt: &str, dt: &vault_clip::date::DateTime) -> String {
    if !fmt.contains("gg") {
        return fmt.to_string();
    }
    let week: i64 = vault_clip::date::format(dt, "w").parse().unwrap_or(1);
    let year: i64 = vault_clip::date::format(dt, "YYYY").parse().unwrap_or(0);
    let month: i64 = vault_clip::date::format(dt, "M").parse().unwrap_or(1);
    let week_year = match (week, month) {
        (1, 12) => year + 1,
        (w, 1) if w >= 52 => year - 1,
        _ => year,
    };
    // Longest token first, and only outside an existing [literal] section.
    let mut out = String::with_capacity(fmt.len() + 4);
    let mut rest = fmt;
    while let Some(i) = rest.find(['g', '[']) {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        if let Some(lit) = rest.strip_prefix('[') {
            let end = lit.find(']').map(|j| j + 2).unwrap_or(rest.len());
            out.push_str(&rest[..end]);
            rest = &rest[end..];
        } else if let Some(r) = rest.strip_prefix("gggg") {
            out.push_str(&format!("[{week_year:04}]"));
            rest = r;
        } else if let Some(r) = rest.strip_prefix("gg") {
            out.push_str(&format!("[{:02}]", week_year.rem_euclid(100)));
            rest = r;
        } else {
            out.push('g');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

/// `{{monday:FORMAT}}` … `{{sunday:FORMAT}}`, as the Periodic Notes plugin
/// fills them (the day of the note's own week; Sunday is day 0).
fn weekday_tokens(tpl: &str, ms: f64, tz: i32) -> String {
    const DAYS: [&str; 7] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    let dt = vault_clip::date::DateTime::from_epoch_ms(ms, tz);
    let weekday: i64 = vault_clip::date::format(&dt, "d").parse().unwrap_or(0);
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(i) = rest.find("{{") {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find("}}") else {
            break;
        };
        let inner = rest[i + 2..i + j].trim();
        let (name, fmt) = match inner.split_once(':') {
            Some((n, f)) => (n.trim().to_lowercase(), f.trim()),
            None => (inner.to_lowercase(), "YYYY-MM-DD"),
        };
        match DAYS.iter().position(|d| *d == name) {
            Some(idx) => {
                let day = vault_clip::date::DateTime::from_epoch_ms(ms + (idx as i64 - weekday) as f64 * 86_400_000.0, tz);
                out.push_str(&vault_clip::date::format(&day, &expand_week_year(fmt, &day)));
            }
            None => out.push_str(&rest[i..i + j + 2]),
        }
        rest = &rest[i + j + 2..];
    }
    out.push_str(rest);
    out
}

fn t_periodic_note(s: &mut Server, a: &Map<String, Value>) -> R {
    let period = req_str(a, "period")?.trim().to_lowercase();
    let Some((_, unit, default_format)) = PERIODS.iter().find(|(p, _, _)| *p == period) else {
        return Err(format!("`period` must be weekly, monthly, quarterly or yearly (got {period}); for daily notes use daily_note").into());
    };
    let action = opt_str(a, "action")?.unwrap_or("read");
    if !["read", "create", "append"].contains(&action) {
        return Err("`action` must be read, create or append".into());
    }
    if action != "read" && s.read_only {
        return Err("the server is read-only; only action `read` is available".into());
    }
    let cfg = vault::read_json(&s.root.join(".obsidian/periodic-notes.json"));
    let section = cfg.get(&period).and_then(Value::as_object).cloned().unwrap_or_default();
    let get = |k: &str| section.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    let format = Some(get("format")).filter(|s| !s.is_empty()).unwrap_or_else(|| (*default_format).to_string());
    let folder = get("folder").trim_matches('/').to_string();
    let template = get("template");

    let tz = vault::local_offset_minutes();
    let now = vault::now_ms();
    let ms = match opt_str(a, "date")?.map(str::trim).unwrap_or("this") {
        "" | "this" | "current" | "today" => now,
        "last" | "previous" => shift(now, tz, -1, unit)?,
        "next" => shift(now, tz, 1, unit)?,
        d => super::tools::daily_ms(Some(d), now, tz)?,
    };
    let dt = vault_clip::date::DateTime::from_epoch_ms(ms, tz);
    let name = vault_clip::date::format(&dt, &expand_week_year(&format, &dt));
    if name.trim().is_empty() {
        return Err(format!("the Periodic notes `format` for {period} ({format}) produced an empty file name").into());
    }
    let rel = fsx::clean_rel(&if folder.is_empty() { format!("{name}.md") } else { format!("{folder}/{name}.md") })
        .map_err(|e| format!("the Periodic notes settings give an invalid path: {e}"))?;
    let full = fsx::confined(&s.root, &rel)?;
    let exists = full.is_file();
    if action == "read" {
        if !exists {
            return Err(format!(
                "the {period} note {rel} does not exist yet{}",
                if s.read_only { "" } else { " (use action `create` or `append`)" }
            )
            .into());
        }
        let file = s.read_file(&rel)?;
        return Ok(ToolOutput {
            text: format!("{rel}\n\n{}", file.text),
            structured: Some(json!({ "path": rel, "period": period, "text": file.text })),
            extra: Vec::new(),
        });
    }
    let append = if action == "append" { Some(fsx::lf(req_str(a, "content")?)) } else { None };
    let mut created = false;
    if !exists {
        let body = if template.is_empty() {
            String::new()
        } else {
            let t = s.resolve_existing(&template).map_err(|e| format!("{period} note template: {e}"))?;
            let tpl = s.read_file(&t)?;
            let (df, tf) = crate::commands::template_settings(&s.vault);
            let title = name.rsplit('/').next().unwrap_or(&name).to_string();
            crate::commands::apply_template(&weekday_tokens(&tpl.text, ms, tz), &title, ms, tz, &df, &tf)
        };
        s.write_file(&rel, &TextFile::new(body))?;
        created = true;
    }
    if let Some(content) = append {
        let mut file = s.read_file(&rel)?;
        file.text = append_text(&file.text, None, &content)?;
        s.write_file(&rel, &file)?;
    }
    let file = s.read_file(&rel)?;
    let verb = match (created, action) {
        (true, "append") => "Created and appended to",
        (true, _) => "Created",
        (false, "append") => "Appended to",
        _ => "Already exists:",
    };
    Ok(ToolOutput {
        text: format!("{verb} {rel}\n\n{}", file.text),
        structured: Some(json!({ "path": rel, "period": period, "created": created, "text": file.text })),
        extra: Vec::new(),
    })
}

fn shift(now: f64, tz: i32, amount: i64, unit: &str) -> Result<f64, String> {
    let dt = vault_clip::date::DateTime::from_epoch_ms(now, tz);
    vault_clip::date::add(&dt, amount, unit)
        .map(|d| d.epoch_ms())
        .ok_or_else(|| format!("cannot move {amount} {unit} from now"))
}
