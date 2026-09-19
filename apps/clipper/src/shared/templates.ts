/**
 * Template matching, import/export and frontmatter, compatible with Obsidian
 * Web Clipper's JSON (`schemaVersion` 0.1.0). Behaviour follows
 * obsidian-clipper (MIT) and mirrors crates/vault-clip/src/template/mod.rs,
 * which does the rendering itself.
 */
import type { ClipBehavior } from "../../../../packages/app/src/companion/protocol";
import { newId, PROPERTY_TYPES, type PropertyType, type Template } from "./settings";

export const BEHAVIORS: { value: ClipBehavior; label: string }[] = [
  { value: "create", label: "Create new note" },
  { value: "append-specific", label: "Add to an existing note, at the bottom" },
  { value: "prepend-specific", label: "Add to an existing note, at the top" },
  { value: "append-daily", label: "Add to the daily note, at the bottom" },
  { value: "prepend-daily", label: "Add to the daily note, at the top" },
  { value: "overwrite", label: "Overwrite note" },
];

export const isDaily = (b: ClipBehavior) => b === "append-daily" || b === "prepend-daily";

// ---- triggers -----------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function matchSchema(pattern: string, schemaOrg: Json[]): boolean {
  const m = /^schema:(@\w+)?(?:\.(.+?))?(?:=(.+))?$/.exec(pattern);
  if (!m) return false;
  const type = m[1]?.slice(1);
  const key = m[2];
  const expected = m[3];
  if (!type && !key) return false;
  const flat: Json[] = [];
  for (const s of schemaOrg) Array.isArray(s) ? flat.push(...s) : flat.push(s);
  for (const schema of flat) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) continue;
    if (type) {
      const t = schema["@type"];
      const ok = Array.isArray(t) ? t.includes(type) : t === type;
      if (!ok) continue;
    }
    if (!key) return true;
    let val: Json | undefined = schema;
    for (const k of key.split(".")) val = val && typeof val === "object" && !Array.isArray(val) ? val[k] : undefined;
    if (val === undefined) continue;
    if (expected === undefined) return true;
    if (Array.isArray(val) ? val.includes(expected) : val === expected) return true;
  }
  return false;
}

export function matchTriggerPattern(pattern: string, url: string, schemaOrg: Json[]): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p.startsWith("schema:")) return matchSchema(p, schemaOrg);
  if (p.length >= 2 && p.startsWith("/") && p.endsWith("/")) {
    try {
      return new RegExp(p.slice(1, -1)).test(url);
    } catch {
      return false;
    }
  }
  return url.startsWith(p);
}

/** URL and regex triggers across every template first, then schema triggers (Web Clipper's `matchTemplate`). */
export function findMatchingTemplate(templates: Template[], url: string, schemaOrg: unknown): Template | null {
  const schema = (Array.isArray(schemaOrg) ? schemaOrg : schemaOrg ? [schemaOrg] : []) as Json[];
  for (const t of templates) if (t.triggers.some((tr) => !tr.startsWith("schema:") && matchTriggerPattern(tr, url, []))) return t;
  if (schema.length) for (const t of templates) if (t.triggers.some((tr) => tr.startsWith("schema:") && matchSchema(tr, schema))) return t;
  return null;
}

// ---- import / export ----------------------------------------------------------

/** The JSON the engine's `clipPage` and Web Clipper's Export button use. */
export function toClipperJson(t: Template): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schemaVersion: "0.1.0",
    name: t.name,
    behavior: t.behavior,
    noteContentFormat: t.noteContentFormat,
    properties: t.properties.map((p) => ({ name: p.name, value: p.value, type: p.type })),
    triggers: t.triggers,
  };
  if (!isDaily(t.behavior)) {
    out.noteNameFormat = t.noteNameFormat;
    out.path = t.path;
  }
  if (t.context) out.context = t.context;
  return out;
}

export function exportTemplate(t: Template): string {
  return JSON.stringify(toClipperJson(t), null, "\t");
}

export function exportFileName(t: Template): string {
  return `${t.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "template"}-clipper.json`;
}

const VALID_BEHAVIORS = new Set(BEHAVIORS.map((b) => b.value));

/** Web Clipper's `validateImportedTemplate`, plus a fresh id. Throws a readable message. */
export function importTemplate(raw: unknown, existingNames: string[] = []): Template {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid template file: not an object");
  const o = raw as Record<string, unknown>;
  for (const f of ["name", "behavior", "properties", "noteContentFormat"]) if (!(f in o)) throw new Error(`Invalid template file: missing ${f}`);
  const behavior = String(o.behavior) as ClipBehavior;
  if (!VALID_BEHAVIORS.has(behavior)) throw new Error(`Invalid template file: unknown behavior "${behavior}"`);
  if (!isDaily(behavior) && (!("noteNameFormat" in o) || !("path" in o))) throw new Error("Invalid template file: missing noteNameFormat or path");
  if (!Array.isArray(o.properties)) throw new Error("Invalid template file: properties must be an array");
  const properties = o.properties.map((p) => {
    if (!p || typeof p !== "object" || !("name" in p) || !("value" in p)) throw new Error("Invalid template file: property needs name and value");
    const pp = p as Record<string, unknown>;
    const type = (pp.type ?? "text") as PropertyType;
    if (!PROPERTY_TYPES.includes(type)) throw new Error(`Invalid template file: bad property type ${String(pp.type)}`);
    return { id: newId(), name: String(pp.name), value: String(pp.value), type };
  });
  if (o.context !== undefined && o.context !== null && typeof o.context !== "string") throw new Error("Invalid template file: context must be a string");
  let name = String(o.name);
  if (existingNames.includes(name)) {
    let i = 1;
    while (existingNames.includes(`${name} ${i}`)) i++;
    name = `${name} ${i}`;
  }
  return {
    id: newId(),
    name,
    behavior,
    noteNameFormat: typeof o.noteNameFormat === "string" ? o.noteNameFormat : "{{title}}",
    path: typeof o.path === "string" ? o.path : "",
    noteContentFormat: String(o.noteContentFormat),
    properties,
    triggers: Array.isArray(o.triggers) ? o.triggers.map(String) : [],
    context: typeof o.context === "string" ? o.context : undefined,
  };
}

/** A file may hold one template or an array of them. */
export function importTemplatesText(text: string, existingNames: string[]): Template[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid template file: ${(e as Error).message}`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const names = [...existingNames];
  return list.map((item) => {
    const t = importTemplate(item, names);
    names.push(t.name);
    return t;
  });
}

// ---- notes ----------------------------------------------------------------------

// Shared with the app, which writes the frontmatter itself when it fills prompt variables.
export { generateFrontmatter, joinPath, sanitizeFileName } from "../../../../packages/app/src/companion/clip-format";
