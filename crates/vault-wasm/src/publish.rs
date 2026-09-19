//! Publishing: one note → standalone HTML, a vault → a static site.
//!
//! Input shapes are `vault_publish::NoteExportInput` / `SiteExportInput`
//! (camelCase JSON; file `bytes` as base64). See packages/engine/src/index.ts.
use serde::Serialize;
use serde_json::json;
use vault_publish::{NoteExportInput, SiteExportInput};
use wasm_bindgen::prelude::*;

use crate::util::b64encode;

/// `input_json`: `NoteExportInput`. Returns the HTML document, or an empty
/// string when the input does not parse.
#[wasm_bindgen]
pub fn publish_note(input_json: &str) -> String {
    match serde_json::from_str::<NoteExportInput>(input_json) {
        Ok(input) => vault_publish::export_note(&input),
        Err(_) => String::new(),
    }
}

#[derive(Serialize)]
struct OutFile {
    path: String,
    /// base64
    data: String,
}

/// `input_json`: `SiteExportInput`. Returns `[{path, data: base64}]`, or
/// `{"error": …}` when the input does not parse.
#[wasm_bindgen]
pub fn publish_site(input_json: &str) -> String {
    match serde_json::from_str::<SiteExportInput>(input_json) {
        Ok(input) => {
            let files: Vec<OutFile> =
                vault_publish::export_site(&input).into_iter().map(|f| OutFile { data: b64encode(&f.bytes), path: f.path }).collect();
            serde_json::to_string(&files).unwrap_or_else(|_| "[]".into())
        }
        Err(e) => json!({ "error": e.to_string() }).to_string(),
    }
}
