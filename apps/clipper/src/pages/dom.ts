/** A few DOM helpers for the extension pages (no UI framework). */
import arrowDown from "lucide-static/icons/arrow-down.svg";
import arrowUp from "lucide-static/icons/arrow-up.svg";
import bookOpen from "lucide-static/icons/book-open.svg";
import check from "lucide-static/icons/check.svg";
import copy from "lucide-static/icons/copy.svg";
import download from "lucide-static/icons/download.svg";
import fileText from "lucide-static/icons/file-text.svg";
import highlighter from "lucide-static/icons/highlighter.svg";
import panelRight from "lucide-static/icons/panel-right.svg";
import plus from "lucide-static/icons/plus.svg";
import settings from "lucide-static/icons/settings.svg";
import trash from "lucide-static/icons/trash-2.svg";
import upload from "lucide-static/icons/upload.svg";
import x from "lucide-static/icons/x.svg";
import { PRODUCT_NAME } from "../../../../packages/app/src/product";

const ICONS = { arrowDown, arrowUp, bookOpen, check, copy, download, fileText, highlighter, panelRight, plus, settings, trash, upload, x };
export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = ICONS[name].replace(/<!--[\s\S]*?-->/, "").trim();
  const svg = tpl.content.firstElementChild as SVGElement;
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

type Attrs = Record<string, string | number | boolean | undefined | null> & { class?: string; text?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export function iconButton(name: IconName, label: string, onClick: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
  const b = h("button", { type: "button", class: `oa-icon-btn ${cls}`.trim(), "aria-label": label, title: label });
  b.append(icon(name));
  b.addEventListener("click", onClick);
  return b;
}

export function button(label: string, onClick: (e: MouseEvent) => void, variant: "primary" | "secondary" | "ghost" | "danger" = "secondary", iconName?: IconName): HTMLButtonElement {
  const b = h("button", { type: "button", class: `oa-btn oa-btn--${variant}` });
  if (iconName) b.append(icon(iconName, 14));
  b.append(label);
  b.addEventListener("click", onClick);
  return b;
}

/** The wordmark: muted "Open", the product word, and the accent full stop. */
export function brandMark(): HTMLElement {
  const word = PRODUCT_NAME.startsWith("Open") ? PRODUCT_NAME.slice(4) : PRODUCT_NAME;
  const tile = h("span", { class: "brand-tile", "aria-hidden": "true" });
  tile.append(icon("fileText", 12));
  return h(
    "span",
    { class: "brand" },
    tile,
    h("span", { class: "brand-word" }, PRODUCT_NAME.startsWith("Open") ? h("span", { class: "muted", text: "Open" }) : null, word, h("span", { class: "dot", text: "." })),
  );
}

export function downloadText(filename: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export { PRODUCT_NAME };
