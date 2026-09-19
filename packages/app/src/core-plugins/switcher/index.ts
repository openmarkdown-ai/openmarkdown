/**
 * Core plugin Quick switcher (`switcher`), `Mod+O`.
 *
 * Lists notes (plus aliases, unresolved link targets and, per the options,
 * attachments and other files). With no query it shows recently opened files.
 * Ranking is the Rust fuzzy matcher (`getEngine().rank`) over each entry's
 * path without `.md`; excluded files sink below the rest.
 *
 *   ↵ open · Mod+↵ new tab · Mod+Alt+↵ to the right · Shift+↵ create with
 *   the typed name · Tab complete the next path segment
 *
 * Options (`.obsidian/switcher.json`): showExistingOnly, showAttachments,
 * showAllFileTypes.
 */
import { getEngine } from "@vault/engine";
import type { SearchResult } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Keymap, isMacPlatform } from "../../obsidian/ui/keymap";
import { Notice } from "../../obsidian/ui/notice";
import { SettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { SuggestModal } from "../../obsidian/ui/suggest";
import { normalizePath, parseFrontMatterAliases } from "../../obsidian/util";
import { TFile, type TFolder } from "../../obsidian/vault/files";
import { customTitle } from "../file-explorer/note-titles";

interface SwitcherOptions {
  showExistingOnly: boolean;
  showAttachments: boolean;
  showAllFileTypes: boolean;
}

const DEFAULTS: SwitcherOptions = { showExistingOnly: false, showAttachments: true, showAllFileTypes: false };

/** Files the app treats as notes rather than attachments. */
const NOTE_EXTENSIONS = new Set(["md", "canvas", "base"]);

type Entry =
  | { type: "file"; file: TFile; text: string; excluded: boolean }
  | { type: "alias"; file: TFile; alias: string; text: string; excluded: boolean }
  | { type: "title"; file: TFile; title: string; text: string; excluded: boolean }
  | { type: "unresolved"; linktext: string; text: string; excluded: false };

interface Suggestion {
  entry: Entry | null; // null: "create a note with the typed name"
  match: SearchResult | null;
}

const LIMIT = 100;

class QuickSwitcherModal extends SuggestModal<Suggestion> {
  constructor(private plugin: SwitcherPlugin) {
    super(plugin.app);
    this.limit = LIMIT;
    this.modalEl.addClass("mod-quick-switcher");
    this.setPlaceholder("Find or create a note...");
    this.emptyStateText = "No notes found.";
    const mod = isMacPlatform() ? "⌘" : "ctrl";
    const alt = isMacPlatform() ? "⌥" : "alt";
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to open" },
      { command: `${mod} ↵`, purpose: "to open in new tab" },
      { command: `${mod} ${alt} ↵`, purpose: "to open to the right" },
      { command: "shift ↵", purpose: "to create" },
      { command: "esc", purpose: "to dismiss" },
    ]);
    const choose = (newLeaf: "tab" | "split") => (evt: KeyboardEvent) => {
      if (evt.isComposing) return;
      const s = this.chooser.values?.[this.chooser.selectedItem];
      if (s) {
        this.close();
        void this.openSuggestion(s, newLeaf);
      }
      return false;
    };
    this.scope.register(["Mod"], "Enter", choose("tab"));
    this.scope.register(["Mod", "Alt"], "Enter", choose("split"));
    this.scope.register(["Shift"], "Enter", (evt) => {
      if (evt.isComposing) return;
      const name = this.inputEl.value.trim();
      if (!name) return false;
      this.close();
      void this.createNote(name, Keymap.isModEvent(evt));
      return false;
    });
    this.scope.register([], "Tab", () => {
      this.completePathSegment();
      return false;
    });
  }

  // ---- data ---------------------------------------------------------------------------

  private entries(): Entry[] {
    const { vault, metadataCache } = this.app as any;
    const opts = this.plugin.options;
    const out: Entry[] = [];
    const ignored = (path: string) => !!metadataCache.isUserIgnored?.(path);
    for (const file of vault.getFiles() as TFile[]) {
      const ext = file.extension.toLowerCase();
      const isNote = NOTE_EXTENSIONS.has(ext);
      if (!isNote) {
        const supported = this.app.viewRegistry.isExtensionRegistered(ext);
        if (!(opts.showAllFileTypes || (opts.showAttachments && supported))) continue;
      }
      const excluded = ignored(file.path);
      out.push({ type: "file", file, text: ext === "md" ? file.path.slice(0, -3) : file.path, excluded });
      if (ext === "md") {
        // A note shown by its title can be found by the title as well as by its path.
        const title = customTitle(this.app, file);
        if (title && title !== file.basename) out.push({ type: "title", file, title, text: title, excluded });
        const aliases = parseFrontMatterAliases(metadataCache.getFileCache(file)?.frontmatter ?? null) ?? [];
        for (const alias of aliases) out.push({ type: "alias", file, alias: String(alias), text: String(alias), excluded });
      }
    }
    if (!opts.showExistingOnly) {
      const seen = new Set<string>();
      for (const links of Object.values<Record<string, number>>(metadataCache.unresolvedLinks ?? {})) {
        for (const link of Object.keys(links)) {
          if (seen.has(link)) continue;
          seen.add(link);
          out.push({ type: "unresolved", linktext: link, text: link, excluded: false });
        }
      }
    }
    return out;
  }

  getSuggestions(query: string): Suggestion[] {
    const q = query.trim();
    if (!q) return this.recentSuggestions();
    const entries = this.entries();
    let ranked: { index: number; result: SearchResult }[];
    try {
      ranked = getEngine().rank(q, entries.map((e) => e.text), entries.length);
    } catch (e) {
      console.error(e);
      ranked = [];
    }
    // One row per note: a title match and a path match of the same file keep the better one.
    const seenTitle = new Set<TFile>();
    const results: Suggestion[] = [];
    for (const r of ranked) {
      const entry = entries[r.index]!;
      if (entry.type === "title" || entry.type === "file") {
        if (seenTitle.has(entry.file)) continue;
        seenTitle.add(entry.file);
      }
      results.push({ entry, match: r.result });
    }
    // Excluded files are deprioritised, not hidden.
    const visible = results.filter((s) => !s.entry?.excluded);
    const excluded = results.filter((s) => s.entry?.excluded);
    return [...visible, ...excluded].slice(0, LIMIT);
  }

  /** Empty query: recently opened files, most recent first (so ↓ ↵ flips back to the previous note). */
  private recentSuggestions(): Suggestion[] {
    const { vault, workspace } = this.app as any;
    const out: Suggestion[] = [];
    const recent: string[] = workspace.getLastOpenFiles?.() ?? [];
    for (const path of recent) {
      const file = vault.getFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const title = customTitle(this.app, file);
      if (title && title !== file.basename) out.push({ entry: { type: "title", file, title, text: title, excluded: false }, match: null });
      else out.push({ entry: { type: "file", file, text: file.extension === "md" ? path.slice(0, -3) : path, excluded: false }, match: null });
    }
    return out;
  }

  override onNoSuggestion(): void {
    const q = this.inputEl.value.trim();
    if (!q) {
      super.onNoSuggestion();
      return;
    }
    this.chooser.setSuggestions([{ entry: null, match: null }]);
  }

  renderSuggestion(s: Suggestion, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createDiv({ cls: "suggestion-content" });
    const titleEl = content.createDiv({ cls: "suggestion-title" });
    const aux = el.createDiv({ cls: "suggestion-aux" });
    const entry = s.entry;
    if (!entry) {
      titleEl.setText(this.inputEl.value.trim());
      content.createDiv({ cls: "suggestion-note", text: "Enter to create" });
      el.addClass("mod-create");
      const flair = aux.createSpan({ cls: "suggestion-flair", attr: { "aria-label": "Create" } });
      setIcon(flair, "lucide-file-plus");
      return;
    }
    if (entry.type === "unresolved") {
      this.renderText(titleEl, entry.text, s.match, 0);
      content.createDiv({ cls: "suggestion-note", text: "Not created yet, select to create" });
      el.addClass("is-unresolved");
      const flair = aux.createSpan({ cls: "suggestion-flair", attr: { "aria-label": "Not created yet" } });
      setIcon(flair, "lucide-file-plus");
      return;
    }
    if (entry.type === "title") {
      this.renderText(titleEl, entry.title, s.match, 0);
      content.createDiv({ cls: "suggestion-note", text: entry.file.path.slice(0, -3) });
      el.addClass("vault-mod-display-title");
    } else if (entry.type === "alias") {
      this.renderText(titleEl, entry.alias, s.match, 0);
      content.createDiv({ cls: "suggestion-note", text: entry.file.path.slice(0, -3) });
      const flair = aux.createSpan({ cls: "suggestion-flair", attr: { "aria-label": "Alias" } });
      setIcon(flair, "lucide-forward");
    } else {
      // Title is the file name; the folder (if any) shows below. Matches are on the full path.
      const file = entry.file;
      const slash = entry.text.lastIndexOf("/");
      const name = entry.text.slice(slash + 1);
      this.renderText(titleEl, name, s.match, slash + 1);
      if (slash > 0) {
        const note = content.createDiv({ cls: "suggestion-note" });
        this.renderText(note, entry.text.slice(0, slash), s.match, 0);
      }
      if (file.extension !== "md") aux.createSpan({ cls: "nav-file-tag", text: file.extension });
    }
    if (entry.excluded) el.addClass("mod-excluded");
  }

  private renderText(el: HTMLElement, text: string, match: SearchResult | null, offset: number) {
    if (!match) {
      el.setText(text);
      return;
    }
    // renderResults shifts match ranges by `offset` so a slice of the ranked text highlights correctly.
    const matches = match.matches.filter(([s, e]) => e > offset && s < offset + text.length);
    let pos = 0;
    for (const [s0, e0] of matches) {
      const s = Math.max(0, s0 - offset);
      const e = Math.min(text.length, e0 - offset);
      if (s > pos) el.appendText(text.slice(pos, s));
      el.createSpan({ cls: "suggestion-highlight", text: text.slice(Math.max(s, pos), e) });
      pos = Math.max(pos, e);
    }
    if (pos < text.length) el.appendText(text.slice(pos));
  }

  onChooseSuggestion(s: Suggestion, evt: MouseEvent | KeyboardEvent): void {
    void this.openSuggestion(s, Keymap.isModEvent(evt));
  }

  private async openSuggestion(s: Suggestion, newLeaf: ReturnType<typeof Keymap.isModEvent>) {
    const entry = s.entry;
    if (!entry) {
      await this.createNote(this.inputEl.value.trim(), newLeaf);
      return;
    }
    const { workspace } = this.app as any;
    if (entry.type === "unresolved") {
      const source = workspace.getActiveFile()?.path ?? "";
      await workspace.openLinkText(entry.linktext, source, newLeaf);
      return;
    }
    const file = entry.file;
    const ext = file.extension.toLowerCase();
    if (!NOTE_EXTENSIONS.has(ext) && !this.app.viewRegistry.isExtensionRegistered(ext)) {
      (this.app as any).openWithDefaultApp(file.path);
      return;
    }
    await workspace.getLeaf(newLeaf).openFile(file, { active: true });
  }

  /** Create a note named exactly as typed (folders in the name are created too). */
  private async createNote(name: string, newLeaf: ReturnType<typeof Keymap.isModEvent>) {
    if (!name) return;
    const app = this.app as any;
    const withExt = /\.[a-z0-9]+$/i.test(name) && NOTE_EXTENSIONS.has(name.split(".").pop()!.toLowerCase()) ? name : `${name}.md`;
    let path: string;
    if (withExt.includes("/")) path = normalizePath(withExt);
    else {
      const parent: TFolder = app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "", withExt);
      path = normalizePath(parent.isRoot() ? withExt : `${parent.path}/${withExt}`);
    }
    try {
      const existing = app.vault.getFileByPath(path);
      let file: TFile = existing;
      if (!existing) {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
        file = await app.vault.create(path, "");
      }
      await app.workspace.getLeaf(newLeaf).openFile(file, { active: true, state: { mode: "source" } });
    } catch (e) {
      new Notice(String((e as Error).message ?? e));
    }
  }

  /** Tab: extend the query to the selected entry's next path segment. */
  private completePathSegment() {
    const s = this.chooser.values?.[this.chooser.selectedItem];
    const text = s?.entry?.type === "file" ? s.entry.text : s?.entry?.type === "alias" || s?.entry?.type === "title" ? s.entry.file.path.slice(0, -3) : null;
    if (!text) return;
    const typed = this.inputEl.value;
    const lowerText = text.toLowerCase();
    let start = lowerText.startsWith(typed.toLowerCase()) ? typed.length : 0;
    const next = text.indexOf("/", start);
    this.inputEl.value = next === -1 ? text : text.slice(0, next + 1);
    start = this.inputEl.value.length;
    this.inputEl.setSelectionRange(start, start);
    this.onInput();
  }
}

class SwitcherSettingTab extends SettingTab {
  constructor(
    app: any,
    private plugin: SwitcherPlugin,
  ) {
    super(app);
    this.id = "switcher";
    this.icon = "lucide-puzzle";
    this.name = "Quick switcher";
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    const opts = this.plugin.options;
    const toggle = (key: keyof SwitcherOptions, name: string, desc: string) =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(opts[key]).onChange((v) => {
            opts[key] = v;
            void this.plugin.instance.saveOptions();
          }),
        );
    toggle("showExistingOnly", "Show existing only", "Whether to hide notes that don't exist yet (unresolved links).");
    toggle("showAttachments", "Show attachments", "Whether to show attachments like images and PDFs.");
    toggle("showAllFileTypes", "Show all file types", "Whether to show all files, including those Obsidian can't open. They open in your default app.");
  }
}

export class SwitcherPlugin extends Plugin {
  instance!: any;

  get options(): SwitcherOptions {
    return Object.assign(this.instance.options, { ...DEFAULTS, ...this.instance.options }) as SwitcherOptions;
  }

  override onload() {
    const open = () => new QuickSwitcherModal(this).open();
    this.instance.QuickSwitcherModal = QuickSwitcherModal;
    this.instance.openQuickSwitcher = open;
    this.register(() => {
      delete this.instance.QuickSwitcherModal;
      delete this.instance.openQuickSwitcher;
    });
    this.addCommand({
      id: "switcher:open",
      name: "Quick switcher: Open quick switcher",
      icon: "lucide-navigation",
      hotkeys: [{ modifiers: ["Mod"], key: "o" }],
      callback: open,
    });
    this.addRibbonIcon("lucide-navigation", "Open quick switcher", open);
    if (this.app.setting?.addSettingTab) this.addSettingTab(new SwitcherSettingTab(this.app, this));
  }
}

export const switcher: CorePluginDefinition = {
  id: "switcher",
  name: "Quick switcher",
  description: "Jump to other files with your keyboard.",
  icon: "lucide-navigation",
  defaultOn: true,
  defaultOptions: { ...DEFAULTS },
  create: (app) => new SwitcherPlugin(app, { id: "switcher", name: "Quick switcher", version: "", minAppVersion: "", author: "", description: "" }),
};
