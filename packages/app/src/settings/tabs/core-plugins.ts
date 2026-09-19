/**
 * Settings → Core plugins (§6.8): search, a toggle per core plugin, a gear to
 * its options tab and a shortcut to its hotkeys. Only Obsidian's own core
 * plugins are listed; OpenMarkdown's additions are pre-installed plugins in
 * Settings → Community plugins.
 */
import type { App } from "../../obsidian/app";
import { matchesAll, tokens } from "../helpers";
import { AppSettingTab } from "../tab-base";
import { openHotkeysFor } from "./community-plugins";

export class CorePluginsSettingTab extends AppSettingTab {
  private query = "";

  constructor(app: App) {
    super(app, "plugins", "Core plugins", "lucide-box");
  }

  render(el: HTMLElement): void {
    const app = this.app;
    const group = this.group(el, "Core plugins");
    group.addSearch((s) => {
      s.setPlaceholder("Search core plugins...").setValue(this.query);
      s.onChange((v) => {
        this.query = v;
        filter();
      });
    });
    const wrappers = Object.values(app.internalPlugins.plugins)
      .filter((w) => !w.definition.hidden && !w.definition.preinstalled)
      .sort((a, b) => a.definition.name.localeCompare(b.definition.name));
    const rows: { el: HTMLElement; text: string }[] = [];
    for (const wrapper of wrappers) {
      const def = wrapper.definition;
      const s = this.row(group, def.name, def.description);
      s.settingEl.setAttr("data-plugin-id", def.id);
      if (wrapper.enabled) {
        const tab = app.setting?.pluginTabs.find((t: { id: string }) => t.id === def.id);
        if (tab) {
          s.addExtraButton((b) =>
            b
              .setIcon("lucide-settings")
              .setTooltip("Options")
              .onClick(() => app.setting.openTab(tab)),
          );
        }
        s.addExtraButton((b) =>
          b
            .setIcon("lucide-plus-circle")
            .setTooltip("Hotkeys")
            .onClick(() => openHotkeysFor(app, def.name, def.id)),
        );
      }
      s.addToggle((t) =>
        t.setValue(wrapper.enabled).onChange(async (v) => {
          t.setDisabled(true);
          try {
            await app.internalPlugins.setEnabled(def.id, v);
          } catch (e) {
            console.error(e);
          }
          this.rerender();
          app.setting?.updatePluginSection?.();
        }),
      );
      rows.push({ el: s.settingEl, text: `${def.name} ${def.description} ${def.id}` });
    }
    if (!wrappers.length) this.row(group, "No core plugins are registered.");
    const more = this.row(this.group(el), "Pre-installed plugins", "Features this app adds beyond the core plugins, such as Calendar, Backups and Sync, are pre-installed plugins. Turn them on or off, or uninstall them, in Community plugins.");
    more.settingEl.addClass("vault-preinstalled-pointer");
    more.addButton((b) => b.setButtonText("Open").onClick(() => app.setting.openTabById("community-plugins")));
    const filter = () => {
      const toks = tokens(this.query);
      for (const r of rows) r.el.toggle(matchesAll(r.text, toks));
    };
    filter();
  }
}
