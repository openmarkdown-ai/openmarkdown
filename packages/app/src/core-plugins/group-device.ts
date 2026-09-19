import type { CorePluginDefinition } from "../obsidian/app-internals/internal-plugins";
import { Plugin } from "../obsidian/plugin";
import type { OcrOptions } from "./ocr/index";
import type { VoiceOptions } from "./voice/index";
import type { AiToolsOptions } from "./ai-tools/index";
import type { RemindersOptions } from "./reminders/index";
import type { BackupOptions } from "./backup/index";
import type { TranscribeOptions } from "./transcribe/index";

type PluginClass = new (app: any, manifest: any) => Plugin;

/**
 * A core plugin whose implementation is a separate chunk, imported when the
 * plugin is enabled. The shell owns the lifecycle: the implementation is
 * loaded as its child, so disabling the plugin unloads everything it added.
 */
class LazyCorePlugin extends Plugin {
  instance!: any;
  // internal (used by tests and by code that needs the implementation's methods)
  impl: Plugin | null = null;

  constructor(
    app: any,
    manifest: any,
    private loader: () => Promise<PluginClass>,
  ) {
    super(app, manifest);
  }

  override async onload() {
    const Impl = await this.loader();
    const impl = new Impl(this.app, this.manifest) as Plugin & { instance?: unknown; isCorePlugin?: boolean };
    impl.isCorePlugin = true;
    impl.instance = this.instance;
    // Views go through the shell, so the core plugin wrapper records them.
    impl.registerView = (type: string, creator: (leaf: any) => any) => this.registerView(type, creator);
    await impl.load();
    this.addChild(impl);
    this.impl = impl;
  }
}

function lazy(meta: Omit<CorePluginDefinition, "create" | "defaultOn">, loader: () => Promise<PluginClass>): CorePluginDefinition {
  return {
    ...meta,
    defaultOn: false,
    create: (app) => new LazyCorePlugin(app, { id: meta.id, name: meta.name, version: "", minAppVersion: "", author: "", description: meta.description }, loader),
  };
}

/**
 * Core plugins in the "device" group: features built on browser and device
 * capabilities (text recognition, speech, on-device AI, notifications,
 * backups). All off by default, feature-detected, and loaded only when enabled.
 */
export const definitions: CorePluginDefinition[] = [
  lazy(
    {
      id: "ocr",
      name: "Text recognition",
      description: "Copy the text in images and scanned PDFs, and let search plugins index it.",
      icon: "lucide-scan-text",
      defaultOptions: { ocrLanguages: [], useTextDetector: true, ocrScannedPdfPages: true, provideTextExtractorApi: true, importedTextExtractorSettings: false } satisfies OcrOptions,
    },
    async () => (await import("./ocr/index")).OcrPlugin,
  ),
  lazy(
    {
      id: "voice",
      name: "Voice",
      description: "Dictate into notes and read notes aloud.",
      icon: "lucide-audio-lines",
      defaultOptions: { dictationLanguage: "", allowServerRecognition: false, spokenPunctuation: true, voiceURI: "", rate: 1, pitch: 1, highlightSentence: true } satisfies VoiceOptions,
    },
    async () => (await import("./voice/index")).VoicePlugin,
  ),
  lazy(
    {
      id: "ai-tools",
      name: "AI tools",
      description: "Summarize, translate, rewrite and ask about notes with the browser's on-device AI.",
      icon: "lucide-sparkles",
      defaultOptions: { targetLanguage: "", summaryType: "key-points", summaryLength: "medium", rewriteMode: "shorter", remoteEnabled: false, remoteBaseUrl: "", remoteModel: "" } satisfies AiToolsOptions,
    },
    async () => (await import("./ai-tools/index")).AiToolsPlugin,
  ),
  lazy(
    {
      id: "reminders",
      name: "Reminders",
      description: "Get notified about tasks with a reminder date, and export them to your calendar.",
      icon: "lucide-alarm-clock",
      defaultOptions: { defaultTime: "09:00", readTasksDates: false, readKanbanDates: false, systemNotifications: true, showBadge: true } satisfies RemindersOptions,
    },
    async () => (await import("./reminders/index")).RemindersPlugin,
  ),
  lazy(
    {
      id: "backup",
      name: "Backups",
      description: "Zip snapshots of the vault on a schedule, with restore.",
      icon: "lucide-archive",
      defaultOptions: { destination: "opfs", intervalMinutes: 60, backupOnOpen: false, keepLast: 10, keepDaily: 7, keepWeekly: 4, exclude: ".git, .trash, node_modules" } satisfies BackupOptions,
    },
    async () => (await import("./backup/index")).BackupPlugin,
  ),
  // AI meaning (docs/PLAN-ai.md stream A2): need Settings → AI; defaults live in each plugin.
  lazy(
    { id: "semantic", name: "Related notes", description: "Find notes related in meaning to the one you are writing, and search by meaning, with an index kept in this browser.", icon: "lucide-waypoints", defaultOptions: {} },
    async () => (await import("./semantic/index")).SemanticPlugin,
  ),
  lazy(
    { id: "vault-chat", name: "Chat with vault", description: "Ask questions and get answers from your notes, with links to the passages they cite.", icon: "lucide-messages-square", defaultOptions: {} },
    async () => (await import("./vault-chat/index")).VaultChatPlugin,
  ),
  // AI assist (docs/PLAN-ai.md stream A3): need Settings → AI; defaults live in each plugin.
  lazy(
    { id: "ai-suggest", name: "AI suggestions", description: "Suggested links, tags, properties, titles and image descriptions for the open note.", icon: "lucide-sparkles", defaultOptions: {} },
    async () => (await import("./ai-suggest/index")).AiSuggestPlugin,
  ),
  lazy(
    { id: "ai-query", name: "AI queries", description: "Describe what you want to see and get a Bases, Dataview or Tasks query, previewed before it is inserted.", icon: "lucide-sparkles", defaultOptions: {} },
    async () => (await import("./ai-query/index")).AiQueryPlugin,
  ),
  lazy(
    { id: "ai-review", name: "AI reviews", description: "Summarise a week's or month's daily notes into the weekly or monthly note, with links to each day.", icon: "lucide-calendar-check", defaultOptions: {} },
    async () => (await import("./ai-review/index")).AiReviewPlugin,
  ),
  lazy(
    {
      id: "transcribe",
      name: "Transcribe",
      description: "Turn recordings and other audio or video into transcripts with timestamp links, using the AI engine you choose.",
      icon: "lucide-captions",
      defaultOptions: { language: "", embedOutput: "below", folder: "", summarize: false, chunkMinutes: 5 } satisfies TranscribeOptions,
    },
    async () => (await import("./transcribe/index")).TranscribePlugin,
  ),
];
