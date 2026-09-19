//! Tags: `getAllTags`, frontmatter `tags`, and `MetadataCache.getTags()`.
//!
//! What the app does (1.13), which differs from what people often assume:
//!
//! * Only a property named `tags` (any case) counts. The legacy `tag` key is
//!   not read at index time — the "Format converter" migrates it.
//! * A string value is **one** tag after trimming; it is not split on commas
//!   or spaces. A value containing a space is dropped, so `tags: a, b` gives
//!   no tags, while `tags: work` gives `#work`. Lists keep their string items
//!   (numbers are dropped), each trimmed, empty and space-containing items
//!   dropped. A missing `#` is added.
//! * `getTags()` counts every tag *and every parent*: `#a/b/c` adds one to
//!   `#a/b/c`, `#a/b` and `#a`. Invalid tags (`#123`, punctuation) are
//!   skipped, a trailing `/` is ignored.
//! * Keys are merged case-insensitively; the spelling kept is the one with
//!   the highest count, the first one seen winning a tie.

use serde_json::{Map, Value};
use vault_types::CachedMetadata;

/// Values of the first frontmatter key matching `name` case-insensitively,
/// as Obsidian's `QT`: a string becomes a one-item list, a list keeps its
/// string items (trimmed), anything else is `None`.
pub fn frontmatter_strings(fm: &Map<String, Value>, name: &str) -> Option<Vec<String>> {
    let (_, v) = fm.iter().find(|(k, _)| k.to_lowercase() == name)?;
    match v {
        Value::String(s) if !s.is_empty() => Some(vec![s.trim().to_string()]),
        Value::Array(a) => Some(
            a.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .collect(),
        ),
        _ => None,
    }
}

/// The actual spelling of the `tags` key, as `IA(frontmatter, "tags")`.
pub fn tags_key(fm: &Map<String, Value>) -> String {
    if fm.contains_key("tags") {
        return "tags".into();
    }
    fm.keys()
        .find(|k| k.to_lowercase() == "tags")
        .cloned()
        .unwrap_or_else(|| "tags".into())
}

/// Frontmatter tags with `#` (Obsidian's `parseFrontMatterTags`).
pub fn frontmatter_tags(fm: Option<&Map<String, Value>>) -> Option<Vec<String>> {
    let fm = fm?;
    let v = frontmatter_strings(fm, "tags")?;
    Some(
        v.into_iter()
            .filter(|t| !t.is_empty() && !t.contains(' '))
            .map(|t| {
                if t.starts_with('#') {
                    t
                } else {
                    format!("#{t}")
                }
            })
            .collect(),
    )
}

/// Frontmatter aliases (`parseFrontMatterAliases`).
pub fn frontmatter_aliases(fm: Option<&Map<String, Value>>) -> Vec<String> {
    let Some(fm) = fm else { return Vec::new() };
    frontmatter_strings(fm, "aliases")
        .unwrap_or_default()
        .into_iter()
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .collect()
}

/// `getAllTags(cache)`: frontmatter tags first, then body tags in order.
pub fn all_tags(meta: &CachedMetadata) -> Vec<String> {
    let mut out = frontmatter_tags(meta.frontmatter.as_ref()).unwrap_or_default();
    if let Some(tags) = &meta.tags {
        out.extend(tags.iter().map(|t| t.tag.clone()));
    }
    out
}

/// Obsidian's tag validity test: `#` followed by one or more characters that
/// are not whitespace, not ASCII punctuation other than `-`, `_`, `/`, and
/// not in the General/Supplemental Punctuation blocks; and not all digits.
pub fn is_valid_tag(tag: &str) -> bool {
    let Some(body) = tag.strip_prefix('#') else {
        return false;
    };
    if body.is_empty() {
        return false;
    }
    if body.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    body.chars().all(|c| {
        !(c.is_whitespace()
            || ('\u{2000}'..='\u{206F}').contains(&c)
            || ('\u{2E00}'..='\u{2E7F}').contains(&c)
            || "'!\"#$%&()*+,.:;<=>?@^`{|}~[]\\".contains(c))
    })
}

/// `getTags()` over an iterator of caches.
pub fn count_tags<'a>(
    caches: impl Iterator<Item = &'a CachedMetadata>,
) -> std::collections::BTreeMap<String, u32> {
    // Insertion-ordered counts, as a JS object would iterate.
    let mut order: Vec<String> = Vec::new();
    let mut counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for meta in caches {
        for tag in all_tags(meta) {
            let mut t = tag.as_str();
            loop {
                if let Some(s) = t.strip_suffix('/') {
                    t = s;
                }
                if !is_valid_tag(t) {
                    break;
                }
                let c = counts.entry(t.to_string()).or_insert_with(|| {
                    order.push(t.to_string());
                    0
                });
                *c += 1;
                match t.rfind('/') {
                    Some(i) => t = &t[..i],
                    None => break,
                }
            }
        }
    }
    struct Merged {
        tag: String,
        count: u32,
        max: u32,
    }
    let mut merged: Vec<Merged> = Vec::new();
    let mut by_lower: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for t in order {
        let p = counts[&t];
        let lower = t.to_lowercase();
        match by_lower.get(&lower) {
            Some(&i) => {
                let m = &mut merged[i];
                m.count += p;
                if p > m.max {
                    m.max = p;
                    m.tag = t;
                }
            }
            None => {
                by_lower.insert(lower, merged.len());
                merged.push(Merged {
                    tag: t,
                    count: p,
                    max: p,
                });
            }
        }
    }
    merged.into_iter().map(|m| (m.tag, m.count)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use vault_types::TagCache;

    fn fm(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn frontmatter_tag_string_is_one_tag() {
        assert_eq!(
            frontmatter_tags(Some(&fm(json!({"tags": "work"})))),
            Some(vec!["#work".into()])
        );
        assert_eq!(
            frontmatter_tags(Some(&fm(json!({"tags": "a, b"})))),
            Some(vec![])
        );
        assert_eq!(
            frontmatter_tags(Some(&fm(
                json!({"Tags": ["#x", " y ", 3, "has space", ""]})
            ))),
            Some(vec!["#x".into(), "#y".into()])
        );
        assert_eq!(frontmatter_tags(Some(&fm(json!({"tag": "legacy"})))), None);
    }

    #[test]
    fn aliases_trim_and_filter() {
        assert_eq!(
            frontmatter_aliases(Some(&fm(json!({"aliases": [" A ", "", 1, "B"]})))),
            vec!["A", "B"]
        );
        assert_eq!(
            frontmatter_aliases(Some(&fm(json!({"ALIASES": "Solo"})))),
            vec!["Solo"]
        );
    }

    #[test]
    fn tag_validity() {
        assert!(is_valid_tag("#a/b-c_d"));
        assert!(is_valid_tag("#日本"));
        assert!(!is_valid_tag("#123"));
        assert!(is_valid_tag("#1a"));
        assert!(!is_valid_tag("#a.b"));
        assert!(!is_valid_tag("#"));
        assert!(!is_valid_tag("tag"));
    }

    fn meta(front: Option<Value>, tags: &[&str]) -> CachedMetadata {
        CachedMetadata {
            frontmatter: front.map(fm),
            tags: Some(
                tags.iter()
                    .map(|t| TagCache {
                        tag: t.to_string(),
                        position: Default::default(),
                    })
                    .collect(),
            ),
            ..Default::default()
        }
    }

    #[test]
    fn get_tags_counts_parents_and_merges_case() {
        let a = meta(
            Some(json!({"tags": ["project/alpha"]})),
            &["#Project/beta", "#todo"],
        );
        let b = meta(None, &["#project", "#todo/", "#123"]);
        let c = meta(None, &["#TODO", "#TODO"]);
        let tags = count_tags([a, b, c].iter());
        // "#project" (count 2) and "#Project" (count 1) merge under the
        // more frequent spelling.
        assert_eq!(tags.get("#project"), Some(&3));
        assert_eq!(tags.get("#project/alpha"), Some(&1));
        assert_eq!(tags.get("#Project/beta"), Some(&1));
        // #todo: 2 (#todo, #todo/) vs #TODO: 2 → tie keeps the first spelling.
        assert_eq!(tags.get("#todo"), Some(&4));
        assert!(!tags.contains_key("#TODO"));
        assert!(!tags.contains_key("#123"));
    }
}
