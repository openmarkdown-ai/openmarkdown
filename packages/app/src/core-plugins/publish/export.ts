/**
 * Gathering vault content for export and calling the Rust exporter
 * (`getEngine().publish`, crates/vault-publish), with a TypeScript fallback
 * built on `getEngine().render` for builds where the exporter is not wired.
 *
 * Engine input shapes (see `NoteExportInput` / `SiteExportInput` in
 * packages/engine/src/index.ts):
 *
 *   exportNote({ path, files: [{ path, text | bytes, mtime, ctime }],
 *                options: { title, strictLineBreaks, inlineTitle } }) → HTML string
 *   exportSite({ files: [...], options: { siteName, home, strictLineBreaks,
 *                hideTitle } }) → [{ path, data: Uint8Array }]
 */
import { getEngine, type PublishFile } from "@vault/engine";
import type { TFile } from "../../obsidian/vault/files";
import { getFrontMatterInfo, parseLinktext, sanitizeHTMLToDom } from "../../obsidian/util";
import { mimeFor } from "../../obsidian/vault/resource";

export interface NoteInput {
  path: string;
  content: string;
  mtime?: number;
}

export interface AttachmentInput {
  path: string;
  data: Uint8Array;
}

export interface SiteOptions {
  siteName: string;
  homepage: string;
  includeFolders: string[];
  excludeFolders: string[];
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"]);
const MEDIA_EXT = new Set([...IMAGE_EXT, "mp3", "wav", "m4a", "ogg", "3gp", "flac", "webm", "mp4", "ogv", "mov", "mkv", "pdf"]);

function inFolder(path: string, folder: string): boolean {
  const f = folder.replace(/^\/+|\/+$/g, "");
  return f === "" || path === f || path.startsWith(f + "/");
}

/** Notes selected for a site: folder filters, overridden by `publish: true|false`. */
export function selectSiteNotes(app: any, opts: SiteOptions): TFile[] {
  return (app.vault.getMarkdownFiles() as TFile[]).filter((file) => {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    const flag = fm?.publish;
    if (flag === true || flag === "true") return true;
    if (flag === false || flag === "false") return false;
    const included = opts.includeFolders.length === 0 || opts.includeFolders.some((f) => inFolder(file.path, f));
    const excluded = opts.excludeFolders.some((f) => f.trim() && inFolder(file.path, f));
    return included && !excluded;
  });
}

/** Attachment files embedded or linked from `notes`. */
export function referencedAttachments(app: any, notes: TFile[]): TFile[] {
  const out = new Map<string, TFile>();
  for (const note of notes) {
    const cache = app.metadataCache.getFileCache(note);
    for (const ref of [...(cache?.embeds ?? []), ...(cache?.links ?? [])]) {
      const target: TFile | null = app.metadataCache.getFirstLinkpathDest(parseLinktext(ref.link).path, note.path);
      if (target && target.extension !== "md" && MEDIA_EXT.has(target.extension.toLowerCase())) out.set(target.path, target);
    }
  }
  return [...out.values()];
}

export async function readNotes(app: any, files: TFile[]): Promise<NoteInput[]> {
  return Promise.all(files.map(async (f) => ({ path: f.path, content: await app.vault.cachedRead(f), mtime: f.stat.mtime })));
}

export async function readAttachments(app: any, files: TFile[]): Promise<AttachmentInput[]> {
  const out: AttachmentInput[] = [];
  for (const f of files) {
    try {
      out.push({ path: f.path, data: new Uint8Array(await app.vault.readBinary(f)) });
    } catch {
      /* unreadable attachment: skip */
    }
  }
  return out;
}

// ---- engine calls ---------------------------------------------------------------

/** Notes `file` embeds, followed `depth` levels deep (the note itself first). */
function embeddedNotes(app: any, file: TFile, depth = 3): TFile[] {
  const out = new Map<string, TFile>([[file.path, file]]);
  let frontier = [file];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: TFile[] = [];
    for (const note of frontier) {
      for (const e of app.metadataCache.getFileCache(note)?.embeds ?? []) {
        const target: TFile | null = app.metadataCache.getFirstLinkpathDest(parseLinktext(e.link).path, note.path);
        if (target && target.extension === "md" && !out.has(target.path)) {
          out.set(target.path, target);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  return [...out.values()];
}

function publishFiles(notes: NoteInput[], attachments: AttachmentInput[], stats: Map<string, TFile>): PublishFile[] {
  return [
    ...notes.map((n) => ({ path: n.path, text: n.content, mtime: n.mtime ?? stats.get(n.path)?.stat.mtime ?? 0, ctime: stats.get(n.path)?.stat.ctime ?? 0 })),
    ...attachments.map((a) => ({ path: a.path, bytes: a.data, mtime: stats.get(a.path)?.stat.mtime ?? 0, ctime: stats.get(a.path)?.stat.ctime ?? 0 })),
  ];
}

export async function exportNoteHtml(app: any, file: TFile): Promise<string> {
  const content = await app.vault.cachedRead(file);
  const noteFiles = embeddedNotes(app, file);
  const attachmentFiles = referencedAttachments(app, noteFiles);
  const attachments = await readAttachments(app, attachmentFiles);
  const options = { strictLineBreaks: !!app.vault.getConfig("strictLineBreaks"), inlineTitle: app.vault.getConfig("showInlineTitle") !== false, title: file.basename };
  try {
    const notes = await readNotes(app, noteFiles);
    const stats = new Map<string, TFile>([...noteFiles, ...attachmentFiles].map((f) => [f.path, f]));
    const html = getEngine().publish.exportNote({ path: file.path, files: publishFiles(notes, attachments, stats), options });
    if (typeof html === "string" && html) return html;
  } catch {
    /* fall back */
  }
  return fallbackNoteHtml(app, file, content, attachments, options);
}

export async function exportSiteFiles(app: any, opts: SiteOptions, onProgress?: (msg: string) => void): Promise<{ path: string; data: Uint8Array | string }[]> {
  const files = selectSiteNotes(app, opts);
  onProgress?.(`Reading ${files.length} notes…`);
  const notes = await readNotes(app, files);
  const attachmentFiles = referencedAttachments(app, files);
  onProgress?.(`Reading ${attachmentFiles.length} attachments…`);
  const attachments = await readAttachments(app, attachmentFiles);
  const options = { strictLineBreaks: !!app.vault.getConfig("strictLineBreaks"), inlineTitle: app.vault.getConfig("showInlineTitle") !== false };
  onProgress?.("Building site…");
  try {
    // Notes are already selected (folder filters + `publish:`); site extras from the vault root ride along.
    const extras: AttachmentInput[] = [];
    for (const name of ["publish.css", "favicon.ico", "favicon-32x32.png", "favicon-32.png", "favicon.png", "favicon.svg"]) {
      const f: TFile | null = app.vault.getFileByPath?.(name) ?? null;
      if (f && !attachments.some((a) => a.path === f.path)) extras.push(...(await readAttachments(app, [f])));
    }
    const stats = new Map<string, TFile>([...files, ...attachmentFiles].map((f) => [f.path, f]));
    const out = getEngine().publish.exportSite({
      files: publishFiles(notes, [...attachments, ...extras], stats),
      options: { siteName: opts.siteName || app.vault.getName(), home: opts.homepage || undefined, strictLineBreaks: options.strictLineBreaks, hideTitle: !options.inlineTitle },
    });
    if (Array.isArray(out) && out.length) return out;
  } catch {
    /* fall back */
  }
  return fallbackSite(app, opts, notes, attachments, options);
}

// ---- TypeScript fallback ------------------------------------------------------------

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#222;--muted:#666;--accent:#7c3aed;--border:#e2e2e2;--code:#f5f5f5}
@media (prefers-color-scheme:dark){:root{--bg:#1e1e1e;--fg:#dadada;--muted:#999;--accent:#a78bfa;--border:#333;--code:#2a2a2a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.site{display:flex;min-height:100vh}.site-nav{width:260px;flex:none;border-right:1px solid var(--border);padding:24px 16px;overflow:auto;position:sticky;top:0;height:100vh;font-size:14px}
.site-nav h2{font-size:15px;margin:0 0 12px}.site-nav ul{list-style:none;padding-left:12px;margin:0}.site-nav>ul{padding:0}.site-nav li{margin:2px 0}.site-nav .folder{color:var(--muted);margin-top:8px}
.site-nav a.is-active{font-weight:600}
main{flex:1;min-width:0;padding:32px 24px}.markdown-rendered{max-width:760px;margin:0 auto}
@media (max-width:760px){.site{display:block}.site-nav{position:static;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--border)}}
a{color:var(--accent)}a.is-unresolved{opacity:.6;text-decoration:none;cursor:default}
img,video{max-width:100%}pre{background:var(--code);padding:12px;border-radius:6px;overflow:auto}code{background:var(--code);padding:0 3px;border-radius:3px}pre code{padding:0}
blockquote{border-left:3px solid var(--accent);margin:0;padding-left:16px;color:var(--muted)}table{border-collapse:collapse}td,th{border:1px solid var(--border);padding:4px 8px}
.callout{border-left:4px solid var(--accent);background:var(--code);padding:8px 12px;border-radius:4px;margin:1em 0}.callout-title{font-weight:600}
mark{background:#ffe066;color:#222}.tag{background:var(--code);border-radius:10px;padding:0 6px;text-decoration:none;font-size:.9em}
.task-list-item{list-style:none}.task-list-item-checkbox{margin-inline-start:-1.4em;margin-inline-end:.4em}
.embed-note{border-left:2px solid var(--border);padding-left:12px;margin:1em 0}.footnotes{font-size:.9em;color:var(--muted)}
h1.inline-title{margin-top:0}
`;

interface RenderOptions {
  strictLineBreaks: boolean;
  inlineTitle: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function bodyOf(content: string): string {
  const info = getFrontMatterInfo(content);
  return info.exists ? content.slice(info.contentStart) : content;
}

function renderMarkdown(text: string, strict: boolean): string {
  return getEngine()
    .render(text, { strictLineBreaks: strict })
    .map((s) => s.html)
    .join("\n");
}

function htmlPathFor(notePath: string): string {
  return notePath.replace(/\.md$/i, ".html");
}

function relative(fromFile: string, toFile: string): string {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.slice(i).map(() => "..");
  return [...up, ...to.slice(i)].map((s) => (s === ".." ? s : encodeURIComponent(s))).join("/");
}

function slugHeading(h: string): string {
  return h.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
}

/**
 * Resolve links and embeds in rendered HTML. `hrefFor` returns the href for a
 * resolved note or attachment path, or null when it is not part of the export.
 */
function postProcess(
  app: any,
  html: string,
  sourcePath: string,
  hrefFor: (path: string, isNote: boolean) => string | null,
  embedNote: (file: TFile, subpath: string) => string | null,
): string {
  const frag = sanitizeHTMLToDom(html);
  const root = document.createElement("div");
  root.appendChild(frag);
  root.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
    const { path, subpath } = parseLinktext(a.getAttribute("data-href") ?? "");
    const target: TFile | null = path ? app.metadataCache.getFirstLinkpathDest(path, sourcePath) : app.vault.getFileByPath(sourcePath);
    const href = target ? hrefFor(target.path, target.extension === "md") : null;
    a.removeAttribute("target");
    a.removeAttribute("data-href");
    if (href === null) {
      a.removeAttribute("href");
      a.classList.add("is-unresolved");
    } else {
      a.setAttribute("href", href + (subpath && !subpath.startsWith("#^") ? "#" + slugHeading(subpath.slice(1)) : ""));
    }
  });
  root.querySelectorAll<HTMLElement>("span.internal-embed").forEach((span) => {
    const { path, subpath } = parseLinktext(span.getAttribute("src") ?? "");
    const alt = span.getAttribute("alt") ?? "";
    const target: TFile | null = path ? app.metadataCache.getFirstLinkpathDest(path, sourcePath) : null;
    if (!target) {
      span.replaceWith(Object.assign(document.createElement("span"), { className: "is-unresolved", textContent: path }));
      return;
    }
    const ext = target.extension.toLowerCase();
    if (ext === "md") {
      const inner = embedNote(target, subpath);
      const div = document.createElement("div");
      div.className = "embed-note";
      if (inner === null) {
        const a = document.createElement("a");
        const href = hrefFor(target.path, true);
        if (href) a.href = href;
        a.textContent = target.basename;
        div.appendChild(a);
      } else div.innerHTML = inner;
      span.replaceWith(div);
      return;
    }
    const src = hrefFor(target.path, false);
    if (!src) {
      span.replaceWith(Object.assign(document.createElement("span"), { textContent: target.name }));
      return;
    }
    let el: HTMLElement;
    if (IMAGE_EXT.has(ext)) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = /^\d+(x\d+)?$/.test(alt) ? target.basename : alt || target.basename;
      const m = /^(\d+)(?:x(\d+))?$/.exec(alt);
      if (m) {
        img.width = Number(m[1]);
        if (m[2]) img.height = Number(m[2]);
      }
      el = img;
    } else if (["mp3", "wav", "m4a", "ogg", "3gp", "flac"].includes(ext)) {
      el = Object.assign(document.createElement("audio"), { controls: true, src });
    } else if (["mp4", "webm", "ogv", "mov", "mkv"].includes(ext)) {
      el = Object.assign(document.createElement("video"), { controls: true, src });
    } else {
      el = Object.assign(document.createElement("a"), { href: src, textContent: target.name });
    }
    span.replaceWith(el);
  });
  root.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6").forEach((h) => {
    if (!h.id) h.id = slugHeading(h.getAttribute("data-heading") ?? h.textContent ?? "");
  });
  root.querySelectorAll<HTMLElement>(".callout-content[style]").forEach((c) => c.removeAttribute("style"));
  return root.innerHTML;
}

function page(title: string, body: string, css: string, nav = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${css}
</head>
<body>
<div class="site">${nav}<main><article class="markdown-rendered">
${body}
</article></main></div>
</body>
</html>
`;
}

function toDataUri(data: Uint8Array, path: string): string {
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return `data:${mimeFor(path)};base64,${btoa(s)}`;
}

function sliceSubpath(app: any, file: TFile, text: string, subpath: string): string {
  if (!subpath) return bodyOf(text);
  const cache = app.metadataCache.getFileCache(file);
  const res = cache ? getEngine().resolveSubpath(cache, subpath) : null;
  if (!res) return "";
  return text.slice(res.start.offset, res.end ? res.end.offset : text.length);
}

export function fallbackNoteHtml(app: any, file: TFile, content: string, attachments: AttachmentInput[], options: RenderOptions & { title: string }): string {
  let html: string;
  try {
    html = renderMarkdown(bodyOf(content), options.strictLineBreaks);
  } catch {
    throw new Error("Export needs the vault engine, which is not available in this build.");
  }
  const byPath = new Map(attachments.map((a) => [a.path, a]));
  const body = postProcess(
    app,
    html,
    file.path,
    (path, isNote) => {
      if (isNote) return path === file.path ? "" : null;
      const a = byPath.get(path);
      return a ? toDataUri(a.data, path) : null;
    },
    () => null,
  );
  const title = options.inlineTitle ? `<h1 class="inline-title">${escapeHtml(options.title)}</h1>\n` : "";
  return page(options.title, title + body, `<style>${BASE_CSS}</style>`);
}

function navTree(paths: string[], current: string, homepage: string): string {
  interface Node {
    folders: Map<string, Node>;
    files: string[];
  }
  const root: Node = { folders: new Map(), files: [] };
  for (const p of paths) {
    const segs = p.split("/");
    let n = root;
    for (const s of segs.slice(0, -1)) {
      if (!n.folders.has(s)) n.folders.set(s, { folders: new Map(), files: [] });
      n = n.folders.get(s)!;
    }
    n.files.push(p);
  }
  const target = (p: string) => (p === homepage ? "index.html" : htmlPathFor(p));
  const render = (n: Node): string => {
    const items: string[] = [];
    for (const [name, child] of [...n.folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      items.push(`<li><div class="folder">${escapeHtml(name)}</div>${render(child)}</li>`);
    }
    for (const p of n.files.sort((a, b) => a.localeCompare(b))) {
      const name = p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "");
      const cls = p === current ? ' class="is-active"' : "";
      items.push(`<li><a${cls} href="${relative(current === homepage ? "index.html" : htmlPathFor(current), target(p))}">${escapeHtml(name)}</a></li>`);
    }
    return `<ul>${items.join("")}</ul>`;
  };
  return render(root);
}

export function fallbackSite(app: any, opts: SiteOptions, notes: NoteInput[], attachments: AttachmentInput[], options: RenderOptions): { path: string; data: Uint8Array | string }[] {
  try {
    getEngine().render("", { strictLineBreaks: false });
  } catch {
    throw new Error("Export needs the vault engine, which is not available in this build.");
  }
  const notePaths = new Set(notes.map((n) => n.path));
  const attachmentPaths = new Set(attachments.map((a) => a.path));
  const homepage = notePaths.has(opts.homepage) ? opts.homepage : "";
  const outputPath = (p: string) => (p === homepage ? "index.html" : htmlPathFor(p));
  const contents = new Map(notes.map((n) => [n.path, n.content]));
  const out: { path: string; data: Uint8Array | string }[] = [];
  const paths = notes.map((n) => n.path);
  const siteTitle = opts.siteName || app.vault.getName();

  for (const note of notes) {
    const self = outputPath(note.path);
    const cssHref = relative(self, "style.css");
    const hrefFor = (path: string, isNote: boolean) => {
      if (isNote) return notePaths.has(path) ? relative(self, outputPath(path)) : null;
      return attachmentPaths.has(path) ? relative(self, path) : null;
    };
    const embedNote = (file: TFile, subpath: string): string | null => {
      const text = contents.get(file.path);
      if (text === undefined) return null;
      try {
        return postProcess(app, renderMarkdown(sliceSubpath(app, file, text, subpath), options.strictLineBreaks), file.path, hrefFor, () => null);
      } catch {
        return null;
      }
    };
    const body = postProcess(app, renderMarkdown(bodyOf(note.content), options.strictLineBreaks), note.path, hrefFor, embedNote);
    const name = note.path.slice(note.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    const title = options.inlineTitle ? `<h1 class="inline-title">${escapeHtml(name)}</h1>\n` : "";
    const nav = `<nav class="site-nav"><h2><a href="${relative(self, "index.html")}">${escapeHtml(siteTitle)}</a></h2>${navTree(paths, note.path, homepage)}</nav>`;
    out.push({ path: self, data: page(`${name} - ${siteTitle}`, title + body, `<link rel="stylesheet" href="${cssHref}">`, nav) });
  }
  if (!homepage) {
    const nav = `<nav class="site-nav"><h2>${escapeHtml(siteTitle)}</h2>${navTree(paths, "index.html", "")}</nav>`;
    const list = paths
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((p) => `<li><a href="${relative("index.html", htmlPathFor(p))}">${escapeHtml(p.replace(/\.md$/i, ""))}</a></li>`)
      .join("\n");
    out.push({ path: "index.html", data: page(siteTitle, `<h1>${escapeHtml(siteTitle)}</h1>\n<ul>\n${list}\n</ul>`, `<link rel="stylesheet" href="style.css">`, nav) });
  }
  out.push({ path: "style.css", data: BASE_CSS });
  for (const a of attachments) out.push({ path: a.path, data: a.data });
  return out;
}
