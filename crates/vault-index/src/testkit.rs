//! A deliberately crude Markdown scanner that produces `CachedMetadata`.
//!
//! The real parser is `vault-ofm`. This exists so the index's tests and its
//! `inspect` example can build metadata from plain strings without depending
//! on it: frontmatter with simple YAML (scalars, flow lists, block lists),
//! headings, fenced code (skipped), list items and tasks, paragraphs,
//! wikilinks and embeds, local Markdown links, and `#tags`. Every position
//! goes through `LineIndex`, so it is UTF-16 like the real thing.
//!
//! The example includes this file with `#[path]`, so it must only use
//! `vault_types`, `serde_json` and `std`.

#![allow(dead_code)]

use serde_json::{Map, Number, Value};
use vault_types::{
    CachedMetadata, FrontmatterLinkCache, HeadingCache, LineIndex, LinkCache, ListItemCache, Pos,
    SectionCache, TagCache,
};

pub fn parse(text: &str) -> CachedMetadata {
    let idx = LineIndex::new(text);
    let mut meta = CachedMetadata::default();
    let mut links = Vec::new();
    let mut embeds = Vec::new();
    let mut tags = Vec::new();
    let mut headings = Vec::new();
    let mut sections = Vec::new();
    let mut list_items = Vec::new();

    let line_count = idx.line_count();
    let line = |l: usize| -> (usize, usize) { (idx.line_start(l), idx.line_end(text, l)) };

    let mut l = 0usize;
    // Frontmatter.
    if line_count > 1 && &text[line(0).0..line(0).1] == "---" {
        let mut close = None;
        for k in 1..line_count {
            let (s, e) = line(k);
            if &text[s..e] == "---" {
                close = Some(k);
                break;
            }
        }
        if let Some(c) = close {
            let body_start = line(1).0;
            let body_end = if c > 1 { line(c - 1).1 } else { body_start };
            let yaml = &text[body_start..body_end.max(body_start)];
            let fm = parse_simple_yaml(yaml);
            let mut fl = Vec::new();
            for (k, v) in &fm {
                collect_fm_links(k, v, &mut fl);
            }
            let pos = idx.pos(text, 0, line(c).1);
            meta.frontmatter = Some(fm);
            meta.frontmatter_position = Some(pos);
            if !fl.is_empty() {
                meta.frontmatter_links = Some(fl);
            }
            sections.push(SectionCache {
                id: None,
                kind: "yaml".into(),
                position: pos,
            });
            l = c + 1;
        }
    }

    #[derive(PartialEq)]
    enum Block {
        None,
        Para,
        List,
    }
    let mut block = Block::None;
    let mut block_start = 0usize;
    let mut block_end = 0usize;
    let mut list_stack: Vec<(usize, usize)> = Vec::new(); // (indent, line)
    let mut list_first_line = 0usize;

    let flush = |block: &mut Block, sections: &mut Vec<SectionCache>, start: usize, end: usize| {
        let kind = match block {
            Block::None => return,
            Block::Para => "paragraph",
            Block::List => "list",
        };
        sections.push(SectionCache {
            id: None,
            kind: kind.into(),
            position: idx.pos(text, start, end),
        });
        *block = Block::None;
    };

    while l < line_count {
        let (s, e) = line(l);
        let raw = &text[s..e];
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            flush(&mut block, &mut sections, block_start, block_end);
            let fence = &trimmed[..3];
            let mut k = l + 1;
            while k < line_count {
                let (ks, ke) = line(k);
                if text[ks..ke].trim_start().starts_with(fence) {
                    break;
                }
                k += 1;
            }
            let end_line = k.min(line_count - 1);
            sections.push(SectionCache {
                id: None,
                kind: "code".into(),
                position: idx.pos(text, s, line(end_line).1),
            });
            l = end_line + 1;
            continue;
        }
        if raw.trim().is_empty() {
            flush(&mut block, &mut sections, block_start, block_end);
            list_stack.clear();
            l += 1;
            continue;
        }
        let hashes = raw.bytes().take_while(|&b| b == b'#').count();
        if (1..=6).contains(&hashes) && (raw.len() == hashes || raw.as_bytes()[hashes] == b' ') {
            flush(&mut block, &mut sections, block_start, block_end);
            let heading = raw[hashes..].trim().to_string();
            let pos = idx.pos(text, s, e);
            headings.push(HeadingCache {
                heading,
                level: hashes as u8,
                position: pos,
            });
            sections.push(SectionCache {
                id: None,
                kind: "heading".into(),
                position: pos,
            });
            scan_inline(
                text,
                &idx,
                s + hashes,
                e,
                &mut links,
                &mut embeds,
                &mut tags,
            );
            list_stack.clear();
            l += 1;
            continue;
        }
        if let Some((marker_len, task)) = list_marker(trimmed) {
            if block != Block::List {
                flush(&mut block, &mut sections, block_start, block_end);
                block = Block::List;
                block_start = s;
                list_first_line = l;
                list_stack.clear();
            }
            let indent = raw.len() - trimmed.len();
            while let Some(&(ind, _)) = list_stack.last() {
                if ind >= indent {
                    list_stack.pop();
                } else {
                    break;
                }
            }
            let parent = match list_stack.last() {
                Some(&(_, pl)) => pl as i64,
                None => -(list_first_line as i64),
            };
            list_items.push(ListItemCache {
                id: None,
                task,
                parent,
                position: idx.pos(text, s + indent, e),
            });
            list_stack.push((indent, l));
            block_end = e;
            scan_inline(
                text,
                &idx,
                s + indent + marker_len,
                e,
                &mut links,
                &mut embeds,
                &mut tags,
            );
            l += 1;
            continue;
        }
        if block == Block::List {
            flush(&mut block, &mut sections, block_start, block_end);
        }
        if block == Block::None {
            block = Block::Para;
            block_start = s;
        }
        block_end = e;
        scan_inline(text, &idx, s, e, &mut links, &mut embeds, &mut tags);
        l += 1;
    }
    flush(&mut block, &mut sections, block_start, block_end);

    // Obsidian omits empty lists from the cache (and `section:` treats a
    // missing `headings` differently from an empty one).
    fn some<T>(v: Vec<T>) -> Option<Vec<T>> {
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    }
    meta.links = some(links);
    meta.embeds = some(embeds);
    meta.tags = some(tags);
    meta.headings = some(headings);
    meta.sections = some(sections);
    meta.list_items = some(list_items);
    meta
}

/// `- `, `* `, `+ `, `1. `, `1) ` plus an optional `[c] ` task box.
fn list_marker(t: &str) -> Option<(usize, Option<String>)> {
    let b = t.as_bytes();
    let mut n = if !b.is_empty() && matches!(b[0], b'-' | b'*' | b'+') {
        1
    } else {
        let d = b.iter().take_while(|c| c.is_ascii_digit()).count();
        if d == 0 || d >= b.len() || !matches!(b[d], b'.' | b')') {
            return None;
        }
        d + 1
    };
    if n >= b.len() || b[n] != b' ' {
        if n == b.len() {
            return Some((n, None));
        }
        return None;
    }
    n += 1;
    let rest = &t[n..];
    let mut chars = rest.char_indices();
    if let (Some((_, '[')), Some((_, c)), Some((i, ']'))) =
        (chars.next(), chars.next(), chars.next())
    {
        let after = &rest[i + 1..];
        if after.is_empty() || after.starts_with(' ') {
            return Some((n, Some(c.to_string())));
        }
    }
    Some((n, None))
}

fn scan_inline(
    text: &str,
    idx: &LineIndex,
    start: usize,
    end: usize,
    links: &mut Vec<LinkCache>,
    embeds: &mut Vec<LinkCache>,
    tags: &mut Vec<TagCache>,
) {
    let s = &text[start..end];
    let b = s.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        match b[i] {
            b'`' => {
                let run = b[i..].iter().take_while(|&&c| c == b'`').count();
                let fence = &s[i..i + run];
                match s[i + run..].find(fence) {
                    Some(j) => i += run + j + run,
                    None => i += run,
                }
            }
            b'!' | b'[' => {
                let embed = b[i] == b'!';
                let o = if embed { i + 1 } else { i };
                if s[o..].starts_with("[[") {
                    if let Some(close) = s[o + 2..].find("]]") {
                        let inner = &s[o + 2..o + 2 + close];
                        let full_end = o + 2 + close + 2;
                        if !inner.contains('\n') {
                            let (target, alias) = match inner.find('|') {
                                Some(p) => (&inner[..p], Some(inner[p + 1..].trim().to_string())),
                                None => (inner, None),
                            };
                            let link = target.trim().trim_end_matches('\\').to_string();
                            let display = alias.or_else(|| Some(display_of(&link)));
                            let c = LinkCache {
                                link,
                                original: s[i..full_end].to_string(),
                                display_text: display,
                                position: idx.pos(text, start + i, start + full_end),
                            };
                            if embed {
                                embeds.push(c)
                            } else {
                                links.push(c)
                            }
                            i = full_end;
                            continue;
                        }
                    }
                } else if s[o..].starts_with('[') {
                    if let Some(close) = s[o + 1..].find("](") {
                        let label_end = o + 1 + close;
                        if let Some(paren) = s[label_end + 2..].find(')') {
                            let url_raw = s[label_end + 2..label_end + 2 + paren].trim();
                            let full_end = label_end + 2 + paren + 1;
                            let mut url =
                                url_raw.split(" \"").next().unwrap_or("").trim().to_string();
                            if url.starts_with('<') && url.ends_with('>') {
                                url = url[1..url.len() - 1].to_string();
                            }
                            if !url.is_empty()
                                && !url.contains("://")
                                && !url.starts_with("mailto:")
                            {
                                let c = LinkCache {
                                    link: percent_decode(&url),
                                    original: s[i..full_end].to_string(),
                                    display_text: Some(s[o + 1..label_end].to_string()),
                                    position: idx.pos(text, start + i, start + full_end),
                                };
                                if embed {
                                    embeds.push(c)
                                } else {
                                    links.push(c)
                                }
                            }
                            i = full_end;
                            continue;
                        }
                    }
                }
                i += 1;
            }
            b'#' if i == 0 || s[..i].ends_with(|c: char| c.is_whitespace()) => {
                let body: usize = s[i + 1..]
                    .char_indices()
                    .find(|(_, c)| {
                        c.is_whitespace()
                            || ('\u{2000}'..='\u{206F}').contains(c)
                            || ('\u{2E00}'..='\u{2E7F}').contains(c)
                            || "'!\"#$%&()*+,.:;<=>?@^`{|}~[]\\".contains(*c)
                    })
                    .map(|(k, _)| k)
                    .unwrap_or(s.len() - i - 1);
                let tag = &s[i..i + 1 + body];
                if body > 0 && !tag[1..].chars().all(|c| c.is_ascii_digit()) {
                    tags.push(TagCache {
                        tag: tag.to_string(),
                        position: idx.pos(text, start + i, start + i + 1 + body),
                    });
                }
                i += 1 + body;
            }
            _ => i += s[i..].chars().next().map_or(1, |c| c.len_utf8()),
        }
    }
}

fn display_of(link: &str) -> String {
    link.split('#')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" > ")
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && b[i + 1].is_ascii_hexdigit()
            && b[i + 2].is_ascii_hexdigit()
        {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn collect_fm_links(key: &str, v: &Value, out: &mut Vec<FrontmatterLinkCache>) {
    match v {
        Value::String(s) if s.starts_with("[[") && s.ends_with("]]") => {
            let inner = &s[2..s.len() - 2];
            let (target, alias) = match inner.find('|') {
                Some(p) => (inner[..p].trim(), Some(inner[p + 1..].trim().to_string())),
                None => (inner.trim(), None),
            };
            out.push(FrontmatterLinkCache {
                key: key.to_string(),
                link: target.to_string(),
                original: s.clone(),
                display_text: Some(alias.unwrap_or_else(|| display_of(target))),
            });
        }
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                collect_fm_links(&format!("{key}.{i}"), x, out);
            }
        }
        Value::Object(o) => {
            for (k, x) in o {
                collect_fm_links(&format!("{key}.{k}"), x, out);
            }
        }
        _ => {}
    }
}

/// Top-level `key: value` pairs, flow lists `[a, b]`, and block lists.
pub fn parse_simple_yaml(yaml: &str) -> Map<String, Value> {
    let mut map = Map::new();
    let lines: Vec<&str> = yaml.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if line.starts_with(' ')
            || line.starts_with('-')
            || line.trim().is_empty()
            || line.trim_start().starts_with('#')
        {
            continue;
        }
        let Some(colon) = line.find(':') else {
            continue;
        };
        let key = line[..colon].trim().trim_matches('"').to_string();
        let rest = line[colon + 1..].trim();
        if rest.is_empty() {
            let mut items = Vec::new();
            while i < lines.len() && lines[i].trim_start().starts_with("- ")
                || (i < lines.len() && lines[i].trim() == "-")
            {
                let item = lines[i].trim_start()[1..].trim();
                items.push(scalar(item));
                i += 1;
            }
            map.insert(
                key,
                if items.is_empty() {
                    Value::Null
                } else {
                    Value::Array(items)
                },
            );
        } else if rest.starts_with('[') && rest.ends_with(']') && !rest.starts_with("[[") {
            let inner = &rest[1..rest.len() - 1];
            let items = if inner.trim().is_empty() {
                Vec::new()
            } else {
                inner.split(',').map(|x| scalar(x.trim())).collect()
            };
            map.insert(key, Value::Array(items));
        } else {
            map.insert(key, scalar(rest));
        }
    }
    map
}

fn scalar(s: &str) -> Value {
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        return Value::String(s[1..s.len() - 1].to_string());
    }
    match s {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        "null" | "~" | "" => return Value::Null,
        _ => {}
    }
    if let Ok(n) = s.parse::<i64>() {
        return Value::Number(n.into());
    }
    if let Ok(f) = s.parse::<f64>() {
        if let Some(n) = Number::from_f64(f) {
            return Value::Number(n);
        }
    }
    Value::String(s.to_string())
}

/// A `Pos` from UTF-16 offsets on a single-line text (test convenience).
pub fn pos_u16(text: &str, start: usize, end: usize) -> Pos {
    let idx = LineIndex::new(text);
    idx.pos(text, start, end)
}
