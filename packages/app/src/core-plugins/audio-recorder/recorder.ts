/**
 * Audio recorder: record from the microphone, save `Recording YYYYMMDDHHmmss.<ext>`
 * as an attachment, and embed it in the active note.
 */
import { Plugin } from "../../obsidian/plugin";
import { Notice } from "../../obsidian/ui/notice";
import { moment } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";

const MIME_CANDIDATES: [string, string][] = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/webm", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/ogg;codecs=opus", "ogg"],
  ["audio/ogg", "ogg"],
];

function chooseFormat(): { mimeType: string; ext: string } {
  const MR = (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  for (const [mime, ext] of MIME_CANDIDATES) {
    if (MR && typeof MR.isTypeSupported === "function" && MR.isTypeSupported(mime)) return { mimeType: mime, ext };
  }
  return { mimeType: "", ext: "webm" };
}

function extFromMime(mime: string, fallback: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("mp4") || m.includes("aac") || m.includes("m4a")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  return fallback;
}

export class AudioRecorderPlugin extends Plugin {
  instance!: any;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private ribbonEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private timer: number | null = null;
  private starting = false;

  override async onload() {
    this.addCommand({
      id: "audio-recorder:start",
      name: "Start recording audio",
      icon: "lucide-mic",
      checkCallback: (checking) => {
        if (this.isRecording() || this.starting) return false;
        if (!checking) void this.start();
        return true;
      },
    });
    this.addCommand({
      id: "audio-recorder:stop",
      name: "Stop recording audio",
      icon: "lucide-square",
      checkCallback: (checking) => {
        if (!this.isRecording()) return false;
        if (!checking) this.stop();
        return true;
      },
    });
    this.ribbonEl = this.addRibbonIcon("lucide-mic", "Start/stop recording", () => {
      if (this.isRecording()) this.stop();
      else void this.start();
    });
    this.register(() => this.discard());
  }

  isRecording(): boolean {
    return !!this.recorder && this.recorder.state !== "inactive";
  }

  async start(): Promise<void> {
    if (this.isRecording() || this.starting) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      new Notice("Audio recording is not supported in this browser.");
      return;
    }
    this.starting = true;
    // The note the recording belongs to is the one active when recording starts.
    const sourceFile: TFile | null = this.app.workspace.getActiveFile();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      this.starting = false;
      const name = (e as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "SecurityError") new Notice("Microphone access was denied. Please grant microphone permission to record audio.");
      else if (name === "NotFoundError" || name === "OverconstrainedError") new Notice("No microphone is connected.");
      else new Notice(`Unable to start recording: ${(e as Error)?.message ?? e}`);
      return;
    }
    const format = chooseFormat();
    let recorder: MediaRecorder;
    try {
      recorder = format.mimeType ? new MediaRecorder(this.stream, { mimeType: format.mimeType }) : new MediaRecorder(this.stream);
    } catch (e) {
      this.starting = false;
      this.releaseStream();
      new Notice(`Unable to start recording: ${(e as Error)?.message ?? e}`);
      return;
    }
    this.chunks = [];
    this.recorder = recorder;
    recorder.addEventListener("dataavailable", (evt) => {
      if (evt.data && evt.data.size > 0) this.chunks.push(evt.data);
    });
    recorder.addEventListener("stop", () => {
      // discard() clears `this.recorder` first: the plugin is unloading, so nothing is saved.
      if (this.recorder !== recorder) return;
      const mime = recorder.mimeType || format.mimeType || "audio/webm";
      const blob = new Blob(this.chunks, { type: mime });
      this.chunks = [];
      this.recorder = null;
      this.releaseStream();
      this.updateIndicator();
      void this.save(blob, extFromMime(mime, format.ext), sourceFile);
    });
    recorder.start(1000);
    this.startedAt = Date.now();
    this.starting = false;
    this.updateIndicator();
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
  }

  /** On unload: stop the microphone without saving a half-finished file. */
  private discard() {
    const r = this.recorder;
    this.recorder = null;
    if (r && r.state !== "inactive") {
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
    }
    this.releaseStream();
    this.updateIndicator();
  }

  private releaseStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private updateIndicator() {
    const recording = this.isRecording();
    this.ribbonEl?.toggleClass("is-recording", recording);
    if (recording) {
      if (!this.statusEl) {
        this.statusEl = this.addStatusBarItem();
        this.statusEl.addClass("vault-recording-status", "mod-clickable");
        this.statusEl.setAttr("aria-label", "Stop recording");
        this.statusEl.createSpan({ cls: "vault-recording-dot" });
        this.statusEl.createSpan({ cls: "vault-recording-time", text: "00:00" });
        this.statusEl.addEventListener("click", () => this.stop());
      }
      if (this.timer === null) this.timer = window.setInterval(() => this.tick(), 500);
      this.tick();
    } else {
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
      this.statusEl?.detach();
      this.statusEl = null;
    }
  }

  private tick() {
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    const text = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    this.statusEl?.querySelector(".vault-recording-time")?.setText(text);
  }

  private async save(blob: Blob, ext: string, sourceFile: TFile | null) {
    if (blob.size === 0) {
      new Notice("The recording is empty.");
      return;
    }
    try {
      const name = `Recording ${moment().format("YYYYMMDDHHmmss")}.${ext}`;
      const sourcePath = sourceFile?.path ?? this.app.workspace.getActiveFile()?.path ?? "";
      const path: string = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
      const file: TFile = await this.app.vault.createBinary(path, await blob.arrayBuffer());
      await this.embed(file, sourceFile);
    } catch (e) {
      console.error(e);
      new Notice(`Failed to save the recording: ${(e as Error)?.message ?? e}`);
    }
  }

  private async embed(file: TFile, sourceFile: TFile | null) {
    const info = this.app.workspace.activeEditor;
    const editor = info?.editor;
    const editorFile: TFile | null = info?.file ?? null;
    if (editor && (!sourceFile || editorFile === sourceFile)) {
      const link: string = this.app.fileManager.generateMarkdownLink(file, editorFile?.path ?? "");
      editor.replaceSelection(link);
      return;
    }
    const target = sourceFile && !sourceFile.deleted && sourceFile.extension === "md" ? sourceFile : null;
    if (!target) {
      new Notice(`Recording saved to ${file.path}`);
      return;
    }
    const link: string = this.app.fileManager.generateMarkdownLink(file, target.path);
    await this.app.vault.process(target, (text: string) => {
      const sep = text === "" || text.endsWith("\n") ? "" : "\n";
      return `${text}${sep}${link}\n`;
    });
  }
}
