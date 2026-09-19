/**
 * Transcribe (`transcribe`): recordings and any audio or video in the vault to
 * text through `app.ai.transcribe` (Whisper on this device by default, or the
 * engine the user routed "Transcribe" to).
 *
 * - "Transcribe recording" on an audio/video file (command, file menu) writes a
 *   transcript note; on a recording embedded in a note (the embed's button, its
 *   context menu, the editor menu on its line) it inserts the transcript below
 *   the embed.
 * - Paragraphs are grouped from the engine's segments; each opens with a
 *   timestamp link in the Media plugin's format (`[[rec.webm#t=01:23.47|01:23]]`)
 *   that seeks the player when clicked.
 * - Long recordings are cut into chunks at quiet moments: progress per chunk,
 *   cancel between and within chunks, and a cache per chunk so a re-run is
 *   instant and a cancelled run resumes.
 * - "Summarize transcript" asks `app.ai.generate` for a summary and shows it
 *   before anything is inserted.
 *
 * Off by default. Steps aside while a Whisper transcription community plugin is
 * enabled. Every result names the engine that produced it.
 */
import type { AiService, EngineInfo, TranscriptSegment } from "../../ai/types";
import { Plugin } from "../../obsidian/plugin";
import { Menu } from "../../obsidian/ui/menu";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { FuzzySuggestModal } from "../../obsidian/ui/suggest";
import { setIcon } from "../../obsidian/ui/icons";
import { parseLinktext } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";
import { communityPluginEnabled } from "../smart-paste/network";
import { mediaEmbedHooks } from "../audio-recorder/embeds";
import { chunkAudio, decodeAudio, sha256Hex, sliceChunk } from "./audio";
import { chunkKey, clearCache, getChunk, putChunk, type CachedChunk } from "./cache";
import { engineLabel, groupParagraphs, paragraphsFromMarkdown, timeFragment, transcriptForPrompt, transcriptMarkdown, type Paragraph } from "./format";
import { MEDIA_EXTENSIONS, installSeekFallback } from "./seek";
import { formatDuration } from "../media/timefrag";

export interface TranscribeOptions {
  /** BCP-47 language hint; "" lets the engine detect it. */
  language: string;
  /** Recordings embedded in a note: transcript below the embed, or a separate note. */
  embedOutput: "below" | "note";
  /** Folder for transcript notes; "" = next to the recording. */
  folder: string;
  /** Offer a summary as soon as a transcript is written. */
  summarize: boolean;
  /** Chunk length for long recordings, in minutes. */
  chunkMinutes: number;
}

export const DEFAULT_TRANSCRIBE_OPTIONS: TranscribeOptions = { language: "", embedOutput: "below", folder: "", summarize: false, chunkMinutes: 5 };

/** Community plugins that transcribe recordings; Transcribe steps aside while one is enabled. */
const REPLACED_PLUGINS = ["whisper", "transcription", "scribe"];

export const LANGUAGES: Record<string, string> = {
  "": "Detect automatically",
  en: "English",
  zh: "Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  ja: "Japanese",
  ko: "Korean",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  ru: "Russian",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  ms: "Malay",
  th: "Thai",
  vi: "Vietnamese",
  tr: "Turkish",
  pl: "Polish",
  sv: "Swedish",
  uk: "Ukrainian",
};

type Target = { kind: "note" } | { kind: "below"; note: TFile; linktext: string; line?: number };

interface Job {
  file: TFile;
  controller: AbortController;
  notice: Notice;
  setProgress(fraction: number, status: string): void;
}

function isAbort(e: unknown): boolean {
  return (e as { name?: string })?.name === "AbortError";
}

export class TranscribePlugin extends Plugin {
  instance!: any;
  jobs = new Map<string, Job>();

  get options(): TranscribeOptions {
    return this.instance.options as TranscribeOptions;
  }

  get ai(): AiService | null {
    return ((this.app as any).ai as AiService | undefined) ?? null;
  }

  get standingAside(): boolean {
    return REPLACED_PLUGINS.some((id) => communityPluginEnabled(this.app, id));
  }

  override async onload() {
    this.addCommand({
      id: "transcribe:transcribe-recording",
      name: "Transcribe recording",
      icon: "lucide-captions",
      checkCallback: (checking) => {
        if (this.standingAside) return false;
        if (!checking) this.transcribeFromContext();
        return true;
      },
    });
    this.addCommand({
      id: "transcribe:summarize-transcript",
      name: "Summarize transcript",
      icon: "lucide-list",
      checkCallback: (checking) => {
        if (this.standingAside) return false;
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.summarizeNote(file);
        return true;
      },
    });
    this.addCommand({
      id: "transcribe:cancel",
      name: "Cancel transcription",
      icon: "lucide-square",
      checkCallback: (checking) => {
        if (!this.jobs.size) return false;
        if (!checking) for (const job of this.jobs.values()) job.controller.abort();
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: any, file: TFile) => {
        if (this.standingAside || !file || !("extension" in file) || !MEDIA_EXTENSIONS.includes(file.extension.toLowerCase())) return;
        menu.addItem((i: any) =>
          i
            .setSection("action")
            .setTitle("Transcribe recording")
            .setIcon("lucide-captions")
            .onClick(() => void this.transcribe(file, { kind: "note" })),
        );
      }),
    );
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: any, editor: any, view: any) => {
        if (this.standingAside || !view?.file) return;
        const embed = this.embedOnLine(editor.getLine(editor.getCursor().line), view.file.path);
        if (!embed) return;
        const line = editor.getCursor().line;
        menu.addItem((i: any) =>
          i
            .setSection("action")
            .setTitle("Transcribe recording")
            .setIcon("lucide-captions")
            .onClick(() => void this.transcribe(embed.file, this.embedTarget(view.file, embed.linktext, line))),
        );
      }),
    );

    // Recording embeds: a button, and a context menu.
    const hook = (el: HTMLElement, file: TFile, ctx: { sourcePath: string }) => this.decorateEmbed(el, file, ctx.sourcePath);
    mediaEmbedHooks.push(hook);
    this.register(() => mediaEmbedHooks.remove(hook));
    this.registerDomEvent(document, "contextmenu", (evt: MouseEvent) => {
      if (this.standingAside) return;
      const embed = (evt.target as HTMLElement | null)?.closest?.<HTMLElement>(".internal-embed.audio-embed, .internal-embed.video-embed");
      if (!embed) return;
      const info = this.embedInfo(embed);
      if (!info) return;
      evt.preventDefault();
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Transcribe recording").setIcon("lucide-captions").onClick(() => void this.transcribe(info.file, this.embedTarget(info.note, info.linktext))));
      menu.showAtMouseEvent(evt);
    });

    installSeekFallback(this);
    this.register(() => {
      for (const job of this.jobs.values()) {
        job.controller.abort();
        job.notice.hide();
      }
    });
    this.addSettingTab(new TranscribeSettingTab(this.app, this));
  }

  // ---- where a transcription starts ------------------------------------------------

  private embedTarget(note: TFile, linktext: string, line?: number): Target {
    return this.options.embedOutput === "note" ? { kind: "note" } : { kind: "below", note, linktext, line };
  }

  /** `![[rec.webm]]` / `![](rec.webm)` on a line, resolved to a media file. */
  embedOnLine(text: string, sourcePath: string): { file: TFile; linktext: string } | null {
    const re = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
    for (const m of text.matchAll(re)) {
      const raw = m[1] ?? decodeURI(m[2]!.replace(/^<|>$/g, ""));
      const { path } = parseLinktext(raw);
      const file: TFile | null = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
      if (file && MEDIA_EXTENSIONS.includes(file.extension.toLowerCase())) return { file, linktext: raw };
    }
    return null;
  }

  private embedInfo(embed: HTMLElement): { file: TFile; note: TFile; linktext: string } | null {
    const linktext = embed.getAttr("src") ?? "";
    const leafEl = embed.closest(".workspace-leaf-content");
    const leaf = (this.app.workspace.getLeavesOfType("markdown") as any[]).find((l) => l.view?.containerEl === leafEl);
    const note: TFile | null = leaf?.view?.file ?? this.app.workspace.getActiveFile();
    if (!note || note.extension !== "md") return null;
    const file: TFile | null = this.app.metadataCache.getFirstLinkpathDest(parseLinktext(linktext).path, note.path);
    if (!file || !MEDIA_EXTENSIONS.includes(file.extension.toLowerCase())) return null;
    return { file, note, linktext };
  }

  private decorateEmbed(el: HTMLElement, file: TFile, sourcePath: string) {
    if (this.standingAside || el.querySelector(":scope > .vault-transcribe-embed-button")) return;
    const note = this.app.vault.getFileByPath(sourcePath);
    if (!note || note.extension !== "md") return;
    el.addClass("vault-transcribable");
    const btn = el.createEl("button", { cls: "clickable-icon vault-transcribe-embed-button", attr: { "aria-label": "Transcribe recording", type: "button" } });
    setIcon(btn, "lucide-captions");
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const linktext = el.closest(".internal-embed")?.getAttr("src") ?? el.getAttr("src") ?? file.path;
      void this.transcribe(file, this.embedTarget(note, linktext));
    });
  }

  private transcribeFromContext() {
    const active = this.app.workspace.getActiveFile();
    if (active && MEDIA_EXTENSIONS.includes(active.extension.toLowerCase())) {
      void this.transcribe(active, { kind: "note" });
      return;
    }
    const info = this.app.workspace.activeEditor;
    if (info?.editor && info.file) {
      const line = info.editor.getCursor().line;
      const here = this.embedOnLine(info.editor.getLine(line), info.file.path);
      if (here) {
        void this.transcribe(here.file, this.embedTarget(info.file, here.linktext, line));
        return;
      }
      const lines: string[] = info.editor.getValue().split("\n");
      const embeds = lines.map((text, i) => ({ i, e: this.embedOnLine(text, info.file.path) })).filter((x) => x.e);
      if (embeds.length === 1) {
        const { i, e } = embeds[0]!;
        void this.transcribe(e!.file, this.embedTarget(info.file, e!.linktext, i));
        return;
      }
    }
    new RecordingPicker(this.app, (file) => void this.transcribe(file, { kind: "note" })).open();
  }

  // ---- AI availability ----------------------------------------------------------------

  /** The service, once AI is on for Transcribe and the user agreed to what it needs; otherwise explains and returns null. */
  private async readyAi(capability: "transcribe" | "generate"): Promise<AiService | null> {
    const ai = this.ai;
    if (!ai || !ai.isAvailable("transcribe", capability)) {
      const frag = createFragment((f) => {
        f.appendText(
          !ai
            ? "Transcribe needs AI. Turn AI on in Settings → AI, then choose an engine for Transcribe."
            : capability === "transcribe"
              ? "No engine can transcribe right now. Choose one for Transcribe in Settings → AI."
              : "No engine can write a summary right now. Choose one for Transcribe in Settings → AI.",
        );
        if (ai) {
          f.createEl("br");
          const b = f.createEl("button", { cls: "mod-cta vault-transcribe-open-settings", text: "Open AI settings" });
          b.addEventListener("click", () => {
            (this.app as any).setting?.open?.();
            (this.app as any).setting?.openTabById?.("ai");
          });
        }
      });
      new Notice(frag, 8000);
      return null;
    }
    if (!(await ai.ensureConsent("transcribe", capability))) return null;
    return ai;
  }

  // ---- transcription --------------------------------------------------------------------

  async transcribe(file: TFile, target: Target): Promise<TFile | null> {
    if (this.jobs.has(file.path)) {
      new Notice(`“${file.name}” is already being transcribed.`);
      return null;
    }
    const ai = await this.readyAi("transcribe");
    if (!ai) return null;
    const engine: EngineInfo = ai.engineFor("transcribe", "transcribe") ?? { provider: "unknown", model: "", location: "device", leavesDevice: false };
    const job = this.startJob(file, engine);
    try {
      const result = await this.run(ai, file, engine, job);
      const paragraphs = groupParagraphs(result.segments);
      if (!paragraphs.length) {
        new Notice(`No speech was found in “${file.name}”.`);
        return null;
      }
      const written = target.kind === "note" ? await this.writeNote(file, paragraphs, result) : await this.insertBelow(file, target, paragraphs);
      const label = engineLabel(result.engine);
      new Notice(`Transcribed “${file.name}”${result.cached ? " (from cache)" : ""} · ${label}`);
      if (this.options.summarize && written) void this.summarizeNote(written, paragraphs, file);
      return written;
    } catch (e) {
      if (isAbort(e) || job.controller.signal.aborted) new Notice(`Transcription of “${file.name}” cancelled. Finished parts are kept and reused next time.`);
      else new Notice(`Could not transcribe “${file.name}”: ${(e as Error)?.message ?? e}`, 10000);
      return null;
    } finally {
      this.jobs.delete(file.path);
      job.notice.hide();
    }
  }

  private startJob(file: TFile, engine: EngineInfo): Job {
    const controller = new AbortController();
    let bar!: HTMLProgressElement;
    let status!: HTMLElement;
    const frag = createFragment((f) => {
      const box = f.createDiv({ cls: "vault-transcribe-progress" });
      box.createDiv({ cls: "vault-transcribe-title", text: `Transcribing “${file.name}”` });
      box.createDiv({ cls: "vault-transcribe-engine", text: engineLabel(engine) });
      bar = box.createEl("progress", { cls: "vault-transcribe-bar", attr: { max: "1", value: "0" } });
      const row = box.createDiv({ cls: "vault-transcribe-row" });
      status = row.createSpan({ cls: "vault-transcribe-status", text: "Reading the recording…" });
      const cancel = row.createEl("button", { cls: "vault-transcribe-cancel", text: "Cancel" });
      cancel.addEventListener("click", (e) => {
        e.stopPropagation();
        controller.abort();
        status.setText("Cancelling…");
      });
      box.addEventListener("click", (e) => e.stopPropagation());
    });
    const notice = new Notice(frag, 0);
    notice.containerEl.addClass("vault-transcribe-notice");
    const job: Job = {
      file,
      controller,
      notice,
      setProgress: (fraction, text) => {
        bar.value = Math.max(0, Math.min(1, fraction));
        status.setText(text);
      },
    };
    this.jobs.set(file.path, job);
    return job;
  }

  private async run(ai: AiService, file: TFile, engine: EngineInfo, job: Job): Promise<{ segments: TranscriptSegment[]; language?: string; engine: EngineInfo; cached: boolean }> {
    const signal = job.controller.signal;
    const data = await this.app.vault.readBinary(file);
    const hash = await sha256Hex(data);
    const language = this.options.language;
    const wholeKey = chunkKey(hash, engine, language, "whole");
    const whole = await getChunk(wholeKey);
    if (whole) {
      job.setProgress(1, "Done");
      return { segments: whole.segments, language: whole.language, engine: whole.engine, cached: true };
    }
    signal.throwIfAborted();
    job.setProgress(0, "Decoding audio…");
    const decoded = await decodeAudio(data);
    signal.throwIfAborted();
    const chunkSeconds = Math.max(0.1, Number(this.options.chunkMinutes) || 5) * 60;
    const chunks = decoded ? chunkAudio(decoded, chunkSeconds) : [{ start: 0, end: 0 }];
    const total = decoded?.duration ?? 0;
    const segments: TranscriptSegment[] = [];
    let usedEngine = engine;
    let detected: string | undefined;
    let allCached = true;
    for (let i = 0; i < chunks.length; i++) {
      signal.throwIfAborted();
      const chunk = chunks[i]!;
      const span = chunks.length > 1 ? ` · ${formatDuration(chunk.start)}–${formatDuration(chunk.end)} of ${formatDuration(total)}` : "";
      const label = chunks.length > 1 ? `Part ${i + 1} of ${chunks.length}${span}` : "Transcribing…";
      const key = chunkKey(hash, engine, language, chunk);
      let cached: CachedChunk | undefined = await getChunk(key);
      if (!cached) {
        allCached = false;
        job.setProgress(i / chunks.length, label);
        const audio = decoded ? sliceChunk(decoded, chunk) : new Blob([data], { type: mimeFor(file.extension) });
        const r = await ai.transcribe({
          audio,
          language: language || undefined,
          signal,
          onProgress: (done, all) => {
            if (all > 0) job.setProgress((i + Math.min(1, done / all)) / chunks.length, `${label} · ${Math.round(((i + Math.min(1, done / all)) / chunks.length) * 100)}%`);
          },
        });
        signal.throwIfAborted();
        cached = {
          segments: r.segments.map((s) => ({ start: s.start + chunk.start, end: s.end + chunk.start, text: s.text })),
          language: r.language,
          engine: r.engine,
          at: Date.now(),
        };
        if (!r.segments.length && r.text.trim()) cached.segments = [{ start: chunk.start, end: chunk.end || chunk.start, text: r.text }];
        await putChunk(key, cached);
      }
      usedEngine = cached.engine;
      detected ??= cached.language;
      segments.push(...cached.segments);
      job.setProgress((i + 1) / chunks.length, label);
    }
    await putChunk(wholeKey, { segments, language: detected, engine: usedEngine, at: Date.now() });
    return { segments, language: detected, engine: usedEngine, cached: allCached };
  }

  // ---- output --------------------------------------------------------------------------

  private linkMaker(recording: TFile, notePath: string) {
    return (hash: string, text: string) => this.app.fileManager.generateMarkdownLink(recording, notePath, hash, text).replace(/^!/, "");
  }

  private async writeNote(recording: TFile, paragraphs: Paragraph[], result: { language?: string; engine: EngineInfo }): Promise<TFile> {
    const folder = (this.options.folder.trim() || recording.parent?.path || "").replace(/^\/+|\/+$/g, "");
    if (folder && folder !== "/" && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
    const base = `${folder && folder !== "/" ? folder + "/" : ""}${recording.basename} (transcript)`;
    const path = this.app.vault.getAbstractFileByPath(`${base}.md`) ? this.app.vault.getAvailablePath(base, "md") : `${base}.md`;
    const q = (s: string) => JSON.stringify(s);
    const fm = [
      "---",
      `recording: ${q(this.app.fileManager.generateMarkdownLink(recording, path).replace(/^!/, ""))}`,
      ...(result.language ? [`language: ${q(result.language)}`] : []),
      `transcribed-with: ${q(engineLabel(result.engine))}`,
      "---",
    ].join("\n");
    const body = `${fm}\n${this.app.fileManager.generateMarkdownLink(recording, path)}\n\n## Transcript\n\n${transcriptMarkdown(paragraphs, this.linkMaker(recording, path))}\n`;
    const note = await this.app.vault.create(path, body);
    await this.app.workspace.getLeaf("tab").openFile(note, { active: true });
    return note;
  }

  private async insertBelow(recording: TFile, target: Extract<Target, { kind: "below" }>, paragraphs: Paragraph[]): Promise<TFile> {
    const note = target.note;
    const md = transcriptMarkdown(paragraphs, this.linkMaker(recording, note.path));
    const findLine = (lines: string[]) => {
      if (target.line !== undefined && this.embedOnLine(lines[target.line] ?? "", note.path)?.file === recording) return target.line;
      return lines.findIndex((l) => this.embedOnLine(l, note.path)?.file === recording);
    };
    const editor = this.editorFor(note);
    if (editor) {
      const lines: string[] = editor.getValue().split("\n");
      const line = findLine(lines);
      const at = line < 0 ? { line: lines.length - 1, ch: lines[lines.length - 1]!.length } : { line, ch: lines[line]!.length };
      // One blank line on each side, reusing a blank line that is already there.
      const blankAfter = line >= 0 && line + 1 < lines.length && lines[line + 1]!.trim() === "" && line + 2 < lines.length;
      editor.replaceRange(`\n\n${md}${blankAfter ? "" : "\n"}`, at);
      return note;
    }
    await this.app.vault.process(note, (text: string) => {
      const lines = text.split("\n");
      const line = findLine(lines);
      if (line < 0) return `${text}${text.endsWith("\n") ? "" : "\n"}\n${md}\n`;
      const blankAfter = line + 1 < lines.length && lines[line + 1]!.trim() === "" && line + 2 < lines.length;
      lines.splice(line + 1, 0, "", md, ...(blankAfter ? [] : [""]));
      return lines.join("\n");
    });
    return note;
  }

  private editorFor(note: TFile): any {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown") as any[]) if (leaf.view?.file === note && leaf.view.editor) return leaf.view.editor;
    return null;
  }

  // ---- summary ---------------------------------------------------------------------------

  async summarizeNote(note: TFile, known?: Paragraph[], recording?: TFile): Promise<void> {
    const text = await this.app.vault.read(note);
    const paragraphs = known ?? paragraphsFromMarkdown(text);
    if (!paragraphs.length) {
      new Notice("This note has no transcript to summarize.");
      return;
    }
    const ai = await this.readyAi("generate");
    if (!ai) return;
    const engine = ai.engineFor("transcribe", "generate");
    const controller = new AbortController();
    const notice = new Notice(
      createFragment((f) => {
        const box = f.createDiv({ cls: "vault-transcribe-progress" });
        box.createDiv({ cls: "vault-transcribe-title", text: "Summarizing transcript…" });
        box.createDiv({ cls: "vault-transcribe-engine", text: engineLabel(engine) });
        const row = box.createDiv({ cls: "vault-transcribe-row" });
        row.createSpan({ cls: "vault-transcribe-status" });
        row.createEl("button", { cls: "vault-transcribe-cancel", text: "Cancel" }).addEventListener("click", (e) => {
          e.stopPropagation();
          controller.abort();
        });
      }),
      0,
    );
    try {
      const { text: summary, engine: used } = await summarize(ai, paragraphs, engine, controller.signal);
      notice.hide();
      recording ??= this.recordingOf(text, note.path) ?? undefined;
      const linked = recording ? this.linkTimes(summary, recording, note.path) : summary;
      new SummaryModal(this.app, linked, engineLabel(used), (final) => void this.insertSummary(note, final)).open();
    } catch (e) {
      notice.hide();
      if (!isAbort(e) && !controller.signal.aborted) new Notice(`Could not summarize: ${(e as Error)?.message ?? e}`, 10000);
    }
  }

  private recordingOf(text: string, notePath: string): TFile | null {
    const m = /\[\[([^\]|#]+)#t=|\]\(([^)#\s]+)#t=/.exec(text);
    const path = m ? (m[1] ?? decodeURI(m[2]!)) : null;
    return path ? this.app.metadataCache.getFirstLinkpathDest(path, notePath) : null;
  }

  /** `[01:23]` in the summary → a timestamp link that seeks. */
  linkTimes(summary: string, recording: TFile, notePath: string): string {
    const link = this.linkMaker(recording, notePath);
    return summary.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\](?!\()/g, (whole, t: string) => {
      const secs = t.split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
      return Number.isFinite(secs) ? link(`#${timeFragment(secs)}`, formatDuration(secs)) : whole;
    });
  }

  private async insertSummary(note: TFile, summary: string) {
    const place = (text: string): { offset: number; insert: string } => {
      const heading = /^## Transcript\s*$/m.exec(text);
      if (heading) return { offset: heading.index, insert: `## Summary\n\n${summary.trim()}\n\n` };
      const first = /^(?:\[\[[^\]]+#t=[^\]]*\]\]|\[[^\]]*\]\([^)]+#t=[^)]*\))\s/m.exec(text);
      const callout = `> [!summary] Summary\n${summary.trim().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
      return first ? { offset: first.index, insert: callout } : { offset: text.length, insert: `\n${callout}` };
    };
    const editor = this.editorFor(note);
    if (editor) {
      const { offset, insert } = place(editor.getValue());
      editor.replaceRange(insert, editor.offsetToPos(offset));
    } else {
      await this.app.vault.process(note, (text: string) => {
        const { offset, insert } = place(text);
        return text.slice(0, offset) + insert + text.slice(offset);
      });
    }
    new Notice("Summary added.");
  }
}

function mimeFor(ext: string): string {
  const e = ext.toLowerCase();
  if (["mp4", "m4v", "mov"].includes(e)) return "video/mp4";
  if (e === "m4a" || e === "aac") return "audio/mp4";
  if (e === "mp3") return "audio/mpeg";
  if (e === "wav") return "audio/wav";
  if (e === "flac") return "audio/flac";
  if (["ogg", "oga", "opus"].includes(e)) return "audio/ogg";
  if (e === "mkv") return "video/x-matroska";
  return `audio/${e}`;
}

const SUMMARY_SYSTEM =
  "You summarize transcripts of recordings. Write in the language of the transcript. Answer in Markdown only: one or two sentences on what the recording is about, then the key points as a bulleted list, then action items or decisions as a bulleted list if there are any. When a point comes from a particular moment, end it with that moment's time in square brackets exactly as it appears in the transcript, e.g. [04:12]. Do not invent anything that is not in the transcript.";

/** Characters of transcript one request may carry, by where the engine runs. */
function budgetFor(engine: EngineInfo | null): number {
  if (!engine || engine.location === "device") return 12_000;
  if (engine.location === "local-server") return 32_000;
  return 150_000;
}

/** One request when the transcript fits the engine; otherwise summaries of parts, then a summary of those. */
export async function summarize(ai: AiService, paragraphs: Paragraph[], engine: EngineInfo | null, signal: AbortSignal): Promise<{ text: string; engine: EngineInfo }> {
  const budget = budgetFor(engine);
  const full = transcriptForPrompt(paragraphs);
  if (full.length <= budget) {
    const r = await ai.generate({ feature: "transcribe", system: SUMMARY_SYSTEM, messages: [{ role: "user", content: `Transcript:\n\n${full}` }], signal, maxTokens: 800 });
    return { text: r.text.trim(), engine: r.engine };
  }
  const parts: Paragraph[][] = [[]];
  let size = 0;
  for (const p of paragraphs) {
    const len = p.text.length + 12;
    if (size + len > budget && parts[parts.length - 1]!.length) {
      parts.push([]);
      size = 0;
    }
    parts[parts.length - 1]!.push(p);
    size += len;
  }
  const notes: string[] = [];
  let used: EngineInfo | null = null;
  for (const part of parts) {
    const r = await ai.generate({
      feature: "transcribe",
      system: "Write concise notes on this part of a recording's transcript: the points made, with each point's time in square brackets as it appears, e.g. [04:12]. Markdown bullets only.",
      messages: [{ role: "user", content: transcriptForPrompt(part) }],
      signal,
      maxTokens: 600,
    });
    notes.push(r.text.trim());
    used = r.engine;
  }
  const r = await ai.generate({ feature: "transcribe", system: SUMMARY_SYSTEM, messages: [{ role: "user", content: `Notes on the recording, in order:\n\n${notes.join("\n\n")}` }], signal, maxTokens: 800 });
  return { text: r.text.trim(), engine: r.engine ?? used! };
}

class RecordingPicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: any,
    private onPick: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Choose a recording to transcribe…");
  }
  getItems(): TFile[] {
    return (this.app.vault.getFiles() as TFile[]).filter((f) => MEDIA_EXTENSIONS.includes(f.extension.toLowerCase())).sort((a, b) => b.stat.mtime - a.stat.mtime);
  }
  getItemText(item: TFile): string {
    return item.path;
  }
  onChooseItem(item: TFile): void {
    this.onPick(item);
  }
}

class SummaryModal extends Modal {
  constructor(
    app: any,
    private summary: string,
    private engine: string,
    private onInsert: (text: string) => void,
  ) {
    super(app);
  }
  override onOpen() {
    this.setTitle("Summary");
    this.modalEl.addClass("vault-transcribe-summary-modal");
    this.contentEl.createDiv({ cls: "vault-transcribe-engine", text: this.engine });
    const area = this.contentEl.createEl("textarea", { cls: "vault-transcribe-summary", attr: { rows: "14", spellcheck: "true" } });
    area.value = this.summary;
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Insert")
          .setCta()
          .onClick(() => {
            this.close();
            this.onInsert(area.value);
          }),
      );
  }
  override onClose() {
    this.contentEl.empty();
  }
}

class TranscribeSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: TranscribePlugin,
  ) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();
    if (this.owner.standingAside) {
      containerEl.createDiv({ cls: "setting-item-description vault-standing-aside", text: "A transcription community plugin is enabled, so Transcribe's commands are hidden while it is on." });
    }
    const ai = this.owner.ai;
    const engine = ai?.engineFor("transcribe", "transcribe") ?? null;
    new Setting(containerEl)
      .setName("Engine")
      .setDesc(
        !ai
          ? "AI is not set up yet. Turn it on in Settings → AI and choose an engine for Transcribe."
          : engine
            ? `${engineLabel(engine)}. Change it in Settings → AI.`
            : "No engine can transcribe. Choose one for Transcribe in Settings → AI.",
      )
      .addButton((b) =>
        b.setButtonText("Open AI settings").onClick(() => {
          (this.app as any).setting?.openTabById?.("ai");
        }),
      );
    new Setting(containerEl)
      .setName("Language")
      .setDesc("The language spoken in your recordings. Detection guesses per recording; naming the language is faster and avoids mistakes in quiet or mixed passages.")
      .addDropdown((d) => d.addOptions(LANGUAGES).setValue(o.language).onChange((v) => ((o.language = v), save())));
    new Setting(containerEl)
      .setName("Recordings embedded in a note")
      .setDesc("Where the transcript of an embedded recording goes.")
      .addDropdown((d) =>
        d
          .addOptions({ below: "Below the recording, in the same note", note: "In a separate transcript note" })
          .setValue(o.embedOutput)
          .onChange((v) => ((o.embedOutput = v as TranscribeOptions["embedOutput"]), save())),
      );
    new Setting(containerEl)
      .setName("Transcript folder")
      .setDesc("Where transcript notes are created. Leave empty to put each next to its recording.")
      .addText((t) => t.setPlaceholder("Next to the recording").setValue(o.folder).onChange((v) => ((o.folder = v.trim()), save())));
    new Setting(containerEl)
      .setName("Offer a summary")
      .setDesc("After transcribing, write a summary with the same AI settings and show it before inserting.")
      .addToggle((t) => t.setValue(o.summarize).onChange((v) => ((o.summarize = v), save())));
    new Setting(containerEl)
      .setName("Part length")
      .setDesc("Long recordings are transcribed in parts of about this many minutes, cut at pauses. Finished parts are kept if you cancel.")
      .addText((t) => t.setValue(String(o.chunkMinutes)).onChange((v) => ((o.chunkMinutes = Math.max(1, Math.min(30, Number(v) || 5))), save())));
    new Setting(containerEl)
      .setName("Saved transcripts")
      .setDesc("Transcripts are kept on this device so running them again is instant.")
      .addButton((b) =>
        b.setButtonText("Clear").onClick(async () => {
          await clearCache();
          new Notice("Saved transcripts cleared.");
        }),
      );
  }
}
