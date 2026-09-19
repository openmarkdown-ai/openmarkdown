//! Defuddle's `elements/headings.ts` (permalink anchors out of headings) and
//! `elements/callouts.ts` (GitHub alerts, callout asides, admonitions and
//! Bootstrap alerts into Obsidian callout markup).

use super::constants::is_allowed_attribute;
use super::util::{capitalize, js_trim, regex, remove_class, sel, DomExt};
use crate::html::{Document, NodeId};

pub fn is_permalink_anchor(doc: &Document, node: NodeId) -> bool {
    if doc.tag(node) != Some("a") {
        return false;
    }
    let href = doc.get(node, "href");
    let title = doc.get(node, "title").to_lowercase();
    let class = doc.class_name(node).to_lowercase();
    let text = doc.trimmed_text(node);
    if href.starts_with('#') || title.contains("permalink") {
        return true;
    }
    if class.contains("permalink") || class.contains("heading-anchor") || class.contains("anchor-link") {
        return true;
    }
    regex!(r"^[#¶§🔗\x{FEFF}]$").is_match(&text)
}

pub fn remove_permalink_anchors(doc: &mut Document, root: NodeId) {
    for link in doc.qsa(root, sel!("h1 a, h2 a, h3 a, h4 a, h5 a, h6 a, a.permalink, a.anchor-link, a.heading-anchor")) {
        if is_permalink_anchor(doc, link) {
            doc.remove(link);
        }
    }
}

fn is_heading_nav_element(doc: &Document, node: NodeId) -> bool {
    let tag = doc.tag_name(node);
    if tag == "button" {
        return true;
    }
    if tag == "a" && is_permalink_anchor(doc, node) {
        return true;
    }
    if doc.has_class(node, "anchor") || doc.has_class(node, "permalink-widget") {
        return true;
    }
    if (tag == "span" || tag == "div") && doc.by_tag(node, "a").iter().any(|a| is_permalink_anchor(doc, *a)) {
        return true;
    }
    false
}

pub fn transform_heading(doc: &mut Document, el: NodeId) -> NodeId {
    let tag = doc.tag_name(el).to_string();
    let new = doc.create_element(&tag);
    for (k, v) in doc.attrs(el).to_vec() {
        if is_allowed_attribute(&k) {
            doc.set_attr(new, &k, &v);
        }
    }
    if doc.elem_children(el).is_empty() {
        let t = doc.trimmed_text(el);
        if !t.is_empty() {
            let tn = doc.create_text(&t);
            doc.append(new, tn);
        }
        return new;
    }
    let clone = doc.clone_subtree(el);
    let mut nav_text: Vec<String> = Vec::new();
    let mut to_remove = Vec::new();
    for child in doc.descendant_elements(clone) {
        if !is_heading_nav_element(doc, child) {
            continue;
        }
        let ct = doc.trimmed_text(child);
        nav_text.push(ct.clone());
        if let Some(p) = doc.parent_element(child) {
            if p != clone && doc.trimmed_text(p) == ct {
                // JS keys the map by element, so a parent set later keeps its first slot.
                nav_text.push(ct);
            }
        }
        to_remove.push(child);
    }
    for r in to_remove {
        doc.remove(r);
    }
    let mut text = doc.trimmed_text(clone);
    if text.is_empty() {
        if let Some(first) = nav_text.first() {
            text = first.clone();
        }
    }
    if !text.is_empty() {
        let tn = doc.create_text(&text);
        doc.append(new, tn);
    }
    new
}

// ---- callouts ---------------------------------------------------------------

fn create_callout(doc: &mut Document, kind: &str, title: &str, content_source: NodeId) -> NodeId {
    let callout = doc.create_element("div");
    doc.set_attr(callout, "data-callout", kind);
    doc.set_attr(callout, "class", "callout");
    let title_div = doc.create_element("div");
    doc.set_attr(title_div, "class", "callout-title");
    let inner = doc.create_element("div");
    doc.set_attr(inner, "class", "callout-title-inner");
    if !title.is_empty() {
        let t = doc.create_text(title);
        doc.append(inner, t);
    }
    doc.append(title_div, inner);
    doc.append(callout, title_div);
    let content = doc.create_element("div");
    doc.set_attr(content, "class", "callout-content");
    doc.transfer_children(content_source, content);
    doc.append(callout, content);
    callout
}

pub fn standardize_callouts(doc: &mut Document, root: NodeId) {
    for el in doc.qsa(root, sel!(".callout.is-collapsed, .callout.is-collapsible")) {
        let collapsed = doc.has_class(el, "is-collapsed");
        remove_class(doc, el, &["is-collapsed", "is-collapsible"]);
        if !doc.has_attr(el, "data-callout-fold") {
            doc.set_attr(el, "data-callout-fold", if collapsed { "-" } else { "+" });
        }
        if let Some(fold) = doc.qs(el, sel!(".callout-fold")) {
            doc.remove(fold);
        }
        if let Some(content) = doc.qs(el, sel!(".callout-content")) {
            if let Some(style) = doc.attr(content, "style") {
                let cleaned = js_trim(&regex!(r"(?i)display\s*:\s*none\s*;?").replace_all(style, "")).to_string();
                if cleaned.is_empty() {
                    doc.remove_attr(content, "style");
                } else {
                    doc.set_attr(content, "style", &cleaned);
                }
            }
        }
    }

    for el in doc.qsa(root, sel!(".markdown-alert")) {
        let kind = doc
            .classes(el)
            .find(|c| c.starts_with("markdown-alert-") && *c != "markdown-alert")
            .map(|c| c["markdown-alert-".len()..].to_string())
            .unwrap_or_else(|| "note".to_string());
        let title = capitalize(&kind);
        if let Some(t) = doc.qs(el, sel!(".markdown-alert-title")) {
            doc.remove(t);
        }
        let c = create_callout(doc, &kind, &title, el);
        doc.replace(el, c);
    }

    for el in doc.qsa(root, sel!("aside[class*=\"callout\"]")) {
        let kind = doc
            .classes(el)
            .find(|c| c.starts_with("callout-"))
            .map(|c| c["callout-".len()..].to_string())
            .unwrap_or_else(|| "note".to_string());
        let title = capitalize(&kind);
        let source = doc.qs(el, sel!(".callout-content")).unwrap_or(el);
        let c = create_callout(doc, &kind, &title, source);
        doc.replace(el, c);
    }

    const ADMONITION_TYPES: &[&str] = &[
        "info", "warning", "note", "tip", "danger", "caution", "important", "abstract", "success",
        "question", "failure", "bug", "example", "quote",
    ];
    for el in doc.qsa(root, sel!(".admonition")) {
        if !doc.get(el, "data-callout").is_empty() {
            continue;
        }
        let kind = doc.classes(el).find(|c| ADMONITION_TYPES.contains(c)).unwrap_or("note").to_string();
        let title_el = doc.qs(el, sel!(".admonition-title"));
        let mut title = title_el.map(|t| doc.trimmed_text(t)).unwrap_or_default();
        if title.is_empty() {
            title = capitalize(&kind);
        }
        if let Some(t) = title_el {
            doc.remove(t);
        }
        let source = doc.qs(el, sel!(".admonition-content")).or_else(|| doc.qs(el, sel!(".details-content"))).unwrap_or(el);
        let c = create_callout(doc, &kind, &title, source);
        doc.replace(el, c);
    }

    for el in doc.qsa(root, sel!(".alert[class*=\"alert-\"]")) {
        let kind = doc
            .classes(el)
            .find(|c| c.starts_with("alert-") && *c != "alert-dismissible")
            .map(|c| c["alert-".len()..].to_string())
            .unwrap_or_else(|| "note".to_string());
        let title_el = doc.qs(el, sel!(".alert-heading, .alert-title"));
        let mut title = title_el.map(|t| doc.trimmed_text(t)).unwrap_or_default();
        if title.is_empty() {
            title = capitalize(&kind);
        }
        if let Some(t) = title_el {
            doc.remove(t);
        }
        let c = create_callout(doc, &kind, &title, el);
        doc.replace(el, c);
    }
}
