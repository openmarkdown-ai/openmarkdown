/**
 * Export — copy as rich text, Word (.docx), EPUB, and more formats through
 * pandoc (downloaded on first use, after consent). Everything runs in the
 * page; nothing is uploaded.
 *
 * Replaces the desktop-only Pandoc Plugin, Enhancing Export and Copy document
 * as HTML. PDF lives in `publish/export-pdf.ts` (`workspace:export-pdf`).
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { TAbstractFile, TFile, TFolder } from "../../obsidian/vault/files";
import { downloadBlob } from "../publish/zip";
import { safeFileName } from "./render";
import { DEFAULT_RICH_COPY, richCopyPayload, writeRichClipboard } from "./rich-copy";

export interface ExportOptions {
  /** "download" (browser download) or "vault" (next to the note, as the Pandoc plugin does). */
  saveTo: "download" | "vault";
  richCopyTitle: boolean;
  richCopyMaxImageMB: number;
  docxIncludeTitle: boolean;
  includeProperties: boolean;
  epubAuthor: string;
  epubLanguage: string;
  pandocConsented: boolean;
  pandocExtraArgs: string;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  saveTo: "download",
  richCopyTitle: false,
  richCopyMaxImageMB: 2,
  docxIncludeTitle: true,
  includeProperties: false,
  epubAuthor: "",
  epubLanguage: "",
  pandocConsented: false,
  pandocExtraArgs: "",
};

type Format = "docx" | "epub";

function notesIn(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  const walk = (f: TAbstractFile) => {
    if (f instanceof TFile && f.extension === "md") out.push(f);
    else if (f instanceof TFolder) for (const c of f.children) walk(c);
  };
  walk(folder);
  return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export class ExportPlugin extends Plugin {
  instance!: any;
  private busy = false;

  get options(): ExportOptions {
    const o = this.instance.options as Partial<ExportOptions>;
    for (const [k, v] of Object.entries(DEFAULT_EXPORT_OPTIONS)) if (!(k in o)) (o as Record<string, unknown>)[k] = v;
    return o as ExportOptions;
  }

  override onload() {
    const activeNote = (): TFile | null => {
      const f: TFile | null = this.app.workspace.getActiveFile();
      return f && f.extension === "md" ? f : null;
    };
    this.addCommand({
      id: "editor:copy-as-html",
      name: "Copy as rich text",
      icon: "lucide-clipboard-copy",
      checkCallback: (checking) => {
        const file = activeNote();
        if (!file) return false;
        if (!checking) void this.copyRich(file);
        return true;
      },
    });
    this.addCommand({
      id: "publish:copy-html-source",
      name: "Copy as HTML",
      icon: "lucide-code",
      checkCallback: (checking) => {
        const file = activeNote();
        if (!file) return false;
        if (!checking) void this.copyHtmlSource(file);
        return true;
      },
    });
    const exportCommand = (format: Format, name: string, icon: string) =>
      this.addCommand({
        id: `publish:export-${format}`,
        name,
        icon,
        checkCallback: (checking) => {
          const file = activeNote();
          if (!file) return false;
          if (!checking) void this.exportFiles([file], format);
          return true;
        },
      });
    exportCommand("docx", "Export to Word (.docx)", "lucide-file-text");
    exportCommand("epub", "Export to EPUB", "lucide-book-open");
    this.addCommand({
      id: "publish:export-pandoc",
      name: "Export with pandoc...",
      icon: "lucide-file-output",
      checkCallback: (checking) => {
        const file = activeNote();
        if (!file) return false;
        if (!checking) void this.exportPandoc([file]);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: any, file: TAbstractFile, source: string) => {
        const notes = file instanceof TFolder ? notesIn(file) : file instanceof TFile && file.extension === "md" ? [file] : [];
        if (!notes.length) return;
        const folder = file instanceof TFolder;
        menu.addItem((item: any) => {
          item.setSection("action").setTitle(folder ? "Export folder to Word (.docx)" : "Export to Word (.docx)").setIcon("lucide-file-text").onClick(() => void this.exportFiles(notes, "docx"));
        });
        menu.addItem((item: any) => {
          item.setSection("action").setTitle(folder ? "Export folder as EPUB" : "Export to EPUB").setIcon("lucide-book-open").onClick(() => void this.exportFiles(notes, "epub"));
        });
        if (!folder && source !== "file-explorer-context-menu") {
          menu.addItem((item: any) => item.setSection("action").setTitle("Copy as rich text").setIcon("lucide-clipboard-copy").onClick(() => void this.copyRich(file as TFile)));
        }
      }),
    );
    this.registerEvent(
      this.app.workspace.on("files-menu", (menu: any, files: TAbstractFile[]) => {
        const notes = files.flatMap((f) => (f instanceof TFolder ? notesIn(f) : f instanceof TFile && f.extension === "md" ? [f] : []));
        if (notes.length < 2) return;
        menu.addItem((item: any) => item.setSection("action").setTitle(`Export ${notes.length} notes as one EPUB`).setIcon("lucide-book-open").onClick(() => void this.exportFiles(notes, "epub")));
        menu.addItem((item: any) => item.setSection("action").setTitle(`Export ${notes.length} notes to one Word document`).setIcon("lucide-file-text").onClick(() => void this.exportFiles(notes, "docx")));
      }),
    );

    if (this.app.setting?.addSettingTab) this.addSettingTab(new ExportSettingTab(this.app, this));

    // internal (used by tests and other core plugins)
    this.instance.copyRich = (file: TFile) => this.copyRich(file);
    this.instance.exportFiles = (files: TFile[], format: Format) => this.exportFiles(files, format);
    this.instance.buildBlob = (files: TFile[], format: Format) => this.buildBlob(files, format);
    this.instance.richCopyPayload = (file: TFile) => richCopyPayload(this.app, file, undefined, this.richOptions());
  }

  private richOptions() {
    return { ...DEFAULT_RICH_COPY, includeTitle: this.options.richCopyTitle, maxImageBytes: this.options.richCopyMaxImageMB * 1_000_000 };
  }

  private selectionFor(file: TFile): string | undefined {
    const view = this.app.workspace.activeEditor;
    if (view?.file !== file) return undefined;
    const sel = view.editor?.getSelection?.();
    return typeof sel === "string" && sel.trim() ? sel : undefined;
  }

  async copyRich(file: TFile) {
    const selection = this.selectionFor(file);
    const notice = new Notice("Copying as rich text…", 0);
    try {
      await writeRichClipboard(richCopyPayload(this.app, file, selection, this.richOptions()));
      notice.setMessage(selection ? "Selection copied as rich text." : "Note copied as rich text.");
      setTimeout(() => notice.hide(), 2500);
    } catch (e) {
      notice.hide();
      new Notice(`Copy failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async copyHtmlSource(file: TFile) {
    try {
      const payload = await richCopyPayload(this.app, file, this.selectionFor(file), this.richOptions());
      await navigator.clipboard.writeText(payload.html.replace(/^<meta charset="utf-8">/, ""));
      new Notice("HTML copied.");
    } catch (e) {
      new Notice(`Copy failed: ${(e as Error)?.message ?? e}`);
    }
  }

  async buildBlob(files: TFile[], format: Format): Promise<Blob> {
    const o = this.options;
    if (format === "docx") {
      const { exportDocx } = await import("./docx");
      return exportDocx(this.app, files, { includeTitle: o.docxIncludeTitle, includeProperties: o.includeProperties });
    }
    const { exportEpub } = await import("./epub");
    return exportEpub(this.app, files, { author: o.epubAuthor, language: o.epubLanguage, includeProperties: o.includeProperties });
  }

  async exportFiles(files: TFile[], format: Format) {
    if (this.busy) return;
    this.busy = true;
    const label = format === "docx" ? "Word document" : "EPUB";
    const notice = new Notice(`Exporting ${label}…`, 0);
    try {
      const blob = await this.buildBlob(files, format);
      const base = files.length === 1 ? files[0]!.basename : (files[0]!.parent?.isRoot?.() ? this.app.vault.getName() : files[0]!.parent?.name) || "Export";
      await this.save(blob, `${safeFileName(base)}.${format}`, files[0]!);
      notice.hide();
    } catch (e) {
      notice.hide();
      console.error(e);
      new Notice(`Export failed: ${(e as Error)?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  async save(blob: Blob, name: string, near: TFile) {
    if (this.options.saveTo === "vault") {
      const folder = near.parent && !near.parent.isRoot() ? `${near.parent.path}/` : "";
      const dot = name.lastIndexOf(".");
      const path = this.app.vault.getAvailablePath(`${folder}${name.slice(0, dot)}`, name.slice(dot + 1));
      await this.app.vault.createBinary(path, await blob.arrayBuffer());
      new Notice(`Saved ${path}`);
    } else {
      downloadBlob(blob, name);
    }
  }

  async exportPandoc(files: TFile[]) {
    const { PandocExportModal } = await import("./pandoc");
    new PandocExportModal(this.app, this, files).open();
  }
}

class ExportSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private exportPlugin: ExportPlugin,
  ) {
    super(app, exportPlugin);
    this.name = "Export";
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.exportPlugin.options;
    const save = () => void this.exportPlugin.instance.saveOptions();
    new Setting(containerEl)
      .setName("Save exported files")
      .setDesc("Download them, or save them next to the note in the vault.")
      .addDropdown((d) => d.addOptions({ download: "Download", vault: "Next to the note" }).setValue(o.saveTo).onChange((v) => ((o.saveTo = v as ExportOptions["saveTo"]), save())));
    new Setting(containerEl)
      .setName("Include properties")
      .setDesc("Add the note's properties as a table at the top of Word and EPUB exports.")
      .addToggle((t) => t.setValue(o.includeProperties).onChange((v) => ((o.includeProperties = v), save())));
    new Setting(containerEl).setHeading().setName("Copy as rich text");
    new Setting(containerEl)
      .setName("Include the note title")
      .addToggle((t) => t.setValue(o.richCopyTitle).onChange((v) => ((o.richCopyTitle = v), save())));
    new Setting(containerEl)
      .setName("Largest image to embed (MB)")
      .setDesc("Bigger images are left out so pasting stays fast.")
      .addText((t) => t.setValue(String(o.richCopyMaxImageMB)).onChange((v) => ((o.richCopyMaxImageMB = Math.max(0, Number(v) || 0)), save())));
    new Setting(containerEl).setHeading().setName("Word and EPUB");
    new Setting(containerEl)
      .setName("Start Word documents with the note title")
      .addToggle((t) => t.setValue(o.docxIncludeTitle).onChange((v) => ((o.docxIncludeTitle = v), save())));
    new Setting(containerEl)
      .setName("EPUB author")
      .setDesc("Used when the note has no author property.")
      .addText((t) => t.setValue(o.epubAuthor).onChange((v) => ((o.epubAuthor = v), save())));
    new Setting(containerEl)
      .setName("EPUB language")
      .setDesc("A language tag such as en or de. Empty uses the note's lang property, then the app language.")
      .addText((t) => t.setPlaceholder("en").setValue(o.epubLanguage).onChange((v) => ((o.epubLanguage = v.trim()), save())));
    new Setting(containerEl).setHeading().setName("Pandoc");
    new Setting(containerEl)
      .setName("Pandoc for more formats")
      .setDesc(o.pandocConsented ? "Pandoc is allowed. It is downloaded once and kept in this browser." : "LaTeX, ODT, RTF and others use pandoc (GPL, about 59 MB), downloaded only when you first ask for it.")
      .addButton((b) =>
        b.setButtonText("Remove downloaded pandoc").onClick(async () => {
          const { removePandocCache } = await import("./pandoc");
          await removePandocCache();
          o.pandocConsented = false;
          save();
          this.display();
          new Notice("Pandoc removed from this browser.");
        }),
      );
    new Setting(containerEl)
      .setName("Extra pandoc arguments")
      .setDesc("For example --toc --number-sections. Only pandoc options are accepted.")
      .addText((t) => t.setValue(o.pandocExtraArgs).onChange((v) => ((o.pandocExtraArgs = v), save())));
  }
}


export const exportPlugin: CorePluginDefinition = {
  id: "export",
  name: "Export",
  description: "Copy notes as rich text and export them to Word, EPUB and other formats.",
  icon: "lucide-file-output",
  defaultOn: true,
  defaultOptions: { ...DEFAULT_EXPORT_OPTIONS },
  create: (app) => new ExportPlugin(app, { id: "export", name: "Export", version: "", minAppVersion: "", author: "", description: "" }),
};
