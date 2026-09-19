//! Unit tests: every tool against a temporary vault, the path and text
//! safety helpers, and the JSON-RPC layer (without a subprocess; see
//! tests/mcp_stdio.rs for that).

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{json, Map, Value};

use super::fsx::{self, TextFile};
use super::tools::{self, glob_match};
use super::{Server, ToolError};

static N: AtomicUsize = AtomicUsize::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new(files: &[(&str, &[u8])]) -> Tmp {
        let dir = std::env::temp_dir().join(format!("vault-mcp-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        for (p, data) in files {
            let path = dir.join(p);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, data).unwrap();
        }
        Tmp(dir)
    }
    fn read(&self, p: &str) -> String {
        fs::read_to_string(self.0.join(p)).unwrap_or_else(|e| panic!("{p}: {e}"))
    }
    fn bytes(&self, p: &str) -> Vec<u8> {
        fs::read(self.0.join(p)).unwrap()
    }
    fn write(&self, p: &str, s: &str) {
        let path = self.0.join(p);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, s).unwrap();
    }
    fn server(&self) -> Server {
        Server::open(&self.0, false).unwrap()
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn sample() -> Tmp {
    Tmp::new(&[
        ("Home.md", b"# Home\nSee [[Alpha]] and [[Missing note]].\n#welcome\n"),
        (
            "Projects/Alpha.md",
            b"---\nstatus: active # keep this comment\ntags:\n  - project\n  - rust\n---\n# Alpha\nBack to [[Home]]. The alpha plan.\n\n## Tasks\n- [ ] write tests ^task1\n- [ ] ship\n\n## Notes\nA paragraph with an id. ^para\n",
        ),
        ("Projects/Beta.md", b"---\nstatus: done\ntags: [project]\n---\nLinks [[Alpha#Tasks]] and ![[pic.png]]. alpha again\n"),
        ("pic.png", b"\x89PNG"),
        (".obsidian/app.json", b"{}"),
        (".trash/Old.md", b"[[Home]] alpha"),
    ])
}

fn args(v: Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap()
}

fn ok(s: &mut Server, name: &str, a: Value) -> (String, Value) {
    match s.call_tool(name, &args(a.clone())) {
        Ok(o) => (o.text, o.structured.unwrap_or(Value::Null)),
        Err(ToolError::Failed(e)) | Err(ToolError::Unknown(e)) => panic!("{name} {a}: {e}"),
    }
}

fn fail(s: &mut Server, name: &str, a: Value) -> String {
    match s.call_tool(name, &args(a.clone())) {
        Ok(o) => panic!("{name} {a}: expected an error, got {}", o.text),
        Err(ToolError::Failed(e)) => e,
        Err(ToolError::Unknown(e)) => format!("UNKNOWN: {e}"),
    }
}

// ---- safety helpers ----------------------------------------------------------------

#[test]
fn clean_rel_accepts_relative_and_rejects_escapes() {
    assert_eq!(fsx::clean_rel("Projects/Alpha.md").unwrap(), "Projects/Alpha.md");
    assert_eq!(fsx::clean_rel(" Projects\\Alpha.md ").unwrap(), "Projects/Alpha.md");
    assert_eq!(fsx::clean_rel("a//b/").unwrap(), "a/b");
    for bad in ["", "/etc/passwd", "../x.md", "a/../../x", "./a.md", "C:/x.md", "~/x.md", ".obsidian/app.json", "a/.git/config", "x\0y"] {
        assert!(fsx::clean_rel(bad).is_err(), "{bad:?} should be rejected");
    }
}

#[cfg(unix)]
#[test]
fn confined_rejects_symlinks_that_leave_the_vault() {
    let outside = Tmp::new(&[("secret.md", b"secret")]);
    let v = Tmp::new(&[("Inside.md", b"hi")]);
    std::os::unix::fs::symlink(&outside.0, v.0.join("escape")).unwrap();
    std::os::unix::fs::symlink(v.0.join("Inside.md"), v.0.join("Alias.md")).unwrap();
    let root = v.0.canonicalize().unwrap();
    assert!(fsx::confined(&root, "escape/secret.md").unwrap_err().contains("symlink"));
    assert!(fsx::confined(&root, "escape/new/note.md").is_err());
    assert!(fsx::confined(&root, "Alias.md").is_ok());
    assert!(fsx::confined(&root, "New/Folder/x.md").is_ok());
    let mut s = Server::open(&v.0, false).unwrap();
    assert!(fail(&mut s, "create_note", json!({"path": "escape/pwn.md", "content": "x"})).contains("symlink"));
    assert!(!outside.0.join("pwn.md").exists());
    // Symlinked files are not indexed, so they cannot be edited through the server …
    assert!(fail(&mut s, "edit_note", json!({"path": "Alias.md", "old_string": "hi", "new_string": "yo"})).contains("not found"));
    // … and the writer refuses to replace one in any case.
    assert!(fsx::write_atomic(&root.join("Alias.md"), "Alias.md", b"yo").unwrap_err().contains("symlink"));
    assert_eq!(v.read("Inside.md"), "hi");
}

#[test]
fn text_file_keeps_bom_and_crlf_and_refuses_invalid_utf8() {
    let f = TextFile::decode(b"\xEF\xBB\xBFa\r\nb\r\n", "x.md").unwrap();
    assert!(f.bom && f.crlf);
    assert_eq!(f.text, "a\nb\n");
    assert_eq!(f.encode(), b"\xEF\xBB\xBFa\r\nb\r\n");
    let g = TextFile::decode(b"a\nb\n", "x.md").unwrap();
    assert!(!g.bom && !g.crlf);
    assert!(TextFile::decode(b"caf\xE9", "x.md").unwrap_err().contains("UTF-8"));
}

#[test]
fn atomic_write_leaves_no_temp_files() {
    let v = Tmp::new(&[]);
    fsx::write_atomic(&v.0.join("A/B.md"), "A/B.md", b"one").unwrap();
    fsx::write_atomic(&v.0.join("A/B.md"), "A/B.md", b"two").unwrap();
    assert_eq!(v.read("A/B.md"), "two");
    let names: Vec<String> = fs::read_dir(v.0.join("A")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    assert_eq!(names, vec!["B.md"]);
}

#[test]
fn glob_rules() {
    assert!(glob_match("*.md", "Projects/Alpha.md"));
    assert!(glob_match("*alp*", "Projects/Alpha.md"));
    assert!(glob_match("Projects/*.md", "Projects/Alpha.md"));
    assert!(!glob_match("Projects/*.md", "Projects/Sub/Alpha.md"));
    assert!(glob_match("Projects/**/*.md", "Projects/Sub/Alpha.md"));
    assert!(glob_match("Projects/**/*.md", "Projects/Alpha.md"));
    assert!(glob_match("**/a?pha.md", "x/y/Alpha.md"));
    assert!(!glob_match("*.png", "Projects/Alpha.md"));
}

#[test]
fn iso_and_daily_dates() {
    assert_eq!(tools::iso_utc(0.0), "1970-01-01T00:00:00Z");
    assert_eq!(tools::iso_utc(1_789_648_200_000.0), "2026-09-17T12:30:00Z");
    let now = 1_789_648_200_000.0;
    assert_eq!(tools::daily_ms(Some("yesterday"), now, 0).unwrap(), now - 86_400_000.0);
    let d = tools::daily_ms(Some("2026-01-02"), now, 480).unwrap();
    assert_eq!(tools::iso_utc(d + 480.0 * 60_000.0).get(..10), Some("2026-01-02"));
    assert!(tools::daily_ms(Some("02/01/2026"), now, 0).is_err());
}

// ---- read tools ------------------------------------------------------------------------

#[test]
fn search_returns_files_and_snippets() {
    let v = sample();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "search", json!({"query": "alpha"}));
    let paths: Vec<&str> = r["results"].as_array().unwrap().iter().map(|x| x["path"].as_str().unwrap()).collect();
    assert!(paths.contains(&"Projects/Alpha.md") && paths.contains(&"Projects/Beta.md"), "{paths:?}");
    assert!(!paths.iter().any(|p| p.starts_with(".trash")));
    let beta = r["results"].as_array().unwrap().iter().find(|x| x["path"] == "Projects/Beta.md").unwrap();
    assert_eq!(beta["snippets"][0]["line"], 5);
    assert!(beta["snippets"][0]["text"].as_str().unwrap().contains("alpha again"));

    let (_, r) = ok(&mut s, "search", json!({"query": "tag:#project", "limit": 1}));
    assert_eq!(r["fileCount"], 2);
    assert_eq!(r["returned"], 1);
    assert_eq!(r["truncated"], true);

    let (_, r) = ok(&mut s, "search", json!({"query": "[status:done]"}));
    assert_eq!(r["results"][0]["path"], "Projects/Beta.md");

    assert!(fail(&mut s, "search", json!({"query": "  "})).contains("empty"));
    assert!(fail(&mut s, "search", json!({})).contains("missing required argument `query`"));
    assert!(fail(&mut s, "search", json!({"query": "x", "limit": 0})).contains("limit"));
}

#[test]
fn read_note_whole_heading_and_block() {
    let v = sample();
    let mut s = v.server();
    let (t, _) = ok(&mut s, "read_note", json!({"path": "Projects/Alpha.md"}));
    assert!(t.starts_with("---\nstatus: active"));
    let (t2, _) = ok(&mut s, "read_note", json!({"path": "Alpha"}));
    assert_eq!(t, t2, "link-text resolution");
    let (t, _) = ok(&mut s, "read_note", json!({"path": "Projects/Alpha", "heading": "## Tasks"}));
    assert_eq!(t, "## Tasks\n- [ ] write tests ^task1\n- [ ] ship\n\n");
    let (t, _) = ok(&mut s, "read_note", json!({"path": "Alpha", "heading": "Alpha#Notes"}));
    assert_eq!(t, "## Notes\nA paragraph with an id. ^para\n");
    let (t, _) = ok(&mut s, "read_note", json!({"path": "Alpha", "block": "^para"}));
    assert_eq!(t, "A paragraph with an id. ^para");
    let (t, _) = ok(&mut s, "read_note", json!({"path": "Alpha", "block": "task1"}));
    assert!(t.contains("write tests ^task1") && !t.contains("ship"), "{t:?}");

    let e = fail(&mut s, "read_note", json!({"path": "Alpha", "heading": "Nope"}));
    assert!(e.contains("heading not found") && e.contains("## Tasks"), "{e}");
    assert!(fail(&mut s, "read_note", json!({"path": "Alpha", "block": "zzz"})).contains("^para"));
    assert!(fail(&mut s, "read_note", json!({"path": "alp"})).contains("did you mean: Projects/Alpha.md"));
    assert!(fail(&mut s, "read_note", json!({"path": "../etc/passwd"})).contains("not allowed"));
    assert!(fail(&mut s, "read_note", json!({"path": ".obsidian/app.json"})).contains("hidden"));
    assert!(fail(&mut s, "read_note", json!({"path": "/Home.md"})).contains("absolute"));
    assert!(fail(&mut s, "read_note", json!({"path": "pic.png"})).contains("not a Markdown note"));
}

#[test]
fn read_note_refuses_non_utf8() {
    let v = Tmp::new(&[("Latin.md", b"caf\xE9\n")]);
    let mut s = v.server();
    assert!(fail(&mut s, "read_note", json!({"path": "Latin.md"})).contains("not valid UTF-8"));
    assert!(fail(&mut s, "append_note", json!({"path": "Latin.md", "content": "x"})).contains("not valid UTF-8"));
    assert_eq!(v.bytes("Latin.md"), b"caf\xE9\n");
}

#[test]
fn list_notes_filters() {
    let v = sample();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "list_notes", json!({}));
    let paths: Vec<&str> = r["files"].as_array().unwrap().iter().map(|x| x["path"].as_str().unwrap()).collect();
    assert_eq!(paths, vec!["Home.md", "Projects/Alpha.md", "Projects/Beta.md"]);
    assert!(r["files"][0]["modified"].as_str().unwrap().ends_with('Z'));
    let (_, r) = ok(&mut s, "list_notes", json!({"folder": "Projects", "glob": "*beta*"}));
    assert_eq!(r["total"], 1);
    let (_, r) = ok(&mut s, "list_notes", json!({"include_attachments": true, "limit": 2}));
    assert_eq!((r["total"].as_u64(), r["returned"].as_u64(), r["truncated"].as_bool()), (Some(4), Some(2), Some(true)));
    let (_, r) = ok(&mut s, "list_notes", json!({"glob": "*.png", "include_attachments": true}));
    assert_eq!(r["files"][0]["path"], "pic.png");
    assert!(fail(&mut s, "list_notes", json!({"folder": "Nope"})).contains("folder not found"));
    assert!(fail(&mut s, "list_notes", json!({"folder": ".obsidian"})).contains("hidden"));
}

#[test]
fn backlinks_and_outgoing_links() {
    let v = sample();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "backlinks", json!({"path": "Projects/Alpha.md"}));
    let sources: Vec<&str> = r["backlinks"].as_array().unwrap().iter().map(|b| b["source"].as_str().unwrap()).collect();
    assert!(sources.contains(&"Projects/Beta.md") && sources.contains(&"Home.md"), "{sources:?}");
    assert_eq!(r["count"], 2);
    let beta = r["backlinks"].as_array().unwrap().iter().find(|b| b["source"] == "Projects/Beta.md").unwrap();
    assert_eq!(beta["references"][0]["link"], "[[Alpha#Tasks]]");
    assert_eq!(beta["references"][0]["line"], 5);

    let (_, r) = ok(&mut s, "backlinks", json!({"path": "pic.png"}));
    assert_eq!(r["count"], 1);

    let (_, r) = ok(&mut s, "outgoing_links", json!({"path": "Home"}));
    assert_eq!(r["resolved"], json!([{"target": "Projects/Alpha.md", "count": 1}]));
    assert_eq!(r["unresolved"], json!([{"target": "Missing note", "count": 1}]));
}

#[test]
fn tags_and_properties() {
    let v = sample();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "tags", json!({}));
    assert_eq!(r["tags"][0]["tag"], "#project");
    assert_eq!(r["tags"][0]["count"], 2);
    assert!(r["tags"].as_array().unwrap().iter().any(|t| t["tag"] == "#welcome"));
    let (_, r) = ok(&mut s, "tags", json!({"path": "Projects/Alpha.md"}));
    assert_eq!(r["tags"], json!(["#project", "#rust"]));

    let (_, r) = ok(&mut s, "properties", json!({"path": "Alpha"}));
    assert_eq!(r["properties"], json!({"status": "active", "tags": ["project", "rust"]}));
    let (_, r) = ok(&mut s, "properties", json!({}));
    assert_eq!(r["properties"], json!([{"name": "status", "notes": 2}, {"name": "tags", "notes": 2}]));
}

#[test]
fn index_follows_external_changes() {
    let v = sample();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "search", json!({"query": "zebra"}));
    assert_eq!(r["fileCount"], 0);
    v.write("New/Zoo.md", "a zebra [[Home]]\n");
    let (_, r) = ok(&mut s, "search", json!({"query": "zebra"}));
    assert_eq!(r["results"][0]["path"], "New/Zoo.md");
    let (_, r) = ok(&mut s, "backlinks", json!({"path": "Home"}));
    assert!(r["backlinks"].as_array().unwrap().iter().any(|b| b["source"] == "New/Zoo.md"));
    fs::remove_file(v.0.join("New/Zoo.md")).unwrap();
    let (_, r) = ok(&mut s, "search", json!({"query": "zebra"}));
    assert_eq!(r["fileCount"], 0);
}

// ---- write tools ------------------------------------------------------------------------

#[test]
fn create_note_rules() {
    let v = sample();
    let mut s = v.server();
    let (t, r) = ok(&mut s, "create_note", json!({"path": "Ideas/New idea", "content": "Links to [[Home]]\r\n"}));
    assert_eq!(t, "Created Ideas/New idea.md");
    assert_eq!(r["uri"], "vault://Ideas/New%20idea.md");
    assert_eq!(v.read("Ideas/New idea.md"), "Links to [[Home]]\n");
    let (_, r) = ok(&mut s, "backlinks", json!({"path": "Home"}));
    assert!(r["backlinks"].as_array().unwrap().iter().any(|b| b["source"] == "Ideas/New idea.md"), "new note is indexed");
    assert!(fail(&mut s, "create_note", json!({"path": "Home.md"})).contains("already exists"));
    assert!(fail(&mut s, "create_note", json!({"path": "home.md"})).contains("already exists"));
    assert!(fail(&mut s, "create_note", json!({"path": "../outside.md"})).contains("not allowed"));
    assert!(fail(&mut s, "create_note", json!({"path": ".obsidian/plugins/x.md"})).contains("hidden"));
    assert!(!v.0.join("../outside.md").exists());
}

#[test]
fn edit_note_exact_replacement() {
    let v = sample();
    let mut s = v.server();
    let (t, _) = ok(&mut s, "edit_note", json!({"path": "Home", "old_string": "See [[Alpha]]", "new_string": "Visit [[Alpha]]"}));
    assert!(t.contains("replaced 1 occurrence"));
    assert_eq!(v.read("Home.md"), "# Home\nVisit [[Alpha]] and [[Missing note]].\n#welcome\n");
    assert!(fail(&mut s, "edit_note", json!({"path": "Beta", "old_string": "zzz", "new_string": ""})).contains("not found"));
    assert!(fail(&mut s, "edit_note", json!({"path": "Beta", "old_string": "a", "new_string": "b"})).contains("times"));
    assert!(fail(&mut s, "edit_note", json!({"path": "Beta", "old_string": "a"})).contains("both"));
    assert!(fail(&mut s, "edit_note", json!({"path": "Beta", "old_string": "a", "new_string": "b", "heading": "x", "content": "y"})).contains("one mode"));
    assert!(fail(&mut s, "edit_note", json!({"path": "Beta"})).contains("one mode"));
}

#[test]
fn edit_note_section_and_block() {
    let v = sample();
    let mut s = v.server();
    ok(&mut s, "edit_note", json!({"path": "Alpha", "heading": "Tasks", "content": "- [x] write tests\n- [ ] ship"}));
    let text = v.read("Projects/Alpha.md");
    assert!(text.contains("## Tasks\n- [x] write tests\n- [ ] ship\n\n## Notes\n"), "{text}");
    ok(&mut s, "edit_note", json!({"path": "Alpha", "heading": "Notes", "content": "## Notes\nRewritten."}));
    assert!(v.read("Projects/Alpha.md").ends_with("## Notes\nRewritten.\n"));
    v.write("B.md", "Intro\n\nOld paragraph. ^keep\n\nOutro\n");
    ok(&mut s, "edit_note", json!({"path": "B", "block": "^keep", "content": "New paragraph."}));
    assert_eq!(v.read("B.md"), "Intro\n\nNew paragraph. ^keep\n\nOutro\n");
    assert!(fail(&mut s, "edit_note", json!({"path": "B", "heading": "Intro"})).contains("`content` is required"));
    assert!(fail(&mut s, "edit_note", json!({"path": "B", "content": "x"})).contains("heading"));
}

#[test]
fn writes_preserve_crlf_and_bom() {
    let v = Tmp::new(&[("Win.md", b"\xEF\xBB\xBF# Win\r\nline one\r\n\r\n## Log\r\nfirst\r\n")]);
    let mut s = v.server();
    ok(&mut s, "edit_note", json!({"path": "Win", "old_string": "line one\n", "new_string": "line 1\n"}));
    ok(&mut s, "append_note", json!({"path": "Win", "heading": "Log", "content": "second"}));
    ok(&mut s, "set_property", json!({"path": "Win", "name": "os", "value": "windows"}));
    assert_eq!(v.bytes("Win.md"), b"\xEF\xBB\xBF---\r\nos: windows\r\n---\r\n# Win\r\nline 1\r\n\r\n## Log\r\nfirst\r\nsecond\r\n".to_vec());
}

#[test]
fn append_note_end_heading_and_create() {
    let v = sample();
    let mut s = v.server();
    ok(&mut s, "append_note", json!({"path": "Beta", "content": "Appended."}));
    assert!(v.read("Projects/Beta.md").ends_with("alpha again\nAppended.\n"));
    ok(&mut s, "append_note", json!({"path": "Alpha", "heading": "Tasks", "content": "- [ ] celebrate"}));
    assert!(v.read("Projects/Alpha.md").contains("- [ ] ship\n- [ ] celebrate\n\n## Notes"));
    assert!(fail(&mut s, "append_note", json!({"path": "Inbox/Later", "content": "x"})).contains("not found"));
    let (_, r) = ok(&mut s, "append_note", json!({"path": "Inbox/Later", "content": "first", "create_if_missing": true}));
    assert_eq!(r["created"], true);
    assert_eq!(v.read("Inbox/Later.md"), "first\n");
    v.write("NoNewline.md", "tail");
    ok(&mut s, "append_note", json!({"path": "NoNewline", "content": "more"}));
    assert_eq!(v.read("NoNewline.md"), "tail\nmore\n");
}

#[test]
fn set_property_touches_only_that_property() {
    let v = sample();
    let mut s = v.server();
    ok(&mut s, "set_property", json!({"path": "Alpha", "name": "tags", "value": ["project", "rust", "mcp"]}));
    let text = v.read("Projects/Alpha.md");
    assert!(text.starts_with("---\nstatus: active # keep this comment\ntags:\n"), "{text}");
    ok(&mut s, "set_property", json!({"path": "Alpha", "name": "due", "value": "2026-10-01"}));
    ok(&mut s, "set_property", json!({"path": "Alpha", "name": "related", "value": "[[Beta]]"}));
    let (_, r) = ok(&mut s, "properties", json!({"path": "Alpha"}));
    assert_eq!(r["properties"], json!({"status": "active", "tags": ["project", "rust", "mcp"], "due": "2026-10-01", "related": "[[Beta]]"}));
    assert!(v.read("Projects/Alpha.md").contains("status: active # keep this comment"));
    let (_, r) = ok(&mut s, "outgoing_links", json!({"path": "Alpha"}));
    assert!(r["resolved"].as_array().unwrap().iter().any(|l| l["target"] == "Projects/Beta.md"), "frontmatter link indexed: {r}");

    ok(&mut s, "set_property", json!({"path": "Alpha", "name": "tags", "value": null}));
    let (_, r) = ok(&mut s, "properties", json!({"path": "Alpha"}));
    assert!(r["properties"].get("tags").is_none());
    assert!(v.read("Projects/Alpha.md").contains("# Alpha\nBack to [[Home]]"));

    ok(&mut s, "set_property", json!({"path": "Home", "name": "count", "value": 3}));
    assert!(v.read("Home.md").starts_with("---\ncount: 3\n---\n# Home\n"));
    let (t, _) = ok(&mut s, "set_property", json!({"path": "Home", "name": "absent", "value": null}));
    assert!(t.contains("no changes"));

    v.write("Bad.md", "---\nkey: [unclosed\n---\nbody\n");
    assert!(fail(&mut s, "set_property", json!({"path": "Bad", "name": "x", "value": 1})).contains("not valid YAML"));
    assert!(fail(&mut s, "set_property", json!({"path": "Home", "name": "", "value": 1})).contains("name"));
}

#[test]
fn rename_note_updates_links() {
    let v = sample();
    let mut s = v.server();
    let (t, r) = ok(&mut s, "rename_note", json!({"path": "Projects/Alpha.md", "new_path": "Archive/Alpha 2026"}));
    assert!(t.starts_with("Renamed Projects/Alpha.md → Archive/Alpha 2026.md"), "{t}");
    assert!(!v.0.join("Projects/Alpha.md").exists());
    assert!(v.read("Archive/Alpha 2026.md").contains("Back to [[Home]]"));
    assert!(v.read("Home.md").contains("[[Alpha 2026]]"), "{}", v.read("Home.md"));
    assert!(v.read("Projects/Beta.md").contains("[[Alpha 2026#Tasks]]"));
    assert_eq!(r["notes_updated"].as_array().unwrap().len(), 2);
    let (_, r) = ok(&mut s, "backlinks", json!({"path": "Archive/Alpha 2026.md"}));
    assert_eq!(r["count"], 2);

    ok(&mut s, "rename_note", json!({"path": "Beta", "new_path": "Gamma"}));
    assert!(v.0.join("Projects/Gamma.md").exists(), "a bare name keeps the folder");
    assert!(fail(&mut s, "rename_note", json!({"path": "Home", "new_path": "Projects/Gamma.md"})).contains("already exists"));
    assert!(fail(&mut s, "rename_note", json!({"path": "Home", "new_path": "../Home.md"})).contains("not allowed"));
    assert!(fail(&mut s, "rename_note", json!({"path": "Home", "new_path": ".trash/Home.md"})).contains("hidden"));
}

#[test]
fn daily_note_uses_settings_and_template() {
    let v = sample();
    v.write(".obsidian/daily-notes.json", r#"{"folder": "Journal/", "format": "YYYY-MM-DD", "template": "Templates/Day"}"#);
    v.write("Templates/Day.md", "# {{title}}\n\n## Log\n");
    let mut s = v.server();
    assert!(fail(&mut s, "daily_note", json!({"date": "2026-01-02"})).contains("does not exist"));
    let (_, r) = ok(&mut s, "daily_note", json!({"action": "create", "date": "2026-01-02"}));
    assert_eq!(r["path"], "Journal/2026-01-02.md");
    assert_eq!(r["created"], true);
    assert_eq!(v.read("Journal/2026-01-02.md"), "# 2026-01-02\n\n## Log\n");
    let (_, r) = ok(&mut s, "daily_note", json!({"action": "create", "date": "2026-01-02"}));
    assert_eq!(r["created"], false);
    ok(&mut s, "daily_note", json!({"action": "append", "date": "2026-01-02", "content": "- met Ada"}));
    let (t, _) = ok(&mut s, "daily_note", json!({"date": "2026-01-02"}));
    assert!(t.ends_with("## Log\n- met Ada\n"), "{t}");
    assert!(fail(&mut s, "daily_note", json!({"action": "append", "date": "2026-01-03"})).contains("content"));
    assert!(!v.0.join("Journal/2026-01-03.md").exists());
    assert!(fail(&mut s, "daily_note", json!({"action": "delete"})).contains("action"));

    v.write(".obsidian/daily-notes.json", r#"{"folder": "../escape"}"#);
    assert!(fail(&mut s, "daily_note", json!({"action": "create"})).contains("invalid path"));
}

// ---- read-only and protocol ------------------------------------------------------------

fn rpc(s: &mut Server, v: Value) -> Value {
    s.handle(v).expect("a response")
}

fn modern_meta() -> Value {
    json!({ "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} })
}

#[test]
fn read_only_hides_write_tools() {
    let v = sample();
    let mut s = Server::open(&v.0, true).unwrap();
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}));
    let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["search", "read_note", "list_notes", "backlinks", "outgoing_links", "tags", "properties", "daily_note"]);
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "create_note", "arguments": {"path": "X"}}}));
    assert_eq!(r["error"]["code"], -32602);
    assert!(r["error"]["message"].as_str().unwrap().contains("read-only"));
    assert!(fail(&mut s, "daily_note", json!({"action": "create"})).contains("read-only"));
    assert!(!v.0.join("X.md").exists());
}

#[test]
fn tool_definitions_are_well_formed() {
    let all = tools::definitions(false);
    assert_eq!(all.len(), 13);
    for t in &all {
        let name = t["name"].as_str().unwrap();
        assert!(name.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{name}");
        assert!(t["description"].as_str().unwrap().len() > 40, "{name}");
        assert_eq!(t["inputSchema"]["type"], "object", "{name}");
        for req in t["inputSchema"]["required"].as_array().unwrap() {
            assert!(t["inputSchema"]["properties"].get(req.as_str().unwrap()).is_some(), "{name}: {req}");
        }
        assert!(t["annotations"]["readOnlyHint"].is_boolean());
    }
}

#[test]
fn legacy_handshake_and_calls() {
    let v = sample();
    let mut s = v.server();
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}));
    assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(r["result"]["serverInfo"]["name"], "openmarkdown-vault");
    assert!(r["result"]["capabilities"]["tools"].is_object());
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2099-01-01"}}));
    assert_eq!(r["result"]["protocolVersion"], "2025-11-25");
    assert!(s.handle(json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).is_none());
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": "p", "method": "ping"}));
    assert_eq!(r, json!({"jsonrpc": "2.0", "id": "p", "result": {}}));

    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "read_note", "arguments": {"path": "Home"}}}));
    assert_eq!(r["result"]["isError"], false);
    assert!(r["result"]["content"][0]["text"].as_str().unwrap().starts_with("# Home"));
    assert!(r["result"].get("resultType").is_none(), "legacy results stay plain");
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "read_note", "arguments": {"path": "Nope"}}}));
    assert_eq!(r["result"]["isError"], true);
    assert!(r["result"]["content"][0]["text"].as_str().unwrap().contains("not found"));
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "rm_rf"}}));
    assert_eq!(r["error"]["code"], -32602);
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 5, "method": "prompts/list"}));
    assert_eq!(r["error"]["code"], -32601);

    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 6, "method": "resources/list"}));
    let uris: Vec<&str> = r["result"]["resources"].as_array().unwrap().iter().map(|x| x["uri"].as_str().unwrap()).collect();
    assert_eq!(uris, vec!["vault://Home.md", "vault://Projects/Alpha.md", "vault://Projects/Beta.md"]);
    assert_eq!(r["result"]["resources"][0]["mimeType"], "text/markdown");
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 7, "method": "resources/read", "params": {"uri": "vault://Projects/Alpha.md"}}));
    assert_eq!(r["result"]["contents"][0]["mimeType"], "text/markdown");
    assert!(r["result"]["contents"][0]["text"].as_str().unwrap().contains("# Alpha"));
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 8, "method": "resources/read", "params": {"uri": "vault://..%2F..%2Fetc%2Fpasswd"}}));
    assert_eq!(r["error"]["code"], -32002);
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 9, "method": "resources/read", "params": {"uri": "vault://.obsidian/app.json"}}));
    assert_eq!(r["error"]["code"], -32002);
}

#[test]
fn modern_stateless_requests() {
    let v = sample();
    let mut s = v.server();
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": "d", "method": "server/discover", "params": {"_meta": modern_meta()}}));
    assert_eq!(r["result"]["resultType"], "complete");
    assert_eq!(r["result"]["supportedVersions"][0], "2026-07-28");
    assert!(r["result"]["supportedVersions"].as_array().unwrap().contains(&json!("2025-11-25")));
    assert_eq!(r["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "openmarkdown-vault");
    assert!(r["result"]["ttlMs"].as_u64().is_some() && r["result"]["cacheScope"] == "public");

    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {"_meta": modern_meta()}}));
    assert_eq!(r["result"]["tools"].as_array().unwrap().len(), 13);
    assert_eq!(r["result"]["resultType"], "complete");
    assert!(r["result"]["ttlMs"].is_u64());

    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"_meta": modern_meta(), "name": "tags", "arguments": {}}}));
    assert_eq!(r["result"]["resultType"], "complete");
    assert_eq!(r["result"]["structuredContent"]["tags"][0]["tag"], "#project");
    let text: Value = serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text, r["result"]["structuredContent"]);
    assert!(r["result"].get("ttlMs").is_none());

    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 3, "method": "resources/read", "params": {"_meta": modern_meta(), "uri": "vault://Nope.md"}}));
    assert_eq!(r["error"]["code"], -32602);
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 4, "method": "resources/read", "params": {"_meta": modern_meta(), "uri": "vault://Home.md"}}));
    assert_eq!(r["result"]["cacheScope"], "private");

    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": "1900-01-01", "io.modelcontextprotocol/clientCapabilities": {}}}}));
    assert_eq!(r["error"]["code"], -32022);
    assert_eq!(r["error"]["data"]["requested"], "1900-01-01");
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 6, "method": "tools/list", "params": {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}}}));
    assert_eq!(r["error"]["code"], -32602);
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 7, "method": "server/discover"}));
    assert_eq!(r["error"]["code"], -32602);
}

#[test]
fn malformed_messages() {
    let v = sample();
    let mut s = v.server();
    let r: Value = serde_json::from_str(&s.handle_line("{not json").unwrap()).unwrap();
    assert_eq!(r["error"]["code"], -32700);
    assert_eq!(r["id"], Value::Null);
    let r = rpc(&mut s, json!([{"jsonrpc": "2.0", "id": 1, "method": "ping"}]));
    assert_eq!(r["error"]["code"], -32600);
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": null, "method": "ping"}));
    assert_eq!(r["error"]["code"], -32600);
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "search", "arguments": "x"}}));
    assert_eq!(r["error"]["code"], -32602);
    assert!(s.handle(json!({"jsonrpc": "2.0", "id": 9, "result": {}})).is_none());

    let mut out = Vec::new();
    let input = b"\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\"}\n\xff\n";
    s.serve(&mut &input[..], &mut out).unwrap();
    let lines: Vec<&str> = std::str::from_utf8(&out).unwrap().lines().collect();
    assert_eq!(lines.len(), 2);
    let first: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!((first["id"].clone(), first["result"].clone()), (json!(1), json!({})));
    assert!(lines[1].contains("-32700"));
}
