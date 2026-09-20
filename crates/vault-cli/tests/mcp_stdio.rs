//! Spawns `vault mcp <folder>` and speaks MCP over its stdin/stdout, as
//! Claude Code or Claude Desktop would.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl Session {
    fn start(vault: &PathBuf, extra: &[&str]) -> Session {
        let mut child = Command::new(env!("CARGO_BIN_EXE_vault"))
            .arg("mcp")
            .arg(vault)
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn vault mcp");
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Session { child, stdin, stdout }
    }

    fn send(&mut self, msg: Value) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{msg}").unwrap();
        stdin.flush().unwrap();
    }

    fn request(&mut self, msg: Value) -> Value {
        let id = msg["id"].clone();
        self.send(msg);
        let mut line = String::new();
        assert!(self.stdout.read_line(&mut line).unwrap() > 0, "server closed stdout");
        let v: Value = serde_json::from_str(&line).unwrap_or_else(|e| panic!("stdout is not a JSON-RPC message ({e}): {line:?}"));
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], id);
        v
    }

    fn finish(mut self) {
        drop(self.stdin.take()); // EOF: the server must exit
        let mut rest = String::new();
        std::io::Read::read_to_string(&mut self.stdout, &mut rest).unwrap();
        assert!(rest.is_empty(), "unexpected output: {rest}");
        let status = self.child.wait().unwrap();
        assert!(status.success(), "exit status {status}");
    }
}

fn temp_vault(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("vault-mcp-stdio-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join(".obsidian")).unwrap();
    fs::create_dir_all(dir.join("Projects")).unwrap();
    fs::write(dir.join("Home.md"), "# Home\nSee [[Alpha]]. #project\n").unwrap();
    fs::write(dir.join("Projects/Alpha.md"), "---\nstatus: active\ntags: [project]\n---\n# Alpha\nThe alpha plan.\n").unwrap();
    fs::write(
        dir.join("Board.canvas"),
        r#"{"nodes":[{"id":"c1","type":"text","text":"A card","x":0,"y":0,"width":200,"height":80},{"id":"c2","type":"file","file":"Projects/Alpha.md","x":300,"y":0,"width":260,"height":160}],"edges":[{"id":"e1","fromNode":"c1","toNode":"c2","label":"about"}]}"#,
    )
    .unwrap();
    fs::write(dir.join("Notes.base"), "views:\n  - type: table\n    name: All\n    order:\n      - file.name\n").unwrap();
    dir
}

/// Every tool the server offers, in `tools/list` order.
const ALL_TOOLS: &[&str] = &[
    "search", "read_note", "list_notes", "backlinks", "outgoing_links", "tags", "properties", "unlinked_mentions", "list_folders",
    "vault_stats", "list_trash", "open_in_app", "render_note", "run_base", "graph", "graph_image", "canvas_read", "canvas_image",
    "create_note", "edit_note", "append_note", "set_property", "rename_note", "move_note", "delete_note", "restore_note",
    "create_folder", "replace_in_vault", "rename_tag", "export_note", "export_vault", "clip_html", "import_notes", "canvas_edit",
    "daily_note", "periodic_note",
];

/// Tools hidden when the server runs with `--read-only`.
const WRITE_TOOLS: &[&str] = &[
    "create_note", "edit_note", "append_note", "set_property", "rename_note", "move_note", "delete_note", "restore_note",
    "create_folder", "replace_in_vault", "rename_tag", "export_note", "export_vault", "clip_html", "import_notes", "canvas_edit",
];

impl Session {
    /// `tools/call`, asserting it succeeded.
    fn call(&mut self, id: &str, name: &str, arguments: Value) -> Value {
        let r = self.request(json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": arguments } }));
        assert_eq!(r["result"]["isError"], false, "{name}: {}", r["result"]["content"][0]["text"]);
        r["result"].clone()
    }
}

#[test]
fn initialize_list_and_call_over_stdio() {
    let vault = temp_vault("legacy");
    let mut s = Session::start(&vault, &[]);

    let init = s.request(json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": { "name": "stdio-test", "version": "0" } }
    }));
    assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(init["result"]["serverInfo"]["name"], "openmarkdown-vault");
    s.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));

    let list = s.request(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names, ALL_TOOLS, "tools/list must offer every tool, in order");

    let search = s.request(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "search", "arguments": { "query": "alpha plan" } } }));
    assert_eq!(search["result"]["isError"], false);
    assert_eq!(search["result"]["structuredContent"]["results"][0]["path"], "Projects/Alpha.md");

    let create = s.request(json!({ "jsonrpc": "2.0", "id": "c", "method": "tools/call", "params": { "name": "create_note", "arguments": { "path": "Inbox/From MCP", "content": "Linked to [[Home]]" } } }));
    assert_eq!(create["result"]["isError"], false, "{create}");
    assert_eq!(fs::read_to_string(vault.join("Inbox/From MCP.md")).unwrap(), "Linked to [[Home]]");

    let backlinks = s.request(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "backlinks", "arguments": { "path": "Home" } } }));
    assert_eq!(backlinks["result"]["structuredContent"]["backlinks"][0]["source"], "Inbox/From MCP.md");

    let escape = s.request(json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "read_note", "arguments": { "path": "../../etc/hosts" } } }));
    assert_eq!(escape["result"]["isError"], true);

    let read = s.request(json!({ "jsonrpc": "2.0", "id": 6, "method": "resources/read", "params": { "uri": "vault://Projects/Alpha.md" } }));
    assert_eq!(read["result"]["contents"][0]["mimeType"], "text/markdown");

    s.finish();
    let _ = fs::remove_dir_all(&vault);
}

/// Drives a representative tool from each group the way an agent would.
#[test]
fn every_tool_group_works_over_stdio() {
    let vault = temp_vault("tools");
    let mut s = Session::start(&vault, &[]);
    s.request(json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-11-25", "capabilities": {} } }));

    // Reading the vault.
    let stats = s.call("stats", "vault_stats", json!({}));
    assert_eq!(stats["structuredContent"]["notes"], 2);
    assert!(stats["structuredContent"]["words"].as_u64().unwrap() > 5);
    let folders = s.call("folders", "list_folders", json!({}));
    assert_eq!(folders["structuredContent"]["folders"][0]["path"], "Projects");
    let rendered = s.call("render", "render_note", json!({ "path": "Alpha", "format": "text" }));
    assert!(rendered["content"][0]["text"].as_str().unwrap().contains("The alpha plan"));
    let base = s.call("base", "run_base", json!({ "path": "Notes.base", "format": "markdown" }));
    assert!(base["content"][0]["text"].as_str().unwrap().starts_with("| "));
    assert!(base["structuredContent"]["count"].as_u64().unwrap() >= 2);
    let mentions = s.call("mentions", "unlinked_mentions", json!({ "path": "Home.md" }));
    assert!(mentions["structuredContent"]["noteCount"].is_number());
    let link = s.call("url", "open_in_app", json!({ "path": "Alpha" }));
    assert!(link["structuredContent"]["web_url"].as_str().unwrap().starts_with("https://openmarkdown.ai/?uri=obsidian%3A%2F%2Fopen"));

    // Pictures.
    let graph = s.call("graph", "graph_image", json!({}));
    let svg = graph["content"][0]["text"].as_str().unwrap();
    assert!(svg.starts_with("<svg xmlns=") && svg.contains(">Alpha<"), "{}", &svg[..80]);
    assert_eq!(graph["content"][1]["type"], "image");
    assert_eq!(graph["content"][1]["mimeType"], "image/svg+xml");
    assert!(!graph["content"][1]["data"].as_str().unwrap().is_empty());
    let canvas = s.call("canvas", "canvas_read", json!({ "path": "Board.canvas" }));
    assert_eq!(canvas["structuredContent"]["nodes"], 2);
    let picture = s.call("canvaspic", "canvas_image", json!({ "path": "Board.canvas" }));
    assert!(picture["content"][0]["text"].as_str().unwrap().contains(">about<"), "the edge label is drawn");

    // Changing the vault.
    s.call("mk", "create_folder", json!({ "path": "Archive" }));
    let moved = s.call("mv", "move_note", json!({ "path": "Alpha", "to": "Archive" }));
    assert_eq!(moved["structuredContent"]["new_path"], "Archive/Alpha.md");
    assert!(vault.join("Archive/Alpha.md").is_file());
    let preview = s.call("rep1", "replace_in_vault", json!({ "query": "alpha plan", "replacement": "beta plan" }));
    assert_eq!(preview["structuredContent"]["applied"], false);
    assert!(fs::read_to_string(vault.join("Archive/Alpha.md")).unwrap().contains("alpha plan"), "a preview writes nothing");
    let applied = s.call("rep2", "replace_in_vault", json!({ "query": "alpha plan", "replacement": "beta plan", "apply": true }));
    assert_eq!(applied["structuredContent"]["replacements"], 1);
    assert!(fs::read_to_string(vault.join("Archive/Alpha.md")).unwrap().contains("beta plan"));
    let tagged = s.call("tag", "rename_tag", json!({ "from": "project", "to": "work" }));
    assert!(tagged["structuredContent"]["notes"].as_u64().unwrap() >= 1);
    assert!(fs::read_to_string(vault.join("Home.md")).unwrap().contains("#work"));

    // Canvas editing round-trips through the app's file layout.
    s.call("cedit", "canvas_edit", json!({ "path": "Board.canvas", "add_nodes": [{ "type": "text", "text": "From MCP", "x": 0, "y": 300 }] }));
    let raw = fs::read_to_string(vault.join("Board.canvas")).unwrap();
    assert!(raw.starts_with("{\n\t\"nodes\":[\n\t\t{"), "{}", &raw[..30]);
    assert!(raw.contains("From MCP"));

    // Delete and restore.
    let deleted = s.call("rm", "delete_note", json!({ "path": "Archive/Alpha.md" }));
    assert_eq!(deleted["structuredContent"]["trash_path"], ".trash/Alpha.md");
    assert!(!vault.join("Archive/Alpha.md").exists() && vault.join(".trash/Alpha.md").is_file());
    let trash = s.call("ls", "list_trash", json!({}));
    assert_eq!(trash["structuredContent"]["trash"][0]["name"], "Alpha.md");
    s.call("undo", "restore_note", json!({ "path": "Alpha.md", "to": "Archive/Alpha.md" }));
    assert!(vault.join("Archive/Alpha.md").is_file());

    // Exporting, and the confinement rule for paths outside the vault.
    s.call("html", "export_note", json!({ "path": "Archive/Alpha.md", "to": "Exports/Alpha.html" }));
    assert!(fs::read_to_string(vault.join("Exports/Alpha.html")).unwrap().contains("</html>"));
    let denied = s.request(json!({ "jsonrpc": "2.0", "id": "out", "method": "tools/call",
        "params": { "name": "export_note", "arguments": { "path": "Archive/Alpha.md", "to": "/tmp/vault-mcp-denied.html" } } }));
    assert_eq!(denied["result"]["isError"], true);
    assert!(denied["result"]["content"][0]["text"].as_str().unwrap().contains("outside_vault"));
    assert!(!std::path::Path::new("/tmp/vault-mcp-denied.html").exists());

    // Prompts.
    let prompts = s.request(json!({ "jsonrpc": "2.0", "id": "p", "method": "prompts/list" }));
    let names: Vec<&str> = prompts["result"]["prompts"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"open_questions"), "{names:?}");
    let got = s.request(json!({ "jsonrpc": "2.0", "id": "pg", "method": "prompts/get", "params": { "name": "vault_tour" } }));
    assert!(got["result"]["messages"][0]["content"]["text"].as_str().unwrap().contains("vault_stats"));

    s.finish();
    let _ = fs::remove_dir_all(&vault);
}

#[test]
fn modern_discover_and_read_only_over_stdio() {
    let vault = temp_vault("modern");
    let mut s = Session::start(&vault, &["--read-only"]);
    let meta = json!({ "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} });

    let discover = s.request(json!({ "jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": { "_meta": meta } }));
    assert_eq!(discover["result"]["resultType"], "complete");
    assert!(discover["result"]["supportedVersions"].as_array().unwrap().contains(&json!("2026-07-28")));

    let list = s.request(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": { "_meta": meta } }));
    let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for w in WRITE_TOOLS {
        assert!(!names.contains(w), "{w} must be hidden in read-only mode: {names:?}");
    }
    for r in ALL_TOOLS.iter().filter(|t| !WRITE_TOOLS.contains(t)) {
        assert!(names.contains(r), "{r} missing from the read-only list: {names:?}");
    }
    let picture = s.request(json!({ "jsonrpc": "2.0", "id": "g", "method": "tools/call", "params": { "_meta": meta, "name": "graph_image", "arguments": {} } }));
    assert_eq!(picture["result"]["content"][1]["mimeType"], "image/svg+xml");
    assert_eq!(picture["result"]["resultType"], "complete");

    let call = s.request(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "_meta": meta, "name": "properties", "arguments": { "path": "Alpha" } } }));
    assert_eq!(call["result"]["structuredContent"]["properties"]["status"], "active");

    for (id, name, args) in [
        (10, "create_note", json!({ "path": "X" })),
        (11, "delete_note", json!({ "path": "Home.md" })),
        (12, "replace_in_vault", json!({ "query": "a", "replacement": "b", "apply": true })),
        (13, "canvas_edit", json!({ "path": "Board.canvas" })),
    ] {
        let denied = s.request(json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "_meta": meta, "name": name, "arguments": args } }));
        assert_eq!(denied["error"]["code"], -32602, "{name}: {denied}");
    }
    assert!(!vault.join("X.md").exists() && vault.join("Home.md").exists());

    s.finish();
    let _ = fs::remove_dir_all(&vault);
}
