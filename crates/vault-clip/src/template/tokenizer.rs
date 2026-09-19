//! Knap tokenizer — a line-for-line port of `knap/src/tokenizer.ts`.
//!
//! Positions are 1-based line/column in characters, as Knap reports them.

use super::params::parse_regex_pattern;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tok {
    Text,
    VariableStart,
    VariableEnd,
    TagStart,
    TagEnd,
    KwIf,
    KwElseif,
    KwElse,
    KwEndif,
    KwFor,
    KwIn,
    KwEndfor,
    KwSet,
    OpEq,
    OpNeq,
    OpGte,
    OpLte,
    OpGt,
    OpLt,
    OpAnd,
    OpOr,
    OpNot,
    OpContains,
    OpNullish,
    OpAssign,
    Identifier,
    String,
    Number,
    Boolean,
    Null,
    Pipe,
    LParen,
    RParen,
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    Colon,
    Comma,
    Dot,
    Star,
    Slash,
    Plus,
    Arrow,
    Dollar,
    Eof,
}

#[derive(Debug, Clone)]
pub struct Token {
    pub kind: Tok,
    pub value: String,
    pub line: usize,
    pub column: usize,
    pub trim_left: bool,
    pub trim_right: bool,
}

#[derive(Debug, Clone)]
pub struct TokError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

#[derive(PartialEq, Clone, Copy)]
enum Mode {
    Text,
    Variable,
    Tag,
}

struct State {
    input: Vec<char>,
    pos: usize,
    line: usize,
    column: usize,
    mode: Mode,
    tokens: Vec<Token>,
    errors: Vec<TokError>,
}

fn keyword(s: &str) -> Option<Tok> {
    Some(match s.to_lowercase().as_str() {
        "if" => Tok::KwIf,
        "elseif" => Tok::KwElseif,
        "else" => Tok::KwElse,
        "endif" => Tok::KwEndif,
        "for" => Tok::KwFor,
        "in" => Tok::KwIn,
        "endfor" => Tok::KwEndfor,
        "set" => Tok::KwSet,
        "and" => Tok::OpAnd,
        "or" => Tok::OpOr,
        "not" => Tok::OpNot,
        "contains" => Tok::OpContains,
        "true" | "false" => Tok::Boolean,
        "null" => Tok::Null,
        _ => return None,
    })
}

pub fn tokenize(input: &str) -> (Vec<Token>, Vec<TokError>) {
    let mut st = State {
        input: input.chars().collect(),
        pos: 0,
        line: 1,
        column: 1,
        mode: Mode::Text,
        tokens: Vec::new(),
        errors: Vec::new(),
    };
    while st.pos < st.input.len() {
        match st.mode {
            Mode::Text => text_mode(&mut st),
            Mode::Variable => variable_mode(&mut st),
            Mode::Tag => tag_mode(&mut st),
        }
    }
    let (line, column) = (st.line, st.column);
    st.push(Tok::Eof, "", line, column);
    (st.tokens, st.errors)
}

impl State {
    fn push(&mut self, kind: Tok, value: &str, line: usize, column: usize) {
        self.tokens.push(Token {
            kind,
            value: value.to_string(),
            line,
            column,
            trim_left: false,
            trim_right: false,
        });
    }
    fn at(&self, i: usize) -> Option<char> {
        self.input.get(i).copied()
    }
    fn look(&self, s: &str) -> bool {
        s.chars()
            .enumerate()
            .all(|(k, c)| self.input.get(self.pos + k) == Some(&c))
    }
    fn advance_char(&mut self) {
        if self.pos < self.input.len() {
            if self.input[self.pos] == '\n' {
                self.line += 1;
                self.column = 1;
            } else {
                self.column += 1;
            }
            self.pos += 1;
        }
    }
    fn advance(&mut self, n: usize) {
        for _ in 0..n {
            self.advance_char();
        }
    }
    fn skip_ws(&mut self) {
        while self.at(self.pos).is_some_and(|c| matches!(c, ' ' | '\t' | '\n' | '\r')) {
            self.advance_char();
        }
    }
    fn err(&mut self, message: impl Into<String>, line: usize, column: usize) {
        self.errors.push(TokError {
            message: message.into(),
            line,
            column,
        });
    }
    fn slice(&self, a: usize, b: usize) -> String {
        self.input[a..b].iter().collect()
    }
}

fn text_mode(st: &mut State) {
    let start = st.pos;
    let (sl, sc) = (st.line, st.column);
    while st.pos < st.input.len() {
        if st.input[st.pos] != '{' {
            st.advance_char();
            continue;
        }
        let next = st.at(st.pos + 1);
        let is_var = next == Some('{');
        let is_tag = next == Some('%');
        let is_comment = next == Some('#');
        if !is_var && !is_tag && !is_comment {
            st.advance_char();
            continue;
        }
        if st.pos > start {
            let v = st.slice(start, st.pos);
            st.push(Tok::Text, &v, sl, sc);
        }
        if is_comment {
            // Find "#}" after the opener.
            let mut end = None;
            let mut k = st.pos + 2;
            while k + 1 < st.input.len() {
                if st.input[k] == '#' && st.input[k + 1] == '}' {
                    end = Some(k);
                    break;
                }
                k += 1;
            }
            if end.is_none() {
                let (l, c) = (st.line, st.column);
                st.err("Unclosed comment - missing '#}'", l, c);
            }
            let target = end.map(|e| e + 2).unwrap_or(st.input.len());
            while st.pos < target {
                st.advance_char();
            }
            return;
        }
        st.advance(2);
        let (l, c) = (st.line, st.column - 2);
        st.push(
            if is_var { Tok::VariableStart } else { Tok::TagStart },
            if is_var { "{{" } else { "{%" },
            l,
            c,
        );
        st.mode = if is_var { Mode::Variable } else { Mode::Tag };
        return;
    }
    if st.pos > start {
        let v = st.slice(start, st.pos);
        st.push(Tok::Text, &v, sl, sc);
    }
}

fn variable_mode(st: &mut State) {
    st.skip_ws();
    if st.look("}}") {
        let (l, c) = (st.line, st.column);
        st.push(Tok::VariableEnd, "}}", l, c);
        st.advance(2);
        st.mode = Mode::Text;
        return;
    }
    if st.at(st.pos) == Some('}') && st.at(st.pos + 1) != Some('}') {
        let next = st.at(st.pos + 1);
        let valid = matches!(next, Some('|' | ',' | ')' | ']' | ' ' | '\t' | '\n' | '\r'));
        if !valid {
            let (l, c) = (st.line, st.column);
            st.err(
                "Malformed variable: expected '}}' but found '}'. Did you forget a '}'?",
                l,
                c,
            );
            st.push(Tok::VariableEnd, "}", l, c);
            st.advance_char();
            st.mode = Mode::Text;
            return;
        }
    }
    if st.look("{%") || st.look("{{") {
        let idx = st.tokens.iter().rposition(|t| t.kind == Tok::VariableStart);
        let (l, c) = idx
            .map(|i| (st.tokens[i].line, st.tokens[i].column))
            .unwrap_or((st.line, st.column));
        st.err("Missing closing '}}' for variable", l, c);
        if let Some(i) = idx {
            st.tokens.truncate(i);
        }
        st.mode = Mode::Text;
        return;
    }
    expression(st, Mode::Variable);
}

fn tag_mode(st: &mut State) {
    st.skip_ws();
    if st.look("%}") {
        let (l, c) = (st.line, st.column);
        st.push(Tok::TagEnd, "%}", l, c);
        st.tokens.last_mut().unwrap().trim_right = true;
        st.advance(2);
        st.mode = Mode::Text;
        return;
    }
    if st.look("-%}") {
        let (l, c) = (st.line, st.column);
        st.push(Tok::TagEnd, "-%}", l, c);
        st.tokens.last_mut().unwrap().trim_right = true;
        st.advance(3);
        st.mode = Mode::Text;
        return;
    }
    if st.at(st.pos) == Some('}') && st.pos > 0 && st.at(st.pos - 1) != Some('%') {
        let (l, c) = (st.line, st.column);
        st.err("Malformed tag: expected '%}' but found '}'. Did you forget the '%'?", l, c);
        st.push(Tok::TagEnd, "}", l, c);
        st.tokens.last_mut().unwrap().trim_right = true;
        st.advance_char();
        st.mode = Mode::Text;
        return;
    }
    if st.look("{%") || st.look("{{") {
        let idx = st.tokens.iter().rposition(|t| t.kind == Tok::TagStart);
        let (l, c) = idx
            .map(|i| (st.tokens[i].line, st.tokens[i].column))
            .unwrap_or((st.line, st.column));
        st.err("Missing closing '%}' for tag", l, c);
        if let Some(i) = idx {
            st.tokens.truncate(i);
        }
        st.mode = Mode::Text;
        return;
    }
    expression(st, Mode::Tag);
}

fn expression(st: &mut State, mode: Mode) {
    st.skip_ws();
    if st.pos >= st.input.len() {
        let (l, c) = (st.line, st.column);
        st.err(
            if mode == Mode::Variable {
                "Unclosed variable - missing '}}'"
            } else {
                "Unclosed tag - missing '%}'"
            },
            l,
            c,
        );
        return;
    }
    let ch = st.input[st.pos];
    let (l, c) = (st.line, st.column);
    if ch == '"' || ch == '\'' {
        string_lit(st);
        return;
    }
    if ch.is_ascii_digit() || (ch == '-' && st.at(st.pos + 1).is_some_and(|d| d.is_ascii_digit())) {
        number_lit(st);
        return;
    }
    for (s, kind) in [
        ("==", Tok::OpEq),
        ("!=", Tok::OpNeq),
        (">=", Tok::OpGte),
        ("<=", Tok::OpLte),
        ("&&", Tok::OpAnd),
        ("||", Tok::OpOr),
        ("??", Tok::OpNullish),
        ("=>", Tok::Arrow),
    ] {
        if st.look(s) {
            st.push(kind, s, l, c);
            st.advance(2);
            return;
        }
    }
    let single = match ch {
        '>' => Some(Tok::OpGt),
        '<' => Some(Tok::OpLt),
        '!' => Some(Tok::OpNot),
        '=' => Some(Tok::OpAssign),
        '|' => Some(Tok::Pipe),
        '(' => Some(Tok::LParen),
        ')' => Some(Tok::RParen),
        '[' => Some(Tok::LBracket),
        ']' => Some(Tok::RBracket),
        ':' => Some(Tok::Colon),
        ',' => Some(Tok::Comma),
        '.' => Some(Tok::Dot),
        '*' => Some(Tok::Star),
        '/' => Some(Tok::Slash),
        '+' => Some(Tok::Plus),
        '{' => Some(Tok::LBrace),
        '}' => Some(Tok::RBrace),
        '$' => Some(Tok::Dollar),
        _ => None,
    };
    if let Some(kind) = single {
        st.push(kind, &ch.to_string(), l, c);
        st.advance_char();
        return;
    }
    if is_ident_start(ch) {
        identifier(st);
        return;
    }
    if ch == '\\' {
        escaped_argument(st);
        return;
    }
    st.err(format!("Unexpected character '{ch}' in template"), l, c);
    st.advance_char();
}

fn string_lit(st: &mut State) {
    let quote = st.input[st.pos];
    let (l, c) = (st.line, st.column);
    let mut value = String::new();
    let mut raw = String::new();
    st.advance_char();
    while st.pos < st.input.len() {
        let ch = st.input[st.pos];
        let next = st.at(st.pos + 1);
        if ch == quote {
            st.advance_char();
            if parse_regex_pattern(&raw).is_some() {
                value = decode_regex_quotes(&raw);
            }
            st.push(Tok::String, &value, l, c);
            return;
        }
        if (ch == '}' && next == Some('}')) || (ch == '%' && next == Some('}')) {
            st.err(
                format!("Unclosed string - missing {quote} before {ch}{}", next.unwrap_or(' ')),
                l,
                c,
            );
            st.push(Tok::String, &value, l, c);
            return;
        }
        if ch == '\\' && st.pos + 1 < st.input.len() {
            st.advance_char();
            let esc = st.input[st.pos];
            raw.push('\\');
            raw.push(esc);
            value.push_str(&decode_string_escape(esc));
            st.advance_char();
            continue;
        }
        value.push(ch);
        raw.push(ch);
        st.advance_char();
    }
    st.err(format!("Unclosed string - missing closing {quote}"), l, c);
    st.push(Tok::String, &value, l, c);
}

/// `rawValue.replace(/\\([\\"'])/g, '$1')`
fn decode_regex_quotes(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&n) = chars.peek() {
                if matches!(n, '\\' | '"' | '\'') {
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

pub fn decode_string_escape(c: char) -> String {
    match c {
        'n' => "\n".into(),
        't' => "\t".into(),
        'r' => "\r".into(),
        other => other.to_string(),
    }
}

fn escaped_argument(st: &mut State) {
    let (l, c) = (st.line, st.column);
    let mut value = String::new();
    while st.pos < st.input.len() {
        let ch = st.input[st.pos];
        let next = st.at(st.pos + 1);
        if matches!(ch, '|' | '%' | '}' | ')') {
            break;
        }
        if ch == '+' && matches!(next, Some('%') | Some('}')) {
            break;
        }
        if ch == '\\' && st.pos + 1 < st.input.len() {
            let esc = st.input[st.pos + 1];
            match esc {
                'n' => value.push('\n'),
                't' => value.push('\t'),
                'r' => value.push('\r'),
                other => value.push(other),
            }
            st.advance(2);
            continue;
        }
        value.push(ch);
        st.advance_char();
    }
    st.push(Tok::String, &value, l, c);
}

fn number_lit(st: &mut State) {
    let (l, c) = (st.line, st.column);
    let mut value = String::new();
    if st.at(st.pos) == Some('-') {
        value.push('-');
        st.advance_char();
    }
    while st.at(st.pos).is_some_and(|d| d.is_ascii_digit()) {
        value.push(st.input[st.pos]);
        st.advance_char();
    }
    if st.at(st.pos) == Some('.') {
        value.push('.');
        st.advance_char();
        while st.at(st.pos).is_some_and(|d| d.is_ascii_digit()) {
            value.push(st.input[st.pos]);
            st.advance_char();
        }
    }
    st.push(Tok::Number, &value, l, c);
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_' || c == '@'
}

fn is_ident_char(c: char) -> bool {
    is_ident_start(c) || c.is_ascii_digit() || c == '-' || c == '.'
}

fn identifier(st: &mut State) {
    let (l, c) = (st.line, st.column);
    let mut value = String::new();
    while st.at(st.pos).is_some_and(is_ident_char) {
        value.push(st.input[st.pos]);
        st.advance_char();
    }
    if (value == "selector" || value == "selectorHtml") && st.at(st.pos) == Some(':') {
        value.push(':');
        st.advance_char();
        value = css_selector(st, value);
    }
    match keyword(&value) {
        Some(kind) => st.push(kind, &value, l, c),
        None => st.push(Tok::Identifier, &value, l, c),
    }
}

fn css_selector(st: &mut State, mut value: String) -> String {
    let mut bracket = 0i32;
    let mut paren = 0i32;
    let mut in_string: Option<char> = None;
    while st.pos < st.input.len() {
        let ch = st.input[st.pos];
        let next = st.at(st.pos + 1);
        if in_string.is_none() && bracket == 0 && paren == 0 {
            if ch == '|' {
                break;
            }
            if ch == '%' && next == Some('}') {
                break;
            }
            if ch == '}' && next == Some('}') {
                break;
            }
            if ch == '-' && matches!(next, Some('%') | Some('}')) {
                break;
            }
            if ch == '}' && next != Some('}') {
                break;
            }
        }
        if (ch == '}' && next == Some('}')) || (ch == '%' && next == Some('}')) {
            let (l, c) = (st.line, st.column);
            if let Some(q) = in_string {
                st.err(format!("Unclosed string in selector - missing closing {q}"), l, c);
                break;
            }
            if bracket > 0 {
                st.err("Unclosed '[' in selector - missing ']'", l, c);
                break;
            }
            if paren > 0 {
                st.err("Unclosed '(' in selector - missing ')'", l, c);
                break;
            }
        }
        if in_string.is_none() && ch == '\\' && matches!(next, Some('"') | Some('\'')) {
            value.push(ch);
            st.advance_char();
            value.push(st.input[st.pos]);
            st.advance_char();
            continue;
        }
        if in_string.is_none() && (ch == '"' || ch == '\'') {
            in_string = Some(ch);
            value.push(ch);
            st.advance_char();
            continue;
        }
        if in_string == Some(ch) {
            in_string = None;
            value.push(ch);
            st.advance_char();
            continue;
        }
        if in_string.is_some() && ch == '\\' && st.pos + 1 < st.input.len() {
            value.push(ch);
            st.advance_char();
            value.push(st.input[st.pos]);
            st.advance_char();
            continue;
        }
        if in_string.is_none() {
            match ch {
                '[' => bracket += 1,
                ']' => {
                    bracket -= 1;
                    if bracket < 0 {
                        let (l, c) = (st.line, st.column);
                        st.err("Extra ']' in selector - no matching '['", l, c);
                        bracket = 0;
                    }
                }
                '(' => paren += 1,
                ')' => {
                    paren -= 1;
                    if paren < 0 {
                        let (l, c) = (st.line, st.column);
                        st.err("Extra ')' in selector - no matching '('", l, c);
                        paren = 0;
                    }
                }
                _ => {}
            }
        }
        value.push(ch);
        st.advance_char();
    }
    value.trim_end().to_string()
}
