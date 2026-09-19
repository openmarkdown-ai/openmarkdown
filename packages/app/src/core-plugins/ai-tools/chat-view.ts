/**
 * "Ask about this note": a side pane that answers questions grounded on the
 * active note, streaming from the engine routed to "Chat" in Settings → AI.
 */
import { describeEngine, type AiMessage } from "../../ai/index";
import { isAbort } from "../../ai/ui";
import { MarkdownView } from "../../obsidian/markdown/markdown-view";
import { setIcon } from "../../obsidian/ui/icons";
import { ItemView } from "../../obsidian/workspace/view";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import type { TFile } from "../../obsidian/vault/files";
import { getFrontMatterInfo } from "../../obsidian/util";
import type { AiToolsPlugin } from "./index";

export const VIEW_TYPE_AI_CHAT = "ai-tools-chat";
const MAX_NOTE_CHARS = 16_000;

export class AiChatView extends ItemView {
  private file: TFile | null = null;
  private history: AiMessage[] = [];
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private contextEl!: HTMLElement;
  private controller: AbortController | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private host: AiToolsPlugin,
  ) {
    super(leaf);
    this.icon = "lucide-message-square-text";
  }

  getViewType(): string {
    return VIEW_TYPE_AI_CHAT;
  }
  getDisplayText(): string {
    return "Ask about this note";
  }
  override getIcon(): string {
    return "lucide-message-square-text";
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("vault-ai-chat");
    this.contextEl = this.contentEl.createDiv({ cls: "vault-ai-chat-context" });
    this.messagesEl = this.contentEl.createDiv({ cls: "vault-ai-chat-messages", attr: { "aria-live": "polite" } });
    const form = this.contentEl.createDiv({ cls: "vault-ai-chat-form" });
    this.inputEl = form.createEl("textarea", { cls: "vault-ai-chat-input", attr: { placeholder: "Ask a question about this note…", rows: "2" } });
    this.sendBtn = form.createEl("button", { cls: "mod-cta vault-ai-chat-send", text: "Ask" });
    this.sendBtn.addEventListener("click", () => (this.controller ? this.controller.abort() : void this.ask()));
    this.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        if (!this.controller) void this.ask();
      }
    });
    this.addAction("lucide-eraser", "Clear conversation", () => this.reset());
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.followActiveNote()));
    const ai = this.host.ai;
    if (ai) {
      const ref = ai.on("change", () => this.renderContext());
      this.register(() => ai.offref(ref));
    }
    this.followActiveNote();
  }

  override async onClose(): Promise<void> {
    this.controller?.abort();
  }

  private followActiveNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file ?? null;
    if (!file || file === this.file) {
      this.renderContext();
      return;
    }
    this.file = file;
    this.reset();
  }

  private reset() {
    this.controller?.abort();
    this.history = [];
    this.messagesEl.empty();
    this.renderContext();
  }

  private renderContext() {
    this.contextEl.empty();
    const engine = this.host.ai?.engineFor("chat") ?? null;
    if (!engine) {
      this.contextEl.createDiv({ cls: "vault-ai-chat-unavailable", text: "No AI engine is set up for Chat. Turn AI on and choose an engine in Settings → AI." });
      this.inputEl.disabled = true;
      this.sendBtn.disabled = true;
      return;
    }
    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
    const icon = this.contextEl.createSpan({ cls: "vault-ai-chat-context-icon" });
    setIcon(icon, "lucide-file-text");
    this.contextEl.createSpan({ text: this.file ? this.file.basename : "Open a note to ask about it" });
    const where = this.contextEl.createDiv({ cls: "vault-ai-engine", attr: { "data-location": engine.location } });
    const whereIcon = where.createSpan({ cls: "vault-ai-engine-icon" });
    setIcon(whereIcon, engine.leavesDevice ? "lucide-cloud" : engine.location === "local-server" ? "lucide-server" : "lucide-cpu");
    where.createSpan({ text: describeEngine(engine) });
    if (engine.leavesDevice) this.contextEl.createDiv({ cls: "vault-ai-chat-remote-warning mod-warning", text: `The note and your questions are sent to ${engine.provider === "openai-compatible" ? "your AI server" : (this.host.ai?.getProvider(engine.provider)?.label ?? engine.provider)}.` });
  }

  private async noteText(): Promise<{ text: string; truncated: boolean }> {
    if (!this.file) return { text: "", truncated: false };
    // Prefer the open editor's buffer: it may hold edits not yet saved to disk.
    const open = this.app.workspace.getLeavesOfType("markdown").map((l: { view: MarkdownView }) => l.view).find((v: MarkdownView) => v.file === this.file && v.editor);
    const raw: string = open ? open.editor.getValue() : await this.app.vault.cachedRead(this.file);
    const body = raw.slice(getFrontMatterInfo(raw).contentStart);
    return { text: body.slice(0, MAX_NOTE_CHARS), truncated: body.length > MAX_NOTE_CHARS };
  }

  private addMessage(role: "user" | "assistant" | "error", text: string): HTMLElement {
    const el = this.messagesEl.createDiv({ cls: `vault-ai-chat-message mod-${role}` });
    el.setText(text);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return el;
  }

  // internal (used by tests)
  async ask(question = this.inputEl.value.trim()): Promise<void> {
    if (!question || !this.file) return;
    this.inputEl.value = "";
    this.addMessage("user", question);
    const answerEl = this.addMessage("assistant", "…");
    answerEl.addClass("is-streaming");
    const controller = new AbortController();
    this.controller = controller;
    this.sendBtn.setText("Stop");
    try {
      const { text, truncated } = await this.noteText();
      const system = `You answer questions about the user's note. Use only the note; say so when it does not contain the answer. Answer in the question's language, concisely, in Markdown.${truncated ? " The note was cut off because it is long." : ""}\n\nNOTE "${this.file.basename}":\n${text}`;
      const messages: AiMessage[] = [...this.history, { role: "user", content: question }];
      const r = await this.host.generate(
        {
          signal: controller.signal,
          onChunk: (s) => {
            answerEl.setText(s);
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
          },
        },
        { system, messages },
        "chat",
      );
      if (!r) {
        answerEl.setText("(Cancelled.)");
        return;
      }
      answerEl.setText(r.text.trim() ? r.text : "(No answer.)");
      this.history.push({ role: "user", content: question }, { role: "assistant", content: r.text });
    } catch (e) {
      if (isAbort(e)) answerEl.setText(answerEl.getText() === "…" ? "(Stopped.)" : `${answerEl.getText()} (stopped)`);
      else {
        answerEl.remove();
        this.addMessage("error", (e as Error).message || String(e));
      }
    } finally {
      answerEl.removeClass("is-streaming");
      this.controller = null;
      this.sendBtn.setText("Ask");
    }
  }
}
