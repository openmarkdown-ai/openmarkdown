//! A vault → a static website shaped like an Obsidian Publish site.
//!
//! Generated files (all paths site-root relative):
//!
//! | Path | Contents |
//! |---|---|
//! | `index.html` | the home note, or a list of every page |
//! | `<Folder>/<Note>.html` | one page per published note (see [`crate::paths`]) |
//! | `tags/index.html`, `tags/<tag>.html` | tag index and one page per tag (nested tags nest) |
//! | `graph.html`, `graph.json` | global graph page and its data (positions precomputed) |
//! | `search-index.json` | title, path, aliases, headings, tags and text per page |
//! | `assets/site.css`, `assets/site.js` | styles and runtime |
//! | `sitemap.xml`, `rss.xml` | absolute URLs when `baseUrl` is set |
//! | `404.html` | not-found page (links rooted at `baseUrl`, or `/`) |
//! | `robots.txt` | only with `noindex` |
//! | `publish.css`, favicons, attachments | copied from the vault |
//!
//! Redirect pages (`<meta http-equiv="refresh">`) are written at a note's
//! default path when a `permalink` moves it, and at the path of every alias
//! that contains a `/` (Permalinks.md: "Redirect old notes").

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde_json::{json, Value};
use vault_index::{ForceLayout, ForceParams, GraphOptions};

use crate::assets::{self, icons};
use crate::html::esc;
use crate::input::{SiteExportInput, SiteFile, SiteOptions};
use crate::paths::{self, encode_path, rel_href, root_prefix};
use crate::pipeline::{properties_table, render_note, value_text, Ctx, Mode, PageState, Vault};

const RESERVED_FILES: &[&str] =
    &["index.html", "graph.html", "404.html", "graph.json", "search-index.json", "sitemap.xml", "rss.xml", "robots.txt"];
const RESERVED_DIRS: &[&str] = &["assets", "tags"];
/// Frontmatter keys that configure publishing rather than describe the note.
const PUBLISH_KEYS: &[&str] = &["publish", "permalink", "aliases", "alias", "cssclasses", "cssclass", "description", "image", "cover"];

fn in_folder(path: &str, folder: &str) -> bool {
    let f = folder.trim_matches('/');
    f.is_empty() || path == f || path.starts_with(&format!("{f}/"))
}

fn publish_flag(v: Option<&Value>) -> Option<bool> {
    match v? {
        Value::Bool(b) => Some(*b),
        Value::String(s) if s.trim().eq_ignore_ascii_case("true") => Some(true),
        Value::String(s) if s.trim().eq_ignore_ascii_case("false") => Some(false),
        _ => None,
    }
}

/// Which notes a site publishes: `publish: false` never, `publish: true`
/// always, otherwise the include/exclude folder filters decide.
pub(crate) fn select_notes(vault: &Vault, opts: &SiteOptions) -> Vec<String> {
    vault
        .index
        .note_paths()
        .into_iter()
        .filter(|path| {
            match publish_flag(vault.frontmatter(path).and_then(|f| f.get("publish"))) {
                Some(flag) => return flag,
                None => {}
            }
            let included = opts.include.iter().all(|f| f.trim().is_empty()) || opts.include.iter().any(|f| !f.trim().is_empty() && in_folder(path, f));
            let excluded = opts.exclude.iter().any(|f| !f.trim().is_empty() && in_folder(path, f));
            included && !excluded
        })
        .map(str::to_string)
        .collect()
}

struct Page {
    note: String,
    out: String,
    title: String,
}

struct Site<'a> {
    opts: &'a SiteOptions,
    page_of: HashMap<String, String>,
    attachments: HashMap<String, String>,
    site_name: String,
    publish_css: bool,
    favicon: Option<String>,
    nav: Vec<NavNode>,
}

enum NavNode {
    Folder { name: String, path: String, children: Vec<NavNode> },
    Page { title: String, note: String },
}

fn natural_key(s: &str) -> String {
    s.to_lowercase()
}

fn build_nav(notes: &[&Page], opts: &SiteOptions) -> Vec<NavNode> {
    #[derive(Default)]
    struct Dir {
        dirs: BTreeMap<String, Dir>,
        files: Vec<(String, String)>,
    }
    let hidden: HashSet<String> = opts.nav_hidden.iter().map(|h| h.trim_matches('/').to_string()).collect();
    let mut root = Dir::default();
    'outer: for p in notes {
        let segs: Vec<&str> = p.note.split('/').collect();
        let mut prefix = String::new();
        for s in &segs[..segs.len() - 1] {
            prefix = if prefix.is_empty() { s.to_string() } else { format!("{prefix}/{s}") };
            if hidden.contains(&prefix) {
                continue 'outer;
            }
        }
        if hidden.contains(&p.note) || hidden.contains(paths::strip_md(&p.note)) {
            continue;
        }
        let mut d = &mut root;
        for s in &segs[..segs.len() - 1] {
            d = d.dirs.entry(s.to_string()).or_default();
        }
        d.files.push((p.title.clone(), p.note.clone()));
    }
    let order: HashMap<String, usize> = opts
        .nav_order
        .iter()
        .enumerate()
        .map(|(i, p)| (paths::strip_md(p.trim_matches('/')).to_string(), i))
        .collect();
    fn convert(d: Dir, prefix: &str, order: &HashMap<String, usize>) -> Vec<NavNode> {
        let mut items: Vec<(Option<usize>, u8, String, NavNode)> = Vec::new();
        for (name, sub) in d.dirs {
            let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let children = convert(sub, &path, order);
            items.push((order.get(&path).copied(), 0, natural_key(&name), NavNode::Folder { name, path, children }));
        }
        for (title, note) in d.files {
            let key = paths::strip_md(&note).to_string();
            items.push((order.get(&key).copied(), 1, natural_key(&title), NavNode::Page { title, note }));
        }
        items.sort_by(|a, b| match (a.0, b.0) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.1.cmp(&b.1).then_with(|| vault_index::util::natural_cmp(&a.2, &b.2)),
        });
        items.into_iter().map(|i| i.3).collect()
    }
    convert(root, "", &order)
}

fn json_script(v: &Value) -> String {
    v.to_string().replace("</", "<\\/")
}

fn layout_positions(n: usize, edges: &[(u32, u32)], params: ForceParams) -> Vec<f32> {
    if n == 0 {
        return Vec::new();
    }
    let mut layout = ForceLayout::new(n, edges, params);
    let ticks = if n > 5000 { 80 } else if n > 1500 { 150 } else { 300 };
    layout.step(ticks);
    layout.positions().to_vec()
}

impl<'a> Site<'a> {
    fn root_url(&self) -> String {
        let b = self.opts.base_url.trim();
        if b.is_empty() {
            String::new()
        } else if b.ends_with('/') {
            b.to_string()
        } else {
            format!("{b}/")
        }
    }

    fn absolute(&self, out: &str) -> String {
        format!("{}{}", self.root_url(), encode_path(out))
    }

    fn nav_html(&self, current_note: Option<&str>, href: &dyn Fn(&str) -> String) -> String {
        fn walk(site: &Site, nodes: &[NavNode], current: Option<&str>, href: &dyn Fn(&str) -> String, out: &mut String, top: bool) {
            out.push_str(if top { "<ul class=\"nav-view\">" } else { "<ul class=\"tree-item-children\">" });
            for n in nodes {
                match n {
                    NavNode::Folder { name, path, children } => {
                        let open = current.map(|c| c.starts_with(&format!("{path}/"))).unwrap_or(false);
                        out.push_str(&format!(
                            "<li><details class=\"tree-item nav-folder\" data-path=\"{}\"{}><summary class=\"tree-item-self nav-folder-title\"><span class=\"nav-folder-collapse-indicator\">{}</span><span class=\"tree-item-inner\">{}</span></summary>",
                            esc(path),
                            if open { " open" } else { "" },
                            icons::svg("chevron-right"),
                            esc(name)
                        ));
                        walk(site, children, current, href, out, false);
                        out.push_str("</details></li>");
                    }
                    NavNode::Page { title, note } => {
                        let Some(target) = site.page_of.get(note) else { continue };
                        let active = current == Some(note.as_str());
                        out.push_str(&format!(
                            "<li class=\"tree-item nav-file\"><a class=\"tree-item-self nav-file-title{}\" href=\"{}\"{}><span class=\"tree-item-inner\">{}</span></a></li>",
                            if active { " is-active" } else { "" },
                            esc(&href(target)),
                            if active { " aria-current=\"page\"" } else { "" },
                            esc(title)
                        ));
                    }
                }
            }
            out.push_str("</ul>");
        }
        let mut out = String::new();
        walk(self, &self.nav, current_note, href, &mut out, true);
        out
    }

    fn theme_toggle(&self) -> String {
        if !self.opts.show_theme_toggle {
            return String::new();
        }
        format!(
            "<button class=\"clickable-icon theme-toggle\" aria-label=\"Toggle light and dark mode\" type=\"button\">{}{}</button>",
            icons::svg("sun"),
            icons::svg("moon")
        )
    }
}

struct Shell<'s> {
    /// Output path (for relative links); `None` for 404.html, whose links
    /// are rooted at the base URL.
    out: &'s str,
    rooted: bool,
    title: String,
    current_note: Option<&'s str>,
    head: String,
    center: String,
    right: String,
    mobile_right: String,
    body_class: String,
    has_math: bool,
    has_mermaid: bool,
    has_callout: bool,
}

fn shell(site: &Site, s: Shell) -> String {
    let opts = site.opts;
    let root = if s.rooted {
        let r = site.root_url();
        if r.is_empty() {
            "/".to_string()
        } else {
            r
        }
    } else {
        root_prefix(s.out)
    };
    let href = |target: &str| -> String {
        if s.rooted {
            format!("{root}{}", encode_path(target))
        } else {
            rel_href(s.out, target)
        }
    };
    let mut h = String::with_capacity(s.center.len() + 16_000);
    h.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    let full_title = if s.title.is_empty() || s.title == site.site_name {
        site.site_name.clone()
    } else if site.site_name.is_empty() {
        s.title.clone()
    } else {
        format!("{} - {}", s.title, site.site_name)
    };
    h.push_str(&format!("<title>{}</title>\n", esc(&full_title)));
    h.push_str("<meta name=\"generator\" content=\"vault-publish\">\n");
    if opts.noindex {
        h.push_str("<meta name=\"robots\" content=\"noindex\">\n");
    }
    h.push_str(&format!("<link rel=\"stylesheet\" href=\"{}\">\n", esc(&href("assets/site.css"))));
    if site.publish_css {
        h.push_str(&format!("<link rel=\"stylesheet\" href=\"{}\">\n", esc(&href("publish.css"))));
    }
    if let Some(f) = &site.favicon {
        h.push_str(&format!("<link rel=\"icon\" href=\"{}\">\n", esc(&href(f))));
    }
    h.push_str(&format!("<link rel=\"alternate\" type=\"application/rss+xml\" title=\"{}\" href=\"{}\">\n", esc(&site.site_name), esc(&href("rss.xml"))));
    h.push_str(&s.head);
    h.push_str("</head>\n");
    let theme = opts.theme.as_str();
    h.push_str(&format!(
        "<body class=\"{}\" data-root=\"{}\" data-default-theme=\"{theme}\"{}>\n",
        esc(s.body_class.trim()),
        esc(&root),
        if opts.hover_preview { " data-hover-preview" } else { "" }
    ));
    // Apply the theme before first paint.
    let stored = if opts.show_theme_toggle { "try{t=localStorage.getItem(\"vault-publish-theme\")}catch(e){}" } else { "" };
    h.push_str(&format!(
        "<script>(function(){{var t;{stored}t=t||\"{theme}\";var d=t===\"dark\"||(t!==\"light\"&&window.matchMedia&&matchMedia(\"(prefers-color-scheme: dark)\").matches);document.body.classList.add(d?\"theme-dark\":\"theme-light\")}})()</script>\n"
    ));
    h.push_str(icons::LICENSE_COMMENT);
    h.push('\n');
    h.push_str(&format!(
        "<div class=\"published-container{}\">\n",
        if opts.readable_line_length { " readable-line-width" } else { "" }
    ));
    let home_href = esc(&href("index.html"));
    let logo = site.opts.logo.as_deref().and_then(|l| site.attachments.get(l.trim_start_matches('/')).map(|o| href(o)));
    // Header (narrow screens).
    h.push_str("<header class=\"site-header\">");
    if opts.show_navigation {
        h.push_str(&format!("<button class=\"clickable-icon site-header-menu\" type=\"button\" aria-label=\"Open navigation\">{}</button>", icons::svg("menu")));
    }
    if let Some(l) = &logo {
        h.push_str(&format!("<a class=\"site-header-logo\" href=\"{home_href}\"><img src=\"{}\" alt=\"{}\"></a>", esc(l), esc(&site.site_name)));
    }
    h.push_str(&format!("<a class=\"site-header-text\" href=\"{home_href}\">{}</a>{}</header>\n", esc(&site.site_name), site.theme_toggle()));
    h.push_str("<div class=\"site-body\">\n");
    if opts.show_navigation || opts.search {
        h.push_str("<nav class=\"site-body-left-column\" aria-label=\"Site\">");
        if let Some(l) = &logo {
            h.push_str(&format!("<a class=\"site-body-left-column-site-logo\" href=\"{home_href}\"><img src=\"{}\" alt=\"{}\"></a>", esc(l), esc(&site.site_name)));
        }
        h.push_str(&format!("<a class=\"site-body-left-column-site-name\" href=\"{home_href}\">{}</a>", esc(&site.site_name)));
        h.push_str("<div class=\"left-column-top\">");
        if opts.search {
            h.push_str(&format!(
                "<div class=\"search-view-outer\"><label class=\"search-bar\">{}<input type=\"search\" placeholder=\"Search\" aria-label=\"Search\" autocomplete=\"off\" spellcheck=\"false\"></label><div class=\"search-results\" hidden></div></div>",
                icons::svg("search")
            ));
        }
        h.push_str(&site.theme_toggle());
        h.push_str("</div>");
        if opts.show_navigation {
            h.push_str("<div class=\"nav-view-outer\">");
            h.push_str(&site.nav_html(s.current_note, &href));
            h.push_str("</div>");
        }
        h.push_str("<div class=\"nav-extra\">");
        if opts.show_graph {
            h.push_str(&format!("<a class=\"tree-item-self\" href=\"{}\">{}<span>Graph view</span></a>", esc(&href("graph.html")), icons::svg("git-fork")));
        }
        h.push_str(&format!("<a class=\"tree-item-self\" href=\"{}\">#<span>Tags</span></a>", esc(&href("tags/index.html"))));
        h.push_str("</div></nav>\n");
    }
    h.push_str("<main class=\"site-body-center-column\"><div class=\"render-container\">\n");
    h.push_str(&s.center);
    if !s.mobile_right.is_empty() {
        h.push_str(&format!("<div class=\"mobile-right\">{}</div>", s.mobile_right));
    }
    h.push_str("</div></main>\n");
    if !s.right.is_empty() {
        h.push_str(&format!("<aside class=\"site-body-right-column\">{}</aside>\n", s.right));
    }
    h.push_str("</div>\n</div>\n");
    h.push_str(&format!("<script src=\"{}\"></script>\n", esc(&href("assets/site.js"))));
    if opts.cdn && s.has_math {
        h.push_str(&assets::mathjax_tags());
    }
    if opts.cdn && s.has_mermaid {
        h.push_str(&assets::mermaid_tags());
    }
    let _ = s.has_callout;
    h.push_str("</body>\n</html>\n");
    h
}

fn redirect_page(from: &str, to: &str) -> String {
    let href = esc(&rel_href(from, to));
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Redirecting…</title>\n<meta http-equiv=\"refresh\" content=\"0; url={href}\">\n<link rel=\"canonical\" href=\"{href}\">\n<meta name=\"robots\" content=\"noindex\">\n</head>\n<body><p>This page has moved to <a href=\"{href}\">{href}</a>.</p></body>\n</html>\n"
    )
}

fn file(path: &str, bytes: impl Into<Vec<u8>>) -> SiteFile {
    SiteFile { path: path.to_string(), bytes: bytes.into() }
}

fn truncate_chars(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

fn description_of(plain: &str) -> String {
    let t = plain.trim();
    if t.chars().count() <= 160 {
        return t.to_string();
    }
    let cut = truncate_chars(t, 157);
    let cut = match cut.rfind(' ') {
        Some(i) if i > 100 => cut[..i].to_string(),
        _ => cut,
    };
    format!("{cut}…")
}

pub fn export_site(input: &SiteExportInput) -> Vec<SiteFile> {
    let opts = &input.options;
    let vault = Vault::build(&input.files);
    let published = select_notes(&vault, opts);
    let published_set: HashSet<&str> = published.iter().map(|s| s.as_str()).collect();

    // ---- home ---------------------------------------------------------------
    let home = opts.home.as_deref().map(str::trim).filter(|h| !h.is_empty()).and_then(|h| {
        let h = h.trim_start_matches('/');
        [h.to_string(), format!("{h}.md")]
            .into_iter()
            .find(|p| vault.index.note(p).is_some())
            .or_else(|| vault.index.resolve_link(h, "").filter(|p| paths::is_note(p)))
    });
    let mut notes: Vec<String> = published.clone();
    if let Some(h) = &home {
        if !published_set.contains(h.as_str()) {
            notes.push(h.clone());
        }
    }

    // ---- output paths ---------------------------------------------------------
    let mut taken: HashSet<String> = RESERVED_FILES.iter().map(|s| s.to_string()).collect();
    let mut page_of: HashMap<String, String> = HashMap::new();
    let avoid_reserved = |p: String| -> String {
        let mut segs: Vec<String> = p.split('/').map(str::to_string).collect();
        if segs.len() > 1 && RESERVED_DIRS.contains(&segs[0].to_lowercase().as_str()) {
            segs[0] = format!("{}-folder", segs[0]);
        }
        segs.join("/")
    };
    let claim = |want: String, taken: &mut HashSet<String>| -> String {
        let stem = want.strip_suffix(".html").unwrap_or(&want).to_string();
        let mut candidate = want.clone();
        let mut n = 2;
        while taken.contains(&candidate.to_lowercase()) {
            candidate = format!("{stem}-{n}.html");
            n += 1;
        }
        taken.insert(candidate.to_lowercase());
        candidate
    };
    if let Some(h) = &home {
        taken.remove("index.html");
        let out = claim("index.html".into(), &mut taken);
        page_of.insert(h.clone(), out);
    }
    let permalink_of = |note: &str| -> Option<String> {
        let p = vault.frontmatter(note)?.get("permalink")?.as_str()?.trim().trim_matches('/').to_string();
        if p.is_empty() {
            return None;
        }
        let p = p.strip_suffix(".html").unwrap_or(&p);
        let segs: Vec<String> = p.split('/').filter(|s| !s.is_empty()).map(paths::slug_segment).collect();
        Some(format!("{}.html", segs.join("/")))
    };
    // Permalinks first so they win over default paths.
    for note in &notes {
        if page_of.contains_key(note) {
            continue;
        }
        if let Some(p) = permalink_of(note) {
            let p = avoid_reserved(p);
            if !taken.contains(&p.to_lowercase()) {
                let out = claim(p, &mut taken);
                page_of.insert(note.clone(), out);
            }
        }
    }
    for note in &notes {
        if !page_of.contains_key(note) {
            let out = claim(avoid_reserved(paths::page_path(note)), &mut taken);
            page_of.insert(note.clone(), out);
        }
    }
    let mut redirects: Vec<(String, String)> = Vec::new();
    for note in &notes {
        let out = &page_of[note];
        let default = avoid_reserved(paths::page_path(note));
        let mut sources = Vec::new();
        if &default != out {
            sources.push(default);
        }
        if let Some(fm) = vault.frontmatter(note) {
            for alias in vault_index::tags::frontmatter_aliases(Some(fm)).into_iter().chain(
                vault_index::tags::frontmatter_strings(fm, "alias").unwrap_or_default(),
            ) {
                if alias.contains('/') {
                    sources.push(avoid_reserved(paths::page_path(alias.trim_matches('/'))));
                }
            }
        }
        for src in sources {
            if !taken.contains(&src.to_lowercase()) {
                taken.insert(src.to_lowercase());
                redirects.push((src, out.clone()));
            }
        }
    }

    // ---- attachments ------------------------------------------------------------
    let mut attachments: HashMap<String, String> = HashMap::new();
    for path in vault.bytes.keys() {
        let lower = path.to_lowercase();
        let first = lower.split('/').next().unwrap_or("");
        let out = if taken.contains(&lower) || (lower.contains('/') && RESERVED_DIRS.contains(&first)) || (!lower.contains('/') && RESERVED_FILES.contains(&lower.as_str())) {
            format!("_attachments/{path}")
        } else {
            path.clone()
        };
        attachments.insert(path.clone(), out);
    }

    let mut pages: Vec<Page> = notes
        .iter()
        .map(|n| Page { note: n.clone(), out: page_of[n].clone(), title: paths::note_title(n) })
        .collect();
    pages.sort_by(|a, b| a.note.cmp(&b.note));
    let nav_pages: Vec<&Page> = pages.iter().collect();
    let nav = build_nav(&nav_pages, opts);

    let publish_css = opts.custom_css && vault.bytes.contains_key("publish.css");
    let favicon = ["favicon.ico", "favicon-32x32.png", "favicon-32.png", "favicon.png", "favicon.svg"]
        .iter()
        .find(|f| vault.bytes.contains_key(**f))
        .map(|f| attachments[*f].clone());
    let site_name = if opts.site_name.trim().is_empty() {
        home.as_deref().map(paths::note_title).unwrap_or_else(|| "Notes".into())
    } else {
        opts.site_name.trim().to_string()
    };
    let site = Site {
        opts,
        page_of: page_of.clone(),
        attachments: attachments.clone(),
        site_name,
        publish_css,
        favicon: favicon.clone(),
        nav,
    };
    let mut copy: BTreeSet<String> = BTreeSet::new();
    if let Some(l) = &opts.logo {
        let l = l.trim_start_matches('/');
        if vault.bytes.contains_key(l) {
            copy.insert(l.to_string());
        }
    }

    // ---- graph ----------------------------------------------------------------------
    let gd = vault.index.graph(&GraphOptions { hide_unresolved: true, show_orphans: true, ..Default::default() });
    let mut gidx: HashMap<String, usize> = HashMap::new();
    let mut gnodes: Vec<String> = Vec::new();
    for n in &gd.nodes {
        if page_of.contains_key(&n.id) && !gidx.contains_key(&n.id) {
            gidx.insert(n.id.clone(), gnodes.len());
            gnodes.push(n.id.clone());
        }
    }
    let mut gedges: Vec<(u32, u32)> = Vec::new();
    let mut seen_edges = HashSet::new();
    for l in &gd.links {
        let (Some(a), Some(b)) = (gd.nodes.get(l.source as usize), gd.nodes.get(l.target as usize)) else { continue };
        if let (Some(&x), Some(&y)) = (gidx.get(&a.id), gidx.get(&b.id)) {
            if x != y && seen_edges.insert((x.min(y), x.max(y))) {
                gedges.push((x as u32, y as u32));
            }
        }
    }
    let mut degree = vec![0u32; gnodes.len()];
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); gnodes.len()];
    for &(a, b) in &gedges {
        degree[a as usize] += 1;
        degree[b as usize] += 1;
        adjacency[a as usize].push(b as usize);
        adjacency[b as usize].push(a as usize);
    }
    let global_graph = if opts.show_graph {
        let pos = layout_positions(gnodes.len(), &gedges, ForceParams::default());
        let nodes: Vec<Value> = gnodes
            .iter()
            .enumerate()
            .map(|(i, id)| {
                json!({
                    "id": id,
                    "label": paths::note_title(id),
                    "url": encode_path(&page_of[id]),
                    "weight": degree[i],
                    "x": (pos[i * 2] * 10.0).round() / 10.0,
                    "y": (pos[i * 2 + 1] * 10.0).round() / 10.0,
                })
            })
            .collect();
        let links: Vec<Value> = gedges.iter().map(|&(a, b)| json!([a, b])).collect();
        Some(json!({ "nodes": nodes, "links": links }))
    } else {
        None
    };

    // ---- pages ------------------------------------------------------------------------
    let mut out_files: Vec<SiteFile> = Vec::new();
    let mut search_index: Vec<Value> = Vec::new();
    let mut tag_pages: BTreeMap<String, (String, BTreeSet<String>)> = BTreeMap::new();
    let mut plains: HashMap<String, String> = HashMap::new();
    for page in &pages {
        let ctx = Ctx {
            vault: &vault,
            mode: Mode::Site { pages: &page_of, attachments: &attachments },
            page: page.out.clone(),
            note: page.note.clone(),
            strict_line_breaks: opts.strict_line_breaks,
            embed_depth: opts.embed_depth,
        };
        let mut st = PageState::default();
        let (body, plain) = render_note(&ctx, &mut st);
        copy.extend(st.attachments.iter().cloned());
        let note = vault.index.note(&page.note);
        let meta = note.map(|n| &n.meta);
        let fm = meta.and_then(|m| m.frontmatter.as_ref());
        let aliases = vault_index::tags::frontmatter_aliases(fm);
        let css_classes: Vec<String> = fm
            .and_then(|f| vault_index::tags::frontmatter_strings(f, "cssclasses").or_else(|| vault_index::tags::frontmatter_strings(f, "cssclass")))
            .unwrap_or_default();
        let mut tags: Vec<String> = Vec::new();
        for t in meta.map(vault_index::tags::all_tags).unwrap_or_default() {
            if !tags.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
                tags.push(t);
            }
        }
        for t in &tags {
            let body = t.trim_start_matches('#');
            let mut prefix = String::new();
            for seg in body.split('/') {
                prefix = if prefix.is_empty() { seg.to_string() } else { format!("{prefix}/{seg}") };
                let entry = tag_pages.entry(prefix.to_lowercase()).or_insert_with(|| (format!("#{prefix}"), BTreeSet::new()));
                entry.1.insert(page.note.clone());
            }
        }

        // Head: description, OpenGraph.
        let description = fm
            .and_then(|f| f.get("description"))
            .map(value_text)
            .filter(|d| !d.trim().is_empty())
            .unwrap_or_else(|| description_of(&plain));
        let mut head = String::new();
        head.push_str(&format!("<meta name=\"description\" content=\"{}\">\n", esc(&description)));
        head.push_str(&format!("<meta property=\"og:title\" content=\"{}\">\n", esc(&page.title)));
        head.push_str(&format!("<meta property=\"og:description\" content=\"{}\">\n", esc(&description)));
        head.push_str("<meta property=\"og:type\" content=\"article\">\n");
        if !site.site_name.is_empty() {
            head.push_str(&format!("<meta property=\"og:site_name\" content=\"{}\">\n", esc(&site.site_name)));
        }
        if !site.root_url().is_empty() {
            let url = site.absolute(if page.out == "index.html" { "" } else { &page.out });
            head.push_str(&format!("<meta property=\"og:url\" content=\"{}\">\n<link rel=\"canonical\" href=\"{}\">\n", esc(&url), esc(&url)));
        }
        let image = fm.and_then(|f| f.get("image").or_else(|| f.get("cover"))).map(value_text).map(|s| {
            s.trim().trim_start_matches("![[").trim_start_matches("[[").trim_end_matches("]]").split('|').next().unwrap_or("").trim().to_string()
        });
        let mut has_image = false;
        if let Some(img) = image.filter(|s| !s.is_empty()) {
            let url = if img.contains("://") {
                Some(img)
            } else {
                let p = img.trim_start_matches('/');
                let resolved = if vault.bytes.contains_key(p) { Some(p.to_string()) } else { vault.index.resolve_link(p, &page.note) };
                resolved.filter(|r| attachments.contains_key(r)).map(|r| {
                    copy.insert(r.clone());
                    let out = &attachments[&r];
                    if site.root_url().is_empty() {
                        rel_href(&page.out, out)
                    } else {
                        site.absolute(out)
                    }
                })
            };
            if let Some(url) = url {
                has_image = true;
                head.push_str(&format!("<meta property=\"og:image\" content=\"{}\">\n", esc(&url)));
            }
        }
        head.push_str(&format!(
            "<meta name=\"twitter:card\" content=\"{}\">\n",
            if has_image { "summary_large_image" } else { "summary" }
        ));

        // Center column.
        let mut center = String::new();
        let folders: Vec<&str> = page.note.split('/').collect();
        if folders.len() > 1 {
            center.push_str("<div class=\"breadcrumbs\" aria-label=\"Breadcrumbs\">");
            for f in &folders[..folders.len() - 1] {
                center.push_str(&format!("<span class=\"breadcrumb\">{}</span>{}", esc(f), icons::svg("chevron-right")));
            }
            center.push_str(&format!("<span class=\"breadcrumb is-current\">{}</span></div>\n", esc(&page.title)));
        }
        let mut classes = vec!["markdown-preview-view".to_string(), "markdown-rendered".to_string()];
        classes.extend(css_classes.iter().cloned());
        center.push_str(&format!("<div class=\"{}\">\n", esc(&classes.join(" "))));
        if !opts.hide_title {
            center.push_str(&format!("<div class=\"page-header\"><h1 class=\"page-title\">{}</h1></div>\n", esc(&page.title)));
        }
        if opts.show_properties {
            if let Some(fm) = fm {
                center.push_str(&properties_table(fm, PUBLISH_KEYS));
            }
        }
        center.push_str(&body);
        center.push_str("</div>\n");
        if !tags.is_empty() {
            center.push_str("<div class=\"page-tags\">");
            for t in &tags {
                center.push_str(&format!("<a class=\"tag\" href=\"{}\">{}</a>", esc(&rel_href(&page.out, &paths::tag_page(t))), esc(t)));
            }
            center.push_str("</div>\n");
        }

        // Right column.
        let mut right = String::new();
        let mut mobile_right = String::new();
        if opts.show_graph {
            if let Some(&ci) = gidx.get(&page.note) {
                let mut members = vec![ci];
                for &n in &adjacency[ci] {
                    if !members.contains(&n) {
                        members.push(n);
                    }
                }
                let pos_of: HashMap<usize, usize> = members.iter().enumerate().map(|(i, &m)| (m, i)).collect();
                let mut ledges = Vec::new();
                for &(a, b) in &gedges {
                    if let (Some(&x), Some(&y)) = (pos_of.get(&(a as usize)), pos_of.get(&(b as usize))) {
                        ledges.push((x as u32, y as u32));
                    }
                }
                let params = ForceParams { link_distance: 120.0, ..Default::default() };
                let pos = layout_positions(members.len(), &ledges, params);
                let nodes: Vec<Value> = members
                    .iter()
                    .enumerate()
                    .map(|(i, &m)| {
                        json!({
                            "label": paths::note_title(&gnodes[m]),
                            "url": encode_path(&page_of[&gnodes[m]]),
                            "weight": degree[m],
                            "x": (pos[i * 2] * 10.0).round() / 10.0,
                            "y": (pos[i * 2 + 1] * 10.0).round() / 10.0,
                            "current": m == ci,
                        })
                    })
                    .collect();
                let data = json!({ "nodes": nodes, "links": ledges.iter().map(|&(a, b)| json!([a, b])).collect::<Vec<_>>() });
                right.push_str(&format!(
                    "<div class=\"right-column-section graph-view-outer\"><div class=\"right-column-title\">Interactive graph</div><a class=\"clickable-icon graph-expand\" href=\"{}\" aria-label=\"Open graph view\">{}</a><div class=\"graph-view-container\" data-local></div><script type=\"application/json\">{}</script></div>",
                    esc(&rel_href(&page.out, "graph.html")),
                    icons::svg("git-fork"),
                    json_script(&data)
                ));
            }
        }
        if opts.show_toc && !st.toc.is_empty() {
            let min = st.toc.iter().map(|t| t.0).min().unwrap_or(1);
            let mut toc = String::from("<div class=\"right-column-section outline-view-outer\"><div class=\"right-column-title\">On this page</div><ul>");
            for (level, text, id) in &st.toc {
                toc.push_str(&format!(
                    "<li><a class=\"depth-{}\" href=\"#{}\">{}</a></li>",
                    level - min + 1,
                    esc(&paths::encode_segment(id)),
                    esc(&crate::html::unescape(text))
                ));
            }
            toc.push_str("</ul></div>");
            right.push_str(&toc);
        }
        if opts.show_backlinks {
            let backlinks: Vec<_> =
                vault.index.backlinks(&page.note).into_iter().filter(|b| page_of.contains_key(&b.source)).collect();
            let mut bl = String::from("<div class=\"right-column-section backlinks\"><div class=\"right-column-title\">Links to this page</div>");
            if backlinks.is_empty() {
                bl.push_str("<div class=\"empty-state\">No backlinks found</div>");
            } else {
                bl.push_str("<ul>");
                for b in &backlinks {
                    let context = b.refs.iter().find_map(|r| r.context.as_ref()).map(|c| c.text.trim().to_string()).unwrap_or_default();
                    bl.push_str(&format!(
                        "<li><a class=\"backlink-item\" href=\"{}\">{}<span class=\"backlink-context\">{}</span></a></li>",
                        esc(&rel_href(&page.out, &page_of[&b.source])),
                        esc(&paths::note_title(&b.source)),
                        esc(&truncate_chars(&context, 140))
                    ));
                }
                bl.push_str("</ul>");
            }
            bl.push_str("</div>");
            right.push_str(&bl);
            mobile_right.push_str(&bl);
        }

        let html = shell(
            &site,
            Shell {
                out: &page.out,
                rooted: false,
                title: page.title.clone(),
                current_note: Some(&page.note),
                head,
                center,
                right,
                mobile_right,
                body_class: String::new(),
                has_math: st.has_math,
                has_mermaid: st.has_mermaid,
                has_callout: st.has_callout,
            },
        );
        out_files.push(file(&page.out, html));

        let headings: Vec<String> =
            meta.and_then(|m| m.headings.as_ref()).map(|h| h.iter().map(|h| h.heading.clone()).collect()).unwrap_or_default();
        search_index.push(json!({
            "u": encode_path(&page.out),
            "t": page.title,
            "p": paths::parent(&page.note),
            "a": aliases,
            "h": headings,
            "g": tags,
            "x": truncate_chars(&plain, 20_000),
        }));
        plains.insert(page.note.clone(), description);
    }

    // ---- index when there is no home note ----------------------------------------------------
    if home.is_none() {
        let mut center = format!("<div class=\"markdown-preview-view markdown-rendered\"><div class=\"page-header\"><h1 class=\"page-title\">{}</h1></div><ul class=\"page-list\">", esc(&site.site_name));
        for p in &pages {
            center.push_str(&format!("<li><a class=\"internal-link\" href=\"{}\">{}</a></li>", esc(&rel_href("index.html", &p.out)), esc(paths::strip_md(&p.note))));
        }
        center.push_str("</ul></div>");
        let html = shell(&site, Shell { out: "index.html", rooted: false, title: String::new(), current_note: None, head: String::new(), center, right: String::new(), mobile_right: String::new(), body_class: String::new(), has_math: false, has_mermaid: false, has_callout: false });
        out_files.push(file("index.html", html));
    }

    for (from, to) in &redirects {
        out_files.push(file(from, redirect_page(from, to)));
    }

    // ---- tags ------------------------------------------------------------------------------
    let title_of = |note: &str| paths::note_title(note);
    for (key, (display, members)) in &tag_pages {
        let out = paths::tag_page(key);
        let mut center = format!("<div class=\"markdown-preview-view markdown-rendered tag-page\"><div class=\"page-header\"><h1 class=\"page-title\">{}</h1></div>", esc(display));
        let children: Vec<(&String, &(String, BTreeSet<String>))> = tag_pages
            .iter()
            .filter(|(k, _)| k.starts_with(&format!("{key}/")) && !k[key.len() + 1..].contains('/'))
            .collect();
        if !children.is_empty() {
            center.push_str("<p>");
            for (k, (d, m)) in children {
                center.push_str(&format!("<a class=\"tag\" href=\"{}\">{}</a><span class=\"tag-count\">{}</span> ", esc(&rel_href(&out, &paths::tag_page(k))), esc(d), m.len()));
            }
            center.push_str("</p>");
        }
        center.push_str(&format!("<p>{} {}</p><ul class=\"page-list\">", members.len(), if members.len() == 1 { "page" } else { "pages" }));
        let mut sorted: Vec<&String> = members.iter().collect();
        sorted.sort_by(|a, b| vault_index::util::natural_cmp(&title_of(a).to_lowercase(), &title_of(b).to_lowercase()));
        for m in sorted {
            center.push_str(&format!(
                "<li><a class=\"internal-link\" href=\"{}\">{}</a></li>",
                esc(&rel_href(&out, &page_of[m])),
                esc(&title_of(m))
            ));
        }
        center.push_str("</ul></div>");
        let html = shell(&site, Shell { out: &out, rooted: false, title: display.clone(), current_note: None, head: String::new(), center, right: String::new(), mobile_right: String::new(), body_class: String::new(), has_math: false, has_mermaid: false, has_callout: false });
        out_files.push(file(&out, html));
    }
    {
        let out = "tags/index.html";
        let mut center = String::from("<div class=\"markdown-preview-view markdown-rendered\"><div class=\"page-header\"><h1 class=\"page-title\">Tags</h1></div>");
        if tag_pages.is_empty() {
            center.push_str("<p class=\"empty-state\">No tags.</p>");
        } else {
            center.push_str("<ul class=\"tag-list\">");
            for (k, (d, m)) in &tag_pages {
                center.push_str(&format!("<li><a class=\"tag\" href=\"{}\">{}</a><span class=\"tag-count\">{}</span></li>", esc(&rel_href(out, &paths::tag_page(k))), esc(d), m.len()));
            }
            center.push_str("</ul>");
        }
        center.push_str("</div>");
        let html = shell(&site, Shell { out, rooted: false, title: "Tags".into(), current_note: None, head: String::new(), center, right: String::new(), mobile_right: String::new(), body_class: String::new(), has_math: false, has_mermaid: false, has_callout: false });
        out_files.push(file(out, html));
    }

    // ---- graph page ----------------------------------------------------------------------------
    if let Some(g) = &global_graph {
        out_files.push(file("graph.json", g.to_string()));
        let center = format!(
            "<div class=\"graph-view-outer\"><div class=\"page-header\"><h1 class=\"page-title\">Graph view</h1></div><div class=\"graph-view-container\"></div><script type=\"application/json\">{}</script></div>",
            json_script(g)
        );
        let html = shell(&site, Shell { out: "graph.html", rooted: false, title: "Graph view".into(), current_note: None, head: String::new(), center, right: String::new(), mobile_right: String::new(), body_class: "graph-page".into(), has_math: false, has_mermaid: false, has_callout: false });
        out_files.push(file("graph.html", html));
    }

    // ---- 404 -------------------------------------------------------------------------------------
    {
        let center = "<div class=\"markdown-preview-view markdown-rendered\"><div class=\"page-header\"><h1 class=\"page-title\">Page not found</h1></div><p>The page you are looking for does not exist. Try the search or the navigation.</p></div>".to_string();
        let html = shell(&site, Shell { out: "404.html", rooted: true, title: "Page not found".into(), current_note: None, head: "<meta name=\"robots\" content=\"noindex\">\n".into(), center, right: String::new(), mobile_right: String::new(), body_class: String::new(), has_math: false, has_mermaid: false, has_callout: false });
        out_files.push(file("404.html", html));
    }

    // ---- search, sitemap, rss, robots ------------------------------------------------------------
    if opts.search {
        out_files.push(file("search-index.json", Value::Array(search_index).to_string()));
    }
    let mut by_mtime: Vec<&Page> = pages.iter().collect();
    by_mtime.sort_by(|a, b| vault.mtime(&b.note).partial_cmp(&vault.mtime(&a.note)).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.note.cmp(&b.note)));
    let mut sitemap = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n");
    for p in &pages {
        let loc = if p.out == "index.html" { site.absolute("") } else { site.absolute(&p.out) };
        sitemap.push_str(&format!("  <url><loc>{}</loc>", esc(&loc)));
        let m = vault.mtime(&p.note);
        if m > 0.0 {
            sitemap.push_str(&format!("<lastmod>{}</lastmod>", paths::iso_date(m)));
        }
        sitemap.push_str("</url>\n");
    }
    sitemap.push_str("</urlset>\n");
    out_files.push(file("sitemap.xml", sitemap));

    let build_ms = if opts.now_ms > 0.0 { opts.now_ms } else { pages.iter().map(|p| vault.mtime(&p.note)).fold(0.0, f64::max) };
    let mut rss = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rss version=\"2.0\">\n<channel>\n");
    rss.push_str(&format!("<title>{}</title>\n<link>{}</link>\n<description>{}</description>\n<generator>vault-publish</generator>\n", esc(&site.site_name), esc(&site.absolute("")), esc(&format!("Recently updated in {}", site.site_name))));
    if build_ms > 0.0 {
        rss.push_str(&format!("<lastBuildDate>{}</lastBuildDate>\n", paths::rfc822(build_ms)));
    }
    for p in by_mtime.iter().take(opts.rss_limit) {
        let link = if p.out == "index.html" { site.absolute("") } else { site.absolute(&p.out) };
        rss.push_str(&format!("<item><title>{}</title><link>{}</link><guid>{}</guid>", esc(&p.title), esc(&link), esc(&link)));
        let m = vault.mtime(&p.note);
        if m > 0.0 {
            rss.push_str(&format!("<pubDate>{}</pubDate>", paths::rfc822(m)));
        }
        if let Some(d) = plains.get(&p.note) {
            rss.push_str(&format!("<description>{}</description>", esc(d)));
        }
        rss.push_str("</item>\n");
    }
    rss.push_str("</channel>\n</rss>\n");
    out_files.push(file("rss.xml", rss));
    if opts.noindex {
        out_files.push(file("robots.txt", "User-agent: *\nDisallow: /\n"));
    }

    // ---- assets and copied files -------------------------------------------------------------------
    out_files.push(file("assets/site.css", format!("{}\n{}", assets::CONTENT_CSS, assets::SITE_CSS)));
    out_files.push(file("assets/site.js", assets::SITE_JS));
    if publish_css {
        copy.insert("publish.css".into());
    }
    if let Some(f) = &favicon {
        copy.insert(f.clone());
    }
    for path in &copy {
        if let (Some(bytes), Some(out)) = (vault.bytes.get(path), attachments.get(path)) {
            out_files.push(SiteFile { path: out.clone(), bytes: bytes.clone() });
        }
    }
    out_files
}
