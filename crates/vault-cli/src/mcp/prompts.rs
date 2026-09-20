//! MCP prompts: a few ready-made jobs that name the tools to use, so a
//! person can pick one from their client's prompt menu instead of writing
//! the instructions out.
//!
//! They are static templates — no vault is read to list them, and filling one
//! in costs one string substitution.

use serde_json::{json, Value};

struct Prompt {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    /// `(name, description, required)`.
    args: &'static [(&'static str, &'static str, bool)],
    /// `{arg}` placeholders are replaced with the arguments.
    text: &'static str,
}

const PROMPTS: &[Prompt] = &[
    Prompt {
        name: "open_questions",
        title: "Open questions in this vault",
        description: "Collect the unanswered questions, unfinished tasks and loose ends across the vault and summarise them.",
        args: &[("folder", "Only look at notes in this folder. Leave empty for the whole vault.", false)],
        text: "Summarise the open questions in this vault{folder_clause}.\n\n\
1. Use `search` for unfinished tasks (`task-todo:\"\"`), for question marks in headings (`section:(?)`), and for words like TODO, TBD, \"not sure\", \"decide\", \"follow up\".\n\
2. Use `vault_stats` to see the broken links — a link to a note that does not exist is usually a question nobody answered.\n\
3. Read the most promising notes with `read_note` before you quote them.\n\n\
Then give me a short list, grouped by theme. For each item: the question in one line, the note it comes from (as a `[[wikilink]]`), and how old it looks. End with the three you think I should settle first, and why. Do not change anything in the vault.",
    },
    Prompt {
        name: "note_review",
        title: "Review a note",
        description: "Read one note with its links and mentions, and suggest what to fix, split or connect.",
        args: &[("path", "The note to review, e.g. `Projects/Alpha.md`.", true)],
        text: "Review the note `{path}`.\n\n\
Read it with `read_note`, then look at `outgoing_links`, `backlinks` and `unlinked_mentions` for it, and `properties` to see its frontmatter.\n\n\
Tell me: what the note is actually about in one sentence; anything stale, contradictory or unfinished; links it promises but does not have (including mentions that should be links); and whether it should be split or merged with something else. Suggest concrete edits, with the exact text to change, but do not write anything until I say so.",
    },
    Prompt {
        name: "vault_tour",
        title: "Show me around this vault",
        description: "A first look at an unfamiliar vault: size, structure, hubs, clusters and the places to start reading.",
        args: &[],
        text: "Give me a tour of this vault.\n\n\
Start with `vault_stats` and `list_folders` for the shape of it, `tags` for what it is about, and `graph` (and `graph_image` if you want to show me) for the hubs and clusters. Use `list_notes` with `sort: modified` to see what is being worked on now.\n\n\
Then write: what this vault is for, how it is organised, the five notes I should read first and why, where the work is happening, and anything that looks neglected — orphans, broken links, folders nobody has touched. Read nothing into it that is not there. Do not change anything.",
    },
    Prompt {
        name: "weekly_summary",
        title: "Summarise the week",
        description: "Read the notes changed recently and write a summary into the weekly note.",
        args: &[("days", "How many days back to look. Default 7.", false)],
        text: "Summarise what happened in this vault over the last {days} days.\n\n\
Use `list_notes` with `sort: modified` to find what changed, and `read_note` on the ones that matter. Check `daily_note` for each recent day as well.\n\n\
Write me a short summary: what was worked on, what was decided, what is still open. Then ask me whether to append it to the weekly note — and only if I say yes, use `periodic_note` with `period: \"weekly\"` and `action: \"append\"`.",
    },
];

pub fn list() -> Value {
    let items: Vec<Value> = PROMPTS
        .iter()
        .map(|p| {
            let args: Vec<Value> = p
                .args
                .iter()
                .map(|(name, description, required)| json!({ "name": name, "description": description, "required": required }))
                .collect();
            json!({ "name": p.name, "title": p.title, "description": p.description, "arguments": args })
        })
        .collect();
    json!({ "prompts": items })
}

/// `prompts/get`: fills the template from `arguments`.
pub fn get(name: &str, args: &serde_json::Map<String, Value>) -> Result<Value, String> {
    let Some(p) = PROMPTS.iter().find(|p| p.name == name) else {
        return Err(format!("Unknown prompt: {name} (available: {})", PROMPTS.iter().map(|p| p.name).collect::<Vec<_>>().join(", ")));
    };
    let mut text = p.text.to_string();
    for (arg, _, required) in p.args {
        let value = args.get(*arg).and_then(Value::as_str).map(str::trim).unwrap_or("");
        if *required && value.is_empty() {
            return Err(format!("prompt {name} needs the argument `{arg}`"));
        }
        let filled = match (*arg, value) {
            ("days", "") => "7".to_string(),
            _ => value.to_string(),
        };
        text = text.replace(&format!("{{{arg}}}"), &filled);
        text = text.replace(
            &format!("{{{arg}_clause}}"),
            &if filled.is_empty() { String::new() } else { format!(", limited to the folder `{filled}`") },
        );
    }
    Ok(json!({
        "description": p.description,
        "messages": [{ "role": "user", "content": { "type": "text", "text": text } }]
    }))
}
