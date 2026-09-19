use vault_bases::{
    parse_base, parse_yaml, serialize_base, stringify_yaml, validate_base, BaseFile, Direction,
    ErrorKind, FilterNode, ViewConfig, YamlValue,
};

const DOCS_EXAMPLE: &str = r#"filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
        - file.inFolder("Required Reading")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
"#;

#[test]
fn parses_the_documented_example() {
    let b = parse_base(DOCS_EXAMPLE).unwrap();
    match b.filters.as_ref().unwrap() {
        FilterNode::Or { or } => {
            assert_eq!(or.len(), 3);
            assert_eq!(or[0], FilterNode::Expr("file.hasTag(\"tag\")".into()));
            assert!(matches!(&or[1], FilterNode::And { and } if and.len() == 2));
            assert!(matches!(&or[2], FilterNode::Not { not } if not.len() == 2));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(
        b.formulas.get("formatted_price").unwrap(),
        "if(price, price.toFixed(2) + \" dollars\")"
    );
    assert_eq!(b.formulas.get("ppu").unwrap(), "(price / age).toFixed(2)");
    assert_eq!(
        b.properties
            .get("formula.formatted_price")
            .unwrap()
            .display_name
            .as_deref(),
        Some("Price")
    );
    assert_eq!(
        b.summaries.get("customAverage").unwrap(),
        "values.mean().round(3)"
    );
    let v = &b.views[0];
    assert_eq!(
        (v.view_type.as_str(), v.name.as_str(), v.limit),
        ("table", "My table", Some(10.0))
    );
    let g = v.group_by.as_ref().unwrap();
    assert_eq!(
        (g.property.as_str(), g.direction),
        ("note.age", Direction::DESC)
    );
    assert_eq!(v.order.as_ref().unwrap().len(), 5);
    assert_eq!(
        v.summaries.as_ref().unwrap().get("formula.ppu").unwrap(),
        "Average"
    );
    assert!(validate_base(&b).is_empty());
}

#[test]
fn round_trip_is_stable() {
    let b = parse_base(DOCS_EXAMPLE).unwrap();
    let out = serialize_base(&b);
    let again = parse_base(&out).unwrap();
    assert_eq!(b, again, "{out}");
    assert_eq!(serialize_base(&again), out);
}

#[test]
fn serialises_in_obsidian_style() {
    let b = parse_base(DOCS_EXAMPLE).unwrap();
    let out = serialize_base(&b);
    assert!(out.starts_with("filters:\n  or:\n    - file.hasTag(\"tag\")\n    - and:\n        - file.hasTag(\"book\")\n"), "{out}");
    assert!(
        out.contains("  formatted_price: if(price, price.toFixed(2) + \" dollars\")\n"),
        "{out}"
    );
    assert!(
        out.contains("views:\n  - type: table\n    name: My table\n    limit: 10\n"),
        "{out}"
    );
    assert!(
        out.contains("    groupBy:\n      property: note.age\n      direction: DESC\n"),
        "{out}"
    );
}

#[test]
fn preserves_unknown_keys_and_order() {
    let src = r#"summaries:
  Unique: values.unique().length
views:
  - type: map
    name: Map
    order:
      - file.name
    coordinates: note.coordinates
    markerIcon: formula.Type icon
    defaultZoom: 12
    center:
      lat: 48.85
      lng: 2.29
    mapTiles:
      - https://tiles.openfreemap.org/styles/liberty
  - type: cms
    name: Guide
    propertyDisplay1: file.fullname
    showTextPreview: true
    newNoteLocation: ""
    imageAspectRatio: 0.55
filters:
  and:
    - file.ext == "md"
pluginSetting:
  nested:
    - 1
    - two
"#;
    let b = parse_base(src).unwrap();
    assert_eq!(
        b.key_order,
        vec!["summaries", "views", "filters", "pluginSetting"]
    );
    let map = &b.views[0];
    assert_eq!(map.extra.get("defaultZoom"), Some(&YamlValue::Int(12)));
    assert!(matches!(map.extra.get("center"), Some(YamlValue::Map(_))));
    let cms = &b.views[1];
    assert_eq!(
        cms.extra.get("showTextPreview"),
        Some(&YamlValue::Bool(true))
    );
    assert_eq!(cms.image_aspect_ratio, Some(0.55));
    let out = serialize_base(&b);
    assert!(out.starts_with("summaries:\n"), "{out}");
    assert!(out.contains("    newNoteLocation: ''\n"), "{out}");
    assert!(
        out.contains("    center:\n      lat: 48.85\n      lng: 2.29\n"),
        "{out}"
    );
    assert!(
        out.contains("pluginSetting:\n  nested:\n    - 1\n    - two\n"),
        "{out}"
    );
    assert_eq!(parse_base(&out).unwrap(), b);
}

#[test]
fn view_type_specific_options() {
    let src = r#"views:
  - type: table
    name: Board
    sort:
      - property: order
        direction: ASC
      - property: file.mtime
        direction: desc
    columnSize:
      file.name: 466
      note.pr: 427.5
    rowHeight: medium
  - type: cards
    name: Covers
    cardSize: 230
    image: note.cover
    imageFit: contain
    imageAspectRatio: 0.45
  - type: list
    name: Quick
    markers: number
    separator: ", "
    indentProperties: false
"#;
    let b = parse_base(src).unwrap();
    let t = &b.views[0];
    let sort = t.sort.as_ref().unwrap();
    assert_eq!(sort[1].direction, Direction::DESC);
    assert_eq!(t.column_size.as_ref().unwrap().get("note.pr"), Some(&427.5));
    assert_eq!(t.row_height.as_deref(), Some("medium"));
    let c = &b.views[1];
    assert_eq!(
        (
            c.card_size,
            c.image.as_deref(),
            c.image_fit.as_deref(),
            c.image_aspect_ratio
        ),
        (Some(230.0), Some("note.cover"), Some("contain"), Some(0.45))
    );
    let l = &b.views[2];
    assert_eq!(
        l.extra.get("separator"),
        Some(&YamlValue::String(", ".into()))
    );
    let out = serialize_base(&b);
    assert!(
        out.contains("        direction: DESC\n"),
        "direction normalised: {out}"
    );
    assert!(out.contains("    separator: ', '\n"), "{out}");
    assert_eq!(parse_base(&out).unwrap(), b);
}

#[test]
fn string_filters_at_both_levels() {
    let b = parse_base("filters: status == \"To Do\"\nviews:\n  - type: table\n    name: T\n    filters: '!file.inFolder(\"_meta\")'\n").unwrap();
    assert_eq!(
        b.filters,
        Some(FilterNode::Expr("status == \"To Do\"".into()))
    );
    assert_eq!(
        b.views[0].filters,
        Some(FilterNode::Expr("!file.inFolder(\"_meta\")".into()))
    );
    let out = serialize_base(&b);
    assert!(out.contains("filters: status == \"To Do\"\n"), "{out}");
    assert!(
        out.contains("    filters: '!file.inFolder(\"_meta\")'\n"),
        "{out}"
    );
}

#[test]
fn multiline_formulas_use_block_scalars() {
    let src = "formulas:\n  Slug: |-\n    if(file.folder == \"posts\",\n      \"/posts/\" + file.basename,\n      \"/\")\n";
    let b = parse_base(src).unwrap();
    assert_eq!(
        b.formulas.get("Slug").unwrap(),
        "if(file.folder == \"posts\",\n  \"/posts/\" + file.basename,\n  \"/\")"
    );
    let out = serialize_base(&b);
    assert_eq!(out, src);
}

#[test]
fn block_scalar_chomping_round_trips() {
    for body in ["a\nb", "a\nb\n", "a\nb\n\n", "\nx", "a\n\nb"] {
        let mut b = BaseFile::default();
        b.formulas.insert("f", body.to_string());
        let out = serialize_base(&b);
        assert_eq!(
            parse_base(&out).unwrap().formulas.get("f").unwrap(),
            body,
            "{out:?}"
        );
    }
    // leading spaces and trailing whitespace fall back to double quotes
    for body in ["  indented\nx", "trailing \nx", "tab\tin\nx"] {
        let mut b = BaseFile::default();
        b.formulas.insert("f", body.to_string());
        let out = serialize_base(&b);
        assert_eq!(
            parse_base(&out).unwrap().formulas.get("f").unwrap(),
            body,
            "{out:?}"
        );
    }
}

#[test]
fn quoting_rules() {
    let tricky = [
        "",
        "true",
        "null",
        "123",
        "1.5",
        "0x1F",
        "- item",
        "#tag",
        "a: b",
        "a #b",
        "ends:",
        "'quoted'",
        "\"dq\"",
        "[list]",
        "{map}",
        "*alias",
        "&anchor",
        "!tag",
        "%pct",
        "@at",
        "`tick`",
        "|pipe",
        ">gt",
        "?q",
        " lead",
        "trail ",
        "yes",
        "~",
        "it's",
        "émoji 😀",
        "a\tb",
    ];
    let mut b = BaseFile::default();
    for (i, t) in tricky.iter().enumerate() {
        b.formulas.insert(format!("f{i}"), t.to_string());
        b.properties.insert(t.to_string(), Default::default());
    }
    let out = serialize_base(&b);
    let back = parse_base(&out).unwrap_or_else(|e| panic!("{e}\n{out}"));
    for (i, t) in tricky.iter().enumerate() {
        assert_eq!(back.formulas.get(&format!("f{i}")).unwrap(), t, "{out}");
        assert!(back.properties.contains_key(t), "key {t:?} in {out}");
    }
    assert!(out.contains("f0: ''\n"));
    assert!(out.contains("f1: 'true'\n"));
    assert!(out.contains("f28: it's\n"), "{out}");
}

#[test]
fn scalar_formulas_become_strings() {
    let b = parse_base("formulas:\n  n: 42\n  t: true\n  e: \"\"\n").unwrap();
    assert_eq!(b.formulas.get("n").unwrap(), "42");
    assert_eq!(b.formulas.get("t").unwrap(), "true");
    assert_eq!(b.formulas.get("e").unwrap(), "");
}

#[test]
fn empty_formula_name() {
    let src = "formulas:\n  \"\": today().year\nproperties:\n  formula.:\n    displayName: title\nviews:\n  - type: cards\n    name: On this day\n    order:\n      - formula.\n";
    let b = parse_base(src).unwrap();
    assert_eq!(b.formulas.get("").unwrap(), "today().year");
    let out = serialize_base(&b);
    assert!(out.contains("  '': today().year\n"), "{out}");
    assert_eq!(parse_base(&out).unwrap(), b);
}

#[test]
fn empty_sections_that_were_present_are_kept() {
    let b = parse_base("formulas: {}\nsummaries:\nviews:\n  - type: table\n    name: T\n    columnSize: {}\n    order: []\n").unwrap();
    let out = serialize_base(&b);
    assert!(out.contains("formulas: {}\n"), "{out}");
    assert!(out.contains("summaries: {}\n"), "{out}");
    assert!(out.contains("    columnSize: {}\n"), "{out}");
    assert!(out.contains("    order: []\n"), "{out}");
    assert!(!out.contains("properties"), "{out}");
}

#[test]
fn legacy_sort_column_key() {
    let b = parse_base("views:\n  - type: table\n    name: T\n    sort:\n      - column: note.year\n        direction: DESC\n").unwrap();
    let s = &b.views[0].sort.as_ref().unwrap()[0];
    assert_eq!(
        (s.property.as_str(), s.direction),
        ("note.year", Direction::DESC)
    );
}

#[test]
fn built_views_serialise_without_key_order() {
    let mut b = BaseFile {
        filters: Some(FilterNode::And {
            and: vec![FilterNode::Expr("file.hasTag(\"example\")".into())],
        }),
        ..Default::default()
    };
    b.views.push(ViewConfig {
        view_type: "table".into(),
        name: "Table".into(),
        ..Default::default()
    });
    assert_eq!(serialize_base(&b), "filters:\n  and:\n    - file.hasTag(\"example\")\nviews:\n  - type: table\n    name: Table\n");
}

#[test]
fn json_shape_for_the_ui() {
    let b = parse_base(DOCS_EXAMPLE).unwrap();
    let j = serde_json::to_value(&b).unwrap();
    assert_eq!(j["filters"]["or"][1]["and"][0], "file.hasTag(\"book\")");
    assert_eq!(j["views"][0]["type"], "table");
    assert_eq!(j["views"][0]["groupBy"]["direction"], "DESC");
    assert_eq!(j["properties"]["file.ext"]["displayName"], "Extension");
    let text = serde_json::to_string(&b).unwrap();
    assert!(
        text.find("\"formatted_price\"").unwrap() < text.find("\"ppu\"").unwrap(),
        "formula order kept"
    );
    let back: BaseFile = serde_json::from_value(j).unwrap();
    assert_eq!(back.formulas, b.formulas);
    assert_eq!(back.views[0].group_by, b.views[0].group_by);
    assert_eq!(
        parse_base(&serialize_base(&back)).unwrap().filters,
        b.filters
    );
}

#[test]
fn yaml_errors_have_positions() {
    let e = parse_base("views:\n  - type: table\n   name: bad indent\n").unwrap_err();
    assert_eq!(e.kind, ErrorKind::Yaml);
    assert_eq!(e.line, Some(2), "{e:?}");
    let e = parse_base("formulas:\n  a: 'unterminated\n").unwrap_err();
    assert_eq!(e.kind, ErrorKind::Yaml);
    assert!(e.offset.is_some());
}

#[test]
fn yaml_error_offsets_are_utf16() {
    let src = "formulas:\n  😀: \"x\"\n  b: [unclosed\n";
    let e = parse_base(src).unwrap_err();
    let line = e.line.unwrap() as usize;
    let line_start_u16: u32 = src
        .split_inclusive('\n')
        .take(line)
        .map(|l| l.encode_utf16().count() as u32)
        .sum();
    assert_eq!(e.offset.unwrap(), line_start_u16 + e.col.unwrap());
}

#[test]
fn schema_errors() {
    assert_eq!(
        parse_base("- a\n- b\n").unwrap_err().kind,
        ErrorKind::Schema
    );
    let e = parse_base("filters:\n  and: [a]\n  or: [b]\n").unwrap_err();
    assert!(e.message.contains("exactly one"), "{e}");
    let e = parse_base("filters:\n  xor:\n    - a\n").unwrap_err();
    assert!(e.message.contains("xor"));
    let e = parse_base("views:\n  - type: table\n    name: T\n    filters:\n      and:\n        - a\n        - nand: [b]\n").unwrap_err();
    assert_eq!(e.source.as_deref(), Some("views[0].filters.and[1]"));
    assert_eq!(
        parse_base("views: table\n").unwrap_err().source.as_deref(),
        Some("views")
    );
}

#[test]
fn validate_reports_every_syntax_error_with_source() {
    let b = parse_base(
        "filters:\n  and:\n    - status ==\nformulas:\n  ok: 1 + 1\n  bad: '\"😀\" +'\nsummaries:\n  s: values.(\nviews:\n  - type: table\n    name: T\n    filters:\n      or:\n        - x\n        - y )\n",
    )
    .unwrap();
    let errs = validate_base(&b);
    let sources: Vec<&str> = errs.iter().map(|e| e.source.as_deref().unwrap()).collect();
    assert_eq!(
        sources,
        vec![
            "filters.and[0]",
            "formulas.bad",
            "summaries.s",
            "views[0].filters.or[1]"
        ]
    );
    let bad = &errs[1];
    assert_eq!(bad.offset, Some(6), "after '\"😀\" +' = 6 UTF-16 units");
}

#[test]
fn code_block_body_parses() {
    let block = "filters:\n  and:\n    - file.hasTag(\"example\")\nviews:\n  - type: table\n    name: Table\n";
    let b = parse_base(block).unwrap();
    assert_eq!(b.views[0].name, "Table");
}

#[test]
fn generic_yaml_helpers() {
    let v = parse_yaml("a: 1\nb:\n  - x\n  - 2.5\nc: null\n").unwrap();
    assert_eq!(
        v.to_json(),
        serde_json::json!({"a": 1, "b": ["x", 2.5], "c": null})
    );
    assert_eq!(stringify_yaml(&v), "a: 1\nb:\n  - x\n  - 2.5\nc: null\n");
    assert_eq!(parse_yaml("").unwrap(), YamlValue::Null);
}

#[test]
fn real_world_thing_base_round_trips() {
    // Shapes from a large community base: literal blocks with blank lines,
    // `|+` keep-chomping, emoji display names, negative column sizes.
    let src = "summaries:\n  Since: |-\n    today()\n    -values.earliest()\n  Loss/gain: |+\n    [\n\n    values.reduce(acc, 0)\n    ][0]\n\n\n  Average: values.mean().round(2)\nproperties:\n  note.Favourite:\n    displayName: ⭐\nviews:\n  - type: table\n    name: ---------- Specific ----------\n  - type: table\n    name: Entities\n    columnSize:\n      note.Attraction: -36\n      file.name: 206\n";
    let b = parse_base(src).unwrap();
    assert_eq!(
        b.summaries.get("Loss/gain").unwrap(),
        "[\n\nvalues.reduce(acc, 0)\n][0]\n\n\n"
    );
    assert_eq!(b.views[0].name, "---------- Specific ----------");
    assert_eq!(
        b.views[1]
            .column_size
            .as_ref()
            .unwrap()
            .get("note.Attraction"),
        Some(&-36.0)
    );
    let out = serialize_base(&b);
    assert_eq!(parse_base(&out).unwrap(), b, "{out}");
}
