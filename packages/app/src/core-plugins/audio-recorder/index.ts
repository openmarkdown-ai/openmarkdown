import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { MediaViewsPlugin } from "./media";
import { AudioRecorderPlugin } from "./recorder";

export const audioRecorder: CorePluginDefinition = {
  id: "audio-recorder",
  name: "Audio recorder",
  description: "Record audio notes and save them as attachments",
  icon: "lucide-mic",
  defaultOn: false,
  defaultOptions: {},
  create: (app) =>
    new AudioRecorderPlugin(app, { id: "audio-recorder", name: "Audio recorder", version: "", minAppVersion: "", author: "", description: "Record audio notes and save them as attachments" }),
};

/**
 * Image, audio, video and PDF embeds and tabs. Always on and not listed in
 * Settings → Core plugins (`hidden`): in Obsidian these are part of the app.
 */
export const mediaViews = {
  id: "media-views",
  name: "Media",
  description: "View and embed images, audio, video and PDF files",
  icon: "lucide-image",
  defaultOn: true,
  hidden: true,
  defaultOptions: {},
  create: (app: any) =>
    new MediaViewsPlugin(app, { id: "media-views", name: "Media", version: "", minAppVersion: "", author: "", description: "View and embed images, audio, video and PDF files" }),
} as CorePluginDefinition;
