/**
 * Folder and file pickers for settings fields ("Template folder location",
 * "Template file location" …), built on AbstractInputSuggest.
 */
import type { App } from "../../obsidian/app";
import { AbstractInputSuggest } from "../../obsidian/ui/suggest";
import { prepareFuzzySearch, renderResults } from "../../obsidian/util";
import { TFile, TFolder } from "../../obsidian/vault/files";

const LIMIT = 50;

function rank<T>(items: T[], text: (t: T) => string, query: string) {
  const q = query.trim();
  if (!q) return items.slice(0, LIMIT).map((item) => ({ item, match: null }));
  const search = prepareFuzzySearch(q);
  const out: { item: T; match: ReturnType<typeof search> }[] = [];
  for (const item of items) {
    const m = search(text(item));
    if (m) out.push({ item, match: m });
  }
  out.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
  return out.slice(0, LIMIT);
}

type Ranked<T> = { item: T; match: { score: number; matches: [number, number][] } | null };

export class FolderSuggest extends AbstractInputSuggest<Ranked<TFolder>> {
  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private onPick?: (path: string) => void,
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): Ranked<TFolder>[] {
    const folders = (this.app as any).vault.getAllFolders(false) as TFolder[];
    folders.sort((a, b) => a.path.localeCompare(b.path));
    return rank(folders, (f) => f.path, query) as Ranked<TFolder>[];
  }

  renderSuggestion(value: Ranked<TFolder>, el: HTMLElement): void {
    if (value.match) renderResults(el, value.item.path, value.match);
    else el.setText(value.item.path);
  }

  override selectSuggestion(value: Ranked<TFolder>, evt: MouseEvent | KeyboardEvent): void {
    this.setValue(value.item.path);
    this.inputEl.dispatchEvent(new Event("input"));
    this.onPick?.(value.item.path);
    super.selectSuggestion(value, evt);
  }
}

export class FileSuggest extends AbstractInputSuggest<Ranked<TFile>> {
  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private filter: (f: TFile) => boolean = (f) => f.extension === "md",
    private onPick?: (path: string) => void,
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): Ranked<TFile>[] {
    const files = ((this.app as any).vault.getFiles() as TFile[]).filter(this.filter);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return rank(files, (f) => pathWithoutMd(f), query) as Ranked<TFile>[];
  }

  renderSuggestion(value: Ranked<TFile>, el: HTMLElement): void {
    const text = pathWithoutMd(value.item);
    if (value.match) renderResults(el, text, value.match);
    else el.setText(text);
  }

  override selectSuggestion(value: Ranked<TFile>, evt: MouseEvent | KeyboardEvent): void {
    const text = pathWithoutMd(value.item);
    this.setValue(text);
    this.inputEl.dispatchEvent(new Event("input"));
    this.onPick?.(text);
    super.selectSuggestion(value, evt);
  }
}

export function pathWithoutMd(f: TFile): string {
  return f.extension === "md" ? f.path.slice(0, -3) : f.path;
}

/** Resolve a user-entered template path ("Templates/Daily", with or without .md). */
export function resolveTemplateFile(app: any, path: string): TFile | null {
  const p = path.trim().replace(/^\/+/, "");
  if (!p) return null;
  const direct = app.vault.getFileByPath(p) ?? app.vault.getFileByPath(`${p}.md`);
  if (direct) return direct;
  return app.metadataCache.getFirstLinkpathDest(p, "") ?? null;
}

export function isFolder(f: unknown): f is TFolder {
  return f instanceof TFolder;
}
