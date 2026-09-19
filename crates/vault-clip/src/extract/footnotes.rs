//! Defuddle's `elements/footnotes.ts`: inline references become
//! `<sup id="fnref:N"><a href="#fn:N">N</a></sup>` and definitions are
//! collected into `<div id="footnotes"><ol><li class="footnote" id="fn:N">…`
//! with `<a href="#fnref:N" class="footnote-backref">↩</a>` backlinks.

use std::collections::{BTreeMap, HashMap, HashSet};

use super::constants::{is_block_level, FOOTNOTE_INLINE_REFERENCES, FOOTNOTE_LIST_SELECTORS};
use super::standardize::remove_orphaned_dividers;
use super::util::{js_trim, regex, sel, DomExt};
use crate::html::{Document, NodeData, NodeId};

pub fn footnote_section_heading(text: &str) -> bool {
    regex!(r"(?i)^(foot\s*notes?|end\s*notes?|notes?|references?)$").is_match(text)
}

fn marker_num(text: &str) -> Option<String> {
    regex!(r"^\[?\(?(\d{1,4})\)?\]?$").captures(text).map(|c| c[1].to_string())
}

fn href_fragment(doc: &Document, a: Option<NodeId>) -> String {
    let Some(a) = a else { return String::new() };
    doc.get(a, "href").rsplit('#').next().unwrap_or("").to_lowercase()
}

#[derive(Clone)]
struct Footnote {
    content: NodeId,
    original_id: String,
    refs: Vec<String>,
}

type Collection = BTreeMap<i64, Footnote>;

struct State {
    footnotes: Collection,
    processed: HashSet<String>,
    count: i64,
}

struct Handler<'a> {
    doc: &'a mut Document,
    pending: Vec<NodeId>,
}

fn make_ref_id(num: &str, len: usize) -> String {
    if len > 0 {
        format!("fnref:{}-{}", num, len + 1)
    } else {
        format!("fnref:{num}")
    }
}

impl Handler<'_> {
    fn add(&self, st: &mut State, id: &str, content: NodeId, explicit: Option<i64>) -> bool {
        if id.is_empty() || st.processed.contains(id) {
            return false;
        }
        let key = explicit.unwrap_or(st.count);
        st.footnotes.insert(key, Footnote { content, original_id: id.to_string(), refs: vec![] });
        st.processed.insert(id.to_string());
        match explicit {
            None => st.count += 1,
            Some(n) if n >= st.count => st.count = n + 1,
            _ => {}
        }
        true
    }

    fn is_backref_link(&self, el: NodeId) -> bool {
        if self.doc.tag(el) != Some("a") {
            return false;
        }
        let text: String = js_trim(&self.doc.tc(el)).chars().filter(|c| *c != '\u{FE0E}' && *c != '\u{FE0F}').collect();
        if regex!(r"^[\^\x{21A9}\x{21A5}\x{2191}\x{21B5}\x{2934}\x{2935}\x{23CE}]+$").is_match(&text) || self.doc.has_class(el, "footnote-backref") {
            return true;
        }
        self.doc.get(el, "href").starts_with("#cite_ref-")
    }

    fn remove_backrefs(&mut self, el: NodeId) {
        for a in self.doc.by_tag(el, "a") {
            if self.is_backref_link(a) {
                let parent = self.doc.parent_element(a);
                if let Some(p) = parent.filter(|p| self.doc.tag(*p) == Some("sup") && self.doc.elem_children(*p).len() == 1) {
                    self.doc.remove(p);
                } else {
                    self.doc.remove(a);
                }
            }
        }
        while let Some(f) = self.doc.first_child(el) {
            match self.doc.text(f) {
                Some(t) if regex!(r"^[\s\^,.;]*$").is_match(t) && t.contains('^') => self.doc.remove(f),
                _ => break,
            }
        }
        while let Some(l) = self.doc.last_child(el) {
            match self.doc.text(l) {
                Some(t) if t.chars().all(super::util::is_js_space) => self.doc.remove(l),
                _ => break,
            }
        }
    }

    fn trim_leading_ws(&mut self, parent: NodeId) {
        if let Some(f) = self.doc.first_child(parent) {
            if let Some(t) = self.doc.text(f) {
                let n = super::util::js_trim_start(t).to_string();
                self.doc.set_text(f, &n);
            }
        }
    }

    fn create_item(&mut self, number: i64, content: NodeId, refs: &[String]) -> NodeId {
        let li = self.doc.create_element("li");
        self.doc.set_attr(li, "class", "footnote");
        self.doc.set_attr(li, "id", &format!("fn:{number}"));
        let children = self.doc.elem_children(content);
        let has_p = children.iter().any(|c| self.doc.tag(*c) == Some("p"));
        let has_block = children.iter().any(|c| is_block_level(self.doc.tag_name(*c)));
        if !has_p && !has_block {
            let p = self.doc.create_element("p");
            self.doc.transfer_children(content, p);
            self.remove_backrefs(p);
            self.doc.append(li, p);
        } else if !has_p {
            for c in children {
                if self.is_backref_link(c) {
                    continue;
                }
                let clone = self.doc.clone_subtree(c);
                self.remove_backrefs(clone);
                self.doc.append(li, clone);
            }
        } else {
            for c in children {
                if self.is_backref_link(c) {
                    continue;
                }
                if self.doc.tag(c) == Some("p") {
                    if js_trim(&self.doc.tc(c)).is_empty() && !self.doc.has_tag_desc(c, &["img", "br"]) {
                        continue;
                    }
                    let np = self.doc.create_element("p");
                    self.doc.transfer_children(c, np);
                    self.remove_backrefs(np);
                    self.doc.append(li, np);
                } else {
                    let clone = self.doc.clone_subtree(c);
                    self.remove_backrefs(clone);
                    self.doc.append(li, clone);
                }
            }
        }
        let last_p = self.doc.qsa(li, sel!("p:last-of-type")).first().copied().unwrap_or(li);
        for (i, r) in refs.iter().enumerate() {
            let a = self.doc.create_element("a");
            self.doc.set_attr(a, "href", &format!("#{r}"));
            self.doc.set_attr(a, "title", "return to article");
            self.doc.set_attr(a, "class", "footnote-backref");
            let text = if i < refs.len() - 1 { "↩ " } else { "↩" };
            let t = self.doc.create_text(text);
            self.doc.append(a, t);
            self.doc.append(last_p, a);
        }
        li
    }

    fn list_item_id_and_content(&self, li: NodeId) -> (String, Option<NodeId>) {
        if let Some(c) = self.doc.qs(li, sel!(".citations")) {
            let id = self.doc.id_of(c).to_lowercase();
            if id.starts_with('r') {
                return (id, self.doc.qs(c, sel!(".citation-content")));
            }
        }
        let raw = self.doc.id_of(li).to_lowercase();
        for prefix in ["bib.bib", "fn:", "fn"] {
            if let Some(rest) = raw.strip_prefix(prefix) {
                return (rest.to_string(), Some(li));
            }
        }
        if self.doc.has_attr(li, "data-counter") {
            let v = self.doc.get(li, "data-counter");
            let v = v.strip_suffix('.').unwrap_or(v).to_lowercase();
            return (v, Some(li));
        }
        let last = raw.rsplit('/').next().unwrap_or("");
        if let Some(c) = regex!(r"cite_note-(.+)").captures(last) {
            return (c[1].to_string(), Some(li));
        }
        (raw, Some(li))
    }

    fn collect(&mut self, element: NodeId) -> Collection {
        let mut st = State { footnotes: BTreeMap::new(), processed: HashSet::new(), count: 1 };
        for list in self.doc.qsa(element, sel!(FOOTNOTE_LIST_SELECTORS)) {
            if self.doc.is(list, sel!("div.footnotes-footer")) {
                for div in self.doc.qsa(list, sel!("div.footnote-footer")) {
                    let id_attr = self.doc.id_of(div).to_string();
                    let Some(c) = regex!(r"^footnote-(\d+)$").captures(&id_attr) else { continue };
                    let id = c[1].to_string();
                    if st.processed.contains(&id) {
                        continue;
                    }
                    let clone = self.doc.clone_subtree(div);
                    if let Some(a) = self.doc.qs(clone, sel!("a")) {
                        self.doc.remove(a);
                    }
                    let html = self.doc.inner_html(clone);
                    let text = regex!(r"^\s*\.\s*").replace(&html, "").into_owned();
                    let cd = self.doc.create_element("div");
                    self.doc.append_html(cd, js_trim(&text));
                    self.add(&mut st, &id, cd, None);
                }
                continue;
            }
            if self.doc.is(list, sel!("div.footnote-definition"))
                && !self.doc.parent_element(list).is_some_and(|p| self.doc.is(p, sel!("div.footnote-definitions")))
            {
                let id = self.doc.id_of(list).to_lowercase();
                let clone = self.doc.clone_subtree(list);
                if let Some(l) = self.doc.qs(clone, sel!("sup.footnote-definition-label")) {
                    self.doc.remove(l);
                }
                self.add(&mut st, &id, clone, None);
                continue;
            }
            if self.doc.is(list, sel!("div.footnote-definitions")) {
                for def in self.doc.qsa(list, sel!("div.footnote-definition")) {
                    let sup = self.doc.qs(def, sel!("sup[id]"));
                    let body = self.doc.qs(def, sel!(".footnote-body"));
                    let (Some(sup), Some(body)) = (sup, body) else { continue };
                    let id = self.doc.id_of(sup).to_lowercase();
                    let c = self.doc.clone_subtree(body);
                    self.add(&mut st, &id, c, None);
                }
                if let Some(p) = self.doc.parent_element(list) {
                    if p != element && self.doc.has_class(p, "footnotes") {
                        self.pending.push(p);
                    }
                }
                continue;
            }
            if self.doc.is(list, sel!("ol.easy-footnotes-wrapper")) {
                for li in self.doc.qsa(list, sel!("li.easy-footnote-single")) {
                    let Some(span) = self.doc.qs(li, sel!("span[id^=\"easy-footnote-bottom-\"]")) else { continue };
                    let id = self.doc.id_of(span).to_lowercase();
                    let clone = self.doc.clone_subtree(li);
                    if let Some(s) = self.doc.qs(clone, sel!("span[id^=\"easy-footnote-bottom-\"]")) {
                        self.doc.remove(s);
                    }
                    if let Some(s) = self.doc.qs(clone, sel!("a.easy-footnote-to-top")) {
                        self.doc.remove(s);
                    }
                    self.add(&mut st, &id, clone, None);
                }
                for s in self.doc.qsa(element, sel!("span.easy-footnote-margin-adjust")) {
                    self.pending.push(s);
                }
                continue;
            }
            if self.doc.is(list, sel!("div.footnotes-segment")) {
                for h in self.doc.qsa(list, sel!("h5.footnote-body-heading")) {
                    let id = self.doc.qs(h, sel!("a[id]")).map(|a| self.doc.id_of(a).to_lowercase()).unwrap_or_default();
                    if id.is_empty() {
                        continue;
                    }
                    let cd = self.doc.create_element("div");
                    let mut sib = self.doc.next_element_sibling(h);
                    while let Some(s) = sib {
                        if self.doc.tag(s) == Some("h5") && self.doc.has_class(s, "footnote-body-heading") {
                            break;
                        }
                        if !js_trim(&self.doc.tc(s)).is_empty() || self.doc.has_tag_desc(s, &["img", "br"]) {
                            let c = self.doc.clone_subtree(s);
                            self.doc.append(cd, c);
                        }
                        sib = self.doc.next_element_sibling(s);
                    }
                    self.add(&mut st, &id, cd, None);
                }
                self.pending.push(list);
                continue;
            }
            if self.doc.is(list, sel!("div.footnote[data-component-name=\"FootnoteToDOM\"]")) {
                let anchor = self.doc.qs(list, sel!("a.footnote-number"));
                let content = self.doc.qs(list, sel!(".footnote-content"));
                if let (Some(a), Some(c)) = (anchor, content) {
                    let id = self.doc.id_of(a).replacen("footnote-", "", 1).to_lowercase();
                    self.add(&mut st, &id, c, None);
                }
                continue;
            }
            for li in self.doc.qsa(list, sel!("li, div[role=\"listitem\"]")) {
                let (id, content) = self.list_item_id_and_content(li);
                self.add(&mut st, &id, content.unwrap_or(li), None);
            }
        }

        let fallbacks: [fn(&mut Self, NodeId, &mut State); 8] = [
            Self::try_data_type,
            Self::try_generic_id,
            Self::try_word_export,
            Self::try_google_docs,
            Self::try_labeled_section,
            Self::try_loose,
            Self::try_class_footnote,
            Self::try_br_separated,
        ];
        for f in fallbacks {
            if st.count > 1 {
                break;
            }
            f(self, element, &mut st);
        }
        st.footnotes
    }

    fn try_data_type(&mut self, element: NodeId, st: &mut State) {
        for def in self.doc.qsa(element, sel!("p[data-type=\"footnote\"][id]")) {
            let id = self.doc.id_of(def).to_lowercase();
            if id.is_empty() {
                continue;
            }
            let cd = self.doc.create_element("div");
            let clone = self.doc.clone_subtree(def);
            if let Some(m) = self.doc.first_elem_child(clone) {
                if self.doc.tag(m) == Some("sup") && self.doc.qs(m, sel!("a[href*=\"#\"]")).is_some() {
                    self.doc.remove(m);
                    self.trim_leading_ws(clone);
                }
            }
            self.doc.append(cd, clone);
            self.add(st, &id, cd, None);
            self.pending.push(def);
        }
    }

    fn child_anchor_id(&self, el: NodeId) -> String {
        let Some(a) = self.doc.qs(el, sel!("a[id], a[name]")) else { return String::new() };
        let id = self.doc.id_of(a);
        if !id.is_empty() {
            id.to_lowercase()
        } else {
            self.doc.get(a, "name").to_lowercase()
        }
    }

    fn matching_elements(&self, container: NodeId, frags: &HashSet<String>) -> Vec<(NodeId, String)> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for el in self.doc.qsa(container, sel!("li, p, div")) {
            let raw = self.doc.id_of(el);
            let mut id = String::new();
            if !raw.is_empty() && frags.contains(&raw.to_lowercase()) {
                id = raw.to_lowercase();
            } else if raw.is_empty() {
                let a = self.child_anchor_id(el);
                if !a.is_empty() && frags.contains(&a) {
                    id = a;
                }
            }
            if !id.is_empty() && seen.insert(id.clone()) {
                out.push((el, id));
            }
        }
        out
    }

    fn try_generic_id(&mut self, element: NodeId, st: &mut State) {
        let mut refs: Vec<(String, Vec<NodeId>)> = Vec::new();
        for a in self.doc.qsa(element, sel!("a[href*=\"#\"]")) {
            let frag = href_fragment(self.doc, Some(a));
            if frag.is_empty() || marker_num(&js_trim(&self.doc.tc(a))).is_none() {
                continue;
            }
            match refs.iter_mut().find(|(f, _)| *f == frag) {
                Some((_, v)) => v.push(a),
                None => refs.push((frag, vec![a])),
            }
        }
        if refs.len() < 2 {
            return;
        }
        let frags: HashSet<String> = refs.iter().map(|(f, _)| f.clone()).collect();
        let mut best = None;
        let mut best_count = 0;
        for c in self.doc.qsa(element, sel!("div, section, aside, footer, ol, ul")) {
            let n = self.matching_elements(c, &frags).len();
            if n >= 2 && n >= best_count {
                best_count = n;
                best = Some(c);
            }
        }
        let Some(container) = best else { return };
        let ordered = self.matching_elements(container, &frags);
        let fn_frags: HashSet<&String> = ordered.iter().map(|(_, id)| id).collect();
        let (mut total, mut matched) = (0, 0);
        for (frag, anchors) in &refs {
            if anchors.iter().any(|a| self.doc.contains(container, *a)) {
                continue;
            }
            total += 1;
            if fn_frags.contains(frag) {
                matched += 1;
            }
        }
        let valid = matched >= std::cmp::max(2, ((total as f64) * 0.75).ceil() as i64);
        for (el, id) in &ordered {
            if st.processed.contains(id) {
                continue;
            }
            let cd = self.doc.create_element("div");
            let clone = self.doc.clone_subtree(*el);
            let id_anchor = self.doc.qsa(clone, sel!("a[id]")).into_iter().find(|a| self.doc.id_of(*a) == id.as_str());
            if let Some(ia) = id_anchor {
                let t = js_trim(&self.doc.tc(ia)).to_string();
                if t.is_empty() || regex!(r"^\d+[.)]*\s*$").is_match(&t) {
                    self.doc.remove(ia);
                }
            }
            if let Some(na) = self.doc.qs(clone, sel!("a[name]")) {
                if self.doc.get(na, "name").to_lowercase() == *id {
                    self.doc.remove(na);
                }
            }
            if let Some(f) = self.doc.first_child(clone) {
                if let Some(t) = self.doc.text(f) {
                    let n = regex!(r"^\d+\.\s*").replace(t, "").into_owned();
                    let n = super::util::js_trim_start(&n).to_string();
                    self.doc.set_text(f, &n);
                }
            }
            if self.doc.tag(clone) == Some("li") {
                self.doc.transfer_children(clone, cd);
            } else {
                self.doc.append(cd, clone);
            }
            let mut sib = self.doc.next_element_sibling(*el);
            while let Some(s) = sib {
                if !self.doc.id_of(s).is_empty() {
                    break;
                }
                let aid = self.child_anchor_id(s);
                if !aid.is_empty() && frags.contains(&aid) {
                    break;
                }
                let c = self.doc.clone_subtree(s);
                self.doc.append(cd, c);
                sib = self.doc.next_element_sibling(s);
            }
            self.add(st, id, cd, None);
        }
        if valid {
            self.pending.push(container);
        }
    }

    fn try_word_export(&mut self, element: NodeId, st: &mut State) {
        let backrefs = self.doc.qsa(element, sel!("a[href*=\"#_ftnref\"]"));
        if backrefs.len() < 2 {
            return;
        }
        let mut pairs: Vec<(i64, NodeId)> = Vec::new();
        for a in backrefs {
            let frag = href_fragment(self.doc, Some(a));
            if let Some(c) = regex!(r"^_ftnref(\d+)$").captures(&frag) {
                pairs.push((c[1].parse().unwrap_or(0), a));
            }
        }
        pairs.sort_by_key(|p| p.0);
        for (num, anchor) in pairs {
            let oid = format!("_ftn{num}");
            if st.processed.contains(&oid) {
                continue;
            }
            let mut container = self.doc.parent_element(anchor);
            while let Some(c) = container {
                if c == element || matches!(self.doc.tag_name(c), "p" | "div" | "li") {
                    break;
                }
                container = self.doc.parent_element(c);
            }
            let Some(container) = container.filter(|c| *c != element) else { continue };
            let clone = self.doc.clone_subtree(container);
            if let Some(b) = self.doc.qs(clone, sel!("a[href*=\"_ftnref\"]")) {
                match self.doc.closest_tags(b, &["sup"]) {
                    Some(s) => self.doc.remove(s),
                    None => self.doc.remove(b),
                }
            }
            let cd = self.doc.create_element("div");
            self.doc.append(cd, clone);
            self.add(st, &oid, cd, Some(num));
            self.pending.push(container);
        }
    }

    fn try_google_docs(&mut self, element: NodeId, st: &mut State) {
        let mut pairs: Vec<(i64, NodeId)> = Vec::new();
        for p in self.doc.qsa(element, sel!("p[id^=\"ftnt\"]")) {
            if let Some(c) = regex!(r"^ftnt(\d+)$").captures(self.doc.id_of(p)) {
                pairs.push((c[1].parse().unwrap_or(0), p));
            }
        }
        if pairs.len() < 2 {
            return;
        }
        pairs.sort_by_key(|p| p.0);
        for &(num, el) in &pairs {
            let oid = format!("ftnt{num}");
            if st.processed.contains(&oid) {
                continue;
            }
            let clone = self.doc.clone_subtree(el);
            if let Some(a) = self.doc.qs(clone, sel!("a[href*=\"#ftnt_ref\"]")) {
                self.doc.remove(a);
            }
            let cd = self.doc.create_element("div");
            self.doc.append(cd, clone);
            self.add(st, &oid, cd, Some(num));
            self.pending.push(el);
            if let Some(p) = self.doc.parent_element(el) {
                if p != element && self.doc.tag(p) == Some("div") && self.doc.elem_children(p).len() == 1 {
                    self.pending.push(p);
                }
            }
        }
        let first = pairs[0].1;
        let fp = self.doc.parent_element(first);
        let scan = match fp {
            Some(p) if p != element && self.doc.tag(p) == Some("div") => p,
            _ => first,
        };
        if let Some(prev) = self.doc.prev_element_sibling(scan) {
            if super::constants::is_heading(self.doc.tag_name(prev)) && footnote_section_heading(&js_trim(&self.doc.tc(prev))) {
                self.pending.push(prev);
            }
        }
    }

    fn is_bold_wrapped_sup(&self, el: NodeId) -> bool {
        matches!(self.doc.tag_name(el), "b" | "strong")
            && self.doc.first_child(el) == self.doc.first_elem_child(el)
            && self.doc.first_elem_child(el).is_some_and(|c| self.doc.tag(c) == Some("sup"))
    }

    fn strip_marker_and_wrap(&mut self, el: NodeId) -> NodeId {
        let cd = self.doc.create_element("div");
        let clone = self.doc.clone_subtree(el);
        if let Some(marker) = self.doc.first_elem_child(clone) {
            if self.is_bold_wrapped_sup(marker) {
                if let Some(s) = self.doc.first_elem_child(marker) {
                    self.doc.remove(s);
                }
                self.trim_leading_ws(marker);
            } else {
                self.doc.remove(marker);
                self.trim_leading_ws(clone);
            }
        }
        self.doc.append(cd, clone);
        cd
    }

    fn parse_num(&self, el: NodeId) -> Option<i64> {
        let first_node = self.doc.first_child(el)?;
        let mut first = self.doc.first_elem_child(el)?;
        if first != first_node {
            return None;
        }
        let mut tag = self.doc.tag_name(first).to_string();
        if self.is_bold_wrapped_sup(first) {
            first = self.doc.first_elem_child(first)?;
            tag = "sup".into();
        }
        if tag != "sup" && tag != "strong" {
            return None;
        }
        let t = js_trim(&self.doc.tc(first)).to_string();
        let n = super::util::parse_int(&t)?;
        if n >= 1 && n.to_string() == t {
            Some(n)
        } else {
            None
        }
    }

    fn cross_validate(&self, element: NodeId, paras: &[(i64, NodeId)]) -> bool {
        let nums: HashSet<i64> = paras.iter().map(|p| p.0).collect();
        let mut matched = HashSet::new();
        for sup in self.doc.by_tag(element, "sup") {
            if paras.iter().any(|(_, e)| self.doc.contains(*e, sup)) {
                continue;
            }
            if self.doc.has_tag_desc(sup, &["a"]) {
                continue;
            }
            let t = js_trim(&self.doc.tc(sup)).to_string();
            if let Some(n) = super::util::parse_int(&t) {
                if n >= 1 && n.to_string() == t && nums.contains(&n) {
                    matched.insert(n);
                }
            }
        }
        matched.len() >= 2
    }

    fn find_loose(&self, element: NodeId) -> Option<(Vec<(i64, NodeId)>, Vec<NodeId>)> {
        let all_ps = self.doc.by_tag(element, "p");
        let container = all_ps.last().and_then(|p| self.doc.parent_element(*p)).unwrap_or(element);
        let children = self.doc.elem_children(container);
        for i in (0..children.len()).rev() {
            if self.doc.tag(children[i]) != Some("hr") {
                continue;
            }
            let paras: Vec<(i64, NodeId)> = children[i + 1..].iter().filter_map(|c| self.parse_num(*c).map(|n| (n, *c))).collect();
            if paras.len() >= 2 && self.cross_validate(element, &paras) {
                return Some((paras, children[i..].to_vec()));
            }
            break;
        }
        let mut trailing: Vec<(i64, NodeId)> = Vec::new();
        let mut first_idx = None;
        for i in (0..children.len()).rev() {
            let c = children[i];
            let tag = self.doc.tag_name(c);
            if tag == "p" {
                if let Some(n) = self.parse_num(c) {
                    trailing.insert(0, (n, c));
                    first_idx = Some(i);
                    continue;
                }
                break;
            }
            if matches!(tag, "ul" | "ol" | "blockquote") {
                continue;
            }
            break;
        }
        if trailing.len() >= 2 && self.cross_validate(element, &trailing) {
            let mut to_remove = children[first_idx.unwrap_or(0)..].to_vec();
            if let Some(prev) = self.doc.prev_element_sibling(trailing[0].1) {
                if super::constants::is_heading(self.doc.tag_name(prev)) && footnote_section_heading(&js_trim(&self.doc.tc(prev))) {
                    to_remove.insert(0, prev);
                }
            }
            return Some((trailing, to_remove));
        }
        let half = all_ps.len() / 2;
        let scattered: Vec<(i64, NodeId)> = all_ps[half..].iter().filter_map(|p| self.parse_num(*p).map(|n| (n, *p))).collect();
        if scattered.len() >= 2 && self.cross_validate(element, &scattered) {
            let rm = scattered.iter().map(|p| p.1).collect();
            return Some((scattered, rm));
        }
        None
    }

    fn try_loose(&mut self, element: NodeId, st: &mut State) {
        let Some((paras, to_remove)) = self.find_loose(element) else { return };
        let rm: HashSet<NodeId> = to_remove.iter().copied().collect();
        for i in 0..paras.len() {
            let (num, def) = paras[i];
            let next_def = paras.get(i + 1).map(|p| p.1);
            let cd = self.strip_marker_and_wrap(def);
            let mut sib = self.doc.next_element_sibling(def);
            while let Some(s) = sib {
                if Some(s) == next_def || !rm.contains(&s) {
                    break;
                }
                let c = self.doc.clone_subtree(s);
                self.doc.append(cd, c);
                sib = self.doc.next_element_sibling(s);
            }
            self.add(st, &num.to_string(), cd, None);
        }
        self.pending.extend(to_remove);
    }

    fn try_class_footnote(&mut self, element: NodeId, st: &mut State) {
        let paras: Vec<(i64, NodeId)> = self
            .doc
            .qsa(element, sel!("p.footnote"))
            .into_iter()
            .filter_map(|p| self.parse_num(p).map(|n| (n, p)))
            .collect();
        for &(num, def) in &paras {
            let cd = self.strip_marker_and_wrap(def);
            self.add(st, &num.to_string(), cd, None);
        }
        self.pending.extend(paras.iter().map(|p| p.1));
    }

    fn try_labeled_section(&mut self, element: NodeId, st: &mut State) {
        for container in self.doc.qsa(element, sel!("div, section, aside")) {
            let class = self.doc.class_name(container).to_lowercase();
            let id = self.doc.id_of(container).to_lowercase();
            if !class.contains("footnote") && !id.contains("footnote") {
                continue;
            }
            let Some(h) = self.doc.qs(container, sel!("h1, h2, h3, h4, h5, h6")) else { continue };
            if !footnote_section_heading(&js_trim(&self.doc.tc(h))) {
                continue;
            }
            if !self.collect_section_paragraphs(container, st) && !self.collect_section_list(container, st) {
                continue;
            }
            self.pending.push(container);
            break;
        }
    }

    fn collect_section_paragraphs(&mut self, container: NodeId, st: &mut State) -> bool {
        let paras: Vec<(i64, NodeId)> = self
            .doc
            .by_tag(container, "p")
            .into_iter()
            .filter_map(|p| self.parse_num(p).map(|n| (n, p)))
            .collect();
        if paras.is_empty() {
            return false;
        }
        let set: HashSet<NodeId> = paras.iter().map(|p| p.1).collect();
        for &(num, def) in &paras {
            let cd = self.strip_marker_and_wrap(def);
            let mut sib = self.doc.next_element_sibling(def);
            while let Some(s) = sib {
                if set.contains(&s) {
                    break;
                }
                if !js_trim(&self.doc.tc(s)).is_empty() {
                    let c = self.doc.clone_subtree(s);
                    self.doc.append(cd, c);
                }
                self.pending.push(s);
                sib = self.doc.next_element_sibling(s);
            }
            self.add(st, &num.to_string(), cd, None);
            self.pending.push(def);
        }
        true
    }

    fn collect_section_list(&mut self, container: NodeId, st: &mut State) -> bool {
        let Some(list) = self.doc.qs(container, sel!("ol")) else { return false };
        let items: Vec<NodeId> = self.doc.elem_children(list).into_iter().filter(|c| self.doc.tag(*c) == Some("li")).collect();
        if items.is_empty() {
            return false;
        }
        for (i, li) in items.into_iter().enumerate() {
            let id = self.doc.id_of(li).to_lowercase();
            let id = if id.is_empty() { (i + 1).to_string() } else { id };
            let c = self.doc.clone_subtree(li);
            self.add(st, &id, c, None);
        }
        true
    }

    fn try_br_separated(&mut self, element: NodeId, st: &mut State) {
        let mut linked = HashSet::new();
        for a in self.doc.qsa(element, sel!("a[href^=\"#\"]")) {
            if marker_num(&js_trim(&self.doc.tc(a))).is_some() {
                let f = href_fragment(self.doc, Some(a));
                if !f.is_empty() {
                    linked.insert(f);
                }
            }
        }
        if linked.len() < 2 {
            return;
        }
        for block in self.doc.qsa(element, sel!("p, div")) {
            if !self.doc.has_tag_desc(block, &["br"]) {
                continue;
            }
            let mut segments: Vec<Vec<NodeId>> = Vec::new();
            let mut cur = Vec::new();
            for n in self.doc.children(block).to_vec() {
                if self.doc.tag(n) == Some("br") {
                    if !cur.is_empty() {
                        segments.push(std::mem::take(&mut cur));
                    }
                } else {
                    cur.push(n);
                }
            }
            if !cur.is_empty() {
                segments.push(cur);
            }
            let mut defs: Vec<(String, Vec<NodeId>)> = Vec::new();
            for nodes in segments {
                let mut anchor = None;
                for &n in &nodes {
                    match &self.doc.node(n).data {
                        NodeData::Text(t) => {
                            if !js_trim(t).is_empty() {
                                break;
                            }
                        }
                        NodeData::Element { name, .. } => {
                            if name == "a" && (self.doc.has_attr(n, "name") || !self.doc.id_of(n).is_empty()) {
                                anchor = Some(n);
                            }
                            break;
                        }
                        _ => {}
                    }
                }
                let Some(a) = anchor else { continue };
                let name = self.doc.get(a, "name");
                let id = if !name.is_empty() { name.to_lowercase() } else { self.doc.id_of(a).to_lowercase() };
                if id.is_empty() || !linked.contains(&id) {
                    continue;
                }
                defs.push((id, nodes.into_iter().filter(|n| *n != a).collect()));
            }
            if defs.len() < 2 {
                continue;
            }
            for (id, nodes) in defs {
                let cd = self.doc.create_element("div");
                for n in nodes {
                    let c = self.doc.clone_subtree(n);
                    self.doc.append(cd, c);
                }
                self.remove_backrefs(cd);
                self.trim_leading_ws(cd);
                self.add(st, &id, cd, None);
            }
            self.pending.push(block);
            if let Some(prev) = self.doc.prev_element_sibling(block) {
                if self.doc.tag(prev) == Some("hr") {
                    self.pending.push(prev);
                }
            }
            return;
        }
    }

    fn create_reference(&mut self, num: &str, ref_id: &str) -> NodeId {
        let sup = self.doc.create_element("sup");
        self.doc.set_attr(sup, "id", ref_id);
        let a = self.doc.create_element("a");
        self.doc.set_attr(a, "href", &format!("#fn:{num}"));
        let t = self.doc.create_text(num);
        self.doc.append(a, t);
        self.doc.append(sup, a);
        sup
    }

    fn outer_container(&self, el: NodeId) -> NodeId {
        let mut current = el;
        let mut parent = self.doc.parent_element(el);
        while let Some(p) = parent {
            let tag = self.doc.tag_name(p);
            if tag != "span" && tag != "sup" {
                break;
            }
            if tag == "span" {
                let other = self.doc.children(p).iter().any(|c| {
                    *c != current
                        && match &self.doc.node(*c).data {
                            NodeData::Text(t) => !js_trim(t).is_empty(),
                            NodeData::Element { name, .. } => name != "sup",
                            _ => false,
                        }
                });
                if other {
                    break;
                }
            }
            current = p;
            parent = self.doc.parent_element(p);
        }
        current
    }

    fn replace_preserving_text(&mut self, container: NodeId, reference: NodeId) {
        let mut direct = String::new();
        let mut has_elements = false;
        for c in self.doc.children(container) {
            match &self.doc.node(*c).data {
                NodeData::Text(t) => direct.push_str(t),
                NodeData::Element { .. } => has_elements = true,
                _ => {}
            }
        }
        let direct = js_trim(&direct).to_string();
        if !direct.is_empty() && has_elements {
            let t = self.doc.create_text(&direct);
            self.doc.replace_with_nodes(container, &[t, reference]);
        } else {
            self.doc.replace_with_nodes(container, &[reference]);
        }
    }

    fn inline_sidenotes(&mut self, element: NodeId) -> Collection {
        let mut out = BTreeMap::new();
        let containers = self.doc.qsa(element, sel!("span.footnote-container, span.sidenote-container, span.inline-footnote"));
        if containers.is_empty() {
            let footrefs = self.doc.qsa(element, sel!("label.footref"));
            if !footrefs.is_empty() {
                let mut count = 1;
                for label in footrefs {
                    let mut sib = self.doc.next_element_sibling(label);
                    if let Some(s) = sib {
                        if self.doc.tag(s) == Some("input") && self.doc.has_class(s, "footref-toggle") {
                            sib = self.doc.next_element_sibling(s);
                        }
                    }
                    let Some(sn) = sib.filter(|s| self.doc.tag(*s) == Some("span") && self.doc.has_class(*s, "sidenote")) else { continue };
                    let content = self.doc.clone_subtree(sn);
                    if let Some(sup) = self.doc.qs(content, sel!("sup")) {
                        if self.doc.first_child(content) == Some(sup) {
                            self.doc.remove(sup);
                        }
                    }
                    let n = count.to_string();
                    out.insert(count, Footnote { content, original_id: n.clone(), refs: vec![format!("fnref:{n}")] });
                    let r = self.create_reference(&n, &format!("fnref:{n}"));
                    if let Some(input) = self.doc.next_element_sibling(label) {
                        if self.doc.tag(input) == Some("input") && self.doc.has_class(input, "footref-toggle") {
                            self.doc.remove(input);
                        }
                    }
                    self.doc.remove(sn);
                    self.doc.replace_with_nodes(label, &[r]);
                    count += 1;
                }
                for footer in self.doc.by_tag(element, "footer") {
                    if self.doc.qs(footer, sel!(".footdef")).is_some() {
                        self.doc.remove(footer);
                    }
                }
                return out;
            }
            for s in self.doc.qsa(element, sel!("span.sidenote")) {
                self.doc.remove(s);
            }
            return out;
        }
        let mut count = 1;
        for c in containers {
            let Some(content) = self.doc.qs(c, sel!("span.footnote, span.sidenote, span.footnoteContent")) else { continue };
            let n = count.to_string();
            let clone = self.doc.clone_subtree(content);
            out.insert(count, Footnote { content: clone, original_id: n.clone(), refs: vec![format!("fnref:{n}")] });
            let r = self.create_reference(&n, &format!("fnref:{n}"));
            self.doc.replace_with_nodes(c, &[r]);
            count += 1;
        }
        out
    }

    fn sidenotes_column(&mut self, element: NodeId) -> Collection {
        let mut out = BTreeMap::new();
        let mut columns = self.doc.qsa(element, sel!(".sidenotes-column"));
        if columns.is_empty() {
            let mut anc = self.doc.parent_element(element);
            for _ in 0..3 {
                let Some(a) = anc else { break };
                if !columns.is_empty() {
                    break;
                }
                columns = self.doc.elem_children(a).into_iter().filter(|c| self.doc.has_class(*c, "sidenotes-column")).collect();
                anc = self.doc.parent_element(a);
            }
        }
        let mut count = 1;
        for column in columns {
            for sn in self.doc.qsa(column, sel!(".sidenote[id]")) {
                let id = self.doc.id_of(sn).to_string();
                if id.is_empty() {
                    continue;
                }
                let num_text: String = self.doc.qs(sn, sel!(".sidenote__id")).map(|s| self.doc.tc(s)).unwrap_or_default().chars().filter(|c| c.is_ascii_digit()).collect();
                let number = if num_text.is_empty() { count } else { num_text.parse().unwrap_or(count) };
                let cd = self.doc.create_element("div");
                for n in self.doc.children(sn).to_vec() {
                    if self.doc.is_element(n) && (self.doc.has_class(n, "sidenote__id") || self.doc.has_class(n, "sidenote__label") || self.doc.has_class(n, "sn-backref")) {
                        continue;
                    }
                    let c = self.doc.clone_subtree(n);
                    self.doc.append(cd, c);
                }
                self.remove_backrefs(cd);
                out.insert(number, Footnote { content: cd, original_id: id.to_lowercase(), refs: vec![] });
                count += 1;
            }
            self.doc.remove(column);
        }
        out
    }

    fn aside_footnotes(&mut self, element: NodeId) -> Collection {
        let mut out = BTreeMap::new();
        for ol in self.doc.qsa(element, sel!("aside > ol[start]")) {
            let Some(aside) = self.doc.parent_element(ol) else { continue };
            let Some(number) = super::util::parse_int(self.doc.get(ol, "start")).filter(|n| *n >= 1) else { continue };
            let items = self.doc.by_tag(ol, "li");
            if items.is_empty() {
                continue;
            }
            let cd = self.doc.create_element("div");
            if items.len() == 1 {
                let c = self.doc.clone_subtree(items[0]);
                self.doc.transfer_children(c, cd);
            } else {
                for li in items {
                    let p = self.doc.create_element("p");
                    let c = self.doc.clone_subtree(li);
                    self.doc.transfer_children(c, p);
                    self.doc.append(cd, p);
                }
            }
            out.insert(number, Footnote { content: cd, original_id: number.to_string(), refs: vec![] });
            self.doc.remove(aside);
        }
        out
    }

    fn hidden_aside_footnotes(&mut self, element: NodeId) -> Collection {
        let mut out = BTreeMap::new();
        let refs = self.doc.qsa(element, sel!("span[data-definition]"));
        if refs.is_empty() {
            return out;
        }
        let mut asides: HashMap<String, NodeId> = HashMap::new();
        for a in self.doc.qsa(element, sel!("aside[id]")) {
            asides.insert(self.doc.id_of(a).to_string(), a);
        }
        let mut count = 1;
        for r in refs {
            let def = self.doc.get(r, "data-definition").to_string();
            if def.is_empty() {
                continue;
            }
            let Some(&aside) = asides.get(&def) else { continue };
            let cd = self.doc.create_element("div");
            self.doc.transfer_children(aside, cd);
            self.doc.remove(aside);
            let n = count.to_string();
            let rid = format!("fnref:{n}");
            out.insert(count, Footnote { content: cd, original_id: def.to_lowercase(), refs: vec![rid.clone()] });
            let refn = self.create_reference(&n, &rid);
            self.doc.replace_with_nodes(r, &[refn]);
            count += 1;
        }
        out
    }

    fn inline_ref_id(&self, el: NodeId) -> Option<String> {
        let d = &*self.doc;
        let id_of = |e: NodeId| d.id_of(e).to_string();
        let rules: [(&crate::selector::SelectorList, &dyn Fn() -> String); 13] = [
            (sel!("sup.footnoteref"), &|| {
                d.qs(el, sel!("a[id^=\"footnoteref-\"]"))
                    .and_then(|l| regex!(r"^footnoteref-(\d+)$").captures(d.id_of(l)).map(|c| c[1].to_string()))
                    .unwrap_or_default()
            }),
            (sel!("a[id^=\"ref-link\"]"), &|| js_trim(&d.tc(el)).to_string()),
            (sel!("a[role=\"doc-biblioref\"]"), &|| {
                let rid = d.get(el, "data-xml-rid");
                if !rid.is_empty() {
                    return rid.to_string();
                }
                let href = d.get(el, "href");
                href.strip_prefix("#core-").map(|s| s.to_string()).filter(|_| href.starts_with("#core-R")).unwrap_or_default()
            }),
            (sel!("a.footnote-anchor, span.footnote-hovercard-target a"), &|| id_of(el).replacen("footnote-anchor-", "", 1).to_lowercase()),
            (sel!("sup.reference"), &|| {
                let mut id = String::new();
                for link in d.by_tag(el, "a") {
                    let href = d.get(link, "href");
                    let last = href.rsplit('/').next().unwrap_or("");
                    if let Some(c) = regex!(r"(?:cite_note|cite_ref)-(.+)").captures(last) {
                        id = c[1].to_lowercase();
                    }
                }
                id
            }),
            (sel!("sup[id^=\"fnref:\"], span[id^=\"fnref:\"]"), &|| id_of(el).replacen("fnref:", "", 1).to_lowercase()),
            (sel!("sup[id^=\"fnr\"]"), &|| id_of(el).replacen("fnr", "", 1).to_lowercase()),
            (sel!("sup.footnote-reference"), &|| href_fragment(d, d.qs(el, sel!("a[href^=\"#\"]")))),
            (sel!("span.footnote-reference"), &|| {
                let a = d.get(el, "data-footnote-id");
                if !a.is_empty() {
                    return a.to_string();
                }
                let i = id_of(el);
                if i.starts_with("fnref") {
                    i.replacen("fnref", "", 1).to_lowercase()
                } else {
                    String::new()
                }
            }),
            (sel!("span.footnote-link"), &|| d.get(el, "data-footnote-id").to_string()),
            (sel!("a.citation"), &|| js_trim(&d.tc(el)).to_string()),
            (sel!("a[id^=\"fnref\"]"), &|| id_of(el).replacen("fnref", "", 1).to_lowercase()),
            (sel!("a[data-type=\"noteref\"]"), &|| href_fragment(d, Some(el))),
        ];
        for (s, f) in rules {
            if d.is(el, s) {
                return Some(f());
            }
        }
        None
    }

    fn run(&mut self, element: NodeId) {
        let sidenotes = self.inline_sidenotes(element);
        let mut footnotes = self.hidden_aside_footnotes(element);
        for (k, v) in self.collect(element) {
            footnotes.entry(k).or_insert(v);
        }
        for (k, v) in self.sidenotes_column(element) {
            footnotes.entry(k).or_insert(v);
        }
        for (k, v) in self.aside_footnotes(element) {
            footnotes.entry(k).or_insert(v);
        }

        let refs = self.doc.qsa(element, sel!(FOOTNOTE_INLINE_REFERENCES));
        let mut by_original: HashMap<String, i64> = HashMap::new();
        for (k, v) in &footnotes {
            by_original.insert(v.original_id.to_lowercase(), *k);
        }
        let mut sup_groups: Vec<(NodeId, Vec<(String, String)>)> = Vec::new();

        for el in refs {
            if !self.doc.has_parent(el) || js_trim(&self.doc.tc(el)).is_empty() {
                continue;
            }
            if self.doc.is(el, sel!("cite.ltx_cite")) {
                let mut new_refs = Vec::new();
                for link in self.doc.by_tag(el, "a") {
                    let href = self.doc.get(link, "href");
                    if href.is_empty() {
                        continue;
                    }
                    let last = href.rsplit('/').next().unwrap_or("").to_string();
                    let Some(c) = regex!(r"bib\.bib(\d+)").captures(&last) else { continue };
                    let Some(&num) = by_original.get(&c[1].to_lowercase()) else { continue };
                    let fnum = num.to_string();
                    let data = footnotes.get_mut(&num).unwrap();
                    let rid = make_ref_id(&fnum, data.refs.len());
                    data.refs.push(rid.clone());
                    new_refs.push(self.create_reference(&fnum, &rid));
                }
                if !new_refs.is_empty() {
                    let container = self.outer_container(el);
                    let mut nodes = Vec::new();
                    for (i, r) in new_refs.into_iter().enumerate() {
                        if i > 0 {
                            nodes.push(self.doc.create_text(" "));
                        }
                        nodes.push(r);
                    }
                    self.doc.replace_with_nodes(container, &nodes);
                }
                continue;
            }
            let mut fid = self.inline_ref_id(el).unwrap_or_default();
            if fid.is_empty() {
                let href = self.doc.get(el, "href");
                if !href.is_empty() {
                    fid = href.strip_prefix('#').unwrap_or(href).to_lowercase();
                }
            }
            if fid.is_empty() {
                continue;
            }
            let Some(&num) = by_original.get(&fid.to_lowercase()) else { continue };
            let fnum = num.to_string();
            let container = self.outer_container(el);
            let is_sup = self.doc.tag(container) == Some("sup");
            if is_sup {
                if let Some((_, g)) = sup_groups.iter().find(|(c, _)| *c == container) {
                    if g.iter().any(|(n, _)| *n == fnum) {
                        continue;
                    }
                }
            }
            let data = footnotes.get_mut(&num).unwrap();
            let rid = make_ref_id(&fnum, data.refs.len());
            data.refs.push(rid.clone());
            if is_sup {
                match sup_groups.iter_mut().find(|(c, _)| *c == container) {
                    Some((_, g)) => g.push((fnum, rid)),
                    None => sup_groups.push((container, vec![(fnum, rid)])),
                }
            } else {
                let r = self.create_reference(&fnum, &rid);
                self.replace_preserving_text(container, r);
            }
        }

        if footnotes.values().any(|d| d.refs.is_empty()) {
            let unmatched: Vec<i64> = footnotes.iter().filter(|(_, d)| d.refs.is_empty()).map(|(k, _)| *k).collect();
            let mut id_map: HashMap<String, i64> = HashMap::new();
            let mut num_map: HashMap<String, i64> = HashMap::new();
            for k in &unmatched {
                id_map.insert(footnotes[k].original_id.clone(), *k);
                num_map.insert(k.to_string(), *k);
            }
            let inside = |h: &Handler, el: NodeId| {
                h.doc.closest_sel(el, sel!("[id^=\"fnref:\"]")).is_some()
                    || h.doc.closest_sel(el, sel!("#footnotes")).is_some()
                    || h.pending.iter().any(|g| h.doc.contains(*g, el))
            };
            for link in self.doc.qsa(element, sel!("a[href*=\"#\"]")) {
                if !self.doc.has_parent(link) || inside(self, link) {
                    continue;
                }
                let frag = href_fragment(self.doc, Some(link));
                if frag.is_empty() {
                    continue;
                }
                let Some(&k) = id_map.get(&frag) else { continue };
                if marker_num(&js_trim(&self.doc.tc(link))).is_none() {
                    continue;
                }
                self.assign_ref(&mut footnotes, link, k);
            }
            if footnotes.values().any(|d| d.refs.is_empty()) {
                for el in self.doc.qsa(element, sel!("sup, span.footnote-ref")) {
                    if !self.doc.has_parent(el) || self.doc.id_of(el).starts_with("fnref:") || self.doc.closest_sel(el, sel!("#footnotes")).is_some() {
                        continue;
                    }
                    let Some(m) = marker_num(&js_trim(&self.doc.tc(el))) else { continue };
                    let Some(&k) = num_map.get(&m).or_else(|| id_map.get(&m)) else { continue };
                    if !footnotes[&k].refs.is_empty() {
                        continue;
                    }
                    self.assign_ref(&mut footnotes, el, k);
                }
            }
        }

        for (container, refs) in sup_groups {
            let nodes: Vec<NodeId> = refs.iter().map(|(n, r)| self.create_reference(n, r)).collect();
            self.doc.replace_with_nodes(container, &nodes);
        }

        let new_list = self.doc.create_element("div");
        self.doc.set_attr(new_list, "id", "footnotes");
        let ol = self.doc.create_element("ol");
        let mut all = sidenotes;
        for (k, v) in footnotes {
            all.insert(k, v);
        }
        for (num, data) in &all {
            let item = self.create_item(*num, data.content, &data.refs);
            self.doc.append(ol, item);
        }
        for l in self.doc.qsa(element, sel!(FOOTNOTE_LIST_SELECTORS)) {
            self.doc.remove(l);
        }
        for p in std::mem::take(&mut self.pending) {
            if self.doc.has_parent(p) {
                self.doc.remove(p);
            }
        }
        remove_orphaned_dividers(self.doc, element);
        if !self.doc.elem_children(ol).is_empty() {
            self.doc.append(new_list, ol);
            self.doc.append(element, new_list);
        }
    }

    fn assign_ref(&mut self, footnotes: &mut Collection, el: NodeId, k: i64) {
        let fnum = k.to_string();
        let data = footnotes.get_mut(&k).unwrap();
        let rid = make_ref_id(&fnum, data.refs.len());
        data.refs.push(rid.clone());
        let container = self.outer_container(el);
        let r = self.create_reference(&fnum, &rid);
        self.replace_preserving_text(container, r);
    }
}

pub fn standardize_footnotes(doc: &mut Document, element: NodeId) {
    let mut h = Handler { doc, pending: Vec::new() };
    h.run(element);
}
