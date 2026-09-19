/**
 * Bases outside their own tab: `![[x.base]]` / `![[x.base#View]]` embeds and
 * ```base code blocks. Both render a BasesHost with `this` = the embedding
 * note; edits made through the toolbar are written back to the `.base` file
 * or into the code block.
 */
import { Component } from "../../obsidian/events";
import type { TFile } from "../../obsidian/vault/files";
import { BasesHost } from "./host";
import type { BasesPluginHost } from "./types";

export class BaseFileEmbed extends Component {
  private host: BasesHost | null = null;
  private lastText: string | null = null;

  constructor(
    private plugin: BasesPluginHost,
    private ctx: { app: any; containerEl: HTMLElement; linktext: string; sourcePath: string; depth?: number },
    private file: TFile,
    private subpath: string,
  ) {
    super();
  }

  override onload() {
    const app = this.ctx.app;
    const el = this.ctx.containerEl;
    el.addClasses(["bases-embed", "is-loaded"]);
    el.removeClass("file-embed");
    const viewName = decodeURIComponent((this.subpath ?? "").replace(/^#/, "")) || null;
    this.host = this.addChild(
      new BasesHost(app, this.plugin, el.createDiv({ cls: "bases-embed-content" }), {
        embedded: true,
        baseFile: this.file,
        getThisFile: () => app.vault.getFileByPath(this.ctx.sourcePath) ?? null,
        initialViewName: viewName,
        save: async (yaml) => {
          this.lastText = yaml;
          await app.vault.modify(this.file, yaml);
        },
      }),
    );
    // Keep clicks inside the embed from reaching the editor (which would move the cursor into the embed source).
    this.registerDomEvent(el, "mousedown", (evt: MouseEvent) => evt.stopPropagation());
    this.registerDomEvent(el, "click", (evt: MouseEvent) => {
      evt.stopPropagation();
    });
    this.registerEvent(
      app.vault.on("modify", (f: TFile) => {
        if (f === this.file) void this.loadFile();
      }),
    );
  }

  async loadFile() {
    if (!this._loaded) this.load();
    if ((this.ctx.depth ?? 0) > 3) {
      this.ctx.containerEl.setText("Embed depth limit reached.");
      return;
    }
    const text: string = await this.ctx.app.vault.cachedRead(this.file);
    if (text === this.lastText && this.host?.yamlText === text) return;
    this.lastText = text;
    this.host?.setSource(text);
  }
}

/** Replace the body of the ```base block whose content was `oldSource` (near `lineHint`). */
export function replaceCodeBlock(text: string, oldSource: string, newSource: string, lineHint: number | null): string | null {
  const lines = text.split("\n");
  const blocks: { start: number; end: number; body: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\s*base\s*$/.exec(lines[i]!);
    if (!open) continue;
    const fence = open[2]!;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(lines[j]!)) j++;
    blocks.push({ start: i, end: j, body: lines.slice(i + 1, j).join("\n") });
    i = j;
  }
  const norm = (s: string) => s.replace(/\s+$/, "");
  const matching = blocks.filter((b) => norm(b.body) === norm(oldSource));
  const pick = matching.length > 1 && lineHint !== null ? matching.reduce((a, b) => (Math.abs(b.start - lineHint) < Math.abs(a.start - lineHint) ? b : a)) : matching[0];
  if (!pick) return null;
  const body = newSource.replace(/\n$/, "");
  return [...lines.slice(0, pick.start + 1), ...(body ? body.split("\n") : []), ...lines.slice(pick.end)].join("\n");
}

export function renderBaseCodeBlock(plugin: BasesPluginHost, source: string, el: HTMLElement, ctx: any): Component {
  const app = plugin.app;
  el.addClass("bases-embed");
  let current = source;
  const host = new BasesHost(app, plugin, el, {
    embedded: true,
    baseFile: null,
    getThisFile: () => app.vault.getFileByPath(ctx.sourcePath) ?? null,
    save: async (yaml) => {
      const file = app.vault.getFileByPath(ctx.sourcePath) as TFile | null;
      if (!file) return;
      const info = ctx.getSectionInfo?.(el);
      const old = current;
      current = yaml;
      await app.vault.process(file, (text: string) => replaceCodeBlock(text, old, yaml, info?.text === text ? info.lineStart : null) ?? text);
    },
  });
  const stop = (evt: Event) => evt.stopPropagation();
  el.addEventListener("mousedown", stop);
  el.addEventListener("click", stop);
  host.setSource(source);
  if (ctx.addChild) ctx.addChild(host);
  else host.load();
  return host;
}
