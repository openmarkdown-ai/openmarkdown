/**
 * `.obsidian/bookmarks.json` — the bookmark tree, in Obsidian's format:
 *
 *   { "items": [
 *       { "type": "file",   "ctime": 1700000000000, "path": "Note.md", "subpath": "#Heading", "title": "…" },
 *       { "type": "folder", "ctime": …, "path": "Projects" },
 *       { "type": "search", "ctime": …, "query": "tag:#todo" },
 *       { "type": "graph",  "ctime": …, "title": "…", "options": { … } },
 *       { "type": "url",    "ctime": …, "url": "https://…", "title": "…" },
 *       { "type": "group",  "ctime": …, "title": "Reading", "items": [ … ] } ] }
 *
 * Unknown fields on items are kept, so a file written by a newer Obsidian
 * round-trips unchanged.
 */
import type { TAbstractFile } from "../../obsidian/vault/files";

export type BookmarkType = "file" | "folder" | "search" | "graph" | "group" | "url";

export interface BookmarkItem {
  type: BookmarkType;
  ctime: number;
  path?: string;
  subpath?: string;
  title?: string;
  query?: string;
  url?: string;
  options?: Record<string, unknown>;
  items?: BookmarkItem[];
  [key: string]: unknown;
}

const TYPES = new Set<BookmarkType>(["file", "folder", "search", "graph", "group", "url"]);

/** Keep only well-formed items; drop anything that would crash the view. */
export function sanitizeItems(raw: unknown): BookmarkItem[] {
  if (!Array.isArray(raw)) return [];
  const out: BookmarkItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || !TYPES.has((r as BookmarkItem).type)) continue;
    const item = { ...(r as BookmarkItem) };
    if (typeof item.ctime !== "number") item.ctime = Date.now();
    if (item.type === "group") item.items = sanitizeItems(item.items);
    out.push(item);
  }
  return out;
}

/** Depth-first walk; the callback may return true to stop. */
export function walkItems(items: BookmarkItem[], cb: (item: BookmarkItem, parent: BookmarkItem | null) => boolean | void, parent: BookmarkItem | null = null): boolean {
  for (const item of items) {
    if (cb(item, parent) === true) return true;
    if (item.type === "group" && item.items && walkItems(item.items, cb, item)) return true;
  }
  return false;
}

/** The group holding `item`, or null for the top level; undefined when not found. */
export function findParent(items: BookmarkItem[], target: BookmarkItem): BookmarkItem | null | undefined {
  let found: BookmarkItem | null | undefined;
  walkItems(items, (item, parent) => {
    if (item === target) {
      found = parent;
      return true;
    }
  });
  return found;
}

export function isDescendant(group: BookmarkItem, item: BookmarkItem): boolean {
  if (group === item) return true;
  return group.type === "group" && !!group.items?.some((c) => isDescendant(c, item));
}

/** The title Obsidian shows when an item has none of its own. */
export function defaultTitle(item: BookmarkItem, getName: () => string): string {
  switch (item.type) {
    case "file": {
      const path = item.path ?? "";
      const name = path.slice(path.lastIndexOf("/") + 1);
      const base = name.endsWith(".md") ? name.slice(0, -3) : name;
      if (!item.subpath) return base;
      const sub = item.subpath.replace(/^#/, "");
      return `${base} > ${sub.split("#").join(" > ")}`;
    }
    case "folder": {
      const path = item.path ?? "";
      return path === "/" || path === "" ? getName() : path.slice(path.lastIndexOf("/") + 1);
    }
    case "search":
      return item.query ?? "";
    case "graph":
      return "Graph view";
    case "url":
      return item.url ?? "";
    case "group":
      return "Untitled group";
  }
  return "";
}

export function iconFor(item: BookmarkItem, file: TAbstractFile | null): string {
  switch (item.type) {
    case "file": {
      if (item.subpath?.startsWith("#^")) return "lucide-box";
      if (item.subpath) return "lucide-heading";
      const ext = (item.path ?? "").split(".").pop()?.toLowerCase() ?? "";
      if (ext === "canvas") return "lucide-layout-dashboard";
      if (ext === "base") return "lucide-table";
      if (ext === "pdf") return "lucide-file-text";
      if (["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"].includes(ext)) return "lucide-image";
      if (["mp3", "wav", "m4a", "ogg", "flac", "3gp"].includes(ext)) return "lucide-file-audio";
      if (["mp4", "webm", "ogv", "mov", "mkv"].includes(ext)) return "lucide-file-video";
      return file ? "lucide-file" : "lucide-file-x";
    }
    case "folder":
      return "lucide-folder";
    case "search":
      return "lucide-search";
    case "graph":
      return "lucide-git-fork";
    case "url":
      return "lucide-globe-2";
    case "group":
      return "lucide-folder-open";
  }
  return "lucide-bookmark";
}
