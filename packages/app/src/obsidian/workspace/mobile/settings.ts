/**
 * Settings → Mobile: the keyboard toolbar ("Manage toolbar options": the
 * commands in `mobileToolbarCommands`, reorder, remove, add any command), the
 * pull-down Quick Action (`mobilePullAction`) and the swipe gestures. Plus the
 * "Mobile layout: auto / on / off" row that Settings → Appearance shows.
 *
 * Shown on every device: the toolbar list lives in the vault's `app.json`, so
 * it can be set up from a desktop for the phone.
 */
import type { Command } from "obsidian";
import type { App } from "../../app";
import { setIcon } from "../../ui/icons";
import type { Setting } from "../../ui/setting";
import { FuzzySuggestModal } from "../../ui/suggest";
import { AppSettingTab } from "../../../settings/tab-base";
import { getPullAction, swipeSidebarsEnabled } from "./gestures";
import { getMobileLayoutPreference, type MobileLayout, type MobileLayoutPreference } from "./index";
import { DEFAULT_TOOLBAR_COMMANDS, EXTRA_TOOLBAR_COMMANDS, commandIcon, getToolbarCommands, setToolbarCommands } from "./toolbar";

class CommandPickerModal extends FuzzySuggestModal<Command | null> {
  constructor(app: App, private items: (Command | null)[], private choose: (cmd: Command | null) => void, placeholder: string) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getItems() {
    return this.items;
  }
  getItemText(item: Command | null) {
    return item ? item.name : "None";
  }
  onChooseItem(item: Command | null) {
    this.choose(item);
  }
}

/** The "Mobile layout" dropdown row; Settings → Appearance adds it. */
export function addMobileLayoutSetting(app: App, setting: Setting): Setting {
  const layout = (app as unknown as { mobile?: MobileLayout | null }).mobile;
  return setting
    .setName("Mobile layout")
    .setDesc("Use the phone and tablet layout: sidebars as drawers, a navigation bar and a toolbar above the keyboard. Automatic uses it on touch devices. Applies to this device only.")
    .addDropdown((d) =>
      d
        .addOptions({ auto: "Automatic", on: "On", off: "Off" })
        .setValue(getMobileLayoutPreference())
        .onChange((v) => layout?.setPreference(v as MobileLayoutPreference)),
    );
}

export class MobileSettingTab extends AppSettingTab {
  constructor(app: App) {
    super(app, "mobile", "Mobile", "lucide-smartphone");
  }

  render(el: HTMLElement): void {
    const app = this.app;
    const general = this.group(el);
    addMobileLayoutSetting(app, this.row(general, "Mobile layout")).settingEl.addClass("vault-mobile-layout-setting");

    // Toolbar
    const toolbar = this.group(el, "Toolbar");
    toolbar.getHeader().setDesc("Commands shown above the keyboard while editing. Obsidian stores the same list, so it carries over to Obsidian mobile.");
    const ids = getToolbarCommands(app);
    const list = toolbar.listEl;
    list.addClass("mobile-toolbar-options-list-container");
    ids.forEach((id, index) => {
      const cmd = app.commands.findCommand(id);
      const row = this.row(toolbar, cmd?.name ?? id, cmd ? undefined : "Not available: the plugin that adds it is off.");
      row.settingEl.addClass("mobile-option-setting-item");
      const icon = createDiv({ cls: "mobile-option-setting-item-option-icon" });
      setIcon(icon, commandIcon(app, id));
      row.settingEl.prepend(icon);
      row
        .addExtraButton((b) =>
          b
            .setIcon("lucide-arrow-up")
            .setTooltip("Move up")
            .setDisabled(index === 0)
            .onClick(() => this.move(index, index - 1)),
        )
        .addExtraButton((b) =>
          b
            .setIcon("lucide-arrow-down")
            .setTooltip("Move down")
            .setDisabled(index === ids.length - 1)
            .onClick(() => this.move(index, index + 1)),
        )
        .addExtraButton((b) =>
          b
            .setIcon("lucide-minus-circle")
            .setTooltip("Remove from toolbar")
            .onClick(() => {
              setToolbarCommands(app, ids.filter((_, i) => i !== index));
              this.rerender();
            }),
        );
    });
    this.row(toolbar, "Add global command", "Put any command on the toolbar.")
      .addButton((b) =>
        b.setButtonText("Add…").onClick(() => {
          const current = new Set(getToolbarCommands(app));
          const items = Object.values(app.commands.commands)
            .filter((c) => !current.has(c.id))
            .sort((a, b) => a.name.localeCompare(b.name));
          new CommandPickerModal(app, items, (cmd) => {
            if (!cmd) return;
            setToolbarCommands(app, [...getToolbarCommands(app), cmd.id]);
            this.rerender();
          }, "Choose a command to add to the toolbar…").open();
        }),
      )
      .addExtraButton((b) =>
        b
          .setIcon("lucide-rotate-ccw")
          .setTooltip("Restore the default toolbar")
          .onClick(() => {
            setToolbarCommands(app, DEFAULT_TOOLBAR_COMMANDS.slice());
            this.rerender();
          }),
      );

    const more = [...DEFAULT_TOOLBAR_COMMANDS, ...EXTRA_TOOLBAR_COMMANDS].filter((id) => !ids.includes(id) && app.commands.findCommand(id));
    if (more.length) {
      const available = this.group(el, "More toolbar options");
      for (const id of more) {
        const cmd = app.commands.findCommand(id)!;
        const row = this.row(available, cmd.name);
        row.settingEl.addClass("mobile-option-setting-item");
        row.addExtraButton((b) =>
          b
            .setIcon("lucide-plus-circle")
            .setTooltip("Add to toolbar")
            .onClick(() => {
              setToolbarCommands(app, [...getToolbarCommands(app), id]);
              this.rerender();
            }),
        );
      }
    }

    // Gestures
    const gestures = this.group(el, "Gestures");
    const pull = getPullAction(app);
    const pullName = pull ? (app.commands.findCommand(pull)?.name ?? pull) : "None";
    this.row(gestures, "Quick Action", `Pull down at the top of a note to run a command. Current: ${pullName}.`).addButton((b) =>
      b.setButtonText("Configure").onClick(() => openQuickActionPicker(app, () => this.rerender())),
    );
    this.row(gestures, "Swipe to open sidebars", "Swipe in from the left or right edge of the screen to open that sidebar.").addToggle((t) =>
      t.setValue(swipeSidebarsEnabled(app)).onChange((v) => this.setConfig("mobileSwipeSidebars", v)),
    );
    this.row(gestures, "Long press for menus", "Press and hold a file, tab or link to open its menu. Always on in the mobile layout.");
  }

  private move(from: number, to: number) {
    const ids = getToolbarCommands(this.app);
    if (to < 0 || to >= ids.length) return;
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id!);
    setToolbarCommands(this.app, ids);
    this.rerender();
  }
}

export function openQuickActionPicker(app: App, done?: () => void) {
  const items: (Command | null)[] = [null, ...Object.values(app.commands.commands).sort((a, b) => a.name.localeCompare(b.name))];
  new CommandPickerModal(app, items, (cmd) => {
    app.vault.setConfig("mobilePullAction", cmd ? cmd.id : "");
    done?.();
  }, "Choose the command to run when pulling down…").open();
}

export function installMobileSettings(app: App, _layout: MobileLayout) {
  const setting = app.setting as { addBuiltinTab?: (tab: unknown) => void; settingTabs?: { id: string }[] };
  if (typeof setting?.addBuiltinTab === "function" && !setting.settingTabs?.some((t) => t.id === "mobile")) {
    setting.addBuiltinTab(new MobileSettingTab(app));
  }
  app.commands.addCommand({
    id: "mobile:quick-action",
    name: "Configure mobile Quick Action",
    icon: "lucide-arrow-down-to-line",
    callback: () => openQuickActionPicker(app),
  } as Command);
}
