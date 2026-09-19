//! Behaviour tests for the public API. Expectations come from the help vault
//! (quoted where it decides a case), obsidian.d.ts, and the HTML contract in
//! docs/ARCHITECTURE.md.

use serde_json::json;
use vault_types::{CachedMetadata, Loc, Pos};

use crate::*;

fn meta(s: &str) -> CachedMetadata {
    parse(s)
}

fn links(s: &str) -> Vec<(String, String, String)> {
    meta(s)
        .links
        .unwrap_or_default()
        .into_iter()
        .map(|l| (l.link, l.display_text.unwrap_or_default(), l.original))
        .collect()
}

fn link_paths(s: &str) -> Vec<String> {
    links(s).into_iter().map(|l| l.0).collect()
}

fn embeds(s: &str) -> Vec<(String, String)> {
    meta(s).embeds.unwrap_or_default().into_iter().map(|l| (l.link, l.display_text.unwrap_or_default())).collect()
}

fn tags(s: &str) -> Vec<String> {
    meta(s).tags.unwrap_or_default().into_iter().map(|t| t.tag).collect()
}

fn sections(s: &str) -> Vec<(String, u32, u32)> {
    meta(s)
        .sections
        .unwrap_or_default()
        .into_iter()
        .map(|x| (x.kind, x.position.start.line, x.position.end.line))
        .collect()
}

fn kinds(s: &str) -> Vec<String> {
    sections(s).into_iter().map(|x| x.0).collect()
}

fn html(s: &str) -> String {
    render(s, &RenderOptions::default()).sections.into_iter().map(|x| x.html).collect::<Vec<_>>().join("\n")
}

fn loc(line: u32, col: u32, offset: u32) -> Loc {
    Loc { line, col, offset }
}

/// The UTF-16 slice a position covers.
fn at(text: &str, p: Pos) -> String {
    let u: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16_lossy(&u[p.start.offset as usize..p.end.offset as usize])
}

const TL: &str = "target=\"_blank\" rel=\"noopener nofollow\"";

// ---------------------------------------------------------------------------
// Links

#[test]
fn wikilink_plain() {
    assert_eq!(links("see [[Note]]"), vec![("Note".into(), "Note".into(), "[[Note]]".into())]);
}

#[test]
fn wikilink_alias() {
    assert_eq!(links("[[Note|Shown]]"), vec![("Note".into(), "Shown".into(), "[[Note|Shown]]".into())]);
}

#[test]
fn wikilink_heading_display_text() {
    // Internal links.md: `[[Example#Details]]` displays as "Example > Details".
    assert_eq!(links("[[Example#Details]]")[0].1, "Example > Details");
    assert_eq!(links("[[Example#Details]]")[0].0, "Example#Details");
}

#[test]
fn wikilink_nested_headings() {
    let l = &links("[[Help and support#Questions and advice#Report bugs]]")[0];
    assert_eq!(l.0, "Help and support#Questions and advice#Report bugs");
    assert_eq!(l.1, "Help and support > Questions and advice > Report bugs");
}

#[test]
fn wikilink_block_reference() {
    let l = &links("[[2023-01-01#^37066d]]")[0];
    assert_eq!(l.0, "2023-01-01#^37066d");
    assert_eq!(l.1, "2023-01-01 > ^37066d");
}

#[test]
fn wikilink_same_file_heading() {
    let l = &links("[[#Preview a linked file]]")[0];
    assert_eq!(l.0, "#Preview a linked file");
    assert_eq!(l.1, "Preview a linked file");
}

#[test]
fn wikilink_trims_and_keeps_extension() {
    assert_eq!(link_paths("[[ Figure 1.png ]]"), vec!["Figure 1.png"]);
}

#[test]
fn wikilink_heading_with_alias() {
    let l = &links("[[Example#Details|Section name]]")[0];
    assert_eq!((l.0.as_str(), l.1.as_str()), ("Example#Details", "Section name"));
}

#[test]
fn wikilink_in_table_escaped_pipe() {
    let text = "| a | b |\n|---|---|\n| [[Note\\|alias]] | x |\n";
    let l = &links(text)[0];
    assert_eq!((l.0.as_str(), l.1.as_str()), ("Note", "alias"));
}

#[test]
fn wikilink_cannot_span_lines_or_nest() {
    assert!(links("[[a\nb]]").is_empty());
    assert_eq!(link_paths("[[a [[b]]"), vec!["b"]);
}

#[test]
fn several_links_in_order() {
    assert_eq!(link_paths("[[a]] and [[b]], [c](c.md)"), vec!["a", "b", "c.md"]);
}

#[test]
fn markdown_link_to_note_is_internal() {
    // Internal links.md: `[Three laws of motion](Three%20laws%20of%20motion.md)`.
    let l = &links("[Three laws of motion](Three%20laws%20of%20motion.md)")[0];
    assert_eq!(l.0, "Three laws of motion.md");
    assert_eq!(l.1, "Three laws of motion");
}

#[test]
fn markdown_link_angle_brackets_with_spaces() {
    assert_eq!(link_paths("[x](<My Note.md>)"), vec!["My Note.md"]);
}

#[test]
fn markdown_link_display_text_is_plain_text() {
    assert_eq!(links("[**bold** `code`](Note.md)")[0].1, "bold code");
}

#[test]
fn markdown_link_with_heading_and_folder() {
    assert_eq!(link_paths("[s](Projects/Example.md#Details)"), vec!["Projects/Example.md#Details"]);
}

#[test]
fn markdown_link_keeps_encoded_hash_literal() {
    // decodeURI leaves reserved characters encoded, so `%23` cannot turn a
    // file name into a heading subpath.
    assert_eq!(link_paths("[x](C%23%20notes.md)"), vec!["C%23 notes.md"]);
}

#[test]
fn external_links_are_not_links() {
    assert!(meta("[x](https://obsidian.md) <https://a.com> https://b.com mailto:me@x.com [y](obsidian://open)").links.is_none());
}

#[test]
fn malformed_percent_escape_keeps_raw_path() {
    assert_eq!(link_paths("[x](100%.md)"), vec!["100%.md"]);
}

#[test]
fn links_inside_code_are_ignored() {
    let text = "`[[inline]]`\n\n```\n[[fenced]]\n```\n\n    [[indented]]\n\n$[[math]]$\n\n$$\n[[block math]]\n$$\n";
    assert!(meta(text).links.is_none(), "{:?}", meta(text).links);
}

#[test]
fn links_inside_comments_are_ignored() {
    assert!(meta("a %%[[hidden]] #tag%% b\n\n%%\n[[also]]\n#tag\n%%\n").links.is_none());
    assert!(meta("a %%[[hidden]] #tag%% b").tags.is_none());
}

#[test]
fn link_positions_are_utf16() {
    let text = "😀 [[Note]]\né [[B]]";
    let m = meta(text);
    let l = m.links.unwrap();
    assert_eq!(l[0].position.start, loc(0, 3, 3));
    assert_eq!(l[0].position.end, loc(0, 11, 11));
    assert_eq!(l[1].position.start, loc(1, 2, 14));
    assert_eq!(at(text, l[1].position), "[[B]]");
}

#[test]
fn crlf_positions_index_the_original_text() {
    let text = "# H\r\n\r\npara [[x]]\r\n- [[y]]\r\n";
    let m = meta(text);
    let l = m.links.unwrap();
    assert_eq!(at(text, l[0].position), "[[x]]");
    assert_eq!(l[0].position.start, loc(2, 5, 12));
    assert_eq!(at(text, l[1].position), "[[y]]");
    assert_eq!(l[1].position.start.line, 3);
    let s = sections(text);
    assert_eq!(s, vec![("heading".into(), 0, 0), ("paragraph".into(), 2, 2), ("list".into(), 3, 3)]);
}

#[test]
fn bom_is_not_content() {
    let text = "\u{FEFF}# Title [[x]]";
    let m = meta(text);
    assert_eq!(m.headings.as_ref().unwrap()[0].heading, "Title [[x]]");
    assert_eq!(at(text, m.links.unwrap()[0].position), "[[x]]");
}

#[test]
fn no_trailing_newline() {
    let text = "para\n\n- a\n- b";
    assert_eq!(sections(text), vec![("paragraph".into(), 0, 0), ("list".into(), 2, 3)]);
    let li = meta(text).list_items.unwrap();
    assert_eq!(li[1].position.end, loc(3, 3, 13));
}

// ---------------------------------------------------------------------------
// Embeds

#[test]
fn wikilink_embed_with_size() {
    assert_eq!(embeds("![[file.png|100x80]]"), vec![("file.png".into(), "100x80".into())]);
}

#[test]
fn wikilink_embed_block() {
    assert_eq!(embeds("![[Note#^id]]"), vec![("Note#^id".into(), "Note > ^id".into())]);
}

#[test]
fn markdown_image_local_is_embed() {
    assert_eq!(embeds("![alt text](assets/My%20Pic.png)"), vec![("assets/My Pic.png".into(), "alt text".into())]);
    assert!(meta("![alt](https://x.com/a.png)").embeds.is_none());
}

#[test]
fn embed_is_not_also_a_link() {
    let m = meta("![[a]] [[b]]");
    assert_eq!(m.embeds.unwrap().len(), 1);
    assert_eq!(m.links.unwrap().len(), 1);
}

// ---------------------------------------------------------------------------
// Tags

#[test]
fn tag_basic_and_nested() {
    assert_eq!(tags("#meeting and #inbox/to-read"), vec!["#meeting", "#inbox/to-read"]);
}

#[test]
fn tag_must_have_non_digit() {
    // Tags.md: "#1984 isn't a valid tag, but #y1984 is."
    assert_eq!(tags("#1984 #y1984 #2024-01"), vec!["#y1984", "#2024-01"]);
}

#[test]
fn tag_allowed_characters() {
    assert_eq!(tags("#camelCase #snake_case #kebab-case #日本語 #café #🚀rocket"), vec![
        "#camelCase", "#snake_case", "#kebab-case", "#日本語", "#café", "#🚀rocket"
    ]);
}

#[test]
fn tag_stops_at_punctuation() {
    assert_eq!(tags("#tag, #end. (#paren) #a?b #x…"), vec!["#tag", "#end", "#a", "#x"]);
}

#[test]
fn tag_needs_whitespace_before() {
    assert!(tags("a#b http://x.com/#anchor [[Note#Heading]] issue#12").is_empty());
    assert_eq!(tags("#start\n#line2 mid #x"), vec!["#start", "#line2", "#x"]);
}

#[test]
fn lone_hash_is_not_a_tag() {
    assert!(tags("# \n\na # b ## c").is_empty());
}

#[test]
fn tags_in_code_links_and_urls_are_ignored() {
    assert!(tags("`#code` [#text](https://x.com) https://x.com/#frag <b>#</b>").is_empty());
    assert!(tags("```\n#fenced\n```").is_empty());
}

#[test]
fn tag_in_heading_is_indexed() {
    let m = meta("# Heading #tag\n");
    assert_eq!(m.tags.unwrap()[0].tag, "#tag");
    assert_eq!(m.headings.unwrap()[0].heading, "Heading #tag");
}

#[test]
fn tag_in_bold_and_list_and_quote() {
    assert_eq!(tags("**#bold** - x\n\n- #item\n\n> #quoted"), vec!["#bold", "#item", "#quoted"]);
}

#[test]
fn tag_position() {
    let text = "😀 #tag";
    let t = &meta(text).tags.unwrap()[0];
    assert_eq!(t.position.start, loc(0, 3, 3));
    assert_eq!(at(text, t.position), "#tag");
}

#[test]
fn frontmatter_tags_are_not_body_tags() {
    let m = meta("---\ntags: [a, b]\n---\ntext");
    assert!(m.tags.is_none());
    assert_eq!(m.frontmatter.unwrap()["tags"], json!(["a", "b"]));
}

// ---------------------------------------------------------------------------
// Headings

#[test]
fn atx_heading_levels_and_closing_hashes() {
    let h = meta("# One\n## Two ##\n###### Six\n####### seven\n#NoSpace").headings.unwrap();
    let got: Vec<(String, u8)> = h.into_iter().map(|h| (h.heading, h.level)).collect();
    assert_eq!(got, vec![("One".into(), 1), ("Two".into(), 2), ("Six".into(), 6)]);
}

#[test]
fn setext_headings() {
    let h = meta("Title\n=====\n\nSub\n---\n").headings.unwrap();
    assert_eq!((h[0].heading.as_str(), h[0].level), ("Title", 1));
    assert_eq!((h[1].heading.as_str(), h[1].level), ("Sub", 2));
    assert_eq!(h[0].position.end.line, 1);
}

#[test]
fn heading_keeps_markup_as_written() {
    assert_eq!(meta("## [[Link]] and *em*").headings.unwrap()[0].heading, "[[Link]] and *em*");
}

#[test]
fn heading_position() {
    let h = &meta("text\n\n## Title  ").headings.unwrap()[0];
    assert_eq!(h.position.start, loc(2, 0, 6));
    assert_eq!(h.position.end, loc(2, 10, 16));
}

#[test]
fn headings_inside_quotes_are_not_headings() {
    assert!(meta("> # quoted\n\n- # item").headings.is_none());
}

#[test]
fn heading_block_id_is_not_heading_text() {
    let m = meta("# Title ^hid\n");
    assert_eq!(m.headings.unwrap()[0].heading, "Title");
    assert_eq!(m.sections.unwrap()[0].id.as_deref(), Some("hid"));
}

// ---------------------------------------------------------------------------
// Sections

#[test]
fn section_types() {
    let text = "---\na: 1\n---\n# H\n\npara\n\n- item\n\n```js\ncode\n```\n\n> quote\n\n> [!tip] t\n> x\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n***\n\n$$\nx\n$$\n\n%%\nc\n%%\n\n[^1]: note\n\n<div>\nhi\n</div>\n\n[ref]: https://x.com\n";
    assert_eq!(kinds(text), vec![
        "yaml", "heading", "paragraph", "list", "code", "blockquote", "callout", "table", "thematicBreak", "math",
        "comment", "footnoteDefinition", "html", "definition"
    ]);
}

#[test]
fn section_line_ranges() {
    let text = "# H\npara one\npara two\n\n- a\n  - b\n- c\n\n```\nx\n\ny\n```";
    assert_eq!(sections(text), vec![
        ("heading".into(), 0, 0),
        ("paragraph".into(), 1, 2),
        ("list".into(), 4, 6),
        ("code".into(), 8, 12)
    ]);
}

#[test]
fn section_positions_exclude_trailing_blank_lines() {
    let m = meta("para\n\n\n\nnext\n");
    let s = m.sections.unwrap();
    assert_eq!(s[0].position.end, loc(0, 4, 4));
    assert_eq!(s[1].position.start, loc(4, 0, 8));
}

#[test]
fn indented_code_section() {
    assert_eq!(kinds("para\n\n    code\n    more\n"), vec!["paragraph", "code"]);
}

#[test]
fn unclosed_fence_runs_to_end() {
    assert_eq!(sections("```\na\n\nb"), vec![("code".into(), 0, 3)]);
}

#[test]
fn list_interrupts_paragraph() {
    assert_eq!(kinds("para\n- item"), vec!["paragraph", "list"]);
}

#[test]
fn thematic_break_vs_setext() {
    assert_eq!(kinds("a\n\n---\n\nb"), vec!["paragraph", "thematicBreak", "paragraph"]);
    assert_eq!(kinds("a\n---"), vec!["heading"]);
}

// ---------------------------------------------------------------------------
// Lists

#[test]
fn list_items_parents_follow_obsidian_d_ts() {
    // The forum-confirmed example: roots of a list at line 0 report -1.
    let li = meta("- [ ] no\n- [ ] yes\n    - [ ] maybe\n").list_items.unwrap();
    let got: Vec<(i64, Option<&str>)> = li.iter().map(|i| (i.parent, i.task.as_deref())).collect();
    assert_eq!(got, vec![(-1, Some(" ")), (-1, Some(" ")), (1, Some(" "))]);
}

#[test]
fn list_parent_is_negative_first_line() {
    let li = meta("para\n\n- a\n- b\n  - c\n    - d\n- e\n").list_items.unwrap();
    let parents: Vec<i64> = li.iter().map(|i| i.parent).collect();
    assert_eq!(parents, vec![-2, -2, 3, 4, -2]);
}

#[test]
fn list_item_position_excludes_children() {
    let li = meta("- parent\n  - child\n").list_items.unwrap();
    assert_eq!(li[0].position.start, loc(0, 0, 0));
    assert_eq!(li[0].position.end, loc(0, 8, 8));
    assert_eq!(li[1].position.start, loc(1, 2, 11));
    assert_eq!(li[1].position.end, loc(1, 9, 18));
}

#[test]
fn list_item_multiline_position() {
    let li = meta("- first\n  continued\n- next").list_items.unwrap();
    assert_eq!(li[0].position.end.line, 1);
}

#[test]
fn task_status_characters() {
    let li = meta("- [ ] a\n- [x] b\n- [X] c\n- [-] d\n- [>] e\n- [] f\n- [ab] g\n").list_items.unwrap();
    let t: Vec<Option<&str>> = li.iter().map(|i| i.task.as_deref()).collect();
    assert_eq!(t, vec![Some(" "), Some("x"), Some("X"), Some("-"), Some(">"), None, None]);
}

#[test]
fn ordered_lists() {
    let li = meta("1. one\n2. two\n   1) nested? no\n").list_items.unwrap();
    assert_eq!(li[0].parent, -1);
    assert_eq!(kinds("3. three\n4. four"), vec!["list"]);
}

#[test]
fn different_bullets_split_lists() {
    assert_eq!(kinds("- a\n* b\n"), vec!["list", "list"]);
}

#[test]
fn list_item_block_ids() {
    let m = meta("- Gemmy\n    - child ^child\n- Unhelpful ^top\n");
    let li = m.list_items.unwrap();
    assert_eq!(li[0].id, None);
    assert_eq!(li[1].id.as_deref(), Some("child"));
    assert_eq!(li[2].id.as_deref(), Some("top"));
    let blocks = m.blocks.unwrap();
    assert_eq!(blocks["child"].position, li[1].position);
    assert_eq!(blocks["top"].id, "top");
}

#[test]
fn callout_nested_in_list() {
    let text = "- item\n  > [!note] Inside\n  > body [[x]]\n";
    let m = meta(text);
    assert_eq!(kinds(text), vec!["list"]);
    assert_eq!(at(text, m.links.unwrap()[0].position), "[[x]]");
    assert!(html(text).contains("data-callout=\"note\""));
}

#[test]
fn tabs_indent_nested_lists() {
    let li = meta("- a\n\t- b\n").list_items.unwrap();
    assert_eq!(li[1].parent, 0);
    assert_eq!(li[1].position.start.col, 1);
}

// ---------------------------------------------------------------------------
// Blocks

#[test]
fn paragraph_block_id() {
    let text = "The quick purple gem. ^37066d\n";
    let m = meta(text);
    let b = &m.blocks.unwrap()["37066d"];
    assert_eq!(b.id, "37066d");
    assert_eq!(b.position, m.sections.unwrap()[0].position);
}

#[test]
fn standalone_block_id_names_previous_block() {
    // Internal links.md: structured blocks take the id on a separate line.
    let text = "> quote\n\n^37066f\n\nThis is the tale.";
    let m = meta(text);
    let s = m.sections.unwrap();
    assert_eq!(s.len(), 2);
    assert_eq!(s[0].id.as_deref(), Some("37066f"));
    assert_eq!(m.blocks.unwrap()["37066f"].position, s[0].position);
}

#[test]
fn block_id_after_table() {
    let m = meta("| a | b |\n|---|---|\n| 1 | 2 |\n\n^tbl\n");
    assert_eq!(m.sections.unwrap()[0].id.as_deref(), Some("tbl"));
}

#[test]
fn block_id_keys_are_lowercase_ids_keep_case() {
    let m = meta("text ^MyBlock");
    let b = m.blocks.unwrap();
    assert_eq!(b["myblock"].id, "MyBlock");
}

#[test]
fn caret_mid_paragraph_is_not_a_block_id() {
    assert!(meta("x ^notid more").blocks.is_none());
    assert!(meta("x^noid").blocks.is_none());
    assert!(meta("x ^bad_id").blocks.is_none());
}

#[test]
fn block_id_on_last_line_of_multiline_paragraph() {
    let m = meta("line one\nline two ^end");
    assert!(m.blocks.unwrap().contains_key("end"));
}

// ---------------------------------------------------------------------------
// Footnotes and references

#[test]
fn footnote_definition_and_reference() {
    let text = "Text[^1] again[^note].\n\n[^1]: First.\n[^note]: Second\n    continued.\n";
    let m = meta(text);
    let f = m.footnotes.unwrap();
    assert_eq!(f.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["1", "note"]);
    assert_eq!(f[1].position.end.line, 4);
    let r = m.footnote_refs.unwrap();
    assert_eq!(at(text, r[0].position), "[^1]");
    assert_eq!(r[1].id, "note");
}

#[test]
fn inline_footnote() {
    let text = "Claim.^[An inline note.]";
    let m = meta(text);
    let r = m.footnote_refs.unwrap();
    assert_eq!(r[0].id, "inline-1");
    assert_eq!(at(text, r[0].position), "^[An inline note.]");
    assert_eq!(at(text, m.footnotes.unwrap()[0].position), "An inline note.");
}

#[test]
fn reference_link_definitions() {
    let m = meta("[foo]: https://example.com \"Title\"\n[Bar]: <local note.md>\n");
    let r = m.reference_links.unwrap();
    assert_eq!((r[0].id.as_str(), r[0].link.as_str()), ("foo", "https://example.com"));
    assert_eq!((r[1].id.as_str(), r[1].link.as_str()), ("Bar", "local note.md"));
}

// ---------------------------------------------------------------------------
// Frontmatter

#[test]
fn frontmatter_values_and_position() {
    let text = "---\ntitle: Hello\ndate: 2024-01-15\ncount: 3\ndone: true\nnothing:\naliases:\n  - One\n  - Two\nnested:\n  a: 1\n---\nBody";
    let m = meta(text);
    let fm = m.frontmatter.unwrap();
    assert_eq!(serde_json::Value::Object(fm), json!({
        "title": "Hello", "date": "2024-01-15", "count": 3, "done": true, "nothing": null,
        "aliases": ["One", "Two"], "nested": {"a": 1}
    }));
    let p = m.frontmatter_position.unwrap();
    assert_eq!(p.start, loc(0, 0, 0));
    assert_eq!(p.end.line, 11);
    assert_eq!(p.end.col, 3);
    assert_eq!(m.sections.unwrap()[0].kind, "yaml");
}

#[test]
fn frontmatter_keeps_key_order() {
    let fm = meta("---\nzeta: 1\nalpha: 2\n---\n").frontmatter.unwrap();
    assert_eq!(fm.keys().collect::<Vec<_>>(), vec!["zeta", "alpha"]);
}

#[test]
fn frontmatter_links_keys() {
    let text = "---\nup: \"[[Parent|The parent]]\"\nrelated:\n  - \"[[A#h]]\"\n  - \"[B](B%20note.md)\"\nproject:\n  owner: \"[[Me]]\"\nsite: \"[s](https://x.com)\"\nplain: \"[[x]] and [[y]]\"\n---\n";
    let fl = meta(text).frontmatter_links.unwrap();
    let got: Vec<(&str, &str, &str)> =
        fl.iter().map(|l| (l.key.as_str(), l.link.as_str(), l.display_text.as_deref().unwrap())).collect();
    assert_eq!(got, vec![
        ("up", "Parent", "The parent"),
        ("related.0", "A#h", "A > h"),
        ("related.1", "B note.md", "B"),
        ("project.owner", "Me", "Me"),
        ("plain", "x]] and [[y", "x]] and [[y"),
    ]);
}

#[test]
fn invalid_frontmatter_has_position_but_no_data() {
    let m = meta("---\na: 1\na: 2\n---\ntext");
    assert!(m.frontmatter.is_none());
    assert!(m.frontmatter_position.is_some());
    let f = parse_frontmatter("---\na: b: c\n---\n");
    assert!(f.data.is_none());
    assert!(f.error.unwrap().contains("BLOCK_AS_IMPLICIT_KEY"));
}

#[test]
fn frontmatter_must_be_first_and_closed() {
    assert!(meta("\n---\na: 1\n---\n").frontmatter.is_none());
    assert!(meta("---\na: 1\n").frontmatter.is_none());
    assert_eq!(kinds("---\na: 1\n"), vec!["thematicBreak", "paragraph"]);
}

#[test]
fn empty_frontmatter() {
    let m = meta("---\n---\nbody");
    assert!(m.frontmatter.is_none());
    assert_eq!(kinds("---\n---\nbody"), vec!["yaml", "paragraph"]);
}

#[test]
fn parse_frontmatter_body_start() {
    let t = "---\r\na: 1\r\n---\r\nBody";
    let f = parse_frontmatter(t);
    assert_eq!(&t[f.body_start_byte..], "Body");
    assert_eq!(f.data.unwrap()["a"], json!(1));
    assert_eq!(f.position.unwrap().end, loc(2, 3, 14));
    assert_eq!(parse_frontmatter("no fm").body_start_byte, 0);
}

// ---------------------------------------------------------------------------
// resolveSubpath and helpers

#[test]
fn resolve_heading_subpath() {
    let text = "# A\n## B\ntext\n## C\n# D\n";
    let m = meta(text);
    match resolve_subpath(&m, "#A#C").unwrap() {
        SubpathResult::Heading { current, next, start, end } => {
            assert_eq!(current.heading, "C");
            assert_eq!(next.unwrap().heading, "D");
            assert_eq!(start.line, 3);
            assert_eq!(end.unwrap().line, 4);
        }
        other => panic!("{other:?}"),
    }
    match resolve_subpath(&m, "b").unwrap() {
        SubpathResult::Heading { current, next, .. } => {
            assert_eq!(current.heading, "B");
            assert_eq!(next.unwrap().heading, "C");
        }
        other => panic!("{other:?}"),
    }
    match resolve_subpath(&m, "#D").unwrap() {
        SubpathResult::Heading { end, .. } => assert!(end.is_none()),
        other => panic!("{other:?}"),
    }
    assert!(resolve_subpath(&m, "#Missing").is_none());
    assert!(resolve_subpath(&m, "#D#A").is_none());
}

#[test]
fn resolve_heading_ignores_punctuation() {
    let m = meta("## Q: what? (really)\n");
    assert!(resolve_subpath(&m, "#Q what really").is_some());
}

#[test]
fn resolve_block_and_footnote_subpaths() {
    let m = meta("- item ^Blk\n\n[^1]: note\n");
    match resolve_subpath(&m, "#^blk").unwrap() {
        SubpathResult::Block { block, list, .. } => {
            assert_eq!(block.id, "Blk");
            assert!(list.is_some());
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(resolve_subpath(&m, "#[^1]"), Some(SubpathResult::Footnote { .. })));
    let json = serde_json::to_value(resolve_subpath(&m, "^blk").unwrap()).unwrap();
    assert_eq!(json["type"], "block");
}

#[test]
fn strip_heading_helpers() {
    assert_eq!(strip_heading("A: b  [c]|d"), "A b c d");
    assert_eq!(strip_heading_for_link("Hi: [[x]] #y ^z"), "Hi x y z");
    assert_eq!(strip_heading_for_link("100% done"), "100% done");
    assert_eq!(get_linkpath("Note#Heading"), "Note");
    assert_eq!(parse_linktext("Note#^b"), ("Note".to_string(), "#^b".to_string()));
    assert_eq!(display_text("#a##b"), "a > b");
}

// ---------------------------------------------------------------------------
// Rendering: the HTML contract

#[test]
fn render_internal_link() {
    assert_eq!(
        html("[[Note#H|Alias]]"),
        format!("<p dir=\"auto\"><a data-href=\"Note#H\" href=\"Note#H\" class=\"internal-link\" {TL}>Alias</a></p>")
    );
    assert!(html("[[Note#H]]").contains(">Note &gt; H</a>"));
}

#[test]
fn render_embeds() {
    assert_eq!(
        html("![[file.png|100x80]]"),
        "<p dir=\"auto\"><span class=\"internal-embed\" src=\"file.png\" alt=\"100x80\" tabindex=\"-1\"></span></p>"
    );
    assert!(html("![[Note#^id]]").contains("<span class=\"internal-embed\" src=\"Note#^id\" alt=\"Note > ^id\" tabindex=\"-1\"></span>"));
    assert!(html("![alt](local/My%20Pic.png)").contains("src=\"local/My Pic.png\" alt=\"alt\""));
}

#[test]
fn render_external_image_and_link() {
    assert_eq!(
        html("![alt](https://x.com/a.png)"),
        "<p dir=\"auto\"><img src=\"https://x.com/a.png\" alt=\"alt\" referrerpolicy=\"no-referrer\"></p>"
    );
    assert!(html("![alt|200](https://x.com/a.png)").contains("alt=\"alt\" width=\"200\" referrerpolicy"));
    assert_eq!(
        html("[x](https://obsidian.md)"),
        format!("<p dir=\"auto\"><a href=\"https://obsidian.md\" class=\"external-link\" {TL}>x</a></p>")
    );
}

#[test]
fn render_markdown_internal_link() {
    assert_eq!(
        html("[x](Note%20A)"),
        format!("<p dir=\"auto\"><a data-href=\"Note A\" href=\"Note A\" class=\"internal-link\" {TL}>x</a></p>")
    );
}

#[test]
fn render_bare_url_autolink() {
    assert_eq!(
        html("see https://obsidian.md/help."),
        format!("<p dir=\"auto\">see <a href=\"https://obsidian.md/help\" class=\"external-link\" {TL}>https://obsidian.md/help</a>.</p>")
    );
}

#[test]
fn render_tag() {
    assert_eq!(html("#tag/sub"), format!("<p dir=\"auto\"><a href=\"#tag/sub\" class=\"tag\" {TL}>#tag/sub</a></p>"));
}

#[test]
fn render_emphasis_family() {
    assert_eq!(
        html("==hi== ~~x~~ **b** *i* `c<d`"),
        "<p dir=\"auto\"><mark>hi</mark> <del>x</del> <strong>b</strong> <em>i</em> <code>c&lt;d</code></p>"
    );
}

#[test]
fn render_comments_omitted() {
    assert_eq!(html("a%%c%%b"), "<p dir=\"auto\">ab</p>");
    let r = render("x\n\n%%\nblock\n%%\n\ny", &RenderOptions::default());
    assert_eq!(r.sections[1].kind, "comment");
    assert_eq!(r.sections[1].html, "");
}

#[test]
fn render_math() {
    assert_eq!(html("$a<b$"), "<p dir=\"auto\"><span class=\"math math-inline\">a&lt;b</span></p>");
    assert_eq!(html("$$\nx<y\n$$"), "<div class=\"math math-block\">x&lt;y</div>");
    assert_eq!(html("cost $5 and $6"), "<p dir=\"auto\">cost $5 and $6</p>");
}

#[test]
fn render_fenced_code() {
    assert_eq!(
        html("```js\nif (a < b) {}\n```"),
        "<pre class=\"language-js\"><code class=\"language-js\">if (a &lt; b) {}\n</code></pre>"
    );
    assert_eq!(html("```\nplain\n```"), "<pre><code>plain\n</code></pre>");
}

#[test]
fn render_heading() {
    assert_eq!(html("## Text"), "<h2 data-heading=\"Text\" dir=\"auto\">Text</h2>");
    assert_eq!(html("# A \"q\" ^id"), "<h1 data-heading=\"A &quot;q&quot;\" dir=\"auto\">A \"q\"</h1>");
}

#[test]
fn render_list_items_and_tasks() {
    let out = html("- a\n- [x] done\n- [ ] todo");
    assert_eq!(
        out,
        "<ul class=\"contains-task-list\">\n<li data-line=\"0\" dir=\"auto\">a</li>\n<li data-line=\"1\" data-task=\"x\" class=\"task-list-item is-checked\" dir=\"auto\"><input data-line=\"1\" type=\"checkbox\" class=\"task-list-item-checkbox\" checked>done</li>\n<li data-line=\"2\" data-task=\" \" class=\"task-list-item\" dir=\"auto\"><input data-line=\"2\" type=\"checkbox\" class=\"task-list-item-checkbox\">todo</li>\n</ul>"
    );
    assert!(html("- [/] partial").contains("data-task=\"/\" class=\"task-list-item is-checked\""));
    assert_eq!(html("- a\n- b"), "<ul>\n<li data-line=\"0\" dir=\"auto\">a</li>\n<li data-line=\"1\" dir=\"auto\">b</li>\n</ul>");
}

#[test]
fn render_data_line_is_relative_to_section() {
    // Plugins compute getSectionInfo(el).lineStart + Number(li.dataset.line).
    let text = "# Heading\n\nSome text\nmore\n\n- first\n  - [ ] nested\n- third\n";
    let r = render(text, &RenderOptions::default());
    let list = &r.sections[2];
    assert_eq!((list.kind.as_str(), list.line_start, list.line_end), ("list", 5, 7));
    assert!(list.html.contains("<li data-line=\"0\" dir=\"auto\">first"));
    assert!(list.html.contains("<li data-line=\"1\" data-task=\" \" class=\"task-list-item\" dir=\"auto\"><input data-line=\"1\""));
    assert!(list.html.contains("<li data-line=\"2\" dir=\"auto\">third"));
}

#[test]
fn render_ordered_list_start() {
    assert!(html("3. a\n4. b").starts_with("<ol start=\"3\">\n"));
}

#[test]
fn render_loose_list_wraps_paragraphs() {
    assert_eq!(
        html("- a\n\n- b"),
        "<ul>\n<li data-line=\"0\" dir=\"auto\">\n<p dir=\"auto\">a</p>\n</li>\n<li data-line=\"2\" dir=\"auto\">\n<p dir=\"auto\">b</p>\n</li>\n</ul>"
    );
}

#[test]
fn render_callout_collapsed() {
    assert_eq!(
        html("> [!tip]- Title\n> Body"),
        "<div data-callout-metadata=\"\" data-callout-fold=\"-\" data-callout=\"tip\" class=\"callout is-collapsible is-collapsed\"><div class=\"callout-title\" dir=\"auto\"><div class=\"callout-icon\"></div><div class=\"callout-title-inner\">Title</div><div class=\"callout-fold is-collapsed\"></div></div><div class=\"callout-content\" style=\"display: none;\">\n<p dir=\"auto\">Body</p>\n</div></div>"
    );
}

#[test]
fn render_callout_defaults_and_metadata() {
    let out = html("> [!NOTE|wide]\n> text");
    assert!(out.starts_with("<div data-callout-metadata=\"wide\" data-callout-fold=\"\" data-callout=\"note\" class=\"callout\">"));
    assert!(out.contains("<div class=\"callout-title-inner\">Note</div></div>"));
    let open = html("> [!faq]+ Q?\n> A");
    assert!(open.contains("class=\"callout is-collapsible\""));
    assert!(open.contains("<div class=\"callout-fold\"></div>"));
    assert!(html("> [!my-type]").contains(">My type</div>"));
}

#[test]
fn render_nested_callouts_and_title_markup() {
    let out = html("> [!question] Can **callouts** be nested?\n> > [!todo] Yes!\n> > > [!example] Deeper");
    assert_eq!(out.matches("class=\"callout\"").count(), 3);
    assert!(out.contains("<div class=\"callout-title-inner\">Can <strong>callouts</strong> be nested?</div>"));
    assert_eq!(kinds("> [!question] Q\n> > [!todo] Yes"), vec!["callout"]);
}

#[test]
fn render_plain_blockquote() {
    assert_eq!(html("> quote"), "<blockquote dir=\"auto\">\n<p dir=\"auto\">quote</p>\n</blockquote>");
}

#[test]
fn render_footnotes() {
    let r = render("A[^1] B[^1]\n\n[^1]: Note.", &RenderOptions::default());
    assert_eq!(
        r.sections[0].html,
        format!("<p dir=\"auto\">A<sup data-footnote-id=\"fnref-1\" class=\"footnote-ref\" id=\"fnref-1\"><a href=\"#fn-1\" class=\"footnote-link\" {TL}>1</a></sup> B<sup data-footnote-id=\"fnref-1-1\" class=\"footnote-ref\" id=\"fnref-1-1\"><a href=\"#fn-1\" class=\"footnote-link\" {TL}>1</a></sup></p>")
    );
    let last = r.sections.last().unwrap();
    assert_eq!(last.kind, "footnotes");
    assert_eq!(
        last.html,
        "<section class=\"footnotes\"><hr><ol><li data-footnote-id=\"fn-1\" id=\"fn-1\">Note. <a href=\"#fnref-1\" class=\"footnote-backref footnote-link\">↩︎</a> <a href=\"#fnref-1-1\" class=\"footnote-backref footnote-link\">↩︎</a></li></ol></section>"
    );
}

#[test]
fn render_inline_footnote_numbered_in_order() {
    let r = render("x^[inline] y[^a]\n\n[^a]: def", &RenderOptions::default());
    assert!(r.sections[0].html.contains("href=\"#fn-1\""));
    assert!(r.sections[0].html.contains("href=\"#fn-2\""));
    assert!(r.sections.last().unwrap().html.contains("<li data-footnote-id=\"fn-1\" id=\"fn-1\">inline <a"));
}

#[test]
fn render_undefined_footnote_is_text() {
    assert_eq!(html("x[^nope]"), "<p dir=\"auto\">x[^nope]</p>");
}

#[test]
fn render_block_id_hidden() {
    assert_eq!(html("Paragraph ^abc"), "<p dir=\"auto\">Paragraph</p>");
    assert_eq!(html("> q\n\n^id").matches("id").count(), 0);
}

#[test]
fn render_raw_html_passthrough() {
    assert_eq!(html("<div class=\"x\">\n*not md*\n</div>"), "<div class=\"x\">\n*not md*\n</div>");
    assert_eq!(html("a <b>bold</b> c"), "<p dir=\"auto\">a <b>bold</b> c</p>");
}

#[test]
fn render_frontmatter_not_rendered() {
    let r = render("---\na: 1\n---\n# H", &RenderOptions::default());
    assert_eq!((r.sections[0].kind.as_str(), r.sections[0].html.as_str()), ("yaml", ""));
    assert_eq!((r.sections[0].line_start, r.sections[0].line_end), (0, 2));
}

#[test]
fn render_line_breaks() {
    assert_eq!(html("a\nb"), "<p dir=\"auto\">a<br>\nb</p>");
    let strict = render("a\nb", &RenderOptions { strict_line_breaks: true });
    assert_eq!(strict.sections[0].html, "<p dir=\"auto\">a\nb</p>");
    let hard = render("a  \nb", &RenderOptions { strict_line_breaks: true });
    assert_eq!(hard.sections[0].html, "<p dir=\"auto\">a<br>\nb</p>");
}

#[test]
fn render_escaping() {
    assert_eq!(html("1 < 2 & 3 > 2 \\*x\\* &amp; &copy;"), "<p dir=\"auto\">1 &lt; 2 &amp; 3 &gt; 2 *x* &amp; ©</p>");
    assert!(html("[[a\"b]]").contains("data-href=\"a&quot;b\""));
}

#[test]
fn render_table_alignment() {
    assert_eq!(
        html("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |"),
        "<table>\n<thead>\n<tr>\n<th align=\"left\">a</th>\n<th align=\"center\">b</th>\n<th align=\"right\">c</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td align=\"left\">1</td>\n<td align=\"center\">2</td>\n<td align=\"right\">3</td>\n</tr>\n</tbody>\n</table>"
    );
}

#[test]
fn render_table_without_leading_pipes() {
    assert!(html("a | b\n--|--\n1 | [[x]]").contains("<td><a data-href=\"x\""));
}

#[test]
fn render_hr_and_reference_links() {
    assert_eq!(html("***"), "<hr>");
    let out = html("[text][r] and [missing][nope]\n\n[r]: https://x.com");
    assert!(out.contains("<a href=\"https://x.com\" class=\"external-link\""));
    assert!(out.contains("[missing][nope]"));
}

#[test]
fn render_sections_match_metadata_sections() {
    let text = "---\na: 1\n---\n# H\n\npara\n\n- a\n- b\n\n> [!note]\n> x\n\n```\nc\n```\n\n| a |\n|---|\n| 1 |\n";
    let m = meta(text).sections.unwrap();
    let r = render(text, &RenderOptions::default()).sections;
    assert_eq!(m.len(), r.len());
    for (a, b) in m.iter().zip(r.iter()) {
        assert_eq!((a.kind.as_str(), a.position.start.line, a.position.end.line), (b.kind.as_str(), b.line_start, b.line_end));
    }
}

#[test]
fn render_email_autolink() {
    assert!(html("mail me@example.com").contains("<a href=\"mailto:me@example.com\" class=\"external-link\""));
}

#[test]
fn render_does_not_panic_on_odd_input() {
    for s in ["", "\n", "[", "![", "[[", "]]", "`", "$", "$$", "%%", "> ", "- ", "1.", "|", "|\n|", "^", "#", "---", "***\n---", "[^", "^[", "<", "&", "\r", "\u{FEFF}", "- [ ]", "> [!", "> [!]", "```", "~~~\n", "a\u{2028}b"] {
        let _ = render(s, &RenderOptions::default());
        let _ = parse(s);
    }
}

// ---------------------------------------------------------------------------
// Word count

#[test]
fn word_count_basic() {
    assert_eq!(word_count("Hello world, it's a well-known fact."), WordCount { words: 6, characters: 36 });
}

#[test]
fn word_count_numbers() {
    assert_eq!(word_count("1,000.50 and 3.14").words, 3);
}

#[test]
fn word_count_cjk_characters_are_words() {
    assert_eq!(word_count("日本語のテキスト").words, 8);
    assert_eq!(word_count("中文 text").words, 3);
    // Hangul is written with spaces, so words, not syllables.
    assert_eq!(word_count("한국어 단어").words, 2);
}

#[test]
fn word_count_ignores_frontmatter() {
    let w = word_count("---\ntitle: many words here\n---\nTwo words");
    assert_eq!(w, WordCount { words: 2, characters: 9 });
}

#[test]
fn word_count_characters_are_utf16() {
    assert_eq!(word_count("😀a").characters, 3);
    assert_eq!(word_count("").words, 0);
}

#[test]
fn word_count_markup_is_not_words() {
    assert_eq!(word_count("# Title\n\n**bold** [[link]]").words, 3);
    // A hyphen is a word character, so a lone `-` bullet counts, as in the
    // core plugin's pattern.
    assert_eq!(word_count("- item").words, 2);
}

// ---------------------------------------------------------------------------
// YAML

#[test]
fn yaml_core_schema_scalars() {
    let v = yaml_parse("a: 1\nb: 1.5\nc: true\nd: yes\ne: ~\nf: 2024-01-01\ng: 0x1F\nh: 0o17\ni: '12'\nj: 1e3\nk: 010").unwrap();
    assert_eq!(v, json!({"a": 1, "b": 1.5, "c": true, "d": "yes", "e": null, "f": "2024-01-01", "g": 31, "h": 15, "i": "12", "j": 1000, "k": 10}));
}

#[test]
fn yaml_collections() {
    let v = yaml_parse("list:\n- a\n- b\nflow: [x, {y: 1}]\nmap:\n  inner:\n    deep: [1, 2]\n").unwrap();
    assert_eq!(v, json!({"list": ["a", "b"], "flow": ["x", {"y": 1}], "map": {"inner": {"deep": [1, 2]}}}));
}

#[test]
fn yaml_seq_of_maps() {
    assert_eq!(yaml_parse("- a: 1\n  b: 2\n- c").unwrap(), json!([{"a": 1, "b": 2}, "c"]));
}

#[test]
fn yaml_strings() {
    let v = yaml_parse("s: \"a\\tb\\u00e9\"\nq: 'it''s'\nlit: |\n  line1\n  line2\nfold: >\n  a\n  b\n\n  c\nmulti: a\n  b\nhash: foo #comment\nurl: http://x.com/#frag").unwrap();
    assert_eq!(v, json!({"s": "a\tbé", "q": "it's", "lit": "line1\nline2\n", "fold": "a b\nc\n", "multi": "a b", "hash": "foo", "url": "http://x.com/#frag"}));
}

#[test]
fn yaml_block_scalar_chomping() {
    assert_eq!(yaml_parse("a: |-\n  x\n").unwrap(), json!({"a": "x"}));
    assert_eq!(yaml_parse("a: |+\n  x\n\n").unwrap(), json!({"a": "x\n\n"}));
    assert_eq!(yaml_parse("a: >-\n  folded\n  text\n").unwrap(), json!({"a": "folded text"}));
}

#[test]
fn yaml_anchors_and_comments() {
    assert_eq!(yaml_parse("# c\na: &x 1 # one\nb: *x\n").unwrap(), json!({"a": 1, "b": 1}));
    assert!(yaml_parse("a: *nope").is_err());
}

#[test]
fn yaml_errors() {
    for bad in ["a: 1\na: 2", "t: a: b", "\tindent: 1", "x: [a, b", "x: 'open", "@at: 1", "a: 1\n---\nb: 2", "a: b\n  c: d", "a: - b"] {
        assert!(yaml_parse(bad).is_err(), "{bad:?} should fail");
    }
}

#[test]
fn yaml_wikilink_unquoted_is_nested_list() {
    // Properties.md quotes links for this reason: unquoted, `[[x]]` is YAML.
    assert_eq!(yaml_parse("a: [[Link]]").unwrap(), json!({"a": [["Link"]]}));
    assert_eq!(yaml_parse("a: \"[[Link]]\"").unwrap(), json!({"a": "[[Link]]"}));
}

#[test]
fn yaml_empty_and_scalar_documents() {
    assert_eq!(yaml_parse("").unwrap(), json!(null));
    assert_eq!(yaml_parse("# only a comment\n").unwrap(), json!(null));
    assert_eq!(yaml_parse("just text").unwrap(), json!("just text"));
    assert_eq!(yaml_parse("a: 1\n...\n").unwrap(), json!({"a": 1}));
}

#[test]
fn yaml_integer_keys_come_first() {
    let v = yaml_parse("b: 1\n2: two\n1: one").unwrap();
    assert_eq!(v.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["1", "2", "b"]);
}

#[test]
fn yaml_stringify_block_style() {
    let v = json!({"title": "Hello", "tags": ["a", "b"], "empty": null, "n": 3, "f": 1.5, "ok": true, "none": [], "obj": {"x": {"y": [1, {"z": 2}]}}});
    assert_eq!(
        yaml_stringify(&v),
        "title: Hello\ntags:\n  - a\n  - b\nempty:\nn: 3\nf: 1.5\nok: true\nnone: []\nobj:\n  x:\n    y:\n      - 1\n      - z: 2\n"
    );
}

#[test]
fn yaml_stringify_quotes_only_when_needed() {
    let v = json!({"s1": "true", "s2": "123", "s3": "", "s4": "a: b", "s5": "#tag", "s6": "[[Link]]", "s7": "it's", "s8": "say \"hi\"", "s9": " lead", "s10": "2023-01-01", "s11": "a#b", "s12": "yes", "s13": "both ' and \""});
    assert_eq!(
        yaml_stringify(&v),
        "s1: \"true\"\ns2: \"123\"\ns3: \"\"\ns4: \"a: b\"\ns5: \"#tag\"\ns6: \"[[Link]]\"\ns7: it's\ns8: say \"hi\"\ns9: \" lead\"\ns10: 2023-01-01\ns11: a#b\ns12: yes\ns13: both ' and \"\n"
    );
}

#[test]
fn yaml_stringify_multiline_and_keys() {
    assert_eq!(yaml_stringify(&json!({"a": "line1\nline2"})), "a: |-\n  line1\n  line2\n");
    assert_eq!(yaml_stringify(&json!({"x": "end\n"})), "x: |\n  end\n");
    assert_eq!(yaml_stringify(&json!({"key with space": 1, "true": 2, "#k": 3})), "key with space: 1\n\"true\": 2\n\"#k\": 3\n");
    assert_eq!(yaml_stringify(&json!([[1, 2], [3]])), "- - 1\n  - 2\n- - 3\n");
}

#[test]
fn yaml_round_trip() {
    let v = json!({"title": "A: note", "aliases": ["x", "y z"], "created": "2024-05-01", "rating": 4.5, "links": ["[[A]]", "[[B|b]]"], "deep": {"list": [{"k": "v"}]}, "text": "multi\nline\n"});
    assert_eq!(yaml_parse(&yaml_stringify(&v)).unwrap(), v);
}

// ---------------------------------------------------------------------------
// Serialisation shape

#[test]
fn metadata_json_shape() {
    let v = serde_json::to_value(meta("# H\n\n- [ ] t [[x]]\n")).unwrap();
    assert!(v.get("listItems").is_some());
    assert!(v.get("frontmatter").is_none());
    assert_eq!(v["links"][0]["displayText"], "x");
    assert_eq!(v["sections"][1]["type"], "list");
    assert_eq!(v["listItems"][0]["task"], " ");
}

#[test]
fn rendered_json_shape() {
    let v = serde_json::to_value(render("x", &RenderOptions::default())).unwrap();
    assert_eq!(v["sections"][0]["lineStart"], 0);
    assert_eq!(v["sections"][0]["kind"], "paragraph");
}
