//! Expression evaluation: identifiers, operators, global functions and
//! per-type methods.

use crate::datetime::{self, Duration};
use crate::error::BaseError;
use crate::expr::{parse_expression, BinOp, Expr, ExprKind, UnOp};
use crate::record::{
    self, json_to_value, link_key, property_type, split_link, FileIndex, FileRecord,
};
use crate::value::{js_to_fixed, natural_cmp, normalize_tag, OrderedMap, Value};
use std::cell::{Cell, RefCell};
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};

type R<T> = Result<T, String>;

const MAX_EVAL_DEPTH: usize = 200;
const MAX_STRING: usize = 16 * 1024 * 1024;

/// Everything an expression can see.
pub struct EvalContext<'a> {
    /// Every file in the vault (for `file()`, links, `asFile()`, backlinks).
    pub files: &'a [FileRecord],
    /// The row being evaluated: what `file` and bare property names refer to.
    pub file: Option<&'a FileRecord>,
    /// The base file, the embedding note, or the active file for a sidebar base.
    pub this: Option<&'a FileRecord>,
    /// Formulas `formula.x` can reference.
    pub formulas: Option<&'a OrderedMap<String>>,
    pub now_ms: f64,
    /// Minutes east of UTC.
    pub tz_offset_min: i32,
    /// `.obsidian/types.json` property types.
    pub property_types: Option<&'a BTreeMap<String, String>>,
    /// Extra bindings (`values` for a summary, `value`/`index` in callbacks).
    pub locals: Vec<(String, Value)>,
}

impl<'a> EvalContext<'a> {
    pub fn new(files: &'a [FileRecord], now_ms: f64) -> Self {
        EvalContext {
            files,
            file: None,
            this: None,
            formulas: None,
            now_ms,
            tz_offset_min: 0,
            property_types: None,
            locals: Vec::new(),
        }
    }
}

/// Parse and evaluate one expression.
pub fn eval(expr: &str, ctx: &EvalContext) -> Result<Value, BaseError> {
    let ast = parse_expression(expr)?;
    let empty = OrderedMap::new();
    let engine = Engine::new(
        ctx.files,
        ctx.this,
        ctx.formulas.unwrap_or(&empty),
        ctx.now_ms,
        ctx.tz_offset_min,
        ctx.property_types,
    );
    let mut ev = engine.row(ctx.file);
    ev.locals = ctx.locals.clone();
    ev.eval(&ast).map_err(BaseError::eval)
}

pub(crate) struct Engine<'a> {
    pub index: FileIndex<'a>,
    pub now_ms: f64,
    pub tz: i32,
    types: Option<&'a BTreeMap<String, String>>,
    formulas: HashMap<String, Result<Expr, BaseError>>,
    regex_cache: RefCell<HashMap<(String, String), Result<regex_lite::Regex, String>>>,
    rng: Cell<u64>,
}

impl<'a> Engine<'a> {
    pub fn new(
        files: &'a [FileRecord],
        this: Option<&'a FileRecord>,
        formulas: &OrderedMap<String>,
        now_ms: f64,
        tz: i32,
        types: Option<&'a BTreeMap<String, String>>,
    ) -> Self {
        // An empty formula (a freshly added, untitled one) is simply empty.
        let formulas = formulas
            .iter()
            .map(|(k, src)| {
                let parsed = if src.trim().is_empty() {
                    Ok(Expr {
                        kind: ExprKind::Null,
                        start: 0,
                        end: 0,
                    })
                } else {
                    parse_expression(src).map_err(|e| e.with_source(format!("formulas.{k}")))
                };
                (k.clone(), parsed)
            })
            .collect();
        Engine {
            index: FileIndex::new(files, this),
            now_ms,
            tz,
            types,
            formulas,
            regex_cache: RefCell::new(HashMap::new()),
            rng: Cell::new((now_ms.to_bits() ^ 0x9E37_79B9_7F4A_7C15) | 1),
        }
    }

    pub fn row<'e>(&'e self, row: Option<&'a FileRecord>) -> Ev<'e, 'a> {
        Ev {
            eng: self,
            row,
            cache: HashMap::new(),
            stack: Vec::new(),
            locals: Vec::new(),
            depth: 0,
        }
    }

    pub fn formula_error(&self, name: &str) -> Option<&BaseError> {
        self.formulas.get(name).and_then(|r| r.as_ref().err())
    }

    fn random(&self) -> f64 {
        let mut x = self.rng.get();
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng.set(x);
        (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }

    fn regex(&self, pattern: &str, flags: &str) -> R<regex_lite::Regex> {
        let key = (pattern.to_string(), flags.to_string());
        if let Some(r) = self.regex_cache.borrow().get(&key) {
            return r.clone();
        }
        let r = compile_regex(pattern, flags);
        self.regex_cache.borrow_mut().insert(key, r.clone());
        r
    }
}

/// Translate a JavaScript pattern and flags to a regex-lite pattern.
pub(crate) fn compile_regex(pattern: &str, flags: &str) -> R<regex_lite::Regex> {
    let mut inline = String::new();
    for f in ['i', 'm', 's'] {
        if flags.contains(f) {
            inline.push(f);
        }
    }
    let mut p = String::with_capacity(pattern.len() + 8);
    if !inline.is_empty() {
        p.push_str(&format!("(?{inline})"));
    }
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('/') => p.push('/'),
                Some(n) => {
                    p.push('\\');
                    p.push(n);
                }
                None => p.push_str("\\\\"),
            }
        } else {
            p.push(c);
        }
    }
    regex_lite::Regex::new(&p).map_err(|e| format!("Invalid regular expression /{pattern}/: {e}"))
}

/// JS replacement string (`$1`, `$&`, `$<name>`, `$$`) → regex-lite syntax.
fn translate_replacement(s: &str) -> String {
    let mut out = String::new();
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i] == '$' && i + 1 < b.len() {
            let n = b[i + 1];
            if n == '$' {
                out.push_str("$$");
                i += 2;
                continue;
            }
            if n == '&' {
                out.push_str("${0}");
                i += 2;
                continue;
            }
            if n.is_ascii_digit() {
                let mut j = i + 1;
                while j < b.len() && j < i + 3 && b[j].is_ascii_digit() {
                    j += 1;
                }
                let digits: String = b[i + 1..j].iter().collect();
                out.push_str(&format!("${{{digits}}}"));
                i = j;
                continue;
            }
            if n == '<' {
                if let Some(end) = b[i + 2..].iter().position(|&c| c == '>') {
                    let name: String = b[i + 2..i + 2 + end].iter().collect();
                    out.push_str(&format!("${{{name}}}"));
                    i += end + 3;
                    continue;
                }
            }
            out.push_str("$$");
            i += 1;
            continue;
        }
        if b[i] == '$' {
            out.push_str("$$");
        } else {
            out.push(b[i]);
        }
        i += 1;
    }
    out
}

/// Evaluation state for one row.
pub(crate) struct Ev<'e, 'a> {
    eng: &'e Engine<'a>,
    pub row: Option<&'a FileRecord>,
    cache: HashMap<String, R<Value>>,
    stack: Vec<String>,
    pub locals: Vec<(String, Value)>,
    depth: usize,
}

fn type_label(v: &Value) -> &'static str {
    v.type_name()
}

fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn from_utf16(v: &[u16]) -> String {
    String::from_utf16_lossy(v)
}

/// JS `slice` index normalisation.
fn slice_bounds(len: usize, start: Option<f64>, end: Option<f64>) -> (usize, usize) {
    let norm = |x: f64| -> usize {
        let x = if x.is_nan() { 0.0 } else { x.trunc() };
        if x < 0.0 {
            (len as f64 + x).max(0.0) as usize
        } else {
            (x as usize).min(len)
        }
    };
    let s = start.map(norm).unwrap_or(0);
    let e = end.map(norm).unwrap_or(len);
    (s, e.max(s))
}

impl<'e, 'a> Ev<'e, 'a> {
    fn tz(&self) -> i32 {
        self.eng.tz
    }

    fn source_path(&self) -> Option<&'a str> {
        self.row.or(self.eng.index.this).map(|r| r.path.as_str())
    }

    pub fn eval(&mut self, e: &Expr) -> R<Value> {
        self.depth += 1;
        if self.depth > MAX_EVAL_DEPTH {
            self.depth -= 1;
            return Err("Expression is nested too deeply".into());
        }
        let r = self.eval_inner(e);
        self.depth -= 1;
        r
    }

    fn local(&self, name: &str) -> Option<&Value> {
        self.locals
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v)
    }

    fn eval_inner(&mut self, e: &Expr) -> R<Value> {
        Ok(match &e.kind {
            ExprKind::Null => Value::Null,
            ExprKind::Bool(b) => Value::bool(*b),
            ExprKind::Number(n) => Value::num(*n),
            ExprKind::Str(s) => Value::str(s.clone()),
            ExprKind::Regex { pattern, flags } => {
                self.eng.regex(pattern, flags)?;
                Value::RegExp {
                    value: pattern.clone(),
                    flags: flags.clone(),
                }
            }
            ExprKind::List(items) => {
                let mut out = Vec::with_capacity(items.len());
                for it in items {
                    out.push(self.eval(it)?);
                }
                Value::list(out)
            }
            ExprKind::Object(entries) => {
                let mut m = OrderedMap::new();
                for (k, x) in entries {
                    let v = self.eval(x)?;
                    m.insert(k.clone(), v);
                }
                Value::Object { value: m }
            }
            ExprKind::Ident(name) => self.ident(name)?,
            ExprKind::Member(obj, name) => {
                if let ExprKind::Ident(root) = &obj.kind {
                    if self.local(root).is_none() {
                        match root.as_str() {
                            "note" => return Ok(self.property(self.row, name)),
                            "formula" => return self.formula(name),
                            "file" => {
                                let row = self.row.ok_or("\"file\" is not available here")?;
                                return self.file_field(Some(row), &row.path, name);
                            }
                            "this" => return self.this_member(name),
                            _ => {}
                        }
                    }
                }
                let v = self.eval(obj)?;
                self.member(&v, name)?
            }
            ExprKind::Index(obj, idx) => {
                if let ExprKind::Ident(root) = &obj.kind {
                    if self.local(root).is_none() && (root == "note" || root == "formula") {
                        let key = self.eval(idx)?;
                        let key = key.to_display(self.tz());
                        return if root == "note" {
                            Ok(self.property(self.row, &key))
                        } else {
                            self.formula(&key)
                        };
                    }
                }
                let v = self.eval(obj)?;
                let i = self.eval(idx)?;
                self.index(&v, &i)?
            }
            ExprKind::Call(callee, args) => match &callee.kind {
                ExprKind::Ident(name) => self.call_global(name, args)?,
                ExprKind::Member(obj, name) => {
                    let recv = self.eval(obj)?;
                    self.call_method(recv, name, args)?
                }
                _ => return Err("Only functions and methods can be called".into()),
            },
            ExprKind::Unary(op, x) => {
                let v = self.eval(x)?;
                if let Value::Error { message } = &v {
                    return Err(message.clone());
                }
                match op {
                    UnOp::Not => Value::bool(!v.is_truthy()),
                    UnOp::Neg | UnOp::Plus if v.is_null() => Value::Null,
                    UnOp::Neg => match v.as_duration() {
                        Some(d) => Value::duration(d.neg()),
                        None => Value::num(-to_js_number(&v)),
                    },
                    UnOp::Plus => Value::num(to_js_number(&v)),
                }
            }
            ExprKind::Binary(op, l, r) => {
                let a = self.eval(l)?;
                match op {
                    BinOp::Or => {
                        return if a.is_truthy() { Ok(a) } else { self.eval(r) };
                    }
                    BinOp::And => {
                        return if a.is_truthy() { self.eval(r) } else { Ok(a) };
                    }
                    _ => {}
                }
                let b = self.eval(r)?;
                self.binary(*op, a, b)?
            }
        })
    }

    fn ident(&mut self, name: &str) -> R<Value> {
        if let Some(v) = self.local(name) {
            return Ok(v.clone());
        }
        match name {
            "file" => Ok(Value::file(
                &self.row.ok_or("\"file\" is not available here")?.path,
            )),
            "note" => Ok(self.properties_object(self.row)),
            "this" => Ok(self
                .eng
                .index
                .this
                .map(|t| Value::file(&t.path))
                .unwrap_or(Value::Null)),
            "formula" => Err("Use formula.name to reference a formula".into()),
            _ => Ok(self.property(self.row, name)),
        }
    }

    pub fn property(&self, rec: Option<&FileRecord>, name: &str) -> Value {
        let Some(rec) = rec else { return Value::Null };
        let found = rec.properties.get(name).map(|v| (name, v)).or_else(|| {
            rec.properties
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(k, v)| (k.as_str(), v))
        });
        match found {
            Some((key, v)) => json_to_value(v, property_type(self.eng.types, key), self.tz()),
            None => Value::Null,
        }
    }

    fn properties_object(&self, rec: Option<&FileRecord>) -> Value {
        let mut m = OrderedMap::new();
        if let Some(rec) = rec {
            for (k, v) in &rec.properties {
                m.insert(
                    k.clone(),
                    json_to_value(v, property_type(self.eng.types, k), self.tz()),
                );
            }
        }
        Value::Object { value: m }
    }

    pub fn formula(&mut self, name: &str) -> R<Value> {
        if let Some(v) = self.cache.get(name) {
            return v.clone();
        }
        let eng = self.eng;
        let Some(parsed) = eng.formulas.get(name) else {
            return Err(format!("Formula \"{name}\" does not exist"));
        };
        let ast = match parsed {
            Ok(a) => a,
            Err(e) => {
                return Err(format!(
                    "Formula \"{name}\" has a syntax error: {}",
                    e.message
                ))
            }
        };
        if self.stack.iter().any(|s| s == name) {
            let mut chain = self.stack.clone();
            chain.push(name.to_string());
            return Err(format!(
                "Circular reference in formula: {}",
                chain.join(" → ")
            ));
        }
        self.stack.push(name.to_string());
        let saved = std::mem::take(&mut self.locals);
        let r = self.eval(ast).and_then(|v| match v {
            Value::Error { message } => Err(message),
            v => Ok(v),
        });
        self.locals = saved;
        self.stack.pop();
        self.cache.insert(name.to_string(), r.clone());
        r
    }

    /// `file.<name>` for the current row.
    pub fn row_file_field(&mut self, name: &str) -> R<Value> {
        let row = self.row.ok_or("\"file\" is not available here")?;
        self.file_field(Some(row), &row.path, name)
    }

    fn this_member(&mut self, name: &str) -> R<Value> {
        let Some(this) = self.eng.index.this else {
            return Ok(Value::Null);
        };
        match name {
            "file" => Ok(Value::file(&this.path)),
            "note" | "properties" => Ok(self.properties_object(Some(this))),
            _ => Ok(self.property(Some(this), name)),
        }
    }

    // ------------------------------------------------------------------
    // Member access and indexing
    // ------------------------------------------------------------------

    fn member(&mut self, v: &Value, name: &str) -> R<Value> {
        Ok(match v {
            Value::Null => Value::Null,
            Value::Error { message } => return Err(message.clone()),
            Value::Object { value } => value.get(name).cloned().unwrap_or(Value::Null),
            Value::File { value } => {
                let rec = self.eng.index.get(value);
                return self.file_field(rec, &value.clone(), name);
            }
            Value::List { value } if name == "length" => Value::num(value.len() as f64),
            Value::Date { value, .. } => {
                let p = datetime::to_parts(*value, self.tz());
                Value::num(match name {
                    "year" => p.year,
                    "month" => p.month,
                    "day" => p.day,
                    "hour" => p.hour,
                    "minute" => p.minute,
                    "second" => p.second,
                    "millisecond" => p.millisecond,
                    _ => return Err(format!("Date has no field \"{name}\"")),
                } as f64)
            }
            Value::Duration { .. } => match v.as_duration().unwrap().as_unit(name) {
                Some(n) => Value::num(n),
                None => return Err(format!("Duration has no field \"{name}\"")),
            },
            other => match (other.string_like(), name) {
                (Some(s), "length") => Value::num(s.encode_utf16().count() as f64),
                _ => return Err(format!("Cannot read \"{name}\" of {}", type_label(other))),
            },
        })
    }

    fn file_field(&mut self, rec: Option<&'a FileRecord>, path: &str, name: &str) -> R<Value> {
        let owned;
        let r = match rec {
            Some(r) => r,
            None => {
                owned = FileRecord::new(path);
                // Only path-derived fields exist for a file that is not in the vault.
                return Ok(match name {
                    "name" => Value::str(&owned.name),
                    "basename" => Value::str(&owned.basename),
                    "path" => Value::str(&owned.path),
                    "folder" => Value::str(&owned.folder),
                    "ext" => Value::str(&owned.ext),
                    "file" => Value::file(path),
                    _ => Value::Null,
                });
            }
        };
        Ok(match name {
            "name" => Value::str(&r.name),
            "basename" => Value::str(&r.basename),
            "path" => Value::str(&r.path),
            "folder" => Value::str(&r.folder),
            "ext" => Value::str(&r.ext),
            "size" => Value::num(r.size),
            "ctime" => Value::date(r.ctime, true),
            "mtime" => Value::date(r.mtime, true),
            "file" => Value::file(&r.path),
            "properties" => self.properties_object(Some(r)),
            "tags" => {
                let mut seen: Vec<String> = Vec::new();
                let mut out = Vec::new();
                for t in &r.tags {
                    let key = normalize_tag(t);
                    if key.is_empty() || seen.contains(&key) {
                        continue;
                    }
                    seen.push(key);
                    let t = t.trim();
                    out.push(Value::Tag {
                        value: if t.starts_with('#') {
                            t.to_string()
                        } else {
                            format!("#{t}")
                        },
                    });
                }
                Value::list(out)
            }
            "links" => Value::list(
                r.links
                    .iter()
                    .map(|l| record::link_value_from_text(l))
                    .collect(),
            ),
            "embeds" => Value::list(
                r.embeds
                    .iter()
                    .map(|l| record::link_value_from_text(l))
                    .collect(),
            ),
            "backlinks" => Value::list(r.backlinks.iter().map(Value::file).collect()),
            _ => self.property(Some(r), name),
        })
    }

    fn index(&mut self, v: &Value, i: &Value) -> R<Value> {
        Ok(match (v, i) {
            (Value::Error { message }, _) | (_, Value::Error { message }) => {
                return Err(message.clone())
            }
            (Value::Null, _) => Value::Null,
            (Value::List { value }, Value::Number { value: n }) => {
                if n.fract() != 0.0 || !n.is_finite() {
                    return Ok(Value::Null);
                }
                let idx = if *n < 0.0 { value.len() as f64 + n } else { *n };
                if idx < 0.0 {
                    Value::Null
                } else {
                    value.get(idx as usize).cloned().unwrap_or(Value::Null)
                }
            }
            (Value::Object { value }, key) => value
                .get(&key.to_display(self.tz()))
                .cloned()
                .unwrap_or(Value::Null),
            (Value::File { .. }, key) => {
                let k = key.to_display(self.tz());
                self.member(v, &k)?
            }
            (other, Value::Number { value: n }) if other.string_like().is_some() => {
                let u = utf16(other.string_like().unwrap());
                let idx = if *n < 0.0 { u.len() as f64 + n } else { *n };
                if idx < 0.0 || idx.fract() != 0.0 || idx as usize >= u.len() {
                    Value::Null
                } else {
                    Value::str(from_utf16(&u[idx as usize..idx as usize + 1]))
                }
            }
            (other, Value::String { value: key }) => self.member(other, key)?,
            (other, idx) => {
                return Err(format!(
                    "Cannot index {} with {}",
                    type_label(other),
                    type_label(idx)
                ))
            }
        })
    }

    // ------------------------------------------------------------------
    // Operators
    // ------------------------------------------------------------------

    fn parse_date_str(&self, s: &str) -> Option<f64> {
        datetime::parse_date(s, self.tz()).map(|d| d.ms)
    }

    fn binary(&mut self, op: BinOp, a: Value, b: Value) -> R<Value> {
        if let Value::Error { message } = &a {
            return Err(message.clone());
        }
        if let Value::Error { message } = &b {
            return Err(message.clone());
        }
        let tz = self.tz();
        Ok(match op {
            BinOp::Eq => Value::bool(self.loose_eq(&a, &b)),
            BinOp::Ne => Value::bool(!self.loose_eq(&a, &b)),
            BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
                let ord = self.compare(&a, &b);
                Value::bool(match (op, ord) {
                    (_, None) => false,
                    (BinOp::Lt, Some(o)) => o == Ordering::Less,
                    (BinOp::Le, Some(o)) => o != Ordering::Greater,
                    (BinOp::Gt, Some(o)) => o == Ordering::Greater,
                    (_, Some(o)) => o != Ordering::Less,
                })
            }
            // A missing value poisons arithmetic (the cell renders empty rather
            // than JavaScript's `null → 0`), but concatenates as "".
            BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod
                if (a.is_null() || b.is_null())
                    && !(op == BinOp::Add && (is_stringy(&a) || is_stringy(&b))) =>
            {
                Value::Null
            }
            BinOp::Add => match (&a, &b) {
                (Value::Number { value: x }, Value::Number { value: y }) => Value::num(x + y),
                (Value::Date { value, time }, _) if duration_of(&b).is_some() => {
                    let d = duration_of(&b).unwrap();
                    Value::date(
                        datetime::add_duration(*value, &d, 1.0, tz),
                        *time || d.ms != 0.0,
                    )
                }
                (Value::Duration { .. }, Value::Date { value, time }) => {
                    let d = a.as_duration().unwrap();
                    Value::date(
                        datetime::add_duration(*value, &d, 1.0, tz),
                        *time || d.ms != 0.0,
                    )
                }
                (Value::Date { value, time }, Value::Number { value: n }) => {
                    Value::date(value + n, *time)
                }
                (Value::Duration { .. }, _) if duration_of(&b).is_some() => {
                    Value::duration(a.as_duration().unwrap().add(&duration_of(&b).unwrap()))
                }
                (Value::List { value: x }, Value::List { value: y }) => {
                    let mut v = x.clone();
                    v.extend(y.iter().cloned());
                    Value::list(v)
                }
                _ if is_stringy(&a) || is_stringy(&b) => {
                    let s = format!("{}{}", concat_str(&a, tz), concat_str(&b, tz));
                    if s.len() > MAX_STRING {
                        return Err("String is too long".into());
                    }
                    Value::str(s)
                }
                _ if is_numeric_like(&a) && is_numeric_like(&b) => {
                    Value::num(to_js_number(&a) + to_js_number(&b))
                }
                _ => {
                    return Err(format!(
                        "Cannot add {} and {}",
                        type_label(&a),
                        type_label(&b)
                    ))
                }
            },
            BinOp::Sub => match (&a, &b) {
                (Value::Date { value: x, .. }, Value::Date { value: y, .. }) => {
                    Value::duration(Duration::from_ms(x - y))
                }
                (Value::Date { value, time }, Value::Number { value: n }) => {
                    Value::date(value - n, *time)
                }
                (Value::Date { value, time }, _) if duration_of(&b).is_some() => {
                    let d = duration_of(&b).unwrap();
                    Value::date(
                        datetime::add_duration(*value, &d, -1.0, tz),
                        *time || d.ms != 0.0,
                    )
                }
                (Value::Date { value: x, .. }, Value::String { value: s })
                    if self.parse_date_str(s).is_some() =>
                {
                    Value::duration(Duration::from_ms(x - self.parse_date_str(s).unwrap()))
                }
                (Value::Duration { .. }, _) if duration_of(&b).is_some() => Value::duration(
                    a.as_duration()
                        .unwrap()
                        .add(&duration_of(&b).unwrap().neg()),
                ),
                _ if is_numeric_like(&a) && is_numeric_like(&b) => {
                    Value::num(to_js_number(&a) - to_js_number(&b))
                }
                _ => {
                    return Err(format!(
                        "Cannot subtract {} from {}",
                        type_label(&b),
                        type_label(&a)
                    ))
                }
            },
            BinOp::Mul | BinOp::Div | BinOp::Mod => {
                if let Some(d) = a.as_duration() {
                    return Ok(match (&b, op) {
                        (Value::Duration { .. }, BinOp::Div) => {
                            Value::num(d.total_ms() / b.as_duration().unwrap().total_ms())
                        }
                        (_, BinOp::Mul) if is_numeric_like(&b) => {
                            Value::duration(d.scale(to_js_number(&b)))
                        }
                        (_, BinOp::Div) if is_numeric_like(&b) => {
                            Value::duration(d.scale(1.0 / to_js_number(&b)))
                        }
                        _ => {
                            return Err(format!(
                                "Cannot apply {} to duration and {}",
                                op_symbol(op),
                                type_label(&b)
                            ))
                        }
                    });
                }
                if matches!(b, Value::Duration { .. }) {
                    return Err(
                        "When multiplying a duration by a number, the duration must be on the left"
                            .into(),
                    );
                }
                if !(is_numeric_like(&a) && is_numeric_like(&b)) {
                    return Err(format!(
                        "Cannot apply {} to {} and {}",
                        op_symbol(op),
                        type_label(&a),
                        type_label(&b)
                    ));
                }
                let (x, y) = (to_js_number(&a), to_js_number(&b));
                Value::num(match op {
                    BinOp::Mul => x * y,
                    BinOp::Div => x / y,
                    _ => {
                        if y == 0.0 {
                            f64::NAN
                        } else {
                            x % y
                        }
                    }
                })
            }
            BinOp::Or | BinOp::And => unreachable!(),
        })
    }

    fn resolve_path(&self, text: &str) -> Option<&'a str> {
        self.eng
            .index
            .resolve(text, self.source_path())
            .map(|r| r.path.as_str())
    }

    /// `==` semantics (`Value.looseEquals`).
    pub fn loose_eq(&self, a: &Value, b: &Value) -> bool {
        let tz = self.tz();
        match (a, b) {
            (Value::Null, Value::Null) => true,
            (Value::Null, _) | (_, Value::Null) => false,
            (Value::Number { value: x }, Value::Number { value: y }) => x == y,
            (Value::Number { value: n }, s) | (s, Value::Number { value: n })
                if s.string_like().is_some() =>
            {
                let t = s.string_like().unwrap().trim();
                !t.is_empty() && t.parse::<f64>().is_ok_and(|v| v == *n)
            }
            (Value::Boolean { value: x }, Value::Boolean { value: y }) => x == y,
            (Value::Boolean { value: x }, Value::String { value: s })
            | (Value::String { value: s }, Value::Boolean { value: x }) => {
                s == if *x { "true" } else { "false" }
            }
            (Value::Date { value: x, .. }, Value::Date { value: y, .. }) => x == y,
            (Value::Date { value: x, .. }, s) | (s, Value::Date { value: x, .. })
                if s.string_like().is_some() =>
            {
                self.parse_date_str(s.string_like().unwrap()) == Some(*x)
            }
            (Value::Duration { value: x, .. }, Value::Duration { value: y, .. }) => x == y,
            (Value::Duration { value: x, .. }, Value::String { value: s })
            | (Value::String { value: s }, Value::Duration { value: x, .. }) => {
                datetime::parse_duration(s).is_some_and(|d| d.total_ms() == *x)
            }
            (Value::Link { value: x, .. }, Value::Link { value: y, .. }) => self.link_eq(x, y),
            (Value::Link { value: l, .. }, Value::File { value: p })
            | (Value::File { value: p }, Value::Link { value: l, .. }) => {
                self.resolve_path(l) == Some(p.as_str())
            }
            (Value::File { value: x }, Value::File { value: y }) => x == y,
            (Value::File { value: p }, s) | (s, Value::File { value: p })
                if s.string_like().is_some() =>
            {
                let t = s.string_like().unwrap();
                t == p || self.resolve_path(t) == Some(p.as_str())
            }
            (Value::Link { value: l, .. }, s) | (s, Value::Link { value: l, .. })
                if s.string_like().is_some() =>
            {
                self.link_eq(l, s.string_like().unwrap())
            }
            (Value::Tag { value: t }, s) | (s, Value::Tag { value: t })
                if s.string_like().is_some() =>
            {
                normalize_tag(t) == normalize_tag(s.string_like().unwrap())
            }
            (Value::List { value: x }, Value::List { value: y }) => {
                x.len() == y.len() && x.iter().zip(y).all(|(p, q)| self.loose_eq(p, q))
            }
            (Value::Object { value: x }, Value::Object { value: y }) => {
                x.len() == y.len()
                    && x.iter()
                        .all(|(k, v)| y.get(k).is_some_and(|w| self.loose_eq(v, w)))
            }
            (Value::RegExp { value: p, flags: f }, Value::RegExp { value: q, flags: g }) => {
                p == q && f == g
            }
            _ => match (a.string_like(), b.string_like()) {
                (Some(x), Some(y)) => x == y,
                _ => {
                    let _ = tz;
                    false
                }
            },
        }
    }

    fn link_eq(&self, x: &str, y: &str) -> bool {
        match (self.resolve_path(x), self.resolve_path(y)) {
            (Some(p), Some(q)) => p == q,
            (None, None) => link_key(x) == link_key(y),
            _ => false,
        }
    }

    /// `<`/`>` semantics; `None` when the values are not comparable.
    fn compare(&self, a: &Value, b: &Value) -> Option<Ordering> {
        match (a, b) {
            (Value::Null, _) | (_, Value::Null) => None,
            (Value::Number { value: x }, Value::Number { value: y }) => x.partial_cmp(y),
            (Value::Date { value: x, .. }, Value::Date { value: y, .. }) => x.partial_cmp(y),
            (Value::Date { value: x, .. }, s) if s.string_like().is_some() => {
                x.partial_cmp(&self.parse_date_str(s.string_like().unwrap())?)
            }
            (s, Value::Date { value: y, .. }) if s.string_like().is_some() => self
                .parse_date_str(s.string_like().unwrap())?
                .partial_cmp(y),
            (Value::Duration { value: x, .. }, Value::Duration { value: y, .. }) => {
                x.partial_cmp(y)
            }
            (Value::Duration { value: x, .. }, Value::String { value: s }) => {
                x.partial_cmp(&datetime::parse_duration(s)?.total_ms())
            }
            (Value::Duration { value: x, .. }, Value::Number { value: y }) => x.partial_cmp(y),
            (Value::Number { value: y }, Value::Duration { value: x, .. }) => y.partial_cmp(x),
            _ => match (a.string_like(), b.string_like()) {
                (Some(x), Some(y)) => Some(utf16(x).cmp(&utf16(y))),
                _ if is_numeric_like(a) && is_numeric_like(b) => {
                    to_js_number(a).partial_cmp(&to_js_number(b))
                }
                _ => None,
            },
        }
    }

    // ------------------------------------------------------------------
    // Global functions
    // ------------------------------------------------------------------

    fn args(&mut self, args: &[Expr]) -> R<Vec<Value>> {
        let mut out = Vec::with_capacity(args.len());
        for a in args {
            let v = self.eval(a)?;
            if let Value::Error { message } = v {
                return Err(message);
            }
            out.push(v);
        }
        Ok(out)
    }

    fn call_global(&mut self, name: &str, args: &[Expr]) -> R<Value> {
        let tz = self.tz();
        if name == "if" {
            if args.len() < 2 || args.len() > 3 {
                return Err(format!("if() takes 2 or 3 arguments, got {}", args.len()));
            }
            let c = self.eval(&args[0])?;
            if let Value::Error { message } = c {
                return Err(message);
            }
            return if c.is_truthy() {
                self.eval(&args[1])
            } else if args.len() == 3 {
                self.eval(&args[2])
            } else {
                Ok(Value::Null)
            };
        }
        let a = self.args(args)?;
        let arity = |min: usize, max: usize| -> R<()> {
            if a.len() < min || a.len() > max {
                Err(if min == max {
                    format!(
                        "{name}() takes {min} argument{}, got {}",
                        if min == 1 { "" } else { "s" },
                        a.len()
                    )
                } else {
                    format!("{name}() takes {min} to {max} arguments, got {}", a.len())
                })
            } else {
                Ok(())
            }
        };
        Ok(match name {
            "now" => {
                arity(0, 0)?;
                Value::date(self.eng.now_ms, true)
            }
            "today" => {
                arity(0, 0)?;
                Value::date(datetime::start_of_day(self.eng.now_ms, tz), false)
            }
            "date" => {
                arity(1, 1)?;
                match &a[0] {
                    d @ Value::Date { .. } => d.clone(),
                    Value::Number { value } => Value::date(*value, true),
                    s if s.string_like().is_some() => {
                        let text = match s {
                            Value::Link { value, .. } => value.as_str(),
                            _ => s.string_like().unwrap(),
                        };
                        match datetime::parse_date(text, tz) {
                            Some(d) => Value::date(d.ms, d.has_time),
                            None => return Err(format!("Invalid date: \"{text}\"")),
                        }
                    }
                    other => {
                        return Err(format!(
                            "date() expects a string, got {}",
                            type_label(other)
                        ))
                    }
                }
            }
            "duration" => {
                arity(1, 1)?;
                match &a[0] {
                    d @ Value::Duration { .. } => d.clone(),
                    Value::Number { value } => Value::duration(Duration::from_ms(*value)),
                    s if s.string_like().is_some() => {
                        match datetime::parse_duration(s.string_like().unwrap()) {
                            Some(d) => Value::duration(d),
                            None => {
                                return Err(format!(
                                    "Invalid duration: \"{}\"",
                                    s.string_like().unwrap()
                                ))
                            }
                        }
                    }
                    other => {
                        return Err(format!(
                            "duration() expects a string, got {}",
                            type_label(other)
                        ))
                    }
                }
            }
            "number" => {
                arity(1, 1)?;
                match &a[0] {
                    Value::Number { value } => Value::num(*value),
                    Value::Boolean { value } => Value::num(if *value { 1.0 } else { 0.0 }),
                    Value::Date { value, .. } => Value::num(*value),
                    Value::Duration { value, .. } => Value::num(*value),
                    s if s.string_like().is_some() => {
                        let t = s.string_like().unwrap().trim();
                        match parse_js_number(t) {
                            Some(n) => Value::num(n),
                            None => return Err(format!("Cannot convert \"{t}\" to a number")),
                        }
                    }
                    other => {
                        return Err(format!("Cannot convert {} to a number", type_label(other)))
                    }
                }
            }
            "list" => {
                arity(1, 1)?;
                match &a[0] {
                    l @ Value::List { .. } => l.clone(),
                    Value::Null => Value::list(vec![]),
                    other => Value::list(vec![other.clone()]),
                }
            }
            "link" => {
                arity(1, 2)?;
                let display = a.get(1).map(|d| Box::new(d.clone()));
                match &a[0] {
                    Value::File { value } => Value::Link {
                        value: value.clone(),
                        display,
                    },
                    Value::Link { value, display: d0 } => Value::Link {
                        value: value.clone(),
                        display: display.or_else(|| d0.clone()),
                    },
                    s if s.string_like().is_some() => {
                        let (target, d) = split_link(s.string_like().unwrap());
                        Value::Link {
                            value: target,
                            display: display.or(d.map(|d| Box::new(Value::str(d)))),
                        }
                    }
                    Value::Null => return Err("link() expects a path, got null".into()),
                    other => Value::Link {
                        value: other.to_display(tz),
                        display,
                    },
                }
            }
            "file" => {
                arity(1, 1)?;
                match &a[0] {
                    f @ Value::File { .. } => f.clone(),
                    Value::Link { value, .. } => self
                        .resolve_path(value)
                        .map(Value::file)
                        .unwrap_or(Value::Null),
                    s if s.string_like().is_some() => {
                        let t = s.string_like().unwrap();
                        self.eng
                            .index
                            .get(t)
                            .map(|r| r.path.as_str())
                            .or_else(|| self.resolve_path(t))
                            .map(Value::file)
                            .unwrap_or(Value::Null)
                    }
                    Value::Null => Value::Null,
                    other => {
                        return Err(format!("file() expects a path, got {}", type_label(other)))
                    }
                }
            }
            "image" => {
                arity(1, 1)?;
                match &a[0] {
                    Value::File { value } | Value::Link { value, .. } => Value::Image {
                        value: value.clone(),
                    },
                    Value::Null => Value::Null,
                    s if s.string_like().is_some() => {
                        let (target, _) = split_link(s.string_like().unwrap());
                        Value::Image { value: target }
                    }
                    other => {
                        return Err(format!("image() expects a path, got {}", type_label(other)))
                    }
                }
            }
            "icon" => {
                arity(1, 1)?;
                Value::Icon {
                    value: a[0].to_display(tz),
                }
            }
            "html" => {
                arity(1, 1)?;
                Value::Html {
                    value: a[0].to_display(tz),
                }
            }
            "escapeHTML" => {
                arity(1, 1)?;
                Value::str(escape_html(&a[0].to_display(tz)))
            }
            "max" | "min" => {
                let is_max = name == "max";
                let vals: Vec<&Value> = a.iter().filter(|v| !v.is_null()).collect();
                if !vals.is_empty() && vals.iter().all(|v| matches!(v, Value::Date { .. })) {
                    let best = vals
                        .iter()
                        .max_by(|x, y| {
                            let o = date_ms(x)
                                .partial_cmp(&date_ms(y))
                                .unwrap_or(Ordering::Equal);
                            if is_max {
                                o
                            } else {
                                o.reverse()
                            }
                        })
                        .unwrap();
                    return Ok((*best).clone());
                }
                let mut acc = if is_max {
                    f64::NEG_INFINITY
                } else {
                    f64::INFINITY
                };
                for v in vals {
                    if !is_numeric_like(v) {
                        return Err(format!("{name}() expects numbers, got {}", type_label(v)));
                    }
                    let n = to_js_number(v);
                    if n.is_nan() {
                        return Ok(Value::num(f64::NAN));
                    }
                    acc = if is_max { acc.max(n) } else { acc.min(n) };
                }
                Value::num(acc)
            }
            "random" => {
                arity(0, 0)?;
                Value::num(self.eng.random())
            }
            _ => return Err(format!("Unknown function \"{name}\"")),
        })
    }

    // ------------------------------------------------------------------
    // Methods
    // ------------------------------------------------------------------

    fn with_locals<T>(
        &mut self,
        binds: Vec<(&str, Value)>,
        f: impl FnOnce(&mut Self) -> R<T>,
    ) -> R<T> {
        let n = binds.len();
        for (k, v) in binds {
            self.locals.push((k.to_string(), v));
        }
        let r = f(self);
        let len = self.locals.len();
        self.locals.truncate(len - n);
        r
    }

    fn call_method(&mut self, recv: Value, name: &str, args: &[Expr]) -> R<Value> {
        if let Value::Error { message } = &recv {
            return Err(message.clone());
        }
        // Callback methods take their argument unevaluated.
        if let Value::List { value: items } = &recv {
            match name {
                "filter" | "map" => {
                    if args.len() != 1 {
                        return Err(format!("{name}() takes 1 argument, got {}", args.len()));
                    }
                    let mut out = Vec::new();
                    for (i, it) in items.iter().enumerate() {
                        let r = self.with_locals(
                            vec![("value", it.clone()), ("index", Value::num(i as f64))],
                            |ev| ev.eval(&args[0]),
                        )?;
                        if let Value::Error { message } = r {
                            return Err(message);
                        }
                        if name == "map" {
                            out.push(r);
                        } else if r.is_truthy() {
                            out.push(it.clone());
                        }
                    }
                    return Ok(Value::list(out));
                }
                "reduce" => {
                    if args.is_empty() || args.len() > 2 {
                        return Err(format!(
                            "reduce() takes 1 or 2 arguments, got {}",
                            args.len()
                        ));
                    }
                    let mut acc = match args.get(1) {
                        Some(init) => self.eval(init)?,
                        None => Value::Null,
                    };
                    for (i, it) in items.iter().enumerate() {
                        acc = self.with_locals(
                            vec![
                                ("value", it.clone()),
                                ("index", Value::num(i as f64)),
                                ("acc", acc.clone()),
                            ],
                            |ev| ev.eval(&args[0]),
                        )?;
                        if let Value::Error { message } = acc {
                            return Err(message);
                        }
                    }
                    return Ok(acc);
                }
                _ => {}
            }
        }
        let a = self.args(args)?;
        let tz = self.tz();
        let arity = |min: usize, max: usize| -> R<()> {
            if a.len() < min || a.len() > max {
                Err(if min == max {
                    format!(
                        "{name}() takes {min} argument{}, got {}",
                        if min == 1 { "" } else { "s" },
                        a.len()
                    )
                } else {
                    format!("{name}() takes {min} to {max} arguments, got {}", a.len())
                })
            } else {
                Ok(())
            }
        };
        // Any type.
        match name {
            "isTruthy" => {
                arity(0, 0)?;
                return Ok(Value::bool(recv.is_truthy()));
            }
            "isType" => {
                arity(1, 1)?;
                return Ok(Value::bool(recv.is_type(&a[0].to_display(tz))));
            }
            "toString" => {
                arity(0, 0)?;
                return Ok(Value::str(recv.to_display(tz)));
            }
            "isEmpty" => {
                arity(0, 0)?;
                return Ok(Value::bool(recv.is_empty()));
            }
            _ => {}
        }
        match &recv {
            Value::Null => Err(format!("Cannot call \"{name}\" on null")),
            Value::Number { value: n } => self.number_method(*n, name, &a, arity),
            Value::Date { value, time } => self.date_method(*value, *time, name, &a, arity),
            Value::List { value } => self.list_method(value, name, &a, arity),
            Value::Object { value } => match name {
                "keys" => {
                    arity(0, 0)?;
                    Ok(Value::list(value.keys().map(Value::str).collect()))
                }
                "values" => {
                    arity(0, 0)?;
                    Ok(Value::list(value.iter().map(|(_, v)| v.clone()).collect()))
                }
                _ => Err(unknown_method(name, &recv)),
            },
            Value::File { value: path } => self.file_method(path, name, &a, arity),
            Value::RegExp { value, flags } => match name {
                "matches" => {
                    arity(1, 1)?;
                    let re = self.eng.regex(value, flags)?;
                    Ok(Value::bool(re.is_match(&a[0].to_display(tz))))
                }
                _ => Err(unknown_method(name, &recv)),
            },
            Value::Link { value, .. } if name == "asFile" => {
                arity(0, 0)?;
                Ok(self
                    .resolve_path(value)
                    .map(Value::file)
                    .unwrap_or(Value::Null))
            }
            Value::Link { value, .. } if name == "linksTo" => {
                arity(1, 1)?;
                let Some(src) = self.eng.index.resolve(value, self.source_path()) else {
                    return Ok(Value::bool(false));
                };
                Ok(Value::bool(self.file_links_to(src, &a[0])))
            }
            other if other.string_like().is_some() => {
                let s = other.string_like().unwrap().to_string();
                self.string_method(&s, &recv, name, &a, arity)
            }
            _ => Err(unknown_method(name, &recv)),
        }
    }

    fn number_method(
        &mut self,
        n: f64,
        name: &str,
        a: &[Value],
        arity: impl Fn(usize, usize) -> R<()>,
    ) -> R<Value> {
        Ok(match name {
            "abs" => {
                arity(0, 0)?;
                Value::num(n.abs())
            }
            "ceil" => {
                arity(0, 0)?;
                Value::num(n.ceil())
            }
            "floor" => {
                arity(0, 0)?;
                Value::num(n.floor())
            }
            "round" => {
                arity(0, 1)?;
                let digits = match a.first() {
                    None | Some(Value::Null) => 0.0,
                    Some(v) => expect_number(v, "round")?.trunc(),
                };
                let p = 10f64.powf(digits);
                let x = n * p;
                // Math.round: nearest integer, halves towards +∞.
                let f = x.floor();
                let r = if x - f >= 0.5 { f + 1.0 } else { f };
                Value::num(r / p)
            }
            "toFixed" => {
                arity(0, 1)?;
                let digits = match a.first() {
                    None => 0.0,
                    Some(v) => expect_number(v, "toFixed")?,
                };
                if !(0.0..=100.0).contains(&digits) {
                    return Err("toFixed() digits must be between 0 and 100".into());
                }
                Value::str(js_to_fixed(n, digits as usize))
            }
            _ => return Err(unknown_method(name, &Value::num(n))),
        })
    }

    fn date_method(
        &mut self,
        ms: f64,
        time: bool,
        name: &str,
        a: &[Value],
        arity: impl Fn(usize, usize) -> R<()>,
    ) -> R<Value> {
        let tz = self.tz();
        Ok(match name {
            "date" => {
                arity(0, 0)?;
                Value::date(datetime::start_of_day(ms, tz), false)
            }
            "format" => {
                arity(0, 1)?;
                let fmt = match a.first() {
                    None => "YYYY-MM-DDTHH:mm:ssZ".to_string(),
                    Some(v) => v.to_display(tz),
                };
                Value::str(datetime::format_date(ms, &fmt, tz))
            }
            "time" => {
                arity(0, 0)?;
                Value::str(datetime::format_date(ms, "HH:mm:ss", tz))
            }
            "relative" => {
                arity(0, 0)?;
                Value::str(datetime::relative(ms, self.eng.now_ms))
            }
            _ => return Err(unknown_method(name, &Value::date(ms, time))),
        })
    }

    fn file_links_to(&self, src: &FileRecord, target: &Value) -> bool {
        let target_path: Option<&str>;
        let target_key: String;
        match target {
            Value::File { value } => {
                target_path = Some(value.as_str());
                target_key = link_key(value);
            }
            Value::Link { value, .. } => {
                target_path = self
                    .eng
                    .index
                    .resolve(value, Some(&src.path))
                    .map(|r| r.path.as_str());
                target_key = link_key(value);
            }
            other => {
                let t = other.to_display(self.tz());
                target_path = self
                    .eng
                    .index
                    .resolve(&t, Some(&src.path))
                    .map(|r| r.path.as_str());
                target_key = link_key(&t);
            }
        }
        src.links.iter().any(
            |l| match (self.eng.index.resolve(l, Some(&src.path)), target_path) {
                (Some(r), Some(p)) => r.path == p,
                (None, None) => link_key(l) == target_key,
                (Some(r), None) => link_key(&r.path) == target_key,
                (None, Some(_)) => false,
            },
        )
    }

    fn file_method(
        &mut self,
        path: &str,
        name: &str,
        a: &[Value],
        arity: impl Fn(usize, usize) -> R<()>,
    ) -> R<Value> {
        let tz = self.tz();
        let rec = self.eng.index.get(path);
        Ok(match name {
            "asLink" => {
                arity(0, 1)?;
                Value::Link {
                    value: path.to_string(),
                    display: a.first().map(|d| Box::new(d.clone())),
                }
            }
            "hasLink" => {
                arity(1, 1)?;
                Value::bool(rec.is_some_and(|r| self.file_links_to(r, &a[0])))
            }
            "hasProperty" => {
                arity(1, 1)?;
                let key = a[0].to_display(tz);
                Value::bool(rec.is_some_and(|r| {
                    r.properties.contains_key(&key)
                        || r.properties.keys().any(|k| k.eq_ignore_ascii_case(&key))
                }))
            }
            "hasTag" => {
                if a.is_empty() {
                    return Err("hasTag() takes at least 1 argument".into());
                }
                let wanted: Vec<String> = a
                    .iter()
                    .flat_map(flatten)
                    .map(|v| normalize_tag(&v.to_display(tz)))
                    .collect();
                Value::bool(rec.is_some_and(|r| {
                    r.tags.iter().any(|t| {
                        let t = normalize_tag(t);
                        wanted
                            .iter()
                            .any(|w| !w.is_empty() && (t == *w || t.starts_with(&format!("{w}/"))))
                    })
                }))
            }
            "inFolder" => {
                arity(1, 1)?;
                let folder = a[0].to_display(tz);
                let folder = folder.trim_matches('/');
                let file_folder = rec
                    .map(|r| r.folder.clone())
                    .unwrap_or_else(|| FileRecord::new(path).folder);
                let ff = file_folder.trim_matches('/');
                Value::bool(
                    folder.is_empty() || ff == folder || ff.starts_with(&format!("{folder}/")),
                )
            }
            _ => return Err(unknown_method(name, &Value::file(path))),
        })
    }

    fn string_method(
        &mut self,
        s: &str,
        recv: &Value,
        name: &str,
        a: &[Value],
        arity: impl Fn(usize, usize) -> R<()>,
    ) -> R<Value> {
        let tz = self.tz();
        let text = |v: &Value| v.to_display(tz);
        Ok(match name {
            "contains" => {
                arity(1, 1)?;
                Value::bool(s.contains(&text(&a[0])))
            }
            "containsAll" => Value::bool(a.iter().flat_map(flatten).all(|v| s.contains(&text(v)))),
            "containsAny" => Value::bool(a.iter().flat_map(flatten).any(|v| s.contains(&text(v)))),
            "startsWith" => {
                arity(1, 1)?;
                Value::bool(s.starts_with(&text(&a[0])))
            }
            "endsWith" => {
                arity(1, 1)?;
                Value::bool(s.ends_with(&text(&a[0])))
            }
            "lower" => {
                arity(0, 0)?;
                Value::str(s.to_lowercase())
            }
            "upper" => {
                arity(0, 0)?;
                Value::str(s.to_uppercase())
            }
            "title" => {
                arity(0, 0)?;
                let mut out = String::with_capacity(s.len());
                let mut at_start = true;
                for ch in s.chars() {
                    if at_start && ch.is_alphanumeric() {
                        out.extend(ch.to_uppercase());
                        at_start = false;
                    } else {
                        out.push(ch);
                        if ch.is_whitespace() {
                            at_start = true;
                        }
                    }
                }
                Value::str(out)
            }
            "trim" => {
                arity(0, 0)?;
                Value::str(s.trim())
            }
            "reverse" => {
                arity(0, 0)?;
                Value::str(s.chars().rev().collect::<String>())
            }
            "repeat" => {
                arity(1, 1)?;
                let n = expect_number(&a[0], "repeat")?;
                if n < 0.0 || !n.is_finite() {
                    return Err("repeat() count must be a non-negative number".into());
                }
                let n = n.trunc() as usize;
                if s.len().saturating_mul(n) > MAX_STRING {
                    return Err("String is too long".into());
                }
                Value::str(s.repeat(n))
            }
            "slice" => {
                arity(1, 2)?;
                let u = utf16(s);
                let start = expect_opt_number(a.first(), "slice")?;
                let end = expect_opt_number(a.get(1), "slice")?;
                let (st, en) = slice_bounds(u.len(), start, end);
                Value::str(from_utf16(&u[st..en]))
            }
            "split" => {
                arity(1, 2)?;
                let limit = expect_opt_number(a.get(1), "split")?.map(|n| n.max(0.0) as usize);
                let mut parts: Vec<String> = match &a[0] {
                    Value::RegExp { value, flags } => {
                        let re = self.eng.regex(value, flags)?;
                        if s.is_empty() {
                            if re.is_match("") {
                                vec![]
                            } else {
                                vec![String::new()]
                            }
                        } else {
                            re.split(s).map(str::to_string).collect()
                        }
                    }
                    sep => {
                        let sep = text(sep);
                        if sep.is_empty() {
                            s.chars().map(|c| c.to_string()).collect()
                        } else {
                            s.split(sep.as_str()).map(str::to_string).collect()
                        }
                    }
                };
                if let Some(n) = limit {
                    parts.truncate(n);
                }
                Value::list(parts.into_iter().map(Value::str).collect())
            }
            "replace" => {
                arity(2, 2)?;
                let repl = text(&a[1]);
                match &a[0] {
                    Value::RegExp { value, flags } => {
                        let re = self.eng.regex(value, flags)?;
                        let r = translate_replacement(&repl);
                        if flags.contains('g') {
                            Value::str(re.replace_all(s, r.as_str()).into_owned())
                        } else {
                            Value::str(re.replace(s, r.as_str()).into_owned())
                        }
                    }
                    pat => {
                        let pat = text(pat);
                        if pat.is_empty() {
                            Value::str(format!("{repl}{s}"))
                        } else {
                            Value::str(s.replace(pat.as_str(), &repl))
                        }
                    }
                }
            }
            _ => return Err(unknown_method(name, recv)),
        })
    }

    fn list_method(
        &mut self,
        items: &[Value],
        name: &str,
        a: &[Value],
        arity: impl Fn(usize, usize) -> R<()>,
    ) -> R<Value> {
        let tz = self.tz();
        Ok(match name {
            "contains" => {
                arity(1, 1)?;
                Value::bool(items.iter().any(|x| self.loose_eq(x, &a[0])))
            }
            "containsAll" => {
                Value::bool(a.iter().all(|w| items.iter().any(|x| self.loose_eq(x, w))))
            }
            "containsAny" => {
                Value::bool(a.iter().any(|w| items.iter().any(|x| self.loose_eq(x, w))))
            }
            "flat" => {
                arity(0, 1)?;
                let depth = expect_opt_number(a.first(), "flat")?
                    .unwrap_or(1.0)
                    .max(0.0) as usize;
                fn go(v: &[Value], depth: usize, out: &mut Vec<Value>) {
                    for x in v {
                        match x {
                            Value::List { value } if depth > 0 => go(value, depth - 1, out),
                            other => out.push(other.clone()),
                        }
                    }
                }
                let mut out = Vec::new();
                go(items, depth.min(64), &mut out);
                Value::list(out)
            }
            "join" => {
                arity(0, 1)?;
                let sep = a
                    .first()
                    .map(|v| v.to_display(tz))
                    .unwrap_or_else(|| ",".into());
                Value::str(
                    items
                        .iter()
                        .map(|v| {
                            if v.is_null() {
                                String::new()
                            } else {
                                v.to_display(tz)
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(&sep),
                )
            }
            "reverse" => {
                arity(0, 0)?;
                Value::list(items.iter().rev().cloned().collect())
            }
            "sort" => {
                arity(0, 0)?;
                let mut v = items.to_vec();
                v.sort_by(|x, y| sort_cmp(x, y, tz));
                Value::list(v)
            }
            "unique" => {
                arity(0, 0)?;
                let mut out: Vec<Value> = Vec::new();
                for x in items {
                    if !out
                        .iter()
                        .any(|y| y.type_name() == x.type_name() && self.loose_eq(x, y))
                    {
                        out.push(x.clone());
                    }
                }
                Value::list(out)
            }
            "slice" => {
                arity(0, 2)?;
                let start = expect_opt_number(a.first(), "slice")?;
                let end = expect_opt_number(a.get(1), "slice")?;
                let (s, e) = slice_bounds(items.len(), start, end);
                Value::list(items[s..e].to_vec())
            }
            "sum" | "mean" | "average" | "median" | "stddev" => {
                arity(0, 0)?;
                let nums: Vec<f64> = items.iter().filter_map(Value::as_number).collect();
                aggregate(name, &nums)
            }
            "min" | "max" | "earliest" | "latest" => {
                arity(0, 0)?;
                let want_max = name == "max" || name == "latest";
                if name == "earliest"
                    || name == "latest"
                    || items.iter().any(|v| matches!(v, Value::Date { .. }))
                {
                    let dates = items.iter().filter(|v| matches!(v, Value::Date { .. }));
                    let best = if want_max {
                        dates.max_by(|x, y| {
                            date_ms(x)
                                .partial_cmp(&date_ms(y))
                                .unwrap_or(Ordering::Equal)
                        })
                    } else {
                        dates.min_by(|x, y| {
                            date_ms(x)
                                .partial_cmp(&date_ms(y))
                                .unwrap_or(Ordering::Equal)
                        })
                    };
                    best.cloned().unwrap_or(Value::Null)
                } else {
                    let nums: Vec<f64> = items.iter().filter_map(Value::as_number).collect();
                    if nums.is_empty() {
                        Value::Null
                    } else if want_max {
                        Value::num(nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
                    } else {
                        Value::num(nums.iter().cloned().fold(f64::INFINITY, f64::min))
                    }
                }
            }
            _ => return Err(unknown_method(name, &Value::list(vec![]))),
        })
    }
}

pub(crate) fn aggregate(name: &str, nums: &[f64]) -> Value {
    if nums.is_empty() {
        return if name == "sum" {
            Value::num(0.0)
        } else {
            Value::Null
        };
    }
    let n = nums.len() as f64;
    let sum: f64 = nums.iter().sum();
    match name {
        "sum" => Value::num(sum),
        "mean" | "average" => Value::num(sum / n),
        "median" => {
            let mut v = nums.to_vec();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
            let m = v.len() / 2;
            Value::num(if v.len().is_multiple_of(2) {
                (v[m - 1] + v[m]) / 2.0
            } else {
                v[m]
            })
        }
        "stddev" => {
            let mean = sum / n;
            Value::num((nums.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n).sqrt())
        }
        _ => Value::Null,
    }
}

fn date_ms(v: &Value) -> f64 {
    match v {
        Value::Date { value, .. } => *value,
        _ => f64::NAN,
    }
}

fn flatten(v: &Value) -> Vec<&Value> {
    match v {
        Value::List { value } => value.iter().collect(),
        other => vec![other],
    }
}

fn unknown_method(name: &str, recv: &Value) -> String {
    format!("Unknown function \"{name}\" for type {}", recv.type_name())
}

fn op_symbol(op: BinOp) -> &'static str {
    match op {
        BinOp::Mul => "*",
        BinOp::Div => "/",
        BinOp::Mod => "%",
        BinOp::Add => "+",
        BinOp::Sub => "-",
        _ => "operator",
    }
}

fn expect_number(v: &Value, f: &str) -> R<f64> {
    match v {
        Value::Number { value } => Ok(*value),
        other => Err(format!("{f}() expects a number, got {}", other.type_name())),
    }
}

fn expect_opt_number(v: Option<&Value>, f: &str) -> R<Option<f64>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(v) => expect_number(v, f).map(Some),
    }
}

fn duration_of(v: &Value) -> Option<Duration> {
    match v {
        Value::Duration { .. } => v.as_duration(),
        Value::String { value } => datetime::parse_duration(value),
        _ => None,
    }
}

fn is_stringy(v: &Value) -> bool {
    v.string_like().is_some()
}

fn is_numeric_like(v: &Value) -> bool {
    matches!(
        v,
        Value::Number { .. } | Value::Boolean { .. } | Value::Null | Value::Date { .. }
    ) || matches!(v, Value::String { value } if parse_js_number(value.trim()).is_some() || value.trim().is_empty())
}

fn concat_str(v: &Value, tz: i32) -> String {
    if v.is_null() {
        String::new()
    } else {
        v.to_display(tz)
    }
}

/// `Number(x)` for strings, but `""` is not a number.
fn parse_js_number(t: &str) -> Option<f64> {
    if t.is_empty() {
        return None;
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).ok().map(|n| n as f64);
    }
    if t.chars()
        .any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E')
    {
        return None;
    }
    t.parse::<f64>().ok()
}

fn to_js_number(v: &Value) -> f64 {
    match v {
        Value::Number { value } => *value,
        Value::Boolean { value } => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        Value::Date { value, .. } => *value,
        Value::Duration { value, .. } => *value,
        Value::String { value } => {
            let t = value.trim();
            if t.is_empty() {
                0.0
            } else {
                parse_js_number(t).unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn is_blank(v: &Value) -> bool {
    v.is_empty()
}

fn rank(v: &Value) -> u8 {
    match v {
        Value::Number { .. } => 1,
        Value::Duration { .. } => 2,
        Value::Date { .. } => 3,
        Value::Boolean { .. } => 4,
        Value::List { .. } => 6,
        Value::Object { .. } => 7,
        Value::File { .. } => 8,
        v if v.string_like().is_some() => 5,
        _ => 9,
    }
}

/// Total order for sorting rows, groups and `list.sort()`: empty values last,
/// then by type, then numbers numerically, dates chronologically and text
/// naturally (number-aware, case-insensitive).
pub fn sort_cmp(a: &Value, b: &Value, tz: i32) -> Ordering {
    match (is_blank(a), is_blank(b)) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    let (ra, rb) = (rank(a), rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    let num = |x: f64, y: f64| match (x.is_nan(), y.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        _ => x.partial_cmp(&y).unwrap(),
    };
    match (a, b) {
        (Value::Number { value: x }, Value::Number { value: y }) => num(*x, *y),
        (Value::Duration { value: x, .. }, Value::Duration { value: y, .. }) => num(*x, *y),
        (Value::Date { value: x, .. }, Value::Date { value: y, .. }) => num(*x, *y),
        (Value::Boolean { value: x }, Value::Boolean { value: y }) => x.cmp(y),
        (Value::List { value: x }, Value::List { value: y }) => {
            for (p, q) in x.iter().zip(y) {
                let o = sort_cmp(p, q, tz);
                if o != Ordering::Equal {
                    return o;
                }
            }
            x.len().cmp(&y.len())
        }
        _ => natural_cmp(&a.to_display(tz), &b.to_display(tz)),
    }
}
