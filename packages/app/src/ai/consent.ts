/**
 * The one consent dialog every AI feature goes through (`app.ai.ensureConsent`):
 * before a model download, stating its size and source; and before text is
 * first sent off this device, naming the provider.
 */
import { Modal } from "../obsidian/ui/modal";
import { ButtonComponent } from "../obsidian/ui/setting";

export type ConsentAsk =
  | { kind: "download"; feature: string; what: string; size: string | null; from: string }
  | { kind: "cloud"; feature: string; provider: string; model: string; host?: string };

export function askConsent(app: any, ask: ConsentAsk): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const modal = new Modal(app);
    modal.modalEl.addClass("mod-confirmation", "vault-device-consent", "vault-ai-consent");
    modal.modalEl.setAttr("data-consent", ask.kind);
    const c = modal.contentEl;
    let cta: string;
    if (ask.kind === "download") {
      modal.setTitle("Download the on-device model?");
      c.createEl("p", { text: `${ask.feature} runs on this device with ${ask.what}. It needs a one-time download first${ask.size ? `: ${ask.size}` : ""}.` });
      const facts = c.createEl("ul", { cls: "vault-ai-consent-facts" });
      facts.createEl("li", { text: `Downloaded from ${ask.from} and kept in this browser, so it works offline afterwards.` });
      facts.createEl("li", { text: "Your notes are not sent anywhere." });
      facts.createEl("li", { text: "You can delete downloaded models in Settings → AI." });
      cta = ask.size ? `Download (${ask.size})` : "Download";
    } else {
      modal.setTitle(`Send text to ${ask.provider}?`);
      c.createEl("p", { text: `${ask.feature} is set to use ${ask.provider}${ask.model ? ` (${ask.model})` : ""}. When you use it, the text it works on, such as the note or selection, leaves this device and is sent to ${ask.host ?? ask.provider}.` });
      const facts = c.createEl("ul", { cls: "vault-ai-consent-facts" });
      facts.createEl("li", { text: `${ask.provider} handles it under the terms of your account with them.` });
      facts.createEl("li", { text: "Nothing is sent until you use the feature, and only what that feature needs." });
      facts.createEl("li", { text: "Asked once for this feature and engine. Change the engine in Settings → AI." });
      cta = `Send to ${ask.provider}`;
    }
    const buttons = modal.modalEl.createDiv({ cls: "modal-button-container" });
    const ok = new ButtonComponent(buttons).setButtonText(cta).setCta();
    ok.buttonEl.addClass("vault-ai-consent-accept");
    ok.onClick(() => {
      decided = true;
      modal.close();
      resolve(true);
    });
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => modal.close());
    modal.onClose = () => {
      if (!decided) resolve(false);
    };
    modal.open();
    ok.buttonEl.focus();
  });
}
