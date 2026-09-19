//! Obsidian Flavored Markdown: metadata, rendering, frontmatter, YAML.
use serde_json::json;
use vault_ofm::RenderOptions;
use vault_types::CachedMetadata;
use wasm_bindgen::prelude::*;

pub fn parse_metadata(text: &str) -> CachedMetadata {
    vault_ofm::parse(text)
}

#[wasm_bindgen]
pub fn parse(text: &str) -> String {
    serde_json::to_string(&vault_ofm::parse(text)).unwrap_or_default()
}

/// The sections array (not the wrapper), camelCase.
#[wasm_bindgen]
pub fn render(text: &str, strict_line_breaks: bool) -> String {
    let rendered = vault_ofm::render(text, &RenderOptions { strict_line_breaks });
    serde_json::to_string(&rendered.sections).unwrap_or_default()
}

#[wasm_bindgen]
pub fn word_count(text: &str) -> String {
    serde_json::to_string(&vault_ofm::word_count(text)).unwrap_or_default()
}

#[wasm_bindgen]
pub fn parse_frontmatter(text: &str) -> String {
    serde_json::to_string(&vault_ofm::parse_frontmatter(text)).unwrap_or_default()
}

/// `{ value }` or `{ error }`.
#[wasm_bindgen]
pub fn yaml_parse(src: &str) -> String {
    match vault_ofm::yaml_parse(src) {
        Ok(v) => json!({ "value": v }).to_string(),
        Err(e) => json!({ "error": e }).to_string(),
    }
}

#[wasm_bindgen]
pub fn yaml_stringify(json_value: &str) -> String {
    serde_json::from_str::<serde_json::Value>(json_value).map(|v| vault_ofm::yaml_stringify(&v)).unwrap_or_default()
}

#[wasm_bindgen]
pub fn resolve_subpath(meta_json: &str, subpath: &str) -> String {
    let meta: CachedMetadata = serde_json::from_str(meta_json).unwrap_or_default();
    serde_json::to_string(&vault_ofm::resolve_subpath(&meta, subpath)).unwrap_or_else(|_| "null".into())
}
