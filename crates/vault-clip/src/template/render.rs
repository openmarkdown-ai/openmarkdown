//! Knap renderer — a port of `knap/src/renderer.ts` and the engine's filter
//! dispatch. Whitespace control is reproduced exactly, including its odd
//! corner: a tag's pending right-trim is applied to that same tag's own
//! output when the tag is appended (which is what makes `{% if %}\n…` blocks
//! render without a leading newline).

use super::filters::{self, FilterCall, FilterEnv};
use super::parser::{Expr, Lit, Node};
use crate::value::{js_number, Map, Value};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub line: usize,
    pub column: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
}

/// Resolves names that are not plain variables (selectors, schema, …).
pub trait Resolver {
    fn resolve(&self, name: &str, scope: &Scope) -> Value;
}

/// Variable scope: host variables first (the clipper stores them as
/// `{{name}}` keys, which Knap consults before plain keys), then `set`/loop
/// frames from innermost outwards.
pub struct Scope<'a> {
    pub host: &'a Variables,
    pub frames: Vec<Map>,
}

/// Host variables with insertion order and O(1) lookup.
#[derive(Debug, Clone, Default)]
pub struct Variables {
    order: Vec<String>,
    map: std::collections::HashMap<String, Value>,
}

impl Variables {
    pub fn new() -> Variables {
        Variables::default()
    }
    pub fn insert(&mut self, key: impl Into<String>, value: Value) {
        let mut key: String = key.into();
        if key.starts_with("{{") && key.ends_with("}}") && key.len() >= 4 {
            key = key[2..key.len() - 2].to_string();
        }
        if !self.map.contains_key(&key) {
            self.order.push(key.clone());
        }
        self.map.insert(key, value);
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.map.get(key)
    }
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.order.iter()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.order.iter().map(move |k| (k, &self.map[k]))
    }
    pub fn len(&self) -> usize {
        self.order.len()
    }
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }
}

impl Scope<'_> {
    fn lookup_key(&self, key: &str) -> Option<Value> {
        if let Some(v) = self.host.get(key) {
            if !matches!(v, Value::Undefined) {
                return Some(v.clone());
            }
        }
        for f in self.frames.iter().rev() {
            if let Some(v) = f.get(key) {
                if !matches!(v, Value::Undefined) {
                    return Some(v.clone());
                }
            }
        }
        None
    }

    fn lookup_plain(&self, key: &str) -> Option<Value> {
        self.frames
            .iter()
            .rev()
            .find_map(|f| f.get(key).filter(|v| !matches!(v, Value::Undefined)).cloned())
    }

    /// knap `resolveVariable`.
    pub fn resolve(&self, name: &str) -> Value {
        let trimmed = name.trim();
        if let Some(v) = self.lookup_key(trimmed) {
            return v;
        }
        if trimmed.contains('.') {
            return self.nested(&trimmed.split('.').collect::<Vec<_>>());
        }
        Value::Undefined
    }

    fn nested(&self, keys: &[&str]) -> Value {
        let mut value: Option<Value> = None;
        for (i, key) in keys.iter().enumerate() {
            if i > 0 && value.as_ref().is_none_or(|v| v.is_nullish()) {
                return Value::Undefined;
            }
            if key.contains('[') && key.contains(']') {
                if let Some(open) = key.find('[') {
                    if let Some(close_rel) = key[open + 1..].find(']') {
                        let array_key = &key[..open];
                        let index = &key[open + 1..open + 1 + close_rel];
                        if !index.is_empty() {
                            let base = if i == 0 {
                                // Knap reads the bracketed first key as a plain
                                // (non-`{{…}}`) key only.
                                if array_key.is_empty() {
                                    None
                                } else {
                                    self.lookup_plain(array_key)
                                }
                            } else if array_key.is_empty() {
                                value.clone()
                            } else {
                                value.as_ref().and_then(|v| own_property(v, array_key))
                            };
                            value = match base {
                                Some(Value::Array(a)) => {
                                    crate::value::parse_int(index).and_then(|n| usize::try_from(n).ok()).and_then(|n| a.get(n).cloned())
                                }
                                Some(Value::Object(m)) => m.get(index.trim_matches(['"', '\''])).cloned(),
                                _ => return Value::Undefined,
                            };
                            continue;
                        }
                    }
                }
            }
            value = if i == 0 {
                self.lookup_key(key)
            } else {
                let v = value.as_ref().unwrap();
                own_property(v, &format!("{{{{{key}}}}}")).or_else(|| own_property(v, key))
            };
        }
        value.unwrap_or(Value::Undefined)
    }

    fn set(&mut self, name: &str, value: Value) {
        if self.frames.is_empty() {
            self.frames.push(Map::new());
        }
        self.frames.last_mut().unwrap().insert(name, value);
    }
}

/// `ownProperty(value, key)`.
pub fn own_property(v: &Value, key: &str) -> Option<Value> {
    match v {
        Value::Object(m) => m.get(key).cloned(),
        Value::Array(a) => {
            if key == "length" {
                return Some(Value::Number(a.len() as f64));
            }
            if key.chars().all(|c| c.is_ascii_digit()) && !key.is_empty() && (key == "0" || !key.starts_with('0')) {
                return key.parse::<usize>().ok().and_then(|i| a.get(i).cloned());
            }
            None
        }
        Value::String(s) => {
            if key == "length" {
                return Some(Value::Number(crate::value::utf16_len(s) as f64));
            }
            if key.chars().all(|c| c.is_ascii_digit()) && !key.is_empty() && (key == "0" || !key.starts_with('0')) {
                let i: usize = key.parse().ok()?;
                let units: Vec<u16> = s.encode_utf16().collect();
                return units.get(i).map(|u| Value::String(String::from_utf16_lossy(&[*u])));
            }
            None
        }
        _ => None,
    }
}

struct Renderer<'a> {
    resolver: &'a dyn Resolver,
    env: &'a FilterEnv,
    errors: Vec<Diagnostic>,
    warnings: Vec<Diagnostic>,
    ops: usize,
}

const MAX_OPS: usize = 1_000_000;
const MAX_OUTPUT: usize = 5_000_000;

pub struct RenderOutput {
    pub output: String,
    pub errors: Vec<Diagnostic>,
    pub warnings: Vec<Diagnostic>,
}

pub fn render(ast: &[Node], host: &Variables, resolver: &dyn Resolver, env: &FilterEnv) -> RenderOutput {
    let mut r = Renderer {
        resolver,
        env,
        errors: Vec::new(),
        warnings: Vec::new(),
        ops: 0,
    };
    let mut scope = Scope {
        host,
        frames: vec![Map::new()],
    };
    let mut pending = false;
    let mut output = String::new();
    for node in ast {
        let out = r.node(node, &mut scope, &mut pending);
        append(&mut output, &out, node, &mut pending);
        if output.len() > MAX_OUTPUT || r.ops > MAX_OPS {
            r.errors.push(Diagnostic {
                code: "LIMIT_EXCEEDED".into(),
                message: "Template exceeded render limits".into(),
                line: 1,
                column: 1,
                filter: None,
            });
            return RenderOutput {
                output: String::new(),
                errors: r.errors,
                warnings: r.warnings,
            };
        }
    }
    RenderOutput {
        output,
        errors: r.errors,
        warnings: r.warnings,
    }
}

fn trim_leading_ws(s: &str) -> &str {
    // /^[\t ]*\r?\n?/
    let t = s.trim_start_matches(['\t', ' ']);
    let t = t.strip_prefix("\r\n").or_else(|| t.strip_prefix('\n')).unwrap_or(t);
    t
}

fn trim_trailing_ws(s: &str) -> String {
    // /[\t ]*\r?\n?$/
    let mut t = s;
    if let Some(x) = t.strip_suffix('\n') {
        t = x.strip_suffix('\r').unwrap_or(x);
    }
    t.trim_end_matches(['\t', ' ']).to_string()
}

fn node_trim_left(node: &Node) -> bool {
    match node {
        Node::Text(_) => false,
        Node::Variable { trim_left, .. }
        | Node::If { trim_left, .. }
        | Node::For { trim_left, .. }
        | Node::Set { trim_left, .. } => *trim_left,
    }
}

fn append(output: &mut String, node_out: &str, node: &Node, pending: &mut bool) {
    if node_trim_left(node) && !output.is_empty() {
        *output = trim_trailing_ws(output);
    }
    if *pending && !node_out.is_empty() {
        output.push_str(trim_leading_ws(node_out));
        *pending = false;
    } else {
        output.push_str(node_out);
    }
}

/// Knap `valueToString`.
pub fn value_to_string(v: &Value) -> String {
    match v {
        Value::Undefined | Value::Null => String::new(),
        Value::Array(a) if a.len() == 1 && !matches!(a[0], Value::Array(_) | Value::Object(_) | Value::Null) => a[0].js_string(),
        Value::Array(_) | Value::Object(_) => v.to_json_string(),
        other => other.js_string(),
    }
}

struct EvalError {
    code: String,
    message: String,
    line: Option<usize>,
    column: Option<usize>,
}

impl<'a> Renderer<'a> {
    fn node(&mut self, node: &Node, scope: &mut Scope, pending: &mut bool) -> String {
        self.ops += 1;
        match node {
            Node::Text(t) => {
                if *pending {
                    *pending = false;
                    trim_leading_ws(t).to_string()
                } else {
                    t.clone()
                }
            }
            Node::Variable { expr, trim_right, line, column, .. } => match self.eval(expr, scope) {
                Ok(v) => {
                    if *trim_right {
                        *pending = true;
                    }
                    value_to_string(&v)
                }
                Err(e) => {
                    self.push_error(e, "Error evaluating variable", *line, *column);
                    String::new()
                }
            },
            Node::If { cond, then, elseifs, otherwise, trim_right, line, column, .. } => {
                let result = (|| -> Result<String, EvalError> {
                    if self.eval(cond, scope)?.truthy() {
                        return Ok(self.nodes(then, scope, pending));
                    }
                    for (c, body) in elseifs {
                        if self.eval(c, scope)?.truthy() {
                            return Ok(self.nodes(body, scope, pending));
                        }
                    }
                    if let Some(body) = otherwise {
                        return Ok(self.nodes(body, scope, pending));
                    }
                    Ok(String::new())
                })();
                match result {
                    Ok(out) => {
                        if *trim_right {
                            *pending = true;
                        }
                        out
                    }
                    Err(e) => {
                        self.push_error(e, "Error evaluating if condition", *line, *column);
                        String::new()
                    }
                }
            }
            Node::For { iterator, iterable, body, trim_right, line, column, .. } => {
                let value = match self.eval(iterable, scope) {
                    Ok(v) => v,
                    Err(e) => {
                        self.push_error(e, "Error in for loop", *line, *column);
                        return String::new();
                    }
                };
                if value.is_nullish() {
                    if *trim_right {
                        *pending = true;
                    }
                    return String::new();
                }
                let items = match value {
                    Value::Array(a) => a,
                    Value::String(s) => match Value::parse_json(&s) {
                        Some(Value::Array(a)) => a,
                        _ => {
                            self.not_array("string", *trim_right, *line, *column, pending);
                            return String::new();
                        }
                    },
                    other => {
                        let ty = match other {
                            Value::Number(_) => "number",
                            Value::Bool(_) => "boolean",
                            _ => "object",
                        };
                        self.not_array(ty, *trim_right, *line, *column, pending);
                        return String::new();
                    }
                };
                let len = items.len();
                let mut results: Vec<String> = Vec::new();
                for (i, item) in items.into_iter().enumerate() {
                    self.ops += 1;
                    if self.ops > MAX_OPS {
                        break;
                    }
                    let mut frame = Map::new();
                    frame.insert(iterator.clone(), item);
                    frame.insert(format!("{iterator}_index"), Value::Number(i as f64));
                    let mut loop_obj = Map::new();
                    loop_obj.insert("index", Value::Number((i + 1) as f64));
                    loop_obj.insert("index0", Value::Number(i as f64));
                    loop_obj.insert("first", Value::Bool(i == 0));
                    loop_obj.insert("last", Value::Bool(i + 1 == len));
                    loop_obj.insert("length", Value::Number(len as f64));
                    frame.insert("loop", Value::Object(loop_obj));
                    scope.frames.push(frame);
                    let mut loop_pending = *pending;
                    let item_out = self.nodes(body, scope, &mut loop_pending);
                    scope.frames.pop();
                    let trimmed = trim_leading_ws(&item_out).to_string();
                    if !trimmed.is_empty() {
                        results.push(trimmed);
                    }
                }
                if *trim_right {
                    *pending = true;
                }
                let n = results.len();
                results
                    .into_iter()
                    .enumerate()
                    .map(|(i, r)| {
                        if i + 1 == n {
                            trim_trailing_ws(&r)
                        } else if r.ends_with('\n') {
                            r
                        } else {
                            format!("{r}\n")
                        }
                    })
                    .collect()
            }
            Node::Set { name, value, trim_right, line, column, .. } => match self.eval(value, scope) {
                Ok(v) => {
                    scope.set(name, v);
                    if *trim_right {
                        *pending = true;
                    }
                    String::new()
                }
                Err(e) => {
                    self.push_error(e, "Error in set", *line, *column);
                    String::new()
                }
            },
        }
    }

    fn not_array(&mut self, ty: &str, trim_right: bool, line: usize, column: usize, pending: &mut bool) {
        self.errors.push(Diagnostic {
            code: "RENDER_ERROR".into(),
            message: format!("For loop iterable is not an array: {ty}"),
            line,
            column,
            filter: None,
        });
        if trim_right {
            *pending = true;
        }
    }

    fn push_error(&mut self, e: EvalError, prefix: &str, line: usize, column: usize) {
        let message = if e.code == "RENDER_ERROR" {
            format!("{prefix}: {}", e.message)
        } else {
            e.message
        };
        self.errors.push(Diagnostic {
            code: e.code,
            message,
            line: e.line.unwrap_or(line),
            column: e.column.unwrap_or(column),
            filter: None,
        });
    }

    fn nodes(&mut self, nodes: &[Node], scope: &mut Scope, pending: &mut bool) -> String {
        let mut output = String::new();
        for n in nodes {
            let out = self.node(n, scope, pending);
            append(&mut output, &out, n, pending);
        }
        output
    }

    fn eval(&mut self, expr: &Expr, scope: &mut Scope) -> Result<Value, EvalError> {
        self.ops += 1;
        Ok(match expr {
            Expr::Literal { value, .. } => lit_value(value),
            Expr::Ident { name } => {
                let v = scope.resolve(name);
                if !matches!(v, Value::Undefined) {
                    v
                } else {
                    self.resolver.resolve(name, scope)
                }
            }
            Expr::Group(e) => self.eval(e, scope)?,
            Expr::Member { object, property } => {
                let obj = self.eval(object, scope)?;
                let prop = self.eval(property, scope)?;
                if obj.is_nullish() {
                    Value::Undefined
                } else {
                    let key = match &prop {
                        Value::String(s) => s.clone(),
                        Value::Number(n) => js_number(*n),
                        _ => return Ok(Value::Undefined),
                    };
                    own_property(&obj, &key).unwrap_or(Value::Undefined)
                }
            }
            Expr::Not(e) => Value::Bool(!self.eval(e, scope)?.truthy()),
            Expr::Binary { op, left, right } => {
                if op == "??" {
                    let l = self.eval(left, scope)?;
                    if l.truthy() {
                        return Ok(l);
                    }
                    return self.eval(right, scope);
                }
                let l = self.eval(left, scope)?;
                let r = self.eval(right, scope)?;
                use std::cmp::Ordering::*;
                match op.as_str() {
                    "==" => Value::Bool(l.loose_eq(&r)),
                    "!=" => Value::Bool(!l.loose_eq(&r)),
                    ">" => Value::Bool(l.js_compare(&r) == Some(Greater)),
                    "<" => Value::Bool(l.js_compare(&r) == Some(Less)),
                    ">=" => Value::Bool(matches!(l.js_compare(&r), Some(Greater | Equal))),
                    "<=" => Value::Bool(matches!(l.js_compare(&r), Some(Less | Equal))),
                    "contains" => Value::Bool(contains(&l, &r)),
                    "and" => Value::Bool(l.truthy() && r.truthy()),
                    "or" => Value::Bool(l.truthy() || r.truthy()),
                    _ => Value::Undefined,
                }
            }
            Expr::Filter { value, name, args, line, column } => {
                let v = self.eval(value, scope)?;
                let mut evaluated = Vec::new();
                for a in args {
                    let mut av = self.eval(a, scope)?;
                    if matches!(av, Value::Undefined) {
                        if let Expr::Ident { name } = a {
                            av = Value::String(name.clone());
                        }
                    }
                    evaluated.push(av);
                }
                let raw_args: Vec<Value> = args
                    .iter()
                    .zip(evaluated.iter())
                    .map(|(a, av)| {
                        let mut e = a;
                        while let Expr::Group(inner) = e {
                            e = inner;
                        }
                        match e {
                            Expr::Literal { unquoted: Some(u), .. } => Value::String(u.clone()),
                            _ => av.clone(),
                        }
                    })
                    .collect();
                let param = if evaluated.is_empty() {
                    None
                } else {
                    Some(
                        evaluated
                            .iter()
                            .map(|a| match a {
                                Value::String(s) => format_string_arg(s),
                                other => other.js_string(),
                            })
                            .collect::<Vec<_>>()
                            .join(","),
                    )
                };
                let string_value = value_to_string(&v);
                if !filters::exists(name) {
                    return Ok(Value::String(string_value));
                }
                if args.iter().any(|a| !a.is_literal_arg()) {
                    if let Err(msg) = super::validate::validate_params(name, param.as_deref()) {
                        return Err(EvalError {
                            code: "INVALID_FILTER_ARGUMENTS".into(),
                            message: format!("Filter \"{name}\" {msg}"),
                            line: Some(*line),
                            column: Some(*column),
                        });
                    }
                }
                let call = FilterCall {
                    value: &string_value,
                    param: param.as_deref(),
                    raw_value: &v,
                    raw_args: Some(&raw_args),
                    env: self.env,
                };
                let out = filters::apply(name, &call).unwrap_or_else(|| Value::String(string_value.clone()).into());
                if let Some(w) = out.warning {
                    let d = Diagnostic {
                        code: "FILTER_WARNING".into(),
                        message: w,
                        line: *line,
                        column: *column,
                        filter: Some(name.clone()),
                    };
                    if !self.warnings.contains(&d) {
                        self.warnings.push(d);
                    }
                }
                if let Some(e) = out.error {
                    return Err(EvalError {
                        code: "INVALID_FILTER_ARGUMENTS".into(),
                        message: e,
                        line: Some(*line),
                        column: Some(*column),
                    });
                }
                out.value
            }
        })
    }
}

fn lit_value(l: &Lit) -> Value {
    match l {
        Lit::Str(s) => Value::String(s.clone()),
        Lit::Num(n) => Value::Number(*n),
        Lit::Bool(b) => Value::Bool(*b),
        Lit::Null => Value::Null,
    }
}

/// How the renderer serializes a string argument into the parameter string.
fn format_string_arg(a: &str) -> String {
    let quoted = {
        let first = a.chars().next();
        let last = a.chars().last();
        (a.chars().count() >= 2 && matches!(first, Some('"' | '\'')) && matches!(last, Some('"' | '\'')))
            || a.contains("\":\"")
            || a.contains("':'")
    };
    if quoted {
        return a.to_string();
    }
    // /\s*\w+\s*=>/
    if let Some(pos) = a.find("=>") {
        let before = a[..pos].trim_end();
        if before.chars().last().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
            return a.to_string();
        }
    }
    if !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "_.:+-*/".contains(c)) {
        return a.to_string();
    }
    format!("\"{a}\"")
}

fn contains(l: &Value, r: &Value) -> bool {
    if l.is_nullish() || r.is_nullish() {
        return false;
    }
    match l {
        Value::Array(items) => items.iter().any(|item| match (item, r) {
            (Value::String(a), Value::String(b)) => a.to_lowercase() == b.to_lowercase(),
            _ => item.loose_eq(r),
        }),
        Value::String(s) => {
            let needle = match r {
                Value::String(x) => x.clone(),
                other => other.js_string(),
            };
            s.to_lowercase().contains(&needle.to_lowercase())
        }
        _ => false,
    }
}
