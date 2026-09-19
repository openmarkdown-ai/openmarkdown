/**
 * TypeScript importers for the formats that need no heavy parsing, used when
 * the Rust importer (`getEngine().importer.run`) is not available.
 */
import { htmlToMarkdown, stringifyYaml } from "../../obsidian/util";

export interface InputFile {
  path: string;
  data: Uint8Array;
}

export interface OutputFile {
  path: string;
  data: Uint8Array | string;
  ctimeMs?: number;
  mtimeMs?: number;
}

export interface ImportOutput {
  files: OutputFile[];
  warnings: string[];
}

const decoder = new TextDecoder();

function ext(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "Untitled";
}

/** Drop the folder name a directory picker prefixes to every relative path. */
export function stripCommonRoot(files: InputFile[]): InputFile[] {
  if (files.length === 0) return files;
  const first = files[0]!.path.split("/")[0]!;
  if (!files.every((f) => f.path.includes("/") && f.path.split("/")[0] === first)) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

const HIDDEN = /(^|\/)(\.|__MACOSX\/)/;

export function importMarkdown(files: InputFile[]): ImportOutput {
  const out: ImportOutput = { files: [], warnings: [] };
  for (const f of stripCommonRoot(files)) {
    if (HIDDEN.test(f.path)) continue;
    const e = ext(f.path);
    if (e === "md" || e === "markdown" || e === "txt") {
      const path = e === "md" ? f.path : f.path.replace(/\.[^.]+$/, ".md");
      out.files.push({ path, data: decoder.decode(f.data) });
    } else {
      out.files.push({ path: f.path, data: f.data });
    }
  }
  return out;
}

export function importHtml(files: InputFile[]): ImportOutput {
  const out: ImportOutput = { files: [], warnings: [] };
  const inputs = stripCommonRoot(files);
  for (const f of inputs) {
    if (HIDDEN.test(f.path)) continue;
    const e = ext(f.path);
    if (e !== "html" && e !== "htm") {
      out.files.push({ path: f.path, data: f.data });
      continue;
    }
    const html = decoder.decode(f.data);
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
    const title = doc.title?.trim() || stem(f.path);
    let markdown: string;
    try {
      markdown = htmlToMarkdown(doc.body?.innerHTML ?? "");
    } catch {
      markdown = (doc.body?.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (out.warnings.length === 0) out.warnings.push("HTML was converted to plain text because the Markdown converter is not available.");
    }
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
    out.files.push({ path: `${dir}${sanitizeName(stem(f.path))}.md`, data: `${title !== stem(f.path) ? `# ${title}\n\n` : ""}${markdown.trim()}\n` });
  }
  return out;
}

/** RFC 4180: quoted fields, doubled quotes, CR/LF inside quotes. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  text = text.replace(/^﻿/, "");
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === d) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/)[0] ?? "";
  let best = ",";
  let n = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const count = line.split(d).length;
    if (count > n) {
      n = count;
      best = d;
    }
  }
  return best;
}

export function importCsv(files: InputFile[], options: { hasHeaderRow?: boolean; titleColumn?: string; bodyColumn?: string }): ImportOutput {
  const out: ImportOutput = { files: [], warnings: [] };
  const used = new Set<string>();
  for (const f of files) {
    if (ext(f.path) !== "csv") continue;
    const rows = parseCsv(decoder.decode(f.data)).map((r) => r.map((v) => v.trim()));
    if (rows.length === 0) {
      out.warnings.push(`${f.path}: no rows`);
      continue;
    }
    const hasHeader = options.hasHeaderRow !== false;
    const width = Math.max(...rows.map((r) => r.length));
    const headers = hasHeader ? rows[0]!.map((h, i) => h || `Column ${i + 1}`) : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
    const data = hasHeader ? rows.slice(1) : rows;
    const find = (name?: string) => (name ? headers.findIndex((h) => h.toLowerCase() === name.toLowerCase()) : -1);
    let titleIdx = find(options.titleColumn);
    if (options.titleColumn && titleIdx === -1) out.warnings.push(`${f.path}: no column named “${options.titleColumn}”; using the first column.`);
    if (titleIdx === -1) titleIdx = 0;
    const bodyIdx = find(options.bodyColumn);
    const folder = files.length > 1 ? `${sanitizeName(stem(f.path))}/` : "";
    data.forEach((row, n) => {
      const fm: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        if (i === titleIdx || i === bodyIdx) return;
        const v = row[i] ?? "";
        if (v === "") return;
        const key = h.replace(/[^\p{L}\p{N}_\s-]/gu, "").trim() || `Column ${i + 1}`;
        if (key.toLowerCase() === "tags") fm[key] = v.split(/[,\s]+/).filter(Boolean).map((t) => t.replace(/^#/, ""));
        else if (/^-?\d+(\.\d+)?$/.test(v)) fm[key] = Number(v);
        else if (/^(true|false)$/i.test(v)) fm[key] = v.toLowerCase() === "true";
        else fm[key] = v;
      });
      const name = sanitizeName(row[titleIdx] || `Row ${n + 1}`);
      let candidate = `${folder}${name}.md`;
      for (let i = 1; used.has(candidate.toLowerCase()); i++) candidate = `${folder}${name} ${i}.md`;
      used.add(candidate.toLowerCase());
      const body = bodyIdx >= 0 ? (row[bodyIdx] ?? "") : "";
      const yaml = Object.keys(fm).length ? `---\n${stringifyYaml(fm)}---\n` : "";
      out.files.push({ path: candidate, data: `${yaml}${body}${body ? "\n" : ""}` });
    });
  }
  return out;
}
