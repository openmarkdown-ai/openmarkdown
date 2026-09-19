/** Chromium offscreen document: builds a note for quick clip (the service worker has no DOM and runs no wasm). */
import { assembleNote, buildClip } from "../shared/clip";
import type { RuntimeMessage } from "../shared/messages";

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg?.kind !== "build-note" || msg.target !== "offscreen") return false;
  buildClip(msg.page, msg.template, { settings: msg.settings, highlights: msg.highlights })
    .then((draft) => sendResponse(assembleNote(draft, msg.settings)))
    .catch((e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});
