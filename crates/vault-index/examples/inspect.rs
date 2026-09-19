//! Runs the index over a real folder of Markdown and prints what it finds,
//! with timings.
//!
//! ```text
//! cargo run --release -p vault-index --example inspect -- <vault folder> [--layout-nodes 20000]
//! ```
//!
//! Metadata comes from the crate's crude test scanner (`src/testkit.rs`),
//! not `vault-ofm`, so this example only depends on this crate. Dot folders,
//! `node_modules` and `target` are skipped.

#[path = "../src/testkit.rs"]
mod testkit;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};
use vault_index::*;

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => walk(&p, out),
            Ok(t) if t.is_file() => out.push(p),
            _ => {}
        }
    }
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let root = PathBuf::from(args.get(1).cloned().unwrap_or_else(|| ".".into()));
    let layout_nodes: usize = args
        .iter()
        .position(|a| a == "--layout-nodes")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(20_000);

    // ------------------------------------------------------------ load
    let t = Instant::now();
    let mut files = Vec::new();
    walk(&root, &mut files);
    let mut index = VaultIndex::new();
    let mut texts: Vec<(String, String)> = Vec::new();
    let mut bytes = 0usize;
    for f in &files {
        let rel = f
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let meta = std::fs::metadata(f).ok();
        let time = |st: Option<std::io::Result<std::time::SystemTime>>| {
            st.and_then(|r| r.ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
        };
        index.upsert_file(FileEntry {
            path: rel.clone(),
            size: meta.as_ref().map_or(0, |m| m.len()),
            ctime: time(meta.as_ref().map(|m| m.created())),
            mtime: time(meta.as_ref().map(|m| m.modified())),
        });
        if rel.ends_with(".md") {
            if let Ok(text) = std::fs::read_to_string(f) {
                bytes += text.len();
                texts.push((rel, text));
            }
        }
    }
    let read_ms = ms(t);
    let t = Instant::now();
    let parsed: Vec<_> = texts
        .iter()
        .map(|(p, text)| (p.clone(), text.clone(), testkit::parse(text)))
        .collect();
    let parse_ms = ms(t);
    let t = Instant::now();
    for (p, text, meta) in parsed {
        index.set_note(&p, text, meta);
    }
    let insert_ms = ms(t);
    println!("vault: {}", root.display());
    println!(
        "files {}  notes {}  attachments {}  markdown {:.1} MB",
        index.file_count(),
        index.note_count(),
        index.file_count() - index.note_count(),
        bytes as f64 / 1e6
    );
    println!("timing: walk+read {read_ms:.0} ms, scan metadata {parse_ms:.0} ms, index insert {insert_ms:.1} ms");

    // ------------------------------------------------------------ links
    let t = Instant::now();
    let resolved = index.resolved_links();
    let unresolved = index.unresolved_links();
    let links_ms = ms(t);
    let n_resolved: u32 = resolved.values().flat_map(|m| m.values()).sum();
    let n_unresolved: u32 = unresolved.values().flat_map(|m| m.values()).sum();
    println!("\nlinks: {n_resolved} resolved, {n_unresolved} unresolved (resolvedLinks + unresolvedLinks in {links_ms:.1} ms)");
    let mut incoming: BTreeMap<&str, u32> = BTreeMap::new();
    for (source, targets) in &resolved {
        // Self links (`[[#Heading]]`, `[x](#anchor)`) are not backlinks.
        for (t, c) in targets.iter().filter(|(t, _)| *t != source) {
            *incoming.entry(t).or_default() += c;
        }
    }
    let mut top: Vec<_> = incoming.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    println!("most linked:");
    for (p, c) in top.iter().take(10) {
        println!("  {c:5}  {p}");
    }
    let mut missing: BTreeMap<&str, u32> = BTreeMap::new();
    for targets in unresolved.values() {
        for (t, c) in targets {
            *missing.entry(t).or_default() += c;
        }
    }
    let mut missing: Vec<_> = missing.into_iter().collect();
    missing.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    println!("top unresolved:");
    for (p, c) in missing.iter().take(10) {
        println!("  {c:5}  {p}");
    }

    // ------------------------------------------------------------ tags
    let t = Instant::now();
    let tags = index.tags();
    let tags_ms = ms(t);
    let mut tag_list: Vec<_> = tags.iter().collect();
    tag_list.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    println!(
        "\ntags: {} distinct in {tags_ms:.1} ms; top: {}",
        tags.len(),
        tag_list
            .iter()
            .take(8)
            .map(|(t, c)| format!("{t} ({c})"))
            .collect::<Vec<_>>()
            .join(", ")
    );

    // ------------------------------------------------------------ backlinks, mentions, rename
    if let Some((target, _)) = top.first() {
        let target = target.to_string();
        let t = Instant::now();
        let bl = index.backlinks(&target);
        let bl_ms = ms(t);
        let t = Instant::now();
        let um = index.unlinked_mentions(&target);
        let um_ms = ms(t);
        println!(
            "\nbacklinks of {target}: {} files / {} refs in {bl_ms:.1} ms; unlinked mentions: {} files / {} matches in {um_ms:.1} ms",
            bl.len(),
            bl.iter().map(|b| b.refs.len()).sum::<usize>(),
            um.len(),
            um.iter().map(|m| m.matches.len()).sum::<usize>()
        );
        if let Some(b) = bl.first() {
            if let Some(ctx) = b.refs.iter().find_map(|r| r.context.as_ref()) {
                println!(
                    "  e.g. {}: {}",
                    b.source,
                    ctx.text.chars().take(100).collect::<String>()
                );
            }
        }
        let new_path = format!(
            "renamed/{}",
            target
                .rsplit('/')
                .next()
                .unwrap_or(&target)
                .replace(".md", " (moved).md")
        );
        let t = Instant::now();
        let edits = index.rename_edits(&target, &new_path, &RenameOptions::default());
        let rn_ms = ms(t);
        println!(
            "rename {target} → {new_path}: {} files, {} edits in {rn_ms:.1} ms",
            edits.len(),
            edits.iter().map(|e| e.edits.len()).sum::<usize>()
        );
        if let Some(e) = edits.first().and_then(|f| f.edits.first().map(|x| (f, x))) {
            let note = index.note(&e.0.original_path).unwrap();
            let s = note.lines.byte_of_u16(&note.text, e.1.start);
            let en = note.lines.byte_of_u16(&note.text, e.1.end);
            println!(
                "  e.g. {}: {} → {}",
                e.0.original_path,
                &note.text[s..en],
                e.1.text
            );
        }
    }

    // ------------------------------------------------------------ search
    println!("\nsearch:");
    let queries = [
        "link",
        "\"internal link\"",
        "obsidian -plugin",
        "file:readme",
        "path:plugins",
        "tag:#todo",
        "line:(search operator)",
        "section:(graph view)",
        "task-todo:\"\"",
        "[aliases]",
        "/\\d{4}-\\d{2}-\\d{2}/",
        "(link OR embed) -canvas",
        "match-case:Obsidian",
        "broken:(query",
    ];
    for q in queries {
        let t = Instant::now();
        let out = index.search(q, &SearchOptions::default());
        let q_ms = ms(t);
        match out.error {
            Some(e) => println!("  {q:28} error: {e}  ({q_ms:.1} ms)"),
            None => println!(
                "  {q:28} {:5} files {:6} matches  {q_ms:7.1} ms  first: {}",
                out.file_count,
                out.match_count,
                out.results.first().map_or("-", |r| r.path.as_str())
            ),
        }
    }
    if let Ok(Some(e)) = explain("meeting (work OR meetup) -personal [status:draft]") {
        println!(
            "explain:\n{}",
            e.to_text()
                .lines()
                .map(|l| format!("  {l}"))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    // ------------------------------------------------------------ fuzzy
    let items: Vec<String> = index
        .files()
        .map(|f| f.path.trim_end_matches(".md").to_string())
        .collect();
    for q in ["graph", "intlink", "srch plg"] {
        let t = Instant::now();
        let r = fuzzy::rank(q, &items, 5);
        let f_ms = ms(t);
        println!(
            "switcher {q:10} {f_ms:6.1} ms: {}",
            r.iter()
                .map(|(i, s)| format!("{} ({:.3})", items[*i], s.score))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    // ------------------------------------------------------------ graph + layout
    let t = Instant::now();
    let g = index.graph(&GraphOptions::default());
    let g_ms = ms(t);
    let t = Instant::now();
    let gt = index.graph(&GraphOptions {
        show_tags: true,
        show_attachments: true,
        color_groups: vec![ColorGroup {
            query: "path:plugins".into(),
            color: serde_json::Value::Null,
        }],
        ..Default::default()
    });
    let gt_ms = ms(t);
    println!("\ngraph: {} nodes, {} links in {g_ms:.1} ms; with tags+attachments+group {} nodes, {} links in {gt_ms:.1} ms", g.nodes.len(), g.links.len(), gt.nodes.len(), gt.links.len());
    if let Some((center, _)) = top.first() {
        let t = Instant::now();
        let lg = index.graph(&GraphOptions {
            local_file: Some(center.to_string()),
            local_jumps: 2,
            ..Default::default()
        });
        println!(
            "local graph of {center} (depth 2): {} nodes, {} links in {:.1} ms",
            lg.nodes.len(),
            lg.links.len(),
            ms(t)
        );
    }
    bench_layout(
        "vault graph",
        g.nodes.len(),
        &g.links
            .iter()
            .map(|l| (l.source, l.target))
            .collect::<Vec<_>>(),
    );

    // Synthetic scale test: a scale-free-ish graph of `layout_nodes` nodes.
    let n = layout_nodes;
    let mut edges = Vec::with_capacity(n * 2);
    let mut seed = 42u64;
    let mut rnd = |m: usize| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 33) as usize) % m.max(1)
    };
    for i in 1..n {
        edges.push((i as u32, rnd(i) as u32));
        if i % 3 == 0 {
            edges.push((i as u32, rnd(i) as u32));
        }
    }
    bench_layout("synthetic", n, &edges);
}

fn bench_layout(name: &str, n: usize, edges: &[(u32, u32)]) {
    if n == 0 {
        return;
    }
    let t = Instant::now();
    let mut layout = ForceLayout::new(n, edges, ForceParams::default());
    let init_ms = ms(t);
    // Warm-up ticks (the first ones rebuild deep trees from the spiral).
    let t = Instant::now();
    layout.step(10);
    let first_ms = ms(t) / 10.0;
    let t = Instant::now();
    let ticks = 60;
    for _ in 0..ticks {
        layout.tick();
    }
    let tick_ms = ms(t) / ticks as f64;
    let t = Instant::now();
    let mut total = 0;
    while layout.step(10) && total < 3000 {
        total += 10;
    }
    let settle_ms = ms(t);
    let mut parts = [0f64; 5];
    for _ in 0..10 {
        let t = layout.profile_tick();
        for (a, b) in parts.iter_mut().zip(t) {
            *a += b / 10.0;
        }
    }
    let p = layout.positions();
    let (mut minx, mut maxx) = (f32::MAX, f32::MIN);
    for i in 0..n {
        minx = minx.min(p[i * 2]);
        maxx = maxx.max(p[i * 2]);
    }
    println!(
        "layout {name}: {n} nodes / {} edges: init {init_ms:.1} ms, first ticks {first_ms:.2} ms/tick, steady {tick_ms:.2} ms/tick ({:.0} ticks/s), settled after {} more ticks in {settle_ms:.0} ms, width {:.0}",
        edges.len(),
        1000.0 / tick_ms,
        total + 10,
        maxx - minx
    );
    println!(
        "  per force: center {:.2} ms, links {:.2} ms, quadtree {:.2} ms, repel (incl. tree) {:.2} ms, collide {:.2} ms",
        parts[0], parts[1], parts[2], parts[3], parts[4]
    );
}
