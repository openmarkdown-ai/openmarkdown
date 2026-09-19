//! Knap parser — a port of `knap/src/parser.ts` (tokens → AST).

use super::tokenizer::{tokenize, Tok, Token};

#[derive(Debug, Clone)]
pub enum Node {
    Text(String),
    Variable {
        expr: Expr,
        trim_left: bool,
        trim_right: bool,
        line: usize,
        column: usize,
    },
    If {
        cond: Expr,
        then: Vec<Node>,
        elseifs: Vec<(Expr, Vec<Node>)>,
        otherwise: Option<Vec<Node>>,
        trim_left: bool,
        trim_right: bool,
        line: usize,
        column: usize,
    },
    For {
        iterator: String,
        iterable: Expr,
        body: Vec<Node>,
        trim_left: bool,
        trim_right: bool,
        line: usize,
        column: usize,
    },
    Set {
        name: String,
        value: Expr,
        trim_left: bool,
        trim_right: bool,
        line: usize,
        column: usize,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Lit {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
}

#[derive(Debug, Clone)]
pub enum Expr {
    Literal {
        value: Lit,
        /// The decoded string before quoting for legacy parameter serialisation.
        unquoted: Option<String>,
    },
    Ident {
        name: String,
    },
    Binary {
        op: String,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Not(Box<Expr>),
    Filter {
        value: Box<Expr>,
        name: String,
        args: Vec<Expr>,
        line: usize,
        column: usize,
    },
    Group(Box<Expr>),
    Member {
        object: Box<Expr>,
        property: Box<Expr>,
    },
}

impl Expr {
    fn str_lit(s: String) -> Expr {
        Expr::Literal {
            value: Lit::Str(s),
            unquoted: None,
        }
    }

    pub fn is_literal_arg(&self) -> bool {
        match self {
            Expr::Literal { .. } => true,
            Expr::Group(e) => e.is_literal_arg(),
            _ => false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ParseError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

struct P {
    tokens: Vec<Token>,
    pos: usize,
    errors: Vec<ParseError>,
    depth: usize,
}

const MAX_DEPTH: usize = 100;

pub fn parse(input: &str) -> (Vec<Node>, Vec<ParseError>) {
    let (tokens, terrs) = tokenize(input);
    let mut p = P {
        tokens,
        pos: 0,
        errors: terrs
            .into_iter()
            .map(|e| ParseError {
                message: e.message,
                line: e.line,
                column: e.column,
            })
            .collect(),
        depth: 0,
    };
    let mut nodes = Vec::new();
    while !p.at_end() {
        if let Some(n) = p.node() {
            nodes.push(n);
        }
    }
    (nodes, p.errors)
}

impl P {
    fn peek(&self) -> &Token {
        static EOF: std::sync::OnceLock<Token> = std::sync::OnceLock::new();
        self.tokens.get(self.pos).unwrap_or_else(|| {
            EOF.get_or_init(|| Token {
                kind: Tok::Eof,
                value: String::new(),
                line: 0,
                column: 0,
                trim_left: false,
                trim_right: false,
            })
        })
    }
    fn kind_at(&self, i: usize) -> Tok {
        self.tokens.get(i).map(|t| t.kind).unwrap_or(Tok::Eof)
    }
    fn check(&self, k: Tok) -> bool {
        self.peek().kind == k
    }
    fn at_end(&self) -> bool {
        self.check(Tok::Eof)
    }
    fn advance(&mut self) -> Token {
        let t = self.peek().clone();
        if !self.at_end() {
            self.pos += 1;
        }
        t
    }
    fn err(&mut self, message: impl Into<String>) {
        let (line, column) = (self.peek().line, self.peek().column);
        self.errors.push(ParseError {
            message: message.into(),
            line,
            column,
        });
    }
    fn err_at(&mut self, message: impl Into<String>, t: &Token) {
        self.errors.push(ParseError {
            message: message.into(),
            line: t.line,
            column: t.column,
        });
    }

    fn node(&mut self) -> Option<Node> {
        match self.peek().kind {
            Tok::Text => {
                let mut v = self.advance().value;
                while self.check(Tok::Text) {
                    v.push_str(&self.advance().value);
                }
                Some(Node::Text(v))
            }
            Tok::VariableStart => self.variable(),
            Tok::TagStart => self.tag(),
            Tok::Eof => {
                self.advance();
                None
            }
            _ => {
                let t = self.peek().clone();
                self.err_at(format!("Unexpected \"{}\" in template", t.value), &t);
                self.advance();
                None
            }
        }
    }

    fn variable(&mut self) -> Option<Node> {
        let start = self.advance();
        // Collapse a run of identifiers: {{ First name | upper }}
        if self.check(Tok::Identifier) && self.kind_at(self.pos + 1) == Tok::Identifier {
            let mut end = self.pos + 1;
            let mut parts = vec![self.tokens[self.pos].value.clone()];
            while self.kind_at(end) == Tok::Identifier {
                parts.push(self.tokens[end].value.clone());
                end += 1;
            }
            let mut first = self.tokens[self.pos].clone();
            first.value = parts.join(" ");
            self.tokens.splice(self.pos..end, [first]);
        }
        let Some(expr) = self.expression() else {
            self.err_at("Empty variable - add a variable name between {{ and }}", &start);
            while !self.at_end() && !self.check(Tok::VariableEnd) {
                self.advance();
            }
            if self.check(Tok::VariableEnd) {
                self.advance();
            }
            return None;
        };
        let mut trim_right = false;
        if self.check(Tok::VariableEnd) {
            trim_right = self.advance().trim_right;
        } else {
            self.err("Missing closing }}");
        }
        Some(Node::Variable {
            expr,
            trim_left: start.trim_left,
            trim_right,
            line: start.line,
            column: start.column,
        })
    }

    fn tag(&mut self) -> Option<Node> {
        let start = self.advance();
        let kw = self.peek().clone();
        match kw.kind {
            Tok::KwIf => self.if_stmt(start),
            Tok::KwFor => self.for_stmt(start),
            Tok::KwSet => self.set_stmt(start),
            Tok::KwElse | Tok::KwElseif | Tok::KwEndif | Tok::KwEndfor => {
                self.err_at(
                    format!("Unexpected {{% {} %}} - no matching opening tag", kw.value),
                    &kw,
                );
                self.skip_to_tag_end();
                None
            }
            _ => {
                self.err_at(format!("Unknown tag: {{% {} %}}", kw.value), &kw);
                self.skip_to_tag_end();
                None
            }
        }
    }

    fn skip_to_tag_end(&mut self) {
        while !self.at_end() && !self.check(Tok::TagEnd) {
            self.advance();
        }
        if self.check(Tok::TagEnd) {
            self.advance();
        }
    }

    fn check_tag_kw(&self, kws: &[Tok]) -> bool {
        self.check(Tok::TagStart) && kws.contains(&self.kind_at(self.pos + 1))
    }

    fn consume_tag_end(&mut self) {
        if self.check(Tok::TagEnd) {
            self.advance();
        } else {
            self.err("Missing closing %}");
        }
    }

    fn if_stmt(&mut self, start: Token) -> Option<Node> {
        self.advance();
        let Some(cond) = self.expression() else {
            self.err_at("{% if %} requires a condition", &start);
            self.skip_to_tag_end();
            return None;
        };
        let mut trim_right = false;
        if self.check(Tok::TagEnd) {
            trim_right = self.advance().trim_right;
        } else {
            self.err("Missing %} to close {% if %}");
        }
        let stops = [Tok::KwElseif, Tok::KwElse, Tok::KwEndif];
        let then = self.body(&stops, true)?;
        let mut elseifs = Vec::new();
        while self.check_tag_kw(&[Tok::KwElseif]) {
            self.advance();
            self.advance();
            let Some(c) = self.expression() else {
                self.err("{% elseif %} requires a condition");
                self.skip_to_tag_end();
                continue;
            };
            self.consume_tag_end();
            let b = self.body(&stops, true)?;
            elseifs.push((c, b));
        }
        let mut otherwise = None;
        if self.check_tag_kw(&[Tok::KwElse]) {
            self.advance();
            self.advance();
            self.consume_tag_end();
            otherwise = Some(self.body(&[Tok::KwEndif], true)?);
        }
        if self.check_tag_kw(&[Tok::KwEndif]) {
            self.advance();
            self.advance();
            self.consume_tag_end();
        } else {
            self.err("Missing {% endif %} to close {% if %}");
        }
        Some(Node::If {
            cond,
            then,
            elseifs,
            otherwise,
            trim_left: start.trim_left,
            trim_right,
            line: start.line,
            column: start.column,
        })
    }

    fn for_stmt(&mut self, start: Token) -> Option<Node> {
        self.advance();
        if !self.check(Tok::Identifier) {
            self.err("{% for %} requires a variable name, e.g. {% for item in items %}");
            self.skip_to_tag_end();
            return None;
        }
        let iterator = self.advance().value;
        if !self.check(Tok::KwIn) {
            self.err("{% for %} requires \"in\" keyword, e.g. {% for item in items %}");
            self.skip_to_tag_end();
            return None;
        }
        self.advance();
        let Some(iterable) = self.expression() else {
            self.err("{% for %} requires something to loop over after \"in\"");
            self.skip_to_tag_end();
            return None;
        };
        let mut trim_right = false;
        if self.check(Tok::TagEnd) {
            trim_right = self.advance().trim_right;
        } else {
            self.err("Missing %} to close {% for %}");
        }
        let body = self.body(&[Tok::KwEndfor], false)?;
        if self.check_tag_kw(&[Tok::KwEndfor]) {
            self.advance();
            self.advance();
            self.consume_tag_end();
        } else {
            self.err("Missing {% endfor %} to close {% for %}");
        }
        Some(Node::For {
            iterator,
            iterable,
            body,
            trim_left: start.trim_left,
            trim_right,
            line: start.line,
            column: start.column,
        })
    }

    fn set_stmt(&mut self, start: Token) -> Option<Node> {
        self.advance();
        if !self.check(Tok::Identifier) {
            self.err("{% set %} requires a variable name, e.g. {% set name = value %}");
            self.skip_to_tag_end();
            return None;
        }
        let name = self.advance().value;
        if !self.check(Tok::OpAssign) {
            self.err("{% set %} requires \"=\" after variable name");
            self.skip_to_tag_end();
            return None;
        }
        self.advance();
        let Some(value) = self.expression() else {
            self.err("{% set %} requires a value after \"=\"");
            self.skip_to_tag_end();
            return None;
        };
        let mut trim_right = false;
        if self.check(Tok::TagEnd) {
            trim_right = self.advance().trim_right;
        } else {
            self.err("Missing %} to close {% set %}");
        }
        Some(Node::Set {
            name,
            value,
            trim_left: start.trim_left,
            trim_right,
            line: start.line,
            column: start.column,
        })
    }

    fn body(&mut self, stops: &[Tok], trim_closing_line: bool) -> Option<Vec<Node>> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            self.err("Template exceeded maxDepth");
            self.pos = self.tokens.len().saturating_sub(1);
            self.depth -= 1;
            return None;
        }
        let mut nodes: Vec<Node> = Vec::new();
        while !self.at_end() {
            if self.check_tag_kw(stops) {
                if trim_closing_line {
                    let mut end = self.pos;
                    while end < self.tokens.len() && self.tokens[end].kind != Tok::TagEnd {
                        end += 1;
                    }
                    let after = self.tokens.get(end + 1);
                    let standalone = match after {
                        Some(t) if t.kind == Tok::Eof => true,
                        Some(t) if t.kind == Tok::Text => {
                            let v = t.value.trim_start_matches(['\t', ' ']);
                            v.is_empty() || v.starts_with('\n') || v.starts_with("\r\n")
                        }
                        _ => false,
                    };
                    if standalone {
                        if let Some(Node::Text(last)) = nodes.last_mut() {
                            // replace(/\r?\n[\t ]*$/, '')
                            let trimmed = last.trim_end_matches(['\t', ' ']);
                            if let Some(stripped) = trimmed.strip_suffix('\n') {
                                let stripped = stripped.strip_suffix('\r').unwrap_or(stripped);
                                *last = stripped.to_string();
                            }
                        }
                    }
                }
                break;
            }
            if let Some(n) = self.node() {
                nodes.push(n);
            }
        }
        self.depth -= 1;
        Some(nodes)
    }

    // ---- expressions -----------------------------------------------------

    fn expression(&mut self) -> Option<Expr> {
        self.nullish()
    }

    fn nullish(&mut self) -> Option<Expr> {
        let mut left = self.filter_expr()?;
        while self.check(Tok::OpNullish) {
            let op = self.advance();
            let Some(right) = self.filter_expr() else {
                self.err_at("Missing fallback value after ??", &op);
                break;
            };
            left = Expr::Binary {
                op: "??".into(),
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Some(left)
    }

    fn filter_argument(&mut self) -> Option<Expr> {
        let start = self.peek().clone();
        if self.check(Tok::Slash) || self.check(Tok::Star) {
            let t = self.advance();
            return Some(Expr::str_lit(t.value));
        }
        if self.check(Tok::LBracket) {
            let mut value = String::new();
            let mut depth = 0i32;
            while !self.at_end() {
                let t = self.peek().clone();
                if t.kind == Tok::LBracket {
                    depth += 1;
                } else if t.kind == Tok::RBracket {
                    depth -= 1;
                    if depth == 0 {
                        value.push_str(&t.value);
                        self.advance();
                        break;
                    }
                }
                if depth == 0 && matches!(t.kind, Tok::Pipe | Tok::VariableEnd | Tok::Comma) {
                    break;
                }
                value.push_str(&t.value);
                self.advance();
            }
            return Some(Expr::str_lit(value));
        }
        if self.check(Tok::Identifier) {
            let saved = self.pos;
            let id = self.advance();
            if self.check(Tok::Arrow) {
                let mut value = format!("{} {} ", id.value, self.advance().value);
                let (mut brace, mut paren) = (0i32, 0i32);
                while !self.at_end() {
                    let t = self.peek().clone();
                    if brace == 0 && paren == 0 && matches!(t.kind, Tok::Pipe | Tok::VariableEnd | Tok::TagEnd) {
                        break;
                    }
                    match t.kind {
                        Tok::LBrace => brace += 1,
                        Tok::LParen => paren += 1,
                        Tok::RBrace | Tok::RParen => {
                            if t.kind == Tok::RBrace {
                                brace -= 1;
                            } else {
                                paren -= 1;
                            }
                            if brace < 0 || paren < 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    if t.kind == Tok::String {
                        value.push('"');
                        value.push_str(&t.value);
                        value.push('"');
                    } else {
                        value.push_str(&t.value);
                    }
                    self.advance();
                }
                return Some(Expr::str_lit(value.trim().to_string()));
            }
            self.pos = saved;
        }

        let first = self.primary()?;
        if let Expr::Literal { value: Lit::Str(s), .. } = &first {
            if start.kind == Tok::String {
                let mut combined = format!("\"{s}\"");
                let mut is_pair = false;
                while self.check(Tok::Colon) {
                    let saved = self.pos;
                    self.advance();
                    if self.check(Tok::String) {
                        if let Some(Expr::Literal { value: Lit::Str(n), .. }) = self.primary() {
                            combined.push_str(&format!(":\"{n}\""));
                            is_pair = true;
                        }
                    } else {
                        self.pos = saved;
                        break;
                    }
                }
                return Some(Expr::Literal {
                    value: Lit::Str(combined),
                    unquoted: if is_pair { None } else { Some(s.clone()) },
                });
            }
        }
        if let Expr::Ident { name } = &first {
            if self.check(Tok::Plus) {
                let saved = self.pos;
                self.advance();
                if self.check(Tok::Number) {
                    let n = self.advance();
                    return Some(Expr::str_lit(format!("{}+{}", name, n.value)));
                }
                self.pos = saved;
            }
        }
        if start.kind == Tok::Number && self.check(Tok::Identifier) {
            let id = self.peek().clone();
            if id.value.chars().count() == 1 && id.value.chars().all(|c| c.is_ascii_alphabetic()) {
                self.advance();
                let num = match &first {
                    Expr::Literal { value: Lit::Num(n), .. } => crate::value::js_number(*n),
                    _ => String::new(),
                };
                return Some(Expr::str_lit(format!("{num}{}", id.value)));
            }
        }
        if !self.check(Tok::Colon) {
            return Some(first);
        }
        let mut value = match &first {
            Expr::Literal { value, .. } => lit_string(value),
            Expr::Ident { name } => name.clone(),
            _ => return Some(first),
        };
        while self.check(Tok::Colon) && !self.at_end() {
            self.advance();
            value.push(':');
            match self.primary() {
                Some(Expr::Literal { value: l, .. }) => value.push_str(&lit_string(&l)),
                Some(Expr::Ident { name }) => value.push_str(&name),
                Some(_) => {}
                None => break,
            }
        }
        Some(Expr::str_lit(value))
    }

    fn filter_expr(&mut self) -> Option<Expr> {
        let mut left = self.or_expr()?;
        while self.check(Tok::Pipe) {
            self.advance();
            if !self.check(Tok::Identifier) {
                self.err("Missing filter name after |");
                break;
            }
            let ft = self.advance();
            let mut args = Vec::new();
            if self.check(Tok::Colon) {
                self.advance();
                if self.check(Tok::LParen) {
                    self.advance();
                    while !self.check(Tok::RParen) && !self.at_end() {
                        let Some(arg) = self.or_expr() else { break };
                        let is_str = matches!(&arg, Expr::Literal { value: Lit::Str(_), .. });
                        if is_str && self.check(Tok::Colon) {
                            let s = match &arg {
                                Expr::Literal { value: Lit::Str(s), .. } => s.clone(),
                                _ => unreachable!(),
                            };
                            let mut combined = format!("\"{s}\"");
                            while self.check(Tok::Colon) {
                                self.advance();
                                match self.or_expr() {
                                    Some(Expr::Literal { value: Lit::Str(n), .. }) => {
                                        combined.push_str(&format!(":\"{n}\""))
                                    }
                                    _ => break,
                                }
                            }
                            args.push(Expr::str_lit(combined));
                        } else {
                            args.push(arg);
                        }
                        if self.check(Tok::Comma) {
                            self.advance();
                        } else {
                            break;
                        }
                    }
                    if self.check(Tok::RParen) {
                        self.advance();
                    }
                } else {
                    if let Some(a) = self.filter_argument() {
                        args.push(a);
                    }
                    while self.check(Tok::Comma) {
                        self.advance();
                        if let Some(a) = self.filter_argument() {
                            args.push(a);
                        }
                    }
                }
            }
            left = Expr::Filter {
                value: Box::new(left),
                name: ft.value,
                args,
                line: ft.line,
                column: ft.column,
            };
        }
        Some(left)
    }

    fn with_depth<T>(&mut self, f: impl FnOnce(&mut P) -> Option<T>) -> Option<T> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            self.err("Template exceeded maxDepth");
            self.depth -= 1;
            return None;
        }
        let r = f(self);
        self.depth -= 1;
        r
    }

    fn or_expr(&mut self) -> Option<Expr> {
        self.with_depth(|p| {
            let mut left = p.and_expr()?;
            while p.check(Tok::OpOr) {
                let op = p.advance();
                let Some(right) = p.and_expr() else {
                    p.err_at("Missing value after \"or\"", &op);
                    break;
                };
                left = Expr::Binary {
                    op: "or".into(),
                    left: Box::new(left),
                    right: Box::new(right),
                };
            }
            Some(left)
        })
    }

    fn and_expr(&mut self) -> Option<Expr> {
        let mut left = self.not_expr()?;
        while self.check(Tok::OpAnd) {
            let op = self.advance();
            let Some(right) = self.not_expr() else {
                self.err_at("Missing value after \"and\"", &op);
                break;
            };
            left = Expr::Binary {
                op: "and".into(),
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Some(left)
    }

    fn not_expr(&mut self) -> Option<Expr> {
        self.with_depth(|p| {
            if p.check(Tok::OpNot) {
                let op = p.advance();
                let Some(arg) = p.not_expr() else {
                    p.err_at("Missing value after \"not\"", &op);
                    return None;
                };
                return Some(Expr::Not(Box::new(arg)));
            }
            p.comparison()
        })
    }

    fn comparison(&mut self) -> Option<Expr> {
        let left = self.postfix()?;
        let op = match self.peek().kind {
            Tok::OpEq => "==",
            Tok::OpNeq => "!=",
            Tok::OpGt => ">",
            Tok::OpLt => "<",
            Tok::OpGte => ">=",
            Tok::OpLte => "<=",
            Tok::OpContains => "contains",
            _ => return Some(left),
        };
        let opt = self.advance();
        let Some(right) = self.postfix() else {
            self.err_at(format!("Missing value after \"{}\"", opt.value), &opt);
            return Some(left);
        };
        Some(Expr::Binary {
            op: op.into(),
            left: Box::new(left),
            right: Box::new(right),
        })
    }

    fn postfix(&mut self) -> Option<Expr> {
        let mut left = self.primary()?;
        while self.check(Tok::LBracket) || self.check(Tok::Dot) {
            if self.check(Tok::Dot) {
                let dot = self.advance();
                let prop = self.peek().clone();
                let parts: Vec<&str> = prop.value.split('.').collect();
                let valid = prop.kind != Tok::String
                    && parts.iter().all(|part| {
                        let mut cs = part.chars();
                        cs.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '@')
                            && cs.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '@' || c == '-')
                    });
                if !valid {
                    self.err_at("Expected a property name after .", &dot);
                    break;
                }
                self.advance();
                for part in parts {
                    left = Expr::Member {
                        object: Box::new(left),
                        property: Box::new(Expr::str_lit(part.to_string())),
                    };
                }
                continue;
            }
            let bt = self.advance();
            let Some(prop) = self.or_expr() else {
                self.err_at("Empty brackets [] - add an index or key", &bt);
                break;
            };
            if self.check(Tok::RBracket) {
                self.advance();
            } else {
                self.err("Missing closing ]");
            }
            left = Expr::Member {
                object: Box::new(left),
                property: Box::new(prop),
            };
        }
        Some(left)
    }

    fn primary(&mut self) -> Option<Expr> {
        let t = self.peek().clone();
        match t.kind {
            Tok::LParen => {
                self.advance();
                let Some(e) = self.or_expr() else {
                    self.err_at("Empty parentheses () - add an expression", &t);
                    return None;
                };
                if self.check(Tok::RParen) {
                    self.advance();
                } else {
                    self.err("Missing closing )");
                }
                Some(Expr::Group(Box::new(e)))
            }
            Tok::String => {
                self.advance();
                Some(Expr::str_lit(t.value))
            }
            Tok::Number => {
                self.advance();
                Some(Expr::Literal {
                    value: Lit::Num(crate::value::parse_float(&t.value)),
                    unquoted: None,
                })
            }
            Tok::Boolean => {
                self.advance();
                Some(Expr::Literal {
                    value: Lit::Bool(t.value.eq_ignore_ascii_case("true")),
                    unquoted: None,
                })
            }
            Tok::Null => {
                self.advance();
                Some(Expr::Literal {
                    value: Lit::Null,
                    unquoted: None,
                })
            }
            Tok::Identifier => {
                self.advance();
                let mut name = t.value.clone();
                if self.check(Tok::Colon) {
                    self.advance();
                    let mut rest = String::new();
                    while matches!(
                        self.peek().kind,
                        Tok::Identifier
                            | Tok::Dot
                            | Tok::Colon
                            | Tok::LBracket
                            | Tok::RBracket
                            | Tok::Number
                            | Tok::String
                            | Tok::Star
                    ) {
                        rest.push_str(&self.advance().value);
                    }
                    name = format!("{name}:{rest}");
                }
                Some(Expr::Ident { name })
            }
            _ => None,
        }
    }
}

fn lit_string(l: &Lit) -> String {
    match l {
        Lit::Str(s) => s.clone(),
        Lit::Num(n) => crate::value::js_number(*n),
        Lit::Bool(b) => b.to_string(),
        Lit::Null => "null".into(),
    }
}
