/**
 * Opening files from the operating system (manifest `file_handlers`, Chromium
 * desktop): double-clicking a `.md`, `.canvas` or `.base` file launches the
 * app with the file's handle in `window.launchQueue`.
 *
 * - The file lies inside a known folder vault that still has permission: that
 *   vault opens (or, in a running window of that vault, a new tab) on the file.
 * - Otherwise it opens in **single-file mode**: a vault held in memory with just
 *   the launched files, whose edits are written back to the files' handles.
 *
 * `launch_handler: focus-existing` sends later launches to the open window's
 * consumer. A file that belongs somewhere else is handed to a new window
 * through IndexedDB (`?launch=<id>`), which also lets a reload of a
 * single-file window reopen the same files.
 */
import type { App } from "../obsidian/app";
import { Notice } from "../obsidian/ui/notice";
import { normalizePath } from "../obsidian/util";
import { MemoryAdapter } from "../obsidian/vault/adapter";
import { newPwaId, pwaStore } from "./store";

type Handle = FileSystemFileHandle & {
  queryPermission?(o: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};

let handler: ((files: FileSystemFileHandle[]) => void) | null = null;
const pending: FileSystemFileHandle[][] = [];
const waiters: ((files: FileSystemFileHandle[]) => void)[] = [];

export const supportsLaunchQueue = typeof window !== "undefined" && "launchQueue" in window;

/** Call at boot, before anything awaits: launches queue up until a consumer is set. */
export function installLaunchQueue() {
  const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemHandle[]; targetURL?: string }) => void): void } }).launchQueue;
  if (!lq?.setConsumer) return;
  lq.setConsumer((params) => deliverLaunch(params.files ?? []));
}

/** Also the entry point tests use to simulate a launch. */
export function deliverLaunch(handles: FileSystemHandle[]) {
  const files = handles.filter((h): h is FileSystemFileHandle => h.kind === "file");
  if (!files.length) return;
  const waiter = waiters.shift();
  if (waiter) waiter(files);
  else if (handler) handler(files);
  else pending.push(files);
}

/** Waits for the launch that started this window (URL `?launch=file`). */
export function waitForLaunchFiles(timeout: number): Promise<FileSystemFileHandle[] | null> {
  const queued = pending.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve) => {
    const done = (files: FileSystemFileHandle[] | null) => {
      clearTimeout(timer);
      const i = waiters.indexOf(onFiles);
      if (i !== -1) waiters.splice(i, 1);
      resolve(files);
    };
    const onFiles = (files: FileSystemFileHandle[]) => done(files);
    const timer = setTimeout(() => done(null), timeout);
    waiters.push(onFiles);
  });
}

export function setLaunchHandler(fn: (files: FileSystemFileHandle[]) => void) {
  handler = fn;
  for (const files of pending.splice(0)) fn(files);
}

export async function rememberLaunch(handles: FileSystemFileHandle[]): Promise<string> {
  const id = newPwaId();
  await pwaStore.putLaunch({ id, handles, createdAt: Date.now() });
  return id;
}

export async function recallLaunch(id: string): Promise<FileSystemFileHandle[] | null> {
  try {
    return (await pwaStore.getLaunch(id))?.handles ?? null;
  } catch {
    return null;
  }
}

interface FolderVaultLike {
  id: string;
  name: string;
  kind: string;
  handle?: FileSystemDirectoryHandle;
}

/** The folder vault that contains every launched file, with the files' vault paths. */
export async function findContainingVault<V extends FolderVaultLike>(vaults: V[], handles: FileSystemFileHandle[]): Promise<{ vault: V; paths: string[]; granted: boolean } | null> {
  for (const v of vaults) {
    if (v.kind !== "folder" || !v.handle) continue;
    const paths: string[] = [];
    for (const h of handles) {
      const segs = await v.handle.resolve(h).catch(() => null);
      if (!segs) break;
      paths.push(normalizePath(segs.join("/")));
    }
    if (paths.length !== handles.length) continue;
    const state = await (v.handle as unknown as Handle).queryPermission?.({ mode: "readwrite" }).catch(() => "prompt" as PermissionState);
    return { vault: v, paths, granted: state === "granted" };
  }
  return null;
}

const OPEN_KEY = "openmarkdown-launch-open";

/** Files to open once the vault this window is opening is ready. */
export function setPendingOpen(vaultId: string, paths: string[]) {
  try {
    sessionStorage.setItem(OPEN_KEY, JSON.stringify({ vaultId, paths }));
  } catch {
    /* storage unavailable */
  }
}

export function takePendingOpen(vaultId: string): string[] {
  try {
    const raw = sessionStorage.getItem(OPEN_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as { vaultId: string; paths: string[] };
    if (data.vaultId !== vaultId) return [];
    sessionStorage.removeItem(OPEN_KEY);
    return data.paths;
  } catch {
    return [];
  }
}

async function ensureWritable(handle: Handle, interactive: boolean): Promise<boolean> {
  const state = await handle.queryPermission?.({ mode: "readwrite" }).catch(() => undefined);
  if (state === "granted" || state === undefined) return true;
  if (!interactive) return false;
  try {
    return (await handle.requestPermission?.({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

async function writeHandle(handle: FileSystemFileHandle, data: ArrayBuffer) {
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}

/** A memory vault whose files are the launched files; writes go back to disk. */
export class LaunchedFilesAdapter extends MemoryAdapter {
  private handles = new Map<string, Handle>();
  private permissionNotice: Notice | null = null;

  constructor(vaultId: string, name: string, files: { path: string; handle: FileSystemFileHandle; data: ArrayBuffer }[]) {
    super(vaultId, name, Object.fromEntries(files.map((f) => [f.path, f.data])));
    for (const f of files) this.handles.set(f.path, f.handle as Handle);
  }

  // internal
  launchedPaths(): string[] {
    return Array.from(this.handles.keys());
  }

  override async writeBinary(path: string, data: ArrayBuffer, o?: Parameters<MemoryAdapter["writeBinary"]>[2]) {
    await super.writeBinary(path, data, o);
    const handle = this.handles.get(normalizePath(path));
    if (!handle) return;
    let ok = false;
    try {
      ok = await ensureWritable(handle, true);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.askForPermission(normalizePath(path));
      throw new DOMException(`Saving to ${handle.name} needs permission.`, "NotAllowedError");
    }
    await writeHandle(handle, data);
  }

  override async rename(from: string, to: string) {
    await super.rename(from, to);
    const h = this.handles.get(normalizePath(from));
    if (h) {
      this.handles.delete(normalizePath(from));
      // The file on disk keeps its name; the tab stops writing to it.
      new Notice(`“${h.name}” was renamed here only. Changes to “${to}” are no longer saved to the original file.`);
    }
  }

  private askForPermission(path: string) {
    if (this.permissionNotice && !this.permissionNotice.isHidden) return;
    const frag = document.createDocumentFragment();
    frag.createSpan({ text: `To save changes to ${path.split("/").pop()}, allow editing the file. ` });
    const btn = frag.createEl("button", { cls: "mod-cta", text: "Allow saving" });
    const notice = new Notice(frag, 0);
    this.permissionNotice = notice;
    btn.addEventListener("click", async (evt) => {
      evt.stopPropagation();
      const handle = this.handles.get(path);
      if (!handle) return notice.hide();
      if (await ensureWritable(handle, true)) {
        notice.hide();
        try {
          await writeHandle(handle, await this.readBinary(path));
          new Notice(`Saved ${handle.name}.`);
        } catch (e) {
          new Notice(`Could not save ${handle.name}: ${(e as Error).message}`);
        }
      }
    });
  }
}

export async function readLaunchedFiles(handles: FileSystemFileHandle[]): Promise<{ path: string; handle: FileSystemFileHandle; data: ArrayBuffer }[]> {
  const out: { path: string; handle: FileSystemFileHandle; data: ArrayBuffer }[] = [];
  const used = new Set<string>();
  for (const handle of handles) {
    const file = await handle.getFile();
    let path = handle.name;
    for (let i = 1; used.has(path.toLowerCase()); i++) {
      const dot = handle.name.lastIndexOf(".");
      path = dot > 0 ? `${handle.name.slice(0, dot)} ${i}${handle.name.slice(dot)}` : `${handle.name} ${i}`;
    }
    used.add(path.toLowerCase());
    out.push({ path, handle, data: await file.arrayBuffer() });
  }
  return out;
}

/** A running window receives a launch (focus-existing). */
export async function openLaunchInApp(app: App, handles: FileSystemFileHandle[]) {
  const adapter = app.vault.adapter as unknown as { kind: string; root?: FileSystemDirectoryHandle };
  const elsewhere: FileSystemFileHandle[] = [];
  for (const handle of handles) {
    let path: string | null = null;
    if (adapter.kind === "folder" && adapter.root) {
      const segs = await adapter.root.resolve(handle).catch(() => null);
      if (segs) path = normalizePath(segs.join("/"));
    }
    if (!path) {
      elsewhere.push(handle);
      continue;
    }
    let file = app.vault.getFileByPath(path);
    if (!file) {
      await (app.vault as unknown as { reconcilePath?: (p: string) => Promise<void> }).reconcilePath?.(path);
      file = app.vault.getFileByPath(path);
    }
    if (file) await app.workspace.getLeaf("tab").openFile(file, { active: true });
    else elsewhere.push(handle);
  }
  if (!elsewhere.length) return;
  if (handOffToNewWindow(elsewhere)) return;
  const frag = document.createDocumentFragment();
  frag.createSpan({ text: `${elsewhere.map((h) => h.name).join(", ")} ${elsewhere.length === 1 ? "is" : "are"} not in this vault. ` });
  const btn = frag.createEl("button", { cls: "mod-cta", text: "Open in a new window" });
  const notice = new Notice(frag, 0);
  btn.addEventListener("click", (evt) => {
    evt.stopPropagation();
    handOffToNewWindow(elsewhere);
    notice.hide();
  });
}

/**
 * Opens `?launch=message` and posts the handles to it until it acknowledges.
 * (Handles cross by structured clone; the new window then keeps them in
 * IndexedDB so a reload reopens the same files.)
 */
function handOffToNewWindow(handles: FileSystemFileHandle[]): boolean {
  const url = new URL("./", location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("launch", "message");
  const win = window.open(url.toString(), "_blank");
  if (!win) return false;
  let acked = false;
  const onAck = (ev: MessageEvent) => {
    if (ev.source === win && (ev.data as { type?: string } | null)?.type === "openmarkdown-launch-ack") acked = true;
  };
  window.addEventListener("message", onAck);
  const started = Date.now();
  const timer = window.setInterval(() => {
    if (acked || win.closed || Date.now() - started > 20_000) {
      window.clearInterval(timer);
      window.removeEventListener("message", onAck);
      return;
    }
    try {
      win.postMessage({ type: "openmarkdown-launch", handles }, location.origin);
    } catch {
      /* not ready yet */
    }
  }, 250);
  return true;
}

/** The receiving side of `handOffToNewWindow`. */
export function listenForLaunchHandOff() {
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.origin !== location.origin) return;
    const data = ev.data as { type?: string; handles?: FileSystemHandle[] } | null;
    if (data?.type !== "openmarkdown-launch" || !Array.isArray(data.handles)) return;
    (ev.source as Window | null)?.postMessage({ type: "openmarkdown-launch-ack" }, location.origin);
    if (handedOff) return;
    handedOff = true;
    deliverLaunch(data.handles);
  });
}
let handedOff = false;
