//! Defuddle's `standardize.ts`: the element rules (math, code, headings,
//! images, ARIA lists) and the clean-up passes that give every page the same
//! shape — attribute stripping, wrapper flattening, empty-node and `<br>`
//! removal, whitespace normalisation.
//!
//! Where Defuddle asks `getComputedStyle`, this port answers as Defuddle does
//! under linkedom (no layout): nothing is known to be `display: block`.

use super::code::{transform_code_block, CODE_BLOCK_SELECTOR};
use super::constants::*;
use super::headings::{is_permalink_anchor, remove_permalink_anchors, transform_heading};
use super::images::{transform_figure, transform_lazy_image, transform_picture, transform_span_with_image, transform_uni_image};
use super::math::{convert_latex_images, transform_math, wrap_raw_latex_delimiters, MATH_FAST_CHECK, MATH_SELECTORS};
use super::util::{js_trim, normalize_text, regex, sel, DomExt};
use crate::html::{Document, NodeData, NodeId};

pub struct Options<'a> {
    pub title: &'a str,
    /// The page loads MathJax or KaTeX (gates raw `$…$` detection).
    pub has_math_library: bool,
}

pub fn standardize_content(doc: &mut Document, el: NodeId, opts: &Options) {
    standardize_drop_caps(doc, el);
    standardize_spaces(doc, el);
    remove_html_comments(doc, el);
    standardize_headings(doc, el, opts.title);
    wrap_preformatted_code(doc, el);
    standardize_elements(doc, el, opts.has_math_library);
    resolve_svg_colors(doc, el);
    replace_custom_elements(doc, el);
    convert_data_as_spans(doc, el);
    convert_block_spans(doc, el);
    unwrap_layout_tables(doc, el);
    flatten_wrapper_elements(doc, el);
    remove_permalink_anchors(doc, el);
    strip_unwanted_attributes(doc, el);
    unwrap_bare_spans(doc, el);
    unwrap_special_links(doc, el);
    for o in doc.qsa(el, sel!("object, embed, applet")) {
        doc.remove(o);
    }
    remove_empty_elements(doc, el);
    remove_trailing_headings(doc, el);
    remove_orphaned_dividers(doc, el);
    flatten_wrapper_elements(doc, el);
    remove_orphaned_dividers(doc, el);
    strip_extra_br_elements(doc, el);
    remove_empty_lines(doc, el);
}

/// Only the element rules: used for fragments that skip content selection.
pub fn standardize_elements_only(doc: &mut Document, el: NodeId, has_math_library: bool) {
    standardize_elements(doc, el, has_math_library);
}

fn is_text_ws(doc: &Document, n: NodeId) -> bool {
    doc.text(n).is_some_and(|t| js_trim(t).is_empty())
}

fn unwrap(doc: &mut Document, el: NodeId) {
    let kids = doc.children(el).to_vec();
    doc.replace_with_nodes(el, &kids);
}

fn standardize_drop_caps(doc: &mut Document, root: NodeId) {
    let caps = doc.qsa(root, sel!("span[data-caps=\"initial\"]"));
    let mut count = 0;
    for span in caps {
        if !doc.has_parent(span) {
            continue;
        }
        let next = doc.next_element_sibling(span);
        if let Some(n) = next.filter(|n| doc.tag(*n) == Some("small")) {
            let merged = doc.tc(span) + &doc.tc(n);
            let t = doc.create_text(&merged);
            doc.insert_before(span, t);
            doc.remove(n);
            doc.remove(span);
        } else {
            unwrap(doc, span);
        }
        count += 1;
    }
    if count > 0 {
        doc.normalize(root);
    }
}

fn standardize_spaces(doc: &mut Document, root: NodeId) {
    let mut stack = vec![root];
    while let Some(n) = stack.pop() {
        match &doc.node(n).data {
            NodeData::Element { name, .. } => {
                if name == "pre" || name == "code" || name == "svg" || doc.is_svg(n) {
                    continue;
                }
                stack.extend(doc.children(n).iter().copied());
            }
            NodeData::Text(t) => {
                if t.contains('\u{a0}') {
                    let nt = t.replace('\u{a0}', " ");
                    doc.set_text(n, &nt);
                }
            }
            _ => {}
        }
    }
}

fn remove_html_comments(doc: &mut Document, root: NodeId) {
    for n in doc.descendants(root) {
        if matches!(doc.node(n).data, NodeData::Comment(_)) {
            doc.remove(n);
        }
    }
}

fn standardize_headings(doc: &mut Document, root: NodeId, title: &str) {
    for h1 in doc.by_tag(root, "h1") {
        let h2 = doc.create_element("h2");
        doc.transfer_children(h1, h2);
        for (k, v) in doc.attrs(h1).to_vec() {
            if is_allowed_attribute(&k) {
                doc.set_attr(h2, &k, &v);
            }
        }
        doc.replace(h1, h2);
    }
    if let Some(first) = doc.by_tag(root, "h2").first().copied() {
        let mut permalink = String::new();
        for a in doc.by_tag(first, "a") {
            if is_permalink_anchor(doc, a) {
                permalink.push_str(&doc.tc(a));
            }
        }
        let text = doc.tc(first).replacen(&permalink, "", 1);
        let nt = normalize_text(title);
        if !nt.is_empty() && nt == normalize_text(&text) {
            doc.remove(first);
        }
    }
}

fn wrap_preformatted_code(doc: &mut Document, root: NodeId) {
    for code in doc.by_tag(root, "code") {
        if doc.closest_tags(code, &["pre"]).is_some() {
            continue;
        }
        if !regex!(r"white-space\s*:\s*pre").is_match(doc.get(code, "style")) {
            continue;
        }
        let pre = doc.create_element("pre");
        doc.insert_before(code, pre);
        doc.append(pre, code);
    }
}

type Transform = fn(&mut Document, NodeId) -> NodeId;

fn apply_rule(doc: &mut Document, root: NodeId, list: &crate::selector::SelectorList, f: Transform) {
    for el in doc.qsa(root, list) {
        // A match inside an already-replaced subtree would be replaced in a
        // detached tree — a DOM no-op — so skip the work.
        if !doc.contains(root, el) {
            continue;
        }
        let t = f(doc, el);
        doc.replace(el, t);
    }
}

fn standardize_elements(doc: &mut Document, root: NodeId, has_math_library: bool) {
    wrap_raw_latex_delimiters(doc, root, has_math_library);
    convert_latex_images(doc, root);

    if doc.qs(root, sel!(MATH_FAST_CHECK)).is_some() {
        apply_rule(doc, root, sel!(MATH_SELECTORS), transform_math);
    }
    apply_rule(doc, root, sel!(CODE_BLOCK_SELECTOR), transform_code_block);
    apply_rule(doc, root, sel!("h1, h2, h3, h4, h5, h6"), transform_heading);
    apply_rule(doc, root, sel!("picture"), transform_picture);
    apply_rule(doc, root, sel!("uni-image-full-width"), transform_uni_image);
    apply_rule(
        doc,
        root,
        sel!("img[data-src], img[data-srcset], img[loading=\"lazy\"], img.lazy, img.lazyload, img[src^=\"data:image/svg+xml\"]"),
        transform_lazy_image,
    );
    apply_rule(doc, root, sel!("span:has(img)"), transform_span_with_image);
    apply_rule(doc, root, sel!("figure, p:has([class*=\"caption\"])"), transform_figure);
    apply_rule(doc, root, sel!("div[data-testid^=\"paragraph\"], div[role=\"paragraph\"]"), transform_paragraph_div);
    apply_rule(doc, root, sel!("div[role=\"list\"]"), transform_role_list);
    apply_rule(doc, root, sel!("div[role=\"listitem\"]"), transform_role_listitem);

    for pre in doc.qsa(root, sel!("code > pre")) {
        if let Some(outer) = doc.parent_element(pre) {
            if doc.tag(outer) == Some("code") {
                doc.replace(outer, pre);
            }
        }
    }

    for table in doc.qsa(root, sel!("table.ltx_equation, table.ltx_eqn_table, table.ltx_equationgroup")) {
        let maths = doc.by_tag(table, "math");
        if maths.is_empty() {
            continue;
        }
        let mut nodes = Vec::new();
        for m in maths {
            let alt = doc.get(m, "alttext").to_string();
            let latex = if !alt.is_empty() {
                alt
            } else {
                doc.qs(m, sel!("annotation[encoding=\"application/x-tex\"]")).map(|a| js_trim(&doc.tc(a)).to_string()).unwrap_or_default()
            };
            if latex.is_empty() {
                continue;
            }
            let block = doc.get(m, "display") == "block" || doc.has_class(table, "ltx_equation") || doc.has_class(table, "ltx_equationgroup");
            let clean = doc.create_element("math");
            doc.set_attr(clean, "xmlns", "http://www.w3.org/1998/Math/MathML");
            doc.set_attr(clean, "display", if block { "block" } else { "inline" });
            doc.set_attr(clean, "data-latex", &latex);
            let t = doc.create_text(&latex);
            doc.append(clean, t);
            nodes.push(clean);
        }
        if !nodes.is_empty() {
            doc.replace_with_nodes(table, &nodes);
        }
    }

    for outer in doc.qsa(root, sel!("span.ltx_note_outer")) {
        doc.remove(outer);
    }
    for link in doc.qsa(root, sel!("a.ltx_ref")) {
        if doc.qs(link, sel!("span.ltx_ref_tag, span.ltx_text.ltx_ref_tag")).is_some() {
            let t = doc.tc(link);
            let tn = doc.create_text(&t);
            doc.replace(link, tn);
        }
    }

    for table in doc.by_tag(root, "table") {
        if !doc.has_parent(table) {
            continue;
        }
        let cells = doc.by_tags(table, &["td", "th"]);
        if !cells.is_empty()
            && cells.iter().all(|c| js_trim(&doc.tc(*c)).is_empty())
            && !doc.has_tag_desc(table, &["img", "picture", "video", "audio", "iframe", "svg", "math"])
        {
            doc.remove(table);
        }
    }

    for table in doc.by_tag(root, "table") {
        if !doc.has_parent(table) {
            continue;
        }
        let direct_cells: Vec<NodeId> = doc.by_tags(table, &["td", "th"]).into_iter().filter(|c| is_direct_table_child(doc, *c, table)).collect();
        if direct_cells.iter().any(|c| doc.tag(*c) == Some("th")) {
            continue;
        }
        let rows: Vec<NodeId> = doc.by_tag(table, "tr").into_iter().filter(|r| is_direct_table_child(doc, *r, table)).collect();
        if rows.is_empty() {
            continue;
        }
        let single = rows.iter().all(|r| direct_cells.iter().filter(|c| doc.parent(**c) == Some(*r)).count() <= 1);
        if !single {
            continue;
        }
        let mut nodes = Vec::new();
        for c in &direct_cells {
            nodes.extend(doc.children(*c).iter().copied());
        }
        for n in &nodes {
            doc.detach(*n);
        }
        doc.replace_with_nodes(table, &nodes);
    }

    for v in doc.qsa(root, sel!("video:not([controls])")) {
        doc.set_attr(v, "controls", "");
    }

    for el in doc.by_tag(root, "lite-youtube") {
        let vid = doc.get(el, "videoid").to_string();
        if vid.is_empty() {
            continue;
        }
        let title = doc.attr(el, "videotitle").filter(|t| !t.is_empty()).unwrap_or("YouTube video player").to_string();
        let iframe = doc.create_element("iframe");
        doc.set_attr(iframe, "width", "560");
        doc.set_attr(iframe, "height", "315");
        doc.set_attr(iframe, "src", &format!("https://www.youtube.com/embed/{vid}"));
        doc.set_attr(iframe, "title", &title);
        doc.set_attr(iframe, "frameborder", "0");
        doc.set_attr(iframe, "allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
        doc.set_attr(iframe, "allowfullscreen", "");
        doc.replace(el, iframe);
    }

    merge_adjacent_verso_code_blocks(doc, root);
}

fn is_direct_table_child(doc: &Document, el: NodeId, table: NodeId) -> bool {
    let mut p = doc.parent(el);
    while let Some(x) = p {
        if x == table {
            return true;
        }
        if doc.tag(x) == Some("table") {
            return false;
        }
        p = doc.parent(x);
    }
    false
}

fn transform_paragraph_div(doc: &mut Document, el: NodeId) -> NodeId {
    let p = doc.create_element("p");
    doc.transfer_children(el, p);
    for (k, v) in doc.attrs(el).to_vec() {
        if is_allowed_attribute(&k) {
            doc.set_attr(p, &k, &v);
        }
    }
    p
}

fn convert_paragraph_divs(doc: &mut Document, content: NodeId) {
    for div in doc.qsa(content, sel!("div[role=\"paragraph\"]")) {
        let p = doc.create_element("p");
        doc.transfer_children(div, p);
        doc.replace(div, p);
    }
}

fn is_ordered_label(doc: &Document, list: NodeId) -> bool {
    let label = doc.qs(list, sel!("div[role=\"listitem\"] .label")).map(|l| js_trim(&doc.tc(l)).to_string()).unwrap_or_default();
    regex!(r"^\d+\)").is_match(&label)
}

fn transform_role_list(doc: &mut Document, el: NodeId) -> NodeId {
    let ordered = is_ordered_label(doc, el);
    let list = doc.create_element(if ordered { "ol" } else { "ul" });
    for item in doc.qsa(el, sel!("div[role=\"listitem\"]")) {
        let li = doc.create_element("li");
        if let Some(content) = doc.qs(item, sel!(".content")) {
            convert_paragraph_divs(doc, content);
            for nested in doc.qsa(content, sel!("div[role=\"list\"]")) {
                let nested_ordered = is_ordered_label(doc, nested);
                let nl = doc.create_element(if nested_ordered { "ol" } else { "ul" });
                for ni in doc.qsa(nested, sel!("div[role=\"listitem\"]")) {
                    let nli = doc.create_element("li");
                    if let Some(nc) = doc.qs(ni, sel!(".content")) {
                        convert_paragraph_divs(doc, nc);
                        doc.transfer_children(nc, nli);
                    }
                    doc.append(nl, nli);
                }
                doc.replace(nested, nl);
            }
            doc.transfer_children(content, li);
        }
        doc.append(list, li);
    }
    list
}

fn transform_role_listitem(doc: &mut Document, el: NodeId) -> NodeId {
    let Some(content) = doc.qs(el, sel!(".content")) else { return el };
    convert_paragraph_divs(doc, content);
    content
}

fn merge_adjacent_verso_code_blocks(doc: &mut Document, root: NodeId) {
    let mut parents: Vec<NodeId> = Vec::new();
    for c in doc.qsa(root, sel!("pre[data-verso-code=\"true\"]")) {
        if let Some(p) = doc.parent_element(c) {
            if !parents.contains(&p) {
                parents.push(p);
            }
        }
    }
    let code_of = |doc: &Document, pre: NodeId| -> Option<NodeId> {
        let kids = doc.elem_children(pre);
        if kids.len() == 1 && doc.tag(kids[0]) == Some("code") {
            Some(kids[0])
        } else {
            None
        }
    };
    let lang_of = |doc: &Document, code: NodeId| -> String {
        let dl = doc.get(code, "data-lang").to_lowercase();
        if !dl.is_empty() {
            return dl;
        }
        regex!(r"(?i)(?:^|\s)language-([a-z0-9_+-]+)(?:\s|$)").captures(doc.class_name(code)).map(|c| c[1].to_lowercase()).unwrap_or_default()
    };
    for container in parents {
        let children = doc.children(container).to_vec();
        let mut i = 0;
        while i < children.len() {
            let start = children[i];
            if doc.tag(start) != Some("pre") || doc.get(start, "data-verso-code") != "true" {
                i += 1;
                continue;
            }
            let Some(start_code) = code_of(doc, start) else {
                i += 1;
                continue;
            };
            let lang = lang_of(doc, start_code);
            if lang != "lean" && lang != "lean4" {
                i += 1;
                continue;
            }
            let mut run = vec![(start, start_code)];
            let mut ws = Vec::new();
            let mut j = i + 1;
            while j < children.len() {
                let n = children[j];
                if is_text_ws(doc, n) {
                    ws.push(n);
                    j += 1;
                    continue;
                }
                if doc.tag(n) != Some("pre") || doc.get(n, "data-verso-code") != "true" {
                    break;
                }
                let Some(c) = code_of(doc, n) else { break };
                if lang_of(doc, c) != lang {
                    break;
                }
                run.push((n, c));
                j += 1;
            }
            if run.len() > 1 {
                let merged = run.iter().map(|(_, c)| {
                    let t = doc.tc(*c);
                    t.strip_suffix("\r\n").or_else(|| t.strip_suffix('\n')).unwrap_or(&t).to_string()
                }).collect::<Vec<_>>().join("\n");
                let merged = regex!(r"\n{3,}").replace_all(&merged, "\n\n").trim_matches('\n').to_string();
                doc.set_text_content(start_code, &merged);
                for (p, _) in &run[1..] {
                    doc.remove(*p);
                }
                for w in ws {
                    doc.remove(w);
                }
            }
            i = j.max(i + 1);
        }
    }
}

// ---- SVG colours ------------------------------------------------------------

const TAILWIND: &[(&str, &str)] = &[
    ("slate", "f8fafcf1f5f9e2e8f0cbd5e194a3b864748b4755693341551e293b0f172a020617"),
    ("gray", "f9fafbf3f4f6e5e7ebd1d5db9ca3af6b72804b55633741511f2937111827030712"),
    ("zinc", "fafafaf4f4f5e4e4e7d4d4d8a1a1aa71717a52525b3f3f4627272a18181b09090b"),
    ("neutral", "fafafaf5f5f5e5e5e5d4d4d4a3a3a37373735252524040402626261717170a0a0a"),
    ("stone", "fafaf9f5f5f4e7e5e4d6d3d1a8a29e78716c57534e44403c2925241c19170c0a09"),
    ("red", "fef2f2fee2e2fecacafca5a5f87171ef4444dc2626b91c1c991b1b7f1d1d450a0a"),
    ("orange", "fff7edffedd5fed7aafdba74fb923cf97316ea580cc2410c9a34127c2d12431407"),
    ("amber", "fffbebfef3c7fde68afcd34dfbbf24f59e0bd97706b4530992400e78350f451a03"),
    ("yellow", "fefce8fef9c3fef08afde047facc15eab308ca8a04a16207854d0e713f12422006"),
    ("lime", "f7fee7ecfccbd9f99dbef264a3e63584cc1665a30d4d7c0f3f62123653141a2e05"),
    ("green", "f0fdf4dcfce7bbf7d086efac4ade8022c55e16a34a15803d16653414532d052e16"),
    ("emerald", "ecfdf5d1fae5a7f3d06ee7b734d39910b981059669047857065f46064e3b022c22"),
    ("teal", "f0fdfaccfbf199f6e45eead42dd4bf14b8a60d94880f766e115e59134e4a042f2e"),
    ("cyan", "ecfeffcffafea5f3fc67e8f922d3ee06b6d40891b20e7490155e75164e63083344"),
    ("sky", "f0f9ffe0f2febae6fd7dd3fc38bdf80ea5e90284c70369a10759850c4a6e082f49"),
    ("blue", "eff6ffdbeafebfdbfe93c5fd60a5fa3b82f62563eb1d4ed81e40af1e3a8a172554"),
    ("indigo", "eef2ffe0e7ffc7d2fea5b4fc818cf86366f14f46e54338ca3730a3312e811e1b4b"),
    ("violet", "f5f3ffede9feddd6fec4b5fda78bfa8b5cf67c3aed6d28d95b21b64c1d952e1065"),
    ("purple", "faf5fff3e8ffe9d5ffd8b4fec084fca855f79333ea7e22ce6b21a8581c873b0764"),
    ("fuchsia", "fdf4fffae8fff5d0fef0abfce879f9d946efc026d3a21caf86198f701a754a044e"),
    ("pink", "fdf2f8fce7f3fbcfe8f9a8d4f472b6ec4899db2777be185d9d174d831843500724"),
    ("rose", "fff1f2ffe4e6fecdd3fda4affb7185f43f5ee11d48be123c9f12398813374c0519"),
];
const SHADES: &[&str] = &["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

fn tailwind_hex(color: &str, shade: &str) -> Option<String> {
    let (_, hex) = TAILWIND.iter().find(|(n, _)| *n == color)?;
    let i = SHADES.iter().position(|s| *s == shade)?;
    Some(format!("#{}", &hex[i * 6..i * 6 + 6]))
}

fn unwrap_light_dark(v: &str) -> String {
    regex!(r"light-dark\(\s*([^,]+?)\s*,\s*[^)]+?\)").replace_all(v, |c: &regex_lite::Captures| js_trim(&c[1]).to_string()).into_owned()
}

fn resolve_var(value: &str) -> String {
    let value = unwrap_light_dark(value);
    if !value.contains("var(") {
        return value;
    }
    if let Some(c) = regex!(r"var\(--([^,)]+)(?:,\s*([^)]+))?\)").captures(&value) {
        if let Some(fb) = c.get(2) {
            let fb = js_trim(fb.as_str());
            if !fb.is_empty() && !fb.contains("var(") {
                return fb.to_string();
            }
        }
        let name = c[1].to_lowercase();
        if let Some(tw) = regex!(r"(?:^|-)([a-z]+)-(\d{2,3})$").captures(&name) {
            if let Some(h) = tailwind_hex(&tw[1], &tw[2]) {
                return h;
            }
        }
        if name.ends_with("-black") {
            return "#000".into();
        }
        if name.ends_with("-white") {
            return "#fff".into();
        }
        if ["background", "card", "surface", "bg"].iter().any(|k| name.contains(k)) {
            return "Canvas".into();
        }
        if ["border", "divider", "separator"].iter().any(|k| name.contains(k)) {
            return "#ccc".into();
        }
        if ["muted", "subtle", "secondary", "placeholder"].iter().any(|k| name.contains(k)) {
            return "#888".into();
        }
    }
    "currentColor".into()
}

fn resolve_tailwind_classes(doc: &mut Document, el: NodeId) {
    let Some(class) = doc.attr(el, "class").map(str::to_string) else { return };
    let tokens: Vec<&str> = class.split_whitespace().collect();
    let mut keep = Vec::new();
    let mut styles = Vec::new();
    for t in &tokens {
        if let Some(c) = regex!(r"^(fill|stroke)-([a-z]+)-(\d{2,3})(?:/(\d+))?$").captures(t) {
            if let Some(hex) = tailwind_hex(&c[2], &c[3]) {
                if let Some(op) = c.get(4) {
                    let a = op.as_str().parse::<f64>().unwrap_or(100.0) / 100.0;
                    let r = u8::from_str_radix(&hex[1..3], 16).unwrap_or(0);
                    let g = u8::from_str_radix(&hex[3..5], 16).unwrap_or(0);
                    let b = u8::from_str_radix(&hex[5..7], 16).unwrap_or(0);
                    doc.set_attr(el, &c[1], &format!("rgba({r},{g},{b},{})", crate::value::js_number(a)));
                } else {
                    doc.set_attr(el, &c[1], &hex);
                }
                continue;
            }
        }
        if let Some(c) = regex!(r"^(fill|stroke)-(black|white|transparent|current)$").captures(t) {
            let v = match &c[2] {
                "black" => "#000",
                "white" => "#fff",
                "transparent" => "transparent",
                _ => "currentColor",
            };
            doc.set_attr(el, &c[1], v);
            continue;
        }
        if let Some(c) = regex!(r"^text-\[(.+)\]$").captures(t) {
            let v = &c[1];
            if !v.starts_with('#') && !v.starts_with("rgb") && !v.starts_with("hsl") {
                styles.push(format!("font-size:{v}"));
                continue;
            }
        }
        match *t {
            "font-semibold" => styles.push("font-weight:600".into()),
            "font-bold" => styles.push("font-weight:700".into()),
            "font-medium" => styles.push("font-weight:500".into()),
            "font-mono" => styles.push("font-family:monospace".into()),
            _ => {
                keep.push(*t);
                continue;
            }
        }
    }
    if keep.len() == tokens.len() {
        return;
    }
    if keep.is_empty() {
        doc.remove_attr(el, "class");
    } else {
        doc.set_attr(el, "class", &keep.join(" "));
    }
    if !styles.is_empty() {
        let existing = doc.get(el, "style").to_string();
        let sep = if !existing.is_empty() && !existing.ends_with(';') { ";" } else { "" };
        doc.set_attr(el, "style", &format!("{existing}{sep}{}", styles.join(";")));
    }
}

fn has_style_prop(doc: &Document, el: NodeId, prop: &str) -> bool {
    let Some(style) = doc.attr(el, "style") else { return false };
    style.split(';').any(|decl| js_trim(decl).split(':').next().is_some_and(|p| js_trim(p) == prop) && decl.contains(':'))
}

fn apply_svg_fallback_styles(doc: &mut Document, svg: NodeId) {
    if doc.has_tag_desc(svg, &["style"]) {
        return;
    }
    let all = doc.descendant_elements(svg);
    let non_rendered = |doc: &Document, e: NodeId| doc.closest_tags(e, &["defs", "clippath", "mask", "pattern", "marker"]).is_some();
    let filled = |t: &str| matches!(t, "path" | "rect" | "circle" | "ellipse" | "polygon");
    let unstyled = all.iter().any(|e| {
        filled(doc.tag_name(*e)) && !doc.get(*e, "class").is_empty() && !non_rendered(doc, *e) && !doc.has_attr(*e, "fill") && !has_style_prop(doc, *e, "fill")
    });
    if !unstyled {
        return;
    }
    for e in all {
        let tag = doc.tag_name(e).to_string();
        let is_filled = filled(&tag);
        let is_stroke = matches!(tag.as_str(), "line" | "polyline");
        let is_text = matches!(tag.as_str(), "text" | "tspan");
        if !is_filled && !is_stroke && !is_text {
            continue;
        }
        if doc.get(e, "class").is_empty() || non_rendered(doc, e) {
            continue;
        }
        if is_text {
            if !doc.has_attr(e, "fill") && !has_style_prop(doc, e, "fill") {
                doc.set_attr(e, "fill", "currentColor");
            }
            continue;
        }
        let has_fill = doc.has_attr(e, "fill") && doc.get(e, "fill") != "none";
        let has_stroke = doc.has_attr(e, "stroke") || has_style_prop(doc, e, "stroke");
        if is_filled && !doc.has_attr(e, "fill") && !has_style_prop(doc, e, "fill") {
            doc.set_attr(e, "fill", "none");
        }
        if !has_stroke {
            if is_stroke {
                doc.set_attr(e, "stroke", "currentColor");
                if !doc.has_attr(e, "stroke-opacity") {
                    doc.set_attr(e, "stroke-opacity", "0.2");
                }
            } else if is_filled && !has_fill {
                let d = js_trim(doc.get(e, "d")).to_string();
                if !regex!(r"(?i)Z\s*$").is_match(&d) {
                    doc.set_attr(e, "stroke", "currentColor");
                }
            }
        }
    }
}

fn resolve_svg_colors(doc: &mut Document, root: NodeId) {
    for svg in doc.by_tag(root, "svg") {
        let mut els = vec![svg];
        els.extend(doc.descendant_elements(svg));
        for e in els {
            for a in ["fill", "stroke", "color", "stop-color", "flood-color", "lighting-color"] {
                let v = doc.get(e, a).to_string();
                if v.is_empty() || (!v.contains("var(") && !v.contains("light-dark(")) {
                    continue;
                }
                doc.set_attr(e, a, &resolve_var(&v));
            }
            let style = doc.get(e, "style").to_string();
            if style.contains("var(") || style.contains("light-dark(") {
                let s = unwrap_light_dark(&style);
                let s = regex!(r"var\(--[^,)]+(?:,\s*[^)]+)?\)").replace_all(&s, |c: &regex_lite::Captures| resolve_var(&c[0])).into_owned();
                doc.set_attr(e, "style", &s);
            }
            resolve_tailwind_classes(doc, e);
        }
        apply_svg_fallback_styles(doc, svg);
    }
}

// ---- structure clean-up ---------------------------------------------------------------

fn replace_custom_elements(doc: &mut Document, root: NodeId) {
    let mut customs: Vec<NodeId> = doc
        .descendant_elements(root)
        .into_iter()
        .filter(|e| {
            let t = doc.tag_name(*e);
            t.contains('-') && !is_inline(t) && !doc.is_svg(*e)
        })
        .collect();
    customs.reverse();
    for el in customs {
        if !doc.has_parent(el) {
            continue;
        }
        let div = doc.create_element("div");
        doc.transfer_children(el, div);
        doc.replace(el, div);
    }
}

fn convert_data_as_spans(doc: &mut Document, root: NodeId) {
    for span in doc.qsa(root, sel!("span[data-as]")) {
        if !doc.has_parent(span) {
            continue;
        }
        let target = doc.get(span, "data-as").to_lowercase();
        if !matches!(target.as_str(), "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "blockquote") {
            continue;
        }
        let r = doc.create_element(&target);
        doc.transfer_children(span, r);
        doc.replace(span, r);
    }
}

fn convert_block_spans(doc: &mut Document, root: NodeId) {
    for span in doc.qsa(root, sel!("span[class*=\"block\"], span[style*=\"block\"]")) {
        if !doc.has_parent(span) {
            continue;
        }
        let is_block = regex!(r"(?:^|\s)block(?:\s|$)").is_match(doc.class_name(span))
            || regex!(r"(?i)display\s*:\s*block").is_match(doc.get(span, "style"));
        if !is_block || js_trim(&doc.tc(span)).is_empty() {
            continue;
        }
        let p = doc.create_element("p");
        doc.transfer_children(span, p);
        doc.replace(span, p);
    }
}

fn unwrap_layout_tables(doc: &mut Document, root: NodeId) {
    for table in doc.by_tag(root, "table") {
        if !doc.has_parent(table) {
            continue;
        }
        if doc.has_tag_desc(table, &["thead", "tfoot", "th", "caption"]) {
            continue;
        }
        let mut cells = Vec::new();
        for c in doc.elem_children(table) {
            match doc.tag_name(c) {
                "tbody" => {
                    for tr in doc.elem_children(c).into_iter().filter(|r| doc.tag(*r) == Some("tr")) {
                        cells.extend(doc.elem_children(tr).into_iter().filter(|d| doc.tag(*d) == Some("td")));
                    }
                }
                "tr" => cells.extend(doc.elem_children(c).into_iter().filter(|d| doc.tag(*d) == Some("td"))),
                _ => {}
            }
        }
        let non_empty: Vec<NodeId> = cells.into_iter().filter(|c| !js_trim(&doc.tc(*c)).is_empty()).collect();
        if non_empty.len() != 1 {
            continue;
        }
        let kids: Vec<NodeId> = doc.elem_children(non_empty[0]).into_iter().filter(|c| !js_trim(&doc.tc(*c)).is_empty()).collect();
        if kids.len() == 1 && is_block_level(doc.tag_name(kids[0])) {
            doc.replace(table, kids[0]);
        }
    }
}

fn has_direct_inline_content(doc: &Document, el: NodeId) -> bool {
    doc.children(el).iter().any(|c| match &doc.node(*c).data {
        NodeData::Text(t) => !js_trim(t).is_empty(),
        NodeData::Element { name, .. } => is_inline(name),
        _ => false,
    })
}

fn semantic_class(class: &str) -> bool {
    let c = class.to_lowercase();
    ["article", "main", "content", "footnote", "reference", "bibliography"].iter().any(|k| c.contains(k))
}

fn should_preserve(doc: &Document, el: NodeId) -> bool {
    let tag = doc.tag_name(el);
    if doc.is_svg(el) || is_preserve(tag) {
        return true;
    }
    if !doc.get(el, "data-callout").is_empty() || doc.closest_sel(el, sel!("[data-callout]")).is_some() {
        return true;
    }
    if matches!(doc.get(el, "role"), "article" | "main" | "navigation" | "banner" | "contentinfo") {
        return true;
    }
    let class = doc.class_name(el);
    if !class.is_empty() && semantic_class(class) {
        return true;
    }
    doc.elem_children(el).iter().any(|c| {
        is_preserve(doc.tag_name(*c)) || doc.get(*c, "role") == "article" || {
            let cc = doc.class_name(*c);
            !cc.is_empty() && semantic_class(cc)
        }
    })
}

fn is_wrapper(doc: &Document, el: NodeId) -> bool {
    if has_direct_inline_content(doc, el) {
        return false;
    }
    if js_trim(&doc.tc(el)).is_empty() {
        return true;
    }
    let children = doc.elem_children(el);
    if children.is_empty() {
        return true;
    }
    if children.iter().all(|c| is_block_level(doc.tag_name(*c))) {
        return true;
    }
    if regex!(r"(?i)(?:wrapper|container|layout|row|col|grid|flex|outer|inner|content-area)").is_match(&doc.class_name(el).to_lowercase()) {
        return true;
    }
    let text_nodes = doc.children(el).iter().filter(|c| doc.text(**c).is_some_and(|t| !js_trim(t).is_empty())).count();
    if text_nodes == 0 {
        return true;
    }
    !children.iter().any(|c| is_inline(doc.tag_name(*c)))
}

fn block_depth(doc: &Document, el: NodeId) -> usize {
    doc.ancestors(el).iter().filter(|a| is_block_element(doc.tag_name(**a))).count()
}

fn flatten_wrapper_elements(doc: &mut Document, root: NodeId) {
    fn process(doc: &mut Document, root: NodeId, el: NodeId) -> bool {
        if !doc.has_parent(el) || should_preserve(doc, el) {
            return false;
        }
        let tag = doc.tag_name(el).to_string();
        if !is_allowed_empty(&tag) && doc.elem_children(el).is_empty() && js_trim(&doc.tc(el)).is_empty() {
            doc.remove(el);
            return true;
        }
        if doc.parent(el) == Some(root) {
            let children = doc.elem_children(el);
            if !children.is_empty() && !children.iter().any(|c| is_inline(doc.tag_name(*c))) {
                unwrap(doc, el);
                return true;
            }
        }
        if is_wrapper(doc, el) {
            unwrap(doc, el);
            return true;
        }
        let nodes = doc.children(el).to_vec();
        let only_inline = !nodes.is_empty()
            && nodes.iter().all(|c| match &doc.node(*c).data {
                NodeData::Text(_) => true,
                NodeData::Element { name, .. } => is_inline(name),
                _ => false,
            });
        if only_inline && !js_trim(&doc.tc(el)).is_empty() {
            let p = doc.create_element("p");
            doc.transfer_children(el, p);
            doc.replace(el, p);
            return true;
        }
        let children = doc.elem_children(el);
        if children.len() == 1 {
            let child = children[0];
            if is_block_element(doc.tag_name(child)) && !should_preserve(doc, child) {
                doc.replace(el, child);
                return true;
            }
        }
        if block_depth(doc, el) > 0 && !has_direct_inline_content(doc, el) {
            unwrap(doc, el);
            return true;
        }
        false
    }

    loop {
        let mut changed = false;
        let top: Vec<NodeId> = doc.elem_children(root).into_iter().filter(|e| is_block_element(doc.tag_name(*e))).collect();
        for el in top {
            if process(doc, root, el) {
                changed = true;
            }
        }
        let mut all = doc.qsa(root, sel!(BLOCK_ELEMENTS_SELECTOR));
        let depths: std::collections::HashMap<NodeId, usize> = all.iter().map(|e| (*e, block_depth(doc, *e))).collect();
        all.sort_by(|a, b| depths[b].cmp(&depths[a]));
        for el in all {
            if process(doc, root, el) {
                changed = true;
            }
        }
        for el in doc.qsa(root, sel!(BLOCK_ELEMENTS_SELECTOR)) {
            let children = doc.elem_children(el);
            let only_p = !children.is_empty() && children.iter().all(|c| doc.tag(*c) == Some("p"));
            if only_p || (!should_preserve(doc, el) && is_wrapper(doc, el)) {
                unwrap(doc, el);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
}

fn strip_unwanted_attributes(doc: &mut Document, root: NodeId) {
    let mut els = vec![root];
    els.extend(doc.descendant_elements(root));
    for el in els {
        if !doc.is_element(el) {
            continue;
        }
        if doc.is_svg(el) {
            doc.remove_attr(el, "class");
            continue;
        }
        let tag = doc.tag_name(el).to_string();
        let kept: Vec<(String, String)> = doc
            .attrs(el)
            .iter()
            .filter(|(k, v)| {
                let name = k.to_lowercase();
                if name == "id" && (v.starts_with("fnref:") || v.starts_with("fn:") || v == "footnotes") {
                    return true;
                }
                if name == "class"
                    && ((tag == "code" && v.starts_with("language-")) || v == "footnote-backref" || regex!(r"^callout(?:-|$)").is_match(v))
                {
                    return true;
                }
                is_allowed_attribute(&name)
            })
            .cloned()
            .collect();
        doc.set_attrs(el, kept);
    }
}

fn unwrap_bare_spans(doc: &mut Document, root: NodeId) {
    let mut spans = doc.by_tag(root, "span");
    spans.reverse();
    let mut n = 0;
    for s in spans {
        if !doc.has_parent(s) || !doc.attrs(s).is_empty() {
            continue;
        }
        unwrap(doc, s);
        n += 1;
    }
    if n > 0 {
        doc.normalize(root);
    }
}

fn unwrap_special_links(doc: &mut Document, root: NodeId) {
    for a in doc.qsa(root, sel!("code a")) {
        unwrap(doc, a);
    }
    for a in doc.qsa(root, sel!("a[href^=\"javascript:\"]")) {
        unwrap(doc, a);
    }
    for link in doc.by_tag(root, "a") {
        let href = doc.get(link, "href").to_string();
        if href.is_empty() || href.starts_with('#') {
            continue;
        }
        let Some(h) = doc.elem_children(link).into_iter().find(|c| is_heading(doc.tag_name(*c))) else { continue };
        let inner = doc.create_element("a");
        doc.set_attr(inner, "href", &href);
        doc.transfer_children(h, inner);
        doc.append(h, inner);
        unwrap(doc, link);
    }
    for link in doc.qsa(root, sel!("a[href^=\"#\"]")) {
        if doc.has_tag_desc(link, &["h1", "h2", "h3", "h4", "h5", "h6"]) {
            unwrap(doc, link);
        }
    }
}

fn is_empty_element(doc: &Document, el: NodeId) -> bool {
    let tag = doc.tag_name(el);
    if is_allowed_empty(tag) {
        return false;
    }
    if tag == "div" {
        let children = doc.elem_children(el);
        if !children.is_empty()
            && children.iter().all(|c| {
                doc.tag(*c) == Some("span") && {
                    let t = js_trim(&doc.tc(*c)).to_string();
                    t == "," || t.is_empty()
                }
            })
        {
            return true;
        }
    }
    let text = doc.tc(el);
    if !js_trim(&text).is_empty() || text.contains('\u{a0}') {
        return false;
    }
    doc.children(el).iter().all(|c| match &doc.node(*c).data {
        NodeData::Element { name, .. } => name == "br",
        NodeData::Text(t) => js_trim(t).is_empty() && !t.contains('\u{a0}'),
        _ => false,
    })
}

fn remove_empty_elements(doc: &mut Document, root: NodeId) {
    let mut all = doc.descendant_elements(root);
    all.reverse();
    for el in all {
        if doc.has_parent(el) && is_empty_element(doc, el) {
            doc.remove(el);
        }
    }
}

fn remove_trailing_headings(doc: &mut Document, root: NodeId) {
    fn content_after(doc: &Document, root: NodeId, el: NodeId) -> bool {
        let mut s = doc.next_sibling(el);
        let mut text = String::new();
        while let Some(x) = s {
            if doc.is_element(x) || doc.is_text(x) {
                text.push_str(&doc.tc(x));
            }
            s = doc.next_sibling(x);
        }
        if !js_trim(&text).is_empty() {
            return true;
        }
        match doc.parent_element(el) {
            Some(p) if p != root => content_after(doc, root, p),
            _ => false,
        }
    }
    let mut hs = doc.by_tags(root, &["h1", "h2", "h3", "h4", "h5", "h6"]);
    hs.reverse();
    for h in hs {
        if !content_after(doc, root, h) {
            doc.remove(h);
        } else {
            break;
        }
    }
}

pub fn remove_orphaned_dividers(doc: &mut Document, root: NodeId) {
    loop {
        let first = doc.children(root).iter().copied().find(|c| !is_text_ws(doc, *c));
        match first {
            Some(f) if doc.tag(f) == Some("hr") => doc.remove(f),
            _ => break,
        }
    }
    loop {
        let last = doc.children(root).iter().rev().copied().find(|c| !is_text_ws(doc, *c));
        match last {
            Some(l) if doc.tag(l) == Some("hr") => doc.remove(l),
            _ => break,
        }
    }
    for hr in doc.by_tag(root, "hr") {
        if !doc.has_parent(hr) {
            continue;
        }
        let mut node = doc.next_sibling(hr);
        while let Some(n) = node {
            if is_text_ws(doc, n) {
                node = doc.next_sibling(n);
                continue;
            }
            if doc.tag(n) == Some("hr") {
                let next = doc.next_sibling(n);
                doc.remove(n);
                node = next;
                continue;
            }
            break;
        }
    }
}

fn skip_ws(doc: &Document, node: NodeId, forward: bool) -> Option<NodeId> {
    let mut s = if forward { doc.next_sibling(node) } else { doc.prev_sibling(node) };
    while let Some(x) = s {
        if is_text_ws(doc, x) {
            s = if forward { doc.next_sibling(x) } else { doc.prev_sibling(x) };
        } else {
            break;
        }
    }
    s
}

fn strip_extra_br_elements(doc: &mut Document, root: NodeId) {
    let brs = doc.by_tag(root, "br");
    let mut run: Vec<NodeId> = Vec::new();
    let flush = |doc: &mut Document, run: &mut Vec<NodeId>| {
        if run.len() > 2 {
            for b in &run[2..] {
                doc.remove(*b);
            }
        }
        run.clear();
    };
    for br in brs {
        let consecutive = run.last().is_some_and(|last| skip_ws(doc, br, false) == Some(*last));
        if consecutive {
            run.push(br);
        } else {
            flush(doc, &mut run);
            run.push(br);
        }
    }
    flush(doc, &mut run);

    for br in doc.by_tag(root, "br") {
        let Some(parent) = doc.parent_element(br) else { continue };
        if doc.closest_tags(br, &["pre", "code"]).is_some() {
            continue;
        }
        let ptag = doc.tag_name(parent).to_string();
        if is_block_level(&ptag) || ptag == "body" {
            let mut group = vec![br];
            let mut scan = skip_ws(doc, br, true);
            while let Some(s) = scan.filter(|s| doc.tag(*s) == Some("br")) {
                group.push(s);
                scan = skip_ws(doc, s, true);
            }
            let prev = skip_ws(doc, group[0], false);
            let next = skip_ws(doc, *group.last().unwrap(), true);
            let prev_block = prev.is_some_and(|p| doc.is_element(p) && is_block_level(doc.tag_name(p)));
            let next_block = next.is_some_and(|n| doc.is_element(n) && is_block_level(doc.tag_name(n)));
            if (prev_block && next_block) || (prev_block && next.is_none()) || prev.is_none() {
                for b in group {
                    doc.remove(b);
                }
                continue;
            }
        }
        if is_block_level(&ptag) && skip_ws(doc, br, true).is_none() {
            doc.remove(br);
        }
    }
}

fn zero_width_only(t: &str) -> bool {
    t.chars().all(|c| matches!(c, '\u{200C}' | '\u{200B}' | '\u{200D}' | '\u{200E}' | '\u{200F}' | '\u{FEFF}'))
}

fn remove_empty_lines(doc: &mut Document, root: NodeId) {
    fn texts(doc: &mut Document, n: NodeId) {
        if matches!(doc.tag(n), Some("pre") | Some("code")) {
            return;
        }
        for c in doc.children(n).to_vec() {
            texts(doc, c);
        }
        if let Some(t) = doc.text(n) {
            if t.is_empty() || zero_width_only(t) {
                doc.remove(n);
            } else {
                let mut s = regex!(r"[\n\r]+").replace_all(t, " ").into_owned();
                s = regex!(r"\t+").replace_all(&s, " ").into_owned();
                s = regex!(r" {2,}").replace_all(&s, " ").into_owned();
                s = regex!(r"^[ ]+$").replace_all(&s, " ").into_owned();
                s = regex!(r"\s+([,.!?:;])").replace_all(&s, "$1").into_owned();
                s = regex!(r"[\x{200B}\x{200D}\x{200E}\x{200F}\x{FEFF}]+").replace_all(&s, "").into_owned();
                s = regex!(r"(?:\x{A0}){2,}").replace_all(&s, "\u{a0}").into_owned();
                if s != t {
                    doc.set_text(n, &s);
                }
            }
        }
    }
    fn is_ws_pattern(t: &str) -> bool {
        t.chars().all(|c| matches!(c, '\n' | '\r' | '\t' | '\u{200C}' | '\u{200B}' | '\u{200D}' | '\u{200E}' | '\u{200F}' | '\u{FEFF}'))
    }
    fn move_ws_outside(doc: &mut Document, node: NodeId, leading: bool) {
        let child = if leading { doc.first_child(node) } else { doc.last_child(node) };
        let Some(child) = child else { return };
        let Some(text) = doc.text(child).map(str::to_string) else { return };
        let trimmed = if leading { super::util::js_trim_start(&text) } else { super::util::js_trim_end(&text) }.to_string();
        if trimmed == text || !doc.has_parent(node) {
            return;
        }
        doc.set_text(child, &trimmed);
        let neighbor = if leading { doc.prev_sibling(node) } else { doc.next_sibling(node) };
        let has_space = neighbor.and_then(|n| doc.text(n)).is_some_and(|t| if leading { t.ends_with(' ') } else { t.starts_with(' ') });
        if !has_space {
            let sp = doc.create_text(" ");
            if leading {
                doc.insert_before(node, sp);
            } else {
                doc.insert_after(node, sp);
            }
        }
    }
    fn cleanup(doc: &mut Document, n: NodeId) {
        if !doc.is_element(n) {
            return;
        }
        let tag = doc.tag_name(n).to_string();
        if tag == "pre" || tag == "code" {
            return;
        }
        for c in doc.elem_children(n) {
            cleanup(doc, c);
        }
        doc.normalize(n);
        while let Some(f) = doc.first_child(n) {
            if doc.text(f).is_some_and(is_ws_pattern) {
                doc.remove(f);
            } else {
                break;
            }
        }
        while let Some(l) = doc.last_child(n) {
            if doc.text(l).is_some_and(is_ws_pattern) {
                doc.remove(l);
            } else {
                break;
            }
        }
        if is_inline(&tag) && doc.has_parent(n) {
            move_ws_outside(doc, n, true);
            move_ws_outside(doc, n, false);
        }
        let children = doc.children(n).to_vec();
        for i in 0..children.len().saturating_sub(1) {
            let (cur, next) = (children[i], children[i + 1]);
            if !(doc.is_element(cur) || doc.is_element(next)) {
                continue;
            }
            let next_content = doc.tc(next);
            let cur_content = doc.tc(cur);
            let next_is_ref = doc.tag(next) == Some("sup") && doc.id_of(next).starts_with("fnref:");
            let next_punct = regex!(r"^[,.!?:;)\]]").is_match(&next_content);
            let cur_punct = regex!(r"[,.!?:;(\[]\s*$").is_match(&cur_content);
            let has_space = doc.text(cur).is_some_and(|t| t.ends_with(' ')) || doc.text(next).is_some_and(|t| t.starts_with(' '));
            if !next_is_ref && !next_punct && !cur_punct && !has_space {
                let sp = doc.create_text(" ");
                doc.insert_before(next, sp);
            }
        }
    }
    texts(doc, root);
    cleanup(doc, root);
}

