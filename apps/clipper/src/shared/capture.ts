/** Page capture, injected on demand with `scripting.executeScript` (activeTab). No engine here: the service worker imports it. */
export interface PageCapture {
  url: string;
  title: string;
  html: string;
  selectionHtml: string;
  selectionText: string;
}

/** Runs in the page (injected with `scripting.executeScript`). Must be self-contained. */
export function capturePageInPage(): PageCapture {
  const sel = window.getSelection();
  let selectionHtml = "";
  let selectionText = "";
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const box = document.createElement("div");
    for (let i = 0; i < sel.rangeCount; i++) box.appendChild(sel.getRangeAt(i).cloneContents());
    selectionHtml = box.innerHTML;
    selectionText = sel.toString();
  }
  // Clone so the reader overlay and highlight marks never leak into the clip.
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-vault-clipper]").forEach((el) => el.remove());
  clone.querySelectorAll("mark.vault-clipper-highlight").forEach((m) => m.replaceWith(...Array.from(m.childNodes)));
  // Absolute URLs for lazy images and relative links survive better than the raw attributes.
  return { url: location.href, title: document.title, html: "<!DOCTYPE html>" + clone.outerHTML, selectionHtml, selectionText };
}

export async function capturePage(tabId: number, frameId?: number): Promise<PageCapture> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: frameId !== undefined ? [frameId] : undefined }, func: capturePageInPage });
  if (!res?.result) throw new Error("This page cannot be clipped (the browser does not allow extensions on it).");
  return res.result as PageCapture;
}

