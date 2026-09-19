//! The JSON shapes `export_note` and `export_site` take (camelCase on the
//! wire). Key names also accept the ones Obsidian Headless writes to
//! `site-options.json` (`indexFile`, `showOutline`, `defaultTheme` …), so such
//! a file can be passed as `options` unchanged.

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

/// File bytes: base64 in JSON (a plain array of numbers is accepted too).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Bytes(pub Vec<u8>);

impl Serialize for Bytes {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64_encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> de::Visitor<'de> for V {
            type Value = Bytes;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a base64 string or an array of bytes")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Bytes, E> {
                Ok(Bytes(base64_decode(v)))
            }
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Bytes, A::Error> {
                let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some(b) = seq.next_element::<u8>()? {
                    out.push(b);
                }
                Ok(Bytes(out))
            }
        }
        d.deserialize_any(V)
    }
}

/// One vault file. Notes carry `text`; attachments carry `bytes` (a note given
/// only as bytes is decoded as UTF-8).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct InputFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none", alias = "content")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", alias = "data")]
    pub bytes: Option<Bytes>,
    /// Milliseconds since the epoch.
    pub mtime: f64,
    pub ctime: f64,
}

impl InputFile {
    pub fn note(path: &str, text: &str) -> Self {
        InputFile { path: path.into(), text: Some(text.into()), ..Default::default() }
    }
    pub fn binary(path: &str, bytes: Vec<u8>) -> Self {
        InputFile { path: path.into(), bytes: Some(Bytes(bytes)), ..Default::default() }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    /// Follow `prefers-color-scheme`.
    #[default]
    #[serde(alias = "system")]
    Auto,
}

impl Theme {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Theme::Light => "light",
            Theme::Dark => "dark",
            Theme::Auto => "auto",
        }
    }
}

/// `export_note` input.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteExportInput {
    /// The note to export (must be one of `files`).
    pub path: String,
    /// The note plus anything it links or embeds: other notes (for embeds),
    /// attachments with bytes (inlined as data URIs).
    pub files: Vec<InputFile>,
    pub options: NoteOptions,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteOptions {
    /// Page title; defaults to the note's file name.
    pub title: Option<String>,
    pub theme: Theme,
    pub strict_line_breaks: bool,
    /// Show the title as an `<h1>` above the content.
    pub inline_title: bool,
    /// Show the frontmatter as a properties table.
    pub show_properties: bool,
    /// How deep `![[note]]` embeds nest before becoming links.
    pub embed_depth: u32,
    /// Notes exported alongside this one: links to them become relative
    /// `.html` hrefs using the same path scheme as `export_site`
    /// ([`crate::page_path`]). Links to other notes become plain text.
    pub exported: Vec<String>,
    /// Allow the MathJax / Mermaid CDN script tags (only added when the page
    /// has math or a mermaid block).
    pub cdn: bool,
    /// Extra CSS appended after the built-in styles.
    pub css: Option<String>,
}

impl Default for NoteOptions {
    fn default() -> Self {
        NoteOptions {
            title: None,
            theme: Theme::Auto,
            strict_line_breaks: false,
            inline_title: true,
            show_properties: true,
            embed_depth: 3,
            exported: Vec::new(),
            cdn: true,
            css: None,
        }
    }
}

/// `export_site` input.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SiteExportInput {
    /// Every vault file that may be published: notes with `text`,
    /// attachments with `bytes`, and optionally `publish.css` and favicons.
    pub files: Vec<InputFile>,
    pub options: SiteOptions,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SiteOptions {
    pub site_name: String,
    /// Home note: a path (`Home.md`) or link text (`Home`). Rendered as
    /// `index.html`; without one, `index.html` lists every page.
    #[serde(alias = "indexFile", alias = "homepage")]
    pub home: Option<String>,
    /// Absolute URL the site is served from (`https://example.com/notes/`);
    /// used for canonical/OpenGraph URLs, the sitemap and the RSS feed.
    pub base_url: String,
    #[serde(alias = "defaultTheme")]
    pub theme: Theme,
    pub show_navigation: bool,
    #[serde(alias = "showGraphView")]
    pub show_graph: bool,
    pub show_backlinks: bool,
    #[serde(alias = "showOutline")]
    pub show_toc: bool,
    #[serde(alias = "showSearch")]
    pub search: bool,
    #[serde(alias = "showHoverPreview")]
    pub hover_preview: bool,
    pub show_theme_toggle: bool,
    pub hide_title: bool,
    pub readable_line_length: bool,
    pub strict_line_breaks: bool,
    pub show_properties: bool,
    /// Folders to publish (empty = all). `publish: true` in a note's
    /// frontmatter overrides both lists, `publish: false` always excludes.
    #[serde(alias = "includes")]
    pub include: Vec<String>,
    #[serde(alias = "excludes")]
    pub exclude: Vec<String>,
    /// Vault path of a logo image shown above the navigation.
    pub logo: Option<String>,
    pub embed_depth: u32,
    /// Navigation order: folder and note paths in the order they should
    /// appear within their folder; unlisted items follow alphabetically.
    #[serde(alias = "navigationOrdering", alias = "navOrdering")]
    pub nav_order: Vec<String>,
    /// Folder and note paths hidden from the navigation (still published).
    #[serde(alias = "navigationHiddenItems")]
    pub nav_hidden: Vec<String>,
    /// Link `publish.css` from the vault root when it is among the files.
    pub custom_css: bool,
    /// Items in `rss.xml`.
    pub rss_limit: usize,
    /// Build time for the feed's `lastBuildDate` (ms since the epoch; the
    /// crate never reads the clock). 0 = latest note mtime.
    pub now_ms: f64,
    /// Write a `robots.txt` that disallows indexing and a `noindex` meta.
    #[serde(alias = "disallowIndexing")]
    pub noindex: bool,
    /// Allow the MathJax / Mermaid CDN script tags.
    pub cdn: bool,
}

impl Default for SiteOptions {
    fn default() -> Self {
        SiteOptions {
            site_name: String::new(),
            home: None,
            base_url: String::new(),
            theme: Theme::Auto,
            show_navigation: true,
            show_graph: true,
            show_backlinks: true,
            show_toc: true,
            search: true,
            hover_preview: true,
            show_theme_toggle: true,
            hide_title: false,
            readable_line_length: true,
            strict_line_breaks: false,
            show_properties: false,
            include: Vec::new(),
            exclude: Vec::new(),
            logo: None,
            embed_depth: 3,
            nav_order: Vec::new(),
            nav_hidden: Vec::new(),
            custom_css: true,
            rss_limit: 20,
            now_ms: 0.0,
            noindex: false,
            cdn: true,
        }
    }
}

/// One generated file of the site.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SiteFile {
    /// `/`-separated path relative to the site root.
    pub path: String,
    pub bytes: Vec<u8>,
}

impl SiteFile {
    pub fn text(&self) -> &str {
        std::str::from_utf8(&self.bytes).unwrap_or("")
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Standard or URL-safe alphabet; padding and whitespace are ignored.
pub fn base64_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        } as u32;
        buf = buf << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}
