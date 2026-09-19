/**
 * Where backups go: the origin private file system (every modern browser) or
 * a folder the user picks (Chromium desktop, File System Access API), plus the
 * snapshot naming and retention rules.
 */
import { idb } from "../../obsidian/vault/idb";
import type { ZipSink } from "./zip-writer";

export interface SnapshotInfo {
  name: string;
  size: number;
  /** When the snapshot was taken (from its name), ms. */
  time: number;
  /** Label of a named backup, kept forever. */
  label: string | null;
}

export interface BackupStore {
  kind: "opfs" | "folder";
  label: string;
  list(): Promise<SnapshotInfo[]>;
  create(name: string): Promise<ZipSink>;
  read(name: string): Promise<ArrayBuffer>;
  remove(name: string): Promise<void>;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function slug(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

/** `<vault>-<YYYYMMDDHHmmss>[-<label>].zip`, as Local Backup names its files. */
export function snapshotName(vault: string, ms: number, label?: string): string {
  return `${slug(vault) || "vault"}-${stamp(ms)}${label ? `-${slug(label)}` : ""}.zip`;
}

export function parseSnapshotName(name: string): { time: number; label: string | null } | null {
  const m = /-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:-(.+))?\.zip$/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  return { time: new Date(y, mo - 1, d, h, mi, s).getTime(), label: m[7] ?? null };
}

export interface Retention {
  keepLast: number;
  keepDaily: number;
  keepWeekly: number;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function weekKey(ms: number): string {
  // ISO week: the Thursday of the week decides the year.
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round(((d.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${week}`;
}

/**
 * Snapshots to delete: everything except named backups, the newest
 * `keepLast`, the newest of each of the last `keepDaily` days that have one,
 * and the newest of each of the last `keepWeekly` weeks that have one.
 */
export function snapshotsToDelete(snapshots: SnapshotInfo[], r: Retention): SnapshotInfo[] {
  const sorted = [...snapshots].sort((a, b) => b.time - a.time);
  const keep = new Set<string>();
  for (const s of sorted) if (s.label) keep.add(s.name);
  const auto = sorted.filter((s) => !s.label);
  auto.slice(0, Math.max(0, r.keepLast)).forEach((s) => keep.add(s.name));
  const bucket = (key: (ms: number) => string, n: number) => {
    const seen = new Set<string>();
    for (const s of auto) {
      const k = key(s.time);
      if (seen.has(k)) continue;
      if (seen.size >= n) break;
      seen.add(k);
      keep.add(s.name);
    }
  };
  bucket(dayKey, Math.max(0, r.keepDaily));
  bucket(weekKey, Math.max(0, r.keepWeekly));
  return auto.filter((s) => !keep.has(s.name));
}

// ---- stores ------------------------------------------------------------------------

function writableSink(writable: FileSystemWritableFileStream): ZipSink {
  return {
    write: (chunk) => writable.write(chunk as Uint8Array<ArrayBuffer>),
    close: () => writable.close(),
    abort: () => writable.abort(),
  };
}

async function listDir(dir: FileSystemDirectoryHandle): Promise<SnapshotInfo[]> {
  const out: SnapshotInfo[] = [];
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind !== "file" || !name.endsWith(".zip")) continue;
    const parsed = parseSnapshotName(name);
    if (!parsed) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    out.push({ name, size: file.size, time: parsed.time, label: parsed.label });
  }
  return out.sort((a, b) => b.time - a.time);
}

export function hasOpfs(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

export function hasFolderPicker(): boolean {
  return typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

export async function opfsStore(vaultId: string): Promise<BackupStore> {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle("openmarkdown-backups", { create: true });
  const dir = await base.getDirectoryHandle(vaultId.replace(/[^\w.-]/g, "_"), { create: true });
  return {
    kind: "opfs",
    label: "Browser storage on this device",
    list: () => listDir(dir),
    async create(name) {
      const handle = await dir.getFileHandle(name, { create: true });
      if (typeof (handle as { createWritable?: unknown }).createWritable !== "function") {
        await dir.removeEntry(name).catch(() => {});
        throw new Error("This browser cannot write files to its private storage (it needs Safari 26 or a recent Chrome or Firefox). Choose a backup folder instead, or download a backup.");
      }
      return writableSink(await handle.createWritable());
    },
    async read(name) {
      return (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
    },
    remove: (name) => dir.removeEntry(name),
  };
}

const HANDLE_KEY = (vaultId: string) => `backup-folder:${vaultId}`;

export async function savedFolder(vaultId: string): Promise<FileSystemDirectoryHandle | null> {
  return ((await idb.get<FileSystemDirectoryHandle>("handles", HANDLE_KEY(vaultId)).catch(() => undefined)) ?? null) as FileSystemDirectoryHandle | null;
}

export async function pickFolder(vaultId: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: "openmarkdown-backups", mode: "readwrite", startIn: "documents" });
    await idb.set("handles", HANDLE_KEY(vaultId), handle);
    return handle;
  } catch {
    return null;
  }
}

/** Whether the folder is writable now; asks for permission only when `interactive` (needs a click). */
export async function folderPermission(handle: FileSystemDirectoryHandle, interactive: boolean): Promise<boolean> {
  const h = handle as unknown as { queryPermission?(o: object): Promise<string>; requestPermission?(o: object): Promise<string> };
  const q = (await h.queryPermission?.({ mode: "readwrite" })) ?? "granted";
  if (q === "granted") return true;
  if (!interactive) return false;
  return ((await h.requestPermission?.({ mode: "readwrite" })) ?? "denied") === "granted";
}

export function folderStore(dir: FileSystemDirectoryHandle): BackupStore {
  return {
    kind: "folder",
    label: `Folder “${dir.name}”`,
    list: () => listDir(dir),
    async create(name) {
      const handle = await dir.getFileHandle(name, { create: true });
      return writableSink(await handle.createWritable());
    },
    async read(name) {
      return (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
    },
    remove: (name) => dir.removeEntry(name),
  };
}

/** Glob list "a, *.tmp, folder/sub" → a matcher. A bare name matches any path segment. */
export function excludeMatcher(patterns: string): (path: string) => boolean {
  const rules = patterns
    .split(/[,\n]/)
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .map((p) => {
      const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*")}$`);
      return p.includes("/") ? (path: string) => re.test(path) || path.startsWith(`${p}/`) : (path: string) => path.split("/").some((seg) => re.test(seg));
    });
  return (path) => rules.some((r) => r(path));
}
