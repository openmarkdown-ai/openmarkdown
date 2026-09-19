/**
 * Quick capture: turn a line of text (and shared files) into an entry in
 * today's daily note, an inbox note, or a new note — without the vault index.
 *
 * Everything here goes through `CaptureIO`, a handful of adapter calls, so the
 * capture surface can write the moment it opens, before `App.initialize()` has
 * scanned or indexed anything (the thought is saved first; the index catches up
 * when the vault loads). Inside a running app the same code writes through the
 * vault's adapter, which the vault reconciles on each write.
 *
 * Settings live in `.obsidian/quick-capture.json`; the daily note location and
 * template come from `.obsidian/daily-notes.json`, as the Daily notes plugin
 * reads them.
 */
import { moment, normalizePath } from "../../obsidian/util";
import { processTemplateVariables } from "../templates/template-vars";

export type CaptureDestination = "daily" | "inbox" | "new";

export interface QuickCaptureOptions {
  destination: CaptureDestination;
  /** Inbox note path (".md" optional). */
  inboxPath: string;
  /** Folder for "new note" captures ("" = vault root). */
  newNoteFolder: string;
  /** Heading the entry goes under ("" = the whole note). Created if missing. */
  heading: string;
  position: "append" | "prepend";
  /** Moment format put before each entry; "" for none. */
  timestampFormat: string;
  /** Write entries as list items (`- `). */
  bullet: boolean;
}

export const DEFAULT_CAPTURE_OPTIONS: QuickCaptureOptions = {
  destination: "daily",
  inboxPath: "Inbox.md",
  newNoteFolder: "",
  heading: "",
  position: "append",
  timestampFormat: "HH:mm",
  bullet: true,
};

export interface CaptureIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Read-modify-write in one step, when the host can do it atomically (the vault can). */
  process?(path: string, fn: (data: string) => string): Promise<string>;
}

export interface CaptureAttachment {
  name: string;
  data: ArrayBuffer;
}

export interface CaptureRequest {
  text: string;
  attachments?: CaptureAttachment[];
  destination?: CaptureDestination;
  now?: moment.Moment;
}

export interface CaptureResult {
  path: string;
  created: boolean;
  attachments: string[];
}

interface DailyConfig {
  format: string;
  folder: string;
  template: string;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

async function readJson(io: CaptureIO, path: string): Promise<Record<string, unknown> | null> {
  try {
    if (!(await io.exists(path))) return null;
    const data = JSON.parse(await io.read(path));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

export async function loadCaptureOptions(io: CaptureIO, configDir: string): Promise<QuickCaptureOptions> {
  const data = await readJson(io, `${configDir}/quick-capture.json`);
  return { ...DEFAULT_CAPTURE_OPTIONS, ...(data ?? {}) } as QuickCaptureOptions;
}

async function loadDailyConfig(io: CaptureIO, configDir: string, given?: Partial<DailyConfig> | null): Promise<DailyConfig> {
  const data = given ?? ((await readJson(io, `${configDir}/daily-notes.json`)) as Partial<DailyConfig> | null) ?? {};
  const folder = String(data.folder ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  return { format: String(data.format ?? "").trim() || "YYYY-MM-DD", folder, template: String(data.template ?? "").trim() };
}

async function ensureFolder(io: CaptureIO, folder: string) {
  if (!folder) return;
  const segs = folder.split("/");
  for (let i = 1; i <= segs.length; i++) {
    const p = segs.slice(0, i).join("/");
    if (!(await io.exists(p))) await io.mkdir(p);
  }
}

async function availablePath(io: CaptureIO, path: string): Promise<string> {
  if (!(await io.exists(path))) return path;
  const dot = path.lastIndexOf(".");
  const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
  const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = `${stem} ${i}${ext}`;
    if (!(await io.exists(candidate))) return candidate;
  }
}

/** A file name safe on Windows, macOS, Linux and in wikilinks. */
export function safeName(name: string, fallback = "Capture"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return (cleaned || fallback).slice(0, 80).trim();
}

const EMBEDDABLE = /\.(png|jpe?g|gif|bmp|svg|webp|avif|mp3|wav|m4a|ogg|flac|3gp|webm|mp4|mov|ogv|mkv|pdf)$/i;

/** Formats one entry: `- 14:05 text`, continuation lines indented under the bullet. */
export function formatEntry(text: string, opts: QuickCaptureOptions, now: moment.Moment, links: string[] = []): string {
  const stamp = opts.timestampFormat ? now.format(opts.timestampFormat) : "";
  const lines = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  const body = [...lines];
  if (links.length) {
    if (body.length === 1 && body[0] === "") body[0] = links.join(" ");
    else body.push(links.join(" "));
  }
  const first = [stamp, body[0] ?? ""].filter(Boolean).join(" ");
  if (!opts.bullet) return [first, ...body.slice(1)].join("\n");
  return [`- ${first}`, ...body.slice(1).map((l) => (l ? `  ${l}` : ""))].join("\n");
}

/** Inserts `entry` into a note, under `heading` when given; keeps frontmatter first. */
export function insertEntry(note: string, entry: string, position: "append" | "prepend", heading: string): string {
  const eol = note.includes("\r\n") ? "\r\n" : "\n";
  const lines = note === "" ? [] : note.split(/\r?\n/);
  const trailingNewline = note === "" || /\r?\n$/.test(note);
  if (trailingNewline && lines.length && lines[lines.length - 1] === "") lines.pop();
  const entryLines = entry.split("\n");

  let fmEnd = 0;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) fmEnd = close + 1;
  }

  const wanted = heading.trim().replace(/^#+\s*/, "");
  if (!wanted) {
    if (position === "prepend") lines.splice(fmEnd, 0, ...entryLines);
    else lines.push(...entryLines);
    return lines.join(eol) + eol;
  }

  const level = (/^(#+)/.exec(heading.trim())?.[1] ?? "##").length;
  let at = -1;
  let atLevel = level;
  let inFence = false;
  for (let i = fmEnd; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]!);
    if (m && m[2]!.trim().toLowerCase() === wanted.toLowerCase()) {
      at = i;
      atLevel = m[1]!.length;
      break;
    }
  }
  if (at === -1) {
    while (lines.length > fmEnd && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines.length > fmEnd) lines.push("");
    lines.push(`${"#".repeat(level)} ${wanted}`, ...entryLines);
    return lines.join(eol) + eol;
  }
  if (position === "prepend") {
    lines.splice(at + 1, 0, ...entryLines);
    return lines.join(eol) + eol;
  }
  let end = lines.length;
  inFence = false;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s/.exec(lines[i]!);
    if (m && m[1]!.length <= atLevel) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > at + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  lines.splice(insertAt, 0, ...entryLines);
  return lines.join(eol) + eol;
}

export async function dailyNotePath(io: CaptureIO, configDir: string, now: moment.Moment, daily?: Partial<DailyConfig> | null): Promise<string> {
  const cfg = await loadDailyConfig(io, configDir, daily);
  const name = now.format(cfg.format);
  return normalizePath(cfg.folder ? `${cfg.folder}/${name}.md` : `${name}.md`);
}

async function attachmentFolder(io: CaptureIO, configDir: string, notePath: string): Promise<string> {
  const app = await readJson(io, `${configDir}/app.json`);
  const setting = String(app?.attachmentFolderPath ?? "/").trim();
  const noteDir = parentOf(notePath);
  if (setting === "" || setting === "/") return "";
  if (setting === "./") return noteDir;
  if (setting.startsWith("./")) return normalizePath(noteDir ? `${noteDir}/${setting.slice(2)}` : setting.slice(2));
  return normalizePath(setting);
}

export interface CaptureContext {
  io: CaptureIO;
  configDir: string;
  options: QuickCaptureOptions;
  /** Daily notes settings when the plugin is loaded; read from disk otherwise. */
  daily?: Partial<DailyConfig> | null;
}

export async function capture(ctx: CaptureContext, req: CaptureRequest): Promise<CaptureResult> {
  const { io, configDir } = ctx;
  const opts = { ...ctx.options, ...(req.destination ? { destination: req.destination } : {}) };
  const now = req.now ?? moment();
  const text = req.text ?? "";

  let path: string;
  let initial = "";
  if (opts.destination === "daily") {
    path = await dailyNotePath(io, configDir, now, ctx.daily);
    if (!(await io.exists(path))) {
      const cfg = await loadDailyConfig(io, configDir, ctx.daily);
      if (cfg.template) {
        const tpl = /\.md$/i.test(cfg.template) ? cfg.template : `${cfg.template}.md`;
        try {
          if (await io.exists(normalizePath(tpl))) {
            const raw = await io.read(normalizePath(tpl));
            const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
            initial = processTemplateVariables(raw, { title, dateFormat: cfg.format, timeFormat: "HH:mm", date: now });
          }
        } catch {
          initial = "";
        }
      }
    }
  } else if (opts.destination === "inbox") {
    path = normalizePath(opts.inboxPath || DEFAULT_CAPTURE_OPTIONS.inboxPath);
    if (!/\.md$/i.test(path)) path += ".md";
  } else {
    const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
    const name = safeName(firstLine, `Capture ${now.format("YYYY-MM-DD HHmmss")}`);
    const folder = normalizePath(opts.newNoteFolder || "").replace(/^\/$/, "");
    path = await availablePath(io, normalizePath(folder && folder !== "/" ? `${folder}/${name}.md` : `${name}.md`));
  }
  if (path.split("/").includes("..")) throw new Error('The capture path cannot contain "..".');

  // Attachments first, so the entry can link to their final names.
  const saved: string[] = [];
  for (const file of req.attachments ?? []) {
    const folder = await attachmentFolder(io, configDir, path);
    await ensureFolder(io, folder);
    const target = await availablePath(io, normalizePath(folder ? `${folder}/${safeName(file.name, "Shared file")}` : safeName(file.name, "Shared file")));
    await io.writeBinary(target, file.data);
    saved.push(target);
  }
  const links = saved.map((p) => {
    const name = p.slice(p.lastIndexOf("/") + 1);
    return EMBEDDABLE.test(name) ? `![[${name}]]` : `[[${name}]]`;
  });

  await ensureFolder(io, parentOf(path));
  const exists = await io.exists(path);
  if (opts.destination === "new") {
    const body = [text.replace(/\s+$/, ""), links.join(" ")].filter(Boolean).join("\n\n");
    await io.write(path, body + "\n");
    return { path, created: true, attachments: saved };
  }
  const entry = formatEntry(text, opts, now, links);
  if (exists && io.process) {
    await io.process(path, (before) => insertEntry(before, entry, opts.position, opts.heading));
  } else {
    const before = exists ? await io.read(path) : initial;
    await io.write(path, insertEntry(before, entry, opts.position, opts.heading));
  }
  return { path, created: !exists, attachments: saved };
}

/** A `CaptureIO` over any object with the `DataAdapter` methods. */
export function adapterIO(adapter: {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
  write(p: string, d: string): Promise<void>;
  writeBinary(p: string, d: ArrayBuffer): Promise<void>;
  mkdir(p: string): Promise<void>;
}): CaptureIO {
  return {
    exists: (p) => adapter.exists(p),
    read: (p) => adapter.read(p),
    write: (p, d) => adapter.write(p, d),
    writeBinary: (p, d) => adapter.writeBinary(p, d),
    mkdir: (p) => adapter.mkdir(p),
  };
}
