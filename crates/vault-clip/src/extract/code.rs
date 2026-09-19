//! Defuddle's `elements/code.ts`: every highlighter's markup becomes
//! `<pre><code data-lang="x" class="language-x">plain text</code></pre>`.

use super::util::{count_words, is_js_space, regex, sel, DomExt};
use crate::html::{Document, NodeData, NodeId};

pub const CODE_BLOCK_SELECTOR: &str = "pre, div[class*=\"prismjs\"], .syntaxhighlighter, .highlight, .highlight-source, .wp-block-syntaxhighlighter-code, .wp-block-code, div[class*=\"language-\"], .code-block[data-lang], code.hl.block";

pub fn is_code_language(s: &str) -> bool {
    matches!(
        s,
        "abap" | "actionscript" | "ada" | "adoc" | "agda" | "antlr4" | "applescript" | "arduino"
            | "armasm" | "asciidoc" | "aspnet" | "atom" | "bash" | "batch" | "c" | "clojure"
            | "cmake" | "cobol" | "coffeescript" | "cpp" | "c++" | "crystal" | "csharp" | "cs"
            | "dart" | "django" | "dockerfile" | "dotnet" | "elixir" | "elm" | "erlang"
            | "fortran" | "fsharp" | "gdscript" | "gitignore" | "glsl" | "golang" | "gradle"
            | "graphql" | "groovy" | "haskell" | "hs" | "haxe" | "hlsl" | "html" | "idris"
            | "java" | "javascript" | "js" | "jsx" | "jsdoc" | "json" | "jsonp" | "julia"
            | "kotlin" | "latex" | "lean" | "lean4" | "lisp" | "elisp" | "livescript" | "lua"
            | "makefile" | "markdown" | "md" | "markup" | "masm" | "mathml" | "matlab"
            | "mongodb" | "mysql" | "nasm" | "nginx" | "nim" | "nix" | "objc" | "ocaml"
            | "pascal" | "perl" | "php" | "postgresql" | "powershell" | "prolog" | "puppet"
            | "python" | "regex" | "rss" | "ruby" | "rb" | "rust" | "scala" | "scheme" | "shell"
            | "sh" | "solidity" | "sparql" | "sql" | "ssml" | "svg" | "swift" | "tcl"
            | "terraform" | "tex" | "toml" | "typescript" | "ts" | "tsx" | "unrealscript"
            | "verilog" | "vhdl" | "webassembly" | "wasm" | "xml" | "yaml" | "yml" | "zig"
    )
}

fn highlighter_match(class: &str) -> Option<String> {
    let pats = [
        regex!(r"^language-(\w+)$"),
        regex!(r"^lang-(\w+)$"),
        regex!(r"^(\w+)-code$"),
        regex!(r"^code-(\w+)$"),
        regex!(r"^syntax-(\w+)$"),
        regex!(r"^code-snippet__(\w+)$"),
        regex!(r"^highlight-(\w+)$"),
        regex!(r"^(\w+)-snippet$"),
        regex!(r"(?i)(?:^|\s)(?:language|lang|brush|syntax)-(\w+)(?:\s|$)"),
    ];
    for p in pats {
        if let Some(c) = p.captures(class) {
            let l = c[1].to_lowercase();
            if is_code_language(&l) {
                return Some(l);
            }
        }
    }
    None
}

thread_local! {
    /// Set by `standardize_fragment`: also read GitHub's `highlight-source-x`
    /// wrapper classes, which Defuddle's generic rule does not recognise (its
    /// GitHub extractor handles them only on issue pages).
    pub static GITHUB_HIGHLIGHT_CLASSES: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Language from `data-lang`/`data-language`/`language` or class patterns.
pub fn code_language(doc: &Document, el: NodeId) -> String {
    if GITHUB_HIGHLIGHT_CLASSES.with(|f| f.get()) {
        for c in doc.classes(el) {
            if let Some(l) = c.strip_prefix("highlight-source-") {
                let l = l.to_lowercase();
                if !l.is_empty() && l.chars().all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '+' || ch == '-') {
                    return l;
                }
            }
        }
    }
    for a in ["data-lang", "data-language", "language"] {
        let v = doc.get(el, a);
        if !v.is_empty() {
            return v.to_lowercase();
        }
    }
    let classes: Vec<String> = doc.classes(el).map(|s| s.to_string()).collect();
    if doc.has_class(el, "syntaxhighlighter") {
        if let Some(c) = classes.iter().find(|c| *c != "syntaxhighlighter" && *c != "nogutter") {
            if is_code_language(&c.to_lowercase()) {
                return c.to_lowercase();
            }
        }
    }
    for c in &classes {
        if let Some(l) = highlighter_match(&c.to_lowercase()) {
            return l;
        }
    }
    for c in &classes {
        if is_code_language(&c.to_lowercase()) {
            return c.to_lowercase();
        }
    }
    String::new()
}

fn line_selector() -> &'static crate::selector::SelectorList {
    sel!("div[class*=\"line\"], span[class*=\"line\"], .ec-line, [data-line-number], [data-line]")
}

fn structured_text(doc: &Document, node: NodeId) -> String {
    match &doc.node(node).data {
        NodeData::Text(t) => {
            if let Some(p) = doc.parent_element(node) {
                if doc.qs(p, sel!("[data-line], .line")).is_some() && t.chars().all(is_js_space) {
                    return String::new();
                }
            }
            t.clone()
        }
        NodeData::Element { name, .. } => {
            if doc.is(node, sel!(".hover-info, .hover-container")) {
                return String::new();
            }
            if name == "button" || name == "style" {
                return String::new();
            }
            if name == "br" {
                if let Some(prev) = doc.prev_element_sibling(node) {
                    if doc.is(prev, line_selector()) {
                        return String::new();
                    }
                }
                return "\n".to_string();
            }
            if doc.is(node, sel!("span.lnt, span.lineno, .react-syntax-highlighter-line-number, .rouge-gutter")) {
                return String::new();
            }
            if (name == "div" || name == "span") && doc.elem_children(node).len() == 2 {
                let kids = doc.elem_children(node);
                let gutter = doc.trimmed_text(kids[0]);
                if !gutter.is_empty() && gutter.bytes().all(|b| b.is_ascii_digit()) {
                    let t = structured_text(doc, kids[1]);
                    return t.strip_suffix('\n').unwrap_or(&t).to_string() + "\n";
                }
            }
            if doc.is(node, line_selector()) {
                if let Some(cc) = doc.qs(node, sel!(".code:not(.token), .content:not(.token), [class*=\"code-\"], [class*=\"content-\"]")) {
                    let t = doc.tc(cc);
                    return t.strip_suffix('\n').unwrap_or(&t).to_string() + "\n";
                }
                if let Some(ln) = doc.qs(node, sel!(".line-number, .gutter, [class*=\"line-number\"], [class*=\"gutter\"]")) {
                    let mut s = String::new();
                    for c in doc.children(node) {
                        if doc.contains(ln, *c) {
                            continue;
                        }
                        s.push_str(&structured_text(doc, *c));
                    }
                    return s.strip_suffix('\n').unwrap_or(&s).to_string() + "\n";
                }
                let t = doc.tc(node);
                return t.strip_suffix('\n').unwrap_or(&t).to_string() + "\n";
            }
            let mut s = String::new();
            for c in doc.children(node) {
                s.push_str(&structured_text(doc, *c));
            }
            s
        }
        _ => String::new(),
    }
}

fn wordpress_content(doc: &Document, el: NodeId) -> String {
    if let Some(container) = doc.qs(el, sel!(".syntaxhighlighter table .code .container")) {
        return doc
            .elem_children(container)
            .iter()
            .map(|line| {
                let parts: String = doc
                    .by_tag(*line, "code")
                    .iter()
                    .map(|c| {
                        let t = doc.tc(*c);
                        if doc.has_class(*c, "spaces") {
                            " ".repeat(super::util::utf16_len(&t))
                        } else {
                            t
                        }
                    })
                    .collect();
                if parts.is_empty() {
                    doc.tc(*line)
                } else {
                    parts
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    let lines = doc.qsa(el, sel!(".code .line"));
    if !lines.is_empty() {
        return lines
            .iter()
            .map(|line| {
                let parts: String = doc.by_tag(*line, "code").iter().map(|c| doc.tc(*c)).collect();
                if parts.is_empty() {
                    doc.tc(*line)
                } else {
                    parts
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    String::new()
}

fn trim_js_ws(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

pub fn transform_code_block(doc: &mut Document, el: NodeId) -> NodeId {
    for b in doc.qsa(el, sel!("button, [class*=\"codeblock-button\"]")) {
        doc.remove(b);
    }
    for h in doc.qsa(el, sel!("[class*=\"header\"], [class*=\"toolbar\"], [class*=\"titlebar\"], [class*=\"title-bar\"]")) {
        if !matches!(doc.tag_name(h), "div" | "span") {
            continue;
        }
        if let Some(la) = doc.closest_sel(h, sel!("[data-line], .line")) {
            if doc.contains(el, la) {
                continue;
            }
        }
        if doc.qs(h, sel!("[data-line], .line, pre")).is_some() {
            continue;
        }
        if count_words(&doc.trimmed_text(h)) <= 5 {
            doc.remove(h);
        }
    }

    let mut language = String::new();
    let mut current = Some(el);
    while let (Some(c), true) = (current, language.is_empty()) {
        language = code_language(doc, c);
        if language.is_empty() && c == el {
            let code = doc.qs(c, sel!("code[data-lang], code[class*=\"language-\"]")).or_else(|| doc.qs(c, sel!("code")));
            if let Some(code) = code {
                language = code_language(doc, code);
            }
        }
        current = doc.parent_element(c);
    }

    let cm = doc.qs(el, sel!(".cm-content"));
    if let (Some(cm), true) = (cm, language.is_empty()) {
        for div in doc.by_tag(el, "div") {
            if doc.contains(div, cm) {
                continue;
            }
            let t = doc.trimmed_text(div).to_lowercase();
            if !t.is_empty() && is_code_language(&t) {
                language = t;
                break;
            }
        }
    }

    let mut content = String::new();
    if doc.is(el, sel!(".syntaxhighlighter, .wp-block-syntaxhighlighter-code")) {
        content = wordpress_content(doc, el);
    }
    if content.is_empty() {
        if let Some(cm) = cm {
            content = structured_text(doc, cm);
        } else {
            let mut target = el;
            if !matches!(doc.tag_name(el), "pre" | "code") {
                let pres = doc.by_tag(el, "pre");
                let code_pre = pres
                    .iter()
                    .copied()
                    .find(|p| doc.qs(*p, sel!("code[data-lang], code[class*=\"language-\"], .line, [data-line]")).is_some())
                    .or_else(|| pres.iter().copied().find(|p| doc.qs(*p, sel!("span[class]")).is_some() && !doc.has_class(*p, "lineno")));
                if let Some(p) = code_pre {
                    target = p;
                }
            }
            content = structured_text(doc, target);
        }
    }

    let verso = doc.is(el, sel!("code.hl.block"));
    if verso {
        let t = content.trim_matches(|c| c == ' ' || c == '\t');
        content = t.replace('\t', "    ").replace('\u{a0}', " ");
        content = content.trim_start_matches('\n').to_string();
    } else {
        content = content.replace('\t', "    ").replace('\u{a0}', " ");
        let lines: Vec<&str> = content.split('\n').collect();
        let mut min_indent = usize::MAX;
        for line in &lines {
            if let Some(i) = line.char_indices().find(|(_, c)| !is_js_space(*c)).map(|(i, _)| i) {
                let units = super::util::utf16_len(&line[..i]);
                min_indent = min_indent.min(units);
            }
        }
        if min_indent == usize::MAX {
            min_indent = 0;
        }
        if min_indent > 0 {
            content = lines
                .iter()
                .map(|l| {
                    let mut units = 0;
                    let mut cut = l.len();
                    for (i, c) in l.char_indices() {
                        if units >= min_indent {
                            cut = i;
                            break;
                        }
                        units += c.len_utf16();
                    }
                    if units < min_indent {
                        cut = l.len();
                    }
                    &l[cut.min(l.len())..]
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
        content = trim_js_ws(&content).to_string();
        content = regex!(r"\n{3,}").replace_all(&content, "\n\n").into_owned();
        content = content.trim_matches('\n').to_string();
    }

    let mut ancestor = Some(el);
    for _ in 0..3 {
        let Some(a) = ancestor else { break };
        let Some(container) = doc.parent_element(a) else { break };
        if doc.tag(container) == Some("body") {
            break;
        }
        let kids = doc.elem_children(container);
        if kids.len() > 5 {
            break;
        }
        if doc.closest_sel(container, sel!("[data-callout]")).is_some() {
            break;
        }
        for sib in kids {
            if doc.contains(sib, el) {
                continue;
            }
            if !matches!(doc.tag_name(sib), "div" | "span") {
                continue;
            }
            if count_words(&doc.trimmed_text(sib)) <= 5
                && doc.qs(sib, sel!("pre, code, img, svg, table, h1, h2, h3, h4, h5, h6, p, blockquote, ul, ol, hr")).is_none()
            {
                doc.remove(sib);
            }
        }
        ancestor = Some(container);
    }

    let pre = doc.create_element("pre");
    if doc.is(el, sel!("code.hl.block, pre.hl.lean.lean-output")) {
        doc.set_attr(pre, "data-verso-code", "true");
    }
    let code = doc.create_element("code");
    if !language.is_empty() {
        doc.set_attr(code, "data-lang", &language);
        doc.set_attr(code, "class", &format!("language-{language}"));
    }
    if !content.is_empty() {
        let t = doc.create_text(&content);
        doc.append(code, t);
    }
    doc.append(pre, code);
    pre
}
