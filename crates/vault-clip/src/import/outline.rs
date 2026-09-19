//! Outliner blocks to Markdown, as an outline or flattened into prose.
//!
//! Port of obsidian-importer's `outline.ts`. Roam and Logseq store everything
//! as nested bullets; written out verbatim that is a note of nothing but list
//! items. Flattening ("de-outlining") keeps top-level blocks as paragraphs and
//! only writes a list where the blocks are list-shaped: a run of tasks, two or
//! more item-like siblings, or the children of a heading.

use super::mdcode::outside_fences;

#[derive(Debug, Clone, PartialEq)]
pub struct OutlineNode {
    /// `None` omits the block's own line but keeps its children.
    pub text: Option<String>,
    pub anchor: Option<String>,
    /// Content that must stay at the left margin, such as a pipe table.
    pub verbatim: Option<String>,
    pub children: Vec<OutlineNode>,
}

impl OutlineNode {
    pub fn text(text: impl Into<String>) -> OutlineNode {
        OutlineNode {
            text: Some(text.into()),
            anchor: None,
            verbatim: None,
            children: Vec::new(),
        }
    }
}

fn starts_fence(line: &str) -> bool {
    line.trim_start().starts_with("```")
}

/// Indent continuation lines, including blank lines inside fenced code.
pub fn with_continuation(lines: &[&str], continuation: &str) -> Vec<String> {
    let mut inside = false;
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let was_inside = inside;
            if starts_fence(line) {
                inside = !inside;
            }
            if i == 0 {
                line.to_string()
            } else if !line.is_empty() {
                format!("{continuation}{line}")
            } else if was_inside {
                continuation.to_string()
            } else {
                String::new()
            }
        })
        .collect()
}

/// Put `^anchor` on a one-line block, or on its own line after a multi-line
/// block (so it never lands on a closing fence).
pub fn anchor_lines(mut lines: Vec<String>, anchor: Option<&str>, continuation: &str) -> Vec<String> {
    let Some(anchor) = anchor else {
        return lines;
    };
    if lines.len() > 1 {
        lines.push(format!("{continuation}^{anchor}"));
    } else if let Some(first) = lines.first_mut() {
        first.push_str(&format!(" ^{anchor}"));
    }
    lines
}

fn is_heading(b: &OutlineNode) -> bool {
    b.verbatim.is_none()
        && b.text.as_deref().is_some_and(|t| {
            let hashes = t.chars().take_while(|c| *c == '#').count();
            (1..=6).contains(&hashes)
                && t[hashes..].starts_with(char::is_whitespace)
                && !t[hashes..].trim().is_empty()
        })
}

fn is_task(b: &OutlineNode) -> bool {
    b.verbatim.is_none()
        && b.text.as_deref().is_some_and(|t| {
            let c: Vec<char> = t.chars().take(4).collect();
            c.len() >= 4 && c[0] == '[' && c[2] == ']' && c[3].is_whitespace()
        })
}

fn is_list(blocks: &[OutlineNode]) -> bool {
    blocks.len() >= 2 && blocks.iter().all(can_be_list_item)
}

fn can_be_list_item(b: &OutlineNode) -> bool {
    if b.verbatim.is_some() || b.text.is_none() || is_heading(b) {
        return false;
    }
    if is_task(b) || b.children.is_empty() || is_list(&b.children) {
        return true;
    }
    b.children.len() == 1 && can_be_list_item(&b.children[0])
}

fn is_chain(b: &OutlineNode) -> bool {
    if b.children.len() != 1 {
        return false;
    }
    let c = &b.children[0];
    if c.verbatim.is_some() || c.text.is_none() || is_heading(c) || is_task(c) {
        return false;
    }
    c.children.is_empty() || is_chain(c)
}

fn text_of(b: &OutlineNode, continuation: &str) -> Vec<String> {
    let text = b.text.clone().unwrap_or_default();
    let lines: Vec<&str> = text.split('\n').collect();
    anchor_lines(with_continuation(&lines, continuation), b.anchor.as_deref(), continuation)
}

fn as_list(blocks: &[OutlineNode], depth: usize) -> Vec<String> {
    let indent = "    ".repeat(depth);
    let mut lines = Vec::new();
    for b in blocks {
        let mut t = text_of(b, &format!("{indent}  ")).into_iter();
        lines.push(format!("{indent}- {}", t.next().unwrap_or_default()));
        lines.extend(t);
        if !b.children.is_empty() {
            lines.extend(as_list(&b.children, depth + 1));
        }
    }
    lines
}

fn as_chain(b: &OutlineNode) -> Vec<String> {
    let mut lines = text_of(b, "");
    let mut cur = b;
    while is_chain(cur) {
        cur = &cur.children[0];
        lines.push(String::new());
        lines.extend(text_of(cur, ""));
    }
    lines
}

fn as_prose(blocks: &[OutlineNode]) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    fn separate(lines: &mut Vec<String>) {
        if lines.last().is_some_and(|l| !l.is_empty()) {
            lines.push(String::new());
        }
    }
    let mut at = 0;
    while at < blocks.len() {
        let b = &blocks[at];
        if let Some(v) = &b.verbatim {
            separate(&mut lines);
            lines.extend(v.split('\n').filter(|l| !l.is_empty()).map(String::from));
            at += 1;
            continue;
        }
        if b.text.is_none() {
            if !b.children.is_empty() {
                separate(&mut lines);
                lines.extend(as_prose(&b.children));
            }
            at += 1;
            continue;
        }
        if is_heading(b) {
            separate(&mut lines);
            lines.extend(text_of(b, ""));
            if !b.children.is_empty() {
                separate(&mut lines);
                if is_list(&b.children) {
                    lines.extend(as_list(&b.children, 0));
                } else {
                    lines.extend(as_prose(&b.children));
                }
            }
            at += 1;
            continue;
        }
        if is_task(b) {
            let start = at;
            while at + 1 < blocks.len() && is_task(&blocks[at + 1]) {
                at += 1;
            }
            separate(&mut lines);
            lines.extend(as_list(&blocks[start..=at], 0));
            at += 1;
            continue;
        }
        if is_list(&b.children) {
            separate(&mut lines);
            lines.extend(text_of(b, ""));
            separate(&mut lines);
            lines.extend(as_list(&b.children, 0));
            at += 1;
            continue;
        }
        if is_chain(b) {
            separate(&mut lines);
            lines.extend(as_chain(b));
            at += 1;
            continue;
        }
        separate(&mut lines);
        lines.extend(text_of(b, ""));
        if !b.children.is_empty() {
            separate(&mut lines);
            lines.extend(as_prose(&b.children));
        }
        at += 1;
    }
    lines
}

/// Flatten top-level blocks into prose; only list-shaped runs stay lists.
pub fn de_outline(blocks: &[OutlineNode]) -> String {
    let joined = as_prose(blocks).join("\n");
    outside_fences(&joined, |seg| {
        let mut out = String::with_capacity(seg.len());
        let mut newlines = 0;
        for c in seg.chars() {
            if c == '\n' {
                newlines += 1;
                if newlines <= 2 {
                    out.push(c);
                }
            } else {
                newlines = 0;
                out.push(c);
            }
        }
        out
    })
    .trim()
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(text: &str, children: Vec<OutlineNode>) -> OutlineNode {
        OutlineNode {
            children,
            ..OutlineNode::text(text)
        }
    }

    #[test]
    fn headings_lists_chains_and_tasks() {
        let blocks = vec![
            node("## Community videos", vec![node("One", vec![]), node("Another", vec![])]),
            node("## Background", vec![node("A paragraph on its own.", vec![])]),
            node("[ ] task one", vec![]),
            node("[x] task two", vec![]),
            node("Reading notes", vec![node("a", vec![]), node("b", vec![node("c", vec![])])]),
            node("Chain start", vec![node("then this", vec![])]),
        ];
        assert_eq!(
            de_outline(&blocks),
            "## Community videos\n\n- One\n- Another\n\n## Background\n\nA paragraph on its own.\n\n- [ ] task one\n- [x] task two\n\nReading notes\n\n- a\n- b\n    - c\n\nChain start\n\nthen this"
        );
    }

    #[test]
    fn anchors_go_after_multiline_blocks() {
        let mut b = OutlineNode::text("```js\nconst one = 1;\n```");
        b.anchor = Some("blk".into());
        assert_eq!(de_outline(&[b]), "```js\nconst one = 1;\n```\n^blk");
        let mut single = OutlineNode::text("one line");
        single.anchor = Some("x1".into());
        assert_eq!(de_outline(&[single]), "one line ^x1");
    }
}
