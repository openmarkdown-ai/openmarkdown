//! Each test builds a vault in the system temp directory and runs commands
//! through `crate::run`, exactly as the binary does.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

struct TempVault(PathBuf);

impl TempVault {
    fn new(files: &[(&str, &str)]) -> TempVault {
        let dir = std::env::temp_dir().join(format!("vault-cli-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        for (p, text) in files {
            let path = dir.join(p);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        TempVault(dir)
    }

    fn run(&self, args: &[&str]) -> (i32, String) {
        let mut argv: Vec<String> = vec!["--vault".into(), self.0.to_string_lossy().to_string()];
        argv.extend(args.iter().map(|s| s.to_string()));
        let mut out = Vec::new();
        let code = crate::run(argv, &mut out).unwrap_or_else(|e| panic!("{args:?}: {e}"));
        (code, String::from_utf8(out).unwrap())
    }

    fn err(&self, args: &[&str]) -> String {
        let mut argv: Vec<String> = vec!["--vault".into(), self.0.to_string_lossy().to_string()];
        argv.extend(args.iter().map(|s| s.to_string()));
        crate::run(argv, &mut Vec::new()).expect_err("expected an error")
    }

    fn read(&self, p: &str) -> String {
        fs::read_to_string(self.0.join(p)).unwrap_or_else(|e| panic!("{p}: {e}"))
    }

    fn path(&self, p: &str) -> PathBuf {
        self.0.join(p)
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sample() -> TempVault {
    TempVault::new(&[
        ("Home.md", "# Home\nSee [[Projects/Alpha]] and [[Missing note]].\n#welcome"),
        ("Projects/Alpha.md", "---\nstatus: active\ntags: [project]\n---\n# Alpha\nBack to [[Home]]. The alpha plan.\n"),
        ("Projects/Beta.md", "---\nstatus: done\ntags: [project]\n---\nLinks [[Alpha#Alpha]] and ![[pic.png]].\n"),
        ("pic.png", "\u{89}PNG"),
        (".obsidian/app.json", "{\"newLinkFormat\":\"shortest\"}"),
        (".trash/Old.md", "[[Home]]"),
    ])
}

#[test]
fn args_parse_flags_values_and_positionals() {
    let a = crate::Args::parse(["search", "tag:#x", "--limit", "5", "--json", "-o", "out", "--name=My Site"].map(String::from)).unwrap();
    assert_eq!(a.positional, vec!["search", "tag:#x"]);
    assert_eq!(a.get("limit"), Some("5"));
    assert!(a.has("json"));
    assert_eq!(a.get("o"), Some("out"));
    assert_eq!(a.get("name"), Some("My Site"));
    assert!(crate::Args::parse(["--limit".to_string()]).is_err());
}

#[test]
fn help_lists_commands() {
    let v = sample();
    let (code, out) = v.run(&["help"]);
    assert_eq!(code, 0);
    for c in ["search", "publish", "rename", "daily", "import", "base", "clip"] {
        assert!(out.contains(c), "{c}");
    }
}

#[test]
fn info_counts_and_ignores_hidden_folders() {
    let v = sample();
    let (_, out) = v.run(&["info", "--json"]);
    let j: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(j["notes"], 3, "{out}");
    assert_eq!(j["attachments"], 1);
    assert_eq!(j["brokenLinks"], 1);
    assert_eq!(j["brokenTargets"][0], "Missing note");
    assert_eq!(j["tags"]["#project"], 2);
    let (_, text) = v.run(&["info"]);
    assert!(text.contains("notes        3"), "{text}");
}

#[test]
fn search_uses_obsidian_syntax() {
    let v = sample();
    let (code, out) = v.run(&["search", "tag:#project", "plan"]);
    assert_eq!(code, 0);
    assert!(out.contains("Projects/Alpha.md"), "{out}");
    assert!(!out.contains("Beta"));
    let (_, json) = v.run(&["search", "path:Projects", "--json", "--limit", "1"]);
    let j: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(j["results"].as_array().unwrap().len(), 1);
    assert_eq!(j["fileCount"], 2);
    let (code, _) = v.run(&["search", "ALPHA", "--case-sensitive"]);
    assert_eq!(code, 1, "no case-sensitive match exits 1");
    assert!(v.err(&["search", "/[/"]).contains("search"));
}

#[test]
fn backlinks_links_and_unresolved() {
    let v = sample();
    let (_, out) = v.run(&["backlinks", "Alpha"]);
    assert!(out.contains("Home.md"), "{out}");
    assert!(out.contains("Projects/Beta.md"));
    assert!(out.contains("2 backlinks"));
    let (_, out) = v.run(&["links", "Home"]);
    assert!(out.contains("Projects/Alpha.md"));
    assert!(out.contains("Missing note (unresolved)"));
    let (_, out) = v.run(&["unresolved"]);
    assert!(out.contains("Missing note  ← Home.md"), "{out}");
    assert!(v.err(&["backlinks", "Nope"]).contains("not found"));
}

#[test]
fn tags_and_graph() {
    let v = sample();
    let (_, out) = v.run(&["tags"]);
    assert!(out.lines().next().unwrap().starts_with("#project"), "{out}");
    let (_, json) = v.run(&["graph", "--json"]);
    let g: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(g["nodes"].as_array().unwrap().len() >= 3);
    assert!(!g["links"].as_array().unwrap().is_empty());
}

#[test]
fn render_text_html_and_json() {
    let v = sample();
    let (_, text) = v.run(&["render", "Projects/Alpha.md"]);
    assert!(text.starts_with("Alpha\n"), "{text}");
    assert!(text.contains("Back to Home."));
    let (_, html) = v.run(&["render", "Alpha", "--html"]);
    assert!(html.contains("<h1 data-heading=\"Alpha\""), "{html}");
    let (_, json) = v.run(&["render", "Alpha", "--json"]);
    assert!(json.contains("\"sections\""));
}

#[test]
fn export_html_inlines_images() {
    let v = sample();
    let target = v.path("out/beta.html");
    let (_, out) = v.run(&["export-html", "Beta", "-o", target.to_str().unwrap()]);
    assert!(out.contains("wrote"));
    let html = fs::read_to_string(target).unwrap();
    assert!(html.contains("data:image/png;base64,"), "{html}");
    assert!(html.contains("<title>Beta</title>"));
}

#[test]
fn publish_writes_a_site() {
    let v = sample();
    let site = v.path("site");
    let (_, out) = v.run(&["publish", "-o", site.to_str().unwrap(), "--home", "Home", "--name", "Test", "--exclude", "Nothing"]);
    assert!(out.contains("published 3 notes"), "{out}");
    for p in ["index.html", "Projects/Alpha.html", "search-index.json", "graph.html", "tags/project.html", "pic.png", "assets/site.js"] {
        assert!(site.join(p).exists(), "{p}");
    }
    assert!(fs::read_to_string(site.join("index.html")).unwrap().contains("<title>Home - Test</title>"));
    let (_, _) = v.run(&["publish", "-o", v.path("site2").to_str().unwrap(), "--include", "Projects"]);
    assert!(!v.path("site2/Home.html").exists());
    assert!(v.path("site2/Projects/Beta.html").exists());
}

#[test]
fn base_runs_a_view_as_table_and_json() {
    let v = TempVault::new(&[
        ("A.md", "---\nstatus: active\nprice: 3\n---\n"),
        ("B.md", "---\nstatus: done\nprice: 5\n---\n"),
        ("C.md", "no props"),
        (
            "Tasks.base",
            "filters:\n  and:\n    - file.ext == \"md\"\n    - status\nviews:\n  - type: table\n    name: All\n    order:\n      - file.name\n      - status\n      - price\n    sort:\n      - property: price\n        direction: DESC\n",
        ),
    ]);
    let (_, out) = v.run(&["base", "Tasks.base"]);
    assert!(out.contains("All (table): 2 of 2 rows"), "{out}");
    let lines: Vec<&str> = out.lines().collect();
    assert!(lines[1].starts_with("file name") && lines[1].contains("status"), "{out}");
    let b = lines.iter().position(|l| l.starts_with("B.md ")).unwrap();
    let a = lines.iter().position(|l| l.starts_with("A.md ")).unwrap();
    assert!(b < a, "sorted by price desc: {out}");
    let (_, json) = v.run(&["base", "Tasks", "--json", "--view", "All"]);
    let j: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(j["total"], 2);
}

#[test]
fn clip_local_html_file() {
    let v = sample();
    let page = v.path("page.html");
    fs::write(
        &page,
        "<html><head><title>Great Article</title><meta name=\"description\" content=\"About things\"></head><body><article><h1>Great Article</h1><p>The <b>body</b> of the article, long enough to be the main content of this page.</p></article></body></html>",
    )
    .unwrap();
    let (_, out) = v.run(&["clip", page.to_str().unwrap(), "--url", "https://example.com/a"]);
    assert_eq!(out.trim(), "Clippings/Great Article.md");
    let note = v.read("Clippings/Great Article.md");
    assert!(note.starts_with("---\n"), "{note}");
    assert!(note.contains("source: \"https://example.com/a\"") || note.contains("source: https://example.com/a"), "{note}");
    assert!(note.contains("**body**"));
    let (_, again) = v.run(&["clip", page.to_str().unwrap(), "-o", "Web"]);
    assert_eq!(again.trim(), "Web/Great Article.md");
    let (_, third) = v.run(&["clip", page.to_str().unwrap(), "-o", "Web"]);
    assert_eq!(third.trim(), "Web/Great Article 1.md", "never overwrites");
}

#[test]
fn import_csv_and_html() {
    let v = sample();
    let csv = v.path("in/books.csv");
    fs::create_dir_all(csv.parent().unwrap()).unwrap();
    fs::write(&csv, "title,author\nDune,Herbert\nEmma,Austen\n").unwrap();
    let (_, out) = v.run(&["import", "csv", csv.to_str().unwrap(), "-o", v.path("Imported").to_str().unwrap()]);
    assert!(out.contains("imported"), "{out}");
    let names: Vec<String> = walk_names(&v.path("Imported"));
    assert!(names.iter().any(|n| n.contains("Dune")), "{names:?}");
    let html = v.path("in/html/page.html");
    fs::create_dir_all(html.parent().unwrap()).unwrap();
    fs::write(&html, "<html><head><title>Page</title></head><body><p>Hello <i>world</i></p></body></html>").unwrap();
    v.run(&["import", "html", v.path("in/html").to_str().unwrap(), "-o", v.path("FromHtml").to_str().unwrap()]);
    let names = walk_names(&v.path("FromHtml"));
    assert!(names.iter().any(|n| n.ends_with(".md")), "{names:?}");
    assert!(v.err(&["import", "word", csv.to_str().unwrap(), "-o", "x"]).contains("unknown import kind"));
}

fn walk_names(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir).unwrap().flatten() {
        if e.path().is_dir() {
            out.extend(walk_names(&e.path()));
        } else {
            out.push(e.path().to_string_lossy().to_string());
        }
    }
    out
}

#[test]
fn convert_format_dry_run_and_apply() {
    let v = TempVault::new(&[("A.md", "See [link](B.md) and ==x== #multi word"), ("B.md", "b")]);
    assert!(v.err(&["convert-format"]).contains("choose"));
    let (_, out) = v.run(&["convert-format", "--markdown-links", "--dry-run"]);
    assert!(out.contains("would change A.md"), "{out}");
    assert_eq!(v.read("A.md"), "See [link](B.md) and ==x== #multi word");
    let (_, out) = v.run(&["convert-format", "--markdown-links"]);
    assert!(out.contains("changed A.md"));
    assert!(v.read("A.md").contains("[[B|link]]"), "{}", v.read("A.md"));
}

#[test]
fn rename_updates_links_like_obsidian() {
    let v = sample();
    let (_, out) = v.run(&["rename", "Projects/Alpha.md", "Alpha Prime"]);
    assert!(out.contains("renamed Projects/Alpha.md → Projects/Alpha Prime.md"), "{out}");
    assert!(v.path("Projects/Alpha Prime.md").exists());
    assert!(!v.path("Projects/Alpha.md").exists());
    assert!(v.read("Home.md").contains("See [[Alpha Prime]] and"), "shortest link format: {}", v.read("Home.md"));
    assert!(v.read("Projects/Beta.md").contains("[[Alpha Prime#Alpha]]"), "{}", v.read("Projects/Beta.md"));
    assert!(v.err(&["rename", "Home", "Projects/Beta"]).contains("already exists"));
}

#[test]
fn rename_folder_and_dry_run() {
    let v = sample();
    let (_, dry) = v.run(&["rename", "Projects", "Work", "--dry-run"]);
    assert!(dry.contains("move Projects/Alpha.md → Work/Alpha.md"), "{dry}");
    assert!(v.path("Projects/Alpha.md").exists(), "dry run changes nothing");
    v.run(&["rename", "Projects", "Work"]);
    assert!(v.path("Work/Beta.md").exists());
    assert!(v.read("Home.md").contains("See [[Alpha]] and"), "{}", v.read("Home.md"));
}

#[test]
fn daily_note_uses_settings_and_template() {
    let v = TempVault::new(&[
        (".obsidian/daily-notes.json", "{\"format\":\"YYYY/MM/DD ddd\",\"folder\":\"Journal\",\"template\":\"Templates/Day\"}"),
        ("Templates/Day.md", "# {{title}}\nCreated {{date:dddd, MMMM D}}"),
    ]);
    let (_, out) = v.run(&["daily", "--date", "2024-03-09"]);
    assert_eq!(out.trim(), "Journal/2024/03/09 Sat.md");
    let note = v.read("Journal/2024/03/09 Sat.md");
    assert_eq!(note, "# 09 Sat\nCreated Saturday, March 9");
    fs::write(v.path("Journal/2024/03/09 Sat.md"), "edited").unwrap();
    v.run(&["daily", "--date", "2024-03-09"]);
    assert_eq!(v.read("Journal/2024/03/09 Sat.md"), "edited", "existing daily note is kept");
    let (_, out) = v.run(&["daily", "--date", "2024-03-10", "--no-create"]);
    assert_eq!(out.trim(), "Journal/2024/03/10 Sun.md");
    assert!(!v.path("Journal/2024/03/10 Sun.md").exists());
    let plain = TempVault::new(&[]);
    let (_, out) = plain.run(&["daily", "--date", "2025-12-31"]);
    assert_eq!(out.trim(), "2025-12-31.md");
}

#[test]
fn new_note_respects_location_and_template() {
    let v = TempVault::new(&[
        (".obsidian/app.json", "{\"newFileLocation\":\"folder\",\"newFileFolderPath\":\"Inbox\"}"),
        ("T.md", "title: {{title}}"),
    ]);
    let (_, out) = v.run(&["new", "Idea", "--template", "T"]);
    assert_eq!(out.trim(), "Inbox/Idea.md");
    assert_eq!(v.read("Inbox/Idea.md"), "title: Idea");
    assert!(v.err(&["new", "Idea"]).contains("already exists"));
    let (_, out) = v.run(&["new", "Other", "--folder", "Elsewhere"]);
    assert_eq!(out.trim(), "Elsewhere/Other.md");
}

#[test]
fn template_variables() {
    let ms = 1_700_000_000_000.0; // 2023-11-14 22:13:20 UTC
    assert_eq!(crate::commands::test_apply_template("{{title}} {{date}} {{time}} {{date:YYYY}} {{other}}", "T", ms), "T 2023-11-14 22:13 2023 {{other}}");
}

#[test]
fn unknown_command_is_an_error() {
    let v = sample();
    assert!(v.err(&["frobnicate"]).contains("unknown command"));
}
