/**
 * The suggest family: SuggestModal, FuzzySuggestModal, PopoverSuggest,
 * AbstractInputSuggest, EditorSuggest — plus the internal `SuggestionChooser`
 * that renders and navigates a list, and `EditorSuggests`, the per-workspace
 * manager the editor drives (`app.workspace.editorSuggest`).
 *
 * DOM of a SuggestModal:
 *
 *   .modal-container.mod-dim > .modal-bg + .prompt
 *     .prompt-input-container > input.prompt-input + .search-input-clear-button
 *     .prompt-results > .suggestion-item[.is-selected] | .suggestion-empty
 *     .prompt-instructions > .prompt-instruction > .prompt-instruction-command + span
 *
 * DOM of a PopoverSuggest: `body > .suggestion-container > .suggestion > .suggestion-item`
 * (+ `.prompt-instructions` for an EditorSuggest that set instructions).
 *
 * Keys go through the owner's Scope: ArrowUp/ArrowDown move, Enter chooses,
 * Escape closes. A handler that plugins add to `this.scope` (Shift+Enter, Mod+Enter …)
 * takes part in the same routing.
 */
import type { App } from "../app";
import type {
  Editor,
  EditorPosition,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  FuzzyMatch,
  HistoryHandler,
  Instruction,
  ISuggestOwner,
  TFile,
} from "obsidian";
import { prepareFuzzySearch, renderResults, sortSearchResults } from "../util";
import { Keymap, Scope, keymapFor } from "./keymap";
import { Modal } from "./modal";

const DEFAULT_LIMIT = 100;

// ---- SuggestionChooser -----------------------------------------------------------

/**
 * internal (used by plugins: `modal.chooser.values`, `.selectedItem`,
 * `.setSelectedItem()`, `.useSelectedItem()`, `.suggestions`)
 */
export class SuggestionChooser<T> {
  owner: ISuggestOwner<T>;
  containerEl: HTMLElement;
  values: T[] | null = null;
  suggestions: HTMLElement[] = [];
  selectedItem = 0;

  constructor(owner: ISuggestOwner<T>, containerEl: HTMLElement, scope: Scope) {
    this.owner = owner;
    this.containerEl = containerEl;
    scope.register([], "ArrowUp", (evt) => {
      if (evt.isComposing || !this.hasValues()) return;
      this.moveUp(evt);
      return false;
    });
    scope.register([], "ArrowDown", (evt) => {
      if (evt.isComposing || !this.hasValues()) return;
      this.moveDown(evt);
      return false;
    });
    scope.register([], "PageUp", (evt) => {
      if (!this.hasValues()) return;
      this.pageMove(evt, -1);
      return false;
    });
    scope.register([], "PageDown", (evt) => {
      if (!this.hasValues()) return;
      this.pageMove(evt, 1);
      return false;
    });
    containerEl.on("click", ".suggestion-item", (evt, target) => {
      evt.preventDefault();
      const i = this.suggestions.indexOf(target);
      if (i === -1) return;
      this.setSelectedItem(i, false);
      this.useSelectedItem(evt as MouseEvent);
    });
    containerEl.on("mousemove", ".suggestion-item", (_evt, target) => {
      const i = this.suggestions.indexOf(target);
      if (i !== -1 && i !== this.selectedItem) this.setSelectedItem(i, false);
    });
  }

  hasValues(): boolean {
    return !!this.values && this.values.length > 0;
  }

  setSuggestions(values: T[] | null): void {
    this.containerEl.empty();
    this.suggestions = [];
    this.values = values;
    if (!values) return;
    for (const value of values) {
      const el = this.containerEl.createDiv({ cls: "suggestion-item" });
      try {
        this.owner.renderSuggestion(value, el);
      } catch (e) {
        console.error(e);
      }
      this.suggestions.push(el);
    }
    this.selectedItem = -1;
    this.setSelectedItem(0, false);
  }

  setSelectedItem(index: number, scroll: boolean | KeyboardEvent | MouseEvent): void {
    const n = this.suggestions.length;
    if (n === 0) {
      this.selectedItem = 0;
      return;
    }
    const i = ((index % n) + n) % n;
    this.suggestions[this.selectedItem]?.removeClass("is-selected");
    this.selectedItem = i;
    const el = this.suggestions[i]!;
    el.addClass("is-selected");
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }

  moveUp(evt: KeyboardEvent): false {
    this.setSelectedItem(this.selectedItem - 1, evt);
    return false;
  }

  moveDown(evt: KeyboardEvent): false {
    this.setSelectedItem(this.selectedItem + 1, evt);
    return false;
  }

  private pageMove(evt: KeyboardEvent, dir: number) {
    const el = this.suggestions[this.selectedItem];
    const perPage = el && el.offsetHeight > 0 ? Math.max(1, Math.floor(this.containerEl.clientHeight / el.offsetHeight)) : 10;
    const target = Math.min(Math.max(this.selectedItem + dir * perPage, 0), this.suggestions.length - 1);
    this.setSelectedItem(target, evt);
  }

  useSelectedItem(evt: MouseEvent | KeyboardEvent): boolean {
    if (!this.values || this.values.length === 0) return false;
    const value = this.values[this.selectedItem];
    if (value === undefined) return false;
    this.owner.selectSuggestion(value, evt);
    return true;
  }
}

// ---- SuggestModal ------------------------------------------------------------------

export abstract class SuggestModal<T> extends Modal implements ISuggestOwner<T> {
  limit = DEFAULT_LIMIT;
  emptyStateText = "No results found.";
  inputEl: HTMLInputElement;
  resultContainerEl: HTMLElement;
  // internal
  chooser: SuggestionChooser<T>;
  // internal
  inputContainerEl: HTMLElement;
  // internal
  clearButtonEl: HTMLElement;
  // internal
  instructionsEl: HTMLElement | null = null;
  private querySeq = 0;
  private queryAtClose: string | null = null;

  constructor(app: App) {
    super(app);
    this.modalEl.empty();
    this.modalEl.className = "prompt";
    this.inputContainerEl = this.modalEl.createDiv({ cls: "prompt-input-container" });
    this.inputEl = this.inputContainerEl.createEl("input", {
      cls: "prompt-input",
      type: "text",
      attr: { enterkeyhint: "done", spellcheck: "false", autocomplete: "off" },
    });
    this.clearButtonEl = this.inputContainerEl.createDiv({ cls: "search-input-clear-button", attr: { "aria-label": "Clear search" } });
    this.clearButtonEl.hide();
    this.clearButtonEl.addEventListener("click", () => {
      this.inputEl.value = "";
      this.inputEl.focus();
      this.onInput();
    });
    this.resultContainerEl = this.modalEl.createDiv({ cls: "prompt-results" });
    // Clicking a result must not blur the input.
    this.resultContainerEl.addEventListener("mousedown", (evt) => evt.preventDefault());
    this.chooser = new SuggestionChooser<T>(this, this.resultContainerEl, this.scope);
    this.scope.register([], "Enter", (evt) => {
      if (evt.isComposing) return;
      this.selectActiveSuggestion(evt);
      return false;
    });
    this.inputEl.addEventListener("input", () => this.onInput());
  }

  override open(): void {
    const wasOpen = this.isOpen;
    super.open();
    if (wasOpen || !this.isOpen) return;
    // A modal instance reopened by a plugin (Templater keeps one picker for
    // every "insert template") starts with an empty query, not the last one
    // typed. A value the plugin set on the input since closing is kept.
    if (this.queryAtClose !== null && this.inputEl.value === this.queryAtClose) this.inputEl.value = "";
    this.queryAtClose = null;
    this.inputEl.focus();
    this.onInput();
  }

  override close(): void {
    const wasOpen = this.isOpen;
    super.close();
    // Read after close: onChooseSuggestion runs after close() and often uses the query.
    if (wasOpen && !this.isOpen) this.queryAtClose = this.inputEl.value;
  }

  setPlaceholder(placeholder: string): void {
    this.inputEl.setAttribute("placeholder", placeholder);
  }

  setInstructions(instructions: Instruction[]): void {
    if (!this.instructionsEl) this.instructionsEl = this.modalEl.createDiv({ cls: "prompt-instructions" });
    this.instructionsEl.empty();
    for (const ins of instructions) {
      const row = this.instructionsEl.createDiv({ cls: "prompt-instruction" });
      row.createSpan({ cls: "prompt-instruction-command", text: ins.command });
      row.createSpan({ text: ins.purpose });
    }
  }

  // internal
  onInput(): void {
    this.clearButtonEl.toggle(this.inputEl.value !== "");
    this.updateSuggestions();
  }

  // internal
  updateSuggestions(): void {
    const seq = ++this.querySeq;
    const query = this.inputEl.value;
    let result: T[] | Promise<T[]>;
    try {
      result = this.getSuggestions(query);
    } catch (e) {
      console.error(e);
      result = [];
    }
    const apply = (values: T[] | null | undefined) => {
      if (seq !== this.querySeq || !this.isOpen) return;
      if (!values || values.length === 0) {
        this.chooser.setSuggestions(null);
        this.onNoSuggestion();
        return;
      }
      this.chooser.setSuggestions(this.limit > 0 ? values.slice(0, this.limit) : values);
    };
    if (result instanceof Promise) {
      result.then(apply, (e) => {
        console.error(e);
        apply([]);
      });
    } else apply(result);
  }

  onNoSuggestion(): void {
    this.chooser.setSuggestions(null);
    this.resultContainerEl.createDiv({ cls: "suggestion-empty", text: this.emptyStateText });
  }

  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    this.close();
    this.onChooseSuggestion(value, evt);
  }

  selectActiveSuggestion(evt: MouseEvent | KeyboardEvent): void {
    this.chooser.useSelectedItem(evt);
  }

  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  getSuggestions(query: string): FuzzyMatch<T>[] {
    const items = this.getItems();
    const q = query.trim();
    if (!q) return items.map((item) => ({ item, match: { score: 0, matches: [] } }));
    const search = prepareFuzzySearch(q);
    const results: FuzzyMatch<T>[] = [];
    for (const item of items) {
      const match = search(this.getItemText(item));
      if (match) results.push({ item, match });
    }
    sortSearchResults(results);
    return results;
  }

  renderSuggestion(item: FuzzyMatch<T>, el: HTMLElement): void {
    renderResults(el, this.getItemText(item.item), item.match);
  }

  onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseItem(item.item, evt);
  }

  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
}

// ---- PopoverSuggest ------------------------------------------------------------------

/** internal: a rectangle to place a popover against. */
export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
  right: number;
  width: number;
}

export abstract class PopoverSuggest<T> implements ISuggestOwner<T>, HistoryHandler {
  app: App;
  scope: Scope;
  // internal (used by plugins: `suggest.suggestEl` to add classes, `.suggestions` to style)
  suggestEl: HTMLElement;
  // internal
  suggestionsEl: HTMLElement;
  // internal
  chooser: SuggestionChooser<T>;
  // internal
  isOpen = false;
  private explicitParent: boolean;
  private detachWindowListeners: (() => void) | null = null;

  constructor(app: App, scope?: Scope) {
    this.app = app;
    this.explicitParent = !!scope;
    this.scope = new Scope(scope);
    this.suggestEl = createDiv({ cls: "suggestion-container" });
    this.suggestionsEl = this.suggestEl.createDiv({ cls: "suggestion" });
    this.suggestEl.addEventListener("mousedown", (evt) => evt.preventDefault());
    this.chooser = new SuggestionChooser<T>(this, this.suggestionsEl, this.scope);
    this.scope.register([], "Enter", (evt) => {
      if (evt.isComposing || !this.chooser.hasValues()) return;
      this.chooser.useSelectedItem(evt);
      return false;
    });
    this.scope.register([], "Escape", (evt) => {
      if (evt.isComposing) return;
      this.close();
      return false;
    });
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    const keymap = keymapFor(this.app);
    if (!this.explicitParent) {
      const active = keymap.getActiveScope();
      this.scope.parent = active !== this.scope ? active : undefined;
    }
    keymap.pushScope(this.scope);
    const doc = (globalThis as { activeDocument?: Document }).activeDocument ?? document;
    doc.body.appendChild(this.suggestEl);
    const win = doc.defaultView ?? window;
    const onResize = () => this.onViewportChange();
    const onScroll = (evt: Event) => {
      if (evt.target instanceof Node && this.suggestEl.contains(evt.target)) return;
      this.onViewportChange();
    };
    win.addEventListener("resize", onResize);
    win.addEventListener("scroll", onScroll, true);
    this.detachWindowListeners = () => {
      win.removeEventListener("resize", onResize);
      win.removeEventListener("scroll", onScroll, true);
    };
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    keymapFor(this.app).popScope(this.scope);
    this.detachWindowListeners?.();
    this.detachWindowListeners = null;
    this.chooser.setSuggestions(null);
    this.suggestEl.detach();
  }

  onHistoryBack(): void {
    this.close();
  }

  // internal: called on window scroll/resize while open.
  onViewportChange(): void {}

  // internal
  showSuggestions(values: T[]): void {
    if (values.length === 0) {
      this.close();
      return;
    }
    this.chooser.setSuggestions(values);
    this.open();
  }

  // internal: place the popover below the anchor, or above it when there is more room.
  reposition(rect: AnchorRect, matchWidth = false): void {
    const el = this.suggestEl;
    const doc = el.ownerDocument;
    const win = doc.defaultView ?? window;
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const margin = 8;
    const gap = 4;
    if (matchWidth) el.style.minWidth = `${Math.round(rect.width)}px`;
    else el.style.removeProperty("min-width");
    el.style.removeProperty("max-height");
    const w = el.offsetWidth;
    let h = el.offsetHeight;
    const below = vh - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    const placeAbove = h > below && above > below;
    const room = placeAbove ? above : below;
    if (h > room) {
      el.style.maxHeight = `${Math.max(80, Math.floor(room))}px`;
      h = Math.min(h, Math.max(80, room));
    }
    const top = placeAbove ? rect.top - gap - h : rect.bottom + gap;
    const left = Math.min(Math.max(rect.left, margin), Math.max(margin, vw - w - margin));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(margin, top))}px`;
    el.toggleClass("mod-above", placeAbove);
  }

  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
}

// ---- AbstractInputSuggest -------------------------------------------------------------

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  limit = DEFAULT_LIMIT;
  // internal
  textInputEl: HTMLInputElement | HTMLDivElement;
  // internal
  selectCallback: ((value: T, evt: MouseEvent | KeyboardEvent) => any) | null = null;
  private querySeq = 0;

  constructor(app: App, textInputEl: HTMLInputElement | HTMLDivElement) {
    super(app);
    this.textInputEl = textInputEl;
    this.suggestEl.addClass("mod-search-suggestion");
    textInputEl.addEventListener("input", () => this.onInputChange());
    textInputEl.addEventListener("focus", () => this.onInputChange());
    textInputEl.addEventListener("blur", () => this.close());
  }

  setValue(value: string): void {
    if (this.textInputEl instanceof HTMLInputElement) this.textInputEl.value = value;
    else this.textInputEl.textContent = value;
  }

  getValue(): string {
    if (this.textInputEl instanceof HTMLInputElement) return this.textInputEl.value;
    return this.textInputEl.textContent ?? "";
  }

  protected abstract getSuggestions(query: string): T[] | Promise<T[]>;

  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    if (this.selectCallback) {
      try {
        const r = this.selectCallback(value, evt);
        if (r instanceof Promise) r.catch((e) => console.error(e));
      } catch (e) {
        console.error(e);
      }
    }
    this.close();
  }

  onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => any): this {
    this.selectCallback = callback;
    return this;
  }

  // internal
  onInputChange(): void {
    const seq = ++this.querySeq;
    let result: T[] | Promise<T[]>;
    try {
      result = this.getSuggestions(this.getValue());
    } catch (e) {
      console.error(e);
      result = [];
    }
    const apply = (values: T[] | null | undefined) => {
      if (seq !== this.querySeq) return;
      const doc = this.textInputEl.ownerDocument;
      if (doc.activeElement !== this.textInputEl) {
        this.close();
        return;
      }
      if (!values || values.length === 0) {
        this.close();
        return;
      }
      this.showSuggestions(this.limit > 0 ? values.slice(0, this.limit) : values);
      this.reposition(this.textInputEl.getBoundingClientRect(), true);
    };
    if (result instanceof Promise) result.then(apply, (e) => (console.error(e), apply([])));
    else apply(result);
  }

  override onViewportChange(): void {
    if (!this.textInputEl.isConnected) {
      this.close();
      return;
    }
    this.reposition(this.textInputEl.getBoundingClientRect(), true);
  }
}

// ---- EditorSuggest ------------------------------------------------------------------------

export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
  context: EditorSuggestContext | null = null;
  limit = DEFAULT_LIMIT;
  // internal
  instructionsEl: HTMLElement | null = null;
  private querySeq = 0;

  constructor(app: App) {
    super(app);
    this.scope.register([], "Tab", (evt) => {
      if (evt.isComposing || !this.chooser.hasValues()) return;
      this.chooser.useSelectedItem(evt);
      return false;
    });
  }

  setInstructions(instructions: Instruction[]): void {
    if (!this.instructionsEl) this.instructionsEl = this.suggestEl.createDiv({ cls: "prompt-instructions" });
    this.instructionsEl.empty();
    for (const ins of instructions) {
      const row = this.instructionsEl.createDiv({ cls: "prompt-instruction" });
      row.createSpan({ cls: "prompt-instruction-command", text: ins.command });
      row.createSpan({ text: ins.purpose });
    }
  }

  abstract onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null;
  abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>;

  override close(): void {
    this.querySeq++;
    this.context = null;
    super.close();
  }

  /**
   * internal: evaluate `onTrigger` at the editor's cursor and show or update
   * the popover. With `openIfClosed` false (a cursor move rather than typing)
   * a closed suggest stays closed. Returns whether this suggest took the
   * trigger.
   */
  trigger(editor: Editor, file: TFile | null, openIfClosed: boolean): boolean {
    let info: EditorSuggestTriggerInfo | null = null;
    try {
      info = this.onTrigger(editor.getCursor(), editor, file);
    } catch (e) {
      console.error(e);
    }
    if (!info) {
      if (this.isOpen || this.context) this.close();
      return false;
    }
    if (!this.isOpen && !openIfClosed) return false;
    const context: EditorSuggestContext = { ...info, editor, file: file as TFile };
    this.context = context;
    const seq = ++this.querySeq;
    let result: T[] | Promise<T[]>;
    try {
      result = this.getSuggestions(context);
    } catch (e) {
      console.error(e);
      result = [];
    }
    const apply = (values: T[] | null | undefined) => {
      if (seq !== this.querySeq || this.context !== context) return;
      if (!values || values.length === 0) {
        this.close();
        return;
      }
      this.showSuggestions(this.limit > 0 ? values.slice(0, this.limit) : values);
      this.positionAtContext();
    };
    if (result instanceof Promise) result.then(apply, (e) => (console.error(e), apply([])));
    else apply(result);
    return true;
  }

  override onViewportChange(): void {
    this.positionAtContext();
  }

  // internal
  positionAtContext(): void {
    const ctx = this.context;
    if (!ctx || !this.isOpen) return;
    // `trigger` runs from the editor's update listener, where CodeMirror forbids
    // layout reads; measure in CodeMirror's next read phase instead.
    const cm = (ctx.editor as Editor & { cm?: { requestMeasure?: (req: { read: () => unknown; write?: (m: any) => void }) => void } }).cm;
    if (cm?.requestMeasure) {
      cm.requestMeasure({
        read: () => editorCoords(ctx.editor, ctx.start),
        write: (rect: AnchorRect | null) => {
          if (rect && this.context === ctx && this.isOpen) this.reposition(rect);
        },
      });
      return;
    }
    const rect = editorCoords(ctx.editor, ctx.start);
    if (rect) this.reposition(rect);
  }
}

interface Coords {
  left: number;
  right?: number;
  top: number;
  bottom: number;
}

function editorCoords(editor: Editor, pos: EditorPosition): AnchorRect | null {
  const e = editor as Editor & {
    cm?: { coordsAtPos(offset: number, side?: number): Coords | null };
    coordsAtPos?: (pos: EditorPosition, local?: boolean) => Coords | null;
  };
  let c: Coords | null = null;
  try {
    if (e.cm && typeof e.cm.coordsAtPos === "function") c = e.cm.coordsAtPos(editor.posToOffset(pos), 1);
    else if (typeof e.coordsAtPos === "function") c = e.coordsAtPos(pos);
  } catch (err) {
    console.error(err);
  }
  if (!c) {
    const doc = (globalThis as { activeDocument?: Document }).activeDocument ?? document;
    const sel = doc.getSelection();
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height || r.left || r.top) c = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }
    if (!c && doc.activeElement instanceof HTMLElement) {
      const r = doc.activeElement.getBoundingClientRect();
      c = { left: r.left, right: r.left, top: r.top, bottom: r.top + 20 };
    }
  }
  if (!c) return null;
  return { left: c.left, right: c.right ?? c.left, top: c.top, bottom: c.bottom, width: 0 };
}

// ---- EditorSuggests manager ------------------------------------------------------------------

/**
 * internal (used by plugins: `app.workspace.editorSuggest.suggests` — some
 * plugins `unshift` their suggest to take priority)
 *
 * The editor calls `trigger(editor, file)` from its update listener (typing:
 * `openIfClosed` true; cursor/selection moves: false), and consults
 * `isShowingSuggestion()` / `handleKey(evt)` for keys it would otherwise
 * handle itself. When the global Keymap is installed, keys already reach the
 * open suggest's scope first and `handleKey` is a fallback.
 */
export class EditorSuggests {
  app: App;
  suggests: EditorSuggest<any>[] = [];
  currentSuggest: EditorSuggest<any> | null = null;

  constructor(app: App) {
    this.app = app;
  }

  addSuggest(suggest: EditorSuggest<any>): void {
    if (!this.suggests.includes(suggest)) this.suggests.push(suggest);
  }

  removeSuggest(suggest: EditorSuggest<any>): void {
    const i = this.suggests.indexOf(suggest);
    if (i !== -1) this.suggests.splice(i, 1);
    if (this.currentSuggest === suggest) {
      suggest.close();
      this.currentSuggest = null;
    }
  }

  isShowingSuggestion(): boolean {
    return !!this.currentSuggest && this.currentSuggest.isOpen;
  }

  trigger(editor: Editor, file: TFile | null, openIfClosed = true): void {
    const current = this.currentSuggest;
    // An open suggest keeps the trigger while its own onTrigger still matches.
    const triedCurrent = !!current && current.isOpen;
    if (current && triedCurrent) {
      if (current.trigger(editor, file, true)) return;
      this.currentSuggest = null;
    }
    for (const suggest of this.suggests.slice()) {
      if (triedCurrent && suggest === current) continue;
      if (suggest.trigger(editor, file, openIfClosed)) {
        if (this.currentSuggest && this.currentSuggest !== suggest) this.currentSuggest.close();
        this.currentSuggest = suggest;
        return;
      }
    }
  }

  close(): void {
    this.currentSuggest?.close();
    this.currentSuggest = null;
  }

  /** Route a key to the open suggest's own handlers. Returns true when handled. */
  handleKey(evt: KeyboardEvent): boolean {
    const s = this.currentSuggest;
    if (!s || !s.isOpen) return false;
    const parent = s.scope.parent;
    s.scope.parent = undefined;
    try {
      return s.scope.handleKey(evt, Keymap.getContext(evt)) === false;
    } finally {
      s.scope.parent = parent;
    }
  }
}
