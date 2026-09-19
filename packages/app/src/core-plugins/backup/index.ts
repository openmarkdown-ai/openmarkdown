/**
 * Core plugin Backups (`backup`): zip snapshots of the whole vault, on a
 * schedule or on demand, into browser storage (OPFS) or a folder the user
 * picks, with retention, and restore of a whole snapshot or single files.
 *
 * Only one tab backs up at a time (Web Locks). A snapshot is streamed file by
 * file, so large vaults do not need to fit in memory.
 */
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { ButtonComponent, SearchComponent, Setting } from "../../obsidian/ui/setting";
import { normalizePath } from "../../obsidian/util";
import { confirmModal, promptModal } from "../../settings/helpers";
import { readZip } from "../../settings/zip";
import { downloadBlob } from "../publish/zip";
import { formatBytes, isAbort, ProgressModal } from "../ai-tools/ui";
import {
  type BackupStore,
  excludeMatcher,
  folderPermission,
  folderStore,
  hasFolderPicker,
  hasOpfs,
  opfsStore,
  pickFolder,
  savedFolder,
  type SnapshotInfo,
  snapshotName,
  snapshotsToDelete,
} from "./store";
import { ZipWriter } from "./zip-writer";

export interface BackupOptions {
  destination: "opfs" | "folder";
  intervalMinutes: number;
  backupOnOpen: boolean;
  keepLast: number;
  keepDaily: number;
  keepWeekly: number;
  exclude: string;
}

const LAST_KEY = "backup-last";

export interface BackupResult {
  name: string;
  size: number;
  files: number;
}

export class BackupPlugin extends Plugin {
  instance!: any;
  private running: AbortController | null = null;
  private statusEl: HTMLElement | null = null;
  private permissionNoticeShown = false;

  get options(): BackupOptions {
    return this.instance.options as BackupOptions;
  }

  override async onload() {
    this.addCommand({ id: "backup:create-now", name: "Back up vault now", icon: "lucide-archive", callback: () => void this.backupWithUi() });
    this.addCommand({
      id: "backup:create-named",
      name: "Create named backup (kept forever)",
      icon: "lucide-archive-restore",
      callback: async () => {
        const label = await promptModal(this.app, { title: "Name this backup", placeholder: "Before reorganising", cta: "Back up" });
        if (label) await this.backupWithUi(label);
      },
    });
    this.addCommand({ id: "backup:restore", name: "Restore from backup…", icon: "lucide-history", callback: () => void this.openRestore() });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("vault-backup-status", "mod-clickable");
    this.statusEl.hide();
    this.statusEl.addEventListener("click", () => this.running?.abort());

    this.app.workspace.onLayoutReady(() => {
      if (this.options.backupOnOpen) void this.scheduledBackup(true);
    });
    this.registerInterval(window.setInterval(() => void this.scheduledBackup(false), 60_000));
    this.addSettingTab(new BackupSettingTab(this.app, this));
  }

  override onunload() {
    this.running?.abort();
  }

  lastBackupAt(): number {
    return Number(this.app.loadLocalStorage(LAST_KEY) ?? 0);
  }

  async store(interactive: boolean): Promise<BackupStore | null> {
    if (this.options.destination === "folder") {
      const handle = await savedFolder(this.app.appId);
      if (!handle) {
        if (interactive) new Notice("Choose a backup folder in Settings → Backups first.");
        return null;
      }
      if (!(await folderPermission(handle, interactive))) {
        if (!interactive && !this.permissionNoticeShown) {
          this.permissionNoticeShown = true;
          new Notice(`Scheduled backups are paused: the browser needs permission again for the folder “${handle.name}”. Run “Back up vault now” to allow it.`, 10000);
        }
        return null;
      }
      return folderStore(handle);
    }
    if (!hasOpfs()) {
      if (interactive) new Notice("This browser has no private file storage (OPFS) for backups.");
      return null;
    }
    return opfsStore(this.app.appId);
  }

  private async scheduledBackup(onOpen: boolean) {
    const o = this.options;
    if (this.running) return;
    if (!onOpen && (!o.intervalMinutes || Date.now() - this.lastBackupAt() < o.intervalMinutes * 60_000)) return;
    try {
      await this.backup({ interactive: false });
    } catch (e) {
      if (!isAbort(e)) new Notice(`Scheduled backup failed: ${(e as Error).message}`, 10000);
    }
  }

  async backupWithUi(label?: string): Promise<BackupResult | null> {
    if (this.running) {
      new Notice("A backup is already running.");
      return null;
    }
    const modal = new ProgressModal(this.app, label ? `Backing up “${label}”` : "Backing up the vault");
    modal.open();
    try {
      const result = await this.backup({ interactive: true, label, signal: modal.signal, onProgress: (p, s, d) => modal.setProgress(p, s, d) });
      if (!result) {
        modal.done = true;
        modal.close();
        return null;
      }
      modal.finish(`Saved ${result.name} (${result.files.toLocaleString()} files, ${formatBytes(result.size)}).`);
      return result;
    } catch (e) {
      modal.done = true;
      modal.close();
      if (isAbort(e)) new Notice("Backup cancelled.");
      else new Notice(`Backup failed: ${(e as Error).message}`, 10000);
      return null;
    }
  }

  /** Runs one backup under a Web Lock. Resolves null when another tab holds the lock or no store is usable. */
  async backup(opts: { interactive: boolean; label?: string; signal?: AbortSignal; onProgress?: (fraction: number | null, status: string, detail?: string) => void }): Promise<BackupResult | null> {
    const locks = (navigator as { locks?: LockManager }).locks;
    const run = async (): Promise<BackupResult | null> => {
      const store = await this.store(opts.interactive);
      if (!store) return null;
      const controller = new AbortController();
      opts.signal?.addEventListener("abort", () => controller.abort());
      this.running = controller;
      try {
        return await this.writeSnapshot(store, controller.signal, opts);
      } finally {
        this.running = null;
        this.statusEl?.hide();
      }
    };
    if (!locks) return run();
    return locks.request(`openmarkdown-backup:${this.app.appId}`, { ifAvailable: true }, async (lock) => {
      if (!lock) {
        if (opts.interactive) new Notice("Another tab is backing up this vault right now.");
        return null;
      }
      return run();
    });
  }

  private async vaultFiles(): Promise<{ path: string; size: number; mtime: number }[]> {
    const adapter = this.app.vault.adapter;
    const skip = excludeMatcher(this.options.exclude);
    let entries: { path: string; type: string; size?: number; mtime?: number }[] = [];
    if (typeof adapter.scan === "function") entries = await adapter.scan();
    else {
      const walk = async (dir: string) => {
        const { files, folders } = await adapter.list(dir);
        for (const f of files) {
          const st = await adapter.stat(f);
          entries.push({ path: f, type: "file", size: st?.size ?? 0, mtime: st?.mtime ?? 0 });
        }
        for (const d of folders) await walk(d);
      };
      await walk("");
    }
    return entries
      .filter((e) => e.type === "file" && !skip(e.path))
      .map((e) => ({ path: normalizePath(e.path), size: e.size ?? 0, mtime: e.mtime ?? 0 }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private async writeSnapshot(store: BackupStore, signal: AbortSignal, opts: { label?: string; onProgress?: (fraction: number | null, status: string, detail?: string) => void; interactive: boolean }): Promise<BackupResult> {
    const files = await this.vaultFiles();
    const total = files.reduce((n, f) => n + f.size, 0) || 1;
    const now = Date.now();
    const name = snapshotName(this.app.vault.getName(), now, opts.label);
    const sink = await store.create(name);
    const zip = new ZipWriter(sink);
    let done = 0;
    const progress = (status: string, detail?: string) => {
      const fraction = done / total;
      opts.onProgress?.(fraction, status, detail);
      if (!opts.interactive && this.statusEl) {
        this.statusEl.setText(`Backing up… ${Math.round(fraction * 100)}%`);
        this.statusEl.setAttr("aria-label", "Cancel backup");
        this.statusEl.show();
      }
    };
    try {
      progress(`Reading ${files.length.toLocaleString()} files…`);
      for (const [i, f] of files.entries()) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        let data: ArrayBuffer;
        try {
          data = await this.app.vault.adapter.readBinary(f.path);
        } catch {
          continue; // deleted while backing up
        }
        await zip.add(f.path, new Uint8Array(data), new Date(f.mtime || now));
        done += f.size;
        if (i % 10 === 0 || i === files.length - 1) progress(`${i + 1} of ${files.length} files`, `${formatBytes(done)} of ${formatBytes(total)} · ${f.path}`);
      }
      const size = await zip.finish();
      this.app.saveLocalStorage(LAST_KEY, now);
      await this.applyRetention(store);
      return { name, size, files: files.length };
    } catch (e) {
      await sink.abort().catch(() => {});
      await store.remove(name).catch(() => {});
      throw e;
    }
  }

  async applyRetention(store: BackupStore): Promise<SnapshotInfo[]> {
    const o = this.options;
    const doomed = snapshotsToDelete(await store.list(), { keepLast: o.keepLast, keepDaily: o.keepDaily, keepWeekly: o.keepWeekly });
    for (const s of doomed) await store.remove(s.name).catch(() => {});
    return doomed;
  }

  async openRestore(snapshot?: string) {
    const store = await this.store(true);
    if (!store) return;
    new RestoreModal(this.app, this, store, snapshot).open();
  }

  /** Writes files from a snapshot into the vault. Existing files are overwritten; others are left alone. */
  async restoreFiles(entries: { path: string; read(): Promise<Uint8Array> }[], onProgress?: (i: number, path: string) => void): Promise<number> {
    const vault = this.app.vault;
    let n = 0;
    for (const [i, entry] of entries.entries()) {
      const path = normalizePath(entry.path);
      const data = await entry.read();
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      onProgress?.(i, path);
      const existing = vault.getFileByPath(path);
      if (existing) await vault.modifyBinary(existing, buf);
      else if (path.startsWith(`${vault.configDir}/`) || path.split("/").some((s) => s.startsWith("."))) {
        const parent = path.slice(0, path.lastIndexOf("/"));
        if (parent) await vault.adapter.mkdir(parent);
        await vault.adapter.writeBinary(path, buf);
      } else {
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (parent && !vault.getFolderByPath(parent)) await vault.createFolder(parent).catch(() => {});
        await vault.createBinary(path, buf);
      }
      n++;
    }
    return n;
  }
}

class RestoreModal extends Modal {
  constructor(
    app: any,
    private plugin: BackupPlugin,
    private store: BackupStore,
    private initial?: string,
  ) {
    super(app);
    this.modalEl.addClass("vault-backup-restore");
  }

  override async onOpen() {
    if (this.initial) await this.showSnapshot(this.initial);
    else await this.showList();
  }

  private async showList() {
    this.setTitle("Restore from backup");
    const el = this.contentEl;
    el.empty();
    const snapshots = await this.store.list();
    el.createDiv({ cls: "setting-item-description", text: `${this.store.label}. Pick a snapshot to see its files.` });
    if (!snapshots.length) {
      el.createDiv({ cls: "pane-empty", text: "No backups yet." });
      return;
    }
    const list = el.createDiv({ cls: "vault-backup-list" });
    for (const s of snapshots) {
      const row = list.createDiv({ cls: "vault-backup-item tappable", attr: { tabindex: "0", "data-name": s.name } });
      row.createDiv({ cls: "vault-backup-item-title", text: new Date(s.time).toLocaleString() + (s.label ? ` · ${s.label}` : "") });
      row.createDiv({ cls: "vault-backup-item-meta", text: `${s.name} · ${formatBytes(s.size)}` });
      row.addEventListener("click", () => void this.showSnapshot(s.name));
    }
  }

  private async showSnapshot(name: string) {
    const el = this.contentEl;
    el.empty();
    this.setTitle("Restore from backup");
    el.createDiv({ cls: "setting-item-description", text: "Loading…" });
    let entries: Awaited<ReturnType<typeof readZip>>;
    try {
      entries = await readZip(await this.store.read(name));
    } catch (e) {
      el.empty();
      el.createDiv({ cls: "mod-warning", text: `Could not read ${name}: ${(e as Error).message}` });
      return;
    }
    el.empty();
    const head = el.createDiv({ cls: "vault-backup-restore-head" });
    new ButtonComponent(head).setIcon("lucide-arrow-left").setTooltip("All backups").onClick(() => void this.showList());
    head.createDiv({ cls: "vault-backup-restore-name", text: `${name} · ${entries.length.toLocaleString()} files` });
    let query = "";
    const search = new SearchComponent(el).setPlaceholder("Filter files…");
    const list = el.createDiv({ cls: "vault-backup-files" });
    const render = () => {
      list.empty();
      const shown = entries.filter((e) => e.path.toLowerCase().includes(query.toLowerCase())).slice(0, 300);
      for (const entry of shown) {
        const row = list.createDiv({ cls: "vault-backup-file", attr: { "data-path": entry.path } });
        row.createSpan({ cls: "vault-backup-file-path", text: entry.path });
        const state = row.createSpan({ cls: "vault-backup-file-state" });
        // The adapter also sees the config folder, which the vault's file tree does not list.
        void fileState(this.app.vault.adapter, entry).then((st) => {
          state.setText(st);
          state.toggleClass("mod-warning", st !== "unchanged");
        });
        new ButtonComponent(row).setButtonText("Restore").onClick(async () => {
          await this.plugin.restoreFiles([entry]);
          new Notice(`Restored ${entry.path}.`);
          render();
        });
      }
      if (entries.length > shown.length && !query) list.createDiv({ cls: "setting-item-description", text: `Showing ${shown.length} of ${entries.length}. Filter to find a file.` });
    };
    search.onChange((v) => {
      query = v;
      render();
    });
    render();
    const buttons = this.modalEl.querySelector(".modal-button-container") ?? this.modalEl.createDiv({ cls: "modal-button-container" });
    (buttons as HTMLElement).empty();
    new ButtonComponent(buttons as HTMLElement).setButtonText("Download .zip").onClick(async () => downloadBlob(new Blob([await this.store.read(name)], { type: "application/zip" }), name));
    new ButtonComponent(buttons as HTMLElement)
      .setButtonText("Restore all files")
      .setWarning()
      .onClick(async () => {
        const ok = await confirmModal(this.app, {
          title: "Restore the whole snapshot?",
          message: `${entries.length.toLocaleString()} files are written back into the vault, overwriting the current versions. Files that are not in the snapshot are kept. A backup of the vault as it is now is made first.`,
          cta: "Restore all",
          warning: true,
        });
        if (!ok) return;
        const safety = await this.plugin.backupWithUi("before restore");
        if (!safety) {
          new Notice("Restore cancelled: the safety backup did not complete.");
          return;
        }
        const progress = new ProgressModal(this.app, "Restoring files");
        progress.open();
        try {
          const n = await this.plugin.restoreFiles(entries, (i, path) => {
            if (progress.signal.aborted) throw new DOMException("Cancelled", "AbortError");
            progress.setProgress(i / entries.length, `${i + 1} of ${entries.length}`, path);
          });
          progress.finish(`Restored ${n.toLocaleString()} files.`);
          this.close();
        } catch (e) {
          progress.done = true;
          progress.close();
          new Notice(isAbort(e) ? "Restore stopped part-way; files already written stay restored." : `Restore failed: ${(e as Error).message}`, 10000);
        }
      });
  }
}

class BackupSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: BackupPlugin,
  ) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.owner.options;
    const save = () => void this.owner.instance.saveOptions();

    const last = this.owner.lastBackupAt();
    new Setting(containerEl)
      .setName("Back up now")
      .setDesc(last ? `Last backup: ${new Date(last).toLocaleString()}.` : "No backup yet on this device.")
      .addButton((b) =>
        b.setButtonText("Back up now").setCta().onClick(async () => {
          await this.owner.backupWithUi();
          this.display();
        }),
      );

    new Setting(containerEl).setName("Where").setHeading();
    new Setting(containerEl)
      .setName("Backup location")
      .setDesc(o.destination === "opfs" ? "Private browser storage for this site. Clearing site data deletes these backups too; download important ones." : "A folder on this computer, outside the browser.")
      .addDropdown((d) => {
        d.addOption("opfs", "Browser storage");
        if (hasFolderPicker()) d.addOption("folder", "A folder on this computer");
        d.setValue(o.destination === "folder" && !hasFolderPicker() ? "opfs" : o.destination).onChange((v) => {
          o.destination = v as BackupOptions["destination"];
          save();
          this.display();
        });
      });
    if (!hasFolderPicker()) containerEl.createDiv({ cls: "setting-item-description vault-device-support", text: "This browser cannot write to a folder you choose (File System Access API); backups stay in browser storage." });
    if (o.destination === "folder" && hasFolderPicker()) {
      const folder = new Setting(containerEl).setName("Backup folder").setDesc("Checking…");
      void savedFolder(this.app.appId).then((h) => folder.setDesc(h ? `“${h.name}”` : "None chosen."));
      folder.addButton((b) =>
        b.setButtonText("Choose folder…").onClick(async () => {
          if (await pickFolder(this.app.appId)) this.display();
        }),
      );
    }

    new Setting(containerEl).setName("When").setHeading();
    new Setting(containerEl)
      .setName("Back up every")
      .setDesc("Minutes between automatic backups while the app is open. 0 turns scheduled backups off.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = "0";
        t.setValue(String(o.intervalMinutes)).onChange((v) => {
          const n = Math.max(0, Math.floor(Number(v)));
          if (Number.isFinite(n)) ((o.intervalMinutes = n), save());
        });
      });
    new Setting(containerEl).setName("Back up when the vault opens").addToggle((t) => t.setValue(o.backupOnOpen).onChange((v) => ((o.backupOnOpen = v), save())));

    new Setting(containerEl).setName("Keep").setHeading();
    const num = (name: string, desc: string, key: "keepLast" | "keepDaily" | "keepWeekly") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.inputEl.type = "number";
          t.inputEl.min = "0";
          t.setValue(String(o[key])).onChange((v) => {
            const n = Math.max(0, Math.floor(Number(v)));
            if (Number.isFinite(n)) ((o[key] = n), save());
          });
        });
    num("Latest backups", "How many of the most recent backups to keep.", "keepLast");
    num("Daily backups", "Also keep the last backup of each of this many days.", "keepDaily");
    num("Weekly backups", "Also keep the last backup of each of this many weeks. Named backups are never deleted.", "keepWeekly");
    new Setting(containerEl)
      .setName("Exclude")
      .setDesc("Comma-separated names or globs that are not backed up, e.g. .git, .trash, *.mp4")
      .addText((t) => t.setValue(o.exclude).onChange((v) => ((o.exclude = v), save())));

    new Setting(containerEl).setName("Backups").setHeading();
    const listEl = containerEl.createDiv({ cls: "vault-backup-settings-list" });
    void (async () => {
      const store = await this.owner.store(false).catch(() => null);
      if (!store) {
        listEl.createDiv({ cls: "setting-item-description", text: o.destination === "folder" ? "Choose a folder (and allow access) to see its backups." : "Browser storage is unavailable." });
        return;
      }
      const snapshots = await store.list().catch(() => [] as SnapshotInfo[]);
      if (!snapshots.length) listEl.createDiv({ cls: "setting-item-description", text: "No backups yet." });
      for (const s of snapshots) {
        const row = new Setting(listEl).setName(new Date(s.time).toLocaleString() + (s.label ? ` · ${s.label}` : "")).setDesc(`${s.name} · ${formatBytes(s.size)}`);
        row.settingEl.addClass("vault-backup-row");
        row.addButton((b) => b.setButtonText("Restore…").onClick(() => void this.owner.openRestore(s.name)));
        row.addExtraButton((b) => b.setIcon("lucide-download").setTooltip("Download").onClick(async () => downloadBlob(new Blob([await store.read(s.name)], { type: "application/zip" }), s.name)));
        row.addExtraButton((b) =>
          b
            .setIcon("lucide-trash-2")
            .setTooltip("Delete")
            .onClick(async () => {
              if (!(await confirmModal(this.app, { title: "Delete backup?", message: `Delete ${s.name}? This cannot be undone.`, cta: "Delete", warning: true }))) return;
              await store.remove(s.name);
              this.display();
            }),
        );
      }
      if (store.kind === "opfs" && navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        listEl.createDiv({ cls: "setting-item-description", text: `This site uses ${formatBytes(est.usage ?? 0)} of ${formatBytes(est.quota ?? 0)} available browser storage.` });
      }
    })();
  }
}

/** How the file in the vault compares with its copy in a backup. */
async function fileState(adapter: any, entry: { path: string; read(): Promise<Uint8Array> }): Promise<"missing" | "changed" | "unchanged"> {
  try {
    if (!(await adapter.exists(entry.path))) return "missing";
    const [current, saved] = await Promise.all([adapter.readBinary(entry.path) as Promise<ArrayBuffer>, entry.read()]);
    const a = new Uint8Array(current);
    if (a.length !== saved.length) return "changed";
    for (let i = 0; i < a.length; i++) if (a[i] !== saved[i]) return "changed";
    return "unchanged";
  } catch {
    return "changed";
  }
}
