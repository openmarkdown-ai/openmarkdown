/**
 * Note composer — merge two notes, or split part of one into a new note.
 *
 * `.obsidian/note-composer.json`: `{ askBeforeMerging, replacementText, template }`
 * with `replacementText` one of `"link" | "embed" | "none"`.
 *
 * Merging moves every link that pointed at the merged-away note onto the
 * destination (the same edits a rename would make), merges properties, and
 * deletes the source. Extracting rewrites the links inside the moved text
 * that would resolve differently from the new note's folder.
 */
import type { Editor } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { getEngine } from "@vault/engine";
import { Plugin } from "../../obsidian/plugin";
import { ConfirmationModal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { SuggestModal } from "../../obsidian/ui/suggest";
import { isMacPlatform } from "../../obsidian/ui/keymap";
import { moment, normalizePath, parseLinktext, prepareFuzzySearch, renderResults } from "../../obsidian/util";
import { applyEdits } from "../../obsidian/vault/file-manager";
import { TFile } from "../../obsidian/vault/files";
import { FileSuggest, resolveTemplateFile } from "../templates/input-suggest";
import { mergeIntoText, processTemplateVariables, splitFrontmatter } from "../templates/template-vars";

export interface NoteComposerOptions {
  askBeforeMerging: boolean;
  replacementText: "link" | "embed" | "none";
  template: string;
}

const DEFAULTS: NoteComposerOptions = { askBeforeMerging: true, replacementText: "link", template: "" };

type Placement = "append" | "prepend";
interface Edit {
  start: number;
  end: number;
  text: string;
}

export class NoteComposerPlugin extends Plugin {
  instance!: any;

  get options(): NoteComposerOptions {
    return this.instance.options as NoteComposerOptions;
  }

  override async onload() {
    this.instance.mergeFile = (source: TFile, dest: TFile, placement?: Placement) => this.mergeFile(source, dest, placement ?? "append");
    this.instance.openMergeModal = (file: TFile) => this.openMerge(file);

    this.addCommand({
      id: "note-composer:merge-file",
      name: "Merge current file with another file...",
      icon: "lucide-git-merge",
      checkCallback: (checking: boolean) => {
        const file = this.activeMarkdownFile();
        if (!file) return false;
        if (!checking) this.openMerge(file);
        return true;
      },
    });
    this.addCommand({
      id: "note-composer:split-file",
      name: "Extract current selection...",
      icon: "lucide-scissors",
      editorCheckCallback: (checking: boolean, editor: Editor, info: any) => {
        const file: TFile | null = info?.file ?? null;
        if (!file || !editor.somethingSelected()) return false;
        if (!checking) this.openExtractSelection(editor, file);
        return true;
      },
    });
    this.addCommand({
      id: "note-composer:extract-heading",
      name: "Extract this heading...",
      icon: "lucide-scissors",
      editorCheckCallback: (checking: boolean, editor: Editor, info: any) => {
        const file: TFile | null = info?.file ?? null;
        if (!file || !headingAt(editor, editor.getCursor().line)) return false;
        if (!checking) this.openExtractHeading(editor, file, editor.getCursor().line);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: any, file: any) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item: any) =>
          item
            .setSection("action")
            .setTitle("Merge entire file with...")
            .setIcon("lucide-git-merge")
            .onClick(() => this.openMerge(file)),
        );
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: any, editor: Editor, info: any) => {
        const file: TFile | null = info?.file ?? null;
        if (!file) return;
        if (editor.somethingSelected()) {
          menu.addItem((item: any) =>
            item
              .setSection("selection")
              .setTitle("Extract current selection...")
              .setIcon("lucide-scissors")
              .onClick(() => this.openExtractSelection(editor, file)),
          );
        } else if (headingAt(editor, editor.getCursor().line)) {
          const line = editor.getCursor().line;
          menu.addItem((item: any) =>
            item
              .setSection("action")
              .setTitle("Extract this heading...")
              .setIcon("lucide-scissors")
              .onClick(() => this.openExtractHeading(editor, file, line)),
          );
        }
      }),
    );

    this.addSettingTab(new NoteComposerSettingTab(this.app, this));
  }

  private activeMarkdownFile(): TFile | null {
    const f: TFile | null = this.app.workspace.getActiveFile();
    return f && f.extension === "md" ? f : null;
  }

  // ---- merge ------------------------------------------------------------------

  openMerge(source: TFile) {
    new ComposerSuggestModal(this, source, {
      placeholder: "Select file to merge into...",
      verb: "merge",
      onChoose: async (choice, placement) => {
        let dest = choice.file;
        if (!dest) {
          dest = await this.createTargetFile(choice.create!, source);
          if (!dest) return;
        }
        if (dest === source) return;
        const run = () => void this.mergeFile(source, dest!, placement).catch((e) => new Notice(`Merge failed: ${String((e as Error)?.message ?? e)}`));
        if (!this.options.askBeforeMerging || !choice.file) {
          run();
          return;
        }
        const modal = new ConfirmationModal(this.app);
        modal.setTitle("Merge files");
        modal.contentEl.setText(`Are you sure you want to merge “${source.basename}” into “${dest.basename}”? “${source.basename}” will be deleted.`);
        modal.addCheckbox("Don't ask again", (checked) => {
          this.options.askBeforeMerging = !checked;
          void this.instance.saveOptions();
        });
        modal.addButton((b) => b.setButtonText("Merge").setCta().onClick(run));
        modal.addCancelButton();
        modal.open();
      },
    }).open();
  }

  async mergeFile(source: TFile, dest: TFile, placement: Placement): Promise<void> {
    await this.saveOpenViews([source, dest]);
    // 1. Point every link at the source to the destination, including links
    //    inside the source itself (they travel with its text).
    const edits = this.linkEditsForMerge(source, dest);
    for (const [path, list] of edits) {
      const f = this.app.vault.getFileByPath(path);
      if (f && list.length) await this.app.vault.process(f, (text: string) => applyEdits(text, list));
    }
    // 2. Merge the (rewritten) source into the destination.
    const sourceText = await this.app.vault.read(source);
    const { properties, body } = splitFrontmatter(sourceText);
    const content = await this.applyTemplate(body, source.basename, dest.basename);
    await this.app.vault.process(dest, (destText: string) => {
      const merged = placement === "prepend" ? prependBody(destText, content) : appendBody(destText, content);
      return mergeIntoText(merged, properties);
    });
    // 3. Remove the source.
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view?.file === source) await leaf.openFile(dest);
    }
    await this.app.fileManager.trashFile(source);
    new Notice(`Merged “${source.basename}” into “${dest.basename}”.`);
  }

  /** Edits that a rename of `source` to `dest` would make, by file path. */
  private linkEditsForMerge(source: TFile, dest: TFile): Map<string, Edit[]> {
    const byPath = new Map<string, Edit[]>();
    try {
      const index = this.app.metadataCache.index;
      const result = index.renameEdits(source.path, dest.path, {
        format: this.app.vault.getConfig("newLinkFormat"),
        useMarkdownLinks: this.app.vault.getConfig("useMarkdownLinks"),
      }) as { path: string; edits: Edit[] }[];
      for (const r of result) byPath.set(r.path, r.edits);
      return byPath;
    } catch {
      /* fall through to the metadata-cache rewrite */
    }
    const resolved = this.app.metadataCache.resolvedLinks as Record<string, Record<string, number>>;
    for (const [from, targets] of Object.entries(resolved)) {
      if (!targets[source.path]) continue;
      const file = this.app.vault.getFileByPath(from);
      const cache = file ? this.app.metadataCache.getFileCache(file) : null;
      if (!file || !cache) continue;
      const list: Edit[] = [];
      for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
        const { path, subpath } = parseLinktext(ref.link);
        if (this.app.metadataCache.getFirstLinkpathDest(path, from) !== source) continue;
        const alias = ref.displayText && ref.displayText !== ref.link ? ref.displayText : undefined;
        let text: string = this.app.fileManager.generateMarkdownLink(dest, from, subpath || undefined, isMarkdownLink(ref.original) ? (ref.displayText ?? undefined) : alias);
        const embed = ref.original.startsWith("!");
        if (embed && !text.startsWith("!")) text = "!" + text;
        if (!embed && text.startsWith("!")) text = text.slice(1);
        list.push({ start: ref.position.start.offset, end: ref.position.end.offset, text });
      }
      if (list.length) byPath.set(from, list);
    }
    return byPath;
  }

  // ---- extract ----------------------------------------------------------------

  openExtractSelection(editor: Editor, source: TFile) {
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const text = editor.getRange(from, to);
    new ComposerSuggestModal(this, source, {
      placeholder: "Select file to move the selection to, or type a new name...",
      verb: "extract",
      onChoose: (choice, placement) => void this.extract(editor, source, { from, to }, text, choice, placement),
    }).open();
  }

  openExtractHeading(editor: Editor, source: TFile, line: number) {
    const heading = headingAt(editor, line);
    if (!heading) return;
    let endLine = editor.lineCount();
    let inFence = false;
    for (let l = line + 1; l < editor.lineCount(); l++) {
      const s = editor.getLine(l);
      if (/^\s*(```|~~~)/.test(s)) inFence = !inFence;
      if (inFence) continue;
      const h = /^(#{1,6})\s/.exec(s);
      if (h && h[1]!.length <= heading.level) {
        endLine = l;
        break;
      }
    }
    const from = { line, ch: 0 };
    const to = endLine >= editor.lineCount() ? { line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length } : { line: endLine, ch: 0 };
    const bodyFrom = line + 1 >= editor.lineCount() ? to : { line: line + 1, ch: 0 };
    const body = editor.getRange(bodyFrom, to).replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "") + "\n";
    const modal = new ComposerSuggestModal(this, source, {
      placeholder: "Select file to move the heading to, or type a new name...",
      verb: "extract",
      onChoose: (choice, placement) => void this.extract(editor, source, { from, to }, body, choice, placement, endLine < editor.lineCount()),
    });
    modal.open();
    modal.inputEl.value = sanitizeFileName(heading.text);
    modal.inputEl.select();
    modal.onInput();
  }

  private async extract(
    editor: Editor,
    source: TFile,
    range: { from: { line: number; ch: number }; to: { line: number; ch: number } },
    text: string,
    choice: Choice,
    placement: Placement,
    keepTrailingBreak = false,
  ) {
    try {
      let dest = choice.file;
      const created = !dest;
      if (!dest) {
        dest = await this.createTargetFile(choice.create!, source);
        if (!dest) return;
      }
      const moved = this.rewriteLinksForNewLocation(text, source.path, dest.path);
      const content = await this.applyTemplate(moved, source.basename, dest.basename);
      await this.app.vault.process(dest, (destText: string) => {
        if (created && !destText) return content;
        return placement === "prepend" ? prependBody(destText, content) : appendBody(destText, content);
      });
      let replacement = "";
      if (this.options.replacementText !== "none") {
        let link: string = this.app.fileManager.generateMarkdownLink(dest, source.path);
        if (this.options.replacementText === "embed" && !link.startsWith("!")) link = "!" + link;
        replacement = link + (keepTrailingBreak ? "\n\n" : "");
      }
      editor.replaceRange(replacement, range.from, range.to);
      new Notice(`Moved to “${dest.basename}”.`);
    } catch (e) {
      new Notice(`Extract failed: ${String((e as Error)?.message ?? e)}`);
    }
  }

  /** Links in moved text that would resolve differently from the new note's path. */
  rewriteLinksForNewLocation(text: string, fromPath: string, toPath: string): string {
    if (parentOf(fromPath) === parentOf(toPath)) return text;
    let meta: any;
    try {
      meta = getEngine().parse(text);
    } catch {
      return text;
    }
    const edits: Edit[] = [];
    for (const ref of [...(meta.links ?? []), ...(meta.embeds ?? [])]) {
      const { path, subpath } = parseLinktext(ref.link);
      if (!path) continue;
      const target: TFile | null = this.app.metadataCache.getFirstLinkpathDest(path, fromPath);
      if (!target) continue;
      if (this.app.metadataCache.getFirstLinkpathDest(path, toPath) === target) continue;
      const markdown = isMarkdownLink(ref.original);
      const alias = markdown ? ref.displayText : ref.displayText && ref.displayText !== ref.link ? ref.displayText : undefined;
      let link: string = this.app.fileManager.generateMarkdownLink(target, toPath, subpath || undefined, alias);
      const embed = String(ref.original).startsWith("!");
      if (embed && !link.startsWith("!")) link = "!" + link;
      if (!embed && link.startsWith("!")) link = link.slice(1);
      edits.push({ start: ref.position.start.offset, end: ref.position.end.offset, text: link });
    }
    return edits.length ? applyEdits(text, edits) : text;
  }

  // ---- shared -----------------------------------------------------------------

  private async createTargetFile(name: string, source: TFile): Promise<TFile | null> {
    const clean = name.trim().replace(/\.md$/, "");
    if (!clean) return null;
    try {
      let path: string;
      if (clean.includes("/")) {
        path = normalizePath(`${clean}.md`);
        const dir = path.slice(0, path.lastIndexOf("/"));
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
      } else {
        const folder = this.app.fileManager.getNewFileParent(source.path);
        path = normalizePath(folder.isRoot() ? `${clean}.md` : `${folder.path}/${clean}.md`);
      }
      const existing = this.app.vault.getFileByPath(path);
      if (existing) return existing;
      return await this.app.vault.create(path, "");
    } catch (e) {
      new Notice(String((e as Error)?.message ?? e));
      return null;
    }
  }

  private async applyTemplate(content: string, fromTitle: string, newTitle: string): Promise<string> {
    const path = (this.options.template || "").trim();
    if (!path) return content;
    const file = resolveTemplateFile(this.app, path);
    if (!file) {
      new Notice(`Failed to find the template file “${path}”.`);
      return content;
    }
    const raw = await this.app.vault.read(file);
    const templates = this.app.internalPlugins.getEnabledPluginById("templates")?.options ?? {};
    const hasContent = /{{\s*content\s*}}/i.test(raw);
    const processed = processTemplateVariables(raw, {
      title: newTitle,
      date: moment(),
      dateFormat: templates.dateFormat || "YYYY-MM-DD",
      timeFormat: templates.timeFormat || "HH:mm",
      extra: { content, fromTitle, newTitle },
    });
    return hasContent ? processed : appendBody(processed, content);
  }

  private async saveOpenViews(files: TFile[]) {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view && files.includes(view.file) && typeof view.save === "function") await view.save();
    }
  }
}

interface Choice {
  file: TFile | null;
  create?: string;
}

class ComposerSuggestModal extends SuggestModal<Choice> {
  constructor(
    private plugin: NoteComposerPlugin,
    private source: TFile,
    private opts: { placeholder: string; verb: "merge" | "extract"; onChoose: (choice: Choice, placement: Placement) => unknown },
  ) {
    super(plugin.app);
    this.setPlaceholder(opts.placeholder);
    const bottom = opts.verb === "merge" ? "to merge" : "to move to bottom";
    const top = opts.verb === "merge" ? "to merge at top" : "to move to top";
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: bottom },
      { command: "shift ↵", purpose: top },
      { command: `${isMacPlatform() ? "cmd" : "ctrl"} ↵`, purpose: "to create new" },
      { command: "esc", purpose: "to dismiss" },
    ]);
    this.scope.register(["Shift"], "Enter", (evt) => {
      if (evt.isComposing) return;
      this.pick(evt, "prepend");
      return false;
    });
    this.scope.register(["Mod"], "Enter", (evt) => {
      if (evt.isComposing) return;
      const name = this.inputEl.value.trim();
      if (!name) return false;
      this.close();
      void this.opts.onChoose({ file: null, create: name }, "append");
      return false;
    });
  }

  private pick(evt: KeyboardEvent | MouseEvent, placement: Placement) {
    const values = this.chooser.values;
    const value = values?.[this.chooser.selectedItem];
    if (!value) return;
    this.close();
    void this.opts.onChoose(value, placement);
  }

  getSuggestions(query: string): Choice[] {
    const files = (this.app as any).vault.getMarkdownFiles().filter((f: TFile) => f !== this.source) as TFile[];
    const q = query.trim();
    let out: Choice[];
    if (!q) {
      const recent = (this.app as any).workspace.getLastOpenFiles?.() ?? [];
      files.sort((a, b) => {
        const ra = recent.indexOf(a.path);
        const rb = recent.indexOf(b.path);
        if (ra !== rb) return (ra === -1 ? 1e9 : ra) - (rb === -1 ? 1e9 : rb);
        return b.stat.mtime - a.stat.mtime;
      });
      out = files.map((file) => ({ file }));
    } else {
      const search = prepareFuzzySearch(q);
      const scored: { file: TFile; score: number }[] = [];
      for (const file of files) {
        const m = search(file.path.replace(/\.md$/, ""));
        if (m) scored.push({ file, score: m.score });
      }
      scored.sort((a, b) => b.score - a.score);
      out = scored.map((s) => ({ file: s.file }));
      const exact = files.some((f) => f.basename.toLowerCase() === q.toLowerCase() || f.path.replace(/\.md$/, "").toLowerCase() === q.toLowerCase());
      if (!exact && q !== this.source.basename) out.push({ file: null, create: q });
    }
    return out;
  }

  renderSuggestion(value: Choice, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createDiv({ cls: "suggestion-content" });
    if (value.file) {
      const title = content.createDiv({ cls: "suggestion-title" });
      const text = value.file.path.replace(/\.md$/, "");
      const q = this.inputEl.value.trim();
      const m = q ? prepareFuzzySearch(q)(text) : null;
      if (m) renderResults(title, text, m);
      else title.setText(text);
    } else {
      content.createDiv({ cls: "suggestion-title", text: value.create ?? "" });
      el.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: "suggestion-flair", text: "Enter to create" });
    }
  }

  onChooseSuggestion(item: Choice, _evt: MouseEvent | KeyboardEvent): void {
    void this.opts.onChoose(item, "append");
  }
}

function headingAt(editor: Editor, line: number): { level: number; text: string } | null {
  if (line < 0 || line >= editor.lineCount()) return null;
  const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(editor.getLine(line));
  if (!m) return null;
  // Not inside a code fence.
  let inFence = false;
  for (let l = 0; l < line; l++) if (/^\s*(```|~~~)/.test(editor.getLine(l))) inFence = !inFence;
  if (inFence) return null;
  return { level: m[1]!.length, text: m[2]! };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function isMarkdownLink(original: string): boolean {
  return /^!?\[[^\]]*\]\(/.test(original);
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function appendBody(destText: string, add: string): string {
  if (!destText.trim()) return destText + add;
  const base = destText.replace(/\s*$/, "");
  return `${base}\n\n${add.replace(/^\s*\n/, "")}`;
}

function prependBody(destText: string, add: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(destText);
  const head = m ? m[0] : "";
  const body = destText.slice(head.length);
  const addition = add.replace(/\s*$/, "");
  return head + (body.trim() ? `${addition}\n\n${body.replace(/^\s*\n/, "")}` : `${addition}\n`);
}

class NoteComposerSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: NoteComposerPlugin,
  ) {
    super(app, owner as any);
    this.id = "note-composer";
    this.name = "Note composer";
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const options = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();

    new Setting(containerEl)
      .setName("Confirm file merge")
      .setDesc("Ask before merging two files.")
      .addToggle((t) =>
        t.setValue(options.askBeforeMerging !== false).onChange((v) => {
          options.askBeforeMerging = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Text after extraction")
      .setDesc("What to leave in place of the extracted text.")
      .addDropdown((dd) =>
        dd
          .addOption("link", "Link to new file")
          .addOption("embed", "Embed new file")
          .addOption("none", "None")
          .setValue(options.replacementText ?? "link")
          .onChange((v) => {
            options.replacementText = v as NoteComposerOptions["replacementText"];
            save();
          }),
      );

    const desc = createFragment((f) => {
      f.appendText("Variables: ");
      for (const [i, v] of ["{{content}}", "{{fromTitle}}", "{{newTitle}}", "{{date:FORMAT}}"].entries()) {
        if (i) f.appendText(", ");
        f.createEl("code", { text: v });
      }
      f.appendText(".");
    });
    new Setting(containerEl)
      .setName("Template file location")
      .setDesc(desc)
      .addSearch((search) => {
        search.setPlaceholder("Example: folder/note").setValue(options.template ?? "");
        new FileSuggest(this.app, search.inputEl);
        search.onChange((v) => {
          options.template = v.trim().replace(/^\/+/, "");
          save();
        });
      });
  }
}

export const noteComposer: CorePluginDefinition = {
  id: "note-composer",
  name: "Note composer",
  description: "Merge two notes or split one note into two.",
  icon: "lucide-git-merge",
  defaultOn: true,
  defaultOptions: { ...DEFAULTS },
  create: (app) =>
    new NoteComposerPlugin(app, { id: "note-composer", name: "Note composer", version: "", minAppVersion: "", author: "", description: "Merge two notes or split one note into two." }),
};
