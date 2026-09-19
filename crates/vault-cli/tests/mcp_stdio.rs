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
    fs::write(dir.join("Home.md"), "# Home\nSee [[Alpha]].\n").unwrap();
    fs::write(dir.join("Projects/Alpha.md"), "---\nstatus: active\n---\n# Alpha\nThe alpha plan.\n").unwrap();
    dir
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
    for expected in ["search", "read_note", "list_notes", "backlinks", "outgoing_links", "tags", "properties", "create_note", "edit_note", "append_note", "set_property", "rename_note", "daily_note"] {
        assert!(names.contains(&expected), "{expected} missing from {names:?}");
    }

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
    assert!(!names.contains(&"create_note") && !names.contains(&"rename_note"), "{names:?}");

    let call = s.request(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "_meta": meta, "name": "properties", "arguments": { "path": "Alpha" } } }));
    assert_eq!(call["result"]["structuredContent"]["properties"]["status"], "active");

    let denied = s.request(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "_meta": meta, "name": "create_note", "arguments": { "path": "X" } } }));
    assert_eq!(denied["error"]["code"], -32602);
    assert!(!vault.join("X.md").exists());

    s.finish();
    let _ = fs::remove_dir_all(&vault);
}
