//! Parser for Obsidian's search language (`lP`/`cP`/`uP`/`hP` in 1.13).
//!
//! Grammar, as the app's recursive descent implements it:
//!
//! ```text
//! query   := and ( OR and )*                  -- cP
//! and     := primary primary*                 -- uP (implicit AND)
//! primary := WORD ':' primary                 -- operator, unless inside [ ]
//!          | '[' query ( ':' query )? ']'?    -- property
//!          | '(' query ')'?                   -- group
//!          | WORD | "QUOTE" | /REGEX/
//!          | TRUE | FALSE | EMPTY
//!          | '-' primary                      -- exclude
//!          | '<' primary | '>' primary        -- comparison (text or quote)
//! ```
//!
//! Details that matter and are kept:
//!
//! * An operator binds to exactly one primary: `path:a b` is
//!   `path:(a) AND b`. With nothing after the colon the operand is empty
//!   text, which matches nothing.
//! * Inside `[...]` nothing is an operator, so `[status:done]` is a key and
//!   a value, and `[a:b:c]` stops at the second colon.
//! * "Exclusive" operators (`file path content line block section task
//!   task-todo task-done tag`) cannot be nested in each other, except
//!   `section` in `section`. `match-case`/`ignore-case` nest anywhere.
//! * `tag:` takes plain text only; a missing `#` is added.
//! * `task:""` (empty quotes) matches every task.
//! * Parsing stops at the first token no rule consumes (an unmatched `)` or
//!   `]`, a stray `:`); the rest of the query is ignored, as in the app.

use super::lexer::{tokenize, Token, TokenKind};

/// A parsed matcher tree.
#[derive(Clone, Debug)]
pub enum Node {
    /// Bare word: substring match (`tP`).
    Text(String),
    /// Quoted phrase: whole-word in content, substring elsewhere (`eP`).
    Exact(String),
    /// `/regex/` (`ZA`).
    Regex(Box<RegexTerm>),
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
    /// `match-case:` (true) / `ignore-case:` (false).
    Case(bool, Box<Node>),
    Path(Box<Node>),
    File(Box<Node>),
    Content(Box<Node>),
    Line(Box<Node>),
    Block(Box<Node>),
    Section(Box<Node>),
    /// `task:` (None), `task-todo:` (Some(false)), `task-done:` (Some(true)).
    Task(Option<bool>, Box<Node>),
    /// `tag:` with its `#`-prefixed text.
    Tag(String),
    Property {
        key: Box<Node>,
        value: Option<Box<Node>>,
    },
    /// `TRUE` (Some(true)), `FALSE` (Some(false)), `EMPTY` (None).
    Literal(Option<bool>),
    /// `<x` (less = true) or `>x`.
    Compare {
        less: bool,
        text: String,
    },
    /// Matches every non-empty key (what `task:""` becomes).
    Everything,
}

#[derive(Clone, Debug)]
pub struct RegexTerm {
    pub source: String,
    pub sensitive: Option<regex_lite::Regex>,
    pub insensitive: Option<regex_lite::Regex>,
}

/// A parsed query. `root` is `None` for an empty query (which searches
/// nothing).
#[derive(Clone, Debug)]
pub struct Query {
    pub source: String,
    pub root: Option<Node>,
    pub(crate) needs_content: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OpName {
    MatchCase,
    IgnoreCase,
    Path,
    File,
    Content,
    Line,
    Block,
    Section,
    Task,
    TaskTodo,
    TaskDone,
    Tag,
}

impl OpName {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "match-case" => Self::MatchCase,
            "ignore-case" => Self::IgnoreCase,
            "path" => Self::Path,
            "file" => Self::File,
            "content" => Self::Content,
            "line" => Self::Line,
            "block" => Self::Block,
            "section" => Self::Section,
            "task" => Self::Task,
            "task-todo" => Self::TaskTodo,
            "task-done" => Self::TaskDone,
            "tag" => Self::Tag,
            _ => return None,
        })
    }
    fn name(self) -> &'static str {
        match self {
            Self::MatchCase => "match-case",
            Self::IgnoreCase => "ignore-case",
            Self::Path => "path",
            Self::File => "file",
            Self::Content => "content",
            Self::Line => "line",
            Self::Block => "block",
            Self::Section => "section",
            Self::Task => "task",
            Self::TaskTodo => "task-todo",
            Self::TaskDone => "task-done",
            Self::Tag => "tag",
        }
    }
    fn exclusive(self) -> bool {
        !matches!(self, Self::MatchCase | Self::IgnoreCase)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Frame {
    Op(OpName),
    Bracket,
    Colon,
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    stack: Vec<Frame>,
}

/// Parses a query; the error text is what Obsidian shows under the search
/// box.
pub fn parse_query(q: &str) -> Result<Query, String> {
    let tokens = tokenize(q);
    let mut p = Parser {
        tokens,
        pos: 0,
        stack: Vec::new(),
    };
    let root = p.or()?;
    let needs_content = root.as_ref().is_some_and(needs_content);
    Ok(Query {
        source: q.to_string(),
        root,
        needs_content,
    })
}

impl Query {
    /// Whether evaluating needs note contents (`requiredInputs.content`):
    /// false for queries made only of `file:`/`path:` terms, which a caller
    /// can run before note text is loaded.
    pub fn needs_content(&self) -> bool {
        self.needs_content
    }
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn at(&self, kind: TokenKind) -> bool {
        self.peek().is_some_and(|t| t.kind == kind)
    }

    fn in_bracket(&self) -> bool {
        self.stack.contains(&Frame::Bracket)
    }

    fn or(&mut self) -> Result<Option<Node>, String> {
        let mut alts = Vec::new();
        while self.pos < self.tokens.len() {
            let Some(n) = self.and()? else { break };
            alts.push(n);
            if self.at(TokenKind::Or) {
                self.pos += 1;
                continue;
            }
            break;
        }
        Ok(match alts.len() {
            0 => None,
            1 => alts.pop(),
            _ => Some(Node::Or(alts)),
        })
    }

    fn and(&mut self) -> Result<Option<Node>, String> {
        let mut all = Vec::new();
        while self.pos < self.tokens.len() {
            match self.primary()? {
                Some(n) => all.push(n),
                None => break,
            }
        }
        Ok(match all.len() {
            0 => None,
            1 => all.pop(),
            _ => Some(Node::And(all)),
        })
    }

    fn primary(&mut self) -> Result<Option<Node>, String> {
        let Some(tok) = self.peek().cloned() else {
            return Ok(None);
        };
        use TokenKind::*;
        match tok.kind {
            Text if self
                .tokens
                .get(self.pos + 1)
                .is_some_and(|t| t.kind == Colon)
                && !self.in_bracket() =>
            {
                let name = tok.content.to_lowercase();
                let op = OpName::parse(&name)
                    .ok_or_else(|| format!("Operator \"{name}\" not recognized"))?;
                if op.exclusive() {
                    for f in &self.stack {
                        if let Frame::Op(outer) = f {
                            if outer.exclusive()
                                && !(op == OpName::Section && *outer == OpName::Section)
                            {
                                return Err(format!(
                                    "Operator \"{}\" cannot be nested within \"{}\"",
                                    op.name(),
                                    outer.name()
                                ));
                            }
                        }
                    }
                }
                self.stack.push(Frame::Op(op));
                self.pos += 2;
                let operand = self.primary();
                self.stack.pop();
                let operand = operand?.unwrap_or_else(|| Node::Text(String::new()));
                let b = |n: Node| Box::new(n);
                Ok(Some(match op {
                    OpName::MatchCase => Node::Case(true, b(operand)),
                    OpName::IgnoreCase => Node::Case(false, b(operand)),
                    OpName::Path => Node::Path(b(operand)),
                    OpName::File => Node::File(b(operand)),
                    OpName::Content => Node::Content(b(operand)),
                    OpName::Line => Node::Line(b(operand)),
                    OpName::Block => Node::Block(b(operand)),
                    OpName::Section => Node::Section(b(operand)),
                    OpName::Task | OpName::TaskTodo | OpName::TaskDone => {
                        let done = match op {
                            OpName::TaskTodo => Some(false),
                            OpName::TaskDone => Some(true),
                            _ => None,
                        };
                        let operand = match operand {
                            Node::Exact(s) if s.is_empty() => Node::Everything,
                            other => other,
                        };
                        Node::Task(done, b(operand))
                    }
                    OpName::Tag => match operand {
                        Node::Text(t) => Node::Tag(if t.starts_with('#') {
                            t
                        } else {
                            format!("#{t}")
                        }),
                        _ => return Err("Operator \"tag\" can only be followed by text".into()),
                    },
                }))
            }
            BracketOpen => {
                if self.in_bracket() {
                    return Err("Property cannot be nested within a property.".into());
                }
                self.stack.push(Frame::Bracket);
                self.pos += 1;
                let key = self.or()?.unwrap_or_else(|| Node::Text(String::new()));
                let mut value = None;
                if self.at(Colon) {
                    self.stack.push(Frame::Colon);
                    self.pos += 1;
                    let v = self.or();
                    self.stack.pop();
                    value = v?.map(Box::new);
                }
                self.stack.pop();
                if self.at(BracketClose) {
                    self.pos += 1;
                }
                Ok(Some(Node::Property {
                    key: Box::new(key),
                    value,
                }))
            }
            BracketClose | ParenClose | Or | Colon => Ok(None),
            Text => {
                self.pos += 1;
                Ok(Some(Node::Text(tok.content)))
            }
            Quote => {
                self.pos += 1;
                Ok(Some(Node::Exact(tok.content)))
            }
            Regex => {
                let term = compile_regex(&tok.content)?;
                self.pos += 1;
                Ok(Some(Node::Regex(Box::new(term))))
            }
            ParenOpen => {
                self.pos += 1;
                let inner = self.or()?;
                if self.at(ParenClose) {
                    self.pos += 1;
                }
                Ok(Some(inner.unwrap_or_else(|| Node::Text(String::new()))))
            }
            True | False | Empty => {
                self.pos += 1;
                Ok(Some(Node::Literal(match tok.kind {
                    True => Some(true),
                    False => Some(false),
                    _ => None,
                })))
            }
            Not => {
                self.pos += 1;
                Ok(self.primary()?.map(|n| Node::Not(Box::new(n))))
            }
            GreaterThan | LessThan => {
                self.pos += 1;
                let less = tok.kind == LessThan;
                match self.primary()? {
                    None => Ok(None),
                    Some(Node::Text(text)) | Some(Node::Exact(text)) => {
                        Ok(Some(Node::Compare { less, text }))
                    }
                    Some(other) => Err(format!(
                        "{} operator cannot be applied to matcher {}",
                        if less { "lessthan" } else { "greaterthan" },
                        super::explain::label(&other)
                    )),
                }
            }
        }
    }
}

/// Translates the JavaScript regex syntax Obsidian accepts into regex-lite
/// syntax and compiles both case variants (flags `gm` / `gmi`).
pub fn compile_regex(source: &str) -> Result<RegexTerm, String> {
    if source.is_empty() {
        return Ok(RegexTerm {
            source: String::new(),
            sensitive: None,
            insensitive: None,
        });
    }
    let translated = translate_js_regex(source)?;
    let build = |flags: &str| {
        regex_lite::Regex::new(&format!("(?{flags}){translated}")).map_err(|e| {
            format!(
                "Failed to parse regular expression. Invalid regular expression: /{source}/: {}",
                first_line(&e.to_string())
            )
        })
    };
    Ok(RegexTerm {
        source: source.to_string(),
        sensitive: Some(build("m")?),
        insensitive: Some(build("mi")?),
    })
}

fn first_line(s: &str) -> String {
    s.lines()
        .rfind(|l| !l.trim().is_empty())
        .unwrap_or(s)
        .trim()
        .to_string()
}

/// The differences between JavaScript's (non-`u`) regex syntax and
/// regex-lite's that real queries hit:
///
/// * `[^]` (any character) becomes `[\s\S]`;
/// * `\uXXXX` becomes `\x{XXXX}`, `\cX` a control character, `\0` NUL;
/// * a `{` that does not start a valid `{n}`, `{n,}` or `{n,m}` quantifier,
///   and a `}` or `]` with nothing to close, are literal in JavaScript and
///   are escaped;
/// * `\/` is a literal slash (the tokenizer has already unescaped it).
///
/// Lookaround and backreferences have no regex-lite equivalent and are
/// reported as parse errors.
pub fn translate_js_regex(src: &str) -> Result<String, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len() + 8);
    let mut i = 0;
    let mut in_class = false;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' if i + 1 < chars.len() => {
                let d = chars[i + 1];
                match d {
                    'u' if i + 5 < chars.len() &&chars[i + 2..i + 6].iter().all(|h| h.is_ascii_hexdigit()) => {
                        let hex: String = chars[i + 2..i + 6].iter().collect();
                        out.push_str(&format!("\\x{{{hex}}}"));
                        i += 6;
                        continue;
                    }
                    'c' if i + 2 < chars.len() && chars[i + 2].is_ascii_alphabetic() => {
                        let v = (chars[i + 2] as u32) % 32;
                        out.push_str(&format!("\\x{{{v:X}}}"));
                        i += 3;
                        continue;
                    }
                    '0' if !chars.get(i + 2).is_some_and(|x| x.is_ascii_digit()) => {
                        out.push_str("\\x{0}");
                        i += 2;
                        continue;
                    }
                    '1'..='9' if !in_class => return Err(format!("Failed to parse regular expression. Backreferences are not supported: /{src}/")),
                    '/' => {
                        out.push('/');
                        i += 2;
                        continue;
                    }
                    _ => {
                        out.push(c);
                        out.push(d);
                        i += 2;
                        continue;
                    }
                }
            }
            '[' if !in_class => {
                if chars.get(i + 1) == Some(&'^') && chars.get(i + 2) == Some(&']') {
                    out.push_str("[\\s\\S]");
                    i += 3;
                    continue;
                }
                if chars.get(i + 1) == Some(&']') {
                    // `[]` matches nothing in JavaScript.
                    out.push_str("[^\\s\\S]");
                    i += 2;
                    continue;
                }
                in_class = true;
                out.push('[');
                if chars.get(i + 1) == Some(&'^') {
                    out.push('^');
                    i += 1;
                }
                // A `]` right after `[` or `[^` is literal in regex-lite but
                // closes an empty class in JS; handled above for `[]`.
            }
            '[' if in_class => out.push_str("\\["),
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            ']' => out.push_str("\\]"),
            '}' if !in_class => out.push_str("\\}"),
            '{' if !in_class => {
                let rest: String = chars[i + 1..].iter().collect();
                let valid = rest.find('}').is_some_and(|end| {
                    let body = &rest[..end];
                    let mut parts = body.splitn(2, ',');
                    let a = parts.next().unwrap_or("");
                    let b = parts.next();
                    !a.is_empty()
                        && a.chars().all(|c| c.is_ascii_digit())
                        && b.is_none_or(|b| b.chars().all(|c| c.is_ascii_digit()))
                });
                if valid && i > 0 {
                    let end = rest.find('}').unwrap();
                    out.push('{');
                    out.push_str(&rest[..end]);
                    out.push('}');
                    i += end + 2;
                    continue;
                }
                out.push_str("\\{");
            }
            '(' if !in_class && chars.get(i + 1) == Some(&'?') => match chars.get(i + 2) {
                Some('=') | Some('!') => {
                    return Err(format!(
                        "Failed to parse regular expression. Lookahead is not supported: /{src}/"
                    ))
                }
                Some('<') if matches!(chars.get(i + 3), Some('=') | Some('!')) => {
                    return Err(format!(
                        "Failed to parse regular expression. Lookbehind is not supported: /{src}/"
                    ))
                }
                _ => out.push('('),
            },
            '&' | '~' | '-' if in_class && chars.get(i + 1) == Some(&c) => {
                // regex-lite reserves `&&`, `~~`, `--` in classes; JS does not.
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
        i += 1;
    }
    Ok(out)
}

fn needs_content(n: &Node) -> bool {
    match n {
        Node::Text(_) | Node::Exact(_) | Node::Regex(_) => true,
        Node::And(v) | Node::Or(v) => v.iter().any(needs_content),
        Node::Not(x) | Node::Case(_, x) => needs_content(x),
        Node::Path(_) | Node::File(_) => false,
        Node::Content(_)
        | Node::Line(_)
        | Node::Block(_)
        | Node::Section(_)
        | Node::Task(..)
        | Node::Tag(_)
        | Node::Property { .. } => true,
        Node::Literal(_) | Node::Compare { .. } | Node::Everything => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(q: &str) -> String {
        match parse_query(q) {
            Ok(Query { root: Some(n), .. }) => super::super::explain::compact(&n),
            Ok(_) => "∅".into(),
            Err(e) => format!("ERR {e}"),
        }
    }

    #[test]
    fn implicit_and_or_precedence() {
        assert_eq!(
            shape("meeting work OR meetup personal"),
            "OR(AND(t:meeting,t:work),AND(t:meetup,t:personal))"
        );
        assert_eq!(
            shape("meeting (work OR meetup) personal"),
            "AND(t:meeting,OR(t:work,t:meetup),t:personal)"
        );
        assert_eq!(
            shape("meeting -(work meetup)"),
            "AND(t:meeting,NOT(AND(t:work,t:meetup)))"
        );
    }

    #[test]
    fn operators_bind_one_primary() {
        assert_eq!(shape("path:a b"), "AND(path(t:a),t:b)");
        assert_eq!(shape("path:"), "path(t:)");
        assert_eq!(shape("task:(call OR email)"), "task(OR(t:call,t:email))");
        assert_eq!(shape("PATH:x"), "path(t:x)");
    }

    #[test]
    fn property_forms() {
        assert_eq!(shape("[aliases]"), "prop(t:aliases)");
        assert_eq!(
            shape("[status:Draft OR Published]"),
            "prop(t:status=OR(t:Draft,t:Published))"
        );
        assert_eq!(shape("[duration:<5]"), "prop(t:duration=<5)");
        assert_eq!(shape("[\"my key\":\"x y\"]"), "prop(q:my key=q:x y)");
        assert_eq!(shape("[a:path:b]"), "prop(t:a=t:path)");
    }

    #[test]
    fn tag_and_task_special_cases() {
        assert_eq!(shape("tag:work"), "tag(#work)");
        assert_eq!(shape("tag:#work"), "tag(#work)");
        assert_eq!(
            shape("tag:\"work\""),
            "ERR Operator \"tag\" can only be followed by text"
        );
        assert_eq!(shape("task:\"\""), "task(*)");
        assert_eq!(shape("task-done:x"), "task-done(t:x)");
    }

    #[test]
    fn nesting_rules() {
        assert_eq!(
            shape("line:(block:x)"),
            "ERR Operator \"block\" cannot be nested within \"line\""
        );
        assert_eq!(shape("section:(section:x)"), "section(section(t:x))");
        assert_eq!(shape("line:(match-case:X)"), "line(case(t:X))");
        assert_eq!(
            shape("[a:[b]]"),
            "ERR Property cannot be nested within a property."
        );
        assert_eq!(shape("foo:bar"), "ERR Operator \"foo\" not recognized");
    }

    #[test]
    fn stray_tokens_end_the_query() {
        assert_eq!(shape("a ) b"), "t:a");
        assert_eq!(shape(""), "∅");
        assert_eq!(shape("   "), "∅");
        assert_eq!(shape("-"), "∅");
    }

    #[test]
    fn regex_errors_and_translation() {
        assert!(shape("/(unclosed/").starts_with("ERR Failed to parse regular expression."));
        assert!(shape("/a(?=b)/").starts_with("ERR Failed to parse regular expression."));
        assert_eq!(
            translate_js_regex("[^]a{b}\\u00e9x{2}").unwrap(),
            "[\\s\\S]a\\{b\\}\\x{00e9}x{2}"
        );
        assert!(parse_query(r"/\d{4}-\d{2}-\d{2}/").is_ok());
    }

    #[test]
    fn comparison_needs_text() {
        assert_eq!(shape("[a:>(x)]"), "prop(t:a=>x)");
        assert!(shape("[a:</x/]")
            .starts_with("ERR lessthan operator cannot be applied to matcher Matches regex: /x/"));
    }
}
