/** Settings → Sync. */
import { ConfirmationModal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { setIcon } from "../../obsidian/ui/icons";
import type { SyncPlugin } from "./index";
import { ago, isHosted } from "./words";

export const SYNC_TAB_ID = "sync";

export class SyncSettingTab extends PluginSettingTab {
  private offref: (() => void) | null = null;
  private statusEl: HTMLElement | null = null;
  private lastShape = "";

  constructor(
    app: any,
    private readonly sync: SyncPlugin,
  ) {
    super(app, sync);
    // Not "opensync": that is the community plugin's tab, and `openTabById`
    // must still reach it when the plugin is installed. "sync" is the id
    // Obsidian gives its own Sync settings.
    this.id = SYNC_TAB_ID;
    this.name = "Sync";
    this.icon = "lucide-refresh-cw";
  }

  override display(): void {
    if (!this.offref) {
      const ref = this.sync.changes.on("change", () => this.onChange());
      this.offref = () => this.sync.changes.offref(ref);
    }
    this.render();
  }

  override hide(): void {
    this.offref?.();
    this.offref = null;
    super.hide?.();
  }

  /** Re-render only when what is shown changes shape; otherwise refresh the status line in place. */
  private onChange() {
    if (!this.containerEl.isConnected) return;
    if (this.shape() === this.lastShape) return this.renderStatus();
    // Never rebuild the pane under someone typing into it; wait for them to leave the field.
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.containerEl.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
      this.renderStatus();
      active.addEventListener("focusout", () => window.setTimeout(() => this.onChange(), 0), { once: true });
      return;
    }
    this.render();
  }

  private shape(): string {
    const s = this.sync;
    const c = s.controller;
    return JSON.stringify([!!s.record, s.pluginOwnsSync, s.canSync, c?.status.state === "attention" ? (c.status as { kind: string }).kind : "", c?.conflicts.length ?? 0, c?.heldBack.length ?? 0, s.record?.paused, s.record?.carryAttachments, s.record?.relayWs]);
  }

  private render() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("vault-sync-settings");
    this.lastShape = this.shape();
    const plugin = this.sync;

    if (!plugin.canSync) {
      const panel = containerEl.createDiv({ cls: "vault-sync-status-panel" });
      const row = panel.createDiv({ cls: "vault-sync-status-row mod-off" });
      setIcon(row.createDiv({ cls: "vault-sync-status-panel-icon" }), "lucide-cloud-off");
      const info = row.createDiv({ cls: "vault-sync-status-info" });
      info.createDiv({ cls: "vault-sync-status-title", text: "This vault cannot sync" });
      info.createDiv({
        cls: "vault-sync-status-lines",
        text: "The demo vault is not saved anywhere, so there is nothing to sync. Create a vault stored in this browser, or open a folder on this computer, then come back here.",
      });
      row.createDiv({ cls: "vault-sync-status-actions" }).createEl("button", { cls: "mod-cta", text: "Vaults" }).addEventListener("click", () => {
        const url = new URL(location.href);
        url.searchParams.set("choose", "1");
        url.searchParams.delete("vault");
        location.href = url.toString();
      });
      return;
    }

    if (plugin.pluginOwnsSync) {
      const box = containerEl.createDiv({ cls: "vault-sync-callout" });
      box.createEl("strong", { text: "Synced by the OpenSync plugin. " });
      box.createSpan({
        text: "The OpenSync community plugin is enabled for this vault, and it syncs it. Built-in sync stays off while the plugin is on, because two syncs of one folder behave like two devices and make conflict copies of every edit. To use built-in sync instead, disable the plugin in Community plugins, then set up sync here.",
      });
      new Setting(containerEl).setName("Community plugins").addButton((b) => b.setButtonText("Open").onClick(() => this.app.setting.openTabById("community-plugins")));
      return;
    }

    if (!plugin.record) {
      this.renderNotSetUp(containerEl);
      return;
    }
    this.renderSetUp(containerEl);
  }

  private renderNotSetUp(el: HTMLElement) {
    // Say the state before the offer: "is it syncing?" must be answerable at a glance.
    const panel = el.createDiv({ cls: "vault-sync-status-panel" });
    const row = panel.createDiv({ cls: "vault-sync-status-row mod-off" });
    setIcon(row.createDiv({ cls: "vault-sync-status-panel-icon" }), "lucide-cloud-off");
    const info = row.createDiv({ cls: "vault-sync-status-info" });
    info.createDiv({ cls: "vault-sync-status-title", text: "Sync is off for this vault" });
    info.createDiv({ cls: "vault-sync-status-lines", text: `“${this.sync.app.vault.getName()}” stays on this device. Nothing is sent anywhere until you turn sync on or join from another device.` });

    const intro = el.createDiv({ cls: "vault-sync-intro" });
    setIcon(intro.createDiv({ cls: "vault-sync-intro-icon" }), "lucide-refresh-cw");
    const text = intro.createDiv();
    text.createDiv({ cls: "vault-sync-intro-title", text: "Sync this vault between your devices" });
    text.createDiv({
      cls: "setting-item-description",
      text: "Encrypted on this device before anything leaves it — the server stores data it cannot read. No account or password: devices join with a short code. Notes sync free and without limits.",
    });

    new Setting(el)
      .setName("Turn on sync")
      .setDesc("Start syncing this vault. You'll print a recovery kit next.")
      .addButton((b) => b.setButtonText("Turn on").setCta().onClick(() => void import("./modals").then((m) => m.openSetUp(this.sync))));
    new Setting(el)
      .setName("Join from another device")
      .setDesc("A device that already syncs shows a code under Add a device. Type it here.")
      .addButton((b) => b.setButtonText("Join").onClick(() => void import("./modals").then((m) => m.openJoin(this.sync))));
    new Setting(el)
      .setName("Restore from a recovery kit")
      .setDesc("When no other device is left. Type the keys from your printed kit.")
      .addButton((b) => b.setButtonText("Restore").onClick(() => void import("./modals").then((m) => m.openRestore(this.sync))));
    new Setting(el)
      .setName("Your own sync server")
      .setDesc("Sync through a server you run instead — attachments included, no limits.")
      .addButton((b) => b.setButtonText("How").onClick(() => void import("./modals").then((m) => m.openSelfHost(this.sync))));
  }

  private renderSetUp(el: HTMLElement) {
    const plugin = this.sync;
    const record = plugin.record!;
    const c = plugin.controller;

    this.statusEl = el.createDiv({ cls: "vault-sync-status-panel" });
    this.renderStatus();

    if (c?.status.state === "attention") {
      const s = c.status;
      const box = el.createDiv({ cls: `vault-sync-callout mod-${s.kind}` });
      box.createDiv({ text: s.text });
      if (s.kind === "not-admitted" || s.kind === "quota") {
        const row = box.createDiv({ cls: "vault-sync-callout-actions" });
        row.createEl("button", { text: "Run your own sync server" }).addEventListener("click", () => void import("./modals").then((m) => m.openSelfHost(plugin)));
        row.createEl("button", { text: "Change server" }).addEventListener("click", () => void import("./modals").then((m) => new m.ServerModal(plugin).open()));
      }
      if (s.kind === "locked-out") {
        const row = box.createDiv({ cls: "vault-sync-callout-actions" });
        row.createEl("button", { text: "Disconnect and join again" }).addEventListener("click", () => this.confirmDisconnect());
      }
    }

    new Setting(el).setHeading().setName("This device");
    new Setting(el)
      .setName("Device name")
      .setDesc("Shown to your other devices, and in the name of conflict copies made from this device's version.")
      .addText((t) => {
        t.inputEl.addClass("vault-sync-device-name");
        t.setValue(record.deviceLabel);
        t.inputEl.addEventListener("change", () => {
          const v = t.getValue().trim();
          if (v && v !== plugin.record?.deviceLabel) void plugin.updateRecord({ deviceLabel: v }, true);
        });
      });
    new Setting(el)
      .setName("Sync server")
      .setDesc(isHosted(record.relayWs) ? "OpenSync server" : record.relayWs)
      .addButton((b) => b.setButtonText("Change").onClick(() => void import("./modals").then((m) => new m.ServerModal(plugin).open())));
    const npub = c?.npub ?? null;
    const account = new Setting(el)
      .setName("Account")
      .setDesc(
        npub
          ? "Your public identity on the sync server — safe to share. It is the same on every device of this vault. Your keys are never shown."
          : `${record.accountId} — the same on every device of this vault, and on its recovery kit.`,
      )
      .addButton((b) => b.setButtonText("Print recovery kit").onClick(() => void import("./modals").then((m) => m.openKit(plugin))));
    if (npub) {
      const box = account.descEl.createDiv({ cls: "vault-sync-npub" });
      const code = box.createEl("code", { cls: "vault-sync-npub-key", text: npub });
      code.setAttr("title", npub);
      const copy = box.createEl("button", { cls: "clickable-icon vault-sync-npub-copy", attr: { "aria-label": "Copy npub" } });
      setIcon(copy, "lucide-copy");
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(npub).then(
          () => new Notice("npub copied."),
          () => new Notice("Could not copy the npub."),
        );
      });
      box.createSpan({ cls: "vault-sync-npub-id", text: `recovery kit id ${record.accountId}` });
    }

    new Setting(el).setHeading().setName("Devices");
    const devicesEl = el.createDiv({ cls: "vault-sync-devices" });
    void c?.seenDevices().then((seen) => {
      if (!seen.length) devicesEl.createDiv({ cls: "setting-item-description", text: "No other device has synced yet." });
      for (const d of seen) {
        const row = devicesEl.createDiv({ cls: "vault-sync-device" });
        setIcon(row.createSpan({ cls: "vault-sync-device-icon" }), /Android|iOS|Phone/i.test(d.name) ? "lucide-smartphone" : "lucide-monitor");
        row.createSpan({ cls: "vault-sync-device-name-text", text: d.name });
        row.createSpan({ cls: "vault-sync-device-meta", text: d.name === record.deviceLabel ? "this device" : `last sent changes ${ago(d.at)}` });
      }
    });
    new Setting(el)
      .setName("Add a device")
      .setDesc("Shows a code and a QR for your phone or another computer. The key is never typed.")
      .addButton((b) => b.setButtonText("Add a device").setCta().onClick(() => void import("./modals").then((m) => m.openAddDevice(plugin))));

    new Setting(el).setHeading().setName("What syncs");
    new Setting(el).setName("Notes and other text").setDesc("Markdown, canvases, bases, and other text files. Always on.").addToggle((t) => t.setValue(true).setDisabled(true));
    const hosted = isHosted(record.relayWs);
    const metered = hosted && record.plan !== "supporter";
    const attachments = new Setting(el)
      .setName("Attachments")
      .setDesc(
        metered
          ? "Images, PDFs, audio and video sync on the paid plan of the OpenSync server — coming soon — or free on your own sync server."
          : "Images, PDFs, audio, video and every other file. Your own server has no limits.",
      )
      .addToggle((t) =>
        t
          .setValue(record.carryAttachments && !metered)
          .setDisabled(metered)
          .onChange((v) => void plugin.updateRecord({ carryAttachments: v }, true)),
      );
    if (c?.heldBack.length) {
      attachments.addButton((b) => b.setButtonText(`${c.heldBack.length} not synced`).onClick(() => void import("./modals").then((m) => m.openHeldBack(plugin))));
    }
    new Setting(el)
      .setName("Settings and plugins")
      .setDesc("Not yet. The sync format cannot yet tell “this device does not sync settings” from “settings were deleted”, so .obsidian stays on each device for now.")
      .addToggle((t) => t.setValue(false).setDisabled(true));

    new Setting(el).setHeading().setName("Activity");
    new Setting(el)
      .setName("Conflicts")
      .setDesc(c?.conflicts.length ? `${c.conflicts.length} file${c.conflicts.length === 1 ? "" : "s"} changed on two devices at once. Both versions were kept.` : "None.")
      .addButton((b) => b.setButtonText("Review").setDisabled(!c?.conflicts.length).onClick(() => void plugin.reviewConflicts()));
    new Setting(el)
      .setName("Sync activity")
      .setDesc("What arrived, what was sent, and anything that went wrong.")
      .addButton((b) => b.setButtonText("View").onClick(() => {
        this.app.setting.close();
        void plugin.openLog();
      }));

    new Setting(el).setHeading().setName("Stop syncing");
    new Setting(el)
      .setName("Disconnect this device")
      .setDesc("This device stops syncing and forgets the keys. The files stay here, and your other devices keep syncing.")
      .addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(() => this.confirmDisconnect()));
  }

  private renderStatus() {
    const el = this.statusEl;
    const plugin = this.sync;
    if (!el || !el.isConnected || !plugin.record) return;
    el.empty();
    const c = plugin.controller;
    const { text, icon, cls } = plugin.statusText();
    const row = el.createDiv({ cls: `vault-sync-status-row ${cls}` });
    setIcon(row.createDiv({ cls: "vault-sync-status-panel-icon" }), icon);
    const info = row.createDiv({ cls: "vault-sync-status-info" });
    info.createDiv({ cls: "vault-sync-status-title", text });

    // Three plain lines, so "is it syncing?" is answered without reading a log:
    // the connection, what the last sync did, and what is still waiting.
    const lines = info.createDiv({ cls: "vault-sync-status-lines" });
    const line = (t: string, mod = "") => lines.createDiv({ cls: `vault-sync-status-line${mod ? ` ${mod}` : ""}`, text: t });

    const server = isHosted(plugin.record.relayWs) ? "the OpenSync server" : plugin.record.relayWs;
    if (plugin.record.paused) line("Paused — nothing is sent or received until you resume.");
    else if (c?.status.state === "follower") line("Another tab of this vault is syncing it; this tab sends its changes through that one.");
    else if (c?.connected) line(`Connected to ${server} — other devices' changes arrive as they are made.`, "mod-ok");
    else line(`Not connected to ${server} — retrying; your edits are kept and sent when it answers.`, "mod-warn");

    const o = c?.lastOutcome;
    if (!c?.lastSyncAt) line("Nothing has synced yet on this device.");
    else if (o && (o.pulled || o.deleted || o.pushed || o.conflicts)) {
      const parts: string[] = [];
      if (o.pushed) parts.push(`sent ${o.pushed}`);
      if (o.pulled) parts.push(`received ${o.pulled}`);
      if (o.deleted) parts.push(`deleted ${o.deleted}`);
      if (o.conflicts) parts.push(`${o.conflicts} conflict${o.conflicts === 1 ? "" : "s"}`);
      line(`Last synced ${ago(c.lastSyncAt)} — ${parts.join(", ")}.`);
    } else line(`Last synced ${ago(c.lastSyncAt)} — everything was already up to date.`);

    if (c?.pending.size) line(`${c.pending.size} change${c.pending.size === 1 ? "" : "s"} waiting to send.`, "mod-warn");

    const actions = row.createDiv({ cls: "vault-sync-status-actions" });
    const now = actions.createEl("button", { cls: "mod-cta", text: "Sync now" });
    now.disabled = !c || c.status.state === "syncing" || !!plugin.record.paused;
    now.addEventListener("click", () => {
      if (!c) return;
      now.disabled = true;
      const before = c.lastSyncAt;
      void c.runNow().then(() => {
        // Say what happened: a button that only stops being disabled tells nobody anything.
        const o2 = c.lastOutcome;
        if (c.lastSyncAt && c.lastSyncAt !== before) {
          const parts: string[] = [];
          if (o2?.pushed) parts.push(`sent ${o2.pushed}`);
          if (o2?.pulled) parts.push(`received ${o2.pulled}`);
          if (o2?.deleted) parts.push(`deleted ${o2.deleted}`);
          new Notice(parts.length ? `Synced — ${parts.join(", ")}.` : "Synced — everything was already up to date.");
        } else if (c.status.state === "attention") new Notice((c.status as { text: string }).text);
        this.renderStatus();
      });
    });
    const pause = actions.createEl("button", { text: plugin.record.paused ? "Resume" : "Pause" });
    pause.disabled = !c;
    pause.addEventListener("click", () => void c?.setPaused(!plugin.record?.paused));
    const activity = actions.createEl("button", { text: "Activity" });
    activity.addEventListener("click", () => void plugin.openLog());
  }

  private confirmDisconnect() {
    const modal = new ConfirmationModal(this.app);
    modal.setTitle("Disconnect this device?");
    modal.setContent("This device stops syncing this vault and forgets its keys. Your files stay here, and your other devices are not affected. To sync again, join with a code from another device.");
    modal.addButton((b) => b.setButtonText("Disconnect").setWarning().onClick(() => void this.sync.disconnect().then(() => this.render())));
    modal.addCancelButton();
    modal.open();
  }
}
