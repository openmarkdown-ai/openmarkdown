//! Running a view: filter, compute formulas, sort, limit, group, summarise.

use crate::error::BaseError;
use crate::eval::{aggregate, sort_cmp, Engine, Ev};
use crate::expr::{parse_expression, Expr};
use crate::record::FileRecord;
use crate::schema::{BaseFile, Direction, FilterNode, ViewConfig};
use crate::value::{OrderedMap, Value};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeMap;

/// Options for [`run_view_with`].
#[derive(Clone, Debug, Default)]
pub struct RunOptions<'a> {
    pub now_ms: f64,
    /// Minutes east of UTC (Singapore is `480`); the negation of JS
    /// `getTimezoneOffset()`.
    pub tz_offset_min: i32,
    /// Property types from `.obsidian/types.json`.
    pub property_types: Option<&'a BTreeMap<String, String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewInfo {
    pub index: usize,
    #[serde(rename = "type")]
    pub view_type: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    /// Normalised property id: `note.status`, `file.name`, `formula.ppu`.
    pub id: String,
    /// `displayName` from `properties`, or the default name.
    pub name: String,
    /// `note` | `file` | `formula`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub width: Option<f64>,
    /// Summary name configured for this column in the view, if any.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summary: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub path: String,
    /// Column id → value; a failed evaluation is a `{"type":"error"}` value.
    pub cells: OrderedMap<Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    /// The groupBy value, `null` for rows without one (and when not grouped).
    pub key: Value,
    pub has_key: bool,
    pub rows: Vec<Row>,
    /// Column id → summary value for this group.
    pub summaries: OrderedMap<Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ViewResult {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub view: Option<ViewInfo>,
    pub columns: Vec<Column>,
    pub groups: Vec<Group>,
    /// Column id → summary value over every row shown.
    pub summaries: OrderedMap<Value>,
    /// Rows matching the filters, before `limit`.
    pub total: usize,
    /// Rows shown (after `limit`).
    pub count: usize,
    /// Syntax errors and the first evaluation error of each filter statement.
    pub errors: Vec<BaseError>,
}

/// Split a property id into (kind, name). A bare name is a note property.
pub fn parse_property_id(id: &str) -> (&str, &str) {
    for kind in ["note", "file", "formula"] {
        if let Some(rest) = id.strip_prefix(kind).and_then(|r| r.strip_prefix('.')) {
            return (kind, rest);
        }
    }
    ("note", id)
}

pub fn normalize_property_id(id: &str) -> String {
    let (kind, name) = parse_property_id(id);
    format!("{kind}.{name}")
}

/// Obsidian's default display name for a property id.
pub fn default_display_name(id: &str) -> String {
    let (kind, name) = parse_property_id(id);
    if kind == "file" {
        let d = match name {
            "name" => "file name",
            "basename" => "file base name",
            "path" => "file path",
            "folder" => "folder",
            "ext" => "file extension",
            "size" => "file size",
            "ctime" => "created time",
            "mtime" => "modified time",
            "tags" => "file tags",
            "links" => "file links",
            "embeds" => "file embeds",
            "backlinks" => "backlinks",
            "properties" => "file properties",
            other => other,
        };
        return d.to_string();
    }
    name.to_string()
}

/// Display name for `id` given the base's `properties` section.
pub fn display_name(base: &BaseFile, id: &str) -> String {
    let norm = normalize_property_id(id);
    base.properties
        .iter()
        .find(|(k, _)| normalize_property_id(k) == norm)
        .and_then(|(_, c)| c.display_name.clone())
        .unwrap_or_else(|| default_display_name(id))
}

enum Compiled {
    Expr(Result<Expr, ()>, String),
    And(Vec<Compiled>),
    Or(Vec<Compiled>),
    Not(Vec<Compiled>),
}

fn compile(f: &FilterNode, source: &str, errors: &mut Vec<BaseError>) -> Compiled {
    let (key, items) = match f {
        // An empty statement (a filter row not filled in yet) matches everything.
        FilterNode::Expr(s) if s.trim().is_empty() => return Compiled::And(Vec::new()),
        FilterNode::Expr(s) => {
            return Compiled::Expr(
                parse_expression(s).map_err(|e| errors.push(e.with_source(source))),
                source.to_string(),
            )
        }
        FilterNode::And { and } => ("and", and),
        FilterNode::Or { or } => ("or", or),
        FilterNode::Not { not } => ("not", not),
    };
    let children = items
        .iter()
        .enumerate()
        .map(|(i, c)| compile(c, &format!("{source}.{key}[{i}]"), errors))
        .collect();
    match key {
        "and" => Compiled::And(children),
        "or" => Compiled::Or(children),
        _ => Compiled::Not(children),
    }
}

fn test(c: &Compiled, ev: &mut Ev, eval_errors: &mut Vec<BaseError>) -> bool {
    match c {
        Compiled::Expr(Ok(e), source) => match ev.eval(e) {
            Ok(Value::Error { message }) | Err(message) => {
                if eval_errors.len() < 50
                    && !eval_errors
                        .iter()
                        .any(|x| x.source.as_deref() == Some(source))
                {
                    let path = ev.row.map(|r| r.path.as_str()).unwrap_or("");
                    eval_errors.push(
                        BaseError::eval(format!("{message} (in {path})"))
                            .with_source(source.clone()),
                    );
                }
                false
            }
            Ok(v) => v.is_truthy(),
        },
        Compiled::Expr(Err(()), _) => false,
        Compiled::And(items) => items.iter().all(|x| test(x, ev, eval_errors)),
        Compiled::Or(items) => items.iter().any(|x| test(x, ev, eval_errors)),
        Compiled::Not(items) => !items.iter().any(|x| test(x, ev, eval_errors)),
    }
}

fn property_value(ev: &mut Ev, id: &str) -> Value {
    let (kind, name) = parse_property_id(id);
    let r = match kind {
        "formula" => ev.formula(name),
        "file" => ev.row_file_field(name),
        _ => Ok(ev.property(ev.row, name)),
    };
    match r {
        Ok(v) => v,
        Err(message) => Value::Error { message },
    }
}

fn directed(o: Ordering, a: &Value, b: &Value, dir: Direction) -> Ordering {
    // Empty values stay last whichever way the sort runs.
    if a.is_empty() != b.is_empty() || dir == Direction::ASC {
        o
    } else {
        o.reverse()
    }
}

/// Built-in summary functions, by name (case-insensitive).
pub fn builtin_summary(name: &str, values: &[Value]) -> Option<Value> {
    let nums: Vec<f64> = values.iter().filter_map(Value::as_number).collect();
    let dates: Vec<f64> = values
        .iter()
        .filter_map(|v| match v {
            Value::Date { value, .. } => Some(*value),
            _ => None,
        })
        .collect();
    let date_of = |pick_max: bool| -> Value {
        let best = values
            .iter()
            .filter(|v| matches!(v, Value::Date { .. }))
            .fold(None::<&Value>, |acc, v| match (acc, v) {
                (None, v) => Some(v),
                (Some(Value::Date { value: a, .. }), Value::Date { value: b, .. }) => {
                    if (pick_max && b > a) || (!pick_max && b < a) {
                        Some(v)
                    } else {
                        acc
                    }
                }
                _ => acc,
            });
        best.cloned().unwrap_or(Value::Null)
    };
    let count =
        |f: &dyn Fn(&Value) -> bool| Value::num(values.iter().filter(|v| f(v)).count() as f64);
    Some(match name.to_ascii_lowercase().as_str() {
        "average" | "mean" => aggregate("mean", &nums),
        "sum" => aggregate("sum", &nums),
        "median" => aggregate("median", &nums),
        "stddev" => aggregate("stddev", &nums),
        "min" => {
            if nums.is_empty() && !dates.is_empty() {
                date_of(false)
            } else if nums.is_empty() {
                Value::Null
            } else {
                Value::num(nums.iter().cloned().fold(f64::INFINITY, f64::min))
            }
        }
        "max" => {
            if nums.is_empty() && !dates.is_empty() {
                date_of(true)
            } else if nums.is_empty() {
                Value::Null
            } else {
                Value::num(nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
            }
        }
        "range" => {
            if nums.is_empty() && !dates.is_empty() {
                let lo = dates.iter().cloned().fold(f64::INFINITY, f64::min);
                let hi = dates.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                Value::duration(crate::datetime::Duration::from_ms(hi - lo))
            } else if nums.is_empty() {
                Value::Null
            } else {
                let lo = nums.iter().cloned().fold(f64::INFINITY, f64::min);
                let hi = nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                Value::num(hi - lo)
            }
        }
        "earliest" => date_of(false),
        "latest" => date_of(true),
        "checked" => count(&|v| matches!(v, Value::Boolean { value: true })),
        "unchecked" => count(&|v| matches!(v, Value::Boolean { value: false })),
        "empty" => count(&|v| v.is_empty()),
        "filled" => count(&|v| !v.is_empty()),
        "unique" => {
            let mut seen: Vec<String> = Vec::new();
            for v in values.iter().filter(|v| !v.is_empty()) {
                let key = format!(
                    "{}:{}",
                    v.type_name(),
                    serde_json::to_string(v).unwrap_or_default()
                );
                if !seen.contains(&key) {
                    seen.push(key);
                }
            }
            Value::num(seen.len() as f64)
        }
        _ => return None,
    })
}

/// Run view `view` of `base` over `files`.
///
/// `this` is the base file itself, the note embedding it, or the active file
/// for a sidebar base. `tz_offset_min` is minutes east of UTC.
pub fn run_view(
    base: &BaseFile,
    view: usize,
    files: &[FileRecord],
    this: Option<&FileRecord>,
    now_ms: f64,
    tz_offset_min: i32,
) -> ViewResult {
    run_view_with(
        base,
        view,
        files,
        this,
        &RunOptions {
            now_ms,
            tz_offset_min,
            property_types: None,
        },
    )
}

pub fn run_view_with(
    base: &BaseFile,
    view_index: usize,
    files: &[FileRecord],
    this: Option<&FileRecord>,
    opts: &RunOptions,
) -> ViewResult {
    let default_view;
    let view: &ViewConfig = match base.views.get(view_index) {
        Some(v) => v,
        None if base.views.is_empty() && view_index == 0 => {
            default_view = ViewConfig {
                view_type: "table".into(),
                name: "Table".into(),
                ..Default::default()
            };
            &default_view
        }
        None => {
            return ViewResult {
                errors: vec![BaseError::schema(format!(
                    "View {view_index} does not exist; the base has {} views",
                    base.views.len()
                ))],
                ..Default::default()
            }
        }
    };
    let mut result = ViewResult {
        view: Some(ViewInfo {
            index: view_index,
            view_type: view.view_type.clone(),
            name: view.name.clone(),
        }),
        ..Default::default()
    };
    let engine = Engine::new(
        files,
        this,
        &base.formulas,
        opts.now_ms,
        opts.tz_offset_min,
        opts.property_types,
    );
    let tz = opts.tz_offset_min;

    for (k, _) in base.formulas.iter() {
        if let Some(e) = engine.formula_error(k) {
            result.errors.push(e.clone());
        }
    }
    let global = base
        .filters
        .as_ref()
        .map(|f| compile(f, "filters", &mut result.errors));
    let local = view.filters.as_ref().map(|f| {
        compile(
            f,
            &format!("views[{view_index}].filters"),
            &mut result.errors,
        )
    });

    // Filter.
    let mut eval_errors = Vec::new();
    let mut rows: Vec<Ev> = Vec::new();
    for f in files {
        let mut ev = engine.row(Some(f));
        let pass = global
            .as_ref()
            .is_none_or(|g| test(g, &mut ev, &mut eval_errors))
            && local
                .as_ref()
                .is_none_or(|l| test(l, &mut ev, &mut eval_errors));
        if pass {
            rows.push(ev);
        }
    }
    result.errors.extend(eval_errors);

    // Sort.
    let sorts: Vec<(String, Direction)> = view
        .sort
        .iter()
        .flatten()
        .map(|s| (normalize_property_id(&s.property), s.direction))
        .collect();
    if !sorts.is_empty() {
        let mut keyed: Vec<(Vec<Value>, Ev)> = rows
            .into_iter()
            .map(|mut ev| {
                let keys = sorts
                    .iter()
                    .map(|(id, _)| property_value(&mut ev, id))
                    .collect();
                (keys, ev)
            })
            .collect();
        keyed.sort_by(|(ka, _), (kb, _)| {
            for (i, (_, dir)) in sorts.iter().enumerate() {
                let o = directed(sort_cmp(&ka[i], &kb[i], tz), &ka[i], &kb[i], *dir);
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        });
        rows = keyed.into_iter().map(|(_, ev)| ev).collect();
    }

    result.total = rows.len();
    if let Some(limit) = view.limit {
        if limit >= 0.0 && (limit as usize) < rows.len() {
            rows.truncate(limit as usize);
        }
    }
    result.count = rows.len();

    // Columns.
    let order: Vec<String> = match &view.order {
        Some(o) => o.iter().map(|x| normalize_property_id(x)).collect(),
        None => vec!["file.name".to_string()],
    };
    let summaries: Vec<(String, String)> = view
        .summaries
        .iter()
        .flat_map(|m| m.iter())
        .map(|(k, v)| (normalize_property_id(k), v.clone()))
        .collect();
    for id in &order {
        let width = view.column_size.as_ref().and_then(|cs| {
            cs.iter()
                .find(|(k, _)| normalize_property_id(k) == *id)
                .map(|(_, w)| *w)
        });
        result.columns.push(Column {
            id: id.clone(),
            name: display_name(base, id),
            kind: parse_property_id(id).0.to_string(),
            width,
            summary: summaries
                .iter()
                .find(|(k, _)| k == id)
                .map(|(_, s)| s.clone()),
        });
    }

    // Cells (and the extra values summaries need).
    let mut needed: Vec<String> = order.clone();
    for (id, _) in &summaries {
        if !needed.contains(id) {
            needed.push(id.clone());
        }
    }
    let group_id = view
        .group_by
        .as_ref()
        .map(|g| normalize_property_id(&g.property));
    struct Computed {
        path: String,
        values: Vec<Value>,
        group: Value,
    }
    let computed: Vec<Computed> = rows
        .into_iter()
        .map(|mut ev| {
            let values = needed
                .iter()
                .map(|id| property_value(&mut ev, id))
                .collect();
            let group = group_id
                .as_ref()
                .map(|g| property_value(&mut ev, g))
                .unwrap_or(Value::Null);
            Computed {
                path: ev.row.map(|r| r.path.clone()).unwrap_or_default(),
                values,
                group,
            }
        })
        .collect();

    // Group.
    let mut buckets: Vec<(Value, Vec<usize>)> = Vec::new();
    let comparer = engine.row(None);
    for (i, c) in computed.iter().enumerate() {
        let key = if c.group.is_empty() || c.group.is_error() {
            Value::Null
        } else {
            c.group.clone()
        };
        match buckets
            .iter_mut()
            .find(|(k, _)| k.type_name() == key.type_name() && comparer.loose_eq(k, &key))
        {
            Some((_, members)) => members.push(i),
            None => buckets.push((key, vec![i])),
        }
    }
    if let Some(g) = &view.group_by {
        let dir = g.direction;
        buckets.sort_by(|(a, _), (b, _)| directed(sort_cmp(a, b, tz), a, b, dir));
    }
    if buckets.is_empty() {
        buckets.push((Value::Null, Vec::new()));
    }

    let summarise = |members: &[usize]| -> OrderedMap<Value> {
        let mut out = OrderedMap::new();
        for (id, name) in &summaries {
            let col = needed.iter().position(|n| n == id).unwrap();
            let values: Vec<Value> = members
                .iter()
                .map(|&i| computed[i].values[col].clone())
                .collect();
            let v = if let Some(src) = base.summaries.get(name) {
                match parse_expression(src) {
                    Err(e) => Value::error(format!(
                        "Summary \"{name}\" has a syntax error: {}",
                        e.message
                    )),
                    Ok(ast) => {
                        let all_empty = values.iter().all(Value::is_empty);
                        let mut ev = engine.row(None);
                        ev.locals.push(("values".into(), Value::list(values)));
                        match ev.eval(&ast) {
                            Ok(v) => v,
                            // `values.mean().round(2)` over a group with no values is
                            // an empty cell, not an error.
                            Err(_) if all_empty => Value::Null,
                            Err(message) => Value::Error { message },
                        }
                    }
                }
            } else {
                builtin_summary(name, &values)
                    .unwrap_or_else(|| Value::error(format!("Unknown summary \"{name}\"")))
            };
            out.insert(id.clone(), v);
        }
        out
    };

    let all: Vec<usize> = (0..computed.len()).collect();
    result.summaries = summarise(&all);
    for (key, members) in buckets {
        let rows = members
            .iter()
            .map(|&i| {
                let c = &computed[i];
                let mut cells = OrderedMap::new();
                for (j, id) in order.iter().enumerate() {
                    cells.insert(id.clone(), c.values[j].clone());
                }
                Row {
                    path: c.path.clone(),
                    cells,
                }
            })
            .collect();
        result.groups.push(Group {
            has_key: group_id.is_some() && !key.is_null(),
            key,
            rows,
            summaries: summarise(&members),
        });
    }
    result
}
