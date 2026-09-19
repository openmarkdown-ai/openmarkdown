/**
 * Standalone editor harness for development: the Markdown editor over an
 * in-memory vault with a sample note that exercises every syntax element,
 * plus toggles for Live Preview / Source / Vim and a few settings.
 *
 *   import { mountEditorHarness } from "@vault/app/src/dev/editor-harness";
 *   mountEditorHarness(document.getElementById("root")!);
 *
 * The fake host is deliberately simple (its Markdown renderer only knows what
 * the sample needs); the real host lives in obsidian/markdown.
 */
import "../styles/editor.css";
import { installDomExtensions } from "../obsidian/dom";
import { createMarkdownEditor } from "../editor/create";
import type { MarkdownEditorHandle } from "../editor/create";
import type { EditorConfig, EditorHost } from "../editor/host";
import { DEFAULT_EDITOR_CONFIG } from "../editor/host";
import { EDITOR_COMMANDS } from "../editor/commands";

export const SAMPLE_NOTE = `---
title: Editor tour
tags: [demo, editor]
aliases:
  - Tour
created: 2024-05-01
---
# Editor tour

This note exercises **bold**, *italic*, ***both***, ~~strikethrough~~, ==highlight==, \`inline code\`, and a %%hidden comment%%. Escaped \\*stars\\* stay literal.

## Links

- Internal: [[Roadmap]], with alias [[Roadmap|the plan]], to a heading [[Roadmap#Milestones]], to a block [[Roadmap#^goal-1]].
- Unresolved: [[Does not exist]]
- Markdown: [Obsidian help](https://help.obsidian.md) and a bare URL https://example.com
- Tags: #demo #project/alpha #émoji-ok
- Footnote reference[^1] and an inline footnote^[Written right here.]

## Lists

1. First
2. Second
   1. Nested numbered
3. Third

- Bullet
  - Nested bullet
    - Deeper bullet with a long line of text that should wrap onto the next line and stay aligned with the text after the bullet.
- [ ] Open task
- [x] Done task
- [>] Forwarded task

> A plain quote with **bold** text
> > and a nested quote

> [!tip]- Callouts render as widgets
> Click into the callout to edit its Markdown.
> - it can hold lists

## Math

Inline math $e^{i\\pi} + 1 = 0$ and a block:

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

## Code

\`\`\`js
function greet(name) {
  // say hello
  return \`Hello, \${name}!\`;
}
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

## Tables

| Feature | Status | Notes |
| :------ | :----: | ----: |
| Tables  | ✅     | [[Roadmap]] |
| Math    | ✅     | $x^2$ |

## Embeds

![[diagram.svg|240]]

![[Roadmap#Milestones]]

---

A paragraph with a block id. ^para-1

%%
A multi-line
comment block
%%

[^1]: The footnote text.
`;

const ROADMAP = `# Roadmap

The first goal is shipping the editor. ^goal-1

## Milestones

- [x] Syntax
- [ ] Live Preview polish

## Risks

Nothing yet.
`;

const DIAGRAM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect x="4" y="4" width="232" height="112" rx="12" fill="#8a5cf5" opacity="0.18"/><circle cx="60" cy="60" r="32" fill="#8a5cf5"/><rect x="110" y="36" width="100" height="48" rx="8" fill="#8a5cf5" opacity="0.6"/></svg>`;

interface FakeFile {
  path: string;
  content: string;
  url?: string;
}

function basename(path: string) {
  return path.split("/").pop()!.replace(/\.md$/, "");
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** A tiny inline renderer: enough for the sample's callouts, tables and embeds. */
function renderInline(md: string): string {
  let h = escapeHtml(md);
  h = h.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a class="internal-link" data-href="$1">$2</a>');
  h = h.replace(/\[\[([^\]]+)\]\]/g, '<a class="internal-link" data-href="$1">$1</a>');
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/==([^=]+)==/g, "<mark>$1</mark>");
  h = h.replace(/\$([^$]+)\$/g, '<span class="math math-inline">$1</span>');
  return h;
}

function renderBlockMarkdown(md: string, el: HTMLElement) {
  const lines = md.replace(/\n$/, "").split("\n");
  const callout = /^>\s*\[!(\w+)\]([+-]?)\s*(.*)$/.exec(lines[0] ?? "");
  if (callout) {
    const [, type, fold, title] = callout;
    const box = el.createDiv({ cls: `callout${fold ? " is-collapsible" : ""}${fold === "-" ? " is-collapsed" : ""}`, attr: { "data-callout": type!.toLowerCase() } });
    const titleEl = box.createDiv({ cls: "callout-title" });
    titleEl.createDiv({ cls: "callout-icon", text: "💡" });
    titleEl.createDiv({ cls: "callout-title-inner", text: title || type![0]!.toUpperCase() + type!.slice(1) });
    const content = box.createDiv({ cls: "callout-content" });
    if (fold) {
      const foldEl = titleEl.createDiv({ cls: "callout-fold", text: "▾" });
      const toggle = () => {
        box.toggleClass("is-collapsed", !box.hasClass("is-collapsed"));
        content.style.display = box.hasClass("is-collapsed") ? "none" : "";
      };
      foldEl.addEventListener("click", toggle);
      if (fold === "-") content.style.display = "none";
    }
    renderBlockMarkdown(lines.slice(1).map((l) => l.replace(/^>\s?/, "")).join("\n"), content);
    return;
  }
  if (/^\s*```mermaid/.test(lines[0] ?? "")) {
    const pre = el.createEl("pre", { cls: "mermaid vault-dev-mermaid" });
    pre.setText(`[mermaid diagram]\n${lines.slice(1, -1).join("\n")}`);
    return;
  }
  if (/^\s*```/.test(lines[0] ?? "")) {
    el.createEl("pre").createEl("code", { text: lines.slice(1, -1).join("\n") });
    return;
  }
  if (lines.length >= 2 && /^\s*\|?\s*:?-+/.test(lines[1]!)) {
    const table = el.createEl("table");
    const split = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
    const head = table.createEl("thead").createEl("tr");
    for (const c of split(lines[0]!)) head.createEl("th").innerHTML = renderInline(c);
    const body = table.createEl("tbody");
    for (const l of lines.slice(2)) {
      const tr = body.createEl("tr");
      for (const c of split(l)) tr.createEl("td").innerHTML = renderInline(c.replace(/\\\|/g, "|"));
    }
    return;
  }
  let list: HTMLElement | null = null;
  for (const l of lines) {
    const item = /^\s*[-*+]\s+(.*)$/.exec(l);
    if (item) {
      list ??= el.createEl("ul");
      list.createEl("li").innerHTML = renderInline(item[1]!);
      continue;
    }
    list = null;
    if (/^#{1,6}\s/.test(l)) {
      const level = /^#+/.exec(l)![0].length;
      el.createEl(`h${level}` as "h1").innerHTML = renderInline(l.replace(/^#+\s*/, ""));
    } else if (l.trim()) {
      el.createEl("p").innerHTML = renderInline(l);
    }
  }
}

function injectDevTheme() {
  if (document.getElementById("vault-editor-dev-theme")) return;
  const style = document.createElement("style");
  style.id = "vault-editor-dev-theme";
  // Dev-only approximation of the default theme's variables (the app's theme defines the real ones).
  style.textContent = `
  body.vault-editor-dev {
    --font-text: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; --font-interface: var(--font-text);
    --font-monospace: ui-monospace, "SF Mono", Menlo, Consolas, monospace; --font-text-size: 16px;
    --font-ui-smaller: 12px; --font-ui-small: 13px; --line-height-normal: 1.5; --line-height-tight: 1.3;
    --background-primary: #ffffff; --background-secondary: #f6f6f6; --background-modifier-border: #e0e0e0;
    --background-modifier-hover: rgba(0,0,0,0.067); --text-normal: #222222; --text-muted: #5c5c5c; --text-faint: #ababab;
    --text-accent: #8a5cf5; --text-on-accent: #fff; --text-error: #e93147; --text-selection: rgba(138,92,245,0.2);
    --text-highlight-bg: rgba(255,208,0,0.4); --text-highlight-bg-active: rgba(255,128,0,0.4); --caret-color: #222;
    --interactive-accent: #8a5cf5; --icon-color: #5c5c5c; --icon-color-hover: #222; --icon-xs: 14px; --icon-s: 16px;
    --size-2-1: 2px; --size-2-2: 4px; --size-2-3: 6px; --size-4-1: 4px; --size-4-2: 8px; --size-4-3: 12px; --size-4-4: 16px; --size-4-6: 24px; --size-4-12: 48px;
    --radius-s: 4px; --radius-m: 8px; --clickable-icon-radius: 4px; --border-width: 1px; --shadow-s: 0 2px 8px rgba(0,0,0,0.12); --layer-popover: 30;
    --file-line-width: 700px; --file-margins: 32px 48px;
    --h1-size: 1.802em; --h2-size: 1.602em; --h3-size: 1.424em; --h4-size: 1.266em; --h5-size: 1.125em; --h6-size: 1em;
    --h1-weight: 700; --h2-weight: 600; --h3-weight: 600; --h4-weight: 600; --h5-weight: 600; --h6-weight: 600;
    --h1-line-height: 1.2; --h2-line-height: 1.2; --h3-line-height: 1.3; --h4-line-height: 1.4; --h5-line-height: 1.5; --h6-line-height: 1.5;
    --h1-color: inherit; --h2-color: inherit; --h3-color: inherit; --h4-color: inherit; --h5-color: inherit; --h6-color: inherit;
    --h1-font: inherit; --h2-font: inherit; --h3-font: inherit; --h4-font: inherit; --h5-font: inherit; --h6-font: inherit;
    --bold-weight: 600; --bold-color: inherit; --italic-color: inherit;
    --link-color: #8a5cf5; --link-color-hover: #a68af9; --link-decoration: underline; --link-decoration-hover: underline; --link-decoration-thickness: auto; --link-weight: inherit;
    --link-external-color: #8a5cf5; --link-external-color-hover: #a68af9; --link-external-decoration: underline; --link-external-decoration-hover: underline;
    --link-unresolved-color: #8a5cf5; --link-unresolved-opacity: 0.7; --link-unresolved-decoration-style: solid; --link-unresolved-decoration-color: rgba(138,92,245,0.3);
    --tag-size: 0.875em; --tag-color: #8a5cf5; --tag-color-hover: #8a5cf5; --tag-background: rgba(138,92,245,0.1); --tag-background-hover: rgba(138,92,245,0.2);
    --tag-border-color: transparent; --tag-border-width: 0; --tag-padding-x: 0.65em; --tag-padding-y: 0.25em; --tag-radius: 2em; --tag-weight: inherit; --tag-decoration: none;
    --code-background: #f6f6f6; --code-normal: #5c5c5c; --code-size: 0.875em; --code-radius: 4px; --code-comment: #ababab; --code-function: #c89a00;
    --code-important: #ec7500; --code-keyword: #d53984; --code-operator: #e93147; --code-property: #00a5c2; --code-punctuation: #5c5c5c; --code-string: #0cb54f; --code-tag: #e93147; --code-value: #8a5cf5;
    --blockquote-border-thickness: 2px; --blockquote-border-color: #8a5cf5; --blockquote-color: inherit; --blockquote-font-style: normal; --blockquote-background-color: transparent;
    --list-indent: 2.25em; --list-spacing: 0.075em; --list-marker-color: #ababab; --list-marker-color-hover: #5c5c5c; --list-bullet-size: 0.3em; --list-bullet-radius: 50%; --list-bullet-border: none; --list-bullet-transform: none;
    --checkbox-size: 1em; --checkbox-radius: 4px; --checkbox-color: #8a5cf5; --checkbox-color-hover: #a68af9; --checkbox-border-color: #ababab; --checkbox-border-color-hover: #5c5c5c; --checkbox-marker-color: #fff;
    --checklist-done-color: #5c5c5c; --checklist-done-decoration: line-through;
    --indentation-guide-width: 1px; --indentation-guide-width-active: 1px; --indentation-guide-color: rgba(0,0,0,0.12); --indentation-guide-color-active: rgba(0,0,0,0.3);
    --hr-color: #e0e0e0; --hr-thickness: 2px; --collapse-icon-color: #ababab; --collapse-icon-color-collapsed: #8a5cf5;
    --table-border-width: 1px; --table-border-color: #e0e0e0; --table-header-background: transparent; --table-header-weight: 600; --table-header-color: inherit; --table-text-size: inherit; --table-text-color: inherit; --table-line-height: 1.5; --table-white-space: normal; --table-row-background-hover: transparent;
    --callout-radius: 4px; margin: 0; font-family: var(--font-interface); color: var(--text-normal); background: var(--background-primary);
  }
  .vault-editor-harness { display: flex; flex-direction: column; height: 100%; min-height: 480px; }
  .vault-editor-harness-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--background-modifier-border); background: var(--background-secondary); font-size: 13px; }
  .vault-editor-harness-bar button { font: inherit; padding: 3px 10px; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); cursor: pointer; }
  .vault-editor-harness-bar button.is-active { background: var(--interactive-accent); color: #fff; border-color: transparent; }
  .vault-editor-harness-bar select { font: inherit; }
  .vault-editor-harness-status { margin-inline-start: auto; color: var(--text-muted); }
  .vault-editor-harness-body { flex: 1; min-height: 0; position: relative; }
  .vault-editor-dev .callout { border-radius: var(--callout-radius); padding: 12px 16px; background: rgba(0,191,188,0.1); border-left: 3px solid rgb(0,191,188); }
  .vault-editor-dev .callout-title { display: flex; gap: 6px; font-weight: 600; color: rgb(0,150,148); align-items: center; }
  .vault-editor-dev .callout-fold { margin-left: auto; cursor: pointer; }
  .vault-editor-dev .callout-content p, .vault-editor-dev .callout-content ul { margin: 6px 0 0; }
  .vault-editor-dev .math { font-family: "Times New Roman", serif; font-style: italic; }
  .vault-editor-dev .vault-dev-mermaid { background: var(--code-background); padding: 12px; border-radius: 4px; font-size: 13px; margin: 0; }
  .vault-editor-dev .markdown-embed { border-left: 2px solid var(--interactive-accent); padding: 4px 16px; }
  .vault-editor-dev .markdown-embed h1, .vault-editor-dev .markdown-embed h2 { font-size: 1.1em; margin: 4px 0; }
  .vault-editor-dev .metadata-container { margin: 0 0 16px; padding: 8px 0; border-bottom: 1px solid var(--background-modifier-border); font-family: var(--font-interface); font-size: 13px; }
  .vault-editor-dev .metadata-property { display: flex; gap: 8px; padding: 2px 0; }
  .vault-editor-dev .metadata-property-key { width: 120px; color: var(--text-muted); }
  .vault-editor-dev .metadata-property-value input { font: inherit; border: none; background: transparent; width: 100%; color: var(--text-normal); }
  .vault-editor-dev .inline-title { font-size: var(--h1-size); font-weight: 700; margin-bottom: 0.5em; outline: none; }
  `;
  document.head.appendChild(style);
}

export interface EditorHarness {
  handle: MarkdownEditorHandle;
  host: EditorHost;
  config: EditorConfig;
  files: Map<string, FakeFile>;
  log: string[];
  setConfig(patch: Partial<EditorConfig>): void;
  runCommand(id: string): void;
}

export function mountEditorHarness(el: HTMLElement): EditorHarness {
  installDomExtensions();
  injectDevTheme();
  document.body.classList.add("vault-editor-dev");
  const svgUrl = URL.createObjectURL(new Blob([DIAGRAM_SVG], { type: "image/svg+xml" }));
  const files = new Map<string, FakeFile>([
    ["Editor tour.md", { path: "Editor tour.md", content: SAMPLE_NOTE }],
    ["Projects/Roadmap.md", { path: "Projects/Roadmap.md", content: ROADMAP }],
    ["Daily/2024-05-01.md", { path: "Daily/2024-05-01.md", content: "# 2024-05-01\n\n- met with #project/alpha\n" }],
    ["diagram.svg", { path: "diagram.svg", content: "", url: svgUrl }],
  ]);
  const config: EditorConfig = { ...DEFAULT_EDITOR_CONFIG };
  const log: string[] = [];
  const current = files.get("Editor tour.md")!;

  const root = el.createDiv({ cls: "vault-editor-harness" });
  const bar = root.createDiv({ cls: "vault-editor-harness-bar" });
  const body = root.createDiv({ cls: "vault-editor-harness-body" });
  const status = bar.createSpan({ cls: "vault-editor-harness-status" });
  const note = (msg: string) => {
    log.push(msg);
    status.setText(msg);
  };

  const find = (linkpath: string): FakeFile | null => {
    const lp = linkpath.replace(/\\$/, "").trim();
    if (!lp) return current;
    for (const f of files.values()) {
      if (f.path === lp || f.path === lp + ".md" || basename(f.path) === lp || f.path.split("/").pop() === lp) return f;
    }
    return null;
  };

  const host: EditorHost = {
    app: { vault: { getName: () => "Harness" } },
    getFile: () => ({ path: current.path, basename: basename(current.path) }),
    resolveLink: (linkpath) => {
      const f = find(linkpath);
      return f ? { path: f.path, extension: f.path.split(".").pop()! } : null;
    },
    getLinkSuggestions: (query) => {
      const q = query.toLowerCase();
      const out = [...files.values()]
        .filter((f) => f.path.toLowerCase().includes(q))
        .map((f) => ({ path: f.path, display: f.path.endsWith(".md") ? basename(f.path) : f.path.split("/").pop()!, note: f.path.includes("/") ? f.path : undefined }));
      if (query && !out.length) out.push({ path: query, display: query, note: undefined, unresolved: true } as never);
      return out;
    },
    getHeadingSuggestions: (linkpath) => {
      const f = find(linkpath);
      if (!f) return [];
      return f.content
        .split("\n")
        .map((l) => /^(#{1,6})\s+(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => ({ heading: m[2]!, level: m[1]!.length }));
    },
    getBlockSuggestions: (linkpath) => {
      const f = find(linkpath);
      if (!f) return [];
      return f.content
        .split("\n")
        .map((text, line) => ({ text, line, id: /\s\^([\w-]+)$/.exec(text)?.[1] }))
        .filter((b) => b.text.trim() && !b.text.startsWith("#") && !b.text.startsWith("---"));
    },
    getTagSuggestions: (query) => {
      const counts = new Map<string, number>();
      for (const f of files.values()) for (const m of f.content.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) counts.set("#" + m[1], (counts.get("#" + m[1]) ?? 0) + 1);
      return [...counts.entries()].filter(([t]) => t.toLowerCase().includes(query.toLowerCase())).map(([tag, count]) => ({ tag, count }));
    },
    openLink: (linktext, _source, newLeaf) => note(`openLink(${JSON.stringify(linktext)}${newLeaf ? ", new leaf" : ""})`),
    openExternal: (url) => note(`openExternal(${url})`),
    onTagClick: (tag) => note(`search tag ${tag}`),
    renderEmbed: (container, linktext, _source, alt) => {
      const [path, sub] = linktext.split("#");
      const f = find(path!);
      if (!f) {
        container.addClass("file-embed", "mod-empty");
        container.setText(`"${linktext}" could not be found.`);
        return;
      }
      if (f.url) {
        container.addClass("media-embed", "image-embed", "is-loaded");
        const img = container.createEl("img", { attr: { src: f.url, alt } });
        const w = /^(\d+)/.exec(alt)?.[1];
        if (w) img.setAttribute("width", w);
        return;
      }
      container.addClass("markdown-embed", "inline-embed", "is-loaded");
      let text = f.content;
      if (sub) {
        const lines = text.split("\n");
        const start = lines.findIndex((l) => new RegExp(`^#+\\s+${sub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`).test(l));
        if (start >= 0) {
          const level = /^#+/.exec(lines[start]!)![0].length;
          let end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l) && /^#+/.exec(l)![0].length <= level);
          if (end < 0) end = lines.length;
          text = lines.slice(start, end).join("\n");
        }
      }
      renderBlockMarkdown(text, container.createDiv({ cls: "markdown-embed-content" }));
    },
    renderMath: (source, display) => {
      const e = createSpan({ cls: display ? "vault-dev-math is-display" : "vault-dev-math" });
      e.setText(source);
      return e;
    },
    renderMarkdown: (markdown, container) => renderBlockMarkdown(markdown, container),
    renderProperties: (container, yaml, onChange) => {
      const rows = yaml.split("\n");
      rows.forEach((row, i) => {
        const m = /^([^:\s][^:]*):\s*(.*)$/.exec(row);
        if (!m) return;
        const prop = container.createDiv({ cls: "metadata-property" });
        prop.createDiv({ cls: "metadata-property-key", text: m[1]! });
        const input = prop.createDiv({ cls: "metadata-property-value" }).createEl("input", { value: m[2]! });
        input.addEventListener("change", () => {
          rows[i] = `${m[1]}: ${input.value}`;
          onChange(rows.join("\n"));
        });
      });
    },
    hasCodeBlockProcessor: (lang) => lang === "dataview",
    htmlToMarkdown: (html) => {
      const div = document.createElement("div");
      div.innerHTML = html;
      for (const b of Array.from(div.querySelectorAll("b, strong"))) b.replaceWith(`**${b.textContent}**`);
      for (const i of Array.from(div.querySelectorAll("i, em"))) i.replaceWith(`*${i.textContent}*`);
      for (const a of Array.from(div.querySelectorAll("a"))) a.replaceWith(`[${a.textContent}](${a.getAttribute("href")})`);
      return div.textContent ?? "";
    },
    saveAttachment: async (file) => {
      const name = file.name || `Pasted image ${Date.now()}.png`;
      files.set(name, { path: name, content: "", url: URL.createObjectURL(file) });
      note(`saved attachment ${name}`);
      return name;
    },
    getConfig: (key) => (config as unknown as Record<string, unknown>)[key],
    onDocChanged: (text) => {
      current.content = text;
    },
    getEditorSuggests: () => null,
    extraExtensions: () => [],
  };

  const inlineTitle = createDiv({ cls: "inline-title", text: basename(current.path) });
  const handle = createMarkdownEditor(body, host, current.content, { inlineTitleEl: inlineTitle });

  const buttons: Record<string, HTMLButtonElement> = {};
  const refreshBar = () => {
    buttons.lp!.toggleClass("is-active", handle.isLivePreview());
    buttons.source!.toggleClass("is-active", !handle.isLivePreview());
    buttons.vim!.toggleClass("is-active", config.vimMode);
    buttons.lines!.toggleClass("is-active", config.showLineNumber);
    buttons.readable!.toggleClass("is-active", config.readableLineLength);
  };
  const button = (key: string, label: string, onClick: () => void) => {
    const b = bar.createEl("button", { text: label, attr: { "data-harness": key } });
    b.addEventListener("click", () => {
      onClick();
      refreshBar();
      handle.view.focus();
    });
    buttons[key] = b;
  };
  const setConfig = (patch: Partial<EditorConfig>) => {
    Object.assign(config, patch);
    handle.reconfigure();
    refreshBar();
  };
  button("lp", "Live Preview", () => handle.setMode(true));
  button("source", "Source", () => handle.setMode(false));
  button("vim", "Vim", () => setConfig({ vimMode: !config.vimMode }));
  button("lines", "Line numbers", () => setConfig({ showLineNumber: !config.showLineNumber }));
  button("readable", "Readable width", () => setConfig({ readableLineLength: !config.readableLineLength }));
  const props = bar.createEl("select", { attr: { "data-harness": "properties" } });
  for (const v of ["visible", "hidden", "source"]) props.createEl("option", { text: `Properties: ${v}`, value: v });
  props.addEventListener("change", () => setConfig({ propertiesInDocument: props.value as EditorConfig["propertiesInDocument"] }));
  const cmd = bar.createEl("select", { attr: { "data-harness": "command" } });
  cmd.createEl("option", { text: "Run command…", value: "" });
  for (const c of EDITOR_COMMANDS) cmd.createEl("option", { text: c.name, value: c.id });
  const runCommand = (id: string) => {
    const c = EDITOR_COMMANDS.find((x) => x.id === id);
    if (c) c.editorCallback(handle.editor);
  };
  cmd.addEventListener("change", () => {
    runCommand(cmd.value);
    cmd.value = "";
    handle.view.focus();
  });
  bar.appendChild(status);
  refreshBar();

  return { handle, host, config, files, log, setConfig, runCommand };
}
