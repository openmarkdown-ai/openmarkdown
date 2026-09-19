/**
 * Core plugin Text recognition (`ocr`): copy or insert the text in images and
 * scanned PDFs, and give other plugins Text Extractor's API.
 *
 * Commands: `ocr:copy-text` ("Copy text from image"), `ocr:insert-below`
 * ("Insert text from image below embed"), `ocr:extract-to-note`. Right-click
 * on an image embed or an image/PDF in the file menu offers the same.
 *
 * Omnisearch and others read `app.plugins.plugins["text-extractor"].api`
 * (`extractText(file)`, `canFileBeExtracted(path)`, `isInCache(file)`). When
 * Text Extractor itself is not installed this plugin answers there, so they
 * index image and PDF text unmodified. The real plugin always wins.
 */
import { Plugin } from "../../obsidian/plugin";
import { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { idb } from "../../obsidian/vault/idb";
import type { TFile } from "../../obsidian/vault/files";
import { askToDownload, formatBytes, isAbort, ProgressModal } from "../ai-tools/ui";
import {
  canFileBeExtracted,
  deleteLangData,
  downloadLang,
  extractPdf,
  hasTextDetector,
  isImagePath,
  isLangCached,
  isPdfPath,
  LANG_DATA_HOST,
  langName,
  missingLangs,
  OCR_LANGS,
  recognizeImage,
  terminateOcr,
  tesseractCodeFor,
} from "./engine";

export interface OcrOptions {
  ocrLanguages: string[];
  useTextDetector: boolean;
  ocrScannedPdfPages: boolean;
  provideTextExtractorApi: boolean;
  importedTextExtractorSettings: boolean;
}

const TEXT_EXTRACTOR_ID = "text-extractor";
/** Rough download sizes of `4.0.0_best_int` models, for the consent dialog. */
const APPROX_SIZE: Record<string, number> = { eng: 2_952_873, fra: 707_406, deu: 1_400_000, spa: 1_100_000, chi_sim: 2_400_000, jpn: 2_500_000 };

function defaultLangs(): string[] {
  const code = tesseractCodeFor(navigator.language || "en");
  return code && code !== "eng" ? [code, "eng"] : ["eng"];
}

type EmbedTarget = { file: TFile; sourcePath: string; view?: any; line?: number };

export class OcrPlugin extends Plugin {
  instance!: any;
  private shimInstalled = false;
  private missingDataNoticeShown = false;
  private dialogOpen = false;

  get options(): OcrOptions {
    return this.instance.options as OcrOptions;
  }

  override async onload() {
    if (!Array.isArray(this.options.ocrLanguages) || !this.options.ocrLanguages.length) this.options.ocrLanguages = defaultLangs();
    void this.importTextExtractorSettings();

    this.addCommand({
      id: "ocr:copy-text",
      name: "Copy text from image",
      icon: "lucide-scan-text",
      checkCallback: (checking) => {
        const target = this.targetFromActive();
        if (!target) return false;
        if (!checking) void this.copyText(target.file);
        return true;
      },
    });
    this.addCommand({
      id: "ocr:insert-below",
      name: "Insert text from image below embed",
      icon: "lucide-text-cursor-input",
      checkCallback: (checking) => {
        const target = this.targetFromActive(true);
        if (!target || target.line === undefined) return false;
        if (!checking) void this.insertBelow(target);
        return true;
      },
    });
    this.addCommand({
      id: "ocr:extract-to-note",
      name: "Extract text into a new note",
      icon: "lucide-file-text",
      checkCallback: (checking) => {
        const target = this.targetFromActive();
        if (!target) return false;
        if (!checking) void this.extractToNote(target.file);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TFile) => {
        if (!file || !(file as { extension?: string }).extension || !canFileBeExtracted(file.path) || this.handledByTextExtractor()) return;
        menu.addItem((i) => i.setSection("action").setTitle(isPdfPath(file.path) ? "Copy text from PDF" : "Copy text from image").setIcon("lucide-scan-text").onClick(() => void this.copyText(file)));
        menu.addItem((i) => i.setSection("action").setTitle("Extract text into a new note").setIcon("lucide-file-text").onClick(() => void this.extractToNote(file)));
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: any, view: any) => {
        const target = this.embedAtCursor(editor, view);
        if (!target) return;
        menu.addItem((i) => i.setSection("action").setTitle("Copy text from image").setIcon("lucide-scan-text").onClick(() => void this.copyText(target.file)));
        menu.addItem((i) => i.setSection("action").setTitle("Insert text from image below embed").setIcon("lucide-text-cursor-input").onClick(() => void this.insertBelow(target)));
      }),
    );
    // Right-click on a rendered image embed (reading view and Live Preview).
    this.registerDomEvent(
      document,
      "contextmenu",
      (evt: MouseEvent) => {
        const img = (evt.target as HTMLElement | null)?.closest?.("img");
        const embed = img?.closest<HTMLElement>(".internal-embed, .image-embed");
        if (!img || !embed) return;
        const target = this.targetFromEmbedEl(embed);
        if (!target) return;
        evt.preventDefault();
        evt.stopPropagation();
        const menu = new Menu();
        menu.addItem((i) => i.setTitle("Copy text from image").setIcon("lucide-scan-text").onClick(() => void this.copyText(target.file)));
        if (target.view) menu.addItem((i) => i.setTitle("Insert text from image below embed").setIcon("lucide-text-cursor-input").onClick(() => void this.insertBelow(target, embed)));
        menu.addItem((i) => i.setTitle("Extract text into a new note").setIcon("lucide-file-text").onClick(() => void this.extractToNote(target.file)));
        menu.showAtMouseEvent(evt);
      },
      true,
    );

    this.syncTextExtractorShim();
    for (const name of ["plugin-installed", "plugin-uninstalled", "plugin-loaded", "plugin-unloaded"]) {
      this.registerEvent(this.app.plugins.on(name, () => this.syncTextExtractorShim()));
    }
    this.instance.api = this.api;
    this.addSettingTab(new OcrSettingTab(this.app, this));
  }

  override onunload() {
    this.removeTextExtractorShim();
    void terminateOcr();
  }

  // ---- Text Extractor API -----------------------------------------------------------------

  readonly api = {
    extractText: (file: TFile): Promise<string> => this.extractText(file, { interactive: false }),
    canFileBeExtracted: (filePath: string): boolean => canFileBeExtracted(filePath),
    isInCache: async (file: TFile): Promise<boolean> => (await idb.get("cache", this.cacheKey(file)).catch(() => undefined)) !== undefined,
    getOcrLangs: (): string[] => OCR_LANGS.slice(),
  };

  handledByTextExtractor(): boolean {
    const plugins = this.app.plugins;
    return !!plugins.manifests?.[TEXT_EXTRACTOR_ID] && plugins.enabledPlugins?.has(TEXT_EXTRACTOR_ID) && plugins.isEnabled?.();
  }

  private syncTextExtractorShim() {
    const plugins = this.app.plugins;
    const realInstalled = !!plugins.manifests?.[TEXT_EXTRACTOR_ID];
    if (this.options.provideTextExtractorApi && !realInstalled) this.installTextExtractorShim();
    else this.removeTextExtractorShim();
  }

  private installTextExtractorShim() {
    if (this.shimInstalled) return;
    const registry = this.app.plugins.plugins as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(registry, TEXT_EXTRACTOR_ID)) return;
    const shim = {
      api: this.api,
      manifest: { id: TEXT_EXTRACTOR_ID, name: "Text recognition (built in)", version: "0.0.0", minAppVersion: "", author: "", description: "Text Extractor API provided by the Text recognition core plugin." },
      // internal marker so other code can tell the shim from the real plugin
      isBuiltInShim: true,
    };
    const plugins = this.app.plugins;
    // Non-enumerable, so the plugin manager never tries to unload it; any real
    // assignment (the real Text Extractor loading) replaces it with a plain property.
    Object.defineProperty(registry, TEXT_EXTRACTOR_ID, {
      configurable: true,
      enumerable: false,
      get: () => (plugins.manifests?.[TEXT_EXTRACTOR_ID] ? undefined : shim),
      set(value) {
        delete registry[TEXT_EXTRACTOR_ID];
        registry[TEXT_EXTRACTOR_ID] = value;
      },
    });
    this.shimInstalled = true;
  }

  private removeTextExtractorShim() {
    if (!this.shimInstalled) return;
    const registry = this.app.plugins.plugins as Record<string, unknown>;
    const desc = Object.getOwnPropertyDescriptor(registry, TEXT_EXTRACTOR_ID);
    if (desc?.get) delete registry[TEXT_EXTRACTOR_ID];
    this.shimInstalled = false;
  }

  refreshShim() {
    this.removeTextExtractorShim();
    this.syncTextExtractorShim();
  }

  private async importTextExtractorSettings() {
    if (this.options.importedTextExtractorSettings) return;
    try {
      const path = `${this.app.vault.configDir}/plugins/${TEXT_EXTRACTOR_ID}/data.json`;
      if (!(await this.app.vault.adapter.exists(path))) return;
      const data = JSON.parse(await this.app.vault.adapter.read(path));
      const langs = Array.isArray(data?.ocrLanguages) ? data.ocrLanguages.filter((l: unknown) => typeof l === "string" && OCR_LANGS.includes(l as string)) : [];
      if (langs.length) this.options.ocrLanguages = langs;
      this.options.importedTextExtractorSettings = true;
      await this.instance.saveOptions();
    } catch {
      /* no usable settings */
    }
  }

  // ---- extraction -------------------------------------------------------------------

  cacheKey(file: TFile): string {
    return `ocr:${this.app.appId}:${file.path}:${file.stat.mtime}:${file.stat.size}:${this.options.ocrLanguages.join("+")}`;
  }

  /**
   * Makes sure the language data exists. Interactive callers get a consent
   * dialog and a progress bar; API callers (search indexing) never download.
   */
  async ensureLanguageData(interactive: boolean): Promise<boolean> {
    const missing = await missingLangs(this.options.ocrLanguages);
    if (!missing.length) return true;
    if (!interactive) {
      if (!this.missingDataNoticeShown) {
        this.missingDataNoticeShown = true;
        new Notice("Text in images cannot be read yet: download the language data in Settings → Text recognition.", 8000);
      }
      return false;
    }
    const size = missing.reduce((n, l) => n + (APPROX_SIZE[l] ?? 2_000_000), 0);
    this.dialogOpen = true;
    try {
      return await this.downloadWithConsent(missing, size);
    } finally {
      this.dialogOpen = false;
    }
  }

  private async downloadWithConsent(missing: string[], size: number): Promise<boolean> {
    const ok = await askToDownload(this.app, {
      title: "Download text recognition data?",
      message: `Reading text in images needs the ${missing.map(langName).join(", ")} language model${missing.length > 1 ? "s" : ""} (about ${formatBytes(size)}) from ${LANG_DATA_HOST}.`,
      detail: "It is downloaded once and kept in this browser. Your images are never uploaded: recognition runs on this device.",
      cta: "Download",
    });
    if (!ok) return false;
    const modal = new ProgressModal(this.app, "Downloading text recognition data");
    modal.open();
    try {
      for (const [i, lang] of missing.entries()) {
        await downloadLang(
          lang,
          (loaded, total) => modal.setProgress(total ? (i + loaded / total) / missing.length : null, `${langName(lang)}: ${formatBytes(loaded)}${total ? ` of ${formatBytes(total)}` : ""}`),
          modal.signal,
        );
      }
      modal.finish("Downloaded.");
      modal.close();
      return true;
    } catch (e) {
      modal.done = true;
      modal.close();
      if (!isAbort(e)) new Notice(`Could not download the language data: ${(e as Error).message}`, 8000);
      return false;
    }
  }

  async extractText(file: TFile, opts: { interactive: boolean; onProgress?: (p: number | null, s: string) => void; signal?: AbortSignal }): Promise<string> {
    if (!canFileBeExtracted(file.path)) throw new Error("File type not supported");
    const key = this.cacheKey(file);
    const cached = await idb.get<string>("cache", key).catch(() => undefined);
    if (typeof cached === "string") return cached;
    const data = await this.app.vault.readBinary(file);
    let text = "";
    let complete = true;
    const common = { langs: this.options.ocrLanguages, useTextDetector: this.options.useTextDetector, onProgress: opts.onProgress, signal: opts.signal };
    if (isImagePath(file.path)) {
      // The TextDetector fast path needs no language data; try it before asking to download.
      if (this.options.useTextDetector && hasTextDetector()) {
        text = await recognizeImage(data, { ...common, langs: [] }).catch(() => "");
      }
      if (!text) {
        if (!(await this.ensureLanguageData(opts.interactive))) return "";
        text = await recognizeImage(data, { ...common, useTextDetector: false });
      }
    } else {
      const needOcr = this.options.ocrScannedPdfPages && (await missingLangs(this.options.ocrLanguages)).length === 0;
      text = await extractPdf(data, { ...common, ocrScannedPages: needOcr });
      complete = needOcr || !this.options.ocrScannedPdfPages;
      if (!text && !complete && opts.interactive && (await this.ensureLanguageData(true))) {
        text = await extractPdf(data, { ...common, ocrScannedPages: true });
        complete = true;
      }
    }
    // A PDF read without OCR (no language data yet) may have more text later.
    if (complete || text) await idb.set("cache", key, text).catch(() => {});
    return text;
  }

  /** Runs an extraction with a progress dialog; resolves to null when cancelled or failed. */
  async extractWithUi(file: TFile): Promise<string | null> {
    // Ask for the language data before any progress dialog, so the two never stack.
    if (isImagePath(file.path) && !(this.options.useTextDetector && hasTextDetector()) && !(await idb.get("cache", this.cacheKey(file)).catch(() => undefined))) {
      if (!(await this.ensureLanguageData(true))) return null;
    }
    let modal: ProgressModal | null = null;
    let timer = 0;
    const showProgress = () => {
      if (this.dialogOpen) {
        timer = window.setTimeout(showProgress, 400);
        return;
      }
      modal = new ProgressModal(this.app, `Reading text in ${file.name}`);
      modal.open();
    };
    timer = window.setTimeout(showProgress, 400);
    try {
      const text = await this.extractText(file, {
        interactive: true,
        onProgress: (p, s) => (modal as ProgressModal | null)?.setProgress(p, s),
        signal: undefined,
      });
      return text;
    } catch (e) {
      if (!isAbort(e)) new Notice(`Could not read text in ${file.name}: ${(e as Error).message}`, 8000);
      return null;
    } finally {
      clearTimeout(timer);
      const m = modal as ProgressModal | null;
      if (m) {
        m.done = true;
        m.close();
      }
    }
  }

  async copyText(file: TFile) {
    const text = await this.extractWithUi(file);
    if (text === null) return;
    if (!text) {
      new Notice(`No text found in ${file.name}.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      new Notice(`Copied ${text.length.toLocaleString()} characters from ${file.name}.`);
    } catch {
      new Notice("The browser did not allow copying to the clipboard.");
    }
  }

  async insertBelow(target: EmbedTarget, embedEl?: HTMLElement) {
    const text = await this.extractWithUi(target.file);
    if (text === null) return;
    if (!text) {
      new Notice(`No text found in ${target.file.name}.`);
      return;
    }
    const view = target.view;
    const editor = view?.editor;
    let line = target.line;
    if (editor && embedEl && editor.cm && view.getMode?.() !== "preview") {
      try {
        line = editor.cm.state.doc.lineAt(editor.cm.posAtDOM(embedEl)).number - 1;
      } catch {
        /* keep line */
      }
    }
    if (editor && view.getMode?.() !== "preview" && line !== undefined) {
      const end = { line, ch: editor.getLine(line).length };
      const nextLineBlank = line + 1 >= editor.lineCount() || !editor.getLine(line + 1).trim();
      editor.replaceRange(`\n${text}${nextLineBlank ? "" : "\n"}`, end);
      return;
    }
    // Reading view: write to the file below the first line that embeds the image.
    const source = this.app.vault.getFileByPath(target.sourcePath);
    if (!source) return;
    await this.app.vault.process(source, (data: string) => {
      const lines = data.split("\n");
      const idx = line ?? lines.findIndex((l) => l.includes(target.file.name) || l.includes(encodeURI(target.file.name)));
      if (idx < 0) return data;
      lines.splice(idx + 1, 0, text);
      return lines.join("\n");
    });
  }

  async extractToNote(file: TFile) {
    const text = await this.extractWithUi(file);
    if (text === null) return;
    const folder = file.parent?.path && file.parent.path !== "/" ? `${file.parent.path}/` : "";
    const path = this.app.vault.getAvailablePath(`${folder}${file.basename} (text)`, "md");
    const link = this.app.fileManager.generateMarkdownLink(file, path);
    const note = await this.app.vault.create(path, `${text}\n\n!${link.replace(/^!/, "")}\n`);
    await this.app.workspace.getLeaf("tab").openFile(note);
  }

  // ---- targets ----------------------------------------------------------------------

  private resolve(linkpath: string, sourcePath: string): TFile | null {
    const clean = linkpath.split("#")[0]!.split("|")[0]!.trim();
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      /* keep */
    }
    const f = this.app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
    return f && canFileBeExtracted(f.path) ? f : null;
  }

  embedAtCursor(editor: any, view: any): EmbedTarget | null {
    if (!editor || !view?.file) return null;
    const cursor = editor.getCursor();
    const text: string = editor.getLine(cursor.line);
    const re = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(<?([^)>]+)>?\)/g;
    let best: EmbedTarget | null = null;
    for (let m; (m = re.exec(text)); ) {
      const link = m[1] ?? m[2] ?? "";
      if (/^[a-z]+:\/\//i.test(link)) continue;
      const file = this.resolve(link, view.file.path);
      if (!file) continue;
      const candidate = { file, sourcePath: view.file.path, view, line: cursor.line };
      if (cursor.ch >= m.index && cursor.ch <= m.index + m[0].length) return candidate;
      best ??= candidate;
    }
    return best;
  }

  targetFromActive(needEmbed = false): EmbedTarget | null {
    const view = this.app.workspace.getActiveFileView?.() ?? this.app.workspace.activeLeaf?.view;
    if (!view) return null;
    if (view.editor && view.getViewType?.() === "markdown") return this.embedAtCursor(view.editor, view);
    if (needEmbed) return null;
    const file = view.file as TFile | null;
    if (file && canFileBeExtracted(file.path)) return { file, sourcePath: file.path };
    return null;
  }

  private targetFromEmbedEl(embed: HTMLElement): EmbedTarget | null {
    const src = embed.getAttr("src");
    let view: any = null;
    this.app.workspace.iterateAllLeaves((leaf: any) => {
      if (!view && leaf.view?.containerEl?.contains(embed)) view = leaf.view;
    });
    const sourcePath = view?.file?.path ?? this.app.workspace.getActiveFile()?.path ?? "";
    if (!src) return null;
    const file = this.resolve(src, sourcePath);
    if (!file) return null;
    return { file, sourcePath, view: view?.getViewType?.() === "markdown" ? view : undefined };
  }
}

class OcrSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: OcrPlugin,
  ) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();
    if (this.owner.handledByTextExtractor()) {
      containerEl.createDiv({ cls: "vault-device-handled-by setting-item-description", text: "Handled by Text Extractor: that community plugin is enabled, so its commands and API are used instead." });
    }
    containerEl.createDiv({
      cls: "setting-item-description vault-device-intro",
      text: "Reads text in images and scanned PDFs on this device. Language data downloads once, when you first use it.",
    });

    const langSetting = new Setting(containerEl).setName("Languages").setDesc("Recognition is slower with each extra language.");
    const chips = langSetting.controlEl.createDiv({ cls: "vault-ocr-langs" });
    for (const lang of o.ocrLanguages) {
      const chip = chips.createSpan({ cls: "vault-ocr-lang-chip", text: langName(lang) });
      const x = chip.createSpan({ cls: "vault-ocr-lang-remove", text: "×", attr: { "aria-label": `Remove ${langName(lang)}`, role: "button" } });
      x.addEventListener("click", () => {
        if (o.ocrLanguages.length <= 1) return;
        o.ocrLanguages = o.ocrLanguages.filter((l) => l !== lang);
        save();
        this.owner.refreshShim();
        this.display();
      });
    }
    langSetting.addDropdown((d) => {
      d.addOption("", "Add language…");
      for (const code of OCR_LANGS) if (!o.ocrLanguages.includes(code)) d.addOption(code, langName(code));
      d.onChange((v) => {
        if (!v) return;
        o.ocrLanguages = [...o.ocrLanguages, v];
        save();
        this.display();
      });
    });

    const data = new Setting(containerEl).setName("Language data").setDesc("Checking…");
    void (async () => {
      const cached: string[] = [];
      for (const l of o.ocrLanguages) if (await isLangCached(l)) cached.push(l);
      const missing = o.ocrLanguages.filter((l) => !cached.includes(l));
      data.setDesc(missing.length ? `Not downloaded yet: ${missing.map(langName).join(", ")}. Downloaded from ${LANG_DATA_HOST} after you agree.` : `Downloaded: ${cached.map(langName).join(", ")}.`);
      if (missing.length) data.addButton((b) => b.setButtonText("Download").setCta().onClick(async () => {
        if (await this.owner.ensureLanguageData(true)) this.display();
      }));
      if (cached.length) data.addButton((b) =>
        b.setButtonText("Delete downloaded data").onClick(async () => {
          await terminateOcr();
          await deleteLangData();
          new Notice("Deleted the text recognition data.");
          this.display();
        }),
      );
    })();

    new Setting(containerEl)
      .setName("Use the browser's text detection")
      .setDesc(hasTextDetector() ? "This browser has a built-in text detector (Shape Detection API). It is tried first; it needs no download." : "This browser has no built-in text detector (Shape Detection API), so Tesseract is always used.")
      .addToggle((t) => t.setValue(o.useTextDetector).onChange((v) => ((o.useTextDetector = v), save())));
    new Setting(containerEl)
      .setName("Recognise scanned PDF pages")
      .setDesc("PDF pages without a text layer are rendered and read with OCR. Slow for long documents.")
      .addToggle((t) => t.setValue(o.ocrScannedPdfPages).onChange((v) => ((o.ocrScannedPdfPages = v), save())));
    new Setting(containerEl)
      .setName("Provide Text Extractor's API to other plugins")
      .setDesc("Lets plugins such as Omnisearch index the text in images and PDFs. Turned off automatically while Text Extractor itself is installed.")
      .addToggle((t) =>
        t.setValue(o.provideTextExtractorApi).onChange((v) => {
          o.provideTextExtractorApi = v;
          save();
          this.owner.refreshShim();
        }),
      );
    new Setting(containerEl)
      .setName("Extracted text cache")
      .setDesc("Text already read from a file is reused until the file changes.")
      .addButton((b) =>
        b.setButtonText("Clear cache").onClick(async () => {
          const entries = await idb.entries("cache", `ocr:${this.app.appId}:`).catch(() => [] as [string, unknown][]);
          for (const [k] of entries) await idb.delete("cache", k).catch(() => {});
          new Notice(`Cleared ${entries.length} cached extraction${entries.length === 1 ? "" : "s"}.`);
        }),
      );
  }
}
