//! Tokenizer for Obsidian's search language (`fP` in the 1.13 bundle).
//!
//! Scanning rules, from the app:
//!
//! * At a token boundary, `"` starts a quoted phrase (a backslash escapes the
//!   next character), `/` starts a regex (`\/` is a literal slash, `\\` stays
//!   as two backslashes, any other `\x` is kept as written) and `-` is a
//!   negation. An unterminated quote or regex runs to the end of the query.
//! * Anything else accumulates into a text token until a space or one of
//!   `[ ] ( ) : < >`, each of which is its own token. Only the ASCII space
//!   separates words; `-` and `/` inside a word are ordinary characters.
//! * The words `OR`, `TRUE`, `FALSE` and `EMPTY` — upper-case only — are
//!   keywords.
//!
//! Positions are UTF-16 offsets into the query.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    Text,
    Quote,
    Regex,
    Not,
    Or,
    True,
    False,
    Empty,
    Colon,
    BracketOpen,
    BracketClose,
    ParenOpen,
    ParenClose,
    GreaterThan,
    LessThan,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub kind: TokenKind,
    pub content: String,
    /// UTF-16 offset of the token's first character in the query.
    pub pos: u32,
}

pub fn tokenize(query: &str) -> Vec<Token> {
    // Work on chars with a running UTF-16 position; every special character
    // is ASCII, so this is equivalent to the app's charAt() loop.
    let chars: Vec<char> = query.chars().collect();
    let mut u16pos = Vec::with_capacity(chars.len() + 1);
    let mut acc = 0u32;
    for c in &chars {
        u16pos.push(acc);
        acc += c.len_utf16() as u32;
    }
    u16pos.push(acc);

    let n = chars.len();
    let mut t = 0usize;
    let mut out = Vec::new();
    let push_word = |out: &mut Vec<Token>, s: &str, at: usize| {
        let kind = match s {
            "TRUE" => TokenKind::True,
            "FALSE" => TokenKind::False,
            "EMPTY" => TokenKind::Empty,
            "OR" => TokenKind::Or,
            _ => TokenKind::Text,
        };
        out.push(Token {
            kind,
            content: s.to_string(),
            pos: u16pos[at],
        });
    };
    while t < n {
        let o = chars[t];
        if o == '"' {
            let start = t;
            t += 1;
            let mut s = String::new();
            loop {
                if t >= n {
                    out.push(Token {
                        kind: TokenKind::Quote,
                        content: s,
                        pos: u16pos[start],
                    });
                    break;
                }
                let h = chars[t];
                t += 1;
                if h == '\\' && t < n {
                    s.push(chars[t]);
                    t += 1;
                } else if h == '"' {
                    out.push(Token {
                        kind: TokenKind::Quote,
                        content: s,
                        pos: u16pos[start],
                    });
                    break;
                } else {
                    s.push(h);
                }
            }
        } else if o == '/' {
            let start = t;
            t += 1;
            let mut s = String::new();
            loop {
                if t >= n {
                    out.push(Token {
                        kind: TokenKind::Regex,
                        content: s,
                        pos: u16pos[start],
                    });
                    break;
                }
                let h = chars[t];
                t += 1;
                if h == '\\' && t < n {
                    let p = chars[t];
                    if p == '/' {
                        s.push('/');
                        t += 1;
                        continue;
                    }
                    if p == '\\' {
                        s.push_str("\\\\");
                        t += 1;
                        continue;
                    }
                }
                if h == '/' {
                    out.push(Token {
                        kind: TokenKind::Regex,
                        content: s,
                        pos: u16pos[start],
                    });
                    break;
                }
                s.push(h);
            }
        } else if o == '-' {
            out.push(Token {
                kind: TokenKind::Not,
                content: "-".into(),
                pos: u16pos[t],
            });
            t += 1;
        } else {
            let start = t;
            let mut s = String::new();
            loop {
                if t >= n {
                    if !s.is_empty() {
                        push_word(&mut out, &s, start);
                    }
                    break;
                }
                let h = chars[t];
                t += 1;
                let special = match h {
                    '[' => Some(TokenKind::BracketOpen),
                    ']' => Some(TokenKind::BracketClose),
                    '(' => Some(TokenKind::ParenOpen),
                    ')' => Some(TokenKind::ParenClose),
                    ':' => Some(TokenKind::Colon),
                    '>' => Some(TokenKind::GreaterThan),
                    '<' => Some(TokenKind::LessThan),
                    _ => None,
                };
                if let Some(kind) = special {
                    if !s.is_empty() {
                        push_word(&mut out, &s, start);
                    }
                    out.push(Token {
                        kind,
                        content: h.to_string(),
                        pos: u16pos[t - 1],
                    });
                    break;
                }
                if h == ' ' {
                    if !s.is_empty() {
                        push_word(&mut out, &s, start);
                    }
                    break;
                }
                s.push(h);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::TokenKind::*;
    use super::*;

    fn kinds(q: &str) -> Vec<(TokenKind, String)> {
        tokenize(q)
            .into_iter()
            .map(|t| (t.kind, t.content))
            .collect()
    }

    #[test]
    fn words_quotes_and_keywords() {
        assert_eq!(
            kinds(r#"meeting "star \"wars\"" OR or -work"#),
            vec![
                (Text, "meeting".into()),
                (Quote, "star \"wars\"".into()),
                (Or, "OR".into()),
                (Text, "or".into()),
                (Not, "-".into()),
                (Text, "work".into())
            ]
        );
    }

    #[test]
    fn operators_brackets_and_comparisons() {
        assert_eq!(
            kinds("path:a/b [duration:<5] (x)"),
            vec![
                (Text, "path".into()),
                (Colon, ":".into()),
                (Text, "a/b".into()),
                (BracketOpen, "[".into()),
                (Text, "duration".into()),
                (Colon, ":".into()),
                (LessThan, "<".into()),
                (Text, "5".into()),
                (BracketClose, "]".into()),
                (ParenOpen, "(".into()),
                (Text, "x".into()),
                (ParenClose, ")".into())
            ]
        );
    }

    #[test]
    fn regex_escapes() {
        assert_eq!(kinds(r"/a\/b\\c\d/"), vec![(Regex, r"a/b\\c\d".into())]);
        assert_eq!(kinds("/open"), vec![(Regex, "open".into())]);
        assert_eq!(kinds("\"open"), vec![(Quote, "open".into())]);
    }

    #[test]
    fn dash_and_slash_inside_words() {
        assert_eq!(
            kinds("foo-bar a/b"),
            vec![(Text, "foo-bar".into()), (Text, "a/b".into())]
        );
        assert_eq!(
            kinds("TRUE FALSE EMPTY true"),
            vec![
                (True, "TRUE".into()),
                (False, "FALSE".into()),
                (Empty, "EMPTY".into()),
                (Text, "true".into())
            ]
        );
    }

    #[test]
    fn positions_are_utf16() {
        let t = tokenize("😀 x");
        assert_eq!(t[0].pos, 0);
        assert_eq!(t[1].pos, 3);
    }
}
