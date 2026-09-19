/**
 * Settings → Appearance (§6.5): colour scheme, accent, community themes,
 * fonts, font size, zoom, translucency and CSS snippets.
 *
 * Window frame style, custom app icon, native menus and hardware acceleration
 * belong to a desktop shell and are not shown. The browser owns the real page
 * zoom, so "Zoom level" scales the app with CSS zoom instead.
 */
import type { App } from "../../obsidian/app";
import { Modal } from "../../obsidian/ui/modal";
import { Notice } from "../../obsidian/ui/notice";
import { ButtonComponent, Setting, TextComponent } from "../../obsidian/ui/setting";
import { isFontAvailable, parseFontList, pickFiles, promptModal, serializeFontList } from "../helpers";
import { AppSettingTab } from "../tab-base";
import { ThemeBrowserModal, checkThemeUpdates, themeUpdates, updateTheme } from "../theme-store";
import { ZOOM_STEPS, getZoomIndex, setZoomIndex } from "../zoom";
import { addMobileLayoutSetting } from "../../obsidian/workspace/mobile/settings";

export const DEFAULT_ACCENT = "#8a5cf5";

const FONT_SETTINGS: { key: string; name: string; desc: string }[] = [
  { key: "interfaceFontFamily", name: "Interface font", desc: "Set base font for all of the interface." },
  { key: "textFontFamily", name: "Text font", desc: "Set font for editing and reading views." },
  { key: "monospaceFontFamily", name: "Monospace font", desc: "Set font for places like code blocks and frontmatter." },
];

export class AppearanceSettingTab extends AppSettingTab {
  constructor(app: App) {
    super(app, "appearance", "Appearance", "lucide-palette");
  }

  render(el: HTMLElement): void {
    const app = this.app;
    const css = app.customCss;

    const general = this.group(el);
    this.row(general, "Base color scheme", "Choose the default color scheme.").addDropdown((d) =>
      d
        .addOptions({ system: "Adapt to system", moonstone: "Light", obsidian: "Dark" })
        .setValue(css.getTheme())
        .onChange((v) => css.setTheme(v as "system" | "moonstone" | "obsidian")),
    );
    const accent = String(this.getConfig("accentColor") ?? "");
    this.row(general, "Accent color", "Choose the accent color used throughout the app.")
      .addExtraButton((b) =>
        b
          .setIcon("lucide-rotate-ccw")
          .setTooltip("Restore default")
          .setDisabled(!accent)
          .onClick(() => {
            css.setAccentColor("");
            this.rerender();
          }),
      )
      .addColorPicker((c) =>
        c.setValue(accent || DEFAULT_ACCENT).onChange((v) => {
          css.setAccentColor(v);
        }),
      );

    // Themes
    const themes = this.group(el, "Themes");
    const installed = Object.keys(css.themes).sort((a, b) => a.localeCompare(b));
    this.row(themes, "Themes", `Manage installed themes and browse community themes. Themes live in ${app.vault.configDir}/themes.`)
      .addDropdown((d) => {
        d.addOption("", "Default");
        for (const name of installed) d.addOption(name, name);
        if (css.theme && !installed.includes(css.theme)) d.addOption(css.theme, `${css.theme} (missing)`);
        d.setValue(css.theme).onChange((v) => void css.setCssTheme(v).then(() => this.rerender()));
      })
      .addButton((b) =>
        b.setButtonText("Manage").onClick(() => {
          new ThemeBrowserModal(app, () => this.rerender()).open();
        }),
      );
    const updates = themeUpdates();
    const updateCount = Object.keys(updates).length;
    const current = this.row(
      themes,
      "Current community themes",
      installed.length ? `${installed.length} installed.${updateCount ? ` ${updateCount} update${updateCount === 1 ? "" : "s"} available.` : ""}` : "No community themes installed.",
    );
    current.addButton((b) =>
      b
        .setButtonText("Check for updates")
        .setDisabled(!installed.length)
        .onClick(async () => {
          b.setDisabled(true).setButtonText("Checking…");
          try {
            const n = Object.keys(await checkThemeUpdates(app)).length;
            new Notice(n ? `${n} theme update${n === 1 ? "" : "s"} available.` : "All themes are up to date.");
          } catch (e) {
            new Notice(`Could not check for theme updates: ${(e as Error).message}`);
          }
          this.rerender();
        }),
    );
    if (updateCount) {
      current.addButton((b) =>
        b
          .setButtonText("Update all")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true).setButtonText("Updating…");
            for (const name of Object.keys(updates)) {
              try {
                await updateTheme(app, name);
              } catch (e) {
                new Notice(`Could not update ${name}: ${(e as Error).message}`);
              }
            }
            this.rerender();
          }),
      );
    }

    // Fonts
    const fonts = this.group(el, "Font");
    for (const f of FONT_SETTINGS) {
      const names = parseFontList(this.getConfig(f.key));
      this.row(fonts, f.name, names.length ? `${f.desc} Current: ${names.join(", ")}.` : f.desc).addButton((b) =>
        b.setButtonText("Manage").onClick(() => new FontListModal(app, f.name, f.key, () => this.rerender()).open()),
      );
    }
    this.row(fonts, "Font size", "Font size in pixels that affects editing and reading views.")
      .addExtraButton((b) =>
        b
          .setIcon("lucide-rotate-ccw")
          .setTooltip("Restore default")
          .onClick(() => {
            this.setConfig("baseFontSize", 16);
            this.rerender();
          }),
      )
      .addSlider((s) =>
        s
          .setLimits(10, 30, 1)
          .setValue(Number(this.getConfig("baseFontSize") ?? 16))
          .setInstant(true)
          .onChange((v) => this.setConfig("baseFontSize", v)),
      );
    this.toggle(fonts, "Quick font size adjustment", "Adjust the font size using Ctrl/Cmd + scroll wheel, or a trackpad pinch gesture.", "baseFontSizeAction");

    // Advanced
    const advanced = this.group(el, "Advanced");
    this.row(advanced, "Zoom level", "Scale the whole interface. Your browser's own zoom (Ctrl/Cmd + and −) still applies on top.").addDropdown((d) => {
      ZOOM_STEPS.forEach((pct, i) => d.addOption(String(i), `${pct}%`));
      d.setValue(String(getZoomIndex(app))).onChange((v) => setZoomIndex(app, parseInt(v, 10)));
    });
    this.toggle(advanced, "Translucent window", "Make the sidebars slightly see-through.", "translucency");
    addMobileLayoutSetting(app, this.row(advanced, "Mobile layout"));

    // CSS snippets
    this.renderSnippets(el);
  }

  private renderSnippets(el: HTMLElement) {
    const app = this.app;
    const css = app.customCss;
    const folder = css.getSnippetsFolder();
    const group = this.group(el, "CSS snippets");
    const header = group.getHeader();
    header.setDesc(`CSS snippets are stored in ${folder}.`);
    header
      .addExtraButton((b) =>
        b
          .setIcon("lucide-refresh-cw")
          .setTooltip("Reload snippets")
          .onClick(async () => {
            await css.requestLoadSnippets();
            this.rerender();
          }),
      )
      .addExtraButton((b) =>
        b
          .setIcon("lucide-file-plus")
          .setTooltip("New snippet")
          .onClick(() => void this.newSnippet()),
      )
      .addExtraButton((b) =>
        b
          .setIcon("lucide-upload")
          .setTooltip("Import .css files")
          .onClick(() => void this.importSnippets()),
      );
    if (!css.snippets.length) {
      this.row(group, "No snippets yet", "Create a new snippet, or import .css files, to customise the app's styles.");
      return;
    }
    for (const name of css.snippets) {
      this.row(group, name, `${folder}/${name}.css`)
        .addExtraButton((b) =>
          b
            .setIcon("lucide-pencil")
            .setTooltip("Edit snippet")
            .onClick(() => new SnippetEditorModal(app, name, () => this.rerender()).open()),
        )
        .addToggle((t) => t.setValue(css.enabledSnippets.has(name)).onChange((v) => css.setCssEnabledStatus(name, v)));
    }
  }

  private async newSnippet() {
    const css = this.app.customCss;
    const name = await promptModal(this.app, {
      title: "New CSS snippet",
      placeholder: "Snippet name",
      cta: "Create",
      validate: (v) => (!v ? "Enter a name." : /[\\/:*?"<>|]/.test(v) ? "A name cannot contain \\ / : * ? \" < > |" : css.snippets.includes(v) ? "A snippet with this name already exists." : null),
    });
    if (!name) return;
    const adapter = this.app.vault.adapter;
    await adapter.mkdir(css.getSnippetsFolder());
    await adapter.write(`${css.getSnippetsFolder()}/${name}.css`, `/* ${name} */\n`);
    await css.requestLoadSnippets();
    this.rerender();
    new SnippetEditorModal(this.app, name, () => this.rerender()).open();
  }

  private async importSnippets() {
    const files = await pickFiles({ accept: ".css,text/css", multiple: true });
    if (!files.length) return;
    const css = this.app.customCss;
    const adapter = this.app.vault.adapter;
    await adapter.mkdir(css.getSnippetsFolder());
    for (const file of files) {
      const name = file.name.replace(/\.css$/i, "");
      await adapter.write(`${css.getSnippetsFolder()}/${name}.css`, await file.text());
    }
    await css.requestLoadSnippets();
    new Notice(`Imported ${files.length} snippet${files.length === 1 ? "" : "s"}.`);
    this.rerender();
  }
}

/** Ordered font list; the first installed font wins. */
export class FontListModal extends Modal {
  private fonts: string[];

  constructor(
    app: App,
    title: string,
    private key: string,
    private onDone: () => void,
  ) {
    super(app);
    this.fonts = parseFontList(app.vault.getConfig(key));
    this.modalEl.addClass("vault-font-list-modal");
    this.setTitle(title);
  }

  override onOpen(): void {
    this.render();
  }

  override onClose(): void {
    this.onDone();
  }

  private save() {
    this.app.vault.setConfig(this.key, serializeFontList(this.fonts));
    this.app.customCss.applyAppearance();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { cls: "setting-item-description", text: "Fonts are tried in order; the first one installed on this device is used. Leave the list empty to use the theme's default." });
    const list = contentEl.createDiv({ cls: "vault-font-list" });
    if (!this.fonts.length) list.createDiv({ cls: "vault-empty-state", text: "Using the default font." });
    let firstAvailable = true;
    this.fonts.forEach((font, i) => {
      const available = isFontAvailable(font);
      const s = new Setting(list).setName(font);
      s.nameEl.style.fontFamily = `"${font}"`;
      s.setDesc(available ? (firstAvailable ? "Detected on your system. In use." : "Detected on your system.") : "Not detected on your system.");
      if (available) firstAvailable = false;
      s.settingEl.toggleClass("mod-unavailable", !available);
      s.addExtraButton((b) => b.setIcon("lucide-arrow-up").setTooltip("Move up").setDisabled(i === 0).onClick(() => this.move(i, i - 1)));
      s.addExtraButton((b) => b.setIcon("lucide-arrow-down").setTooltip("Move down").setDisabled(i === this.fonts.length - 1).onClick(() => this.move(i, i + 1)));
      s.addExtraButton((b) =>
        b
          .setIcon("lucide-x")
          .setTooltip("Remove")
          .onClick(() => {
            this.fonts.splice(i, 1);
            this.save();
            this.render();
          }),
      );
    });

    const add = contentEl.createDiv({ cls: "vault-font-list-add" });
    const input = new TextComponent(add).setPlaceholder("Font name, e.g. Inter");
    const datalistId = `vault-font-options-${this.key}`;
    const datalist = add.createEl("datalist", { attr: { id: datalistId } });
    for (const name of COMMON_FONTS) datalist.createEl("option", { value: name });
    input.inputEl.setAttr("list", datalistId);
    const commit = () => {
      const name = input.getValue().trim().replace(/^["']|["']$/g, "");
      if (!name) return;
      if (!this.fonts.includes(name)) this.fonts.push(name);
      this.save();
      this.render();
      (contentEl.querySelector(".vault-font-list-add input") as HTMLInputElement | null)?.focus();
    };
    new ButtonComponent(add).setButtonText("Add").setCta().onClick(commit);
    input.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && !evt.isComposing) {
        evt.preventDefault();
        commit();
      }
    });
    const queryLocalFonts = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
    if (typeof queryLocalFonts === "function") {
      new ButtonComponent(add)
        .setButtonText("List installed fonts")
        .setTooltip("Ask the browser for the fonts installed on this device")
        .onClick(async () => {
          try {
            const families = Array.from(new Set((await queryLocalFonts.call(window)).map((f) => f.family))).sort();
            datalist.empty();
            for (const name of families) datalist.createEl("option", { value: name });
            new Notice(`${families.length} installed fonts are now suggested.`);
            input.inputEl.focus();
          } catch {
            new Notice("The browser did not allow listing installed fonts.");
          }
        });
    }
  }

  private move(from: number, to: number) {
    const [f] = this.fonts.splice(from, 1);
    if (f === undefined) return;
    this.fonts.splice(to, 0, f);
    this.save();
    this.render();
  }
}

const COMMON_FONTS = [
  "Arial",
  "Avenir Next",
  "Cascadia Code",
  "Consolas",
  "Courier New",
  "Fira Code",
  "Georgia",
  "Helvetica Neue",
  "IBM Plex Sans",
  "Inter",
  "JetBrains Mono",
  "Literata",
  "Menlo",
  "Merriweather",
  "Noto Sans",
  "Roboto",
  "SF Mono",
  "Segoe UI",
  "Source Code Pro",
  "Source Serif Pro",
  "System-ui",
  "Times New Roman",
  "Ubuntu",
  "Verdana",
];

/** A plain editor for a snippet file, since the browser has no "open folder". */
export class SnippetEditorModal extends Modal {
  constructor(
    app: App,
    private name: string,
    private onDone: () => void,
  ) {
    super(app);
    this.modalEl.addClass("vault-snippet-editor-modal");
    this.setTitle(`${name}.css`);
  }

  override async onOpen(): Promise<void> {
    const css = this.app.customCss;
    const path = `${css.getSnippetsFolder()}/${this.name}.css`;
    let text = "";
    try {
      text = await this.app.vault.adapter.read(path);
    } catch {
      /* new or removed */
    }
    const area = this.contentEl.createEl("textarea", { cls: "vault-snippet-editor", attr: { spellcheck: "false" } });
    area.value = text;
    const buttons = this.modalEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons)
      .setButtonText("Delete snippet")
      .setWarning()
      .onClick(async () => {
        await this.app.vault.adapter.remove(path).catch(() => {});
        if (css.enabledSnippets.has(this.name)) css.setCssEnabledStatus(this.name, false);
        await css.requestLoadSnippets();
        this.close();
      });
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(buttons)
      .setButtonText("Save")
      .setCta()
      .onClick(async () => {
        await this.app.vault.adapter.write(path, area.value);
        await css.requestLoadSnippets();
        new Notice(`Saved ${this.name}.css`);
        this.close();
      });
    area.focus();
  }

  override onClose(): void {
    this.onDone();
  }
}
