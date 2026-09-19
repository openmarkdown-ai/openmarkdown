//! Run the Defuddle port over a saved page and print what it found.
//!
//!   cargo run --example extract_inspect -- page.html https://example.com/page [--json|--content]
//!
//! Default output: metadata summary then the cleaned content HTML.
//! `--json` prints the whole `Extracted` as JSON; `--content` only the HTML.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: extract_inspect <file.html> <url> [--json|--content]");
        std::process::exit(2);
    }
    let html = std::fs::read(&args[1]).expect("read html");
    let html = String::from_utf8_lossy(&html);
    let start = std::time::Instant::now();
    let e = vault_clip::extract(&html, &args[2]);
    let elapsed = start.elapsed();
    match args.get(3).map(String::as_str) {
        Some("--json") => println!("{}", serde_json::to_string_pretty(&e).unwrap()),
        Some("--content") => print!("{}", e.content_html),
        _ => {
            println!("title:       {}", e.title);
            println!("author:      {}", e.author);
            println!("published:   {}", e.published);
            println!("description: {}", e.description);
            println!("image:       {}", e.image);
            println!("favicon:     {}", e.favicon);
            println!("site:        {}", e.site);
            println!("domain:      {}", e.domain);
            println!("language:    {}", e.language);
            println!("wordCount:   {}", e.word_count);
            println!("metaTags:    {}", e.meta_tags.len());
            println!("schemaOrg:   {}", e.schema_org_data.len());
            println!("variables:   {:?}", e.variables);
            println!("time:        {:?}", elapsed);
            println!("---");
            println!("{}", e.content_html);
        }
    }
}
