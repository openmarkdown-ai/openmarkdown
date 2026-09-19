//! Everything a generated page loads, as string constants. Nothing is fetched
//! from elsewhere except the optional MathJax and Mermaid CDN scripts.

pub mod icons;

/// Note typography, callouts, embeds and the light/dark palette.
pub const CONTENT_CSS: &str = include_str!("content.css");
/// Site layout: columns, navigation, search, outline, graph, popovers.
pub const SITE_CSS: &str = include_str!("site.css");
/// Site runtime (theme toggle, search, hover previews, graph).
pub const SITE_JS: &str = include_str!("site.js");

/// Callout folding for the standalone export (the site does it in site.js).
pub const NOTE_JS: &str = r#"document.addEventListener("click",function(e){var t=e.target.closest(".callout.is-collapsible > .callout-title");if(!t)return;var c=t.parentElement,n=c.querySelector(":scope > .callout-content"),f=t.querySelector(".callout-fold"),x=c.classList.toggle("is-collapsed");if(f)f.classList.toggle("is-collapsed",x);if(n)n.style.display=x?"none":"";});"#;

pub const MATHJAX_VERSION: &str = "3.2.2";
pub const MERMAID_VERSION: &str = "11.4.1";

/// MathJax, configured for the `\(…\)` / `\[…\]` delimiters the exporter
/// wraps `.math` elements' TeX in.
pub fn mathjax_tags() -> String {
    format!(
        "<script>window.MathJax={{tex:{{inlineMath:[['\\\\(','\\\\)']],displayMath:[['\\\\[','\\\\]']]}},svg:{{fontCache:'global'}}}};</script>\n<script async src=\"https://cdn.jsdelivr.net/npm/mathjax@{MATHJAX_VERSION}/es5/tex-svg.js\"></script>\n"
    )
}

/// Mermaid as an ES module, themed to the page's current colour scheme.
pub fn mermaid_tags() -> String {
    format!(
        "<script type=\"module\">import mermaid from \"https://cdn.jsdelivr.net/npm/mermaid@{MERMAID_VERSION}/dist/mermaid.esm.min.mjs\";mermaid.initialize({{startOnLoad:true,theme:document.body.classList.contains(\"theme-dark\")||(!document.body.classList.contains(\"theme-light\")&&matchMedia(\"(prefers-color-scheme: dark)\").matches)?\"dark\":\"default\"}});</script>\n"
    )
}
