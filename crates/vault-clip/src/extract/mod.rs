//! Main-content extraction and HTML standardisation: a port of
//! [Defuddle](https://github.com/kepano/defuddle) 0.19.3 (MIT, © Steph Ango),
//! the extractor behind Obsidian Web Clipper.
//!
//! The pipeline follows `defuddle.ts` step for step: schema.org and meta tags,
//! metadata, site extractors, entry-point scoring to pick the content root,
//! footnote/callout standardisation, small-image, hidden-element, selector,
//! low-score and content-pattern clutter removal, `standardizeContent`, URL
//! resolution, image de-duplication and sanitisation — including the
//! low-word-count retries and the schema.org `articleBody` fallback. The
//! output conventions (`sup#fnref:N`, `div#footnotes`, `pre > code.language-x`,
//! `math[data-latex]`, callout divs) are the ones Defuddle's Markdown
//! converter, and ours, depend on.
//!
//! Deliberate departures, all because this runs without a browser:
//! - **No layout.** Defuddle in a browser also evaluates `max-width` media
//!   queries and `getComputedStyle`; like Defuddle under linkedom, only inline
//!   styles and class names are consulted.
//! - **`document.location` is the given URL**, as in the browser. (Under
//!   linkedom Defuddle falls back to og:url, and returns an empty `domain` and
//!   `favicon` when there is none.)
//! - **Math conversion libraries are not ported** (see [`math`]).
//! - **Only the Wikipedia, Substack and Medium extractors** are ported; other
//!   sites go through the generic pipeline.
//! - Retries that Defuddle expresses as a CSS selector built from an element
//!   (hidden-content and schema.org retries) target the element itself.
//! - Where linkedom and a browser disagree, this follows the browser: `<noscript>`
//!   is raw text, attribute names are case-insensitive (`CONTENT=`, SVG
//!   `viewBox`), entities inside JSON-LD strings are decoded, and `<table>`
//!   gets its implied `<tbody>` (from [`crate::html`]).
//! - `standardize_fragment` additionally reads GitHub's `highlight-source-x`
//!   classes for code-block languages; full extraction does not, as Defuddle.
//!
//! Verified against Defuddle 0.19.3 on 25 saved real pages (content HTML
//! token-identical apart from the points above) and 56 rule fixtures in
//! `testdata/oracle_cases.json`.

mod code;
mod constants;
mod content_patterns;
mod extractors;
mod footnotes;
mod headings;
mod images;
mod math;
mod metadata;
mod removals;
mod standardize;
mod urlutil;
mod util;

#[cfg(test)]
mod tests;

use std::collections::HashSet;

use crate::html::{Document, NodeData, NodeId};
use crate::template::MetaTag;
use crate::value::Value;
use constants::*;
use metadata::Metadata;
use util::{count_words, js_trim, regex, sel, utf16_len, DomExt};

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extracted {
    pub title: String,
    pub author: String,
    pub published: String,
    pub description: String,
    pub image: String,
    pub favicon: String,
    pub site: String,
    pub domain: String,
    pub language: String,
    /// Cleaned, standardised main content (Defuddle `content`).
    pub content_html: String,
    /// Defuddle `wordCount`.
    pub word_count: usize,
    pub meta_tags: Vec<MetaTag>,
    /// Parsed JSON-LD objects, `@graph` arrays flattened.
    pub schema_org_data: Vec<Value>,
    /// Extractor-provided extra variables, if any.
    pub variables: Vec<(String, String)>,
}

/// Extract the main content and metadata of a page.
pub fn extract(html: &str, url: &str) -> Extracted {
    let mut doc = Document::parse(html);
    ensure_structure(&mut doc);
    let mut d = Defuddle::new(doc, url);
    d.parse()
}

/// Apply only the element standardisation passes (code blocks, footnotes,
/// math, callouts, lazy images, pictures, headings) and, with a base URL,
/// relative URL resolution — no clutter removal or content selection.
pub fn standardize_fragment(doc: &mut Document, root: NodeId, base_url: Option<&str>) {
    footnotes::standardize_footnotes(doc, root);
    headings::standardize_callouts(doc, root);
    let lib = math::page_has_math_library(doc);
    code::GITHUB_HIGHLIGHT_CLASSES.with(|f| f.set(true));
    standardize::standardize_elements_only(doc, root, lib);
    code::GITHUB_HIGHLIGHT_CLASSES.with(|f| f.set(false));
    if let Some(base) = base_url.filter(|b| !b.is_empty()) {
        resolve_relative_urls(doc, root, base);
    }
}

/// Give a parsed page the `html > head + body` skeleton an HTML5 parser
/// always builds, so "body" and "documentElement" exist for fragments too.
fn ensure_structure(doc: &mut Document) {
    if doc.find_tag(0, "body").is_some() {
        return;
    }
    let html = match doc.children(0).iter().copied().find(|c| doc.tag(*c) == Some("html")) {
        Some(h) => h,
        None => {
            let h = doc.create_element("html");
            for c in doc.children(0).to_vec() {
                doc.append(h, c);
            }
            doc.append(0, h);
            h
        }
    };
    let body = doc.create_element("body");
    for c in doc.children(html).to_vec() {
        if matches!(doc.tag(c), Some("head" | "title" | "meta" | "link" | "base")) {
            continue;
        }
        doc.append(body, c);
    }
    doc.append(html, body);
}

#[derive(Clone)]
struct Opts {
    remove_exact: bool,
    remove_partial: bool,
    remove_hidden: bool,
    remove_low_scoring: bool,
    remove_small_images: bool,
    remove_content_patterns: bool,
    standardize: bool,
    content_node: Option<NodeId>,
    content_selector: Option<String>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            remove_exact: true,
            remove_partial: true,
            remove_hidden: true,
            remove_low_scoring: true,
            remove_small_images: true,
            remove_content_patterns: true,
            standardize: true,
            content_node: None,
            content_selector: None,
        }
    }
}

struct Result {
    content: String,
    word_count: usize,
    meta: Metadata,
    variables: Vec<(String, String)>,
}

struct Defuddle {
    doc: Document,
    url: String,
    schema: Vec<Value>,
    meta_tags: Vec<MetaTag>,
    metadata: Option<Metadata>,
    small_images: Option<HashSet<String>>,
    in_extractor_run: bool,
    has_math_library: bool,
}

fn body_of(doc: &Document) -> NodeId {
    doc.find_tag(0, "body").unwrap_or(0)
}

pub(crate) fn count_html_words(content: &str) -> usize {
    let t = regex!(r"<[^>]*>").replace_all(content, " ");
    let t = regex!(r"(?i)&nbsp;").replace_all(&t, " ");
    let t = regex!(r"(?i)&amp;").replace_all(&t, "&");
    let t = regex!(r"(?i)&lt;").replace_all(&t, "<");
    let t = regex!(r"(?i)&gt;").replace_all(&t, ">");
    let t = regex!(r"(?i)&quot;").replace_all(&t, "\"");
    let t = regex!(r"&#\d+;").replace_all(&t, " ");
    let t = regex!(r"&\w+;").replace_all(&t, " ");
    count_words(&t)
}

impl Defuddle {
    fn new(doc: Document, url: &str) -> Defuddle {
        let schema = extract_schema_org(&doc);
        let meta_tags = collect_meta_tags(&doc);
        let has_math_library = math::page_has_math_library(&doc);
        Defuddle {
            doc,
            url: url.to_string(),
            schema,
            meta_tags,
            metadata: None,
            small_images: None,
            in_extractor_run: false,
            has_math_library,
        }
    }

    fn parse(&mut self) -> Extracted {
        let body = body_of(&self.doc);
        resolve_noscript_images(&mut self.doc, body);

        let mut result = self.parse_internal(Opts::default());
        if result.word_count < 200 {
            let retry = self.parse_internal(Opts { remove_partial: false, ..Opts::default() });
            if retry.word_count > result.word_count * 2 {
                result = retry;
            }
        }
        if result.word_count < 50 {
            let retry = self.parse_internal(Opts { remove_hidden: false, ..Opts::default() });
            if retry.word_count > result.word_count * 2 {
                result = retry;
            }
            if let Some(node) = self.largest_hidden_content() {
                let retry = self.parse_internal(Opts {
                    remove_hidden: false,
                    remove_partial: false,
                    content_node: Some(node),
                    ..Opts::default()
                });
                if retry.word_count > result.word_count
                    || (retry.word_count as f64 > (20f64).max(result.word_count as f64 * 0.7)
                        && utf16_len(&retry.content) < utf16_len(&result.content))
                {
                    result = retry;
                }
            }
        }
        if result.word_count < 50 {
            let retry = self.parse_internal(Opts {
                remove_low_scoring: false,
                remove_partial: false,
                remove_content_patterns: false,
                ..Opts::default()
            });
            if retry.word_count > result.word_count {
                result = retry;
            }
        }

        let schema_text = schema_text(&self.schema, 0);
        if !schema_text.is_empty() && count_html_words(&schema_text) as f64 > result.word_count as f64 * 1.5 {
            let mut safe = self.doc.clone();
            let sb = body_of(&safe);
            strip_unsafe_elements(&mut safe, sb);
            let live = std::mem::replace(&mut self.doc, safe);
            let body = body_of(&self.doc);
            match find_element_by_schema_text(&self.doc, body, &schema_text) {
                Some(best) => {
                    result = self.parse_internal(Opts { content_node: Some(best), ..Opts::default() });
                }
                None => {
                    let html = self.sanitize_html(&schema_text);
                    result.word_count = count_html_words(&html);
                    result.content = html;
                }
            }
            self.doc = live;
        }

        Extracted {
            title: result.meta.title,
            author: result.meta.author,
            published: result.meta.published,
            description: result.meta.description,
            image: result.meta.image,
            favicon: result.meta.favicon,
            site: result.meta.site,
            domain: result.meta.domain,
            language: result.meta.language,
            content_html: result.content,
            word_count: result.word_count,
            meta_tags: self.meta_tags.clone(),
            schema_org_data: self.schema.clone(),
            variables: result.variables,
        }
    }

    fn sanitize_html(&mut self, html: &str) -> String {
        let mut d = Document::new();
        let container = d.create_element("div");
        d.append(0, container);
        d.append_html(container, html);
        strip_unsafe_elements(&mut d, container);
        resolve_relative_urls_with_doc(&mut d, container, &self.url, None);
        d.inner_html(container)
    }

    fn largest_hidden_content(&self) -> Option<NodeId> {
        let body = body_of(&self.doc);
        let mut best = None;
        let mut best_words = 0;
        for el in self.doc.qsa(body, sel!(HIDDEN_EXACT_SKIP_SELECTOR)) {
            if self.doc.class_name(el).contains("math") {
                continue;
            }
            let w = count_words(&self.doc.tc(el));
            if w > best_words {
                best = Some(el);
                best_words = w;
            }
        }
        if best_words < 30 {
            None
        } else {
            best
        }
    }

    fn metadata(&mut self) -> Metadata {
        if self.metadata.is_none() {
            self.metadata = Some(metadata::extract(&self.doc, &self.url, &self.schema, &self.meta_tags));
        }
        self.metadata.clone().unwrap()
    }

    fn fallback_body(&self) -> String {
        let mut d = self.doc.clone();
        let body = body_of(&d);
        strip_unsafe_elements(&mut d, body);
        let base = base_href(&d, &self.url);
        resolve_relative_urls_with_doc(&mut d, body, &self.url, base.as_deref());
        d.inner_html(body)
    }

    fn parse_internal(&mut self, opts: Opts) -> Result {
        let mut meta = self.metadata();

        if !self.in_extractor_run {
            let url = self.url.clone();
            if let Some(ex) = extractors::run(&mut self.doc, &url, &self.schema) {
                self.in_extractor_run = true;
                let mut r = self.parse_internal(Opts {
                    content_selector: Some(ex.content_selector.clone()),
                    remove_low_scoring: false,
                    remove_hidden: false,
                    ..Opts::default()
                });
                self.in_extractor_run = false;
                for (field, v) in [
                    (&mut r.meta.title, ex.title),
                    (&mut r.meta.description, ex.description),
                    (&mut r.meta.author, ex.author),
                    (&mut r.meta.published, ex.published),
                    (&mut r.meta.site, ex.site),
                ] {
                    if !v.is_empty() {
                        *field = v;
                    }
                }
                return r;
            }
        }

        if self.small_images.is_none() {
            self.small_images = Some(removals::find_small_images(&self.doc));
        }

        let mut clone = self.doc.clone();
        let body = body_of(&clone);
        clone.normalize(body);
        resolve_streamed_content(&mut clone);

        let mut main = None;
        if let Some(n) = opts.content_node {
            if clone.is_attached(n) && clone.is_element(n) {
                main = Some(n);
            }
        }
        if main.is_none() {
            if let Some(s) = &opts.content_selector {
                if let Ok(list) = crate::selector::parse(s) {
                    main = clone.qs(0, &list);
                }
            }
        }
        if main.is_none() {
            main = find_main_content(&clone);
        }
        if let Some(m) = main {
            if clone.tag(m) == Some("body") {
                let st = schema_text(&self.schema, 0);
                if !st.is_empty() {
                    if let Some(e) = find_element_by_schema_text(&clone, m, &st) {
                        main = Some(e);
                    }
                }
            }
        }
        let Some(main) = main else {
            let content = self.fallback_body();
            return Result { word_count: count_html_words(&content), content, meta, variables: vec![] };
        };

        if !meta.published.is_empty() || !meta.author.is_empty() {
            removals::remove_metadata_block(&mut clone, main);
        }
        for w in clone.by_tag(main, "wbr") {
            clone.remove(w);
        }
        if opts.standardize {
            adopt_external_footnotes(&mut clone, main);
            footnotes::standardize_footnotes(&mut clone, main);
            headings::standardize_callouts(&mut clone, main);
        }
        if opts.remove_small_images {
            let small = self.small_images.clone().unwrap_or_default();
            removals::remove_small_images(&mut clone, &small);
        }
        if opts.remove_hidden {
            removals::remove_hidden_elements(&mut clone);
        }
        if opts.remove_content_patterns {
            content_patterns::remove_eyebrow_label(&mut clone, main);
        }
        if opts.remove_exact || opts.remove_partial {
            removals::remove_by_selector(&mut clone, opts.remove_exact, opts.remove_partial, main, !opts.remove_hidden);
        }
        if opts.remove_low_scoring {
            removals::score_and_remove(&mut clone, main);
        }
        if opts.remove_content_patterns {
            content_patterns::remove_by_content_pattern(&mut clone, main, &self.url, &meta.title, &meta.description);
        }
        if opts.standardize {
            standardize::standardize_content(
                &mut clone,
                main,
                &standardize::Options { title: &meta.title, has_math_library: self.has_math_library },
            );
        }
        let base = base_href(&self.doc, &self.url);
        resolve_relative_urls_with_doc(&mut clone, main, &self.url, base.as_deref());
        deduplicate_images(&mut clone, main);
        if let Some(best) = remove_cover_image(&mut clone, main, &meta.image) {
            if let Some(m) = self.metadata.as_mut() {
                m.image = best.clone();
            }
            meta.image = best;
        }
        strip_unsafe_elements(&mut clone, main);
        let content = clone.outer_html(main);
        Result { word_count: count_html_words(&content), content, meta, variables: vec![] }
    }
}

// ---- schema.org and meta tags ---------------------------------------------------------

fn decode_strings(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(crate::entities::decode(&s, false)),
        Value::Array(a) => Value::Array(a.into_iter().map(decode_strings).collect()),
        Value::Object(m) => {
            let mut out = crate::value::Map::new();
            for (k, v) in m.0 {
                out.insert(k, decode_strings(v));
            }
            Value::Object(out)
        }
        other => other,
    }
}

fn extract_schema_org(doc: &Document) -> Vec<Value> {
    let mut items = Vec::new();
    for s in doc.qsa(0, sel!("script[type=\"application/ld+json\"]")) {
        let raw = doc.tc(s);
        let t = regex!(r"(?m)/\*[\s\S]*?\*/|^\s*//.*$").replace_all(&raw, "");
        let t = regex!(r"^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$").replace(&t, "$1");
        let t = regex!(r"^\s*(\*/|/\*)\s*|\s*(\*/|/\*)\s*$").replace_all(&t, "");
        let Some(v) = Value::parse_json(js_trim(&t)) else { continue };
        let graph = match &v {
            Value::Object(m) => match m.get("@graph") {
                Some(Value::Array(g)) => Some(g.clone()),
                _ => None,
            },
            _ => None,
        };
        match graph {
            Some(g) => items.extend(g),
            None => items.push(v),
        }
    }
    items.into_iter().map(decode_strings).collect()
}

fn collect_meta_tags(doc: &Document) -> Vec<MetaTag> {
    let mut out = Vec::new();
    for m in doc.by_tag(0, "meta") {
        let content = doc.get(m, "content");
        if content.is_empty() {
            continue;
        }
        out.push(MetaTag {
            name: doc.attr(m, "name").map(str::to_string),
            property: doc.attr(m, "property").map(str::to_string),
            content: Some(crate::entities::decode(content, false)),
        });
    }
    out
}

fn schema_text(items: &[Value], depth: usize) -> String {
    if depth > 10 {
        return String::new();
    }
    for item in items {
        match item {
            Value::Array(a) => {
                let f = schema_text(a, depth + 1);
                if !f.is_empty() {
                    return f;
                }
            }
            Value::Object(m) => {
                for k in ["text", "articleBody"] {
                    if let Some(Value::String(s)) = m.get(k) {
                        if !s.is_empty() {
                            return s.clone();
                        }
                    }
                }
                if let Some(Value::Array(g)) = m.get("@graph") {
                    let f = schema_text(g, depth + 1);
                    if !f.is_empty() {
                        return f;
                    }
                }
            }
            _ => {}
        }
    }
    String::new()
}

fn find_element_by_schema_text(doc: &Document, root: NodeId, text: &str) -> Option<NodeId> {
    let first_para = regex!(r"\n\s*\n").split(text).next().map(js_trim).unwrap_or("");
    let phrase = js_trim(util::js_prefix(first_para, 100));
    if phrase.is_empty() {
        return None;
    }
    let schema_words = count_words(text);
    let mut best = None;
    let mut best_size = usize::MAX;
    for el in doc.descendant_elements(root) {
        let t = doc.tc(el);
        if !t.contains(phrase) {
            continue;
        }
        let w = count_words(&t);
        if w as f64 >= schema_words as f64 * 0.8 && w < best_size {
            best_size = w;
            best = Some(el);
        }
    }
    best
}

// ---- content root ------------------------------------------------------------------

fn find_main_content(doc: &Document) -> Option<NodeId> {
    let n = ENTRY_POINT_ELEMENTS.len();
    let mut cands: Vec<(NodeId, f64, usize)> = Vec::new();
    for (i, s) in ENTRY_POINT_ELEMENTS.iter().enumerate() {
        let list = crate::selector::parse(s).ok()?;
        for el in doc.qsa(0, &list) {
            let score = ((n - i) * 40) as f64 + removals::score_element(doc, el);
            cands.push((el, score, i));
        }
    }
    if cands.is_empty() {
        let mut best: Option<(NodeId, f64)> = None;
        for el in doc.qsa(0, sel!(BLOCK_ELEMENTS_SELECTOR)) {
            let s = removals::score_element(doc, el);
            if s > 0.0 && best.is_none_or(|b| s > b.1) {
                best = Some((el, s));
            }
        }
        return best.map(|b| b.0);
    }
    cands.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    if cands.len() == 1 && doc.tag(cands[0].0) == Some("body") {
        if let Some(t) = find_table_based_content(doc) {
            return Some(t);
        }
    }
    let top = cands[0];
    let mut best = top;
    for &child in &cands[1..] {
        let words = count_words(&doc.tc(child.0));
        if child.2 < best.2 && doc.contains(best.0, child.0) && words > 50 {
            let siblings = cands.iter().filter(|c| c.2 == child.2 && doc.contains(top.0, c.0)).count();
            if siblings > 1 {
                continue;
            }
            best = child;
        }
    }
    Some(best.0)
}

fn find_table_based_content(doc: &Document) -> Option<NodeId> {
    let tables = doc.by_tag(0, "table");
    let layout = tables.iter().any(|t| {
        let width = util::parse_int(doc.get(*t, "width")).unwrap_or(0);
        let class = doc.class_name(*t).to_lowercase();
        width > 400
            || doc.get(*t, "align") == "center"
            || class.contains("content")
            || class.contains("article")
            || doc.by_tag(*t, "tr").iter().any(|row| {
                let cells: Vec<NodeId> = doc.elem_children(*row).into_iter().filter(|c| doc.tag(*c) == Some("td")).collect();
                cells.len() >= 2 && cells.iter().any(|c| doc.has_attr(*c, "width"))
            })
    });
    if !layout {
        return None;
    }
    let cells = doc.by_tag(0, "td");
    let best = removals::find_best_element(doc, &cells, 50.0)?;
    let body = body_of(doc);
    if count_words(&doc.tc(best)) * 2 < count_words(&doc.tc(body)) {
        return None;
    }
    Some(best)
}

fn adopt_external_footnotes(doc: &mut Document, main: NodeId) {
    let body = body_of(doc);
    if main == body {
        return;
    }
    for el in doc.qsa(body, sel!("div, section, aside")) {
        let class = doc.class_name(el).to_lowercase();
        let id = doc.id_of(el).to_lowercase();
        if !class.contains("footnote") && !id.contains("footnote") {
            continue;
        }
        if doc.contains(main, el) || doc.contains(el, main) {
            continue;
        }
        let Some(h) = doc.qs(el, sel!("h1, h2, h3, h4, h5, h6")) else { continue };
        if !footnotes::footnote_section_heading(&doc.trimmed_text(h)) {
            continue;
        }
        doc.append(main, el);
    }
}

// ---- noscript images, streamed SSR -----------------------------------------------------

fn resolve_noscript_images(doc: &mut Document, body: NodeId) {
    for ns in doc.by_tag(body, "noscript") {
        let html = doc.tc(ns);
        if !html.contains("<img") {
            continue;
        }
        let frag = Document::parse(&html);
        let Some(fimg) = frag.find_tag(0, "img") else { continue };
        let real = frag.attr(fimg, "src").unwrap_or("").to_string();
        if real.is_empty() || real.starts_with("data:") {
            continue;
        }
        let alt = frag.attr(fimg, "alt").map(str::to_string);
        let srcset = frag.attr(fimg, "srcset").unwrap_or("").to_string();
        let Some(parent) = doc.parent_element(ns) else { continue };
        let mut matched = false;
        for img in doc.elem_children(parent).into_iter().filter(|c| doc.tag(*c) == Some("img")) {
            if !doc.get(img, "src").starts_with("data:") {
                continue;
            }
            match &alt {
                Some(a) if !a.is_empty() && doc.attr(img, "alt") == Some(a.as_str()) => {}
                _ => continue,
            }
            doc.set_attr(img, "src", &real);
            if !srcset.is_empty() {
                doc.set_attr(img, "srcset", &srcset);
            }
            matched = true;
            break;
        }
        if !matched && is_lazy_image_context(doc, ns) {
            let container = doc.closest_tags(ns, &["figure"]).unwrap_or(parent);
            let has_real = doc.by_tag(container, "img").iter().any(|i| {
                doc.closest_tags(*i, &["noscript"]).is_none() && {
                    let s = doc.get(*i, "src");
                    !s.is_empty() && !s.starts_with("data:")
                }
            });
            if !has_real {
                let imported = doc.import(&frag, fimg);
                doc.insert_before(ns, imported);
            }
        }
    }
}

fn is_lazy_image_context(doc: &Document, ns: NodeId) -> bool {
    if doc.closest_tags(ns, &["figure"]).is_some() {
        return true;
    }
    if let Some(p) = doc.parent_element(ns) {
        if doc.elem_children(p).iter().any(|s| *s != ns && doc.class_name(*s).to_lowercase().contains("lazy")) {
            return true;
        }
        let pc = doc.class_name(p).to_lowercase();
        if ["image", "img", "picture", "photo", "media"].iter().any(|k| pc.contains(k)) {
            return true;
        }
    }
    false
}

fn find_by_id(doc: &Document, id: &str) -> Option<NodeId> {
    doc.descendant_elements(0).into_iter().find(|e| doc.attr(*e, "id") == Some(id))
}

fn resolve_streamed_content(doc: &mut Document) {
    let mut swaps = Vec::new();
    for s in doc.by_tag(0, "script") {
        let t = doc.tc(s);
        if !t.contains("$RC(") {
            continue;
        }
        for c in regex!(r#"\$RC\("(B:\d+)","(S:\d+)"\)"#).captures_iter(&t) {
            swaps.push((c[1].to_string(), c[2].to_string()));
        }
    }
    for (b, s) in swaps {
        let (Some(template), Some(content)) = (find_by_id(doc, &b), find_by_id(doc, &s)) else { continue };
        let Some(parent) = doc.parent(template) else { continue };
        let mut found = false;
        let mut next = doc.next_sibling(template);
        while let Some(n) = next {
            let following = doc.next_sibling(n);
            let is_marker = matches!(&doc.node(n).data, NodeData::Comment(c) if c == "/$");
            doc.remove(n);
            if is_marker {
                found = true;
                break;
            }
            next = following;
        }
        if !found {
            continue;
        }
        let _ = parent;
        for c in doc.children(content).to_vec() {
            doc.insert_before(template, c);
        }
        doc.remove(template);
        doc.remove(content);
    }
}

// ---- URLs, images, sanitising ------------------------------------------------------------

fn base_href(doc: &Document, url: &str) -> Option<String> {
    let b = doc.qs(0, sel!("base[href]"))?;
    urlutil::join(url, doc.get(b, "href")).map(|u| u.href())
}

fn resolve_relative_urls(doc: &mut Document, root: NodeId, base: &str) {
    let b = base_href(doc, base);
    resolve_relative_urls_with_doc(doc, root, base, b.as_deref());
}

fn resolve_one(base: &str, url: &str) -> String {
    let n = regex!(r#"^\\?["']+"#).replace(js_trim(url), "");
    let n = regex!(r#"\\?["']+$"#).replace(&n, "").into_owned();
    if n.starts_with('#') {
        return n;
    }
    match urlutil::join(base, &n) {
        Some(u) => u.href(),
        None => {
            if n.is_empty() {
                url.to_string()
            } else {
                n
            }
        }
    }
}

fn resolve_relative_urls_with_doc(doc: &mut Document, root: NodeId, doc_url: &str, base_override: Option<&str>) {
    if doc_url.is_empty() {
        return;
    }
    let base = base_override.unwrap_or(doc_url).to_string();
    let mut els = vec![root];
    els.extend(doc.descendant_elements(root));
    let els: Vec<NodeId> = els.into_iter().filter(|e| doc.is_element(*e)).collect();
    for &e in &els {
        for a in ["href", "src"] {
            let v = doc.get(e, a).to_string();
            if !v.is_empty() {
                let r = resolve_one(&base, &v);
                doc.set_attr(e, a, &r);
            }
        }
    }
    for &e in &els {
        let srcset = doc.get(e, "srcset").to_string();
        if srcset.is_empty() {
            continue;
        }
        let mut entries = Vec::new();
        let mut first = true;
        for c in regex!(r"(.+?)\s+(\d+(?:\.\d+)?[wx])").captures_iter(&srcset) {
            let mut u = js_trim(&c[1]).to_string();
            if !first {
                u = regex!(r"^,\s*").replace(&u, "").into_owned();
            }
            first = false;
            entries.push(format!("{} {}", resolve_one(&base, &u), &c[2]));
        }
        let v = if !entries.is_empty() {
            entries.join(", ")
        } else {
            srcset
                .split(',')
                .map(|entry| {
                    let mut parts: Vec<String> = js_trim(entry).split(util::is_js_space).filter(|p| !p.is_empty()).map(str::to_string).collect();
                    if let Some(p0) = parts.first_mut() {
                        *p0 = resolve_one(&base, p0);
                    }
                    parts.join(" ")
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        doc.set_attr(e, "srcset", &v);
    }
    for &e in &els {
        let p = doc.get(e, "poster").to_string();
        if !p.is_empty() {
            let r = resolve_one(&base, &p);
            doc.set_attr(e, "poster", &r);
        }
    }
}

fn normalize_src(url: &str) -> String {
    let u = regex!(r"^https?://").replace(url, "");
    u.split('?').next().unwrap_or("").to_string()
}

fn url_width(doc: &Document, img: NodeId) -> i64 {
    regex!(r"(?:width[=:/]|[/,?&]w[_:=])(\d+)").captures(doc.get(img, "src")).and_then(|c| c[1].parse().ok()).unwrap_or(0)
}

fn pick_best_image(doc: &Document, a: NodeId, b: NodeId) -> NodeId {
    let tier = |e: NodeId| {
        if !doc.get(e, "srcset").is_empty() {
            2
        } else if doc.closest_tags(e, &["picture"]).is_some() {
            1
        } else {
            0
        }
    };
    let (ta, tb) = (tier(a), tier(b));
    if ta != tb {
        return if ta > tb { a } else { b };
    }
    let (wa, wb) = (url_width(doc, a), url_width(doc, b));
    if wa != wb {
        return if wa > wb { a } else { b };
    }
    a
}

fn keep_best_image(doc: &mut Document, group: &[NodeId]) {
    let mut best = group[0];
    for &g in &group[1..] {
        let winner = pick_best_image(doc, best, g);
        doc.remove(if winner == best { g } else { best });
        best = winner;
    }
}

fn no_visible_content_between(doc: &Document, a: NodeId, b: NodeId) -> bool {
    let next = |n: NodeId| -> Option<NodeId> {
        if let Some(f) = doc.children(n).first() {
            return Some(*f);
        }
        let mut cur = Some(n);
        while let Some(c) = cur {
            if let Some(s) = doc.next_sibling(c) {
                return Some(s);
            }
            cur = doc.parent(c);
        }
        None
    };
    let mut node = next(a);
    while let Some(n) = node {
        if n == b {
            break;
        }
        if doc.text(n).is_some_and(|t| !js_trim(t).is_empty()) {
            return false;
        }
        node = next(n);
    }
    true
}

fn deduplicate_images(doc: &mut Document, root: NodeId) {
    for figure in doc.by_tag(root, "figure") {
        let imgs: Vec<NodeId> = doc.by_tag(figure, "img").into_iter().filter(|i| doc.closest_tags(*i, &["noscript"]).is_none() && doc.has_parent(*i)).collect();
        if imgs.len() < 2 {
            continue;
        }
        let mut groups: Vec<(Option<String>, Vec<NodeId>)> = Vec::new();
        for img in imgs {
            let src = doc.get(img, "src");
            if src.is_empty() || src.starts_with("data:") {
                continue;
            }
            let alt = js_trim(doc.get(img, "alt"));
            let key = if alt.is_empty() { None } else { Some(alt.to_string()) };
            match groups.iter_mut().find(|g| g.0 == key) {
                Some(g) => g.1.push(img),
                None => groups.push((key, vec![img])),
            }
        }
        for (key, group) in groups {
            if group.len() < 2 {
                continue;
            }
            if key.is_some() && group.iter().all(|i| doc.get(*i, "src") == doc.get(group[0], "src")) {
                continue;
            }
            keep_best_image(doc, &group);
        }
    }
    let imgs = doc.by_tag(root, "img");
    for w in 0..imgs.len().saturating_sub(1) {
        let (img, other) = (imgs[w], imgs[w + 1]);
        if !doc.has_parent(img) || doc.closest_tags(img, &["noscript", "figure"]).is_some() {
            continue;
        }
        let alt = js_trim(doc.get(img, "alt")).to_string();
        let src = doc.get(img, "src").to_string();
        if alt.is_empty() || src.is_empty() || src.starts_with("data:") {
            continue;
        }
        if !doc.has_parent(other) || doc.closest_tags(other, &["noscript", "figure"]).is_some() {
            continue;
        }
        if js_trim(doc.get(other, "alt")) != alt {
            continue;
        }
        let osrc = doc.get(other, "src");
        if osrc.is_empty() || osrc.starts_with("data:") || osrc == src {
            continue;
        }
        if !no_visible_content_between(doc, img, other) {
            continue;
        }
        keep_best_image(doc, &[img, other]);
    }
    for img in doc.by_tag(root, "img") {
        if !doc.has_parent(img) || doc.closest_tags(img, &["a", "figure", "noscript"]).is_some() {
            continue;
        }
        let src = doc.get(img, "src").to_string();
        if src.is_empty() || src.starts_with("data:") {
            continue;
        }
        let Some(parent) = doc.parent_element(img) else { continue };
        let ns = normalize_src(&src);
        for link in doc.elem_children(parent) {
            if doc.tag(link) != Some("a") || !doc.has_attr(link, "href") || !doc.has_tag_desc(link, &["img"]) {
                continue;
            }
            if ns == normalize_src(doc.get(link, "href")) {
                doc.remove(img);
                break;
            }
        }
    }
}

fn largest_image_src(doc: &Document, img: NodeId) -> String {
    let srcset = doc.get(img, "srcset");
    if srcset.is_empty() {
        return doc.get(img, "src").to_string();
    }
    let mut best = String::new();
    let mut best_w = 0.0;
    let mut first = true;
    for c in regex!(r"(.+?)\s+(\d+(?:\.\d+)?)w").captures_iter(srcset) {
        let mut u = js_trim(&c[1]).to_string();
        if !first {
            u = regex!(r"^,\s*").replace(&u, "").into_owned();
        }
        first = false;
        let w: f64 = c[2].parse().unwrap_or(0.0);
        if !u.is_empty() && w > best_w {
            best_w = w;
            best = u;
        }
    }
    let url = if best.is_empty() { doc.get(img, "src").to_string() } else { best };
    let url = regex!(r",w_\d+").replace_all(&url, "");
    regex!(r",c_\w+").replace_all(&url, "").into_owned()
}

fn remove_cover_image(doc: &mut Document, root: NodeId, meta_image: &str) -> Option<String> {
    if meta_image.is_empty() {
        return None;
    }
    let norm = normalize_src(meta_image);
    for img in doc.by_tag(root, "img") {
        let src = doc.get(img, "src");
        if src.is_empty() || src.starts_with("data:") || normalize_src(src) != norm {
            continue;
        }
        let best = largest_image_src(doc, img);
        if let Some(f) = doc.closest_tags(img, &["figure"]) {
            if doc.has_tag_desc(f, &["figcaption"]) {
                return Some(best);
            }
        }
        doc.remove(img);
        return Some(best);
    }
    None
}

fn is_dangerous_url(url: &str, allow_inline_image: bool) -> bool {
    let n: String = url.chars().filter(|c| !(c.is_whitespace() || (*c as u32) < 0x20)).collect::<String>().to_lowercase();
    if n.starts_with("javascript:") || n.starts_with("blob:") {
        return true;
    }
    if n.starts_with("data:") {
        return !(allow_inline_image && n.starts_with("data:image/"));
    }
    false
}

fn strip_unsafe_elements(doc: &mut Document, root: NodeId) {
    for el in doc.qsa(root, sel!("script:not([type^=\"math/\"]), style, noscript, frame, frameset, object, embed, applet, base, animate, set, animatemotion, animatetransform, animatecolor, discard")) {
        doc.remove(el);
    }
    let mut els = vec![root];
    els.extend(doc.descendant_elements(root));
    for el in els {
        if !doc.is_element(el) {
            continue;
        }
        let is_iframe = doc.tag(el) == Some("iframe");
        let kept: Vec<(String, String)> = doc
            .attrs(el)
            .iter()
            .filter(|(k, v)| {
                let name = k.to_lowercase();
                if name.starts_with("on") || name == "srcdoc" {
                    return false;
                }
                if matches!(name.as_str(), "href" | "src" | "action" | "formaction" | "xlink:href") {
                    let allow = !(name == "src" && is_iframe);
                    return !is_dangerous_url(v, allow);
                }
                true
            })
            .cloned()
            .collect();
        if kept.len() != doc.attrs(el).len() {
            doc.set_attrs(el, kept);
        }
    }
}
