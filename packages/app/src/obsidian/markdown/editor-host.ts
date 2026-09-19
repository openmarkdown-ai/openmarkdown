/**
 * The EditorHost the CodeMirror editor runs against, implemented over the real
 * App for one MarkdownView (see packages/app/src/editor/host.ts for the
 * contract).
 */
import moment from "moment";
import type { EditorHost, LinkSuggestion } from "../../editor/host";
import { getEngine } from "@vault/engine";
import { setIcon } from "../ui/icons";
import { Menu } from "../ui/menu";
import { parseFrontMatterAliases, parseLinktext } from "../util";
import type { TFile } from "../vault/files";
import { renderMathSync } from "./loaders";
import { MarkdownPreviewRenderer, MarkdownRenderer, renderEmbedInto } from "./renderer";
import { runCommandOn } from "../../editor/toolbar-commands";
import { customTitle } from "../../core-plugins/file-explorer/note-titles";
import { vaultVocabulary } from "../../editor/vocabulary";

type MetadataEditorRenderer = (app: any, containerEl: HTMLElement, file: TFile | null, yaml: string, onChange: (yaml: string) => void, opts?: Record<string, unknown>) => void;

let metadataEditorRenderer: MetadataEditorRenderer | null = null;

/** Installed at startup by the Properties module. */
export function setMetadataEditorRenderer(fn: MetadataEditorRenderer) {
  metadataEditorRenderer = fn;
}

export function getMetadataEditorRenderer(): MetadataEditorRenderer | null {
  return metadataEditorRenderer;
}

function fallbackProperties(container: HTMLElement, yaml: string) {
  container.empty();
  container.addClass("metadata-container");
  container.createEl("pre", { cls: "vault-frontmatter-fallback", text: yaml });
}

export function createEditorHost(app: any, view: any): EditorHost {
  const vault = app.vault;
  const cache = app.metadataCache;

  return {
    app,
    getInfo: () => view,
    getFile: () => view.file,

    resolveLink(linkpath, sourcePath) {
      const f = cache.getFirstLinkpathDest(linkpath, sourcePath);
      return f ? { path: f.path, extension: f.extension } : null;
    },

    getLinkSuggestions(query, sourcePath) {
      const entries: LinkSuggestion[] = [];
      const basenames = new Map<string, number>();
      const titled = new Set<string>();
      const titleRows = new Set<LinkSuggestion>();
      const files: TFile[] = vault.getFiles();
      for (const f of files) basenames.set(f.basename, (basenames.get(f.basename) ?? 0) + 1);
      for (const f of files) {
        const ambiguous = (basenames.get(f.basename) ?? 0) > 1;
        const display = f.extension === "md" ? (ambiguous ? f.path.replace(/\.md$/, "") : f.basename) : f.name;
        entries.push({
          path: f.path,
          display,
          linktext: cache.fileToLinktext(f, sourcePath, true),
          note: f.parent && !f.parent.isRoot() ? f.parent.path : undefined,
        });
        // A note shown by its title ("Show note title from", W5) is listed and matched by that title
        // too, with the file name beside it; the inserted link text stays the file's.
        const title = f.extension === "md" ? customTitle(app, f) : null;
        if (title && title !== f.basename) {
          titled.add(f.path);
          const row: LinkSuggestion = { path: f.path, display: title, linktext: cache.fileToLinktext(f, sourcePath, true), note: display };
          titleRows.add(row);
          entries.push(row);
        }
        for (const alias of parseFrontMatterAliases(cache.getFileCache(f)?.frontmatter ?? null) ?? []) {
          entries.push({ path: f.path, display: alias, linktext: cache.fileToLinktext(f, sourcePath, true), alias, note: f.basename });
        }
      }
      const seen = new Set<string>();
      for (const links of Object.values(cache.unresolvedLinks as Record<string, Record<string, number>>)) {
        for (const link of Object.keys(links)) {
          if (seen.has(link)) continue;
          seen.add(link);
          entries.push({ path: link, display: link, linktext: link, unresolved: true });
        }
      }
      if (!query) {
        const recent = app.workspace.getLastOpenFiles() as string[];
        const rank = (e: LinkSuggestion) => {
          const i = recent.indexOf(e.path);
          return i === -1 ? 1000 : i;
        };
        // One row per file: the title row for titled notes, else the file-name row.
        return entries
          .filter((e) => !e.unresolved && !e.alias && (!titled.has(e.path) || titleRows.has(e)))
          .sort((a, b) => rank(a) - rank(b))
          .slice(0, 50);
      }
      const ranked = getEngine().rank(query, entries.map((e) => e.display), 50);
      return ranked.map((r) => entries[r.index]!);
    },

    getHeadingSuggestions(linkpath, sourcePath) {
      const file = linkpath ? cache.getFirstLinkpathDest(linkpath, sourcePath) : vault.getFileByPath(sourcePath);
      const headings = file ? (cache.getFileCache(file)?.headings ?? []) : [];
      return headings.map((h: { heading: string; level: number }) => ({ heading: h.heading, level: h.level }));
    },

    getBlockSuggestions(linkpath, sourcePath) {
      const file = linkpath ? cache.getFirstLinkpathDest(linkpath, sourcePath) : vault.getFileByPath(sourcePath);
      if (!file) return [];
      const meta = cache.getFileCache(file);
      const text: string | null = vault.getCachedText(file.path);
      if (!meta || text === null) return [];
      const lines = text.split("\n");
      return (meta.sections ?? [])
        .filter((s: { type: string }) => s.type !== "yaml" && s.type !== "thematicBreak")
        .map((s: { id?: string; position: { start: { line: number }; end: { line: number } } }) => ({
          id: s.id,
          text: lines.slice(s.position.start.line, s.position.end.line + 1).join(" ").trim().slice(0, 200),
          line: s.position.end.line,
        }));
    },

    getTagSuggestions(query) {
      const q = query.replace(/^#/, "").toLowerCase();
      return Object.entries(cache.getTags() as Record<string, number>)
        .filter(([tag]) => tag.slice(1).toLowerCase().includes(q))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([tag, count]) => ({ tag, count }));
    },

    addBlockId(linkpath, sourcePath, line, id) {
      const file = linkpath ? cache.getFirstLinkpathDest(linkpath, sourcePath) : vault.getFileByPath(sourcePath);
      if (!file) return;
      void vault.process(file, (text: string) => {
        const lines = text.split("\n");
        if (lines[line] !== undefined) lines[line] = `${lines[line]!.replace(/\s+$/, "")} ^${id}`;
        return lines.join("\n");
      });
    },

    openLink(linktext, sourcePath, newLeaf) {
      void app.workspace.openLinkText(linktext, sourcePath, newLeaf ? "tab" : false);
    },
    openExternal(url) {
      window.open(url, "_blank", "noopener");
    },
    onTagClick(tag) {
      const search = app.internalPlugins.getEnabledPluginById("global-search");
      search?.openGlobalSearch?.(`tag:${tag}`);
    },
    onLinkHover(evt, targetEl, linktext, sourcePath) {
      app.workspace.trigger("hover-link", { event: evt, source: "editor", hoverParent: view, targetEl, linktext, sourcePath });
    },

    renderEmbed(container, linktext, sourcePath, alt) {
      renderEmbedInto(app, view, container, linktext, sourcePath, alt);
    },
    renderMath: (source, display) => renderMathSync(source, display),
    renderMarkdown: (markdown, container, sourcePath) => MarkdownRenderer.render(app, markdown, container, sourcePath, view),
    renderProperties(container, yaml, onChange) {
      if (metadataEditorRenderer) metadataEditorRenderer(app, container, view.file, yaml, onChange, { source: "editor" });
      else fallbackProperties(container, yaml);
    },
    hasCodeBlockProcessor: (lang) => lang in MarkdownPreviewRenderer.codeBlockPostProcessors,

    htmlToMarkdown(html) {
      try {
        return getEngine().htmlToMarkdown(html, undefined);
      } catch {
        const div = document.createElement("div");
        div.innerHTML = html;
        return div.innerText;
      }
    },

    async saveAttachment(file, sourcePath) {
      const dot = file.name.lastIndexOf(".");
      const ext = dot > 0 ? file.name.slice(dot + 1) : (file.type.split("/")[1] ?? "bin");
      const pasted = !file.name || /^image\.\w+$/.test(file.name);
      const name = pasted ? `Pasted image ${moment().format("YYYYMMDDHHmmss")}.${ext}` : file.name;
      const path = await app.fileManager.getAvailablePathForAttachment(name, sourcePath);
      const created = await vault.createBinary(path, await file.arrayBuffer());
      return cache.fileToLinktext(created, sourcePath, created.extension === "md");
    },

    getConfig: (key) => vault.getConfig(String(key)),

    onDocChanged: (text) => view.onEditorDocChanged(text),
    onSelectionChanged: () => view.onEditorSelectionChanged?.(),
    getEditorSuggests: () => app.workspace.editorSuggest,
    extraExtensions: () => app.workspace.editorExtensions ?? [],
    setIcon: (el, icon) => setIcon(el, icon),

    isPluginEnabled: (id) => !!app.plugins?.enabledPlugins?.has?.(id) && !!app.plugins?.plugins?.[id],
    // [W3:vocabulary] word completion and grammar check (core plugin `grammar`).
    getVocabulary: () => vaultVocabulary(vault),
    lintGrammar: (text) => app.internalPlugins?.getEnabledPluginById?.("grammar")?.lint?.(text) ?? Promise.resolve([]),
    addToDictionary: async (word) => void (await app.internalPlugins?.getEnabledPluginById?.("grammar")?.addToDictionary?.(word)),

    onPaste(evt) {
      app.workspace.trigger("editor-paste", evt, view.editor, view);
      return evt.defaultPrevented;
    },
    onDrop(evt) {
      app.workspace.trigger("editor-drop", evt, view.editor, view);
      if (evt.defaultPrevented) return true;
      const drag = app.dragManager.draggable;
      if (drag && (drag.file || drag.files || drag.linktext)) {
        evt.preventDefault();
        const source = view.file?.path ?? "";
        const links: string[] = [];
        const add = (f: TFile) => links.push(app.fileManager.generateMarkdownLink(f, source));
        if (drag.files) drag.files.forEach((f: TFile) => "extension" in f && add(f));
        else if (drag.file && "extension" in drag.file) add(drag.file);
        else if (drag.linktext) links.push(`[[${drag.linktext}]]`);
        const pos = view.editor.cm.posAtCoords({ x: evt.clientX, y: evt.clientY }) ?? view.editor.cm.state.selection.main.head;
        view.editor.cm.dispatch({ changes: { from: pos, insert: links.join("\n") }, selection: { anchor: pos + links.join("\n").length } });
        return true;
      }
      return false;
    },
    onContextMenu(evt) {
      const editor = view.editor;
      const cm = editor.cm;
      // Shift+right-click always gives the browser's own menu.
      if (evt.shiftKey) return false;
      const clickPos: number | null = cm ? cm.posAtCoords({ x: evt.clientX, y: evt.clientY }) : null;
      const clickToken = clickPos === null ? null : (editor.getClickableTokenAt?.(editor.offsetToPos(clickPos)) ?? null);
      if (nativeSpellMenuWanted(app, cm, evt, clickPos, clickToken)) return false;

      const menu = new Menu();
      const hasSelection = editor.somethingSelected();
      const run = (id: string) => runCommandOn(app, id, editor, view);
      const cmd = (m: Menu, section: string, id: string, title: string, icon: string) =>
        m.addItem((i) => i.setSection(section).setTitle(title).setIcon(icon).onClick(() => void run(id)));

      menu.addItem((i) => i.setSection("clipboard").setTitle("Cut").setIcon("lucide-scissors").setDisabled(!hasSelection).onClick(() => {
        editor.focus();
        document.execCommand("cut");
      }));
      menu.addItem((i) => i.setSection("clipboard").setTitle("Copy").setIcon("lucide-copy").setDisabled(!hasSelection).onClick(() => void navigator.clipboard.writeText(editor.getSelection())));
      const paste = (plain: boolean) => async () => {
        try {
          if (!plain && navigator.clipboard.read) {
            const items = await navigator.clipboard.read();
            const html = items.find((it) => it.types.includes("text/html"));
            if (html && app.vault.getConfig("autoConvertHtml") !== false) {
              const md = getEngine().htmlToMarkdown(await (await html.getType("text/html")).text(), undefined);
              if (md) return editor.replaceSelection(md, "paste");
            }
          }
          editor.replaceSelection(await navigator.clipboard.readText(), "paste");
        } catch {
          /* clipboard permission refused */
        }
      };
      menu.addItem((i) => i.setSection("clipboard").setTitle("Paste").setIcon("lucide-clipboard-paste").onClick(paste(false)));
      menu.addItem((i) => i.setSection("clipboard").setTitle("Paste as plain text").setIcon("lucide-clipboard-type").onClick(paste(true)));
      menu.addItem((i) =>
        i.setSection("clipboard").setTitle("Select all").setIcon("lucide-text-select").onClick(() => {
          editor.focus();
          editor.setSelection({ line: 0, ch: 0 }, { line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length });
        }),
      );

      const submenu = (title: string, icon: string) => {
        let sub!: Menu;
        menu.addItem((i) => {
          i.setSection("action-primary").setTitle(title).setIcon(icon);
          sub = (i as unknown as { setSubmenu(): Menu }).setSubmenu();
        });
        return sub;
      };
      const format = submenu("Format", "lucide-type");
      cmd(format, "format", "editor:toggle-bold", "Bold", "lucide-bold");
      cmd(format, "format", "editor:toggle-italics", "Italic", "lucide-italic");
      cmd(format, "format", "editor:toggle-strikethrough", "Strikethrough", "lucide-strikethrough");
      cmd(format, "format", "editor:toggle-highlight", "Highlight", "lucide-highlighter");
      cmd(format, "format", "editor:toggle-code", "Code", "lucide-code");
      cmd(format, "format", "editor:toggle-inline-math", "Math", "lucide-sigma");
      cmd(format, "format", "editor:toggle-comments", "Comment", "lucide-percent");
      cmd(format, "clear", "editor:clear-formatting", "Clear formatting", "lucide-eraser");
      const paragraph = submenu("Paragraph", "lucide-pilcrow");
      cmd(paragraph, "list", "editor:toggle-bullet-list", "Bullet list", "lucide-list");
      cmd(paragraph, "list", "editor:toggle-numbered-list", "Numbered list", "lucide-list-ordered");
      cmd(paragraph, "list", "editor:toggle-checklist-status", "Task list", "lucide-check-square");
      for (let n = 1; n <= 6; n++) cmd(paragraph, "heading", `editor:set-heading-${n}`, `Heading ${n}`, `lucide-heading-${n}`);
      cmd(paragraph, "heading", "editor:set-heading-0", "Body", "lucide-pilcrow");
      cmd(paragraph, "quote", "editor:toggle-blockquote", "Quote", "lucide-quote");
      const insert = submenu("Insert", "lucide-plus-circle");
      cmd(insert, "insert", "editor:insert-footnote", "Footnote", "lucide-footprints");
      cmd(insert, "insert", "editor:insert-table", "Table", "lucide-table");
      cmd(insert, "insert", "editor:insert-callout", "Callout", "lucide-message-square-quote");
      cmd(insert, "insert", "editor:insert-codeblock", "Code block", "lucide-square-code");
      cmd(insert, "insert", "editor:insert-mathblock", "Math block", "lucide-sigma-square");
      cmd(insert, "insert", "editor:insert-horizontal-rule", "Horizontal rule", "lucide-minus");
      cmd(insert, "link", "editor:insert-link", "Markdown link", "lucide-link");
      cmd(insert, "link", "editor:insert-wikilink", "Internal link", "lucide-link-2");
      if (app.internalPlugins?.getEnabledPluginById?.("templates")) {
        insert.addItem((i) =>
          i.setSection("template").setTitle("Template").setIcon("lucide-files").onClick(() => {
            if (!run("templates:insert-template")) run("insert-template");
          }),
        );
      }

      cmd(menu, "action", "markdown:add-metadata-property", "Add file property", "lucide-list-plus");
      const token = clickToken ?? editor.getClickableTokenAt?.(editor.getCursor()) ?? null;
      if (token?.type === "internal-link") app.workspace.handleLinkContextMenu(menu, token.text, view.file?.path ?? "");
      app.workspace.trigger("editor-menu", menu, editor, view);
      menu.showAtMouseEvent(evt);
      return true;
    },
  };
}

/**
 * Whether a right-click should open the browser's menu (spelling suggestions,
 * Add to dictionary) instead of ours: spellcheck and `nativeSpellMenu` are on,
 * and the click lands on a plain word — not a link, tag, embed or widget — with
 * no selection of the user's own (macOS selects the clicked word before the
 * event, so a selection equal to that word still counts as none).
 */
function nativeSpellMenuWanted(app: any, cm: any, evt: MouseEvent, pos: number | null, token: unknown): boolean {
  // `editor:context-menu` asks for our menu explicitly.
  if (!cm || pos === null || token || (evt as MouseEvent & { vaultEditorMenu?: boolean }).vaultEditorMenu) return false;
  if (!app.vault.getConfig("spellcheck") || app.vault.getConfig("nativeSpellMenu") === false) return false;
  const target = evt.target as HTMLElement | null;
  if (!target || !cm.contentDOM.contains(target)) return false;
  if (target.closest('[contenteditable="false"], .cm-widgetBuffer, .cm-embed-block, a, img, .cm-hashtag, .cm-hmd-internal-link, .cm-url, .cm-link, .cm-formatting')) return false;
  const state = cm.state;
  const word = state.wordAt(pos);
  if (!word) return false;
  // The pointer must be over the word itself, not the empty space after a line.
  const coords = cm.coordsAtPos(word.from);
  const end = cm.coordsAtPos(word.to, -1);
  if (!coords || !end || evt.clientX < coords.left - 1 || evt.clientX > end.right + 1 || evt.clientY < coords.top - 1 || evt.clientY > end.bottom + 1) return false;
  const sel = state.selection;
  if (sel.ranges.length > 1) return false;
  const main = sel.main;
  return main.empty || (main.from === word.from && main.to === word.to);
}

export { parseLinktext };
