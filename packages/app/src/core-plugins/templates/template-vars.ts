/**
 * Template variables shared by Templates, Daily notes and Note composer.
 *
 * `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`, `{{time:FORMAT}}`
 * (Moment tokens; both accept any format). Daily notes passes the note's own
 * date so `{{date}}` in a template for last Tuesday says last Tuesday; Note
 * composer adds `{{content}}`, `{{fromTitle}}` and `{{newTitle}}`.
 */
import type { Moment } from "moment";
import { getFrontMatterInfo, moment, parseYaml, stringifyYaml } from "../../obsidian/util";

export interface TemplateContext {
  title: string;
  dateFormat: string;
  timeFormat: string;
  /** The moment `{{date}}` refers to; defaults to now. `{{time}}` is always now. */
  date?: Moment;
  /** Extra plain variables such as `content`, `fromTitle`, `newTitle`. */
  extra?: Record<string, string>;
}

const VAR_RE = /{{\s*([A-Za-z][\w-]*)\s*(?:([+-]\d+)\s*([yqMwdhms]))?\s*(?::([^}]*?))?\s*}}/g;

export function processTemplateVariables(text: string, ctx: TemplateContext): string {
  const now = moment();
  return text.replace(VAR_RE, (whole, rawName: string, offset?: string, unit?: string, format?: string) => {
    const name = rawName.toLowerCase();
    if (ctx.extra) {
      for (const [k, v] of Object.entries(ctx.extra)) if (k.toLowerCase() === name && offset === undefined && format === undefined) return v;
    }
    const base = (m: Moment) => {
      const c = m.clone();
      if (offset && unit) c.add(Number(offset), unit as moment.unitOfTime.DurationConstructor);
      return c;
    };
    switch (name) {
      case "title":
        return format === undefined && offset === undefined ? ctx.title : whole;
      case "date":
        return base(ctx.date ?? now).format(format?.trim() || ctx.dateFormat || "YYYY-MM-DD");
      case "time":
        return base(now).format(format?.trim() || ctx.timeFormat || "HH:mm");
      case "yesterday":
        return (ctx.date ?? now).clone().subtract(1, "day").format(format?.trim() || ctx.dateFormat || "YYYY-MM-DD");
      case "tomorrow":
        return (ctx.date ?? now).clone().add(1, "day").format(format?.trim() || ctx.dateFormat || "YYYY-MM-DD");
      default:
        return whole;
    }
  });
}

type Frontmatter = Record<string, unknown>;

function isPlainObject(v: unknown): v is Frontmatter {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Merge template properties into a note's (Obsidian 1.4+): properties the
 * note lacks are added; list values are unioned; an existing scalar keeps
 * the note's value.
 */
export function mergeProperties(note: Frontmatter, template: Frontmatter): Frontmatter {
  const out: Frontmatter = { ...note };
  for (const [key, value] of Object.entries(template)) {
    const existingKey = Object.keys(out).find((k) => k.toLowerCase() === key.toLowerCase());
    if (existingKey === undefined) {
      out[key] = value;
      continue;
    }
    const current = out[existingKey];
    if (Array.isArray(current) || Array.isArray(value)) {
      const a = Array.isArray(current) ? current : current === null || current === undefined || current === "" ? [] : [current];
      const b = Array.isArray(value) ? value : value === null || value === undefined || value === "" ? [] : [value];
      const merged = [...a];
      for (const item of b) if (!merged.some((x) => JSON.stringify(x) === JSON.stringify(item))) merged.push(item);
      out[existingKey] = merged;
    } else if (current === null || current === undefined || current === "") {
      out[existingKey] = value;
    }
  }
  return out;
}

export interface SplitTemplate {
  /** Parsed template properties, or null when the template has none. */
  properties: Frontmatter | null;
  body: string;
  error?: string;
}

export function splitFrontmatter(text: string): SplitTemplate {
  const info = getFrontMatterInfo(text);
  if (!info.exists) return { properties: null, body: text };
  try {
    const data = parseYaml(info.frontmatter);
    return { properties: isPlainObject(data) ? data : {}, body: text.slice(info.contentStart) };
  } catch (e) {
    return { properties: null, body: text.slice(info.contentStart), error: String((e as Error)?.message ?? e) };
  }
}

/** Serialise properties as a frontmatter block (empty string for none). */
export function frontmatterBlock(props: Frontmatter): string {
  if (Object.keys(props).length === 0) return "";
  return `---\n${stringifyYaml(props)}---\n`;
}

/**
 * Apply template properties to a whole note's text and return the new text.
 * Used where there is no editor (daily note creation, merges).
 */
export function mergeIntoText(noteText: string, props: Frontmatter | null): string {
  if (!props || Object.keys(props).length === 0) return noteText;
  const info = getFrontMatterInfo(noteText);
  let existing: Frontmatter = {};
  if (info.exists) {
    try {
      const data = parseYaml(info.frontmatter);
      if (isPlainObject(data)) existing = data;
    } catch {
      /* unreadable note properties: keep them and add ours on top */
    }
  }
  const merged = mergeProperties(existing, props);
  const body = info.exists ? noteText.slice(info.contentStart) : noteText;
  return frontmatterBlock(merged) + body;
}
