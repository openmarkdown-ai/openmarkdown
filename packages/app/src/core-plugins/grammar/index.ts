/**
 * Grammar check (`grammar`) — hidden, always-on core plugin behind the
 * `grammarCheck` setting (app.json, off by default).
 *
 * Harper (harper.js, Apache-2.0) runs on this device in WebAssembly, in a
 * worker when the browser allows it. Its 16 MB model is downloaded only after
 * the user agrees, once per device (`grammar-model-consent` in local storage);
 * nothing typed is sent anywhere. The editor side (underlines, suggestions
 * popover) is `editor/grammar-lint.ts`, reaching this plugin through the
 * editor host's `lintGrammar` / `addToDictionary`.
 *
 * The vault dictionary is `.obsidian/dictionary.txt`, one word per line, so it
 * travels with the vault. Steps aside while the Harper or LanguageTool
 * community plugins are enabled.
 *
 * Command: "Toggle grammar and style check" (`editor:toggle-grammar`).
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { ConfirmationModal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import type { GrammarIssue } from "../../editor/grammar-lint";
import type { HarperChecker } from "./harper";

export const GRAMMAR_CONSENT_KEY = "grammar-model-consent";
const COMMUNITY_PLUGINS = ["harper", "obsidian-languagetool-plugin"];
const DICTIONARY = "dictionary.txt";

export class GrammarPlugin extends Plugin {
  instance!: any;
  private checker: Promise<HarperChecker | null> | null = null;
  private askedThisSession = false;
  private dictionary = new Set<string>();

  override onload() {
    const app = this.app;
    this.instance.lint = (text: string) => this.lint(text);
    this.instance.addToDictionary = (word: string) => this.addToDictionary(word);
    this.instance.setEnabled = (on: boolean) => this.setEnabled(on);
    this.instance.isReady = () => !!this.checker;

    this.addCommand({
      id: "editor:toggle-grammar",
      name: "Toggle grammar and style check",
      icon: "lucide-spell-check",
      callback: () => void this.setEnabled(!app.vault.getConfig("grammarCheck")),
    });
  }

  override onunload() {
    void this.checker?.then((c) => c?.dispose()).catch(() => {});
    this.checker = null;
  }

  private consented(): boolean {
    return !!this.app.loadLocalStorage(GRAMMAR_CONSENT_KEY);
  }

  private stepAside(): boolean {
    const enabled = this.app.plugins?.enabledPlugins;
    return COMMUNITY_PLUGINS.some((id) => enabled?.has?.(id));
  }

  /** Turn grammar check on (asking before the first download) or off. Resolves to the new state. */
  async setEnabled(on: boolean): Promise<boolean> {
    if (!on) {
      this.app.vault.setConfig("grammarCheck", false);
      return false;
    }
    if (!this.consented() && !(await this.askConsent())) return false;
    this.app.vault.setConfig("grammarCheck", true);
    if (this.stepAside()) new Notice("Grammar check is paused while the Harper or LanguageTool plugin is enabled.");
    return true;
  }

  private askConsent(): Promise<boolean> {
    return new Promise((resolve) => {
      let answered = false;
      const modal = new ConfirmationModal(this.app);
      modal.addClass("vault-grammar-consent");
      modal.setTitle("Download grammar checker?");
      modal.contentEl.createEl("p", { text: "Grammar check downloads a 16 MB on-device language model once. Nothing you write leaves this device." });
      modal.contentEl.createEl("p", { cls: "setting-item-description", text: "Harper checks English grammar, spelling and style. You can turn it off again in Settings → Editor." });
      modal.addButton((b) =>
        b
          .setButtonText("Download")
          .setCta()
          .onClick(() => {
            answered = true;
            this.app.saveLocalStorage(GRAMMAR_CONSENT_KEY, true);
            resolve(true);
          }),
      );
      modal.addCancelButton();
      modal.onClose = () => {
        if (!answered) resolve(false);
      };
      modal.open();
    });
  }

  private loadChecker(): Promise<HarperChecker | null> {
    if (this.checker) return this.checker;
    const notice = new Notice("Loading grammar checker…", 0);
    this.checker = (async () => {
      try {
        const { loadHarper } = await import("./harper");
        const checker = await loadHarper();
        await this.loadDictionary();
        await checker.addWords([...this.dictionary]);
        return checker;
      } catch (e) {
        console.error("Grammar checker failed to load", e);
        new Notice("Grammar check could not start in this browser.");
        return null;
      } finally {
        notice.hide();
      }
    })();
    return this.checker;
  }

  private async loadDictionary() {
    const path = `${this.app.vault.configDir}/${DICTIONARY}`;
    try {
      if (!(await this.app.vault.adapter.exists(path))) return;
      const text: string = await this.app.vault.adapter.read(path);
      for (const w of text.split(/\r?\n/)) if (w.trim()) this.dictionary.add(w.trim());
    } catch (e) {
      console.error(e);
    }
  }

  async lint(text: string): Promise<GrammarIssue[]> {
    if (!this.app.vault.getConfig("grammarCheck") || this.stepAside()) return [];
    if (!this.consented()) {
      // The setting came from another device's app.json: ask once, on use.
      if (this.askedThisSession) return [];
      this.askedThisSession = true;
      if (!(await this.askConsent())) return [];
    }
    const checker = await this.loadChecker();
    if (!checker) return [];
    const issues = await checker.lint(text);
    return issues.filter((i) => !(this.dictionary.has(i.problem) && /spell/i.test(i.kind)));
  }

  async addToDictionary(word: string): Promise<void> {
    const w = word.trim();
    if (!w || this.dictionary.has(w)) return;
    this.dictionary.add(w);
    const path = `${this.app.vault.configDir}/${DICTIONARY}`;
    try {
      const adapter = this.app.vault.adapter;
      const existing: string = (await adapter.exists(path)) ? await adapter.read(path) : "";
      await adapter.write(path, existing + (existing && !existing.endsWith("\n") ? "\n" : "") + w + "\n");
    } catch (e) {
      console.error("Could not save the dictionary", e);
    }
    const checker = this.checker ? await this.checker : null;
    await checker?.addWords([w]);
  }
}

export const grammar: CorePluginDefinition = {
  id: "grammar",
  name: "Grammar check",
  description: "Grammar and style checking with Harper, on-device.",
  defaultOn: true,
  hidden: true,
  defaultOptions: {},
  create: (app) => new GrammarPlugin(app, { id: "grammar", name: "Grammar check", version: "", minAppVersion: "", author: "", description: "" }),
};
