/**
 * Plain-language queries (`ai-query`, off by default, AI feature "query"):
 * describe what you want ("unread books rated 4+") and get a Bases view, a
 * Dataview query or a Tasks query, written against the vault's real property
 * names and types. The query is shown editable with a live preview of its
 * results; nothing is inserted until the user picks Insert.
 *
 * Bases YAML is checked with the engine's parser (`bases_parse`) and property
 * names against the vault; Dataview and Tasks queries get a structural check.
 * A query that fails is sent back once with the error.
 *
 * Commands: "Write a query from a description" (inside an empty or
 * description-only ```base / ```dataview / ```tasks block it fills that
 * block).
 */
import { getEngine } from "@vault/engine";
import type { EngineInfo } from "../../ai/types";
import { MarkdownView } from "../../obsidian/markdown/markdown-view";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { ButtonComponent, DropdownComponent, Setting } from "../../obsidian/ui/setting";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { debounce, normalizePath } from "../../obsidian/util";
import type { TFile } from "../../obsidian/vault/files";
import {
  aiAvailable,
  aiOf,
  communityPluginEnabled,
  errorMessage,
  generate,
  isAbort,
  LivePreview,
  propertySchema,
  renderEngineBadge,
  vaultFolders,
  vaultTags,
} from "../ai-suggest/shared";

const PLUGIN_ID = "ai-query";

export type QueryKind = "base" | "dataview" | "tasks";

export interface AiQueryOptions {
  /** "auto" picks per what is enabled. */
  defaultKind: "auto" | QueryKind;
}

export const DEFAULT_AI_QUERY_OPTIONS: AiQueryOptions = { defaultKind: "auto" };

const KIND_LABEL: Record<QueryKind, string> = { base: "Bases view", dataview: "Dataview query", tasks: "Tasks query" };
const DATAVIEW_ID = "dataview";
const TASKS_ID = "obsidian-tasks-plugin";

export function kindEnabled(app: any, kind: QueryKind): boolean {
  if (kind === "base") return !!app.internalPlugins?.getEnabledPluginById?.("bases");
  if (kind === "dataview") return communityPluginEnabled(app, DATAVIEW_ID);
  return communityPluginEnabled(app, TASKS_ID);
}

export function pickKind(app: any, description: string, preferred: AiQueryOptions["defaultKind"]): QueryKind {
  if (preferred !== "auto") return preferred;
  if (/\b(tasks?|to-?dos?|due|overdue|checkbox(es)?)\b/i.test(description) && kindEnabled(app, "tasks")) return "tasks";
  if (kindEnabled(app, "base")) return "base";
  if (kindEnabled(app, "dataview")) return "dataview";
  if (kindEnabled(app, "tasks")) return "tasks";
  return "base";
}

/** The body of the first fenced block in `text`, or the text itself. */
export function extractQuery(text: string): string {
  const fence = /(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2\s*(\n|$)/.exec(text);
  const body = fence ? fence[3]! : text.replace(/^(`{3,}|~{3,})[^\n]*\n?/, "").replace(/\n?(`{3,}|~{3,})\s*$/, "");
  return body.replace(/^\n+/, "").replace(/\s+$/, "");
}

const BASE_KEYWORDS = new Set(["true", "false", "null", "and", "or", "not", "this", "file", "note", "formula", "values", "if", "now", "today", "date", "duration", "link", "list", "number", "min", "max", "image", "icon", "html"]);

/** Bare property names an expression reads (ignoring strings, functions, `file.*` and `formula.*`). */
export function expressionProperties(expr: string): string[] {
  const out = new Set<string>();
  const src = expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^/\\\n]|\\.)+\/[a-z]*/g, '""');
  for (const m of expr.matchAll(/note\[\s*["']([^"']+)["']\s*\]/g)) out.add(m[1]!);
  const re = /(^|[^\w.$])([A-Za-z_][\w-]*)(\s*\.\s*[A-Za-z_][\w]*)?(\s*\()?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[2]!;
    const member = m[3]?.replace(/\s|\./g, "");
    if (name === "note" && member) {
      out.add(member);
      continue;
    }
    if (m[4] && !member) continue; // a function call
    if (BASE_KEYWORDS.has(name)) continue;
    out.add(name);
  }
  return [...out];
}

function filterStrings(node: unknown, out: string[]) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const n of node) filterStrings(n, out);
  else if (node && typeof node === "object") for (const v of Object.values(node)) filterStrings(v, out);
}

export interface Validation {
  errors: string[];
  warnings: string[];
}

export function validateBase(app: any, yaml: string): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: { base?: any; error?: string; errors?: string[] };
  try {
    parsed = getEngine().bases.parse(yaml) as any;
  } catch (e) {
    return { errors: [errorMessage(e)], warnings };
  }
  if (parsed.error) return { errors: [parsed.error], warnings };
  errors.push(...(parsed.errors ?? []));
  const base = parsed.base ?? {};
  if (!Array.isArray(base.views) || !base.views.length) errors.push('A base needs at least one view under "views", e.g. "- type: table" with a "name".');
  const known = new Set(propertySchema(app, 100_000).map((p) => p.name.toLowerCase()));
  const formulas = new Set(Object.keys(base.formulas ?? {}).map((k) => k.toLowerCase()));
  const exprs: string[] = [];
  filterStrings(base.filters, exprs);
  for (const v of Array.isArray(base.views) ? base.views : []) {
    filterStrings(v?.filters, exprs);
    for (const id of Array.isArray(v?.order) ? v.order : []) if (typeof id === "string") exprs.push(id.includes(".") ? id : `note.${id}`);
  }
  for (const f of Object.values(base.formulas ?? {})) if (typeof f === "string") exprs.push(f);
  const unknown = new Set<string>();
  for (const e of exprs) for (const name of expressionProperties(e)) if (!known.has(name.toLowerCase()) && !formulas.has(name.toLowerCase())) unknown.add(name);
  if (unknown.size) errors.push(`No note in this vault has the ${unknown.size === 1 ? "property" : "properties"} ${[...unknown].map((n) => `"${n}"`).join(", ")}.`);
  return { errors, warnings };
}

const DATAVIEW_START = /^(TABLE(\s+WITHOUT\s+ID)?|LIST(\s+WITHOUT\s+ID)?|TASK|CALENDAR)\b/i;
const DATAVIEW_CLAUSE = /^(FROM|WHERE|SORT|GROUP\s+BY|FLATTEN|LIMIT)\b/i;

export function validateDataview(query: string): Validation {
  const lines = query.split("\n").map((l) => l.trim()).filter(Boolean);
  const errors: string[] = [];
  if (!lines.length) return { errors: ["The query is empty."], warnings: [] };
  if (!DATAVIEW_START.test(lines[0]!)) errors.push(`A Dataview query starts with TABLE, LIST, TASK or CALENDAR, not “${lines[0]!.slice(0, 30)}”.`);
  for (const l of lines.slice(1)) if (!DATAVIEW_CLAUSE.test(l) && !l.startsWith("//")) errors.push(`“${l.slice(0, 40)}” is not a Dataview clause (FROM, WHERE, SORT, GROUP BY, FLATTEN, LIMIT).`);
  if (/[^=!<>]==[^=]/.test(query.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) errors.push("Use = for equality in Dataview, not ==.");
  if (/\b(dql|```)/i.test(query)) errors.push("Answer with the query only, no code fence.");
  return { errors, warnings: [] };
}

const TASKS_LINE = [
  /^(not\s+)?done$/,
  /^(due|scheduled|starts|start|created|done|cancelled|happens)\s+(before|after|on|in|on or before|on or after)\s+.+$/,
  /^(has|no)\s+(due|scheduled|start|created|done|cancelled|happens)\s+date$/,
  /^(has|no)\s+(time|tags|id|depends on)$/,
  /^(path|description|heading|filename|folder|root|tag|tags|status\.name|status\.type|recurrence|id)\s+(includes|does not include|regex matches|regex does not match|is|is not)\s+.+$/,
  /^tags?\s+(include|do not include|includes|does not include)\s+.+$/,
  /^priority\s+is\s+(above\s+|below\s+|not\s+)?(highest|high|medium|none|low|lowest)$/,
  /^is\s+(not\s+)?(recurring|blocked|blocking)$/,
  /^exclude\s+sub-?items$/,
  /^(sort|group)\s+by\s+.+$/,
  /^limit\s+(groups\s+)?(to\s+)?\d+(\s+tasks)?$/,
  /^(hide|show)\s+.+$/,
  /^(short|full)\s+mode$/,
  /^explain$/,
  /^ignore\s+global\s+query$/,
  /^(\(.*\))(\s+(AND|OR|XOR|AND NOT|OR NOT)\s+\(.*\))*$/,
  /^NOT\s+\(.*\)$/,
  /^filter\s+by\s+function\s+.+$/,
  /^#.*$/,
];

export function validateTasks(query: string): Validation {
  const errors: string[] = [];
  for (const raw of query.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (!TASKS_LINE.some((re) => re.test(l.replace(/\s+/g, " ")) || re.test(l.toLowerCase().replace(/\s+/g, " ")))) errors.push(`“${l.slice(0, 50)}” is not a Tasks instruction.`);
  }
  if (!query.trim()) errors.push("The query is empty.");
  return { errors, warnings: [] };
}

export function validateQuery(app: any, kind: QueryKind, query: string): Validation {
  if (kind === "base") return validateBase(app, query);
  if (kind === "dataview") return validateDataview(query);
  return validateTasks(query);
}

function grounding(app: any): string {
  const props = propertySchema(app, 80);
  const tags = vaultTags(app, 60);
  const folders = vaultFolders(app);
  return [
    "Properties in this vault (name (type): example values):",
    ...(props.length ? props.map((p) => `- ${p.name} (${p.type})${p.samples.length ? `: ${p.samples.join(", ")}` : ""}`) : ["(none)"]),
    `Tags: ${tags.length ? tags.map((t) => `#${t}`).join(" ") : "(none)"}`,
    `Folders: ${folders.length ? folders.join(", ") : "(none)"}`,
  ].join("\n");
}

const SYSTEM: Record<QueryKind, string> = {
  base: [
    "Task: query-base",
    "Write an Obsidian Bases view (the YAML of a .base file) for the user's description.",
    "Schema: optional top-level `filters`; `views`: a list with one view {type: table, name: <short name>, filters?, order?: [property ids], sort?: [{property, direction: ASC|DESC}], limit?}.",
    "Filters are a string expression or {and: [...]}, {or: [...]}, {not: [...]} of expressions. Expressions: note properties by bare name (rating >= 4, read == false, status != \"done\"), file.name, file.folder, file.path, file.ext, file.mtime, file.ctime, file.tags; functions file.hasTag(\"x\") (no #), file.inFolder(\"Folder\"), file.hasLink(\"Note\"), list.contains(x), string.contains(\"x\"), date(\"2025-01-01\"), today(), now(); date math like file.mtime > now() - \"7d\". Use == and != for equality; single-quote a YAML string that contains double quotes.",
    "Only use property names from the list below, with operators that fit their type (checkbox → == true/false, number → comparisons, date → date comparisons, list → .contains()).",
    "Put file.name first in `order`, then the properties the description is about.",
    "Answer with the YAML only.",
  ].join("\n"),
  dataview: [
    "Task: query-dataview",
    "Write a Dataview query (DQL) for the user's description.",
    "Form: TABLE <fields> | LIST | TASK, then optional FROM \"Folder\" or FROM #tag, WHERE <condition>, SORT <field> ASC|DESC, GROUP BY, LIMIT n — each clause on its own line.",
    "Fields are frontmatter property names (bare), and file.name, file.link, file.folder, file.tags, file.mtime, file.ctime, file.day. Equality is =, not ==; booleans are true/false; strings in double quotes; dates date(today), date(2025-01-01), durations dur(7 days). For tasks: TASK WHERE !completed.",
    "Only use property names from the list below.",
    "Answer with the query only, without a code fence.",
  ].join("\n"),
  tasks: [
    "Task: query-tasks",
    "Write an Obsidian Tasks plugin query for the user's description: one instruction per line.",
    "Instructions: not done | done; due|scheduled|starts|done|created before|after|on <date or 'today', 'tomorrow', 'next week'>; has due date | no due date; path includes <text>; folder includes <text>; description includes <text>; heading includes <text>; tags include #tag; priority is above|below|is high|medium|low; is recurring; sort by due|priority|path|description|done; group by folder|filename|heading|due|tags; limit <n>; short mode; hide backlink.",
    "Answer with the query only, without a code fence.",
  ].join("\n"),
};

/** Asks the model for a query, validates it, and retries once with the errors. */
export async function writeQuery(
  app: any,
  kind: QueryKind,
  description: string,
  signal?: AbortSignal,
): Promise<{ query: string; validation: Validation; engine: EngineInfo; attempts: number } | null> {
  const user = `${grounding(app)}\n\nDescription: ${description.trim()}`;
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: user }];
  const first = await generate(app, { feature: "query", system: SYSTEM[kind], messages, temperature: 0.1, maxTokens: 600, signal });
  if (!first) return null;
  let query = extractQuery(first.text);
  let validation = validateQuery(app, kind, query);
  let engine = first.engine;
  if (!validation.errors.length) return { query, validation, engine, attempts: 1 };
  messages.push({ role: "assistant", content: first.text }, { role: "user", content: `That query has errors:\n${validation.errors.map((e) => `- ${e}`).join("\n")}\nFix them and answer with the corrected query only.` });
  const second = await generate(app, { feature: "query", system: SYSTEM[kind], messages, temperature: 0, maxTokens: 600, signal });
  if (!second) return null;
  const retried = extractQuery(second.text);
  const retriedValidation = validateQuery(app, kind, retried);
  query = retried;
  validation = retriedValidation;
  engine = second.engine;
  return { query, validation, engine, attempts: 2 };
}

/** A fenced ```base / ```dataview / ```tasks block around the cursor. */
export function blockAtCursor(lines: string[], line: number): { kind: QueryKind; start: number; end: number; body: string } | null {
  for (let i = line; i >= 0; i--) {
    const open = /^\s*(`{3,}|~{3,})\s*(base|dataview|tasks)\s*$/.exec(lines[i]!);
    if (!open) {
      if (i < line && /^\s*(`{3,}|~{3,})/.test(lines[i]!)) return null;
      continue;
    }
    const fence = open[1]!;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(lines[j]!)) j++;
    if (j >= lines.length || line > j) return null;
    return { kind: open[2] as QueryKind, start: i, end: j, body: lines.slice(i + 1, j).join("\n") };
  }
  return null;
}

class QueryModal extends Modal {
  private kind: QueryKind;
  private descEl!: HTMLTextAreaElement;
  private kindDropdown!: DropdownComponent;
  private generateBtn!: ButtonComponent;
  private engineEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private sourceEl!: HTMLTextAreaElement;
  private validationEl!: HTMLElement;
  private preview!: LivePreview;
  private insertBtn: ButtonComponent | null = null;
  private saveBtn!: ButtonComponent;
  private controller: AbortController | null = null;
  private schedulePreview = debounce(() => void this.updatePreview(), 350, true);

  constructor(
    app: any,
    private plugin: AiQueryPlugin,
    private target: { view: MarkdownView; block: ReturnType<typeof blockAtCursor> } | null,
    initial: { description: string; kind: QueryKind },
  ) {
    super(app);
    this.kind = initial.kind;
    this.modalEl.addClass("ai-query-modal", "ai-assist-modal");
    this.setTitle("Write a query");
    this.build(initial.description);
  }

  private build(description: string) {
    const el = this.contentEl;
    const form = el.createDiv({ cls: "ai-assist-form" });
    form.createEl("label", { cls: "ai-assist-label", text: "Describe what you want to see", attr: { for: "ai-query-description" } });
    this.descEl = form.createEl("textarea", { cls: "ai-query-description", attr: { id: "ai-query-description", rows: "2", placeholder: "Unread books rated 4 or more, best first" } });
    this.descEl.value = description;
    this.descEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        void this.generate();
      }
    });
    const row = form.createDiv({ cls: "ai-assist-row" });
    this.kindDropdown = new DropdownComponent(row);
    this.kindDropdown.selectEl.addClass("ai-query-kind");
    this.kindDropdown.selectEl.setAttr("aria-label", "Query type");
    for (const k of ["base", "dataview", "tasks"] as QueryKind[]) this.kindDropdown.addOption(k, kindEnabled(this.app, k) ? KIND_LABEL[k] : `${KIND_LABEL[k]} (plugin off)`);
    this.kindDropdown.setValue(this.kind).onChange((v) => {
      this.kind = v as QueryKind;
      this.updateButtons();
      void this.updatePreview();
    });
    this.generateBtn = new ButtonComponent(row).setButtonText("Write query").setCta().onClick(() => void this.generate());
    this.generateBtn.buttonEl.addClass("ai-query-generate");
    this.engineEl = row.createDiv();
    renderEngineBadge(this.engineEl, aiOf(this.app)?.engineFor("query") ?? null);
    this.statusEl = el.createDiv({ cls: "ai-assist-status", attr: { "aria-live": "polite" } });

    el.createEl("label", { cls: "ai-assist-label", text: "Query (you can edit it)", attr: { for: "ai-query-source" } });
    this.sourceEl = el.createEl("textarea", { cls: "ai-query-source", attr: { id: "ai-query-source", rows: "8", spellcheck: "false" } });
    this.sourceEl.addEventListener("input", () => this.schedulePreview());
    this.validationEl = el.createDiv({ cls: "ai-query-validation" });
    el.createDiv({ cls: "ai-assist-label", text: "Preview" });
    this.preview = new LivePreview(this.app, el.createDiv({ cls: "ai-assist-preview ai-query-preview" }));
    this.preview.message("Write a query to see its results here.");

    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    if (this.target) {
      this.insertBtn = new ButtonComponent(buttons).setButtonText(this.target.block ? "Replace block" : "Insert").setCta().onClick(() => void this.insert());
      this.insertBtn.buttonEl.addClass("ai-query-insert");
    }
    this.saveBtn = new ButtonComponent(buttons).setButtonText("Save as base file").onClick(() => void this.saveBase());
    this.saveBtn.buttonEl.addClass("ai-query-save");
    new ButtonComponent(buttons).setButtonText("Copy").onClick(async () => {
      await navigator.clipboard.writeText(this.fenced()).catch(() => {});
      new Notice("Copied.");
    });
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    this.updateButtons();
  }

  override onOpen() {
    this.descEl.focus();
    if (this.descEl.value.trim()) void this.generate();
  }

  override onClose() {
    this.controller?.abort();
    this.schedulePreview.cancel();
    this.preview.dispose();
  }

  private updateButtons() {
    const empty = !this.sourceEl.value.trim();
    this.insertBtn?.setDisabled(empty);
    this.saveBtn.buttonEl.toggle(this.kind === "base");
    this.saveBtn.setDisabled(empty);
  }

  private fenced(): string {
    return `\`\`\`${this.kind}\n${this.sourceEl.value.replace(/\s+$/, "")}\n\`\`\``;
  }

  async generate() {
    const description = this.descEl.value.trim();
    if (!description) {
      this.statusEl.setText("Describe the notes or tasks you want first.");
      return;
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.generateBtn.setDisabled(true);
    this.statusEl.setText("Writing the query…");
    this.modalEl.addClass("is-loading");
    try {
      const res = await writeQuery(this.app, this.kind, description, controller.signal);
      if (controller.signal.aborted) return;
      if (!res) {
        this.statusEl.setText("Cancelled.");
        return;
      }
      renderEngineBadge(this.engineEl, res.engine);
      this.sourceEl.value = res.query;
      this.statusEl.setText(res.validation.errors.length ? "The query still has problems — edit it before inserting." : res.attempts > 1 ? "Fixed after a second try. Nothing is inserted until you choose." : "Nothing is inserted until you choose.");
      await this.updatePreview();
    } catch (e) {
      if (!isAbort(e)) this.statusEl.setText(errorMessage(e));
    } finally {
      if (this.controller === controller) this.controller = null;
      this.generateBtn.setDisabled(false);
      this.modalEl.removeClass("is-loading");
      this.updateButtons();
    }
  }

  async updatePreview() {
    this.updateButtons();
    const query = this.sourceEl.value;
    const validation = query.trim() ? validateQuery(this.app, this.kind, query) : { errors: [], warnings: [] };
    this.validationEl.empty();
    this.validationEl.toggleClass("mod-warning", validation.errors.length > 0);
    for (const e of validation.errors) this.validationEl.createDiv({ cls: "ai-query-error", text: e });
    if (!query.trim()) {
      this.preview.message("Write a query to see its results here.");
      return;
    }
    if (validation.errors.length && this.kind === "base") {
      this.preview.message("Fix the errors above to see the results.");
      return;
    }
    if (!kindEnabled(this.app, this.kind)) {
      const need = this.kind === "base" ? "the Bases core plugin" : this.kind === "dataview" ? "the Dataview plugin" : "the Tasks plugin";
      this.preview.message(`The preview needs ${need}, which is turned off.`);
      return;
    }
    const sourcePath = this.target?.view.file?.path ?? this.app.workspace.getActiveFile()?.path ?? "";
    await this.preview.render(this.fenced(), sourcePath);
  }

  async insert() {
    const target = this.target;
    const editor = target?.view.editor;
    if (!target || !editor) return;
    const body = this.sourceEl.value.replace(/\s+$/, "");
    if (target.block) {
      const b = target.block;
      const lines = editor.getValue().split("\n");
      const now = blockAtCursor(lines, b.start + 1);
      if (!now || now.start !== b.start) {
        new Notice("The code block has moved. Put the cursor in it and try again.");
        return;
      }
      editor.transaction({ changes: [{ from: { line: now.start + 1, ch: 0 }, to: { line: now.end, ch: 0 }, text: body ? `${body}\n` : "" }] }, "ai-assist");
    } else {
      const cursor = editor.getCursor("to");
      const line = editor.getLine(cursor.line);
      const before = line.slice(0, cursor.ch).trim() ? "\n\n" : "";
      const after = line.slice(cursor.ch).trim() ? "\n\n" : "\n";
      editor.transaction({ changes: [{ from: cursor, to: cursor, text: `${before}${this.fenced()}${after}` }] }, "ai-assist");
    }
    this.close();
  }

  async saveBase() {
    const yaml = this.sourceEl.value.replace(/\s+$/, "") + "\n";
    const name = this.descEl.value.trim().replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Untitled base";
    const active = this.app.workspace.getActiveFile() as TFile | null;
    const parent = this.app.fileManager.getNewFileParent(active?.path ?? "");
    const stem = normalizePath(parent && !parent.isRoot() ? `${parent.path}/${name}` : name);
    const path = this.app.vault.getAvailablePath(stem, "base");
    const file = await this.app.vault.create(path, yaml);
    this.close();
    await this.app.workspace.getLeaf(false).openFile(file, { active: true });
  }
}

export class AiQueryPlugin extends Plugin {
  instance!: any;

  get options(): AiQueryOptions {
    return { ...DEFAULT_AI_QUERY_OPTIONS, ...(this.instance.options as Partial<AiQueryOptions>) };
  }

  override async onload() {
    this.addCommand({
      id: "ai-query:write-query",
      name: "Write a query from a description",
      icon: "lucide-sparkles",
      checkCallback: (checking) => {
        if (!aiAvailable(this.app, "query")) return false;
        if (!checking) this.open();
        return true;
      },
    });
    this.addSettingTab(new AiQuerySettingTab(this.app, this));
  }

  /** Opens the query writer; inside a query code block it fills that block. */
  open(description = "") {
    // The last focused note, even while a sidebar or the command palette has focus.
    const ws = this.app.workspace;
    const view = ((ws.getActiveViewOfType(MarkdownView) as MarkdownView | null) ?? (ws.activeEditor instanceof MarkdownView ? ws.activeEditor : null) ?? (ws.getMostRecentLeaf?.(ws.rootSplit)?.view instanceof MarkdownView ? ws.getMostRecentLeaf(ws.rootSplit).view : null)) as MarkdownView | null;
    const usable = view?.file && view.getMode() !== "preview" ? view : null;
    let block: ReturnType<typeof blockAtCursor> = null;
    if (usable) {
      const editor = usable.editor;
      block = blockAtCursor(editor.getValue().split("\n"), editor.getCursor().line);
    }
    const kind = block?.kind ?? pickKind(this.app, description, this.options.defaultKind);
    // A block that holds a description rather than a query seeds the description.
    if (block && !description && block.body.trim() && validateQuery(this.app, block.kind, block.body).errors.length) description = block.body.trim();
    const modal = new QueryModal(this.app, this, usable ? { view: usable, block } : null, { description, kind });
    modal.open();
    return modal;
  }
}

class AiQuerySettingTab extends PluginSettingTab {
  constructor(
    app: any,
    private owner: AiQueryPlugin,
  ) {
    super(app, owner as any);
    this.id = PLUGIN_ID;
    this.name = "AI queries";
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    el.createEl("p", { cls: "setting-item-description", text: "Describe what you want and get a Bases view, a Dataview query or a Tasks query, shown with a preview before it is inserted." });
    new Setting(el)
      .setName("Query type")
      .setDesc("Automatic picks Tasks for task questions when the Tasks plugin is on, else Bases, else Dataview.")
      .addDropdown((d) =>
        d
          .addOptions({ auto: "Automatic", base: KIND_LABEL.base, dataview: KIND_LABEL.dataview, tasks: KIND_LABEL.tasks })
          .setValue(this.owner.options.defaultKind)
          .onChange((v) => {
            this.owner.instance.options.defaultKind = v;
            void this.owner.instance.saveOptions();
          }),
      );
  }
}
