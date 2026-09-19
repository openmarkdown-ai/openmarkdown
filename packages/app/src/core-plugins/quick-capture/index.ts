/**
 * Quick capture (core plugin `quick-capture`).
 *
 * - Command **Quick capture: Open** (`quick-capture:open`, Mod+Alt+N) opens
 *   the capture sheet over the workspace.
 * - Command **Quick capture: Open in floating window**
 *   (`quick-capture:open-floating`) opens it in an always-on-top Document
 *   Picture-in-Picture window where the browser has one (Chromium 116+,
 *   Firefox 151+), else a small pop-up window, else the sheet.
 * - The URL `/?capture=1&vault=<name>&text=…&dest=daily|inbox|new` opens the
 *   same sheet as a page before the vault loads (boot.ts), and the manifest's
 *   "New quick note" shortcut, `note_taking.new_note_url` and the share target
 *   all land there. See docs/quick-capture.md.
 *
 * Settings: `.obsidian/quick-capture.json` (see `QuickCaptureOptions`).
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { PluginSettingTab } from "../../obsidian/ui/setting-tab";
import { Setting } from "../../obsidian/ui/setting";
import { moment } from "../../obsidian/util";
import { prepareWindow } from "../../obsidian/workspace/popout";
import { copyText } from "../../settings/helpers";
import {
  capture,
  DEFAULT_CAPTURE_OPTIONS,
  type CaptureAttachment,
  type CaptureDestination,
  type CaptureIO,
  type CaptureResult,
  type QuickCaptureOptions,
} from "./capture";
import { renderCaptureSurface } from "./surface";

export { capture, adapterIO, loadCaptureOptions, DEFAULT_CAPTURE_OPTIONS } from "./capture";
export { renderCaptureSurface } from "./surface";

/** Capture through the vault once it is loaded, through its adapter before that. */
export function vaultIO(app: any): CaptureIO {
  const vault = app.vault;
  const adapter = vault.adapter;
  const ready = () => !!app.workspace?.layoutReady;
  return {
    exists: (p) => adapter.exists(p),
    read: (p) => adapter.read(p),
    mkdir: async (p) => {
      if (ready() && !vault.getAbstractFileByPath(p)) await vault.createFolder(p).catch(() => adapter.mkdir(p));
      else await adapter.mkdir(p);
    },
    write: async (p, d) => {
      const file = ready() ? vault.getFileByPath(p) : null;
      if (file) await vault.modify(file, d);
      else if (ready() && !(await adapter.exists(p))) await vault.create(p, d);
      else await adapter.write(p, d);
    },
    writeBinary: async (p, d) => {
      if (ready() && !(await adapter.exists(p))) await vault.createBinary(p, d);
      else await adapter.writeBinary(p, d);
    },
    process: async (p, fn) => {
      const file = ready() ? vault.getFileByPath(p) : null;
      return file ? vault.process(file, fn) : adapter.process(p, fn);
    },
  };
}

export class QuickCapturePlugin extends Plugin {
  instance!: any;

  get options(): QuickCaptureOptions {
    return this.instance.options as QuickCaptureOptions;
  }

  override async onload() {
    // internal (a stable entry point for other code: share target, URIs)
    this.instance.capture = (text: string, o: { destination?: CaptureDestination; attachments?: CaptureAttachment[] } = {}) => this.capture(text, o);
    this.instance.openCapture = (initialText?: string) => this.openModal(initialText);

    this.addCommand({
      id: "quick-capture:open",
      name: "Quick capture: Open",
      icon: "lucide-zap",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "N" }],
      callback: () => this.openModal(),
    });
    this.addCommand({
      id: "quick-capture:open-floating",
      name: "Quick capture: Open in floating window",
      icon: "lucide-picture-in-picture-2",
      callback: () => void this.openFloating(),
    });
    this.addRibbonIcon("lucide-zap", "Quick capture", () => this.openModal());
    this.addSettingTab(new QuickCaptureSettingTab(this.app, this));
  }

  dailyConfig(): Record<string, unknown> | null {
    const wrapper = this.app.internalPlugins?.getPluginById?.("daily-notes");
    return wrapper?.enabled ? (wrapper.instance.options as Record<string, unknown>) : null;
  }

  async capture(text: string, o: { destination?: CaptureDestination; attachments?: CaptureAttachment[] } = {}): Promise<CaptureResult> {
    return capture(
      { io: vaultIO(this.app), configDir: this.app.vault.configDir, options: { ...DEFAULT_CAPTURE_OPTIONS, ...this.options }, daily: this.dailyConfig() as never },
      { text, attachments: o.attachments, destination: o.destination, now: moment() },
    );
  }

  openModal(initialText = "") {
    new QuickCaptureModal(this.app, this, initialText).open();
  }

  async openFloating() {
    const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
    let win: Window | null = null;
    try {
      if (dpip) win = await dpip.requestWindow({ width: 440, height: 320 });
    } catch (e) {
      console.warn("Document Picture-in-Picture refused", e);
    }
    if (!win) win = window.open("", "", "popup,width=440,height=340");
    if (!win) {
      new Notice("This browser blocked the floating window, so quick capture opened here.");
      this.openModal();
      return;
    }
    const w = win;
    prepareWindow(this.app, w, { title: "Quick capture" });
    const host = w.document.body.createDiv({ cls: "vault-capture-floating-host" });
    const surface = renderCaptureSurface({
      parent: host,
      mode: "floating",
      vaultName: this.app.vault.getName(),
      destination: this.options.destination,
      inboxPath: this.options.inboxPath,
      save: (text, destination) => this.capture(text, { destination }),
      close: () => w.close(),
    });
    surface.focus();
  }
}

class QuickCaptureModal extends Modal {
  constructor(
    app: any,
    private plugin: QuickCapturePlugin,
    private initialText: string,
  ) {
    super(app);
    this.modalEl.addClass("vault-capture-modal");
  }

  override onOpen() {
    this.contentEl.empty();
    const surface = renderCaptureSurface({
      parent: this.contentEl,
      mode: "modal",
      vaultName: this.app.vault.getName(),
      initialText: this.initialText,
      destination: this.plugin.options.destination,
      inboxPath: this.plugin.options.inboxPath,
      save: async (text, destination) => {
        const result = await this.plugin.capture(text, { destination });
        new Notice(`Captured to ${result.path}`);
        return result;
      },
      close: () => this.close(),
    });
    window.setTimeout(() => surface.focus(), 0);
  }

  override onClose() {
    this.contentEl.empty();
  }
}

class QuickCaptureSettingTab extends PluginSettingTab {
  constructor(
    app: any,
    override plugin: QuickCapturePlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const o = this.plugin.options;
    const save = () => void this.plugin.instance.saveOptions();

    new Setting(containerEl)
      .setName("Destination")
      .setDesc("Where captured text goes by default. The capture sheet can change it for one entry.")
      .addDropdown((d) =>
        d
          .addOptions({ daily: "Today's daily note", inbox: "Inbox note", new: "A new note" })
          .setValue(o.destination)
          .onChange((v) => {
            o.destination = v as CaptureDestination;
            save();
          }),
      );
    new Setting(containerEl)
      .setName("Inbox note")
      .setDesc("The note captures are added to when the destination is Inbox.")
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_CAPTURE_OPTIONS.inboxPath)
          .setValue(o.inboxPath)
          .onChange((v) => {
            o.inboxPath = v.trim() || DEFAULT_CAPTURE_OPTIONS.inboxPath;
            save();
          }),
      );
    new Setting(containerEl)
      .setName("Folder for new notes")
      .setDesc("Where a capture saved as a new note is created. Empty means the vault root.")
      .addText((t) =>
        t
          .setPlaceholder("Inbox")
          .setValue(o.newNoteFolder)
          .onChange((v) => {
            o.newNoteFolder = v.trim();
            save();
          }),
      );
    new Setting(containerEl)
      .setName("Under heading")
      .setDesc("Add entries under this heading in the daily or inbox note, creating it if it is missing. Empty adds to the whole note.")
      .addText((t) =>
        t
          .setPlaceholder("## Captured")
          .setValue(o.heading)
          .onChange((v) => {
            o.heading = v;
            save();
          }),
      );
    new Setting(containerEl)
      .setName("Position")
      .setDesc("Add new entries at the end or at the top (after the properties).")
      .addDropdown((d) =>
        d
          .addOptions({ append: "At the end", prepend: "At the top" })
          .setValue(o.position)
          .onChange((v) => {
            o.position = v as "append" | "prepend";
            save();
          }),
      );
    const stamp = new Setting(containerEl).setName("Timestamp format");
    const preview = () => stamp.setDesc(`Written before each entry, using Moment.js tokens. Empty for no timestamp. Now: ${o.timestampFormat ? moment().format(o.timestampFormat) : "(none)"}`);
    preview();
    stamp.addMomentFormat((m) =>
      m
        .setDefaultFormat("")
        .setPlaceholder("HH:mm")
        .setValue(o.timestampFormat)
        .onChange((v) => {
          o.timestampFormat = v;
          preview();
          save();
        }),
    );
    new Setting(containerEl)
      .setName("Write entries as list items")
      .setDesc("Start each entry with “- ” so captures form a list.")
      .addToggle((t) =>
        t.setValue(o.bullet).onChange((v) => {
          o.bullet = v;
          save();
        }),
      );

    const url = new URL("./", location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("capture", "1");
    url.searchParams.set("vault", this.app.vault.getName());
    new Setting(containerEl)
      .setName("Capture link")
      .setDesc(`Opens the capture sheet for this vault without loading it. Add &text=… to fill it in. ${url.toString()}`)
      .addButton((b) =>
        b.setButtonText("Copy link").onClick(async () => {
          new Notice((await copyText(url.toString())) ? "Capture link copied." : "Could not copy to the clipboard.");
        }),
      );
  }
}

export const quickCapture: CorePluginDefinition = {
  id: "quick-capture",
  name: "Quick capture",
  description: "Write a thought into today's daily note or an inbox note from a small sheet, a floating window, a link or the share menu — before the vault finishes loading.",
  icon: "lucide-zap",
  defaultOn: true,
  defaultOptions: { ...DEFAULT_CAPTURE_OPTIONS },
  create: (app) =>
    new QuickCapturePlugin(app, { id: "quick-capture", name: "Quick capture", version: "", minAppVersion: "", author: "", description: "" }),
};
