//! Defuddle's `elements/math.base.ts` + `math.core.ts`: every math flavour
//! (MathML, MathJax v2/v3, KaTeX, MediaWiki, WordPress LaTeX images, raw
//! `$…$` delimiters) becomes `<math display="…" data-latex="…">`.
//!
//! Departure: Defuddle's Node build (`math.full.ts`) converts MathML to LaTeX
//! with `mathml-to-latex` when no TeX source exists, and renders LaTeX-only
//! math to MathML with `temml`. Neither library is ported; like the browser
//! core bundle, a LaTeX-only formula keeps its TeX as the element's text and
//! MathML without a TeX annotation keeps an empty `data-latex`.

use super::util::{decode_uri_component, js_trim, regex, sel, DomExt};
use crate::html::{Document, NodeData, NodeId};

pub fn looks_like_latex(s: &str) -> bool {
    regex!(r"\\[a-zA-Z]{2,}").is_match(s)
}

pub const MATH_FAST_CHECK: &str = "math, mjx-container, .MathJax, .katex, img.latex, [data-math], [data-latex], script[type^=\"math/\"]";

pub const MATH_SELECTORS: &str = "img.latex[src*=\"latex.php\"],span.MathJax,mjx-container,script[type=\"math/tex\"],script[type=\"math/tex; mode=display\"],.MathJax_Preview + script[type=\"math/tex\"],.MathJax_Display,.MathJax_SVG,.MathJax_MathML,.mwe-math-element,.mwe-math-fallback-image-inline,.mwe-math-fallback-image-display,.mwe-math-mathml-inline,.mwe-math-mathml-display,.katex,.katex-display,.katex-mathml,.katex-html,[data-katex],script[type=\"math/katex\"],math,[data-math],[data-latex],[data-tex],script[type^=\"math/\"],annotation[encoding=\"application/x-tex\"]";

/// Detached `<math>` subtree plus what was learned about it.
pub struct MathData {
    pub mathml: NodeId,
    pub latex: Option<String>,
}

fn flatten_tagged_equation_tables(doc: &mut Document, math: NodeId) {
    for table in doc.by_tag(math, "mtable") {
        let rows: Vec<NodeId> = doc.elem_children(table).into_iter().filter(|c| matches!(doc.tag_name(*c), "mtr" | "mlabeledtr")).collect();
        if rows.len() != 1 || doc.tag(rows[0]) != Some("mlabeledtr") {
            continue;
        }
        let cells: Vec<NodeId> = doc.elem_children(rows[0]).into_iter().filter(|c| doc.tag(*c) == Some("mtd")).collect();
        if cells.len() < 2 {
            continue;
        }
        let replacement = doc.create_element("mrow");
        for &cell in &cells[1..] {
            doc.transfer_children(cell, replacement);
        }
        if !doc.children(cells[0]).is_empty() {
            let spacer = doc.create_element("mspace");
            doc.set_attr(spacer, "width", "2em");
            doc.append(replacement, spacer);
            doc.transfer_children(cells[0], replacement);
        }
        doc.replace(table, replacement);
    }
}

fn normalized_clone(doc: &mut Document, math: NodeId) -> NodeId {
    let c = doc.clone_subtree(math);
    flatten_tagged_equation_tables(doc, c);
    c
}

// ---- MathJax CHTML reconstruction ------------------------------------------------

fn normalize_glyphs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\u{2061}' | '\u{2062}' | '\u{2063}' | '\u{2064}') {
            continue;
        }
        out.push(fold_math_alnum(c));
    }
    out
}

/// NFKC for the Mathematical Alphanumeric Symbols block (the part MathJax
/// glyphs use): bold/italic/script Latin and Greek fold to plain letters.
fn fold_math_alnum(c: char) -> char {
    let cp = c as u32;
    if !(0x1D400..=0x1D7FF).contains(&cp) {
        return match c {
            '\u{210E}' => 'h',
            _ => c,
        };
    }
    if cp <= 0x1D6A3 {
        let off = (cp - 0x1D400) % 52;
        let ch = if off < 26 { b'A' + off as u8 } else { b'a' + (off - 26) as u8 };
        return ch as char;
    }
    if (0x1D7CE..=0x1D7FF).contains(&cp) {
        return char::from(b'0' + ((cp - 0x1D7CE) % 10) as u8);
    }
    if (0x1D6A8..=0x1D7C9).contains(&cp) {
        let off = (cp - 0x1D6A8) % 58;
        // 25 capitals (Α..Ω incl. ϴ), ∇, 25 smalls, ∂ and variants.
        let base = if off < 25 { 0x391 + off } else if off == 25 { return '∇' } else if off < 51 { 0x3B1 + off - 26 } else { return c };
        return char::from_u32(base).unwrap_or(c);
    }
    c
}

fn wrap_parts(doc: &mut Document, parts: Vec<NodeId>) -> NodeId {
    if parts.len() == 1 {
        return parts[0];
    }
    let mrow = doc.create_element("mrow");
    for p in parts {
        doc.append(mrow, p);
    }
    mrow
}

fn build_el(doc: &mut Document, name: &str, children: Vec<NodeId>) -> NodeId {
    let el = doc.create_element(name);
    for c in children {
        doc.append(el, c);
    }
    el
}

fn flatten_mjx(doc: &mut Document, node: Option<NodeId>, skip: Option<NodeId>) -> Vec<NodeId> {
    let Some(node) = node else { return vec![] };
    let mut out = Vec::new();
    for child in doc.elem_children(node) {
        if Some(child) == skip {
            continue;
        }
        out.extend(convert_mjx(doc, child));
    }
    out
}

fn direct_child(doc: &Document, node: NodeId, tag: &str) -> Option<NodeId> {
    doc.elem_children(node).into_iter().find(|c| doc.tag(*c) == Some(tag))
}

fn convert_mjx(doc: &mut Document, node: NodeId) -> Vec<NodeId> {
    let tag = doc.tag_name(node).to_string();
    if tag == "mjx-c" {
        let t = normalize_glyphs(&doc.tc(node));
        return if t.is_empty() { vec![] } else { vec![doc.create_text(&t)] };
    }
    if matches!(tag.as_str(), "mjx-nstrut" | "mjx-dstrut" | "mjx-strut" | "mjx-line" | "mjx-spacer" | "mjx-break" | "mjx-mark") {
        return vec![];
    }
    let Some(name) = tag.strip_prefix("mjx-") else { return vec![] };
    let name = name.to_string();
    if matches!(name.as_str(), "mi" | "mo" | "mn" | "mtext" | "ms" | "mspace" | "mglyph") {
        let t = normalize_glyphs(&doc.tc(node));
        if t.is_empty() && name != "mspace" {
            return vec![];
        }
        let el = doc.create_element(&name);
        if !t.is_empty() {
            let tn = doc.create_text(&t);
            doc.append(el, tn);
        }
        return vec![el];
    }
    if matches!(name.as_str(), "mrow" | "mstyle" | "mpadded" | "mphantom" | "menclose" | "merror" | "mtable" | "mtr" | "mtd" | "mlabeledtr") {
        let kids = flatten_mjx(doc, Some(node), None);
        return vec![build_el(doc, &name, kids)];
    }
    match name.as_str() {
        "mfrac" => {
            let num_node = doc.qs(node, sel!("mjx-num"));
            let den_node = doc.qs(node, sel!("mjx-den"));
            let n = flatten_mjx(doc, num_node, None);
            let num = wrap_parts(doc, n);
            let d = flatten_mjx(doc, den_node, None);
            let den = wrap_parts(doc, d);
            vec![build_el(doc, "mfrac", vec![num, den])]
        }
        "msqrt" => {
            let b = doc.qs(node, sel!("mjx-box")).or(Some(node));
            let kids = flatten_mjx(doc, b, None);
            vec![build_el(doc, "msqrt", kids)]
        }
        "msub" | "msup" => {
            let script = direct_child(doc, node, "mjx-script");
            let b = flatten_mjx(doc, Some(node), script);
            let base = wrap_parts(doc, b);
            let s = flatten_mjx(doc, script, None);
            let sup = wrap_parts(doc, s);
            vec![build_el(doc, &name, vec![base, sup])]
        }
        "msubsup" => {
            let script = direct_child(doc, node, "mjx-script");
            let b = flatten_mjx(doc, Some(node), script);
            let base = wrap_parts(doc, b);
            let parts = flatten_mjx(doc, script, None);
            let sub = if parts.len() > 1 { parts[parts.len() - 1] } else { parts.first().copied().unwrap_or_else(|| doc.create_element("mrow")) };
            let sup = if parts.len() > 1 { parts[0] } else { doc.create_element("mrow") };
            vec![build_el(doc, "msubsup", vec![base, sub, sup])]
        }
        "munder" | "mover" | "munderover" => {
            let base_node = doc.qs(node, sel!("mjx-base"));
            let bp = flatten_mjx(doc, base_node, None);
            let base = wrap_parts(doc, bp);
            let under = doc.qs(node, sel!("mjx-under"));
            let over = doc.qs(node, sel!("mjx-over"));
            let u = flatten_mjx(doc, under, None);
            let o = flatten_mjx(doc, over, None);
            match name.as_str() {
                "munder" => {
                    let w = wrap_parts(doc, u);
                    vec![build_el(doc, "munder", vec![base, w])]
                }
                "mover" => {
                    let w = wrap_parts(doc, o);
                    vec![build_el(doc, "mover", vec![base, w])]
                }
                _ => {
                    let wu = wrap_parts(doc, u);
                    let wo = wrap_parts(doc, o);
                    vec![build_el(doc, "munderover", vec![base, wu, wo])]
                }
            }
        }
        _ => flatten_mjx(doc, Some(node), None),
    }
}

fn reconstruct_from_mjx(doc: &mut Document, mjx_math: NodeId) -> Option<NodeId> {
    let math = doc.create_element("math");
    doc.set_attr(math, "xmlns", "http://www.w3.org/1998/Math/MathML");
    for child in doc.elem_children(mjx_math) {
        for n in convert_mjx(doc, child) {
            doc.append(math, n);
        }
    }
    if doc.children(math).is_empty() {
        return None;
    }
    if doc.get(mjx_math, "display") == "true" {
        doc.set_attr(math, "display", "block");
    }
    Some(math)
}

pub fn mathml_from_element(doc: &mut Document, el: NodeId) -> Option<MathData> {
    if doc.tag(el) == Some("math") {
        let latex = doc.attr(el, "alttext").filter(|s| !s.is_empty()).map(str::to_string);
        return Some(MathData { mathml: normalized_clone(doc, el), latex });
    }
    let data_mathml = doc.get(el, "data-mathml").to_string();
    if !data_mathml.is_empty() {
        let holder = doc.create_element("div");
        doc.append_html(holder, &data_mathml);
        if let Some(m) = doc.qs(holder, sel!("math")) {
            let latex = doc.attr(m, "alttext").filter(|s| !s.is_empty()).map(str::to_string);
            return Some(MathData { mathml: normalized_clone(doc, m), latex });
        }
    }
    if let Some(container) = doc.qs(el, sel!(".MJX_Assistive_MathML, mjx-assistive-mml")) {
        if let Some(m) = doc.qs(container, sel!("math")) {
            let latex = doc.attr(m, "alttext").filter(|s| !s.is_empty()).map(str::to_string);
            return Some(MathData { mathml: normalized_clone(doc, m), latex });
        }
    }
    if let Some(m) = doc.qs(el, sel!(".katex-mathml math")) {
        return Some(MathData { mathml: normalized_clone(doc, m), latex: None });
    }
    let mjx = if doc.tag(el) == Some("mjx-math") { Some(el) } else { doc.qs(el, sel!("mjx-math")) };
    if let Some(mj) = mjx {
        if let Some(m) = reconstruct_from_mjx(doc, mj) {
            return Some(MathData { mathml: m, latex: None });
        }
    }
    None
}

pub fn basic_latex_from_element(doc: &Document, el: NodeId) -> Option<String> {
    for a in ["data-latex", "data-math"] {
        let v = doc.get(el, a);
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    if let Some(p) = doc.parent_element(el) {
        if doc.has_class(p, "hurmet-tex") {
            let e = doc.get(p, "data-entry");
            if !e.is_empty() {
                return Some(e.to_string());
            }
        }
    }
    if doc.tag(el) == Some("img") && doc.has_class(el, "latex") {
        let alt = doc.get(el, "alt");
        if !alt.is_empty() {
            return Some(alt.to_string());
        }
        let src = doc.get(el, "src");
        if let Some(c) = regex!(r"latex\.php\?latex=([^&]+)").captures(src) {
            if let Some(d) = decode_uri_component(&c[1]) {
                return Some(d.replace('+', " ").replace("%5C", "\\"));
            }
        }
    }
    if let Some(a) = doc.qs(el, sel!("annotation[encoding=\"application/x-tex\"]")) {
        let t = doc.tc(a);
        if !t.is_empty() {
            return Some(js_trim(&t).to_string());
        }
    }
    if doc.has_class(el, "katex") {
        if let Some(a) = doc.qs(el, sel!(".katex-mathml annotation[encoding=\"application/x-tex\"]")) {
            let t = doc.tc(a);
            if !t.is_empty() {
                return Some(js_trim(&t).to_string());
            }
        }
    }
    if doc.is(el, sel!("script[type=\"math/tex\"], script[type=\"math/tex; mode=display\"]")) {
        let t = js_trim(&doc.tc(el)).to_string();
        return if t.is_empty() { None } else { Some(t) };
    }
    if let Some(p) = doc.parent_element(el) {
        if let Some(s) = doc.qs(p, sel!("script[type=\"math/tex\"], script[type=\"math/tex; mode=display\"]")) {
            let t = js_trim(&doc.tc(s)).to_string();
            return if t.is_empty() { None } else { Some(t) };
        }
    }
    if doc.tag(el) == Some("math") {
        let t = js_trim(&doc.tc(el)).to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    let alt = doc.get(el, "alt");
    if alt.is_empty() {
        None
    } else {
        Some(alt.to_string())
    }
}

pub fn is_block_display(doc: &Document, el: NodeId) -> bool {
    if doc.get(el, "display") == "block" {
        return true;
    }
    let class = doc.class_name(el).to_lowercase();
    if class.contains("display") || class.contains("block") {
        return true;
    }
    if doc.closest_sel(el, sel!(".katex-display, .MathJax_Display, [data-display=\"block\"]")).is_some() {
        return true;
    }
    if doc.prev_element_sibling(el).is_some_and(|p| doc.tag(p) == Some("p")) {
        return true;
    }
    if doc.has_class(el, "mwe-math-fallback-image-display") {
        return true;
    }
    if doc.has_class(el, "katex") {
        return doc.closest_sel(el, sel!(".katex-display")).is_some();
    }
    if doc.has_attr(el, "display") {
        return doc.get(el, "display") == "true";
    }
    if doc.is(el, sel!("script[type=\"math/tex; mode=display\"]")) {
        return true;
    }
    if let Some(c) = doc.closest_sel(el, sel!("[display]")) {
        return doc.get(c, "display") == "true";
    }
    false
}

pub fn create_clean_math(doc: &mut Document, data: Option<&MathData>, latex: Option<&str>, block: bool) -> NodeId {
    let m = doc.create_element("math");
    doc.set_attr(m, "xmlns", "http://www.w3.org/1998/Math/MathML");
    doc.set_attr(m, "display", if block { "block" } else { "inline" });
    doc.set_attr(m, "data-latex", latex.unwrap_or(""));
    if let Some(d) = data {
        doc.transfer_children(d.mathml, m);
    } else if let Some(l) = latex.filter(|l| !l.is_empty()) {
        let t = doc.create_text(l);
        doc.append(m, t);
    }
    m
}

pub fn transform_math(doc: &mut Document, el: NodeId) -> NodeId {
    let data = mathml_from_element(doc, el);
    // Departure: where Defuddle's Node build would run mathml-to-latex, use the
    // MathML `alttext` (usually the author's TeX) instead of an empty string.
    let latex = basic_latex_from_element(doc, el).or_else(|| data.as_ref().and_then(|d| d.latex.clone()));
    let block = is_block_display(doc, el);
    let clean = create_clean_math(doc, data.as_ref(), latex.as_deref(), block);
    if let Some(p) = doc.parent_element(el) {
        if !doc.is(el, sel!("script[type^=\"math/\"]")) {
            for s in doc.qsa(p, sel!("script[type^=\"math/\"], .MathJax_Preview, script[type=\"text/javascript\"][src*=\"mathjax\"], script[type=\"text/javascript\"][src*=\"katex\"]")) {
                doc.remove(s);
            }
        }
    }
    clean
}

// ---- raw LaTeX delimiters and LaTeX images -------------------------------------------

fn has_math_library(doc: &Document) -> bool {
    for s in doc.qsa(0, sel!("script[src]")) {
        let src = doc.get(s, "src").to_lowercase();
        if src.contains("mathjax") || src.contains("katex") {
            return true;
        }
    }
    for s in doc.qsa(0, sel!("script:not([src])")) {
        let t = doc.tc(s);
        if regex!(r"MathJax\s*[.=]").is_match(&t) || t.to_lowercase().contains("katex") {
            return true;
        }
    }
    false
}

/// `library_doc` is the page (for the MathJax/KaTeX presence gate).
pub fn wrap_raw_latex_delimiters(doc: &mut Document, element: NodeId, has_library: bool) {
    if !has_library {
        return;
    }
    if doc.qs(element, sel!(MATH_FAST_CHECK)).is_some() {
        return;
    }
    let mut text_nodes = Vec::new();
    let mut stack = vec![element];
    while let Some(n) = stack.pop() {
        match &doc.node(n).data {
            NodeData::Text(_) => text_nodes.push(n),
            NodeData::Element { name, .. } => {
                if n != element && matches!(name.as_str(), "pre" | "code" | "script" | "style" | "math" | "svg" | "textarea") {
                    continue;
                }
                for c in doc.children(n).iter().rev() {
                    stack.push(*c);
                }
            }
            _ => {}
        }
    }
    let re = regex!(r"\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^\s$][^$]*[^\s$]|[^\s$])\$|\\\(([\s\S]+?)\\\)");
    for tn in text_nodes {
        let text = doc.text(tn).unwrap_or("").to_string();
        if !text.contains('$') && !text.contains("\\(") && !text.contains("\\[") {
            continue;
        }
        enum Part {
            Text(String),
            Math(String, bool),
        }
        let mut parts: Vec<Part> = Vec::new();
        let mut last = 0;
        let mut has_block = false;
        for c in re.captures_iter(&text) {
            let whole = c.get(0).unwrap();
            let block = c.get(1).or(c.get(2));
            let inline = c.get(3).or(c.get(4));
            let is_block = block.is_some();
            let latex = js_trim(block.or(inline).map(|m| m.as_str()).unwrap_or("")).to_string();
            let backslash = c.get(2).is_some() || c.get(4).is_some();
            if !backslash && !(regex!(r"\\[a-zA-Z]").is_match(&latex) || regex!(r"[_^{}]").is_match(&latex)) {
                continue;
            }
            if last < whole.start() {
                parts.push(Part::Text(text[last..whole.start()].to_string()));
            }
            if is_block {
                has_block = true;
            }
            parts.push(Part::Math(latex, is_block));
            last = whole.end();
        }
        if parts.is_empty() {
            continue;
        }
        if last < text.len() {
            parts.push(Part::Text(text[last..].to_string()));
        }
        if has_block {
            let surrounding = parts.iter().any(|p| matches!(p, Part::Text(t) if !js_trim(t).is_empty()));
            let parent_other = doc.parent_element(tn).is_some_and(|p| {
                doc.children(p).iter().any(|n| *n != tn && (doc.is_element(*n) || doc.text(*n).is_some_and(|t| !js_trim(t).is_empty())))
            });
            if surrounding || parent_other {
                for p in parts.iter_mut() {
                    if let Part::Math(_, b) = p {
                        *b = false;
                    }
                }
            }
        }
        let mut new_nodes = Vec::new();
        for p in parts {
            match p {
                Part::Text(t) => new_nodes.push(doc.create_text(&t)),
                Part::Math(l, b) => {
                    let m = doc.create_element("math");
                    doc.set_attr(m, "xmlns", "http://www.w3.org/1998/Math/MathML");
                    doc.set_attr(m, "display", if b { "block" } else { "inline" });
                    doc.set_attr(m, "data-latex", &l);
                    let t = doc.create_text(&l);
                    doc.append(m, t);
                    new_nodes.push(m);
                }
            }
        }
        doc.replace_with_nodes(tn, &new_nodes);
    }
}

pub fn page_has_math_library(doc: &Document) -> bool {
    has_math_library(doc)
}

fn decode_latex(raw: &str) -> Option<String> {
    let d = decode_uri_component(&raw.replace('+', " "))?;
    if looks_like_latex(&d) {
        Some(d)
    } else {
        None
    }
}

pub fn latex_from_image_src(src: &str) -> Option<String> {
    for re in [
        regex!(r"(?i)[?&]latex=([^&#]+)"),
        regex!(r"(?i)[?&]chl=([^&#]+)"),
        regex!(r"(?i)[?&]tex=([^&#]+)"),
        regex!(r"(?i)[?&]eq=([^&#]+)"),
        regex!(r"(?i)[?&]math=([^&#]+)"),
    ] {
        if let Some(c) = re.captures(src) {
            if let Some(l) = decode_latex(&c[1]) {
                return Some(l);
            }
        }
    }
    if let Some(c) = regex!(r"\?([^#]+)").captures(src) {
        if let Some(l) = decode_latex(&c[1]) {
            return Some(l);
        }
    }
    let path = src.split('?').next().unwrap_or("");
    for seg in path.split('/').rev() {
        if seg.contains("%5C") || seg.contains("%5c") {
            if let Some(l) = decode_latex(seg) {
                return Some(l);
            }
        }
    }
    None
}

pub fn convert_latex_images(doc: &mut Document, element: NodeId) {
    for img in doc.qsa(element, sel!("img[src]")) {
        let src = doc.get(img, "src").to_string();
        if src.is_empty() {
            continue;
        }
        let mut latex = latex_from_image_src(&src);
        if latex.is_none() {
            let alt = doc.get(img, "alt");
            if looks_like_latex(alt) {
                latex = Some(alt.to_string());
            }
        }
        let Some(latex) = latex else { continue };
        let block = latex.contains("\\begin{")
            || doc.parent_element(img).is_some_and(|p| doc.tag(p) == Some("p") && doc.children(p).len() == 1);
        let m = create_clean_math(doc, None, Some(&latex), block);
        doc.replace(img, m);
    }
}
