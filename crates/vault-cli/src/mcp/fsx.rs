//! File access for the MCP server: vault confinement, UTF-8 text with its
//! BOM and line endings remembered, and atomic writes.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Validates a vault-relative path from a client and normalises it to
/// `a/b/c.md`. Rejects absolute paths, `.`/`..` segments, and hidden
/// segments (so `.obsidian`, `.trash`, `.git` are unreachable).
pub fn clean_rel(input: &str) -> Result<String, String> {
    let s = input.trim().replace('\\', "/");
    if s.is_empty() {
        return Err("empty path: give a vault-relative path such as `Folder/Note.md`".into());
    }
    if s.contains('\0') {
        return Err("invalid path: contains a NUL character".into());
    }
    let b = s.as_bytes();
    let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    if s.starts_with('/') || s.starts_with('~') || drive {
        return Err(format!("absolute paths are not allowed ({input}); use a path relative to the vault root, such as `Folder/Note.md`"));
    }
    let mut parts = Vec::new();
    for seg in s.split('/') {
        match seg {
            "" => continue, // `a//b`, trailing `/`
            "." | ".." => return Err(format!("`{seg}` is not allowed in paths ({input}); paths must stay inside the vault")),
            _ if seg.starts_with('.') => {
                return Err(format!("hidden files and folders such as `{seg}` are not accessible ({input})"));
            }
            _ => parts.push(seg),
        }
    }
    if parts.is_empty() {
        return Err(format!("invalid path: {input}"));
    }
    Ok(parts.join("/"))
}

/// Joins a cleaned relative path to the (canonical) root and makes sure no
/// existing component is a symlink leading outside the vault.
pub fn confined(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let full = root.join(rel);
    let mut probe = full.as_path();
    loop {
        if probe.symlink_metadata().is_ok() {
            let canon = probe.canonicalize().map_err(|_| format!("{rel}: a symlink on this path points nowhere"))?;
            if !canon.starts_with(root) {
                return Err(format!("{rel}: path leaves the vault through a symlink; refusing"));
            }
            break;
        }
        match probe.parent() {
            Some(p) if p.starts_with(root) => probe = p,
            _ => break,
        }
    }
    Ok(full)
}

/// A text file's content with `\n` line endings and no BOM, plus what is
/// needed to write it back the same way.
#[derive(Debug, Clone, PartialEq)]
pub struct TextFile {
    pub text: String,
    pub bom: bool,
    pub crlf: bool,
}

impl TextFile {
    pub fn new(text: String) -> TextFile {
        TextFile { text, bom: false, crlf: false }
    }

    pub fn decode(bytes: &[u8], rel: &str) -> Result<TextFile, String> {
        let (bom, body) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
            Some(rest) => (true, rest),
            None => (false, bytes),
        };
        let s = std::str::from_utf8(body).map_err(|_| format!("{rel} is not valid UTF-8 text; refusing to read or modify it"))?;
        let crlf_count = s.matches("\r\n").count();
        let lf_count = s.matches('\n').count();
        let crlf = crlf_count > 0 && crlf_count * 2 >= lf_count;
        Ok(TextFile { text: s.replace("\r\n", "\n"), bom, crlf })
    }

    pub fn encode(&self) -> Vec<u8> {
        let body = if self.crlf { self.text.replace("\r\n", "\n").replace('\n', "\r\n") } else { self.text.clone() };
        let mut out = Vec::with_capacity(body.len() + 3);
        if self.bom {
            out.extend_from_slice(b"\xEF\xBB\xBF");
        }
        out.extend_from_slice(body.as_bytes());
        out
    }
}

/// Normalises client-supplied text to `\n` line endings.
pub fn lf(s: &str) -> String {
    s.replace("\r\n", "\n")
}

pub fn read_text(full: &Path, rel: &str) -> Result<TextFile, String> {
    let meta = full.metadata().map_err(|_| format!("not found: {rel}"))?;
    if !meta.is_file() {
        return Err(format!("{rel} is not a file"));
    }
    let bytes = fs::read(full).map_err(|e| format!("{rel}: {e}"))?;
    TextFile::decode(&bytes, rel)
}

static TMP: AtomicUsize = AtomicUsize::new(0);

/// Writes `data` to `full` through a temporary file in the same folder and a
/// rename, so readers never see a half-written note. Creates missing folders
/// (after `confined` has vetted the path). Keeps an existing file's
/// permissions. Refuses to replace a symlink.
pub fn write_atomic(full: &Path, rel: &str, data: &[u8]) -> Result<(), String> {
    if full.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(format!("{rel} is a symlink; refusing to replace it"));
    }
    let parent = full.parent().ok_or_else(|| format!("{rel}: no parent folder"))?;
    fs::create_dir_all(parent).map_err(|e| format!("{rel}: cannot create folder: {e}"))?;
    let name = full.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = parent.join(format!(".{name}.{}-{}.vault-mcp.tmp", std::process::id(), TMP.fetch_add(1, Ordering::SeqCst)));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        if let Ok(m) = full.metadata() {
            fs::set_permissions(&tmp, m.permissions())?;
        }
        fs::rename(&tmp, full)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{rel}: write failed: {e}"));
    }
    Ok(())
}
