/**
 * Core plugin Chat with vault (`vault-chat`). Off by default; needs AI with a
 * "chat" engine and the Related notes index (`semantic`) for retrieval. Steps
 * aside while Smart Connections is enabled.
 */
import { Plugin } from "../../obsidian/plugin";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { VaultChatView, VIEW_TYPE_VAULT_CHAT } from "./chat-view";

export interface VaultChatOptions {
  conversationFolder: string;
}

export const VAULT_CHAT_DEFAULTS: VaultChatOptions = { conversationFolder: "AI chats" };

const REPLACED_PLUGINS = ["smart-connections"];

export class VaultChatPlugin extends Plugin {
  instance!: any;

  get options(): VaultChatOptions {
    const o = this.instance.options as Partial<VaultChatOptions>;
    if (typeof o.conversationFolder !== "string") o.conversationFolder = VAULT_CHAT_DEFAULTS.conversationFolder;
    return o as VaultChatOptions;
  }

  steppedAside(): boolean {
    const enabled: Set<string> | undefined = this.app.plugins?.enabledPlugins;
    return !!enabled && REPLACED_PLUGINS.some((id) => enabled.has(id));
  }

  openAiSettings() {
    this.app.setting?.open?.();
    this.app.setting?.openTabById?.("ai");
  }

  override async onload() {
    this.registerView(VIEW_TYPE_VAULT_CHAT, (leaf: WorkspaceLeaf) => new VaultChatView(leaf, this));
    this.addCommand({
      id: "vault-chat:open",
      name: "Chat with vault: Open chat",
      icon: "lucide-messages-square",
      callback: () => void this.open(),
    });
    this.addSettingTab(new VaultChatSettingTab(this.app, this));
  }

  async open(): Promise<VaultChatView | null> {
    const leaf = (await this.app.workspace.ensureSideLeaf(VIEW_TYPE_VAULT_CHAT, "right", { active: true, reveal: true })) as WorkspaceLeaf;
    await leaf.loadIfDeferred?.();
    const view = leaf.view;
    if (view instanceof VaultChatView) {
      (view as any).inputEl?.focus();
      return view;
    }
    return null;
  }
}

class VaultChatSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: VaultChatPlugin,
  ) {
    super(app, owner as any);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createDiv({
      cls: "setting-item-description",
      text: "Answers questions from passages found in your notes, with links to the notes they cite. Passages come from the Related notes index; the answer comes from the engine chosen for “Chat” in Settings → AI, which is named under every answer.",
    });
    new Setting(containerEl)
      .setName("Folder for saved conversations")
      .setDesc("“Save conversation as note” creates notes here.")
      .addText((t) =>
        t.setPlaceholder("AI chats").setValue(this.owner.options.conversationFolder).onChange((v) => {
          this.owner.options.conversationFolder = v.trim();
          void this.owner.instance.saveOptions?.();
        }),
      );
  }
}
