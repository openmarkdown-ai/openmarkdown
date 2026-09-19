//! Run a base over a folder of Markdown notes and print the view as a table.
//!
//! ```text
//! cargo run -p vault-bases --example inspect -- <file.base | note.md> <vault-dir>
//!     [--view N|NAME] [--now 2025-06-15T12:00] [--tz MINUTES_EAST] [--json] [--all-views]
//! ```
//!
//! A `.md` first argument uses its first ```` ```base ```` block and makes that
//! note `this`. Frontmatter is parsed with the crate's YAML reader; tags, links
//! and embeds are pulled from the body with simple patterns (good enough to
//! exercise `hasTag`/`hasLink`; the real app uses vault-ofm + vault-index).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use vault_bases::{
    parse_base, parse_yaml, run_view_with, validate_base, FileRecord, RunOptions, Value, ViewResult,
};

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.path());
    for e in entries {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

fn split_frontmatter(text: &str) -> (Option<&str>, &str) {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    if let Some(rest) = t
        .strip_prefix("---\n")
        .or_else(|| t.strip_prefix("---\r\n"))
    {
        for (i, _) in rest.match_indices("\n---") {
            let after = &rest[i + 4..];
            if after.is_empty() || after.starts_with('\n') || after.starts_with("\r\n") {
                return (Some(&rest[..i + 1]), after.trim_start_matches(['\r', '\n']));
            }
        }
        if let Some(body) = rest.strip_prefix("---") {
            return (Some(""), body);
        }
    }
    (None, t)
}

fn scan_body(
    body: &str,
    tags: &mut Vec<String>,
    links: &mut Vec<String>,
    embeds: &mut Vec<String>,
) {
    let mut in_code = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        let b = line.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if line[i..].starts_with("![[") || line[i..].starts_with("[[") {
                let embed = b[i] == b'!';
                let start = i + if embed { 3 } else { 2 };
                if let Some(end) = line[start..].find("]]") {
                    let target = &line[start..start + end];
                    let target = target.split('|').next().unwrap_or("").to_string();
                    if embed {
                        embeds.push(target);
                    } else {
                        links.push(target);
                    }
                    i = start + end + 2;
                    continue;
                }
            }
            if b[i] == b'#' && (i == 0 || b[i - 1] == b' ') {
                let rest = &line[i + 1..];
                let tag: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || "_-/".contains(*c))
                    .collect();
                if !tag.is_empty() && !tag.chars().all(|c| c.is_ascii_digit()) {
                    tags.push(format!("#{tag}"));
                    i += 1 + tag.len();
                    continue;
                }
            }
            i += line[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        }
    }
}

fn frontmatter_links(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.starts_with("[[") && t.ends_with("]]") {
                out.push(
                    t[2..t.len() - 2]
                        .split('|')
                        .next()
                        .unwrap_or("")
                        .to_string(),
                );
            }
        }
        serde_json::Value::Array(a) => a.iter().for_each(|x| frontmatter_links(x, out)),
        serde_json::Value::Object(o) => o.values().for_each(|x| frontmatter_links(x, out)),
        _ => {}
    }
}

fn load_vault(root: &Path) -> Vec<FileRecord> {
    let mut paths = Vec::new();
    walk(root, &mut paths);
    let mut files: Vec<FileRecord> = Vec::new();
    for p in paths {
        let rel = p
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let mut r = FileRecord::new(rel);
        if let Ok(meta) = fs::metadata(&p) {
            r.size = meta.len() as f64;
            let t = |st: std::io::Result<std::time::SystemTime>| {
                st.ok()
                    .and_then(|x| x.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as f64)
                    .unwrap_or(0.0)
            };
            r.mtime = t(meta.modified());
            r.ctime = t(meta.created());
        }
        if r.ext == "md" {
            let text = fs::read_to_string(&p).unwrap_or_default();
            let (fm, body) = split_frontmatter(&text);
            if let Some(fm) = fm {
                match parse_yaml(fm) {
                    Ok(y) => {
                        if let serde_json::Value::Object(m) = y.to_json() {
                            r.properties = m;
                        }
                    }
                    Err(e) => eprintln!("warning: {}: frontmatter: {e}", r.path),
                }
            }
            let mut tags = Vec::new();
            for key in ["tags", "tag"] {
                match r.properties.get(key) {
                    Some(serde_json::Value::Array(a)) => tags.extend(
                        a.iter()
                            .filter_map(|x| x.as_str())
                            .map(|s| format!("#{}", s.trim_start_matches('#'))),
                    ),
                    Some(serde_json::Value::String(s)) => tags.extend(
                        s.split([',', ' '])
                            .filter(|x| !x.is_empty())
                            .map(|x| format!("#{}", x.trim_start_matches('#'))),
                    ),
                    _ => {}
                }
            }
            let mut links = Vec::new();
            for v in r.properties.values() {
                frontmatter_links(v, &mut links);
            }
            let mut embeds = Vec::new();
            scan_body(body, &mut tags, &mut links, &mut embeds);
            r.tags = tags;
            r.links = links;
            r.embeds = embeds;
        }
        files.push(r);
    }
    // Backlinks: resolve each link by exact path, path + .md, or basename.
    let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, f) in files.iter().enumerate() {
        by_name.entry(f.path.to_lowercase()).or_default().push(i);
        by_name
            .entry(f.path.trim_end_matches(".md").to_lowercase())
            .or_default()
            .push(i);
        by_name.entry(f.name.to_lowercase()).or_default().push(i);
        if f.ext == "md" {
            by_name
                .entry(f.basename.to_lowercase())
                .or_default()
                .push(i);
        }
    }
    let mut backlinks: Vec<Vec<String>> = vec![Vec::new(); files.len()];
    for f in &files {
        for l in &f.links {
            let key = l.split('#').next().unwrap_or("").to_lowercase();
            if let Some(&t) = by_name.get(&key).and_then(|v| v.first()) {
                if !backlinks[t].contains(&f.path) {
                    backlinks[t].push(f.path.clone());
                }
            }
        }
    }
    for (f, b) in files.iter_mut().zip(backlinks) {
        f.backlinks = b;
    }
    files
}

fn truncate(s: &str, width: usize) -> String {
    let s = s.replace('\n', " ⏎ ");
    if s.chars().count() <= width {
        s
    } else {
        let mut t: String = s.chars().take(width.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

fn cell_text(v: &Value, tz: i32) -> String {
    match v {
        Value::Null => String::new(),
        Value::Error { message } => format!("⚠ {message}"),
        Value::Icon { value } => format!("<icon:{value}>"),
        Value::Image { value } => format!("<img:{value}>"),
        Value::Html { value } => format!("<html:{value}>"),
        Value::Link { value, display } => match display {
            Some(d) => format!("[[{value}|{}]]", d.to_display(tz)),
            None => format!("[[{value}]]"),
        },
        Value::List { value } => value
            .iter()
            .map(|x| cell_text(x, tz))
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_display(tz),
    }
}

fn print_view(r: &ViewResult, tz: i32, max_width: usize) {
    let v = r.view.as_ref().unwrap();
    println!(
        "\n=== view {} \"{}\" ({}) — {} of {} rows ===",
        v.index, v.name, v.view_type, r.count, r.total
    );
    for e in &r.errors {
        println!("  error: {e}");
    }
    let cols = &r.columns;
    let mut widths: Vec<usize> = cols
        .iter()
        .map(|c| c.name.chars().count().min(max_width))
        .collect();
    for g in &r.groups {
        for row in &g.rows {
            for (i, c) in cols.iter().enumerate() {
                let t = truncate(
                    &cell_text(row.cells.get(&c.id).unwrap_or(&Value::Null), tz),
                    max_width,
                );
                widths[i] = widths[i].max(t.chars().count());
            }
        }
        for (i, c) in cols.iter().enumerate() {
            if let Some(s) = g.summaries.get(&c.id).or(r.summaries.get(&c.id)) {
                widths[i] =
                    widths[i].max(truncate(&cell_text(s, tz), max_width).chars().count() + 2);
            }
        }
    }
    let line = |cells: Vec<String>| -> String {
        cells
            .iter()
            .zip(&widths)
            .map(|(c, w)| format!("{:<w$}", c, w = *w))
            .collect::<Vec<_>>()
            .join(" │ ")
    };
    println!(
        "{}",
        line(cols.iter().map(|c| truncate(&c.name, max_width)).collect())
    );
    println!(
        "{}",
        widths
            .iter()
            .map(|w| "─".repeat(*w))
            .collect::<Vec<_>>()
            .join("─┼─")
    );
    let summary_line = |sums: &vault_bases::OrderedMap<Value>| -> Option<String> {
        if cols.iter().all(|c| sums.get(&c.id).is_none()) {
            return None;
        }
        Some(line(
            cols.iter()
                .map(|c| {
                    sums.get(&c.id)
                        .map(|s| format!("Σ {}", truncate(&cell_text(s, tz), max_width)))
                        .unwrap_or_default()
                })
                .collect(),
        ))
    };
    for g in &r.groups {
        if g.has_key || r.groups.len() > 1 {
            println!(
                "▸ {} ({} rows)",
                if g.has_key {
                    cell_text(&g.key, tz)
                } else {
                    "(none)".into()
                },
                g.rows.len()
            );
            if let Some(s) = summary_line(&g.summaries) {
                println!("{s}");
            }
        }
        for row in &g.rows {
            println!(
                "{}",
                line(
                    cols.iter()
                        .map(|c| truncate(
                            &cell_text(row.cells.get(&c.id).unwrap_or(&Value::Null), tz),
                            max_width
                        ))
                        .collect()
                )
            );
        }
    }
    if let Some(s) = summary_line(&r.summaries) {
        println!(
            "{}",
            widths
                .iter()
                .map(|w| "─".repeat(*w))
                .collect::<Vec<_>>()
                .join("─┼─")
        );
        println!("{s}");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let positional: Vec<&String> = {
        let mut out = Vec::new();
        let mut i = 0;
        while i < args.len() {
            if args[i].starts_with("--") {
                if !matches!(args[i].as_str(), "--json" | "--all-views") {
                    i += 1;
                }
            } else {
                out.push(&args[i]);
            }
            i += 1;
        }
        out
    };
    if positional.len() < 2 {
        eprintln!("usage: inspect <file.base|note.md> <vault-dir> [--view N|NAME] [--now ISO] [--tz MIN] [--json] [--all-views] [--width N]");
        std::process::exit(2);
    }
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let base_path = Path::new(positional[0]);
    let vault = Path::new(positional[1]);
    let tz: i32 = flag("--tz").and_then(|s| s.parse().ok()).unwrap_or(0);
    let now_ms = match flag("--now") {
        Some(s) => {
            vault_bases::datetime::parse_date(&s, tz)
                .expect("--now must be an ISO date")
                .ms
        }
        None => std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as f64,
    };
    let width: usize = flag("--width").and_then(|s| s.parse().ok()).unwrap_or(40);

    let text = fs::read_to_string(base_path).expect("cannot read base");
    let yaml = if base_path.extension().is_some_and(|e| e == "md") {
        let start = text.find("```base\n").expect("no ```base block in note") + 8;
        let end = text[start..]
            .find("\n```")
            .map(|e| start + e + 1)
            .unwrap_or(text.len());
        text[start..end].to_string()
    } else {
        text
    };

    let t0 = std::time::Instant::now();
    let files = load_vault(vault);
    let load_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let base = match parse_base(&yaml) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("{}: {e}", base_path.display());
            std::process::exit(1);
        }
    };
    for e in validate_base(&base) {
        println!("syntax: {e}");
    }
    let types: Option<BTreeMap<String, String>> =
        fs::read_to_string(vault.join(".obsidian/types.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|j| serde_json::from_value(j["types"].clone()).ok());

    let this_path = base_path
        .strip_prefix(vault)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| base_path.file_name().unwrap().to_string_lossy().to_string());
    let this = files
        .iter()
        .find(|f| f.path == this_path)
        .cloned()
        .unwrap_or_else(|| FileRecord::new(this_path));

    let views: Vec<usize> = if args.iter().any(|a| a == "--all-views") {
        (0..base.views.len().max(1)).collect()
    } else {
        let v = flag("--view");
        vec![match v {
            None => 0,
            Some(s) => s.parse().unwrap_or_else(|_| {
                base.views
                    .iter()
                    .position(|x| x.name == s)
                    .expect("no view with that name")
            }),
        }]
    };
    println!(
        "{} files loaded in {load_ms:.1} ms; base has {} views",
        files.len(),
        base.views.len()
    );
    let opts = RunOptions {
        now_ms,
        tz_offset_min: tz,
        property_types: types.as_ref(),
    };
    for vi in views {
        let t1 = std::time::Instant::now();
        let r = run_view_with(&base, vi, &files, Some(&this), &opts);
        let ms = t1.elapsed().as_secs_f64() * 1000.0;
        if args.iter().any(|a| a == "--json") {
            println!("{}", serde_json::to_string_pretty(&r).unwrap());
        } else {
            print_view(&r, tz, width);
        }
        println!("(ran in {ms:.1} ms)");
    }
}
