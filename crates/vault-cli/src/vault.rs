//! A vault folder on disk: the file walk, `.obsidian` configuration, the
//! index, and the helpers commands share. This crate is the only one in the
//! workspace that touches the file system.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use vault_index::{FileEntry, LinkFormat, VaultIndex};

pub struct DiskFile {
    /// Vault-relative, `/`-separated.
    pub path: String,
    pub size: u64,
    pub mtime: f64,
    pub ctime: f64,
}

pub struct Vault {
    pub root: PathBuf,
    pub files: Vec<DiskFile>,
    pub index: VaultIndex,
    /// `.obsidian/app.json` (empty object when absent).
    pub app: Map<String, Value>,
}

fn ms(t: std::io::Result<SystemTime>) -> f64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<DiskFile>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = e.path();
        let Ok(meta) = e.metadata() else { continue };
        if meta.is_dir() {
            walk(root, &path, out);
        } else if meta.is_file() {
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            out.push(DiskFile { path: rel, size: meta.len(), mtime: ms(meta.modified()), ctime: ms(meta.created()) });
        }
    }
}

/// Every visible file under `root` (dot-files, dot-folders and symlinks are
/// skipped), in path order.
pub fn scan(root: &Path) -> Vec<DiskFile> {
    let mut files = Vec::new();
    walk(root, root, &mut files);
    files
}

pub fn read_json(path: &Path) -> Map<String, Value> {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// The vault root for `start`: the nearest ancestor holding `.obsidian`,
/// else `start` itself.
pub fn find_root(start: &Path) -> PathBuf {
    let start = start.canonicalize().unwrap_or_else(|_| start.to_path_buf());
    let mut dir = Some(start.as_path());
    while let Some(d) = dir {
        if d.join(".obsidian").is_dir() {
            return d.to_path_buf();
        }
        dir = d.parent();
    }
    start
}

impl Vault {
    pub fn open(root: &Path) -> Result<Vault, String> {
        if !root.is_dir() {
            return Err(format!("not a folder: {}", root.display()));
        }
        let mut files = Vec::new();
        walk(root, root, &mut files);
        let mut index = VaultIndex::new();
        for f in &files {
            index.upsert_file(FileEntry { path: f.path.clone(), size: f.size, ctime: f.ctime, mtime: f.mtime });
        }
        for f in &files {
            if f.path.to_lowercase().ends_with(".md") {
                let text = fs::read(root.join(&f.path)).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
                let meta = vault_ofm::parse(&text);
                index.set_note(&f.path, text, meta);
            }
        }
        let app = read_json(&root.join(".obsidian/app.json"));
        Ok(Vault { root: root.to_path_buf(), files, index, app })
    }

    pub fn name(&self) -> String {
        self.root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
    }

    pub fn abs(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    pub fn text(&self, path: &str) -> &str {
        self.index.note(path).map(|n| n.text.as_str()).unwrap_or("")
    }

    pub fn config_str(&self, key: &str) -> Option<String> {
        self.app.get(key).and_then(|v| v.as_str()).map(str::to_string)
    }

    pub fn config_bool(&self, key: &str) -> bool {
        self.app.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
    }

    /// `newLinkFormat`: shortest (default) | relative | absolute.
    pub fn link_format(&self) -> LinkFormat {
        match self.config_str("newLinkFormat").as_deref() {
            Some("relative") => LinkFormat::Relative,
            Some("absolute") => LinkFormat::Absolute,
            _ => LinkFormat::Shortest,
        }
    }

    /// Resolves a note argument: an exact vault path, a path without `.md`,
    /// or link text resolved the way `[[…]]` would be from the vault root.
    pub fn resolve_note(&self, arg: &str) -> Result<String, String> {
        self.resolve_file(arg).filter(|p| p.to_lowercase().ends_with(".md")).ok_or_else(|| format!("note not found: {arg}"))
    }

    pub fn resolve_file(&self, arg: &str) -> Option<String> {
        let arg = arg.trim().trim_start_matches("./").trim_start_matches('/').replace('\\', "/");
        let arg = arg.trim_start_matches("[[").trim_end_matches("]]").to_string();
        if self.index.file(&arg).is_some() {
            return Some(arg);
        }
        let with_md = format!("{arg}.md");
        if self.index.file(&with_md).is_some() {
            return Some(with_md);
        }
        // A path relative to the current directory inside the vault.
        if let Ok(cwd) = std::env::current_dir() {
            let candidate = cwd.join(&arg);
            if let Ok(rel) = candidate.canonicalize().unwrap_or(candidate).strip_prefix(self.root.canonicalize().unwrap_or(self.root.clone())) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if self.index.file(&rel).is_some() {
                    return Some(rel);
                }
            }
        }
        self.index.resolve_link(&arg, "")
    }

    /// Bytes of a vault file.
    pub fn read_bytes(&self, rel: &str) -> Option<Vec<u8>> {
        fs::read(self.abs(rel)).ok()
    }

    pub fn is_note(path: &str) -> bool {
        path.to_lowercase().ends_with(".md")
    }

    /// Writes a vault file, creating folders.
    pub fn write(&self, rel: &str, data: &[u8]) -> Result<(), String> {
        let p = self.abs(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::write(&p, data).map_err(|e| format!("{}: {e}", p.display()))
    }

    /// The Bases record of every file (links resolved to paths, backlinks
    /// from the resolved link table), as the app's Bases plugin builds them.
    pub fn file_records(&self) -> Vec<vault_bases::FileRecord> {
        let resolved = self.index.resolved_links();
        let mut backlinks: std::collections::HashMap<&str, Vec<String>> = std::collections::HashMap::new();
        for (source, dests) in &resolved {
            for dest in dests.keys() {
                backlinks.entry(dest.as_str()).or_default().push(source.clone());
            }
        }
        let resolve = |link: &str, source: &str| -> String {
            let linkpath = link.split('#').next().unwrap_or("").split('|').next().unwrap_or("");
            if linkpath.is_empty() {
                return source.to_string();
            }
            self.index.resolve_link(linkpath, source).unwrap_or_else(|| linkpath.to_string())
        };
        self.files
            .iter()
            .map(|f| {
                let mut r = vault_bases::FileRecord::new(f.path.clone());
                r.size = f.size as f64;
                r.ctime = f.ctime;
                r.mtime = f.mtime;
                if let Some(note) = self.index.note(&f.path) {
                    let meta = &note.meta;
                    r.properties = meta.frontmatter.clone().unwrap_or_default();
                    r.tags = vault_index::tags::all_tags(meta);
                    let mut links: Vec<String> = Vec::new();
                    for l in meta.links.iter().flatten() {
                        links.push(resolve(&l.link, &f.path));
                    }
                    for l in meta.frontmatter_links.iter().flatten() {
                        links.push(resolve(&l.link, &f.path));
                    }
                    links.dedup();
                    r.links = links;
                    r.embeds = meta.embeds.iter().flatten().map(|e| resolve(&e.link, &f.path)).collect();
                }
                r.backlinks = backlinks.get(f.path.as_str()).cloned().unwrap_or_default();
                r
            })
            .collect()
    }
}

pub fn now_ms() -> f64 {
    ms(Ok(SystemTime::now()))
}

/// The local UTC offset in minutes, from `date +%z` (std has no time zone
/// database); 0 when that is unavailable.
pub fn local_offset_minutes() -> i32 {
    if let Ok(v) = std::env::var("VAULT_TZ_OFFSET_MINUTES") {
        if let Ok(n) = v.trim().parse() {
            return n;
        }
    }
    let Ok(out) = std::process::Command::new("date").arg("+%z").output() else { return 0 };
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.len() != 5 {
        return 0;
    }
    let sign = if s.starts_with('-') { -1 } else { 1 };
    let h: i32 = s[1..3].parse().unwrap_or(0);
    let m: i32 = s[3..5].parse().unwrap_or(0);
    sign * (h * 60 + m)
}
