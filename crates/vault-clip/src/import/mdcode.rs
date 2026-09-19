//! Rewriting Markdown without touching its code.
//!
//! Every syntax conversion an importer makes (`^^x^^` to `==x==`, a tag, a
//! block reference) is wrong inside a code example. These are the importer's
//! `markdown.ts` helpers: split text into prose and code — fenced blocks
//! (backtick or tilde, including fences opened on a list item) and inline code
//! spans — and rewrite only the prose.

/// Marks lines that belong to a fenced code block, delimiters included.
pub fn fence_lines(text: &str) -> Vec<bool> {
    let lines: Vec<&str> = text.split('\n').collect();
    if !text.contains('`') && !text.contains('~') {
        return vec![false; lines.len()];
    }
    let mut out = Vec::with_capacity(lines.len());
    let mut fence: Option<(char, usize)> = None;
    for line in lines {
        if let Some((marker, len)) = fence {
            out.push(true);
            if let Some((m, l)) = close_fence(line) {
                if m == marker && l >= len {
                    fence = None;
                }
            }
            continue;
        }
        match open_fence(line) {
            Some((marker, len, after)) => {
                out.push(true);
                let run: String = std::iter::repeat_n(marker, len).collect();
                if !after.contains(&run) {
                    fence = Some((marker, len));
                }
            }
            None => out.push(false),
        }
    }
    out
}

/// `^[ \t]*(?:[-*+]\s+)?([`~]{3,})` → (marker, run length, rest of line).
pub fn open_fence(line: &str) -> Option<(char, usize, &str)> {
    let t = line.trim_start_matches([' ', '\t']);
    let t = match t.chars().next() {
        Some('-' | '*' | '+') => {
            let after = &t[1..];
            let trimmed = after.trim_start();
            if trimmed.len() == after.len() {
                return None;
            }
            trimmed
        }
        _ => t,
    };
    let marker = t.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let len = t.chars().take_while(|c| *c == marker).count();
    if len < 3 {
        return None;
    }
    Some((marker, len, &t[len..]))
}

/// A closing fence line, optionally with a list marker and a `^anchor` after.
fn close_fence(line: &str) -> Option<(char, usize)> {
    let (marker, len, after) = open_fence(line)?;
    let after = after.trim();
    if after.is_empty() {
        return Some((marker, len));
    }
    let anchor = after.strip_prefix('^')?;
    if !anchor.is_empty()
        && anchor
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Some((marker, len))
    } else {
        None
    }
}

/// Rewrite runs of whole non-fenced lines. A run's trailing newline belongs to
/// it, so a rewrite that removes its last line can remove the newline too.
pub fn outside_fences(text: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let fenced = fence_lines(text);
    let mut out = String::with_capacity(text.len());
    let mut start = 0;
    while start < lines.len() {
        let is_fenced = fenced[start];
        let mut end = start + 1;
        while end < lines.len() && fenced[end] == is_fenced {
            end += 1;
        }
        let mut segment = lines[start..end].join("\n");
        if end < lines.len() {
            segment.push('\n');
        }
        if is_fenced {
            out.push_str(&segment);
        } else {
            out.push_str(&rewrite(&segment));
        }
        start = end;
    }
    out
}

/// Split on inline code spans (`` `+[^`]*`+ ``), rewriting the prose between.
pub fn outside_code_spans(text: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    for (is_code, piece) in split_code_spans(text) {
        if is_code {
            out.push_str(piece);
        } else {
            out.push_str(&rewrite(piece));
        }
    }
    out
}

fn split_code_spans(text: &str) -> Vec<(bool, &str)> {
    let mut out = Vec::new();
    let b = text.as_bytes();
    let mut i = 0;
    let mut prose_start = 0;
    while i < b.len() {
        if b[i] != b'`' {
            i += 1;
            continue;
        }
        let open_start = i;
        while i < b.len() && b[i] == b'`' {
            i += 1;
        }
        let run = i - open_start;
        // The span closes at the next backtick run of the same length. It
        // may cross a line ending but not a blank line (the paragraph ends),
        // so a stray backtick cannot swallow the rest of the note.
        let mut j = i;
        let mut close = None;
        while j < b.len() {
            if b[j] == b'\n' {
                let next = text[j + 1..].trim_start_matches([' ', '\t']);
                if next.starts_with('\n') || next.is_empty() {
                    break;
                }
                j += 1;
                continue;
            }
            if b[j] == b'`' {
                let k = j;
                while j < b.len() && b[j] == b'`' {
                    j += 1;
                }
                if j - k == run {
                    close = Some(j);
                    break;
                }
                continue;
            }
            j += 1;
        }
        let Some(j) = close else {
            // An unmatched run is literal text; keep scanning after it.
            continue;
        };
        if open_start > prose_start {
            out.push((false, &text[prose_start..open_start]));
        }
        out.push((true, &text[open_start..j]));
        prose_start = j;
        i = j;
    }
    if prose_start < text.len() {
        out.push((false, &text[prose_start..]));
    }
    out
}

/// Rewrite prose only: fenced blocks and inline code spans pass through.
pub fn outside_code(text: &str, mut rewrite: impl FnMut(&str) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let fenced = fence_lines(text);
    let lines: Vec<&str> = text.split('\n').collect();
    let mut start = 0;
    while start < lines.len() {
        let is_fenced = fenced[start];
        let mut end = start + 1;
        while end < lines.len() && fenced[end] == is_fenced {
            end += 1;
        }
        let mut segment = lines[start..end].join("\n");
        if end < lines.len() {
            segment.push('\n');
        }
        if is_fenced {
            out.push_str(&segment);
        } else {
            out.push_str(&outside_code_spans(&segment, &mut rewrite));
        }
        start = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fences_and_spans_are_protected() {
        let text = "a ^^x^^ `^^y^^`\n```js\n^^z^^\n```\n- ~~~\n  ^^w^^\n  ~~~\nb ^^v^^";
        let out = outside_code(text, |s| s.replace("^^", "=="));
        assert_eq!(out, "a ==x== `^^y^^`\n```js\n^^z^^\n```\n- ~~~\n  ^^w^^\n  ~~~\nb ==v==");
    }

    // Regression from obsidian-importer's tests/markdown/code.md: a stray
    // backtick after a fence paired with a code span two paragraphs later.
    #[test]
    fn code_spans_stop_at_blank_lines_and_need_equal_runs() {
        let out = outside_code_spans("stray ` here #a\n\nlater `#b` and ``x ` y`` #c\n`multi\n#d`", |s| s.replace('#', "@"));
        assert_eq!(out, "stray ` here @a\n\nlater `#b` and ``x ` y`` @c\n`multi\n#d`");
    }

    #[test]
    fn unclosed_fence_protects_to_end_and_inline_fence_does_not_open() {
        assert_eq!(fence_lines("```\na\nb"), vec![true, true, true]);
        assert_eq!(fence_lines("```x```\nb"), vec![true, false]);
        assert_eq!(fence_lines("``not``\nb"), vec![false, false]);
    }

    #[test]
    fn outside_fences_gives_whole_lines() {
        let out = outside_fences("x\n```\ncode\n```\ny", |s| s.to_uppercase());
        assert_eq!(out, "X\n```\ncode\n```\nY");
    }
}
