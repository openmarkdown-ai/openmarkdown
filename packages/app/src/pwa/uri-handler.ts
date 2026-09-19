/**
 * `web+obsidian:` link registration. Browsers only let a page claim `web+`
 * schemes (`obsidian:` is not on the safelist and throws). Installed apps get
 * it from the manifest's `protocol_handlers`; a browser tab registers from a
 * button in Settings, since registering on every load prompts repeatedly.
 */
export function registerLinkHandler(): boolean {
  const nav = navigator as Navigator & { registerProtocolHandler?: (scheme: string, url: string) => void };
  if (!window.isSecureContext || typeof nav.registerProtocolHandler !== "function") return false;
  try {
    const base = new URL("./", location.href);
    base.search = "";
    base.hash = "";
    nav.registerProtocolHandler("web+obsidian", `${base.toString()}?uri=%s`);
    return true;
  } catch (e) {
    console.debug("registerProtocolHandler failed", e);
    return false;
  }
}
