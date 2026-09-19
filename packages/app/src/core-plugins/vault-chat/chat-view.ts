/**
 * Chat with vault (`vault-chat`): questions answered from passages retrieved
 * across the vault (or only the pinned notes and folders), streamed, with
 * citations as `[[note#heading]]` links, the engine that answered, "Insert
 * into note" with a preview, and "Save conversation as note".
 */
import { AiUnavailableError, type AiService, type EngineInfo } from "../../ai/types";
import { MarkdownRenderer } from "../../obsidian/markdown/renderer";
import { MarkdownView } from "../../obsidian/markdown/markdown-view";
import { Component } from "../../obsidian/events";
import { setIcon } from "../../obsidian/ui/icons";
import { Keymap } from "../../obsidian/ui/keymap";
import { Menu } from "../../obsidian/ui/menu";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { FuzzySuggestModal } from "../../obsidian/ui/suggest";
import { moment, normalizePath } from "../../obsidian/util";
import { TFile, TFolder, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ItemView } from "../../obsidian/workspace/view";
import { linkHeading } from "../semantic/engine";
import { budgetFor, buildMessages, conversationMarkdown, fitSources, linkCitations, SYSTEM_PROMPT, type Source, type Turn } from "./prompt";

export const VIEW_TYPE_VAULT_CHAT = "vault-chat";

export interface VaultChatHost {
  options: { conversationFolder: string };
  steppedAside(): boolean;
  openAiSettings(): void;
}

interface PassageHitLike {
  key: number;
  path: string;
  headings: string[];
  startLine: number;
  endLine: number;
  score: number;
}

interface SemanticInstance {
  search(text: string, opts?: { k?: number; kind?: "query" | "document"; excludePaths?: string[]; onlyPaths?: string[]; signal?: AbortSignal }): Promise<PassageHitLike[]>;
  passageText(keys: number[]): Promise<Map<number, string>>;
  getStatus(): { state: string; notes: number; message: string; done: number; total: number };
}

interface ChatTurn extends Turn {
  sources: Source[];
  engine: EngineInfo | null;
}

export function engineSentence(engine: EngineInfo | null): string {
  if (!engine) return "";
  if (engine.location === "device") return `Answered on this device · ${engine.model}`;
  if (!engine.leavesDevice) return `Answered by ${providerName(engine.provider)} on this computer · ${engine.model}`;
  return `Sent to ${providerName(engine.provider)} · ${engine.model}`;
}

function providerName(id: string): string {
  const names: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Google Gemini", ollama: "Ollama", lmstudio: "LM Studio", "lm-studio": "LM Studio", "openai-compatible": "your AI server", "chrome-builtin": "Chrome", transformers: "Transformers.js" };
  return names[id] ?? id;
}

class PinSuggestModal extends FuzzySuggestModal<TAbstractFile> {
  constructor(
    app: any,
    private onPick: (f: TAbstractFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Pin a note or folder as context…");
  }
  getItems(): TAbstractFile[] {
    const all = this.app.vault.getAllLoadedFiles() as TAbstractFile[];
    return all.filter((f) => (f instanceof TFile && f.extension === "md") || (f instanceof TFolder && !f.isRoot()));
  }
  getItemText(f: TAbstractFile): string {
    return f instanceof TFolder ? `${f.path}/` : f.path;
  }
  onChooseItem(f: TAbstractFile): void {
    this.onPick(f);
  }
}

class InsertPreviewModal extends Modal {
  private component = new Component();

  constructor(
    app: any,
    private text: string,
    private target: MarkdownView,
  ) {
    super(app);
    this.modalEl.addClass("vault-chat-insert-modal");
    this.setTitle(`Insert into “${target.file?.basename ?? "note"}”`);
  }

  override onOpen() {
    this.component.load();
    const { contentEl } = this;
    contentEl.createDiv({ cls: "setting-item-description", text: "This text will be inserted at the cursor. Edit it first if you like." });
    const tabs = contentEl.createDiv({ cls: "vault-chat-insert-tabs" });
    const preview = contentEl.createDiv({ cls: "vault-chat-insert-preview markdown-rendered" });
    const area = contentEl.createEl("textarea", { cls: "vault-chat-insert-source" });
    area.value = this.text;
    area.rows = 10;
    area.hide();
    const renderPreview = () => {
      preview.empty();
      void MarkdownRenderer.render(this.app, area.value, preview, this.target.file?.path ?? "", this.component);
    };
    const tab = (label: string, show: () => void) => {
      const b = tabs.createEl("button", { text: label });
      b.addEventListener("click", () => {
        tabs.querySelectorAll("button").forEach((x) => x.removeClass("is-active"));
        b.addClass("is-active");
        show();
      });
      return b;
    };
    tab("Preview", () => {
      area.hide();
      renderPreview();
      preview.show();
    }).addClass("is-active");
    tab("Edit", () => {
      preview.hide();
      area.show();
      area.focus();
    });
    renderPreview();
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    const insert = buttons.createEl("button", { cls: "mod-cta", text: "Insert" });
    insert.addEventListener("click", () => {
      const editor = this.target.editor;
      if (!editor) return;
      // One transaction: a single undo removes it.
      editor.replaceSelection(area.value.trim() + "\n");
      this.close();
      new Notice(`Inserted into ${this.target.file?.basename ?? "the note"}.`);
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  override onClose() {
    this.component.unload();
    this.contentEl.empty();
  }
}

export class VaultChatView extends ItemView {
  hoverPopover: any = null;
  private turns: ChatTurn[] = [];
  private pins: string[] = [];
  private pinsEl!: HTMLElement;
  private noticeEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private controller: AbortController | null = null;
  private lastEditor: MarkdownView | null = null;
  private renderComponent = new Component();

  constructor(
    leaf: WorkspaceLeaf,
    private host: VaultChatHost,
  ) {
    super(leaf);
    this.icon = "lucide-messages-square";
    this.navigation = false;
  }

  getViewType() {
    return VIEW_TYPE_VAULT_CHAT;
  }
  getDisplayText() {
    return "Chat with vault";
  }
  override getIcon() {
    return "lucide-messages-square";
  }

  private ai(): AiService | null {
    const ai = this.app.ai as AiService | undefined;
    return ai && typeof ai.isAvailable === "function" ? ai : null;
  }

  private semantic(): SemanticInstance | null {
    const inst = this.app.internalPlugins.getEnabledPluginById("semantic");
    return inst && typeof inst.search === "function" ? (inst as SemanticInstance) : null;
  }

  override async onOpen() {
    this.addChild(this.renderComponent);
    const el = this.contentEl;
    el.empty();
    el.addClass("vault-chat-view");
    this.pinsEl = el.createDiv({ cls: "vault-chat-pins" });
    this.noticeEl = el.createDiv({ cls: "vault-chat-notice" });
    this.messagesEl = el.createDiv({ cls: "vault-chat-messages", attr: { "aria-live": "polite" } });
    const form = el.createDiv({ cls: "vault-chat-form" });
    this.inputEl = form.createEl("textarea", { cls: "vault-chat-input", attr: { placeholder: "Ask about your notes…", rows: "2", "aria-label": "Question" } });
    this.sendBtn = form.createEl("button", { cls: "mod-cta vault-chat-send", text: "Ask" });
    this.sendBtn.addEventListener("click", () => (this.controller ? this.controller.abort() : void this.ask()));
    this.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        if (!this.controller) void this.ask();
      }
    });
    this.addAction("lucide-eraser", "Clear conversation", () => this.clear());
    this.addAction("lucide-save", "Save conversation as note", () => void this.saveConversation());

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const v = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (v) this.lastEditor = v;
      }),
    );
    this.lastEditor = this.app.workspace.getActiveViewOfType(MarkdownView);
    const ai = this.ai();
    if (ai) {
      const ref = ai.on("change", () => this.renderNotice());
      this.register(() => ai.offref(ref));
    }
    this.registerInterval(window.setInterval(() => this.renderNotice(), 4000));
    this.renderPins();
    this.renderNotice();
    this.renderEmptyState();
  }

  override async onClose() {
    this.controller?.abort();
  }

  override getState(): Record<string, unknown> {
    return { pins: this.pins };
  }

  override async setState(state: any, result: any): Promise<void> {
    if (Array.isArray(state?.pins)) {
      this.pins = state.pins.filter((p: unknown) => typeof p === "string");
      if (this.pinsEl) this.renderPins();
    }
    await super.setState(state, result);
  }

  // ---- context pins -----------------------------------------------------------------

  // internal (used by tests)
  pin(path: string) {
    if (!this.pins.includes(path)) this.pins.push(path);
    this.renderPins();
    this.app.workspace.requestSaveLayout();
  }

  private unpin(path: string) {
    this.pins = this.pins.filter((p) => p !== path);
    this.renderPins();
    this.app.workspace.requestSaveLayout();
  }

  private renderPins() {
    const el = this.pinsEl;
    el.empty();
    el.createSpan({ cls: "vault-chat-pins-label", text: this.pins.length ? "Context:" : "Context: whole vault" });
    for (const path of this.pins) {
      const f = this.app.vault.getAbstractFileByPath(path);
      const chip = el.createDiv({ cls: "vault-chat-pin", attr: { "data-path": path } });
      setIcon(chip.createSpan({ cls: "vault-chat-pin-icon" }), f instanceof TFolder ? "lucide-folder" : "lucide-file-text");
      chip.createSpan({ text: f instanceof TFile ? f.basename : f ? f.name : `${path} (missing)` });
      const x = chip.createSpan({ cls: "vault-chat-pin-remove clickable-icon", attr: { "aria-label": "Unpin" } });
      setIcon(x, "lucide-x");
      x.addEventListener("click", () => this.unpin(path));
    }
    const add = el.createDiv({ cls: "clickable-icon vault-chat-pin-add", attr: { "aria-label": "Pin notes or folders as context" } });
    setIcon(add, "lucide-pin");
    add.addEventListener("click", (evt) => {
      const menu = new Menu();
      const active = this.lastEditor?.file ?? this.app.workspace.getActiveFile();
      if (active) menu.addItem((i) => i.setTitle(`Pin “${active.basename}”`).setIcon("lucide-file-text").onClick(() => this.pin(active.path)));
      menu.addItem((i) => i.setTitle("Pin a note or folder…").setIcon("lucide-search").onClick(() => new PinSuggestModal(this.app, (f) => this.pin(f.path)).open()));
      if (this.pins.length) menu.addItem((i) => i.setTitle("Unpin all (use whole vault)").setIcon("lucide-pin-off").onClick(() => ((this.pins = []), this.renderPins())));
      menu.showAtMouseEvent(evt);
    });
  }

  /** Markdown files in the pinned notes and folders. */
  private pinnedPaths(): string[] {
    const out = new Set<string>();
    const walk = (f: TAbstractFile | null) => {
      if (f instanceof TFile && f.extension === "md") out.add(f.path);
      else if (f instanceof TFolder) for (const c of f.children) walk(c);
    };
    for (const p of this.pins) walk(this.app.vault.getAbstractFileByPath(p));
    return Array.from(out);
  }

  // ---- availability -------------------------------------------------------------------

  private unavailableReason(): { text: string; action?: { label: string; run: () => void } } | null {
    if (this.host.steppedAside()) return { text: "Smart Connections is enabled. Use its chat, or turn it off to chat here." };
    const ai = this.ai();
    if (!ai || !ai.isAvailable("chat", "generate")) return { text: "Chat with vault needs AI. Turn on AI and choose an engine for “Chat” in Settings → AI.", action: { label: "Open AI settings", run: () => this.host.openAiSettings() } };
    if (!ai.isAvailable("related", "embed")) return { text: "To find passages, choose an embedding engine for “Related notes” in Settings → AI.", action: { label: "Open AI settings", run: () => this.host.openAiSettings() } };
    if (this.app.internalPlugins.isUninstalled?.("semantic"))
      return {
        text: "Chat finds passages with the Related notes index, and Related notes is uninstalled. Reinstall it in Settings → Community plugins.",
        action: {
          label: "Open Community plugins",
          run: () => {
            this.app.setting.open();
            this.app.setting.openTabById("community-plugins");
          },
        },
      };
    if (!this.semantic())
      return {
        text: "Chat finds passages with the Related notes index. Turn it on to start indexing.",
        action: { label: "Turn on Related notes", run: () => void this.app.internalPlugins.setEnabled("semantic", true).then(() => this.renderNotice()) },
      };
    return null;
  }

  private renderNotice() {
    const reason = this.unavailableReason();
    const key = reason ? reason.text : `ok:${this.semantic()?.getStatus().state}`;
    if (this.noticeEl.dataset.key === key) return;
    this.noticeEl.dataset.key = key;
    this.noticeEl.empty();
    this.inputEl.disabled = !!reason;
    this.sendBtn.disabled = !!reason && !this.controller;
    if (reason) {
      this.noticeEl.show();
      this.noticeEl.createDiv({ text: reason.text });
      if (reason.action) this.noticeEl.createEl("button", { cls: "mod-cta", text: reason.action.label }).addEventListener("click", reason.action.run);
      return;
    }
    const s = this.semantic()!.getStatus();
    if (s.state === "indexing" || s.state === "loading") {
      this.noticeEl.show();
      this.noticeEl.setText(`Still indexing (${s.done} of ${s.total}); answers may miss notes that are not indexed yet.`);
    } else this.noticeEl.hide();
  }

  private renderEmptyState() {
    if (this.turns.length) return;
    this.messagesEl.empty();
    const empty = this.messagesEl.createDiv({ cls: "vault-chat-empty" });
    empty.createDiv({ cls: "vault-chat-empty-title", text: "Ask your notes" });
    empty.createDiv({ text: "Answers use passages from your vault and cite the notes they come from. Pin notes or folders to narrow the context." });
  }

  // ---- asking ------------------------------------------------------------------------

  private async retrieve(question: string, signal: AbortSignal, budget: ReturnType<typeof budgetFor>): Promise<Source[]> {
    const semantic = this.semantic();
    if (!semantic) return [];
    const onlyPaths = this.pins.length ? this.pinnedPaths() : undefined;
    // Follow-up questions ("and the second one?") need the previous question to find anything.
    const prev = this.turns[this.turns.length - 1]?.question;
    const query = prev && question.length < 80 ? `${prev}\n${question}` : question;
    const hits = onlyPaths && !onlyPaths.length ? [] : await semantic.search(query, { k: budget.maxPassages * 3, kind: "query", onlyPaths });
    const texts = await semantic.passageText(hits.map((h) => h.key));
    const ranked = hits
      .filter((h) => texts.has(h.key))
      // Skip near-duplicates (overlapping passages of the same section).
      .filter((h, i, arr) => !arr.slice(0, i).some((o) => o.path === h.path && o.startLine <= h.endLine && h.startLine <= o.endLine))
      .map((h) => ({ ...h, text: texts.get(h.key)! }));
    const fitted = fitSources(ranked, budget);
    return fitted.map((h, i) => {
      const file = this.app.vault.getFileByPath(h.path) as TFile | null;
      const base = file ? this.app.metadataCache.fileToLinktext(file, "", true) : h.path.replace(/\.md$/, "");
      const heading = linkHeading(h.path, h.headings);
      return { n: i + 1, path: h.path, headings: h.headings, startLine: h.startLine, endLine: h.endLine, linktext: heading ? `${base}#${heading}` : base, text: h.text, score: h.score };
    });
  }

  private resolves = (linktext: string): boolean => {
    const [path, sub] = linktext.split("#");
    const file = this.app.metadataCache.getFirstLinkpathDest(path ?? "", "") as TFile | null;
    if (!file) return false;
    if (!sub) return true;
    const headings: { heading: string }[] = this.app.metadataCache.getFileCache(file)?.headings ?? [];
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return headings.some((h) => norm(h.heading) === norm(sub));
  };

  // internal (used by tests)
  async ask(question = this.inputEl.value.trim()): Promise<void> {
    if (!question || this.controller) return;
    const reason = this.unavailableReason();
    if (reason) {
      new Notice(reason.text);
      return;
    }
    const ai = this.ai()!;
    if (!this.turns.length) this.messagesEl.empty();
    this.inputEl.value = "";
    const turnEl = this.messagesEl.createDiv({ cls: "vault-chat-turn" });
    turnEl.createDiv({ cls: "vault-chat-message mod-user", text: question });
    const answerEl = turnEl.createDiv({ cls: "vault-chat-message mod-assistant is-streaming" });
    const statusEl = answerEl.createDiv({ cls: "vault-chat-status", text: "Finding passages…" });
    const bodyEl = answerEl.createDiv({ cls: "vault-chat-answer" });
    this.scrollDown();
    const controller = new AbortController();
    this.controller = controller;
    this.sendBtn.setText("Stop");
    this.sendBtn.disabled = false;
    let raw = "";
    let sources: Source[] = [];
    let engine: EngineInfo | null = ai.engineFor("chat", "generate");
    try {
      if (!(await ai.ensureConsent("chat", "generate"))) throw new AiUnavailableError("consent-declined", "Chat was not allowed to use the engine.");
      const budget = budgetFor(engine);
      sources = await this.retrieve(question, controller.signal, budget);
      if (controller.signal.aborted) throw new DOMException("Stopped", "AbortError");
      statusEl.setText(sources.length ? `Using ${sources.length} passage${sources.length === 1 ? "" : "s"}…` : "No matching passages; answering anyway…");
      const result = await ai.generate({
        feature: "chat",
        system: SYSTEM_PROMPT,
        messages: buildMessages(question, sources, this.turns, budget),
        maxTokens: budget.maxAnswerTokens,
        temperature: 0.2,
        signal: controller.signal,
        onToken: (t) => {
          raw += t;
          statusEl.hide();
          bodyEl.setText(raw);
          this.scrollDown();
        },
      });
      raw = result.text || raw;
      engine = result.engine ?? engine;
      await this.finishAnswer(answerEl, bodyEl, statusEl, question, raw, sources, engine);
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError" || controller.signal.aborted;
      if (aborted && raw) await this.finishAnswer(answerEl, bodyEl, statusEl, question, raw + " …(stopped)", sources, engine);
      else {
        answerEl.removeClass("is-streaming");
        answerEl.addClass(aborted ? "mod-stopped" : "mod-error");
        statusEl.show();
        statusEl.setText(aborted ? "Stopped." : e instanceof AiUnavailableError ? e.message : `Something went wrong: ${(e as Error)?.message ?? e}`);
      }
    } finally {
      this.controller = null;
      this.sendBtn.setText("Ask");
      this.renderNotice();
    }
  }

  private async finishAnswer(answerEl: HTMLElement, bodyEl: HTMLElement, statusEl: HTMLElement, question: string, raw: string, sources: Source[], engine: EngineInfo | null) {
    const answer = linkCitations(raw.trim() || "(No answer.)", sources, this.resolves);
    const turn: ChatTurn = { question, answer, sources, engine };
    this.turns.push(turn);
    answerEl.removeClass("is-streaming");
    statusEl.hide();
    bodyEl.empty();
    bodyEl.addClass("markdown-rendered");
    await MarkdownRenderer.render(this.app, answer, bodyEl, "", this.renderComponent);
    // Citation links open the passage (the renderer's links open the note at the heading).
    bodyEl.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => a.addClass("vault-chat-citation"));

    if (sources.length) {
      const src = answerEl.createEl("details", { cls: "vault-chat-sources" });
      src.createEl("summary", { text: `${sources.length} source${sources.length === 1 ? "" : "s"}` });
      for (const s of sources) {
        const row = src.createDiv({ cls: "vault-chat-source tappable", attr: { "data-path": s.path, "data-line": String(s.startLine) } });
        row.createSpan({ cls: "vault-chat-source-n", text: String(s.n) });
        const file = this.app.vault.getFileByPath(s.path) as TFile | null;
        row.createSpan({ cls: "vault-chat-source-title", text: [file?.basename ?? s.path, ...s.headings.slice(-1)].join(" › ") });
        row.addEventListener("click", (evt) => {
          if (file) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file, { active: true, eState: { line: s.startLine } });
        });
        row.addEventListener("mouseover", (evt) => {
          this.app.workspace.trigger("hover-link", { event: evt, source: "vault-chat", hoverParent: this, targetEl: row, linktext: s.linktext, sourcePath: "" });
        });
      }
    }
    const footer = answerEl.createDiv({ cls: "vault-chat-footer" });
    footer.createSpan({ cls: "vault-chat-engine", text: engineSentence(engine) });
    const actions = footer.createDiv({ cls: "vault-chat-actions" });
    const action = (icon: string, label: string, run: () => void) => {
      const b = actions.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(b, icon);
      b.addEventListener("click", run);
    };
    action("lucide-copy", "Copy", () => void navigator.clipboard?.writeText(answer).then(() => new Notice("Copied.")));
    action("lucide-text-cursor-input", "Insert into note", () => this.insertIntoNote(answer));
    this.scrollDown();
  }

  private scrollDown() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  // internal (used by tests)
  insertIntoNote(text: string) {
    const target = this.lastEditor?.leaf?.parent ? this.lastEditor : this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!target?.editor) {
      new Notice("Open a note to insert into.");
      return;
    }
    new InsertPreviewModal(this.app, text, target).open();
  }

  clear() {
    this.controller?.abort();
    this.turns = [];
    this.renderComponent.unload();
    this.renderComponent = new Component();
    this.addChild(this.renderComponent);
    this.renderEmptyState();
  }

  // internal (used by tests)
  async saveConversation(): Promise<TFile | null> {
    if (!this.turns.length) {
      new Notice("Nothing to save yet.");
      return null;
    }
    const folder = normalizePath(this.host.options.conversationFolder || "/");
    if (folder !== "/" && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const name = `Chat ${moment().format("YYYY-MM-DD HH.mm")}`;
    const base = folder === "/" ? name : `${folder}/${name}`;
    const path = this.app.vault.getAvailablePath(base, "md");
    const md = conversationMarkdown(
      this.turns.map((t) => ({ ...t, engine: engineSentence(t.engine) })),
      moment().format("YYYY-MM-DDTHH:mm"),
    );
    const file = (await this.app.vault.create(path, md)) as TFile;
    await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
    new Notice(`Saved conversation to ${file.path}.`);
    return file;
  }
}
