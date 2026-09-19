/**
 * Core plugin Voice (`voice`): dictation into the editor and reading notes
 * aloud, with the browser's Web Speech API.
 *
 * Dictation (`voice:dictate`) prefers on-device recognition
 * (`processLocally`, Chrome 139+), downloading the language pack after the
 * user agrees. Server-based recognition sends audio to the browser vendor, so
 * it is off until the user turns it on. Interim words show as a ghost at the
 * cursor; final words are inserted with spoken punctuation applied.
 *
 * Read aloud (`voice:read-note`, `voice:read-selection`, `voice:pause-resume`,
 * `voice:stop`) speaks one sentence at a time with `speechSynthesis`,
 * highlighting it in the editor, skipping frontmatter, code and comments.
 *
 * Transcribing existing recordings is not built in: there is no on-device
 * speech-to-text for audio files in the browser without shipping a Whisper
 * model, which this plugin does not do.
 */
import { EditorView } from "@codemirror/view";
import { MarkdownView } from "../../obsidian/markdown/markdown-view";
import { Plugin } from "../../obsidian/plugin";
import { setIcon } from "../../obsidian/ui/icons";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { askToDownload } from "../ai-tools/ui";
import { setInterim, setSpeaking, voiceEditorExtension } from "./editor-marks";
import { joinDictation, type SpeechSegment, speechSegments } from "./text";

export interface VoiceOptions {
  dictationLanguage: string;
  allowServerRecognition: boolean;
  spokenPunctuation: boolean;
  voiceURI: string;
  rate: number;
  pitch: number;
  highlightSentence: boolean;
}

type RecognitionCtor = {
  new (): any;
  available?: (opts: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (opts: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
  availableOnDevice?: (lang: string) => Promise<string>;
  installOnDevice?: (lang: string) => Promise<boolean>;
};

export function recognitionCtor(): RecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function hasSpeechSynthesis(): boolean {
  return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

function supportsOnDevice(Ctor: RecognitionCtor): boolean {
  return typeof Ctor.available === "function" || typeof Ctor.availableOnDevice === "function";
}

async function onDeviceStatus(Ctor: RecognitionCtor, lang: string): Promise<string> {
  if (typeof Ctor.available === "function") return Ctor.available({ langs: [lang], processLocally: true });
  if (typeof Ctor.availableOnDevice === "function") return Ctor.availableOnDevice(lang);
  return "unavailable";
}

async function installOnDevice(Ctor: RecognitionCtor, lang: string): Promise<boolean> {
  if (typeof Ctor.install === "function") return Ctor.install({ langs: [lang], processLocally: true });
  if (typeof Ctor.installOnDevice === "function") return Ctor.installOnDevice(lang);
  return false;
}

const LANGUAGES: Record<string, string> = {
  "": "Browser language",
  "en-US": "English (US)", "en-GB": "English (UK)", "en-AU": "English (Australia)", "en-IN": "English (India)", "de-DE": "German", "fr-FR": "French", "es-ES": "Spanish (Spain)", "es-MX": "Spanish (Mexico)",
  "it-IT": "Italian", "pt-BR": "Portuguese (Brazil)", "pt-PT": "Portuguese (Portugal)", "nl-NL": "Dutch", "sv-SE": "Swedish", "da-DK": "Danish", "nb-NO": "Norwegian", "fi-FI": "Finnish", "pl-PL": "Polish",
  "cs-CZ": "Czech", "ru-RU": "Russian", "uk-UA": "Ukrainian", "tr-TR": "Turkish", "ar-SA": "Arabic", "he-IL": "Hebrew", "hi-IN": "Hindi", "th-TH": "Thai", "vi-VN": "Vietnamese", "id-ID": "Indonesian",
  "ms-MY": "Malay", "ja-JP": "Japanese", "ko-KR": "Korean", "zh-CN": "Chinese (Mandarin, simplified)", "zh-TW": "Chinese (Taiwan)",
};

export class VoicePlugin extends Plugin {
  instance!: any;
  // dictation
  private recognition: any = null;
  private dictating = false;
  private dictationEditor: any = null;
  private dictationStatusEl: HTMLElement | null = null;
  // read aloud
  private segments: SpeechSegment[] = [];
  private segmentIndex = 0;
  private readingView: MarkdownView | null = null;
  private reading = false;
  private paused = false;
  private readStatusEl: HTMLElement | null = null;
  private readToken = 0;

  get options(): VoiceOptions {
    return this.instance.options as VoiceOptions;
  }

  override async onload() {
    this.registerEditorExtension(voiceEditorExtension);
    const activeEditorView = (): MarkdownView | null => this.app.workspace.getActiveViewOfType(MarkdownView);

    this.addCommand({
      id: "voice:dictate",
      name: "Start or stop dictation",
      icon: "lucide-mic",
      checkCallback: (checking) => {
        if (!recognitionCtor()) return false;
        const view = activeEditorView();
        if (!this.dictating && (!view || view.getMode() === "preview")) return false;
        if (!checking) {
          if (this.dictating) this.stopDictation();
          else void this.startDictation(view!);
        }
        return true;
      },
    });
    this.addCommand({
      id: "voice:read-note",
      name: "Read note aloud",
      icon: "lucide-volume-2",
      checkCallback: (checking) => {
        if (!hasSpeechSynthesis()) return false;
        const view = activeEditorView();
        if (!view?.file) return false;
        if (!checking) void this.readNote(view, false);
        return true;
      },
    });
    this.addCommand({
      id: "voice:read-selection",
      name: "Read selection aloud",
      icon: "lucide-text-select",
      checkCallback: (checking) => {
        if (!hasSpeechSynthesis()) return false;
        const view = activeEditorView();
        if (!view?.editor?.somethingSelected()) return false;
        if (!checking) void this.readNote(view, true);
        return true;
      },
    });
    this.addCommand({
      id: "voice:pause-resume",
      name: "Pause or resume reading aloud",
      icon: "lucide-pause",
      checkCallback: (checking) => {
        if (!this.reading) return false;
        if (!checking) this.togglePause();
        return true;
      },
    });
    this.addCommand({
      id: "voice:stop",
      name: "Stop reading aloud",
      icon: "lucide-square",
      checkCallback: (checking) => {
        if (!this.reading) return false;
        if (!checking) this.stopReading();
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: any, editor: any, view: any) => {
        if (!hasSpeechSynthesis() || !(view instanceof MarkdownView)) return;
        if (editor.somethingSelected()) menu.addItem((i: any) => i.setSection("selection").setTitle("Read selection aloud").setIcon("lucide-volume-2").onClick(() => void this.readNote(view, true)));
      }),
    );
    // Chrome loads the voice list asynchronously.
    if (hasSpeechSynthesis()) this.registerDomEvent(speechSynthesis as unknown as HTMLElement, "voiceschanged" as keyof HTMLElementEventMap, () => this.app.setting?.activeTab?.id === "voice" && this.app.setting.activeTab.display?.());

    this.addSettingTab(new VoiceSettingTab(this.app, this));
  }

  override onunload() {
    this.stopDictation();
    this.stopReading();
  }

  // ---- dictation --------------------------------------------------------------------

  isDictating(): boolean {
    return this.dictating;
  }

  dictationLang(): string {
    return this.options.dictationLanguage || navigator.language || "en-US";
  }

  async startDictation(view: MarkdownView): Promise<void> {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      new Notice("This browser has no speech recognition (Web Speech API). Chrome, Edge and Safari have it; Firefox does not.", 8000);
      return;
    }
    const lang = this.dictationLang();
    let local = false;
    if (supportsOnDevice(Ctor)) {
      let status = "unavailable";
      try {
        status = await onDeviceStatus(Ctor, lang);
      } catch {
        status = "unavailable";
      }
      if (status === "downloadable" || status === "downloading") {
        const ok = await askToDownload(this.app, {
          title: "Download speech recognition?",
          message: `To recognise ${LANGUAGES[lang] ?? lang} speech on this device, the browser needs to download its language pack.`,
          detail: "Your audio then stays on this device.",
          cta: "Download",
        });
        if (!ok) return;
        new Notice("Downloading the speech recognition language pack…");
        const installed = await installOnDevice(Ctor, lang).catch(() => false);
        status = installed ? "available" : await onDeviceStatus(Ctor, lang).catch(() => "unavailable");
      }
      local = status === "available";
      if (!local && !this.options.allowServerRecognition) {
        new Notice(`On-device speech recognition is not available for ${LANGUAGES[lang] ?? lang} in this browser. To dictate anyway, turn on “Allow server-based recognition” in Settings → Voice (audio is then sent to the browser vendor).`, 10000);
        return;
      }
    } else if (!this.options.allowServerRecognition) {
      new Notice("This browser only recognises speech on its vendor's servers. To dictate anyway, turn on “Allow server-based recognition” in Settings → Voice (audio is then sent to the browser vendor).", 10000);
      return;
    }

    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    if (local && "processLocally" in rec) rec.processLocally = true;
    this.recognition = rec;
    this.dictationEditor = view.editor;
    this.dictating = true;
    this.showDictationStatus(local);

    rec.onresult = (event: any) => {
      const editor = this.dictationEditor;
      if (!editor) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript: string = result[0]?.transcript ?? "";
        if (result.isFinal) this.insertFinal(transcript);
        else interim += transcript;
      }
      this.showInterim(interim);
    };
    rec.onerror = (event: any) => {
      const messages: Record<string, string> = {
        "not-allowed": "Microphone access was blocked. Allow the microphone for this site to dictate.",
        "service-not-allowed": "The browser refused to start speech recognition.",
        "audio-capture": "No microphone was found.",
        network: "Speech recognition failed: the browser's recognition service could not be reached.",
        "language-not-supported": `Speech recognition does not support ${LANGUAGES[lang] ?? lang}.`,
      };
      if (event.error === "no-speech" || event.error === "aborted") return;
      new Notice(messages[event.error] ?? `Dictation stopped: ${event.error}`, 8000);
      this.stopDictation();
    };
    rec.onend = () => {
      // Recognition ends on its own after silence; keep going until the user stops.
      if (this.dictating && this.recognition === rec) {
        try {
          rec.start();
        } catch {
          this.stopDictation();
        }
      }
    };
    try {
      rec.start();
    } catch (e) {
      new Notice(`Could not start dictation: ${(e as Error).message}`);
      this.stopDictation();
    }
  }

  stopDictation(): void {
    if (!this.dictating && !this.recognition) return;
    this.dictating = false;
    const rec = this.recognition;
    this.recognition = null;
    try {
      rec?.stop();
    } catch {
      /* already stopped */
    }
    this.showInterim("");
    this.dictationEditor = null;
    this.dictationStatusEl?.remove();
    this.dictationStatusEl = null;
  }

  private showInterim(text: string) {
    const cm = this.dictationEditor?.cm;
    if (!cm) return;
    const pos = cm.state.selection.main.head;
    const before = cm.state.sliceDoc(Math.max(0, pos - 40), pos);
    const shown = text ? joinDictation(text, before, false) : "";
    cm.dispatch({ effects: setInterim.of(shown ? { pos, text: shown } : null) });
  }

  private insertFinal(transcript: string) {
    const editor = this.dictationEditor;
    if (!editor) return;
    const from = editor.getCursor("from");
    const offset = editor.posToOffset(from);
    const before = editor.getValue().slice(Math.max(0, offset - 40), offset);
    const text = joinDictation(transcript, before, this.options.spokenPunctuation);
    if (!text) return;
    editor.replaceSelection(text);
  }

  private showDictationStatus(local: boolean) {
    this.dictationStatusEl?.remove();
    const el = this.addStatusBarItem();
    el.addClass("vault-voice-status", "mod-clickable", "is-dictating");
    const dot = el.createSpan({ cls: "vault-voice-dot" });
    dot.setAttr("aria-hidden", "true");
    el.createSpan({ text: `Dictating · ${this.dictationLang()}${local ? " · on device" : ""}` });
    el.setAttr("aria-label", "Stop dictation");
    el.addEventListener("click", () => this.stopDictation());
    this.dictationStatusEl = el;
  }

  // ---- read aloud -------------------------------------------------------------------

  isReading(): boolean {
    return this.reading;
  }

  private pickVoice(lang: string | null): SpeechSynthesisVoice | null {
    const voices = speechSynthesis.getVoices();
    if (this.options.voiceURI) {
      const v = voices.find((x) => x.voiceURI === this.options.voiceURI);
      if (v) return v;
    }
    if (lang) {
      const l = lang.toLowerCase();
      return voices.find((x) => x.lang.toLowerCase() === l) ?? voices.find((x) => x.lang.toLowerCase().startsWith(l.split("-")[0]!)) ?? null;
    }
    return null;
  }

  async readNote(view: MarkdownView, selectionOnly: boolean): Promise<void> {
    if (!hasSpeechSynthesis()) {
      new Notice("This browser cannot read text aloud (no speechSynthesis).");
      return;
    }
    this.stopReading();
    const editor = view.editor;
    const text = editor.getValue();
    let from = 0;
    let to = text.length;
    if (selectionOnly && editor.somethingSelected()) {
      from = editor.posToOffset(editor.getCursor("from"));
      to = editor.posToOffset(editor.getCursor("to"));
    }
    const fmLang = view.file ? this.app.metadataCache.getFileCache(view.file)?.frontmatter?.lang : null;
    const lang = typeof fmLang === "string" ? fmLang : null;
    this.segments = speechSegments(text, from, to, lang ?? undefined);
    if (!this.segments.length) {
      new Notice("Nothing to read aloud.");
      return;
    }
    this.readingView = view;
    this.segmentIndex = 0;
    this.reading = true;
    this.paused = false;
    this.showReadStatus();
    this.speakNext(++this.readToken, lang);
  }

  private speakNext(token: number, lang: string | null) {
    if (token !== this.readToken || !this.reading) return;
    const seg = this.segments[this.segmentIndex];
    if (!seg) {
      this.stopReading();
      return;
    }
    const u = new SpeechSynthesisUtterance(seg.text);
    const voice = this.pickVoice(lang);
    if (voice) {
      try {
        u.voice = voice;
      } catch {
        /* not a SpeechSynthesisVoice of this browser */
      }
    }
    if (lang) u.lang = lang;
    else if (voice) u.lang = voice.lang;
    u.rate = this.options.rate;
    u.pitch = this.options.pitch;
    u.onstart = () => {
      if (token !== this.readToken) return;
      this.highlight(seg);
      this.updateReadStatus();
    };
    u.onend = () => {
      if (token !== this.readToken) return;
      this.segmentIndex++;
      this.speakNext(token, lang);
    };
    u.onerror = (e: SpeechSynthesisErrorEvent) => {
      if (token !== this.readToken) return;
      if (e.error === "interrupted" || e.error === "canceled") return;
      new Notice(`Reading aloud stopped: ${e.error}`);
      this.stopReading();
    };
    speechSynthesis.speak(u);
  }

  private highlight(seg: SpeechSegment | null) {
    const cm = (this.readingView?.editor as { cm?: any } | undefined)?.cm;
    if (!cm || !this.options.highlightSentence) return;
    try {
      cm.dispatch({ effects: setSpeaking.of(seg ? { from: seg.from, to: seg.to } : null) });
      if (seg) {
        const coords = cm.coordsAtPos(seg.from);
        const rect = cm.scrollDOM.getBoundingClientRect();
        if (!coords || coords.top < rect.top || coords.bottom > rect.bottom) cm.dispatch({ effects: EditorView.scrollIntoView(seg.from, { y: "center" }) });
      }
    } catch {
      /* the editor was closed */
    }
  }

  togglePause(): void {
    if (!this.reading) return;
    if (this.paused) speechSynthesis.resume();
    else speechSynthesis.pause();
    this.paused = !this.paused;
    this.updateReadStatus();
  }

  stopReading(): void {
    const wasReading = this.reading;
    this.reading = false;
    this.paused = false;
    this.readToken++;
    if (wasReading && hasSpeechSynthesis()) speechSynthesis.cancel();
    this.highlight(null);
    this.readingView = null;
    this.readStatusEl?.remove();
    this.readStatusEl = null;
  }

  private showReadStatus() {
    this.readStatusEl?.remove();
    const el = this.addStatusBarItem();
    el.addClass("vault-voice-status", "is-reading");
    this.readStatusEl = el;
    this.updateReadStatus();
  }

  private updateReadStatus() {
    const el = this.readStatusEl;
    if (!el) return;
    el.empty();
    const label = el.createSpan({ cls: "vault-voice-progress", text: `${this.paused ? "Paused" : "Reading aloud"} · ${Math.min(this.segmentIndex + 1, this.segments.length)}/${this.segments.length}` });
    label.setAttr("aria-live", "polite");
    const pause = el.createSpan({ cls: "clickable-icon vault-voice-button", attr: { "aria-label": this.paused ? "Resume" : "Pause", role: "button" } });
    setIcon(pause, this.paused ? "lucide-play" : "lucide-pause");
    pause.addEventListener("click", () => this.togglePause());
    const stop = el.createSpan({ cls: "clickable-icon vault-voice-button", attr: { "aria-label": "Stop", role: "button" } });
    setIcon(stop, "lucide-square");
    stop.addEventListener("click", () => this.stopReading());
  }
}

class VoiceSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: VoicePlugin,
  ) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();
    const Ctor = recognitionCtor();

    new Setting(containerEl).setName("Dictation").setHeading();
    const status = containerEl.createDiv({ cls: "setting-item-description vault-device-support" });
    if (!Ctor) status.setText("This browser has no speech recognition (Web Speech API), so dictation is unavailable. Chrome, Edge and Safari have it; Firefox does not.");
    else if (!supportsOnDevice(Ctor)) status.setText("This browser recognises speech on its vendor's servers only. Dictation works after you allow server-based recognition below.");
    else {
      // Not probed here: SpeechRecognition.available() crashes the renderer of headless Chromium 153,
      // so it is only called when the user starts dictating.
      status.setText("This browser supports on-device speech recognition. Whether your language is installed is checked when you start dictating; a language pack download is asked for first.");
    }
    new Setting(containerEl)
      .setName("Language")
      .setDesc("The language you speak.")
      .addDropdown((d) => {
        for (const [code, name] of Object.entries(LANGUAGES)) d.addOption(code, code ? `${name} (${code})` : `${name} (${navigator.language})`);
        if (o.dictationLanguage && !(o.dictationLanguage in LANGUAGES)) d.addOption(o.dictationLanguage, o.dictationLanguage);
        d.setValue(o.dictationLanguage).onChange((v) => {
          o.dictationLanguage = v;
          save();
          this.display();
        });
      });
    new Setting(containerEl)
      .setName("Allow server-based recognition")
      .setDesc("When on-device recognition is unavailable, send microphone audio to the browser vendor's speech service (Google for Chrome, Apple for Safari, Microsoft for Edge).")
      .addToggle((t) => t.setValue(o.allowServerRecognition).onChange((v) => ((o.allowServerRecognition = v), save())));
    new Setting(containerEl)
      .setName("Spoken punctuation")
      .setDesc("Say “comma”, “period”, “question mark”, “new line” or “new paragraph” to type them.")
      .addToggle((t) => t.setValue(o.spokenPunctuation).onChange((v) => ((o.spokenPunctuation = v), save())));

    new Setting(containerEl).setName("Read aloud").setHeading();
    if (!hasSpeechSynthesis()) {
      containerEl.createDiv({ cls: "setting-item-description vault-device-support", text: "This browser cannot read text aloud (no speechSynthesis)." });
    } else {
      const voices = speechSynthesis.getVoices();
      new Setting(containerEl)
        .setName("Voice")
        .setDesc("“Automatic” picks a voice for the note's `lang` property, else the browser default.")
        .addDropdown((d) => {
          d.addOption("", "Automatic");
          for (const v of voices) d.addOption(v.voiceURI, `${v.name} (${v.lang})${v.localService ? "" : " · online"}`);
          d.setValue(o.voiceURI).onChange((v) => ((o.voiceURI = v), save()));
        });
      new Setting(containerEl)
        .setName("Speed")
        .addSlider((s) => s.setLimits(0.5, 2, 0.1).setValue(o.rate).setDynamicTooltip().onChange((v) => ((o.rate = v), save())));
      new Setting(containerEl)
        .setName("Pitch")
        .addSlider((s) => s.setLimits(0.5, 2, 0.1).setValue(o.pitch).setDynamicTooltip().onChange((v) => ((o.pitch = v), save())));
      new Setting(containerEl)
        .setName("Highlight the sentence being read")
        .addToggle((t) => t.setValue(o.highlightSentence).onChange((v) => ((o.highlightSentence = v), save())));
    }
    new Setting(containerEl).setName("Transcription").setHeading();
    containerEl.createDiv({
      cls: "setting-item-description vault-device-support",
      text: "Transcribing existing recordings is not built in: browsers offer no on-device speech-to-text for audio files, and this app does not download a speech model. Dictate while playing the recording, or use a transcription plugin.",
    });
  }
}
