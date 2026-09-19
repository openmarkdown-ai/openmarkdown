/**
 * The file explorer's tree items. Their DOM is Obsidian's, because themes style
 * it and plugins (Iconize, File Color, Folder Notes …) reach into
 * `view.fileItems[path].selfEl` / `.innerEl` / `.el` to decorate rows:
 *
 *   .tree-item.nav-folder[.is-collapsed][.mod-root]
 *     .tree-item-self.nav-folder-title.is-clickable.mod-collapsible[data-path][draggable]
 *       .tree-item-icon.collapse-icon.nav-folder-collapse-indicator[.is-collapsed] > svg.right-triangle
 *       .tree-item-inner.nav-folder-title-content
 *     .tree-item-children.nav-folder-children
 *   .tree-item.nav-file
 *     .tree-item-self.nav-file-title.tappable.is-clickable[data-path][draggable]
 *       .tree-item-inner.nav-file-title-content
 *       .nav-file-tag                                  (non-Markdown files)
 */
import { setIcon } from "../../obsidian/ui/icons";
import type { TAbstractFile, TFile, TFolder } from "../../obsidian/vault/files";

export abstract class ExplorerItem<F extends TAbstractFile = TAbstractFile> {
  file: F;
  el: HTMLElement;
  selfEl: HTMLElement;
  innerEl: HTMLElement;
  parent: FolderItem | null = null;

  constructor(file: F, el: HTMLElement, selfEl: HTMLElement, innerEl: HTMLElement) {
    this.file = file;
    this.el = el;
    this.selfEl = selfEl;
    this.innerEl = innerEl;
  }

  // Older plugins use the pre-1.0 names.
  get titleEl(): HTMLElement {
    return this.selfEl;
  }
  get titleInnerEl(): HTMLElement {
    return this.innerEl;
  }

  abstract updateTitle(): void;

  /** Keep `data-path` in step after a rename or move. */
  updatePath(): void {
    this.selfEl.setAttr("data-path", this.file.path);
    this.updateTitle();
  }
}

export class FileItem extends ExplorerItem<TFile> {
  tagEl: HTMLElement | null = null;
  // internal: the note's display title (Settings → Files and links → Show note title from), null for the file name
  titleOf: ((file: TFile) => string | null) | null;

  constructor(file: TFile, titleOf: ((file: TFile) => string | null) | null = null) {
    const el = createDiv({ cls: "tree-item nav-file" });
    const selfEl = el.createDiv({
      cls: "tree-item-self nav-file-title tappable is-clickable",
      attr: { "data-path": file.path, draggable: "true" },
    });
    const innerEl = selfEl.createDiv({ cls: "tree-item-inner nav-file-title-content" });
    super(file, el, selfEl, innerEl);
    this.titleOf = titleOf;
    this.updateTitle();
  }

  updateTitle(): void {
    const file = this.file;
    const isMarkdown = file.extension === "md";
    // The title is the basename (or the note's display title); a non-Markdown file shows its extension as a tag.
    const title = isMarkdown ? (this.titleOf?.(file) ?? null) : null;
    this.innerEl.setText(title ?? file.basename);
    this.el.toggleClass("vault-has-display-title", title !== null);
    if (title !== null) this.innerEl.setAttr("data-file-name", file.basename);
    else this.innerEl.removeAttribute("data-file-name");
    if (!isMarkdown && file.extension) {
      this.tagEl ??= this.selfEl.createDiv({ cls: "nav-file-tag" });
      this.tagEl.setText(file.extension);
    } else if (this.tagEl) {
      this.tagEl.remove();
      this.tagEl = null;
    }
  }
}

export class FolderItem extends ExplorerItem<TFolder> {
  collapseEl: HTMLElement;
  childrenEl: HTMLElement;
  collapsed = true;
  /** The child items in display order (only meaningful once rendered). */
  vChildren: ExplorerItem[] = [];
  // internal: set by the view so `setCollapsed` re-renders
  owner: { setCollapsed(item: FolderItem, collapsed: boolean): void } | null = null;

  constructor(folder: TFolder) {
    const isRoot = folder.isRoot();
    const el = createDiv({ cls: isRoot ? "tree-item nav-folder mod-root" : "tree-item nav-folder is-collapsed" });
    const selfEl = el.createDiv({
      cls: "tree-item-self nav-folder-title" + (isRoot ? "" : " is-clickable mod-collapsible"),
      attr: { "data-path": folder.path, ...(isRoot ? {} : { draggable: "true" }) },
    });
    const collapseEl = createDiv({ cls: "tree-item-icon collapse-icon nav-folder-collapse-indicator is-collapsed" });
    if (!isRoot) {
      selfEl.appendChild(collapseEl);
      setIcon(collapseEl, "right-triangle");
    }
    const innerEl = selfEl.createDiv({ cls: "tree-item-inner nav-folder-title-content" });
    super(folder, el, selfEl, innerEl);
    this.collapseEl = collapseEl;
    this.childrenEl = el.createDiv({ cls: "tree-item-children nav-folder-children" });
    this.collapsed = !isRoot;
    this.updateTitle();
  }

  updateTitle(): void {
    this.innerEl.setText(this.file.isRoot() ? this.file.vault.getName() : this.file.name);
  }

  /** Obsidian's API on folder items (used by plugins: folder notes, "collapse all" helpers). */
  async setCollapsed(collapsed: boolean, _animate = false): Promise<void> {
    if (this.owner) this.owner.setCollapsed(this, collapsed);
    else this.applyCollapsed(collapsed);
  }

  /** Toggle the classes only; the view renders or empties the children. */
  applyCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.el.toggleClass("is-collapsed", collapsed);
    this.collapseEl.toggleClass("is-collapsed", collapsed);
  }
}
