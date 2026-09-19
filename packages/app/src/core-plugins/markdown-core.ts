/**
 * The Markdown view and editor commands — an always-on core plugin, because in
 * Obsidian these belong to the app itself.
 */
import { EDITOR_COMMANDS } from "../editor/commands";
import type { CorePluginDefinition } from "../obsidian/app-internals/internal-plugins";
import { MarkdownEmbed } from "../obsidian/markdown/embeddable-editor";
import { MarkdownView } from "../obsidian/markdown/markdown-view";
import { Plugin } from "../obsidian/plugin";
import { getFrontMatterInfo } from "../obsidian/util";
import { installFootnoteHover } from "./footnotes/hover";

const manifest = { id: "markdown", name: "Markdown", version: "", minAppVersion: "", author: "", description: "" };

class MarkdownCorePlugin extends Plugin {
  override onload() {
    const app = this.app;
    this.registerView("markdown", (leaf) => new MarkdownView(leaf));
    this.registerExtensions(["md"], "markdown");
    // Footnote refs preview their definition on hover (Live Preview and Reading view).
    installFootnoteHover(this);
    app.embedRegistry.registerExtension("md", (ctx: never, file: never, subpath: string) => new MarkdownEmbed(ctx, file, subpath));
    this.register(() => app.embedRegistry.unregisterExtension("md"));

    const activeMarkdown = (): MarkdownView | null => app.workspace.getActiveViewOfType(MarkdownView);
    const whenMarkdown = (id: string, name: string, run: (v: MarkdownView) => unknown, hotkeys?: { modifiers: string[]; key: string }[], sourceOnly = false) =>
      this.addCommand({
        id,
        name,
        hotkeys: hotkeys as never,
        checkCallback: (checking) => {
          const v = activeMarkdown();
          if (!v || (sourceOnly && v.getMode() !== "source")) return false;
          if (!checking) void run(v);
          return true;
        },
      });

    // Editor commands implemented by the editor module, with Obsidian's ids and default hotkeys.
    for (const spec of EDITOR_COMMANDS) {
      this.addCommand({ id: spec.id, name: spec.name, icon: spec.icon, hotkeys: spec.hotkeys as never, editorCallback: (editor) => spec.editorCallback(editor as never) });
    }

    whenMarkdown("markdown:toggle-preview", "Toggle reading view", (v) => v.toggleMode(), [{ modifiers: ["Mod"], key: "E" }]);
    whenMarkdown("editor:toggle-source", "Toggle Live Preview/Source mode", (v) => v.toggleSource(), undefined, true);
    whenMarkdown("editor:save-file", "Save current file", (v) => v.save(), [{ modifiers: ["Mod"], key: "S" }]);
    whenMarkdown("editor:open-search", "Search current file", (v) => v.showSearch(false), [{ modifiers: ["Mod"], key: "F" }]);
    whenMarkdown("editor:open-search-replace", "Search & replace in current file", (v) => v.showSearch(true), [
      { modifiers: ["Mod"], key: "H" },
      { modifiers: ["Mod", "Alt"], key: "F" },
    ]);
    whenMarkdown("editor:focus", "Focus on editor", (v) => {
      if (v.getMode() !== "source") v.setMode("source");
      v.editor.focus();
    });
    whenMarkdown("editor:open-link-in-new-split", "Open link under cursor to the right", (v) => followLink(app, v, "split"), [{ modifiers: ["Mod", "Alt"], key: "Enter" }], true);
    whenMarkdown("editor:open-link-in-new-window", "Open link under cursor in new window", (v) => followLink(app, v, "window"), [{ modifiers: ["Mod", "Alt", "Shift"], key: "Enter" }], true);
    whenMarkdown("editor:insert-tag", "Add tag", (v) => {
      v.editor.replaceSelection("#");
    }, undefined, true);
    whenMarkdown("editor:attach-file", "Attach file", (v) => attachFile(app, v), undefined, true);
    this.addCommand({
      id: "editor:toggle-line-numbers",
      name: "Toggle line numbers",
      callback: () => app.vault.setConfig("showLineNumber", !app.vault.getConfig("showLineNumber")),
    });
    this.addCommand({
      id: "editor:toggle-readable-line-length",
      name: "Toggle readable line length",
      callback: () => app.vault.setConfig("readableLineLength", !app.vault.getConfig("readableLineLength")),
    });
    this.addCommand({
      id: "editor:toggle-spellcheck",
      name: "Toggle spellcheck",
      callback: () => app.vault.setConfig("spellcheck", !app.vault.getConfig("spellcheck")),
    });
    whenMarkdown("markdown:add-metadata-property", "Add file property", (v) => addProperty(app, v, ""), [{ modifiers: ["Mod"], key: ";" }]);
    whenMarkdown("markdown:add-alias", "Add alias", (v) => addProperty(app, v, "aliases"));
    whenMarkdown("markdown:clear-metadata-properties", "Clear file properties", (v) => {
      const info = getFrontMatterInfo(v.data);
      if (info.exists) {
        v.setViewData(v.data.slice(info.contentStart), false);
        v.requestSave();
      }
    });
    whenMarkdown("editor:toggle-fold-properties", "Toggle fold properties in current file", (v) => {
      const el = v.containerEl.querySelector(".metadata-container");
      el?.toggleClass("is-collapsed", !el.hasClass("is-collapsed"));
    });
  }
}

function followLink(app: any, view: MarkdownView, target: "split" | "window") {
  const token = (view.editor as unknown as { getClickableTokenAt?: (p: unknown) => { type: string; text: string } | null }).getClickableTokenAt?.(view.editor.getCursor());
  if (!token) return;
  if (token.type === "internal-link") void app.workspace.openLinkText(token.text, view.file?.path ?? "", target);
  else if (token.type === "external-link") window.open(token.text, "_blank", "noopener");
}

function attachFile(app: any, view: MarkdownView) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.addEventListener("change", async () => {
    const links: string[] = [];
    for (const file of Array.from(input.files ?? [])) {
      const path = await app.fileManager.getAvailablePathForAttachment(file.name, view.file?.path ?? "");
      const created = await app.vault.createBinary(path, await file.arrayBuffer());
      links.push(app.fileManager.generateMarkdownLink(created, view.file?.path ?? ""));
    }
    view.editor.replaceSelection(links.join("\n"));
  });
  input.click();
}

/**
 * "Add file property" (Mod+;) and "Add alias": an empty property row with its
 * name focused (or, given a key, that property's value), through the
 * Properties widget — the same path as its "+ Add property" button. Without a
 * widget (Source mode, properties shown as YAML) the YAML is edited directly.
 */
async function addProperty(app: any, view: MarkdownView, key: string) {
  const file = view.file;
  if (!file) return;
  const cm = view.handle.view;
  const widgetShown = () => view.getMode() === "source" && view.handle.isLivePreview() && app.vault.getConfig("propertiesInDocument") !== "hidden" && app.vault.getConfig("propertiesInDocument") !== "source";
  if (view.getMode() === "preview") view.setMode("source");
  const text = cm.state.doc.toString();
  const info = getFrontMatterInfo(text);
  if (!widgetShown()) {
    if (app.vault.getConfig("propertiesInDocument") === "hidden" && view.handle.isLivePreview()) {
      await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
        if (key && !(key in fm)) fm[key] = key === "aliases" ? [] : "";
      });
      return;
    }
    // YAML in the editor: add `key: ` (or an empty line) inside the fences and put the cursor there.
    const insertKey = key ? `${key}: ` : "";
    if (info.exists) {
      const at = info.to;
      const needsNl = at > info.from && text[at - 1] !== "\n";
      const insert = (needsNl ? "\n" : "") + insertKey + "\n";
      cm.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length - 1 }, userEvent: "input" });
    } else {
      const insert = `---\n${insertKey}\n---\n`;
      cm.dispatch({ changes: { from: 0, insert }, selection: { anchor: 4 + insertKey.length }, userEvent: "input" });
    }
    view.editor.focus();
    return;
  }
  if (!info.exists) cm.dispatch({ changes: { from: 0, insert: "---\n---\n" }, userEvent: "input.properties" });
  // The widget renders from the editor's update listener; wait a frame for it.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const container = view.handle.metadataEl as HTMLElement & { __metadataEditor?: { addProperty(key?: string): void } };
  const editor = container.__metadataEditor;
  if (editor) editor.addProperty(key || undefined);
  else container.querySelector<HTMLElement>(".metadata-add-button")?.click();
}

export const markdownCore: CorePluginDefinition = {
  id: "markdown",
  name: "Markdown",
  description: "Notes, the editor and reading view.",
  defaultOn: true,
  hidden: true,
  create: (app) => new MarkdownCorePlugin(app, manifest),
};
