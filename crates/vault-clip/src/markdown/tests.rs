use super::*;

#[path = "oracle_tests.rs"]
mod oracle;

// ---- regressions found on real pages -------------------------------------------

#[test]
fn template_content_is_not_converted() {
    // MDN: "Enable JavaScript to view this browser compatibility table." sat in
    // a <template> and leaked into the note.
    let html = "<h2>Browser compatibility</h2><template><noscript>Enable JavaScript to view</noscript></template>";
    assert_eq!(clean_html_to_markdown(html), "## Browser compatibility");
}

#[test]
fn misnested_anchor_in_tweet_embed_matches_browser_parse() {
    // Substack tweet cards: <a><div/><p>quote <a>link</a></p></a>. Without the
    // adoption agency algorithm the quote lost its link.
    let html = r#"<a href="https://x.com/u/status/1"><div>avatar</div><p>quote <a href="https://f.com/p">f.com/p</a> </p></a>"#;
    assert_eq!(
        clean_html_to_markdown(html),
        "[\n\navatar\n\n](https://x.com/u/status/1)\n\n[quote](https://x.com/u/status/1) [f.com/p](https://f.com/p)"
    );
}

#[test]
fn complex_table_keeps_implied_tbody() {
    let html = "<table><tr><th colspan='2'>H</th></tr><tr><td>a</td><td>b</td></tr></table>";
    assert_eq!(
        clean_html_to_markdown(html),
        r#"<table><tbody><tr><th colspan="2">H</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>"#
    );
}

// ---- snippet API (plugin htmlToMarkdown) ---------------------------------------

#[test]
fn snippet_keeps_leading_h1_and_resolves_urls() {
    let md = html_to_markdown(
        r#"<h1>Title</h1><p><a href="../x">x</a> <img src="/i.png" alt="i"></p>"#,
        Some("https://ex.com/a/b/c.html"),
    );
    assert_eq!(md, "# Title\n\n[x](https://ex.com/a/x) ![i](https://ex.com/i.png)");
}

#[test]
fn snippet_whole_document_converts_only_the_body() {
    let html = "<!doctype html><html><head><title>Tab title</title><style>p{}</style></head><body><p>Body</p></body></html>";
    assert_eq!(html_to_markdown(html, None), "Body");
    assert_eq!(html_to_markdown("<title>T</title><p>x</p>", None), "x");
}

#[test]
fn snippet_without_base_leaves_relative_urls() {
    assert_eq!(html_to_markdown(r#"<a href="/x">x</a>"#, None), "[x](/x)");
}

#[test]
fn snippet_plain_text_and_empty() {
    assert_eq!(html_to_markdown("", None), "");
    assert_eq!(html_to_markdown("just text", None), "just text");
    assert_eq!(html_to_markdown("<p>  </p>", None), "");
}

#[test]
fn checked_checkbox_without_value_is_checked() {
    let html = r#"<ul><li class="task-list-item"><input type="checkbox" checked disabled> done</li><li class="task-list-item"><input type="checkbox" disabled> todo</li></ul>"#;
    assert_eq!(clean_html_to_markdown(html), "- [x] done\n- [ ] todo");
}

#[test]
fn checkbox_first_child_makes_a_task_without_class() {
    let html = r#"<ul><li><input type="checkbox"> a</li><li><input type="checkbox" checked> b</li></ul>"#;
    assert_eq!(html_to_markdown(html, None), "- [ ] a\n- [x] b");
}

#[test]
fn deeply_nested_lists_use_tabs() {
    let html = "<ol><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ol>";
    assert_eq!(clean_html_to_markdown(html), "1. a\n\t- b\n\t\t- c\n2. d");
}

#[test]
fn code_fence_escapes_backticks_like_defuddle() {
    let html = "<pre><code class=\"language-md\">```\ninner\n```</code></pre>";
    assert_eq!(clean_html_to_markdown(html), "```md\n\\`\\`\\`\ninner\n\\`\\`\\`\n```");
}

#[test]
fn inline_code_with_backticks_grows_delimiter() {
    assert_eq!(clean_html_to_markdown("<p><code>a`b</code></p>"), "``a`b``");
}

#[test]
fn table_pipes_and_newlines_in_cells() {
    let html = "<table><tr><th>a|b</th></tr><tr><td><p>one</p><p>two</p></td></tr></table>";
    assert_eq!(clean_html_to_markdown(html), "| a\\|b |\n| --- |\n| one  two |");
}

#[test]
fn ragged_rows_are_padded_to_widest() {
    let html = "<table><tr><th>A</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>";
    assert_eq!(clean_html_to_markdown(html), "| A |  |  |\n| --- | --- | --- |\n| 1 | 2 | 3 |");
}

#[test]
fn escaping_only_where_markdown_would_misread() {
    assert_eq!(clean_html_to_markdown("<p>1.5 and a-b and #tag and 3 > 2</p>"), "1.5 and a-b and #tag and 3 > 2");
    assert_eq!(clean_html_to_markdown("<p>1. x</p>"), "1\\. x");
}

#[test]
fn youtube_short_and_nocookie_embeds() {
    assert_eq!(
        clean_html_to_markdown(r#"<iframe src="https://youtu.be/abc_123"></iframe><iframe src="https://www.youtube-nocookie.com/embed/xyz"></iframe>"#),
        "![](https://www.youtube.com/watch?v=abc_123)\n![](https://www.youtube.com/watch?v=xyz)"
    );
}

#[test]
fn other_iframes_are_kept_as_html() {
    assert_eq!(
        clean_html_to_markdown(r#"<p>See</p><iframe src="https://player.vimeo.com/video/1" width="640"></iframe>"#),
        "See\n\n<iframe src=\"https://player.vimeo.com/video/1\" width=\"640\"></iframe>"
    );
}

#[test]
fn wbr_is_invisible() {
    assert_eq!(clean_html_to_markdown("<p>super<wbr>cali<wbr/>fragilistic</p>"), "supercalifragilistic");
}

#[test]
fn best_srcset_ignores_density_descriptors() {
    let d = Document::parse(r#"<img srcset="a.png 1x, b.png 2x" src="c.png">"#);
    let img = d.find_tag(0, "img").unwrap();
    assert_eq!(best_image_src(&d, img), "c.png");
}

#[test]
fn block_latex_with_alignment_is_wrapped() {
    assert_eq!(
        clean_html_to_markdown(r#"<math display="block" data-latex="a &amp;= b \\ c &amp;= d"><mi>a</mi></math>"#),
        "$$\n\\begin{aligned}\na &= b \\\\ c &= d\n\\end{aligned}\n$$"
    );
}

#[test]
fn images_on_hosts_containing_x_com_are_not_swallowed() {
    // Defuddle's embed filter tested `src` for the substring "x.com", so an
    // image on ex.com / box.com / netflix.com rendered as nothing.
    assert_eq!(
        clean_html_to_markdown(r#"<p><img src="https://ex.com/i.png" alt="i"> <img src="https://dropbox.com/a.png"></p>"#),
        "![i](https://ex.com/i.png) ![](https://dropbox.com/a.png)"
    );
    assert_eq!(
        clean_html_to_markdown(r#"<iframe src="https://x.com/jack/status/20"></iframe>"#),
        "![](https://x.com/jack/status/20)"
    );
}

#[test]
fn nested_list_siblings_share_one_indent() {
    // Defuddle/clipper output: "- a\n\t- b\n\t\t- c\n- d\n\t1. e\n\t\t2. f\n\t\t3. g",
    // which nests c under b and f, g under e. Found by importing Evernote notes.
    let html = "<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d<ol><li>e</li><li>f</li><li>g</li></ol></li></ul>";
    assert_eq!(clean_html_to_markdown(html), "- a\n\t- b\n\t- c\n- d\n\t1. e\n\t2. f\n\t3. g");
}

#[test]
fn list_nested_directly_in_list_still_indents() {
    assert_eq!(clean_html_to_markdown("<ul><li>a</li><ul><li>b</li><li>c</li></ul></ul>"), "- a\n\t- b\n\t- c");
}
