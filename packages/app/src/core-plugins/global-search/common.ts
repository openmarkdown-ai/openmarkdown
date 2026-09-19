/**
 * Pieces shared by the knowledge views: the `.nav-header` button row, the
 * search filter box, sort menus, and the base class of views that follow the
 * active file (Backlinks, Outgoing links, Outline, File properties, Footnotes).
 */
import type { ViewStateResult } from "obsidian";
import { addIcon, hasIcon, setIcon } from "../../obsidian/ui/icons";
import { Menu } from "../../obsidian/ui/menu";
import { SearchComponent } from "../../obsidian/ui/setting";
import { debounce } from "../../obsidian/util";
import { TFile, type TAbstractFile } from "../../obsidian/vault/files";
import type { WorkspaceLeaf } from "../../obsidian/workspace/leaf";
import { ItemView } from "../../obsidian/workspace/view";

const G = '<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">';

/** Obsidian's own (non-Lucide) icons for the link panes. */
export function ensureKnowledgeIcons() {
  if (!hasIcon("links-coming-in")) addIcon("links-coming-in", `${G}<path d="M40 22h-6a22 22 0 0 0 0 44h6"/><path d="M60 22h6a22 22 0 0 1 22 22"/><path d="M36 44h26"/><path d="M92 78H64"/><path d="M76 66L64 78l12 12"/></g>`);
  if (!hasIcon("links-going-out")) addIcon("links-going-out", `${G}<path d="M40 22h-6a22 22 0 0 0 0 44h6"/><path d="M60 22h6a22 22 0 0 1 22 22"/><path d="M36 44h26"/><path d="M62 78h28"/><path d="M78 66l12 12-12 12"/></g>`);
}

export class NavHeader {
  headerEl: HTMLElement;
  buttonsEl: HTMLElement;

  constructor(parentEl: HTMLElement, prepend = true) {
    this.headerEl = createDiv({ cls: "nav-header" });
    if (prepend) parentEl.prepend(this.headerEl);
    else parentEl.appendChild(this.headerEl);
    this.buttonsEl = this.headerEl.createDiv({ cls: "nav-buttons-container" });
  }

  addButton(icon: string, label: string, onClick: (evt: MouseEvent, el: HTMLElement) => void): HTMLElement {
    const el = this.buttonsEl.createDiv({ cls: "clickable-icon nav-action-button", attr: { "aria-label": label } });
    setIcon(el, icon);
    el.addEventListener("click", (evt) => onClick(evt, el));
    return el;
  }
}

export function setButtonState(el: HTMLElement, active: boolean, icon?: string, label?: string) {
  el.toggleClass("is-active", active);
  if (icon) setIcon(el, icon);
  if (label) el.setAttr("aria-label", label);
}

/** The `.search-input-container` filter row under a nav header. */
export class FilterBox {
  component: SearchComponent;
  el: HTMLElement;
  constructor(parentEl: HTMLElement, placeholder: string, onChange: (value: string) => void, wait = 200) {
    this.el = parentEl.createDiv({ cls: "search-row" });
    this.component = new SearchComponent(this.el);
    this.component.setPlaceholder(placeholder);
    const d = debounce((v: string) => onChange(v), wait, true);
    this.component.onChange((v) => d(v));
    this.component.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape" && this.component.getValue()) {
        evt.preventDefault();
        evt.stopPropagation();
        this.component.setValue("");
        onChange("");
      }
    });
  }
  show(visible: boolean) {
    this.el.toggle(visible);
  }
}

export function showSortMenu<T extends string>(evt: MouseEvent, options: [T, string][], current: T, onPick: (v: T) => void) {
  const menu = new Menu();
  for (const [value, label] of options) {
    menu.addItem((item) =>
      item
        .setTitle(label)
        .setChecked(value === current)
        .onClick(() => onPick(value)),
    );
  }
  menu.showAtMouseEvent(evt);
}

/**
 * A sidebar view about one file. Unlinked, it follows the active file; linked
 * (`leaf.group` set, "Open backlinks for the current note"), the workspace
 * pushes its partner's file through `setState({ file })`.
 */
export abstract class FileInfoView extends ItemView {
  file: TFile | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  // internal
  isLinked(): boolean {
    return !!this.leaf.group;
  }

  override async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        if (this.isLinked()) return;
        if (file) this.setFile(file);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.isLinked()) return;
        const f = this.app.workspace.getActiveFile();
        if (f && f !== this.file) this.setFile(f);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f: TAbstractFile) => {
        if (f === this.file) {
          this.leaf.updateHeader?.();
          this.onFileRenamed();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f: TAbstractFile) => {
        if (f === this.file) this.setFile(null);
      }),
    );
    if (!this.file && !this.isLinked()) {
      const f = this.app.workspace.getActiveFile();
      if (f) this.setFile(f);
      else this.onFileChanged();
    }
  }

  override getState(): Record<string, unknown> {
    return { file: this.file?.path ?? null };
  }

  override async setState(state: any, result: ViewStateResult): Promise<void> {
    if (state && typeof state.file === "string") {
      const f = this.app.vault.getFileByPath(state.file);
      if (f instanceof TFile && f !== this.file) this.setFile(f);
    }
    await super.setState(state, result);
  }

  setFile(file: TFile | null) {
    if (file === this.file) return;
    this.file = file;
    this.leaf.updateHeader?.();
    this.onFileChanged();
    this.app.workspace.requestSaveLayout?.();
  }

  onFileRenamed(): void {
    this.onFileChanged();
  }

  abstract onFileChanged(): void;
}

/** Opens a linked view of `type` beside the active note ("Open … for the current file"). */
export async function openLinkedView(app: any, type: string) {
  const active = app.workspace.activeLeaf as WorkspaceLeaf | null;
  const file = app.workspace.getActiveFile() as TFile | null;
  if (!active || !file) return;
  const leaf = app.workspace.getLeaf("split", "vertical") as WorkspaceLeaf;
  await leaf.setViewState({ type, state: { file: file.path }, active: false });
  leaf.setGroupMember(active);
  app.workspace.setActiveLeaf(active, { focus: true });
}

export async function showSideView(app: any, type: string, side: "left" | "right" = "right") {
  const leaf = await app.workspace.ensureSideLeaf(type, side, { active: true, reveal: true });
  return leaf as WorkspaceLeaf;
}

/** The view showing `file`: the linked partner of `leaf` first, then the active leaf, then the most recent. */
export function findViewForFile(app: any, leaf: WorkspaceLeaf | null, file: TFile | null): any {
  if (!file) return null;
  const ws = app.workspace;
  if (leaf?.group) {
    for (const l of ws.getGroupLeaves(leaf.group) as WorkspaceLeaf[]) {
      const v = l.view as any;
      if (l !== leaf && v?.file === file) return v;
    }
  }
  const active = ws.activeLeaf?.view as any;
  if (active?.file === file && active.getViewType?.() === "markdown") return active;
  let best: WorkspaceLeaf | null = null;
  ws.iterateRootLeaves((l: WorkspaceLeaf) => {
    const v = l.view as any;
    if (v?.file === file && (!best || l.activeTime > best.activeTime)) best = l;
  });
  return (best as WorkspaceLeaf | null)?.view ?? null;
}

/** Scrolls the note to `line` (and puts the cursor there in editing views), opening it if needed. */
export async function revealLine(app: any, leaf: WorkspaceLeaf | null, file: TFile, line: number, ch = 0) {
  const view = findViewForFile(app, leaf, file);
  if (!view) {
    await app.workspace.getLeaf(false).openFile(file, { active: true, eState: { line } });
    return;
  }
  const target = view.leaf as WorkspaceLeaf;
  app.workspace.setActiveLeaf(target, { focus: true });
  target.setEphemeralState({ line, focus: true });
  const mode = typeof view.getMode === "function" ? view.getMode() : "source";
  const editor = view.editor;
  if (editor && mode !== "preview") {
    try {
      const pos = { line, ch };
      editor.setCursor(pos);
      editor.scrollIntoView({ from: pos, to: pos }, true);
      editor.focus();
    } catch {
      /* the view handles eState itself */
    }
  }
}

/** Heading text as the outline shows it: inline Markdown syntax removed. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]*)\]\]/g, (_m, t: string) => t.replace(/#\^?/g, " > ").replace(/^ > /, ""))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/==(.+?)==/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/%%.*?%%/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}
