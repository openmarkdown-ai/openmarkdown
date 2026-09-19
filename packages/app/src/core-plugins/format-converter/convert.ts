/**
 * The Format converter's rewrites, in TypeScript.
 *
 * Used when the Rust engine's `formatConvert` is not available, and always for
 * the Zettelkasten fixers, which need to look files up in the vault. Fenced
 * code blocks and inline code are never touched; frontmatter is touched only
 * by the frontmatter migration.
 */
import { getFrontMatterInfo, parseYaml, stringifyYaml } from "../../obsidian/util";

export interface ConvertOptions {
  /** `#tag`, `#[[tag]]` → `[[tag]]` */
  roamTags: boolean;
  /** `^^x^^` → `==x==` */
  roamHighlights: boolean;
  /** `{{[[TODO]]}}` → `[ ]`, `{{[[DONE]]}}` → `[x]` */
  roamTodos: boolean;
  /** `::x::` → `==x==` */
  bearHighlights: boolean;
  /** `#multi word tag#` → `#multi-word-tag` */
  bearMultiwordTags: boolean;
  /** `[text](Note.md)` → `[[Note|text]]` */
  markdownLinksToWikilinks: boolean;
  /** `[[UID]]` → `[[UID File Name]]` */
  zettelkastenLinkFixer: boolean;
  /** `[[UID]]` → `[[UID File Name|File Name]]` */
  zettelkastenLinkBeautifier: boolean;
  /** `tag`/`alias`/`cssclass` → `tags`/`aliases`/`cssclasses` lists */
  frontmatterMigration: boolean;
}

export const DEFAULT_CONVERT_OPTIONS: ConvertOptions = {
  roamTags: false,
  roamHighlights: false,
  roamTodos: false,
  bearHighlights: false,
  bearMultiwordTags: false,
  markdownLinksToWikilinks: false,
  zettelkastenLinkFixer: false,
  zettelkastenLinkBeautifier: false,
  frontmatterMigration: false,
};

export interface ConvertContext {
  /** Basename of the note whose name starts with `uid` (and is not exactly `uid`), or null. */
  resolveUid(uid: string): string | null;
  /** Optional: vault linktext for a Markdown link path (decoded, without `.md`). */
  resolveLink?(path: string): string | null;
}

export interface ConvertResult {
  text: string;
  replacements: number;
}

type Rewrite = (prose: string) => string;

/** Apply `rewrite` to everything outside frontmatter, fenced code and inline code. */
export function mapProse(text: string, rewrite: Rewrite, includeFrontmatter = false): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  // Frontmatter
  if (lines[0]?.replace(/\r$/, "") === "---") {
    let end = -1;
    for (let j = 1; j < lines.length; j++) {
      const l = lines[j]!.replace(/\r$/, "");
      if (l === "---" || l === "...") {
        end = j;
        break;
      }
    }
    if (end !== -1) {
      const block = lines.slice(0, end + 1).join("\n");
      out.push(includeFrontmatter ? rewrite(block) : block);
      i = end + 1;
    }
  }
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(rewriteOutsideInlineCode(prose.join("\n"), rewrite));
    prose = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const marker = fence[1]!;
      const block = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        block.push(l);
        i++;
        const close = /^\s{0,3}(`{3,}|~{3,})\s*\r?$/.exec(l);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) break;
      }
      out.push(block.join("\n"));
      continue;
    }
    prose.push(line);
    i++;
  }
  flush();
  return out.join("\n");
}

function rewriteOutsideInlineCode(text: string, rewrite: Rewrite): string {
  let result = "";
  let last = 0;
  const re = /(`+)[\s\S]*?[^`]\1(?!`)|(`+)\2(?!`)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    result += rewrite(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return result + rewrite(text.slice(last));
}

/** Replace with a counter. */
function counted(re: RegExp, fn: (...m: string[]) => string, counter: { n: number }): Rewrite {
  return (s) =>
    s.replace(re, (...args: unknown[]) => {
      const groups = args.slice(0, -2).map((g) => (g === undefined ? "" : String(g)));
      const next = fn(...groups);
      if (next !== groups[0]) counter.n++;
      return next;
    });
}

const TAG_CHARS = "[\\p{L}\\p{N}_\\/\\-]";

function wikilinkFromMarkdown(text: string, rawTarget: string, embed: boolean, ctx: ConvertContext): string | null {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  // Drop a title: [x](path "title")
  const titled = /^(\S+)\s+["'(].*["')]$/.exec(target);
  if (titled) target = titled[1]!;
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }
  let subpath = "";
  const hash = decoded.indexOf("#");
  if (hash !== -1) {
    subpath = decoded.slice(hash);
    decoded = decoded.slice(0, hash);
  }
  decoded = decoded.replace(/^\.\//, "");
  if (/\.md$/i.test(decoded)) decoded = decoded.slice(0, -3);
  if (!decoded) return null;
  const linktext = ctx.resolveLink?.(decoded) ?? decoded;
  const name = decoded.slice(decoded.lastIndexOf("/") + 1);
  const display = text.trim();
  const alias = display && display !== name && display !== linktext && display !== decoded ? `|${display}` : "";
  if (/[[\]|]/.test(display) && !embed) return null;
  return `${embed ? "!" : ""}[[${linktext}${subpath}${alias}]]`;
}

function splitList(value: unknown, splitSpaces: boolean): string[] {
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const out: string[] = [];
  for (const item of items) {
    if (item === null || item === undefined) continue;
    for (const part of String(item).split(splitSpaces ? /[,\s]+/ : /,/)) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** tag/alias/cssclass → tags/aliases/cssclasses, as lists. Returns null when nothing changed. */
export function migrateFrontmatter(text: string): { text: string; replacements: number } | null {
  const info = getFrontMatterInfo(text);
  if (!info.exists) return null;
  let data: unknown;
  try {
    data = parseYaml(info.frontmatter);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fm = data as Record<string, unknown>;
  const pairs: { singular: string; plural: string; spaces: boolean }[] = [
    { singular: "tag", plural: "tags", spaces: true },
    { singular: "alias", plural: "aliases", spaces: false },
    { singular: "cssclass", plural: "cssclasses", spaces: true },
  ];
  const migrated = new Map<string, string[]>();
  const pluralOf = new Map<string, string>();
  for (const { singular, plural, spaces } of pairs) {
    const pluralValue = fm[plural];
    const pluralNeedsFix = plural in fm && !Array.isArray(pluralValue) && pluralValue !== null && pluralValue !== undefined;
    if (!(singular in fm) && !pluralNeedsFix) continue;
    let items = [...splitList(pluralValue, spaces), ...splitList(fm[singular], spaces)];
    if (plural === "tags") items = items.map((t) => t.replace(/^#/, ""));
    migrated.set(plural, Array.from(new Set(items)));
    pluralOf.set(singular, plural);
    pluralOf.set(plural, plural);
  }
  if (migrated.size === 0) return null;
  // The list takes the place of whichever of the pair came first.
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(fm)) {
    const plural = pluralOf.get(key);
    if (!plural) ordered[key] = fm[key];
    else if (!(plural in ordered)) ordered[plural] = migrated.get(plural);
  }
  return { text: `---\n${stringifyYaml(ordered)}---\n${text.slice(info.contentStart)}`, replacements: migrated.size };
}

export function convert(text: string, options: Partial<ConvertOptions>, ctx: ConvertContext): ConvertResult {
  const o = { ...DEFAULT_CONVERT_OPTIONS, ...options };
  const counter = { n: 0 };
  let out = text;

  if (o.frontmatterMigration) {
    const r = migrateFrontmatter(out);
    if (r) {
      out = r.text;
      counter.n += r.replacements;
    }
  }

  const rewrites: Rewrite[] = [];
  if (o.roamTodos) {
    rewrites.push(
      counted(/^([ \t]*)((?:[-*+]|\d+[.)])[ \t]+)?\{\{\s*\[?\[?(TODO|DONE)\]?\]?\s*\}\}[ \t]?/gm, (_all, indent, bullet, kind) => `${indent}${bullet || "- "}[${kind === "DONE" ? "x" : " "}] `, counter),
      counted(/\{\{\s*\[\[(TODO|DONE)\]\]\s*\}\}/g, (_all, kind) => `[${kind === "DONE" ? "x" : " "}]`, counter),
    );
  }
  if (o.roamHighlights) rewrites.push(counted(/\^\^(?!\s)([^\n^]+?)\^\^/g, (_all, inner) => `==${inner}==`, counter));
  if (o.bearHighlights) rewrites.push(counted(/(?<![\p{L}\p{N}_:])::(?![\s:])([^\n:]+?)(?<!\s)::(?![\p{L}\p{N}_:])/gu, (_all, inner) => `==${inner}==`, counter));
  if (o.bearMultiwordTags) {
    rewrites.push(
      counted(new RegExp(`(^|\\s)#(${TAG_CHARS}[^#\\n]*?\\s[^#\\n]*?${TAG_CHARS})#(?=$|\\s|[.,;:!?)])`, "gmu"), (_all, lead, inner) => `${lead}#${inner.trim().replace(/\s+/g, "-")}`, counter),
    );
  }
  if (o.roamTags) {
    rewrites.push(
      counted(/#\[\[([^\]\n]+)\]\]/g, (_all, inner) => `[[${inner}]]`, counter),
      counted(new RegExp(`(^|\\s)#(${TAG_CHARS}+)`, "gmu"), (all, lead, tag) => (/^[\d/_-]+$/.test(tag) ? all : `${lead}[[${tag.replace(/[/-]+$/, "")}]]${tag.match(/[/-]+$/)?.[0] ?? ""}`), counter),
    );
  }
  if (o.markdownLinksToWikilinks) {
    rewrites.push(
      counted(/(!?)\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(((?:<[^>\n]*>|[^()\s\n]|\([^()\n]*\))+(?:\s+"[^"\n]*")?)\)/g, (all, bang, label, target) => wikilinkFromMarkdown(label, target, bang === "!", ctx) ?? all, counter),
    );
  }
  if (o.zettelkastenLinkFixer || o.zettelkastenLinkBeautifier) {
    rewrites.push(
      counted(/\[\[(\d{6,})(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g, (all, uid, sub, alias) => {
        const base = ctx.resolveUid(uid);
        if (!base) return all;
        const title = base.slice(uid.length).replace(/^[\s\-_.]+/, "");
        const aliasPart = alias ? alias : o.zettelkastenLinkBeautifier && title ? `|${title}` : "";
        return `[[${base}${sub}${aliasPart}]]`;
      }, counter),
    );
  }
  if (rewrites.length) out = mapProse(out, (s) => rewrites.reduce((acc, fn) => fn(acc), s));
  return { text: out, replacements: counter.n };
}
