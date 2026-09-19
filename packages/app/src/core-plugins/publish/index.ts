/**
 * Publish, locally: no service, no account. The vault (or a filtered part of
 * it) becomes a static website in a .zip; a note becomes one standalone .html.
 *
 * Also `export-pdf`, a hidden always-on definition for `workspace:export-pdf`,
 * which Obsidian ships as an app command rather than in a core plugin.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import { TAbstractFile, TFile, TFolder } from "../../obsidian/vault/files";
import { exportNoteHtml, exportSiteFiles, selectSiteNotes, type SiteOptions } from "./export";
import { DEFAULT_PDF_OPTIONS, PdfExportModal, printNotes, type PdfOptions } from "./export-pdf";
import { buildZip, downloadBlob } from "./zip";

interface PublishOptions {
  siteName: string;
  homepage: string;
  includeFolders: string[];
  excludeFolders: string[];
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "export";
}

class PublishPlugin extends Plugin {
  instance!: any;

  get options(): PublishOptions {
    return this.instance.options as PublishOptions;
  }

  override onload() {
    this.addCommand({ id: "publish:export-site", name: "Export vault as website…", icon: "lucide-send", callback: () => new ExportSiteModal(this.app, this).open() });
    this.addCommand({
      id: "publish:export-note",
      name: "Export note as HTML…",
      icon: "lucide-file-code",
      checkCallback: (checking) => {
        const file: TFile | null = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.exportNote(file);
        return true;
      },
    });
    this.addRibbonIcon("lucide-send", "Export vault as website", () => new ExportSiteModal(this.app, this).open());
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: any, file: TFile) => {
        if (!file || (file as { extension?: string }).extension !== "md") return;
        menu.addItem((item: any) =>
          item
            .setSection("action")
            .setTitle("Export as HTML")
            .setIcon("lucide-file-code")
            .onClick(() => void this.exportNote(file)),
        );
      }),
    );
    this.instance.exportNote = (file: TFile) => this.exportNote(file);
  }

  async exportNote(file: TFile) {
    try {
      const html = await exportNoteHtml(this.app, file);
      downloadBlob(new Blob([html], { type: "text/html" }), `${safeFileName(file.basename)}.html`);
    } catch (e) {
      new Notice(String((e as Error)?.message ?? e));
    }
  }
}

class ExportSiteModal extends Modal {
  constructor(app: any, private plugin: PublishPlugin) {
    super(app);
    this.modalEl.addClass("mod-publish-export");
  }

  override onOpen() {
    this.setTitle("Export vault as website");
    const o = this.plugin.options;
    const save = () => void this.plugin.instance.saveOptions();
    const { contentEl } = this;
    contentEl.createEl("p", { cls: "setting-item-description", text: "Builds a static website from your notes and downloads it as a .zip. Notes with “publish: true” are always included; notes with “publish: false” never are." });

    new Setting(contentEl).setName("Site name").addText((t) => t.setPlaceholder(this.app.vault.getName()).setValue(o.siteName).onChange((v) => ((o.siteName = v), save())));
    new Setting(contentEl)
      .setName("Homepage file")
      .setDesc("Shown as index.html. Leave empty for a list of all pages.")
      .addText((t) => t.setPlaceholder("Home.md").setValue(o.homepage).onChange((v) => ((o.homepage = v.trim()), save(), update())));
    new Setting(contentEl)
      .setName("Included folders")
      .setDesc("One per line. Empty includes the whole vault.")
      .addTextArea((t) => t.setValue(o.includeFolders.join("\n")).onChange((v) => ((o.includeFolders = lines(v)), save(), update())));
    new Setting(contentEl)
      .setName("Excluded folders")
      .setDesc("One per line.")
      .addTextArea((t) => t.setValue(o.excludeFolders.join("\n")).onChange((v) => ((o.excludeFolders = lines(v)), save(), update())));

    const summary = contentEl.createDiv({ cls: "publish-export-summary setting-item-description" });
    const update = () => {
      const n = selectSiteNotes(this.app, this.siteOptions()).length;
      summary.setText(`${n} note${n === 1 ? "" : "s"} will be exported.`);
    };
    update();

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const run = buttons.createEl("button", { cls: "mod-cta", text: "Export" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    run.addEventListener("click", async () => {
      run.disabled = true;
      const notice = new Notice("Exporting site…", 0);
      try {
        const opts = this.siteOptions();
        const files = await exportSiteFiles(this.app, opts, (msg) => notice.setMessage(msg));
        notice.setMessage("Creating zip…");
        const blob = buildZip(files.map((f) => ({ path: f.path, data: f.data })));
        downloadBlob(blob, `${safeFileName(opts.siteName || this.app.vault.getName())}-site.zip`);
        notice.hide();
        new Notice(`Exported ${files.filter((f) => f.path.endsWith(".html")).length} pages.`);
        this.close();
      } catch (e) {
        notice.hide();
        new Notice(String((e as Error)?.message ?? e));
      } finally {
        run.disabled = false;
      }
    });
  }

  override onClose() {
    this.contentEl.empty();
  }

  private siteOptions(): SiteOptions {
    const o = this.plugin.options;
    let homepage = o.homepage;
    if (homepage && !homepage.endsWith(".md")) {
      const f = this.app.metadataCache.getFirstLinkpathDest(homepage, "");
      homepage = f ? f.path : `${homepage}.md`;
    }
    return { siteName: o.siteName, homepage, includeFolders: o.includeFolders, excludeFolders: o.excludeFolders };
  }
}

function lines(v: string): string[] {
  return v
    .split("\n")
    .map((s) => s.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
}

class ExportPdfPlugin extends Plugin {
  instance!: any;

  private get pdfOptions(): PdfOptions {
    const o = this.instance.options as Partial<PdfOptions>;
    for (const [k, v] of Object.entries(DEFAULT_PDF_OPTIONS)) if (!(k in o)) (o as Record<string, unknown>)[k] = Array.isArray(v) ? [...v] : v;
    return o as PdfOptions;
  }

  openModal(files: TFile[]) {
    if (!files.length) {
      new Notice("There are no notes to export.");
      return;
    }
    new PdfExportModal(this.app, files, this.pdfOptions, () => void this.instance.saveOptions()).open();
  }

  override onload() {
    this.addCommand({
      id: "workspace:export-pdf",
      name: "Export to PDF...",
      icon: "lucide-file-down",
      checkCallback: (checking) => {
        const file: TFile | null = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) this.openModal([file]);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: any, file: TAbstractFile, source: string) => {
        if (file instanceof TFolder) {
          const notes = notesIn(file);
          if (!notes.length) return;
          menu.addItem((item: any) =>
            item
              .setSection("action")
              .setTitle("Export folder to PDF...")
              .setIcon("lucide-file-down")
              .onClick(() => this.openModal(notes)),
          );
          return;
        }
        if (!file || (file as { extension?: string }).extension !== "md" || source === "file-explorer-context-menu") return;
        menu.addItem((item: any) =>
          item
            .setSection("action")
            .setTitle("Export to PDF...")
            .setIcon("lucide-file-down")
            .onClick(() => this.openModal([file as TFile])),
        );
      }),
    );
    this.registerEvent(
      this.app.workspace.on("files-menu", (menu: any, files: TAbstractFile[]) => {
        const notes = files.flatMap((f) => (f instanceof TFolder ? notesIn(f) : f instanceof TFile && f.extension === "md" ? [f] : []));
        if (notes.length < 2) return;
        menu.addItem((item: any) =>
          item
            .setSection("action")
            .setTitle(`Export ${notes.length} notes to one PDF...`)
            .setIcon("lucide-file-down")
            .onClick(() => this.openModal(notes)),
        );
      }),
    );
    this.instance.exportPdf = (files: TFile[], options?: Partial<PdfOptions>) => printNotes(this.app, files, { ...this.pdfOptions, ...options });
    this.instance.openExportModal = (files: TFile[]) => this.openModal(files);
  }
}

/** Markdown files under `folder`, in path order. */
export function notesIn(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  const walk = (f: TAbstractFile) => {
    if (f instanceof TFile && f.extension === "md") out.push(f);
    else if (f instanceof TFolder) for (const c of f.children) walk(c);
  };
  walk(folder);
  return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export const publish: CorePluginDefinition = {
  id: "publish",
  name: "Publish",
  description: "Export your notes as a static website or standalone HTML.",
  icon: "lucide-send",
  defaultOn: false,
  defaultOptions: { siteName: "", homepage: "", includeFolders: [], excludeFolders: [] },
  create: (app) => new PublishPlugin(app, { id: "publish", name: "Publish", version: "", minAppVersion: "", author: "", description: "" }),
};

export const exportPdf = {
  id: "export-pdf",
  name: "Export to PDF",
  description: "Export notes to PDF through the print dialog, with page size, margins, headers, footers and a table of contents.",
  icon: "lucide-file-down",
  defaultOn: true,
  hidden: true,
  defaultOptions: { ...DEFAULT_PDF_OPTIONS, customMargins: [...DEFAULT_PDF_OPTIONS.customMargins] },
  create: (app: any) => new ExportPdfPlugin(app, { id: "export-pdf", name: "Export to PDF", version: "", minAppVersion: "", author: "", description: "" }),
} as CorePluginDefinition;
