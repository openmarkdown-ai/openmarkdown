/**
 * Footnotes view (`footnotes`): the footnote definitions of the active note.
 * Click a footnote to jump to it; click its text to edit it in place (saved
 * back into the definition); the flair counts references and jumps to the
 * first one.
 */
import type { CachedMetadata, FootnoteCache } from "obsidian";
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { debounce } from "../../obsidian/util";
import { TFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { FileInfoView, revealLine, showSideView } from "../global-search/common";

export const VIEW_TYPE_FOOTNOTES = "footnotes";

const DEF_PREFIX = /^\s*\[\^([^\]]+)\]:[ \t]?/;

export class FootnotesView extends FileInfoView {
  hoverPopover: any = null;
  listEl!: HTMLElement;
  private editing = false;
  private requestRender = debounce(() => void this.render(), 200, true);

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "lucide-footprints";
  }

  getViewType() {
    return VIEW_TYPE_FOOTNOTES;
  }

  getDisplayText() {
    return this.file ? `Footnotes in ${this.file.basename}` : "Footnotes";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.listEl = this.contentEl.createDiv({ cls: "footnotes-pane" });
    this.registerEvent(
      this.app.metadataCache.on("changed", (f: TFile) => {
        if (f === this.file && !this.editing) this.requestRender();
      }),
    );
    await super.onOpen();
  }

  onFileChanged(): void {
    void this.render();
  }

  async render() {
    if (!this.listEl) return;
    const file = this.file;
    const cache = file ? (this.app.metadataCache.getFileCache(file) as CachedMetadata | null) : null;
    const defs = (cache?.footnotes ?? []).slice().sort((a, b) => a.position.start.offset - b.position.start.offset);
    const text = file && defs.length ? await this.app.vault.cachedRead(file) : "";
    if (file !== this.file) return;
    this.listEl.empty();
    if (!file || !defs.length) {
      this.listEl.createDiv({ cls: "pane-empty", text: "No footnotes found." });
      return;
    }
    const refs = cache?.footnoteRefs ?? [];
    defs.forEach((def, i) => this.renderFootnote(file, text, def, i, refs.filter((r) => r.id.toLowerCase() === def.id.toLowerCase())));
  }

  private renderFootnote(file: TFile, text: string, def: FootnoteCache, i: number, refs: { id: string; position: FootnoteCache["position"] }[]) {
    const raw = text.slice(def.position.start.offset, def.position.end.offset);
    const prefix = DEF_PREFIX.exec(raw);
    const contentStart = def.position.start.offset + (prefix ? prefix[0].length : 0);
    const body = text.slice(contentStart, def.position.end.offset);
    const item = this.listEl.createDiv({ cls: "tree-item footnote-item", attr: { "data-footnote-id": def.id } });
    const self = item.createDiv({ cls: "tree-item-self is-clickable" });
    self.createDiv({ cls: "footnote-id", text: `${i + 1}`, attr: { "aria-label": `[^${def.id}]` } });
    const contentEl = self.createDiv({ cls: "tree-item-inner footnote-content", text: body.replace(/\n\s+/g, " ") });
    if (refs.length) {
      const flair = self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: String(refs.length), attr: { "aria-label": "Go to reference" } });
      flair.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const r = refs[0]!;
        void revealLine(this.app, this.leaf, file, r.position.start.line, r.position.start.col);
      });
    }
    self.addEventListener("click", (evt) => {
      if (this.editing) return;
      if (evt.target === contentEl) {
        this.startEditing(file, def, contentEl, body, contentStart);
        return;
      }
      void revealLine(this.app, this.leaf, file, def.position.start.line, 0);
    });
    self.addEventListener("dblclick", () => void revealLine(this.app, this.leaf, file, def.position.start.line, 0));
  }

  private startEditing(file: TFile, def: FootnoteCache, el: HTMLElement, original: string, contentStart: number) {
    this.editing = true;
    el.setText(original);
    el.setAttr("contenteditable", "true");
    el.addClass("is-editing");
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const finish = async (commit: boolean) => {
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("blur", onBlur);
      el.removeAttribute("contenteditable");
      el.removeClass("is-editing");
      const value = (el.textContent ?? "").replace(/\r?\n/g, " ");
      if (commit && value !== original) {
        await this.app.vault.process(file, (text: string) => {
          if (text.slice(contentStart, def.position.end.offset) !== original) return text;
          return text.slice(0, contentStart) + value + text.slice(def.position.end.offset);
        });
      }
      this.editing = false;
      void this.render();
    };
    const onKey = (evt: KeyboardEvent) => {
      if (evt.key === "Enter" && !evt.shiftKey) {
        evt.preventDefault();
        void finish(true);
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        evt.stopPropagation();
        void finish(false);
      }
    };
    const onBlur = () => void finish(true);
    el.addEventListener("keydown", onKey);
    el.addEventListener("blur", onBlur);
  }
}

class FootnotesPlugin extends Plugin {
  instance!: any;
  override async onload() {
    this.registerView(VIEW_TYPE_FOOTNOTES, (leaf: WorkspaceLeaf) => new FootnotesView(leaf));
    this.addCommand({ id: "footnotes:open", name: "Footnotes: Show footnotes", icon: "lucide-footprints", callback: () => void showSideView(this.app, VIEW_TYPE_FOOTNOTES) });
  }
}

export const footnotes: CorePluginDefinition = {
  id: "footnotes",
  name: "Footnotes view",
  description: "Show a list of footnotes from the current note.",
  icon: "lucide-footprints",
  defaultOn: false,
  defaultOptions: {},
  create: (app) => new FootnotesPlugin(app, { id: "footnotes", name: "Footnotes view", version: "", minAppVersion: "", author: "", description: "" }),
};
