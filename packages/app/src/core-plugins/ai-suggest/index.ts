/**
 * AI suggestions (`ai-suggest`, off by default, AI feature "suggest"): a side
 * pane of accept/dismiss chips for the active note —
 *
 * - links: other notes' names written as plain text here (unlinked mentions),
 *   and notes related by meaning when the semantic index is available;
 * - tags: picked from the vault's existing tags (a new one only sparingly);
 * - properties: values for property names the vault already uses, converted
 *   to each property's type;
 * - a title for notes named "Untitled…", renamed through the file manager so
 *   links to the note are updated;
 * - alt text for image embeds that have none (vision-capable engines only).
 *
 * Nothing changes until a chip is accepted; each accept is one undo step.
 * Runs on demand ("Suggest for this note") and, if turned on, when the note
 * has been idle for a while.
 */
import { getEngine } from "@vault/engine";
import type { CachedMetadata } from "obsidian";
import type { EngineInfo } from "../../ai/types";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { debounce, getAllTags, getFrontMatterInfo, normalizePath, parseFrontMatterAliases } from "../../obsidian/util";
import { TFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ItemView } from "../../obsidian/workspace/view";
import { findUnlinkedMentions } from "../outgoing-link/index";
import { convertValue, isCompatible, isValidTag, type PropertyType } from "../properties/types";
import {
  aiAvailable,
  aiOf,
  editNote,
  errorMessage,
  generate,
  isAbort,
  parseJsonAnswer,
  propertySchema,
  renderEngineBadge,
  truncate,
  vaultTags,
  viewFor,
  withFrontmatter,
} from "./shared";

export const VIEW_TYPE_AI_SUGGEST = "ai-suggest";
const PLUGIN_ID = "ai-suggest";

export interface AiSuggestOptions {
  links: boolean;
  tags: boolean;
  properties: boolean;
  title: boolean;
  altText: boolean;
  allowNewTags: boolean;
  suggestWhenIdle: boolean;
  idleSeconds: number;
}

export const DEFAULT_AI_SUGGEST_OPTIONS: AiSuggestOptions = {
  links: true,
  tags: true,
  properties: true,
  title: true,
  altText: true,
  allowNewTags: true,
  suggestWhenIdle: false,
  idleSeconds: 60,
};

export type SuggestionKind = "link" | "related" | "tag" | "property" | "title" | "alt";

export interface Suggestion {
  /** Stable within a note, so a dismissed suggestion stays dismissed. */
  key: string;
  kind: SuggestionKind;
  label: string;
  detail?: string;
  apply(): Promise<boolean>;
}

const SECTIONS: { kinds: SuggestionKind[]; title: string; icon: string }[] = [
  { kinds: ["title"], title: "Title", icon: "lucide-heading" },
  { kinds: ["link", "related"], title: "Links", icon: "lucide-link" },
  { kinds: ["tag"], title: "Tags", icon: "lucide-tags" },
  { kinds: ["property"], title: "Properties", icon: "lucide-list" },
  { kinds: ["alt"], title: "Image descriptions", icon: "lucide-image" },
];

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const RESERVED = new Set(["tags", "tag", "aliases", "alias", "cssclasses", "cssclass", "position"]);
const MAX_NOTE_CHARS = 8000;
const MAX_IMAGES = 3;

export function isUntitled(file: TFile): boolean {
  return /^untitled\b/i.test(file.basename);
}

/** A title usable as a file name: no characters links or file systems reject. */
export function cleanTitle(title: unknown): string {
  if (typeof title !== "string") return "";
  return title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
    .trim();
}

function parseText(text: string): CachedMetadata {
  return getEngine().parse(text) as CachedMetadata;
}

class AiSuggestView extends ItemView {
  /** Not `file`: the workspace treats views with a `file` field as editors of it. */
  note: TFile | null = null;
  suggestions: Suggestion[] = [];
  engine: EngineInfo | null = null;
  running: AbortController | null = null;
  ranFor: TFile | null = null;
  private topEl!: HTMLElement;
  private noteEl!: HTMLElement;
  private engineEl!: HTMLElement;
  private runBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private listEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: AiSuggestPlugin,
  ) {
    super(leaf);
    this.icon = "lucide-sparkles";
  }

  getViewType() {
    return VIEW_TYPE_AI_SUGGEST;
  }
  getDisplayText() {
    return "AI suggestions";
  }
  override getIcon() {
    return "lucide-sparkles";
  }

  override async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("ai-suggest-view");
    this.topEl = this.contentEl.createDiv({ cls: "ai-suggest-header" });
    this.noteEl = this.topEl.createDiv({ cls: "ai-suggest-note" });
    const row = this.topEl.createDiv({ cls: "ai-suggest-actions" });
    this.runBtn = row.createEl("button", { cls: "mod-cta ai-suggest-run", text: "Suggest for this note" });
    this.runBtn.addEventListener("click", () => {
      if (this.running) this.running.abort();
      else void this.run();
    });
    this.engineEl = row.createDiv();
    this.statusEl = this.contentEl.createDiv({ cls: "ai-suggest-status", attr: { "aria-live": "polite" } });
    this.listEl = this.contentEl.createDiv({ cls: "ai-suggest-list" });

    const follow = () => {
      const f = this.app.workspace.getActiveFile() as TFile | null;
      if (f && f.extension === "md" && f !== this.note) this.setNote(f);
    };
    this.registerEvent(this.app.workspace.on("file-open", follow));
    this.registerEvent(this.app.workspace.on("active-leaf-change", follow));
    this.registerEvent(
      this.app.vault.on("rename", (f: any) => {
        if (f === this.note) this.renderHeader();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f: any) => {
        if (f === this.note) this.setNote(null);
      }),
    );
    this.registerEvent(this.app.ai?.on?.("change", () => this.renderHeader()) ?? null);
    follow();
    this.renderHeader();
  }

  override registerEvent(ref: any): void {
    if (ref) super.registerEvent(ref);
  }

  override async onClose() {
    this.running?.abort();
  }

  setNote(file: TFile | null) {
    if (file === this.note) return;
    this.running?.abort();
    this.note = file;
    this.suggestions = [];
    this.ranFor = null;
    this.statusEl.setText("");
    this.renderHeader();
    this.renderList();
  }

  renderHeader() {
    const available = aiAvailable(this.app, "suggest");
    this.noteEl.setText(this.note ? this.note.basename : "No note open");
    this.runBtn.setText(this.running ? "Stop" : "Suggest for this note");
    this.runBtn.disabled = !this.note || (!available && !this.running);
    renderEngineBadge(this.engineEl, this.engine ?? aiOf(this.app)?.engineFor("suggest") ?? null);
    if (!available && !this.running) this.statusEl.setText("Turn on AI and suggestions in Settings → AI to get suggestions.");
    else if (this.statusEl.getText().startsWith("Turn on AI")) this.statusEl.setText("");
  }

  async run(quiet = false) {
    const file = this.note;
    if (!file || this.running) return;
    const controller = new AbortController();
    this.running = controller;
    this.statusEl.setText("Looking at this note…");
    this.contentEl.addClass("is-loading");
    this.renderHeader();
    try {
      const result = await this.plugin.suggestFor(file, controller.signal, quiet);
      if (controller.signal.aborted || this.note !== file) return;
      if (!result) {
        this.statusEl.setText("Cancelled.");
        return;
      }
      this.engine = result.engine;
      const dismissed = this.plugin.dismissedFor(file);
      this.suggestions = result.suggestions.filter((s) => !dismissed.has(s.key));
      this.ranFor = file;
      this.statusEl.setText(this.suggestions.length ? "Nothing changes until you accept a suggestion." : "No suggestions for this note.");
      this.renderList();
    } catch (e) {
      if (isAbort(e) || controller.signal.aborted) {
        this.statusEl.setText("Stopped.");
        return;
      }
      this.statusEl.setText(errorMessage(e));
    } finally {
      if (this.running === controller) this.running = null;
      this.contentEl.removeClass("is-loading");
      this.renderHeader();
    }
  }

  renderList() {
    this.listEl.empty();
    for (const section of SECTIONS) {
      const items = this.suggestions.filter((s) => section.kinds.includes(s.kind));
      if (!items.length) continue;
      const sec = this.listEl.createDiv({ cls: "ai-suggest-section", attr: { "data-section": section.kinds[0]! } });
      const title = sec.createDiv({ cls: "ai-suggest-section-title" });
      setIcon(title.createSpan({ cls: "ai-suggest-section-icon" }), section.icon);
      title.createSpan({ text: section.title });
      const chips = sec.createDiv({ cls: "ai-suggest-chips" });
      for (const s of items) this.renderChip(chips, s);
    }
  }

  private renderChip(parent: HTMLElement, s: Suggestion) {
    const chip = parent.createDiv({ cls: "ai-suggest-chip", attr: { "data-kind": s.kind, "data-key": s.key } });
    const body = chip.createDiv({ cls: "ai-suggest-chip-body" });
    body.createDiv({ cls: "ai-suggest-chip-label", text: s.label });
    if (s.detail) body.createDiv({ cls: "ai-suggest-chip-detail", text: s.detail });
    const accept = chip.createEl("button", { cls: "clickable-icon ai-suggest-accept", attr: { "aria-label": "Accept", type: "button" } });
    setIcon(accept, "lucide-check");
    const dismiss = chip.createEl("button", { cls: "clickable-icon ai-suggest-dismiss", attr: { "aria-label": "Dismiss", type: "button" } });
    setIcon(dismiss, "lucide-x");
    const remove = () => {
      this.suggestions = this.suggestions.filter((x) => x !== s);
      this.renderList();
      if (!this.suggestions.length && this.ranFor) this.statusEl.setText("That's everything for this note.");
    };
    accept.addEventListener("click", async () => {
      accept.disabled = dismiss.disabled = true;
      try {
        const ok = await s.apply();
        if (ok) remove();
        else accept.disabled = dismiss.disabled = false;
      } catch (e) {
        new Notice(errorMessage(e));
        accept.disabled = dismiss.disabled = false;
      }
    });
    dismiss.addEventListener("click", () => {
      if (this.note) this.plugin.dismissedFor(this.note).add(s.key);
      remove();
    });
  }
}

export class AiSuggestPlugin extends Plugin {
  instance!: any;
  private dismissed = new Map<string, Set<string>>();
  /** Idle runs never ask for consent: they run only once the user has run suggestions on demand. */
  private consented = false;

  get options(): AiSuggestOptions {
    const o = this.instance.options as Partial<AiSuggestOptions>;
    return { ...DEFAULT_AI_SUGGEST_OPTIONS, ...o };
  }

  dismissedFor(file: TFile): Set<string> {
    let set = this.dismissed.get(file.path);
    if (!set) this.dismissed.set(file.path, (set = new Set()));
    return set;
  }

  override async onload() {
    this.registerView(VIEW_TYPE_AI_SUGGEST, (leaf) => new AiSuggestView(leaf, this));
    this.addCommand({
      id: "ai-suggest:suggest",
      name: "Suggest for this note",
      icon: "lucide-sparkles",
      checkCallback: (checking) => {
        if (!aiAvailable(this.app, "suggest")) return false;
        const file = this.app.workspace.getActiveFile() as TFile | null;
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.openAndRun(file);
        return true;
      },
    });
    this.addCommand({
      id: "ai-suggest:open",
      name: "Show AI suggestions",
      icon: "lucide-sparkles",
      checkCallback: (checking) => {
        if (!aiAvailable(this.app, "suggest")) return false;
        if (!checking) void this.openView();
        return true;
      },
    });
    this.addSettingTab(new AiSuggestSettingTab(this.app, this));

    const idle = debounce(
      () => void this.idleRun(),
      Math.max(10, this.options.idleSeconds) * 1000,
      true,
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        if (this.options.suggestWhenIdle) idle();
      }),
    );
    this.register(() => idle.cancel());
  }

  private views(): AiSuggestView[] {
    return (this.app.workspace.getLeavesOfType(VIEW_TYPE_AI_SUGGEST) as WorkspaceLeaf[]).map((l) => l.view).filter((v): v is AiSuggestView => v instanceof AiSuggestView);
  }

  async openView(): Promise<AiSuggestView | null> {
    const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_AI_SUGGEST, "right", { active: true, reveal: true });
    const view = leaf?.view;
    return view instanceof AiSuggestView ? view : null;
  }

  async openAndRun(file: TFile) {
    const view = await this.openView();
    if (!view) return;
    view.setNote(file);
    await view.run();
  }

  private async idleRun() {
    if (!this.options.suggestWhenIdle || !aiAvailable(this.app, "suggest")) return;
    const engine = aiOf(this.app)?.engineFor("suggest");
    if (engine?.leavesDevice && !this.consented) return;
    const file = this.app.workspace.getActiveFile() as TFile | null;
    for (const view of this.views()) {
      if (file && view.note === file && !view.running) await view.run(true);
    }
  }

  /** Every kind of suggestion for `file`. Resolves null when the user declined consent. */
  async suggestFor(file: TFile, signal: AbortSignal, quiet = false): Promise<{ suggestions: Suggestion[]; engine: EngineInfo | null } | null> {
    const o = this.options;
    const ai = aiOf(this.app);
    const view = viewFor(this.app, file);
    const text: string = view ? view.editor.getValue() : await this.app.vault.cachedRead(file);
    const cache = parseText(text);
    const out: Suggestion[] = [];
    let engine: EngineInfo | null = ai?.engineFor("suggest") ?? null;

    if (o.links) {
      out.push(...this.linkSuggestions(file, text, cache));
      out.push(...(await this.relatedSuggestions(file, cache, signal)));
    }
    if (o.tags || o.properties || (o.title && isUntitled(file))) {
      if (quiet && engine?.leavesDevice && !this.consented) return { suggestions: out, engine };
      const res = await generate(this.app, this.metadataRequest(file, text, cache, signal));
      if (!res) return null;
      this.consented = true;
      engine = res.engine;
      const data = parseJsonAnswer(res.text);
      if (data && typeof data === "object") {
        if (o.title && isUntitled(file)) out.unshift(...this.titleSuggestions(file, data.title));
        if (o.tags) out.push(...this.tagSuggestions(file, cache, data.tags, data.newTags));
        if (o.properties) out.push(...this.propertySuggestions(file, cache, data.properties));
      }
    }
    if (o.altText && aiAvailable(this.app, "suggest", "vision")) {
      out.push(...(await this.altTextSuggestions(file, cache, signal)));
      engine = ai?.engineFor("suggest", "vision") ?? engine;
    }
    return { suggestions: out, engine };
  }

  // ---- links ----

  private linkSuggestions(file: TFile, text: string, cache: CachedMetadata): Suggestion[] {
    const out: Suggestion[] = [];
    const mentions = findUnlinkedMentions(this.app, file, text, cache);
    for (const [target, { ranges }] of mentions) {
      const first = ranges[0]!;
      const matched = text.slice(first[0], first[1]);
      out.push({
        key: `link:${target.path}`,
        kind: "link",
        label: target.basename,
        detail: `Link “${matched}”${ranges.length > 1 ? ` (mentioned ${ranges.length} times; links the first)` : ""}`,
        apply: () => this.linkFirstMention(file, target),
      });
      if (out.length >= 12) break;
    }
    return out;
  }

  async linkFirstMention(file: TFile, target: TFile): Promise<boolean> {
    let ok = false;
    await editNote(this.app, file, (text) => {
      const found = findUnlinkedMentions(this.app, file, text, parseText(text)).get(target);
      const range = found?.ranges[0];
      if (!range) return null;
      const matched = text.slice(range[0], range[1]);
      const names = [target.basename, ...(parseFrontMatterAliases(this.app.metadataCache.getFileCache(target)?.frontmatter ?? null) ?? [])];
      const alias = names.some((n) => n === matched) && matched === target.basename ? undefined : matched;
      ok = true;
      return text.slice(0, range[0]) + this.app.fileManager.generateMarkdownLink(target, file.path, undefined, alias) + text.slice(range[1]);
    });
    if (!ok) new Notice("That mention is no longer in the note.");
    return ok;
  }

  /** Notes related by meaning, from the semantic index when it is enabled. */
  private async relatedSuggestions(file: TFile, cache: CachedMetadata, signal: AbortSignal): Promise<Suggestion[]> {
    // The semantic index (core-plugins/semantic) publishes `instance.index.similarToNote(path, k)`.
    const index = (this.app.internalPlugins?.getEnabledPluginById?.("semantic") as any)?.index;
    if (!index || typeof index.similarToNote !== "function" || !aiAvailable(this.app, "related", "embed")) return [];
    if (typeof index.isIndexed === "function" && !index.isIndexed(file.path)) return [];
    let raw: unknown;
    try {
      const hits = ((await index.similarToNote(file.path, 40)) ?? []) as { path: string; score: number }[];
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const best = new Map<string, number>();
      for (const h of hits) if (h.path !== file.path) best.set(h.path, Math.max(best.get(h.path) ?? -Infinity, h.score));
      raw = [...best.entries()].sort((x, y) => y[1] - x[1]).map(([path]) => path);
    } catch (e) {
      if (isAbort(e)) throw e;
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const linked = new Set<string>();
    for (const l of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
      const dest = this.app.metadataCache.getFirstLinkpathDest(l.link.split("#")[0], file.path) as TFile | null;
      if (dest) linked.add(dest.path);
    }
    const out: Suggestion[] = [];
    for (const item of raw as any[]) {
      const path = typeof item === "string" ? item : (item?.path ?? item?.file?.path);
      const target = typeof path === "string" ? (this.app.vault.getFileByPath(path) as TFile | null) : null;
      if (!target || target === file || target.extension !== "md" || linked.has(target.path)) continue;
      linked.add(target.path);
      out.push({
        key: `related:${target.path}`,
        kind: "related",
        label: target.basename,
        detail: "Related by meaning — adds a link under “Related”",
        apply: () => this.addRelatedLink(file, target),
      });
      if (out.length >= 5) break;
    }
    return out;
  }

  async addRelatedLink(file: TFile, target: TFile): Promise<boolean> {
    const link = this.app.fileManager.generateMarkdownLink(target, file.path);
    return editNote(this.app, file, (text) => {
      const lines = text.split("\n");
      const heading = lines.findIndex((l) => /^#{1,6}\s+Related\s*$/i.test(l));
      if (heading >= 0) {
        let end = heading + 1;
        while (end < lines.length && !/^#{1,6}\s/.test(lines[end]!)) end++;
        while (end > heading + 1 && !lines[end - 1]!.trim()) end--;
        lines.splice(end, 0, `- ${link}`);
        return lines.join("\n");
      }
      const body = text.replace(/\s*$/, "");
      return `${body}${body ? "\n\n" : ""}## Related\n\n- ${link}\n`;
    });
  }

  // ---- tags, properties, title ----

  private metadataRequest(file: TFile, text: string, cache: CachedMetadata, signal: AbortSignal) {
    const o = this.options;
    const tags = vaultTags(this.app);
    const schema = propertySchema(this.app).filter((p) => !RESERVED.has(p.name.toLowerCase()));
    const fm = cache.frontmatter ?? {};
    const body = text.slice(getFrontMatterInfo(text).contentStart);
    const wantTitle = o.title && isUntitled(file);
    const system = [
      "Task: suggest-note-metadata",
      "You suggest metadata for one Markdown note in the user's personal notes vault.",
      'Answer with a JSON object only: {"tags": string[], "newTags": string[], "properties": {"<name>": value}, "title": string | null}.',
      o.tags ? "tags: up to 5 tags from the vault's existing tags that clearly fit this note, without #. Never tags the note already has." : 'tags: always [].',
      o.tags && o.allowNewTags ? "newTags: at most 1 new tag, only when no existing tag covers the note's main topic; lowercase, no spaces. Usually []." : "newTags: always [].",
      o.properties
        ? "properties: values only for property names listed below that the note does not set yet, and only when the note's text states or clearly implies the value. Match each property's type: number → number, checkbox → true/false, date → YYYY-MM-DD, datetime → YYYY-MM-DDTHH:mm, list → array of strings, text → string. Usually few or none."
        : "properties: always {}.",
      wantTitle ? "title: a short, specific title for the note (2–7 words, no quotes, no file extension)." : "title: always null.",
      "Do not invent facts. Write in the note's language.",
    ].join("\n");
    const user = [
      `Existing tags in the vault: ${tags.length ? tags.join(", ") : "(none)"}`,
      "Property names in the vault (type: examples):",
      ...(schema.length ? schema.map((p) => `- ${p.name} (${p.type})${p.samples.length ? `: ${p.samples.join(", ")}` : ""}`) : ["(none)"]),
      "",
      `Note name: ${file.basename}`,
      `Note's current properties: ${JSON.stringify(fm)}`,
      `Note's current tags: ${(getAllTags(cache) ?? []).join(" ") || "(none)"}`,
      "Note text:",
      truncate(body, MAX_NOTE_CHARS),
    ].join("\n");
    return { feature: "suggest" as const, system, messages: [{ role: "user" as const, content: user }], json: true, temperature: 0.2, maxTokens: 400, signal };
  }

  private titleSuggestions(file: TFile, title: unknown): Suggestion[] {
    const clean = cleanTitle(title);
    if (!clean || clean.toLowerCase() === file.basename.toLowerCase()) return [];
    return [{ key: `title:${clean}`, kind: "title", label: clean, detail: "Rename the note; links to it are updated", apply: () => this.rename(file, clean) }];
  }

  async rename(file: TFile, title: string): Promise<boolean> {
    const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
    const path = normalizePath(`${dir}${title}.${file.extension}`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && existing !== file) {
      new Notice(`A note named “${title}” already exists here.`);
      return false;
    }
    await this.app.fileManager.renameFile(file, path);
    return true;
  }

  private tagSuggestions(file: TFile, cache: CachedMetadata, tags: unknown, newTags: unknown): Suggestion[] {
    const vault = new Map(vaultTags(this.app, 100_000).map((t) => [t.toLowerCase(), t]));
    const has = new Set((getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "").toLowerCase()));
    const out: Suggestion[] = [];
    const add = (tag: string, isNew: boolean) => {
      out.push({
        key: `tag:${tag.toLowerCase()}`,
        kind: "tag",
        label: `#${tag}`,
        detail: isNew ? "New tag" : undefined,
        apply: () => this.addTag(file, tag),
      });
      has.add(tag.toLowerCase());
    };
    for (const t of Array.isArray(tags) ? tags : []) {
      if (typeof t !== "string") continue;
      const tag = vault.get(t.trim().replace(/^#/, "").toLowerCase());
      if (tag && !has.has(tag.toLowerCase())) add(tag, false);
      if (out.length >= 5) break;
    }
    if (this.options.allowNewTags) {
      for (const t of Array.isArray(newTags) ? newTags.slice(0, 1) : []) {
        if (typeof t !== "string") continue;
        const tag = t.trim().replace(/^#/, "").replace(/\s+/g, "-");
        if (!isValidTag(tag) || has.has(tag.toLowerCase())) continue;
        if (vault.has(tag.toLowerCase())) add(vault.get(tag.toLowerCase())!, false);
        else add(tag, true);
      }
    }
    return out;
  }

  async addTag(file: TFile, tag: string): Promise<boolean> {
    return editNote(this.app, file, (text) =>
      withFrontmatter(text, (fm) => {
        const key = Object.keys(fm).find((k) => k.toLowerCase() === "tags") ?? "tags";
        const cur = fm[key];
        const list: string[] = Array.isArray(cur) ? cur.map(String) : typeof cur === "string" && cur.trim() ? cur.split(/[,\s]+/).filter(Boolean) : [];
        if (list.some((t) => t.replace(/^#/, "").toLowerCase() === tag.toLowerCase())) return;
        list.push(tag);
        fm[key] = list;
      }),
    );
  }

  private propertySuggestions(file: TFile, cache: CachedMetadata, props: unknown): Suggestion[] {
    if (!props || typeof props !== "object" || Array.isArray(props)) return [];
    const schema = new Map(propertySchema(this.app, 100_000).map((p) => [p.name.toLowerCase(), p]));
    const fm = cache.frontmatter ?? {};
    const out: Suggestion[] = [];
    for (const [rawName, rawValue] of Object.entries(props as Record<string, unknown>)) {
      const info = schema.get(rawName.toLowerCase());
      if (!info || RESERVED.has(info.name.toLowerCase())) continue;
      const setKey = Object.keys(fm).find((k) => k.toLowerCase() === info.name.toLowerCase());
      const current = setKey ? fm[setKey] : undefined;
      if (current !== undefined && current !== null && current !== "" && !(Array.isArray(current) && !current.length)) continue;
      const type = info.type as PropertyType;
      if (rawValue === null || rawValue === undefined || rawValue === "") continue;
      if (!isCompatible(type, rawValue)) continue;
      const value = convertValue(type, rawValue);
      if (value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
      const shown = Array.isArray(value) ? value.join(", ") : String(value);
      out.push({
        key: `property:${info.name.toLowerCase()}=${JSON.stringify(value)}`,
        kind: "property",
        label: `${info.name}: ${shown}`,
        detail: typeLabel(type),
        apply: () => this.setProperty(file, info.name, value),
      });
      if (out.length >= 6) break;
    }
    return out;
  }

  async setProperty(file: TFile, name: string, value: unknown): Promise<boolean> {
    return editNote(this.app, file, (text) =>
      withFrontmatter(text, (fm) => {
        const key = Object.keys(fm).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
        fm[key] = value;
      }),
    );
  }

  // ---- alt text ----

  private async altTextSuggestions(file: TFile, cache: CachedMetadata, signal: AbortSignal): Promise<Suggestion[]> {
    const out: Suggestion[] = [];
    for (const embed of cache.embeds ?? []) {
      if (out.length >= MAX_IMAGES) break;
      const linkpath = embed.link.split("#")[0]!.split("|")[0]!;
      const target = this.app.metadataCache.getFirstLinkpathDest(linkpath, file.path) as TFile | null;
      if (!target || !IMAGE_EXTS.has(target.extension.toLowerCase())) continue;
      if (hasAltText(embed.original)) continue;
      const bytes: ArrayBuffer = await this.app.vault.readBinary(target);
      const mime = target.extension.toLowerCase() === "svg" ? "image/svg+xml" : `image/${target.extension.toLowerCase() === "jpg" ? "jpeg" : target.extension.toLowerCase()}`;
      const res = await generate(
        this.app,
        {
          feature: "suggest",
          system: "Task: image-alt-text\nWrite alt text for this image in a Markdown note: one plain sentence under 125 characters that says what the image shows. No quotes, no \"image of\". Answer with the alt text only.",
          messages: [{ role: "user", content: `Image file: ${target.name}`, images: [new Blob([bytes], { type: mime })] }],
          temperature: 0.2,
          maxTokens: 80,
          signal,
        },
        "vision",
      );
      if (!res) return out;
      const alt = cleanAlt(res.text);
      if (!alt) continue;
      const original = embed.original;
      const offset = embed.position.start.offset;
      out.push({
        key: `alt:${offset}:${original}`,
        kind: "alt",
        label: alt,
        detail: target.name,
        apply: () => this.setAltText(file, original, offset, alt),
      });
    }
    return out;
  }

  async setAltText(file: TFile, original: string, offset: number, alt: string): Promise<boolean> {
    let ok = false;
    await editNote(this.app, file, (text) => {
      let at = text.slice(offset, offset + original.length) === original ? offset : -1;
      if (at < 0) {
        const first = text.indexOf(original);
        at = first >= 0 && text.indexOf(original, first + 1) < 0 ? first : -1;
      }
      if (at < 0) return null;
      ok = true;
      return text.slice(0, at) + withAltText(original, alt) + text.slice(at + original.length);
    });
    if (!ok) new Notice("That image embed has changed since the suggestion was made.");
    return ok;
  }
}

function typeLabel(type: PropertyType): string {
  return ({ text: "Text", multitext: "List", number: "Number", checkbox: "Checkbox", date: "Date", datetime: "Date & time", tags: "Tags", aliases: "Aliases" } as Record<string, string>)[type] ?? type;
}

/** True when an image embed already describes itself. `![[a.png|300]]` sizes, it doesn't describe. */
export function hasAltText(original: string): boolean {
  const wiki = /^!\[\[([^\]]*)\]\]$/.exec(original);
  if (wiki) {
    const parts = wiki[1]!.split("|").slice(1);
    return parts.some((p) => p.trim() && !/^\d+(x\d+)?$/.test(p.trim()));
  }
  const md = /^!\[([^\]]*)\]/.exec(original);
  if (md) return !!md[1]!.split("|")[0]!.trim() && !/^\d+(x\d+)?$/.test(md[1]!.trim());
  return true;
}

export function cleanAlt(text: string): string {
  return text
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[[\]|]/g, "")
    .slice(0, 200)
    .trim();
}

/** The embed with `alt` as its description, keeping a size if it had one. */
export function withAltText(original: string, alt: string): string {
  const wiki = /^!\[\[([^\]|]*)((?:\|[^\]]*)?)\]\]$/.exec(original);
  if (wiki) {
    const size = wiki[2]!
      .split("|")
      .slice(1)
      .find((p) => /^\d+(x\d+)?$/.test(p.trim()));
    return `![[${wiki[1]}|${alt}${size ? `|${size.trim()}` : ""}]]`;
  }
  return original.replace(/^!\[([^\]]*)\]/, (_m, inner: string) => {
    const size = /^\d+(x\d+)?$/.test(inner.trim()) ? inner.trim() : "";
    return `![${alt}${size ? `|${size}` : ""}]`;
  });
}

class AiSuggestSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: AiSuggestPlugin,
  ) {
    super(app, owner as any);
    this.id = PLUGIN_ID;
    this.name = "AI suggestions";
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    el.createEl("p", {
      cls: "setting-item-description",
      text: "Suggestions appear in the AI suggestions pane. Nothing in a note changes until you accept a suggestion. Which engine answers is set in Settings → AI.",
    });
    const o = this.owner.instance.options as AiSuggestOptions;
    const toggle = (key: keyof AiSuggestOptions, name: string, desc: string) =>
      new Setting(el)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(!!(o[key] ?? DEFAULT_AI_SUGGEST_OPTIONS[key])).onChange((v) => {
            (o as any)[key] = v;
            void this.owner.instance.saveOptions();
          }),
        );
    toggle("links", "Links", "Other notes mentioned here as plain text, and related notes when the semantic index is on.");
    toggle("tags", "Tags", "Tags the vault already uses.");
    toggle("allowNewTags", "Allow a new tag", "At most one tag the vault doesn't have yet, when none of the existing ones fit.");
    toggle("properties", "Properties", "Values for property names the vault already uses.");
    toggle("title", "Title for untitled notes", "Rename notes named “Untitled…”; links to them are updated.");
    toggle("altText", "Image descriptions", "Alt text for images without one. Needs an engine that can see images.");
    toggle("suggestWhenIdle", "Suggest when a note is idle", "Refresh the open suggestions pane after you stop typing. Never runs before you've asked once.");
    new Setting(el)
      .setName("Idle time")
      .setDesc("Seconds without typing before suggestions refresh. Applies after the plugin is reloaded.")
      .addText((t) =>
        t.setValue(String(o.idleSeconds ?? DEFAULT_AI_SUGGEST_OPTIONS.idleSeconds)).onChange((v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 10) {
            o.idleSeconds = Math.round(n);
            void this.owner.instance.saveOptions();
          }
        }),
      );
  }
}
