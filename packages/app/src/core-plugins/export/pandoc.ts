/**
 * "Export with pandoc…": LaTeX, ODT, RTF, PowerPoint and more through the
 * official pandoc.wasm, which is GPL-licensed and about 59 MB. It is never
 * bundled: the user agrees to download it (or picks a copy they downloaded),
 * it is checked, kept in Cache Storage, and run in a worker.
 */
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import { parseLinktext, requestUrl } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";
import type { PandocRequest, PandocResponse } from "./pandoc-worker";
import { safeFileName, stripFrontmatter } from "./render";

export const PANDOC_URL = "https://pandoc.org/app/pandoc.wasm";
/** SHA-256 of the build this integration was tested with (pandoc 3.9, 59,163,604 bytes). */
export const PANDOC_SHA256 = "44829227ac8f74fb57387d12ac7e347e89fa851510e089263d27f5af2e266332";
const PANDOC_SIZE_MB = 59;
const CACHE = "vault-pandoc-v1";
const CACHE_KEY = "/vault-pandoc/pandoc.wasm";

export const PANDOC_FORMATS: Record<string, { label: string; ext: string; binary: boolean }> = {
  latex: { label: "LaTeX", ext: "tex", binary: false },
  odt: { label: "OpenDocument (ODT)", ext: "odt", binary: true },
  rtf: { label: "Rich Text Format (RTF)", ext: "rtf", binary: false },
  docx: { label: "Word via pandoc (DOCX)", ext: "docx", binary: true },
  pptx: { label: "PowerPoint (PPTX)", ext: "pptx", binary: true },
  epub3: { label: "EPUB via pandoc", ext: "epub", binary: true },
  typst: { label: "Typst", ext: "typ", binary: false },
  html5: { label: "HTML (standalone)", ext: "html", binary: false },
  rst: { label: "reStructuredText", ext: "rst", binary: false },
  asciidoc: { label: "AsciiDoc", ext: "adoc", binary: false },
  org: { label: "Org mode", ext: "org", binary: false },
  mediawiki: { label: "MediaWiki", ext: "wiki", binary: false },
  jats: { label: "JATS XML", ext: "xml", binary: false },
  gfm: { label: "GitHub Markdown", ext: "md", binary: false },
};

async function sha256(data: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cachedPandoc(): Promise<ArrayBuffer | null> {
  try {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(CACHE_KEY);
    return hit ? await hit.arrayBuffer() : null;
  } catch {
    return null;
  }
}

async function storePandoc(data: ArrayBuffer) {
  try {
    const cache = await caches.open(CACHE);
    await cache.put(CACHE_KEY, new Response(data, { headers: { "content-type": "application/wasm" } }));
  } catch {
    /* no Cache Storage (private window): it is downloaded again next time */
  }
}

export async function removePandocCache() {
  try {
    await caches.delete(CACHE);
  } catch {
    /* nothing cached */
  }
}

function looksLikePandoc(data: ArrayBuffer): boolean {
  try {
    const names = WebAssembly.Module.exports(new WebAssembly.Module(data)).map((e) => e.name);
    return names.includes("convert") && names.includes("hs_init_with_rtsopts");
  } catch {
    return false;
  }
}

/** Download pandoc.wasm: directly if the host allows it, else through the companion extension. */
export async function downloadPandoc(onProgress: (msg: string) => void): Promise<ArrayBuffer> {
  let data: ArrayBuffer | null = null;
  try {
    onProgress(`Downloading pandoc (${PANDOC_SIZE_MB} MB)…`);
    const res = await fetch(PANDOC_URL, { mode: "cors" });
    if (res.ok) data = await res.arrayBuffer();
  } catch {
    /* pandoc.org sends no CORS headers; try the bridge */
  }
  if (!data) {
    const res = await requestUrl({ url: PANDOC_URL, throw: false });
    if (res.status !== 200) throw new Error("pandoc.org cannot be reached from this page. Install the companion extension, or download pandoc.wasm yourself and choose the file.");
    data = res.arrayBuffer;
  }
  onProgress("Checking the download…");
  const hash = await sha256(data);
  if (hash !== PANDOC_SHA256) throw new Error(`The downloaded pandoc.wasm does not match the tested build (SHA-256 ${hash.slice(0, 12)}…). Choose a copy of the tested build instead.`);
  await storePandoc(data);
  return data;
}

export async function acceptPandocFile(file: Blob): Promise<ArrayBuffer> {
  const data = await file.arrayBuffer();
  if (!looksLikePandoc(data)) throw new Error("That file is not pandoc.wasm.");
  await storePandoc(data);
  return data;
}

// ---- Markdown for pandoc ------------------------------------------------------------

/**
 * Obsidian Markdown → pandoc Markdown: wikilinks become text or links, image
 * embeds become `![](path)` with the file handed to pandoc, note embeds are
 * inlined, callouts become quotes with a bold title, comments are removed.
 */
export async function portableMarkdown(app: any, file: TFile, files: Record<string, Uint8Array>, depth = 0): Promise<string> {
  let text = stripFrontmatter(await app.vault.cachedRead(file));
  text = text.replace(/%%[\s\S]*?%%/g, "");
  const embeds: { match: string; replacement: string }[] = [];
  for (const m of text.matchAll(/!\[\[([^\]]+)\]\]/g)) {
    const [target, alias] = m[1]!.split("|");
    const { path, subpath } = parseLinktext(target!.trim());
    const dest: TFile | null = app.metadataCache.getFirstLinkpathDest(path, file.path);
    let replacement = "";
    if (dest && dest.extension === "md" && depth < 3 && !subpath) {
      replacement = await portableMarkdown(app, dest, files, depth + 1);
    } else if (dest && /^(png|jpe?g|gif|svg|webp|bmp)$/i.test(dest.extension)) {
      files[dest.path] = new Uint8Array(await app.vault.readBinary(dest));
      const width = alias && /^\d+/.test(alias) ? `{width=${alias.split("x")[0]}px}` : "";
      replacement = `![${alias && !/^\d/.test(alias) ? alias : ""}](${dest.path.replace(/ /g, "%20")})${width}`;
    } else {
      replacement = alias ?? target ?? "";
    }
    embeds.push({ match: m[0], replacement });
  }
  for (const e of embeds) text = text.replace(e.match, () => e.replacement);
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, (_, t: string) => t.replace(/#\^?/, " > "));
  text = text.replace(/^(>+)\s*\[!(\w[\w-]*)\][+-]?\s*(.*)$/gm, (_, q: string, type: string, title: string) => `${q} **${title.trim() || type.charAt(0).toUpperCase() + type.slice(1)}**\n${q}`);
  text = text.replace(/(^|\s)\^[\w-]+$/gm, "$1");
  return text;
}

/** Parse the few command-line options that map onto pandoc defaults keys. */
export function argsToDefaults(args: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const vars: Record<string, string> = {};
  const parts = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!.replace(/^["']|["']$/g, "");
    const [flag, inline] = p.includes("=") && p.startsWith("--") ? [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)] : [p, undefined];
    const value = () => inline ?? parts[++i]?.replace(/^["']|["']$/g, "") ?? "";
    switch (flag) {
      case "--toc":
      case "--table-of-contents":
        out["table-of-contents"] = true;
        break;
      case "-N":
      case "--number-sections":
        out["number-sections"] = true;
        break;
      case "-s":
      case "--standalone":
        out.standalone = true;
        break;
      case "--toc-depth":
        out["toc-depth"] = Number(value());
        break;
      case "-V":
      case "--variable": {
        const v = value();
        const eq = v.indexOf("=");
        if (eq > 0) vars[v.slice(0, eq)] = v.slice(eq + 1);
        break;
      }
      case "-M":
      case "--metadata": {
        const v = value();
        const eq = v.indexOf("=");
        if (eq > 0) ((out.metadata ??= {}) as Record<string, string>)[v.slice(0, eq)] = v.slice(eq + 1);
        break;
      }
      case "--shift-heading-level-by":
        out["shift-heading-level-by"] = Number(value());
        break;
      case "--wrap":
        out.wrap = value();
        break;
    }
  }
  if (Object.keys(vars).length) out.variables = vars;
  return out;
}

export async function runPandoc(wasm: ArrayBuffer, options: Record<string, unknown>, stdin: string, files: Record<string, Uint8Array>): Promise<PandocResponse> {
  const worker = new Worker(new URL("./pandoc-worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<PandocResponse>((resolve, reject) => {
      worker.onmessage = (evt: MessageEvent<PandocResponse>) => resolve(evt.data);
      worker.onerror = (evt) => reject(new Error(evt.message || "pandoc worker failed"));
      const req: PandocRequest = { wasm: wasm.slice(0), options, stdin, files };
      worker.postMessage(req);
    });
  } finally {
    worker.terminate();
  }
}

export class PandocExportModal extends Modal {
  private format = "latex";

  constructor(
    app: any,
    private plugin: { options: { pandocConsented: boolean; pandocExtraArgs: string }; instance: any; save(blob: Blob, name: string, near: TFile): Promise<void> },
    private files: TFile[],
  ) {
    super(app);
    this.modalEl.addClass("vault-export-modal", "mod-pandoc-export");
  }

  override async onOpen() {
    this.setTitle("Export with pandoc");
    const { contentEl } = this;
    const cached = await cachedPandoc();
    new Setting(contentEl).setName("Format").addDropdown((d) => {
      for (const [id, f] of Object.entries(PANDOC_FORMATS)) d.addOption(id, f.label);
      d.setValue(this.format).onChange((v) => (this.format = v));
    });
    new Setting(contentEl)
      .setName("Extra arguments")
      .setDesc("--toc, --number-sections, -V key=value, -M key=value, --wrap, --toc-depth")
      .addText((t) => t.setValue(this.plugin.options.pandocExtraArgs).onChange((v) => ((this.plugin.options.pandocExtraArgs = v), void this.plugin.instance.saveOptions())));

    const consent = contentEl.createDiv({ cls: "vault-pandoc-consent" });
    const status = contentEl.createDiv({ cls: "setting-item-description vault-pandoc-status" });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const run = buttons.createEl("button", { cls: "mod-cta", text: cached ? "Export" : `Download pandoc (${PANDOC_SIZE_MB} MB) and export` });
    const pick = buttons.createEl("button", { text: "Choose pandoc.wasm…" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    if (cached) {
      pick.hide();
    } else {
      consent.createEl("p", { text: `Pandoc is not part of this app. The first export downloads the official pandoc.wasm from pandoc.org (about ${PANDOC_SIZE_MB} MB) and keeps it in this browser. Pandoc is free software under the GNU GPL; it runs on this device and nothing is uploaded.` });
      consent.createEl("p", { text: "If this page cannot reach pandoc.org, download pandoc.wasm yourself and choose the file." });
    }
    const input = contentEl.createEl("input", { type: "file", attr: { accept: ".wasm,application/wasm", hidden: "" } });
    pick.addEventListener("click", () => input.click());

    const go = async (getWasm: () => Promise<ArrayBuffer>) => {
      run.disabled = pick.disabled = true;
      try {
        const wasm = await getWasm();
        this.plugin.options.pandocConsented = true;
        void this.plugin.instance.saveOptions();
        status.setText("Converting…");
        await this.convert(wasm);
        this.close();
      } catch (e) {
        status.setText(String((e as Error)?.message ?? e));
        status.addClass("mod-warning");
      } finally {
        run.disabled = pick.disabled = false;
      }
    };
    run.addEventListener("click", () => void go(async () => cached ?? (await downloadPandoc((m) => status.setText(m)))));
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (f) void go(() => acceptPandocFile(f));
    });
  }

  private async convert(wasm: ArrayBuffer) {
    const fmt = PANDOC_FORMATS[this.format]!;
    const files: Record<string, Uint8Array> = {};
    const parts: string[] = [];
    for (const f of this.files) {
      const md = await portableMarkdown(this.app, f, files);
      parts.push(this.files.length > 1 ? `# ${f.basename}\n\n${md}` : md);
    }
    const first = this.files[0]!;
    const fm = (this.app.metadataCache.getFileCache(first)?.frontmatter ?? {}) as Record<string, unknown>;
    const outName = `output.${fmt.ext}`;
    const options: Record<string, unknown> = {
      from: "markdown+wikilinks_title_after_pipe+mark-yaml_metadata_block",
      to: this.format,
      standalone: true,
      "output-file": outName,
      metadata: { title: typeof fm.title === "string" ? fm.title : first.basename, ...(typeof fm.author === "string" ? { author: fm.author } : {}) },
      ...argsToDefaults(this.plugin.options.pandocExtraArgs),
    };
    const res = await runPandoc(wasm, options, parts.join("\n\n"), files);
    if (!res.ok || !res.output) throw new Error(`pandoc: ${res.error ?? res.stderr ?? "failed"}`);
    const blob = new Blob([res.output as Uint8Array<ArrayBuffer>], { type: fmt.binary ? "application/octet-stream" : "text/plain" });
    await this.plugin.save(blob, `${safeFileName(first.basename)}.${fmt.ext}`, first);
    new Notice(`Exported ${fmt.label}.`);
  }

  override onClose() {
    this.contentEl.empty();
  }
}
