//! CSV files: one note per row.
//!
//! Mirrors obsidian-importer's CSV importer with its default template: the
//! note is named by the title column (the first column unless chosen), and
//! every column becomes a property — typed as a number or boolean where the
//! text is one, null where the cell is empty, a `|-` block where it has
//! newlines, and a list for a `tags` column. Property names are the headers
//! with characters other than letters, digits, `_`, `-` and spaces removed
//! (`sanitizeYAMLKey`). A body column, when chosen, becomes the note text
//! instead of a property.
//!
//! The parser is RFC 4180 (quoted fields, doubled quotes, newlines inside
//! quotes, CRLF, a leading byte-order mark) rather than the importer's
//! line splitter, and it detects `;` and tab delimiters, which spreadsheet
//! exports in many locales use.

use super::util::{sanitize_file_name, UniquePaths};
use super::yaml::{frontmatter, typed, Yaml};
use super::{ImportResult, ImportedFile};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CsvOptions {
    /// When false, columns are named `Column 1`, `Column 2`, ….
    pub has_header_row: bool,
    /// Header of the column that names each note; default the first.
    pub title_column: Option<String>,
    /// Header of a column to use as the note body instead of a property.
    pub body_column: Option<String>,
    /// Headers (case-insensitive) whose cells are lists split on commas and
    /// whitespace. Default `["tags"]`.
    pub list_columns: Vec<String>,
    /// Folder for the notes, relative to the import root.
    pub folder: String,
    /// `,`, `;` or `\t`; `None` detects it from the first line.
    pub delimiter: Option<char>,
}

impl Default for CsvOptions {
    fn default() -> Self {
        CsvOptions {
            has_header_row: true,
            title_column: None,
            body_column: None,
            list_columns: vec!["tags".into()],
            folder: String::new(),
            delimiter: None,
        }
    }
}

/// Parse CSV text into rows of fields (RFC 4180). Blank lines are skipped.
pub fn parse(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    let end_row = |row: &mut Vec<String>, field: &mut String, quoted: &mut bool, rows: &mut Vec<Vec<String>>| {
        row.push(std::mem::take(field));
        let blank = row.len() == 1 && row[0].is_empty() && !*quoted;
        if !blank {
            rows.push(std::mem::take(row));
        } else {
            row.clear();
        }
        *quoted = false;
    };
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.trim().is_empty() && !quoted => {
                field.clear();
                in_quotes = true;
                quoted = true;
            }
            c if c == delimiter => {
                row.push(std::mem::take(&mut field));
                quoted = false;
            }
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                end_row(&mut row, &mut field, &mut quoted, &mut rows);
            }
            '\n' => end_row(&mut row, &mut field, &mut quoted, &mut rows),
            c => {
                // Text after a closing quote is kept, as spreadsheets do.
                field.push(c);
            }
        }
    }
    if !field.is_empty() || !row.is_empty() || quoted {
        end_row(&mut row, &mut field, &mut quoted, &mut rows);
    }
    rows
}

/// The delimiter that splits the first line into the most fields.
pub fn detect_delimiter(text: &str) -> char {
    let mut best = (',', 0);
    for d in [',', ';', '\t', '|'] {
        let first = parse(text.split('\n').next().unwrap_or(""), d);
        let n = first.first().map(|r| r.len()).unwrap_or(0);
        if n > best.1 {
            best = (d, n);
        }
    }
    best.0
}

/// `sanitizeYAMLKey`: keep word characters, whitespace and `-`.
pub fn sanitize_key(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_alphanumeric() || *c == '_' || c.is_whitespace() || *c == '-')
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn convert(csv: &str, opts: &CsvOptions) -> ImportResult {
    let mut result = ImportResult::default();
    let delimiter = opts.delimiter.unwrap_or_else(|| detect_delimiter(csv));
    let rows: Vec<Vec<String>> = parse(csv, delimiter)
        .into_iter()
        .map(|r| r.into_iter().map(|v| v.trim().to_string()).collect())
        .collect();
    if rows.is_empty() {
        result.warnings.push("The CSV file has no rows".into());
        return result;
    }
    let (headers, data): (Vec<String>, &[Vec<String>]) = if opts.has_header_row {
        let mut seen: Vec<String> = Vec::new();
        let headers = rows[0]
            .iter()
            .enumerate()
            .map(|(i, h)| {
                let base = if h.is_empty() { format!("Column {}", i + 1) } else { h.clone() };
                let mut name = base.clone();
                let mut n = 2;
                while seen.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                    name = format!("{base} {n}");
                    n += 1;
                }
                seen.push(name.clone());
                name
            })
            .collect();
        (headers, &rows[1..])
    } else {
        let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        ((1..=width).map(|i| format!("Column {i}")).collect(), &rows[..])
    };
    if data.is_empty() {
        result.warnings.push("The CSV file has a header but no data rows".into());
        return result;
    }
    let find = |name: &Option<String>| -> Option<usize> {
        name.as_ref()
            .and_then(|n| headers.iter().position(|h| h.eq_ignore_ascii_case(n.trim())))
    };
    let title_col = find(&opts.title_column).unwrap_or(0);
    if opts.title_column.is_some() && find(&opts.title_column).is_none() {
        result.warnings.push(format!(
            "No column named {:?}; using {:?} for titles",
            opts.title_column.as_deref().unwrap_or(""),
            headers[0]
        ));
    }
    let body_col = find(&opts.body_column);
    let folder = super::util::sanitize_file_path(&opts.folder);
    let mut paths = UniquePaths::new();

    for (i, row) in data.iter().enumerate() {
        let cell = |c: usize| row.get(c).map(|s| s.as_str()).unwrap_or("");
        let title = cell(title_col);
        if title.trim().is_empty() {
            result.warnings.push(format!("Row {}: skipped, the title is empty", i + 1));
            continue;
        }
        let mut props: Vec<(String, Yaml)> = Vec::new();
        for (c, header) in headers.iter().enumerate() {
            if Some(c) == body_col {
                continue;
            }
            let key = sanitize_key(header);
            if key.is_empty() {
                continue;
            }
            let value = cell(c);
            let is_list = opts.list_columns.iter().any(|l| l.eq_ignore_ascii_case(&key));
            let yaml = if is_list {
                if value.is_empty() {
                    Yaml::Null
                } else {
                    Yaml::list(
                        value
                            .split(|ch: char| ch == ',' || ch.is_whitespace())
                            .map(|t| t.trim().trim_start_matches('#'))
                            .filter(|t| !t.is_empty())
                            .map(String::from),
                    )
                }
            } else {
                typed(value)
            };
            props.push((key, yaml));
        }
        // `convertRow`: frontmatter, a blank line, then the body.
        let mut text = frontmatter(&props);
        if !text.is_empty() {
            text.push('\n');
        }
        if let Some(b) = body_col {
            let body = cell(b);
            if !body.is_empty() {
                text.push_str(body);
                text.push('\n');
            }
        }
        let path = paths.claim(&folder, &format!("{}.md", sanitize_file_name(title)));
        result.files.push(ImportedFile::note(path, text));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4180_quotes_newlines_and_bom() {
        let rows = parse("\u{feff}a,\"b \"\"q\"\"\",c\r\n\"multi\nline\",,\"x,y\"\n\n", ',');
        assert_eq!(
            rows,
            vec![
                vec!["a".to_string(), "b \"q\"".into(), "c".into()],
                vec!["multi\nline".into(), "".into(), "x,y".into()],
            ]
        );
        assert_eq!(parse("\"\"\n", ','), vec![vec![String::new()]]);
        assert_eq!(parse("a,b", ','), vec![vec!["a".to_string(), "b".into()]]);
    }

    #[test]
    fn detects_semicolons_and_tabs() {
        assert_eq!(detect_delimiter("a;b;c\n1;2;3"), ';');
        assert_eq!(detect_delimiter("a\tb\n"), '\t');
        assert_eq!(detect_delimiter("\"x;y\",b,c\n"), ',');
    }

    #[test]
    fn sample_matches_importer_output() {
        let csv = "Title,Category,Tags,Content,Date,Priority,Completed\nMy First Note,Work,project planning,This is the content of my first note.,2024-01-15,,true\n\"Note with, comma\",Work,urgent,Content with special characters.,2024-01-17,Low,true\nPlanning Document,Work,planning strategy,\"Multi-line\ncontent goes\nhere.\",2024-01-18,High,false\n";
        let r = convert(csv, &CsvOptions::default());
        assert_eq!(
            r.text("My First Note.md"),
            "---\nTitle: My First Note\nCategory: Work\nTags:\n  - project\n  - planning\nContent: This is the content of my first note.\nDate: 2024-01-15\nPriority:\nCompleted: true\n---\n\n"
        );
        assert!(r.text("Note with, comma.md").contains("Title: Note with, comma\n"));
        assert!(r.text("Planning Document.md").contains("Content: |-\n  Multi-line\n  content goes\n  here.\n"));
    }

    #[test]
    fn numbers_quotes_unicode_and_special_characters() {
        let csv = "Title,Rating,Notes\n\"Note with \"\"quotes\"\"\",8.5,\"Content with unicode: 你好世界 🌟 café\"\nSpecial,007,\"a: b\"\n";
        let r = convert(csv, &CsvOptions::default());
        let q = r.text("Note with quotes.md");
        assert!(q.contains("Title: Note with \"quotes\"\n"), "{q}");
        assert!(q.contains("Rating: 8.5\n"));
        assert!(q.contains("Notes: \"Content with unicode: 你好世界 🌟 café\"\n"), "{q}");
        let s = r.text("Special.md");
        assert!(s.contains("Rating: \"007\"\n") && s.contains("Notes: \"a: b\"\n"), "{s}");
    }

    #[test]
    fn title_and_body_columns_duplicates_and_empty_titles() {
        let csv = "id,Name,Body\n1,Same,first body\n2,Same,second\n3,,orphan\n";
        let r = convert(
            csv,
            &CsvOptions {
                title_column: Some("name".into()),
                body_column: Some("Body".into()),
                folder: "Import/Rows".into(),
                ..CsvOptions::default()
            },
        );
        assert_eq!(r.paths(), vec!["Import/Rows/Same.md", "Import/Rows/Same 1.md"]);
        assert_eq!(r.text("Import/Rows/Same.md"), "---\nid: 1\nName: Same\n---\n\nfirst body\n");
        assert_eq!(r.warnings, vec!["Row 3: skipped, the title is empty".to_string()]);
    }

    #[test]
    fn headerless_and_short_rows() {
        let r = convert("alpha,1\nbeta\n", &CsvOptions { has_header_row: false, ..CsvOptions::default() });
        assert_eq!(r.text("alpha.md"), "---\nColumn 1: alpha\nColumn 2: 1\n---\n\n");
        assert_eq!(r.text("beta.md"), "---\nColumn 1: beta\nColumn 2:\n---\n\n");
    }

    #[test]
    fn keys_are_sanitised() {
        let r = convert("Title,Price ($),Tags\nA,$1,#x y\n", &CsvOptions::default());
        assert_eq!(r.text("A.md"), "---\nTitle: A\nPrice: $1\nTags:\n  - x\n  - y\n---\n\n");
    }
}
