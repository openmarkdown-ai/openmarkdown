//! Clipper-layer behaviour (variables, selectors, schema, prompts, properties,
//! triggers, template JSON). Knap-core parity lives in `oracle_tests.rs`.

use super::*;

const NOW: f64 = 1_700_000_000_000.0; // 2023-11-14T22:13:20Z

fn ctx() -> TemplateContext {
    TemplateContext::new("https://example.com/a", NOW)
}

fn r(tpl: &str, c: &TemplateContext) -> String {
    render_template(tpl, c).unwrap()
}

fn page_ctx() -> TemplateContext {
    let page = PageData {
        title: "  A Title  ".into(),
        author: "Ada".into(),
        content: "Body **md**".into(),
        content_html: "<p>Body <b>md</b></p>".into(),
        url: "https://www.bbc.co.uk/news/x#:~:text=hello".into(),
        description: "Desc".into(),
        published: "2024-03-05T10:00:00Z, updated".into(),
        site: "BBC".into(),
        language: "en".into(),
        word_count: 42,
        meta_tags: vec![
            MetaTag { name: Some("description".into()), property: None, content: Some("Meta desc".into()) },
            MetaTag { name: None, property: Some("og:title".into()), content: Some("OG Title".into()) },
        ],
        schema_org: vec![Value::parse_json(
            r#"{"@type":"NewsArticle","headline":"Head","author":[{"@type":"Person","name":"A"},{"@type":"Person","name":"B"}],"publisher":{"@type":"Organization","name":"Pub"},"keywords":["k1","k2"]}"#,
        )
        .unwrap()],
        ..Default::default()
    };
    let mut c = TemplateContext::new(&page.url, NOW);
    c.variables = build_variables(&page, NOW, 0);
    c.page_html = Some(
        r#"<html><body><h1 class="t">Page H1</h1><ul><li class="c">one</li><li class="c"> two </li></ul><img class="hero" src="/h.png"><div id="x"><b>bold</b></div></body></html>"#
            .into(),
    );
    c
}

#[test]
fn smoke() {
    let c = ctx().with_variable("title", "Hello");
    assert_eq!(r("# {{title|upper}}", &c), "# HELLO");
}

#[test]
fn preset_variables_are_trimmed_and_derived() {
    let c = page_ctx();
    assert_eq!(r("{{title}}|{{domain}}|{{url}}|{{words}}|{{published}}", &c), "A Title|bbc.co.uk|https://www.bbc.co.uk/news/x|42|2024-03-05T10:00:00Z");
    assert_eq!(r("{{date}}", &c), "2023-11-14T22:13:20+00:00");
    assert_eq!(r("{{noteName}}", &c), "A Title");
}

#[test]
fn meta_variables() {
    let c = page_ctx();
    assert_eq!(r("{{meta:name:description}} / {{meta:property:og:title|upper}}", &c), "Meta desc / OG TITLE");
}

#[test]
fn schema_variables_typed_and_shorthand() {
    let c = page_ctx();
    assert_eq!(r("{{schema:@NewsArticle:headline}}", &c), "Head");
    assert_eq!(r("{{schema:headline}}", &c), "Head");
    assert_eq!(r("{{schema:@NewsArticle:publisher.name}}", &c), "Pub");
    assert_eq!(r("{{schema:@NewsArticle:author[1].name}}", &c), "B");
    assert_eq!(r("{{schema:author[*].name|join:\", \"}}", &c), "A, B");
    assert_eq!(r("{{schema:keywords|join:\";\"}}", &c), "k1;k2");
    assert_eq!(r("{% for k in schema:keywords %}[{{k}}]{% endfor %}", &c), "[k1]\n[k2]");
}

#[test]
fn schema_flattening_matches_clipper_keys() {
    let c = page_ctx();
    let keys: Vec<&String> = c.variables.keys().filter(|k| k.starts_with("schema:")).collect();
    assert!(keys.iter().any(|k| *k == "schema:@NewsArticle:"), "{keys:?}");
    assert!(keys.iter().any(|k| *k == "schema:@NewsArticle:author[0].name"), "{keys:?}");
    assert!(keys.iter().any(|k| *k == "schema:@NewsArticle:publisher.name"), "{keys:?}");
}

#[test]
fn selector_variables_text_attr_and_html() {
    let c = page_ctx();
    assert_eq!(r("{{selector:h1.t}}", &c), "Page H1");
    assert_eq!(r("{{selector:li.c|join:\",\"}}", &c), "one,two");
    assert_eq!(r("{{selector:img.hero?src}}", &c), "/h.png");
    assert_eq!(r("{{selectorHtml:#x}}", &c), "<div id=\"x\"><b>bold</b></div>");
    assert_eq!(r("{{selectorHtml:#x|markdown}}", &c), "**bold**");
    assert_eq!(r("[{{selector:.missing}}]", &c), "[]");
    assert_eq!(r("{% if selector:.c %}has{% endif %}", &c), "has");
    assert_eq!(r("{% for i in selector:li.c %}- {{i}}\n{% endfor %}", &c), "- one\n- two");
}

#[test]
fn selector_with_attribute_brackets_and_combinators() {
    let c = page_ctx();
    assert_eq!(r("{{selector:ul > li[class=\"c\"]:first-child}}", &c), "one");
    assert_eq!(r("{{selector:body h1}}", &c), "Page H1");
}

#[test]
fn invalid_selector_yields_empty() {
    let c = page_ctx();
    assert_eq!(r("[{{selector:li:frobnicate}}]", &c), "[]");
}

#[test]
fn prompt_variables_are_kept_for_the_interpreter() {
    let c = ctx().with_variable("title", "T");
    assert_eq!(r("{{title}} {{\"summarize this\"|blockquote}}", &c), "T {{\"summarize this\"|blockquote}}");
    assert_eq!(r("{{ prompt:'it\\'s \"x\"' }}", &c), "{{prompt:\"it's \\\"x\\\"\"}}");
    let mut off = ctx();
    off.interpreter_enabled = false;
    assert_eq!(r("a{{\"q\"}}b", &off), "ab");
}

#[test]
fn model_variables_are_deferred_too() {
    let c = ctx();
    assert_eq!(r("{{ model | upper }}", &c), "{{model|upper}}");
}

#[test]
fn collect_and_fill_prompts() {
    let tpl = "{{\"a summary\"}}\n{{\"tags\"|split:\",\"|join:\" #\"}}\n{{\"a summary\"}}";
    let prompts = collect_prompts(&[tpl]);
    assert_eq!(prompts.len(), 2);
    assert_eq!(prompts[0].key, "prompt_1");
    assert_eq!(prompts[1].filters, "|split:\",\"|join:\" #\"");
    let c = ctx();
    let rendered = r(tpl, &c);
    let filled = fill_prompts(
        &rendered,
        &[
            ("a summary".to_string(), Value::str("Short.")),
            ("tags".to_string(), Value::str("x,y")),
        ],
        &c,
    );
    assert_eq!(filled, "Short.\nx #y\nShort.");
}

#[test]
fn fill_prompts_pretty_prints_objects() {
    let c = ctx();
    let out = fill_prompts("{{\"o\"}}", &[("o".into(), Value::parse_json(r#"{"a":1}"#).unwrap())], &c);
    assert_eq!(out, "{\n  \"a\": 1\n}");
}

#[test]
fn apply_filters_chain_parses_json_between_filters() {
    let env = FilterEnv::default();
    assert_eq!(apply_filters(&Value::str("a,b,c"), "split:\",\"|slice:1,3|join:\" \"", &env), "b c");
    assert_eq!(apply_filters(&Value::str("x"), "", &env), "x");
}

#[test]
fn parse_errors_are_errors_runtime_errors_are_partial() {
    let c = ctx();
    assert!(render_template("{% if %}", &c).is_err());
    assert!(render_template("{{ title ", &c).is_err());
    let full = render_template_full("a{{ \"<b>\"|replace_tags:\"1bad\":\"x\" }}b", &{
        let mut x = ctx();
        x.defer_prompts = false;
        x
    });
    assert_eq!(full.output, "ab");
    assert!(full.errors.iter().any(|e| e.code == "INVALID_FILTER_ARGUMENTS"));
}

#[test]
fn unknown_filters_pass_value_through_with_diagnostic() {
    let c = ctx().with_variable("t", "x");
    let full = render_template_full("{{t|frob}}", &c);
    assert_eq!(full.output, "x");
    assert_eq!(full.errors[0].code, "UNKNOWN_FILTER");
}

#[test]
fn filter_warnings_are_reported_once() {
    let c = ctx().with_variable("d", "not a date").with_variable("xs", Value::parse_json("[1,2]").unwrap());
    let full = render_template_full("{% for x in xs %}{{d|date:\"YYYY\"}}{% endfor %}", &c);
    assert_eq!(full.output, "not a date\nnot a date");
    assert_eq!(full.warnings.len(), 1, "{:?}", full.warnings);
}

#[test]
fn text_fragment_is_stripped_from_urls() {
    assert_eq!(strip_text_fragment("https://a.com/p#:~:text=foo"), "https://a.com/p");
    assert_eq!(strip_text_fragment("https://a.com/p#:~:text=foo&x=1"), "https://a.com/px=1");
    assert_eq!(strip_text_fragment("https://a.com/p#frag"), "https://a.com/p#frag");
}

#[test]
fn tz_offset_changes_local_date_output() {
    let mut c = ctx().with_variable("p", "2024-03-05T23:30:00Z");
    c.tz_offset_minutes = 8 * 60;
    assert_eq!(r("{{p|date:\"YYYY-MM-DD HH:mm Z\"}}", &c), "2024-03-06 07:30 +08:00");
}

#[test]
fn now_date_filter_uses_context_clock() {
    let c = ctx().with_variable("n", "now");
    assert_eq!(r("{{n|date:\"YYYY-MM-DD\"}}", &c), "2023-11-14");
}

#[test]
fn frontmatter_types() {
    let props = vec![
        Property { name: "title".into(), value: "He said \"hi\" C:\\new\nline".into(), kind: Some("text".into()) },
        Property { name: "tags".into(), value: "a, b, [[Link, with comma]]".into(), kind: Some("multitext".into()) },
        Property { name: "json tags".into(), value: "[\"x\",\"y\"]".into(), kind: Some("multitext".into()) },
        Property { name: "count".into(), value: "about 1,234.5 items".into(), kind: Some("number".into()) },
        Property { name: "done".into(), value: "true".into(), kind: Some("checkbox".into()) },
        Property { name: "created".into(), value: "2024-03-05".into(), kind: Some("date".into()) },
        Property { name: "empty".into(), value: "".into(), kind: None },
        Property { name: "2nd".into(), value: "v".into(), kind: None },
    ];
    let fm = generate_frontmatter(&props, &[]);
    assert_eq!(
        fm,
        "---\ntitle: \"He said \\\"hi\\\" C:\\\\new\\nline\"\ntags:\n  - \"a\"\n  - \"b\"\n  - \"[[Link, with comma]]\"\n\"json tags\":\n  - \"x\"\n  - \"y\"\ncount: 1234.5\ndone: true\ncreated: 2024-03-05\nempty:\n\"2nd\": \"v\"\n---\n"
    );
}

#[test]
fn frontmatter_empty_properties_give_no_block() {
    assert_eq!(generate_frontmatter(&[], &[]), "");
}

#[test]
fn frontmatter_property_type_map_overrides() {
    let props = vec![Property { name: "n".into(), value: "5".into(), kind: Some("text".into()) }];
    assert_eq!(generate_frontmatter(&props, &[("n".into(), "number".into())]), "---\nn: 5\n---\n");
}

#[test]
fn format_property_value_by_type() {
    assert_eq!(format_property_value("v1.5x", "number", "", 0), "1.5");
    assert_eq!(format_property_value("1", "checkbox", "", 0), "true");
    assert_eq!(format_property_value("yes", "checkbox", "", 0), "false");
    assert_eq!(format_property_value("2024-03-05T10:20:30Z", "date", "{{published}}", 0), "2024-03-05");
    assert_eq!(format_property_value("2024-03-05T10:20:30Z", "datetime", "{{published}}", 0), "2024-03-05T10:20:30+00:00");
    assert_eq!(format_property_value("05/03", "date", "{{x|date:\"DD/MM\"}}", 0), "05/03");
}

#[test]
fn template_json_round_trip_and_export_shape() {
    let json = r#"{
	"schemaVersion": "0.1.0",
	"name": "Recipe",
	"behavior": "create",
	"noteContentFormat": "{{content}}",
	"properties": [
		{"name": "source", "value": "{{url}}", "type": "text"},
		{"name": "tags", "value": "clippings"}
	],
	"triggers": ["https://cooking.example/", "schema:@Recipe"],
	"noteNameFormat": "{{title}}",
	"path": "Clippings/Recipes"
}"#;
    let t = parse_template_json(json).unwrap();
    assert_eq!(t.properties[1].kind.as_deref(), Some("text"));
    let out = serialize_template_json(&t);
    assert!(out.starts_with("{\n\t\"schemaVersion\": \"0.1.0\",\n\t\"name\": \"Recipe\""), "{out}");
    assert!(out.contains("\n\t\t{\n\t\t\t\"name\": \"source\""), "{out}");
    let again = parse_template_json(&out).unwrap();
    assert_eq!(again.name, t.name);
    assert_eq!(again.triggers, t.triggers);
    assert_eq!(again.path, "Clippings/Recipes");
    let key_order: Vec<usize> = ["schemaVersion", "behavior", "noteContentFormat", "properties", "triggers", "noteNameFormat", "path"]
        .iter()
        .map(|k| out.find(&format!("\"{k}\"")).unwrap())
        .collect();
    assert!(key_order.windows(2).all(|w| w[0] < w[1]), "{out}");
}

#[test]
fn daily_templates_omit_name_and_path() {
    let t = ClipperTemplate {
        name: "Daily".into(),
        behavior: "append-daily".into(),
        note_content_format: "- {{title}}".into(),
        note_name_format: "ignored".into(),
        path: "ignored".into(),
        ..Default::default()
    };
    let out = serialize_template_json(&t);
    assert!(!out.contains("noteNameFormat") && !out.contains("\"path\""), "{out}");
    assert!(parse_template_json(&out).is_ok());
}

#[test]
fn template_json_validation() {
    assert!(parse_template_json("[]").is_err());
    assert!(parse_template_json(r#"{"name":"x","behavior":"create","properties":[],"noteContentFormat":""}"#).is_err());
    assert!(parse_template_json(r#"{"name":"x","behavior":"create","properties":[{"name":"a","value":"b","type":"weird"}],"noteContentFormat":"","noteNameFormat":"","path":""}"#).is_err());
    assert!(parse_template_json(r#"{"name":"x","behavior":"prepend-daily","properties":[],"noteContentFormat":""}"#).is_ok());
}

#[test]
fn trigger_matching_prefix_regex_schema() {
    let schema = vec![Value::parse_json(r#"{"@type":["Recipe","Thing"],"recipeCategory":"Dessert","keywords":["a","b"],"nutrition":{"calories":"100"}}"#).unwrap()];
    assert!(match_trigger_pattern("https://example.com/", "https://example.com/a", &[]));
    assert!(!match_trigger_pattern("https://example.com/b", "https://example.com/a", &[]));
    assert!(match_trigger_pattern("/^https:\\/\\/(www\\.)?youtube\\.com\\/watch/", "https://www.youtube.com/watch?v=1", &[]));
    assert!(match_trigger_pattern("schema:@Recipe", "", &schema));
    assert!(match_trigger_pattern("schema:@Recipe.recipeCategory=Dessert", "", &schema));
    assert!(!match_trigger_pattern("schema:@Recipe.recipeCategory=Main", "", &schema));
    assert!(match_trigger_pattern("schema:@Recipe.keywords=b", "", &schema));
    assert!(match_trigger_pattern("schema:.nutrition.calories", "", &schema));
    assert!(!match_trigger_pattern("schema:@Movie", "", &schema));
}

#[test]
fn find_matching_template_prefers_url_triggers_over_schema() {
    let mk = |name: &str, triggers: &[&str]| ClipperTemplate {
        name: name.into(),
        behavior: "create".into(),
        triggers: Some(triggers.iter().map(|s| s.to_string()).collect()),
        ..Default::default()
    };
    let templates = vec![mk("schema", &["schema:@Article"]), mk("url", &["https://news.example/"])];
    let schema = vec![Value::parse_json(r#"{"@type":"Article"}"#).unwrap()];
    assert_eq!(find_matching_template(&templates, "https://news.example/story", &schema), Some(1));
    assert_eq!(find_matching_template(&templates, "https://other.example/", &schema), Some(0));
    assert_eq!(find_matching_template(&templates, "https://other.example/", &[]), None);
    assert!(match_trigger(&templates[1], "https://news.example/x", &[]));
}

#[test]
fn clip_compiles_name_properties_and_content() {
    let c = page_ctx();
    let t = ClipperTemplate {
        name: "Default".into(),
        behavior: "create".into(),
        note_name_format: "{{title}}: {{site}}?".into(),
        path: "Clippings".into(),
        note_content_format: "{{content}}\n\n{{\"summary\"}}".into(),
        properties: vec![
            Property { name: "source".into(), value: "{{url}}".into(), kind: Some("text".into()) },
            Property { name: "published".into(), value: "{{published}}".into(), kind: Some("date".into()) },
            Property { name: "tags".into(), value: "clippings,{{site|lower}}".into(), kind: Some("multitext".into()) },
        ],
        ..Default::default()
    };
    let res = clip(&t, &c, &[]);
    assert_eq!(res.note_name, "A Title BBC");
    assert_eq!(res.properties[1].value, "2024-03-05");
    assert_eq!(
        res.frontmatter,
        "---\nsource: \"https://www.bbc.co.uk/news/x\"\npublished: 2024-03-05\ntags:\n  - \"clippings\"\n  - \"bbc\"\n---\n"
    );
    assert_eq!(res.content, "Body **md**\n\n{{\"summary\"}}");
    assert!(res.full_content.starts_with("---\nsource:"));
    assert_eq!(res.prompts.len(), 1);
}

#[test]
fn sanitize_file_name_rules() {
    assert_eq!(sanitize_file_name("a/b:c*?\"<>|#^[]d"), "abcd");
    assert_eq!(sanitize_file_name(".hidden"), "_hidden");
    assert_eq!(sanitize_file_name("   "), "Untitled");
    assert_eq!(sanitize_file_name(&"x".repeat(300)).len(), 245);
}

#[test]
fn set_does_not_override_host_variables_like_the_clipper() {
    let c = ctx().with_variable("title", "Host");
    assert_eq!(r("{% set title = \"Local\" %}{{title}}", &c), "Host");
    assert_eq!(r("{% set other = title|upper %}{{other}}", &c), "HOST");
}

#[test]
fn deferred_prompt_inside_logic_survives() {
    let c = ctx().with_variable("x", "1");
    assert_eq!(r("{% if x %}{{\"q\"}}{% endif %}", &c), "{{\"q\"}}");
}

#[test]
fn markdown_filter_uses_page_url_as_base() {
    let c = ctx().with_variable("h", "<p><a href=\"/rel\">r</a> <img src=\"i.png\"></p>");
    assert_eq!(r("{{h|markdown}}", &c), "[r](https://example.com/rel) ![](https://example.com/i.png)");
}

#[test]
fn remove_html_and_html_to_json_use_the_dom() {
    let mut c = ctx().with_variable("h", "<div class=\"a\"><p>keep <b>x</b></p><img src=\"i.png\"><span class=\"ad\">ad</span></div>");
    c.defer_prompts = false;
    assert_eq!(
        r("{{h|remove_html:\"img,.ad\"}}", &c),
        "<div xmlns=\"http://www.w3.org/1999/xhtml\" class=\"a\"><p>keep <b>x</b></p></div>"
    );
    assert_eq!(
        r("{{ \"<p class='a'>Hi <b>x</b></p>\"|html_to_json }}", &c),
        r#"{"type":"element","tag":"p","attributes":{"class":"a"},"children":[{"type":"text","content":"Hi"},{"type":"element","tag":"b","children":[{"type":"text","content":"x"}]}]}"#
    );
}
