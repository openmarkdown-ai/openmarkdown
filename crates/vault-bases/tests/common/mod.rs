#![allow(dead_code)]

use serde_json::json;
use vault_bases::{eval, EvalContext, FileRecord, OrderedMap, Value};

/// 2025-06-15T12:00:00Z, a Sunday.
pub const NOW: f64 = 1_749_988_800_000.0;

pub fn ms(iso: &str) -> f64 {
    vault_bases::datetime::parse_date(iso, 0).unwrap().ms
}

pub fn rec(path: &str, props: serde_json::Value) -> FileRecord {
    let mut r = FileRecord::new(path);
    if let serde_json::Value::Object(m) = props {
        r.properties = m;
    }
    r
}

pub fn vault() -> Vec<FileRecord> {
    let mut dune = rec(
        "Books/Dune.md",
        json!({
            "author": "[[Frank Herbert]]",
            "rating": 4.5,
            "pages": 412,
            "status": "reading",
            "started": "2025-06-01",
            "finished": null,
            "genres": ["sci-fi", "classic"],
            "price": 9.99,
            "quantity": 3,
            "my prop": "spaced",
            "done": false,
            "meta": {"isbn": "978-0441013593", "edition": 2},
            "related": ["[[Foundation]]", "[[Hyperion]]"]
        }),
    );
    dune.size = 2048.0;
    dune.ctime = ms("2025-01-10T08:30:00Z");
    dune.mtime = ms("2025-06-14T18:45:30Z");
    dune.tags = vec!["#book".into(), "book/scifi".into(), "#to-read".into()];
    dune.links = vec![
        "Frank Herbert".into(),
        "Foundation".into(),
        "Textbook#Chapter 1".into(),
    ];
    dune.embeds = vec!["cover.png".into()];
    dune.backlinks = vec!["Reading list.md".into()];

    let mut foundation = rec(
        "Books/Foundation.md",
        json!({"author": "[[Isaac Asimov]]", "rating": 4, "status": "done", "icon": "book"}),
    );
    foundation.tags = vec!["book".into()];
    foundation.links = vec!["Dune".into()];
    foundation.ctime = ms("2024-03-01T00:00:00Z");
    foundation.mtime = ms("2024-03-02T00:00:00Z");

    let frank = rec(
        "People/Frank Herbert.md",
        json!({"born": "1920-10-08", "icon": "user"}),
    );
    let mut list = rec("Reading list.md", json!({}));
    list.links = vec!["Books/Dune.md".into()];
    let cover = FileRecord::new("Books/cover.png");
    let home = FileRecord::new("Home.base");
    vec![dune, foundation, frank, list, cover, home]
}

pub struct Fixture {
    pub files: Vec<FileRecord>,
    pub formulas: OrderedMap<String>,
}

impl Fixture {
    pub fn new() -> Self {
        let mut formulas = OrderedMap::new();
        formulas.insert("ppu", "(price / quantity).toFixed(2)".to_string());
        formulas.insert("total", "price * quantity".to_string());
        formulas.insert("double_total", "formula.total * 2".to_string());
        formulas.insert("a", "formula.b + 1".to_string());
        formulas.insert("b", "formula.a + 1".to_string());
        formulas.insert("self", "formula.self".to_string());
        formulas.insert("broken", "price *".to_string());
        formulas.insert(
            "Type icon",
            "list(author)[0].asFile().properties.icon".to_string(),
        );
        Fixture {
            files: vault(),
            formulas,
        }
    }

    pub fn eval_on(&self, row: &str, src: &str) -> Result<Value, vault_bases::BaseError> {
        let file = self.files.iter().find(|f| f.path == row);
        let this = self.files.iter().find(|f| f.path == "Home.base");
        let ctx = EvalContext {
            files: &self.files,
            file,
            this,
            formulas: Some(&self.formulas),
            now_ms: NOW,
            tz_offset_min: 0,
            property_types: None,
            locals: Vec::new(),
        };
        eval(src, &ctx)
    }
}

/// Evaluate on Books/Dune.md.
pub fn ev(src: &str) -> Value {
    Fixture::new()
        .eval_on("Books/Dune.md", src)
        .unwrap_or_else(|e| panic!("{src}: {e}"))
}

pub fn err(src: &str) -> String {
    match Fixture::new().eval_on("Books/Dune.md", src) {
        Ok(v) => panic!("{src}: expected an error, got {v:?}"),
        Err(e) => e.message,
    }
}

/// Evaluate and render with `toString()` semantics.
pub fn s(src: &str) -> String {
    ev(src).to_display(0)
}

pub fn b(src: &str) -> bool {
    match ev(src) {
        Value::Boolean { value } => value,
        other => panic!("{src}: expected boolean, got {other:?}"),
    }
}

pub fn n(src: &str) -> f64 {
    match ev(src) {
        Value::Number { value } => value,
        other => panic!("{src}: expected number, got {other:?}"),
    }
}
