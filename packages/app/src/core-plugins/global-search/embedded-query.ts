/**
 * ```query code blocks: live search results inside a note.
 *
 * The block's lines are joined with spaces (Obsidian: `query.replace(/\r?\n/g, " ")`),
 * no option lines are parsed, and matches that fall inside the containing
 * note's own query blocks are ignored so a note does not find itself.
 */
import type { MarkdownPostProcessorContext } from "obsidian";
import { MarkdownRenderChild } from "../../obsidian/markdown/renderer";
import { setIcon } from "../../obsidian/ui/icons";
import { debounce } from "../../obsidian/util";
import { TFile } from "../../obsidian/vault/files";
import { runSearch, SORT_LABELS, type Range, type SortOrder } from "./engine";
import { CopySearchResultsModal } from "./copy-modal";
import { SearchResultDOM } from "./result-dom";
import { hitToResult } from "./search-view";
import { showSortMenu } from "./common";

const QUERY_BLOCK = /^([ \t]*)(`{3,}|~{3,})[ \t]*query[ \t]*\r?\n[\s\S]*?\r?\n\1\2[ \t]*$/gm;

function queryBlockRanges(text: string): Range[] {
  const out: Range[] = [];
  QUERY_BLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUERY_BLOCK.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}

export class EmbeddedQuery extends MarkdownRenderChild {
  app: any;
  query: string;
  sourcePath: string;
  dom!: SearchResultDOM;
  hoverPopover: any = null;
  private collapseAll = false;
  private extraContext = false;
  private sortOrder: SortOrder = "alphabetical";
  private requestRefresh = debounce(() => void this.refresh(), 500, true);

  constructor(app: any, containerEl: HTMLElement, query: string, sourcePath: string) {
    super(containerEl);
    this.app = app;
    this.query = query;
    this.sourcePath = sourcePath;
  }

  override onload(): void {
    const root = this.containerEl.createDiv({ cls: "internal-query" });
    const header = root.createDiv({ cls: "internal-query-header" });
    header.createDiv({ cls: "internal-query-header-title", text: this.query });
    const buttons = header.createDiv({ cls: "internal-query-header-buttons" });
    const button = (icon: string, label: string, onClick: (evt: MouseEvent, el: HTMLElement) => void) => {
      const el = buttons.createDiv({ cls: "internal-query-header-button clickable-icon", attr: { "aria-label": label } });
      setIcon(el, icon);
      el.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        onClick(evt, el);
      });
      return el;
    };
    button("lucide-list-collapse", "Collapse results", (_e, el) => {
      this.collapseAll = !this.collapseAll;
      el.toggleClass("is-active", this.collapseAll);
      this.dom.setCollapseAll(this.collapseAll);
    });
    button("lucide-move-vertical", "Show more context", (_e, el) => {
      this.extraContext = !this.extraContext;
      el.toggleClass("is-active", this.extraContext);
      this.dom.setExtraContext(this.extraContext);
    });
    button("lucide-arrow-up-narrow-wide", "Change sort order", (evt) =>
      showSortMenu(evt, SORT_LABELS, this.sortOrder, (v) => {
        this.sortOrder = v;
        this.dom.setSortOrder(v);
      }),
    );
    button("lucide-copy", "Copy search results", () => new CopySearchResultsModal(this.app, this.dom.getFiles()).open());

    this.dom = new SearchResultDOM({ app: this.app, hoverSource: "search", hoverParent: this, showInfo: true, emptyStateText: "No matches found.", menuSource: "search-view" }, root);
    // Clicks inside the results must not put a Live Preview block into edit mode.
    root.addEventListener("mousedown", (evt) => evt.stopPropagation());

    this.registerEvent(this.app.metadataCache.on("changed", () => this.requestRefresh()));
    this.registerEvent(this.app.metadataCache.on("deleted", () => this.requestRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.requestRefresh()));
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.requestRefresh()));
    void this.refresh();
  }

  override onunload(): void {
    this.dom?.destroy();
  }

  async refresh() {
    if (!this.query.trim()) {
      this.dom.emptyResults();
      this.dom.infoEl.hide();
      this.dom.emptyStateEl.show();
      return;
    }
    const run = runSearch(this.app, this.query, { sort: this.sortOrder });
    if (run.error) {
      this.dom.emptyResults();
      this.dom.setEmptyStateText(run.error);
      this.dom.infoEl.hide();
      return;
    }
    this.dom.setEmptyStateText("No matches found.");
    const seen = new Set<TFile>();
    let count = 0;
    for (const hit of run.files) {
      const file = this.app.vault.getFileByPath(hit.path);
      if (!(file instanceof TFile)) continue;
      const data = hitToResult(hit);
      let content: string | null = null;
      if (file.path === this.sourcePath) {
        content = await this.app.vault.cachedRead(file);
        const blocks = queryBlockRanges(content!);
        data.content = data.content.filter((r) => !blocks.some((b) => r[0] >= b[0] && r[1] <= b[1]));
        if (!data.content.length && !(data.filename?.length) && !(data.properties?.length)) continue;
      }
      seen.add(file);
      count += data.content.length + (data.filename?.length ?? 0) + (data.properties?.length ?? 0);
      this.dom.addResult(file, data, content);
    }
    for (const file of Array.from(this.dom.resultDomLookup.keys())) if (!seen.has(file)) this.dom.removeResult(file);
    this.dom.infoEl.show();
    this.dom.resultCountEl.setText(`${count.toLocaleString()} result${count === 1 ? "" : "s"}`);
  }
}

export function queryCodeBlockProcessor(app: any) {
  return (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    const query = source.replace(/\r?\n/g, " ").trim();
    const child = new EmbeddedQuery(app, el, query, ctx.sourcePath);
    ctx.addChild(child as never);
  };
}
