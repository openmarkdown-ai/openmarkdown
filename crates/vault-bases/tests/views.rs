mod common;

use common::*;
use serde_json::json;
use vault_bases::{parse_base, run_view, run_view_with, FileRecord, RunOptions, Value, ViewResult};

fn books() -> Vec<FileRecord> {
    let mut v = vec![
        rec(
            "Books/Dune.md",
            json!({"author": "Frank Herbert", "rating": 5, "status": "done", "year": 1965, "read": "2025-01-05", "owned": true, "tags": ["book"]}),
        ),
        rec(
            "Books/Book 10.md",
            json!({"author": "Anon", "rating": 3, "status": "reading", "year": 2001, "owned": false}),
        ),
        rec(
            "Books/Book 9.md",
            json!({"author": "Anon", "rating": 4, "status": "reading", "year": 1999, "read": "2024-12-31", "owned": true}),
        ),
        rec(
            "Books/Hyperion.md",
            json!({"author": "Dan Simmons", "rating": 4, "status": "done", "year": 1989, "read": "2025-03-10"}),
        ),
        rec(
            "Books/Neuromancer.md",
            json!({"author": "William Gibson", "status": "to-read", "year": 1984, "owned": false}),
        ),
        rec("Notes/Meeting.md", json!({"status": "done"})),
        FileRecord::new("Books/cover.png"),
    ];
    for (i, f) in v.iter_mut().enumerate() {
        f.size = (i as f64 + 1.0) * 100.0;
        f.mtime = NOW - (i as f64) * 86_400_000.0;
        f.ctime = NOW - 30.0 * 86_400_000.0;
        if f.path.starts_with("Books/") && f.ext == "md" {
            f.tags.push("#book".into());
        }
    }
    v[0].tags.push("#classic".into());
    v
}

fn run(yaml: &str) -> ViewResult {
    run_n(yaml, 0)
}

fn run_n(yaml: &str, view: usize) -> ViewResult {
    let base = parse_base(yaml).unwrap_or_else(|e| panic!("{e}"));
    run_view(&base, view, &books(), None, NOW, 0)
}

fn paths(r: &ViewResult) -> Vec<String> {
    r.groups
        .iter()
        .flat_map(|g| {
            g.rows.iter().map(|x| {
                x.path
                    .trim_start_matches("Books/")
                    .trim_end_matches(".md")
                    .to_string()
            })
        })
        .collect()
}

fn cell(r: &ViewResult, row: usize, col: &str) -> Value {
    r.groups
        .iter()
        .flat_map(|g| g.rows.iter())
        .nth(row)
        .unwrap()
        .cells
        .get(col)
        .cloned()
        .unwrap()
}

#[test]
fn no_filters_includes_every_file() {
    let r = run("views:\n  - type: table\n    name: All\n");
    assert_eq!(r.total, 7);
    assert_eq!(r.count, 7);
    assert_eq!(r.columns.len(), 1);
    assert_eq!(r.columns[0].id, "file.name");
    assert_eq!(r.columns[0].name, "file name");
    assert_eq!(r.groups.len(), 1);
    assert!(!r.groups[0].has_key);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
}

#[test]
fn empty_base_gets_a_default_table() {
    let r = run("");
    assert_eq!(r.total, 7);
    assert_eq!(r.view.unwrap().view_type, "table");
}

#[test]
fn missing_view_index_is_an_error() {
    let r = run_n("views:\n  - type: table\n    name: A\n", 3);
    assert_eq!(r.errors.len(), 1);
    assert!(r.errors[0].message.contains("View 3 does not exist"));
}

#[test]
fn string_filter() {
    let r = run("filters: status == \"done\"\nviews:\n  - type: table\n    name: T\n");
    assert_eq!(r.total, 3);
}

#[test]
fn and_filter() {
    let r = run("filters:\n  and:\n    - file.hasTag(\"book\")\n    - 'status != \"done\"'\nviews:\n  - type: table\n    name: T\n");
    assert_eq!(paths(&r), vec!["Book 10", "Book 9", "Neuromancer"]);
}

#[test]
fn or_filter() {
    let r = run("filters:\n  or:\n    - file.inFolder(\"Notes\")\n    - rating >= 5\nviews:\n  - type: table\n    name: T\n");
    assert_eq!(paths(&r), vec!["Dune", "Notes/Meeting"]);
}

#[test]
fn not_filter_is_none_of() {
    let r = run("filters:\n  not:\n    - file.hasTag(\"book\")\n    - file.ext == \"png\"\nviews:\n  - type: table\n    name: T\n");
    assert_eq!(paths(&r), vec!["Notes/Meeting"]);
}

#[test]
fn nested_filters_from_the_docs() {
    let yaml = r#"
filters:
  or:
    - file.hasTag("classic")
    - and:
        - file.hasTag("book")
        - rating > 3
    - not:
        - file.hasTag("book")
        - file.inFolder("Books")
views:
  - type: table
    name: T
"#;
    let r = run(yaml);
    assert_eq!(
        paths(&r),
        vec!["Dune", "Book 9", "Hyperion", "Notes/Meeting"]
    );
}

#[test]
fn global_and_view_filters_are_anded() {
    let yaml = "filters: file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    filters:\n      and:\n        - status == 'reading'\n";
    assert_eq!(paths(&run(yaml)), vec!["Book 10", "Book 9"]);
}

#[test]
fn filter_on_formula() {
    let yaml = "formulas:\n  age: 2025 - year\nviews:\n  - type: table\n    name: T\n    filters:\n      and:\n        - formula.age > 30\n        - file.ext == 'md'\n";
    assert_eq!(paths(&run(yaml)), vec!["Dune", "Hyperion", "Neuromancer"]);
}

#[test]
fn filter_by_date() {
    let yaml = "views:\n  - type: table\n    name: T\n    filters: file.mtime > now() - '2d'\n";
    assert_eq!(paths(&run(yaml)), vec!["Dune", "Book 10"]);
    let yaml = "views:\n  - type: table\n    name: T\n    filters: read >= date('2025-01-01')\n";
    assert_eq!(paths(&run(yaml)), vec!["Dune", "Hyperion"]);
}

#[test]
fn filter_syntax_error_is_reported_and_matches_nothing() {
    let r = run("filters: status ==\nviews:\n  - type: table\n    name: T\n");
    assert_eq!(r.total, 0);
    assert_eq!(r.errors.len(), 1);
    assert_eq!(r.errors[0].source.as_deref(), Some("filters"));
    assert_eq!(r.errors[0].kind, vault_bases::ErrorKind::Parse);
}

#[test]
fn filter_eval_errors_exclude_the_row_and_are_reported_once() {
    let r = run("filters: status.lower() == 'done'\nviews:\n  - type: table\n    name: T\n");
    // cover.png has no status → error for that row only
    assert_eq!(r.total, 3);
    assert_eq!(r.errors.len(), 1);
    assert!(
        r.errors[0]
            .message
            .contains("Cannot call \"lower\" on null"),
        "{}",
        r.errors[0].message
    );
}

#[test]
fn columns_use_display_names() {
    let yaml = r#"
formulas:
  formatted: 'if(rating, rating.toFixed(1) + " stars", "")'
properties:
  author:
    displayName: Author
  formula.formatted:
    displayName: "Stars"
  file.ext:
    displayName: Extension
views:
  - type: table
    name: T
    order:
      - file.name
      - note.author
      - formula.formatted
      - file.ext
      - year
      - file.mtime
    columnSize:
      note.author: 240
"#;
    let r = run(yaml);
    let names: Vec<&str> = r.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "file name",
            "Author",
            "Stars",
            "Extension",
            "year",
            "modified time"
        ]
    );
    let ids: Vec<&str> = r.columns.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "file.name",
            "note.author",
            "formula.formatted",
            "file.ext",
            "note.year",
            "file.mtime"
        ]
    );
    assert_eq!(r.columns[1].width, Some(240.0));
    assert_eq!(r.columns[2].kind, "formula");
    assert_eq!(cell(&r, 0, "formula.formatted"), Value::str("5.0 stars"));
    assert_eq!(cell(&r, 0, "file.name"), Value::str("Dune.md"));
}

#[test]
fn formula_errors_become_error_cells() {
    let yaml = "formulas:\n  bad: author.lower()\n  syntax: 'rating +'\nviews:\n  - type: table\n    name: T\n    order: [file.name, formula.bad, formula.syntax]\n";
    let r = run(yaml);
    assert_eq!(r.total, 7);
    let png = r.groups[0]
        .rows
        .iter()
        .find(|x| x.path == "Books/cover.png")
        .unwrap();
    assert!(matches!(
        png.cells.get("formula.bad"),
        Some(Value::Error { .. })
    ));
    assert_eq!(
        r.groups[0].rows[0].cells.get("formula.bad"),
        Some(&Value::str("frank herbert"))
    );
    assert!(matches!(
        r.groups[0].rows[0].cells.get("formula.syntax"),
        Some(Value::Error { .. })
    ));
    assert!(r
        .errors
        .iter()
        .any(|e| e.source.as_deref() == Some("formulas.syntax")));
}

#[test]
fn formula_cycle_in_a_view() {
    let yaml = "formulas:\n  a: formula.b\n  b: formula.a\nviews:\n  - type: table\n    name: T\n    order: [formula.a]\n";
    let r = run(yaml);
    match cell(&r, 0, "formula.a") {
        Value::Error { message } => assert!(message.contains("Circular"), "{message}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn sort_ascending_natural() {
    let yaml = "filters: file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    sort:\n      - property: file.name\n        direction: ASC\n";
    assert_eq!(
        paths(&run(yaml)),
        vec!["Book 9", "Book 10", "Dune", "Hyperion", "Neuromancer"]
    );
}

#[test]
fn sort_descending_numbers_with_nulls_last() {
    let yaml = "filters: file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    sort:\n      - property: rating\n        direction: DESC\n";
    assert_eq!(
        paths(&run(yaml)),
        vec!["Dune", "Book 9", "Hyperion", "Book 10", "Neuromancer"]
    );
    let asc = yaml.replace("DESC", "ASC");
    assert_eq!(
        paths(&run(&asc)),
        vec!["Book 10", "Book 9", "Hyperion", "Dune", "Neuromancer"]
    );
}

#[test]
fn multi_key_sort() {
    let yaml = r#"
filters: file.hasTag('book')
views:
  - type: table
    name: T
    sort:
      - property: author
        direction: ASC
      - property: year
        direction: DESC
"#;
    assert_eq!(
        paths(&run(yaml)),
        vec!["Book 10", "Book 9", "Hyperion", "Dune", "Neuromancer"]
    );
}

#[test]
fn sort_by_date_and_formula() {
    let yaml = "filters: file.hasTag('book')\nformulas:\n  neg: 0 - year\nviews:\n  - type: table\n    name: T\n    sort:\n      - property: formula.neg\n        direction: ASC\n";
    assert_eq!(
        paths(&run(yaml)),
        vec!["Book 10", "Book 9", "Hyperion", "Neuromancer", "Dune"]
    );
    let yaml = "filters: file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    sort:\n      - property: read\n        direction: DESC\n";
    assert_eq!(
        paths(&run(yaml)),
        vec!["Hyperion", "Dune", "Book 9", "Book 10", "Neuromancer"]
    );
}

#[test]
fn sort_booleans() {
    let yaml = "filters: file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    sort:\n      - property: owned\n        direction: DESC\n      - property: file.name\n        direction: ASC\n";
    assert_eq!(
        paths(&run(yaml)),
        vec!["Book 9", "Dune", "Book 10", "Neuromancer", "Hyperion"]
    );
}

#[test]
fn limit_applies_after_sort() {
    let yaml = "filters: file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    limit: 2\n    sort:\n      - property: year\n        direction: ASC\n";
    let r = run(yaml);
    assert_eq!(paths(&r), vec!["Dune", "Neuromancer"]);
    assert_eq!(r.total, 5);
    assert_eq!(r.count, 2);
}

#[test]
fn group_by_property() {
    let yaml = r#"
filters: file.ext == "md"
views:
  - type: table
    name: T
    groupBy:
      property: note.status
      direction: ASC
    sort:
      - property: file.name
        direction: ASC
"#;
    let r = run(yaml);
    let keys: Vec<String> = r.groups.iter().map(|g| g.key.to_display(0)).collect();
    assert_eq!(keys, vec!["done", "reading", "to-read"]);
    assert!(r.groups.iter().all(|g| g.has_key));
    assert_eq!(r.groups[0].rows.len(), 3);
    assert_eq!(r.groups[0].rows[0].path, "Books/Dune.md");
    assert_eq!(
        r.groups[1]
            .rows
            .iter()
            .map(|x| x.path.as_str())
            .collect::<Vec<_>>(),
        vec!["Books/Book 9.md", "Books/Book 10.md"]
    );
}

#[test]
fn group_by_descending_with_missing_group_last() {
    let yaml = "views:\n  - type: table\n    name: T\n    groupBy:\n      property: rating\n      direction: DESC\n";
    let r = run(yaml);
    let keys: Vec<Value> = r.groups.iter().map(|g| g.key.clone()).collect();
    assert_eq!(
        keys,
        vec![
            Value::num(5.0),
            Value::num(4.0),
            Value::num(3.0),
            Value::Null
        ]
    );
    assert!(!r.groups[3].has_key);
    assert_eq!(r.groups[3].rows.len(), 3);
}

#[test]
fn group_by_formula() {
    let yaml = "filters: file.hasTag('book')\nformulas:\n  decade: (year / 10).floor() * 10\nviews:\n  - type: table\n    name: T\n    groupBy:\n      property: formula.decade\n      direction: ASC\n";
    let r = run(yaml);
    let keys: Vec<String> = r.groups.iter().map(|g| g.key.to_display(0)).collect();
    assert_eq!(keys, vec!["1960", "1980", "1990", "2000"]);
    assert_eq!(r.groups[1].rows.len(), 2);
}

#[test]
fn group_by_file_folder() {
    let yaml = "filters: file.ext == 'md'\nviews:\n  - type: table\n    name: T\n    groupBy:\n      property: file.folder\n      direction: DESC\n";
    let r = run(yaml);
    let keys: Vec<String> = r.groups.iter().map(|g| g.key.to_display(0)).collect();
    assert_eq!(keys, vec!["Notes", "Books"]);
}

#[test]
fn builtin_numeric_summaries() {
    let yaml = r#"
filters: file.hasTag('book')
views:
  - type: table
    name: T
    order: [file.name, rating]
    summaries:
      rating: Average
"#;
    let r = run(yaml);
    assert_eq!(r.summaries.get("note.rating"), Some(&Value::num(4.0)));
    assert_eq!(r.columns[1].summary.as_deref(), Some("Average"));
    for (name, expect) in [
        ("Sum", 16.0),
        ("Min", 3.0),
        ("Max", 5.0),
        ("Range", 2.0),
        ("Median", 4.0),
        ("Stddev", (0.5f64).sqrt()),
        ("Empty", 1.0),
        ("Filled", 4.0),
        ("Unique", 3.0),
    ] {
        let r = run(&yaml.replace("Average", name));
        match r.summaries.get("note.rating") {
            Some(Value::Number { value }) => {
                assert!((value - expect).abs() < 1e-9, "{name}: {value}")
            }
            other => panic!("{name}: {other:?}"),
        }
    }
}

#[test]
fn builtin_date_and_boolean_summaries() {
    let yaml = "filters: file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    summaries:\n      read: Earliest\n      note.owned: Checked\n";
    let r = run(yaml);
    assert_eq!(
        r.summaries.get("note.read"),
        Some(&Value::date(ms("2024-12-31"), false))
    );
    assert_eq!(r.summaries.get("note.owned"), Some(&Value::num(2.0)));
    let r = run(&yaml
        .replace("Earliest", "Latest")
        .replace("Checked", "Unchecked"));
    assert_eq!(
        r.summaries.get("note.read"),
        Some(&Value::date(ms("2025-03-10"), false))
    );
    assert_eq!(r.summaries.get("note.owned"), Some(&Value::num(2.0)));
    let r = run(&yaml.replace("Earliest", "Range"));
    match r.summaries.get("note.read") {
        Some(Value::Duration { value, .. }) => assert_eq!(*value, 69.0 * 86_400_000.0),
        other => panic!("{other:?}"),
    }
}

#[test]
fn custom_summary_formulas() {
    let yaml = r#"
summaries:
  customAverage: 'values.mean().round(3)'
  Filled: values.filter(!value.isType("null")).length
  span: 'values.max() - values.min()'
filters: file.hasTag('book')
formulas:
  third: rating / 3
views:
  - type: table
    name: T
    summaries:
      formula.third: customAverage
      rating: Filled
      year: span
"#;
    let r = run(yaml);
    assert_eq!(r.summaries.get("formula.third"), Some(&Value::num(1.333)));
    assert_eq!(
        r.summaries.get("note.rating"),
        Some(&Value::num(4.0)),
        "custom summaries override built-ins"
    );
    assert_eq!(r.summaries.get("note.year"), Some(&Value::num(36.0)));
}

#[test]
fn summaries_per_group() {
    let yaml = "filters: file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    groupBy:\n      property: status\n      direction: ASC\n    summaries:\n      rating: Sum\n";
    let r = run(yaml);
    let sums: Vec<Value> = r
        .groups
        .iter()
        .map(|g| g.summaries.get("note.rating").cloned().unwrap())
        .collect();
    assert_eq!(
        sums,
        vec![Value::num(9.0), Value::num(7.0), Value::num(0.0)]
    );
    assert_eq!(r.summaries.get("note.rating"), Some(&Value::num(16.0)));
}

#[test]
fn unknown_summary_is_an_error_value() {
    let r = run("views:\n  - type: table\n    name: T\n    summaries:\n      rating: Mode\n");
    assert!(matches!(
        r.summaries.get("note.rating"),
        Some(Value::Error { .. })
    ));
}

#[test]
fn summaries_respect_limit() {
    let yaml = "filters: file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    limit: 2\n    sort:\n      - property: rating\n        direction: DESC\n    summaries:\n      rating: Sum\n";
    assert_eq!(
        run(yaml).summaries.get("note.rating"),
        Some(&Value::num(9.0))
    );
}

#[test]
fn this_in_filters() {
    let base = parse_base(
        "filters: file.hasLink(this.file)\nviews:\n  - type: table\n    name: Backlinks\n",
    )
    .unwrap();
    let mut files = books();
    files[1].links = vec!["Dune".into()];
    files[3].links = vec!["[[Books/Dune.md|the book]]".into()];
    let this = files[0].clone();
    let r = run_view(&base, 0, &files, Some(&this), NOW, 0);
    assert_eq!(paths(&r), vec!["Book 10", "Hyperion"]);
}

#[test]
fn view_uses_timezone() {
    let base = parse_base("formulas:\n  d: file.mtime.format('YYYY-MM-DD HH:mm')\nviews:\n  - type: table\n    name: T\n    order: [formula.d]\n").unwrap();
    let r = run_view(&base, 0, &books(), None, NOW, 480);
    assert_eq!(cell(&r, 0, "formula.d"), Value::str("2025-06-15 20:00"));
}

#[test]
fn property_types_change_values() {
    let base = parse_base("views:\n  - type: table\n    name: T\n    order: [read]\n").unwrap();
    let mut types = std::collections::BTreeMap::new();
    types.insert("read".to_string(), "text".to_string());
    let r = run_view_with(
        &base,
        0,
        &books(),
        None,
        &RunOptions {
            now_ms: NOW,
            tz_offset_min: 0,
            property_types: Some(&types),
        },
    );
    assert_eq!(cell(&r, 0, "note.read"), Value::str("2025-01-05"));
}

#[test]
fn second_view_is_independent() {
    let yaml = "views:\n  - type: table\n    name: A\n    filters: status == 'done'\n  - type: cards\n    name: B\n    filters: status == 'reading'\n    image: note.cover\n";
    let r = run_n(yaml, 1);
    assert_eq!(r.total, 2);
    let v = r.view.unwrap();
    assert_eq!(
        (v.index, v.view_type.as_str(), v.name.as_str()),
        (1, "cards", "B")
    );
}

#[test]
fn result_json_shape() {
    let yaml = "filters: file.path == 'Books/Dune.md'\nviews:\n  - type: table\n    name: T\n    order: [file.name, read]\n    summaries:\n      rating: Average\n";
    let r = run(yaml);
    let j = serde_json::to_value(&r).unwrap();
    assert_eq!(j["columns"][1]["id"], "note.read");
    assert_eq!(j["groups"][0]["hasKey"], false);
    assert_eq!(j["groups"][0]["key"]["type"], "null");
    assert_eq!(j["groups"][0]["rows"][0]["path"], "Books/Dune.md");
    assert_eq!(
        j["groups"][0]["rows"][0]["cells"]["note.read"]["type"],
        "date"
    );
    assert_eq!(
        j["groups"][0]["rows"][0]["cells"]["note.read"]["time"],
        false
    );
    assert_eq!(
        j["groups"][0]["rows"][0]["cells"]["file.name"],
        json!({"type": "string", "value": "Dune.md"})
    );
    assert_eq!(
        j["summaries"]["note.rating"],
        json!({"type": "number", "value": 5.0})
    );
    assert_eq!(j["total"], 1);
    let back: ViewResult = serde_json::from_value(j).unwrap();
    assert_eq!(back, r);
}

#[test]
fn map_example_from_the_maps_plugin() {
    let yaml = r#"
filters:
  and:
    - categories.containsAny(link("Places"))
formulas:
  Type icon: list(type)[0].asFile().properties.icon
views:
  - type: map
    name: Map
    order:
      - file.name
      - formula.Type icon
    coordinates: note.coordinates
    markerIcon: formula.Type icon
    defaultZoom: 12
"#;
    let files = vec![
        rec(
            "Eiffel Tower.md",
            json!({"categories": ["[[Places]]"], "type": ["[[Landmarks]]"], "coordinates": ["48.85837", "2.294481"]}),
        ),
        rec(
            "Louvre.md",
            json!({"categories": ["[[Places]]", "[[Museums]]"], "type": ["[[Museums]]"]}),
        ),
        rec("Landmarks.md", json!({"icon": "landmark"})),
        rec("Museums.md", json!({"icon": "palette"})),
        FileRecord::new("Places.md"),
    ];
    let base = parse_base(yaml).unwrap();
    assert_eq!(
        base.views[0]
            .extra
            .get("markerIcon")
            .unwrap()
            .scalar_string()
            .unwrap(),
        "formula.Type icon"
    );
    let r = run_view(&base, 0, &files, None, NOW, 0);
    assert_eq!(r.total, 2);
    assert_eq!(cell(&r, 0, "formula.Type icon"), Value::str("landmark"));
    assert_eq!(cell(&r, 1, "formula.Type icon"), Value::str("palette"));
}

#[test]
fn sidebar_backlinks_example() {
    // "use file.hasLink(this.file) to replicate the backlinks pane"
    let base = parse_base("filters: file.hasLink(this.file)\n").unwrap();
    let files = vec![
        {
            let mut r = FileRecord::new("a.md");
            r.links = vec!["target".into()];
            r
        },
        {
            let mut r = FileRecord::new("b.md");
            r.links = vec!["other".into()];
            r
        },
        FileRecord::new("folder/target.md"),
    ];
    let r = run_view(&base, 0, &files, Some(&files[2]), NOW, 0);
    assert_eq!(r.total, 1);
}

#[test]
fn empty_formula_and_empty_filter_statement() {
    let yaml = "formulas:\n  untitled: \"\"\nfilters:\n  and:\n    - \"\"\n    - file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    order: [formula.untitled]\n";
    let base = parse_base(yaml).unwrap();
    assert!(vault_bases::validate_base(&base).is_empty());
    let r = run_view(&base, 0, &books(), None, NOW, 0);
    assert_eq!(r.total, 5);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert_eq!(cell(&r, 0, "formula.untitled"), Value::Null);
}

#[test]
fn custom_summary_over_an_empty_group_is_empty() {
    let yaml = "summaries:\n  avg2: values.mean().round(2)\nfilters: file.hasTag('book')\nviews:\n  - type: table\n    name: T\n    groupBy:\n      property: status\n      direction: ASC\n    summaries:\n      rating: avg2\n";
    let r = run(yaml);
    let to_read = r
        .groups
        .iter()
        .find(|g| g.key == Value::str("to-read"))
        .unwrap();
    assert_eq!(to_read.summaries.get("note.rating"), Some(&Value::Null));
    let done = r
        .groups
        .iter()
        .find(|g| g.key == Value::str("done"))
        .unwrap();
    assert_eq!(done.summaries.get("note.rating"), Some(&Value::num(4.5)));
}

#[test]
fn builtin_summary_function_directly() {
    use vault_bases::builtin_summary;
    let vals = vec![
        Value::num(1.0),
        Value::str("x"),
        Value::Null,
        Value::num(3.0),
        Value::str("x"),
        Value::bool(true),
    ];
    assert_eq!(builtin_summary("average", &vals), Some(Value::num(2.0)));
    assert_eq!(builtin_summary("Unique", &vals), Some(Value::num(4.0)));
    assert_eq!(builtin_summary("Empty", &vals), Some(Value::num(1.0)));
    assert_eq!(builtin_summary("Checked", &vals), Some(Value::num(1.0)));
    assert_eq!(builtin_summary("Median", &[]), Some(Value::Null));
    assert_eq!(builtin_summary("Sum", &[]), Some(Value::num(0.0)));
    assert_eq!(builtin_summary("Mode", &vals), None);
}

#[test]
fn property_id_helpers() {
    use vault_bases::{default_display_name, normalize_property_id, parse_property_id};
    assert_eq!(parse_property_id("status"), ("note", "status"));
    assert_eq!(
        parse_property_id("formula.Type icon"),
        ("formula", "Type icon")
    );
    assert_eq!(parse_property_id("formula."), ("formula", ""));
    assert_eq!(parse_property_id("notebook"), ("note", "notebook"));
    assert_eq!(normalize_property_id("file.mtime"), "file.mtime");
    assert_eq!(normalize_property_id("my prop"), "note.my prop");
    assert_eq!(default_display_name("file.ctime"), "created time");
    assert_eq!(default_display_name("note.author"), "author");
}

#[test]
fn group_by_list_values_and_links() {
    let files = vec![
        rec(
            "a.md",
            json!({"director": "[[Denis Villeneuve]]", "genres": ["x", "y"]}),
        ),
        rec(
            "b.md",
            json!({"director": "[[denis villeneuve]]", "genres": ["x", "y"]}),
        ),
        rec(
            "c.md",
            json!({"director": "[[Andrei Tarkovsky]]", "genres": ["x"]}),
        ),
        FileRecord::new("Denis Villeneuve.md"),
    ];
    let base = parse_base("filters: director\nviews:\n  - type: table\n    name: T\n    groupBy:\n      property: director\n      direction: ASC\n").unwrap();
    let r = run_view(&base, 0, &files, None, NOW, 0);
    assert_eq!(
        r.groups.len(),
        2,
        "links to the same file group together: {:?}",
        r.groups.iter().map(|g| &g.key).collect::<Vec<_>>()
    );
    let base = parse_base("filters: director\nviews:\n  - type: table\n    name: T\n    groupBy:\n      property: genres\n      direction: DESC\n").unwrap();
    let r = run_view(&base, 0, &files, None, NOW, 0);
    assert_eq!(r.groups.len(), 2);
    assert_eq!(r.groups[0].key.to_display(0), "x, y");
}
