//! Lexer and Pratt parser for the Bases expression language.
//!
//! Grammar (JavaScript precedence, lowest first):
//!
//! ```text
//! expr    := or
//! or      := and ( "||" and )*
//! and     := eq ( "&&" eq )*
//! eq      := rel ( ("==" | "!=") rel )*
//! rel     := add ( ("<" | "<=" | ">" | ">=") add )*
//! add     := mul ( ("+" | "-") mul )*
//! mul     := unary ( ("*" | "/" | "%") unary )*
//! unary   := ("!" | "-" | "+") unary | postfix
//! postfix := primary ( "." name | "[" expr "]" | "(" args ")" )*
//! primary := number | string | regexp | true | false | null | ident
//!          | "(" expr ")" | "[" list "]" | "{" object "}"
//! ```
//!
//! Spans are byte offsets into the source; [`crate::BaseError`] converts them
//! to UTF-16 at the API edge.

use crate::error::BaseError;

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Num(f64),
    Str(String),
    Regex(String, String),
    Ident(String),
    Punct(&'static str),
    Eof,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    pub tok: Tok,
    pub start: usize,
    pub end: usize,
}

const PUNCTS: [&str; 24] = [
    "&&", "||", "==", "!=", "<=", ">=", "(", ")", "[", "]", "{", "}", ",", ".", ":", "!", "<", ">",
    "+", "-", "*", "/", "%", "?",
];

fn is_ident_start(c: char) -> bool {
    c == '_'
        || c == '$'
        || c.is_alphabetic()
        || (!c.is_ascii() && !c.is_whitespace() && !is_cjk_punct(c))
}

fn is_ident_continue(c: char) -> bool {
    is_ident_start(c) || c.is_ascii_digit() || c.is_numeric()
}

fn is_cjk_punct(c: char) -> bool {
    matches!(
        c,
        '，' | '。' | '（' | '）' | '【' | '】' | '“' | '”' | '‘' | '’'
    )
}

pub fn lex(src: &str) -> Result<Vec<Token>, BaseError> {
    let mut out: Vec<Token> = Vec::new();
    let bytes = src.as_bytes();
    let mut i = 0;
    while i < src.len() {
        let c = src[i..].chars().next().unwrap();
        if c.is_whitespace() {
            i += c.len_utf8();
            continue;
        }
        let start = i;
        // Numbers. `1.isTruthy()` is a number followed by a member access, so a
        // dot only belongs to the number when a digit follows it.
        if c.is_ascii_digit()
            || (c == '.'
                && bytes.get(i + 1).is_some_and(u8::is_ascii_digit)
                && !prev_is_operand(&out))
        {
            let mut j = i;
            while j < src.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j < src.len() && bytes[j] == b'.' && bytes.get(j + 1).is_some_and(u8::is_ascii_digit)
            {
                j += 1;
                while j < src.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
            }
            if j < src.len() && (bytes[j] == b'e' || bytes[j] == b'E') {
                let mut k = j + 1;
                if k < src.len() && (bytes[k] == b'+' || bytes[k] == b'-') {
                    k += 1;
                }
                if k < src.len() && bytes[k].is_ascii_digit() {
                    while k < src.len() && bytes[k].is_ascii_digit() {
                        k += 1;
                    }
                    j = k;
                }
            }
            let n: f64 = src[i..j]
                .parse()
                .map_err(|_| BaseError::parse("Invalid number", src, i, j))?;
            out.push(Token {
                tok: Tok::Num(n),
                start,
                end: j,
            });
            i = j;
            continue;
        }
        if c == '"' || c == '\'' {
            let mut s = String::new();
            let mut j = i + 1;
            loop {
                let Some(ch) = src[j..].chars().next() else {
                    return Err(BaseError::parse(
                        "Unterminated string",
                        src,
                        start,
                        src.len(),
                    ));
                };
                if ch == c {
                    j += 1;
                    break;
                }
                if ch == '\\' {
                    let Some(esc) = src[j + 1..].chars().next() else {
                        return Err(BaseError::parse(
                            "Unterminated string",
                            src,
                            start,
                            src.len(),
                        ));
                    };
                    j += 1 + esc.len_utf8();
                    match esc {
                        'n' => s.push('\n'),
                        't' => s.push('\t'),
                        'r' => s.push('\r'),
                        'b' => s.push('\u{8}'),
                        'f' => s.push('\u{c}'),
                        'v' => s.push('\u{b}'),
                        '0' => s.push('\0'),
                        'u' => {
                            let hex = src
                                .get(j..j + 4)
                                .filter(|h| h.chars().all(|x| x.is_ascii_hexdigit()));
                            match hex
                                .and_then(|h| u32::from_str_radix(h, 16).ok())
                                .and_then(char::from_u32)
                            {
                                Some(ch) => {
                                    s.push(ch);
                                    j += 4;
                                }
                                None => s.push('u'),
                            }
                        }
                        other => s.push(other),
                    }
                    continue;
                }
                s.push(ch);
                j += ch.len_utf8();
            }
            out.push(Token {
                tok: Tok::Str(s),
                start,
                end: j,
            });
            i = j;
            continue;
        }
        if c == '/' && !prev_is_operand(&out) {
            // Regular expression literal.
            let mut j = i + 1;
            let mut in_class = false;
            loop {
                let Some(ch) = src[j..].chars().next() else {
                    return Err(BaseError::parse(
                        "Unterminated regular expression",
                        src,
                        start,
                        src.len(),
                    ));
                };
                if ch == '\n' {
                    return Err(BaseError::parse(
                        "Unterminated regular expression",
                        src,
                        start,
                        j,
                    ));
                }
                if ch == '\\' {
                    j += 1;
                    if let Some(n) = src[j..].chars().next() {
                        j += n.len_utf8();
                    }
                    continue;
                }
                if ch == '[' {
                    in_class = true;
                } else if ch == ']' {
                    in_class = false;
                } else if ch == '/' && !in_class {
                    break;
                }
                j += ch.len_utf8();
            }
            let pattern = src[i + 1..j].to_string();
            j += 1;
            let fstart = j;
            while j < src.len() && bytes[j].is_ascii_alphabetic() {
                j += 1;
            }
            let flags = src[fstart..j].to_string();
            if let Some(bad) = flags.chars().find(|f| !"gimsuyd".contains(*f)) {
                return Err(BaseError::parse(
                    format!("Invalid regular expression flag '{bad}'"),
                    src,
                    fstart,
                    j,
                ));
            }
            out.push(Token {
                tok: Tok::Regex(pattern, flags),
                start,
                end: j,
            });
            i = j;
            continue;
        }
        if is_ident_start(c) {
            let mut j = i;
            while let Some(ch) = src[j..].chars().next() {
                if is_ident_continue(ch) {
                    j += ch.len_utf8();
                } else {
                    break;
                }
            }
            out.push(Token {
                tok: Tok::Ident(src[i..j].to_string()),
                start,
                end: j,
            });
            i = j;
            continue;
        }
        if let Some(p) = PUNCTS.iter().find(|p| src[i..].starts_with(**p)) {
            // `=` alone is not an operator; `===` is accepted as `==`.
            out.push(Token {
                tok: Tok::Punct(p),
                start,
                end: i + p.len(),
            });
            i += p.len();
            if (*p == "==" || *p == "!=") && bytes.get(i) == Some(&b'=') {
                i += 1;
                out.last_mut().unwrap().end = i;
            }
            continue;
        }
        let end = i + c.len_utf8();
        if c == '=' {
            return Err(BaseError::parse(
                "Unexpected '=' (use '==' to compare)",
                src,
                start,
                end,
            ));
        }
        return Err(BaseError::parse(
            format!("Unexpected character '{c}'"),
            src,
            start,
            end,
        ));
    }
    out.push(Token {
        tok: Tok::Eof,
        start: src.len(),
        end: src.len(),
    });
    Ok(out)
}

fn prev_is_operand(out: &[Token]) -> bool {
    match out.last() {
        None => false,
        Some(t) => match &t.tok {
            Tok::Num(_) | Tok::Str(_) | Tok::Regex(..) | Tok::Ident(_) => true,
            Tok::Punct(p) => matches!(*p, ")" | "]" | "}"),
            Tok::Eof => false,
        },
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnOp {
    Not,
    Neg,
    Plus,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExprKind {
    Null,
    Bool(bool),
    Number(f64),
    Str(String),
    Regex { pattern: String, flags: String },
    List(Vec<Expr>),
    Object(Vec<(String, Expr)>),
    Ident(String),
    Member(Box<Expr>, String),
    Index(Box<Expr>, Box<Expr>),
    Call(Box<Expr>, Vec<Expr>),
    Unary(UnOp, Box<Expr>),
    Binary(BinOp, Box<Expr>, Box<Expr>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Expr {
    pub kind: ExprKind,
    pub start: usize,
    pub end: usize,
}

const MAX_DEPTH: usize = 100;

struct Parser<'a> {
    src: &'a str,
    toks: Vec<Token>,
    pos: usize,
    depth: usize,
}

/// Parse one expression.
pub fn parse_expression(src: &str) -> Result<Expr, BaseError> {
    let toks = lex(src)?;
    let mut p = Parser {
        src,
        toks,
        pos: 0,
        depth: 0,
    };
    if matches!(p.peek().tok, Tok::Eof) {
        return Err(BaseError::parse("Empty expression", src, 0, src.len()));
    }
    let e = p.expr()?;
    let t = p.peek().clone();
    if t.tok != Tok::Eof {
        return Err(BaseError::parse(
            format!("Unexpected {}", describe(&t.tok)),
            src,
            t.start,
            t.end,
        ));
    }
    Ok(e)
}

fn describe(t: &Tok) -> String {
    match t {
        Tok::Num(n) => format!("number {}", crate::value::js_number_to_string(*n)),
        Tok::Str(_) => "string".into(),
        Tok::Regex(..) => "regular expression".into(),
        Tok::Ident(s) => format!("identifier '{s}'"),
        Tok::Punct(p) => format!("'{p}'"),
        Tok::Eof => "end of expression".into(),
    }
}

impl Parser<'_> {
    fn peek(&self) -> &Token {
        &self.toks[self.pos]
    }
    fn next(&mut self) -> Token {
        let t = self.toks[self.pos].clone();
        if self.pos + 1 < self.toks.len() {
            self.pos += 1;
        }
        t
    }
    fn is_punct(&self, p: &str) -> bool {
        matches!(&self.peek().tok, Tok::Punct(q) if *q == p)
    }
    fn expect(&mut self, p: &str) -> Result<Token, BaseError> {
        if self.is_punct(p) {
            Ok(self.next())
        } else {
            let t = self.peek().clone();
            Err(BaseError::parse(
                format!("Expected '{p}' but found {}", describe(&t.tok)),
                self.src,
                t.start,
                t.end,
            ))
        }
    }

    fn expr(&mut self) -> Result<Expr, BaseError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            let t = self.peek().clone();
            return Err(BaseError::parse(
                "Expression is nested too deeply",
                self.src,
                t.start,
                t.end,
            ));
        }
        let r = self.binary(0);
        self.depth -= 1;
        r
    }

    fn binop(&self) -> Option<(BinOp, u8)> {
        let Tok::Punct(p) = &self.peek().tok else {
            return None;
        };
        Some(match *p {
            "||" => (BinOp::Or, 1),
            "&&" => (BinOp::And, 2),
            "==" => (BinOp::Eq, 3),
            "!=" => (BinOp::Ne, 3),
            "<" => (BinOp::Lt, 4),
            "<=" => (BinOp::Le, 4),
            ">" => (BinOp::Gt, 4),
            ">=" => (BinOp::Ge, 4),
            "+" => (BinOp::Add, 5),
            "-" => (BinOp::Sub, 5),
            "*" => (BinOp::Mul, 6),
            "/" => (BinOp::Div, 6),
            "%" => (BinOp::Mod, 6),
            _ => return None,
        })
    }

    fn binary(&mut self, min_prec: u8) -> Result<Expr, BaseError> {
        let mut left = self.unary()?;
        while let Some((op, prec)) = self.binop() {
            if prec <= min_prec {
                break;
            }
            self.next();
            let right = self.binary(prec)?;
            let (start, end) = (left.start, right.end);
            left = Expr {
                kind: ExprKind::Binary(op, Box::new(left), Box::new(right)),
                start,
                end,
            };
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr, BaseError> {
        let op = match &self.peek().tok {
            Tok::Punct("!") => Some(UnOp::Not),
            Tok::Punct("-") => Some(UnOp::Neg),
            Tok::Punct("+") => Some(UnOp::Plus),
            _ => None,
        };
        if let Some(op) = op {
            let t = self.next();
            self.depth += 1;
            if self.depth > MAX_DEPTH {
                return Err(BaseError::parse(
                    "Expression is nested too deeply",
                    self.src,
                    t.start,
                    t.end,
                ));
            }
            let operand = self.unary()?;
            self.depth -= 1;
            let end = operand.end;
            return Ok(Expr {
                kind: ExprKind::Unary(op, Box::new(operand)),
                start: t.start,
                end,
            });
        }
        self.postfix()
    }

    fn postfix(&mut self) -> Result<Expr, BaseError> {
        let mut e = self.primary()?;
        loop {
            if self.is_punct(".") {
                self.next();
                let t = self.next();
                let name = match t.tok {
                    Tok::Ident(s) => s,
                    other => {
                        return Err(BaseError::parse(
                            format!(
                                "Expected a property name after '.' but found {}",
                                describe(&other)
                            ),
                            self.src,
                            t.start,
                            t.end,
                        ))
                    }
                };
                let start = e.start;
                e = Expr {
                    kind: ExprKind::Member(Box::new(e), name),
                    start,
                    end: t.end,
                };
            } else if self.is_punct("[") {
                self.next();
                let idx = self.expr()?;
                let close = self.expect("]")?;
                let start = e.start;
                e = Expr {
                    kind: ExprKind::Index(Box::new(e), Box::new(idx)),
                    start,
                    end: close.end,
                };
            } else if self.is_punct("(") {
                let open = self.next();
                if !matches!(e.kind, ExprKind::Ident(_) | ExprKind::Member(..)) {
                    return Err(BaseError::parse(
                        "Only functions and methods can be called",
                        self.src,
                        open.start,
                        open.end,
                    ));
                }
                let args = self.list_items(")")?;
                let close = self.expect(")")?;
                let start = e.start;
                e = Expr {
                    kind: ExprKind::Call(Box::new(e), args),
                    start,
                    end: close.end,
                };
            } else {
                break;
            }
        }
        Ok(e)
    }

    fn list_items(&mut self, close: &str) -> Result<Vec<Expr>, BaseError> {
        let mut items = Vec::new();
        while !self.is_punct(close) {
            items.push(self.expr()?);
            if self.is_punct(",") {
                self.next();
            } else if !self.is_punct(close) {
                let t = self.peek().clone();
                return Err(BaseError::parse(
                    format!("Expected ',' or '{close}' but found {}", describe(&t.tok)),
                    self.src,
                    t.start,
                    t.end,
                ));
            }
        }
        Ok(items)
    }

    fn primary(&mut self) -> Result<Expr, BaseError> {
        let t = self.next();
        let kind = match t.tok {
            Tok::Num(n) => ExprKind::Number(n),
            Tok::Str(s) => ExprKind::Str(s),
            Tok::Regex(pattern, flags) => ExprKind::Regex { pattern, flags },
            Tok::Ident(name) => match name.as_str() {
                "true" => ExprKind::Bool(true),
                "false" => ExprKind::Bool(false),
                "null" => ExprKind::Null,
                _ => ExprKind::Ident(name),
            },
            Tok::Punct("(") => {
                let inner = self.expr()?;
                let close = self.expect(")")?;
                return Ok(Expr {
                    kind: inner.kind,
                    start: t.start,
                    end: close.end,
                });
            }
            Tok::Punct("[") => {
                let items = self.list_items("]")?;
                let close = self.expect("]")?;
                return Ok(Expr {
                    kind: ExprKind::List(items),
                    start: t.start,
                    end: close.end,
                });
            }
            Tok::Punct("{") => {
                let mut entries = Vec::new();
                while !self.is_punct("}") {
                    let k = self.next();
                    let key = match k.tok {
                        Tok::Str(s) | Tok::Ident(s) => s,
                        Tok::Num(n) => crate::value::js_number_to_string(n),
                        other => {
                            return Err(BaseError::parse(
                                format!("Expected an object key but found {}", describe(&other)),
                                self.src,
                                k.start,
                                k.end,
                            ))
                        }
                    };
                    self.expect(":")?;
                    let v = self.expr()?;
                    entries.push((key, v));
                    if self.is_punct(",") {
                        self.next();
                    } else if !self.is_punct("}") {
                        let t = self.peek().clone();
                        return Err(BaseError::parse(
                            format!("Expected ',' or '}}' but found {}", describe(&t.tok)),
                            self.src,
                            t.start,
                            t.end,
                        ));
                    }
                }
                let close = self.expect("}")?;
                return Ok(Expr {
                    kind: ExprKind::Object(entries),
                    start: t.start,
                    end: close.end,
                });
            }
            other => {
                return Err(BaseError::parse(
                    format!("Unexpected {}", describe(&other)),
                    self.src,
                    t.start,
                    t.end,
                ));
            }
        };
        Ok(Expr {
            kind,
            start: t.start,
            end: t.end,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Expr {
        parse_expression(s).unwrap_or_else(|e| panic!("{s}: {e}"))
    }

    fn shape(e: &Expr) -> String {
        match &e.kind {
            ExprKind::Null => "null".into(),
            ExprKind::Bool(b) => b.to_string(),
            ExprKind::Number(n) => crate::value::js_number_to_string(*n),
            ExprKind::Str(s) => format!("{s:?}"),
            ExprKind::Regex { pattern, flags } => format!("/{pattern}/{flags}"),
            ExprKind::List(v) => format!("[{}]", v.iter().map(shape).collect::<Vec<_>>().join(",")),
            ExprKind::Object(v) => format!(
                "{{{}}}",
                v.iter()
                    .map(|(k, x)| format!("{k}:{}", shape(x)))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            ExprKind::Ident(s) => s.clone(),
            ExprKind::Member(o, n) => format!("{}.{n}", shape(o)),
            ExprKind::Index(o, i) => format!("{}[{}]", shape(o), shape(i)),
            ExprKind::Call(c, a) => format!(
                "{}({})",
                shape(c),
                a.iter().map(shape).collect::<Vec<_>>().join(",")
            ),
            ExprKind::Unary(op, x) => format!("({op:?} {})", shape(x)),
            ExprKind::Binary(op, a, b) => format!("({op:?} {} {})", shape(a), shape(b)),
        }
    }

    #[test]
    fn precedence() {
        assert_eq!(shape(&p("1 + 2 * 3")), "(Add 1 (Mul 2 3))");
        assert_eq!(shape(&p("(1 + 2) * 3")), "(Mul (Add 1 2) 3)");
        assert_eq!(shape(&p("a || b && c")), "(Or a (And b c))");
        assert_eq!(shape(&p("a == b > c")), "(Eq a (Gt b c))");
        assert_eq!(shape(&p("!a && -b")), "(And (Not a) (Neg b))");
        assert_eq!(shape(&p("10 - 2 - 3")), "(Sub (Sub 10 2) 3)");
    }

    #[test]
    fn postfix_chains() {
        assert_eq!(
            shape(&p("file.name.lower().contains(\"x\")")),
            "file.name.lower().contains(\"x\")"
        );
        assert_eq!(shape(&p("note[\"my prop\"][0]")), "note[\"my prop\"][0]");
        assert_eq!(shape(&p("1.isTruthy()")), "1.isTruthy()");
        assert_eq!(shape(&p("(2.5).round()")), "2.5.round()");
        assert_eq!(shape(&p("[[1],[2]].flat()")), "[[1],[2]].flat()");
        assert_eq!(shape(&p("{\"a\": 1, b: [2]}.keys()")), "{a:1,b:[2]}.keys()");
    }

    #[test]
    fn regex_vs_division() {
        assert_eq!(shape(&p("a / b")), "(Div a b)");
        assert_eq!(
            shape(&p("/a\\/b[/]/gi.matches(x)")),
            "/a\\/b[/]/gi.matches(x)"
        );
        assert_eq!(shape(&p("x.replace(/:/g, \"-\")")), "x.replace(/:/g,\"-\")");
        assert_eq!(shape(&p("(a) / 2")), "(Div a 2)");
    }

    #[test]
    fn strings_and_numbers() {
        assert_eq!(
            shape(&p("'it\\'s' + \"a\\nb\"")),
            "(Add \"it's\" \"a\\nb\")"
        );
        assert_eq!(shape(&p("1e3 + .5 + 0.25")), "(Add (Add 1000 0.5) 0.25)");
        assert_eq!(shape(&p("\"\\u00e9\"")), "\"é\"");
        assert_eq!(shape(&p("a === b")), "(Eq a b)");
    }

    #[test]
    fn unicode_identifiers() {
        assert_eq!(shape(&p("未命名 + 1")), "(Add 未命名 1)");
        assert_eq!(shape(&p("café.length")), "café.length");
    }

    #[test]
    fn errors_have_positions() {
        let e = parse_expression("price * ").unwrap_err();
        assert_eq!((e.offset, e.end), (Some(8), Some(8)));
        assert!(e.message.contains("end of expression"), "{}", e.message);
        let e = parse_expression("a = b").unwrap_err();
        assert_eq!(e.offset, Some(2));
        let e = parse_expression("\"abc").unwrap_err();
        assert_eq!(e.message, "Unterminated string");
        let e = parse_expression("f(1, 2").unwrap_err();
        assert!(e.message.contains("Expected ',' or ')'"), "{}", e.message);
        let e = parse_expression("a b").unwrap_err();
        assert_eq!(e.offset, Some(2));
        assert!(parse_expression("").is_err());
        assert!(parse_expression("x.").is_err());
        assert!(parse_expression("(1)(2)").is_err());
    }

    #[test]
    fn error_offsets_are_utf16() {
        // "😀" is 4 bytes and 2 UTF-16 units; the '#' sits at byte 11, UTF-16 offset 9.
        let e = parse_expression("\"😀\" + 1 # 2").unwrap_err();
        assert_eq!(e.offset, Some(9));
        let e = parse_expression("\"é😀\" ?").unwrap_err();
        assert_eq!(e.offset, Some(6));
    }

    #[test]
    fn deep_nesting_is_an_error_not_a_crash() {
        let src = "(".repeat(5000) + "1" + &")".repeat(5000);
        assert!(parse_expression(&src).is_err());
        let src = "!".repeat(5000) + "1";
        assert!(parse_expression(&src).is_err());
    }
}
