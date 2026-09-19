//! Web pages and other apps' exports into notes.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use vault_clip::{import, template, value::Value, FormatConverterOptions};
use wasm_bindgen::prelude::*;

use crate::util::{b64decode, b64encode};

fn opts<T: DeserializeOwned + Default>(json: &str) -> T {
    serde_json::from_str(json).unwrap_or_default()
}

#[wasm_bindgen]
pub fn html_to_markdown(html: &str, base_url: &str) -> String {
    vault_clip::html_to_markdown(html, if base_url.is_empty() { None } else { Some(base_url) })
}

#[wasm_bindgen]
pub fn extract(html: &str, url: &str) -> String {
    serde_json::to_string(&vault_clip::extract(html, url)).unwrap_or_default()
}

#[wasm_bindgen]
pub fn format_convert(text: &str, options_json: &str) -> String {
    vault_clip::format_convert(text, &opts::<FormatConverterOptions>(options_json))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct TemplateInput {
    /// When given, page variables are extracted from it.
    html: Option<String>,
    url: String,
    now_ms: f64,
    tz_offset_minutes: i32,
    variables: serde_json::Map<String, serde_json::Value>,
}

fn context(input: &TemplateInput) -> template::TemplateContext {
    let mut ctx = match &input.html {
        Some(html) => vault_clip::page_context(html, &input.url, input.now_ms, input.tz_offset_minutes).1,
        None => {
            let mut c = template::TemplateContext::new(&input.url, input.now_ms);
            c.tz_offset_minutes = input.tz_offset_minutes;
            c
        }
    };
    for (k, v) in &input.variables {
        if let Some(val) = Value::parse_json(&v.to_string()) {
            ctx.variables.insert(k.clone(), val);
        }
    }
    ctx
}

/// `{ output, errors }`.
#[wasm_bindgen]
pub fn render_template(tpl: &str, input_json: &str) -> String {
    let input: TemplateInput = opts(input_json);
    let r = vault_clip::render_template_full(tpl, &context(&input));
    json!({ "output": r.output, "errors": r.errors }).to_string()
}

/// Runs a Web Clipper template (its JSON export) against a page: `ClipResult`.
#[wasm_bindgen]
pub fn clip_page(template_json: &str, input_json: &str) -> String {
    let input: TemplateInput = opts(input_json);
    match vault_clip::parse_template_json(template_json) {
        Ok(t) => serde_json::to_string(&vault_clip::clip(&t, &context(&input), &[])).unwrap_or_default(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

#[derive(Deserialize)]
struct InFile {
    path: String,
    /// base64
    data: String,
}

#[derive(Serialize)]
struct OutFile {
    path: String,
    /// base64
    data: String,
}

/// `files_json`: `[{path, data: base64}]`. Returns `{files: [{path, data: base64}], warnings}`.
#[wasm_bindgen]
pub fn import_run(kind: &str, files_json: &str, options_json: &str) -> String {
    let files: Vec<(String, Vec<u8>)> = serde_json::from_str::<Vec<InFile>>(files_json)
        .unwrap_or_default()
        .into_iter()
        .map(|f| (f.path, b64decode(&f.data)))
        .collect();
    let first_text = || files.first().map(|f| String::from_utf8_lossy(&f.1).into_owned()).unwrap_or_default();
    let first_bytes = || files.first().map(|f| f.1.clone()).unwrap_or_default();
    let result = match kind {
        "enex" => {
            let mut all = import::ImportResult::default();
            for (_, data) in &files {
                let r = import::enex::convert(&String::from_utf8_lossy(data), &opts(options_json));
                all.files.extend(r.files);
                all.warnings.extend(r.warnings);
            }
            all
        }
        "html" => import::html_files::convert(&files, &opts(options_json)),
        "notion" => {
            // A zip export, or its unpacked files.
            let unpacked = if files.len() == 1 && files[0].0.to_lowercase().ends_with(".zip") {
                vault_clip::zip::read_zip(&files[0].1).map(|entries| entries.into_iter().map(|e| (e.name, e.data)).collect::<Vec<_>>()).unwrap_or_default()
            } else {
                files.clone()
            };
            import::notion::convert_with(&unpacked, &opts(options_json))
        }
        "roam" => import::roam::convert(&first_text(), &opts(options_json)),
        "keep" => import::keep::convert_with(&files, &opts(options_json)),
        "bear" => import::bear::convert_with(&first_bytes(), &opts(options_json)),
        "logseq" => import::logseq::convert_with(&files, &opts(options_json)),
        "csv" => import::csv::convert(&first_text(), &opts(options_json)),
        "textbundle" => import::textbundle::convert(&files),
        other => import::ImportResult { files: vec![], warnings: vec![format!("Unknown import format: {other}")] },
    };
    let out: Vec<OutFile> = result.files.iter().map(|f| OutFile { path: f.path.clone(), data: b64encode(&f.data) }).collect();
    json!({ "files": out, "warnings": result.warnings }).to_string()
}
