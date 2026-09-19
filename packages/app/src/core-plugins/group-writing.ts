import type { CorePluginDefinition } from "../obsidian/app-internals/internal-plugins";
import { audioRecorder, mediaViews } from "./audio-recorder/index";
import { dailyNotes } from "./daily-notes/index";
import { quickCapture } from "./quick-capture/index";
import { fileRecovery } from "./file-recovery/index";
import { formatConverter } from "./format-converter/index";
import { importer } from "./markdown-importer/index";
import { noteComposer } from "./note-composer/index";
import { exportPdf, publish } from "./publish/index";
import { exportPlugin } from "./export/index";
import { citations } from "./citations/index";
import { slashCommand } from "./slash-command/index";
import { slides } from "./slides/index";
import { templates } from "./templates/index";
import { webviewer } from "./webviewer/index";
import { externalEmbeds, media } from "./media/index";
import { smartPaste } from "./smart-paste/index";
import { localImages } from "./local-images/index";
import { writingFocus } from "./writing-focus/index";
import { formattingToolbar } from "./formatting-toolbar/index";
import { grammar } from "./grammar/index";

/**
 * Core plugins in the "writing" group.
 *
 * `mediaViews` (image/audio/video/PDF embeds and file views) and `exportPdf`
 * (`workspace:export-pdf`) are app features in Obsidian rather than
 * toggleable plugins; they are always-on definitions marked `hidden`.
 */
export const definitions: CorePluginDefinition[] = [
  dailyNotes,
  quickCapture,
  templates,
  noteComposer,
  formatConverter,
  fileRecovery,
  audioRecorder,
  mediaViews,
  externalEmbeds,
  media,
  smartPaste,
  localImages,
  slides,
  webviewer,
  slashCommand,
  importer,
  publish,
  exportPdf,
  exportPlugin,
  citations,
  writingFocus,
  formattingToolbar,
  grammar,
];
