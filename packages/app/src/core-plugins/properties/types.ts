/**
 * Property types: names, icons, compatibility and conversion — shared by the
 * metadata editor and the All properties view.
 */
import { inferType, type PropertyType } from "../../obsidian/app-internals/misc";

export type { PropertyType };

export interface TypeInfo {
  type: PropertyType;
  name: string;
  icon: string;
}

export const TYPE_INFO: Record<PropertyType, TypeInfo> = {
  text: { type: "text", name: "Text", icon: "lucide-text" },
  multitext: { type: "multitext", name: "List", icon: "lucide-list" },
  number: { type: "number", name: "Number", icon: "lucide-binary" },
  checkbox: { type: "checkbox", name: "Checkbox", icon: "lucide-check-square" },
  date: { type: "date", name: "Date", icon: "lucide-calendar" },
  datetime: { type: "datetime", name: "Date & time", icon: "lucide-clock" },
  tags: { type: "tags", name: "Tags", icon: "lucide-tags" },
  aliases: { type: "aliases", name: "Aliases", icon: "lucide-forward" },
};

/** Types a user can pick from the "Property type" menu (tags/aliases only for their own keys). */
export const USER_TYPES: PropertyType[] = ["text", "multitext", "number", "checkbox", "date", "datetime"];

export const RESERVED_KEYS: Record<string, PropertyType> = { tags: "tags", aliases: "aliases", cssclasses: "multitext" };

export function iconForType(type: string | null | undefined): string {
  return (type && TYPE_INFO[type as PropertyType]?.icon) || "lucide-file-question";
}

/**
 * The type a property's widget uses: the type assigned in types.json, else the type inferred across
 * the vault (what the All properties view shows), else the type of this value. An empty value has no
 * type of its own, so without the vault-wide type a new `read:` row got a text box in a vault where
 * `read` is a checkbox everywhere else.
 */
export function typeFor(app: any, key: string, value: unknown): PropertyType {
  const mtm = app.metadataTypeManager;
  const assigned = mtm?.getAssignedType?.(key) as PropertyType | null | undefined;
  if (assigned) return assigned;
  const vault = key ? (mtm?.getAllProperties?.()?.[key.toLowerCase()] as { type?: PropertyType; count?: number } | undefined) : undefined;
  if (vault?.type && vault.type in TYPE_INFO) {
    if (value === null || value === undefined || value === "") return vault.type;
    // A value that reads as plain text (a list property with one item, a number typed as text) takes
    // the vault's type when it fits; a value with a type of its own (true, 42, a date) keeps it.
    const own = inferType(key, value);
    if (own !== vault.type && (own === "text" || (own === "date" && vault.type === "datetime")) && isCompatible(vault.type, value)) return vault.type;
    return own;
  }
  return inferType(key, value);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:?\d{2}|Z)?$/;

export function isCompatible(type: PropertyType, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (type) {
    case "text":
      return typeof value !== "object";
    case "multitext":
    case "tags":
    case "aliases":
      return (Array.isArray(value) && value.every((v) => v === null || typeof v !== "object")) || typeof value === "string";
    case "number":
      return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)));
    case "checkbox":
      return typeof value === "boolean" || value === "true" || value === "false";
    case "date":
      return typeof value === "string" && (DATE_RE.test(value) || DATETIME_RE.test(value));
    case "datetime":
      return typeof value === "string" && (DATE_RE.test(value) || DATETIME_RE.test(value));
  }
  return false;
}

/** The value adapted to `type` (Obsidian's "It will be adapted to fit the new format"). */
export function convertValue(type: PropertyType, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const scalar = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  switch (type) {
    case "text":
      return Array.isArray(value) ? value.map(scalar).join(", ") : scalar(value);
    case "multitext":
    case "aliases":
      return Array.isArray(value) ? value.map(scalar) : scalar(value) === "" ? [] : [scalar(value)];
    case "tags":
      return (Array.isArray(value) ? value.map(scalar) : scalar(value).split(/[\s,]+/)).map((t) => t.replace(/^#/, "")).filter(Boolean);
    case "number": {
      const n = Number(Array.isArray(value) ? value[0] : value);
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return null;
    case "date": {
      const s = scalar(Array.isArray(value) ? value[0] : value);
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
      return m ? m[1] : null;
    }
    case "datetime": {
      const s = scalar(Array.isArray(value) ? value[0] : value);
      if (DATE_RE.test(s)) return `${s}T00:00:00`;
      return DATETIME_RE.test(s) ? s : null;
    }
  }
  return value;
}

/** Tag validity as the tag property checks it (no spaces, at least one non-digit). */
export function isValidTag(tag: string): boolean {
  const t = tag.replace(/^#/, "");
  return t.length > 0 && !/[\s,#]/.test(t) && !/^\d+$/.test(t) && !/^[/]|[/]$/.test(t);
}
