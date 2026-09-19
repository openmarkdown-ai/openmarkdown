/**
 * Sharing into and out of the app.
 *
 * In: the manifest's `share_target` POSTs `title`, `text`, `url` and `files`
 * to `./share-target`; the service worker stores them and redirects to
 * `./?share=<id>`. The same fields in a GET query (`?share=1&title=…&text=…&url=…`)
 * work without the worker (a browser that never installed it, or a link).
 * Either way the capture surface opens with the text filled in and the files
 * listed as attachments.
 *
 * Out: "Share current file" and the file menu's "Share" use the Web Share API
 * with the note as a `.md` file where the platform accepts files, else as
 * text, else copy to the clipboard.
 */
import type { App } from "../obsidian/app";
import { Notice } from "../obsidian/ui/notice";
import type { TFile } from "../obsidian/vault/files";
import { pwaStore } from "./store";

export interface IncomingShare {
  id: string | null;
  title: string;
  text: string;
  url: string;
  files: { name: string; type: string; blob: Blob }[];
}

/** Reads a share from the page URL, if this navigation came from the share target. */
export async function takeIncomingShare(params: URLSearchParams): Promise<IncomingShare | null> {
  const id = params.get("share");
  if (id === null) return null;
  if (id && id !== "1" && id !== "true") {
    try {
      const stored = await pwaStore.getShare(id);
      if (stored) return { id, title: stored.title, text: stored.text, url: stored.url, files: stored.files ?? [] };
    } catch (e) {
      console.warn("Could not read the shared item", e);
    }
  }
  const title = params.get("title") ?? "";
  const text = params.get("text") ?? "";
  const url = params.get("url") ?? "";
  if (!title && !text && !url) return id && id !== "1" && id !== "true" ? { id, title: "", text: "", url: "", files: [] } : null;
  return { id: null, title, text, url, files: [] };
}

export async function forgetShare(share: IncomingShare) {
  if (share.id) await pwaStore.deleteShare(share.id).catch(() => {});
}

/** The capture text for a share: a Markdown link when there is a URL, the shared text otherwise. */
export function shareToText(share: Pick<IncomingShare, "title" | "text" | "url">): string {
  const title = share.title.trim();
  let text = share.text.trim();
  let url = share.url.trim();
  // Android puts the link in `text` for many apps.
  if (!url && /^https?:\/\/\S+$/.test(text)) {
    url = text;
    text = "";
  }
  const parts: string[] = [];
  if (url) {
    const label = title && !text.includes(title) ? title : "";
    if (text && !text.includes(url)) parts.push(text, label ? `[${label}](${url})` : url);
    else if (text) parts.push(text);
    else parts.push(label ? `[${label}](${url})` : url);
  } else {
    if (title && !text.includes(title)) parts.push(title);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

/** Shares a note with the Web Share API; falls back to the clipboard. */
export async function shareFile(app: App, file: TFile): Promise<void> {
  const text = await app.vault.cachedRead(file);
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  const attempts: ShareData[] = [];
  if (typeof nav.share === "function") {
    for (const type of ["text/markdown", "text/plain"]) {
      const data: ShareData = { title: file.basename, files: [new File([text], file.name, { type })] };
      if (nav.canShare?.(data)) {
        attempts.push(data);
        break;
      }
    }
    attempts.push({ title: file.basename, text });
  }
  for (const data of attempts) {
    try {
      await nav.share(data);
      return;
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === "AbortError") return;
      if (name !== "NotAllowedError" && name !== "DataError" && name !== "TypeError") {
        console.warn("Share failed", e);
      }
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    new Notice(typeof nav.share === "function" ? "Sharing is not available here, so the note was copied to the clipboard." : "This browser cannot share, so the note was copied to the clipboard.");
  } catch {
    new Notice("This browser cannot share or copy this note.");
  }
}
