//! `vault`: a native command line over a vault folder, built on the same
//! crates as the browser app. See `vault help` and docs/ARCHITECTURE.md.
//!
//! Arguments are parsed by hand (no clap) to keep the binary small:
//! `--flag value`, `--flag=value`, `-o value`, and boolean `--flag`s, in any
//! order around the positional arguments. `--vault <dir>` picks the vault;
//! otherwise it is the nearest folder above the current directory holding
//! `.obsidian`, or the current directory.

mod commands;
mod mcp;
mod vault;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::io::Write;

pub const USAGE: &str = "vault — work with a Markdown vault from the command line

USAGE
  vault [--vault <dir>] <command> [args] [flags]

COMMANDS
  info                              counts, tags, broken links
  search <query> [--json] [--case-sensitive] [--limit N]
                                    Obsidian search syntax (path: tag: line:() …)
  backlinks <note> [--json]         notes linking to <note>, with context
  links <note> [--json]             outgoing links of <note>
  unresolved [--json]               links whose target does not exist
  tags [--json] [--sort name|count] tags with counts
  graph [--json]                    link graph (nodes + links)
  render <note> [--html|--json]     reading-view text, HTML fragment or sections
  export-html <note> [-o out.html]  one note as a standalone HTML document
  publish -o <dir> [--home Note] [--name \"Site\"] [--base-url URL]
          [--include a,b] [--exclude c] [--options site-options.json]
                                    static website (navigation, search, graph …)
  base <file.base> [--view N|name] [--json|--table]
                                    run a Bases view
  clip <url|file.html> [--template t.json] [-o folder] [--url URL] [--dry-run]
                                    web page → note (URLs are fetched with curl)
  import <kind> <paths...> -o <folder> [--options o.json]
                                    enex | html | notion | roam | keep | bear |
                                    logseq | csv | textbundle
  convert-format [--all] [--markdown-links] [--roam] [--bear] [--zettelkasten[=pretty]]
                 [--properties] [--dry-run]
                                    Format converter over every note
  rename <old> <new> [--dry-run]    rename a file or folder, updating links
  daily [--date YYYY-MM-DD] [--no-create]
                                    today's daily note (created from settings)
  new <name> [--template path] [--folder f]
                                    create a note (newFileLocation, templates)
  mcp [<vault-folder>] [--read-only]
                                    Model Context Protocol server over stdio:
                                    36 tools (20 read-only) covering search,
                                    links, editing, trash, bases, canvases,
                                    the graph, publishing and importing
                                    (for Claude Code, Claude Desktop …; docs/mcp.md)
  help                              this text
";

/// Parsed command line: positionals and `--flags`.
#[derive(Debug, Default, Clone)]
pub struct Args {
    pub positional: Vec<String>,
    pub flags: HashMap<String, String>,
}

/// Flags that take a value (everything else is boolean).
const VALUE_FLAGS: &[&str] =
    &["vault", "limit", "o", "output", "home", "name", "template", "view", "date", "base-url", "include", "exclude", "options", "url", "folder", "sort"];

impl Args {
    pub fn parse<I: IntoIterator<Item = String>>(iter: I) -> Result<Args, String> {
        let mut args = Args::default();
        let mut it = iter.into_iter().peekable();
        let mut only_positional = false;
        while let Some(a) = it.next() {
            if only_positional {
                args.positional.push(a);
                continue;
            }
            if a == "--" {
                only_positional = true;
                continue;
            }
            let name = if let Some(n) = a.strip_prefix("--") {
                n.to_string()
            } else if a.len() == 2 && a.starts_with('-') && a != "-" {
                a[1..].to_string()
            } else {
                args.positional.push(a);
                continue;
            };
            if let Some((k, v)) = name.split_once('=') {
                args.flags.insert(k.to_string(), v.to_string());
            } else if VALUE_FLAGS.contains(&name.as_str()) {
                let v = it.next().ok_or_else(|| format!("--{name} needs a value"))?;
                args.flags.insert(name, v);
            } else {
                args.flags.insert(name, String::new());
            }
        }
        if let Some(v) = args.flags.remove("output") {
            args.flags.insert("o".into(), v);
        }
        Ok(args)
    }

    pub fn has(&self, flag: &str) -> bool {
        self.flags.contains_key(flag)
    }

    pub fn get(&self, flag: &str) -> Option<&str> {
        self.flags.get(flag).map(|s| s.as_str())
    }

    pub fn list(&self, flag: &str) -> Vec<String> {
        self.get(flag).map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
    }

    pub fn pos(&self, i: usize, what: &str) -> Result<&str, String> {
        self.positional.get(i).map(|s| s.as_str()).ok_or_else(|| format!("missing {what} (see `vault help`)"))
    }
}

/// Runs a command line (without the program name); output goes to `out`.
/// Returns the process exit code.
pub fn run(argv: Vec<String>, out: &mut dyn Write) -> Result<i32, String> {
    let args = Args::parse(argv)?;
    commands::dispatch(&args, out)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    match run(argv, &mut lock) {
        Ok(code) => {
            let _ = lock.flush();
            std::process::exit(code);
        }
        Err(e) if e.contains("Broken pipe") => std::process::exit(0),
        Err(e) => {
            let _ = lock.flush();
            eprintln!("vault: {e}");
            std::process::exit(1);
        }
    }
}
