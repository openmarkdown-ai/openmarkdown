//! Run the clipper pipeline over a real page on disk.
//!
//! ```sh
//! cargo run -p vault-clip --example inspect -- page.html https://example.com/article
//! cargo run -p vault-clip --example inspect -- page.html https://example.com/article --template t.json
//! cargo run -p vault-clip --example inspect -- --markdown snippet.html [base-url]
//! ```
//!
//! Prints the extracted metadata, then the Markdown of the content (or the
//! rendered note when a clipper template JSON is given).

use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: inspect <file.html> <url> [--template t.json] | --markdown <file.html> [base]");
        std::process::exit(2);
    }
    if args[0] == "--dom" {
        // Re-serialise after parsing (compare with a browser/domino parse).
        let html = std::fs::read_to_string(&args[1]).expect("read html");
        let doc = vault_clip::html::Document::parse(&html);
        print!("{}", doc.outer_html(0));
        return;
    }
    if args[0] == "--clean" {
        // Convert already-standardised content HTML (e.g. Defuddle's output).
        let html = std::fs::read_to_string(&args[1]).expect("read html");
        print!("{}", vault_clip::clean_html_to_markdown(&html));
        return;
    }
    if args[0] == "--markdown" {
        let html = std::fs::read_to_string(&args[1]).expect("read html");
        println!("{}", vault_clip::html_to_markdown(&html, args.get(2).map(String::as_str)));
        return;
    }
    let html = std::fs::read_to_string(&args[0]).expect("read html");
    let url = args.get(1).cloned().unwrap_or_else(|| "https://example.com/".into());
    let now_ms = 1_757_721_600_000.0;

    let t = Instant::now();
    let (extracted, ctx) = vault_clip::page_context(&html, &url, now_ms, 0);
    let elapsed = t.elapsed();

    eprintln!("title:       {}", extracted.title);
    eprintln!("author:      {}", extracted.author);
    eprintln!("published:   {}", extracted.published);
    eprintln!("site:        {}", extracted.site);
    eprintln!("domain:      {}", extracted.domain);
    eprintln!("language:    {}", extracted.language);
    eprintln!("image:       {}", extracted.image);
    eprintln!("favicon:     {}", extracted.favicon);
    eprintln!("description: {}", extracted.description);
    eprintln!("words:       {}", extracted.word_count);
    eprintln!("meta tags:   {}", extracted.meta_tags.len());
    eprintln!("schema.org:  {} object(s)", extracted.schema_org_data.len());
    eprintln!("time:        {:?}", elapsed);
    eprintln!("---");

    if let Some(i) = args.iter().position(|a| a == "--template") {
        let json = std::fs::read_to_string(&args[i + 1]).expect("read template");
        let tpl = vault_clip::parse_template_json(&json).expect("template");
        let res = vault_clip::clip(&tpl, &ctx, &[]);
        println!("# note name: {}\n", res.note_name);
        println!("{}", res.full_content);
        for e in res.errors {
            eprintln!("template error line {}: {}", e.line, e.message);
        }
        return;
    }
    let md = vault_clip::clean_html_to_markdown(&extracted.content_html);
    println!("{md}");
}
