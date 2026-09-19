/** Sample notes for the demo vault. Everything here is original sample content. */
export function demoVaultFiles(): Record<string, string> {
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  return {
    "Welcome.md": `---
tags: [start, demo]
aliases: [Home, Start here]
created: ${iso}
---
# Welcome

This vault lives in your browser. Every note is a plain Markdown file, so the same folder opens in any Markdown editor — including Obsidian.

Start with these:

- [[Linking notes]] — wikilinks, headings, blocks and aliases
- [[Formatting]] — callouts, tasks, math, diagrams and code
- [[Projects/Garden plan|The garden plan]] — a note in a folder, with properties
- [[Reading list.base|Reading list]] — a base: notes as a database
- [[Ideas.canvas|Ideas board]] — a canvas

> [!tip] Try the keyboard
> Press **Mod+O** to jump to a note, **Mod+P** for every command, and **Mod+E** to switch between editing and reading.

Tags like #demo and #start collect in the tag pane.
`,
    "Linking notes.md": `# Linking notes

Type two square brackets to link: [[Welcome]]. Link to a heading with a hash — [[Formatting#Callouts]] — or to a single block with a caret: [[Formatting#^quote]].

An alias changes the text a link shows: [[Welcome|go home]].

## Embeds

Put an exclamation mark in front of a link to embed the note:

![[Projects/Garden plan#Beds]]

## Links that do not exist yet

[[A note that does not exist]] is shown dimmed. Click it to create it.

## Backlinks

Open the right sidebar to see which notes link here.
`,
    "Formatting.md": `# Formatting

**Bold**, *italic*, ~~struck~~, ==highlighted== and \`inline code\`. %%This comment is hidden when reading.%%

## Callouts

> [!note] A note
> Callouts hold asides. They can contain **formatting** and [[Linking notes|links]].

> [!warning]- A folded warning
> Click the title to expand.

> [!example] Nested
> > [!success] Inside another callout
> > It works.

## Tasks

- [x] Open the demo vault
- [ ] Write a note
- [ ] Link it to [[Welcome]]
    - [ ] Nested subtask

## Math

Euler's identity inline: $e^{i\\pi} + 1 = 0$, and a block:

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

## Diagrams

\`\`\`mermaid
graph LR
  Idea --> Draft --> Note
  Note --> Idea
\`\`\`

## Code

\`\`\`rust
fn main() {
    println!("Notes are just files.");
}
\`\`\`

## Tables

| Syntax | Result |
| :-- | --: |
| \`==text==\` | ==text== |
| \`~~text~~\` | ~~text~~ |

## Quotes and footnotes

> Keep your notes in a format that will outlive the app you write them in.

^quote

A claim that needs a source.[^1]

[^1]: Footnotes appear at the bottom when reading.
`,
    "Projects/Garden plan.md": `---
status: in progress
priority: 2
due: ${iso}
tags: [project, garden]
---
# Garden plan

## Beds

| Bed | Crop | Sown |
| --- | --- | --- |
| North | Beans | April |
| South | Tomatoes | May |

## Tasks

- [ ] Order seeds
- [x] Build the south bed
`,
    "Projects/Kitchen shelves.md": `---
status: done
priority: 3
due: 2026-03-01
tags: [project]
---
# Kitchen shelves

Finished. See [[Projects/Garden plan]] for what is next.
`,
    "Books/The Pragmatic Programmer.md": `---
author: David Thomas, Andrew Hunt
rating: 5
read: true
genre: software
---
# The Pragmatic Programmer

A classic about craft.
`,
    "Books/Thinking in Systems.md": `---
author: Donella Meadows
rating: 4
read: true
genre: science
---
# Thinking in Systems
`,
    "Books/The Overstory.md": `---
author: Richard Powers
rating: 5
read: false
genre: fiction
---
# The Overstory
`,
    "Reading list.base": `filters:
  and:
    - file.inFolder("Books")
formulas:
  stars: '"★".repeat(rating)'
properties:
  note.author:
    displayName: Author
  formula.stars:
    displayName: Rating
views:
  - type: table
    name: All books
    order:
      - file.name
      - author
      - formula.stars
      - read
    sort:
      - property: rating
        direction: DESC
  - type: cards
    name: Unread
    filters:
      and:
        - read == false
`,
    "Ideas.canvas": JSON.stringify(
      {
        nodes: [
          { id: "a1", type: "text", text: "# Ideas\nDrag cards around. Double-click empty space to add one.", x: -320, y: -160, width: 300, height: 140, color: "4" },
          { id: "a2", type: "file", file: "Welcome.md", x: 60, y: -200, width: 360, height: 260 },
          { id: "a3", type: "link", url: "https://jsoncanvas.org", x: -320, y: 60, width: 300, height: 120 },
          { id: "g1", type: "group", label: "Start", x: -360, y: -240, width: 820, height: 460 },
        ],
        edges: [{ id: "e1", fromNode: "a1", fromSide: "right", toNode: "a2", toSide: "left", label: "read" }],
      },
      null,
      2,
    ),
    [`Daily/${iso}.md`]: `# ${iso}\n\n- Opened the demo vault\n`,
    // The daily note above lives in Daily/, so the Daily notes core plugin
    // (and Calendar, Periodic Notes, Homepage, which read its options) agree.
    ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", format: "YYYY-MM-DD", template: "" }, null, 2),
  };
}
