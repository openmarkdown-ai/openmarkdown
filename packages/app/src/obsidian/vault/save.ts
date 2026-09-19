/**
 * Check-before-write: a save that notices the file changed since it was loaded.
 *
 * A view remembers the version its buffer is based on (`SaveBase`: the text,
 * with `\n` line endings, and the mtime and size it had). Before writing, the
 * file is `stat`ed; if it moved on, it is read and merged three ways (base,
 * disk, buffer). A clean merge is written; a conflict writes nothing and is
 * handed back so the view can ask. Both sides are snapshotted in File recovery
 * before anything is replaced, so an automatic merge is always undoable.
 */
import type { TFile } from "./files";
import { merge3, type MergeResult } from "./merge";
import { normalizeEol } from "./text-format";
import type { Vault } from "./vault";

export interface SaveBase {
  text: string;
  mtime: number;
  size: number;
}

export type WriteOutcome =
  | { kind: "written"; text: string; base: SaveBase }
  | { kind: "merged"; text: string; theirs: string; base: SaveBase }
  | { kind: "conflict"; theirs: string; theirsBase: SaveBase; merge: MergeResult }
  | { kind: "deleted" };

/**
 * Line merges are only applied automatically to Markdown and plain text. A
 * structured file (Canvas or Bases JSON/YAML) could merge into something that
 * no longer parses, so there a concurrent change always asks.
 */
export function canAutoMerge(file: TFile): boolean {
  return file.extension === "md" || file.extension === "txt";
}

export async function checkedWrite(vault: Vault, file: TFile, buffer: string, base: SaveBase): Promise<WriteOutcome> {
  const mine = normalizeEol(buffer);
  const st = await vault.adapter.stat(file.path);
  if (!st || st.type !== "file") return { kind: "deleted" };
  let text = mine;
  let theirs: string | null = null;
  if (st.mtime !== base.mtime || st.size !== base.size) {
    const disk = normalizeEol(await vault.adapter.read(file.path));
    const diskBase: SaveBase = { text: disk, mtime: st.mtime, size: st.size };
    if (disk === mine) return { kind: "written", text: mine, base: diskBase };
    if (disk !== base.text) {
      const merge = merge3(base.text, mine, disk);
      await vault.snapshot(file.path, disk);
      await vault.snapshot(file.path, mine);
      // An emptied file is how sync clients and placeholders fail; never merge it in silently.
      const emptied = disk.trim() === "" && base.text.trim() !== "";
      if (!merge.clean || emptied || !canAutoMerge(file)) return { kind: "conflict", theirs: disk, theirsBase: diskBase, merge };
      text = merge.text;
      theirs = disk;
    }
  }
  (vault.safety as { noteLocalWrite?: (path: string, text: string) => void } | null)?.noteLocalWrite?.(file.path, text);
  await vault.modify(file, text);
  const next: SaveBase = { text, mtime: file.stat.mtime, size: file.stat.size };
  return theirs === null ? { kind: "written", text, base: next } : { kind: "merged", text, theirs, base: next };
}

/** Human wording for a failed write. */
export function describeSaveError(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? "";
  const message = (e as { message?: string } | null)?.message ?? String(e);
  switch (name) {
    case "QuotaExceededError":
      return "Storage is full. Free up disk or browser storage space.";
    case "NotAllowedError":
    case "SecurityError":
      return "Permission to the vault folder was lost.";
    case "NoModificationAllowedError":
      return "The file is locked by another program.";
    case "NotFoundError":
      return "The folder is no longer available.";
    case "NotReadableError":
      return "The file could not be read.";
    case "NotUtf8Error":
      return message;
    default:
      return message || "Unknown error";
  }
}
