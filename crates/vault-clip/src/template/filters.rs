//! Every Knap filter (knap 0.5 `src/filters/*.ts`) plus the clipper's
//! `markdown`, `fragment_link` override and the DOM filters `html_to_json` /
//! `remove_html`.
//!
//! Each filter keeps Knap's calling convention: it receives the input as a
//! string (`valueToString`), the serialized parameter string, and the typed
//! raw value/arguments. Most filters `JSON.parse` their input; that is kept
//! deliberately, because it decides edge cases users rely on (`"123"|first`
//! returns `"123"`, a one-element array renders as its element).

use super::params::*;
use crate::value::{js_number, parse_float, parse_int, utf16_len, utf16_slice, Map, Value};
use regex_lite::Regex;

pub struct FilterCall<'a> {
    pub value: &'a str,
    pub param: Option<&'a str>,
    pub raw_value: &'a Value,
    pub raw_args: Option<&'a [Value]>,
    pub env: &'a FilterEnv,
}

/// Host data a filter may need.
#[derive(Debug, Clone, Default)]
pub struct FilterEnv {
    pub current_url: String,
    pub now_ms: f64,
    pub tz_offset_minutes: i32,
}

pub struct FilterOutput {
    pub value: Value,
    pub warning: Option<String>,
    pub error: Option<String>,
}

impl From<Value> for FilterOutput {
    fn from(value: Value) -> Self {
        FilterOutput {
            value,
            warning: None,
            error: None,
        }
    }
}

fn s(v: impl Into<String>) -> FilterOutput {
    Value::String(v.into()).into()
}

fn warn(v: Value, msg: impl Into<String>) -> FilterOutput {
    FilterOutput {
        value: v,
        warning: Some(msg.into()),
        error: None,
    }
}

pub const FILTER_NAMES: &[&str] = &[
    "blockquote", "bold", "calc", "callout", "camel", "capitalize", "compact", "code",
    "code_block", "comment", "date_modify", "date", "decode_uri", "duration", "embed",
    "encode_uri", "escape_md", "first", "footnote", "fragment_link", "h1", "h2", "h3", "h4", "h5",
    "h6", "hard_break", "highlight", "hr", "image", "indent", "italic", "join", "kebab", "last",
    "length", "link", "list", "lower", "map", "math", "math_block", "merge", "number_format",
    "nth", "object", "pascal", "parse_json", "reverse", "remove_attr", "remove_tags", "replace",
    "replace_tags", "round", "safe_name", "slice", "snake", "sort", "split", "sum", "strip_attr",
    "strip_md", "strip_tags", "stripmd", "strike", "table", "table_pretty", "template", "title",
    "trim", "truncate", "truncatewords", "uncamel", "unescape", "unique", "upper", "wikilink",
    "yaml", "yaml_property", "where", "html_to_json", "remove_html", "markdown",
];

pub fn exists(name: &str) -> bool {
    FILTER_NAMES.contains(&name)
}

/// Apply a filter. `None` when the filter does not exist (the engine passes
/// the value through unchanged in that case).
pub fn apply(name: &str, call: &FilterCall) -> Option<FilterOutput> {
    // Knap's registry wrapper maps an empty param to undefined.
    let param = call.param.filter(|p| !p.is_empty());
    let c = FilterCall {
        value: call.value,
        param,
        raw_value: call.raw_value,
        raw_args: call.raw_args,
        env: call.env,
    };
    let v = c.value;
    Some(match name {
        "blockquote" => s(blockquote(v)),
        "bold" => {
            let m = clean_scalar_param(param).unwrap_or_else(|| "*".into());
            map_strings(&c, |x| wrap_inline(x, &m.repeat(2), &m.repeat(2))).into()
        }
        "italic" => {
            let m = clean_scalar_param(param).unwrap_or_else(|| "*".into());
            map_strings(&c, |x| wrap_inline(x, &m, &m)).into()
        }
        "strike" => map_strings(&c, |x| wrap_inline(x, "~~", "~~")).into(),
        "highlight" => {
            let marker = highlight_marker(param).unwrap_or_default();
            map_strings(&c, |x| wrap_inline(x, &format!("=={marker}"), "==")).into()
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level = name[1..].parse::<usize>().unwrap_or(1);
            map_strings(&c, |x| format_heading(level, x)).into()
        }
        "escape_md" => map_strings(&c, |x| {
            let mut out = String::new();
            for ch in x.chars() {
                if "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".contains(ch) {
                    out.push('\\');
                }
                out.push(ch);
            }
            out
        })
        .into(),
        "hard_break" => map_strings(&c, hard_break).into(),
        "hr" => {
            let pos = clean_scalar_param(param).unwrap_or_else(|| "after".into());
            map_strings(&c, |x| match pos.as_str() {
                "before" => prepend_block(x, "---"),
                "both" => append_block(&prepend_block(x, "---"), "---"),
                _ => append_block(x, "---"),
            })
            .into()
        }
        "code" => {
            let lang = clean_scalar_param(param);
            map_strings(&c, |x| {
                if lang.is_some() || is_multiline(x) {
                    format_code_block(x, lang.as_deref().unwrap_or(""))
                } else {
                    format_inline_code(x)
                }
            })
            .into()
        }
        "code_block" => {
            let lang = clean_scalar_param(param).unwrap_or_default();
            map_strings(&c, |x| format_code_block(x, &lang)).into()
        }
        "math" => map_strings(&c, |x| {
            if is_multiline(x) {
                format_math_block(x)
            } else {
                wrap_inline(x, "$", "$")
            }
        })
        .into(),
        "math_block" => map_strings(&c, format_math_block).into(),
        "comment" => map_strings(&c, |x| {
            if x.is_empty() {
                return x.to_string();
            }
            if !is_multiline(x) {
                return wrap_inline(x, "%%", "%%");
            }
            let (lead, content, trail) = split_blank_line_padding(x);
            if content.is_empty() {
                x.to_string()
            } else {
                format!("{lead}%%\n{content}\n%%{trail}")
            }
        })
        .into(),
        "calc" => calc(&c),
        "callout" => s(callout(v, param)),
        "camel" => s(camel(v)),
        "capitalize" => s(capitalize(v)),
        "compact" => {
            let input = input_value(&c);
            let empty = |x: &Value| match x {
                Value::Null | Value::Undefined => true,
                Value::String(t) => t.trim().is_empty(),
                _ => false,
            };
            match input {
                Value::Array(a) => Value::Array(a.into_iter().filter(|x| !empty(x)).collect()),
                Value::Object(m) => Value::Object(Map(m.0.into_iter().filter(|(_, x)| !empty(x)).collect())),
                other => other,
            }
            .into()
        }
        "date" => date(&c),
        "date_modify" => date_modify(&c),
        "decode_uri" => map_strings(&c, |x| decode_uri_component(x).unwrap_or_else(|| x.to_string())).into(),
        "encode_uri" => map_strings(&c, encode_uri_component).into(),
        "duration" => s(duration(v, param)),
        "first" | "last" => s(first_last(v, name == "first")),
        "footnote" => s(footnote(v)),
        "fragment_link" => {
            let combined: Vec<&str> = [param.unwrap_or(""), c.env.current_url.as_str()]
                .into_iter()
                .filter(|x| !x.is_empty())
                .collect();
            let joined = combined.join(":");
            fragment_link(v, if joined.is_empty() { None } else { Some(&joined) })
        }
        "image" => image(v, param),
        "indent" => s(indent(v, param)),
        "join" => s(join(v, param)),
        "kebab" => s(kebab(v)),
        "length" => s(length(v)),
        "link" => s(link(v, param)),
        "list" => s(list(v, param)),
        "lower" => s(v.to_lowercase()),
        "upper" => s(v.to_uppercase()),
        "map" => map_filter(&c),
        "merge" => s(merge(&c)),
        "number_format" => s(number_format(v, param)),
        "nth" => nth(v, param),
        "object" => object(v, param),
        "pascal" => s(pascal(v)),
        "parse_json" => {
            if !matches!(c.raw_value, Value::String(_) | Value::Undefined) {
                c.raw_value.clone().into()
            } else {
                match Value::parse_json(v) {
                    Some(x) => x.into(),
                    None => warn(Value::str(v), "Could not parse value as JSON"),
                }
            }
        }
        "reverse" => s(reverse(v)),
        "remove_attr" => s(remove_attr(v, param.unwrap_or(""))),
        "remove_tags" => s(remove_tags(v, param.unwrap_or(""))),
        "replace" => replace(v, param),
        "replace_tags" => match replace_tags(v, param.unwrap_or("")) {
            Ok(r) => s(r),
            Err(e) => FilterOutput {
                value: Value::str(v),
                warning: None,
                error: Some(e),
            },
        },
        "round" => s(round(v, param)),
        "safe_name" => s(safe_name(v, param)),
        "slice" => slice(v, param),
        "snake" => s(snake(v)),
        "sort" => sort(&c),
        "split" => s(split(v, param)),
        "sum" => sum(&c),
        "strip_attr" => s(strip_attr(v, param.unwrap_or(""))),
        "strip_md" | "stripmd" => s(strip_md(v)),
        "strip_tags" => s(strip_tags(v, param.unwrap_or(""))),
        "table" | "table_pretty" => table(v, param, name == "table_pretty"),
        "template" => s(template(v, param)),
        "title" => s(title(v)),
        "trim" => s(js_trim(v)),
        "truncate" | "truncatewords" => {
            let parts: Vec<String> = param
                .map(|p| split_params(&unwrap_param_list(p)).iter().map(|t| clean_param_token(t)).collect())
                .unwrap_or_default();
            let limit = parts.first().and_then(|p| parse_int(p)).unwrap_or(0).max(0) as usize;
            let suffix = parts.get(1).cloned().unwrap_or_else(|| "…".into());
            let words = name == "truncatewords";
            map_strings(&c, |x| {
                if words {
                    truncate_words(x, limit, &suffix)
                } else {
                    truncate_chars(x, limit, &suffix)
                }
            })
            .into()
        }
        "uncamel" => s(uncamel(v)),
        "unescape" => s(v.replace("\\\"", "\"").replace("\\n", "\n")),
        "unique" => s(unique(v)),
        "wikilink" | "embed" => {
            let input = if matches!(c.raw_value, Value::Array(_)) {
                c.raw_value.to_json_string()
            } else {
                v.to_string()
            };
            s(wiki_reference(&input, param, if name == "embed" { "!" } else { "" }))
        }
        "yaml" => s(yaml(&c)),
        "yaml_property" => s(yaml_property(&c)),
        "where" => where_filter(&c),
        "html_to_json" => s(html_to_json(v)),
        "remove_html" => s(remove_html(v, param.unwrap_or(""))),
        "markdown" => {
            let base = match param {
                Some(p) => unquote_param_token(p),
                None => c.env.current_url.clone(),
            };
            let base = if base.is_empty() { None } else { Some(base.as_str()) };
            s(crate::markdown::html_to_markdown(v, base))
        }
        _ => return None,
    })
}

// ---- shared helpers ----------------------------------------------------------

/// JS `String.prototype.trim` (Unicode whitespace + BOM).
pub fn js_trim(s: &str) -> String {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').to_string()
}

fn is_plain_object(v: &Value) -> bool {
    matches!(v, Value::Object(_))
}

/// knap `inputValue`.
fn input_value(c: &FilterCall) -> Value {
    if matches!(c.raw_value, Value::Array(_)) || is_plain_object(c.raw_value) {
        return c.raw_value.clone();
    }
    if c.value.starts_with('[') || c.value.starts_with('{') {
        if let Some(p) = Value::parse_json(c.value) {
            if p.is_collection() {
                return p;
            }
        }
    }
    Value::str(c.value)
}

/// knap `collectionInputValue`.
fn collection_input_value(c: &FilterCall) -> Value {
    match c.raw_value {
        Value::Array(_) | Value::Object(_) => return c.raw_value.clone(),
        Value::String(_) => {}
        other => return other.clone(),
    }
    if c.value.starts_with('[') || c.value.starts_with('{') {
        if let Some(p) = Value::parse_json(c.value) {
            if p.is_collection() {
                return p;
            }
        }
    }
    Value::str(c.value)
}

fn map_string_values(v: Value, f: &dyn Fn(&str) -> String) -> Value {
    match v {
        Value::String(x) => Value::String(f(&x)),
        Value::Array(a) => Value::Array(a.into_iter().map(|i| map_string_values(i, f)).collect()),
        Value::Object(m) => Value::Object(Map(m.0.into_iter().map(|(k, i)| (k, map_string_values(i, f))).collect())),
        other => other,
    }
}

fn map_strings(c: &FilterCall, f: impl Fn(&str) -> String) -> Value {
    map_string_values(input_value(c), &f)
}

fn wrap_inline(value: &str, open: &str, close: &str) -> String {
    let content = js_trim(value);
    if content.is_empty() {
        return value.to_string();
    }
    let start = value.find(&content).unwrap_or(0);
    format!(
        "{}{open}{content}{close}{}",
        &value[..start],
        &value[start + content.len()..]
    )
}

fn is_multiline(v: &str) -> bool {
    v.contains('\n') || v.contains('\r')
}

fn split_blank_line_padding(value: &str) -> (String, String, String) {
    // leading: /^(?:[\t ]*\r?\n)+/
    let bytes = value.as_bytes();
    let mut lead_end = 0;
    let mut i = 0;
    loop {
        let mut j = i;
        while j < bytes.len() && (bytes[j] == b'\t' || bytes[j] == b' ') {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'\r' && bytes.get(j + 1) == Some(&b'\n') {
            j += 2;
        } else if j < bytes.len() && bytes[j] == b'\n' {
            j += 1;
        } else {
            break;
        }
        i = j;
        lead_end = j;
    }
    let rest = &value[lead_end..];
    // trailing: /(?:\r?\n[\t ]*)+$/
    let rb = rest.as_bytes();
    let mut end = rb.len();
    let mut trail_start = rb.len();
    loop {
        let mut k = end;
        while k > 0 && (rb[k - 1] == b'\t' || rb[k - 1] == b' ') {
            k -= 1;
        }
        if k > 0 && rb[k - 1] == b'\n' {
            k -= 1;
            if k > 0 && rb[k - 1] == b'\r' {
                k -= 1;
            }
            end = k;
            trail_start = k;
        } else {
            break;
        }
    }
    (
        value[..lead_end].to_string(),
        rest[..trail_start].to_string(),
        rest[trail_start..].to_string(),
    )
}

fn format_heading(level: usize, value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let prefix = format!("{} ", "#".repeat(level));
    let mut out = String::new();
    let mut line = String::new();
    let flush = |line: &mut String, out: &mut String| {
        if line.trim().is_empty() {
            out.push_str(line);
        } else {
            out.push_str(&prefix);
            out.push_str(line);
        }
        line.clear();
    };
    let chars: Vec<char> = value.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\r' && chars.get(i + 1) == Some(&'\n') {
            flush(&mut line, &mut out);
            out.push_str("\r\n");
            i += 2;
            continue;
        }
        if chars[i] == '\n' {
            flush(&mut line, &mut out);
            out.push('\n');
            i += 1;
            continue;
        }
        line.push(chars[i]);
        i += 1;
    }
    flush(&mut line, &mut out);
    out
}

fn hard_break(value: &str) -> String {
    // /^([^\r\n]*\S)[\t ]*(\r?\n)(?=[^\r\n]*\S)/gm → '$1  $2'
    let lines: Vec<&str> = value.split('\n').collect();
    let mut out = String::new();
    for (i, raw) in lines.iter().enumerate() {
        let is_last = i + 1 == lines.len();
        let (line, cr) = match raw.strip_suffix('\r') {
            Some(l) if !is_last => (l, "\r"),
            _ => (*raw, ""),
        };
        if is_last {
            out.push_str(raw);
            break;
        }
        let next_has_content = lines[i + 1].trim_end_matches('\r').chars().any(|c| !c.is_whitespace());
        let trimmed = line.trim_end_matches(['\t', ' ']);
        if next_has_content && trimmed.chars().last().is_some_and(|c| !c.is_whitespace()) {
            out.push_str(trimmed);
            out.push_str("  ");
        } else {
            out.push_str(line);
        }
        out.push_str(cr);
        out.push('\n');
    }
    out
}

fn highlight_marker(param: Option<&str>) -> Option<String> {
    let color = clean_scalar_param(param);
    let Some(color) = color else {
        return Some(String::new());
    };
    Some(
        match color.as_str() {
            "red" => "🔴",
            "orange" => "🟠",
            "yellow" => "🟡",
            "green" => "🟢",
            "blue" => "🔵",
            "purple" => "🟣",
            _ => return None,
        }
        .to_string(),
    )
}

fn append_block(value: &str, block: &str) -> String {
    if value.is_empty() {
        return block.to_string();
    }
    let trailing_newlines = {
        let t = value.trim_end_matches(['\t', ' ', '\r', '\n']);
        value[t.len()..].matches('\n').count()
    };
    if trailing_newlines >= 2 {
        format!("{value}{block}")
    } else if trailing_newlines == 1 {
        format!("{value}\n{block}")
    } else {
        format!("{value}\n\n{block}")
    }
}

fn prepend_block(value: &str, block: &str) -> String {
    if value.is_empty() {
        return block.to_string();
    }
    let leading_newlines = {
        let t = value.trim_start_matches(['\t', ' ', '\r', '\n']);
        value[..value.len() - t.len()].matches('\n').count()
    };
    if leading_newlines >= 2 {
        format!("{block}{value}")
    } else if leading_newlines == 1 {
        format!("{block}\n{value}")
    } else {
        format!("{block}\n\n{value}")
    }
}

fn longest_backtick_run(v: &str) -> usize {
    let mut best = 0;
    let mut cur = 0;
    for ch in v.chars() {
        if ch == '`' {
            cur += 1;
            best = best.max(cur);
        } else {
            cur = 0;
        }
    }
    best
}

fn format_inline_code(value: &str) -> String {
    let content = js_trim(value);
    if content.is_empty() {
        return value.to_string();
    }
    let start = value.find(&content).unwrap_or(0);
    let delim = "`".repeat((longest_backtick_run(&content) + 1).max(1));
    let pad = if content.starts_with('`') || content.ends_with('`') { " " } else { "" };
    format!(
        "{}{delim}{pad}{content}{pad}{delim}{}",
        &value[..start],
        &value[start + content.len()..]
    )
}

fn format_code_block(value: &str, lang: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let (lead, content, trail) = split_blank_line_padding(value);
    if content.is_empty() {
        return value.to_string();
    }
    let fence = "`".repeat((longest_backtick_run(&content) + 1).max(3));
    format!("{lead}{fence}{lang}\n{content}\n{fence}{trail}")
}

fn format_math_block(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    let (lead, content, trail) = split_blank_line_padding(value);
    if content.is_empty() {
        return value.to_string();
    }
    format!("{lead}$$\n{content}\n$${trail}")
}

// ---- individual filters --------------------------------------------------------

fn blockquote(input: &str) -> String {
    fn quote(s: &str, depth: usize) -> String {
        let prefix = "> ".repeat(depth);
        s.split('\n').map(|l| format!("{prefix}{l}")).collect::<Vec<_>>().join("\n")
    }
    fn arr(a: &[Value], depth: usize) -> String {
        a.iter()
            .map(|item| match item {
                Value::Array(inner) => arr(inner, depth + 1),
                other => quote(&other.js_string(), depth),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    match Value::parse_json(input) {
        Some(Value::Array(a)) => arr(&a, 1),
        Some(v @ Value::Object(_)) => quote(&v.to_json_pretty(2), 1),
        Some(v) => quote(&v.js_string(), 1),
        None => quote(input, 1),
    }
}

fn calc(c: &FilterCall) -> FilterOutput {
    let Some(param) = c.param else {
        return s(c.value);
    };
    let num = crate::value::string_to_number(c.value);
    if num.is_nan() {
        return warn(
            Value::str(c.value),
            format!("Could not parse \"{}\" as a number", c.value),
        );
    }
    let op = clean_scalar_param(Some(param)).unwrap_or_default();
    let op = op.trim();
    let operator = if op.starts_with("**") { "**" } else { op.get(..1).unwrap_or("") };
    let rest = &op[operator.len()..];
    let value = crate::value::string_to_number(rest);
    if value.is_nan() || rest.is_empty() && operator.is_empty() {
        return s(c.value);
    }
    let result = match operator {
        "+" => num + value,
        "-" => num - value,
        "*" => num * value,
        "/" => num / value,
        "**" | "^" => num.powf(value),
        _ => return s(c.value),
    };
    // Number(result.toFixed(10)).toString()
    if !result.is_finite() {
        return s(js_number(result));
    }
    let fixed = to_fixed(result, 10);
    s(js_number(fixed.parse::<f64>().unwrap_or(result)))
}

/// JS `Number.prototype.toFixed`.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return js_number(x);
    }
    if x.abs() >= 1e21 {
        return js_number(x);
    }
    let neg = x < 0.0;
    let ax = x.abs();
    let mut out = format!("{:.*}", digits, ax);
    // Ties round half up in JS; Rust rounds half to even.
    let exact = format!("{:.*}", digits + 60, ax);
    if let Some(dot) = exact.find('.') {
        let tail = &exact[dot + 1 + digits..];
        if tail.starts_with('5') && tail[1..].chars().all(|c| c == '0') {
            // Round up the truncated value.
            let truncated = &exact[..dot + 1 + digits];
            let truncated = truncated.trim_end_matches('.');
            let scaled: f64 = truncated.parse().unwrap_or(ax);
            let step = 10f64.powi(-(digits as i32));
            out = format!("{:.*}", digits, scaled + step);
        }
    }
    if neg && out.chars().any(|c| c.is_ascii_digit() && c != '0') {
        format!("-{out}")
    } else if neg {
        format!("-{out}")
    } else {
        out
    }
}

fn callout(v: &str, param: Option<&str>) -> String {
    let mut ty = "info".to_string();
    let mut title = String::new();
    let mut fold: Option<&str> = None;
    if let Some(p) = param {
        let params: Vec<String> = split_params(&unwrap_param_list(p)).iter().map(|t| unquote_param_token(t)).collect();
        if let Some(t) = params.first().filter(|t| !t.is_empty()) {
            ty = t.clone();
        }
        if let Some(t) = params.get(1).filter(|t| !t.is_empty()) {
            title = t.clone();
        }
        if let Some(f) = params.get(2) {
            match f.to_lowercase().as_str() {
                "true" => fold = Some("-"),
                "false" => fold = Some("+"),
                _ => {}
            }
        }
    }
    let mut header = format!("> [!{ty}]");
    if let Some(f) = fold {
        header.push_str(f);
    }
    if !title.is_empty() {
        header.push(' ');
        header.push_str(&title);
    }
    let body = v.split('\n').map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n");
    format!("{header}\n{body}")
}

fn camel(v: &str) -> String {
    // .replace(/(?:^\w|[A-Z]|\b\w)/g, (letter, index) => index === 0 ? lower : upper)
    let chars: Vec<char> = v.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::new();
    let mut utf16_index = 0usize;
    for (i, &ch) in chars.iter().enumerate() {
        let at_start = i == 0 && is_word(ch);
        let boundary = is_word(ch) && (i == 0 || !is_word(chars[i - 1]));
        if at_start || ch.is_ascii_uppercase() || boundary {
            if utf16_index == 0 {
                out.extend(ch.to_lowercase());
            } else {
                out.extend(ch.to_uppercase());
            }
        } else {
            out.push(ch);
        }
        utf16_index += ch.len_utf16();
    }
    // .replace(/[\s_-]+/g, '')
    out.chars().filter(|c| !(c.is_whitespace() || *c == '_' || *c == '-')).collect()
}

fn capitalize_str(s: &str) -> String {
    // str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() — UTF-16 based.
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.is_empty() {
        return String::new();
    }
    let first = String::from_utf16_lossy(&units[..1]);
    let rest = String::from_utf16_lossy(&units[1..]);
    format!("{}{}", first.to_uppercase(), rest.to_lowercase())
}

fn capitalize(input: &str) -> String {
    fn go(v: Value) -> Value {
        match v {
            Value::String(s) => Value::String(capitalize_str(&s)),
            Value::Array(a) => Value::Array(a.into_iter().map(go).collect()),
            Value::Object(m) => Value::Object(Map(m.0.into_iter().map(|(k, v)| (capitalize_str(&k), go(v))).collect())),
            other => other,
        }
    }
    match Value::parse_json(input) {
        Some(v) => go(v).to_json_string(),
        None => capitalize_str(input),
    }
}

fn date(c: &FilterCall) -> FilterOutput {
    let v = c.value;
    if v.is_empty() {
        return s("");
    }
    let tz = c.env.tz_offset_minutes;
    let parse_default = |input: &str| {
        if input == "now" {
            Some(crate::date::DateTime::from_epoch_ms(c.env.now_ms, tz))
        } else {
            crate::date::parse(input, tz)
        }
    };
    let Some(param) = c.param else {
        return match parse_default(v) {
            Some(d) => s(crate::date::format(&d, "YYYY-MM-DD")),
            None => s("Invalid Date"),
        };
    };
    let params: Vec<String> = split_params(&unwrap_param_list(param)).iter().map(|t| unquote_param_token(t)).collect();
    let output = params.first().cloned().unwrap_or_default();
    let input_fmt = params.get(1).filter(|f| !f.is_empty());
    let parsed = match input_fmt {
        Some(fmt) if v != "now" => crate::date::parse_with_format_at(v, fmt, true, tz, c.env.now_ms),
        Some(_) => parse_default(v),
        None => parse_default(v),
    };
    match parsed {
        Some(d) => s(crate::date::format(&d, &output)),
        None => warn(Value::str(v), format!("Could not parse \"{v}\" as a date")),
    }
}

fn date_modify(c: &FilterCall) -> FilterOutput {
    let v = c.value;
    let Some(param) = c.param else {
        return s(v);
    };
    if v.is_empty() {
        return s(v);
    }
    let tz = c.env.tz_offset_minutes;
    let Some(d) = crate::date::parse(v, tz) else {
        return warn(Value::str(v), format!("Could not parse \"{v}\" as a date"));
    };
    let p = clean_scalar_param(Some(param)).unwrap_or_default();
    let p = p.trim();
    // /^([+-])\s*(\d+)\s*(\w+)s?$/
    let re = Regex::new(r"^([+-])\s*(\d+)\s*(\w+)s?$").unwrap();
    let Some(caps) = re.captures(p) else {
        return s(v);
    };
    let sign = &caps[1];
    let amount: i64 = caps[2].parse().unwrap_or(0);
    let unit = &caps[3];
    let delta = if sign == "+" { amount } else { -amount };
    match crate::date::add(&d, delta, unit) {
        Some(nd) => s(crate::date::format(&nd, "YYYY-MM-DD")),
        None => s(crate::date::format(&d, "YYYY-MM-DD")),
    }
}

pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let h = s.get(i + 1..i + 3)?;
            let b = u8::from_str_radix(h, 16).ok()?;
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn duration(v: &str, param: Option<&str>) -> String {
    if v.is_empty() {
        return String::new();
    }
    // str.replace(/^["'](.*)["']$/g, '$1')
    let mut t = v.to_string();
    if t.len() >= 2 && (t.starts_with('"') || t.starts_with('\'')) && (t.ends_with('"') || t.ends_with('\'')) && !t[1..t.len() - 1].contains('\n') {
        t = t[1..t.len() - 1].to_string();
    }
    let re = Regex::new(r"^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$").unwrap();
    let total: i64 = match re.captures(&t) {
        Some(caps) => {
            let g = |i: usize, mul: i64| caps.get(i).and_then(|m| m.as_str().parse::<i64>().ok()).unwrap_or(0) * mul;
            g(1, 365 * 24 * 3600) + g(2, 30 * 24 * 3600) + g(3, 24 * 3600) + g(4, 3600) + g(5, 60) + g(6, 1)
        }
        None => match parse_int(&t) {
            Some(n) => n,
            None => return t,
        },
    };
    let hours_f = total as f64 / 3600.0;
    let fmt = match param {
        Some(p) => {
            // format.replace(/^["'(](.*)["')]$/g, '$1')
            let p = p.to_string();
            let first = p.chars().next();
            let last = p.chars().last();
            if p.chars().count() >= 2
                && matches!(first, Some('"' | '\'' | '('))
                && matches!(last, Some('"' | '\'' | ')'))
                && !p.contains('\n')
            {
                p.chars().skip(1).take(p.chars().count() - 2).collect()
            } else {
                p
            }
        }
        None => {
            if hours_f >= 1.0 {
                "HH:mm:ss".into()
            } else {
                "mm:ss".into()
            }
        }
    };
    let hours = hours_f.floor() as i64;
    // dayjs duration minutes()/seconds() use a year=365d, month=30d breakdown;
    // for the hour-based output the remainder math is the same.
    let rem = total.rem_euclid(3600);
    let minutes = rem / 60;
    let seconds = rem % 60;
    let re_tok = Regex::new("HH|H|mm|m|ss|s").unwrap();
    re_tok
        .replace_all(&fmt, |caps: &regex_lite::Captures| match &caps[0] {
            "HH" => format!("{:02}", hours),
            "H" => hours.to_string(),
            "mm" => format!("{:02}", minutes),
            "m" => minutes.to_string(),
            "ss" => format!("{:02}", seconds),
            _ => seconds.to_string(),
        })
        .into_owned()
}

fn first_last(v: &str, first: bool) -> String {
    if v.is_empty() {
        return String::new();
    }
    if let Some(Value::Array(a)) = Value::parse_json(v) {
        let item = if first { a.first() } else { a.last() };
        if let Some(item) = item {
            return match item {
                Value::Null | Value::Undefined => String::new(),
                other => other.js_string(),
            };
        }
    }
    v.to_string()
}

fn footnote(v: &str) -> String {
    if v.is_empty() {
        return String::new();
    }
    match Value::parse_json(v) {
        Some(Value::Array(a)) => a
            .iter()
            .enumerate()
            .map(|(i, item)| format!("[^{}]: {}", i + 1, item.js_string()))
            .collect::<Vec<_>>()
            .join("\n\n"),
        Some(Value::Object(m)) => m
            .iter()
            .map(|(k, val)| {
                let id = kebab_like(k, "-").to_lowercase();
                format!("[^{id}]: {}", val.js_string())
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => v.to_string(),
    }
}

/// `.replace(/([a-z])([A-Z])/g, '$1<sep>$2').replace(/[\s_]+/g, sep)`
fn kebab_like(v: &str, sep: &str) -> String {
    let chars: Vec<char> = v.chars().collect();
    let mut step1 = String::new();
    let mut i = 0;
    while i < chars.len() {
        step1.push(chars[i]);
        if chars[i].is_ascii_lowercase() && chars.get(i + 1).is_some_and(|c| c.is_ascii_uppercase()) {
            step1.push_str(sep);
            step1.push(chars[i + 1]);
            i += 2;
            continue;
        }
        i += 1;
    }
    let mut out = String::new();
    let mut in_run = false;
    for ch in step1.chars() {
        if ch.is_whitespace() || ch == '_' {
            if !in_run {
                out.push_str(sep);
                in_run = true;
            }
        } else {
            in_run = false;
            out.push(ch);
        }
    }
    out
}

fn kebab(v: &str) -> String {
    kebab_like(v, "-").to_lowercase()
}

fn snake(v: &str) -> String {
    // .replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase()
    let chars: Vec<char> = v.chars().collect();
    let mut step1 = String::new();
    let mut i = 0;
    while i < chars.len() {
        step1.push(chars[i]);
        if chars[i].is_ascii_lowercase() && chars.get(i + 1).is_some_and(|c| c.is_ascii_uppercase()) {
            step1.push('_');
            step1.push(chars[i + 1]);
            i += 2;
            continue;
        }
        i += 1;
    }
    let mut out = String::new();
    let mut in_run = false;
    for ch in step1.chars() {
        if ch.is_whitespace() || ch == '-' {
            if !in_run {
                out.push('_');
                in_run = true;
            }
        } else {
            in_run = false;
            out.push(ch);
        }
    }
    out.to_lowercase()
}

fn pascal(v: &str) -> String {
    // .replace(/[\s_-]+(.)/g, (_, c) => c.toUpperCase()).replace(/^(.)/, c => c.toUpperCase())
    let chars: Vec<char> = v.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() || c == '_' || c == '-' {
            let mut j = i;
            while j < chars.len() && (chars[j].is_whitespace() || chars[j] == '_' || chars[j] == '-') {
                j += 1;
            }
            if j < chars.len() && chars[j] != '\n' {
                out.extend(chars[j].to_uppercase());
                i = j + 1;
                continue;
            }
            // No following char: keep the run.
            for k in &chars[i..j] {
                out.push(*k);
            }
            i = j;
            continue;
        }
        out.push(c);
        i += 1;
    }
    let mut cs = out.chars();
    match cs.next() {
        Some(f) if f != '\n' => f.to_uppercase().chain(cs).collect(),
        Some(f) => std::iter::once(f).chain(cs).collect(),
        None => String::new(),
    }
}

fn uncamel(v: &str) -> String {
    let chars: Vec<char> = v.chars().collect();
    let mut step = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if i > 0 && c.is_ascii_uppercase() && (chars[i - 1].is_ascii_lowercase() || chars[i - 1].is_ascii_digit()) {
            step.push(' ');
        }
        step.push(c);
    }
    let chars: Vec<char> = step.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        out.push(chars[i]);
        if chars[i].is_ascii_uppercase()
            && chars.get(i + 1).is_some_and(|c| c.is_ascii_uppercase())
            && chars.get(i + 2).is_some_and(|c| c.is_ascii_lowercase())
        {
            out.push(' ');
        }
        i += 1;
    }
    out.to_lowercase()
}

fn fragment_link(v: &str, param: Option<&str>) -> FilterOutput {
    let arr = |items: Vec<Value>| FilterOutput::from(Value::Array(items));
    let Some(param) = param else {
        return arr(vec![Value::str(v)]);
    };
    if js_trim(v).is_empty() {
        return arr(vec![Value::str(v)]);
    }
    let param = {
        let p = param;
        let first = p.chars().next();
        if p.len() >= 2 && matches!(first, Some('"' | '\'')) && p.ends_with(first.unwrap()) {
            p[1..p.len() - 1].to_string()
        } else {
            p.to_string()
        }
    };
    // /^(.*?):?((https?:\/\/|file:\/\/).*$)/
    let re = Regex::new(r"^(.*?):?((https?://|file://).*$)").unwrap();
    let (linktext, source) = match re.captures(&param) {
        Some(caps) => {
            let lt = caps.get(1).map(|m| m.as_str().trim().replace(['"', '\''], "")).unwrap_or_default();
            (
                if lt.is_empty() { "link".to_string() } else { lt },
                caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_else(|| param.clone()),
            )
        }
        None => ("link".to_string(), param.clone()),
    };
    let frag = |text: &str| -> String {
        let stripped = strip_md(text);
        let words: Vec<&str> = stripped.split_whitespace().collect();
        let (start, end) = if words.len() > 10 {
            (words[..5].join(" "), Some(words[words.len() - 5..].join(" ")))
        } else {
            (words.join(" "), None)
        };
        let enc_end = end.map(|e| format!(",{}", encode_uri_component(&e))).unwrap_or_default();
        format!("#:~:text={}{}", encode_uri_component(&start), enc_end)
    };
    let make = |text: &str| format!("{text} [{linktext}]({source}{})", frag(text));
    match Value::parse_json(v) {
        Some(Value::Array(items)) => arr(items
            .into_iter()
            .map(|item| match item {
                Value::Object(mut m) if m.contains_key("text") => {
                    let t = m.get("text").cloned().unwrap_or_default();
                    let ts = t.js_string();
                    m.insert("text", Value::String(format!("{ts} [{linktext}]({source}{})", frag(&ts))));
                    Value::Object(m)
                }
                other => Value::String(make(&other.js_string())),
            })
            .collect()),
        Some(Value::Object(m)) => arr(m.values().map(|val| Value::String(make(&val.js_string()))).collect()),
        Some(Value::String(t)) => arr(vec![Value::String(make(&t))]),
        _ => arr(vec![Value::str(v)]),
    }
}

/// knap `escapeMarkdown`.
fn escape_markdown(v: &str) -> String {
    let mut out = String::new();
    let mut chars = v.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '&' => out.push_str("&amp;"),
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' => {
                out.push('\\');
                out.push(c);
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push(' ');
            }
            '\n' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

/// knap `markdownDestination`.
fn markdown_destination(v: &str) -> String {
    let normalized: String = v.chars().filter(|c| *c as u32 > 0x20 && *c as u32 != 0x7f).collect();
    let lower = normalized.to_ascii_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("vbscript:") || lower.starts_with("data:") {
        return String::new();
    }
    let re = Regex::new(r"(?i)&(#\d+;|#x[\da-f]+;|[a-z][a-z\d]+;)").unwrap();
    let step = re.replace_all(v, "%26$1").into_owned();
    let mut out = String::new();
    for ch in step.chars() {
        let cp = ch as u32;
        if cp <= 0x20 || cp == 0x7f || "()[]<>\\\"`".contains(ch) {
            out.push_str(&format!("%{:02X}", cp));
        } else {
            out.push(ch);
        }
    }
    out
}

fn image(v: &str, param: Option<&str>) -> FilterOutput {
    if js_trim(v).is_empty() {
        return s(v);
    }
    let alt = escape_markdown(&param.and_then(|p| unquote_scalar_param(Some(p))).unwrap_or_default());
    fn process_object(m: &Map, out: &mut Vec<Value>) {
        for (k, val) in m.iter() {
            match val {
                Value::Object(inner) => process_object(inner, out),
                Value::Array(_) => {
                    // Object.entries on an array yields index keys.
                    if let Value::Array(items) = val {
                        let mm = Map(items.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect());
                        process_object(&mm, out);
                    }
                }
                other => out.push(Value::String(format!(
                    "![{}]({})",
                    escape_markdown(&other.js_string()),
                    markdown_destination(k)
                ))),
            }
        }
    }
    match Value::parse_json(v) {
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for item in items {
                match &item {
                    Value::Object(m) => process_object(m, &mut out),
                    Value::Array(a) => {
                        let mm = Map(a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect());
                        process_object(&mm, &mut out);
                    }
                    other => out.push(Value::String(if other.truthy() {
                        format!("![{alt}]({})", markdown_destination(&other.js_string()))
                    } else {
                        String::new()
                    })),
                }
            }
            Value::Array(out).into()
        }
        Some(Value::Object(m)) => {
            let mut out = Vec::new();
            process_object(&m, &mut out);
            Value::Array(out).into()
        }
        Some(_) => s(v),
        None => s(format!("![{alt}]({})", markdown_destination(v))),
    }
}

fn link(v: &str, param: Option<&str>) -> String {
    if js_trim(v).is_empty() {
        return v.to_string();
    }
    let text = escape_markdown(&param.and_then(|p| unquote_scalar_param(Some(p))).unwrap_or_else(|| "link".into()));
    fn process_object(m: &Map, out: &mut Vec<String>) {
        for (k, val) in m.iter() {
            match val {
                Value::Object(inner) => process_object(inner, out),
                Value::Array(items) => {
                    let mm = Map(items.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect());
                    process_object(&mm, out);
                }
                other => out.push(format!(
                    "[{}]({})",
                    escape_markdown(&other.js_string()),
                    markdown_destination(k)
                )),
            }
        }
    }
    match Value::parse_json(v) {
        Some(Value::Array(items)) => {
            let mut lines = Vec::new();
            for item in items {
                match &item {
                    Value::Object(m) => {
                        let mut o = Vec::new();
                        process_object(m, &mut o);
                        lines.push(o.join(","));
                    }
                    Value::Array(a) => {
                        let mut o = Vec::new();
                        let mm = Map(a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect());
                        process_object(&mm, &mut o);
                        lines.push(o.join(","));
                    }
                    other => lines.push(if other.truthy() {
                        format!("[{text}]({})", markdown_destination(&other.js_string()))
                    } else {
                        String::new()
                    }),
                }
            }
            lines.join("\n")
        }
        Some(Value::Object(m)) => {
            let mut o = Vec::new();
            process_object(&m, &mut o);
            o.join("\n")
        }
        Some(_) => v.to_string(),
        None => format!("[{text}]({})", markdown_destination(v)),
    }
}

fn indent(v: &str, param: Option<&str>) -> String {
    let width = match param {
        None => 2,
        Some(p) => {
            let w = clean_scalar_param(Some(p)).unwrap_or_default();
            if !w.chars().all(|c| c.is_ascii_digit()) || w.is_empty() {
                return v.to_string();
            }
            match w.parse::<usize>() {
                Ok(n) if n <= 1000 => n,
                _ => return v.to_string(),
            }
        }
    };
    let prefix = " ".repeat(width);
    let mut out = String::new();
    let mut line = String::new();
    for ch in v.chars() {
        if ch == '\r' || ch == '\n' {
            if !line.is_empty() {
                out.push_str(&prefix);
                out.push_str(&line);
                line.clear();
            }
            out.push(ch);
        } else {
            line.push(ch);
        }
    }
    if !line.is_empty() {
        out.push_str(&prefix);
        out.push_str(&line);
    }
    out
}

fn join(v: &str, param: Option<&str>) -> String {
    if v.is_empty() || v == "undefined" || v == "null" {
        return String::new();
    }
    let Some(Value::Array(items)) = Value::parse_json(v) else {
        return v.to_string();
    };
    let sep = match param {
        Some(p) => unquote_scalar_param(Some(p)).unwrap_or_else(|| ",".into()).replace("\\n", "\n"),
        None => ",".into(),
    };
    items
        .iter()
        .map(|i| match i {
            Value::Null | Value::Undefined => String::new(),
            other => other.js_string(),
        })
        .collect::<Vec<_>>()
        .join(&sep)
}

fn length(v: &str) -> String {
    match Value::parse_json(v) {
        Some(Value::Array(a)) => a.len().to_string(),
        Some(Value::Object(m)) => m.len().to_string(),
        _ => utf16_len(v).to_string(),
    }
}

fn list(v: &str, param: Option<&str>) -> String {
    let option = clean_scalar_param(param);
    if v.is_empty() {
        return String::new();
    }
    let ty = match option.as_deref() {
        Some("numbered") => "numbered",
        Some("task") => "task",
        Some("numbered-task") => "numbered-task",
        _ => "bullet",
    };
    fn item(v: &Value, ty: &str, depth: usize) -> String {
        if let Value::Array(a) = v {
            return array(a, ty, depth + 1);
        }
        let prefix = match ty {
            "numbered" => "1. ",
            "task" => "- [ ] ",
            "numbered-task" => "1. [ ] ",
            _ => "- ",
        };
        format!("{}{}{}", "\t".repeat(depth), prefix, v.js_string())
    }
    fn array(a: &[Value], ty: &str, depth: usize) -> String {
        a.iter()
            .enumerate()
            .map(|(i, x)| {
                let line = item(x, ty, depth);
                if ty == "numbered" || ty == "numbered-task" {
                    // .replace(/^\d+/, number)
                    let digits = line.chars().take_while(|c| c.is_ascii_digit()).count();
                    if digits > 0 {
                        return format!("{}{}", i + 1, &line[digits..]);
                    }
                }
                line
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    match Value::parse_json(v) {
        Some(Value::Array(a)) => array(&a, ty, 0),
        Some(other) => array(&[other], ty, 0),
        None => item(&Value::str(v), ty, 0),
    }
}

fn map_filter(c: &FilterCall) -> FilterOutput {
    let Some(param) = c.param else {
        return s(c.value);
    };
    let arrow = Regex::new(r"^\s*(\w+)\s*=>\s*(.+)$").unwrap();
    if arrow.is_match(param) {
        return s(map_with_arrow(c.value, param));
    }
    let path = match c.raw_args.and_then(|a| a.first()) {
        Some(Value::String(p)) => Some(p.clone()),
        Some(Value::Undefined) | None => Some(unquote_param_token(&unwrap_param_list(param))),
        Some(_) => None,
    };
    let input = collection_input_value(c);
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return input.into();
    };
    match input {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| own_property_at_path(item, &path).unwrap_or(Value::Null))
                .collect(),
        )
        .into(),
        other => other.into(),
    }
}

fn own_property(v: &Value, key: &str) -> Option<Value> {
    match v {
        Value::Object(m) => m.get(key).cloned(),
        Value::Array(a) => {
            if key == "length" {
                return Some(Value::Number(a.len() as f64));
            }
            key.parse::<usize>().ok().and_then(|i| a.get(i).cloned())
        }
        Value::String(s) => {
            if key == "length" {
                return Some(Value::Number(utf16_len(s) as f64));
            }
            key.parse::<i64>().ok().map(|i| Value::String(utf16_slice(s, Some(i), Some(i + 1)))).filter(|v| v.as_str() != Some(""))
        }
        _ => None,
    }
}

fn own_property_at_path(v: &Value, path: &str) -> Option<Value> {
    if path.is_empty() || path.split('.').any(|s| s.is_empty()) {
        return None;
    }
    let mut cur = v.clone();
    for seg in path.split('.') {
        cur = own_property(&cur, seg)?;
    }
    Some(cur)
}

fn map_with_arrow(v: &str, param: &str) -> String {
    let array = Value::parse_json(v).unwrap_or_else(|| Value::Array(vec![Value::str(v)]));
    let Value::Array(items) = array else {
        return v.to_string();
    };
    let arrow = Regex::new(r"^\s*(\w+)\s*=>\s*(.+)$").unwrap();
    let Some(caps) = arrow.captures(param) else {
        return v.to_string();
    };
    let arg = caps[1].to_string();
    let expression = caps[2].to_string();
    let mapped: Vec<Value> = items
        .iter()
        .map(|item| {
            let mut expr = expression.trim().to_string();
            if expr.starts_with('(') && expr.ends_with(')') {
                expr = expr[1..expr.len() - 1].trim().to_string();
            }
            let is_obj = expr.starts_with('{') && expr.ends_with('}');
            let is_str = expr.len() >= 2
                && ((expr.starts_with('"') && expr.ends_with('"')) || (expr.starts_with('\'') && expr.ends_with('\'')));
            if is_obj {
                let mut m = Map::new();
                for assignment in split_params(&expr[1..expr.len() - 1]) {
                    let (key, value) = split_param_pair(&assignment);
                    let Some(value) = value else { continue };
                    let clean_key = {
                        let k = key.as_str();
                        if k.len() >= 3 && (k.starts_with('"') || k.starts_with('\'')) && (k.ends_with('"') || k.ends_with('\'')) {
                            k[1..k.len() - 1].to_string()
                        } else {
                            k.to_string()
                        }
                    };
                    m.insert(clean_key, evaluate_arrow_expression(&value, item, &arg));
                }
                Value::Object(m)
            } else if is_str {
                let lit = &expr[1..expr.len() - 1];
                let needle = format!("${{{arg}}}");
                Value::String(lit.replace(&needle, &item.js_string()))
            } else {
                evaluate_arrow_expression(&expression, item, &arg)
            }
        })
        .collect();
    Value::Array(mapped).to_json_string()
}

fn evaluate_arrow_expression(expression: &str, item: &Value, arg: &str) -> Value {
    if let Value::String(s) = item {
        return Value::String(s.clone());
    }
    let re = Regex::new(&format!(r"{}\.([\w.\[\]]+)", regex_lite::escape(arg))).unwrap();
    let result = re
        .replace_all(expression, |caps: &regex_lite::Captures| {
            let prop = &caps[1];
            let mut cur = Some(item.clone());
            for key in prop.split(['.', '[', ']']).filter(|k| !k.is_empty()) {
                cur = cur.and_then(|c| own_property(&c, key));
            }
            match cur {
                Some(v) => v.to_json().unwrap_or_else(|| "undefined".into()),
                None => "undefined".into(),
            }
        })
        .into_owned();
    match Value::parse_json(&result) {
        Some(v) => v,
        None => {
            // .replace(/^["'](.+)["']$/, '$1')
            let r = result.as_str();
            if r.len() >= 3 && (r.starts_with('"') || r.starts_with('\'')) && (r.ends_with('"') || r.ends_with('\'')) && !r.contains('\n') {
                Value::String(r[1..r.len() - 1].to_string())
            } else {
                Value::String(result)
            }
        }
    }
}

fn merge(c: &FilterCall) -> String {
    let v = c.value;
    if v.is_empty() || v == "undefined" || v == "null" {
        return "[]".into();
    }
    let values = match c.raw_value {
        Value::Array(a) => a.clone(),
        _ => match Value::parse_json(v) {
            Some(Value::Array(a)) => a,
            _ => vec![Value::str(v)],
        },
    };
    let Some(param) = c.param else {
        return Value::Array(values).to_json_string();
    };
    let single = c.raw_args.filter(|a| a.len() == 1).and_then(|a| a[0].as_str().map(|s| s.to_string()));
    let list_src = match &single {
        Some(s) if s.contains(',') => s.as_str(),
        _ => param,
    };
    let mut all = values;
    all.extend(split_param_list(list_src).iter().map(|t| Value::String(unquote_param_token(t))));
    Value::Array(all).to_json_string()
}

fn number_format(v: &str, param: Option<&str>) -> String {
    let mut decimals: i64 = 0;
    let mut dec_point = ".".to_string();
    let mut sep = ",".to_string();
    let unescape = |s: &str| {
        let mut out = String::new();
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                    continue;
                }
            }
            out.push(c);
        }
        out
    };
    if let Some(p) = param {
        let params: Vec<String> = split_params(&unwrap_param_list(p)).iter().map(|t| unquote_param_token(t)).collect();
        if let Some(d) = params.first() {
            decimals = parse_int(d).unwrap_or(0);
        }
        if let Some(d) = params.get(1) {
            dec_point = unescape(d);
        }
        if let Some(d) = params.get(2) {
            sep = unescape(d);
        }
    }
    let decimals = decimals.clamp(0, 100) as usize;
    let fmt_num = |n: f64| -> String {
        let fixed = to_fixed(n, decimals);
        let (int_part, frac) = match fixed.split_once('.') {
            Some((a, b)) => (a.to_string(), Some(b.to_string())),
            None => (fixed.clone(), None),
        };
        // \B(?=(\d{3})+(?!\d)) over the integer part (sign kept).
        let (sign, digits) = if let Some(d) = int_part.strip_prefix('-') { ("-", d.to_string()) } else { ("", int_part.clone()) };
        let mut grouped = String::new();
        let len = digits.len();
        for (i, ch) in digits.chars().enumerate() {
            if i > 0 && (len - i) % 3 == 0 && digits.chars().all(|c| c.is_ascii_digit()) {
                grouped.push_str(&sep);
            }
            grouped.push(ch);
        }
        let mut out = format!("{sign}{grouped}");
        if let Some(f) = frac {
            out.push_str(&dec_point);
            out.push_str(&f);
        }
        out
    };
    fn process(val: Value, f: &dyn Fn(f64) -> String) -> Value {
        match val {
            Value::Number(n) => Value::String(f(n)),
            Value::String(s) if !parse_float(&s).is_nan() => Value::String(f(parse_float(&s))),
            Value::Array(a) => Value::Array(a.into_iter().map(|x| process(x, f)).collect()),
            Value::Object(m) => Value::Object(Map(m.0.into_iter().map(|(k, x)| (k, process(x, f))).collect())),
            other => other,
        }
    }
    let parsed = Value::parse_json(v).unwrap_or_else(|| Value::str(v));
    match process(parsed, &fmt_num) {
        Value::String(s) => s,
        other => other.to_json_string(),
    }
}

fn nth(v: &str, params: Option<&str>) -> FilterOutput {
    if v.is_empty() || v == "undefined" || v == "null" {
        return s(v);
    }
    let Some(parsed) = Value::parse_json(v) else {
        return warn(Value::str(v), "Could not parse value as a JSON array");
    };
    let Value::Array(data) = parsed else {
        return s(v);
    };
    let Some(params) = params else {
        return s(Value::Array(data).to_json_string());
    };
    let pick = |f: &dyn Fn(usize) -> bool| -> FilterOutput {
        s(Value::Array(data.iter().enumerate().filter(|(i, _)| f(*i)).map(|(_, x)| x.clone()).collect()).to_json_string())
    };
    if params.contains(':') {
        let mut split = params.split(':').map(|p| p.trim());
        let positions = split.next().unwrap_or("");
        let basis = split.next().unwrap_or("");
        let nths: Vec<i64> = positions.split(',').filter_map(|n| parse_int(n.trim())).filter(|n| *n > 0).collect();
        let basis = parse_int(basis).unwrap_or(0);
        if basis <= 0 {
            return pick(&|_| false);
        }
        return pick(&|i| nths.contains(&((i as i64 % basis) + 1)));
    }
    let expr = params.trim();
    if !expr.is_empty() && expr.chars().all(|c| c.is_ascii_digit()) {
        let pos: usize = expr.parse().unwrap_or(0);
        return pick(&|i| i + 1 == pos);
    }
    if let Some(m) = expr.strip_suffix('n') {
        if !m.is_empty() && m.chars().all(|c| c.is_ascii_digit()) {
            let mult: usize = m.parse().unwrap_or(1);
            if mult == 0 {
                return pick(&|_| false);
            }
            return pick(&|i| (i + 1) % mult == 0);
        }
    }
    if let Some(off) = expr.strip_prefix("n+") {
        if !off.is_empty() && off.chars().all(|c| c.is_ascii_digit()) {
            let offset: usize = off.parse().unwrap_or(0);
            return pick(&|i| i + 1 >= offset);
        }
    }
    s(v)
}

fn object(v: &str, param: Option<&str>) -> FilterOutput {
    let option = clean_scalar_param(param);
    match Value::parse_json(v) {
        Some(val) if val.is_collection() => {
            let entries: Vec<(String, Value)> = match &val {
                Value::Object(m) => m.0.clone(),
                Value::Array(a) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
                _ => vec![],
            };
            match option.as_deref() {
                Some("array") => s(Value::Array(entries.into_iter().map(|(k, x)| Value::Array(vec![Value::String(k), x])).collect()).to_json_string()),
                Some("keys") => s(Value::Array(entries.into_iter().map(|(k, _)| Value::String(k)).collect()).to_json_string()),
                Some("values") => s(Value::Array(entries.into_iter().map(|(_, x)| x).collect()).to_json_string()),
                _ => s(v),
            }
        }
        Some(_) => s(v),
        None => warn(Value::str(v), "Could not parse value as JSON"),
    }
}

fn reverse(v: &str) -> String {
    if v.is_empty() || v == "undefined" || v == "null" {
        return String::new();
    }
    match Value::parse_json(v) {
        Some(Value::Array(mut a)) => {
            a.reverse();
            Value::Array(a).to_json_string()
        }
        Some(Value::Object(mut m)) => {
            m.0.reverse();
            Value::Object(m).to_json_string()
        }
        Some(_) => v.to_string(),
        None => {
            // str.split('').reverse().join('') — UTF-16 units.
            let mut units: Vec<u16> = v.encode_utf16().collect();
            units.reverse();
            String::from_utf16_lossy(&units)
        }
    }
}

fn remove_attr(html: &str, remove: &str) -> String {
    if remove.is_empty() {
        return html.to_string();
    }
    let list: Vec<String> = normalize_param_list(remove).into_iter().map(|a| a.to_lowercase()).filter(|a| !a.is_empty()).collect();
    if list.is_empty() {
        return html.to_string();
    }
    let tag_re = Regex::new(r"<(\w+)\s+([^>]*?)>").unwrap();
    let attr_re = Regex::new(r#"([a-zA-Z0-9_:-]+(?:\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^'"\s>]+))?)|(\s*/?\s*$)"#).unwrap();
    tag_re
        .replace_all(html, |caps: &regex_lite::Captures| {
            let tag = &caps[1];
            let attrs = &caps[2];
            let mut keep: Vec<String> = Vec::new();
            for m in attr_re.captures_iter(attrs) {
                let full = m.get(0).map(|x| x.as_str()).unwrap_or("");
                if let Some(attr) = m.get(1) {
                    let name: String = attr.as_str().chars().take_while(|c| c.is_ascii_alphanumeric() || "_:-".contains(*c)).collect();
                    if !list.contains(&name.to_lowercase()) {
                        keep.push(attr.as_str().to_string());
                    }
                } else if m.get(2).is_some() && full.contains('/') {
                    keep.push(full.trim().to_string());
                }
            }
            let cleaned = keep.join(" ").trim().to_string();
            if cleaned.is_empty() {
                format!("<{tag}>")
            } else {
                format!("<{tag} {cleaned}>")
            }
        })
        .into_owned()
}

fn remove_tags(html: &str, tags: &str) -> String {
    if tags.is_empty() {
        return html.to_string();
    }
    let list: Vec<String> = normalize_param_list(tags).into_iter().filter(|t| !t.is_empty()).collect();
    if list.is_empty() {
        return html.to_string();
    }
    let escaped: Vec<String> = list.iter().map(|t| regex_lite::escape(t)).collect();
    let Ok(re) = Regex::new(&format!(r"(?i)</?(?:{})\b[^>]*>", escaped.join("|"))) else {
        return html.to_string();
    };
    re.replace_all(html, "").into_owned()
}

fn replace_tags(html: &str, params: &str) -> Result<String, String> {
    let tokens: Vec<String> = split_param_list(params).into_iter().filter(|t| !t.is_empty()).collect();
    let clean = |v: &str| {
        let u = unquote_param_token(v);
        let mut out = String::new();
        let mut cs = u.chars();
        while let Some(c) = cs.next() {
            if c == '\\' {
                if let Some(n) = cs.next() {
                    out.push(n);
                    continue;
                }
            }
            out.push(c);
        }
        out
    };
    let mut transforms = Vec::new();
    for t in &tokens {
        let (a, b) = split_param_pair(t);
        transforms.push((clean(&a), b.map(|b| clean(&b)).unwrap_or_default()));
    }
    let valid = |n: &str| {
        let mut cs = n.chars();
        cs.next().is_some_and(|c| c.is_ascii_alphabetic()) && cs.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':' || c == '-')
    };
    if transforms.iter().any(|(src, tgt)| !valid(src) || (!tgt.is_empty() && !valid(tgt))) {
        return Err("replace_tags requires tag names".into());
    }
    let mut result = html.to_string();
    for (src, tgt) in transforms {
        let open = Regex::new(&format!(r"<{}(\s+[^>]*?)?>", regex_lite::escape(&src))).unwrap();
        result = open
            .replace_all(&result, |caps: &regex_lite::Captures| {
                if tgt.is_empty() {
                    String::new()
                } else {
                    format!("<{}{}>", tgt, caps.get(1).map(|m| m.as_str()).unwrap_or(""))
                }
            })
            .into_owned();
        let close = format!("</{src}>");
        result = result.replace(&close, &if tgt.is_empty() { String::new() } else { format!("</{tgt}>") });
    }
    Ok(result)
}

fn split_replacement_pair(value: &str) -> Option<(String, String)> {
    let chars: Vec<char> = value.chars().collect();
    let mut quote: Option<char> = None;
    let mut in_regex = false;
    let mut escaped = false;
    for (i, &c) in chars.iter().enumerate() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if let Some(q) = quote {
            if c == q {
                quote = None;
            }
        } else if in_regex {
            if c == '/' {
                in_regex = false;
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
        } else if c == '/' && chars[..i].iter().all(|x| x.is_whitespace()) {
            in_regex = true;
        } else if c == ':' {
            return Some((chars[..i].iter().collect(), chars[i + 1..].iter().collect()));
        }
    }
    None
}

fn process_escaped(s: &str) -> String {
    let mut out = String::new();
    let mut cs = s.chars();
    while let Some(c) = cs.next() {
        if c == '\\' {
            match cs.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some(o) => out.push(o),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Translate a JS regex source + flags into regex-lite syntax.
pub fn js_regex(pattern: &str, flags: &str) -> Result<Regex, String> {
    let mut src = String::new();
    let mut inline = String::new();
    if flags.contains('i') {
        inline.push('i');
    }
    if flags.contains('m') {
        inline.push('m');
    }
    if flags.contains('s') {
        inline.push('s');
    }
    if !inline.is_empty() {
        src.push_str(&format!("(?{inline})"));
    }
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    let mut in_class = false;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            let n = chars[i + 1];
            match n {
                '/' => src.push('/'),
                'd' | 'D' | 'w' | 'W' | 'b' | 'B' | 'n' | 'r' | 't' | 'f' | 'v' | '\\' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '^' | '$' | '-' => {
                    src.push('\\');
                    src.push(n);
                }
                's' => src.push_str(if in_class {
                    r"\t\n\x0B\x0C\r \x{A0}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}"
                } else {
                    r"[\t\n\x0B\x0C\r \x{A0}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]"
                }),
                'S' => src.push_str(if in_class { r"\S" } else { r"[^\t\n\x0B\x0C\r \x{A0}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]" }),
                'u' if chars.get(i + 2) == Some(&'{') => {
                    let end = chars[i..].iter().position(|x| *x == '}').map(|p| p + i).unwrap_or(chars.len() - 1);
                    let hex: String = chars[i + 3..end].iter().collect();
                    src.push_str(&format!("\\x{{{hex}}}"));
                    i = end + 1;
                    continue;
                }
                'u' if i + 5 < chars.len() + 0 && chars[i + 2..].len() >= 4 => {
                    let hex: String = chars[i + 2..i + 6].iter().collect();
                    src.push_str(&format!("\\x{{{hex}}}"));
                    i += 6;
                    continue;
                }
                'x' if chars[i + 2..].len() >= 2 => {
                    let hex: String = chars[i + 2..i + 4].iter().collect();
                    src.push_str(&format!("\\x{{{hex}}}"));
                    i += 4;
                    continue;
                }
                c2 if c2.is_ascii_digit() => {
                    return Err("backreferences are not supported".into());
                }
                other => {
                    if other.is_ascii_alphanumeric() {
                        src.push('\\');
                        src.push(other);
                    } else {
                        // Escaped punctuation JS allows: make it literal.
                        src.push_str(&regex_lite::escape(&other.to_string()));
                    }
                }
            }
            i += 2;
            continue;
        }
        if c == '[' && !in_class {
            in_class = true;
            src.push(c);
            if chars.get(i + 1) == Some(&'^') {
                src.push('^');
                i += 1;
            }
            // JS allows `[]` / literal `]` first — Rust needs it escaped.
            if chars.get(i + 1) == Some(&']') {
                src.push_str("\\]");
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == ']' && in_class {
            in_class = false;
        }
        if c == '(' && chars.get(i + 1) == Some(&'?') && chars.get(i + 2) == Some(&'<') && chars.get(i + 3).is_some_and(|x| x.is_alphabetic()) {
            src.push_str("(?P<");
            i += 3;
            continue;
        }
        if in_class && (c == '[' || c == '&' || c == '~') {
            src.push('\\');
        }
        src.push(c);
        i += 1;
    }
    Regex::new(&src).map_err(|e| e.to_string())
}

/// `input.replace(regex, replacement)` with JS replacement patterns.
pub fn js_regex_replace(input: &str, re: &Regex, replacement: &str, global: bool) -> String {
    let mut out = String::new();
    let mut last = 0;
    let names: Vec<Option<&str>> = re.capture_names().collect();
    for caps in re.captures_iter(input) {
        let m = caps.get(0).unwrap();
        out.push_str(&input[last..m.start()]);
        let r: Vec<char> = replacement.chars().collect();
        let mut i = 0;
        while i < r.len() {
            if r[i] == '$' && i + 1 < r.len() {
                let n = r[i + 1];
                match n {
                    '$' => {
                        out.push('$');
                        i += 2;
                        continue;
                    }
                    '&' => {
                        out.push_str(m.as_str());
                        i += 2;
                        continue;
                    }
                    '`' => {
                        out.push_str(&input[..m.start()]);
                        i += 2;
                        continue;
                    }
                    '\'' => {
                        out.push_str(&input[m.end()..]);
                        i += 2;
                        continue;
                    }
                    '<' => {
                        if let Some(end) = r[i..].iter().position(|c| *c == '>') {
                            let name: String = r[i + 2..i + end].iter().collect();
                            if names.iter().any(|x| *x == Some(name.as_str())) {
                                out.push_str(caps.name(&name).map(|x| x.as_str()).unwrap_or(""));
                                i += end + 1;
                                continue;
                            }
                        }
                    }
                    d if d.is_ascii_digit() => {
                        let groups = caps.len() - 1;
                        let two: Option<usize> = r.get(i + 2).filter(|c| c.is_ascii_digit()).map(|c2| (d as usize - 48) * 10 + (*c2 as usize - 48));
                        if let Some(idx) = two.filter(|x| *x > 0 && *x <= groups) {
                            out.push_str(caps.get(idx).map(|x| x.as_str()).unwrap_or(""));
                            i += 3;
                            continue;
                        }
                        let idx = d as usize - 48;
                        if idx > 0 && idx <= groups {
                            out.push_str(caps.get(idx).map(|x| x.as_str()).unwrap_or(""));
                            i += 2;
                            continue;
                        }
                    }
                    _ => {}
                }
            }
            out.push(r[i]);
            i += 1;
        }
        last = m.end();
        if !global {
            break;
        }
    }
    out.push_str(&input[last..]);
    out
}

fn replace(v: &str, param: Option<&str>) -> FilterOutput {
    let Some(param) = param else {
        return s(v);
    };
    let mut acc = v.to_string();
    let mut warning = None;
    for replacement in split_params(&unwrap_param_list(param)) {
        let pair = split_replacement_pair(&replacement).or_else(|| {
            // legacy: split(/(?<=[^\\]["']):(?=["'])/)
            let chars: Vec<char> = replacement.chars().collect();
            for i in 2..chars.len().saturating_sub(1) {
                if chars[i] == ':'
                    && (chars[i - 1] == '"' || chars[i - 1] == '\'')
                    && chars[i - 2] != '\\'
                    && (chars[i + 1] == '"' || chars[i + 1] == '\'')
                {
                    return Some((chars[..i].iter().collect(), chars[i + 1..].iter().collect()));
                }
            }
            None
        });
        let Some((search, repl)) = pair else { continue };
        let search = unquote_param_token(&search);
        let repl = unquote_param_token(&repl);
        if let Some((pattern, flags)) = parse_regex_pattern(&search) {
            let repl = process_escaped(&repl);
            match js_regex(&pattern, &flags) {
                Ok(re) => acc = js_regex_replace(&acc, &re, &repl, flags.contains('g')),
                Err(e) => warning = Some(format!("Invalid regular expression: {e}")),
            }
            continue;
        }
        let search = process_escaped(&search);
        let repl = process_escaped(&repl);
        if search.is_empty() {
            // new RegExp('', 'g') inserts the replacement between every unit.
            let units: Vec<u16> = acc.encode_utf16().collect();
            let mut out = repl.clone();
            for u in units.chunks(1) {
                out.push_str(&String::from_utf16_lossy(u));
                out.push_str(&repl);
            }
            acc = out;
            continue;
        }
        acc = acc.replace(&search, &repl_literal_expand(&repl, &search));
    }
    FilterOutput {
        value: Value::String(acc),
        warning,
        error: None,
    }
}

/// A literal search still goes through `String.replace(regex, repl)`, so `$&`
/// and `$$` in the replacement are expanded (except for `|`/`:`/newline
/// searches, which use split/join — `$&` there is literal, and rare enough to
/// ignore).
fn repl_literal_expand(repl: &str, search: &str) -> String {
    if !repl.contains('$') || search == "|" || search == ":" || search.contains(['\n', '\r', '\t']) {
        return repl.to_string();
    }
    repl.replace("$$", "\u{0}").replace("$&", search).replace('\u{0}', "$")
}

fn round(v: &str, param: Option<&str>) -> String {
    let clean = clean_scalar_param(param);
    if let Some(cp) = &clean {
        if crate::value::string_to_number(cp).is_nan() {
            return v.to_string();
        }
    }
    let places = clean.as_deref().filter(|c| !c.is_empty()).and_then(parse_int);
    let round_num = |n: f64| -> f64 {
        match places {
            None => js_math_round(n),
            Some(p) => {
                let f = 10f64.powi(p as i32);
                js_math_round(n * f) / f
            }
        }
    };
    fn process(val: Value, f: &dyn Fn(f64) -> f64) -> Value {
        match val {
            Value::Number(n) => Value::Number(f(n)),
            Value::String(s) => {
                let n = parse_float(&s);
                if n.is_nan() {
                    Value::String(s)
                } else {
                    Value::String(js_number(f(n)))
                }
            }
            Value::Array(a) => Value::Array(a.into_iter().map(|x| process(x, f)).collect()),
            Value::Object(m) => Value::Object(Map(m.0.into_iter().map(|(k, x)| (k, process(x, f))).collect())),
            other => other,
        }
    }
    let parsed = Value::parse_json(v).unwrap_or_else(|| Value::str(v));
    match process(parsed, &round_num) {
        Value::String(s) => s,
        other => other.to_json_string(),
    }
}

pub fn js_math_round(n: f64) -> f64 {
    if !n.is_finite() {
        return n;
    }
    let f = n.floor();
    if n - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

pub fn safe_name(v: &str, param: Option<&str>) -> String {
    let os = clean_scalar_param(param).map(|o| o.to_lowercase()).unwrap_or_else(|| "default".into());
    let mut out: String = v.chars().filter(|c| !"#|^[]".contains(*c)).collect();
    let is_ctrl = |c: char| (c as u32) < 0x20;
    let reserved = |s: &str| -> String {
        // /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i → '_$1$2'
        let lower = s.to_lowercase();
        let base = lower.split('.').next().unwrap_or("");
        let is_res = matches!(base, "con" | "prn" | "aux" | "nul")
            || ((base.starts_with("com") || base.starts_with("lpt")) && base.len() == 4 && base.as_bytes()[3].is_ascii_digit());
        if is_res && !s.contains('\n') {
            format!("_{s}")
        } else {
            s.to_string()
        }
    };
    let trim_trailing_dots_spaces = |s: &str| s.trim_end_matches(|c: char| c.is_whitespace() || c == '.').to_string();
    let leading_dot_underscore = |s: &str| {
        if let Some(rest) = s.strip_prefix('.') {
            format!("_{rest}")
        } else {
            s.to_string()
        }
    };
    match os.as_str() {
        "windows" => {
            out = out.chars().filter(|c| !"<>:\"/\\|?*".contains(*c) && !is_ctrl(*c)).collect();
            out = reserved(&out);
            out = trim_trailing_dots_spaces(&out);
        }
        "mac" => {
            out = out.chars().filter(|c| !"/:".contains(*c) && !is_ctrl(*c)).collect();
            out = leading_dot_underscore(&out);
        }
        "linux" => {
            out = out.chars().filter(|c| *c != '/' && !is_ctrl(*c)).collect();
            out = leading_dot_underscore(&out);
        }
        _ => {
            out = out.chars().filter(|c| !"<>:\"/\\|?*".contains(*c) && !is_ctrl(*c)).collect();
            out = reserved(&out);
            out = trim_trailing_dots_spaces(&out);
            out = leading_dot_underscore(&out);
        }
    }
    out = out.trim_start_matches('.').to_string();
    out = utf16_slice(&out, Some(0), Some(245));
    if out.is_empty() {
        out = "Untitled".into();
    }
    out
}

fn slice(v: &str, param: Option<&str>) -> FilterOutput {
    let Some(param) = param else {
        return s(v);
    };
    if v.is_empty() {
        return s(v);
    }
    let parts: Vec<Option<i64>> = split_params(&unwrap_param_list(param))
        .iter()
        .map(|t| clean_param_token(t))
        .map(|p| if p.is_empty() { None } else { parse_int(&p) })
        .collect();
    let start = parts.first().copied().flatten();
    let end = parts.get(1).copied().flatten();
    let mut warning = None;
    match Value::parse_json(v) {
        Some(Value::Array(a)) => {
            let (lo, hi) = crate::value::slice_bounds(a.len(), start, end);
            let sliced: Vec<Value> = if lo < hi { a[lo..hi].to_vec() } else { vec![] };
            if sliced.len() == 1 {
                return s(match &sliced[0] {
                    Value::Null | Value::Undefined => String::new(),
                    other => other.js_string(),
                });
            }
            s(Value::Array(sliced).to_json_string())
        }
        other => {
            if other.is_none() && (v.starts_with('[') || v.starts_with('{')) {
                warning = Some("Could not parse structured value as JSON".to_string());
            }
            FilterOutput {
                value: Value::String(utf16_slice(v, start, end)),
                warning,
                error: None,
            }
        }
    }
}

fn sort(c: &FilterCall) -> FilterOutput {
    let input = input_value(c);
    let Value::Array(items) = input else {
        return input.into();
    };
    let (property, desc) = match c.param {
        None => (None, false),
        Some(p) => {
            let parts: Vec<String> = split_params(&unwrap_param_list(p)).iter().map(|t| clean_param_token(t)).collect();
            if parts.len() == 1 && (parts[0] == "asc" || parts[0] == "desc") {
                (None, parts[0] == "desc")
            } else {
                (
                    parts.first().filter(|p| !p.is_empty()).cloned(),
                    parts.get(1).map(|d| d == "desc").unwrap_or(false),
                )
            }
        }
    };
    let prop = |v: &Value| -> Value {
        match &property {
            None => v.clone(),
            Some(path) => {
                let mut cur = v.clone();
                for key in path.split('.') {
                    cur = match &cur {
                        Value::Object(m) => m.get(key).cloned().unwrap_or(Value::Undefined),
                        Value::Array(_) => own_property(&cur, key).unwrap_or(Value::Undefined),
                        _ => Value::Undefined,
                    };
                }
                cur
            }
        }
    };
    let mut sorted = items;
    sorted.sort_by(|a, b| {
        let (l, r) = (prop(a), prop(b));
        use std::cmp::Ordering::*;
        let cmp = if l == r {
            Equal
        } else if l.is_nullish() {
            Greater
        } else if r.is_nullish() {
            Less
        } else if let (Value::Number(x), Value::Number(y)) = (&l, &r) {
            x.partial_cmp(y).unwrap_or(Equal)
        } else {
            let lt = match &l {
                Value::String(s) => s.clone(),
                other => other.to_json_string(),
            };
            let rt = match &r {
                Value::String(s) => s.clone(),
                other => other.to_json_string(),
            };
            let lu: Vec<u16> = lt.encode_utf16().collect();
            let ru: Vec<u16> = rt.encode_utf16().collect();
            lu.cmp(&ru)
        };
        if l.is_nullish() || r.is_nullish() {
            return cmp;
        }
        if desc {
            cmp.reverse()
        } else {
            cmp
        }
    });
    Value::Array(sorted).into()
}

fn split(v: &str, param: Option<&str>) -> String {
    let units_split = |s: &str| -> Vec<Value> {
        let units: Vec<u16> = s.encode_utf16().collect();
        units.chunks(1).map(|u| Value::String(String::from_utf16_lossy(u))).collect()
    };
    let Some(param) = param.filter(|p| !p.is_empty()) else {
        return Value::Array(units_split(v)).to_json_string();
    };
    let sep = unquote_scalar_param(Some(param)).unwrap_or_default();
    let parts: Vec<Value> = if utf16_len(&sep) == 1 {
        v.split(sep.as_str()).map(Value::str).collect()
    } else if sep.is_empty() {
        units_split(v)
    } else {
        match js_regex(&sep, "") {
            Ok(re) => {
                // JS split with a regex includes capture groups.
                let mut out = Vec::new();
                let mut last = 0;
                for caps in re.captures_iter(v) {
                    let m = caps.get(0).unwrap();
                    if m.start() == m.end() && (m.start() == 0 || m.start() == v.len()) {
                        continue;
                    }
                    out.push(Value::str(&v[last..m.start()]));
                    for g in 1..caps.len() {
                        out.push(caps.get(g).map(|x| Value::str(x.as_str())).unwrap_or(Value::Undefined));
                    }
                    last = m.end();
                }
                out.push(Value::str(&v[last..]));
                out
            }
            Err(_) => v.split(sep.as_str()).map(Value::str).collect(),
        }
    };
    Value::Array(parts).to_json_string()
}

fn sum(c: &FilterCall) -> FilterOutput {
    let input = collection_input_value(c);
    let Value::Array(items) = &input else {
        return input.into();
    };
    let args: Vec<Value> = match c.raw_args {
        Some(a) => a.to_vec(),
        None => parse_typed_params(c.param).unwrap_or_default(),
    };
    let path = args.first().cloned();
    let path = match path {
        None | Some(Value::Undefined) => None,
        Some(Value::String(p)) if !p.is_empty() => Some(p),
        Some(_) => return input.into(),
    };
    let mut total = 0.0;
    for item in items {
        let candidate = match &path {
            Some(p) => match own_property_at_path(item, p) {
                Some(v) => v,
                None => continue,
            },
            None => item.clone(),
        };
        let n = match &candidate {
            Value::Number(n) if n.is_finite() => Some(*n),
            Value::String(t) if !t.trim().is_empty() => {
                let n = crate::value::string_to_number(t.trim());
                n.is_finite().then_some(n)
            }
            _ => None,
        };
        if let Some(n) = n {
            total += n;
        }
    }
    Value::Number(total).into()
}

fn strip_attr(html: &str, keep: &str) -> String {
    let keep_list: Vec<String> = normalize_param_list(keep).into_iter().filter(|a| !a.is_empty()).collect();
    let tag_re = Regex::new(r"<(\w+)\s+(?:[^>]*?)>").unwrap();
    tag_re
        .replace_all(html, |caps: &regex_lite::Captures| {
            let whole = &caps[0];
            let tag = &caps[1];
            if keep_list.is_empty() {
                return format!("<{tag}>");
            }
            let kept: Vec<String> = keep_list
                .iter()
                .filter_map(|attr| {
                    let re = Regex::new(&format!(r#"(?i)\s{}\s*=\s*("[^"]*"|'[^']*')"#, regex_lite::escape(attr))).ok()?;
                    re.find(whole).map(|m| m.as_str().trim().to_string())
                })
                .collect();
            if kept.is_empty() {
                format!("<{tag}>")
            } else {
                format!("<{tag} {}>", kept.join(" "))
            }
        })
        .into_owned()
}

pub fn strip_md(input: &str) -> String {
    let mut s = input.to_string();
    let rep = |s: &str, pat: &str, with: &str| -> String { Regex::new(pat).unwrap().replace_all(s, with).into_owned() };
    s = rep(&s, r"!\[([^\]]*)\]\([^\)]+\)", "");
    s = rep(&s, r"!\[\[([^\]]+)\]\]", "");
    s = rep(&s, r"\[([^\]]+)\]\([^\)]+\)", "$1");
    s = rep(&s, r"https?://\S+", "");
    // (\*\*|__)(.*?)\1 — no backreferences in regex-lite: two passes.
    s = rep(&s, r"\*\*(.*?)\*\*", "$1");
    s = rep(&s, r"__(.*?)__", "$1");
    s = rep(&s, r"\*(.*?)\*", "$1");
    s = rep(&s, r"_(.*?)_", "$1");
    s = rep(&s, r"==(.*?)==", "$1");
    s = rep(&s, r"(?m)^#+\s+", "");
    s = rep(&s, r"`([^`]+)`", "$1");
    s = rep(&s, r"```[\s\S]*?```", "");
    s = rep(&s, r"~~(.*?)~~", "$1");
    s = rep(&s, r"(?m)^[-*+] (\[[x ]\] )?", "");
    s = rep(&s, r"(?m)^(?:-{3,}|\*{3,}|_{3,})\s*$", "");
    s = rep(&s, r"(?m)^>\s+", "");
    s = rep(&s, r"\|.*\|", "");
    s = rep(&s, r"~(\w+)~", "$1");
    s = rep(&s, r"\^(\w+)\^", "$1");
    s = rep(&s, r":[a-z_]+:", "");
    s = rep(&s, r"<[^>]+>", "");
    s = rep(&s, r"\[\s*\]", "");
    s = rep(&s, r"\[\^[^\]]+\]", "");
    s = rep(&s, r"(?m)^\*\[[^\]]+\]:.+$", "");
    let wl = Regex::new(r"\[\[([^\]|]+)\|?([^\]]*)\]\]").unwrap();
    s = wl
        .replace_all(&s, |c: &regex_lite::Captures| {
            let p2 = c.get(2).map(|m| m.as_str()).unwrap_or("");
            if p2.is_empty() {
                c[1].to_string()
            } else {
                p2.to_string()
            }
        })
        .into_owned();
    s = rep(&s, r"\n{3,}", "\n\n");
    js_trim(&s)
}

fn strip_tags(html: &str, keep: &str) -> String {
    let keep_list: Vec<String> = normalize_param_list(keep).into_iter().filter(|t| !t.is_empty()).collect();
    let mut result = if keep_list.is_empty() {
        Regex::new(r"</?[^>]+(>|$)").unwrap().replace_all(html, "").into_owned()
    } else {
        // <(?!\/?(?:tags)\b)[^>]+>  — no lookahead: filter in a closure.
        let any_tag = Regex::new(r"<[^>]+>").unwrap();
        let keep_re = Regex::new(&format!(
            r"(?i)^</?(?:{})\b",
            keep_list.iter().map(|t| regex_lite::escape(t)).collect::<Vec<_>>().join("|")
        ))
        .unwrap();
        any_tag
            .replace_all(html, |c: &regex_lite::Captures| {
                if keep_re.is_match(&c[0]) {
                    c[0].to_string()
                } else {
                    String::new()
                }
            })
            .into_owned()
    };
    for (from, to) in [
        ("&nbsp;", " "),
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&ldquo;", "\""),
        ("&rdquo;", "\""),
        ("&lsquo;", "'"),
        ("&rsquo;", "'"),
        ("&mdash;", "—"),
        ("&ndash;", "–"),
        ("&hellip;", "…"),
    ] {
        result = result.replace(from, to);
    }
    let dec = Regex::new(r"&#(\d+);").unwrap();
    result = dec
        .replace_all(&result, |c: &regex_lite::Captures| {
            let n: u32 = c[1].parse().unwrap_or(0xFFFD);
            // String.fromCharCode truncates to 16 bits.
            char::from_u32(n & 0xFFFF).map(|ch| ch.to_string()).unwrap_or_default()
        })
        .into_owned();
    let hex = Regex::new(r"&#x([0-9A-Fa-f]+);").unwrap();
    result = hex
        .replace_all(&result, |c: &regex_lite::Captures| {
            let n = u32::from_str_radix(&c[1], 16).unwrap_or(0xFFFD);
            char::from_u32(n & 0xFFFF).map(|ch| ch.to_string()).unwrap_or_default()
        })
        .into_owned();
    result = Regex::new(r"\n{3,}").unwrap().replace_all(&result, "\n\n").into_owned();
    js_trim(&result)
}

fn table(v: &str, param: Option<&str>, pretty: bool) -> FilterOutput {
    if v.is_empty() || v == "undefined" || v == "null" {
        return s(v);
    }
    let Some(data) = Value::parse_json(v) else {
        return warn(Value::str(v), "Could not parse value as JSON table data");
    };
    let headers: Vec<String> = param
        .map(|p| split_params(&unwrap_param_list(p)).iter().map(|t| unquote_param_token(t)).collect())
        .unwrap_or_default();
    let cell = |x: &Value| x.js_string().replace('|', "\\|");
    let render = |heads: Vec<String>, rows: Vec<Vec<Value>>| -> String {
        let n = heads.len();
        let heads: Vec<String> = heads.iter().map(|h| h.replace('|', "\\|")).collect();
        let rows: Vec<Vec<String>> = rows
            .into_iter()
            .map(|r| {
                let mut r: Vec<String> = r.iter().map(cell).collect();
                r.resize(n.max(r.len()), String::new());
                r.truncate(n);
                r
            })
            .collect();
        let width = |c: &str| c.chars().count();
        if !pretty {
            let mut lines = vec![
                format!("| {} |", heads.join(" | ")),
                format!("| {} |", heads.iter().map(|_| "-").collect::<Vec<_>>().join(" | ")),
            ];
            lines.extend(rows.iter().map(|r| format!("| {} |", r.join(" | "))));
            return lines.join("\n");
        }
        let widths: Vec<usize> = (0..n)
            .map(|col| rows.iter().map(|r| width(&r[col])).fold(3.max(width(&heads[col])), usize::max))
            .collect();
        let fmt_row = |r: &[String]| {
            format!(
                "| {} |",
                r.iter().enumerate().map(|(i, c)| format!("{c}{}", " ".repeat(widths[i] - width(c)))).collect::<Vec<_>>().join(" | ")
            )
        };
        let mut lines = vec![fmt_row(&heads), format!("| {} |", widths.iter().map(|w| "-".repeat(*w)).collect::<Vec<_>>().join(" | "))];
        lines.extend(rows.iter().map(|r| fmt_row(r)));
        lines.join("\n")
    };
    let stringify_headers = |vals: &[Value]| vals.iter().map(|x| x.js_string()).collect::<Vec<_>>();
    match data {
        Value::Object(m) => {
            if m.is_empty() {
                return s(v);
            }
            // renderTable(entries[0], entries.slice(1)) — entries are [key, value] pairs.
            let entries: Vec<Vec<Value>> = m.0.into_iter().map(|(k, x)| vec![Value::String(k), x]).collect();
            s(render(stringify_headers(&entries[0]), entries[1..].to_vec()))
        }
        Value::Array(rows) if !rows.is_empty() && matches!(rows[0], Value::Array(_)) => {
            let max_cols = rows.iter().map(|r| if let Value::Array(a) = r { a.len() } else { 0 }).max().unwrap_or(0);
            let mut heads = headers.clone();
            if heads.len() < max_cols {
                heads.resize(max_cols, String::new());
            }
            if headers.is_empty() {
                heads = vec![String::new(); max_cols];
            }
            let rows = rows.into_iter().map(|r| if let Value::Array(a) = r { a } else { vec![r] }).collect();
            s(render(heads, rows))
        }
        Value::Array(rows) if !rows.is_empty() && matches!(rows[0], Value::Object(_)) => {
            let heads = if headers.is_empty() {
                match &rows[0] {
                    Value::Object(m) => m.keys().cloned().collect(),
                    _ => vec![],
                }
            } else {
                headers.clone()
            };
            let body = rows
                .iter()
                .map(|r| heads.iter().map(|h| own_property(r, h).filter(|x| !x.is_nullish()).unwrap_or_else(|| Value::str(""))).collect())
                .collect();
            s(render(heads, body))
        }
        Value::Array(rows) => {
            if !headers.is_empty() {
                let body = rows.chunks(headers.len()).map(|c| c.to_vec()).collect();
                s(render(headers, body))
            } else {
                s(render(vec!["Value".into()], rows.into_iter().map(|x| vec![x]).collect()))
            }
        }
        _ => s(v),
    }
}

fn template(v: &str, param: Option<&str>) -> String {
    let Some(param) = param else {
        return v.to_string();
    };
    let tpl = unquote_scalar_param(Some(param)).unwrap_or_default();
    let obj = Value::parse_json(v).unwrap_or_else(|| Value::Array(vec![Value::str(v)]));
    let items = match obj {
        Value::Array(a) => a,
        other => vec![other],
    };
    let var_re = Regex::new(r"\$\{([\w.]+)\}").unwrap();
    items
        .iter()
        .map(|item| {
            let item: Value = match item {
                Value::String(sv) => {
                    let mut m = parse_object_string(sv);
                    if !m.contains_key("str") {
                        m.insert("str", Value::String(sv.clone()));
                    }
                    Value::Object(m)
                }
                other => other.clone(),
            };
            let replaced = var_re
                .replace_all(&tpl, |c: &regex_lite::Captures| match own_property_at_path(&item, &c[1]) {
                    Some(Value::Undefined) | None => String::new(),
                    Some(Value::String(x)) if x == "undefined" => String::new(),
                    Some(x) => x.js_string(),
                })
                .into_owned();
            let replaced = replaced.replace("\\n", "\n");
            let joined = replaced.split('\n').filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n");
            js_trim(&joined)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn parse_object_string(s: &str) -> Map {
    let mut m = Map::new();
    let re = Regex::new(r#"(\w+):\s*("(?:\\.|[^"\\])*"|[^,}]+)"#).unwrap();
    for c in re.captures_iter(s) {
        let key = c[1].to_string();
        let mut val = c[2].to_string();
        if val.len() >= 2 && val.starts_with('"') && val.ends_with('"') {
            val = val[1..val.len() - 1].to_string();
        }
        m.insert(key, if val == "undefined" { Value::Undefined } else { Value::String(val) });
    }
    m
}

fn title(input: &str) -> String {
    const LOWER: &[&str] = &["a", "an", "the", "and", "but", "or", "for", "nor", "on", "at", "to", "from", "by", "in", "of"];
    fn tc(s: &str) -> String {
        // str.split(/\s+/) then join(' ')
        let words: Vec<&str> = split_ws_js(s);
        words
            .iter()
            .enumerate()
            .map(|(i, w)| {
                if i != 0 && LOWER.contains(&w.to_lowercase().as_str()) {
                    w.to_lowercase()
                } else {
                    capitalize_str(w)
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn go(v: Value) -> Value {
        match v {
            Value::String(s) => Value::String(tc(&s)),
            Value::Array(a) => Value::Array(a.into_iter().map(go).collect()),
            Value::Object(m) => Value::Object(Map(m.0.into_iter().map(|(k, x)| (tc(&k), go(x))).collect())),
            other => other,
        }
    }
    match Value::parse_json(input) {
        Some(v) => go(v).to_json_string(),
        None => tc(input),
    }
}

/// JS `str.split(/\s+/)` — keeps leading/trailing empty strings.
fn split_ws_js(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_ws = false;
    for (i, c) in s.char_indices() {
        if c.is_whitespace() || c == '\u{feff}' {
            if !in_ws {
                out.push(&s[start..i]);
                in_ws = true;
            }
        } else if in_ws {
            start = i;
            in_ws = false;
        }
    }
    if in_ws {
        out.push("");
    } else {
        out.push(&s[start..]);
    }
    out
}

fn truncate_chars(v: &str, limit: usize, suffix: &str) -> String {
    if limit == 0 {
        return String::new();
    }
    let chars: Vec<char> = v.chars().collect();
    if chars.len() <= limit {
        return v.to_string();
    }
    let suf: Vec<char> = suffix.chars().take(limit).collect();
    let content_limit = limit.saturating_sub(suf.len());
    format!("{}{}", chars[..content_limit].iter().collect::<String>(), suf.iter().collect::<String>())
}

fn truncate_words(v: &str, limit: usize, suffix: &str) -> String {
    if limit == 0 {
        return String::new();
    }
    let words: Vec<(usize, usize)> = Regex::new(r"\S+").unwrap().find_iter(v).map(|m| (m.start(), m.end())).collect();
    if words.len() <= limit {
        return v.to_string();
    }
    format!("{}{}", &v[..words[limit - 1].1], suffix)
}

fn unique(v: &str) -> String {
    match Value::parse_json(v) {
        Some(Value::Array(a)) => {
            let mut seen: Vec<String> = Vec::new();
            let mut out = Vec::new();
            let all_prim = a.iter().all(|x| !x.is_collection() && !matches!(x, Value::Null));
            for item in a {
                let key = if all_prim {
                    match &item {
                        Value::String(s) => format!("s:{s}"),
                        other => format!("o:{}", other.to_json_string()),
                    }
                } else {
                    item.to_json_string()
                };
                if !seen.contains(&key) {
                    seen.push(key);
                    out.push(item);
                }
            }
            Value::Array(out).to_json_string()
        }
        Some(Value::Object(m)) => {
            let mut seen: Vec<String> = Vec::new();
            let mut kept = Vec::new();
            for (k, x) in m.0.into_iter().rev() {
                let key = x.to_json_string();
                if !seen.contains(&key) {
                    seen.push(key);
                    kept.push((k, x));
                }
            }
            kept.reverse();
            Value::Object(Map(kept)).to_json_string()
        }
        _ => v.to_string(),
    }
}

fn wiki_reference(v: &str, param: Option<&str>, prefix: &str) -> String {
    if js_trim(v).is_empty() {
        return v.to_string();
    }
    let alias = param.and_then(|p| unquote_scalar_param(Some(p))).unwrap_or_default();
    fn process_object(m: &Map, prefix: &str, out: &mut Vec<Value>) {
        for (k, x) in m.iter() {
            match x {
                Value::Object(inner) => process_object(inner, prefix, out),
                Value::Array(items) => {
                    let mm = Map(items.iter().enumerate().map(|(i, y)| (i.to_string(), y.clone())).collect());
                    process_object(&mm, prefix, out);
                }
                other => out.push(Value::String(format!("{prefix}[[{k}|{}]]", other.js_string()))),
            }
        }
    }
    match Value::parse_json(v) {
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for item in items {
                match &item {
                    Value::Object(m) => process_object(m, prefix, &mut out),
                    Value::Array(a) => {
                        let mm = Map(a.iter().enumerate().map(|(i, y)| (i.to_string(), y.clone())).collect());
                        process_object(&mm, prefix, &mut out);
                    }
                    other => out.push(Value::String(if other.truthy() {
                        if alias.is_empty() {
                            format!("{prefix}[[{}]]", other.js_string())
                        } else {
                            format!("{prefix}[[{}|{alias}]]", other.js_string())
                        }
                    } else {
                        String::new()
                    })),
                }
            }
            Value::Array(out).to_json_string()
        }
        Some(Value::Object(m)) => {
            let mut out = Vec::new();
            process_object(&m, prefix, &mut out);
            Value::Array(out).to_json_string()
        }
        Some(_) => v.to_string(),
        None => {
            if alias.is_empty() {
                format!("{prefix}[[{v}]]")
            } else {
                format!("{prefix}[[{v}|{alias}]]")
            }
        }
    }
}

fn yaml_flow(v: &Value) -> String {
    let json = v.to_json_string();
    let mut out = String::new();
    for ch in json.chars() {
        let cp = ch as u32;
        if (0x7f..=0x9f).contains(&cp) || cp == 0x2028 || cp == 0x2029 {
            out.push_str(&format!("\\u{:04x}", cp));
        } else {
            out.push(ch);
        }
    }
    out
}

fn yaml_key(k: &str) -> String {
    let mut cs = k.chars();
    let simple = cs.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && cs.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    let reserved = matches!(k.to_lowercase().as_str(), "true" | "false" | "null" | "yes" | "no" | "on" | "off" | "y" | "n");
    if simple && !reserved {
        k.to_string()
    } else {
        yaml_flow(&Value::str(k))
    }
}

fn yaml_block(v: &Value) -> String {
    let is_block = |x: &Value| match x {
        Value::Array(a) => !a.is_empty(),
        Value::Object(m) => !m.is_empty(),
        _ => false,
    };
    match v {
        Value::Array(a) => {
            if a.is_empty() {
                "[]".into()
            } else {
                a.iter().map(|i| format!("- {}", yaml_block(i).replace('\n', "\n  "))).collect::<Vec<_>>().join("\n")
            }
        }
        Value::Object(m) => {
            if m.is_empty() {
                "{}".into()
            } else {
                m.iter()
                    .filter(|(_, x)| !matches!(x, Value::Undefined))
                    .map(|(k, x)| {
                        if is_block(x) {
                            format!("{}:\n  {}", yaml_key(k), yaml_block(x).replace('\n', "\n  "))
                        } else {
                            format!("{}: {}", yaml_key(k), yaml_block(x))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }
        other => yaml_flow(other),
    }
}

fn yaml_collection(c: &FilterCall) -> Option<Value> {
    let src = if matches!(c.raw_value, Value::Array(_)) {
        c.raw_value.to_json_string()
    } else {
        c.value.to_string()
    };
    match Value::parse_json(&src) {
        Some(v) if v.is_collection() => Some(v),
        _ => None,
    }
}

fn yaml_scalar(c: &FilterCall) -> String {
    if matches!(c.raw_value, Value::Null) {
        return "null".into();
    }
    let t = c.value.trim();
    if matches!(t.to_lowercase().as_str(), "true" | "false" | "null") {
        return t.to_string();
    }
    let n = crate::value::string_to_number(t);
    if n.is_finite() && js_number(n) == t {
        return t.to_string();
    }
    yaml_flow(&Value::str(c.value))
}

fn yaml(c: &FilterCall) -> String {
    match yaml_collection(c) {
        Some(v) => {
            if clean_scalar_param(c.param).as_deref() == Some("flow") {
                yaml_flow(&v)
            } else {
                yaml_block(&v)
            }
        }
        None => yaml_scalar(c),
    }
}

fn yaml_property(c: &FilterCall) -> String {
    let key = c.param.and_then(|p| {
        let parts = split_params(&unwrap_param_list(p));
        if parts.len() == 1 {
            Some(clean_param_token(&parts[0]))
        } else {
            None
        }
    });
    let Some(key) = key.filter(|k| !k.trim().is_empty()) else {
        return c.value.to_string();
    };
    match yaml_collection(c) {
        Some(v) => {
            let mut m = Map::new();
            m.insert(key, v);
            yaml_block(&Value::Object(m))
        }
        None => format!("{}: {}", yaml_key(&key), yaml_scalar(c)),
    }
}

fn where_filter(c: &FilterCall) -> FilterOutput {
    let input = collection_input_value(c);
    let Value::Array(items) = &input else {
        return input.into();
    };
    let args: Vec<Value> = match c.raw_args {
        Some(a) => a.to_vec(),
        None => parse_typed_params(c.param).unwrap_or_default(),
    };
    let (Some(Value::String(path)), Some(expected)) = (args.first(), args.get(1)) else {
        return input.into();
    };
    if path.is_empty() || !matches!(expected, Value::Null | Value::String(_) | Value::Number(_) | Value::Bool(_)) {
        return input.into();
    }
    Value::Array(
        items
            .iter()
            .filter(|item| own_property_at_path(item, path).is_some_and(|v| &v == expected))
            .cloned()
            .collect(),
    )
    .into()
}

// ---- DOM filters ----------------------------------------------------------------

fn html_to_json(input: &str) -> String {
    use crate::html::{Document, NodeData};
    let doc = Document::parse(input);
    let root = doc.find_tag(0, "body").unwrap_or(0);
    fn node(doc: &Document, id: usize) -> Option<Value> {
        match &doc.node(id).data {
            NodeData::Text(t) => {
                let t = js_trim(t);
                if t.is_empty() {
                    None
                } else {
                    let mut m = Map::new();
                    m.insert("type", Value::str("text"));
                    m.insert("content", Value::String(t));
                    Some(Value::Object(m))
                }
            }
            NodeData::Element { name, attrs } => {
                let mut m = Map::new();
                m.insert("type", Value::str("element"));
                m.insert("tag", Value::String(name.to_lowercase()));
                if !attrs.is_empty() {
                    m.insert("attributes", Value::Object(Map(attrs.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())));
                }
                let kids: Vec<Value> = doc.children(id).iter().filter_map(|c| node(doc, *c)).collect();
                if !kids.is_empty() {
                    m.insert("children", Value::Array(kids));
                }
                Some(Value::Object(m))
            }
            _ => None,
        }
    }
    let top: Vec<usize> = doc
        .children(root)
        .iter()
        .copied()
        .filter(|c| !(root == 0 && matches!(doc.tag(*c), Some("head" | "html"))))
        .collect();
    let kids: Vec<Value> = top.iter().filter_map(|c| node(&doc, *c)).collect();
    if kids.len() == 1 {
        kids[0].to_json_string()
    } else {
        Value::Array(kids).to_json_string()
    }
}

fn remove_html(html: &str, params: &str) -> String {
    use crate::html::{Document, NodeData};
    let selectors: Vec<String> = normalize_param_list(params).into_iter().filter(|s| !s.is_empty()).collect();
    if selectors.is_empty() {
        return html.to_string();
    }
    let mut doc = Document::parse(html);
    for sel in &selectors {
        for id in doc.select(0, sel) {
            doc.detach(id);
        }
    }
    // XMLSerializer output for top-level nodes, text as raw textContent.
    fn xml(doc: &Document, id: usize, out: &mut String, top: bool) {
        match &doc.node(id).data {
            NodeData::Text(t) => {
                for ch in t.chars() {
                    match ch {
                        '&' => out.push_str("&amp;"),
                        '<' => out.push_str("&lt;"),
                        '>' => out.push_str("&gt;"),
                        c => out.push(c),
                    }
                }
            }
            NodeData::Comment(c) => {
                out.push_str("<!--");
                out.push_str(c);
                out.push_str("-->");
            }
            NodeData::Element { name, attrs } => {
                out.push('<');
                out.push_str(name);
                if top {
                    out.push_str(" xmlns=\"http://www.w3.org/1999/xhtml\"");
                }
                for (k, v) in attrs {
                    out.push(' ');
                    out.push_str(k);
                    out.push_str("=\"");
                    for ch in v.chars() {
                        match ch {
                            '&' => out.push_str("&amp;"),
                            '"' => out.push_str("&quot;"),
                            '<' => out.push_str("&lt;"),
                            '>' => out.push_str("&gt;"),
                            c => out.push(c),
                        }
                    }
                    out.push('"');
                }
                if crate::html::is_void(name) {
                    out.push_str(" />");
                    return;
                }
                out.push('>');
                for c in doc.children(id) {
                    xml(doc, *c, out, false);
                }
                out.push_str("</");
                out.push_str(name);
                out.push('>');
            }
            NodeData::Document => {}
        }
    }
    let body = doc.find_tag(0, "body").unwrap_or(0);
    let mut out = String::new();
    for c in doc.children(body).to_vec() {
        match &doc.node(c).data {
            NodeData::Text(t) => out.push_str(t),
            NodeData::Element { name, .. } if body == 0 && (name == "head" || name == "html") => {}
            NodeData::Element { .. } => xml(&doc, c, &mut out, true),
            _ => {}
        }
    }
    out
}
