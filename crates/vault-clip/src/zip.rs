//! A ZIP reader (and a small writer) for the importers.
//!
//! Every export an importer reads arrives zipped at least once: a Notion export
//! is a zip holding `Export-…-Part-1.zip`, a Bear backup is a zip of
//! `.textbundle` folders, a Google Takeout is a zip of JSON and images. The
//! browser hands the bytes over; this turns them into entries.
//!
//! What it reads: stored and deflated entries, sizes from the central directory
//! (so entries written with data descriptors read correctly), Zip64 end records
//! and Zip64 extra fields, UTF-8 names (general-purpose flag bit 11 or the
//! Info-ZIP Unicode Path extra field) with a CP437 fallback for names written
//! by old Windows tools. What it refuses: encrypted entries, and methods other
//! than store and deflate.
//!
//! Two guards, because the input is whatever file a user dropped:
//!
//! - **Zip bombs.** Inflation is capped at the declared size of each entry and
//!   the total at [`MAX_TOTAL_UNCOMPRESSED`] (or the caller's limit), so a
//!   42-kilobyte archive cannot claim four gigabytes of a wasm heap.
//! - **Path traversal.** Names are normalised: backslashes become slashes,
//!   drive prefixes and leading slashes are dropped, and `.`/`..` segments are
//!   removed, so no entry can name a path outside the folder it is unpacked to.
//!
//! The writer is adapted from `openread/crates/read-core/src/zip.rs` (same
//! licence, MIT OR Apache-2.0), with miniz_oxide in place of flate2 and a local
//! CRC-32. It exists for building test fixtures and for callers that need to
//! hand a zip back.

use std::fmt;

/// Default cap on the total inflated size of one archive: 1 GiB.
pub const MAX_TOTAL_UNCOMPRESSED: u64 = 1 << 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntry {
    /// Normalised path inside the archive, forward slashes, no leading slash,
    /// no `.` or `..` segments. Directories keep no trailing slash.
    pub name: String,
    pub data: Vec<u8>,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZipError {
    /// No end-of-central-directory record: not a zip, or cut off.
    NotAZip,
    /// A record points past the end of the data.
    Truncated,
    /// An entry is encrypted; its name is given.
    Encrypted(String),
    /// A compression method other than store (0) or deflate (8).
    UnsupportedMethod { name: String, method: u16 },
    /// Deflate data that does not inflate, or a CRC that does not match.
    Corrupt(String),
    /// The archive inflates to more than the allowed total.
    TooLarge { limit: u64 },
}

impl fmt::Display for ZipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ZipError::NotAZip => write!(f, "not a zip archive"),
            ZipError::Truncated => write!(f, "zip archive is truncated"),
            ZipError::Encrypted(n) => write!(f, "zip entry is encrypted: {n}"),
            ZipError::UnsupportedMethod { name, method } => {
                write!(f, "unsupported compression method {method} for {name}")
            }
            ZipError::Corrupt(n) => write!(f, "zip entry is corrupt: {n}"),
            ZipError::TooLarge { limit } => {
                write!(f, "zip archive inflates to more than {limit} bytes")
            }
        }
    }
}

impl std::error::Error for ZipError {}

/// Read every entry of an archive, capping the total at
/// [`MAX_TOTAL_UNCOMPRESSED`].
pub fn read_zip(bytes: &[u8]) -> Result<Vec<ZipEntry>, ZipError> {
    read_zip_with_limit(bytes, MAX_TOTAL_UNCOMPRESSED)
}

/// True when the bytes start with a local file header or an empty-archive end
/// record, which is how an importer tells a nested zip from an attachment.
pub fn looks_like_zip(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && (u32_at(bytes, 0) == Some(LOCAL_SIG) || u32_at(bytes, 0) == Some(EOCD_SIG))
}

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;
const ZIP64_LOCATOR_SIG: u32 = 0x0706_4b50;

pub fn read_zip_with_limit(bytes: &[u8], limit: u64) -> Result<Vec<ZipEntry>, ZipError> {
    let eocd = find_eocd(bytes).ok_or(ZipError::NotAZip)?;
    let mut count = u16_at(bytes, eocd + 10).ok_or(ZipError::Truncated)? as u64;
    let mut cd_size = u32_at(bytes, eocd + 12).ok_or(ZipError::Truncated)? as u64;
    let mut cd_offset = u32_at(bytes, eocd + 16).ok_or(ZipError::Truncated)? as u64;

    // Zip64: the locator sits immediately before the classic end record.
    if eocd >= 20 && u32_at(bytes, eocd - 20) == Some(ZIP64_LOCATOR_SIG) {
        if let Some(z64) = u64_at(bytes, eocd - 20 + 8) {
            let z64 = z64 as usize;
            if u32_at(bytes, z64) == Some(ZIP64_EOCD_SIG) {
                count = u64_at(bytes, z64 + 32).ok_or(ZipError::Truncated)?;
                cd_size = u64_at(bytes, z64 + 40).ok_or(ZipError::Truncated)?;
                cd_offset = u64_at(bytes, z64 + 48).ok_or(ZipError::Truncated)?;
            }
        }
    }

    // Some writers prepend data (self-extracting stubs) without adjusting
    // offsets; the true start of the central directory is then `eocd - size`.
    let mut shift: i64 = 0;
    if u32_at(bytes, cd_offset as usize) != Some(CENTRAL_SIG) && count > 0 {
        let actual = (eocd as u64).checked_sub(cd_size).ok_or(ZipError::Truncated)?;
        if u32_at(bytes, actual as usize) != Some(CENTRAL_SIG) {
            return Err(ZipError::Truncated);
        }
        shift = actual as i64 - cd_offset as i64;
        cd_offset = actual;
    }

    let mut entries = Vec::new();
    let mut total: u64 = 0;
    let mut p = cd_offset as usize;
    // `count` comes from the file; never trust it for an allocation.
    for _ in 0..count {
        if u32_at(bytes, p) != Some(CENTRAL_SIG) {
            break;
        }
        let flags = u16_at(bytes, p + 8).ok_or(ZipError::Truncated)?;
        let method = u16_at(bytes, p + 10).ok_or(ZipError::Truncated)?;
        let crc = u32_at(bytes, p + 16).ok_or(ZipError::Truncated)?;
        let mut csize = u32_at(bytes, p + 20).ok_or(ZipError::Truncated)? as u64;
        let mut usize_ = u32_at(bytes, p + 24).ok_or(ZipError::Truncated)? as u64;
        let name_len = u16_at(bytes, p + 28).ok_or(ZipError::Truncated)? as usize;
        let extra_len = u16_at(bytes, p + 30).ok_or(ZipError::Truncated)? as usize;
        let comment_len = u16_at(bytes, p + 32).ok_or(ZipError::Truncated)? as usize;
        let external = u32_at(bytes, p + 38).ok_or(ZipError::Truncated)?;
        let mut local = u32_at(bytes, p + 42).ok_or(ZipError::Truncated)? as u64;
        let name_raw = bytes
            .get(p + 46..p + 46 + name_len)
            .ok_or(ZipError::Truncated)?;
        let extra = bytes
            .get(p + 46 + name_len..p + 46 + name_len + extra_len)
            .ok_or(ZipError::Truncated)?;
        p += 46 + name_len + extra_len + comment_len;

        let mut unicode_name: Option<String> = None;
        let mut e = 0;
        while e + 4 <= extra.len() {
            let id = u16::from_le_bytes([extra[e], extra[e + 1]]);
            let len = u16::from_le_bytes([extra[e + 2], extra[e + 3]]) as usize;
            let body = extra.get(e + 4..e + 4 + len).unwrap_or(&[]);
            match id {
                0x0001 => {
                    // Only the fields that were saturated in the fixed header
                    // are present, in this order.
                    let mut q = 0;
                    let mut take = |b: &[u8]| -> Option<u64> {
                        let v = u64_at(b, q);
                        q += 8;
                        v
                    };
                    if usize_ == 0xFFFF_FFFF {
                        usize_ = take(body).unwrap_or(usize_);
                    }
                    if csize == 0xFFFF_FFFF {
                        csize = take(body).unwrap_or(csize);
                    }
                    if local == 0xFFFF_FFFF {
                        local = take(body).unwrap_or(local);
                    }
                }
                0x7075 if body.len() > 5 => {
                    // Info-ZIP Unicode Path: version(1) crc(4) utf8-name.
                    if let Ok(s) = std::str::from_utf8(&body[5..]) {
                        unicode_name = Some(s.to_string());
                    }
                }
                _ => {}
            }
            e += 4 + len;
        }

        let raw_name = unicode_name.unwrap_or_else(|| decode_name(name_raw, flags & 0x0800 != 0));
        let is_dir = raw_name.ends_with('/') || raw_name.ends_with('\\') || (external & 0x10) != 0;
        let name = normalise_name(&raw_name);
        if name.is_empty() {
            continue;
        }
        if is_dir {
            entries.push(ZipEntry {
                name,
                data: Vec::new(),
                is_dir: true,
            });
            continue;
        }
        if flags & 0x0001 != 0 {
            return Err(ZipError::Encrypted(name));
        }

        let local = (local as i64 + shift) as usize;
        if u32_at(bytes, local) != Some(LOCAL_SIG) {
            return Err(ZipError::Truncated);
        }
        let lname = u16_at(bytes, local + 26).ok_or(ZipError::Truncated)? as usize;
        let lextra = u16_at(bytes, local + 28).ok_or(ZipError::Truncated)? as usize;
        let start = local + 30 + lname + lextra;
        let end = start
            .checked_add(csize as usize)
            .ok_or(ZipError::Truncated)?;
        let raw = bytes.get(start..end).ok_or(ZipError::Truncated)?;

        let remaining = limit.saturating_sub(total);
        if usize_ > remaining {
            return Err(ZipError::TooLarge { limit });
        }
        let data = match method {
            0 => raw.to_vec(),
            8 => {
                // The declared size bounds the output: a stream that claims
                // less than it inflates to is corrupt, not a reason to grow.
                let cap = (usize_ as usize).min(remaining as usize);
                match miniz_oxide::inflate::decompress_to_vec_with_limit(raw, cap.max(1)) {
                    Ok(v) => v,
                    Err(err) => {
                        if matches!(
                            err.status,
                            miniz_oxide::inflate::TINFLStatus::HasMoreOutput
                        ) {
                            if usize_ >= remaining {
                                return Err(ZipError::TooLarge { limit });
                            }
                            return Err(ZipError::Corrupt(name));
                        }
                        return Err(ZipError::Corrupt(name));
                    }
                }
            }
            m => {
                return Err(ZipError::UnsupportedMethod { name, method: m });
            }
        };
        if crc32(&data) != crc {
            return Err(ZipError::Corrupt(name));
        }
        total += data.len() as u64;
        entries.push(ZipEntry {
            name,
            data,
            is_dir: false,
        });
    }
    Ok(entries)
}

fn find_eocd(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 22 {
        return None;
    }
    let last = bytes.len() - 22;
    let first = last.saturating_sub(0xFFFF);
    (first..=last)
        .rev()
        .find(|&i| u32_at(bytes, i) == Some(EOCD_SIG))
}

/// Normalise an archive path so it cannot escape the folder it lands in.
pub fn normalise_name(raw: &str) -> String {
    let unified = raw.replace('\\', "/");
    let mut parts: Vec<String> = Vec::new();
    for (i, seg) in unified.split('/').enumerate() {
        let seg: String = seg.chars().filter(|c| (*c as u32) >= 0x20).collect();
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        // A drive prefix ("C:") at the start is an absolute Windows path.
        if i == 0 && seg.len() == 2 && seg.ends_with(':') {
            continue;
        }
        parts.push(seg);
    }
    parts.join("/")
}

fn decode_name(raw: &[u8], utf8_flag: bool) -> String {
    if utf8_flag || raw.is_ascii() {
        return String::from_utf8_lossy(raw).into_owned();
    }
    // Without the flag the spec says CP437, but macOS Archive Utility and many
    // modern tools write UTF-8 regardless. Valid UTF-8 with non-ASCII bytes is
    // vanishingly unlikely to be intended CP437, so prefer it.
    if let Ok(s) = std::str::from_utf8(raw) {
        return s.to_string();
    }
    raw.iter()
        .map(|&b| {
            if b < 0x80 {
                b as char
            } else {
                CP437_HIGH[(b - 0x80) as usize]
            }
        })
        .collect()
}

const CP437_HIGH: [char; 128] = [
    'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å', 'É', 'æ', 'Æ',
    'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ', 'á', 'í', 'ó', 'ú', 'ñ', 'Ñ',
    'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»', '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕',
    '╣', '║', '╗', '╝', '╜', '╛', '┐', '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦',
    '╠', '═', '╬', '╧', '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐',
    '▀', 'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩', '≡', '±',
    '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²', '■', '\u{a0}',
];

fn u16_at(b: &[u8], i: usize) -> Option<u16> {
    b.get(i..i.checked_add(2)?).map(|s| u16::from_le_bytes([s[0], s[1]]))
}
fn u32_at(b: &[u8], i: usize) -> Option<u32> {
    b.get(i..i.checked_add(4)?)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}
fn u64_at(b: &[u8], i: usize) -> Option<u64> {
    b.get(i..i.checked_add(8)?).map(|s| {
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        u64::from_le_bytes(a)
    })
}

/// CRC-32 (IEEE 802.3, reflected), table-driven.
pub fn crc32(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        t
    });
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Store,
    Deflate,
}

struct WrittenEntry {
    name: Vec<u8>,
    method: Method,
    crc: u32,
    compressed: usize,
    uncompressed: usize,
    offset: usize,
    flags: u16,
}

/// A minimal writer: stored and deflated entries, no Zip64, no encryption.
#[derive(Default)]
pub struct ZipWriter {
    buf: Vec<u8>,
    entries: Vec<WrittenEntry>,
    /// When set, entries are written with bit 3 and a trailing data
    /// descriptor, zeroing the sizes in the local header (as streaming
    /// writers do). Exists so the reader's handling of that shape is tested.
    pub data_descriptors: bool,
}

impl ZipWriter {
    pub fn new() -> ZipWriter {
        ZipWriter::default()
    }

    pub fn add(&mut self, name: &str, data: &[u8], method: Method) {
        self.add_raw_name(name.as_bytes(), true, data, method);
    }

    pub fn add_text(&mut self, name: &str, text: &str) {
        self.add(name, text.as_bytes(), Method::Deflate);
    }

    /// Add with a name given as raw bytes; `utf8` controls flag bit 11.
    pub fn add_raw_name(&mut self, name: &[u8], utf8: bool, data: &[u8], method: Method) {
        let offset = self.buf.len();
        let crc = crc32(data);
        let body = match method {
            Method::Store => data.to_vec(),
            Method::Deflate => miniz_oxide::deflate::compress_to_vec(data, 6),
        };
        let (method, body) = if method == Method::Deflate && body.len() >= data.len() {
            (Method::Store, data.to_vec())
        } else {
            (method, body)
        };
        let mut flags: u16 = if utf8 && !name.is_ascii() { 0x0800 } else { 0 };
        if self.data_descriptors {
            flags |= 0x0008;
        }
        let (lcrc, lc, lu) = if self.data_descriptors {
            (0, 0, 0)
        } else {
            (crc, body.len() as u32, data.len() as u32)
        };
        self.buf.extend_from_slice(&LOCAL_SIG.to_le_bytes());
        self.buf.extend_from_slice(&20u16.to_le_bytes());
        self.buf.extend_from_slice(&flags.to_le_bytes());
        self.buf.extend_from_slice(&method_code(method).to_le_bytes());
        self.buf.extend_from_slice(&0u16.to_le_bytes());
        self.buf.extend_from_slice(&0x21u16.to_le_bytes());
        self.buf.extend_from_slice(&lcrc.to_le_bytes());
        self.buf.extend_from_slice(&lc.to_le_bytes());
        self.buf.extend_from_slice(&lu.to_le_bytes());
        self.buf.extend_from_slice(&(name.len() as u16).to_le_bytes());
        self.buf.extend_from_slice(&0u16.to_le_bytes());
        self.buf.extend_from_slice(name);
        self.buf.extend_from_slice(&body);
        if self.data_descriptors {
            self.buf.extend_from_slice(&0x0807_4b50u32.to_le_bytes());
            self.buf.extend_from_slice(&crc.to_le_bytes());
            self.buf.extend_from_slice(&(body.len() as u32).to_le_bytes());
            self.buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        }
        self.entries.push(WrittenEntry {
            name: name.to_vec(),
            method,
            crc,
            compressed: body.len(),
            uncompressed: data.len(),
            offset,
            flags,
        });
    }

    pub fn finish(mut self) -> Vec<u8> {
        let cd_offset = self.buf.len();
        for e in &self.entries {
            let name = &e.name;
            self.buf.extend_from_slice(&CENTRAL_SIG.to_le_bytes());
            self.buf.extend_from_slice(&20u16.to_le_bytes());
            self.buf.extend_from_slice(&20u16.to_le_bytes());
            self.buf.extend_from_slice(&e.flags.to_le_bytes());
            self.buf.extend_from_slice(&method_code(e.method).to_le_bytes());
            self.buf.extend_from_slice(&0u16.to_le_bytes());
            self.buf.extend_from_slice(&0x21u16.to_le_bytes());
            self.buf.extend_from_slice(&e.crc.to_le_bytes());
            self.buf.extend_from_slice(&(e.compressed as u32).to_le_bytes());
            self.buf.extend_from_slice(&(e.uncompressed as u32).to_le_bytes());
            self.buf.extend_from_slice(&(name.len() as u16).to_le_bytes());
            self.buf.extend_from_slice(&0u16.to_le_bytes());
            self.buf.extend_from_slice(&0u16.to_le_bytes());
            self.buf.extend_from_slice(&0u16.to_le_bytes());
            self.buf.extend_from_slice(&0u16.to_le_bytes());
            self.buf.extend_from_slice(&0u32.to_le_bytes());
            self.buf.extend_from_slice(&(e.offset as u32).to_le_bytes());
            self.buf.extend_from_slice(name);
        }
        let cd_size = self.buf.len() - cd_offset;
        let count = self.entries.len() as u16;
        self.buf.extend_from_slice(&EOCD_SIG.to_le_bytes());
        self.buf.extend_from_slice(&0u16.to_le_bytes());
        self.buf.extend_from_slice(&0u16.to_le_bytes());
        self.buf.extend_from_slice(&count.to_le_bytes());
        self.buf.extend_from_slice(&count.to_le_bytes());
        self.buf.extend_from_slice(&(cd_size as u32).to_le_bytes());
        self.buf.extend_from_slice(&(cd_offset as u32).to_le_bytes());
        self.buf.extend_from_slice(&0u16.to_le_bytes());
        self.buf
    }
}

fn method_code(m: Method) -> u16 {
    match m {
        Method::Store => 0,
        Method::Deflate => 8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(entries: &[(&str, &[u8], Method)]) -> Vec<u8> {
        let mut z = ZipWriter::new();
        for (n, d, m) in entries {
            z.add(n, d, *m);
        }
        z.finish()
    }

    #[test]
    fn crc32_matches_known_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn round_trips_stored_and_deflated_entries() {
        let text = "hello world ".repeat(100);
        let zip = build(&[
            ("a.txt", b"plain", Method::Store),
            ("dir/b.txt", text.as_bytes(), Method::Deflate),
        ]);
        let entries = read_zip(&zip).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "a.txt");
        assert_eq!(entries[0].data, b"plain");
        assert_eq!(entries[1].name, "dir/b.txt");
        assert_eq!(entries[1].data, text.as_bytes());
    }

    #[test]
    fn reads_entries_written_with_data_descriptors() {
        let mut z = ZipWriter::new();
        z.data_descriptors = true;
        z.add("one.md", "first body ".repeat(20).as_bytes(), Method::Deflate);
        z.add("two.md", b"second", Method::Store);
        let entries = read_zip(&z.finish()).unwrap();
        assert_eq!(entries[1].data, b"second");
        assert!(String::from_utf8_lossy(&entries[0].data).starts_with("first body"));
    }

    #[test]
    fn normalises_traversal_and_absolute_names() {
        let zip = build(&[
            ("../../etc/passwd", b"x", Method::Store),
            ("/abs/./file.txt", b"y", Method::Store),
            ("C:\\win\\path.txt", b"z", Method::Store),
        ]);
        let names: Vec<_> = read_zip(&zip).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["etc/passwd", "abs/file.txt", "win/path.txt"]);
    }

    #[test]
    fn directory_entries_are_flagged() {
        let zip = build(&[("folder/", b"", Method::Store), ("folder/x", b"1", Method::Store)]);
        let entries = read_zip(&zip).unwrap();
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "folder");
        assert!(!entries[1].is_dir);
    }

    #[test]
    fn utf8_flag_and_cp437_fallback_names() {
        let mut z = ZipWriter::new();
        z.add("кошки.jpg", b"1", Method::Store);
        // "Ä.txt" in CP437 is 0x8E.
        z.add_raw_name(&[0x8E, b'.', b't', b'x', b't'], false, b"2", Method::Store);
        let entries = read_zip(&z.finish()).unwrap();
        assert_eq!(entries[0].name, "кошки.jpg");
        assert_eq!(entries[1].name, "Ä.txt");
    }

    #[test]
    fn zip_bomb_is_refused_by_total_limit() {
        let zeros = vec![0u8; 200_000];
        let zip = build(&[("bomb.bin", &zeros, Method::Deflate)]);
        assert!(zip.len() < 2_000);
        assert_eq!(
            read_zip_with_limit(&zip, 100_000),
            Err(ZipError::TooLarge { limit: 100_000 })
        );
        assert!(read_zip_with_limit(&zip, 300_000).is_ok());
    }

    #[test]
    fn lying_declared_size_is_corrupt_not_unbounded() {
        let zeros = vec![0u8; 50_000];
        let mut zip = build(&[("x.bin", &zeros, Method::Deflate)]);
        // Patch the central directory's uncompressed size down to 10.
        let eocd = zip.len() - 22;
        let cd = u32_at(&zip, eocd + 16).unwrap() as usize;
        zip[cd + 24..cd + 28].copy_from_slice(&10u32.to_le_bytes());
        assert!(matches!(read_zip(&zip), Err(ZipError::Corrupt(_))));
    }

    #[test]
    fn crc_mismatch_is_corrupt() {
        let mut zip = build(&[("a.txt", b"abcdef", Method::Store)]);
        zip[30 + 5] = b'X';
        assert_eq!(read_zip(&zip), Err(ZipError::Corrupt("a.txt".into())));
    }

    #[test]
    fn not_a_zip_and_truncated() {
        assert_eq!(read_zip(b"hello"), Err(ZipError::NotAZip));
        let zip = build(&[("a.txt", b"abcdef", Method::Store)]);
        assert!(read_zip(&zip[10..]).is_err());
        assert!(looks_like_zip(&zip));
        assert!(!looks_like_zip(b"%PDF-1.4"));
    }

    #[test]
    fn prepended_stub_is_tolerated() {
        let zip = build(&[("a.txt", b"abc", Method::Store)]);
        let mut sfx = b"MZ-stub-bytes".to_vec();
        sfx.extend_from_slice(&zip);
        let entries = read_zip(&sfx).unwrap();
        assert_eq!(entries[0].data, b"abc");
    }

    #[test]
    fn zip64_end_record_is_followed() {
        let zip = build(&[("a.txt", b"abc", Method::Store)]);
        let eocd = zip.len() - 22;
        let cd_offset = u32_at(&zip, eocd + 16).unwrap() as u64;
        let cd_size = u32_at(&zip, eocd + 12).unwrap() as u64;
        let mut out = zip[..eocd].to_vec();
        let z64_at = out.len() as u64;
        out.extend_from_slice(&ZIP64_EOCD_SIG.to_le_bytes());
        out.extend_from_slice(&44u64.to_le_bytes());
        out.extend_from_slice(&45u16.to_le_bytes());
        out.extend_from_slice(&45u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&1u64.to_le_bytes());
        out.extend_from_slice(&1u64.to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&ZIP64_LOCATOR_SIG.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&z64_at.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        // Classic record with saturated fields.
        out.extend_from_slice(&EOCD_SIG.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&0xFFFFu16.to_le_bytes());
        out.extend_from_slice(&0xFFFFu16.to_le_bytes());
        out.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        out.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        let entries = read_zip(&out).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].data, b"abc");
    }

    #[test]
    fn encrypted_entry_is_reported_by_name() {
        let mut zip = build(&[("secret.txt", b"abc", Method::Store)]);
        let eocd = zip.len() - 22;
        let cd = u32_at(&zip, eocd + 16).unwrap() as usize;
        zip[cd + 8] |= 1;
        assert_eq!(read_zip(&zip), Err(ZipError::Encrypted("secret.txt".into())));
    }
}
