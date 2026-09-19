/**
 * Core plugin Random note (`random-note`): ribbon dice and "Open random note".
 * Picks any Markdown file other than the one already open. Mod-clicking the
 * ribbon icon opens it in a new tab (Mod+Alt: to the right).
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Keymap } from "../../obsidian/ui/keymap";
import { Notice } from "../../obsidian/ui/notice";
import type { TFile } from "../../obsidian/vault/files";

class RandomNotePlugin extends Plugin {
  instance!: any;

  override onload() {
    this.instance.openRandomNote = (newLeaf?: boolean | "tab" | "split" | "window") => this.openRandomNote(newLeaf ?? false);
    this.register(() => delete this.instance.openRandomNote);
    this.addCommand({
      id: "random-note",
      name: "Random note: Open random note",
      icon: "dice",
      callback: () => void this.openRandomNote(false),
    });
    this.addRibbonIcon("dice", "Open random note", (evt) => void this.openRandomNote(Keymap.isModEvent(evt)));
  }

  async openRandomNote(newLeaf: boolean | "tab" | "split" | "window") {
    const { vault, workspace, metadataCache } = this.app;
    const active = workspace.getActiveFile();
    let files: TFile[] = vault.getMarkdownFiles().filter((f: TFile) => !metadataCache.isUserIgnored?.(f.path));
    if (files.length === 0) files = vault.getMarkdownFiles();
    if (files.length > 1 && active) files = files.filter((f) => f !== active);
    if (files.length === 0) {
      new Notice("There are no notes in this vault.");
      return;
    }
    const file = files[Math.floor(Math.random() * files.length)]!;
    await workspace.getLeaf(newLeaf).openFile(file, { active: true });
  }
}

export const randomNote: CorePluginDefinition = {
  id: "random-note",
  name: "Random note",
  description: "Open a random note from your vault.",
  icon: "dice",
  defaultOn: false,
  defaultOptions: {},
  create: (app) => new RandomNotePlugin(app, { id: "random-note", name: "Random note", version: "", minAppVersion: "", author: "", description: "" }),
};
