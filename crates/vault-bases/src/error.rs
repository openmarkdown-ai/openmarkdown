use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    /// The `.base` text is not valid YAML.
    Yaml,
    /// The YAML is valid but does not match the Bases schema.
    Schema,
    /// An expression failed to parse.
    Parse,
    /// An expression failed to evaluate.
    Eval,
}

/// An error with an optional location.
///
/// For `parse` errors `offset`/`end` are UTF-16 code units into the
/// expression text; for `yaml` errors they are UTF-16 offsets into the `.base`
/// text and `line`/`col` are zero-based. `source` names where the expression
/// lives in the file (`formulas.ppu`, `views[0].filters.and[1]`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BaseError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub end: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub col: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,
}

pub(crate) fn utf16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

impl BaseError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        BaseError {
            kind,
            message: message.into(),
            offset: None,
            end: None,
            line: None,
            col: None,
            source: None,
        }
    }

    /// A parse error spanning bytes `start..end` of `src`.
    pub fn parse(message: impl Into<String>, src: &str, start: usize, end: usize) -> Self {
        let s = floor_char_boundary(src, start);
        let e = floor_char_boundary(src, end.max(start));
        BaseError {
            offset: Some(utf16_len(&src[..s])),
            end: Some(utf16_len(&src[..e])),
            ..BaseError::new(ErrorKind::Parse, message)
        }
    }

    pub fn eval(message: impl Into<String>) -> Self {
        BaseError::new(ErrorKind::Eval, message)
    }

    pub fn schema(message: impl Into<String>) -> Self {
        BaseError::new(ErrorKind::Schema, message)
    }

    pub fn with_source(mut self, source: impl Into<String>) -> Self {
        if self.source.is_none() {
            self.source = Some(source.into());
        }
        self
    }
}

impl fmt::Display for BaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(src) = &self.source {
            write!(f, "{src}: ")?;
        }
        f.write_str(&self.message)?;
        match (self.line, self.col, self.offset) {
            (Some(l), Some(c), _) => write!(f, " (line {}, column {})", l + 1, c + 1),
            (_, _, Some(o)) => write!(f, " (at {o})"),
            _ => Ok(()),
        }
    }
}

impl std::error::Error for BaseError {}
