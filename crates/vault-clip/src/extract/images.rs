//! Defuddle's `elements/images.ts`: `<picture>` source selection, lazy-load
//! attribute promotion, and figure/caption normalisation.

use super::constants::is_block_level;
use super::util::{js_trim, regex, remove_class, sel, utf16_len, DomExt};
use crate::html::{Document, NodeId};
use crate::value::Value;

pub fn is_base64_placeholder(src: &str) -> bool {
    let Some(c) = regex!(r"^data:image/([^;]+);base64,").captures(src) else {
        return false;
    };
    if &c[1] == "svg+xml" {
        return false;
    }
    let head = utf16_len(&c[0]);
    utf16_len(src) - head < 133
}

fn is_svg_data_url(src: &str) -> bool {
    src.starts_with("data:image/svg+xml")
}

fn is_valid_image_url(src: &str) -> bool {
    if src.starts_with("data:") || js_trim(src).is_empty() {
        return false;
    }
    regex!(r"(?i)\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$").is_match(src)
        || src.contains("image")
        || src.contains("img")
        || src.contains("photo")
}

fn has_better_image_source(doc: &Document, el: NodeId) -> bool {
    if doc.has_attr(el, "data-src") || doc.has_attr(el, "data-srcset") {
        return true;
    }
    for (name, value) in doc.attrs(el) {
        if name == "src" {
            continue;
        }
        if regex!(r"(?i)\.(jpg|jpeg|png|webp|gif)(\?.*)?$").is_match(value) {
            return true;
        }
    }
    false
}

fn is_image_element(doc: &Document, el: NodeId) -> bool {
    matches!(doc.tag_name(el), "img" | "video" | "picture" | "source")
}

fn contains_image(doc: &Document, el: NodeId) -> bool {
    is_image_element(doc, el) || doc.has_tag_desc(el, &["img", "video", "picture", "source"])
}

/// First srcset URL, parsing on descriptors so CDN URLs with commas survive.
pub fn extract_first_url_from_srcset(srcset: &str) -> Option<String> {
    let trimmed = js_trim(srcset);
    if trimmed.is_empty() {
        return None;
    }
    let mut first = true;
    for c in regex!(r"(.+?)\s+(\d+(?:\.\d+)?[wx])").captures_iter(trimmed) {
        let mut url = js_trim(&c[1]).to_string();
        if !first {
            url = regex!(r"^,\s*").replace(&url, "").into_owned();
        }
        first = false;
        if url.is_empty() || is_svg_data_url(&url) {
            continue;
        }
        return Some(url);
    }
    let m = regex!(r"^([^\s]+)").captures(trimmed)?;
    if is_svg_data_url(&m[1]) {
        return None;
    }
    Some(m[1].to_string())
}

fn select_best_source(doc: &Document, sources: &[NodeId]) -> Option<NodeId> {
    match sources.len() {
        0 => return None,
        1 => return Some(sources[0]),
        _ => {}
    }
    if let Some(s) = sources.iter().find(|s| !doc.has_attr(**s, "media")) {
        return Some(*s);
    }
    let mut best = None;
    let mut max = 0.0;
    for &s in sources {
        let Some(srcset) = doc.attr(s, "srcset") else { continue };
        if srcset.is_empty() {
            continue;
        }
        if let Some(w) = regex!(r"\s(\d+)w").captures(srcset) {
            let width: f64 = w[1].parse().unwrap_or(0.0);
            let dpr = regex!(r"dpr=(\d+(?:\.\d+)?)").captures(srcset).and_then(|d| d[1].parse::<f64>().ok()).unwrap_or(1.0);
            let res = width * dpr;
            if res > max {
                max = res;
                best = Some(s);
            }
        }
    }
    best.or(Some(sources[0]))
}

fn apply_srcset(doc: &mut Document, srcset: &str, img: NodeId) {
    doc.set_attr(img, "srcset", srcset);
    if let Some(u) = extract_first_url_from_srcset(srcset) {
        if is_valid_image_url(&u) {
            doc.set_attr(img, "src", &u);
        }
    }
}

pub fn transform_picture(doc: &mut Document, el: NodeId) -> NodeId {
    let sources = doc.by_tag(el, "source");
    let img = doc.qs(el, sel!("img"));
    let Some(img) = img else {
        if let Some(best) = select_best_source(doc, &sources) {
            let srcset = doc.get(best, "srcset").to_string();
            if !srcset.is_empty() {
                let new_img = doc.create_element("img");
                apply_srcset(doc, &srcset, new_img);
                doc.clear_children(el);
                doc.append(el, new_img);
            }
        }
        return el;
    };
    let mut best_srcset = String::new();
    let mut best_src = None;
    if !sources.is_empty() {
        if let Some(best) = select_best_source(doc, &sources) {
            best_srcset = doc.get(best, "srcset").to_string();
            if !best_srcset.is_empty() {
                best_src = extract_first_url_from_srcset(&best_srcset);
            }
        }
    }
    if !best_srcset.is_empty() {
        doc.set_attr(img, "srcset", &best_srcset);
    }
    match best_src {
        Some(ref s) if is_valid_image_url(s) => doc.set_attr(img, "src", s),
        _ => {
            if !doc.has_attr(img, "src") || !is_valid_image_url(doc.get(img, "src")) {
                let from = if !doc.get(img, "srcset").is_empty() { doc.get(img, "srcset").to_string() } else { best_srcset.clone() };
                if let Some(u) = extract_first_url_from_srcset(&from) {
                    if is_valid_image_url(&u) {
                        doc.set_attr(img, "src", &u);
                    }
                }
            }
        }
    }
    for s in sources {
        doc.remove(s);
    }
    el
}

pub fn transform_uni_image(doc: &mut Document, el: NodeId) -> NodeId {
    let figure = doc.create_element("figure");
    let img = doc.create_element("img");
    let Some(orig) = doc.qs(el, sel!("img")) else { return figure };
    let mut best = doc.attr(orig, "src").map(|s| s.to_string());
    if let Some(dl) = doc.attr(orig, "data-loading") {
        if let Some(Value::Object(m)) = Value::parse_json(dl) {
            if let Some(Value::String(d)) = m.get("desktop") {
                if is_valid_image_url(d) {
                    best = Some(d.clone());
                }
            }
        }
    }
    match best {
        Some(ref b) if is_valid_image_url(b) => doc.set_attr(img, "src", b),
        _ => return figure,
    }
    let mut alt = doc.get(orig, "alt").to_string();
    if alt.is_empty() {
        alt = doc.get(el, "alt-text").to_string();
    }
    if !alt.is_empty() {
        doc.set_attr(img, "alt", &alt);
    }
    doc.append(figure, img);
    if let Some(fc) = doc.qs(el, sel!("figcaption")) {
        let text = doc.trimmed_text(fc);
        if utf16_len(&text) > 5 {
            let figcaption = doc.create_element("figcaption");
            if let Some(p) = doc.qs(fc, sel!(".rich-text p")) {
                doc.transfer_children(p, figcaption);
            } else {
                let t = doc.create_text(&text);
                doc.append(figcaption, t);
            }
            doc.append(figure, figcaption);
        }
    }
    figure
}

pub fn transform_lazy_image(doc: &mut Document, el: NodeId) -> NodeId {
    let src = doc.get(el, "src").to_string();
    let better = has_better_image_source(doc, el);
    if (is_base64_placeholder(&src) || is_svg_data_url(&src)) && better {
        doc.remove_attr(el, "src");
    }
    let data_src = doc.get(el, "data-src").to_string();
    if !data_src.is_empty() && doc.get(el, "src").is_empty() {
        doc.set_attr(el, "src", &data_src);
    }
    let data_srcset = doc.get(el, "data-srcset").to_string();
    if !data_srcset.is_empty() && doc.get(el, "srcset").is_empty() {
        doc.set_attr(el, "srcset", &data_srcset);
    }
    let attrs: Vec<(String, String)> = doc.attrs(el).to_vec();
    for (name, _) in attrs {
        if name == "src" || name == "srcset" || name == "alt" {
            continue;
        }
        let value = doc.get(el, &name).to_string();
        if value.starts_with('{') || value.starts_with('[') {
            continue;
        }
        if regex!(r"\.(jpg|jpeg|png|webp)\s+\d").is_match(&value) {
            doc.set_attr(el, "srcset", &value);
        } else if regex!(r"^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$").is_match(&value) {
            let current = doc.get(el, "src");
            let has_abs = regex!(r"^https?://").is_match(current);
            let new_abs = regex!(r"^https?://").is_match(&value);
            if !has_abs || new_abs {
                doc.set_attr(el, "src", &value);
            }
        }
    }
    remove_class(doc, el, &["lazy", "lazyload"]);
    for a in ["data-ll-status", "data-src", "data-srcset", "loading"] {
        doc.remove_attr(el, a);
    }
    el
}

fn find_main_image(doc: &Document, el: NodeId) -> Option<NodeId> {
    if is_image_element(doc, el) {
        return Some(el);
    }
    if let Some(p) = doc.by_tag(el, "picture").first() {
        return Some(*p);
    }
    let imgs = doc.by_tag(el, "img");
    for &img in &imgs {
        let src = doc.get(img, "src");
        let alt = doc.get(img, "alt");
        if is_svg_data_url(src) || is_base64_placeholder(src) {
            continue;
        }
        if js_trim(alt).is_empty() && imgs.len() > 1 {
            continue;
        }
        return Some(img);
    }
    if let Some(v) = doc.by_tag(el, "video").first() {
        return Some(*v);
    }
    if let Some(s) = doc.by_tag(el, "source").first() {
        return Some(*s);
    }
    doc.by_tags(el, &["img", "picture", "source", "video"]).first().copied()
}

/// Caption search; a synthetic alt-text caption is created detached.
fn find_caption(doc: &mut Document, el: NodeId) -> Option<NodeId> {
    if let Some(fc) = doc.qs(el, sel!("figcaption")) {
        return Some(fc);
    }
    let list = sel!("[class*=\"caption\"], [class*=\"description\"], [class*=\"alt\"], [class*=\"title\"], [class*=\"credit\"], [class*=\"text\"], [class*=\"post-thumbnail-text\"], [class*=\"image-caption\"], [class*=\"photo-caption\"], [aria-label], [title]");
    for c in doc.qsa(el, list) {
        if is_image_element(doc, c) {
            continue;
        }
        if !doc.trimmed_text(c).is_empty() {
            return Some(c);
        }
    }
    if let Some(img) = doc.qs(el, sel!("img")) {
        if let Some(alt) = doc.attr(img, "alt") {
            if !js_trim(alt).is_empty() {
                let alt = alt.to_string();
                let div = doc.create_element("div");
                let t = doc.create_text(&alt);
                doc.append(div, t);
                return Some(div);
            }
        }
    }
    if let Some(parent) = doc.parent_element(el) {
        for sib in doc.elem_children(parent) {
            if sib == el {
                continue;
            }
            let has = doc.classes(sib).any(|c| c.contains("caption") || c.contains("credit") || c.contains("text") || c.contains("description"));
            if has && !doc.trimmed_text(sib).is_empty() {
                return Some(sib);
            }
        }
    }
    let imgs = doc.by_tag(el, "img");
    for &img in &imgs {
        if doc.parent_element(img).is_none() {
            continue;
        }
        let mut next = doc.next_element_sibling(img);
        while let Some(n) = next {
            if matches!(doc.tag_name(n), "em" | "strong" | "span" | "i" | "b" | "small" | "cite") && !doc.trimmed_text(n).is_empty() {
                return Some(n);
            }
            next = doc.next_element_sibling(n);
        }
    }
    for &img in &imgs {
        let Some(parent) = doc.parent_element(img) else { continue };
        for t in doc.by_tags(parent, &["em", "strong", "span", "i", "b", "small", "cite"]) {
            if t == img {
                continue;
            }
            if !doc.trimmed_text(t).is_empty() {
                return Some(t);
            }
        }
    }
    None
}

fn unique_caption_content(doc: &Document, caption: NodeId) -> String {
    let mut texts: Vec<String> = Vec::new();
    for n in doc.descendants(caption) {
        if let Some(raw) = doc.text(n) {
            let t = js_trim(raw).to_string();
            if !t.is_empty() && !texts.contains(&t) {
                texts.push(t);
            }
        }
    }
    if !texts.is_empty() {
        return texts.join(" ");
    }
    doc.inner_html(caption)
}

fn meaningful_caption(doc: &Document, caption: NodeId) -> bool {
    let text = doc.trimmed_text(caption);
    if utf16_len(&text) < 10 || text.starts_with("http://") || text.starts_with("https://") {
        return false;
    }
    if regex!(r"(?i)^[\w\-\./\\]+\.(jpg|jpeg|png|gif|webp|svg)$").is_match(&text) {
        return false;
    }
    if regex!(r"^\d+$").is_match(&text) || regex!(r"^\d{4}-\d{2}-\d{2}$").is_match(&text) {
        return false;
    }
    true
}

fn copy_attributes_except(doc: &mut Document, from: NodeId, to: NodeId, except: &[&str]) {
    for (k, v) in doc.attrs(from).to_vec() {
        if !except.contains(&k.as_str()) {
            doc.set_attr(to, &k, &v);
        }
    }
}

fn process_img_element(doc: &mut Document, el: NodeId) -> NodeId {
    let src = doc.get(el, "src").to_string();
    if is_base64_placeholder(&src) || is_svg_data_url(&src) {
        if let Some(parent) = doc.parent_element(el) {
            let has_sources = doc.by_tag(parent, "source").iter().any(|s| doc.attr(*s, "data-srcset").is_some_and(|v| !v.is_empty()));
            if has_sources {
                let new_img = doc.create_element("img");
                let data_src = doc.get(el, "data-src").to_string();
                if !data_src.is_empty() && !is_svg_data_url(&data_src) {
                    doc.set_attr(new_img, "src", &data_src);
                }
                copy_attributes_except(doc, el, new_img, &["src"]);
                return new_img;
            }
        }
    }
    doc.clone_subtree(el)
}

fn process_source_element(doc: &mut Document, el: NodeId) -> NodeId {
    let new_img = doc.create_element("img");
    let srcset = doc.get(el, "srcset").to_string();
    if !srcset.is_empty() {
        apply_srcset(doc, &srcset, new_img);
    }
    if let Some(parent) = doc.parent_element(el) {
        let good: Vec<NodeId> = doc
            .by_tag(parent, "img")
            .into_iter()
            .filter(|i| {
                let s = doc.get(*i, "src");
                !is_base64_placeholder(s) && !is_svg_data_url(s) && !s.is_empty()
            })
            .collect();
        if let Some(&first) = good.first() {
            copy_attributes_except(doc, first, new_img, &["src", "srcset"]);
            if !doc.has_attr(new_img, "src") || !is_valid_image_url(doc.get(new_img, "src")) {
                let s = doc.get(first, "src").to_string();
                if is_valid_image_url(&s) {
                    doc.set_attr(new_img, "src", &s);
                }
            }
        } else if let Some(ds) = doc.qs(parent, sel!("img[data-src]")) {
            copy_attributes_except(doc, ds, new_img, &["src", "srcset"]);
            if !doc.has_attr(new_img, "src") || !is_valid_image_url(doc.get(new_img, "src")) {
                let s = doc.get(ds, "data-src").to_string();
                if is_valid_image_url(&s) {
                    doc.set_attr(new_img, "src", &s);
                }
            }
        }
    }
    new_img
}

fn process_image_element(doc: &mut Document, el: NodeId) -> NodeId {
    match doc.tag_name(el) {
        "img" => process_img_element(doc, el),
        "picture" => match doc.qs(el, sel!("img")) {
            Some(img) => process_img_element(doc, img),
            None => doc.clone_subtree(el),
        },
        "source" => process_source_element(doc, el),
        _ => doc.clone_subtree(el),
    }
}

fn figure_with_caption(doc: &mut Document, image: NodeId, caption: NodeId) -> NodeId {
    let figure = doc.create_element("figure");
    let img = doc.clone_subtree(image);
    doc.append(figure, img);
    let figcaption = doc.create_element("figcaption");
    let content = unique_caption_content(doc, caption);
    doc.append_html(figcaption, &content);
    doc.append(figure, figcaption);
    figure
}

pub fn transform_span_with_image(doc: &mut Document, el: NodeId) -> NodeId {
    if !contains_image(doc, el) {
        return el;
    }
    if doc.elem_children(el).iter().any(|c| is_block_level(doc.tag_name(*c))) {
        return el;
    }
    let Some(img) = find_main_image(doc, el) else { return el };
    let caption = find_caption(doc, el);
    let processed = process_image_element(doc, img);
    match caption {
        Some(c) if meaningful_caption(doc, c) => {
            let figure = figure_with_caption(doc, processed, c);
            doc.remove(c);
            figure
        }
        _ => processed,
    }
}

pub fn transform_figure(doc: &mut Document, el: NodeId) -> NodeId {
    if !contains_image(doc, el) {
        return el;
    }
    let Some(img) = find_main_image(doc, el) else { return el };
    let caption = find_caption(doc, el);
    match caption {
        Some(c) if meaningful_caption(doc, c) => {
            let image = match find_main_image(doc, el) {
                Some(cur) => cur,
                None => process_image_element(doc, img),
            };
            figure_with_caption(doc, image, c)
        }
        _ => el,
    }
}
