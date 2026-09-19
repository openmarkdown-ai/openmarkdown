/**
 * Importer — bring notes in from other apps.
 *
 * In Obsidian this is the official community plugin `obsidian-importer`; the
 * core id `markdown-importer` belongs to the Format converter, so this one is
 * registered as `importer`. The conversions themselves live in Rust
 * (`crates/vault-clip/src/import`); this file reads the chosen files, runs the
 * importer, and writes what comes back into the vault without overwriting.
 */
import { getEngine } from "@vault/engine";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { ProgressBarComponent, Setting } from "../../obsidian/ui/setting";
import { normalizePath } from "../../obsidian/util";
import { importCsv, importHtml, importMarkdown, sanitizeName, type ImportOutput, type InputFile, type OutputFile } from "./fallback";

interface FormatInfo {
  kind: string;
  name: string;
  accept: string;
  hint: string;
  /** Offer a folder picker. */
  folder?: boolean;
  /** Offer a file picker. */
  files?: boolean;
  multiple?: boolean;
}

export const FORMATS: FormatInfo[] = [
  { kind: "enex", name: "Evernote (.enex)", accept: ".enex", hint: "One or more notebooks exported from Evernote as .enex files.", files: true, multiple: true },
  { kind: "html", name: "HTML files", accept: ".html,.htm", hint: "HTML files, or a folder of them with their images.", files: true, folder: true, multiple: true },
  { kind: "notion", name: "Notion (.zip)", accept: ".zip", hint: "A Notion workspace export: HTML format, “Include subpages” and “Create folders for subpages” on.", files: true, multiple: true },
  { kind: "roam", name: "Roam Research (.json)", accept: ".json", hint: "A Roam graph exported as JSON.", files: true, multiple: true },
  { kind: "keep", name: "Google Keep (Takeout)", accept: ".zip,.json", hint: "The Google Takeout .zip for Keep, or the .json files inside it.", files: true, folder: true, multiple: true },
  { kind: "bear", name: "Bear (.bear2bk)", accept: ".bear2bk,.zip", hint: "A Bear backup (File → Backup Notes) or iOS ApplicationData.zip.", files: true },
  { kind: "logseq", name: "Logseq graph (folder)", accept: "", hint: "The graph folder that contains pages, journals and assets.", folder: true },
  { kind: "textbundle", name: "Textbundle (.textbundle, .textpack)", accept: ".textbundle,.textpack,.zip", hint: "Textbundle folders or .textpack files.", files: true, folder: true, multiple: true },
  { kind: "csv", name: "CSV", accept: ".csv", hint: "Each row becomes a note; columns become properties.", files: true, multiple: true },
  { kind: "markdown", name: "Markdown folder", accept: ".md,.markdown,.txt", hint: "A folder of Markdown files and attachments, copied as they are.", files: true, folder: true, multiple: true },
];

const ENGINE_MISSING = "This format needs the vault engine, which is not available in this build.";

class ImporterPlugin extends Plugin {
  instance!: any;

  override onload() {
    this.addCommand({ id: "importer:open", name: "Import notes…", icon: "lucide-import", callback: () => new ImportModal(this.app).open() });
    this.addRibbonIcon("lucide-import", "Import notes", () => new ImportModal(this.app).open());
    this.instance.openModal = () => new ImportModal(this.app).open();
  }
}

interface EngineResultLike {
  files?: { path: string; data: Uint8Array | number[] | string; ctimeMs?: number; mtimeMs?: number }[];
  notes?: { path: string; content: string }[];
  attachments?: { path: string; data: Uint8Array }[];
  warnings?: string[];
}

function normalizeEngineResult(r: EngineResultLike): ImportOutput {
  const files: OutputFile[] = [];
  for (const f of r.files ?? []) {
    const data = typeof f.data === "string" ? f.data : f.data instanceof Uint8Array ? f.data : Uint8Array.from(f.data);
    files.push({ path: f.path, data, ctimeMs: f.ctimeMs, mtimeMs: f.mtimeMs });
  }
  for (const n of r.notes ?? []) files.push({ path: n.path, data: n.content });
  for (const a of r.attachments ?? []) files.push({ path: a.path, data: a.data });
  return { files, warnings: r.warnings ?? [] };
}

export function runImport(kind: string, files: InputFile[], options: Record<string, unknown>): ImportOutput {
  let engineError: unknown = null;
  try {
    const r = getEngine().importer.run(kind, files, options) as unknown as EngineResultLike;
    if (r && typeof r === "object") return normalizeEngineResult(r);
  } catch (e) {
    engineError = e;
  }
  if (kind === "markdown") return importMarkdown(files);
  if (kind === "html") return importHtml(files);
  if (kind === "csv") return importCsv(files, options as { hasHeaderRow?: boolean; titleColumn?: string; bodyColumn?: string });
  console.warn("Importer engine unavailable", engineError);
  throw new Error(ENGINE_MISSING);
}

export class ImportModal extends Modal {
  private format: FormatInfo = FORMATS[0]!;
  private chosen: File[] = [];
  private outputFolder = "";
  private outputEdited = false;
  private options: Record<string, unknown> = {};
  private running = false;
  private bodyEl!: HTMLElement;

  constructor(app: any) {
    super(app);
    this.modalEl.addClass("mod-importer");
  }

  override onOpen() {
    this.setTitle("Import notes");
    this.render();
  }

  override onClose() {
    this.contentEl.empty();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.outputEdited) this.outputFolder = `Imported from ${this.format.name.replace(/\s*\(.*\)$/, "")}`;

    new Setting(contentEl).setName("File format").addDropdown((d) => {
      for (const f of FORMATS) d.addOption(f.kind, f.name);
      d.setValue(this.format.kind).onChange((v) => {
        this.format = FORMATS.find((f) => f.kind === v) ?? FORMATS[0]!;
        this.chosen = [];
        this.options = {};
        this.render();
      });
    });

    const pick = new Setting(contentEl).setName("Files to import").setDesc(this.format.hint);
    const countEl = pick.descEl.createDiv({ cls: "importer-selection", text: this.selectionText() });
    const makeInput = (folder: boolean) => {
      const input = createEl("input", { type: "file" });
      input.hide();
      if (folder) {
        input.setAttr("webkitdirectory", "");
        input.setAttr("directory", "");
        input.multiple = true;
      } else {
        if (this.format.accept) input.accept = this.format.accept;
        input.multiple = !!this.format.multiple;
      }
      input.addEventListener("change", () => {
        this.chosen = Array.from(input.files ?? []);
        countEl.setText(this.selectionText());
      });
      contentEl.appendChild(input);
      return input;
    };
    if (this.format.files) {
      const input = makeInput(false);
      pick.addButton((b) => b.setButtonText(this.format.multiple ? "Choose files" : "Choose file").onClick(() => input.click()));
    }
    if (this.format.folder) {
      const input = makeInput(true);
      pick.addButton((b) => b.setButtonText("Choose folder").onClick(() => input.click()));
    }

    new Setting(contentEl)
      .setName("Output folder")
      .setDesc("Imported notes go in this folder. Existing files are never overwritten.")
      .addText((t) =>
        t.setValue(this.outputFolder).onChange((v) => {
          this.outputFolder = v;
          this.outputEdited = true;
        }),
      );

    this.renderOptions(contentEl);

    this.bodyEl = contentEl.createDiv({ cls: "importer-status" });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const importBtn = buttons.createEl("button", { cls: "mod-cta", text: "Import" });
    importBtn.addEventListener("click", () => void this.run(importBtn));
    buttons.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
  }

  private renderOptions(el: HTMLElement) {
    const toggle = (key: string, name: string, desc: string, def: boolean) => {
      if (this.options[key] === undefined) this.options[key] = def;
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) => t.setValue(!!this.options[key]).onChange((v) => (this.options[key] = v)));
    };
    const text = (key: string, name: string, desc: string, placeholder: string) => {
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t
            .setPlaceholder(placeholder)
            .setValue(String(this.options[key] ?? ""))
            .onChange((v) => {
              if (v.trim()) this.options[key] = v.trim();
              else delete this.options[key];
            }),
        );
    };
    switch (this.format.kind) {
      case "enex":
        toggle("dateProperties", "Add dates as properties", "Write created and updated properties.", true);
        toggle("skipWebClips", "Skip web clips", "Leave out notes saved with the Evernote Web Clipper.", false);
        break;
      case "roam":
        toggle("deOutline", "Flatten outlines", "Turn Roam's nested bullets into paragraphs.", false);
        toggle("embedBlockReferences", "Embed block references", "Write ((uid)) references as embeds rather than links.", false);
        break;
      case "keep":
        toggle("importArchived", "Import archived notes", "", true);
        toggle("importTrashed", "Import deleted notes", "", false);
        break;
      case "bear":
        toggle("tagsAsProperty", "Tags as properties", "Move inline tags into the tags property.", false);
        break;
      case "csv":
        toggle("hasHeaderRow", "First row is a header", "Otherwise columns are named Column 1, Column 2, …", true);
        text("titleColumn", "Title column", "The column that names each note. Default: the first column.", "Name");
        text("bodyColumn", "Body column", "A column to use as the note text instead of a property.", "");
        break;
    }
  }

  private selectionText(): string {
    const n = this.chosen.length;
    return n === 0 ? "Nothing selected." : n === 1 ? `Selected: ${this.chosen[0]!.name}` : `${n} files selected.`;
  }

  private async run(button: HTMLButtonElement) {
    if (this.running) return;
    if (this.chosen.length === 0) {
      new Notice("Choose what to import first.");
      return;
    }
    this.running = true;
    button.disabled = true;
    const status = this.bodyEl;
    status.empty();
    const label = status.createDiv({ cls: "importer-progress-label", text: "Reading files…" });
    const bar = new ProgressBarComponent(status);
    const report = { notes: 0, attachments: 0, skipped: 0, failed: 0, warnings: [] as string[] };
    try {
      const inputs: InputFile[] = [];
      for (let i = 0; i < this.chosen.length; i++) {
        const f = this.chosen[i]!;
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        inputs.push({ path: rel, data: new Uint8Array(await f.arrayBuffer()) });
        bar.setValue(((i + 1) / this.chosen.length) * 30);
      }
      label.setText("Converting…");
      await new Promise((r) => setTimeout(r, 20));
      const options: Record<string, unknown> = { ...this.options };
      if (this.format.kind === "enex" && inputs.length > 1) options.notebookFromFileName = true;
      const result = runImport(this.format.kind, inputs, options);
      report.warnings.push(...result.warnings);
      bar.setValue(40);
      label.setText("Writing notes…");
      const root = normalizePath(this.outputFolder.trim() || "Imported");
      const total = result.files.length || 1;
      for (let i = 0; i < result.files.length; i++) {
        const out = result.files[i]!;
        try {
          const kind = await writeImported(this.app, root, out);
          if (kind === "note") report.notes++;
          else if (kind === "attachment") report.attachments++;
          else report.skipped++;
        } catch (e) {
          report.failed++;
          report.warnings.push(`${out.path}: ${(e as Error)?.message ?? e}`);
        }
        if (i % 10 === 0) {
          bar.setValue(40 + ((i + 1) / total) * 60);
          label.setText(`Writing notes… ${i + 1} / ${result.files.length}`);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      bar.setValue(100);
      label.setText("Import complete.");
      this.renderReport(status, report, root);
    } catch (e) {
      label.setText("Import failed.");
      status.createDiv({ cls: "importer-error mod-warning", text: String((e as Error)?.message ?? e) });
    } finally {
      this.running = false;
      button.disabled = false;
    }
  }

  private renderReport(el: HTMLElement, r: { notes: number; attachments: number; skipped: number; failed: number; warnings: string[] }, root: string) {
    const box = el.createDiv({ cls: "importer-report" });
    const row = (name: string, value: number) => {
      const line = box.createDiv({ cls: "importer-report-row" });
      line.createSpan({ cls: "importer-report-name", text: name });
      line.createSpan({ cls: "importer-report-value", text: String(value) });
    };
    row("Notes imported", r.notes);
    row("Attachments imported", r.attachments);
    row("Skipped", r.skipped);
    row("Failed", r.failed);
    if (r.warnings.length) {
      const details = box.createEl("details", { cls: "importer-warnings" });
      details.createEl("summary", { text: `${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}` });
      const list = details.createEl("ul");
      for (const w of r.warnings.slice(0, 500)) list.createEl("li", { text: w });
    }
    const folder = this.app.vault.getFolderByPath(root);
    if (folder && r.notes > 0) {
      const btn = box.createEl("button", { text: "Reveal in file explorer" });
      btn.addEventListener("click", () => {
        this.close();
        (this.app.internalPlugins.getEnabledPluginById("file-explorer") as { revealInFolder?: (f: unknown) => void } | null)?.revealInFolder?.(folder);
      });
    }
  }
}

async function ensureFolder(app: any, path: string) {
  if (!path || path === "/") return;
  const segs = path.split("/");
  let cur = "";
  for (const s of segs) {
    cur = cur ? `${cur}/${s}` : s;
    const existing = app.vault.getAbstractFileByPath(cur);
    if (!existing) await app.vault.createFolder(cur).catch(() => {});
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Write one imported file under `root`, choosing a free name. */
async function writeImported(app: any, root: string, file: OutputFile): Promise<"note" | "attachment" | "skipped"> {
  const rel = file.path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .map((s, i, all) => (i === all.length - 1 ? s.replace(/[\\:*?"<>|]/g, " ").trim() : sanitizeName(s)))
    .join("/");
  if (!rel) return "skipped";
  const full = normalizePath(`${root}/${rel}`);
  const slash = full.lastIndexOf("/");
  const dir = slash === -1 ? "" : full.slice(0, slash);
  await ensureFolder(app, dir);
  const name = full.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  const base = dot > 0 ? full.slice(0, full.length - extension.length - 1) : full;
  const path = app.vault.getAvailablePath(base, extension);
  const opts = file.mtimeMs || file.ctimeMs ? { ctime: file.ctimeMs, mtime: file.mtimeMs ?? file.ctimeMs } : undefined;
  if (extension.toLowerCase() === "md") {
    const text = typeof file.data === "string" ? file.data : decoder.decode(file.data);
    await app.vault.create(path, text, opts);
    return "note";
  }
  const bytes = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await app.vault.createBinary(path, buffer, opts);
  return "attachment";
}

export const importer: CorePluginDefinition = {
  id: "importer",
  name: "Importer",
  description: "Import notes from other apps: Evernote, Notion, Roam, Google Keep, Bear, Logseq, HTML, CSV and Markdown.",
  icon: "lucide-import",
  defaultOn: true,
  defaultOptions: {},
  create: (app) => new ImporterPlugin(app, { id: "importer", name: "Importer", version: "", minAppVersion: "", author: "", description: "" }),
};
