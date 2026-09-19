/**
 * `Setting` rows and the component classes plugins build settings tabs from.
 *
 * DOM (Obsidian's class names, which themes style):
 *
 *   .setting-item
 *     .setting-item-info > .setting-item-name, .setting-item-description
 *     .setting-item-control > (components)
 *
 * Components append themselves to the element they are constructed with, so
 * `new ToggleComponent(anyEl)` works outside a Setting as it does in Obsidian.
 * `setValue` never fires `onChange`; only user input does.
 */
import moment from "moment";
import type { App } from "../app";
import type { HexString, HSL, RGB, TooltipOptions } from "obsidian";
import { setIcon } from "./icons";
import { setTooltip } from "./tooltip";

// ---- base classes ------------------------------------------------------------

export abstract class BaseComponent {
  disabled = false;

  then(cb: (component: this) => any): this {
    cb(this);
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
}

export abstract class ValueComponent<T> extends BaseComponent {
  registerOptionListener(listeners: Record<string, (value?: T) => T>, key: string): this {
    listeners[key] = (value?: T) => {
      if (value !== undefined) this.setValue(value);
      return this.getValue();
    };
    return this;
  }

  abstract getValue(): T;
  abstract setValue(value: T): this;
}

function runCallback(fn: ((...args: any[]) => unknown) | null | undefined, ...args: unknown[]): void {
  if (!fn) return;
  try {
    const r = fn(...args);
    if (r instanceof Promise) r.catch((e) => console.error(e));
  } catch (e) {
    console.error(e);
  }
}

// ---- text inputs ---------------------------------------------------------------

export class AbstractTextComponent<T extends HTMLInputElement | HTMLTextAreaElement> extends ValueComponent<string> {
  inputEl: T;
  // internal
  changeCallback: ((value: string) => any) | null = null;

  constructor(inputEl: T) {
    super();
    this.inputEl = inputEl;
    inputEl.addEventListener("input", () => this.onChanged());
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    return this;
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setValue(value: string): this {
    this.inputEl.value = value ?? "";
    return this;
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  onChanged(): void {
    runCallback(this.changeCallback, this.getValue());
  }

  onChange(callback: (value: string) => any): this {
    this.changeCallback = callback;
    return this;
  }
}

export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
  constructor(containerEl: HTMLElement) {
    super(containerEl.createEl("input", { type: "text", attr: { spellcheck: "false" } }));
  }
}

export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
  constructor(containerEl: HTMLElement) {
    super(containerEl.createEl("textarea", { attr: { spellcheck: "false" } }));
  }
}

export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
  clearButtonEl: HTMLElement;
  // internal
  containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    const wrap = containerEl.createDiv({ cls: "search-input-container" });
    super(wrap.createEl("input", { type: "search", attr: { enterkeyhint: "search", spellcheck: "false" } }));
    this.containerEl = wrap;
    this.clearButtonEl = wrap.createDiv({ cls: "search-input-clear-button", attr: { "aria-label": "Clear search" } });
    this.clearButtonEl.addEventListener("click", () => {
      this.setValue("");
      this.onChanged();
      this.inputEl.focus();
    });
    this.updateClearButton();
  }

  override setValue(value: string): this {
    super.setValue(value);
    this.updateClearButton();
    return this;
  }

  override onChanged(): void {
    this.updateClearButton();
    super.onChanged();
  }

  private updateClearButton() {
    this.clearButtonEl.toggle(this.inputEl.value !== "");
  }
}

export class MomentFormatComponent extends TextComponent {
  sampleEl: HTMLElement;
  // internal
  defaultFormat = "";

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.sampleEl = createSpan({ cls: "u-pop" });
  }

  setDefaultFormat(defaultFormat: string): this {
    this.defaultFormat = defaultFormat;
    this.setPlaceholder(defaultFormat);
    this.updateSample();
    return this;
  }

  setSampleEl(sampleEl: HTMLElement): this {
    this.sampleEl = sampleEl;
    this.updateSample();
    return this;
  }

  override setValue(value: string): this {
    super.setValue(value);
    this.updateSample();
    return this;
  }

  override onChanged(): void {
    this.updateSample();
    super.onChanged();
  }

  updateSample(): void {
    if (!this.sampleEl) return;
    const format = this.getValue() || this.defaultFormat;
    this.sampleEl.setText(moment().format(format));
  }
}

// ---- toggle, dropdown, slider ---------------------------------------------------

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement;
  // internal
  inputEl: HTMLInputElement;
  // internal
  on = false;
  // internal
  changeCallback: ((value: boolean) => any) | null = null;

  constructor(containerEl: HTMLElement) {
    super();
    this.toggleEl = containerEl.createDiv({ cls: "checkbox-container" });
    this.inputEl = this.toggleEl.createEl("input", { type: "checkbox", attr: { tabindex: 0 } });
    this.toggleEl.addEventListener("click", (evt) => {
      evt.preventDefault();
      this.onClick();
    });
    this.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === " " || evt.key === "Enter") {
        evt.preventDefault();
        this.onClick();
      }
    });
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    this.toggleEl.toggleClass("is-disabled", disabled);
    return this;
  }

  getValue(): boolean {
    return this.on;
  }

  setValue(on: boolean): this {
    this.on = !!on;
    this.toggleEl.toggleClass("is-enabled", this.on);
    this.inputEl.checked = this.on;
    return this;
  }

  setTooltip(tooltip: string, options?: TooltipOptions): this {
    setTooltip(this.toggleEl, tooltip, options);
    return this;
  }

  onClick(): void {
    if (this.disabled) return;
    this.setValue(!this.on);
    runCallback(this.changeCallback, this.on);
  }

  onChange(callback: (value: boolean) => any): this {
    this.changeCallback = callback;
    return this;
  }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;
  // internal
  changeCallback: ((value: string) => any) | null = null;

  constructor(containerEl: HTMLElement) {
    super();
    this.selectEl = containerEl.createEl("select", { cls: "dropdown" });
    this.selectEl.addEventListener("change", () => runCallback(this.changeCallback, this.getValue()));
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.selectEl.disabled = disabled;
    return this;
  }

  addOption(value: string, display: string): this {
    this.selectEl.createEl("option", { text: display, value });
    return this;
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) this.addOption(value, display);
    return this;
  }

  getValue(): string {
    return this.selectEl.value;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  onChange(callback: (value: string) => any): this {
    this.changeCallback = callback;
    return this;
  }
}

export class SliderComponent extends ValueComponent<number> {
  sliderEl: HTMLInputElement;
  // internal
  valueEl: HTMLElement;
  // internal
  instant = false;
  // internal
  displayFormat: ((value: number) => string) | null = null;
  // internal
  changeCallback: ((value: number) => any) | null = null;

  constructor(containerEl: HTMLElement) {
    super();
    this.sliderEl = containerEl.createEl("input", { cls: "slider", type: "range", attr: { tabindex: 0 } });
    this.valueEl = containerEl.createSpan({ cls: "vault-slider-value" });
    this.setLimits(0, 100, 1);
    this.sliderEl.addEventListener("input", () => {
      this.updateDisplay();
      if (this.instant) runCallback(this.changeCallback, this.getValue());
    });
    this.sliderEl.addEventListener("change", () => {
      this.updateDisplay();
      if (!this.instant) runCallback(this.changeCallback, this.getValue());
    });
    this.updateDisplay();
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.sliderEl.disabled = disabled;
    return this;
  }

  setInstant(instant: boolean): this {
    this.instant = instant;
    return this;
  }

  setLimits(min: number | null, max: number | null, step: number | "any"): this {
    this.sliderEl.min = String(min ?? 0);
    this.sliderEl.max = String(max ?? 100);
    this.sliderEl.step = String(step);
    this.updateDisplay();
    return this;
  }

  getValue(): number {
    return Number(this.sliderEl.value);
  }

  setValue(value: number): this {
    this.sliderEl.value = String(value);
    this.updateDisplay();
    return this;
  }

  getValuePretty(): string {
    const v = this.getValue();
    return this.displayFormat ? this.displayFormat(v) : String(v);
  }

  setDisplayFormat(format: (value: number) => string): this {
    this.displayFormat = format;
    this.updateDisplay();
    return this;
  }

  /** @deprecated The value is always shown inline next to the slider. */
  setDynamicTooltip(): this {
    return this;
  }

  // internal
  showTooltip(): void {}

  onChange(callback: (value: number) => any): this {
    this.changeCallback = callback;
    return this;
  }

  private updateDisplay() {
    if (!this.valueEl) return;
    let text: string;
    try {
      text = this.getValuePretty();
    } catch (e) {
      console.error(e);
      text = String(this.getValue());
    }
    this.valueEl.setText(text);
    this.valueEl.toggle(text !== "");
  }
}

// ---- buttons ---------------------------------------------------------------------

export class ButtonComponent extends BaseComponent {
  buttonEl: HTMLButtonElement;
  // internal
  clickCallback: ((evt: MouseEvent) => unknown | Promise<unknown>) | null = null;

  constructor(containerEl: HTMLElement) {
    super();
    this.buttonEl = containerEl.createEl("button");
    this.buttonEl.addEventListener("click", (evt) => {
      if (this.disabled) return;
      runCallback(this.clickCallback, evt);
    });
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.buttonEl.disabled = disabled;
    return this;
  }

  setCta(): this {
    this.buttonEl.addClass("mod-cta");
    return this;
  }

  removeCta(): this {
    this.buttonEl.removeClass("mod-cta");
    return this;
  }

  /** @deprecated Use `setDestructive`. */
  setWarning(): this {
    this.buttonEl.addClass("mod-warning");
    return this;
  }

  setDestructive(): this {
    this.buttonEl.addClass("mod-destructive");
    return this;
  }

  removeDestructive(): this {
    this.buttonEl.removeClass("mod-destructive", "mod-warning");
    return this;
  }

  setTooltip(tooltip: string, options?: TooltipOptions): this {
    setTooltip(this.buttonEl, tooltip, options);
    return this;
  }

  setButtonText(name: string): this {
    this.buttonEl.removeClass("mod-icon");
    this.buttonEl.setText(name);
    return this;
  }

  setIcon(icon: string): this {
    setIcon(this.buttonEl, icon);
    this.buttonEl.addClass("mod-icon");
    return this;
  }

  setClass(cls: string): this {
    this.buttonEl.addClass(cls);
    return this;
  }

  onClick(callback: (evt: MouseEvent) => unknown | Promise<unknown>): this {
    this.clickCallback = callback;
    return this;
  }
}

export class ExtraButtonComponent extends BaseComponent {
  extraSettingsEl: HTMLElement;
  // internal
  clickCallback: (() => any) | null = null;

  constructor(containerEl: HTMLElement) {
    super();
    this.extraSettingsEl = containerEl.createDiv({ cls: ["clickable-icon", "extra-setting-button"], attr: { tabindex: 0, role: "button" } });
    setIcon(this.extraSettingsEl, "gear");
    this.extraSettingsEl.addEventListener("click", (evt) => {
      evt.preventDefault();
      if (this.disabled) return;
      runCallback(this.clickCallback);
    });
    this.extraSettingsEl.addEventListener("keydown", (evt) => {
      if ((evt.key === "Enter" || evt.key === " ") && !this.disabled) {
        evt.preventDefault();
        runCallback(this.clickCallback);
      }
    });
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.extraSettingsEl.toggleClass("is-disabled", disabled);
    this.extraSettingsEl.setAttr("aria-disabled", disabled ? "true" : null);
    return this;
  }

  setTooltip(tooltip: string, options?: TooltipOptions): this {
    setTooltip(this.extraSettingsEl, tooltip, options);
    return this;
  }

  setIcon(icon: string): this {
    setIcon(this.extraSettingsEl, icon);
    return this;
  }

  onClick(callback: () => any): this {
    this.clickCallback = callback;
    return this;
  }
}

// ---- colour ----------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }: RGB): HexString {
  const part = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = ln - c / 2;
  return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) };
}

export class ColorComponent extends ValueComponent<string> {
  // internal
  colorPickerEl: HTMLInputElement;
  // internal
  changeCallback: ((value: string) => any) | null = null;

  constructor(containerEl: HTMLElement) {
    super();
    this.colorPickerEl = containerEl.createEl("input", { type: "color", attr: { tabindex: 0 } });
    this.colorPickerEl.addEventListener("input", () => runCallback(this.changeCallback, this.getValue()));
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.colorPickerEl.disabled = disabled;
    return this;
  }

  getValue(): HexString {
    return this.colorPickerEl.value;
  }

  getValueRgb(): RGB {
    return hexToRgb(this.getValue());
  }

  getValueHsl(): HSL {
    return rgbToHsl(this.getValueRgb());
  }

  setValue(value: HexString): this {
    if (typeof value === "string" && value) this.colorPickerEl.value = rgbToHex(hexToRgb(value));
    return this;
  }

  setValueRgb(rgb: RGB): this {
    this.colorPickerEl.value = rgbToHex(rgb);
    return this;
  }

  setValueHsl(hsl: HSL): this {
    this.colorPickerEl.value = rgbToHex(hslToRgb(hsl));
    return this;
  }

  onChange(callback: (value: string) => any): this {
    this.changeCallback = callback;
    return this;
  }
}

// ---- progress, display value, secret ----------------------------------------------

export class ProgressBarComponent extends ValueComponent<number> {
  // internal
  progressBar: HTMLElement;
  // internal
  lineEl: HTMLElement;
  // internal
  value = 0;

  constructor(containerEl: HTMLElement) {
    super();
    this.progressBar = containerEl.createDiv({ cls: "setting-progress-bar", attr: { role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100 } });
    this.lineEl = this.progressBar.createDiv({ cls: "setting-progress-bar-inner" });
    this.setValue(0);
  }

  getValue(): number {
    return this.value;
  }

  setValue(value: number): this {
    this.value = clamp(Number(value) || 0, 0, 100);
    this.lineEl.style.width = `${this.value}%`;
    this.progressBar.setAttr("aria-valuenow", this.value);
    return this;
  }
}

export class DisplayValueComponent {
  valueEl: HTMLElement;
  // internal
  statusEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.statusEl = containerEl.createDiv({ cls: "vault-setting-status" });
    this.statusEl.hide();
    this.valueEl = containerEl.createDiv({ cls: "vault-setting-display-value" });
  }

  setValue(value: string | null): this {
    this.valueEl.setText(value ?? "");
    this.valueEl.toggle(!!value);
    return this;
  }

  setStatus(status: "warning" | null): this {
    this.statusEl.empty();
    this.statusEl.toggleClass("mod-warning", status === "warning");
    if (status === "warning") {
      setIcon(this.statusEl, "lucide-alert-triangle");
      this.statusEl.show();
    } else {
      this.statusEl.hide();
    }
    return this;
  }
}

interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
  listSecrets(): string[];
  on?(name: string, cb: (...args: any[]) => any): unknown;
}

/**
 * Picks one of the secrets stored in `app.secretStorage` (the value is the
 * secret's id, never the secret itself), with an inline form to add a new one.
 */
export class SecretComponent extends BaseComponent {
  // internal
  app: App;
  // internal
  containerEl: HTMLElement;
  // internal
  selectEl: HTMLSelectElement;
  // internal
  value = "";
  // internal
  changeCallback: ((value: string) => unknown) | null = null;

  constructor(app: App, containerEl: HTMLElement) {
    super();
    this.app = app;
    this.containerEl = containerEl.createDiv({ cls: "vault-secret-component" });
    this.selectEl = this.containerEl.createEl("select", { cls: "dropdown" });
    this.selectEl.addEventListener("focus", () => this.renderOptions());
    this.selectEl.addEventListener("change", () => {
      this.value = this.selectEl.value;
      runCallback(this.changeCallback, this.value);
    });
    const addButton = new ExtraButtonComponent(this.containerEl).setIcon("lucide-plus").setTooltip("Add secret");
    const form = this.containerEl.createDiv({ cls: "vault-secret-form" });
    form.hide();
    const idInput = form.createEl("input", { type: "text", placeholder: "secret-id", attr: { spellcheck: "false" } });
    const secretInput = form.createEl("input", { type: "password", placeholder: "Secret value" });
    const save = form.createEl("button", { text: "Save", cls: "mod-cta" });
    addButton.onClick(() => {
      if (this.disabled) return;
      form.toggle(form.style.display === "none");
      if (form.style.display !== "none") idInput.focus();
    });
    save.addEventListener("click", () => {
      const id = idInput.value.trim();
      const storage = this.storage();
      if (!id || !storage) return;
      try {
        storage.setSecret(id, secretInput.value);
      } catch (e) {
        idInput.setCustomValidity(e instanceof Error ? e.message : String(e));
        idInput.reportValidity();
        return;
      }
      idInput.value = "";
      secretInput.value = "";
      form.hide();
      this.setValue(id);
      runCallback(this.changeCallback, id);
    });
    idInput.addEventListener("input", () => idInput.setCustomValidity(""));
    this.renderOptions();
  }

  private storage(): SecretStorageLike | null {
    return ((this.app as unknown as { secretStorage?: SecretStorageLike }).secretStorage ?? null) as SecretStorageLike | null;
  }

  private renderOptions() {
    const ids = this.storage()?.listSecrets() ?? [];
    this.selectEl.empty();
    this.selectEl.createEl("option", { value: "", text: "Select a secret…" });
    for (const id of ids) this.selectEl.createEl("option", { value: id, text: id });
    if (this.value && !ids.includes(this.value)) this.selectEl.createEl("option", { value: this.value, text: `${this.value} (missing)` });
    this.selectEl.value = this.value;
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.selectEl.disabled = disabled;
    return this;
  }

  // internal
  getValue(): string {
    return this.value;
  }

  setValue(value: string): this {
    this.value = value ?? "";
    this.renderOptions();
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.changeCallback = cb;
    return this;
  }
}

// ---- Setting ------------------------------------------------------------------------

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  components: BaseComponent[] = [];
  errorEl: HTMLElement | null = null;

  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }

  setErrorMessage(message: string | null): this {
    if (message) {
      if (!this.errorEl) this.errorEl = this.infoEl.createDiv({ cls: "vault-setting-item-error", attr: { role: "alert" } });
      this.errorEl.setText(message);
      this.settingEl.addClass("is-invalid");
    } else {
      this.errorEl?.remove();
      this.errorEl = null;
      this.settingEl.removeClass("is-invalid");
    }
    return this;
  }

  addDisplayValue(cb: (component: DisplayValueComponent) => any): this {
    cb(new DisplayValueComponent(this.controlEl));
    return this;
  }

  // internal (used by plugins: importer's format list) — the whole row becomes
  // a navigation entry with a trailing chevron, styled like a SettingPage entry.
  // Click only: callers that manage focus (Importer) bind Enter/Space themselves.
  setNavigable(onNavigate: (evt: MouseEvent) => unknown): this {
    const el = this.settingEl;
    if (!el.hasClass("vault-setting-page-entry")) {
      el.addClass("vault-setting-page-entry");
      el.setAttr("role", "button");
      setIcon(this.controlEl.createDiv({ cls: "vault-setting-page-chevron" }), "lucide-chevron-right");
    }
    el.addEventListener("click", (evt) => {
      if (el.hasClass("is-disabled")) return;
      if (evt.target instanceof Element && evt.target.closest("button, input, select, textarea, .clickable-icon")) return;
      onNavigate(evt);
    });
    return this;
  }

  // internal (used by plugins: importer's file lists) — a leading icon, the
  // same `.setting-item-icon` slot SettingGroup list rows use. `null` removes it.
  setIcon(icon: string | null): this {
    let iconEl = this.settingEl.querySelector<HTMLElement>(":scope > .setting-item-icon");
    if (!icon) {
      iconEl?.remove();
      return this;
    }
    if (!iconEl) {
      iconEl = createDiv({ cls: "setting-item-icon" });
      this.settingEl.prepend(iconEl);
    }
    iconEl.empty();
    setIcon(iconEl, icon);
    return this;
  }

  // internal (used by plugins: importer's "Choose files" rows) — the row runs
  // `action` when clicked or activated from the keyboard, like a declarative
  // setting with `action`.
  setAction(action: (evt: Event) => unknown): this {
    const el = this.settingEl;
    el.addClass("vault-setting-action");
    el.setAttr("tabindex", 0);
    el.setAttr("role", "button");
    const run = (evt: Event) => {
      if (el.hasClass("is-disabled")) return;
      if (evt.target instanceof Element && evt.target !== el && evt.target.closest("button, input, select, textarea, .clickable-icon")) return;
      action(evt);
    };
    el.addEventListener("click", run);
    el.addEventListener("keydown", (evt) => {
      if (evt.target === el && (evt.key === "Enter" || evt.key === " ")) {
        evt.preventDefault();
        run(evt);
      }
    });
    return this;
  }

  setName(name: string | DocumentFragment): this {
    this.nameEl.setText(name);
    return this;
  }

  setDesc(desc: string | DocumentFragment): this {
    this.descEl.setText(desc);
    return this;
  }

  setClass(cls: string): this {
    this.settingEl.addClass(cls);
    return this;
  }

  setTooltip(tooltip: string, options?: TooltipOptions): this {
    setTooltip(this.nameEl, tooltip, options);
    return this;
  }

  setHeading(): this {
    this.settingEl.addClass("setting-item-heading");
    this.nameEl.setAttr("role", "heading");
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.settingEl.toggleClass("is-disabled", disabled);
    for (const c of this.components) c.setDisabled(disabled);
    return this;
  }

  // internal (used by plugins: Excalidraw's export dialog shows and hides rows)
  setVisibility(visible: boolean): this {
    this.settingEl.toggle(visible);
    return this;
  }

  private add<C extends BaseComponent>(component: C, cb: (component: C) => any): this {
    this.components.push(component);
    cb(component);
    return this;
  }

  addButton(cb: (component: ButtonComponent) => any): this {
    return this.add(new ButtonComponent(this.controlEl), cb);
  }

  addExtraButton(cb: (component: ExtraButtonComponent) => any): this {
    return this.add(new ExtraButtonComponent(this.controlEl), cb);
  }

  addToggle(cb: (component: ToggleComponent) => any): this {
    return this.add(new ToggleComponent(this.controlEl), cb);
  }

  addText(cb: (component: TextComponent) => any): this {
    return this.add(new TextComponent(this.controlEl), cb);
  }

  addComponent<T extends BaseComponent>(cb: (el: HTMLElement) => T): this {
    const c = cb(this.controlEl);
    if (c) this.components.push(c);
    return this;
  }

  addSearch(cb: (component: SearchComponent) => any): this {
    return this.add(new SearchComponent(this.controlEl), cb);
  }

  addTextArea(cb: (component: TextAreaComponent) => any): this {
    return this.add(new TextAreaComponent(this.controlEl), cb);
  }

  addMomentFormat(cb: (component: MomentFormatComponent) => any): this {
    return this.add(new MomentFormatComponent(this.controlEl), cb);
  }

  addDropdown(cb: (component: DropdownComponent) => any): this {
    return this.add(new DropdownComponent(this.controlEl), cb);
  }

  addColorPicker(cb: (component: ColorComponent) => any): this {
    return this.add(new ColorComponent(this.controlEl), cb);
  }

  addProgressBar(cb: (component: ProgressBarComponent) => any): this {
    return this.add(new ProgressBarComponent(this.controlEl), cb);
  }

  addSlider(cb: (component: SliderComponent) => any): this {
    return this.add(new SliderComponent(this.controlEl), cb);
  }

  then(cb: (setting: this) => any): this {
    cb(this);
    return this;
  }

  clear(): this {
    this.controlEl.empty();
    this.components = [];
    return this;
  }
}

// ---- SettingGroup, SettingPage ------------------------------------------------------

/**
 * A titled block of settings (1.11). DOM:
 * `.setting-group > .setting-item.setting-item-heading + .setting-items`.
 */
export class SettingGroup {
  listEl: HTMLElement;
  // internal
  groupEl: HTMLElement;
  // internal: created on first heading/search/extra button
  headerSetting: Setting | null = null;

  constructor(containerEl: HTMLElement) {
    this.groupEl = containerEl.createDiv({ cls: "setting-group" });
    this.listEl = this.groupEl.createDiv({ cls: "setting-items" });
  }

  // internal
  getHeader(): Setting {
    if (!this.headerSetting) {
      const frag = createDiv();
      this.headerSetting = new Setting(frag).setHeading();
      this.groupEl.insertBefore(this.headerSetting.settingEl, this.listEl);
    }
    return this.headerSetting;
  }

  setHeading(text: string | DocumentFragment): this {
    this.getHeader().setName(text);
    return this;
  }

  addClass(...classes: string[]): this {
    this.groupEl.addClass(...classes);
    return this;
  }

  addSetting(cb: (setting: Setting) => void): this {
    cb(new Setting(this.listEl));
    return this;
  }

  addSearch(cb: (component: SearchComponent) => any): this {
    this.getHeader().addSearch(cb);
    return this;
  }

  addExtraButton(cb: (component: ExtraButtonComponent) => any): this {
    this.getHeader().addExtraButton(cb);
    return this;
  }
}

/**
 * A sub-page of a setting tab (1.13). The tab that opens it sets `title`,
 * mounts `rootEl` and calls `display()`; `hide()` runs when the user leaves.
 */
export abstract class SettingPage {
  rootEl: HTMLElement;
  titlebarEl: HTMLElement;
  containerEl: HTMLElement;
  title = "";
  // internal: set by the tab while the page is open; returns to the parent page.
  navigateBack: (() => void) | null = null;

  constructor() {
    this.rootEl = createDiv({ cls: "vault-setting-page" });
    this.titlebarEl = this.rootEl.createDiv({ cls: "vault-setting-page-titlebar" });
    this.containerEl = this.rootEl.createDiv({ cls: "vault-setting-page-content" });
  }

  abstract display(): void;

  hide(): void {
    this.containerEl.empty();
  }
}
