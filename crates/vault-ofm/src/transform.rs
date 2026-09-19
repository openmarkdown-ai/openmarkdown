//! Tree rewrites shared by metadata and rendering: local markdown links and
//! images become internal links and embeds, `^block-id`s attach to their
//! blocks, and block quotes that open with `[!type]` become callouts.
//!
//! Both consumers read the same rewritten tree, so a link that metadata
//! reports is always one the reading view renders as a link, and vice versa.

use crate::linktext::{is_local, normalize_href};
use crate::mdast::{Kind, Node, Position};
use crate::util::decode_uri;

pub(crate) fn apply(root: &mut Node) {
    local_links(root);
    block_ids(root);
    callouts(root);
}

pub(crate) fn walk_mut(node: &mut Node, f: &mut dyn FnMut(&mut Node)) {
    f(node);
    for child in node.children.iter_mut() {
        walk_mut(child, f);
    }
}

/// Internal links.md: `[Three laws of motion](Three%20laws%20of%20motion.md)`
/// is the same link as `[[Three laws of motion.md]]`, with the destination
/// URL-encoded. Anything with a scheme stays an external link.
fn local_links(root: &mut Node) {
    walk_mut(root, &mut |node| match &node.kind {
        Kind::Link { url, .. } if !url.is_empty() && is_local(url) => {
            let decoded = decode_uri(url).unwrap_or_else(|_| url.clone());
            node.kind = Kind::ILink { href: normalize_href(&decoded), title: String::new(), converted: true };
        }
        Kind::Image { url, alt, .. } if !url.is_empty() && is_local(url) => {
            let decoded = decode_uri(url).unwrap_or_else(|_| url.clone());
            let alt = alt.clone();
            node.kind = Kind::IEmbed {
                href: normalize_href(&decoded),
                title: alt.clone().unwrap_or_default(),
                alt,
                width: None,
                height: None,
            };
        }
        _ => {}
    });
}

fn first_block_id(node: &Node) -> Option<String> {
    for child in &node.children {
        match &child.kind {
            Kind::List { .. } => continue,
            Kind::BlockId(id) => return Some(id.clone()),
            _ => {
                if let Some(id) = first_block_id(child) {
                    return Some(id);
                }
            }
        }
    }
    None
}

fn last_block_id(node: &Node, found: &mut Option<String>) {
    if let Kind::BlockId(id) = &node.kind {
        *found = Some(id.clone());
    }
    for child in &node.children {
        last_block_id(child, found);
    }
}

/// Internal links.md: a ` ^id` at the end of a paragraph (or list item, or
/// heading) names that block; for lists, quotes, callouts and tables the id
/// goes on its own line after the block, separated by blank lines, and names
/// the block before it.
fn block_ids(root: &mut Node) {
    let mut i = 0usize;
    while i < root.children.len() {
        if let Kind::BlockId(id) = &root.children[i].kind {
            let id = id.clone();
            if i > 0 {
                root.children[i - 1].id = Some(id);
            }
            root.children.remove(i);
            continue;
        }
        let node = &mut root.children[i];
        if matches!(node.kind, Kind::List { .. }) {
            // Each item owns the id on its own lines; a nested item's id is
            // the nested item's, not its parent's.
            walk_mut(node, &mut |n| {
                if matches!(n.kind, Kind::ListItem { .. }) {
                    n.id = first_block_id(n);
                }
            });
        } else {
            let mut found = None;
            last_block_id(node, &mut found);
            if found.is_some() {
                node.id = found;
            }
        }
        i += 1;
    }
}

/// Callouts.md: `> [!type] Title` — the rest of the first line is the title,
/// the following lines are the content, and a callout with no title shows
/// its type, capitalised.
fn callouts(root: &mut Node) {
    walk_mut(root, &mut |node| {
        let Kind::Blockquote { callout: Some(info) } = &node.kind else { return };
        let info = info.clone();
        let mut children = std::mem::take(&mut node.children);
        let mut out = Vec::new();
        let has_title = children.first().map(|c| c.pos.start.line == node.pos.start.line).unwrap_or(false);
        if has_title {
            let first = children.remove(0);
            let pos = first.pos;
            let title_children = if matches!(first.kind, Kind::Paragraph) { first.children } else { vec![first] };
            out.push(Node::with_children(Kind::CalloutTitle, pos, title_children));
        } else {
            let at = Position { start: node.pos.start, end: node.pos.start };
            out.push(Node::with_children(
                Kind::CalloutTitle,
                at,
                vec![Node::new(Kind::Text(default_title(&info.kind)), at)],
            ));
        }
        if !children.is_empty() {
            let pos = Position { start: children[0].pos.start, end: children[children.len() - 1].pos.end };
            out.push(Node::with_children(Kind::CalloutContent, pos, children));
        }
        node.kind = Kind::Callout(info);
        node.children = out;
    });
}

/// `tip` → `Tip`, `my-type` → `My type`.
pub(crate) fn default_title(kind: &str) -> String {
    let t = kind.trim().replace('-', " ");
    let mut chars = t.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}
