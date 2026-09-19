/**
 * `window.i18next` — Obsidian exposes its i18next instance as a global, and
 * plugins borrow its interface strings instead of translating their own
 * ("Continue" and "Cancel" in Tag Wrangler's dialogs). This is a facade with
 * the part of the i18next surface plugins call: `t` (with `{{var}}`
 * interpolation), `language`, `exists`, `getFixedT`, `changeLanguage`, `on`.
 * Unknown keys return the key, as i18next does.
 */
import { getLanguage } from "./util";

// internal (used by plugins: tag-wrangler) — keys of the app's own strings
const STRINGS: Record<string, string> = {
  "dialogue.button-continue": "Continue",
  "dialogue.button-cancel": "Cancel",
  "dialogue.button-ok": "OK",
  "dialogue.button-done": "Done",
  "dialogue.button-save": "Save",
  "dialogue.button-delete": "Delete",
  "dialogue.button-close": "Close",
  "dialogue.button-yes": "Yes",
  "dialogue.button-no": "No",
  "interface.menu.rename": "Rename",
  "interface.menu.delete": "Delete",
};

function t(key: string | string[], options?: Record<string, unknown> | string): string {
  const keys = Array.isArray(key) ? key : [key];
  const found = keys.find((k) => k in STRINGS);
  const fallback = typeof options === "string" ? options : (options?.defaultValue as string | undefined);
  let text = found ? STRINGS[found]! : (fallback ?? keys[keys.length - 1] ?? "");
  if (options && typeof options === "object") {
    text = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => (name in options ? String(options[name]) : m));
  }
  return text;
}

export const i18next = {
  get language() {
    return getLanguage();
  },
  get languages() {
    return [getLanguage(), "en"];
  },
  isInitialized: true,
  t,
  exists: (key: string) => key in STRINGS,
  getFixedT: () => t,
  changeLanguage: async () => t,
  on: () => {},
  off: () => {},
};
