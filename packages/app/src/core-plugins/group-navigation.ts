import type { CorePluginDefinition } from "../obsidian/app-internals/internal-plugins";
import { bookmarks } from "./bookmarks/index";
import { commandPalette } from "./command-palette/index";
import { editorStatus } from "./editor-status/index";
import { fileExplorer } from "./file-explorer/index";
import { randomNote } from "./random-note/index";
import { switcher } from "./switcher/index";
import { wordCount } from "./word-count/index";
import { workspaces } from "./workspaces/index";
import { zkPrefixer } from "./zk-prefixer/index";
import { noteTitles } from "./file-explorer/note-titles";
import { linkTabs } from "./switcher/link-tabs";
import { opensync } from "./opensync/index";

/**
 * Core plugins in the "navigation" group: finding, opening and arranging
 * files, plus the status bar items that describe the open note.
 */
export const definitions: CorePluginDefinition[] = [
  fileExplorer,
  bookmarks,
  switcher,
  commandPalette,
  randomNote,
  workspaces,
  editorStatus,
  wordCount,
  zkPrefixer,
  noteTitles,
  linkTabs,
  opensync,
];
