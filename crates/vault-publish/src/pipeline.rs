//! Rendering one note into page HTML: `vault_ofm::render`, then a single pass
//! over its output that resolves links, inlines embeds, adds heading ids,
//! callout icons, MathJax delimiters and Mermaid blocks, and removes scripts
//! and event handlers from raw HTML.

use std::collections::{BTreeSet, HashMap};

use serde_json::{Map, Value};
use vault_index::{FileEntry, VaultIndex};
use vault_ofm::{parse_linktext, resolve_subpath, RenderOptions, SubpathResult};

use crate::assets::icons;
use crate::html::{esc, parse_tag, Tag};
use crate::input::{base64_encode, InputFile};
use crate::paths::{self, media_kind, rel_href, MediaKind};

/// The files of one export, indexed.
pub(crate) struct Vault {
    pub index: VaultIndex,
    pub bytes: HashMap<String, Vec<u8>>,
    pub times: HashMap<String, (f64, f64)>,
}

/// Paths an exporter never reads, as Obsidian hides them.
pub(crate) fn is_ignored(path: &str) -> bool {
    path.split('/').any(|s| s == ".obsidian" || s == ".trash" || s == ".git") || path.is_empty()
}

impl Vault {
    pub fn build(files: &[InputFile]) -> Vault {
        let mut index = VaultIndex::new();
        let mut bytes = HashMap::new();
        let mut times = HashMap::new();
        for f in files {
            let path = f.path.trim_start_matches('/').to_string();
            if is_ignored(&path) {
                continue;
            }
            times.insert(path.clone(), (f.mtime, f.ctime));
            if paths::is_note(&path) {
                let text = match (&f.text, &f.bytes) {
                    (Some(t), _) => t.clone(),
                    (None, Some(b)) => String::from_utf8_lossy(&b.0).into_owned(),
                    (None, None) => String::new(),
                };
                index.upsert_file(FileEntry { path: path.clone(), size: text.len() as u64, ctime: f.ctime, mtime: f.mtime });
                let meta = vault_ofm::parse(&text);
                index.set_note(&path, text, meta);
            } else {
                let data = match (&f.bytes, &f.text) {
                    (Some(b), _) => Some(b.0.clone()),
                    (None, Some(t)) => Some(t.as_bytes().to_vec()),
                    _ => None,
                };
                let size = data.as_ref().map(|d| d.len() as u64).unwrap_or(0);
                index.upsert_file(FileEntry { path: path.clone(), size, ctime: f.ctime, mtime: f.mtime });
                if let Some(d) = data {
                    bytes.insert(path, d);
                }
            }
        }
        Vault { index, bytes, times }
    }

    pub fn frontmatter(&self, path: &str) -> Option<&Map<String, Value>> {
        self.index.note(path).and_then(|n| n.meta.frontmatter.as_ref())
    }

    pub fn mtime(&self, path: &str) -> f64 {
        self.times.get(path).map(|t| t.0).unwrap_or(0.0)
    }

    /// Resolves a link path (no subpath) from `source`; an empty path is the
    /// source itself.
    pub fn resolve(&self, linkpath: &str, source: &str) -> Option<String> {
        if linkpath.is_empty() {
            return Some(source.to_string());
        }
        self.index.resolve_link(linkpath, source)
    }
}

/// How hrefs are produced for the page being written.
pub(crate) enum Mode<'a> {
    /// Standalone document: attachments become data URIs; notes listed in
    /// `pages` become relative `.html` links.
    Note { pages: &'a HashMap<String, String> },
    /// Static site: every published note and copied attachment has a path.
    Site { pages: &'a HashMap<String, String>, attachments: &'a HashMap<String, String> },
}

pub(crate) struct Ctx<'a> {
    pub vault: &'a Vault,
    pub mode: Mode<'a>,
    /// Output path of the page being written.
    pub page: String,
    /// Vault path of the page's note.
    pub note: String,
    pub strict_line_breaks: bool,
    pub embed_depth: u32,
}

#[derive(Default)]
pub(crate) struct PageState {
    pub has_math: bool,
    pub has_mermaid: bool,
    pub has_callout: bool,
    /// `(level, text, id)` of the page's own headings.
    pub toc: Vec<(u8, String, String)>,
    ids: HashMap<String, u32>,
    /// Attachments the page references.
    pub attachments: BTreeSet<String>,
    embed_stack: Vec<String>,
    last_callout: String,
}

impl PageState {
    fn unique_id(&mut self, base: &str) -> String {
        let n = self.ids.entry(base.to_string()).or_insert(0);
        *n += 1;
        if *n == 1 {
            base.to_string()
        } else {
            format!("{base}-{}", *n - 1)
        }
    }
}

impl<'a> Ctx<'a> {
    fn note_href(&self, target: &str) -> Option<String> {
        let pages = match &self.mode {
            Mode::Note { pages } | Mode::Site { pages, .. } => pages,
        };
        pages.get(target).map(|out| rel_href(&self.page, out))
    }

    /// `src` for an attachment, or `None` when it is not part of the export.
    fn attachment_src(&self, target: &str) -> Option<String> {
        match &self.mode {
            Mode::Note { .. } => self
                .vault
                .bytes
                .get(target)
                .map(|b| format!("data:{};base64,{}", paths::mime(target), base64_encode(b))),
            Mode::Site { attachments, .. } => attachments.get(target).map(|out| rel_href(&self.page, out)),
        }
    }

    fn tag_href(&self, tag: &str) -> Option<String> {
        match &self.mode {
            Mode::Note { .. } => None,
            Mode::Site { .. } => Some(rel_href(&self.page, &paths::tag_page(tag))),
        }
    }

    fn render(&self, text: &str) -> vault_ofm::Rendered {
        vault_ofm::render(text, &RenderOptions { strict_line_breaks: self.strict_line_breaks })
    }
}

/// The fragment (`#id`) a link subpath points at in `target`, matching the
/// ids [`render_note`] gives headings and blocks.
pub(crate) fn subpath_anchor(vault: &Vault, target: &str, subpath: &str) -> String {
    if subpath.is_empty() {
        return String::new();
    }
    let Some(note) = vault.index.note(target) else {
        return String::new();
    };
    match resolve_subpath(&note.meta, subpath) {
        Some(SubpathResult::Heading { current, .. }) => {
            let id = paths::heading_id(&current.heading);
            let before = note
                .meta
                .headings
                .iter()
                .flatten()
                .take_while(|h| h.position.start.offset < current.position.start.offset)
                .filter(|h| paths::heading_id(&h.heading) == id)
                .count();
            let id = if before == 0 { id } else { format!("{id}-{before}") };
            format!("#{}", paths::encode_segment(&id))
        }
        Some(SubpathResult::Block { block, .. }) => format!("#{}", paths::encode_segment(&format!("^{}", block.id))),
        Some(SubpathResult::Footnote { footnote, .. }) => format!("#fn-{}", paths::encode_segment(&footnote.id)),
        None => String::new(),
    }
}

/// The note's body HTML (frontmatter excluded) with everything resolved.
/// Also returns the renderer's raw text (for search and descriptions).
pub(crate) fn render_note(ctx: &Ctx, st: &mut PageState) -> (String, String) {
    let vault = ctx.vault;
    let note = vault.index.note(&ctx.note);
    let text = note.map(|n| n.text.as_str()).unwrap_or("");
    let rendered = ctx.render(text);
    let blocks: Vec<(u32, String)> = note
        .and_then(|n| n.meta.blocks.as_ref())
        .map(|b| b.values().map(|b| (b.position.start.line, b.id.clone())).collect())
        .unwrap_or_default();
    let mut out = String::new();
    let mut plain = String::new();
    st.embed_stack.push(ctx.note.clone());
    for section in &rendered.sections {
        if section.kind == "yaml" || section.html.is_empty() {
            continue;
        }
        plain.push_str(&crate::html::strip_tags(&section.html));
        plain.push(' ');
        let html = process(ctx, &section.html, &ctx.note, st, 0, false);
        let ids: Vec<&String> =
            blocks.iter().filter(|(l, _)| *l >= section.line_start && *l <= section.line_end).map(|(_, id)| id).collect();
        let class = format!("el-{}", section.kind);
        match ids.first() {
            Some(id) => out.push_str(&format!("<div class=\"{class}\" id=\"^{}\">", esc(id))),
            None => out.push_str(&format!("<div class=\"{class}\">")),
        }
        out.push_str(&html);
        out.push_str("</div>\n");
    }
    st.embed_stack.pop();
    (out, plain.trim_end().to_string())
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let h = hay.as_bytes();
    let n = needle.as_bytes();
    if n.len() > h.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// One pass over rendered HTML. `source` is the note the HTML came from
/// (links resolve relative to it); `depth` counts embed nesting.
fn process(ctx: &Ctx, html: &str, source: &str, st: &mut PageState, depth: u32, in_embed: bool) -> String {
    let mut out = String::with_capacity(html.len() + html.len() / 4);
    let mut i = 0;
    // Whether a <p> is open: a note embed (a block) closes and reopens it.
    let mut in_p = false;
    while let Some(off) = html[i..].find('<') {
        let at = i + off;
        out.push_str(&html[i..at]);
        let rest = &html[at..];
        if rest.starts_with("<!--") {
            let end = rest.find("-->").map(|e| e + 3).unwrap_or(rest.len());
            out.push_str(&rest[..end]);
            i = at + end;
            continue;
        }
        let Some(mut tag) = parse_tag(rest) else {
            out.push('<');
            i = at + 1;
            continue;
        };
        let raw = &rest[..tag.len];
        let mut next = at + tag.len;
        if tag.closing {
            if tag.name == "p" {
                in_p = false;
            }
            out.push_str(raw);
            i = next;
            continue;
        }
        match tag.name.as_str() {
            "script" => {
                let end = find_ci(&html[next..], "</script>").map(|e| next + e + 9).unwrap_or(html.len());
                i = end;
                continue;
            }
            "p" if tag.attrs.iter().all(|(n, _)| n == "dir") && html[next..].starts_with("<span class=\"internal-embed\"") => {
                // A paragraph holding only a note embed: emit the embed as a
                // block (a <div> cannot live inside a <p>).
                if let Some(span) = parse_tag(&html[next..]) {
                    let after = next + span.len;
                    if let Some(close) = html[after..].find("</span>") {
                        let tail = after + close + 7;
                        if html[tail..].starts_with("</p>") && embed_is_note(ctx, &span, source) {
                            out.push_str(&embed(ctx, &span, source, st, depth, true));
                            i = tail + 4;
                            continue;
                        }
                    }
                }
                in_p = true;
                out.push_str(raw);
            }
            "p" => {
                in_p = true;
                out.push_str(raw);
            }
            "span" if tag.has_class("internal-embed") => {
                if let Some(close) = html[next..].find("</span>") {
                    next += close + 7;
                }
                if in_p && embed_is_note(ctx, &tag, source) {
                    out.push_str("</p>");
                    out.push_str(&embed(ctx, &tag, source, st, depth, true));
                    out.push_str("<p dir=\"auto\">");
                } else {
                    out.push_str(&embed(ctx, &tag, source, st, depth, false));
                }
            }
            "a" if tag.has_class("internal-link") => {
                let data_href = tag.attr("data-href").or(tag.attr("href")).unwrap_or("").to_string();
                let (linkpath, subpath) = parse_linktext(&data_href);
                let href = ctx.vault.resolve(&linkpath, source).and_then(|target| {
                    if paths::is_note(&target) {
                        let anchor = subpath_anchor(ctx.vault, &target, &subpath);
                        if target == ctx.note && !anchor.is_empty() {
                            Some(anchor)
                        } else {
                            ctx.note_href(&target).map(|h| h + &anchor)
                        }
                    } else {
                        let src = ctx.attachment_src(&target);
                        if src.is_some() {
                            st.attachments.insert(target);
                        }
                        src
                    }
                });
                tag.remove_attr("target");
                tag.remove_attr("rel");
                match href {
                    Some(h) => tag.set_attr("href", Some(&h)),
                    None => {
                        tag.remove_attr("href");
                        tag.set_attr("class", Some("internal-link is-unresolved"));
                    }
                }
                out.push_str(&tag.to_html());
            }
            "a" if tag.has_class("tag") => {
                let t = tag.attr("href").unwrap_or("").to_string();
                tag.remove_attr("target");
                tag.remove_attr("rel");
                match ctx.tag_href(&t) {
                    Some(h) => tag.set_attr("href", Some(&h)),
                    None => tag.remove_attr("href"),
                }
                out.push_str(&tag.to_html());
            }
            "a" if tag.has_class("footnote-link") || tag.has_class("footnote-backref") => {
                tag.remove_attr("target");
                tag.remove_attr("rel");
                out.push_str(&tag.to_html());
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" if tag.attr("data-heading").is_some() => {
                if !in_embed {
                    let text = tag.attr("data-heading").unwrap_or("").to_string();
                    let id = st.unique_id(&paths::heading_id(&text));
                    tag.set_attr("id", Some(&id));
                    st.toc.push((tag.name.as_bytes()[1] - b'0', text, id));
                }
                out.push_str(&tag.to_html());
            }
            "div" if tag.attr("data-callout").is_some() => {
                st.has_callout = true;
                st.last_callout = tag.attr("data-callout").unwrap_or("").to_string();
                out.push_str(raw);
            }
            "div" if tag.has_class("callout-icon") => {
                out.push_str(raw);
                out.push_str(&icons::svg(icons::callout_icon(&st.last_callout)));
            }
            "div" if tag.has_class("callout-fold") => {
                out.push_str(raw);
                out.push_str(&icons::svg("chevron-down"));
            }
            "span" | "div" if tag.has_class("math") => {
                st.has_math = true;
                let (open, close, end_tag) =
                    if tag.name == "span" { ("\\(", "\\)", "</span>") } else { ("\\[", "\\]", "</div>") };
                out.push_str(raw);
                out.push_str(open);
                match html[next..].find(end_tag) {
                    Some(e) => {
                        out.push_str(&html[next..next + e]);
                        out.push_str(close);
                        out.push_str(end_tag);
                        next += e + end_tag.len();
                    }
                    None => out.push_str(close),
                }
            }
            "pre" if tag.has_class("language-mermaid") => {
                st.has_mermaid = true;
                let body_start = parse_tag(&html[next..]).filter(|t| t.name == "code").map(|t| next + t.len).unwrap_or(next);
                match html[body_start..].find("</code></pre>") {
                    Some(e) => {
                        out.push_str("<pre class=\"mermaid\">");
                        out.push_str(&html[body_start..body_start + e]);
                        out.push_str("</pre>");
                        next = body_start + e + 13;
                    }
                    None => out.push_str(raw),
                }
            }
            "input" if tag.has_class("task-list-item-checkbox") => {
                tag.set_attr("disabled", None);
                out.push_str(&tag.to_html());
            }
            _ if tag.is_unsafe() => {
                tag.sanitize();
                out.push_str(&tag.to_html());
            }
            _ => out.push_str(raw),
        }
        i = next;
    }
    out.push_str(&html[i..]);
    out
}

fn embed_is_note(ctx: &Ctx, span: &Tag, source: &str) -> bool {
    let (linkpath, _) = parse_linktext(span.attr("src").unwrap_or(""));
    ctx.vault.resolve(&linkpath, source).map(|t| paths::is_note(&t)).unwrap_or(false)
}

/// `100` or `100x80` in an embed's alt: the size syntax of Embed files.md.
fn parse_size(alt: &str) -> Option<(u32, Option<u32>)> {
    let (w, h) = match alt.split_once('x') {
        Some((w, h)) => (w.trim(), Some(h.trim())),
        None => (alt.trim(), None),
    };
    let w: u32 = w.parse().ok()?;
    match h {
        Some(h) => Some((w, Some(h.parse().ok()?))),
        None => Some((w, None)),
    }
}

fn embed(ctx: &Ctx, span: &Tag, source: &str, st: &mut PageState, depth: u32, block: bool) -> String {
    let src = span.attr("src").unwrap_or("").to_string();
    let alt = span.attr("alt").unwrap_or("").to_string();
    let (linkpath, subpath) = parse_linktext(&src);
    let Some(target) = ctx.vault.resolve(&linkpath, source) else {
        return format!("<span class=\"internal-embed is-unresolved\">{}</span>", esc(&src));
    };
    if paths::is_note(&target) {
        return note_embed(ctx, &target, &subpath, &src, st, depth, block);
    }
    let name = paths::basename(&target);
    let Some(url) = ctx.attachment_src(&target) else {
        return format!("<span class=\"internal-embed is-unresolved\">{}</span>", esc(name));
    };
    st.attachments.insert(target.clone());
    let url = esc(&url);
    match media_kind(&target) {
        MediaKind::Image => {
            let (size, alt_text) = match parse_size(&alt) {
                Some(s) => (Some(s), name.to_string()),
                None if alt.is_empty() || alt == src => (None, name.to_string()),
                None => (None, alt.clone()),
            };
            let mut dims = String::new();
            if let Some((w, h)) = size {
                dims.push_str(&format!(" width=\"{w}\""));
                if let Some(h) = h {
                    dims.push_str(&format!(" height=\"{h}\""));
                }
            }
            format!(
                "<span class=\"internal-embed media-embed image-embed is-loaded\"><img src=\"{url}\" alt=\"{}\"{dims} loading=\"lazy\"></span>",
                esc(&alt_text)
            )
        }
        MediaKind::Audio => format!("<span class=\"internal-embed media-embed audio-embed is-loaded\"><audio controls src=\"{url}\"></audio></span>"),
        MediaKind::Video => format!("<span class=\"internal-embed media-embed video-embed is-loaded\"><video controls src=\"{url}\"></video></span>"),
        MediaKind::Pdf if matches!(ctx.mode, Mode::Site { .. }) => {
            format!("<span class=\"internal-embed pdf-embed is-loaded\"><iframe src=\"{url}\" title=\"{}\"></iframe></span>", esc(name))
        }
        _ => format!("<a class=\"internal-link\" href=\"{url}\">{}</a>", esc(name)),
    }
}

fn note_embed(ctx: &Ctx, target: &str, subpath: &str, src: &str, st: &mut PageState, depth: u32, block: bool) -> String {
    let vault = ctx.vault;
    let title = paths::note_title(target);
    let anchor = subpath_anchor(vault, target, subpath);
    let href = if target == ctx.note && !anchor.is_empty() { Some(anchor.clone()) } else { ctx.note_href(target).map(|h| h + &anchor) };
    let link = |label: &str| match &href {
        Some(h) => format!("<a class=\"internal-link\" href=\"{}\">{}</a>", esc(h), esc(label)),
        None => format!("<span class=\"internal-link is-unresolved\">{}</span>", esc(label)),
    };
    let key = format!("{target}{subpath}");
    if depth >= ctx.embed_depth || st.embed_stack.iter().any(|k| k == &key || (k == target && subpath.is_empty())) {
        return link(&vault_ofm::display_text(src));
    }
    let Some(note) = vault.index.note(target) else {
        return link(&title);
    };
    let text = note.text.as_str();
    let slice = if subpath.is_empty() {
        &text[vault_ofm::parse_frontmatter(text).body_start_byte.min(text.len())..]
    } else {
        let range = match resolve_subpath(&note.meta, subpath) {
            Some(SubpathResult::Heading { start, end, .. })
            | Some(SubpathResult::Block { start, end, .. })
            | Some(SubpathResult::Footnote { start, end, .. }) => Some((start, end)),
            None => None,
        };
        match range {
            Some((start, end)) => {
                let a = note.byte(start.offset);
                let b = end.map(|e| note.byte(e.offset)).unwrap_or(text.len());
                &text[a.min(b)..b]
            }
            None => return format!("<span class=\"internal-embed is-unresolved\">{}</span>", esc(src)),
        }
    };
    st.embed_stack.push(key);
    let rendered = ctx.render(slice);
    let mut inner = String::new();
    for s in &rendered.sections {
        if s.kind != "yaml" {
            inner.push_str(&process(ctx, &s.html, target, st, depth + 1, true));
        }
    }
    st.embed_stack.pop();
    let open_link = match &href {
        Some(h) => format!(
            "<a class=\"markdown-embed-link\" href=\"{}\" aria-label=\"Open {}\">{}</a>",
            esc(h),
            esc(&title),
            icons::svg("link")
        ),
        None => String::new(),
    };
    let tag = if block { "div" } else { "span" };
    format!(
        "<{tag} class=\"internal-embed markdown-embed inline-embed is-loaded\" data-src=\"{}\">{open_link}<{tag} class=\"markdown-embed-content\">{inner}</{tag}></{tag}>",
        esc(src)
    )
}

/// Frontmatter as a properties table.
pub(crate) fn properties_table(fm: &Map<String, Value>, hidden: &[&str]) -> String {
    let rows: Vec<String> = fm
        .iter()
        .filter(|(k, _)| !hidden.contains(&k.as_str()))
        .map(|(k, v)| {
            let value = match v {
                Value::Array(items) => items
                    .iter()
                    .map(|i| format!("<span class=\"multi-select-pill\">{}</span>", esc(&value_text(i))))
                    .collect::<Vec<_>>()
                    .join(" "),
                Value::Bool(b) => format!("<input type=\"checkbox\" disabled{}>", if *b { " checked" } else { "" }),
                other => esc(&value_text(other)),
            };
            format!("<tr class=\"metadata-property\" data-property-key=\"{}\"><th>{}</th><td>{value}</td></tr>", esc(k), esc(k))
        })
        .collect();
    if rows.is_empty() {
        return String::new();
    }
    format!("<table class=\"metadata-properties\"><tbody>{}</tbody></table>\n", rows.join(""))
}

pub(crate) fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Array(a) => a.iter().map(value_text).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}
