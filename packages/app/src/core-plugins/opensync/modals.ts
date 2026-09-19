/**
 * The sync screens that open from Settings → Sync, the status menu and the
 * command palette: turn on, join, add a device, recovery kit, restore, files
 * not synced, and how to run your own server. None of them shows a key.
 */
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { Setting } from "../../obsidian/ui/setting";
import { setIcon } from "../../obsidian/ui/icons";
import type { SyncPlugin } from "./index";
import { joinWithCode, restoreFromKit, setUpNew, type ServerChoice } from "./enroll";
import { device as devices, unwrap } from "./store";
import { defaultDeviceLabel, endpointFor, isHosted, mixedContentProblem } from "./words";

/** "Sync server" as a choice of two, with the address field only when it is yours. */
export function serverPicker(containerEl: HTMLElement, initial = ""): { value(): ServerChoice } {
  let own = !!initial;
  let address = initial;
  const setting = new Setting(containerEl).setName("Sync server");
  const desc = () =>
    own
      ? "Your own OpenSync server. Type its address, such as sync.example.net or 192.168.0.10:4848. Nothing is metered on a server of your own."
      : "The OpenSync server. Notes sync free; everything is encrypted on this device before it leaves.";
  setting.setDesc(desc());
  let field: HTMLInputElement | null = null;
  setting.addDropdown((d) =>
    d
      .addOption("hosted", "OpenSync server")
      .addOption("own", "My own server")
      .setValue(own ? "own" : "hosted")
      .onChange((v) => {
        own = v === "own";
        setting.setDesc(desc());
        field?.toggle(own);
        if (own) field?.focus();
      }),
  );
  setting.addText((t) => {
    field = t.inputEl;
    t.inputEl.addClass("vault-sync-server-address");
    t.setPlaceholder("sync.example.net").setValue(address).onChange((v) => {
      address = v;
      let problem: string | null = null;
      try {
        problem = v.trim() ? mixedContentProblem(endpointFor(v).ws) : null;
      } catch {
        problem = null;
      }
      setting.setErrorMessage(problem);
    });
    t.inputEl.toggle(own);
  });
  return { value: () => ({ address: own ? address : "" }) };
}

function deviceName(containerEl: HTMLElement, initial: string): () => string {
  let value = initial;
  new Setting(containerEl)
    .setName("This device's name")
    .setDesc("Shown to your other devices, and in the name of a conflict copy made from this device's version.")
    .addText((t) => t.setValue(value).onChange((v) => (value = v)).inputEl.addClass("vault-sync-device-name"));
  return () => value;
}

function statusLine(containerEl: HTMLElement) {
  const el = containerEl.createDiv({ cls: "vault-sync-modal-status", attr: { role: "status" } });
  return {
    busy(text: string) {
      el.empty();
      el.removeClass("mod-error");
      setIcon(el.createSpan({ cls: "vault-sync-spinner" }), "lucide-loader-2");
      el.createSpan({ text });
    },
    error(text: string) {
      el.empty();
      el.addClass("mod-error");
      el.setText(text);
    },
    clear() {
      el.empty();
      el.removeClass("mod-error");
    },
  };
}

function buttons(containerEl: HTMLElement) {
  return containerEl.createDiv({ cls: "modal-button-container" });
}

// ---- turn on ---------------------------------------------------------------------------

export class SetUpModal extends Modal {
  constructor(private readonly plugin: SyncPlugin) {
    super(plugin.app);
    this.modalEl.addClass("vault-sync-modal");
    this.setTitle("Turn on sync");
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: "This vault's notes will sync to your other devices, encrypted on this device first. No account or password: other devices join with a short code, and a printed recovery kit is the backup.",
    });
    if (this.app.vault.getFiles().length === 0) {
      contentEl.createEl("p", { cls: "setting-item-description", text: "This vault is empty. To get notes from a device that already syncs, use Join from another device instead." });
    }
    const server = serverPicker(contentEl);
    const name = deviceName(contentEl, defaultDeviceLabel());
    const status = statusLine(contentEl);
    const row = buttons(contentEl);
    const go = row.createEl("button", { cls: "mod-cta", text: "Turn on sync" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    go.addEventListener("click", async () => {
      go.disabled = true;
      status.busy("Setting up…");
      try {
        const record = await setUpNew(this.plugin.vaultId, server.value(), name());
        await this.plugin.enrolled(record);
        this.close();
        new KitModal(this.plugin, true).open();
      } catch (e) {
        status.error(String((e as Error)?.message ?? e));
        go.disabled = false;
      }
    });
  }
}

// ---- join -------------------------------------------------------------------------------

export class JoinModal extends Modal {
  constructor(private readonly plugin: SyncPlugin) {
    super(plugin.app);
    this.modalEl.addClass("vault-sync-modal");
    this.setTitle("Join from another device");
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: "On a device that already syncs, open Sync settings and choose Add a device. Type the code it shows here." });
    if (this.app.vault.getFiles().length > 0) {
      contentEl.createDiv({
        cls: "vault-sync-callout",
        text: "This vault already has files. They are combined with the synced vault; a file that differs on both sides is kept twice, as a conflict copy you can review.",
      });
    }
    let code = "";
    new Setting(contentEl)
      .setName("Code")
      .setDesc("Ten characters, like 9x4k-tv2q8m. Or paste the whole opensync:// link.")
      .addText((t) => {
        t.inputEl.addClass("vault-sync-code-input");
        t.setPlaceholder("xxxx-xxxxxx").onChange((v) => (code = v));
        window.setTimeout(() => t.inputEl.focus(), 0);
      });
    const server = serverPicker(contentEl);
    const name = deviceName(contentEl, defaultDeviceLabel());
    const status = statusLine(contentEl);
    const row = buttons(contentEl);
    const go = row.createEl("button", { cls: "mod-cta", text: "Join" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    go.addEventListener("click", async () => {
      go.disabled = true;
      status.busy("Waiting for the other device…");
      try {
        const { record, grantedBy } = await joinWithCode(this.plugin.vaultId, code, server.value(), name());
        await this.plugin.enrolled(record);
        this.close();
        new Notice(`Sync: joined ${grantedBy ? `from ${grantedBy}` : "the account"}. Getting your notes…`);
      } catch (e) {
        status.error(String((e as Error)?.message ?? e));
        go.disabled = false;
      }
    });
  }
}

// ---- add a device ---------------------------------------------------------------------------

export class AddDeviceModal extends Modal {
  private cancelled = false;

  constructor(private readonly plugin: SyncPlugin) {
    super(plugin.app);
    this.modalEl.addClass("vault-sync-modal", "vault-sync-pair-modal");
    this.setTitle("Add a device");
  }

  override async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const record = this.plugin.record;
    if (!record) return;
    const status = statusLine(contentEl);
    status.busy("Making a code…");
    try {
      const engine = await import("./engine");
      const secrets = await unwrap(record.wrapped);
      const offer = await engine.offer(secrets, record);
      status.clear();
      contentEl.empty();

      const layout = contentEl.createDiv({ cls: "vault-sync-pair" });
      const qrBox = layout.createDiv({ cls: "vault-sync-qr" });
      const canvas = qrBox.createEl("canvas", { attr: { "aria-label": "Pairing QR code" } });
      offer.draw(canvas);
      const side = layout.createDiv({ cls: "vault-sync-pair-side" });
      side.createDiv({ cls: "vault-sync-pair-step", text: "On the other device, open OpenMarkdown and choose Open a synced vault — or, in Obsidian with the OpenSync plugin, Join from a code — and type:" });
      side.createDiv({ cls: "vault-sync-code", text: offer.code, attr: { "data-code": offer.code } });
      const server = side.createDiv({ cls: "vault-sync-pair-server" });
      server.createSpan({ text: "Sync server: " });
      server.createSpan({ cls: "vault-sync-pair-server-name", text: isHosted(record.relayWs) ? "OpenSync server" : record.relayWs });
      const copy = side.createEl("button", { cls: "vault-sync-copy-link", text: "Copy link" });
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(offer.uri);
          new Notice("Link copied. It works once, for one device.");
        } catch {
          new Notice("Could not copy the link.");
        }
      });
      side.createDiv({ cls: "setting-item-description", text: "A scanned QR carries the server address too. The code works once, for one device, for five minutes." });
      const host = record.relayWs.replace(/^wss?:\/\//, "").split(/[:/]/)[0];
      if (host === "127.0.0.1" || host === "localhost") {
        side.createDiv({ cls: "vault-sync-callout mod-warning", text: "This server address is this computer. A phone or another computer cannot reach it — use this computer's network address for the server instead." });
      }

      const waiting = statusLine(contentEl);
      waiting.busy("Waiting for the other device…");
      const row = buttons(contentEl);
      const cancel = row.createEl("button", { text: "Cancel" });
      cancel.addEventListener("click", () => this.close());
      offer.done.then(
        () => {
          if (this.cancelled) return;
          contentEl.empty();
          const done = contentEl.createDiv({ cls: "vault-sync-done" });
          setIcon(done.createDiv({ cls: "vault-sync-done-icon" }), "lucide-check-circle");
          done.createDiv({ text: "Done — that device now syncs this vault." });
          buttons(contentEl).createEl("button", { cls: "mod-cta", text: "Close" }).addEventListener("click", () => this.close());
          this.plugin.controller?.request(1000);
        },
        (e) => {
          if (this.cancelled) return;
          waiting.error(`No device joined: ${String((e as Error)?.message ?? e)}. Close this and try a new code.`);
        },
      );
    } catch (e) {
      status.error(String((e as Error)?.message ?? e));
    }
  }

  override onClose() {
    this.cancelled = true;
    this.contentEl.empty();
  }
}

// ---- recovery kit ---------------------------------------------------------------------------------

export class KitModal extends Modal {
  constructor(
    private readonly plugin: SyncPlugin,
    private readonly firstTime = false,
  ) {
    super(plugin.app);
    this.modalEl.addClass("vault-sync-modal");
    this.setTitle(firstTime ? "Sync is on — print your recovery kit" : "Recovery kit");
  }

  override async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const record = this.plugin.record;
    if (!record) return;
    contentEl.createEl("p", {
      text: "The recovery kit is the only way back into your synced notes if every device is lost. It holds your keys, so it is printed, not saved in the vault or shown here. Keep it where you keep your passport.",
    });
    const status = statusLine(contentEl);
    const frame = contentEl.createEl("iframe", { cls: "vault-sync-kit-frame", attr: { "aria-hidden": "true", tabindex: "-1" } });
    try {
      const engine = await import("./engine");
      const kit = await engine.renderKit(await unwrap(record.wrapped), record);
      const doc = frame.contentDocument!;
      doc.open();
      doc.write("<!doctype html><title>OpenSync recovery kit</title>");
      doc.close();
      const style = doc.createElement("style");
      style.textContent = "body{font:12pt/1.45 ui-monospace,Menlo,Consolas,monospace;margin:2cm;color:#000;background:#fff}pre{white-space:pre-wrap}";
      doc.head.appendChild(style);
      // Plain DOM: the app's element helpers are installed on this window's prototypes, not the frame's.
      const pre = doc.createElement("pre");
      pre.className = "kit";
      pre.textContent = kit.text;
      doc.body.appendChild(pre);
      new Setting(contentEl).setName("Account").setDesc(`The kit reads back as account ${kit.fingerprint}. Check that the printed page says the same.`);
      const row = buttons(contentEl);
      row.createEl("button", { cls: "mod-cta", text: "Print" }).addEventListener("click", () => {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
      });
      row.createEl("button", { text: this.firstTime ? "I've saved it" : "Close" }).addEventListener("click", async () => {
        await this.plugin.updateRecord({ kitSaved: true });
        this.close();
      });
      if (this.firstTime) {
        row.createEl("button", { text: "Later" }).addEventListener("click", () => this.close());
      }
    } catch (e) {
      status.error(String((e as Error)?.message ?? e));
    }
  }
}

// ---- restore ------------------------------------------------------------------------------------------

export class RestoreModal extends Modal {
  constructor(private readonly plugin: SyncPlugin) {
    super(plugin.app);
    this.modalEl.addClass("vault-sync-modal");
    this.setTitle("Restore from a recovery kit");
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: "Type both keys from your printed kit. Spaces and line breaks do not matter. Use this only when no other device can show a code." });
    let text = "";
    new Setting(contentEl).setName("Recovery kit").addTextArea((t) => {
      t.inputEl.rows = 6;
      t.inputEl.addClass("vault-sync-kit-input");
      t.setPlaceholder("nsec1 …\novault1 …").onChange((v) => (text = v));
    });
    const server = serverPicker(contentEl);
    const name = deviceName(contentEl, defaultDeviceLabel());
    const status = statusLine(contentEl);
    const row = buttons(contentEl);
    const go = row.createEl("button", { cls: "mod-cta", text: "Restore" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    go.addEventListener("click", async () => {
      go.disabled = true;
      status.busy("Checking the kit…");
      try {
        const record = await restoreFromKit(this.plugin.vaultId, text, server.value(), name());
        await this.plugin.enrolled(record);
        this.close();
        new Notice(`Sync: restored account ${record.accountId}. Getting your notes…`);
      } catch (e) {
        status.error(String((e as Error)?.message ?? e));
        go.disabled = false;
      }
    });
  }
}

// ---- files not synced -----------------------------------------------------------------------------------

export class HeldBackModal extends Modal {
  constructor(private readonly plugin: SyncPlugin) {
    super(plugin.app);
    this.modalEl.addClass("vault-sync-modal");
    this.setTitle("Files not synced");
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const paths = this.plugin.controller?.heldBack ?? [];
    const record = this.plugin.record;
    contentEl.createEl("p", {
      text:
        record && isHosted(record.relayWs)
          ? "Images, PDFs, audio and other attachments sync on the paid plan of the OpenSync server (coming soon), or free on a server of your own. Notes and other text always sync."
          : "Attachments are turned off for this device. Turn them on in Settings → Sync to sync these files.",
    });
    const list = contentEl.createDiv({ cls: "vault-sync-file-list" });
    for (const p of paths.slice(0, 500)) {
      const f = this.app.vault.getFileByPath(p);
      const row = list.createDiv({ cls: "vault-sync-file-row" });
      row.createSpan({ text: p });
      if (f) row.createSpan({ cls: "vault-sync-file-size", text: size(f.stat.size) });
    }
    if (paths.length > 500) list.createDiv({ cls: "setting-item-description", text: `…and ${paths.length - 500} more.` });
  }
}

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- your own server --------------------------------------------------------------------------------------

export class SelfHostModal extends Modal {
  constructor(
    app: any,
    private readonly publicId: string | null,
  ) {
    super(app);
    this.modalEl.addClass("vault-sync-modal", "vault-sync-selfhost");
    this.setTitle("Run your own sync server");
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const p = (t: string) => contentEl.createEl("p", { text: t });
    const code = (t: string) => contentEl.createEl("pre", { cls: "vault-sync-pre" }).createEl("code", { text: t });
    const h = (t: string) => contentEl.createEl("h4", { text: t });
    p("The sync server is one small program. It stores only encrypted data — it never sees a file name, a note or a key — and a server of your own has no limits: attachments sync too.");
    h("1. Build it");
    code("git clone https://github.com/open-sync/opensync.git\ncd opensync\ncargo build --release -p opensync-relay");
    h("2. Configure it");
    code('# relay.toml\nbind         = "127.0.0.1:4848"\ndata_dir     = "/var/lib/opensync"\ndatabase_url = "sqlite:///var/lib/opensync/relay.db?mode=rwc"\nadmission    = "roster"   # only accounts you admit may store anything\nbehind_a_reverse_proxy = true');
    h("3. Put TLS in front of it");
    p("A page served over https can only reach a wss:// server. Caddy does it in three lines:");
    code("sync.example.net {\n    reverse_proxy 127.0.0.1:4848\n}");
    p("On your own network, `tailscale serve` gives the server an https name without a domain.");
    h("4. Admit this account");
    if (this.publicId) {
      const row = contentEl.createDiv({ cls: "vault-sync-public-id" });
      code(`opensync-relay relay.toml admit ${this.publicId} "my vault"`);
      row.createSpan({ text: "This account's public ID (not a secret): " });
      const btn = row.createEl("button", { text: "Copy" });
      btn.addEventListener("click", () => void navigator.clipboard.writeText(this.publicId!).then(() => new Notice("Copied.")));
    } else {
      code('opensync-relay relay.toml admit <account public ID> "my vault"');
      p("The account's public ID is shown in Settings → Sync once sync is set up.");
    }
    h("5. Point this vault at it");
    p("Settings → Sync → Sync server → My own server, and type its address, such as sync.example.net. Back it up: copy relay.db with sqlite3 .backup, and the blobs directory.");
  }
}

// ---- entry points used by commands and the settings tab ---------------------------------------------------

export const openSetUp = (plugin: SyncPlugin) => new SetUpModal(plugin).open();
export const openJoin = (plugin: SyncPlugin) => new JoinModal(plugin).open();
export const openAddDevice = (plugin: SyncPlugin) => new AddDeviceModal(plugin).open();
export const openKit = (plugin: SyncPlugin) => new KitModal(plugin).open();
export const openRestore = (plugin: SyncPlugin) => new RestoreModal(plugin).open();
export const openHeldBack = (plugin: SyncPlugin) => new HeldBackModal(plugin).open();

export async function openSelfHost(plugin: SyncPlugin) {
  let id: string | null = null;
  if (plugin.record) {
    try {
      const engine = await import("./engine");
      id = await engine.publicId(await unwrap(plugin.record.wrapped));
    } catch {
      id = null;
    }
  }
  new SelfHostModal(plugin.app, id).open();
}

/** Change the server for an enrolled vault: the account and keys stay; the next sync publishes there. */
export class ServerModal extends Modal {
  constructor(private readonly plugin: SyncPlugin) {
    super(plugin.app);
    this.modalEl.addClass("vault-sync-modal");
    this.setTitle("Sync server");
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    const record = this.plugin.record;
    if (!record) return;
    contentEl.createEl("p", { text: "Your other devices must use the same server. After changing it here, change it on each of them too — or pair them again, which carries the address." });
    const picker = serverPicker(contentEl, isHosted(record.relayWs) ? "" : record.relayWs);
    const status = statusLine(contentEl);
    const row = buttons(contentEl);
    const go = row.createEl("button", { cls: "mod-cta", text: "Save" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    go.addEventListener("click", async () => {
      go.disabled = true;
      status.busy("Checking the server…");
      try {
        const { endpointOf } = await import("./enroll");
        const engine = await import("./engine");
        const endpoint = endpointOf(picker.value());
        await engine.probe(endpoint);
        await devices.update(record.vaultId, { relayWs: endpoint.ws, relayHttp: endpoint.http });
        await this.plugin.updateRecord({ relayWs: endpoint.ws, relayHttp: endpoint.http }, true);
        this.close();
      } catch (e) {
        status.error(String((e as Error)?.message ?? e));
        go.disabled = false;
      }
    });
  }
}
