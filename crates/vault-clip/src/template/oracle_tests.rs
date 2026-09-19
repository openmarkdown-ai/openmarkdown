//! Generated from knap 0.5.0 running in Node (TZ=UTC) by oracle/gen-knap.mjs
//! from oracle/knap-cases.json. Each case renders the same template with the
//! same variables and must produce byte-identical output.

use super::*;

const VARS: &str = "{\"title\":\"Hello World\",\"author\":\"Ada Lovelace\",\"tags\":[\"alpha\",\"beta\",\"gamma\"],\"empty\":\"\",\"nums\":[3,1,2],\"people\":[{\"name\":\"Ann\",\"age\":31,\"city\":{\"name\":\"Oslo\"}},{\"name\":\"Bob\",\"age\":25,\"city\":{\"name\":\"Rome\"}}],\"obj\":{\"a\":1,\"b\":\"two\",\"c\":[1,2]},\"html\":\"<p class=\\\"x\\\" id=\\\"y\\\">Hi <b>there</b> <a href=\\\"/l\\\" style=\\\"c\\\">link</a></p><img src=\\\"a.png\\\" alt=\\\"A\\\">\",\"published\":\"2024-03-05T14:07:09Z\",\"md\":\"**bold** _it_ [link](https://x.com) `code` ==hl== ~~s~~\",\"camelText\":\"helloWorld exampleText\",\"spaced\":\"  padded  \",\"multi\":\"line one\\nline two\",\"single\":[\"solo\"],\"url\":\"https://example.com/a?b=1\",\"n\":1234.5678,\"dur\":\"PT1H30M5S\",\"str\":\"a,b,c,d\"}";

fn oracle(tpl: &str, vars: Option<&str>, expected: &str) {
    let mut ctx = TemplateContext::new("https://example.com/a", 1_700_000_000_000.0);
    ctx.defer_prompts = false;
    let json = Value::parse_json(vars.unwrap_or(VARS)).unwrap();
    if let Value::Object(m) = json {
        for (k, v) in m.0 {
            ctx.variables.insert(k, v);
        }
    }
    let out = render_template_full(tpl, &ctx);
    assert_eq!(out.output, expected, "template: {tpl}\nerrors: {:?}", out.errors);
}

#[test]
fn oracle_var() {
    oracle("{{title}}", None, "Hello World");
}

#[test]
fn oracle_upper() {
    oracle("{{title|upper}}", None, "HELLO WORLD");
}

#[test]
fn oracle_lower() {
    oracle("{{title|lower}}", None, "hello world");
}

#[test]
fn oracle_chain() {
    oracle("{{ title | lower | replace:\"o\":\"0\" }}", None, "hell0 w0rld");
}

#[test]
fn oracle_missing() {
    oracle("[{{nope}}]", None, "[]");
}

#[test]
fn oracle_array_out() {
    oracle("{{tags}}", None, "[\"alpha\",\"beta\",\"gamma\"]");
}

#[test]
fn oracle_single_array_out() {
    oracle("{{single}}", None, "solo");
}

#[test]
fn oracle_obj_out() {
    oracle("{{obj}}", None, "{\"a\":1,\"b\":\"two\",\"c\":[1,2]}");
}

#[test]
fn oracle_nested() {
    oracle("{{people[1].name}} {{obj.b}} {{people[0].city.name}}", None, "Bob two Oslo");
}

#[test]
fn oracle_if_true() {
    oracle("{% if title %}yes{% else %}no{% endif %}", None, "yes");
}

#[test]
fn oracle_if_false() {
    oracle("{% if empty %}yes{% elseif tags %}tags{% else %}no{% endif %}", None, "tags");
}

#[test]
fn oracle_if_ml() {
    oracle("Start\n{% if title %}\nhas title\n{% endif %}\nEnd", None, "Start\nhas title\nEnd");
}

#[test]
fn oracle_if_else_ml() {
    oracle("a\n{% if empty %}\nx\n{% else %}\ny\n{% endif %}\nb", None, "a\ny\nb");
}

#[test]
fn oracle_for() {
    oracle("{% for t in tags %}\n- {{t}}\n{% endfor %}\ndone", None, "- alpha\n- beta\n- gamma\ndone");
}

#[test]
fn oracle_for_loop() {
    oracle("{% for t in tags %}{{loop.index}}/{{loop.length}}:{{t}}{% if not loop.last %}, {% endif %}{% endfor %}", None, "1/3:alpha, \n2/3:beta, \n3/3:gamma");
}

#[test]
fn oracle_for_index() {
    oracle("{% for p in people %}{{p_index}}={{p.name}} {% endfor %}", None, "0=Ann \n1=Bob");
}

#[test]
fn oracle_for_nested() {
    oracle("{% for p in people %}\n## {{p.name}}\n{% for t in tags %}\n- {{t}}\n{% endfor %}\n{% endfor %}", None, "## Ann\n- alpha\n- beta\n- gamma\n## Bob\n- alpha\n- beta\n- gamma");
}

#[test]
fn oracle_for_split() {
    oracle("{% for x in str|split:\",\" %}[{{x}}]{% endfor %}", None, "[a]\n[b]\n[c]\n[d]");
}

#[test]
fn oracle_set() {
    oracle("{% set x = title|upper %}{{x}}-{{x|lower}}", None, "HELLO WORLD-hello world");
}

#[test]
fn oracle_set_in_for() {
    oracle("{% set c = \"out\" %}{% for t in tags %}{% set c = t %}{% endfor %}{{c}}", None, "out");
}

#[test]
fn oracle_compare() {
    oracle("{% if people[0].age > 30 %}old{% endif %}{% if nums contains 2 %} has2{% endif %}{% if title contains \"world\" %} w{% endif %}", None, "oldhas2w");
}

#[test]
fn oracle_logic() {
    oracle("{% if title and not empty %}A{% endif %}{% if empty or tags %}B{% endif %}{% if title == \"Hello World\" %}C{% endif %}{% if 5 >= 5 %}D{% endif %}", None, "ABCD");
}

#[test]
fn oracle_nullish() {
    oracle("{{ nope ?? \"fallback\" }} {{ empty ?? title }}", None, "fallback Hello World");
}

#[test]
fn oracle_comment() {
    oracle("a{# hidden #}b\n{# line #}\nc", None, "ab\n\nc");
}

#[test]
fn oracle_spaced_name() {
    oracle("{{ First name }}", Some("{\"First name\":\"Grace\"}"), "Grace");
}

#[test]
fn oracle_blockquote() {
    oracle("{{multi|blockquote}}", None, "> line one\n> line two");
}

#[test]
fn oracle_blockquote_arr() {
    oracle("{{tags|blockquote}}", None, "> alpha\n> beta\n> gamma");
}

#[test]
fn oracle_bold() {
    oracle("{{title|bold}} {{tags|bold}}", None, "**Hello World** [\"**alpha**\",\"**beta**\",\"**gamma**\"]");
}

#[test]
fn oracle_italic() {
    oracle("{{title|italic:\"_\"}}", None, "_Hello World_");
}

#[test]
fn oracle_strike_hl() {
    oracle("{{title|strike}} {{title|highlight:\"blue\"}}", None, "~~Hello World~~ ==🔵Hello World==");
}

#[test]
fn oracle_calc() {
    oracle("{{ \"5\"|calc:\"+10\" }} {{ \"2\"|calc:\"**3\" }} {{ \"10\"|calc:\"/3\" }} {{ \"abc\"|calc:\"+1\" }}", None, "15 8 3.3333333333 abc");
}

#[test]
fn oracle_callout() {
    oracle("{{multi|callout:(\"warning\", \"Heads up\", true)}}", None, "> [!warning]- Heads up\n> line one\n> line two");
}

#[test]
fn oracle_callout_default() {
    oracle("{{title|callout}}", None, "> [!info]\n> Hello World");
}

#[test]
fn oracle_camel() {
    oracle("{{camelText|camel}} {{\"hello world-foo_bar\"|camel}}", None, "helloWorldExampleText helloWorldFoobar");
}

#[test]
fn oracle_capitalize() {
    oracle("{{\"hELLO wORLD\"|capitalize}} {{tags|capitalize}}", None, "Hello world [\"Alpha\",\"Beta\",\"Gamma\"]");
}

#[test]
fn oracle_code() {
    oracle("{{title|code}} {{multi|code:\"js\"}}", None, "`Hello World` ```js\nline one\nline two\n```");
}

#[test]
fn oracle_code_block() {
    oracle("{{title|code_block}}", None, "```\nHello World\n```");
}

#[test]
fn oracle_comment_filter() {
    oracle("{{title|comment}}", None, "%%Hello World%%");
}

#[test]
fn oracle_compact() {
    oracle("{{ \"[1,null,\\\"\\\",\\\"x\\\"]\"|parse_json|compact }}", None, "[1,\"x\"]");
}

#[test]
fn oracle_date() {
    oracle("{{published|date:\"YYYY-MM-DD HH:mm\"}}", None, "2024-03-05 14:07");
}

#[test]
fn oracle_date_input() {
    oracle("{{ \"12/01/2024\"|date:(\"YYYY-MM-DD\", \"MM/DD/YYYY\") }}", None, "2024-12-01");
}

#[test]
fn oracle_date_tokens() {
    oracle("{{published|date:\"dddd, MMMM Do YYYY [at] h:mm A Q\"}}", None, "Tuesday, March 5th 2024 at 2:07 PM 1");
}

#[test]
fn oracle_date_default() {
    oracle("{{published|date}}", None, "2024-03-05");
}

#[test]
fn oracle_date_modify() {
    oracle("{{ \"2024-12-01\"|date_modify:\"+1 year\" }} {{ \"2024-12-01\"|date_modify:\"- 2 months\" }} {{ \"2024-01-31\"|date_modify:\"+1 month\" }}", None, "2025-12-01 2024-10-01 2024-02-29");
}

#[test]
fn oracle_decode_uri() {
    oracle("{{ \"hello%20world\"|decode_uri }} {{ \"%E4%BD%A0%E5%A5%BD\"|decode_uri }} {{ \"%E4%ZZ\"|decode_uri }}", None, "hello world 你好 %E4%ZZ");
}

#[test]
fn oracle_encode_uri() {
    oracle("{{ \"a b&c/d\"|encode_uri }}", None, "a%20b%26c%2Fd");
}

#[test]
fn oracle_duration() {
    oracle("{{dur|duration}} {{ \"3665\"|duration:\"H:mm:ss\" }} {{ \"PT6702S\"|duration }} {{ \"125\"|duration }}", None, "01:30:05 1:01:05 01:51:42 02:05");
}

#[test]
fn oracle_embed() {
    oracle("{{title|embed}} {{tags|embed:\"x\"}}", None, "![[Hello World]] [\"![[alpha|x]]\",\"![[beta|x]]\",\"![[gamma|x]]\"]");
}

#[test]
fn oracle_escape_md() {
    oracle("{{ \"*a* [b] #c\"|escape_md }}", None, "\\*a\\* \\[b\\] \\#c");
}

#[test]
fn oracle_first_last() {
    oracle("{{tags|first}} {{tags|last}} {{title|first}}", None, "alpha gamma Hello World");
}

#[test]
fn oracle_footnote() {
    oracle("{{tags|footnote}}", None, "[^1]: alpha\n\n[^2]: beta\n\n[^3]: gamma");
}

#[test]
fn oracle_footnote_obj() {
    oracle("{{ '{\"First Note\": \"C1\", \"secondNote\": \"C2\"}'|footnote }}", None, "[^first-note]: C1\n\n[^second-note]: C2");
}

#[test]
fn oracle_fragment_link() {
    oracle("{{ \"one two three\"|fragment_link:\"https://ex.com/p\" }}", None, "one two three");
}

#[test]
fn oracle_headings() {
    oracle("{{title|h2}}\n{{multi|h3}}", None, "## Hello World\n### line one\n### line two");
}

#[test]
fn oracle_hard_break() {
    oracle("{{multi|hard_break}}", None, "line one  \nline two");
}

#[test]
fn oracle_hr() {
    oracle("{{title|hr}}|{{title|hr:\"before\"}}", None, "Hello World\n\n---|---\n\nHello World");
}

#[test]
fn oracle_image() {
    oracle("{{ \"image.jpg\"|image:\"alt text\" }} {{tags|image}}", None, "![alt text](image.jpg) [\"![](alpha)\",\"![](beta)\",\"![](gamma)\"]");
}

#[test]
fn oracle_image_obj() {
    oracle("{{ '{\"a.jpg\":\"Alt 1\",\"b.jpg\":\"Alt 2\"}'|image }}", None, "[\"![Alt 1](a.jpg)\",\"![Alt 2](b.jpg)\"]");
}

#[test]
fn oracle_indent() {
    oracle("{{multi|indent}}|{{multi|indent:4}}", None, "  line one\n  line two|    line one\n    line two");
}

#[test]
fn oracle_join() {
    oracle("{{tags|join}} {{tags|join:\" \"}} {{tags|join:\"\\n\"}}", None, "alpha,beta,gamma alpha beta gamma alpha\nbeta\ngamma");
}

#[test]
fn oracle_kebab_snake_pascal() {
    oracle("{{camelText|kebab}} {{camelText|snake}} {{\"hello world-foo_bar\"|pascal}}", None, "hello-world-example-text hello_world_example_text HelloWorldFooBar");
}

#[test]
fn oracle_length() {
    oracle("{{tags|length}} {{title|length}} {{obj|length}}", None, "3 11 3");
}

#[test]
fn oracle_link() {
    oracle("{{url|link:\"author\"}} {{tags|link}}", None, "[author](https://example.com/a?b=1) [link](alpha)\n[link](beta)\n[link](gamma)");
}

#[test]
fn oracle_link_obj() {
    oracle("{{ '{\"u1\":\"A 1\",\"u2\":\"A 2\"}'|link }}", None, "[A 1](u1)\n[A 2](u2)");
}

#[test]
fn oracle_list() {
    oracle("{{tags|list}}\n{{tags|list:numbered}}\n{{tags|list:task}}\n{{tags|list:\"numbered-task\"}}", None, "- alpha\n- beta\n- gamma\n1. alpha\n2. beta\n3. gamma\n- [ ] alpha\n- [ ] beta\n- [ ] gamma\n1. [ ] alpha\n2. [ ] beta\n3. [ ] gamma");
}

#[test]
fn oracle_map_arrow() {
    oracle("{{people|map:p => p.name}}", None, "[\"Ann\",\"Bob\"]");
}

#[test]
fn oracle_map_obj() {
    oracle("{{people|map:p => ({n: p.name, c: p.city.name})}}", None, "[{\"n\":\"Ann\",\"c\":\"Oslo\"},{\"n\":\"Bob\",\"c\":\"Rome\"}]");
}

#[test]
fn oracle_map_str() {
    oracle("{{tags|map:t => \"genres/${t}\"|template:\"- ${str}\"}}", None, "- genres/alpha\n\n- genres/beta\n\n- genres/gamma");
}

#[test]
fn oracle_map_path() {
    oracle("{{people|map:\"city.name\"}}", None, "[\"Oslo\",\"Rome\"]");
}

#[test]
fn oracle_math() {
    oracle("{{ \"x^2\"|math }} {{multi|math_block}}", None, "$x^2$ $$\nline one\nline two\n$$");
}

#[test]
fn oracle_merge() {
    oracle("{{tags|merge:(\"d\",\"e\")}} {{title|merge:\"x\"}} {{tags|merge:'b,\"c,d\",e'}}", None, "[\"alpha\",\"beta\",\"gamma\",\"d\",\"e\"] [\"Hello World\",\"x\"] [\"alpha\",\"beta\",\"gamma\",\"b\",\"c,d\",\"e\"]");
}

#[test]
fn oracle_nth() {
    oracle("{{ \"[1,2,3,4,5,6,7,8,9,10]\"|nth:1,2,3:5 }} {{ \"[1,2,3,4,5,6]\"|nth:2n }} {{ \"[1,2,3,4,5]\"|nth:n+3 }} {{ \"[1,2,3]\"|nth:2 }}", None, "[1,2,3,6,7,8] [2,4,6] [3,4,5] [2]");
}

#[test]
fn oracle_number_format() {
    oracle("{{n|number_format:2}} {{n|number_format:(2,\",\",\".\")}} {{ \"1000000\"|number_format }}", None, "1,234.57 1.234,57 1,000,000");
}

#[test]
fn oracle_object() {
    oracle("{{obj|object:array}} {{obj|object:keys}} {{obj|object:values}}", None, "[[\"a\",1],[\"b\",\"two\"],[\"c\",[1,2]]] [\"a\",\"b\",\"c\"] [1,\"two\",[1,2]]");
}

#[test]
fn oracle_remove_attr() {
    oracle("{{html|remove_attr:\"class\"}}", None, "<p id=\"y\">Hi <b>there</b> <a href=\"/l\" style=\"c\">link</a></p><img src=\"a.png\" alt=\"A\">");
}

#[test]
fn oracle_remove_tags() {
    oracle("{{html|remove_tags:\"b,a\"}}", None, "<p class=\"x\" id=\"y\">Hi there link</p><img src=\"a.png\" alt=\"A\">");
}

#[test]
fn oracle_replace_simple() {
    oracle("{{ \"hello, world!\"|replace:\",\":\"\" }} {{ \"hello world\"|replace:(\"e\":\"a\",\"o\":\"0\") }}", None, "hello world! hall0 w0rld");
}

#[test]
fn oracle_replace_regex() {
    oracle("{{ \"hello world\"|replace:\"/[aeiou]/g\":\"*\" }} {{ \"HELLO world\"|replace:\"/hello/i\":\"hi\" }} {{ \"hello world\"|replace:(\"/[aeiou]/g\":\"*\",\"/\\s+/\":\"-\") }}", None, "h*ll* w*rld hi world h*ll*-w*rld");
}

#[test]
fn oracle_replace_groups() {
    oracle("{{ \"2024-03-05\"|replace:\"/(\\d+)-(\\d+)-(\\d+)/\":\"$3.$2.$1\" }}", None, "05.03.2024");
}

#[test]
fn oracle_replace_tags() {
    oracle("{{html|replace_tags:\"b\":\"strong\"}}", None, "<p class=\"x\" id=\"y\">Hi <strong>there</strong> <a href=\"/l\" style=\"c\">link</a></p><img src=\"a.png\" alt=\"A\">");
}

#[test]
fn oracle_reverse() {
    oracle("{{tags|reverse}} {{title|reverse}}", None, "[\"gamma\",\"beta\",\"alpha\"] dlroW olleH");
}

#[test]
fn oracle_round() {
    oracle("{{n|round}} {{n|round:2}} {{ \"3.7\"|round }}", None, "1235 1234.57 4");
}

#[test]
fn oracle_safe_name() {
    oracle("{{ \"a/b:c*d?#e|f.\"|safe_name }} {{ \"con.txt\"|safe_name:windows }} {{ \".hidden\"|safe_name:mac }}", None, "abcdef _con.txt _hidden");
}

#[test]
fn oracle_slice() {
    oracle("{{ \"hello\"|slice:1,4 }} {{tags|slice:1,3}} {{ \"hello\"|slice:-3 }} {{tags|slice:1,2}}", None, "ell [\"beta\",\"gamma\"] llo beta");
}

#[test]
fn oracle_sort() {
    oracle("{{nums|sort}} {{people|sort:(\"age\")|map:\"name\"}} {{tags|sort:\"desc\"}}", None, "[1,2,3] [\"Bob\",\"Ann\"] [\"gamma\",\"beta\",\"alpha\"]");
}

#[test]
fn oracle_split() {
    oracle("{{str|split:\",\"}} {{ \"a1b2c3\"|split:[0-9] }} {{ \"hey\"|split }}", None, "[\"a\",\"b\",\"c\",\"d\"] [\"a\",\"b\",\"c\",\"\"] [\"h\",\"e\",\"y\"]");
}

#[test]
fn oracle_sum() {
    oracle("{{nums|sum}} {{people|sum:\"age\"}}", None, "6 56");
}

#[test]
fn oracle_strip_attr() {
    oracle("{{html|strip_attr}} {{html|strip_attr:(\"class, id\")}}", None, "<p>Hi <b>there</b> <a>link</a></p><img> <p class=\"x\" id=\"y\">Hi <b>there</b> <a>link</a></p><img>");
}

#[test]
fn oracle_strip_md() {
    oracle("{{md|strip_md}}", None, "bold it link code hl s");
}

#[test]
fn oracle_strip_tags() {
    oracle("{{html|strip_tags}} {{html|strip_tags:(\"b\")}}", None, "Hi there link Hi <b>there</b> link");
}

#[test]
fn oracle_table() {
    oracle("{{people|table}}\n{{tags|table}}\n{{ \"[[1,2],[3,4]]\"|table:(\"A\",\"B\") }}\n{{tags|table:(\"X\",\"Y\")}}", None, "| name | age | city |\n| - | - | - |\n| Ann | 31 | [object Object] |\n| Bob | 25 | [object Object] |\n| Value |\n| - |\n| alpha |\n| beta |\n| gamma |\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| X | Y |\n| - | - |\n| alpha | beta |\n| gamma |  |");
}

#[test]
fn oracle_table_pretty() {
    oracle("{{people|table_pretty}}", None, "| name | age | city            |\n| ---- | --- | --------------- |\n| Ann  | 31  | [object Object] |\n| Bob  | 25  | [object Object] |");
}

#[test]
fn oracle_template() {
    oracle("{{ '{\"gem\":\"obsidian\",\"hardness\":5}'|template:\"${gem} has ${hardness}\" }}", None, "obsidian has 5");
}

#[test]
fn oracle_title_f() {
    oracle("{{ \"the lord of the rings\"|title }}", None, "The Lord of the Rings");
}

#[test]
fn oracle_trim() {
    oracle("[{{spaced|trim}}]", None, "[padded]");
}

#[test]
fn oracle_truncate() {
    oracle("{{title|truncate:8}} {{ \"one two three four\"|truncatewords:2 }} {{title|truncate:(5,\"...\")}}", None, "Hello W… one two… He...");
}

#[test]
fn oracle_uncamel() {
    oracle("{{ \"camelCaseXMLParser\"|uncamel }}", None, "camel case xml parser");
}

#[test]
fn oracle_unescape() {
    oracle("{{ 'Line 1\\\\nLine 2'|unescape }}", None, "Line 1\nLine 2");
}

#[test]
fn oracle_unique() {
    oracle("{{ \"[1,1,2,\\\"a\\\",\\\"a\\\"]\"|unique }}", None, "[1,2,\"a\"]");
}

#[test]
fn oracle_wikilink() {
    oracle("{{title|wikilink}} {{tags|wikilink:\"al\"}} {{ '{\"p1\":\"a1\"}'|wikilink }}", None, "[[Hello World]] [\"[[alpha|al]]\",\"[[beta|al]]\",\"[[gamma|al]]\"] [\"[[p1|a1]]\"]");
}

#[test]
fn oracle_yaml() {
    oracle("{{tags|yaml}}\n{{obj|yaml}}\n{{title|yaml}}\n{{ \"42\"|yaml }}\n{{tags|yaml:flow}}", None, "- \"alpha\"\n- \"beta\"\n- \"gamma\"\na: 1\nb: \"two\"\nc:\n  - 1\n  - 2\n\"Hello World\"\n42\n[\"alpha\",\"beta\",\"gamma\"]");
}

#[test]
fn oracle_yaml_property() {
    oracle("{{tags|yaml_property:\"genre\"}}\n{{title|yaml_property:\"name\"}}", None, "genre:\n  - \"alpha\"\n  - \"beta\"\n  - \"gamma\"\nname: \"Hello World\"");
}

#[test]
fn oracle_where() {
    oracle("{{people|where:(\"name\", \"Bob\")|map:\"age\"}}", None, "25");
}

#[test]
fn oracle_parse_json() {
    oracle("{{ '{\"a\":[1,2]}'|parse_json|object:keys }}", None, "[\"a\"]");
}

#[test]
fn oracle_unknown_filter() {
    oracle("{{title|nosuch}}", None, "Hello World");
}

#[test]
fn oracle_filter_ident_arg() {
    oracle("{{title|callout:info}}", None, "> [!info]\n> Hello World");
}

#[test]
fn oracle_string_literal() {
    oracle("{{ \"lit\" }} {{ 'single' }} {{ 42 }} {{ true }}", None, "lit single 42 true");
}

#[test]
fn oracle_member_bracket() {
    oracle("{{ tags[0] }} {{ obj[\"b\"] }} {{ people[1][\"name\"] }}", None, "alpha two Bob");
}

#[test]
fn oracle_loop_empty_iter() {
    oracle("{% for x in nope %}x{% endfor %}ok", None, "ok");
}

#[test]
fn oracle_whitespace_set() {
    oracle("a\n{% set y = 1 %}\nb", None, "a\nb");
}

#[test]
fn oracle_ws_nested_if_in_for() {
    oracle("{% for p in people %}\n{% if p.age > 30 %}\n- {{p.name}} (old)\n{% else %}\n- {{p.name}}\n{% endif %}\n{% endfor %}\nend", None, "- Ann (old)\n- Bob\nend");
}

#[test]
fn oracle_ws_empty_iteration() {
    oracle("{% for t in tags %}{% if t == \"beta\" %}{{t}}{% endif %}{% endfor %}|", None, "beta|");
}

#[test]
fn oracle_ws_blank_lines_kept() {
    oracle("a\n\n{% if title %}\n\nb\n\n{% endif %}\n\nc", None, "a\n\n\nb\n\n\nc");
}

#[test]
fn oracle_ws_inline_if() {
    oracle("x {% if title %}y{% endif %} z", None, "x y z");
}

#[test]
fn oracle_ws_set_chain() {
    oracle("{% set a = 1 %}\n{% set b = 2 %}\n{{a}}{{b}}", None, "12");
}

#[test]
fn oracle_for_over_object_error() {
    oracle("{% for x in obj %}{{x}}{% endfor %}after", None, "after");
}

#[test]
fn oracle_for_json_string() {
    oracle("{% for x in '[\"a\",\"b\"]' %}{{x}}{% endfor %}", None, "a\nb");
}

#[test]
fn oracle_loop_first_last() {
    oracle("{% for t in tags %}{% if loop.first %}[{% endif %}{{t}}{% if loop.last %}]{% else %},{% endif %}{% endfor %}", None, "[alpha,\nbeta,\ngamma]");
}

#[test]
fn oracle_compare_numbers_strings() {
    oracle("{% if \"10\" > 9 %}a{% endif %}{% if \"abc\" < \"abd\" %}b{% endif %}{% if nums|length == 3 %}c{% endif %}{% if 0 %}d{% endif %}", None, "");
}

#[test]
fn oracle_not_precedence() {
    oracle("{% if not empty and title %}A{% endif %}{% if not (empty or title) %}B{% endif %}", None, "A");
}

#[test]
fn oracle_contains_array_ci() {
    oracle("{% if tags contains \"ALPHA\" %}yes{% endif %}", None, "yes");
}

#[test]
fn oracle_nullish_chain() {
    oracle("{{ nope ?? empty ?? \"last\" }}", None, "last");
}

#[test]
fn oracle_filter_in_condition() {
    oracle("{% if title|lower contains \"hello\" %}ok{% endif %}", None, "");
}

#[test]
fn oracle_set_filtered_array() {
    oracle("{% set picked = people|map:p => p.name %}{% for n in picked %}<{{n}}>{% endfor %}", None, "<1234.5678>\n<1234.5678>");
}

#[test]
fn oracle_date_parse_formats() {
    oracle("{{ \"March 5, 2024\"|date:\"YYYY-MM-DD\" }} {{ \"2024/03/05 10:20\"|date:\"DD.MM.YY HH:mm\" }} {{ \"Tue, 05 Mar 2024 10:20:30 GMT\"|date:\"x\" }}", None, "2024-03-05 05.03.24 10:20 1709634030000");
}

#[test]
fn oracle_date_unix() {
    oracle("{{ \"1709634000\"|date:\"YYYY\" }} {{ \"05/03/2024\"|date:(\"MMM D\",\"DD/MM/YYYY\") }}", None, "1714 Mar 5");
}

#[test]
fn oracle_date_week() {
    oracle("{{published|date:\"W WW w ww GGGG\"}}", None, "10 10 10 10 2024");
}

#[test]
fn oracle_date_modify_units() {
    oracle("{{ \"2024-03-05\"|date_modify:\"+3 weeks\" }} {{ \"2024-03-05\"|date_modify:\"-10 days\" }} {{ \"2024-03-05T23:00:00Z\"|date_modify:\"+2 hours\" }}", None, "2024-03-26 2024-02-24 2024-03-06");
}

#[test]
fn oracle_replace_colon_pipe() {
    oracle("{{ \"a:b|c\"|replace:\":\":\"-\" }} {{ \"a|b\"|replace:\"|\":\"/\" }} {{ \"x.y.z\"|replace:\".\":\"\" }}", None, "a-b|c a/b xyz");
}

#[test]
fn oracle_replace_newline() {
    oracle("{{multi|replace:\"\\n\":\" / \"}}", None, "line one / line two");
}

#[test]
fn oracle_replace_dollar() {
    oracle("{{ \"cost 5\"|replace:\"5\":\"$&0\" }} {{ \"abc\"|replace:\"/(b)/\":\"[$1]\" }}", None, "cost 50 a[b]c");
}

#[test]
fn oracle_split_regex_groups() {
    oracle("{{ \"a1b22c\"|split:\"(\\d+)\" }}", None, "[\"a1b22c\"]");
}

#[test]
fn oracle_slice_negative_array() {
    oracle("{{tags|slice:-2}} {{tags|slice:0,-1}}", None, "[\"beta\",\"gamma\"] [\"alpha\",\"beta\"]");
}

#[test]
fn oracle_join_nested() {
    oracle("{{ \"[[1,2],[3]]\"|join:\";\" }}", None, "1,2;3");
}

#[test]
fn oracle_first_of_objects() {
    oracle("{{people|first}} {{people|last|length}}", None, "[object Object] 15");
}

#[test]
fn oracle_length_unicode() {
    oracle("{{ \"héllo😀\"|length }}", None, "7");
}

#[test]
fn oracle_upper_unicode() {
    oracle("{{ \"straße ǆ\"|upper }} {{ \"İSTANBUL\"|lower }}", None, "STRASSE Ǆ i̇stanbul");
}

#[test]
fn oracle_title_hyphen() {
    oracle("{{ \"a tale of two-cities and THE end\"|title }}", None, "A Tale of Two-cities and the End");
}

#[test]
fn oracle_capitalize_unicode() {
    oracle("{{ \"éCOLE\"|capitalize }}", None, "École");
}

#[test]
fn oracle_safe_name_long() {
    oracle("{{ \"   ...lead dots\"|safe_name }} {{ \"trail. \"|safe_name:windows }} {{ \"a:b\"|safe_name:linux }}", None, "   ...lead dots trail a:b");
}

#[test]
fn oracle_wikilink_empty() {
    oracle("[{{empty|wikilink}}] {{ \"[\\\"a\\\",\\\"\\\"]\"|wikilink }}", None, "[] [\"[[a]]\",\"\"]");
}

#[test]
fn oracle_link_escape() {
    oracle("{{ \"https://e.com/a b(c)\"|link:\"t*x_[y]\" }} {{ \"javascript:alert(1)\"|link }}", None, "[t\\*x\\_\\[y\\]](https://e.com/a%20b%28c%29) [link]()");
}

#[test]
fn oracle_image_array_objects() {
    oracle("{{ '[{\"a.png\":\"A\"},\"b.png\"]'|image:\"alt\" }}", None, "[\"![A](a.png)\",\"![alt](b.png)\"]");
}

#[test]
fn oracle_list_nested() {
    oracle("{{ '[\"a\",[\"b\",\"c\"],\"d\"]'|list }} {{ '[\"a\",[\"b\"]]'|list:numbered }}", None, "- a\n\t- b\n\t- c\n- d 1. a\n\t1. b");
}

#[test]
fn oracle_table_escape() {
    oracle("{{ '[{\"a|b\":\"x|y\",\"c\":null}]'|table }}", None, "| a\\|b | c |\n| - | - |\n| x\\|y |  |");
}

#[test]
fn oracle_template_nested() {
    oracle("{{ '{\"gem\":{\"name\":\"Obsidian\"},\"n\":null}'|template:\"${gem.name}-${n}-${missing}\" }}", None, "Obsidian-null-");
}

#[test]
fn oracle_template_array_newlines() {
    oracle("{{people|template:\"- ${name}\\n  age ${age}\"}}", None, "- Ann\n  age 31\n\n- Bob\n  age 25");
}

#[test]
fn oracle_map_nested_prop_array() {
    oracle("{{ '[{\"a\":{\"b\":[1,2]}}]'|map:x => x.a.b }}", None, "");
}

#[test]
fn oracle_merge_nonarray() {
    oracle("{{ \"\"|merge:\"x\" }} {{obj|merge:\"z\"}}", None, "[] [\"{\\\"a\\\":1,\\\"b\\\":\\\"two\\\",\\\"c\\\":[1,2]}\",\"z\"]");
}

#[test]
fn oracle_object_on_array() {
    oracle("{{tags|object:keys}}", None, "[\"0\",\"1\",\"2\"]");
}

#[test]
fn oracle_number_format_neg() {
    oracle("{{ \"-1234567.891\"|number_format:2 }} {{ \"0.005\"|number_format:2 }} {{ \"2.5\"|number_format }}", None, "-1,234,567.89 0.01 3");
}

#[test]
fn oracle_round_neg() {
    oracle("{{ \"-2.5\"|round }} {{ \"1.005\"|round:2 }} {{ '[1.26,\"x\"]'|round:1 }}", None, "-2 1 [1.3,\"x\"]");
}

#[test]
fn oracle_calc_chain() {
    oracle("{{ \"3\"|calc:\"*4\"|calc:\"-2\"|calc:\"^2\" }} {{ \"0.1\"|calc:\"+0.2\" }}", None, "100 0.3");
}

#[test]
fn oracle_unique_objects() {
    oracle("{{ '[{\"a\":1},{\"a\":1},{\"a\":2}]'|unique }} {{ '{\"x\":1,\"y\":1,\"z\":2}'|unique }}", None, "[{\"a\":1},{\"a\":2}] {\"y\":1,\"z\":2}");
}

#[test]
fn oracle_reverse_object() {
    oracle("{{obj|reverse}}", None, "{\"c\":[1,2],\"b\":\"two\",\"a\":1}");
}

#[test]
fn oracle_strip_md_wikilinks() {
    oracle("{{ \"# H\\n[[Page|Alias]] [[Other]] ![[img.png]] > quote\\n- [x] task\"|strip_md }}", None, "H\nAlias Other  > quote\ntask");
}

#[test]
fn oracle_strip_tags_entities() {
    oracle("{{ \"<p>a &amp; b &#8212; &#x41;</p>\\n\\n\\n\\n<b>c</b>\"|strip_tags }}", None, "a & b — A\n\nc");
}

#[test]
fn oracle_remove_attr_selfclosing() {
    oracle("{{ '<img src=\"a\" alt=\"b\" />'|remove_attr:\"alt\" }}", None, "<img src=\"a\" />");
}

#[test]
fn oracle_footnote_string() {
    oracle("{{title|footnote}}", None, "Hello World");
}

#[test]
fn oracle_duration_edge() {
    oracle("{{ \"P1DT2H\"|duration }} {{ \"59\"|duration }} {{ \"abc\"|duration }} {{ \"PT90M\"|duration:\"H[h] m\" }}", None, "26:00:00 00:59 abc 1[h] 30");
}

#[test]
fn oracle_uncamel_digits() {
    oracle("{{ \"version2Update\"|uncamel }} {{ \"HTMLParser\"|uncamel }}", None, "version2 update html parser");
}

#[test]
fn oracle_kebab_existing() {
    oracle("{{ \"already-kebab_case Mixed\"|kebab }} {{ \"Some_Title here\"|snake }}", None, "already-kebab-case-mixed some_title_here");
}

#[test]
fn oracle_pascal_edge() {
    oracle("{{ \"  lead space\"|pascal }} {{ \"a--b\"|pascal }}", None, "LeadSpace AB");
}

#[test]
fn oracle_camel_edge() {
    oracle("{{ \"HTML parser_v2\"|camel }}", None, "hTMLParserv2");
}

#[test]
fn oracle_encode_decode_obj() {
    oracle("{{ '[\"a b\",\"c/d\"]'|encode_uri }} {{ '{\"k\":\"%20\"}'|decode_uri }}", None, "[\"a%20b\",\"c%2Fd\"] {\"k\":\" \"}");
}

#[test]
fn oracle_sort_mixed() {
    oracle("{{ '[3,\"10\",null,1,\"2\"]'|sort }} {{ '[{\"n\":null},{\"n\":2},{\"n\":1}]'|sort:(\"n\",\"desc\")|map:\"n\" }}", None, "[1,\"10\",\"2\",3,null] [2,1,null]");
}

#[test]
fn oracle_sum_strings() {
    oracle("{{ '[\"1.5\",\" 2 \",\"x\",true,null]'|sum }}", None, "3.5");
}

#[test]
fn oracle_where_bool_num() {
    oracle("{{ '[{\"a\":true,\"n\":1},{\"a\":false,\"n\":2}]'|where:(\"a\", true)|map:\"n\" }} {{ '[{\"n\":1},{\"n\":\"1\"}]'|where:(\"n\", 1)|length }}", None, "1 1");
}

#[test]
fn oracle_compact_object() {
    oracle("{{ '{\"a\":\"\",\"b\":0,\"c\":null,\"d\":\" \"}'|compact }}", None, "{\"b\":0}");
}

#[test]
fn oracle_yaml_nested() {
    oracle("{{ '{\"a\":{\"b\":[1,{\"c\":\"x\"}]},\"yes\":true,\"e\":[],\"f\":{}}'|yaml }}", None, "");
}

#[test]
fn oracle_yaml_scalars() {
    oracle("{{ \"007\"|yaml }} {{ \"true\"|yaml }} {{ \"1e5\"|yaml }} {{ \"a\\\"b\"|yaml }}", None, "\"007\" true \"1e5\" \"a\\\"b\"");
}

#[test]
fn oracle_yaml_property_key_quote() {
    oracle("{{tags|yaml_property:\"my key\"}}\n{{ \"x\"|yaml_property:\"no\" }}", None, "\"my key\":\n  - \"alpha\"\n  - \"beta\"\n  - \"gamma\"\n\"no\": \"x\"");
}

#[test]
fn oracle_truncate_edge() {
    oracle("{{ \"abc\"|truncate:2 }} {{ \"abc\"|truncate:(1,\"...\") }} {{ \"a  b  c\"|truncatewords:2 }} {{ \"abc\"|truncate:0 }}", None, "a… . a  b… ");
}

#[test]
fn oracle_indent_crlf() {
    oracle("{{ \"a\\r\\nb\\n\\nc\"|indent:1 }}", None, " a\r\n b\n\n c");
}

#[test]
fn oracle_highlight_colors() {
    oracle("{{title|highlight}} {{title|highlight:\"red\"}}", None, "==Hello World== ==🔴Hello World==");
}

#[test]
fn oracle_escape_md_all() {
    oracle("{{ \"!\\\"#$%&'()*+,-./:;<=>?@[\\\\]^_`{|}~\"|escape_md }}", None, "\\!\\\"\\#\\$\\%\\&\\'\\(\\)\\*\\+\\,\\-\\.\\/\\:\\;\\<\\=\\>\\?\\@\\[\\\\\\]\\^\\_\\`\\{\\|\\}\\~");
}

#[test]
fn oracle_code_multiline_backticks() {
    oracle("{{ \"a ``` b\\nc\"|code }} {{ \"`x`\"|code }}", None, "````\na ``` b\nc\n```` `` `x` ``");
}

#[test]
fn oracle_hr_both_multiline() {
    oracle("{{multi|hr:\"both\"}}", None, "---\n\nline one\nline two\n\n---");
}

#[test]
fn oracle_heading_multiline_blank() {
    oracle("{{ \"one\\n\\n  \\ntwo\"|h4 }}", None, "#### one\n\n  \n#### two");
}

#[test]
fn oracle_parse_json_invalid() {
    oracle("{{ \"{nope\"|parse_json }}", None, "{nope");
}

#[test]
fn oracle_filter_paren_args() {
    oracle("{{title|replace:(\"Hello\":\"Bye\",\"World\":\"All\")}}", None, "Bye All");
}

#[test]
fn oracle_filter_number_arg_slice() {
    oracle("{{tags|slice:1}}", None, "[\"beta\",\"gamma\"]");
}

#[test]
fn oracle_member_on_filter_result() {
    oracle("{{ (people|first) }}", None, "");
}

#[test]
fn oracle_unclosed_if_error() {
    oracle("{% if title %}x", None, "");
}

#[test]
fn oracle_unknown_tag_error() {
    oracle("{% unless x %}y", None, "");
}

#[test]
fn oracle_comment_multiline() {
    oracle("a{#\n multi\n line #}b", None, "ab");
}
