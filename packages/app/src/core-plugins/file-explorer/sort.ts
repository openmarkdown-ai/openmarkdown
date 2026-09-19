/**
 * Sort orders of the file explorer. The ids are Obsidian's: they are what a
 * vault's `workspace.json` stores in the file-explorer leaf's `sortOrder`.
 */
import { TFile, TFolder, type TAbstractFile } from "../../obsidian/vault/files";

export type SortOrder =
  | "alphabetical"
  | "alphabeticalReverse"
  | "byModifiedTime"
  | "byModifiedTimeReverse"
  | "byCreatedTime"
  | "byCreatedTimeReverse"
  | "custom";

/** Menu groups, in the order the "Change sort order" menu shows them. */
export const SORT_MENU: { order: SortOrder; title: string }[][] = [
  [
    { order: "alphabetical", title: "File name (A to Z)" },
    { order: "alphabeticalReverse", title: "File name (Z to A)" },
  ],
  [
    { order: "byModifiedTime", title: "Modified time (new to old)" },
    { order: "byModifiedTimeReverse", title: "Modified time (old to new)" },
  ],
  [
    { order: "byCreatedTime", title: "Created time (new to old)" },
    { order: "byCreatedTimeReverse", title: "Created time (old to new)" },
  ],
  [{ order: "custom", title: "Custom order" }],
];

export function isSortOrder(value: unknown): value is SortOrder {
  return SORT_MENU.some((group) => group.some((o) => o.order === value));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Natural, case-insensitive name comparison ("Note 2" before "Note 10"). */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Folders always come first. Folders are ordered by name (reversed only for
 * Z to A); files follow the chosen order, falling back to name for ties.
 */
export function compareFiles(order: SortOrder, a: TAbstractFile, b: TAbstractFile, nameOf: (f: TAbstractFile) => string = (f) => f.name): number {
  const aFolder = a instanceof TFolder;
  const bFolder = b instanceof TFolder;
  if (aFolder !== bFolder) return aFolder ? -1 : 1;
  const byName = compareNames(nameOf(a), nameOf(b));
  if (aFolder || !(a instanceof TFile) || !(b instanceof TFile)) {
    return order === "alphabeticalReverse" ? -byName : byName;
  }
  switch (order) {
    case "alphabetical":
      return byName;
    case "alphabeticalReverse":
      return -byName;
    case "byModifiedTime":
      return b.stat.mtime - a.stat.mtime || byName;
    case "byModifiedTimeReverse":
      return a.stat.mtime - b.stat.mtime || byName;
    case "byCreatedTime":
      return b.stat.ctime - a.stat.ctime || byName;
    case "byCreatedTimeReverse":
      return a.stat.ctime - b.stat.ctime || byName;
  }
  return byName;
}

/**
 * "Custom order": `.obsidian/file-explorer.json` → `manualOrder`, a map of
 * folder path ("/" for the vault root) to child names in display order.
 * Children missing from the list follow, folders first, by name. Files are
 * never renamed.
 */
export type ManualOrder = Record<string, string[]>;

export function manualOrderKey(folder: TFolder): string {
  return folder.isRoot() ? "/" : folder.path;
}

export function applyManualOrder<T extends { file: TAbstractFile }>(order: ManualOrder, folder: TFolder, items: T[], nameOf?: (f: TAbstractFile) => string): T[] {
  const list = order[manualOrderKey(folder)] ?? [];
  const index = new Map<string, number>();
  list.forEach((name, i) => {
    if (!index.has(name)) index.set(name, i);
  });
  return items.slice().sort((a, b) => {
    const ia = index.get(a.file.name);
    const ib = index.get(b.file.name);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return compareFiles("alphabetical", a.file, b.file, nameOf);
  });
}
