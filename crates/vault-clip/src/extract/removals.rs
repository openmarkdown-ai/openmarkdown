//! Defuddle's `removals/{selectors,hidden,scoring,small-images,metadata-block}.ts`.

use std::collections::HashSet;

use super::constants::*;
use super::images::is_base64_placeholder;
use super::math::looks_like_latex;
use super::util::{count_words, js_trim, parse_float, parse_int, regex, sel, utf16_len, DomExt};
use crate::html::{Document, NodeId};

pub fn has_responsive_show_class(class_name: &str) -> bool {
    class_name.split_whitespace().any(|t| {
        regex!(r"^(sm|md|lg|xl|2xl|min-\[|max-\[):(?:block|flex|grid|inline|table|contents)").is_match(t)
    })
}

// ---- removeBySelector -------------------------------------------------------

pub fn remove_by_selector(
    doc: &mut Document,
    remove_exact: bool,
    remove_partial: bool,
    main: NodeId,
    skip_hidden_exact: bool,
) {
    let mut order: Vec<NodeId> = Vec::new();
    let mut marked: HashSet<NodeId> = HashSet::new();
    let exact_list = {
        static S: std::sync::OnceLock<crate::selector::SelectorList> = std::sync::OnceLock::new();
        S.get_or_init(|| crate::selector::parse(&EXACT_SELECTORS.join(",")).expect("exact selectors"))
    };
    let hidden_exact = sel!(HIDDEN_EXACT_SELECTOR);
    let hidden_skip = sel!(HIDDEN_EXACT_SKIP_SELECTOR);

    if remove_exact {
        for el in doc.qsa(0, exact_list) {
            if !doc.has_parent(el) {
                continue;
            }
            if skip_hidden_exact {
                let hidden_ancestor = doc.closest_sel(el, hidden_skip).is_some();
                let role = doc.get(el, "role").to_lowercase();
                if doc.is(el, hidden_exact) || (hidden_ancestor && role == "dialog") {
                    continue;
                }
            }
            if doc.closest_tags(el, &["pre", "code"]).is_some() {
                continue;
            }
            if doc.is(el, hidden_exact) && has_responsive_show_class(doc.class_name(el)) {
                continue;
            }
            if marked.insert(el) {
                order.push(el);
            }
        }
    }

    if remove_partial {
        let m = partial_matcher();
        let test_sel = sel!("[class],[id],[data-component],[data-test],[data-testid],[data-test-id],[data-qa],[data-cy]");
        let mut all = doc.qsa(0, test_sel);
        let seen: HashSet<NodeId> = all.iter().copied().collect();
        for e in doc.qsa(main, test_sel) {
            if !seen.contains(&e) {
                all.push(e);
            }
        }
        for el in all {
            if marked.contains(&el) {
                continue;
            }
            if doc.closest_sel(el, sel!("[data-defuddle]")).is_some() {
                continue;
            }
            let tag = doc.tag_name(el);
            if tag == "code" || tag == "pre" || doc.has_tag_desc(el, &["pre"]) || doc.closest_tags(el, &["code", "pre"]).is_some() {
                continue;
            }
            let is_heading = is_heading(tag);
            let attrs = if is_heading {
                doc.class_name(el).to_lowercase()
            } else {
                format!(
                    "{} {} {} {} {} {} {}",
                    doc.class_name(el),
                    doc.get(el, "data-component"),
                    doc.get(el, "data-test"),
                    doc.get(el, "data-testid"),
                    doc.get(el, "data-test-id"),
                    doc.get(el, "data-qa"),
                    doc.get(el, "data-cy")
                )
                .to_lowercase()
            };
            let id = if is_heading { String::new() } else { doc.id_of(el).to_lowercase() };
            let has_attrs = !js_trim(&attrs).is_empty();
            if !has_attrs && id.is_empty() {
                continue;
            }
            let attrs_match = has_attrs && m.test(&attrs);
            let id_match = if id.is_empty() {
                false
            } else if id.chars().any(|c| c.is_whitespace() || matches!(c, '_' | '-' | ':' | '.')) {
                m.test(&id)
            } else {
                m.test_anchored(&id)
            };
            if attrs_match || id_match {
                marked.insert(el);
                order.push(el);
            }
        }
    }

    let footnote_lists = sel!(FOOTNOTE_LIST_SELECTORS);
    for el in order {
        if doc.contains(el, main) {
            continue;
        }
        let tag = doc.tag_name(el).to_string();
        if tag == "a" && doc.closest_tags(el, &["h1", "h2", "h3", "h4", "h5", "h6"]).is_some() {
            continue;
        }
        if doc.is(el, footnote_lists) || doc.qs(el, footnote_lists).is_some() {
            continue;
        }
        if let Some(p) = doc.parent_element(el) {
            if doc.is(p, footnote_lists) {
                continue;
            }
        }
        if doc.has_class(el, "footnote-backref") && doc.closest_sel(el, sel!("#footnotes")).is_some() {
            continue;
        }
        if tag == "button" && doc.has_tag_desc(el, &["img", "picture", "video"]) {
            if doc.parent_element(el).is_some() {
                for media in doc.by_tags(el, &["img", "picture", "video"]) {
                    doc.insert_before(el, media);
                }
                doc.remove(el);
            }
            continue;
        }
        if tag == "button" && doc.closest_tags(el, &["p", "li", "td", "th", "span", "h1", "h2", "h3", "h4", "h5", "h6"]).is_some() {
            let kids = doc.children(el).to_vec();
            doc.replace_with_nodes(el, &kids);
            continue;
        }
        doc.remove(el);
    }
}

// ---- removeHiddenElements ---------------------------------------------------

pub fn remove_hidden_elements(doc: &mut Document) {
    let all = doc.elements_under(0);
    // Elements that contain math are never removed (Wikipedia hides MathML
    // in display:none spans). Precompute instead of querySelector per element.
    let mut has_math: HashSet<NodeId> = HashSet::new();
    let math_sel = sel!("math, [data-mathml], .katex-mathml");
    for &e in &all {
        if doc.is(e, math_sel) {
            for a in doc.ancestors(e) {
                if !has_math.insert(a) {
                    break;
                }
            }
        }
    }
    let mut to_remove = Vec::new();
    for &el in &all {
        if has_math.contains(&el) || doc.tag(el) == Some("math") {
            continue;
        }
        if let Some(style) = doc.attr(el, "style") {
            if regex!(r"(?i)(?:^|;\s*)(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)(?:\s*;|\s*$)").is_match(style) {
                to_remove.push(el);
                continue;
            }
        }
        let class = doc.class_name(el);
        if !class.is_empty() {
            if has_responsive_show_class(class) {
                continue;
            }
            for token in class.split_whitespace() {
                let exact = token == "hidden" || token == "invisible";
                let variant = !token.contains('[') && (token.ends_with(":hidden") || token.ends_with(":invisible"));
                if exact || variant {
                    to_remove.push(el);
                    break;
                }
            }
        }
    }
    for el in to_remove {
        doc.remove(el);
    }
}

// ---- small images -----------------------------------------------------------

pub fn element_identifier(doc: &Document, el: NodeId) -> Option<String> {
    if doc.tag(el) == Some("img") {
        let data_src = doc.get(el, "data-src");
        if !data_src.is_empty() {
            return Some(format!("src:{data_src}"));
        }
        let src = doc.get(el, "src");
        let srcset = doc.get(el, "srcset");
        let data_srcset = doc.get(el, "data-srcset");
        if !src.is_empty() {
            return Some(format!("src:{src}"));
        }
        if !srcset.is_empty() {
            return Some(format!("srcset:{srcset}"));
        }
        if !data_srcset.is_empty() {
            return Some(format!("srcset:{data_srcset}"));
        }
    }
    let id = doc.id_of(el);
    let class = doc.class_name(el);
    let view_box = if doc.tag(el) == Some("svg") { doc.get(el, "viewBox") } else { "" };
    if !id.is_empty() {
        return Some(format!("id:{id}"));
    }
    if !view_box.is_empty() {
        return Some(format!("viewBox:{view_box}"));
    }
    if !class.is_empty() {
        return Some(format!("class:{class}"));
    }
    None
}

pub fn find_small_images(doc: &Document) -> HashSet<String> {
    const MIN: f64 = 33.0;
    let mut out = HashSet::new();
    for el in doc.by_tags(0, &["img", "svg"]) {
        let is_svg = doc.tag(el) == Some("svg");
        let attr_w = parse_int(doc.get(el, "width")).unwrap_or(0) as f64;
        let attr_h = parse_int(doc.get(el, "height")).unwrap_or(0) as f64;
        let (mut vb_w, mut vb_h) = (0.0, 0.0);
        if is_svg {
            let vb = doc.get(el, "viewBox");
            if !vb.is_empty() {
                let parts: Vec<&str> = regex!(r"[\s,]+").split(vb).collect();
                if parts.len() == 4 {
                    vb_w = parse_float(parts[2]).unwrap_or(0.0);
                    vb_h = parse_float(parts[3]).unwrap_or(0.0);
                }
            }
        }
        let style = doc.get(el, "style");
        let style_w = regex!(r"width\s*:\s*(\d+)").captures(style).and_then(|c| parse_int(&c[1])).unwrap_or(0) as f64;
        let style_h = regex!(r"height\s*:\s*(\d+)").captures(style).and_then(|c| parse_int(&c[1])).unwrap_or(0) as f64;
        let mut widths: Vec<f64> = [attr_w, style_w, vb_w].into_iter().filter(|d| *d > 0.0).collect();
        let heights: Vec<f64> = [attr_h, style_h, vb_h].into_iter().filter(|d| *d > 0.0).collect();
        if widths.is_empty() && heights.is_empty() && !is_svg {
            let srcset = doc.get(el, "srcset");
            if let Some(c) = regex!(r"(\S+)\s+1x").captures(srcset) {
                if let Some(w) = regex!(r"(?:width[=:/]|[/,?&]w[_:=])(\d+)").captures(&c[1]).and_then(|m| parse_int(&m[1])) {
                    if w > 0 {
                        widths.push(w as f64);
                    }
                }
            }
        }
        if widths.is_empty() && heights.is_empty() {
            continue;
        }
        let ew = widths.iter().cloned().fold(f64::INFINITY, f64::min);
        let eh = heights.iter().cloned().fold(f64::INFINITY, f64::min);
        if ew < MIN || eh < MIN {
            if !is_svg {
                if looks_like_latex(doc.get(el, "alt")) {
                    continue;
                }
                if doc.has_class(el, "latex") || doc.has_class(el, "tex") {
                    continue;
                }
                if !doc.get(el, "data-latex").is_empty() || !doc.get(el, "data-math").is_empty() {
                    continue;
                }
            }
            if let Some(id) = element_identifier(doc, el) {
                out.insert(id);
            }
        }
    }
    out
}

pub fn remove_small_images(doc: &mut Document, small: &HashSet<String>) {
    for tag in ["img", "svg"] {
        for el in doc.by_tag(0, tag) {
            if tag == "img" {
                let src = doc.get(el, "src").to_string();
                let has_alt = ["srcset", "data-src", "data-srcset", "data-lazy-src", "data-original"]
                    .iter()
                    .any(|a| !doc.get(el, a).is_empty());
                if src.is_empty() && !has_alt {
                    doc.remove(el);
                    continue;
                }
                if !has_alt && doc.closest_tags(el, &["picture"]).is_none() && is_base64_placeholder(&src) {
                    doc.remove(el);
                    continue;
                }
            }
            if let Some(id) = element_identifier(doc, el) {
                if small.contains(&id) {
                    doc.remove(el);
                }
            }
        }
    }
}

// ---- removeMetadataBlock ----------------------------------------------------

const DATE_RE: &str = r"(?i)\b(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}[\s,]+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})\b";

pub fn remove_metadata_block(doc: &mut Document, main: NodeId) {
    let Some(h1) = doc.qs(main, sel!("h1")) else { return };
    let mut sibling = doc.next_element_sibling(h1);
    for _ in 0..3 {
        let Some(sib) = sibling else { break };
        let next = doc.next_element_sibling(sib);
        let text = doc.trimmed_text(sib);
        let len = utf16_len(&text);
        if len > 0 && len < 300 {
            let mut has_date = regex!(DATE_RE).is_match(&text);
            if !has_date {
                has_date = doc.qsa(sib, sel!("p, time")).iter().any(|e| regex!(DATE_RE).is_match(&doc.trimmed_text(*e)));
            }
            if has_date {
                doc.remove(sib);
                break;
            }
        }
        sibling = next;
    }
}

// ---- ContentScorer ------------------------------------------------------------

const CONTENT_INDICATORS: &[&str] = &[
    "admonition", "article", "content", "entry", "image", "img", "font", "figure", "figcaption",
    "pre", "main", "post", "story", "table",
];

const NAVIGATION_INDICATORS: &[&str] = &[
    "advertisement", "all rights reserved", "banner", "cookie", "comments", "copyright",
    "follow me", "follow us", "footer", "header", "homepage", "login", "menu", "more articles",
    "more like this", "most read", "nav", "navigation", "newsletter", "popular", "privacy",
    "recommended", "register", "related", "responses", "share", "sidebar", "sign in", "sign up",
    "signup", "social", "sponsored", "subscribe", "terms", "trending",
];

const NON_CONTENT_PATTERNS: &[&str] = &[
    "advert", "ad-", "ads", "banner", "cookie", "copyright", "footer", "header", "homepage",
    "menu", "nav", "newsletter", "popular", "privacy", "recommended", "related", "rights",
    "share", "sidebar", "social", "sponsored", "subscribe", "terms", "trending", "widget",
];

fn nav_indicator_regexes() -> &'static Vec<regex_lite::Regex> {
    static R: std::sync::OnceLock<Vec<regex_lite::Regex>> = std::sync::OnceLock::new();
    R.get_or_init(|| {
        NAVIGATION_INDICATORS
            .iter()
            .map(|i| super::util::re(&format!(r"\b{}\b", i.replace(' ', r"\s+"))))
            .collect()
    })
}

fn nav_heading_matches(text: &str) -> bool {
    static R: std::sync::OnceLock<regex_lite::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| {
        let joined: Vec<String> = NAVIGATION_INDICATORS.iter().map(|i| i.replace(' ', r"\s+")).collect();
        super::util::re(&format!("(?i){}", joined.join("|")))
    })
    .is_match(text)
}

fn social_profile(href: &str) -> bool {
    // JS: /\b(linkedin\.com\/(in|company)\/|twitter\.com\/(?!intent\b)\w|x\.com\/(?!intent\b)\w|facebook\.com\/(?!share\b)\w|instagram\.com\/\w|threads\.net\/\w|mastodon\.\w)/i
    let h = href.to_lowercase();
    let b = h.as_bytes();
    let boundary = |i: usize| i == 0 || !(b[i - 1].is_ascii_alphanumeric() || b[i - 1] == b'_');
    let word = |c: Option<&u8>| c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_');
    let neg_word = |rest: &[u8], w: &[u8]| {
        rest.starts_with(w) && !word(rest.get(w.len()))
    };
    for (i, _) in h.match_indices("linkedin.com/") {
        if boundary(i) && (h[i + 13..].starts_with("in/") || h[i + 13..].starts_with("company/")) {
            return true;
        }
    }
    for (pat, neg) in [("twitter.com/", "intent"), ("x.com/", "intent"), ("facebook.com/", "share")] {
        for (i, _) in h.match_indices(pat) {
            let rest = &b[i + pat.len()..];
            if boundary(i) && word(rest.first()) && !neg_word(rest, neg.as_bytes()) {
                return true;
            }
        }
    }
    for pat in ["instagram.com/", "threads.net/", "mastodon."] {
        for (i, _) in h.match_indices(pat) {
            if boundary(i) && word(b.get(i + pat.len())) {
                return true;
            }
        }
    }
    false
}

pub fn score_element(doc: &Document, el: NodeId) -> f64 {
    let text = doc.tc(el);
    let words = count_words(&text);
    let mut score = words as f64;
    score += doc.count_tag(el, "p") as f64 * 10.0;
    let commas = text.matches(',').count();
    score += commas as f64;
    let images = doc.count_tag(el, "img") as f64;
    score -= images / (if words == 0 { 1.0 } else { words as f64 }) * 3.0;
    let style = doc.get(el, "style");
    let align = doc.get(el, "align");
    if style.contains("float: right") || style.contains("text-align: right") || align == "right" {
        score += 5.0;
    }
    if regex!(r"(?i)\b(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?\s+\d{4})\b").is_match(&text) {
        score += 10.0;
    }
    if regex!(r"(?i)\b(?:by|written by|author:)\s+[A-Za-z\s]+\b").is_match(&text) {
        score += 10.0;
    }
    let class = doc.class_name(el).to_lowercase();
    if class.contains("content") || class.contains("article") || class.contains("post") {
        score += 15.0;
    }
    if doc.qs(el, sel!(FOOTNOTE_INLINE_REFERENCES)).is_some() {
        score += 10.0;
    }
    if doc.qs(el, sel!(FOOTNOTE_LIST_SELECTORS)).is_some() {
        score += 10.0;
    }
    score -= doc.count_tag(el, "table") as f64 * 5.0;
    if doc.tag(el) == Some("td") {
        if let Some(table) = doc.closest_tags(el, &["table"]) {
            let width = parse_int(doc.get(table, "width")).unwrap_or(0);
            let talign = doc.get(table, "align");
            let tclass = doc.class_name(table).to_lowercase();
            if width > 400 || talign == "center" || tclass.contains("content") || tclass.contains("article") {
                let cells = doc.by_tag(table, "td");
                let idx = cells.iter().position(|c| *c == el);
                if let Some(i) = idx {
                    if i > 0 && i < cells.len() - 1 {
                        score += 10.0;
                    }
                }
            }
        }
    }
    let link_len: usize = doc.by_tag(el, "a").iter().map(|a| utf16_len(&doc.tc(*a))).sum();
    let text_len = utf16_len(&text).max(1);
    let density = (link_len as f64 / text_len as f64).min(0.5);
    score * (1.0 - density)
}

pub fn find_best_element(doc: &Document, elements: &[NodeId], min_score: f64) -> Option<NodeId> {
    let mut best = None;
    let mut best_score = 0.0;
    for &e in elements {
        let s = score_element(doc, e);
        if s > best_score {
            best_score = s;
            best = Some(e);
        }
    }
    if best_score > min_score {
        best
    } else {
        None
    }
}

pub fn score_and_remove(doc: &mut Document, main: NodeId) {
    let mut to_remove = Vec::new();
    for el in doc.qsa(0, sel!(BLOCK_ELEMENTS_SELECTOR)) {
        if doc.contains(el, main) {
            continue;
        }
        if doc.closest_tags(el, &["pre"]).is_some() {
            continue;
        }
        if doc.closest_sel(el, sel!("[data-defuddle]")).is_some() {
            continue;
        }
        if doc.closest_tags(el, &["td", "th"]).is_some() {
            continue;
        }
        if is_likely_content(doc, el) {
            continue;
        }
        if score_non_content_block(doc, el) < 0.0 {
            to_remove.push(el);
        }
    }
    for el in to_remove {
        doc.remove(el);
    }
}

fn is_likely_content(doc: &Document, el: NodeId) -> bool {
    let role = doc.get(el, "role");
    if matches!(role, "article" | "main" | "contentinfo") {
        return true;
    }
    let class = doc.class_name(el).to_lowercase();
    let id = doc.id_of(el).to_lowercase();
    for ind in CONTENT_INDICATORS {
        if class.contains(ind) || id.contains(ind) {
            return true;
        }
    }
    if doc.has_tag_desc(el, &["pre", "table", "figure", "picture"]) {
        return true;
    }
    let text = doc.tc(el);
    let words = count_words(&text);
    let headings = doc.by_tags(el, &["h1", "h2", "h3", "h4", "h5", "h6"]);
    if let Some(&h) = headings.first() {
        let ht = doc.trimmed_text(h);
        if !ht.is_empty() && ht == js_trim(&text) {
            let hl = ht.to_lowercase();
            if !nav_heading_matches(&hl) && !regex!(r"(?i)^(?:table of )?contents$|^on this page$|^in this (?:article|guide|post)$").is_match(&hl) {
                return true;
            }
        }
    }
    if words < 1000 {
        let has_nav_heading = headings.iter().any(|h| nav_heading_matches(&js_trim(&doc.tc(*h)).to_lowercase()));
        if has_nav_heading {
            if words < 200 {
                return false;
            }
            let links = doc.count_tag(el, "a") as f64;
            if links / (words.max(1) as f64) > 0.2 {
                return false;
            }
        }
    }
    if is_card_grid(doc, el, words) {
        return false;
    }
    if words < 80 {
        for a in doc.by_tag(el, "a") {
            if social_profile(doc.get(a, "href")) {
                return false;
            }
        }
    }
    let blocks = doc.count_tag(el, "p") + doc.count_tag(el, "li");
    if words > 50 && blocks > 1 {
        return true;
    }
    if words > 100 {
        return true;
    }
    if words > 30 && blocks > 0 {
        return true;
    }
    if words >= 10 && (text.contains('.') || text.contains('?') || text.contains('!')) {
        let links = doc.count_tag(el, "a") as f64;
        if links / (words as f64) < 0.1 {
            return true;
        }
    }
    false
}

fn score_non_content_block(doc: &Document, el: NodeId) -> f64 {
    let fl = sel!(FOOTNOTE_LIST_SELECTORS);
    if doc.is(el, fl) || doc.qs(el, fl).is_some() || doc.closest_sel(el, fl).is_some() {
        return 0.0;
    }
    let text = doc.tc(el);
    let words = count_words(&text);
    if words < 3 {
        return 0.0;
    }
    let mut score = text.matches(',').count() as f64;
    let lower = text.to_lowercase();
    let matches = nav_indicator_regexes().iter().filter(|r| r.is_match(&lower)).count();
    score -= matches as f64 * 10.0;
    let links = doc.by_tag(el, "a");
    if links.len() as f64 / words.max(1) as f64 > 0.5 {
        score -= 15.0;
    }
    if links.len() > 1 && words < 80 {
        let link_len: usize = links.iter().map(|a| utf16_len(&doc.tc(*a))).sum();
        let total = utf16_len(&text);
        if total > 0 && link_len as f64 / total as f64 > 0.8 {
            score -= 15.0;
        }
    }
    let lists = doc.count_tag(el, "ul") + doc.count_tag(el, "ol");
    if lists > 0 && links.len() > lists * 3 {
        score -= 10.0;
    }
    if words < 80 && links.iter().any(|a| social_profile(doc.get(*a, "href"))) {
        score -= 15.0;
    }
    if words < 15
        && regex!(r"\bBy\s+[A-Z]").is_match(&text)
        && regex!(r"(?i)(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)").is_match(&text)
    {
        score -= 10.0;
    }
    if is_card_grid(doc, el, words) {
        score -= 15.0;
    }
    let class = doc.class_name(el).to_lowercase();
    let id = doc.id_of(el).to_lowercase();
    for p in NON_CONTENT_PATTERNS {
        if class.contains(p) || id.contains(p) {
            score -= 8.0;
        }
    }
    score
}

fn is_card_grid(doc: &Document, el: NodeId, words: usize) -> bool {
    if !(3..500).contains(&words) {
        return false;
    }
    let headings = doc.by_tags(el, &["h2", "h3", "h4"]);
    if headings.len() < 3 {
        return false;
    }
    if doc.count_tag(el, "img") < 2 {
        return false;
    }
    let hw: usize = headings.iter().map(|h| count_words(&doc.tc(*h))).sum();
    let prose = (words as f64 - hw as f64) / headings.len() as f64;
    prose < 20.0
}

