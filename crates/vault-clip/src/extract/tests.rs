//! Tests for the Defuddle port.
//!
//! `testdata/oracle_cases.json` holds one fixture per rule together with what
//! Defuddle 0.19.3 (under linkedom) returned for it; each `oracle_case!` test
//! asserts our metadata and content match. Content is compared after a
//! canonical re-serialisation (sorted attributes, collapsed whitespace, no
//! implied `<tbody>`, MathML children dropped because Defuddle's Node build
//! renders them with temml). Regenerate with the scratch `gencases.py`.

use super::*;
use crate::html::{Document, NodeData};

fn canon(html: &str) -> String {
    fn walk(d: &Document, id: NodeId, out: &mut String) {
        for &c in d.children(id) {
            match &d.node(c).data {
                NodeData::Text(t) => out.push_str(t),
                NodeData::Element { name, attrs } => {
                    if name == "tbody" {
                        walk(d, c, out);
                        continue;
                    }
                    let mut a: Vec<String> = attrs.iter().map(|(k, v)| format!(" {}=\"{}\"", k.to_lowercase(), v)).collect();
                    a.sort();
                    out.push('<');
                    out.push_str(name);
                    out.push_str(&a.concat());
                    out.push('>');
                    if name != "math" {
                        walk(d, c, out);
                    }
                    if !crate::html::is_void(name) {
                        out.push_str("</");
                        out.push_str(name);
                        out.push('>');
                    }
                }
                _ => {}
            }
        }
    }
    let d = Document::parse(html);
    let mut out = String::new();
    walk(&d, 0, &mut out);
    let out = util::collapse_ws(&out);
    let out = regex!(r">\s+<").replace_all(&out, "><");
    js_trim(&out).to_string()
}

fn oracle_cases() -> &'static Vec<serde_json::Value> {
    static C: std::sync::OnceLock<Vec<serde_json::Value>> = std::sync::OnceLock::new();
    C.get_or_init(|| serde_json::from_str(include_str!("testdata/oracle_cases.json")).expect("oracle cases"))
}

fn run_oracle_case(name: &str) {
    let case = oracle_cases().iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("no case {name}"));
    let html = case["html"].as_str().unwrap();
    let url = case["url"].as_str().unwrap();
    let exp = &case["expected"];
    let skip: Vec<&str> = case["skip"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let got = extract(html, url);
    let fields: [(&str, &str); 7] = [
        ("title", &got.title),
        ("author", &got.author),
        ("published", &got.published),
        ("description", &got.description),
        ("image", &got.image),
        ("site", &got.site),
        ("language", &got.language),
    ];
    for (k, v) in fields {
        if !skip.contains(&k) {
            assert_eq!(v, exp[k].as_str().unwrap_or(""), "{name}: {k}");
        }
    }
    if !skip.contains(&"wordCount") {
        assert_eq!(got.word_count as u64, exp["wordCount"].as_u64().unwrap(), "{name}: wordCount");
    }
    assert_eq!(canon(&got.content_html), canon(exp["content"].as_str().unwrap()), "{name}: content");
}

macro_rules! oracle_case {
    ($name:ident) => {
        #[test]
        fn $name() {
            run_oracle_case(stringify!($name));
        }
    };
}

mod oracle {
    use super::run_oracle_case;
    oracle_case!(meta_og_title_and_site);
    oracle_case!(title_suffix_cleaned_without_site);
    oracle_case!(title_prefix_site_name);
    oracle_case!(title_fuzzy_site_suffix);
    oracle_case!(author_meta_by_prefix_and_and);
    oracle_case!(author_citation_author_reversed);
    oracle_case!(author_schema_graph);
    oracle_case!(author_rel_author);
    oracle_case!(author_byline_near_h1);
    oracle_case!(published_time_element);
    oracle_case!(published_date_text_after_h1);
    oracle_case!(published_meta_article_time);
    oracle_case!(placeholder_values_rejected);
    oracle_case!(language_og_locale);
    oracle_case!(image_twitter_and_favicon_link);
    oracle_case!(entry_point_article_over_body);
    oracle_case!(exact_selectors_remove_clutter);
    oracle_case!(partial_selector_class);
    oracle_case!(partial_selector_anchored_id);
    oracle_case!(hidden_inline_style_and_class);
    oracle_case!(small_images_removed);
    oracle_case!(low_scoring_nav_block);
    oracle_case!(content_pattern_read_time_and_byline);
    oracle_case!(content_pattern_related_heading);
    oracle_case!(content_pattern_toc_list);
    oracle_case!(content_pattern_newsletter);
    oracle_case!(content_pattern_boilerplate_trailing);
    oracle_case!(h1_to_h2_and_title_heading_removed);
    oracle_case!(heading_permalink_anchors);
    oracle_case!(code_language_variants);
    oracle_case!(code_line_numbers_and_buttons);
    oracle_case!(footnotes_wikipedia_style);
    oracle_case!(footnotes_markdown_it_style);
    oracle_case!(footnotes_substack_style);
    oracle_case!(math_mathml_annotation);
    oracle_case!(math_mathjax_script_and_katex);
    oracle_case!(math_raw_latex_with_library);
    oracle_case!(math_latex_image);
    oracle_case!(callout_github_alert);
    oracle_case!(callout_bootstrap_and_aside);
    oracle_case!(callout_admonition);
    oracle_case!(lazy_images_promoted);
    oracle_case!(picture_sources);
    oracle_case!(figure_caption_normalised);
    oracle_case!(noscript_image_resolved);
    oracle_case!(attributes_stripped);
    oracle_case!(relative_urls_and_srcset);
    oracle_case!(empty_elements_and_br);
    oracle_case!(layout_table_unwrapped);
    oracle_case!(cover_image_removed);
    oracle_case!(short_page_retry_keeps_content);
    oracle_case!(schema_article_body_fallback);
    oracle_case!(cjk_word_count);
    oracle_case!(wikipedia_extractor);
    oracle_case!(streamed_ssr_content);
    oracle_case!(unsafe_elements_stripped);
}

#[test]
fn every_oracle_case_has_a_test() {
    let src = include_str!("tests.rs");
    for c in oracle_cases() {
        let name = c["name"].as_str().unwrap();
        assert!(src.contains(&format!("oracle_case!({name});")), "missing test for {name}");
    }
}

// ---- standardize_fragment ------------------------------------------------------

fn fragment(html: &str, base: Option<&str>) -> String {
    let mut d = Document::parse(html);
    let root = d.create_element("div");
    for c in d.children(0).to_vec() {
        d.append(root, c);
    }
    d.append(0, root);
    standardize_fragment(&mut d, root, base);
    d.inner_html(root)
}

#[test]
fn fragment_code_languages_from_class_and_data_attributes() {
    let out = fragment(
        r#"<pre><code class="language-rust">a</code></pre><pre class="lang-python">b</pre><div class="highlight highlight-source-ts"><pre>c</pre></div><pre data-lang="Go"><code>d</code></pre><pre><code class="hljs">e</code></pre>"#,
        None,
    );
    assert!(out.contains(r#"<pre><code data-lang="rust" class="language-rust">a</code></pre>"#), "{out}");
    assert!(out.contains(r#"<code data-lang="python" class="language-python">b</code>"#), "{out}");
    assert!(out.contains(r#"<code data-lang="ts" class="language-ts">c</code>"#), "{out}");
    assert!(out.contains(r#"<code data-lang="go" class="language-go">d</code>"#), "{out}");
    assert!(out.contains("<pre><code>e</code></pre>"), "{out}");
}

#[test]
fn fragment_highlight_source_is_not_used_by_full_extraction() {
    let body = "<p>Some words here to make a real paragraph of content, with commas.</p>".repeat(5);
    let e = extract(&format!(r#"<article>{body}<div class="highlight highlight-source-ts"><pre>let x = 1;</pre></div></article>"#), "https://x.com/a");
    assert!(e.content_html.contains("<pre><code>let x = 1;</code></pre>"), "{}", e.content_html);
}

#[test]
fn fragment_code_block_keeps_newlines_and_dedents() {
    let out = fragment("<pre><code>    line one\n      line two\n</code></pre>", None);
    assert!(out.contains("<code>line one\n  line two</code>"), "{out}");
}

#[test]
fn fragment_footnotes_use_defuddle_shape() {
    let out = fragment(
        r##"<p>Claim<sup id="fnref-a"><a href="#fn-a">1</a></sup>.</p><div class="footnotes"><ol><li id="fn-a"><p>Source text. <a href="#fnref-a">↩</a></p></li></ol></div>"##,
        None,
    );
    assert!(out.contains(r##"<sup id="fnref:1"><a href="#fn:1">1</a></sup>"##), "{out}");
    assert!(out.contains(r##"<div id="footnotes"><ol><li class="footnote" id="fn:1"><p>Source text. <a href="#fnref:1" title="return to article" class="footnote-backref">↩</a></p></li></ol></div>"##), "{out}");
}

#[test]
fn fragment_math_from_scripts_and_katex() {
    let out = fragment(
        r#"<p>A <script type="math/tex">x^2</script></p><p><span class="katex-display"><span class="katex"><span class="katex-mathml"><math><semantics><mi>y</mi><annotation encoding="application/x-tex">y</annotation></semantics></math></span></span></span></p>"#,
        None,
    );
    assert!(out.contains(r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline" data-latex="x^2">x^2</math>"#), "{out}");
    assert!(out.contains(r#"display="block" data-latex="y""#), "{out}");
}

#[test]
fn fragment_callouts_from_github_alerts() {
    let out = fragment(r#"<div class="markdown-alert markdown-alert-note"><p class="markdown-alert-title">Note</p><p>Body</p></div>"#, None);
    assert_eq!(
        out,
        r#"<div data-callout="note" class="callout"><div class="callout-title"><div class="callout-title-inner">Note</div></div><div class="callout-content"><p>Body</p></div></div>"#
    );
}

#[test]
fn fragment_lazy_images_and_relative_urls() {
    let out = fragment(
        r##"<img data-src="/i/real.jpg" src="data:image/gif;base64,R0lGOD" alt="x"><a href="../up">u</a><a href="#top">t</a><img srcset="a.png 1x, b.png 2x" alt="y">"##,
        Some("https://ex.com/dir/page"),
    );
    assert!(out.contains(r#"src="https://ex.com/i/real.jpg""#), "{out}");
    assert!(out.contains(r#"href="https://ex.com/up""#), "{out}");
    assert!(out.contains(r##"href="#top""##), "{out}");
    assert!(out.contains(r#"srcset="https://ex.com/dir/a.png 1x, https://ex.com/dir/b.png 2x""#), "{out}");
}

#[test]
fn fragment_without_base_url_leaves_links_alone() {
    let out = fragment(r#"<a href="../up">u</a>"#, None);
    assert_eq!(out, r#"<a href="../up">u</a>"#);
}

// ---- metadata helpers ----------------------------------------------------------------

#[test]
fn title_cleaning_rules() {
    use metadata::clean_title;
    assert_eq!(clean_title("Story | Site", "Site").0, "Story");
    assert_eq!(clean_title("Site — Story Title Here", "Site").0, "Story Title Here");
    assert_eq!(clean_title("CORS - HTTP | MDN", "MDN Web Docs").0, "CORS");
    assert_eq!(clean_title("A long article title / Blog", ""), ("A long article title".into(), "Blog".into()));
    assert_eq!(clean_title("Well-known - dash in title", "").0, "Well-known - dash in title");
    assert_eq!(clean_title("Rust Programming - Wiki", "").0, "Rust Programming");
}

#[test]
fn schema_property_paths() {
    let v = vec![Value::parse_json(r#"{"@type":"Article","author":[{"name":"A"},{"name":"B"}],"publisher":{"name":"P","logo":{"url":"u"}},"image":{"url":"i"}}"#).unwrap()];
    assert_eq!(metadata::schema_property(&v, "author.name"), "A, B");
    assert_eq!(metadata::schema_property(&v, "publisher.name"), "P");
    assert_eq!(metadata::schema_property(&v, "logo.url"), "u");
    assert_eq!(metadata::schema_property(&v, "missing"), "");
}

#[test]
fn date_text_and_placeholders() {
    assert_eq!(metadata::parse_date_text("Wednesday, 26 February 2025"), "2025-02-26T00:00:00+00:00");
    assert_eq!(metadata::parse_date_text("June 5, 2023 by X"), "2023-06-05T00:00:00+00:00");
    assert_eq!(metadata::parse_date_text("no date"), "");
    assert!(metadata::is_placeholder("{{title}}"));
    assert!(metadata::is_placeholder("#author.fullName"));
    assert!(metadata::is_placeholder(". ."));
    assert!(!metadata::is_placeholder("Jane"));
}

#[test]
fn schema_org_keeps_key_order_strips_comments_and_decodes_entities() {
    let html = r#"<html><head><script type="application/ld+json">/* c */ {"z":1,"a":"x &amp; y","@graph":null}</script><script type="application/ld+json">{"@graph":[{"@type":"A"},{"@type":"B"}]}</script><script type="application/ld+json">{bad json</script></head><body><p>x</p></body></html>"#;
    let e = extract(html, "https://ex.com/");
    assert_eq!(e.schema_org_data.len(), 3);
    assert_eq!(e.schema_org_data[0].to_json_string(), r#"{"z":1,"a":"x & y","@graph":null}"#);
    assert_eq!(e.schema_org_data[2].to_json_string(), r#"{"@type":"B"}"#);
}

#[test]
fn meta_tags_collected_with_names_and_properties() {
    let html = r#"<html><head><meta name="description" content="D &amp;amp; E"><meta property="og:type" content="article"><meta charset="utf-8"><meta name="empty" content=""></head><body></body></html>"#;
    let e = extract(html, "https://ex.com/");
    assert_eq!(e.meta_tags.len(), 2);
    assert_eq!(e.meta_tags[0].name.as_deref(), Some("description"));
    assert_eq!(e.meta_tags[0].content.as_deref(), Some("D & E"));
    assert_eq!(e.meta_tags[1].property.as_deref(), Some("og:type"));
    assert_eq!(e.meta_tags[1].name, None);
}

#[test]
fn domain_and_favicon_come_from_the_page_url() {
    let e = extract("<html><body><p>hi</p></body></html>", "https://www.Example.com/a/b");
    assert_eq!(e.domain, "example.com");
    assert_eq!(e.favicon, "https://www.example.com/favicon.ico");
    assert_eq!(e.site, "example.com");
}

// ---- pipeline edge cases ---------------------------------------------------------------

#[test]
fn empty_and_fragment_inputs_do_not_panic() {
    let e = extract("", "");
    assert_eq!(e.word_count, 0);
    let e = extract("<p>Just a fragment with no html or body.</p>", "https://ex.com/");
    assert!(e.content_html.contains("Just a fragment"), "{}", e.content_html);
    let e = extract("not html at all", "not a url");
    assert_eq!(e.word_count, 4);
}

#[test]
fn multibyte_text_near_slicing_boundaries_does_not_panic() {
    let p = "<p>😀 Ünïcødé — “quotes” and ☃ snowmen, repeated to pass the prose threshold. 日本語。</p>".repeat(8);
    let html = format!("<html><head><title>😀 Emoji — Title | Sité</title></head><body><article><ul><li><a href=\"#a\">😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀</a></li><li><a href=\"#b\">b</a></li><li><a href=\"#c\">c</a></li></ul>{p}</article></body></html>");
    let e = extract(&html, "https://ex.com/ü");
    assert!(e.word_count > 50);
    assert_eq!(e.title, "😀 Emoji — Title");
}

#[test]
fn html_word_count_decodes_entities_like_defuddle() {
    assert_eq!(count_html_words("<p>a&nbsp;b &amp; c</p><p>d&#8212;e &hellip;</p>"), 6);
    assert_eq!(count_html_words("<p>日本</p>"), 2);
}

#[test]
fn dangerous_urls_are_stripped_but_inline_images_kept() {
    let p = "<p>Enough words in this paragraph to be the content, with commas, yes.</p>".repeat(6);
    let html = format!(r#"<article>{p}<a href=" JaVa&#x09;Script:alert(1)">x</a><img src="data:image/png;base64,{}" alt="ok"><iframe src="data:image/svg+xml,x"></iframe><p onclick="evil()">t</p></article>"#, "A".repeat(200));
    let e = extract(&html, "https://ex.com/");
    assert!(!e.content_html.to_lowercase().contains("javascript"), "{}", e.content_html);
    assert!(e.content_html.contains("data:image/png;base64"), "{}", e.content_html);
    assert!(!e.content_html.contains("onclick"));
    assert!(!e.content_html.contains("svg+xml"));
}

#[test]
fn substack_preloaded_post_body_is_injected() {
    let body = "<p>Preloaded post paragraph with a good number of words, commas, and so on.</p>".repeat(6);
    let json = serde_json::json!({"feedData":{"initialPost":{"post":{"title":"Pre Title","subtitle":"Sub","body_html":body,"post_date":"2025-01-02T00:00:00Z","publishedBylines":[{"name":"Writer"}]}}}}).to_string();
    let js_string = serde_json::to_string(&json).unwrap();
    let html = format!("<html><head></head><body><div id=\"entry\"></div><script>window._preloads = JSON.parse({js_string})</script></body></html>");
    let e = extract(&html, "https://someone.substack.com/p/x");
    assert_eq!(e.title, "Pre Title");
    assert_eq!(e.author, "Writer");
    assert_eq!(e.published, "2025-01-02T00:00:00Z");
    assert_eq!(e.site, "Substack");
    assert!(e.content_html.contains("Preloaded post paragraph"), "{}", e.content_html);
}

#[test]
fn medium_extractor_strips_ui_chrome() {
    let p = "<p>Medium body paragraph that is long enough to be real content, with commas.</p>".repeat(6);
    let html = format!(r#"<html><head><meta property="og:site_name" content="Medium"></head><body><article><h1 data-testid="storyTitle">Story</h1><div><span data-testid="authorName">Ann</span><p>Member-only story</p><p>8 min read</p></div>{p}</article></body></html>"#);
    let e = extract(&html, "https://medium.com/@ann/story-abc123");
    assert_eq!(e.title, "Story");
    assert_eq!(e.author, "Ann");
    assert_eq!(e.site, "Medium");
    assert!(!e.content_html.contains("Member-only"), "{}", e.content_html);
    assert!(!e.content_html.contains("min read"), "{}", e.content_html);
}

#[test]
fn mathjax_chtml_tree_is_rebuilt_as_mathml() {
    let p = "<p>Paragraph of prose that is long enough to count as the article content, ok.</p>".repeat(6);
    let html = format!(r#"<article>{p}<p><mjx-container class="MathJax" jax="CHTML"><mjx-math class="MJX-TEX"><mjx-msup><mjx-mi><mjx-c>𝑥</mjx-c></mjx-mi><mjx-script><mjx-mn><mjx-c>2</mjx-c></mjx-mn></mjx-script></mjx-msup></mjx-math></mjx-container></p></article>"#);
    let e = extract(&html, "https://ex.com/");
    assert!(e.content_html.contains("<msup><mi>x</mi>") && e.content_html.contains("<mn>2</mn></msup>"), "{}", e.content_html);
}

#[test]
fn arxiv_equation_tables_become_block_math() {
    let p = "<p>Paragraph of prose that is long enough to count as the article content, ok.</p>".repeat(6);
    let html = format!(r#"<article>{p}<table class="ltx_equation"><tr><td><math alttext="E=mc^2" display="block"><semantics><mi>E</mi><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></td><td><span class="ltx_tag">(1)</span></td></tr></table></article>"#);
    let e = extract(&html, "https://arxiv.org/html/x");
    assert!(e.content_html.contains(r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="block" data-latex="E=mc^2">E=mc^2</math>"#), "{}", e.content_html);
    assert!(!e.content_html.contains("<table"));
}
