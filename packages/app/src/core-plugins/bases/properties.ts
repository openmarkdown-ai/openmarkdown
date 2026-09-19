/**
 * Property catalogue for the toolbar menus: which properties exist, their
 * kinds (text/number/date/…), icons, the filter operators each kind offers,
 * and converting a simple filter row to and from its expression text.
 */
import { normalizePropertyId, type BasesPropertyId } from "../../obsidian/bases/api";

export type PropertyKind = "text" | "number" | "date" | "checkbox" | "list" | "file" | "any";

export const FILE_PROPERTIES: { name: string; kind: PropertyKind; icon: string }[] = [
  { name: "name", kind: "text", icon: "lucide-file" },
  { name: "basename", kind: "text", icon: "lucide-file" },
  { name: "path", kind: "text", icon: "lucide-folder-tree" },
  { name: "folder", kind: "text", icon: "lucide-folder" },
  { name: "ext", kind: "text", icon: "lucide-file-type" },
  { name: "size", kind: "number", icon: "lucide-binary" },
  { name: "ctime", kind: "date", icon: "lucide-clock" },
  { name: "mtime", kind: "date", icon: "lucide-clock" },
  { name: "tags", kind: "list", icon: "lucide-tags" },
  { name: "links", kind: "list", icon: "lucide-link" },
  { name: "embeds", kind: "list", icon: "lucide-file-input" },
  { name: "backlinks", kind: "list", icon: "lucide-link-2" },
  { name: "file", kind: "file", icon: "lucide-file" },
];

const TYPE_TO_KIND: Record<string, PropertyKind> = {
  text: "text",
  number: "number",
  checkbox: "checkbox",
  date: "date",
  datetime: "date",
  multitext: "list",
  tags: "list",
  aliases: "list",
};

const TYPE_ICONS: Record<string, string> = {
  text: "lucide-text",
  multitext: "lucide-list",
  number: "lucide-binary",
  checkbox: "lucide-check-square",
  date: "lucide-calendar",
  datetime: "lucide-clock",
  tags: "lucide-tags",
  aliases: "lucide-forward",
};

export function splitId(id: string): { kind: "note" | "file" | "formula"; name: string } {
  const norm = normalizePropertyId(id);
  const dot = norm.indexOf(".");
  return { kind: norm.slice(0, dot) as "note" | "file" | "formula", name: norm.slice(dot + 1) };
}

let lastPropertyRefresh = 0;

/** Every property a base can show: file.*, note properties seen in the vault, and the base's formulas. */
export function allPropertyIds(app: any, base: any): BasesPropertyId[] {
  const out: BasesPropertyId[] = FILE_PROPERTIES.filter((p) => p.name !== "file").map((p) => `file.${p.name}` as BasesPropertyId);
  const mtm = app.metadataTypeManager;
  // Recounting is vault-wide and announces "changed"; do it at most every few seconds.
  const now = Date.now();
  if (now - lastPropertyRefresh > 3000) {
    lastPropertyRefresh = now;
    try {
      mtm?.updatePropertyInfoCache?.();
    } catch {
      /* ignore */
    }
  }
  const names = Object.values((mtm?.getAllProperties?.() ?? {}) as Record<string, { name: string }>).map((p) => p.name);
  names.sort((a, b) => a.localeCompare(b));
  for (const n of names) out.push(`note.${n}`);
  for (const f of Object.keys(base?.formulas ?? {})) out.push(`formula.${f}`);
  return out;
}

export function propertyKind(app: any, id: string): PropertyKind {
  const { kind, name } = splitId(id);
  if (kind === "file") return FILE_PROPERTIES.find((p) => p.name === name)?.kind ?? "any";
  if (kind === "formula") return "any";
  const type = app.metadataTypeManager?.getAssignedType?.(name) ?? app.metadataTypeManager?.getPropertyInfo?.(name)?.type;
  return TYPE_TO_KIND[type ?? "text"] ?? "text";
}

export function propertyIcon(app: any, id: string): string {
  const { kind, name } = splitId(id);
  if (kind === "file") return FILE_PROPERTIES.find((p) => p.name === name)?.icon ?? "lucide-file";
  if (kind === "formula") return "lucide-square-function";
  const type = app.metadataTypeManager?.getAssignedType?.(name) ?? app.metadataTypeManager?.getPropertyInfo?.(name)?.type ?? "text";
  return TYPE_ICONS[type] ?? "lucide-text";
}

/** Sort direction labels by kind ("A→Z", "0→1", "Old to new"). */
export function directionLabels(kind: PropertyKind): { ASC: string; DESC: string } {
  if (kind === "number") return { ASC: "0→1", DESC: "1→0" };
  if (kind === "date") return { ASC: "Old to new", DESC: "New to old" };
  return { ASC: "A→Z", DESC: "Z→A" };
}

// ---------------------------------------------------------------------------
// filter operators

export interface Operator {
  id: string;
  label: string;
  /** false when the operator takes no value */
  value: boolean;
}

const op = (id: string, label: string, value = true): Operator => ({ id, label, value });

const EMPTY_OPS = [op("empty", "is empty", false), op("not-empty", "is not empty", false)];

export function operatorsFor(propId: string, kind: PropertyKind): Operator[] {
  const { kind: source } = splitId(propId);
  const hasProp = source === "note" ? [op("has-property", "has property", false), op("not-has-property", "does not have property", false)] : [];
  switch (kind) {
    case "number":
      return [op("eq", "="), op("neq", "≠"), op("lt", "<"), op("lte", "≤"), op("gt", ">"), op("gte", "≥"), ...EMPTY_OPS, ...hasProp];
    case "date":
      return [op("eq", "on"), op("neq", "not on"), op("lt", "before"), op("lte", "on or before"), op("gt", "after"), op("gte", "on or after"), ...EMPTY_OPS, ...hasProp];
    case "checkbox":
      return [op("eq", "is"), op("neq", "is not"), ...hasProp];
    case "list":
      return [
        op("contains", "contains"),
        op("not-contains", "does not contain"),
        op("contains-any", "contains any of"),
        op("not-contains-any", "does not contain any of"),
        op("contains-all", "contains all of"),
        op("not-contains-all", "does not contain all of"),
        op("eq", "is exactly"),
        op("neq", "is not exactly"),
        ...(propId === "file.tags" ? [op("has-tag", "has tag"), op("not-has-tag", "does not have tag")] : []),
        ...EMPTY_OPS,
        ...hasProp,
      ];
    case "file":
      return [
        op("links-to", "links to"),
        op("not-links-to", "does not link to"),
        op("in-folder", "in folder"),
        op("not-in-folder", "is not in folder"),
        op("has-tag", "has tag"),
        op("not-has-tag", "does not have tag"),
        op("has-property", "has property"),
        op("not-has-property", "does not have property"),
      ];
    default:
      return [
        op("eq", "is"),
        op("neq", "is not"),
        op("contains", "contains"),
        op("not-contains", "does not contain"),
        op("starts-with", "starts with"),
        op("not-starts-with", "does not start with"),
        op("ends-with", "ends with"),
        op("not-ends-with", "does not end with"),
        op("matches", "matches"),
        op("not-matches", "does not match"),
        ...(propId === "file.folder" ? [op("in-folder", "in folder"), op("not-in-folder", "is not in folder")] : []),
        ...(kind === "any" ? [op("lt", "<"), op("lte", "≤"), op("gt", ">"), op("gte", "≥")] : []),
        ...EMPTY_OPS,
        ...hasProp,
      ];
  }
}

// ---------------------------------------------------------------------------
// expressions

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The expression that reads property `id` (`status`, `note["my prop"]`, `file.name`, `formula.x`). */
export function propertyExpression(id: string): string {
  const { kind, name } = splitId(id);
  if (IDENT.test(name)) return kind === "note" ? name : `${kind}.${name}`;
  return `${kind}[${JSON.stringify(name)}]`;
}

function looksLikeExpression(text: string): boolean {
  const t = text.trim();
  return (
    /^(this|now\(\)|today\(\))(\.|$)/.test(t) ||
    /^(file|note|formula)\.[A-Za-z_]/.test(t) ||
    /^[a-z][A-Za-z]*\(.*\)$/.test(t) ||
    /^\/.*\/[a-z]*$/.test(t) ||
    /^\[.*\]$/.test(t) && !/^\[\[.*\]\]$/.test(t)
  );
}

/** A literal for a value typed into the filter builder. */
export function literal(text: string, kind: PropertyKind): string {
  const t = text.trim();
  const wiki = /^\[\[([^\]]+)\]\]$/.exec(t);
  if (wiki) return `link(${JSON.stringify(wiki[1]!.split("|")[0])})`;
  if (looksLikeExpression(t)) return t;
  if (kind === "checkbox" && (t === "true" || t === "false")) return t;
  if ((kind === "number" || kind === "any") && t !== "" && Number.isFinite(Number(t))) return t;
  return JSON.stringify(text);
}

function splitArgs(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") cur += src[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "" || out.length) out.push(cur.trim());
  return out;
}

/** Literal expression text → what the value box shows; null when it is not a plain literal. */
function unliteral(src: string): string {
  const t = src.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (/^'(?:[^'\\]|\\.)*'$/.test(t)) return t.slice(1, -1).replace(/\\'/g, "'");
  const link = /^link\(\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\)$/.exec(t);
  if (link) return `[[${unliteral(link[1]!)}]]`;
  const date = /^date\(\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\)$/.exec(t);
  if (date) return unliteral(date[1]!);
  return t;
}

const PROP_SRC = String.raw`(?:(?:note|file|formula)\.[A-Za-z_][A-Za-z0-9_]*|(?:note|formula)\[(?:"(?:[^"\\]|\\.)*"|'[^']*')\]|[A-Za-z_][A-Za-z0-9_]*)`;

function propFromSource(src: string): BasesPropertyId | null {
  const bracket = /^(note|formula)\[(.*)\]$/.exec(src);
  if (bracket) return `${bracket[1] as "note" | "formula"}.${unliteral(bracket[2]!)}`;
  if (/^(this|true|false|null|now|today)$/.test(src)) return null;
  return normalizePropertyId(src);
}

export interface FilterRow {
  property: BasesPropertyId;
  operator: string;
  value: string;
}

/** Parses an expression written by the simple filter builder; null when it cannot be represented. */
export function parseFilterRow(expression: string): FilterRow | null {
  let s = expression.trim();
  let negated = false;
  if (s.startsWith("!")) {
    negated = true;
    s = s.slice(1).trim();
  }
  while (s.startsWith("(") && s.endsWith(")") && splitArgs(s.slice(1, -1)).length === 1 && balanced(s.slice(1, -1))) s = s.slice(1, -1).trim();
  const neg = (id: string) => (negated ? `not-${id}` : id);

  const fileFn = /^file\.(hasProperty|inFolder|hasTag|hasLink)\((.*)\)$/.exec(s);
  if (fileFn) {
    const args = splitArgs(fileFn[2]!);
    switch (fileFn[1]) {
      case "hasProperty":
        if (args.length !== 1) return null;
        return { property: normalizePropertyId(unliteral(args[0]!)), operator: neg("has-property"), value: "" };
      case "inFolder":
        return args.length === 1 ? { property: "file.file", operator: neg("in-folder"), value: unliteral(args[0]!) } : null;
      case "hasTag":
        return { property: "file.file", operator: neg("has-tag"), value: args.map(unliteral).join(", ") };
      case "hasLink":
        return args.length === 1 ? { property: "file.file", operator: neg("links-to"), value: unliteral(args[0]!) } : null;
    }
  }

  const method = new RegExp(`^(${PROP_SRC})\\.(contains|containsAny|containsAll|startsWith|endsWith|isEmpty)\\((.*)\\)$`).exec(s);
  if (method) {
    const property = propFromSource(method[1]!);
    if (!property) return null;
    const args = splitArgs(method[3]!);
    const map: Record<string, string> = { contains: "contains", containsAny: "contains-any", containsAll: "contains-all", startsWith: "starts-with", endsWith: "ends-with", isEmpty: "empty" };
    const id = map[method[2]!]!;
    if (id === "empty") return args.length === 0 ? { property, operator: negated ? "not-empty" : "empty", value: "" } : null;
    if ((id === "contains" || id === "starts-with" || id === "ends-with") && args.length !== 1) return null;
    return { property, operator: neg(id), value: args.map(unliteral).join(", ") };
  }

  const regex = new RegExp(`^(/(?:[^/\\\\]|\\\\.)+/[a-z]*)\\.matches\\((${PROP_SRC})\\)$`).exec(s);
  if (regex) {
    const property = propFromSource(regex[2]!);
    return property ? { property, operator: neg("matches"), value: regex[1]!.replace(/^\/|\/[a-z]*$/g, "") } : null;
  }

  if (negated) return null;
  const cmp = new RegExp(`^(${PROP_SRC})\\s*(==|!=|<=|>=|<|>)\\s*(.+)$`).exec(s);
  if (cmp) {
    const property = propFromSource(cmp[1]!);
    if (!property) return null;
    const ops: Record<string, string> = { "==": "eq", "!=": "neq", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" };
    const rhs = cmp[3]!.trim();
    if (/&&|\|\|/.test(rhs.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ""))) return null;
    return { property, operator: ops[cmp[2]!]!, value: unliteral(rhs) };
  }
  return null;
}

function balanced(s: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/** The expression for a builder row. */
export function buildFilterRow(row: FilterRow, kind: PropertyKind): string {
  const p = propertyExpression(row.property);
  const negated = row.operator.startsWith("not-");
  const base = negated ? row.operator.slice(4) : row.operator;
  const bang = negated ? "!" : "";
  const v = () => literal(row.value, kind);
  const list = () =>
    row.value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => literal(x, kind === "list" ? "text" : kind))
      .join(", ");
  const { name } = splitId(row.property);
  switch (base) {
    case "eq":
      return `${p} == ${v()}`;
    case "neq":
      return `${p} != ${v()}`;
    case "lt":
      return `${p} < ${v()}`;
    case "lte":
      return `${p} <= ${v()}`;
    case "gt":
      return `${p} > ${v()}`;
    case "gte":
      return `${p} >= ${v()}`;
    case "contains":
      return `${bang}${p}.contains(${literal(row.value, kind === "list" ? "text" : kind)})`;
    case "contains-any":
      return `${bang}${p}.containsAny(${list()})`;
    case "contains-all":
      return `${bang}${p}.containsAll(${list()})`;
    case "starts-with":
      return `${bang}${p}.startsWith(${JSON.stringify(row.value)})`;
    case "ends-with":
      return `${bang}${p}.endsWith(${JSON.stringify(row.value)})`;
    case "matches":
      return `${bang}/${row.value.replace(/\//g, "\\/")}/.matches(${p})`;
    case "empty":
      return negated ? `!${p}.isEmpty()` : `${p}.isEmpty()`;
    case "has-property":
      return `${bang}file.hasProperty(${JSON.stringify(name === "file" ? row.value : name)})`;
    case "in-folder":
      return `${bang}file.inFolder(${JSON.stringify(row.value)})`;
    case "has-tag":
      return `${bang}file.hasTag(${
        row.value
          .split(",")
          .map((t) => t.trim().replace(/^#/, ""))
          .filter(Boolean)
          .map((t) => JSON.stringify(t))
          .join(", ") || '""'
      })`;
    case "links-to": {
      const t = row.value.trim();
      const wiki = /^\[\[([^\]|]+)/.exec(t);
      return `${bang}file.hasLink(${wiki ? `link(${JSON.stringify(wiki[1])})` : looksLikeExpression(t) ? t : `link(${JSON.stringify(t)})`})`;
    }
    default:
      return `${p} == ${v()}`;
  }
}

// ---------------------------------------------------------------------------
// filter trees

export type FilterNode = string | { and: FilterNode[] } | { or: FilterNode[] } | { not: FilterNode[] };
export type Conjunction = "and" | "or" | "not";

export function conjunctionOf(node: FilterNode): Conjunction | null {
  if (typeof node === "string" || !node) return null;
  if ("and" in node) return "and";
  if ("or" in node) return "or";
  if ("not" in node) return "not";
  return null;
}

export function childrenOf(node: FilterNode): FilterNode[] {
  const c = conjunctionOf(node);
  return c ? ((node as Record<string, FilterNode[]>)[c] ?? []) : [];
}

/** A group node as one expression (for the advanced editor). */
export function filterToExpression(node: FilterNode | undefined | null): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  const c = conjunctionOf(node);
  const parts = childrenOf(node)
    .map((n) => filterToExpression(n))
    .filter((s) => s.trim() !== "");
  if (!parts.length) return "";
  const wrapped = parts.map((p) => (parts.length > 1 && /&&|\|\|/.test(p) ? `(${p})` : p));
  if (c === "and") return wrapped.join(" && ");
  if (c === "or") return wrapped.join(" || ");
  return `!(${parts.map((p) => (parts.length > 1 ? `(${p})` : p)).join(" || ")})`;
}
