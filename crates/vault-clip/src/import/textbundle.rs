//! TextBundle and TextPack files (Ulysses, iA Writer, Craft and others).
//!
//! Mirrors obsidian-importer's TextBundle importer: each bundle's `text.md`
//! or `text.markdown` becomes a note named after the bundle, bundles whose
//! `info.json` declares a type other than Markdown are skipped, assets are
//! copied to an attachment folder, and `![](assets/name)` becomes
//! `![[name]]`. Accepts `.textpack` zips, zips of bundles, and the files of
//! unpacked `.textbundle` folders.

use super::util::{basename, extension_lower, parent, percent_decode, sanitize_file_name, UniquePaths};
use super::{ImportResult, ImportedFile, LinkResolver};
use std::collections::BTreeMap;

pub fn convert(files: &[(String, Vec<u8>)]) -> ImportResult {
    let mut result = ImportResult::default();
    let mut flat: Vec<(String, Vec<u8>)> = Vec::new();
    for (path, data) in files {
        let ext = extension_lower(path);
        if ext == "textpack" || ext == "zip" {
            match crate::zip::read_zip(data) {
                Ok(entries) => {
                    let pack = basename(path);
                    for e in entries.into_iter().filter(|e| !e.is_dir) {
                        // A textpack's entries may sit at its root; give them
                        // the pack's name as their bundle.
                        let name = if ext == "textpack" && !e.name.contains(".textbundle/") {
                            format!("{}.textbundle/{}", pack.trim_end_matches(".textpack"), e.name)
                        } else {
                            e.name
                        };
                        flat.push((name, e.data));
                    }
                }
                Err(e) => result.warnings.push(format!("{path}: {e}")),
            }
        } else {
            flat.push((path.clone(), data.clone()));
        }
    }
    flat.retain(|(p, _)| !(basename(p).starts_with("._") || p.contains("__MACOSX/")));

    // Group by bundle folder: the path up to and including `.textbundle`.
    let mut bundles: BTreeMap<String, Vec<(String, &[u8])>> = BTreeMap::new();
    for (p, d) in &flat {
        match p.find(".textbundle/") {
            Some(i) => bundles
                .entry(p[..i + 11].to_string())
                .or_default()
                .push((p[i + 12..].to_string(), d)),
            None => result.warnings.push(format!("Skipped {p}: not inside a .textbundle")),
        }
    }

    let mut paths = UniquePaths::new();
    let mut notes: Vec<(String, String)> = Vec::new();
    let mut attachments: Vec<ImportedFile> = Vec::new();
    let mut written: std::collections::HashMap<(String, String), String> = std::collections::HashMap::new();
    for (bundle, entries) in &bundles {
        if let Some((_, info)) = entries.iter().find(|(n, _)| n == "info.json") {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(info) {
                if let Some(t) = v.get("type").and_then(|t| t.as_str()) {
                    if t != "net.daringfireball.markdown" {
                        result.warnings.push(format!("Skipped {bundle}: not a Markdown bundle ({t})"));
                        continue;
                    }
                }
            }
        }
        let name = basename(bundle).trim_end_matches(".textbundle");
        let mut asset_names: BTreeMap<String, String> = BTreeMap::new();
        for (n, d) in entries {
            if n.starts_with("assets/") && !n.ends_with('/') {
                // The same image in several bundles is one attachment (the
                // importer skips a name that already exists).
                let name = sanitize_file_name(basename(n));
                let key = (name.to_lowercase(), super::util::md5_hex(d));
                let out = match written.get(&key) {
                    Some(p) => p.clone(),
                    None => {
                        let p = paths.claim("attachments", &name);
                        attachments.push(ImportedFile::new(p.clone(), d.to_vec()));
                        written.insert(key, p.clone());
                        p
                    }
                };
                asset_names.insert(n["assets/".len()..].to_string(), out);
            }
        }
        for (n, d) in entries {
            let ext = extension_lower(n);
            if !parent(n).is_empty() || !(ext == "md" || ext == "markdown") {
                continue;
            }
            let path = paths.claim("", &format!("{}.md", sanitize_file_name(name)));
            let text = super::util::decode_text(d);
            // Code examples of the syntax are left as written.
            let resolved = super::mdcode::outside_code(&text, |seg| {
                let mut resolved = String::new();
                let mut rest = seg;
                while let Some(at) = rest.find("![](assets/") {
                    let start = at + "![](assets/".len();
                    let Some(close) = rest[start..].find(')') else {
                        break;
                    };
                    let asset = percent_decode(&rest[start..start + close]);
                    resolved.push_str(&rest[..at]);
                    resolved.push_str(&format!("\u{0}{}\u{0}", asset_names.get(&asset).cloned().unwrap_or(asset)));
                    rest = &rest[start + close + 1..];
                }
                resolved.push_str(rest);
                resolved
            });
            notes.push((path, resolved));
        }
    }
    let resolver = LinkResolver::new(
        notes
            .iter()
            .map(|(p, _)| p.as_str())
            .chain(attachments.iter().map(|a| a.path.as_str())),
    );
    for (path, text) in notes {
        let mut out = String::new();
        for (i, part) in text.split('\u{0}').enumerate() {
            if i % 2 == 1 {
                out.push_str(&format!("![[{}]]", resolver.link(part)));
            } else {
                out.push_str(part);
            }
        }
        result.files.push(ImportedFile::note(path, out));
    }
    result.files.extend(attachments);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::{Method, ZipWriter};

    #[test]
    fn textpack_and_folder_bundles() {
        let mut z = ZipWriter::new();
        z.add_text("info.json", r#"{"version":2,"type":"net.daringfireball.markdown"}"#);
        z.add_text("text.md", "# Packed\n\n![](assets/pic%201.png)\n");
        z.add("assets/pic 1.png", b"PNG", Method::Store);
        let files = vec![
            ("Example.textpack".to_string(), z.finish()),
            ("Loose.textbundle/text.markdown".to_string(), b"Loose ![](assets/pic 1.png)".to_vec()),
            ("Loose.textbundle/assets/pic 1.png".to_string(), b"PNG2".to_vec()),
            ("Other.textbundle/info.json".to_string(), br#"{"type":"public.plain-text"}"#.to_vec()),
            ("Other.textbundle/text.txt".to_string(), b"x".to_vec()),
        ];
        let r = convert(&files);
        assert_eq!(r.text("Example.md"), "# Packed\n\n![[pic 1.png]]\n");
        assert_eq!(r.text("Loose.md"), "Loose ![[pic 1 1.png]]");
        assert_eq!(r.file("attachments/pic 1 1.png").unwrap().data, b"PNG2");
        assert_eq!(r.warnings.len(), 1, "{:?}", r.warnings);
    }

    // Regression from the importer's example bundles: the same image in two
    // bundles was written twice, and a code example of the syntax rewritten.
    #[test]
    fn shared_assets_once_and_code_untouched() {
        let text = "Use `![](assets/a.png)` to embed:\n\n![](assets/a.png)";
        let files = vec![
            ("One.textbundle/text.md".to_string(), text.as_bytes().to_vec()),
            ("One.textbundle/assets/a.png".to_string(), b"PNG".to_vec()),
            ("Two.textbundle/text.md".to_string(), text.as_bytes().to_vec()),
            ("Two.textbundle/assets/a.png".to_string(), b"PNG".to_vec()),
        ];
        let r = convert(&files);
        assert_eq!(r.files.iter().filter(|f| f.path.starts_with("attachments/")).count(), 1);
        assert_eq!(r.text("Two.md"), "Use `![](assets/a.png)` to embed:\n\n![[a.png]]");
    }
}
