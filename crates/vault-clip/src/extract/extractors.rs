//! The site extractors cheap enough to port: Wikipedia, Substack posts and
//! Medium. Each only picks the content root and a few variables; the normal
//! pipeline does the rest (`contentSelector` extractors in Defuddle terms).

use super::util::{collapse_ws, js_prefix, regex, sel, DomExt};
use crate::html::Document;
use crate::value::Value;

pub struct Extraction {
    pub content_selector: String,
    pub title: String,
    pub author: String,
    pub published: String,
    pub site: String,
    pub description: String,
}

fn og(doc: &Document, prop: &str) -> String {
    for m in doc.by_tag(0, "meta") {
        if doc.get(m, "property") == prop {
            return doc.get(m, "content").to_string();
        }
    }
    String::new()
}

/// Run the matching extractor, if any. May mutate the page (Substack injects
/// the preloaded post body, Medium strips its UI chrome), as Defuddle does.
pub fn run(doc: &mut Document, url: &str, schema: &[Value]) -> Option<Extraction> {
    let parsed = super::urlutil::parse(url)?;
    let host = parsed.host.as_str();
    if host.contains("medium.com") || regex!(r"\.medium\.com").is_match(url) {
        if let Some(e) = medium(doc, schema) {
            return Some(e);
        }
    }
    if host.contains("substack.com") {
        if let Some(e) = substack(doc) {
            return Some(e);
        }
    }
    if host.contains("wikipedia.org") && doc.qs(0, sel!("#mw-content-text")).is_some() {
        let og_title = og(doc, "og:title");
        let t = regex!(r"\s*[-–—]\s*Wikipedia\s*$").replace(&og_title, "").into_owned();
        return Some(Extraction {
            content_selector: "#mw-content-text".into(),
            title: if t.is_empty() { og_title } else { t },
            author: "Wikipedia".into(),
            site: "Wikipedia".into(),
            published: String::new(),
            description: String::new(),
        });
    }
    None
}

struct PostData {
    title: String,
    subtitle: String,
    body_html: String,
    post_date: String,
    author: String,
}

fn substack_preload(doc: &Document) -> Option<PostData> {
    for s in doc.by_tag(0, "script") {
        let text = doc.tc(s);
        if !text.contains("window._preloads") || !text.contains("body_html") {
            continue;
        }
        let Some(idx) = text.find("JSON.parse(\"") else { continue };
        let start = idx + "JSON.parse(\"".len();
        let b = text.as_bytes();
        let mut i = start;
        while i < b.len() {
            match b[i] {
                b'\\' => i += 2,
                b'"' => break,
                _ => i += 1,
            }
        }
        let inner = &text[start..i.min(b.len())];
        let Some(Value::String(json)) = Value::parse_json(&format!("\"{inner}\"")) else { continue };
        let Some(data) = Value::parse_json(&json) else { continue };
        let post = get_path(&data, &["feedData", "initialPost", "post"]);
        let Some(Value::Object(p)) = post else { continue };
        let s = |k: &str| p.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        if s("body_html").is_empty() {
            continue;
        }
        let author = match p.get("publishedBylines") {
            Some(Value::Array(a)) => a.first().and_then(|v| match v {
                Value::Object(o) => o.get("name").and_then(|n| n.as_str()).map(str::to_string),
                _ => None,
            }),
            _ => None,
        }
        .unwrap_or_default();
        return Some(PostData { title: s("title"), subtitle: s("subtitle"), body_html: s("body_html"), post_date: s("post_date"), author });
    }
    None
}

fn get_path<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for p in path {
        match cur {
            Value::Object(m) => cur = m.get(p)?,
            _ => return None,
        }
    }
    Some(cur)
}

fn substack(doc: &mut Document) -> Option<Extraction> {
    let data = substack_preload(doc);
    let selector = if doc.qs(0, sel!("div.body.markup")).is_some() {
        "div.body.markup".to_string()
    } else if let Some(d) = data.as_ref().filter(|d| !d.body_html.is_empty()) {
        if doc.qs(0, sel!("[data-defuddle-substack-post]")).is_none() {
            let body = doc.find_tag(0, "body").unwrap_or(0);
            let wrapper = doc.create_element("div");
            doc.set_attr(wrapper, "data-defuddle-substack-post", "");
            doc.append_html(wrapper, &d.body_html);
            doc.append(body, wrapper);
        }
        "[data-defuddle-substack-post]".to_string()
    } else {
        return None;
    };
    let d = data.unwrap_or(PostData { title: String::new(), subtitle: String::new(), body_html: String::new(), post_date: String::new(), author: String::new() });
    let title = if d.title.is_empty() { og(doc, "og:title") } else { d.title };
    let description = if d.subtitle.is_empty() { og(doc, "og:description") } else { d.subtitle };
    let mut author = d.author;
    if author.is_empty() {
        author = doc.qs(0, sel!("a[href*=\"substack.com/@\"]")).map(|a| doc.trimmed_text(a)).unwrap_or_default();
    }
    let mut published = d.post_date;
    if published.is_empty() {
        if let Some(b) = doc.qs(0, sel!("[class*=\"byline-wrapper\"]")) {
            let text = regex!(r"([a-z])([A-Z])").replace_all(&doc.trimmed_text(b), "$1 $2").into_owned();
            if let Some(c) = regex!(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b").captures(&text) {
                let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                let m = months.iter().position(|x| *x == &c[1]).unwrap_or(0) + 1;
                published = format!("{}-{:02}-{:0>2}T00:00:00+00:00", &c[3], m, &c[2]);
            }
        }
    }
    Some(Extraction { content_selector: selector, title, author, published, site: "Substack".into(), description })
}

fn medium(doc: &mut Document, schema: &[Value]) -> Option<Extraction> {
    let article = doc.qs(0, sel!("article.meteredContent")).or_else(|| doc.qs(0, sel!("article")))?;
    let ok = doc.has_class(article, "meteredContent") || og(doc, "og:site_name") == "Medium" || og(doc, "al:android:app_name") == "Medium";
    if !ok {
        return None;
    }
    let title = match doc.qs(0, sel!("[data-testid=\"storyTitle\"]")) {
        Some(t) => doc.trimmed_text(t),
        None => doc.qs(article, sel!("h1")).map(|h| doc.trimmed_text(h)).unwrap_or_default(),
    };
    let subtitle = doc.qs(0, sel!(".pw-subtitle-paragraph")).map(|s| doc.trimmed_text(s)).unwrap_or_default();
    let author = doc.qs(0, sel!("[data-testid=\"authorName\"]")).map(|s| doc.trimmed_text(s)).unwrap_or_default();
    let mut publication = og(doc, "og:site_name");
    if publication == "Medium" {
        publication.clear();
    }
    if publication.is_empty() {
        for s in schema {
            if let Some(Value::String(n)) = get_path(s, &["publisher", "name"]) {
                if !n.is_empty() {
                    publication = n.clone();
                    break;
                }
            }
        }
    }

    // cleanArticle
    for btn in doc.qsa(article, sel!("figure [role=\"button\"]")) {
        let kids = doc.children(btn).to_vec();
        doc.replace_with_nodes(btn, &kids);
    }
    for el in doc.qsa(article, sel!("[role=\"tooltip\"]")) {
        doc.remove_attr(el, "role");
    }
    for link in doc.qsa(article, sel!("a[href*=\"medium.com/plans\"]")) {
        match doc.closest_tags(link, &["div"]) {
            Some(w) if w != article => doc.remove(w),
            _ => doc.remove(link),
        }
    }
    for el in doc.qsa(article, sel!("[data-testid=\"post-preview\"], [data-testid*=\"Clap\"], [data-testid*=\"Bookmark\"], [data-testid*=\"Share\"], [data-testid*=\"Response\"], [data-testid=\"authorPhoto\"], [data-testid=\"authorName\"], [data-testid=\"storyReadTime\"]")) {
        doc.remove(el);
    }
    const UI: &[&str] = &["Member-only story", "Listen", "Share", "Top highlight", "·", "Press enter or click to view image in full size"];
    for el in doc.qsa(article, sel!("p, span, div")) {
        let text = doc.trimmed_text(el);
        if text.is_empty() {
            continue;
        }
        if UI.contains(&text.as_str())
            || (regex!(r"^\w{3}\s+\d{1,2},\s+\d{4}").is_match(&text) && text.chars().count() < 30)
            || regex!(r"^·\s*\d+\s*\w+\s*ago$").is_match(&text)
            || regex!(r"^·?\s*\d+\s*min\s*read$").is_match(&text)
        {
            doc.remove(el);
        }
    }
    let description = if !subtitle.is_empty() {
        subtitle
    } else {
        let mut d = String::new();
        for p in doc.by_tag(article, "p") {
            let text = doc.trimmed_text(p);
            if text.chars().count() < 3 || regex!(r"^[\d\W]+$").is_match(&text) {
                continue;
            }
            d = collapse_ws(js_prefix(&text, 140));
            break;
        }
        d
    };
    Some(Extraction {
        content_selector: "article".into(),
        title,
        author,
        published: String::new(),
        site: if publication.is_empty() { "Medium".into() } else { publication },
        description,
    })
}
