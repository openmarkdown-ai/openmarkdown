//! Just enough HTML to rewrite what `vault_ofm::render` produces: escaping,
//! entity decoding and a start-tag parser. The renderer's output is regular
//! (see the contract table in docs/ARCHITECTURE.md), and raw HTML from notes
//! only needs to be passed through with scripts and event handlers removed.

pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Decodes the entities the renderer and typical raw HTML use: the five XML
/// ones, `&nbsp;` and numeric references. Others are left as written.
pub fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest[1..].find(';').map(|j| j + 1).filter(|&j| j <= 12);
        let decoded = end.and_then(|j| {
            let name = &rest[1..j];
            let ch = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some('\u{a0}'),
                _ if name.starts_with("#x") || name.starts_with("#X") => u32::from_str_radix(&name[2..], 16).ok().and_then(char::from_u32),
                _ if name.starts_with('#') => name[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            };
            ch.map(|c| (c, j))
        });
        match decoded {
            Some((c, j)) => {
                out.push(c);
                rest = &rest[j + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Text content of an HTML fragment: tags removed, entities decoded,
/// whitespace collapsed. Block-level boundaries become spaces.
pub fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        out.push(' ');
        rest = &rest[i..];
        match rest.find('>') {
            Some(j) => rest = &rest[j + 1..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    let text = unescape(&out);
    let mut collapsed = String::with_capacity(text.len());
    let mut ws = true;
    for c in text.chars() {
        if c.is_whitespace() {
            if !ws {
                collapsed.push(' ');
            }
            ws = true;
        } else {
            collapsed.push(c);
            ws = false;
        }
    }
    collapsed.trim_end().to_string()
}

/// A parsed start (or end) tag.
#[derive(Debug, Clone)]
pub struct Tag {
    /// Lower-cased.
    pub name: String,
    pub closing: bool,
    /// `(name lower-cased, decoded value)`; `None` for a bare attribute.
    pub attrs: Vec<(String, Option<String>)>,
    pub self_closing: bool,
    /// Byte length of the tag in the source, `<` to `>` inclusive.
    pub len: usize,
}

impl Tag {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_deref().unwrap_or(""))
    }

    pub fn has_class(&self, class: &str) -> bool {
        self.attr("class").map(|c| c.split_ascii_whitespace().any(|x| x == class)).unwrap_or(false)
    }

    pub fn set_attr(&mut self, name: &str, value: Option<&str>) {
        match self.attrs.iter_mut().find(|(n, _)| n == name) {
            Some(a) => a.1 = value.map(str::to_string),
            None => self.attrs.push((name.to_string(), value.map(str::to_string))),
        }
    }

    pub fn remove_attr(&mut self, name: &str) {
        self.attrs.retain(|(n, _)| n != name);
    }

    /// Whether the tag carries an attribute that must not reach a published
    /// page: an event handler or a `javascript:` URL.
    pub fn is_unsafe(&self) -> bool {
        self.attrs.iter().any(|(n, v)| {
            n.starts_with("on")
                || (matches!(n.as_str(), "href" | "src" | "action" | "formaction" | "xlink:href")
                    && v.as_deref().map(|v| v.trim_start().to_ascii_lowercase().starts_with("javascript:")).unwrap_or(false))
        })
    }

    pub fn sanitize(&mut self) {
        self.attrs.retain(|(n, v)| {
            !(n.starts_with("on")
                || (matches!(n.as_str(), "href" | "src" | "action" | "formaction" | "xlink:href")
                    && v.as_deref().map(|v| v.trim_start().to_ascii_lowercase().starts_with("javascript:")).unwrap_or(false)))
        });
    }

    pub fn to_html(&self) -> String {
        let mut s = String::from("<");
        if self.closing {
            s.push('/');
        }
        s.push_str(&self.name);
        for (n, v) in &self.attrs {
            s.push(' ');
            s.push_str(n);
            if let Some(v) = v {
                s.push_str("=\"");
                s.push_str(&esc(v));
                s.push('"');
            }
        }
        if self.self_closing {
            s.push_str(" /");
        }
        s.push('>');
        s
    }
}

/// Parses the tag at the start of `s` (which begins with `<`). Returns `None`
/// when it is not a tag (a lone `<` in text, a comment, a doctype).
pub fn parse_tag(s: &str) -> Option<Tag> {
    let b = s.as_bytes();
    if b.first() != Some(&b'<') {
        return None;
    }
    let mut i = 1;
    let closing = b.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let start = i;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'-') {
        i += 1;
    }
    if i == start || !b[start].is_ascii_alphabetic() {
        return None;
    }
    let name = s[start..i].to_ascii_lowercase();
    let mut attrs = Vec::new();
    let mut self_closing = false;
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return None;
        }
        match b[i] {
            b'>' => {
                return Some(Tag { name, closing, attrs, self_closing, len: i + 1 });
            }
            b'/' => {
                self_closing = true;
                i += 1;
                continue;
            }
            _ => {}
        }
        let an_start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'/') {
            i += 1;
        }
        if i == an_start {
            i += 1;
            continue;
        }
        let an = s[an_start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if b.get(i) == Some(&b'=') {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            let value = match b.get(i) {
                Some(&q) if q == b'"' || q == b'\'' => {
                    let end = s[i + 1..].find(q as char)? + i + 1;
                    let v = &s[i + 1..end];
                    i = end + 1;
                    v
                }
                _ => {
                    let vs = i;
                    while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                        i += 1;
                    }
                    &s[vs..i]
                }
            };
            attrs.push((an, Some(unescape(value))));
        } else {
            attrs.push((an, None));
        }
        self_closing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_renderer_tags() {
        let t = parse_tag(r#"<a data-href="A &amp; B#H" href="A &amp; B#H" class="internal-link" target="_blank">x"#).unwrap();
        assert_eq!(t.name, "a");
        assert_eq!(t.attr("data-href"), Some("A & B#H"));
        assert!(t.has_class("internal-link"));
        let t = parse_tag("<input data-line=\"0\" type=\"checkbox\" checked>").unwrap();
        assert_eq!(t.attr("checked"), Some(""));
        assert!(parse_tag("< 3").is_none());
        assert!(parse_tag("<!-- c -->").is_none());
    }

    #[test]
    fn strips_and_unescapes() {
        assert_eq!(strip_tags("<p>a &amp; <b>b</b></p>\n<p>c&#x41;</p>"), "a & b cA");
        assert_eq!(unescape("&unknown; &lt;"), "&unknown; <");
    }
}
