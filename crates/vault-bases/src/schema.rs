//! The `.base` file format: parse, model and serialise.
//!
//! Unknown keys at the top level, inside `properties.*` and inside each view
//! are kept in `extra` and written back in their original position, so a
//! plugin's custom view settings survive a round trip.

use crate::error::{utf16_len, BaseError, ErrorKind};
use crate::expr::parse_expression;
use crate::value::{js_number_to_string, OrderedMap};
use serde::de::{Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use std::fmt;
use yaml_rust2::{Yaml, YamlLoader};

/// Order-preserving YAML data, used for keys this crate does not model.
#[derive(Clone, Debug, PartialEq)]
pub enum YamlValue {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
    List(Vec<YamlValue>),
    Map(OrderedMap<YamlValue>),
}

impl Serialize for YamlValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            YamlValue::Null => s.serialize_unit(),
            YamlValue::Bool(b) => s.serialize_bool(*b),
            YamlValue::Int(i) => s.serialize_i64(*i),
            YamlValue::Float(f) => s.serialize_f64(*f),
            YamlValue::String(x) => s.serialize_str(x),
            YamlValue::List(v) => {
                let mut seq = s.serialize_seq(Some(v.len()))?;
                for x in v {
                    seq.serialize_element(x)?;
                }
                seq.end()
            }
            YamlValue::Map(m) => {
                let mut map = s.serialize_map(Some(m.len()))?;
                for (k, v) in m.iter() {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for YamlValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = YamlValue;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("any YAML value")
            }
            fn visit_unit<E>(self) -> Result<YamlValue, E> {
                Ok(YamlValue::Null)
            }
            fn visit_none<E>(self) -> Result<YamlValue, E> {
                Ok(YamlValue::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<YamlValue, E> {
                Ok(YamlValue::Bool(b))
            }
            fn visit_i64<E>(self, i: i64) -> Result<YamlValue, E> {
                Ok(YamlValue::Int(i))
            }
            fn visit_u64<E>(self, i: u64) -> Result<YamlValue, E> {
                Ok(i64::try_from(i)
                    .map(YamlValue::Int)
                    .unwrap_or(YamlValue::Float(i as f64)))
            }
            fn visit_f64<E>(self, f: f64) -> Result<YamlValue, E> {
                Ok(YamlValue::Float(f))
            }
            fn visit_str<E>(self, s: &str) -> Result<YamlValue, E> {
                Ok(YamlValue::String(s.to_string()))
            }
            fn visit_string<E>(self, s: String) -> Result<YamlValue, E> {
                Ok(YamlValue::String(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<YamlValue, A::Error> {
                let mut v = Vec::new();
                while let Some(x) = a.next_element()? {
                    v.push(x);
                }
                Ok(YamlValue::List(v))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<YamlValue, A::Error> {
                let mut m = OrderedMap::new();
                while let Some((k, v)) = a.next_entry::<String, YamlValue>()? {
                    m.insert(k, v);
                }
                Ok(YamlValue::Map(m))
            }
        }
        d.deserialize_any(V)
    }
}

impl YamlValue {
    fn from_yaml(y: &Yaml) -> YamlValue {
        match y {
            Yaml::Real(s) => s
                .parse::<f64>()
                .ok()
                .or(match s.as_str() {
                    ".inf" | ".Inf" | ".INF" | "+.inf" => Some(f64::INFINITY),
                    "-.inf" | "-.Inf" | "-.INF" => Some(f64::NEG_INFINITY),
                    _ => None,
                })
                .map(YamlValue::Float)
                .unwrap_or_else(|| YamlValue::String(s.clone())),
            Yaml::Integer(i) => YamlValue::Int(*i),
            Yaml::String(s) => YamlValue::String(s.clone()),
            Yaml::Boolean(b) => YamlValue::Bool(*b),
            Yaml::Array(a) => YamlValue::List(a.iter().map(YamlValue::from_yaml).collect()),
            Yaml::Hash(h) => {
                let mut m = OrderedMap::new();
                for (k, v) in h {
                    m.insert(
                        YamlValue::from_yaml(k).scalar_string().unwrap_or_default(),
                        YamlValue::from_yaml(v),
                    );
                }
                YamlValue::Map(m)
            }
            Yaml::Alias(_) | Yaml::Null | Yaml::BadValue => YamlValue::Null,
        }
    }

    /// Text of a scalar (numbers and booleans as they would be written).
    pub fn scalar_string(&self) -> Option<String> {
        Some(match self {
            YamlValue::String(s) => s.clone(),
            YamlValue::Int(i) => i.to_string(),
            YamlValue::Float(f) => js_number_to_string(*f),
            YamlValue::Bool(b) => b.to_string(),
            YamlValue::Null => String::new(),
            _ => return None,
        })
    }

    fn as_f64(&self) -> Option<f64> {
        match self {
            YamlValue::Int(i) => Some(*i as f64),
            YamlValue::Float(f) => Some(*f),
            YamlValue::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

/// Parse YAML text into order-preserving data (first document only).
pub fn parse_yaml(src: &str) -> Result<YamlValue, BaseError> {
    let docs = YamlLoader::load_from_str(src).map_err(|e| {
        let m = e.marker();
        // Marker line is 1-based; col is 0-based chars.
        let line = m.line().saturating_sub(1);
        let line_start = src
            .split_inclusive('\n')
            .take(line)
            .map(str::len)
            .sum::<usize>();
        let line_text = src[line_start.min(src.len())..]
            .split('\n')
            .next()
            .unwrap_or("");
        let col_byte = line_text
            .char_indices()
            .nth(m.col())
            .map(|(i, _)| i)
            .unwrap_or(line_text.len());
        let byte = (line_start + col_byte).min(src.len());
        BaseError {
            offset: Some(utf16_len(&src[..byte])),
            end: Some(utf16_len(&src[..byte])),
            line: Some(line as u32),
            col: Some(utf16_len(&line_text[..col_byte])),
            ..BaseError::new(ErrorKind::Yaml, e.info().to_string())
        }
    })?;
    Ok(docs
        .first()
        .map(YamlValue::from_yaml)
        .unwrap_or(YamlValue::Null))
}

/// `filters`: a statement, or exactly one of `and` / `or` / `not` over a list.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterNode {
    Expr(String),
    And { and: Vec<FilterNode> },
    Or { or: Vec<FilterNode> },
    Not { not: Vec<FilterNode> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Direction {
    #[default]
    ASC,
    DESC,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SortConfig {
    pub property: String,
    pub direction: Direction,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GroupBy {
    pub property: String,
    pub direction: Direction,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PropertyConfig {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_name: Option<String>,
    #[serde(flatten, default)]
    pub extra: OrderedMap<YamlValue>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewConfig {
    #[serde(rename = "type")]
    pub view_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub filters: Option<FilterNode>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group_by: Option<GroupBy>,
    /// Visible properties, in order.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub order: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sort: Option<Vec<SortConfig>>,
    /// Property → summary name.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summaries: Option<OrderedMap<String>>,
    /// Table: column widths in pixels by property id.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub column_size: Option<OrderedMap<f64>>,
    /// Table: `short` | `medium` | `tall` | `extra-tall`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub row_height: Option<String>,
    /// Cards: card width in pixels.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub card_size: Option<f64>,
    /// Cards: property id of the cover image.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub image: Option<String>,
    /// Cards: `cover` | `contain`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub image_fit: Option<String>,
    /// Cards: height / width of the cover image.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub image_aspect_ratio: Option<f64>,
    /// Every other key (list `markers`/`separator`/`indentProperties`, map
    /// `coordinates`/`markerIcon`, plugin views …), in file order.
    #[serde(default)]
    pub extra: OrderedMap<YamlValue>,
    /// Key order as read, for round trips.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_order: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BaseFile {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub filters: Option<FilterNode>,
    #[serde(default)]
    pub formulas: OrderedMap<String>,
    #[serde(default)]
    pub properties: OrderedMap<PropertyConfig>,
    #[serde(default)]
    pub summaries: OrderedMap<String>,
    #[serde(default)]
    pub views: Vec<ViewConfig>,
    #[serde(default)]
    pub extra: OrderedMap<YamlValue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_order: Vec<String>,
}

fn schema_err(source: &str, msg: impl Into<String>) -> BaseError {
    BaseError::schema(msg).with_source(source)
}

fn parse_filter(v: &YamlValue, source: &str) -> Result<Option<FilterNode>, BaseError> {
    Ok(Some(match v {
        YamlValue::Null => return Ok(None),
        YamlValue::Map(m) => {
            if m.len() != 1 {
                return Err(schema_err(
                    source,
                    "A filter group must have exactly one of \"and\", \"or\" or \"not\"",
                ));
            }
            let (k, list) = &m.0[0];
            let items: Vec<&YamlValue> = match list {
                YamlValue::List(items) => items.iter().collect(),
                YamlValue::Null => Vec::new(),
                single => vec![single],
            };
            let mut children = Vec::new();
            for (i, it) in items.into_iter().enumerate() {
                if let Some(f) = parse_filter(it, &format!("{source}.{k}[{i}]"))? {
                    children.push(f);
                }
            }
            match k.as_str() {
                "and" => FilterNode::And { and: children },
                "or" => FilterNode::Or { or: children },
                "not" => FilterNode::Not { not: children },
                other => {
                    return Err(schema_err(
                        source,
                        format!("Unknown filter group \"{other}\" (expected and, or, not)"),
                    ))
                }
            }
        }
        YamlValue::List(_) => {
            return Err(schema_err(
                source,
                "Filters must be a string or an and/or/not group, not a list",
            ))
        }
        scalar => FilterNode::Expr(scalar.scalar_string().unwrap_or_default()),
    }))
}

fn string_map(v: &YamlValue, source: &str) -> Result<OrderedMap<String>, BaseError> {
    match v {
        YamlValue::Null => Ok(OrderedMap::new()),
        YamlValue::Map(m) => {
            let mut out = OrderedMap::new();
            for (k, x) in m.iter() {
                let s = x
                    .scalar_string()
                    .ok_or_else(|| schema_err(&format!("{source}.{k}"), "Expected a string"))?;
                out.insert(k.clone(), s);
            }
            Ok(out)
        }
        _ => Err(schema_err(source, "Expected a map")),
    }
}

fn parse_direction(v: Option<&YamlValue>) -> Direction {
    match v.and_then(YamlValue::scalar_string) {
        Some(s) if s.eq_ignore_ascii_case("desc") => Direction::DESC,
        _ => Direction::ASC,
    }
}

fn parse_view(v: &YamlValue, source: &str) -> Result<ViewConfig, BaseError> {
    let YamlValue::Map(m) = v else {
        return Err(schema_err(source, "Each view must be a map"));
    };
    let mut view = ViewConfig {
        view_type: "table".into(),
        ..Default::default()
    };
    for (k, x) in m.iter() {
        view.key_order.push(k.clone());
        let src = format!("{source}.{k}");
        match k.as_str() {
            "type" => view.view_type = x.scalar_string().unwrap_or_default(),
            "name" => view.name = x.scalar_string().unwrap_or_default(),
            "limit" => view.limit = x.as_f64(),
            "filters" => view.filters = parse_filter(x, &src)?,
            "order" => {
                view.order = Some(match x {
                    YamlValue::List(items) => {
                        items.iter().filter_map(YamlValue::scalar_string).collect()
                    }
                    YamlValue::Null => Vec::new(),
                    _ => return Err(schema_err(&src, "Expected a list of properties")),
                })
            }
            "sort" => {
                let mut out = Vec::new();
                if let YamlValue::List(items) = x {
                    for it in items {
                        match it {
                            YamlValue::Map(sm) => {
                                let prop = sm
                                    .get("property")
                                    .or_else(|| sm.get("column"))
                                    .and_then(YamlValue::scalar_string);
                                if let Some(property) = prop {
                                    out.push(SortConfig {
                                        property,
                                        direction: parse_direction(sm.get("direction")),
                                    });
                                }
                            }
                            other => {
                                if let Some(property) = other.scalar_string() {
                                    out.push(SortConfig {
                                        property,
                                        direction: Direction::ASC,
                                    });
                                }
                            }
                        }
                    }
                }
                view.sort = Some(out);
            }
            "groupBy" => {
                view.group_by = match x {
                    YamlValue::Map(gm) => gm
                        .get("property")
                        .and_then(YamlValue::scalar_string)
                        .map(|property| GroupBy {
                            property,
                            direction: parse_direction(gm.get("direction")),
                        }),
                    YamlValue::String(s) => Some(GroupBy {
                        property: s.clone(),
                        direction: Direction::ASC,
                    }),
                    _ => None,
                }
            }
            "summaries" => view.summaries = Some(string_map(x, &src)?),
            "columnSize" => {
                let mut out = OrderedMap::new();
                if let YamlValue::Map(cm) = x {
                    for (ck, cv) in cm.iter() {
                        if let Some(n) = cv.as_f64() {
                            out.insert(ck.clone(), n);
                        }
                    }
                }
                view.column_size = Some(out);
            }
            "rowHeight" => view.row_height = x.scalar_string(),
            "cardSize" => view.card_size = x.as_f64(),
            "image" => view.image = x.scalar_string(),
            "imageFit" => view.image_fit = x.scalar_string(),
            "imageAspectRatio" => view.image_aspect_ratio = x.as_f64(),
            _ => view.extra.insert(k.clone(), x.clone()),
        }
    }
    Ok(view)
}

/// Parse `.base` YAML (or the body of a ```` ```base ```` code block).
pub fn parse_base(yaml: &str) -> Result<BaseFile, BaseError> {
    let root = parse_yaml(yaml)?;
    let m =
        match root {
            YamlValue::Null => return Ok(BaseFile::default()),
            YamlValue::Map(m) => m,
            _ => return Err(BaseError::schema(
                "A base must be a YAML map with filters, formulas, properties, summaries and views",
            )),
        };
    let mut base = BaseFile::default();
    for (k, v) in m.iter() {
        base.key_order.push(k.clone());
        match k.as_str() {
            "filters" => base.filters = parse_filter(v, "filters")?,
            "formulas" => base.formulas = string_map(v, "formulas")?,
            "summaries" => base.summaries = string_map(v, "summaries")?,
            "properties" => match v {
                YamlValue::Null => {}
                YamlValue::Map(pm) => {
                    for (pk, pv) in pm.iter() {
                        let mut cfg = PropertyConfig::default();
                        if let YamlValue::Map(fields) = pv {
                            for (fk, fv) in fields.iter() {
                                if fk == "displayName" {
                                    cfg.display_name = fv.scalar_string();
                                } else {
                                    cfg.extra.insert(fk.clone(), fv.clone());
                                }
                            }
                        }
                        base.properties.insert(pk.clone(), cfg);
                    }
                }
                _ => return Err(schema_err("properties", "Expected a map")),
            },
            "views" => match v {
                YamlValue::Null => {}
                YamlValue::List(items) => {
                    for (i, it) in items.iter().enumerate() {
                        base.views.push(parse_view(it, &format!("views[{i}]"))?);
                    }
                }
                _ => return Err(schema_err("views", "Expected a list of views")),
            },
            _ => base.extra.insert(k.clone(), v.clone()),
        }
    }
    Ok(base)
}

/// Parse every expression in the base and report syntax errors, each with its
/// `source` (`formulas.x`, `views[1].filters.and[0]`) and UTF-16 offsets into
/// that expression.
pub fn validate_base(base: &BaseFile) -> Vec<BaseError> {
    fn walk(f: &FilterNode, source: &str, out: &mut Vec<BaseError>) {
        let (key, items) = match f {
            FilterNode::Expr(s) if s.trim().is_empty() => return,
            FilterNode::Expr(s) => {
                if let Err(e) = parse_expression(s) {
                    out.push(e.with_source(source));
                }
                return;
            }
            FilterNode::And { and } => ("and", and),
            FilterNode::Or { or } => ("or", or),
            FilterNode::Not { not } => ("not", not),
        };
        for (i, c) in items.iter().enumerate() {
            walk(c, &format!("{source}.{key}[{i}]"), out);
        }
    }
    let mut out = Vec::new();
    if let Some(f) = &base.filters {
        walk(f, "filters", &mut out);
    }
    for (k, src) in base
        .formulas
        .iter()
        .filter(|(_, src)| !src.trim().is_empty())
    {
        if let Err(e) = parse_expression(src) {
            out.push(e.with_source(format!("formulas.{k}")));
        }
    }
    for (k, src) in base.summaries.iter() {
        if let Err(e) = parse_expression(src) {
            out.push(e.with_source(format!("summaries.{k}")));
        }
    }
    for (i, v) in base.views.iter().enumerate() {
        if let Some(f) = &v.filters {
            walk(f, &format!("views[{i}].filters"), &mut out);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

fn filter_yaml(f: &FilterNode) -> YamlValue {
    let (k, items) = match f {
        FilterNode::Expr(s) => return YamlValue::String(s.clone()),
        FilterNode::And { and } => ("and", and),
        FilterNode::Or { or } => ("or", or),
        FilterNode::Not { not } => ("not", not),
    };
    let mut m = OrderedMap::new();
    m.insert(k, YamlValue::List(items.iter().map(filter_yaml).collect()));
    YamlValue::Map(m)
}

fn str_map_yaml(m: &OrderedMap<String>) -> YamlValue {
    YamlValue::Map(OrderedMap(
        m.iter()
            .map(|(k, v)| (k.clone(), YamlValue::String(v.clone())))
            .collect(),
    ))
}

fn dir_str(d: Direction) -> YamlValue {
    YamlValue::String(match d {
        Direction::ASC => "ASC".into(),
        Direction::DESC => "DESC".into(),
    })
}

fn num_yaml(n: f64) -> YamlValue {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        YamlValue::Int(n as i64)
    } else {
        YamlValue::Float(n)
    }
}

/// Assemble keys in their original order, then known keys that were added,
/// then extras that were added.
fn ordered(
    key_order: &[String],
    known: Vec<(&str, Option<YamlValue>)>,
    extra: &OrderedMap<YamlValue>,
) -> OrderedMap<YamlValue> {
    let mut out = OrderedMap::new();
    let lookup = |k: &str| -> Option<YamlValue> {
        known
            .iter()
            .find(|(n, _)| *n == k)
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| extra.get(k).cloned())
    };
    for k in key_order {
        if out.contains_key(k) {
            continue;
        }
        if let Some(v) = lookup(k) {
            out.insert(k.clone(), v);
        }
    }
    for (k, v) in &known {
        if !out.contains_key(k) {
            if let Some(v) = v {
                out.insert(*k, v.clone());
            }
        }
    }
    for (k, v) in extra.iter() {
        if !out.contains_key(k) {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

fn view_yaml(v: &ViewConfig) -> YamlValue {
    let known: Vec<(&str, Option<YamlValue>)> = vec![
        ("type", Some(YamlValue::String(v.view_type.clone()))),
        ("name", Some(YamlValue::String(v.name.clone()))),
        ("limit", v.limit.map(num_yaml)),
        ("filters", v.filters.as_ref().map(filter_yaml)),
        (
            "groupBy",
            v.group_by.as_ref().map(|g| {
                let mut m = OrderedMap::new();
                m.insert("property", YamlValue::String(g.property.clone()));
                m.insert("direction", dir_str(g.direction));
                YamlValue::Map(m)
            }),
        ),
        (
            "order",
            v.order
                .as_ref()
                .map(|o| YamlValue::List(o.iter().cloned().map(YamlValue::String).collect())),
        ),
        (
            "sort",
            v.sort.as_ref().map(|s| {
                YamlValue::List(
                    s.iter()
                        .map(|c| {
                            let mut m = OrderedMap::new();
                            m.insert("property", YamlValue::String(c.property.clone()));
                            m.insert("direction", dir_str(c.direction));
                            YamlValue::Map(m)
                        })
                        .collect(),
                )
            }),
        ),
        ("summaries", v.summaries.as_ref().map(str_map_yaml)),
        (
            "columnSize",
            v.column_size.as_ref().map(|c| {
                YamlValue::Map(OrderedMap(
                    c.iter().map(|(k, n)| (k.clone(), num_yaml(*n))).collect(),
                ))
            }),
        ),
        ("rowHeight", v.row_height.clone().map(YamlValue::String)),
        ("cardSize", v.card_size.map(num_yaml)),
        ("image", v.image.clone().map(YamlValue::String)),
        ("imageFit", v.image_fit.clone().map(YamlValue::String)),
        ("imageAspectRatio", v.image_aspect_ratio.map(num_yaml)),
    ];
    YamlValue::Map(ordered(&v.key_order, known, &v.extra))
}

fn base_yaml(base: &BaseFile) -> YamlValue {
    let present = |k: &str| base.key_order.iter().any(|x| x == k);
    let non_empty_or_present = |empty: bool, k: &str| !empty || present(k);
    let known: Vec<(&str, Option<YamlValue>)> = vec![
        ("filters", base.filters.as_ref().map(filter_yaml)),
        (
            "formulas",
            non_empty_or_present(base.formulas.is_empty(), "formulas")
                .then(|| str_map_yaml(&base.formulas)),
        ),
        (
            "properties",
            non_empty_or_present(base.properties.is_empty(), "properties").then(|| {
                YamlValue::Map(OrderedMap(
                    base.properties
                        .iter()
                        .map(|(k, cfg)| {
                            let mut m = OrderedMap::new();
                            if let Some(d) = &cfg.display_name {
                                m.insert("displayName", YamlValue::String(d.clone()));
                            }
                            for (ek, ev) in cfg.extra.iter() {
                                m.insert(ek.clone(), ev.clone());
                            }
                            (k.clone(), YamlValue::Map(m))
                        })
                        .collect(),
                ))
            }),
        ),
        (
            "summaries",
            non_empty_or_present(base.summaries.is_empty(), "summaries")
                .then(|| str_map_yaml(&base.summaries)),
        ),
        (
            "views",
            non_empty_or_present(base.views.is_empty(), "views")
                .then(|| YamlValue::List(base.views.iter().map(view_yaml).collect())),
        ),
    ];
    YamlValue::Map(ordered(&base.key_order, known, &base.extra))
}

/// Serialise a base to YAML in the style Obsidian writes: block maps and
/// lists, two-space indent, plain scalars where safe, single quotes otherwise,
/// `|-` blocks for multi-line formulas.
pub fn serialize_base(base: &BaseFile) -> String {
    let mut out = String::new();
    if let YamlValue::Map(m) = base_yaml(base) {
        emit_map(&mut out, &m, 0);
    }
    out
}

/// Serialise any YAML data in the same style.
pub fn stringify_yaml(v: &YamlValue) -> String {
    let mut out = String::new();
    match v {
        YamlValue::Map(m) if !m.is_empty() => emit_map(&mut out, m, 0),
        YamlValue::List(l) if !l.is_empty() => emit_list(&mut out, l, 0),
        other => {
            out.push_str(&scalar(other, 0));
            out.push('\n');
        }
    }
    out
}

fn emit_map(out: &mut String, m: &OrderedMap<YamlValue>, indent: usize) {
    for (k, v) in m.iter() {
        out.push_str(&" ".repeat(indent));
        out.push_str(&quote_key(k));
        out.push(':');
        emit_value_after_key(out, v, indent);
    }
}

fn emit_value_after_key(out: &mut String, v: &YamlValue, indent: usize) {
    match v {
        YamlValue::Map(m) if !m.is_empty() => {
            out.push('\n');
            emit_map(out, m, indent + 2);
        }
        YamlValue::List(l) if !l.is_empty() => {
            out.push('\n');
            emit_list(out, l, indent + 2);
        }
        other => {
            out.push(' ');
            out.push_str(&scalar(other, indent + 2));
            out.push('\n');
        }
    }
}

fn emit_list(out: &mut String, l: &[YamlValue], indent: usize) {
    for item in l {
        out.push_str(&" ".repeat(indent));
        out.push('-');
        match item {
            YamlValue::Map(m) if !m.is_empty() => {
                // first entry on the dash line, the rest aligned under it
                let (k0, v0) = &m.0[0];
                out.push(' ');
                out.push_str(&quote_key(k0));
                out.push(':');
                emit_value_after_key(out, v0, indent + 2);
                let rest = OrderedMap(m.0[1..].to_vec());
                emit_map(out, &rest, indent + 2);
            }
            YamlValue::List(inner) if !inner.is_empty() => {
                out.push('\n');
                emit_list(out, inner, indent + 2);
            }
            other => {
                out.push(' ');
                out.push_str(&scalar(other, indent + 2));
                out.push('\n');
            }
        }
    }
}

fn scalar(v: &YamlValue, block_indent: usize) -> String {
    match v {
        YamlValue::Null => "null".into(),
        YamlValue::Bool(b) => b.to_string(),
        YamlValue::Int(i) => i.to_string(),
        YamlValue::Float(f) => {
            if f.is_nan() {
                ".nan".into()
            } else if f.is_infinite() {
                if *f > 0.0 { ".inf" } else { "-.inf" }.into()
            } else {
                let s = js_number_to_string(*f);
                if s.contains('.') || s.contains('e') {
                    s
                } else {
                    format!("{s}.0")
                }
            }
        }
        YamlValue::Map(_) => "{}".into(),
        YamlValue::List(_) => "[]".into(),
        YamlValue::String(s) => quote_string(s, block_indent),
    }
}

fn looks_special(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "null"
            | "~"
            | "true"
            | "false"
            | "yes"
            | "no"
            | "on"
            | "off"
            | "y"
            | "n"
            | ".inf"
            | "-.inf"
            | "+.inf"
            | ".nan"
    ) {
        return true;
    }
    let t = s.trim_start_matches(['+', '-']);
    if t.starts_with("0x") || t.starts_with("0o") || t.starts_with("0b") {
        return true;
    }
    s.parse::<f64>().is_ok()
        || s.replace('_', "").parse::<f64>().is_ok()
            && s.chars().next().is_some_and(|c| c.is_ascii_digit())
}

fn needs_quotes(s: &str) -> bool {
    if s.is_empty() || s != s.trim() || looks_special(s) {
        return true;
    }
    let first = s.chars().next().unwrap();
    if "-?:,[]{}#&*!|>'\"%@`".contains(first) {
        // `-x` and `?x` and `:x` are plain-safe only when not followed by space,
        // but quoting them is always correct and rarer than it looks.
        return true;
    }
    s.contains(": ")
        || s.contains(" #")
        || s.ends_with(':')
        || s.chars().any(|c| c.is_control() || c == '\u{feff}')
}

fn quote_key(k: &str) -> String {
    if needs_quotes(k) {
        single_or_double(k)
    } else {
        k.to_string()
    }
}

fn single_or_double(s: &str) -> String {
    if s.chars().any(|c| c.is_control()) {
        serde_json::to_string(s).unwrap()
    } else {
        format!("'{}'", s.replace('\'', "''"))
    }
}

fn quote_string(s: &str, block_indent: usize) -> String {
    if s.contains('\n') {
        let lines: Vec<&str> = s.split('\n').collect();
        let body_ok = !s.chars().any(|c| c.is_control() && c != '\n')
            && !lines
                .iter()
                .find(|l| !l.is_empty())
                .is_some_and(|l| l.starts_with(' '))
            && lines
                .iter()
                .all(|l| !l.ends_with(' ') && !l.ends_with('\t'));
        if body_ok {
            let trailing = s.len() - s.trim_end_matches('\n').len();
            let content = s.trim_end_matches('\n');
            if !content.is_empty() {
                let chomp = match trailing {
                    0 => "-",
                    1 => "",
                    _ => "+",
                };
                let pad = " ".repeat(block_indent);
                let mut out = format!("|{chomp}");
                let body_lines: Vec<&str> = if trailing > 1 {
                    s[..s.len() - 1].split('\n').collect()
                } else {
                    content.split('\n').collect()
                };
                for l in body_lines {
                    out.push('\n');
                    if !l.is_empty() {
                        out.push_str(&pad);
                        out.push_str(l);
                    }
                }
                return out;
            }
        }
        return serde_json::to_string(s).unwrap();
    }
    if needs_quotes(s) {
        single_or_double(s)
    } else {
        s.to_string()
    }
}
