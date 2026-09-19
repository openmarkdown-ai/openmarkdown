/**
 * Renders ```cardlink blocks (Auto Card Link) and ```embed blocks (Link
 * Embed) as link cards. The DOM uses Auto Card Link's class names, so CSS
 * snippets written for that plugin apply. Images load as plain `<img>`,
 * which needs no CORS. Remote favicons and thumbnails follow "Click to load
 * embeds" (on by default): the card shows its text, and a "Load images"
 * button fetches them, so opening a note contacts no one.
 */
import { setIcon } from "../../obsidian/ui/icons";
import { Notice } from "../../obsidian/ui/notice";
import { parseLinktext, parseYaml } from "../../obsidian/util";
import { embedOptions } from "../media/embeds";

interface CardData {
  url: string;
  title: string;
  description?: string;
  host?: string;
  favicon?: string;
  image?: string;
  indent: number;
}

function isUrl(s: string) {
  return /^(https?:|data:)/i.test(s);
}

function localImage(app: any, link: string, sourcePath: string): string {
  const inner = link.replace(/^!?\[\[/, "").replace(/\]\]$/, "");
  const { path } = parseLinktext(inner.split("|")[0]!);
  const file = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
  return file ? app.vault.getResourcePath(file) : inner;
}

function parse(source: string, kind: "cardlink" | "embed"): CardData {
  let indent = -1;
  const normalised = source
    .split(/\r?\n|\r/g)
    .map((line) =>
      line.replace(/^\t+/g, (tabs) => {
        if (indent < 0) indent = tabs.length;
        return " ".repeat(tabs.length);
      }),
    )
    .join("\n");
  let yaml: Record<string, unknown> | null;
  try {
    yaml = parseYaml(normalised) as Record<string, unknown> | null;
  } catch {
    throw new Error("failed to parse yaml. Check debug console for more detail.");
  }
  const str = (k: string) => (typeof yaml?.[k] === "string" || typeof yaml?.[k] === "number" ? String(yaml[k]) : undefined);
  const url = str("url");
  const title = str("title");
  if (kind === "cardlink" && (!url || !title)) throw new Error("required params[url, title] are not found.");
  if (kind === "embed" && !url) throw new Error("required param url is not found.");
  let host = str("host");
  if (!host && url) {
    try {
      host = new URL(url).hostname;
    } catch {
      /* keep */
    }
  }
  return { url: url!, title: title ?? url!, description: str("description"), host, favicon: str("favicon"), image: str("image"), indent };
}

export function renderCard(app: any, source: string, el: HTMLElement, sourcePath: string, kind: "cardlink" | "embed") {
  let data: CardData;
  try {
    data = parse(source, kind);
  } catch (e) {
    const err = el.createDiv({ cls: "auto-card-link-error-container" });
    err.createSpan({ text: `${kind} error: ${(e as Error).message}` });
    return;
  }
  const container = el.createDiv({ cls: "auto-card-link-container", attr: { "data-auto-card-link-depth": String(data.indent) } });
  const card = container.createEl("a", { cls: "auto-card-link-card", attr: { href: data.url, target: "_blank", rel: "noopener nofollow" } });
  const main = card.createDiv({ cls: "auto-card-link-main" });
  main.createDiv({ cls: "auto-card-link-title", text: data.title });
  if (data.description) main.createDiv({ cls: "auto-card-link-description", text: data.description });
  const hostEl = main.createDiv({ cls: "auto-card-link-host" });
  const deferred: (() => void)[] = [];
  /** Remote images wait for a click while "Click to load embeds" is on; vault and data: images load at once. */
  const image = (value: string, place: (img: HTMLImageElement) => void, cls: string) => {
    const src = isUrl(value) ? value : localImage(app, value, sourcePath);
    const load = () => {
      const img = createEl("img", { cls, attr: { src, draggable: "false", referrerpolicy: "no-referrer", alt: "" } });
      img.addEventListener("error", () => img.remove());
      place(img);
    };
    if (/^https?:/i.test(src) && embedOptions.clickToLoad) deferred.push(load);
    else load();
  };
  if (data.favicon) image(data.favicon, (img) => hostEl.prepend(img), "auto-card-link-favicon");
  if (data.host) hostEl.createSpan({ text: data.host });
  if (data.image) image(data.image, (img) => card.appendChild(img), "auto-card-link-thumbnail");
  if (deferred.length) {
    const load = container.createEl("button", { cls: "auto-card-link-load-images clickable-icon", attr: { "aria-label": `Load images from ${data.host ?? "the web"}`, type: "button" } });
    setIcon(load, "lucide-image");
    load.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      load.remove();
      for (const run of deferred.splice(0)) run();
    });
  }
  const copy = container.createEl("button", { cls: "auto-card-link-copy-url clickable-icon", attr: { "aria-label": `Copy URL\n${data.url}`, type: "button" } });
  setIcon(copy, "lucide-copy");
  copy.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    void navigator.clipboard?.writeText(data.url).then(() => new Notice("URL copied to your clipboard"), () => {});
  });
}
