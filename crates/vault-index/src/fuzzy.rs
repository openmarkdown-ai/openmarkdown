//! `prepareFuzzySearch`, `prepareSimpleSearch`, `prepareQuery` and the
//! quick switcher's ranking, reproduced from Obsidian 1.13.
//!
//! **Fuzzy.** The query is lower-cased and split into tokens at whitespace,
//! with every punctuation character (ASCII punctuation and the General /
//! Supplemental Punctuation blocks) and every CJK character becoming a token
//! of its own. The tokens are found in order in the lower-cased text, each
//! from where the previous one ended. A token that starts mid-word (a
//! lower-case letter after a letter or digit, or an upper-case letter after
//! an upper-case letter) costs a penalty. If the tokens are not all found,
//! the query's non-space characters are matched one by one instead (the
//! app's mid-word retry in this mode always ends up accepting the first
//! occurrence, so it is a plain in-order character match). Adjacent matches
//! merge into one range.
//!
//! **Score** (always ≤ 0, closer to 0 is better):
//! `-(ranges − 1) − penalty/10 − (span + 1 − query length)/100 − first/1000 − text length/10000`
//! where `span` is last end − first start. So fewer, tighter, earlier
//! matches in shorter texts win.
//!
//! **Simple.** Space-separated words, each of which must occur
//! (case-insensitively); all occurrences are highlighted; scored with the
//! same formula and no penalty.
//!
//! All offsets are UTF-16 code units.

use serde::{Deserialize, Serialize};
use vault_types::SearchResult;

/// `prepareQuery(query)`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PreparedQuery {
    pub query: String,
    pub tokens: Vec<String>,
    pub fuzzy: Vec<String>,
}

fn is_punct(u: u16) -> bool {
    matches!(u, 0x2000..=0x206F | 0x2E00..=0x2E7F)
        || (u < 0x80 && b"\\'!\"#$%&()*+,-./:;<=>?@[]^_`{|}~".contains(&(u as u8)))
}

fn is_js_space(u: u16) -> bool {
    matches!(u, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

fn is_cjk(u: u16) -> bool {
    matches!(u, 0x0F00..=0x0FFF | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF66..=0xFF9F)
}

/// Lower-cases UTF-16 code units one at a time (keeping units whose
/// lower-case form is not a single unit), so indices stay aligned.
fn lower_units(units: &[u16]) -> Vec<u16> {
    units
        .iter()
        .map(|&u| match char::from_u32(u as u32) {
            Some(c) => {
                let mut l = c.to_lowercase();
                match (l.next(), l.next()) {
                    (Some(x), None) if x.len_utf16() == 1 => x as u16,
                    _ => u,
                }
            }
            None => u,
        })
        .collect()
}

fn has_lower_form(u: u16) -> bool {
    char::from_u32(u as u32).is_some_and(|c| c.to_lowercase().ne(std::iter::once(c)))
}

fn has_upper_form(u: u16) -> bool {
    char::from_u32(u as u32).is_some_and(|c| c.to_uppercase().ne(std::iter::once(c)))
}

pub fn prepare_query(query: &str) -> PreparedQuery {
    let lower: Vec<u16> = lower_units(&query.encode_utf16().collect::<Vec<_>>());
    let mut tokens = Vec::new();
    let mut start = 0usize;
    for (i, &u) in lower.iter().enumerate() {
        if is_js_space(u) {
            if start != i {
                tokens.push(String::from_utf16_lossy(&lower[start..i]));
            }
            start = i + 1;
        } else if is_punct(u) || is_cjk(u) {
            if start != i {
                tokens.push(String::from_utf16_lossy(&lower[start..i]));
            }
            tokens.push(String::from_utf16_lossy(&lower[i..i + 1]));
            start = i + 1;
        }
    }
    if start != lower.len() {
        tokens.push(String::from_utf16_lossy(&lower[start..]));
    }
    let fuzzy = lower
        .iter()
        .filter(|&&u| u != 0x20)
        .map(|&u| String::from_utf16_lossy(&[u]))
        .collect();
    PreparedQuery {
        query: query.to_string(),
        tokens,
        fuzzy,
    }
}

fn index_of(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(hay.len()));
    }
    if needle.len() > hay.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

/// The shared score formula (`Jy`).
pub fn score(matches: &[[u32; 2]], query_len: usize, text_len: usize, penalty: u32) -> f64 {
    if matches.is_empty() {
        return 0.0;
    }
    let mut r = -((matches.len() as f64 - 1.0).max(0.0));
    r -= penalty as f64 / 10.0;
    let first = matches[0][0] as f64;
    let last_end = matches[matches.len() - 1][1] as f64;
    r -= (last_end - first + 1.0 - query_len as f64) / 100.0;
    r -= first / 1000.0;
    r -= text_len as f64 / 10000.0;
    r
}

fn match_tokens(
    tokens: &[Vec<u16>],
    query_len: usize,
    text: &[u16],
    char_mode: bool,
) -> Option<SearchResult> {
    if tokens.is_empty() {
        return None;
    }
    let lower = lower_units(text);
    let mut penalty = 0u32;
    let mut from = 0usize;
    let mut matches: Vec<[u32; 2]> = Vec::new();
    for tok in tokens {
        let u = index_of(&lower, tok, from)?;
        let h = text[u];
        if u > 0 && !char_mode && !is_punct(h) && !is_cjk(h) {
            let p = text[u - 1];
            let mid_word = (has_lower_form(h) && has_lower_form(p))
                || (has_upper_form(h) && !is_punct(p) && !is_js_space(p) && !is_cjk(p));
            if mid_word {
                penalty += 1;
            }
        }
        let end = (u + tok.len()) as u32;
        match matches.last_mut() {
            Some(last) if last[1] >= u as u32 => last[1] = end,
            _ => matches.push([u as u32, end]),
        }
        from = u + tok.len();
    }
    let s = score(&matches, query_len, lower.len(), penalty);
    Some(SearchResult { score: s, matches })
}

/// A `prepareFuzzySearch(query)` callback.
pub struct FuzzySearch {
    prepared: PreparedQuery,
    tokens: Vec<Vec<u16>>,
    chars: Vec<Vec<u16>>,
    query_len: usize,
}

impl FuzzySearch {
    pub fn new(query: &str) -> Self {
        let prepared = prepare_query(query);
        let tokens = prepared
            .tokens
            .iter()
            .map(|t| t.encode_utf16().collect())
            .collect();
        let chars = prepared
            .fuzzy
            .iter()
            .map(|t| t.encode_utf16().collect())
            .collect();
        FuzzySearch {
            query_len: query.encode_utf16().count(),
            prepared,
            tokens,
            chars,
        }
    }

    pub fn prepared(&self) -> &PreparedQuery {
        &self.prepared
    }

    pub fn run(&self, text: &str) -> Option<SearchResult> {
        if self.prepared.query.is_empty() {
            return Some(SearchResult {
                score: 0.0,
                matches: Vec::new(),
            });
        }
        let units: Vec<u16> = text.encode_utf16().collect();
        match_tokens(&self.tokens, self.query_len, &units, false)
            .or_else(|| match_tokens(&self.chars, self.query_len, &units, true))
    }
}

/// `prepareFuzzySearch(query)(text)`.
pub fn fuzzy(query: &str, text: &str) -> Option<SearchResult> {
    FuzzySearch::new(query).run(text)
}

/// A `prepareSimpleSearch(query)` callback.
pub struct SimpleSearch {
    words: Vec<Vec<u16>>,
    query_len: usize,
}

impl SimpleSearch {
    pub fn new(query: &str) -> Self {
        let lower = lower_units(&query.encode_utf16().collect::<Vec<_>>());
        let words = lower.split(|&u| u == 0x20).map(|w| w.to_vec()).collect();
        SimpleSearch {
            words,
            query_len: query.encode_utf16().count(),
        }
    }

    pub fn run(&self, text: &str) -> Option<SearchResult> {
        let units: Vec<u16> = text.encode_utf16().collect();
        let lower = lower_units(&units);
        let mut ranges: Vec<[u32; 2]> = Vec::new();
        for w in self.words.iter().filter(|w| !w.is_empty()) {
            let mut found = false;
            let mut from = 0usize;
            while let Some(i) = index_of(&lower, w, from) {
                found = true;
                ranges.push([i as u32, (i + w.len()) as u32]);
                // The app resumes one past the end, skipping a character.
                from = i + w.len() + 1;
                if from > lower.len() {
                    break;
                }
            }
            if !found {
                return None;
            }
        }
        let ranges = crate::util::merge_ranges(ranges);
        let s = score(&ranges, self.query_len, units.len(), 0);
        Some(SearchResult {
            score: s,
            matches: ranges,
        })
    }
}

/// `prepareSimpleSearch(query)(text)`.
pub fn simple(query: &str, text: &str) -> Option<SearchResult> {
    SimpleSearch::new(query).run(text)
}

/// `sortSearchResults`: best score first, stable.
pub fn sort_results<T>(items: &mut [(T, SearchResult)]) {
    items.sort_by(|a, b| {
        b.1.score
            .partial_cmp(&a.1.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
}

/// Quick-switcher ranking over paths (as the switcher shows them, e.g.
/// without `.md`). Each item is matched on its last segment first — ranges
/// shifted to full-path offsets — and only if that fails on the whole path,
/// one point worse. Fuzzy matching is used below 10 000 items, simple
/// matching above, as in the app. Returns `(item index, result)` best first,
/// ties in input order, at most `limit` (0 = all).
pub fn rank(query: &str, items: &[String], limit: usize) -> Vec<(usize, SearchResult)> {
    let use_fuzzy = items.len() < 10_000;
    let fz = FuzzySearch::new(query);
    let sm = SimpleSearch::new(query);
    let run = |t: &str| if use_fuzzy { fz.run(t) } else { sm.run(t) };
    let mut out: Vec<(usize, SearchResult)> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let name = crate::util::basename(item);
        if let Some(mut r) = run(name) {
            let shift = (item.encode_utf16().count() - name.encode_utf16().count()) as u32;
            for m in &mut r.matches {
                m[0] += shift;
                m[1] += shift;
            }
            out.push((i, r));
        } else if let Some(mut r) = run(item) {
            r.score -= 1.0;
            out.push((i, r));
        }
    }
    sort_results(&mut out);
    if limit > 0 {
        out.truncate(limit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn prepare_query_splits_punctuation_and_cjk() {
        let p = prepare_query("Foo-bar 日本 x");
        assert_eq!(p.tokens, vec!["foo", "-", "bar", "日", "本", "x"]);
        assert_eq!(p.fuzzy.join(""), "foo-bar日本x");
    }

    #[test]
    fn token_match_scores_like_the_app() {
        let r = fuzzy("note", "My Note").unwrap();
        assert_eq!(r.matches, vec![[3, 7]]);
        // -(1-1) - 0 - (7-3+1-4)/100 - 3/1000 - 7/10000
        assert!(approx(r.score, -0.01 - 0.003 - 0.0007), "{}", r.score);
    }

    #[test]
    fn mid_word_token_is_penalised() {
        let start = fuzzy("book", "Book club").unwrap();
        let mid = fuzzy("book", "Ebook club").unwrap();
        assert!(start.score > mid.score);
        assert!(
            approx(
                mid.score - (-0.1 - (4.0 + 1.0 - 4.0) / 100.0 - 1.0 / 1000.0 - 10.0 / 10000.0),
                0.0
            ),
            "{}",
            mid.score
        );
    }

    #[test]
    fn falls_back_to_characters() {
        let r = fuzzy("qsw", "Quick Switcher").unwrap();
        assert_eq!(r.matches, vec![[0, 1], [6, 8]]);
        assert!(r.score < -1.0);
        assert!(fuzzy("zzz", "Quick").is_none());
    }

    #[test]
    fn empty_query_matches_with_zero() {
        assert_eq!(
            fuzzy("", "anything"),
            Some(SearchResult {
                score: 0.0,
                matches: vec![]
            })
        );
        assert_eq!(fuzzy("  ", "anything"), None);
    }

    #[test]
    fn utf16_ranges_with_emoji() {
        let r = fuzzy("cat", "😀 cat").unwrap();
        assert_eq!(r.matches, vec![[3, 6]]);
        let s = simple("cat", "😀cat😀cat").unwrap();
        assert_eq!(s.matches, vec![[2, 5], [7, 10]]);
    }

    #[test]
    fn simple_requires_every_word() {
        let r = simple("foo bar", "bar and FOO").unwrap();
        assert_eq!(r.matches, vec![[0, 3], [8, 11]]);
        assert!(simple("foo baz", "bar and foo").is_none());
        // Resuming one past each match skips an adjacent repeat.
        assert_eq!(simple("aa", "aaaa").unwrap().matches, vec![[0, 2]]);
    }

    #[test]
    fn rank_prefers_basename_and_is_stable() {
        let items: Vec<String> = [
            "notes/meeting/Agenda",
            "Meeting notes",
            "archive/Meeting",
            "zzz",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let r = rank("meeting", &items, 0);
        let order: Vec<usize> = r.iter().map(|(i, _)| *i).collect();
        assert_eq!(order, vec![2, 1, 0]);
        // Basename match ranges are shifted into the full path.
        assert_eq!(r[0].1.matches, vec![[8, 15]]);
        // Path-only match is one point worse.
        assert!(r[2].1.score < -1.0);
        assert_eq!(rank("meeting", &items, 1).len(), 1);
    }
}
