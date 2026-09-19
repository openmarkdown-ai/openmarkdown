/**
 * Core plugin AI tools (`ai-tools`): summarize, translate, rewrite, proofread
 * and write, and a side pane to ask questions about the open note.
 *
 * Every request goes through `app.ai` (packages/app/src/ai), which picks the
 * engine the user routed "Writing tools" and "Chat" to in Settings → AI (on
 * this device by default: the browser's built-in models), asks before a
 * download or before text leaves the device, and says where each result came
 * from. Commands whose engine is missing are hidden. Results are previewed and
 * applied only when the user picks an action; each application is one undo step.
 */
import { AiUnavailableError, describeEngine, migrateAiToolsSettings, type AiServiceImpl, type AiTaskHint, type EngineInfo, type GenerateRequest } from "../../ai/index";
import { API_LABELS, type ApiName, availability, createWithConsent } from "../../ai/engines/chrome";
import { MarkdownView } from "../../obsidian/markdown/markdown-view";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { ButtonComponent, DropdownComponent, Setting, TextAreaComponent } from "../../obsidian/ui/setting";
import { getFrontMatterInfo } from "../../obsidian/util";
import { AiChatView, VIEW_TYPE_AI_CHAT } from "./chat-view";
import { wordDiff } from "./diff";
import { isAbort } from "../../ai/ui";

export { wordDiff } from "./diff";

export type SummaryType = "key-points" | "tldr" | "teaser" | "headline";
export type SummaryLength = "short" | "medium" | "long";
export type RewriteMode = "shorter" | "longer" | "more-formal" | "more-casual";
export const REWRITE_LABELS: Record<RewriteMode, string> = { shorter: "Shorter", longer: "Longer", "more-formal": "More formal", "more-casual": "More casual" };

export interface AiToolsOptions {
  targetLanguage: string;
  summaryType: SummaryType;
  summaryLength: SummaryLength;
  rewriteMode: RewriteMode;
  /** Before `app.ai`: carried into Settings → AI once (the OpenAI-compatible engine), then unused. */
  remoteEnabled: boolean;
  remoteBaseUrl: string;
  remoteModel: string;
}

export const TRANSLATE_LANGUAGES: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", nl: "Dutch", pl: "Polish", sv: "Swedish", da: "Danish", fi: "Finnish", nb: "Norwegian",
  cs: "Czech", ro: "Romanian", hu: "Hungarian", el: "Greek", tr: "Turkish", ru: "Russian", uk: "Ukrainian", bg: "Bulgarian", hr: "Croatian", sk: "Slovak", sl: "Slovenian", lt: "Lithuanian",
  ar: "Arabic", he: "Hebrew", hi: "Hindi", bn: "Bengali", mr: "Marathi", ta: "Tamil", te: "Telugu", kn: "Kannada", th: "Thai", vi: "Vietnamese", id: "Indonesian", ja: "Japanese", ko: "Korean",
  zh: "Chinese (simplified)", "zh-Hant": "Chinese (traditional)",
};

interface TextTarget {
  view: MarkdownView;
  text: string;
  from: number;
  to: number;
  isSelection: boolean;
}

function targetOf(view: MarkdownView): TextTarget {
  const editor = view.editor;
  if (editor.somethingSelected()) {
    return { view, text: editor.getSelection(), from: editor.posToOffset(editor.getCursor("from")), to: editor.posToOffset(editor.getCursor("to")), isSelection: true };
  }
  const all = editor.getValue();
  const start = getFrontMatterInfo(all).contentStart;
  return { view, text: all.slice(start), from: start, to: all.length, isSelection: false };
}

function replaceRange(t: TextTarget, text: string) {
  const e = t.view.editor;
  e.replaceRange(text, e.offsetToPos(t.from), e.offsetToPos(t.to));
}

function insertBelow(t: TextTarget, text: string) {
  const e = t.view.editor;
  const end = e.offsetToPos(t.to);
  const lineEnd = { line: end.line, ch: e.getLine(end.line).length };
  e.replaceRange(`\n\n${text.trim()}\n`, lineEnd);
}

export function summaryCallout(summary: string): string {
  const lines = summary.trim().split("\n").map((l) => (l ? `> ${l}` : ">"));
  return `> [!summary]\n${lines.join("\n")}\n`;
}

/** "Working on this device…", "Sending to Anthropic…". */
function workingLabel(engine: EngineInfo | null): string {
  if (!engine) return "Working…";
  if (engine.location === "device") return "Working on this device…";
  const label = describeEngine(engine);
  return label.startsWith("Sent to ") ? `Sending to ${label.slice(8)}…` : `Working: ${label}…`;
}

interface AiAction {
  label: string;
  cta?: boolean;
  run(output: string): void | Promise<void>;
}

/** Preview modal: optional controls, a streaming output, and the actions that apply it. */
export class AiModal extends Modal {
  private outputEl: HTMLElement;
  private statusEl: HTMLElement;
  private actionButtons: ButtonComponent[] = [];
  private runBtn: ButtonComponent;
  private controller: AbortController | null = null;
  output = "";

  constructor(
    app: any,
    private opts: {
      title: string;
      controls?: (el: HTMLElement) => void;
      runLabel?: string;
      autoRun: boolean;
      diffAgainst?: string;
      engine?: () => EngineInfo | null;
      run(ctx: { signal: AbortSignal; onChunk: (s: string) => void }): Promise<string | null>;
      actions: AiAction[];
    },
  ) {
    super(app);
    this.modalEl.addClass("vault-ai-modal");
    this.setTitle(opts.title);
    const controls = this.contentEl.createDiv({ cls: "vault-ai-controls" });
    opts.controls?.(controls);
    if (!controls.childElementCount) controls.remove();
    this.outputEl = this.contentEl.createDiv({ cls: "vault-ai-output", attr: { tabindex: "0", "aria-live": "polite" } });
    this.statusEl = this.contentEl.createDiv({ cls: "vault-ai-status setting-item-description" });
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    this.runBtn = new ButtonComponent(buttons).setButtonText(opts.runLabel ?? "Try again").onClick(() => void this.run());
    for (const action of opts.actions) {
      const b = new ButtonComponent(buttons).setButtonText(action.label).setDisabled(true);
      if (action.cta) b.setCta();
      b.onClick(async () => {
        await action.run(this.output);
        this.close();
      });
      this.actionButtons.push(b);
    }
    const copy = new ButtonComponent(buttons).setButtonText("Copy").setDisabled(true);
    copy.onClick(async () => {
      await navigator.clipboard.writeText(this.output).catch(() => {});
      new Notice("Copied.");
    });
    this.actionButtons.push(copy);
  }

  override onOpen() {
    if (this.opts.autoRun) void this.run();
  }

  override onClose() {
    this.controller?.abort();
  }

  async run() {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.output = "";
    this.outputEl.empty();
    this.outputEl.addClass("is-running");
    const engine = this.opts.engine?.() ?? null;
    this.statusEl.setText(workingLabel(engine));
    for (const b of this.actionButtons) b.setDisabled(true);
    this.runBtn.setDisabled(true);
    try {
      const result = await this.opts.run({ signal: controller.signal, onChunk: (s) => this.render(s) });
      if (controller.signal.aborted) return;
      if (result === null) {
        this.statusEl.setText("Cancelled.");
        return;
      }
      this.output = result;
      this.render(result, true);
      const where = engine ? `${describeEngine(engine)}. ` : "";
      this.statusEl.setText(result.trim() ? `Done. ${where}Nothing changes until you pick an action.` : "The model returned nothing.");
      for (const b of this.actionButtons) b.setDisabled(!result.trim());
    } catch (e) {
      if (isAbort(e)) return;
      this.statusEl.setText("");
      this.outputEl.empty();
      this.outputEl.createDiv({ cls: "vault-ai-error mod-warning", text: (e as Error).message || String(e) });
    } finally {
      if (this.controller === controller) this.controller = null;
      this.outputEl.removeClass("is-running");
      this.runBtn.setDisabled(false);
    }
  }

  private render(text: string, final = false) {
    this.outputEl.empty();
    if (final && this.opts.diffAgainst !== undefined) {
      for (const [op, s] of wordDiff(this.opts.diffAgainst, text)) {
        if (op === 0) this.outputEl.appendText(s);
        else this.outputEl.createEl(op > 0 ? "ins" : "del", { text: s });
      }
      return;
    }
    this.outputEl.setText(text);
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }
}

type RunCtx = { signal: AbortSignal; onChunk: (s: string) => void };

export class AiToolsPlugin extends Plugin {
  instance!: any;

  get options(): AiToolsOptions {
    return this.instance.options as AiToolsOptions;
  }

  get ai(): AiServiceImpl | null {
    const ai = (this.app as { ai?: AiServiceImpl }).ai;
    return ai && typeof ai.canDoTask === "function" ? ai : null;
  }

  /** Whether `kind` can run now for the writing tools. */
  can(kind: AiTaskHint["kind"]): boolean {
    return !!this.ai?.canDoTask("tools", kind);
  }

  /**
   * One request through `app.ai`, streaming into `onChunk` (the text so far).
   * Resolves null when the user declined a download or sending.
   */
  async generate(ctx: RunCtx, req: Omit<GenerateRequest, "feature" | "signal" | "onToken">, feature: "tools" | "chat" = "tools"): Promise<{ text: string; data?: { language?: string; confidence?: number } } | null> {
    const ai = this.ai;
    if (!ai) throw new Error("AI is not available in this app.");
    let acc = "";
    try {
      const r = await ai.generate({
        ...req,
        feature,
        signal: ctx.signal,
        onToken: (t) => {
          acc += t;
          ctx.onChunk(acc);
        },
      });
      return { text: r.text, data: r.data };
    } catch (e) {
      if (e instanceof AiUnavailableError && e.reason === "consent-declined") return null;
      if (isAbort(e) && !ctx.signal.aborted) return null;
      throw e;
    }
  }

  override async onload() {
    void migrateAiToolsSettings(this.app, this.options);
    this.registerView(VIEW_TYPE_AI_CHAT, (leaf) => new AiChatView(leaf, this));
    const withView = (can: () => boolean, needSelection: boolean, run: (view: MarkdownView) => void) => (checking: boolean) => {
      if (!can()) return false;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.file || view.getMode() === "preview") return false;
      if (needSelection && !view.editor.somethingSelected()) return false;
      if (!checking) run(view);
      return true;
    };

    this.addCommand({ id: "ai-tools:summarize", name: "Summarize note or selection", icon: "lucide-list-collapse", checkCallback: withView(() => this.can("summarize"), false, (v) => this.summarize(v)) });
    this.addCommand({ id: "ai-tools:translate", name: "Translate note or selection", icon: "lucide-languages", checkCallback: withView(() => this.can("translate"), false, (v) => this.translate(v)) });
    this.addCommand({ id: "ai-tools:rewrite", name: "Rewrite selection", icon: "lucide-wand-sparkles", checkCallback: withView(() => this.can("rewrite"), true, (v) => this.rewrite(v)) });
    this.addCommand({ id: "ai-tools:proofread", name: "Proofread note or selection", icon: "lucide-spell-check", checkCallback: withView(() => this.can("proofread"), false, (v) => this.proofread(v)) });
    this.addCommand({ id: "ai-tools:write", name: "Write with AI at cursor", icon: "lucide-pen-line", checkCallback: withView(() => this.can("write"), false, (v) => this.write(v)) });
    this.addCommand({ id: "ai-tools:detect-language", name: "Detect note language", icon: "lucide-globe", checkCallback: withView(() => this.can("detect-language"), false, (v) => void this.detect(v)) });
    this.addCommand({
      id: "ai-tools:ask-note",
      name: "Ask about this note",
      icon: "lucide-message-square-text",
      checkCallback: (checking) => {
        if (!this.ai?.isAvailable("chat")) return false;
        if (!checking) void this.openChat();
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: any, editor: any, view: any) => {
        if (!(view instanceof MarkdownView) || !editor.somethingSelected()) return;
        if (this.can("translate")) menu.addItem((i: any) => i.setSection("selection").setTitle("Translate selection").setIcon("lucide-languages").onClick(() => this.translate(view)));
        if (this.can("rewrite")) menu.addItem((i: any) => i.setSection("selection").setTitle("Rewrite selection").setIcon("lucide-wand-sparkles").onClick(() => this.rewrite(view)));
        if (this.can("summarize")) menu.addItem((i: any) => i.setSection("selection").setTitle("Summarize selection").setIcon("lucide-list-collapse").onClick(() => this.summarize(view)));
      }),
    );
    this.addSettingTab(new AiToolsSettingTab(this.app, this));
  }

  override onunload() {
    this.app.workspace.detachLeavesOfType?.(VIEW_TYPE_AI_CHAT);
  }

  async openChat() {
    const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_AI_CHAT, "right", { active: true, reveal: true });
    return leaf.view as AiChatView;
  }

  private toolsEngine = () => this.ai?.engineFor("tools") ?? null;

  summarize(view: MarkdownView) {
    const t = targetOf(view);
    const o = this.options;
    new AiModal(this.app, {
      title: t.isSelection ? "Summary of the selection" : `Summary of ${view.file?.basename ?? "the note"}`,
      autoRun: true,
      engine: this.toolsEngine,
      controls: (el) => {
        new DropdownComponent(el)
          .addOptions({ "key-points": "Key points", tldr: "TL;DR", teaser: "Teaser", headline: "Headline" })
          .setValue(o.summaryType)
          .onChange((v) => {
            o.summaryType = v as SummaryType;
            void this.instance.saveOptions();
          });
        new DropdownComponent(el)
          .addOptions({ short: "Short", medium: "Medium", long: "Long" })
          .setValue(o.summaryLength)
          .onChange((v) => {
            o.summaryLength = v as SummaryLength;
            void this.instance.saveOptions();
          });
      },
      run: async (ctx) => {
        const shape = { "key-points": "a Markdown bullet list of the key points", tldr: "a short TL;DR paragraph", teaser: "an engaging teaser sentence or two", headline: "a single headline" }[o.summaryType];
        const r = await this.generate(ctx, {
          system: `You summarize notes. Reply with ${shape}, ${o.summaryLength} length, in the note's language. Output only the summary.`,
          messages: [{ role: "user", content: t.text }],
          task: { kind: "summarize", type: o.summaryType, length: o.summaryLength },
        });
        return r?.text ?? null;
      },
      actions: [
        {
          label: t.isSelection ? "Insert below selection" : "Insert at top",
          cta: true,
          run: (out) => {
            if (t.isSelection) insertBelow(t, summaryCallout(out));
            else view.editor.replaceRange(`${summaryCallout(out)}\n`, view.editor.offsetToPos(t.from));
          },
        },
      ],
    }).open();
  }

  translate(view: MarkdownView) {
    const t = targetOf(view);
    const o = this.options;
    let target = o.targetLanguage || (navigator.language || "en").split("-")[0]!;
    const modal = new AiModal(this.app, {
      title: t.isSelection ? "Translate selection" : `Translate ${view.file?.basename ?? "note"}`,
      autoRun: false,
      runLabel: "Translate",
      engine: this.toolsEngine,
      controls: (el) => {
        el.createSpan({ cls: "vault-ai-control-label", text: "Into" });
        const d = new DropdownComponent(el).addOptions(TRANSLATE_LANGUAGES).setValue(target in TRANSLATE_LANGUAGES ? target : "en");
        target = d.getValue();
        d.selectEl.addClass("vault-ai-target-language");
        d.onChange((v) => {
          target = v;
          o.targetLanguage = v;
          void this.instance.saveOptions();
        });
      },
      run: async (ctx) => {
        const r = await this.generate(ctx, {
          system: `Translate the user's Markdown text into the language with code "${target}". Keep Markdown syntax, links, code and math unchanged. Output only the translation.`,
          messages: [{ role: "user", content: t.text }],
          task: { kind: "translate", target },
        });
        return r?.text ?? null;
      },
      actions: [
        { label: t.isSelection ? "Replace selection" : "Replace note text", cta: true, run: (out) => replaceRange(t, out) },
        { label: "Insert below", run: (out) => insertBelow(t, out) },
        {
          label: "New note",
          run: async (out) => {
            const file = view.file;
            if (!file) return;
            const folder = file.parent && file.parent.path !== "/" ? `${file.parent.path}/` : "";
            const path = this.app.vault.getAvailablePath(`${folder}${file.basename} (${target})`, "md");
            const all = view.editor.getValue();
            const fm = getFrontMatterInfo(all);
            const note = await this.app.vault.create(path, (t.isSelection ? "" : all.slice(0, fm.contentStart)) + out);
            await this.app.workspace.getLeaf("tab").openFile(note);
          },
        },
      ],
    });
    modal.open();
  }

  rewrite(view: MarkdownView) {
    const t = targetOf(view);
    const o = this.options;
    const modal = new AiModal(this.app, {
      title: "Rewrite selection",
      autoRun: true,
      engine: this.toolsEngine,
      controls: (el) => {
        new DropdownComponent(el)
          .addOptions(REWRITE_LABELS)
          .setValue(o.rewriteMode)
          .onChange((v) => {
            o.rewriteMode = v as RewriteMode;
            void this.instance.saveOptions();
            void modal.run();
          });
      },
      run: async (ctx) => {
        const how = { shorter: "shorter", longer: "longer, with more detail", "more-formal": "more formal", "more-casual": "more casual" }[o.rewriteMode];
        const r = await this.generate(ctx, {
          system: `Rewrite the user's text to be ${how}. Keep its language, meaning and Markdown formatting. Output only the rewritten text.`,
          messages: [{ role: "user", content: t.text }],
          task: { kind: "rewrite", mode: o.rewriteMode },
        });
        return r?.text ?? null;
      },
      actions: [
        { label: "Replace selection", cta: true, run: (out) => replaceRange(t, out) },
        { label: "Insert below", run: (out) => insertBelow(t, out) },
      ],
    });
    modal.open();
  }

  proofread(view: MarkdownView) {
    const t = targetOf(view);
    new AiModal(this.app, {
      title: t.isSelection ? "Proofread selection" : `Proofread ${view.file?.basename ?? "note"}`,
      autoRun: true,
      diffAgainst: t.text,
      engine: this.toolsEngine,
      run: async (ctx) => {
        const r = await this.generate(ctx, {
          system: "Correct spelling, grammar and punctuation in the user's text. Change nothing else: keep wording, language and Markdown. Output only the corrected text.",
          messages: [{ role: "user", content: t.text }],
          task: { kind: "proofread" },
        });
        return r?.text ?? null;
      },
      actions: [{ label: "Accept corrections", cta: true, run: (out) => replaceRange(t, out) }],
    }).open();
  }

  write(view: MarkdownView) {
    let request = "";
    const cursor = view.editor.getCursor();
    const modal = new AiModal(this.app, {
      title: "Write with AI",
      autoRun: false,
      runLabel: "Write",
      engine: this.toolsEngine,
      controls: (el) => {
        const input = new TextAreaComponent(el).setPlaceholder("What should be written here? For example: an introduction to this note");
        input.inputEl.addClass("vault-ai-write-request");
        input.inputEl.rows = 3;
        input.onChange((v) => (request = v));
        input.inputEl.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter" && (evt.metaKey || evt.ctrlKey)) {
            evt.preventDefault();
            void modal.run();
          }
        });
        setTimeout(() => input.inputEl.focus(), 0);
      },
      run: async (ctx) => {
        if (!request.trim()) throw new Error("Describe what to write first.");
        const context = view.editor.getValue();
        const r = await this.generate(ctx, {
          system: `You write Markdown for the user's note. Output only the requested text.\n\nThe note so far:\n${context.slice(0, 6000)}`,
          messages: [{ role: "user", content: request }],
          task: { kind: "write", request, context },
        });
        return r?.text ?? null;
      },
      actions: [{ label: "Insert at cursor", cta: true, run: (out) => view.editor.replaceRange(out, cursor) }],
    });
    modal.open();
  }

  async detect(view: MarkdownView) {
    const file = view.file;
    if (!file) return;
    const t = targetOf(view);
    try {
      const controller = new AbortController();
      const r = await this.generate(
        { signal: controller.signal, onChunk: () => {} },
        {
          system: "Identify the language of the user's text. Reply with only its BCP 47 language code, such as en, fr or zh-Hant.",
          messages: [{ role: "user", content: t.text.slice(0, 2000) }],
          task: { kind: "detect-language" },
        },
      );
      if (!r) return;
      const lang = r.data?.language ?? r.text.trim().split(/\s+/)[0]!.replace(/[^A-Za-z-]/g, "");
      if (!lang) return;
      const confidence = r.data?.confidence;
      let name = lang;
      try {
        name = new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(lang) ?? lang;
      } catch {
        /* not a valid code */
      }
      const frag = createFragment();
      frag.appendText(`Detected ${name} (${lang}${confidence !== undefined ? `, ${Math.round(confidence * 100)}% confidence` : ""}). `);
      const btn = frag.createEl("button", { cls: "mod-cta", text: "Set lang property" });
      btn.addEventListener("click", () => void this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => (fm.lang = lang)));
      new Notice(frag, 10000);
    } catch (e) {
      if (!isAbort(e)) new Notice((e as Error).message);
    }
  }
}

class AiToolsSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: AiToolsPlugin,
  ) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();
    const ai = this.owner.ai;

    const intro = containerEl.createDiv({ cls: "setting-item-description vault-device-intro" });
    const engine = ai?.engineFor("tools") ?? null;
    intro.setText(
      engine
        ? `AI tools use the engine chosen for “Writing tools” in Settings → AI (now: ${describeEngine(engine)}).`
        : "AI tools need an engine. Turn AI on and choose engines in Settings → AI.",
    );
    new Setting(containerEl)
      .setName("Engines, keys and routing")
      .setDesc("Where AI runs, API keys, and what leaves this device.")
      .addButton((b) => b.setButtonText("Open Settings → AI").onClick(() => this.app.setting?.openTabById?.("ai")));

    new Setting(containerEl).setName("Built-in AI in this browser").setHeading();
    const apis: [ApiName, string, Record<string, unknown>?][] = [
      ["Summarizer", "Summarize"],
      ["Translator", "Translate", { sourceLanguage: "en", targetLanguage: o.targetLanguage && o.targetLanguage !== "en" ? o.targetLanguage : "es" }],
      ["LanguageDetector", "Detect language"],
      ["LanguageModel", "Ask about this note; stands in for the three below"],
      ["Rewriter", "Rewrite (trial API)"],
      ["Writer", "Write (trial API)"],
      ["Proofreader", "Proofread (trial API)"],
    ];
    for (const [name, use, opts] of apis) {
      const s = new Setting(containerEl).setName(API_LABELS[name]).setDesc(`${use}. Checking…`);
      s.settingEl.addClass("vault-ai-api-row");
      s.settingEl.setAttr("data-api", name);
      void availability(name, opts).then((state) => {
        const label = {
          available: "Ready.",
          downloadable: "The model needs a one-time download.",
          downloading: "The model is downloading.",
          unavailable: "The browser has this API but cannot run its model on this device.",
          missing: "Not in this browser.",
        }[state];
        s.setDesc(`${use}. ${label}`);
        s.settingEl.setAttr("data-state", state);
        if ((state === "downloadable" || state === "downloading") && ai) {
          s.addButton((b) =>
            b.setButtonText("Download model").onClick(async () => {
              try {
                const obj = await createWithConsent(this.app, name, opts ?? {}, (d) => ai.ensureConsent("tools").then((ok) => ok && askDownloadDirect(this.app, d)));
                obj?.destroy?.();
              } catch (e) {
                if (!isAbort(e)) new Notice((e as Error).message);
              }
              this.display();
            }),
          );
        }
      });
    }

    new Setting(containerEl).setName("Defaults").setHeading();
    new Setting(containerEl)
      .setName("Translate into")
      .addDropdown((d) => d.addOption("", `Browser language (${(navigator.language || "en").split("-")[0]})`).addOptions(TRANSLATE_LANGUAGES).setValue(o.targetLanguage).onChange((v) => ((o.targetLanguage = v), save())));
  }
}

/** The settings tab's explicit "Download model" button is itself the request; confirm with the same dialog. */
async function askDownloadDirect(app: any, d: { what: string; size?: string; from: string }): Promise<boolean> {
  const { askConsent } = await import("../../ai/consent");
  return askConsent(app, { kind: "download", feature: "Writing tools", what: d.what, size: d.size ?? null, from: d.from });
}
