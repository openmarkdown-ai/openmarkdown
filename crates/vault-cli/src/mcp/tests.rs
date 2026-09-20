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
    assert_eq!(
        names,
        vec![
            "search", "read_note", "list_notes", "backlinks", "outgoing_links", "tags", "properties", "unlinked_mentions", "list_folders",
            "vault_stats", "list_trash", "open_in_app", "render_note", "run_base", "graph", "graph_image", "canvas_read", "canvas_image",
            "daily_note", "periodic_note"
        ]
    );
    for write in ["move_note", "delete_note", "restore_note", "create_folder", "replace_in_vault", "rename_tag", "export_note", "export_vault", "clip_html", "import_notes", "canvas_edit"] {
        assert!(!names.contains(&write), "{write} must be hidden in read-only mode");
        let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": write, "arguments": {}}}));
        assert_eq!(r["error"]["code"], -32602, "{write}: {r}");
    }
    assert!(fail(&mut s, "periodic_note", json!({"period": "weekly", "action": "create"})).contains("read-only"));
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "create_note", "arguments": {"path": "X"}}}));
    assert_eq!(r["error"]["code"], -32602);
    assert!(r["error"]["message"].as_str().unwrap().contains("read-only"));
    assert!(fail(&mut s, "daily_note", json!({"action": "create"})).contains("read-only"));
    assert!(!v.0.join("X.md").exists());
}

#[test]
fn tool_definitions_are_well_formed() {
    let all = tools::definitions(false);
    assert_eq!(all.len(), 36, "{:?}", all.iter().map(|t| t["name"].clone()).collect::<Vec<_>>());
    let mut seen: Vec<&str> = Vec::new();
    for t in &all {
        let name = t["name"].as_str().unwrap();
        assert!(name.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{name}");
        assert!(t["description"].as_str().unwrap().len() > 40, "{name}");
        assert_eq!(t["inputSchema"]["type"], "object", "{name}");
        for req in t["inputSchema"]["required"].as_array().unwrap() {
            assert!(t["inputSchema"]["properties"].get(req.as_str().unwrap()).is_some(), "{name}: {req}");
        }
        assert!(t["annotations"]["readOnlyHint"].is_boolean());
        assert!(t["title"].as_str().is_some_and(|x| !x.is_empty()), "{name}");
        assert_eq!(t["inputSchema"]["additionalProperties"], false, "{name}");
        for (prop, schema) in t["inputSchema"]["properties"].as_object().unwrap() {
            assert!(prop.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{name}.{prop}");
            assert!(schema.is_object(), "{name}.{prop}");
        }
        assert!(!seen.contains(&name), "duplicate tool {name}");
        seen.push(name);
        assert!(tools::exists(name), "{name} is not in the registry");
    }
    // Every registered tool is also offered, and the read/write split agrees.
    for name in tools::read_names() {
        assert!(seen.contains(&name), "{name} is registered but not listed");
        assert!(!tools::is_write(name), "{name}");
    }
    for name in tools::write_names() {
        assert!(seen.contains(&name), "{name} is registered but not listed");
        assert!(tools::is_write(name), "{name}");
        let t = all.iter().find(|t| t["name"] == name).unwrap();
        assert_eq!(t["annotations"]["readOnlyHint"], false, "{name} writes but claims to be read-only");
    }
    let read_only = tools::definitions(true);
    for t in &read_only {
        assert!(!tools::is_write(t["name"].as_str().unwrap()), "{} leaked into read-only mode", t["name"]);
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
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 5, "method": "sampling/createMessage"}));
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
    assert_eq!(r["result"]["tools"].as_array().unwrap().len(), 36);
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

// ---- vault operations: move, trash, folders, mentions, stats ----------------------------

#[test]
fn move_note_updates_links_and_previews() {
    let v = sample();
    let mut s = v.server();
    let (t, r) = ok(&mut s, "move_note", json!({"path": "Projects/Alpha.md", "to": "Archive", "dry_run": true}));
    assert!(t.starts_with("Would move Projects/Alpha.md → Archive/Alpha.md"), "{t}");
    assert_eq!(r["dry_run"], true);
    assert_eq!(r["moves"], json!([{"from": "Projects/Alpha.md", "to": "Archive/Alpha.md"}]));
    assert!(v.0.join("Projects/Alpha.md").exists(), "a dry run must not move anything");

    let (t, r) = ok(&mut s, "move_note", json!({"path": "Alpha", "to": "Archive"}));
    assert!(t.starts_with("Moved Projects/Alpha.md → Archive/Alpha.md"), "{t}");
    assert_eq!(r["new_path"], "Archive/Alpha.md");
    assert!(!v.0.join("Projects/Alpha.md").exists());
    assert!(v.read("Home.md").contains("[[Alpha]]"), "a shortest-form link still resolves, so it is left alone");
    assert!(v.read("Projects/Beta.md").contains("[[Alpha#Tasks]]"));

    // Changing the name does rewrite the links that named it.
    let (t, r) = ok(&mut s, "move_note", json!({"path": "Archive/Alpha.md", "to": "Archive/Alpha (old).md", "dry_run": true}));
    assert!(t.contains("update 2 links in 2 notes"), "{t}");
    assert_eq!(r["notes_to_update"], json!(["Home.md", "Projects/Beta.md"]));
    let (_, r) = ok(&mut s, "move_note", json!({"path": "Archive/Alpha.md", "to": "Archive/Alpha (old).md"}));
    assert_eq!((r["new_path"].clone(), r["links_updated"].clone()), (json!("Archive/Alpha (old).md"), json!(2)));
    assert!(v.read("Projects/Beta.md").contains("[[Alpha (old)#Tasks]]"), "{}", v.read("Projects/Beta.md"));
    // A name with no extension is a folder, so the note keeps its own name.
    let (_, r) = ok(&mut s, "move_note", json!({"path": "Archive/Alpha (old).md", "to": "Done"}));
    assert_eq!(r["new_path"], "Done/Alpha (old).md");

    assert!(fail(&mut s, "move_note", json!({"path": "Home.md", "to": "Home.md"})).contains("same"));
    assert!(fail(&mut s, "move_note", json!({"path": "Nope", "to": "X"})).contains("not found"));
    assert!(fail(&mut s, "move_note", json!({"path": "Home.md", "to": "../out.md"})).contains("not allowed"));
}

#[test]
fn move_folder_moves_everything_inside() {
    let v = sample();
    let mut s = v.server();
    let (t, r) = ok(&mut s, "move_note", json!({"path": "Projects", "to": "Work"}));
    assert!(t.contains("Moved Projects → Work"), "{t}");
    assert!(r["files_moved"].as_u64().unwrap() >= 2, "{r}");
    assert!(v.0.join("Work/Alpha.md").is_file() && !v.0.join("Projects").exists());
    assert!(v.read("Work/Beta.md").contains("[[Alpha#Tasks]]"));
}

#[test]
fn delete_to_trash_and_restore() {
    let v = sample();
    let mut s = v.server();
    let (t, r) = ok(&mut s, "delete_note", json!({"path": "Projects/Alpha.md"}));
    assert!(t.contains(".trash/Alpha.md") && t.contains("restore_note"), "{t}");
    assert_eq!(r["broken_backlinks"], 2);
    assert!(!v.0.join("Projects/Alpha.md").exists());
    assert_eq!(v.read(".trash/Alpha.md").lines().next(), Some("---"));
    // Gone from the index, so search and links no longer see it.
    let (_, sr) = ok(&mut s, "search", json!({"query": "\"alpha plan\""}));
    assert_eq!(sr["fileCount"], 0);

    let (_, lt) = ok(&mut s, "list_trash", json!({}));
    let entry = lt["trash"].as_array().unwrap().iter().find(|e| e["name"] == "Alpha.md").expect("Alpha.md in the trash");
    assert_eq!(entry["type"], "file");
    assert!(entry["bytes"].as_u64().unwrap() > 0);

    // A second file of the same name is kept beside the first.
    v.write("Projects/Alpha.md", "a different Alpha\n");
    ok(&mut s, "delete_note", json!({"path": "Projects/Alpha.md"}));
    assert_eq!(v.read(".trash/Alpha 1.md"), "a different Alpha\n");

    let (t, r) = ok(&mut s, "restore_note", json!({"path": "Alpha.md", "to": "Projects/Alpha.md"}));
    assert!(t.contains("→ Projects/Alpha.md"), "{t}");
    assert_eq!(r["path"], "Projects/Alpha.md");
    assert!(v.read("Projects/Alpha.md").contains("The alpha plan"));
    let (_, sr) = ok(&mut s, "search", json!({"query": "\"alpha plan\""}));
    assert_eq!(sr["fileCount"], 1, "the restored note is indexed again");

    assert!(fail(&mut s, "restore_note", json!({"path": "Alpha 1.md", "to": "Projects/Alpha.md"})).contains("already exists"));
    assert!(fail(&mut s, "restore_note", json!({"path": "Nothing.md"})).contains("not in the trash"));
    assert!(fail(&mut s, "restore_note", json!({"path": "../escape.md"})).contains("not allowed"));
    assert!(fail(&mut s, "delete_note", json!({"path": ".obsidian/app.json"})).contains("hidden"));
}

#[test]
fn restore_uses_the_recorded_origin() {
    let v = sample();
    v.write(".obsidian/trash.json", r#"{"origins": {".trash/Alpha.md": "Projects/Alpha.md"}}"#);
    let mut s = v.server();
    ok(&mut s, "delete_note", json!({"path": "Projects/Alpha.md"}));
    let (_, lt) = ok(&mut s, "list_trash", json!({}));
    let entry = lt["trash"].as_array().unwrap().iter().find(|e| e["name"] == "Alpha.md").unwrap();
    assert_eq!(entry["original_path"], "Projects/Alpha.md");
    let (_, r) = ok(&mut s, "restore_note", json!({"path": "Alpha.md"}));
    assert_eq!(r["path"], "Projects/Alpha.md");
}

#[test]
fn folders_are_listed_and_created() {
    let v = sample();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "list_folders", json!({}));
    let names: Vec<&str> = r["folders"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Projects"]);
    assert_eq!(r["folders"][0]["notes"], 2);

    let (t, _) = ok(&mut s, "create_folder", json!({"path": "Areas/2026"}));
    assert_eq!(t, "Created folder Areas/2026");
    assert!(v.0.join("Areas/2026").is_dir());
    let (t, _) = ok(&mut s, "create_folder", json!({"path": "Areas/2026"}));
    assert!(t.contains("already exists"));
    let (_, r) = ok(&mut s, "list_folders", json!({}));
    let names: Vec<&str> = r["folders"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Areas", "Areas/2026", "Projects"], "empty folders are listed too");
    let (_, r) = ok(&mut s, "list_folders", json!({"folder": "Areas", "depth": 1}));
    assert_eq!(r["folders"][0]["path"], "Areas/2026");
    assert!(fail(&mut s, "create_folder", json!({"path": ".obsidian/x"})).contains("hidden"));
    assert!(fail(&mut s, "create_folder", json!({"path": "Home.md"})).contains("is a file"));
}

#[test]
fn unlinked_mentions_finds_plain_text_names() {
    let v = sample();
    v.write("Notes/Mention.md", "Alpha is mentioned here, and [[Alpha]] is linked.\n");
    let mut s = v.server();
    let (_, r) = ok(&mut s, "unlinked_mentions", json!({"path": "Projects/Alpha.md"}));
    let sources: Vec<&str> = r["notes"].as_array().unwrap().iter().map(|n| n["source"].as_str().unwrap()).collect();
    assert!(sources.contains(&"Notes/Mention.md"), "{sources:?}");
    let m = r["notes"].as_array().unwrap().iter().find(|n| n["source"] == "Notes/Mention.md").unwrap();
    assert_eq!(m["count"], 1, "the linked occurrence is not a mention");
    assert!(m["mentions"][0]["text"].as_str().unwrap().contains("Alpha is mentioned"));
    assert!(fail(&mut s, "unlinked_mentions", json!({"path": "Nope"})).contains("not found"));
}

#[test]
fn vault_stats_counts_everything() {
    let v = sample();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "vault_stats", json!({}));
    assert_eq!(r["notes"], 3);
    assert_eq!(r["attachments"], 1);
    assert!(r["words"].as_u64().unwrap() > 10, "{r}");
    assert_eq!(r["brokenLinks"], 1);
    assert_eq!(r["topMissingNotes"][0]["target"], "Missing note");
    assert_eq!(r["tags"], 3);
    assert_eq!(r["topTags"][0]["tag"], "#project");
    assert_eq!(r["settings"]["newLinkFormat"], "shortest");
    assert!(r["recentlyModified"][0]["modified"].as_str().unwrap().ends_with('Z'));
    let (_, r) = ok(&mut s, "vault_stats", json!({"top": 0}));
    assert_eq!(r["topTags"], json!([]));
}

#[test]
fn open_in_app_builds_urls() {
    let v = sample();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "open_in_app", json!({"path": "Alpha"}));
    let name = v.0.file_name().unwrap().to_string_lossy().to_string();
    let uri = format!("obsidian://open?vault={}&file=Projects%2FAlpha", percent(&name));
    assert_eq!(r["obsidian_url"], uri);
    assert_eq!(r["web_url"], format!("https://openmarkdown.ai/?uri={}", percent(&uri)));

    let (_, r) = ok(&mut s, "open_in_app", json!({"path": "Alpha", "heading": "Tasks"}));
    assert!(r["obsidian_url"].as_str().unwrap().ends_with("file=Projects%2FAlpha%23Tasks"), "{r}");
    let (_, r) = ok(&mut s, "open_in_app", json!({"path": "Alpha", "block": "para"}));
    assert!(r["obsidian_url"].as_str().unwrap().ends_with("%23%5Epara"), "{r}");
    let (_, r) = ok(&mut s, "open_in_app", json!({"action": "search", "query": "tag:#project"}));
    assert!(r["obsidian_url"].as_str().unwrap().contains("obsidian://search?vault="));
    assert!(r["obsidian_url"].as_str().unwrap().ends_with("&query=tag%3A%23project"));
    let (_, r) = ok(&mut s, "open_in_app", json!({"action": "daily", "base_url": "http://localhost:5173/"}));
    assert!(r["web_url"].as_str().unwrap().starts_with("http://localhost:5173/?uri=obsidian%3A%2F%2Fdaily"));

    assert!(fail(&mut s, "open_in_app", json!({"path": "Alpha", "heading": "Nope"})).contains("heading not found"));
    assert!(fail(&mut s, "open_in_app", json!({"action": "search"})).contains("`query` is required"));
    assert!(fail(&mut s, "open_in_app", json!({"path": "Alpha", "base_url": "javascript:x"})).contains("http"));
}

/// The percent-encoding `open_in_app` uses, for the expectations above.
fn percent(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

#[test]
fn periodic_notes_use_the_settings() {
    let v = sample();
    v.write(".obsidian/periodic-notes.json", r#"{"weekly": {"format": "gggg-[W]ww", "folder": "Weeks"}, "monthly": {"format": "YYYY-MM", "folder": "Months"}}"#);
    let mut s = v.server();
    assert!(fail(&mut s, "periodic_note", json!({"period": "weekly"})).contains("does not exist yet"));
    assert!(fail(&mut s, "periodic_note", json!({"period": "daily"})).contains("daily_note"));

    let (t, r) = ok(&mut s, "periodic_note", json!({"period": "weekly", "action": "create"}));
    let path = r["path"].as_str().unwrap().to_string();
    assert!(path.starts_with("Weeks/") && path.contains("-W") && path.ends_with(".md"), "{path}");
    assert_eq!(path.len(), "Weeks/2026-W38.md".len(), "gggg-[W]ww must resolve the week-year: {path}");
    assert!(t.starts_with("Created Weeks/"));
    assert_eq!(r["created"], true);

    let (_, r2) = ok(&mut s, "periodic_note", json!({"period": "weekly", "action": "append", "content": "- did a thing"}));
    assert_eq!(r2["created"], false);
    assert!(v.read(&path).contains("- did a thing"));

    let (_, last) = ok(&mut s, "periodic_note", json!({"period": "weekly", "action": "create", "date": "last"}));
    assert_ne!(last["path"], json!(path), "`last` is the previous week");
    let (_, m) = ok(&mut s, "periodic_note", json!({"period": "monthly", "action": "create", "date": "2026-03-15"}));
    assert_eq!(m["path"], "Months/2026-03.md");
    let (_, q) = ok(&mut s, "periodic_note", json!({"period": "quarterly", "action": "create", "date": "2026-03-15"}));
    assert_eq!(q["path"], "2026-Q1.md", "the default format and the vault root");
    let (_, y) = ok(&mut s, "periodic_note", json!({"period": "yearly", "action": "create", "date": "2026-03-15"}));
    assert_eq!(y["path"], "2026.md");
}

#[test]
fn periodic_note_uses_a_template() {
    let v = sample();
    v.write(".obsidian/periodic-notes.json", r#"{"monthly": {"format": "YYYY-MM", "folder": "Months", "template": "Templates/Month.md"}}"#);
    v.write("Templates/Month.md", "# {{title}}\nMonday was {{monday:YYYY-MM-DD}}\n");
    let mut s = v.server();
    let (_, r) = ok(&mut s, "periodic_note", json!({"period": "monthly", "action": "create", "date": "2026-03-15"}));
    let text = v.read("Months/2026-03.md");
    assert!(text.starts_with("# 2026-03\n"), "{text}");
    assert!(text.contains("Monday was 2026-03-16"), "{text}");
    assert_eq!(r["path"], "Months/2026-03.md");
}

// ---- replace and rename_tag -------------------------------------------------------------

fn replace_vault() -> Tmp {
    Tmp::new(&[
        ("Notes/One.md", b"---\nstatus: Acme Corp\ntags: [acme]\n---\nAcme Corp ships things.\nSee [[Acme Corp]] and https://acme.example/corp.\n#acme/team writes it.\n"),
        ("Notes/Two.md", b"Acme Corp again, and `Acme Corp` in code.\n"),
        ("Acme Corp.md", b"About #acme and #acme/team.\n"),
        (".obsidian/app.json", b"{}"),
    ])
}

#[test]
fn replace_in_vault_previews_before_writing() {
    let v = replace_vault();
    let mut s = v.server();
    let (t, r) = ok(&mut s, "replace_in_vault", json!({"query": "Acme Corp", "replacement": "Globex"}));
    assert!(t.starts_with("Preview only — nothing was written."), "{t}");
    assert_eq!(r["applied"], false);
    assert!(r["replacements"].as_u64().unwrap() >= 3, "{r}");
    assert!(v.read("Notes/Two.md").contains("Acme Corp"), "a preview must not write");

    // Link targets, property values that are names, tags and URLs are skipped.
    let reasons: Vec<&str> = r["skipped_examples"].as_array().unwrap().iter().map(|x| x["reason"].as_str().unwrap()).collect();
    assert!(reasons.iter().any(|x| x.contains("link target")), "{reasons:?}");
    // A one-word query reaches the tag and the URL too.
    let (_, w) = ok(&mut s, "replace_in_vault", json!({"query": "acme", "replacement": "globex"}));
    let reasons: Vec<&str> = w["skipped_examples"].as_array().unwrap().iter().map(|x| x["reason"].as_str().unwrap()).collect();
    assert!(reasons.iter().any(|x| x.contains("web address")), "{reasons:?}");
    assert!(reasons.iter().any(|x| x.contains("a tag")), "{reasons:?}");
    let one = r["changes"].as_array().unwrap().iter().find(|c| c["path"] == "Notes/One.md").unwrap();
    let after: Vec<&str> = one["diff"].as_array().unwrap().iter().map(|d| d["after"].as_str().unwrap()).collect();
    assert!(after.contains(&"Globex ships things."), "{after:?}");

    let (t, r) = ok(&mut s, "replace_in_vault", json!({"query": "Acme Corp", "replacement": "Globex", "apply": true}));
    assert!(t.starts_with("Replaced"), "{t}");
    assert_eq!(r["applied"], true);
    assert!(v.read("Notes/Two.md").starts_with("Globex again"));
    assert!(v.read("Notes/One.md").contains("[[Acme Corp]]"), "the link target is untouched");
    assert!(v.read("Notes/One.md").contains("https://acme.example/corp"), "the URL is untouched");
    assert!(v.read("Notes/One.md").contains("Globex ships things."));
    assert!(v.0.join("Acme Corp.md").exists(), "replace never renames files");
}

#[test]
fn replace_in_vault_regex_and_opt_in() {
    let v = replace_vault();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "replace_in_vault", json!({"query": "/Acme (Corp)/", "replacement": "Globex ${1}", "apply": true}));
    assert!(r["replacements"].as_u64().unwrap() >= 1, "{r}");
    assert!(v.read("Notes/Two.md").starts_with("Globex Corp again"), "{}", v.read("Notes/Two.md"));

    // The opt-in reaches links, tags and property names.
    let v2 = replace_vault();
    let mut s2 = v2.server();
    let (_, r) = ok(&mut s2, "replace_in_vault", json!({"query": "Acme Corp", "replacement": "Globex", "include_links_and_tags": true, "apply": true}));
    assert_eq!(r["skipped"], 0);
    assert!(v2.read("Notes/One.md").contains("[[Globex]]"));

    assert!(fail(&mut s, "replace_in_vault", json!({"query": "  ", "replacement": "x"})).contains("empty"));
    assert!(fail(&mut s, "replace_in_vault", json!({"query": "/a(?=b)/", "replacement": "x"})).contains("invalid search query"));
}

#[test]
fn rename_tag_follows_children_and_skips_code() {
    let v = Tmp::new(&[
        ("A.md", b"---\ntags:\n  - project\n  - other\n---\nAbout #project and #project/alpha.\n\n```\n#project in code\n```\n\n%% #project in a comment %%\n"),
        ("B.md", b"---\ntag: [Project, done]\n---\nInline #Project here. Not a#project.\n"),
        (".obsidian/app.json", b"{}"),
    ]);
    let mut s = v.server();
    let (t, r) = ok(&mut s, "rename_tag", json!({"from": "#project", "to": "work", "dry_run": true}));
    assert!(t.starts_with("Preview only"), "{t}");
    assert_eq!(r["notes"], 2);
    assert!(v.read("A.md").contains("#project"), "a dry run must not write");

    let (t, r) = ok(&mut s, "rename_tag", json!({"from": "project", "to": "work"}));
    assert!(t.starts_with("Renamed #project → #work"), "{t}");
    assert_eq!(r["notes_written"], 2);
    let a = v.read("A.md");
    assert!(a.contains("About #work and #work/alpha."), "{a}");
    assert!(a.contains("  - work\n  - other"), "frontmatter list: {a}");
    assert!(a.contains("#project in code"), "code blocks are left alone: {a}");
    assert!(a.contains("%% #project in a comment %%"), "comments are left alone: {a}");
    let b = v.read("B.md");
    assert!(b.contains("tag: [work, done]"), "{b}");
    assert!(b.contains("Inline #work here."), "case-insensitive: {b}");
    assert!(b.contains("Not a#project."), "a # inside a word is not a tag: {b}");

    assert!(fail(&mut s, "rename_tag", json!({"from": "work", "to": "with space"})).contains("not a tag name"));
    assert!(fail(&mut s, "rename_tag", json!({"from": "work", "to": "123"})).contains("not a tag name"));
    assert!(fail(&mut s, "rename_tag", json!({"from": "nosuchtag", "to": "x"})).contains("no note uses"));
    assert!(fail(&mut s, "rename_tag", json!({"from": "work", "to": "work"})).contains("same"));
}

#[test]
fn rename_tag_merges_and_deduplicates() {
    let v = Tmp::new(&[
        ("A.md", b"---\ntags: [old, new]\n---\n#old and #new.\n"),
        (".obsidian/app.json", b"{}"),
    ]);
    let mut s = v.server();
    let (_, r) = ok(&mut s, "rename_tag", json!({"from": "old", "to": "new"}));
    assert_eq!(r["merges_into_existing_tag"], true);
    let a = v.read("A.md");
    assert!(a.contains("tags: [new]"), "the duplicate is dropped: {a}");
    assert!(a.contains("#new and #new."), "{a}");
}

#[test]
fn replace_protects_the_right_ranges() {
    let text = "See [[Target|shown]] and ![[pic.png]] plus #tag and https://x.example/a.\n";
    let meta = vault_ofm::parse(text);
    let lines = vault_types::LineIndex::new(text);
    let byte = |o: u32| lines.byte_of_u16(text, o);
    let ranges = super::replace::protected_ranges(&meta, text, &byte);
    let covered = |needle: &str| {
        let at = text.find(needle).unwrap();
        ranges.iter().any(|r| r.start <= at && r.end >= at + needle.len())
    };
    assert!(covered("[[Target|"), "the link target is protected");
    assert!(!covered("shown"), "the display text is prose and stays replaceable");
    assert!(covered("![[pic.png]]"));
    assert!(covered("#tag"));
    assert!(covered("https://x.example/a"));
}

// ---- render, bases, export, clip, import -----------------------------------------------

#[test]
fn render_note_formats() {
    let v = sample();
    let mut s = v.server();
    let (text, _) = ok(&mut s, "render_note", json!({"path": "Alpha"}));
    assert!(text.contains("Alpha") && text.contains("The alpha plan"), "{text}");
    assert!(!text.contains('<'), "plain text has no tags: {text}");
    let (frag, _) = ok(&mut s, "render_note", json!({"path": "Alpha", "format": "fragment"}));
    assert!(frag.contains("<h1") && frag.contains("Tasks"), "{frag}");
    let (html, _) = ok(&mut s, "render_note", json!({"path": "Alpha", "format": "html", "theme": "dark"}));
    assert!(html.starts_with("<!DOCTYPE html>") || html.starts_with("<!doctype html>"), "{}", &html[..60.min(html.len())]);
    assert!(html.contains("</html>"));
    assert!(fail(&mut s, "render_note", json!({"path": "Alpha", "format": "pdf"})).contains("format"));
    assert!(fail(&mut s, "render_note", json!({"path": "pic.png"})).contains("not a Markdown note"));
}

#[test]
fn run_base_returns_rows_and_a_table() {
    let v = Tmp::new(&[
        ("Books/One.md", b"---\nauthor: Ada\nrating: 5\nread: false\n---\n# One\n"),
        ("Books/Two.md", b"---\nauthor: Bob\nrating: 3\nread: true\n---\n# Two\n"),
        ("Other.md", b"not a book\n"),
        ("Reading list.base", b"filters:\n  and:\n    - file.inFolder(\"Books\")\nviews:\n  - type: table\n    name: All books\n    order:\n      - file.name\n      - author\n    sort:\n      - property: rating\n        direction: DESC\n  - type: table\n    name: Unread\n    order:\n      - file.name\n      - author\n    filters:\n      and:\n        - read == false\n"),
        (".obsidian/app.json", b"{}"),
    ]);
    let mut s = v.server();
    let (_, r) = ok(&mut s, "run_base", json!({"path": "Reading list.base"}));
    assert_eq!(r["view"]["name"], "All books");
    assert_eq!(r["count"], 2);
    assert_eq!(r["groups"][0]["rows"][0]["path"], "Books/One.md", "sorted by rating descending");
    let (table, r) = ok(&mut s, "run_base", json!({"path": "Reading list", "view": "Unread", "format": "markdown"}));
    assert_eq!(r["view"]["name"], "Unread");
    assert_eq!(r["count"], 1);
    assert!(table.starts_with("| "), "{table}");
    assert!(table.contains("Ada") && !table.contains("Bob"), "{table}");

    let (_, r) = ok(&mut s, "run_base", json!({"yaml": "views:\n  - type: table\n    name: All\n    order:\n      - file.name\n"}));
    assert_eq!(r["count"], 4, "an inline base sees every file");

    assert!(fail(&mut s, "run_base", json!({})).contains("Reading list.base"));
    assert!(fail(&mut s, "run_base", json!({"path": "Other.md"})).contains("not a .base file"));
    assert!(fail(&mut s, "run_base", json!({"path": "Reading list.base", "view": "Nope"})).contains("no view named"));
    assert!(fail(&mut s, "run_base", json!({"yaml": "views: [oops"})).contains("not valid"));
}

#[test]
fn export_note_and_vault_respect_confinement() {
    let v = sample();
    let mut s = v.server();
    let (t, r) = ok(&mut s, "export_note", json!({"path": "Alpha", "to": "Exports/Alpha.html"}));
    assert!(t.starts_with("Wrote "), "{t}");
    assert!(v.read("Exports/Alpha.html").contains("</html>"));
    assert_eq!(r["outside_vault"], false);
    assert!(fail(&mut s, "export_note", json!({"path": "Alpha", "to": "Exports/Alpha.html"})).contains("overwrite"));
    ok(&mut s, "export_note", json!({"path": "Alpha", "to": "Exports/Alpha.html", "overwrite": true}));

    let e = fail(&mut s, "export_note", json!({"path": "Alpha", "to": "/tmp/vault-mcp-should-not-exist.html"}));
    assert!(e.contains("outside the vault") && e.contains("outside_vault: true"), "{e}");
    assert!(!std::path::Path::new("/tmp/vault-mcp-should-not-exist.html").exists());
    assert!(fail(&mut s, "export_note", json!({"path": "Alpha", "to": "../out.html"})).contains("not allowed"));

    assert!(fail(&mut s, "export_vault", json!({"to": "Site"})).contains("inside the vault"));
    let out = std::env::temp_dir().join(format!("vault-mcp-site-{}", std::process::id()));
    let _ = fs::remove_dir_all(&out);
    let (t, r) = ok(&mut s, "export_vault", json!({"to": out.to_string_lossy(), "outside_vault": true, "dry_run": true}));
    assert!(t.starts_with("Would publish"), "{t}");
    assert!(!out.exists());
    let (t, r2) = ok(&mut s, "export_vault", json!({"to": out.to_string_lossy(), "outside_vault": true, "site_name": "Demo"}));
    assert!(t.contains("Published"), "{t}");
    assert!(r2["pages"].as_u64().unwrap() >= 3, "{r2}");
    assert!(out.join("index.html").exists());
    assert_eq!(r["notes"], r2["notes"]);
    let e = fail(&mut s, "export_vault", json!({"to": out.to_string_lossy(), "outside_vault": true}));
    assert!(e.contains("not empty"), "{e}");
    let _ = fs::remove_dir_all(&out);
}

#[test]
fn clip_html_creates_a_note_without_the_network() {
    let v = sample();
    let mut s = v.server();
    let html = "<html><head><title>A page</title><meta name=\"description\" content=\"About things\"></head><body><article><h1>A page</h1><p>Some prose about things.</p></article></body></html>";
    let (md, r) = ok(&mut s, "clip_html", json!({"html": html, "url": "https://example.com/a", "dry_run": true}));
    assert!(md.contains("Some prose about things."), "{md}");
    assert_eq!(r["dry_run"], true);
    assert!(!v.0.join("Clippings").exists());

    let (t, r) = ok(&mut s, "clip_html", json!({"html": html, "url": "https://example.com/a", "folder": "Clips", "name": "A page"}));
    assert!(t.starts_with("Clipped https://example.com/a → Clips/A page.md"), "{t}");
    assert_eq!(r["path"], "Clips/A page.md");
    let note = v.read("Clips/A page.md");
    assert!(note.starts_with("---\n") && note.contains("source: \"https://example.com/a\""), "{note}");
    // A second clip never overwrites.
    let (_, r) = ok(&mut s, "clip_html", json!({"html": html, "url": "https://example.com/a", "folder": "Clips", "name": "A page"}));
    assert_eq!(r["path"], "Clips/A page 1.md");
    assert!(fail(&mut s, "clip_html", json!({})).contains("over the network"));
    assert!(fail(&mut s, "clip_html", json!({"url": "ftp://x/y"})).contains("http"));
}

#[test]
fn import_notes_previews_then_writes() {
    let v = sample();
    let source = v.0.join("outside-export.csv");
    fs::write(&source, "title,body\nFirst,Hello there\nSecond,Another one\n").unwrap();
    let mut s = v.server();
    let args = json!({"kind": "csv", "source": [source.to_string_lossy()], "to": "Imported"});
    let (t, r) = ok(&mut s, "import_notes", args.clone());
    assert!(t.starts_with("Preview only"), "{t}");
    assert_eq!(r["applied"], false);
    assert_eq!(r["files"], 2);
    assert!(!v.0.join("Imported").exists(), "a preview must not write");

    let mut apply = args.as_object().unwrap().clone();
    apply.insert("apply".into(), json!(true));
    let (t, r) = ok(&mut s, "import_notes", Value::Object(apply.clone()));
    assert!(t.starts_with("Imported 2 file(s)"), "{t}");
    assert_eq!(r["applied"], true);
    let created: Vec<&str> = r["created"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    assert!(created.iter().all(|p| p.starts_with("Imported/")), "{created:?}");
    assert!(v.read(created[0]).contains("Hello there"), "{}", v.read(created[0]));
    // Importing again never overwrites.
    let (_, r) = ok(&mut s, "import_notes", Value::Object(apply));
    let again: Vec<&str> = r["created"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    assert!(again.iter().all(|p| !created.contains(p)), "{again:?} vs {created:?}");

    assert!(fail(&mut s, "import_notes", json!({"kind": "zim", "source": ["x"], "to": "X"})).contains("unknown import kind"));
    assert!(fail(&mut s, "import_notes", json!({"kind": "csv", "source": [], "to": "X"})).contains("at least one path"));
}

// ---- graph and canvas -------------------------------------------------------------------

#[test]
fn graph_returns_nodes_and_links() {
    let v = sample();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "graph", json!({}));
    let ids: Vec<&str> = r["graph"]["nodes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"Home.md") && ids.contains(&"Projects/Alpha.md"), "{ids:?}");
    assert!(ids.contains(&"Missing note"), "unresolved links are nodes by default");
    assert!(!ids.contains(&"pic.png"), "attachments are off by default");
    let alpha = r["graph"]["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "Projects/Alpha.md").unwrap();
    assert_eq!(alpha["kind"], "note");
    assert!(alpha["links"].as_u64().unwrap() >= 2, "{alpha}");
    assert!(r["links"].as_u64().unwrap() >= 3, "{r}");

    let (_, r) = ok(&mut s, "graph", json!({"include_attachments": true, "include_unresolved": false}));
    let ids: Vec<&str> = r["graph"]["nodes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"pic.png") && !ids.contains(&"Missing note"), "{ids:?}");

    let (_, r) = ok(&mut s, "graph", json!({"note": "Alpha", "depth": 1}));
    let ids: Vec<&str> = r["graph"]["nodes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
    assert_eq!(r["center"], "Projects/Alpha.md");
    assert!(ids.contains(&"Projects/Alpha.md") && ids.contains(&"Home.md"), "{ids:?}");
    let center = r["graph"]["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "Projects/Alpha.md").unwrap();
    assert_eq!(center["depth"], 0);

    let (_, r) = ok(&mut s, "graph", json!({"filter": "path:Projects"}));
    let ids: Vec<&str> = r["graph"]["nodes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
    assert!(!ids.contains(&"Home.md"), "{ids:?}");
    let (_, r) = ok(&mut s, "graph", json!({"limit": 1}));
    assert_eq!(r["nodes"], 1);
    assert_eq!(r["truncated"], true);
    assert!(fail(&mut s, "graph", json!({"note": "Nope"})).contains("not found"));
    assert!(fail(&mut s, "graph", json!({"depth": 9})).contains("depth"));
}

#[test]
fn graph_image_is_a_labelled_svg() {
    let v = sample();
    let mut s = v.server();
    let (svg, r) = ok(&mut s, "graph_image", json!({}));
    assert!(svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""), "{}", &svg[..60]);
    assert!(svg.trim_end().ends_with("</svg>"));
    assert_eq!(r["mimeType"], "image/svg+xml");
    // One circle per node, one line per link.
    assert_eq!(svg.matches("<circle").count(), r["nodes"].as_u64().unwrap() as usize);
    assert_eq!(svg.matches("<line").count(), r["links"].as_u64().unwrap() as usize);
    assert!(svg.contains(">Home<") && svg.contains(">Alpha<"), "nodes are labelled");
    assert!(svg.contains("node-unresolved"), "the missing note is drawn as unresolved");
    assert!(svg.contains("prefers-color-scheme"), "the picture works in dark mode");
    assert!(!svg.contains("<script"));

    // Deterministic: the same vault gives the same picture.
    let (again, _) = ok(&mut s, "graph_image", json!({}));
    assert_eq!(svg, again);

    let (local, r) = ok(&mut s, "graph_image", json!({"note": "Alpha", "labels": 0}));
    assert!(local.contains("node-center"), "the centre is marked");
    assert!(local.contains("Links around Projects/Alpha.md"));
    assert!(r["nodes"].as_u64().unwrap() >= 2);

    let (few, _) = ok(&mut s, "graph_image", json!({"limit": 2, "width": 400}));
    assert_eq!(few.matches("<circle").count(), 2);
    assert!(few.contains("width=\"400\""));
    assert!(fail(&mut s, "graph_image", json!({"filter": "path:NoSuchFolder", "include_orphans": false})).contains("no nodes"));
}

/// A canvas with one of every node type, a group and a labelled edge.
fn canvas_vault() -> Tmp {
    Tmp::new(&[
        ("Notes/Target.md", b"---\nx: 1\n---\n# Target\nFirst line of the note.\nSecond line.\n"),
        (
            "Ideas.canvas",
            br##"{"nodes":[{"id":"a1","type":"text","text":"# Ideas\nSome text","x":-300,"y":-100,"width":300,"height":140,"color":"4"},{"id":"a2","type":"file","file":"Notes/Target.md","x":100,"y":-100,"width":320,"height":220},{"id":"a3","type":"link","url":"https://jsoncanvas.org","x":-300,"y":120,"width":300,"height":100},{"id":"g1","type":"group","label":"Start","x":-340,"y":-160,"width":800,"height":420}],"edges":[{"id":"e1","fromNode":"a1","fromSide":"right","toNode":"a2","toSide":"left","label":"read"}]}"##,
        ),
        (".obsidian/app.json", b"{}"),
    ])
}

#[test]
fn canvas_read_reports_cards_and_edges() {
    let v = canvas_vault();
    let mut s = v.server();
    let (_, r) = ok(&mut s, "canvas_read", json!({"path": "Ideas"}));
    assert_eq!(r["path"], "Ideas.canvas");
    assert_eq!(r["nodes"], 4);
    assert_eq!(r["edges"], 1);
    assert_eq!(r["byType"], json!({"text": 1, "file": 1, "link": 1, "group": 1}));
    let file_card = r["canvas"]["nodes"].as_array().unwrap().iter().find(|n| n["type"] == "file").unwrap();
    assert_eq!(file_card["resolved"], "Notes/Target.md");
    assert_eq!(r["canvas"]["edges"][0]["label"], "read");
    assert_eq!(r["canvas"]["edges"][0]["fromNode"], "a1");
    assert!(fail(&mut s, "canvas_read", json!({"path": "Notes/Target.md"})).contains("not a .canvas"));
    assert!(fail(&mut s, "canvas_read", json!({"path": "Nope"})).contains("Ideas.canvas"));
}

#[test]
fn canvas_image_draws_cards_groups_and_edges() {
    let v = canvas_vault();
    let mut s = v.server();
    let (svg, r) = ok(&mut s, "canvas_image", json!({"path": "Ideas.canvas"}));
    assert!(svg.starts_with("<svg xmlns="));
    assert_eq!(r["nodes"], 4);
    assert_eq!(r["mimeType"], "image/svg+xml");
    // One rect per card, one for the group, one for the background, one behind the edge label.
    assert!(svg.contains("class=\"group\""), "the group is drawn");
    assert_eq!(svg.matches("class=\"card\"").count(), 4, "3 cards plus the edge label chip");
    assert_eq!(svg.matches("<line").count(), 1);
    assert!(svg.contains("marker-end=\"url(#a)\""), "the edge has an arrow");
    assert!(svg.contains(">read<"), "the edge label");
    assert!(svg.contains(">Start<"), "the group label");
    assert!(svg.contains(">Target<"), "the file card's title");
    assert!(svg.contains("First line of the note."), "the file card's snippet");
    assert!(svg.contains("https://jsoncanvas.org"));
    assert!(svg.contains("# Ideas") || svg.contains("Ideas"), "the text card");

    let (plain, _) = ok(&mut s, "canvas_image", json!({"path": "Ideas.canvas", "snippets": false}));
    assert!(!plain.contains("First line of the note."));
    assert!(plain.contains(">Target<"));
}

#[test]
fn canvas_edit_validates_and_round_trips() {
    let v = canvas_vault();
    let mut s = v.server();
    let (t, r) = ok(
        &mut s,
        "canvas_edit",
        json!({
            "path": "Ideas.canvas",
            "add_nodes": [{"id": "n1", "type": "text", "text": "New card", "x": 600, "y": 0, "width": 200, "height": 80}],
            "add_edges": [{"fromNode": "a2", "toNode": "n1", "label": "leads to"}],
            "update_nodes": [{"id": "a1", "x": -320, "color": null}],
            "remove_nodes": ["a3"]
        }),
    );
    assert!(t.starts_with("Updated Ideas.canvas"), "{t}");
    assert_eq!((r["nodes"].clone(), r["edges"].clone()), (json!(4), json!(2)));
    let raw = v.read("Ideas.canvas");
    assert!(raw.starts_with("{\n\t\"nodes\":[\n\t\t{"), "the app's layout is kept: {}", &raw[..40]);
    let round: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(round["nodes"].as_array().unwrap().len(), 4);
    let (_, r) = ok(&mut s, "canvas_read", json!({"path": "Ideas.canvas"}));
    let a1 = r["canvas"]["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "a1").unwrap();
    assert_eq!(a1["x"], -320);
    assert!(a1.get("color").is_none(), "null removed the colour");
    assert!(!r["canvas"]["nodes"].as_array().unwrap().iter().any(|n| n["id"] == "a3"));
    let new_edge = r["canvas"]["edges"].as_array().unwrap().iter().find(|e| e["toNode"] == "n1").unwrap();
    assert_eq!(new_edge["label"], "leads to");
    assert_eq!(new_edge["id"].as_str().unwrap().len(), 16);

    assert!(fail(&mut s, "canvas_edit", json!({"path": "Ideas.canvas", "add_nodes": [{"type": "text", "x": 0, "y": 0}]})).contains("needs `text`"));
    assert!(fail(&mut s, "canvas_edit", json!({"path": "Ideas.canvas", "add_nodes": [{"type": "sticky", "x": 0, "y": 0}]})).contains("must be text"));
    assert!(fail(&mut s, "canvas_edit", json!({"path": "Ideas.canvas", "add_nodes": [{"id": "a1", "type": "text", "text": "x"}]})).contains("already on this canvas"));
    assert!(fail(&mut s, "canvas_edit", json!({"path": "Ideas.canvas", "add_edges": [{"fromNode": "a1", "toNode": "zz"}]})).contains("not on Ideas.canvas"));
    assert!(fail(&mut s, "canvas_edit", json!({"path": "Ideas.canvas", "add_edges": [{"fromNode": "a1", "toNode": "a2", "fromSide": "up"}]})).contains("top, right"));
    assert!(fail(&mut s, "canvas_edit", json!({"path": "Ideas.canvas", "remove_nodes": ["zz"]})).contains("no card with id"));
    assert!(fail(&mut s, "canvas_edit", json!({"path": "New.canvas"})).contains("not found"));

    let (t, _) = ok(&mut s, "canvas_edit", json!({"path": "Boards/New", "create_if_missing": true, "add_nodes": [{"type": "text", "text": "Hi", "x": 0, "y": 0}]}));
    assert!(t.starts_with("Updated Boards/New.canvas"), "{t}");
    assert!(v.read("Boards/New.canvas").contains("\"Hi\""));
}

#[test]
fn canvas_parse_repairs_a_broken_file() {
    let mut seed = 1u64;
    let c = super::visual::parse_canvas(
        r#"{"nodes":[{"id":"a","type":"text"},{"id":"a","type":"text","text":"dup id"},{"type":"file","file":"X.md","width":-5,"x":"12"}],"edges":[{"fromNode":"a"},{"id":"e","fromNode":"a","toNode":"b"}],"extra":{"k":1}}"#,
        &mut seed,
    )
    .unwrap();
    assert_eq!(c.nodes.len(), 3);
    assert_ne!(c.nodes[1].id, "a", "a duplicate id is replaced");
    assert_eq!(c.nodes[0].extra.get("text"), Some(&json!("")), "a text card always has text");
    assert_eq!((c.nodes[2].width, c.nodes[2].height, c.nodes[2].x), (1.0, 60.0, 12.0));
    assert_eq!(c.edges.len(), 1, "an edge without toNode is dropped");
    assert_eq!(c.rest.get("k"), None);
    assert!(c.rest.contains_key("extra"), "unknown top-level keys are kept");
    assert!(super::visual::parse_canvas("[]", &mut seed).unwrap_err().contains("JSON object"));
    assert!(super::visual::parse_canvas("{oops", &mut seed).unwrap_err().contains("not valid JSON"));
    assert_eq!(super::visual::parse_canvas("  ", &mut seed).unwrap().nodes.len(), 0);
}

// ---- prompts ----------------------------------------------------------------------------

#[test]
fn prompts_are_listed_and_filled() {
    let v = sample();
    let mut s = v.server();
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 1, "method": "prompts/list"}));
    let names: Vec<&str> = r["result"]["prompts"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["open_questions", "note_review", "vault_tour", "weekly_summary"]);
    assert!(r["result"]["prompts"][0]["description"].as_str().unwrap().len() > 20);

    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 2, "method": "prompts/get", "params": {"name": "note_review", "arguments": {"path": "Projects/Alpha.md"}}}));
    let text = r["result"]["messages"][0]["content"]["text"].as_str().unwrap();
    assert!(text.contains("`Projects/Alpha.md`") && !text.contains("{path}"), "{text}");
    assert_eq!(r["result"]["messages"][0]["role"], "user");

    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 3, "method": "prompts/get", "params": {"name": "open_questions", "arguments": {}}}));
    assert!(!r["result"]["messages"][0]["content"]["text"].as_str().unwrap().contains("{folder"));
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 4, "method": "prompts/get", "params": {"name": "note_review", "arguments": {}}}));
    assert_eq!(r["error"]["code"], -32602);
    let r = rpc(&mut s, json!({"jsonrpc": "2.0", "id": 5, "method": "prompts/get", "params": {"name": "nope"}}));
    assert!(r["error"]["message"].as_str().unwrap().contains("Unknown prompt"));
    assert!(Server::open(&v.0, true).unwrap().handle(json!({"jsonrpc": "2.0", "id": 6, "method": "prompts/list"})).is_some());
}
