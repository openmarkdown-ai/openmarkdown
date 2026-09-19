//! Web pages into notes: readable-content extraction, HTML → Markdown, the
//! Obsidian Web Clipper template language, and importers from other note apps.
//! See docs/ARCHITECTURE.md ("vault-clip") and NOTES.md in this crate.
//!
//! ```text
//! extract(html, url)          → Extracted  (Defuddle port: metadata + cleaned content)
//! html_to_markdown(html, url) → String     (Web Clipper Markdown; plugin `htmlToMarkdown`)
//! render_template(tpl, ctx)   → String     (Knap + clipper variables/filters)
//! clip_page(html, url, tpl)   → ClipResult (the whole Web Clipper pipeline)
//! import::*                   → files      (ENEX, Notion, Roam, Keep, Bear, Logseq, CSV, HTML)
//! ```

pub mod date;
pub mod entities;
pub mod extract;
pub mod html;
pub mod import;
pub mod markdown;
pub mod selector;
pub mod template;
pub mod url;
pub mod value;
pub mod zip;

pub use extract::{extract, Extracted};
pub use import::format_converter::FormatConverterOptions;
pub use import::{ImportResult, ImportedFile};
pub use template::{validate_template, MetaTag, RenderResult};

/// Obsidian's Format converter core plugin over one note's Markdown.
pub fn format_convert(markdown: &str, opts: &FormatConverterOptions) -> String {
    import::format_converter::convert(markdown, opts)
}
pub use markdown::{clean_html_to_markdown, html_to_markdown};
pub use template::{
    clip, find_matching_template, match_trigger, parse_template_json, render_template,
    render_template_full, serialize_template_json, ClipResult, ClipperTemplate, PageData, Property,
    TemplateContext, TemplateError,
};

/// The clipper's page data for an extraction (`{{content}}` is the Markdown of
/// the cleaned content, as in `content-extractor.ts`).
pub fn page_data(extracted: &Extracted, full_html: &str, url: &str) -> PageData {
    PageData {
        title: extracted.title.clone(),
        author: extracted.author.clone(),
        content: clean_html_to_markdown(&extracted.content_html),
        content_html: extracted.content_html.clone(),
        url: url.to_string(),
        full_html: full_html.to_string(),
        description: extracted.description.clone(),
        favicon: extracted.favicon.clone(),
        image: extracted.image.clone(),
        published: extracted.published.clone(),
        site: extracted.site.clone(),
        language: extracted.language.clone(),
        word_count: extracted.word_count,
        schema_org: extracted.schema_org_data.clone(),
        meta_tags: extracted.meta_tags.clone(),
        extra: extracted.variables.clone(),
        ..Default::default()
    }
}

/// Extract a page and build a template context holding every preset, meta,
/// schema and selector variable.
pub fn page_context(html: &str, url: &str, now_ms: f64, tz_offset_minutes: i32) -> (Extracted, TemplateContext) {
    let extracted = extract(html, url);
    let data = page_data(&extracted, html, url);
    let mut ctx = TemplateContext::new(url, now_ms);
    ctx.tz_offset_minutes = tz_offset_minutes;
    ctx.variables = template::build_variables(&data, now_ms, tz_offset_minutes);
    ctx.page_html = Some(html.to_string());
    (extracted, ctx)
}

/// The Web Clipper pipeline end to end: extract, build variables, compile the
/// template's note name, properties (typed frontmatter) and content.
pub fn clip_page(
    html: &str,
    url: &str,
    tpl: &ClipperTemplate,
    property_types: &[(String, String)],
    now_ms: f64,
    tz_offset_minutes: i32,
) -> ClipResult {
    let (_, ctx) = page_context(html, url, now_ms, tz_offset_minutes);
    clip(tpl, &ctx, property_types)
}
