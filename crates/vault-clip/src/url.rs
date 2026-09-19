//! Just enough RFC 3986 to turn the relative URLs in a page into absolute ones.
//!
//! A saved article is read long after the page it came from is gone, so every
//! `src` and `href` has to be absolute at save time. A full URL crate would do
//! this, but it brings IDNA tables and a percent-encoding set that together
//! outweigh the entire rest of this library in a wasm build, to solve a problem
//! we do not have: these inputs come from an HTML attribute the browser already
//! accepted, not from user text.

/// Split an absolute URL into (scheme, authority, path, query).
fn split_absolute(url: &str) -> Option<(&str, &str, &str, &str)> {
    let colon = url.find("://")?;
    let scheme = &url[..colon];
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return None;
    }
    let rest = &url[colon + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let tail = &rest[end..];
    let (path, query) = match tail.find('?') {
        Some(q) => (&tail[..q], &tail[q..]),
        None => (tail, ""),
    };
    let path = match path.find('#') {
        Some(h) => &path[..h],
        None => path,
    };
    Some((scheme, authority, path, query))
}

/// The scheme of a URI reference, if it has one.
///
/// RFC 3986 says a reference with a scheme is absolute — with or without the
/// `//` authority. Requiring `://` here was a real bug: `javascript:alert(1)`
/// has no `//`, so it was treated as a relative path and cheerfully joined onto
/// the base, producing `https://site/javascript:alert(1)`. That particular
/// result is inert, but a rule that turns one scheme into another is not one to
/// leave standing in front of a sanitiser.
pub fn scheme_of(url: &str) -> Option<&str> {
    let bytes = url.as_bytes();
    let colon = url.find(':')?;
    if colon == 0 {
        return None;
    }
    // A `/`, `?` or `#` before the colon means the colon is inside a path
    // segment, not a scheme delimiter.
    if url[..colon].contains(['/', '?', '#']) {
        return None;
    }
    if !bytes[0].is_ascii_alphabetic() {
        return None;
    }
    if !bytes[..colon]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
    {
        return None;
    }
    Some(&url[..colon])
}

pub fn is_absolute(url: &str) -> bool {
    scheme_of(url).is_some()
}

/// Resolve `href` against `base`. Returns `None` when there is no way to
/// produce an absolute URL (no base, and `href` is relative).
pub fn resolve(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.is_empty() {
        return None;
    }
    // A protocol-relative reference has no scheme but must not be treated as a
    // path, so it is checked before the scheme test consumes the leading "//".
    if !href.starts_with("//") && is_absolute(href) {
        return Some(href.to_string());
    }
    let (scheme, authority, base_path, _) = split_absolute(base)?;

    // Protocol-relative: //cdn.example.com/a.png
    if let Some(rest) = href.strip_prefix("//") {
        return Some(format!("{scheme}://{rest}"));
    }
    // Fragment-only or query-only resolve against the base document itself.
    if href.starts_with('#') {
        return Some(format!("{scheme}://{authority}{base_path}{href}"));
    }
    if href.starts_with('?') {
        return Some(format!("{scheme}://{authority}{base_path}{href}"));
    }
    // Root-relative.
    if let Some(rest) = href.strip_prefix('/') {
        return Some(format!("{scheme}://{authority}/{}", normalise_path(rest)));
    }
    // Path-relative: drop the base's last segment, then normalise.
    let dir = match base_path.rfind('/') {
        Some(i) => &base_path[..=i],
        None => "/",
    };
    let joined = format!("{}{}", dir.trim_start_matches('/'), href);
    Some(format!(
        "{scheme}://{authority}/{}",
        normalise_path(&joined)
    ))
}

/// Collapse `.` and `..` segments. A `..` that would escape the root is
/// dropped rather than kept, matching what browsers do.
fn normalise_path(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let trailing_slash = path.ends_with('/');
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    let mut s = out.join("/");
    if trailing_slash && !s.is_empty() {
        s.push('/');
    }
    s
}

/// Whether a URL is safe to put in a `href`/`src` inside the reader.
///
/// The reader renders saved HTML from arbitrary sites into a privileged
/// extension page, so this is a security boundary, not a tidiness rule.
/// Allowlist, never denylist: a denylist has to anticipate `jAvAsCrIpT:` and
/// every future scheme a browser adds.
pub fn is_safe(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    // Strip the control characters and whitespace browsers ignore inside a
    // scheme — "java\nscript:alert(1)" is a live URL in some parsers.
    let stripped: String = lower
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .collect();
    if stripped.starts_with("http://")
        || stripped.starts_with("https://")
        || stripped.starts_with("mailto:")
    {
        return true;
    }
    // Inline images only — `data:text/html` is a same-origin script vector.
    if stripped.starts_with("data:image/") && !stripped.contains("svg") {
        return true;
    }
    // Relative URLs never got resolved (no base). They cannot execute, but they
    // also cannot load, so they are dropped by the sanitiser as dead weight.
    false
}

/// Hostname of a URL, for display and for grouping a library by site.
pub fn host(url: &str) -> Option<String> {
    let (_, authority, _, _) = split_absolute(url)?;
    let host = authority.rsplit('@').next()?;
    let host = match host.rfind(':') {
        // Guard against IPv6 literals, where the last colon is inside brackets.
        Some(i) if !host.contains(']') => &host[..i],
        _ => host,
    };
    let host = host.trim_start_matches("www.");
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// The clipper's `getDomain`: the registrable domain (`www.bbc.co.uk` →
/// `bbc.co.uk`), or the bare host for localhost and IPv4 addresses.
pub fn domain(url: &str) -> String {
    let Some((_, authority, _, _)) = split_absolute(url) else {
        return String::new();
    };
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = match host.rfind(':') {
        Some(i) if !host.contains(']') => &host[..i],
        _ => host,
    }
    .to_ascii_lowercase();
    let is_ipv4 = host.split('.').count() == 4
        && host.split('.').all(|p| !p.is_empty() && p.len() <= 3 && p.chars().all(|c| c.is_ascii_digit()));
    if host == "localhost" || is_ipv4 {
        return host;
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 2 {
        let sld = parts[parts.len() - 2];
        let tld = parts[parts.len() - 1];
        if matches!(sld, "co" | "com" | "org" | "net" | "edu" | "gov" | "mil")
            && tld.len() == 2
            && tld.chars().all(|c| c.is_ascii_lowercase())
        {
            return parts[parts.len() - 3..].join(".");
        }
    }
    let start = parts.len().saturating_sub(2);
    parts[start..].join(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://example.com/blog/2026/post.html?x=1";

    #[test]
    fn resolves_the_five_relative_forms() {
        assert_eq!(
            resolve(BASE, "https://other.org/a").unwrap(),
            "https://other.org/a"
        );
        assert_eq!(
            resolve(BASE, "//cdn.net/a.png").unwrap(),
            "https://cdn.net/a.png"
        );
        assert_eq!(
            resolve(BASE, "/img/a.png").unwrap(),
            "https://example.com/img/a.png"
        );
        assert_eq!(
            resolve(BASE, "a.png").unwrap(),
            "https://example.com/blog/2026/a.png"
        );
        assert_eq!(
            resolve(BASE, "#top").unwrap(),
            "https://example.com/blog/2026/post.html#top"
        );
    }

    #[test]
    fn walks_up_with_dot_dot_and_cannot_escape_the_root() {
        assert_eq!(
            resolve(BASE, "../a.png").unwrap(),
            "https://example.com/blog/a.png"
        );
        assert_eq!(
            resolve(BASE, "../../../../a.png").unwrap(),
            "https://example.com/a.png"
        );
    }

    #[test]
    fn a_scheme_without_slashes_is_absolute_not_relative() {
        // The bug this pins: these must come back untouched (and then be
        // rejected by is_safe), never joined onto the base path.
        assert_eq!(
            resolve(BASE, "javascript:alert(1)").unwrap(),
            "javascript:alert(1)"
        );
        assert_eq!(resolve(BASE, "mailto:a@b.com").unwrap(), "mailto:a@b.com");
        assert_eq!(
            resolve(BASE, "data:image/png;base64,AAA").unwrap(),
            "data:image/png;base64,AAA"
        );
        assert!(!is_safe(&resolve(BASE, "javascript:alert(1)").unwrap()));
    }

    #[test]
    fn a_colon_inside_a_path_segment_is_not_a_scheme() {
        assert_eq!(scheme_of("a/b:c"), None);
        assert_eq!(
            scheme_of("2026:post"),
            None,
            "a scheme must start with a letter"
        );
        assert_eq!(
            resolve(BASE, "notes/2026:03.html").unwrap(),
            "https://example.com/blog/2026/notes/2026:03.html"
        );
    }

    #[test]
    fn relative_href_with_no_base_is_unresolvable() {
        assert!(resolve("", "a.png").is_none());
    }

    #[test]
    fn rejects_script_urls_including_obfuscated_ones() {
        assert!(!is_safe("javascript:alert(1)"));
        assert!(!is_safe("JaVaScRiPt:alert(1)"));
        assert!(!is_safe("java\nscript:alert(1)"));
        assert!(!is_safe("  javascript:alert(1)"));
        assert!(!is_safe("data:text/html;base64,PHNjcmlwdD4="));
        assert!(!is_safe("data:image/svg+xml;base64,PHN2Zz4="));
        assert!(!is_safe("vbscript:msgbox"));
    }

    #[test]
    fn accepts_the_schemes_a_reader_needs() {
        assert!(is_safe("https://example.com/a"));
        assert!(is_safe("http://example.com/a"));
        assert!(is_safe("mailto:someone@example.com"));
        assert!(is_safe("data:image/png;base64,iVBORw0KGgo="));
    }

    #[test]
    fn extracts_a_display_host() {
        assert_eq!(host("https://www.example.com/a").unwrap(), "example.com");
        assert_eq!(
            host("https://user:pw@sub.example.com:8443/a").unwrap(),
            "sub.example.com"
        );
        assert!(host("not a url").is_none());
    }
}
