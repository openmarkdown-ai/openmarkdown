/**
 * Installs the Settings window (`app.setting`), its built-in tabs, the
 * app-level commands, the ribbon footer, and `obsidian://` link handling.
 *
 * Call `installSettings(app)` right after constructing the App and before
 * `app.initialize()`: core plugins call `this.addSettingTab()` while they load,
 * which goes through `app.setting`. The parts that need the workspace (ribbon
 * footer, zoom, quick font size) wait for it.
 */
import type { App } from "../obsidian/app";
import { AppSetting } from "./app-setting";
import { registerAppCommands } from "./commands";
import { whenLayoutReady, whenWorkspace } from "./helpers";
import { installRibbonFooter } from "./ribbon-footer";
import { AppearanceSettingTab } from "./tabs/appearance";
import { CommunityPluginsSettingTab, maybeAutoCheckPluginUpdates } from "./tabs/community-plugins";
import { CorePluginsSettingTab } from "./tabs/core-plugins";
import { EditorSettingTab } from "./tabs/editor";
import { FilesLinksSettingTab } from "./tabs/files-links";
import { GeneralSettingTab } from "./tabs/general";
import { HotkeysSettingTab } from "./tabs/hotkeys";
import { InterfaceSettingTab } from "./tabs/interface";
import { KeychainSettingTab } from "./tabs/keychain";
import { AiSettingTab } from "./tabs/ai";
import { installAi } from "../ai/index";
import { applyZoom, installQuickFontSize } from "./zoom";

export { AppSetting } from "./app-setting";
export { handleUri, installUriHandling, parseObsidianUri } from "./uri";
export { PluginBrowserModal } from "./community-store";
export { ThemeBrowserModal } from "./theme-store";

export function installSettings(app: App): AppSetting {
  const existing = app.setting as unknown;
  if (existing instanceof AppSetting) return existing;
  // `app.ai` (docs/PLAN-ai.md): before core plugins load, so AI features find it in onload.
  installAi(app);
  const setting = new AppSetting(app);
  // Plugins that added tabs before the window existed (a stub `app.setting`) keep them.
  const pending = (existing as { pluginTabs?: unknown[] } | null)?.pluginTabs;
  app.setting = setting;
  for (const tab of [
    new GeneralSettingTab(app),
    new InterfaceSettingTab(app),
    new EditorSettingTab(app),
    new FilesLinksSettingTab(app),
    new AppearanceSettingTab(app),
    new HotkeysSettingTab(app),
    new KeychainSettingTab(app),
    new AiSettingTab(app),
    new CorePluginsSettingTab(app),
    new CommunityPluginsSettingTab(app),
  ]) {
    setting.addBuiltinTab(tab);
  }
  if (Array.isArray(pending)) for (const tab of pending) setting.addSettingTab(tab as never);

  registerAppCommands(app);

  whenWorkspace(app, () => {
    installRibbonFooter(app);
  });
  whenLayoutReady(app, () => {
    applyZoom(app);
    installQuickFontSize(app);
    maybeAutoCheckPluginUpdates(app);
  });
  return setting;
}
