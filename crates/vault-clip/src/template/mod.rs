//! The Obsidian Web Clipper template language.
//!
//! Since Web Clipper 1.x the language lives in the `knap` package
//! (obsidianmd/knap); the clipper adds page variables, selector and schema
//! resolution, deferred prompt/model variables, the `markdown` filter,
//! property typing and frontmatter, trigger matching and the template JSON
//! format. This module ports both layers:
//!
//! * [`tokenizer`], [`parser`], [`render`], [`params`], [`filters`] — Knap 0.5.
//! * this file — `obsidian-clipper/src/utils/{template-compiler,shared,
//!   resolver,triggers,import-export}.ts` and `src/api.ts`.
//!
//! Deliberate departures, each because the original is wrong for a vault:
//! frontmatter text values escape backslashes and newlines (the clipper only
//! escapes `"`, so `C:\new` became a newline), and "local time" is an explicit
//! UTC offset because a pure crate has no clock or time zone.

pub mod filters;
pub mod params;
pub mod parser;
pub mod render;
pub mod tokenizer;
pub mod validate;

use crate::html::Document;
use crate::value::{Map, Value};
use filters::FilterEnv;
pub use render::{Diagnostic, Variables};
use serde::{Deserialize, Serialize};
use std::cell::OnceCell;

/// Everything a template can read.
pub struct TemplateContext {
    /// Page variables, keyed by name without braces (`title`,
    /// `meta:name:description`, `schema:@Article:headline`). Keys given as
    /// `{{title}}` are normalised.
    pub variables: Variables,
    /// The page URL (used by `markdown` and `fragment_link`).
    pub url: String,
    /// Full page HTML, for `{{selector:…}}` / `{{selectorHtml:…}}`.
    pub page_html: Option<String>,
    pub now_ms: f64,
    pub tz_offset_minutes: i32,
    /// When true (the default) prompt `{{"…"}}` and `{{model}}` variables are
    /// kept verbatim in the output for the interpreter to fill; when false
    /// they render as empty strings, as the clipper does with Interpreter off.
    pub interpreter_enabled: bool,
    /// Treat `{{"…"}}` as an interpreter prompt (the clipper's reading, the
    /// default). When false it is a plain Knap string literal.
    pub defer_prompts: bool,
    doc: OnceCell<Document>,
}

impl TemplateContext {
    pub fn new(url: &str, now_ms: f64) -> TemplateContext {
        TemplateContext {
            variables: Variables::new(),
            url: url.to_string(),
            page_html: None,
            now_ms,
            tz_offset_minutes: 0,
            interpreter_enabled: true,
            defer_prompts: true,
            doc: OnceCell::new(),
        }
    }

    pub fn with_variable(mut self, key: &str, value: impl Into<Value>) -> TemplateContext {
        self.variables.insert(key, value.into());
        self
    }

    fn document(&self) -> Option<&Document> {
        let html = self.page_html.as_ref()?;
        Some(self.doc.get_or_init(|| Document::parse(html)))
    }

    fn env(&self) -> FilterEnv {
        FilterEnv {
            current_url: strip_text_fragment(&self.url),
            now_ms: self.now_ms,
            tz_offset_minutes: self.tz_offset_minutes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TemplateError {
    pub errors: Vec<Diagnostic>,
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for e in &self.errors {
            writeln!(f, "Line {}: {}", e.line, e.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for TemplateError {}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub output: String,
    pub errors: Vec<Diagnostic>,
    pub warnings: Vec<Diagnostic>,
}

/// Render a template. Parse errors are an `Err` (the clipper renders nothing
/// in that case); runtime errors leave partial output, as in the clipper.
pub fn render_template(tpl: &str, ctx: &TemplateContext) -> Result<String, TemplateError> {
    let r = render_template_full(tpl, ctx);
    let parse_failed = r.output.is_empty()
        && r.errors.iter().any(|e| e.code == "PARSE_ERROR" || e.code == "LIMIT_EXCEEDED");
    if parse_failed {
        return Err(TemplateError { errors: r.errors });
    }
    Ok(r.output)
}

pub fn render_template_full(tpl: &str, ctx: &TemplateContext) -> RenderResult {
    let deferred = if ctx.defer_prompts {
        protect_deferred(tpl, &ctx.variables)
    } else {
        Deferred {
            template: tpl.to_string(),
            variables: Vec::new(),
            expressions: Vec::new(),
        }
    };
    let (ast, perrs) = parser::parse(&deferred.template);
    if !perrs.is_empty() {
        return RenderResult {
            output: String::new(),
            errors: perrs
                .into_iter()
                .map(|e| Diagnostic {
                    code: "PARSE_ERROR".into(),
                    message: e.message,
                    line: e.line,
                    column: e.column,
                    filter: None,
                })
                .collect(),
            warnings: Vec::new(),
        };
    }
    let mut host = ctx.variables.clone();
    for (k, v) in &deferred.variables {
        host.insert(k.clone(), Value::String(v.clone()));
    }
    let env = ctx.env();
    let resolver = ClipResolver { ctx };
    let mut out = render::render(&ast, &host, &resolver, &env);
    out.errors.splice(0..0, validate_filters(&ast));
    let mut output = out.output;
    for d in &deferred.expressions {
        let replacement = if ctx.interpreter_enabled { d.template.clone() } else { String::new() };
        output = output.replace(&d.token, &replacement);
    }
    RenderResult {
        output,
        errors: out.errors,
        warnings: out.warnings,
    }
}

/// Check a template without data (`engine.validate`): syntax errors, unknown
/// filters, and literal filter arguments that the filter would reject.
pub fn validate_template(tpl: &str) -> Vec<Diagnostic> {
    let (ast, perrs) = parser::parse(tpl);
    if !perrs.is_empty() {
        return perrs
            .into_iter()
            .map(|e| Diagnostic {
                code: "PARSE_ERROR".into(),
                message: e.message,
                line: e.line,
                column: e.column,
                filter: None,
            })
            .collect();
    }
    validate_filters(&ast)
}

fn validate_filters(ast: &[parser::Node]) -> Vec<Diagnostic> {
    use parser::{Expr, Node};
    fn walk_expr(e: &Expr, out: &mut Vec<Diagnostic>) {
        match e {
            Expr::Filter { value, name, args, line, column } => {
                if !filters::exists(name) {
                    out.push(Diagnostic {
                        code: "UNKNOWN_FILTER".into(),
                        message: format!("Unknown filter \"{name}\""),
                        line: *line,
                        column: *column,
                        filter: None,
                    });
                } else if args.iter().all(|a| a.is_literal_arg()) {
                    let param = if args.is_empty() {
                        None
                    } else {
                        Some(
                            args.iter()
                                .map(|a| {
                                    let mut e = a;
                                    while let Expr::Group(inner) = e {
                                        e = inner;
                                    }
                                    match e {
                                        Expr::Literal { value, .. } => validate::literal_to_param(value),
                                        _ => String::new(),
                                    }
                                })
                                .collect::<Vec<_>>()
                                .join(","),
                        )
                    };
                    if let Err(msg) = validate::validate_params(name, param.as_deref()) {
                        out.push(Diagnostic {
                            code: "INVALID_FILTER_ARGUMENTS".into(),
                            message: format!("Filter \"{name}\" {msg}"),
                            line: *line,
                            column: *column,
                            filter: None,
                        });
                    }
                }
                walk_expr(value, out);
                for a in args {
                    walk_expr(a, out);
                }
            }
            Expr::Binary { left, right, .. } => {
                walk_expr(left, out);
                walk_expr(right, out);
            }
            Expr::Not(x) | Expr::Group(x) => walk_expr(x, out),
            Expr::Member { object, property } => {
                walk_expr(object, out);
                walk_expr(property, out);
            }
            _ => {}
        }
    }
    fn walk(nodes: &[Node], out: &mut Vec<Diagnostic>) {
        for n in nodes {
            match n {
                Node::Variable { expr, .. } => walk_expr(expr, out),
                Node::Set { value, .. } => walk_expr(value, out),
                Node::If { cond, then, elseifs, otherwise, .. } => {
                    walk_expr(cond, out);
                    walk(then, out);
                    for (c, b) in elseifs {
                        walk_expr(c, out);
                        walk(b, out);
                    }
                    if let Some(o) = otherwise {
                        walk(o, out);
                    }
                }
                Node::For { iterable, body, .. } => {
                    walk_expr(iterable, out);
                    walk(body, out);
                }
                Node::Text(_) => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(ast, &mut out);
    out
}

pub fn strip_text_fragment(url: &str) -> String {
    // url.replace(/#:~:text=[^&]+(&|$)/, '')
    if let Some(start) = url.find("#:~:text=") {
        let rest = &url[start + 9..];
        let end = match rest.find('&') {
            Some(0) => return url.to_string(),
            Some(i) => start + 9 + i + 1,
            None => {
                if rest.is_empty() {
                    return url.to_string();
                }
                url.len()
            }
        };
        return format!("{}{}", &url[..start], &url[end..]);
    }
    url.to_string()
}

// ---- deferred prompt / model variables ------------------------------------------

struct Deferred {
    template: String,
    variables: Vec<(String, String)>,
    expressions: Vec<DeferredExpr>,
}

struct DeferredExpr {
    token: String,
    template: String,
}

fn read_template_expression(chars: &[char], start: usize) -> Option<(usize, String, bool, bool)> {
    let mut i = start + 2;
    let trim_left = chars.get(i) == Some(&'-');
    if trim_left {
        i += 1;
    }
    let expr_start = i;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    while i + 1 < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            quote = Some(c);
            i += 1;
            continue;
        }
        if c == '}' && chars[i + 1] == '}' {
            let trim_right = i > 0 && chars[i - 1] == '-';
            let end_expr = if trim_right { i - 1 } else { i };
            return Some((i + 2, chars[expr_start..end_expr.max(expr_start)].iter().collect(), trim_left, trim_right));
        }
        i += 1;
    }
    None
}

fn canonicalize_deferred(expression: &str) -> Option<String> {
    let value = expression.trim();
    for name in ["modelProvider", "modelId", "model"] {
        if let Some(rest) = value.strip_prefix(name) {
            let rest_t = rest.trim_start();
            if rest.is_empty() {
                return Some(format!("{{{{{name}}}}}"));
            }
            if let Some(f) = rest_t.strip_prefix('|') {
                let f = f.trim();
                return Some(if f.is_empty() {
                    format!("{{{{{name}}}}}")
                } else {
                    format!("{{{{{name}|{f}}}}}")
                });
            }
        }
    }
    let has_prefix = value.starts_with("prompt:");
    let pe = if has_prefix { value["prompt:".len()..].trim_start() } else { value };
    let chars: Vec<char> = pe.chars().collect();
    let quote = *chars.first()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let mut closing = None;
    let mut escaped = false;
    for (i, &c) in chars.iter().enumerate().skip(1) {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == quote {
            closing = Some(i);
            break;
        }
    }
    let closing = closing?;
    let remainder: String = chars[closing + 1..].iter().collect();
    let remainder = remainder.trim();
    if !remainder.is_empty() && !remainder.starts_with('|') {
        return None;
    }
    let filters = if remainder.is_empty() { "" } else { remainder[1..].trim() };
    let mut prompt: String = chars[1..closing].iter().collect();
    if quote == '\'' {
        prompt = prompt.replace("\\'", "'").replace('"', "\\\"");
    }
    Some(format!(
        "{{{{{}\"{}\"{}}}}}",
        if has_prefix { "prompt:" } else { "" },
        prompt,
        if filters.is_empty() { String::new() } else { format!("|{filters}") }
    ))
}

fn protect_deferred(text: &str, variables: &Variables) -> Deferred {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Deferred {
        template: String::new(),
        variables: Vec::new(),
        expressions: Vec::new(),
    };
    let mut idx = 0usize;
    let mut cursor = 0usize;
    let mut search = 0usize;
    while search < chars.len() {
        let Some(start) = (search..chars.len().saturating_sub(1)).find(|&i| chars[i] == '{' && chars[i + 1] == '{') else {
            break;
        };
        let Some((end, expr, tl, tr)) = read_template_expression(&chars, start) else {
            break;
        };
        let Some(canonical) = canonicalize_deferred(&expr) else {
            search = start + 2;
            continue;
        };
        let mut key;
        loop {
            key = format!("__knap_deferred_{idx}");
            idx += 1;
            if variables.get(&key).is_none() && !out.variables.iter().any(|(k, _)| *k == key) {
                break;
            }
        }
        let token = format!("\u{E000}knap-deferred-{idx}\u{E001}");
        out.template.extend(&chars[cursor..start]);
        out.template.push_str(&format!(
            "{{{{{}{}{}}}}}",
            if tl { "-" } else { "" },
            key,
            if tr { "-" } else { "" }
        ));
        out.variables.push((key, token.clone()));
        out.expressions.push(DeferredExpr { token, template: canonical });
        cursor = end;
        search = end;
    }
    out.template.extend(&chars[cursor..]);
    out
}

/// A prompt variable found in a template (`collectPromptVariables`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptVariable {
    pub key: String,
    pub prompt: String,
    pub filters: String,
}

fn prompt_regex(across_lines_filters: bool) -> regex_lite::Regex {
    if across_lines_filters {
        regex_lite::Regex::new(r#"\{\{(?:prompt:)?"((?s:.)*?)"(\|(?s:.)*?)?\}\}"#).unwrap()
    } else {
        regex_lite::Regex::new(r#"\{\{(?:prompt:)?"((?s:.)*?)"(\|.*?)?\}\}"#).unwrap()
    }
}

/// Collect the distinct prompts in the given template texts, keyed `prompt_1`…
pub fn collect_prompts(texts: &[&str]) -> Vec<PromptVariable> {
    let re = prompt_regex(false);
    let mut out: Vec<PromptVariable> = Vec::new();
    for t in texts {
        for c in re.captures_iter(t) {
            let prompt = c[1].to_string();
            if !out.iter().any(|p| p.prompt == prompt) {
                out.push(PromptVariable {
                    key: format!("prompt_{}", out.len() + 1),
                    prompt,
                    filters: c.get(2).map(|m| m.as_str().to_string()).unwrap_or_default(),
                });
            }
        }
    }
    out
}

/// Replace prompt placeholders with interpreter responses and apply their
/// filters (`replacePromptVariables`). `responses` maps prompt text → value.
pub fn fill_prompts(text: &str, responses: &[(String, Value)], ctx: &TemplateContext) -> String {
    let re = prompt_regex(true);
    re.replace_all(text, |c: &regex_lite::Captures| {
        let prompt = &c[1];
        let Some((_, value)) = responses.iter().find(|(p, _)| p == prompt) else {
            return c[0].to_string();
        };
        let mut v = match value {
            Value::Object(_) | Value::Array(_) => Value::String(value.to_json_pretty(2)),
            other => other.clone(),
        };
        if let Some(f) = c.get(2) {
            let s = apply_filters(&v, &f.as_str()[1..], &FilterEnv { current_url: String::new(), ..ctx.env() });
            v = Value::String(s);
        }
        match v {
            Value::String(s) => s,
            other => other.js_string(),
        }
    })
    .into_owned()
}

/// Apply a raw filter chain (`applyFiltersWithRegistry`).
pub fn apply_filters(value: &Value, filter_string: &str, env: &FilterEnv) -> String {
    if filter_string.is_empty() {
        return match value {
            Value::String(s) => s.clone(),
            other => other.to_json_string(),
        };
    }
    let mut processed = value.clone();
    for expr in params::split_filter_string(filter_string) {
        let parts = params::parse_filter_string(&expr);
        let Some(name) = parts.first() else { continue };
        if !filters::exists(name) {
            continue;
        }
        let param = parts[1..].join(":");
        let input = match &processed {
            Value::String(s) => s.clone(),
            other => other.to_json_string(),
        };
        let raw_args = params::parse_typed_params(Some(&param));
        let call = filters::FilterCall {
            value: &input,
            param: Some(&param),
            raw_value: &processed,
            raw_args: raw_args.as_deref(),
            env,
        };
        let out = filters::apply(name, &call).map(|o| o.value).unwrap_or(Value::String(input.clone()));
        if let Value::String(s) = &out {
            if s.starts_with('[') || s.starts_with('{') {
                if let Some(parsed) = Value::parse_json(s) {
                    processed = parsed;
                    continue;
                }
            }
        }
        processed = out;
    }
    match processed {
        Value::String(s) => s,
        other => other.to_json_string(),
    }
}

// ---- selector and schema resolution ----------------------------------------------

struct ClipResolver<'a> {
    ctx: &'a TemplateContext,
}

impl render::Resolver for ClipResolver<'_> {
    fn resolve(&self, name: &str, scope: &render::Scope) -> Value {
        if let Some(rest) = name.strip_prefix("selectorHtml:") {
            return self.selector(rest, true);
        }
        if let Some(rest) = name.strip_prefix("selector:") {
            return self.selector(rest, false);
        }
        if name.starts_with("schema:") {
            return resolve_schema_variable(name, scope.host);
        }
        Value::Undefined
    }
}

impl ClipResolver<'_> {
    fn selector(&self, part: &str, html: bool) -> Value {
        let Some(doc) = self.ctx.document() else {
            return Value::Undefined;
        };
        let (sel, attr) = match part.find('?') {
            Some(i) if i > 0 && i + 1 < part.len() => (&part[..i], Some(&part[i + 1..])),
            _ => (part, None),
        };
        let sel = sel.replace("\\\"", "\"");
        extract_content_by_selector(doc, &sel, attr, html)
    }
}

/// `extractContentBySelector`: `''` when nothing matches, else one string per
/// element (attribute value, outerHTML, or trimmed textContent).
pub fn extract_content_by_selector(doc: &Document, selector: &str, attribute: Option<&str>, html: bool) -> Value {
    let Ok(ids) = crate::selector::select_all(doc, 0, selector.trim()) else {
        return Value::str("");
    };
    if ids.is_empty() {
        return Value::str("");
    }
    Value::Array(
        ids.into_iter()
            .map(|id| {
                Value::String(match attribute {
                    Some(a) => doc.attr(id, a).unwrap_or("").to_string(),
                    None if html => doc.outer_html(id),
                    None => filters::js_trim(&doc.text_content(id)),
                })
            })
            .collect(),
    )
}

/// `resolveSchemaVariable`.
pub fn resolve_schema_variable(name: &str, variables: &Variables) -> Value {
    let key = name.strip_prefix("schema:").unwrap_or(name);
    // /^(.*?)\[(\*|\d+)\](?:\.(.*))?$/
    let re = regex_lite::Regex::new(r"^(.*?)\[(\*|\d+)\](?:\.(.*))?$").unwrap();
    if let Some(c) = re.captures(key) {
        let array_key = c.get(1).map(|m| m.as_str()).unwrap_or("");
        let idx = &c[2];
        let path = c.get(3).map(|m| m.as_str());
        let Some(raw) = resolve_schema_key(array_key, variables) else {
            return Value::Undefined;
        };
        let parsed = parse_schema_array(&raw);
        let Value::Array(items) = parsed else {
            return Value::Undefined;
        };
        if idx == "*" {
            return match path {
                Some(p) => Value::Array(
                    items
                        .iter()
                        .map(|i| get_nested_value(i, p))
                        .filter(|v| !v.is_nullish())
                        .collect(),
                ),
                None => Value::Array(items),
            };
        }
        let i: usize = idx.parse().unwrap_or(usize::MAX);
        let Some(item) = items.get(i) else {
            return Value::Undefined;
        };
        return match path {
            Some(p) => get_nested_value(item, p),
            None => item.clone(),
        };
    }
    match resolve_schema_key(key, variables) {
        Some(v) => parse_schema_value(&v),
        None => Value::Undefined,
    }
}

fn resolve_schema_key(key: &str, variables: &Variables) -> Option<Value> {
    let name = format!("schema:{key}");
    if let Some(v) = variables.get(&name) {
        return Some(v.clone());
    }
    if !key.contains('@') {
        let suffix = format!(":{key}");
        for k in variables.keys() {
            if k.contains('@') && k.ends_with(&suffix) {
                return variables.get(k).cloned();
            }
        }
    }
    None
}

fn parse_schema_array(v: &Value) -> Value {
    if let Value::String(s) = v {
        let re = regex_lite::Regex::new(r"(?m)^(?:\d+\.|[-*•]\s)").unwrap();
        if re.is_match(s.trim()) {
            // value.split(/(?=\d+\.|[-*•]\s)/) — emulate the lookahead split.
            let marker = regex_lite::Regex::new(r"\d+\.|[-*•]\s").unwrap();
            let mut pieces = Vec::new();
            let mut last = 0;
            for m in marker.find_iter(s) {
                if m.start() > last {
                    pieces.push(&s[last..m.start()]);
                    last = m.start();
                }
            }
            pieces.push(&s[last..]);
            let strip = regex_lite::Regex::new(r"^(?:\d+\.|[-*•])\s*").unwrap();
            return Value::Array(
                pieces
                    .into_iter()
                    .map(|p| strip.replace(p, "").trim().to_string())
                    .filter(|p| !p.is_empty())
                    .map(Value::String)
                    .collect(),
            );
        }
    }
    parse_schema_value(v)
}

fn parse_schema_value(v: &Value) -> Value {
    if let Value::String(s) = v {
        if s.starts_with('[') || s.starts_with('{') {
            if let Some(p) = Value::parse_json(s) {
                return p;
            }
        }
    }
    v.clone()
}

fn get_nested_value(obj: &Value, path: &str) -> Value {
    if path.is_empty() || obj.is_nullish() {
        return Value::Undefined;
    }
    let mut cur = obj.clone();
    for key in path.split('.') {
        if cur.is_nullish() {
            return Value::Undefined;
        }
        if let (Some(open), true) = (key.find('['), key.contains(']')) {
            let close = key[open..].find(']').map(|c| c + open).unwrap_or(key.len());
            let array_key = &key[..open];
            let index = &key[open + 1..close];
            if !index.is_empty() {
                let base = if array_key.is_empty() {
                    cur.clone()
                } else {
                    render::own_property(&cur, array_key).unwrap_or(Value::Undefined)
                };
                cur = match base {
                    Value::Array(a) => crate::value::parse_int(index)
                        .and_then(|n| usize::try_from(n).ok())
                        .and_then(|n| a.get(n).cloned())
                        .unwrap_or(Value::Undefined),
                    Value::Object(m) => m.get(index.trim_matches(['"', '\''])).cloned().unwrap_or(Value::Undefined),
                    _ => return Value::Undefined,
                };
                continue;
            }
        }
        cur = render::own_property(&cur, key).unwrap_or(Value::Undefined);
    }
    cur
}

// ---- page variables ------------------------------------------------------------

/// A `<meta>` tag as the clipper records it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct MetaTag {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub property: Option<String>,
    pub content: Option<String>,
}

/// Inputs of `buildVariables`.
#[derive(Debug, Clone, Default)]
pub struct PageData {
    pub title: String,
    pub author: String,
    /// Markdown of the content (the clipper converts `content_html`).
    pub content: String,
    pub content_html: String,
    pub url: String,
    pub full_html: String,
    pub description: String,
    pub favicon: String,
    pub image: String,
    pub published: String,
    pub site: String,
    pub language: String,
    pub word_count: usize,
    pub selection: String,
    pub selection_html: String,
    pub highlights: String,
    pub schema_org: Vec<Value>,
    pub meta_tags: Vec<MetaTag>,
    pub extra: Vec<(String, String)>,
}

/// `buildVariables` — the preset variable dictionary.
pub fn build_variables(p: &PageData, now_ms: f64, tz_offset_minutes: i32) -> Variables {
    let url = strip_text_fragment(&p.url);
    let t = filters::js_trim;
    let timestamp = crate::date::format(&crate::date::DateTime::from_epoch_ms(now_ms, tz_offset_minutes), "YYYY-MM-DDTHH:mm:ssZ");
    let mut v = Variables::new();
    let mut put = |k: &str, s: String| v.insert(k, Value::String(s));
    put("author", t(&p.author));
    put("content", t(&p.content));
    put("contentHtml", t(&p.content_html));
    put("selection", t(&p.selection));
    put("selectionHtml", t(&p.selection_html));
    put("date", timestamp.clone());
    put("time", timestamp);
    put("description", t(&p.description));
    put("domain", crate::url::domain(&url));
    put("favicon", p.favicon.clone());
    put("fullHtml", t(&p.full_html));
    put("highlights", p.highlights.clone());
    put("image", p.image.clone());
    put("noteName", t(&sanitize_file_name(&p.title)));
    put("published", t(p.published.split(',').next().unwrap_or("")));
    put("site", t(&p.site));
    put("title", t(&p.title));
    put("url", t(&url));
    put("language", t(&p.language));
    put("words", p.word_count.to_string());
    for (k, val) in &p.extra {
        put(k, val.clone());
    }
    for m in &p.meta_tags {
        if let Some(content) = m.content.as_ref().filter(|c| !c.is_empty()) {
            if let Some(n) = m.name.as_ref().filter(|n| !n.is_empty()) {
                v.insert(format!("meta:name:{n}"), Value::String(content.clone()));
            }
            if let Some(pr) = m.property.as_ref().filter(|n| !n.is_empty()) {
                v.insert(format!("meta:property:{pr}"), Value::String(content.clone()));
            }
        }
    }
    if !p.schema_org.is_empty() {
        add_schema_org(&Value::Array(p.schema_org.clone()), &mut v, "");
    }
    v
}

/// `addSchemaOrgDataToVariables`.
pub fn add_schema_org(data: &Value, vars: &mut Variables, prefix: &str) {
    match data {
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                let Value::Object(m) = item else { continue };
                match m.get("@type") {
                    Some(Value::Array(types)) => {
                        for t in types {
                            add_schema_org(item, vars, &format!("@{}:", t.js_string()));
                        }
                    }
                    Some(t) if t.truthy() => add_schema_org(item, vars, &format!("@{}:", t.js_string())),
                    _ => add_schema_org(item, vars, &format!("[{i}]:")),
                }
            }
        }
        Value::Object(m) => {
            let object_key = format!("schema:{}", prefix.strip_suffix('.').unwrap_or(prefix));
            vars.insert(object_key, Value::String(data.to_json_string()));
            for (k, val) in m.iter() {
                if k == "@type" {
                    continue;
                }
                let key = format!("schema:{prefix}{k}");
                match val {
                    Value::String(_) | Value::Number(_) | Value::Bool(_) => vars.insert(key, Value::String(val.js_string())),
                    Value::Array(items) => {
                        vars.insert(key, Value::String(val.to_json_string()));
                        for (i, item) in items.iter().enumerate() {
                            add_schema_org(item, vars, &format!("{prefix}{k}[{i}]."));
                        }
                    }
                    Value::Object(_) => add_schema_org(val, vars, &format!("{prefix}{k}.")),
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// The clipper's `sanitizeFileName` (the non-Windows, non-macOS branch — the
/// most portable of the three).
pub fn sanitize_file_name(name: &str) -> String {
    let mut s: String = name.chars().filter(|c| !"#|^[]".contains(*c)).collect();
    s = s.chars().filter(|c| !"<>:\"/\\|?*".contains(*c) && (*c as u32) >= 0x20).collect();
    if let Some(rest) = s.strip_prefix('.') {
        s = format!("_{rest}");
    }
    s = s.trim_start_matches('.').to_string();
    s = filters::js_trim(&s);
    s = crate::value::utf16_slice(&s, Some(0), Some(245));
    if s.is_empty() {
        "Untitled".into()
    } else {
        s
    }
}

// ---- clipper templates -----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Property {
    pub name: String,
    pub value: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClipperTemplate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub behavior: String,
    #[serde(default)]
    pub note_name_format: String,
    #[serde(default)]
    pub path: String,
    pub note_content_format: String,
    pub properties: Vec<Property>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

const VALID_TYPES: &[&str] = &["text", "multitext", "number", "checkbox", "date", "datetime"];

impl ClipperTemplate {
    pub fn is_daily(&self) -> bool {
        self.behavior == "append-daily" || self.behavior == "prepend-daily"
    }
}

/// Parse and validate an exported template (`validateImportedTemplate`).
pub fn parse_template_json(json: &str) -> Result<ClipperTemplate, String> {
    let raw: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("Invalid template file: {e}"))?;
    let obj = raw.as_object().ok_or("Invalid template file: not an object")?;
    for field in ["name", "behavior", "properties", "noteContentFormat"] {
        if !obj.contains_key(field) {
            return Err(format!("Invalid template file: missing {field}"));
        }
    }
    let props = obj["properties"].as_array().ok_or("Invalid template file: properties must be an array")?;
    for p in props {
        let po = p.as_object().ok_or("Invalid template file: bad property")?;
        if !po.contains_key("name") || !po.contains_key("value") {
            return Err("Invalid template file: property needs name and value".into());
        }
        if let Some(t) = po.get("type") {
            if !t.as_str().is_some_and(|t| VALID_TYPES.contains(&t)) {
                return Err(format!("Invalid template file: bad property type {t}"));
            }
        }
    }
    let behavior = obj["behavior"].as_str().unwrap_or("");
    let daily = behavior == "append-daily" || behavior == "prepend-daily";
    if !daily && (!obj.contains_key("noteNameFormat") || !obj.contains_key("path")) {
        return Err("Invalid template file: missing noteNameFormat or path".into());
    }
    if let Some(c) = obj.get("context") {
        if !c.is_string() && !c.is_null() {
            return Err("Invalid template file: context must be a string".into());
        }
    }
    let mut t: ClipperTemplate = serde_json::from_value(raw).map_err(|e| format!("Invalid template file: {e}"))?;
    for p in &mut t.properties {
        if p.kind.is_none() {
            p.kind = Some("text".into());
        }
    }
    Ok(t)
}

/// Serialise a template exactly as the clipper's Export button does.
pub fn serialize_template_json(t: &ClipperTemplate) -> String {
    let mut m = Map::new();
    m.insert("schemaVersion", Value::str("0.1.0"));
    m.insert("name", Value::str(&t.name));
    m.insert("behavior", Value::str(&t.behavior));
    m.insert("noteContentFormat", Value::str(&t.note_content_format));
    m.insert(
        "properties",
        Value::Array(
            t.properties
                .iter()
                .map(|p| {
                    let mut pm = Map::new();
                    pm.insert("name", Value::str(&p.name));
                    pm.insert("value", Value::str(&p.value));
                    pm.insert("type", Value::str(p.kind.as_deref().unwrap_or("text")));
                    Value::Object(pm)
                })
                .collect(),
        ),
    );
    if let Some(tr) = &t.triggers {
        m.insert("triggers", Value::Array(tr.iter().map(Value::str).collect()));
    }
    if !t.is_daily() {
        m.insert("noteNameFormat", Value::str(&t.note_name_format));
        m.insert("path", Value::str(&t.path));
    }
    if let Some(c) = t.context.as_ref().filter(|c| !c.is_empty()) {
        m.insert("context", Value::str(c));
    }
    Value::Object(m).to_json_pretty(1).lines().map(|l| {
        let spaces = l.len() - l.trim_start_matches(' ').len();
        format!("{}{}", "\t".repeat(spaces), &l[spaces..])
    }).collect::<Vec<_>>().join("\n")
}

/// Does one trigger match? URL prefix, `/regex/`, or `schema:@Type[.key[=value]]`.
pub fn match_trigger_pattern(pattern: &str, url: &str, schema_org: &[Value]) -> bool {
    if pattern.starts_with("schema:") {
        return match_schema_pattern(pattern, schema_org);
    }
    if pattern.len() >= 2 && pattern.starts_with('/') && pattern.ends_with('/') {
        return filters::js_regex(&pattern[1..pattern.len() - 1], "").is_ok_and(|re| re.is_match(url));
    }
    url.starts_with(pattern)
}

/// Does any of this template's triggers match?
pub fn match_trigger(template: &ClipperTemplate, url: &str, schema_org: &[Value]) -> bool {
    template
        .triggers
        .iter()
        .flatten()
        .any(|t| match_trigger_pattern(t, url, schema_org))
}

/// `matchTemplate`: URL/regex triggers across all templates first, then schema
/// triggers. Returns the index of the first match.
pub fn find_matching_template(templates: &[ClipperTemplate], url: &str, schema_org: &[Value]) -> Option<usize> {
    for (i, t) in templates.iter().enumerate() {
        if t.triggers.iter().flatten().any(|tr| !tr.starts_with("schema:") && match_trigger_pattern(tr, url, &[])) {
            return Some(i);
        }
    }
    if !schema_org.is_empty() {
        for (i, t) in templates.iter().enumerate() {
            if t.triggers.iter().flatten().any(|tr| tr.starts_with("schema:") && match_schema_pattern(tr, schema_org)) {
                return Some(i);
            }
        }
    }
    None
}

fn match_schema_pattern(pattern: &str, schema_org: &[Value]) -> bool {
    let re = regex_lite::Regex::new(r"^schema:(@\w+)?(?:\.(.+?))?(?:=(.+))?$").unwrap();
    let Some(c) = re.captures(pattern) else {
        return false;
    };
    let ty = c.get(1).map(|m| &m.as_str()[1..]);
    let key = c.get(2).map(|m| m.as_str());
    let expected = c.get(3).map(|m| m.as_str());
    if ty.is_none() && key.is_none() {
        return false;
    }
    let mut flat: Vec<&Value> = Vec::new();
    for s in schema_org {
        match s {
            Value::Array(inner) => flat.extend(inner.iter()),
            other => flat.push(other),
        }
    }
    for schema in flat {
        let Value::Object(m) = schema else { continue };
        if let Some(ty) = ty {
            let matches = match m.get("@type") {
                Some(Value::Array(ts)) => ts.iter().any(|t| t.as_str() == Some(ty)),
                Some(Value::String(t)) => t == ty,
                _ => false,
            };
            if !matches {
                continue;
            }
        }
        let Some(key) = key else {
            return true;
        };
        let mut val = Some(schema.clone());
        for k in key.split('.') {
            val = match val {
                Some(Value::Object(mm)) => mm.get(k).cloned(),
                _ => None,
            };
        }
        match (expected, val) {
            (Some(exp), Some(Value::Array(items))) => {
                if items.iter().any(|i| i.as_str() == Some(exp)) {
                    return true;
                }
            }
            (Some(exp), Some(v)) => {
                if v.as_str() == Some(exp) {
                    return true;
                }
            }
            (None, Some(_)) => return true,
            _ => {}
        }
    }
    false
}

// ---- properties and frontmatter ------------------------------------------------

/// `formatPropertyValue`.
pub fn format_property_value(value: &str, kind: &str, template_value: &str, tz_offset_minutes: i32) -> String {
    match kind {
        "number" => {
            let numeric: String = value.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
            if numeric.is_empty() {
                value.to_string()
            } else {
                crate::value::js_number(crate::value::parse_float(&numeric))
            }
        }
        "checkbox" => (value.to_lowercase() == "true" || value == "1").to_string(),
        "date" | "datetime" => {
            if !template_value.contains("|date:") {
                if let Some(d) = crate::date::parse(value, tz_offset_minutes) {
                    return crate::date::format(&d, if kind == "date" { "YYYY-MM-DD" } else { "YYYY-MM-DDTHH:mm:ssZ" });
                }
            }
            value.to_string()
        }
        _ => value.to_string(),
    }
}

fn yaml_double_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `generateFrontmatter`. `types` maps property name → type and overrides the
/// property's own `type`.
pub fn generate_frontmatter(properties: &[Property], types: &[(String, String)]) -> String {
    let mut fm = String::from("---\n");
    for p in properties {
        let trimmed = p.name.trim();
        let needs_quotes = trimmed.chars().any(|c| ":{}[],&*#?|<>=!%@\\- \t\n".contains(c))
            || trimmed.chars().next().is_some_and(|c| c.is_ascii_digit())
            || matches!(trimmed.to_lowercase().as_str(), "true" | "false" | "null" | "yes" | "no" | "on" | "off");
        let key = if needs_quotes {
            if p.name.contains('"') {
                format!("'{}'", p.name.replace('\'', "''"))
            } else {
                format!("\"{}\"", p.name)
            }
        } else {
            p.name.clone()
        };
        fm.push_str(&key);
        fm.push(':');
        let kind = types
            .iter()
            .find(|(n, _)| *n == p.name)
            .map(|(_, t)| t.as_str())
            .or(p.kind.as_deref())
            .unwrap_or("text");
        match kind {
            "multitext" => {
                let tv = p.value.trim();
                let mut items: Vec<String> = if tv.starts_with("[\"") && tv.ends_with("\"]") {
                    match Value::parse_json(&p.value) {
                        Some(Value::Array(a)) => a.iter().map(|x| x.js_string()).collect(),
                        _ => p.value.split(',').map(|i| i.trim().to_string()).collect(),
                    }
                } else {
                    split_multitext(&p.value)
                };
                items.retain(|i| !i.is_empty());
                fm.push('\n');
                for item in items {
                    fm.push_str("  - ");
                    fm.push_str(&yaml_double_quoted(&item));
                    fm.push('\n');
                }
            }
            "number" => {
                let numeric: String = p.value.chars().filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
                if numeric.is_empty() {
                    fm.push('\n');
                } else {
                    fm.push(' ');
                    fm.push_str(&crate::value::js_number(crate::value::parse_float(&numeric)));
                    fm.push('\n');
                }
            }
            "checkbox" => {
                fm.push_str(if p.value == "true" { " true\n" } else { " false\n" });
            }
            "date" | "datetime" => {
                if p.value.trim().is_empty() {
                    fm.push('\n');
                } else {
                    fm.push(' ');
                    fm.push_str(&p.value);
                    fm.push('\n');
                }
            }
            _ => {
                if p.value.trim().is_empty() {
                    fm.push('\n');
                } else {
                    fm.push(' ');
                    fm.push_str(&yaml_double_quoted(&p.value));
                    fm.push('\n');
                }
            }
        }
    }
    fm.push_str("---\n");
    if fm == "---\n---\n" {
        return String::new();
    }
    fm
}

/// `value.split(/,(?![^\[]*\]\])/)` — commas inside `[[wikilinks]]` survive.
fn split_multitext(v: &str) -> Vec<String> {
    let chars: Vec<char> = v.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if c == ',' {
            // Lookahead: [^\[]*\]\] — no '[' before a "]]".
            let rest: String = chars[i + 1..].iter().collect();
            let inside = match rest.find("]]") {
                Some(pos) => !rest[..pos].contains('['),
                None => false,
            };
            if !inside {
                out.push(cur.trim().to_string());
                cur.clear();
                continue;
            }
        }
        cur.push(c);
    }
    out.push(cur.trim().to_string());
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipResult {
    pub note_name: String,
    pub frontmatter: String,
    pub content: String,
    pub full_content: String,
    pub properties: Vec<Property>,
    pub prompts: Vec<PromptVariable>,
    pub errors: Vec<Diagnostic>,
}

/// Compile a whole clipper template (`api.ts` `clip`), given a context
/// already holding the page variables.
pub fn clip(template: &ClipperTemplate, ctx: &TemplateContext, property_types: &[(String, String)]) -> ClipResult {
    let mut errors = Vec::new();
    let mut compile = |text: &str| {
        let r = render_template_full(text, ctx);
        errors.extend(r.errors);
        r.output
    };
    let raw_name = compile(&template.note_name_format);
    let note_name = sanitize_file_name(&raw_name);
    let properties: Vec<Property> = template
        .properties
        .iter()
        .map(|p| {
            let value = compile(&p.value);
            let kind = p.kind.clone().unwrap_or_else(|| "text".into());
            Property {
                name: p.name.clone(),
                value: format_property_value(&value, &kind, &p.value, ctx.tz_offset_minutes),
                kind: p.kind.clone(),
            }
        })
        .collect();
    let mut types: Vec<(String, String)> = property_types.to_vec();
    for p in &template.properties {
        if let Some(k) = &p.kind {
            if !types.iter().any(|(n, _)| *n == p.name) {
                types.push((p.name.clone(), k.clone()));
            }
        }
    }
    let frontmatter = generate_frontmatter(&properties, &types);
    let content = compile(&template.note_content_format);
    let mut texts: Vec<&str> = vec![&template.note_content_format];
    for p in &template.properties {
        texts.push(&p.value);
    }
    let prompts = collect_prompts(&texts);
    let full_content = if frontmatter.is_empty() { content.clone() } else { format!("{frontmatter}{content}") };
    ClipResult {
        note_name,
        frontmatter,
        content,
        full_content,
        properties,
        prompts,
        errors,
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod oracle_tests;

#[cfg(test)]
mod validate_oracle_tests;
