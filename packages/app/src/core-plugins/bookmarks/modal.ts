/**
 * The "Add bookmark" / "Edit bookmark" dialog: Title (optional), the field
 * that identifies the item (Path, Query or URL), and Bookmark group.
 */
import { Modal } from "../../obsidian/ui/modal";
import { Setting } from "../../obsidian/ui/setting";
import type { BookmarkItem } from "./model";
import { isDescendant, walkItems } from "./model";

export interface BookmarkHost {
  app: any;
  items: BookmarkItem[];
  getItemTitle(item: BookmarkItem): string;
}

export interface BookmarkModalResult {
  title: string;
  /** Path, query or URL, depending on the item type. */
  target: string;
  group: BookmarkItem | null;
}

interface Options {
  heading: string;
  /** The item being added or edited, or null when bookmarking several at once. */
  item: BookmarkItem | null;
  /** Current group of the item. */
  group: BookmarkItem | null;
  /** Ask for a name (bookmark all tabs / new group) instead of an item title. */
  nameLabel?: string;
  defaultName?: string;
  onSave(result: BookmarkModalResult): void;
}

export class BookmarkModal extends Modal {
  private titleValue = "";
  private targetValue = "";
  private groupValue: BookmarkItem | null;

  constructor(
    private host: BookmarkHost,
    private opts: Options,
  ) {
    super(host.app);
    this.groupValue = opts.group;
    this.modalEl.addClass("mod-bookmark");
    this.setTitle(opts.heading);
  }

  override onOpen(): void {
    const { item } = this.opts;
    const el = this.contentEl;
    el.empty();
    let firstInput: HTMLInputElement | null = null;
    const submitOnEnter = (input: HTMLInputElement) => {
      firstInput ??= input;
      input.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" && !evt.isComposing) {
          evt.preventDefault();
          this.save();
        }
      });
    };

    if (this.opts.nameLabel) {
      this.titleValue = this.opts.defaultName ?? "";
      new Setting(el).setName(this.opts.nameLabel).addText((t) => {
        t.setValue(this.titleValue).onChange((v) => (this.titleValue = v));
        submitOnEnter(t.inputEl);
      });
    } else if (item) {
      this.titleValue = item.title ?? "";
      new Setting(el)
        .setName("Title")
        .setDesc("Optional. Leave empty to use the default title.")
        .addText((t) => {
          t.setPlaceholder(this.host.getItemTitle({ ...item, title: undefined })).setValue(this.titleValue).onChange((v) => (this.titleValue = v));
          submitOnEnter(t.inputEl);
        });
      const field = item.type === "search" ? "Query" : item.type === "url" ? "URL" : item.type === "file" || item.type === "folder" ? "Path" : null;
      if (field) {
        this.targetValue = (item.type === "search" ? item.query : item.type === "url" ? item.url : (item.path ?? "") + (item.subpath ?? "")) ?? "";
        new Setting(el).setName(field).addText((t) => {
          t.setValue(this.targetValue).onChange((v) => (this.targetValue = v));
          submitOnEnter(t.inputEl);
        });
      }
    }

    // Groups, indented by depth; a group cannot move into itself.
    const groups: { item: BookmarkItem; label: string }[] = [];
    const collect = (items: BookmarkItem[], prefix: string) => {
      for (const g of items) {
        if (g.type !== "group" || (item && isDescendant(item, g))) continue;
        const label = prefix + this.host.getItemTitle(g);
        groups.push({ item: g, label });
        collect(g.items ?? [], label + " / ");
      }
    };
    collect(this.host.items, "");
    if (groups.length) {
      new Setting(el).setName("Bookmark group").addDropdown((d) => {
        d.addOption("-1", "None");
        groups.forEach((g, i) => d.addOption(String(i), g.label));
        const current = groups.findIndex((g) => g.item === this.groupValue);
        d.setValue(String(current));
        d.onChange((v) => (this.groupValue = groups[Number(v)]?.item ?? null));
      });
    }

    const buttons = this.modalEl.querySelector(".modal-button-container") ?? this.modalEl.createDiv({ cls: "modal-button-container" });
    buttons.empty();
    const save = buttons.createEl("button", { text: "Save", cls: "mod-cta" });
    save.addEventListener("click", () => this.save());
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    window.setTimeout(() => (firstInput as HTMLInputElement | null)?.select(), 0);
  }

  private save() {
    this.close();
    this.opts.onSave({ title: this.titleValue.trim(), target: this.targetValue.trim(), group: this.groupValue });
  }
}

/** All groups in the tree (for callers that need to validate a stored group). */
export function allGroups(items: BookmarkItem[]): BookmarkItem[] {
  const out: BookmarkItem[] = [];
  walkItems(items, (i) => {
    if (i.type === "group") out.push(i);
  });
  return out;
}
