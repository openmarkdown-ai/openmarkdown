//! Defuddle's `removals/content-patterns.ts` and `content-boundary.ts`:
//! text-shaped clutter (bylines, read times, breadcrumbs, related-post blocks,
//! newsletter prompts, trailing boilerplate) found by what it says rather
//! than by class name.

use super::constants::{is_heading, CONTENT_ELEMENT_NO_IMG_SELECTOR, CONTENT_ELEMENT_SELECTOR};
use super::urlutil;
use super::util::{count_words, js_index_of, js_prefix, js_trim, normalize_text, regex, sel, utf16_len, DomExt};
use crate::html::{Document, NodeId};

const CONTENT_DATE: &str = r"(?i)(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*|\d{4}[-/]\d{1,2}[-/]\d{1,2})";

fn has_sentence_punct(s: &str) -> bool {
    s.contains(['.', '!', '?'])
}

// ---- content boundary ---------------------------------------------------------

fn find_title_element(doc: &Document, main: NodeId, title: &str) -> Option<NodeId> {
    let nt = normalize_text(title);
    if nt.is_empty() {
        return None;
    }
    doc.by_tags(main, &["h1", "h2"]).into_iter().find(|h| normalize_text(&doc.tc(*h)) == nt)
}

fn link_text_len(doc: &Document, el: NodeId) -> usize {
    doc.by_tag(el, "a").iter().map(|a| utf16_len(&doc.tc(*a))).sum()
}

fn is_prose_block(doc: &Document, el: NodeId) -> bool {
    let tag = doc.tag_name(el);
    if !matches!(tag, "p" | "div" | "section" | "article" | "blockquote" | "font") {
        return false;
    }
    if doc.closest_sel(el, sel!("aside, nav, header, footer, form, [role=\"dialog\"], [role=\"alertdialog\"]")).is_some() {
        return false;
    }
    if regex!(r"\b(?:isHidden(?:-[A-Za-z0-9_]+)?|is-hidden)\b").is_match(doc.class_name(el)) {
        return false;
    }
    if doc.qs(el, sel!("[role=\"dialog\"], [role=\"alertdialog\"]")).is_some() {
        return false;
    }
    if doc.has_tag_desc(el, &["script", "style"]) {
        return false;
    }
    let text = doc.trimmed_text(el);
    if text.is_empty() {
        return false;
    }
    let words = count_words(&text);
    if words < 7 {
        return false;
    }
    if !has_sentence_punct(&text) {
        return false;
    }
    if regex!(r"(?i)^by\s+\S").is_match(&text) && words < 15 {
        return false;
    }
    if regex!(CONTENT_DATE).is_match(&text) && words < 20 {
        return false;
    }
    if link_text_len(doc, el) as f64 > utf16_len(&text) as f64 * 0.7 {
        return false;
    }
    if tag == "div" && !doc.has_tag_desc(el, &["p"]) {
        return false;
    }
    true
}

pub fn find_content_start(doc: &Document, main: NodeId, title: &str) -> Option<NodeId> {
    let start = find_title_element(doc, main, title);
    let all = doc.elements_under(main);
    let begin = match start {
        Some(s) => all.iter().position(|e| *e == s).map(|p| p + 1).unwrap_or(0),
        None => 0,
    };
    let mut leaf = None;
    let mut container = None;
    for &el in &all[begin..] {
        if is_prose_block(doc, el) {
            if matches!(doc.tag_name(el), "p" | "blockquote" | "font") {
                leaf = Some(el);
                break;
            }
            if container.is_none() {
                container = Some(el);
            }
        }
    }
    if leaf.is_some() {
        return leaf;
    }
    if let Some(mut result) = container {
        loop {
            let mut q = None;
            let mut multiple = false;
            for c in doc.elem_children(result) {
                if is_prose_block(doc, c) {
                    if q.is_some() {
                        multiple = true;
                        break;
                    }
                    q = Some(c);
                }
            }
            match (q, multiple) {
                (Some(c), false) => result = c,
                _ => break,
            }
        }
        return Some(result);
    }
    if start.is_some() {
        return find_content_start(doc, main, "");
    }
    None
}

pub fn is_above_content_start(doc: &Document, el: NodeId, boundary: Option<NodeId>) -> bool {
    let Some(b) = boundary else { return false };
    if el == b {
        return false;
    }
    doc.is_before(el, b).unwrap_or(false)
}

// ---- helpers ---------------------------------------------------------------------

fn is_or_contains_heading(doc: &Document, el: NodeId) -> bool {
    is_heading(doc.tag_name(el)) || doc.has_tag_desc(el, &["h1", "h2", "h3", "h4", "h5", "h6"])
}

fn is_newsletter_element(doc: &Document, el: NodeId, max_words: usize) -> bool {
    let text = doc.trimmed_text(el);
    let words = count_words(&text);
    if words < 2 || words > max_words {
        return false;
    }
    if doc.qs(el, sel!(CONTENT_ELEMENT_SELECTOR)).is_some() {
        return false;
    }
    let norm = regex!(r"([a-z])([A-Z])").replace_all(&text, "$1 $2").replace(['\u{2018}', '\u{2019}'], "'");
    regex!(r"(?i)\bsubscribe\b[\s\S]{0,40}\bnewsletter\b|\bnewsletter\b[\s\S]{0,40}\bsubscribe\b|\bsign[- ]up\b[\s\S]{0,80}\b(?:newsletter|email alert)|\b(?:don[\x{2019}']?t (?:want to )?miss|never miss)\b[\s\S]{0,80}\b(?:latest|best|exclusive|reports?|updates?|source)").is_match(&norm)
}

fn has_following_prose(doc: &Document, el: NodeId) -> bool {
    let mut sib = doc.next_element_sibling(el);
    while let Some(s) = sib {
        if doc.tag(s) == Some("p") && count_words(&doc.tc(s)) >= 25 {
            return true;
        }
        for p in doc.by_tag(s, "p") {
            if count_words(&doc.tc(p)) >= 25 {
                return true;
            }
        }
        sib = doc.next_element_sibling(s);
    }
    false
}

fn preceding_prose_words(doc: &Document, el: NodeId, main: NodeId) -> usize {
    let mut words = 0;
    let mut node = Some(el);
    while let Some(n) = node {
        if n == main {
            break;
        }
        let mut sib = doc.prev_element_sibling(n);
        while let Some(s) = sib {
            if doc.tag(s) == Some("p") {
                words += count_words(&doc.tc(s));
            } else {
                for p in doc.by_tag(s, "p") {
                    words += count_words(&doc.tc(p));
                }
            }
            sib = doc.prev_element_sibling(s);
        }
        node = doc.parent_element(n);
    }
    words
}

fn walk_up_to_wrapper(doc: &Document, el: NodeId, text: &str, main: NodeId) -> NodeId {
    let mut target = el;
    while let Some(p) = doc.parent_element(target) {
        if p == main || doc.trimmed_text(p) != text {
            break;
        }
        target = p;
    }
    target
}

fn remove_trailing_siblings(doc: &mut Document, el: NodeId, remove_self: bool) {
    let mut sib = doc.next_element_sibling(el);
    while let Some(s) = sib {
        let next = doc.next_element_sibling(s);
        if doc.id_of(s) != "footnotes" {
            doc.remove(s);
        }
        sib = next;
    }
    if remove_self {
        doc.remove(el);
    }
}

fn remove_trailing_with_cascade(doc: &mut Document, target: NodeId, main: NodeId) {
    let mut ancestors = Vec::new();
    let mut anc = doc.parent_element(target);
    while let Some(a) = anc {
        if a == main {
            break;
        }
        ancestors.push(a);
        anc = doc.parent_element(a);
    }
    remove_trailing_siblings(doc, target, true);
    for a in ancestors {
        remove_trailing_siblings(doc, a, false);
    }
}

fn walk_up_isolated(doc: &Document, el: NodeId, main: NodeId) -> NodeId {
    let mut target = el;
    while let Some(p) = doc.parent_element(target) {
        if p == main {
            break;
        }
        let mut preceding = 0;
        let mut sib = doc.prev_element_sibling(target);
        while let Some(s) = sib {
            preceding += count_words(&doc.tc(s));
            if preceding > 10 {
                break;
            }
            sib = doc.prev_element_sibling(s);
        }
        if preceding > 10 {
            break;
        }
        target = p;
    }
    target
}

fn remove_thin_preceding_section(doc: &mut Document, target: NodeId) {
    let Some(prev) = doc.prev_element_sibling(target) else { return };
    if count_words(&doc.tc(prev)) >= 50 {
        return;
    }
    if doc.qs(prev, sel!(CONTENT_ELEMENT_SELECTOR)).is_some() {
        return;
    }
    if let Some(bp) = doc.prev_element_sibling(prev) {
        if is_or_contains_heading(doc, bp) {
            return;
        }
    }
    doc.remove(prev);
}

fn remove_hero_header(doc: &mut Document, main: NodeId, content_start: Option<NodeId>) {
    let times = doc.by_tag(main, "time");
    for time in times {
        if !is_above_content_start(doc, time, content_start) {
            continue;
        }
        let mut best = None;
        let mut current = doc.parent_element(time);
        while let Some(c) = current {
            if c == main {
                break;
            }
            if doc.has_tag_desc(c, &["h1", "h2"]) && doc.has_tag_desc(c, &["time"]) {
                let total = count_words(&doc.trimmed_text(c));
                let mut meta_els: Vec<NodeId> = Vec::new();
                for e in doc.qsa(c, sel!("h1, h2, h3, time, [aria-label]")) {
                    if !meta_els.iter().any(|m| doc.contains(*m, e)) {
                        meta_els.push(e);
                    }
                }
                let meta_words: usize = meta_els.iter().map(|e| count_words(&doc.tc(*e))).sum();
                let prose = total as i64 - meta_words as i64;
                if prose < 30 {
                    best = Some(c);
                } else {
                    break;
                }
            }
            current = doc.parent_element(c);
        }
        if let Some(b) = best {
            doc.remove(b);
            return;
        }
    }
}

fn is_breadcrumb_list(doc: &Document, list: NodeId) -> bool {
    let items = doc.by_tag(list, "li");
    if items.len() < 2 || items.len() > 8 {
        return false;
    }
    let links = doc.by_tag(list, "a");
    if links.is_empty() || links.len() >= items.len() {
        return false;
    }
    if doc.has_tag_desc(list, &["img", "p", "figure", "blockquote"]) {
        return false;
    }
    if items.iter().any(|i| count_words(&doc.tc(*i)) > 8) {
        return false;
    }
    let mut all_internal = true;
    let mut has_crumb = false;
    let mut short = true;
    for a in links {
        let href = doc.get(a, "href");
        if href.starts_with("http") || href.starts_with("//") {
            all_internal = false;
            break;
        }
        if href == "/" || regex!(r"^/[a-zA-Z0-9_-]+/?$").is_match(href) {
            has_crumb = true;
        }
        if js_trim(&doc.tc(a)).split_whitespace().count() > 5 {
            short = false;
        }
    }
    all_internal && has_crumb && short
}

pub fn remove_eyebrow_label(doc: &mut Document, main: NodeId) {
    let first = doc.qs(main, sel!("h1")).or_else(|| doc.qs(main, sel!("h2")));
    let Some(first) = first else { return };
    let mut current = first;
    while let Some(p) = doc.parent_element(current) {
        if p == main || doc.prev_element_sibling(current).is_some() {
            break;
        }
        current = p;
    }
    let Some(prev) = doc.prev_element_sibling(current) else { return };
    let text = doc.trimmed_text(prev);
    let words = count_words(&text);
    if !(1..=6).contains(&words) || utf16_len(&text) > 40 || has_sentence_punct(&text) {
        return;
    }
    if regex!(CONTENT_DATE).is_match(&text) {
        return;
    }
    if doc
        .qs(prev, sel!("img, picture, video, iframe, figure, table, pre, code, time, [datetime], h1, h2, h3, h4, h5, h6, ul, ol, blockquote"))
        .is_some()
    {
        return;
    }
    doc.remove(prev);
}

const METADATA_STRIP_BASE: &[&str] = &[
    r"(?i)\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b",
    r"(?i)\b(?:Mon(?:day)?|Tue(?:s(?:day)?)?|Wed(?:nesday)?|Thu(?:rs(?:day)?)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\b",
    r"\b\d+(?:st|nd|rd|th)?\b",
    r"\d{4}[-/]\d{1,2}[-/]\d{1,2}",
];

fn strip_patterns(text: &str, patterns: &[&'static regex_lite::Regex]) -> String {
    let mut s = text.to_string();
    for p in patterns {
        s = p.replace_all(&s, "").into_owned();
    }
    s
}

fn base_strip() -> Vec<&'static regex_lite::Regex> {
    vec![
        regex!(METADATA_STRIP_BASE[0]),
        regex!(METADATA_STRIP_BASE[1]),
        regex!(METADATA_STRIP_BASE[2]),
        regex!(METADATA_STRIP_BASE[3]),
    ]
}

fn boilerplate_matches(text: &str) -> bool {
    let pats: [&regex_lite::Regex; 11] = [
        regex!(r"(?i)^This (?:article|story|piece) (?:appeared|was published|originally appeared) in\b"),
        regex!(r"(?i)^A version of this (?:article|story) (?:appeared|was published) in\b"),
        regex!(r"(?i)^Originally (?:published|appeared) (?:in|on|at)\b"),
        regex!(r"(?i)^Any re-?use permitted\b"),
        regex!(r"(?i)^©\s*(?:Copyright\s+)?\d{4}"),
        regex!(r"(?i)^Comments?$"),
        regex!(r"(?i)^Leave a (?:comment|reply)$"),
        regex!(r"^Loading\.{3}$"),
        regex!(r"(?i)^Affiliate links\b.*\b(?:earn|commission)"),
        regex!(r"(?i)\bRead our Comment Policy\b"),
        regex!(r"(?i)^Thank you for (?:being part of|joining) our community\b"),
    ];
    pats.iter().any(|p| p.is_match(text))
}

// ---- removeByContentPattern ---------------------------------------------------------

pub fn remove_by_content_pattern(doc: &mut Document, main: NodeId, url: &str, title: &str, description: &str) {
    let content_start = find_content_start(doc, main, title);
    let norm_title = normalize_text(title);
    let norm_desc = normalize_text(description);

    if let Some(first_list) = doc.qs(main, sel!("ul, ol")) {
        if is_breadcrumb_list(doc, first_list) {
            let mut target = first_list;
            while let Some(p) = doc.parent_element(target) {
                if p == main || doc.elem_children(p).len() != 1 {
                    break;
                }
                target = p;
            }
            doc.remove(target);
        }
    }

    if let Some(h1) = doc.qs(main, sel!("h1")) {
        for link in doc.qsa(main, sel!("a[href]")) {
            if !doc.has_parent(link) {
                continue;
            }
            if doc.is_before(link, h1) != Some(true) {
                continue;
            }
            if !doc.has_tag_desc(link, &["div"]) || doc.has_tag_desc(link, &["img", "picture", "video"]) {
                continue;
            }
            let text = doc.trimmed_text(link);
            if count_words(&text) > 25 || regex!(r"[.!?]\s").is_match(&text) {
                continue;
            }
            doc.remove(link);
        }
    }

    remove_hero_header(doc, main, content_start);

    for media in doc.by_tags(main, &["audio", "video"]) {
        if !doc.has_parent(media) {
            continue;
        }
        if doc.attr(media, "src").is_none_or(|s| s.is_empty()) && !doc.has_tag_desc(media, &["source"]) {
            continue;
        }
        let mut container = media;
        while let Some(p) = doc.parent_element(container) {
            if p == main || count_words(&doc.trimmed_text(p)) > 25 {
                break;
            }
            container = p;
        }
        let ct = doc.trimmed_text(container);
        let listen = regex!(r"(?i)\blisten\s+to\s+(?:this\s+)?(?:article|story|post|episode|podcast)\b").is_match(&ct);
        let pre_player = !listen && is_above_content_start(doc, container, content_start) && count_words(&ct) <= 25;
        if listen || pre_player {
            doc.remove(container);
        }
    }

    let content_text = doc.tc(main);
    let page = urlutil::parse(url);

    // Table of contents near the top.
    for list in doc.qsa(main, sel!("ul, ol")) {
        if !doc.has_parent(list) || doc.closest_sel(list, sel!("#footnotes")).is_some() {
            continue;
        }
        let list_text = doc.trimmed_text(list);
        let pos = js_index_of(&content_text, js_prefix(&list_text, 60));
        if pos < 0 || pos as f64 > utf16_len(&content_text) as f64 * 0.3 {
            continue;
        }
        let links = doc.qsa(list, sel!("a[href]"));
        if links.len() < 3 || doc.qs(list, sel!(CONTENT_ELEMENT_SELECTOR)).is_some() {
            continue;
        }
        let mut anchors = 0;
        for l in &links {
            let href = doc.get(*l, "href");
            if href.starts_with('#') {
                anchors += 1;
            } else if let (Some(p), true) = (&page, href.contains('#')) {
                if let Some(r) = urlutil::join(url, href) {
                    if r.path == p.path && r.host == p.host {
                        anchors += 1;
                    }
                }
            }
        }
        if anchors < 3 || (anchors as f64 / links.len() as f64) < 0.8 {
            continue;
        }
        let mut target = list;
        while let Some(p) = doc.parent_element(target) {
            if p == main || doc.elem_children(p).len() != 1 {
                break;
            }
            target = p;
        }
        if let Some(prev) = doc.prev_element_sibling(target) {
            if is_heading(doc.tag_name(prev))
                && regex!(r"(?i)^(?:table of )?contents$|^on this page$|^in this (?:article|guide|post)$").is_match(&doc.trimmed_text(prev))
            {
                doc.remove(prev);
            }
        }
        let prev = doc.prev_element_sibling(target);
        let next = doc.next_element_sibling(target);
        doc.remove(target);
        if let Some(p) = prev {
            if doc.tag(p) == Some("hr") {
                doc.remove(p);
            }
        }
        if let Some(n) = next {
            if doc.tag(n) == Some("hr") {
                doc.remove(n);
            }
        }
        break;
    }

    let mut byline_found = false;
    let mut author_date_found = false;
    for el in doc.qsa(main, sel!("p, span, div, time")) {
        if !doc.has_parent(el) {
            continue;
        }
        let text = doc.trimmed_text(el);
        let words = count_words(&text);
        if words > 15 || words == 0 {
            continue;
        }
        if doc.closest_tags(el, &["pre", "code"]).is_some() {
            continue;
        }
        let tag = doc.tag_name(el).to_string();
        let has_date = regex!(CONTENT_DATE).is_match(&text);
        let pre = |doc: &Document| is_above_content_start(doc, el, content_start);

        if regex!(r"(?i)^current time in$").is_match(&text) && js_index_of(&content_text, &text) <= 300 {
            let mut target = el;
            if let Some(p) = doc.parent_element(el) {
                if p != main {
                    target = p;
                }
            }
            doc.remove(target);
            continue;
        }
        if words == 1 && regex!(r"(?i)^pinned$").is_match(&text) {
            doc.remove(el);
            continue;
        }
        let mut removed = false;
        for normalized in [&norm_title, &norm_desc] {
            if !normalized.is_empty() && words >= 3 && pre(doc) && normalize_text(&text) == **normalized {
                doc.remove(el);
                removed = true;
                break;
            }
        }
        if removed {
            continue;
        }
        let metadata_label = regex!(r"(?i)^(?:date|published|updated|posted|from|to|subject)\s*:").is_match(&text);
        if (tag == "div" || tag == "p")
            && (1..=10).contains(&words)
            && (has_date || regex!(r"(?i)\b\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b").is_match(&text))
            && !metadata_label
            && !has_sentence_punct(&text)
            && pre(doc)
            && !doc.qsa(el, sel!("p, h1, h2, h3, h4, h5, h6")).iter().any(|b| count_words(&doc.tc(*b)) > 8)
        {
            doc.remove(el);
            continue;
        }
        if tag == "div" && (1..=5).contains(&words) && !has_sentence_punct(&text) && pre(doc) && doc.has_tag_desc(el, &["img"]) {
            let links = doc.qsa(el, sel!("a[href]"));
            if !links.is_empty() {
                let lt: usize = links.iter().map(|l| utf16_len(&doc.trimmed_text(*l))).sum();
                if lt as f64 / utf16_len(&text).max(1) as f64 >= 0.8 {
                    doc.remove(el);
                    continue;
                }
            }
        }
        if !byline_found
            && regex!(r"(?i)^(?:posted\s+)?by\s+\S").is_match(&text)
            && words >= 2
            && !regex!(r"[.!?]$").is_match(&text)
            && pre(doc)
        {
            let target = walk_up_to_wrapper(doc, el, &text, main);
            doc.remove(target);
            byline_found = true;
            continue;
        }
        if regex!(r"(?i)\d+\s*min(?:ute)?s?\s+read\b|(?:read(?:ing)?\s+time)\s*:?\s*\d+\s*min(?:ute)?s?\b").is_match(&text)
            && (if has_date {
                doc.qsa(el, sel!("p, div, section, article")).is_empty()
            } else {
                words <= 5 && pre(doc)
            })
        {
            let mut pats = base_strip();
            pats.push(regex!(r"(?i)\bmin(?:ute)?s?\b"));
            pats.push(regex!(r"(?i)\bread(?:ing)?\b"));
            pats.push(regex!(r"(?i)\btime\b"));
            pats.push(regex!(r"(?i)\bestimated\b"));
            pats.push(regex!(r"[/|·•—–\-,:.\s]+"));
            let cleaned = strip_patterns(&text, &pats);
            if js_trim(&cleaned).is_empty() {
                let target = if has_date { el } else { walk_up_to_wrapper(doc, el, &text, main) };
                doc.remove(target);
                continue;
            }
        }
        if !author_date_found && (2..=10).contains(&words) && has_date && !metadata_label && pre(doc) {
            let mut pats = base_strip();
            pats.push(regex!(r"(?i)\bby\b"));
            pats.push(regex!(r"[/|·•—–\-,]+"));
            let residual = strip_patterns(&text, &pats);
            let residual = js_trim(&residual);
            if !residual.is_empty() {
                let names: Vec<&str> = residual.split(super::util::is_js_space).filter(|w| !w.is_empty()).collect();
                if (1..=4).contains(&names.len()) && names.iter().all(|w| w.chars().next().is_some_and(|c| c.is_uppercase())) {
                    let target = walk_up_to_wrapper(doc, el, &text, main);
                    doc.remove(target);
                    author_date_found = true;
                    continue;
                }
            }
        }
        if has_date && words <= 5 && pre(doc) {
            let residual = strip_patterns(&text, &base_strip());
            let residual = regex!(r"[,\s/\-]+").replace_all(&residual, "");
            if js_trim(&residual).is_empty() {
                let target = walk_up_to_wrapper(doc, el, &text, main);
                doc.remove(target);
                continue;
            }
        }
    }

    // Standalone <time> at the content boundaries.
    for time in doc.by_tag(main, "time") {
        if !doc.has_parent(time) {
            continue;
        }
        let mut target = time;
        let mut target_text = doc.trimmed_text(target);
        while let Some(p) = doc.parent_element(target) {
            if p == main {
                break;
            }
            let ptag = doc.tag_name(p);
            let ptext = doc.trimmed_text(p);
            if ptag == "p" && ptext == target_text {
                target = p;
                break;
            }
            if matches!(ptag, "i" | "em" | "span" | "b" | "strong" | "small") && ptext == target_text {
                target = p;
                target_text = ptext;
                continue;
            }
            break;
        }
        let text = doc.trimmed_text(target);
        if count_words(&text) > 10 {
            continue;
        }
        let pos = js_index_of(&content_text, &text);
        let dist = utf16_len(&content_text) as i64 - (pos + utf16_len(&text) as i64);
        if pos > 200 && dist > 200 {
            continue;
        }
        doc.remove(target);
    }

    // Blog metadata lists.
    for list in doc.qsa(main, sel!("ul, ol, dl")) {
        if !doc.has_parent(list) || doc.closest_sel(list, sel!("#footnotes")).is_some() {
            continue;
        }
        let is_dl = doc.tag(list) == Some("dl");
        let items: Vec<NodeId> = doc
            .elem_children(list)
            .into_iter()
            .filter(|c| doc.tag(*c) == Some(if is_dl { "dd" } else { "li" }))
            .collect();
        let min = if is_dl { 1 } else { 2 };
        if items.len() < min || items.len() > 8 {
            continue;
        }
        let list_text = doc.trimmed_text(list);
        let pos = js_index_of(&content_text, &list_text);
        let dist = utf16_len(&content_text) as i64 - (pos + utf16_len(&list_text) as i64);
        if pos > 500 && dist > 500 {
            continue;
        }
        if let Some(prev) = doc.prev_element_sibling(list) {
            if is_or_contains_heading(doc, prev) || doc.trimmed_text(prev).ends_with(':') {
                continue;
            }
        }
        let is_meta = items.iter().all(|i| {
            let t = doc.trimmed_text(*i);
            count_words(&t) <= 8 && !regex!(r"[.!?]$").is_match(&t)
        });
        if !is_meta || count_words(&list_text) > 30 {
            continue;
        }
        let target = walk_up_to_wrapper(doc, list, &list_text, main);
        doc.remove(target);
    }

    // Section breadcrumbs and back links.
    let url_path = page.as_ref().map(|p| p.path.clone()).unwrap_or_default();
    let page_host = page.as_ref().map(|p| p.host.strip_prefix("www.").unwrap_or(&p.host).to_string()).unwrap_or_default();
    if !url_path.is_empty() {
        let first_heading = doc.qs(main, sel!("h1, h2, h3"));
        for el in doc.qsa(main, sel!("div, span, p, a[href]")) {
            if !doc.has_parent(el) {
                continue;
            }
            let text = doc.trimmed_text(el);
            if count_words(&text) > 10 {
                continue;
            }
            if doc.has_tag_desc(el, &["p", "div", "section", "article"]) {
                continue;
            }
            let is_link = doc.tag(el) == Some("a") && doc.has_attr(el, "href");
            if is_link {
                if let Some(p) = doc.parent_element(el) {
                    if p != main && doc.trimmed_text(p) != text {
                        if doc.closest_tags(el, &["p"]).is_some() {
                            continue;
                        }
                        let Some(fh) = first_heading else { continue };
                        if doc.is_before(el, fh) != Some(true) {
                            continue;
                        }
                    }
                }
            }
            let link = if is_link { Some(el) } else { doc.qs(el, sel!("a[href]")) };
            let Some(link) = link else { continue };
            let Some(lp) = urlutil::join(url, doc.get(link, "href")) else { continue };
            let link_path = lp.path;
            let link_dir = regex!(r"/[^/]*$").replace(&link_path, "/").into_owned();
            let last = link_path.rsplit('/').next().unwrap_or("");
            let parent_index = regex!(r"(?i)^index\.(html?|php)$").is_match(last) && url_path.starts_with(&link_dir);
            if link_path != "/" && link_path != url_path && (url_path.starts_with(&link_path) || parent_index) {
                doc.remove(el);
            }
        }
    }

    // Trailing external link lists.
    if !page_host.is_empty() {
        for heading in doc.qsa(main, sel!("h2, h3, h4, h5, h6")) {
            if !doc.has_parent(heading) {
                continue;
            }
            let Some(list) = doc.next_element_sibling(heading) else { continue };
            if !matches!(doc.tag_name(list), "ul" | "ol") {
                continue;
            }
            let items: Vec<NodeId> = doc.elem_children(list).into_iter().filter(|c| doc.tag(*c) == Some("li")).collect();
            if items.len() < 2 {
                continue;
            }
            let mut trailing = false;
            let mut check = Some(list);
            while let Some(c) = check {
                if c == main {
                    break;
                }
                let mut sib = doc.next_element_sibling(c);
                while let Some(s) = sib {
                    if !doc.trimmed_text(s).is_empty() {
                        trailing = true;
                        break;
                    }
                    sib = doc.next_element_sibling(s);
                }
                if trailing {
                    break;
                }
                check = doc.parent_element(c);
            }
            if trailing {
                continue;
            }
            let mut all_external = true;
            for item in &items {
                let links = doc.qsa(*item, sel!("a[href]"));
                if links.is_empty() {
                    all_external = false;
                    break;
                }
                let item_text = doc.trimmed_text(*item);
                let mut lt = 0;
                for l in &links {
                    lt += utf16_len(&doc.trimmed_text(*l));
                    if let Some(u) = urlutil::join(url, doc.get(*l, "href")) {
                        if u.host.strip_prefix("www.").unwrap_or(&u.host) == page_host {
                            all_external = false;
                            break;
                        }
                    }
                }
                if !all_external {
                    break;
                }
                if (lt as f64) < utf16_len(&item_text) as f64 * 0.6 {
                    all_external = false;
                    break;
                }
            }
            if !all_external {
                continue;
            }
            doc.remove(list);
            doc.remove(heading);
        }
    }

    // Trailing related-posts block.
    let mut last = doc.last_elem_child(main);
    while let Some(l) = last {
        if matches!(doc.tag_name(l), "hr" | "br") {
            last = doc.prev_element_sibling(l);
        } else {
            break;
        }
    }
    if let Some(l) = last {
        if matches!(doc.tag_name(l), "section" | "div" | "aside") {
            let mut paras = Vec::new();
            let mut non_para = false;
            for c in doc.elem_children(l) {
                if doc.trimmed_text(c).is_empty() {
                    continue;
                }
                if doc.tag(c) == Some("p") {
                    paras.push(c);
                } else if doc.tag(c) != Some("br") {
                    non_para = true;
                    break;
                }
            }
            if paras.len() >= 2 && !non_para {
                let all_dense = paras.iter().all(|p| {
                    let text = super::util::collapse_ws(&doc.trimmed_text(*p));
                    let links = doc.qsa(*p, sel!("a[href]"));
                    if links.is_empty() {
                        return false;
                    }
                    let lt: usize = links.iter().map(|a| utf16_len(&doc.trimmed_text(*a))).sum();
                    if lt as f64 / utf16_len(&text).max(1) as f64 <= 0.6 {
                        return false;
                    }
                    let mut non_link = text.clone();
                    for a in &links {
                        let at = doc.trimmed_text(*a);
                        if !at.is_empty() {
                            non_link = non_link.split(at.as_str()).collect::<Vec<_>>().join("");
                        }
                    }
                    !has_sentence_punct(&non_link)
                });
                if all_dense {
                    doc.remove(l);
                }
            }
        }
    }

    // Trailing thin sections.
    let total_words = count_words(&doc.tc(main));
    if total_words > 300 {
        let mut trailing = Vec::new();
        let mut trailing_words: i64 = 0;
        let mut child = doc.last_elem_child(main);
        while let Some(c) = child {
            if doc.id_of(c) == "footnotes" {
                child = doc.prev_element_sibling(c);
                continue;
            }
            if doc.tag(c) == Some("hr") {
                trailing.push(c);
                break;
            }
            let svg_words: usize = doc.by_tag(c, "svg").iter().map(|s| count_words(&doc.tc(*s))).sum();
            let words = count_words(&doc.trimmed_text(c)) as i64 - svg_words as i64;
            if words > 25 {
                break;
            }
            trailing_words += words;
            trailing.push(c);
            child = doc.prev_element_sibling(c);
        }
        if !trailing.is_empty() && (trailing_words as f64) < total_words as f64 * 0.15 {
            let has_heading = trailing.iter().any(|e| is_or_contains_heading(doc, *e));
            let has_content = trailing.iter().any(|e| doc.qs(*e, sel!(CONTENT_ELEMENT_SELECTOR)).is_some());
            let prose = trailing.iter().filter(|e| doc.tag(**e) == Some("p") && count_words(&doc.tc(**e)) > 5).count();
            if has_heading && !has_content && prose < 2 {
                for e in trailing {
                    doc.remove(e);
                }
            }
        }
    }

    // Boilerplate and everything after it.
    let full_text = doc.tc(main);
    for el in doc.qsa(main, sel!("p, div, span, section")) {
        if !doc.has_parent(el) || doc.closest_tags(el, &["pre", "code"]).is_some() {
            continue;
        }
        let text = doc.trimmed_text(el);
        let words = count_words(&text);
        if !(1..=50).contains(&words) {
            continue;
        }
        if boilerplate_matches(&text) {
            let mut target = el;
            while let Some(p) = doc.parent_element(target) {
                if p == main || doc.next_element_sibling(target).is_some() {
                    break;
                }
                target = p;
            }
            let tpos = js_index_of(&full_text, &doc.tc(target));
            if tpos < 200 {
                if target != el && doc.next_element_sibling(el).is_none() {
                    doc.remove(el);
                }
                continue;
            }
            remove_trailing_with_cascade(doc, target, main);
        }
    }

    // Related / read-next / about-the-author sections by heading.
    for heading in doc.qsa(main, sel!("h2, h3, h4, h5, h6")) {
        if !doc.has_parent(heading) {
            continue;
        }
        let ht = doc.trimmed_text(heading);
        let is_cta = regex!(r"(?i)^(?:subscribe|sign up|follow us|share this|stay (?:updated|connected)|join (?:us|our)|search (?:the |our )?(?:site|blog|archives?|newsroom|website|catalog|store|shop|database))$").is_match(&ht);
        if !is_cta && !regex!(r"(?i)^(?:related (?:posts?|articles?|content|stories|reads?|reading)|you (?:might|may|could) (?:also )?(?:like|enjoy|be interested in)|read (?:next|more|also)|further reading|see also|more (?:from .*|from|articles?|posts?|like this)|more to (?:read|explore)|explore more|about (?:the )?author|latest (?:news|events?|posts?|articles?|stories)(?:\s*[&+]\s*(?:news|events?|posts?|articles?|stories))?)$").is_match(&ht) {
            continue;
        }
        if js_index_of(&content_text, &ht) < 500 {
            continue;
        }
        let target = walk_up_isolated(doc, heading, main);
        if has_following_prose(doc, target) {
            if target == heading {
                continue;
            }
            doc.remove(target);
            continue;
        }
        if target == heading {
            if !is_cta {
                continue;
            }
            remove_trailing_siblings(doc, heading, true);
        } else {
            remove_thin_preceding_section(doc, target);
            remove_trailing_with_cascade(doc, target, main);
        }
        break;
    }

    for el in doc.by_tag(main, "p") {
        if !doc.has_parent(el) {
            continue;
        }
        let text = doc.trimmed_text(el);
        if !regex!(r"(?i)^for more (?:on|about)\b").is_match(&text) || count_words(&text) > 20 {
            continue;
        }
        if doc.qs(el, sel!(CONTENT_ELEMENT_SELECTOR)).is_some() {
            continue;
        }
        doc.remove(el);
    }

    // Headingless related-post card grids.
    let content_words = count_words(&content_text);
    for el in doc.qsa(main, sel!("div, ul, ol")) {
        if !doc.has_parent(el) {
            continue;
        }
        let children = doc.elem_children(el);
        if children.len() < 2 {
            continue;
        }
        if doc.by_tags(el, &["img", "picture"]).len() < 2 {
            continue;
        }
        let cards = children
            .iter()
            .filter(|c| doc.has_tag_desc(**c, &["img", "picture"]) && (doc.has_tag_desc(**c, &["h2", "h3", "h4"]) || doc.qs(**c, sel!("a[href]")).is_some()))
            .count();
        if cards < 2 || (cards as f64) < children.len() as f64 * 0.7 {
            continue;
        }
        let first_text = js_prefix(&doc.trimmed_text(children[0]), 30).to_string();
        let follows = if utf16_len(&first_text) >= 5 {
            js_index_of(&content_text, &first_text) >= 500
        } else {
            children.iter().all(|c| doc.qs(*c, sel!("a[href]")).is_some()) && preceding_prose_words(doc, el, main) >= 100
        };
        if !follows {
            continue;
        }
        let grid_words = count_words(&doc.tc(el));
        if content_words > 0 && grid_words as f64 / content_words as f64 > 0.3 {
            continue;
        }
        let target = walk_up_isolated(doc, el, main);
        if target == el {
            continue;
        }
        let target_words = count_words(&doc.tc(target));
        if target_words > grid_words * 2 + 15 {
            continue;
        }
        if has_following_prose(doc, target) {
            continue;
        }
        remove_thin_preceding_section(doc, target);
        remove_trailing_siblings(doc, target, true);
        break;
    }

    // Newsletter signup sections.
    for el in doc.qsa(main, sel!("div, section, aside")) {
        if !doc.has_parent(el) || doc.closest_tags(el, &["pre", "code"]).is_some() {
            continue;
        }
        if !is_newsletter_element(doc, el, 60) {
            continue;
        }
        let el_words = count_words(&doc.trimmed_text(el));
        let mut target = el;
        while let Some(p) = doc.parent_element(target) {
            if p == main || count_words(&doc.trimmed_text(p)) > el_words * 2 + 15 {
                break;
            }
            target = p;
        }
        doc.remove(target);
        break;
    }
    for el in doc.by_tag(main, "ul") {
        if !doc.has_parent(el) || !is_newsletter_element(doc, el, 30) {
            continue;
        }
        doc.remove(el);
        break;
    }

    // Author/contact blocks near the end.
    for el in doc.qsa(main, sel!("div, section")) {
        if !doc.has_parent(el) {
            continue;
        }
        let text = doc.trimmed_text(el);
        let words = count_words(&text);
        if !(2..=40).contains(&words) {
            continue;
        }
        let pos = js_index_of(&content_text, js_prefix(&text, 60));
        if pos < 0 {
            continue;
        }
        let dist = utf16_len(&content_text) as i64 - (pos + utf16_len(&text) as i64);
        if dist > 300 {
            continue;
        }
        let has_label = doc
            .qsa(el, sel!("div, span, p, dt, dd, li"))
            .iter()
            .any(|c| regex!(r"(?i)^(?:written by|(?:author|contact|reporter|correspondent)s?)$").is_match(&doc.trimmed_text(*c)));
        if !has_label {
            continue;
        }
        let contact = regex!(r"[\w.-]+@[\w.-]+\.\w+").is_match(&text)
            || regex!(r"\(?\d{3}\)?[\s.‑–-]?\d{3}[\s.‑–-]?\d{4}").is_match(&text)
            || doc.qs(el, sel!("a[href^=\"mailto:\"]")).is_some();
        if !contact {
            continue;
        }
        let target = walk_up_isolated(doc, el, main);
        doc.remove(target);
        break;
    }

    // Author/share label widgets.
    for el in doc.qsa(main, sel!("p, span, div")) {
        if !doc.has_parent(el) {
            continue;
        }
        if !regex!(r"(?i)^(?:share|follow|authors?|written\s+by)$").is_match(&doc.trimmed_text(el)) {
            continue;
        }
        let mut container = el;
        while let Some(p) = doc.parent_element(container) {
            if p == main || count_words(&doc.trimmed_text(p)) > 15 {
                break;
            }
            container = p;
        }
        if doc.qs(container, sel!(CONTENT_ELEMENT_NO_IMG_SELECTOR)).is_some() {
            continue;
        }
        doc.remove(container);
    }

    // Social engagement counters.
    for el in doc.qsa(main, sel!("a, p, div, span")) {
        if !doc.has_parent(el) {
            continue;
        }
        let text = doc.trimmed_text(el);
        if !regex!(r"(?i)^\d+\s+(?:Likes?|Comments?|Shares?|Retweets?|Reposts?|Restacks?)$").is_match(&text) {
            continue;
        }
        let is_a = doc.tag(el) == Some("a");
        if is_a && !doc.get(el, "href").is_empty() {
            continue;
        }
        if !is_a {
            let pos = js_index_of(&content_text, &text);
            let dist = utf16_len(&content_text) as i64 - (pos + utf16_len(&text) as i64);
            if dist > 200 {
                continue;
            }
        }
        let target = walk_up_to_wrapper(doc, el, &text, main);
        doc.remove(target);
    }

    // Trailing tag/category link blocks.
    for el in doc.by_tag(main, "div") {
        if !doc.has_parent(el) {
            continue;
        }
        let text = doc.trimmed_text(el);
        let words = count_words(&text);
        if !(1..=10).contains(&words) || has_sentence_punct(&text) {
            continue;
        }
        if doc.qs(el, sel!(CONTENT_ELEMENT_SELECTOR)).is_some() {
            continue;
        }
        let pos = js_index_of(&content_text, &text);
        if pos < 0 {
            continue;
        }
        let dist = utf16_len(&content_text) as i64 - (pos + utf16_len(&text) as i64);
        if dist > 300 {
            continue;
        }
        let links = doc.qsa(el, sel!("a[href]"));
        if links.is_empty() {
            continue;
        }
        let lt: usize = links.iter().map(|l| utf16_len(&doc.trimmed_text(*l))).sum();
        if (lt as f64 / utf16_len(&text).max(1) as f64) < 0.8 {
            continue;
        }
        doc.remove(el);
    }
}
