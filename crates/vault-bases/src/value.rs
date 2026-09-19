//! The value model, mirroring the `Value` class hierarchy in `obsidian.d.ts`.
//!
//! ```text
//! Value
//! ├── NullValue                         {"type":"null"}
//! └── NotNullValue
//!     ├── PrimitiveValue
//!     │   ├── BooleanValue              {"type":"boolean","value":true}
//!     │   ├── NumberValue               {"type":"number","value":3.5}
//!     │   └── StringValue               {"type":"string","value":"x"}
//!     │       ├── LinkValue             {"type":"link","value":"Note","display":Value?}
//!     │       ├── HTMLValue             {"type":"html","value":"<b>x</b>"}
//!     │       ├── IconValue             {"type":"icon","value":"arrow-right"}
//!     │       ├── ImageValue            {"type":"image","value":"cover.png"}
//!     │       ├── TagValue              {"type":"tag","value":"#book"}
//!     │       └── UrlValue              {"type":"url","value":"https://…"}
//!     ├── DateValue                     {"type":"date","value":ms,"time":bool}
//!     ├── DurationValue                 {"type":"duration","value":ms,"months":0,"days":1,"milliseconds":0}
//!     ├── ListValue                     {"type":"list","value":[Value…]}
//!     ├── ObjectValue                   {"type":"object","value":{"k":Value…}}
//!     ├── FileValue                     {"type":"file","value":"path/to/file.md"}
//!     └── RegExpValue                   {"type":"regexp","value":"source","flags":"gi"}
//! ErrorValue (returned by BasesEntry.getValue on failure)
//!                                       {"type":"error","message":"…"}
//! ```
//!
//! Non-finite numbers serialise as the strings `"NaN"`, `"Infinity"` and
//! `"-Infinity"` because JSON has no spelling for them.

use crate::datetime::{self, Duration};
use serde::de::{Deserializer, MapAccess, Visitor};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fmt;

/// An insertion-ordered string map. JavaScript objects keep insertion order,
/// and `.base` files are diffed by humans, so neither end wants a sorted map.
#[derive(Clone, Debug, PartialEq)]
pub struct OrderedMap<V>(pub Vec<(String, V)>);

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        OrderedMap(Vec::new())
    }
}

impl<V> OrderedMap<V> {
    pub fn new() -> Self {
        OrderedMap(Vec::new())
    }
    pub fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn insert(&mut self, key: impl Into<String>, value: V) {
        let key = key.into();
        if let Some(slot) = self.get_mut(&key) {
            *slot = value;
        } else {
            self.0.push((key, value));
        }
    }
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let i = self.0.iter().position(|(k, _)| k == key)?;
        Some(self.0.remove(i).1)
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.0.iter().map(|(k, v)| (k, v))
    }
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.iter().map(|(k, _)| k)
    }
}

impl<V: Serialize> Serialize for OrderedMap<V> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for OrderedMap<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V2<V>(std::marker::PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for V2<V> {
            type Value = OrderedMap<V>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a map")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut out = OrderedMap::new();
                while let Some((k, v)) = a.next_entry::<String, V>()? {
                    out.insert(k, v);
                }
                Ok(out)
            }
        }
        d.deserialize_map(V2(std::marker::PhantomData))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Value {
    Null,
    Boolean {
        value: bool,
    },
    Number {
        #[serde(with = "js_number")]
        value: f64,
    },
    String {
        value: String,
    },
    Link {
        /// The link target as written (`Note`, `folder/Note.md`, `https://…`).
        value: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        display: Option<Box<Value>>,
    },
    Html {
        value: String,
    },
    Icon {
        value: String,
    },
    Image {
        value: String,
    },
    Tag {
        value: String,
    },
    Url {
        value: String,
    },
    Date {
        #[serde(with = "js_number")]
        value: f64,
        /// false for a date-only value (`2025-01-31`, `today()`, `date.date()`).
        time: bool,
    },
    Duration {
        /// Total milliseconds (moment's `asMilliseconds()`).
        #[serde(with = "js_number")]
        value: f64,
        months: f64,
        days: f64,
        milliseconds: f64,
    },
    List {
        value: Vec<Value>,
    },
    Object {
        value: OrderedMap<Value>,
    },
    File {
        /// Vault path of the file.
        value: String,
    },
    #[serde(rename = "regexp")]
    RegExp {
        value: String,
        flags: String,
    },
    Error {
        message: String,
    },
}

mod js_number {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        if v.is_nan() {
            s.serialize_str("NaN")
        } else if v.is_infinite() {
            s.serialize_str(if *v > 0.0 { "Infinity" } else { "-Infinity" })
        } else {
            s.serialize_f64(*v)
        }
    }
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum N {
        F(f64),
        S(String),
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        Ok(match N::deserialize(d)? {
            N::F(f) => f,
            N::S(s) => match s.as_str() {
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                _ => f64::NAN,
            },
        })
    }
}

impl Value {
    pub fn str(s: impl Into<String>) -> Value {
        Value::String { value: s.into() }
    }
    pub fn num(n: f64) -> Value {
        Value::Number { value: n }
    }
    pub fn bool(b: bool) -> Value {
        Value::Boolean { value: b }
    }
    pub fn list(v: Vec<Value>) -> Value {
        Value::List { value: v }
    }
    pub fn date(ms: f64, time: bool) -> Value {
        Value::Date { value: ms, time }
    }
    pub fn link(path: impl Into<String>) -> Value {
        Value::Link {
            value: path.into(),
            display: None,
        }
    }
    pub fn file(path: impl Into<String>) -> Value {
        Value::File { value: path.into() }
    }
    pub fn error(message: impl Into<String>) -> Value {
        Value::Error {
            message: message.into(),
        }
    }
    pub fn duration(d: Duration) -> Value {
        Value::Duration {
            value: d.total_ms(),
            months: d.months,
            days: d.days,
            milliseconds: d.ms,
        }
    }

    pub fn as_duration(&self) -> Option<Duration> {
        match self {
            Value::Duration {
                months,
                days,
                milliseconds,
                ..
            } => Some(Duration {
                months: *months,
                days: *days,
                ms: *milliseconds,
            }),
            _ => None,
        }
    }

    /// Lower-case type name as accepted by `isType()`.
    pub fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Boolean { .. } => "boolean",
            Value::Number { .. } => "number",
            Value::String { .. } => "string",
            Value::Link { .. } => "link",
            Value::Html { .. } => "html",
            Value::Icon { .. } => "icon",
            Value::Image { .. } => "image",
            Value::Tag { .. } => "tag",
            Value::Url { .. } => "url",
            Value::Date { .. } => "date",
            Value::Duration { .. } => "duration",
            Value::List { .. } => "list",
            Value::Object { .. } => "object",
            Value::File { .. } => "file",
            Value::RegExp { .. } => "regexp",
            Value::Error { .. } => "error",
        }
    }

    /// `value.isType(name)`: case-insensitive, and the StringValue subclasses
    /// (link, html, icon, image, tag, url) also answer to `"string"`.
    pub fn is_type(&self, name: &str) -> bool {
        let n = name.to_ascii_lowercase();
        let n = match n.as_str() {
            "text" => "string",
            "array" => "list",
            "bool" | "checkbox" => "boolean",
            "regex" => "regexp",
            other => other,
        };
        n == self.type_name() || (n == "string" && self.string_like().is_some())
    }

    /// The text of a StringValue or any of its subclasses.
    pub fn string_like(&self) -> Option<&str> {
        match self {
            Value::String { value }
            | Value::Link { value, .. }
            | Value::Html { value }
            | Value::Icon { value }
            | Value::Image { value }
            | Value::Tag { value }
            | Value::Url { value } => Some(value),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn is_error(&self) -> bool {
        matches!(self, Value::Error { .. })
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number { value } => Some(*value),
            _ => None,
        }
    }

    /// `isTruthy()`.
    pub fn is_truthy(&self) -> bool {
        match self {
            Value::Null | Value::Error { .. } => false,
            Value::Boolean { value } => *value,
            Value::Number { value } => *value != 0.0 && !value.is_nan(),
            Value::Date { value, .. } => value.is_finite(),
            Value::Duration { value, .. } => *value != 0.0,
            Value::List { value } => !value.is_empty(),
            Value::Object { value } => !value.is_empty(),
            Value::File { .. } | Value::RegExp { .. } => true,
            Value::Link { value, .. } => !value.is_empty(),
            other => !other.string_like().unwrap_or("").is_empty(),
        }
    }

    /// `isEmpty()`: missing, `""`, `[]` or `{}`.
    pub fn is_empty(&self) -> bool {
        match self {
            Value::Null => true,
            Value::List { value } => value.is_empty(),
            Value::Object { value } => value.is_empty(),
            other => other.string_like().is_some_and(str::is_empty),
        }
    }

    /// `toString()` with the given timezone for dates.
    pub fn to_display(&self, tz_min: i32) -> String {
        match self {
            Value::Null => "null".into(),
            Value::Boolean { value } => value.to_string(),
            Value::Number { value } => js_number_to_string(*value),
            Value::Link { value, display } => match display {
                Some(d) => d.to_display(tz_min),
                None => value.clone(),
            },
            Value::Date { value, time } => {
                if !value.is_finite() {
                    "Invalid date".into()
                } else if *time {
                    datetime::format_date(*value, "YYYY-MM-DD HH:mm", tz_min)
                } else {
                    datetime::format_date(*value, "YYYY-MM-DD", tz_min)
                }
            }
            Value::Duration { .. } => self.as_duration().unwrap().humanize(),
            Value::List { value } => value
                .iter()
                .map(|v| v.to_display(tz_min))
                .collect::<Vec<_>>()
                .join(", "),
            Value::Object { .. } => {
                let mut out = String::new();
                write_json(self, tz_min, &mut out);
                out
            }
            Value::File { value } => value.clone(),
            Value::RegExp { value, flags } => format!("/{value}/{flags}"),
            Value::Error { message } => message.clone(),
            other => other.string_like().unwrap_or("").to_string(),
        }
    }
}

/// `JSON.stringify` of the plain form of a value (dates and other rich values
/// as their display strings), keeping object key order.
fn write_json(v: &Value, tz_min: i32, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Boolean { value } => out.push_str(if *value { "true" } else { "false" }),
        Value::Number { value } if value.is_finite() => out.push_str(&js_number_to_string(*value)),
        Value::Number { .. } => out.push_str("null"),
        Value::List { value } => {
            out.push('[');
            for (i, x) in value.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(x, tz_min, out);
            }
            out.push(']');
        }
        Value::Object { value } => {
            out.push('{');
            for (i, (k, x)) in value.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap());
                out.push(':');
                write_json(x, tz_min, out);
            }
            out.push('}');
        }
        other => out.push_str(&serde_json::to_string(&other.to_display(tz_min)).unwrap()),
    }
}

/// JavaScript's `Number.prototype.toString()`.
pub fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x == 0.0 {
        return "0".into();
    }
    let neg = x < 0.0;
    // Rust's `{:e}` yields the shortest round-trip digits, like JS.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp + 1;
    let body = if k <= n && n <= 21 {
        format!("{}{}", digits, "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{}e{}{}", digits, sign, e.abs())
        } else {
            format!("{}.{}e{}{}", &digits[..1], &digits[1..], sign, e.abs())
        }
    };
    if neg {
        format!("-{body}")
    } else {
        body
    }
}

/// JavaScript's `Number.prototype.toFixed(digits)` (ties round away from zero).
pub fn js_to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return js_number_to_string(x);
    }
    if x.abs() >= 1e21 {
        return js_number_to_string(x);
    }
    let digits = digits.min(100);
    let exact = format!("{:.*}", digits + 30, x.abs());
    let (int_part, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let keep = &frac[..digits];
    let tail = &frac[digits..];
    let round_up = match tail.as_bytes().first() {
        Some(b'5') => true, // ≥ half: an exact tie rounds up in JS, and "5…" beyond a tie is above half
        Some(c) => *c > b'5',
        None => false,
    };
    let mut num: Vec<u8> = format!("{int_part}{keep}").into_bytes();
    if round_up {
        let mut i = num.len();
        loop {
            if i == 0 {
                num.insert(0, b'1');
                break;
            }
            i -= 1;
            if num[i] == b'9' {
                num[i] = b'0';
            } else {
                num[i] += 1;
                break;
            }
        }
    }
    let s = String::from_utf8(num).unwrap();
    let split = s.len() - digits;
    let mut out = if digits == 0 {
        s.clone()
    } else {
        format!("{}.{}", &s[..split], &s[split..])
    };
    if x < 0.0 {
        out.insert(0, '-');
    }
    out
}

/// Strip a leading `#` and lower-case, for tag comparison.
pub fn normalize_tag(t: &str) -> String {
    t.trim().trim_start_matches('#').to_lowercase()
}

/// Natural, number-aware, case-insensitive string comparison (like
/// `localeCompare(b, undefined, {numeric: true, sensitivity: "base"})`).
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    fn chunks(s: &str) -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for ch in s.chars() {
            let d = ch.is_ascii_digit();
            match out.last_mut() {
                Some((kind, buf)) if *kind == d => buf.push(ch),
                _ => out.push((d, ch.to_string())),
            }
        }
        out
    }
    let ca = chunks(a);
    let cb = chunks(b);
    for (x, y) in ca.iter().zip(cb.iter()) {
        let ord = match (x.0, y.0) {
            (true, true) => {
                let xs = x.1.trim_start_matches('0');
                let ys = y.1.trim_start_matches('0');
                xs.len().cmp(&ys.len()).then_with(|| xs.cmp(ys))
            }
            _ => x.1.to_lowercase().cmp(&y.1.to_lowercase()),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    ca.len().cmp(&cb.len()).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_numbers() {
        assert_eq!(js_number_to_string(1.0), "1");
        assert_eq!(js_number_to_string(-2.5), "-2.5");
        assert_eq!(js_number_to_string(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(
            js_number_to_string(123456789012345680000.0),
            "123456789012345680000"
        );
        assert_eq!(js_number_to_string(0.000001), "0.000001");
        assert_eq!(js_number_to_string(1e-7), "1e-7");
        assert_eq!(js_number_to_string(1.5e-10), "1.5e-10");
        assert_eq!(js_number_to_string(f64::INFINITY), "Infinity");
        assert_eq!(js_number_to_string(-0.0), "0");
        assert_eq!(js_number_to_string(86400000.0), "86400000");
    }

    #[test]
    fn js_fixed() {
        assert_eq!(js_to_fixed(1.23456, 2), "1.23");
        assert_eq!(js_to_fixed(2.5, 0), "3");
        assert_eq!(js_to_fixed(1.005, 2), "1.00"); // binary 1.00499…
        assert_eq!(js_to_fixed(1.45, 1), "1.4"); // binary 1.4499…
        assert_eq!(js_to_fixed(0.125, 2), "0.13"); // exact tie
        assert_eq!(js_to_fixed(9.999, 2), "10.00");
        assert_eq!(js_to_fixed(-1.5, 0), "-2");
        assert_eq!(js_to_fixed(-0.0001, 2), "-0.00");
        assert_eq!(js_to_fixed(42.0, 3), "42.000");
    }

    #[test]
    fn serialises_with_type_tags() {
        let v = Value::list(vec![
            Value::date(1000.0, false),
            Value::num(f64::INFINITY),
            Value::Link {
                value: "Note".into(),
                display: Some(Box::new(Value::Icon {
                    value: "plus".into(),
                })),
            },
            Value::Null,
        ]);
        let j = serde_json::to_string(&v).unwrap();
        assert_eq!(
            j,
            r#"{"type":"list","value":[{"type":"date","value":1000.0,"time":false},{"type":"number","value":"Infinity"},{"type":"link","value":"Note","display":{"type":"icon","value":"plus"}},{"type":"null"}]}"#
        );
        let back: Value = serde_json::from_str(&j).unwrap();
        assert_eq!(back, v);
        let mut m = OrderedMap::new();
        m.insert("z", Value::num(1.0));
        m.insert(
            "a",
            Value::RegExp {
                value: "a+".into(),
                flags: "g".into(),
            },
        );
        let o = Value::Object { value: m };
        let j = serde_json::to_string(&o).unwrap();
        assert_eq!(
            j,
            r#"{"type":"object","value":{"z":{"type":"number","value":1.0},"a":{"type":"regexp","value":"a+","flags":"g"}}}"#
        );
        assert_eq!(serde_json::from_str::<Value>(&j).unwrap(), o);
    }

    #[test]
    fn truthiness_and_emptiness() {
        assert!(!Value::Null.is_truthy());
        assert!(!Value::num(0.0).is_truthy());
        assert!(Value::num(-1.0).is_truthy());
        assert!(!Value::str("").is_truthy());
        assert!(!Value::list(vec![]).is_truthy());
        assert!(Value::list(vec![Value::Null]).is_truthy());
        assert!(Value::Null.is_empty());
        assert!(!Value::num(5.0).is_empty());
        assert!(Value::str("").is_empty());
        assert!(!Value::date(0.0, false).is_empty());
    }

    #[test]
    fn type_names() {
        assert!(Value::link("x").is_type("string"));
        assert!(Value::link("x").is_type("Link"));
        assert!(!Value::str("x").is_type("link"));
        assert!(Value::Null.is_type("null"));
        assert!(Value::bool(true).is_type("boolean"));
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["Book 10", "book 2", "Book 1", "apple", "Zebra"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["apple", "Book 1", "book 2", "Book 10", "Zebra"]);
    }
}
