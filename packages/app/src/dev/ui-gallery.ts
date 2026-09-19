/**
 * UI gallery — every component in `obsidian/ui` on one page, for manual and
 * automated checks (the e2e suite drives it through the `data-gallery`
 * attributes and reads results from `[data-gallery="log"]`).
 *
 * `mountUiGallery(el, app?)` renders into `el` and returns a cleanup function.
 * Without an `app` it uses `window.app` or builds a minimal stand-in with a
 * Keymap installed, so the gallery works before the workspace exists.
 * The fuzzy modal needs the engine (`initEngine()`), which the gallery starts
 * on demand.
 */
import type { App } from "../obsidian/app";
import type { SettingDefinitionItem } from "obsidian";
import { addIcon, getIconIds, setIcon } from "../obsidian/ui/icons";
import { Keymap, Scope, hotkeyToString, parseHotkey } from "../obsidian/ui/keymap";
import { Menu } from "../obsidian/ui/menu";
import { ConfirmationModal, Modal } from "../obsidian/ui/modal";
import { Notice } from "../obsidian/ui/notice";
import { HoverPopover } from "../obsidian/ui/popover";
import { ButtonComponent, SecretComponent, Setting, SettingGroup, SettingPage } from "../obsidian/ui/setting";
import { PluginSettingTab } from "../obsidian/ui/setting-tab";
import { AbstractInputSuggest, FuzzySuggestModal, SuggestModal } from "../obsidian/ui/suggest";
import { setTooltip } from "../obsidian/ui/tooltip";

const FRUITS = ["Apple", "Apricot", "Banana", "Blackberry", "Blueberry", "Cherry", "Coconut", "Date", "Fig", "Grape", "Guava", "Kiwi", "Lemon", "Lime", "Mango", "Melon", "Orange", "Papaya", "Peach", "Pear", "Pineapple", "Plum", "Raspberry", "Strawberry"];

function galleryApp(given?: App): App {
  if (given) return given;
  const existing = (window as unknown as { app?: App }).app;
  if (existing?.keymap) return existing;
  // No app yet: a stand-in with the fields the UI classes touch.
  const scope = new Scope();
  const keymap = new Keymap(scope);
  keymap.install(window);
  const vaultFiles = Array.from({ length: 40 }, (_, i) => ({ path: `Notes/Note ${i + 1}.md`, name: `Note ${i + 1}.md`, basename: `Note ${i + 1}`, extension: "md" }));
  const folders = [{ path: "/", children: [] }, { path: "Notes", children: [] }, { path: "Daily", children: [] }];
  const config: Record<string, unknown> = {};
  const secrets = new Map<string, string>();
  const standIn = {
    keymap,
    scope,
    lastEvent: null,
    workspace: {},
    metadataCache: {},
    dom: { appContainerEl: document.body },
    vault: {
      getFiles: () => vaultFiles,
      getAllFolders: (includeRoot?: boolean) => folders.filter((f) => includeRoot || f.path !== "/"),
      getConfig: (k: string) => config[k],
      setConfig: (k: string, v: unknown) => {
        config[k] = v;
      },
    },
    secretStorage: {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, secret: string) => {
        if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Secret ids use lowercase letters, digits and dashes");
        secrets.set(id, secret);
      },
      listSecrets: () => Array.from(secrets.keys()),
    },
  };
  const app = standIn as unknown as App;
  (window as unknown as { app?: App }).app = app;
  return app;
}

async function ensureEngine(log: (s: string) => void): Promise<void> {
  try {
    const engine = await import("@vault/engine");
    if (!engine.isEngineReady()) await engine.initEngine();
  } catch (e) {
    log(`engine unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function mountUiGallery(el: HTMLElement, appArg?: App): () => void {
  const app = galleryApp(appArg);
  const cleanups: (() => void)[] = [];
  el.empty();
  el.addClass("vault-ui-gallery");

  const logEl = el.createEl("pre", { attr: { "data-gallery": "log" } });
  const log = (line: string) => {
    logEl.appendText(`${line}\n`);
    logEl.scrollTop = logEl.scrollHeight;
  };

  const section = (title: string) => {
    const s = el.createDiv({ cls: "vault-ui-gallery-section" });
    s.createEl("h2", { text: title });
    return s;
  };
  const button = (parent: HTMLElement, text: string, id: string, onClick: (evt: MouseEvent) => void) => {
    const b = new ButtonComponent(parent).setButtonText(text).onClick(onClick);
    b.buttonEl.setAttr("data-gallery", id);
    return b;
  };

  // ---- settings -------------------------------------------------------------
  const settings = section("Setting components");
  new Setting(settings).setName("Heading").setHeading();
  new Setting(settings)
    .setName("Text")
    .setDesc("A text input")
    .addText((t) => t.setPlaceholder("Type here").onChange((v) => log(`text: ${v}`)).inputEl.setAttr("data-gallery", "text"));
  new Setting(settings).setName("Text area").addTextArea((t) => t.setPlaceholder("Several lines").onChange((v) => log(`textarea: ${v.length}`)));
  new Setting(settings).setName("Search").addSearch((s) => s.setPlaceholder("Search…").onChange((v) => log(`search: ${v}`)));
  const sample = createSpan();
  new Setting(settings)
    .setName("Moment format")
    .setDesc(createFragment((f) => {
      f.appendText("Sample: ");
      f.appendChild(sample);
    }))
    .addMomentFormat((m) => m.setDefaultFormat("YYYY-MM-DD").setSampleEl(sample).onChange((v) => log(`moment: ${v}`)));
  new Setting(settings)
    .setName("Toggle")
    .setDesc("A pill switch")
    .addToggle((t) => {
      t.setValue(true).setTooltip("Toggle me").onChange((v) => log(`toggle: ${v}`));
      t.toggleEl.setAttr("data-gallery", "toggle");
    });
  new Setting(settings).setName("Dropdown").addDropdown((d) =>
    d.addOption("a", "Option A").addOptions({ b: "Option B", c: "Option C" }).setValue("b").onChange((v) => log(`dropdown: ${v}`)),
  );
  new Setting(settings).setName("Slider").addSlider((s) =>
    s.setLimits(0, 20, 1).setValue(8).setDisplayFormat((v) => `${v}px`).setDynamicTooltip().onChange((v) => log(`slider: ${v}`)),
  );
  new Setting(settings)
    .setName("Buttons")
    .addButton((b) => b.setButtonText("Default").onClick(() => log("button: default")))
    .addButton((b) => b.setButtonText("Call to action").setCta().onClick(() => log("button: cta")))
    .addButton((b) => b.setButtonText("Warning").setWarning())
    .addButton((b) => b.setButtonText("Delete").setDestructive())
    .addButton((b) => b.setIcon("lucide-star").setTooltip("Icon button"))
    .addExtraButton((b) => b.setIcon("reset").setTooltip("Restore default").onClick(() => log("extra: reset")));
  new Setting(settings).setName("Colour").addColorPicker((c) => c.setValueHsl({ h: 258, s: 88, l: 66 }).onChange((v) => log(`color: ${v}`)));
  const progress = new Setting(settings).setName("Progress bar");
  progress.addProgressBar((p) => {
    let v = 0;
    const id = window.setInterval(() => p.setValue((v = (v + 5) % 105)), 200);
    cleanups.push(() => clearInterval(id));
  });
  new Setting(settings).setName("Display value").addDisplayValue((d) => d.setValue("Enabled").setStatus("warning"));
  new Setting(settings).setName("Secret").addComponent((cEl) => new SecretComponent(app, cEl).onChange((v) => log(`secret: ${v}`)));
  new Setting(settings).setName("Disabled row").setDesc("Every control is disabled").addText((t) => t.setValue("read only")).addToggle((t) => t.setValue(true)).setDisabled(true);
  new Setting(settings).setName("Invalid row").addText((t) => t.setValue("bad value")).setErrorMessage("This value is not allowed.");

  const group = new SettingGroup(settings).setHeading("Setting group");
  group.addSearch((s) => s.setPlaceholder("Filter group"));
  group.addExtraButton((b) => b.setIcon("lucide-plus").setTooltip("Add"));
  group.addSetting((s) => s.setName("Grouped setting one").addToggle((t) => t));
  group.addSetting((s) => s.setName("Grouped setting two").addToggle((t) => t.setValue(true)));

  // ---- declarative settings --------------------------------------------------
  const declarative = section("Declarative setting tab (getSettingDefinitions)");
  const plugin = {
    manifest: { id: "gallery", name: "Gallery" },
    settings: { enabled: true, mode: "fast", name: "", count: 3, size: 12, accent: "#7c3aed", notes: "", file: "", folder: "", entries: ["First", "Second", "Third"] } as Record<string, any>,
    async saveData(data: unknown) {
      log(`saveData: ${JSON.stringify(data)}`);
    },
  };
  class GalleryPage extends SettingPage {
    display(): void {
      this.containerEl.empty();
      new Setting(this.containerEl).setName("Imperative sub-page").setDesc(`Title: ${this.title}`);
    }
  }
  class GalleryTab extends PluginSettingTab {
    override getSettingDefinitions(): SettingDefinitionItem[] {
      const entries: string[] = plugin.settings.entries;
      return [
        { name: "Enabled", desc: "A toggle bound to plugin.settings.enabled", control: { type: "toggle", key: "enabled" } },
        {
          type: "group",
          heading: "Controls",
          items: [
            { name: "Mode", control: { type: "dropdown", key: "mode", options: { fast: "Fast", slow: "Slow" } } },
            { name: "Name", control: { type: "text", key: "name", placeholder: "At least 3 characters", validate: (v: string) => (v && v.length < 3 ? "Too short" : undefined) } },
            { name: "Count", visible: () => plugin.settings.enabled, control: { type: "number", key: "count", min: 0, max: 10 } },
            { name: "Size", control: { type: "slider", key: "size", min: 8, max: 32, step: 1, displayFormat: (v: number) => `${v}px` } },
            { name: "Accent", control: { type: "color", key: "accent" } },
            { name: "Notes", control: { type: "textarea", key: "notes", rows: 3 } },
            { name: "File", control: { type: "file", key: "file", placeholder: "Pick a note" } },
            { name: "Folder", control: { type: "folder", key: "folder", includeRoot: true } },
            { name: "Run action", desc: "Click the row", action: (_el, i) => log(`action row ${i}`) },
            { name: "Custom render", render: (s) => void s.addButton((b) => b.setButtonText("Rendered").onClick(() => log("render button"))) },
            { type: "page", name: "Advanced", desc: "A declarative sub-page", displayValue: () => plugin.settings.mode, items: [{ name: "Deep toggle", control: { type: "toggle", key: "deep" } }] },
            { type: "page", name: "Imperative page", page: () => new GalleryPage() },
          ],
        },
        {
          type: "list",
          heading: "Entries",
          search: { placeholder: "Filter entries", match: (def, q) => def.name.toLowerCase().includes(q.toLowerCase()) },
          emptyState: "No entries",
          addItem: { name: "Add entry", action: () => (entries.push(`Entry ${entries.length + 1}`), this.update()) },
          onDelete: (i) => (entries.splice(i, 1), this.update()),
          onReorder: (a, b) => {
            const [x] = entries.splice(a, 1);
            entries.splice(b, 0, x!);
            log(`reorder ${a} -> ${b}`);
          },
          items: entries.map((e) => ({ name: e })),
        },
      ];
    }
  }
  const tab = new GalleryTab(app, plugin);
  declarative.appendChild(tab.containerEl);
  tab.showTab();
  cleanups.push(() => tab.hideTab());

  // ---- overlays ---------------------------------------------------------------
  const overlays = section("Modal, menu, notices, suggest");
  const row = overlays.createDiv({ cls: "vault-ui-gallery-row" });

  button(row, "Open modal", "open-modal", () => {
    const m = new (class extends Modal {
      override onOpen() {
        this.setTitle("A modal");
        this.contentEl.createEl("p", { text: "Escape, the close button, or a click on the backdrop closes it. Tab stays inside." });
        new Setting(this.contentEl).setName("Inside a modal").addText((t) => t.setPlaceholder("Focusable"));
        new Setting(this.contentEl).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
      }
      override onClose() {
        this.contentEl.empty();
        log("modal: closed");
      }
    })(app);
    m.open();
  });

  button(row, "Confirmation modal", "open-confirm", () => {
    new ConfirmationModal(app)
      .setTitle("Delete file")
      .setContent("Are you sure you want to delete “Note.md”?")
      .addCheckbox("Don't ask again", (v) => log(`confirm checkbox: ${v}`))
      .addButton((b) => b.setButtonText("Delete").setDestructive().setCta().setInitialFocus().onClick(() => log("confirm: delete")))
      .addButton((b) => b.setButtonText("Keep open").setSecondary().onClick(() => (log("confirm: kept open"), true)))
      .addCancelButton()
      .open();
  });

  const showMenu = (evt: MouseEvent) => {
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Delete").setIcon("trash").setWarning(true).setSection("danger").onClick(() => log("menu: delete")));
    menu.addItem((i) => i.setTitle("Open in new tab").setIcon("lucide-file-plus").setSection("open").onClick(() => log("menu: open")));
    menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil").setSection("action").onClick(() => log("menu: rename")));
    menu.addItem((i) => i.setTitle("Disabled").setIcon("lucide-ban").setDisabled(true).setSection("action"));
    menu.addItem((i) => i.setTitle("Checked").setChecked(true).setSection("view").onClick(() => log("menu: checked")));
    menu.addItem((i) => {
      i.setTitle("More").setIcon("lucide-more-horizontal").setSection("view");
      const sub = i.setSubmenu();
      sub.addItem((s) => s.setTitle("Sub item A").onClick(() => log("menu: sub A")));
      sub.addItem((s) => s.setTitle("Sub item B").setIcon("star").onClick(() => log("menu: sub B")));
    });
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Unsectioned").onClick(() => log("menu: unsectioned")));
    menu.onHide(() => log("menu: hidden"));
    menu.showAtMouseEvent(evt);
  };
  button(row, "Show menu", "show-menu", showMenu);
  const ctxTarget = row.createDiv({ cls: "vault-ui-gallery-target", text: "Right-click me (Menu.forEvent)", attr: { "data-gallery": "context-target" } });
  ctxTarget.addEventListener("contextmenu", (evt) => {
    Menu.forEvent(evt).addItem((i) => i.setTitle("From handler one").setIcon("document").onClick(() => log("forEvent: one")));
  });
  ctxTarget.addEventListener("contextmenu", (evt) => {
    Menu.forEvent(evt).addItem((i) => i.setTitle("From handler two").setIcon("folder").onClick(() => log("forEvent: two")));
  });

  button(row, "Notice", "notice", () => new Notice("Saved."));
  button(row, "Sticky notice", "notice-sticky", () => new Notice("Click to dismiss this notice.", 0));
  button(row, "Fragment notice", "notice-fragment", () => {
    const frag = createFragment((f) => {
      f.createEl("b", { text: "Bold" });
      f.appendText(" fragment message");
    });
    const n = new Notice(frag, 3000);
    window.setTimeout(() => n.setMessage("Message updated"), 1000);
  });

  button(row, "Fuzzy modal (1000 items)", "open-fuzzy", async () => {
    await ensureEngine(log);
    const items = Array.from({ length: 1000 }, (_, i) => `${FRUITS[i % FRUITS.length]} ${i + 1}`);
    const modal = new (class extends FuzzySuggestModal<string> {
      getItems() {
        return items;
      }
      getItemText(item: string) {
        return item;
      }
      onChooseItem(item: string) {
        log(`fuzzy: ${item}`);
      }
    })(app);
    modal.setPlaceholder("Type a fruit…");
    modal.setInstructions([
      { command: "↑↓", purpose: "to navigate" },
      { command: "↵", purpose: "to choose" },
      { command: "esc", purpose: "to dismiss" },
    ]);
    modal.open();
  });

  button(row, "Async suggest modal", "open-async", () => {
    const modal = new (class extends SuggestModal<string> {
      getSuggestions(query: string) {
        return new Promise<string[]>((resolve) =>
          window.setTimeout(() => resolve(FRUITS.filter((f) => f.toLowerCase().includes(query.toLowerCase()))), 120),
        );
      }
      renderSuggestion(value: string, el: HTMLElement) {
        el.addClass("mod-complex");
        const content = el.createDiv({ cls: "suggestion-content" });
        content.createDiv({ cls: "suggestion-title", text: value });
        content.createDiv({ cls: "suggestion-note", text: `${value.length} letters` });
        const aux = el.createDiv({ cls: "suggestion-aux" });
        setIcon(aux.createSpan({ cls: "suggestion-flair" }), "lucide-apple");
      }
      onChooseSuggestion(item: string) {
        log(`async: ${item}`);
      }
    })(app);
    modal.emptyStateText = "No fruit matches.";
    modal.open();
  });

  const inputRow = overlays.createDiv({ cls: "vault-ui-gallery-row" });
  const input = inputRow.createEl("input", { type: "text", placeholder: "AbstractInputSuggest: type a fruit", attr: { "data-gallery": "input-suggest" } });
  const inputSuggest = new (class extends AbstractInputSuggest<string> {
    protected getSuggestions(query: string) {
      return FRUITS.filter((f) => f.toLowerCase().startsWith(query.toLowerCase()));
    }
    renderSuggestion(value: string, el: HTMLElement) {
      el.setText(value);
    }
  })(app, input).onSelect((value) => {
    inputSuggest.setValue(value);
    log(`input suggest: ${value}`);
  });

  // ---- tooltips, popover, icons, hotkeys -------------------------------------------
  const misc = section("Tooltips, hover popover, icons, hotkeys");
  const tipRow = misc.createDiv({ cls: "vault-ui-gallery-row" });
  for (const placement of ["top", "bottom", "left", "right"] as const) {
    const b = button(tipRow, placement, `tooltip-${placement}`, () => {});
    setTooltip(b.buttonEl, `Tooltip on the ${placement}`, { placement, delay: 100 });
  }
  const ariaOnly = tipRow.createDiv({ cls: ["clickable-icon"], attr: { "aria-label": "Plain aria-label tooltip" } });
  setIcon(ariaOnly, "info");

  const hoverParent = { hoverPopover: null as HoverPopover | null };
  const hoverTarget = tipRow.createDiv({ cls: "vault-ui-gallery-target", text: "Hover for a popover", attr: { "data-gallery": "hover-target" } });
  hoverTarget.addEventListener("mouseover", () => {
    if (hoverParent.hoverPopover) return;
    const pop = new HoverPopover(hoverParent, hoverTarget, 300);
    pop.hoverEl.createEl("h3", { text: "Hover popover" });
    const inner = pop.hoverEl.createDiv({ cls: "vault-ui-gallery-target", text: "Hover here for a nested popover" });
    inner.addEventListener("mouseover", () => {
      if (pop.hoverPopover) return;
      const child = new HoverPopover(pop, inner, 300);
      child.hoverEl.createEl("p", { text: "Nested popover: the parent stays open while this is hovered." });
    });
  });

  addIcon("gallery-custom", '<circle cx="50" cy="50" r="40" fill="currentColor"/>');
  const icons = misc.createDiv({ cls: "vault-ui-gallery-icons" });
  for (const id of ["document", "folder", "search", "pencil", "cross", "gear", "dice", "star", "pin", "link", "sheets-in-box", "right-triangle", "three-horizontal-bars", "vertical-three-dots", "enter", "checkmark", "info", "lucide-file-text", "alert-triangle", "gallery-custom", "does-not-exist"]) {
    const cell = icons.createDiv({ cls: "vault-ui-gallery-icon", attr: { "aria-label": id } });
    setIcon(cell.createDiv(), id);
    cell.createDiv({ text: id });
  }
  misc.createDiv({ text: `${getIconIds().length} icon ids registered` });
  const hotkeys = misc.createDiv({ cls: "vault-ui-gallery-row" });
  for (const hk of ["Mod+Shift+P", "Ctrl+Alt+ArrowUp", "Mod+,", "Shift+Enter"]) {
    const parsed = parseHotkey(hk);
    hotkeys.createEl("kbd", { text: parsed ? hotkeyToString(parsed) : `unparsed: ${hk}` });
  }

  // A scope hotkey on the app scope: Mod+Shift+K logs.
  const handler = app.scope.register(["Mod", "Shift"], "K", () => {
    log("hotkey: Mod+Shift+K");
    return false;
  });
  cleanups.push(() => app.scope.unregister(handler));

  return () => {
    for (const c of cleanups.splice(0)) {
      try {
        c();
      } catch (e) {
        console.error(e);
      }
    }
    el.empty();
  };
}
