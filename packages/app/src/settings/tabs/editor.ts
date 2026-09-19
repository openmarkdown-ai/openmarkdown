/**
 * Settings → Editor (§6.3). Keys and defaults are Obsidian's `app.json` keys.
 */
import type { App } from "../../obsidian/app";
import { Modal } from "../../obsidian/ui/modal";
import { ButtonComponent, TextComponent } from "../../obsidian/ui/setting";
import { AppSettingTab, descFragment } from "../tab-base";

export class EditorSettingTab extends AppSettingTab {
  constructor(app: App) {
    super(app, "editor", "Editor", "lucide-pencil");
  }

  render(el: HTMLElement): void {
    const app = this.app;

    const general = this.group(el, "General");
    this.toggle(general, "Always focus new tabs", "When you open a link in a new tab, switch to that tab immediately.", "focusNewTab");
    this.dropdown(general, "Default view for new tabs", "The default view that a new Markdown tab gets opened in.", "defaultViewMode", {
      source: "Editing view",
      preview: "Reading view",
    });
    this.row(general, "Default editing mode", "The default editing mode a new tab starts in. Live Preview renders Markdown as you type.").addDropdown((d) =>
      d
        .addOptions({ true: "Live Preview", false: "Source mode" })
        .setValue(this.getConfig("livePreview") === false ? "false" : "true")
        .onChange((v) => this.setConfig("livePreview", v === "true")),
    );
    const status = app.internalPlugins.getPluginById("editor-status");
    this.row(general, "Show editing mode in status bar", status ? "Display the current editing mode in the status bar." : "The Editor status core plugin is not available.").addToggle((t) =>
      t
        .setValue(!!status?.enabled)
        .setDisabled(!status)
        .onChange((v) => void app.internalPlugins.setEnabled("editor-status", v)),
    );

    const display = this.group(el, "Display");
    this.toggle(display, "Readable line length", "Limit maximum line length. Less content fits onscreen, but long paragraphs are more readable.", "readableLineLength");
    this.toggle(
      display,
      "Strict line breaks",
      "Markdown specs ignore single line breaks in reading view. Turn this off to make single line breaks visible.",
      "strictLineBreaks",
    );
    this.dropdown(display, "Properties in document", "Choose how properties are displayed at the top of notes. Select \"source\" to show properties as raw YAML.", "propertiesInDocument", {
      visible: "Visible",
      hidden: "Hidden",
      source: "Source",
    });
    this.toggle(display, "Fold heading", "Lets you fold all content under a heading.", "foldHeading");
    this.toggle(display, "Fold indent", "Lets you fold part of an indentation, such as lists.", "foldIndent");
    this.toggle(display, "Line numbers", "Show line numbers in the gutter.", "showLineNumber");
    this.toggle(display, "Indentation guides", "Show vertical relationship lines between list items.", "showIndentGuide");
    this.toggle(display, "Right-to-left (RTL)", "Sets the default text direction of notes to right-to-left.", "rightToLeft");
    const mermaidKey = "mermaid-allowed";
    this.row(display, "Show Mermaid diagrams in notes", "Render ```mermaid code blocks as diagrams in this vault.").addToggle((t) =>
      t.setValue(app.loadLocalStorage(mermaidKey) === true).onChange((v) => {
        app.saveLocalStorage(mermaidKey, v ? true : null);
        app.workspace.updateOptions();
      }),
    );

    const behavior = this.group(el, "Behavior");
    this.toggle(behavior, "Spellcheck", "Turn on the spellchecker.", "spellcheck");
    this.row(behavior, "Spellcheck languages", "The browser's spellchecker uses the languages set in your browser's preferences.");
    this.toggle(behavior, "Auto-pair brackets", "Pair brackets and quotes automatically.", "autoPairBrackets");
    this.toggle(behavior, "Auto-pair Markdown syntax", "Pair symbols automatically for bold, italic, code and more.", "autoPairMarkdown");
    this.toggle(behavior, "Smart lists", "Automatically handle list indentation and continue list markers.", "smartIndentList");
    this.toggle(behavior, "Indent using tabs", "Use tabs to indent. Turn this off to indent using 4 spaces.", "useTab");
    this.row(behavior, "Indent visual width", "Number of spaces a tab character will render as.").addSlider((s) =>
      s
        .setLimits(1, 8, 1)
        .setValue(Number(this.getConfig("tabSize") ?? 4))
        .setDynamicTooltip()
        .onChange((v) => this.setConfig("tabSize", v)),
    );
    this.toggle(
      behavior,
      "Convert pasted HTML to Markdown",
      descFragment(["Automatically convert HTML to Markdown when pasting and dragging from webpages. Use ", { text: "Mod+Shift+V", code: true }, " to paste without converting."]),
      "autoConvertHtml",
    );

    // ---- Writing (OpenMarkdown built-ins; W3). One block per feature, keys in app.json.
    const writing = this.group(el, "Writing");
    const writingToggle = (name: string, desc: string | DocumentFragment, key: string, def: boolean) =>
      this.row(writing, name, desc).addToggle((t) => t.setValue((this.getConfig(key) ?? def) === true).onChange((v) => this.setConfig(key, v)));
    // [W3:spell-menu]
    writingToggle(
      "Spelling suggestions on right-click",
      "With spellcheck on, right-clicking a word opens the browser's menu with spelling suggestions. Shift+right-click always opens the browser's menu.",
      "nativeSpellMenu",
      true,
    );
    // [W3:typography]
    writingToggle(
      "Smart typography",
      "Turn straight quotes into curly quotes, -- into an en dash, --- into an em dash and ... into an ellipsis as you type. Never inside code, math or links. Backspace right after a replacement undoes it.",
      "smartTypography",
      false,
    );
    // [W3:tables]
    writingToggle(
      "Table keys",
      "In a table, Tab and Shift+Tab move between cells and Enter moves to the next row, re-aligning the table as you go. Advanced Tables takes over in Source mode when it is enabled.",
      "tableAutoFormat",
      true,
    );
    writingToggle("Table toolbar", "Show buttons for rows, columns, alignment and sorting above a table while the cursor is in it.", "tableToolbar", true);
    // [W3:completion]
    writingToggle(
      "Word completion",
      "Suggest words you have used in this vault after three letters. Tab accepts; Enter accepts once you move into the list. Off while the Various Complements plugin is enabled.",
      "wordCompletion",
      false,
    );
    // [W3:grammar]
    this.row(
      writing,
      "Grammar and style check",
      "Underline grammar, spelling and style issues in English with Harper, running on this device. The first time, a 16 MB language model is downloaded; nothing you write leaves this device.",
    ).addToggle((t) =>
      t.setValue(this.getConfig("grammarCheck") === true).onChange(async (v) => {
        const grammarPlugin = app.internalPlugins.getEnabledPluginById("grammar") as { setEnabled?: (on: boolean) => Promise<boolean> } | null;
        if (!grammarPlugin?.setEnabled) return this.setConfig("grammarCheck", v);
        const on = await grammarPlugin.setEnabled(v);
        if (on !== v) t.setValue(on);
      }),
    );
    // [W3:toolbar]
    this.row(writing, "Formatting toolbar", "Show formatting buttons above the editor, or floating over selected text.").addDropdown((d) =>
      d
        .addOptions({ off: "Off", fixed: "Fixed", selection: "On selection" })
        .setValue(String(this.getConfig("formattingToolbar") ?? "off"))
        .onChange((v) => this.setConfig("formattingToolbar", v)),
    );
    const toolbarPlugin = app.internalPlugins.getEnabledPluginById("formatting-toolbar") as { openManager?: () => void } | null;
    this.row(
      writing,
      "Toolbar buttons",
      toolbarPlugin ? "Choose and order the buttons of the fixed toolbar." : "The Formatting toolbar plugin is off or uninstalled. Turn it on in Settings → Community plugins to use the fixed toolbar.",
    ).addButton((b) =>
      b
        .setButtonText("Manage")
        .setDisabled(!toolbarPlugin?.openManager)
        .onClick(() => toolbarPlugin?.openManager?.()),
    );
    // [W3:focus]
    this.row(writing, "Focus mode dimming", descFragment(["While focus mode is on (", { text: "Mod+Shift+Enter", code: true }, "), dim everything except the current paragraph, sentence or line."])).addDropdown((d) =>
      d
        .addOptions({ off: "Off", paragraph: "Paragraph", sentence: "Sentence", line: "Line" })
        .setValue(String(this.getConfig("focusDim") ?? "paragraph"))
        .onChange((v) => this.setConfig("focusDim", v)),
    );
    writingToggle("Typewriter scrolling", "Keep the line you are typing on at a fixed height of the editor.", "typewriterScroll", false);
    this.row(writing, "Typewriter position", "Where the typing line sits, as a percentage of the editor's height from the top.").addSlider((s) =>
      s
        .setLimits(10, 90, 5)
        .setValue(Number(this.getConfig("typewriterOffset") ?? 50))
        .setDynamicTooltip()
        .onChange((v) => this.setConfig("typewriterOffset", v)),
    );
    void writingToggle;

    const advanced = this.group(el, "Advanced");
    this.row(advanced, "Vim key bindings", "Use Vim key bindings when editing.").addToggle((t) =>
      t.setValue(!!this.getConfig("vimMode")).onChange((v) => {
        if (!v) {
          this.setConfig("vimMode", false);
          return;
        }
        t.setValue(false);
        new VimConfirmModal(app, () => {
          this.setConfig("vimMode", true);
          t.setValue(true);
        }).open();
      }),
    );
  }
}

/**
 * Vim confirmation: prove you know how to leave Vim before turning it on.
 * The answer is `:q!`.
 */
export class VimConfirmModal extends Modal {
  constructor(
    app: App,
    private onConfirm: () => void,
  ) {
    super(app);
    this.modalEl.addClass("vault-vim-confirm-modal");
    this.setTitle("Are you sure?");
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: "Vim key bindings change how every key in the editor behaves." });
    contentEl.createEl("p", { text: "Before you continue, show that you can get out: type the Vim command that quits without saving." });
    const input = new TextComponent(contentEl).setPlaceholder("Type the command here");
    input.inputEl.addClass("vault-vim-confirm-input");
    const hint = contentEl.createDiv({ cls: "setting-item-description vault-vim-confirm-hint" });
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    const ok = new ButtonComponent(buttons).setButtonText("Let me enable Vim").setCta().setDisabled(true);
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    const check = () => {
      const right = input.getValue().trim() === ":q!";
      ok.setDisabled(!right);
      hint.setText(input.getValue().trim() && !right ? "Not quite. Hint: it starts with a colon." : "");
      return right;
    };
    input.onChange(check);
    ok.onClick(() => {
      if (!check()) return;
      this.close();
      this.onConfirm();
    });
    input.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && check()) {
        evt.preventDefault();
        this.close();
        this.onConfirm();
      }
    });
    window.setTimeout(() => input.inputEl.focus(), 0);
  }
}
