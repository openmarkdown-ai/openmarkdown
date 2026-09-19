/**
 * The bridge between the web app page and the extension. Registered only for
 * the app origins configured in the options page. It relays the protocol in
 * packages/app/src/companion/protocol.ts verbatim in both directions and adds
 * nothing of its own; the background checks the origin again.
 */
import { APP_SOURCE, EXT_SOURCE, PROTOCOL_VERSION, type AppHello, type AppToExt } from "../../../../packages/app/src/companion/protocol";
import type { RuntimeMessage } from "../shared/messages";

const w = window as unknown as { __vaultCompanionBridge?: { reconnect(): void } };

if (w.__vaultCompanionBridge) {
  w.__vaultCompanionBridge.reconnect();
} else {
  let port: chrome.runtime.Port | null = null;
  let lastHello: AppHello | null = null;

  const toPage = (msg: object) => window.postMessage({ source: EXT_SOURCE, ...msg }, location.origin);

  const connect = (): chrome.runtime.Port | null => {
    try {
      const p = chrome.runtime.connect({ name: "app-bridge" });
      p.onMessage.addListener((msg: object) => toPage(msg));
      p.onDisconnect.addListener(() => {
        if (port === p) port = null;
      });
      port = p;
      if (lastHello) p.postMessage(lastHello);
      return p;
    } catch {
      // The extension was reloaded or removed: this script is orphaned.
      window.removeEventListener("message", onPageMessage);
      return null;
    }
  };

  const onPageMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as ({ source?: string } & AppToExt) | null;
    if (!data || typeof data !== "object" || data.source !== APP_SOURCE || typeof data.type !== "string") return;
    const { source: _source, ...msg } = data;
    if (msg.type === "app-hello") lastHello = msg as AppHello;
    const p = port ?? connect();
    try {
      p?.postMessage(msg);
    } catch {
      connect()?.postMessage(msg);
    }
  };

  const hello = () =>
    toPage({ type: "ext-hello", protocol: PROTOCOL_VERSION, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });

  const reconnect = () => {
    if (!port) connect();
    hello();
  };

  window.addEventListener("message", onPageMessage);
  chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
    if (msg?.kind === "bridge-reconnect") reconnect();
  });
  w.__vaultCompanionBridge = { reconnect };
  connect();
  hello();
}
