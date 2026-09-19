/**
 * "Open a synced vault" on the vault chooser: join by code into a new vault
 * stored in this browser, then open it and pull. No vault exists until the
 * other device has answered.
 */
import { SYNC_IN_BUILD } from "@opensync/in-build";
import { createBrowserVault, navigateToVault } from "../../boot";
import { Setting } from "../../obsidian/ui/setting";
import { setIcon } from "../../obsidian/ui/icons";
import { serverPicker } from "./modals";
import { joinWithCode } from "./enroll";
import { defaultDeviceLabel } from "./words";

export function addSyncedVaultAction(main: HTMLElement): void {
  if (!SYNC_IN_BUILD) return;
  const row = main.createDiv({ cls: "vault-starter-action setting-item vault-starter-sync" });
  const info = row.createDiv({ cls: "setting-item-info" });
  info.createDiv({ cls: "setting-item-name", text: "Open a synced vault" });
  info.createDiv({ cls: "setting-item-description", text: "Get a vault from a device that already syncs. Type the code it shows under Settings → Sync → Add a device. Stored in this browser." });
  const button = row.createDiv({ cls: "setting-item-control" }).createEl("button", { text: "Join" });

  // Before the demo row, after the ways to open or make a vault.
  const demo = [...main.querySelectorAll(".vault-starter-action")].pop();
  if (demo && demo !== row) main.insertBefore(row, demo);

  let form: HTMLElement | null = null;
  button.addEventListener("click", () => {
    if (form) {
      form.remove();
      form = null;
      return;
    }
    form = createDiv({ cls: "vault-starter-sync-form" });
    row.after(form);
    let code = "";
    let name = "";
    new Setting(form)
      .setName("Code")
      .setDesc("Ten characters, like 9x4k-tv2q8m, or the whole opensync:// link.")
      .addText((t) => {
        t.inputEl.addClass("vault-sync-code-input");
        t.setPlaceholder("xxxx-xxxxxx").onChange((v) => (code = v));
        window.setTimeout(() => t.inputEl.focus(), 0);
      });
    const server = serverPicker(form);
    new Setting(form)
      .setName("Vault name")
      .setDesc("What this browser calls the vault. Leave empty to name it after the other device.")
      .addText((t) => t.setPlaceholder("Synced vault").onChange((v) => (name = v)).inputEl.addClass("vault-sync-vault-name"));
    const status = form.createDiv({ cls: "vault-sync-modal-status", attr: { role: "status" } });
    const buttons = form.createDiv({ cls: "modal-button-container" });
    const go = buttons.createEl("button", { cls: "mod-cta", text: "Join and open" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      form?.remove();
      form = null;
    });
    go.addEventListener("click", async () => {
      go.disabled = true;
      status.empty();
      status.removeClass("mod-error");
      setIcon(status.createSpan({ cls: "vault-sync-spinner" }), "lucide-loader-2");
      status.createSpan({ text: "Waiting for the other device…" });
      try {
        const { record } = await joinWithCode(
          async (grantedBy) => (await createBrowserVault(name.trim() || (grantedBy ? `Vault from ${grantedBy}` : "Synced vault"))).id,
          code,
          server.value(),
          defaultDeviceLabel(),
        );
        status.empty();
        status.setText("Joined. Opening the vault…");
        navigateToVault(record.vaultId);
      } catch (e) {
        status.empty();
        status.addClass("mod-error");
        status.setText(String((e as Error)?.message ?? e));
        go.disabled = false;
      }
    });
  });
}
