/**
 * Sync — end-to-end encrypted vault sync, built in.
 *
 * A hidden core plugin with id `opensync`: always registered, dormant until
 * this vault is set up for sync *on this device*. Whether a vault syncs is
 * device state in IndexedDB, never vault config, so nothing is written to
 * `core-plugins.json` (where `sync` would mean Obsidian Sync to Obsidian).
 * The engine underneath is OpenSync; people see "Sync".
 *
 * Nothing here imports the engine. `controller.ts` and the sync screens load
 * `engine.ts` with `import()` when a vault is enrolled or a sync screen opens.
 *
 * The community plugin `opensync` is the same engine in Obsidian. It uses the
 * same command id (`opensync:sync-now`), so hotkeys carry over — and the two
 * must never sync one vault at once, or one set of files becomes two devices.
 * While the plugin is enabled here, built-in sync stays off and says why.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Events } from "../../obsidian/events";
import { Menu } from "../../obsidian/ui/menu";
import { Notice } from "../../obsidian/ui/notice";
import { setIcon } from "../../obsidian/ui/icons";
import { setTooltip } from "../../obsidian/ui/tooltip";
import { TFile, type TAbstractFile } from "../../obsidian/vault/files";
import { SYNC_IN_BUILD } from "@opensync/in-build";
import { SyncController, type SyncStatus } from "./controller";
import { ExplorerBadges } from "./explorer";
import { SyncLogView, SYNC_LOG_VIEW } from "./log-view";
import { SyncSettingTab, SYNC_TAB_ID } from "./settings-tab";
import { device as devices, forgetVault, type DeviceRecord } from "./store";
import { ago, parseConflict } from "./words";

export const SYNC_ID = "opensync";

export class SyncPlugin extends Plugin {
  instance!: any;
  controller: SyncController | null = null;
  record: DeviceRecord | null = null;
  /** Fires "change" whenever enrolment, status, conflicts or pending files change. */
  readonly changes = new Events();
  private statusEl!: HTMLElement;
  private badges: ExplorerBadges | null = null;
  private syncNowCommand: { id: string } | null = null;

  /** Memory vaults (the demo) have nothing to sync to. */
  get canSync(): boolean {
    return (this.app.vault.adapter?.kind ?? "memory") !== "memory";
  }

  get vaultId(): string {
    return this.app.appId;
  }

  /** The community plugin of the same engine is enabled for this vault and will run. */
  get pluginOwnsSync(): boolean {
    const plugins = this.app.plugins;
    if (!plugins) return false;
    if (plugins.plugins?.[SYNC_ID]) return true;
    return !!plugins.enabledPlugins?.has?.(SYNC_ID) && !!plugins.isEnabled?.();
  }

  override async onload() {
    // A build made without ../opensync has no sync: no tab, no status, no commands.
    if (!SYNC_IN_BUILD) return;
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable", "vault-sync-status");
    this.statusEl.hide();
    this.registerDomEvent(this.statusEl, "click", (evt) => this.showStatusMenu(evt));

    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.registerView(SYNC_LOG_VIEW, (leaf) => new SyncLogView(leaf, this));
    this.registerCommands();

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || !this.controller) return;
        const conflict = this.controller.conflicts.find((c) => c.copy === file.path || c.path === file.path);
        if (conflict) {
          menu.addItem((i) =>
            i.setSection("info").setTitle("Resolve sync conflict…").setIcon("lucide-git-compare").onClick(() => void this.reviewConflicts(conflict.copy)),
          );
        }
        if (this.controller.pending.has(file.path)) {
          menu.addItem((i) => i.setSection("info").setTitle("Not synced yet").setIcon("lucide-refresh-cw").setDisabled(true));
        }
      }),
    );

    this.record = (await devices.get(this.vaultId).catch(() => undefined)) ?? null;
    this.app.workspace.onLayoutReady(() => void this.startIfReady());
    const onPluginChange = () => {
      // The community plugin registers the same `opensync:sync-now` id, and
      // removing it on disable removes ours too; put ours back.
      if (this.syncNowCommand && !this.app.commands.commands[this.syncNowCommand.id]) this.app.commands.addCommand(this.syncNowCommand);
      void this.startIfReady();
    };
    this.registerEvent(this.app.plugins.on("plugin-loaded", onPluginChange));
    this.registerEvent(this.app.plugins.on("plugin-unloaded", onPluginChange));
    this.registerEvent(this.app.plugins.on("restricted-change", onPluginChange));
    this.renderStatus();
  }

  override onunload() {
    this.controller?.stop();
    this.controller = null;
    this.badges?.stop();
  }

  private registerCommands() {
    const enrolled = () => !!this.controller;
    this.syncNowCommand = this.addCommand({
      id: "opensync:sync-now",
      name: "Sync: Sync now",
      checkCallback: (checking) => {
        if (!enrolled()) return false;
        if (!checking) {
          if (this.record?.paused) new Notice("Sync is paused. Resume it to sync.");
          else void this.controller!.runNow();
        }
        return true;
      },
    });
    this.addCommand({
      id: "opensync:pause",
      name: "Sync: Pause sync",
      checkCallback: (checking) => {
        if (!enrolled() || this.record?.paused) return false;
        if (!checking) void this.controller!.setPaused(true);
        return true;
      },
    });
    this.addCommand({
      id: "opensync:resume",
      name: "Sync: Resume sync",
      checkCallback: (checking) => {
        if (!enrolled() || !this.record?.paused) return false;
        if (!checking) void this.controller!.setPaused(false);
        return true;
      },
    });
    this.addCommand({ id: "opensync:open-settings", name: "Sync: Open sync settings", callback: () => this.openSettings() });
    this.addCommand({
      id: "opensync:add-device",
      name: "Sync: Add a device…",
      checkCallback: (checking) => {
        if (!enrolled()) return false;
        if (!checking) void import("./modals").then((m) => m.openAddDevice(this));
        return true;
      },
    });
    this.addCommand({
      id: "opensync:join",
      name: "Sync: Join a synced vault…",
      checkCallback: (checking) => {
        if (this.record || !this.canSync || !SYNC_IN_BUILD) return false;
        if (!checking) void import("./modals").then((m) => m.openJoin(this));
        return true;
      },
    });
    this.addCommand({
      id: "opensync:show-recovery-kit",
      name: "Sync: Print recovery kit",
      checkCallback: (checking) => {
        if (!enrolled()) return false;
        if (!checking) void import("./modals").then((m) => m.openKit(this));
        return true;
      },
    });
    this.addCommand({
      id: "opensync:review-conflicts",
      name: "Sync: Review conflicts",
      checkCallback: (checking) => {
        if (!this.controller?.conflicts.length) return false;
        if (!checking) void this.reviewConflicts();
        return true;
      },
    });
    this.addCommand({
      id: "opensync:show-held-back",
      name: "Sync: Show files not synced",
      checkCallback: (checking) => {
        if (!this.controller?.heldBack.length) return false;
        if (!checking) void import("./modals").then((m) => m.openHeldBack(this));
        return true;
      },
    });
    this.addCommand({
      id: "opensync:show-log",
      name: "Sync: Show sync activity",
      checkCallback: (checking) => {
        if (!this.record) return false;
        if (!checking) void this.openLog();
        return true;
      },
    });
  }

  /** Start syncing if this vault is enrolled here and nothing else owns its sync. */
  private async startIfReady(): Promise<void> {
    if (!SYNC_IN_BUILD || !this.record || !this.canSync) return this.renderStatus();
    if (this.pluginOwnsSync) {
      if (this.controller) {
        this.controller.stop();
        this.controller = null;
      }
      return this.renderStatus();
    }
    if (this.controller) return this.renderStatus();
    const controller = new SyncController(this.app, this.record);
    this.controller = controller;
    const changed = () => {
      // A controller replaced by a restart may still finish a run; its record is stale.
      if (this.controller !== controller) return;
      this.record = controller.record;
      this.renderStatus();
      // Settings → Sync listens here; without it the panel's connection and
      // last-result lines only refreshed when something else redrew them.
      this.changes.trigger("change");
    };
    controller.on("status", changed);
    controller.on("conflicts", changed);
    controller.on("pending", () => {
      this.badges?.update(controller.pending, controller.conflicts);
      this.changes.trigger("change");
    });
    controller.on("conflicts", () => this.badges?.update(controller.pending, controller.conflicts));
    controller.on("review-conflicts", () => void this.reviewConflicts());
    this.badges ??= new ExplorerBadges(this.app);
    this.badges.start();
    try {
      await controller.start();
    } catch (e) {
      console.error("Sync could not start", e);
    }
    this.renderStatus();
  }

  /** Called by the set-up and join flows once the device record is written. */
  async enrolled(record: DeviceRecord): Promise<void> {
    this.record = record;
    this.controller?.stop();
    this.controller = null;
    await this.startIfReady();
    this.changes.trigger("change");
  }

  async updateRecord(patch: Partial<DeviceRecord>, restart = false): Promise<void> {
    if (!this.record) return;
    this.record = (await devices.update(this.vaultId, patch)) ?? this.record;
    if (restart) await this.enrolled(this.record);
    else this.changes.trigger("change");
  }

  /** Forget this device's sync state and keys for this vault. The files stay. */
  async disconnect(): Promise<void> {
    this.controller?.stop();
    this.controller = null;
    this.badges?.update(new Set(), []);
    await forgetVault(this.vaultId);
    this.record = null;
    this.renderStatus();
  }

  openSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(SYNC_TAB_ID);
  }

  async openLog() {
    const existing = this.app.workspace.getLeavesOfType(SYNC_LOG_VIEW)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: SYNC_LOG_VIEW, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  async reviewConflicts(copy?: string) {
    const { ConflictModal } = await import("./conflicts");
    if (this.controller) new ConflictModal(this, copy).open();
  }

  statusText(): { text: string; icon: string; cls: string; tooltip: string } {
    if (this.record && this.pluginOwnsSync) {
      return { text: "Synced by the OpenSync plugin", icon: "lucide-puzzle", cls: "mod-plugin", tooltip: "Built-in sync is off while the OpenSync community plugin is enabled for this vault." };
    }
    const c = this.controller;
    if (!c) return { text: "Sync off", icon: "lucide-cloud-off", cls: "mod-off", tooltip: "" };
    const s: SyncStatus = c.status;
    const last = `Last synced ${ago(c.lastSyncAt)}`;
    const conflicts = c.conflicts.length ? ` · ${c.conflicts.length} conflict${c.conflicts.length === 1 ? "" : "s"}` : "";
    switch (s.state) {
      case "starting":
        return { text: "Sync starting…", icon: "lucide-refresh-cw", cls: "mod-syncing", tooltip: last };
      case "syncing":
        return { text: "Syncing…", icon: "lucide-refresh-cw", cls: "mod-syncing", tooltip: last };
      case "synced":
        return { text: `Synced${conflicts}`, icon: c.conflicts.length ? "lucide-alert-triangle" : "lucide-check-circle", cls: c.conflicts.length ? "mod-warning" : "mod-synced", tooltip: last };
      case "paused":
        return { text: "Sync paused", icon: "lucide-pause-circle", cls: "mod-paused", tooltip: last };
      case "follower":
        return { text: "Syncing in another tab", icon: "lucide-copy", cls: "mod-follower", tooltip: "Another tab of this vault is syncing it. This tab's changes are sent through that one." };
      case "attention":
        return s.kind === "offline"
          ? { text: "Sync offline", icon: "lucide-wifi-off", cls: "mod-offline", tooltip: `${s.text}\n${last}` }
          : { text: "Sync needs attention", icon: "lucide-alert-circle", cls: "mod-error", tooltip: `${s.text}\n${last}` };
    }
  }

  renderStatus() {
    this.changes.trigger("change");
    const el = this.statusEl;
    if (!el) return;
    if (!SYNC_IN_BUILD || !this.record) {
      el.hide();
      return;
    }
    const { text, icon, cls, tooltip } = this.statusText();
    el.empty();
    el.show();
    el.className = el.className
      .split(" ")
      .filter((c) => !c.startsWith("mod-") || c === "mod-clickable")
      .join(" ");
    el.addClass(cls);
    const iconEl = el.createSpan({ cls: "status-bar-item-icon vault-sync-status-icon" });
    setIcon(iconEl, icon);
    el.createSpan({ cls: "vault-sync-status-text", text });
    el.setAttr("aria-label", text);
    if (tooltip) setTooltip(el, tooltip, { placement: "top" });
  }

  showStatusMenu(evt: MouseEvent) {
    const menu = new Menu();
    const c = this.controller;
    const s = c?.status;
    if (s?.state === "attention") menu.addItem((i) => i.setTitle(s.text).setIsLabel(true));
    if (c) {
      menu.addItem((i) => i.setTitle("Sync now").setIcon("lucide-refresh-cw").onClick(() => void c.runNow()));
      menu.addItem((i) =>
        this.record?.paused
          ? i.setTitle("Resume sync").setIcon("lucide-play").onClick(() => void c.setPaused(false))
          : i.setTitle("Pause sync").setIcon("lucide-pause").onClick(() => void c.setPaused(true)),
      );
      menu.addItem((i) =>
        i
          .setTitle(c.conflicts.length ? `Review conflicts (${c.conflicts.length})` : "No conflicts")
          .setIcon("lucide-git-compare")
          .setDisabled(!c.conflicts.length)
          .onClick(() => void this.reviewConflicts()),
      );
      if (c.heldBack.length) {
        menu.addItem((i) => i.setTitle(`Files not synced (${c.heldBack.length})`).setIcon("lucide-file-x").onClick(() => void import("./modals").then((m) => m.openHeldBack(this))));
      }
      menu.addSeparator();
    }
    menu.addItem((i) => i.setTitle("Sync activity").setIcon("lucide-list").onClick(() => void this.openLog()));
    menu.addItem((i) => i.setTitle("Sync settings").setIcon("lucide-settings").onClick(() => this.openSettings()));
    menu.showAtMouseEvent(evt);
  }

  /** Conflict pairs that involve `path`, for callers outside the controller. */
  conflictFor(path: string) {
    const parsed = parseConflict(path);
    return this.controller?.conflicts.find((c) => c.copy === path || c.path === (parsed?.original ?? path)) ?? null;
  }
}

export const opensync: CorePluginDefinition = {
  id: SYNC_ID,
  name: "Sync",
  description: "End-to-end encrypted sync between your devices.",
  icon: "lucide-refresh-cw",
  defaultOn: true,
  hidden: true,
  create: (app) => new SyncPlugin(app, { id: SYNC_ID, name: "Sync", version: "", minAppVersion: "", author: "", description: "" }),
};
