/**
 * View, ItemView, FileView, EditableFileView, TextFileView.
 *
 * The header DOM (`.view-header` with nav buttons, a title and actions) is what
 * themes style and what plugins reach into (`view.titleEl`, `view.actionsEl`,
 * `addAction`), so it is built the same way for every ItemView.
 */
import type { ViewStateResult } from "obsidian";
import { Component } from "../events";
import { setIcon } from "../ui/icons";
import { Menu } from "../ui/menu";
import { isMacPlatform, type Scope } from "../ui/keymap";
import { TFile, type TAbstractFile } from "../vault/files";
import { merge3 } from "../vault/merge";
import { canAutoMerge, checkedWrite, type SaveBase } from "../vault/save";
import { normalizeEol } from "../vault/text-format";
import type { WorkspaceLeaf } from "./leaf";

export abstract class View extends Component {
  app: any;
  icon = "";
  navigation = false;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  scope: Scope | null = null;
  // internal
  closeable = true;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = createDiv({ cls: "workspace-leaf-content" });
  }

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}

  // internal: called by the leaf
  async open(parentEl: HTMLElement): Promise<void> {
    this.containerEl.setAttr("data-type", this.getViewType());
    parentEl.appendChild(this.containerEl);
    this.load();
    await this.onOpen();
  }

  // internal: called by the leaf
  async close(): Promise<void> {
    await this.onClose();
    this.unload();
    this.containerEl.detach();
  }

  abstract getViewType(): string;

  getState(): Record<string, unknown> {
    return {};
  }

  async setState(_state: unknown, _result: ViewStateResult): Promise<void> {}

  getEphemeralState(): Record<string, unknown> {
    return {};
  }

  setEphemeralState(_state: unknown): void {}

  getIcon(): string {
    return this.icon;
  }

  onResize(): void {}

  abstract getDisplayText(): string;

  onPaneMenu(menu: Menu, source: string): void {
    // The tab header's menu has its own Close entries (leaf.ts).
    if (source === "tab-header") return;
    menu.addItem((item) =>
      item
        .setSection("pane")
        .setTitle("Close")
        .setIcon("lucide-x")
        .onClick(() => this.leaf.detach()),
    );
  }

  // internal
  onTabMenu(menu: Menu) {
    this.onPaneMenu(menu, "tab-header");
  }

  // internal (used by plugins: iconize, homepage)
  handleDrop(_evt: DragEvent, _dragData: unknown, _dropped: boolean): unknown {
    return null;
  }
}

export abstract class ItemView extends View {
  contentEl: HTMLElement;
  // internal (used by plugins: tab title decorations)
  headerEl: HTMLElement;
  titleEl: HTMLElement;
  titleParentEl: HTMLElement;
  titleContainerEl: HTMLElement;
  actionsEl: HTMLElement;
  iconEl: HTMLElement;
  backButtonEl: HTMLButtonElement;
  forwardButtonEl: HTMLButtonElement;
  moreOptionsButtonEl: HTMLElement;
  // internal
  navButtonsEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    const el = this.containerEl;
    this.headerEl = el.createDiv({ cls: "view-header" });
    const left = this.headerEl.createDiv({ cls: "view-header-left" });
    this.navButtonsEl = left.createDiv({ cls: "view-header-nav-buttons" });
    this.backButtonEl = this.navButtonsEl.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Navigate back", "aria-disabled": "true" } });
    setIcon(this.backButtonEl, "lucide-arrow-left");
    this.forwardButtonEl = this.navButtonsEl.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Navigate forward", "aria-disabled": "true" } });
    setIcon(this.forwardButtonEl, "lucide-arrow-right");
    this.backButtonEl.addEventListener("click", () => this.leaf.history.back());
    this.forwardButtonEl.addEventListener("click", () => this.leaf.history.forward());
    this.iconEl = this.headerEl.createDiv({ cls: "view-header-icon" });
    this.titleContainerEl = this.headerEl.createDiv({ cls: "view-header-title-container mod-at-start" });
    this.titleParentEl = this.titleContainerEl.createDiv({ cls: "view-header-title-parent" });
    this.titleEl = this.titleContainerEl.createDiv({ cls: "view-header-title", attr: { tabindex: "-1" } });
    this.actionsEl = this.headerEl.createDiv({ cls: "view-actions" });
    this.moreOptionsButtonEl = this.actionsEl.createEl("button", { cls: "clickable-icon view-action", attr: { "aria-label": "More options" } });
    setIcon(this.moreOptionsButtonEl, "lucide-more-vertical");
    this.moreOptionsButtonEl.addEventListener("click", (evt) => this.onMoreOptionsMenu(evt));
    this.contentEl = el.createDiv({ cls: "view-content" });
  }

  // internal
  onMoreOptionsMenu(evt: MouseEvent) {
    const menu = new Menu();
    this.onPaneMenu(menu, "more-options");
    this.app.workspace.trigger("leaf-menu", menu, this.leaf);
    menu.showAtMouseEvent(evt);
  }

  addAction(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
    const btn = createEl("button", { cls: "clickable-icon view-action", attr: { "aria-label": title } });
    setIcon(btn, icon);
    btn.addEventListener("click", callback);
    this.actionsEl.insertBefore(btn, this.actionsEl.firstChild);
    return btn;
  }

  // internal
  updateNavButtons() {
    const h = this.leaf.history;
    this.backButtonEl.setAttr("aria-disabled", h.backHistory.length === 0 ? "true" : "false");
    this.forwardButtonEl.setAttr("aria-disabled", h.forwardHistory.length === 0 ? "true" : "false");
  }

  // internal
  updateHeader() {
    this.titleEl.setText(this.getDisplayText());
    this.updateNavButtons();
  }
}

export abstract class FileView extends ItemView {
  allowNoFile = false;
  file: TFile | null = null;
  override navigation = true;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getDisplayText(): string {
    return this.file ? this.file.basename : "No file";
  }

  override onload(): void {
    super.onload();
    this.registerEvent(
      this.app.vault.on("rename", (f: TAbstractFile) => {
        if (f === this.file) void this.onRename(f as TFile);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f: TAbstractFile) => {
        if (f === this.file) void this.onDelete(f as TFile);
      }),
    );
    // Clicking the title renames the file, as in Obsidian.
    this.titleEl.addEventListener("click", () => this.startTitleRename());
  }

  // internal
  async onDelete(_file: TFile) {
    this.file = null;
    this.leaf.detach();
  }

  private startTitleRename() {
    const file = this.file;
    if (!file || this.titleEl.getAttr("contenteditable") === "true") return;
    this.titleEl.setAttr("contenteditable", "true");
    this.titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(this.titleEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const finish = async (commit: boolean, returnFocus = false) => {
      this.titleEl.removeAttribute("contenteditable");
      this.titleEl.removeEventListener("keydown", onKey);
      this.titleEl.removeEventListener("blur", onBlur);
      const name = this.titleEl.getText().trim();
      // Enter/Escape hand the keyboard back to the note at once, so keys typed while the rename runs land in it.
      if (returnFocus) this.focusAfterTitleRename();
      if (commit && name && name !== file.basename) {
        const newPath = file.getNewPathAfterRename(file.extension ? `${name}.${file.extension}` : name);
        try {
          await this.app.fileManager.renameFile(file, newPath);
        } catch (e) {
          const { Notice } = await import("../ui/notice");
          new Notice(String((e as Error).message ?? e));
        }
      }
      this.updateHeader();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void finish(true, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void finish(false, true);
      }
    };
    const onBlur = () => void finish(true);
    this.titleEl.addEventListener("keydown", onKey);
    this.titleEl.addEventListener("blur", onBlur);
  }

  // internal: where focus goes after a view-header rename (the editor, for views that have one)
  focusAfterTitleRename() {
    const editor = (this as { editor?: { focus?: () => void } }).editor;
    if (editor?.focus) editor.focus();
    else this.titleEl.blur();
  }

  override updateHeader() {
    super.updateHeader();
    this.titleParentEl.empty();
    const parent = this.file?.parent;
    if (parent && !parent.isRoot()) {
      const segs = parent.path.split("/");
      segs.forEach((seg) => {
        this.titleParentEl.createSpan({ cls: "view-header-breadcrumb", text: seg });
        this.titleParentEl.createSpan({ cls: "view-header-breadcrumb-separator", text: "/" });
      });
    }
    this.leaf.updateHeader();
  }

  override getState(): Record<string, unknown> {
    return { file: this.file ? this.file.path : null };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    const path = state && typeof state.file === "string" ? state.file : null;
    const file = path ? this.app.vault.getFileByPath(path) : null;
    if (file && file !== this.file) {
      await this.loadFile(file);
      result.history = true;
    } else if (!file && !this.allowNoFile && path) {
      // A layout can name a file that has since gone. Show nothing rather than throwing.
      this.file = null;
    }
    this.updateHeader();
  }

  // internal
  async loadFile(file: TFile) {
    if (this.file) await this.onUnloadFile(this.file);
    this.file = file;
    await this.onLoadFile(file);
    this.updateHeader();
    this.app.workspace.onFileOpenInLeaf?.(this.leaf, file);
  }

  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}

  async onRename(_file: TFile): Promise<void> {
    this.updateHeader();
    this.app.workspace.requestSaveLayout();
  }

  canAcceptExtension(_extension: string): boolean {
    return false;
  }

  override onPaneMenu(menu: Menu, source: string): void {
    const file = this.file;
    if (file) {
      this.app.workspace.trigger("file-menu", menu, file, source, this.leaf);
    }
    super.onPaneMenu(menu, source);
  }
}

export abstract class EditableFileView extends FileView {}

/**
 * `requestSave` debounce: a save 1.5 s after typing pauses, and at least every
 * 2 s while typing continues (a plain resetting debounce postponed the write
 * for as long as the user kept typing).
 */
function boundedDebounce(fn: () => void, idleMs: number, maxWaitMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let first = 0;
  const fire = () => {
    timer = null;
    first = 0;
    fn();
  };
  const call = () => {
    const now = Date.now();
    if (!first) first = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, Math.max(0, Math.min(idleMs, first + maxWaitMs - now)));
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    first = 0;
  };
  return call;
}

const RETRY_DELAYS = [1000, 5000, 30000];

/**
 * A view over one text file (Markdown, and community views such as Kanban).
 *
 * Saving never loses text silently (see vault/safety.ts):
 * - `lastSavedData` and `dirty` change only after a write resolves; a failed
 *   write keeps the buffer dirty, is reported, and retries with backoff.
 * - The buffer remembers the disk version it is based on (`safetyBase`). A save
 *   checks the file first and merges three ways if it moved on; an outside
 *   change that arrives while the buffer is dirty is merged into the editor at
 *   once. A conflict writes nothing and shows a banner to compare and choose.
 * - A file deleted underneath unsaved edits keeps its tab, with Restore/Discard.
 * - A file that is not UTF-8 opens read-only and is never written.
 */
export abstract class TextFileView extends EditableFileView {
  data = "";
  requestSave: () => void;
  // internal
  dirty = false;
  // internal
  lastSavedData: string | null = null;
  // internal (data safety): the disk version the buffer is based on
  safetyBase: SaveBase | null = null;
  // internal (data safety)
  safetySaving = false;
  // internal (data safety): the last failed write's error, while retrying
  safetySaveError: unknown = null;
  // internal (data safety): the disk changed the same lines as the buffer
  safetyConflict: { theirs: string; theirsBase: SaveBase } | null = null;
  // internal (data safety): the file was deleted outside the app with unsaved edits
  safetyDeletedPath: string | null = null;
  // internal (data safety): "encoding" when the file is not UTF-8 and must not be written
  safetyReadOnly: string | null = null;
  private safetyChain: Promise<void> = Promise.resolve();
  private safetyRetryTimer: number | null = null;
  private safetyRetryCount = 0;
  private safetyBannerEl: HTMLElement | null = null;
  private safetyDebouncer: ReturnType<typeof boundedDebounce>;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.safetyDebouncer = boundedDebounce(() => void this.save(), 1500, 2000);
    this.requestSave = () => {
      this.dirty = true;
      this.safetyDebouncer();
      this.app.vault.safety?.onDirty(this);
    };
  }

  override onload(): void {
    super.onload();
    this.registerEvent(
      this.app.vault.on("modify", (f: TAbstractFile) => {
        if (f !== this.file) return;
        this.safetyEnqueue(() => this.safetySyncFromDisk());
      }),
    );
  }

  private safetyEnqueue(task: () => Promise<void>): Promise<void> {
    const run = this.safetyChain.then(task);
    this.safetyChain = run.catch((e) => console.error(e));
    return this.safetyChain;
  }

  /** Buffer text differs from what was last read or written. */
  private safetyHasUnsavedText(): boolean {
    return this.lastSavedData !== null && normalizeEol(this.getViewData()) !== normalizeEol(this.lastSavedData);
  }

  private safetyBaseFor(file: TFile): SaveBase {
    return this.safetyBase ?? { text: normalizeEol(this.lastSavedData ?? ""), mtime: file.stat.mtime, size: file.stat.size };
  }

  /** The file changed on disk (an outside edit, a plugin write, another tab or pane). */
  private async safetySyncFromDisk(): Promise<void> {
    const file = this.file;
    if (!file || file.deleted || this.safetyDeletedPath) return;
    let raw: string;
    try {
      raw = await this.app.vault.read(file);
    } catch {
      return;
    }
    if (this.file !== file) return;
    const vault = this.app.vault;
    const disk = normalizeEol(raw);
    const diskBase: SaveBase = { text: disk, mtime: file.stat.mtime, size: file.stat.size };
    const current = normalizeEol(this.getViewData());
    if (this.safetyConflict) {
      if (disk === current) {
        this.safetyConflict = null;
        this.safetyAdoptDisk(file, raw, diskBase);
      } else if (disk !== this.safetyConflict.theirs) {
        await vault.snapshot(file.path, disk);
        this.safetyConflict = { theirs: disk, theirsBase: diskBase };
      }
      this.renderSafetyBanner();
      vault.safety?.render();
      return;
    }
    if (this.safetyBase && disk === this.safetyBase.text) {
      // Our own write (or an outside touch that changed nothing).
      this.safetyBase = diskBase;
      return;
    }
    if (disk === current) {
      this.safetyAdoptDisk(file, raw, diskBase);
      return;
    }
    if (typeof (this as { applyMirroredUpdate?: unknown }).applyMirroredUpdate === "function" && vault.safety?.isLocalWrite(file.path, disk)) {
      // A mirrored pane of this note saved an earlier state of this same buffer: nothing to merge.
      this.lastSavedData = raw;
      this.safetyBase = diskBase;
      this.dirty = true;
      this.requestSave();
      return;
    }
    if (!this.dirty && !this.safetyHasUnsavedText() && !this.safetySaveError) {
      this.lastSavedData = raw;
      this.safetyBase = diskBase;
      this.data = raw;
      this.setViewData(raw, false);
      return;
    }
    // Unsaved edits and an outside change: merge now, so the user sees it early.
    const baseText = this.safetyBaseFor(file).text;
    await vault.snapshot(file.path, disk);
    await vault.snapshot(file.path, current);
    if (this.file !== file) return;
    const m = merge3(baseText, current, disk);
    if (!m.clean || (disk.trim() === "" && baseText.trim() !== "") || !canAutoMerge(file)) {
      this.safetyEnterConflict(file, disk, diskBase);
      return;
    }
    const now = normalizeEol(this.getViewData());
    const next = now === current ? m.text : merge3(current, now, m.text).text;
    this.lastSavedData = raw;
    this.safetyBase = diskBase;
    if (next !== now) this.setViewData(next, false);
    this.dirty = next !== disk;
    if (this.dirty) this.requestSave();
    vault.safety?.notifyMerged(file);
  }

  private safetyAdoptDisk(file: TFile, raw: string, base: SaveBase) {
    this.lastSavedData = raw;
    this.safetyBase = base;
    this.dirty = false;
    this.safetyClearError();
    this.app.vault.safety?.onSaved(this, file, base.text);
  }

  override async onLoadFile(file: TFile): Promise<void> {
    const data = await this.app.vault.read(file);
    const format = this.app.vault.adapter.codec?.get(file.path);
    this.safetyReadOnly = format && !format.valid ? "encoding" : null;
    this.safetyConflict = null;
    this.safetyDeletedPath = null;
    this.safetyClearError();
    this.data = data;
    this.lastSavedData = data;
    this.safetyBase = { text: normalizeEol(data), mtime: file.stat.mtime, size: file.stat.size };
    this.setViewData(data, true);
    this.dirty = false;
    this.safetySetReadOnly(!!this.safetyReadOnly);
    this.renderSafetyBanner();
    if (this.safetyReadOnly) {
      const { Notice } = await import("../ui/notice");
      new Notice(`“${file.name}” is not UTF-8 text. It is open read-only so its contents are not changed.`);
    }
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    await this.save();
    this.safetyHandOff(file);
    if (this.file === file) this.clear();
  }

  /**
   * The view is letting go of `file` (closing, or opening another file). Text
   * that could not be written goes to the app, which keeps retrying it.
   */
  private safetyHandOff(file: TFile) {
    this.safetyDebouncer.cancel();
    if (this.safetyRetryTimer !== null) clearTimeout(this.safetyRetryTimer);
    this.safetyRetryTimer = null;
    const safety = this.app.vault.safety;
    const text = normalizeEol(this.getViewData());
    if (!this.safetyReadOnly && !this.safetyDeletedPath && (this.safetyConflict || this.safetySaveError || this.safetyHasUnsavedText())) {
      safety?.adopt(file, text, this.safetyBase, this.safetyConflict ? this.safetyConflict.theirs : null);
    } else if (this.safetyDeletedPath && this.safetyHasUnsavedText()) {
      void this.app.vault.snapshot(this.safetyDeletedPath, text);
    }
    this.safetySaveError = null;
    this.safetyRetryCount = 0;
    this.safetyConflict = null;
    this.safetyDeletedPath = null;
    this.dirty = false;
    this.renderSafetyBanner();
    safety?.render();
  }

  async save(clear = false): Promise<void> {
    await this.safetyEnqueue(() => this.safetyDoSave());
    if (clear) this.clear();
  }

  private async safetyDoSave(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const data = this.getViewData();
    this.data = data;
    if (this.safetyReadOnly || this.safetyConflict || this.safetyDeletedPath) return;
    const safety = this.app.vault.safety;
    const text = normalizeEol(data);
    if (this.lastSavedData !== null && text === normalizeEol(this.lastSavedData)) {
      this.dirty = false;
      if (this.safetySaveError) this.safetyClearError();
      safety?.onSaved(this, file, text);
      return;
    }
    if (file.deleted) {
      this.safetyShowDeleted(file);
      return;
    }
    this.safetySaving = true;
    try {
      const out = await checkedWrite(this.app.vault, file, text, this.safetyBaseFor(file));
      if (out.kind === "deleted") {
        this.safetyShowDeleted(file);
        return;
      }
      if (out.kind === "conflict") {
        this.safetyEnterConflict(file, out.theirs, out.theirsBase);
        return;
      }
      this.safetyBase = out.base;
      this.lastSavedData = out.text;
      if (this.file === file) {
        const now = normalizeEol(this.getViewData());
        if (out.kind === "merged") {
          const next = now === text ? out.text : merge3(text, now, out.text).text;
          if (next !== now) this.setViewData(next, false);
          safety?.notifyMerged(file);
        }
        this.dirty = normalizeEol(this.getViewData()) !== out.text;
        if (this.dirty) this.requestSave();
      }
      this.safetyClearError();
      safety?.onSaved(this, file, out.text);
    } catch (e) {
      this.dirty = true;
      this.safetySaveError = e;
      const delay = RETRY_DELAYS[Math.min(this.safetyRetryCount, RETRY_DELAYS.length - 1)]!;
      this.safetyRetryCount++;
      if (this.safetyRetryTimer !== null) clearTimeout(this.safetyRetryTimer);
      this.safetyRetryTimer = window.setTimeout(() => {
        this.safetyRetryTimer = null;
        void this.save();
      }, delay);
      safety?.onSaveFailed(this, file, e, delay);
    } finally {
      this.safetySaving = false;
    }
  }

  private safetyClearError() {
    if (this.safetyRetryTimer !== null) clearTimeout(this.safetyRetryTimer);
    this.safetyRetryTimer = null;
    this.safetyRetryCount = 0;
    this.safetySaveError = null;
  }

  private safetyEnterConflict(file: TFile, theirs: string, theirsBase: SaveBase) {
    this.safetyConflict = { theirs, theirsBase };
    this.dirty = true;
    this.safetyDebouncer.cancel();
    this.renderSafetyBanner();
    const safety = this.app.vault.safety;
    safety?.onDirty(this);
    safety?.render();
    // A visible note already shows the banner (and the status bar says "Conflict"); a notice
    // on top would sit over the banner's buttons. Only announce conflicts in notes off screen.
    if (this.containerEl.isConnected && this.containerEl.offsetParent !== null) return;
    void import("../ui/notice").then(({ Notice }) => {
      const frag = document.createDocumentFragment();
      frag.createDiv({ text: `“${file.basename}” changed outside the app on the lines you are editing. Nothing was overwritten.` });
      const compare = frag.createDiv({ cls: "vault-safety-notice-actions" }).createEl("button", { cls: "mod-cta", text: "Compare…" });
      const notice = new Notice(frag, 6000);
      notice.containerEl.addClass("vault-conflict-notice");
      compare.addEventListener("click", (evt) => {
        evt.stopPropagation();
        notice.hide();
        this.safetyOpenConflict();
      });
    });
  }

  // internal (data safety): open the compare modal for the current conflict
  safetyOpenConflict() {
    const c = this.safetyConflict;
    const file = this.file;
    if (!c || !file) return;
    void import("../vault/safety-ui").then(({ ConflictModal }) =>
      new ConflictModal(this.app, {
        title: `“${file.basename}” changed on disk`,
        description: "The file was changed outside the app on the same lines as your unsaved edits. Choose what to keep. Both versions are also kept in File recovery.",
        path: file.path,
        theirs: c.theirs,
        mine: normalizeEol(this.getViewData()),
        allowBoth: canAutoMerge(file),
        onChoose: (choice) => this.safetyResolveConflict(choice),
      }).open(),
    );
  }

  // internal (data safety)
  async safetyResolveConflict(choice: "mine" | "theirs" | "both"): Promise<void> {
    const c = this.safetyConflict;
    const file = this.file;
    if (!c || !file) return;
    const vault = this.app.vault;
    const current = normalizeEol(this.getViewData());
    await vault.snapshot(file.path, c.theirs);
    await vault.snapshot(file.path, current);
    const baseText = this.safetyBase?.text ?? "";
    this.safetyConflict = null;
    this.safetyBase = c.theirsBase;
    this.lastSavedData = c.theirs;
    if (choice === "theirs") {
      this.setViewData(c.theirs, false);
      this.dirty = false;
      vault.safety?.onSaved(this, file, c.theirs);
    } else {
      const text = choice === "mine" ? current : merge3(baseText, current, c.theirs).bothText;
      if (text !== current) this.setViewData(text, false);
      this.dirty = true;
    }
    this.renderSafetyBanner();
    vault.safety?.render();
    if (choice !== "theirs") await this.save();
  }

  private safetyShowDeleted(file: TFile) {
    if (this.safetyDeletedPath) return;
    this.safetyDeletedPath = file.path;
    this.dirty = true;
    this.safetyDebouncer.cancel();
    this.safetyClearError();
    void this.app.vault.snapshot(file.path, normalizeEol(this.getViewData()));
    this.renderSafetyBanner();
    this.app.vault.safety?.render();
  }

  override async onDelete(file: TFile) {
    const unsaved = !this.safetyReadOnly && (this.dirty || !!this.safetyConflict || !!this.safetySaveError || this.safetyHasUnsavedText());
    if (!unsaved) {
      this.safetyClearError();
      return super.onDelete(file);
    }
    this.safetyShowDeleted(file);
  }

  // internal (data safety): write the buffer back to the path it was deleted from
  async safetyRestoreDeleted(): Promise<void> {
    const path = this.safetyDeletedPath;
    if (!path) return;
    const vault = this.app.vault;
    const text = this.getViewData();
    try {
      let file = vault.getFileByPath(path);
      let base: SaveBase;
      if (!file) {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
        file = await vault.create(path, text);
        base = { text: normalizeEol(text), mtime: file!.stat.mtime, size: file!.stat.size };
      } else {
        // Recreated meanwhile: merge against an empty base, which asks when both have text.
        base = { text: "", mtime: -1, size: -1 };
      }
      this.safetyDeletedPath = null;
      this.file = file;
      this.safetyBase = base;
      this.lastSavedData = base.mtime === -1 ? "" : text;
      this.dirty = base.mtime === -1;
      this.updateHeader();
      this.app.workspace.requestSaveLayout?.();
      this.renderSafetyBanner();
      if (this.dirty) await this.save();
      else vault.safety?.onSaved(this, file!, normalizeEol(text));
    } catch (e) {
      const { Notice } = await import("../ui/notice");
      new Notice(`Could not restore “${path}”: ${(e as Error).message ?? e}`);
    }
  }

  // internal (data safety): the user does not want the deleted file's text
  async safetyDiscardDeleted(): Promise<void> {
    const path = this.safetyDeletedPath;
    if (!path) return;
    await this.app.vault.safety?.journal.discard(path);
    this.safetyDeletedPath = null;
    this.dirty = false;
    this.lastSavedData = this.getViewData();
    this.renderSafetyBanner();
    this.app.vault.safety?.render();
    this.file = null;
    this.leaf.detach();
  }

  // internal (data safety): make the editor read-only (MarkdownView overrides)
  safetySetReadOnly(_readOnly: boolean): void {}

  // internal (data safety)
  renderSafetyBanner() {
    this.safetyBannerEl?.remove();
    this.safetyBannerEl = null;
    const file = this.file;
    if (!file) return;
    const safety = this.app.vault.safety;
    void import("../vault/safety-ui").then(({ renderBanner }) => {
      this.safetyBannerEl?.remove();
      this.safetyBannerEl = null;
      if (this.file !== file) return;
      if (this.safetyDeletedPath) {
        this.safetyBannerEl = renderBanner(this.contentEl, "deleted", `“${file.basename}” was deleted outside the app. Your text is still here.`, [
          { text: "Discard", onClick: () => void this.safetyDiscardDeleted() },
          { text: "Restore file", cta: true, onClick: () => void this.safetyRestoreDeleted() },
        ]);
      } else if (this.safetyConflict) {
        this.safetyBannerEl = renderBanner(this.contentEl, "conflict", `“${file.basename}” changed outside the app on the lines you are editing. Nothing has been overwritten.`, [
          { text: "Keep mine", onClick: () => void this.safetyResolveConflict("mine") },
          ...(canAutoMerge(file) ? [{ text: "Keep both", onClick: () => void this.safetyResolveConflict("both") }] : []),
          { text: "Compare…", cta: true, onClick: () => this.safetyOpenConflict() },
        ]);
      } else if (this.safetyReadOnly === "encoding") {
        this.safetyBannerEl = renderBanner(this.contentEl, "encoding", "This file is not UTF-8 text, so it is open read-only and will not be changed.", []);
      } else if (safety?.pendingRecovery?.(file.path)) {
        // Unsaved edits from an earlier session that the user put off in the recovery prompt.
        const path = file.path;
        this.safetyBannerEl = renderBanner(this.contentEl, "recovery", `This note has unsaved edits from an earlier session that were not restored.`, [
          { text: "Discard", onClick: () => void safety.discardPending(path) },
          { text: "Compare…", onClick: () => void safety.comparePending(path) },
          { text: "Restore", cta: true, onClick: () => void safety.restorePending(path) },
        ]);
      }
    });
  }

  override async onClose(): Promise<void> {
    const file = this.file;
    await this.save();
    if (file && this.file === file) this.safetyHandOff(file);
  }

  abstract getViewData(): string;
  abstract setViewData(data: string, clear: boolean): void;
  abstract clear(): void;
}

/** The view shown in a tab with nothing in it. */
export class EmptyView extends ItemView {
  getViewType() {
    return "empty";
  }
  getDisplayText() {
    return "New tab";
  }
  override async onOpen() {
    this.contentEl.addClass("empty-state");
    const container = this.contentEl.createDiv({ cls: "empty-state-container" });
    container.createDiv({ cls: "empty-state-title", text: "No file is open" });
    const actions = container.createDiv({ cls: "empty-state-action-list" });
    // Platform key names, as Obsidian shows them: ⌘N on Apple platforms (macOS, iPhone, iPad), Ctrl+N elsewhere.
    const keyName = (hotkey: string) => (isMacPlatform() ? hotkey.replace(/^Mod\+/, "⌘") : hotkey.replace(/^Mod\+/, "Ctrl+"));
    const action = (text: string, hotkey: string, run: () => void) => {
      const el = actions.createDiv({ cls: "empty-state-action tappable", text: `${text} (${keyName(hotkey)})` });
      el.addEventListener("click", run);
    };
    action("Create new note", "Mod+N", () => this.app.commands.executeCommandById("file-explorer:new-file"));
    action("Go to file", "Mod+O", () => this.app.commands.executeCommandById("switcher:open"));
    action("See recent files", "Mod+O", () => this.app.commands.executeCommandById("switcher:open"));
    action("Close", "Mod+W", () => this.leaf.detach());
  }
}
