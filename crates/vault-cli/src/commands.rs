//! One function per subcommand.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use vault_index::{GraphOptions, RenameOptions, SearchOptions};

use crate::vault::{self, Vault};
use crate::{Args, USAGE};

type Out<'a> = &'a mut dyn Write;

macro_rules! outln {
    ($out:expr) => { writeln!($out).map_err(|e| e.to_string())? };
    ($out:expr, $($arg:tt)*) => { writeln!($out, $($arg)*).map_err(|e| e.to_string())? };
}

fn open(args: &Args) -> Result<Vault, String> {
    let start = match args.get("vault") {
        Some(v) => PathBuf::from(v),
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    let root = if args.has("vault") { start.canonicalize().unwrap_or(start) } else { vault::find_root(&start) };
    Vault::open(&root)
}

fn print_json(out: Out, v: &impl serde::Serialize) -> Result<(), String> {
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    outln!(out, "{s}");
    Ok(())
}

pub fn dispatch(args: &Args, out: Out) -> Result<i32, String> {
    let Some(cmd) = args.positional.first() else {
        write!(out, "{USAGE}").map_err(|e| e.to_string())?;
        return Ok(0);
    };
    let rest = Args { positional: args.positional[1..].to_vec(), flags: args.flags.clone() };
    match cmd.as_str() {
        "help" | "--help" | "-h" => {
            write!(out, "{USAGE}").map_err(|e| e.to_string())?;
            Ok(0)
        }
        "info" => info(&rest, out),
        "search" => search(&rest, out),
        "backlinks" => backlinks(&rest, out),
        "links" => links(&rest, out),
        "unresolved" => unresolved(&rest, out),
        "tags" => tags(&rest, out),
        "graph" => graph(&rest, out),
        "render" => render(&rest, out),
        "export-html" => export_html(&rest, out),
        "publish" => publish(&rest, out),
        "base" => base(&rest, out),
        "clip" => clip(&rest, out),
        "import" => import(&rest, out),
        "convert-format" => convert_format(&rest, out),
        "rename" => rename(&rest, out),
        "daily" => daily(&rest, out),
        "new" => new_note(&rest, out),
        "mcp" => crate::mcp::command(&rest, out),
        other => Err(format!("unknown command `{other}` (see `vault help`)")),
    }
}

// ---- info / search / links / tags / graph ---------------------------------------

fn info(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let notes = v.index.note_count();
    let attachments = v.files.len() - notes;
    let size: u64 = v.files.iter().map(|f| f.size).sum();
    let tags = v.index.tags();
    let resolved = v.index.resolved_links();
    let unresolved = v.index.unresolved_links();
    let link_count: u32 = resolved.values().flat_map(|m| m.values()).sum();
    let broken: u32 = unresolved.values().flat_map(|m| m.values()).sum();
    let broken_targets: BTreeSet<&String> = unresolved.values().flat_map(|m| m.keys()).collect();
    let linked: HashSet<&String> = resolved.iter().filter(|(_, m)| !m.is_empty()).map(|(s, _)| s).chain(resolved.values().flat_map(|m| m.keys())).collect();
    let orphans = v.index.note_paths().into_iter().filter(|p| !linked.contains(&p.to_string())).count();
    let mut top: Vec<(&String, &u32)> = tags.iter().collect();
    top.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    if args.has("json") {
        print_json(
            out,
            &json!({
                "name": v.name(), "path": v.root, "notes": notes, "attachments": attachments, "bytes": size,
                "links": link_count, "brokenLinks": broken, "brokenTargets": broken_targets, "orphans": orphans,
                "tags": tags, "newLinkFormat": v.config_str("newLinkFormat").unwrap_or_else(|| "shortest".into()),
                "useMarkdownLinks": v.config_bool("useMarkdownLinks"), "attachmentFolderPath": v.config_str("attachmentFolderPath").unwrap_or_else(|| "/".into()),
            }),
        )?;
        return Ok(0);
    }
    outln!(out, "vault        {}", v.name());
    outln!(out, "path         {}", v.root.display());
    outln!(out, "notes        {notes}");
    outln!(out, "attachments  {attachments}");
    outln!(out, "size         {:.1} MB", size as f64 / 1e6);
    outln!(out, "links        {link_count} resolved, {broken} broken ({} distinct targets)", broken_targets.len());
    outln!(out, "orphans      {orphans}");
    outln!(out, "tags         {} distinct", tags.len());
    if !top.is_empty() {
        let list: Vec<String> = top.iter().take(10).map(|(t, n)| format!("{t} ({n})")).collect();
        outln!(out, "top tags     {}", list.join(", "));
    }
    outln!(
        out,
        "settings     newLinkFormat={} useMarkdownLinks={} attachmentFolderPath={}",
        v.config_str("newLinkFormat").unwrap_or_else(|| "shortest".into()),
        v.config_bool("useMarkdownLinks"),
        v.config_str("attachmentFolderPath").unwrap_or_else(|| "/".into())
    );
    if !broken_targets.is_empty() {
        let list: Vec<&str> = broken_targets.iter().take(10).map(|s| s.as_str()).collect();
        outln!(out, "broken       {}{}", list.join(", "), if broken_targets.len() > 10 { ", …" } else { "" });
    }
    Ok(0)
}

fn search(args: &Args, out: Out) -> Result<i32, String> {
    let query = args.positional.join(" ");
    if query.trim().is_empty() {
        return Err("missing search query".into());
    }
    let v = open(args)?;
    let limit = match args.get("limit") {
        Some(l) => Some(l.parse::<usize>().map_err(|_| format!("--limit: not a number: {l}"))?),
        None => None,
    };
    let opts = SearchOptions { case_sensitive: args.has("case-sensitive"), limit, ..Default::default() };
    let res = v.index.search(&query, &opts);
    if let Some(e) = &res.error {
        return Err(format!("search: {e}"));
    }
    if args.has("json") {
        print_json(out, &res)?;
        return Ok(0);
    }
    for r in &res.results {
        outln!(out, "{} ({} {})", r.path, r.match_count, if r.match_count == 1 { "match" } else { "matches" });
        let mut lines: Vec<&vault_index::ContentMatch> = r.content_matches.iter().collect();
        lines.dedup_by_key(|m| m.line);
        for m in lines.iter().take(5) {
            let text = m.context.text.replace('\n', " ");
            outln!(out, "  {}: {}", m.line + 1, text.trim());
        }
        if lines.len() > 5 {
            outln!(out, "  … {} more lines", lines.len() - 5);
        }
    }
    outln!(out, "{} files, {} matches", res.file_count, res.match_count);
    Ok(if res.results.is_empty() { 1 } else { 0 })
}

fn backlinks(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let path = v.resolve_note(args.pos(0, "note")?)?;
    let bl = v.index.backlinks(&path);
    if args.has("json") {
        print_json(out, &bl)?;
        return Ok(0);
    }
    for b in &bl {
        outln!(out, "{} ({})", b.source, b.refs.len());
        for r in &b.refs {
            let line = r.position.map(|p| format!("{}: ", p.start.line + 1)).unwrap_or_else(|| format!("{}: ", r.key.clone().unwrap_or_default()));
            let ctx = r.context.as_ref().map(|c| c.text.replace('\n', " ")).unwrap_or_else(|| r.original.clone());
            outln!(out, "  {line}{}", ctx.trim());
        }
    }
    outln!(out, "{} backlinks to {path}", bl.len());
    Ok(0)
}

fn links(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let path = v.resolve_note(args.pos(0, "note")?)?;
    let resolved = v.index.resolved_links().remove(&path).unwrap_or_default();
    let unresolved = v.index.unresolved_links().remove(&path).unwrap_or_default();
    if args.has("json") {
        print_json(out, &json!({ "path": path, "resolved": resolved, "unresolved": unresolved }))?;
        return Ok(0);
    }
    for (t, n) in &resolved {
        outln!(out, "{t}{}", if *n > 1 { format!(" ×{n}") } else { String::new() });
    }
    for (t, n) in &unresolved {
        outln!(out, "{t} (unresolved){}", if *n > 1 { format!(" ×{n}") } else { String::new() });
    }
    Ok(0)
}

fn unresolved(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let table = v.index.unresolved_links();
    let mut by_target: BTreeMap<String, Vec<(String, u32)>> = BTreeMap::new();
    for (source, targets) in &table {
        for (t, n) in targets {
            by_target.entry(t.clone()).or_default().push((source.clone(), *n));
        }
    }
    if args.has("json") {
        let v: BTreeMap<&String, Vec<Value>> = by_target.iter().map(|(t, s)| (t, s.iter().map(|(p, n)| json!({"source": p, "count": n})).collect())).collect();
        print_json(out, &v)?;
        return Ok(0);
    }
    for (t, sources) in &by_target {
        let list: Vec<String> = sources.iter().map(|(p, n)| if *n > 1 { format!("{p} ×{n}") } else { p.clone() }).collect();
        outln!(out, "{t}  ← {}", list.join(", "));
    }
    outln!(out, "{} unresolved targets", by_target.len());
    Ok(0)
}

fn tags(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let tags = v.index.tags();
    if args.has("json") {
        print_json(out, &tags)?;
        return Ok(0);
    }
    let mut list: Vec<(&String, &u32)> = tags.iter().collect();
    if args.get("sort") != Some("name") {
        list.sort_by(|a, b| b.1.cmp(a.1).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    }
    let width = list.iter().map(|(t, _)| t.chars().count()).max().unwrap_or(0);
    for (t, n) in list {
        outln!(out, "{t:<width$}  {n}");
    }
    Ok(0)
}

fn graph(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let opts = GraphOptions { show_orphans: true, ..Default::default() };
    let g = v.index.graph(&opts);
    if args.has("json") {
        print_json(out, &g)?;
        return Ok(0);
    }
    let unresolved = g.nodes.iter().filter(|n| n.kind == vault_index::NodeKind::Unresolved).count();
    outln!(out, "{} nodes ({} unresolved), {} links", g.nodes.len(), unresolved, g.links.len());
    let mut top: Vec<&vault_index::GraphNode> = g.nodes.iter().collect();
    top.sort_by(|a, b| b.weight.cmp(&a.weight));
    for n in top.iter().take(10) {
        outln!(out, "  {:>4}  {}", n.weight, n.id);
    }
    outln!(out, "use --json for the full graph");
    Ok(0)
}

// ---- render / export / publish --------------------------------------------------------

fn render(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let path = v.resolve_note(args.pos(0, "note")?)?;
    let strict = v.config_bool("strictLineBreaks");
    let rendered = vault_ofm::render(v.text(&path), &vault_ofm::RenderOptions { strict_line_breaks: strict });
    if args.has("json") {
        print_json(out, &rendered)?;
    } else if args.has("html") {
        for s in &rendered.sections {
            if !s.html.is_empty() {
                outln!(out, "{}", s.html);
            }
        }
    } else {
        for s in &rendered.sections {
            let text = plain_text(&s.html);
            if !text.is_empty() {
                outln!(out, "{text}\n");
            }
        }
    }
    Ok(0)
}

/// Rendered HTML → readable text: block ends become line breaks.
fn plain_text(html: &str) -> String {
    let mut s = html.to_string();
    for tag in ["</p>", "</li>", "</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>", "<br>", "</tr>", "</div>", "</pre>"] {
        s = s.replace(tag, &format!("{tag}\n"));
    }
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
    out.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")
}

fn input_note(v: &Vault, path: &str) -> vault_publish::InputFile {
    let f = v.files.iter().find(|f| f.path == path);
    let mut i = vault_publish::InputFile::note(path, v.text(path));
    if let Some(f) = f {
        i.mtime = f.mtime;
        i.ctime = f.ctime;
    }
    i
}

fn input_binary(v: &Vault, path: &str) -> Option<vault_publish::InputFile> {
    let bytes = v.read_bytes(path)?;
    let mut i = vault_publish::InputFile::binary(path, bytes);
    if let Some(f) = v.files.iter().find(|f| f.path == path) {
        i.mtime = f.mtime;
        i.ctime = f.ctime;
    }
    Some(i)
}

/// Attachments (non-notes) that `notes` link to or embed, following note
/// embeds `depth` levels deep.
fn referenced_attachments(v: &Vault, notes: &[String], depth: u32) -> BTreeSet<String> {
    let resolved = v.index.resolved_links();
    let mut out = BTreeSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut frontier: Vec<String> = notes.to_vec();
    for _ in 0..=depth {
        let mut next = Vec::new();
        for n in frontier.drain(..) {
            if !seen.insert(n.clone()) {
                continue;
            }
            for target in resolved.get(&n).map(|m| m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
                if Vault::is_note(&target) {
                    next.push(target);
                } else {
                    out.insert(target);
                }
            }
            // `image:` / `cover:` properties (OpenGraph images).
            if let Some(fm) = v.index.note(&n).and_then(|note| note.meta.frontmatter.as_ref()) {
                for key in ["image", "cover"] {
                    if let Some(s) = fm.get(key).and_then(|x| x.as_str()) {
                        let s = s.trim().trim_start_matches("![[").trim_start_matches("[[").trim_end_matches("]]");
                        if let Some(p) = v.resolve_file(s).filter(|p| !Vault::is_note(p)) {
                            out.insert(p);
                        }
                    }
                }
            }
        }
        frontier = next;
    }
    out
}

fn export_html(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let path = v.resolve_note(args.pos(0, "note")?)?;
    let mut files: Vec<vault_publish::InputFile> = v.index.note_paths().into_iter().map(|p| input_note(&v, p)).collect();
    for a in referenced_attachments(&v, std::slice::from_ref(&path), 3) {
        if let Some(f) = input_binary(&v, &a) {
            files.push(f);
        }
    }
    let mut input = vault_publish::NoteExportInput { path: path.clone(), files, ..Default::default() };
    input.options.strict_line_breaks = v.config_bool("strictLineBreaks");
    if args.has("light") {
        input.options.theme = vault_publish::Theme::Light;
    } else if args.has("dark") {
        input.options.theme = vault_publish::Theme::Dark;
    }
    let html = vault_publish::export_note(&input);
    match args.get("o") {
        Some(o) if o != "-" => {
            let target = PathBuf::from(o);
            if let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty()) {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&target, &html).map_err(|e| format!("{}: {e}", target.display()))?;
            outln!(out, "wrote {} ({} KB)", target.display(), html.len() / 1024);
        }
        _ => write!(out, "{html}").map_err(|e| e.to_string())?,
    }
    Ok(0)
}

fn publish(args: &Args, out: Out) -> Result<i32, String> {
    let target = PathBuf::from(args.get("o").ok_or("publish needs -o <dir>")?);
    let v = open(args)?;
    let mut options: vault_publish::SiteOptions = match args.get("options") {
        Some(p) => serde_json::from_str(&fs::read_to_string(p).map_err(|e| format!("{p}: {e}"))?).map_err(|e| format!("{p}: {e}"))?,
        None => vault_publish::SiteOptions::default(),
    };
    if let Some(h) = args.get("home") {
        options.home = Some(h.to_string());
    }
    if let Some(n) = args.get("name") {
        options.site_name = n.to_string();
    }
    if options.site_name.is_empty() {
        options.site_name = v.name();
    }
    if let Some(b) = args.get("base-url") {
        options.base_url = b.to_string();
    }
    if args.has("include") {
        options.include = args.list("include");
    }
    if args.has("exclude") {
        options.exclude = args.list("exclude");
    }
    if args.has("noindex") {
        options.noindex = true;
    }
    options.strict_line_breaks = options.strict_line_breaks || v.config_bool("strictLineBreaks");
    options.now_ms = vault::now_ms();
    let notes: Vec<vault_publish::InputFile> = v.index.note_paths().into_iter().map(|p| input_note(&v, p)).collect();
    let mut input = vault_publish::SiteExportInput { files: notes, options };
    let published = vault_publish::published_notes(&input);
    let mut extra: BTreeSet<String> = referenced_attachments(&v, &published, 3);
    for f in ["publish.css", "favicon.ico", "favicon-32x32.png", "favicon-32.png", "favicon.png", "favicon.svg"] {
        if v.index.file(f).is_some() {
            extra.insert(f.to_string());
        }
    }
    if let Some(logo) = input.options.logo.clone() {
        if let Some(p) = v.resolve_file(&logo) {
            input.options.logo = Some(p.clone());
            extra.insert(p);
        }
    }
    for a in &extra {
        if let Some(f) = input_binary(&v, a) {
            input.files.push(f);
        }
    }
    let site = vault_publish::export_site(&input);
    let mut bytes = 0usize;
    for f in &site {
        let p = target.join(&f.path);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::write(&p, &f.bytes).map_err(|e| format!("{}: {e}", p.display()))?;
        bytes += f.bytes.len();
    }
    let pages = site.iter().filter(|f| f.path.ends_with(".html")).count();
    outln!(out, "published {} notes → {} ({} files, {} html, {:.1} MB)", published.len(), target.display(), site.len(), pages, bytes as f64 / 1e6);
    outln!(out, "serve it with any static server, e.g. `python3 -m http.server -d {}`", target.display());
    Ok(0)
}

// ---- base --------------------------------------------------------------------------------

fn base(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let arg = args.pos(0, "base file")?;
    let found = v.resolve_file(arg).filter(|p| p.to_lowercase().ends_with(".base")).or_else(|| v.resolve_file(&format!("{}.base", arg.trim_end_matches(".base"))));
    let (yaml, this_path) = match found.filter(|p| p.to_lowercase().ends_with(".base")) {
        Some(p) => (fs::read_to_string(v.abs(&p)).map_err(|e| e.to_string())?, Some(p)),
        None => (fs::read_to_string(arg).map_err(|e| format!("{arg}: {e}"))?, None),
    };
    let base = vault_bases::parse_base(&yaml).map_err(|e| format!("{arg}: {e}"))?;
    let view = match args.get("view") {
        None => 0,
        Some(s) => match s.parse::<usize>() {
            Ok(n) => n,
            Err(_) => base.views.iter().position(|w| w.name.eq_ignore_ascii_case(s)).ok_or_else(|| format!("no view named {s}"))?,
        },
    };
    let records = v.file_records();
    let this = this_path.as_ref().and_then(|p| records.iter().find(|r| &r.path == p)).cloned();
    let tz = vault::local_offset_minutes();
    let result = vault_bases::run_view(&base, view, &records, this.as_ref(), vault::now_ms(), tz);
    if args.has("json") {
        print_json(out, &result)?;
        return Ok(0);
    }
    for e in &result.errors {
        eprintln!("warning: {e}");
    }
    let headers: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let grouped = result.groups.iter().any(|g| g.has_key);
    for g in &result.groups {
        if grouped {
            rows.push(vec![format!("▸ {}", if g.has_key { g.key.to_display(tz) } else { "(none)".into() })]);
        }
        for r in &g.rows {
            rows.push(
                result
                    .columns
                    .iter()
                    .map(|c| r.cells.get(&c.id).map(|x| if x.is_null() { String::new() } else { x.to_display(tz) }).unwrap_or_default())
                    .collect(),
            );
        }
    }
    if let Some(info) = &result.view {
        outln!(out, "{} ({}): {} of {} rows", info.name, info.view_type, result.count, result.total);
    }
    write_table(out, &headers, &rows)?;
    if !result.summaries.is_empty() {
        let parts: Vec<String> = result
            .summaries
            .iter()
            .map(|(id, val)| format!("{}: {}", result.columns.iter().find(|c| &c.id == id).map(|c| c.name.as_str()).unwrap_or(id), val.to_display(tz)))
            .collect();
        outln!(out, "summary  {}", parts.join("  "));
    }
    Ok(0)
}

fn write_table(out: Out, headers: &[String], rows: &[Vec<String>]) -> Result<(), String> {
    const MAX: usize = 48;
    let clip = |s: &str| -> String {
        let s = s.replace('\n', " ");
        if s.chars().count() > MAX {
            format!("{}…", s.chars().take(MAX - 1).collect::<String>())
        } else {
            s
        }
    };
    let mut widths: Vec<usize> = headers.iter().map(|h| clip(h).chars().count()).collect();
    for r in rows.iter().filter(|r| r.len() == headers.len()) {
        for (i, c) in r.iter().enumerate() {
            widths[i] = widths[i].max(clip(c).chars().count());
        }
    }
    let line = |cells: &[String]| -> String {
        cells.iter().enumerate().map(|(i, c)| format!("{:<w$}", clip(c), w = widths[i])).collect::<Vec<_>>().join("  ").trim_end().to_string()
    };
    outln!(out, "{}", line(headers));
    outln!(out, "{}", widths.iter().map(|w| "-".repeat(*w)).collect::<Vec<_>>().join("  "));
    for r in rows {
        if r.len() == headers.len() {
            outln!(out, "{}", line(r));
        } else {
            outln!(out, "{}", r.join(" "));
        }
    }
    Ok(())
}

// ---- clip / import / convert --------------------------------------------------------------

const DEFAULT_CLIP_TEMPLATE: &str = r#"{
  "schemaVersion": "0.1.0",
  "name": "Default",
  "behavior": "create",
  "noteNameFormat": "{{title}}",
  "path": "Clippings",
  "noteContentFormat": "{{content}}",
  "properties": [
    {"name": "title", "value": "{{title}}", "type": "text"},
    {"name": "source", "value": "{{url}}", "type": "text"},
    {"name": "author", "value": "{{author|split:\", \"|wikilink|join}}", "type": "multitext"},
    {"name": "published", "value": "{{published}}", "type": "date"},
    {"name": "created", "value": "{{date}}", "type": "date"},
    {"name": "description", "value": "{{description}}", "type": "text"},
    {"name": "tags", "value": "clippings", "type": "multitext"}
  ]
}"#;

/// Fetches a URL with the system `curl` (so the binary needs no HTTP or TLS
/// library).
fn fetch(url: &str) -> Result<String, String> {
    let output = std::process::Command::new("curl")
        .args(["-sSL", "--compressed", "--max-time", "60", "-A", "Mozilla/5.0 (compatible; vault-cli)", url])
        .output()
        .map_err(|e| format!("could not run curl (needed to fetch URLs; pass a saved .html file instead): {e}"))?;
    if !output.status.success() {
        return Err(format!("curl failed for {url}: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn clip(args: &Args, out: Out) -> Result<i32, String> {
    let src = args.pos(0, "URL or HTML file")?;
    let (html, url) = if src.starts_with("http://") || src.starts_with("https://") {
        (fetch(src)?, src.to_string())
    } else {
        let html = fs::read(src).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|e| format!("{src}: {e}"))?;
        let url = args.get("url").map(str::to_string).unwrap_or_else(|| {
            let abs = Path::new(src).canonicalize().unwrap_or_else(|_| PathBuf::from(src));
            format!("file://{}", abs.display())
        });
        (html, url)
    };
    let tpl_json = match args.get("template") {
        Some(p) => fs::read_to_string(p).map_err(|e| format!("{p}: {e}"))?,
        None => DEFAULT_CLIP_TEMPLATE.to_string(),
    };
    let tpl = vault_clip::parse_template_json(&tpl_json)?;
    let v = open(args)?;
    // Property types from `.obsidian/types.json` (`{"types": {name: type}}`).
    let types = vault::read_json(&v.root.join(".obsidian/types.json"));
    let property_types: Vec<(String, String)> = types
        .get("types")
        .and_then(|t| t.as_object())
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default();
    let tz = vault::local_offset_minutes();
    let result = vault_clip::clip_page(&html, &url, &tpl, &property_types, vault::now_ms(), tz);
    for e in &result.errors {
        eprintln!("warning: {e:?}");
    }
    let name = vault_clip::import::sanitize_file_name(result.note_name.trim());
    let name = if name.is_empty() { "Untitled".to_string() } else { name };
    let folder = args.get("o").map(str::to_string).unwrap_or_else(|| tpl.path.clone());
    let folder = folder.trim_matches('/');
    if args.has("dry-run") {
        outln!(out, "{}", result.full_content);
        return Ok(0);
    }
    let rel = unique_path(&v, &if folder.is_empty() { format!("{name}.md") } else { format!("{folder}/{name}.md") });
    v.write(&rel, result.full_content.as_bytes())?;
    outln!(out, "{rel}");
    Ok(0)
}

/// `path` or `path 1.md`, `path 2.md` … — the first that does not exist.
fn unique_path(v: &Vault, rel: &str) -> String {
    if !v.abs(rel).exists() {
        return rel.to_string();
    }
    let (stem, ext) = match rel.rfind('.') {
        Some(i) if i > rel.rfind('/').map(|j| j + 1).unwrap_or(0) => (&rel[..i], &rel[i..]),
        _ => (rel, ""),
    };
    (1..).map(|n| format!("{stem} {n}{ext}")).find(|p| !v.abs(p).exists()).unwrap_or_else(|| rel.to_string())
}

fn read_inputs(paths: &[String]) -> Result<Vec<(String, Vec<u8>)>, String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
        let mut entries: Vec<_> = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if p.is_dir() {
                walk(base, &p, out)?;
            } else {
                let rel = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                out.push((rel, fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))?));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            walk(path, path, &mut out)?;
        } else {
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.clone());
            out.push((name, fs::read(path).map_err(|e| format!("{p}: {e}"))?));
        }
    }
    Ok(out)
}

fn import(args: &Args, out: Out) -> Result<i32, String> {
    use vault_clip::import;
    let kind = args.pos(0, "import kind")?;
    let paths = args.positional[1..].to_vec();
    if paths.is_empty() {
        return Err("import needs at least one input path".into());
    }
    let target = args.get("o").ok_or("import needs -o <vault folder>")?;
    let options_json = match args.get("options") {
        Some(p) => fs::read_to_string(p).map_err(|e| format!("{p}: {e}"))?,
        None => "{}".into(),
    };
    fn opts<T: serde::de::DeserializeOwned + Default>(json: &str) -> T {
        serde_json::from_str(json).unwrap_or_default()
    }
    let files = read_inputs(&paths)?;
    let first_text = || files.first().map(|f| String::from_utf8_lossy(&f.1).into_owned()).unwrap_or_default();
    let result = match kind {
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
                vault_clip::zip::read_zip(&files[0].1).map(|e| e.into_iter().map(|e| (e.name, e.data)).collect::<Vec<_>>()).map_err(|e| format!("zip: {e:?}"))?
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
        other => return Err(format!("unknown import kind `{other}` (enex, html, notion, roam, keep, bear, logseq, csv, textbundle)")),
    };
    let root = PathBuf::from(target);
    let mut written = 0;
    for f in &result.files {
        let rel = f.path.trim_start_matches('/');
        let mut p = root.join(rel);
        if p.exists() {
            let s = p.to_string_lossy().to_string();
            let (stem, ext) = match s.rfind('.') {
                Some(i) if i > s.rfind('/').unwrap_or(0) => (s[..i].to_string(), s[i..].to_string()),
                _ => (s.clone(), String::new()),
            };
            p = (1..).map(|n| PathBuf::from(format!("{stem} {n}{ext}"))).find(|c| !c.exists()).unwrap();
        }
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::write(&p, &f.data).map_err(|e| format!("{}: {e}", p.display()))?;
        written += 1;
    }
    for w in &result.warnings {
        eprintln!("warning: {w}");
    }
    outln!(out, "imported {written} files into {} ({} warnings)", root.display(), result.warnings.len());
    Ok(0)
}

fn convert_format(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let all = args.has("all");
    let mut o = vault_clip::FormatConverterOptions::default();
    o.markdown_links_to_wikilinks = all || args.has("markdown-links");
    o.roam_tags = all || args.has("roam");
    o.roam_highlights = all || args.has("roam");
    o.roam_todos = all || args.has("roam");
    o.bear_highlights = all || args.has("bear");
    o.bear_multi_word_tags = all || args.has("bear");
    o.properties = all || args.has("properties");
    o.zettelkasten = match args.get("zettelkasten") {
        Some("pretty") => vault_clip::import::format_converter::ZettelkastenLinks::Pretty,
        Some(_) => vault_clip::import::format_converter::ZettelkastenLinks::Full,
        None if all => vault_clip::import::format_converter::ZettelkastenLinks::Full,
        None => vault_clip::import::format_converter::ZettelkastenLinks::Off,
    };
    if o == vault_clip::FormatConverterOptions::default() {
        return Err("choose conversions: --all, --markdown-links, --roam, --bear, --zettelkasten[=pretty], --properties".into());
    }
    o.file_names = v.index.note_paths().iter().map(|p| vault_publish::paths::note_title(p)).collect();
    let dry = args.has("dry-run");
    let mut changed = 0;
    for path in v.index.note_paths() {
        let text = v.text(path);
        let converted = vault_clip::format_convert(text, &o);
        if converted != text {
            changed += 1;
            let lines = text.lines().zip(converted.lines()).filter(|(a, b)| a != b).count() + text.lines().count().abs_diff(converted.lines().count());
            outln!(out, "{}{path} ({lines} lines)", if dry { "would change " } else { "changed " });
            if !dry {
                v.write(path, converted.as_bytes())?;
            }
        }
    }
    outln!(out, "{changed} of {} notes {}", v.index.note_count(), if dry { "would change" } else { "changed" });
    Ok(0)
}

// ---- rename / daily / new ----------------------------------------------------------------------

fn rename(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let old_arg = args.pos(0, "old path")?;
    let new_arg = args.pos(1, "new path")?.trim_matches('/').to_string();
    let (old, is_folder) = match v.resolve_file(old_arg) {
        Some(p) => (p, false),
        None => {
            let folder = old_arg.trim_matches('/').to_string();
            if v.abs(&folder).is_dir() {
                (folder, true)
            } else {
                return Err(format!("not found: {old_arg}"));
            }
        }
    };
    let new = if is_folder {
        new_arg
    } else {
        let mut n = new_arg;
        let old_ext = old.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default();
        let base = n.rsplit('/').next().unwrap_or(&n).to_string();
        if !old_ext.is_empty() && !base.to_lowercase().ends_with(&format!(".{}", old_ext.to_lowercase())) {
            n = format!("{n}.{old_ext}");
        }
        if !n.contains('/') {
            if let Some((dir, _)) = old.rsplit_once('/') {
                n = format!("{dir}/{n}");
            }
        }
        n
    };
    if v.abs(&new).exists() {
        return Err(format!("already exists: {new}"));
    }
    let edits = v.index.rename_edits(&old, &new, &RenameOptions { link_format: v.link_format() });
    let plan = v.index.rename_plan(&old, &new);
    if args.has("dry-run") {
        for (from, to) in &plan {
            outln!(out, "move {from} → {to}");
        }
        for e in &edits {
            outln!(out, "update {} ({} links)", e.path, e.edits.len());
            for t in &e.edits {
                outln!(out, "    → {}", t.text);
            }
        }
        return Ok(0);
    }
    let texts: Vec<(String, String)> =
        edits.iter().map(|e| (e.path.clone(), vault_index::apply_edits(v.text(&e.original_path), &e.edits))).collect();
    let dest = v.abs(&new);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(v.abs(&old), &dest).map_err(|e| format!("rename {old} → {new}: {e}"))?;
    for (path, text) in &texts {
        v.write(path, text.as_bytes())?;
    }
    let links: usize = edits.iter().map(|e| e.edits.len()).sum();
    outln!(out, "renamed {old} → {new} ({} files moved); updated {links} links in {} notes", plan.len(), texts.len());
    for (path, _) in &texts {
        outln!(out, "  {path}");
    }
    Ok(0)
}

/// Days since the epoch for a civil date (proleptic Gregorian).
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`, `{{time:FORMAT}}`
/// as the Templates core plugin fills them (formats are Moment tokens).
pub(crate) fn apply_template(tpl: &str, title: &str, ms: f64, tz: i32, date_format: &str, time_format: &str) -> String {
    let dt = vault_clip::date::DateTime::from_epoch_ms(ms, tz);
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(i) = rest.find("{{") {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find("}}") else {
            out.push_str(&rest[i..]);
            rest = "";
            break;
        };
        let inner = rest[i + 2..i + j].trim();
        let (name, fmt) = match inner.split_once(':') {
            Some((n, f)) => (n.trim(), Some(f.trim())),
            None => (inner, None),
        };
        let replaced = match name.to_lowercase().as_str() {
            "title" => Some(title.to_string()),
            "date" => Some(vault_clip::date::format(&dt, fmt.unwrap_or(date_format))),
            "time" => Some(vault_clip::date::format(&dt, fmt.unwrap_or(time_format))),
            _ => None,
        };
        match replaced {
            Some(r) => out.push_str(&r),
            None => out.push_str(&rest[i..i + j + 2]),
        }
        rest = &rest[i + j + 2..];
    }
    out.push_str(rest);
    out
}

pub(crate) fn template_settings(v: &Vault) -> (String, String) {
    let t = vault::read_json(&v.root.join(".obsidian/templates.json"));
    let date = t.get("dateFormat").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).unwrap_or("YYYY-MM-DD").to_string();
    let time = t.get("timeFormat").and_then(|x| x.as_str()).filter(|s| !s.is_empty()).unwrap_or("HH:mm").to_string();
    (date, time)
}

fn read_template(v: &Vault, arg: &str) -> Result<String, String> {
    if let Some(p) = v.resolve_file(arg).or_else(|| v.resolve_file(&format!("{}.md", arg.trim_end_matches(".md")))) {
        return Ok(v.text(&p).to_string());
    }
    fs::read_to_string(arg).map_err(|e| format!("template {arg}: {e}"))
}

fn daily(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let cfg = vault::read_json(&v.root.join(".obsidian/daily-notes.json"));
    let format = cfg.get("format").and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).unwrap_or("YYYY-MM-DD").to_string();
    let folder = cfg.get("folder").and_then(|x| x.as_str()).unwrap_or("").trim().trim_matches('/').to_string();
    let template = cfg.get("template").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let tz = vault::local_offset_minutes();
    let ms = match args.get("date") {
        Some(d) => {
            let parts: Vec<i64> = d.split('-').filter_map(|p| p.parse().ok()).collect();
            if parts.len() != 3 || !(1..=12).contains(&parts[1]) || !(1..=31).contains(&parts[2]) {
                return Err(format!("--date: expected YYYY-MM-DD, got {d}"));
            }
            // That local day at the current local time of day.
            let time_of_day = (vault::now_ms() + tz as f64 * 60_000.0).rem_euclid(86_400_000.0);
            (days_from_civil(parts[0], parts[1], parts[2]) as f64) * 86_400_000.0 - tz as f64 * 60_000.0 + time_of_day
        }
        None => vault::now_ms(),
    };
    let dt = vault_clip::date::DateTime::from_epoch_ms(ms, tz);
    let name = vault_clip::date::format(&dt, &format);
    let rel = if folder.is_empty() { format!("{name}.md") } else { format!("{folder}/{name}.md") };
    if !v.abs(&rel).exists() && !args.has("no-create") {
        let body = if template.is_empty() {
            String::new()
        } else {
            let (df, tf) = template_settings(&v);
            let title = name.rsplit('/').next().unwrap_or(&name).to_string();
            apply_template(&read_template(&v, &template)?, &title, ms, tz, &df, &tf)
        };
        v.write(&rel, body.as_bytes())?;
        eprintln!("created {rel}");
    }
    outln!(out, "{rel}");
    Ok(0)
}

fn new_note(args: &Args, out: Out) -> Result<i32, String> {
    let v = open(args)?;
    let name = args.pos(0, "note name")?.trim().trim_end_matches(".md").to_string();
    if name.is_empty() {
        return Err("empty note name".into());
    }
    let folder = match args.get("folder") {
        Some(f) => f.trim_matches('/').to_string(),
        None if name.contains('/') => String::new(),
        None => match v.config_str("newFileLocation").as_deref() {
            Some("folder") => v.config_str("newFileFolderPath").unwrap_or_default().trim_matches('/').to_string(),
            _ => String::new(),
        },
    };
    let rel = if folder.is_empty() { format!("{name}.md") } else { format!("{folder}/{name}.md") };
    if v.abs(&rel).exists() {
        return Err(format!("already exists: {rel}"));
    }
    let body = match args.get("template") {
        Some(t) => {
            let (df, tf) = template_settings(&v);
            let title = name.rsplit('/').next().unwrap_or(&name).to_string();
            apply_template(&read_template(&v, t)?, &title, vault::now_ms(), vault::local_offset_minutes(), &df, &tf)
        }
        None => String::new(),
    };
    v.write(&rel, body.as_bytes())?;
    outln!(out, "{rel}");
    Ok(0)
}

#[cfg(test)]
pub(crate) fn test_apply_template(tpl: &str, title: &str, ms: f64) -> String {
    apply_template(tpl, title, ms, 0, "YYYY-MM-DD", "HH:mm")
}
