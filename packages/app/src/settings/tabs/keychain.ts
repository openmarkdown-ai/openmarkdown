/**
 * Settings → Keychain (§6.7): the named secrets plugins read through
 * `app.secretStorage` (`SecretComponent` stores a secret's id, never its value).
 * Values are never shown; they can be replaced or removed.
 */
import type { App } from "../../obsidian/app";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { ButtonComponent, Setting, TextComponent } from "../../obsidian/ui/setting";
import { confirmModal } from "../helpers";
import { AppSettingTab } from "../tab-base";

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * SecretStorage has no removal method in the API; the app's implementation
 * keeps secrets under the `secret-storage` local storage key.
 */
export function removeSecret(app: App, id: string): void {
  const storage = app.secretStorage as unknown as { removeSecret?: (id: string) => void; deleteSecret?: (id: string) => void };
  if (typeof storage.removeSecret === "function") return storage.removeSecret(id);
  if (typeof storage.deleteSecret === "function") return storage.deleteSecret(id);
  const all = (app.loadLocalStorage("secret-storage") ?? {}) as Record<string, string>;
  delete all[id];
  app.saveLocalStorage("secret-storage", Object.keys(all).length ? all : null);
  app.secretStorage.trigger("changed", id);
}

export class KeychainSettingTab extends AppSettingTab {
  constructor(app: App) {
    super(app, "keychain", "Keychain", "lucide-key-round");
  }

  render(el: HTMLElement): void {
    const app = this.app;
    const group = this.group(el, "Secrets");
    group.getHeader().setDesc("API keys and tokens that plugins use. They are stored in this browser for this vault and are never written to the vault folder.");
    group.addExtraButton((b) =>
      b
        .setIcon("lucide-plus")
        .setTooltip("Add secret")
        .onClick(() => new SecretModal(app, null, () => this.rerender()).open()),
    );
    const ids = app.secretStorage.listSecrets().sort();
    if (!ids.length) {
      this.row(group, "No secrets", "Add a secret here, or from a plugin's settings.");
    }
    for (const id of ids) {
      this.row(group, id, "••••••••")
        .addExtraButton((b) =>
          b
            .setIcon("lucide-pencil")
            .setTooltip("Replace value")
            .onClick(() => new SecretModal(app, id, () => this.rerender()).open()),
        )
        .addExtraButton((b) =>
          b
            .setIcon("lucide-trash-2")
            .setTooltip("Remove")
            .onClick(async () => {
              const ok = await confirmModal(app, { title: "Remove secret", message: `Remove "${id}"? Plugins that use it will stop working until you add it again.`, cta: "Remove", warning: true });
              if (!ok) return;
              removeSecret(app, id);
              this.rerender();
            }),
        );
    }
    const add = this.row(this.group(el), "Add a secret", "Secret ids use lowercase letters, digits and dashes.");
    add.addButton((b) => b.setButtonText("Add secret").onClick(() => new SecretModal(app, null, () => this.rerender()).open()));
  }
}

class SecretModal extends Modal {
  constructor(
    app: App,
    private id: string | null,
    private onDone: () => void,
  ) {
    super(app);
    this.setTitle(id ? `Replace "${id}"` : "Add secret");
  }

  override onOpen(): void {
    const { contentEl } = this;
    let idInput: TextComponent | null = null;
    if (!this.id) {
      new Setting(contentEl).setName("Id").addText((t) => {
        idInput = t.setPlaceholder("my-api-key");
        t.inputEl.setAttr("spellcheck", "false");
      });
    }
    let valueInput!: TextComponent;
    new Setting(contentEl).setName("Value").addText((t) => {
      valueInput = t.setPlaceholder("Secret value");
      t.inputEl.type = "password";
      t.inputEl.autocomplete = "off";
    });
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    const save = () => {
      const id = this.id ?? (idInput as TextComponent | null)?.getValue().trim() ?? "";
      if (!ID_PATTERN.test(id)) {
        new Notice("Use lowercase letters, digits and single dashes for the id.");
        return;
      }
      if (!this.id && this.app.secretStorage.listSecrets().includes(id)) {
        new Notice(`A secret named "${id}" already exists.`);
        return;
      }
      try {
        this.app.secretStorage.setSecret(id, valueInput.getValue());
      } catch (e) {
        new Notice((e as Error).message);
        return;
      }
      this.close();
    };
    new ButtonComponent(buttons).setButtonText("Save").setCta().onClick(save);
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    contentEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.isComposing) {
        evt.preventDefault();
        save();
      }
    });
    window.setTimeout(() => ((idInput as TextComponent | null) ?? valueInput).inputEl.focus(), 0);
  }

  override onClose(): void {
    this.onDone();
  }
}
