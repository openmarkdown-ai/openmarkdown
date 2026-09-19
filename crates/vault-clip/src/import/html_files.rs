//! A folder of HTML files (saved pages, a static site, a wiki export).
//!
//! Mirrors obsidian-importer's HTML importer:
//!
//! - Each `.html`/`.htm` file becomes a note in the same folder structure,
//!   named by its title (the extractor's title, else `<title>`, else the file
//!   name, with a trailing `.html` removed).
//! - With `extractMainContent` (the default) the page's main content is taken
//!   by [`crate::extract`] (the Defuddle port), falling back to the whole body
//!   when extraction finds nothing.
//! - Local `<img>`, `<audio>` and `<video>` files are copied into the
//!   attachment folder and embedded as `![[file]]`; images smaller than
//!   `minimumImageSize` pixels on either side (icons, spacers) and files over
//!   `attachmentSizeLimit` bytes are left out. A file without an extension
//!   gets `png`/`mp3`/`mp4` by element.
//! - Links to other imported pages become wikilinks to their notes, and a
//!   `#fragment` naming a heading's `id` becomes `#Heading text`.
//!
//! Remote images are left as links (nothing is downloaded here).

use super::markup::Doc;
use super::util::{
    basename, extension_lower, image_dimensions, parent, percent_decode, resolve_path,
    sanitize_file_name, sanitize_file_path, split_ext, Tokens, UniquePaths,
};
use super::{ImportResult, ImportedFile, LinkResolver};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HtmlFilesOptions {
    /// Take the main content with the readability extractor.
    pub extract_main_content: bool,
    /// Skip attachments larger than this many bytes; 0 for no limit.
    pub attachment_size_limit: u64,
    /// Skip images narrower or shorter than this; 0 keeps every image.
    pub minimum_image_size: u32,
    pub attachment_folder: String,
}

impl Default for HtmlFilesOptions {
    fn default() -> Self {
        HtmlFilesOptions {
            extract_main_content: true,
            attachment_size_limit: 0,
            minimum_image_size: 65,
            attachment_folder: "attachments".into(),
        }
    }
}

const BASE: &str = "https://import.invalid/";

struct Page {
    source: String,
    path: String,
    title: String,
    html: String,
    /// `id` attribute → heading text.
    headings: HashMap<String, String>,
}

pub fn convert(files: &[(String, Vec<u8>)], opts: &HtmlFilesOptions) -> ImportResult {
    let mut result = ImportResult::default();
    let mut flat: Vec<(String, Vec<u8>)> = Vec::new();
    for (p, d) in files {
        let p = p.replace('\\', "/").trim_start_matches('/').to_string();
        if extension_lower(&p) == "zip" {
            match crate::zip::read_zip(d) {
                Ok(es) => flat.extend(es.into_iter().filter(|e| !e.is_dir).map(|e| (e.name, e.data))),
                Err(e) => result.warnings.push(format!("{p}: {e}")),
            }
        } else {
            flat.push((p, d.clone()));
        }
    }
    flat.retain(|(p, _)| !p.split('/').any(|s| s.starts_with('.') || s == "__MACOSX"));
    let index: HashMap<String, usize> = flat.iter().enumerate().map(|(i, (p, _))| (p.to_lowercase(), i)).collect();

    let mut paths = UniquePaths::new();
    let mut pages: Vec<Page> = Vec::new();
    for (p, d) in &flat {
        if !matches!(extension_lower(p).as_str(), "html" | "htm") {
            continue;
        }
        let html = super::util::decode_text(d);
        let doc = Doc::parse_html(&html);
        let title_tag = doc
            .find(doc.root, "title")
            .map(|t| doc.text_content(t).split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        let mut headings = HashMap::new();
        for h in doc.descendants(doc.root) {
            if matches!(doc.name(h), Some("h1" | "h2" | "h3" | "h4" | "h5" | "h6")) {
                if let Some(id) = doc.attr(h, "id") {
                    let text = doc.text_content(h).split_whitespace().collect::<Vec<_>>().join(" ");
                    if !id.is_empty() && !text.is_empty() {
                        headings.insert(id.to_string(), text);
                    }
                }
            }
        }
        let extracted_title = if opts.extract_main_content {
            crate::extract(&html, &format!("{BASE}{}", super::util::encode_uri(p))).title
        } else {
            String::new()
        };
        let fallback = split_ext(basename(p)).0.to_string();
        let chosen = [extracted_title.trim(), title_tag.trim()]
            .into_iter()
            .find(|t| !t.is_empty())
            .unwrap_or(&fallback)
            .to_string();
        let lower = chosen.to_lowercase();
        let chosen = if lower.ends_with(".html") {
            chosen[..chosen.len() - 5].to_string()
        } else if lower.ends_with(".htm") {
            chosen[..chosen.len() - 4].to_string()
        } else {
            chosen
        };
        let title = if chosen.trim().is_empty() { fallback } else { chosen };
        let folder = sanitize_file_path(parent(p));
        let path = paths.claim(&folder, &format!("{}.md", sanitize_file_name(&title)));
        pages.push(Page {
            source: p.clone(),
            path,
            title,
            html,
            headings,
        });
    }
    if pages.is_empty() {
        result.warnings.push("No HTML files found".into());
        return result;
    }
    let by_source: HashMap<String, usize> = pages.iter().enumerate().map(|(i, pg)| (pg.source.to_lowercase(), i)).collect();

    // Attachments are placed while converting, so links are resolved in a
    // second pass once every path is known.
    let attachment_dir = opts.attachment_folder.trim_matches('/').to_string();
    let mut placed: HashMap<usize, Option<String>> = HashMap::new();
    let mut attachments: Vec<ImportedFile> = Vec::new();
    let mut drafts: Vec<(String, String, Tokens)> = Vec::new();
    for page in &pages {
        let content = if opts.extract_main_content {
            let url = format!("{BASE}{}", super::util::encode_uri(&page.source));
            let ex = crate::extract(&page.html, &url);
            if ex.content_html.trim().is_empty() {
                None
            } else {
                Some(ex.content_html)
            }
        } else {
            None
        };
        let mut doc = Doc::parse_html(content.as_deref().unwrap_or(&page.html));
        let root = doc.find(doc.root, "body").unwrap_or(doc.root);
        for tag in ["script", "style", "noscript", "template"] {
            for n in doc.find_all(root, tag) {
                doc.detach(n);
            }
        }
        let mut tokens = Tokens::new();
        for el in doc.descendants(root) {
            let Some(name) = doc.name(el).map(str::to_string) else {
                continue;
            };
            if doc.parent(el).is_none() {
                continue;
            }
            match name.as_str() {
                "img" | "audio" | "video" => {
                    let src = doc
                        .attr(el, "src")
                        .map(str::to_string)
                        .or_else(|| {
                            doc.find(el, "source").and_then(|s| doc.attr(s, "src")).map(str::to_string)
                        });
                    let Some(src) = src else {
                        continue;
                    };
                    let Some(local) = local_path(&page.source, &src) else {
                        continue;
                    };
                    let Some(&i) = index.get(&local.to_lowercase()) else {
                        if !matches!(extension_lower(&local).as_str(), "html" | "htm") {
                            result.warnings.push(format!("{}: {src} is not in the import", page.source));
                        }
                        continue;
                    };
                    let target = placed
                        .entry(i)
                        .or_insert_with(|| {
                            let data = &flat[i].1;
                            if opts.attachment_size_limit > 0 && data.len() as u64 > opts.attachment_size_limit {
                                result.warnings.push(format!("Skipped {}: larger than the attachment size limit", flat[i].0));
                                return None;
                            }
                            if name == "img" && opts.minimum_image_size > 0 {
                                if let Some((w, h)) = image_dimensions(data) {
                                    if w < opts.minimum_image_size || h < opts.minimum_image_size {
                                        return None;
                                    }
                                }
                            }
                            let file = basename(&flat[i].0);
                            let (stem, ext) = split_ext(file);
                            let ext = if ext.is_empty() {
                                match name.as_str() {
                                    "img" => super::util::extension_from_bytes(data).unwrap_or("png"),
                                    "audio" => "mp3",
                                    _ => "mp4",
                                }
                                .to_string()
                            } else {
                                ext.to_string()
                            };
                            let out = paths.claim(&attachment_dir, &sanitize_file_name(&format!("{stem}.{ext}")));
                            attachments.push(ImportedFile::new(out.clone(), data.clone()));
                            Some(out)
                        })
                        .clone();
                    match target {
                        Some(t) => {
                            let tok = tokens.add(format!("embed\0{t}"));
                            doc.replace_with_text(el, &tok);
                        }
                        None => doc.detach(el),
                    }
                }
                "a" => {
                    let Some(href) = doc.attr(el, "href").map(str::to_string) else {
                        continue;
                    };
                    let (link, fragment) = match href.split_once('#') {
                        Some((l, f)) => (l.to_string(), Some(percent_decode(f))),
                        None => (href.clone(), None),
                    };
                    let target_page = if link.is_empty() {
                        by_source.get(&page.source.to_lowercase()).copied()
                    } else {
                        local_path(&page.source, &link).and_then(|l| {
                            let l = l.to_lowercase();
                            by_source
                                .get(&l)
                                .or_else(|| by_source.get(&format!("{l}.html")))
                                .or_else(|| by_source.get(&format!("{l}/index.html")))
                                .copied()
                        })
                    };
                    let Some(t) = target_page else {
                        continue;
                    };
                    let heading = fragment.as_ref().map(|f| pages[t].headings.get(f).cloned().unwrap_or_else(|| f.clone()));
                    let same_page = link.is_empty();
                    let text = doc.text_content(el).split_whitespace().collect::<Vec<_>>().join(" ");
                    if text.is_empty() && !doc.element_children(el).is_empty() {
                        continue;
                    }
                    let tok = tokens.add(format!(
                        "link\0{}\0{}\0{}",
                        if same_page { String::new() } else { pages[t].path.clone() },
                        heading.unwrap_or_default(),
                        text
                    ));
                    doc.replace_with_text(el, &tok);
                }
                _ => {}
            }
        }
        let html = doc.inner_html(root);
        let md = crate::html_to_markdown(&html, None);
        drafts.push((page.path.clone(), md, tokens));
    }

    let resolver = LinkResolver::new(
        pages
            .iter()
            .map(|p| p.path.as_str())
            .chain(attachments.iter().map(|a| a.path.as_str())),
    );
    let titles: HashMap<&str, &str> = pages.iter().map(|p| (p.path.as_str(), p.title.as_str())).collect();
    for (path, md, tokens) in drafts {
        let text = tokens.replace_with(&md, |_, v| render(v, &resolver, &titles));
        let text = format!("{}\n", text.trim_end());
        result.files.push(ImportedFile::note(path, text));
    }
    result.files.extend(attachments);
    result
}

fn render(value: &str, resolver: &LinkResolver, titles: &HashMap<&str, &str>) -> String {
    let parts: Vec<&str> = value.split('\0').collect();
    match parts[0] {
        "embed" => format!("![[{}]]", resolver.link(parts[1])),
        "link" => {
            let (path, heading, text) = (parts[1], parts[2], parts[3]);
            let mut target = if path.is_empty() { String::new() } else { resolver.link(path) };
            if !heading.is_empty() {
                target.push('#');
                target.push_str(&heading.replace(['[', ']', '|', '#', '^'], " ").split_whitespace().collect::<Vec<_>>().join(" "));
            }
            let title = titles.get(path).copied().unwrap_or("");
            if text.is_empty() || text == target || (heading.is_empty() && text == title && target == title) {
                format!("[[{target}]]")
            } else {
                format!("[[{target}|{}]]", text.replace(['[', ']'], ""))
            }
        }
        _ => String::new(),
    }
}

/// A `src`/`href` as a path in the import, or `None` for remote, data and
/// other scheme URLs.
fn local_path(page: &str, url: &str) -> Option<String> {
    let url = url.trim().replace('\\', "/");
    if let Some(rest) = url.strip_prefix(BASE) {
        return Some(percent_decode(rest.split(['?', '#']).next().unwrap_or("")));
    }
    if url.is_empty() || url.starts_with('#') || super::util::has_scheme(&url) {
        return None;
    }
    let clean = percent_decode(url.split(['?', '#']).next().unwrap_or(""));
    if clean.is_empty() {
        return None;
    }
    Some(if clean.starts_with('/') {
        // Site-root relative: the page's top folder is the site root.
        let root = page.split('/').next().filter(|_| page.contains('/')).unwrap_or("");
        resolve_path(root, clean.trim_start_matches('/'))
    } else {
        resolve_path(parent(page), &clean)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10, 0, 0, 0, 13];
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v
    }

    fn opts() -> HtmlFilesOptions {
        HtmlFilesOptions {
            extract_main_content: false,
            ..HtmlFilesOptions::default()
        }
    }

    #[test]
    fn pages_titles_folders_images_and_links() {
        let files = vec![
            ("site/index.html".to_string(), b"<html><head><title>Home Page</title></head><body><h1 id=\"top\">Welcome</h1><p>See <a href=\"docs/guide.html#install-step\">the guide</a> and <a href=\"#top\">top</a>.</p><p><img src=\"img/photo%201.png\" alt=\"Photo\"><img src=\"img/icon.png\"><img src=\"https://example.com/remote.png\"></p><script>alert(1)</script></body></html>".to_vec()),
            ("site/docs/guide.html".to_string(), b"<html><head><title>Guide.html</title></head><body><h2 id=\"install-step\">Install it</h2><p>Back <a href=\"../index.html\">Home Page</a>, <a href=\"/index.html\">root</a></p><img src=\"/img/photo 1.png\"></body></html>".to_vec()),
            ("site/img/photo 1.png".to_string(), png(200, 100)),
            ("site/img/icon.png".to_string(), png(16, 16)),
        ];
        let r = convert(&files, &opts());
        let mut paths = r.paths();
        paths.sort();
        assert_eq!(paths, vec!["attachments/photo 1.png", "site/Home Page.md", "site/docs/Guide.md"]);
        let home = r.text("site/Home Page.md");
        assert!(home.contains("# Welcome"), "{home}");
        assert!(home.contains("[[Guide#Install it|the guide]]"), "{home}");
        assert!(home.contains("[[#Welcome|top]]"), "{home}");
        assert!(home.contains("![[photo 1.png]]"), "{home}");
        assert!(!home.contains("icon.png"), "{home}");
        assert!(home.contains("https://example.com/remote.png"), "{home}");
        assert!(!home.contains("alert"), "{home}");
        let guide = r.text("site/docs/Guide.md");
        assert!(guide.contains("[[Home Page]]") && guide.contains("[[Home Page|root]]"), "{guide}");
        assert!(guide.contains("![[photo 1.png]]"), "{guide}");
        assert_eq!(r.files.iter().filter(|f| f.path.starts_with("attachments/")).count(), 1);
    }

    #[test]
    fn size_limits_missing_files_and_extensionless_images() {
        let files = vec![
            ("page.htm".to_string(), b"<title></title><p><img src=\"big.png\"><img src=\"noext\"><img src=\"missing.png\"><video src=\"clip\"></video></p>".to_vec()),
            ("big.png".to_string(), { let mut v = png(100, 100); v.resize(5000, 0); v }),
            ("noext".to_string(), png(100, 100)),
            ("clip".to_string(), vec![0u8; 10]),
        ];
        let r = convert(&files, &HtmlFilesOptions { attachment_size_limit: 1000, ..opts() });
        let t = r.text("page.md");
        assert!(t.contains("![[noext.png]]") && t.contains("![[clip.mp4]]"), "{t}");
        assert!(!t.contains("big.png"), "{t}");
        assert!(r.warnings.iter().any(|w| w.contains("missing.png")), "{:?}", r.warnings);
        assert!(r.warnings.iter().any(|w| w.contains("size limit")), "{:?}", r.warnings);
    }

    #[test]
    fn duplicate_titles_and_zip_input() {
        let mut z = crate::zip::ZipWriter::new();
        z.add_text("a.html", "<title>Same</title><p>one</p>");
        z.add_text("b.html", "<title>same</title><p>two</p>");
        let r = convert(&[("pages.zip".into(), z.finish())], &opts());
        assert_eq!(r.paths(), vec!["Same.md", "same 1.md"]);
        assert!(r.text("same 1.md").contains("two"));
    }
}
