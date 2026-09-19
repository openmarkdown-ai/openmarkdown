//! One note → one self-contained HTML document.

use std::collections::HashMap;

use crate::assets::{self, icons};
use crate::html::esc;
use crate::input::{NoteExportInput, Theme};
use crate::paths;
use crate::pipeline::{properties_table, render_note, Ctx, Mode, PageState, Vault};

pub fn export_note(input: &NoteExportInput) -> String {
    let vault = Vault::build(&input.files);
    let path = input.path.trim_start_matches('/').to_string();
    let opts = &input.options;
    let page = paths::page_path(&path);
    let mut pages: HashMap<String, String> = HashMap::new();
    pages.insert(path.clone(), page.clone());
    for other in &opts.exported {
        let other = other.trim_start_matches('/');
        if vault.index.note(other).is_some() || paths::is_note(other) {
            pages.insert(other.to_string(), paths::page_path(other));
        }
    }
    let ctx = Ctx {
        vault: &vault,
        mode: Mode::Note { pages: &pages },
        page: page.clone(),
        note: path.clone(),
        strict_line_breaks: opts.strict_line_breaks,
        embed_depth: opts.embed_depth,
    };
    let mut st = PageState::default();
    let (body, _plain) = render_note(&ctx, &mut st);
    let title = opts.title.clone().unwrap_or_else(|| paths::note_title(&path));
    let fm = vault.frontmatter(&path);
    let css_classes: Vec<String> = fm
        .and_then(|f| vault_index::tags::frontmatter_strings(f, "cssclasses").or_else(|| vault_index::tags::frontmatter_strings(f, "cssclass")))
        .unwrap_or_default();
    let description = fm.and_then(|f| f.get("description")).and_then(|v| v.as_str()).map(str::to_string);

    let mut html = String::with_capacity(body.len() + assets::CONTENT_CSS.len() + 2048);
    html.push_str("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n");
    html.push_str("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n");
    html.push_str(&format!("<title>{}</title>\n", esc(&title)));
    if let Some(d) = &description {
        html.push_str(&format!("<meta name=\"description\" content=\"{}\">\n", esc(d)));
    }
    html.push_str("<meta name=\"generator\" content=\"vault-publish\">\n<style>\n");
    html.push_str(assets::CONTENT_CSS);
    html.push_str("\n.markdown-preview-view{max-width:var(--file-line-width);margin:0 auto;padding:48px 24px 80px}\n@media print{.markdown-preview-view{padding:0;max-width:none}}\n");
    if let Some(css) = &opts.css {
        html.push_str(css);
        html.push('\n');
    }
    html.push_str("</style>\n</head>\n");
    let body_class = match opts.theme {
        Theme::Light => " class=\"theme-light\"",
        Theme::Dark => " class=\"theme-dark\"",
        Theme::Auto => "",
    };
    html.push_str(&format!("<body{body_class}>\n"));
    if st.has_callout {
        html.push_str(icons::LICENSE_COMMENT);
        html.push('\n');
    }
    let classes = std::iter::once("markdown-preview-view markdown-rendered".to_string())
        .chain(css_classes.iter().map(|c| esc(c)))
        .collect::<Vec<_>>()
        .join(" ");
    html.push_str(&format!("<article class=\"{classes}\">\n"));
    if opts.inline_title {
        html.push_str(&format!("<h1 class=\"page-header page-title\">{}</h1>\n", esc(&title)));
    }
    if opts.show_properties {
        if let Some(fm) = fm {
            html.push_str(&properties_table(fm, &[]));
        }
    }
    html.push_str(&body);
    html.push_str("</article>\n");
    if st.has_callout {
        html.push_str(&format!("<script>{}</script>\n", assets::NOTE_JS));
    }
    if opts.cdn && st.has_math {
        html.push_str(&assets::mathjax_tags());
    }
    if opts.cdn && st.has_mermaid {
        html.push_str(&assets::mermaid_tags());
    }
    html.push_str("</body>\n</html>\n");
    html
}
