/**
 * Note titles: show a note's `title` property or first heading instead of its
 * file name (the forum's most-voted request; the Front Matter Title plugin's
 * job). Files are never renamed; only what the lists and tabs display changes.
 *
 * Settings (`.obsidian/app.json`, Settings → Files and links):
 *   displayTitle          "filename" (default) | "property" | "heading"
 *   displayTitleProperty  property name for "property" (default "title", as
 *                         Front Matter Title's default template)
 *
 * Where it applies: file explorer, tab headers, quick switcher (searches both
 * the title and the path), search results, backlinks and bookmarks.
 * The view header and inline title keep the file name, because clicking them
 * renames the file.
 *
 * The hidden core plugin `note-titles` keeps tab headers in step. It steps
 * aside when the Front Matter Title plugin (`obsidian-front-matter-title-plugin`)
 * is enabled.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { TFile, type TAbstractFile } from "../../obsidian/vault/files";
import { FileView } from "../../obsidian/workspace/view";

export type DisplayTitleSource = "filename" | "property" | "heading";

export const FRONT_MATTER_TITLE_PLUGIN = "obsidian-front-matter-title-plugin";

export function displayTitleSource(app: any): DisplayTitleSource {
  if (app?.plugins?.enabledPlugins?.has?.(FRONT_MATTER_TITLE_PLUGIN)) return "filename";
  const v = app?.vault?.getConfig?.("displayTitle");
  return v === "property" || v === "heading" ? v : "filename";
}

export function displayTitleProperty(app: any): string {
  const v = app?.vault?.getConfig?.("displayTitleProperty");
  return typeof v === "string" && v.trim() ? v.trim() : "title";
}

function stripInline(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]*)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/==(.+?)==/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/** The title configured for `file`, or null when it has none (then the name is shown). */
export function customTitle(app: any, file: TAbstractFile | null | undefined): string | null {
  if (!(file instanceof TFile) || file.extension !== "md") return null;
  const source = displayTitleSource(app);
  if (source === "filename") return null;
  const cache = app.metadataCache?.getFileCache?.(file);
  if (!cache) return null;
  if (source === "property") {
    const fm = cache.frontmatter;
    if (!fm || typeof fm !== "object") return null;
    const key = displayTitleProperty(app);
    const lower = key.toLowerCase();
    const k = Object.keys(fm).find((kk) => kk === key) ?? Object.keys(fm).find((kk) => kk.toLowerCase() === lower);
    let v = k === undefined ? null : fm[k];
    if (Array.isArray(v)) v = v.find((x) => typeof x === "string" || typeof x === "number") ?? null;
    if (typeof v === "number") v = String(v);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  }
  const h1 = (cache.headings ?? []).find((h: { level: number }) => h.level === 1);
  const text = h1 ? stripInline(String(h1.heading ?? "")) : "";
  return text || null;
}

/** What lists show for `file`: its custom title, else the basename (or name for non-notes). */
export function getDisplayTitle(app: any, file: TFile): string {
  return customTitle(app, file) ?? (file.extension === "md" ? file.basename : file.name);
}

const LEAF_PATCH = Symbol("vault-note-title");

class NoteTitlesPlugin extends Plugin {
  instance!: any;
  private patched = new Set<any>();

  override async onload() {
    this.instance.getDisplayTitle = (file: TFile) => getDisplayTitle(this.app, file);
    const refresh = () => this.refreshLeaves();
    this.registerEvent(this.app.workspace.on("layout-change", refresh));
    this.registerEvent(this.app.workspace.on("file-open", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    this.registerEvent(
      this.app.vault.on("config-changed", (key: string) => {
        if (key === "displayTitle" || key === "displayTitleProperty") refresh();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        if (displayTitleSource(this.app) === "filename") return;
        this.app.workspace.iterateAllLeaves((leaf: any) => {
          if (leaf.view instanceof FileView && leaf.view.file === file) leaf.updateHeader?.();
        });
      }),
    );
    this.app.workspace.onLayoutReady(refresh);
  }

  override onunload() {
    for (const leaf of this.patched) {
      delete leaf.getDisplayText;
      delete leaf[LEAF_PATCH];
      leaf.updateHeader?.();
    }
    this.patched.clear();
    delete this.instance.getDisplayTitle;
  }

  private refreshLeaves() {
    const app = this.app;
    const on = displayTitleSource(app) !== "filename";
    app.workspace.iterateAllLeaves((leaf: any) => {
      if (on && !leaf[LEAF_PATCH]) {
        const original = leaf.getDisplayText;
        leaf[LEAF_PATCH] = true;
        // Only the tab header reads the leaf's text; the view header keeps the file name for renaming.
        // Only views *of* the note take its title: Backlinks, Outgoing links and Outline also have a
        // `file` (the note they describe) but keep their own names.
        leaf.getDisplayText = function (this: any) {
          const file = this.deferredState || !(this.view instanceof FileView) ? null : this.view.file;
          return (file && customTitle(app, file)) ?? original.call(this);
        };
        this.patched.add(leaf);
      }
      if (leaf[LEAF_PATCH]) leaf.updateHeader?.();
    });
  }
}

export const noteTitles: CorePluginDefinition = {
  id: "note-titles",
  name: "Note titles",
  description: "Show notes by their title property or first heading.",
  defaultOn: true,
  hidden: true,
  defaultOptions: {},
  create: (app) => new NoteTitlesPlugin(app, { id: "note-titles", name: "Note titles", version: "", minAppVersion: "", author: "", description: "" }),
};
