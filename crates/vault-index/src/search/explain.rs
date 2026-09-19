//! "Explain search term": the tree Obsidian renders under the search box,
//! with the app's English labels (`getInfo()` of each matcher).

use super::parser::{Node, Query};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    pub label: String,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub children: Vec<Explanation>,
}

impl Explanation {
    /// Indented plain text, two spaces per level.
    pub fn to_text(&self) -> String {
        let mut out = String::new();
        self.write(0, &mut out);
        out
    }

    fn write(&self, depth: usize, out: &mut String) {
        out.push_str(&"  ".repeat(depth));
        out.push_str(self.label.trim_end());
        out.push('\n');
        for c in &self.children {
            c.write(depth + 1, out);
        }
    }
}

/// The matcher's own label.
pub fn label(n: &Node) -> String {
    match n {
        Node::Text(t) => format!("Matches text: \"{t}\""),
        Node::Exact(t) => format!("Contains exact text: \"{t}\""),
        Node::Regex(r) => format!("Matches regex: /{}/", r.source),
        Node::And(_) => "Match all of: ".into(),
        Node::Or(_) => "Match any of: ".into(),
        Node::Not(_) => "Excluding: ".into(),
        Node::Case(true, _) => "Case sensitive".into(),
        Node::Case(false, _) => "Case insensitive".into(),
        Node::Path(_) => "Match file path: ".into(),
        Node::File(_) => "Match file name: ".into(),
        Node::Content(_) => "Match file content: ".into(),
        Node::Line(_) => "Match line: ".into(),
        Node::Block(_) => "Match block: ".into(),
        Node::Section(_) => "Match section: ".into(),
        Node::Task(None, _) => "Match task: ".into(),
        Node::Task(Some(false), _) => "Match task (todo): ".into(),
        Node::Task(Some(true), _) => "Match task (done): ".into(),
        Node::Tag(t) => format!("Match tag: {t}"),
        Node::Property { .. } => "Contains property:".into(),
        Node::Literal(Some(true)) => "Is true".into(),
        Node::Literal(Some(false)) => "Is false".into(),
        Node::Literal(None) => "Is empty".into(),
        Node::Compare { less: true, text } => format!("Less than: {text}"),
        Node::Compare { less: false, text } => format!("Greater than: {text}"),
        Node::Everything => String::new(),
    }
}

/// `renderSearchInfo`: groups list their members, wrappers their operand,
/// properties a `Key:` and a `Value:` subtree.
pub fn explain_node(n: &Node) -> Explanation {
    let children = match n {
        Node::And(v) | Node::Or(v) => v.iter().map(explain_node).collect(),
        Node::Not(x)
        | Node::Case(_, x)
        | Node::Path(x)
        | Node::File(x)
        | Node::Content(x)
        | Node::Line(x)
        | Node::Block(x)
        | Node::Section(x)
        | Node::Task(_, x) => vec![explain_node(x)],
        Node::Property { key, value } => {
            let mut v = vec![Explanation {
                label: "Key:".into(),
                children: vec![explain_node(key)],
            }];
            if let Some(val) = value {
                v.push(Explanation {
                    label: "Value:".into(),
                    children: vec![explain_node(val)],
                });
            }
            v
        }
        _ => Vec::new(),
    };
    Explanation {
        label: label(n),
        children,
    }
}

impl Query {
    /// The explanation tree, `None` for an empty query.
    pub fn explain(&self) -> Option<Explanation> {
        self.root.as_ref().map(explain_node)
    }
}

/// Parses and explains in one step; the error is the parse error text.
pub fn explain(q: &str) -> Result<Option<Explanation>, String> {
    Ok(super::parser::parse_query(q)?.explain())
}

/// Compact one-line form used by tests.
#[cfg(test)]
pub fn compact(n: &Node) -> String {
    let list = |v: &Vec<Node>| v.iter().map(compact).collect::<Vec<_>>().join(",");
    match n {
        Node::Text(t) => format!("t:{t}"),
        Node::Exact(t) => format!("q:{t}"),
        Node::Regex(r) => format!("re:{}", r.source),
        Node::And(v) => format!("AND({})", list(v)),
        Node::Or(v) => format!("OR({})", list(v)),
        Node::Not(x) => format!("NOT({})", compact(x)),
        Node::Case(_, x) => format!("case({})", compact(x)),
        Node::Path(x) => format!("path({})", compact(x)),
        Node::File(x) => format!("file({})", compact(x)),
        Node::Content(x) => format!("content({})", compact(x)),
        Node::Line(x) => format!("line({})", compact(x)),
        Node::Block(x) => format!("block({})", compact(x)),
        Node::Section(x) => format!("section({})", compact(x)),
        Node::Task(None, x) => format!("task({})", compact(x)),
        Node::Task(Some(false), x) => format!("task-todo({})", compact(x)),
        Node::Task(Some(true), x) => format!("task-done({})", compact(x)),
        Node::Tag(t) => format!("tag({t})"),
        Node::Property { key, value: None } => format!("prop({})", compact(key)),
        Node::Property {
            key,
            value: Some(v),
        } => format!("prop({}={})", compact(key), compact(v)),
        Node::Literal(v) => format!("lit({v:?})"),
        Node::Compare { less, text } => format!("{}{}", if *less { "<" } else { ">" }, text),
        Node::Everything => "*".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explanation_tree_uses_app_labels() {
        let e = explain("meeting -\"star wars\" [status:Draft] tag:work")
            .unwrap()
            .unwrap();
        assert_eq!(
            e.to_text(),
            "Match all of:\n  Matches text: \"meeting\"\n  Excluding:\n    Contains exact text: \"star wars\"\n  Contains property:\n    Key:\n      Matches text: \"status\"\n    Value:\n      Matches text: \"Draft\"\n  Match tag: #work\n"
        );
    }

    #[test]
    fn explain_empty_and_error() {
        assert_eq!(explain("").unwrap(), None);
        assert!(explain("nope:x").is_err());
    }
}
