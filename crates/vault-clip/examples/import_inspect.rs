//! Run an importer over a real export on disk and show what it produces.
//!
//! ```text
//! cargo run -p vault-clip --example import_inspect -- <format> <path> [options]
//!
//! formats: enex, notion, roam, keep, bear, logseq, csv, html, textbundle, format
//! options:
//!   --note <substring>   print the first note whose path contains this
//!   --all                print every note
//!   --out <dir>          also write the result to <dir>
//! ```
//!
//! A directory is read recursively into `(relative path, bytes)` pairs, the
//! shape the browser hands the importers; a file is passed as itself.

use std::fs;
use std::path::{Path, PathBuf};
use vault_clip::import::{self, ImportResult};

fn read_tree(root: &Path) -> Vec<(String, Vec<u8>)> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let mut entries: Vec<PathBuf> = fs::read_dir(dir)
            .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
            .unwrap_or_default();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                walk(base, &p, out);
            } else if let Ok(data) = fs::read(&p) {
                let rel = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                out.push((rel, data));
            }
        }
    }
    let mut out = Vec::new();
    if root.is_dir() {
        walk(root, root, &mut out);
    } else if let Ok(data) = fs::read(root) {
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        out.push((name, data));
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: import_inspect <enex|notion|roam|keep|bear|logseq|csv|html|textbundle|format> <path> [--note S] [--all] [--out DIR]");
        std::process::exit(2);
    }
    let format = args[0].as_str();
    let path = PathBuf::from(&args[1]);
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let all = args.iter().any(|a| a == "--all");

    let text = || String::from_utf8_lossy(&fs::read(&path).expect("read input")).into_owned();
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let started = std::time::Instant::now();
    let result: ImportResult = match format {
        "enex" => import::enex::convert(&text(), &import::enex::EnexOptions { notebook: stem, ..Default::default() }),
        "notion" => import::notion::convert(&read_tree(&path)),
        "roam" => import::roam::convert(&text(), &Default::default()),
        "keep" => import::keep::convert(&read_tree(&path)),
        "bear" => import::bear::convert(&fs::read(&path).expect("read input")),
        "logseq" => import::logseq::convert(&read_tree(&path)),
        "csv" => import::csv::convert(&text(), &Default::default()),
        "html" => import::html_files::convert(&read_tree(&path), &Default::default()),
        "textbundle" => import::textbundle::convert(&read_tree(&path)),
        "format" => {
            let opts = import::format_converter::FormatConverterOptions {
                markdown_links_to_wikilinks: true,
                roam_tags: true,
                roam_highlights: true,
                roam_todos: true,
                bear_highlights: true,
                bear_multi_word_tags: true,
                properties: true,
                ..Default::default()
            };
            let out = import::format_converter::convert(&text(), &opts);
            print!("{out}");
            return;
        }
        other => {
            eprintln!("unknown format {other}");
            std::process::exit(2);
        }
    };
    let elapsed = started.elapsed();

    let notes: Vec<_> = result.files.iter().filter(|f| f.path.ends_with(".md")).collect();
    println!(
        "{} files ({} notes, {} attachments) in {:.1?}",
        result.files.len(),
        notes.len(),
        result.files.len() - notes.len(),
        elapsed
    );
    for f in &result.files {
        let times = match (f.ctime_ms, f.mtime_ms) {
            (Some(c), Some(m)) => format!("  ctime={c} mtime={m}"),
            _ => String::new(),
        };
        println!("  {} ({} bytes){times}", f.path, f.data.len());
    }
    if !result.warnings.is_empty() {
        println!("warnings:");
        for w in &result.warnings {
            println!("  - {w}");
        }
    }
    let selected: Vec<_> = match flag("--note") {
        Some(s) => notes.iter().filter(|f| f.path.contains(&s)).take(1).collect(),
        None if all => notes.iter().collect(),
        None => notes.iter().take(1).collect(),
    };
    for f in selected {
        println!("\n===== {} =====\n{}", f.path, f.text());
    }
    if let Some(out) = flag("--out") {
        for f in &result.files {
            let target = Path::new(&out).join(&f.path);
            if let Some(dir) = target.parent() {
                fs::create_dir_all(dir).ok();
            }
            fs::write(&target, &f.data).expect("write output");
        }
        println!("\nwritten to {out}");
    }
}
