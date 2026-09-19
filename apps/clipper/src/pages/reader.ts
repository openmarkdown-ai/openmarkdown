/**
 * Reader view: the page's HTML arrives from content/reader.ts; the engine's
 * extraction picks the article, DOMPurify cleans it, and it renders here, in
 * the extension's origin, where the page's scripts cannot reach.
 */
import DOMPurify from "dompurify";
import { ensureEngine } from "../shared/clip";
import { brandMark, h, iconButton } from "./dom";
import "./ui.css";
import "./reader.css";

const root = document.getElementById("app")!;
const article = h("article", { class: "markdown reader-article" });
const meta = h("p", { class: "reader-meta" });
const title = h("h1", { class: "reader-title" });
const close = () => window.parent.postMessage({ type: "vault-reader-close" }, "*");

root.append(
  h("header", { class: "reader-top" }, brandMark(), iconButton("x", "Close reader view (Esc)", close)),
  h("main", { class: "reader-main" }, h("p", { class: "loading", text: "Reading…" }), title, meta, article),
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") close();
});

window.addEventListener("message", async (e) => {
  if (e.source !== window.parent) return;
  const data = e.data as { type?: string; html?: string; url?: string } | null;
  if (data?.type !== "vault-reader-page" || typeof data.html !== "string" || typeof data.url !== "string") return;
  const engine = await ensureEngine();
  const ex = engine.extract(data.html, data.url);
  root.querySelector(".loading")?.remove();
  title.textContent = String(ex.title || "");
  document.title = String(ex.title || "Reader view");
  meta.textContent = [ex.author, ex.site || ex.domain, ex.published, ex.wordCount ? `${ex.wordCount} words` : ""].filter(Boolean).join(" · ");
  article.innerHTML = DOMPurify.sanitize(String(ex.contentHtml ?? ""), { FORBID_TAGS: ["style", "form", "input", "button", "iframe"], FORBID_ATTR: ["style"] });
  for (const a of article.querySelectorAll("a[href]")) {
    a.setAttribute("target", "_top");
    a.setAttribute("rel", "noopener noreferrer");
  }
});

window.parent.postMessage({ type: "vault-reader-ready" }, "*");
