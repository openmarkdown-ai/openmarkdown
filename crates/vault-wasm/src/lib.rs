//! The browser's view of the vault crates.
//!
//! Every value crosses as a JSON string: one `JSON.parse` on the JS side is
//! cheaper than walking a structure through wasm-bindgen accessors, and it
//! keeps the crates free of JS types. The TypeScript wrapper that parses these
//! strings is `packages/engine/src/bind.ts`; the two files change together.

use serde::Serialize;
use vault_index::{FileEntry, ForceLayout, ForceParams, GraphOptions, LinkFormat, RenameOptions, SearchOptions, VaultIndex};
use wasm_bindgen::prelude::*;

mod bases;
mod clip;
mod markdown;
mod publish;
mod util;

fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|e| format!("{{\"error\":{}}}", serde_json::Value::String(e.to_string())))
}

fn from_json<T: serde::de::DeserializeOwned + Default>(s: &str) -> T {
    serde_json::from_str(s).unwrap_or_default()
}

fn link_format(s: &str) -> LinkFormat {
    match s {
        "relative" => LinkFormat::Relative,
        "absolute" => LinkFormat::Absolute,
        _ => LinkFormat::Shortest,
    }
}

// ---- fuzzy ------------------------------------------------------------------

#[wasm_bindgen]
pub fn fuzzy(query: &str, text: &str) -> String {
    to_json(&vault_index::fuzzy::fuzzy(query, text))
}

#[wasm_bindgen]
pub fn simple_search(query: &str, text: &str) -> String {
    to_json(&vault_index::fuzzy::simple(query, text))
}

/// `items_json` is a JSON array of strings; returns `[{index, result}]`.
#[wasm_bindgen]
pub fn rank(query: &str, items_json: &str, limit: usize) -> String {
    let items: Vec<String> = from_json(items_json);
    #[derive(Serialize)]
    struct Ranked<'a> {
        index: usize,
        result: &'a vault_types::SearchResult,
    }
    let ranked = vault_index::fuzzy::rank(query, &items, limit);
    to_json(&ranked.iter().map(|(index, result)| Ranked { index: *index, result }).collect::<Vec<_>>())
}

// ---- index ------------------------------------------------------------------

#[wasm_bindgen]
pub struct Index {
    inner: VaultIndex,
}

#[wasm_bindgen]
impl Index {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Index {
        Index { inner: VaultIndex::new() }
    }

    pub fn upsert_file(&mut self, entry_json: &str) {
        if let Ok(e) = serde_json::from_str::<FileEntry>(entry_json) {
            self.inner.upsert_file(e);
        }
    }

    pub fn remove_file(&mut self, path: &str) {
        self.inner.remove_file(path);
    }

    pub fn rename_file(&mut self, old: &str, new: &str) {
        self.inner.rename_file(old, new);
    }

    /// Parses the note, stores text + metadata, returns the metadata JSON.
    pub fn set_note(&mut self, path: &str, text: String) -> String {
        let meta = markdown::parse_metadata(&text);
        let json = to_json(&meta);
        self.inner.set_note(path, text, meta);
        json
    }

    pub fn resolve_link(&self, linkpath: &str, source: &str) -> Option<String> {
        self.inner.resolve_link(linkpath, source)
    }

    pub fn resolved_links(&self) -> String {
        to_json(&self.inner.resolved_links())
    }

    pub fn unresolved_links(&self) -> String {
        to_json(&self.inner.unresolved_links())
    }

    pub fn backlinks(&self, path: &str) -> String {
        to_json(&self.inner.backlinks(path))
    }

    pub fn unlinked_mentions(&self, path: &str) -> String {
        to_json(&self.inner.unlinked_mentions(path))
    }

    pub fn tags(&self) -> String {
        to_json(&self.inner.tags())
    }

    pub fn linktext(&self, target: &str, source: &str, format: &str) -> String {
        self.inner.linktext(target, source, link_format(format))
    }

    pub fn rename_edits(&self, old: &str, new: &str, format: &str) -> String {
        to_json(&self.inner.rename_edits(old, new, &RenameOptions { link_format: link_format(format) }))
    }

    pub fn search(&self, query: &str, opts_json: &str) -> String {
        let opts: SearchOptions = from_json(opts_json);
        to_json(&self.inner.search(query, &opts))
    }

    pub fn graph(&self, opts_json: &str) -> String {
        let opts: GraphOptions = serde_json::from_str(opts_json).unwrap_or_default();
        to_json(&self.inner.graph(&opts))
    }
}

impl Default for Index {
    fn default() -> Self {
        Self::new()
    }
}

// ---- layout -----------------------------------------------------------------

fn pairs(links: &[u32]) -> Vec<(u32, u32)> {
    links.chunks_exact(2).map(|c| (c[0], c[1])).collect()
}

#[wasm_bindgen]
pub struct Layout {
    inner: ForceLayout,
    ids: Vec<String>,
}

#[wasm_bindgen]
impl Layout {
    /// `ids_json` names the nodes so a later `set_graph` keeps positions;
    /// `links` is a flat `[source, target, …]` array of node indices.
    #[wasm_bindgen(constructor)]
    pub fn new(ids_json: &str, links: &[u32], params_json: &str) -> Layout {
        let ids: Vec<String> = from_json(ids_json);
        let params: ForceParams = serde_json::from_str(params_json).unwrap_or_default();
        let inner = ForceLayout::with_ids(ids.clone(), &pairs(links), params);
        Layout { inner, ids }
    }

    pub fn step(&mut self, iterations: u32) -> bool {
        self.inner.step(iterations)
    }

    /// Pointer and length of the interleaved positions in wasm memory.
    pub fn positions_ptr(&self) -> *const f32 {
        self.inner.positions().as_ptr()
    }

    pub fn positions_len(&self) -> usize {
        self.inner.positions().len()
    }

    pub fn set_params(&mut self, params_json: &str) {
        if let Ok(p) = serde_json::from_str::<ForceParams>(params_json) {
            self.inner.set_params(p);
        }
    }

    pub fn pin(&mut self, node: usize, x: f32, y: f32) {
        self.inner.pin(node, x, y);
    }

    pub fn unpin(&mut self, node: usize) {
        self.inner.unpin(node);
    }

    pub fn reheat(&mut self, alpha: f32) {
        self.inner.reheat(alpha);
    }

    pub fn alpha(&self) -> f32 {
        self.inner.alpha()
    }

    pub fn set_graph(&mut self, ids_json: &str, links: &[u32]) {
        let ids: Vec<String> = from_json(ids_json);
        self.inner.set_graph(ids.clone(), &pairs(links));
        self.ids = ids;
    }
}
