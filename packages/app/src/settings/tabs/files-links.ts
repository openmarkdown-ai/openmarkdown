/**
 * Settings → Files and links (§6.4).
 *
 * `attachmentFolderPath` is one string that encodes four choices:
 * `/` vault folder, `./` same folder as the current file, `./<name>` a
 * subfolder under the current folder, anything else a fixed folder.
 * `openBehavior` is `""`, `"new"`, `"daily"` or `"file:<path>"`.
 */
import type { App } from "../../obsidian/app";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { ButtonComponent, Setting, TextComponent } from "../../obsidian/ui/setting";
import { AbstractInputSuggest } from "../../obsidian/ui/suggest";
import { confirmModal } from "../helpers";
import { AppSettingTab } from "../tab-base";

export type AttachmentChoice = "root" | "current" | "subfolder" | "folder";

export function decodeAttachmentPath(value: unknown): { choice: AttachmentChoice; name: string } {
  const v = String(value ?? "/");
  if (v === "" || v === "/") return { choice: "root", name: "" };
  if (v === "." || v === "./") return { choice: "current", name: "" };
  if (v.startsWith("./")) return { choice: "subfolder", name: v.slice(2) };
  return { choice: "folder", name: v };
}

export function encodeAttachmentPath(choice: AttachmentChoice, name: string): string {
  const clean = name.trim().replace(/^\/+|\/+$/g, "");
  switch (choice) {
    case "root":
      return "/";
    case "current":
      return "./";
    case "subfolder":
      return `./${clean || "attachments"}`;
    case "folder":
      return clean || "/";
  }
}

/** Suggests vault paths (folders or files) under a text input. */
export class PathSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private kind: "folder" | "file",
    private onPick: (path: string) => void,
  ) {
    super(app, inputEl);
  }

  protected getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    const vault = this.app.vault;
    const paths = this.kind === "folder" ? vault.getAllFolders(false).map((f) => f.path) : vault.getFiles().map((f) => f.path);
    return paths.filter((p) => p.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b)).slice(0, 200);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  override selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
    this.setValue(value);
    this.onPick(value);
    this.close();
  }
}

export class FilesLinksSettingTab extends AppSettingTab {
  constructor(app: App) {
    super(app, "file", "Files and links", "lucide-folder-open");
  }

  render(el: HTMLElement): void {
    const app = this.app;
    const general = this.group(el);

    // Default file to open
    const openBehavior = String(this.getConfig("openBehavior") ?? "");
    const dailyOn = !!app.internalPlugins.getEnabledPluginById("daily-notes");
    const openChoice = openBehavior.startsWith("file:") ? "file" : openBehavior;
    const openOptions: Record<string, string> = { "": "Last opened", new: "New note", file: "Specific file" };
    if (dailyOn || openChoice === "daily") openOptions.daily = "Daily note";
    this.row(general, "Default file to open", "Choose what to show when the vault opens.").addDropdown((d) =>
      d
        .addOptions(openOptions)
        .setValue(openChoice)
        .onChange((v) => {
          const current = String(this.getConfig("openBehavior") ?? "");
          this.setConfig("openBehavior", v === "file" ? (current.startsWith("file:") ? current : "file:") : v);
          this.rerender();
        }),
    );
    if (openChoice === "file") {
      this.row(general, "File to open", "The file shown when the vault opens.").addText((t) => {
        t.setPlaceholder("Example: Home.md").setValue(openBehavior.slice(5));
        const save = (v: string) => this.setConfig("openBehavior", `file:${v.trim()}`);
        t.onChange(save);
        new PathSuggest(app, t.inputEl, "file", save);
      });
    }

    // New notes
    const newFileLocation = String(this.getConfig("newFileLocation") ?? "root");
    this.dropdown(general, "Default location for new notes", "Where newly created notes are placed. Plugins may override this.", "newFileLocation", {
      root: "Vault folder",
      current: "Same folder as current file",
      folder: "In the folder specified below",
    }, () => this.rerender());
    if (newFileLocation === "folder") {
      this.row(general, "Folder to create new notes in", "Newly created notes will appear under this folder.").addText((t) => {
        t.setPlaceholder("Example: folder 1/folder 2").setValue(String(this.getConfig("newFileFolderPath") ?? ""));
        const save = (v: string) => this.setConfig("newFileFolderPath", v.trim());
        t.onChange(save);
        new PathSuggest(app, t.inputEl, "folder", save);
      });
    }

    // Links
    this.dropdown(general, "New link format", "What links to insert when auto-generating internal links.", "newLinkFormat", {
      shortest: "Shortest path when possible",
      relative: "Relative path to file",
      absolute: "Absolute path in vault",
    });
    this.row(general, "Use [[Wikilinks]]", "Auto-generate Wikilinks for [[links]] and ![[images]] instead of Markdown links and images. Turn this off to generate Markdown links instead.").addToggle((t) =>
      t.setValue(!this.getConfig("useMarkdownLinks")).onChange((v) => this.setConfig("useMarkdownLinks", !v)),
    );
    this.toggle(general, "Automatically update internal links", "When you rename a file, update the links to it without asking.", "alwaysUpdateLinks");

    // Attachments
    const attachment = decodeAttachmentPath(this.getConfig("attachmentFolderPath"));
    this.row(general, "Default location for new attachments", "Where newly added attachments are placed.").addDropdown((d) =>
      d
        .addOptions({
          root: "Vault folder",
          folder: "In the folder specified below",
          current: "Same folder as current file",
          subfolder: "In subfolder under current folder",
        })
        .setValue(attachment.choice)
        .onChange((v) => {
          const choice = v as AttachmentChoice;
          const name = choice === attachment.choice ? attachment.name : choice === "subfolder" ? "attachments" : "";
          this.setConfig("attachmentFolderPath", encodeAttachmentPath(choice, name));
          this.rerender();
        }),
    );
    if (attachment.choice === "subfolder") {
      this.row(general, "Subfolder name", "If your file is under \"vault/folder\", and you set subfolder name to \"attachments\", attachments will be saved to \"vault/folder/attachments\".").addText((t) =>
        t
          .setPlaceholder("attachments")
          .setValue(attachment.name)
          .onChange((v) => this.setConfig("attachmentFolderPath", encodeAttachmentPath("subfolder", v))),
      );
    } else if (attachment.choice === "folder") {
      this.row(general, "Attachment folder path", "Place newly created attachment files, such as images created via drag and drop, in this folder.").addText((t) => {
        t.setPlaceholder("Example: folder 1/folder 2").setValue(attachment.name);
        const save = (v: string) => this.setConfig("attachmentFolderPath", encodeAttachmentPath("folder", v));
        t.onChange(save);
        new PathSuggest(app, t.inputEl, "folder", save);
      });
    }
    this.toggle(general, "Show all file types", "Show files with any extension, even if the app can't open them natively, so that you can link to them and see them in the File explorer and Quick switcher.", "showUnsupportedFiles");

    // W5 Knowledge: note titles and link tabs (core-plugins/file-explorer/note-titles.ts, core-plugins/switcher/link-tabs.ts)
    const titleSource = String(this.getConfig("displayTitle") ?? "filename");
    this.row(general, "Show note title from", "What the file explorer, tabs, quick switcher, search and backlinks show for a note. Files are not renamed.").addDropdown((d) =>
      d
        .addOptions({ filename: "File name", property: "Title property", heading: "First heading" })
        .setValue(titleSource === "property" || titleSource === "heading" ? titleSource : "filename")
        .onChange((v) => {
          this.setConfig("displayTitle", v === "filename" ? undefined : v);
          this.rerender();
        }),
    );
    if (titleSource === "property") {
      this.row(general, "Title property", "The property that holds a note's title. Front Matter Title uses \"title\".").addText((t) =>
        t
          .setPlaceholder("title")
          .setValue(String(this.getConfig("displayTitleProperty") ?? ""))
          .onChange((v) => this.setConfig("displayTitleProperty", v.trim() || undefined)),
      );
    }
    this.toggle(general, "Open links in a new tab", "Clicking an internal link opens the note in a new tab, or switches to its tab if it is already open.", "openLinksInNewTab");

    // Trash
    const trash = this.group(el, "Trash");
    this.toggle(trash, "Confirm before deleting files", "Show a confirmation dialog when deleting a file.", "promptDelete");
    this.dropdown(trash, "Deleted files", "What happens to a file after you delete it. A browser page cannot reach the system trash, so that option uses the vault's .trash folder.", "trashOption", {
      system: "Move to system trash",
      local: "Move to vault trash (.trash folder)",
      none: "Permanently delete",
    });
    this.dropdown(trash, "Delete attachments when deleting files", "Whether attachments only used by a deleted file are deleted with it.", "deleteUnlinkedAttachments", {
      always: "Always",
      ask: "Ask each time",
      never: "Never",
    });

    // Advanced
    const advanced = this.group(el, "Advanced");
    const filters = (this.getConfig<string[] | null>("userIgnoreFilters") ?? []).length;
    this.row(advanced, "Excluded files", `Excluded files will be hidden in Search, Graph view, and Unlinked mentions, less noticeable in Quick switcher and link suggestions. ${filters ? `${filters} excluded.` : ""}`.trim()).addButton((b) =>
      b.setButtonText("Manage").onClick(() => new ExcludedFilesModal(app, () => this.rerender()).open()),
    );
    const configKey = "config-dir";
    this.row(advanced, "Override config folder", "Use a different folder for this device's settings. Must start with a dot. Takes effect after a reload.").addText((t) => {
      t.setPlaceholder(".obsidian").setValue(String(app.loadLocalStorage(configKey) ?? ""));
      t.onChange((v) => {
        const value = v.trim();
        if (value && !value.startsWith(".")) {
          t.inputEl.setCustomValidity("The folder name must start with a dot.");
          t.inputEl.reportValidity();
          return;
        }
        t.inputEl.setCustomValidity("");
        app.saveLocalStorage(configKey, value && value !== ".obsidian" ? value : null);
      });
    });
    this.toggle(advanced, "Allow URI callbacks", "Allow x-callback-url \"x-success\" and \"x-error\" parameters in obsidian:// links to open other apps and sites.", "uriCallbacks");
    this.row(advanced, "Rebuild vault cache", "Rebuild the metadata index of every note, then reload. Use this if links, tags or search results look out of date.").addButton((b) =>
      b.setButtonText("Rebuild").onClick(async () => {
        const ok = await confirmModal(app, {
          title: "Rebuild vault cache",
          message: "The app will reload and re-index every file in this vault. This can take a while for large vaults.",
          cta: "Rebuild and reload",
        });
        if (!ok) return;
        new Notice("Rebuilding vault cache…");
        const cache = app.metadataCache as unknown as { clear?: () => unknown };
        try {
          await cache.clear?.();
        } catch (e) {
          console.error(e);
        }
        location.reload();
      }),
    );
  }
}

/** Manage `userIgnoreFilters`: paths and `/regex/` patterns. */
export class ExcludedFilesModal extends Modal {
  private filters: string[];

  constructor(
    app: App,
    private onDone: () => void,
  ) {
    super(app);
    this.filters = [...((app.vault.getConfig("userIgnoreFilters") as string[] | null) ?? [])];
    this.modalEl.addClass("vault-excluded-files-modal");
    this.setTitle("Excluded files");
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.onDone();
  }

  private save() {
    this.app.vault.setConfig("userIgnoreFilters", this.filters.length ? this.filters : null);
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { cls: "setting-item-description", text: "Files matching these paths or regular expressions (written as /pattern/) are excluded." });
    const list = contentEl.createDiv({ cls: "vault-excluded-files-list" });
    if (!this.filters.length) list.createDiv({ cls: "vault-empty-state", text: "No excluded files." });
    this.filters.forEach((filter, i) => {
      new Setting(list).setName(filter).addExtraButton((b) =>
        b
          .setIcon("lucide-x")
          .setTooltip("Remove")
          .onClick(() => {
            this.filters.splice(i, 1);
            this.save();
            this.render();
          }),
      );
    });
    const add = contentEl.createDiv({ cls: "vault-excluded-files-add" });
    const input = new TextComponent(add).setPlaceholder("Enter path or /regex/");
    new PathSuggest(this.app, input.inputEl, "folder", () => {});
    const commit = () => {
      const value = input.getValue().trim();
      if (!value) return;
      if (/^\/.*\/[a-z]*$/.test(value) && value.length > 2) {
        try {
          new RegExp(value.slice(1, value.lastIndexOf("/")));
        } catch {
          new Notice("That regular expression is not valid.");
          return;
        }
      }
      if (!this.filters.includes(value)) this.filters.push(value);
      this.save();
      this.render();
      (contentEl.querySelector(".vault-excluded-files-add input") as HTMLInputElement | null)?.focus();
    };
    new ButtonComponent(add).setButtonText("Add").setCta().onClick(commit);
    input.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.isComposing) {
        evt.preventDefault();
        commit();
      }
    });
  }
}
