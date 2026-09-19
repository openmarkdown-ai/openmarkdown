//! Defuddle's `metadata.ts`: title, author, dates, site name, description,
//! image, favicon and language from meta tags, schema.org JSON-LD and the DOM.

use super::urlutil;
use super::util::{
    collapse_ws, count_words, js_trim, regex, sel, utf16_len, visible_text, DomExt,
};
use crate::html::{Document, NodeId};
use crate::template::MetaTag;
use crate::value::Value;

#[derive(Debug, Clone, Default)]
pub struct Metadata {
    pub title: String,
    pub description: String,
    pub domain: String,
    pub favicon: String,
    pub image: String,
    pub language: String,
    pub published: String,
    pub author: String,
    pub site: String,
}

pub fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn extract(doc: &Document, page_url: &str, schema: &[Value], meta: &[MetaTag]) -> Metadata {
    // A browser document has `location.href`; linkedom's does not, so the
    // oracle falls through to og:url. We have the real URL, so use it first.
    let mut url = String::new();
    if urlutil::parse(page_url).is_some_and(|p| p.special) {
        url = page_url.to_string();
    }
    if url.is_empty() {
        url = first_nonempty(&[
            meta_content(meta, "property", "og:url"),
            meta_content(meta, "property", "twitter:url"),
            schema_property(schema, "url"),
            schema_property(schema, "mainEntityOfPage.url"),
            schema_property(schema, "mainEntity.url"),
            schema_property(schema, "WebSite.url"),
            doc.qs(0, sel!("link[rel=\"canonical\"]"))
                .map(|l| doc.get(l, "href").to_string())
                .unwrap_or_default(),
        ]);
    }
    let mut domain = String::new();
    if let Some(p) = urlutil::parse(&url) {
        if p.special {
            domain = p.host.strip_prefix("www.").unwrap_or(&p.host).to_string();
        }
    }

    let site_name = get_site_name(schema, meta);
    let best = get_best_title(doc, schema, meta, &domain, &site_name);
    let (title, detected_site) = clean_title(&best, &site_name);
    let author = get_author(doc, schema, meta);
    let author_as_site = if !author.is_empty() && !author.contains(',') { author.clone() } else { String::new() };
    let site = first_nonempty(&[site_name, detected_site, author_as_site, domain.clone()]);

    Metadata {
        title,
        description: get_description(schema, meta),
        favicon: get_favicon(doc, &url, meta),
        image: get_image(schema, meta),
        language: get_language(doc, schema, meta),
        published: get_published(doc, schema, meta, &url),
        author,
        site,
        domain,
    }
}

fn first_nonempty(v: &[String]) -> String {
    v.iter().find(|s| !s.is_empty()).cloned().unwrap_or_default()
}

pub fn is_placeholder(s: &str) -> bool {
    if s.contains('{') || s.contains('}') {
        return true;
    }
    let mut chars = s.chars();
    if chars.next() == Some('#') && chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return true;
    }
    !s.chars().any(|c| c.is_alphanumeric())
}

fn first_valid(thunks: &[&dyn Fn() -> String]) -> String {
    for t in thunks {
        let v = t();
        if !v.is_empty() && !is_placeholder(&v) {
            return v;
        }
    }
    String::new()
}

pub fn meta_contents(meta: &[MetaTag], attr: &str, value: &str) -> Vec<String> {
    let value = value.to_lowercase();
    meta.iter()
        .filter(|t| {
            let a = if attr == "name" { &t.name } else { &t.property };
            a.as_ref().is_some_and(|v| v.to_lowercase() == value)
        })
        .map(|t| js_trim(t.content.as_deref().unwrap_or("")).to_string())
        .collect()
}

pub fn meta_content(meta: &[MetaTag], attr: &str, value: &str) -> String {
    meta_contents(meta, attr, value).into_iter().next().unwrap_or_default()
}

fn get_author(doc: &Document, schema: &[Value], meta: &[MetaTag]) -> String {
    let s = first_valid(&[
        &|| meta_content(meta, "name", "sailthru.author"),
        &|| meta_content(meta, "property", "article:author"),
        &|| meta_content(meta, "property", "author"),
        &|| meta_content(meta, "name", "author"),
        &|| meta_content(meta, "name", "byl"),
        &|| meta_content(meta, "name", "authorList"),
    ]);
    if !s.is_empty() {
        let cleaned = clean_author_string(&s);
        if !cleaned.is_empty() {
            return cleaned;
        }
    }

    let mut list: Vec<String> =
        meta_contents(meta, "name", "citation_author").into_iter().filter(|s| !is_placeholder(s)).collect();
    if list.is_empty() {
        list = meta_contents(meta, "property", "dc.creator").into_iter().filter(|s| !is_placeholder(s)).collect();
    }
    if !list.is_empty() {
        return list
            .iter()
            .map(|s| {
                if !s.contains(',') {
                    return js_trim(s).to_string();
                }
                if let Some(c) = regex!(r"(.*),\s(.*)").captures(s) {
                    return format!("{} {}", &c[2], &c[1]);
                }
                js_trim(s).to_string()
            })
            .collect::<Vec<_>>()
            .join(", ");
    }

    let mut schema_authors = schema_property(schema, "author.name");
    if schema_authors.is_empty() {
        schema_authors = schema_property(schema, "author.[].name");
    }
    if !schema_authors.is_empty() {
        let mut uniq: Vec<String> = Vec::new();
        for part in schema_authors.split(',') {
            let p = js_trim(js_trim(part).trim_end_matches(','));
            if !p.is_empty() && !is_placeholder(p) && !uniq.iter().any(|u| u == p) {
                uniq.push(p.to_string());
            }
        }
        if !uniq.is_empty() {
            uniq.truncate(10);
            return uniq.join(", ");
        }
    }

    let rel = doc.qsa(0, sel!("a[rel~=\"author\"], address[rel~=\"author\"]"));
    if !rel.is_empty() && rel.len() <= 3 {
        let mut names: Vec<String> = Vec::new();
        for el in rel {
            let text = js_trim(&collapse_ws(&visible_text(doc, el))).to_string();
            let lower = text.to_lowercase();
            if !text.is_empty() && utf16_len(&text) < 100 && lower != "author" && lower != "authors"
                && !is_placeholder(&text) && !names.contains(&text)
            {
                names.push(text);
            }
        }
        if !names.is_empty() {
            return names.join(", ");
        }
    }

    let mut collected: Vec<String> = Vec::new();
    let selectors: [(&crate::selector::SelectorList, Option<usize>); 4] = [
        (sel!("[itemprop=\"author\"]"), None),
        (sel!(".author"), Some(3)),
        (sel!("[href*=\"/author/\"]"), Some(3)),
        (sel!(".authors a"), Some(3)),
    ];
    for (s, max) in selectors {
        let matches = doc.qsa(0, s);
        if max.is_some_and(|m| matches.len() > m) {
            continue;
        }
        for el in matches {
            let value = author_name(doc, el);
            for part in value.split(',') {
                let name = js_trim(js_trim(&collapse_ws(part)).trim_end_matches(',')).to_string();
                let lower = name.to_lowercase();
                if !name.is_empty() && lower != "author" && lower != "authors" && !is_placeholder(&name) {
                    collected.push(name);
                }
            }
        }
    }
    if !collected.is_empty() {
        let mut uniq: Vec<String> = Vec::new();
        for n in collected {
            let n = js_trim(&n).to_string();
            if !n.is_empty() && !uniq.contains(&n) {
                uniq.push(n);
            }
        }
        if uniq.len() > 1 {
            let snapshot = uniq.clone();
            uniq.retain(|a| !snapshot.iter().any(|b| b != a && a.contains(b.as_str())));
        }
        if !uniq.is_empty() {
            uniq.truncate(10);
            return uniq.join(", ");
        }
    }

    if let Some(h1) = doc.qs(0, sel!("h1")) {
        let mut sibling = doc.next_element_sibling(h1);
        let mut i = 0;
        while let (true, Some(sib)) = (i < 3, sibling) {
            let sib_text = doc.trimmed_text(sib);
            let child_els = doc.qsa(sib, sel!("p, time"));
            let has_date_child = child_els.iter().any(|e| !parse_date_text(&doc.trimmed_text(*e)).is_empty());
            let has_sibling_date = !parse_date_text(&sib_text).is_empty() || has_date_child;
            if has_sibling_date {
                let links = doc.by_tag(sib, "a");
                if links.len() == 1 {
                    let lt = doc.trimmed_text(links[0]).replace('\u{a0}', " ");
                    if !lt.is_empty() && utf16_len(&lt) < 100 && parse_date_text(&lt).is_empty() {
                        return lt;
                    }
                }
                if has_date_child && utf16_len(&sib_text) < 300 {
                    for p in &child_els {
                        if doc.tag(*p) != Some("p") {
                            continue;
                        }
                        let pt = doc.trimmed_text(*p).replace('\u{a0}', " ");
                        if !pt.is_empty() && utf16_len(&pt) < 150 && parse_date_text(&pt).is_empty() {
                            return pt;
                        }
                    }
                }
            }
            sibling = doc.next_element_sibling(sib);
            i += 1;
        }

        let mut scope = Some(h1);
        for _ in 0..3 {
            let Some(sc) = scope else { break };
            let mut cand = doc.prev_element_sibling(sc);
            for _ in 0..3 {
                let Some(c) = cand else { break };
                if let Some(b) = extract_byline(doc, c) {
                    return b;
                }
                cand = doc.prev_element_sibling(c);
            }
            let mut cand = doc.next_element_sibling(sc);
            for _ in 0..3 {
                let Some(c) = cand else { break };
                if let Some(b) = extract_byline(doc, c) {
                    return b;
                }
                cand = doc.next_element_sibling(c);
            }
            scope = doc.parent_element(sc);
        }
    }
    String::new()
}

fn extract_byline(doc: &Document, el: NodeId) -> Option<String> {
    let mut candidates = vec![el];
    candidates.extend(doc.qsa(el, sel!("p, span, address")));
    for c in candidates {
        let text = doc.trimmed_text(c).replace('\u{a0}', " ");
        let len = utf16_len(&text);
        if len > 0 && len < 50 {
            if let Some(m) = regex!(r"(?i)^By\s+([A-Z].+)$").captures(&text) {
                return Some(js_trim(&m[1]).to_string());
            }
        }
    }
    None
}

fn clean_author_string(s: &str) -> String {
    let s = regex!(r"(?i)^by\s+").replace(s, "");
    let s = regex!(r"(?i)\(?\s*https?://\S+\s*\)?").replace_all(&s, "");
    let s = regex!(r"(?i),?\s+and\s+").replace_all(&s, ", ");
    let s = regex!(r"\s*[-–—|]\s*$").replace_all(&s, "");
    js_trim(&s).to_string()
}

fn get_site_name(schema: &[Value], meta: &[MetaTag]) -> String {
    let c = first_valid(&[
        &|| schema_property(schema, "publisher.name"),
        &|| meta_content(meta, "property", "og:site_name"),
        &|| meta_content(meta, "name", "og:site_name"),
        &|| schema_property(schema, "WebSite.name"),
        &|| schema_property(schema, "sourceOrganization.name"),
        &|| meta_content(meta, "name", "copyright"),
        &|| schema_property(schema, "copyrightHolder.name"),
        &|| schema_property(schema, "isPartOf.name"),
        &|| meta_content(meta, "name", "application-name"),
    ]);
    if !c.is_empty() && count_words(&c) > 6 {
        return String::new();
    }
    c
}

fn get_best_title(doc: &Document, schema: &[Value], meta: &[MetaTag], domain: &str, site: &str) -> String {
    let candidates: Vec<String> = [
        meta_content(meta, "property", "og:title"),
        meta_content(meta, "name", "twitter:title"),
        schema_property(schema, "headline"),
        meta_content(meta, "name", "title"),
        meta_content(meta, "name", "sailthru.title"),
        doc.qs(0, sel!("title")).map(|t| doc.trimmed_text(t)).unwrap_or_default(),
        doc.qs(0, sel!("h1")).map(|t| doc.trimmed_text(t)).unwrap_or_default(),
    ]
    .into_iter()
    .filter(|c| !c.is_empty() && !is_placeholder(c))
    .collect();
    if candidates.is_empty() {
        return String::new();
    }
    let mut author_meta = meta_content(meta, "property", "author");
    if author_meta.is_empty() {
        author_meta = meta_content(meta, "name", "author");
    }
    let author_norm = js_trim(&author_meta).to_lowercase();
    let site_norm = js_trim(site).to_lowercase();
    let domain_norm: String = if domain.is_empty() {
        String::new()
    } else {
        let d = match domain.rfind('.') {
            Some(i) if i + 1 < domain.len() => &domain[..i],
            _ => domain,
        };
        d.to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
    };
    for c in &candidates {
        let norm = js_trim(c).to_lowercase();
        if !author_norm.is_empty() && norm == author_norm {
            continue;
        }
        if !site_norm.is_empty() && norm == site_norm {
            continue;
        }
        if !domain_norm.is_empty() {
            let cn: String = norm.chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect();
            if cn == domain_norm {
                continue;
            }
        }
        return c.clone();
    }
    candidates[0].clone()
}

const SEPARATORS: &str = r"[|\-–—/·]";

pub fn clean_title(title: &str, site_name: &str) -> (String, String) {
    if title.is_empty() {
        return (String::new(), String::new());
    }
    if !site_name.is_empty() && site_name.to_lowercase() != title.to_lowercase() && count_words(site_name) <= 6 {
        let site_lower = site_name.to_lowercase();
        let esc = escape_regex(site_name);
        for pat in [
            format!(r"(?i)\s*{SEPARATORS}\s*{esc}\s*$"),
            format!(r"(?i)^\s*{esc}\s*{SEPARATORS}\s*"),
        ] {
            let r = super::util::re(&pat);
            if r.is_match(title) {
                return (js_trim(&r.replace(title, "")).to_string(), site_name.to_string());
            }
        }
        let all: Vec<(usize, usize)> = regex!(r"\s+[|\-–—/·]\s+")
            .find_iter(title)
            .map(|m| (m.start(), m.end()))
            .collect();
        if let (Some(&last), Some(&first)) = (all.last(), all.first()) {
            let last_seg = js_trim(&title[last.1..]).to_lowercase();
            if !last_seg.is_empty() && site_lower.contains(&last_seg) {
                let mut cut = last.0;
                for i in (0..all.len().saturating_sub(1)).rev() {
                    let pos = all[i];
                    let seg = js_trim(&title[pos.1..cut]);
                    if count_words(seg) > 3 {
                        break;
                    }
                    cut = pos.0;
                }
                return (js_trim(&title[..cut]).to_string(), site_name.to_string());
            }
            let prefix = js_trim(&title[..first.0]).to_lowercase();
            if !prefix.is_empty() && site_lower.contains(&prefix) {
                let mut cut = first.1;
                for pos in all.iter().skip(1) {
                    let seg = js_trim(&title[cut..pos.0]);
                    if count_words(seg) > 3 {
                        break;
                    }
                    cut = pos.1;
                }
                return (js_trim(&title[cut..]).to_string(), site_name.to_string());
            }
        }
    }
    if let Some(r) = try_separator_split(title, regex!(r"\s+([|/·])\s+"), false, |t, s| s <= 3 && t >= 2 && t >= s * 2) {
        return r;
    }
    if let Some(r) = try_separator_split(title, regex!(r"\s+[-–—]\s+"), true, |t, s| s <= 2 && t >= 2 && t > s) {
        return r;
    }
    (js_trim(title).to_string(), String::new())
}

fn try_separator_split(
    title: &str,
    re: &regex_lite::Regex,
    suffix_only: bool,
    guard: impl Fn(usize, usize) -> bool,
) -> Option<(String, String)> {
    let pos: Vec<(usize, usize)> = re.find_iter(title).map(|m| (m.start(), m.end())).collect();
    let (&first, &last) = (pos.first()?, pos.last()?);
    let st = js_trim(&title[..last.0]);
    let ss = js_trim(&title[last.1..]);
    if guard(count_words(st), count_words(ss)) {
        return Some((st.to_string(), ss.to_string()));
    }
    if !suffix_only {
        let ps = js_trim(&title[..first.0]);
        let pt = js_trim(&title[first.1..]);
        if guard(count_words(pt), count_words(ps)) {
            return Some((pt.to_string(), ps.to_string()));
        }
    }
    None
}

fn get_description(schema: &[Value], meta: &[MetaTag]) -> String {
    first_valid(&[
        &|| meta_content(meta, "name", "description"),
        &|| meta_content(meta, "property", "description"),
        &|| meta_content(meta, "property", "og:description"),
        &|| schema_property(schema, "description"),
        &|| meta_content(meta, "name", "twitter:description"),
        &|| meta_content(meta, "name", "sailthru.description"),
    ])
}

fn get_image(schema: &[Value], meta: &[MetaTag]) -> String {
    first_nonempty(&[
        meta_content(meta, "property", "og:image"),
        meta_content(meta, "name", "twitter:image"),
        schema_property(schema, "image.url"),
        meta_content(meta, "name", "sailthru.image.full"),
    ])
}

fn get_language(doc: &Document, schema: &[Value], meta: &[MetaTag]) -> String {
    let norm = |s: &str| s.replace('_', "-");
    let html = doc.children(0).iter().copied().find(|c| doc.is_element(*c));
    if let Some(h) = html {
        let lang = js_trim(doc.get(h, "lang"));
        if !lang.is_empty() {
            return norm(lang);
        }
    }
    let mut cl = meta_content(meta, "name", "content-language");
    if cl.is_empty() {
        cl = meta_content(meta, "property", "og:locale");
    }
    if !cl.is_empty() {
        return norm(&cl);
    }
    if let Some(m) = doc.qs(0, sel!("meta[http-equiv=\"Content-Language\" i]")) {
        let c = js_trim(doc.get(m, "content"));
        if !c.is_empty() {
            return norm(c);
        }
    }
    let s = schema_property(schema, "inLanguage");
    if !s.is_empty() {
        return norm(&s);
    }
    String::new()
}

fn get_favicon(doc: &Document, base: &str, meta: &[MetaTag]) -> String {
    let m = meta_content(meta, "property", "og:image:favicon");
    if !m.is_empty() {
        return m;
    }
    if let Some(l) = doc.qs(0, sel!("link[rel='icon']")) {
        if !doc.get(l, "href").is_empty() {
            return doc.get(l, "href").to_string();
        }
    }
    if let Some(l) = doc.qs(0, sel!("link[rel='shortcut icon']")) {
        if !doc.get(l, "href").is_empty() {
            return doc.get(l, "href").to_string();
        }
    }
    if base.starts_with("http://") || base.starts_with("https://") {
        if let Some(u) = urlutil::join(base, "/favicon.ico") {
            return u.href();
        }
    }
    String::new()
}

fn get_published(doc: &Document, schema: &[Value], meta: &[MetaTag], url: &str) -> String {
    let r = first_valid(&[
        &|| schema_property(schema, "datePublished"),
        &|| meta_content(meta, "name", "publishDate"),
        &|| meta_content(meta, "property", "article:published_time"),
        &|| {
            doc.qs(0, sel!("abbr[itemprop=\"datePublished\"]"))
                .map(|a| js_trim(doc.get(a, "title")).to_string())
                .unwrap_or_default()
        },
        &|| time_element(doc, url),
        &|| meta_content(meta, "name", "sailthru.date"),
    ]);
    if !r.is_empty() {
        return r;
    }
    if let Some(h1) = doc.qs(0, sel!("h1")) {
        let scan = |start: Option<NodeId>, forward: bool, children_only: bool| -> String {
            let mut sib = start;
            for _ in 0..3 {
                let Some(s) = sib else { break };
                for child in doc.qsa(s, sel!("p, time")) {
                    let p = parse_date_text(&doc.trimmed_text(child));
                    if !p.is_empty() {
                        return p;
                    }
                }
                if !children_only {
                    let p = parse_date_text(&doc.trimmed_text(s));
                    if !p.is_empty() {
                        return p;
                    }
                }
                sib = if forward { doc.next_element_sibling(s) } else { doc.prev_element_sibling(s) };
            }
            String::new()
        };
        let found = first_valid(&[
            &|| scan(doc.next_element_sibling(h1), true, false),
            &|| scan(doc.prev_element_sibling(h1), false, true),
        ]);
        if !found.is_empty() {
            return found;
        }
    }
    String::new()
}

fn time_element(doc: &Document, url: &str) -> String {
    for t in doc.by_tag(0, "time") {
        if linked_to_other_page(doc, t, url) {
            continue;
        }
        let mut c = js_trim(doc.get(t, "datetime")).to_string();
        if c.is_empty() {
            c = doc.trimmed_text(t);
        }
        if !c.is_empty() {
            return c;
        }
    }
    String::new()
}

fn linked_to_other_page(doc: &Document, el: NodeId, page: &str) -> bool {
    if page.is_empty() {
        return false;
    }
    let Some(a) = doc.closest_sel(el, sel!("a[href]")) else { return false };
    let href = js_trim(doc.get(a, "href"));
    if href.is_empty() || href.starts_with('#') {
        return false;
    }
    let (Some(target), Some(current)) = (urlutil::join(page, href), urlutil::parse(page)) else {
        return false;
    };
    if target.origin() != current.origin() {
        return false;
    }
    target.path.trim_end_matches('/') != current.path.trim_end_matches('/')
}

const MONTHS: &[&str] = &[
    "january", "february", "march", "april", "may", "june", "july", "august", "september",
    "october", "november", "december",
];

pub fn parse_date_text(text: &str) -> String {
    let month_num = |m: &str| {
        let i = MONTHS.iter().position(|x| *x == m.to_lowercase()).unwrap_or(0);
        format!("{:02}", i + 1)
    };
    if let Some(c) = regex!(r"(?i)\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b").captures(text) {
        return format!("{}-{}-{:0>2}T00:00:00+00:00", &c[3], month_num(&c[2]), &c[1]);
    }
    if let Some(c) = regex!(r"(?i)\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b").captures(text) {
        return format!("{}-{}-{:0>2}T00:00:00+00:00", &c[3], month_num(&c[1]), &c[2]);
    }
    String::new()
}

fn author_name(doc: &Document, el: NodeId) -> String {
    let text = js_trim(&collapse_ws(&visible_text(doc, el))).to_string();
    if text.is_empty() {
        return String::new();
    }
    for child in doc.qsa(el, sel!("span, a, p")) {
        let ct = js_trim(&collapse_ws(&visible_text(doc, child))).to_string();
        let len = utf16_len(&ct);
        if (2..=50).contains(&len) && ct != text {
            return ct;
        }
    }
    if utf16_len(&text) <= 100 {
        text
    } else {
        String::new()
    }
}

// ---- schema.org property search -------------------------------------------

fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Array(_) => true,
        other => other.truthy(),
    }
}

fn search_items(items: &[Value], props: &[&str], exact: bool) -> Vec<String> {
    if let Some(p) = props.first() {
        if p.len() > 2 && p.starts_with('[') && p.ends_with(']') && p[1..p.len() - 1].bytes().all(|b| b.is_ascii_digit()) {
            let idx: usize = p[1..p.len() - 1].parse().unwrap_or(usize::MAX);
            return match items.get(idx) {
                Some(v) if js_truthy(v) => search_schema(v, &props[1..], exact),
                _ => vec![],
            };
        }
    }
    if props.is_empty() && items.iter().all(|i| matches!(i, Value::String(_) | Value::Number(_))) {
        return items.iter().map(|i| i.js_string()).collect();
    }
    items.iter().flat_map(|i| search_schema(i, props, exact)).collect()
}

fn search_schema(data: &Value, props: &[&str], exact: bool) -> Vec<String> {
    match data {
        Value::String(s) => {
            if props.is_empty() {
                vec![s.clone()]
            } else {
                vec![]
            }
        }
        Value::Array(items) => search_items(items, props, exact),
        Value::Object(map) => {
            let Some(cur) = props.first() else {
                return match map.get("name") {
                    Some(n) if js_truthy(n) => vec![n.js_string()],
                    _ => vec![],
                };
            };
            if let Some(v) = map.get(cur) {
                return search_schema(v, &props[1..], true);
            }
            if !exact {
                let mut nested = Vec::new();
                for (_, v) in map.iter() {
                    if matches!(v, Value::Object(_) | Value::Array(_) | Value::Null) {
                        nested.extend(search_schema(v, props, false));
                    }
                }
                if !nested.is_empty() {
                    return nested;
                }
            }
            vec![]
        }
        _ => vec![],
    }
}

/// Defuddle's `getSchemaProperty`: dotted path, exact first then a nested
/// search, unique non-empty results joined with ", ".
pub fn schema_property(schema: &[Value], property: &str) -> String {
    if schema.is_empty() {
        return String::new();
    }
    let props: Vec<&str> = property.split('.').collect();
    let mut results = search_items(schema, &props, true);
    if results.is_empty() {
        results = search_items(schema, &props, false);
    }
    let mut uniq: Vec<String> = Vec::new();
    for r in results {
        if !r.is_empty() && !uniq.contains(&r) {
            uniq.push(r);
        }
    }
    uniq.join(", ")
}
