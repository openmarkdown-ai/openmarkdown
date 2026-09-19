//! Helpers every importer shares: name sanitisation, collision-free paths,
//! base64, MD5, text decoding, percent-encoding, path arithmetic, file-type
//! sniffing and the placeholder tokens that carry links through HTML
//! conversion.

use std::collections::HashSet;

// ---------------------------------------------------------------------------
// Names

/// Characters Obsidian rejects in tags (as `ILLEGAL_TAG_CHARS` in the
/// importer): two punctuation blocks plus ASCII punctuation except `-_/`.
pub fn is_illegal_tag_char(c: char) -> bool {
    matches!(c as u32, 0x2000..=0x206F | 0x2E00..=0x2E7F)
        || "'!\"#$%&()*+,.:;<=>?@^`{|}~[]\\".contains(c)
}

/// `sanitizeTag`: drop a leading `#` and replace illegal characters.
pub fn sanitize_tag(name: &str, replacement: &str) -> String {
    let name = name.strip_prefix('#').unwrap_or(name);
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if is_illegal_tag_char(c) {
            out.push_str(replacement);
        } else {
            out.push(c);
        }
    }
    out
}

const MAX_NAME_BYTES: usize = 240;

fn strip_control(s: &str) -> String {
    s.chars()
        .filter(|c| {
            let v = *c as u32;
            !(v <= 0x1f || (0x80..=0x9f).contains(&v))
        })
        .collect()
}

fn is_windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit())
}

fn tidy_name(name: &str) -> String {
    let mut s = name.to_string();
    if !s.is_empty() && s.chars().all(|c| c == '.') {
        s.clear();
    }
    let trimmed = s.trim_end_matches(['.', ' ']).len();
    s.truncate(trimmed);
    if is_windows_reserved(&s) {
        s.clear();
    }
    s.retain(|c| !matches!(c, '[' | ']' | '#' | '|' | '^'));
    let lead = s.len() - s.trim_start_matches(|c: char| c == '.' || c.is_whitespace()).len();
    s.drain(..lead);
    s
}

/// `sanitizeFileName` from obsidian-importer: slashes become dashes, the
/// characters Windows and Obsidian links reject are removed, control characters
/// are dropped, reserved and dot-only names are emptied, and the result is
/// limited to 240 UTF-8 bytes. An empty result is `Untitled`.
///
/// Not done: Unicode NFC normalisation (it would need a normalisation table in
/// the wasm build).
pub fn sanitize_file_name(name: &str) -> String {
    let replaced: String = name
        .chars()
        .filter_map(|c| match c {
            '/' | '\\' => Some('-'),
            '?' | '<' | '>' | ':' | '*' | '|' | '"' => None,
            c => Some(c),
        })
        .collect();
    let cleaned = tidy_name(&strip_control(&replaced));
    let limited = limit_name_length(&cleaned);
    let sanitized = if limited == cleaned {
        cleaned
    } else {
        tidy_name(&limited)
    };
    let trimmed = sanitized.trim();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

fn limit_name_length(name: &str) -> String {
    if name.len() <= MAX_NAME_BYTES {
        return name.to_string();
    }
    let mut out = String::new();
    for c in name.chars() {
        if out.len() + c.len_utf8() > MAX_NAME_BYTES {
            break;
        }
        out.push(c);
    }
    if let Some(space) = out.rfind(' ') {
        if space > out.len() / 2 {
            out.truncate(space);
        }
    }
    out
}

/// `sanitizeFilePath`: sanitise each segment, dropping empty ones.
pub fn sanitize_file_path(path: &str) -> String {
    path.split('/')
        .filter(|s| !s.trim().is_empty())
        .map(sanitize_file_name)
        .collect::<Vec<_>>()
        .join("/")
}

/// The name a wikilink uses: the file name, without `.md` for notes.
pub fn link_name(path: &str) -> &str {
    let name = basename(path);
    name.strip_suffix(".md").unwrap_or(name)
}

// ---------------------------------------------------------------------------
// Paths

pub fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Parent folder, or `""` at the root.
pub fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    }
}

/// `(stem, extension)` split at the last dot; a leading dot is not an
/// extension separator. The extension is returned without its dot.
pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

pub fn extension_lower(path: &str) -> String {
    split_ext(basename(path)).1.to_ascii_lowercase()
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else if name.is_empty() {
        dir.to_string()
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// Resolve `rel` against a folder, collapsing `.` and `..` (never above the
/// root). Backslashes count as separators.
pub fn resolve_path(dir: &str, rel: &str) -> String {
    let rel = rel.replace('\\', "/");
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        Vec::new()
    } else {
        dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// A relative path from the folder of `from_file` to `to_file`.
pub fn relative_path(from_file: &str, to_file: &str) -> String {
    let from: Vec<&str> = parent(from_file).split('/').filter(|s| !s.is_empty()).collect();
    let to: Vec<&str> = to_file.split('/').filter(|s| !s.is_empty()).collect();
    let mut common = 0;
    while common < from.len() && common + 1 < to.len() && from[common] == to[common] {
        common += 1;
    }
    let mut out: Vec<&str> = Vec::new();
    out.resize(from.len() - common, "..");
    out.extend_from_slice(&to[common..]);
    out.join("/")
}

/// Case-insensitive claims on paths, handing out `Name 1.ext`, `Name 2.ext`…
/// on collision (`availableFileName` in the importer).
#[derive(Debug, Default, Clone)]
pub struct UniquePaths {
    taken: HashSet<String>,
}

impl UniquePaths {
    pub fn new() -> UniquePaths {
        UniquePaths::default()
    }

    pub fn is_taken(&self, path: &str) -> bool {
        self.taken.contains(&path.to_lowercase())
    }

    pub fn reserve(&mut self, path: &str) {
        self.taken.insert(path.to_lowercase());
    }

    /// Claim `dir/file_name`, or the first free numbered variant of it.
    pub fn claim(&mut self, dir: &str, file_name: &str) -> String {
        let (stem, ext) = split_ext(file_name);
        let mut i = 0;
        loop {
            let candidate = if i == 0 {
                file_name.to_string()
            } else if ext.is_empty() {
                format!("{stem} {i}")
            } else {
                format!("{stem} {i}.{ext}")
            };
            let full = join(dir, &candidate);
            if !self.is_taken(&full) {
                self.reserve(&full);
                return full;
            }
            i += 1;
        }
    }
}

// ---------------------------------------------------------------------------
// Encodings

/// Lenient base64: standard and URL-safe alphabets, whitespace and padding
/// ignored, trailing partial groups decoded as far as they go.
pub fn base64_decode(input: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for b in input.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// RFC 1321 MD5 as lowercase hex: how ENEX `<en-media hash>` names a resource.
pub fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let k: Vec<u32> = (0..64)
        .map(|i| ((i as f64 + 1.0).sin().abs() * 4_294_967_296.0) as u32)
        .collect();
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());
    let (mut a0, mut b0, mut c0, mut d0) =
        (0x6745_2301u32, 0xefcd_ab89u32, 0x98ba_dcfeu32, 0x1032_5476u32);
    for chunk in msg.chunks(64) {
        let m: Vec<u32> = chunk
            .chunks(4)
            .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
            .collect();
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | (!b & d), i),
                16..=31 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let f = f.wrapping_add(a).wrapping_add(k[i]).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f.rotate_left(S[i]));
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    [a0, b0, c0, d0]
        .iter()
        .flat_map(|w| w.to_le_bytes())
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Bytes to text the way the importer's `decodeText` does for the encodings a
/// browser-free build can decode: a UTF-8 or UTF-16 byte-order mark wins;
/// otherwise UTF-8, and bytes that are not valid UTF-8 are read as
/// Windows-1252 (which is what a declared Latin-1 page almost always is).
pub fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        let le = bytes[0] == 0xFF;
        let units: Vec<u16> = bytes[2..]
            .chunks(2)
            .filter(|c| c.len() == 2)
            .map(|c| {
                if le {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect();
        return String::from_utf16_lossy(&units);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => bytes.iter().map(|&b| windows_1252(b)).collect(),
    }
}

fn windows_1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž',
        '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}',
        'ž', 'Ÿ',
    ];
    match b {
        0x80..=0x9F => HIGH[(b - 0x80) as usize],
        _ => b as char,
    }
}

/// `decodeURIComponent` that leaves malformed or non-UTF-8 escapes as written.
pub fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    match String::from_utf8(out) {
        Ok(s) => s,
        Err(_) => s.to_string(),
    }
}

/// `encodeURI`: escape everything but the URI reserved and unreserved sets.
pub fn encode_uri(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || ";,/?:@&=+$-_.!~*'()#".contains(c) {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

/// Escape only what breaks a Markdown link destination: spaces, parentheses,
/// angle brackets and `%` itself. Readable in source, and what Obsidian writes.
pub fn encode_link_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '%' => out.push_str("%25"),
            c => out.push(c),
        }
    }
    out
}

/// True for a URL with a scheme (`https:`, `data:`, `mailto:`) or `//host`.
pub fn has_scheme(url: &str) -> bool {
    if url.starts_with("//") {
        return true;
    }
    let mut chars = url.char_indices();
    match chars.next() {
        Some((_, c)) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for (i, c) in chars {
        if c == ':' {
            // A single letter before the colon is a Windows drive, not a scheme.
            return i > 1;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
            return false;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// File types

/// Extension for a MIME type, the common ones an export carries.
pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    let mime = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    Some(match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" | "image/pjpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/tiff" => "tiff",
        "image/heic" => "heic",
        "image/avif" => "avif",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "application/pdf" => "pdf",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a",
        "audio/amr" => "amr",
        "audio/aac" => "aac",
        "audio/webm" => "webm",
        "audio/3gpp" => "3gp",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "text/plain" => "txt",
        "text/html" => "html",
        "text/markdown" => "md",
        "text/csv" => "csv",
        "application/json" => "json",
        "application/zip" => "zip",
        "application/msword" => "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        _ => return None,
    })
}

/// Extension from magic bytes (`extensionFromBytes` in the importer).
pub fn extension_from_bytes(b: &[u8]) -> Option<&'static str> {
    let at = |o: usize, sig: &[u8]| b.get(o..o + sig.len()) == Some(sig);
    if at(0, &[0x89, b'P', b'N', b'G']) {
        return Some("png");
    }
    if at(0, &[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if at(0, b"GIF8") {
        return Some("gif");
    }
    if at(0, b"%PDF") {
        return Some("pdf");
    }
    if at(0, b"RIFF") && at(8, b"WEBP") {
        return Some("webp");
    }
    if at(0, b"RIFF") && at(8, b"WAVE") {
        return Some("wav");
    }
    if at(0, b"ID3") {
        return Some("mp3");
    }
    if at(4, b"ftyp") {
        return Some("mp4");
    }
    if at(0, b"PK\x03\x04") {
        return Some("zip");
    }
    None
}

/// Pixel dimensions of a PNG, GIF, JPEG or WebP, read from its header.
pub fn image_dimensions(b: &[u8]) -> Option<(u32, u32)> {
    let be16 = |o: usize| b.get(o..o + 2).map(|s| u16::from_be_bytes([s[0], s[1]]) as u32);
    let be32 = |o: usize| {
        b.get(o..o + 4)
            .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
    };
    let le16 = |o: usize| b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as u32);
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some((be32(16)?, be32(20)?));
    }
    if b.starts_with(b"GIF8") {
        return Some((le16(6)?, le16(8)?));
    }
    if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        let kind = b.get(12..16)?;
        return match kind {
            b"VP8 " => Some((le16(26)? & 0x3FFF, le16(28)? & 0x3FFF)),
            b"VP8L" => {
                let v = u32::from_le_bytes([*b.get(21)?, *b.get(22)?, *b.get(23)?, *b.get(24)?]);
                Some(((v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1))
            }
            b"VP8X" => {
                let w = u32::from_le_bytes([*b.get(24)?, *b.get(25)?, *b.get(26)?, 0]) + 1;
                let h = u32::from_le_bytes([*b.get(27)?, *b.get(28)?, *b.get(29)?, 0]) + 1;
                Some((w, h))
            }
            _ => None,
        };
    }
    if b.starts_with(&[0xFF, 0xD8]) {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = b[i + 1];
            if marker == 0xFF {
                i += 1;
                continue;
            }
            let len = be16(i + 2)? as usize;
            if matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
                return Some((be16(i + 7)?, be16(i + 5)?));
            }
            i += 2 + len;
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Placeholder tokens

/// Placeholders that survive HTML-to-Markdown conversion unchanged.
///
/// A converter escapes Markdown it did not write — `[[Note]]` placed in HTML
/// text comes out as `\[\[Note\]\]` — so anything that must reach the note
/// verbatim (wikilinks, embeds, code fences an importer assembles itself) is
/// put into the HTML as a token of letters and digits and swapped back in the
/// Markdown afterwards.
#[derive(Debug, Default, Clone)]
pub struct Tokens {
    values: Vec<String>,
}

const TOKEN_PREFIX: &str = "ZQIMP";
const TOKEN_SUFFIX: &str = "QZ";

impl Tokens {
    pub fn new() -> Tokens {
        Tokens::default()
    }

    pub fn add(&mut self, value: impl Into<String>) -> String {
        self.values.push(value.into());
        format!("{TOKEN_PREFIX}{}{TOKEN_SUFFIX}", self.values.len() - 1)
    }

    pub fn set(&mut self, token: &str, value: impl Into<String>) {
        if let Some(i) = Self::index(token) {
            if let Some(slot) = self.values.get_mut(i) {
                *slot = value.into();
            }
        }
    }

    fn index(token: &str) -> Option<usize> {
        token
            .strip_prefix(TOKEN_PREFIX)?
            .strip_suffix(TOKEN_SUFFIX)?
            .parse()
            .ok()
    }

    pub fn get(&self, token: &str) -> Option<&str> {
        self.values.get(Self::index(token)?).map(|s| s.as_str())
    }

    /// Replace every token in `text`; `f` may rewrite each value in context.
    ///
    /// A value of several lines is continued with the prefix of the line the
    /// token sits on — its blockquote markers and list indentation — so a
    /// code block or display equation placed inside a quote or a list item
    /// stays inside it.
    pub fn replace_with(&self, text: &str, mut f: impl FnMut(usize, &str) -> String) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = rest.find(TOKEN_PREFIX) {
            out.push_str(&rest[..at]);
            let after = &rest[at + TOKEN_PREFIX.len()..];
            let digits = after.bytes().take_while(|b| b.is_ascii_digit()).count();
            if digits > 0 && after[digits..].starts_with(TOKEN_SUFFIX) {
                let idx: usize = after[..digits].parse().unwrap_or(usize::MAX);
                if let Some(v) = self.values.get(idx) {
                    let value = f(idx, v);
                    if value.contains('\n') {
                        let line_start = out.rfind('\n').map(|i| i + 1).unwrap_or(0);
                        let prefix = container_prefix(&out[line_start..]);
                        let mut first = true;
                        for line in value.split('\n') {
                            if !first {
                                out.push('\n');
                                if line.is_empty() {
                                    // `>` markers stay on a blank line; indentation does not.
                                    out.push_str(prefix.trim_end());
                                } else {
                                    out.push_str(&prefix);
                                }
                            }
                            out.push_str(line);
                            first = false;
                        }
                    } else {
                        out.push_str(&value);
                    }
                    rest = &after[digits + TOKEN_SUFFIX.len()..];
                    continue;
                }
            }
            out.push_str(TOKEN_PREFIX);
            rest = after;
        }
        out.push_str(rest);
        out
    }

    pub fn replace(&self, text: &str) -> String {
        self.replace_with(text, |_, v| v.to_string())
    }
}

/// The prefix a continuation line needs to stay in the same Markdown
/// container as `line`: its indentation and `>` markers, with a list marker
/// turned into the equivalent spaces.
pub fn container_prefix(line: &str) -> String {
    let mut prefix = String::new();
    let mut rest = line;
    loop {
        let ws = rest.len() - rest.trim_start_matches([' ', '\t']).len();
        if ws > 0 {
            prefix.push_str(&rest[..ws]);
            rest = &rest[ws..];
            continue;
        }
        if let Some(r) = rest.strip_prefix('>') {
            prefix.push('>');
            rest = r;
            continue;
        }
        let bullet = ["- ", "* ", "+ "].iter().find(|b| rest.starts_with(**b));
        if let Some(b) = bullet {
            prefix.push_str(&" ".repeat(b.len()));
            rest = &rest[b.len()..];
            continue;
        }
        let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digits > 0 && (rest[digits..].starts_with(". ") || rest[digits..].starts_with(") ")) {
            prefix.push_str(&" ".repeat(digits + 2));
            rest = &rest[digits + 2..];
            continue;
        }
        break;
    }
    prefix
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_file_name_matches_importer_rules() {
        assert_eq!(sanitize_file_name("a/b\\c"), "a-b-c");
        assert_eq!(sanitize_file_name("What? <yes>: *no* |\"q\""), "What yes no q");
        assert_eq!(sanitize_file_name("[[link]] #tag ^block"), "link tag block");
        assert_eq!(sanitize_file_name("..."), "Untitled");
        assert_eq!(sanitize_file_name("  .hidden"), "hidden");
        assert_eq!(sanitize_file_name("trailing. "), "trailing");
        assert_eq!(sanitize_file_name("CON"), "Untitled");
        assert_eq!(sanitize_file_name("con.txt"), "Untitled");
        assert_eq!(sanitize_file_name("console"), "console");
        assert_eq!(sanitize_file_name("tab\there"), "tabhere");
        assert_eq!(sanitize_file_name(""), "Untitled");
        let long = "word ".repeat(100);
        let s = sanitize_file_name(&long);
        assert!(s.len() <= 240 && !s.ends_with(' '));
    }

    #[test]
    fn unique_paths_number_collisions_case_insensitively() {
        let mut u = UniquePaths::new();
        assert_eq!(u.claim("dir", "Note.md"), "dir/Note.md");
        assert_eq!(u.claim("dir", "note.md"), "dir/note 1.md");
        assert_eq!(u.claim("dir", "NOTE.md"), "dir/NOTE 2.md");
        assert_eq!(u.claim("", "folder"), "folder");
        assert_eq!(u.claim("", "folder"), "folder 1");
        assert_eq!(u.claim("", ".hidden"), ".hidden");
    }

    #[test]
    fn base64_and_md5() {
        assert_eq!(base64_decode("aGVs\nbG8="), b"hello");
        assert_eq!(base64_decode("_-8"), vec![0xFF, 0xEF]);
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(
            md5_hex(b"The quick brown fox jumps over the lazy dog"),
            "9e107d9d372bb6826bd81d3542a419d6"
        );
        let big = vec![b'a'; 1000];
        assert_eq!(md5_hex(&big), "cabe45dcc9ae5b66ba86600cca6b8ba8");
    }

    #[test]
    fn decode_text_handles_boms_and_latin1() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFhi"), "hi");
        assert_eq!(decode_text(&[0xFF, 0xFE, b'h', 0, b'i', 0]), "hi");
        assert_eq!(decode_text(b"caf\xE9 \x93q\x94"), "café “q”");
    }

    #[test]
    fn percent_and_paths() {
        assert_eq!(percent_decode("a%20b%E2%9C%93"), "a b✓");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(encode_uri("a b/ü.png"), "a%20b/%C3%BC.png");
        assert_eq!(relative_path("a/b/note.md", "a/img/x.png"), "../img/x.png");
        assert_eq!(relative_path("note.md", "attachments/x.png"), "attachments/x.png");
        assert_eq!(relative_path("trash/n.md", "attachments/x.png"), "../attachments/x.png");
        assert_eq!(resolve_path("site/pages", "../img/./a.png"), "site/img/a.png");
        assert_eq!(resolve_path("a", "../../../x"), "x");
        assert!(has_scheme("https://x") && has_scheme("data:image/png") && has_scheme("//cdn"));
        assert!(!has_scheme("img/a.png") && !has_scheme("C:/x") && !has_scheme("a b:c"));
    }

    #[test]
    fn image_dimensions_from_headers() {
        let mut png = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0, 0, 13];
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&64u32.to_be_bytes());
        png.extend_from_slice(&32u32.to_be_bytes());
        assert_eq!(image_dimensions(&png), Some((64, 32)));
        let gif = [b'G', b'I', b'F', b'8', b'9', b'a', 10, 0, 20, 0];
        assert_eq!(image_dimensions(&gif), Some((10, 20)));
        let jpeg = [
            0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 17, 8, 0, 100, 0, 200, 3, 0, 0,
        ];
        assert_eq!(image_dimensions(&jpeg), Some((200, 100)));
    }

    #[test]
    fn multiline_tokens_stay_in_their_quote_or_list() {
        let mut t = Tokens::new();
        let math = t.add("$$a\n\nb$$");
        assert_eq!(t.replace(&format!("> > {math}\n\t\t- {math}")), "> > $$a\n> >\n> > b$$\n\t\t- $$a\n\n\t\t  b$$");
        assert_eq!(container_prefix("12. text"), "    ");
    }

    #[test]
    fn tokens_survive_and_restore() {
        let mut t = Tokens::new();
        let a = t.add("[[A]]");
        let b = t.add("![[b.png]]");
        let text = format!("x{a}y {b} ZQIMP ZQIMP99QZ");
        assert_eq!(t.replace(&text), "x[[A]]y ![[b.png]] ZQIMP ZQIMP99QZ");
    }

    #[test]
    fn sanitize_tag_strips_illegal() {
        assert_eq!(sanitize_tag("#label!'@:$\"Symbols", ""), "labelSymbols");
        assert_eq!(sanitize_tag("bad!tag", "_"), "bad_tag");
        assert_eq!(sanitize_tag("中文/子", ""), "中文/子");
    }
}
