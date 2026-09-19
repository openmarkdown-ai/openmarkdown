/** The "Delete file" confirmation, with Obsidian's "don't ask again" option. */
import type { TAbstractFile } from "../vault/files";
import { TFolder } from "../vault/files";
import { Modal } from "./modal";

export function confirmDeletion(app: any, file: TAbstractFile): Promise<boolean> {
  if (app.vault.getConfig("promptDelete") === false) return Promise.resolve(true);
  return new Promise((resolve) => {
    let decided = false;
    const modal = new Modal(app);
    modal.setTitle(file instanceof TFolder ? "Delete folder" : "Delete file");
    const trash = app.vault.getConfig("trashOption");
    const where = trash === "none" ? "It will be permanently deleted." : "It will be moved to the vault's .trash folder.";
    modal.contentEl.createEl("p", { text: `Are you sure you want to delete “${file.name}”? ${where}` });
    const label = modal.contentEl.createEl("label", { cls: "mod-checkbox" });
    const box = label.createEl("input", { type: "checkbox" });
    label.appendText(" Don't ask again");
    const buttons = modal.modalEl.createDiv({ cls: "modal-button-container" });
    const del = buttons.createEl("button", { text: "Delete", cls: "mod-warning" });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    del.addEventListener("click", () => {
      decided = true;
      if (box.checked) app.vault.setConfig("promptDelete", false);
      modal.close();
      resolve(true);
    });
    cancel.addEventListener("click", () => modal.close());
    modal.onClose = () => {
      if (!decided) resolve(false);
    };
    modal.open();
    del.focus();
  });
}
