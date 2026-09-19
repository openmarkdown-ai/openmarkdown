/**
 * The vault chooser shown when no vault is open.
 */
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "./product";
import type { VaultRecord } from "./boot";
import { setIcon } from "./obsidian/ui/icons";

export interface StarterActions {
  vaults: VaultRecord[];
  supportsFolders: boolean;
  reopen(v: VaultRecord): Promise<void>;
  openFolder(): Promise<void>;
  createBrowserVault(name: string): Promise<void>;
  openDemo(): void;
  importFolder(files: File[]): Promise<void>;
  forget(id: string): Promise<void>;
}

export function showStarter(root: HTMLElement, a: StarterActions) {
  root.empty();
  const shell = root.createDiv({ cls: "vault-starter" });
  const side = shell.createDiv({ cls: "vault-starter-recent" });
  const main = shell.createDiv({ cls: "vault-starter-main" });

  side.createDiv({ cls: "vault-starter-recent-title", text: "Vaults" });
  const list = side.createDiv({ cls: "vault-starter-list" });
  const renderList = (vaults: VaultRecord[]) => {
    list.empty();
    if (!vaults.length) list.createDiv({ cls: "vault-starter-empty", text: "No vaults yet." });
    for (const v of vaults) {
      const item = list.createDiv({ cls: "vault-starter-item" });
      const label = item.createDiv({ cls: "vault-starter-item-label" });
      label.createDiv({ cls: "vault-starter-item-name", text: v.name });
      label.createDiv({ cls: "vault-starter-item-kind", text: v.kind === "folder" ? "Folder on this computer" : "Stored in this browser" });
      item.addEventListener("click", () => run(() => a.reopen(v)));
      const remove = item.createDiv({ cls: "clickable-icon vault-starter-item-remove", attr: { "aria-label": "Remove from list" } });
      setIcon(remove, "lucide-x");
      remove.addEventListener("click", async (e) => {
        e.stopPropagation();
        await a.forget(v.id);
        renderList(vaults.filter((x) => x !== v));
      });
    }
  };
  renderList(a.vaults);

  const brand = main.createDiv({ cls: "vault-starter-brand" });
  brand.createEl("h1", { text: PRODUCT_NAME });
  brand.createDiv({ cls: "vault-starter-tagline", text: PRODUCT_TAGLINE });
  const errorEl = main.createDiv({ cls: "vault-starter-error" });
  errorEl.hide();

  const run = async (fn: () => Promise<void> | void) => {
    errorEl.hide();
    try {
      await fn();
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return;
      errorEl.setText(String((e as Error)?.message ?? e));
      errorEl.show();
    }
  };

  const action = (title: string, desc: string, button: string, cta: boolean, onClick: () => void, disabledReason?: string) => {
    const row = main.createDiv({ cls: "vault-starter-action setting-item" });
    const info = row.createDiv({ cls: "setting-item-info" });
    info.createDiv({ cls: "setting-item-name", text: title });
    info.createDiv({ cls: "setting-item-description", text: disabledReason ?? desc });
    const btn = row.createDiv({ cls: "setting-item-control" }).createEl("button", { text: button, cls: cta ? "mod-cta" : "" });
    if (disabledReason) btn.disabled = true;
    btn.addEventListener("click", onClick);
    return row;
  };

  action(
    "Open folder as vault",
    "Choose a folder of Markdown files on this computer, such as an existing Obsidian vault. Changes are saved straight to the folder.",
    "Open",
    true,
    () => run(a.openFolder),
    a.supportsFolders ? undefined : "This browser cannot open folders on disk. Use Chrome, Edge, Brave, Arc or Opera, or create a vault stored in this browser.",
  );

  const create = action("Create new vault", "Stored privately inside this browser. Export it as a zip at any time.", "Create", false, () => {
    const name = nameInput.value.trim() || "My vault";
    void run(() => a.createBrowserVault(name));
  });
  const nameInput = create.querySelector(".setting-item-control")!.createEl("input", { type: "text", placeholder: "Vault name", cls: "vault-starter-name" });
  create.querySelector(".setting-item-control")!.prepend(nameInput);

  const importRow = action("Copy a folder into this browser", "For browsers that cannot open folders: copies an existing vault's files into browser storage.", "Choose folder", false, () => fileInput.click());
  const fileInput = importRow.createEl("input", { type: "file", attr: { webkitdirectory: "", multiple: "" } });
  fileInput.hide();
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    if (files.length) void run(() => a.importFolder(files));
  });

  action("Try the demo vault", "Sample notes that show links, embeds, callouts, tasks, math, diagrams, a canvas and a base. Nothing is saved.", "Open demo", false, () => a.openDemo());

  // W7 Sync: "Open a synced vault" (join by code into a new browser vault). Absent from builds without ../opensync.
  void import("./core-plugins/opensync/starter-join").then((m) => m.addSyncedVaultAction(main)).catch((e) => console.warn("Sync is unavailable on the vault chooser", e));
}
