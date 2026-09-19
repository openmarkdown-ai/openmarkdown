/**
 * File operations the explorer, its context menus and its commands share:
 * creating notes and folders, copying, moving, deleting, and validating names.
 * Every change goes through `app.vault` / `app.fileManager`, so link updates,
 * trash settings and vault events behave the same as for any other caller.
 */
import type { FuzzyMatch } from "obsidian";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { FuzzySuggestModal } from "../../obsidian/ui/suggest";
import { isMacPlatform } from "../../obsidian/ui/keymap";
import { normalizePath } from "../../obsidian/util";
import { TFile, TFolder, type TAbstractFile } from "../../obsidian/vault/files";

type PaneType = "tab" | "split" | "window" | boolean;

/** Characters the vault refuses in a name (Obsidian's non-Windows set). */
const INVALID_CHARS = /[\\/:]/;
/** Characters that are legal but break `[[links]]`. */
const LINK_UNSAFE_CHARS = /[#^[\]|]/;

/** Returns an error message, or null when the name can be used. Warns about link-unsafe names. */
export function validateName(name: string, isFolder: boolean): string | null {
  const what = isFolder ? "Folder name" : "File name";
  if (!name.trim()) return `${what} cannot be empty.`;
  if (name.startsWith(".")) return `${what} cannot start with a dot.`;
  if (INVALID_CHARS.test(name)) return `${what} cannot contain any of the following characters: \\ / :`;
  if (LINK_UNSAFE_CHARS.test(name)) new Notice("Links will not work with file names containing any of these characters: # ^ [ ] |");
  return null;
}

/** The path a child called `name` would have inside `folder`. */
export function childPath(folder: TFolder, name: string): string {
  return normalizePath(folder.isRoot() ? name : `${folder.path}/${name}`);
}

/**
 * Where "Create new note" puts a note, and which leaf opens it: a new tab,
 * unless the active tab is empty (then it is reused).
 */
export function leafForNewNote(app: any, newLeaf: PaneType | undefined) {
  if (newLeaf === undefined) {
    const active = app.workspace.activeLeaf;
    const reuse = active && active.getRoot() === app.workspace.rootSplit && active.view?.getViewType() === "empty";
    return app.workspace.getLeaf(reuse ? false : "tab");
  }
  return app.workspace.getLeaf(newLeaf);
}

/**
 * Open a freshly created file with its inline title focused for renaming.
 * The rename state is re-applied after the leaf activates, because activation
 * focuses the editor and would otherwise take the focus back from the title.
 */
export async function openForRename(leaf: any, file: TFile, rename: "all" | "end" = "all", state?: Record<string, unknown>): Promise<void> {
  await leaf.openFile(file, { ...(state ? { state } : {}), eState: { rename }, active: true });
  leaf.setEphemeralState({ rename });
}

/** Create `Untitled.md` (or `Untitled 1.md` …) in `folder` and open it with the inline title selected for renaming. */
export async function createNewNote(app: any, folder: TFolder, newLeaf?: PaneType): Promise<TFile | null> {
  try {
    const file: TFile = await app.fileManager.createNewMarkdownFile(folder, "Untitled");
    const leaf = leafForNewNote(app, newLeaf);
    await openForRename(leaf, file, "all", { mode: "source" });
    return file;
  } catch (e) {
    new Notice(String((e as Error).message ?? e));
    return null;
  }
}

/** Create a file of another type (canvas, base) in `folder` and open it. */
export async function createNewFileOfType(app: any, folder: TFolder, extension: string, data: string): Promise<TFile | null> {
  try {
    const file: TFile = await app.fileManager.createNewFile(folder, "Untitled", extension, data);
    await openForRename(app.workspace.getLeaf(false), file, "all");
    return file;
  } catch (e) {
    new Notice(String((e as Error).message ?? e));
    return null;
  }
}

/** Create an `Untitled` folder inside `parent`. */
export async function createNewFolder(app: any, parent: TFolder): Promise<TFolder | null> {
  try {
    const path = app.vault.getAvailablePath(childPath(parent, "Untitled"), "");
    return await app.vault.createFolder(path);
  } catch (e) {
    new Notice(String((e as Error).message ?? e));
    return null;
  }
}

/** "Make a copy": `Note 1.md` next to `Note.md`, opened. */
export async function duplicateFile(app: any, file: TFile, open = true): Promise<TFile | null> {
  const parent = file.parent ?? app.vault.getRoot();
  const target = app.vault.getAvailablePath(childPath(parent, file.basename), file.extension);
  try {
    const copy: TFile = await app.vault.copy(file, target);
    if (open) await app.workspace.getLeaf(false).openFile(copy, { active: true });
    return copy;
  } catch (e) {
    new Notice(String((e as Error).message ?? e));
    return null;
  }
}

/** Whether `file` may move into `folder` (not into itself, a descendant, or where it already is). */
export function canMoveInto(file: TAbstractFile, folder: TFolder): boolean {
  if (file.parent === folder) return false;
  if (file instanceof TFolder && (folder === file || folder.path.startsWith(file.path + "/"))) return false;
  return true;
}

/** Move files into a folder, keeping links up to date. Returns the number moved. */
export async function moveFiles(app: any, files: TAbstractFile[], folder: TFolder): Promise<number> {
  let moved = 0;
  // Moving a folder carries its contents; skip items already inside a moved folder.
  const roots = files.filter((f) => !files.some((o) => o !== f && o instanceof TFolder && f.path.startsWith(o.path + "/")));
  for (const file of roots) {
    if (!canMoveInto(file, folder)) continue;
    const target = childPath(folder, file.name);
    if (app.vault.getAbstractFileByPathInsensitive(target)) {
      new Notice(`“${file.name}” already exists in “${folder.isRoot() ? app.vault.getName() : folder.path}”.`);
      continue;
    }
    try {
      await app.fileManager.renameFile(file, target);
      moved++;
    } catch (e) {
      new Notice(String((e as Error).message ?? e));
    }
  }
  return moved;
}

/** Delete one file through `promptForDeletion`, or several after one confirmation. */
export async function deleteFiles(app: any, files: TAbstractFile[]): Promise<void> {
  const roots = files.filter((f) => !files.some((o) => o !== f && o instanceof TFolder && f.path.startsWith(o.path + "/")));
  if (roots.length === 0) return;
  if (roots.length === 1) {
    await app.fileManager.promptForDeletion(roots[0]);
    return;
  }
  const confirmed = app.vault.getConfig("promptDelete") === false || (await confirmMany(app, roots));
  if (!confirmed) return;
  for (const f of roots) {
    try {
      await app.fileManager.trashFile(f);
    } catch (e) {
      new Notice(String((e as Error).message ?? e));
    }
  }
}

function confirmMany(app: any, files: TAbstractFile[]): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const modal = new Modal(app);
    modal.setTitle(`Delete ${files.length} files`);
    const trash = app.vault.getConfig("trashOption");
    modal.contentEl.createEl("p", {
      text: `Are you sure you want to delete these ${files.length} files? ${trash === "none" ? "They will be permanently deleted." : "They will be moved to the trash."}`,
    });
    const list = modal.contentEl.createEl("ul");
    for (const f of files.slice(0, 10)) list.createEl("li", { text: f.path });
    if (files.length > 10) list.createEl("li", { text: `…and ${files.length - 10} more` });
    const buttons = modal.modalEl.createDiv({ cls: "modal-button-container" });
    const del = buttons.createEl("button", { text: "Delete", cls: "mod-warning" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
    del.addEventListener("click", () => {
      decided = true;
      modal.close();
      resolve(true);
    });
    modal.onClose = () => {
      if (!decided) resolve(false);
    };
    modal.open();
    del.focus();
  });
}

export async function copyText(text: string, what = "Path"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(`${what} copied to your clipboard`);
  } catch {
    new Notice("Could not access the clipboard.");
  }
}

/** `obsidian://open?vault=…&file=…` — the URL Obsidian's "Copy Obsidian URL" produces. */
export function obsidianUrl(app: any, file: TAbstractFile): string {
  const path = file instanceof TFile && file.extension === "md" ? file.path.slice(0, -3) : file.path;
  return `obsidian://open?vault=${encodeURIComponent(app.vault.getName())}&file=${encodeURIComponent(path)}`;
}

export const duplicateLabel = () => (isMacPlatform() ? "Duplicate" : "Make a copy");

// ---- "Move file to..." ----------------------------------------------------------------

/** Suggester of vault folders. ↵ moves; Shift+↵ creates the typed folder and moves there; Tab completes. */
export class MoveToFolderModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: any,
    private files: TAbstractFile[],
  ) {
    super(app);
    this.setPlaceholder("Type a folder");
    this.emptyStateText = "No folder found. Press shift ↵ to create it.";
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "tab", purpose: "to autocomplete folder" },
      { command: "↵", purpose: "to move" },
      { command: "shift ↵", purpose: "to create" },
      { command: "esc", purpose: "to dismiss" },
    ]);
    this.scope.register(["Shift"], "Enter", (evt) => {
      if (evt.isComposing) return;
      void this.createAndMove(this.inputEl.value);
      return false;
    });
    this.scope.register([], "Tab", () => {
      const selected = this.chooser.values?.[this.chooser.selectedItem];
      if (selected) {
        this.inputEl.value = selected.item.isRoot() ? "/" : selected.item.path + "/";
        this.onInput();
      }
      return false;
    });
  }

  override onOpen(): void {
    const title = this.files.length === 1 ? `Move “${this.files[0]!.name}” to…` : `Move ${this.files.length} items to…`;
    this.inputEl.setAttr("aria-label", title);
  }

  getItems(): TFolder[] {
    const folders: TFolder[] = this.app.vault.getAllFolders(true);
    return folders
      .filter((folder) => this.files.some((f) => canMoveInto(f, folder)))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  getItemText(folder: TFolder): string {
    return folder.isRoot() ? "/" : folder.path;
  }

  override renderSuggestion(match: FuzzyMatch<TFolder>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
  }

  override selectActiveSuggestion(evt: MouseEvent | KeyboardEvent): void {
    // Enter with nothing matching creates the folder, as Shift+Enter does.
    if (!this.chooser.hasValues() && this.inputEl.value.trim()) {
      void this.createAndMove(this.inputEl.value);
      return;
    }
    super.selectActiveSuggestion(evt);
  }

  onChooseItem(folder: TFolder): void {
    void moveFiles(this.app, this.files, folder);
  }

  private async createAndMove(raw: string) {
    const path = normalizePath(raw.trim());
    if (!path || path === "/") return;
    this.close();
    const vault = (this.app as any).vault;
    let folder = vault.getFolderByPath(path) as TFolder | null;
    if (!folder) {
      try {
        folder = await vault.createFolder(path);
      } catch (e) {
        new Notice(String((e as Error).message ?? e));
        return;
      }
    }
    if (folder) await moveFiles(this.app, this.files, folder);
  }
}
