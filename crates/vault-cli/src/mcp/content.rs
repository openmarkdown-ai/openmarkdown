//! Tools that turn a vault into something else: rendered HTML, a published
//! site, a Bases view's rows, a clipped web page, and imports from other
//! note apps.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::fsx;
use super::tools::{annotations, done, json_out, opt_bool, opt_str, opt_usize, req_str, tool, PATH_DESC};
use super::{Server, ToolError, ToolOutput};
use crate::commands;
use crate::vault::{self, Vault};

type R = Result<ToolOutput, ToolError>;

pub const READ: &[&str] = &["render_note", "run_base"];
pub const WRITE: &[&str] = &["export_note", "export_vault", "clip_html", "import_notes"];

/// Rendered output larger than this is refused with a pointer to export_note.
const MAX_INLINE_BYTES: usize = 2_000_000;

pub fn read_definitions() -> Vec<Value> {
    vec![
        tool(
            "render_note",
            "Render a note",
            "Render a note the way the reading view shows it, with wikilinks, embeds, callouts, tables, footnotes, tasks and math resolved. `format`: `text` (default — the readable plain text, best for summarising or quoting), `html` (a complete standalone HTML document with its styles and embedded images, as `vault export-html` produces), or `fragment` (just the HTML of the note's body, to paste into a page). Nothing is written; use export_note to save the HTML to a file.",
            json!({
                "path": { "type": "string", "description": PATH_DESC },
                "format": { "type": "string", "enum": ["text", "html", "fragment"], "default": "text" },
                "theme": { "type": "string", "enum": ["auto", "light", "dark"], "default": "auto", "description": "Only affects `html`." }
            }),
            &["path"],
            annotations("Render a note", true, false, true),
        ),
        tool(
            "run_base",
            "Run a base view",
            "Run a view of a `.base` file — the vault's own database views — and get the rows back. Filters, formulas, sorting, grouping and summaries are evaluated exactly as the app's Bases plugin does. Give `path` for a `.base` file in the vault, or `yaml` to run a base definition you wrote without saving it. `format: \"markdown\"` adds a Markdown table you can paste straight into a note.",
            json!({
                "path": { "type": "string", "description": "Vault-relative path of a `.base` file, e.g. `Reading list.base`." },
                "yaml": { "type": "string", "description": "A base definition in YAML, instead of `path`. Same syntax as a .base file." },
                "view": { "type": "string", "description": "View name or 0-based index. Default: the first view." },
                "format": { "type": "string", "enum": ["json", "markdown"], "default": "json", "description": "`markdown` also returns a Markdown table of the rows." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100, "description": "Maximum rows to return (the counts still cover every row)." }
            }),
            &[],
            annotations("Run a base view", true, false, true),
        ),
    ]
}

pub fn write_definitions() -> Vec<Value> {
    vec![
        tool(
            "export_note",
            "Export a note to an HTML file",
            "Write one note as a standalone HTML file — styles, embedded images and resolved links all in one file that opens in any browser. `to` is a vault-relative path by default; to write outside the vault (for example `~/Desktop/Alpha.html`) you must also pass `outside_vault: true`, which is the only way any tool here writes outside the vault folder. An existing file is never overwritten unless `overwrite: true`.",
            json!({
                "path": { "type": "string", "description": PATH_DESC },
                "to": { "type": "string", "description": "Where to write the .html file: vault-relative (`Exports/Alpha.html`), or an absolute path with `outside_vault: true`." },
                "outside_vault": { "type": "boolean", "default": false, "description": "Required to write to an absolute path outside the vault." },
                "overwrite": { "type": "boolean", "default": false, "description": "Replace an existing file at `to`." },
                "theme": { "type": "string", "enum": ["auto", "light", "dark"], "default": "auto" }
            }),
            &["path", "to"],
            annotations("Export a note to an HTML file", false, false, false),
        ),
        tool(
            "export_vault",
            "Publish the vault as a website",
            "Publish the whole vault (or the notes you choose) as a static website: one HTML page per note, plus navigation, search, a graph, backlinks, an RSS feed and the attachments the notes use. `to` must be an empty or new folder. Writing outside the vault needs `outside_vault: true`; publishing into the vault is refused, because it would add hundreds of files to the vault itself. Nothing in the vault is modified.",
            json!({
                "to": { "type": "string", "description": "Destination folder for the site. Must be empty or not exist." },
                "outside_vault": { "type": "boolean", "default": false, "description": "Required: the site folder is always outside the vault." },
                "site_name": { "type": "string", "description": "Title of the site. Default: the vault's folder name." },
                "home": { "type": "string", "description": "Note to use as the home page, e.g. `Welcome.md`." },
                "base_url": { "type": "string", "description": "Public URL the site will be served from (used for the RSS feed and canonical links)." },
                "include": { "type": "array", "items": { "type": "string" }, "description": "Only publish notes under these folders or paths." },
                "exclude": { "type": "array", "items": { "type": "string" }, "description": "Do not publish these folders or paths." },
                "noindex": { "type": "boolean", "default": false, "description": "Ask search engines not to index the site." },
                "dry_run": { "type": "boolean", "default": false, "description": "List the pages that would be written, without writing." }
            }),
            &["to"],
            annotations("Publish the vault as a website", false, false, false),
        ),
        tool(
            "clip_html",
            "Clip a web page into a note",
            "Turn a web page into a Markdown note with the Web Clipper's pipeline: the main article is extracted, converted to Markdown, and given frontmatter (title, source, author, published date, description, tags). Pass `html` with the page source, or `url` — **`url` makes a network request**, fetching that address with `curl` before anything is written. The note is created at a free path (never overwriting), so this only ever adds a file. Use `dry_run: true` to see the Markdown without creating anything.",
            json!({
                "url": { "type": "string", "description": "Page to fetch and clip. Fetching it makes a network request to that address." },
                "html": { "type": "string", "description": "Page source to clip instead of fetching. Use with `url` to record where it came from." },
                "folder": { "type": "string", "description": "Vault folder for the new note. Default: the template's folder (`Clippings`)." },
                "name": { "type": "string", "description": "File name for the note, without .md. Default: the page title." },
                "template": { "type": "string", "description": "A Web Clipper template as JSON, or the vault path of a `.json` template file." },
                "dry_run": { "type": "boolean", "default": false, "description": "Return the Markdown without creating a note." }
            }),
            &[],
            annotations("Clip a web page into a note", false, false, false),
        ),
        tool(
            "import_notes",
            "Import notes from another app",
            "Import an export from Evernote (`enex`), Notion (`notion`), Roam (`roam`), Google Keep (`keep`), Bear (`bear`), Logseq (`logseq`), a CSV table (`csv`), saved web pages (`html`) or a TextBundle (`textbundle`) into a folder of the vault, converting links, attachments and frontmatter the way Obsidian's importer does. **It previews by default**: without `apply: true` you get the list of files it would create and the warnings, and nothing is written. `source` is a path on this computer, so this is the one tool that reads a file outside the vault — only point it at an export you meant to import. Existing notes are never overwritten: a clashing name becomes `Note 1.md`.",
            json!({
                "kind": { "type": "string", "enum": ["enex", "html", "notion", "roam", "keep", "bear", "logseq", "csv", "textbundle"], "description": "Which export format `source` is." },
                "source": { "type": "array", "items": { "type": "string" }, "description": "One or more paths on this computer: the export file(s) or a folder of them." },
                "to": { "type": "string", "description": "Vault folder to import into, e.g. `Imported`. Use `/` for the vault root." },
                "apply": { "type": "boolean", "default": false, "description": "false (default) previews the files it would create. true writes them." },
                "options": { "type": "object", "description": "Importer options, as the importer for `kind` defines them." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100, "description": "How many file names to list in the preview." }
            }),
            &["kind", "source", "to"],
            annotations("Import notes from another app", false, false, false),
        ),
    ]
}

pub fn call(s: &mut Server, name: &str, a: &Map<String, Value>) -> R {
    match name {
        "render_note" => t_render_note(s, a),
        "run_base" => t_run_base(s, a),
        "export_note" => t_export_note(s, a),
        "export_vault" => t_export_vault(s, a),
        "clip_html" => t_clip_html(s, a),
        "import_notes" => t_import_notes(s, a),
        other => Err(ToolError::Unknown(format!("Unknown tool: {other}"))),
    }
}

fn theme_of(a: &Map<String, Value>) -> Result<vault_publish::Theme, ToolError> {
    Ok(match opt_str(a, "theme")?.unwrap_or("auto") {
        "auto" => vault_publish::Theme::default(),
        "light" => vault_publish::Theme::Light,
        "dark" => vault_publish::Theme::Dark,
        other => return Err(format!("`theme` must be auto, light or dark (got {other})").into()),
    })
}

/// The standalone HTML of one note, with the attachments it uses embedded.
fn note_html(s: &Server, path: &str, theme: vault_publish::Theme) -> String {
    let mut files: Vec<vault_publish::InputFile> = s.vault.index.note_paths().into_iter().map(|p| commands::input_note(&s.vault, p)).collect();
    for a in commands::referenced_attachments(&s.vault, std::slice::from_ref(&path.to_string()), 3) {
        if let Some(f) = commands::input_binary(&s.vault, &a) {
            files.push(f);
        }
    }
    let mut input = vault_publish::NoteExportInput { path: path.to_string(), files, ..Default::default() };
    input.options.strict_line_breaks = s.vault.config_bool("strictLineBreaks");
    input.options.theme = theme;
    vault_publish::export_note(&input)
}

fn t_render_note(s: &Server, a: &Map<String, Value>) -> R {
    let path = s.resolve_note(req_str(a, "path")?)?;
    let format = opt_str(a, "format")?.unwrap_or("text");
    let out = match format {
        "text" | "fragment" => {
            let strict = s.vault.config_bool("strictLineBreaks");
            let rendered = vault_ofm::render(s.vault.text(&path), &vault_ofm::RenderOptions { strict_line_breaks: strict });
            let mut body = String::new();
            for sec in &rendered.sections {
                if sec.html.is_empty() {
                    continue;
                }
                if format == "fragment" {
                    body.push_str(&sec.html);
                    body.push('\n');
                } else {
                    let t = commands::plain_text(&sec.html);
                    if !t.is_empty() {
                        body.push_str(&t);
                        body.push_str("\n\n");
                    }
                }
            }
            body.trim_end().to_string()
        }
        "html" => note_html(s, &path, theme_of(a)?),
        other => return Err(format!("`format` must be text, html or fragment (got {other})").into()),
    };
    if out.len() > MAX_INLINE_BYTES {
        return Err(format!(
            "{path} renders to {} KB, more than the {} KB a tool result should carry; use export_note to write it to a file, or format `text` for the readable text",
            out.len() / 1024,
            MAX_INLINE_BYTES / 1024
        )
        .into());
    }
    Ok(ToolOutput::text(out))
}

// ---- bases -----------------------------------------------------------------------------

fn t_run_base(s: &Server, a: &Map<String, Value>) -> R {
    let inline = opt_str(a, "yaml")?;
    let (yaml, this_path) = match (opt_str(a, "path")?, inline) {
        (Some(_), Some(_)) => return Err("give either `path` or `yaml`, not both".into()),
        (None, None) => {
            let bases: Vec<&str> = s.vault.files.iter().map(|f| f.path.as_str()).filter(|p| p.to_lowercase().ends_with(".base")).take(10).collect();
            return Err(format!(
                "give `path` (a .base file in the vault) or `yaml` (a base definition){}",
                if bases.is_empty() { String::new() } else { format!(" — this vault has: {}", bases.join(", ")) }
            )
            .into());
        }
        (None, Some(y)) => (y.to_string(), None),
        (Some(p), None) => {
            let rel = s.resolve_existing(p).or_else(|_| s.resolve_existing(&format!("{}.base", p.trim_end_matches(".base"))))?;
            if !rel.to_lowercase().ends_with(".base") {
                return Err(format!("{rel} is not a .base file").into());
            }
            let full = fsx::confined(&s.root, &rel)?;
            (fsx::read_text(&full, &rel)?.text, Some(rel))
        }
    };
    let base = vault_bases::parse_base(&yaml).map_err(|e| format!("this base is not valid: {e:?}"))?;
    let view = match opt_str(a, "view")? {
        None => 0,
        Some(v) => match v.trim().parse::<usize>() {
            Ok(n) => n,
            Err(_) => base
                .views
                .iter()
                .position(|w| w.name.eq_ignore_ascii_case(v.trim()))
                .ok_or_else(|| format!("no view named {v} (views: {})", base.views.iter().map(|w| w.name.as_str()).collect::<Vec<_>>().join(", ")))?,
        },
    };
    if view >= base.views.len() && !(base.views.is_empty() && view == 0) {
        return Err(format!("view {view} does not exist ({} view(s) in this base)", base.views.len()).into());
    }
    let limit = opt_usize(a, "limit", 100, 1, 1000)?;
    let format = opt_str(a, "format")?.unwrap_or("json");
    if format != "json" && format != "markdown" {
        return Err("`format` must be json or markdown".into());
    }
    let records = s.vault.file_records();
    let this = this_path.as_ref().and_then(|p| records.iter().find(|r| &r.path == p)).cloned();
    let tz = vault::local_offset_minutes();
    let result = vault_bases::run_view(&base, view, &records, this.as_ref(), vault::now_ms(), tz);
    let columns: Vec<Value> = result.columns.iter().map(|c| json!({ "id": c.id, "name": c.name, "type": c.kind })).collect();
    let mut left = limit;
    let groups: Vec<Value> = result
        .groups
        .iter()
        .map(|g| {
            let rows: Vec<Value> = g
                .rows
                .iter()
                .take(left)
                .map(|r| {
                    let mut cells = serde_json::Map::new();
                    for c in &result.columns {
                        let v = r.cells.get(&c.id).map(|x| if x.is_null() { Value::Null } else { Value::String(x.to_display(tz)) }).unwrap_or(Value::Null);
                        cells.insert(c.name.clone(), v);
                    }
                    json!({ "path": r.path, "cells": cells })
                })
                .collect();
            left = left.saturating_sub(rows.len());
            let mut v = json!({ "rows": rows });
            if g.has_key {
                v["group"] = json!(g.key.to_display(tz));
            }
            if !g.summaries.is_empty() {
                v["summaries"] = json!(g.summaries.iter().map(|(k, val)| (k.clone(), val.to_display(tz))).collect::<std::collections::BTreeMap<_, _>>());
            }
            v
        })
        .collect();
    let mut out = json!({
        "view": result.view.as_ref().map(|v| json!({ "name": v.name, "type": v.view_type, "index": v.index })),
        "columns": columns, "groups": groups,
        "count": result.count, "total": result.total,
        "returned": limit.saturating_sub(left), "truncated": result.count > limit.saturating_sub(left),
        "summaries": result.summaries.iter().map(|(k, v)| (k.clone(), v.to_display(tz))).collect::<std::collections::BTreeMap<_, _>>(),
        "errors": result.errors.iter().map(|e| format!("{e:?}")).collect::<Vec<_>>(),
    });
    let table = markdown_table(&result, tz, limit);
    if format == "markdown" {
        out["markdown"] = json!(table);
        return Ok(ToolOutput { text: table, structured: Some(out), extra: Vec::new() });
    }
    Ok(json_out(out))
}

/// The view's rows as a Markdown table.
fn markdown_table(r: &vault_bases::ViewResult, tz: i32, limit: usize) -> String {
    let cell = |s: &str| s.replace('|', "\\|").replace('\n', " ");
    let mut out = String::new();
    let headers: Vec<String> = r.columns.iter().map(|c| cell(&c.name)).collect();
    if headers.is_empty() {
        return "(this view has no columns)".into();
    }
    out.push_str(&format!("| {} |\n", headers.join(" | ")));
    out.push_str(&format!("| {} |\n", headers.iter().map(|_| "---").collect::<Vec<_>>().join(" | ")));
    let mut left = limit;
    for g in &r.groups {
        if g.has_key {
            out.push_str(&format!("| **{}** |{}\n", cell(&g.key.to_display(tz)), " |".repeat(headers.len().saturating_sub(1))));
        }
        for row in g.rows.iter().take(left) {
            let cells: Vec<String> = r
                .columns
                .iter()
                .map(|c| row.cells.get(&c.id).map(|x| if x.is_null() { String::new() } else { cell(&x.to_display(tz)) }).unwrap_or_default())
                .collect();
            out.push_str(&format!("| {} |\n", cells.join(" | ")));
        }
        left = left.saturating_sub(g.rows.len().min(left));
    }
    if r.count > limit {
        out.push_str(&format!("\n{} of {} rows shown.\n", limit, r.count));
    }
    out
}

// ---- export ----------------------------------------------------------------------------

/// Where an export may write. A path inside the vault goes through the usual
/// confinement; an absolute path needs `outside_vault: true`.
fn export_target(s: &Server, to: &str, a: &Map<String, Value>, what: &str) -> Result<(PathBuf, String, bool), ToolError> {
    let to = to.trim();
    if to.is_empty() {
        return Err("`to` is empty".into());
    }
    let b = to.as_bytes();
    let absolute = to.starts_with('/') || to.starts_with('~') || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':');
    if !absolute {
        let rel = fsx::clean_rel(to)?;
        let full = fsx::confined(&s.root, &rel)?;
        return Ok((full, rel, false));
    }
    if !opt_bool(a, "outside_vault", false)? {
        return Err(format!(
            "`{to}` is outside the vault. {what} to a vault-relative path such as `Exports/site`, or pass outside_vault: true to allow writing outside the vault folder"
        )
        .into());
    }
    let expanded = match to.strip_prefix("~/") {
        Some(rest) => match std::env::var("HOME") {
            Ok(home) if !home.is_empty() => PathBuf::from(home).join(rest),
            _ => return Err("cannot expand `~`: HOME is not set; give a full absolute path".into()),
        },
        None => PathBuf::from(to),
    };
    if expanded.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("`{to}` contains `..`; give a plain absolute path").into());
    }
    if expanded.parent().is_none() {
        return Err(format!("`{to}` is a filesystem root").into());
    }
    let display = expanded.display().to_string();
    Ok((expanded, display, true))
}

fn t_export_note(s: &Server, a: &Map<String, Value>) -> R {
    let path = s.resolve_note(req_str(a, "path")?)?;
    let (full, shown, outside) = export_target(s, req_str(a, "to")?, a, "Write the HTML")?;
    let full = if full.extension().is_some() { full } else { full.with_extension("html") };
    let overwrite = opt_bool(a, "overwrite", false)?;
    if full.symlink_metadata().is_ok() && !overwrite {
        return Err(format!("already exists: {shown} (pass overwrite: true to replace it)").into());
    }
    if full.is_dir() {
        return Err(format!("{shown} is a folder").into());
    }
    let html = note_html(s, &path, theme_of(a)?);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    fs::write(&full, html.as_bytes()).map_err(|e| format!("{}: {e}", full.display()))?;
    Ok(done(
        format!("Wrote {} ({} KB) from {path}", full.display(), html.len() / 1024),
        json!({ "path": path, "written": full.display().to_string(), "bytes": html.len(), "outside_vault": outside }),
    ))
}

fn t_export_vault(s: &Server, a: &Map<String, Value>) -> R {
    let dry = opt_bool(a, "dry_run", false)?;
    let (dir, shown, _) = export_target(s, req_str(a, "to")?, a, "Publish the site")?;
    if dir.starts_with(&s.root) {
        return Err(format!(
            "{shown} is inside the vault: publishing there would add the whole site to the vault. Choose a folder outside it and pass outside_vault: true"
        )
        .into());
    }
    if dir.is_file() {
        return Err(format!("{shown} is a file, not a folder").into());
    }
    if dir.is_dir() && fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(format!("{shown} is not empty; publishing would mix the site with what is already there — choose a new folder").into());
    }
    let mut options = vault_publish::SiteOptions { site_name: opt_str(a, "site_name")?.unwrap_or("").to_string(), ..Default::default() };
    if options.site_name.is_empty() {
        options.site_name = s.vault.name();
    }
    if let Some(h) = opt_str(a, "home")? {
        options.home = Some(s.resolve_note(h)?);
    }
    if let Some(b) = opt_str(a, "base_url")? {
        options.base_url = b.to_string();
    }
    options.include = string_list(a, "include")?;
    options.exclude = string_list(a, "exclude")?;
    options.noindex = opt_bool(a, "noindex", false)?;
    options.strict_line_breaks = s.vault.config_bool("strictLineBreaks");
    options.now_ms = vault::now_ms();
    let notes: Vec<vault_publish::InputFile> = s.vault.index.note_paths().into_iter().map(|p| commands::input_note(&s.vault, p)).collect();
    let mut input = vault_publish::SiteExportInput { files: notes, options };
    let published = vault_publish::published_notes(&input);
    if published.is_empty() {
        return Err("no notes would be published; check `include` and `exclude`".into());
    }
    if dry {
        return Ok(done(
            format!("Would publish {} note(s) to {shown} (nothing was written)", published.len()),
            json!({ "dry_run": true, "to": shown, "notes": published.len(), "pages": published.iter().take(50).collect::<Vec<_>>() }),
        ));
    }
    let mut extra: BTreeSet<String> = commands::referenced_attachments(&s.vault, &published, 3);
    for f in ["publish.css", "favicon.ico", "favicon-32x32.png", "favicon.png", "favicon.svg"] {
        if s.vault.index.file(f).is_some() {
            extra.insert(f.to_string());
        }
    }
    for p in &extra {
        if let Some(f) = commands::input_binary(&s.vault, p) {
            input.files.push(f);
        }
    }
    let site = vault_publish::export_site(&input);
    let mut bytes = 0usize;
    for f in &site {
        let p = dir.join(&f.path);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::write(&p, &f.bytes).map_err(|e| format!("{}: {e}", p.display()))?;
        bytes += f.bytes.len();
    }
    let pages = site.iter().filter(|f| f.path.ends_with(".html")).count();
    Ok(done(
        format!(
            "Published {} note(s) to {shown}: {} files, {pages} pages, {:.1} MB. Serve it with any static server, e.g. `python3 -m http.server -d {shown}`.",
            published.len(),
            site.len(),
            bytes as f64 / 1e6
        ),
        json!({ "to": shown, "notes": published.len(), "files": site.len(), "pages": pages, "bytes": bytes }),
    ))
}

fn string_list(a: &Map<String, Value>, key: &str) -> Result<Vec<String>, ToolError> {
    match a.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(v)) => v
            .iter()
            .map(|x| x.as_str().map(str::to_string).ok_or_else(|| format!("`{key}` must be an array of strings").into()))
            .collect(),
        Some(Value::String(s)) => Ok(s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()),
        Some(_) => Err(format!("`{key}` must be an array of strings").into()),
    }
}

// ---- clip ------------------------------------------------------------------------------

fn t_clip_html(s: &mut Server, a: &Map<String, Value>) -> R {
    let url = opt_str(a, "url")?.map(str::trim).filter(|u| !u.is_empty());
    let html_arg = opt_str(a, "html")?;
    let (html, url) = match (html_arg, url) {
        (Some(h), u) => (h.to_string(), u.unwrap_or("about:blank").to_string()),
        (None, Some(u)) => {
            if !u.starts_with("http://") && !u.starts_with("https://") {
                return Err(format!("`url` must start with http:// or https:// (got {u})").into());
            }
            (commands::fetch(u)?, u.to_string())
        }
        (None, None) => return Err("give `html` (the page source) or `url` (which fetches it over the network)".into()),
    };
    let tpl_json = match opt_str(a, "template")? {
        None => commands::DEFAULT_CLIP_TEMPLATE.to_string(),
        Some(t) if t.trim_start().starts_with('{') => t.to_string(),
        Some(t) => {
            let rel = s.resolve_existing(t)?;
            fsx::read_text(&fsx::confined(&s.root, &rel)?, &rel)?.text
        }
    };
    let tpl = vault_clip::parse_template_json(&tpl_json).map_err(|e| format!("`template` is not a valid Web Clipper template: {e}"))?;
    let types = vault::read_json(&s.root.join(".obsidian/types.json"));
    let property_types: Vec<(String, String)> = types
        .get("types")
        .and_then(|t| t.as_object())
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|x| (k.clone(), x.to_string()))).collect())
        .unwrap_or_default();
    let tz = vault::local_offset_minutes();
    let result = vault_clip::clip_page(&html, &url, &tpl, &property_types, vault::now_ms(), tz);
    let name = match opt_str(a, "name")? {
        Some(n) => vault_clip::import::sanitize_file_name(n.trim().trim_end_matches(".md")),
        None => vault_clip::import::sanitize_file_name(result.note_name.trim()),
    };
    let name = if name.is_empty() { "Untitled".to_string() } else { name };
    let folder = opt_str(a, "folder")?.unwrap_or(&tpl.path).trim_matches('/').to_string();
    if opt_bool(a, "dry_run", false)? {
        return Ok(ToolOutput {
            text: result.full_content.clone(),
            structured: Some(json!({ "dry_run": true, "would_create": format!("{}{name}.md", if folder.is_empty() { String::new() } else { format!("{folder}/") }), "url": url, "markdown": result.full_content })),
            extra: Vec::new(),
        });
    }
    let wanted = if folder.is_empty() { format!("{name}.md") } else { format!("{folder}/{name}.md") };
    let rel = fsx::clean_rel(&wanted)?;
    let rel = free_path(&s.root, &rel)?;
    s.write_file(&rel, &fsx::TextFile::new(fsx::lf(&result.full_content)))?;
    let warnings: Vec<String> = result.errors.iter().map(|e| format!("{e:?}")).collect();
    Ok(done(
        format!("Clipped {url} → {rel}{}", if warnings.is_empty() { String::new() } else { format!(" ({} warning(s))", warnings.len()) }),
        json!({ "path": rel, "url": url, "bytes": result.full_content.len(), "warnings": warnings }),
    ))
}

/// `rel`, or `rel 1.md`, `rel 2.md` … — the first that does not exist.
fn free_path(root: &Path, rel: &str) -> Result<String, String> {
    if !fsx::confined(root, rel)?.symlink_metadata().is_ok() {
        return Ok(rel.to_string());
    }
    let (stem, ext) = match rel.rfind('.') {
        Some(i) if i > rel.rfind('/').map(|j| j + 1).unwrap_or(0) => (&rel[..i], &rel[i..]),
        _ => (rel, ""),
    };
    for n in 1..10_000 {
        let candidate = format!("{stem} {n}{ext}");
        if !fsx::confined(root, &candidate)?.symlink_metadata().is_ok() {
            return Ok(candidate);
        }
    }
    Err(format!("too many files named like {rel}"))
}

// ---- import ----------------------------------------------------------------------------

fn t_import_notes(s: &mut Server, a: &Map<String, Value>) -> R {
    use vault_clip::import;
    let kind = req_str(a, "kind")?.trim().to_lowercase();
    let sources = string_list(a, "source")?;
    if sources.is_empty() {
        return Err("`source` needs at least one path on this computer".into());
    }
    let to = req_str(a, "to")?.trim().trim_matches('/').to_string();
    let folder = if to.is_empty() { String::new() } else { fsx::clean_rel(&to)? };
    let apply = opt_bool(a, "apply", false)?;
    let limit = opt_usize(a, "limit", 100, 1, 1000)?;
    let options_json = match a.get("options") {
        None | Some(Value::Null) => "{}".to_string(),
        Some(v @ Value::Object(_)) => v.to_string(),
        Some(_) => return Err("`options` must be an object".into()),
    };
    fn opts<T: serde::de::DeserializeOwned + Default>(json: &str) -> T {
        serde_json::from_str(json).unwrap_or_default()
    }
    const KINDS: [&str; 9] = ["enex", "html", "notion", "roam", "keep", "bear", "logseq", "csv", "textbundle"];
    if !KINDS.contains(&kind.as_str()) {
        return Err(format!("unknown import kind `{kind}` (one of: {})", KINDS.join(", ")).into());
    }
    let files = commands::read_inputs(&sources)?;
    if files.is_empty() {
        return Err(format!("nothing to import: {} held no readable files", sources.join(", ")).into());
    }
    let first_text = || files.first().map(|f| String::from_utf8_lossy(&f.1).into_owned()).unwrap_or_default();
    let result = match kind.as_str() {
        "enex" => {
            let mut all = import::ImportResult::default();
            for (_, data) in &files {
                let r = import::enex::convert(&String::from_utf8_lossy(data), &opts(&options_json));
                all.files.extend(r.files);
                all.warnings.extend(r.warnings);
            }
            all
        }
        "html" => import::html_files::convert(&files, &opts(&options_json)),
        "notion" => {
            let unpacked = if files.len() == 1 && files[0].0.to_lowercase().ends_with(".zip") {
                vault_clip::zip::read_zip(&files[0].1).map(|e| e.into_iter().map(|e| (e.name, e.data)).collect::<Vec<_>>()).map_err(|e| format!("this .zip could not be read: {e:?}"))?
            } else {
                files.clone()
            };
            import::notion::convert_with(&unpacked, &opts(&options_json))
        }
        "roam" => import::roam::convert(&first_text(), &opts(&options_json)),
        "keep" => import::keep::convert_with(&files, &opts(&options_json)),
        "bear" => import::bear::convert_with(&files.first().map(|f| f.1.clone()).unwrap_or_default(), &opts(&options_json)),
        "logseq" => import::logseq::convert_with(&files, &opts(&options_json)),
        "csv" => import::csv::convert(&first_text(), &opts(&options_json)),
        "textbundle" => import::textbundle::convert(&files),
        other => return Err(format!("unknown import kind `{other}` (one of: {})", KINDS.join(", ")).into()),
    };
    if result.files.is_empty() {
        return Err(format!(
            "the {kind} importer found nothing to import in {}{}",
            sources.join(", "),
            if result.warnings.is_empty() { String::new() } else { format!(" ({})", result.warnings.join("; ")) }
        )
        .into());
    }
    let notes = result.files.iter().filter(|f| Vault::is_note(&f.path)).count();
    let planned: Vec<String> = result
        .files
        .iter()
        .map(|f| if folder.is_empty() { f.path.trim_start_matches('/').to_string() } else { format!("{folder}/{}", f.path.trim_start_matches('/')) })
        .collect();
    if !apply {
        return Ok(done(
            format!(
                "Preview only — nothing was written. {} file(s) ({notes} note(s)) would be imported into {}. Call again with apply: true to write them.",
                result.files.len(),
                if folder.is_empty() { "the vault root".into() } else { folder.clone() }
            ),
            json!({
                "applied": false, "kind": kind, "to": folder, "files": result.files.len(), "notes": notes,
                "would_create": planned.iter().take(limit).collect::<Vec<_>>(),
                "truncated": planned.len() > limit, "warnings": result.warnings
            }),
        ));
    }
    let mut written: Vec<String> = Vec::new();
    for (f, wanted) in result.files.iter().zip(&planned) {
        let rel = fsx::clean_rel(wanted).map_err(|e| format!("the importer produced a path this server will not write: {e}"))?;
        let rel = free_path(&s.root, &rel)?;
        let full = fsx::confined(&s.root, &rel)?;
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{rel}: {e}"))?;
        }
        fsx::write_atomic(&full, &rel, &f.data)?;
        written.push(rel);
    }
    s.refresh();
    Ok(done(
        format!(
            "Imported {} file(s) ({notes} note(s)) into {}{}",
            written.len(),
            if folder.is_empty() { "the vault root".into() } else { folder.clone() },
            if result.warnings.is_empty() { String::new() } else { format!("; {} warning(s)", result.warnings.len()) }
        ),
        json!({
            "applied": true, "kind": kind, "to": folder, "files": written.len(), "notes": notes,
            "created": written.iter().take(limit).collect::<Vec<_>>(), "warnings": result.warnings
        }),
    ))
}
