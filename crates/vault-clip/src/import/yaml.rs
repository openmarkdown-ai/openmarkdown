//! YAML frontmatter the way Obsidian writes it.
//!
//! Obsidian's `stringifyYaml` (the `yaml` library's defaults) writes a string
//! plain unless plain would read back as something else — a number, a boolean,
//! null, a flow collection, a comment — and then uses double quotes; a string
//! with newlines becomes a `|-` block; sequences are indented two spaces. The
//! importer tests record exactly that output (`Author: "[[Frank Herbert]]"`,
//! `Rating: 8/10`, `Content: |-`), so the same rules are reproduced here.

/// A frontmatter value.
#[derive(Debug, Clone, PartialEq)]
pub enum Yaml {
    Null,
    Bool(bool),
    /// A number, already in canonical text form.
    Number(String),
    Str(String),
    List(Vec<Yaml>),
}

impl Yaml {
    pub fn str(s: impl Into<String>) -> Yaml {
        Yaml::Str(s.into())
    }

    pub fn list<I, S>(items: I) -> Yaml
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Yaml::List(items.into_iter().map(|s| Yaml::Str(s.into())).collect())
    }

    /// A number from a float, written without a trailing `.0`.
    pub fn number(n: f64) -> Yaml {
        if n.fract() == 0.0 && n.abs() < 1e15 {
            Yaml::Number(format!("{}", n as i64))
        } else {
            Yaml::Number(format!("{n}"))
        }
    }
}

/// `---\n…---\n`, or an empty string when there are no properties.
pub fn frontmatter(props: &[(String, Yaml)]) -> String {
    if props.is_empty() {
        return String::new();
    }
    let mut out = String::from("---\n");
    for (k, v) in props {
        out.push_str(&key(k));
        out.push(':');
        write_value(&mut out, v);
    }
    out.push_str("---\n");
    out
}

fn write_value(out: &mut String, v: &Yaml) {
    match v {
        Yaml::Null => out.push('\n'),
        Yaml::Bool(b) => out.push_str(if *b { " true\n" } else { " false\n" }),
        Yaml::Number(n) => {
            out.push(' ');
            out.push_str(n);
            out.push('\n');
        }
        Yaml::Str(s) => {
            if s.contains('\n') {
                out.push(' ');
                out.push_str(&block(s, "  "));
            } else {
                out.push(' ');
                out.push_str(&scalar(s));
                out.push('\n');
            }
        }
        Yaml::List(items) => {
            if items.is_empty() {
                out.push_str(" []\n");
                return;
            }
            out.push('\n');
            for item in items {
                out.push_str("  -");
                match item {
                    Yaml::Str(s) if s.contains('\n') => {
                        out.push(' ');
                        out.push_str(&block(s, "    "));
                    }
                    Yaml::List(_) => {
                        // Nested lists do not occur in frontmatter we write;
                        // flatten rather than emit an unreadable shape.
                        out.push_str(" []\n");
                    }
                    other => write_value(out, other),
                }
            }
        }
    }
}

fn block(s: &str, indent: &str) -> String {
    // A leading space on the first line needs an indentation indicator, which
    // is rarely what a reader expects; quote instead.
    if s.starts_with(' ') || s.starts_with('\t') {
        return format!("{}\n", double_quoted(s));
    }
    let trailing = s.len() - s.trim_end_matches('\n').len();
    let chomp = match trailing {
        0 => "-",
        1 => "",
        _ => "+",
    };
    let body = s.strip_suffix('\n').unwrap_or(s);
    let mut out = format!("|{chomp}\n");
    let lines: Vec<&str> = if trailing > 1 {
        body.split('\n').collect()
    } else {
        body.trim_end_matches('\n').split('\n').collect()
    };
    for line in lines {
        if !line.is_empty() {
            out.push_str(indent);
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

fn key(k: &str) -> String {
    if k.is_empty() || needs_quotes(k) {
        double_quoted(k)
    } else {
        k.to_string()
    }
}

/// A single-line string as a YAML scalar: plain when that reads back as the
/// same string, otherwise double-quoted.
pub fn scalar(s: &str) -> String {
    if s.is_empty() || needs_quotes(s) {
        double_quoted(s)
    } else {
        s.to_string()
    }
}

fn needs_quotes(s: &str) -> bool {
    let first = s.chars().next().unwrap_or(' ');
    if "\t ,[]{}#&*!|>'\"%@`".contains(first) {
        return true;
    }
    if s == "?" || s == "-" || s.starts_with("? ") || s.starts_with("- ") || s.starts_with("-\t") {
        return true;
    }
    if s.contains(": ") || s.contains(":\t") || s.contains(" #") || s.contains("\t#") {
        return true;
    }
    let last = s.chars().last().unwrap_or(' ');
    if last == ':' || last == ' ' || last == '\t' {
        return true;
    }
    if s.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}' || c == '\u{feff}') {
        return true;
    }
    resolves_as_non_string(s)
}

/// Would a YAML 1.2 core-schema parser (Obsidian's) read this plain scalar as
/// something other than a string?
fn resolves_as_non_string(s: &str) -> bool {
    matches!(
        s,
        "~" | "null" | "Null" | "NULL" | "true" | "True" | "TRUE" | "false" | "False" | "FALSE"
            | ".inf" | ".Inf" | ".INF" | "-.inf" | "+.inf" | ".nan" | ".NaN" | ".NAN"
    ) || is_yaml_number(s)
}

/// Integer or float syntax of the YAML core schema, plus hex and octal.
pub fn is_yaml_number(s: &str) -> bool {
    let body = s.strip_prefix(['-', '+']).unwrap_or(s);
    if body.is_empty() {
        return false;
    }
    if let Some(hex) = body.strip_prefix("0x") {
        return !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    if let Some(oct) = body.strip_prefix("0o") {
        return !oct.is_empty() && oct.chars().all(|c| ('0'..='7').contains(&c));
    }
    let (mantissa, exp) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    if let Some(e) = exp {
        let e = e.strip_prefix(['-', '+']).unwrap_or(e);
        if e.is_empty() || !e.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    let mut dots = 0;
    let mut digits = 0;
    for c in mantissa.chars() {
        if c == '.' {
            dots += 1;
        } else if c.is_ascii_digit() {
            digits += 1;
        } else {
            return false;
        }
    }
    dots <= 1 && digits > 0
}

fn double_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\x{:02X}", c as u32));
            }
            '\u{feff}' => out.push_str("\\uFEFF"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Type a raw text value the way the CSV importer's `convertToYAML` does:
/// empty is null, `true`/`false` are booleans, a number that round-trips is
/// a number, anything else is a string.
pub fn typed(value: &str) -> Yaml {
    let t = value.trim();
    if t.is_empty() {
        return Yaml::Null;
    }
    match t {
        "true" | "TRUE" | "True" => return Yaml::Bool(true),
        "false" | "FALSE" | "False" => return Yaml::Bool(false),
        _ => {}
    }
    // Leading zeros ("007", zip codes) and "+1" are identifiers, not numbers.
    let digits = t.strip_prefix('-').unwrap_or(t);
    let leading_zero = digits.len() > 1 && digits.starts_with('0') && !digits.starts_with("0.");
    if !leading_zero
        && !t.starts_with('+')
        && !t.starts_with('.')
        && !t.ends_with('.')
        && t.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-')
        && is_yaml_number(t)
        && t.parse::<f64>().map(|f| f.is_finite()).unwrap_or(false)
    {
        return Yaml::Number(t.to_string());
    }
    Yaml::Str(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fm(props: Vec<(&str, Yaml)>) -> String {
        frontmatter(
            &props
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn quotes_like_obsidian() {
        assert_eq!(scalar("[[Frank Herbert]]"), "\"[[Frank Herbert]]\"");
        assert_eq!(scalar("8/10"), "8/10");
        assert_eq!(scalar("http://www.blankwebsite.com/"), "http://www.blankwebsite.com/");
        assert_eq!(scalar("2024-01-15"), "2024-01-15");
        assert_eq!(scalar("true"), "\"true\"");
        assert_eq!(scalar("42"), "\"42\"");
        assert_eq!(scalar("1e5"), "\"1e5\"");
        assert_eq!(scalar("a: b"), "\"a: b\"");
        assert_eq!(scalar("note #1"), "\"note #1\"");
        assert_eq!(scalar("#tag"), "\"#tag\"");
        assert_eq!(scalar("- item"), "\"- item\"");
        assert_eq!(scalar("-x"), "-x");
        assert_eq!(scalar("say \"hi\""), "say \"hi\"");
        assert_eq!(scalar("\"hi\""), "\"\\\"hi\\\"\"");
        assert_eq!(scalar(""), "\"\"");
        assert_eq!(scalar("Note with, comma"), "Note with, comma");
        assert_eq!(scalar("Content with special characters: !@#$%^&*()_+-=[]{}|;:',.<>?"),
            "\"Content with special characters: !@#$%^&*()_+-=[]{}|;:',.<>?\"");
    }

    #[test]
    fn writes_lists_blocks_and_nulls() {
        let out = fm(vec![
            ("Title", Yaml::str("Planning Document")),
            ("Tags", Yaml::list(["planning", "strategy"])),
            ("Content", Yaml::str("Multi-line\ncontent goes\n\nhere.")),
            ("Priority", Yaml::Null),
            ("Completed", Yaml::Bool(false)),
            ("Rating", Yaml::Number("8.5".into())),
            ("empty list", Yaml::List(vec![])),
        ]);
        assert_eq!(
            out,
            "---\nTitle: Planning Document\nTags:\n  - planning\n  - strategy\nContent: |-\n  Multi-line\n  content goes\n\n  here.\nPriority:\nCompleted: false\nRating: 8.5\nempty list: []\n---\n"
        );
        assert_eq!(frontmatter(&[]), "");
    }

    #[test]
    fn typed_values() {
        assert_eq!(typed(""), Yaml::Null);
        assert_eq!(typed("true"), Yaml::Bool(true));
        assert_eq!(typed("8.5"), Yaml::Number("8.5".into()));
        assert_eq!(typed("-3"), Yaml::Number("-3".into()));
        assert_eq!(typed("007"), Yaml::Str("007".into()));
        assert_eq!(typed("2024-01-15"), Yaml::Str("2024-01-15".into()));
        assert_eq!(typed("1e5"), Yaml::Str("1e5".into()));
        assert_eq!(typed("$1,234.56"), Yaml::Str("$1,234.56".into()));
        assert_eq!(typed("1.2.3"), Yaml::Str("1.2.3".into()));
    }

    #[test]
    fn keys_are_quoted_when_needed() {
        let out = fm(vec![("Price (USD)", Yaml::str("$1")), ("a: b", Yaml::Null)]);
        assert_eq!(out, "---\nPrice (USD): $1\n\"a: b\":\n---\n");
    }
}
