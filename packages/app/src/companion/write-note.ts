/**
 * Writes a clip into the vault the way Obsidian handles the Web Clipper's
 * `obsidian://new` and `obsidian://daily` URIs: create (never overwriting an
 * existing note), overwrite, append/prepend to a named note, or append/prepend
 * to today's daily note through the Daily notes core plugin.
 */
import type { App } from "../obsidian/app";
import { Notice } from "../obsidian/ui/notice";
import { moment, normalizePath } from "../obsidian/util";
import type { TFile } from "../obsidian/vault/files";
import { mergeContent } from "../settings/uri";
import type { ClipRequest } from "./protocol";

const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";

async function ensureFolder(app: App, path: string) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
}

function notePath(raw: string): string {
  if (raw.split(/[\\/]/).includes("..")) throw new Error('The note path cannot contain "..".');
  let path = normalizePath(raw.replace(/\\/g, "/"));
  if (!path || path === "/") throw new Error("The note has no name.");
  if (!/\.md$/i.test(path)) path += ".md";
  return path;
}

async function dailyNote(app: App): Promise<TFile> {
  const daily = app.internalPlugins.getEnabledPluginById("daily-notes") as
    | { getDailyNote?: () => TFile | null; createDailyNote?: () => Promise<TFile> }
    | null;
  if (daily?.getDailyNote && daily.createDailyNote) return daily.getDailyNote() ?? (await daily.createDailyNote());
  // The plugin is off: Obsidian's default daily note (vault root, YYYY-MM-DD).
  const path = `${moment().format(DEFAULT_DAILY_FORMAT)}.md`;
  return app.vault.getFileByPath(path) ?? (await app.vault.create(path, ""));
}

/** Returns the path written. */
export async function writeClip(app: App, clip: ClipRequest): Promise<TFile> {
  let file: TFile;
  switch (clip.behavior) {
    case "append-daily":
    case "prepend-daily": {
      file = await dailyNote(app);
      await app.vault.process(file, (text) => mergeContent(text, clip.content, clip.behavior === "append-daily" ? "append" : "prepend"));
      break;
    }
    case "append-specific":
    case "prepend-specific": {
      const path = notePath(clip.path);
      const existing = app.vault.getFileByPath(path);
      if (existing) {
        file = existing;
        await app.vault.process(file, (text) => mergeContent(text, clip.content, clip.behavior === "append-specific" ? "append" : "prepend"));
      } else {
        await ensureFolder(app, path);
        file = await app.vault.create(path, clip.content);
      }
      break;
    }
    case "overwrite": {
      const path = notePath(clip.path);
      const existing = app.vault.getFileByPath(path);
      if (existing) {
        file = existing;
        await app.vault.modify(file, clip.content);
      } else {
        await ensureFolder(app, path);
        file = await app.vault.create(path, clip.content);
      }
      break;
    }
    case "create":
    default: {
      let path = notePath(clip.path);
      if (app.vault.getAbstractFileByPath(path)) path = app.vault.getAvailablePath(path.slice(0, -3), "md");
      await ensureFolder(app, path);
      file = await app.vault.create(path, clip.content);
      break;
    }
  }
  new Notice(`Clipped to “${file.basename}”`);
  if (!clip.silent) await app.workspace.getLeaf("tab").openFile(file, { active: true });
  return file;
}
