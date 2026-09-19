/**
 * Reader view, injected on demand; injecting again closes it. The page's HTML
 * goes to reader.html (an extension page in a full-window frame), which runs
 * the engine's extraction and renders the cleaned article. Nothing the page
 * can script runs inside the frame.
 */
const w = window as unknown as { __vaultClipperReader?: { close(): void } };

if (w.__vaultClipperReader) {
  w.__vaultClipperReader.close();
} else {
  const readerUrl = chrome.runtime.getURL("reader.html");
  const extOrigin = new URL(readerUrl).origin;
  const frame = document.createElement("iframe");
  frame.dataset.vaultClipper = "";
  frame.src = readerUrl;
  frame.setAttribute("title", "Reader view");
  frame.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483647;background:#f2f2f2;color-scheme:light";
  const prevOverflow = document.documentElement.style.overflow;

  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-vault-clipper]").forEach((el) => el.remove());
  const html = "<!DOCTYPE html>" + clone.outerHTML;

  const onMessage = (e: MessageEvent) => {
    if (e.origin !== extOrigin || e.source !== frame.contentWindow) return;
    const data = e.data as { type?: string } | null;
    if (data?.type === "vault-reader-ready") frame.contentWindow!.postMessage({ type: "vault-reader-page", html, url: location.href }, extOrigin);
    else if (data?.type === "vault-reader-close") close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  function close() {
    window.removeEventListener("message", onMessage);
    document.removeEventListener("keydown", onKey, true);
    frame.remove();
    document.documentElement.style.overflow = prevOverflow;
    delete w.__vaultClipperReader;
  }

  window.addEventListener("message", onMessage);
  document.addEventListener("keydown", onKey, true);
  document.documentElement.style.overflow = "hidden";
  document.documentElement.appendChild(frame);
  w.__vaultClipperReader = { close };
}
