/**
 * BasesController — the `QueryController` a base's views receive. It holds
 * the parsed base, runs the selected view through the vault-bases engine over
 * the vault's file records, and turns the result into `BasesQueryResult`.
 */
import { getEngine } from "@vault/engine";
import {
  BasesEntry,
  BasesEntryGroup,
  BasesQueryResult,
  BasesViewConfig,
  ErrorValue,
  NullValue,
  QueryController,
  builtinSummary,
  normalizePropertyId,
  valueFromJson,
  type BasesPropertyId,
  type Value,
} from "../../obsidian/bases/api";
import { Notice } from "../../obsidian/ui/notice";
import { normalizePath, stringifyYaml } from "../../obsidian/util";
import type { TFile, TFolder } from "../../obsidian/vault/files";
import { allPropertyIds, childrenOf, conjunctionOf, parseFilterRow, propertyExpression, splitId, type FilterNode } from "./properties";
import type { FileRecordJson, FileRecordStore } from "./records";

export interface ControllerHost {
  /** The base changed through the UI or a view's config: persist it. */
  onBaseChanged(): void;
  /** A property was requested that the last run did not compute. */
  onNeedsRerun(): void;
  /** Folder new files go to when the view has no "newItemFolder". */
  defaultNewFileFolder(): TFolder;
}

export function tzOffset(): number {
  return -new Date().getTimezoneOffset();
}

export class BasesController extends QueryController {
  thisFile: TFile | null = null;
  searchQuery = "";
  // properties plugin views asked for that are not columns (map coordinates …)
  private extraProps = new Set<string>();
  // internal: the raw engine result of the last run
  raw: any = null;
  parseErrors: string[] = [];

  constructor(
    app: any,
    private store: FileRecordStore,
    private host: ControllerHost,
  ) {
    super(app);
  }

  get views(): any[] {
    return Array.isArray(this.base?.views) ? this.base.views : [];
  }

  get currentView(): any {
    return this.views[this.viewIndex] ?? null;
  }

  setBase(base: any) {
    this.base = base ?? { views: [] };
    this.base.views ??= [];
    this.base.formulas ??= {};
    this.base.properties ??= {};
    this.base.summaries ??= {};
    if (this.viewIndex >= this.views.length) this.viewIndex = 0;
  }

  override requestSave(): void {
    this.host.onBaseChanged();
  }

  private thisRecord(): FileRecordJson | null {
    return this.thisFile ? this.store.get(this.thisFile.path) : null;
  }

  /** Runs the current view; returns the new result. */
  run(): BasesQueryResult {
    const engine = getEngine();
    const view = this.currentView;
    this.config = new BasesViewConfig(this, view);
    this.allProperties = allPropertyIds(this.app, this.base);
    const order = this.config.getOrder();
    let raw: any;
    if (!view && this.views.length > 0) raw = { error: `View ${this.viewIndex} not found` };
    else {
      const runBase = this.withExtraColumns(order);
      try {
        raw = engine.bases.runView(runBase, this.viewIndex, this.store.all(), this.thisRecord(), Date.now(), tzOffset());
      } catch (e) {
        raw = { error: String((e as Error).message ?? e) };
      }
    }
    this.raw = raw;
    const errors = [...(raw?.errors ?? [])];
    if (raw?.error) errors.push({ kind: "schema", message: raw.error });
    const vault = this.app.vault;
    const query = this.searchQuery.trim().toLowerCase();
    const groups: BasesEntryGroup[] = [];
    for (const g of (raw?.groups ?? []) as any[]) {
      let entries: BasesEntry[] = [];
      for (const row of g.rows ?? []) {
        const file = vault.getFileByPath(row.path);
        if (!file) continue;
        entries.push(new BasesEntry(this, file, row.cells ?? {}));
      }
      if (query) entries = entries.filter((e) => this.matchesSearch(e, order, query));
      groups.push(new BasesEntryGroup(valueFromJson(g.key), entries, !!g.hasKey, g.summaries ?? {}));
    }
    const grouped = !!view?.groupBy?.property;
    const result = new BasesQueryResult({
      groups: query ? groups.filter((g) => g.entries.length) : groups,
      properties: order,
      summaries: raw?.summaries ?? {},
      total: raw?.total ?? 0,
      errors,
      grouped,
    });
    this.results = result;
    return result;
  }

  private withExtraColumns(order: BasesPropertyId[]): any {
    const view = this.currentView;
    if (!view) return this.base;
    const extra: string[] = [];
    const have = new Set<string>(order.map((o) => normalizePropertyId(o)));
    const want = [...this.extraProps];
    const image = typeof view.image === "string" && view.image ? normalizePropertyId(view.image) : null;
    if (image) want.push(image);
    for (const id of want) if (!have.has(id)) extra.push(id), have.add(id);
    if (!extra.length) return this.base;
    const views = this.views.slice();
    views[this.viewIndex] = { ...view, order: [...(Array.isArray(view.order) ? view.order : ["file.name"]), ...extra] };
    return { ...this.base, views };
  }

  private matchesSearch(entry: BasesEntry, order: BasesPropertyId[], query: string): boolean {
    for (const id of order) {
      const v = entry.getValue(id);
      if (v && v.toString().toLowerCase().includes(query)) return true;
    }
    return entry.file.basename.toLowerCase().includes(query);
  }

  override evaluate(expression: string, file: TFile | null): Value {
    try {
      const out: any = getEngine().bases.eval(expression, {
        files: this.store.all(),
        file: file ? this.store.get(file.path) : this.thisRecord(),
        this: this.thisRecord(),
        nowMs: Date.now(),
        tzOffsetMin: tzOffset(),
      });
      if (out?.error) return new ErrorValue(String(out.error));
      return valueFromJson(out?.value ?? null, file?.path ?? "");
    } catch (e) {
      return new ErrorValue(String((e as Error).message ?? e));
    }
  }

  /** Evaluates without the vault file list (cheap; for per-row fallbacks). */
  private evaluateRow(expression: string, file: TFile): Value {
    const record = this.store.get(file.path);
    try {
      const out: any = getEngine().bases.eval(expression, { files: record ? [record] : [], file: record, this: this.thisRecord(), nowMs: Date.now(), tzOffsetMin: tzOffset() });
      if (out?.error) return new ErrorValue(String(out.error));
      return valueFromJson(out?.value ?? null, file.path);
    } catch (e) {
      return new ErrorValue(String((e as Error).message ?? e));
    }
  }

  override resolveValue(entry: BasesEntry, propertyId: BasesPropertyId): Value | null {
    const id = normalizePropertyId(propertyId);
    if (!this.extraProps.has(id)) {
      this.extraProps.add(id);
      this.host.onNeedsRerun();
    }
    const { kind, name } = splitId(id);
    if (kind === "formula") {
      const formula = this.base?.formulas?.[name];
      if (typeof formula !== "string") return NullValue.value;
      return this.evaluateRow(formula, entry.file);
    }
    return this.evaluateRow(propertyExpression(id), entry.file);
  }

  override computeSummary(entries: BasesEntry[], prop: BasesPropertyId, summaryKey: string): Value {
    return builtinSummary(summaryKey, entries.map((e) => e.getValue(prop) ?? NullValue.value));
  }

  /** Frontmatter a new note needs to pass simple equality filters, plus the folder a folder filter implies. */
  private impliedByFilters(): { frontmatter: Record<string, unknown>; folder: string | null } {
    const frontmatter: Record<string, unknown> = {};
    let folder: string | null = null;
    const visit = (node: FilterNode | undefined) => {
      if (node === undefined || node === null) return;
      if (typeof node === "string") {
        const row = parseFilterRow(node);
        if (!row) return;
        const { kind, name } = splitId(row.property);
        if (row.operator === "eq" && kind === "note") {
          const v = row.value;
          frontmatter[name] = v === "true" ? true : v === "false" ? false : v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
        } else if (row.operator === "contains" && kind === "note") frontmatter[name] = [row.value];
        else if (row.operator === "has-tag") {
          const tags = (frontmatter.tags as string[] | undefined) ?? [];
          for (const t of row.value.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean)) tags.push(t);
          frontmatter.tags = tags;
        } else if (row.operator === "in-folder") folder = row.value;
        return;
      }
      if (conjunctionOf(node) === "and") childrenOf(node).forEach(visit);
    };
    visit(this.base?.filters);
    visit(this.currentView?.filters);
    return { frontmatter, folder };
  }

  override async createFileForView(baseFileName?: string, frontmatterProcessor?: (frontmatter: any) => void): Promise<void> {
    const app = this.app;
    const vault = app.vault;
    const implied = this.impliedByFilters();
    const configured = this.config?.get("newItemFolder");
    let folderPath = typeof configured === "string" && configured.trim() ? normalizePath(configured) : implied.folder ? normalizePath(implied.folder) : this.host.defaultNewFileFolder().path;
    if (folderPath === "/") folderPath = "";
    if (folderPath && !vault.getAbstractFileByPath(folderPath)) await vault.createFolder(folderPath);
    const name = (baseFileName ?? "").trim() || "Untitled";
    const path = vault.getAvailablePath(folderPath ? `${folderPath}/${name}` : name, "md");
    const frontmatter: Record<string, unknown> = { ...implied.frontmatter };
    frontmatterProcessor?.(frontmatter);
    let body = "";
    const template = this.config?.get("newItemTemplate");
    if (typeof template === "string" && template.trim()) {
      const link = template.replace(/^\[\[|\]\]$/g, "");
      const tfile = app.metadataCache.getFirstLinkpathDest(link, this.thisFile?.path ?? "") ?? vault.getFileByPath(link);
      if (tfile) body = await vault.cachedRead(tfile);
    }
    const yaml = Object.keys(frontmatter).length ? `---\n${stringifyYaml(frontmatter)}---\n` : "";
    let file: TFile;
    try {
      file = await vault.create(path, yaml + body);
    } catch (e) {
      new Notice(`Could not create the note: ${(e as Error).message}`);
      return;
    }
    // Would the new note show up in this view?
    try {
      const record: FileRecordJson = {
        path: file.path,
        size: 0,
        ctime: Date.now(),
        mtime: Date.now(),
        properties: frontmatter,
        tags: ((frontmatter.tags as string[] | undefined) ?? []).map((t) => `#${t}`),
        links: [],
        embeds: [],
        backlinks: [],
      };
      const probe: any = getEngine().bases.runView(this.base, this.viewIndex, [record], this.thisRecord(), Date.now(), tzOffset());
      if (probe && !probe.error && probe.total === 0) new Notice("This note will be filtered out because it doesn't match your criteria");
    } catch {
      /* ignore */
    }
    await app.workspace.getLeaf("tab").openFile(file, { active: true });
  }
}
