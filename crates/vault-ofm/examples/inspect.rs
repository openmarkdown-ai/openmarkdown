//! Run the real pipeline over markdown files on disk.
//!
//! ```text
//! cargo run -p vault-ofm --example inspect -- NOTE.md [MORE.md …]   # metadata JSON + sections
//! cargo run -p vault-ofm --release --example inspect -- --bench [NOTE.md]   # repeat to 1 MB
//! cargo run -p vault-ofm --release --example inspect -- --time NOTE.md…
//! cargo run -p vault-ofm --release --example inspect -- --quiet DIR  # every .md under DIR, errors only
//! ```

use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: inspect [--bench|--quiet] PATH…");
        std::process::exit(2);
    }
    match args[0].as_str() {
        "--bench" => bench(args.get(1)),
        "--yaml" => yaml_lines(&args[1..]),
        // JSON-string YAML sources on stdin, one per line → parse results.
        "--yaml-stdin" => {
            use std::io::BufRead;
            for line in std::io::stdin().lock().lines() {
                let src: String = serde_json::from_str(&line.unwrap()).unwrap();
                let r = vault_ofm::yaml_parse(&src);
                println!("{}", serde_json::json!({"ok": r.as_ref().ok(), "err": r.as_ref().err()}));
            }
        }
        "--time" => {
            for a in &args[1..] {
                let text = std::fs::read_to_string(a).unwrap();
                let t = Instant::now();
                let _ = vault_ofm::parse(&text);
                let p = t.elapsed().as_secs_f64() * 1000.0;
                let t = Instant::now();
                let _ = vault_ofm::render(&text, &vault_ofm::RenderOptions::default());
                println!("{a}: {} bytes, parse {p:.1} ms, render {:.1} ms", text.len(), t.elapsed().as_secs_f64() * 1000.0);
            }
        }
        "--quiet" => {
            for a in &args[1..] {
                sweep(std::path::Path::new(a));
            }
        }
        _ => {
            for a in &args {
                show(a);
            }
        }
    }
}

fn show(path: &str) {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let meta = vault_ofm::parse(&text);
    println!("=== {path}");
    println!("{}", serde_json::to_string_pretty(&meta).unwrap());
    for s in vault_ofm::render(&text, &vault_ofm::RenderOptions::default()).sections {
        println!("--- {} [{}..{}]", s.kind, s.line_start, s.line_end);
        println!("{}", s.html);
    }
    println!("--- word count {:?}", vault_ofm::word_count(&text));
}

/// Parse and render every note under a directory; report panics and any
/// position that does not point back at the text it claims to cover.
fn sweep(dir: &std::path::Path) {
    let mut files = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(p) = stack.pop() {
        if p.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                for e in rd.flatten() {
                    let name = e.file_name();
                    if name.to_string_lossy() == "node_modules" || name.to_string_lossy().starts_with('.') {
                        continue;
                    }
                    stack.push(e.path());
                }
            }
            continue;
        }
        if p.extension().map(|e| e == "md").unwrap_or(false) {
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            files += 1;
            let r = std::panic::catch_unwind(|| {
                let meta = vault_ofm::parse(&text);
                let _ = vault_ofm::render(&text, &vault_ofm::RenderOptions::default());
                meta
            });
            match r {
                Err(_) => println!("PANIC {}", p.display()),
                Ok(meta) => check(&p, &text, &meta),
            }
        }
    }
    println!("{files} files under {}", dir.display());
}

fn check(p: &std::path::Path, text: &str, meta: &vault_types::CachedMetadata) {
    let u16: Vec<u16> = text.encode_utf16().collect();
    let slice = |a: u32, b: u32| String::from_utf16_lossy(&u16[a as usize..(b as usize).min(u16.len())]);
    for l in meta.links.iter().flatten().chain(meta.embeds.iter().flatten()) {
        if slice(l.position.start.offset, l.position.end.offset) != l.original {
            println!("BAD LINK POS {} {:?}", p.display(), l.original);
        }
    }
    for t in meta.tags.iter().flatten() {
        if slice(t.position.start.offset, t.position.end.offset) != t.tag {
            println!("BAD TAG POS {} {:?}", p.display(), t.tag);
        }
    }
}

fn bench(path: Option<&String>) {
    let unit = match path {
        Some(p) => std::fs::read_to_string(p).unwrap(),
        None => "# Heading [[Link]] #tag\n\nA paragraph with **bold**, [[Note#Section|alias]], ![[img.png|100]], #tag/sub and `code`.\nSecond line with $x^2$ and [ext](https://example.com) and ==mark==.\n\n- [ ] task ^blk\n  - nested [md](Other%20Note.md)\n- item\n\n> [!note]- Callout\n> body\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x = 1;\n```\n\n".to_string(),
    };
    let mut text = String::new();
    while text.len() < 1_000_000 {
        text.push_str(&unit);
    }
    let t = Instant::now();
    let meta = vault_ofm::parse(&text);
    let parse_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let r = vault_ofm::render(&text, &vault_ofm::RenderOptions::default());
    let render_ms = t.elapsed().as_secs_f64() * 1000.0;
    println!(
        "{} bytes: parse {parse_ms:.1} ms ({} sections, {} links), render {render_ms:.1} ms ({} sections)",
        text.len(),
        meta.sections.map(|s| s.len()).unwrap_or(0),
        meta.links.map(|s| s.len()).unwrap_or(0),
        r.sections.len()
    );
}

/// `--yaml FILE…`: print `{file, parsed, error, stringified}` JSON lines for
/// each note's frontmatter, to compare against another YAML implementation.
fn yaml_lines(files: &[String]) {
    for f in files {
        let Ok(text) = std::fs::read_to_string(f) else { continue };
        let fm = vault_ofm::parse_frontmatter(&text);
        if fm.position.is_none() {
            continue;
        }
        let end = fm.body_start_byte;
        let block = &text[..end];
        let yaml = block.splitn(2, '\n').nth(1).unwrap_or("");
        let yaml = yaml.trim_end_matches(['\n', '\r']);
        let yaml = yaml.strip_suffix("---").unwrap_or(yaml).trim_end_matches(['\n', '\r']);
        let parsed = vault_ofm::yaml_parse(yaml);
        let line = serde_json::json!({
            "file": f,
            "yaml": yaml,
            "parsed": parsed.as_ref().ok(),
            "error": parsed.as_ref().err(),
            "stringified": parsed.as_ref().ok().map(vault_ofm::yaml_stringify),
        });
        println!("{line}");
    }
}
