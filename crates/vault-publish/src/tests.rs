use crate::*;

fn note(path: &str, text: &str) -> InputFile {
    InputFile::note(path, text)
}

fn export(path: &str, files: Vec<InputFile>) -> String {
    export_note(&NoteExportInput { path: path.into(), files, ..Default::default() })
}

fn site(files: Vec<InputFile>, f: impl FnOnce(&mut SiteOptions)) -> Vec<SiteFile> {
    let mut input = SiteExportInput { files, ..Default::default() };
    input.options.site_name = "Test Site".into();
    f(&mut input.options);
    export_site(&input)
}

fn get<'a>(files: &'a [SiteFile], path: &str) -> &'a str {
    files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("no {path} in {:?}", files.iter().map(|f| &f.path).collect::<Vec<_>>())).text()
}

fn has(files: &[SiteFile], path: &str) -> bool {
    files.iter().any(|f| f.path == path)
}

// ---- export_note ----------------------------------------------------------------

#[test]
fn note_is_a_standalone_document() {
    let html = export("Note.md", vec![note("Note.md", "# Hello\n\nSome *text*.")]);
    assert!(html.starts_with("<!DOCTYPE html>"));
    assert!(html.contains("<title>Note</title>"));
    assert!(html.contains("<style>"));
    assert!(html.contains("<h1 class=\"page-header page-title\">Note</h1>"));
    assert!(html.contains("<em>text</em>"));
    assert!(!html.contains("<link rel=\"stylesheet\""), "no external stylesheet");
    assert!(!html.contains("<script"), "no script when nothing needs one");
}

#[test]
fn note_light_dark_and_print_css() {
    let html = export("N.md", vec![note("N.md", "x")]);
    assert!(html.contains("prefers-color-scheme: dark"));
    assert!(html.contains("@media print"));
    let mut input = NoteExportInput { path: "N.md".into(), files: vec![note("N.md", "x")], ..Default::default() };
    input.options.theme = Theme::Dark;
    assert!(export_note(&input).contains("<body class=\"theme-dark\">"));
}

#[test]
fn note_links_to_absent_notes_become_plain_text() {
    let html = export("A.md", vec![note("A.md", "See [[B]] and [[Missing]]."), note("B.md", "b")]);
    assert!(html.contains("class=\"internal-link is-unresolved\">B</a>"), "{html}");
    assert!(html.contains("class=\"internal-link is-unresolved\">Missing</a>"));
    assert!(!html.contains(" href=\"B\""));
    assert!(!html.contains("target=\"_blank\" rel=\"noopener nofollow\">B"));
}

#[test]
fn note_links_to_exported_notes_are_relative_html() {
    let mut input = NoteExportInput {
        path: "Folder/A.md".into(),
        files: vec![note("Folder/A.md", "See [[My Note#Part two|there]]."), note("Other/My Note.md", "# Part one\n## Part two\n")],
        ..Default::default()
    };
    input.options.exported = vec!["Other/My Note.md".into()];
    let html = export_note(&input);
    assert!(html.contains("href=\"../Other/My-Note.html#Part-two\""), "{html}");
}

#[test]
fn note_self_heading_links_are_anchors() {
    let html = export("A.md", vec![note("A.md", "[[#Second: part]]\n\n## Second: part\n")]);
    assert!(html.contains("href=\"#Second-part\""), "{html}");
    assert!(html.contains("id=\"Second-part\""));
}

#[test]
fn note_embeds_other_notes_inline() {
    let html = export("A.md", vec![note("A.md", "Before\n\n![[B]]\n\nAfter"), note("B.md", "---\ntags: x\n---\nEmbedded **body**")]);
    assert!(html.contains("markdown-embed"), "{html}");
    assert!(html.contains("Embedded <strong>body</strong>"));
    assert!(!html.contains("tags: x"), "frontmatter of the embedded note is not shown");
    assert!(!html.contains("<p><div"), "a note embed alone in a paragraph is not wrapped in <p>");
}

#[test]
fn note_embed_of_heading_section() {
    let text = "# One\nalphaword\n## Two\nbetaword\n# Three\ngammaword";
    let html = export("A.md", vec![note("A.md", "![[B#Two]]"), note("B.md", text)]);
    assert!(html.contains("betaword"), "{html}");
    assert!(!html.contains("alphaword"));
    assert!(!html.contains("gammaword"));
    assert!(html.contains("<h2 data-heading=\"Two\""), "the heading is part of the section");
}

#[test]
fn note_embed_of_block() {
    let html = export("A.md", vec![note("A.md", "![[B#^quote1]]"), note("B.md", "intro\n\nThe quoted line ^quote1\n\nother")]);
    assert!(html.contains("The quoted line"), "{html}");
    assert!(!html.contains("intro"));
}

#[test]
fn embeds_are_depth_limited_and_cycle_safe() {
    let files = vec![note("A.md", "![[B]]"), note("B.md", "in B ![[A]]")];
    let html = export("A.md", files);
    assert_eq!(html.matches("in B").count(), 1, "{html}");
    let chain = vec![note("A.md", "![[B]]"), note("B.md", "b ![[C]]"), note("C.md", "c ![[D]]"), note("D.md", "d ![[E]]"), note("E.md", "deep")];
    let mut input = NoteExportInput { path: "A.md".into(), files: chain, ..Default::default() };
    input.options.embed_depth = 2;
    let html = export_note(&input);
    assert!(html.contains("c "), "{html}");
    assert!(!html.contains("deep"));
}

#[test]
fn note_images_become_data_uris() {
    let png = vec![0x89, b'P', b'N', b'G'];
    let html = export("A.md", vec![note("A.md", "![[pic.png|200]]\n\n![[missing.png]]"), InputFile::binary("img/pic.png", png)]);
    assert!(html.contains("src=\"data:image/png;base64,iVBORw==\""), "{html}");
    assert!(html.contains("width=\"200\""));
    assert!(html.contains("internal-embed is-unresolved"));
}

#[test]
fn callouts_get_icons_and_license_notice() {
    let html = export("A.md", vec![note("A.md", "> [!warning] Careful\n> body\n\n> [!custom]- Folded\n> hidden")]);
    assert!(html.contains("lucide-triangle-alert"), "{html}");
    assert!(html.contains("lucide-pencil"), "unknown types use the note icon");
    assert!(html.contains("lucide-chevron-down"));
    assert!(html.contains("Lucide"));
    assert!(html.contains("ISC"));
    assert!(html.contains("<script>"), "fold toggle script");
}

#[test]
fn math_adds_mathjax_only_when_present() {
    let html = export("A.md", vec![note("A.md", "Inline $x^2$ and\n\n$$\n\\sum_i i\n$$\n")]);
    assert!(html.contains("\\(x^2\\)"), "{html}");
    assert!(html.contains("\\["));
    assert!(html.contains("cdn.jsdelivr.net/npm/mathjax@"));
    assert!(!export("B.md", vec![note("B.md", "no math")]).contains("mathjax"));
    let mut input = NoteExportInput { path: "A.md".into(), files: vec![note("A.md", "$x$")], ..Default::default() };
    input.options.cdn = false;
    assert!(!export_note(&input).contains("mathjax"));
}

#[test]
fn mermaid_blocks_become_mermaid_pre() {
    let html = export("A.md", vec![note("A.md", "```mermaid\ngraph TD\nA-->B\n```\n")]);
    assert!(html.contains("<pre class=\"mermaid\">graph TD\nA--&gt;B\n</pre>"), "{html}");
    assert!(html.contains("mermaid.esm.min.mjs"));
    assert!(!export("B.md", vec![note("B.md", "```js\nx\n```")]).contains("mermaid.esm"));
}

#[test]
fn properties_table_from_frontmatter() {
    let html = export("A.md", vec![note("A.md", "---\nstatus: draft\ntags:\n  - one\n  - two\ndone: true\n---\nbody")]);
    assert!(html.contains("metadata-properties"), "{html}");
    assert!(html.contains("<th>status</th><td>draft</td>"));
    assert!(html.contains("<span class=\"multi-select-pill\">two</span>"));
    assert!(html.contains("disabled checked"));
}

#[test]
fn raw_html_scripts_and_handlers_are_removed() {
    let html = export("A.md", vec![note("A.md", "<div onclick=\"alert(1)\">hi</div>\n\n<script>alert(2)</script>\n\n<a href=\"javascript:alert(3)\">x</a>")]);
    assert!(!html.contains("alert(1)"), "{html}");
    assert!(!html.contains("alert(2)"));
    assert!(!html.contains("javascript:"));
    assert!(html.contains(">hi</div>"));
}

#[test]
fn tasks_are_disabled_checkboxes_and_cssclasses_apply() {
    let html = export("A.md", vec![note("A.md", "---\ncssclasses: [wide, cards]\n---\n- [x] done\n- [ ] todo")]);
    assert!(html.contains("disabled"), "{html}");
    assert!(html.contains("class=\"markdown-preview-view markdown-rendered wide cards\""));
}

#[test]
fn footnote_links_stay_in_page() {
    let html = export("A.md", vec![note("A.md", "Text[^1]\n\n[^1]: Note")]);
    assert!(html.contains("href=\"#fn-1\""), "{html}");
    assert!(!html.contains("target=\"_blank\""));
}

#[test]
fn emoji_before_block_link_resolves() {
    // Offsets are UTF-16 in metadata; slicing an embed must convert them.
    let html = export("A.md", vec![note("A.md", "![[B#^id]]"), note("B.md", "😀😀 alphaword\n\n😀 target text ^id\n\nlast")]);
    assert!(html.contains("😀 target text"), "{html}");
    assert!(!html.contains("alphaword"));
}

// ---- export_site ------------------------------------------------------------------------

fn sample() -> Vec<InputFile> {
    let mut files = vec![
        note("Home.md", "---\naliases: [Start]\n---\n# Welcome\nGo to [[Guide]] or [[Folder/Deep Note#Details]]. #intro"),
        note("Guide.md", "---\ndescription: The guide to everything.\nimage: cover.png\n---\n## Setup\nSee [[Home]].\n\n> [!tip] Remember\n> ![[Folder/Deep Note#Details]]"),
        note("Folder/Deep Note.md", "---\ntags: [project/alpha]\n---\n# Deep\n## Details\nDetail text with [[Guide]].\n![[cover.png]]"),
        note("Private.md", "---\npublish: false\n---\nsecret stuff"),
        note("Drafts/Idea.md", "draft idea"),
        note(".obsidian/hidden.md", "never"),
    ];
    files.push(InputFile::binary("cover.png", vec![1, 2, 3]));
    files.push(InputFile::binary("unused.png", vec![9]));
    for (i, f) in files.iter_mut().enumerate() {
        f.mtime = 1_700_000_000_000.0 + i as f64 * 86_400_000.0;
    }
    files
}

fn sample_site() -> Vec<SiteFile> {
    site(sample(), |o| {
        o.home = Some("Home".into());
        o.base_url = "https://example.com/notes".into();
        o.exclude = vec!["Drafts".into()];
    })
}

#[test]
fn site_generates_expected_files() {
    let files = sample_site();
    for p in [
        "index.html",
        "Guide.html",
        "Folder/Deep-Note.html",
        "graph.html",
        "graph.json",
        "search-index.json",
        "tags/index.html",
        "tags/intro.html",
        "tags/project.html",
        "tags/project/alpha.html",
        "sitemap.xml",
        "rss.xml",
        "404.html",
        "assets/site.css",
        "assets/site.js",
        "cover.png",
    ] {
        assert!(has(&files, p), "missing {p}");
    }
    assert!(get(&files, "Home.html").contains("url=index.html"), "home is index.html; its default path redirects");
}

#[test]
fn site_respects_publish_flags_and_folders() {
    let files = sample_site();
    assert!(!has(&files, "Private.html"));
    assert!(!has(&files, "Drafts/Idea.html"));
    assert!(!files.iter().any(|f| f.path.contains(".obsidian")));
    assert!(!has(&files, "unused.png"), "only referenced attachments are copied");
    // publish: true beats an excluded folder
    let mut input = sample();
    input.push(note("Drafts/Ready.md", "---\npublish: true\n---\nready"));
    let files = site(input, |o| o.exclude = vec!["Drafts".into()]);
    assert!(has(&files, "Drafts/Ready.html"));
    assert!(!has(&files, "Drafts/Idea.html"));
    // include list
    let files = site(sample(), |o| o.include = vec!["Folder".into()]);
    assert!(has(&files, "Folder/Deep-Note.html"));
    assert!(!has(&files, "Guide.html"));
}

#[test]
fn site_links_are_relative_and_consistent() {
    let files = sample_site();
    let home = get(&files, "index.html");
    assert!(home.contains("href=\"Guide.html\""), "{home}");
    assert!(home.contains("href=\"Folder/Deep-Note.html#Details\""));
    let deep = get(&files, "Folder/Deep-Note.html");
    assert!(deep.contains("href=\"../Guide.html\""));
    assert!(deep.contains("src=\"../cover.png\""));
    assert!(deep.contains("href=\"../assets/site.css\""));
    assert!(deep.contains("data-root=\"../\""));
    let private_link = site(vec![note("A.md", "[[Private]]"), note("Private.md", "---\npublish: false\n---\nx")], |_| {});
    assert!(get(&private_link, "A.html").contains("internal-link is-unresolved\">Private</a>"));
    assert!(!has(&private_link, "Private.html"));
}

#[test]
fn site_navigation_tree_highlights_current_page() {
    let files = sample_site();
    let deep = get(&files, "Folder/Deep-Note.html");
    assert!(deep.contains("class=\"tree-item-self nav-file-title is-active\" href=\"Deep-Note.html\""), "{deep}");
    assert!(deep.contains("data-path=\"Folder\" open"));
    let guide = get(&files, "Guide.html");
    assert!(guide.contains("data-path=\"Folder\"><summary"), "folders not containing the page start closed");
    // folders sort before files
    let nav_start = guide.find("nav-view\"").unwrap();
    assert!(guide[nav_start..].find("data-path=\"Folder\"").unwrap() < guide[nav_start..].find("Guide.html").unwrap());
}

#[test]
fn site_navigation_order_and_hidden_items() {
    let files = site(vec![note("a.md", "a"), note("b.md", "b"), note("c.md", "c")], |o| {
        o.nav_order = vec!["c.md".into(), "a".into()];
        o.nav_hidden = vec!["b.md".into()];
    });
    let page = get(&files, "a.html");
    let nav = &page[page.find("nav-view\"").unwrap()..];
    assert!(nav.find("c.html").unwrap() < nav.find("a.html").unwrap());
    assert!(!nav[..nav.find("</ul>").unwrap()].contains("b.html"));
    assert!(has(&files, "b.html"), "hidden items are still published");
}

#[test]
fn site_right_column_toc_backlinks_and_local_graph() {
    let files = sample_site();
    let guide = get(&files, "Guide.html");
    assert!(guide.contains("On this page"));
    assert!(guide.contains("href=\"#Setup\""));
    assert!(guide.contains("Links to this page"));
    assert!(guide.contains("class=\"backlink-item\" href=\"index.html\""), "{guide}");
    assert!(guide.contains("graph-view-container\" data-local"));
    assert!(guide.contains("\"current\":true"));
    let off = site(sample(), |o| {
        o.show_graph = false;
        o.show_backlinks = false;
        o.show_toc = false;
    });
    let g = get(&off, "Guide.html");
    assert!(!g.contains("On this page") && !g.contains("Links to this page") && !g.contains("data-local"));
    assert!(!has(&off, "graph.html"));
}

#[test]
fn site_graph_json_has_published_nodes_with_positions() {
    let files = sample_site();
    let g: serde_json::Value = serde_json::from_str(get(&files, "graph.json")).unwrap();
    let nodes = g["nodes"].as_array().unwrap();
    let ids: Vec<&str> = nodes.iter().map(|n| n["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"Guide.md") && ids.contains(&"Home.md"));
    assert!(!ids.contains(&"Private.md") && !ids.contains(&"Drafts/Idea.md"));
    assert!(nodes.iter().all(|n| n["x"].is_number() && n["y"].is_number() && n["url"].is_string()));
    assert!(!g["links"].as_array().unwrap().is_empty());
    let xs: Vec<f64> = nodes.iter().map(|n| n["x"].as_f64().unwrap()).collect();
    assert!(xs.iter().any(|x| (x - xs[0]).abs() > 1.0), "layout spread the nodes");
}

#[test]
fn site_search_index_has_titles_headings_and_text() {
    let files = sample_site();
    let idx: serde_json::Value = serde_json::from_str(get(&files, "search-index.json")).unwrap();
    let entries = idx.as_array().unwrap();
    let deep = entries.iter().find(|e| e["t"] == "Deep Note").unwrap();
    assert_eq!(deep["u"], "Folder/Deep-Note.html");
    assert_eq!(deep["p"], "Folder");
    assert!(deep["h"].as_array().unwrap().iter().any(|h| h == "Details"));
    assert!(deep["x"].as_str().unwrap().contains("Detail text"));
    assert!(deep["g"].as_array().unwrap().iter().any(|t| t == "#project/alpha"));
    let home = entries.iter().find(|e| e["u"] == "index.html").unwrap();
    assert_eq!(home["a"][0], "Start");
    let no_search = site(sample(), |o| o.search = false);
    assert!(!has(&no_search, "search-index.json"));
    assert!(!get(&no_search, "Guide.html").contains("search-view-outer"));
}

#[test]
fn site_tag_pages_list_notes_and_nested_tags() {
    let files = sample_site();
    let project = get(&files, "tags/project.html");
    assert!(project.contains("href=\"project/alpha.html\""), "{project}");
    assert!(project.contains("href=\"../Folder/Deep-Note.html\""));
    let deep = get(&files, "Folder/Deep-Note.html");
    assert!(deep.contains("href=\"../tags/project/alpha.html\""));
    let home = get(&files, "index.html");
    assert!(home.contains("<a href=\"#intro\"") || home.contains("href=\"tags/intro.html\""), "inline tags link to tag pages");
    assert!(get(&files, "tags/index.html").contains("#project/alpha"));
}

#[test]
fn site_opengraph_description_image_and_canonical() {
    let files = sample_site();
    let guide = get(&files, "Guide.html");
    assert!(guide.contains("<meta name=\"description\" content=\"The guide to everything.\">"));
    assert!(guide.contains("<meta property=\"og:image\" content=\"https://example.com/notes/cover.png\">"), "{guide}");
    assert!(guide.contains("<link rel=\"canonical\" href=\"https://example.com/notes/Guide.html\">"));
    assert!(guide.contains("summary_large_image"));
    let deep = get(&files, "Folder/Deep-Note.html");
    assert!(deep.contains("<meta name=\"description\" content=\"Deep Details Detail text"), "automatic description");
}

#[test]
fn site_permalinks_and_alias_redirects() {
    let files = site(
        vec![
            note("Company/About us.md", "---\npermalink: about\n---\nabout"),
            note("Tutorials/How to make friends.md", "---\naliases:\n  - Guides/Making friends\n---\nfriends"),
            note("Links.md", "[[About us]] [[How to make friends]]"),
        ],
        |_| {},
    );
    assert!(has(&files, "about.html"));
    assert!(get(&files, "Company/About-us.html").contains("http-equiv=\"refresh\" content=\"0; url=../about.html\""));
    assert!(get(&files, "Guides/Making-friends.html").contains("url=../Tutorials/How-to-make-friends.html"));
    let links = get(&files, "Links.html");
    assert!(links.contains("href=\"about.html\""));
}

#[test]
fn site_slug_collisions_are_deduplicated() {
    let files = site(vec![note("A B.md", "one"), note("A-B.md", "two"), note("a b.md", "three")], |_| {});
    let mut pages: Vec<&str> = files.iter().map(|f| f.path.as_str()).filter(|p| p.ends_with(".html") && (p.starts_with('A') || p.starts_with('a'))).collect();
    pages.sort();
    assert_eq!(pages, vec!["A-B-2.html", "A-B.html", "a-b-3.html"]);
}

#[test]
fn site_reserved_paths_do_not_collide() {
    let files = site(vec![note("graph.md", "g"), note("tags/x.md", "t"), note("index.md", "i")], |_| {});
    assert!(has(&files, "graph-2.html"));
    assert!(has(&files, "tags-folder/x.html"));
    assert!(has(&files, "index-2.html"));
    assert!(get(&files, "index.html").contains("page-list"), "generated index without a home note");
}

#[test]
fn site_sitemap_and_rss() {
    let files = sample_site();
    let sitemap = get(&files, "sitemap.xml");
    assert!(sitemap.contains("<loc>https://example.com/notes/Folder/Deep-Note.html</loc><lastmod>2023-11-16</lastmod>"), "{sitemap}");
    assert!(sitemap.contains("<loc>https://example.com/notes/</loc>"));
    let rss = get(&files, "rss.xml");
    assert!(rss.contains("<title>Test Site</title>"));
    let first = rss.find("<item>").unwrap();
    assert!(rss[first..].starts_with("<item><title>Deep Note</title>"), "newest first: {rss}");
    assert!(rss.contains("<pubDate>Thu, 16 Nov 2023 22:13:20 GMT</pubDate>"));
}

#[test]
fn site_404_links_are_rooted() {
    let files = sample_site();
    let nf = get(&files, "404.html");
    assert!(nf.contains("href=\"https://example.com/notes/assets/site.css\""), "{nf}");
    assert!(nf.contains("href=\"https://example.com/notes/Guide.html\""));
    let plain = site(sample(), |_| {});
    assert!(get(&plain, "404.html").contains("href=\"/assets/site.css\""));
}

#[test]
fn site_publish_css_logo_favicon_and_theme() {
    let mut input = sample();
    input.push(InputFile { path: "publish.css".into(), text: Some(".x{color:red}".into()), ..Default::default() });
    input.push(InputFile::binary("favicon.ico", vec![0, 0, 1]));
    input.push(InputFile::binary("Attachments/logo.svg", b"<svg/>".to_vec()));
    let files = site(input, |o| {
        o.logo = Some("Attachments/logo.svg".into());
        o.theme = Theme::Dark;
        o.noindex = true;
    });
    let deep = get(&files, "Folder/Deep-Note.html");
    assert!(deep.contains("href=\"../publish.css\""));
    assert!(deep.contains("rel=\"icon\" href=\"../favicon.ico\""));
    assert!(deep.contains("src=\"../Attachments/logo.svg\""));
    assert!(deep.contains("data-default-theme=\"dark\""));
    assert!(deep.contains("noindex"));
    assert_eq!(get(&files, "publish.css"), ".x{color:red}");
    assert!(has(&files, "Attachments/logo.svg") && has(&files, "favicon.ico") && has(&files, "robots.txt"));
    let off = site(vec![note("A.md", "a"), InputFile { path: "publish.css".into(), text: Some("x".into()), ..Default::default() }], |o| o.custom_css = false);
    assert!(!get(&off, "A.html").contains("publish.css"));
}

#[test]
fn site_embeds_breadcrumbs_and_callouts() {
    let files = sample_site();
    let guide = get(&files, "Guide.html");
    assert!(guide.contains("Detail text with"), "embedded heading section inlined");
    assert!(guide.contains("lucide-flame"), "tip icon");
    let deep = get(&files, "Folder/Deep-Note.html");
    assert!(deep.contains("<span class=\"breadcrumb\">Folder</span>"));
    assert!(!get(&files, "Guide.html").contains("class=\"breadcrumbs\""), "root notes have no breadcrumbs");
}

#[test]
fn site_options_accept_headless_site_options_json() {
    let json = r#"{"files":[{"path":"Home.md","text":"hi"},{"path":"x.png","bytes":"AQID"}],
        "options":{"siteName":"Help","indexFile":"Home","defaultTheme":"system","showOutline":false,"navigationOrdering":["Home.md"]}}"#;
    let input: SiteExportInput = serde_json::from_str(json).unwrap();
    assert_eq!(input.options.home.as_deref(), Some("Home"));
    assert_eq!(input.options.theme, Theme::Auto);
    assert!(!input.options.show_toc);
    assert!(input.options.show_backlinks, "unspecified options keep their defaults");
    assert_eq!(input.files[1].bytes.as_ref().unwrap().0, vec![1, 2, 3]);
    let files = export_site(&input);
    assert!(get(&files, "index.html").contains("<title>Home - Help</title>"));
}

#[test]
fn site_hover_preview_flag_and_popover_container() {
    let files = sample_site();
    let guide = get(&files, "Guide.html");
    assert!(guide.contains("data-hover-preview"));
    assert!(guide.contains("class=\"render-container\""), "hover previews read .render-container");
    let off = site(sample(), |o| o.hover_preview = false);
    assert!(!get(&off, "Guide.html").contains("data-hover-preview"));
}

#[test]
fn site_pages_make_no_external_requests_without_math() {
    let files = sample_site();
    for f in &files {
        if f.path.ends_with(".html") && f.path != "404.html" {
            let t = f.text();
            assert!(!t.contains("src=\"http"), "{}: external src", f.path);
            assert!(!t.contains("stylesheet\" href=\"http"), "{}: external css", f.path);
        }
    }
    assert!(!get(&files, "assets/site.js").contains("http"));
}

#[test]
fn published_notes_lists_selection() {
    let input = SiteExportInput { files: sample(), options: SiteOptions { exclude: vec!["Drafts".into()], ..Default::default() } };
    assert_eq!(published_notes(&input), vec!["Folder/Deep Note.md", "Guide.md", "Home.md"]);
}

#[test]
fn html_attribute_values_are_escaped() {
    let files = site(vec![note("Q \"quote\" & <b>.md", "# T\n[[Q \"quote\" & <b>]]")], |_| {});
    let page = files.iter().find(|f| f.path.ends_with(".html") && f.path.starts_with('Q')).unwrap();
    assert_eq!(page.path, "Q-quote-b.html");
    let t = page.text();
    assert!(t.contains("<title>Q &quot;quote&quot; &amp; &lt;b&gt; - Test Site</title>"), "{t}");
}
