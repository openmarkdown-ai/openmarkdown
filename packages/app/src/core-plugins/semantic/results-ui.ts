/**
 * The list of similar notes and passages shared by Related notes and search
 * by meaning. Built from Obsidian's search result DOM (`tree-item
 * search-result`, `search-result-file-title`, `search-result-file-match`) so
 * themes style it like search results.
 *
 * Each note and passage opens on click (Mod opens a new tab), previews on
 * hover, drags as a link, and has an "Insert link" button when an editor is
 * available.
 */
import { MarkdownView } from "../../obsidian/markdown/markdown-view";
import { setIcon } from "../../obsidian/ui/icons";
import { Keymap } from "../../obsidian/ui/keymap";
import { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import type { TFile } from "../../obsidian/vault/files";
import { linkHeading, type NoteHit, type PassageHit } from "./engine";

export interface HitListOptions {
  app: any;
  hoverParent: { hoverPopover: any };
  hoverSource: string;
  /** The note links are relative to (the note being compared, or ""). */
  sourcePath: string;
  /** Passage text by key, when loaded. */
  texts: Map<number, string>;
  /** Where "Insert link" writes; null hides the button. */
  targetEditor: () => MarkdownView | null;
  showScores: boolean;
}

export function formatScore(score: number): string {
  return Math.max(0, score).toFixed(2);
}

function excerpt(text: string, max = 220): string {
  const plain = text
    .replace(/^#{1,6}\s+.*$/gm, "")
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max).replace(/\s\S*$/, "")}…` : plain;
}

/** The link text for a note or one of its headings, relative to `sourcePath`. */
function linktextFor(app: any, file: TFile, sourcePath: string, heading?: string): string {
  const base = app.metadataCache.fileToLinktext(file, sourcePath, true);
  return heading ? `${base}#${heading}` : base;
}

export function insertLink(app: any, view: MarkdownView | null, file: TFile, heading?: string): boolean {
  if (!view?.editor || !view.file) {
    new Notice("Open a note to insert the link into.");
    return false;
  }
  const subpath = heading ? `#${heading}` : undefined;
  const link: string = app.fileManager.generateMarkdownLink(file, view.file.path, subpath);
  view.editor.replaceSelection(link);
  view.editor.focus?.();
  return true;
}

function passageLabel(p: PassageHit): string {
  return p.headings.length ? p.headings.join(" › ") : "Top of note";
}

export function renderNoteHits(container: HTMLElement, hits: NoteHit[], o: HitListOptions): void {
  container.empty();
  const { app } = o;
  for (const hit of hits) {
    const file = app.vault.getFileByPath(hit.path) as TFile | null;
    if (!file) continue;
    const item = container.createDiv({ cls: "tree-item search-result semantic-result", attr: { "data-path": hit.path } });
    const self = item.createDiv({ cls: "tree-item-self search-result-file-title is-clickable" });
    self.createDiv({ cls: "tree-item-inner", text: file.basename, attr: { "aria-label": file.path } });
    const flair = self.createDiv({ cls: "tree-item-flair-outer" });
    if (o.showScores) flair.createSpan({ cls: "tree-item-flair semantic-score", text: formatScore(hit.score), attr: { "aria-label": "Similarity (0 to 1)" } });
    if (o.targetEditor) {
      const btn = flair.createDiv({ cls: "clickable-icon semantic-insert-link", attr: { "aria-label": "Insert link" } });
      setIcon(btn, "lucide-link");
      btn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        insertLink(app, o.targetEditor(), file);
      });
    }
    self.addEventListener("click", (evt) => {
      void app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file, { active: true });
    });
    self.addEventListener("mouseover", (evt) => {
      app.workspace.trigger("hover-link", { event: evt, source: o.hoverSource, hoverParent: o.hoverParent, targetEl: self, linktext: file.path, sourcePath: o.sourcePath });
    });
    self.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Insert link").setIcon("lucide-link").onClick(() => insertLink(app, o.targetEditor(), file)));
      app.workspace.trigger("file-menu", menu, file, "semantic-related", null);
      menu.showAtMouseEvent(evt);
    });
    app.dragManager?.handleDrag?.(self, (evt: DragEvent) => app.dragManager.dragFile(evt, file, o.sourcePath));

    const matches = item.createDiv({ cls: "search-result-file-matches" });
    for (const p of hit.passages) {
      const heading = linkHeading(p.path, p.headings);
      const row = matches.createDiv({ cls: "search-result-file-match tappable semantic-passage", attr: { "data-line": String(p.startLine) } });
      const head = row.createDiv({ cls: "semantic-passage-heading" });
      head.createSpan({ text: passageLabel(p) });
      if (o.showScores) head.createSpan({ cls: "semantic-passage-score", text: formatScore(p.score) });
      const text = o.texts.get(p.key);
      if (text !== undefined) row.createDiv({ cls: "semantic-passage-text", text: excerpt(text) });
      row.addEventListener("click", (evt) => {
        void app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file, { active: true, eState: { line: p.startLine } });
      });
      row.addEventListener("mouseover", (evt) => {
        app.workspace.trigger("hover-link", {
          event: evt,
          source: o.hoverSource,
          hoverParent: o.hoverParent,
          targetEl: row,
          linktext: heading ? `${file.path}#${heading}` : file.path,
          sourcePath: o.sourcePath,
          state: { scroll: p.startLine },
        });
      });
      row.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        const menu = new Menu();
        menu.addItem((i) => i.setTitle(heading ? "Insert link to heading" : "Insert link").setIcon("lucide-link").onClick(() => insertLink(app, o.targetEditor(), file, heading)));
        menu.showAtMouseEvent(evt);
      });
      app.dragManager?.handleDrag?.(row, (evt: DragEvent) => {
        const data = app.dragManager.dragLink(evt, linktextFor(app, file, o.sourcePath, heading), o.sourcePath, heading ?? file.basename);
        // Respect the vault's link format (wikilink or Markdown).
        evt.dataTransfer?.setData("text/plain", app.fileManager.generateMarkdownLink(file, o.sourcePath, heading ? `#${heading}` : undefined));
        return data;
      });
    }
  }
}
