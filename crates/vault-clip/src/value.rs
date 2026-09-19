//! A JavaScript-shaped value, with JSON and coercion semantics copied from JS.
//!
//! The clipper template language (Knap) is stringly typed in a very specific
//! way: every filter receives `String(value)` or `JSON.stringify(value)`, most
//! filters immediately `JSON.parse` that string back, and object key order is
//! insertion order. Reproducing the output byte for byte therefore needs three
//! things `serde_json::Value` does not give us: ordered objects without
//! turning on a workspace-wide feature, JS number formatting (`1` not `1.0`,
//! `1e-7` not `0.0000001`), and an `undefined` distinct from `null`.
//!
//! String lengths and slices that leak into output (`length`, `slice`) are
//! measured in UTF-16 code units, as JS measures them.

use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value {
    #[default]
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Object(Map),
}

/// An insertion-ordered string-keyed map (a JS plain object).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Map(pub Vec<(String, Value)>);

impl Map {
    pub fn new() -> Map {
        Map(Vec::new())
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }
    pub fn insert(&mut self, key: impl Into<String>, value: Value) {
        let key = key.into();
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            self.0.push((key, value));
        }
    }
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let idx = self.0.iter().position(|(k, _)| k == key)?;
        Some(self.0.remove(idx).1)
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0.iter().map(|(k, v)| (k, v))
    }
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.iter().map(|(k, _)| k)
    }
    pub fn values(&self) -> impl Iterator<Item = &Value> {
        self.0.iter().map(|(_, v)| v)
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Value {
        Value::String(s.to_string())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Value {
        Value::String(s)
    }
}
impl From<f64> for Value {
    fn from(n: f64) -> Value {
        Value::Number(n)
    }
}
impl From<bool> for Value {
    fn from(b: bool) -> Value {
        Value::Bool(b)
    }
}

impl Value {
    pub fn str(s: impl Into<String>) -> Value {
        Value::String(s.into())
    }

    pub fn is_nullish(&self) -> bool {
        matches!(self, Value::Undefined | Value::Null)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn is_collection(&self) -> bool {
        matches!(self, Value::Array(_) | Value::Object(_))
    }

    /// Knap's `isTruthy`: note that `NaN` and `{}` are truthy, `[]` is not.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Undefined | Value::Null => false,
            Value::String(s) => !s.is_empty(),
            Value::Number(n) => *n != 0.0,
            Value::Bool(b) => *b,
            Value::Array(a) => !a.is_empty(),
            Value::Object(_) => true,
        }
    }

    /// JS `String(value)`.
    pub fn js_string(&self) -> String {
        match self {
            Value::Undefined => "undefined".into(),
            Value::Null => "null".into(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => js_number(*n),
            Value::String(s) => s.clone(),
            Value::Array(items) => items
                .iter()
                .map(|v| match v {
                    Value::Undefined | Value::Null => String::new(),
                    other => other.js_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
            Value::Object(_) => "[object Object]".into(),
        }
    }

    /// JS `JSON.stringify(value)`; `None` for a top-level `undefined`.
    pub fn to_json(&self) -> Option<String> {
        if matches!(self, Value::Undefined) {
            return None;
        }
        let mut out = String::new();
        write_json(self, &mut out, None, 0);
        Some(out)
    }

    /// `JSON.stringify(value) ?? ''`.
    pub fn to_json_string(&self) -> String {
        self.to_json().unwrap_or_default()
    }

    /// `JSON.stringify(value, null, indent)`.
    pub fn to_json_pretty(&self, indent: usize) -> String {
        let mut out = String::new();
        write_json(self, &mut out, Some(indent), 0);
        out
    }

    /// JS `Number(value)` (ToNumber).
    pub fn to_number(&self) -> f64 {
        match self {
            Value::Undefined => f64::NAN,
            Value::Null => 0.0,
            Value::Bool(b) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
            Value::Number(n) => *n,
            Value::String(s) => string_to_number(s),
            Value::Array(_) => string_to_number(&self.js_string()),
            Value::Object(_) => f64::NAN,
        }
    }

    /// JS abstract equality `==`.
    pub fn loose_eq(&self, other: &Value) -> bool {
        use Value::*;
        match (self, other) {
            (Undefined | Null, Undefined | Null) => true,
            (Undefined | Null, _) | (_, Undefined | Null) => false,
            (Number(a), Number(b)) => a == b,
            (String(a), String(b)) => a == b,
            (Bool(a), Bool(b)) => a == b,
            (Array(_) | Object(_), Array(_) | Object(_)) => std::ptr::eq(self, other),
            (Bool(_), _) => Number(self.to_number()).loose_eq(other),
            (_, Bool(_)) => self.loose_eq(&Number(other.to_number())),
            (Number(a), String(_)) => *a == other.to_number(),
            (String(_), Number(b)) => self.to_number() == *b,
            (Array(_) | Object(_), _) => String(self.js_string()).loose_eq(other),
            (_, Array(_) | Object(_)) => self.loose_eq(&String(other.js_string())),
        }
    }

    /// JS relational comparison; `None` when the answer is `undefined` (NaN).
    pub fn js_compare(&self, other: &Value) -> Option<std::cmp::Ordering> {
        let prim = |v: &Value| match v {
            Value::Array(_) | Value::Object(_) => Value::String(v.js_string()),
            other => other.clone(),
        };
        let (a, b) = (prim(self), prim(other));
        if let (Value::String(x), Value::String(y)) = (&a, &b) {
            let xu: Vec<u16> = x.encode_utf16().collect();
            let yu: Vec<u16> = y.encode_utf16().collect();
            return Some(xu.cmp(&yu));
        }
        let (x, y) = (a.to_number(), b.to_number());
        x.partial_cmp(&y)
    }

    pub fn parse_json(input: &str) -> Option<Value> {
        let mut p = JsonParser {
            s: input.as_bytes(),
            src: input,
            i: 0,
            depth: 0,
        };
        p.ws();
        let v = p.value()?;
        p.ws();
        if p.i != p.s.len() {
            return None;
        }
        Some(v)
    }

    /// Convert from serde_json (object order is whatever serde_json kept).
    pub fn from_serde(v: &serde_json::Value) -> Value {
        match v {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(b) => Value::Bool(*b),
            serde_json::Value::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
            serde_json::Value::String(s) => Value::String(s.clone()),
            serde_json::Value::Array(a) => Value::Array(a.iter().map(Value::from_serde).collect()),
            serde_json::Value::Object(o) => Value::Object(Map(o
                .iter()
                .map(|(k, v)| (k.clone(), Value::from_serde(v)))
                .collect())),
        }
    }

    pub fn to_serde(&self) -> serde_json::Value {
        match self {
            Value::Undefined | Value::Null => serde_json::Value::Null,
            Value::Bool(b) => serde_json::Value::Bool(*b),
            Value::Number(n) => serde_json::Number::from_f64(*n)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null),
            Value::String(s) => serde_json::Value::String(s.clone()),
            Value::Array(a) => serde_json::Value::Array(a.iter().map(|v| v.to_serde()).collect()),
            Value::Object(m) => serde_json::Value::Object(
                m.iter().map(|(k, v)| (k.clone(), v.to_serde())).collect(),
            ),
        }
    }
}

impl serde::Serialize for Value {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap, SerializeSeq};
        match self {
            Value::Undefined | Value::Null => ser.serialize_unit(),
            Value::Bool(b) => ser.serialize_bool(*b),
            Value::Number(n) => {
                if n.fract() == 0.0 && n.abs() < 9e15 {
                    ser.serialize_i64(*n as i64)
                } else if n.is_finite() {
                    ser.serialize_f64(*n)
                } else {
                    ser.serialize_unit()
                }
            }
            Value::String(s) => ser.serialize_str(s),
            Value::Array(a) => {
                let mut seq = ser.serialize_seq(Some(a.len()))?;
                for v in a {
                    seq.serialize_element(v)?;
                }
                seq.end()
            }
            Value::Object(m) => {
                let mut map = ser.serialize_map(Some(m.len()))?;
                for (k, v) in m.iter() {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> serde::Deserialize<'de> for Value {
    fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Value, D::Error> {
        let v = serde_json::Value::deserialize(de)?;
        Ok(Value::from_serde(&v))
    }
}

fn write_json(v: &Value, out: &mut String, indent: Option<usize>, level: usize) {
    let nl = |out: &mut String, level: usize| {
        if let Some(n) = indent {
            if n > 0 {
                out.push('\n');
                out.push_str(&" ".repeat(n * level));
            }
        }
    };
    let pretty = indent.is_some_and(|n| n > 0);
    match v {
        Value::Undefined | Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if n.is_finite() {
                out.push_str(&js_number(*n))
            } else {
                out.push_str("null")
            }
        }
        Value::String(s) => json_quote(s, out),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                nl(out, level + 1);
                write_json(item, out, indent, level + 1);
            }
            nl(out, level);
            out.push(']');
        }
        Value::Object(map) => {
            let entries: Vec<_> = map
                .iter()
                .filter(|(_, v)| !matches!(v, Value::Undefined))
                .collect();
            if entries.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, item)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                nl(out, level + 1);
                json_quote(k, out);
                out.push(':');
                if pretty {
                    out.push(' ');
                }
                write_json(item, out, indent, level + 1);
            }
            nl(out, level);
            out.push('}');
        }
    }
}

/// JSON string quoting exactly as `JSON.stringify` does it.
pub fn json_quote(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn json_quoted(s: &str) -> String {
    let mut out = String::new();
    json_quote(s, &mut out);
    out
}

/// JS `Number.prototype.toString()` for any f64.
pub fn js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let neg = n < 0.0;
    // Rust's `{:e}` gives the shortest round-tripping digits.
    let sci = format!("{:e}", n.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let e = exp + 1; // position of the decimal point relative to digits
    let mut s = String::new();
    if neg {
        s.push('-');
    }
    if k <= e && e <= 21 {
        s.push_str(&digits);
        s.push_str(&"0".repeat((e - k) as usize));
    } else if 0 < e && e <= 21 {
        s.push_str(&digits[..e as usize]);
        s.push('.');
        s.push_str(&digits[e as usize..]);
    } else if -6 < e && e <= 0 {
        s.push_str("0.");
        s.push_str(&"0".repeat((-e) as usize));
        s.push_str(&digits);
    } else {
        s.push_str(&digits[..1]);
        if k > 1 {
            s.push('.');
            s.push_str(&digits[1..]);
        }
        s.push('e');
        let x = e - 1;
        s.push(if x < 0 { '-' } else { '+' });
        s.push_str(&x.abs().to_string());
    }
    s
}

/// JS ToNumber applied to a string.
pub fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return u64::from_str_radix(rest, radix)
                .map(|v| v as f64)
                .unwrap_or(f64::NAN);
        }
    }
    let valid = t
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'));
    if !valid || t.contains("inf") {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// JS `parseFloat`: the longest numeric prefix.
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    if t.starts_with("Infinity") || t.starts_with("+Infinity") {
        return f64::INFINITY;
    }
    if t.starts_with("-Infinity") {
        return f64::NEG_INFINITY;
    }
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut had_digits = i > int_start;
    if i < b.len() && b[i] == b'.' {
        let j = i + 1;
        let mut k = j;
        while k < b.len() && b[k].is_ascii_digit() {
            k += 1;
        }
        if k > j || had_digits {
            had_digits = had_digits || k > j;
            i = k;
        }
    }
    if !had_digits {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut k = i + 1;
        if k < b.len() && (b[k] == b'+' || b[k] == b'-') {
            k += 1;
        }
        let ds = k;
        while k < b.len() && b[k].is_ascii_digit() {
            k += 1;
        }
        if k > ds {
            i = k;
        }
    }
    t[..i].parse::<f64>().unwrap_or(f64::NAN)
}

/// JS `parseInt(s, 10)`.
pub fn parse_int(s: &str) -> Option<i64> {
    let t = s.trim_start();
    let b = t.as_bytes();
    let mut i = 0;
    let neg = if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
        b[0] == b'-'
    } else {
        false
    };
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    let v: i64 = t[start..i.min(start + 18)].parse().ok()?;
    Some(if neg { -v } else { v })
}

pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `String.prototype.slice(start, end)` on UTF-16 units.
pub fn utf16_slice(s: &str, start: Option<i64>, end: Option<i64>) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let (a, b) = slice_bounds(units.len(), start, end);
    if a >= b {
        return String::new();
    }
    String::from_utf16_lossy(&units[a..b])
}

/// Resolve JS slice indices (negative from the end, clamped).
pub fn slice_bounds(len: usize, start: Option<i64>, end: Option<i64>) -> (usize, usize) {
    let len_i = len as i64;
    let norm = |v: i64| -> usize {
        if v < 0 {
            (len_i + v).max(0) as usize
        } else {
            v.min(len_i) as usize
        }
    };
    let a = start.map(norm).unwrap_or(0);
    let b = end.map(norm).unwrap_or(len);
    (a, b)
}

struct JsonParser<'a> {
    s: &'a [u8],
    src: &'a str,
    i: usize,
    depth: usize,
}

impl JsonParser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn value(&mut self) -> Option<Value> {
        self.depth += 1;
        if self.depth > 512 {
            return None;
        }
        let r = self.value_inner();
        self.depth -= 1;
        r
    }

    fn value_inner(&mut self) -> Option<Value> {
        match *self.s.get(self.i)? {
            b'{' => {
                self.i += 1;
                let mut map = Map::new();
                self.ws();
                if self.s.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Some(Value::Object(map));
                }
                loop {
                    self.ws();
                    if self.s.get(self.i) != Some(&b'"') {
                        return None;
                    }
                    let k = self.string()?;
                    self.ws();
                    if self.s.get(self.i) != Some(&b':') {
                        return None;
                    }
                    self.i += 1;
                    self.ws();
                    let v = self.value()?;
                    map.insert(k, v);
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Some(Value::Object(map));
                        }
                        _ => return None,
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Some(Value::Array(items));
                }
                loop {
                    self.ws();
                    items.push(self.value()?);
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Some(Value::Array(items));
                        }
                        _ => return None,
                    }
                }
            }
            b'"' => self.string().map(Value::String),
            b't' => self.lit("true", Value::Bool(true)),
            b'f' => self.lit("false", Value::Bool(false)),
            b'n' => self.lit("null", Value::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        }
    }

    fn lit(&mut self, word: &str, v: Value) -> Option<Value> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Some(v)
        } else {
            None
        }
    }

    fn number(&mut self) -> Option<Value> {
        let start = self.i;
        if self.s[self.i] == b'-' {
            self.i += 1;
        }
        let int_start = self.i;
        while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
            self.i += 1;
        }
        let int_len = self.i - int_start;
        if int_len == 0 || (int_len > 1 && self.s[int_start] == b'0') {
            return None;
        }
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            let fs = self.i;
            while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
                self.i += 1;
            }
            if self.i == fs {
                return None;
            }
        }
        if matches!(self.s.get(self.i), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            let es = self.i;
            while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
                self.i += 1;
            }
            if self.i == es {
                return None;
            }
        }
        self.src[start..self.i].parse::<f64>().ok().map(Value::Number)
    }

    fn string(&mut self) -> Option<String> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len() && self.s[self.i] != b'"' && self.s[self.i] != b'\\' {
                if self.s[self.i] < 0x20 {
                    return None;
                }
                self.i += 1;
            }
            out.push_str(&self.src[start..self.i]);
            match self.s.get(self.i)? {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                _ => {
                    self.i += 1;
                    let c = *self.s.get(self.i)?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            if (0xD800..0xDC00).contains(&hi)
                                && self.s.get(self.i) == Some(&b'\\')
                                && self.s.get(self.i + 1) == Some(&b'u')
                            {
                                let save = self.i;
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    let cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                                    out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                                    continue;
                                }
                                self.i = save;
                            }
                            out.push(char::from_u32(hi).unwrap_or('\u{fffd}'));
                        }
                        _ => return None,
                    }
                }
            }
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        let h = self.src.get(self.i..self.i + 4)?;
        let v = u32::from_str_radix(h, 16).ok()?;
        self.i += 4;
        Some(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_number_formatting_matches_v8() {
        assert_eq!(js_number(1.0), "1");
        assert_eq!(js_number(-2.5), "-2.5");
        assert_eq!(js_number(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1e20), "100000000000000000000");
        assert_eq!(js_number(1e-7), "1e-7");
        assert_eq!(js_number(0.000001), "0.000001");
        assert_eq!(js_number(123456.789), "123456.789");
        assert_eq!(js_number(f64::NAN), "NaN");
    }

    #[test]
    fn json_round_trip_keeps_key_order_and_js_spacing() {
        let v = Value::parse_json(r#"{"b":1,"a":[true,null,"x\n"],"c":{"d":1.5}}"#).unwrap();
        assert_eq!(v.to_json().unwrap(), r#"{"b":1,"a":[true,null,"x\n"],"c":{"d":1.5}}"#);
        assert_eq!(
            Value::parse_json("[1,2]").unwrap().to_json_pretty(2),
            "[\n  1,\n  2\n]"
        );
    }

    #[test]
    fn json_parse_rejects_what_js_rejects() {
        assert!(Value::parse_json("{'a':1}").is_none());
        assert!(Value::parse_json("[1,]").is_none());
        assert!(Value::parse_json("01").is_none());
        assert!(Value::parse_json("hello").is_none());
        assert_eq!(Value::parse_json(" 12 "), Some(Value::Number(12.0)));
        assert_eq!(
            Value::parse_json(r#""😀""#),
            Some(Value::String("😀".into()))
        );
    }

    #[test]
    fn coercions_follow_js() {
        assert_eq!(Value::Array(vec![1.0.into(), Value::Null, "a".into()]).js_string(), "1,,a");
        assert!(Value::Number(1.0).loose_eq(&Value::from("1")));
        assert!(Value::Null.loose_eq(&Value::Undefined));
        assert!(!Value::Null.loose_eq(&Value::Number(0.0)));
        assert!(Value::Bool(true).loose_eq(&Value::from("1")));
        assert_eq!(string_to_number(" 0x1F "), 31.0);
        assert!(string_to_number("12px").is_nan());
        assert_eq!(parse_float("12.5px"), 12.5);
        assert_eq!(parse_int("  -42abc"), Some(-42));
        assert!(!Value::Array(vec![]).truthy());
        assert!(Value::Object(Map::new()).truthy());
    }

    #[test]
    fn utf16_slicing_counts_surrogates() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_slice("hello", Some(-3), None), "llo");
        assert_eq!(utf16_slice("hello", Some(1), Some(3)), "el");
    }
}
