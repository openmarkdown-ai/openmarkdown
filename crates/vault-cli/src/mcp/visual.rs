//! What the app *shows*: the link graph and JSON Canvas boards, as data and
//! as pictures.
//!
//! The pictures are SVG written by hand (see `svg.rs`) — no browser, no
//! raster library, no new dependency. The graph uses `vault-index`'s force
//! layout, the same simulation the app's graph view runs, so the picture has
//! the same shape the person sees.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};
use vault_index::{ForceLayout, ForceParams, GraphOptions, NodeKind};

use super::fsx::{self, TextFile};
use super::svg::{self, Svg};
use super::tools::{annotations, done, json_out, opt_bool, opt_str, opt_usize, req_str, tool};
use super::{Server, ToolError, ToolOutput};

type R = Result<ToolOutput, ToolError>;

pub const READ: &[&str] = &["graph", "graph_image", "canvas_read", "canvas_image"];
pub const WRITE: &[&str] = &["canvas_edit"];

/// The biggest SVG a tool result will carry.
const MAX_SVG_BYTES: usize = 4_000_000;
/// Ticks of the force simulation before the picture is drawn.
const LAYOUT_STEPS: u32 = 400;

const CANVAS_DESC: &str = "Vault-relative path of a `.canvas` file, e.g. `Ideas.canvas`.";

pub fn read_definitions() -> Vec<Value> {
    vec![
        tool(
            "graph",
            "Link graph",
            "The vault's link graph as data: nodes (notes, and optionally attachments, tags and not-yet-created notes) with how many links touch each, and the links between them. Without `note` it is the whole vault; with `note` it is the local graph around that note, `depth` hops out. `filter` is a search query (`path:Projects`, `tag:#idea`, `-archive`) that keeps only matching notes. Use it to find hubs, clusters and dead ends; use graph_image for a picture of the same thing.",
            json!({
                "note": { "type": "string", "description": "Centre a local graph on this note. Omit for the whole vault." },
                "depth": { "type": "integer", "minimum": 1, "maximum": 5, "default": 1, "description": "Local graph only: how many links out from `note`." },
                "filter": { "type": "string", "description": "Search query; only notes it matches are included (the centre note always is)." },
                "include_tags": { "type": "boolean", "default": false, "description": "Add a node per tag, linked to the notes that use it." },
                "include_attachments": { "type": "boolean", "default": false, "description": "Add images, PDFs and other non-Markdown files." },
                "include_unresolved": { "type": "boolean", "default": true, "description": "Include links to notes that do not exist yet." },
                "include_orphans": { "type": "boolean", "default": true, "description": "Include notes with no links at all." },
                "incoming": { "type": "boolean", "default": true, "description": "Local graph: follow links pointing at the centre." },
                "outgoing": { "type": "boolean", "default": true, "description": "Local graph: follow links out of the centre." },
                "neighbor_links": { "type": "boolean", "default": false, "description": "Local graph: also draw links between the neighbours themselves." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 5000, "default": 500, "description": "Maximum nodes to return; the busiest are kept." }
            }),
            &[],
            annotations("Link graph", true, false, true),
        ),
        tool(
            "graph_image",
            "Picture of the link graph",
            "Draw the link graph as an SVG image: a circle per note sized by how many links touch it, labelled, with unresolved notes shown as dashed outlines and tags in green. The layout is the same force simulation the app's graph view runs, so it looks like what the person sees; it is deterministic, so the same vault gives the same picture. Takes the same arguments as `graph`. The result carries the SVG as text and as an image block; nothing is written to the vault. PNG is not offered — rendering one would need a browser.",
            json!({
                "note": { "type": "string", "description": "Centre a local graph on this note. Omit for the whole vault." },
                "depth": { "type": "integer", "minimum": 1, "maximum": 5, "default": 1 },
                "filter": { "type": "string", "description": "Search query; only notes it matches are drawn." },
                "include_tags": { "type": "boolean", "default": false },
                "include_attachments": { "type": "boolean", "default": false },
                "include_unresolved": { "type": "boolean", "default": true },
                "include_orphans": { "type": "boolean", "default": true },
                "incoming": { "type": "boolean", "default": true },
                "outgoing": { "type": "boolean", "default": true },
                "neighbor_links": { "type": "boolean", "default": false },
                "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 250, "description": "Most-linked nodes to draw. More than a few hundred is unreadable." },
                "labels": { "type": "integer", "minimum": 0, "maximum": 1000, "default": 60, "description": "How many of the busiest nodes get a name next to them." },
                "width": { "type": "integer", "minimum": 200, "maximum": 4000, "default": 1200, "description": "Image width in pixels (the height follows the layout)." }
            }),
            &[],
            annotations("Picture of the link graph", true, false, true),
        ),
        tool(
            "canvas_read",
            "Read a canvas",
            "Read a `.canvas` board (the JSON Canvas format Obsidian and OpenMarkdown use) as structured JSON: its cards (`text` notes, `file` cards pointing at a vault note, `link` cards with a URL), its groups, and the edges between them with their labels. Positions and sizes are in canvas coordinates. Use canvas_image to see it.",
            json!({ "path": { "type": "string", "description": CANVAS_DESC } }),
            &["path"],
            annotations("Read a canvas", true, false, true),
        ),
        tool(
            "canvas_image",
            "Picture of a canvas",
            "Draw a `.canvas` board as an SVG image: cards with their text, file cards with the note's name and its first lines, groups behind them, and edges with their labels and arrows, laid out at the canvas's own coordinates. It is a readable picture rather than a pixel-faithful copy of the app. The result carries the SVG as text and as an image block; nothing is written to the vault.",
            json!({
                "path": { "type": "string", "description": CANVAS_DESC },
                "width": { "type": "integer", "minimum": 200, "maximum": 4000, "default": 1200, "description": "Image width in pixels." },
                "snippets": { "type": "boolean", "default": true, "description": "Show the first lines of the note behind each file card." }
            }),
            &["path"],
            annotations("Picture of a canvas", true, false, true),
        ),
    ]
}

pub fn write_definitions() -> Vec<Value> {
    vec![tool(
        "canvas_edit",
        "Edit a canvas",
        "Change a `.canvas` board: add, update or remove cards and edges. Every change is validated the way the app validates a canvas before it writes one — ids must be unique, sizes are at least 1, an edge must name two cards that exist — and the file is written in the same layout the app uses, so the app and Obsidian open it unchanged. Give `add_nodes` / `update_nodes` / `remove_nodes` / `add_edges` / `remove_edges`; a node needs `type` (`text`, `file`, `link` or `group`), `x`, `y`, and `text`, `file`, `url` or `label` depending on the type. Read the board with canvas_read first so you know the ids.",
        json!({
            "path": { "type": "string", "description": CANVAS_DESC },
            "create_if_missing": { "type": "boolean", "default": false, "description": "Create an empty canvas at `path` if it does not exist." },
            "add_nodes": { "type": "array", "description": "Cards to add. `id` is optional and generated when missing. Defaults: width 250, height 60.", "items": { "type": "object" } },
            "update_nodes": { "type": "array", "description": "Changes to existing cards, each with the `id` to change and the fields to set (null removes a field).", "items": { "type": "object" } },
            "remove_nodes": { "type": "array", "description": "Ids of cards to delete. Edges touching them are deleted too.", "items": { "type": "string" } },
            "add_edges": { "type": "array", "description": "Edges to add: `fromNode`, `toNode`, optional `fromSide`/`toSide` (top|right|bottom|left), `label`, `color`, `toEnd`.", "items": { "type": "object" } },
            "remove_edges": { "type": "array", "description": "Ids of edges to delete.", "items": { "type": "string" } }
        }),
        &["path"],
        annotations("Edit a canvas", false, true, false),
    )]
}

pub fn call(s: &mut Server, name: &str, a: &Map<String, Value>) -> R {
    match name {
        "graph" => t_graph(s, a),
        "graph_image" => t_graph_image(s, a),
        "canvas_read" => t_canvas_read(s, a),
        "canvas_image" => t_canvas_image(s, a),
        "canvas_edit" => t_canvas_edit(s, a),
        other => Err(ToolError::Unknown(format!("Unknown tool: {other}"))),
    }
}

/// An SVG result: the source as text plus an image content block.
fn svg_out(svg: String, structured: Value) -> R {
    if svg.len() > MAX_SVG_BYTES {
        return Err(format!(
            "the picture came to {} KB, more than the {} KB a tool result should carry; lower `limit` (fewer nodes) or `width`",
            svg.len() / 1024,
            MAX_SVG_BYTES / 1024
        )
        .into());
    }
    let data = vault_publish::base64_encode(svg.as_bytes());
    let mut structured = structured;
    structured["bytes"] = json!(svg.len());
    structured["mimeType"] = json!("image/svg+xml");
    Ok(ToolOutput {
        text: svg,
        structured: Some(structured),
        extra: vec![json!({ "type": "image", "data": data, "mimeType": "image/svg+xml" })],
    })
}

// ---- graph -----------------------------------------------------------------------------

fn graph_options(s: &Server, a: &Map<String, Value>) -> Result<GraphOptions, ToolError> {
    let local = match opt_str(a, "note")? {
        Some(n) => Some(s.resolve_note(n)?),
        None => None,
    };
    Ok(GraphOptions {
        search: opt_str(a, "filter")?.unwrap_or("").to_string(),
        show_tags: opt_bool(a, "include_tags", false)?,
        show_attachments: opt_bool(a, "include_attachments", false)?,
        hide_unresolved: !opt_bool(a, "include_unresolved", true)?,
        show_orphans: opt_bool(a, "include_orphans", true)?,
        color_groups: Vec::new(),
        local_jumps: opt_usize(a, "depth", 1, 1, 5)? as u32,
        local_backlinks: opt_bool(a, "incoming", true)?,
        local_forelinks: opt_bool(a, "outgoing", true)?,
        local_interlinks: opt_bool(a, "neighbor_links", false)?,
        local_file: local,
    })
}

/// The graph, trimmed to the `limit` busiest nodes with the links between
/// the ones that are kept.
struct Trimmed {
    nodes: Vec<vault_index::GraphNode>,
    links: Vec<(usize, usize)>,
    total_nodes: usize,
    total_links: usize,
    errors: Vec<String>,
}

fn trimmed_graph(s: &Server, opts: &GraphOptions, limit: usize) -> Trimmed {
    let g = s.vault.index.graph(opts);
    let total_nodes = g.nodes.len();
    let total_links = g.links.len();
    let mut order: Vec<usize> = (0..g.nodes.len()).collect();
    order.sort_by(|a, b| {
        let (x, y) = (&g.nodes[*a], &g.nodes[*b]);
        x.depth.unwrap_or(u32::MAX).cmp(&y.depth.unwrap_or(u32::MAX)).then(y.weight.cmp(&x.weight)).then(x.id.cmp(&y.id))
    });
    order.truncate(limit);
    let mut map: BTreeMap<usize, usize> = BTreeMap::new();
    // Keep the graph's own node order so the picture is stable.
    let mut kept: Vec<usize> = order.clone();
    kept.sort_unstable();
    for (new, old) in kept.iter().enumerate() {
        map.insert(*old, new);
    }
    let nodes: Vec<vault_index::GraphNode> = kept.iter().map(|i| g.nodes[*i].clone()).collect();
    let links: Vec<(usize, usize)> = g
        .links
        .iter()
        .filter_map(|l| Some((*map.get(&(l.source as usize))?, *map.get(&(l.target as usize))?)))
        .filter(|(a, b)| a != b)
        .collect();
    Trimmed { nodes, links, total_nodes, total_links, errors: g.errors }
}

fn kind_name(k: NodeKind) -> &'static str {
    match k {
        NodeKind::Note => "note",
        NodeKind::Attachment => "attachment",
        NodeKind::Tag => "tag",
        NodeKind::Unresolved => "unresolved",
    }
}

fn t_graph(s: &Server, a: &Map<String, Value>) -> R {
    let opts = graph_options(s, a)?;
    let limit = opt_usize(a, "limit", 500, 1, 5000)?;
    let t = trimmed_graph(s, &opts, limit);
    let nodes: Vec<Value> = t
        .nodes
        .iter()
        .map(|n| {
            let mut v = json!({ "id": n.id, "label": n.label, "kind": kind_name(n.kind), "links": n.weight });
            if let Some(d) = n.depth {
                v["depth"] = json!(d);
            }
            v
        })
        .collect();
    let links: Vec<Value> = t.links.iter().map(|(a, b)| json!({ "from": t.nodes[*a].id, "to": t.nodes[*b].id })).collect();
    Ok(json_out(json!({
        "center": opts.local_file,
        "nodes": nodes.len(), "links": links.len(),
        "totalNodes": t.total_nodes, "totalLinks": t.total_links,
        "truncated": t.total_nodes > nodes.len(),
        "graph": { "nodes": nodes, "links": links },
        "errors": t.errors
    })))
}

fn t_graph_image(s: &Server, a: &Map<String, Value>) -> R {
    let opts = graph_options(s, a)?;
    let limit = opt_usize(a, "limit", 250, 1, 1000)?;
    let label_count = opt_usize(a, "labels", 60, 0, 1000)?;
    let width = opt_usize(a, "width", 1200, 200, 4000)? as f64;
    let t = trimmed_graph(s, &opts, limit);
    if t.nodes.is_empty() {
        return Err("this graph has no nodes — try include_orphans: true, a wider `filter`, or a different `note`".into());
    }
    let edges: Vec<(u32, u32)> = t.links.iter().map(|(a, b)| (*a as u32, *b as u32)).collect();
    let ids: Vec<String> = t.nodes.iter().map(|n| n.id.clone()).collect();
    let mut layout = ForceLayout::with_ids(ids, &edges, ForceParams::default());
    layout.step(LAYOUT_STEPS);
    let pos = layout.positions().to_vec();

    let radius = |w: u32| (4.0 + (w as f64).sqrt() * 3.0).clamp(4.0, 28.0);
    // Label the busiest nodes (and, in a local graph, the centre).
    let mut by_weight: Vec<usize> = (0..t.nodes.len()).collect();
    by_weight.sort_by(|x, y| t.nodes[*y].weight.cmp(&t.nodes[*x].weight).then(t.nodes[*x].id.cmp(&t.nodes[*y].id)));
    by_weight.truncate(label_count);
    let labels: Vec<Option<String>> = t
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (by_weight.contains(&i) || n.depth == Some(0)).then(|| svg::ellipsis(&n.label, 32)))
        .collect();

    // The box must hold the labels too, or names at the edge are cut off.
    // The label font is sized from the finished box, so estimate with the
    // ratio that `font` uses below (13 px at the final width).
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    let mut widest = 0.0f64;
    for (i, n) in t.nodes.iter().enumerate() {
        let (x, y) = (pos[i * 2] as f64, pos[i * 2 + 1] as f64);
        let r = radius(n.weight);
        let chars = labels[i].as_ref().map(|l| l.chars().count() as f64).unwrap_or(0.0);
        widest = widest.max(chars);
        min_x = min_x.min(x - r - 10.0);
        max_x = max_x.max(x + r + 10.0);
        min_y = min_y.min(y - r - 10.0);
        max_y = max_y.max(y + r + if chars > 0.0 { 34.0 } else { 10.0 });
    }
    // A label is centred on its node, so half of it can stick out each side.
    let side = (widest * 13.0 * 0.3).min((max_x - min_x).max(200.0) * 0.25);
    min_x -= side;
    max_x += side;
    let (vw, vh) = ((max_x - min_x).max(200.0), (max_y - min_y).max(200.0));
    let height = (width * vh / vw).clamp(200.0, 4000.0);
    let font = (vw / width * 13.0).max(1.0);

    let mut svg = Svg::new((min_x, min_y, vw, vh), width, height);
    for (a, b) in &t.links {
        svg.line(pos[a * 2] as f64, pos[a * 2 + 1] as f64, pos[b * 2] as f64, pos[b * 2 + 1] as f64, "edge", &format!(r#" stroke-width="{:.2}""#, font * 0.09));
    }
    for (i, n) in t.nodes.iter().enumerate() {
        let (x, y) = (pos[i * 2] as f64, pos[i * 2 + 1] as f64);
        let r = radius(n.weight);
        let center = n.depth == Some(0);
        let class = match n.kind {
            NodeKind::Note => "node",
            NodeKind::Attachment => "node node-attachment",
            NodeKind::Tag => "node node-tag",
            NodeKind::Unresolved => "node node-unresolved",
        };
        let class = if center { format!("{class} node-center") } else { class.to_string() };
        svg.group_open("");
        svg.title(&format!("{} ({} link{})", n.id, n.weight, if n.weight == 1 { "" } else { "s" }));
        svg.circle(x, y, r, &class, "");
        svg.group_close();
        if let Some(label) = &labels[i] {
            svg.text(x, y + r + font * 1.4, font, "", "middle", label);
        }
    }
    let what = match &opts.local_file {
        Some(f) => format!("Links around {f}"),
        None => format!("{} link graph", s.vault.name()),
    };
    let out = svg.finish(&what, svg::THEME_CSS);
    svg_out(
        out,
        json!({
            "title": what, "center": opts.local_file, "nodes": t.nodes.len(), "links": t.links.len(),
            "totalNodes": t.total_nodes, "totalLinks": t.total_links, "truncated": t.total_nodes > t.nodes.len(),
            "width": width, "height": height, "errors": t.errors
        }),
    )
}

// ---- canvas ----------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct CanvasNode {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug)]
pub struct CanvasEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub extra: Map<String, Value>,
}

#[derive(Debug)]
pub struct Canvas {
    pub nodes: Vec<CanvasNode>,
    pub edges: Vec<CanvasEdge>,
    /// Top-level keys other than `nodes` and `edges`, kept as they were.
    pub rest: Map<String, Value>,
}

fn num(v: Option<&Value>, default: f64) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(default),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(default),
        _ => default,
    }
}

/// A 16-character id, as the app's `randomId()` makes one. No randomness
/// source is needed: the counter and the clock are enough to be unique
/// inside one file.
fn new_id(seed: &mut u64) -> String {
    *seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
    let a = *seed;
    *seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
    format!("{:08x}{:08x}", (a >> 32) as u32, (*seed >> 32) as u32)
}

fn seed_from(text: &str) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h ^ crate::vault::now_ms() as u64
}

/// Parses a `.canvas` file the way the app's `parseCanvas` does: broken
/// values are repaired rather than rejected, and unknown keys are kept.
pub fn parse_canvas(text: &str, seed: &mut u64) -> Result<Canvas, String> {
    if text.trim().is_empty() {
        return Ok(Canvas { nodes: Vec::new(), edges: Vec::new(), rest: Map::new() });
    }
    let raw: Value = serde_json::from_str(text).map_err(|e| format!("this canvas is not valid JSON ({e}); fix the file before editing it here"))?;
    let Value::Object(obj) = raw else {
        return Err("a canvas file must contain a JSON object".into());
    };
    let mut seen: Vec<String> = Vec::new();
    let mut nodes = Vec::new();
    for item in obj.get("nodes").and_then(Value::as_array).cloned().unwrap_or_default() {
        let Value::Object(mut m) = item else { continue };
        let id = match m.remove("id") {
            Some(Value::String(s)) if !s.is_empty() && !seen.contains(&s) => s,
            _ => new_id(seed),
        };
        seen.push(id.clone());
        let kind = match m.remove("type") {
            Some(Value::String(s)) => s,
            _ => "text".to_string(),
        };
        let x = num(m.remove("x").as_ref(), 0.0).round();
        let y = num(m.remove("y").as_ref(), 0.0).round();
        let width = num(m.remove("width").as_ref(), 250.0).round().max(1.0);
        let height = num(m.remove("height").as_ref(), 60.0).round().max(1.0);
        if kind == "text" && !m.get("text").is_some_and(Value::is_string) {
            m.insert("text".into(), json!(""));
        }
        nodes.push(CanvasNode { id, kind, x, y, width, height, extra: m });
    }
    let mut edges = Vec::new();
    for item in obj.get("edges").and_then(Value::as_array).cloned().unwrap_or_default() {
        let Value::Object(mut m) = item else { continue };
        let (Some(Value::String(from)), Some(Value::String(to))) = (m.remove("fromNode"), m.remove("toNode")) else { continue };
        let id = match m.remove("id") {
            Some(Value::String(s)) if !s.is_empty() => s,
            _ => new_id(seed),
        };
        edges.push(CanvasEdge { id, from, to, extra: m });
    }
    let rest: Map<String, Value> = obj.into_iter().filter(|(k, _)| k != "nodes" && k != "edges").collect();
    Ok(Canvas { nodes, edges, rest })
}

fn node_json(n: &CanvasNode) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(n.id));
    m.insert("type".into(), json!(n.kind));
    m.insert("x".into(), json!(n.x as i64));
    m.insert("y".into(), json!(n.y as i64));
    m.insert("width".into(), json!(n.width as i64));
    m.insert("height".into(), json!(n.height as i64));
    for (k, v) in &n.extra {
        m.insert(k.clone(), v.clone());
    }
    Value::Object(m)
}

fn edge_json(e: &CanvasEdge) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(e.id));
    m.insert("fromNode".into(), json!(e.from));
    m.insert("toNode".into(), json!(e.to));
    for (k, v) in &e.extra {
        m.insert(k.clone(), v.clone());
    }
    Value::Object(m)
}

/// Writes a canvas in the layout Obsidian and the app write: tab-indented,
/// one node and one edge per line, so diffs stay small.
pub fn serialize_canvas(c: &Canvas) -> String {
    let list = |items: Vec<String>| -> String {
        if items.is_empty() {
            "[]".to_string()
        } else {
            format!("[\n\t\t{}\n\t]", items.join(",\n\t\t"))
        }
    };
    let nodes = list(c.nodes.iter().map(|n| node_json(n).to_string()).collect());
    let edges = list(c.edges.iter().map(|e| edge_json(e).to_string()).collect());
    let mut out = format!("{{\n\t\"nodes\":{nodes},\n\t\"edges\":{edges}");
    for (k, v) in &c.rest {
        out.push_str(&format!(",\n\t{}:{}", Value::String(k.clone()), v));
    }
    out.push_str("\n}");
    out
}

fn read_canvas(s: &Server, arg: &str) -> Result<(String, Canvas), ToolError> {
    let rel = s
        .resolve_existing(arg)
        .or_else(|_| s.resolve_existing(&format!("{}.canvas", arg.trim_end_matches(".canvas"))))
        .map_err(|e| {
            let list: Vec<&str> = s.vault.files.iter().map(|f| f.path.as_str()).filter(|p| p.to_lowercase().ends_with(".canvas")).take(5).collect();
            if list.is_empty() {
                format!("{e} — this vault has no .canvas files")
            } else {
                format!("{e} — canvases in this vault: {}", list.join(", "))
            }
        })?;
    if !rel.to_lowercase().ends_with(".canvas") {
        return Err(format!("{rel} is not a .canvas file").into());
    }
    let text = fsx::read_text(&fsx::confined(&s.root, &rel)?, &rel)?.text;
    let mut seed = seed_from(&rel);
    let canvas = parse_canvas(&text, &mut seed)?;
    Ok((rel, canvas))
}

fn t_canvas_read(s: &Server, a: &Map<String, Value>) -> R {
    let (rel, c) = read_canvas(s, req_str(a, "path")?)?;
    let nodes: Vec<Value> = c
        .nodes
        .iter()
        .map(|n| {
            let mut v = node_json(n);
            if n.kind == "file" {
                if let Some(f) = n.extra.get("file").and_then(Value::as_str) {
                    v["resolved"] = json!(s.vault.index.resolve_link(f, &rel));
                }
            }
            v
        })
        .collect();
    let edges: Vec<Value> = c.edges.iter().map(edge_json).collect();
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for n in &c.nodes {
        *counts.entry(n.kind.as_str()).or_default() += 1;
    }
    Ok(json_out(json!({
        "path": rel, "nodes": nodes.len(), "edges": edges.len(),
        "byType": counts, "canvas": { "nodes": nodes, "edges": edges }
    })))
}

// Canvas preset colours 1–6, as the app names them.
const CANVAS_COLORS: [&str; 6] = ["#e5534b", "#d98726", "#d6b420", "#4caf6a", "#3aa8c1", "#9b7bd4"];

fn color_of(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    if let Ok(n) = s.parse::<usize>() {
        return CANVAS_COLORS.get(n.checked_sub(1)?).map(|c| c.to_string());
    }
    let hex = s.strip_prefix('#')?;
    if (3..=8).contains(&hex.len()) && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(s.to_string())
    } else {
        None
    }
}

/// Where an edge leaves or enters a card.
fn side_point(n: &CanvasNode, side: &str) -> (f64, f64) {
    match side {
        "top" => (n.x + n.width / 2.0, n.y),
        "bottom" => (n.x + n.width / 2.0, n.y + n.height),
        "left" => (n.x, n.y + n.height / 2.0),
        _ => (n.x + n.width, n.y + n.height / 2.0),
    }
}

/// The side that faces the other card, when the edge does not name one.
fn facing(a: &CanvasNode, b: &CanvasNode) -> &'static str {
    let dx = (b.x + b.width / 2.0) - (a.x + a.width / 2.0);
    let dy = (b.y + b.height / 2.0) - (a.y + a.height / 2.0);
    if dx.abs() >= dy.abs() {
        if dx >= 0.0 {
            "right"
        } else {
            "left"
        }
    } else if dy >= 0.0 {
        "bottom"
    } else {
        "top"
    }
}

fn t_canvas_image(s: &Server, a: &Map<String, Value>) -> R {
    let (rel, c) = read_canvas(s, req_str(a, "path")?)?;
    if c.nodes.is_empty() {
        return Err(format!("{rel} has no cards to draw").into());
    }
    let width = opt_usize(a, "width", 1200, 200, 4000)? as f64;
    let snippets = opt_bool(a, "snippets", true)?;
    let pad = 40.0;
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for n in &c.nodes {
        min_x = min_x.min(n.x - pad);
        min_y = min_y.min(n.y - pad);
        max_x = max_x.max(n.x + n.width + pad);
        max_y = max_y.max(n.y + n.height + pad);
    }
    let (vw, vh) = ((max_x - min_x).max(100.0), (max_y - min_y).max(100.0));
    let height = (width * vh / vw).clamp(120.0, 4000.0);
    let mut svg = Svg::new((min_x, min_y, vw, vh), width, height);
    svg.defs(
        r#"<marker id="a" viewBox="0 0 10 8" refX="9" refY="4" markerWidth="8" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 4 L0 8 z" class="arrow"/></marker>"#,
    );
    let by_id: BTreeMap<&str, &CanvasNode> = c.nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    // Groups behind everything else.
    for n in c.nodes.iter().filter(|n| n.kind == "group") {
        let stroke = color_of(n.extra.get("color")).map(|c| format!(r#" stroke="{}""#, svg::esc(&c))).unwrap_or_default();
        svg.rect((n.x, n.y, n.width, n.height), 10.0, "group", &stroke);
        if let Some(l) = n.extra.get("label").and_then(Value::as_str).filter(|l| !l.trim().is_empty()) {
            svg.text(n.x + 12.0, n.y + 26.0, 18.0, "muted", "start", &svg::ellipsis(l, 60));
        }
    }
    // Edges.
    for e in &c.edges {
        let (Some(from), Some(to)) = (by_id.get(e.from.as_str()), by_id.get(e.to.as_str())) else { continue };
        let fs = e.extra.get("fromSide").and_then(Value::as_str).unwrap_or_else(|| facing(from, to));
        let ts = e.extra.get("toSide").and_then(Value::as_str).unwrap_or_else(|| facing(to, from));
        let (x1, y1) = side_point(from, fs);
        let (x2, y2) = side_point(to, ts);
        let stroke = color_of(e.extra.get("color")).map(|c| format!(r#" stroke="{}""#, svg::esc(&c))).unwrap_or_default();
        let head = if e.extra.get("toEnd").and_then(Value::as_str) == Some("none") { "" } else { r#" marker-end="url(#a)""# };
        svg.line(x1, y1, x2, y2, "edge", &format!(r#" stroke-width="2"{stroke}{head}"#));
        if let Some(l) = e.extra.get("label").and_then(Value::as_str).filter(|l| !l.trim().is_empty()) {
            let (mx, my) = ((x1 + x2) / 2.0, (y1 + y2) / 2.0);
            let label = svg::ellipsis(l, 40);
            let w = label.chars().count() as f64 * 7.2 + 10.0;
            svg.rect((mx - w / 2.0, my - 12.0, w, 20.0), 5.0, "card", "");
            svg.text(mx, my + 2.0, 13.0, "muted", "middle", &label);
        }
    }
    // Cards.
    for n in c.nodes.iter().filter(|n| n.kind != "group") {
        let stroke = color_of(n.extra.get("color")).map(|c| format!(r#" stroke="{}" stroke-width="2.5""#, svg::esc(&c))).unwrap_or_default();
        svg.rect((n.x, n.y, n.width, n.height), 8.0, "card", &stroke);
        let (title, body) = card_text(s, n, &rel, snippets);
        let cols = ((n.width - 20.0) / 7.6).max(6.0) as usize;
        let mut y = n.y + 24.0;
        if let Some(t) = title {
            svg.text(n.x + 10.0, y, 15.0, "", "start", &svg::ellipsis(&t, cols));
            y += 20.0;
        }
        let rows = (((n.y + n.height - 6.0) - y) / 17.0).max(0.0) as usize;
        if rows > 0 && !body.is_empty() {
            let lines = svg::wrap(&body, cols, rows.min(30));
            svg.text_block(n.x + 10.0, y, 13.0, 17.0, "muted", &lines);
        }
    }
    let out = svg.finish(&format!("Canvas {rel}"), svg::THEME_CSS);
    svg_out(out, json!({ "path": rel, "nodes": c.nodes.len(), "edges": c.edges.len(), "width": width, "height": height }))
}

/// The heading and body a card shows.
fn card_text(s: &Server, n: &CanvasNode, canvas: &str, snippets: bool) -> (Option<String>, String) {
    match n.kind.as_str() {
        "file" => {
            let file = n.extra.get("file").and_then(Value::as_str).unwrap_or("");
            let title = file.rsplit('/').next().unwrap_or(file).trim_end_matches(".md").to_string();
            let body = if snippets {
                s.vault
                    .index
                    .resolve_link(file, canvas)
                    .and_then(|p| s.vault.index.note(&p).map(|note| note.text.clone()))
                    .map(|t| {
                        let start = vault_ofm::parse_frontmatter(&t).body_start_byte.min(t.len());
                        t[start..].lines().filter(|l| !l.trim().is_empty()).take(12).collect::<Vec<_>>().join("\n")
                    })
                    .unwrap_or_else(|| "(note not found)".into())
            } else {
                String::new()
            };
            (Some(title), body)
        }
        "link" => {
            let url = n.extra.get("url").and_then(Value::as_str).unwrap_or("");
            (Some("Link".into()), url.to_string())
        }
        _ => (None, n.extra.get("text").and_then(Value::as_str).unwrap_or("").to_string()),
    }
}

// ---- canvas_edit -----------------------------------------------------------------------

fn object_list<'a>(a: &'a Map<String, Value>, key: &str) -> Result<Vec<&'a Map<String, Value>>, ToolError> {
    match a.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(v)) => v
            .iter()
            .map(|x| x.as_object().ok_or_else(|| format!("every item of `{key}` must be an object").into()))
            .collect(),
        Some(_) => Err(format!("`{key}` must be an array of objects").into()),
    }
}

fn id_list(a: &Map<String, Value>, key: &str) -> Result<Vec<String>, ToolError> {
    match a.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(v)) => v
            .iter()
            .map(|x| x.as_str().map(str::to_string).ok_or_else(|| format!("`{key}` must be an array of id strings").into()))
            .collect(),
        Some(_) => Err(format!("`{key}` must be an array of id strings").into()),
    }
}

const NODE_TYPES: [&str; 4] = ["text", "file", "link", "group"];

fn node_from(m: &Map<String, Value>, seed: &mut u64, taken: &[String]) -> Result<CanvasNode, ToolError> {
    let kind = m.get("type").and_then(Value::as_str).unwrap_or("text").to_string();
    if !NODE_TYPES.contains(&kind.as_str()) {
        return Err(format!("a card's `type` must be text, file, link or group (got {kind})").into());
    }
    let id = match m.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(s) if taken.iter().any(|t| t == s) => return Err(format!("a card with id {s} is already on this canvas").into()),
        Some(s) => s.to_string(),
        None => new_id(seed),
    };
    let mut extra: Map<String, Value> = m.iter().filter(|(k, _)| !["id", "type", "x", "y", "width", "height"].contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    match kind.as_str() {
        "text" => {
            if !extra.get("text").is_some_and(Value::is_string) {
                return Err("a `text` card needs `text` (its Markdown)".into());
            }
        }
        "file" => {
            if !extra.get("file").is_some_and(Value::is_string) {
                return Err("a `file` card needs `file` (a vault path such as `Projects/Alpha.md`)".into());
            }
        }
        "link" => {
            if !extra.get("url").is_some_and(Value::is_string) {
                return Err("a `link` card needs `url`".into());
            }
        }
        _ => {
            extra.entry("label").or_insert(json!(""));
        }
    }
    let default_size = if kind == "group" { (400.0, 400.0) } else { (250.0, 60.0) };
    Ok(CanvasNode {
        id,
        kind,
        x: num(m.get("x"), 0.0).round(),
        y: num(m.get("y"), 0.0).round(),
        width: num(m.get("width"), default_size.0).round().max(1.0),
        height: num(m.get("height"), default_size.1).round().max(1.0),
        extra,
    })
}

const SIDES: [&str; 4] = ["top", "right", "bottom", "left"];

fn t_canvas_edit(s: &mut Server, a: &Map<String, Value>) -> R {
    let arg = req_str(a, "path")?;
    let (rel, mut c, mut file) = match read_canvas(s, arg) {
        Ok((rel, c)) => {
            let f = fsx::read_text(&fsx::confined(&s.root, &rel)?, &rel)?;
            (rel, c, f)
        }
        Err(e) if opt_bool(a, "create_if_missing", false)? => {
            let _ = e;
            let mut rel = fsx::clean_rel(arg)?;
            if !rel.to_lowercase().ends_with(".canvas") {
                rel.push_str(".canvas");
            }
            if fsx::confined(&s.root, &rel)?.symlink_metadata().is_ok() {
                return Err(format!("already exists: {rel}").into());
            }
            (rel, Canvas { nodes: Vec::new(), edges: Vec::new(), rest: Map::new() }, TextFile::new(String::new()))
        }
        Err(e) => return Err(e),
    };
    let mut seed = seed_from(&rel);
    let before = (c.nodes.len(), c.edges.len());

    for id in id_list(a, "remove_nodes")? {
        if !c.nodes.iter().any(|n| n.id == id) {
            return Err(format!("no card with id {id} on {rel} (read it with canvas_read)").into());
        }
        c.nodes.retain(|n| n.id != id);
        c.edges.retain(|e| e.from != id && e.to != id);
    }
    for id in id_list(a, "remove_edges")? {
        if !c.edges.iter().any(|e| e.id == id) {
            return Err(format!("no edge with id {id} on {rel}").into());
        }
        c.edges.retain(|e| e.id != id);
    }
    for m in object_list(a, "update_nodes")? {
        let Some(id) = m.get("id").and_then(Value::as_str) else {
            return Err("every item of `update_nodes` needs the `id` of the card to change".into());
        };
        let Some(n) = c.nodes.iter_mut().find(|n| n.id == id) else {
            return Err(format!("no card with id {id} on {rel} (read it with canvas_read)").into());
        };
        for (k, v) in m {
            match k.as_str() {
                "id" => {}
                "type" => {
                    let t = v.as_str().unwrap_or_default();
                    if !NODE_TYPES.contains(&t) {
                        return Err(format!("a card's `type` must be text, file, link or group (got {v})").into());
                    }
                    n.kind = t.to_string();
                }
                "x" => n.x = num(Some(v), n.x).round(),
                "y" => n.y = num(Some(v), n.y).round(),
                "width" => n.width = num(Some(v), n.width).round().max(1.0),
                "height" => n.height = num(Some(v), n.height).round().max(1.0),
                _ if v.is_null() => {
                    n.extra.remove(k);
                }
                _ => {
                    n.extra.insert(k.clone(), v.clone());
                }
            }
        }
    }
    for m in object_list(a, "add_nodes")? {
        let taken: Vec<String> = c.nodes.iter().map(|n| n.id.clone()).collect();
        c.nodes.push(node_from(m, &mut seed, &taken)?);
    }
    for m in object_list(a, "add_edges")? {
        let (Some(from), Some(to)) = (m.get("fromNode").and_then(Value::as_str), m.get("toNode").and_then(Value::as_str)) else {
            return Err("every item of `add_edges` needs `fromNode` and `toNode` (card ids)".into());
        };
        for id in [from, to] {
            if !c.nodes.iter().any(|n| n.id == id) {
                return Err(format!("an edge names card {id}, which is not on {rel}").into());
            }
        }
        for key in ["fromSide", "toSide"] {
            if let Some(v) = m.get(key).and_then(Value::as_str) {
                if !SIDES.contains(&v) {
                    return Err(format!("`{key}` must be top, right, bottom or left (got {v})").into());
                }
            }
        }
        let id = match m.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(s) if c.edges.iter().any(|e| e.id == s) => return Err(format!("an edge with id {s} is already on this canvas").into()),
            Some(s) => s.to_string(),
            None => new_id(&mut seed),
        };
        let extra = m.iter().filter(|(k, _)| !["id", "fromNode", "toNode"].contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
        c.edges.push(CanvasEdge { id, from: from.to_string(), to: to.to_string(), extra });
    }
    // Dangling edges are dropped by every renderer; refuse to write one.
    if let Some(e) = c.edges.iter().find(|e| !c.nodes.iter().any(|n| n.id == e.from) || !c.nodes.iter().any(|n| n.id == e.to)) {
        return Err(format!("edge {} points at a card that is not on the canvas; remove it with remove_edges", e.id).into());
    }
    if before == (c.nodes.len(), c.edges.len()) && object_list(a, "update_nodes")?.is_empty() && !file.text.is_empty() {
        return Ok(done(format!("{rel}: no changes"), json!({ "path": rel, "changed": false })));
    }
    file.text = serialize_canvas(&c);
    s.write_file(&rel, &file)?;
    Ok(done(
        format!("Updated {rel}: {} card(s), {} edge(s)", c.nodes.len(), c.edges.len()),
        json!({ "path": rel, "changed": true, "nodes": c.nodes.len(), "edges": c.edges.len() }),
    ))
}
