/**
 * OpenMarkdown's pre-installed plugins.
 *
 * Obsidian's own core plugins (§3.0 of docs/research/obsidian-features.md) stay
 * core plugins: toggled in Settings → Core plugins, never uninstalled. Every
 * feature OpenMarkdown adds beyond Obsidian is listed here instead. They ship
 * with the app and are installed in every vault, but they are plugins the user
 * may uninstall (and reinstall, offline) from Settings → Community plugins.
 *
 * Each entry is the manifest-like part a definition lacks: author and version
 * (the app's), the community plugins it steps aside for (`replaces`), what an
 * uninstall removes besides `.obsidian/<id>.json`, and the clean-up hook.
 * Plugin ids, command ids and options files are unchanged, so hotkeys,
 * workspaces, tests and other plugins keep working.
 *
 * Clean-up hooks import their plugin's modules lazily, so this file adds
 * nothing heavy to the main bundle.
 */
import type { CorePluginDefinition, PreinstalledInfo } from "../obsidian/app-internals/internal-plugins";
import { APP_VERSION, PRODUCT_NAME } from "../product";

const clearLocal = (app: any, ...keys: string[]) => {
  for (const k of keys) app.saveLocalStorage?.(k, null);
};

export const PREINSTALLED: Record<string, PreinstalledInfo> = {
  // Writing (editor settings stay in Settings → Editor; these are the app-side pieces)
  "formatting-toolbar": { replaces: ["editing-toolbar", "cmenu-plugin"] },
  "writing-focus": {
    replaces: ["remember-cursor-position"],
    removes: ["the remembered cursor positions for notes in this browser"],
    onUninstall: (app) => clearLocal(app, "vault-cursor-memory"),
  },
  grammar: {
    replaces: ["harper", "obsidian-languagetool-plugin"],
    removes: ["the consent to download the grammar model in this browser (your dictionary.txt is kept)"],
    onUninstall: (app) => clearLocal(app, "grammar-model-consent"),
  },
  // Knowledge
  "natural-dates": { replaces: ["nldates-obsidian"] },
  "periodic-notes": { replaces: ["periodic-notes"] },
  calendar: { replaces: ["calendar"] },
  trash: { replaces: ["trash-explorer"] },
  // Paste & media
  "smart-paste": { replaces: ["obsidian-auto-link-title", "url-into-selection", "auto-card-link", "obsidian-link-embed"] },
  media: { replaces: ["media-extended"] },
  "local-images": { replaces: ["obsidian-local-images-plus", "obsidian-local-images"] },
  // Export & write-ups
  export: {},
  citations: {
    replaces: ["obsidian-citation-plugin", "obsidian-zotero-desktop-connector"],
    removes: ["downloaded citation styles and locales in .obsidian/citations"],
    onUninstall: async (app) => {
      const dir = `${app.vault.configDir}/citations`;
      if (await app.vault.adapter.exists(dir)) await app.vault.adapter.rmdir(dir, true);
    },
  },
  // App shell
  "quick-capture": {},
  importer: { replaces: ["obsidian-importer"] },
  // Device & AI
  ocr: {
    replaces: ["text-extractor"],
    removes: ["text recognised from this vault's images and PDFs, cached in this browser"],
    onUninstall: async (app) => {
      const { idb } = await import("../obsidian/vault/idb");
      await idb.deletePrefix("cache", `ocr:${app.appId}:`).catch(() => {});
    },
  },
  voice: {},
  "ai-tools": {},
  reminders: {
    replaces: ["obsidian-reminder-plugin"],
    removes: ["the record of reminders already shown in this browser"],
    onUninstall: (app) => clearLocal(app, "reminders-fired"),
  },
  backup: {
    removes: ["the backup schedule and the chosen backup folder (backup files already made are kept)"],
    onUninstall: async (app) => {
      clearLocal(app, "backup-last");
      const { idb } = await import("../obsidian/vault/idb");
      await idb.delete("handles", `backup-folder:${app.appId}`).catch(() => {});
    },
  },
  opensync: {
    replaces: ["opensync"],
    disconnect: {
      needed: async (app) => {
        const { device } = await import("./opensync/store");
        return !!(await device.get(app.appId).catch(() => undefined));
      },
      title: "Disconnect this vault from sync?",
      message:
        "This vault is synced on this device. Uninstalling Sync also disconnects it: this device's sync keys and sync state for the vault are deleted from this browser. Your notes stay, and other devices keep syncing. To connect again you need your recovery kit.",
      cta: "Disconnect and uninstall",
      run: async (app) => {
        const { forgetVault } = await import("./opensync/store");
        await forgetVault(app.appId);
      },
    },
  },
  semantic: {
    replaces: ["smart-connections"],
    removes: ["the Related notes index (passages and their vectors) kept in this browser"],
    onUninstall: async (app) => {
      clearLocal(app, "semantic-search-by-meaning");
      const { SemanticStore } = await import("./semantic/store");
      await SemanticStore.destroy(`openmarkdown-semantic:${app.appId ?? app.vault?.getName?.() ?? "vault"}`);
    },
  },
  "vault-chat": { replaces: ["smart-connections"] },
  "ai-suggest": {},
  "ai-query": {},
  "ai-review": {},
  transcribe: {
    replaces: ["whisper", "transcription", "scribe"],
    removes: ["cached transcripts of recordings in this browser"],
    onUninstall: async () => {
      const { clearCache } = await import("./transcribe/cache");
      await clearCache().catch(() => {});
    },
  },
};

/** Marks the definitions OpenMarkdown adds as pre-installed plugins. */
export function withPreinstalled(def: CorePluginDefinition): CorePluginDefinition {
  const info = PREINSTALLED[def.id];
  if (!info) return def;
  return { ...def, hidden: false, preinstalled: { author: PRODUCT_NAME, version: APP_VERSION, ...info } };
}
