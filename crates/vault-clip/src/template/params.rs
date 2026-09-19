//! Filter-parameter string helpers — a port of `knap/src/parser-utils.ts`.
//!
//! Filters receive their arguments as one serialized string (`"a","b"` or
//! `"old":"new"`) and re-split it themselves; these are the shared splitters.

use crate::value::Value;

pub fn parse_regex_pattern(p: &str) -> Option<(String, String)> {
    // /^\/(.+)\/([gimsuy]*)$/
    if !p.starts_with('/') || p.len() < 3 {
        return None;
    }
    let body = &p[1..];
    let last = body.rfind('/')?;
    let flags = &body[last + 1..];
    if !flags.chars().all(|c| "gimsuy".contains(c)) {
        return None;
    }
    let pattern = &body[..last];
    if pattern.is_empty() || pattern.contains('\n') {
        return None;
    }
    Some((pattern.to_string(), flags.to_string()))
}

pub fn unwrap_param_list(value: &str) -> String {
    let t = value.trim();
    if !t.starts_with('(') || !t.ends_with(')') {
        return t.to_string();
    }
    let chars: Vec<char> = t.chars().collect();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut depth = 0i32;
    for (i, &c) in chars.iter().enumerate() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if let Some(q) = quote {
            if c == q {
                quote = None;
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
        } else if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
            if depth == 0 && i != chars.len() - 1 {
                return t.to_string();
            }
        }
    }
    if depth == 0 {
        chars[1..chars.len() - 1].iter().collect::<String>().trim().to_string()
    } else {
        t.to_string()
    }
}

/// `value.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')`
pub fn unquote_param_token(value: &str) -> String {
    let t = value.trim();
    let mut chars = t.chars();
    if let (Some(first), Some(last)) = (chars.next(), t.chars().last()) {
        if (first == '"' || first == '\'') && last == first && t.chars().count() >= 2 {
            let n = t.chars().count();
            return t.chars().skip(1).take(n - 2).collect();
        }
    }
    t.to_string()
}

/// `value.replace(/\\([\\,:|"'])/g, '$1')`
pub fn decode_param_escapes(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&n) = chars.peek() {
                if matches!(n, '\\' | ',' | ':' | '|' | '"' | '\'') {
                    out.push(n);
                    chars.next();
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

pub fn clean_param_token(value: &str) -> String {
    decode_param_escapes(&unquote_param_token(value))
}

pub fn unquote_scalar_param(value: Option<&str>) -> Option<String> {
    let v = value?;
    if !v.is_empty() && v.trim().is_empty() {
        return Some(v.to_string());
    }
    Some(unquote_param_token(&unwrap_param_list(v)))
}

pub fn clean_scalar_param(value: Option<&str>) -> Option<String> {
    unquote_scalar_param(value).map(|v| decode_param_escapes(&v))
}

pub fn split_param_list(value: &str) -> Vec<String> {
    let unwrapped = unwrap_param_list(value);
    let tokens = split_params(&unwrapped);
    let unquoted = if tokens.len() == 1 {
        unquote_param_token(&tokens[0])
    } else {
        String::new()
    };
    let quoted_list = tokens
        .first()
        .is_some_and(|t| unquoted != t.trim() && unquoted.contains(','));
    if quoted_list {
        split_params(&unquoted)
    } else {
        tokens
    }
}

/// `splitParamList(value).map(t => unquoteParamToken(t).replace(/\\(["'])/g, '$1'))`
pub fn normalize_param_list(value: &str) -> Vec<String> {
    split_param_list(value)
        .iter()
        .map(|t| {
            let u = unquote_param_token(t);
            let mut out = String::new();
            let mut chars = u.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\\' && matches!(chars.peek(), Some('"') | Some('\'')) {
                    out.push(chars.next().unwrap());
                    continue;
                }
                out.push(c);
            }
            out
        })
        .collect()
}

fn parse_typed_param_token(value: &str) -> Value {
    let token = value.trim();
    if split_param_pair(token).1.is_some() {
        return Value::str(token);
    }
    let n = token.chars().count();
    if n >= 2 {
        let first = token.chars().next().unwrap();
        if (first == '"' || first == '\'') && token.ends_with(first) {
            let inner: String = token.chars().skip(1).take(n - 2).collect();
            let mut out = String::new();
            let mut chars = inner.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    if let Some(e) = chars.next() {
                        out.push_str(&super::tokenizer::decode_string_escape(e));
                        continue;
                    }
                }
                out.push(c);
            }
            return Value::String(out);
        }
    }
    match token {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        "null" => return Value::Null,
        _ => {}
    }
    if is_json_number(token) {
        if let Ok(n) = token.parse::<f64>() {
            if n.is_finite() {
                return Value::Number(n);
            }
        }
    }
    Value::str(token)
}

fn is_json_number(t: &str) -> bool {
    // /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
    let b = t.as_bytes();
    let mut i = 0;
    if b.first() == Some(&b'-') {
        i += 1;
    }
    match b.get(i) {
        Some(b'0') => i += 1,
        Some(c) if c.is_ascii_digit() => {
            while b.get(i).is_some_and(|c| c.is_ascii_digit()) {
                i += 1;
            }
        }
        _ => return false,
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        let s = i;
        while b.get(i).is_some_and(|c| c.is_ascii_digit()) {
            i += 1;
        }
        if i == s {
            return false;
        }
    }
    if matches!(b.get(i), Some(b'e') | Some(b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+') | Some(b'-')) {
            i += 1;
        }
        let s = i;
        while b.get(i).is_some_and(|c| c.is_ascii_digit()) {
            i += 1;
        }
        if i == s {
            return false;
        }
    }
    i == b.len()
}

pub fn parse_typed_params(value: Option<&str>) -> Option<Vec<Value>> {
    let v = value?;
    if v.is_empty() {
        return None;
    }
    Some(
        split_params(&unwrap_param_list(v))
            .iter()
            .map(|t| parse_typed_param_token(t))
            .collect(),
    )
}

/// Split once on a colon outside quotes or nested brackets.
pub fn split_param_pair(value: &str) -> (String, Option<String>) {
    let chars: Vec<char> = value.chars().collect();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let (mut paren, mut curly, mut bracket) = (0i32, 0i32, 0i32);
    for (i, &c) in chars.iter().enumerate() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if let Some(q) = quote {
            if c == q {
                quote = None;
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
        } else {
            match c {
                '(' => paren += 1,
                ')' => paren -= 1,
                '{' => curly += 1,
                '}' => curly -= 1,
                '[' => bracket += 1,
                ']' => bracket -= 1,
                ':' if paren == 0 && curly == 0 && bracket == 0 => {
                    let a: String = chars[..i].iter().collect();
                    let b: String = chars[i + 1..].iter().collect();
                    return (a.trim().to_string(), Some(b.trim().to_string()));
                }
                _ => {}
            }
        }
    }
    (value.trim().to_string(), None)
}

/// Split comma-separated parameters, respecting quotes and brackets.
pub fn split_params(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let (mut paren, mut curly, mut bracket) = (0i32, 0i32, 0i32);
    for c in value.chars() {
        if escaped {
            current.push(c);
            escaped = false;
        } else if c == '\\' {
            current.push(c);
            escaped = true;
        } else if let Some(q) = quote {
            current.push(c);
            if c == q {
                quote = None;
            }
        } else if c == '"' || c == '\'' {
            current.push(c);
            quote = Some(c);
        } else {
            match c {
                '(' => paren += 1,
                ')' => paren -= 1,
                '{' => curly += 1,
                '}' => curly -= 1,
                '[' => bracket += 1,
                ']' => bracket -= 1,
                ',' if paren == 0 && curly == 0 && bracket == 0 => {
                    parts.push(current.trim().to_string());
                    current.clear();
                    continue;
                }
                _ => {}
            }
            current.push(c);
        }
    }
    parts.push(current.trim().to_string());
    parts
}

/// Character-level state machine used by `applyFiltersWithRegistry` to split a
/// raw `filter1:arg|filter2` string.
#[derive(Default)]
struct PState {
    current: String,
    in_quote: bool,
    quote: char,
    in_regex: bool,
    curly: i32,
    paren: i32,
    escape_next: bool,
}

impl PState {
    fn process(&mut self, c: char) {
        if self.escape_next {
            self.current.push(c);
            self.escape_next = false;
            return;
        }
        if c == '\\' {
            self.current.push(c);
            if !self.in_regex {
                self.escape_next = true;
            }
            return;
        }
        if (c == '"' || c == '\'') && !self.in_regex && (!self.in_quote || self.quote == c) {
            self.in_quote = !self.in_quote;
            self.quote = if self.in_quote { c } else { '\0' };
            self.current.push(c);
            return;
        }
        if c == '/'
            && !self.in_quote
            && !self.in_regex
            && (self.current.ends_with(':') || self.current.ends_with(','))
        {
            self.in_regex = true;
            self.current.push(c);
            return;
        }
        if c == '/' && self.in_regex {
            self.in_regex = false;
            self.current.push(c);
            return;
        }
        match c {
            '{' => self.curly += 1,
            '}' => self.curly -= 1,
            '(' if !self.in_quote => self.paren += 1,
            ')' if !self.in_quote => self.paren -= 1,
            _ => {}
        }
        self.current.push(c);
    }
}

pub fn split_filter_string(s: &str) -> Vec<String> {
    let mut filters = Vec::new();
    let mut st = PState::default();
    for c in s.chars() {
        if c == '|' && !st.escape_next && !st.in_quote && !st.in_regex && st.curly == 0 && st.paren == 0 {
            filters.push(st.current.trim().to_string());
            st.current.clear();
        } else {
            st.process(c);
        }
    }
    if !st.current.is_empty() {
        filters.push(st.current.trim().to_string());
    }
    filters
}

/// Returns `[name, params...]` where params is at most one element.
pub fn parse_filter_string(s: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut st = PState::default();
    for c in s.chars() {
        if c == ':' && !st.escape_next && !st.in_quote && !st.in_regex && st.paren == 0 && parts.is_empty() {
            parts.push(st.current.trim().to_string());
            st.current.clear();
        } else {
            st.process(c);
        }
    }
    if !st.current.is_empty() {
        parts.push(st.current.trim().to_string());
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_unquotes_like_knap() {
        assert_eq!(split_params(r#""a,b", 'c', (d,e)"#), vec![r#""a,b""#, "'c'", "(d,e)"]);
        assert_eq!(unwrap_param_list(r#"("a", "b")"#), r#""a", "b""#);
        assert_eq!(unwrap_param_list("(a)(b)"), "(a)(b)");
        assert_eq!(unquote_param_token(" 'x' "), "x");
        assert_eq!(split_param_pair(r#""a:b":"c""#), (r#""a:b""#.into(), Some(r#""c""#.into())));
        assert_eq!(split_param_list(r#""a, b, c""#), vec!["a", "b", "c"]);
        assert_eq!(parse_regex_pattern("/a+/gi"), Some(("a+".into(), "gi".into())));
        assert_eq!(parse_regex_pattern("/x/q"), None);
    }

    #[test]
    fn typed_params() {
        let v = parse_typed_params(Some(r#""name", 3, true, null, "a:b":"c""#)).unwrap();
        assert_eq!(v[0], Value::str("name"));
        assert_eq!(v[1], Value::Number(3.0));
        assert_eq!(v[2], Value::Bool(true));
        assert_eq!(v[3], Value::Null);
        assert_eq!(v[4], Value::str(r#""a:b":"c""#));
    }

    #[test]
    fn filter_string_splitting_respects_quotes_and_regex() {
        assert_eq!(
            split_filter_string(r#"replace:"|":"-"|upper|split:/a|b/"#),
            vec![r#"replace:"|":"-""#, "upper", "split:/a|b/"]
        );
        assert_eq!(parse_filter_string(r#"date:"HH:mm""#), vec!["date", r#""HH:mm""#]);
    }
}
