/**
 * Smart paste (`smart-paste`) — link titles, links over selections and link
 * cards, writing the Markdown Auto Link Title, Paste URL into selection and
 * Auto Card Link write. Off by default; each part steps aside while the
 * matching community plugin is enabled.
 *
 * | Clipboard | Context                                   | Result                                             |
 * |-----------|-------------------------------------------|----------------------------------------------------|
 * | URL       | text selected                             | `[selection](url)` (`![selection](url)` for image hosts) |
 * | image URL | nothing selected                          | `![](url)`                                         |
 * | URL       | nothing selected, "Fetch title on paste"  | `[Fetching Title#abcd](url)` → `[Title](url)`      |
 * | URL       | after `](`, `"` or `'`                    | pasted as-is                                       |
 * | URL       | host in "Hosts that never fetch"          | `[hostname](url)`                                  |
 *
 * A title that cannot be fetched (the site refuses a browser page and the
 * companion extension is not installed) leaves the plain URL and says once
 * how to get titles.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { communityPluginEnabled, NetError, showBridgeHint } from "./network";
import { cardlinkBlock, escapeMarkdown, fetchLinkMetadata, fetchTitle, shortTitle } from "./metadata";
import { renderCard } from "./card";

/** Auto Link Title's URL test. */
const URL_REGEX =
  /^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})$/i;
const IMAGE_REGEX = /\.(gif|jpe?g|tiff?|png|webp|bmp|tga|psd|ai|avif|svg)$/i;
const LINK_REGEX = /\[([^[\]]*)\]\((https?:\/\/[^\s)]+)\)/gi;
const LINE_URL_REGEX = /(https?:\/\/[^\s)>\]]+|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s)>\]]{2,})/gi;

export const COMMUNITY = {
  autoLinkTitle: "obsidian-auto-link-title",
  urlIntoSelection: "url-into-selection",
  autoCardLink: "auto-card-link",
  linkEmbed: "obsidian-link-embed",
};

export interface SmartPasteOptions {
  /** Auto Link Title: fetch the title when a URL is pasted with nothing selected */
  enhanceDefaultPaste: boolean;
  /** Auto Link Title: same for drag and drop */
  enhanceDropEvents: boolean;
  /** Keep the selected text as the link text (off: fetch the title and replace the selection) */
  shouldPreserveSelectionAsTitle: boolean;
  /** Auto Link Title: 0 = no limit */
  maximumTitleLength: number;
  /** Auto Link Title: hosts that never fetch (comma or newline separated) */
  websiteBlacklist: string;
  /** Paste URL into selection: 0 paste as-is · 1 link the word under the cursor · 2 `[](url)` · 3 `<url>` — used when titles are off */
  nothingSelected: 0 | 1 | 2 | 3;
  /** Paste URL into selection: hosts whose links are written as images */
  listForImgEmbed: string;
  /** Paste image URLs as `![](url)` */
  embedImageUrls: boolean;
}

export const DEFAULT_SMART_PASTE: SmartPasteOptions = {
  enhanceDefaultPaste: true,
  enhanceDropEvents: true,
  shouldPreserveSelectionAsTitle: true,
  maximumTitleLength: 0,
  websiteBlacklist: "",
  nothingSelected: 0,
  listForImgEmbed: "",
  embedImageUrls: true,
};

function isUrl(text: string) {
  return URL_REGEX.test(text);
}

function normaliseUrl(text: string) {
  return /^www\./i.test(text) ? `https://${text}` : text;
}

function hostOf(url: string): string {
  try {
    return new URL(normaliseUrl(url)).hostname;
  } catch {
    return url;
  }
}

function listOf(setting: string): string[] {
  return setting
    .split(/,|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Inside a fenced code block or an inline code span: paste untouched. */
function inCode(editor: any): boolean {
  const cursor = editor.getCursor("from");
  let fenced = false;
  for (let i = 0; i < cursor.line; i++) if (/^\s*(```|~~~)/.test(editor.getLine(i))) fenced = !fenced;
  if (fenced) return true;
  const before = (editor.getLine(cursor.line) as string).slice(0, cursor.ch);
  return (before.match(/`/g)?.length ?? 0) % 2 === 1;
}

function blockHash(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 4; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

export class SmartPastePlugin extends Plugin {
  instance!: any;

  get options(): SmartPasteOptions {
    return this.instance.options as SmartPasteOptions;
  }

  override onload() {
    this.registerEvent(this.app.workspace.on("editor-paste", (evt: ClipboardEvent, editor: any) => this.onPaste(evt, editor)));
    this.registerEvent(this.app.workspace.on("editor-drop", (evt: DragEvent, editor: any) => this.onDrop(evt, editor)));

    const unlessPlugin = (id: string, run: (editor: any) => void) => (checking: boolean, editor: any) => {
      if (communityPluginEnabled(this.app, id)) return false;
      if (!checking) run(editor);
      return true;
    };
    this.addCommand({ id: "smart-paste:paste-with-title", name: "Paste URL and fetch title", editorCheckCallback: unlessPlugin(COMMUNITY.autoLinkTitle, (e) => void this.pasteFromClipboard(e, "title")) } as any);
    this.addCommand({ id: "smart-paste:enhance-url", name: "Add title to link under cursor", editorCheckCallback: unlessPlugin(COMMUNITY.autoLinkTitle, (e) => void this.enhanceUrlUnderCursor(e)) } as any);
    this.addCommand({ id: "smart-paste:paste-as-card", name: "Paste URL as link card", editorCheckCallback: unlessPlugin(COMMUNITY.autoCardLink, (e) => void this.pasteFromClipboard(e, "card")) } as any);
    this.addCommand({ id: "smart-paste:create-card", name: "Convert link to card", editorCheckCallback: unlessPlugin(COMMUNITY.autoCardLink, (e) => void this.convertUnderCursorToCard(e)) } as any);

    // Card blocks (read-only renderers for notes written by Auto Card Link / Link Embed).
    if (!communityPluginEnabled(this.app, COMMUNITY.autoCardLink)) {
      this.registerMarkdownCodeBlockProcessor("cardlink", (source, el, ctx) => renderCard(this.app, source, el, ctx.sourcePath, "cardlink"));
    }
    if (!communityPluginEnabled(this.app, COMMUNITY.linkEmbed)) {
      this.registerMarkdownCodeBlockProcessor("embed", (source, el, ctx) => renderCard(this.app, source, el, ctx.sourcePath, "embed"));
    }
    this.instance.fetchTitle = fetchTitle;
    this.instance.fetchLinkMetadata = fetchLinkMetadata;
    this.addSettingTab(new SmartPasteSettingTab(this.app, this));
  }

  // ---- paste and drop -----------------------------------------------------------

  onPaste(evt: ClipboardEvent, editor: any) {
    if (evt.defaultPrevented || !editor) return;
    const data = evt.clipboardData;
    if (!data || (data.files && data.files.length)) return;
    const text = (data.getData("text/plain") ?? "").trim();
    if (!text || !isUrl(text) || inCode(editor)) return;
    if (this.handleUrl(text, editor)) evt.preventDefault();
  }

  onDrop(evt: DragEvent, editor: any) {
    if (evt.defaultPrevented || !editor || !this.options.enhanceDropEvents) return;
    if (communityPluginEnabled(this.app, COMMUNITY.autoLinkTitle)) return;
    const data = evt.dataTransfer;
    if (!data || (data.files && data.files.length)) return;
    const text = (data.getData("text/plain") ?? "").trim();
    if (!text || !isUrl(text) || IMAGE_REGEX.test(text)) return;
    const pos = editor.posAtMouse?.(evt);
    if (pos) editor.setCursor(pos);
    evt.preventDefault();
    void this.convertUrlToTitledLink(editor, normaliseUrl(text));
  }

  /** Returns true when the paste was handled (and the default must not run). */
  handleUrl(text: string, editor: any): boolean {
    const o = this.options;
    const url = normaliseUrl(text);
    const selected: string = editor.getSelection();
    const selectionIsPlain = !!selected && !/\n/.test(selected) && !isUrl(selected.trim());
    const altEnabled = communityPluginEnabled(this.app, COMMUNITY.autoLinkTitle);
    const uisEnabled = communityPluginEnabled(this.app, COMMUNITY.urlIntoSelection);

    // After `](`, `"` or `'`: the user is writing the link by hand.
    const cursor = editor.getCursor("from");
    const before = editor.getRange({ line: cursor.line, ch: Math.max(0, cursor.ch - 2) }, cursor) as string;
    if (before.endsWith("](") || /["']$/.test(before)) return false;

    if (selectionIsPlain) {
      if (uisEnabled) return false;
      const image = listOf(o.listForImgEmbed).some((h) => hostOf(url).includes(h));
      if (altEnabled && !image) return false; // Auto Link Title (or the core link-over-selection) handles it
      if (o.shouldPreserveSelectionAsTitle || image) {
        editor.replaceSelection(`${image ? "!" : ""}[${selected}](${url})`);
        return true;
      }
      void this.convertUrlToTitledLink(editor, url);
      return true;
    }
    if (selected) return false;

    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      /* keep */
    }
    if (IMAGE_REGEX.test(path) && o.embedImageUrls) {
      editor.replaceSelection(`![](${url})`);
      return true;
    }
    if (o.enhanceDefaultPaste && !altEnabled) {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        new Notice("No internet connection. Cannot fetch title.");
        return false;
      }
      void this.convertUrlToTitledLink(editor, url);
      return true;
    }
    if (uisEnabled) return false;
    switch (Number(o.nothingSelected)) {
      case 1: {
        const range = editor.wordAt?.(editor.getCursor());
        if (!range) return false;
        const word = editor.getRange(range.from, range.to);
        editor.replaceRange(`[${word}](${url})`, range.from, range.to);
        return true;
      }
      case 2:
        editor.replaceSelection(`[](${url})`);
        editor.setCursor({ line: cursor.line, ch: cursor.ch + 1 });
        return true;
      case 3:
        editor.replaceSelection(`<${url}>`);
        return true;
      default:
        return false;
    }
  }

  private isBlacklisted(url: string): boolean {
    return listOf(this.options.websiteBlacklist).some((site) => url.includes(site));
  }

  /** Insert the placeholder at once, then swap in the title (Auto Link Title's flow). */
  async convertUrlToTitledLink(editor: any, url: string): Promise<void> {
    if (this.isBlacklisted(url)) {
      editor.replaceSelection(`[${hostOf(url)}](${url})`);
      return;
    }
    const pasteId = `Fetching Title#${blockHash()}`;
    const placeholder = `[${pasteId}](${url})`;
    editor.replaceSelection(placeholder);
    let replacement: string;
    try {
      const title = await fetchTitle(url);
      replacement = `[${shortTitle(escapeMarkdown(title), Number(this.options.maximumTitleLength) || 0)}](${url})`;
    } catch (e) {
      replacement = url;
      if (e instanceof NetError && e.kind === "cors") showBridgeHint("links were pasted without their titles");
      else new Notice(`Couldn't fetch the title of ${hostOf(url)}: ${(e as Error)?.message ?? e}`);
    }
    this.replacePlaceholder(editor, placeholder, replacement);
  }

  private replacePlaceholder(editor: any, placeholder: string, replacement: string) {
    const text: string = editor.getValue();
    const start = text.indexOf(placeholder);
    if (start < 0) return; // edited away: leave the note alone
    editor.replaceRange(replacement, editor.offsetToPos(start), editor.offsetToPos(start + placeholder.length));
  }

  // ---- commands -----------------------------------------------------------------

  async pasteFromClipboard(editor: any, mode: "title" | "card") {
    let text = "";
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      new Notice("The browser did not allow reading the clipboard.");
      return;
    }
    if (!text) return;
    if (!isUrl(text)) {
      editor.replaceSelection(text);
      return;
    }
    const url = normaliseUrl(text);
    if (mode === "card") await this.insertCard(editor, url);
    else if (IMAGE_REGEX.test(url)) editor.replaceSelection(text);
    else await this.convertUrlToTitledLink(editor, url);
  }

  /** Auto Card Link's flow: `[Fetching Data#abcd](url)` → the ```cardlink block. */
  async insertCard(editor: any, url: string) {
    const selected = editor.getSelection();
    const placeholder = `[Fetching Data#${blockHash()}](${url})`;
    editor.replaceSelection(placeholder);
    try {
      const meta = await fetchLinkMetadata(url);
      this.replacePlaceholder(editor, placeholder, cardlinkBlock(meta));
    } catch (e) {
      if (e instanceof NetError && e.kind === "cors") showBridgeHint("the link card could not be made");
      else new Notice("Couldn't fetch link metadata");
      this.replacePlaceholder(editor, placeholder, selected || url);
    }
  }

  /** The `[text](url)` or bare URL around the cursor, with its range. */
  private linkUnderCursor(editor: any): { url: string; from: any; to: any } | null {
    const cursor = editor.getCursor();
    const line: string = editor.getLine(cursor.line);
    const selected = (editor.getSelection() as string).trim();
    if (selected && isUrl(selected)) return { url: normaliseUrl(selected), from: editor.getCursor("from"), to: editor.getCursor("to") };
    for (const re of [LINK_REGEX, LINE_URL_REGEX]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        if (m.index <= cursor.ch && cursor.ch <= m.index + m[0].length) {
          const url = re === LINK_REGEX ? m[2]! : m[0];
          return { url: normaliseUrl(url), from: { line: cursor.line, ch: m.index }, to: { line: cursor.line, ch: m.index + m[0].length } };
        }
      }
    }
    return null;
  }

  async enhanceUrlUnderCursor(editor: any) {
    const link = this.linkUnderCursor(editor);
    if (!link) {
      new Notice("Put the cursor on a URL or a link first.");
      return;
    }
    editor.setSelection(link.from, link.to);
    await this.convertUrlToTitledLink(editor, link.url);
  }

  async convertUnderCursorToCard(editor: any) {
    const link = this.linkUnderCursor(editor);
    if (!link) {
      new Notice("Put the cursor on a URL or a link first.");
      return;
    }
    editor.setSelection(link.from, link.to);
    await this.insertCard(editor, link.url);
  }
}

class SmartPasteSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: SmartPastePlugin,
  ) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();
    const aside = (id: string, name: string) => {
      if (communityPluginEnabled(this.app, id)) containerEl.createDiv({ cls: "setting-item-description vault-standing-aside", text: `Handled by ${name} while that plugin is enabled.` });
    };
    new Setting(containerEl).setName("Link titles").setHeading();
    aside(COMMUNITY.autoLinkTitle, "Auto Link Title");
    new Setting(containerEl)
      .setName("Fetch title on paste")
      .setDesc("Pasting a web address with nothing selected writes [Page title](url). Most sites need the companion extension; YouTube and Vimeo work without it.")
      .addToggle((t) => t.setValue(o.enhanceDefaultPaste).onChange((v) => ((o.enhanceDefaultPaste = v), save())));
    new Setting(containerEl)
      .setName("Fetch title on drop")
      .setDesc("The same for a link dragged into a note.")
      .addToggle((t) => t.setValue(o.enhanceDropEvents).onChange((v) => ((o.enhanceDropEvents = v), save())));
    new Setting(containerEl)
      .setName("Keep selection as link text")
      .setDesc("Pasting a web address over selected text writes [selection](url). Off: the page title replaces the selection.")
      .addToggle((t) => t.setValue(o.shouldPreserveSelectionAsTitle).onChange((v) => ((o.shouldPreserveSelectionAsTitle = v), save())));
    new Setting(containerEl)
      .setName("Maximum title length")
      .setDesc("Longer titles are cut and end with “...”. 0 means no limit.")
      .addText((t) => t.setValue(String(o.maximumTitleLength)).onChange((v) => ((o.maximumTitleLength = Math.max(0, Number(v) || 0)), save())));
    new Setting(containerEl)
      .setName("Hosts that never fetch")
      .setDesc("One per line. Their links are written as [hostname](url) and never requested.")
      .addTextArea((t) => t.setValue(o.websiteBlacklist).onChange((v) => ((o.websiteBlacklist = v), save())));
    new Setting(containerEl).setName("Pasting web addresses").setHeading();
    aside(COMMUNITY.urlIntoSelection, "Paste URL into selection");
    new Setting(containerEl)
      .setName("Embed image addresses")
      .setDesc("Pasting the address of an image writes ![](url).")
      .addToggle((t) => t.setValue(o.embedImageUrls).onChange((v) => ((o.embedImageUrls = v), save())));
    new Setting(containerEl)
      .setName("With nothing selected (titles off)")
      .setDesc("What pasting a web address does when “Fetch title on paste” is off.")
      .addDropdown((d) =>
        d
          .addOptions({ "0": "Paste as-is", "1": "Link the word under the cursor", "2": "Insert [](url)", "3": "Insert <url>" })
          .setValue(String(o.nothingSelected))
          .onChange((v) => ((o.nothingSelected = Number(v) as 0 | 1 | 2 | 3), save())),
      );
    new Setting(containerEl)
      .setName("Image embed hosts")
      .setDesc("One per line. Links to these hosts pasted over a selection are written as images, ![selection](url).")
      .addTextArea((t) => t.setValue(o.listForImgEmbed).onChange((v) => ((o.listForImgEmbed = v), save())));
    new Setting(containerEl).setName("Link cards").setHeading();
    aside(COMMUNITY.autoCardLink, "Auto Card Link");
    new Setting(containerEl).setName("Cards").setDesc("“Paste URL as link card” writes a ```cardlink block, the format Auto Card Link uses. Existing ```cardlink and ```embed blocks render as cards.");
    new Setting(containerEl)
      .setName("Import settings")
      .setDesc("Read Auto Link Title and Paste URL into selection settings from this vault's plugin folders.")
      .addButton((b) =>
        b.setButtonText("Import").onClick(async () => {
          const n = await importCommunitySettings(this.app, o);
          if (n) save();
          new Notice(n ? `Imported settings from ${n} plugin${n === 1 ? "" : "s"}.` : "No settings from those plugins were found in this vault.");
          this.display();
        }),
      );
  }
}

async function readPluginData(app: any, id: string): Promise<Record<string, any> | null> {
  const path = `${app.vault.configDir}/plugins/${id}/data.json`;
  try {
    if (!(await app.vault.adapter.exists(path))) return null;
    return JSON.parse(await app.vault.adapter.read(path));
  } catch {
    return null;
  }
}

async function importCommunitySettings(app: any, o: SmartPasteOptions): Promise<number> {
  let n = 0;
  const alt = await readPluginData(app, COMMUNITY.autoLinkTitle);
  if (alt) {
    n++;
    for (const k of ["enhanceDefaultPaste", "enhanceDropEvents", "shouldPreserveSelectionAsTitle"] as const) if (typeof alt[k] === "boolean") o[k] = alt[k];
    if (typeof alt.maximumTitleLength === "number") o.maximumTitleLength = alt.maximumTitleLength;
    if (typeof alt.websiteBlacklist === "string") o.websiteBlacklist = alt.websiteBlacklist;
  }
  const uis = await readPluginData(app, COMMUNITY.urlIntoSelection);
  if (uis) {
    n++;
    if ([0, 1, 2, 3].includes(uis.nothingSelected)) o.nothingSelected = uis.nothingSelected;
    if (typeof uis.listForImgEmbed === "string") o.listForImgEmbed = uis.listForImgEmbed;
  }
  return n;
}

export const smartPaste: CorePluginDefinition = {
  id: "smart-paste",
  name: "Smart paste",
  description: "Paste web addresses as titled links, links over selected text, or link cards.",
  icon: "lucide-clipboard-paste",
  defaultOn: false,
  defaultOptions: { ...DEFAULT_SMART_PASTE },
  create: (app) => new SmartPastePlugin(app, { id: "smart-paste", name: "Smart paste", version: "", minAppVersion: "", author: "", description: "" }),
};
