/**
 * Local images (`local-images`) — download remote images into the vault and
 * rewrite links to them. Replaces Local Images Plus and Local images (both
 * desktop-only); steps aside when either is enabled.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import type { TFile } from "../../obsidian/vault/files";
import { communityPluginEnabled } from "../smart-paste/network";
import { downloadRemoteImagesInFile, findRemoteImages, reportResult, type DownloadResult } from "./download";

const COMMUNITY_IDS = ["obsidian-local-images-plus", "obsidian-local-images"];

export interface LocalImagesOptions {
  downloadOnPaste: boolean;
  maxSizeMB: number;
}

const DEFAULT_OPTIONS: LocalImagesOptions = { downloadOnPaste: false, maxSizeMB: 25 };

export class LocalImagesPlugin extends Plugin {
  instance!: any;
  running = false;

  get options(): LocalImagesOptions {
    return this.instance.options as LocalImagesOptions;
  }

  get standingAside(): string | null {
    return COMMUNITY_IDS.find((id) => communityPluginEnabled(this.app, id)) ?? null;
  }

  override onload() {
    this.addCommand({
      id: "local-images:download-current",
      name: "Download remote images in this note",
      icon: "lucide-image-down",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md" || this.standingAside || this.running) return false;
        if (!checking) void this.runOne(file);
        return true;
      },
    });
    this.addCommand({
      id: "local-images:download-all",
      name: "Download remote images in all notes",
      icon: "lucide-images",
      checkCallback: (checking) => {
        if (this.standingAside || this.running) return false;
        if (!checking) void this.runAll();
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-paste", (evt: ClipboardEvent, _editor: any, view: any) => {
        if (!this.options.downloadOnPaste || this.standingAside || !view?.file) return;
        const urls = pastedImageUrls(evt);
        if (!urls.size) return;
        const file: TFile = view.file;
        // After the paste (and a smart-paste rewrite) has landed in the document.
        const tryDownload = async (attempt: number) => {
          const text = view.editor?.getValue?.() ?? "";
          const present = findRemoteImages(text).some((l) => urls.has(l.url));
          if (!present) {
            if (attempt < 10) window.setTimeout(() => void tryDownload(attempt + 1), 150);
            return;
          }
          const result = await downloadRemoteImagesInFile(this.app, file, { onlyUrls: urls, maxBytes: this.options.maxSizeMB * 1048576 });
          if (result.failures.length) reportResult(this.app, [result]);
        };
        window.setTimeout(() => void tryDownload(0), 50);
      }),
    );

    this.instance.downloadInFile = (file: TFile) => downloadRemoteImagesInFile(this.app, file, { maxBytes: this.options.maxSizeMB * 1048576 });
    this.addSettingTab(new LocalImagesSettingTab(this.app, this));
  }

  async runOne(file: TFile) {
    this.running = true;
    try {
      await downloadRemoteImagesInFile(this.app, file, { report: true, maxBytes: this.options.maxSizeMB * 1048576 });
    } finally {
      this.running = false;
    }
  }

  async runAll() {
    const notes: { file: TFile; count: number }[] = [];
    for (const file of this.app.vault.getMarkdownFiles() as TFile[]) {
      const text: string = await this.app.vault.cachedRead(file);
      const count = findRemoteImages(text).length;
      if (count) notes.push({ file, count });
    }
    const total = notes.reduce((n, x) => n + x.count, 0);
    if (!total) {
      new Notice("No remote images found in this vault.");
      return;
    }
    const ok = await new Promise<boolean>((resolve) => new ConfirmModal(this.app, `Download ${total} remote image link${total === 1 ? "" : "s"} in ${notes.length} note${notes.length === 1 ? "" : "s"}?`, resolve).open());
    if (!ok) return;
    this.running = true;
    const signal = { cancelled: false };
    const progress = new ProgressModal(this.app, notes.length, () => (signal.cancelled = true));
    progress.open();
    const results: DownloadResult[] = [];
    try {
      for (const [i, { file }] of notes.entries()) {
        if (signal.cancelled) break;
        progress.update(i, file.path);
        results.push(await downloadRemoteImagesInFile(this.app, file, { signal, maxBytes: this.options.maxSizeMB * 1048576 }));
      }
      progress.update(signal.cancelled ? results.length : notes.length, "");
    } finally {
      this.running = false;
      progress.close();
    }
    reportResult(this.app, results, signal.cancelled);
  }
}

/** Image URLs in pasted text/HTML (`![](…)`, `<img src>`, and a bare image URL). */
function pastedImageUrls(evt: ClipboardEvent): Set<string> {
  const urls = new Set<string>();
  const data = evt.clipboardData;
  if (!data) return urls;
  const text = data.getData("text/plain") ?? "";
  for (const l of findRemoteImages(text)) urls.add(l.url);
  const bare = text.trim();
  if (/^https?:\/\/\S+$/i.test(bare)) urls.add(bare);
  const html = data.getData("text/html");
  if (html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("img[src]").forEach((img) => {
      const src = img.getAttribute("src") ?? "";
      if (/^(https?:|data:image\/)/i.test(src)) urls.add(src);
    });
  }
  return urls;
}

class ConfirmModal extends Modal {
  private answered = false;
  constructor(
    app: any,
    private message: string,
    private resolve: (ok: boolean) => void,
  ) {
    super(app);
  }
  override onOpen() {
    this.setTitle("Download remote images");
    this.contentEl.createEl("p", { text: this.message });
    this.contentEl.createEl("p", { cls: "setting-item-description", text: "Images are saved to your attachment folder and the links are rewritten to point at them." });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Download")
          .setCta()
          .onClick(() => {
            this.answered = true;
            this.resolve(true);
            this.close();
          }),
      );
  }
  override onClose() {
    if (!this.answered) this.resolve(false);
    this.contentEl.empty();
  }
}

class ProgressModal extends Modal {
  private bar!: HTMLProgressElement;
  private label!: HTMLElement;
  constructor(
    app: any,
    private total: number,
    private onCancel: () => void,
  ) {
    super(app);
  }
  override onOpen() {
    this.setTitle("Downloading remote images");
    this.modalEl.addClass("vault-local-images-progress");
    this.bar = this.contentEl.createEl("progress", { attr: { max: String(this.total), value: "0" } });
    this.label = this.contentEl.createDiv({ cls: "vault-local-images-progress-label", text: `0 of ${this.total} notes` });
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Cancel").onClick(() => {
        this.onCancel();
        b.setDisabled(true).setButtonText("Cancelling…");
      }),
    );
  }
  update(done: number, current: string) {
    this.bar.value = done;
    this.label.setText(`${done} of ${this.total} notes${current ? ` · ${current}` : ""}`);
  }
  override onClose() {
    this.onCancel();
    this.contentEl.empty();
  }
}

class LocalImagesSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: LocalImagesPlugin,
  ) {
    super(app, owner as any);
  }
  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();
    const aside = this.owner.standingAside;
    if (aside) containerEl.createDiv({ cls: "setting-item-description vault-standing-aside", text: `Handled by ${aside === "obsidian-local-images-plus" ? "Local Images Plus" : "Local images"} while that plugin is enabled.` });
    new Setting(containerEl)
      .setName("Download on paste")
      .setDesc("When pasted text contains remote images, save them to the vault right away.")
      .addToggle((t) => t.setValue(o.downloadOnPaste).onChange((v) => ((o.downloadOnPaste = v), save())));
    new Setting(containerEl)
      .setName("Maximum image size (MB)")
      .setDesc("Larger images are skipped and listed in the report.")
      .addText((t) => t.setValue(String(o.maxSizeMB)).onChange((v) => ((o.maxSizeMB = Math.max(1, Number(v) || 25)), save())));
    new Setting(containerEl)
      .setName("Where images go")
      .setDesc("Files → Default location for new attachments. Links follow Files → Use [[Wikilinks]]. Sites that do not allow the app to read them need the companion extension.");
  }
}

export const localImages: CorePluginDefinition = {
  id: "local-images",
  name: "Local images",
  description: "Download remote images in notes into the vault and link to the local copies.",
  icon: "lucide-image-down",
  defaultOn: false,
  defaultOptions: { ...DEFAULT_OPTIONS },
  create: (app) => new LocalImagesPlugin(app, { id: "local-images", name: "Local images", version: "", minAppVersion: "", author: "", description: "" }),
};
