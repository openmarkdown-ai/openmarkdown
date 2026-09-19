/**
 * Modals used by the Bases toolbar: the formula editor (live validation), the
 * custom summary editor, and a one-line text prompt.
 */
import { NullValue, ErrorValue, normalizePropertyId } from "../../obsidian/bases/api";
import { setIcon } from "../../obsidian/ui/icons";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { debounce } from "../../obsidian/util";
import type { BasesHost } from "./host";

const FUNCTION_NAMES = [
  "now()", "today()", "date()", "duration()", "if()", "min()", "max()", "number()", "list()", "link()", "file()", "image()", "icon()", "html()", "escapeHTML()", "random()",
  ".contains()", ".containsAll()", ".containsAny()", ".startsWith()", ".endsWith()", ".isEmpty()", ".lower()", ".title()", ".trim()", ".replace()", ".repeat()", ".reverse()", ".slice()", ".split()",
  ".abs()", ".ceil()", ".floor()", ".round()", ".toFixed()", ".format()", ".relative()", ".time()", ".filter()", ".map()", ".reduce()", ".flat()", ".join()", ".sort()", ".unique()",
  ".sum()", ".mean()", ".median()", ".min()", ".max()", ".asLink()", ".asFile()", ".hasLink()", ".hasTag()", ".hasProperty()", ".inFolder()", ".linksTo()", ".keys()", ".values()", ".matches()", ".toString()", ".isTruthy()", ".isType()",
];

/** Replace every `formula.<from>` property id in the base with `formula.<to>`. */
export function renameFormulaReferences(base: any, from: string, to: string) {
  const oldId = `formula.${from}`;
  const newId = `formula.${to}`;
  const swap = (id: string) => (normalizePropertyId(id) === oldId ? newId : id);
  if (base.properties && oldId in base.properties) {
    const entries = Object.entries(base.properties).map(([k, v]) => [k === oldId ? newId : k, v]);
    base.properties = Object.fromEntries(entries);
  }
  for (const view of base.views ?? []) {
    if (Array.isArray(view.order)) view.order = view.order.map(swap);
    if (Array.isArray(view.sort)) for (const s of view.sort) s.property = swap(s.property);
    if (view.groupBy?.property) view.groupBy.property = swap(view.groupBy.property);
    if (view.summaries) view.summaries = Object.fromEntries(Object.entries(view.summaries).map(([k, v]) => [swap(k), v]));
    if (view.columnSize) view.columnSize = Object.fromEntries(Object.entries(view.columnSize).map(([k, v]) => [swap(k), v]));
  }
}

export class FormulaModal extends Modal {
  private nameInput!: HTMLInputElement;
  private formulaInput!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;

  constructor(
    private host: BasesHost,
    private existingName: string | null,
    private onSaved?: (name: string) => void,
  ) {
    super(host.app);
  }

  override onOpen() {
    const base = this.host.controller.base;
    this.modalEl.addClass("bases-formula-modal");
    this.setTitle(this.existingName === null ? "Add formula" : "Edit formula");
    const { contentEl } = this;
    const nameRow = contentEl.createDiv({ cls: "bases-formula-field" });
    nameRow.createDiv({ cls: "bases-formula-label", text: "Formula name" });
    this.nameInput = nameRow.createEl("input", { type: "text", cls: "bases-formula-name", placeholder: "Untitled" });
    this.nameInput.value = this.existingName ?? "";
    const formulaRow = contentEl.createDiv({ cls: "bases-formula-field" });
    formulaRow.createDiv({ cls: "bases-formula-label", text: "Formula" });
    this.formulaInput = formulaRow.createEl("textarea", { cls: "bases-formula-input", attr: { rows: "4", spellcheck: "false", placeholder: 'if(price, price.toFixed(2) + " dollars")' } });
    this.formulaInput.value = this.existingName !== null ? String(base.formulas?.[this.existingName] ?? "") : "";
    this.statusEl = contentEl.createDiv({ cls: "bases-formula-status" });
    const help = contentEl.createDiv({ cls: "bases-formula-help setting-item-description" });
    help.setText("Reference properties by name (price), file properties (file.mtime) and other formulas (formula.name). Functions: " + FUNCTION_NAMES.slice(0, 16).join(", ") + " …");
    const validate = debounce(() => this.validate(), 150, true);
    this.formulaInput.addEventListener("input", () => validate());
    this.formulaInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        this.save();
      }
    });
    this.nameInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        this.formulaInput.focus();
      }
    });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { cls: "mod-cta", text: "Save" }).addEventListener("click", () => this.save());
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    this.validate();
    (this.existingName === null ? this.nameInput : this.formulaInput).focus();
  }

  private validate() {
    const expr = this.formulaInput.value;
    this.statusEl.empty();
    this.statusEl.removeClasses(["mod-error", "mod-success"]);
    if (!expr.trim()) return;
    const ctrl = this.host.controller;
    const sample = ctrl.results?.data[0]?.file ?? ctrl.thisFile ?? null;
    const value = ctrl.evaluate(expr, sample);
    if (value instanceof ErrorValue) {
      this.statusEl.addClass("mod-error");
      setIcon(this.statusEl.createSpan({ cls: "bases-formula-status-icon" }), "lucide-alert-circle");
      this.statusEl.createSpan({ text: value.message });
      return;
    }
    this.statusEl.addClass("mod-success");
    setIcon(this.statusEl.createSpan({ cls: "bases-formula-status-icon" }), "lucide-check");
    if (sample && !(value instanceof NullValue)) {
      this.statusEl.createSpan({ cls: "bases-formula-preview-label", text: `${sample.basename}: ` });
      value.renderTo(this.statusEl.createSpan({ cls: "bases-formula-preview bases-rendered-value" }), this.app.renderContext);
    } else this.statusEl.createSpan({ text: "Valid formula" });
  }

  private save() {
    const name = this.nameInput.value.trim();
    const formula = this.formulaInput.value;
    if (!name) {
      new Notice("Formula name cannot be empty");
      return;
    }
    const base = this.host.controller.base;
    base.formulas ??= {};
    if (name !== this.existingName && name in base.formulas) {
      new Notice(`A formula named “${name}” already exists`);
      return;
    }
    if (this.existingName !== null && this.existingName !== name) {
      const entries = Object.entries(base.formulas).map(([k, v]) => (k === this.existingName ? [name, formula] : [k, v]));
      base.formulas = Object.fromEntries(entries);
      renameFormulaReferences(base, this.existingName, name);
    } else {
      base.formulas[name] = formula;
      if (this.existingName === null) {
        const view = this.host.controller.currentView;
        if (view) view.order = [...(Array.isArray(view.order) ? view.order : ["file.name"]), `formula.${name}`];
      }
    }
    this.host.commit();
    this.onSaved?.(name);
    this.close();
  }

  override onClose() {
    this.contentEl.empty();
  }
}

export class SummaryModal extends Modal {
  constructor(
    private host: BasesHost,
    private onSaved: (name: string) => void,
  ) {
    super(host.app);
  }

  override onOpen() {
    this.setTitle("Add summary");
    const { contentEl } = this;
    const nameRow = contentEl.createDiv({ cls: "bases-formula-field" });
    nameRow.createDiv({ cls: "bases-formula-label", text: "Summary name" });
    const name = nameRow.createEl("input", { type: "text", placeholder: "Custom summary" });
    const formulaRow = contentEl.createDiv({ cls: "bases-formula-field" });
    formulaRow.createDiv({ cls: "bases-formula-label", text: "Formula" });
    const formula = formulaRow.createEl("textarea", { cls: "bases-formula-input", attr: { rows: "3", spellcheck: "false", placeholder: "values.mean().round(3)" } });
    contentEl.createDiv({ cls: "setting-item-description", text: "Use values to refer to the list of values in the column." });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { cls: "mod-cta", text: "Save" }).addEventListener("click", () => {
      const n = name.value.trim();
      if (!n || !formula.value.trim()) {
        new Notice("Summary name and formula are required");
        return;
      }
      const base = this.host.controller.base;
      base.summaries ??= {};
      base.summaries[n] = formula.value;
      this.onSaved(n);
      this.close();
    });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    name.focus();
  }

  override onClose() {
    this.contentEl.empty();
  }
}

export class PromptModal extends Modal {
  constructor(
    app: any,
    private title: string,
    private initial: string,
    private onSubmit: (value: string) => void,
    private placeholder = "",
  ) {
    super(app);
  }

  override onOpen() {
    this.setTitle(this.title);
    const input = this.contentEl.createEl("input", { type: "text", cls: "bases-prompt-input", placeholder: this.placeholder });
    input.value = this.initial;
    const submit = () => {
      this.onSubmit(input.value);
      this.close();
    };
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        submit();
      }
    });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { cls: "mod-cta", text: "Save" }).addEventListener("click", submit);
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    input.focus();
    input.select();
  }

  override onClose() {
    this.contentEl.empty();
  }
}
