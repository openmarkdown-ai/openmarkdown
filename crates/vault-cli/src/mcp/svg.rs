//! A tiny hand-written SVG writer for the graph and canvas pictures.
//!
//! No dependencies: the images are plain text built here, so the binary stays
//! the same size and the server never needs a browser or a raster library.
//! Everything that reaches an attribute or a text node goes through [`esc`].

use std::fmt::Write as _;

/// XML-escapes text for an attribute value or a text node.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            // Control characters are not legal in XML 1.0.
            c if (c as u32) < 0x20 && c != '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Shortens to `max` characters, ending with `…` when it had to cut.
pub fn ellipsis(s: &str, max: usize) -> String {
    let s = s.replace(['\n', '\r', '\t'], " ");
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Greedily wraps `text` into lines of at most `cols` characters, at most
/// `max_lines` of them (the last one ends with `…` when text is left over).
pub fn wrap(text: &str, cols: usize, max_lines: usize) -> Vec<String> {
    let cols = cols.max(4);
    let mut lines: Vec<String> = Vec::new();
    for para in text.split('\n') {
        if lines.len() >= max_lines {
            break;
        }
        let para = para.trim_end();
        if para.is_empty() {
            if !lines.is_empty() && !lines.last().is_some_and(|l| l.is_empty()) {
                lines.push(String::new());
            }
            continue;
        }
        let mut line = String::new();
        for word in para.split_whitespace() {
            let word_len = word.chars().count();
            if line.is_empty() {
                line = if word_len > cols { ellipsis(word, cols) } else { word.to_string() };
            } else if line.chars().count() + 1 + word_len <= cols {
                line.push(' ');
                line.push_str(word);
            } else {
                lines.push(std::mem::take(&mut line));
                if lines.len() >= max_lines {
                    break;
                }
                line = if word_len > cols { ellipsis(word, cols) } else { word.to_string() };
            }
        }
        if !line.is_empty() && lines.len() < max_lines {
            lines.push(line);
        }
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    if lines.len() > max_lines {
        lines.truncate(max_lines);
    }
    lines
}

/// An SVG document being built.
pub struct Svg {
    body: String,
    pub width: f64,
    pub height: f64,
    view: (f64, f64, f64, f64),
    defs: String,
}

impl Svg {
    pub fn new(view: (f64, f64, f64, f64), width: f64, height: f64) -> Svg {
        Svg { body: String::new(), width, height, view, defs: String::new() }
    }

    pub fn defs(&mut self, s: &str) {
        self.defs.push_str(s);
        self.defs.push('\n');
    }

    pub fn line(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, class: &str, extra: &str) {
        let _ = writeln!(
            self.body,
            r#"<line x1="{x1:.1}" y1="{y1:.1}" x2="{x2:.1}" y2="{y2:.1}" class="{class}"{extra}/>"#
        );
    }

    pub fn circle(&mut self, cx: f64, cy: f64, r: f64, class: &str, extra: &str) {
        let _ = writeln!(self.body, r#"<circle cx="{cx:.1}" cy="{cy:.1}" r="{r:.1}" class="{class}"{extra}/>"#);
    }

    /// `box_` is `(x, y, width, height)`.
    pub fn rect(&mut self, box_: (f64, f64, f64, f64), rx: f64, class: &str, extra: &str) {
        let (x, y, w, h) = box_;
        let _ = writeln!(
            self.body,
            r#"<rect x="{x:.1}" y="{y:.1}" width="{w:.1}" height="{h:.1}" rx="{rx:.1}" class="{class}"{extra}/>"#
        );
    }

    pub fn text(&mut self, x: f64, y: f64, size: f64, class: &str, anchor: &str, s: &str) {
        let _ = writeln!(
            self.body,
            r#"<text x="{x:.1}" y="{y:.1}" font-size="{size:.1}" text-anchor="{anchor}" class="{class}">{}</text>"#,
            esc(s)
        );
    }

    /// Several lines of text starting at the baseline `y`.
    pub fn text_block(&mut self, x: f64, y: f64, size: f64, leading: f64, class: &str, lines: &[String]) {
        for (i, l) in lines.iter().enumerate() {
            if l.is_empty() {
                continue;
            }
            self.text(x, y + i as f64 * leading, size, class, "start", l);
        }
    }

    pub fn title(&mut self, s: &str) {
        let _ = writeln!(self.body, "<title>{}</title>", esc(s));
    }

    pub fn group_open(&mut self, attrs: &str) {
        let _ = writeln!(self.body, "<g {attrs}>");
    }

    pub fn group_close(&mut self) {
        self.body.push_str("</g>\n");
    }

    /// The finished document. `css` is inserted as a `<style>` block, so it
    /// can carry a `prefers-color-scheme` rule for dark mode.
    pub fn finish(self, title: &str, css: &str) -> String {
        let (vx, vy, vw, vh) = self.view;
        format!(
            concat!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0}" height="{h:.0}" "#,
                r#"viewBox="{vx:.1} {vy:.1} {vw:.1} {vh:.1}" role="img" aria-label="{label}">"#,
                "\n<title>{label}</title>\n<style>{css}</style>\n<defs>\n{defs}</defs>\n",
                r#"<rect x="{vx:.1}" y="{vy:.1}" width="{vw:.1}" height="{vh:.1}" class="bg"/>"#,
                "\n{body}</svg>\n"
            ),
            w = self.width,
            h = self.height,
            vx = vx,
            vy = vy,
            vw = vw,
            vh = vh,
            label = esc(title),
            css = css,
            defs = self.defs,
            body = self.body,
        )
    }
}

/// The colours both pictures share, with a dark-mode variant.
pub const THEME_CSS: &str = "\
.bg{fill:#ffffff}\
text{font-family:ui-sans-serif,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;fill:#1f2328}\
.muted{fill:#6b7280}\
.edge{stroke:#c3c8d0;stroke-width:1.2}\
.card{fill:#f6f7f9;stroke:#d5d9e0;stroke-width:1.5}\
.group{fill:#eef1f5;stroke:#c3c8d0;stroke-width:1.5;stroke-dasharray:6 4}\
.node{fill:#5b8def;stroke:#ffffff;stroke-width:1}\
.node-attachment{fill:#9aa4b2}\
.node-tag{fill:#43b581}\
.node-unresolved{fill:none;stroke:#e0a33e;stroke-width:1.6;stroke-dasharray:3 2}\
.node-center{stroke:#1f2328;stroke-width:2}\
.arrow{fill:#c3c8d0}\
@media (prefers-color-scheme:dark){\
.bg{fill:#14161a}\
text{fill:#e6e9ef}\
.muted{fill:#9aa4b2}\
.edge{stroke:#3a4048}\
.card{fill:#1d2026;stroke:#343a43}\
.group{fill:#191c21;stroke:#343a43}\
.node{stroke:#14161a}\
.node-center{stroke:#e6e9ef}\
.arrow{fill:#3a4048}}";
