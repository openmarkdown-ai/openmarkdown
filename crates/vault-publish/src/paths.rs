//! Output paths and hrefs.
//!
//! # URL scheme
//!
//! A note's page lives at its vault path with every segment *slugged* and
//! `.md` replaced by `.html`: `Getting started/Link notes.md` →
//! `Getting-started/Link-notes.html`. Slugging turns runs of whitespace and
//! `+` into one `-`, drops characters that are unsafe or reserved in URLs
//! and file names (`? # % & = " ' < > \ | * : ^ [ ] { } ;` and controls) and
//! keeps letters and digits of any script, case included. Two notes whose
//! slugs collide (case-insensitively, for macOS and Windows file systems)
//! get `-2`, `-3` … in path order. A `permalink` property replaces the path
//! (`permalink: about` → `about.html`, `permalink: /` → the home page).
//!
//! Attachments keep their vault path. Every href is relative to the page it
//! is written into and percent-encoded per segment, so the site works from
//! any sub-path and from a plain static file server.

pub fn slug_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_dash = false;
    for c in s.chars() {
        if c.is_whitespace() || c == '+' || c == '-' {
            pending_dash = true;
            continue;
        }
        if c.is_control() || "?#%&=\"'<>\\|*:^[]{};/`$".contains(c) {
            continue;
        }
        if pending_dash && !out.is_empty() {
            out.push('-');
        }
        pending_dash = false;
        out.push(c);
    }
    let out = out.trim_start_matches('.').to_string();
    if out.is_empty() {
        "untitled".into()
    } else {
        out
    }
}

/// The default page path of a note (before collision handling and
/// permalinks): see the module documentation.
pub fn page_path(note_path: &str) -> String {
    let stem = strip_md(note_path);
    let segs: Vec<String> = stem.split('/').filter(|s| !s.is_empty()).map(slug_segment).collect();
    format!("{}.html", segs.join("/"))
}

pub fn strip_md(path: &str) -> &str {
    if path.len() >= 3 && path[path.len() - 3..].eq_ignore_ascii_case(".md") {
        &path[..path.len() - 3]
    } else {
        path
    }
}

pub fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

/// File name without `.md` (a note's title).
pub fn note_title(path: &str) -> String {
    strip_md(basename(path)).to_string()
}

pub fn extension(path: &str) -> String {
    let name = basename(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

pub fn is_note(path: &str) -> bool {
    extension(path) == "md"
}

/// Percent-encodes one path segment: everything but unreserved ASCII and a
/// few sub-delimiters that need no encoding in a path.
pub fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~!()*,@".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn encode_path(path: &str) -> String {
    path.split('/').map(encode_segment).collect::<Vec<_>>().join("/")
}

/// Href from the page at `from` to the file at `to` (both site-root
/// relative, `/`-separated), percent-encoded.
pub fn rel_href(from: &str, to: &str) -> String {
    let from_dir: Vec<&str> = from.split('/').collect::<Vec<_>>();
    let from_dir = &from_dir[..from_dir.len() - 1];
    let to_segs: Vec<&str> = to.split('/').collect();
    let mut i = 0;
    while i < from_dir.len() && i + 1 < to_segs.len() && from_dir[i] == to_segs[i] {
        i += 1;
    }
    let mut parts: Vec<String> = Vec::new();
    for _ in i..from_dir.len() {
        parts.push("..".into());
    }
    for s in &to_segs[i..] {
        parts.push(encode_segment(s));
    }
    parts.join("/")
}

/// `../` repeated for the depth of `page` (empty at the root).
pub fn root_prefix(page: &str) -> String {
    "../".repeat(page.matches('/').count())
}

pub fn mime(path: &str) -> &'static str {
    match extension(path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "ogg" => "audio/ogg",
        "3gp" => "audio/3gpp",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "pdf" => "application/pdf",
        "css" => "text/css",
        "js" => "text/javascript",
        _ => "application/octet-stream",
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MediaKind {
    Image,
    Audio,
    Video,
    Pdf,
    Other,
}

pub fn media_kind(path: &str) -> MediaKind {
    match extension(path).as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "svg" | "webp" | "avif" | "ico" => MediaKind::Image,
        "mp3" | "wav" | "m4a" | "ogg" | "3gp" | "flac" => MediaKind::Audio,
        "mp4" | "webm" | "ogv" | "mov" | "mkv" => MediaKind::Video,
        "pdf" => MediaKind::Pdf,
        _ => MediaKind::Other,
    }
}

/// Fragment id for a heading: `stripHeading`'s normalisation with spaces as
/// `-`. Link subpaths go through the same function, so `[[Note#A: b]]`
/// lands on `## A: b`.
pub fn heading_id(heading: &str) -> String {
    let s = vault_ofm::strip_heading(heading);
    let id: String = s.chars().map(|c| if c.is_whitespace() { '-' } else { c }).collect();
    if id.is_empty() {
        "section".into()
    } else {
        id
    }
}

/// Tag page path: `#Project/Alpha` → `tags/project/alpha.html`.
pub fn tag_page(tag: &str) -> String {
    let t = tag.trim_start_matches('#').to_lowercase();
    let segs: Vec<String> = t.split('/').filter(|s| !s.is_empty()).map(slug_segment).collect();
    format!("tags/{}.html", segs.join("/"))
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DD` (UTC) for a millisecond timestamp.
pub fn iso_date(ms: f64) -> String {
    let (y, m, d) = civil_from_days((ms / 86_400_000.0).floor() as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// RFC 822 date (UTC) for RSS.
pub fn rfc822(ms: f64) -> String {
    let days = (ms / 86_400_000.0).floor() as i64;
    let (y, m, d) = civil_from_days(days);
    let secs = ((ms / 1000.0).floor() as i64).rem_euclid(86_400);
    let wd = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][days.rem_euclid(7) as usize];
    let mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m - 1) as usize];
    format!("{wd}, {d:02} {mon} {y:04} {:02}:{:02}:{:02} GMT", secs / 3600, secs / 60 % 60, secs % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_and_hrefs() {
        assert_eq!(page_path("Getting started/Link notes.md"), "Getting-started/Link-notes.html");
        assert_eq!(page_path("a/What's new? (2024).md"), "a/Whats-new-(2024).html");
        assert_eq!(page_path("日本語 ノート.md"), "日本語-ノート.html");
        assert_eq!(slug_segment("  "), "untitled");
        assert_eq!(rel_href("a/b/c.html", "a/d.html"), "../d.html");
        assert_eq!(rel_href("index.html", "Folder/Note-A.html"), "Folder/Note-A.html");
        assert_eq!(rel_href("x/y.html", "x/y.html"), "y.html");
        assert_eq!(rel_href("x/y.html", "Attachments/my pic.png"), "../Attachments/my%20pic.png");
        assert_eq!(root_prefix("a/b/c.html"), "../../");
        assert_eq!(tag_page("#Project/Alpha"), "tags/project/alpha.html");
    }

    #[test]
    fn dates() {
        assert_eq!(iso_date(0.0), "1970-01-01");
        assert_eq!(iso_date(1_700_000_000_000.0), "2023-11-14");
        assert_eq!(rfc822(1_700_000_000_000.0), "Tue, 14 Nov 2023 22:13:20 GMT");
    }
}
