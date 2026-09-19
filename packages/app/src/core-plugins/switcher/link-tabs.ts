/**
 * "Open links in a new tab" (`.obsidian/app.json` → `openLinksInNewTab`,
 * default off; Settings → Files and links). A plain click on an internal link
 * opens the note in a new tab instead of replacing the current one. When the
 * note is already open in a tab of the main area, that tab is focused instead.
 * Links inside the same note (headings, blocks) and empty tabs are not
 * affected, and Mod-click still decides for itself.
 *
 * Hidden core plugin `link-tabs`; it steps aside when the Open Tab Settings
 * plugin (`open-tab-settings`) is enabled.
 */
import type { CorePluginDefinition } from "../../obsidian/app-internals/internal-plugins";
import { Plugin } from "../../obsidian/plugin";
import { parseLinktext } from "../../obsidian/util";

export const OPEN_TAB_SETTINGS_PLUGIN = "open-tab-settings";

class LinkTabsPlugin extends Plugin {
  override async onload() {
    const app = this.app as any;
    const ws = app.workspace;
    const original = ws.openLinkText;
    const wrapper = async function (this: any, linktext: string, sourcePath: string, newLeaf?: any, openViewState?: any) {
      if (!newLeaf && app.vault.getConfig("openLinksInNewTab") && !app.plugins?.enabledPlugins?.has?.(OPEN_TAB_SETTINGS_PLUGIN)) {
        const { path } = parseLinktext(linktext);
        const target = path === "" ? null : app.metadataCache.getFirstLinkpathDest(path, sourcePath);
        const active = ws.activeLeaf;
        const activeFile = active?.view?.file ?? null;
        const isEmpty = !active?.view || active.view.getViewType?.() === "empty";
        const inMain = !!active && active.getRoot?.() === ws.rootSplit;
        if (path !== "" && target !== activeFile && !isEmpty && inMain) {
          let open: any = null;
          if (target) {
            ws.iterateRootLeaves((leaf: any) => {
              if (!open && leaf.view?.file === target) open = leaf;
            });
          }
          if (open) {
            ws.setActiveLeaf(open, { focus: true });
            const subpath = parseLinktext(linktext).subpath;
            if (subpath) open.setEphemeralState?.({ subpath });
            return;
          }
          newLeaf = "tab";
        }
      }
      return original.call(this, linktext, sourcePath, newLeaf, openViewState);
    };
    ws.openLinkText = wrapper;
    this.register(() => {
      if (ws.openLinkText === wrapper) ws.openLinkText = original;
    });
  }
}

export const linkTabs: CorePluginDefinition = {
  id: "link-tabs",
  name: "Link tabs",
  description: "Open links in a new tab when the setting is on.",
  defaultOn: true,
  hidden: true,
  defaultOptions: {},
  create: (app) => new LinkTabsPlugin(app, { id: "link-tabs", name: "Link tabs", version: "", minAppVersion: "", author: "", description: "" }),
};
