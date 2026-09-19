/**
 * Format converter (`markdown-importer`): rewrites Markdown written for other
 * apps — Roam, Bear, Zettelkasten tools, old frontmatter keys — across the
 * whole vault.
 */
import { getEngine } from "@vault/engine";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import type { TFile } from "../../obsidian/vault/files";
import { diffLineOps } from "../file-recovery/diff";
import { convert, DEFAULT_CONVERT_OPTIONS, type ConvertContext, type ConvertOptions } from "./convert";

const ID = "markdown-importer";

const OPTION_ROWS: { key: keyof ConvertOptions; name: string; desc: string }[] = [
  { key: "roamTags", name: "Roam Research tag fixer", desc: "Convert #tag and #[[tag]] into [[tag]]." },
  { key: "roamHighlights", name: "Roam Research highlight fixer", desc: "Convert ^^highlight^^ into ==highlight==." },
  { key: "roamTodos", name: "Roam Research TODO converter", desc: "Convert {{[[TODO]]}} into [ ] and {{[[DONE]]}} into [x]." },
  { key: "bearHighlights", name: "Bear highlight fixer", desc: "Convert ::highlight:: into ==highlight==." },
  { key: "bearMultiwordTags", name: "Bear multi-word tag fixer", desc: "Convert #multi word tag# into #multi-word-tag." },
  { key: "markdownLinksToWikilinks", name: "Markdown link converter", desc: "Convert [text](Note.md) links to notes and attachments into [[Note|text]] wikilinks. Web links are left alone." },
  { key: "zettelkastenLinkFixer", name: "Zettelkasten link fixer", desc: "Convert [[UID]] into [[UID File Name]]." },
  { key: "zettelkastenLinkBeautifier", name: "Zettelkasten link beautifier", desc: "Convert [[UID]] into [[UID File Name|File Name]]." },
  { key: "frontmatterMigration", name: "Frontmatter migration", desc: "Convert tag, alias and cssclass into tags, aliases and cssclasses lists, splitting comma-separated text." },
];

interface Progress {
  processed: number;
  modified: number;
  replacements: number;
  failed: number;
  total: number;
}

class FormatConverterPlugin extends Plugin {
  instance!: any;

  override async onload() {
    this.addRibbonIcon("lucide-wand-sparkles", "Open format converter", () => this.openModal());
    this.addCommand({ id: `${ID}:open`, name: "Open format converter", callback: () => this.openModal() });
    this.instance.openModal = () => this.openModal();
    this.instance.convertText = (text: string, options: Partial<ConvertOptions>) => this.convertText(text, options);
  }

  get options(): ConvertOptions {
    const o = this.instance.options as Record<string, unknown>;
    const out = { ...DEFAULT_CONVERT_OPTIONS };
    for (const k of Object.keys(out) as (keyof ConvertOptions)[]) if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
    return out;
  }

  openModal() {
    new FormatConverterModal(this).open();
  }

  private context(): ConvertContext {
    const files = this.app.vault.getMarkdownFiles() as TFile[];
    const byUid = new Map<string, string | null>();
    return {
      resolveUid: (uid) => {
        if (byUid.has(uid)) return byUid.get(uid)!;
        let found: string | null = null;
        if (!files.some((f) => f.basename === uid)) {
          const matches = files.filter((f) => f.basename.startsWith(uid) && /^[\s\-_.]/.test(f.basename.slice(uid.length)));
          if (matches.length === 1) found = matches[0]!.basename;
        }
        byUid.set(uid, found);
        return found;
      },
      resolveLink: (path) => {
        const file = this.app.metadataCache.getFirstLinkpathDest(path, "") ?? this.app.metadataCache.getFirstLinkpathDest(`${path}.md`, "");
        if (!file) return null;
        return this.app.metadataCache.fileToLinktext(file, "", true);
      },
    };
  }

  /** Engine first (without the Zettelkasten fixers), then the vault-aware TS passes. */
  convertText(text: string, options: Partial<ConvertOptions>, ctx: ConvertContext = this.context()): { text: string; replacements: number } {
    const opts = { ...DEFAULT_CONVERT_OPTIONS, ...options };
    const { zettelkastenLinkFixer, zettelkastenLinkBeautifier, markdownLinksToWikilinks, ...rest } = opts;
    let engineText: string | null = null;
    try {
      const engine = getEngine() as { formatConvert?: (t: string, o: Record<string, boolean>) => string };
      if (typeof engine.formatConvert === "function") {
        const r = engine.formatConvert(text, { ...rest, markdownLinksToWikilinks: false, zettelkastenLinkFixer: false, zettelkastenLinkBeautifier: false });
        if (typeof r === "string") engineText = r;
      }
    } catch {
      engineText = null;
    }
    if (engineText === null) return convert(text, opts, ctx);
    let replacements = engineText === text ? 0 : diffLineOps(text, engineText).filter((op) => op.type === "insert").length || 1;
    const vaultAware = convert(engineText, { markdownLinksToWikilinks, zettelkastenLinkFixer, zettelkastenLinkBeautifier }, ctx);
    replacements += vaultAware.replacements;
    return { text: vaultAware.text, replacements };
  }

  async run(options: ConvertOptions, onProgress: (p: Progress) => void, shouldStop: () => boolean): Promise<Progress> {
    const files = (this.app.vault.getMarkdownFiles() as TFile[]).slice().sort((a, b) => a.path.localeCompare(b.path));
    const progress: Progress = { processed: 0, modified: 0, replacements: 0, failed: 0, total: files.length };
    const ctx = this.context();
    onProgress(progress);
    let lastYield = performance.now();
    for (const file of files) {
      if (shouldStop()) break;
      try {
        const original = await this.app.vault.read(file);
        const result = this.convertText(original, options, ctx);
        if (result.text !== original) {
          await this.app.vault.process(file, (current: string) => (current === original ? result.text : this.convertText(current, options, ctx).text));
          progress.modified++;
          progress.replacements += result.replacements;
        }
      } catch (e) {
        console.error(`Format converter failed on ${file.path}`, e);
        progress.failed++;
      }
      progress.processed++;
      if (performance.now() - lastYield > 50) {
        onProgress(progress);
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
    onProgress(progress);
    return progress;
  }
}

class FormatConverterModal extends Modal {
  private running = false;
  private stopRequested = false;

  constructor(private plugin: FormatConverterPlugin) {
    super(plugin.app);
    this.modalEl.addClass("vault-format-converter-modal");
    this.setTitle("Format converter");
  }

  override onOpen() {
    this.renderOptions();
  }

  private renderOptions() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: "Convert Markdown written for other apps into Obsidian-flavored Markdown. The conversion runs over every note in the vault." });
    const warn = contentEl.createDiv({ cls: "vault-format-converter-warning" });
    warn.createEl("strong", { text: "Back up your vault first. " });
    warn.appendText("Conversion changes files in place and cannot be undone.");

    const options = this.plugin.options;
    for (const row of OPTION_ROWS) {
      new Setting(contentEl)
        .setName(row.name)
        .setDesc(row.desc)
        .addToggle((t) =>
          t.setValue(options[row.key]).onChange(async (v) => {
            this.plugin.instance.options[row.key] = v;
            await this.plugin.instance.saveOptions();
            this.updateStartButton();
          }),
        );
    }
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const start = buttons.createEl("button", { cls: "mod-cta vault-format-converter-start", text: "Start conversion" });
    start.addEventListener("click", () => this.renderConfirm());
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    this.updateStartButton();
  }

  private updateStartButton() {
    const btn = this.contentEl.querySelector<HTMLButtonElement>(".vault-format-converter-start");
    if (!btn) return;
    const any = Object.values(this.plugin.options).some(Boolean);
    btn.disabled = !any;
    btn.toggleClass("is-disabled", !any);
  }

  private renderConfirm() {
    const { contentEl } = this;
    const options = this.plugin.options;
    const enabled = OPTION_ROWS.filter((r) => options[r.key]);
    const count = this.app.vault.getMarkdownFiles().length;
    contentEl.empty();
    contentEl.createEl("p", { text: `Convert ${count} ${count === 1 ? "note" : "notes"} with these fixers?` });
    const list = contentEl.createEl("ul");
    for (const r of enabled) list.createEl("li", { text: r.name });
    contentEl.createDiv({ cls: "vault-format-converter-warning", text: "Make sure you have a backup. This cannot be undone." });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const go = buttons.createEl("button", { cls: "mod-warning", text: "Convert" });
    go.addEventListener("click", () => void this.start());
    const back = buttons.createEl("button", { text: "Back" });
    back.addEventListener("click", () => this.renderOptions());
    go.focus();
  }

  private async start() {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    const { contentEl } = this;
    contentEl.empty();
    const status = contentEl.createDiv({ cls: "vault-format-converter-status", text: "Converting…" });
    const bar = contentEl.createEl("progress", { cls: "vault-format-converter-progress", attr: { max: "1", value: "0" } });
    const stats = contentEl.createDiv({ cls: "vault-format-converter-stats" });
    const cell = (label: string) => {
      const row = stats.createDiv({ cls: "vault-format-converter-stat" });
      const value = row.createDiv({ cls: "vault-format-converter-stat-value", text: "0" });
      row.createDiv({ cls: "vault-format-converter-stat-label", text: label });
      return value;
    };
    const processedEl = cell("Processed files");
    const modifiedEl = cell("Modified files");
    const replacementsEl = cell("Total replacements");
    const failedEl = cell("Failed");
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const stop = buttons.createEl("button", { cls: "mod-warning", text: "Stop" });
    stop.addEventListener("click", () => {
      this.stopRequested = true;
      stop.disabled = true;
      stop.setText("Stopping…");
    });

    const result = await this.plugin.run(
      this.plugin.options,
      (p) => {
        processedEl.setText(`${p.processed} / ${p.total}`);
        modifiedEl.setText(String(p.modified));
        replacementsEl.setText(String(p.replacements));
        failedEl.setText(String(p.failed));
        bar.max = Math.max(1, p.total);
        bar.value = p.processed;
      },
      () => this.stopRequested,
    );
    this.running = false;
    const stopped = result.processed < result.total;
    status.setText(stopped ? "Conversion stopped." : "Conversion finished.");
    stop.remove();
    const done = buttons.createEl("button", { cls: "mod-cta", text: "Done" });
    done.addEventListener("click", () => this.close());
    if (this.isOpen) done.focus();
    new Notice(
      `Format conversion ${stopped ? "stopped" : "finished"}: ${result.modified} of ${result.processed} files modified, ${result.replacements} replacements${result.failed ? `, ${result.failed} failed` : ""}.`,
    );
  }
}

export const formatConverter: CorePluginDefinition = {
  id: ID,
  name: "Format converter",
  description: "Convert Markdown from other apps to Obsidian format",
  icon: "lucide-wand-sparkles",
  defaultOn: false,
  defaultOptions: { ...DEFAULT_CONVERT_OPTIONS },
  create: (app) => new FormatConverterPlugin(app, { id: ID, name: "Format converter", version: "", minAppVersion: "", author: "", description: "Convert Markdown from other apps to Obsidian format" }),
};
