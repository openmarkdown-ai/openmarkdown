//! `new URL(href, base)` for the handful of properties Defuddle reads: the
//! serialised `href`, `hostname`, `pathname` and `origin`. Built on
//! [`crate::url::resolve`] and then normalised the way WHATWG URL serialises
//! special (http/https/ftp/ws/file) URLs: lowercase scheme and host, an empty
//! path becomes `/`, backslashes become slashes, and characters outside the
//! URL code-point set are percent-encoded. Not a full WHATWG parser — IDNA,
//! IPv6 canonicalisation and default-port stripping are left out.

#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub scheme: String,
    pub host: String,
    pub port: String,
    pub path: String,
    pub query: String,
    pub fragment: String,
    pub special: bool,
}

impl Parsed {
    pub fn origin(&self) -> String {
        if self.special {
            if self.port.is_empty() {
                format!("{}://{}", self.scheme, self.host)
            } else {
                format!("{}://{}:{}", self.scheme, self.host, self.port)
            }
        } else {
            "null".to_string()
        }
    }

    pub fn href(&self) -> String {
        if self.special {
            let mut s = format!("{}://{}", self.scheme, self.host);
            if !self.port.is_empty() {
                s.push(':');
                s.push_str(&self.port);
            }
            s.push_str(&self.path);
            s.push_str(&self.query);
            s.push_str(&self.fragment);
            s
        } else {
            format!("{}:{}{}{}", self.scheme, self.path, self.query, self.fragment)
        }
    }
}

const SPECIAL: &[&str] = &["http", "https", "ftp", "ws", "wss", "file"];

fn encode(s: &str, extra: &[char]) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_control() || c == ' ' || c == '"' || c == '<' || c == '>' || c == '`'
            || extra.contains(&c) || !c.is_ascii()
        {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Parse an absolute URL.
pub fn parse(url: &str) -> Option<Parsed> {
    let url = url.trim_matches(|c: char| c <= ' ');
    let scheme = crate::url::scheme_of(url)?.to_ascii_lowercase();
    let rest = &url[scheme.len() + 1..];
    let special = SPECIAL.contains(&scheme.as_str());
    if !special {
        let (before_frag, fragment) = match rest.find('#') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        let (path, query) = match before_frag.find('?') {
            Some(i) => (&before_frag[..i], &before_frag[i..]),
            None => (before_frag, ""),
        };
        return Some(Parsed {
            scheme,
            host: String::new(),
            port: String::new(),
            path: path.to_string(),
            query: query.to_string(),
            fragment: fragment.to_string(),
            special,
        });
    }
    let rest = rest.replace('\\', "/");
    let rest = rest.trim_start_matches('/');
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let tail = &rest[end..];
    let hostport = authority.rsplit('@').next().unwrap_or("");
    let (host, port) = match hostport.rfind(':') {
        Some(i) if !hostport[i..].contains(']') => (&hostport[..i], &hostport[i + 1..]),
        _ => (hostport, ""),
    };
    if host.is_empty() && scheme != "file" {
        return None;
    }
    let port = match (scheme.as_str(), port) {
        ("http" | "ws", "80") | ("https" | "wss", "443") | ("ftp", "21") => "",
        _ => port,
    };
    let (before_frag, fragment) = match tail.find('#') {
        Some(i) => (&tail[..i], &tail[i..]),
        None => (tail, ""),
    };
    let (path, query) = match before_frag.find('?') {
        Some(i) => (&before_frag[..i], &before_frag[i..]),
        None => (before_frag, ""),
    };
    let path = if path.is_empty() { "/".to_string() } else { normalise_dots(path) };
    Some(Parsed {
        scheme,
        host: host.to_ascii_lowercase(),
        port: port.to_string(),
        path: encode(&path, &['?', '{', '}']),
        query: encode(query, &['\'']),
        fragment: encode(fragment, &[]),
        special,
    })
}

fn normalise_dots(path: &str) -> String {
    if !path.contains("/.") {
        return path.to_string();
    }
    let trailing = path.ends_with('/') || path.ends_with("/.") || path.ends_with("/..");
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/').skip(1) {
        match seg {
            "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    let mut s = String::from("/");
    s.push_str(&out.join("/"));
    if trailing && !s.ends_with('/') {
        s.push('/');
    }
    s
}

/// `new URL(href, base)`, `None` where the constructor would throw.
pub fn join(base: &str, href: &str) -> Option<Parsed> {
    let href = href.trim_matches(|c: char| c <= ' ');
    if crate::url::is_absolute(href) && !href.starts_with("//") {
        return parse(href);
    }
    let b = parse(base)?;
    if href.is_empty() {
        let mut b2 = b;
        b2.fragment.clear();
        return Some(b2);
    }
    if !b.special {
        if let Some(f) = href.strip_prefix('#') {
            let mut b2 = b;
            b2.fragment = format!("#{f}");
            return Some(b2);
        }
        return None;
    }
    if let Some(f) = href.strip_prefix('#') {
        let mut b2 = b;
        b2.fragment = encode(&format!("#{f}"), &[]);
        return Some(b2);
    }
    let href = href.replace('\\', "/");
    let base_str = b.href();
    let resolved = crate::url::resolve(&base_str, &href)?;
    parse(&resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_and_normalises_like_whatwg() {
        assert_eq!(join("https://a.com/x/y", "../z w").unwrap().href(), "https://a.com/z%20w");
        assert_eq!(join("https://a.com/x", "HTTPS://B.COM").unwrap().href(), "https://b.com/");
        assert_eq!(join("https://a.com/x/y?q", "#top").unwrap().href(), "https://a.com/x/y?q#top");
        assert_eq!(join("https://a.com/x", "mailto:me@x.org").unwrap().href(), "mailto:me@x.org");
        assert_eq!(join("https://a.com/x", "//cdn.b.com/i.png").unwrap().href(), "https://cdn.b.com/i.png");
        assert_eq!(parse("https://www.x.com:443/p").unwrap().origin(), "https://www.x.com");
        assert_eq!(join("https://a.com/a/b", "/é").unwrap().path, "/%C3%A9");
    }
}
