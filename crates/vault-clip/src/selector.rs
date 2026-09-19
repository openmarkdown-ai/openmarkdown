//! CSS selectors (Selectors Level 4 subset) over [`crate::html::Document`].
//!
//! Needed twice: the clipper's `{{selector:…}}` variables take arbitrary
//! user-written selectors, and the extractor's clutter lists are selectors.
//! Supported: type/universal, `#id`, `.class`, all attribute operators with the
//! `i` flag, the four combinators, selector lists, `:not/:is/:where/:has`,
//! the structural pseudo-classes (`nth-child(An+B of S)`, `*-of-type`, …),
//! `:empty`, `:root`, `:checked`, `:first/last/only-*`. A selector using an
//! unsupported pseudo-class fails to parse, which mirrors `querySelectorAll`
//! throwing a SyntaxError (callers treat that as "no match").

use crate::html::{Document, NodeId};

#[derive(Debug, Clone, PartialEq)]
pub struct SelectorList(pub Vec<Complex>);

#[derive(Debug, Clone, PartialEq)]
pub struct Complex {
    /// Compounds right-to-left paired with the combinator that joins each to
    /// the next compound on its left.
    pub parts: Vec<(Compound, Option<Combinator>)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Combinator {
    Descendant,
    Child,
    Adjacent,
    Sibling,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Compound {
    pub tag: Option<String>,
    pub simple: Vec<Simple>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Simple {
    Id(String),
    Class(String),
    Attr {
        name: String,
        op: Option<(AttrOp, String)>,
        ci: bool,
    },
    Pseudo(Pseudo),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AttrOp {
    Eq,
    Includes,
    Dash,
    Prefix,
    Suffix,
    Substring,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Pseudo {
    Not(SelectorList),
    Is(SelectorList),
    Has(Vec<(Option<Combinator>, Complex)>),
    NthChild(i64, i64, Option<SelectorList>),
    NthLastChild(i64, i64, Option<SelectorList>),
    NthOfType(i64, i64),
    NthLastOfType(i64, i64),
    OnlyChild,
    OnlyOfType,
    Empty,
    Root,
    Checked,
    Disabled,
    Enabled,
    Link,
    Never,
}

pub fn parse(input: &str) -> Result<SelectorList, String> {
    let mut p = Parser {
        s: input.chars().collect(),
        i: 0,
    };
    let list = p.list()?;
    p.ws();
    if p.i < p.s.len() {
        return Err(format!("unexpected '{}' in selector", p.s[p.i]));
    }
    Ok(list)
}

struct Parser {
    s: Vec<char>,
    i: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) -> bool {
        let start = self.i;
        while self.peek().is_some_and(|c| c.is_whitespace()) {
            self.i += 1;
        }
        self.i > start
    }

    fn list(&mut self) -> Result<SelectorList, String> {
        let mut out = Vec::new();
        loop {
            self.ws();
            out.push(self.complex()?);
            self.ws();
            if self.peek() == Some(',') {
                self.i += 1;
                continue;
            }
            break;
        }
        Ok(SelectorList(out))
    }

    fn complex(&mut self) -> Result<Complex, String> {
        let mut compounds: Vec<Compound> = Vec::new();
        let mut combs: Vec<Combinator> = Vec::new();
        compounds.push(self.compound()?);
        loop {
            let had_ws = self.ws();
            let c = match self.peek() {
                Some('>') => {
                    self.i += 1;
                    Combinator::Child
                }
                Some('+') => {
                    self.i += 1;
                    Combinator::Adjacent
                }
                Some('~') => {
                    self.i += 1;
                    Combinator::Sibling
                }
                Some(',') | Some(')') | None => break,
                _ if had_ws => Combinator::Descendant,
                Some(ch) => return Err(format!("unexpected '{ch}'")),
            };
            self.ws();
            combs.push(c);
            compounds.push(self.compound()?);
        }
        let mut parts = Vec::new();
        for (idx, comp) in compounds.into_iter().enumerate().rev() {
            let comb = if idx == 0 { None } else { Some(combs[idx - 1]) };
            parts.push((comp, comb));
        }
        Ok(Complex { parts })
    }

    fn ident(&mut self) -> Result<String, String> {
        let mut out = String::new();
        while let Some(c) = self.peek() {
            if c == '\\' {
                self.i += 1;
                // Hex escape or literal.
                let mut hex = String::new();
                while hex.len() < 6 && self.peek().is_some_and(|h| h.is_ascii_hexdigit()) {
                    hex.push(self.peek().unwrap());
                    self.i += 1;
                }
                if !hex.is_empty() {
                    if let Some(ch) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                        out.push(ch);
                    }
                    if self.peek() == Some(' ') {
                        self.i += 1;
                    }
                } else if let Some(n) = self.peek() {
                    out.push(n);
                    self.i += 1;
                }
                continue;
            }
            if c.is_alphanumeric() || c == '-' || c == '_' || !c.is_ascii() {
                out.push(c);
                self.i += 1;
            } else {
                break;
            }
        }
        if out.is_empty() {
            return Err("expected identifier".into());
        }
        Ok(out)
    }

    fn compound(&mut self) -> Result<Compound, String> {
        let mut comp = Compound::default();
        let mut any = false;
        match self.peek() {
            Some('*') => {
                self.i += 1;
                any = true;
            }
            Some(c) if c.is_alphabetic() || c == '_' || c == '\\' || c == '-' => {
                comp.tag = Some(self.ident()?.to_ascii_lowercase());
                any = true;
            }
            _ => {}
        }
        // Namespace prefix `ns|tag` — ignore the namespace.
        if self.peek() == Some('|') && self.s.get(self.i + 1) != Some(&'=') {
            self.i += 1;
            if self.peek() == Some('*') {
                self.i += 1;
                comp.tag = None;
            } else {
                comp.tag = Some(self.ident()?.to_ascii_lowercase());
            }
        }
        loop {
            match self.peek() {
                Some('#') => {
                    self.i += 1;
                    comp.simple.push(Simple::Id(self.ident()?));
                }
                Some('.') => {
                    self.i += 1;
                    comp.simple.push(Simple::Class(self.ident()?));
                }
                Some('[') => {
                    self.i += 1;
                    comp.simple.push(self.attr()?);
                }
                Some(':') => {
                    self.i += 1;
                    if self.peek() == Some(':') {
                        self.i += 1;
                        let _ = self.ident()?;
                        if self.peek() == Some('(') {
                            self.skip_parens()?;
                        }
                        comp.simple.push(Simple::Pseudo(Pseudo::Never));
                    } else {
                        comp.simple.push(Simple::Pseudo(self.pseudo()?));
                    }
                }
                _ => break,
            }
            any = true;
        }
        if !any {
            return Err("empty compound selector".into());
        }
        Ok(comp)
    }

    fn skip_parens(&mut self) -> Result<(), String> {
        let mut depth = 0;
        while let Some(c) = self.peek() {
            self.i += 1;
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(());
                    }
                }
                _ => {}
            }
        }
        Err("unclosed (".into())
    }

    fn attr(&mut self) -> Result<Simple, String> {
        self.ws();
        let mut name = self.ident()?;
        if self.peek() == Some('|') && self.s.get(self.i + 1) != Some(&'=') {
            self.i += 1;
            name = self.ident()?;
        }
        self.ws();
        let op = match self.peek() {
            Some(']') => {
                self.i += 1;
                return Ok(Simple::Attr {
                    name: name.to_ascii_lowercase(),
                    op: None,
                    ci: false,
                });
            }
            Some('=') => {
                self.i += 1;
                AttrOp::Eq
            }
            Some(c) if "~|^$*".contains(c) && self.s.get(self.i + 1) == Some(&'=') => {
                self.i += 2;
                match c {
                    '~' => AttrOp::Includes,
                    '|' => AttrOp::Dash,
                    '^' => AttrOp::Prefix,
                    '$' => AttrOp::Suffix,
                    _ => AttrOp::Substring,
                }
            }
            _ => return Err("bad attribute selector".into()),
        };
        self.ws();
        let value = match self.peek() {
            Some(q @ ('"' | '\'')) => {
                self.i += 1;
                let mut v = String::new();
                loop {
                    match self.peek() {
                        None => return Err("unclosed string".into()),
                        Some('\\') => {
                            self.i += 1;
                            if let Some(n) = self.peek() {
                                v.push(n);
                                self.i += 1;
                            }
                        }
                        Some(c) if c == q => {
                            self.i += 1;
                            break;
                        }
                        Some(c) => {
                            v.push(c);
                            self.i += 1;
                        }
                    }
                }
                v
            }
            _ => self.ident()?,
        };
        self.ws();
        let mut ci = false;
        if matches!(self.peek(), Some('i') | Some('I')) {
            self.i += 1;
            ci = true;
            self.ws();
        } else if matches!(self.peek(), Some('s') | Some('S')) {
            self.i += 1;
            self.ws();
        }
        if self.peek() != Some(']') {
            return Err("expected ]".into());
        }
        self.i += 1;
        Ok(Simple::Attr {
            name: name.to_ascii_lowercase(),
            op: Some((op, value)),
            ci,
        })
    }

    fn arg_text(&mut self) -> Result<String, String> {
        // Called after '('; returns text up to the matching ')'.
        let start = self.i;
        let mut depth = 1;
        let mut quote: Option<char> = None;
        while let Some(c) = self.peek() {
            self.i += 1;
            match quote {
                Some(q) if c == q => quote = None,
                Some(_) => {}
                None => match c {
                    '"' | '\'' => quote = Some(c),
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            return Ok(self.s[start..self.i - 1].iter().collect());
                        }
                    }
                    _ => {}
                },
            }
        }
        Err("unclosed (".into())
    }

    fn pseudo(&mut self) -> Result<Pseudo, String> {
        let name = self.ident()?.to_ascii_lowercase();
        let has_args = self.peek() == Some('(');
        if has_args {
            self.i += 1;
        }
        let p = match (name.as_str(), has_args) {
            ("not", true) => {
                let list = self.list()?;
                self.close()?;
                Pseudo::Not(list)
            }
            ("is" | "where" | "matches" | "-webkit-any" | "-moz-any", true) => {
                let list = self.list()?;
                self.close()?;
                Pseudo::Is(list)
            }
            ("has", true) => {
                let mut rel = Vec::new();
                loop {
                    self.ws();
                    let comb = match self.peek() {
                        Some('>') => {
                            self.i += 1;
                            Some(Combinator::Child)
                        }
                        Some('+') => {
                            self.i += 1;
                            Some(Combinator::Adjacent)
                        }
                        Some('~') => {
                            self.i += 1;
                            Some(Combinator::Sibling)
                        }
                        _ => None,
                    };
                    self.ws();
                    rel.push((comb, self.complex()?));
                    self.ws();
                    if self.peek() == Some(',') {
                        self.i += 1;
                        continue;
                    }
                    break;
                }
                self.close()?;
                Pseudo::Has(rel)
            }
            ("nth-child" | "nth-last-child", true) => {
                let text = self.arg_text()?;
                let (formula, of) = match text.find(" of ") {
                    Some(idx) => (text[..idx].to_string(), Some(parse(&text[idx + 4..])?)),
                    None => (text, None),
                };
                let (a, b) = parse_nth(&formula)?;
                if name == "nth-child" {
                    Pseudo::NthChild(a, b, of)
                } else {
                    Pseudo::NthLastChild(a, b, of)
                }
            }
            ("nth-of-type" | "nth-last-of-type", true) => {
                let text = self.arg_text()?;
                let (a, b) = parse_nth(&text)?;
                if name == "nth-of-type" {
                    Pseudo::NthOfType(a, b)
                } else {
                    Pseudo::NthLastOfType(a, b)
                }
            }
            ("first-child", false) => Pseudo::NthChild(0, 1, None),
            ("last-child", false) => Pseudo::NthLastChild(0, 1, None),
            ("only-child", false) => Pseudo::OnlyChild,
            ("first-of-type", false) => Pseudo::NthOfType(0, 1),
            ("last-of-type", false) => Pseudo::NthLastOfType(0, 1),
            ("only-of-type", false) => Pseudo::OnlyOfType,
            ("empty", false) => Pseudo::Empty,
            ("root", false) => Pseudo::Root,
            ("checked", false) => Pseudo::Checked,
            ("disabled", false) => Pseudo::Disabled,
            ("enabled", false) => Pseudo::Enabled,
            ("link" | "any-link", false) => Pseudo::Link,
            ("hover" | "focus" | "active" | "visited" | "focus-within" | "focus-visible"
            | "target", false) => Pseudo::Never,
            _ => return Err(format!("unsupported pseudo-class :{name}")),
        };
        Ok(p)
    }

    fn close(&mut self) -> Result<(), String> {
        self.ws();
        if self.peek() == Some(')') {
            self.i += 1;
            Ok(())
        } else {
            Err("expected )".into())
        }
    }
}

fn parse_nth(text: &str) -> Result<(i64, i64), String> {
    let t: String = text.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase();
    match t.as_str() {
        "odd" => return Ok((2, 1)),
        "even" => return Ok((2, 0)),
        _ => {}
    }
    if let Some(npos) = t.find('n') {
        let a_str = &t[..npos];
        let a = match a_str {
            "" | "+" => 1,
            "-" => -1,
            s => s.parse::<i64>().map_err(|_| "bad nth")?,
        };
        let rest = &t[npos + 1..];
        let b = if rest.is_empty() {
            0
        } else {
            rest.parse::<i64>().map_err(|_| "bad nth")?
        };
        Ok((a, b))
    } else {
        Ok((0, t.parse::<i64>().map_err(|_| "bad nth")?))
    }
}

fn nth_matches(a: i64, b: i64, pos: i64) -> bool {
    if a == 0 {
        return pos == b;
    }
    let diff = pos - b;
    diff % a == 0 && diff / a >= 0
}

// ---- matching --------------------------------------------------------------

pub fn matches(doc: &Document, id: NodeId, list: &SelectorList) -> bool {
    doc.is_element(id) && list.0.iter().any(|c| matches_complex(doc, id, &c.parts, 0))
}

fn matches_complex(doc: &Document, id: NodeId, parts: &[(Compound, Option<Combinator>)], idx: usize) -> bool {
    let (comp, comb) = &parts[idx];
    if !matches_compound(doc, id, comp) {
        return false;
    }
    let Some(comb) = comb else {
        return true;
    };
    match comb {
        Combinator::Child => doc
            .parent_element(id)
            .is_some_and(|p| matches_complex(doc, p, parts, idx + 1)),
        Combinator::Descendant => {
            let mut cur = doc.parent_element(id);
            while let Some(p) = cur {
                if matches_complex(doc, p, parts, idx + 1) {
                    return true;
                }
                cur = doc.parent_element(p);
            }
            false
        }
        Combinator::Adjacent => doc
            .prev_element_sibling(id)
            .is_some_and(|s| matches_complex(doc, s, parts, idx + 1)),
        Combinator::Sibling => {
            let mut cur = doc.prev_element_sibling(id);
            while let Some(s) = cur {
                if matches_complex(doc, s, parts, idx + 1) {
                    return true;
                }
                cur = doc.prev_element_sibling(s);
            }
            false
        }
    }
}

fn matches_compound(doc: &Document, id: NodeId, comp: &Compound) -> bool {
    if let Some(tag) = &comp.tag {
        match doc.tag(id) {
            Some(t) if t.eq_ignore_ascii_case(tag) => {}
            _ => return false,
        }
    }
    comp.simple.iter().all(|s| matches_simple(doc, id, s))
}

fn matches_simple(doc: &Document, id: NodeId, s: &Simple) -> bool {
    match s {
        Simple::Id(v) => doc.attr(id, "id") == Some(v.as_str()),
        Simple::Class(c) => doc.has_class(id, c),
        Simple::Attr { name, op, ci } => {
            let Some(actual) = doc.attr(id, name) else {
                return false;
            };
            let Some((op, expected)) = op else {
                return true;
            };
            let (a, e) = if *ci {
                (actual.to_lowercase(), expected.to_lowercase())
            } else {
                (actual.to_string(), expected.clone())
            };
            match op {
                AttrOp::Eq => a == e,
                AttrOp::Includes => !e.is_empty() && a.split_ascii_whitespace().any(|w| w == e),
                AttrOp::Dash => a == e || a.starts_with(&format!("{e}-")),
                AttrOp::Prefix => !e.is_empty() && a.starts_with(&e),
                AttrOp::Suffix => !e.is_empty() && a.ends_with(&e),
                AttrOp::Substring => !e.is_empty() && a.contains(&e),
            }
        }
        Simple::Pseudo(p) => matches_pseudo(doc, id, p),
    }
}

fn siblings(doc: &Document, id: NodeId) -> Vec<NodeId> {
    match doc.parent(id) {
        Some(p) => doc.element_children(p),
        None => vec![id],
    }
}

fn matches_pseudo(doc: &Document, id: NodeId, p: &Pseudo) -> bool {
    match p {
        Pseudo::Not(list) => !matches(doc, id, list),
        Pseudo::Is(list) => matches(doc, id, list),
        Pseudo::Has(rel) => rel.iter().any(|(comb, complex)| {
            let candidates: Vec<NodeId> = match comb {
                None => doc.descendant_elements(id),
                Some(Combinator::Child) | Some(Combinator::Descendant) => {
                    if matches!(comb, Some(Combinator::Child)) {
                        doc.element_children(id)
                    } else {
                        doc.descendant_elements(id)
                    }
                }
                Some(Combinator::Adjacent) => doc.next_element_sibling(id).into_iter().collect(),
                Some(Combinator::Sibling) => {
                    let mut v = Vec::new();
                    let mut cur = doc.next_element_sibling(id);
                    while let Some(c) = cur {
                        v.push(c);
                        cur = doc.next_element_sibling(c);
                    }
                    v
                }
            };
            let scoped: Vec<NodeId> = match comb {
                Some(Combinator::Adjacent) | Some(Combinator::Sibling) => candidates,
                _ => candidates,
            };
            scoped.into_iter().any(|c| {
                if !matches_complex(doc, c, &complex.parts, 0) {
                    return false;
                }
                // The leftmost compound must stay inside the :has() anchor.
                true
            })
        }),
        Pseudo::NthChild(a, b, of) => {
            let sibs: Vec<NodeId> = siblings(doc, id)
                .into_iter()
                .filter(|s| of.as_ref().is_none_or(|l| matches(doc, *s, l)))
                .collect();
            match sibs.iter().position(|s| *s == id) {
                Some(pos) => nth_matches(*a, *b, pos as i64 + 1),
                None => false,
            }
        }
        Pseudo::NthLastChild(a, b, of) => {
            let sibs: Vec<NodeId> = siblings(doc, id)
                .into_iter()
                .filter(|s| of.as_ref().is_none_or(|l| matches(doc, *s, l)))
                .collect();
            match sibs.iter().position(|s| *s == id) {
                Some(pos) => nth_matches(*a, *b, (sibs.len() - pos) as i64),
                None => false,
            }
        }
        Pseudo::NthOfType(a, b) | Pseudo::NthLastOfType(a, b) => {
            let tag = doc.tag(id);
            let sibs: Vec<NodeId> = siblings(doc, id)
                .into_iter()
                .filter(|s| doc.tag(*s) == tag)
                .collect();
            let pos = sibs.iter().position(|s| *s == id).unwrap_or(0);
            let n = if matches!(p, Pseudo::NthOfType(..)) {
                pos as i64 + 1
            } else {
                (sibs.len() - pos) as i64
            };
            nth_matches(*a, *b, n)
        }
        Pseudo::OnlyChild => siblings(doc, id).len() == 1,
        Pseudo::OnlyOfType => {
            let tag = doc.tag(id);
            siblings(doc, id).into_iter().filter(|s| doc.tag(*s) == tag).count() == 1
        }
        Pseudo::Empty => doc.children(id).iter().all(|c| {
            !doc.is_element(*c) && doc.text(*c).is_none_or(|t| t.is_empty())
        }),
        Pseudo::Root => doc.parent(id) == Some(0) && doc.tag(id) == Some("html"),
        Pseudo::Checked => doc.has_attr(id, "checked") || doc.has_attr(id, "selected"),
        Pseudo::Disabled => doc.has_attr(id, "disabled"),
        Pseudo::Enabled => {
            matches!(doc.tag(id), Some("input" | "button" | "select" | "textarea"))
                && !doc.has_attr(id, "disabled")
        }
        Pseudo::Link => {
            matches!(doc.tag(id), Some("a" | "area")) && doc.has_attr(id, "href")
        }
        Pseudo::Never => false,
    }
}

/// `root.querySelectorAll(selector)` in document order (root excluded).
pub fn select_all(doc: &Document, root: NodeId, selector: &str) -> Result<Vec<NodeId>, String> {
    let list = parse(selector)?;
    Ok(select_all_parsed(doc, root, &list))
}

pub fn select_all_parsed(doc: &Document, root: NodeId, list: &SelectorList) -> Vec<NodeId> {
    doc.descendants(root)
        .into_iter()
        .filter(|n| matches(doc, *n, list))
        .collect()
}

pub fn select_first(doc: &Document, root: NodeId, selector: &str) -> Option<NodeId> {
    let list = parse(selector).ok()?;
    doc.descendants(root)
        .into_iter()
        .find(|n| matches(doc, *n, &list))
}

impl Document {
    pub fn select(&self, root: NodeId, selector: &str) -> Vec<NodeId> {
        select_all(self, root, selector).unwrap_or_default()
    }
    pub fn select_first(&self, root: NodeId, selector: &str) -> Option<NodeId> {
        select_first(self, root, selector)
    }
    pub fn matches_selector(&self, id: NodeId, selector: &str) -> bool {
        parse(selector).is_ok_and(|l| matches(self, id, &l))
    }
    pub fn closest(&self, id: NodeId, selector: &str) -> Option<NodeId> {
        let list = parse(selector).ok()?;
        let mut cur = Some(id);
        while let Some(c) = cur {
            if matches(self, c, &list) {
                return Some(c);
            }
            cur = self.parent(c);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HTML: &str = r#"<html><body>
      <div id="main" class="content post">
        <h1 class="title">Title</h1>
        <p class="lead">Lead <a href="/x" data-kind="Internal-Link">x</a></p>
        <p>Second</p>
        <ul><li>a</li><li class="sel">b</li><li>c</li><li>d</li></ul>
        <img class="hero" src="h.png">
      </div>
      <aside class="sidebar"><p>Side</p></aside>
    </body></html>"#;

    fn texts(doc: &Document, ids: &[NodeId]) -> Vec<String> {
        ids.iter().map(|i| doc.text_content(*i).trim().to_string()).collect()
    }

    #[test]
    fn descendant_child_and_class_selectors() {
        let d = Document::parse(HTML);
        assert_eq!(texts(&d, &d.select(0, "#main p")), vec!["Lead x", "Second"]);
        assert_eq!(texts(&d, &d.select(0, "div.content > h1.title")), vec!["Title"]);
        assert_eq!(d.select(0, "body > p").len(), 0);
        assert_eq!(texts(&d, &d.select(0, "aside p, h1")), vec!["Title", "Side"]);
    }

    #[test]
    fn attribute_operators_and_case_flag() {
        let d = Document::parse(HTML);
        assert_eq!(d.select(0, "a[href^='/']").len(), 1);
        assert_eq!(d.select(0, r#"a[data-kind="internal-link" i]"#).len(), 1);
        assert_eq!(d.select(0, r#"a[data-kind="internal-link"]"#).len(), 0);
        assert_eq!(d.select(0, "[class*=side]").len(), 1);
        assert_eq!(d.select(0, "[class~=post]").len(), 1);
        assert_eq!(d.select(0, "img[src$='.png']").len(), 1);
    }

    #[test]
    fn structural_pseudo_classes() {
        let d = Document::parse(HTML);
        assert_eq!(texts(&d, &d.select(0, "li:first-child")), vec!["a"]);
        assert_eq!(texts(&d, &d.select(0, "li:nth-child(2n)")), vec!["b", "d"]);
        assert_eq!(texts(&d, &d.select(0, "li:nth-last-child(1)")), vec!["d"]);
        assert_eq!(texts(&d, &d.select(0, "li:not(.sel):nth-child(odd)")), vec!["a", "c"]);
        assert_eq!(texts(&d, &d.select(0, ".sel + li")), vec!["c"]);
        assert_eq!(texts(&d, &d.select(0, ".sel ~ li")), vec!["c", "d"]);
        assert_eq!(texts(&d, &d.select(0, "p:first-of-type")), vec!["Lead x", "Side"]);
    }

    #[test]
    fn has_and_is() {
        let d = Document::parse(HTML);
        assert_eq!(texts(&d, &d.select(0, "p:has(a)")), vec!["Lead x"]);
        assert_eq!(d.select(0, "div:has(> h1)").len(), 1);
        assert_eq!(d.select(0, ":is(aside, h1)").len(), 2);
    }

    #[test]
    fn escaped_identifiers_and_errors() {
        let d = Document::parse(r#"<div class="md:flex w-1/2">x</div>"#);
        assert_eq!(d.select(0, r".md\:flex").len(), 1);
        assert_eq!(d.select(0, r".w-1\/2").len(), 1);
        assert!(parse("div:unknown-thing").is_err());
        assert!(parse("div[").is_err());
        assert!(parse("a >").is_err());
    }
}
