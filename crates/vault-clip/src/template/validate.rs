//! Filter parameter validators (`validateParams` in each knap filter).
//!
//! Knap runs these twice: statically over literal arguments (reported but
//! non-fatal) and at render time when an argument came from a variable (fatal
//! for that expression, which then renders as nothing).

use super::params::*;

pub fn validate_params(name: &str, param: Option<&str>) -> Result<(), String> {
    let param = param.filter(|p| !p.is_empty());
    match name {
        "calc" => {
            let Some(p) = param else {
                return Err("requires an operation (e.g., calc:\"+10\", calc:\"*2\")".into());
            };
            let op = clean_scalar_param(Some(p)).unwrap_or_default();
            let op = op.trim();
            if op.is_empty() {
                return Err("operation cannot be empty".into());
            }
            let operator = if op.starts_with("**") { "**" } else { &op[..op.chars().next().map(|c| c.len_utf8()).unwrap_or(1)] };
            if !["+", "-", "*", "/", "^", "**"].contains(&operator) {
                return Err(format!("invalid operator \"{operator}\". Use +, -, *, /, ^ or **"));
            }
            let rest = &op[operator.len()..];
            if rest.is_empty() || crate::value::string_to_number(rest).is_nan() {
                return Err("requires a number after the operator (e.g., \"+10\")".into());
            }
            Ok(())
        }
        "code" | "code_block" => {
            let lang = clean_scalar_param(param);
            if lang.is_some_and(|l| l.contains(['\r', '\n', '`'])) {
                return Err("language cannot contain newlines or backticks".into());
            }
            Ok(())
        }
        "date_modify" => {
            let Some(p) = param else {
                return Err("requires a modifier (e.g., date_modify:\"+1 day\", \"-2 weeks\")".into());
            };
            let clean = clean_scalar_param(Some(p)).unwrap_or_default();
            let re = regex_lite::Regex::new(r"^([+-])\s*(\d+)\s*(\w+)s?$").unwrap();
            let Some(c) = re.captures(clean.trim()) else {
                return Err("invalid format. Use \"+1 day\", \"-2 weeks\", etc.".into());
            };
            let unit = c[3].to_lowercase();
            let unit = unit.strip_suffix('s').unwrap_or(&unit);
            if !["year", "month", "week", "day", "hour", "minute", "second"].contains(&unit) {
                return Err(format!(
                    "invalid unit \"{}\". Use year, month, week, day, hour, minute, or second",
                    &c[3]
                ));
            }
            Ok(())
        }
        "hr" => match clean_scalar_param(param) {
            None => Ok(()),
            Some(p) if ["after", "before", "both"].contains(&p.as_str()) => Ok(()),
            Some(p) => Err(format!("invalid position \"{p}\". Use \"after\", \"before\", or \"both\"")),
        },
        "highlight" => match clean_scalar_param(param) {
            None => Ok(()),
            Some(c) if ["red", "orange", "yellow", "green", "blue", "purple"].contains(&c.as_str()) => Ok(()),
            Some(c) => Err(format!("invalid color \"{c}\". Use red, orange, yellow, green, blue, or purple")),
        },
        "bold" | "italic" => match clean_scalar_param(param) {
            None => Ok(()),
            Some(m) if m == "*" || m == "_" => Ok(()),
            Some(m) => Err(format!("invalid marker \"{m}\". Use \"*\" or \"_\"")),
        },
        "indent" => {
            let Some(p) = param else { return Ok(()) };
            let w = clean_scalar_param(Some(p)).unwrap_or_default();
            if !w.is_empty() && w.chars().all(|c| c.is_ascii_digit()) && w.parse::<u64>().is_ok_and(|n| n <= 1000) {
                Ok(())
            } else {
                Err("requires an integer from 0 to 1000 spaces (e.g., indent:2)".into())
            }
        }
        "list" => match param {
            None => Ok(()),
            Some(p) => match clean_scalar_param(Some(p)) {
                Some(o) if ["numbered", "task", "numbered-task"].contains(&o.as_str()) => Ok(()),
                o => Err(format!(
                    "invalid list type \"{}\". Use \"numbered\", \"task\", or \"numbered-task\"",
                    o.unwrap_or_default()
                )),
            },
        },
        "map" => {
            let Some(p) = param else {
                return Err("requires a property path or arrow function (e.g., map:\"name\")".into());
            };
            if regex_lite::Regex::new(r"^\s*(\w+)\s*=>\s*(.+)$").unwrap().is_match(p) {
                return Ok(());
            }
            let parts = split_params(&unwrap_param_list(p));
            if parts.len() != 1 || unquote_param_token(&parts[0]).is_empty() {
                return Err("requires a property path or arrow function (e.g., map:\"name\")".into());
            }
            if unquote_param_token(&parts[0]).split('.').any(|s| s.is_empty()) {
                return Err("property path cannot contain empty segments".into());
            }
            Ok(())
        }
        "nth" => {
            let Some(p) = param else { return Ok(()) };
            if p.contains(':') {
                let mut it = p.split(':').map(|x| x.trim());
                let positions = it.next().unwrap_or("");
                let basis = it.next().unwrap_or("");
                if positions.split(',').any(|n| crate::value::parse_int(n.trim()).is_none_or(|v| v < 1)) {
                    return Err("positions must be positive numbers (e.g., nth:1,2,3:7)".into());
                }
                if crate::value::parse_int(basis).is_none_or(|v| v < 1) {
                    return Err("basis must be a positive number (e.g., nth:1,2,3:7)".into());
                }
                return Ok(());
            }
            let e = p.trim();
            let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
            if digits(e) || e.strip_suffix('n').is_some_and(digits) || e.strip_prefix("n+").is_some_and(digits) {
                Ok(())
            } else {
                Err("invalid syntax. Use number (2), multiplier (5n), offset (n+7), or basis (1,2:5)".into())
            }
        }
        "object" => {
            let Some(p) = param else {
                return Err("requires a parameter: \"array\", \"keys\", or \"values\"".into());
            };
            match clean_scalar_param(Some(p)) {
                Some(o) if ["array", "keys", "values"].contains(&o.as_str()) => Ok(()),
                o => Err(format!(
                    "invalid parameter \"{}\". Use \"array\", \"keys\", or \"values\"",
                    o.unwrap_or_default()
                )),
            }
        }
        "replace" => {
            let Some(p) = param else {
                return Err("requires search and replacement (e.g., replace:\"old\":\"new\")".into());
            };
            let unwrapped = unwrap_param_list(p);
            let quoted = regex_lite::Regex::new(r#"^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$"#).unwrap();
            let regex = regex_lite::Regex::new(r"^/(?:\\.|[^/\\])+/[gimsuy]*$").unwrap();
            let reps = split_params(&unwrapped);
            let all_valid = !reps.is_empty()
                && reps.iter().all(|r| match split_pair_for_validation(r) {
                    Some((s, v)) => {
                        (quoted.is_match(s.trim()) || regex.is_match(s.trim()))
                            && (v.trim().is_empty() || quoted.is_match(v.trim()))
                    }
                    None => false,
                });
            let legacy = regex_lite::Regex::new(r#"["'][^"']*["']\s*:\s*["'][^"']*["']"#).unwrap().is_match(&unwrapped)
                || regex_lite::Regex::new(r#"["'][^"']*["']\s*:"#).unwrap().is_match(&unwrapped)
                || regex_lite::Regex::new(r"/[^/]+/[gimsuy]*\s*:").unwrap().is_match(&unwrapped);
            if all_valid || legacy {
                Ok(())
            } else {
                Err("values must be quoted (e.g., replace:\"old\":\"new\" or replace:\"text\":\"\")".into())
            }
        }
        "round" => match param {
            None => Ok(()),
            Some(p) => match crate::value::parse_int(&clean_scalar_param(Some(p)).unwrap_or_default()) {
                None => Err("decimal places must be a number (e.g., round:2)".into()),
                Some(n) if n < 0 => Err("decimal places must be non-negative (e.g., round:2)".into()),
                _ => Ok(()),
            },
        },
        "safe_name" => match param {
            None => Ok(()),
            Some(p) => match clean_scalar_param(Some(p)).map(|o| o.to_lowercase()) {
                Some(o) if ["windows", "mac", "linux"].contains(&o.as_str()) => Ok(()),
                o => Err(format!("invalid OS \"{}\". Use \"windows\", \"mac\", or \"linux\"", o.unwrap_or_default())),
            },
        },
        "slice" => {
            let Some(p) = param else {
                return Err("requires at least a start index (e.g., slice:0,5)".into());
            };
            let parts: Vec<String> = split_params(&unwrap_param_list(p)).iter().map(|t| clean_param_token(t)).collect();
            if parts.len() > 2 {
                return Err("accepts at most 2 parameters: start and end".into());
            }
            for part in &parts {
                if !part.is_empty() && crate::value::parse_int(part).is_none() {
                    return Err(format!("\"{part}\" is not a valid number"));
                }
            }
            Ok(())
        }
        "sort" => {
            let Some(p) = param else { return Ok(()) };
            let parts: Vec<String> = split_params(&unwrap_param_list(p)).iter().map(|t| clean_param_token(t)).collect();
            if parts.len() > 2 {
                return Err("accepts at most a property and direction".into());
            }
            if parts.len() == 2 && parts[0].is_empty() {
                return Err("property cannot be empty".into());
            }
            let dir = if parts.len() == 1 && (parts[0] == "asc" || parts[0] == "desc") {
                parts[0].clone()
            } else {
                parts.get(1).filter(|d| !d.is_empty()).cloned().unwrap_or_else(|| "asc".into())
            };
            if dir != "asc" && dir != "desc" {
                return Err(format!("invalid direction \"{dir}\". Use \"asc\" or \"desc\""));
            }
            Ok(())
        }
        "sum" => {
            let Some(p) = param else { return Ok(()) };
            let parts = split_params(&unwrap_param_list(p));
            if parts.len() != 1 {
                return Err("accepts at most one property path".into());
            }
            let path = unquote_param_token(&parts[0]);
            if path.is_empty() {
                return Err("property path cannot be empty".into());
            }
            if path.split('.').any(|s| s.is_empty()) {
                return Err("property path cannot contain empty segments".into());
            }
            Ok(())
        }
        "template" => match param {
            None => Err("requires a template string (e.g., template:\"${name}\")".into()),
            Some(_) => Ok(()),
        },
        "truncate" | "truncatewords" => {
            let example = if name == "truncate" { "truncate:100" } else { "truncatewords:20" };
            let parts: Vec<String> = param
                .map(|p| split_params(&unwrap_param_list(p)).iter().map(|t| clean_param_token(t)).collect())
                .unwrap_or_default();
            if parts.is_empty() || parts[0].is_empty() {
                return Err(format!("requires a non-negative limit (e.g., {example})"));
            }
            if parts.len() > 2 {
                return Err("accepts at most a limit and suffix".into());
            }
            if !parts[0].chars().all(|c| c.is_ascii_digit()) {
                return Err("limit must be a non-negative integer".into());
            }
            Ok(())
        }
        "where" => {
            let Some(p) = param else {
                return Err("requires a property path and value".into());
            };
            let parts = split_params(&unwrap_param_list(p));
            if parts.len() != 2 {
                return Err("requires exactly a property path and value".into());
            }
            let path = unquote_param_token(&parts[0]);
            if path.is_empty() {
                return Err("property path cannot be empty".into());
            }
            if path.split('.').any(|s| s.is_empty()) {
                return Err("property path cannot contain empty segments".into());
            }
            Ok(())
        }
        "yaml" => match param {
            None => Ok(()),
            Some(p) if clean_scalar_param(Some(p)).as_deref() == Some("flow") => Ok(()),
            Some(_) => Err("accepts only \"flow\"; omit the parameter for block YAML".into()),
        },
        "yaml_property" => {
            let key = param.and_then(|p| {
                let parts = split_params(&unwrap_param_list(p));
                (parts.len() == 1).then(|| clean_param_token(&parts[0]))
            });
            if key.is_some_and(|k| !k.trim().is_empty()) {
                Ok(())
            } else {
                Err("requires one non-empty property name (e.g., yaml_property:\"director\")".into())
            }
        }
        _ => Ok(()),
    }
}

fn split_pair_for_validation(value: &str) -> Option<(String, String)> {
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

/// knap `expressionToString` for a literal argument (static validation).
pub fn literal_to_param(value: &super::parser::Lit) -> String {
    use super::parser::Lit;
    match value {
        Lit::Str(s) => {
            let quoted = (s.chars().count() >= 2
                && matches!(s.chars().next(), Some('"' | '\''))
                && matches!(s.chars().last(), Some('"' | '\'')))
                || s.contains("\":\"")
                || s.contains("':'");
            let arrow = regex_lite::Regex::new(r"\s*\w+\s*=>").unwrap().is_match(s);
            let simple = !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.:+-*/".contains(c));
            if quoted || arrow || simple {
                s.clone()
            } else {
                format!("\"{s}\"")
            }
        }
        Lit::Num(n) => crate::value::js_number(*n),
        Lit::Bool(b) => b.to_string(),
        Lit::Null => "null".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validators_accept_documented_forms() {
        for (name, p) in [
            ("calc", "\"+10\""),
            ("calc", "\"**2\""),
            ("date_modify", "\"+1 day\""),
            ("date_modify", "\"- 2 months\""),
            ("replace", "\"a\":\"b\""),
            ("replace", "\"/x/g\":\"\""),
            ("slice", "0,5"),
            ("sort", "(\"name\", \"desc\")"),
            ("nth", "1,2,3:5"),
            ("nth", "n+3"),
            ("truncate", "(10, \"...\")"),
            ("where", "(\"a\", true)"),
            ("object", "keys"),
            ("list", "numbered"),
            ("yaml", "flow"),
            ("indent", "4"),
        ] {
            assert!(validate_params(name, Some(p)).is_ok(), "{name}:{p}");
        }
    }

    #[test]
    fn validators_reject_bad_forms() {
        for (name, p) in [
            ("calc", Some("\"%3\"")),
            ("calc", None),
            ("date_modify", Some("\"+1 fortnight\"")),
            ("replace", Some("a:b")),
            ("slice", Some("x")),
            ("sort", Some("(\"n\",\"sideways\")")),
            ("nth", Some("abc")),
            ("truncate", Some("many")),
            ("where", Some("\"a\"")),
            ("object", Some("entries")),
            ("list", Some("bullets")),
            ("highlight", Some("pink")),
            ("safe_name", Some("dos")),
        ] {
            assert!(validate_params(name, p).is_err(), "{name}:{p:?}");
        }
    }
}
