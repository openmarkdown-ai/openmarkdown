//! YAML for frontmatter, with the semantics of the `yaml` package (v2) that
//! Obsidian's `parseYaml` and `stringifyYaml` wrap.
//!
//! What matters for notes: YAML 1.2 core schema (so `2024-01-01` and `yes`
//! stay strings, `0o17` is 15, `010` is 10), duplicate keys are an error, a
//! `key: value: more` line is an error, and any error drops the whole
//! frontmatter — Obsidian shows no properties rather than half of them.
//! Objects come out with JavaScript key order: integer-like keys first.
//!
//! Stringifying follows `stringify(obj, { nullStr: "", lineWidth: 0 })`:
//! block style, sequences indented under their key, strings quoted only when
//! they would not read back as the same string, multi-line strings as `|`
//! blocks.

use std::collections::HashMap;

use serde_json::{Map, Number, Value};

use crate::util::{is_js_ws, js_trim_end};

#[derive(Debug, Clone, PartialEq)]
pub struct YamlError {
    pub code: &'static str,
    pub message: String,
    /// 1-based, as the `yaml` package reports them.
    pub line: usize,
    pub col: usize,
}

impl std::fmt::Display for YamlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {} at line {}, column {}", self.code, self.message, self.line, self.col)
    }
}

/// `parseYaml`: the document as JSON. Errors carry the `yaml` package's code.
pub fn parse(src: &str) -> Result<Value, YamlError> {
    let normalized;
    let s = if src.contains('\r') {
        normalized = src.replace("\r\n", "\n").replace('\r', "\n");
        &normalized
    } else {
        src
    };
    let mut p = P { s, pos: 0, anchors: HashMap::new() };
    p.document()
}

#[derive(Clone, Copy, PartialEq)]
enum Ctx {
    /// At the start of a line.
    Block,
    /// After `key: ` on the same line: no block collections may start here.
    MapValue,
    /// After `- ` on the same line: a compact mapping or sequence may.
    SeqEntry,
}

/// A parsed node before conversion: scalars keep whether they were plain so
/// keys can be compared and stringified the way the `yaml` package does.
#[derive(Clone, Debug)]
enum Node {
    Plain(String),
    Quoted(String),
    Seq(Vec<Node>),
    Map(Vec<(Node, Node)>),
    Null,
    /// A scalar forced to a string by `!!str` or an unknown tag.
    Str(String),
    Resolved(Value),
}

struct P<'a> {
    s: &'a str,
    pos: usize,
    anchors: HashMap<String, Node>,
}

type R<T> = Result<T, YamlError>;

fn resolve_plain(s: &str) -> Value {
    match s {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    let b = s.as_bytes();
    let digits = |x: &[u8]| !x.is_empty() && x.iter().all(|c| c.is_ascii_digit());
    if let Some(rest) = s.strip_prefix("0o") {
        if !rest.is_empty() && rest.bytes().all(|c| (b'0'..=b'7').contains(&c)) {
            return number(parse_radix(rest, 8));
        }
    }
    {
        let body = if matches!(b.first(), Some(b'-') | Some(b'+')) { &b[1..] } else { b };
        if digits(body) {
            let v = parse_radix(std::str::from_utf8(body).unwrap(), 10);
            return number(if b[0] == b'-' { -v } else { v });
        }
    }
    if let Some(rest) = s.strip_prefix("0x") {
        if !rest.is_empty() && rest.bytes().all(|c| c.is_ascii_hexdigit()) {
            return number(parse_radix(rest, 16));
        }
    }
    let body = if matches!(b.first(), Some(b'-') | Some(b'+')) { &s[1..] } else { s };
    if matches!(body, ".inf" | ".Inf" | ".INF") || matches!(s, ".nan" | ".NaN" | ".NAN") {
        // Infinity and NaN have no JSON form.
        return Value::Null;
    }
    if is_float(body) {
        if let Ok(v) = s.parse::<f64>() {
            return number(v);
        }
        if let Ok(v) = format!("{}0", s).parse::<f64>() {
            return number(v);
        }
    }
    Value::String(s.to_string())
}

/// `[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?` minus plain integers.
fn is_float(body: &str) -> bool {
    let b = body.as_bytes();
    let mut i = 0;
    let int_digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    i += int_digits;
    let mut frac = false;
    let mut frac_digits = 0;
    if b.get(i) == Some(&b'.') {
        frac = true;
        i += 1;
        frac_digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        i += frac_digits;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    let mut exp = false;
    if matches!(b.get(i), Some(b'e') | Some(b'E')) {
        let mut j = i + 1;
        if matches!(b.get(j), Some(b'-') | Some(b'+')) {
            j += 1;
        }
        let n = b[j.min(b.len())..].iter().take_while(|c| c.is_ascii_digit()).count();
        if n == 0 {
            return false;
        }
        exp = true;
        i = j + n;
    }
    i == b.len() && (frac || exp)
}

fn parse_radix(digits: &str, radix: u32) -> f64 {
    let mut v = 0f64;
    for c in digits.chars() {
        v = v * radix as f64 + c.to_digit(radix).unwrap_or(0) as f64;
    }
    v
}

fn number(v: f64) -> Value {
    if !v.is_finite() {
        return Value::Null;
    }
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        return Value::Number(Number::from(v as i64));
    }
    Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
}

/// JavaScript `String(number)`.
pub(crate) fn js_number_string(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if v == 0.0 {
        return "0".into();
    }
    let abs = v.abs();
    if (1e-7..1e21).contains(&abs) {
        let s = format!("{}", v);
        return s;
    }
    // Exponent form: Rust gives `1e21`, JavaScript `1e+21`.
    let s = format!("{:e}", v);
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

impl Node {
    fn to_value(&self) -> Value {
        match self {
            Node::Plain(s) => resolve_plain(s),
            Node::Quoted(s) | Node::Str(s) => Value::String(s.clone()),
            Node::Null => Value::Null,
            Node::Resolved(v) => v.clone(),
            Node::Seq(items) => Value::Array(items.iter().map(Node::to_value).collect()),
            Node::Map(pairs) => {
                let mut entries: Vec<(String, Value)> = Vec::new();
                let mut index: HashMap<String, usize> = HashMap::new();
                for (k, v) in pairs {
                    let key = key_string(k);
                    let value = v.to_value();
                    match index.get(&key) {
                        Some(&i) => entries[i].1 = value,
                        None => {
                            index.insert(key.clone(), entries.len());
                            entries.push((key, value));
                        }
                    }
                }
                Value::Object(js_object_order(entries))
            }
        }
    }
}

/// JavaScript objects list integer-like keys first, ascending.
pub(crate) fn js_object_order(entries: Vec<(String, Value)>) -> Map<String, Value> {
    let is_index = |k: &str| {
        !k.is_empty()
            && k.bytes().all(|c| c.is_ascii_digit())
            && (k == "0" || !k.starts_with('0'))
            && k.len() <= 10
            && k.parse::<u64>().map(|n| n < 4_294_967_295).unwrap_or(false)
    };
    let mut ints: Vec<(u64, String, Value)> = Vec::new();
    let mut rest = Vec::new();
    for (k, v) in entries {
        if is_index(&k) {
            ints.push((k.parse().unwrap(), k, v));
        } else {
            rest.push((k, v));
        }
    }
    ints.sort_by_key(|x| x.0);
    let mut map = Map::new();
    for (_, k, v) in ints {
        map.insert(k, v);
    }
    for (k, v) in rest {
        map.insert(k, v);
    }
    map
}

fn key_string(k: &Node) -> String {
    match k.to_value() {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s,
        other => {
            let s = stringify(&other);
            s.trim_end().to_string()
        }
    }
}

/// Keys are duplicates when both are scalars with the same resolved value.
fn same_key(a: &Node, b: &Node) -> bool {
    let scalar = |n: &Node| matches!(n, Node::Plain(_) | Node::Quoted(_) | Node::Str(_) | Node::Null | Node::Resolved(_));
    if !scalar(a) || !scalar(b) {
        return false;
    }
    match (a.to_value(), b.to_value()) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(_), _) | (_, Value::Array(_)) | (Value::Object(_), _) | (_, Value::Object(_)) => false,
        (x, y) => x == y,
    }
}

impl<'a> P<'a> {
    fn err<T>(&self, code: &'static str, message: impl Into<String>) -> R<T> {
        Err(self.error_at(self.pos, code, message))
    }

    fn error_at(&self, pos: usize, code: &'static str, message: impl Into<String>) -> YamlError {
        let pos = pos.min(self.s.len());
        let before = &self.s[..pos];
        let line = before.matches('\n').count() + 1;
        let col = before.rsplit('\n').next().map(|l| l.chars().count()).unwrap_or(0) + 1;
        YamlError { code, message: message.into(), line, col }
    }

    fn b(&self, i: usize) -> u8 {
        *self.s.as_bytes().get(i).unwrap_or(&0)
    }

    fn peek(&self) -> u8 {
        self.b(self.pos)
    }

    fn eof(&self) -> bool {
        self.pos >= self.s.len()
    }

    fn col(&self) -> usize {
        let ls = self.s[..self.pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
        self.pos - ls
    }

    fn ws_or_end(&self, i: usize) -> bool {
        matches!(self.b(i), 0 | b' ' | b'\t' | b'\n')
    }

    fn skip_inline_ws(&mut self) {
        while matches!(self.peek(), b' ' | b'\t') {
            self.pos += 1;
        }
    }

    fn at_line_end(&self) -> bool {
        self.eof() || self.peek() == b'\n'
    }

    /// Consume trailing whitespace, an optional comment and the newline.
    fn finish_line(&mut self) -> R<()> {
        let had_ws = matches!(self.b(self.pos.wrapping_sub(1)), b' ' | b'\t') || self.col() == 0;
        self.skip_inline_ws();
        let ws = had_ws || matches!(self.b(self.pos.wrapping_sub(1)), b' ' | b'\t');
        if self.peek() == b'#' && ws {
            while !self.at_line_end() {
                self.pos += 1;
            }
        }
        if self.eof() {
            return Ok(());
        }
        if self.peek() != b'\n' {
            return self.err("UNEXPECTED_TOKEN", "Unexpected scalar at node end");
        }
        self.pos += 1;
        Ok(())
    }

    /// From a line start, skip blank and comment-only lines; return the
    /// indentation of the next content line without moving past its start.
    fn next_content_line(&mut self) -> R<Option<usize>> {
        loop {
            if self.eof() {
                return Ok(None);
            }
            let start = self.pos;
            let mut i = start;
            while self.b(i) == b' ' {
                i += 1;
            }
            let indent = i - start;
            let mut j = i;
            while matches!(self.b(j), b' ' | b'\t') {
                j += 1;
            }
            match self.b(j) {
                0 => {
                    self.pos = self.s.len();
                    return Ok(None);
                }
                b'\n' => {
                    self.pos = j + 1;
                    continue;
                }
                b'#' => {
                    while !matches!(self.b(j), 0 | b'\n') {
                        j += 1;
                    }
                    self.pos = (j + 1).min(self.s.len());
                    continue;
                }
                _ => {
                    if j > i && self.b(i) == b'\t' {
                        return Err(self.error_at(start, "TAB_AS_INDENT", "Tabs are not allowed as indentation"));
                    }
                    self.pos = start;
                    return Ok(Some(indent));
                }
            }
        }
    }

    fn doc_marker_at(&self, i: usize) -> Option<&'static str> {
        let r = &self.s[i..];
        for m in ["---", "..."] {
            if r.starts_with(m) && self.ws_or_end(i + 3) {
                return Some(m);
            }
        }
        None
    }

    fn document(&mut self) -> R<Value> {
        let mut explicit = false;
        loop {
            match self.next_content_line()? {
                None => return Ok(Value::Null),
                Some(0) if self.peek() == b'%' => {
                    while !self.at_line_end() {
                        self.pos += 1;
                    }
                    explicit = true;
                }
                _ => break,
            }
        }
        let _ = explicit;
        if self.col() == 0 && self.doc_marker_at(self.pos) == Some("---") {
            self.pos += 3;
            self.skip_inline_ws();
            if self.at_line_end() || self.peek() == b'#' {
                self.finish_line()?;
            }
        }
        let root = if self.col() > 0 && !self.at_line_end() {
            let col = self.col();
            self.node(col, Ctx::Block, -1)?
        } else {
            self.block_value(0, None, -1)?
        };
        // Only comments, blank lines and a document end marker may follow.
        loop {
            match self.next_content_line()? {
                None => break,
                Some(0) => match self.doc_marker_at(self.pos) {
                    Some("...") => {
                        self.pos += 3;
                        self.finish_line()?;
                    }
                    Some(_) => {
                        return self.err(
                            "MULTIPLE_DOCS",
                            "Source contains multiple documents; please use YAML.parseAllDocuments()",
                        )
                    }
                    None => {
                        return self.err("UNEXPECTED_TOKEN", "Unexpected content after the document");
                    }
                },
                Some(n) => {
                    self.pos += n;
                    return self.err("BAD_INDENT", "Unexpected content after the document");
                }
            }
        }
        Ok(root.to_value())
    }

    /// A node that starts on a following line: indented at least `min`, or a
    /// block sequence at exactly `seq_at` (`key:\n- item`).
    fn block_value(&mut self, min: usize, seq_at: Option<usize>, parent: isize) -> R<Node> {
        let Some(indent) = self.next_content_line()? else { return Ok(Node::Null) };
        if indent == 0 && self.doc_marker_at(self.pos).is_some() {
            return Ok(Node::Null);
        }
        let line = self.pos;
        let is_seq = self.b(line + indent) == b'-' && self.ws_or_end(line + indent + 1);
        if indent < min || (indent as isize) <= parent {
            if seq_at == Some(indent) && is_seq {
                self.pos = line + indent;
                return self.seq(indent);
            }
            return Ok(Node::Null);
        }
        self.pos = line + indent;
        self.node(indent, Ctx::Block, parent)
    }

    fn node(&mut self, col: usize, ctx: Ctx, parent: isize) -> R<Node> {
        let (anchor, tag) = self.properties()?;
        if (anchor.is_some() || tag.is_some()) && (self.at_line_end() || self.peek() == b'#') {
            self.finish_line()?;
            let seq_at = if ctx == Ctx::MapValue && parent >= 0 { Some(parent as usize) } else { None };
            let n = self.block_value((parent + 1).max(0) as usize, seq_at, parent)?;
            return Ok(self.finish_node(n, anchor, tag));
        }
        let col = if anchor.is_some() || tag.is_some() { self.col() } else { col };
        let c = self.peek();
        let n = match c {
            b'-' if self.ws_or_end(self.pos + 1) => {
                if ctx == Ctx::MapValue {
                    return self.err("UNEXPECTED_TOKEN", "Unexpected block-seq-ind on same line with key");
                }
                self.seq(col)?
            }
            b'?' if self.ws_or_end(self.pos + 1) => {
                if ctx == Ctx::MapValue {
                    return self.err("BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
                }
                self.map(col)?
            }
            b'|' | b'>' => self.block_scalar(parent)?,
            b'@' | b'`' => {
                return self.err(
                    "BAD_SCALAR_START",
                    format!("Plain value cannot start with reserved character {}", c as char),
                )
            }
            b'[' | b'{' | b'"' | b'\'' | b'*' => {
                let start = self.pos;
                let value = self.inline_scalar_or_flow()?;
                self.skip_inline_ws();
                if self.peek() == b':' && self.ws_or_end(self.pos + 1) {
                    if ctx == Ctx::MapValue {
                        return Err(self.error_at(
                            start,
                            "BLOCK_AS_IMPLICIT_KEY",
                            "Nested mappings are not allowed in compact mappings",
                        ));
                    }
                    self.pos = start;
                    self.map(col)?
                } else {
                    self.finish_line()?;
                    value
                }
            }
            _ => {
                if self.plain_line_is_key() {
                    if ctx == Ctx::MapValue {
                        return self.err("BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
                    }
                    self.map(col)?
                } else {
                    self.plain_block(parent)?
                }
            }
        };
        Ok(self.finish_node(n, anchor, tag))
    }

    fn finish_node(&mut self, n: Node, anchor: Option<String>, tag: Option<String>) -> Node {
        let n = match tag.as_deref() {
            None => n,
            Some(t) => apply_tag(t, n),
        };
        if let Some(a) = anchor {
            self.anchors.insert(a, n.clone());
        }
        n
    }

    fn properties(&mut self) -> R<(Option<String>, Option<String>)> {
        let mut anchor = None;
        let mut tag = None;
        loop {
            match self.peek() {
                b'&' if anchor.is_none() => {
                    let start = self.pos + 1;
                    self.pos = start;
                    while !matches!(self.peek(), 0 | b' ' | b'\t' | b'\n' | b',' | b'[' | b']' | b'{' | b'}') {
                        self.pos += 1;
                    }
                    anchor = Some(self.s[start..self.pos].to_string());
                    self.skip_inline_ws();
                }
                b'!' if tag.is_none() => {
                    let start = self.pos;
                    while !matches!(self.peek(), 0 | b' ' | b'\t' | b'\n') {
                        self.pos += 1;
                    }
                    tag = Some(self.s[start..self.pos].to_string());
                    self.skip_inline_ws();
                }
                _ => return Ok((anchor, tag)),
            }
        }
    }

    fn alias(&mut self) -> R<Node> {
        let start = self.pos + 1;
        self.pos = start;
        while !matches!(self.peek(), 0 | b' ' | b'\t' | b'\n' | b',' | b'[' | b']' | b'{' | b'}') {
            self.pos += 1;
        }
        let name = &self.s[start..self.pos];
        match self.anchors.get(name) {
            Some(n) => Ok(n.clone()),
            None => Err(self.error_at(
                start - 1,
                "BAD_ALIAS",
                format!("Unresolved alias (the anchor must be set before the alias): {name}"),
            )),
        }
    }

    /// A quoted scalar, alias or flow collection, on its own.
    fn inline_scalar_or_flow(&mut self) -> R<Node> {
        match self.peek() {
            b'[' | b'{' => self.flow(),
            b'"' => self.double_quoted().map(Node::Quoted),
            b'\'' => self.single_quoted().map(Node::Quoted),
            b'*' => self.alias(),
            _ => unreachable!(),
        }
    }

    /// Does the plain scalar starting here contain a `: ` before its end?
    fn plain_line_is_key(&self) -> bool {
        let mut i = self.pos;
        let mut prev_ws = false;
        loop {
            match self.b(i) {
                0 | b'\n' => return false,
                b'#' if prev_ws => return false,
                b':' if self.ws_or_end(i + 1) => return true,
                c => {
                    prev_ws = c == b' ' || c == b'\t';
                    i += 1;
                }
            }
        }
    }

    fn map(&mut self, col: usize) -> R<Node> {
        let mut pairs: Vec<(Node, Node)> = Vec::new();
        loop {
            let key_pos = self.pos;
            let key;
            let value;
            if self.peek() == b'?' && self.ws_or_end(self.pos + 1) {
                self.pos += 1;
                self.skip_inline_ws();
                key = if self.at_line_end() || self.peek() == b'#' {
                    self.finish_line()?;
                    self.block_value(col + 1, None, col as isize)?
                } else {
                    let c = self.col();
                    self.node(c, Ctx::SeqEntry, col as isize)?
                };
                match self.next_content_line()? {
                    Some(ind) if ind == col && self.b(self.pos + ind) == b':' && self.ws_or_end(self.pos + ind + 1) => {
                        self.pos += ind + 1;
                        value = self.map_value(col)?;
                    }
                    _ => value = Node::Null,
                }
            } else {
                let (anchor, tag) = self.properties()?;
                let k = match self.peek() {
                    b'"' | b'\'' | b'[' | b'{' | b'*' => self.inline_scalar_or_flow()?,
                    b'@' | b'`' => {
                        return self.err(
                            "BAD_SCALAR_START",
                            format!("Plain value cannot start with reserved character {}", self.peek() as char),
                        )
                    }
                    _ => {
                        let start = self.pos;
                        let mut i = self.pos;
                        while !(self.b(i) == b':' && self.ws_or_end(i + 1)) && !matches!(self.b(i), 0 | b'\n') {
                            i += 1;
                        }
                        self.pos = i;
                        Node::Plain(js_trim_end(&self.s[start..i]).to_string())
                    }
                };
                key = self.finish_node(k, anchor, tag);
                self.skip_inline_ws();
                if !(self.peek() == b':' && self.ws_or_end(self.pos + 1)) {
                    return self.err("MISSING_CHAR", "Implicit map keys need to be followed by map values");
                }
                self.pos += 1;
                value = self.map_value(col)?;
            }
            if pairs.iter().any(|(k, _)| same_key(k, &key)) {
                return Err(self.error_at(key_pos, "DUPLICATE_KEY", "Map keys must be unique"));
            }
            pairs.push((key, value));
            match self.next_content_line()? {
                None => break,
                Some(ind) => {
                    if ind == 0 && self.doc_marker_at(self.pos).is_some() {
                        break;
                    }
                    if ind < col {
                        break;
                    }
                    if ind > col {
                        self.pos += ind;
                        return self.err("BAD_INDENT", "All mapping items must start at the same column");
                    }
                    self.pos += ind;
                    if self.peek() == b'-' && self.ws_or_end(self.pos + 1) {
                        return self.err("BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
                    }
                }
            }
        }
        Ok(Node::Map(pairs))
    }

    fn map_value(&mut self, col: usize) -> R<Node> {
        self.skip_inline_ws();
        if self.at_line_end() || self.peek() == b'#' {
            self.finish_line()?;
            return self.block_value(col + 1, Some(col), col as isize);
        }
        let c = self.col();
        self.node(c, Ctx::MapValue, col as isize)
    }

    fn seq(&mut self, col: usize) -> R<Node> {
        let mut items = Vec::new();
        loop {
            self.pos += 1;
            self.skip_inline_ws();
            let item = if self.at_line_end() || self.peek() == b'#' {
                self.finish_line()?;
                self.block_value(col + 1, None, col as isize)?
            } else {
                let c = self.col();
                self.node(c, Ctx::SeqEntry, col as isize)?
            };
            items.push(item);
            match self.next_content_line()? {
                None => break,
                Some(ind) => {
                    if ind == 0 && self.doc_marker_at(self.pos).is_some() {
                        break;
                    }
                    let is_seq = self.b(self.pos + ind) == b'-' && self.ws_or_end(self.pos + ind + 1);
                    if ind == col && is_seq {
                        self.pos += ind;
                        continue;
                    }
                    if ind <= col {
                        break;
                    }
                    self.pos += ind;
                    return self.err("BAD_INDENT", "All sequence items must start at the same column");
                }
            }
        }
        Ok(Node::Seq(items))
    }

    /// A plain scalar in block context, folding its continuation lines.
    fn plain_block(&mut self, parent: isize) -> R<Node> {
        let mut text = String::new();
        let first = self.plain_line()?;
        text.push_str(&first.0);
        if first.1 {
            return Ok(Node::Plain(text));
        }
        loop {
            // Look ahead: blank lines, then a more-indented content line.
            let save = self.pos;
            let mut blanks = 0;
            let mut found = None;
            let mut i = self.pos;
            loop {
                if i >= self.s.len() {
                    break;
                }
                let ls = i;
                let mut j = i;
                while matches!(self.b(j), b' ' | b'\t') {
                    j += 1;
                }
                if matches!(self.b(j), b'\n') {
                    blanks += 1;
                    i = j + 1;
                    continue;
                }
                if self.b(j) == 0 {
                    break;
                }
                let indent = self.s[ls..j].bytes().take_while(|&c| c == b' ').count();
                found = Some((ls, j, indent));
                break;
            }
            let Some((ls, j, indent)) = found else {
                self.pos = save;
                break;
            };
            if (indent as isize) <= parent || self.b(j) == b'#' || (indent == 0 && self.doc_marker_at(ls).is_some()) {
                self.pos = save;
                break;
            }
            self.pos = j;
            if self.plain_line_is_key() {
                return self.err("BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            }
            let (line, ended_by_comment) = self.plain_line()?;
            if blanks == 0 {
                text.push(' ');
            } else {
                for _ in 0..blanks {
                    text.push('\n');
                }
            }
            text.push_str(&line);
            if ended_by_comment {
                break;
            }
        }
        Ok(Node::Plain(text))
    }

    /// One line of a plain scalar; consumes the line. Returns the text and
    /// whether a comment ended it.
    fn plain_line(&mut self) -> R<(String, bool)> {
        let start = self.pos;
        let mut i = self.pos;
        let mut prev_ws = false;
        let mut comment = false;
        loop {
            match self.b(i) {
                0 | b'\n' => break,
                b'#' if prev_ws => {
                    comment = true;
                    break;
                }
                c => {
                    prev_ws = c == b' ' || c == b'\t';
                    i += 1;
                }
            }
        }
        let text = js_trim_end(&self.s[start..i]).trim_end_matches([' ', '\t']).to_string();
        self.pos = i;
        while !self.at_line_end() {
            self.pos += 1;
        }
        if !self.eof() {
            self.pos += 1;
        }
        Ok((text, comment))
    }

    fn block_scalar(&mut self, parent: isize) -> R<Node> {
        let literal = self.peek() == b'|';
        self.pos += 1;
        let mut chomp = 0i8; // -1 strip, 0 clip, 1 keep
        let mut explicit: Option<usize> = None;
        for _ in 0..2 {
            match self.peek() {
                b'+' => {
                    chomp = 1;
                    self.pos += 1;
                }
                b'-' => {
                    chomp = -1;
                    self.pos += 1;
                }
                c @ b'1'..=b'9' => {
                    explicit = Some((c - b'0') as usize);
                    self.pos += 1;
                }
                _ => {}
            }
        }
        self.finish_line()?;
        let base = parent.max(-1);
        let mut lines: Vec<&str> = Vec::new();
        let mut indent: Option<usize> = explicit.map(|n| (base + n as isize).max(0) as usize);
        while !self.eof() {
            let ls = self.pos;
            let le = self.s[ls..].find('\n').map(|x| ls + x).unwrap_or(self.s.len());
            let line = &self.s[ls..le];
            let spaces = line.bytes().take_while(|&c| c == b' ').count();
            let blank = line.bytes().all(|c| c == b' ' || c == b'\t');
            if blank {
                lines.push(line);
            } else {
                let ind = match indent {
                    Some(i) => i,
                    None => {
                        if (spaces as isize) <= base {
                            break;
                        }
                        indent = Some(spaces);
                        spaces
                    }
                };
                if spaces < ind {
                    break;
                }
                lines.push(line);
            }
            self.pos = if le < self.s.len() { le + 1 } else { le };
        }
        let ind = indent.unwrap_or(0);
        let content: Vec<&str> = lines.iter().map(|l| if l.len() >= ind { &l[ind..] } else { "" }).collect();
        let last_non_empty = content.iter().rposition(|l| !l.trim_matches([' ', '\t']).is_empty() || l.len() > 0 && !l.bytes().all(|c| c == b' ' || c == b'\t'));
        let (body_lines, trailing) = match last_non_empty {
            Some(i) => (&content[..=i], content.len() - i - 1),
            None => (&content[..0], content.len()),
        };
        let mut body = String::new();
        if literal {
            body = body_lines.join("\n");
        } else {
            let mut prev_more = false;
            let mut pending = 0usize;
            let mut started = false;
            for l in body_lines {
                if l.is_empty() || l.bytes().all(|c| c == b' ' || c == b'\t') && !l.starts_with([' ', '\t']) {
                    pending += 1;
                    continue;
                }
                let more = l.starts_with([' ', '\t']);
                if !started {
                    body.push_str(&"\n".repeat(pending));
                    started = true;
                } else if pending == 0 {
                    body.push(if more || prev_more { '\n' } else { ' ' });
                } else {
                    body.push_str(&"\n".repeat(pending + usize::from(more || prev_more)));
                }
                pending = 0;
                body.push_str(l);
                prev_more = more;
            }
        }
        let has_content = last_non_empty.is_some();
        match chomp {
            -1 => {}
            0 => {
                if has_content {
                    body.push('\n');
                }
            }
            _ => {
                if has_content {
                    body.push('\n');
                }
                body.push_str(&"\n".repeat(trailing));
            }
        }
        Ok(Node::Quoted(body))
    }

    fn fold_newline(&mut self, out: &mut String) {
        // At a newline inside a quoted scalar: drop trailing spaces, count
        // empty lines, skip the next line's indentation.
        while out.ends_with([' ', '\t']) {
            out.pop();
        }
        let mut blanks = 0;
        self.pos += 1;
        loop {
            while matches!(self.peek(), b' ' | b'\t') {
                self.pos += 1;
            }
            if self.peek() == b'\n' {
                blanks += 1;
                self.pos += 1;
                continue;
            }
            break;
        }
        if blanks == 0 {
            out.push(' ');
        } else {
            out.push_str(&"\n".repeat(blanks));
        }
    }

    fn double_quoted(&mut self) -> R<String> {
        let open = self.pos;
        self.pos += 1;
        let mut out = String::new();
        loop {
            let Some(c) = self.s[self.pos..].chars().next() else {
                return Err(self.error_at(self.s.len(), "MISSING_CHAR", "Missing closing \"quote"));
            };
            let _ = open;
            match c {
                '"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                '\n' => self.fold_newline(&mut out),
                '\\' => {
                    self.pos += 1;
                    let Some(e) = self.s[self.pos..].chars().next() else { continue };
                    self.pos += e.len_utf8();
                    let hex = |p: &mut Self, n: usize| -> R<char> {
                        let h = p.s.get(p.pos..p.pos + n).unwrap_or("");
                        p.pos += n.min(p.s.len() - p.pos);
                        u32::from_str_radix(h, 16).ok().and_then(char::from_u32).ok_or_else(|| {
                            p.error_at(p.pos, "BAD_DQ_ESCAPE", format!("Invalid escape sequence \\{h}"))
                        })
                    };
                    match e {
                        '0' => out.push('\0'),
                        'a' => out.push('\u{7}'),
                        'b' => out.push('\u{8}'),
                        't' | '\t' => out.push('\t'),
                        'n' => out.push('\n'),
                        'v' => out.push('\u{B}'),
                        'f' => out.push('\u{C}'),
                        'r' => out.push('\r'),
                        'e' => out.push('\u{1B}'),
                        ' ' => out.push(' '),
                        '"' => out.push('"'),
                        '/' => out.push('/'),
                        '\\' => out.push('\\'),
                        'N' => out.push('\u{85}'),
                        '_' => out.push('\u{A0}'),
                        'L' => out.push('\u{2028}'),
                        'P' => out.push('\u{2029}'),
                        'x' => out.push(hex(self, 2)?),
                        'u' => out.push(hex(self, 4)?),
                        'U' => out.push(hex(self, 8)?),
                        '\n' => {
                            while matches!(self.peek(), b' ' | b'\t') {
                                self.pos += 1;
                            }
                        }
                        other => {
                            out.push('\\');
                            out.push(other);
                        }
                    }
                }
                _ => {
                    out.push(c);
                    self.pos += c.len_utf8();
                }
            }
        }
    }

    fn single_quoted(&mut self) -> R<String> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let Some(c) = self.s[self.pos..].chars().next() else {
                return Err(self.error_at(self.s.len(), "MISSING_CHAR", "Missing closing 'quote"));
            };
            match c {
                '\'' => {
                    if self.b(self.pos + 1) == b'\'' {
                        out.push('\'');
                        self.pos += 2;
                    } else {
                        self.pos += 1;
                        return Ok(out);
                    }
                }
                '\n' => self.fold_newline(&mut out),
                _ => {
                    out.push(c);
                    self.pos += c.len_utf8();
                }
            }
        }
    }

    fn skip_flow_ws(&mut self) {
        loop {
            match self.peek() {
                b' ' | b'\t' | b'\n' => self.pos += 1,
                b'#' if matches!(self.b(self.pos.wrapping_sub(1)), b' ' | b'\t' | b'\n') => {
                    while !self.at_line_end() {
                        self.pos += 1;
                    }
                }
                _ => return,
            }
        }
    }

    fn flow(&mut self) -> R<Node> {
        let open = self.peek();
        let close = if open == b'[' { b']' } else { b'}' };
        let start = self.pos;
        self.pos += 1;
        let mut items: Vec<Node> = Vec::new();
        let mut pairs: Vec<(Node, Node)> = Vec::new();
        loop {
            self.skip_flow_ws();
            if self.eof() {
                let what = if open == b'[' { "Flow sequence" } else { "Flow map" };
                return Err(self.error_at(
                    self.s.len(),
                    "BAD_INDENT",
                    format!("{what} in block collection must be sufficiently indented and end with a {}", close as char),
                ));
            }
            if self.peek() == close {
                self.pos += 1;
                break;
            }
            let key = if self.peek() == b':' && self.flow_sep(self.pos + 1) {
                Node::Null
            } else {
                self.flow_node()?
            };
            self.skip_flow_ws();
            let mut pair = None;
            if self.peek() == b':' {
                self.pos += 1;
                self.skip_flow_ws();
                let value = if matches!(self.peek(), b',' | b']' | b'}') { Node::Null } else { self.flow_node()? };
                pair = Some((key.clone(), value));
                self.skip_flow_ws();
            }
            if open == b'[' {
                match pair {
                    Some((k, v)) => items.push(Node::Map(vec![(k, v)])),
                    None => items.push(key),
                }
            } else {
                let (k, v) = pair.unwrap_or((key, Node::Null));
                if pairs.iter().any(|(x, _)| same_key(x, &k)) {
                    return self.err("DUPLICATE_KEY", "Map keys must be unique");
                }
                pairs.push((k, v));
            }
            match self.peek() {
                b',' => self.pos += 1,
                c if c == close => {
                    self.pos += 1;
                    break;
                }
                _ => {
                    if self.eof() {
                        continue;
                    }
                    let _ = start;
                    return self.err("UNEXPECTED_TOKEN", "Unexpected scalar in flow collection");
                }
            }
        }
        Ok(if open == b'[' { Node::Seq(items) } else { Node::Map(pairs) })
    }

    fn flow_sep(&self, i: usize) -> bool {
        matches!(self.b(i), 0 | b' ' | b'\t' | b'\n' | b',' | b'[' | b']' | b'{' | b'}')
    }

    fn flow_node(&mut self) -> R<Node> {
        let (anchor, tag) = self.properties()?;
        let n = match self.peek() {
            b'[' | b'{' => self.flow()?,
            b'"' => Node::Quoted(self.double_quoted()?),
            b'\'' => Node::Quoted(self.single_quoted()?),
            b'*' => self.alias()?,
            b'@' | b'`' => {
                return self.err(
                    "BAD_SCALAR_START",
                    format!("Plain value cannot start with reserved character {}", self.peek() as char),
                )
            }
            b',' | b']' | b'}' => Node::Null,
            _ => {
                let mut text = String::new();
                let mut pending_space = false;
                loop {
                    let c = self.peek();
                    match c {
                        0 | b',' | b'[' | b']' | b'{' | b'}' => break,
                        b':' if self.flow_sep(self.pos + 1) => break,
                        b'#' if matches!(self.b(self.pos.wrapping_sub(1)), b' ' | b'\t' | b'\n') => break,
                        b' ' | b'\t' | b'\n' => {
                            pending_space = true;
                            self.pos += 1;
                        }
                        _ => {
                            if pending_space && !text.is_empty() {
                                text.push(' ');
                            }
                            pending_space = false;
                            let ch = self.s[self.pos..].chars().next().unwrap();
                            text.push(ch);
                            self.pos += ch.len_utf8();
                        }
                    }
                }
                Node::Plain(text)
            }
        };
        Ok(self.finish_node(n, anchor, tag))
    }
}

fn apply_tag(tag: &str, n: Node) -> Node {
    let text = match &n {
        Node::Plain(s) | Node::Quoted(s) | Node::Str(s) => Some(s.clone()),
        Node::Null => Some(String::new()),
        _ => None,
    };
    let Some(text) = text else { return n };
    match tag {
        "!!str" | "!" => Node::Str(text),
        "!!null" => Node::Null,
        // An explicit tag only applies when the text has that tag's form
        // (`!!float 3` is not a float in the core schema); otherwise the
        // value stays a string.
        "!!bool" | "!!int" | "!!float" => {
            let body = text.strip_prefix(['-', '+']).unwrap_or(&text);
            let form = match tag {
                "!!bool" => matches!(resolve_plain(&text), Value::Bool(_)),
                "!!int" => {
                    (!body.is_empty() && body.bytes().all(|c| c.is_ascii_digit()))
                        || text.strip_prefix("0o").map(|r| !r.is_empty() && r.bytes().all(|c| (b'0'..=b'7').contains(&c))).unwrap_or(false)
                        || text.strip_prefix("0x").map(|r| !r.is_empty() && r.bytes().all(|c| c.is_ascii_hexdigit())).unwrap_or(false)
                }
                _ => is_float(body) || matches!(body, ".inf" | ".Inf" | ".INF") || matches!(text.as_str(), ".nan" | ".NaN" | ".NAN"),
            };
            match resolve_plain(&text) {
                v @ (Value::Bool(_) | Value::Number(_) | Value::Null) if form => Node::Resolved(v),
                _ => Node::Str(text),
            }
        }
        _ => match n {
            Node::Plain(s) => Node::Str(s),
            other => other,
        },
    }
}

// ---------------------------------------------------------------------------
// stringify

struct SCtx {
    indent: String,
    implicit_key: bool,
    force_block_indent: bool,
}

const INDENT_STEP: &str = "  ";

/// `stringifyYaml`.
pub fn stringify(v: &Value) -> String {
    let mut ctx = SCtx { indent: String::new(), implicit_key: false, force_block_indent: false };
    let mut out = stringify_node(v, &mut ctx);
    out.push('\n');
    out
}

fn stringify_node(v: &Value, ctx: &mut SCtx) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                js_number_string(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => stringify_string(s, ctx),
        Value::Array(items) => {
            if items.is_empty() {
                return "[]".into();
            }
            let item_indent = format!("{}{}", ctx.indent, INDENT_STEP);
            let mut lines = Vec::new();
            for item in items {
                let mut ictx = SCtx { indent: item_indent.clone(), implicit_key: false, force_block_indent: false };
                lines.push(format!("- {}", stringify_node(item, &mut ictx)));
            }
            join_block(&lines, &ctx.indent)
        }
        Value::Object(map) => {
            if map.is_empty() {
                return "{}".into();
            }
            let mut lines = Vec::new();
            for (k, val) in map {
                lines.push(stringify_pair(k, val, &ctx.indent));
            }
            join_block(&lines, &ctx.indent)
        }
    }
}

fn join_block(lines: &[String], indent: &str) -> String {
    let mut s = lines[0].clone();
    for l in &lines[1..] {
        if l.is_empty() {
            s.push('\n');
        } else {
            s.push('\n');
            s.push_str(indent);
            s.push_str(l);
        }
    }
    s
}

fn stringify_pair(key: &str, value: &Value, indent: &str) -> String {
    let pair_indent = format!("{indent}{INDENT_STEP}");
    let mut kctx = SCtx { indent: pair_indent.clone(), implicit_key: true, force_block_indent: false };
    let mut s = stringify_string(key, &mut kctx);
    s.push(':');
    let mut vctx = SCtx { indent: pair_indent.clone(), implicit_key: false, force_block_indent: false };
    let vs = stringify_node(value, &mut vctx);
    let ws = match value {
        Value::Array(a) if !a.is_empty() => format!("\n{pair_indent}"),
        Value::Object(o) if !o.is_empty() => format!("\n{pair_indent}"),
        Value::Array(_) | Value::Object(_) => " ".to_string(),
        _ if vs.is_empty() || vs.starts_with('\n') => String::new(),
        _ => " ".to_string(),
    };
    s.push_str(&ws);
    s.push_str(&vs);
    s
}

fn contains_document_marker(s: &str) -> bool {
    s.split('\n').any(|l| l.starts_with('%') || l.starts_with("---") || l.starts_with("..."))
}

/// Would this plain text read back as something other than a string?
fn resolves_as_non_string(s: &str) -> bool {
    !matches!(resolve_plain(s), Value::String(_))
        || matches!(s, ".inf" | ".Inf" | ".INF" | "-.inf" | "+.inf" | ".nan" | ".NaN" | ".NAN" | "-.Inf" | "+.Inf" | "-.INF" | "+.INF")
}

fn stringify_string(value: &str, ctx: &mut SCtx) -> String {
    let has_control = value.chars().any(|c| {
        let u = c as u32;
        u <= 0x08 || (0x0B..=0x1F).contains(&u) || (0x7F..=0x9F).contains(&u)
    });
    if has_control {
        return double_quoted(value, ctx);
    }
    plain_string(value, ctx)
}

fn plain_not_allowed(v: &str) -> bool {
    // /^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/
    let b = v.as_bytes();
    if v.is_empty() {
        return true;
    }
    if b"\n\t ,[]{}#&*!|>'\"%@`".contains(&b[0]) {
        return true;
    }
    if v == "?" || v == "-" {
        return true;
    }
    if (b[0] == b'?' || b[0] == b'-') && matches!(b.get(1), Some(b' ') | Some(b'\t')) {
        return true;
    }
    for i in 0..b.len() {
        let next = b.get(i + 1).copied();
        if (b[i] == b'\n' || b[i] == b':') && matches!(next, Some(b' ') | Some(b'\t')) {
            return true;
        }
        if (b[i] == b' ' || b[i] == b'\t') && next == Some(b'\n') {
            return true;
        }
        if matches!(b[i], b'\n' | b'\t' | b' ') && next == Some(b'#') {
            return true;
        }
    }
    matches!(b[b.len() - 1], b'\n' | b'\t' | b' ' | b':')
}

fn plain_string(value: &str, ctx: &mut SCtx) -> String {
    if ctx.implicit_key && value.contains('\n') {
        return quoted_string(value, ctx);
    }
    if plain_not_allowed(value) {
        return if ctx.implicit_key || !value.contains('\n') {
            quoted_string(value, ctx)
        } else {
            block_string(value, ctx)
        };
    }
    if !ctx.implicit_key && value.contains('\n') {
        return block_string(value, ctx);
    }
    if contains_document_marker(value) {
        if ctx.indent.is_empty() {
            ctx.force_block_indent = true;
            return block_string(value, ctx);
        } else if ctx.implicit_key && ctx.indent == INDENT_STEP {
            return quoted_string(value, ctx);
        }
    }
    if resolves_as_non_string(value) {
        return quoted_string(value, ctx);
    }
    value.to_string()
}

fn quoted_string(value: &str, ctx: &mut SCtx) -> String {
    let has_double = value.contains('"');
    let has_single = value.contains('\'');
    if has_double && !has_single {
        single_quoted(value, ctx)
    } else {
        double_quoted(value, ctx)
    }
}

fn single_quoted(value: &str, ctx: &mut SCtx) -> String {
    let around_newline = value.contains(" \n") || value.contains("\t\n") || value.contains("\n ") || value.contains("\n\t");
    if (ctx.implicit_key && value.contains('\n')) || around_newline {
        return double_quoted(value, ctx);
    }
    let indent = if ctx.indent.is_empty() && contains_document_marker(value) { "  ".to_string() } else { ctx.indent.clone() };
    let escaped = value.replace('\'', "''");
    let mut out = String::from("'");
    let mut chars = escaped.char_indices().peekable();
    let mut last = 0;
    while let Some((i, c)) = chars.next() {
        if c == '\n' {
            let mut j = i;
            while escaped[j..].starts_with('\n') {
                j += 1;
            }
            out.push_str(&escaped[last..j]);
            out.push('\n');
            out.push_str(&indent);
            last = j;
            while matches!(chars.peek(), Some((k, _)) if *k < j) {
                chars.next();
            }
        }
    }
    out.push_str(&escaped[last..]);
    out.push('\'');
    out
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

fn double_quoted(value: &str, ctx: &mut SCtx) -> String {
    let json = json_string(value);
    let indent = if ctx.indent.is_empty() && contains_document_marker(value) { "  ".to_string() } else { ctx.indent.clone() };
    let jb: Vec<char> = json.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let at = |k: usize| jb.get(k).copied();
    while i < jb.len() {
        let ch = jb[i];
        if ch == ' ' && at(i + 1) == Some('\\') && at(i + 2) == Some('n') {
            out.push_str("\\ ");
            i += 1;
            continue;
        }
        if ch == '\\' {
            match at(i + 1) {
                Some('u') => {
                    let code: String = jb[i + 2..(i + 6).min(jb.len())].iter().collect();
                    match code.as_str() {
                        "0000" => out.push_str("\\0"),
                        "0007" => out.push_str("\\a"),
                        "000b" => out.push_str("\\v"),
                        "001b" => out.push_str("\\e"),
                        "0085" => out.push_str("\\N"),
                        "00a0" => out.push_str("\\_"),
                        "2028" => out.push_str("\\L"),
                        "2029" => out.push_str("\\P"),
                        _ if code.starts_with("00") => {
                            out.push_str("\\x");
                            out.push_str(&code[2..]);
                        }
                        _ => {
                            out.push_str("\\u");
                            out.push_str(&code);
                        }
                    }
                    i += 6;
                    continue;
                }
                Some('n') => {
                    if ctx.implicit_key || at(i + 2) == Some('"') || jb.len() < 40 {
                        out.push_str("\\n");
                        i += 2;
                    } else {
                        out.push_str("\n\n");
                        while at(i + 2) == Some('\\') && at(i + 3) == Some('n') && at(i + 4) != Some('"') {
                            out.push('\n');
                            i += 2;
                        }
                        out.push_str(&indent);
                        if at(i + 2) == Some(' ') {
                            out.push('\\');
                        }
                        i += 2;
                    }
                    continue;
                }
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                    i += 2;
                    continue;
                }
                None => {}
            }
        }
        out.push(ch);
        i += 1;
    }
    out
}

fn block_string(value: &str, ctx: &mut SCtx) -> String {
    // A trailing line of only whitespace cannot be expressed in a block.
    if let Some(i) = value.rfind('\n') {
        let tail = &value[i + 1..];
        if !tail.is_empty() && tail.bytes().all(|c| c == b' ' || c == b'\t') {
            return quoted_string(value, ctx);
        }
    }
    let indent = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if ctx.force_block_indent || contains_document_marker(value) {
        "  ".to_string()
    } else {
        String::new()
    };
    if value.is_empty() {
        return "|\n".into();
    }
    let end_start = value.trim_end_matches(['\n', '\t', ' ']).len();
    let mut end = value[end_start..].to_string();
    let chomp = match end.find('\n') {
        None => "-",
        Some(p) if value == end || p != end.len() - 1 => "+",
        _ => "",
    };
    let mut value = value.to_string();
    if !end.is_empty() {
        value.truncate(value.len() - end.len());
        if end.ends_with('\n') {
            end.pop();
        }
        end = indent_newline_runs(&end, &indent, true);
    }
    let mut start_with_space = false;
    let mut start_end = 0;
    let mut start_nl: isize = -1;
    for (i, c) in value.bytes().enumerate() {
        match c {
            b' ' => start_with_space = true,
            b'\n' => start_nl = i as isize,
            _ => break,
        }
        start_end = i + 1;
    }
    let cut = if start_nl < start_end as isize { (start_nl + 1) as usize } else { start_end };
    let mut start = value[..cut].to_string();
    if !start.is_empty() {
        value = value[cut..].to_string();
        start = indent_newline_runs(&start, &indent, false);
    }
    let indent_size = if indent.is_empty() { "1" } else { "2" };
    let header = format!("{}{}", if start_with_space { indent_size } else { "" }, chomp);
    let value = indent_newline_runs(&value, &indent, false);
    format!("|{header}\n{indent}{start}{value}{end}")
}

/// `s.replace(/\n+/g, "$&" + indent)`; with `interior_only`, runs at the very
/// end are left alone (`blockEndNewlines`).
fn indent_newline_runs(s: &str, indent: &str, interior_only: bool) -> String {
    let mut out = String::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\n' {
            let mut j = i;
            while j < b.len() && b[j] == b'\n' {
                j += 1;
            }
            out.push_str(&s[i..j]);
            if !(interior_only && j == b.len()) {
                out.push_str(indent);
            }
            i = j;
        } else {
            let c = s[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

#[allow(dead_code)]
fn is_ws(c: char) -> bool {
    is_js_ws(c)
}
