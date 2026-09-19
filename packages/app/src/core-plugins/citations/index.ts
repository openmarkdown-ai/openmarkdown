/**
 * Citations — Pandoc citations (`[@citekey]`) from a BibTeX / CSL-JSON file in
 * the vault, a Better BibTeX JSON export, or the Zotero web API.
 *
 * Keeps the formats of the desktop-only Citations and Zotero Integration
 * plugins: the same settings keys as `obsidian-citation-plugin`, its template
 * variables, `@{{citekey}}` literature notes and `[@citekey]` citations. Steps
 * aside while either of those plugins is enabled.
 *
 * - `[@` in the editor suggests entries; hovering a citekey shows the reference.
 * - Reading view formats citations with the chosen CSL style and adds a
 *   bibliography at the end; exports (PDF, Word, EPUB, rich copy) call
 *   `instance.renderBibliography` for the same.
 */
import { hoverTooltip, type Tooltip } from "@codemirror/view";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { SecretComponent, Setting } from "../../obsidian/ui/setting";
import { EditorSuggest, SuggestModal } from "../../obsidian/ui/suggest";
import { debounce, normalizePath, prepareFuzzySearch, sanitizeHTMLToDom } from "../../obsidian/util";
import { TFile } from "../../obsidian/vault/files";
import { BUNDLED_STYLES, Formatter, htmlToMarkdown } from "./cite";
import { citedKeys, findCitations, loadZotero, parseBibliography, renderTemplate, templateVariables, toEntry, type Entry } from "./library";

export interface CitationsOptions {
  // obsidian-citation-plugin's keys
  citationExportPath: string;
  citationExportFormat: "csl-json" | "biblatex";
  literatureNoteTitleTemplate: string;
  literatureNoteFolder: string;
  literatureNoteContentTemplate: string;
  markdownCitationTemplate: string;
  alternativeMarkdownCitationTemplate: string;
  // ours
  cslStyle: string;
  renderInReading: boolean;
  showBibliography: boolean;
  bibliographyHeading: string;
  zoteroUserId: string;
  zoteroLibraryType: "users" | "groups";
  /** Id of a secret in Settings → Keychain holding the Zotero API key. */
  zoteroApiKeySecret: string;
}

export const DEFAULT_CITATIONS_OPTIONS: CitationsOptions = {
  citationExportPath: "",
  citationExportFormat: "csl-json",
  literatureNoteTitleTemplate: "@{{citekey}}",
  literatureNoteFolder: "Reading notes",
  literatureNoteContentTemplate: "---\ntitle: {{title}}\nauthors: {{authorString}}\n{{#if year}}year: {{year}}\n{{/if}}---\n\n",
  markdownCitationTemplate: "[@{{citekey}}]",
  alternativeMarkdownCitationTemplate: "@{{citekey}}",
  cslStyle: "apa",
  renderInReading: true,
  showBibliography: true,
  bibliographyHeading: "References",
  zoteroUserId: "",
  zoteroLibraryType: "users",
  zoteroApiKeySecret: "",
};

/** Community plugins this one replaces; while enabled, it steps aside. */
export const REPLACED_PLUGINS = ["obsidian-citation-plugin", "obsidian-zotero-desktop-connector"];

export class CitationsPlugin extends Plugin {
  instance!: any;
  entries = new Map<string, Entry>();
  loadError = "";
  private formatter: Formatter | null = null;
  private formatterStyle = "";
  private loading: Promise<void> | null = null;
  private popover: HTMLElement | null = null;

  get options(): CitationsOptions {
    const o = this.instance.options as Partial<CitationsOptions>;
    for (const [k, v] of Object.entries(DEFAULT_CITATIONS_OPTIONS)) if (!(k in o)) (o as Record<string, unknown>)[k] = v;
    return o as CitationsOptions;
  }

  stepAside(): boolean {
    const enabled: Set<string> | undefined = this.app.plugins?.enabledPlugins;
    return !!enabled && REPLACED_PLUGINS.some((id) => enabled.has(id));
  }

  override onload() {
    const reload = debounce(() => void this.reload(), 400, true);
    this.registerEvent(
      this.app.vault.on("modify", (f: TFile) => {
        if (f.path === normalizePath(this.options.citationExportPath)) reload();
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (f: TFile) => {
        if (f.path === normalizePath(this.options.citationExportPath)) reload();
      }),
    );
    this.app.workspace.onLayoutReady(() => void this.reload());

    const cmd = (id: string, name: string, run: () => void, needsEditor = false) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking: boolean) => {
          if (this.stepAside()) return false;
          if (needsEditor && !this.app.workspace.activeEditor?.editor) return false;
          if (!checking) run();
          return true;
        },
      });
    cmd("citations:open-literature-note", "Open literature note", () => this.pick("Open literature note", (e) => void this.openLiteratureNote(e)));
    cmd("citations:insert-citation", "Insert Markdown citation", () => this.pick("Insert citation", (e) => this.insert(renderTemplate(this.options.markdownCitationTemplate, templateVariables(e)))), true);
    cmd("citations:insert-link", "Insert literature note link", () => this.pick("Insert literature note link", (e) => this.insert(`[[${this.noteTitle(e)}]]`)), true);
    cmd("citations:insert-content", "Insert literature note content in the current pane", () => this.pick("Insert literature note content", (e) => this.insert(renderTemplate(this.options.literatureNoteContentTemplate, templateVariables(e)))), true);
    cmd("citations:insert-bibliography", "Insert bibliography", () => void this.insertBibliography(), true);
    cmd("citations:update-bib-data", "Refresh citation database", () => void this.reload(true));

    this.registerEditorSuggest(new CitekeySuggest(this.app, this));
    this.registerEditorExtension(
      hoverTooltip((view, pos): Tooltip | null => {
        if (this.stepAside() || !this.entries.size) return null;
        const line = view.state.doc.lineAt(pos);
        const text = line.text;
        const col = pos - line.from;
        for (const c of findCitations(text, (k) => this.entries.has(k))) {
          if (col < c.start || col > c.end) continue;
          const keys = c.items.map((i) => i.key).filter((k) => this.entries.has(k));
          if (!keys.length) return null;
          return {
            pos: line.from + c.start,
            end: line.from + c.end,
            above: true,
            create: () => {
              const dom = createDiv({ cls: "vault-citation-popover" });
              void this.fillPopover(dom, keys);
              return { dom };
            },
          };
        }
        return null;
      }),
    );
    this.registerMarkdownPostProcessor((el: HTMLElement, ctx: any) => this.postProcess(el, ctx));
    if (this.app.setting?.addSettingTab) this.addSettingTab(new CitationsSettingTab(this.app, this));

    this.register(() => this.hidePopover());
    // internal (used by export and tests)
    this.instance.renderBibliography = (container: HTMLElement, markdown: string, sourcePath: string) => this.renderBibliography(container, markdown, sourcePath);
    this.instance.getEntries = () => [...this.entries.values()];
    this.instance.reload = () => this.reload(true);
    this.instance.formatCitation = async (text: string) => {
      await this.ready();
      const f = await this.getFormatter();
      return findCitations(text, (k) => this.entries.has(k)).map((c) => f.cluster(c.items, c.narrative));
    };
  }

  // ---- library ----------------------------------------------------------------------

  async ready(): Promise<void> {
    if (this.loading) await this.loading;
  }

  async reload(announce = false): Promise<void> {
    const run = async () => {
      const o = this.options;
      const next = new Map<string, Entry>();
      const errors: string[] = [];
      const path = normalizePath(o.citationExportPath || "");
      if (path) {
        try {
          const file = this.app.vault.getFileByPath(path);
          const text: string = file ? await this.app.vault.cachedRead(file) : await this.app.vault.adapter.read(path);
          for (const item of await parseBibliography(text, path)) next.set(String(item.id), toEntry(item));
        } catch (e) {
          errors.push(`Bibliography file: ${(e as Error)?.message ?? e}`);
        }
      }
      if (o.zoteroUserId) {
        try {
          const apiKey = o.zoteroApiKeySecret ? (this.app.secretStorage?.getSecret(o.zoteroApiKeySecret) ?? "") : "";
          for (const e of await loadZotero({ userId: o.zoteroUserId, apiKey, libraryType: o.zoteroLibraryType })) if (!next.has(e.citekey)) next.set(e.citekey, e);
        } catch (e) {
          errors.push(`Zotero: ${(e as Error)?.message ?? e}`);
        }
      }
      this.entries = next;
      this.loadError = errors.join("\n");
      this.formatter = null;
      if (announce) new Notice(errors.length ? `Citations: ${errors.join("; ")}` : `Loaded ${next.size} references.`);
    };
    this.loading = run();
    await this.loading;
  }

  private async getFormatter(): Promise<Formatter> {
    const style = this.options.cslStyle || "apa";
    if (!this.formatter || this.formatterStyle !== style) {
      this.formatter = await Formatter.create(this.app, style, (id) => this.entries.get(id)?.csl);
      this.formatterStyle = style;
    }
    return this.formatter;
  }

  noteTitle(e: Entry): string {
    return renderTemplate(this.options.literatureNoteTitleTemplate, templateVariables(e)).replace(/[\\/:*?"<>|#^[\]]/g, "_").trim() || e.citekey;
  }

  // ---- commands -----------------------------------------------------------------------

  private pick(placeholder: string, onChoose: (e: Entry) => void) {
    void this.ready().then(() => {
      if (!this.entries.size) {
        new Notice(this.options.citationExportPath || this.options.zoteroUserId ? "No references loaded. Check Settings → Citations." : "Choose a bibliography file in Settings → Citations first.");
        return;
      }
      new EntryModal(this.app, this, placeholder, onChoose).open();
    });
  }

  private insert(text: string) {
    const editor = this.app.workspace.activeEditor?.editor;
    editor?.replaceSelection(text);
  }

  async openLiteratureNote(e: Entry) {
    const folder = normalizePath(this.options.literatureNoteFolder || "");
    const path = normalizePath(`${folder ? folder + "/" : ""}${this.noteTitle(e)}.md`);
    let file = this.app.vault.getFileByPath(path);
    if (!file) {
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
      file = await this.app.vault.create(path, renderTemplate(this.options.literatureNoteContentTemplate, templateVariables(e)));
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async insertBibliography() {
    const view = this.app.workspace.activeEditor;
    const editor = view?.editor;
    if (!editor) return;
    await this.ready();
    const keys = citedKeys(editor.getValue(), (k) => this.entries.has(k)).filter((k) => this.entries.has(k));
    if (!keys.length) {
      new Notice("This note cites nothing from the bibliography.");
      return;
    }
    const f = await this.getFormatter();
    const md = f.bibliography(keys).map(htmlToMarkdown).join("\n\n");
    editor.replaceSelection(`${this.options.bibliographyHeading ? `## ${this.options.bibliographyHeading}\n\n` : ""}${md}\n`);
  }

  // ---- rendering ------------------------------------------------------------------------

  private async postProcess(el: HTMLElement, ctx: any) {
    if (this.stepAside() || !this.options.renderInReading) return;
    if (!el.textContent?.includes("@")) {
      this.scheduleBibliography(el, ctx);
      return;
    }
    await this.ready();
    if (!this.entries.size) return;
    const f = await this.getFormatter();
    this.replaceCitations(el, f);
    this.scheduleBibliography(el, ctx);
  }

  private replaceCitations(root: HTMLElement, f: Formatter) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest("code, pre, a, .math, .vault-citation, .vault-bibliography, mjx-container") ? NodeFilter.FILTER_REJECT : n.textContent?.includes("@") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const text = node.textContent ?? "";
      const clusters = findCitations(text, (k) => this.entries.has(k));
      if (!clusters.length) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const c of clusters) {
        const known = c.items.every((i) => this.entries.has(i.key));
        if (!known && c.narrative) continue;
        frag.appendChild(document.createTextNode(text.slice(last, c.start)));
        const span = createSpan({ cls: "vault-citation", attr: { "data-citekeys": c.items.map((i) => i.key).join(" "), "data-source": text.slice(c.start, c.end) } });
        if (known) {
          try {
            span.appendChild(sanitizeHTMLToDom(f.cluster(c.items, c.narrative)));
          } catch {
            span.setText(text.slice(c.start, c.end));
          }
        } else {
          span.addClass("is-unresolved");
          span.setText(text.slice(c.start, c.end));
          span.setAttr("aria-label", `Not in the bibliography: ${c.items.filter((i) => !this.entries.has(i.key)).map((i) => i.key).join(", ")}`);
        }
        span.addEventListener("mouseenter", () => this.showPopover(span, c.items.map((i) => i.key).filter((k) => this.entries.has(k))));
        span.addEventListener("mouseleave", () => this.hidePopover());
        frag.appendChild(span);
        last = c.end;
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.replaceWith(frag);
    }
  }

  private pendingBib = new Map<string, number>();

  /** Reading view: keep one bibliography at the end of the rendered note. */
  private scheduleBibliography(el: HTMLElement, ctx: any) {
    if (!this.options.showBibliography) return;
    const docId: string = ctx?.docId ?? "";
    const info = ctx?.getSectionInfo?.(el);
    const sizer = el.parentElement;
    if (!docId || !info || !sizer?.isConnected || !sizer.closest(".markdown-preview-sizer")) return;
    if (typeof ctx.remainingNestLevel === "number" && ctx.remainingNestLevel < 4) return; // not inside embeds
    window.clearTimeout(this.pendingBib.get(docId));
    this.pendingBib.set(
      docId,
      window.setTimeout(() => {
        this.pendingBib.delete(docId);
        if (!sizer.isConnected) return;
        void this.renderBibliography(sizer, info.text, ctx.sourcePath, true);
      }, 50),
    );
  }

  /**
   * Append (or refresh) `div.vault-bibliography` for the citations in
   * `markdown`. In reading view it lives inside the last section so section
   * re-rendering keeps it; in exports it is appended before the footnotes.
   */
  async renderBibliography(container: HTMLElement, markdown: string, _sourcePath: string, readingView = false): Promise<void> {
    if (this.stepAside()) return;
    await this.ready();
    const existing = container.querySelector<HTMLElement>(".vault-bibliography");
    const keys = citedKeys(markdown, (k) => this.entries.has(k)).filter((k) => this.entries.has(k));
    if (!keys.length || !this.options.showBibliography) {
      existing?.remove();
      return;
    }
    const f = await this.getFormatter();
    if (!readingView) this.replaceCitations(container, f);
    const bib = createDiv({ cls: "vault-bibliography references csl-bib-body", attr: { role: "doc-bibliography" } });
    if (this.options.bibliographyHeading) bib.createEl("h2", { cls: "vault-bibliography-heading", text: this.options.bibliographyHeading, attr: { "data-heading": this.options.bibliographyHeading } });
    for (const html of f.bibliography(keys)) bib.appendChild(sanitizeHTMLToDom(html));
    existing?.remove();
    if (readingView) {
      const sections = Array.from(container.children).filter((c) => !c.classList.contains("mod-header") && !c.classList.contains("mod-footer") && !c.querySelector(":scope > section.footnotes"));
      const host = (sections[sections.length - 1] as HTMLElement | undefined) ?? container;
      host.appendChild(bib);
    } else {
      const footnotes = container.querySelector(":scope > section.footnotes, :scope > .footnotes");
      container.insertBefore(bib, footnotes ?? null);
    }
  }

  async fillPopover(dom: HTMLElement, keys: string[]) {
    const f = await this.getFormatter();
    dom.empty();
    for (const key of keys) {
      const e = this.entries.get(key);
      if (!e) continue;
      const item = dom.createDiv({ cls: "vault-citation-popover-item" });
      item.createDiv({ cls: "vault-citation-popover-key", text: `@${key}` });
      item.createDiv({ cls: "vault-citation-popover-ref" }).appendChild(sanitizeHTMLToDom(f.reference(key)));
      const abstract = e.csl.abstract;
      if (typeof abstract === "string" && abstract) item.createDiv({ cls: "vault-citation-popover-abstract", text: abstract.length > 280 ? `${abstract.slice(0, 280)}…` : abstract });
    }
  }

  private showPopover(target: HTMLElement, keys: string[]) {
    if (!keys.length) return;
    this.hidePopover();
    const pop = document.body.createDiv({ cls: "vault-citation-popover" });
    this.popover = pop;
    const rect = target.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 420))}px`;
    pop.style.top = `${rect.bottom + 6}px`;
    void this.fillPopover(pop, keys).then(() => {
      const h = pop.getBoundingClientRect().height;
      if (rect.bottom + 6 + h > window.innerHeight && rect.top - h - 6 > 0) pop.style.top = `${rect.top - h - 6}px`;
    });
  }

  private hidePopover() {
    this.popover?.remove();
    this.popover = null;
  }
}

// ---- UI -------------------------------------------------------------------------------

function renderEntry(e: Entry, el: HTMLElement) {
  el.addClass("mod-complex", "vault-citation-suggestion");
  const content = el.createDiv({ cls: "suggestion-content" });
  content.createDiv({ cls: "suggestion-title", text: e.title || e.citekey });
  content.createDiv({ cls: "suggestion-note", text: [e.authorString, e.year, e.containerTitle].filter(Boolean).join(" · ") });
  el.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: "suggestion-flair vault-citation-key", text: `@${e.citekey}` });
}

function searchEntries(entries: Iterable<Entry>, query: string, limit = 50): Entry[] {
  const q = query.trim();
  const all = [...entries];
  if (!q) return all.slice(0, limit);
  const fuzzy = prepareFuzzySearch(q);
  return all
    .map((e) => {
      const keyHit = e.citekey.toLowerCase().startsWith(q.toLowerCase()) ? 1 : 0;
      const m = fuzzy(`${e.citekey} ${e.title} ${e.authorString} ${e.year}`);
      return { e, score: m ? m.score + keyHit * 10 : keyHit ? 0 : null };
    })
    .filter((x): x is { e: Entry; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}

class EntryModal extends SuggestModal<Entry> {
  constructor(
    app: any,
    private plugin: CitationsPlugin,
    placeholder: string,
    private onChoose: (e: Entry) => void,
  ) {
    super(app);
    this.setPlaceholder(`${placeholder}: search by citekey, title, author or year`);
    this.modalEl.addClass("mod-citations");
  }
  getSuggestions(query: string): Entry[] {
    return searchEntries(this.plugin.entries.values(), query);
  }
  renderSuggestion(e: Entry, el: HTMLElement) {
    renderEntry(e, el);
  }
  onChooseSuggestion(e: Entry) {
    this.onChoose(e);
  }
}

class CitekeySuggest extends EditorSuggest<Entry> {
  constructor(
    app: any,
    private plugin: CitationsPlugin,
  ) {
    super(app);
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to cite" },
      { command: "esc", purpose: "to dismiss" },
    ]);
  }

  onTrigger(cursor: any, editor: any) {
    if (this.plugin.stepAside() || !this.plugin.entries.size) return null;
    const line: string = editor.getLine(cursor.line);
    const before = line.slice(0, cursor.ch);
    const m = /\[(?:[^\[\]]*;\s*)?[^\[\]@;]*?-?@([\p{L}\p{N}_:.#$%&\-+?<>~/]*)$/u.exec(before);
    if (!m) return null;
    return { start: { line: cursor.line, ch: cursor.ch - m[1]!.length }, end: cursor, query: m[1]! };
  }

  getSuggestions(ctx: any): Entry[] {
    return searchEntries(this.plugin.entries.values(), ctx.query, 20);
  }

  renderSuggestion(e: Entry, el: HTMLElement) {
    renderEntry(e, el);
  }

  selectSuggestion(e: Entry) {
    const ctx = this.context;
    if (!ctx) return;
    const editor = ctx.editor;
    const line: string = editor.getLine(ctx.end.line);
    const after = line.slice(ctx.end.ch);
    // Swallow the rest of a partly typed key; close the bracket if nothing does.
    const tail = /^[\p{L}\p{N}_:.#$%&\-+?<>~/]*/u.exec(after)![0];
    const rest = after.slice(tail.length);
    const closes = /^[^\[\n]*\]/.test(rest);
    const insert = e.citekey + (closes ? "" : "]");
    editor.replaceRange(insert, ctx.start, { line: ctx.end.line, ch: ctx.end.ch + tail.length });
    // Continue after the closing bracket when it directly follows (as the link suggester does after "]]").
    const past = !closes || rest.startsWith("]") ? 1 : 0;
    editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + e.citekey.length + past });
    this.close();
  }
}

class CitationsSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private citations: CitationsPlugin,
  ) {
    super(app, citations);
    this.name = "Citations";
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const p = this.citations;
    const o = p.options;
    const save = () => void p.instance.saveOptions();
    const reload = debounce(() => void p.reload().then(() => status()), 600, true);

    if (p.stepAside()) {
      containerEl.createDiv({ cls: "vault-citations-step-aside callout", attr: { "data-callout": "info" } }).setText("The Citations or Zotero Integration community plugin is enabled, so built-in citations are switched off. Disable that plugin to use these settings.");
    }
    const statusEl = containerEl.createDiv({ cls: "setting-item-description vault-citations-status" });
    const status = () => {
      statusEl.setText(p.loadError ? p.loadError : `${p.entries.size} references loaded.`);
      statusEl.toggleClass("mod-warning", !!p.loadError);
    };
    status();

    new Setting(containerEl).setHeading().setName("Sources");
    new Setting(containerEl)
      .setName("Bibliography file")
      .setDesc("A .bib (BibTeX or BibLaTeX), CSL-JSON or Better BibTeX JSON file in the vault. It is re-read when it changes, so Better BibTeX's “Keep updated” export works.")
      .addText((t) =>
        t
          .setPlaceholder("references.bib")
          .setValue(o.citationExportPath)
          .onChange((v) => {
            o.citationExportPath = v.trim();
            o.citationExportFormat = /\.bib$/i.test(v.trim()) ? "biblatex" : "csl-json";
            save();
            reload();
          }),
      );
    new Setting(containerEl)
      .setName("Zotero user or group ID")
      .setDesc("Optional. Reads your library through the Zotero web API (zotero.org/settings/keys). Requests go only to api.zotero.org.")
      .addText((t) => t.setPlaceholder("1234567").setValue(o.zoteroUserId).onChange((v) => ((o.zoteroUserId = v.trim()), save(), reload())))
      .addDropdown((d) => d.addOptions({ users: "User library", groups: "Group library" }).setValue(o.zoteroLibraryType).onChange((v) => ((o.zoteroLibraryType = v as CitationsOptions["zoteroLibraryType"]), save(), reload())));
    new Setting(containerEl)
      .setName("Zotero API key")
      .setDesc("Stored in Settings → Keychain, never in the vault. Not needed for public group libraries.")
      .addComponent((el) => new SecretComponent(this.app, el).setValue(o.zoteroApiKeySecret).onChange((v) => ((o.zoteroApiKeySecret = v), save(), reload())));
    new Setting(containerEl).addButton((b) => b.setButtonText("Refresh now").onClick(() => void p.reload(true).then(status)));

    new Setting(containerEl).setHeading().setName("Formatting");
    new Setting(containerEl)
      .setName("Citation style")
      .setDesc("APA and Chicago are included. Type any style id from the CSL repository (for example ieee, modern-language-association, nature) to download it once, or the path of a .csl file in the vault.")
      .addDropdown((d) => {
        for (const [id, s] of Object.entries(BUNDLED_STYLES)) d.addOption(id, s.label);
        if (!BUNDLED_STYLES[o.cslStyle]) d.addOption(o.cslStyle, o.cslStyle);
        d.setValue(o.cslStyle).onChange((v) => ((o.cslStyle = v), save()));
      })
      .addText((t) =>
        t.setPlaceholder("other style id").onChange(
          debounce((v: string) => {
            if (!v.trim()) return;
            o.cslStyle = v.trim();
            save();
          }, 800, true),
        ),
      );
    new Setting(containerEl)
      .setName("Format citations in reading view")
      .addToggle((t) => t.setValue(o.renderInReading).onChange((v) => ((o.renderInReading = v), save())));
    new Setting(containerEl)
      .setName("Add a bibliography")
      .setDesc("At the end of reading view and of PDF, Word, EPUB and rich-text exports.")
      .addToggle((t) => t.setValue(o.showBibliography).onChange((v) => ((o.showBibliography = v), save())));
    new Setting(containerEl)
      .setName("Bibliography heading")
      .addText((t) => t.setValue(o.bibliographyHeading).onChange((v) => ((o.bibliographyHeading = v), save())));

    new Setting(containerEl).setHeading().setName("Literature notes");
    new Setting(containerEl)
      .setName("Literature note folder")
      .addText((t) => t.setValue(o.literatureNoteFolder).onChange((v) => ((o.literatureNoteFolder = v.trim()), save())));
    new Setting(containerEl)
      .setName("Literature note title template")
      .addText((t) => t.setValue(o.literatureNoteTitleTemplate).onChange((v) => ((o.literatureNoteTitleTemplate = v), save())));
    new Setting(containerEl)
      .setName("Literature note content template")
      .setDesc("Variables: {{citekey}} {{abstract}} {{authorString}} {{containerTitle}} {{DOI}} {{eprint}} {{eprinttype}} {{eventPlace}} {{note}} {{page}} {{publisher}} {{publisherPlace}} {{title}} {{titleShort}} {{URL}} {{year}} {{zoteroSelectURI}}")
      .addTextArea((t) => t.setValue(o.literatureNoteContentTemplate).onChange((v) => ((o.literatureNoteContentTemplate = v), save())));
    new Setting(containerEl)
      .setName("Markdown citation template")
      .addText((t) => t.setValue(o.markdownCitationTemplate).onChange((v) => ((o.markdownCitationTemplate = v), save())));
    new Setting(containerEl)
      .setName("Alternative Markdown citation template")
      .addText((t) => t.setValue(o.alternativeMarkdownCitationTemplate).onChange((v) => ((o.alternativeMarkdownCitationTemplate = v), save())));
    new Setting(containerEl)
      .setName("Import settings from the Citations plugin")
      .setDesc("Copies .obsidian/plugins/obsidian-citation-plugin/data.json.")
      .addButton((b) =>
        b.setButtonText("Import").onClick(async () => {
          try {
            const raw = await this.app.vault.adapter.read(`${this.app.vault.configDir}/plugins/obsidian-citation-plugin/data.json`);
            const data = JSON.parse(raw) as Partial<CitationsOptions>;
            for (const k of ["citationExportPath", "citationExportFormat", "literatureNoteTitleTemplate", "literatureNoteFolder", "literatureNoteContentTemplate", "markdownCitationTemplate", "alternativeMarkdownCitationTemplate"] as const) {
              if (typeof data[k] === "string") (o as unknown as Record<string, string>)[k] = data[k] as string;
            }
            save();
            await p.reload(true);
            this.display();
          } catch {
            new Notice("No Citations plugin settings found in this vault.");
          }
        }),
      );
  }
}

export const citations: CorePluginDefinition = {
  id: "citations",
  name: "Citations",
  description: "Cite from a BibTeX or CSL-JSON bibliography or Zotero, with literature notes and formatted references.",
  icon: "lucide-quote",
  defaultOn: false,
  defaultOptions: { ...DEFAULT_CITATIONS_OPTIONS },
  create: (app) => new CitationsPlugin(app, { id: "citations", name: "Citations", version: "", minAppVersion: "", author: "", description: "" }),
};
