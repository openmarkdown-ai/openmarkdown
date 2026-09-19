mod common;

use common::*;
use vault_bases::Value;

// ---------------------------------------------------------------- literals

#[test]
fn literals() {
    assert_eq!(ev("'single'"), Value::str("single"));
    assert_eq!(ev("\"double\""), Value::str("double"));
    assert_eq!(n("(2.5)"), 2.5);
    assert_eq!(ev("true"), Value::bool(true));
    assert_eq!(ev("null"), Value::Null);
    assert_eq!(s("[1, 'a', true]"), "1, a, true");
    assert_eq!(
        s("{\"name\": \"value\", n: 1}"),
        r#"{"name":"value","n":1}"#
    );
    assert_eq!(s("{}.isEmpty()"), "true");
}

#[test]
fn regexp_literal_value() {
    assert_eq!(
        ev("/a+b/gi"),
        Value::RegExp {
            value: "a+b".into(),
            flags: "gi".into()
        }
    );
    assert_eq!(s("/a+b/gi"), "/a+b/gi");
    assert!(err("/(unclosed/.matches('x')").contains("Invalid regular expression"));
}

// ---------------------------------------------------------------- properties

#[test]
fn note_property_forms() {
    assert_eq!(ev("status"), Value::str("reading"));
    assert_eq!(ev("note.status"), Value::str("reading"));
    assert_eq!(ev("note[\"status\"]"), Value::str("reading"));
    assert_eq!(ev("note[\"my prop\"]"), Value::str("spaced"));
    assert_eq!(ev("missing"), Value::Null);
    assert_eq!(ev("note.missing"), Value::Null);
    assert_eq!(
        ev("Status"),
        Value::str("reading"),
        "property names are case-insensitive"
    );
}

#[test]
fn property_type_inference() {
    assert_eq!(ev("started"), Value::date(ms("2025-06-01"), false));
    assert_eq!(ev("author"), Value::link("Frank Herbert"));
    assert_eq!(ev("related[1]"), Value::link("Hyperion"));
    assert_eq!(ev("finished"), Value::Null);
    assert_eq!(n("meta.edition"), 2.0);
    assert_eq!(s("meta[\"isbn\"]"), "978-0441013593");
}

#[test]
fn property_types_from_types_json() {
    let f = Fixture::new();
    let mut types = std::collections::BTreeMap::new();
    types.insert("started".to_string(), "text".to_string());
    types.insert("pages".to_string(), "text".to_string());
    let ctx = vault_bases::EvalContext {
        files: &f.files,
        file: f.files.first(),
        this: None,
        formulas: None,
        now_ms: NOW,
        tz_offset_min: 0,
        property_types: Some(&types),
        locals: vec![],
    };
    assert_eq!(
        vault_bases::eval("started", &ctx).unwrap(),
        Value::str("2025-06-01")
    );
    assert_eq!(vault_bases::eval("pages", &ctx).unwrap(), Value::str("412"));
}

#[test]
fn file_properties() {
    assert_eq!(s("file.name"), "Dune.md");
    assert_eq!(s("file.basename"), "Dune");
    assert_eq!(s("file.path"), "Books/Dune.md");
    assert_eq!(s("file.folder"), "Books");
    assert_eq!(s("file.ext"), "md");
    assert_eq!(n("file.size"), 2048.0);
    assert_eq!(
        ev("file.ctime"),
        Value::date(ms("2025-01-10T08:30:00Z"), true)
    );
    assert_eq!(s("file.mtime"), "2025-06-14 18:45");
    assert_eq!(s("file.tags"), "#book, #book/scifi, #to-read");
    assert_eq!(n("file.links.length"), 3.0);
    assert_eq!(ev("file.links[0]"), Value::link("Frank Herbert"));
    assert_eq!(
        ev("file.embeds"),
        Value::list(vec![Value::link("cover.png")])
    );
    assert_eq!(
        ev("file.backlinks"),
        Value::list(vec![Value::file("Reading list.md")])
    );
    assert_eq!(s("file.properties.status"), "reading");
    assert_eq!(ev("file.file"), Value::file("Books/Dune.md"));
    assert_eq!(ev("file"), Value::file("Books/Dune.md"));
}

#[test]
fn root_folder_is_slash() {
    let f = Fixture::new();
    assert_eq!(
        f.eval_on("Reading list.md", "file.folder").unwrap(),
        Value::str("/")
    );
}

#[test]
fn this_refers_to_the_context_file() {
    assert_eq!(s("this.file.name"), "Home.base");
    assert_eq!(s("this.file.folder"), "/");
    assert_eq!(ev("this"), Value::file("Home.base"));
    // with the embedding note as `this`
    let f = Fixture::new();
    let this = f.files.iter().find(|x| x.path == "People/Frank Herbert.md");
    let ctx = vault_bases::EvalContext {
        files: &f.files,
        file: f.files.first(),
        this,
        formulas: None,
        now_ms: NOW,
        tz_offset_min: 0,
        property_types: None,
        locals: vec![],
    };
    assert_eq!(
        vault_bases::eval("author == this", &ctx).unwrap(),
        Value::bool(true)
    );
    assert_eq!(
        vault_bases::eval("file.hasLink(this.file)", &ctx).unwrap(),
        Value::bool(true)
    );
    assert_eq!(
        vault_bases::eval("this.born.year", &ctx).unwrap(),
        Value::num(1920.0)
    );
    assert_eq!(
        vault_bases::eval("list(author).contains(this)", &ctx).unwrap(),
        Value::bool(true)
    );
}

// ---------------------------------------------------------------- formulas

#[test]
fn formulas_reference_formulas() {
    assert_eq!(s("formula.ppu"), "3.33");
    assert!((n("formula.total") - 29.97).abs() < 1e-9);
    assert!((n("formula.double_total") - 59.94).abs() < 1e-9);
    assert_eq!(s("formula[\"Type icon\"]"), "user");
}

#[test]
fn formula_cycles_are_detected() {
    let e = err("formula.a");
    assert!(e.contains("Circular reference"), "{e}");
    assert!(e.contains("a → b → a"), "{e}");
    assert!(err("formula.self").contains("Circular"));
}

#[test]
fn formula_errors() {
    assert!(err("formula.nope").contains("does not exist"));
    assert!(err("formula.broken").contains("syntax error"));
    assert!(err("formula").contains("formula.name"));
}

// ---------------------------------------------------------------- arithmetic

#[test]
fn arithmetic_operators() {
    assert_eq!(n("1 + 2 * 3"), 7.0);
    assert_eq!(n("(1 + 2) * 3"), 9.0);
    assert_eq!(n("7 % 3"), 1.0);
    assert_eq!(n("-7 % 3"), -1.0);
    assert_eq!(n("10 / 4"), 2.5);
    assert_eq!(n("1 / 0"), f64::INFINITY);
    assert!(n("0 % 0").is_nan());
    assert_eq!(n("-pages"), -412.0);
    assert_eq!(
        ev("radius * (2 * 3.14)"),
        Value::Null,
        "a missing property poisons arithmetic"
    );
    assert_eq!(ev("1 + missing"), Value::Null);
    assert_eq!(ev("-missing"), Value::Null);
    assert_eq!(n("pages - 12"), 400.0);
}

#[test]
fn string_concatenation() {
    assert_eq!(s("file.name + \" - \" + status"), "Dune.md - reading");
    assert_eq!(s("\"n=\" + 1.5"), "n=1.5");
    assert_eq!(s("2025 + \"-06\""), "2025-06");
    assert_eq!(s("'a' + null"), "a");
    assert_eq!(s("status + ' ' + missing"), "reading ");
    assert_eq!(s("price.toFixed(2) + \" dollars\""), "9.99 dollars");
}

#[test]
fn js_coercions() {
    assert_eq!(n("true + 1"), 2.0);
    assert_eq!(n("\"6\" * \"7\""), 42.0);
    assert!(err("\"x\" - 1").contains("Cannot subtract"));
    assert!(err("{} * 2").contains("Cannot apply"));
}

#[test]
fn list_concatenation() {
    assert_eq!(s("[1, 2] + [3]"), "1, 2, 3");
}

// ---------------------------------------------------------------- dates

#[test]
fn date_arithmetic_with_duration_strings() {
    assert_eq!(
        s("date(\"2024-12-01\") + \"1M\" + \"4h\" + \"3m\""),
        "2025-01-01 04:03"
    );
    assert_eq!(
        ev("date(\"2024-12-01\") + \"1M\" + \"4h\" + \"3m\"").to_display(0),
        "2025-01-01 04:03"
    );
    assert_eq!(
        s("(date(\"2024-12-01\") + \"1M\" + \"4h\" + \"3m\").format(\"YYYY-MM-DD HH:mm:ss\")"),
        "2025-01-01 04:03:00"
    );
    assert_eq!(s("now() + \"1 day\""), "2025-06-16 12:00");
    assert_eq!(s("today() + \"7d\""), "2025-06-22");
    assert_eq!(s("started + \"2w\""), "2025-06-15");
    assert_eq!(s("date('2025-01-31') + '1 month'"), "2025-02-28");
    assert_eq!(s("date('2024-02-29') + '1y'"), "2025-02-28");
    assert_eq!(s("now() - '2 hours'"), "2025-06-15 10:00");
    assert_eq!(s("date('2025-03-01') - '1 week'"), "2025-02-22");
}

#[test]
fn date_comparisons() {
    assert!(b("file.mtime > now() - \"1 week\""));
    assert!(!b("file.ctime > now() - '7d'"));
    assert!(b("started < today()"));
    assert!(b("started == \"2025-06-01\""));
    assert!(b("started >= date('2025-06-01')"));
    assert!(b("date('2025-01-01 12:00:00') > date('2025-01-01')"));
    assert!(!b("finished < today()"), "null never compares");
}

#[test]
fn date_subtraction_gives_a_duration() {
    assert_eq!(n("((now() + \"1d\") - now()).milliseconds"), 86_400_000.0);
    assert_eq!(n("number((now() + \"1d\") - now())"), 86_400_000.0);
    assert_eq!(n("(today() - started).days"), 14.0);
    assert_eq!(n("(now() - started).days"), 14.5);
    assert_eq!(n("(now() - started).hours"), 348.0);
    assert!(matches!(ev("now() - file.ctime"), Value::Duration { .. }));
    assert_eq!(n("(now() - started).days.round()"), 15.0);
    assert!(b("(now() - started) > duration('2 weeks')"));
    assert_eq!(s("date('2025-06-02') - date('2025-06-01')"), "1 day");
}

#[test]
fn duration_function_and_arithmetic() {
    assert_eq!(s("now() + (duration('1d') * 2)"), "2025-06-17 12:00");
    assert_eq!(n("duration('5h').hours"), 5.0);
    assert_eq!(n("(duration('5h') * 2).hours"), 10.0);
    assert_eq!(n("(duration('1d') + duration('12h')).hours"), 36.0);
    assert_eq!(n("duration('1d') / duration('6h')"), 4.0);
    assert!(err("2 * duration('5h')").contains("duration must be on the left"));
    assert_eq!(n("duration('1 year').months"), 12.0);
    assert_eq!(n("duration('P1DT12H').days"), 1.5);
    assert!(err("duration('soon')").contains("Invalid duration"));
    assert_eq!(s("duration('90m')"), "1 hour, 30 minutes");
}

#[test]
fn date_function_parsing() {
    assert_eq!(
        ev("date('2025-01-31')"),
        Value::date(ms("2025-01-31"), false)
    );
    assert_eq!(
        ev("date('2025-01-31T10:00')"),
        Value::date(ms("2025-01-31T10:00"), true)
    );
    assert_eq!(
        ev("date('2025-01-31 10:00:00')"),
        Value::date(ms("2025-01-31T10:00"), true)
    );
    assert_eq!(ev("date(started)"), ev("started"));
    assert!(err("date('not a date')").contains("Invalid date"));
    assert!(err("date(finished)").contains("date() expects a string"));
}

#[test]
fn date_fields() {
    let src = "date('2025-03-04 05:06:07')";
    assert_eq!(n(&format!("{src}.year")), 2025.0);
    assert_eq!(n(&format!("{src}.month")), 3.0);
    assert_eq!(n(&format!("{src}.day")), 4.0);
    assert_eq!(n(&format!("{src}.hour")), 5.0);
    assert_eq!(n(&format!("{src}.minute")), 6.0);
    assert_eq!(n(&format!("{src}.second")), 7.0);
    assert_eq!(n("date('2025-03-04T05:06:07.123Z').millisecond"), 123.0);
    assert_eq!(n("now().hour"), 12.0);
    assert!(err("now().week").contains("no field"));
}

#[test]
fn date_methods() {
    assert_eq!(
        s("now().date().format(\"YYYY-MM-DD HH:mm:ss\")"),
        "2025-06-15 00:00:00"
    );
    assert_eq!(ev("now().date()"), Value::date(ms("2025-06-15"), false));
    assert_eq!(s("now().time()"), "12:00:00");
    assert_eq!(
        s("file.mtime.format('dddd, MMMM Do YYYY [at] h:mm A')"),
        "Saturday, June 14th 2025 at 6:45 PM"
    );
    assert_eq!(s("file.mtime.relative()"), "17 hours ago");
    assert_eq!(s("(now() + '3d').relative()"), "in 3 days");
    assert!(!b("now().isEmpty()"));
    assert!(err("date(file.basename)").contains("Invalid date"));
}

#[test]
fn today_respects_timezone() {
    let f = Fixture::new();
    // 12:00Z is 20:00 in Singapore and 01:00 the next morning in Kiribati (+14).
    for (tz, expect) in [
        (480, "2025-06-15"),
        (840, "2025-06-16"),
        (-600, "2025-06-15"),
    ] {
        let ctx = vault_bases::EvalContext {
            tz_offset_min: tz,
            ..vault_bases::EvalContext::new(&f.files, NOW)
        };
        assert_eq!(
            vault_bases::eval("today()", &ctx).unwrap().to_display(tz),
            expect,
            "tz {tz}"
        );
    }
    let ctx = vault_bases::EvalContext {
        tz_offset_min: 480,
        ..vault_bases::EvalContext::new(&f.files, NOW)
    };
    assert_eq!(
        vault_bases::eval("now().format('HH:mm Z')", &ctx).unwrap(),
        Value::str("20:00 +08:00")
    );
    assert_eq!(
        vault_bases::eval("now().hour", &ctx).unwrap(),
        Value::num(20.0)
    );
}

// ---------------------------------------------------------------- comparison and logic

#[test]
fn comparison_operators() {
    assert!(b("rating > 4"));
    assert!(b("rating >= 4.5"));
    assert!(!b("rating < 4.5"));
    assert!(b("rating <= 4.5"));
    assert!(b("status == \"reading\""));
    assert!(b("status != \"done\""));
    assert!(b("'apple' < 'banana'"));
    assert!(b("pages == \"412\""), "number == numeric string");
    assert!(!b("pages == \"\""));
    assert!(b("null == missing"));
    assert!(!b("null == 0"));
    assert!(b("[1, 'a'] == [1, 'a']"));
    assert!(b("{a: 1} == {a: 1}"));
}

#[test]
fn boolean_operators_follow_js() {
    assert!(b("price > 0 && quantity > 0"));
    assert!(b("!done"));
    assert!(b("done || rating > 4"));
    assert_eq!(s("missing || file.name"), "Dune.md");
    assert_eq!(n("status && 5"), 5.0);
    assert_eq!(
        ev("missing && crash()"),
        Value::Null,
        "short-circuit skips the right side"
    );
    assert!(b("!!status"));
}

#[test]
fn links_compare_by_resolved_file() {
    assert!(b("author == link('Frank Herbert')"));
    assert!(b("author == link('People/Frank Herbert.md')"));
    assert!(b("author == file('People/Frank Herbert.md')"));
    assert!(b("author == 'Frank Herbert'"));
    assert!(!b("author == link('Isaac Asimov')"));
    assert!(b("link('Unresolved') == link('[[Unresolved]]')"));
    assert!(b("related.contains(link('Foundation'))"));
    assert!(b("related.containsAny(link('Nope'), link('Hyperion'))"));
}

#[test]
fn tags_compare_without_hash() {
    assert!(b("file.tags.contains('book')"));
    assert!(b("file.tags.contains('#book')"));
    assert!(b("file.tags.contains('#Book')"));
    assert!(!b("file.tags.contains('scifi')"));
}

// ---------------------------------------------------------------- global functions

#[test]
fn if_function() {
    assert_eq!(s("if(price, \"$\" + price.toFixed(2), \"\")"), "$9.99");
    assert_eq!(ev("if(missing, 'yes')"), Value::Null);
    assert_eq!(s("if(missing, 'yes', 'no')"), "no");
    assert_eq!(
        s("if(due_date < now() && status != \"Done\", \"Overdue\", \"\")"),
        ""
    );
    assert_eq!(s("if(true, 'ok', crash())"), "ok", "branches are lazy");
    assert!(err("if(true)").contains("if() takes 2 or 3"));
}

#[test]
fn number_function() {
    assert_eq!(n("number(\"3.4\")"), 3.4);
    assert_eq!(n("number(true)"), 1.0);
    assert_eq!(n("number(false)"), 0.0);
    assert_eq!(n("number(date('1970-01-02'))"), 86_400_000.0);
    assert_eq!(n("number(' 12 ')"), 12.0);
    assert!(err("number('abc')").contains("Cannot convert"));
    assert!(err("number('')").contains("Cannot convert"));
}

#[test]
fn list_function() {
    assert_eq!(s("list(\"value\")"), "value");
    assert_eq!(ev("list('value')"), Value::list(vec![Value::str("value")]));
    assert_eq!(ev("list(genres)").to_display(0), "sci-fi, classic");
    assert_eq!(ev("list(missing)"), Value::list(vec![]));
    assert_eq!(s("list(author)[0].asFile().properties.icon"), "user");
}

#[test]
fn link_function() {
    assert_eq!(ev("link('filename')"), Value::link("filename"));
    assert_eq!(
        ev("link('[[Note|Alias]]')"),
        Value::Link {
            value: "Note".into(),
            display: Some(Box::new(Value::str("Alias")))
        }
    );
    assert_eq!(s("link('filename', 'display')"), "display");
    assert_eq!(
        ev("link('https://obsidian.md')"),
        Value::link("https://obsidian.md")
    );
    assert_eq!(
        ev("link('filename', icon('plus'))"),
        Value::Link {
            value: "filename".into(),
            display: Some(Box::new(Value::Icon {
                value: "plus".into()
            }))
        }
    );
    assert_eq!(
        ev("link(file.ctime.date().toString())"),
        Value::link("2025-01-10")
    );
    assert_eq!(ev("link(file)"), Value::link("Books/Dune.md"));
    assert_eq!(
        s("link(\"https://www.google.com/maps/search/\" + file.basename.replace(\" \",\"+\"),\"Google Maps\")"),
        "Google Maps"
    );
}

#[test]
fn file_function() {
    assert_eq!(
        ev("file('People/Frank Herbert.md')"),
        Value::file("People/Frank Herbert.md")
    );
    assert_eq!(
        ev("file(link('[[Foundation]]'))"),
        Value::file("Books/Foundation.md")
    );
    assert_eq!(ev("file('Foundation')"), Value::file("Books/Foundation.md"));
    assert_eq!(ev("file('nowhere.md')"), Value::Null);
    assert_eq!(s("file('Foundation').properties.status"), "done");
    assert_eq!(s("file('Foundation').name"), "Foundation.md");
}

#[test]
fn image_icon_html_escape() {
    assert_eq!(
        ev("image('https://obsidian.md/logo.svg')"),
        Value::Image {
            value: "https://obsidian.md/logo.svg".into()
        }
    );
    assert_eq!(
        ev("image(file.embeds[0])"),
        Value::Image {
            value: "cover.png".into()
        }
    );
    assert_eq!(
        ev("image('[[cover.png]]')"),
        Value::Image {
            value: "cover.png".into()
        }
    );
    assert_eq!(
        ev("icon('arrow-right')"),
        Value::Icon {
            value: "arrow-right".into()
        }
    );
    assert_eq!(
        ev("html('<b>hi</b>')"),
        Value::Html {
            value: "<b>hi</b>".into()
        }
    );
    assert_eq!(
        s("escapeHTML('<a href=\"x\">Tom & Jerry\\'s</a>')"),
        "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;"
    );
}

#[test]
fn max_min() {
    assert_eq!(n("max(1, 5, 3)"), 5.0);
    assert_eq!(n("min(4, -2, 9)"), -2.0);
    assert_eq!(n("max(rating, pages)"), 412.0);
    assert_eq!(n("max(missing, 2)"), 2.0);
    assert_eq!(ev("max(date('2025-01-01'), started)"), ev("started"));
    assert!(err("max('a', 1)").contains("expects numbers"));
}

#[test]
fn now_today_random() {
    assert_eq!(ev("now()"), Value::date(NOW, true));
    assert_eq!(ev("today()"), Value::date(ms("2025-06-15"), false));
    let r = n("random()");
    assert!((0.0..1.0).contains(&r));
    assert!(err("now(1)").contains("takes 0 arguments"));
}

#[test]
fn unknown_function() {
    assert_eq!(err("frobnicate(1)"), "Unknown function \"frobnicate\"");
    assert_eq!(
        err("'x'.frobnicate()"),
        "Unknown function \"frobnicate\" for type string"
    );
}

// ---------------------------------------------------------------- any type

#[test]
fn any_methods() {
    assert!(b("1.isTruthy()"));
    assert!(!b("0.isTruthy()"));
    assert!(!b("''.isTruthy()"));
    assert!(b("\"example\".isType(\"string\")"));
    assert!(b("true.isType(\"boolean\")"));
    assert!(b("author.isType('link')"));
    assert!(b("author.isType('string')"));
    assert!(b("missing.isType('null')"));
    assert!(b("started.isType('date')"));
    assert!(b("genres.isType('list')"));
    assert!(b("meta.isType('object')"));
    assert!(b("file.isType('file')"));
    assert_eq!(s("123.toString()"), "123");
    assert_eq!(ev("123.toString()"), Value::str("123"));
    assert_eq!(s("started.toString()"), "2025-06-01");
    assert_eq!(s("genres.toString()"), "sci-fi, classic");
    assert!(b("missing.isEmpty()"));
    assert!(!b("missing.isTruthy()"));
}

#[test]
fn methods_on_null_error() {
    assert!(err("missing.lower()").contains("Cannot call \"lower\" on null"));
    assert_eq!(ev("missing.field"), Value::Null);
    assert_eq!(ev("missing[0]"), Value::Null);
}

// ---------------------------------------------------------------- strings

#[test]
fn string_contains_family() {
    assert!(b("\"hello\".contains(\"ell\")"));
    assert!(!b("\"hello\".contains(\"xyz\")"));
    assert!(b("\"hello\".containsAll(\"h\", \"e\")"));
    assert!(!b("\"hello\".containsAll(\"h\", \"z\")"));
    assert!(b("\"hello\".containsAny(\"x\", \"y\", \"e\")"));
    assert!(!b("\"hello\".containsAny(\"x\", \"y\")"));
    assert!(b("\"hello\".startsWith(\"he\")"));
    assert!(b("\"hello\".endsWith(\"lo\")"));
    assert!(b("file.name.startsWith('Du')"));
}

#[test]
fn string_is_empty_and_length() {
    assert!(!b("\"Hello world\".isEmpty()"));
    assert!(b("\"\".isEmpty()"));
    assert_eq!(n("\"hello\".length"), 5.0);
    assert_eq!(n("\"😀a\".length"), 3.0, "UTF-16 length, as JavaScript");
}

#[test]
fn string_case_and_trim() {
    assert_eq!(s("\"HeLLo\".lower()"), "hello");
    assert_eq!(s("\"hello\".upper()"), "HELLO");
    assert_eq!(s("\"hello world\".title()"), "Hello World");
    assert_eq!(s("\"  hi  \".trim()"), "hi");
    assert_eq!(s("file.name.lower()"), "dune.md");
}

#[test]
fn string_replace() {
    assert_eq!(s("\"a:b:c:d\".replace(\":\", \"-\")"), "a-b-c-d");
    assert_eq!(s("\"a:b:c:d\".replace(/:/, \"-\")"), "a-b:c:d");
    assert_eq!(s("\"a:b:c:d\".replace(/:/g, \"-\")"), "a-b-c-d");
    assert_eq!(
        s("\"John Smith\".replace(/(\\w+) (\\w+)/, \"$2, $1\")"),
        "Smith, John"
    );
    assert_eq!(s("\"Hello\".replace(/l+/i, \"[$&]\")"), "He[ll]o");
    assert_eq!(s("\"cost\".replace('cost', '$$5')"), "$$5");
    assert_eq!(s("\"x1y22\".replace(/\\d+/g, '#')"), "x#y#");
    assert_eq!(s("\"posts/a/b\".replace(/.*\\//, \"\")"), "b");
}

#[test]
fn string_repeat_reverse_slice() {
    assert_eq!(s("\"123\".repeat(2)"), "123123");
    assert_eq!(s("\"hello\".reverse()"), "olleh");
    assert_eq!(s("\"hello\".slice(1, 4)"), "ell");
    assert_eq!(s("\"hello\".slice(1)"), "ello");
    assert_eq!(s("\"hello\".slice(-3)"), "llo");
    assert_eq!(s("\"hello\".slice(3, 1)"), "");
    assert!(err("'x'.repeat(-1)").contains("non-negative"));
}

#[test]
fn string_split() {
    assert_eq!(
        ev("\"a,b,c,d\".split(\",\", 3)"),
        Value::list(vec![Value::str("a"), Value::str("b"), Value::str("c")])
    );
    assert_eq!(
        ev("\"a,b,c,d\".split(/,/, 3)"),
        ev("\"a,b,c,d\".split(\",\", 3)")
    );
    assert_eq!(n("\"a,b,c\".split(\",\").length"), 3.0);
    assert_eq!(s("\"abc\".split(\"\")"), "a, b, c");
    assert_eq!(s("\"a1b22c\".split(/\\d+/)"), "a, b, c");
    assert_eq!(s("file.name.split(\".\", 1)"), "Dune");
    assert_eq!(s("\"Hello world\".split(' ').sort()[0].lower()"), "hello");
}

#[test]
fn string_index() {
    assert_eq!(s("'hello'[1]"), "e");
    assert_eq!(s("'hello'[-1]"), "o");
    assert_eq!(ev("'hello'[10]"), Value::Null);
}

// ---------------------------------------------------------------- numbers

#[test]
fn number_methods() {
    assert_eq!(n("(-5).abs()"), 5.0);
    assert_eq!(n("(2.1).ceil()"), 3.0);
    assert_eq!(n("(2.9).floor()"), 2.0);
    assert_eq!(n("(2.5).round()"), 3.0);
    assert_eq!(n("(-2.5).round()"), -2.0);
    assert_eq!(n("(2.3333).round(2)"), 2.33);
    assert_eq!(n("(1234.5).round(-2)"), 1200.0);
    assert_eq!(s("(3.14159).toFixed(2)"), "3.14");
    assert_eq!(ev("(3.14159).toFixed(2)"), Value::str("3.14"));
    assert_eq!(s("(10).toFixed(1)"), "10.0");
    assert!(!b("5.isEmpty()"));
    assert!(err("(1).toFixed(101)").contains("between 0 and 100"));
    assert_eq!(s("(0.1 + 0.2)"), "0.30000000000000004");
}

// ---------------------------------------------------------------- lists

#[test]
fn list_contains_family() {
    assert!(b("[1,2,3].contains(2)"));
    assert!(!b("[1,2,3].contains(4)"));
    assert!(b("[1,2,3].containsAll(2,3)"));
    assert!(!b("[1,2,3].containsAll(2,4)"));
    assert!(b("[1,2,3].containsAny(3,4)"));
    assert!(!b("[1,2,3].containsAny(5,4)"));
    assert!(b("genres.contains('classic')"));
    assert_eq!(n("[1,2,3].length"), 3.0);
    assert!(!b("[1,2,3].isEmpty()"));
    assert!(b("[].isEmpty()"));
}

#[test]
fn list_filter_map_reduce() {
    assert_eq!(s("[1,2,3,4].filter(value > 2)"), "3, 4");
    assert_eq!(s("[1,2,3,4].map(value + 1)"), "2, 3, 4, 5");
    assert_eq!(s("['a','b','c'].map(index + ':' + value)"), "0:a, 1:b, 2:c");
    assert_eq!(s("[5,6,7].filter(index != 1)"), "5, 7");
    assert_eq!(n("[1,2,3].reduce(acc + value, 0)"), 6.0);
    assert_eq!(
        n("[3, 'x', 9, 4].filter(value.isType(\"number\")).reduce(if(acc == null || value > acc, value, acc), null)"),
        9.0
    );
    assert_eq!(ev("[].reduce(acc + value, null)"), Value::Null);
    assert_eq!(s("[[1,2],[3]].map(value.map(value * 10))"), "10, 20, 30");
    assert_eq!(s("genres.map(value.upper()).join('|')"), "SCI-FI|CLASSIC");
    assert_eq!(
        s("[1,-2,3].reduce(if(value < 0, [acc[0] + 1, acc[1]], [acc[0], acc[1] + 1]), [0, 0])"),
        "1, 2"
    );
}

#[test]
fn list_flat_join_reverse_sort_unique_slice() {
    assert_eq!(ev("[1,[2,3]].flat()"), ev("[1,2,3]"));
    assert_eq!(n("[1,[2,[3]]].flat().length"), 3.0);
    assert_eq!(s("[1,2,3].join(\",\")"), "1,2,3");
    assert_eq!(s("[1,null,3].join('-')"), "1--3");
    assert_eq!(ev("[1,2,3].reverse()"), ev("[3,2,1]"));
    assert_eq!(ev("[3, 1, 2].sort()"), ev("[1, 2, 3]"));
    assert_eq!(
        ev("[\"c\", \"a\", \"b\"].sort()"),
        ev("[\"a\", \"b\", \"c\"]")
    );
    assert_eq!(
        s("['item 10', 'Item 9', 'item 1'].sort()"),
        "item 1, Item 9, item 10"
    );
    assert_eq!(ev("[1,2,2,3].unique()"), ev("[1,2,3]"));
    assert_eq!(n("[1,'1',1].unique().length"), 2.0);
    assert_eq!(ev("[1,2,3,4].slice(1,3)"), ev("[2,3]"));
    assert_eq!(ev("[1,2,3,4].slice(2)"), ev("[3,4]"));
    assert_eq!(ev("[1,2,3,4].slice(-1)"), ev("[4]"));
}

#[test]
fn list_indexing() {
    assert_eq!(ev("genres[0]"), Value::str("sci-fi"));
    assert_eq!(ev("genres[-1]"), Value::str("classic"));
    assert_eq!(ev("genres[5]"), Value::Null);
    assert_eq!(ev("genres[0.5]"), Value::Null);
    assert_eq!(n("[[1, 2], [3]][0][1]"), 2.0);
}

#[test]
fn list_statistics() {
    assert_eq!(n("[1,2,3,4].mean()"), 2.5);
    assert_eq!(n("[1,2,3,4].sum()"), 10.0);
    assert_eq!(n("[5,1,3].median()"), 3.0);
    assert_eq!(n("[4,1,3,2].median()"), 2.5);
    assert_eq!(n("[2,4,4,4,5,5,7,9].stddev()"), 2.0);
    assert_eq!(n("[3, null, 'x', 7].mean()"), 5.0);
    assert_eq!(ev("[].mean()"), Value::Null);
    assert_eq!(n("[1,2,3].mean().round(3)"), 2.0);
    assert_eq!(n("[4, 9, 2].max()"), 9.0);
    assert_eq!(n("[4, 9, 2].min()"), 2.0);
    assert_eq!(
        ev("[date('2025-01-01'), date('2024-01-01')].earliest()"),
        ev("date('2024-01-01')")
    );
    assert_eq!(
        ev("[date('2025-01-01'), date('2024-01-01')].latest()"),
        ev("date('2025-01-01')")
    );
}

// ---------------------------------------------------------------- links, files, objects, regexp

#[test]
fn link_methods() {
    assert_eq!(
        ev("author.asFile()"),
        Value::file("People/Frank Herbert.md")
    );
    assert_eq!(ev("link('[[filename]]').asFile()"), Value::Null);
    assert!(b("link('Foundation').linksTo(file)"));
    assert!(!b("author.linksTo(file)"));
    assert_eq!(s("author.asFile().properties.born.year"), "1920");
    assert!(
        b("author.contains('Frank')"),
        "links inherit string methods"
    );
}

#[test]
fn file_methods() {
    assert!(b("file.hasTag(\"book\")"));
    assert!(b("file.hasTag(\"book\")"));
    assert!(b("file.hasTag(\"nope\", \"to-read\")"));
    assert!(!b("file.hasTag(\"scifi\")"));
    assert!(!b("file.hasTag(\"boo\")"));
    assert!(b("file.hasTag(\"#book/scifi\")"));
    assert!(b("file.hasLink(\"Textbook\")"));
    assert!(b("file.hasLink(\"Foundation\")"));
    assert!(b("file.hasLink(link('Books/Foundation.md'))"));
    assert!(b("file.hasLink(file('Foundation'))"));
    assert!(!b("file.hasLink(\"Hyperion\")"));
    assert!(b("file.hasProperty(\"status\")"));
    assert!(
        b("file.hasProperty(\"finished\")"),
        "present with a null value"
    );
    assert!(!b("file.hasProperty(\"nope\")"));
    assert!(b("file.inFolder(\"Books\")"));
    assert!(b("file.inFolder(\"/Books/\")"));
    assert!(b("file.inFolder(\"\")"));
    assert!(!b("file.inFolder(\"Book\")"));
    assert_eq!(ev("file.asLink()"), Value::link("Books/Dune.md"));
    assert_eq!(s("file.asLink('Read me')"), "Read me");
}

#[test]
fn in_folder_includes_subfolders() {
    let mut files = vault();
    files.push(vault_bases::FileRecord::new(
        "Books/Sci-fi/Old/Neuromancer.md",
    ));
    let ctx = vault_bases::EvalContext {
        file: files.last(),
        ..vault_bases::EvalContext::new(&files, NOW)
    };
    assert_eq!(
        vault_bases::eval("file.inFolder('Books')", &ctx).unwrap(),
        Value::bool(true)
    );
    assert_eq!(
        vault_bases::eval("file.inFolder('Books/Sci-fi')", &ctx).unwrap(),
        Value::bool(true)
    );
    assert_eq!(
        vault_bases::eval("file.inFolder('Sci-fi')", &ctx).unwrap(),
        Value::bool(false)
    );
}

#[test]
fn backlinks_to_this_file() {
    let f = Fixture::new();
    let row = f.files.iter().find(|x| x.path == "Reading list.md");
    let this = f.files.iter().find(|x| x.path == "Books/Dune.md");
    let ctx = vault_bases::EvalContext {
        file: row,
        this,
        ..vault_bases::EvalContext::new(&f.files, NOW)
    };
    assert_eq!(
        vault_bases::eval("file.hasLink(this.file)", &ctx).unwrap(),
        Value::bool(true)
    );
}

#[test]
fn object_methods() {
    // Frontmatter keeps document order (serde_json's `preserve_order` is on
    // for the workspace), as the Properties view shows it.
    assert_eq!(s("meta.keys()"), "isbn, edition");
    assert_eq!(s("meta.values()"), "978-0441013593, 2");
    assert_eq!(s("{z: 1, a: 2}.keys()"), "z, a");
    assert!(!b("meta.isEmpty()"));
    assert!(b("{}.isEmpty()"));
    assert_eq!(n("{\"a\": 1, \"b\": 2}.values().sum()"), 3.0);
    assert_eq!(n("{\"a\": {\"b\": [5]}}.a.b[0]"), 5.0);
}

#[test]
fn regexp_matches() {
    assert!(b("/abc/.matches(\"abcde\")"));
    assert!(!b("/^abc$/.matches(\"abcde\")"));
    assert!(b("/ABC/i.matches(\"xabcx\")"));
    assert!(b("/^\\d{4}-\\d{2}-\\d{2}$/.matches('2025-01-31')"));
    assert!(b("/a.b/s.matches('a\\nb')"));
    assert!(b("/^b/m.matches('a\\nb')"));
    assert!(b("/.pattern/.matches(file.basename + 'xpattern')"));
}

// ---------------------------------------------------------------- errors

#[test]
fn parse_errors_carry_utf16_offsets() {
    let e = Fixture::new()
        .eval_on("Books/Dune.md", "status ==")
        .unwrap_err();
    assert_eq!(e.kind, vault_bases::ErrorKind::Parse);
    assert_eq!(e.offset, Some(9));
    let e = Fixture::new()
        .eval_on("Books/Dune.md", "'😀😀' + ) ")
        .unwrap_err();
    assert_eq!(
        e.offset,
        Some(9),
        "two emoji are four UTF-16 units: '😀😀' + ) puts ')' at 9"
    );
}

#[test]
fn eval_errors_are_eval_kind() {
    let e = Fixture::new()
        .eval_on("Books/Dune.md", "date('x')")
        .unwrap_err();
    assert_eq!(e.kind, vault_bases::ErrorKind::Eval);
}

#[test]
fn arity_errors() {
    assert!(err("'x'.contains()").contains("contains() takes 1 argument"));
    assert!(err("[1].slice(1,2,3)").contains("slice() takes 0 to 2"));
    assert!(err("'x'.startsWith()").contains("startsWith() takes 1 argument, got 0"));
}

#[test]
fn deep_evaluation_is_bounded() {
    let src = "[".repeat(90) + "1" + &"]".repeat(90);
    assert!(Fixture::new().eval_on("Books/Dune.md", &src).is_ok());
    let chain = "1".to_string() + &" + 1".repeat(300);
    let r = Fixture::new().eval_on("Books/Dune.md", &chain);
    assert!(r.is_err(), "left-deep chains nest too: {r:?}");
}

// ---------------------------------------------------------------- documented examples

#[test]
fn examples_from_the_docs() {
    // Bases syntax
    assert_eq!(
        s("if(price, price.toFixed(2) + \" dollars\")"),
        "9.99 dollars"
    );
    assert_eq!(s("(price / quantity).toFixed(2)"), "3.33");
    // Formulas page
    assert!((n("price * quantity") - 29.97).abs() < 1e-9);
    assert_eq!(ev("tasks.length"), Value::Null);
    assert_eq!(s("file.name + \" - \" + status"), "Dune.md - reading");
    assert_eq!(s("started.format(\"YYYY-MM-DD\")"), "2025-06-01");
    // Functions page examples
    assert_eq!(s("\"a:b:c:d\".replace(/:/, \"-\")"), "a-b:c:d");
    assert_eq!(n("(2.3333).round(2)"), 2.33);
    // Map view
    assert_eq!(s("list(author)[0].asFile().properties.icon"), "user");
}
