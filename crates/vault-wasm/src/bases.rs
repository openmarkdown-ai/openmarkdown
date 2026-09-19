//! Bases: `.base` files and their views.
use serde::Deserialize;
use serde_json::json;
use vault_bases::{eval, parse_base, run_view, serialize_base, validate_base, BaseFile, EvalContext, FileRecord};
use wasm_bindgen::prelude::*;

/// `{ base, errors: [...] }` or `{ error }` when the YAML itself does not parse.
#[wasm_bindgen]
pub fn bases_parse(yaml: &str) -> String {
    match parse_base(yaml) {
        Ok(base) => {
            let errors: Vec<String> = validate_base(&base).iter().map(|e| e.to_string()).collect();
            json!({ "base": base, "errors": errors }).to_string()
        }
        Err(e) => json!({ "error": e.to_string() }).to_string(),
    }
}

#[wasm_bindgen]
pub fn bases_serialize(base_json: &str) -> String {
    match serde_json::from_str::<BaseFile>(base_json) {
        Ok(base) => serialize_base(&base),
        Err(_) => String::new(),
    }
}

#[wasm_bindgen]
pub fn bases_run_view(base_json: &str, view: usize, files_json: &str, this_json: &str, now_ms: f64, tz_offset_min: i32) -> String {
    let Ok(base) = serde_json::from_str::<BaseFile>(base_json) else {
        return json!({ "error": "invalid base" }).to_string();
    };
    let mut files: Vec<FileRecord> = serde_json::from_str(files_json).unwrap_or_default();
    for f in &mut files {
        f.fill_derived();
    }
    let this: Option<FileRecord> = serde_json::from_str(this_json).ok().flatten().map(|mut f: FileRecord| {
        f.fill_derived();
        f
    });
    serde_json::to_string(&run_view(&base, view, &files, this.as_ref(), now_ms, tz_offset_min)).unwrap_or_default()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct EvalInput {
    files: Vec<FileRecord>,
    file: Option<FileRecord>,
    this: Option<FileRecord>,
    now_ms: f64,
    tz_offset_min: i32,
}

/// `{ value }` or `{ error }`.
#[wasm_bindgen]
pub fn bases_eval(expr: &str, ctx_json: &str) -> String {
    let input: EvalInput = serde_json::from_str(ctx_json).unwrap_or_default();
    let mut ctx = EvalContext::new(&input.files, input.now_ms);
    ctx.file = input.file.as_ref();
    ctx.this = input.this.as_ref();
    ctx.tz_offset_min = input.tz_offset_min;
    match eval(expr, &ctx) {
        Ok(v) => json!({ "value": v }).to_string(),
        Err(e) => json!({ "error": e.to_string() }).to_string(),
    }
}
