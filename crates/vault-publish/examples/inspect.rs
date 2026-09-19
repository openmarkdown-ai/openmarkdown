//! Exports a real folder of Markdown to a static site, plus one standalone
//! note, and prints what was generated.
//!
//! ```sh
//! cargo run -p vault-publish --example inspect -- <vault-dir> <out-dir> [site-options.json] [note-path]
//! ```
//!
//! `site-options.json` may be an Obsidian Headless `site-options.json`
//! (`siteName`, `indexFile`, `navigationOrdering` … are understood).

use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use vault_publish::{export_note, export_site, InputFile, NoteExportInput, SiteExportInput, SiteOptions};

fn walk(root: &Path, dir: &Path, out: &mut Vec<InputFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            walk(root, &p, out);
            continue;
        }
        let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        let meta = e.metadata().ok();
        let ms = |t: Option<std::time::SystemTime>| t.and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        let mtime = ms(meta.as_ref().and_then(|m| m.modified().ok()));
        let ctime = ms(meta.as_ref().and_then(|m| m.created().ok()));
        let Ok(bytes) = std::fs::read(&p) else { continue };
        let mut f = if rel.to_lowercase().ends_with(".md") {
            InputFile::note(&rel, &String::from_utf8_lossy(&bytes))
        } else {
            InputFile::binary(&rel, bytes)
        };
        f.mtime = mtime;
        f.ctime = ctime;
        out.push(f);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: inspect <vault-dir> <out-dir> [site-options.json] [note-path]");
        std::process::exit(2);
    }
    let root = PathBuf::from(&args[0]);
    let out = PathBuf::from(&args[1]);
    let mut files = Vec::new();
    walk(&root, &root, &mut files);
    let options: SiteOptions = match args.get(2).filter(|a| !a.is_empty()) {
        Some(p) => serde_json::from_str(&std::fs::read_to_string(p).expect("read options")).expect("parse options"),
        None => SiteOptions { site_name: root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), ..Default::default() },
    };
    let notes = files.iter().filter(|f| f.text.is_some()).count();
    println!("read {} files ({} notes) from {}", files.len(), notes, root.display());

    let t = Instant::now();
    let input = SiteExportInput { files, options };
    let site = export_site(&input);
    let elapsed = t.elapsed();
    let bytes: usize = site.iter().map(|f| f.bytes.len()).sum();
    let pages = site.iter().filter(|f| f.path.ends_with(".html")).count();
    println!("site: {} files, {} html, {:.1} MB in {:.2?}", site.len(), pages, bytes as f64 / 1e6, elapsed);
    for f in &site {
        let path = out.join(&f.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(&path, &f.bytes).expect("write");
    }
    let mut biggest: Vec<_> = site.iter().filter(|f| f.path.ends_with(".html")).collect();
    biggest.sort_by_key(|f| std::cmp::Reverse(f.bytes.len()));
    for f in biggest.iter().take(3) {
        println!("  largest page: {} ({} KB)", f.path, f.bytes.len() / 1024);
    }
    let unresolved: usize = site.iter().filter(|f| f.path.ends_with(".html")).map(|f| f.text().matches("is-unresolved").count()).sum();
    println!("  unresolved links/embeds across pages: {unresolved}");

    if let Some(note) = args.get(3) {
        let t = Instant::now();
        let html = export_note(&NoteExportInput { path: note.clone(), files: input.files.clone(), ..Default::default() });
        let target = out.join("_note.html");
        std::fs::write(&target, &html).expect("write note");
        println!("note: {} → {} ({} KB) in {:.2?}", note, target.display(), html.len() / 1024, t.elapsed());
    }
    println!("wrote {}", out.display());
}
