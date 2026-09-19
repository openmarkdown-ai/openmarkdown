//! Graph view data: nodes and links for the global graph and the local graph,
//! with the graph settings' filters and color groups.
//!
//! Reproduces the graph core plugin of Obsidian 1.13:
//!
//! * Every indexed file is a candidate node. Files other than notes, canvases
//!   and bases are attachments and only appear with "Attachments" on.
//! * A note's links come from `resolvedLinks`; with "Existing files only"
//!   off its unresolved links add `unresolved` nodes; with "Tags" on its tags
//!   (frontmatter and body, not parent tags) add `tag` nodes, named with the
//!   spelling `getTags()` settled on.
//! * The search filter and the color groups are search queries evaluated per
//!   file. A note passes when the filter (if any) matches; its group is the
//!   first color group that matches. Attachments and tags are only tested
//!   against the filter (by file path / tag text) and are never colored — as
//!   in the app. The local graph's center note always passes.
//! * Local graph: starting from the center note, each of `depth` rounds adds
//!   notes linked from (outgoing) or linking to (incoming) the current set,
//!   never expanding through tag nodes. Only the links used to reach a node
//!   are kept unless "Neighbor links" is on, which restores every link
//!   between included nodes.
//! * "Orphans" off removes nodes with no link to or from another node.
//!
//! Link endpoints are node indices; links to nodes that are not in the graph
//! (filtered out, or attachments with attachments hidden) are dropped, as the
//! renderer drops them.

use crate::index::VaultIndex;
use crate::search::{parse_query, Query};
use crate::tags::all_tags;
use crate::util::{self, basename, extension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColorGroup {
    pub query: String,
    /// Opaque to the index (Obsidian stores `{a, rgb}`).
    #[serde(default)]
    pub color: serde_json::Value,
}

/// The graph settings, with Obsidian's `graph.json` names and defaults.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphOptions {
    /// Filter: search query (empty = none).
    pub search: String,
    pub show_tags: bool,
    pub show_attachments: bool,
    /// "Existing files only".
    pub hide_unresolved: bool,
    pub show_orphans: bool,
    pub color_groups: Vec<ColorGroup>,
    /// Center note for a local graph; `None` for the global graph.
    pub local_file: Option<String>,
    /// Depth 1–5.
    pub local_jumps: u32,
    /// "Incoming links".
    pub local_backlinks: bool,
    /// "Outgoing links".
    pub local_forelinks: bool,
    /// "Neighbor links".
    pub local_interlinks: bool,
}

impl Default for GraphOptions {
    fn default() -> Self {
        GraphOptions {
            search: String::new(),
            show_tags: false,
            show_attachments: false,
            hide_unresolved: false,
            show_orphans: true,
            color_groups: Vec::new(),
            local_file: None,
            local_jumps: 1,
            local_backlinks: true,
            local_forelinks: true,
            local_interlinks: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Note,
    Attachment,
    Tag,
    Unresolved,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// File path, tag (`#tag`), or unresolved link text.
    pub id: String,
    pub label: String,
    pub kind: NodeKind,
    /// Index into `color_groups` of the group coloring this node.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group: Option<usize>,
    /// Number of links touching the node (drives node size).
    pub weight: u32,
    /// Local graph: hops from the center (0 for the center).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub depth: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct GraphLink {
    pub source: u32,
    pub target: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub links: Vec<GraphLink>,
    /// Parse errors of the filter or color group queries (those queries are
    /// ignored).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub errors: Vec<String>,
}

#[derive(Clone)]
struct RawNode {
    kind: NodeKind,
    group: Option<usize>,
    /// Insertion-ordered link targets.
    links: Vec<String>,
    link_set: HashSet<String>,
}

impl RawNode {
    fn new(kind: NodeKind) -> Self {
        RawNode {
            kind,
            group: None,
            links: Vec::new(),
            link_set: HashSet::new(),
        }
    }
    fn link(&mut self, to: &str) {
        if self.link_set.insert(to.to_string()) {
            self.links.push(to.to_string());
        }
    }
}

/// Insertion-ordered node map (a JS object's key order).
#[derive(Default, Clone)]
struct NodeMap {
    order: Vec<String>,
    map: HashMap<String, RawNode>,
}

impl NodeMap {
    fn contains(&self, id: &str) -> bool {
        self.map.contains_key(id)
    }
    fn insert(&mut self, id: &str, n: RawNode) {
        if !self.map.contains_key(id) {
            self.order.push(id.to_string());
        }
        self.map.insert(id.to_string(), n);
    }
    fn get_mut(&mut self, id: &str) -> Option<&mut RawNode> {
        self.map.get_mut(id)
    }
    fn get(&self, id: &str) -> Option<&RawNode> {
        self.map.get(id)
    }
}

fn is_attachment(path: &str) -> bool {
    !util::is_document_ext(&extension(basename(path)))
}

impl VaultIndex {
    pub fn graph(&self, opts: &GraphOptions) -> GraphData {
        let mut errors = Vec::new();
        // Filter first, then color groups — the order the app evaluates.
        let mut queries: Vec<(Query, Option<usize>)> = Vec::new();
        if !opts.search.trim().is_empty() {
            match parse_query(&opts.search) {
                Ok(q) if q.root.is_some() => queries.push((q, None)),
                Ok(_) => {}
                Err(e) => errors.push(e),
            }
        }
        for (i, g) in opts.color_groups.iter().enumerate() {
            match parse_query(&g.query) {
                Ok(q) if q.root.is_some() => queries.push((q, Some(i))),
                Ok(_) => {}
                Err(e) => errors.push(e),
            }
        }
        let has_filter = queries.iter().any(|(_, g)| g.is_none());

        // fileFilter: path → None (filtered out) / Some(group).
        let mut file_filter: HashMap<&str, Option<Option<usize>>> = HashMap::new();
        if !queries.is_empty() {
            for e in self.files() {
                if !util::is_supported_ext(&extension(basename(&e.path))) {
                    continue;
                }
                let mut pass = true;
                let mut group = None;
                for (q, g) in &queries {
                    let m = q.matches_file(self, &e.path, false);
                    if !m && g.is_none() {
                        pass = false;
                        break;
                    }
                    if m && g.is_some() {
                        group = *g;
                        break;
                    }
                }
                file_filter.insert(&e.path, if pass { Some(group) } else { None });
            }
        }
        let local = opts.local_file.as_deref();
        // n(path, type) from the app. Returns Some(group) when the node passes.
        let passes = |id: &str, kind: NodeKind| -> Option<Option<usize>> {
            if queries.is_empty() {
                return Some(None);
            }
            match kind {
                NodeKind::Note => {
                    if Some(id) == local {
                        // Passes unconditionally and, as in the app, uncolored.
                        return Some(None);
                    }
                    match file_filter.get(id) {
                        Some(v) => *v,
                        None => {
                            if has_filter {
                                None
                            } else {
                                Some(None)
                            }
                        }
                    }
                }
                NodeKind::Tag => queries
                    .iter()
                    .all(|(q, g)| g.is_some() || q.matches_tag(id, false))
                    .then_some(None),
                NodeKind::Attachment => queries
                    .iter()
                    .all(|(q, g)| g.is_some() || q.matches_filepath(id, false))
                    .then_some(None),
                NodeKind::Unresolved => Some(None),
            }
        };

        let tag_names: HashMap<String, String> = if opts.show_tags {
            self.tags()
                .into_keys()
                .map(|t| (t.to_lowercase(), t))
                .collect()
        } else {
            HashMap::new()
        };

        let mut nodes = NodeMap::default();
        self.with_links(|resolved, unresolved| {
            for e in self.files() {
                let path = e.path.as_str();
                let attachment = is_attachment(path);
                if attachment && !opts.show_attachments {
                    continue;
                }
                let kind = if attachment {
                    NodeKind::Attachment
                } else {
                    NodeKind::Note
                };
                let Some(group) = passes(path, kind) else {
                    continue;
                };
                let mut node = RawNode::new(kind);
                node.group = group;
                // The file's node is created before the nodes it introduces.
                nodes.insert(path, RawNode::new(kind));
                if let Some(targets) = resolved.get(path) {
                    for t in targets.keys() {
                        let ta = is_attachment(t);
                        if (opts.show_attachments || !ta)
                            && passes(
                                t,
                                if ta {
                                    NodeKind::Attachment
                                } else {
                                    NodeKind::Note
                                },
                            )
                            .is_some()
                        {
                            node.link(t);
                        }
                    }
                }
                if !opts.hide_unresolved {
                    if let Some(targets) = unresolved.get(path) {
                        for t in targets.keys() {
                            node.link(t);
                            if !nodes.contains(t) {
                                nodes.insert(t, RawNode::new(NodeKind::Unresolved));
                            }
                        }
                    }
                }
                if opts.show_tags {
                    if let Some(note) = self.note(path) {
                        for t in all_tags(&note.meta) {
                            if passes(&t, NodeKind::Tag).is_none() {
                                continue;
                            }
                            let name = tag_names.get(&t.to_lowercase()).cloned().unwrap_or(t);
                            node.link(&name);
                            if !nodes.contains(&name) {
                                nodes.insert(&name, RawNode::new(NodeKind::Tag));
                            }
                        }
                    }
                }
                nodes.insert(path, node);
            }
        });

        let mut depth: HashMap<String, u32> = HashMap::new();
        if let Some(center) = local {
            nodes = local_graph(&nodes, center, opts, &mut depth);
        }
        if !opts.show_orphans {
            remove_orphans(&mut nodes);
        }

        // Emit.
        let index_of: HashMap<&str, u32> = nodes
            .order
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i as u32))
            .collect();
        let mut links = Vec::new();
        let mut seen = HashSet::new();
        let mut weight = vec![0u32; nodes.order.len()];
        for (si, id) in nodes.order.iter().enumerate() {
            for t in &nodes.map[id].links {
                let Some(&ti) = index_of.get(t.as_str()) else {
                    continue;
                };
                if ti as usize == si || !seen.insert((si as u32, ti)) {
                    continue;
                }
                links.push(GraphLink {
                    source: si as u32,
                    target: ti,
                });
                weight[si] += 1;
                weight[ti as usize] += 1;
            }
        }
        let out_nodes = nodes
            .order
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let n = &nodes.map[id];
                GraphNode {
                    id: id.clone(),
                    label: match n.kind {
                        NodeKind::Note => util::stem(id).to_string(),
                        NodeKind::Attachment => basename(id).to_string(),
                        NodeKind::Tag | NodeKind::Unresolved => id.clone(),
                    },
                    kind: n.kind,
                    group: n.group,
                    weight: weight[i],
                    depth: depth.get(id).copied(),
                }
            })
            .collect();
        GraphData {
            nodes: out_nodes,
            links,
            errors,
        }
    }
}

/// `m$`: expand from the center.
fn local_graph(
    all: &NodeMap,
    center: &str,
    opts: &GraphOptions,
    depth: &mut HashMap<String, u32>,
) -> NodeMap {
    let mut inc = NodeMap::default();
    depth.insert(center.to_string(), 0);
    let Some(c) = all.get(center) else {
        inc.insert(center, RawNode::new(NodeKind::Note));
        return inc;
    };
    let mut first = RawNode::new(c.kind);
    first.group = c.group;
    inc.insert(center, first);
    let jumps = opts.local_jumps.clamp(1, 5);
    for round in 0..jumps {
        let mut added = NodeMap::default();
        for id in &all.order {
            let node = &all.map[id];
            if node.kind == NodeKind::Tag {
                continue;
            }
            for target in &node.links {
                let src_in = inc.contains(id);
                let tgt_in = inc.contains(target);
                if opts.local_forelinks
                    && src_in
                    && !tgt_in
                    && inc.get(id).is_some_and(|n| n.kind != NodeKind::Tag)
                {
                    if !added.contains(target) {
                        let mut n = all.get(target).map_or_else(
                            || RawNode::new(NodeKind::Unresolved),
                            |t| RawNode::new(t.kind),
                        );
                        n.group = all.get(target).and_then(|t| t.group);
                        added.insert(target, n);
                    }
                    inc.get_mut(id).unwrap().link(target);
                } else if opts.local_backlinks
                    && tgt_in
                    && !src_in
                    && inc.get(target).is_some_and(|n| n.kind != NodeKind::Tag)
                {
                    if !added.contains(id) {
                        let mut n = RawNode::new(node.kind);
                        n.group = node.group;
                        added.insert(id, n);
                    }
                    added.get_mut(id).unwrap().link(target);
                }
            }
        }
        for id in added.order.clone() {
            let n = added.map.remove(&id).unwrap();
            depth.entry(id.clone()).or_insert(round + 1);
            inc.insert(&id, n);
        }
    }
    if opts.local_interlinks {
        for id in inc.order.clone() {
            if let Some(full) = all.get(&id) {
                inc.map.insert(id, full.clone());
            }
        }
    }
    inc
}

/// The app's orphan filter: a node stays if some other node links to it or
/// it links to another existing node. Removal happens in node order.
fn remove_orphans(nodes: &mut NodeMap) {
    let mut incoming: HashSet<String> = HashSet::new();
    for id in &nodes.order {
        for t in &nodes.map[id].links {
            if t != id {
                incoming.insert(t.clone());
            }
        }
    }
    let mut removed: HashSet<String> = HashSet::new();
    for id in &nodes.order {
        let has_out = nodes.map[id]
            .links
            .iter()
            .any(|t| t != id && nodes.contains(t) && !removed.contains(t));
        if !has_out && !incoming.contains(id) {
            removed.insert(id.clone());
        }
    }
    if !removed.is_empty() {
        nodes.order.retain(|id| !removed.contains(id));
        for id in &removed {
            nodes.map.remove(id);
        }
    }
}
