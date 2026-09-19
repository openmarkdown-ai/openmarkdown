/**
 * BibTeX / BibLaTeX → CSL-JSON, enough for what Better BibTeX and JabRef
 * write: @string macros, `#` concatenation, braces and quotes, LaTeX accents,
 * "Last, First and …" names, BibLaTeX dates.
 */

export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
  "non-dropping-particle"?: string;
  suffix?: string;
}

export interface CslItem {
  id: string;
  type: string;
  [key: string]: unknown;
}

const TYPE_MAP: Record<string, string> = {
  article: "article-journal",
  book: "book",
  mvbook: "book",
  booklet: "pamphlet",
  inbook: "chapter",
  incollection: "chapter",
  inreference: "entry-encyclopedia",
  inproceedings: "paper-conference",
  conference: "paper-conference",
  proceedings: "book",
  collection: "book",
  manual: "book",
  mastersthesis: "thesis",
  phdthesis: "thesis",
  thesis: "thesis",
  techreport: "report",
  report: "report",
  misc: "document",
  online: "webpage",
  electronic: "webpage",
  www: "webpage",
  unpublished: "manuscript",
  patent: "patent",
  dataset: "dataset",
  software: "software",
  periodical: "periodical",
  standard: "standard",
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const ACCENTS: Record<string, string> = {
  '"': "̈",
  "'": "́",
  "`": "̀",
  "^": "̂",
  "~": "̃",
  "=": "̄",
  ".": "̇",
  u: "̆",
  v: "̌",
  H: "̋",
  c: "̧",
  k: "̨",
  r: "̊",
  d: "̣",
  b: "̱",
};

const SYMBOLS: Record<string, string> = {
  ss: "ß", o: "ø", O: "Ø", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", aa: "å", AA: "Å", l: "ł", L: "Ł", i: "ı", j: "ȷ",
  textendash: "–", textemdash: "—", textquoteleft: "‘", textquoteright: "’", textquotedblleft: "“", textquotedblright: "”", ldots: "…", dots: "…", textregistered: "®", texttrademark: "™", copyright: "©", S: "§", P: "¶",
};

/** LaTeX markup → Unicode text. */
export function latexToUnicode(input: string): string {
  let s = input;
  // \"{o}, \"o, {\"o}
  s = s.replace(/\\(["'`^~=.])\s*\{?\s*(\\?[A-Za-z])\s*\}?/g, (_m, acc: string, ch: string) => (ch === "\\i" ? "i" : ch.replace("\\", "")) + ACCENTS[acc]!);
  s = s.replace(/\\([uvHckrdb])\s*\{\s*(\\?[A-Za-z])\s*\}/g, (_m, acc: string, ch: string) => (ch === "\\i" ? "i" : ch.replace("\\", "")) + ACCENTS[acc]!);
  s = s.replace(/\\([uvHckrdb])\s+([A-Za-z])/g, (_m, acc: string, ch: string) => ch + ACCENTS[acc]!);
  s = s.replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j|textendash|textemdash|textquoteleft|textquoteright|textquotedblleft|textquotedblright|ldots|dots|textregistered|texttrademark|copyright|S|P)(?![A-Za-z])\s*(\{\})?/g, (_m, name: string) => SYMBOLS[name]!);
  s = s.replace(/\\(textit|textbf|emph|textsc|textrm|texttt|textsf|mkbibquote|mkbibemph|url|href\{[^}]*\})\s*\{/g, "{");
  s = s.replace(/\\([&%$#_{}])/g, "$1");
  s = s.replace(/---/g, "—").replace(/--/g, "–").replace(/~/g, " ").replace(/``|''/g, '"');
  s = s.replace(/\\[A-Za-z]+\s*/g, "");
  s = s.replace(/[{}]/g, "");
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

interface RawEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
}

/** Split BibTeX source into entries with raw (LaTeX) field values. */
export function parseBibtexEntries(src: string): RawEntry[] {
  const strings: Record<string, string> = {};
  for (const [k, v] of Object.entries(MONTHS)) strings[k] = String(v);
  const out: RawEntry[] = [];
  let i = 0;
  const n = src.length;
  const skipWs = () => {
    while (i < n && /\s/.test(src[i]!)) i++;
  };
  const readBalanced = (open: string, close: string): string => {
    // src[i] === open
    let depth = 0;
    const start = i + 1;
    for (; i < n; i++) {
      const c = src[i]!;
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const value = src.slice(start, i);
          i++;
          return value;
        }
      }
    }
    return src.slice(start);
  };
  const readQuoted = (): string => {
    // src[i] === '"'
    let depth = 0;
    const start = ++i;
    for (; i < n; i++) {
      const c = src[i]!;
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === '"' && depth === 0) {
        const value = src.slice(start, i);
        i++;
        return value;
      }
    }
    return src.slice(start);
  };
  const readValue = (): string => {
    const parts: string[] = [];
    for (;;) {
      skipWs();
      const c = src[i];
      if (c === "{") parts.push(readBalanced("{", "}"));
      else if (c === '"') parts.push(readQuoted());
      else {
        const m = /^[^\s,#}\)]+/.exec(src.slice(i, i + 200));
        if (!m) break;
        i += m[0].length;
        const word = m[0];
        parts.push(/^\d+$/.test(word) ? word : (strings[word.toLowerCase()] ?? word));
      }
      skipWs();
      if (src[i] === "#") {
        i++;
        continue;
      }
      break;
    }
    return parts.join("");
  };

  while (i < n) {
    const at = src.indexOf("@", i);
    if (at < 0) break;
    i = at + 1;
    const tm = /^([A-Za-z]+)\s*([{(])/.exec(src.slice(i, i + 40));
    if (!tm) continue;
    const type = tm[1]!.toLowerCase();
    i += tm[0].length;
    const close = tm[2] === "{" ? "}" : ")";
    if (type === "comment" || type === "preamble") {
      i--;
      readBalanced(tm[2]!, close);
      continue;
    }
    if (type === "string") {
      skipWs();
      const nm = /^[^\s=]+/.exec(src.slice(i));
      if (!nm) continue;
      i += nm[0].length;
      skipWs();
      if (src[i] === "=") i++;
      strings[nm[0].toLowerCase()] = readValue();
      skipWs();
      if (src[i] === close) i++;
      continue;
    }
    skipWs();
    const km = /^[^,\s}]*/.exec(src.slice(i))!;
    const key = km[0];
    i += key.length;
    const fields: Record<string, string> = {};
    for (;;) {
      skipWs();
      if (src[i] === ",") i++;
      skipWs();
      if (i >= n || src[i] === close) {
        i++;
        break;
      }
      const fm = /^([^\s=,{}]+)\s*=/.exec(src.slice(i, i + 200));
      if (!fm) {
        // Malformed: skip to the next entry.
        const next = src.indexOf("\n@", i);
        i = next < 0 ? n : next + 1;
        break;
      }
      i += fm[0].length;
      fields[fm[1]!.toLowerCase()] = readValue();
    }
    if (key) out.push({ type, key, fields });
  }
  return out;
}

function splitNames(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && /\s/.test(c!) && /^\s+and\s+/i.test(value.slice(i))) {
      out.push(value.slice(last, i));
      const m = /^\s+and\s+/i.exec(value.slice(i))!;
      i += m[0].length - 1;
      last = i + 1;
    }
  }
  out.push(value.slice(last));
  return out.map((s) => s.trim()).filter(Boolean);
}

function splitTopLevel(value: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && c === sep) {
      out.push(value.slice(last, i));
      last = i + 1;
    }
  }
  out.push(value.slice(last));
  return out.map((s) => s.trim());
}

export function parseName(raw: string): CslName {
  const t = raw.trim();
  if (/^\{[\s\S]*\}$/.test(t) && !/^\{[^{}]*\}\s*\S/.test(t.slice(1))) {
    const inner = t.slice(1, -1);
    if (!/[{}]/.test(inner) || splitTopLevel(inner, ",").length === 1) return { literal: latexToUnicode(inner) };
  }
  if (t.toLowerCase() === "others") return { literal: "others" };
  const parts = splitTopLevel(t, ",");
  if (parts.length >= 2) {
    const last = parts[0]!;
    const given = parts.length === 3 ? parts[2]! : parts[1]!;
    const suffix = parts.length === 3 ? parts[1]! : undefined;
    const lastWords = last.split(/\s+/);
    const particle: string[] = [];
    while (lastWords.length > 1 && /^[a-z]/.test(lastWords[0]!)) particle.push(lastWords.shift()!);
    return clean({ family: latexToUnicode(lastWords.join(" ")), given: latexToUnicode(given), suffix: suffix ? latexToUnicode(suffix) : undefined, "non-dropping-particle": particle.length ? latexToUnicode(particle.join(" ")) : undefined });
  }
  // "First von Last"
  const words: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of t) {
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (/\s/.test(c) && depth === 0) {
      if (cur) words.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) words.push(cur);
  if (words.length === 1) return { family: latexToUnicode(words[0]!) };
  let vonStart = words.findIndex((w, idx) => idx < words.length - 1 && /^[a-z]/.test(w));
  if (vonStart < 0) vonStart = words.length - 1;
  let lastStart = vonStart;
  while (lastStart < words.length - 1 && /^[a-z]/.test(words[lastStart]!)) lastStart++;
  return clean({
    given: latexToUnicode(words.slice(0, vonStart).join(" ")) || undefined,
    "non-dropping-particle": lastStart > vonStart ? latexToUnicode(words.slice(vonStart, lastStart).join(" ")) : undefined,
    family: latexToUnicode(words.slice(lastStart).join(" ")),
  });
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined || o[k] === "") delete o[k];
  return o;
}

function parseDate(value: string): { "date-parts": number[][] } | { literal: string } | undefined {
  const v = value.trim();
  if (!v) return undefined;
  const range = v.split("/");
  const parts = range.map((p) => {
    const m = /^(-?\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(p.trim());
    return m ? [Number(m[1]), ...(m[2] ? [Number(m[2])] : []), ...(m[3] ? [Number(m[3])] : [])] : null;
  });
  if (parts[0]) return { "date-parts": parts.filter((p): p is number[] => !!p) };
  return { literal: v };
}

/** CSL-JSON items from BibTeX/BibLaTeX source. */
export function bibtexToCsl(src: string): CslItem[] {
  return parseBibtexEntries(src).map(({ type, key, fields }) => {
    const f = (name: string) => (fields[name] !== undefined ? latexToUnicode(fields[name]!) : undefined);
    let cslType = TYPE_MAP[type] ?? "document";
    if (type === "misc" && fields.url && !fields.publisher && !fields.journal) cslType = "webpage";
    const item: CslItem = { id: key, type: cslType };
    const set = (k: string, v: unknown) => {
      if (v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)) item[k] = v;
    };
    set("title", f("title"));
    set("title-short", f("shorttitle"));
    const container = f("journaltitle") ?? f("journal") ?? f("booktitle");
    set("container-title", container);
    set("collection-title", f("series"));
    set("volume", f("volume"));
    if (cslType === "article-journal") set("issue", f("number") ?? f("issue"));
    else {
      set("number", f("number"));
      set("issue", f("issue"));
    }
    set("page", f("pages")?.replace(/\s*[-–]+\s*/g, "–"));
    set("publisher", f("publisher") ?? f("institution") ?? f("school") ?? f("organization"));
    set("publisher-place", f("location") ?? f("address"));
    set("edition", f("edition"));
    set("DOI", f("doi"));
    set("URL", fields.url?.replace(/[{}]/g, "").replace(/\\([_%#&])/g, "$1"));
    set("ISBN", f("isbn"));
    set("ISSN", f("issn"));
    set("abstract", f("abstract"));
    set("note", f("note"));
    set("keyword", f("keywords"));
    set("language", f("language") ?? f("langid"));
    set("genre", type === "phdthesis" ? "PhD thesis" : type === "mastersthesis" ? "Master's thesis" : f("type"));
    set("event-place", f("venue") ?? f("eventplace"));
    set("event-title", f("eventtitle"));
    set("eprint", f("eprint"));
    set("eprinttype", f("eprinttype") ?? f("archiveprefix"));
    set("author", fields.author ? splitNames(fields.author).map(parseName) : undefined);
    set("editor", fields.editor ? splitNames(fields.editor).map(parseName) : undefined);
    set("translator", fields.translator ? splitNames(fields.translator).map(parseName) : undefined);
    if (fields.date) set("issued", parseDate(f("date")!));
    else if (fields.year) {
      const y = Number((f("year") ?? "").replace(/[^\d-]/g, ""));
      const monthRaw = (f("month") ?? "").toLowerCase().slice(0, 3);
      const month = MONTHS[monthRaw] ?? (Number(f("month")) || undefined);
      if (Number.isFinite(y) && y) set("issued", { "date-parts": [[y, ...(month ? [month] : [])]] });
      else set("issued", { literal: f("year") });
    }
    if (fields.urldate) set("accessed", parseDate(f("urldate")!));
    return item;
  });
}
