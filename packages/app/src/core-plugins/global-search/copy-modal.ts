/** "Copy search results" — options dialog, as in Obsidian's search "…" menu. */
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import type { TFile } from "../../obsidian/vault/files";

type LinkStyle = "none" | "wikilink" | "markdown";
type ListStyle = "none" | "dash" | "asterisk" | "numbered";

const STORAGE_KEY = "search-copy-options";

export class CopySearchResultsModal extends Modal {
  private showPath = false;
  private linkStyle: LinkStyle = "wikilink";
  private listStyle: ListStyle = "dash";
  private previewEl!: HTMLElement;

  constructor(
    app: any,
    private files: TFile[],
  ) {
    super(app);
    const saved = app.loadLocalStorage?.(STORAGE_KEY);
    if (saved && typeof saved === "object") {
      this.showPath = !!saved.showPath;
      if (["none", "wikilink", "markdown"].includes(saved.linkStyle)) this.linkStyle = saved.linkStyle;
      if (["none", "dash", "asterisk", "numbered"].includes(saved.listStyle)) this.listStyle = saved.listStyle;
    }
  }

  override onOpen(): void {
    this.setTitle("Copy search results");
    const { contentEl } = this;
    new Setting(contentEl).setName("Show path").addToggle((t) =>
      t.setValue(this.showPath).onChange((v) => {
        this.showPath = v;
        this.update();
      }),
    );
    new Setting(contentEl).setName("Link style").addDropdown((d) =>
      d
        .addOptions({ none: "None", wikilink: "Wikilink", markdown: "Markdown link" })
        .setValue(this.linkStyle)
        .onChange((v) => {
          this.linkStyle = v as LinkStyle;
          this.update();
        }),
    );
    new Setting(contentEl).setName("List prefix").addDropdown((d) =>
      d
        .addOptions({ none: "None", dash: "Dash", asterisk: "Asterisk", numbered: "Numbered" })
        .setValue(this.listStyle)
        .onChange((v) => {
          this.listStyle = v as ListStyle;
          this.update();
        }),
    );
    this.previewEl = contentEl.createEl("pre", { cls: "vault-search-copy-preview" });
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Copy results")
        .setCta()
        .onClick(async () => {
          await navigator.clipboard.writeText(this.text());
          (this.app as any).saveLocalStorage?.(STORAGE_KEY, { showPath: this.showPath, linkStyle: this.linkStyle, listStyle: this.listStyle });
          new Notice(`Copied ${this.files.length} search result${this.files.length === 1 ? "" : "s"}.`);
          this.close();
        }),
    );
    this.update();
  }

  private text(): string {
    const app = this.app as any;
    return this.files
      .map((file, i) => {
        const name = this.showPath ? (file.extension === "md" ? file.path.replace(/\.md$/, "") : file.path) : file.extension === "md" ? file.basename : file.name;
        let item: string;
        if (this.linkStyle === "wikilink") item = this.showPath ? `[[${name}]]` : `[[${app.metadataCache.fileToLinktext(file, "", true)}]]`;
        else if (this.linkStyle === "markdown") item = `[${name}](${encodeURI(file.path)})`;
        else item = name;
        const prefix = this.listStyle === "dash" ? "- " : this.listStyle === "asterisk" ? "* " : this.listStyle === "numbered" ? `${i + 1}. ` : "";
        return prefix + item;
      })
      .join("\n");
  }

  private update() {
    const lines = this.text().split("\n");
    this.previewEl.setText(lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n…` : ""));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
