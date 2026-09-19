/**
 * File recovery: periodic snapshots of Markdown and Canvas files, kept in
 * IndexedDB (not in the vault) for a number of days, with a modal to browse,
 * compare and restore them.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { ConfirmationModal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { TFile, type TAbstractFile } from "../../obsidian/vault/files";
import { FileRecoveryModal } from "./modal";
import { SnapshotStore } from "./store";

const ID = "file-recovery";
const EXTENSIONS = new Set(["md", "canvas"]);
/** Files larger than this are not snapshotted. */
const MAX_SNAPSHOT_CHARS = 5 * 1024 * 1024;

class FileRecoveryPlugin extends Plugin {
  instance!: any;
  store!: SnapshotStore;
  /** Content last seen per path, so the version before a change can be kept. */
  private lastKnown = new Map<string, string>();
  private pending = new Map<string, Promise<void>>();

  get intervalMs(): number {
    const n = Number(this.instance.options.intervalMinutes);
    return (Number.isFinite(n) && n >= 0 ? n : 5) * 60_000;
  }

  get keepDays(): number {
    const n = Number(this.instance.options.keepDays);
    return Number.isFinite(n) && n > 0 ? n : 7;
  }

  override async onload() {
    this.store = new SnapshotStore(this.app.appId);

    this.addCommand({ id: `${ID}:open`, name: "Open local history", callback: () => this.openModal(this.app.workspace.getActiveFile()) });

    this.instance.openModal = (file?: TFile | null) => this.openModal(file ?? null);
    this.instance.getSnapshots = (path: string) => this.store.load().then(() => this.store.list(path));
    this.instance.forceAdd = (path: string, data: string) => this.snapshotNow(path, data);

    // Data safety snapshots both sides before any automatic merge, conflict
    // resolution, restore or delete, regardless of the snapshot interval, so
    // each of those can be undone from here.
    const hook = async (path: string, data: string) => {
      const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      if (!EXTENSIONS.has(ext) || data.length > MAX_SNAPSHOT_CHARS) return;
      await this.snapshotNow(path, data);
    };
    const hooks = (this.app.vault as { snapshotHooks?: Set<typeof hook> }).snapshotHooks;
    hooks?.add(hook);
    this.register(() => hooks?.delete(hook));

    this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => this.onModify(file)));
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (!(file instanceof TFile)) return;
        const known = this.lastKnown.get(oldPath);
        this.lastKnown.delete(oldPath);
        if (known !== undefined) this.lastKnown.set(file.path, known);
        void this.store.load().then(() => this.store.rename(oldPath, file.path)).catch((e) => console.error(e));
      }),
    );
    this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => this.lastKnown.delete(file.path)));
    this.registerEvent(this.app.workspace.on("file-open", (file: TFile | null) => void this.remember(file)));
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: any, file: TAbstractFile) => {
        if (!(file instanceof TFile) || !EXTENSIONS.has(file.extension)) return;
        menu.addItem((item: any) =>
          item
            .setSection("info")
            .setTitle("Open local history")
            .setIcon("lucide-history")
            .onClick(() => this.openModal(file)),
        );
      }),
    );

    void this.store
      .load()
      .then(() => this.store.prune(this.keepDays))
      .catch((e) => console.error("File recovery: could not open snapshot storage", e));
    this.registerInterval(window.setInterval(() => void this.store.prune(this.keepDays).catch(() => {}), 60 * 60_000));
    this.app.workspace.onLayoutReady(() => void this.remember(this.app.workspace.getActiveFile()));

    this.addSettingTab(new FileRecoverySettingTab(this.app, this));
  }

  private async remember(file: TFile | null) {
    if (!file || !EXTENSIONS.has(file.extension) || this.lastKnown.has(file.path)) return;
    try {
      const data = await this.app.vault.cachedRead(file);
      if (data.length <= MAX_SNAPSHOT_CHARS && !this.lastKnown.has(file.path)) this.lastKnown.set(file.path, data);
    } catch {
      /* file vanished */
    }
  }

  private onModify(file: TAbstractFile) {
    if (!(file instanceof TFile) || !EXTENSIONS.has(file.extension)) return;
    // Serialise per path so two quick modifies do not race on "latest".
    const prev = this.pending.get(file.path) ?? Promise.resolve();
    const next = prev
      .then(() => this.handleModify(file))
      .catch((e) => console.error("File recovery: snapshot failed", e))
      .finally(() => {
        if (this.pending.get(file.path) === next) this.pending.delete(file.path);
      });
    this.pending.set(file.path, next);
  }

  private async handleModify(file: TFile) {
    if (file.deleted) return;
    await this.store.load();
    const path = file.path;
    const data = await this.app.vault.cachedRead(file);
    const before = this.lastKnown.get(path);
    this.lastKnown.set(path, data);
    if (data.length > MAX_SNAPSHOT_CHARS) return;
    const now = Date.now();
    const latestTs = this.store.latestTs(path);
    if (latestTs !== null && now - latestTs < this.intervalMs) return;
    const latest = latestTs === null ? null : await this.store.latest(path);
    // Keep the version from before this change when no snapshot holds it yet.
    if (before !== undefined && before !== data && before !== latest?.data) await this.store.add(path, before, now - 1);
    if (data !== latest?.data) await this.store.add(path, data, now);
  }

  async snapshotNow(path: string, data: string) {
    await this.store.load();
    const latest = await this.store.latest(path);
    if (latest?.data === data) return;
    // An older snapshot may already hold this text; keeping it again as the newest is still useful.
    await this.store.add(path, data);
  }

  openModal(file: TFile | null) {
    new FileRecoveryModal({ app: this.app, store: this.store, snapshotNow: (p, d) => this.snapshotNow(p, d) }, file?.path ?? null).open();
  }

  async clearHistory() {
    await this.store.clear();
    new Notice("Local history cleared.");
  }
}

class FileRecoverySettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private recovery: FileRecoveryPlugin,
  ) {
    super(app, recovery);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const options = this.recovery.instance.options;
    const numberSetting = (name: string, desc: string, key: "intervalMinutes" | "keepDays", min: number) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.inputEl.type = "number";
          t.inputEl.min = String(min);
          t.setValue(String(options[key])).onChange(async (v) => {
            const n = Number(v);
            if (v.trim() === "" || !Number.isFinite(n) || n < min) return;
            options[key] = n;
            await this.recovery.instance.saveOptions();
          });
        });
    numberSetting("Snapshot interval", "Minimum number of minutes between two snapshots of the same file.", "intervalMinutes", 0);
    numberSetting("History length", "Number of days to keep snapshots. Older snapshots are deleted.", "keepDays", 1);
    new Setting(containerEl)
      .setName("Snapshots")
      .setDesc("View and restore snapshots of your notes.")
      .addButton((b) => b.setButtonText("View").onClick(() => this.recovery.openModal(null)));
    new Setting(containerEl)
      .setName("Clear history")
      .setDesc("Delete all snapshots of this vault kept on this device.")
      .addButton((b) =>
        b
          .setButtonText("Clear")
          .setWarning()
          .onClick(() => {
            const modal = new ConfirmationModal(this.app);
            modal.setTitle("Clear history");
            modal.setContent("Delete every snapshot of this vault from local history? This cannot be undone.");
            modal.addButton((btn) => btn.setButtonText("Clear").setWarning().onClick(() => this.recovery.clearHistory()));
            modal.addCancelButton();
            modal.open();
          }),
      );
  }
}

export const fileRecovery: CorePluginDefinition = {
  id: ID,
  name: "File recovery",
  description: "Restore recent snapshots of your notes",
  icon: "lucide-history",
  defaultOn: true,
  defaultOptions: { intervalMinutes: 5, keepDays: 7 },
  create: (app) => new FileRecoveryPlugin(app, { id: ID, name: "File recovery", version: "", minAppVersion: "", author: "", description: "Restore recent snapshots of your notes" }),
};
