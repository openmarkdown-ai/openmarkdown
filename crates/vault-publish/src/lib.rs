//! Publishing: one note → a standalone HTML document, and a vault → a static
//! website shaped like an Obsidian Publish site (navigation, outline,
//! backlinks, local and global graph, search, tag pages, hover previews,
//! permalinks and redirects, OpenGraph, sitemap, RSS).
//!
//! Behaviour follows Obsidian's public Publish documentation (the help
//! vault's "Obsidian Publish" folder: Permalinks.md, SEO.md, Social media link
//! previews.md, Customize your site.md, Publish your content.md).
//!
//! ```
//! use vault_publish::{export_note, export_site, InputFile, NoteExportInput, SiteExportInput};
//! let files = vec![
//!     InputFile::note("Home.md", "# Welcome\nSee [[Ideas]].\n\n> [!tip] Hint\n> Try it."),
//!     InputFile::note("Ideas.md", "---\ntags: [draft]\n---\nBack to [[Home]]."),
//! ];
//! let html = export_note(&NoteExportInput { path: "Home.md".into(), files: files.clone(), ..Default::default() });
//! assert!(html.contains("callout-icon\"><svg"));
//!
//! let mut input = SiteExportInput { files, ..Default::default() };
//! input.options.home = Some("Home".into());
//! let site = export_site(&input);
//! assert!(site.iter().any(|f| f.path == "Ideas.html"));
//! assert!(site.iter().any(|f| f.path == "tags/draft.html"));
//! ```
//!
//! No I/O and no clock: files come in as values, the site comes out as a list
//! of `(path, bytes)`. The only external requests a generated page makes are
//! the MathJax / Mermaid CDN scripts, and only on pages that contain math or
//! a mermaid block (turn off with `cdn: false`).

pub mod assets;
mod html;
mod input;
mod note;
pub mod paths;
mod pipeline;
mod site;

pub use input::{base64_decode, base64_encode, Bytes, InputFile, NoteExportInput, NoteOptions, SiteExportInput, SiteFile, SiteOptions, Theme};
pub use paths::page_path;

/// One note as a complete HTML document: inline CSS, resolved links, inlined
/// embeds and images (data URIs), callout icons, properties table, light and
/// dark palettes, print styles.
pub fn export_note(input: &NoteExportInput) -> String {
    note::export_note(input)
}

/// Every published note as a static website. See the `site` module
/// documentation for the list of generated files.
pub fn export_site(input: &SiteExportInput) -> Vec<SiteFile> {
    site::export_site(input)
}

/// The notes `export_site` would publish with these options (vault paths,
/// sorted), without rendering anything.
pub fn published_notes(input: &SiteExportInput) -> Vec<String> {
    let vault = pipeline::Vault::build(&input.files);
    site::select_notes(&vault, &input.options)
}

#[cfg(test)]
mod tests;
