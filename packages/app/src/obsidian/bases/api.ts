/**
 * The Bases API from obsidian.d.ts (1.10+): the `Value` family, `BasesView`,
 * `QueryController`, `BasesEntry`, `BasesEntryGroup`, `BasesQueryResult`,
 * `BasesViewConfig` and the view registry behind `Plugin.registerBasesView`.
 *
 * Query execution lives in the vault-bases engine; the Bases core plugin
 * (core-plugins/bases) subclasses `QueryController` to run it and hands the
 * results to views as these classes. Engine values arrive as JSON with a
 * `type` tag and become Values through `valueFromJson`.
 */
import { Component, Events } from "../events";
import { setIcon } from "../ui/icons";
import { Keymap } from "../ui/keymap";
import { moment, parseLinktext, sanitizeHTMLToDom } from "../util";

// ---------------------------------------------------------------------------
// runtime

let runtimeApp: any = null;

function currentApp(): any {
  return runtimeApp ?? (globalThis as { app?: unknown }).app ?? null;
}

type RenderCtx = { hoverPopover: unknown } | null | undefined;

function hoverLink(el: HTMLElement, linktext: string, sourcePath: string, ctx: RenderCtx) {
  el.addEventListener("mouseover", (event) => {
    const app = currentApp();
    app?.workspace?.trigger("hover-link", { event, source: "bases", hoverParent: ctx ?? app?.renderContext, targetEl: el, linktext, sourcePath });
  });
}

function openLinkOnClick(el: HTMLElement, linktext: string, sourcePath: string) {
  el.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    const app = currentApp();
    void app?.workspace?.openLinkText(linktext, sourcePath, Keymap.isModEvent(evt));
  });
}

// ---------------------------------------------------------------------------
// Value family

export abstract class Value {
  static type = "value";

  static equals(a: Value | null, b: Value | null): boolean {
    if (a === b) return true;
    if (!a || !b) return (a ?? NullValue.value) instanceof NullValue && (b ?? NullValue.value) instanceof NullValue;
    return a.equals(b as never);
  }

  static looseEquals(a: Value | null, b: Value | null): boolean {
    if (a === b) return true;
    if (!a || !b) return (a ?? NullValue.value) instanceof NullValue && (b ?? NullValue.value) instanceof NullValue;
    return a.looseEquals(b);
  }

  abstract toString(): string;
  abstract isTruthy(): boolean;

  equals(other: this): boolean {
    return !!other && other.constructor === this.constructor && other.toString() === this.toString();
  }

  looseEquals(other: Value): boolean {
    if (!other) return false;
    if (this.equals(other as this)) return true;
    const a = this.toString();
    const b = other.toString();
    if (a === b) return true;
    const na = Number(a);
    const nb = Number(b);
    if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && na === nb) return true;
    return a.replace(/^#/, "").toLowerCase() === b.replace(/^#/, "").toLowerCase() && (this instanceof TagValue || other instanceof TagValue || this instanceof LinkValue || other instanceof LinkValue);
  }

  renderTo(el: HTMLElement, _ctx: RenderCtx): void {
    el.appendText(this.toString());
  }
}

export abstract class NotNullValue extends Value {}

export class NullValue extends Value {
  static override type = "null";
  static value: NullValue = new NullValue();
  toString(): string {
    return "";
  }
  isTruthy(): boolean {
    return false;
  }
  override equals(other: this): boolean {
    return other instanceof NullValue;
  }
  override looseEquals(other: Value): boolean {
    return other instanceof NullValue;
  }
  override renderTo(_el: HTMLElement, _ctx: RenderCtx): void {}
}

export abstract class PrimitiveValue<T> extends NotNullValue {
  // internal (read by plugins: maps)
  value: T;
  constructor(value: T) {
    super();
    this.value = value;
  }
  toString(): string {
    return String(this.value);
  }
  isTruthy(): boolean {
    return !!this.value;
  }
}

export class StringValue extends PrimitiveValue<string> {
  static override type = "string";
}

export class NumberValue extends PrimitiveValue<number> {
  static override type = "number";
  override toString(): string {
    const v = this.value;
    if (Number.isNaN(v)) return "NaN";
    return String(v);
  }
  override isTruthy(): boolean {
    return this.value !== 0 && !Number.isNaN(this.value);
  }
}

export class BooleanValue extends PrimitiveValue<boolean> {
  static override type = "boolean";
  override renderTo(el: HTMLElement, _ctx: RenderCtx): void {
    const box = el.createEl("input", { cls: "metadata-input-checkbox", type: "checkbox", attr: { disabled: true, tabindex: "-1" } });
    box.checked = this.value;
  }
}

export class LinkValue extends StringValue {
  static override type = "link";
  // internal
  display: Value | null;
  // internal
  sourcePath: string;

  constructor(value: string, display: Value | null = null, sourcePath = "") {
    super(value);
    this.display = display;
    this.sourcePath = sourcePath;
  }

  static parseFromString(app: any, input: string, sourcePath: string): LinkValue | null {
    const m = /^\s*!?\[\[([^\]]+)\]\]\s*$/.exec(input ?? "");
    if (!m) return null;
    const inner = m[1]!;
    const bar = inner.indexOf("|");
    const target = bar >= 0 ? inner.slice(0, bar) : inner;
    const alias = bar >= 0 ? inner.slice(bar + 1) : "";
    if (app) runtimeApp ??= app;
    return new LinkValue(target.trim(), alias ? new StringValue(alias) : null, sourcePath);
  }

  // internal
  resolve(): any {
    const app = currentApp();
    const { path } = parseLinktext(this.value);
    return app?.metadataCache?.getFirstLinkpathDest?.(path, this.sourcePath) ?? app?.vault?.getFileByPath?.(this.value) ?? null;
  }

  override looseEquals(other: Value): boolean {
    if (other instanceof LinkValue || other instanceof FileValue) {
      const a = this.resolve();
      const b = other instanceof LinkValue ? other.resolve() : other.file;
      if (a && b) return a === b;
    }
    return super.looseEquals(other);
  }

  override renderTo(el: HTMLElement, ctx: RenderCtx): void {
    const file = this.resolve();
    const a = el.createEl("a", { cls: "internal-link", href: this.value, attr: { "data-href": this.value, target: "_blank", rel: "noopener nofollow" } });
    if (!file) a.addClass("is-unresolved");
    if (this.display && !(this.display instanceof NullValue)) this.display.renderTo(a, ctx);
    else {
      const { path, subpath } = parseLinktext(this.value);
      const name = file ? (file.extension === "md" ? file.basename : file.name) : path;
      a.setText(subpath ? `${name} > ${subpath.replace(/^#\^?/, "")}` : name || this.value);
    }
    openLinkOnClick(a, this.value, this.sourcePath);
    hoverLink(a, this.value, this.sourcePath, ctx);
  }
}

export class UrlValue extends StringValue {
  static override type = "url";
  override renderTo(el: HTMLElement, _ctx: RenderCtx): void {
    const a = el.createEl("a", { cls: "external-link", href: this.value, text: this.value, attr: { target: "_blank", rel: "noopener nofollow" } });
    a.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      window.open(this.value, "_blank", "noopener");
    });
  }
}

export class TagValue extends StringValue {
  static override type = "tag";
  constructor(value: string) {
    super(value);
  }
  override toString(): string {
    return this.value.startsWith("#") ? this.value : `#${this.value}`;
  }
  override renderTo(el: HTMLElement, _ctx: RenderCtx): void {
    const text = this.toString();
    const a = el.createEl("a", { cls: "tag", href: text, text, attr: { target: "_blank", rel: "noopener nofollow" } });
    a.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const app = currentApp();
      void app?.internalPlugins?.getEnabledPluginById?.("global-search")?.openGlobalSearch?.(`tag:${text}`);
    });
  }
}

export class HTMLValue extends StringValue {
  static override type = "html";
  override renderTo(el: HTMLElement, _ctx: RenderCtx): void {
    el.appendChild(sanitizeHTMLToDom(this.value));
  }
}

export class IconValue extends StringValue {
  static override type = "icon";
  override renderTo(el: HTMLElement, _ctx: RenderCtx): void {
    setIcon(el.createSpan({ cls: "bases-icon" }), this.value);
  }
}

/** Resolves an image reference (URL, `[[wikilink]]`, vault path) to a src the browser can load. */
function imageSource(ref: string, sourcePath = ""): string | null {
  const s = ref.trim();
  if (!s) return null;
  if (/^(https?:|data:|blob:|app:)/i.test(s)) return s;
  const app = currentApp();
  const wiki = /^!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(s);
  const md = /^!?\[[^\]]*\]\(([^)]+)\)$/.exec(s);
  const path = wiki ? wiki[1]! : md ? decodeURIComponent(md[1]!) : s;
  if (/^(https?:|data:)/i.test(path)) return path;
  const file = app?.metadataCache?.getFirstLinkpathDest?.(parseLinktext(path).path, sourcePath) ?? app?.vault?.getFileByPath?.(path);
  return file ? app.vault.getResourcePath(file) : null;
}

export class ImageValue extends StringValue {
  static override type = "image";
  // internal: the note the reference is relative to
  sourcePath: string;
  constructor(value: string, sourcePath = "") {
    super(value);
    this.sourcePath = sourcePath;
  }
  // internal
  resourcePath(): string | null {
    return imageSource(this.value, this.sourcePath);
  }
  override renderTo(el: HTMLElement, _ctx: RenderCtx): void {
    const src = this.resourcePath();
    if (src) el.createEl("img", { cls: "bases-image", attr: { src, alt: "", referrerpolicy: "no-referrer", draggable: "false" } });
  }
}

function pad(n: number, w = 2) {
  return String(Math.trunc(Math.abs(n))).padStart(w, "0");
}

export class DateValue extends NotNullValue {
  static override type = "date";
  // internal: epoch milliseconds
  time: number;
  // internal: false for date-only values (YYYY-MM-DD)
  hasTime: boolean;

  constructor(time: number | Date = 0, hasTime = true) {
    super();
    this.time = time instanceof Date ? time.getTime() : time;
    this.hasTime = hasTime;
  }

  // internal
  get date(): Date {
    return new Date(this.time);
  }

  toString(): string {
    const d = this.date;
    if (Number.isNaN(d.getTime())) return "Invalid date";
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return this.hasTime ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
  }

  dateOnly(): DateValue {
    const d = this.date;
    return new DateValue(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), false);
  }

  relative(): string {
    return moment(this.time).fromNow();
  }

  isTruthy(): boolean {
    return true;
  }

  override equals(other: this): boolean {
    return other instanceof DateValue && other.time === this.time;
  }

  override looseEquals(other: Value): boolean {
    if (other instanceof DateValue) return this.hasTime && other.hasTime ? other.time === this.time : this.dateOnly().time === other.dateOnly().time;
    if (other instanceof StringValue) {
      const parsed = DateValue.parseFromString(other.value);
      return !!parsed && this.looseEquals(parsed);
    }
    return false;
  }

  override renderTo(el: HTMLElement, _ctx: RenderCtx): void {
    el.createSpan({ cls: "bases-date", text: this.toString() });
  }

  static parseFromString(input: string): DateValue | null {
    if (typeof input !== "string") return null;
    const s = input.trim();
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(s);
    if (!m) return null;
    const [, y, mo, d, h, mi, sec, frac, zone] = m;
    if (h === undefined) {
      const date = new Date(Number(y), Number(mo) - 1, Number(d));
      return Number.isNaN(date.getTime()) ? null : new DateValue(date.getTime(), false);
    }
    const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
    if (zone) {
      let offsetMin = 0;
      if (zone !== "Z") {
        const zm = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone)!;
        offsetMin = (zm[1] === "-" ? -1 : 1) * (Number(zm[2]) * 60 + Number(zm[3] ?? 0));
      }
      const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0), ms) - offsetMin * 60000;
      return new DateValue(utc, true);
    }
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec ?? 0), ms);
    return Number.isNaN(date.getTime()) ? null : new DateValue(date.getTime(), true);
  }
}

export class RelativeDateValue extends DateValue {
  override toString(): string {
    return this.relative();
  }
  override renderTo(el: HTMLElement, _ctx: RenderCtx): void {
    el.createSpan({ cls: "bases-date mod-relative", text: this.relative(), attr: { "aria-label": new DateValue(this.time, this.hasTime).toString() } });
  }
}

export class DurationValue extends NotNullValue {
  static override type = "duration";
  // internal: total milliseconds, and moment's calendar parts
  ms: number;
  months: number;
  days: number;
  milliseconds: number;

  constructor(ms = 0, parts?: { months?: number; days?: number; milliseconds?: number }) {
    super();
    this.ms = ms;
    this.months = parts?.months ?? 0;
    this.days = parts?.days ?? 0;
    this.milliseconds = parts?.milliseconds ?? (parts ? 0 : ms);
  }

  toString(): string {
    const d = moment.duration({ months: this.months, days: this.days, milliseconds: this.milliseconds });
    const units: [number, string][] = [
      [d.years(), "year"],
      [d.months(), "month"],
      [d.days(), "day"],
      [d.hours(), "hour"],
      [d.minutes(), "minute"],
      [d.seconds(), "second"],
    ];
    const parts = units.filter(([n]) => n !== 0).map(([n, u]) => `${n} ${u}${Math.abs(n) === 1 ? "" : "s"}`);
    if (parts.length) return parts.join(", ");
    return this.ms === 0 ? "0 seconds" : `${this.ms} milliseconds`;
  }

  isTruthy(): boolean {
    return this.ms !== 0;
  }

  addToDate(value: DateValue, subtract = false): DateValue {
    const sign = subtract ? -1 : 1;
    const m = moment(value.time)
      .add(sign * this.milliseconds, "ms")
      .add(sign * this.days, "d")
      .add(sign * this.months, "M");
    return new DateValue(m.valueOf(), value.hasTime || this.milliseconds % 86400000 !== 0);
  }

  getMilliseconds(): number {
    return this.ms;
  }

  static parseFromString(input: string): DurationValue | null {
    if (typeof input !== "string" || !/^P/i.test(input.trim())) return null;
    const d = moment.duration(input.trim());
    if (!moment.isDuration(d) || (d.asMilliseconds() === 0 && !/^P(T)?0/i.test(input.trim()))) return null;
    const months = d.years() * 12 + d.months();
    const days = d.days();
    const milliseconds = ((d.hours() * 60 + d.minutes()) * 60 + d.seconds()) * 1000 + d.milliseconds();
    return new DurationValue(d.asMilliseconds(), { months, days, milliseconds });
  }

  static fromMilliseconds(milliseconds: number): DurationValue {
    return new DurationValue(milliseconds, { milliseconds });
  }
}

/** Wraps a JS value that is not already a Value. */
function wrap(v: unknown): Value {
  if (v instanceof Value) return v;
  if (v === null || v === undefined) return NullValue.value;
  if (typeof v === "string") return new StringValue(v);
  if (typeof v === "number") return new NumberValue(v);
  if (typeof v === "boolean") return new BooleanValue(v);
  if (v instanceof Date) return new DateValue(v.getTime());
  if (v instanceof RegExp) return new RegExpValue(v);
  if (Array.isArray(v)) return new ListValue(v);
  if (typeof v === "object") return new ObjectValue(v as Record<string, unknown>);
  return new StringValue(String(v));
}

export class ListValue extends NotNullValue {
  static override type = "list";
  // internal
  value: Value[];

  constructor(value: (unknown | Value)[] = []) {
    super();
    for (let i = 0; i < value.length; i++) value[i] = wrap(value[i]);
    this.value = value as Value[];
  }

  toString(): string {
    return this.value.map((v) => v.toString()).join(", ");
  }

  isTruthy(): boolean {
    return this.value.length > 0;
  }

  includes(value: Value): boolean {
    return this.value.some((v) => Value.looseEquals(v, value));
  }

  length(): number {
    return this.value.length;
  }

  get(index: number): Value {
    const i = index < 0 ? this.value.length + index : index;
    return this.value[i] ?? NullValue.value;
  }

  concat(other: ListValue): ListValue {
    return new ListValue([...this.value, ...other.value]);
  }

  override equals(other: this): boolean {
    return other instanceof ListValue && other.value.length === this.value.length && this.value.every((v, i) => Value.equals(v, other.value[i]!));
  }

  override looseEquals(other: Value): boolean {
    return other instanceof ListValue && other.value.length === this.value.length && this.value.every((v, i) => Value.looseEquals(v, other.value[i]!));
  }

  override renderTo(el: HTMLElement, ctx: RenderCtx): void {
    const container = el.createSpan({ cls: "value-list-container" });
    for (const item of this.value) {
      if (item instanceof NullValue) continue;
      const cls = item instanceof TagValue ? "value-list-element mod-tag" : item instanceof LinkValue || item instanceof FileValue ? "value-list-element mod-link" : "value-list-element";
      item.renderTo(container.createSpan({ cls }), ctx);
    }
  }
}

export class ObjectValue extends NotNullValue {
  static override type = "object";
  // internal
  value: Record<string, Value>;

  constructor(value: Record<string, unknown> = {}) {
    super();
    const out: Record<string, Value> = {};
    for (const [k, v] of Object.entries(value)) out[k] = wrap(v);
    this.value = out;
  }

  toString(): string {
    const entries = Object.entries(this.value).map(([k, v]) => `${k}: ${v instanceof StringValue && !(v instanceof LinkValue) ? JSON.stringify(v.value) : v.toString()}`);
    return entries.length ? `{ ${entries.join(", ")} }` : "{}";
  }

  isTruthy(): boolean {
    return Object.keys(this.value).length > 0;
  }

  isEmpty(): boolean {
    return Object.keys(this.value).length === 0;
  }

  get(key: string): Value | null {
    return key in this.value ? this.value[key]! : NullValue.value;
  }
}

export class FileValue extends NotNullValue {
  static override type = "file";
  // internal: the TFile (null when the path does not exist)
  file: any;
  // internal
  path: string;

  constructor(file: any = null) {
    super();
    if (typeof file === "string") {
      this.path = file;
      this.file = currentApp()?.vault?.getFileByPath?.(file) ?? null;
    } else {
      this.file = file;
      this.path = file?.path ?? "";
    }
  }

  toString(): string {
    return this.path;
  }

  isTruthy(): boolean {
    return !!this.path;
  }

  override looseEquals(other: Value): boolean {
    if (other instanceof FileValue) return other.path === this.path;
    if (other instanceof LinkValue) return other.looseEquals(this);
    return super.looseEquals(other);
  }

  override renderTo(el: HTMLElement, ctx: RenderCtx): void {
    const file = this.file;
    const text = file ? (file.extension === "md" ? file.basename : file.name) : this.path;
    const a = el.createEl("a", { cls: "internal-link", href: this.path, text, attr: { "data-href": this.path, target: "_blank", rel: "noopener nofollow" } });
    if (!file) a.addClass("is-unresolved");
    openLinkOnClick(a, this.path, "");
    hoverLink(a, this.path, "", ctx);
  }
}

export class RegExpValue extends NotNullValue {
  static override type = "regexp";
  // internal
  value: RegExp;
  constructor(value: RegExp = /(?:)/) {
    super();
    this.value = value;
  }
  toString(): string {
    return String(this.value);
  }
  isTruthy(): boolean {
    return true;
  }
}

/** What `BasesEntry.getValue` returns when a property fails to compute. */
export class ErrorValue extends NotNullValue {
  static override type = "error";
  message: string;
  constructor(message: string) {
    super();
    this.message = message;
  }
  toString(): string {
    return `Error: ${this.message}`;
  }
  isTruthy(): boolean {
    return false;
  }
  override renderTo(el: HTMLElement, _ctx: RenderCtx): void {
    el.createSpan({ cls: "bases-error-value", text: "⚠", attr: { "aria-label": this.message } });
  }
}

/** Engine JSON (`{"type": …, "value": …}`) → Value. */
export function valueFromJson(json: any, sourcePath = ""): Value {
  if (json === null || json === undefined) return NullValue.value;
  if (json instanceof Value) return json;
  if (typeof json !== "object" || !("type" in json)) return wrap(json);
  const num = (v: unknown) => (typeof v === "string" ? Number(v === "Infinity" ? Infinity : v === "-Infinity" ? -Infinity : v) : Number(v));
  switch (json.type) {
    case "null":
      return NullValue.value;
    case "boolean":
      return new BooleanValue(!!json.value);
    case "number":
      return new NumberValue(num(json.value));
    case "string":
      return new StringValue(String(json.value ?? ""));
    case "link":
      return new LinkValue(String(json.value ?? ""), json.display ? valueFromJson(json.display, sourcePath) : null, sourcePath);
    case "html":
      return new HTMLValue(String(json.value ?? ""));
    case "icon":
      return new IconValue(String(json.value ?? ""));
    case "image":
      return new ImageValue(String(json.value ?? ""), sourcePath);
    case "tag":
      return new TagValue(String(json.value ?? ""));
    case "url":
      return new UrlValue(String(json.value ?? ""));
    case "date":
      return new DateValue(num(json.value), json.time !== false);
    case "relativeDate":
      return new RelativeDateValue(num(json.value), json.time !== false);
    case "duration":
      return new DurationValue(num(json.value), { months: num(json.months ?? 0), days: num(json.days ?? 0), milliseconds: num(json.milliseconds ?? json.value ?? 0) });
    case "list":
      return new ListValue(((json.value ?? []) as unknown[]).map((v) => valueFromJson(v, sourcePath)));
    case "object": {
      const out: Record<string, Value> = {};
      for (const [k, v] of Object.entries((json.value ?? {}) as Record<string, unknown>)) out[k] = valueFromJson(v, sourcePath);
      return new ObjectValue(out);
    }
    case "file":
      return new FileValue(String(json.value ?? ""));
    case "regexp": {
      try {
        return new RegExpValue(new RegExp(String(json.value ?? ""), String(json.flags ?? "")));
      } catch {
        return new RegExpValue();
      }
    }
    case "error":
      return new ErrorValue(String(json.message ?? json.value ?? "Failed to compute value of property"));
    default:
      return wrap(json.value);
  }
}

// ---------------------------------------------------------------------------
// property ids

export type BasesPropertyId = `${"note" | "formula" | "file"}.${string}`;

// internal
export function normalizePropertyId(id: string): BasesPropertyId {
  for (const kind of ["note", "file", "formula"]) if (id.startsWith(`${kind}.`)) return id as BasesPropertyId;
  return `note.${id}`;
}

const FILE_DISPLAY_NAMES: Record<string, string> = {
  name: "file name",
  basename: "file base name",
  path: "file path",
  folder: "folder",
  ext: "file extension",
  size: "file size",
  ctime: "created time",
  mtime: "modified time",
  tags: "file tags",
  links: "file links",
  embeds: "file embeds",
  backlinks: "backlinks",
  properties: "file properties",
};

// ---------------------------------------------------------------------------
// query classes

export interface BasesSortConfig {
  property: BasesPropertyId;
  direction: "ASC" | "DESC";
}

/** Keys of a view that the engine stores as typed fields; everything else lives in `extra`. */
const TYPED_VIEW_KEYS = new Set(["type", "name", "limit", "filters", "groupBy", "order", "sort", "summaries", "columnSize", "rowHeight", "cardSize", "image", "imageFit", "imageAspectRatio"]);

export class BasesViewConfig {
  // internal
  controller: QueryController;
  // internal: the view object inside the base JSON
  view: any;

  constructor(controller: QueryController, view: any) {
    this.controller = controller;
    this.view = view;
  }

  get name(): string {
    return String(this.view?.name ?? "");
  }
  set name(name: string) {
    if (!this.view) return;
    this.view.name = name;
    this.controller.requestSave();
  }

  // internal
  get type(): string {
    return String(this.view?.type ?? "table");
  }

  get(key: string): unknown {
    if (!this.view) return undefined;
    if (TYPED_VIEW_KEYS.has(key)) return this.view[key] ?? undefined;
    return this.view.extra?.[key] ?? undefined;
  }

  getAsPropertyId(key: string): BasesPropertyId | null {
    const v = this.get(key);
    if (typeof v !== "string" || v.trim() === "") return null;
    return normalizePropertyId(v.trim());
  }

  getEvaluatedFormula(view: BasesView, key: string): Value {
    void view;
    const v = this.get(key);
    if (typeof v !== "string" || v.trim() === "") return NullValue.value;
    const out = this.controller.evaluate(v, null);
    return out instanceof ErrorValue ? NullValue.value : out;
  }

  set(key: string, value: any | null): void {
    if (!this.view) return;
    const empty = value === null || value === undefined;
    if (TYPED_VIEW_KEYS.has(key)) {
      if (empty) delete this.view[key];
      else this.view[key] = value;
    } else {
      this.view.extra ??= {};
      if (empty) delete this.view.extra[key];
      else this.view.extra[key] = value;
    }
    this.controller.requestSave();
  }

  getOrder(): BasesPropertyId[] {
    const order = this.view?.order;
    if (!Array.isArray(order)) return ["file.name"];
    return order.filter((x: unknown): x is string => typeof x === "string").map(normalizePropertyId);
  }

  getSort(): BasesSortConfig[] {
    const sort = this.view?.sort;
    if (!Array.isArray(sort)) return [];
    return sort
      .filter((s: any) => s && typeof s.property === "string" && s.property)
      .map((s: any) => ({ property: normalizePropertyId(s.property), direction: String(s.direction).toUpperCase() === "DESC" ? "DESC" : "ASC" }));
  }

  getDisplayName(propertyId: BasesPropertyId): string {
    const norm = normalizePropertyId(propertyId);
    const props = this.controller.base?.properties ?? {};
    for (const [k, cfg] of Object.entries(props as Record<string, any>)) {
      if (normalizePropertyId(k) === norm && typeof cfg?.displayName === "string") return cfg.displayName;
    }
    const dot = norm.indexOf(".");
    const kind = norm.slice(0, dot);
    const name = norm.slice(dot + 1);
    if (kind === "file") return FILE_DISPLAY_NAMES[name] ?? name;
    return name;
  }
}

export class BasesEntry {
  file: any;
  // internal
  controller: QueryController;
  // internal: engine cells, property id → value JSON
  cells: Record<string, unknown>;
  private cache = new Map<string, Value | null>();

  constructor(controller: QueryController, file: any, cells: Record<string, unknown>) {
    this.controller = controller;
    this.file = file;
    this.cells = cells;
  }

  getValue(propertyId: BasesPropertyId): Value | null {
    const id = normalizePropertyId(propertyId);
    if (this.cache.has(id)) return this.cache.get(id)!;
    let v: Value | null;
    if (id in this.cells) v = valueFromJson(this.cells[id], this.file?.path ?? "");
    else v = this.controller.resolveValue(this, id);
    this.cache.set(id, v);
    return v;
  }
}

export class BasesEntryGroup {
  key?: Value;
  entries: BasesEntry[];
  // internal
  private keyed: boolean;
  // internal: engine summaries for this group, property id → value JSON
  summaries: Record<string, unknown>;

  constructor(key: Value | undefined, entries: BasesEntry[], hasKey?: boolean, summaries: Record<string, unknown> = {}) {
    this.key = key;
    this.entries = entries;
    this.keyed = hasKey ?? (!!key && !(key instanceof NullValue));
    this.summaries = summaries;
  }

  hasKey(): boolean {
    return this.keyed;
  }
}

export class BasesQueryResult {
  data: BasesEntry[];
  // internal
  groups: BasesEntryGroup[];
  // internal
  props: BasesPropertyId[];
  // internal: engine summaries over every row shown
  summaries: Record<string, unknown>;
  // internal
  total: number;
  // internal
  errors: { kind: string; message: string; source?: string }[];
  // internal
  grouped: boolean;

  constructor(init: { groups: BasesEntryGroup[]; properties: BasesPropertyId[]; summaries?: Record<string, unknown>; total?: number; errors?: any[]; grouped?: boolean }) {
    this.groups = init.groups;
    this.data = init.groups.flatMap((g) => g.entries);
    this.props = init.properties;
    this.summaries = init.summaries ?? {};
    this.total = init.total ?? this.data.length;
    this.errors = init.errors ?? [];
    this.grouped = init.grouped ?? false;
  }

  get groupedData(): BasesEntryGroup[] {
    if (!this.grouped) return [new BasesEntryGroup(undefined, this.data, false, this.summaries)];
    return this.groups;
  }

  get properties(): BasesPropertyId[] {
    return this.props.slice();
  }

  getSummaryValue(queryController: QueryController, entries: BasesEntry[], prop: BasesPropertyId, summaryKey: string): Value {
    const id = normalizePropertyId(prop);
    const configured = queryController.config?.get("summaries") as Record<string, string> | undefined;
    const configuredKey = configured ? Object.entries(configured).find(([k]) => normalizePropertyId(k) === id)?.[1] : undefined;
    if (configuredKey && configuredKey.toLowerCase() === summaryKey.toLowerCase()) {
      const same = (a: BasesEntry[], b: BasesEntry[]) => a === b || (a.length === b.length && a.every((e, i) => e === b[i]));
      if (same(entries, this.data) && id in this.summaries) return valueFromJson(this.summaries[id]);
      for (const g of this.groups) if (same(entries, g.entries) && id in g.summaries) return valueFromJson(g.summaries[id]);
    }
    return queryController.computeSummary(entries, id, summaryKey);
  }
}

export class QueryController extends Component {
  // internal
  app: any;
  // internal: the parsed base (vault-bases BaseFile JSON)
  base: any = { views: [] };
  // internal
  viewIndex = 0;
  // internal
  config: BasesViewConfig | null = null;
  // internal
  results: BasesQueryResult | null = null;
  // internal
  allProperties: BasesPropertyId[] = [];

  constructor(app?: any) {
    super();
    this.app = app ?? currentApp();
  }

  // internal: hooks implemented by the Bases core plugin
  requestSave(): void {}
  evaluate(_expression: string, _file: any | null): Value {
    return NullValue.value;
  }
  resolveValue(_entry: BasesEntry, _propertyId: BasesPropertyId): Value | null {
    return null;
  }
  computeSummary(entries: BasesEntry[], prop: BasesPropertyId, summaryKey: string): Value {
    return builtinSummary(summaryKey, entries.map((e) => e.getValue(prop) ?? NullValue.value));
  }
  async createFileForView(_baseFileName?: string, _frontmatterProcessor?: (frontmatter: any) => void): Promise<void> {}
}

/** Built-in summaries (Average … Unique) over Values. */
export function builtinSummary(name: string, values: Value[]): Value {
  const nums = values.map((v) => (v instanceof NumberValue ? v.value : v instanceof StringValue && v.value.trim() !== "" && Number.isFinite(Number(v.value)) ? Number(v.value) : null)).filter((n): n is number => n !== null && !Number.isNaN(n));
  const dates = values.filter((v): v is DateValue => v instanceof DateValue);
  const empty = (v: Value) => v instanceof NullValue || (v instanceof StringValue && v.value === "") || (v instanceof ListValue && v.length() === 0);
  const sum = nums.reduce((a, b) => a + b, 0);
  const sorted = nums.slice().sort((a, b) => a - b);
  switch (name.toLowerCase()) {
    case "average":
    case "mean":
      return nums.length ? new NumberValue(sum / nums.length) : NullValue.value;
    case "sum":
      return new NumberValue(sum);
    case "min":
      return nums.length ? new NumberValue(sorted[0]!) : dates.length ? dates.reduce((a, b) => (b.time < a.time ? b : a)) : NullValue.value;
    case "max":
      return nums.length ? new NumberValue(sorted[sorted.length - 1]!) : dates.length ? dates.reduce((a, b) => (b.time > a.time ? b : a)) : NullValue.value;
    case "earliest":
      return dates.length ? dates.reduce((a, b) => (b.time < a.time ? b : a)) : NullValue.value;
    case "latest":
      return dates.length ? dates.reduce((a, b) => (b.time > a.time ? b : a)) : NullValue.value;
    case "range":
      if (nums.length) return new NumberValue(sorted[sorted.length - 1]! - sorted[0]!);
      if (dates.length) {
        const times = dates.map((d) => d.time);
        return DurationValue.fromMilliseconds(Math.max(...times) - Math.min(...times));
      }
      return NullValue.value;
    case "median": {
      if (!nums.length) return NullValue.value;
      const mid = Math.floor(sorted.length / 2);
      return new NumberValue(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
    }
    case "stddev": {
      if (!nums.length) return NullValue.value;
      const mean = sum / nums.length;
      return new NumberValue(Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length));
    }
    case "checked":
      return new NumberValue(values.filter((v) => v instanceof BooleanValue && v.value).length);
    case "unchecked":
      return new NumberValue(values.filter((v) => v instanceof BooleanValue && !v.value).length);
    case "empty":
      return new NumberValue(values.filter(empty).length);
    case "filled":
      return new NumberValue(values.filter((v) => !empty(v)).length);
    case "unique":
      return new NumberValue(new Set(values.filter((v) => !empty(v)).map((v) => v.toString())).size);
    default:
      return NullValue.value;
  }
}

export abstract class BasesView extends Component {
  abstract type: string;
  app: any;
  config: BasesViewConfig;
  allProperties: BasesPropertyId[] = [];
  data: BasesQueryResult;
  // internal
  controller: QueryController;

  protected constructor(controller: QueryController) {
    super();
    this.controller = controller;
    this.app = controller.app;
    this.config = controller.config ?? new BasesViewConfig(controller, controller.base?.views?.[controller.viewIndex] ?? null);
    this.allProperties = controller.allProperties.slice();
    this.data = controller.results ?? new BasesQueryResult({ groups: [], properties: [] });
  }

  abstract onDataUpdated(): void;

  createFileForView(baseFileName?: string, frontmatterProcessor?: (frontmatter: any) => void): Promise<void> {
    return this.controller.createFileForView(baseFileName, frontmatterProcessor);
  }
}

// ---------------------------------------------------------------------------
// registration

export interface BasesOption {
  key: string;
  type: string;
  displayName: string;
  shouldHide?: () => boolean;
  [k: string]: any;
}

export interface BasesOptionGroup<T extends BasesOption = BasesOption> {
  type: "group";
  displayName: string;
  items: T[];
  shouldHide?: () => boolean;
}

export type BasesAllOptions = BasesOption | BasesOptionGroup<BasesOption>;

export type BasesViewFactory = (controller: QueryController, containerEl: HTMLElement) => BasesView;

export interface BasesViewRegistration {
  name: string;
  icon: string;
  factory: BasesViewFactory;
  options?: (config: BasesViewConfig) => BasesAllOptions[];
}

/** app.basesRegistry — view type id → registration. Triggers "changed". */
export class BasesRegistry extends Events {
  private views = new Map<string, BasesViewRegistration>();
  // Layouts the app ships that a plugin may replace (the built-in map gives
  // way to the official Maps plugin's `map`).
  private fallbacks = new Map<string, BasesViewRegistration>();

  constructor(app: any) {
    super();
    runtimeApp = app;
  }

  has(viewId: string): boolean {
    return this.views.has(viewId);
  }

  register(viewId: string, registration: BasesViewRegistration): boolean {
    if (this.views.has(viewId)) return false;
    this.views.set(viewId, registration);
    this.trigger("changed", viewId);
    return true;
  }

  // internal: a built-in layout that plugin registrations override
  registerFallback(viewId: string, registration: BasesViewRegistration): void {
    this.fallbacks.set(viewId, registration);
    this.trigger("changed", viewId);
  }

  unregister(viewId: string): void {
    if (this.views.delete(viewId)) this.trigger("changed", viewId);
  }

  get(viewId: string): BasesViewRegistration | null {
    return this.views.get(viewId) ?? this.fallbacks.get(viewId) ?? null;
  }

  list(): { id: string; registration: BasesViewRegistration }[] {
    const ids = [...this.views.keys(), ...[...this.fallbacks.keys()].filter((id) => !this.views.has(id))];
    return ids.map((id) => ({ id, registration: this.get(id)! }));
  }

  // internal (used by plugins that inspect the registry)
  getViewTypes(): string[] {
    return this.list().map((v) => v.id);
  }
}
